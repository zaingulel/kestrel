import asyncio
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch

from desktop import conversation


ROOT = Path(__file__).resolve().parents[1]


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_wire_and_corrupt_input(self):
        valid = {'version': 1, 'session': 'fixture', 'turns': [
            {'speaker': 'you', 'text': '<b>Private canary</b>', 'state': 'complete'},
        ]}
        self.assertEqual(conversation.validate_record(json.dumps(valid).encode() + b'\n'), valid)
        corrupt = [b'null\n', b'[]\n', b'{"private canary":}\n', b'\xff\n', b'{}',
                   b'x' * (1024 * 1024 + 1) + b'\n', b'[' * 100000 + b']' * 100000 + b'\n',
                   b'{"alive":"old-session"}\n', b'{"unavailable":"private canary"}\n']
        for replacement in ({'version': True}, {'session': ''}, {'turns': {}}, {'extra': 'private canary'},
                            {'turns': [{'speaker': 'brain', 'text': 'canary', 'state': 'complete'}]},
                            {'turns': [{'speaker': 'you', 'text': 1, 'state': 'complete'}]},
                            {'turns': [{'speaker': 'you', 'text': 'canary', 'state': 'invented'}]}):
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
            feed.user('<b>Private canary</b>')
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
            hostile_payload = b'{"version":1,"session":"evil","turns":[],"canary":"private canary"}\n'

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

            hostile_payload = (b'{"version":1,"session":"hostile","turns":[{"speaker":"you",'
                               b'"text":"Private credential canary","state":"complete"}]}\n')
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
                    late.user('Private accepted connection canary')
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
            feed.user('Synthetic private turn')
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
            restarted.user('x' * (1024 * 1024))
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
                        slow.user('Synthetic turn ' + str(number))
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
                    slow.user('Voice continues while the panel is blocked')
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
            old.user('Private prior session canary')
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
