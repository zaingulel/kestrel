"""Conversation-only Hermes child; its launching parent owns the temporary home."""

from contextlib import redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

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
BONSAI_URL = 'http://127.0.0.1:8080/v1'
DELIVERY_LABELS = frozenset(('neutral', 'curious', 'gently_pleased', 'reassuring'))
DELIVERY_ERROR = 'Hermes returned an invalid delivery header or empty reply. Restart Kestrel and try again.'


class ReplyDeliveryPrefix:
    def __init__(self):
        self.prefix = ''
        self.delivery = None
        self.has_text = False
        self.failed = False

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
                self.prefix += char
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

    def finish(self) -> None:
        if self.failed or self.delivery is None or not self.has_text:
            raise RuntimeError(DELIVERY_ERROR)


SYSTEM_PROMPT = (
    "You are Kestrel, Zain's local voice assistant. Speak naturally in concise English. "
    "Usually answer in one or two short sentences, beginning with a short complete sentence. "
    "Use no markdown, lists, acting directions, accent changes or persona changes. "
    "This session is a local conversation. Your sole tool is native local memory for small "
    "facts and preferences. Maintain those notes automatically when useful, including updating "
    "or removing outdated notes. Claim a save only after a successful memory tool result. "
    "You have no desktop or web access. "
    "Kestrel handles the exact spoken command mute locally. You cannot invoke that action; "
    "for a request to mute, explain that the owner must say mute on its own. "
    "Kestrel handles volume <level> percent or %, set volume [to] <level>, and set the volume [to] <level> locally. "
    "The owner must say one form on its own, as a complete turn, with a whole-number level from zero to one hundred. "
    "A percent or % suffix is required after volume <level> and optional after the set forms; "
    "one please is allowed at either end, never both. "
    "You cannot invoke desktop actions; only the memory tool is available.\n\n"
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
    'What did you find?\n'
    'Someone shares that they earned a qualification after working hard:\n'
    '[delivery:gently_pleased]\n'
    'Well done, that took real effort.\n'
    'Someone is worried about an unfamiliar situation:\n'
    '[delivery:reassuring]\n'
    'You can take it one step at a time.\n'
    '\n'
    'Required output format for every new reply: begin immediately with exactly one of '
    '[delivery:neutral], [delivery:curious], [delivery:gently_pleased] or [delivery:reassuring], then'
    ' a newline, then your concise spoken reply. Never omit the header, even for a very short factual'
    ' answer, a changed subject, or a replacement request after an interruption. Earlier assistant '
    'messages have their headers removed before entering conversation history; do not imitate their '
    'header-free format. Emit the header once at the beginning of the reply, not again within its '
    'text or when continuing the same answer. Nothing comes before the header. After it, output only '
    'the words to speak, with no delivery explanations or acting directions.'
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
                'memory': {'memory_enabled': True, 'user_profile_enabled': True, 'provider': '',
                           'memory_char_limit': 2200, 'user_char_limit': 1375, 'write_approval': False},
                'sessions': {'write_json_snapshots': False},
                'compression': {'enabled': False},
                'auxiliary': {'title_generation': {'enabled': False}},
                'plugins': {'enabled': []}, 'mcp_servers': {},
            }
            (home / 'config.yaml').write_text(json.dumps(config))
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
            from agent.relay_runtime import get_runtime
            import nemo_relay

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
                    model='bonsai-2-9b', enabled_toolsets=['memory'] if memory else [], disabled_toolsets=['terminal'],
                    skip_memory=True, skip_background_review=True, skip_context_files=True, load_soul_identity=False,
                    session_db=None, fallback_model=None, save_trajectories=False,
                    checkpoints_enabled=False, quiet_mode=True, max_tokens=180,
                    reasoning_config={'enabled': False}, request_overrides={'temperature': 0.4},
                )
                built._drop_thinking_only_and_merge_users = preserve_user_turns
                if memory and (built.valid_tool_names != {'memory'}
                               or {tool['function']['name'] for tool in built.tools} != {'memory'}
                               or built._memory_store is None or built._memory_manager is not None):
                    try:
                        built.close()
                    except Exception:
                        raise RuntimeError(ENGINE_CLOSE_ERROR) from None
                    raise RuntimeError(MEMORY_ERROR)
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
                        messages = [{'role': 'user', 'content': 'Hello'}]
                    elif set(request) == {'messages'}:
                        if not begun:
                            raise ValueError('Begin a fresh conversation before sending messages')
                        validate_memory_storage()
                        messages = request['messages']
                    else:
                        raise ValueError('Expected an exact preparation, begin or messages request')
                    if not isinstance(messages, list) or not messages:
                        raise ValueError('Expected nonempty conversation history')
                    for message in messages:
                        if (not isinstance(message, dict) or set(message) != {'role', 'content'}
                                or message['role'] not in ('user', 'assistant')
                                or not isinstance(message['content'], str)
                                or not message['content'].strip()):
                            raise ValueError('Expected text-only user/assistant messages')
                    if messages[-1]['role'] != 'user':
                        raise ValueError('Conversation history must end in user')
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
                        streamed = True
                        for event in delivery.feed(text):
                            emit(event)

                    # Pinned native tool rounds insert a display separator before the first header.
                    native_fire_stream_delta = agent._fire_stream_delta

                    def fire_stream_delta(text: str) -> None:
                        if (not agent._stream_writer_superseded() and agent._stream_needs_break
                                and not delivery.failed and delivery.delivery is None
                                and not delivery.prefix and isinstance(text, str) and text.startswith('[')):
                            agent._stream_needs_break = False
                        native_fire_stream_delta(text)

                    agent._fire_stream_delta = fire_stream_delta
                    try:
                        result = agent.run_conversation(
                            messages[-1]['content'], system_message=SYSTEM_PROMPT,
                            conversation_history=history, stream_callback=delta,
                        )
                    finally:
                        agent._fire_stream_delta = native_fire_stream_delta
                        try:
                            exporter.force_flush()
                        except Exception:
                            tracing_failed = True
                            raise RuntimeError(TRACE_FAILURE_ERROR) from None
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
                    delivery.finish()
                    if preparing:
                        close_agent()
                    emit({'done': True})
                except Exception as error:
                    print(f'Hermes turn failed: {error}', file=sys.stderr, flush=True)
                    emit({'error': str(error) or type(error).__name__})
                    if tracing_failed:
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
