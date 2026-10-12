import asyncio
import os
import signal
import unittest
from unittest.mock import AsyncMock, Mock, patch

from loguru import logger

import bot


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fault = patch.object(bot.ECHO_REMOVAL, "fault", return_value=None)
        fault.start()
        self.addCleanup(fault.stop)

    def arguments(self):
        connection = Mock()
        connection.event_handler.side_effect = lambda name: lambda handler: handler
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
            patch.object(bot.ECHO_REMOVAL, "fault", return_value="Echo removal has stopped. Restart Kestrel."),
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
        ):
            await bot.bot(args)
        stt.load.assert_not_awaited()
        conversation.assert_not_awaited()
        args.webrtc_connection.disconnect.assert_awaited_once()
        self.assertIn("Echo removal has stopped. Restart Kestrel.", messages[0])
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


if __name__ == "__main__":
    unittest.main()
