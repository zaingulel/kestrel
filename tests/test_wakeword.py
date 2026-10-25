import asyncio
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from numpy import float32

import wakeword


class WakeWordTests(unittest.IsolatedAsyncioTestCase):
    def runtime(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        runtime = Path(home.name)
        package = runtime / wakeword.PACKAGE
        package.mkdir(parents=True)
        (package / '__init__.py').write_bytes(b'fixture')
        (runtime / 'hey_kestrel.tflite').write_bytes(b'good')
        identities = {
            str(wakeword.PACKAGE / '__init__.py'): (7, 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d'),
            'hey_kestrel.tflite': (4, '770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c'),
        }
        constructed = []
        sdk = Mock(__file__=str(package / '__init__.py'))
        sdk.OpenWakeWord.from_model.side_effect = lambda path, **kw: constructed.append(Path(path).read_bytes()) or Mock()
        return runtime, identities, sdk, constructed

    def test_loader_refuses_wrong_identity_before_native_construction(self):
        runtime, identities, sdk, constructed = self.runtime()
        with patch.object(wakeword, 'ASSET_IDENTITIES', identities), patch.dict(sys.modules, pyopen_wakeword=sdk):
            model, features = wakeword.load_detector(runtime)
            model.close()
            features.close()
            self.assertEqual(constructed, [b'good'])
            (runtime / 'hey_kestrel.tflite').write_bytes(b'evil')
            with self.assertRaisesRegex(RuntimeError, 'Wake phrase unavailable'):
                wakeword.load_detector(runtime)
            self.assertEqual(constructed, [b'good'], 'Wrong same-length identity must never reach native construction')

    def test_loader_rejects_unsafe_assets(self):
        runtime, identities, sdk, constructed = self.runtime()
        model = runtime / 'hey_kestrel.tflite'
        package = runtime / wakeword.PACKAGE
        with patch.object(wakeword, 'ASSET_IDENTITIES', identities), patch.dict(sys.modules, pyopen_wakeword=sdk):
            for kind in ('missing', 'oversize', 'fifo', 'symlink', 'hardlink', 'writable_file', 'writable_directory', 'cache', 'directory_symlink'):
                with self.subTest(kind=kind):
                    model.unlink()
                    model.write_bytes(b'good')
                    if kind == 'missing':
                        model.unlink()
                    elif kind == 'oversize':
                        model.write_bytes(b'good!')
                    elif kind == 'fifo':
                        model.unlink()
                        os.mkfifo(model)
                    elif kind == 'symlink':
                        other = runtime / 'outside'
                        other.write_bytes(b'good')
                        model.unlink()
                        model.symlink_to(other)
                    elif kind == 'hardlink':
                        os.link(model, runtime / 'hardlink')
                    elif kind == 'writable_file':
                        model.chmod(0o666)
                    elif kind == 'writable_directory':
                        package.chmod(0o777)
                    elif kind == 'cache':
                        (package / '__pycache__').mkdir()
                    else:
                        package.rename(package.with_name('real-package'))
                        package.symlink_to(package.with_name('real-package'), target_is_directory=True)
                    with self.assertRaisesRegex(RuntimeError, 'Wake phrase unavailable'):
                        wakeword.load_detector(runtime)
                    self.assertEqual(constructed, [])
                    if kind == 'directory_symlink':
                        package.unlink()
                        package.with_name('real-package').rename(package)
                    if kind == 'cache':
                        (package / '__pycache__').rmdir()
                    if kind == 'writable_directory':
                        package.chmod(0o755)
                    if kind == 'hardlink':
                        (runtime / 'hardlink').unlink()
                    if not model.exists():
                        model.write_bytes(b'good')

    def test_scores_require_finite_probabilities(self):
        model, features = Mock(), Mock()
        features.process_streaming.return_value = [object()]
        for scores, expected in (([], []), ([0, 0.5, 1.0], [0, 0.5, 1.0]), ([float32(0.75)], [0.75])):
            model.process_streaming.return_value = scores
            returned = wakeword.scores(model, features, bytes(640))
            self.assertEqual(returned, expected)
            self.assertTrue(all(type(score) is float for score in returned))
        for scores in ([True], [float('nan')], [float('inf')], [-0.1], [1.1], ['private'], [0.1] * 1001):
            model.process_streaming.return_value = scores
            with self.assertRaisesRegex(ValueError, 'Invalid wake score'):
                wakeword.scores(model, features, bytes(640))

    def test_worker_sends_one_score_per_frame(self):
        runtime, identities, sdk, _ = self.runtime()
        sdk.OpenWakeWord.from_model.side_effect = None
        model = sdk.OpenWakeWord.from_model.return_value
        features = sdk.OpenWakeWordFeatures.from_builtin.return_value
        features.process_streaming.return_value = [object()]
        for scored, response in (([0.75], b'RS\x3f\x40\x00\x00'), ([0.75, 0.25], b'RE')):
            model.process_streaming.return_value = scored
            output = io.BytesIO()
            with patch.object(wakeword, 'RUNTIME', runtime), patch.object(wakeword, 'ASSET_IDENTITIES', identities), \
                    patch.dict(sys.modules, pyopen_wakeword=sdk), patch.object(wakeword.resource, 'setrlimit'), \
                    patch('sys.stderr', new_callable=io.StringIO) as diagnostics:
                wakeword.serve(io.BytesIO(bytes(640)), output)
            self.assertEqual(output.getvalue(), response)
            self.assertNotIn('private', diagnostics.getvalue())

    def test_wire_scores_must_be_probabilities(self):
        for payload, expected in ((b'\x3f\x40\x00\x00', 0.75), (bytes(4), 0.0), (b'\x3f\x80\x00\x00', 1.0)):
            self.assertEqual(wakeword.wire_score(payload), expected)
        for payload in (b'\x7f\xc0\x00\x00', b'\x7f\x80\x00\x00', b'\xbf\x00\x00\x00', b'\x3f\xc0\x00\x00'):
            with self.assertRaisesRegex(ValueError, 'Invalid wake score'):
                wakeword.wire_score(payload)

    def test_a_score_above_the_bar_wakes(self):
        detected = Mock()
        detector = wakeword.WakeWordDetector(on_detected=detected, on_failed=Mock())
        detector.scored(0.5)
        detected.assert_not_called()
        detector.scored(0.500001)
        detected.assert_called_once_with()

    def test_worker_refuses_truncated_frames_and_closes_both_resources(self):
        runtime, identities, sdk, _ = self.runtime()
        model = sdk.OpenWakeWord.from_model.return_value
        # Construction records asset admission independently, and returns the controlled native objects.
        sdk.OpenWakeWord.from_model.side_effect = None
        features = sdk.OpenWakeWordFeatures.from_builtin.return_value
        features.process_streaming.return_value = []

        class Protocol(io.BytesIO):
            def write(self, data):
                if data == b'R':
                    self.ready_pcm = [item.args[0] for item in features.process_streaming.call_args_list]
                return super().write(data)

        for payload, response in ((bytes(640), b'RN'), (b'private truncated PCM', b'RE')):
            features.process_streaming.reset_mock()
            output = Protocol()
            with patch.object(wakeword, 'RUNTIME', runtime), patch.object(wakeword, 'ASSET_IDENTITIES', identities), \
                    patch.dict(sys.modules, pyopen_wakeword=sdk), patch.object(wakeword.resource, 'setrlimit') as core, \
                    patch('sys.stderr', new_callable=io.StringIO) as diagnostics:
                wakeword.serve(io.BytesIO(payload), output)
            self.assertEqual(output.getvalue(), response)
            self.assertEqual(output.ready_pcm, [bytes(640)], 'Readiness follows one zero priming frame')
            self.assertNotIn('private', diagnostics.getvalue())
            core.assert_called_once_with(wakeword.resource.RLIMIT_CORE, (0, 0))
            self.assertTrue(model.close.called)
            self.assertTrue(features.close.called)
        model.close.side_effect = RuntimeError('private native failure')
        features.close.reset_mock()
        output = io.BytesIO()
        with patch.object(wakeword, 'RUNTIME', runtime), patch.object(wakeword, 'ASSET_IDENTITIES', identities), \
                patch.dict(sys.modules, pyopen_wakeword=sdk), patch.object(wakeword.resource, 'setrlimit'), \
                patch('sys.stderr', new_callable=io.StringIO) as diagnostics:
            wakeword.serve(io.BytesIO(b''), output)
        self.assertEqual(output.getvalue(), b'RE')
        features.close.assert_called_once()
        self.assertNotIn('private', diagnostics.getvalue())


class WakeWorkerTests(unittest.IsolatedAsyncioTestCase):
    def child(self, code):
        native_spawn = asyncio.create_subprocess_exec
        self.spawned = asyncio.Queue()
        self.hits, self.failure = asyncio.Event(), asyncio.Event()
        detector = wakeword.WakeWordDetector(on_detected=self.hits.set, on_failed=self.failure.set)
        async def close():
            if detector.close_task is None:
                await detector.close()
            else:
                await asyncio.gather(detector.close_task, return_exceptions=True)
        self.addAsyncCleanup(close)

        async def spawn(*argv, **kwargs):
            self.assertEqual(argv[:3], ('setpriv', '--pdeathsig', 'KILL'))
            self.assertEqual(argv[-4:], (str(wakeword.RUNTIME / 'venv/bin/python'), '-I', '-B', str(wakeword.ROOT / 'wakeword.py')))
            process = await native_spawn(sys.executable, '-u', '-c', code, **kwargs)
            self.spawned.put_nowait(process)
            return process
        binding = patch.object(wakeword.asyncio, 'create_subprocess_exec', side_effect=spawn)
        binding.start()
        self.spawn_binding = binding
        self.addCleanup(binding.stop)
        return detector

    async def test_worker_wire_rejects_malformed_and_truncated_responses(self):
        detector = self.child(
            "import sys\nsys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush()\n"
            "while True:\n data=sys.stdin.buffer.read(640)\n if not data: break\n"
            " sys.stdout.buffer.write(b'S\\x3f\\x80\\x00\\x00' if data[0] == 1 else b'S\\x7f\\xc0\\x00\\x00' if data[0] == 2 else b'N')\n"
            " sys.stdout.buffer.flush()")
        await detector.start()
        detector.submit(bytes(640))
        detector.submit(bytes([1]) * 640)
        await asyncio.wait_for(self.hits.wait(), 5)
        self.assertFalse(self.failure.is_set())
        detector.submit(bytes([2]) * 640)
        await asyncio.wait_for(self.failure.wait(), 5)
        await detector.close()
        self.assertIsNotNone(detector.process.returncode)
        self.assertTrue(detector.task.done())
        self.assertTrue(detector.queue.empty())
        self.assertTrue(detector.process.stdin.is_closing())
        self.assertTrue(detector.process.stdout._transport.is_closing())

    async def test_truncated_score_is_refused_and_reaped(self):
        detector = self.child(
            "import sys; sys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush(); sys.stdin.buffer.read(640)\n"
            "sys.stdout.buffer.write(b'S\\x3f'); sys.stdout.buffer.flush()")
        await detector.start()
        detector.submit(bytes(640))
        await asyncio.wait_for(self.failure.wait(), 5)
        self.assertFalse(self.hits.is_set())
        await detector.close()
        self.assertIsNotNone(detector.process.returncode)

    async def test_startup_death_timeout_and_cancel_reap(self):
        native_timeout = asyncio.timeout
        for kind in ('dead', 'timeout', 'cancel'):
            with self.subTest(kind=kind):
                detector = self.child('pass' if kind == 'dead' else 'import time; time.sleep(60)')
                deadlines = asyncio.Queue()

                def timeout(seconds):
                    self.assertEqual(seconds, 30)
                    deadline = native_timeout(None)
                    deadlines.put_nowait(deadline)
                    return deadline

                with patch.object(wakeword.asyncio, 'timeout', side_effect=timeout):
                    starting = asyncio.create_task(detector.start())
                    process = await asyncio.wait_for(self.spawned.get(), 5)
                    deadline = await asyncio.wait_for(deadlines.get(), 5)
                    if kind == 'timeout':
                        deadline.reschedule(asyncio.get_running_loop().time())
                    elif kind == 'cancel':
                        starting.cancel()
                    if kind == 'cancel':
                        with self.assertRaises(asyncio.CancelledError):
                            await starting
                    else:
                        await asyncio.wait_for(starting, 5)
                        self.assertTrue(self.failure.is_set())
                self.assertIsNotNone(process.returncode)
                self.assertTrue(detector.closed)
                self.spawn_binding.stop()

    async def test_frame_deadline_overflow_and_invalid_input_disable(self):
        for payload in (bytes(639), bytearray(640)):
            failed = Mock()
            detector = wakeword.WakeWordDetector(on_detected=Mock(), on_failed=failed)
            detector.submit(payload)
            failed.assert_called_once_with()
            await detector.close()
        failed = Mock()
        queued = wakeword.WakeWordDetector(on_detected=Mock(), on_failed=failed)
        for _ in range(4):
            queued.submit(bytes(640))
        self.assertEqual(queued.queue.qsize(), 4)
        self.assertFalse(queued.failed)
        queued.submit(bytes(640))
        failed.assert_called_once_with()
        await queued.close()
        self.assertTrue(queued.queue.empty())
        detector = self.child("import sys, time; sys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush(); sys.stdin.buffer.read(640); time.sleep(60)")
        await detector.start()
        native_timeout = asyncio.timeout
        deadlines = asyncio.Queue()

        def timeout(seconds):
            self.assertEqual(seconds, 1)
            deadline = native_timeout(None)
            deadlines.put_nowait(deadline)
            return deadline

        with patch.object(wakeword.asyncio, 'timeout', side_effect=timeout):
            detector.submit(bytes(640))
            deadline = await asyncio.wait_for(deadlines.get(), 5)
            deadline.reschedule(asyncio.get_running_loop().time())
            await asyncio.wait_for(self.failure.wait(), 5)
        await detector.close()
        self.assertIsNotNone(detector.process.returncode)

    async def test_repeated_cancel_keeps_cleanup_owned(self):
        entered, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        detector = self.child("import sys; sys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush(); sys.stdin.buffer.read()")
        await detector.start()
        process = detector.process
        native_wait_closed = process.stdin.wait_closed

        async def reap_after_observation():
            release.set()
            if detector.close_task is not None:
                await asyncio.gather(detector.close_task, return_exceptions=True)
            if process.stdout._transport is not None:
                process.stdout._transport.close()
            if process.returncode is None:
                process.kill()
            await asyncio.wait_for(process.wait(), 5)

        self.addAsyncCleanup(reap_after_observation)

        async def held_close():
            entered.set()
            await release.wait()
            await native_wait_closed()

        with patch.object(process.stdin, 'wait_closed', side_effect=held_close):
            caller = asyncio.create_task(detector.close())
            self.addCleanup(caller.cancel)
            await asyncio.wait_for(entered.wait(), 5)
            caller.cancel()
            cancellation_delivered = asyncio.Event()
            asyncio.get_running_loop().call_soon(cancellation_delivered.set)
            await cancellation_delivered.wait()
            caller.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            self.assertFalse(detector.close_task.cancelled(), 'Repeated caller cancellation preserves owned cleanup')
            release.set()
            await detector.close()
        self.assertIsNotNone(process.returncode)
        self.assertTrue(process.stdin.is_closing())
        self.assertTrue(process.stdout._transport.is_closing())
        self.assertTrue(detector.task.done())
        self.assertTrue(detector.queue.empty())

    async def test_pipe_close_failure_still_reaps_and_refuses_cleanup(self):
        detector = self.child("import sys; sys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush(); sys.stdin.buffer.read()")
        await detector.start()
        closed = detector.process.stdin.wait_closed

        async def fail_close():
            await closed()
            raise RuntimeError('private pipe failure')

        with patch.object(detector.process.stdin, 'wait_closed', side_effect=fail_close):
            with self.assertRaisesRegex(RuntimeError, 'Wake capture cleanup failed'):
                await detector.close()
        self.assertIsNotNone(detector.process.returncode)
        self.assertTrue(detector.process.stdout._transport.is_closing())
        self.assertTrue(detector.task.done())

    async def test_dead_frame_response_is_refused_and_reaped(self):
        detector = self.child("import sys; sys.stdout.buffer.write(b'R'); sys.stdout.buffer.flush(); sys.stdin.buffer.read(640)")
        await detector.start()
        detector.submit(bytes(640))
        await asyncio.wait_for(self.failure.wait(), 5)
        self.assertFalse(self.hits.is_set())
        await detector.close()
        self.assertIsNotNone(detector.process.returncode)


class NativeWakeWordTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_positive_and_silence(self):
        import hashlib
        import wave
        if not wakeword.RUNTIME.exists() and not wakeword.RUNTIME.is_symlink():
            self.skipTest('Private wake runtime is not provisioned')
        fixture = wakeword.RUNTIME / 'positive.wav'
        self.assertTrue(fixture.is_file(), 'Local delivery requires the private accepted fixture')
        data = fixture.read_bytes()
        self.assertEqual(len(data), 24204)
        self.assertEqual(hashlib.sha256(data).hexdigest(), 'ed4d9ddcc6dbf0835eb212dee74514fd5423f95b9c221578e5d24638c6611422')
        with wave.open(io.BytesIO(data), 'rb') as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()),
                             (1, 2, 16000, 'NONE'))
            pcm = audio.readframes(audio.getnframes())
        padded = pcm + bytes((-len(pcm)) % 640) + bytes(32000)
        for kind, payload in (('positive', padded), ('silence', bytes(len(padded)))):
            with self.subTest(kind=kind):
                process = await asyncio.create_subprocess_exec(
                    str(wakeword.RUNTIME / 'venv/bin/python'), '-I', '-B', str(wakeword.ROOT / 'wakeword.py'),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )

                async def close():
                    if process.returncode is None:
                        process.kill()
                    await asyncio.wait_for(process.wait(), 5)
                self.addAsyncCleanup(close)
                self.assertEqual(await asyncio.wait_for(process.stdout.readexactly(1), 30), b'R')
                hit = Mock()
                detector = wakeword.WakeWordDetector(on_detected=hit, on_failed=Mock())
                for offset in range(0, len(payload), 640):
                    process.stdin.write(payload[offset:offset + 640])
                    await asyncio.wait_for(process.stdin.drain(), 1)
                    result = await asyncio.wait_for(process.stdout.readexactly(1), 1)
                    self.assertIn(result, (b'N', b'S'))
                    if result == b'S':
                        detector.scored(wakeword.wire_score(await asyncio.wait_for(process.stdout.readexactly(4), 1)))
                process.stdin.close()
                await asyncio.wait_for(process.stdin.wait_closed(), 5)
                self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)
                self.assertEqual(await asyncio.wait_for(process.stdout.read(), 5), b'')
                self.assertEqual(hit.called, kind == 'positive')
