import asyncio
from copy import deepcopy
import os
import signal
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from openai.types.chat import ChatCompletionChunk
from pipecat.frames.frames import (
    InterruptionFrame, LLMContextAssistantTurnFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

import bot


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fault = patch.object(bot.ECHO_REMOVAL, "fault", return_value=None)
        fault.start()
        self.addCleanup(fault.stop)
        retry = patch.object(bot, "ECHO_REMOVAL_RETRY", 0)
        retry.start()
        self.addCleanup(retry.stop)

    def arguments(self):
        connection = Mock()
        connection.handlers = {}

        def event_handler(name):
            def register(handler):
                connection.handlers[name] = handler
                return handler
            return register

        connection.event_handler.side_effect = event_handler
        connection.disconnect = AsyncMock()
        return Mock(webrtc_connection=connection)

    async def test_voice_weights_are_reused_between_sessions(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        model = object()
        args = self.arguments()
        with (
            patch.object(bot, "VOICE_MODEL", None),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot.VoxCPM, "from_pretrained", return_value=model) as load,
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            await bot.bot(args)
            await bot.bot(args)
            load.assert_called_once()
            self.assertEqual(conversation.await_count, 2)
            self.assertIs(conversation.await_args.args[2], model)
            self.assertEqual(stt.close.await_count, 2)
            self.assertEqual(args.webrtc_connection.disconnect.await_count, 2)

    async def test_model_load_failure_closes_worker_and_connection(self):
        stt = Mock(load=AsyncMock(side_effect=RuntimeError("load failed")), close=AsyncMock())
        args = self.arguments()
        with patch.object(bot, "NemotronSTT", return_value=stt):
            with self.assertRaisesRegex(RuntimeError, "load failed"):
                await bot.bot(args)
        stt.close.assert_awaited_once()
        args.webrtc_connection.disconnect.assert_awaited_once()
        self.assertFalse(bot.SESSION_LOCK.locked())

    async def test_microphone_session_is_refused_when_echo_removal_is_off(self):
        messages = []
        self.addCleanup(logger.remove, logger.add(messages.append, level="ERROR"))
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        args = self.arguments()
        with (
            patch.object(bot, "ECHO_REMOVAL_WAIT", 0),
            patch.object(bot.ECHO_REMOVAL, "fault", return_value="Echo removal has stopped. Restart Kestrel."),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
        ):
            # A hang guard, not a timing assertion.
            await asyncio.wait_for(bot.bot(args), 5)
        stt.load.assert_not_awaited()
        conversation.assert_not_awaited()
        args.webrtc_connection.disconnect.assert_awaited_once()
        self.assertIn("Echo removal has stopped. Restart Kestrel.", messages[0])
        self.assertFalse(bot.SESSION_LOCK.locked())

    async def test_microphone_session_is_accepted_once_the_page_starts_recording(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        args = self.arguments()
        with (
            patch.object(
                bot.ECHO_REMOVAL, "fault", side_effect=["Nothing is recording.", None]
            ) as fault,
            patch.object(bot, "VOICE_MODEL", object()),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            await bot.bot(args)
        conversation.assert_awaited_once()
        self.assertEqual(fault.call_count, 2)

    async def test_the_wait_for_echo_removal_ends_when_the_page_goes_away(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        args = self.arguments()
        loop = asyncio.get_running_loop()
        looked = asyncio.Event()

        def fault():
            # Runs on a worker thread.
            loop.call_soon_threadsafe(looked.set)
            return "Nothing is recording."

        with (
            patch.object(bot.ECHO_REMOVAL, "fault", side_effect=fault),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
        ):
            task = asyncio.create_task(bot.bot(args))
            # Both waits are hang guards, not timing assertions.
            await asyncio.wait_for(looked.wait(), 5)
            await args.webrtc_connection.handlers["closed"](args.webrtc_connection)
            await asyncio.wait_for(task, 5)
        stt.load.assert_not_awaited()
        conversation.assert_not_awaited()
        self.assertFalse(bot.SESSION_LOCK.locked())

    async def test_no_model_loads_when_the_page_goes_away_during_the_check(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        args = self.arguments()
        loop = asyncio.get_running_loop()

        def fault():
            # Runs on a worker thread: the page closes while this look is still running.
            connection = args.webrtc_connection
            asyncio.run_coroutine_threadsafe(connection.handlers["closed"](connection), loop).result()
            return None

        with (
            patch.object(bot.ECHO_REMOVAL, "fault", side_effect=fault),
            patch.object(bot, "VOICE_MODEL", object()),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            # A hang guard, not a timing assertion.
            await asyncio.wait_for(bot.bot(args), 5)
        stt.load.assert_not_awaited()
        conversation.assert_not_awaited()
        args.webrtc_connection.disconnect.assert_awaited_once()
        self.assertFalse(bot.SESSION_LOCK.locked())

    async def test_second_simultaneous_client_is_disconnected(self):
        args = self.arguments()
        async with bot.SESSION_LOCK:
            with patch.object(bot, "NemotronSTT") as stt:
                await bot.bot(args)
                stt.assert_not_called()
        args.webrtc_connection.disconnect.assert_awaited_once()

    async def test_active_conversation_ends_when_echo_removal_stops(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        args = self.arguments()
        started = asyncio.Event()
        ended = asyncio.Event()
        args.webrtc_connection.disconnect.side_effect = ended.set

        async def conversation(runner_args, stt, voice):
            started.set()
            await ended.wait()

        with (
            patch.object(bot, "VOICE_MODEL", object()),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", conversation),
            patch.object(bot.torch, "set_num_threads"),
            patch.object(bot.os, "kill") as kill,
        ):
            task = asyncio.create_task(bot.bot(args))
            # Both waits are hang guards, not timing assertions.
            await asyncio.wait_for(started.wait(), 5)
            await asyncio.to_thread(bot.stop_kestrel)
            await asyncio.wait_for(task, 5)
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)
        self.assertFalse(bot.SESSION_LOCK.locked())
        self.assertIsNone(bot.CONVERSATION)

    def test_idle_kestrel_is_told_to_stop_when_echo_removal_stops(self):
        with patch.object(bot.os, "kill") as kill:
            bot.stop_kestrel()
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)

    def test_echo_removal_runs_for_the_whole_voice_service(self):
        calls = Mock()
        with (
            patch.object(bot.ECHO_REMOVAL, "start", calls.start),
            patch.object(bot.ECHO_REMOVAL, "close", calls.close),
        ):
            bot.run_voice_service(calls.serve)
            self.assertEqual(
                calls.mock_calls, [call.start(bot.stop_kestrel), call.serve(), call.close()]
            )
            calls.reset_mock()
            calls.serve.side_effect = RuntimeError("serve failed")
            with self.assertRaisesRegex(RuntimeError, "serve failed"):
                bot.run_voice_service(calls.serve)
            self.assertEqual(
                calls.mock_calls, [call.start(bot.stop_kestrel), call.serve(), call.close()]
            )


class WholeConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_conversation_preserves_context_and_interrupts_reply(self):
        started = asyncio.Event()
        second_blocked = asyncio.Event()
        second_closed = asyncio.Event()
        interrupted = asyncio.Event()
        release_second = asyncio.Event()
        spoken_sentences = asyncio.Queue()
        committed_turns = asyncio.Queue()
        spoken = []
        observed_text = []
        requests = []

        class Input(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)

        class Output(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    started.set()
                elif isinstance(frame, TTSTextFrame) and direction == FrameDirection.DOWNSTREAM:
                    spoken.append(frame.text)
                    observed_text.append(frame.text)
                    spoken_sentences.put_nowait(frame.text)
                elif (
                    isinstance(frame, LLMContextAssistantTurnFrame)
                    and direction == FrameDirection.UPSTREAM
                ):
                    observed_text.append(frame.text)
                    committed_turns.put_nowait(frame.text)
                elif (
                    isinstance(frame, InterruptionFrame)
                    and direction == FrameDirection.DOWNSTREAM
                    and second_blocked.is_set()
                ):
                    interrupted.set()
                await self.push_frame(frame, direction)

        transport = Mock()
        transport.input.return_value = Input()
        transport.output.return_value = Output()
        handlers = {}

        def event_handler(name):
            def register(handler):
                handlers[name] = handler
                return handler
            return register

        transport.event_handler.side_effect = event_handler

        def chunks(**kwargs):
            yield np.zeros(4800, dtype=np.float32)

        llm = bot.make_llm()

        async def get_chat_completions(context):
            requests.append(deepcopy(context.messages))
            turn = len(requests)

            def chunk(text):
                return ChatCompletionChunk(
                    id=f"reply-{turn}", created=0, model="underdog-saluki-27b-1.0",
                    object="chat.completion.chunk",
                    choices=[{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                )

            async def stream():
                if turn == 1:
                    yield chunk("Hello.")
                elif turn == 2:
                    try:
                        yield chunk("One fact. Obsolete continuation")
                        second_blocked.set()
                        await release_second.wait()
                        yield chunk(" must not be spoken.")
                    finally:
                        second_closed.set()
                else:
                    yield chunk("Next step.")

            return stream()

        async def finish_user_turn(text):
            await transport.input().queue_frame(
                TranscriptionFrame(text, "", "2026-01-01T00:00:00Z", finalized=True)
            )
            # The native stop is a control frame, ordered behind the transcript.
            await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

        user_params = bot.LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
        )
        with (
            patch.object(bot, "make_llm", return_value=llm),
            patch.object(llm, "get_chat_completions", get_chat_completions),
        ):
            session = asyncio.create_task(bot.run_conversation(
                Mock(), bot.NemotronSTT(), Mock(generate_streaming=chunks),
                transport=transport, user_params=user_params,
            ))
            try:
                # All five-second waits are hang guards, never timing assertions.
                await asyncio.wait_for(started.wait(), 5)
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await finish_user_turn("Hello Kestrel.")
                self.assertEqual((await asyncio.wait_for(committed_turns.get(), 5)).strip(), "Hello.")
                self.assertEqual(await asyncio.wait_for(spoken_sentences.get(), 5), "Hello.")

                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await finish_user_turn("Tell me more.")
                self.assertEqual(await asyncio.wait_for(spoken_sentences.get(), 5), "One fact.")
                await asyncio.wait_for(second_blocked.wait(), 5)
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(second_closed.wait(), 5)
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertEqual((await asyncio.wait_for(committed_turns.get(), 5)).strip(), "One fact.")
                release_second.set()
                await finish_user_turn("Stop. What next?")
                self.assertEqual((await asyncio.wait_for(committed_turns.get(), 5)).strip(), "Next step.")

                self.assertEqual(spoken, ["Hello.", "One fact.", "Next step."])
                self.assertEqual(
                    [[(message["role"], message["content"].strip()) for message in history]
                     for history in requests],
                    [
                        [("user", "Hello Kestrel.")],
                        [("user", "Hello Kestrel."), ("assistant", "Hello."),
                         ("user", "Tell me more.")],
                        [("user", "Hello Kestrel."), ("assistant", "Hello."),
                         ("user", "Tell me more."), ("assistant", "One fact."),
                         ("user", "Stop. What next?")],
                    ],
                )
                for text in observed_text + [
                    message["content"] for history in requests for message in history
                ]:
                    self.assertNotIn("Obsolete continuation", text)
                    self.assertNotIn("must not be spoken", text)
            finally:
                release_second.set()
                await handlers["on_client_disconnected"](transport, None)
                await asyncio.wait_for(session, 5)


if __name__ == "__main__":
    unittest.main()
