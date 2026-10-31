import asyncio
from contextlib import asynccontextmanager, nullcontext
import json
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    InputAudioRawFrame, LLMFullResponseEndFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame, TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection

import bot
from conversation_fixtures import WholeConversationCase, wait_until
import reply_progress
import speech
from test_hermes import ScriptedBrain


# Two 1.0 scores in a row: the wake fires at the second.
WAKE_PHRASE_PCM = bytes([1]) * 1280
# What pw-dump reports when WirePlumber restarts: the old default metadata goes, then its replacement appears.
METADATA_REMOVED = json.dumps([{'id': 32, 'info': None}]).encode() + b'\n'
RESTARTED_METADATA = {'id': 40, 'type': 'PipeWire:Interface:Metadata', 'props': {'metadata.name': 'default'},
                      'metadata': [{'subject': 0, 'key': 'default.audio.sink', 'type': 'Spa:String:JSON',
                                    'value': {'name': 'A'}}]}
METADATA_REPLACED = json.dumps([RESTARTED_METADATA]).encode() + b'\n'
RESTARTED_GRAPH = [RESTARTED_METADATA, {'id': 10, 'type': 'PipeWire:Interface:Node', 'info': {'props': {
    'node.name': 'A', 'media.class': 'Audio/Sink', 'object.serial': 910,
}}}]
CAPTURE_LOST_LOG = 'Audio system restarted or microphone capture lost; reopening'
REOPENED_LOG = 'Microphone capture reopened.'
PAUSE_THAT_NEVER_ELAPSES = 3600
# Differs from the fixture's 900, so a serial remembered from an earlier opening cannot satisfy the test.
OWNED_SERIAL = 901


@asynccontextmanager
async def real_output_watch(manager):
    """Puts a real monitor on the service; the fixture's double would hide how a restart reaches the conversation."""
    watch = speech.OutputDeviceWatch()
    watch.metadata_id, watch.revision = 32, manager.output_watch.revision
    watch.process = Mock(stdout=asyncio.StreamReader(), returncode=None, wait=AsyncMock(return_value=0))
    manager.output_watch = watch
    watch.reader = asyncio.create_task(watch._watch(manager.output_changed, manager.output_watch_failed))
    try:
        yield watch.process.stdout
    finally:
        await watch.close()


def live_capture_children(service):
    return [child for child in service.audio_children if child.stdout is not None and child.returncode is None]


def conversation_recorders(service):
    # An activated session may first have opened a waiting recorder, depending on how quickly it was activated.
    return [child for child in service.audio_children if child.stdout is not None and not child.wake_capture]


class WholeConversationTests(WholeConversationCase):
    def log_lines(self):
        lines = []
        sink = logger.add(lambda message: lines.append(str(message)), format='{message}')
        self.addCleanup(logger.remove, sink)
        return lines

    async def next_waiting(self, service):
        try:
            return await asyncio.wait_for(service.waiting.get(), 5)
        except TimeoutError:
            self.fail('No fresh waiting capture arrived: '
                      f'wake_disabled={service.manager.wake_disabled}, failure={service.manager.failure!r}')

    async def wake_session(self, *replies, **options):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')], *replies])
        self.addCleanup(brain.close)
        session = await self.open_session(brain, through_service=True, native_audio=True, **options)
        return brain, session

    async def assert_waiting_resumes(self, case):
        lines = self.log_lines()
        brain, (handle, _, _, _, _, close) = await self.wake_session(activate=False)
        service = handle.service
        manager = service.manager
        try:
            first = await asyncio.wait_for(service.waiting.get(), 5)
            await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
            if case == 'restart':
                async with real_output_watch(manager) as monitor:
                    monitor.feed_data(METADATA_REMOVED)
                    await asyncio.wait_for(first.capture.reaped.wait(), 5)
                    monitor.feed_data(METADATA_REPLACED)
                    await self.assert_fresh_waiting_starts_conversation(service, brain, first, lines)
            elif case == 'end_of_stream':
                first.capture.stdout.feed_eof()
                await self.assert_fresh_waiting_starts_conversation(service, brain, first, lines)
            else:
                with patch.object(speech, 'LAPTOP_CAPTURE_STALL_TIMEOUT', 0.05):
                    first.capture.stdout.feed_data(bytes(640))
                    # Reader completion leaves the shortened stall bound before any replacement recorder can read.
                    await asyncio.wait({first.reader}, timeout=5)
                self.assertEqual(first.failure, speech.LAPTOP_CAPTURE_FAILURE)
                await self.assert_fresh_waiting_starts_conversation(service, brain, first, lines)
        finally:
            await close()

    async def assert_fresh_waiting_starts_conversation(self, service, brain, first, lines):
        manager = service.manager
        second = await self.next_waiting(service)
        self.assertIsNot(second, first)
        self.assertTrue(first.capture.reaped.is_set())
        self.assertTrue(first.reader.done())
        self.assertIs(manager.waiting_transport, second)
        self.assertIsNone(second.capture.returncode)
        self.assertIsNone(manager.failure)
        self.assertFalse(manager.wake_disabled)
        self.assertGreaterEqual(len(service.echo_generations), 2)
        self.assertFalse(any(speech.LAPTOP_CAPTURE_FAILURE in line for line in lines), lines)
        self.assertTrue(any(CAPTURE_LOST_LOG in line for line in lines), 'Losing capture must log the reopening')
        with patch.object(service.recognizer, 'transcribe', wraps=service.recognizer.transcribe) as recognition:
            second.capture.stdout.feed_data(bytes(640))
            second.capture.stdout.feed_data(WAKE_PHRASE_PCM)
            await asyncio.wait_for(service.started.get(), 5)
            self.assertTrue(second.capture.reaped.is_set(), 'Waiting recorder must exit before recognition')
            self.assertEqual(manager.conversation.turns, [])
            self.assertIsNone(service.recognizer.reader, 'Waiting PCM must not open ordinary recognition')
            recognition.assert_not_called()
            self.assertEqual(len(brain.requests), 1, 'Only fixed preparation, no waiting-audio request')

    async def assert_active_conversation_survives_restart(self):
        lines = self.log_lines()
        _, (transport, _, _, _, _, close) = await self.wake_session()
        manager = transport.service.manager
        try:
            await asyncio.shield(manager.session_ready)
            old_capture = transport.capture
            async with real_output_watch(manager) as monitor:
                monitor.feed_data(METADATA_REMOVED)
                await asyncio.wait_for(old_capture.reaped.wait(), 5)
                self.assertTrue(any(CAPTURE_LOST_LOG in line for line in lines), 'A restart must log the reopening')
                self.assertIsNone(manager.failure)
                monitor.feed_data(METADATA_REPLACED)
                await wait_until(lambda: not manager.switching_output, 'The handover never finished')
                self.assertIs(manager.transport, transport)
                self.assertIsNot(transport.capture, old_capture)
                self.assertTrue(transport.verified)
                self.assertFalse(manager.capture_recovery.recovering)
        finally:
            await close()

    async def assert_typed_only_restart_survives_failed_capture(self):
        reply = [({'content': '[delivery:neutral]\nTyped reply.'}, None), ({}, 'stop')]
        _, (handle, _, committed, _, _, close) = await self.wake_session(reply, activate=False)
        service = handle.service
        manager = service.manager
        try:
            first = await asyncio.wait_for(service.waiting.get(), 5)
            self.assertEqual(await service.submit('Typed request.'), 'accepted')
            typed = await asyncio.wait_for(service.started.get(), 5)
            fresh = await asyncio.wait_for(service.waiting.get(), 5)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed reply.')
            self.assertIsNot(fresh, first)
            self.assertIs(manager.transport, typed)
            self.assertIsNone(typed.capture)
            factory = bot.LaptopAudioTransport.side_effect
            refused = []

            def failing_once(*args, **kwargs):
                transport = factory(*args, **kwargs)
                if not refused:
                    transport._spawn = AsyncMock(side_effect=OSError('Native capture could not start'))
                    refused.append(transport)
                return transport

            async with real_output_watch(manager) as monitor:
                with patch.object(bot.LaptopAudioTransport, 'side_effect', side_effect=failing_once):
                    monitor.feed_data(METADATA_REMOVED)
                    await asyncio.wait_for(fresh.capture.reaped.wait(), 5)
                    monitor.feed_data(METADATA_REPLACED)
                    reopened = await self.next_waiting(service)
                self.assertEqual([transport.failure for transport in refused], [speech.LAPTOP_CAPTURE_FAILURE])
                self.assertFalse(manager.wake_disabled)
                self.assertIsNone(manager.failure)
                self.assertTrue(reopened.verified)
                await wait_until(lambda: not manager.capture_recovery.recovering, 'Recovery never ended')
        finally:
            await close()

    async def test_wake_listening_resumes_after_audio_system_restart(self):
        with patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0, create=True), \
                patch.object(speech, '_pipewire_graph', new=AsyncMock(return_value=RESTARTED_GRAPH)):
            for case in ('restart', 'end_of_stream', 'stall'):
                with self.subTest(case=case):
                    await self.assert_waiting_resumes(case)
            with self.subTest(case='restart_active'):
                await self.assert_active_conversation_survives_restart()
            with self.subTest(case='restart_typed_only_failed_capture'):
                await self.assert_typed_only_restart_survives_failed_capture()

    async def assert_recovery_log_lines(self, case):
        lines = self.log_lines()
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=False)
        service = handle.service
        manager = service.manager

        def logged(text):
            return sum(text in line for line in lines)

        try:
            if case == 'verified':
                first = await asyncio.wait_for(service.waiting.get(), 5)
                first.capture.stdout.feed_eof()
                await self.next_waiting(service)
                await wait_until(lambda: not manager.capture_recovery.recovering, 'Recovery never ended')
                self.assertEqual(logged(REOPENED_LOG), 1, lines)
            elif case == 'wake_disabled_during_recovery':
                first = await asyncio.wait_for(service.waiting.get(), 5)
                first.capture.stdout.feed_eof()
                await wait_until(lambda: logged(CAPTURE_LOST_LOG), 'The loss was never logged')
                manager.wake_failed()
                await wait_until(lambda: not manager.capture_recovery.recovering,
                                 'A disabled wake phrase left the recovery sticky')
                self.assertEqual(logged(CAPTURE_LOST_LOG), 1, lines)
                self.assertEqual(logged(REOPENED_LOG), 0, 'Nothing was reopened, so nothing may be logged as reopened')
            else:
                active = case == 'wake_disabled_active_restart'
                first = await asyncio.wait_for(service.waiting.get(), 5)
                await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
                manager.wake_failed()
                await asyncio.wait_for(first.capture.reaped.wait(), 5)
                if active:
                    self.assertEqual(await service.toggle(), 'starting')
                    transport = await asyncio.wait_for(service.started.get(), 5)
                    await asyncio.shield(manager.session_ready)
                echoes = len(service.echo_generations)
                async with real_output_watch(manager) as monitor:
                    monitor.feed_data(METADATA_REMOVED)
                    if active:
                        await asyncio.wait_for(transport.capture.reaped.wait(), 5)
                    monitor.feed_data(METADATA_REPLACED)
                    await wait_until(lambda: len(service.echo_generations) > echoes and not manager.switching_output,
                                     'The restarted audio system never got a fresh echo process')
                    if active:
                        await wait_until(lambda: not manager.capture_recovery.recovering, 'Recovery never ended')
                        self.assertTrue(transport.verified)
                        self.assertEqual(logged(CAPTURE_LOST_LOG), 1, lines)
                        self.assertEqual(logged(REOPENED_LOG), 1, lines)
                    else:
                        # The toggle round trip lets the run loop pass every check a false line could come from.
                        self.assertEqual(await service.toggle(), 'starting')
                        await asyncio.wait_for(service.started.get(), 5)
                        await asyncio.shield(manager.session_ready)
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(logged(REOPENED_LOG), 0, f'Nothing was open, so nothing was reopened: {lines}')
                        self.assertEqual(logged(CAPTURE_LOST_LOG), 0, lines)
                        self.assertFalse(manager.capture_recovery.recovering)
                        self.assertIsNone(manager.failure)
        finally:
            await close()

    async def test_recovery_log_lines_match_what_reopened(self):
        for case in ('verified', 'wake_disabled_restart', 'wake_disabled_during_recovery', 'wake_disabled_active_restart'):
            pause = PAUSE_THAT_NEVER_ELAPSES if case == 'wake_disabled_during_recovery' else 0
            with self.subTest(case=case), patch.object(bot, 'CAPTURE_RETRY_PAUSE', pause), \
                    patch.object(speech, '_pipewire_graph', new=AsyncMock(return_value=RESTARTED_GRAPH)):
                await self.assert_recovery_log_lines(case)

    async def assert_recovery_pause_yields(self, case):
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=False)
        service = handle.service
        manager = service.manager
        native_sleep = asyncio.sleep
        paused = asyncio.Event()

        async def sleep(delay, result=None):
            if delay == PAUSE_THAT_NEVER_ELAPSES:
                paused.set()
            return await native_sleep(delay, result)

        try:
            first = await asyncio.wait_for(service.waiting.get(), 5)
            original = manager.wake_startup
            with patch.object(bot.asyncio, 'sleep', side_effect=sleep):
                first.capture.stdout.feed_eof()
                try:
                    await asyncio.wait_for(paused.wait(), 5)
                except TimeoutError:
                    self.fail('A retry pause was never requested after the recorder ended: '
                              f'{service.waiting.qsize()} recorder(s) reopened with no pause')
                self.assertIsNot(manager.wake_startup, original)
                self.assertTrue(first.capture.reaped.is_set())
                self.assertFalse(manager.switching_output)
                self.assertTrue(service.waiting.empty(), 'The pause must hold no recorder')
                self.assertIsNone(manager.wake_detector.process, 'The pause must hold no worker')
                if case == 'shortcut':
                    self.assertEqual(await service.toggle(), 'starting')
                    active = await asyncio.wait_for(service.started.get(), 5)
                    self.assertIsNot(active, first)
                    self.assertTrue(active.verified)
                    self.assertTrue(first.capture.reaped.is_set())
                    self.assertIsNone(manager.wake_detector)
                    await wait_until(lambda: not manager.capture_recovery.recovering,
                                     'The verified conversation capture never counted as reopened')
                    self.assertEqual(await service.toggle(), 'inactive')
                    # A further pause would never elapse, so this arrival proves there was none.
                    await self.next_waiting(service)
                else:
                    await asyncio.wait_for(close(), 5)
                    self.assertIsNone(manager.wake_startup)
                    self.assertTrue(service.waiting.empty())
        finally:
            await close()

    async def assert_uncertain_recovery_cleanup_refuses(self):
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=False)
        service = handle.service
        manager = service.manager
        try:
            first = await asyncio.wait_for(service.waiting.get(), 5)
            detector = manager.wake_detector
            original_close = detector.close

            async def refuse_close():
                await original_close()
                raise RuntimeError('Wake capture cleanup failed. Restart Kestrel.')

            with patch.object(detector, 'close', side_effect=refuse_close):
                first.capture.stdout.feed_eof()
                await wait_until(lambda: manager.failure is not None, 'The uncertain cleanup was never reported')
                self.assertEqual(manager.failure, 'Wake capture cleanup failed. Restart Kestrel.')
                self.assertEqual(manager.trouble, 'trouble')
                self.assertEqual(await service.toggle(), 'unavailable')
                self.assertTrue(service.waiting.empty())
        finally:
            await close()

    async def assert_waiting_uncertain_cleanup_is_final(self):
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=False)
        service = handle.service
        manager = service.manager
        serial = AsyncMock(side_effect=speech.PipeWireGraphCleanupFailure(speech.OUTPUT_SWITCH_FAILURE))
        try:
            first = await asyncio.wait_for(service.waiting.get(), 5)
            with patch.object(bot.ECHO_REMOVAL, 'microphone_serial', serial):
                first.capture.stdout.feed_eof()
                await wait_until(lambda: manager.failure is not None, 'The uncertain cleanup was never reported')
                self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                self.assertEqual(manager.trouble, 'trouble')
                self.assertEqual(await service.toggle(), 'unavailable')
                self.assertEqual(await service.submit('Typed after the failure.'), 'unavailable')
                self.assertEqual(serial.await_count, 1, 'The reopening must not be retried after uncertain cleanup')
        finally:
            await close()

    async def assert_first_opening_uncertain_cleanup_disables_wake(self):
        serial = AsyncMock(side_effect=speech.PipeWireGraphCleanupFailure(speech.OUTPUT_SWITCH_FAILURE))
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=False, microphone_serial=serial)
        manager = handle.service.manager
        try:
            await wait_until(lambda: manager.wake_disabled or manager.failure is not None,
                             'The first opening never reported its uncertain cleanup')
            self.assertEqual(serial.await_count, 1, 'The first opening must reach the raising microphone source')
            self.assertTrue(manager.wake_disabled)
            self.assertIsNone(manager.failure)
            self.assertFalse(manager.capture_recovery.recovering)
        finally:
            await close()

    async def test_capture_recovery_yields_to_shortcut_and_shutdown(self):
        with patch.object(bot, 'CAPTURE_RETRY_PAUSE', PAUSE_THAT_NEVER_ELAPSES, create=True):
            for case in ('shortcut', 'shutdown'):
                with self.subTest(case=case):
                    await self.assert_recovery_pause_yields(case)
            with self.subTest(case='uncertain_cleanup'):
                await self.assert_uncertain_recovery_cleanup_refuses()
            with self.subTest(case='waiting_uncertain_cleanup_is_final'), patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0):
                await self.assert_waiting_uncertain_cleanup_is_final()
            with self.subTest(case='first_opening_uncertain_cleanup_disables_wake'):
                await self.assert_first_opening_uncertain_cleanup_disables_wake()

    def assert_owned_capture(self, recorder, output_serial):
        argv = recorder.argv
        self.assertEqual(argv[argv.index('--target') + 1], str(OWNED_SERIAL))
        properties = json.loads(argv[argv.index('--properties') + 1])
        for name in ('node.dont-fallback', 'node.dont-move', 'node.dont-reconnect'):
            self.assertIs(properties[name], True, name)
        bot.ECHO_REMOVAL.microphone_serial.assert_any_await(recorder.pid, output_serial=output_serial)

    async def assert_capture_reopens_through_owned_source(self, route, refusing):
        _, (handle, _, _, _, _, close) = await self.wake_session(activate=route == 'active')
        service = handle.service
        manager = service.manager
        serial = bot.ECHO_REMOVAL.microphone_serial
        refused = []

        async def source(pid=None, *, output_serial=None):
            # The recorder is refused while holding wake audio, so a refusal that still listens would be caught.
            if pid is None:
                return OWNED_SERIAL
            if not refused or pid == refused[0]:
                if not refused:
                    refused.append(pid)
                    recorder = next(c for c in service.audio_children if c.pid == pid)
                    recorder.stdout.feed_data(WAKE_PHRASE_PCM)
                    await wait_until(lambda: not recorder.stdout._buffer, 'The refused recorder was never read')
                raise RuntimeError('The owned microphone is missing. Restart Kestrel.')
            return OWNED_SERIAL

        if route == 'waiting':
            spy = patch.object(bot.WakeWordDetector, 'submit', autospec=True, side_effect=bot.WakeWordDetector.submit)
        else:
            spy = patch.object(handle.input(), 'push_audio_frame', wraps=handle.input().push_audio_frame)
        timeout = 0.2 if refusing else speech.LAPTOP_AUDIO_START_TIMEOUT
        try:
            if route == 'waiting':
                lost = (await asyncio.wait_for(service.waiting.get(), 5)).capture
                await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
            else:
                await asyncio.shield(manager.session_ready)
                lost = handle.capture
            serial.return_value = OWNED_SERIAL
            if refusing:
                serial.side_effect = source
            with spy as heard, patch.object(speech, 'LAPTOP_AUDIO_START_TIMEOUT', timeout):
                lost.stdout.feed_eof()
                if route == 'waiting':
                    fresh = (await self.next_waiting(service)).capture
                else:
                    def reopened():
                        fresh = handle.capture
                        return (fresh is not None and fresh is not lost and fresh.pid not in refused
                                and bool(refused) == refusing and handle.verified and not manager.switching_output)

                    await wait_until(reopened, 'Capture never reopened')
                    fresh = handle.capture
                    self.assertIs(manager.transport, handle)
                self.assertIsNot(fresh, lost)
                self.assert_owned_capture(fresh, 800 if route == 'active' else None)
                self.assertIsNone(manager.failure)
                if refusing:
                    refused_recorder = next(c for c in service.audio_children if c.pid == refused[0])
                    self.assertIsNot(fresh, refused_recorder)
                    heard.assert_not_called()
                    if route == 'active':
                        self.assertIsNone(manager.wake_detector)
                    else:
                        self.assertTrue(service.started.empty(), 'A refused recorder must not start a conversation')
                        self.assertTrue(refused_recorder.reaped.is_set())
                        # The same audio on the verified recorder wakes, so the silence above was the refusal.
                        fresh.stdout.feed_data(bytes(640))
                        fresh.stdout.feed_data(WAKE_PHRASE_PCM)
                        await asyncio.wait_for(service.started.get(), 5)
                        heard.assert_called()
        finally:
            await close()

    async def test_capture_reopens_only_through_the_owned_source(self):
        with patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0):
            for case in ('waiting', 'waiting_refused', 'active', 'active_refused'):
                with self.subTest(case=case):
                    await self.assert_capture_reopens_through_owned_source(case.split('_')[0], case.endswith('_refused'))

    async def lose_active_capture(self, case, transport, monitor):
        lost = transport.capture
        if case == 'stall':
            with patch.object(speech, 'LAPTOP_CAPTURE_STALL_TIMEOUT', 0.05):
                lost.stdout.feed_data(bytes(640))
                # Reader completion leaves the shortened stall bound before any replacement recorder can read.
                await asyncio.wait({transport.reader}, timeout=5)
        elif case == 'removal_before_stream_end':
            monitor.feed_data(METADATA_REMOVED)
            lost.stdout.feed_eof()
        else:
            lost.stdout.feed_eof()
            if case == 'stream_ends_before_removal':
                monitor.feed_data(METADATA_REMOVED)
        if case in ('stream_ends_before_removal', 'removal_before_stream_end'):
            await asyncio.wait_for(lost.reaped.wait(), 5)
            monitor.feed_data(METADATA_REPLACED)

    async def assert_conversation_reopens(self, case):
        lines = self.log_lines()
        reply = [({'content': '[delivery:neutral]\nStill here.'}, None), ({}, 'stop')]
        _, (transport, spoken, _, _, _, close) = await self.wake_session(reply)
        service = transport.service
        manager = service.manager
        refused = []
        route_checks = []
        native_spawn = transport._spawn

        async def refuse_first_recorder(*argv, **kwargs):
            if '--record' in argv and not refused:
                refused.append(argv)
                raise OSError('Native capture could not start')
            return await native_spawn(*argv, **kwargs)

        async def lose_fresh_capture_during_route_check(pid=None):
            route_checks.append(pid)
            if len(route_checks) == 2:
                transport.capture.stdout.feed_eof()
                await asyncio.wait({transport.reader}, timeout=5)
            return 800

        try:
            await asyncio.shield(manager.session_ready)
            lost = transport.capture
            if case == 'replacement_refused_then_reopens':
                transport._spawn = refuse_first_recorder
            route = (patch.object(bot.ECHO_REMOVAL, 'output_serial',
                                  new=AsyncMock(side_effect=lose_fresh_capture_during_route_check))
                     if case == 'lost_during_route_check' else nullcontext())

            def reopened():
                # A removal leaves no metadata until its replacement is read, and that replacement starts a handover.
                return (manager.output_watch.metadata_id is not None and transport.capture is not None
                        and transport.capture is not lost and transport.verified
                        and not manager.switching_output and not manager.capture_recovery.recovering)

            async with real_output_watch(manager) as monitor:
                with route:
                    await self.lose_active_capture(case, transport, monitor)
                    try:
                        await wait_until(reopened, 'Capture never reopened')
                    except AssertionError:
                        self.fail(f'Capture never reopened: failure={manager.failure!r}, trouble={manager.trouble!r}, '
                                  f'desired_active={manager.desired_active}')
                self.assertIs(manager.transport, transport)
                self.assertTrue(manager.desired_active)
                self.assertIsNone(manager.failure)
                self.assertIsNone(manager.trouble)
                self.assertFalse(manager.capture_recovery.recovering)
                self.assertTrue(transport.verified)
                self.assertFalse(any(speech.LAPTOP_CAPTURE_FAILURE in line for line in lines), lines)
                self.assertTrue(any(CAPTURE_LOST_LOG in line for line in lines), 'Losing capture must log the reopening')
                self.assertEqual(live_capture_children(service), [transport.capture])
                if case == 'replacement_refused_then_reopens':
                    self.assertEqual(len(refused), 1)
                await self.speak_request(transport, 'Are you still there?')
                await self.hear_exactly(spoken, 'Still here.')
        finally:
            await close()

    async def assert_uncertain_cleanup_is_final(self):
        _, (transport, _, _, _, _, close) = await self.wake_session()
        service = transport.service
        manager = service.manager

        async def source(pid=None, *, output_serial=None):
            if pid is None:
                return 900
            raise speech.PipeWireGraphCleanupFailure(speech.OUTPUT_SWITCH_FAILURE)

        serial = AsyncMock(side_effect=source)
        try:
            await asyncio.shield(manager.session_ready)
            with patch.object(bot.ECHO_REMOVAL, 'microphone_serial', serial):
                transport.capture.stdout.feed_eof()
                await wait_until(lambda: manager.failure is not None, 'The uncertain cleanup was never reported')
                self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                self.assertEqual(manager.trouble, 'trouble')
                self.assertFalse(manager.desired_active)
                self.assertEqual(await service.toggle(), 'unavailable')
                self.assertEqual(await service.submit('Typed after the failure.'), 'unavailable')
                recorders = conversation_recorders(service)
                self.assertEqual(len(recorders), 2, 'The original and one replacement, with no later reopening')
                for capture in recorders:
                    self.assertTrue(capture.reaped.is_set())
                self.assertEqual(len([call for call in serial.await_args_list if call.args and call.args[0] is not None]), 1)
        finally:
            await close()

    async def test_microphone_loss_during_conversation_reopens(self):
        with patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0), \
                patch.object(speech, '_pipewire_graph', new=AsyncMock(return_value=RESTARTED_GRAPH)):
            for case in ('stream_ends_before_removal', 'removal_before_stream_end', 'stall',
                         'replacement_refused_then_reopens', 'lost_during_route_check'):
                with self.subTest(case=case):
                    await self.assert_conversation_reopens(case)
            with self.subTest(case='uncertain_cleanup_is_final'):
                await self.assert_uncertain_cleanup_is_final()

    async def assert_reopening_yields(self, case):
        _, (transport, _, _, _, _, close) = await self.wake_session()
        service = transport.service
        manager = service.manager
        native_wait_for = asyncio.wait_for
        paused = asyncio.Event()

        async def wait_for(awaitable, timeout):
            if timeout == PAUSE_THAT_NEVER_ELAPSES:
                paused.set()
            return await native_wait_for(awaitable, timeout)

        try:
            await asyncio.shield(manager.session_ready)
            lost = transport.capture
            with patch.object(bot.asyncio, 'wait_for', side_effect=wait_for):
                waiting_before = service.waiting.qsize()
                lost.stdout.feed_eof()
                try:
                    await asyncio.wait_for(paused.wait(), 5)
                except TimeoutError:
                    self.fail(f'A reopening pause was never requested: failure={manager.failure!r}, '
                              f'trouble={manager.trouble!r}, recorders={len(conversation_recorders(service))}')
                self.assertTrue(lost.reaped.is_set())
                self.assertIsNone(transport.capture)
                self.assertEqual(conversation_recorders(service), [lost], 'The pause must hold no recorder')
                self.assertEqual(live_capture_children(service), [], 'The pause must hold no recorder')
                self.assertEqual(await service.submit('Typed during the reopening.'), 'busy')
                if case == 'dismissal':
                    self.assertEqual(await service.toggle(), 'inactive')
                    await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                    await wait_until(lambda: manager.transport is None, 'The dismissed conversation never finished')
                    self.assertIsNone(manager.failure)
                    self.assertEqual(service.waiting.qsize(), waiting_before, 'Dismissal during the pause must queue no new waiting recorder')
                else:
                    await asyncio.wait_for(close(), 5)
        finally:
            await close()

    async def test_reopening_yields_to_dismissal_and_shutdown(self):
        with patch.object(bot, 'CAPTURE_RETRY_PAUSE', PAUSE_THAT_NEVER_ELAPSES):
            for case in ('dismissal', 'shutdown'):
                with self.subTest(case=case):
                    await self.assert_reopening_yields(case)

    async def test_thats_all_ends_conversation_without_brain_request_or_activation(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFirst.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nSecond.'}, None), ({}, 'stop')],
            # Requested only if a that's all turn reaches the brain.
            [({'content': '[delivery:neutral]\nUnwanted reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        manager = service.manager
        startup_waiting = await asyncio.wait_for(service.waiting.get(), 5)
        self.assertEqual(await service.toggle(), 'starting')
        transport = await asyncio.wait_for(service.started.get(), 5)
        transport.capture.stdout.feed_data(bytes(640))
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Hello.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'First.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'First.')
        transport.capture.stdout.feed_data(bytes(640))
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, "That's all.")
        await asyncio.wait_for(service.state('inactive'), 2)
        cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
        await asyncio.wait_for(asyncio.shield(cleanup), 5)
        self.assertFalse(manager.desired_active)
        self.assertEqual(manager.status._state, 'inactive')
        self.assertEqual(manager.conversation.turns, [])
        self.assertIsNone(manager.transport)
        self.assertTrue(transport.capture.reaped.is_set())
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        self.assertEqual(len(brain.requests), 2)
        rearmed = await asyncio.wait_for(service.waiting.get(), 5)
        self.assertIsNot(rearmed, startup_waiting)
        self.assertEqual(await service.submit('Typed A'), 'accepted')
        typed = await asyncio.wait_for(service.started.get(), 5)
        self.assertIsNone(typed.capture)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Second.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Second.')
        self.assertEqual(await service.submit("that's all"), 'accepted')
        cleanup = await asyncio.wait_for(asyncio.shield(typed.cleanup_finished), 5)
        await asyncio.wait_for(asyncio.shield(cleanup), 5)
        self.assertFalse(manager.desired_active)
        self.assertEqual(manager.status._state, 'inactive')
        self.assertEqual(manager.conversation.turns, [])
        self.assertIsNone(manager.transport)
        self.assertEqual(len(service.sessions), 2)
        self.assertTrue(service.started.empty())
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        self.assertEqual(len(brain.requests), 3)
        await close()

    async def test_wake_waiting_audio_is_private_and_starts_fresh(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        actions = AsyncMock(side_effect=AssertionError('Waiting audio has no action authority'))
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, local_command=actions, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        try:
            try:
                waiting = await asyncio.wait_for(service.waiting.get(), 5)
            except TimeoutError:
                self.fail('Inactive prepared service must open verified private wake capture')
            self.assertIsNone(service.recognizer.reader)
            self.assertIsNone(service.manager.pipeline)
            await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
            with patch.object(service.recognizer, 'transcribe', wraps=service.recognizer.transcribe) as recognition:
                waiting.capture.stdout.feed_data(bytes(640))
                waiting.capture.stdout.feed_data(WAKE_PHRASE_PCM)
                active = await asyncio.wait_for(service.started.get(), 5)
                self.assertTrue(waiting.capture.reaped.is_set(), 'Waiting recorder must exit before recognition')
                self.assertTrue(waiting.reader.done())
                self.assertIsNone(waiting.playback)
                self.assertIsNot(active, waiting)
                self.assertTrue(service.manager.desired_active)
                self.assertEqual(service.manager.conversation.turns, [])
                self.assertEqual(actions.await_count, 0)
                self.assertIsNone(service.recognizer.reader, 'Waiting PCM must not open ordinary recognition')
                self.assertEqual(len(brain.requests), 1, 'Only fixed preparation, no waiting-audio request')
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                recognition.assert_not_called()
                recognition.assert_not_awaited()
            await close()
        finally:
            await close()

    async def test_wake_cleanup_failure_refuses_activation(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        manager = service.manager
        try:
            waiting = await asyncio.wait_for(service.waiting.get(), 5)
            detector = manager.wake_detector
            original_close = detector.close
            refused = asyncio.Event()

            async def refuse_close():
                await original_close()
                refused.set()
                raise RuntimeError('Wake capture cleanup failed. Restart Kestrel.')

            with patch.object(detector, 'close', side_effect=refuse_close):
                waiting.capture.stdout.feed_data(WAKE_PHRASE_PCM)
                await asyncio.wait_for(refused.wait(), 5)
                self.assertEqual(manager.failure, 'Wake capture cleanup failed. Restart Kestrel.')
                self.assertEqual(manager.status._state, 'trouble')
                self.assertFalse(manager.desired_active)
                self.assertTrue(service.started.empty())
                self.assertEqual(handle.sessions, [])
                self.assertEqual(await service.toggle(), 'unavailable')
                self.assertTrue(waiting.capture.reaped.is_set())
                self.assertTrue(waiting.reader.done())
                self.assertIsNotNone(detector.process.returncode)
                self.assertIsNone(service.recognizer.reader)
                self.assertEqual(manager.conversation.turns, [])
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
        finally:
            await close()

    async def test_wake_cannot_toggle_or_reopen_after_revocation(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        handle, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        waiting = await asyncio.wait_for(service.waiting.get(), 5)
        late_hit = service.manager.wake_detector.on_detected
        waiting.capture.stdout.feed_data(WAKE_PHRASE_PCM)
        active = await asyncio.wait_for(service.started.get(), 5)
        late_hit()
        late_hit()
        self.assertTrue(service.manager.desired_active)
        self.assertIs(service.manager.transport, active)
        self.assertEqual(await service.toggle(), 'inactive')
        fresh_waiting = await asyncio.wait_for(service.waiting.get(), 5)
        late_hit()
        self.assertFalse(service.manager.desired_active)
        self.assertIs(service.manager.waiting_transport, fresh_waiting)
        last_hit = service.manager.wake_detector.on_detected
        service.manager.revoke()
        last_hit()
        self.assertFalse(service.manager.desired_active)
        await close()
        last_hit()
        self.assertTrue(service.manager.closed)
        self.assertTrue(fresh_waiting.capture.reaped.is_set())
        self.assertEqual(service.manager.conversation.turns, [])
        self.assertTrue(spoken.empty())

    async def test_wake_rearms_after_typed_output_settles(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nHey Kestrel.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        workspace = 1
        action_entered, action_release = asyncio.Event(), asyncio.Event()
        self.addCleanup(action_release.set)

        async def command(argv):
            nonlocal workspace
            if argv == ('/usr/bin/hyprctl', '-j', 'activeworkspace'):
                return json.dumps({'id': workspace})
            self.assertEqual(argv[:2], ('/usr/bin/hyprctl', 'dispatch'))
            action_entered.set()
            await action_release.wait()
            workspace = 3
            return 'ok'

        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True, local_command=command,
        )
        service = handle.service
        manager = service.manager
        waiting = await asyncio.wait_for(service.waiting.get(), 5)
        old_hit = manager.wake_detector.on_detected
        output_end, release_end, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release_end.set)
        original_state = manager.status.set_state

        def state(value):
            original_state(value)
            if value == 'inactive' and manager.handover is None and manager.transport is not None:
                settled.set()

        with patch.object(manager.status, 'set_state', side_effect=state):
            self.assertEqual(await service.submit('Say the wake phrase'), 'accepted')
            transport = await asyncio.wait_for(service.started.get(), 5)
            self.assertTrue(waiting.capture.reaped.is_set())

            @transport.output().event_handler('on_before_push_frame')
            async def hold_output(processor, frame):
                if isinstance(frame, LLMFullResponseEndFrame):
                    output_end.set()
                    await release_end.wait()

            await asyncio.wait_for(output_end.wait(), 5)
            await asyncio.wait_for(settled.wait(), 5)
            self.assertIsNone(manager.wake_detector, 'Typed reply stays suppressed until actual output completion')
            self.assertTrue(service.waiting.empty())
            old_hit()
            self.assertFalse(manager.desired_active)
            token = manager.wake_reply_token
            release_end.set()
            fresh = await asyncio.wait_for(service.waiting.get(), 5)
            self.assertIsNone(transport.capture)
            self.assertIsNot(fresh, waiting)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Hey Kestrel.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Hey Kestrel.')
            for text in ('stop', 'workspace three'):
                self.assertEqual(await service.submit(text), 'accepted')
                if text == 'workspace three':
                    await asyncio.wait_for(action_entered.wait(), 5)
                    self.assertTrue(fresh.capture.reaped.is_set())
                    self.assertIsNone(manager.wake_detector)
                    # Obsolete output completion has no authority over a newer typed reply.
                    late = LLMFullResponseEndFrame()
                    late.reply_progress = reply_progress.ReplyProgress.silent(token)
                    await transport.output().push_frame(late)
                    self.assertIsNone(manager.wake_detector)
                    action_release.set()
                fresh = await asyncio.wait_for(service.waiting.get(), 5)
                self.assertFalse(manager.desired_active)
                self.assertTrue(spoken.empty(), 'Silent typed controls add no spoken reply')
            self.assertEqual(workspace, 3)
            self.assertEqual([t['text'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                             ['Say the wake phrase', 'stop', 'workspace three'])
        await close()

    async def test_wake_failure_preserves_shortcut(self):
        messages = []
        sink = logger.add(lambda message: messages.append(str(message)), format='{message}')
        self.addCleanup(lambda: logger.remove(sink))
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        handle, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
            wake_wire="import sys; sys.stdout.buffer.write(b'E'); sys.stdout.buffer.flush()",
        )
        service = handle.service
        # This is an observed advisory, independent of the optional detector's internal failure flag.
        advised = asyncio.Event()
        if any('Wake phrase unavailable.' in message for message in messages):
            advised.set()
        observer = logger.add(lambda message: advised.set() if 'Wake phrase unavailable.' in str(message) else None)
        self.addCleanup(lambda: logger.remove(observer))
        await asyncio.wait_for(advised.wait(), 5)
        self.assertTrue(any('Press Super + Shift + K to start. Check the service log and restart Kestrel.' in m
                            for m in messages))
        self.assertIsNone(service.manager.failure)
        self.assertEqual(await service.toggle(), 'starting')
        active = await asyncio.wait_for(service.started.get(), 5)
        self.assertIsNotNone(active.capture)
        self.assertTrue(service.manager.desired_active)
        self.assertTrue(spoken.empty())
        await close()

    async def test_inactive_capture_never_reaches_recognition_or_actions(self):
        command = AsyncMock(side_effect=AssertionError('Inactive input cannot execute local commands'))
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        handle, spoken, committed, interrupted, _, close = await self.open_session(
            brain, local_command=command, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        try:
            self.assertEqual(handle.sessions, [], 'Inactive startup opens no recognition session or playback')
            self.assertIsNone(service.recognizer.reader)
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            llm = transport.llm
            old_stt = speech.NemotronSTT(service.recognizer, admission=transport.admission)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await transport.input().queue_frame(InputAudioRawFrame(b'private inactive audio', 16000, 1))
            self.assertEqual(await service.toggle(), 'inactive')
            cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
            await asyncio.wait_for(asyncio.shield(cleanup), 5)
            self.assertEqual(service.manager.status._state, 'inactive')
            transport.capture.stdout.feed_data(b'private stale capture' * 100)
            self.assertTrue(transport.reader.done())
            self.assertTrue(transport.capture.reaped.is_set())
            self.assertEqual([frame async for frame in old_stt.run_stt(b'private stale audio')], [])
            await llm.process_frame(LLMContextFrame(bot.LLMContext([{'role': 'user', 'content': 'mute'}])),
                                    FrameDirection.DOWNSTREAM)
            self.assertFalse(await transport.output().write_audio_frame(TTSAudioRawFrame(bytes(640), 48000, 1)))
            self.assertEqual(command.await_count, 0, 'An inactive service must reject ordinary input')
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(service.manager.conversation.turns, [])
            self.assertIsNone(llm.last_spoken_reply)
            self.assertEqual(service.manager.status._state, 'inactive')
        finally:
            await close()

    async def test_rapid_dismiss_summon_has_fresh_history_and_no_old_output(self):
        with self.subTest(outcome='dismiss_during_feed_reset'):
            entered, release, reset_finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
            self.addCleanup(release.set)
            brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
            self.addCleanup(brain.close)
            handle, spoken, committed, _, _, close = await self.open_session(
                brain, through_service=True, activate=False, native_audio=True,
            )
            service = handle.service
            begin_session = service.manager.conversation.begin_session

            async def held_reset():
                await begin_session()
                entered.set()
                await release.wait()
                reset_finished.set()

            try:
                with patch.object(service.manager.conversation, 'begin_session', side_effect=held_reset):
                    self.assertEqual(await service.toggle(), 'starting')
                    await asyncio.wait_for(entered.wait(), 5)
                    self.assertEqual(await service.toggle(), 'inactive')
                    release.set()
                    await asyncio.wait_for(reset_finished.wait(), 5)
                    self.assertEqual(service.manager.status._state, 'inactive')
                self.assertEqual(handle.sessions, [], 'Dismissed activation must create no capture or adapter')
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
            finally:
                release.set()
                await close()

        for mode in ('fresh', 'held_close_failure', 'watchdog'):
            with self.subTest(outcome=mode):
                loop = asyncio.get_running_loop()
                next_entered, close_entered = asyncio.Event(), asyncio.Event()
                release_next, release_close = threading.Event(), threading.Event()
                expire, watchdog_seen = asyncio.Event(), asyncio.Event()
                events = []
                self.addCleanup(release_next.set)
                self.addCleanup(release_close.set)

                def chunks(**kwargs):
                    text = kwargs['text']
                    events.append(('model', text))
                    if text != 'Old reply.':
                        yield np.zeros(4800, dtype=np.float32)
                        return
                    try:
                        yield np.zeros(4800, dtype=np.float32)
                        loop.call_soon_threadsafe(next_entered.set)
                        if not release_next.wait(45):
                            raise AssertionError('Synthetic native chunk never released')
                        yield np.zeros(4800, dtype=np.float32)
                    finally:
                        loop.call_soon_threadsafe(close_entered.set)
                        if not release_close.wait(45):
                            raise AssertionError('Synthetic native close never released')
                        events.append(('closed', text))
                        if mode == 'held_close_failure':
                            raise RuntimeError('held_close_failure')

                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nOld reply.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                transport, spoken, committed, interrupted, _, close = await self.open_session(
                    brain, through_service=True, synthesis_chunks=chunks, native_audio=True,
                )
                self.addCleanup(release_next.set)
                self.addCleanup(release_close.set)
                service = transport.service
                manager = service.manager
                old_voice, old_llm, pipeline = manager.voice, manager.llm, manager.pipeline
                transport.output().write_gate.clear()
                native_wait_for = asyncio.wait_for
                states = []
                native_set_state = manager.status.set_state

                def set_state(value):
                    states.append(value)
                    native_set_state(value)

                async def wait_for(awaitable, timeout):
                    if timeout == 90 and mode == 'watchdog':
                        watchdog_seen.set()
                        await expire.wait()
                        return await native_wait_for(awaitable, 0)
                    return await native_wait_for(awaitable, timeout)

                try:
                    await asyncio.shield(manager.session_ready)
                    with (
                        patch.object(bot.asyncio, 'wait_for', side_effect=wait_for),
                        patch.object(manager.status, 'set_state', side_effect=set_state),
                    ):
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await asyncio.wait_for(interrupted.wait(), 5)
                        await self.finish_user_turn(transport, 'Old private request.')
                        await asyncio.wait_for(next_entered.wait(), 5)
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(manager.status._state, 'inactive')
                        self.assertFalse(transport.admission.is_open())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertEqual(await service.toggle(), 'starting')
                        self.assertEqual(manager.status._state, 'starting')
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(manager.status._state, 'inactive')
                        self.assertFalse(transport.admission.is_open())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertEqual(await service.toggle(), 'starting')
                        self.assertEqual(manager.status._state, 'starting')
                        self.assertFalse(transport.admission.is_open())
                        self.assertEqual(len(transport.sessions), 1)
                        if mode == 'watchdog':
                            await asyncio.wait_for(watchdog_seen.wait(), 5)
                            cleanup = manager.cleanup
                            expire.set()
                            await service.state('trouble')
                            self.assertIs(manager.cleanup, cleanup)
                            self.assertFalse(cleanup.done())
                            self.assertFalse(manager.desired_active)
                            self.assertEqual(await service.toggle(), 'unavailable')
                        release_next.set()
                        await asyncio.wait_for(close_entered.wait(), 5)
                        cleanup = manager.cleanup
                        self.assertFalse(cleanup.done())
                        self.assertTrue(manager.generation_lock.locked())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        release_close.set()
                        if mode == 'held_close_failure':
                            with self.assertRaisesRegex(RuntimeError, 'generation cleanup failed'):
                                await asyncio.wait_for(asyncio.shield(cleanup), 5)
                            await service.state('trouble-voice')
                            self.assertTrue(old_voice.generation_cleanup_failed)
                        else:
                            await asyncio.wait_for(asyncio.shield(cleanup), 5)
                            self.assertFalse(old_voice.generation_cleanup_failed)
                        self.assertTrue(pipeline.done())
                        self.assertIsNone(old_llm.last_spoken_reply)
                        if mode == 'fresh':
                            fresh = await asyncio.wait_for(service.started.get(), 5)
                            self.assertIsNot(fresh, transport)
                            self.assertIsNot(fresh.llm, old_llm)
                            self.assertIsNone(fresh.llm.last_spoken_reply)
                            self.assertTrue(transport.capture.reaped.is_set())
                            await asyncio.shield(manager.session_ready)
                            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
                            await self.finish_user_turn(fresh, 'Fresh private request.')
                            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
                            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
                            caller = [message for message in brain.requests[-1][2]['messages'] if message['role'] != 'system']
                            self.assertEqual(caller, [{'role': 'user', 'content': 'Fresh private request.'}])
                            self.assertLess(events.index(('closed', 'Old reply.')), events.index(('model', 'Fresh reply.')))
                        else:
                            self.assertEqual(await service.toggle(), 'unavailable', 'Failed cleanup must refuse activation')
                            self.assertEqual(manager.status._state, 'trouble' if mode == 'watchdog' else 'trouble-voice')
                            self.assertEqual(len(transport.sessions), 1)
                            self.assertIs(manager.cleanup, cleanup, 'Late completion retains the original cleanup owner')
                            self.assertEqual(events, [('model', 'Old reply.'), ('closed', 'Old reply.')])
                        self.assertNotIn('released', states)
                finally:
                    expire.set()
                    release_next.set()
                    release_close.set()
                    await close()

    async def test_repeated_conversation_close_retains_echo_owner_and_private_traces(self):
        from desktop import conversation
        traces_home = tempfile.TemporaryDirectory(prefix='kestrel-retained-traces-')
        self.addCleanup(traces_home.cleanup)
        traces = Path(traces_home.name) / 'traces'
        traces.mkdir(mode=0o700)
        sentinel = traces / 'retained-private-sentinel'
        sentinel.write_bytes(b'pre-existing private trace')
        sentinel.chmod(0o600)
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            *[[({'content': f'[delivery:neutral]\nReply {cycle}.'}, None), ({}, 'stop')] for cycle in range(4)],
        ])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, processes, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True, trace_root=traces,
        )
        service = handle.service
        manager = service.manager
        states, identities, processors = [], [], []
        set_state = manager.status.set_state

        def observe(state):
            states.append(state)
            set_state(state)

        async def snapshot():
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            row = json.loads(await asyncio.wait_for(reader.readline(), 1))
            return reader, writer, row

        reader, writer, row = await snapshot()
        previous_session = row['session']
        try:
            with patch.object(manager.status, 'set_state', side_effect=observe):
                for cycle in range(4):
                    if cycle == 0:
                        closing, release = asyncio.Event(), asyncio.Event()
                        self.addCleanup(release.set)
                        close_writer = conversation.close_writer

                        async def held_close(writer):
                            closing.set()
                            await release.wait()
                            await close_writer(writer)

                        with patch.object(conversation, 'close_writer', side_effect=held_close):
                            self.assertEqual(await service.toggle(), 'starting')
                            await asyncio.wait_for(closing.wait(), 5)
                            incoming, incoming_writer = await asyncio.open_unix_connection(conversation.address())
                            try:
                                self.assertEqual(manager.conversation.session, previous_session)
                                self.assertEqual(handle.sessions, [])
                                self.assertEqual(await asyncio.wait_for(incoming.read(1), 1), b'',
                                                 'Readers arriving during reset must receive clean EOF')
                            finally:
                                release.set()
                                await close_writer(incoming_writer)
                            transport = await asyncio.wait_for(service.started.get(), 5)
                    else:
                        self.assertEqual(await service.toggle(), 'starting')
                        transport = await asyncio.wait_for(service.started.get(), 5)
                    await asyncio.shield(manager.session_ready)
                    async with asyncio.timeout(1):
                        while line := await reader.readline():
                            conversation.validate_record(line, previous_session)
                    self.assertTrue(reader.at_eof(), 'A new UUID disconnects the old reader first')
                    await conversation.close_writer(writer)
                    reader, writer, row = await snapshot()
                    self.assertNotEqual(row['session'], previous_session)
                    previous_session = row['session']
                    self.assertEqual(row['turns'], [])
                    self.assertIsNone(transport.llm.last_spoken_reply)
                    self.assertTrue(all(transport.stt is not old for old in processors))
                    processors.append(transport.stt)
                    self.assertEqual(len(manager.status._owners), 2)
                    identities.append(manager.capture_owner)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'repeat that')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                    self.assertTrue(committed.empty())
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, f'Cycle {cycle}.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), f'Reply {cycle}.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), f'Reply {cycle}.')
                    self.assertEqual(await service.toggle(), 'inactive')
                    self.assertEqual(manager.conversation.turns, [])
                    cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                    await asyncio.wait_for(asyncio.shield(cleanup), 5)
                    self.assertEqual(service.manager.status._state, 'inactive')
                    self.assertTrue(transport.capture.reaped.is_set())
                    self.assertIsNone(transport.playback)
                    self.assertTrue(all(child.reaped.is_set() for child in transport.audio_children))
                    self.assertEqual(manager.status._owners, [{'pid': 70001, 'start_time': 71001}])
                    self.assertFalse(manager.status._failed)
                    self.assertEqual(sentinel.read_bytes(), b'pre-existing private trace')
            self.assertEqual(len(handle.sessions), 4)
            self.assertEqual(len({identity['pid'] for identity in identities}), 4)
            self.assertNotIn('released', states)
            self.assertEqual(len(processes), 1, 'The same native Hermes worker stays warm')
            self.assertEqual([[message for message in request[2]['messages'] if message['role'] != 'system']
                              for request in brain.requests[1:]],
                             [[{'role': 'user', 'content': f'Cycle {cycle}.'}] for cycle in range(4)])
            private_traces = list(traces.glob('session-*/events.jsonl'))
            self.assertTrue(private_traces)
            for trace in private_traces:
                self.assertEqual(trace.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('private stale capture', trace.read_text())
        finally:
            await conversation.close_writer(writer)
            await close()
        self.assertEqual(sentinel.read_bytes(), b'pre-existing private trace')
        self.assertTrue(all(trace.exists() for trace in private_traces))

    async def test_cancelled_session_detaches_native_reply(self):
        blocked, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def old_reply():
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Synthetic native reply was never released')
            yield {'content': '[delivery:neutral]\nOld unheard reply.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([
            old_reply(),
            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        allowed = True
        old, spoken, committed, interrupted, processes, close_old = await self.open_session(
            brain, admitted=lambda: allowed,
        )
        channel = old.llm.channel
        self.addCleanup(release.set)
        await old.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        interrupted.clear()
        await self.finish_user_turn(old, 'Old request.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        native_reader = channel.reader
        stale_output = old.llm.output
        self.assertIsNotNone(stale_output)
        self.assertFalse(native_reader.done())

        queued_entered = asyncio.Event()
        queued_output = asyncio.Queue()
        queued_allowed = True

        async def queued_exchange():
            queued_entered.set()
            await channel.exchange(
                [{'role': 'user', 'content': 'Revoked request.'}], queued_output,
                admitted=lambda: queued_allowed,
            )

        queued = asyncio.create_task(queued_exchange())
        async def close_queued():
            queued.cancel()
            await asyncio.gather(queued, return_exceptions=True)

        self.addAsyncCleanup(close_queued)
        await asyncio.wait_for(queued_entered.wait(), 5)
        queued_allowed = False
        allowed = False
        old.llm.revoke()
        self.assertIsNone(channel.output, 'Revocation synchronously detaches the native sink')
        await old.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertIs(channel.reader, native_reader)
        self.assertFalse(native_reader.done(), 'Cancelling speech must retain the native response reader')
        release.set()
        await asyncio.wait_for(channel.drain(), 5)
        await asyncio.wait_for(queued, 5)
        self.assertIsNone(await asyncio.wait_for(queued_output.get(), 5))
        self.assertEqual(len(brain.requests), 1, 'Revoked queued work never reaches the provider')
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        self.assertTrue(stale_output.empty(), 'Native completion cannot append to the detached sink')
        self.assertIsNone(old.llm.last_spoken_reply)

        fresh, new_spoken, new_committed, _, _, close_fresh = await self.open_session(
            brain, channel=channel, local_actions=old.llm.local_actions,
        )
        try:
            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(fresh, 'Fresh request.')
            self.assertEqual((await asyncio.wait_for(new_spoken.get(), 5)).strip(), 'Fresh reply.')
            self.assertEqual(await asyncio.wait_for(new_committed.get(), 5), 'Fresh reply.')
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 2)
            caller = [message for message in brain.requests[-1][2]['messages'] if message['role'] != 'system']
            self.assertEqual(caller, [{'role': 'user', 'content': 'Fresh request.'}])
        finally:
            await close_fresh()
            await close_old()
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())


if __name__ == '__main__':
    unittest.main()
