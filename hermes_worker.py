"""Conversation-only Hermes child; its launching parent owns the temporary home."""

from contextlib import redirect_stdout
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys

HERMES_PYTHON = Path('/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/bin/python')
ALLY_URL = 'http://192.168.0.150:1234/v1'
SYSTEM_PROMPT = (
    "You are Kestrel, Zain's local voice assistant. Speak naturally in concise English. "
    "Usually answer in one or two short sentences, beginning with a short complete sentence. "
    "Use plain spoken text without markdown, lists, or stage directions. "
    "This session is a conversation trial. You have no tools, desktop access, web access, "
    "or persistent memory. Be honest about that and never claim to have performed an action. "
    "Kestrel handles the exact spoken command mute locally. You cannot invoke that action; "
    "for a request to mute, explain that the owner must say mute on its own."
)


def child_environment(home):
    home = Path(home).resolve()
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ')
                   if key in os.environ}
    environment.update(HERMES_HOME=str(home), HERMES_MANAGED_DIR=str(home / 'managed'),
                       PYTHON_DOTENV_DISABLED='1')
    return environment


def main(*, base_url=ALLY_URL):
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
            installed_version = version('hermes-agent')
            if installed_version != '0.19.0':
                raise RuntimeError(f'Unsupported Hermes version {installed_version}; expected 0.19.0')
            from run_agent import AIAgent

            agent = AIAgent(
                base_url=base_url, api_key='lm-studio', provider='custom', api_mode='chat_completions',
                model='underdog-saluki-27b-1.0', enabled_toolsets=[], disabled_toolsets=['terminal'],
                skip_memory=True, skip_context_files=True, load_soul_identity=False,
                session_db=None, fallback_model=None, save_trajectories=False,
                checkpoints_enabled=False, quiet_mode=True, max_tokens=180,
                reasoning_config={'enabled': False}, request_overrides={'temperature': 0.4},
            )
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
                    streamed = False

                    def delta(text):
                        nonlocal streamed
                        if text:
                            streamed = True
                            emit({'text': text})

                    result = agent.run_conversation(
                        messages[-1]['content'], system_message=SYSTEM_PROMPT,
                        conversation_history=messages[:-1], stream_callback=delta,
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
