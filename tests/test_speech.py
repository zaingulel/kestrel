import asyncio
import base64
import io
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
from contextlib import contextmanager, nullcontext
from pathlib import Path
import threading
import unittest
import wave
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from loguru import logger
from wetext.alignment import NormalizationMapping, NormalizationResult
from pipecat.frames.frames import (
    CancelFrame, DataFrame, EndFrame, InputAudioRawFrame, InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    StartFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame, TTSTextFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

from admission import Admission
import reply_progress
import speech
from speech import NemotronSTT, VoicePreset, VoxCPMTTS, load_voice_preset


def setUpModule():
    # pipecat's idle limit is shortened so tests do not wait it out.
    unittest.enterModuleContext(patch.dict(speech.TTSService.__init__.__kwdefaults__, stop_frame_timeout_s=0.5))


TEST_PRESET = VoicePreset(Path("/fixture/voice.wav"), "Fixture voice.", bytes(9600))


def reply_record(token=None, delivery='neutral'):
    record = reply_progress.ReplyProgress(token, feed=None, feed_open=lambda: True)
    record.delivery = delivery
    return record


async def open_section(voice, context_id, record):
    # The public path a turn takes: a labelled start frame, then the turn's context opens its section.
    start = LLMFullResponseStartFrame()
    start.reply_progress = record
    await voice.process_frame(start, speech.FrameDirection.DOWNSTREAM)
    await voice.on_turn_context_created(context_id)
    await voice.create_audio_context(context_id)
    return voice.section(context_id)


class VoicePresetTests(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.directory = Path(home.name)
        self.pcm = b'\x01\x00' * 480
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(self.pcm)
        self.wav = output.getvalue()

    def test_preset_pair_validation_and_containment(self):
        (self.directory / 'fixture.wav').write_bytes(self.wav)
        (self.directory / 'fixture.txt').write_bytes(b' \tLiteral spoken wording.\r\n')
        observed = []
        native_open = Path.open

        @contextmanager
        def observe_open(path, *args, **kwargs):
            with native_open(path, *args, **kwargs) as source:
                reader = Mock(wraps=source)
                yield reader
                observed.extend((path.suffix, call.args[0]) for call in reader.read.call_args_list)

        with patch.object(Path, 'open', observe_open):
            preset = load_voice_preset('fixture', voices_dir=self.directory)
        self.assertEqual(preset.reference, self.directory / 'fixture.wav')
        self.assertEqual(preset.transcript, 'Literal spoken wording.')
        self.assertEqual(preset.pcm, self.pcm)
        self.assertEqual({suffix for suffix, _ in observed}, {'.wav', '.txt'})
        for suffix, size in observed:
            self.assertGreater(size, 0)
            self.assertLessEqual(size, {'.wav': 1048577, '.txt': 4097}[suffix])
        (self.directory / 'fixture.txt').write_bytes(b'x' * 4096)
        self.assertEqual(len(load_voice_preset('fixture', voices_dir=self.directory).transcript), 4096)
        (self.directory / 'fixture.wav').write_bytes(self.wav + bytes(1048576 - len(self.wav)))
        self.assertEqual(load_voice_preset('fixture', voices_dir=self.directory).pcm, self.pcm)
        for name in ('', 'UPPER', 'space name', 'a' * 65, '../fixture', '/fixture'):
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'name'):
                load_voice_preset(name, voices_dir=self.directory)
        linked_directory = self.directory / 'linked-runtime'
        linked_directory.symlink_to(self.directory, target_is_directory=True)
        self.assertEqual(load_voice_preset('fixture', voices_dir=linked_directory).reference,
                         self.directory / 'fixture.wav')
        nested = self.directory / 'nested'
        nested.mkdir()
        (nested / 'reference.wav').write_bytes(self.wav)
        (self.directory / 'nested.wav').symlink_to(nested / 'reference.wav')
        (self.directory / 'nested.txt').write_text('Literal spoken wording.')
        with self.assertRaisesRegex(RuntimeError, 'immediately inside'):
            load_voice_preset('nested', voices_dir=self.directory)

    def test_additional_pair_needs_no_registry(self):
        for name, transcript in [('irish-female', 'Irish fixture.'), ('british-male', 'British fixture.'),
                                 ('third', 'Third fixture.')]:
            with self.subTest(name=name):
                (self.directory / (name + '.wav')).write_bytes(self.wav)
                (self.directory / (name + '.txt')).write_text(transcript)
                preset = load_voice_preset(name, voices_dir=self.directory)
                self.assertEqual((preset.reference, preset.transcript, preset.pcm),
                                 (self.directory / (name + '.wav'), transcript, self.pcm))


class RecognitionTests(unittest.IsolatedAsyncioTestCase):
    def service(self, response):
        service = NemotronSTT(speech.NemotronRecognizer(), admission=Admission(voice=True, output_switching=lambda: False))
        service.recognizer.process = Mock(returncode=None)
        service.recognizer.process.stdin.drain = AsyncMock()
        service.recognizer.process.wait = AsyncMock()
        service.recognizer.process.stdout.readline = AsyncMock(return_value=response)
        return service

    async def test_discard_pending_rejects_late_and_queued_segments(self):
        service = self.service(b'')
        admission = service.admission
        stale_mark = admission.input_mark()
        responses = asyncio.Queue()
        submitted = asyncio.Queue()
        service.recognizer.process.stdout.readline.side_effect = responses.get
        service.recognizer.process.stdin.write.side_effect = submitted.put_nowait
        worker, observed = await LaptopAudioTests.pipeline(self, service)
        self.addAsyncCleanup(service.recognizer.close)
        await service._segment_queue.put(b'old active segment')
        await asyncio.wait_for(submitted.get(), 5)
        await service._segment_queue.put(b'old queued segment')
        service._audio_buffer.extend(b'old partial buffer')
        old_worker = service._segment_task
        admission.take_typed(admission.accept_typed(on_taken=Mock()))
        await service.discard_pending()
        self.assertTrue(old_worker.done())
        self.assertEqual(service._audio_buffer, b'')
        self.assertFalse(service._user_speaking)
        self.assertTrue(service._segment_queue.empty())
        responses.put_nowait(b'{"text":"old late mute"}\n')
        await service.recognizer.drain()
        await service.process_audio_frame(InputAudioRawFrame(b'trailing tail', 16000, 1), speech.FrameDirection.DOWNSTREAM)
        await service.process_frame(VADUserStoppedSpeakingFrame(), speech.FrameDirection.DOWNSTREAM)
        self.assertEqual(service._audio_buffer, b'')
        self.assertTrue(service._segment_queue.empty())
        self.assertTrue(submitted.empty())
        stale = TranscriptionFrame('old already finalized', '', '', finalized=True)
        stale.input_mark = stale_mark
        await service.push_frame(stale)
        await service.process_frame(VADUserStartedSpeakingFrame(), speech.FrameDirection.DOWNSTREAM)
        self.assertFalse(service.awaiting_fresh_vad)
        await service.process_audio_frame(InputAudioRawFrame(bytes(640), 16000, 1), speech.FrameDirection.DOWNSTREAM)
        await service.process_frame(VADUserStoppedSpeakingFrame(), speech.FrameDirection.DOWNSTREAM)
        await asyncio.wait_for(submitted.get(), 5)
        responses.put_nowait(b'{"text":"fresh speech"}\n')
        frame = await LaptopAudioTests.next_frame(self, observed, TranscriptionFrame)
        self.assertEqual((frame.text, frame.input_mark), ('fresh speech', admission.input_mark()))
        self.assertTrue(submitted.empty(), 'Only fresh VAD audio creates another native request')
        await worker.cancel()

    async def test_cancelled_adapter_drains_native_response_before_reuse(self):
        old = self.service(b'')
        process = old.recognizer.process
        responses = asyncio.Queue()
        submitted = asyncio.Event()
        events = []
        readers = 0
        peak_readers = 0

        async def read_response():
            nonlocal readers, peak_readers
            readers += 1
            peak_readers = max(peak_readers, readers)
            try:
                response = await responses.get()
                events.append(json.loads(response)['text'])
                return response
            finally:
                readers -= 1

        def write(request):
            events.append(base64.b64decode(json.loads(request)['audio']).decode())
            submitted.set()

        process.stdout.readline.side_effect = read_response
        process.stdin.write.side_effect = write
        fresh = self.service(b'')
        fresh.recognizer = old.recognizer
        tasks = []

        async def consume(adapter, audio):
            return [frame.text async for frame in adapter.run_stt(audio)]

        async def cleanup():
            for task in tasks:
                task.cancel()
            responses.put_nowait(b'{"text":"cleanup"}\n')
            await asyncio.gather(*tasks, return_exceptions=True)

        self.addAsyncCleanup(cleanup)
        request = asyncio.create_task(consume(old, b'old request'))
        tasks.append(request)
        await asyncio.wait_for(submitted.wait(), 5)
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        next_request = asyncio.create_task(consume(fresh, b'fresh request'))
        tasks.append(next_request)
        responses.put_nowait(b'{"text":"old response"}\n')
        responses.put_nowait(b'{"text":"fresh response"}\n')
        self.assertEqual(await asyncio.wait_for(next_request, 5), ['fresh response'])
        self.assertEqual(events, ['old request', 'old response', 'fresh request', 'fresh response'])
        self.assertEqual(peak_readers, 1)

        submitted.clear()
        queued_admission = asyncio.Event()

        def switching():
            queued_admission.set()
            return False

        revoked = NemotronSTT(old.recognizer, admission=Admission(voice=True, output_switching=switching))
        held = asyncio.create_task(consume(old, b'held request'))
        tasks.append(held)
        await asyncio.wait_for(submitted.wait(), 5)
        waiting = asyncio.create_task(consume(revoked, b'revoked request'))
        tasks.append(waiting)
        await asyncio.wait_for(queued_admission.wait(), 5)
        revoked.admission.close()
        responses.put_nowait(b'{"text":"held response"}\n')
        self.assertEqual(await asyncio.wait_for(held, 5), ['held response'])
        self.assertEqual(await asyncio.wait_for(waiting, 5), [])
        self.assertEqual(events[-2:], ['held request', 'held response'])
        await old.recognizer.drain()

        for invalid in (b'', b'[]\n', b'{"text":123}\n', b'x' * 65537):
            with self.subTest(invalid_response=invalid[:30]):
                failed = self.service(invalid)
                self.addAsyncCleanup(failed.recognizer.close)
                with self.assertRaises(RuntimeError):
                    await consume(failed, b'invalid request')
                failed.recognizer.process.terminate.assert_called_once_with()
                failed.recognizer.process.wait.assert_awaited_once_with()
                failed.recognizer.process.stdin.write.reset_mock()
                with self.assertRaises(RuntimeError):
                    await consume(failed, b'never retry')
                failed.recognizer.process.stdin.write.assert_not_called()

    async def test_load_finishes_reference_inference_before_returning(self):
        service = NemotronSTT(speech.NemotronRecognizer(), admission=Admission(voice=True, output_switching=lambda: False))
        process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.wait = AsyncMock()
        activity = asyncio.Event()
        release = asyncio.Event()
        responses = iter([b'{"ready":true}\n', b'{"text":"discarded preparation"}\n'])

        async def read_response():
            response = next(responses)
            if b'"text"' in response:
                await release.wait()
            return response

        process.stdout.readline = AsyncMock(side_effect=read_response)
        process.stdin.write.side_effect = lambda request: activity.set()
        pcm = bytes(9600)
        with (
            patch.object(speech.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
        ):
            load = asyncio.create_task(service.recognizer.load(pcm))
            load.add_done_callback(lambda completed: activity.set())
            try:
                await asyncio.wait_for(activity.wait(), 5)
                spawn.assert_awaited_once_with(
                    str(speech.ROOT / ".runtime/voice-venv/bin/python"), str(speech.ROOT / "asr_worker.py"),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                )
                self.assertEqual(process.stdin.write.call_count, 1)
                request = json.loads(process.stdin.write.call_args.args[0])
                with wave.open(io.BytesIO(base64.b64decode(request['audio'])), 'rb') as audio:
                    self.assertEqual(audio.getnchannels(), 1)
                    self.assertEqual(audio.getsampwidth(), 2)
                    self.assertEqual(audio.getframerate(), 16000)
                    self.assertEqual(audio.getnframes(), 1600)
                    self.assertEqual(len(audio.readframes(1600)), 3200)
                self.assertFalse(load.done())
                release.set()
                self.assertIsNone(await load)
                self.assertEqual(process.stdin.write.call_count, 1)
            finally:
                release.set()
                await load
                await service.recognizer.close()

    async def test_load_rejects_unusable_reference_or_warmup_failure(self):
        process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.wait = AsyncMock()
        process.stdout.readline = AsyncMock(side_effect=[
            b'{"ready":true}\n', b'{"error":"preparation inference failed"}\n',
        ])
        service = NemotronSTT(speech.NemotronRecognizer(), admission=Admission(voice=True, output_switching=lambda: False))
        with patch.object(speech.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            try:
                with self.assertRaisesRegex(RuntimeError, 'preparation inference failed'):
                    await service.recognizer.load(bytes(9600))
                self.assertEqual(process.stdin.write.call_count, 1)
            finally:
                await service.recognizer.close()

    async def test_transcript_is_finalized_and_audio_is_sent(self):
        service = self.service(b'{"text":"hello kestrel"}\n')
        frames = [frame async for frame in service.run_stt(b"audio")]
        self.assertEqual(len(frames), 1)
        self.assertIsInstance(frames[0], TranscriptionFrame)
        self.assertEqual(frames[0].text, "hello kestrel")
        self.assertTrue(frames[0].finalized)
        request = json.loads(service.recognizer.process.stdin.write.call_args.args[0])
        self.assertEqual(request["audio"], "YXVkaW8=")

    async def test_silence_does_not_invent_a_transcript(self):
        service = self.service(b'{"text":""}\n')
        self.assertEqual([frame async for frame in service.run_stt(b"audio")], [])

    async def test_worker_failure_is_reported(self):
        for response, message in [(b'', "worker stopped"), (b'{"error":"GPU failure"}', "GPU failure")]:
            with self.subTest(response=response):
                service = self.service(response)
                with self.assertRaisesRegex(RuntimeError, message):
                    [frame async for frame in service.run_stt(b"audio")]


class PhononTests(unittest.IsolatedAsyncioTestCase):
    @contextmanager
    def assets(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            directory = root / 'shared-models' / 'phonon-31m-en-q8'
            directory.mkdir(parents=True)
            (root / '.runtime').mkdir()
            (root / '.runtime/models').symlink_to(directory.parent, target_is_directory=True)
            contents = {name: name.encode() for name in (
                'config.json', 'tokenizer.json', 'model.q8.gguf', 'default-voice.safetensors')}
            for name, data in contents.items():
                (directory / name).write_bytes(data)
            pins = {name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in contents.items()}
            (directory.parent / 'phonon-bryony-gfP44RlHwr2kEwk7.safetensors').write_bytes(b'abc')
            with (
                patch.object(speech, 'ROOT', root), patch.object(speech, 'PHONON_ASSETS', pins),
                patch.object(speech, 'PHONON_BRYONY_ASSET',
                             ('phonon-bryony-gfP44RlHwr2kEwk7.safetensors', 3,
                              'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')),
            ):
                yield directory, contents

    async def test_bryony_assets_refuse_before_native_load(self):
        for fault in ('missing', 'short', 'long', 'digest', 'symlink', 'directory', 'fifo'):
            with self.subTest(fault=fault), self.assets() as (directory, _):
                asset = directory.parent / 'phonon-bryony-gfP44RlHwr2kEwk7.safetensors'
                if fault == 'missing':
                    asset.unlink()
                elif fault == 'short':
                    asset.write_bytes(b'ab')
                elif fault == 'long':
                    asset.write_bytes(b'abcd')
                elif fault == 'digest':
                    asset.write_bytes(b'xyz')
                else:
                    asset.unlink()
                    if fault == 'symlink':
                        asset.symlink_to(directory / 'config.json')
                    elif fault == 'directory':
                        asset.mkdir()
                    else:
                        os.mkfifo(asset)
                model = Mock(sample_rate=24000, voices=['default'])
                native = Mock(__version__='0.4.0', TTS=Mock(return_value=model))
                with patch.dict(sys.modules, {'ptts': native}):
                    with self.assertRaisesRegex(RuntimeError, 'Phonon.*[Rr]estore.*Bryony.*restart'):
                        speech.load_phonon()
                native.TTS.assert_not_called()
        self.assertEqual(speech.PHONON_BRYONY_ASSET, (
            'phonon-bryony-gfP44RlHwr2kEwk7.safetensors', 256136,
            'bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b',
        ))

    async def test_pinned_assets_refuse_before_native_load(self):
        self.assertEqual(speech.PHONON_ASSETS, {
            'config.json': (4634, 'b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85'),
            'tokenizer.json': (277967, '691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936'),
            'model.q8.gguf': (64512352, 'a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae'),
            'default-voice.safetensors': (256136, 'f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18'),
        })
        for fault in ('missing', 'short', 'long', 'digest', 'symlink', 'directory', 'unexpected'):
            with self.subTest(fault=fault), self.assets() as (directory, contents):
                asset = directory / 'model.q8.gguf'
                if fault == 'missing':
                    asset.unlink()
                elif fault == 'short':
                    asset.write_bytes(b'')
                elif fault == 'long':
                    asset.write_bytes(contents[asset.name] + b'x')
                elif fault == 'digest':
                    asset.write_bytes(b'x' * len(contents[asset.name]))
                elif fault == 'symlink':
                    asset.unlink()
                    asset.symlink_to(directory / 'config.json')
                elif fault == 'directory':
                    asset.unlink()
                    asset.mkdir()
                else:
                    (directory / 'voices').mkdir()
                native = Mock(__version__='0.4.0')
                with patch.dict(sys.modules, {'ptts': native}):
                    with self.assertRaisesRegex(RuntimeError, 'Phonon.*[Rr]estore'):
                        speech.load_phonon()
                native.TTS.assert_not_called()
        for replaced in (False, True):
            with self.subTest(replaced=replaced), self.assets() as (directory, _):
                model = Mock(sample_rate=24000, voices=['default'])
                descriptors = []

                def register(name, path):
                    self.assertEqual(name, 'bryony')
                    self.assertTrue(path.startswith('/proc/self/fd/'))
                    self.assertEqual(Path(path).read_bytes(), b'abc')
                    descriptors.append(Path(path))
                    model.voices.append(name)

                def construct(*args, **kwargs):
                    if replaced:
                        asset = directory.parent / 'phonon-bryony-gfP44RlHwr2kEwk7.safetensors'
                        asset.unlink()
                        asset.write_bytes(b'xyz')
                    return model

                model.add_voice.side_effect = register
                native = Mock(__version__='0.4.0', TTS=Mock(side_effect=construct))
                with patch.dict(sys.modules, {'ptts': native}):
                    self.assertIs(speech.load_phonon(), model)
                native.TTS.assert_called_once_with(str(directory), lang='en', quant='q8', device='cpu')
                native.set_num_threads.assert_called_once_with(4)
                model.add_voice.assert_called_once()
                self.assertEqual(len(descriptors), 1)
                self.assertFalse(descriptors[0].exists())

    async def test_runtime_and_default_voice_refuse_before_stream(self):
        for fault in ('missing package', 'version', 'missing version', 'rate', 'default', 'native load',
                      'registration', 'missing Bryony'):
            with self.subTest(fault=fault), self.assets():
                model = Mock(sample_rate=22050 if fault == 'rate' else 24000,
                             voices=[] if fault == 'default' else ['default'])
                native = Mock(__version__='0.3.0' if fault == 'version' else '0.4.0',
                              TTS=Mock(return_value=model))
                descriptors = []

                def register(name, path):
                    descriptors.append(Path(path))
                    self.assertEqual(Path(path).read_bytes(), b'abc')
                    if fault == 'registration':
                        raise ValueError('registration refused')
                    if fault != 'missing Bryony':
                        model.voices.append(name)

                model.add_voice.side_effect = register
                if fault == 'missing version':
                    del native.__version__
                if fault == 'native load':
                    native.TTS.side_effect = ValueError('native load refused')
                with patch.dict(sys.modules, {'ptts': None if fault == 'missing package' else native}):
                    with self.assertRaisesRegex(RuntimeError, 'Phonon.*[Rr]estore'):
                        speech.load_phonon()
                model.stream.assert_not_called()
                self.assertTrue(all(not path.exists() for path in descriptors))
                if fault in ('missing package', 'version', 'missing version'):
                    native.TTS.assert_not_called()
                self.assertFalse(any('catalog' in call[0] or 'clone' in call[0] for call in native.mock_calls))

    async def test_public_default_resamples_and_closes(self):
        import soxr

        n = np.arange(24000)
        waveform = (0.2 * np.sin(2 * np.pi * 440 * n / 24000)
                    + 0.1 * np.sin(2 * np.pi * 6100 * n / 24000)).astype(np.float32)
        expected = (np.clip(soxr.resample(waveform, 24000, 48000, quality='HQ'), -1, 1)
                    * 32767).astype('<i2').astype(np.int32)

        class NativeStream:
            sample_rate = 24000

            def __init__(self):
                self.chunks = iter(np.split(waveform, [1, 32, 541, 1538, 5634, 13825]))
                self.close = Mock()

            def __iter__(self):
                return self

            def __next__(self):
                return next(self.chunks)

        for delivery in ('neutral', 'curious', 'gently_pleased', 'reassuring'):
            with self.subTest(delivery=delivery):
                stream = NativeStream()
                model = Mock(sample_rate=24000, voices=['default'], stream=Mock(return_value=stream))
                voice = speech.PhononTTS(model)
                self.assertIsInstance(voice, speech.ConversationTTS)
                self.assertEqual(voice.settings.voice, 'bryony')
                record = reply_record(delivery=delivery)
                await open_section(voice, 'turn', record)
                frames = [frame async for frame in voice.run_tts('The answer is 18.', 'turn')]
                model.stream.assert_called_once_with('The answer is eighteen.', voice='bryony', seed=1234)
                stream.close.assert_called_once_with()
                self.assertTrue(all(isinstance(frame, TTSAudioRawFrame) and frame.sample_rate == 48000
                                    and frame.num_channels == 1 and frame.context_id == 'turn' for frame in frames))
                self.assertEqual(record.text_started_by(frames[0]), 'The answer is 18.')
                actual = np.frombuffer(b''.join(frame.audio for frame in frames), dtype='<i2').astype(np.int32)
                self.assertEqual(len(actual), 48000)
                np.testing.assert_allclose(actual, expected, rtol=0, atol=2)

    async def test_invalid_audio_refuses_output(self):
        for fault, rate, chunks in (
            ('stream rate', 22050, [np.zeros(2400, dtype=np.float32)]),
            ('rank', 24000, [np.zeros((2400, 1), dtype=np.float32)]),
            ('dtype', 24000, [np.zeros(2400, dtype=np.float64)]),
            ('type', 24000, [[0.0] * 2400]),
            ('NaN', 24000, [np.full(2400, np.nan, dtype=np.float32)]),
            ('infinity', 24000, [np.full(2400, np.inf, dtype=np.float32)]),
            ('empty chunk', 24000, [np.empty(0, dtype=np.float32)]),
            ('empty stream', 24000, []),
            ('native exception', 24000, []),
            ('stream creation', 24000, []),
        ):
            with self.subTest(fault=fault):
                class NativeStream:
                    sample_rate = rate
                    close = Mock()

                    def __iter__(self):
                        if fault == 'native exception':
                            raise ValueError('native failed')
                        return iter(chunks)

                stream = NativeStream()
                model = Mock(sample_rate=24000, voices=['default'], stream=Mock(return_value=stream))
                if fault == 'stream creation':
                    model.stream.side_effect = ValueError('native stream failed')
                voice = speech.PhononTTS(model)
                context = await open_section(voice, 'invalid', reply_record(object()))
                voice.push_frame = AsyncMock()
                emitted = []
                with self.assertRaisesRegex(RuntimeError, 'Phonon.*[Rr]estart'):
                    async for frame in voice.run_tts('Refuse corrupt output.', 'invalid'):
                        emitted.append(frame)
                self.assertEqual(emitted, [])
                voice.push_frame.assert_awaited_once()
                failure = voice.push_frame.call_args.args[0]
                self.assertIsInstance(failure, speech.ConversationSynthesisFailedFrame)
                self.assertIs(failure.section, context)
                if fault == 'stream creation':
                    stream.close.assert_not_called()
                else:
                    stream.close.assert_called_once_with()
        model = Mock(sample_rate=24000, voices=['default'])
        voice = speech.PhononTTS(model)
        await open_section(voice, 'invalid', reply_record(delivery='unknown'))
        with self.assertRaisesRegex(RuntimeError, 'Invalid internal speech delivery'):
            _ = [frame async for frame in voice.run_tts('Refuse invalid delivery.', 'invalid')]
        model.stream.assert_not_called()

    async def test_cancel_waits_for_native_close_before_reuse(self):
        for outcome in ('clean', 'close failure'):
            with self.subTest(cleanup=outcome):
                loop = asyncio.get_running_loop()
                next_entered, close_entered, queued_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
                release_next, release_close = threading.Event(), threading.Event()
                events, streams, tasks = [], [], []

                class NativeStream:
                    sample_rate = 24000

                    def __init__(self, text):
                        self.text = text
                        self.count = 0
                        self.closes = 0

                    def __iter__(self):
                        return self

                    def __next__(self):
                        self.count += 1
                        if self.text == 'old' and self.count == 2:
                            loop.call_soon_threadsafe(next_entered.set)
                            if not release_next.wait(5):
                                raise AssertionError('Native next was never released')
                        if self.count > (2 if self.text == 'old' else 1):
                            raise StopIteration
                        return np.full(4096, 0.1, dtype=np.float32)

                    def close(self):
                        self.closes += 1
                        if self.text == 'old':
                            loop.call_soon_threadsafe(close_entered.set)
                            if not release_close.wait(5):
                                raise AssertionError('Native close was never released')
                        events.append((self.text, 'closed'))
                        if self.text == 'old' and outcome == 'close failure':
                            raise RuntimeError('native close refused')

                def generate(text, *, voice, seed):
                    self.assertEqual((voice, seed), ('bryony', 1234))
                    events.append((text, 'start'))
                    stream = NativeStream(text)
                    streams.append(stream)
                    return stream

                model = Mock(sample_rate=24000, voices=['default'], stream=Mock(side_effect=generate))
                lock = asyncio.Lock()
                old_voice = speech.PhononTTS(model, generation_lock=lock)
                new_voice = speech.PhononTTS(model, generation_lock=lock) if outcome == 'clean' else old_voice

                async def consume(voice, text):
                    if text == 'new':
                        queued_entered.set()
                    return [frame async for frame in voice.run_tts(text, text)]

                old = asyncio.create_task(consume(old_voice, 'old'))
                tasks.append(old)
                try:
                    await asyncio.wait_for(next_entered.wait(), 5)
                    old.cancel()
                    new = asyncio.create_task(consume(new_voice, 'new'))
                    tasks.append(new)
                    await asyncio.wait_for(queued_entered.wait(), 5)
                    self.assertTrue(lock.locked())
                    self.assertFalse(old.done())
                    self.assertNotIn(('new', 'start'), events)
                    release_next.set()
                    await asyncio.wait_for(close_entered.wait(), 5)
                    old.cancel()
                    await asyncio.sleep(0)
                    old.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(old.done(), 'Repeated cancellation cannot abandon native close')
                    self.assertTrue(lock.locked())
                    self.assertNotIn(('new', 'start'), events)
                    release_close.set()
                    if outcome == 'clean':
                        with self.assertRaises(asyncio.CancelledError):
                            await old
                        frames = await new
                        self.assertTrue(frames)
                        self.assertLess(events.index(('old', 'closed')), events.index(('new', 'start')))
                        self.assertFalse(old_voice.generation_cleanup_failed)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Phonon native cleanup failed'):
                            await old
                        self.assertTrue(old_voice.generation_cleanup_failed)
                        with self.assertRaisesRegex(RuntimeError, 'Voice generation cleanup failed'):
                            await new
                        self.assertNotIn(('new', 'start'), events)
                    self.assertEqual(streams[0].closes, 1)
                    self.assertFalse(lock.locked())
                finally:
                    release_next.set()
                    release_close.set()
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_delivery_is_context_scoped_and_text_stays_plain(self):
        for text, expected in [
            ('Before. [delivery:reassuring] After.', 'Before. After.'),
            ('Before. [delivery:unknown] After.', 'Before. After.'),
            ('Before. [delivery:reassuring', 'Before.'),
            ('Before. [[delivery:reassuring]] After.', 'Before. After.'),
            (r'Before. \[delivery:reassuring] After.', 'Before. After.'),
            ('Before. [ordinary prose] After.', 'Before. [ordinary prose] After.'),
            ('Before. [[ordinary prose]] After.', 'Before. [[ordinary prose]] After.'),
            (r'Before. \[ordinary prose](plain words) After.',
             'Before. [ordinary prose](plain words) After.'),
        ]:
            with self.subTest(text=text):
                self.assertEqual(' '.join(self.cleaned(text).split()), expected)

        started, completed = asyncio.Event(), asyncio.Queue()
        frames, calls = [], []
        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                frames.append(frame)
                if isinstance(frame, StartFrame):
                    started.set()
                if isinstance(frame, (LLMFullResponseEndFrame, DataFrame)) and type(frame) is not TTSTextFrame:
                    completed.put_nowait(frame)
                await self.push_frame(frame, direction)

        def chunks(**kwargs):
            calls.append(kwargs)
            yield np.zeros(4800, dtype=np.float32)

        voice = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        worker = PipelineWorker(Pipeline([voice, Sink()]), enable_rtvi=False, idle_timeout_secs=None)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        prefixes = [
            ('neutral', 'Hello.'),
            ('curious', '(Subtly curious and interested, natural conversational delivery) Hello.'),
            ('gently_pleased', '(Gently pleased, with a subtle smile in the voice) Hello.'),
            ('reassuring', '(Warm, gentle and reassuring, speaking calmly) Hello.'),
        ]
        try:
            await asyncio.wait_for(started.wait(), 5)
            for label, synthesis in prefixes:
                start = LLMFullResponseStartFrame()
                start.reply_progress = reply_record(object(), label)
                await worker.queue_frames([start, LLMTextFrame('Hello.'), LLMFullResponseEndFrame()])
                while not isinstance(await asyncio.wait_for(completed.get(), 5), LLMFullResponseEndFrame):
                    pass
                expected = dict(text=synthesis, reference_wav_path=str(TEST_PRESET.reference),
                                inference_timesteps=10, max_len=400, retry_badcase=False)
                if label == 'neutral':
                    expected.update(prompt_wav_path=str(TEST_PRESET.reference), prompt_text='Fixture voice.')
                self.assertEqual(calls[-1], expected)
                text_frame = next(f for f in reversed(frames) if isinstance(f, TTSTextFrame))
                audio_frame = next(f for f in reversed(frames) if isinstance(f, TTSAudioRawFrame))
                self.assertEqual(text_frame.text, 'Hello.')
                self.assertEqual(start.reply_progress.text_started_by(audio_frame), 'Hello.')
                self.assertEqual(text_frame.reply_progress.span_of(text_frame)[0].delivery, label)
                self.assertIs(text_frame.reply_progress.span_of(text_frame)[0].reply.token, start.reply_progress.token)

            start = LLMFullResponseStartFrame()
            start.reply_progress = reply_record(delivery='curious')
            await worker.queue_frames([start, LLMTextFrame('First. Tail '), speech.SpeechAdvisoryFrame(' Restart Kestrel.'),
                                       LLMFullResponseEndFrame()])
            while not isinstance(await asyncio.wait_for(completed.get(), 5), LLMFullResponseEndFrame):
                pass
            self.assertEqual(calls[-2]['text'],
                             '(Subtly curious and interested, natural conversational delivery) First.')
            self.assertEqual(calls[-1]['text'], 'Tail Restart Kestrel.')
            self.assertEqual(calls[-1]['prompt_text'], 'Fixture voice.')

            await worker.queue_frames([speech.TTSSpeakFrame('Local reply.'), DataFrame()])
            while type(await asyncio.wait_for(completed.get(), 5)) is not DataFrame:
                pass
            self.assertEqual(calls[-1]['text'], 'Local reply.')
            self.assertEqual(calls[-1]['prompt_text'], 'Fixture voice.')

            await worker.queue_frames([InterruptionFrame(), DataFrame()])
            while type(await asyncio.wait_for(completed.get(), 5)) is not DataFrame:
                pass
            await worker.queue_frames([LLMFullResponseStartFrame(), LLMTextFrame('Replacement.'),
                                       LLMFullResponseEndFrame()])
            while not isinstance(await asyncio.wait_for(completed.get(), 5), LLMFullResponseEndFrame):
                pass
            self.assertEqual(calls[-1]['text'], 'Replacement.')
            self.assertEqual(calls[-1]['prompt_text'], 'Fixture voice.')
            await worker.queue_frame(EndFrame())
            await running
            [f async for f in voice.run_tts('After end.', 'after-end')]
            self.assertEqual(calls[-1]['text'], 'After end.')
        finally:
            if not running.done():
                await worker.cancel()
                await running
        # Context hooks keep queued metadata independent of a later start frame.
        queued = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        for label in ('curious', 'reassuring'):
            start = LLMFullResponseStartFrame()
            start.reply_progress = reply_record(delivery=label)
            await queued.process_frame(start, speech.FrameDirection.DOWNSTREAM)
            context_id = queued._turn_context_id
            await queued.create_audio_context(context_id)
            if label == 'curious':
                old_id = context_id
                old_context = queued.section(old_id)
                await queued.on_turn_context_completed()
        self.assertNotEqual(old_id, context_id)
        self.assertEqual(old_context.delivery, 'curious')
        self.assertEqual(queued.section(context_id).delivery, 'reassuring')
        audio = [f async for f in queued.run_tts('Queued.', old_id)]
        self.assertEqual(calls[-1]['text'],
                         '(Subtly curious and interested, natural conversational delivery) Queued.')
        self.assertEqual(queued.section(old_id).reply.text_started_by(audio[0]), 'Queued.')
        await queued.process_frame(CancelFrame(), speech.FrameDirection.DOWNSTREAM)
        # Retained turn metadata would open a section again.
        await queued.create_audio_context(context_id)
        self.assertIsNone(queued.section(context_id))
        [f async for f in queued.run_tts('Replacement.', 'replacement')]
        self.assertEqual(calls[-1]['text'], 'Replacement.')
        self.assertEqual(calls[-1]['prompt_text'], 'Fixture voice.')
        invalid = LLMFullResponseStartFrame()
        invalid.reply_progress = reply_record(delivery='unknown')
        await queued.process_frame(invalid, speech.FrameDirection.DOWNSTREAM)
        await queued.create_audio_context(queued._turn_context_id)
        with self.assertRaisesRegex(RuntimeError, 'delivery'):
            [f async for f in queued.run_tts('Never.', queued._turn_context_id)]
        # A held list item reaches synthesis as a tail made at the end, labelled like the text it came from.
        tail_voice = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        record, seen = reply_record(), []

        async def record_frame(service, frame, direction):
            seen.append(frame)

        start, fed, end = LLMFullResponseStartFrame(), LLMTextFrame('- Item'), LLMFullResponseEndFrame()
        start.reply_progress = end.reply_progress = record
        with patch.object(speech.TTSService, 'process_frame', record_frame):
            for frame in (start, fed, end):
                await tail_voice.process_frame(frame, speech.FrameDirection.DOWNSTREAM)
        texts = [frame for frame in seen if isinstance(frame, LLMTextFrame)]
        self.assertEqual(len(texts), 2)
        self.assertIs(texts[0], fed)
        for frame in texts:
            self.assertIs(frame.reply_progress, record)

    async def test_reply_cleanup_marks_code_without_speaking_it(self):
        started, finished = asyncio.Event(), asyncio.Event()
        frames, synthesized = [], []

        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                frames.append(frame)
                if isinstance(frame, StartFrame):
                    started.set()
                if isinstance(frame, LLMFullResponseEndFrame):
                    finished.set()
                await self.push_frame(frame, direction)

        def chunks(text, **kwargs):
            synthesized.append(text)
            yield np.zeros(4800, dtype=np.float32)

        worker = PipelineWorker(
            Pipeline([VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET), Sink()]),
            enable_rtvi=False, idle_timeout_secs=None,
        )
        runner = WorkerRunner(handle_sigint=False)
        running = None
        try:
            await runner.add_workers(worker)
            running = asyncio.create_task(runner.run())
            await asyncio.wait_for(started.wait(), 5)
            await worker.queue_frames([
                LLMFullResponseStartFrame(), LLMTextFrame("Use `print(1)` now."),
                LLMFullResponseEndFrame(),
            ])
            await asyncio.wait_for(finished.wait(), 5)
            self.assertEqual(' '.join(synthesized), "Use now. There is code in this reply.")
            self.assertEqual(' '.join(f.text for f in frames if isinstance(f, TTSTextFrame)),
                             "Use now. There is code in this reply.")
            await worker.queue_frame(EndFrame())
            await running
        finally:
            if running is not None and not running.done():
                await worker.cancel()
                await running

        for text, expected in [
            ("Use `print(1)` now.", "Use now. There is code in this reply."),
            ("Use (`print(1)`) now.", "Use now. There is code in this reply."),
            ("Use ``print(`hidden`)`` now.", "Use now. There is code in this reply."),
            ('Before.\n```python\nprint("Hidden. More.")\n```\nAfter.',
             "Before. After. There is code in this reply."),
            ('Before.\n~~~python\nHidden. More.\n~~~\nAfter.',
             "Before. After. There is code in this reply."),
            ('Before.\n\n    print(1)\n    hidden()\nAfter.',
             "Before. After. There is code in this reply."),
            ('\tprint(1)\n\tHidden. More.\nAfter.', "After. There is code in this reply."),
            ('Keep `one` and ``two``.', "Keep and. There is code in this reply."),
            ("Before. `There is no speakable text in this reply. Please ask me to rephrase.` After.",
             "Before. After. There is code in this reply."),
            ('Before.\n````python\n```\nHidden. More.\n`````\nAfter.',
             "Before. After. There is code in this reply."),
        ]:
            with self.subTest(text=text):
                self.assertEqual(' '.join(self.cleaned(text).split()), expected)

    def cleaned(self, text):
        recognizer = speech.SpokenReplyText()
        recognizer.start()
        return ''.join(recognizer.feed(char) for char in text) + recognizer.finish()

    async def test_reply_cleanup_keeps_plain_text_and_flattens_formatting(self):
        for text in [
            "Hello. I am listening.",
            "Open report.md. Version 1.2.3 costs 3.50. Visit example.com.",
            "Use snake_case and 2 * 3.",
            "  Plain  spacing.\nAn indented\n    paragraph continuation.\n",
            "A ~ B. A _ B. Three*four. U.S.A. foo.py.",
            "~ A.",
            "a - b",
            "a | b",
            "Keep [optional] words.",
            "A\n\n    \nPlain.",
        ]:
            with self.subTest(plain=text):
                self.assertEqual(self.cleaned(text), text)
        for text, expected in [
            ("# **Steps**\n- First *item*\n2. Second item", "Steps. First item. Second item."),
            ("  ### Heading ###\n+ Next!\n123456789) Last?", "Heading. Next! Last?"),
            ("> Quoted __words__ and ~~old~~.\n> Another line.", "Quoted words and old. Another line."),
            ("Read _this_ and **that**, then *more*.", "Read this and that, then more."),
            ("An **unfinished phrase", "An unfinished phrase"),
            ("This is ***very*** and ___deeply___ important.", "This is very and deeply important."),
            ("***Bold italic*** start.", "Bold italic start."),
            ("Use _snake_case", "Use snake_case"),
            ("Use _snake_case_ now.", "Use snake_case now."),
            ("Hi\n\n- - -\n\nThere.\n\n***\n\nMore.\n\n___", "Hi. There. More."),
            ("| a | b |\n|---|:---:|\n| 1 | 2 |", "a. b. 1. 2."),
            ("Text\n\n| a | b |\nMore text.", "Text. a. b. More text."),
            ("| a \\| b | `secret()` | [guide](https://x.com) |\n|---|---|---|",
             "a | b. guide. There is code in this reply."),
            ("|https://x.com|safe|", "safe."),
            ("1. Step one\n\n    More detail about step one.\n2. Step two",
             "Step one. More detail about step one. Step two."),
            ("- Item\n    - Sub item\n    - Another\n- Next", "Item. Sub item. Another. Next."),
            ("1. Step one\n\n       print(1)\n\n    Continue safely.\n2. Step two",
             "Step one. Continue safely. Step two. There is code in this reply."),
            ("- Item\n\nOrdinary prose.\n\n    print(1)\nAfter.",
             "Item. Ordinary prose. After. There is code in this reply."),
            ("- Item\n    - Sub item\n\n      ```python\n      hidden()\n      ```\n    - Another\n- Next",
             "Item. Sub item. Another. Next. There is code in this reply."),
            ("># Heading\n> - First *item*\n>>2. Second item", "Heading. First item. Second item."),
            ("### Heading ###", "Heading."),
            (r"Literal \*stars\* and \`ticks\`.", "Literal *stars* and `ticks`."),
        ]:
            with self.subTest(formatted=text):
                self.assertEqual(' '.join(self.cleaned(text).split()), expected)

    async def test_reply_cleanup_omits_explicit_addresses_and_keeps_labels(self):
        for text, expected in [
            ("(https://x.com and more)", "(and more)"),
            ("Read (https://x.com  and more).", "Read (and more)."),
            ("Read (https://x.com  ). Continue.", "Read. Continue."),
            ("See https://en.wikipedia.org/wiki/Hilbert's_paradox today.", "See today."),
            ('Read https://example.com/a"b next.', "Read next."),
            ('Read "https://example.com/it\'s". Continue.', "Read. Continue."),
            ("(see https://x.com)", "(see)"),
            ('She said "see https://x.com".', 'She said "see".'),
            ("See [Hilbert's paradox](https://en.wikipedia.org/wiki/Hilbert's_paradox) for details. It is fun.",
             "See Hilbert's paradox for details. It is fun."),
            ('See [guide](https://x.com/a"b) here. Second sentence.', "See guide here. Second sentence."),
            ("Read https://example.com/a?q=secret. Then continue.", "Read. Then continue."),
            ("Read www.example.com/docs. Then continue.", "Read. Then continue."),
            ("Read HTTP://example.com:80/a#private! Then continue.", "Read! Then continue."),
            ('Read [the guide](https://example.com/a_(b) "Title").', "Read the guide."),
            ('Read ![the **guide**](https://example.com/a_\\(b\\) "Title").', "Read the guide."),
            ("Read <https://example.com/private>. Continue.", "Read. Continue."),
            ("Read (https://example.com/private). Continue.", "Read. Continue."),
            ("Read [https://example.com/private]. Continue.", "Read. Continue."),
            ('Read "https://example.com/private". Continue.', "Read. Continue."),
            ("Read 'https://example.com/private'. Continue.", "Read. Continue."),
            ("A [safe `secret()` label](destination) remains.",
             "A safe label remains. There is code in this reply."),
            ("Keep [optional] words and [nested [words]] here.",
             "Keep [optional] words and [nested [words]] here."),
            ("Keep xhttps://example.com and mywww.example.com.",
             "Keep xhttps://example.com and mywww.example.com."),
        ]:
            with self.subTest(text=text):
                self.assertEqual(' '.join(self.cleaned(text).split()), expected)

    async def test_reply_cleanup_finishes_malformed_or_empty_output(self):
        recognizer = speech.SpokenReplyText()
        address_notice = "This reply contains a web address, which I won't read aloud."
        empty_notice = "There is no speakable text in this reply. Please ask me to rephrase."
        for text, expected in [
            ("Before. `Hidden. More.", "Before. There is code in this reply."),
            ("Before.\n```python\nHidden. More.", "Before. There is code in this reply."),
            ("[the guide](https://example.com/unfinished", "the guide"),
            ("Keep [ordinary words", "Keep [ordinary words"),
            ("Keep [safe `secret()` words", "Keep [safe words There is code in this reply."),
            ("https://example.com/only", address_notice),
            ("<https://example.com/private>", address_notice),
            ("(www.example.com/only).", address_notice),
            ("`print(1)`", "There is code in this reply."),
            ("```python\nprint(1)\n```", "There is code in this reply."),
            ("**", empty_notice),
            ("# ** **", empty_notice),
            ("", empty_notice),
        ]:
            with self.subTest(text=text):
                recognizer.start()
                result = ''.join(recognizer.feed(char) for char in text) + recognizer.finish()
                self.assertEqual(' '.join(result.split()), expected)
                self.assertEqual(recognizer.finish(), '')
                recognizer.start()
                self.assertEqual(recognizer.feed('Fresh plain reply.') + recognizer.finish(), 'Fresh plain reply.')
        recognizer.start()
        self.assertEqual(recognizer.feed('[' + 'x' * (1024 * 1024 - 3) + ' h'), '')
        self.assertEqual(recognizer.feed('x] leaked tail.'), '')
        self.assertEqual(recognizer.finish().strip(),
                         "I couldn't safely prepare this reply for speech. Please ask me to rephrase.")
        recognizer.start()
        self.assertEqual(recognizer.feed('Fresh plain reply.') + recognizer.finish(), 'Fresh plain reply.')
        undecidable_row = '|' + '-' * (1024 * 1024)
        recognizer.start()
        self.assertEqual(recognizer.feed(undecidable_row), '')
        self.assertEqual(recognizer.feed('\nleaked tail.'), '')
        self.assertEqual(recognizer.finish().strip(),
                         "I couldn't safely prepare this reply for speech. Please ask me to rephrase.")
        recognizer.start()
        self.assertEqual(recognizer.feed(undecidable_row), '')
        self.assertEqual(recognizer.feed('\nleaked tail.'), '')
        self.assertEqual(recognizer.finish(failed=True).strip(), '')
        recognizer.start()
        self.assertEqual((recognizer.feed('- Item') + recognizer.finish()).strip(), 'Item.')
        recognizer.start()
        self.assertEqual((recognizer.feed('    print(1)') + recognizer.finish()).strip(),
                         'There is code in this reply.')
        for text in ('**', 'https://example.com/only', '[' + 'x' * (1024 * 1024)):
            recognizer.start()
            recognizer.feed(text)
            self.assertEqual(recognizer.finish(failed=True).strip(), '')

    async def test_reply_cleanup_resets_on_interrupt_and_shutdown(self):
        async def open_voice():
            observed = asyncio.Queue()
            synthesized, heard = [], []
            started = asyncio.Event()

            class Sink(FrameProcessor):
                async def process_frame(self, frame, direction):
                    await super().process_frame(frame, direction)
                    if isinstance(frame, StartFrame):
                        started.set()
                    elif isinstance(frame, TTSTextFrame):
                        heard.append(frame.text)
                    elif isinstance(frame, (DataFrame, InterruptionFrame)):
                        observed.put_nowait(frame)
                    await self.push_frame(frame, direction)

            def chunks(text, **kwargs):
                synthesized.append(text)
                yield np.zeros(4800, dtype=np.float32)

            worker = PipelineWorker(
                Pipeline([VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET), Sink()]),
                enable_rtvi=False, idle_timeout_secs=None,
            )
            runner = WorkerRunner(handle_sigint=False)
            running = None

            async def close():
                if running is not None and not running.done():
                    await worker.cancel()
                    await running

            self.addAsyncCleanup(close)
            await runner.add_workers(worker)
            running = asyncio.create_task(runner.run())
            await asyncio.wait_for(started.wait(), 5)

            async def send(frames):
                barrier = DataFrame()
                await worker.queue_frames([*frames, barrier])
                while await asyncio.wait_for(observed.get(), 5) is not barrier:
                    pass

            return worker, running, observed, synthesized, heard, send

        worker, running, observed, synthesized, heard, send = await open_voice()
        await send([LLMFullResponseStartFrame(), LLMTextFrame('`Hidden. More.')])
        await worker.queue_frame(InterruptionFrame())
        while not isinstance(await asyncio.wait_for(observed.get(), 5), InterruptionFrame):
            pass
        await send([LLMFullResponseEndFrame()])
        self.assertEqual(synthesized, [])
        self.assertEqual(heard, [])
        await send([LLMFullResponseStartFrame(), LLMTextFrame('Fresh reply.'), LLMFullResponseEndFrame()])
        self.assertEqual(synthesized, ['Fresh reply.'])
        self.assertEqual(heard, ['Fresh reply.'])
        await worker.queue_frame(EndFrame())
        await running

        for terminal in (CancelFrame, EndFrame):
            with self.subTest(terminal=terminal.__name__):
                worker, running, _, synthesized, heard, send = await open_voice()
                await send([LLMFullResponseStartFrame(), LLMTextFrame('[partial `Hidden. More.')])
                await worker.queue_frame(terminal())
                await running
                self.assertEqual(synthesized, [])
                self.assertEqual(heard, [])
                fresh, fresh_running, _, fresh_synthesis, fresh_heard, fresh_send = await open_voice()
                await fresh_send([LLMFullResponseStartFrame(), LLMTextFrame('New service.'), LLMFullResponseEndFrame()])
                self.assertEqual(fresh_synthesis, ['New service.'])
                self.assertEqual(fresh_heard, ['New service.'])
                await fresh.queue_frame(EndFrame())
                await fresh_running

    async def test_sentences_and_service_lifetimes_keep_the_same_voice_reference(self):
        model = Mock(generate_streaming=Mock(side_effect=lambda **kwargs: iter_chunks()))

        def iter_chunks():
            yield np.zeros(4800, dtype=np.float32)

        first_session = VoxCPMTTS(model, TEST_PRESET)
        second_session = VoxCPMTTS(model, TEST_PRESET)
        await open_section(first_session, 'expressive', reply_record(delivery='gently_pleased'))
        for service, text, context_id in [
            (first_session, "Hello.", "expressive"), (first_session, "How are you?", "expressive"),
            (first_session, "Here is another reply.", "turn"), (second_session, "Welcome back.", "turn"),
        ]:
            frames = [frame async for frame in service.run_tts(text, context_id)]
            self.assertEqual(len(frames), 1)
        self.assertEqual(model.generate_streaming.call_count, 4)
        for index, call in enumerate(model.generate_streaming.call_args_list):
            self.assertEqual(call.kwargs["reference_wav_path"], str(TEST_PRESET.reference))
            if index < 2:
                self.assertNotIn('prompt_wav_path', call.kwargs)
                self.assertNotIn('prompt_text', call.kwargs)
                self.assertTrue(call.kwargs['text'].startswith(
                    '(Gently pleased, with a subtle smile in the voice) '))
            else:
                self.assertEqual(call.kwargs["prompt_wav_path"], str(TEST_PRESET.reference))
                self.assertEqual(call.kwargs["prompt_text"], TEST_PRESET.transcript)

    async def test_numeric_reply_is_spoken_as_words_and_heard_as_written(self):
        started = asyncio.Event()
        finished = asyncio.Event()
        frames = []

        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                frames.append(frame)
                if isinstance(frame, StartFrame):
                    started.set()
                if isinstance(frame, LLMFullResponseEndFrame):
                    finished.set()
                await self.push_frame(frame, direction)

        def chunks(**kwargs):
            yield np.zeros(4800, dtype=np.float32)

        model = Mock(generate_streaming=Mock(side_effect=chunks))
        voice = VoxCPMTTS(model, TEST_PRESET)
        worker = PipelineWorker(
            Pipeline([voice, Sink()]),
            enable_rtvi=False, idle_timeout_secs=None,
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(started.wait(), 5)
            start = LLMFullResponseStartFrame()
            start.reply_progress = reply_record()
            await worker.queue_frames([
                start, LLMTextFrame('The answer is 18.'),
                LLMFullResponseEndFrame(),
            ])
            await asyncio.wait_for(finished.wait(), 5)
            self.assertEqual([call.kwargs['text'] for call in model.generate_streaming.call_args_list],
                             ['The answer is eighteen.'])
            self.assertEqual([frame.text for frame in frames if isinstance(frame, TTSTextFrame)],
                             ['The answer is 18.'])
            audio = next(frame for frame in frames if isinstance(frame, TTSAudioRawFrame) and frame.audio)
            self.assertEqual(start.reply_progress.text_started_by(audio), 'The answer is 18.')
            await worker.queue_frame(EndFrame())
            await running
        finally:
            if not running.done():
                await worker.cancel()
                await running

    async def test_numeric_forms_keep_their_meaning_in_speech(self):
        def chunks(**kwargs):
            yield np.zeros(4800, dtype=np.float32)

        model = Mock(generate_streaming=Mock(side_effect=chunks))
        voice = VoxCPMTTS(model, TEST_PRESET)
        for text, expected in [
            ('Version 2.0.3 ships.', 'Version 2.0.3 ships.'),
            ('Pay 1,5 now.', 'Pay 1,5 now.'),
            ("Pay 1'000 now.", "Pay 1'000 now."),
            ('Time 1:2:3 now.', 'Time 1:2:3 now.'),
            ('Then ...18 left.', 'Then ...18 left.'),
            ('PIN 0042 now.', 'PIN 0042 now.'),
            ('PIN 0,042 now.', 'PIN 0,042 now.'),
            ('Agent 007.', 'Agent 007.'),
            ('No. The answer is 18.', 'No. The answer is eighteen.'),
            ('Ms. Lee has 18.', 'Ms. Lee has eighteen.'),
            ('He said "18".', 'He said "eighteen".'),
            ('He said "yes".', 'He said "yes".'),
            ('It is 18  now.', 'It is eighteen  now.'),
            ('The 1990s ran 24/7.', 'The 1990s ran 24/7.'),
            ('ID-18 and v2.0 stay.', 'ID-18 and v2.0 stay.'),
            ('It costs 1,000 or 12,000.', 'It costs one thousand or twelve thousand.'),
            ('It rose 35%.', 'It rose thirty-five percent.'),
            ('It is 3.5 now.', 'It is three point five now.'),
            ('It fell to -18.', 'It fell to minus eighteen.'),
            ('Eighteen already.', 'Eighteen already.'),
            ('Version `18` ships.', 'Version `eighteen` ships.'),
        ]:
            with self.subTest(text=text):
                frames = [frame async for frame in voice.run_tts(text, 'turn')]
                self.assertEqual(model.generate_streaming.call_args.kwargs['text'], expected)
                self.assertEqual(len(frames), 1)
        await open_section(voice, 'expressive', reply_record(delivery='gently_pleased'))
        frames = [frame async for frame in voice.run_tts('The answer is 18.', 'expressive')]
        self.assertEqual(model.generate_streaming.call_args.kwargs['text'],
                         '(Gently pleased, with a subtle smile in the voice) The answer is eighteen.')
        self.assertEqual(len(frames), 1)

    async def test_number_reading_failure_speaks_written_form_without_refusal(self):
        corrupt = NormalizationResult(
            input_text='18.', output_text='nineteen.', mappings=(NormalizationMapping(
                kind='replace', token_type='cardinal', input_start=0, input_end=2,
                output_start=0, output_end=8, input_text='19', output_text='nineteen'),))
        for fault, text in [('native failure', 'Your #1 pick.'), ('corrupt mapping', 'The answer is 18.')]:
            with self.subTest(fault=fault):
                def chunks(**kwargs):
                    yield np.zeros(4800, dtype=np.float32)

                model = Mock(generate_streaming=Mock(side_effect=chunks))
                voice = VoxCPMTTS(model, TEST_PRESET)
                warnings = []
                sink = logger.add(lambda message: warnings.append(message.record['message']), level='WARNING')
                try:
                    boundary = patch('wetext.Normalizer.normalize_with_mapping', return_value=corrupt) if fault == 'corrupt mapping' else nullcontext()
                    with boundary:
                        frames = [frame async for frame in voice.run_tts(text, 'turn')]
                    self.assertEqual(len(frames), 1)
                    self.assertEqual(model.generate_streaming.call_count, 1)
                    self.assertEqual(model.generate_streaming.call_args.kwargs['text'], text)
                    self.assertFalse(voice.generation_cleanup_failed)
                    self.assertEqual(warnings, ['Number reading unavailable; speaking the written form.'])
                    frames = [frame async for frame in voice.run_tts('Another 18.', 'turn')]
                    self.assertEqual(len(frames), 1)
                    self.assertEqual(model.generate_streaming.call_count, 2)
                    self.assertEqual(model.generate_streaming.call_args.kwargs['text'], 'Another eighteen.')
                    self.assertFalse(voice.generation_cleanup_failed)
                    self.assertEqual(warnings, ['Number reading unavailable; speaking the written form.'])
                finally:
                    logger.remove(sink)

    async def test_model_creation_failure_preserves_error_and_refuses_further_speech(self):
        failure = RuntimeError('Model creation failed before generator creation')
        model = Mock(generate_streaming=Mock(side_effect=failure))
        voice = VoxCPMTTS(model, TEST_PRESET)
        with self.assertRaises(RuntimeError) as observed:
            _ = [frame async for frame in voice.run_tts('The answer is 18.', 'turn')]
        self.assertIs(observed.exception, failure)
        self.assertEqual(model.generate_streaming.call_count, 1)
        self.assertTrue(voice.generation_cleanup_failed)
        with self.assertRaisesRegex(RuntimeError, 'Voice generation cleanup failed'):
            _ = [frame async for frame in voice.run_tts('Another reply.', 'turn')]
        self.assertEqual(model.generate_streaming.call_count, 1)

    async def test_two_sentences_finish_before_the_response_ends(self):
        started = asyncio.Event()
        finished = asyncio.Event()
        frames = []
        early_starts = []

        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                frames.append(frame)
                if isinstance(frame, TTSAudioRawFrame) and frame.audio:
                    context = next(f.reply_progress.section_of(f) for f in frames if isinstance(f, TTSStartedFrame))
                    early_starts.append(list(context.pending_text_starts))
                if isinstance(frame, StartFrame):
                    started.set()
                if isinstance(frame, LLMFullResponseEndFrame):
                    finished.set()
                await self.push_frame(frame, direction)

        def chunks(**kwargs):
            if kwargs['text'] != 'No audio.':
                yield np.zeros(0, dtype=np.float32)
                yield np.zeros(4800 if kwargs['text'] == 'Hello.' else 1500, dtype=np.float32)

        voice = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        worker = PipelineWorker(
            Pipeline([voice, Sink()]),
            enable_rtvi=False, idle_timeout_secs=None,
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(started.wait(), 5)
            start = LLMFullResponseStartFrame()
            token = object()
            record = reply_record(token)
            start.reply_progress = record
            await worker.queue_frames([
                start, LLMTextFrame("Hello. "),
                LLMTextFrame("I am listening."), LLMFullResponseEndFrame(),
            ])
            await asyncio.wait_for(finished.wait(), 5)
            spoken = [f.text for f in frames if isinstance(f, TTSTextFrame)]
            self.assertEqual(spoken, ["Hello.", "I am listening."])
            audio = [f for f in frames if isinstance(f, TTSAudioRawFrame)]
            self.assertEqual(len(audio), 4)
            self.assertEqual([record.text_started_by(f) for f in audio],
                             [None, 'Hello.', None, 'I am listening.'])
            self.assertIn((0, 'Hello.'), early_starts[0])
            self.assertIn((9600, 'I am listening.'), early_starts[1])
            self.assertEqual(sum(isinstance(f, TTSStoppedFrame) for f in frames), 1)
            end = next(i for i, f in enumerate(frames) if isinstance(f, LLMFullResponseEndFrame))
            self.assertTrue(all(i < end for i, f in enumerate(frames) if isinstance(f, TTSTextFrame)))
            texts = [f for f in frames if isinstance(f, TTSTextFrame)]
            first, second = [f.reply_progress.span_of(f) for f in texts]
            context = first[0]
            self.assertIs(context.reply.token, token)
            self.assertEqual(context.pending_text_starts, [(0, 'Hello.'), (9600, 'I am listening.')])
            self.assertIs(second[0], context)
            self.assertEqual(first[1:4], (0, 9600, True))
            self.assertEqual(second[1:4], (9600, 12600, True))
            self.assertIsNot(first, second)
            self.assertEqual(texts[0].context_id, texts[1].context_id)
            stopped = next(f for f in frames if isinstance(f, TTSStoppedFrame))
            self.assertIs(stopped.reply_progress.section_of(stopped), context)

            for unusable in (False, True):
                finished.clear()
                frames.clear()
                await voice.set_usable(not unusable)
                start = LLMFullResponseStartFrame()
                start.reply_progress = record
                await worker.queue_frames([start, LLMTextFrame('No audio.'), LLMFullResponseEndFrame()])
                await asyncio.wait_for(finished.wait(), 5)
                text = next(f for f in frames if isinstance(f, TTSTextFrame))
                self.assertEqual(text.reply_progress.span_of(text)[1:4], (0, 0, True))
                self.assertIsNot(text.reply_progress.span_of(text)[0], context)
                self.assertEqual(text.reply_progress.span_of(text)[0].pending_text_starts, [])
                self.assertEqual(context.pending_text_starts, [(0, 'Hello.'), (9600, 'I am listening.')])
            await voice.set_usable(True)

            await voice.on_turn_context_created('malformed')
            for audio, rate, channels in ((b'\x01\x00', 44100, 1), (b'\x01\x00', 48000, 2), (b'\x01', 48000, 1)):
                started_frame = TTSStartedFrame(context_id='malformed')
                await voice.push_frame(started_frame)
                frame = TTSAudioRawFrame(audio, rate, channels, context_id='malformed')
                record.starts_text(frame, 'Malformed.')
                await voice.push_frame(frame)
                self.assertEqual(started_frame.reply_progress.section_of(started_frame).pending_text_starts, [])
                text = TTSTextFrame('Malformed.', aggregated_by='sentence')
                text.context_id = 'malformed'
                await voice.push_frame(text)
                self.assertEqual(text.reply_progress.span_of(text)[1:4], (0, len(audio), False))
                self.assertIs(text.reply_progress.span_of(text)[0], started_frame.reply_progress.section_of(started_frame))
                await voice.push_frame(TTSStoppedFrame(context_id='malformed'))
                await voice.on_audio_context_completed('malformed')
            await voice.on_turn_context_created('replacement')
            await voice.create_audio_context('replacement')
            original = voice.section('replacement')
            retained = [f async for f in voice.run_tts('Replacement.', 'replacement')]
            self.assertEqual(original.pending_text_starts, [])
            replacement = record.open_section('neutral')
            tagged = next(f for f in retained if f.audio)
            record.stream_frame(tagged, replacement)
            record.stream_frame(tagged, replacement)
            self.assertEqual(replacement.pending_text_starts, [(0, 'Replacement.')])
            self.assertEqual(replacement.source_bytes, 3000)
            self.assertEqual(original.pending_text_starts, [])
            self.assertEqual(original.source_bytes, 0)
            await worker.queue_frame(EndFrame())
            await running
        finally:
            if not running.done():
                await worker.cancel()
                await running

    async def test_audio_is_clipped_pcm(self):
        def chunks(**kwargs):
            yield np.array([-2, -1, 0, 1, 2], dtype=np.float32)

        voice = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        frames = [frame async for frame in voice.run_tts("hello", "turn")]
        self.assertEqual(len(frames), 1)
        self.assertIsInstance(frames[0], TTSAudioRawFrame)
        self.assertEqual(frames[0].sample_rate, 48000)
        self.assertEqual(frames[0].num_channels, 1)
        self.assertEqual(frames[0].context_id, "turn")
        np.testing.assert_array_equal(
            np.frombuffer(frames[0].audio, dtype="<i2"), [-32767, -32767, 0, 32767, 32767]
        )

    async def test_interruption_closes_old_generator_before_next_turn(self):
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        release = threading.Event()
        events = []

        def chunks(text, **kwargs):
            if text.startswith('(Subtly curious and interested, natural conversational delivery) '):
                self.assertNotIn('prompt_text', kwargs)
                text = 'old'
            else:
                self.assertEqual(text, 'new')
                self.assertEqual(kwargs['prompt_text'], 'Fixture voice.')
            events.append((text, "start"))
            try:
                yield np.zeros(10, dtype=np.float32)
                if text == "old":
                    loop.call_soon_threadsafe(entered.set)
                    release.wait()
                events.append((text, "second"))
                yield np.zeros(10, dtype=np.float32)
                events.append((text, "third"))
                yield np.zeros(10, dtype=np.float32)
            finally:
                events.append((text, "closed"))

        model = Mock(generate_streaming=chunks)
        generation_lock = asyncio.Lock()
        voice = VoxCPMTTS(model, TEST_PRESET, generation_lock=generation_lock)
        fresh = VoxCPMTTS(model, TEST_PRESET, generation_lock=generation_lock)
        old_reply = reply_record(delivery='curious')
        await open_section(voice, 'old', old_reply)
        old_frames = []

        async def consume(adapter, text, frames):
            async for frame in adapter.run_tts(text, text):
                frames.append(frame)

        old = asyncio.create_task(consume(voice, "old", old_frames))
        try:
            await entered.wait()
            old.cancel()
            # Let cancellation reach the pending GPU call while it is still blocked.
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertFalse(old.done())
            old.cancel()
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertFalse(old.done(), 'Repeated cancellation cannot abandon the running GPU chunk')
            new_frames = []
            new = asyncio.create_task(consume(fresh, "new", new_frames))
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await old
            await new
            self.assertEqual(len(old_frames), 1)
            self.assertEqual(old_reply.text_started_by(old_frames[0]), 'old')
            self.assertNotIn(("old", "third"), events)
            self.assertLess(events.index(("old", "closed")), events.index(("new", "start")))
            self.assertEqual(len(new_frames), 3)
        finally:
            release.set()
            await asyncio.gather(old, return_exceptions=True)
        for outcome in ('cancel_close', 'next_error', 'close_error', 'both_errors', 'body_error'):
            with self.subTest(cleanup=outcome):
                next_entered, close_entered = asyncio.Event(), asyncio.Event()
                release_next, release_close = threading.Event(), threading.Event()
                self.addCleanup(release_next.set)
                self.addCleanup(release_close.set)
                activity = []

                class NativeChunks:
                    def __init__(self):
                        self.count = 0

                    def __next__(self):
                        self.count += 1
                        if self.count == 1:
                            return object() if outcome == 'body_error' else np.zeros(10, dtype=np.float32)
                        loop.call_soon_threadsafe(next_entered.set)
                        if not release_next.wait(5):
                            raise AssertionError('Native next was never released')
                        activity.append('next completed')
                        if outcome in ('next_error', 'both_errors'):
                            raise RuntimeError('native next failed')
                        raise StopIteration

                    def close(self):
                        loop.call_soon_threadsafe(close_entered.set)
                        if not release_close.wait(5):
                            raise AssertionError('Native close was never released')
                        activity.append('close completed')
                        if outcome in ('close_error', 'both_errors'):
                            raise RuntimeError('native close failed')

                def generate(text, **kwargs):
                    activity.append(('model', text))
                    if text == 'old':
                        return NativeChunks()

                    def fresh_chunks():
                        yield np.zeros(10, dtype=np.float32)

                    return fresh_chunks()

                model = Mock(generate_streaming=Mock(side_effect=generate))
                lock = asyncio.Lock()
                adapter = VoxCPMTTS(model, TEST_PRESET, generation_lock=lock)
                fresh = VoxCPMTTS(model, TEST_PRESET, generation_lock=lock)
                tasks = []
                old = asyncio.create_task(consume(adapter, 'old', []))
                tasks.append(old)
                try:
                    if outcome != 'body_error':
                        await asyncio.wait_for(next_entered.wait(), 5)
                        old.cancel()
                        for _ in range(3):
                            await asyncio.sleep(0)
                        old.cancel()
                        release_next.set()
                    await asyncio.wait_for(close_entered.wait(), 5)
                    old.cancel()
                    old.cancel()
                    for _ in range(3):
                        await asyncio.sleep(0)
                    self.assertFalse(old.done(), 'Actual native close still owns the shared model')
                    self.assertTrue(lock.locked())
                    queued = None
                    if outcome != 'body_error':
                        queued = asyncio.create_task(consume(fresh if outcome == 'cancel_close' else adapter, 'new', []))
                        tasks.append(queued)
                    release_close.set()
                    if outcome == 'cancel_close':
                        with self.assertRaises(asyncio.CancelledError):
                            await old
                        await queued
                        self.assertFalse(adapter.generation_cleanup_failed)
                        self.assertLess(activity.index('close completed'), activity.index(('model', 'new')))
                    elif outcome == 'body_error':
                        with self.assertRaises(TypeError):
                            await old
                        self.assertFalse(adapter.generation_cleanup_failed)
                    else:
                        message = 'native next failed' if outcome == 'next_error' else 'native close failed'
                        with self.assertRaisesRegex(RuntimeError, message) as failure:
                            await old
                        self.assertTrue(adapter.generation_cleanup_failed)
                        if outcome == 'both_errors':
                            self.assertRegex(str(failure.exception.__cause__ or failure.exception.__context__), 'native next failed')
                        with self.assertRaisesRegex(RuntimeError, 'generation cleanup failed'):
                            await queued
                        self.assertEqual(model.generate_streaming.call_count, 1, 'A queued call must refuse a poisoned adapter')
                    self.assertEqual(activity.count('close completed'), 1)
                    self.assertFalse(lock.locked())
                finally:
                    release_next.set()
                    release_close.set()
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)



class EchoRemovalTests(unittest.TestCase):
    def setUp(self):
        self.messages = []
        self.addCleanup(logger.remove, logger.add(self.messages.append, level="ERROR"))

    def start(self):
        """Start echo removal on doubles; return it, the process start, the watcher and the callback."""
        on_stopped = Mock()
        with patch.object(speech.subprocess, "Popen") as popen, \
                patch.object(speech.threading, "Thread") as thread:
            popen.return_value.wait.return_value = 3
            echo_removal = speech.EchoRemoval()
            echo_removal.start(on_stopped)
        return echo_removal, popen, thread, on_stopped

    def test_echo_removal_process_is_bound_to_kestrel(self):
        _, popen, _, _ = self.start()
        self.assertEqual(
            popen.call_args.args[0],
            [*speech.BOUND_TO_KESTREL, str(os.getpid()), "pipewire", "-c", "echo-removal.conf"],
        )
        self.assertEqual(popen.call_args.kwargs["env"]["PIPEWIRE_CONFIG_DIR"], str(speech.ROOT))
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertTrue((speech.ROOT / "echo-removal.conf").is_file())

    def test_a_command_bound_to_kestrel_keeps_the_parent_death_signal(self):
        result = subprocess.run(
            [*speech.BOUND_TO_KESTREL, str(os.getpid()), "setpriv", "--dump"],
            capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"},
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("Parent death signal: TERM", result.stdout)

    def test_nothing_starts_when_kestrel_is_not_the_parent(self):
        result = subprocess.run(
            [*speech.BOUND_TO_KESTREL, str(os.getppid()), "echo", "started"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_an_unexpected_stop_is_reported(self):
        _, _, thread, on_stopped = self.start()
        thread.call_args.kwargs["target"](*thread.call_args.kwargs["args"])
        on_stopped.assert_called_once_with()
        self.assertEqual(len(self.messages), 1)
        self.assertIn("Echo removal stopped (exit code 3)", self.messages[0])

    def test_closing_echo_removal_reports_nothing(self):
        echo_removal, popen, thread, on_stopped = self.start()
        echo_removal.close()
        thread.call_args.kwargs["target"](*thread.call_args.kwargs["args"])
        popen.return_value.terminate.assert_called_once_with()
        popen.return_value.kill.assert_not_called()
        on_stopped.assert_not_called()
        self.assertEqual(self.messages, [])

    def test_closing_echo_removal_kills_a_process_that_does_not_stop(self):
        echo_removal, popen, _, _ = self.start()
        popen.return_value.wait.side_effect = [subprocess.TimeoutExpired("pipewire", speech.ECHO_REMOVAL_STOP_WAIT), 0]
        echo_removal.close()
        popen.return_value.terminate.assert_called_once_with()
        popen.return_value.kill.assert_called_once_with()
        self.assertEqual(
            popen.return_value.wait.call_args_list,
            [((), {"timeout": speech.ECHO_REMOVAL_STOP_WAIT}), ((), {"timeout": speech.ECHO_REMOVAL_STOP_WAIT})],
        )

    @staticmethod
    def node(node_id, name, client_id=30, serial=900):
        return {"id": node_id, "type": "PipeWire:Interface:Node", "info": {"props": {
            "node.name": name, "client.id": client_id, "object.serial": serial,
        }}}

    @staticmethod
    def client(client_id, pid):
        return {"id": client_id, "type": "PipeWire:Interface:Client", "info": {
            "props": {"pipewire.sec.pid": pid},
        }}

    @staticmethod
    def link(output_node, input_node, state):
        return {
            "id": 100 + output_node, "type": "PipeWire:Interface:Link",
            "info": {"output-node-id": output_node, "input-node-id": input_node, "state": state},
        }

    def graph(self):
        selected = self.node(10, 'selected-output', 30, 910)
        selected['info']['props']['media.class'] = 'Audio/Sink'
        return [self.client(30, 3100), self.client(31, 3200),
                self.node(8, "kestrel-microphone", 30, 900),
                self.node(9, "kestrel-capture", 31, 901), self.link(8, 9, "active"),
                {'id': 50, 'type': 'PipeWire:Interface:Metadata', 'props': {'metadata.name': 'default'},
                 'metadata': [{'subject': 0, 'key': 'default.audio.sink', 'type': 'Spa:String:JSON',
                               'value': {'name': 'selected-output'}}]},
                selected, self.node(11, 'kestrel-echo-removal-reference'), self.link(10, 11, 'active')]

    @contextmanager
    def graph_output(self, graph):
        payload = graph if isinstance(graph, bytes) else json.dumps(graph).encode()
        processes = []

        async def spawn(*args, **kwargs):
            process = Mock(stdout=Mock(read=AsyncMock(side_effect=[payload, b'']), _transport=Mock()),
                           returncode=0, wait=AsyncMock(return_value=0))
            processes.append(process)
            return process

        with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(side_effect=spawn)) as native:
            try:
                yield
            finally:
                self.assertTrue(processes)
                for call in native.await_args_list:
                    self.assertEqual(call.args, ('pw-dump',))
                    self.assertEqual(call.kwargs, {'stdout': asyncio.subprocess.PIPE, 'stderr': asyncio.subprocess.DEVNULL})
                for process in processes:
                    process.stdout._transport.close.assert_called_once_with()
                    self.assertGreater(process.wait.await_count, 0)

    def serial(self, graph, capture_pid=3200):
        echo = speech.EchoRemoval()
        echo.process = Mock(pid=3100)
        echo.process.poll.return_value = None
        with self.graph_output(graph):
            return asyncio.run(echo.microphone_serial(capture_pid))

    def test_selected_output_notifications_preserve_roundtrip_and_refuse_corruption(self):
        async def check():
            native_spawn = asyncio.create_subprocess_exec
            baseline = {'id': 32, 'type': 'PipeWire:Interface:Metadata', 'props': {'metadata.name': 'default'},
                        'metadata': [{'subject': 0, 'key': 'default.audio.sink', 'type': 'Spa:String:JSON',
                                      'value': {'name': 'A'}}]}
            updates = [dict(baseline, metadata=[{'subject': 0, 'key': 'default.audio.sink',
                                                'type': 'Spa:String:JSON', 'value': {'name': name}}])
                       for name in ('B', 'A')]
            updates.append(dict(baseline, metadata=[]))
            tombstone = {'id': 32, 'info': None}
            selected_node = self.node(10, 'A', 30, 910)
            selected_node['info']['props']['media.class'] = 'Audio/Sink'
            selection_graph = [baseline, selected_node]
            graph_children = []

            async def graph_process():
                process = Mock(returncode=0, stdout=Mock(
                    read=AsyncMock(side_effect=[json.dumps(selection_graph).encode(), b'']), _transport=Mock()),
                    wait=AsyncMock(return_value=0))
                graph_children.append(process)
                return process

            # Native source replacement, per-node targeting and deletion-shaped updates
            # do not mean that the selected output changed.
            churn = [dict(baseline, metadata=[{'subject': 0, 'key': 'default.audio.source',
                                             'type': 'Spa:String:JSON', 'value': {'name': name}}])
                     for name in ('kestrel-microphone', 'physical-source', 'kestrel-microphone')]
            churn += [dict(baseline, metadata=[{'subject': 98, 'key': 'target.object',
                                               'type': 'Spa:Id', 'value': 10}]),
                      dict(baseline, metadata=[])]
            consumed = asyncio.Event()
            lines = [json.dumps([record]).encode() + b'\n' for record in [baseline, *churn]]

            async def line():
                if lines:
                    return lines.pop(0)
                consumed.set()
                await asyncio.Event().wait()

            monitor = Mock(returncode=None, stdout=Mock(readline=AsyncMock(side_effect=line), _transport=Mock()),
                           wait=AsyncMock(return_value=0))
            changes, failure = Mock(), Mock()

            async def spawn_churn(*command, **kwargs):
                if command == ('pw-dump',):
                    return await graph_process()
                return monitor

            with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn_churn):
                watch = speech.OutputDeviceWatch()
                try:
                    await watch.start(changes, failure)
                    await asyncio.wait_for(consumed.wait(), 5)
                    changes.assert_not_called()
                    self.assertEqual(watch.revision, 1)
                    failure.assert_not_called()
                finally:
                    await watch.close()
            failure.assert_not_called()
            graph_a = selection_graph
            unresolved_entry = [dict(baseline, metadata=[]), selected_node]
            unresolved_node = [baseline]
            node_b = self.node(11, 'B', 30, 911)
            node_b['info']['props']['media.class'] = 'Audio/Sink'
            graph_b = [updates[0], node_b]
            ambiguous_node = self.node(11, 'A', 30, 911)
            ambiguous_node['info']['props']['media.class'] = 'Audio/Sink'
            for case in ('hidden_change', 'unresolved', 'startup_unresolved', 'explicit_unresolved',
                         'ambiguous_selection', 'snapshot_identity', 'snapshot_identity_startup'):
                with self.subTest(selection=case):
                    if case == 'hidden_change':
                        frames = [(baseline, graph_a), (updates[-1], graph_b)]
                        expected = [2]
                    elif case == 'unresolved':
                        frames = [(baseline, graph_a), (churn[0], unresolved_entry),
                                  (updates[-1], unresolved_node), (churn[1], unresolved_entry), (churn[-2], graph_a)]
                        expected = [2, 3]
                    elif case == 'startup_unresolved':
                        frames = [(baseline, unresolved_entry), (churn[0], graph_a)]
                        expected = [1, 2]
                    elif case == 'explicit_unresolved':
                        frames = [(baseline, graph_a), (churn[0], unresolved_entry),
                                  (updates[0], unresolved_entry), (updates[1], unresolved_entry), (updates[-1], graph_a)]
                        expected = [2, 3, 4, 5]
                    elif case == 'ambiguous_selection':
                        frames = [(baseline, graph_a), (churn[0], [baseline, selected_node, ambiguous_node]),
                                  (churn[-2], graph_a)]
                        expected = [2, 3]
                    else:
                        foreign_graph = [dict(baseline, id=33), selected_node]
                        frames = ([(baseline, foreign_graph)] if case == 'snapshot_identity_startup'
                                  else [(baseline, graph_a), (updates[-1], foreign_graph)])
                        expected = []
                    completed = asyncio.Event()
                    seen, failed = [], Mock(side_effect=completed.set)

                    async def next_record():
                        nonlocal selection_graph
                        if frames:
                            record, selection_graph = frames.pop(0)
                            return json.dumps([record]).encode() + b'\n'
                        completed.set()
                        await asyncio.Event().wait()

                    monitor = Mock(returncode=None, stdout=Mock(readline=AsyncMock(side_effect=next_record),
                                   _transport=Mock()), wait=AsyncMock(return_value=0))
                    watch = speech.OutputDeviceWatch()
                    with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn_churn):
                        try:
                            if case == 'snapshot_identity_startup':
                                with self.assertRaisesRegex(RuntimeError, speech.OUTPUT_WATCH_FAILURE):
                                    await watch.start(lambda: seen.append(watch.revision), failed)
                            else:
                                await watch.start(lambda: seen.append(watch.revision), failed)
                                await asyncio.wait_for(completed.wait(), 5)
                            if case == 'snapshot_identity':
                                failed.assert_called_once_with()
                            else:
                                failed.assert_not_called()
                            self.assertEqual(seen, expected)
                        finally:
                            await watch.close()
            selection_graph = graph_a

            notice, checking, release_snapshot = asyncio.Event(), asyncio.Event(), asyncio.Event()
            consumed = asyncio.Event()
            lines = [json.dumps([record]).encode() + b'\n' for record in (baseline, updates[0])]
            monitor = Mock(returncode=None, stdout=Mock(readline=AsyncMock(side_effect=line), _transport=Mock()),
                           wait=AsyncMock(return_value=0))
            query_count = 0

            async def spawn_held_snapshot(*command, **kwargs):
                nonlocal query_count
                if command == ('pw-dump',):
                    query_count += 1
                    if query_count == 2:
                        checking.set()
                        await release_snapshot.wait()
                    return await graph_process()
                return monitor

            watch = speech.OutputDeviceWatch()
            with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn_held_snapshot):
                try:
                    await watch.start(notice.set, self.fail)
                    await asyncio.wait_for(checking.wait(), 5)
                    self.assertTrue(notice.is_set(), 'Explicit sink notice must close admission before awaited graph work')
                    self.assertEqual(watch.revision, 2)
                    release_snapshot.set()
                    await asyncio.wait_for(consumed.wait(), 5)
                finally:
                    release_snapshot.set()
                    await watch.close()
            for startup in (False, True):
                for entry in (None, {'subject': True, 'key': 'default.audio.source'},
                              {'subject': -1, 'key': 'target.object'}, {'subject': 0, 'key': 5}):
                    with self.subTest(startup_entry=startup, invalid_entry=entry):
                        malformed = dict(baseline, metadata=[entry])
                        consumed = asyncio.Event()
                        lines = [json.dumps([record]).encode() + b'\n'
                                 for record in ([malformed] if startup else [baseline, malformed])]
                        monitor = Mock(returncode=None, stdout=Mock(readline=AsyncMock(side_effect=line),
                                       _transport=Mock()), wait=AsyncMock(return_value=0))
                        failed_event = asyncio.Event()
                        changes, failed = Mock(), Mock(side_effect=failed_event.set)
                        watch = speech.OutputDeviceWatch()
                        with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn_churn):
                            try:
                                if startup:
                                    with self.assertRaisesRegex(RuntimeError, speech.OUTPUT_WATCH_FAILURE):
                                        await watch.start(changes, failed)
                                else:
                                    await watch.start(changes, failed)
                                    await asyncio.wait_for(failed_event.wait(), 5)
                                    failed.assert_called_once_with()
                                changes.assert_not_called()
                            finally:
                                await watch.close()
            for owned in (False, True):
                with self.subTest(snapshot_cleanup_owned=owned):
                    entered, release_cleanup, failed_event = asyncio.Event(), asyncio.Event(), asyncio.Event()
                    consumed = asyncio.Event()
                    lines = [json.dumps([record]).encode() + b'\n' for record in (baseline, updates[-1])]
                    monitor = Mock(returncode=None, stdout=Mock(readline=AsyncMock(side_effect=line),
                                   _transport=Mock()), wait=AsyncMock(return_value=0))
                    failed_query = Mock(returncode=None, stdout=Mock(
                        read=AsyncMock(side_effect=OSError('Controlled snapshot read failure')), _transport=Mock()))

                    async def failed_wait():
                        if failed_query.wait.await_count == 1:
                            entered.set()
                            await release_cleanup.wait()
                        raise TimeoutError

                    failed_query.wait = AsyncMock(side_effect=failed_wait)
                    query_count = 0

                    async def spawn_cleanup(*command, **kwargs):
                        nonlocal query_count
                        if command == ('pw-dump',):
                            query_count += 1
                            return await graph_process() if query_count == 1 else failed_query
                        return monitor

                    watch = speech.OutputDeviceWatch()
                    changes, failed = Mock(), Mock(side_effect=failed_event.set)
                    closing = None
                    with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn_cleanup):
                        try:
                            await watch.start(changes, failed)
                            await asyncio.wait_for(entered.wait(), 5)
                            if owned:
                                closing = asyncio.create_task(watch.close())
                                # close retains its own task, which requests cancellation of the reader.
                                await asyncio.sleep(0)
                                await asyncio.sleep(0)
                                self.assertGreater(watch.reader.cancelling(), 0)
                            release_cleanup.set()
                            if not owned:
                                await asyncio.wait_for(failed_event.wait(), 5)
                            with self.assertRaisesRegex(speech.PipeWireGraphCleanupFailure, speech.OUTPUT_SWITCH_FAILURE):
                                await closing if closing is not None else await watch.close()
                            self.assertEqual(query_count, 2)
                            self.assertEqual(failed.call_count, 0 if owned else 1)
                            changes.assert_not_called()
                            failed_query.terminate.assert_called_once_with()
                            failed_query.kill.assert_called_once_with()
                            self.assertEqual(failed_query.wait.await_count, 2)
                            monitor.terminate.assert_called_once_with()
                            monitor.wait.assert_awaited_once()
                        finally:
                            release_cleanup.set()
                            if closing is not None:
                                await asyncio.gather(closing, return_exceptions=True)
                            elif not watch.closed:
                                await watch.close()
            for malformed in (False, True):
                seen, failed = asyncio.Queue(), asyncio.Event()
                watch = speech.OutputDeviceWatch()
                failed_callback = Mock(side_effect=failed.set)

                async def spawn(*command, **kwargs):
                    self.assertEqual(kwargs['stderr'], asyncio.subprocess.DEVNULL)
                    if command == ('pw-dump',):
                        return await graph_process()
                    if 'pw-metadata' in command:
                        # The old native monitor cannot announce registry removal.
                        wire = 'Found "default" metadata 32\n' + ''.join(
                            "update: id:0 key:'default.audio.sink' value:'" + value + "' type:'Spa:String:JSON'\n"
                            for value in ('A', 'B', 'A'))
                    else:
                        self.assertEqual(command, (*speech.BOUND_TO_KESTREL, str(os.getpid()), 'stdbuf', '-oL',
                                                  'pw-dump', '-m', '-N', '-R', 'default'))
                        records = [[baseline], [1]] if malformed else [[baseline], *[[item] for item in updates], [tombstone]]
                        wire = ''.join(json.dumps(record) + '\n' for record in records)
                    return await native_spawn(sys.executable, '-u', '-c',
                        'import sys,signal;sys.stdout.write(' + repr(wire) + ');sys.stdout.flush();signal.pause()',
                        **kwargs)

                with patch.object(speech.asyncio, 'create_subprocess_exec', side_effect=spawn):
                    try:
                        await watch.start(lambda: seen.put_nowait(watch.revision), failed_callback)
                        await asyncio.wait_for(failed.wait(), 5)
                        self.assertIsNone(watch.process.returncode, 'Metadata loss must fail while the monitor stays alive')
                        failed_callback.assert_called_once_with()
                        if malformed:
                            self.assertEqual(watch.revision, 1)
                            self.assertTrue(seen.empty())
                        else:
                            self.assertEqual([seen.get_nowait() for _ in updates[:2]], [2, 3])
                            self.assertTrue(seen.empty())
                    finally:
                        await watch.close()
                failed_callback.assert_called_once_with()
                self.assertIsNotNone(watch.process.returncode)
                self.assertTrue(watch.reader.done())

            nested = b'[' * 4095 + b'0' + b']' * 4095 + b'\n'
            records = (b'', b'partial', b'x' * 8193 + b'\n', b'private\x00data\n', b'[1]\n', nested,
                       json.dumps([tombstone]).encode() + b'\n' + json.dumps([dict(baseline, id=33)]).encode() + b'\n',
                       json.dumps([dict(baseline, id=33)]).encode() + b'\n',
                       json.dumps([baseline, baseline]).encode() + b'\n')
            for record in records:
                watch = speech.OutputDeviceWatch()
                watch.metadata_id = 32
                watch.revision = 1
                watch.process = Mock(stdout=asyncio.StreamReader(), returncode=None, wait=AsyncMock(return_value=0))
                watch.process.stdout.feed_data(record)
                live_record = record in (b'[1]\n', nested)
                if not live_record:
                    watch.process.stdout.feed_eof()
                failure_seen = asyncio.Event()
                failed = Mock(side_effect=failure_seen.set)
                watch.reader = asyncio.create_task(watch._watch(lambda: self.fail('Corrupt record admitted'), failed))
                try:
                    await asyncio.wait_for(failure_seen.wait(), 5)
                    failed.assert_called_once_with()
                    if live_record:
                        self.assertIsNone(watch.process.returncode)
                        self.assertFalse(watch.process.stdout.at_eof())
                finally:
                    await watch.close()
                failed.assert_called_once_with()

            for owned in (False, True):
                watch = speech.OutputDeviceWatch()
                watch.metadata_id = 32
                watch.process = Mock(stdout=asyncio.StreamReader(), returncode=None, wait=AsyncMock(return_value=0))
                reading = asyncio.Event()
                native_read = watch.process.stdout.readline

                async def read():
                    reading.set()
                    return await native_read()

                watch.process.stdout.readline = read
                failed = Mock()
                watch.reader = asyncio.create_task(watch._watch(Mock(), failed))
                await asyncio.wait_for(reading.wait(), 5)
                if not owned:
                    watch.reader.cancel()
                    await asyncio.gather(watch.reader, return_exceptions=True)
                    failed.assert_called_once_with()
                await watch.close()
                self.assertEqual(failed.call_count, 0 if owned else 1)

            for record in (b'[1]\n', nested):
                process = Mock(stdout=asyncio.StreamReader(), returncode=None, wait=AsyncMock(return_value=0))
                process.stdout.feed_data(record)
                with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)):
                    watch = speech.OutputDeviceWatch()
                    with self.assertRaisesRegex(RuntimeError, 'Audio output monitoring failed. Restart Kestrel.'):
                        await watch.start(Mock(), Mock())
                process.terminate.assert_called_once_with()
                process.wait.assert_awaited_once()

            watch = speech.OutputDeviceWatch()
            watch.process = Mock(stdout=Mock(_transport=Mock()), returncode=None,
                                 wait=AsyncMock(side_effect=TimeoutError))
            with self.assertRaisesRegex(RuntimeError, 'Audio output monitoring failed. Restart Kestrel.'):
                await watch.close()
            watch.process.kill.assert_called_once_with()

            graph = self.graph()
            echo = speech.EchoRemoval()
            echo.process = Mock(pid=3100, poll=Mock(return_value=None))
            with self.graph_output(graph):
                self.assertEqual(await echo.output_serial(), 910)
                self.assertEqual(await echo.microphone_serial(3200, output_serial=910), 900)
            # Normal startup has no saved output serial, but still proves the live reference.
            with self.graph_output(graph):
                self.assertEqual(await echo.microphone_serial(3200), 900)
            for case in ('foreign_source_owner', 'foreign_reference_owner', 'missing_reference', 'wrong_current_reference'):
                with self.subTest(current_reference=case):
                    broken = json.loads(json.dumps(graph))
                    if case in ('foreign_source_owner', 'foreign_reference_owner'):
                        broken.append(self.client(33, 3300))
                        node = broken[2] if case == 'foreign_source_owner' else broken[-3]
                        node['info']['props']['client.id'] = 33
                    elif case == 'missing_reference':
                        broken.pop(-2)
                    else:
                        broken[-1]['info']['output-node-id'] = 8
                    with self.graph_output(broken):
                        with self.assertRaisesRegex(RuntimeError, 'owned echo-removed microphone could not be verified'):
                            await echo.microphone_serial(3200)
            # Before the recorder exists a passive reference need not be active.
            with self.graph_output(self.graph()[:5]):
                self.assertEqual(await echo.microphone_serial(), 900)
            for unresolved in ('missing_entry', 'missing_node', 'ambiguous_node'):
                with self.subTest(unresolved_consumer=unresolved):
                    broken = json.loads(json.dumps(graph))
                    if unresolved == 'missing_entry':
                        broken[5]['metadata'] = []
                    elif unresolved == 'missing_node':
                        broken.pop(6)
                    else:
                        duplicate = self.node(12, 'selected-output', 30, 911)
                        duplicate['info']['props']['media.class'] = 'Audio/Sink'
                        broken.append(duplicate)
                    with self.graph_output(broken):
                        with self.assertRaisesRegex(RuntimeError, speech.OUTPUT_SWITCH_FAILURE):
                            await echo.output_serial()
                        with self.assertRaisesRegex(RuntimeError, 'owned echo-removed microphone could not be verified'):
                            await echo.microphone_serial(3200)
            playback_graph = graph + [self.client(32, 3300), self.node(1, 'owned-playback', 32, 912), self.link(1, 10, 'active')]
            with self.graph_output(playback_graph):
                self.assertEqual(await echo.output_serial(3300), 910)
            for case in ('missing_playback_link', 'foreign_target', 'paused_playback', 'boolean_output_id'):
                with self.subTest(case=case):
                    broken = json.loads(json.dumps(playback_graph))
                    if case == 'missing_playback_link':
                        broken.pop()
                    elif case == 'foreign_target':
                        broken[-1]['info']['input-node-id'] = 9
                    elif case == 'paused_playback':
                        broken[-1]['info']['state'] = 'paused'
                    else:
                        broken[-1]['info']['output-node-id'] = True
                    with self.graph_output(broken):
                        with self.assertRaisesRegex(RuntimeError, 'Restart Kestrel'):
                            await echo.output_serial(3300)
            for case in ('missing_metadata', 'duplicate_metadata', 'blank_name', 'control_name', 'boolean_subject',
                         'boolean_serial', 'string_serial', 'extra_reference_link', 'paused_reference', 'foreign_reference'):
                with self.subTest(case=case):
                    broken = json.loads(json.dumps(graph))
                    if case == 'missing_metadata':
                        broken.pop(5)
                    elif case == 'duplicate_metadata':
                        duplicate = json.loads(json.dumps(broken[5]))
                        duplicate['id'] = 51
                        broken.append(duplicate)
                    elif case in ('blank_name', 'control_name'):
                        broken[5]['metadata'][0]['value']['name'] = '' if case == 'blank_name' else 'private\nname'
                    elif case == 'boolean_subject':
                        broken[5]['metadata'][0]['subject'] = False
                    elif case in ('boolean_serial', 'string_serial'):
                        broken[6]['info']['props']['object.serial'] = True if case == 'boolean_serial' else '910'
                    elif case == 'extra_reference_link':
                        broken.append(self.link(8, 11, 'active'))
                        broken[-1]['id'] = 111
                    elif case == 'paused_reference':
                        broken[-1]['info']['state'] = 'paused'
                    else:
                        broken[-2]['info']['props']['client.id'] = 33
                        broken.append(self.client(33, 3300))
                    with self.graph_output(broken):
                        with self.assertRaisesRegex(RuntimeError, 'Restart Kestrel'):
                            await echo.microphone_serial(3200, output_serial=910)

            for child in graph_children:
                child.stdout._transport.close.assert_called_once_with()
                child.wait.assert_awaited()

        asyncio.run(check())

    def test_replacement_owns_its_exit_and_source(self):
        echo, old_start, old_thread, stopped = self.start()
        old_target = old_thread.call_args.kwargs['target']
        old_args = old_thread.call_args.kwargs['args']
        old_process = old_start.return_value
        echo.close()
        replacement = Mock(pid=3101, poll=Mock(return_value=None), wait=Mock(return_value=4))
        with patch.object(speech.subprocess, 'Popen', return_value=replacement) as spawn, \
                patch.object(speech.threading, 'Thread') as new_thread:
            echo.start(stopped)
        self.assertIs(echo.process, replacement)
        old_target(*old_args)
        stopped.assert_not_called()
        old_process.terminate.assert_called_once_with()
        with self.graph_output(self.graph()):
            with self.assertRaisesRegex(RuntimeError, 'owned echo-removed microphone'):
                asyncio.run(echo.microphone_serial())
        new_thread.call_args.kwargs['target'](*new_thread.call_args.kwargs['args'])
        stopped.assert_called_once_with()
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        replacement.wait.side_effect = subprocess.TimeoutExpired('pipewire', speech.ECHO_REMOVAL_STOP_WAIT)
        with self.assertRaises(subprocess.TimeoutExpired):
            echo.close()
        self.assertEqual(replacement.wait.call_args_list[-2:], [
            ((), {'timeout': speech.ECHO_REMOVAL_STOP_WAIT}), ((), {'timeout': speech.ECHO_REMOVAL_STOP_WAIT}),
        ])

        async def graph_boundaries():
            for case in ('valid', 'oversized', 'stalled', 'cancelled', 'failed_reap', 'cancelled_failed_reap', 'nested'):
                with self.subTest(case=case):
                    entered, cleanup_entered, release_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
                    exited = asyncio.Event()
                    blocks = [(b'[' * 4095 + b'0' + b']' * 4095) if case == 'nested' else b'[]', b'']

                    async def read(size):
                        entered.set()
                        if case in ('stalled', 'cancelled'):
                            await asyncio.Event().wait()
                        if case in ('failed_reap', 'cancelled_failed_reap'):
                            raise OSError('Controlled graph read failure')
                        if case == 'oversized':
                            return b'x' * (8 * 1024 * 1024 + 1)
                        return blocks.pop(0)

                    async def wait():
                        if case in ('failed_reap', 'cancelled_failed_reap'):
                            if case == 'cancelled_failed_reap' and process.wait.await_count == 1:
                                cleanup_entered.set()
                                await release_cleanup.wait()
                            raise TimeoutError
                        if case in ('oversized', 'stalled', 'cancelled'):
                            await exited.wait()
                        process.returncode = 0
                        return 0

                    process = Mock(returncode=None, stdout=Mock(read=AsyncMock(side_effect=read), _transport=Mock()))
                    process.wait = AsyncMock(side_effect=wait)
                    process.terminate.side_effect = exited.set
                    process.kill.side_effect = exited.set
                    with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)):
                        task = asyncio.create_task(speech._pipewire_graph())
                        if case == 'cancelled':
                            await entered.wait()
                            task.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await task
                        elif case in ('failed_reap', 'cancelled_failed_reap'):
                            if case == 'cancelled_failed_reap':
                                await asyncio.wait_for(cleanup_entered.wait(), 5)
                                task.cancel()
                                release_cleanup.set()
                            with self.assertRaisesRegex(RuntimeError, speech.OUTPUT_SWITCH_FAILURE):
                                await task
                        elif case == 'valid':
                            self.assertEqual(await task, [])
                        else:
                            with self.assertRaises((ValueError, TimeoutError)):
                                await task
                    process.stdout._transport.close.assert_called_once_with()
                    self.assertGreater(process.wait.await_count, 0)
                    if case in ('oversized', 'stalled', 'cancelled', 'failed_reap', 'cancelled_failed_reap'):
                        process.terminate.assert_called_once_with()
                    if case in ('failed_reap', 'cancelled_failed_reap'):
                        process.kill.assert_called_once_with()
                        self.assertEqual(process.wait.await_count, 2)

        real_timeout = asyncio.timeout
        with patch.object(speech.asyncio, 'timeout', lambda delay: real_timeout(0.3 if delay == 5 else delay)):
            asyncio.run(graph_boundaries())

    def test_capture_requires_the_owned_echo_source_and_client(self):
        self.assertEqual(self.serial(self.graph(), None), 900)
        self.assertEqual(self.serial(self.graph()), 900)
        graph = self.graph()
        second_channel = self.link(8, 9, "active")
        second_channel["id"] = 109
        graph.append(second_channel)
        self.assertEqual(self.serial(graph), 900)
        for case in ("foreign_source", "foreign_capture", "extra_incoming", "paused", "missing_source",
                     "paused_second", "no_incoming"):
            with self.subTest(case=case):
                graph = self.graph()
                if case == "foreign_source":
                    graph.append(self.client(33, 3300))
                    graph[2]["info"]["props"]["client.id"] = 33
                elif case == "foreign_capture":
                    graph[1]["info"]["props"]["pipewire.sec.pid"] = 9999
                elif case == "extra_incoming":
                    graph += [self.node(12, "raw-microphone", 30, 902), self.link(12, 9, "active")]
                elif case == "paused":
                    graph[4]["info"]["state"] = "paused"
                elif case == "paused_second":
                    second_channel = self.link(8, 9, "paused")
                    second_channel["id"] = 109
                    graph.append(second_channel)
                elif case == "no_incoming":
                    graph.pop(4)
                else:
                    graph.pop(2)
                with self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                    self.serial(graph)
        self.assertEqual(self.messages, [])
    def test_malformed_graph_refuses_capture(self):
        bad = [None, {}, "private payload", [None], b"[" * 4095 + b"0" + b"]" * 4095]
        for field, value in (("object.serial", True), ("client.id", "30"), ("object.serial", "900")):
            graph = self.graph()
            graph[2]["info"]["props"][field] = value
            bad.append(graph)
        for change in ("duplicate_id", "ambiguous_source", "ambiguous_capture", "pid_boolean", "missing_owner", "link_scalar"):
            graph = self.graph()
            if change == "duplicate_id":
                graph.append(self.client(30, 3100))
            elif change == "ambiguous_source":
                graph.append(self.node(12, "kestrel-microphone", 31, 902))
            elif change == "ambiguous_capture":
                graph.append(self.node(12, "other", 31, 902))
            elif change == "pid_boolean":
                graph[0]["info"]["props"]["pipewire.sec.pid"] = True
            elif change == "missing_owner":
                graph.pop(0)
            else:
                graph[4]["info"]["output-node-id"] = "8"
            bad.append(graph)
        for graph in bad:
            with self.subTest(graph=graph), self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                self.serial(graph)
        echo = speech.EchoRemoval()
        echo.process = Mock(pid=3100, poll=Mock(return_value=None))
        for outcome in (FileNotFoundError("private payload"), TimeoutError("Controlled graph deadline"),
                        OSError("Controlled graph spawn failure")):
            with patch.object(speech.asyncio, "create_subprocess_exec", new=AsyncMock(side_effect=outcome)), \
                    self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                asyncio.run(echo.microphone_serial(3200))
        with self.graph_output(self.graph()), \
                patch.object(speech.json, 'loads', side_effect=RecursionError('synthetic decoder failure')):
            with self.assertRaisesRegex(RuntimeError, 'owned echo-removed microphone could not be verified'):
                asyncio.run(echo.microphone_serial(3200))
        echo.process.poll.return_value = 1
        with patch.object(speech, "_pipewire_graph", new=AsyncMock()) as run, self.assertRaisesRegex(RuntimeError, "has stopped"):
            asyncio.run(echo.microphone_serial())
        run.assert_not_called()
        self.assertEqual(self.messages, [])



class LaptopAudioTests(unittest.IsolatedAsyncioTestCase):
    def child(self, pid, *, normal_eof=False, exit_code=0, hold_exit=False):
        process = Mock(pid=pid, returncode=None)
        process.stdout = asyncio.StreamReader()
        process.stdin = Mock(drain=AsyncMock(), wait_closed=AsyncMock())

        exited = asyncio.Event()
        process.eof = asyncio.Event()
        process.wait_started = asyncio.Event()
        process.reaped = asyncio.Event()
        result = [exit_code]

        def release_exit():
            exited.set()

        def close():
            process.eof.set()
            if normal_eof and not hold_exit:
                release_exit()

        def kill():
            result[0] = -9
            exited.set()

        process.release_exit = release_exit
        process.stdin.close.side_effect = close
        process.kill.side_effect = kill
        process.terminate.side_effect = kill

        async def wait():
            process.wait_started.set()
            await exited.wait()
            process.returncode = result[0]
            process.reaped.set()
            return result[0]

        process.wait = AsyncMock(side_effect=wait)
        return process

    async def pipeline(self, *processors):
        started = asyncio.Event()
        observed = asyncio.Queue()

        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    started.set()
                else:
                    observed.put_nowait(frame)
                await self.push_frame(frame, direction)

        worker = PipelineWorker(Pipeline([*processors, Sink()]), params=PipelineParams(
            audio_in_sample_rate=16000, audio_out_sample_rate=48000,
        ), cancel_on_idle_timeout=False)
        runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())

        async def close():
            if not running.done():
                await worker.cancel()
            await asyncio.wait_for(running, 5)

        self.addAsyncCleanup(close)
        await asyncio.wait_for(started.wait(), 5)
        return worker, observed

    async def next_frame(self, observed, kind):
        async with asyncio.timeout(5):
            while True:
                frame = await observed.get()
                if isinstance(frame, kind):
                    return frame

    async def test_sound_cue_playback_failure_is_terminal(self):
        for case in ('drained', 'broken_pipe', 'nonzero', 'cancelled', 'revoked'):
            with self.subTest(case=case):
                admission = Admission(voice=False, output_switching=lambda: False)
                token = admission.accept_typed(on_taken=lambda: None)
                stopped = Mock()
                transport = speech.LaptopAudioTransport(Mock(), on_stopped=stopped, admission=admission,
                                                       capture_enabled=False)
                self.addAsyncCleanup(transport.close)
                output = transport.output()
                playback = self.child(3600, normal_eof=True, hold_exit=True,
                                      exit_code=7 if case == 'nonzero' else 0)
                children = []
                cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
                first_drain, release_drain = asyncio.Event(), asyncio.Event()
                native_wait = playback.wait.side_effect

                async def wait_child():
                    if case == 'cancelled' and playback.kill.called:
                        cleanup_started.set()
                        await release_cleanup.wait()
                    return await native_wait()

                playback.wait.side_effect = wait_child
                if case == 'broken_pipe':
                    playback.stdin.drain = AsyncMock(side_effect=BrokenPipeError('Private playback detail'))
                elif case == 'revoked':
                    async def drain():
                        first_drain.set()
                        await release_drain.wait()

                    playback.stdin.drain = AsyncMock(side_effect=drain)

                async def spawn(*args, **kwargs):
                    children.append(playback)
                    self.assertEqual(len(children), 1, 'Cue failure must never spawn a failure-cue retry')
                    return playback

                async def paced(duration):
                    return None

                self.addCleanup(playback.release_exit)
                self.addCleanup(release_cleanup.set)
                self.addCleanup(release_drain.set)
                task = None
                with patch.object(transport, '_spawn', spawn), patch.object(speech, 'sleep', paced):
                    _, observed = await self.pipeline(output)
                    try:
                        task = asyncio.create_task(output.play_cue('heard', token=token))
                        if case == 'broken_pipe':
                            self.assertFalse(await asyncio.wait_for(task, 5))
                        elif case == 'revoked':
                            await asyncio.wait_for(first_drain.wait(), 5)
                            first_writes = list(playback.stdin.write.call_args_list)
                            self.assertEqual(len(first_writes), 1)
                            self.assertTrue(first_writes[0].args[0])
                            self.assertLess(len(first_writes[0].args[0]), 6720)
                            self.assertTrue(admission.may_speak(token))
                            admission.accept_typed(on_taken=lambda: None)
                            self.assertFalse(admission.may_speak(token))
                            release_drain.set()
                            await asyncio.wait_for(playback.eof.wait(), 5)
                            playback.release_exit()
                            self.assertFalse(await asyncio.wait_for(task, 5))
                            self.assertEqual(playback.stdin.write.call_args_list, first_writes,
                                             'Revoked cue authority must not write additional stale bytes')
                        else:
                            await asyncio.wait_for(playback.eof.wait(), 5)
                            pcm = b''.join(call.args[0] for call in playback.stdin.write.call_args_list)
                            self.assertEqual(len(pcm), 6720, '70-ms mono 48-kHz signed-16-bit heard cue')
                            self.assertTrue(any(pcm))
                            self.assertLessEqual(np.max(np.abs(np.frombuffer(pcm, dtype='<i2').astype(np.int32))), 3277)
                            self.assertFalse(task.done(), 'EOF does not establish drained successful playback')
                            if case == 'cancelled':
                                task.cancel()
                                await asyncio.wait_for(cleanup_started.wait(), 5)
                                self.assertFalse(task.done(), 'Cancellation must await owned-child cleanup')
                                self.assertFalse(playback.reaped.is_set())
                                release_cleanup.set()
                                with self.assertRaises(asyncio.CancelledError):
                                    await asyncio.wait_for(task, 5)
                            else:
                                playback.release_exit()
                                self.assertEqual(await asyncio.wait_for(task, 5), case == 'drained')
                        self.assertTrue(playback.reaped.is_set())
                        self.assertIsNone(transport.playback)
                        self.assertIsNone(transport.playback_watcher)
                        self.assertIsNone(output.playback_deadline)
                        self.assertTrue(observed.empty(), 'Cues emit no text, reply or audio-credit frames')
                        if case in ('broken_pipe', 'nonzero'):
                            self.assertEqual(transport.failure, speech.LAPTOP_PLAYBACK_FAILURE)
                            stopped.assert_called_once_with()
                            self.assertFalse(await output.play_cue('failed', token=token))
                            self.assertEqual(children, [playback])
                            stopped.assert_called_once()
                        elif case == 'drained':
                            self.assertIsNone(transport.failure)
                            playback.kill.assert_not_called()
                            self.assertEqual(playback.returncode, 0)
                        elif case == 'revoked':
                            self.assertIsNone(transport.failure)
                            stopped.assert_not_called()
                        else:
                            playback.kill.assert_called_once()
                    finally:
                        release_cleanup.set()
                        release_drain.set()
                        playback.release_exit()
                        if task is not None and not task.done():
                            task.cancel()
                            await asyncio.gather(task, return_exceptions=True)
                        await transport.close()

    async def test_acknowledgement_deadline_orders_native_bytes(self):
        now = 100.0
        acknowledgement_now = 100.0
        timers = []
        children = []
        admission = Admission(voice=True, output_switching=lambda: False)
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=admission)
        self.addAsyncCleanup(transport.close)
        output = transport.output()
        output.prepared_acknowledgements = (
            speech.PreparedAcknowledgement('One moment.', b'K' * 3840),
            speech.PreparedAcknowledgement('Just a moment.', b'L' * 3840),
            speech.PreparedAcknowledgement('Give me a moment.', b'M' * 3840),
        )
        loop = asyncio.get_running_loop()
        call_later = loop.call_later

        def timer(delay, callback, *args, **kwargs):
            if (getattr(callback, '__self__', None) is output
                    and getattr(callback, '__func__', None) is speech.LaptopOutput._acknowledgement_due):
                handle = Mock()
                timers.append((callback, args, handle))
                return handle
            return call_later(delay, callback, *args, **kwargs)

        async def paced(duration):
            nonlocal now
            now += duration

        async def spawn(*args, **kwargs):
            nonlocal acknowledgement_now
            if opening_late:
                acknowledgement_now = max(acknowledgement_now, output.acknowledgement_deadline or 0)
            child = self.child(3300 + len(children), normal_eof=True, hold_exit=True)
            children.append(child)
            return child

        opening_late = False
        with (patch.object(loop, 'call_later', timer), patch.object(speech, 'monotonic', lambda: now),
              patch.object(output, '_acknowledgement_now', lambda: acknowledgement_now),
              patch.object(speech, 'sleep', paced), patch.object(transport, '_spawn', spawn)):
            worker, observed = await self.pipeline(output)
            for case, pcm in (('early', None), ('metadata', b'K' * 3840), ('opening', b'L' * 3840)):
                with self.subTest(case=case):
                    try:
                        before = len(children)
                        token, _ = admission.accept_spoken()
                        record = reply_record(token)
                        output.arm_acknowledgement(record)
                        callback, args, handle = timers[-1]
                        if case == 'early':
                            now += 1000.0
                        start = TTSStartedFrame()
                        start.reply_progress = record
                        await worker.queue_frame(start)
                        await self.next_frame(observed, TTSStartedFrame)
                        if case == 'metadata':
                            await worker.queue_frame(LLMTextFrame('Answer text is not audio.'))
                            await self.next_frame(observed, LLMTextFrame)
                            acknowledgement_now = max(acknowledgement_now, output.acknowledgement_deadline)
                            callback(*args)
                        opening_late = case == 'opening'
                        await worker.queue_frames([TTSAudioRawFrame(b'A' * 3840, 48000, 1),
                                                   TTSTextFrame('Answer.', aggregated_by='sentence')])
                        if pcm is not None:
                            # EOF or published text is a completion barrier even before the fix.
                            async with asyncio.timeout(5):
                                while len(children) == before:
                                    await observed.get()
                                acknowledgement = children[before]
                                eof = asyncio.create_task(acknowledgement.eof.wait())
                                text = asyncio.create_task(self.next_frame(observed, TTSTextFrame))
                                try:
                                    await asyncio.wait((eof, text), return_when=asyncio.FIRST_COMPLETED)
                                    self.assertTrue(acknowledgement.eof.is_set(),
                                                    'Complete acknowledgement retained its playback child')
                                    self.assertEqual(len(children), before + 1)
                                    self.assertEqual([call.args[0] for call in acknowledgement.stdin.write.call_args_list], [pcm])
                                    self.assertFalse(acknowledgement.reaped.is_set())
                                    acknowledgement.kill.assert_not_called()
                                    now += 10.0
                                    acknowledgement.release_exit()
                                finally:
                                    for task in (eof, text):
                                        task.cancel()
                                    await asyncio.gather(eof, text, return_exceptions=True)
                            acknowledged = None
                            while True:
                                spoken = await self.next_frame(observed, TTSTextFrame)
                                if spoken.text == 'Answer.':
                                    break
                                acknowledged = spoken
                            if case == 'metadata':
                                self.assertIsNotNone(acknowledged)
                                self.assertEqual(acknowledged.text, 'One moment.')
                                self.assertFalse(acknowledged.append_to_context)
                            self.assertEqual(len(children), before + 2)
                            self.assertTrue(acknowledgement.reaped.is_set())
                            self.assertEqual(acknowledgement.returncode, 0)
                            acknowledgement.wait.assert_awaited()
                            acknowledgement.kill.assert_not_called()
                            answer = children[-1]
                            self.assertIsNot(answer, acknowledgement)
                        else:
                            self.assertEqual((await self.next_frame(observed, TTSTextFrame)).text, 'Answer.')
                            self.assertEqual(len(children), before + 1)
                            answer = children[-1]
                        self.assertEqual([call.args[0] for call in answer.stdin.write.call_args_list], [b'A' * 3840])
                        self.assertAlmostEqual(output.playback_deadline, now)
                        self.assertIsNone(transport.failure)
                        handle.cancel.assert_called()
                        callback(*args)
                        mark = reply_progress.AnnouncementMarkFrame()
                        await output.queue_frame(mark)
                        self.assertIs(await self.next_frame(observed, reply_progress.AnnouncementMarkFrame), mark)
                        self.assertEqual([call.args[0] for call in answer.stdin.write.call_args_list], [b'A' * 3840])
                    finally:
                        for child in children:
                            child.release_exit()
                        await transport._discard_playback()
                        output.playback_deadline = None
                    await worker.queue_frame(TTSStoppedFrame())
                    await self.next_frame(observed, TTSStoppedFrame)
                    end = LLMFullResponseEndFrame()
                    end.reply_progress = record
                    await worker.queue_frame(end)
                    await self.next_frame(observed, LLMFullResponseEndFrame)
            await worker.cancel()

    async def test_acknowledgement_revocation_discards_unwritten_audio(self):
        now = 100.0
        waiting = asyncio.Queue()
        release = asyncio.Event()
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=None)
        self.addAsyncCleanup(transport.close)
        output = transport.output()
        output.prepared_acknowledgements = (
            speech.PreparedAcknowledgement('One moment.', b'K' * 7680),
            speech.PreparedAcknowledgement('Just a moment.', b'K' * 7680),
            speech.PreparedAcknowledgement('Give me a moment.', b'K' * 7680),
        )
        pushed = []

        @output.event_handler('on_after_push_frame')
        async def credited(processor, frame):
            if isinstance(frame, TTSAudioRawFrame):
                pushed.append(frame)
            elif isinstance(frame, TTSTextFrame) and case == 'answer_revoked':
                admission.close()

        async def paced(duration):
            nonlocal now
            waiting.put_nowait(duration)
            await release.wait()
            now += duration

        with patch.object(speech, 'monotonic', lambda: now), patch.object(speech, 'sleep', paced):
            worker, observed = await self.pipeline(output)
            for case in ('closed', 'superseded', 'interrupted', 'failed', 'finished', 'answer_revoked'):
                with self.subTest(case=case):
                    while not waiting.empty():
                        waiting.get_nowait()
                    release.clear()
                    admission = Admission(voice=True, output_switching=lambda: False)
                    transport.admission = admission
                    playback = self.child(3300, normal_eof=True)
                    transport.playback = playback
                    token, _ = admission.accept_spoken()
                    record = reply_record(token)
                    previous_finish = Mock()
                    record.on_finish = previous_finish
                    output.arm_acknowledgement(record)
                    handle = output.acknowledgement_timer
                    if case == 'answer_revoked':
                        now += 2.0
                        release.set()
                        start = TTSStartedFrame()
                        start.reply_progress = record
                        await output.queue_frame(start)
                        await output.queue_frame(TTSAudioRawFrame(b'A' * 3840, 48000, 1))
                    elif case == 'finished':
                        record.finish(interrupted=True)
                        self.assertTrue(handle.cancelled())
                        previous_finish.assert_called_once_with(record)
                    else:
                        now += 2.0
                        output._acknowledgement_due(record)
                        await asyncio.wait_for(waiting.get(), 5)
                        self.assertEqual(playback.stdin.write.call_args_list, [((b'K' * 3840,), {})])
                        if case == 'closed':
                            admission.close()
                        elif case == 'superseded':
                            admission.accept_spoken()
                        elif case == 'interrupted':
                            await worker.queue_frame(InterruptionFrame())
                            await self.next_frame(observed, InterruptionFrame)
                            # A marker barrier below observes the native sender's completed cancellation.
                        else:
                            playback.stdin.write.side_effect = OSError('Controlled playback failure')
                        release.set()
                    barrier = reply_progress.AnnouncementMarkFrame()
                    await output.queue_frame(barrier)
                    self.assertIs(await self.next_frame(observed, reply_progress.AnnouncementMarkFrame), barrier)
                    self.assertTrue(handle.cancelled())
                    self.assertIsNone(output.acknowledgement_record)
                    self.assertFalse(output.acknowledgement_tasks)
                    expected_index = 0 if case in ('closed', 'superseded', 'interrupted') else (2 if case == 'answer_revoked' else 1)
                    self.assertEqual(output.acknowledgement_index, expected_index)
                    if case == 'answer_revoked':
                        self.assertEqual([call.args[0] for call in playback.stdin.write.call_args_list],
                                         [b'K' * 3840, b'K' * 3840])
                        self.assertTrue(record.output_failed())
                    elif case == 'failed':
                        self.assertEqual(transport.failure, speech.LAPTOP_PLAYBACK_FAILURE)
                        self.assertTrue(record.output_failed())
                        self.assertEqual(len(pushed), 1, 'Only the completed first chunk receives output credit')
                        transport.failure = None
                    elif case == 'interrupted':
                        self.assertIsNotNone(playback.returncode)
                        playback.stdin.close.assert_called_once_with()
                        playback.wait.assert_awaited()
                    if case in ('closed', 'superseded', 'interrupted'):
                        self.assertEqual(playback.stdin.write.call_args_list, [((b'K' * 3840,), {})])
                        self.assertEqual(pushed, [])
                    before = playback.stdin.write.call_count
                    output._acknowledgement_due(record)
                    await output.queue_frame(barrier)
                    await self.next_frame(observed, reply_progress.AnnouncementMarkFrame)
                    self.assertEqual(playback.stdin.write.call_count, before)
                    if transport.playback is not None:
                        await transport._discard_playback()
                    pushed.clear()
            await worker.cancel()
            self.assertFalse(output.acknowledgement_tasks)

    async def test_acknowledgement_credit_does_not_consume_answer_ranges(self):
        import bot
        from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

        now = 100.0
        latency_now = 100.0
        latency_messages = []
        observer = None
        latency_barrier = None
        observer_drained = asyncio.Event()
        native_observer_init = bot.UserBotLatencyObserver.__init__

        def timed_observer(instance, *args, **kwargs):
            nonlocal observer
            native_observer_init(instance, *args, time_source=lambda: latency_now, **kwargs)
            observer = instance
            native_push = observer.on_push_frame

            async def push(data):
                await native_push(data)
                if data.frame is latency_barrier:
                    observer_drained.set()

            observer.on_push_frame = push

        def logged(message):
            if isinstance(message, str) and message.replace('.', '', 1).isdigit():
                latency_messages.append(message)

        ready = asyncio.Event()
        observed = asyncio.Queue()
        feed = bot.ConversationFeed()
        admission = Admission(voice=True, output_switching=lambda: False)
        token, _ = admission.accept_spoken()
        playback = self.child(3300, normal_eof=True)
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=admission)
        self.addAsyncCleanup(transport.close)
        transport.playback = playback
        answer_playback = self.child(3301, normal_eof=True)
        cue_playback = self.child(3302, normal_eof=True)
        output = transport.output()
        output.prepared_acknowledgements = (speech.PreparedAcknowledgement('One moment.', b'K' * 3840),)
        llm = bot.HermesLLMService(Mock(), local_actions=Mock(), admission=admission,
                                   session_ready=AsyncMock(), dismiss=AsyncMock(), conversation=feed)
        llm.begin_reply(token)
        record = llm.current_reply()
        answer_section = record.open_section('neutral')
        published = []
        native_publish = feed.publish

        def publish():
            native_publish()
            published.append(json.loads(feed.payload)['turns'][-1])

        feed.publish = publish

        class Forward(FrameProcessor):
            generation_cleanup_failed = False

            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)

        def completed(stage, frame):
            if stage == 'output' and isinstance(frame, StartFrame):
                ready.set()

        @output.event_handler('on_after_push_frame')
        async def pushed(processor, frame):
            observed.put_nowait(frame)

        async def paced(duration):
            nonlocal now
            now += duration

        async def drain_observer():
            nonlocal latency_barrier
            observer_drained.clear()
            latency_barrier = reply_progress.AnnouncementMarkFrame()
            await output.queue_frame(latency_barrier)
            await asyncio.wait_for(observer_drained.wait(), 5)

        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        task = None

        async def close():
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        self.addAsyncCleanup(close)
        with (patch.object(speech, 'monotonic', lambda: now), patch.object(speech, 'sleep', paced),
              patch.object(bot.UserBotLatencyObserver, '__init__', timed_observer),
              patch.object(bot.logger, 'info', side_effect=logged),
              patch.object(transport, '_spawn', side_effect=[answer_playback, cue_playback])):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), Forward(), llm=llm, transport=transport, user_params=params,
                on_frame_completed=completed, typed_origin=Mock(return_value=None),
            ))
            await asyncio.wait_for(ready.wait(), 5)
            self.assertIsNotNone(observer)
            await output.queue_frame(VADUserStoppedSpeakingFrame(timestamp=100.0, stop_secs=0))
            await drain_observer()
            output.arm_acknowledgement(record)
            start = TTSStartedFrame()
            record.stream_frame(start, answer_section)
            answer = TTSAudioRawFrame(b'A' * 960, 48000, 1)
            record.starts_text(answer, 'Answer.')
            record.stream_frame(answer, answer_section)
            mark = reply_progress.AnnouncementMarkFrame()
            await output.queue_frame(start)
            await output.queue_frame(answer)
            await output.queue_frame(mark)
            await self.next_frame(observed, reply_progress.AnnouncementMarkFrame)
            playback.stdin.write.assert_not_called()
            now += 2.0
            latency_now = 102.0
            output._acknowledgement_due(record)
            self.assertEqual((await self.next_frame(observed, TTSTextFrame)).text, 'One moment.')
            await self.next_frame(observed, reply_progress.AcknowledgementStoppedFrame)
            self.assertEqual(feed.turns[-1]['text'], 'One moment.')
            await drain_observer()
            # A completed acknowledgement must not leave the silent wait labelled Speaking.
            self.assertEqual(feed.turns[-1]['state'], 'thinking')
            self.assertEqual(latency_messages, [], 'Prepared speech cannot consume answer latency')
            latency_now = 106.0
            text = TTSTextFrame('Answer.', aggregated_by='sentence')
            record.stream_frame(text, answer_section)
            stop = TTSStoppedFrame()
            record.stream_frame(stop, answer_section)
            end = LLMFullResponseEndFrame()
            end.reply_progress = record
            for frame in (text, stop, end):
                await output.queue_frame(frame)
            await self.next_frame(observed, LLMFullResponseEndFrame)
            await drain_observer()
            self.assertEqual(latency_messages, ['6.000'])
            self.assertTrue(record.span_of(text).audible, 'Prepared text cannot clear pending answer audio evidence')
            self.assertEqual([call.args[0] for call in playback.stdin.write.call_args_list], [b'K' * 3840])
            self.assertTrue(playback.reaped.is_set())
            self.assertEqual(playback.returncode, 0)
            playback.kill.assert_not_called()
            self.assertIsNone(transport.playback)
            for child in (answer_playback, cue_playback):
                self.assertTrue(child.reaped.is_set())
                self.assertEqual(child.returncode, 0)
                child.kill.assert_not_called()
            self.assertEqual([call.args[0] for call in answer_playback.stdin.write.call_args_list],
                             [b'A' * 960 + bytes(2880)])
            self.assertEqual(answer_section.output_bytes, 960)
            self.assertEqual(record.sections[1].output_bytes, 3840)
            self.assertFalse(record.output_failed())
            self.assertTrue(record.completed)
            self.assertEqual(feed.turns[-1], {'speaker': 'kestrel', 'text': 'One moment. Answer.', 'state': 'complete'})
            self.assertEqual(published, [
                {'speaker': 'kestrel', 'text': 'One moment.', 'state': 'speaking'},
                {'speaker': 'kestrel', 'text': 'One moment.', 'state': 'thinking'},
                {'speaker': 'kestrel', 'text': 'One moment. Answer.', 'state': 'speaking'},
                {'speaker': 'kestrel', 'text': 'One moment. Answer.', 'state': 'complete'},
            ])
            completed_payload = feed.payload
            record.output_frame(reply_progress.AcknowledgementStoppedFrame(record))
            self.assertEqual(feed.payload, completed_payload)
            self.assertFalse(output.output_buffer.misaligned)
            self.assertFalse(output.acknowledgement_tasks)
            await close()

    async def test_acknowledgement_drain_failure_refuses_answer_and_reaps(self):
        native_wait_for = asyncio.wait_for
        for case in ('nonzero', 'close_failure', 'timeout', 'cleanup_failure'):
            with self.subTest(case=case):
                admission = Admission(voice=True, output_switching=lambda: False)
                token, _ = admission.accept_spoken()
                record = reply_record(token)
                transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=admission)
                self.addAsyncCleanup(transport.close)
                output = transport.output()
                output.prepared_acknowledgements = (speech.PreparedAcknowledgement('One moment.', b'K' * 7680),)
                playback = self.child(3400, normal_eof=True, exit_code=7 if case == 'nonzero' else 0,
                                      hold_exit=case in ('timeout', 'cleanup_failure'))
                native_close = playback.stdin.close.side_effect
                native_wait = playback.wait.side_effect
                close_attempts = 0
                cleanup_fails = case == 'cleanup_failure'
                injection_enabled = True

                def close_pipe():
                    nonlocal close_attempts
                    close_attempts += 1
                    if case == 'close_failure' and close_attempts == 1:
                        raise OSError('Private pipe detail must not reach the failure')
                    native_close()

                async def wait_child():
                    if cleanup_fails and playback.kill.called:
                        raise TimeoutError('Controlled cleanup failure')
                    return await native_wait()

                async def bounded(awaitable, timeout):
                    if (injection_enabled and case in ('timeout', 'cleanup_failure') and timeout == 5
                            and playback.eof.is_set() and not playback.kill.called):
                        pending = asyncio.ensure_future(awaitable)
                        pending.cancel()
                        await asyncio.gather(pending, return_exceptions=True)
                        raise TimeoutError('Controlled native drain deadline')
                    return await native_wait_for(awaitable, timeout)

                playback.stdin.close.side_effect = close_pipe
                playback.wait.side_effect = wait_child
                children = []

                async def spawn(*args, **kwargs):
                    children.append(playback)
                    return playback

                async def paced(duration):
                    return None

                with (patch.object(transport, '_spawn', spawn), patch.object(speech, 'sleep', paced),
                      patch.object(asyncio, 'wait_for', bounded)):
                    worker, _ = await self.pipeline(output)
                    output.reply_progress = record
                    output.arm_acknowledgement(record)
                    output.acknowledgement_deadline = output._acknowledgement_now()
                    try:
                        accepted = await output.write_audio_frame(TTSAudioRawFrame(b'A' * 3840, 48000, 1))
                        self.assertFalse(accepted, 'Failed acknowledgement drain must refuse the answer')
                        self.assertEqual(transport.failure, speech.LAPTOP_PLAYBACK_FAILURE)
                        self.assertTrue(record.output_failed())
                        self.assertEqual(children, [playback])
                        self.assertEqual([call.args[0] for call in playback.stdin.write.call_args_list],
                                         [b'K' * 3840, b'K' * 3840])
                        self.assertIsNone(output.playback_deadline)
                        self.assertIsNone(transport.playback_watcher)
                        if case == 'cleanup_failure':
                            self.assertIs(transport.playback, playback)
                            self.assertFalse(playback.reaped.is_set())
                            self.assertFalse(await output.write_audio_frame(TTSAudioRawFrame(b'A' * 3840, 48000, 1)))
                            self.assertEqual(children, [playback])
                        else:
                            self.assertTrue(playback.reaped.is_set())
                            self.assertIsNone(transport.playback)
                        if case == 'nonzero':
                            self.assertEqual(playback.returncode, 7)
                    finally:
                        injection_enabled = False
                        cleanup_fails = False
                        playback.stdin.close.side_effect = native_close
                        playback.wait.side_effect = native_wait
                        playback.release_exit()
                        await worker.cancel()
                        await transport.close()
                        self.assertTrue(playback.reaped.is_set())

    async def test_acknowledgement_drain_cancellation_reaps_before_replacement(self):
        for case in ('interruption', 'close', 'revoked', 'superseded', 'outer_cancel'):
            with self.subTest(case=case):
                admission = Admission(voice=True, output_switching=lambda: False)
                token, _ = admission.accept_spoken()
                record = reply_record(token)
                transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=admission)
                self.addAsyncCleanup(transport.close)
                output = transport.output()
                output.prepared_acknowledgements = (speech.PreparedAcknowledgement('One moment.', b'K' * 7680),)
                acknowledgement = self.child(3500, normal_eof=True, hold_exit=True)
                replacement = self.child(3501)
                children, write_tasks = [], []
                cleanup_started, cleanup_release = asyncio.Event(), asyncio.Event()
                interruption_completed = asyncio.Event()
                observed_interruption = None
                native_process_frame = output.process_frame
                native_wait = acknowledgement.wait.side_effect
                native_close = acknowledgement.stdin.close.side_effect

                async def observe_process_frame(frame, direction):
                    result = await native_process_frame(frame, direction)
                    if frame is observed_interruption:
                        interruption_completed.set()
                    return result

                def close_pipe():
                    if not write_tasks:
                        write_tasks.append(asyncio.current_task())
                    native_close()

                async def wait_child():
                    if acknowledgement.kill.called:
                        cleanup_started.set()
                        await cleanup_release.wait()
                    return await native_wait()

                acknowledgement.stdin.close.side_effect = close_pipe
                acknowledgement.wait.side_effect = wait_child

                async def spawn(*args, **kwargs):
                    child = acknowledgement if not children else replacement
                    if children:
                        self.assertTrue(acknowledgement.reaped.is_set(), 'Replacement preceded old child reaping')
                    children.append(child)
                    return child

                async def paced(duration):
                    return None

                with (patch.object(transport, '_spawn', spawn), patch.object(speech, 'sleep', paced),
                      patch.object(output, 'process_frame', observe_process_frame)):
                    worker, observed = await self.pipeline(output)
                    output.arm_acknowledgement(record)
                    output.acknowledgement_deadline = output._acknowledgement_now()
                    answer = TTSAudioRawFrame(b'A' * 3840, 48000, 1)
                    section = record.open_section('neutral')
                    start = TTSStartedFrame()
                    record.stream_frame(start, section)
                    record.starts_text(answer, 'Answer.')
                    record.stream_frame(answer, section)
                    await worker.queue_frames([start, answer, TTSTextFrame('Answer.', aggregated_by='sentence')])
                    eof = asyncio.create_task(acknowledgement.eof.wait())
                    text = asyncio.create_task(self.next_frame(observed, TTSTextFrame))
                    action = None
                    try:
                        await asyncio.wait_for(asyncio.wait((text, eof), return_when=asyncio.FIRST_COMPLETED), 5)
                        self.assertTrue(acknowledgement.eof.is_set(),
                                        'Acknowledgement never entered an owned EOF drain')
                        text.cancel()
                        await asyncio.gather(text, return_exceptions=True)
                        writing = write_tasks[0]
                        if case == 'interruption':
                            observed_interruption = InterruptionFrame()
                            await worker.queue_frame(observed_interruption)
                        elif case == 'close':
                            action = asyncio.create_task(transport.close())
                            acknowledgement.release_exit()
                        elif case == 'revoked':
                            admission.close()
                            acknowledgement.release_exit()
                        elif case == 'superseded':
                            admission.accept_spoken()
                            acknowledgement.release_exit()
                        else:
                            writing.cancel()
                        if case in ('interruption', 'outer_cancel'):
                            await asyncio.wait_for(cleanup_started.wait(), 5)
                            self.assertFalse(writing.done(), 'Cancellation returned before owned cleanup')
                            self.assertIs(transport.playback, acknowledgement)
                            self.assertEqual(children, [acknowledgement])
                            if case == 'interruption':
                                self.assertFalse(interruption_completed.is_set())
                            if case == 'outer_cancel':
                                writing.cancel()
                                await asyncio.sleep(0)
                                self.assertFalse(writing.done())
                            cleanup_release.set()
                        if case == 'outer_cancel':
                            await asyncio.wait_for(asyncio.gather(writing, return_exceptions=True), 5)
                            self.assertTrue(acknowledgement.reaped.is_set())
                            self.assertIsNone(transport.playback)
                            self.assertIsNone(transport.playback_watcher)
                            # Direct cancellation stops the native sender; recovery must not do its cleanup.
                            interruption_completed.clear()
                            observed_interruption = InterruptionFrame()
                            await worker.queue_frame(observed_interruption)
                            await asyncio.wait_for(interruption_completed.wait(), 5)
                        elif case == 'interruption':
                            await asyncio.wait_for(interruption_completed.wait(), 5)
                        elif case == 'close':
                            await asyncio.wait_for(action, 5)
                        else:
                            await asyncio.wait_for(acknowledgement.reaped.wait(), 5)
                        barrier = reply_progress.AnnouncementMarkFrame()
                        await output.queue_frame(barrier)
                        self.assertIs(await self.next_frame(observed, reply_progress.AnnouncementMarkFrame), barrier)
                        self.assertTrue(acknowledgement.reaped.is_set())
                        self.assertIsNone(transport.playback_watcher)
                        self.assertIsNone(output.playback_deadline)
                        self.assertIsNone(transport.failure)
                        self.assertEqual([call.args[0] for call in acknowledgement.stdin.write.call_args_list],
                                         [b'K' * 3840, b'K' * 3840])
                        self.assertEqual(section.output_bytes, 0)
                        self.assertEqual(children, [acknowledgement])
                        if case in ('interruption', 'superseded', 'outer_cancel'):
                            fresh_token, _ = admission.accept_spoken()
                            output.reply_progress = reply_record(fresh_token)
                            self.assertTrue(await output.write_audio_frame(TTSAudioRawFrame(b'A' * 3840, 48000, 1)))
                            self.assertEqual(children, [acknowledgement, replacement])
                            self.assertEqual([call.args[0] for call in replacement.stdin.write.call_args_list], [b'A' * 3840])
                    finally:
                        cleanup_release.set()
                        acknowledgement.release_exit()
                        eof.cancel()
                        text.cancel()
                        await asyncio.gather(eof, text, return_exceptions=True)
                        if action is not None:
                            await asyncio.gather(action, return_exceptions=True)
                        await worker.cancel()
                        await transport.close()

    async def test_acknowledgement_eof_drains_native_child(self):
        native_spawn = asyncio.create_subprocess_exec
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                admission = Admission(voice=True, output_switching=lambda: False)
                token, _ = admission.accept_spoken()
                record = reply_record(token)
                transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=admission)
                self.addAsyncCleanup(transport.close)
                output = transport.output()
                output.prepared_acknowledgements = (speech.PreparedAcknowledgement('One moment.', b'K' * 7680),)
                children, receipts = [], []

                async def spawn(*command, **pipes):
                    # Retain the real spawn's parent-death prefix; replace pw-cat only.
                    prefix = command[:len(speech.BOUND_TO_KESTREL) + 1]
                    guard = list(speech.BOUND_TO_KESTREL)
                    guard[2] = 'KILL'
                    self.assertEqual(prefix, (*guard, str(os.getpid())))
                    expected = b'K' * 7680 if not children else b'A' * 3840
                    code = exit_code if not children else 0
                    program = (
                        'import os, sys; expected = ' + repr(expected) + '; '
                        'data = sys.stdin.buffer.read(len(expected)); '
                        'os.write(1, b"OK" if data == expected else b"BAD"); '
                        'tail = sys.stdin.buffer.read(); '
                        'sys.exit(' + str(code) + ' if data == expected and not tail else 9)'
                    )
                    child = await native_spawn(*prefix, sys.executable, '-c', program,
                                               stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
                    children.append(child)
                    receipts.append(asyncio.create_task(child.stdout.readexactly(2)))
                    return child

                async def paced(duration):
                    return None

                with patch.object(speech.asyncio, 'create_subprocess_exec', spawn), patch.object(speech, 'sleep', paced):
                    worker, _ = await self.pipeline(output)
                    output.reply_progress = record
                    output.arm_acknowledgement(record)
                    output.acknowledgement_deadline = output._acknowledgement_now()
                    try:
                        accepted = await asyncio.wait_for(output.write_audio_frame(TTSAudioRawFrame(b'A' * 3840, 48000, 1)), 5)
                        self.assertEqual(accepted, exit_code == 0)
                        self.assertEqual(len(children), 2 if exit_code == 0 else 1,
                                         'Answer requires a distinct child after acknowledgement EOF')
                        self.assertEqual(children[0].returncode, exit_code)
                        self.assertEqual(await asyncio.wait_for(receipts[0], 5), b'OK')
                        if exit_code == 0:
                            self.assertIsNone(transport.failure)
                            self.assertIs(transport.playback, children[1])
                            self.assertEqual(await asyncio.wait_for(receipts[1], 5), b'OK')
                            await transport.close()
                            self.assertIsNotNone(children[1].returncode)
                        else:
                            self.assertEqual(transport.failure, speech.LAPTOP_PLAYBACK_FAILURE)
                            self.assertTrue(record.output_failed())
                            self.assertIsNone(transport.playback)
                    finally:
                        await worker.cancel()
                        await transport.close()
                        for child in children:
                            if child.returncode is None:
                                child.kill()
                            await asyncio.wait_for(child.wait(), 5)
                        for receipt in receipts:
                            receipt.cancel()
                        await asyncio.gather(*receipts, return_exceptions=True)

    @patch.object(speech, 'LAPTOP_CAPTURE_STALL_TIMEOUT', 0.5)
    async def test_capture_refresh_requires_fresh_audio_and_owned_links(self):
        for case in ('fresh', 'no_fresh_audio', 'changed_source', 'foreign_reference', 'cancelled', 'failed_reap', 'failed_pump', 'graph_cleanup_failure', 'graph_query_recovers'):
            with self.subTest(case=case):
                capture, replacement = self.child(3200), self.child(3201)
                capture.stdout.feed_data(b'O' * 640)
                capture.stdin = replacement.stdin = None
                stopped = Mock()
                echo = Mock(microphone_serial=AsyncMock(return_value=900))
                transport = speech.LaptopAudioTransport(echo, on_stopped=stopped, admission=Admission(voice=True, output_switching=lambda: False))
                self.addAsyncCleanup(transport.close)
                native_queue = transport.input()
                with patch.object(transport, '_spawn', return_value=capture) as spawn:
                    await transport.open()
                    await native_queue.drain_audio()  # Pre-readiness has no native ingress.
                    worker, observed = await self.pipeline(native_queue)
                    pump, queue = native_queue._audio_task, native_queue._audio_in_queue
                    if case == 'failed_reap':
                        capture.wait.side_effect = TimeoutError
                        with self.assertRaises(TimeoutError):
                            await transport.suspend_capture()
                        self.assertEqual(spawn.call_count, 1)
                        capture.wait.side_effect = None
                        capture.wait.return_value = -9
                        await transport.close()
                        await worker.cancel()
                        continue
                    await transport.suspend_capture()
                    self.assertFalse(transport.verified)
                    self.assertIsNone(transport.capture)
                    self.assertIsNone(transport.reader)
                    self.assertFalse(transport.received_audio.is_set())
                    self.assertIsNotNone(capture.returncode)
                    await native_queue.drain_audio()
                    self.assertIs(native_queue._audio_task, pump)
                    self.assertIs(native_queue._audio_in_queue, queue)
                    if case == 'failed_pump':
                        await native_queue.cancel_task(pump)
                        with self.assertRaisesRegex(RuntimeError, 'Restart Kestrel'):
                            await native_queue.drain_audio()
                        await worker.cancel()
                        continue
                    spawn.return_value = replacement
                    if case in ('graph_cleanup_failure', 'graph_query_recovers'):
                        echo = speech.EchoRemoval()
                        echo.process = Mock(pid=3100, poll=Mock(return_value=None))
                        transport.echo_removal = echo
                        graphs = []
                        graph = [EchoRemovalTests.client(30, 3100), EchoRemovalTests.client(31, replacement.pid),
                                 EchoRemovalTests.node(8, 'kestrel-microphone', 30, 900),
                                 EchoRemovalTests.node(9, 'owned-capture', 31, 901), EchoRemovalTests.link(8, 9, 'active'),
                                 {'id': 50, 'type': 'PipeWire:Interface:Metadata', 'props': {'metadata.name': 'default'},
                                  'metadata': [{'subject': 0, 'key': 'default.audio.sink', 'type': 'Spa:String:JSON',
                                                'value': {'name': 'selected-output'}}]},
                                 EchoRemovalTests.node(10, 'selected-output', 30, 910),
                                 EchoRemovalTests.node(11, 'kestrel-echo-removal-reference'), EchoRemovalTests.link(10, 11, 'active')]
                        graph[6]['info']['props']['media.class'] = 'Audio/Sink'

                        async def graph_process(*args, **kwargs):
                            self.assertEqual(args, ('pw-dump',))
                            broken = case == 'graph_cleanup_failure' or not graphs
                            read = AsyncMock(side_effect=OSError('Controlled graph read failure')) if broken else AsyncMock(
                                side_effect=[json.dumps(graph).encode(), b''])
                            process = Mock(stdout=Mock(read=read, _transport=Mock()),
                                           returncode=None if case == 'graph_cleanup_failure' else 0)
                            process.wait = AsyncMock(side_effect=TimeoutError) if case == 'graph_cleanup_failure' else AsyncMock(return_value=0)
                            graphs.append(process)
                            return process

                        replacement.stdout.feed_data(b'S' * 640)
                        with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(side_effect=graph_process)):
                            if case == 'graph_cleanup_failure':
                                with self.assertRaisesRegex(RuntimeError, speech.LAPTOP_CAPTURE_FAILURE):
                                    await transport.open()
                                self.assertEqual(len(graphs), 1, 'Uncertain graph cleanup must never authorize another query')
                                self.assertEqual(graphs[0].wait.await_count, 2)
                                graphs[0].terminate.assert_called_once_with()
                                graphs[0].kill.assert_called_once_with()
                                self.assertFalse(transport.verified)
                                self.assertFalse(transport.input().ready)
                                self.assertTrue(transport.closed)
                                stopped.assert_called_once_with()
                            else:
                                await transport.open()
                                self.assertEqual(len(graphs), 3)
                                self.assertTrue(transport.verified)
                                stopped.assert_not_called()
                                replacement.stdout.feed_data(b'F' * 640)
                                self.assertEqual((await self.next_frame(observed, InputAudioRawFrame)).audio, b'F' * 640)
                        for process in graphs:
                            process.stdout._transport.close.assert_called_once_with()
                            self.assertGreater(process.wait.await_count, 0)
                        await transport.close()
                        await worker.cancel()
                        continue
                    if case == 'fresh':
                        replacement.stdout.feed_data(b'S' * 640)
                        await transport.resume_capture(output_serial=910)
                        echo.microphone_serial.assert_any_await(3201, output_serial=910)
                        replacement.stdout.feed_data(b'F' * 640)
                        frame = await self.next_frame(observed, InputAudioRawFrame)
                        self.assertEqual(frame.audio, b'F' * 640)
                        self.assertTrue(transport.verified)
                    elif case == 'no_fresh_audio':
                        with self.assertRaisesRegex(RuntimeError, 'Restart Kestrel'):
                            await transport.resume_capture(output_serial=910)
                        self.assertFalse(transport.verified)
                        stopped.assert_not_called()
                        self.assertFalse(transport.closed)
                        self.assertIsNotNone(replacement.returncode)
                    else:
                        checking = asyncio.Event()

                        async def serial(pid=None, *, output_serial=None):
                            if pid == 3201:
                                self.assertEqual(output_serial, 910)
                                checking.set()
                                if case == 'cancelled':
                                    await asyncio.Event().wait()
                                if case == 'changed_source':
                                    return 901
                                raise RuntimeError('Foreign reference. Restart Kestrel.')
                            return 900

                        echo.microphone_serial.side_effect = serial
                        replacement.stdout.feed_data(b'S' * 640)
                        resume = asyncio.create_task(transport.resume_capture(output_serial=910))
                        await asyncio.wait_for(checking.wait(), 5)
                        if case == 'cancelled':
                            resume.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await resume
                        else:
                            with self.assertRaisesRegex(RuntimeError, 'Restart Kestrel'):
                                await resume
                        self.assertFalse(transport.verified)
                        self.assertIsNotNone(replacement.returncode)
                    await transport.close()
                    await worker.cancel()

    async def test_missing_admission_admits_no_microphone_frame(self):
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=None)
        self.assertFalse(transport.input_admitted())

    async def test_output_only_and_reply_token_gate(self):
        admission = Admission(voice=False, output_switching=lambda: False)
        old, _ = admission.accept_spoken()
        opened, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        playback = self.child(3300)
        echo = Mock()
        transport = speech.LaptopAudioTransport(echo, on_stopped=Mock(), admission=admission, capture_enabled=False)
        self.addAsyncCleanup(transport.close)

        async def spawn(*argv, **kwargs):
            self.assertIn('--playback', argv)
            opened.set()
            await release.wait()
            return playback

        with patch.object(transport, '_spawn', side_effect=spawn) as spawning:
            await transport.open()
            spawning.assert_not_called()
            echo.microphone_serial.assert_not_called()
            self.assertIsNone(transport.capture)
            output = transport.output()
            output.reply_progress = reply_record(old)
            write = asyncio.create_task(output.write_audio_frame(TTSAudioRawFrame(bytes(640), 48000, 1)))
            await asyncio.wait_for(opened.wait(), 5)
            current, _ = admission.accept_spoken()
            release.set()
            self.assertFalse(await asyncio.wait_for(write, 5))
            playback.stdin.write.assert_not_called()
            self.assertTrue(output.reply_progress.output_failed())
            self.assertFalse(await output.write_audio_frame(TTSAudioRawFrame(bytes(640), 48000, 1)))
            output.reply_progress = None
            self.assertFalse(await output.write_audio_frame(TTSAudioRawFrame(bytes(640), 48000, 1)))
            output.reply_progress = reply_record(current)
            with patch.object(speech, 'sleep', AsyncMock()):
                self.assertTrue(await output.write_audio_frame(TTSAudioRawFrame(b'fresh PCM', 48000, 1)))
            playback.stdin.write.assert_called_once_with(b'fresh PCM')
        await transport.close()
        self.assertIsNotNone(playback.returncode)

    async def test_capture_discards_audio_until_verified_and_ready(self):
        capture = self.child(3200)
        spawned = asyncio.Event()
        checked = threading.Event()
        release = threading.Event()
        consumed = asyncio.Queue()
        original_read = capture.stdout.readexactly

        async def read(size):
            data = await original_read(size)
            consumed.put_nowait(data)
            return data

        capture.stdout.readexactly = read

        async def serial(pid=None, *, output_serial=None):
            if pid is not None:
                checked.set()
                if not await asyncio.to_thread(release.wait, 5):
                    raise AssertionError("Capture graph verification was not released")
            return 900

        async def spawn(*argv, **kwargs):
            self.assertIn("--record", argv)
            self.assertEqual(argv[-1], "-")
            self.assertEqual(kwargs["stdout"], asyncio.subprocess.PIPE)
            self.assertIn("stdbuf", argv)
            self.assertEqual(argv[argv.index("stdbuf") + 1:argv.index("pw-cat")], ("-o0",))
            self.assertEqual(argv[argv.index("--target") + 1], "900")
            props = json.loads(argv[argv.index("--properties") + 1])
            for key in ("node.dont-fallback", "node.dont-move", "node.dont-reconnect"):
                self.assertIs(props[key], True)
            self.assertTrue(props["node.name"].startswith("kestrel-capture-"))
            spawned.set()
            return capture

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=AsyncMock(side_effect=serial)), on_stopped=Mock(), admission=Admission(voice=True, output_switching=lambda: False))
        self.addAsyncCleanup(transport.close)
        with patch.object(speech.asyncio, "create_subprocess_exec", spawn):
            opening = asyncio.create_task(transport.open())
            try:
                await asyncio.wait_for(spawned.wait(), 5)
                capture.stdout.feed_data(b"A" * 640)
                self.assertEqual(await asyncio.wait_for(consumed.get(), 5), b"A" * 640)
                await asyncio.wait_for(asyncio.to_thread(checked.wait, 5), 5)
                release.set()
                await asyncio.wait_for(opening, 5)
                startup_graph_calls = transport.echo_removal.microphone_serial.call_count
                capture.stdout.feed_data(b"B" * 640)
                self.assertEqual(await asyncio.wait_for(consumed.get(), 5), b"B" * 640)
                worker, observed = await self.pipeline(transport.input())
                capture.stdout.feed_data(b"C" * 640 + b"D" * 640)
                frames = [await self.next_frame(observed, InputAudioRawFrame) for _ in range(2)]
                self.assertEqual([frame.audio for frame in frames], [b"C" * 640, b"D" * 640])
                self.assertEqual([(frame.sample_rate, frame.num_channels) for frame in frames], [(16000, 1)] * 2)
                self.assertEqual(transport.echo_removal.microphone_serial.call_count, startup_graph_calls)
                await worker.cancel()
            finally:
                release.set()
                await asyncio.gather(opening, return_exceptions=True)
        self.assertIsNone(transport.failure)

    async def test_waiting_capture_delivers_only_verified_private_pcm(self):
        capture = self.child(3200)
        checked, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        consumed, private = asyncio.Queue(), asyncio.Queue()
        original_read = capture.stdout.readexactly

        async def read(size):
            pcm = await original_read(size)
            consumed.put_nowait(pcm)
            return pcm

        capture.stdout.readexactly = read

        async def serial(pid=None, *, output_serial=None):
            if pid is not None:
                checked.set()
                if not await asyncio.to_thread(release.wait, 5):
                    raise AssertionError('Verification was not released')
            return 900

        transport = speech.LaptopAudioTransport(
            Mock(microphone_serial=serial), on_stopped=Mock(), admission=None,
            capture_pcm=private.put_nowait,
        )
        self.addAsyncCleanup(transport.close)
        with patch.object(transport, '_spawn', return_value=capture):
            opening = asyncio.create_task(transport.open())
            try:
                self.assertTrue(await asyncio.to_thread(checked.wait, 5))
                capture.stdout.feed_data(b'A' * 640)
                self.assertEqual(await asyncio.wait_for(consumed.get(), 5), b'A' * 640)
                self.assertTrue(private.empty())
                release.set()
                await asyncio.wait_for(opening, 5)
                capture.stdout.feed_data(b'B' * 640)
                self.assertEqual(await asyncio.wait_for(private.get(), 5), b'B' * 640)
                self.assertFalse(transport.input().ready)
                self.assertFalse(transport.input_admitted())
                self.assertIsNone(transport.playback)
            finally:
                release.set()
                await asyncio.gather(opening, return_exceptions=True)
        await transport.close()
        self.assertTrue(transport.reader.done())
        self.assertIsNotNone(capture.returncode)

    async def test_capture_failure_stops_without_fallback(self):
        for case in ("eof", "truncated", "missing", "timeout"):
            with self.subTest(case=case):
                capture = self.child(3200)
                stopped = asyncio.Event()
                requests = []

                async def serial(pid=None, *, output_serial=None):
                    if case == "missing":
                        raise RuntimeError("The owned microphone is missing. Restart Kestrel.")
                    return 900

                async def spawn(*argv, **kwargs):
                    requests.append(argv)
                    self.assertIn("--record", argv)
                    capture.stdout.feed_data(bytes(640))
                    return capture

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=serial), on_stopped=Mock(side_effect=stopped.set), admission=None)
                with (
                    patch.object(speech.asyncio, "create_subprocess_exec", spawn),
                    patch.object(speech, "LAPTOP_AUDIO_START_TIMEOUT", 0.05 if case == "missing" else 10),
                ):
                    try:
                        if case == "missing":
                            with self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                                await asyncio.wait_for(transport.open(), 5)
                            self.assertEqual(requests, [])
                        else:
                            await asyncio.wait_for(transport.open(), 5)
                            if case != "timeout":
                                await self.pipeline(transport.input())
                                if case == "eof":
                                    capture.stdout.feed_eof()
                                else:
                                    capture.stdout.feed_data(b"X" * 639)
                                    capture.stdout.feed_eof()
                        with patch.object(speech, "LAPTOP_CAPTURE_STALL_TIMEOUT", 0.05 if case == "timeout" else 5):
                            if case == "timeout":
                                capture.stdout.feed_data(bytes(640))
                            await asyncio.wait_for(stopped.wait(), 5)
                        self.assertEqual(transport.failure, "Microphone capture failed. Restart Kestrel.")
                        first_failure = transport.failure
                        transport.fail("later private payload")
                        self.assertEqual(transport.failure, first_failure)
                        transport.on_stopped.assert_called_once_with()
                        self.assertFalse(transport.verified)
                        self.assertLessEqual(sum("--record" in argv for argv in requests), 1)
                    finally:
                        await transport.close()
                    self.assertIsNotNone(transport.failure)
                    if capture.wait.await_count:
                        self.assertIsNotNone(capture.returncode)

    async def test_playback_clock_compensates_overhead_and_rebases_after_gaps(self):
        now = 100.000
        waits = []
        drain_delays = iter([0.003, 0.003, 0.003, 0.100])
        playback = self.child(3300)

        async def drain():
            nonlocal now
            now += next(drain_delays)

        async def paced(duration):
            nonlocal now
            waits.append(duration)
            now += duration + 0.002

        playback.stdin.drain = AsyncMock(side_effect=drain)
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock(), admission=None)
        transport.playback = playback
        self.addAsyncCleanup(transport.close)
        audio = [b"A" * 3840, b"B" * 3840, b"C" * 3840, b"D" * 3840]
        with (patch.object(speech, "monotonic", lambda: now),
              patch.object(speech, "sleep", paced)):
            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(audio[0], 48000, 1)))
            now += 0.005
            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(audio[1], 48000, 1)))
            now = 101.000
            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(audio[2], 48000, 1)))
            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(audio[3], 48000, 1)))
        self.assertEqual([call.args[0] for call in playback.stdin.write.call_args_list], audio)
        self.assertEqual(len(waits), 4)
        for actual, expected in zip(waits, [0.037, 0.030, 0.040, 0.040]):
            self.assertAlmostEqual(actual, expected)
        self.assertIsNone(transport.failure)

    async def test_interruption_discards_old_playback_before_new_audio(self):
        capture, old, new = self.child(3200), self.child(3300), self.child(3400)
        waits = asyncio.Queue()
        release = asyncio.Event()
        processes = iter([old, new])
        spawn_events = []
        now = 100.000

        async def spawn(*argv, **kwargs):
            if "--record" in argv:
                capture.stdout.feed_data(bytes(640))
                return capture
            child = next(processes)
            if child is new:
                self.assertIsNotNone(old.returncode, "Old playback must be reaped before new playback opens")
            spawn_events.append(child.pid)
            return child

        async def paced(duration):
            waits.put_nowait(duration)
            await release.wait()

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=AsyncMock(return_value=900)), on_stopped=Mock(), admission=None)
        self.addAsyncCleanup(transport.close)
        with (patch.object(speech.asyncio, "create_subprocess_exec", spawn),
              patch.object(speech, "monotonic", lambda: now), patch.object(speech, "sleep", paced)):
            await transport.open()
            self.assertIsNone(transport.playback)
            self.assertEqual(spawn_events, [])
            worker, observed = await self.pipeline(transport.output())
            unwritten_interrupted = asyncio.Event()

            async def interruption_processed(processor, frame, direction):
                unwritten_interrupted.set()

            await transport.output().queue_frame(InterruptionFrame(), callback=interruption_processed)
            await self.next_frame(observed, InterruptionFrame)
            await asyncio.wait_for(unwritten_interrupted.wait(), 5)
            self.assertIsNone(transport.playback)
            self.assertEqual(spawn_events, [])
            old.kill.assert_not_called()
            old.stdin.write.assert_not_called()
            await worker.queue_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1))
            self.assertAlmostEqual(await asyncio.wait_for(waits.get(), 5), 0.04)
            self.assertIs(transport.playback, old)
            self.assertEqual(spawn_events, [3300])
            now = 100.040
            release.set()
            completed = await self.next_frame(observed, TTSAudioRawFrame)
            self.assertEqual(completed.audio, b"P" * 3840)
            release.clear()
            await worker.queue_frames([TTSAudioRawFrame(b"A" * 7680, 48000, 1), TTSTextFrame("unheard old tail", aggregated_by="sentence")])
            self.assertAlmostEqual(await asyncio.wait_for(waits.get(), 5), 0.04)
            self.assertEqual(old.stdin.write.call_args_list, [((b"P" * 3840,), {}), ((b"A" * 3840,), {})])
            self.assertFalse(any(isinstance(frame, (TTSTextFrame, TTSAudioRawFrame)) for frame in observed._queue))
            now = 100.050
            await worker.queue_frame(InterruptionFrame())
            await self.next_frame(observed, InterruptionFrame)
            await worker.queue_frames([TTSAudioRawFrame(b"B" * 3840, 48000, 1), TTSTextFrame("new spoken reply", aggregated_by="sentence")])
            self.assertAlmostEqual(await asyncio.wait_for(waits.get(), 5), 0.04)
            self.assertEqual(spawn_events, [3300, 3400])
            old.kill.assert_called_once_with()
            old.wait.assert_awaited()
            old.stdin.close.assert_called_once_with()
            self.assertEqual(new.stdin.write.call_args_list, [((b"B" * 3840,), {})])
            self.assertFalse(any(isinstance(frame, (TTSTextFrame, TTSAudioRawFrame)) for frame in observed._queue))
            now = 100.090
            release.set()
            frame = await self.next_frame(observed, TTSAudioRawFrame)
            self.assertEqual(frame.audio, b"B" * 3840)
            spoken = await self.next_frame(observed, TTSTextFrame)
            self.assertEqual(spoken.text, "new spoken reply")
            self.assertEqual(old.stdin.write.call_count, 2, "Native interruption must drop the queued old chunk")
            self.assertIsNone(transport.failure)
            await worker.cancel()

    async def test_pipe_success_failure_and_partial_start_reap_children(self):
        real_spawn = asyncio.create_subprocess_exec
        for premature_exit in (False, True):
            with self.subTest(premature_exit=premature_exit):
                processes = []
                stopped = asyncio.Event()

                async def spawn(*argv, **kwargs):
                    prefix = argv[:argv.index("pw-cat")] if "stdbuf" not in argv else argv[:argv.index("stdbuf")]
                    if "--record" in argv:
                        code = 'import sys,signal;sys.stdout.buffer.write(b"C"*640);sys.stdout.flush();signal.pause()'
                    elif premature_exit:
                        code = 'import sys;sys.exit(7)'
                    else:
                        code = 'import sys,signal;data=sys.stdin.buffer.read(3840);sys.stdout.buffer.write(data);sys.stdout.flush();signal.pause()'
                        kwargs["stdout"] = asyncio.subprocess.PIPE
                    process = await real_spawn(*prefix, sys.executable, "-c", code, **kwargs)
                    processes.append(process)
                    return process

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=AsyncMock(return_value=900)), on_stopped=Mock(side_effect=stopped.set), admission=None)
                with patch.object(speech.asyncio, "create_subprocess_exec", spawn):
                    try:
                        await transport.open()
                        receipt = reply_record(object())
                        start = TTSStartedFrame()
                        start.reply_progress = receipt
                        await transport.output().write_transport_frame(start)
                        if premature_exit:
                            await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1))
                            await asyncio.wait_for(transport.playback.wait(), 5)
                            await asyncio.wait_for(stopped.wait(), 5)
                            self.assertEqual(transport.failure, "Audio playback failed. Restart Kestrel.")
                            transport.on_stopped.assert_called_once_with()
                            section = receipt.open_section('neutral')
                            queued = [TTSAudioRawFrame(bytes(3840), 48000, 1) for _ in range(2)]
                            for frame in queued:
                                receipt.stream_frame(frame, section)
                                transport.output().output_buffer.enter(frame, receipt)
                            self.assertFalse(await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                            self.assertTrue(receipt.output_failed())
                            # The failed write consumed the first queued chunk, so the next write is the second.
                            self.assertEqual(transport.output().output_buffer.written(TTSAudioRawFrame(bytes(3840), 48000, 1)),
                                             [receipt.source_range(queued[1])])
                        else:
                            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                            self.assertEqual(await asyncio.wait_for(transport.playback.stdout.readexactly(3840), 5), b"P" * 3840)
                            self.assertIsNone(transport.failure)
                            self.assertFalse(receipt.output_failed())
                            transport.output().write_gate.clear()
                            cancelled = asyncio.create_task(transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                            asyncio.get_running_loop().call_soon(cancelled.cancel)
                            with self.assertRaises(asyncio.CancelledError):
                                await cancelled
                            transport.output().write_gate.set()
                            self.assertTrue(receipt.output_failed())
                            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                            self.assertTrue(receipt.output_failed())
                            end = LLMFullResponseEndFrame()
                            end.reply_progress = receipt
                            await transport.output().write_transport_frame(end)
                            self.assertIsNone(transport.output().reply_progress)
                    finally:
                        await transport.close()
                        await transport.close()
                    for process in processes:
                        self.assertIsNotNone(process.returncode)

        for failed_spawn in (1, 2):
            with self.subTest(failed_spawn=failed_spawn):
                capture = self.child(3200)
                spawned = 0

                async def spawn(*argv, **kwargs):
                    nonlocal spawned
                    spawned += 1
                    if spawned == failed_spawn:
                        raise OSError("private external output")
                    capture.stdout.feed_data(bytes(640))
                    return capture

                active = None

                def shutdown_during_failure():
                    if failed_spawn == 2:
                        active.cancel()

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=AsyncMock(return_value=900)), on_stopped=Mock(side_effect=shutdown_during_failure), admission=None)
                with patch.object(speech.asyncio, "create_subprocess_exec", spawn):
                    if failed_spawn == 1:
                        active = asyncio.create_task(transport.open())
                    else:
                        await transport.open()
                        receipt = reply_record(object())
                        start = TTSStartedFrame()
                        start.reply_progress = receipt
                        await transport.output().write_transport_frame(start)
                        active = asyncio.create_task(transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                    with self.assertRaises((RuntimeError, asyncio.CancelledError)):
                        await active
                    if failed_spawn == 2:
                        self.assertTrue(receipt.output_failed())
                    await transport.close()
                    await transport.close()
                transport.on_stopped.assert_called_once_with()
                if failed_spawn == 2:
                    capture.kill.assert_called_once_with()
                    capture.wait.assert_awaited_once()
                    capture.stdin.close.assert_called_once_with()

        # The actual native sender owns write timeout and permanent-error classification.
        import bot
        capture, playback = self.child(3200), self.child(3300)
        blocked = asyncio.Event()
        error_seen = asyncio.Event()
        started = asyncio.Event()
        drain_entered = asyncio.Event()
        task = None

        async def drain():
            drain_entered.set()
            await blocked.wait()

        playback.stdin.drain = AsyncMock(side_effect=drain)

        def shutdown():
            if task is not None:
                task.cancel()

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=AsyncMock(return_value=900)), on_stopped=Mock(side_effect=shutdown), admission=None)
        transport.output()._params.audio_out_write_timeout_secs = 0.05

        @transport.output().event_handler("on_error")
        async def observe_error(processor, frame):
            self.assertFalse(processor.is_usable)
            error_seen.set()

        class Forward(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    started.set()
                await self.push_frame(frame, direction)

        stt = Forward()
        stt.load = AsyncMock()
        stt.close = AsyncMock()
        llm = Forward()
        llm.refresh_indicator = Mock()
        llm.indicator_input_ready = Mock()
        llm.indicator_output_started = Mock()
        llm.start_preparation = Mock()
        llm.conversation_output = Mock()
        llm.remember_assistant_reply = Mock()
        llm._assistant_reply_token = None
        llm.current_reply = Mock(return_value=None)
        llm.revoke = Mock()
        llm.local_actions = Mock(close=AsyncMock(), drain=AsyncMock())
        llm.channel = Mock(begin_conversation=AsyncMock(return_value=True), prepare=AsyncMock(), close=AsyncMock(), drain=AsyncMock(), known_unavailable=Mock(return_value=False), failure=None, preparation=None)
        stt.drain = AsyncMock()
        stt.failure = None

        def chunks(**kwargs):
            yield np.zeros(8, dtype=np.float32)

        async def spawn(*argv, **kwargs):
            if any(str(arg).endswith('/wakeword.py') for arg in argv):
                raise FileNotFoundError('Optional wake assets absent in playback fixture')
            if "--record" in argv:
                capture.stdout.feed_data(bytes(640))
                return capture
            return playback

        native_conversation = bot.run_conversation

        async def conversation(stt, voice, *, llm, transport, handle_signals, on_frame_completed, typed_origin, status=None, conversation=None, on_ingress_ready=None, on_reply_finished=None, input_paused=lambda: False):
            from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
            await native_conversation(stt, voice, llm=llm, transport=transport, on_frame_completed=on_frame_completed, typed_origin=typed_origin, status=status, conversation=conversation, on_ingress_ready=on_ingress_ready, on_reply_finished=on_reply_finished, input_paused=input_paused, user_params=bot.LLMUserAggregatorParams(
                user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
            ))

        prepared = asyncio.Event()
        output_watch = Mock(start=AsyncMock(), close=AsyncMock(), revision=0)
        native_prepare = bot.VoiceConversations.prepare

        async def prepare(manager):
            await native_prepare(manager)
            prepared.set()

        with (tempfile.TemporaryDirectory() as runtime,
              patch.dict(os.environ, XDG_RUNTIME_DIR=runtime, KESTREL_TTS_MODEL='voxcpm2'),
              patch.object(speech.asyncio, "create_subprocess_exec", spawn),
              patch.object(bot, "OutputDeviceWatch", return_value=output_watch),
              patch.object(bot, "LaptopAudioTransport", return_value=transport),
              patch.object(bot, "NemotronSTT", return_value=stt),
              patch.object(bot, "NemotronRecognizer", return_value=stt),
              patch.object(bot, "load_voice_preset", return_value=TEST_PRESET),
              patch.object(bot, "HermesRequestChannel", return_value=llm.channel),
              patch.object(bot, "LocalActions", return_value=llm.local_actions),
              patch.object(bot, "HermesLLMService", return_value=llm),
              patch.object(bot.VoiceConversations, "prepare", prepare),
              patch.object(bot.ECHO_REMOVAL, "start"), patch.object(bot.ECHO_REMOVAL, "close"),
              patch.object(bot.ECHO_REMOVAL, "process", None),
              patch.object(bot.VoxCPM, "from_pretrained", return_value=Mock(generate_streaming=chunks)),
              patch.object(bot, "run_conversation", conversation), patch.object(bot.torch, "set_num_threads")):
            task = asyncio.create_task(bot.run_voice_service())
            try:
                from desktop import control
                await asyncio.wait_for(prepared.wait(), 5)
                self.assertEqual(await control.toggle(), 'starting')
                await asyncio.wait_for(started.wait(), 5)
                receipt = reply_record(object())
                start = TTSStartedFrame()
                start.reply_progress = receipt
                await transport.output().write_transport_frame(start)
                await transport.output().queue_frame(TTSAudioRawFrame(b"W" * 3840, 48000, 1))
                await asyncio.wait_for(drain_entered.wait(), 5)
                await asyncio.wait_for(error_seen.wait(), 5)
                with self.assertRaisesRegex(RuntimeError, "Audio playback failed. Restart Kestrel"):
                    await asyncio.wait_for(task, 5)
                self.assertEqual(transport.failure, "Audio playback failed. Restart Kestrel.")
                self.assertTrue(receipt.output_failed())
                transport.on_stopped.assert_called_once_with()
                for child in (capture, playback):
                    child.kill.assert_called_once_with()
                    self.assertIsNotNone(child.returncode)
                stt.close.assert_awaited_once()
                output_watch.start.assert_awaited_once()
                output_watch.close.assert_awaited_once_with()
                llm.channel.close.assert_awaited_once()
                transport.fail("later failure")
                self.assertEqual(transport.failure, "Audio playback failed. Restart Kestrel.")
            finally:
                blocked.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await transport.close()

    async def test_audio_child_dies_when_its_parent_dies(self):
        parent_code = r"""
import asyncio, sys
from unittest.mock import Mock, AsyncMock
from pipecat.frames.frames import TTSAudioRawFrame
from speech import LaptopAudioTransport

async def main():
    original_spawn = asyncio.create_subprocess_exec
    async def spawn(*argv, **kwargs):
        prefix = argv[:argv.index("stdbuf")] if "--record" in argv else argv[:argv.index("pw-cat")]
        if "--record" in argv:
            code = 'import sys,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);sys.stdout.buffer.write(bytes(640));sys.stdout.flush();signal.pause()'
        else:
            code = 'import sys,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);signal.pause()'
            kwargs["stdout"] = asyncio.subprocess.PIPE
        return await original_spawn(*prefix, sys.executable, "-c", code, **kwargs)
    asyncio.create_subprocess_exec = spawn
    audio = LaptopAudioTransport(Mock(microphone_serial=AsyncMock(return_value=900)), on_stopped=lambda: None, admission=None)
    await audio.open()
    await audio.output().write_audio_frame(TTSAudioRawFrame(bytes(3840), 48000, 1))
    await audio.playback.stdout.readline()
    print(audio.capture.pid, audio.playback.pid, flush=True)
    await asyncio.Event().wait()

asyncio.run(main())
"""
        parent = await asyncio.create_subprocess_exec(sys.executable, "-c", parent_code, stdout=asyncio.subprocess.PIPE)
        children = []
        descriptors = []
        loop = asyncio.get_running_loop()
        try:
            line = await asyncio.wait_for(parent.stdout.readline(), 5)
            children = [int(value) for value in line.split()]
            self.assertEqual(len(children), 2)
            exited = []
            for pid in children:
                descriptor = os.pidfd_open(pid)
                descriptors.append(descriptor)
                done = asyncio.Event()
                loop.add_reader(descriptor, done.set)
                exited.append(done)
            self.assertTrue(all(not event.is_set() for event in exited))
            parent.kill()
            await asyncio.wait_for(parent.wait(), 5)
            for event in exited:
                await asyncio.wait_for(event.wait(), 5)
            self.assertEqual(parent.returncode, -signal.SIGKILL)
        finally:
            if parent.returncode is None:
                parent.kill()
                await parent.wait()
            for descriptor in descriptors:
                loop.remove_reader(descriptor)
                os.close(descriptor)
            for pid in children:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
