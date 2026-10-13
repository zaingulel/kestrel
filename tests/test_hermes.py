"""Native Hermes boundary proofs; each child uses an owned, disposable runtime home."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import selectors
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

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
                             'model': 'underdog-saluki-27b-1.0',
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
    def __init__(self, home, brain):
        import hermes_worker
        self.home = home
        self.stderr = (home / 'worker-stderr.txt').open('w+')
        self.process = subprocess.Popen(
            self.command(home, brain), env=hermes_worker.child_environment(home),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''

    @staticmethod
    def command(home, brain):
        # Test-only containment observes even caught attempts, before permitting only this provider.
        bootstrap = '''
import json, pathlib, sys
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
import hermes_worker
hermes_worker.main(base_url=sys.argv[4])
'''
        return [str(NATIVE_PYTHON), '-c', bootstrap, str(ROOT), str(home),
                str(brain.server.server_port), brain.url]

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


@contextmanager
def native_worker(replies):
    if not NATIVE_PYTHON.exists():
        if os.environ.get('CI'):
            raise unittest.SkipTest('Installed Hermes interpreter absent in hosted environment')
        raise AssertionError('Local installed Hermes interpreter unavailable')
    brain = ScriptedBrain(replies)
    try:
        with tempfile.TemporaryDirectory(prefix='hermes-test-', dir=ROOT / '.runtime') as directory:
            home = Path(directory).resolve()
            worker = WorkerProcess(home, brain)
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
    def test_production_worker_entrypoint_becomes_ready_without_a_turn(self):
        if not NATIVE_PYTHON.exists():
            if os.environ.get('CI'):
                self.skipTest('Installed Hermes interpreter absent in hosted environment')
            self.fail('Local installed Hermes interpreter unavailable')
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

    def test_invalid_requests_are_refused_before_provider_work(self):
        invalid = [b'not json\n', b'[]\n', b'{}\n', b'{"messages":[]}\n',
                   b'{"messages":[{"role":"user","content":"x"}],"extra":true}\n',
                   b'{"messages":[{"role":"system","content":"x"}]}\n',
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
                with native_worker([[({'content': 'Clean nonce-27.'}, None), ({}, 'stop')]]) as (worker, brain):
                    self.assertEqual(worker.event(), {'ready': True})
                    self.assertEqual(worker.request([{'role': 'user', 'content': 'Clean caller.'}]),
                                     [{'text': 'Clean nonce-27.'}, {'done': True}])
                    self.assertEqual(len(brain.requests), 1)
                    self.assertNotIn('normal-home-private-nonce', json.dumps(brain.requests))
                    self.assertEqual(brain.requests[0][1]['Authorization'], 'Bearer lm-studio')
                    self.assertFalse(list(normal_hermes.glob('state.db*')))
                    self.assertFalse((normal_home / 'managed-poison').exists())
                    self.assertEqual(os.environ['OPENAI_API_KEY'], 'synthetic-poison-key')
                    import hermes_worker
                    environment = hermes_worker.child_environment(worker.home)
                    self.assertEqual(environment['HOME'], original_home)
                    self.assertEqual(environment['PYTHON_DOTENV_DISABLED'], '1')
                    self.assertEqual(environment['HERMES_MANAGED_DIR'], str(worker.home / 'managed'))
                    self.assertFalse(set(poison) - {'HERMES_HOME', 'HERMES_MANAGED_DIR', 'PYTHON_DOTENV_DISABLED'} & set(environment))

    def test_provider_failure_is_explicit_and_owned_diagnostics_are_removed_after_exit(self):
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
            home = worker.home
            process = worker.process
            self.assertEqual(len(brain.requests), 1)
        self.assertIsNotNone(process.poll())
        self.assertFalse(home.exists())
        self.assertTrue((ROOT / '.runtime/voice-venv/bin/python').exists())
