import asyncio
import base64
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
import threading
import unittest
import wave
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    CancelFrame, DataFrame, EndFrame, InputAudioRawFrame, InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    StartFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStoppedFrame, TTSTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

import speech
from speech import NemotronSTT, VoicePreset, VoxCPMTTS, load_voice_preset


TEST_PRESET = VoicePreset("fixture", Path("/fixture/voice.wav"), "Fixture voice.", bytes(9600))


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
        self.assertEqual(preset.name, 'fixture')
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
                self.assertEqual((preset.name, preset.reference, preset.transcript, preset.pcm),
                                 (name, self.directory / (name + '.wav'), transcript, self.pcm))


class RecognitionTests(unittest.IsolatedAsyncioTestCase):
    def service(self, response):
        service = NemotronSTT()
        service.process = Mock()
        service.process.stdin.drain = AsyncMock()
        service.process.stdout.readline = AsyncMock(return_value=response)
        return service

    async def test_load_finishes_reference_inference_before_returning(self):
        service = NemotronSTT()
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
            patch.object(speech.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)),
        ):
            load = asyncio.create_task(service.load(pcm))
            load.add_done_callback(lambda completed: activity.set())
            try:
                await asyncio.wait_for(activity.wait(), 5)
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
                await service.close()

    async def test_load_rejects_unusable_reference_or_warmup_failure(self):
        process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.wait = AsyncMock()
        process.stdout.readline = AsyncMock(side_effect=[
            b'{"ready":true}\n', b'{"error":"preparation inference failed"}\n',
        ])
        service = NemotronSTT()
        with patch.object(speech.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            try:
                with self.assertRaisesRegex(RuntimeError, 'preparation inference failed'):
                    await service.load(bytes(9600))
                self.assertEqual(process.stdin.write.call_count, 1)
            finally:
                await service.close()

    async def test_transcript_is_finalized_and_audio_is_sent(self):
        service = self.service(b'{"text":"hello kestrel"}\n')
        frames = [frame async for frame in service.run_stt(b"audio")]
        self.assertEqual(len(frames), 1)
        self.assertIsInstance(frames[0], TranscriptionFrame)
        self.assertEqual(frames[0].text, "hello kestrel")
        self.assertTrue(frames[0].finalized)
        request = json.loads(service.process.stdin.write.call_args.args[0])
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


class VoiceTests(unittest.IsolatedAsyncioTestCase):
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
        for service, text in [
            (first_session, "Hello."), (first_session, "How are you?"),
            (first_session, "Here is another reply."), (second_session, "Welcome back."),
        ]:
            frames = [frame async for frame in service.run_tts(text, "turn")]
            self.assertEqual(len(frames), 1)
        self.assertEqual(model.generate_streaming.call_count, 4)
        for call in model.generate_streaming.call_args_list:
            self.assertEqual(call.kwargs["reference_wav_path"], str(TEST_PRESET.reference))
            self.assertEqual(call.kwargs["prompt_wav_path"], str(TEST_PRESET.reference))
            self.assertEqual(call.kwargs["prompt_text"], TEST_PRESET.transcript)

    async def test_two_sentences_finish_before_the_response_ends(self):
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

        worker = PipelineWorker(
            Pipeline([VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET), Sink()]),
            enable_rtvi=False, idle_timeout_secs=None,
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(started.wait(), 5)
            await worker.queue_frames([
                LLMFullResponseStartFrame(), LLMTextFrame("Hello. "),
                LLMTextFrame("I am listening."), LLMFullResponseEndFrame(),
            ])
            await asyncio.wait_for(finished.wait(), 5)
            spoken = [f.text for f in frames if isinstance(f, TTSTextFrame)]
            self.assertEqual(spoken, ["Hello.", "I am listening."])
            self.assertEqual(sum(isinstance(f, TTSAudioRawFrame) for f in frames), 2)
            self.assertEqual(sum(isinstance(f, TTSStoppedFrame) for f in frames), 1)
            end = next(i for i, f in enumerate(frames) if isinstance(f, LLMFullResponseEndFrame))
            self.assertTrue(all(i < end for i, f in enumerate(frames) if isinstance(f, TTSTextFrame)))
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

        voice = VoxCPMTTS(Mock(generate_streaming=chunks), TEST_PRESET)
        old_frames = []

        async def consume(text, frames):
            async for frame in voice.run_tts(text, text):
                frames.append(frame)

        old = asyncio.create_task(consume("old", old_frames))
        try:
            await entered.wait()
            old.cancel()
            # Let cancellation reach the pending GPU call while it is still blocked.
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertFalse(old.done())
            new_frames = []
            new = asyncio.create_task(consume("new", new_frames))
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await old
            await new
            self.assertEqual(len(old_frames), 1)
            self.assertNotIn(("old", "third"), events)
            self.assertLess(events.index(("old", "closed")), events.index(("new", "start")))
            self.assertEqual(len(new_frames), 3)
        finally:
            release.set()


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
            [((), {"timeout": speech.ECHO_REMOVAL_STOP_WAIT}), ((), {})],
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
        return [self.client(30, 3100), self.client(31, 3200),
                self.node(8, "kestrel-microphone", 30, 900),
                self.node(9, "kestrel-capture", 31, 901), self.link(8, 9, "active")]

    def serial(self, graph, capture_pid=3200):
        echo = speech.EchoRemoval()
        echo.process = Mock(pid=3100)
        echo.process.poll.return_value = None
        with patch.object(speech.subprocess, "run", return_value=Mock(stdout=json.dumps(graph).encode())) as run:
            result = echo.microphone_serial(capture_pid)
            run.assert_called_once_with(["pw-dump"], capture_output=True, check=True, timeout=5)
            return result

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
                    graph[0]["info"]["props"]["pipewire.sec.pid"] = 9999
                elif case == "foreign_capture":
                    graph[1]["info"]["props"]["pipewire.sec.pid"] = 9999
                elif case == "extra_incoming":
                    graph += [self.node(10, "raw-microphone", 30, 902), self.link(10, 9, "active")]
                elif case == "paused":
                    graph[-1]["info"]["state"] = "paused"
                elif case == "paused_second":
                    second_channel = self.link(8, 9, "paused")
                    second_channel["id"] = 109
                    graph.append(second_channel)
                elif case == "no_incoming":
                    graph.pop()
                else:
                    graph.pop(2)
                with self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                    self.serial(graph)
        self.assertEqual(self.messages, [])
    def test_malformed_graph_refuses_capture(self):
        bad = [None, {}, "private payload", [None]]
        for field, value in (("object.serial", True), ("client.id", "30"), ("object.serial", "900")):
            graph = self.graph()
            graph[2]["info"]["props"][field] = value
            bad.append(graph)
        for change in ("duplicate_id", "ambiguous_source", "ambiguous_capture", "pid_boolean", "missing_owner", "link_scalar"):
            graph = self.graph()
            if change == "duplicate_id":
                graph.append(self.client(30, 3100))
            elif change == "ambiguous_source":
                graph.append(self.node(10, "kestrel-microphone", 31, 902))
            elif change == "ambiguous_capture":
                graph.append(self.node(10, "other", 31, 902))
            elif change == "pid_boolean":
                graph[0]["info"]["props"]["pipewire.sec.pid"] = True
            elif change == "missing_owner":
                graph.pop(0)
            else:
                graph[-1]["info"]["output-node-id"] = "8"
            bad.append(graph)
        for graph in bad:
            with self.subTest(graph=graph), self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                self.serial(graph)
        echo = speech.EchoRemoval()
        echo.process = Mock(pid=3100, poll=Mock(return_value=None))
        for outcome in (FileNotFoundError("private payload"), subprocess.TimeoutExpired("pw-dump", 5),
                        subprocess.CalledProcessError(1, "pw-dump"), Mock(stdout=b"private payload")):
            kwargs = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
            with patch.object(speech.subprocess, "run", **kwargs), self.assertRaisesRegex(RuntimeError, "Restart Kestrel"):
                echo.microphone_serial(3200)
        echo.process.poll.return_value = 1
        with patch.object(speech.subprocess, "run") as run, self.assertRaisesRegex(RuntimeError, "has stopped"):
            echo.microphone_serial()
        run.assert_not_called()
        self.assertEqual(self.messages, [])



class LaptopAudioTests(unittest.IsolatedAsyncioTestCase):
    def child(self, pid):
        process = Mock(pid=pid, returncode=None)
        process.stdout = asyncio.StreamReader()
        process.stdin = Mock(drain=AsyncMock(), wait_closed=AsyncMock())

        exited = asyncio.Event()
        process.kill.side_effect = exited.set
        process.terminate.side_effect = exited.set

        async def wait():
            await exited.wait()
            process.returncode = -9
            return -9

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

        def serial(pid=None):
            if pid is not None:
                checked.set()
                if not release.wait(5):
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

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=Mock(side_effect=serial)), on_stopped=Mock())
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

    async def test_capture_failure_stops_without_fallback(self):
        for case in ("eof", "truncated", "missing", "timeout"):
            with self.subTest(case=case):
                capture = self.child(3200)
                stopped = asyncio.Event()
                requests = []

                def serial(pid=None):
                    if case == "missing":
                        raise RuntimeError("The owned microphone is missing. Restart Kestrel.")
                    return 900

                async def spawn(*argv, **kwargs):
                    requests.append(argv)
                    self.assertIn("--record", argv)
                    capture.stdout.feed_data(bytes(640))
                    return capture

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=serial), on_stopped=Mock(side_effect=stopped.set))
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
                        self.assertEqual(transport.failure, "Laptop microphone capture failed. Restart Kestrel.")
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
        transport = speech.LaptopAudioTransport(Mock(), on_stopped=Mock())
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

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=Mock(return_value=900)), on_stopped=Mock())
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

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=Mock(return_value=900)), on_stopped=Mock(side_effect=stopped.set))
                with patch.object(speech.asyncio, "create_subprocess_exec", spawn):
                    try:
                        await transport.open()
                        if premature_exit:
                            await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1))
                            await asyncio.wait_for(transport.playback.wait(), 5)
                            await asyncio.wait_for(stopped.wait(), 5)
                            self.assertEqual(transport.failure, "Laptop audio playback failed. Restart Kestrel.")
                            transport.on_stopped.assert_called_once_with()
                        else:
                            self.assertTrue(await transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                            self.assertEqual(await asyncio.wait_for(transport.playback.stdout.readexactly(3840), 5), b"P" * 3840)
                            self.assertIsNone(transport.failure)
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

                transport = speech.LaptopAudioTransport(Mock(microphone_serial=Mock(return_value=900)), on_stopped=Mock(side_effect=shutdown_during_failure))
                with patch.object(speech.asyncio, "create_subprocess_exec", spawn):
                    if failed_spawn == 1:
                        active = asyncio.create_task(transport.open())
                    else:
                        await transport.open()
                        active = asyncio.create_task(transport.output().write_audio_frame(TTSAudioRawFrame(b"P" * 3840, 48000, 1)))
                    with self.assertRaises((RuntimeError, asyncio.CancelledError)):
                        await active
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

        transport = speech.LaptopAudioTransport(Mock(microphone_serial=Mock(return_value=900)), on_stopped=Mock(side_effect=shutdown))
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
        llm.start_preparation = Mock()
        llm.close_local_tools = AsyncMock()
        llm.close_engine = AsyncMock()

        def chunks(**kwargs):
            yield np.zeros(8, dtype=np.float32)

        async def spawn(*argv, **kwargs):
            if "--record" in argv:
                capture.stdout.feed_data(bytes(640))
                return capture
            return playback

        native_conversation = bot.run_conversation

        async def conversation(stt, voice, *, llm, transport, handle_signals):
            from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
            await native_conversation(stt, voice, llm=llm, transport=transport, user_params=bot.LLMUserAggregatorParams(
                user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
            ))

        with (patch.object(speech.asyncio, "create_subprocess_exec", spawn),
              patch.object(bot, "LaptopAudioTransport", return_value=transport),
              patch.object(bot, "NemotronSTT", return_value=stt),
              patch.object(bot, "make_llm", return_value=llm),
              patch.object(bot.VoxCPM, "from_pretrained", return_value=Mock(generate_streaming=chunks)),
              patch.object(bot, "run_conversation", conversation), patch.object(bot.torch, "set_num_threads")):
            task = asyncio.create_task(bot.bot())
            try:
                await asyncio.wait_for(started.wait(), 5)
                await transport.output().queue_frame(TTSAudioRawFrame(b"W" * 3840, 48000, 1))
                await asyncio.wait_for(drain_entered.wait(), 5)
                await asyncio.wait_for(error_seen.wait(), 5)
                with self.assertRaisesRegex(RuntimeError, "Laptop audio playback failed. Restart Kestrel"):
                    await asyncio.wait_for(task, 5)
                self.assertEqual(transport.failure, "Laptop audio playback failed. Restart Kestrel.")
                transport.on_stopped.assert_called_once_with()
                for child in (capture, playback):
                    child.kill.assert_called_once_with()
                    self.assertIsNotNone(child.returncode)
                stt.close.assert_awaited_once()
                llm.close_engine.assert_awaited_once()
                transport.fail("later failure")
                self.assertEqual(transport.failure, "Laptop audio playback failed. Restart Kestrel.")
            finally:
                blocked.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await transport.close()

    async def test_audio_child_dies_when_its_parent_dies(self):
        parent_code = r"""
import asyncio, sys
from unittest.mock import Mock
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
    audio = LaptopAudioTransport(Mock(microphone_serial=Mock(return_value=900)), on_stopped=lambda: None)
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
