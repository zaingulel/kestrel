import asyncio
import os
import signal
import sys
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    InterruptionFrame, LLMContextAssistantTurnFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

import bot
from test_hermes import NATIVE_PYTHON, ScriptedBrain, WorkerProcess


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
    async def open_session(self, brain, *, wire=None):
        if brain is not None and not NATIVE_PYTHON.exists():
            if os.environ.get('CI'):
                self.skipTest('Installed Hermes interpreter absent in hosted environment')
            self.fail('Local installed Hermes interpreter unavailable')
        started = asyncio.Event()
        spoken = asyncio.Queue()
        committed = asyncio.Queue()
        interrupted = asyncio.Event()

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
                    spoken.put_nowait(frame.text)
                elif isinstance(frame, LLMContextAssistantTurnFrame) and direction == FrameDirection.UPSTREAM:
                    committed.put_nowait(frame.text.strip())
                elif isinstance(frame, InterruptionFrame):
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

        real_spawn = asyncio.create_subprocess_exec
        processes = []

        async def spawn(*command, **kwargs):
            home = Path(kwargs['env']['HERMES_HOME'])
            logger.debug(f'Owned session test home: {home}')
            if wire is not None:
                command = (sys.executable, '-c', wire)
            elif command[0] == str(NATIVE_PYTHON):
                command = WorkerProcess.command(home, brain)
            try:
                process = await real_spawn(*command, **kwargs)
            except OSError:
                processes.append((None, home))
                raise
            processes.append((process, home))
            return process

        direct = patch('pipecat.services.openai.llm.OpenAILLMService.get_chat_completions',
                       side_effect=RuntimeError('Direct brain bypass is prohibited in this native-session proof'))
        direct.start()
        self.addCleanup(direct.stop)
        spawn_patch = patch.object(bot.asyncio, 'create_subprocess_exec', spawn)
        spawn_patch.start()
        self.addCleanup(spawn_patch.stop)
        user_params = bot.LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
        )
        session = asyncio.create_task(bot.run_conversation(
            Mock(), bot.NemotronSTT(), Mock(generate_streaming=chunks),
            transport=transport, user_params=user_params,
        ))

        async def close():
            if not session.done():
                if not started.is_set():
                    session.cancel()
                else:
                    await handlers['on_client_disconnected'](transport, None)
            try:
                await asyncio.wait_for(session, 5)
            except asyncio.CancelledError:
                pass
            for process, home in processes:
                if process is not None:
                    self.assertIsNotNone(process.returncode)
                self.assertFalse(home.exists())
            spawn_patch.stop()

        self.addAsyncCleanup(close)
        await asyncio.wait_for(started.wait(), 45)
        return transport, spoken, committed, interrupted, processes, close

    async def finish_user_turn(self, transport, text):
        await transport.input().queue_frame(
            TranscriptionFrame(text, '', '2026-01-01T00:00:00Z', finalized=True)
        )
        await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

    async def test_missing_engine_waits_for_user_then_speaks_failure(self):
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, _ = await self.open_session(None)
            self.assertTrue(spoken.empty(), 'Startup failure must not make Kestrel speak first')
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Hello unavailable engine.')
            failure = await asyncio.wait_for(spoken.get(), 5)
            self.assertIn("couldn't reach Kestrel's engine", failure)
            self.assertIn('Reconnect', await asyncio.wait_for(spoken.get(), 5))
            self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(committed.get(), 5))
            self.assertEqual(len(processes), 1)
            self.assertIsNone(processes[0][0])

    async def assert_failed_reply(self, transport, spoken, committed, text, *, expected_advisory):
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, text)
        context = await asyncio.wait_for(committed.get(), 5)
        self.assertIn(expected_advisory, context)
        heard = []
        while not spoken.empty():
            heard.append(spoken.get_nowait())
        self.assertIn(expected_advisory, ' '.join(heard))
        return context

    async def test_dead_native_engine_speaks_failure(self):
        brain = ScriptedBrain([])
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        process, _ = processes[0]
        process.kill()
        await process.wait()
        await self.assert_failed_reply(transport, spoken, committed, 'Is anyone there?',
                                         expected_advisory="I couldn't reach Kestrel's engine. Reconnect and try again.")
        self.assertEqual(brain.requests, [])

    async def test_brain_refusal_speaks_failure_without_retry(self):
        brain = ScriptedBrain([400])
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        await self.assert_failed_reply(transport, spoken, committed, 'Answer this synthetic request.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Reconnect and try again.")
        self.assertIsNotNone(processes[0][0].returncode)
        await self.assert_failed_reply(transport, spoken, committed, 'Try another request.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Reconnect and try again.")
        self.assertEqual(len(brain.requests), 1, 'Broken sessions never silently restart or retry')

    async def test_partial_native_reply_speaks_failure(self):
        brain = ScriptedBrain([[({'content': 'Incomplete synthetic reply.'}, None), ({}, 'length')]] * 4)
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        context = await self.assert_failed_reply(transport, spoken, committed, 'Answer completely.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Reconnect and try again.")
        self.assertIn('Incomplete synthetic reply.', context)
        self.assertIsNotNone(processes[0][0].returncode)

    async def test_corrupt_worker_response_speaks_failure(self):
        # External process stand-ins cover malformed JSON and wrongly typed terminal events.
        cases = [
            ('malformed JSON', '{"ready":true}', 'not json'),
            ('wrong done type', '{"ready":true}', '{"text":"Synthetic prefix."}\n{"done":1}'),
            ('wrong ready type', '{"ready":1}', ''),
        ]
        for name, ready, response in cases:
            with self.subTest(name=name):
                wire = (f'import sys; print({ready!r}, flush=True); sys.stdin.readline(); '
                        f'print({response!r}, flush=True); sys.stdin.read()')
                transport, spoken, committed, _, processes, close = await self.open_session(None, wire=wire)
                try:
                    self.assertTrue(spoken.empty(), 'Even corrupt startup must not speak first')
                    if name == 'wrong ready type':
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'Answer over the wire.')
                        self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(committed.get(), 5))
                        self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(spoken.get(), 5))
                    else:
                        await self.assert_failed_reply(transport, spoken, committed, 'Answer over the wire.',
                                             expected_advisory="I couldn't reach Kestrel's engine. Reconnect and try again.")
                    self.assertIsNotNone(processes[0][0].returncode)
                finally:
                    await close()

    async def test_interrupted_partial_failure_is_reported_before_next_answer(self):
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def partial_reply():
            yield {'content': 'One fact. Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted partial reply was never released')
            yield {}, 'length'
            finished.set()

        brain = ScriptedBrain([partial_reply()] + [[({'content': 'Unheard tail.'}, None), ({}, 'length')]] * 3)
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        transport, spoken, committed, interrupted, processes, _ = await self.open_session(brain)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Tell me something.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        interrupted.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
        await self.finish_user_turn(transport, 'What next?')
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        context = await asyncio.wait_for(committed.get(), 5)
        self.assertIn("couldn't get a complete reply", context)
        self.assertNotIn('Unheard', context)
        heard = []
        while not spoken.empty():
            heard.append(spoken.get_nowait())
        self.assertIn("couldn't get a complete reply", ' '.join(heard))
        self.assertNotIn('Unheard', ' '.join(heard))
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(any(m.get('content') == 'What next?' for request in brain.requests
                             for m in request[2]['messages']), 'A failed drain cannot accept another engine turn')

    async def test_engine_startup_timeout_waits_for_user_then_speaks_failure(self):
        with patch.object(bot, 'ENGINE_TIMEOUT', 1, create=True):
            transport, spoken, committed, _, processes, close = await asyncio.wait_for(
                self.open_session(None, wire='import sys; sys.stdin.read()'), 5,
            )
            self.assertTrue(spoken.empty(), 'A hung startup must not speak first')
            await self.assert_failed_reply(
                transport, spoken, committed, 'Hello hung engine.',
                expected_advisory="I couldn't reach Kestrel's engine. Reconnect and try again.",
            )
            process, home = processes[0]
            self.assertIsNotNone(process.returncode)
            await close()
            self.assertFalse(home.exists())

    async def test_engine_turn_timeout_speaks_failure_and_reaps_worker(self):
        for interrupt in (False, True):
            with self.subTest(interrupted=interrupt), patch.object(bot, 'ENGINE_TIMEOUT', 1, create=True):
                wire = ("import sys; print('{\"ready\":true}', flush=True); sys.stdin.readline(); "
                        + ("print('{\"text\":\"One fact. Unheard continuation\"}', flush=True); " if interrupt else '')
                        + 'sys.stdin.read()')
                transport, spoken, committed, interrupted, processes, close = await asyncio.wait_for(
                    self.open_session(None, wire=wire), 5,
                )
                process, home = processes[0]
                try:
                    if interrupt:
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'Start the hung reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
                        interrupted.clear()
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await asyncio.wait_for(interrupted.wait(), 5)
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
                    context = await self.assert_failed_reply(
                        transport, spoken, committed, 'Answer while the engine is hung.',
                        expected_advisory="I couldn't reach Kestrel's engine. Reconnect and try again.",
                    )
                    self.assertNotIn('Unheard continuation', context)
                    self.assertIsNotNone(process.returncode)
                finally:
                    await close()
                self.assertFalse(home.exists())

    async def test_conversation_preserves_context_and_interrupts_reply(self):
        if not NATIVE_PYTHON.exists():
            if os.environ.get('CI'):
                self.skipTest('Installed Hermes interpreter absent in hosted environment')
            self.fail('Local installed Hermes interpreter unavailable')
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def second_reply():
            yield {'content': 'One fact. Obsolete continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted reply was never released')
            yield {'content': ' must not be spoken.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([
            [({'content': 'Hello.'}, None), ({}, 'stop')], second_reply(),
            [({'content': 'Next step.'}, None), ({}, 'stop')],
            [({'content': 'Fresh session.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        transport, spoken, committed, interrupted, processes, close = await self.open_session(brain)
        self.assertTrue(spoken.empty(), 'Kestrel never speaks first')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Hello Kestrel.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Hello.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Hello.')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Tell me more.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        interrupted.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
        self.assertIsNone(processes[0][0].returncode)
        await self.finish_user_turn(transport, 'Stop. What next?')
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5), 'Native generation must finish')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Next step.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Next step.')
        self.assertTrue(spoken.empty())
        histories = [[(m['role'], m['content'].strip()) for m in request[2]['messages']
                      if m['role'] != 'system'] for request in brain.requests]
        self.assertEqual(histories, [
            [('user', 'Hello Kestrel.')],
            [('user', 'Hello Kestrel.'), ('assistant', 'Hello.'), ('user', 'Tell me more.')],
            [('user', 'Hello Kestrel.'), ('assistant', 'Hello.'), ('user', 'Tell me more.'),
             ('assistant', 'One fact.'), ('user', 'Stop. What next?')],
        ])
        await close()
        transport, spoken, committed, _, _, _ = await self.open_session(brain)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'A new conversation.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh session.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh session.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'A new conversation.'}])


if __name__ == '__main__':
    unittest.main()
