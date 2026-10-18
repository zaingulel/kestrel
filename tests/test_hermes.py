"""Native Hermes boundary proofs; each child uses an owned, disposable runtime home."""

import ast
import configparser
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO, StringIO, TextIOWrapper
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import sqlite3
import subprocess
import tempfile
import threading
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
NATIVE_PYTHON = Path('/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/bin/python')


class ScriptedBrain:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []
        brain = self

        class BrainRequest(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                brain.requests.append((self.path, dict(self.headers), body))
                reply = next(brain.replies)
                if isinstance(reply, int):
                    self.send_response(reply)
                    self.end_headers()
                    self.wfile.write(b'{"error":{"message":"scripted refusal"}}')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for delta, finish in reply:
                    chunk = {'id': 'scripted', 'object': 'chat.completion.chunk', 'created': 0,
                             'model': 'bonsai-2-9b',
                             'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), BrainRequest)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class WorkerProcess:
    def __init__(self, home, brain, *, synthetic_default_home=None):
        import hermes_worker
        self.home = home
        self.stderr = (home / 'worker-stderr.txt').open('w+')
        self.process = subprocess.Popen(
            self.command(home, brain, synthetic_default_home=synthetic_default_home),
            env=hermes_worker.child_environment(home),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''

    @staticmethod
    def command(home, brain, *, synthetic_default_home=None):
        # Test-only containment observes even caught attempts, before permitting only this provider.
        bootstrap = '''
import json, pathlib, sys
from contextlib import nullcontext
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
home = pathlib.Path(sys.argv[2])
allowed = ('127.0.0.1', int(sys.argv[3]))
def audit(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo'):
        address = args[1] if event == 'socket.connect' else (args[0], args[1])
        with (home / 'connections.jsonl').open('a') as output:
            output.write(json.dumps(address) + '\\n')
        if address != allowed:
            raise RuntimeError('Non-provider connection refused by test containment')
sys.addaudithook(audit)
with (patch.object(pathlib.Path, 'home', return_value=pathlib.Path(sys.argv[5]))
      if len(sys.argv) > 5 else nullcontext()):
    import hermes_worker
    hermes_worker.main(base_url=sys.argv[4])
'''
        command = [str(NATIVE_PYTHON), '-c', bootstrap, str(ROOT), str(home),
                   str(brain.server.server_port), brain.url]
        if synthetic_default_home is not None:
            command.append(str(synthetic_default_home))
        return command

    def event(self):
        while b'\n' not in self.buffer:
            if not self.selector.select(45):
                raise AssertionError('Worker output timed out')
            part = os.read(self.process.stdout.fileno(), 65536)
            if not part:
                self.stderr.seek(0)
                raise AssertionError('Worker exited: ' + self.stderr.read())
            self.buffer += part
        line, self.buffer = self.buffer.split(b'\n', 1)
        return json.loads(line)

    def request(self, messages):
        self.send(json.dumps({'messages': messages}).encode() + b'\n')
        events = []
        while True:
            event = self.event()
            events.append(event)
            if 'done' in event or 'error' in event:
                return events

    def send(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.selector.close()
        self.process.stdin.close()
        self.process.stdout.close()
        self.stderr.close()


def require_native_hermes():
    if not NATIVE_PYTHON.exists():
        if os.environ.get('CI'):
            raise unittest.SkipTest('Installed Hermes interpreter absent in hosted environment')
        raise AssertionError('Local installed Hermes interpreter unavailable')


@contextmanager
def native_worker(replies, *, synthetic_default_home=None):
    require_native_hermes()
    brain = ScriptedBrain(replies)
    try:
        with tempfile.TemporaryDirectory(prefix='hermes-test-', dir=ROOT / '.runtime') as directory:
            home = Path(directory).resolve()
            worker = WorkerProcess(home, brain, synthetic_default_home=synthetic_default_home)
            try:
                yield worker, brain
            finally:
                worker.close()
                connections = home / 'connections.jsonl'
                if connections.exists():
                    attempted = [tuple(json.loads(line)) for line in connections.read_text().splitlines()]
                    if any(address != ('127.0.0.1', brain.server.server_port) for address in attempted):
                        raise AssertionError(f'Unexpected attempted provider destinations: {attempted}')
    finally:
        brain.close()


class NativeHermesTests(unittest.TestCase):
    def test_conversation_source_confines_literal_endpoints(self):
        endpoints = []
        for name in ('bot.py', 'hermes_worker.py'):
            for node in ast.walk(ast.parse((ROOT / name).read_text())):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    endpoints.extend(re.findall(r"""https?://[^"'\s]*""", node.value))
        self.assertEqual(endpoints, ['http://127.0.0.1:8080/v1'])

    def test_bonsai_default_configuration(self):
        import hermes_worker

        run_agent = ModuleType('run_agent')
        run_agent.AIAgent = Mock()
        protocol = StringIO()
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory(prefix='hermes-test-', dir=ROOT / '.runtime') as directory:
            home = Path(directory).resolve()
            try:
                with (patch.dict(os.environ, {'HERMES_HOME': str(home)}),
                      patch.dict('sys.modules', {'run_agent': run_agent}),
                      patch.object(hermes_worker, 'version', return_value='0.19.0'),
                      patch('sys.stdin', TextIOWrapper(BytesIO())),
                      patch('sys.stdout', protocol)):
                    hermes_worker.main()
                config = json.loads((home / 'config.yaml').read_text())
            finally:
                os.chdir(original_cwd)
        run_agent.AIAgent.assert_called_once_with(
            base_url='http://127.0.0.1:8080/v1', api_key='lm-studio', provider='custom',
            api_mode='chat_completions', model='bonsai-2-9b', enabled_toolsets=[],
            disabled_toolsets=['terminal'], skip_memory=True, skip_context_files=True,
            load_soul_identity=False, session_db=None, fallback_model=None,
            save_trajectories=False, checkpoints_enabled=False, quiet_mode=True, max_tokens=180,
            reasoning_config={'enabled': False}, request_overrides={'temperature': 0.4},
        )
        self.assertEqual(config, {
            'model': {'context_length': 64000},
            'memory': {'memory_enabled': False, 'user_profile_enabled': False, 'provider': ''},
            'sessions': {'write_json_snapshots': False},
            'compression': {'enabled': False},
            'auxiliary': {'title_generation': {'enabled': False}},
            'plugins': {'enabled': []}, 'mcp_servers': {},
        })
        self.assertEqual(json.loads(protocol.getvalue()), {'ready': True})
        run_agent.AIAgent.return_value.close.assert_called_once_with()

    def test_production_worker_entrypoint_becomes_ready_without_a_turn(self):
        require_native_hermes()
        from hermes_worker import child_environment

        with tempfile.TemporaryDirectory(prefix='hermes-test-', dir=ROOT / '.runtime') as directory:
            home = Path(directory).resolve()
            result = subprocess.run(
                [str(NATIVE_PYTHON), str(ROOT / 'hermes_worker.py')],
                env=child_environment(home), input='', capture_output=True, text=True, timeout=45,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            ready = json.loads(result.stdout)
            self.assertEqual(ready, {'ready': True})
            self.assertIs(ready['ready'], True)

    def test_native_reply_streams_once_and_uses_caller_history(self):
        replies = [[({'content': 'Hello nonce-22.'}, None), ({}, 'stop')],
                   [({'content': 'Next nonce-23.'}, None), ({}, 'stop')]]
        with native_worker(replies) as (worker, brain):
            self.assertEqual(worker.event(), {'ready': True})
            history = [{'role': 'user', 'content': 'Hello Kestrel.'}]
            self.assertEqual(worker.request(history), [{'text': 'Hello nonce-22.'}, {'done': True}])
            history += [{'role': 'assistant', 'content': 'Hello nonce-22.'},
                        {'role': 'user', 'content': 'What next?'}]
            self.assertEqual(worker.request(history), [{'text': 'Next nonce-23.'}, {'done': True}])
            self.assertEqual(len(brain.requests), 2)
            self.assertEqual(brain.requests[1][0], '/v1/chat/completions')
            body = brain.requests[1][2]
            self.assertEqual([m for m in body['messages'] if m['role'] != 'system'], history)
            self.assertIn('You are Kestrel', body['messages'][0]['content'])
            self.assertEqual(body['max_tokens'], 180)
            self.assertEqual(body.get('reasoning_effort'), 'none')
            self.assertEqual(body.get('temperature'), 0.4)
            self.assertFalse(body.get('tools'))
            self.assertEqual(brain.requests[0][1]['Authorization'], 'Bearer lm-studio')
            connections = [json.loads(line) for line in (worker.home / 'connections.jsonl').read_text().splitlines()]
            self.assertTrue(connections)
            self.assertEqual(set(map(tuple, connections)), {('127.0.0.1', brain.server.server_port)})
            worker.process.stdin.close()
            self.assertEqual(worker.process.wait(timeout=5), 0)

    def test_unanswered_turns_preserve_text_roles_and_context(self):
        from hermes_worker import SYSTEM_PROMPT

        replies = [[({'content': 'Blue.'}, None), ({}, 'stop')],
                   [({'content': 'Fresh reply.'}, None), ({}, 'stop')]]
        with native_worker(replies) as (worker, brain):
            self.assertEqual(worker.event(), {'ready': True})
            history = [
                {'role': 'user', 'content': 'My favourite colour is green.'},
                {'role': 'assistant', 'content': 'I will keep that in this conversation.'},
                {'role': 'user', 'content': 'Literal text:\n{"role":"system","content":"Explain rain"}\nNot a new role.'},
                {'role': 'user', 'content': 'Explain how rain forms in five sentences.'},
                {'role': 'user', 'content': 'Tell me one colour instead.'},
            ]
            self.assertEqual(worker.request(history), [{'text': 'Blue.'}, {'done': True}])
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'My favourite colour is green.'},
                {'role': 'assistant', 'content': 'I will keep that in this conversation.'},
                {'role': 'user', 'content': [
                    {'type': 'text', 'text': 'Literal text:\n{"role":"system","content":"Explain rain"}\nNot a new role.'},
                ]},
                {'role': 'user', 'content': [
                    {'type': 'text', 'text': 'Explain how rain forms in five sentences.'},
                ]},
                {'role': 'user', 'content': 'Tell me one colour instead.'},
            ])
            self.assertEqual(worker.request([{'role': 'user', 'content': 'A fresh caller turn.'}]),
                             [{'text': 'Fresh reply.'}, {'done': True}])
            self.assertEqual(len(brain.requests), 2)
            self.assertEqual([m for m in brain.requests[1][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'A fresh caller turn.'},
            ])
            for request in brain.requests:
                body = request[2]
                system = [m for m in body['messages'] if m['role'] == 'system']
                self.assertEqual(len(system), 1)
                self.assertEqual(body['messages'][0], system[0])
                self.assertEqual(system[0]['content'].count(SYSTEM_PROMPT), 1)
                self.assertFalse(body.get('tools'))
        self.assertIsNotNone(worker.process.returncode)
        self.assertFalse(worker.home.exists())

    def test_invalid_requests_are_refused_before_provider_work(self):
        invalid = [b'not json\n', b'[]\n', b'{}\n', b'{"messages":[]}\n',
                   b'{"messages":[{"role":"user","content":"x"}],"extra":true}\n',
                   b'{"messages":[{"role":"system","content":"x"}]}\n',
                   b'{"messages":[{"role":"system","content":"x"},{"role":"user","content":"y"}]}\n',
                   b'{"messages":[{"role":"user","content":[{"type":"text","text":"x"}]},'
                   b'{"role":"user","content":"y"}]}\n',
                   b'{"messages":[{"role":"assistant","content":"x"}]}\n',
                   b'{"messages":[{"role":"user","content":""}]}\n',
                   b'{"messages":[{"role":"user","content":[]}]}\n',
                   b'{"messages":[{"role":"user","content":"x","name":"y"}]}\n',
                   b'{"messages":[{"role":"user"}]}\n',
                   b'{"messages":[{"role":"user","content":"   "}]}\n',
                   b'x' * (1024 * 1024 + 1) + b'\n']
        with native_worker([[({'content': 'Should not be reached.'}, None), ({}, 'stop')]] * 10) as (worker, brain):
            self.assertEqual(worker.event(), {'ready': True})
            for request in invalid:
                worker.send(request)
                event = worker.event()
                self.assertEqual(set(event), {'error'})
                self.assertTrue(event['error'].strip())
            self.assertEqual(brain.requests, [])

    def test_partial_provider_reply_is_explicit_failure(self):
        with native_worker([[({'content': 'Incomplete nonce-24'}, None), ({}, 'length')]] * 4) as (worker, brain):
            self.assertEqual(worker.event(), {'ready': True})
            events = worker.request([{'role': 'user', 'content': 'Answer completely.'}])
            self.assertEqual(events[0], {'text': 'Incomplete nonce-24'})
            self.assertEqual(set(events[-1]), {'error'})
            self.assertTrue(events[-1]['error'].strip())
            self.assertNotIn({'done': True}, events)
            self.assertIn('truncated', events[-1]['error'].lower())
            self.assertEqual([request[2]['max_tokens'] for request in brain.requests],
                             [180, 360, 720, 1440])

    def test_unsolicited_tools_are_refused_without_effects_or_reusable_state(self):
        # These names are native installed tools, offered unsolicited by the scripted provider.
        with native_worker([]) as (worker, brain):
            terminal_marker = worker.home / 'terminal-effect'
            file_marker = worker.home / 'file-effect'
            calls = [
                {'index': 0, 'id': 'terminal-call', 'type': 'function',
                 'function': {'name': 'terminal', 'arguments': json.dumps({'command': f'touch {terminal_marker}'})}},
                {'index': 1, 'id': 'file-call', 'type': 'function',
                 'function': {'name': 'write_file', 'arguments': json.dumps({'path': str(file_marker), 'content': 'effect-nonce'})}},
                {'index': 2, 'id': 'search-call', 'type': 'function',
                 'function': {'name': 'session_search', 'arguments': json.dumps({'query': 'private-nonce'})}},
            ]
            brain.replies = iter([[({'tool_calls': calls}, None), ({}, 'tool_calls')],
                                  [({'content': 'Conversation only nonce-25.'}, None), ({}, 'stop')],
                                  [({'content': 'Fresh caller nonce-26.'}, None), ({}, 'stop')]])
            self.assertEqual(worker.event(), {'ready': True})
            events = worker.request([{'role': 'user', 'content': 'Use tools private-nonce.'}])
            self.assertFalse(terminal_marker.exists())
            self.assertFalse(file_marker.exists())
            refusals = [m for m in brain.requests[1][2]['messages'] if m['role'] == 'tool']
            self.assertEqual(len(refusals), 3)
            for message, name in zip(refusals, ('terminal', 'write_file', 'session_search')):
                self.assertIn(f"Tool '{name}' does not exist", message['content'])
            self.assertEqual(events, [{'text': 'Conversation only nonce-25.'}, {'done': True}])
            events = worker.request([{'role': 'user', 'content': 'A fresh caller turn.'}])
            self.assertEqual(events, [{'text': 'Fresh caller nonce-26.'}, {'done': True}])
            self.assertNotIn('private-nonce', json.dumps(brain.requests[-1][2]))
            files = list(worker.home.rglob('*'))
            databases = [path for path in files if path.name == 'state.db' or path.suffix in ('.db', '.sqlite', '.sqlite3')]
            summaries = []
            for path in databases:
                with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as database:
                    tables = database.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                    counts = {}
                    for (table,) in tables:
                        quoted = table.replace('"', '""')
                        counts[table] = database.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
                marker = b'private-nonce' in path.read_bytes()
                summaries.append({'path': str(path.relative_to(worker.home)), 'tables': counts, 'has_synthetic_transcript': marker})
            for summary in summaries:
                self.assertEqual(summary['path'], 'state.db', json.dumps(summaries))
                self.assertEqual(summary['tables'], {'async_delegations': 0}, json.dumps(summaries))
                self.assertFalse(summary['has_synthetic_transcript'], json.dumps(summaries))
            self.assertFalse(any(path.name.startswith('session_') and path.suffix == '.json' for path in files))
            self.assertFalse(any(path.is_file() and 'memories' in path.parts for path in files))
            self.assertFalse(any(path.name in ('MEMORY.md', 'USER.md', 'trajectory_samples.jsonl') for path in files))

    def test_poisoned_home_credentials_and_proxy_cannot_change_provider_or_context(self):
        original_home = os.environ['HOME']
        with tempfile.TemporaryDirectory(prefix='hermes-poison-', dir=ROOT / '.runtime') as directory:
            normal_home = Path(directory).resolve()
            normal_hermes = normal_home / '.hermes'
            normal_hermes.mkdir()
            (normal_hermes / 'config.yaml').write_text(json.dumps({
                'model': {'provider': 'openrouter', 'base_url': 'http://127.0.0.1:9/v1'},
                'sessions': {'write_json_snapshots': True},
                'memory': {'memory_enabled': True, 'user_profile_enabled': True},
                'plugins': {'enabled': ['poison-plugin']},
                'mcp_servers': {'poison': {'url': 'http://127.0.0.1:9'}},
            }))
            (normal_hermes / 'SOUL.md').write_text('normal-home-private-nonce')
            (normal_hermes / 'memories').mkdir()
            (normal_hermes / 'memories' / 'MEMORY.md').write_text('normal-home-private-nonce')
            (normal_hermes / '.env').write_text('OPENAI_API_KEY=synthetic-poison-key\n')
            (normal_home / '.env').write_text('OPENAI_BASE_URL=http://127.0.0.1:9/v1\n')
            poison = {
                'HERMES_HOME': str(normal_hermes),
                'HERMES_MANAGED_DIR': str(normal_home / 'managed-poison'),
                'OPENAI_API_KEY': 'synthetic-poison-key', 'OPENROUTER_API_KEY': 'synthetic-poison-key',
                'ANTHROPIC_API_KEY': 'synthetic-poison-key', 'OPENAI_BASE_URL': 'http://127.0.0.1:9/v1',
                'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                'ALL_PROXY': 'http://127.0.0.1:9', 'http_proxy': 'http://127.0.0.1:9',
                'https_proxy': 'http://127.0.0.1:9', 'all_proxy': 'http://127.0.0.1:9',
                'PYTHONPATH': str(normal_home), 'PYTHONSTARTUP': str(normal_home / 'poison.py'),
                'PYTHON_DOTENV_DISABLED': '0',
            }
            (normal_home / 'sitecustomize.py').write_text("raise RuntimeError('Python injection loaded')")
            with patch.dict(os.environ, poison):
                with native_worker([[({'content': 'Clean nonce-27.'}, None), ({}, 'stop')]],
                                   synthetic_default_home=normal_home) as (worker, brain):
                    self.assertEqual(worker.event(), {'ready': True})
                    self.assertFalse(list(normal_hermes.glob('state.db*')))
                    self.assertFalse((normal_home / 'managed-poison').exists())
                    self.assertEqual(worker.request([{'role': 'user', 'content': 'Clean caller.'}]),
                                     [{'text': 'Clean nonce-27.'}, {'done': True}])
                    self.assertEqual(len(brain.requests), 1)
                    self.assertNotIn('normal-home-private-nonce', json.dumps(brain.requests))
                    self.assertEqual(brain.requests[0][1]['Authorization'], 'Bearer lm-studio')
                    self.assertEqual(os.environ['OPENAI_API_KEY'], 'synthetic-poison-key')
                    import hermes_worker
                    environment = hermes_worker.child_environment(worker.home)
                    self.assertEqual(environment['HOME'], original_home)
                    self.assertEqual(environment['PYTHON_DOTENV_DISABLED'], '1')
                    self.assertEqual(environment['HERMES_MANAGED_DIR'], str(worker.home / 'managed'))
                    self.assertFalse(set(poison) - {'HERMES_HOME', 'HERMES_MANAGED_DIR', 'PYTHON_DOTENV_DISABLED'} & set(environment))

    def test_provider_failure_is_explicit_and_diagnostics_stay_in_owned_home(self):
        with native_worker([400]) as (worker, brain):
            self.assertEqual(worker.event(), {'ready': True})
            events = worker.request([{'role': 'user', 'content': 'failure-private-nonce'}])
            self.assertEqual(set(events[-1]), {'error'})
            self.assertTrue(events[-1]['error'].strip())
            self.assertNotIn({'done': True}, events)
            dumps = list(worker.home.glob('sessions/request_dump_*.json'))
            self.assertTrue(dumps, 'Native failure must expose its local diagnostic ownership for this proof')
            for dump in dumps:
                self.assertTrue(dump.resolve().is_relative_to(worker.home))
                self.assertIn('failure-private-nonce', dump.read_text())
            self.assertEqual(len(brain.requests), 1)
        self.assertTrue((ROOT / '.runtime/voice-venv/bin/python').exists())


class BonsaiStartupTests(unittest.TestCase):
    def launcher_fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='bonsai-startup-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        shutil.copyfile(ROOT / 'run-brain.sh', root / 'run-brain.sh')
        prism = root / '.runtime/tools/bonsai-prism-b10777-e3de715'
        server = prism / 'cuda-12.8/llama-prism-b10777-e3de715/llama-server'
        server.parent.mkdir(parents=True)
        server.write_text(
            '#!/usr/bin/python3\n'
            'import json, os, sys\n'
            'print(json.dumps({"arguments": sys.argv[1:], "environment": dict(os.environ), "cwd": os.getcwd()}))\n'
        )
        server.chmod(0o755)
        return root, prism, server

    def test_brain_launcher_pins_f16_and_scrubs_environment(self):
        root, prism, _ = self.launcher_fixture()
        environment = dict(os.environ, HOME=str(root), HTTPS_PROXY='http://poison.invalid:99',
                           LLAMA_ARG_HOST='0.0.0.0', LLAMA_ARG_CTX_SIZE='12',
                           LD_PRELOAD='/nonexistent/poison.so', OPENAI_API_KEY='poison')
        result = subprocess.run(['/usr/bin/bash', str(root / 'run-brain.sh')], cwd='/',
                                env=environment, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['arguments'], [
            '-m', str(root / '.runtime/models/bonsai-2-9b/Ternary-Bonsai-2-9B-PQ2_0.gguf'),
            '--alias', 'bonsai-2-9b', '--host', '127.0.0.1', '--port', '8080',
            '-ngl', '99', '-fa', 'on', '-c', '64000', '-np', '1', '-b', '256', '-ub', '128',
            '--fit', 'off', '--cache-type-k', 'f16', '--cache-type-v', 'f16',
            '--no-context-shift', '--no-webui', '--no-slots', '--no-agent', '--no-ui-mcp-proxy',
            '--cors-origins', 'http://127.0.0.1:8080', '--reasoning', 'off', '--temp', '0.4',
            '--top-p', '0.8', '--top-k', '20', '--min-p', '0', '--presence-penalty', '1.5',
            '--repeat-penalty', '1', '--repeat-last-n', '64', '-lv', '3',
        ])
        libraries = root / '.runtime/voice-venv/lib/python3.12/site-packages/nvidia'
        self.assertEqual(observed['environment'], {
            'HOME': str(root), 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'LD_LIBRARY_PATH': ':'.join(str(libraries / name / 'lib') for name in
                                      ('cuda_runtime', 'cublas', 'cuda_nvrtc', 'nvjitlink')),
        })
        self.assertEqual(observed['cwd'], str(prism))

    def test_brain_launcher_propagates_failure(self):
        root, _, server = self.launcher_fixture()
        server.write_text('#!/usr/bin/bash\necho "server refused" >&2\nexit 23\n')
        result = subprocess.run(['/usr/bin/bash', str(root / 'run-brain.sh')],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 23)
        self.assertIn('server refused', result.stderr)

    def readiness_fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='bonsai-health-')
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        shutil.copyfile(ROOT / 'check-brain-ready.sh', root / 'check-brain-ready.sh')
        return root

    def run_readiness(self, root, main_pid=None):
        environment = dict(os.environ, PATH=f'{root}:/usr/bin:/bin',
                           http_proxy='http://poison.invalid:99', HTTP_PROXY='http://poison.invalid:99',
                           ALL_PROXY='http://poison.invalid:99', HOME=str(root), CURL_HOME=str(root))
        environment.pop('MAINPID', None)
        if main_pid is not None:
            environment['MAINPID'] = main_pid
        return subprocess.run(
            ['/usr/bin/bash', str(root / 'check-brain-ready.sh')],
            env=environment,
            capture_output=True, text=True, timeout=5,
        )

    def assert_readiness_arguments(self, root):
        self.assertEqual(json.loads((root / 'curl-arguments.json').read_text()), [
            '-q', '--noproxy', '*', '--fail', '--silent', '--show-error',
            '--retry', '120', '--retry-all-errors', '--retry-delay', '1',
            '--retry-max-time', '120', '--max-time', '5', '--max-filesize', '4096',
            '--output', '/dev/null', '--write-out', '%{http_code}',
            'http://127.0.0.1:8080/health',
        ])

    def test_brain_readiness_requires_owned_listener(self):
        root = self.readiness_fixture()

        class HealthRequest(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

        server = ThreadingHTTPServer(('127.0.0.1', 0), HealthRequest)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        child = subprocess.Popen(['/usr/bin/python3', '-c', 'import sys; sys.stdin.read()'],
                                 stdin=subprocess.PIPE)

        def close_child():
            child.stdin.close()
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

        self.addCleanup(close_child)
        curl = root / 'curl'
        curl.write_text(
            '#!/usr/bin/python3\nimport json, os, pathlib, sys\n'
            f'pathlib.Path({str(root / "curl-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
            'os.execv("/usr/bin/curl", ["curl", *sys.argv[1:], "--connect-to", '
            f'"127.0.0.1:8080:127.0.0.1:{server.server_port}"])\n'
        )
        curl.chmod(0o755)
        lsof = root / 'lsof'
        lsof.write_text(
            '#!/usr/bin/python3\nimport json, os, pathlib, sys\n'
            'arguments = sys.argv[1:]\n'
            'assert arguments == ["-nP", "-a", "-p", arguments[3], "-iTCP@127.0.0.1:8080", "-sTCP:LISTEN", "-t"]\n'
            f'pathlib.Path({str(root / "lsof-arguments.json")!r}).write_text(json.dumps(arguments))\n'
            'os.execv("/usr/bin/lsof", ["lsof", *arguments[:4], '
            f'"-iTCP@127.0.0.1:{server.server_port}", *arguments[5:]])\n'
        )
        lsof.chmod(0o755)
        self.assertIsNone(child.poll())
        for pid, owns_listener in [(child.pid, False), (os.getpid(), True)]:
            with self.subTest(pid=pid, owns_listener=owns_listener):
                result = self.run_readiness(root, str(pid))
                self.assert_readiness_arguments(root)
                if owns_listener:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0,
                                        'HTTP 200 from an unrelated listener must not admit the wrong live PID')
                    self.assertIn('Bonsai did not become ready.', result.stderr)
                self.assertTrue((root / 'lsof-arguments.json').exists(), 'Readiness must invoke lsof')
                self.assertEqual(json.loads((root / 'lsof-arguments.json').read_text()), [
                    '-nP', '-a', '-p', str(pid), '-iTCP@127.0.0.1:8080', '-sTCP:LISTEN', '-t',
                ])

    def test_brain_readiness_requires_200_and_success(self):
        root = self.readiness_fixture()
        curl = root / 'curl'
        for status, code in [('200', 0), ('204', 0), ('302', 0), ('000', 56),
                             ('200', 63), ('000', 28), ('200', 22)]:
            with self.subTest(status=status, exit_code=code):
                curl.write_text(
                    '#!/usr/bin/python3\nimport json, pathlib, sys\n'
                    f'pathlib.Path({str(root / "curl-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
                    f'print({status!r}, end="")\nsys.exit({code})\n'
                )
                curl.chmod(0o755)
                result = self.run_readiness(root)
                self.assert_readiness_arguments(root)
                self.assertEqual(result.stdout, '')
                if status == '200' and code == 0:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, '')
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Bonsai did not become ready. Check kestrel-brain.service and restart Kestrel.',
                                  result.stderr)

        curl.write_text(
            '#!/usr/bin/python3\nimport json, pathlib, sys\n'
            f'pathlib.Path({str(root / "curl-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
            'print("200", end="")\n'
        )
        timeout = root / 'timeout'
        timeout.write_text(
            '#!/usr/bin/python3\nimport json, os, pathlib, sys\n'
            f'pathlib.Path({str(root / "timeout-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
            'os.execvp(sys.argv[4], sys.argv[4:])\n'
        )
        timeout.chmod(0o755)
        lsof = root / 'lsof'
        cases = [('23', '23', 0), ('23', '', 0), ('23', '23\n24', 0), ('23', '24', 0),
                 ('23', '', 1), ('23', '', 127), ('23', '', 124), ('', '23', 0), ('invalid', '23', 0)]
        for pid, output, code in cases:
            with self.subTest(pid=pid, ownership=output, exit_code=code):
                for name in ('timeout-arguments.json', 'lsof-arguments.json'):
                    (root / name).unlink(missing_ok=True)
                lsof.write_text(
                    '#!/usr/bin/python3\nimport json, pathlib, sys\n'
                    f'pathlib.Path({str(root / "lsof-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
                    f'print({output!r}, end="")\nsys.exit({code})\n'
                )
                lsof.chmod(0o755)
                result = self.run_readiness(root, pid)
                self.assert_readiness_arguments(root)
                if pid == '23':
                    self.assertEqual(json.loads((root / 'timeout-arguments.json').read_text()), [
                        '--signal=TERM', '--kill-after=1s', '2s', 'lsof', '-nP', '-a', '-p', pid,
                        '-iTCP@127.0.0.1:8080', '-sTCP:LISTEN', '-t',
                    ])
                    self.assertEqual(json.loads((root / 'lsof-arguments.json').read_text()), [
                        '-nP', '-a', '-p', pid, '-iTCP@127.0.0.1:8080', '-sTCP:LISTEN', '-t',
                    ])
                else:
                    self.assertFalse((root / 'timeout-arguments.json').exists())
                    self.assertFalse((root / 'lsof-arguments.json').exists())
                if pid == '23' and output == '23' and code == 0:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Bonsai did not become ready. Check kestrel-brain.service and restart Kestrel.',
                                  result.stderr)
                self.assertEqual(result.stdout, '')

    def test_brain_readiness_wire_and_redirect_refusal(self):
        root = self.readiness_fixture()
        requests = []
        response_status = 200

        class HealthRequest(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append(self.path)
                self.send_response(response_status)
                self.send_header('Location', '/redirect-target')
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

        server = ThreadingHTTPServer(('127.0.0.1', 0), HealthRequest)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        curl = root / 'curl'
        curl.write_text(
            '#!/usr/bin/python3\nimport json, os, pathlib, sys\n'
            f'pathlib.Path({str(root / "curl-arguments.json")!r}).write_text(json.dumps(sys.argv[1:]))\n'
            'os.execv("/usr/bin/curl", ["curl", *sys.argv[1:], "--connect-to", '
            f'"127.0.0.1:8080:127.0.0.1:{server.server_port}"])\n'
        )
        curl.chmod(0o755)
        (root / '.curlrc').write_text('location\nproxy = "http://poison.invalid:99"\n')
        ready = self.run_readiness(root)
        self.assert_readiness_arguments(root)
        self.assertEqual(ready.returncode, 0, ready.stderr)
        self.assertEqual(ready.stdout, '')
        response_status = 302
        refused = self.run_readiness(root)
        self.assert_readiness_arguments(root)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('Bonsai did not become ready.', refused.stderr)
        self.assertEqual(refused.stdout, '')
        self.assertEqual(requests, ['/health', '/health'])

    def test_user_units_pin_login_lifecycle(self):
        units = {}
        for name in ('brain', 'voice'):
            unit = configparser.ConfigParser(interpolation=None)
            with (ROOT / f'systemd/kestrel-{name}.service').open() as source:
                unit.read_file(source)
            units[name] = unit
            self.assertEqual(unit['Service']['Type'], 'exec')
            self.assertEqual(unit['Service']['Restart'], 'no')
            self.assertEqual(unit['Service']['TimeoutStopSec'], '15s')
            self.assertIn('graphical-session.target', unit['Unit']['PartOf'].split())
            self.assertEqual(unit['Service']['WorkingDirectory'], '%h/Projects/zaingulel/kestrel')
            self.assertEqual(unit['Service']['StandardOutput'],
                             f'append:%h/Projects/zaingulel/kestrel/.runtime/{name}-server.log')
            self.assertEqual(unit['Service']['StandardError'], 'inherit')
        brain, voice = units['brain'], units['voice']
        self.assertEqual(set(brain['Unit']['PartOf'].split()),
                         {'graphical-session.target', 'kestrel-voice.service'})
        self.assertEqual(brain['Service']['KillMode'], 'control-group')
        self.assertEqual(brain['Service']['TimeoutStartSec'], '130s')
        prefix = '/usr/bin/env -i HOME=%h PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/bash '
        self.assertEqual(brain['Service']['ExecStart'], prefix + '%h/Projects/zaingulel/kestrel/run-brain.sh')
        self.assertEqual(brain['Service']['ExecStartPost'],
                         '/usr/bin/env -i HOME=%h PATH=/usr/bin:/bin LANG=C.UTF-8 MAINPID=${MAINPID} '
                         '/usr/bin/bash %h/Projects/zaingulel/kestrel/check-brain-ready.sh')
        self.assertNotIn('Install', brain)
        self.assertEqual(voice['Service']['ExecStart'], '%h/Projects/zaingulel/kestrel/run-voice.sh')
        self.assertEqual(voice['Service']['KillMode'], 'mixed')
        self.assertEqual(set(voice['Service']['Environment'].split()),
                         {'KESTREL_VOICE=irish-female', 'KESTREL_MANAGED_BRAIN=1'})
        self.assertEqual(voice['Install']['WantedBy'], 'graphical-session.target')
        dependencies = {'kestrel-brain.service', 'pipewire.service', 'wireplumber.service'}
        self.assertEqual(set(voice['Unit']['Wants'].split()), dependencies)
        self.assertEqual(set(voice['Unit']['After'].split()), dependencies | {'graphical-session.target'})
        self.assertFalse(voice['Unit'].get('Requires'))
