import asyncio
from copy import deepcopy
import os
import signal
import sys
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    DataFrame, InterruptionFrame, LLMContextAssistantTurnFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

import bot
from test_hermes import NATIVE_PYTHON, ROOT, ScriptedBrain, WorkerProcess, require_native_hermes


class LocalMuteTests(unittest.IsolatedAsyncioTestCase):
    async def test_processor_excludes_speculative_nonuser_and_upstream_mute(self):
        cases = [
            ([{'role': 'user', 'content': 'mute'}], True, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': 'mute'}], False, FrameDirection.UPSTREAM),
            ([{'role': 'assistant', 'content': 'mute'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'system', 'content': 'mute'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'assistant', 'content': '', 'tool_calls': [
                {'type': 'function', 'function': {'name': 'mute', 'arguments': '{}'}},
            ]}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': 'mute'}]}], False, FrameDirection.DOWNSTREAM),
            ([], False, FrameDirection.DOWNSTREAM),
        ]
        for messages, speculative, direction in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Only a completed downstream text-user turn may act'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'This direct processor fixture has no engine'
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                command.assert_not_awaited()
                self.assertEqual(context.get_messages(), messages)

    async def test_processor_consumes_mute_before_await_and_cannot_replay_context(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])

        async def command(argv):
            calls.append(argv)
            if len(calls) == 1:
                started.set()
                await release.wait()
            return next(replies)

        service = bot.HermesLLMService(local_command=command)
        service.failure = 'This direct processor fixture has no engine'
        context = bot.LLMContext([{'role': 'user', 'content': 'mute'}])
        frame = LLMContextFrame(context)
        processing = asyncio.create_task(service.process_frame(frame, FrameDirection.DOWNSTREAM))
        try:
            await asyncio.wait_for(started.wait(), 5)
            self.assertEqual(context.get_messages(), [], 'Consumption precedes the first native-command await')
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 1, 'Replayed context cannot start another action while the first is pending')
            release.set()
            await asyncio.wait_for(processing, 5)
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 7)
            self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
            self.assertFalse(service.local_tasks)
        finally:
            release.set()
            await service.close_local_tools()
            if not processing.done():
                processing.cancel()
            await asyncio.gather(processing, return_exceptions=True)

    def test_only_exact_mute_selects_a_free_tool(self):
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute'})
        tool = bot.LOCAL_TOOLS['mute']
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        self.assertTrue(callable(tool.run))
        for text in ('mute', ' MUTE ', 'mute.', 'Mute!'):
            with self.subTest(text=text):
                self.assertIs(bot.match_instant_tool(text), tool)
        for text in ('mute?', '"mute"', 'mute!!', 'do not mute', 'mute this',
                     'unmute', 'please mute', 'mute; echo bad', '', 'mute\nnow'):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, mute=bot.LocalTool(permission, AsyncMock())):
                self.assertIsNone(bot.match_instant_tool('mute'))


    async def test_mute_sets_one_captured_sink_and_requires_readback(self):
        command = AsyncMock(side_effect=[
            'processing.sink\n', 'alsa_output.test\n', 'Mute: no\n', '',
            'processing.sink\n', 'alsa_output.test\n', 'Mute: yes\n',
        ])
        result = await bot.mute_output(command=command)
        self.assertTrue(result.confirmed)
        self.assertTrue(result.attempted)
        self.assertEqual(command.await_args_list, [
            call(('/usr/bin/pactl', 'get-default-sink')),
            call(('/usr/bin/omarchy-audio-output-sink', 'processing.sink')),
            call(('/usr/bin/pactl', 'get-sink-mute', 'alsa_output.test')),
            call(('/usr/bin/pactl', 'set-sink-mute', 'alsa_output.test', '1')),
            call(('/usr/bin/pactl', 'get-default-sink')),
            call(('/usr/bin/omarchy-audio-output-sink', 'processing.sink')),
            call(('/usr/bin/pactl', 'get-sink-mute', 'alsa_output.test')),
        ])


    async def test_already_muted_is_a_verified_noop(self):
        for after_default, after_sink, after_status, confirmed, reason in (
            ('selected', 'physical', 'Mute: yes', True, 'already muted'),
            ('changed', 'physical', 'Mute: yes', False, 'target changed'),
            ('selected', 'different', 'Mute: yes', False, 'target changed'),
            ('selected', 'physical', 'Mute: no', False, 'readback unconfirmed'),
        ):
            with self.subTest(reason=reason, target=(after_default, after_sink)):
                command = AsyncMock(side_effect=[
                    'selected\n', 'physical\n', 'Mute: yes\n',
                    after_default, after_sink, after_status,
                ])
                result = await bot.mute_output(command=command)
                self.assertEqual(result, bot.MuteResult(confirmed, False, reason))
                self.assertEqual(command.await_args_list, [
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', 'selected')),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', after_default)),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                ])

    async def test_corrupt_status_or_changed_target_is_unconfirmed_without_retry(self):
        hostile = ('', 'one\ntwo\n', 'a' * 257, '@DEFAULT_SINK@', '-option',
                   '.hidden', ':alias', 'name;touch file', 'name$(id)', 'speaker é',
                   'space name', 'name\n\n', 'name\r\n')
        cases = []
        for name in hostile:
            cases.append(([name], False, 1, 'invalid sink'))
            cases.append((['selected\n', name], False, 2, 'invalid sink'))
        for status in ('', 'Mute: unknown\n', 'Mute: yes\n\n', 'Mute: YES', ' Mute: no', 'Mute: no\r\n'):
            cases.append((['selected', 'physical', status], False, 3, 'invalid status'))
        prefix = ['selected', 'physical', 'Mute: no', '']
        cases.extend([
            (prefix + ['changed', 'physical', 'Mute: yes'], True, 7, 'target changed'),
            (prefix + ['selected', 'different', 'Mute: yes'], True, 7, 'target changed'),
            (prefix + ['selected', 'physical', 'Mute: no'], True, 7, 'readback unconfirmed'),
            (prefix + ['selected', 'physical', 'bad status'], True, 7, 'invalid status'),
            (['selected', 'physical', 'Mute: no', OSError('private error')], True, 4, 'command failed'),
            ([OSError('missing')], False, 1, 'command failed'),
            (prefix + [RuntimeError('private output')], True, 5, 'command failed'),
        ])
        for outputs, attempted, count, reason in cases:
            with self.subTest(outputs=outputs):
                command = AsyncMock(side_effect=outputs)
                result = await bot.mute_output(command=command)
                self.assertFalse(result.confirmed)
                self.assertEqual(result.attempted, attempted)
                self.assertEqual(result.reason, reason)
                self.assertEqual(command.await_count, count)
                writes = [c for c in command.await_args_list if c.args[0][1] == 'set-sink-mute']
                self.assertEqual(len(writes), int(attempted))
                if writes:
                    self.assertEqual(writes[0], call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')))
        started = asyncio.Event()
        stopped = asyncio.Event()
        commands = []

        async def hung(argv):
            commands.append(argv)
            if argv[1] == 'get-default-sink':
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if argv[1] == 'get-sink-mute':
                return 'Mute: no'
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        with patch.object(bot, 'MUTE_TIMEOUT', 0.01, create=True):
            result = await asyncio.wait_for(bot.mute_output(command=hung), 5)
        self.assertTrue(started.is_set())
        self.assertTrue(stopped.is_set())
        self.assertEqual(result, bot.MuteResult(False, True, 'mute timeout'))
        self.assertEqual(len(commands), 4)
        commands.clear()
        started.clear()
        stopped.clear()
        task = asyncio.create_task(bot.mute_output(command=hung))
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        self.assertEqual(len(commands), 4)


    async def test_local_command_is_bounded_and_cannot_inherit_remote_routing(self):
        poisoned = {'PATH': '/poison', 'LC_ALL': 'other', 'HOME': '/poison',
                    'PULSE_SERVER': 'tcp:remote', 'DBUS_SESSION_BUS_ADDRESS': 'tcp:remote',
                    'HTTP_PROXY': 'http://remote', 'PYTHONPATH': '/poison',
                    'XDG_RUNTIME_DIR': '/poison'}
        uid = os.getuid()
        env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
               'XDG_RUNTIME_DIR': f'/run/user/{uid}',
               'PULSE_SERVER': f'unix:/run/user/{uid}/pulse/native',
               'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus'}
        for output, exitcode, message in [
            (b'local\n', 0, None), (b'x' * 4097, 0, 'output too large'),
            (b'\xff', 0, 'invalid output'), (b'private text', 2, 'command failed'),
        ]:
            with self.subTest(message=message):
                process = Mock(pid=9876, returncode=exitcode)
                process.stdout.read = AsyncMock(side_effect=[output, b''])
                process.wait = AsyncMock(return_value=exitcode)
                with (patch.dict(os.environ, poisoned),
                      patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg') as killpg):
                    if message is None:
                        self.assertEqual(await bot.run_local_command(('/test/command', 'literal;arg')), 'local\n')
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^' + message + '$'):
                            await bot.run_local_command(('/test/command', 'literal;arg'))
                    spawn.assert_awaited_once_with(
                        '/test/command', 'literal;arg', env=env,
                        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
                    )
                    self.assertTrue(all(0 < c.args[0] <= 4097 for c in process.stdout.read.await_args_list))
                    if message:
                        self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
                    else:
                        killpg.assert_not_called()
        with patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(side_effect=FileNotFoundError())):
            with self.assertRaisesRegex(RuntimeError, '^command unavailable$'):
                await bot.run_local_command(('/missing/command',))

        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                started = asyncio.Event()
                stopped = asyncio.Event()
                reaped = asyncio.Event()
                process = Mock(pid=9876, returncode=None)

                async def read(size):
                    self.assertLessEqual(size, 4097)
                    started.set()
                    try:
                        await asyncio.Future()
                    finally:
                        stopped.set()

                async def wait():
                    if process.returncode is None:
                        await asyncio.Future()
                    reaped.set()
                    return process.returncode

                def signal_group(pid, sig):
                    self.assertEqual(pid, 9876)
                    if sig == signal.SIGKILL:
                        process.returncode = -signal.SIGKILL

                process.stdout.read = AsyncMock(side_effect=read)
                process.wait = AsyncMock(side_effect=wait)
                with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg', side_effect=signal_group) as killpg,
                      patch.object(bot, 'LOCAL_COMMAND_TIMEOUT', 0.01, create=True),
                      patch.object(bot, 'LOCAL_COMMAND_CLEANUP_TIMEOUT', 0.01, create=True)):
                    task = asyncio.create_task(bot.run_local_command(('/test/hung',)))
                    await asyncio.wait_for(started.wait(), 5)
                    if cancel:
                        task.cancel()
                    with self.assertRaises(asyncio.CancelledError if cancel else RuntimeError):
                        await asyncio.wait_for(task, 5)
                    self.assertTrue(stopped.is_set())
                    self.assertTrue(reaped.is_set())
                    self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
                    spawn.assert_awaited_once()

        # The leader can exit gracefully while a descendant ignores TERM.
        process = Mock(pid=9876, returncode=None)
        process.stdout.read = AsyncMock(return_value=b'x' * 4097)
        process.wait = AsyncMock(return_value=-signal.SIGTERM)
        descendant_alive = True

        def signal_descendant(pid, sig):
            nonlocal descendant_alive
            if sig == signal.SIGTERM:
                process.returncode = -signal.SIGTERM
            elif sig == signal.SIGKILL:
                descendant_alive = False

        with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)),
              patch.object(bot.os, 'killpg', side_effect=signal_descendant) as killpg):
            with self.assertRaisesRegex(RuntimeError, '^output too large$'):
                await bot.run_local_command(('/test/descendant',))
            self.assertFalse(descendant_alive)
            self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
            self.assertTrue(process.wait.await_count)


        cleanup_started = asyncio.Event()
        release_cleanup = asyncio.Event()
        reaped = asyncio.Event()
        process = Mock(pid=9876, returncode=None)
        process.stdout.read = AsyncMock(return_value=b'x' * 4097)

        async def wait_during_cleanup():
            cleanup_started.set()
            await release_cleanup.wait()
            reaped.set()
            return -signal.SIGTERM

        process.wait = AsyncMock(side_effect=wait_during_cleanup)
        with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)),
              patch.object(bot.os, 'killpg') as killpg):
            task = asyncio.create_task(bot.run_local_command(('/test/cleanup',)))
            await asyncio.wait_for(cleanup_started.wait(), 5)
            task.cancel()
            release_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
            self.assertTrue(reaped.is_set(), 'Cancellation must wait for native cleanup')
            self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])

    async def test_local_command_wire_success_and_failure(self):
        self.assertEqual(await bot.run_local_command((
            sys.executable, '-c', "print('local wire', flush=True)",
        )), 'local wire\n')
        real_spawn = asyncio.create_subprocess_exec
        processes = []

        async def spawn(*args, **kwargs):
            process = await real_spawn(*args, **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / 'child.pid'
            child = ("import os, signal, time; from pathlib import Path; "
                     "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                     f"Path({str(pid_path)!r}).write_text(str(os.getpid())); "
                     "print('ready', flush=True); time.sleep(60)")
            leader = ("import subprocess, sys; "
                      f"subprocess.Popen([sys.executable, '-c', {child!r}])")
            with (patch.object(bot.asyncio, 'create_subprocess_exec', spawn),
                  patch.object(bot, 'LOCAL_COMMAND_TIMEOUT', 0.5)):
                try:
                    with self.assertRaisesRegex(RuntimeError, '^command timeout$'):
                        await bot.run_local_command((sys.executable, '-c', leader))
                    self.assertEqual(len(processes), 1)
                    self.assertEqual(processes[0].returncode, 0)
                    fd = os.pidfd_open(int(pid_path.read_text()))
                    exited = asyncio.Event()
                    loop = asyncio.get_running_loop()
                    loop.add_reader(fd, exited.set)
                    try:
                        await asyncio.wait_for(exited.wait(), 5)
                    finally:
                        loop.remove_reader(fd)
                        os.close(fd)
                finally:
                    for process in processes:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await process.wait()


    async def test_notification_is_fixed_local_and_reports_unavailability(self):
        argv = ('/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
                '--hint=boolean:suppress-sound:true', 'Mute could not be confirmed',
                'Check the audio control. Kestrel will not retry.')
        command = AsyncMock(return_value='')
        with patch.object(bot.logger, 'error') as error:
            self.assertTrue(await bot.notify_mute_failure(command=command))
            command.assert_awaited_once_with(argv)
            error.assert_not_called()
        for failure in (OSError('private missing executable'), RuntimeError('private external output')):
            command = AsyncMock(side_effect=failure)
            with patch.object(bot.logger, 'error') as error:
                self.assertFalse(await bot.notify_mute_failure(command=command))
                command.assert_awaited_once_with(argv)
                error.assert_called_once_with('Mute failure notification unavailable')
        command = AsyncMock(side_effect=asyncio.CancelledError)
        with patch.object(bot.logger, 'error') as error:
            with self.assertRaises(asyncio.CancelledError):
                await bot.notify_mute_failure(command=command)
            command.assert_awaited_once_with(argv)
            error.assert_not_called()


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
    async def open_session(self, brain, *, wire=None, local_command=None):
        if brain is not None:
            require_native_hermes()
        started = asyncio.Event()
        spoken = asyncio.Queue()
        committed = asyncio.Queue()
        interrupted = asyncio.Event()
        processed = asyncio.Queue()

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
                elif type(frame) is DataFrame:
                    processed.put_nowait(frame)
                await self.push_frame(frame, direction)

        transport = Mock()
        transport.input.return_value = Input()
        transport.output.return_value = Output()
        transport.processed = processed
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
            self.assertEqual(command, (str(bot.HERMES_PYTHON), str(ROOT / 'hermes_worker.py')))
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
        if local_command is not None:
            def make_llm():
                transport.llm = bot.HermesLLMService(local_command=local_command)
                return transport.llm

            make_llm_patch = patch.object(bot, 'make_llm', make_llm)
            make_llm_patch.start()
            self.addCleanup(make_llm_patch.stop)
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
            if local_command is not None:
                make_llm_patch.stop()

        self.addAsyncCleanup(close)
        await asyncio.wait_for(started.wait(), 45)
        return transport, spoken, committed, interrupted, processes, close

    async def finish_user_turn(self, transport, text):
        await transport.input().queue_frame(
            TranscriptionFrame(text, '', '2026-01-01T00:00:00Z', finalized=True)
        )
        await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

    async def test_exact_mute_is_silent_with_an_unreachable_brain_and_stays_out_of_history(self):
        brain = ScriptedBrain([[({'content': 'Ordinary reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        completed = asyncio.Event()
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
        calls = []

        async def command(argv):
            calls.append(argv)
            result = next(replies)
            if len(calls) == 7:
                completed.set()
            return result

        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, ' MUTE! ')
        await asyncio.wait_for(completed.wait(), 5)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'An ordinary conversation turn.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary reply.')
        self.assertTrue(spoken.empty(), 'Confirmed mute emits no acknowledgement')
        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
        self.assertEqual(len(brain.requests), 1)
        request = brain.requests[0][2]
        self.assertEqual([m for m in request['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'An ordinary conversation turn.'},
        ])
        self.assertFalse(request.get('tools'))
        self.assertIn(
            'Kestrel handles the exact spoken command mute locally. You cannot invoke that action; '
            'for a request to mute, explain that the owner must say mute on its own.',
            ' '.join(m['content'] for m in request['messages'] if m['role'] == 'system'),
        )

    async def test_exact_mute_works_when_the_local_engine_is_missing(self):
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, _, _, processes, _ = await self.open_session(None, local_command=command)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'mute.')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(spoken.empty(), 'A handled mute must not speak an engine error')
            self.assertEqual(command.await_count, 7)
            self.assertEqual(command.await_args_list.count(
                call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')),
            ), 1)
            self.assertEqual(len(processes), 1)
            self.assertIsNone(processes[0][0])

    async def test_longer_mute_turn_waits_for_completion_and_reaches_brain_unchanged(self):
        brain = ScriptedBrain([[({'content': 'Ordinary longer reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('A longer turn cannot invoke a local command'))
        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await transport.input().queue_frame(
            TranscriptionFrame('mute', '', '2026-01-01T00:00:00Z', finalized=True),
        )
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        command.assert_not_awaited()
        self.assertEqual(brain.requests, [], 'A finalized segment is not a completed user turn')
        await self.finish_user_turn(transport, 'this phrase is ordinary conversation.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary longer reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary longer reply.')
        command.assert_not_awaited()
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'mute this phrase is ordinary conversation.'},
        ])

    async def test_mute_does_not_wait_for_interrupted_brain_work(self):
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def reply():
            yield {'content': 'One fact. Obsolete continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted interrupted reply was never released')
            yield {'content': ' must not be spoken.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([reply()])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        transport, spoken, committed, interrupted, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Tell me something.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        interrupted.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
        await self.finish_user_turn(transport, 'mute')
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(command.await_count, 7, 'Local mute completes before the blocked provider is released')
        self.assertFalse(release.is_set())
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        await asyncio.wait_for(asyncio.shield(transport.llm.reader), 5)
        self.assertTrue(spoken.empty(), 'Neither mute acknowledgement nor obsolete tail may be spoken')
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'Tell me something.'},
        ])

    async def test_unconfirmed_mute_speaks_and_notifies_without_retry(self):
        notification = (
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true', 'Mute could not be confirmed',
            'Check the audio control. Kestrel will not retry.',
        )
        failure = "I couldn't confirm mute. Check the audio control. I won't retry."
        for reason in ('readback', 'timeout', 'notification unavailable'):
            with self.subTest(reason=reason):
                calls = []
                replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: no'])

                async def command(argv):
                    calls.append(argv)
                    if argv[0] == '/usr/bin/notify-send':
                        if reason == 'notification unavailable':
                            raise RuntimeError('notification unavailable')
                        return ''
                    if reason == 'timeout' and argv[1] == 'set-sink-mute':
                        await asyncio.Event().wait()
                    return next(replies)

                with (patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')),
                      patch.object(bot, 'MUTE_TIMEOUT', 0.01 if reason == 'timeout' else 5)):
                    transport, spoken, committed, _, processes, close = await self.open_session(
                        None, local_command=command,
                    )
                    try:
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'mute')
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual([argv for argv in calls if argv[0] == '/usr/bin/notify-send'],
                                         [notification])
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), failure)
                        self.assertTrue(spoken.empty())
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'An ordinary unavailable-engine turn.')
                        context = await asyncio.wait_for(committed.get(), 5)
                        self.assertIn("couldn't reach Kestrel's engine", context)
                        self.assertNotIn(failure, context, 'Local failure speech is never committed to history')
                        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                        self.assertEqual(len(processes), 1)
                        self.assertIsNone(processes[0][0])
                    finally:
                        await close()

    async def test_interruption_finishes_attempted_mute_without_replay_and_disconnect_reaps_it(self):
        writes_started = asyncio.Event()
        release_write = asyncio.Event()
        cancelled = asyncio.Event()
        notified = asyncio.Event()
        calls = []
        action_tasks = []
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: no'])

        async def command(argv):
            calls.append(argv)
            if argv[0] == '/usr/bin/notify-send':
                notified.set()
                return ''
            if argv[1] == 'set-sink-mute':
                action_tasks.append(asyncio.current_task())
                writes_started.set()
                try:
                    await release_write.wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            return next(replies)

        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, interrupted, _, close = await self.open_session(None, local_command=command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(writes_started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertFalse(cancelled.is_set(), 'Speech interruption must not cancel an attempted local action')
                release_write.set()
                await asyncio.wait_for(notified.wait(), 5)
                await asyncio.wait_for(asyncio.shield(action_tasks[0]), 5)
                await self.finish_user_turn(transport, 'An ordinary follow-up after interruption.')
                context = await asyncio.wait_for(committed.get(), 5)
                self.assertIn("couldn't reach Kestrel's engine", context)
                heard = []
                while not spoken.empty():
                    heard.append(spoken.get_nowait())
                self.assertNotIn("couldn't confirm mute", ' '.join(heard), 'Detached actions cannot queue stale speech')
                self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                self.assertEqual(sum(argv[0] == '/usr/bin/notify-send' for argv in calls), 1)
                self.assertFalse(transport.llm.local_tasks)
            finally:
                release_write.set()
                await close()

            writes_started = asyncio.Event()
            cancelled = asyncio.Event()
            release_cleanup = asyncio.Event()
            cleaned = asyncio.Event()
            calls = []
            action_tasks = []
            replies = iter(['selected', 'physical', 'Mute: no'])

            async def hanging_command(argv):
                calls.append(argv)
                if argv[1] == 'set-sink-mute':
                    action_tasks.append(asyncio.current_task())
                    writes_started.set()
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        cancelled.set()
                        await release_cleanup.wait()
                        cleaned.set()
                        raise
                return next(replies)

            transport, _, _, _, _, close = await self.open_session(None, local_command=hanging_command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(writes_started.wait(), 5)
                closing = asyncio.create_task(close())
                await asyncio.wait_for(cancelled.wait(), 5)
                self.assertFalse(closing.done(), 'Disconnect must join command cleanup before finishing')
                release_cleanup.set()
                await asyncio.wait_for(closing, 5)
                self.assertTrue(cleaned.is_set())
                self.assertTrue(action_tasks[0].cancelled())
                self.assertFalse(transport.llm.local_tasks)
                self.assertEqual(calls, [
                    ('/usr/bin/pactl', 'get-default-sink'),
                    ('/usr/bin/omarchy-audio-output-sink', 'selected'),
                    ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
                    ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'),
                ], 'Disconnect launches no readback, retry, notification or unmute')
            finally:
                release_cleanup.set()
                await close()

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
