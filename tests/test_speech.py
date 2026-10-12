import asyncio
import json
import os
import subprocess
import threading
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    EndFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    StartFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStoppedFrame, TTSTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

import speech
from speech import NemotronSTT, VOICE_REFERENCE, VOICE_REFERENCE_TEXT, VoxCPMTTS


class RecognitionTests(unittest.IsolatedAsyncioTestCase):
    def service(self, response):
        service = NemotronSTT()
        service.process = Mock()
        service.process.stdin.drain = AsyncMock()
        service.process.stdout.readline = AsyncMock(return_value=response)
        return service

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
    async def test_sentences_and_reconnections_keep_the_same_voice_reference(self):
        model = Mock(generate_streaming=Mock(side_effect=lambda **kwargs: iter_chunks()))

        def iter_chunks():
            yield np.zeros(4800, dtype=np.float32)

        first_session = VoxCPMTTS(model)
        second_session = VoxCPMTTS(model)
        for service, text in [
            (first_session, "Hello."), (first_session, "How are you?"),
            (first_session, "Here is another reply."), (second_session, "Welcome back."),
        ]:
            frames = [frame async for frame in service.run_tts(text, "turn")]
            self.assertEqual(len(frames), 1)
        self.assertEqual(model.generate_streaming.call_count, 4)
        for call in model.generate_streaming.call_args_list:
            self.assertEqual(call.kwargs["reference_wav_path"], str(VOICE_REFERENCE))
            self.assertEqual(call.kwargs["prompt_wav_path"], str(VOICE_REFERENCE))
            self.assertEqual(call.kwargs["prompt_text"], VOICE_REFERENCE_TEXT)

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
            Pipeline([VoxCPMTTS(Mock(generate_streaming=chunks)), Sink()]),
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

        voice = VoxCPMTTS(Mock(generate_streaming=chunks))
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

        voice = VoxCPMTTS(Mock(generate_streaming=chunks))
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
        self.assertEqual(popen.return_value.wait.call_args_list, [call(timeout=speech.ECHO_REMOVAL_STOP_WAIT), call()])

    @staticmethod
    def node(node_id, name):
        return {"id": node_id, "type": "PipeWire:Interface:Node", "info": {"props": {"node.name": name}}}

    @staticmethod
    def link(output_node, input_node, state):
        return {
            "id": 100 + output_node, "type": "PipeWire:Interface:Link",
            "info": {"output-node-id": output_node, "input-node-id": input_node, "state": state},
        }

    def fault(self, graph=None, exit_code=None, **run_result):
        """Check an echo removal on doubles; return the fault and the patched `subprocess.run`."""
        echo_removal = speech.EchoRemoval()
        echo_removal.process = Mock()
        echo_removal.process.poll.return_value = exit_code
        if graph is not None:
            run_result["return_value"] = Mock(stdout=json.dumps(graph).encode())
        with patch.object(speech.subprocess, "run", **run_result) as run:
            return echo_removal.fault(), run

    def test_no_fault_when_a_program_records_from_the_kestrel_microphone(self):
        fault, run = self.fault([
            self.node(7, "alsa_output"), self.node(8, "kestrel-microphone"), self.node(9, "parec"),
            self.link(7, 8, "active"), self.link(8, 9, "active"),
        ])
        self.assertIsNone(fault)
        run.assert_called_once_with(["pw-dump"], capture_output=True, check=True, timeout=5)

    def test_fault_when_echo_removal_has_stopped(self):
        fault, run = self.fault(exit_code=1)
        self.assertEqual(fault, "Echo removal has stopped. Restart Kestrel.")
        run.assert_not_called()

    def test_fault_when_the_kestrel_microphone_is_missing(self):
        fault, _ = self.fault([self.node(7, "alsa_output"), self.node(9, "parec"), self.link(7, 9, "active")])
        self.assertEqual(
            fault, "The Kestrel microphone is missing from the audio system. Restart Kestrel."
        )

    def test_fault_when_no_program_records_from_the_kestrel_microphone(self):
        reason = (
            'No program is recording from "Kestrel microphone (echo removed)". '
            "Choose it as the microphone in the page and connect again."
        )
        for case, link in {
            "an active link from another node": self.link(7, 9, "active"),
            "a paused link from the Kestrel microphone": self.link(8, 9, "paused"),
        }.items():
            with self.subTest(case):
                fault, _ = self.fault([
                    self.node(7, "alsa_output"), self.node(8, "kestrel-microphone"), self.node(9, "parec"), link,
                ])
                self.assertEqual(fault, reason)

    def test_fault_when_the_audio_graph_cannot_be_read(self):
        unreadable = {
            "a non-zero exit": {"side_effect": subprocess.CalledProcessError(1, "pw-dump")},
            "a missing binary": {"side_effect": FileNotFoundError("pw-dump")},
            "a timeout": {"side_effect": subprocess.TimeoutExpired("pw-dump", 5)},
            "output that is not JSON": {"return_value": Mock(stdout=b"not json")},
            "JSON of another shape": {"return_value": Mock(stdout=b'{"unexpected": true}')},
            "a node with no information": {
                "return_value": Mock(stdout=json.dumps([
                    {"id": 8, "type": "PipeWire:Interface:Node", "info": None},
                ]).encode()),
            },
        }
        for case, run_result in unreadable.items():
            with self.subTest(case):
                fault, _ = self.fault(**run_result)
                self.assertTrue(fault.startswith("Echo removal could not be checked: "))


if __name__ == "__main__":
    unittest.main()
