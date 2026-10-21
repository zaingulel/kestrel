import asyncio
import io
import json
import os
from pathlib import Path
import struct
import sys
import hashlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from desktop import conversation, control


ROOT = Path(__file__).resolve().parents[1]


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_submit_cli_uses_stdin_and_fixed_results(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            payload = b'{"version":1,"text":"private-cli-canary\\nsecond line"}\n'
            peers, children = [], []
            received, release = asyncio.Event(), asyncio.Event()
            requests = []
            response = b'accepted\n'

            async def serve(reader, writer):
                try:
                    requests.append(await asyncio.wait_for(reader.readexactly(len(payload)), 2))
                    self.assertEqual(await asyncio.wait_for(reader.read(1), 2), b'')
                    received.set()
                    await asyncio.wait_for(release.wait(), 2)
                    writer.write(response)
                    await writer.drain()
                finally:
                    await control.close_writer(writer)

            def connected(reader, writer):
                peers.append(asyncio.create_task(serve(reader, writer)))

            async def cleanup():
                release.set()
                for process in children:
                    if process.returncode is None:
                        process.kill()
                    await process.wait()
                await asyncio.gather(*peers)

            self.addAsyncCleanup(cleanup)
            server = await asyncio.start_unix_server(connected, path=control.address())
            try:
                for response, expected in ((b'accepted\n', (0, b'{"status":"accepted"}\n')),
                                           (b'busy\n', (1, b'{"status":"busy"}\n'))):
                    received.clear()
                    release.clear()
                    process = await asyncio.create_subprocess_exec(
                        sys.executable, str(ROOT / 'desktop/control.py'), '--submit',
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    children.append(process)
                    process.stdin.write(payload)
                    await process.stdin.drain()
                    process.stdin.close()
                    await process.stdin.wait_closed()
                    # An unsupported CLI must fail on its actual status, not a fixture timeout.
                    stdout = asyncio.create_task(process.stdout.read())
                    stderr = asyncio.create_task(process.stderr.read())
                    exited = asyncio.create_task(process.wait())
                    arrived = asyncio.create_task(received.wait())
                    try:
                        await asyncio.wait_for(asyncio.wait((exited, arrived),
                                                          return_when=asyncio.FIRST_COMPLETED), 3)
                        if received.is_set():
                            self.assertNotIn(b'private-cli-canary', Path(f'/proc/{process.pid}/cmdline').read_bytes())
                            self.assertNotIn(b'private-cli-canary', Path(f'/proc/{process.pid}/environ').read_bytes())
                        release.set()
                        await asyncio.wait_for(exited, 3)
                        output, errors = await asyncio.gather(stdout, stderr)
                        self.assertEqual((process.returncode, output), expected)
                        self.assertEqual(errors, b'')
                    finally:
                        for task in (stdout, stderr, exited, arrived):
                            task.cancel()
                        await asyncio.gather(stdout, stderr, exited, arrived, return_exceptions=True)
                self.assertEqual(requests, [payload, payload])
            finally:
                server.close()
                await server.wait_closed()
                await cleanup()

            ambient_stderr = sys.stderr
            diagnostic_streams = []

            def emit_diagnostic():
                diagnostic_streams.append(sys.stderr)
                print('submit-stream-isolation: ambient diagnostic', file=sys.stderr)

            for malformed in (b'[]\n', b'1\n', b'{"version":true,"text":"private-cli-canary"}\n',
                              b'{"version":1,"text":""}\n', b'{"version":1,"text":"x"}\nextra'):
                read_fd, write_fd = os.pipe()
                with os.fdopen(read_fd, 'rb') as incoming, os.fdopen(write_fd, 'wb') as outgoing:
                    outgoing.write(malformed)
                    outgoing.close()
                    stdin = Mock(buffer=incoming)
                    output, errors = io.StringIO(), io.StringIO()
                    with (patch.object(control, 'sys', SimpleNamespace(stdin=stdin, stderr=errors)),
                          patch.object(sys, 'stdout', output),
                          patch.object(control.asyncio, 'open_unix_connection', AsyncMock()) as connect,
                          patch.object(control, 'notify_failure', AsyncMock()) as notify):
                        handle = (asyncio.get_running_loop().call_soon(emit_diagnostic)
                                  if malformed == b'[]\n' else None)
                        try:
                            self.assertEqual(await control.main(['--submit']), 1)
                        finally:
                            if handle is not None:
                                handle.cancel()
                    self.assertEqual(output.getvalue(), '{"status":"invalid"}\n')
                    self.assertEqual(errors.getvalue(), '')
                    connect.assert_not_awaited()
                    notify.assert_not_awaited()
            self.assertEqual(diagnostic_streams, [ambient_stderr])

    async def test_submit_wire_bounds_and_peer_refusal(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            toggles, calls = [], []
            server = control.ConversationControl(lambda: toggles.append(True) or 'inactive')
            self.addAsyncCleanup(server.close)
            await server.start()

            async def wire(payload, *, eof=True):
                reader, writer = await asyncio.open_unix_connection(control.address())
                try:
                    writer.write(payload)
                    await writer.drain()
                    if eof:
                        writer.write_eof()
                    return await asyncio.wait_for(reader.read(33), 2)
                finally:
                    await control.close_writer(writer)

            self.assertEqual(await wire(b'{"version":true,"text":"x"}\n'), b'invalid\n')
            self.assertEqual(await wire(b'{"version":1,"text":"x"}\n'), b'unavailable\n')
            await server.close()
            self.assertFalse(server.tasks)

            outcome = 'accepted'

            def receive(text):
                calls.append(text)
                return outcome

            server = control.ConversationControl(lambda: toggles.append(True) or 'inactive', submit=receive)
            self.addAsyncCleanup(server.close)
            await server.start()

            def envelope(text):
                return (json.dumps({'version': 1, 'text': text}, ensure_ascii=True,
                                   separators=(',', ':')) + '\n').encode('utf-8')

            for text in (' line\tA\r\nB ', 'a' * 4096, '😀' * 2048, '😀' * 2047 + 'aa'):
                self.assertEqual(await wire(envelope(text)), b'accepted\n')
            self.assertEqual(calls, [' line\tA\r\nB ', 'a' * 4096, '😀' * 2048, '😀' * 2047 + 'aa'])
            ordinary = b'{"version":1,"text":"x"}\n'
            at_limit = b' ' * (32768 - len(ordinary)) + ordinary
            self.assertEqual(await wire(at_limit), b'accepted\n')
            for prefix in (b' ', b'\t', b'\r', b'\n'):
                self.assertEqual(await wire(prefix + ordinary), b'accepted\n')
            admitted = list(calls)
            hostile = [
                envelope('a' * 4097), envelope('😀' * 2048 + 'a'), envelope('\ud800'),
                envelope('\udfff'), envelope(' \t\r\n'), envelope('x\x00'), envelope('x\x1f'),
                envelope('x\x7f'), envelope('x\x80'), envelope('x\x9f'),
                b'{"version":1,"text":"x","text":"y"}\n',
                b'{"version":1,"version":1,"text":"x"}\n',
                b'{"version":1,"text":"x","command":"mute"}\n',
                b'{"version":true,"text":"x"}\n', b'{"version":1.0,"text":"x"}\n',
                b'{"version":"1","text":"x"}\n', b'{"version":2,"text":"x"}\n',
                b'{"version":1,"text":null}\n', b'{"version":1,"text":[]}\n',
                b'{"version":1,"text":3}\n', b'{"text":"x"}\n',
                b'{"version":1,"text":"\xff"}\n', ordinary + ordinary, ordinary + b'extra',
                ordinary[:-1], ordinary[:-1] + b' \n', b' ' + at_limit,
                b'{' + b' ' * 32768, b'\v' + ordinary, b'\f' + ordinary,
                b'{"version":1,"text":' + b'[' * 1200 + b'0' + b']' * 1200 + b'}\n',
            ]
            for index, payload in enumerate(hostile):
                with self.subTest(hostile=index):
                    self.assertEqual(await wire(payload), b'invalid\n')
            self.assertEqual(await wire(ordinary, eof=False), b'invalid\n')
            for index, payload in enumerate((b'', b'toggle', b'TOGGLE\n', b'toggle\nextra',
                                             b'toggle\n' * 2, b'x' * 100, b'[]\n', b'1\n',
                                             b' \t\n\r\v\f', b'\xff', b' ' * 32769)):
                with self.subTest(legacy=index):
                    self.assertEqual(await wire(payload), b'unavailable\n')
            self.assertEqual(calls, admitted)
            self.assertEqual(toggles, [])
            self.assertEqual(await wire(b'toggle\n'), b'inactive\n')
            self.assertEqual(toggles, [True])
            with patch.object(control, 'same_uid', return_value=False):
                self.assertEqual(await wire(ordinary), b'unavailable\n')
                self.assertEqual(await control.submit('x'), 'unavailable')
            self.assertEqual(calls, admitted)
            for outcome in ('busy', 'unavailable'):
                self.assertEqual(await control.submit('x'), outcome)
            with patch.object(control.asyncio, 'open_unix_connection', AsyncMock()) as connect:
                for invalid in ('', 'a' * 4097, '\ud800', 'x\x00'):
                    self.assertEqual(await control.submit(invalid), 'invalid')
                connect.assert_not_awaited()
            await server.close()
            self.assertFalse(server.tasks)
            self.assertEqual(await control.submit('x'), 'unavailable')

    async def test_submit_receipt_loss_never_replays(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            calls, connections = [], []

            def accept_without_receipt(text):
                calls.append(text)
                connections[-1].transport.abort()
                return 'accepted'

            server = control.ConversationControl(lambda: 'inactive', submit=accept_without_receipt)
            self.addAsyncCleanup(server.close)
            native_serve = server.serve

            async def lose_receipt(reader, writer):
                connections.append(writer)
                await native_serve(reader, writer)

            with patch.object(server, 'serve', side_effect=lose_receipt):
                await server.start()
                self.assertEqual(await control.submit('accepted-once-canary'), 'uncertain')
                await server.close()
            self.assertEqual(calls, ['accepted-once-canary'])
            self.assertEqual(len(connections), 1)
            self.assertFalse(server.tasks)

            attempts, peers = [], []
            release, empty_request = asyncio.Event(), asyncio.Event()
            response, eof = b'', True

            async def answer(reader, writer):
                try:
                    attempts.append(await asyncio.wait_for(reader.read(32769), 2))
                    if not attempts[-1]:
                        empty_request.set()
                        return
                    writer.write(response)
                    await writer.drain()
                    if not eof:
                        await asyncio.wait_for(release.wait(), 2)
                finally:
                    await control.close_writer(writer)

            def connected(reader, writer):
                peers.append(asyncio.create_task(answer(reader, writer)))

            async def cleanup():
                release.set()
                await asyncio.gather(*peers)

            self.addAsyncCleanup(cleanup)
            socket = await asyncio.start_unix_server(connected, path=control.address())
            try:
                for response in (b'', b'accepted', b'accepted\nextra', b'accepted\n' * 2,
                                 b'x' * 33, b'unknown\n', b'\xff\n'):
                    before = len(attempts)
                    self.assertEqual(await control.submit('one-write-canary'), 'uncertain')
                    self.assertEqual(len(attempts), before + 1)
                    self.assertEqual(attempts[-1], b'{"version":1,"text":"one-write-canary"}\n')
                response, eof = b'accepted\n', False
                before = len(attempts)
                self.assertEqual(await control.submit('one-write-canary'), 'uncertain')
                self.assertEqual(len(attempts), before + 1)
                release.set()
                response, eof = b'accepted\n', True
                before = len(attempts)
                with patch.object(control, 'same_uid', return_value=False):
                    self.assertEqual(await control.submit('must-not-write'), 'unavailable')
                await asyncio.wait_for(empty_request.wait(), 1)
                self.assertEqual(attempts[-1], b'')
                self.assertEqual(len(attempts), before + 1)
            finally:
                socket.close()
                await socket.wait_closed()
                await cleanup()

    async def test_toggle_wire_refusal_and_cleanup(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            calls = []
            server = control.ConversationControl(lambda: calls.append('toggle') or 'starting')
            self.addAsyncCleanup(server.close)
            await server.start()
            self.assertEqual(control.address(), '\0kestrel.control.' + str(os.getuid()) + '.' +
                             hashlib.sha256(runtime.encode()).hexdigest())
            with self.assertRaises(OSError):
                duplicate = control.ConversationControl(lambda: 'inactive')
                await duplicate.start()

            async def wire(payload, *, eof=True):
                reader, writer = await asyncio.open_unix_connection(control.address())
                try:
                    writer.write(payload)
                    await writer.drain()
                    if eof:
                        writer.write_eof()
                    return await asyncio.wait_for(reader.read(32), 2)
                finally:
                    await control.close_writer(writer)

            self.assertEqual(await wire(b'toggle\n'), b'starting\n')
            self.assertEqual(calls, ['toggle'])
            for payload in (b'', b'toggle', b'TOGGLE\n', b'toggle\nextra', b'toggle\n' * 2, b'x' * 100):
                with self.subTest(request=payload[:20]):
                    self.assertEqual(await wire(payload), b'unavailable\n')
            self.assertEqual(await wire(b'toggle\n', eof=False), b'unavailable\n')
            self.assertEqual(calls, ['toggle'])
            with patch.object(control, 'same_uid', return_value=False):
                self.assertEqual(await wire(b'toggle\n'), b'unavailable\n')
                with self.assertRaises(ValueError):
                    await control.toggle()
            self.assertEqual(calls, ['toggle'])

            accepted = asyncio.Queue()
            native_serve = server.serve

            async def serve(reader, writer):
                accepted.put_nowait(None)
                await native_serve(reader, writer)

            clients = []
            with patch.object(server, 'serve', side_effect=serve):
                try:
                    for _ in range(8):
                        clients.append(await asyncio.open_unix_connection(control.address()))
                        await asyncio.wait_for(accepted.get(), 1)
                    self.assertEqual(len(server.tasks), 8)
                    extra_reader, extra_writer = await asyncio.open_unix_connection(control.address())
                    clients.append((extra_reader, extra_writer))
                    self.assertEqual(await asyncio.wait_for(extra_reader.read(1), 1), b'')
                    await server.close()
                    self.assertFalse(server.tasks)
                finally:
                    for _, writer in clients:
                        await control.close_writer(writer)
            await server.start()

            children = []

            async def close_children():
                for process in children:
                    if process.returncode is None:
                        process.kill()
                    await process.wait()

            self.addAsyncCleanup(close_children)

            async def cli(*arguments):
                process = await asyncio.create_subprocess_exec(
                    sys.executable, str(ROOT / 'desktop/control.py'), *arguments,
                    env={**os.environ, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/nonexistent-kestrel-test-bus',
                         'DISPLAY': '', 'WAYLAND_DISPLAY': ''},
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                children.append(process)
                output, errors = await asyncio.wait_for(process.communicate(), 5)
                return process.returncode, output, errors

            self.assertEqual(await cli('--toggle'), (0, b'starting\n', b''))
            before = len(calls)
            code, output, errors = await cli('--toggle', 'private canary')
            self.assertEqual(code, 2)
            self.assertEqual(output, b'')
            self.assertEqual(errors, b'Usage: control.py --toggle\n')
            self.assertEqual(len(calls), before)
            await server.close()
            attempts, peers = [], []

            async def refuse(reader, writer):
                attempts.append(await reader.read(8))
                writer.write(b'unavailable\n')
                await writer.drain()
                await control.close_writer(writer)

            def connected(reader, writer):
                peers.append(asyncio.create_task(refuse(reader, writer)))

            refusing = await asyncio.start_unix_server(connected, path=control.address())
            try:
                self.assertEqual(await cli('--toggle'), (1, b'', (control.UNAVAILABLE + '\n').encode()))
                self.assertEqual(attempts, [b'toggle\n'], 'An ambiguous or refused toggle is never retried')
            finally:
                refusing.close()
                await refusing.wait_closed()
                await asyncio.gather(*peers)

            writer = Mock()
            writer.drain = AsyncMock()
            writer.wait_closed = AsyncMock()
            reader = Mock()
            reader.read = AsyncMock(side_effect=[b'inactive\n', b'extra', b''])
            with (patch.object(control.asyncio, 'open_unix_connection', AsyncMock(return_value=(reader, writer))),
                  patch.object(control, 'same_uid', return_value=True)):
                with self.assertRaises(ValueError):
                    await control.toggle()
            writer.close.assert_called_once()
            notify = AsyncMock()
            with patch.object(control, 'notify_failure', notify), patch.object(control.sys, 'stderr', io.StringIO()):
                self.assertEqual(await control.main(['--toggle']), 1)
            notify.assert_awaited_once()



class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_source_is_explicit_and_wire_validation_is_closed(self):
        old = {'version': 1, 'session': 'source-fixture', 'turns': [
            {'speaker': 'you', 'text': 'Old unlabelled input', 'state': 'complete'},
        ]}
        with self.assertRaises(ValueError):
            conversation.validate_record(conversation.encode(old))
        turns = [
            {'speaker': 'you', 'text': '<b>Spoken & literal</b>', 'state': 'complete', 'source': 'spoken'},
            {'speaker': 'you', 'text': '<b>Typed & literal</b>\nNext line', 'state': 'complete', 'source': 'typed'},
            {'speaker': 'kestrel', 'text': 'Heard reply.', 'state': 'complete'},
        ]
        valid = {'version': 2, 'session': 'source-fixture', 'turns': turns}
        self.assertEqual(conversation.validate_record(conversation.encode(valid)), valid)
        invalid = [valid | {'version': 1}, valid | {'extra': True}]
        missing = turns[0].copy()
        del missing['source']
        invalid.append(valid | {'turns': [missing]})
        for source in ('unknown', 'kestrel', '', None, True):
            invalid.append(valid | {'turns': [turns[0] | {'source': source}]})
        invalid.extend([
            valid | {'turns': [turns[0] | {'extra': 'spoken'}]},
            valid | {'turns': [turns[2] | {'source': 'spoken'}]},
            valid | {'turns': [turns[2] | {'source': 'typed'}]},
        ])
        for record in invalid:
            with self.subTest(record=record), self.assertRaises(ValueError):
                conversation.validate_record(conversation.encode(record))
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            feed = conversation.ConversationFeed()
            self.addAsyncCleanup(feed.close)
            await feed.start()
            self.assertIsNotNone(feed.server)
            with self.assertRaises(TypeError):
                feed.user('Source is required')
            with self.assertRaises(TypeError):
                feed.user('Source is keyword-only', 'spoken')
            with self.assertRaises(ValueError):
                feed.user('Unknown source is refused', source='unknown')
            self.assertEqual(feed.turns, [])
            feed.user('<b>Spoken & literal</b>', source='spoken')
            feed.user('<b>Typed & literal</b>\nNext line', source='typed')
            token = object()
            feed.begin_reply(token)
            feed.spoken(token, 'Heard reply.')
            feed.finish(token)
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            try:
                line = await asyncio.wait_for(reader.readline(), 1)
                self.assertEqual(conversation.validate_record(line),
                                 {'version': 2, 'session': feed.session, 'turns': turns})
            finally:
                await conversation.close_writer(writer)

    async def test_private_wire_and_corrupt_input(self):
        valid = {'version': 2, 'session': 'fixture', 'turns': [
            {'speaker': 'you', 'text': '<b>Private canary</b>', 'state': 'complete', 'source': 'spoken'},
        ]}
        self.assertEqual(conversation.validate_record(json.dumps(valid).encode() + b'\n'), valid)
        corrupt = [b'null\n', b'[]\n', b'{"private canary":}\n', b'\xff\n', b'{}',
                   b'x' * (1024 * 1024 + 1) + b'\n', b'[' * 100000 + b']' * 100000 + b'\n',
                   b'{"alive":"old-session"}\n', b'{"unavailable":"private canary"}\n']
        for replacement in ({'version': True}, {'session': ''}, {'turns': {}}, {'extra': 'private canary'},
                            {'turns': [{'speaker': 'brain', 'text': 'canary', 'state': 'complete'}]},
                            {'turns': [{'speaker': 'you', 'text': 1, 'state': 'complete', 'source': 'spoken'}]},
                            {'turns': [{'speaker': 'you', 'text': 'canary', 'state': 'invented', 'source': 'spoken'}]}):
            corrupt.append(json.dumps(valid | replacement).encode() + b'\n')
        for line in corrupt:
            with self.subTest(record=line[:40]), self.assertRaises((ValueError, UnicodeError)):
                conversation.validate_record(line)
        with self.assertRaises(ValueError):
            conversation.validate_record(json.dumps(valid).encode() + b'\n', 'old-session')
        for runtime in ('', 'relative', '/bad\npath', '/bad\x7fpath', '/' + 'a' * 4096):
            with self.subTest(runtime=runtime[:32]), patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
                with self.assertRaises(ValueError):
                    conversation.address()
        peer = Mock()
        peer.getsockopt.return_value = struct.pack('3i', 123, os.getuid(), 456)
        self.assertTrue(conversation.same_uid(peer))
        peer.getsockopt.return_value = struct.pack('3i', 123, os.getuid() + 1, 456)
        self.assertFalse(conversation.same_uid(peer))
        peer.getsockopt.side_effect = OSError('private canary')
        self.assertFalse(conversation.same_uid(peer))

        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            feed = conversation.ConversationFeed()
            self.addAsyncCleanup(feed.close)
            await feed.start()
            self.assertIsNotNone(feed.server)
            feed.user('<b>Private canary</b>', source='spoken')
            process = await asyncio.create_subprocess_exec(
                '/usr/bin/python', str(ROOT / 'desktop/conversation.py'), '--watch',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                row = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
                self.assertEqual(row['turns'], valid['turns'])
                self.assertEqual(set(row), {'version', 'session', 'turns'})
            finally:
                process.terminate()
                _, errors = await asyncio.wait_for(process.communicate(), 5)
                self.assertEqual(errors, b'')
            await feed.close()
            await feed.start()
            pipe_read, pipe_write = os.pipe()
            os.close(pipe_read)
            try:
                process = await asyncio.create_subprocess_exec(
                    '/usr/bin/python', str(ROOT / 'desktop/conversation.py'), '--watch',
                    stdout=pipe_write, stderr=asyncio.subprocess.PIPE,
                )
            finally:
                os.close(pipe_write)
            try:
                _, errors = await asyncio.wait_for(process.communicate(), 5)
                self.assertEqual(errors, b'', 'A closed panel pipe must not produce diagnostic noise')
                self.assertEqual(process.returncode, 0)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            await feed.close()

            accepted = asyncio.Event()
            writers = []
            hostile_payload = b'{"version":2,"session":"evil","turns":[],"canary":"private canary"}\n'

            def hostile(reader, writer):
                writers.append(writer)
                writer.write(hostile_payload)
                accepted.set()

            server = await asyncio.start_unix_server(hostile, path=conversation.address())
            async def close_hostile():
                server.close()
                for writer in writers:
                    await conversation.close_writer(writer)
                await server.wait_closed()

            self.addAsyncCleanup(close_hostile)
            process = await asyncio.create_subprocess_exec(
                '/usr/bin/python', str(ROOT / 'desktop/conversation.py'), '--watch',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                self.assertEqual(json.loads(await asyncio.wait_for(process.stdout.readline(), 5)),
                                 {'unavailable': 'Conversation unavailable. Reopen the panel.'})
                await asyncio.wait_for(accepted.wait(), 5)
            finally:
                process.terminate()
                _, errors = await asyncio.wait_for(process.communicate(), 5)
                self.assertEqual(errors, b'')
                for writer in writers:
                    writer.close()
                    await writer.wait_closed()

            hostile_payload = (b'{"version":2,"session":"hostile","turns":[{"speaker":"you",'
                               b'"text":"Private credential canary","state":"complete","source":"spoken"}]}\n')
            output = io.StringIO()
            emitted = asyncio.Event()
            native_write = output.write

            def observe_write(text):
                result = native_write(text)
                emitted.set()
                return result

            with (patch.object(conversation, 'same_uid', return_value=False),
                  patch.object(output, 'write', side_effect=observe_write),
                  patch.object(conversation.sys, 'stdout', output)):
                watcher = asyncio.create_task(conversation.watch())
                try:
                    await asyncio.wait_for(emitted.wait(), 5)
                    self.assertEqual(output.getvalue(), '{"unavailable":"Conversation unavailable. Reopen the panel."}\n')
                finally:
                    watcher.cancel()
                    await asyncio.gather(watcher, return_exceptions=True)
            for writer in writers:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def test_restart_backpressure_and_cleanup(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            async def shutdown_accepted_connection(delayed_callback):
                late = conversation.ConversationFeed()
                accepted = asyncio.get_running_loop().create_future()
                listener_closed = asyncio.Event()
                server = closing = client_writer = None
                native_connected = late.connected

                def capture_connection(reader, writer):
                    accepted.set_result((reader, writer))

                async def cleanup_accepted():
                    if accepted.done() and not accepted.cancelled():
                        accepted.result()[1].transport.abort()
                    if closing is not None:
                        closing.cancel()
                        await asyncio.wait_for(asyncio.gather(closing, return_exceptions=True), 1)
                    if client_writer is not None:
                        await conversation.close_writer(client_writer)
                    await asyncio.wait_for(late.close(), 1)
                    if server is not None:
                        await asyncio.wait_for(server.wait_closed(), 1)

                self.addAsyncCleanup(cleanup_accepted)
                with patch.object(late, 'connected', side_effect=capture_connection):
                    await late.start()
                    server = late.server
                    client_reader, client_writer = await asyncio.open_unix_connection(conversation.address())
                    peer_reader, peer_writer = await asyncio.wait_for(accepted, 1)
                    late.user('Private accepted connection canary', source='spoken')
                    close_listener = server.close

                    def observe_listener_close():
                        close_listener()
                        listener_closed.set()

                    try:
                        with patch.object(server, 'close', side_effect=observe_listener_close):
                            if delayed_callback:
                                closing = asyncio.create_task(late.close())
                                await asyncio.wait_for(listener_closed.wait(), 1)
                                native_connected(peer_reader, peer_writer)
                                await asyncio.wait_for(asyncio.shield(closing), 1)
                            else:
                                native_connected(peer_reader, peer_writer)
                                async with asyncio.timeout(1):
                                    await late.close()
                        self.assertEqual(await asyncio.wait_for(client_reader.read(), 1), b'')
                        await asyncio.wait_for(server.wait_closed(), 1)
                        self.assertFalse(late.tasks)
                        self.assertEqual(late.turns, [])
                    finally:
                        await cleanup_accepted()

            for delayed_callback in (True, False):
                with self.subTest(delayed_callback=delayed_callback):
                    await shutdown_accepted_connection(delayed_callback)

            feed = conversation.ConversationFeed()
            self.addAsyncCleanup(feed.close)
            await feed.start()
            first_session = feed.session
            token, next_token = object(), object()
            feed.user('Synthetic private turn', source='spoken')
            feed.begin_reply(token)
            feed.spoken(token, 'One fact.')
            feed.finish(token, interrupted=True)
            feed.spoken(token, 'Unheard tail')
            feed.finish(token)
            feed.begin_reply(next_token)
            feed.finish(token, failed=True)
            self.assertEqual(feed.turns[-2:], [
                {'speaker': 'kestrel', 'text': 'One fact.', 'state': 'interrupted'},
                {'speaker': 'kestrel', 'text': '', 'state': 'thinking'},
            ])
            feed.begin_reply(object())
            self.assertEqual(feed.turns[-2]['state'], 'interrupted')
            feed.finish(feed.active)
            self.assertEqual(feed.turns[-1], {'speaker': 'kestrel', 'text': '', 'state': 'failed'})
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            try:
                snapshot = json.loads(await asyncio.wait_for(reader.readline(), 1))
                self.assertEqual(snapshot['turns'], feed.turns)
                other_reader, other_writer = await asyncio.open_unix_connection(conversation.address())
                self.assertEqual(await asyncio.wait_for(other_reader.read(), 1), b'')
                other_writer.close()
                await other_writer.wait_closed()
                writer.write(b'hostile inbound')
                await writer.drain()
                self.assertEqual(await asyncio.wait_for(reader.read(), 1), b'')
            finally:
                writer.close()
                await writer.wait_closed()
            await feed.close()
            self.assertFalse(feed.tasks)
            with patch.object(conversation, 'same_uid', return_value=False):
                await feed.start()
                reader, writer = await asyncio.open_unix_connection(conversation.address())
                try:
                    self.assertEqual(await asyncio.wait_for(reader.read(), 1), b'')
                finally:
                    writer.close()
                    await writer.wait_closed()
            await feed.close()
            restarted = conversation.ConversationFeed()
            self.addAsyncCleanup(restarted.close)
            await restarted.start()
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            snapshot = json.loads(await asyncio.wait_for(reader.readline(), 1))
            self.assertNotEqual(snapshot['session'], first_session)
            self.assertEqual(snapshot['turns'], [])
            writer.close()
            await writer.wait_closed()
            restarted.user('x' * (1024 * 1024), source='spoken')
            self.assertEqual(json.loads(restarted.payload), {'unavailable':
                'Conversation is too large to display. Restart Kestrel to begin a new conversation.'})
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            size_notice = {'unavailable':
                'Conversation is too large to display. Restart Kestrel to begin a new conversation.'}
            self.assertEqual(json.loads(await asyncio.wait_for(reader.readline(), 1)), size_notice)
            self.assertEqual(json.loads(await asyncio.wait_for(reader.readline(), 5)), size_notice,
                             'An oversized conversation remains visibly unavailable across heartbeats')
            writer.close()
            await writer.wait_closed()
            await restarted.close()
            self.assertFalse(restarted.tasks)
            slow = conversation.ConversationFeed()
            self.addAsyncCleanup(slow.close)
            entered, release = asyncio.Event(), asyncio.Event()
            native_connected = slow.connected

            def blocked_peer(reader, writer):
                native_drain = writer.drain

                async def drain():
                    entered.set()
                    await release.wait()
                    await native_drain()

                writer.drain = drain
                native_connected(reader, writer)

            with patch.object(slow, 'connected', side_effect=blocked_peer):
                await slow.start()
                reader, writer = await asyncio.open_unix_connection(conversation.address())
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    for number in range(30):
                        slow.user('Synthetic turn ' + str(number), source='spoken')
                    release.set()
                    self.assertEqual(json.loads(await asyncio.wait_for(reader.readline(), 1))['turns'], [])
                    latest = json.loads(await asyncio.wait_for(reader.readline(), 1))
                    self.assertEqual(len(latest['turns']), 30, 'Only the newest pending snapshot is sent')
                    self.assertEqual(latest['turns'][-1]['text'], 'Synthetic turn 29')
                finally:
                    writer.close()
                    await writer.wait_closed()
                    await slow.close()
                self.assertFalse(slow.tasks)
                entered.clear()
                release.clear()
                await slow.start()
                reader, writer = await asyncio.open_unix_connection(conversation.address())
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    owner = slow.reader_task
                    slow.user('Voice continues while the panel is blocked', source='spoken')
                    await asyncio.wait_for(asyncio.shield(owner), 5)
                    self.assertTrue(owner.done(), 'A blocked drain is bounded and its work is joined')
                finally:
                    writer.close()
                    await writer.wait_closed()
                    await slow.close()
                self.assertFalse(slow.tasks)

            old = conversation.ConversationFeed()
            self.addAsyncCleanup(old.close)
            await old.start()
            old.user('Private prior session canary', source='spoken')
            process = await asyncio.create_subprocess_exec(
                '/usr/bin/python', str(ROOT / 'desktop/conversation.py'), '--watch',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                previous = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
                self.assertEqual(previous['turns'][0]['text'], 'Private prior session canary')
                alive = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
                self.assertEqual(alive, {'alive': previous['session']})
                await old.close()
                unavailable = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
                self.assertEqual(unavailable, {'unavailable': 'Conversation unavailable. Reopen the panel.'})
                fresh = conversation.ConversationFeed()
                self.addAsyncCleanup(fresh.close)
                await fresh.start()
                snapshot = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
                self.assertEqual(snapshot['turns'], [])
                self.assertNotEqual(snapshot['session'], previous['session'])
                await fresh.close()
            finally:
                process.terminate()
                _, errors = await asyncio.wait_for(process.communicate(), 5)
                self.assertEqual(errors, b'')
            self.assertEqual(list(Path(runtime).iterdir()), [], 'The feed never writes transcript files')
