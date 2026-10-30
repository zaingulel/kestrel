import asyncio
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
from pipecat.frames.frames import (
    DataFrame, InputAudioRawFrame, LLMFullResponseEndFrame, InterruptionFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, TranscriptionFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

import bot
from conversation_fixtures import ENGINE_STARTUP, WholeConversationCase, microphone_admitted
import reply_progress
import speech
from test_hermes import ScriptedBrain, require_native_hermes


class WholeConversationTests(WholeConversationCase):
    async def test_phonon_typed_reply_preserves_inactive_microphone(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nTyped reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True, tts_model=None,
        )
        service = handle.service
        self.assertEqual(await service.submit('Typed question'), 'accepted')
        typed = await asyncio.wait_for(service.started.get(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Typed reply.')
        self.assertIsInstance(service.manager.voice, speech.PhononTTS)
        self.assertIs(service.manager.voice.model, service.model)
        service.recognizer.load.assert_awaited_once_with(bytes(9600))
        self.assertIsNone(typed.capture)
        self.assertFalse(service.manager.desired_active)
        self.assertEqual(service.manager.status._state, 'inactive')
        self.assertTrue(all(child.stdin is not None for child in service.audio_children if not child.wake_capture))
        pcm = b''.join(data for child in service.audio_children for data in child.writes)
        self.assertTrue(pcm)
        self.assertEqual(len(pcm) % 2, 0)
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'Typed question'}])
        self.assertEqual(await service.toggle(), 'starting')
        fresh = await asyncio.wait_for(service.started.get(), 5)
        self.assertIsNotNone(fresh.capture)
        self.assertEqual(service.manager.conversation.turns, [])
        self.assertIsNone(fresh.llm.last_spoken_reply)
        self.assertIsInstance(service.manager.voice, speech.PhononTTS)
        self.assertIs(service.manager.voice.model, service.model)
        await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(fresh, 'Fresh voice question')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'Fresh voice question'}])
        self.assertEqual([item.args[0] for item in service.model.stream.call_args_list],
                         ['One moment.', 'Just a moment.', 'Give me a moment.', 'Typed reply.', 'Fresh reply.'])
        await close()

    async def test_typed_inactive_preserves_voice_and_context(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFirst.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nSecond.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFresh.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        with patch.object(service.manager.status, 'set_state', wraps=service.manager.status.set_state) as set_state:
            self.assertEqual(await service.submit('Typed A'), 'accepted')
            transport = await asyncio.wait_for(service.started.get(), 5)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'First.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'First.')
            self.assertIsNone(transport.capture)
            self.assertFalse(service.manager.desired_active)
            self.assertEqual(service.manager.status._state, 'inactive')
            self.assertEqual(await service.submit('Typed B'), 'accepted')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Second.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Second.')
        self.assertEqual({item.args[0] for item in set_state.call_args_list}, {'inactive'})
        self.assertEqual(len(service.sessions), 1)
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'Typed A'}, {'role': 'assistant', 'content': 'First.'},
            {'role': 'user', 'content': 'Typed B'},
        ])
        self.assertEqual([t['source'] for t in service.manager.conversation.turns if t['speaker'] == 'you'],
                         ['typed', 'typed'])
        self.assertTrue(all(child.stdin is not None for child in service.audio_children if not child.wake_capture))
        self.assertTrue(any(child.writes for child in service.audio_children))
        self.assertEqual(await service.toggle(), 'starting')
        fresh = await asyncio.wait_for(service.started.get(), 5)
        self.assertIsNotNone(fresh.capture)
        self.assertEqual(service.manager.conversation.turns, [])
        self.assertIsNone(fresh.llm.last_spoken_reply)
        await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(fresh, 'Spoken fresh')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'Spoken fresh'}])
        await close()

    async def test_typed_interrupt_discards_partial_speech_and_old_output(self):
        blocked, release_provider = threading.Event(), threading.Event()
        self.addCleanup(release_provider.set)
        synthesis_blocked, release_synthesis = threading.Event(), threading.Event()
        self.addCleanup(release_synthesis.set)
        timer_entered, release_timer = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_timer.set)

        def chunks(**kwargs):
            if 'Unheard obsolete continuation' in kwargs['text']:
                synthesis_blocked.set()
                if not release_synthesis.wait(45):
                    raise AssertionError('Obsolete synthesis was not released')
                yield np.full(4800, .5, dtype=np.float32)
            else:
                yield np.zeros(4800, dtype=np.float32)

        def old_reply():
            yield {'content': '[delivery:neutral]\nHeard sentence. [deliv'}, None
            yield {'content': 'ery:unknown] Unheard obsolete continuation. Pending'}, None
            blocked.set()
            if not release_provider.wait(45):
                raise AssertionError('Old provider was not released')
            yield {'content': ' obsolete tail.'}, None
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nReply A.'}, None), ({}, 'stop')], old_reply(),
            [({'content': '[delivery:neutral]\nReply C.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFresh speech.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        strategies = []
        native_strategy = bot.TurnAnalyzerUserTurnStopStrategy

        def capture_strategy(**kwargs):
            strategy = native_strategy(**kwargs)
            strategies.append(strategy)
            return strategy

        with patch.object(bot, 'TurnAnalyzerUserTurnStopStrategy', side_effect=capture_strategy):
            transport, spoken, committed, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, production_turn_strategies=True, synthesis_chunks=chunks,
            )
        service, manager = transport.service, transport.service.manager
        _, user, context = manager.ingress
        analyzer = strategies[0]._turn_analyzer

        async def process(processor, frame):
            done = asyncio.Event()

            @processor.event_handler('on_after_process_frame')
            async def observed(item, actual):
                if actual is frame:
                    done.set()

            await processor.queue_frame(frame)
            await asyncio.wait_for(done.wait(), 5)

        async def transcript(text):
            frame = TranscriptionFrame(text, '', '', finalized=True)
            frame.input_mark = self.input_mark(transport)
            await process(user, frame)

        with patch.object(analyzer, '_predict_endpoint', return_value={'prediction': 1, 'probability': 1.0}):
            self.assertEqual(await service.submit('Typed A'), 'accepted')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Reply A.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Reply A.')
            transport.capture.stdout.feed_data(bytes(640))
            await process(user, VADUserStartedSpeakingFrame())
            await process(user, InputAudioRawFrame(bytes(640), 16000, 1))
            await transcript('Spoken B')
            await process(user, VADUserStoppedSpeakingFrame())
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Heard sentence.')
            self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
            self.assertTrue(await asyncio.to_thread(synthesis_blocked.wait, 5))
            assistant_done, cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
            self.addCleanup(release_cleanup.set)
            original_discard = transport._discard_playback
            held_frame_ids, handover_order = [], []
            assistant_continuation_ready = asyncio.Event()
            original_complete = bot.TypedHandover.frame_completed
            original_stt_reset = transport.stt.discard_pending
            original_user_reset = user.reset
            original_user_queue = user.queue_frame
            original_admitted = manager.admission.take_typed
            typed_token = None

            def completed(handover, role, frame):
                original_complete(handover, role, frame)
                if isinstance(frame, InterruptionFrame):
                    if role == 'assistant':
                        held_frame_ids.append(frame.id)
                        handover_order.append(('assistant_complete', frame.id))
                        # The matching future has queued its continuation before this FIFO checkpoint.
                        asyncio.get_running_loop().call_soon(assistant_continuation_ready.set)
                        assistant_done.set()
                    elif role == 'output':
                        handover_order.append(('output_complete', frame.id))

            async def stt_reset():
                handover_order.append(('stt_reset', old_child.reaped.is_set()))
                await original_stt_reset()

            async def user_reset():
                handover_order.append(('user_reset', old_child.reaped.is_set()))
                await original_user_reset()

            async def user_queue(frame, direction=FrameDirection.DOWNSTREAM, callback=None):
                if isinstance(frame, bot.LLMMessagesAppendFrame):
                    handover_order.append(('typed_append', old_child.reaped.is_set()))
                await original_user_queue(frame, direction, callback)

            def admitted(token):
                handover_order.append(('typed_admitted', token))
                original_admitted(token)

            async def discard():
                cleanup_started.set()
                await release_cleanup.wait()
                await original_discard()
                handover_order.append(('playback_reaped', old_child.reaped.is_set()))

            old_child = transport.playback
            with patch.object(transport, '_discard_playback', side_effect=discard), \
                    patch.object(bot.TypedHandover, 'frame_completed', autospec=True, side_effect=completed), \
                    patch.object(transport.stt, 'discard_pending', side_effect=stt_reset), \
                    patch.object(user, 'reset', side_effect=user_reset), \
                    patch.object(user, 'queue_frame', side_effect=user_queue), \
                    patch.object(manager.admission, 'take_typed', side_effect=admitted):
                self.assertEqual(await service.submit('Typed C'), 'accepted')
                typed_token = manager.handover.ticket
                release_synthesis.set()
                await asyncio.wait_for(assistant_done.wait(), 5)
                await asyncio.wait_for(cleanup_started.wait(), 5)
                await asyncio.wait_for(assistant_continuation_ready.wait(), 5)
                self.assertIsNotNone(manager.handover)
                self.assertFalse(microphone_admitted(manager))
                self.assertFalse(old_child.reaped.is_set())
                self.assertFalse(any(m.get('content') == 'Typed C' for m in context.get_messages()))
                self.assertEqual(len(brain.requests), 3)
                self.assertIn({'role': 'assistant', 'content': 'Heard sentence.'}, context.get_messages())
                release_provider.set()
                release_cleanup.set()
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Heard sentence.')
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Reply C.')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Reply C.')
                self.assertTrue(old_child.reaped.is_set())
                self.assertEqual(len(held_frame_ids), 1)
                kinds = [kind for kind, _ in handover_order]
                output_index = handover_order.index(('output_complete', held_frame_ids[0]))
                self.assertLess(kinds.index('assistant_complete'), kinds.index('playback_reaped'))
                self.assertLess(kinds.index('playback_reaped'), output_index)
                for kind in ('stt_reset', 'user_reset', 'typed_append', 'typed_admitted'):
                    self.assertIn(kind, kinds)
                    self.assertTrue(all(index > output_index for index, (actual, _) in enumerate(handover_order)
                                        if actual == kind), handover_order)
                self.assertTrue(all(value is True for kind, value in handover_order
                                    if kind in ('stt_reset', 'user_reset', 'typed_append')), handover_order)
                self.assertEqual([value for kind, value in handover_order if kind == 'typed_admitted'], [typed_token])
            self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Typed A'}, {'role': 'assistant', 'content': 'Reply A.'},
                {'role': 'user', 'content': 'Spoken B'}, {'role': 'assistant', 'content': 'Heard sentence.'},
                {'role': 'user', 'content': 'Typed C'},
            ])
            self.assertEqual([t['source'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                             ['typed', 'spoken', 'typed'])
        transport.capture.stdout.feed_data(bytes(640))
        queued_vad = VADUserStartedSpeakingFrame()
        vad_held, release_vad, vad_processed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release_vad.set)
        native_user_process = user.process_frame
        native_admitted = manager.admission.take_typed
        typed_acknowledgements = asyncio.Queue()
        admission_tokens, settled_before_admission = [], []

        async def hold_queued_vad(frame, direction):
            if frame is queued_vad:
                vad_held.set()
                await release_vad.wait()
            await native_user_process(frame, direction)

        @user.event_handler('on_after_process_frame')
        async def queued_vad_completed(processor, frame):
            if frame is queued_vad:
                vad_processed.set()

        def acknowledge_queued_handover(token):
            admission_tokens.append(token)
            settled_before_admission.append(vad_processed.is_set())
            native_admitted(token)
            typed_acknowledgements.put_nowait(token)

        spoken_origin = manager.llm.spoken_origin
        before_handover = list(manager.conversation.turns)
        with patch.object(user, 'process_frame', side_effect=hold_queued_vad), \
                patch.object(manager.admission, 'take_typed', side_effect=acknowledge_queued_handover):
            await user.queue_frame(queued_vad)
            await asyncio.wait_for(vad_held.wait(), 5)
            self.assertEqual(await service.submit('repeat that'), 'accepted')
            accepted_token = manager.handover.ticket
            repeat_finished = asyncio.Event()

            @transport.output().event_handler('on_after_push_frame')
            async def repeat_output_completed(processor, frame):
                if isinstance(frame, LLMFullResponseEndFrame) and reply_progress.token_of(frame) is accepted_token:
                    repeat_finished.set()

            self.assertTrue(manager.admission.may_speak(accepted_token))
            self.assertFalse(microphone_admitted(manager))
            release_vad.set()
            await asyncio.wait_for(vad_processed.wait(), 5)
            self.assertTrue(manager.admission.may_speak(accepted_token),
                            'Already-queued speech cannot replace the accepted typed owner')
            self.assertIs(manager.llm.spoken_origin, spoken_origin)
            self.assertIs(await asyncio.wait_for(typed_acknowledgements.get(), 5), accepted_token)
            if manager.submission_task is not None:
                await asyncio.wait_for(asyncio.shield(manager.submission_task), 5)
            self.assertIsNone(manager.handover)
            self.assertTrue(microphone_admitted(manager))
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Reply C.')
            await asyncio.wait_for(repeat_finished.wait(), 5)
            self.assertTrue(committed.empty(), 'Typed repeat does not duplicate the native assistant history')
            self.assertEqual(manager.conversation.turns[len(before_handover):], [
                {'speaker': 'you', 'text': 'repeat that', 'source': 'typed', 'state': 'complete'},
                {'speaker': 'kestrel', 'text': 'Reply C.', 'state': 'complete'},
            ])
            self.assertEqual(admission_tokens, [accepted_token])
            self.assertTrue(typed_acknowledgements.empty())
            self.assertEqual(await service.submit('stop'), 'accepted')
            next_token = manager.handover.ticket
            self.assertIsNot(next_token, accepted_token)
            self.assertIs(await asyncio.wait_for(typed_acknowledgements.get(), 5), next_token)
            if manager.submission_task is not None:
                await asyncio.wait_for(asyncio.shield(manager.submission_task), 5)
            self.assertIsNone(manager.handover)
            self.assertEqual(admission_tokens, [accepted_token, next_token])
            self.assertEqual(settled_before_admission, [True, True],
                             'Native queued speech must settle before typed admission reopens input')
            self.assertTrue(typed_acknowledgements.empty())
            self.assertEqual(len(brain.requests), 4)
            self.assertTrue(spoken.empty())
        native = Mock(returncode=None)
        native.stdin.drain = AsyncMock()
        native.wait = AsyncMock()
        native.stdout = asyncio.StreamReader()
        request_written = asyncio.Event()
        native.stdin.write.side_effect = lambda data: request_written.set()
        service.recognizer.process = native
        self.addCleanup(lambda: native.stdout.feed_data(b'{"text":"cleanup"}\n'))
        native_sleep = asyncio.sleep

        async def hold_native_timer(delay, result=None):
            if asyncio.current_task() is strategies[0]._timeout_task:
                timer_entered.set()
                await release_timer.wait()
                return result
            return await native_sleep(delay, result=result)

        with patch.object(analyzer, '_predict_endpoint', return_value={'prediction': 0, 'probability': 0.0}), \
                patch.object(asyncio, 'sleep', side_effect=hold_native_timer):
            await process(transport.stt, VADUserStartedSpeakingFrame())
            await process(transport.stt, InputAudioRawFrame(bytes(640), 16000, 1))
            await transcript('abandoned mute')
            await process(transport.stt, VADUserStoppedSpeakingFrame())
            await asyncio.wait_for(timer_entered.wait(), 5)
            await asyncio.wait_for(request_written.wait(), 5)
            await transport.stt._segment_queue.put(b'queued old segment')
            timer = strategies[0]._timeout_task
            self.assertIsNotNone(timer)
            self.assertFalse(timer.done())
            self.assertTrue(analyzer._audio_buffer)
            self.assertEqual(await service.submit('stop'), 'accepted')
            # A barrier at the Admission's typed take observes the forced stop/reset first.
            admitted = asyncio.Event()
            original_admitted = manager.admission.take_typed

            def acknowledge(token):
                original_admitted(token)
                admitted.set()

            with patch.object(manager.admission, 'take_typed', side_effect=acknowledge):
                await asyncio.wait_for(admitted.wait(), 5)
            self.assertTrue(timer.done())
            self.assertGreater(timer.cancelling(), 0)
            self.assertIsNone(strategies[0]._timeout_task)
            self.assertEqual(analyzer._audio_buffer, [])
            self.assertTrue(transport.stt.awaiting_fresh_vad)
            native.stdout.feed_data(b'{"text":"late old mute"}\n')
            await service.recognizer.drain()
            self.assertEqual(native.stdin.write.call_count, 1)
            self.assertFalse(any(m.get('content') == 'abandoned mute' for m in context.get_messages()))
            self.assertFalse(any(t['text'] in ('abandoned mute', 'late old mute') for t in manager.conversation.turns))
        with patch.object(analyzer, '_predict_endpoint', return_value={'prediction': 1, 'probability': 1.0}):
            await process(transport.stt, VADUserStartedSpeakingFrame())
            self.assertFalse(transport.stt.awaiting_fresh_vad)
            await process(user, InputAudioRawFrame(bytes(640), 16000, 1))
            await transcript('Fresh spoken turn')
            await process(user, VADUserStoppedSpeakingFrame())
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh speech.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh speech.')
        self.assertEqual(manager.llm.last_spoken_reply, 'Fresh speech.')
        self.assertTrue(all(np.all(np.abs(np.frombuffer(chunk, dtype='<i2').astype(np.int32)) < 8192)
                            for child in service.audio_children for chunk in child.writes),
                        'Obsolete +0.5 synthesis PCM must never reach a playback child')
        self.assertTrue(spoken.empty())
        await close()

    async def test_typed_admission_is_owned_across_readiness_and_dismissal(self):
        require_native_hermes()
        from desktop import control
        prepare_entered, release_prepare = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_prepare.set)
        native_prepare = bot.VoiceConversations.prepare
        notes_home = tempfile.TemporaryDirectory(prefix='kestrel-typed-notes-')
        self.addCleanup(notes_home.cleanup)
        notes = Path(notes_home.name) / 'notes'

        async def prepare(manager):
            prepare_entered.set()
            await release_prepare.wait()
            await native_prepare(manager)

        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        with patch.object(bot.VoiceConversations, 'prepare', new=prepare):
            opening = asyncio.create_task(self.open_session(brain, through_service=True, activate=False, memory_root=notes))
            await asyncio.wait_for(prepare_entered.wait(), 5)
            self.assertEqual(await control.submit('Before model preparation'), 'unavailable')
            release_prepare.set()
            handle, spoken, committed, _, _, close = await asyncio.wait_for(opening, ENGINE_STARTUP)
        service, manager = handle.service, handle.service.manager
        await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
        initializing, release_initialization, initialization_finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release_initialization.set)
        native_reset = manager.conversation.begin_session

        async def reset():
            await native_reset()
            initializing.set()
            await release_initialization.wait()
            initialization_finished.set()

        with patch.object(manager.conversation, 'begin_session', side_effect=reset):
            self.assertEqual(await service.submit('Revoked during initialization'), 'accepted')
            await asyncio.wait_for(initializing.wait(), 5)
            self.assertEqual(await service.submit('Ingress is busy'), 'busy')
            self.assertEqual(await service.toggle(), 'starting')
            self.assertEqual(await service.toggle(), 'inactive')
            release_initialization.set()
            await asyncio.wait_for(initialization_finished.wait(), 5)
            await service.state('inactive')
        self.assertEqual(service.sessions, [])
        self.assertEqual(manager.conversation.turns, [])
        beginning, release_begin = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_begin.set)
        native_read = service.channel.read_event

        async def read_event():
            event = await native_read()
            if event.get('session_ready') is True:
                beginning.set()
                await release_begin.wait()
            return event

        with patch.object(service.channel, 'read_event', side_effect=read_event):
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            await asyncio.wait_for(beginning.wait(), 5)
            receipts = asyncio.Queue()
            native_ack = manager.admission.take_typed

            def acknowledge(token):
                native_ack(token)
                receipts.put_nowait(token)

            with patch.object(manager.admission, 'take_typed', side_effect=acknowledge):
                self.assertEqual(await service.submit('Ordinary waiting for begin'), 'accepted')
                first = await asyncio.wait_for(receipts.get(), 5)
                if manager.submission_task is not None:
                    await asyncio.wait_for(asyncio.shield(manager.submission_task), 5)
                self.assertEqual(len(brain.requests), 1)
                self.assertFalse(manager.session_ready.done())
                self.assertEqual([t['text'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                                 ['Ordinary waiting for begin'])
                await service.submit('repeat that', lose_receipt=True)
                second = await asyncio.wait_for(receipts.get(), 5)
                self.assertIsNot(first, second)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                self.assertFalse(manager.session_ready.done(), 'Local commands do not wait for native begin')
                self.assertTrue(receipts.empty(), 'Receipt loss never causes another service admission')
                self.assertEqual([t['text'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                                 ['Ordinary waiting for begin', 'repeat that'])
                self.assertEqual(await service.submit('Ordinary dismissed'), 'accepted')
                await asyncio.wait_for(receipts.get(), 5)
                self.assertEqual(await service.toggle(), 'inactive')
                release_begin.set()
                cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                await asyncio.wait_for(asyncio.shield(cleanup), 5)
        self.assertEqual(manager.conversation.turns, [])
        self.assertEqual(manager.status._state, 'inactive')
        self.assertFalse(transport.admission.is_open())
        self.assertEqual(len(brain.requests), 1)
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        self.assertIsNone(manager.submission_task)
        self.assertEqual(await service.toggle(), 'starting')
        handover_session = await asyncio.wait_for(service.started.get(), 5)
        stop_entered, stop_finished, release_stop = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release_stop.set)
        user = manager.ingress[1]

        @user.event_handler('on_before_process_frame')
        async def hold_stop(processor, frame):
            if isinstance(frame, ProposedUserStoppedSpeakingFrame):
                stop_entered.set()
                try:
                    await release_stop.wait()
                finally:
                    stop_finished.set()

        self.assertEqual(await service.submit('Cancelled before user completion'), 'accepted')
        await asyncio.wait_for(stop_entered.wait(), 5)
        cancelled_submission = manager.submission_task
        prepared_model = manager.model
        native_process = service.channel.process
        self.assertFalse(cancelled_submission.done())
        self.assertEqual(await service.toggle(), 'inactive')
        await asyncio.wait_for(stop_finished.wait(), 5)
        cleanup = await asyncio.wait_for(asyncio.shield(handover_session.cleanup_finished), 5)
        await asyncio.wait_for(asyncio.shield(cleanup), 5)
        self.assertTrue(cancelled_submission.cancelled())
        self.assertFalse(manager.closed, 'Dismissing a handover must retain the running service')
        self.assertIsNone(manager.failure)
        self.assertEqual(manager.status._state, 'inactive')
        self.assertEqual(manager.conversation.turns, [])
        self.assertIsNone(manager.handover)
        self.assertIsNone(manager.submission_task)
        self.assertIs(manager.model, prepared_model)
        self.assertIsNone(native_process.returncode)
        service.recognizer.close.assert_not_awaited()
        bot.ECHO_REMOVAL.close.assert_not_called()
        self.assertEqual(await control.toggle(), 'starting')
        fresh_session = await asyncio.wait_for(service.started.get(), 5)
        self.assertIsNone(fresh_session.llm.last_spoken_reply)
        self.assertEqual(manager.conversation.turns, [])
        self.assertEqual(await service.toggle(), 'inactive')
        cleanup = await asyncio.wait_for(asyncio.shield(fresh_session.cleanup_finished), 5)
        await asyncio.wait_for(asyncio.shield(cleanup), 5)
        self.assertEqual(len(brain.requests), 1)
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        corrupt = notes / 'MEMORY.md'
        corrupt.write_bytes(b'isolated invalid notes\xff')
        corrupt.chmod(0o600)
        self.assertEqual(await service.submit('Accepted with unavailable notes'), 'accepted')
        failed_session = await asyncio.wait_for(service.started.get(), 5)
        heard = [await asyncio.wait_for(spoken.get(), 5), await asyncio.wait_for(spoken.get(), 5)]
        self.assertEqual(' '.join(heard), bot.MEMORY_ERROR)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), bot.MEMORY_ERROR)
        barrier = DataFrame()
        await failed_session.output().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(failed_session.processed.get(), 5), barrier)
        self.assertEqual([t['text'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                         ['Accepted with unavailable notes'])
        self.assertEqual(manager.conversation.turns[-1]['state'], 'failed')
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual(corrupt.read_bytes(), b'isolated invalid notes\xff')
        if manager.submission_task is not None:
            await asyncio.wait_for(asyncio.shield(manager.submission_task), 5)
        handover_waiting, release_handover = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_handover.set)
        deadlines = asyncio.Queue()
        native_timeout = asyncio.timeout
        user = manager.ingress[1]
        native_queue = user.queue_frame

        def timeout(seconds):
            deadline = native_timeout(seconds)
            if seconds == 5 and asyncio.current_task() is manager.submission_task:
                deadlines.put_nowait(deadline)
            return deadline

        async def queue(frame, direction=FrameDirection.DOWNSTREAM, callback=None):
            if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
                handover_waiting.set()
                await release_handover.wait()
            await native_queue(frame, direction, callback)

        with patch.object(bot.asyncio, 'timeout', side_effect=timeout), \
                patch.object(user, 'queue_frame', side_effect=queue):
            self.assertEqual(await service.submit('Handover cannot finish'), 'accepted')
            deadline = await asyncio.wait_for(deadlines.get(), 5)
            await asyncio.wait_for(handover_waiting.wait(), 5)
            deadline.reschedule(asyncio.get_running_loop().time())
            await service.state('trouble-handover')
            self.assertEqual(manager.conversation.turns[-2], {
                'speaker': 'you', 'text': 'Handover cannot finish', 'state': 'complete', 'source': 'typed',
            })
            self.assertEqual(manager.conversation.turns[-1]['state'], 'failed')
            self.assertEqual(manager.conversation.turns[-1]['text'], '',
                             'The failed-state caption is visible without inventing unheard speech')
            self.assertEqual(await service.submit('No automatic retry'), 'unavailable')
            self.assertEqual(await service.toggle(), 'unavailable')
            release_handover.set()
        self.assertEqual(len(brain.requests), 1)
        await close()

    async def test_failure_publishes_accepted_typed_request(self):
        for path, trouble in (('capture', 'trouble-microphone'), ('output switch', 'trouble')):
            with self.subTest(path=path):
                brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
                self.addCleanup(brain.close)
                transport, _, _, _, _, close = await self.open_session(
                    brain, through_service=True, native_audio=True,
                )
                service, manager = transport.service, transport.service.manager
                await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
                await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                baseline = len(brain.requests)
                held, release = asyncio.Event(), asyncio.Event()
                self.addCleanup(release.set)
                user = manager.ingress[1]
                native_queue = user.queue_frame

                async def queue(frame, direction=FrameDirection.DOWNSTREAM, callback=None):
                    if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
                        held.set()
                        await release.wait()
                    await native_queue(frame, direction, callback)

                if path == 'capture':
                    with patch.object(user, 'queue_frame', side_effect=queue):
                        self.assertEqual(manager.submit('Typed during failure'), 'accepted')
                        await asyncio.wait_for(held.wait(), 5)
                        transport.fail(speech.LAPTOP_CAPTURE_FAILURE)
                        release.set()
                        await service.state(trouble)
                else:
                    with patch.object(transport, 'suspend_capture', new=AsyncMock(side_effect=RuntimeError)):
                        self.assertEqual(manager.submit('Typed during failure'), 'accepted')
                        service.output_watch.emit()
                        await service.state(trouble)
                self.assertEqual(manager.conversation.turns, [
                    {'speaker': 'you', 'text': 'Typed during failure', 'state': 'complete', 'source': 'typed'},
                    {'speaker': 'kestrel', 'text': '', 'state': 'failed'},
                ])
                self.assertEqual(len(brain.requests), baseline)
                await close()


if __name__ == '__main__':
    unittest.main()
