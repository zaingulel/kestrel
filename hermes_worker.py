"""Conversation-only Hermes child; its launching parent owns the temporary home."""

from contextlib import redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

HERMES_PYTHON = Path(__file__).resolve().parent / '.runtime/hermes-0.22.2/venv/bin/python'
HERMES_SOURCE = Path(__file__).resolve().parent / '.runtime/hermes-0.22.2/source'
HERMES_COMMIT = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
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

    def emit(event):
        print(json.dumps(event), file=wire, flush=True)

    with redirect_stdout(sys.stderr):
        agent = None
        try:
            home = Path(os.environ['HERMES_HOME']).resolve(strict=True)
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
            from run_agent import AIAgent

            agent = AIAgent(
                base_url=base_url, api_key='lm-studio', provider='custom', api_mode='chat_completions',
                model='bonsai-2-9b', enabled_toolsets=[], disabled_toolsets=['terminal'],
                skip_memory=True, skip_context_files=True, load_soul_identity=False,
                session_db=None, fallback_model=None, save_trajectories=False,
                checkpoints_enabled=False, quiet_mode=True, max_tokens=180,
                reasoning_config={'enabled': False}, request_overrides={'temperature': 0.4},
            )
            agent._drop_thinking_only_and_merge_users = preserve_user_turns
            emit({'ready': True})
            while line := sys.stdin.buffer.readline(1024 * 1024 + 1):
                if len(line) > 1024 * 1024:
                    emit({'error': 'Hermes request exceeds 1 MiB. Restart Kestrel and try again.'})
                    return
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

                    result = agent.run_conversation(
                        messages[-1]['content'], system_message=SYSTEM_PROMPT,
                        conversation_history=history, stream_callback=delta,
                    )
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
        except Exception as error:
            print(f'Hermes engine unavailable: {error}', file=sys.stderr, flush=True)
            emit({'error': str(error) or type(error).__name__})
        finally:
            if agent is not None:
                agent.close()


if __name__ == '__main__':
    main()
