import asyncio
import os
import signal
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

from loguru import logger

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


if __name__ == "__main__":
    unittest.main()
