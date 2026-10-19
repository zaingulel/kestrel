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
TRACE_ROOT = Path(__file__).resolve().parent / '.runtime/hermes-traces'
TRACE_STARTUP_ERROR = ('Local conversation tracing could not start. '
                       'Check runtime permissions and restart Kestrel.')
TRACE_FAILURE_ERROR = ('Local conversation tracing failed. Check free space and runtime '
                       'permissions, then restart Kestrel.')
BONSAI_URL = 'http://127.0.0.1:8080/v1'
SYSTEM_PROMPT = (
    "You are Kestrel, Zain's local voice assistant. Speak naturally in concise English. "
    "Usually answer in one or two short sentences, beginning with a short complete sentence. "
    "Use plain spoken text without markdown, lists, or stage directions. "
    "This session is a local conversation. You have no tools, desktop access, web access, "
    "or persistent memory. Be honest about that and never claim to have performed an action. "
    "Kestrel handles the exact spoken command mute locally. You cannot invoke that action; "
    "for a request to mute, explain that the owner must say mute on its own. "
    "Kestrel handles volume <level> percent or %, set volume [to] <level>, and set the volume [to] <level> locally. "
    "The owner must say one form on its own, as a complete turn, with a whole-number level from zero to one hundred. "
    "A percent or % suffix is required after volume <level> and optional after the set forms; "
    "one please is allowed at either end, never both. "
    "You cannot invoke that action or any other tool."
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
    except OSError:
        raise RuntimeError(TRACE_STARTUP_ERROR) from None


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
                metadata = home.lstat()
                if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) != 0o700):
                    raise RuntimeError(TRACE_STARTUP_ERROR)
                home = home.resolve(strict=True)
            except OSError:
                raise RuntimeError(TRACE_STARTUP_ERROR) from None
            os.chdir(home)
            config = {
                'model': {'context_length': 64000},
                'memory': {'memory_enabled': False, 'user_profile_enabled': False, 'provider': ''},
                'sessions': {'write_json_snapshots': False},
                'compression': {'enabled': False},
                'auxiliary': {'title_generation': {'enabled': False}},
                'plugins': {'enabled': []}, 'mcp_servers': {},
            }
            (home / 'config.yaml').write_text(json.dumps(config))
            validate_hermes_source()
            validate_local_configuration()
            try:
                session = create_trace_directory()
                event_file = session / 'events.jsonl'
                try:
                    event_file.lstat()
                except FileNotFoundError:
                    pass
                else:
                    raise RuntimeError(TRACE_STARTUP_ERROR)
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
                from run_agent import AIAgent
                from agent.relay_runtime import get_runtime
                import nemo_relay

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
                agent = AIAgent(
                    base_url=base_url, api_key='lm-studio', provider='custom', api_mode='chat_completions',
                    model='bonsai-2-9b', enabled_toolsets=[], disabled_toolsets=['terminal'],
                    skip_memory=True, skip_context_files=True, load_soul_identity=False,
                    session_db=None, fallback_model=None, save_trajectories=False,
                    checkpoints_enabled=False, quiet_mode=True, max_tokens=180,
                    reasoning_config={'enabled': False}, request_overrides={'temperature': 0.4},
                )
                agent._drop_thinking_only_and_merge_users = preserve_user_turns
            except Exception:
                raise RuntimeError(TRACE_STARTUP_ERROR) from None
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
                    if not isinstance(request, dict) or set(request) != {'messages'}:
                        raise ValueError('Expected only a messages field')
                    messages = request['messages']
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

                    def delta(text):
                        nonlocal streamed
                        if text:
                            streamed = True
                            emit({'text': text})

                    try:
                        result = agent.run_conversation(
                            messages[-1]['content'], system_message=SYSTEM_PROMPT,
                            conversation_history=history, stream_callback=delta,
                        )
                    finally:
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
                        emit({'text': final})
                    emit({'done': True})
                except Exception as error:
                    print(f'Hermes turn failed: {error}', file=sys.stderr, flush=True)
                    emit({'error': str(error) or type(error).__name__})
                    if tracing_failed:
                        terminal_failure_reported = True
                        status = 1
                        break
        except Exception as error:
            print(f'Hermes engine unavailable: {error}', file=sys.stderr, flush=True)
            emit({'error': str(error) or type(error).__name__})
            terminal_failure_reported = True
            status = 1
        finally:
            cleanup = []
            if agent is not None:
                cleanup.append(agent.close)
            if runtime is not None:
                cleanup.append(runtime.shutdown)
            if exporter is not None:
                cleanup.extend((exporter.force_flush,
                                lambda: exporter.deregister('kestrel-local-trace'), exporter.shutdown))
            for close in cleanup:
                try:
                    close()
                except Exception:
                    status = 1
                    print(TRACE_FAILURE_ERROR, file=sys.stderr, flush=True)
                    if not terminal_failure_reported:
                        emit({'error': TRACE_FAILURE_ERROR})
                        terminal_failure_reported = True
    return status


if __name__ == '__main__':
    raise SystemExit(main())
