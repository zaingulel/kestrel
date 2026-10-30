import asyncio
import json
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    DataFrame, InputAudioRawFrame, LLMFullResponseEndFrame, ProposedUserStartedSpeakingFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

import bot
from conversation_fixtures import WholeConversationCase, microphone_admitted
import reply_progress
import speech
from test_hermes import ScriptedBrain


class WholeConversationTests(WholeConversationCase):
    async def test_output_roundtrip_preserves_running_reply_and_context(self):
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def continuing():
            yield {'content': '[delivery:neutral]\nFirst sentence. [deliv'}, None
            yield {'content': 'ery:unknown] Continuing'}, None
            held.set()
            if not release.wait(45):
                raise AssertionError('Continuing reply was not released')
            yield {'content': ' sentence.'}, None
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            continuing(),
            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, through_service=True, native_audio=True,
        )
        manager, service = transport.service.manager, transport.service
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Remember this conversation')
        self.assertTrue(await asyncio.to_thread(held.wait, 5))
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'First sentence.')
        interrupted.clear()
        original_reply = manager.llm.current_reply()
        original_mark = manager.admission.input_mark()
        original_capture = transport.capture
        original_playback = transport.playback
        self.assertIsNotNone(original_playback)
        initial_writes = list(original_playback.writes)
        old_verification, refreshed = asyncio.Event(), asyncio.Event()
        observations, route_attempts = [], []
        route_seen = asyncio.Event()
        native_indicator = manager.llm.refresh_indicator

        def indicator():
            native_indicator()
            if microphone_admitted(manager):
                refreshed.set()

        async def serial(pid=None, *, output_serial=None):
            if pid is not None and output_serial is not None:
                observations.append((service.output_watch.revision, output_serial, microphone_admitted(manager)))
                if service.output_watch.revision == 1:
                    old_verification.set()
                    await asyncio.Event().wait()
            return 900

        async def selected(playback_pid=None):
            if playback_pid is not None:
                self.assertEqual(playback_pid, original_playback.pid)
                route_attempts.append(service.output_watch.revision)
                route_seen.set()
                if len(route_attempts) == 1:
                    raise RuntimeError('Playback route has not settled. Restart Kestrel.')
            return 1000 + service.output_watch.revision

        with patch.object(manager.llm, 'refresh_indicator', side_effect=indicator), \
                patch.object(bot.ECHO_REMOVAL, 'microphone_serial', new=AsyncMock(side_effect=serial)), \
                patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(side_effect=selected)):
            service.output_watch.emit()
            self.assertFalse(microphone_admitted(manager), 'Output notice must immediately reject stale microphone input')
            self.assertEqual(await service.submit('During handover'), 'busy')
            await asyncio.wait_for(old_verification.wait(), 5)
            superseded_capture = transport.capture
            service.output_watch.emit()
            await asyncio.wait_for(route_seen.wait(), 5)
            self.assertIsNone(manager.failure, 'A transient route must settle while playback continues')
            self.assertFalse(microphone_admitted(manager))
            await asyncio.wait_for(refreshed.wait(), 5)
        self.assertTrue(superseded_capture.reaped.is_set())
        self.assertIs(transport.playback, original_playback)
        self.assertEqual(original_playback.writes[:len(initial_writes)], initial_writes)
        self.assertEqual(observations, [(1, 1001, False), (2, 1002, False)])
        self.assertEqual(manager.echo_revision, 2)
        self.assertTrue(transport.verified)
        self.assertEqual(len(service.echo_generations), 3)
        self.assertIsNot(transport.capture, superseded_capture)
        self.assertEqual(route_attempts, [2, 2])
        self.assertTrue(original_capture.reaped.is_set())
        self.assertIsNot(transport.capture, original_capture)
        self.assertIs(manager.transport, transport)
        self.assertIs(manager.llm.current_reply(), original_reply)
        self.assertTrue(manager.admission.is_current(original_mark))
        self.assertTrue(microphone_admitted(manager))
        self.assertFalse(interrupted.is_set())
        release.set()
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'First sentence. Continuing sentence.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Continuing sentence.')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Fresh microphone question')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'Remember this conversation'},
            {'role': 'assistant', 'content': 'First sentence. Continuing sentence.'},
            {'role': 'user', 'content': 'Fresh microphone question'},
        ])
        self.assertEqual(len(service.sessions), 1)
        await close()

    async def test_output_handover_quiesces_old_input_and_preserves_accepted_work(self):
        for case in ('held_vad', 'queued_pcm', 'late_recognizer', 'stop_timer', 'accepted_submission', 'accepted_action', 'native_late_start', 'held_aggregation'):
            with self.subTest(case=case):
                entered, release, refreshed = asyncio.Event(), asyncio.Event(), asyncio.Event()
                self.addCleanup(release.set)
                prediction_release = None
                analyzers, strategies, effects, late_start_notices = [], [], [], []
                native_strategy = bot.TurnAnalyzerUserTurnStopStrategy
                muted = False

                def strategy(**kwargs):
                    item = native_strategy(**kwargs)
                    strategies.append(item)
                    return item

                async def command(argv):
                    nonlocal muted
                    if argv[:2] == ('/usr/bin/pactl', 'get-default-sink'):
                        return 'selected'
                    if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                        return 'physical'
                    if 'get-sink-mute' in argv:
                        return 'Mute: yes' if muted else 'Mute: no'
                    if 'set-sink-mute' in argv:
                        entered.set()
                        await release.wait()
                        muted = True
                        effects.append('mute')
                        return ''
                    raise AssertionError(f'Unexpected native command: {argv}')

                def vad_factory(*, params):
                    analyzer = Mock(params=params, sample_rate=16000, cleanup=AsyncMock())

                    async def analyze(audio):
                        if case == 'native_late_start' and audio in (b'S' * 640, b'N' * 640):
                            return VADState.SPEAKING
                        if case == 'held_vad' and audio == b'V' * 640:
                            entered.set()
                            await release.wait()
                            return VADState.SPEAKING
                        return VADState.QUIET

                    analyzer.analyze_audio = analyze
                    analyzers.append(analyzer)
                    return analyzer

                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nAccepted reply.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                with patch.object(bot, 'TurnAnalyzerUserTurnStopStrategy', side_effect=strategy):
                    transport, spoken, committed, interrupted, _, close = await self.open_session(
                        brain, through_service=True, native_audio=True, vad_factory=vad_factory,
                        production_turn_strategies=case in ('held_vad', 'stop_timer', 'native_late_start', 'held_aggregation'), local_command=command,
                    )
                try:
                    service, manager = transport.service, transport.service.manager
                    await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                    before_requests = len(brain.requests)
                    user = manager.ingress[1]
                    original_mark = manager.admission.input_mark()
                    capture = transport.capture
                    native_indicator = manager.llm.refresh_indicator

                    def indicator():
                        native_indicator()
                        if microphone_admitted(manager):
                            refreshed.set()

                    async def completed(processor, frame):
                        done = asyncio.Event()

                        async def ack(processor, frame, direction):
                            done.set()

                        await processor.queue_frame(frame, callback=ack)
                        await asyncio.wait_for(done.wait(), 5)

                    held_frame = InputAudioRawFrame(b'Q' * 640, 16000, 1)
                    original_push = transport.input().push_frame
                    passed = []

                    async def push(frame, direction=FrameDirection.DOWNSTREAM):
                        if frame is held_frame:
                            entered.set()
                            await release.wait()
                            passed.append(microphone_admitted(manager))
                        await original_push(frame, direction)

                    reset_started, handover_entered = asyncio.Event(), asyncio.Event()
                    reset_owners = []
                    native_reset = manager.stt.discard_pending

                    async def reset():
                        reset_started.set()
                        reset_owners.append(asyncio.current_task() is manager.submission_task)
                        await native_reset()

                    original_refresh = manager.refresh_output

                    async def refresh():
                        handover_entered.set()
                        await original_refresh()

                    native_sleep = asyncio.sleep

                    async def hold_timer(delay, result=None):
                        if case in ('stop_timer', 'native_late_start') and strategies and asyncio.current_task() is strategies[0]._timeout_task:
                            entered.set()
                            await release.wait()
                            return result
                        return await native_sleep(delay, result=result)

                    original_submission = manager.submit_pending

                    async def submit():
                        if case == 'accepted_submission':
                            entered.set()
                            await release.wait()
                        await original_submission()

                    with patch.object(manager.llm, 'refresh_indicator', side_effect=indicator), \
                            patch.object(transport.input(), 'push_frame', side_effect=push), \
                            patch.object(manager.stt, 'discard_pending', side_effect=reset), \
                            patch.object(manager, 'submit_pending', side_effect=submit), \
                            patch.object(manager, 'refresh_output', side_effect=refresh), \
                            patch.object(asyncio, 'sleep', side_effect=hold_timer):
                        if case == 'held_vad':
                            await user.queue_frame(InputAudioRawFrame(b'V' * 640, 16000, 1))
                        elif case == 'queued_pcm':
                            await transport.input().push_audio_frame(held_frame)
                        elif case == 'late_recognizer':
                            native = Mock(returncode=None, stdin=Mock(drain=AsyncMock()), stdout=asyncio.StreamReader(), wait=AsyncMock(return_value=0))
                            native.stdin.write.side_effect = lambda data: entered.set()
                            service.recognizer.process = native
                            await completed(manager.stt, VADUserStartedSpeakingFrame())
                            await completed(manager.stt, InputAudioRawFrame(bytes(640), 16000, 1))
                            await completed(manager.stt, VADUserStoppedSpeakingFrame())
                        elif case == 'stop_timer':
                            with patch.object(strategies[0]._turn_analyzer, '_predict_endpoint', return_value={'prediction': 0, 'probability': 0.0}):
                                await completed(user, VADUserStartedSpeakingFrame())
                                await asyncio.wait_for(interrupted.wait(), 5)
                                await completed(user, InputAudioRawFrame(bytes(640), 16000, 1))
                                await completed(user, self.transcription(transport, 'old accumulated speech'))
                                await completed(user, VADUserStoppedSpeakingFrame())
                        elif case == 'held_aggregation':
                            await completed(user, VADUserStartedSpeakingFrame())
                            await asyncio.wait_for(interrupted.wait(), 5)
                            await completed(user, InputAudioRawFrame(bytes(640), 16000, 1))
                            old_text = 'old aggregation sentinel'
                            transcription = self.transcription(transport, old_text)
                            self.assertTrue(transcription.finalized)
                            await completed(user, transcription)
                            prediction_release = threading.Event()
                            prediction_samples = []
                            loop = asyncio.get_running_loop()
                            stop_done = asyncio.Event()

                            def complete_prediction(audio):
                                prediction_samples.append(audio.size)
                                loop.call_soon_threadsafe(entered.set)
                                prediction_release.wait()
                                return {'prediction': 1, 'probability': 1.0}

                            async def stopped(processor, frame, direction):
                                stop_done.set()

                            with patch.object(strategies[0]._turn_analyzer, '_predict_endpoint',
                                              side_effect=complete_prediction):
                                await user.queue_frame(VADUserStoppedSpeakingFrame(), callback=stopped)
                                await asyncio.wait_for(entered.wait(), 5)
                                self.assertFalse(stop_done.is_set())
                                self.assertEqual(len(prediction_samples), 1)
                                self.assertGreater(prediction_samples[0], 0)
                            # The executor is already inside the controlled predictor until release.
                        elif case == 'native_late_start':
                            await user.queue_frame(InputAudioRawFrame(b'S' * 640, 16000, 1))
                            await asyncio.wait_for(interrupted.wait(), 5)
                            self.assertEqual(user._vad_controller._vad_state, VADState.SPEAKING)
                            self.assertEqual(await service.submit('Accepted request'), 'accepted')
                            original_mark = manager.admission.input_mark()
                            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Accepted reply.')
                            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Accepted reply.')
                            if manager.submission_task is not None:
                                await asyncio.wait_for(asyncio.shield(manager.submission_task), 5)
                            self.assertFalse(user._user_turn_controller._user_turn)
                            self.assertEqual(user._vad_controller._vad_state, VADState.SPEAKING)
                            with patch.object(strategies[0]._turn_analyzer, '_predict_endpoint',
                                              return_value={'prediction': 0, 'probability': 0.0}):
                                await user.queue_frame(InputAudioRawFrame(b'Q' * 640, 16000, 1))
                                await asyncio.wait_for(entered.wait(), 5)
                            timer = strategies[0]._timeout_task
                            self.assertIsNotNone(timer)
                            self.assertFalse(timer.done())
                            self.assertFalse(user._user_turn_controller._user_turn)
                            self.assertEqual(user._vad_controller._vad_state, VADState.QUIET)
                            interrupted.clear()
                            refreshed.clear()

                            def output_notice(done):
                                late_start_notices.append((done.cancelling(), user._user_turn_controller._user_turn,
                                                           microphone_admitted(manager)))
                                service.output_watch.emit()

                            timer.add_done_callback(output_notice)
                            await user.queue_frame(InputAudioRawFrame(b'N' * 640, 16000, 1))
                            await asyncio.wait_for(handover_entered.wait(), 5)
                        elif case == 'accepted_action':
                            self.assertEqual(await service.submit('mute'), 'accepted')
                            original_mark = manager.admission.input_mark()
                        else:
                            self.assertEqual(await service.submit('Accepted request'), 'accepted')
                            original_mark = manager.admission.input_mark()
                        if case != 'native_late_start':
                            await asyncio.wait_for(entered.wait(), 5)
                            interrupted.clear()
                            refreshed.clear()
                            service.output_watch.emit()
                        self.assertFalse(microphone_admitted(manager))
                        old_audio_task = transport.input()._audio_task
                        old_audio_queue = transport.input()._audio_in_queue
                        if case == 'accepted_submission':
                            await asyncio.wait_for(handover_entered.wait(), 5)
                            self.assertFalse(reset_started.is_set())
                            self.assertFalse(capture.reaped.is_set())
                        release.set()
                        if case == 'late_recognizer':
                            await asyncio.wait_for(reset_started.wait(), 5)
                            native.stdout.feed_data(b'{"text":"old microphone sentinel"}\n')
                        if case == 'held_aggregation':
                            prediction_release.set()
                            await asyncio.wait_for(stop_done.wait(), 5)
                        await asyncio.wait_for(refreshed.wait(), 5)
                    self.assertIs(transport.input()._audio_task, old_audio_task)
                    self.assertIs(transport.input()._audio_in_queue, old_audio_queue)
                    self.assertTrue(manager.admission.is_current(original_mark))
                    self.assertTrue(capture.reaped.is_set())
                    if case == 'native_late_start':
                        await completed(transport.output(), DataFrame())
                        self.assertTrue(timer.done())
                        self.assertEqual(len(late_start_notices), 1)
                        self.assertGreater(late_start_notices[0][0], 0)
                        self.assertEqual(late_start_notices[0][1:], (True, True))
                    if case not in ('accepted_submission', 'accepted_action'):
                        self.assertFalse(interrupted.is_set(), 'Old microphone work must not interrupt the reply')
                    if case == 'queued_pcm':
                        self.assertEqual(passed, [False])
                    if case == 'held_vad':
                        self.assertEqual(len(analyzers), 2)
                        analyzers[0].cleanup.assert_awaited_once_with()
                        self.assertIs(user._vad_controller._vad_analyzer, analyzers[1])
                        self.assertEqual(user._vad_controller._vad_state, VADState.QUIET)
                    if case == 'stop_timer':
                        self.assertIsNone(strategies[0]._timeout_task)
                        self.assertEqual(strategies[0]._turn_analyzer._audio_buffer, [])
                    if case == 'accepted_action':
                        await asyncio.wait_for(manager.local_actions.drain(), 5)
                        self.assertEqual(effects, ['mute'])
                    if case == 'accepted_submission':
                        self.assertEqual(reset_owners, [True, False])
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Accepted reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Accepted reply.')
                        self.assertEqual(sum(m['content'] == 'Accepted request' for m in brain.requests[-1][2]['messages']), 1)
                    elif case == 'native_late_start':
                        self.assertEqual(reset_owners, [True, False])
                        self.assertEqual(len(brain.requests), before_requests + 1)
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        await user.queue_frame(InputAudioRawFrame(b'N' * 640, 16000, 1))
                        await asyncio.wait_for(interrupted.wait(), 5)
                        await self.finish_user_turn(transport, 'Fresh speech after handover')
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
                        self.assertEqual(len(brain.requests), before_requests + 2)
                        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
                            {'role': 'user', 'content': 'Accepted request'},
                            {'role': 'assistant', 'content': 'Accepted reply.'},
                            {'role': 'user', 'content': 'Fresh speech after handover'},
                        ])
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                    elif case == 'held_aggregation':
                        downstream = DataFrame()
                        downstream_done = asyncio.Event()

                        @transport.output().event_handler('on_after_process_frame')
                        async def after_downstream(processor, frame):
                            if frame is downstream:
                                downstream_done.set()

                        await user.queue_frame(downstream)
                        await asyncio.wait_for(downstream_done.wait(), 5)
                        self.assertNotIn(old_text, str(manager.ingress[2].get_messages()))
                        self.assertNotIn(old_text, str(manager.conversation.turns))
                        self.assertEqual(len(brain.requests), before_requests)
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        await self.finish_user_turn(transport, 'Fresh speech after held analysis')
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Accepted reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Accepted reply.')
                        self.assertEqual(len(brain.requests), before_requests + 1)
                        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
                            {'role': 'user', 'content': 'Fresh speech after held analysis'},
                        ])
                        self.assertNotIn(old_text, str(brain.requests))
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                    else:
                        self.assertEqual(len(brain.requests), before_requests)
                    self.assertNotIn('old microphone sentinel', str(manager.conversation.turns))
                    self.assertIsNone(service.recognizer.reader)
                    self.assertFalse(manager.stt._segment_task.done())
                    self.assertEqual(len(service.sessions), 1)
                    self.assertEqual(await service.toggle(), 'inactive')
                    await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                    await service.state('inactive')
                    self.assertFalse(microphone_admitted(manager))
                finally:
                    if prediction_release is not None:
                        prediction_release.set()
                    release.set()
                    await close()

    async def test_output_handover_inactive_failure_and_dismissal_stay_closed(self):
        for case in ('inactive', 'typed_inactive', 'watcher_loss', 'verification_failure', 'dismissal', 'deferred_source', 'initial_capture_failure', 'waiting_capture_failure', 'persistent_route', 'graph_cleanup_route', 'superseded_shutdown', 'superseded_deadline', 'startup_selection_active', 'startup_selection_waiting', 'initial_selection_recovers', 'initial_selection_superseded', 'initial_selection_cleanup'):
            with self.subTest(case=case):
                releases = []
                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nTyped reply.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                handle, spoken, committed, _, _, close = await self.open_session(
                    brain, through_service=True, native_audio=True, activate=case not in ('inactive', 'typed_inactive', 'deferred_source', 'persistent_route', 'graph_cleanup_route', 'startup_selection_active', 'startup_selection_waiting'),
                )
                try:
                    service, manager = handle.service, handle.service.manager
                    if case == 'inactive':
                        waiting = await asyncio.wait_for(service.waiting.get(), 5)
                        interval = manager.wake_interval
                        service.output_watch.emit()
                        fresh = await asyncio.wait_for(service.waiting.get(), 5)
                        self.assertIsNot(fresh, waiting)
                        self.assertTrue(waiting.capture.reaped.is_set())
                        manager.wake_start(interval)
                        self.assertFalse(manager.desired_active)
                        self.assertFalse(microphone_admitted(manager))
                        self.assertIsNone(manager.transport)
                        self.assertFalse(fresh.input().ready)
                        self.assertFalse(manager.switching_output)
                    elif case == 'typed_inactive':
                        self.assertEqual(await service.submit('Typed while inactive'), 'accepted')
                        typed = await asyncio.wait_for(service.started.get(), 5)
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Typed reply.')
                        refreshed = asyncio.Event()
                        indicator = manager.llm.refresh_indicator

                        def observed():
                            indicator()
                            if not manager.switching_output:
                                refreshed.set()

                        with patch.object(manager.llm, 'refresh_indicator', side_effect=observed):
                            service.output_watch.emit()
                            await asyncio.wait_for(refreshed.wait(), 5)
                        self.assertTrue(typed.input().ready)
                        self.assertIsNone(typed.input()._audio_task)
                        self.assertIsNone(typed.capture)
                        self.assertIsNone(manager.failure)
                        self.assertFalse(manager.desired_active)
                        self.assertFalse(microphone_admitted(manager))
                    elif case == 'deferred_source':
                        initial = await asyncio.wait_for(service.waiting.get(), 5)
                        output_end, release_output = asyncio.Event(), asyncio.Event()
                        export_ready, verifying, release_verification = asyncio.Event(), asyncio.Event(), asyncio.Event()
                        transition_done, detector_pcm = asyncio.Event(), asyncio.Queue()
                        releases.extend((release_output, release_verification))
                        self.assertEqual(await service.submit('Typed while source is unavailable'), 'accepted')
                        typed = await asyncio.wait_for(service.started.get(), 5)

                        @typed.output().event_handler('on_before_push_frame')
                        async def hold_output(processor, frame):
                            if isinstance(frame, LLMFullResponseEndFrame):
                                output_end.set()
                                await release_output.wait()

                        await asyncio.wait_for(output_end.wait(), 5)
                        self.assertTrue(initial.capture.reaped.is_set())
                        self.assertIsNone(manager.wake_detector)
                        self.assertIsNotNone(manager.wake_reply_token)
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Typed reply.')
                        refresh = manager.refresh_output

                        async def observe_refresh():
                            try:
                                await refresh()
                            finally:
                                transition_done.set()

                        async def source(pid=None, *, output_serial=None):
                            if not export_ready.is_set():
                                raise RuntimeError('Replacement source is not exported yet. Restart Kestrel.')
                            if pid is not None:
                                self.assertIsNone(output_serial)
                                verifying.set()
                                await release_verification.wait()
                            return 900

                        def private_pcm(detector, pcm):
                            detector_pcm.put_nowait(pcm)

                        with patch.object(manager, 'refresh_output', side_effect=observe_refresh), \
                                patch.object(bot.ECHO_REMOVAL, 'microphone_serial', new=AsyncMock(side_effect=source)) as resolve, \
                                patch.object(bot.WakeWordDetector, 'submit', autospec=True, side_effect=private_pcm) as submit_pcm:
                            service.output_watch.emit()
                            await asyncio.wait_for(transition_done.wait(), 5)
                            self.assertIsNone(manager.failure, 'Inactive handover must defer source proof until a consumer starts')
                            resolve.assert_not_awaited()
                            self.assertFalse(manager.desired_active)
                            self.assertFalse(microphone_admitted(manager))
                            self.assertIsNone(typed.capture)
                            self.assertIsNone(manager.wake_detector)
                            self.assertIsNotNone(manager.wake_reply_token)
                            export_ready.set()
                            release_output.set()
                            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed reply.')
                            await asyncio.wait_for(verifying.wait(), 5)
                            waiting = manager.waiting_transport
                            await asyncio.wait_for(waiting.received_audio.wait(), 5)
                            self.assertFalse(waiting.verified)
                            self.assertFalse(waiting.input().ready)
                            self.assertFalse(microphone_admitted(manager))
                            submit_pcm.assert_not_called()
                            self.assertIsNone(service.recognizer.reader)
                            release_verification.set()
                            fresh = await asyncio.wait_for(service.waiting.get(), 5)
                            self.assertIs(fresh, waiting)
                            self.assertTrue(fresh.verified)
                            resolve.assert_any_await(fresh.capture.pid, output_serial=None)
                            fresh.capture.stdout.feed_data(b'N' * 640)
                            self.assertEqual(await asyncio.wait_for(detector_pcm.get(), 5), b'N' * 640)
                            self.assertIsNone(service.recognizer.reader)
                            self.assertFalse(microphone_admitted(manager))
                    elif case in ('initial_capture_failure', 'waiting_capture_failure'):
                        switched = asyncio.Event()
                        refresh = manager.refresh_output

                        async def observed_refresh():
                            await refresh()
                            switched.set()

                        with patch.object(manager, 'refresh_output', side_effect=observed_refresh):
                            service.output_watch.emit()
                            await asyncio.wait_for(switched.wait(), 5)
                        self.assertIsNone(manager.failure)
                        self.assertTrue(manager.transport.verified)
                        self.assertEqual(manager.echo_revision, service.output_watch.revision)
                        self.assertEqual(len(service.echo_generations), 2)
                        while not service.waiting.empty():
                            service.waiting.get_nowait()
                        if case == 'initial_capture_failure':
                            self.assertEqual(await service.toggle(), 'inactive')
                            await asyncio.wait_for(service.waiting.get(), 5)
                        transports = []
                        factory = bot.LaptopAudioTransport.side_effect
                        failed = asyncio.Event()
                        original_state, original_wake_failed = manager.status.set_state, manager.wake_failed

                        def failing_capture(*args, **kwargs):
                            transport = factory(*args, **kwargs)
                            transport._spawn = AsyncMock(side_effect=OSError('Native capture could not start'))
                            transports.append(transport)
                            return transport

                        def state(value):
                            original_state(value)
                            if value.startswith('trouble'):
                                failed.set()

                        def wake_failed():
                            original_wake_failed()
                            failed.set()

                        with patch.object(bot.LaptopAudioTransport, 'side_effect', side_effect=failing_capture), \
                                patch.object(manager.status, 'set_state', side_effect=state), \
                                patch.object(manager, 'wake_failed', side_effect=wake_failed):
                            expected = 'starting' if case == 'initial_capture_failure' else 'inactive'
                            self.assertEqual(await service.toggle(), expected)
                            await asyncio.wait_for(failed.wait(), 5)
                            if manager.wake_startup is not None:
                                await asyncio.gather(asyncio.shield(manager.wake_startup), return_exceptions=True)
                        self.assertEqual(len(transports), 1)
                        self.assertEqual(transports[0].failure, speech.LAPTOP_CAPTURE_FAILURE)
                        self.assertTrue(transports[0].closed)
                        if case == 'initial_capture_failure':
                            self.assertEqual(manager.trouble, 'trouble-microphone')
                        else:
                            self.assertTrue(manager.wake_disabled)
                            self.assertIsNone(manager.failure)
                        self.assertFalse(microphone_admitted(manager))
                    elif case in ('startup_selection_active', 'startup_selection_waiting'):
                        await asyncio.wait_for(service.waiting.get(), 5)
                        service.output_watch.emit()
                        prior_waiting = await asyncio.wait_for(service.waiting.get(), 5)
                        self.assertTrue(prior_waiting.verified)
                        self.assertEqual(len(service.echo_generations), 2)
                        if case == 'startup_selection_waiting':
                            self.assertEqual(await service.toggle(), 'starting')
                            active = await asyncio.wait_for(service.started.get(), 5)
                            self.assertTrue(active.verified)
                        verifying, release_verification, refreshed = asyncio.Event(), asyncio.Event(), asyncio.Event()
                        releases.append(release_verification)
                        selected, captures, observations = [800], [], []
                        detector_pcm = asyncio.Queue()
                        refresh = manager.refresh_output

                        async def observed_refresh():
                            await refresh()
                            refreshed.set()

                        async def source(pid=None, *, output_serial=None):
                            if pid is not None:
                                if not captures:
                                    captures.append(manager.transport if case == 'startup_selection_active' else manager.waiting_transport)
                                    verifying.set()
                                    await release_verification.wait()
                                observations.append((pid, output_serial, selected[0], microphone_admitted(manager)))
                                if output_serial is not None and output_serial != selected[0]:
                                    raise RuntimeError('The current reference does not match the old selected output. Restart Kestrel.')
                            return 900

                        def private_pcm(detector, pcm):
                            detector_pcm.put_nowait(pcm)

                        with patch.object(manager, 'refresh_output', side_effect=observed_refresh), \
                                patch.object(bot.ECHO_REMOVAL, 'microphone_serial', new=AsyncMock(side_effect=source)), \
                                patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(side_effect=lambda playback_pid=None: selected[0])), \
                                patch.object(bot.WakeWordDetector, 'submit', autospec=True, side_effect=private_pcm):
                            self.assertEqual(await service.toggle(), 'starting' if case == 'startup_selection_active' else 'inactive')
                            await asyncio.wait_for(verifying.wait(), 5)
                            starting = captures[0]
                            old_capture = starting.capture
                            interval = manager.wake_interval
                            self.assertFalse(starting.verified)
                            self.assertTrue(detector_pcm.empty())
                            self.assertIsNone(service.recognizer.reader)
                            selected[0] = 801
                            service.output_watch.emit()
                            self.assertFalse(microphone_admitted(manager))
                            if case == 'startup_selection_waiting':
                                manager.wake_start(interval)
                                self.assertFalse(manager.desired_active)
                            release_verification.set()
                            await asyncio.wait_for(refreshed.wait(), 5)
                            fresh = (await asyncio.wait_for(service.started.get(), 5) if case == 'startup_selection_active'
                                     else await asyncio.wait_for(service.waiting.get(), 5))
                            self.assertIsNone(manager.failure, 'Normal startup must follow the current selected output')
                            self.assertTrue(old_capture.reaped.is_set())
                            self.assertTrue(fresh.verified)
                            self.assertEqual(manager.echo_revision, service.output_watch.revision)
                            self.assertEqual(len(service.echo_generations), 3)
                            self.assertTrue(all(not admitted for _, _, _, admitted in observations))
                            self.assertTrue(any(pid == fresh.capture.pid and current == 801
                                                for pid, _, current, _ in observations))
                            self.assertTrue(detector_pcm.empty())
                            self.assertIsNone(service.recognizer.reader)
                            if case == 'startup_selection_active':
                                self.assertTrue(microphone_admitted(manager))
                            else:
                                self.assertFalse(microphone_admitted(manager))
                                fresh.capture.stdout.feed_data(b'N' * 640)
                                self.assertEqual(await asyncio.wait_for(detector_pcm.get(), 5), b'N' * 640)
                    elif case in ('initial_selection_recovers', 'initial_selection_superseded', 'initial_selection_cleanup'):
                        entered, release_resolution, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
                        releases.append(release_resolution)
                        attempts, graph_children = [], []
                        refresh = manager.refresh_output

                        async def observed_refresh():
                            try:
                                await refresh()
                            finally:
                                completed.set()

                        async def selected(playback_pid=None):
                            attempts.append((service.output_watch.revision, microphone_admitted(manager)))
                            if case == 'initial_selection_cleanup':
                                child = Mock(returncode=None, stdout=Mock(
                                    read=AsyncMock(side_effect=OSError('Controlled initial graph read failure')),
                                    _transport=Mock()), wait=AsyncMock(side_effect=TimeoutError))
                                graph_children.append(child)
                                with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=child)):
                                    return await speech.EchoRemoval.output_serial(bot.ECHO_REMOVAL)
                            if len(attempts) == 1:
                                entered.set()
                                if case == 'initial_selection_superseded':
                                    await release_resolution.wait()
                                raise RuntimeError('Selected output is not exported yet. Restart Kestrel.')
                            return 800 + service.output_watch.revision

                        with patch.object(manager, 'refresh_output', side_effect=observed_refresh), \
                                patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(side_effect=selected)):
                            service.output_watch.emit()
                            self.assertFalse(microphone_admitted(manager))
                            if case == 'initial_selection_superseded':
                                await asyncio.wait_for(entered.wait(), 5)
                                service.output_watch.emit()
                                release_resolution.set()
                            await asyncio.wait_for(completed.wait(), 5)
                            if case == 'initial_selection_cleanup':
                                await service.state('trouble')
                                self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                                self.assertFalse(microphone_admitted(manager))
                                self.assertEqual(len(attempts), 1)
                                self.assertEqual(len(graph_children), 1)
                                self.assertEqual(graph_children[0].wait.await_count, 2)
                                graph_children[0].terminate.assert_called_once_with()
                                graph_children[0].kill.assert_called_once_with()
                                self.assertEqual(len(service.echo_generations), 2)
                            else:
                                self.assertIsNone(manager.failure, 'Initial unresolved output must settle without losing the service')
                                expected_revisions = [1, 2, 2] if case == 'initial_selection_superseded' else [1, 1, 1]
                                self.assertEqual(attempts, [(revision, False) for revision in expected_revisions])
                                self.assertEqual(manager.echo_revision, service.output_watch.revision)
                                self.assertTrue(microphone_admitted(manager))
                                self.assertTrue(handle.verified)
                                self.assertEqual(len(service.sessions), 1)
                                self.assertEqual(len(service.echo_generations), 3 if case == 'initial_selection_superseded' else 2)
                    elif case in ('superseded_shutdown', 'superseded_deadline'):
                        verifying, reaping, release_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
                        releases.append(release_cleanup)
                        refresh_done = asyncio.Event()
                        refresh = manager.refresh_output
                        deadlines = []
                        native_timeout = asyncio.timeout

                        def timeout(delay):
                            deadline = native_timeout(delay)
                            if delay == 30:
                                deadlines.append(deadline)
                            return deadline

                        async def observed_refresh():
                            try:
                                await refresh()
                            finally:
                                refresh_done.set()

                        async def serial(pid=None, *, output_serial=None):
                            if pid is not None and output_serial is not None:
                                verifying.set()
                                await asyncio.Event().wait()
                            return 900

                        with patch.object(manager, 'refresh_output', side_effect=observed_refresh), \
                                patch.object(bot.ECHO_REMOVAL, 'microphone_serial', new=AsyncMock(side_effect=serial)), \
                                patch.object(bot.asyncio, 'timeout', side_effect=timeout):
                            service.output_watch.emit()
                            await asyncio.wait_for(verifying.wait(), 5)
                            replacement = handle.capture
                            native_wait = replacement.wait.side_effect

                            async def held_wait():
                                reaping.set()
                                await release_cleanup.wait()
                                return await native_wait()

                            replacement.wait.side_effect = held_wait
                            service.output_watch.emit()
                            await asyncio.wait_for(reaping.wait(), 5)
                            generations = len(service.echo_generations)
                            self.assertFalse(microphone_admitted(manager))
                            self.assertFalse(replacement.reaped.is_set())
                            if case == 'superseded_shutdown':
                                service.stop()
                                # Cancellation is delivered while the actual child cleanup is retained.
                                await asyncio.sleep(0)
                            else:
                                self.assertEqual(len(deadlines), 1)
                                deadlines[0].reschedule(asyncio.get_running_loop().time())
                                await asyncio.sleep(0)
                            release_cleanup.set()
                            await asyncio.wait_for(refresh_done.wait(), 5)
                            self.assertTrue(replacement.reaped.is_set())
                            self.assertEqual(len(service.echo_generations), generations,
                                             'Outer cancellation must not start another echo generation')
                            self.assertFalse(microphone_admitted(manager))
                            if case == 'superseded_shutdown':
                                await close()
                                self.assertTrue(service.task.done())
                            else:
                                await service.state('trouble')
                                self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                                self.assertFalse(manager.desired_active)
                    elif case in ('persistent_route', 'graph_cleanup_route'):
                        await asyncio.wait_for(service.waiting.get(), 5)
                        self.assertEqual(await service.submit('Typed reply before silent output switch'), 'accepted')
                        typed = await asyncio.wait_for(service.started.get(), 5)
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed reply.')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Typed reply.')
                        await asyncio.wait_for(service.waiting.get(), 5)
                        command = AsyncMock(side_effect=[
                            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
                        ])
                        with patch.object(manager.local_actions, 'command', new=command):
                            self.assertEqual(await service.submit('mute'), 'accepted')
                            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                            await asyncio.wait_for(service.waiting.get(), 5)
                        playback = typed.playback
                        self.assertIsNotNone(playback)
                        self.assertIsNone(playback.returncode)
                        failed = asyncio.Event()
                        attempts, graph_children = [], []
                        original_state = manager.status.set_state

                        def state(value):
                            original_state(value)
                            if value == 'trouble':
                                failed.set()

                        async def invalid_route(playback_pid=None):
                            if playback_pid is not None:
                                self.assertEqual(playback_pid, playback.pid)
                                attempts.append(playback_pid)
                                self.assertFalse(microphone_admitted(manager))
                                if case == 'graph_cleanup_route':
                                    child = Mock(stdout=Mock(read=AsyncMock(side_effect=OSError('Controlled graph read failure')),
                                                             _transport=Mock()), returncode=None,
                                                 wait=AsyncMock(side_effect=TimeoutError))
                                    graph_children.append(child)
                                    with patch.object(speech.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=child)):
                                        return await speech.EchoRemoval.output_serial(bot.ECHO_REMOVAL, playback_pid)
                                raise RuntimeError('The idle playback route is unverified. Restart Kestrel.')
                            return 800

                        with patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(side_effect=invalid_route)), \
                                patch.object(manager.status, 'set_state', side_effect=state):
                            service.output_watch.emit()
                            # Watchdog includes the existing 30-second handover and bounded cleanup.
                            await asyncio.wait_for(failed.wait(), 35)
                        if case == 'graph_cleanup_route':
                            self.assertEqual(len(attempts), 1)
                            self.assertEqual(len(graph_children), 1)
                            self.assertEqual(graph_children[0].wait.await_count, 2)
                            graph_children[0].terminate.assert_called_once_with()
                            graph_children[0].kill.assert_called_once_with()
                            self.assertEqual(len(service.echo_generations), 2)
                        else:
                            self.assertGreaterEqual(len(attempts), 2)
                        self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                        self.assertFalse(microphone_admitted(manager))
                        self.assertTrue(typed.closed)
                    elif case == 'watcher_loss':
                        service.output_watch.on_failed()
                        await service.state('trouble')
                        self.assertFalse(microphone_admitted(manager))
                        self.assertEqual(await service.submit('new request'), 'unavailable')
                    elif case == 'verification_failure':
                        failed = asyncio.Event()
                        original_state = manager.status.set_state

                        def state(value):
                            original_state(value)
                            if value == 'trouble':
                                failed.set()

                        with patch.object(bot.ECHO_REMOVAL, 'output_serial', new=AsyncMock(side_effect=RuntimeError('private graph'))), \
                                patch.object(manager.status, 'set_state', side_effect=state):
                            service.output_watch.emit()
                            self.assertFalse(microphone_admitted(manager))
                            # Persistent unresolved selection uses the existing 30-second total deadline.
                            await asyncio.wait_for(failed.wait(), 35)
                        self.assertFalse(microphone_admitted(manager))
                        self.assertEqual(manager.failure, speech.OUTPUT_SWITCH_FAILURE)
                        self.assertNotIn('private graph', manager.failure)
                    else:
                        held, release = asyncio.Event(), asyncio.Event()
                        releases.append(release)
                        suspend = handle.suspend_capture

                        async def stop_capture():
                            await suspend()
                            held.set()
                            await release.wait()

                        with patch.object(handle, 'suspend_capture', side_effect=stop_capture):
                            service.output_watch.emit()
                            await asyncio.wait_for(held.wait(), 5)
                            self.assertEqual(await service.toggle(), 'inactive')
                            release.set()
                            await asyncio.wait_for(asyncio.shield(handle.cleanup_finished), 5)
                            await service.state('inactive')
                        self.assertFalse(manager.desired_active)
                        self.assertFalse(microphone_admitted(manager))
                        self.assertTrue(handle.closed)
                        self.assertEqual(len(service.sessions), 1)
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
                    if case not in ('typed_inactive', 'deferred_source', 'persistent_route', 'graph_cleanup_route'):
                        self.assertFalse(any(turn['speaker'] == 'you' for turn in manager.conversation.turns))
                finally:
                    for release in releases:
                        release.set()
                    await close()

    async def test_acknowledgement_output_preserves_history_repeat_and_typed_admission(self):
        loop = asyncio.get_running_loop()
        entered = {text: asyncio.Event() for text in ('First answer.', 'Second answer.', 'Obsolete answer.')}
        released = {text: threading.Event() for text in entered}
        closed = {text: asyncio.Event() for text in entered}
        for release in released.values():
            self.addCleanup(release.set)

        def chunks(**kwargs):
            text = kwargs['text']
            try:
                if text in entered:
                    loop.call_soon_threadsafe(entered[text].set)
                    if not released[text].wait(45):
                        raise AssertionError('Held answer synthesis was not released')
                yield np.ones(4800, dtype=np.float32)
            finally:
                if text in closed:
                    loop.call_soon_threadsafe(closed[text].set)

        brain = ScriptedBrain([
            '[delivery:neutral] Prepared.', '[delivery:neutral] First answer.',
            '[delivery:neutral] Second answer.', '[delivery:neutral] Obsolete answer.',
            '[delivery:neutral] Quick fresh answer.',
        ])
        self.addCleanup(brain.close)
        native_events = []
        handle, spoken, committed, _, processes, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False,
            synthesis_chunks=chunks, native_events=native_events,
        )
        service, manager = handle.service, handle.service.manager
        timers, acknowledgement_time = service.acknowledgement_timers, service.acknowledgement_time
        published = []
        expected_token = None
        thinking = asyncio.Event()
        native_publish = manager.conversation.publish

        def publish():
            native_publish()
            snapshot = json.loads(manager.conversation.payload)
            published.append(snapshot)
            if (expected_token is not None and manager.conversation.active is expected_token
                    and snapshot['turns'] and snapshot['turns'][-1]['text']
                    and snapshot['turns'][-1]['state'] == 'thinking'):
                thinking.set()

        manager.conversation.publish = publish
        waiting = await asyncio.wait_for(service.waiting.get(), 5)
        try:
            for index, (question, answer, phrase) in enumerate((
                ('Typed first question', 'First answer.', 'One moment.'),
                ('Typed second question', 'Second answer.', 'Just a moment.'),
            )):
                thinking.clear()
                expected_token = None
                published_start = len(published)
                self.assertEqual(await service.submit(question), 'accepted')
                if index == 0:
                    transport = await asyncio.wait_for(service.started.get(), 5)
                    output = transport.output()
                    self.assertEqual(len(output.prepared_acknowledgements), 3)
                await asyncio.wait_for(entered[answer].wait(), 5)
                callback, args, deadline = await asyncio.wait_for(timers.get(), 5)
                record = args[0]
                expected_token = record.token
                self.assertIs(manager.llm.current_reply(), record)
                self.assertFalse(record.closed)
                self.assertIsNone(transport.capture)
                self.assertFalse(manager.admission.admits_microphone())
                self.assertFalse(manager.desired_active)
                self.assertEqual(manager.status._state, 'inactive')
                self.assertTrue(waiting.capture.reaped.is_set())
                self.assertIsNone(manager.waiting_transport)
                before = sum(len(data) for child in service.audio_children for data in child.writes)
                acknowledgement_time[0] = max(acknowledgement_time[0], deadline)
                callback(*args)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), phrase)
                await asyncio.wait_for(thinking.wait(), 5)
                self.assertEqual(manager.llm.last_spoken_reply, phrase)
                self.assertEqual(manager.conversation.turns[-1]['text'], phrase)
                self.assertEqual(manager.conversation.turns[-1]['state'], 'thinking')
                pcm = b''.join(data for child in service.audio_children for data in child.writes)
                self.assertEqual(pcm[before:], bytes(9600))
                self.assertTrue(committed.empty())
                self.assertIsNone(manager.waiting_transport)
                acknowledgement_child = next(child for child in reversed(service.audio_children) if child.writes)
                self.assertTrue(acknowledgement_child.reaped.is_set(),
                                'Acknowledgement child must exit before the answer is admitted')
                acknowledgement_child.kill.assert_not_called()
                children_before_answer = len(service.audio_children)
                released[answer].set()
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), answer)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), answer)
                self.assertGreater(len(service.audio_children), children_before_answer)
                self.assertIsNot(transport.playback, acknowledgement_child)
                self.assertEqual(manager.llm.last_spoken_reply, answer)
                self.assertEqual(manager.conversation.turns[-1]['state'], 'complete')
                self.assertTrue(closed[answer].is_set())
                reply_rows = [snapshot['turns'][-1] for snapshot in published[published_start:]
                              if snapshot['turns'] and snapshot['turns'][-1]['speaker'] == 'kestrel'
                              and snapshot['turns'][-1]['text']]
                self.assertEqual(reply_rows, [
                    {'speaker': 'kestrel', 'text': phrase, 'state': 'speaking'},
                    {'speaker': 'kestrel', 'text': phrase, 'state': 'thinking'},
                    {'speaker': 'kestrel', 'text': phrase + ' ' + answer, 'state': 'speaking'},
                    {'speaker': 'kestrel', 'text': phrase + ' ' + answer, 'state': 'complete'},
                ])
            self.assertEqual([m for m in brain.requests[2][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Typed first question'},
                {'role': 'assistant', 'content': 'First answer.'},
                {'role': 'user', 'content': 'Typed second question'},
            ])
            self.assertEqual(await service.submit('repeat that'), 'accepted')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Second answer.')
            barrier = DataFrame()
            await output.queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(len(brain.requests), 3)
            self.assertTrue(timers.empty(), 'Exact repeat never arms an acknowledgement')
            self.assertTrue(committed.empty())

            self.assertEqual(await service.submit('Typed obsolete question'), 'accepted')
            await asyncio.wait_for(entered['Obsolete answer.'].wait(), 5)
            obsolete_callback, obsolete_args, obsolete_deadline = await asyncio.wait_for(timers.get(), 5)
            writing = asyncio.Event()
            release_write = asyncio.Event()
            self.addCleanup(release_write.set)
            playback = None
            native_open_playback = transport._open_playback

            async def hold_write():
                writing.set()
                await release_write.wait()

            async def open_held_playback():
                nonlocal playback
                await native_open_playback()
                playback = transport.playback
                playback.stdin.drain.side_effect = hold_write

            with patch.object(transport, '_open_playback', side_effect=open_held_playback):
                acknowledgement_time[0] = max(acknowledgement_time[0], obsolete_deadline)
                obsolete_callback(*obsolete_args)
                await asyncio.wait_for(writing.wait(), 5)
            held_bytes = sum(len(data) for child in service.audio_children for data in child.writes)
            self.assertEqual(await service.submit("that's all"), 'accepted')
            released['Obsolete answer.'].set()
            release_write.set()
            cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
            await asyncio.wait_for(asyncio.shield(cleanup), 5)
            self.assertTrue(closed['Obsolete answer.'].is_set())
            self.assertTrue(playback.reaped.is_set())
            self.assertTrue(all(child.reaped.is_set() for child in service.audio_children if not child.wake_capture))
            self.assertEqual(sum(len(data) for child in service.audio_children for data in child.writes), held_bytes)
            self.assertIsNone(output.acknowledgement_record)
            self.assertFalse(output.acknowledgement_tasks)
            self.assertEqual(manager.conversation.turns, [])
            self.assertIsNone(transport.llm.last_spoken_reply)
            before = sum(len(data) for child in service.audio_children for data in child.writes)
            acknowledgement_time[0] = max(acknowledgement_time[0], obsolete_deadline)
            obsolete_callback(*obsolete_args)
            self.assertEqual(sum(len(data) for child in service.audio_children for data in child.writes), before)
            self.assertEqual(manager.conversation.turns, [])
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())

            self.assertEqual(await service.toggle(), 'starting')
            fresh = await asyncio.wait_for(service.started.get(), 5)
            self.assertIsNotNone(fresh.capture)
            self.assertEqual(manager.conversation.turns, [])
            self.assertIsNone(fresh.llm.last_spoken_reply)
            quick_finished = asyncio.Event()

            @fresh.output().event_handler('on_after_push_frame')
            async def quick_output_completed(processor, frame):
                if (isinstance(frame, LLMFullResponseEndFrame)
                        and manager.admission.may_speak(reply_progress.token_of(frame))):
                    quick_finished.set()

            fresh.capture.stdout.feed_data(bytes(640))
            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(fresh, 'Fresh quick question')
            quick_callback, quick_args, quick_deadline = await asyncio.wait_for(timers.get(), 5)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Quick fresh answer.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Quick fresh answer.')
            await asyncio.wait_for(quick_finished.wait(), 5)
            before = sum(len(data) for child in service.audio_children for data in child.writes)
            acknowledgement_time[0] = max(acknowledgement_time[0], quick_deadline)
            quick_callback(*quick_args)
            acknowledgement_time[0] = max(acknowledgement_time[0], obsolete_deadline)
            obsolete_callback(*obsolete_args)
            barrier = DataFrame()
            await fresh.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(fresh.processed.get(), 5), barrier)
            self.assertEqual(sum(len(data) for child in service.audio_children for data in child.writes), before)
            self.assertTrue(spoken.empty())
            self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                             [{'role': 'user', 'content': 'Fresh quick question'}])
            payloads = json.dumps([brain.requests, native_events])
            for phrase in ('One moment.', 'Just a moment.', 'Give me a moment.'):
                self.assertNotIn(phrase, payloads)
        finally:
            for release in released.values():
                release.set()
            await close()
        for process, home in processes:
            self.assertIsNotNone(process.returncode)
            self.assertFalse(home.exists())


if __name__ == '__main__':
    unittest.main()
