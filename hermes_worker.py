"""Native Hermes child; its launching parent owns desktop effects and the temporary home."""

from contextlib import redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from typing import NamedTuple

HERMES_PYTHON = Path(__file__).resolve().parent / '.runtime/hermes-0.22.2/venv/bin/python'
HERMES_SOURCE = Path(__file__).resolve().parent / '.runtime/hermes-0.22.2/source'
HERMES_COMMIT = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
ROOT = Path(__file__).resolve().parent
MEMORY_ROOT = ROOT / '.runtime/hermes-memory'
MEMORY_ERROR = ('Local notes are unavailable or unsafe. Check note ownership, permissions, '
                'encoding and size, then restart Kestrel.')
TRACE_ROOT = Path(__file__).resolve().parent / '.runtime/hermes-traces'
TRACE_STARTUP_ERROR = ('Local conversation tracing could not start. '
                       'Check runtime permissions and restart Kestrel.')
TRACE_FAILURE_ERROR = ('Local conversation tracing failed. Check free space and runtime '
                       'permissions, then restart Kestrel.')
RUNTIME_HOME_ERROR = ('Hermes runtime home is not a private directory owned by this user. '
                      'Check runtime ownership and permissions, then restart Kestrel.')
ENGINE_CLOSE_ERROR = 'Hermes engine could not close cleanly. Restart Kestrel.'
TOOL_SURFACE_ERROR = ("Hermes offered tools other than memory and Kestrel's desktop tools. "
                      'Check the pinned Hermes configuration, then restart Kestrel.')
BONSAI_URL = 'http://127.0.0.1:8080/v1'
ORDINARY_MAX_TOKENS = 180
ORDINARY_REASONING_ENABLED = False
GENERATION_TEMPERATURE = 0.4
DELIVERY_LABELS = frozenset(('neutral', 'curious', 'gently_pleased', 'reassuring'))
REASONING_ERROR = 'Hermes returned unsafe reasoning markup. Try again.'
REASONING_CONFIGURATION_ERROR = ('Hermes reasoning configuration is unsafe. Check the pinned '
                                 'Hermes configuration, then restart Kestrel.')
DELIVERY_ERROR = 'Hermes returned an invalid delivery header or empty reply. Restart Kestrel and try again.'
KESTREL_IDENTITY = "You are Kestrel, Zain's local voice assistant."
PROMPT_IDENTITY_ERROR = ("Kestrel's identity could not be applied to the brain's instructions. "
                         'Check the pinned engine, then restart Kestrel.')


def deeper_thought_requested(text: str) -> bool:
    text = text.strip()
    prefix = 'think more deeply about '
    return text.lower().startswith(prefix) and bool(text[len(prefix):].strip())


class ReplyReasoningFilter:
    names = ('think', 'thinking', 'reasoning', 'thought', 'reasoning_scratchpad',
             '思考', '反思', '推理', '推敲')

    def __init__(self):
        self.active = ''
        self.pending = ''
        self.failed = False
        self.last_hidden = ''

    def refuse(self):
        self.failed = True
        raise RuntimeError(REASONING_ERROR)

    def feed(self, text: str) -> str:
        if self.failed or not isinstance(text, str):
            self.refuse()
        visible = []
        for char in text:
            if not self.pending:
                if char == '<':
                    self.pending = char
                elif not self.active:
                    visible.append(char)
                continue
            previous = self.pending
            self.pending += char
            closing = self.pending.startswith('</')
            start = 2 if closing else 1
            name = self.pending[start:].lower()
            if self.pending == '</':
                continue
            if name.endswith('>') and name[:-1] in self.names:
                tag = name[:-1]
                if closing:
                    if self.active != tag:
                        self.refuse()
                    self.active = ''
                else:
                    if self.active:
                        self.refuse()
                    self.active = tag
                self.pending = ''
            elif any((tag + '>').startswith(name) for tag in self.names):
                continue
            else:
                if len(previous) > start and not (char.isalnum() or char == '_'):
                    self.refuse()
                if char == '<':
                    if not self.active:
                        visible.append(previous)
                    self.pending = '<'
                else:
                    if not self.active:
                        visible.append(self.pending)
                    self.pending = ''
        return ''.join(visible)

    def flush(self) -> str:
        if self.failed or self.active or self.pending not in ('', '<', '</'):
            self.refuse()
        tail, self.pending = self.pending, ''
        return tail

    def reset(self) -> None:
        if self.failed or self.active or self.pending:
            self.refuse()


class DesktopToolSchema(NamedTuple):
    description: str
    bounds: dict[str, tuple[type, int, int]]


DESKTOP_TOOLS = {
    'mute': DesktopToolSchema('Mute the selected audio output.', {}),
    'set_volume': DesktopToolSchema('Set the selected audio output volume.', {'percent': (int, 0, 100)}),
    'pause_media': DesktopToolSchema('Pause current media.', {}),
    'next_track': DesktopToolSchema('Advance to the next media track.', {}),
    'focus_workspace': DesktopToolSchema('Focus a numbered workspace.', {'number': (int, 1, 2147483647)}),
    'open_app': DesktopToolSchema('Open one installed app by its visible name.', {'name': (str, 1, 1024)}),
    'take_screenshot': DesktopToolSchema('Save a screenshot to the screenshot folder; its content is never shown to you.', {}),
}


def valid_desktop_arguments(name: str, arguments: dict) -> bool:
    if not isinstance(name, str) or name not in DESKTOP_TOOLS or not isinstance(arguments, dict):
        return False
    bounds = DESKTOP_TOOLS[name].bounds
    return set(arguments) == set(bounds) and all(
        type(arguments[key]) is kind and (
            low <= arguments[key] <= high if kind is int
            else low <= len(arguments[key]) <= high and bool(arguments[key].strip()))
        for key, (kind, low, high) in bounds.items()
    )


class ReplyDeliveryPrefix:
    def __init__(self):
        self.prefix = ''
        self.delivery = None
        self.has_text = False
        self.failed = False
        self.leading_whitespace = False

    def feed(self, text: str) -> list[dict]:
        if self.failed:
            return []
        if not isinstance(text, str):
            self.failed = True
            return []
        events = []
        if self.delivery is None:
            headers = {f'[delivery:{label}]{delimiter}': label
                       for label in DELIVERY_LABELS for delimiter in (' ', '\n')}
            for index, char in enumerate(text):
                if not self.prefix:
                    if char.isspace():
                        self.leading_whitespace = True
                        continue
                    if char == '[' and self.leading_whitespace:
                        self.failed = True
                        return []
                self.prefix += char
                if not self.prefix.startswith('['):
                    if self.prefix == 'delivery:':
                        self.failed = True
                        self.prefix = ''
                        return []
                    if 'delivery:'.startswith(self.prefix):
                        continue
                    self.delivery = 'neutral'
                    events.append({'delivery': 'neutral'})
                    text = self.prefix + text[index + 1:]
                    self.prefix = ''
                    break
                if self.prefix in headers:
                    self.delivery = headers[self.prefix]
                    self.prefix = ''
                    events.append({'delivery': self.delivery})
                    text = text[index + 1:]
                    break
                if not any(header.startswith(self.prefix) for header in headers):
                    self.failed = True
                    self.prefix = ''
                    return []
            else:
                return []
        if text:
            self.has_text |= bool(text.strip())
            events.append({'text': text})
        return events

    def finish(self) -> list[dict]:
        if not self.failed and self.delivery is None and self.prefix and 'delivery:'.startswith(self.prefix):
            self.delivery = 'neutral'
            self.has_text = True
            text, self.prefix = self.prefix, ''
            return [{'delivery': 'neutral'}, {'text': text}]
        if self.failed or self.delivery is None or not self.has_text:
            raise RuntimeError(DELIVERY_ERROR)
        return []


SYSTEM_PROMPT = (
    "Speak naturally in concise English. "
    "Never name the software you run on, and never point to a website or documentation for your abilities. "
    "Usually answer in one or two short sentences, beginning with a short complete sentence. "
    "Ask a follow-up question only when it helps the current conversation. If you first make a statement, end it with a full stop before asking the question as a separate sentence. "
    "Use no markdown, lists, acting directions, accent changes or persona changes. "
    "This session is a local conversation. You can talk, answer from general knowledge, and use these tools: "
    "native local memory for small facts and preferences, and Kestrel's desktop tools mute, set_volume, "
    "pause_media, next_track, focus_workspace, open_app and take_screenshot. "
    "Maintain notes automatically when useful, including updating or removing outdated notes. "
    "Claim a save only after a successful memory tool result. You have no internet, web access or live "
    "information such as news, weather or prices, and you cannot see the screen or any screenshot; "
    "you cannot unmute, resume or go back in media. Say so plainly when asked. "
    "When asked what you can do, name conversation and general knowledge, remembering notes, each desktop tool "
    "in plain words (muting, setting the volume, pausing media, skipping to the next track, switching to a "
    "numbered workspace, opening an installed app by name and taking a screenshot), the exact phrases repeat "
    "that, stop, that's all and what can I say, and these limits. "
    "Call a desktop tool only for an effect the owner asks for, at most once per reply. "
    "Each desktop result is JSON with confirmed, attempted and reason. "
    "Say an effect happened only when confirmed is true, never before its result arrives. "
    "For open_app, confirmed means the launch request was accepted, not that a window is visible. "
    "For take_screenshot, confirmed means a new screenshot file was saved; you never see it. "
    "Never call a desktop tool again to retry it.\n\n"
    'Choose the delivery for the meaning of the current reply, using the conversation as context. '
    'Keep expression subtle and prefer neutral when uncertain. Neutral suits factual answers, '
    'practical information and ordinary replies without a clear emotional cue. Curious suits an '
    'invitation to discover something or genuine interest in an unanswered story. Use gently_pleased '
    'for good news, an achievement or a success the user is sharing. Reassuring suits current worry, '
    'distress or a request for comfort. A hard-earned success calls for gently_pleased; do not choose'
    " reassuring merely because the work was difficult. Do not carry the previous reply's delivery "
    'into a new subject.\n'
    '\n'
    'Format examples, illustrating delivery rather than words to copy:\n'
    'A factual explanation:\n'
    '[delivery:neutral]\n'
    'A triangle has three sides.\n'
    'An invitation to hear a discovery:\n'
    '[delivery:curious]\n'
    'That sounds interesting. What did you find?\n'
    'Someone shares that they earned a qualification after working hard:\n'
    '[delivery:gently_pleased]\n'
    'Well done, that took real effort.\n'
    'Someone is worried about an unfamiliar situation:\n'
    '[delivery:reassuring]\n'
    'You can take it one step at a time.\n'
    '\n'
    'Tool calls use their native format without a delivery header. For the first spoken text of each reply, whether before or after tool calls, begin immediately with exactly one of '
    '[delivery:neutral], [delivery:curious], [delivery:gently_pleased] or [delivery:reassuring], then'
    ' a newline, then your concise spoken reply. Never omit the header, even for a very short factual'
    ' answer, a changed subject, or a replacement request after an interruption. Earlier assistant '
    'messages have their headers removed before entering conversation history; do not imitate their '
    'header-free format. Emit the header once at the beginning of the reply, not again within its '
    'text or when continuing the same answer. Nothing comes before the header. After it, output only '
    'the words to speak, with no delivery explanations or acting directions.'
)


MEMORY_REPLY_REMINDER = (
    'Example confirmation after a successful memory save:\n'
    '[delivery:neutral]\n'
    'Done. Saved.'
)


def validate_hermes_source() -> None:
    refusal = ('Hermes source identity could not be verified. '
               'Reinstall the pinned Hermes 0.22.2 runtime and restart Kestrel.')
    try:
        head = subprocess.run(
            ['git', '-C', str(HERMES_SOURCE), 'rev-parse', 'HEAD'],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5,
        ).stdout.strip()
        if head != HERMES_COMMIT:
            raise RuntimeError(refusal)
        subprocess.run(
            ['git', '-C', str(HERMES_SOURCE), 'diff', '--quiet', '--no-ext-diff',
             '--no-textconv', 'HEAD', '--'],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
        spec = importlib.util.find_spec('run_agent')
        if (spec is None or spec.origin is None
                or Path(spec.origin).resolve() != (HERMES_SOURCE / 'run_agent.py').resolve()):
            raise RuntimeError(refusal)
    except (OSError, subprocess.SubprocessError, ImportError, ValueError):
        raise RuntimeError(refusal) from None


def validate_local_configuration() -> None:
    for path, refusal in (
        (HERMES_SOURCE / '.env',
         'Hermes source .env is not supported. Keep environment files outside '
         'the pinned source and restart Kestrel.'),
        (Path('/etc/nemo-relay/plugins.toml'),
         'System NeMo Relay plugins are not supported by Kestrel. Use an environment '
         'without /etc/nemo-relay/plugins.toml and restart Kestrel.'),
    ):
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        except OSError:
            raise RuntimeError('Kestrel could not verify isolated Hermes configuration. '
                               'Check runtime permissions and restart Kestrel.') from None
        raise RuntimeError(refusal)


def create_trace_directory() -> Path:
    try:
        parent = TRACE_ROOT.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                or stat.S_IMODE(parent.st_mode) & 0o022):
            raise RuntimeError(TRACE_STARTUP_ERROR)
        try:
            root = TRACE_ROOT.lstat()
        except FileNotFoundError:
            TRACE_ROOT.mkdir(mode=0o700)
            root = TRACE_ROOT.lstat()
        if (not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid()
                or stat.S_IMODE(root.st_mode) != 0o700):
            raise RuntimeError(TRACE_STARTUP_ERROR)
        return Path(tempfile.mkdtemp(prefix='session-', dir=TRACE_ROOT))
    except OSError as error:
        raise RuntimeError(TRACE_STARTUP_ERROR) from error


def validate_memory_storage() -> Path:
    try:
        parent = MEMORY_ROOT.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                or stat.S_IMODE(parent.st_mode) & 0o022):
            raise RuntimeError(MEMORY_ERROR)
        try:
            root = MEMORY_ROOT.lstat()
        except FileNotFoundError:
            MEMORY_ROOT.mkdir(mode=0o700)
            root = MEMORY_ROOT.lstat()
        if (not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid()
                or stat.S_IMODE(root.st_mode) != 0o700):
            raise RuntimeError(MEMORY_ERROR)
        for name, limit in (('MEMORY.md', 2200), ('USER.md', 1375),
                            ('MEMORY.md.lock', None), ('USER.md.lock', None)):
            try:
                descriptor = os.open(MEMORY_ROOT / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                continue
            with os.fdopen(descriptor, 'rb') as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1):
                    raise RuntimeError(MEMORY_ERROR)
                if limit is not None:
                    raw = stream.read(16 * 1024 + 1)
                    if len(raw) > 16 * 1024:
                        raise RuntimeError(MEMORY_ERROR)
                    text = raw.decode('utf-8-sig')
                    # Use the pinned native parser so our preflight measures its rendered budget.
                    from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore
                    if len(ENTRY_DELIMITER.join(MemoryStore._parse_entries(text))) > limit:
                        raise RuntimeError(MEMORY_ERROR)
        return MEMORY_ROOT
    except (OSError, UnicodeError):
        raise RuntimeError(MEMORY_ERROR) from None


def validate_runtime_home(home: Path) -> None:
    try:
        metadata = home.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700):
            raise RuntimeError(RUNTIME_HOME_ERROR)
    except OSError:
        raise RuntimeError(RUNTIME_HOME_ERROR) from None


def memory_scaffold_identity(home: Path) -> tuple[int, int]:
    validate_runtime_home(home)
    try:
        child = home / 'memories'
        metadata = child.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o700 or any(child.iterdir())):
            raise RuntimeError(MEMORY_ERROR)
        return metadata.st_dev, metadata.st_ino
    except OSError:
        raise RuntimeError(MEMORY_ERROR) from None


def attach_memory_storage(home: Path, *, scaffold_identity: tuple[int, int]) -> None:
    target = validate_memory_storage()
    if memory_scaffold_identity(home) != scaffold_identity:
        raise RuntimeError(MEMORY_ERROR)
    try:
        (home / 'memories').rmdir()
        (home / 'memories').symlink_to(target, target_is_directory=True)
    except OSError:
        raise RuntimeError(MEMORY_ERROR) from None


def preserve_user_turns(messages, *, drop_codex_reasoning_items=True, drop_nudge_marker=None):
    """Keep unanswered turns distinct while retaining the pinned Hermes filters."""
    from run_agent import AIAgent

    kept = []
    for message in messages:
        kept.extend(AIAgent._drop_thinking_only_and_merge_users(
            [message], drop_codex_reasoning_items=drop_codex_reasoning_items,
            drop_nudge_marker=drop_nudge_marker,
        ))
    return kept


def kestrel_system_prompt(built, prompt: str) -> str:
    # Hermes 0.22.2 has no setting for these four blocks; remove exactly them or refuse.
    # Count each block's own text: adjacent paragraphs share one separator.
    from agent.prompt_builder import (HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS, RUNTIME_ENVIRONMENT_END,
                                      RUNTIME_ENVIRONMENT_HEADING, STEER_CHANNEL_NOTE)
    from agent.system_prompt import _active_profile_line
    head = f'{KESTREL_IDENTITY}\n\n{HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS}\n\n'
    runtime = prompt.find(f'\n\n{RUNTIME_ENVIRONMENT_HEADING}\n\n')
    if (not prompt.startswith(head) or runtime == -1 or not prompt.endswith(RUNTIME_ENVIRONMENT_END)
            or any(prompt.count(text) != 1 for text in
                   (HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS, RUNTIME_ENVIRONMENT_HEADING, RUNTIME_ENVIRONMENT_END))):
        raise RuntimeError(PROMPT_IDENTITY_ERROR)
    kept = f'{KESTREL_IDENTITY}\n\n{prompt[len(head):runtime]}\n\n'
    for text, expected in ((_active_profile_line(built), 1),
                           (STEER_CHANNEL_NOTE, 1 if built.valid_tool_names else 0)):
        paragraph = f'\n\n{text}\n\n'
        if prompt.count(text) != expected or expected and paragraph not in kept:
            raise RuntimeError(PROMPT_IDENTITY_ERROR)
        kept = kept.replace(paragraph, '\n\n', expected)
    return kept.removesuffix('\n\n')


def child_environment(home):
    home = Path(home).resolve()
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ')
                   if key in os.environ}
    environment.update(HERMES_HOME=str(home), HERMES_MANAGED_DIR=str(home / 'managed'),
                       PYTHON_DOTENV_DISABLED='1')
    return environment


def main(*, base_url=BONSAI_URL):
    wire = sys.stdout
    status = 0
    terminal_failure_reported = False

    def emit(event):
        print(json.dumps(event), file=wire, flush=True)

    with redirect_stdout(sys.stderr):
        agent = None
        runtime = None
        exporter = None
        try:
            os.umask(0o077)
            home = Path(os.environ['HERMES_HOME'])
            try:
                validate_runtime_home(home)
                home = home.resolve(strict=True)
            except OSError:
                raise RuntimeError(RUNTIME_HOME_ERROR) from None
            os.chdir(home)
            config = {
                'model': {'context_length': 64000},
                'agent': {'coding_context': 'off'},
                'memory': {'memory_enabled': True, 'user_profile_enabled': True, 'provider': '',
                           'memory_char_limit': 2200, 'user_char_limit': 1375, 'write_approval': False},
                'sessions': {'write_json_snapshots': False},
                'compression': {'enabled': False},
                'auxiliary': {'title_generation': {'enabled': False}},
                'plugins': {'enabled': []}, 'mcp_servers': {},
                'tools': {'tool_search': {'enabled': 'off'}},
            }
            (home / 'config.yaml').write_text(json.dumps(config))
            try:
                with (home / 'SOUL.md').open('x') as soul:
                    soul.write(KESTREL_IDENTITY)
            except OSError:
                raise RuntimeError(RUNTIME_HOME_ERROR) from None
            try:
                (home / 'memories').lstat()
            except FileNotFoundError:
                pass
            else:
                raise RuntimeError(MEMORY_ERROR)
            validate_hermes_source()
            validate_local_configuration()
            try:
                session = create_trace_directory()
                event_file = session / 'events.jsonl'
                plugins = home / 'relay-plugins.toml'
                with plugins.open('x') as output:
                    output.write(
                        'version = 1\n[[components]]\nkind = "observability"\nenabled = true\n'
                        '[components.config]\nversion = 4\nenable_full_payloads = true\n'
                        '[components.config.atof]\nenabled = false\n'
                        '[components.config.atif]\nenabled = false\n'
                        '[components.config.opentelemetry]\nenabled = false\n'
                    )
                os.environ['HERMES_NEMO_RELAY_PLUGINS_TOML'] = str(plugins)
            except Exception as error:
                raise RuntimeError(TRACE_STARTUP_ERROR) from (error.__cause__ or error)
            from run_agent import AIAgent
            from tools.registry import registry
            from agent.relay_runtime import get_runtime
            from agent.turn_failure_copy import is_max_iteration_handoff
            from agent.reasoning_promotion import answer_in_reasoning_capability
            import nemo_relay

            bridge_failed = False
            privacy_failed = False
            reasoning_filter = None

            def check_privacy():
                nonlocal privacy_failed
                if privacy_failed or reasoning_filter is not None and reasoning_filter.failed:
                    privacy_failed = True
                    raise RuntimeError(REASONING_ERROR)

            def desktop_handler(name):
                def handle(args):
                    nonlocal bridge_failed
                    check_privacy()
                    if bridge_failed:
                        return 'Kestrel desktop bridge failed'
                    emit({'tool_call': {'name': name, 'arguments': args}})
                    try:
                        line = sys.stdin.buffer.readline(4096)
                        reply = json.loads(line)
                        if (len(line) == 4096 and not line.endswith(b'\n')
                                or not isinstance(reply, dict) or set(reply) != {'tool_result'}
                                or not isinstance(reply['tool_result'], str)
                                or not reply['tool_result'].strip() or len(reply['tool_result']) > 1024):
                            raise ValueError('Invalid desktop result')
                        return reply['tool_result']
                    except ValueError:
                        bridge_failed = True
                        return 'Kestrel desktop bridge failed'
                return handle

            for name, (description, bounds) in DESKTOP_TOOLS.items():
                registry.register(
                    name=name, toolset='kestrel_desktop', handler=desktop_handler(name),
                    schema={'name': name, 'description': description, 'parameters': {
                        'type': 'object',
                        'properties': {key: {'type': 'integer', 'minimum': low, 'maximum': high} if kind is int
                                       else {'type': 'string', 'minLength': low, 'maxLength': high}
                                       for key, (kind, low, high) in bounds.items()},
                        'required': list(bounds), 'additionalProperties': False,
                    }},
                )

            try:
                runtime = get_runtime()
                if runtime is None or not runtime.managed_execution_enabled():
                    raise RuntimeError(TRACE_STARTUP_ERROR)
                trace_config = nemo_relay.AtofExporterConfig()
                trace_config.sink_type = 'file'
                trace_config.output_directory = str(session)
                trace_config.filename = 'events.jsonl'
                trace_config.mode = nemo_relay.AtofExporterMode.Append
                exporter = nemo_relay.AtofExporter(trace_config)
                metadata = event_file.lstat()
                if (exporter.path != str(event_file) or not stat.S_ISREG(metadata.st_mode)
                        or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600):
                    raise RuntimeError(TRACE_STARTUP_ERROR)
                exporter.register('kestrel-local-trace')
            except Exception as error:
                raise RuntimeError(TRACE_STARTUP_ERROR) from error
            def construct_agent(*, memory):
                built = AIAgent(
                    base_url=base_url, api_key='lm-studio', provider='custom', api_mode='chat_completions',
                    model='bonsai-2-27b', enabled_toolsets=['memory', 'kestrel_desktop'] if memory else [], disabled_toolsets=['terminal'],
                    skip_memory=True, skip_background_review=True, skip_context_files=True, load_soul_identity=True,
                    session_db=None, fallback_model=None, save_trajectories=False,
                    # Contain repeated malformed-tool loops; incomplete summaries must never claim success.
                    checkpoints_enabled=False, quiet_mode=True, max_tokens=ORDINARY_MAX_TOKENS, max_iterations=9,
                    reasoning_config={'enabled': ORDINARY_REASONING_ENABLED},
                    request_overrides={'temperature': GENERATION_TEMPERATURE},
                    ephemeral_system_prompt=MEMORY_REPLY_REMINDER if memory else None,
                )
                built._drop_thinking_only_and_merge_users = preserve_user_turns
                native_prompt = built._build_system_prompt

                def kestrel_prompt(system_message=None):
                    return kestrel_system_prompt(built, native_prompt(system_message))

                built._build_system_prompt = kestrel_prompt
                native_repair = built._repair_tool_call

                def exact_repair(name):
                    repaired = native_repair(name)
                    if repaired == 'memory' or repaired == name.lower().replace('-', '_').replace(' ', '_'):
                        return repaired
                    return None

                built._repair_tool_call = exact_repair
                refusal = REASONING_CONFIGURATION_ERROR if answer_in_reasoning_capability(built) else None
                if memory:
                    if (built.valid_tool_names != {'memory', *DESKTOP_TOOLS}
                            or {tool['function']['name'] for tool in built.tools} != {'memory', *DESKTOP_TOOLS}):
                        refusal = TOOL_SURFACE_ERROR
                    elif built._memory_store is None or built._memory_manager is not None:
                        refusal = MEMORY_ERROR
                if refusal is not None:
                    try:
                        built.close()
                    except Exception:
                        raise RuntimeError(ENGINE_CLOSE_ERROR) from None
                    raise RuntimeError(refusal)
                return built

            def close_agent():
                nonlocal agent
                if agent is not None:
                    try:
                        agent.close()
                    except Exception:
                        raise RuntimeError(ENGINE_CLOSE_ERROR) from None
                    agent = None

            agent = construct_agent(memory=False)
            scaffold_identity = memory_scaffold_identity(home)
            prepared = False
            begun = False
            attached = False
            emit({'ready': True})
            while line := sys.stdin.buffer.readline(1024 * 1024 + 1):
                if len(line) > 1024 * 1024:
                    emit({'error': 'Hermes request exceeds 1 MiB. Restart Kestrel and try again.'})
                    terminal_failure_reported = True
                    status = 1
                    break
                tracing_failed = False
                bridge_failed = False
                privacy_failed = False
                reasoning_filter = None
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError('Expected a preparation, begin or messages request')
                    if set(request) == {'begin'} and request['begin'] is True:
                        begun = False
                        close_agent()
                        validate_runtime_home(home)
                        if not attached:
                            attach_memory_storage(home, scaffold_identity=scaffold_identity)
                            attached = True
                        else:
                            validate_memory_storage()
                            link = home / 'memories'
                            if not link.is_symlink() or os.readlink(link) != str(MEMORY_ROOT):
                                raise RuntimeError(MEMORY_ERROR)
                        agent = construct_agent(memory=True)
                        begun = True
                        emit({'session_ready': True})
                        continue
                    preparing = set(request) == {'prepare'} and request['prepare'] is True
                    if preparing:
                        if prepared or attached or begun:
                            raise ValueError('Preparation is permitted only once before a conversation')
                        prepared = True
                        messages = [{'role': 'user', 'content': 'Hello.'}]
                    elif set(request) == {'messages'}:
                        if not begun:
                            raise ValueError('Begin a fresh conversation before sending messages')
                        validate_memory_storage()
                        messages = request['messages']
                    else:
                        raise ValueError('Expected an exact preparation, begin or messages request')
                    if not isinstance(messages, list) or not messages:
                        raise ValueError('Expected nonempty conversation history')
                    group_names = set()
                    for index, message in enumerate(messages):
                        if isinstance(message, dict) and message.get('role') == 'tool':
                            if (set(message) != {'role', 'name', 'arguments', 'content'}
                                    or not valid_desktop_arguments(message['name'], message['arguments'])
                                    or not isinstance(message['content'], str) or not message['content'].strip()
                                    or len(message['content']) > 1024):
                                raise ValueError('Invalid desktop tool history')
                            if index == 0 or messages[index - 1]['role'] not in ('user', 'tool'):
                                raise ValueError('Invalid desktop tool history')
                            if message['name'] in group_names:
                                raise ValueError('Invalid desktop tool history')
                            group_names.add(message['name'])
                            continue
                        group_names.clear()
                        if (not isinstance(message, dict) or set(message) != {'role', 'content'}
                                or message['role'] not in ('user', 'assistant')
                                or not isinstance(message['content'], str)
                                or not message['content'].strip()):
                            raise ValueError('Expected text-only user/assistant messages')
                    if messages[-1]['role'] != 'user':
                        raise ValueError('Conversation history must end in user')
                    converted = []
                    tool_count = 0
                    for index, message in enumerate(messages):
                        if message['role'] == 'tool':
                            if messages[index - 1]['role'] != 'tool':
                                calls = []
                                converted.append({'role': 'assistant', 'content': '', 'tool_calls': calls})
                            call_id = f'kestrel-desktop-{tool_count}'
                            tool_count += 1
                            calls.append({'id': call_id, 'type': 'function', 'function': {
                                'name': message['name'], 'arguments': json.dumps(message['arguments'])}})
                            converted.append({'role': 'tool', 'tool_call_id': call_id, 'content': message['content']})
                        else:
                            converted.append(message.copy())
                    messages = converted
                    history = []
                    for index, message in enumerate(messages[:-1]):
                        historical = message.copy()
                        if message['role'] == 'user' and messages[index + 1]['role'] == 'user':
                            historical['content'] = [{'type': 'text', 'text': message['content']}]
                        history.append(historical)
                    streamed = False
                    delivery = ReplyDeliveryPrefix()

                    def delta(text):
                        nonlocal streamed
                        check_privacy()
                        if bridge_failed:
                            return
                        streamed = True
                        for event in delivery.feed(text):
                            emit(event)

                    deep = deeper_thought_requested(messages[-1]['content'])
                    agent.reasoning_config = {'enabled': True, 'effort': 'medium'} if deep else {'enabled': ORDINARY_REASONING_ENABLED}
                    agent.max_tokens = 16384 if deep else ORDINARY_MAX_TOKENS
                    template = {'enable_thinking': deep}
                    if deep:
                        template['reasoning_effort'] = 'medium'
                    agent.request_overrides = {'temperature': GENERATION_TEMPERATURE, 'extra_body': {
                        'chat_template_kwargs': template, 'reasoning_format': 'deepseek'}}
                    reasoning_filter = ReplyReasoningFilter()
                    originals = {name: (name in vars(agent), getattr(agent, name)) for name in
                                 ('_stream_think_scrubber', '_get_transport', '_fire_stream_delta',
                                  '_reset_stream_delivery_tracking')}
                    native_get_transport = agent._get_transport
                    native_fire_stream_delta = agent._fire_stream_delta
                    native_reset_stream_delivery = agent._reset_stream_delivery_tracking
                    # Native receives filtered text and must not parse it a second time.
                    visible_scrubber = SimpleNamespace(feed=lambda text: text, last_hidden='')
                    wrapped_transport = None
                    normalizer = None
                    normalizer_owned = False

                    def restore_normalizer():
                        if wrapped_transport is not None:
                            if normalizer_owned:
                                wrapped_transport.normalize_response = normalizer
                            else:
                                del wrapped_transport.normalize_response

                    def sanitize_content(content):
                        if content is None:
                            return None
                        clean = ReplyReasoningFilter()
                        return clean.feed(content) + clean.flush()

                    def finish_stream():
                        with agent._stream_writer_lock:
                            check_privacy()
                            tail = reasoning_filter.flush()
                            context = agent._stream_context_scrubber
                            tails = [context.feed(tail) if tail and context is not None else tail]
                            if context is not None:
                                tails.append(context.flush())
                            for safe in tails:
                                if safe and not agent._stream_writer_superseded():
                                    agent._deliver_to_stream_callbacks(safe)
                                    agent._record_streamed_assistant_text(safe)

                    def reset_stream_delivery_tracking():
                        # Exclude writer claims and resets during the identity swap.
                        # Saved native delivery/reset calls do not acquire this lock.
                        with agent._stream_writer_lock:
                            native_reset_stream_delivery()

                    def get_transport(api_mode=None):
                        nonlocal wrapped_transport, normalizer, normalizer_owned
                        transport = native_get_transport(api_mode)
                        if transport is not wrapped_transport:
                            restore_normalizer()
                            wrapped_transport = transport
                            normalizer = transport.normalize_response
                            normalizer_owned = 'normalize_response' in vars(transport)

                            def normalize_response(response, **kwargs):
                                nonlocal privacy_failed
                                try:
                                    check_privacy()
                                    normalized = normalizer(response, **kwargs)
                                    # Sanitize before native final-response regex handling.
                                    normalized.content = sanitize_content(normalized.content)
                                    # Flush tails before native callbacks unbind.
                                    finish_stream()
                                    return normalized
                                except Exception:
                                    privacy_failed = True
                                    reasoning_filter.failed = True
                                    raise RuntimeError(REASONING_ERROR) from None

                            transport.normalize_response = normalize_response
                        return transport

                    def fire_stream_delta(text: str) -> None:
                        nonlocal privacy_failed
                        with agent._stream_writer_lock:
                            try:
                                check_privacy()
                                if agent._stream_writer_superseded():
                                    native_fire_stream_delta(text)
                                    return
                                # Native delivery trims newlines and inserts tool separators.
                                visible = reasoning_filter.feed(text)
                                if not visible:
                                    return
                                if delivery.delivery is None and not delivery.prefix and visible[0].isspace():
                                    delivery.leading_whitespace = True
                                if (agent._stream_needs_break and not delivery.failed
                                        and delivery.delivery is None and not delivery.prefix
                                        and not delivery.leading_whitespace and visible.startswith('[')):
                                    agent._stream_needs_break = False
                                agent._stream_think_scrubber = visible_scrubber
                                try:
                                    native_fire_stream_delta(visible)
                                finally:
                                    agent._stream_think_scrubber = reasoning_filter
                            except Exception:
                                privacy_failed = True
                                raise RuntimeError(REASONING_ERROR) from None

                    agent._stream_think_scrubber = reasoning_filter
                    agent._get_transport = get_transport
                    agent._fire_stream_delta = fire_stream_delta
                    agent._reset_stream_delivery_tracking = reset_stream_delivery_tracking
                    try:
                        result = agent.run_conversation(
                            messages[-1]['content'], system_message=SYSTEM_PROMPT,
                            conversation_history=history, stream_callback=delta,
                        )
                        check_privacy()
                        finish_stream()
                        if isinstance(result, dict):
                            result['final_response'] = sanitize_content(result.get('final_response'))
                    finally:
                        with agent._stream_writer_lock:
                            restore_normalizer()
                            for name, (owned, original) in originals.items():
                                if owned:
                                    setattr(agent, name, original)
                                else:
                                    delattr(agent, name)
                        try:
                            exporter.force_flush()
                        except Exception:
                            tracing_failed = True
                            raise RuntimeError(TRACE_FAILURE_ERROR) from None
                    check_privacy()
                    if bridge_failed:
                        raise RuntimeError('Kestrel desktop bridge failed')
                    if (not delivery.failed
                            and not (delivery.delivery is None and delivery.prefix.startswith('['))
                            and is_max_iteration_handoff(result)):
                        # Hermes marks a capped turn resumable; its closing summary is unverified and never spoken.
                        print(f"Hermes turn incomplete: {result['turn_exit_reason']}", file=sys.stderr, flush=True)
                        emit({'incomplete': True})
                        continue
                    if (not isinstance(result, dict) or result.get('completed') is not True
                            or any(result.get(key) for key in ('partial', 'interrupted', 'failed', 'error'))):
                        reason = result.get('error') if isinstance(result, dict) else None
                        raise RuntimeError(reason or 'Hermes did not complete the reply.')
                    final = result.get('final_response')
                    if not isinstance(final, str) or not final.strip():
                        raise RuntimeError('Hermes returned an empty reply.')
                    if not streamed:
                        for event in delivery.feed(final):
                            emit(event)
                    for event in delivery.finish():
                        emit(event)
                    if preparing:
                        close_agent()
                    emit({'done': True})
                except Exception as error:
                    print(f'Hermes turn failed: {error}', file=sys.stderr, flush=True)
                    emit({'error': str(error) or type(error).__name__})
                    if tracing_failed or bridge_failed:
                        terminal_failure_reported = True
                        status = 1
                        break
        except Exception as error:
            diagnostic = f'Hermes engine unavailable: {error}'
            if error.__cause__ is not None and str(error.__cause__) != str(error):
                diagnostic += f': {error.__cause__}'
            print(diagnostic, file=sys.stderr, flush=True)
            emit({'error': str(error) or type(error).__name__})
            terminal_failure_reported = True
            status = 1
        finally:
            cleanup = []
            if agent is not None:
                cleanup.append((agent.close, ENGINE_CLOSE_ERROR))
            if runtime is not None:
                cleanup.append((runtime.shutdown, TRACE_FAILURE_ERROR))
            if exporter is not None:
                cleanup.extend(((exporter.force_flush, TRACE_FAILURE_ERROR),
                                (lambda: exporter.deregister('kestrel-local-trace'), TRACE_FAILURE_ERROR),
                                (exporter.shutdown, TRACE_FAILURE_ERROR)))
            for close, diagnostic in cleanup:
                try:
                    close()
                except Exception as error:
                    status = 1
                    print(f'{diagnostic}: {error}', file=sys.stderr, flush=True)
                    if not terminal_failure_reported:
                        emit({'error': diagnostic})
                        terminal_failure_reported = True
    return status


if __name__ == '__main__':
    raise SystemExit(main())
