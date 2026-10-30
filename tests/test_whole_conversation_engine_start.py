import asyncio
import json
import os
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import numpy as np
from pipecat.frames.frames import DataFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

import bot
from conversation_fixtures import ENGINE_MISSING_ADVICE, SOURCE_IDENTITY_REFUSAL, WholeConversationCase, wait_until
from test_hermes import ROOT, ScriptedBrain


# Owner-approved wording, an oracle independent of bot.SLOW_START_LINE.
SLOW_START_NOTICE = 'The brain was slow to start, so replies may take longer.'


class WholeConversationTests(WholeConversationCase):
    def slow_start_channel(self):
        channel = bot.HermesRequestChannel()
        clock = patch.object(channel, '_now', side_effect=[100.0, 108.5])
        clock.start()
        self.addCleanup(clock.stop)
        return channel

    async def test_slow_brain_start_is_told_once_when_addressed(self):
        notice_entered, notice_release, answer_release = threading.Event(), threading.Event(), threading.Event()
        for event in (notice_entered, notice_release, answer_release):
            self.addCleanup(event.set)

        def chunks(**kwargs):
            if kwargs['text'] == SLOW_START_NOTICE and not notice_entered.is_set():
                notice_entered.set()
                if not notice_release.wait(45):
                    raise AssertionError('Slow-start notice synthesis was not released')
            yield np.zeros(4800, dtype=np.float32)

        def held():
            if not answer_release.wait(45):
                raise AssertionError('Held answer was not released')
            yield {'content': '[delivery:neutral] Held answer.'}, None
            yield {}, 'stop'

        brain = ScriptedBrain(['[delivery:neutral] Prepared.', '[delivery:neutral] Unheard answer.', held(),
                               '[delivery:neutral] First answer.'])
        self.addCleanup(brain.close)
        channel = self.slow_start_channel()
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False, channel=channel, synthesis_chunks=chunks,
        )
        service, manager = handle.service, handle.service.manager

        def shows(state):
            return wait_until(lambda: manager.status._state == state, f'The indicator never showed {state}')

        try:
            await asyncio.shield(service.channel.preparation)
            await shows('inactive-slow')
            self.assertTrue(spoken.empty(), 'A slow start is shown silently')
            self.assertEqual(manager.conversation.turns, [])
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            await shows('idle-slow')
            await self.speak_request(transport, 'repeat that')
            await self.hear_exactly(spoken, "I haven't said anything to repeat yet.")
            await self.reply_finished(transport, spoken)
            self.assertTrue(channel.slow_start, 'Repeat never uses up the notice')
            await shows('idle-slow')
            await self.speak_request(transport, 'First question')
            await wait_until(lambda: notice_entered.is_set() and len(brain.requests) == 2,
                             'The brain request waited for the notice synthesis')
            self.assertEqual(await service.toggle(), 'inactive')
            await shows('inactive-slow')
            notice_release.set()
            await wait_until(lambda: manager.transport is None, 'The cancelled conversation never finished cleanup')
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            await shows('idle-slow')
            self.assertTrue(channel.slow_start, 'A notice cancelled before any of its audio is still due')
            self.assertTrue(spoken.empty(), 'Neither the cancelled notice nor its answer was spoken')
            await self.speak_request(transport, 'Second question')
            await self.hear_exactly(spoken, SLOW_START_NOTICE)
            await wait_until(lambda: not channel.slow_start and len(brain.requests) == 3,
                             'The heard notice was not settled while its answer is held')
            await self.speak_request(transport, 'repeat that')
            await self.hear_exactly(spoken, "I haven't said anything to repeat yet.")
            answer_release.set()
            await self.reply_finished(transport, spoken)
            self.assertTrue(committed.empty(), 'The superseded held answer is never committed')
            await self.speak_request(transport, 'Third question')
            await self.hear_exactly(spoken, 'First answer.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'First answer.')
            await self.reply_finished(transport, spoken)
            for message in brain.requests[3][2]['messages']:
                self.assertNotIn(SLOW_START_NOTICE, json.dumps(message))
            self.assertEqual(manager.llm.last_spoken_reply, 'First answer.')
            await shows('idle')
        finally:
            notice_release.set()
            answer_release.set()
            await close()

    async def test_slow_start_notice_interrupted_after_its_first_audio_counts_as_told(self):
        notice_held, notice_release = threading.Event(), threading.Event()
        for event in (notice_held, notice_release):
            self.addCleanup(event.set)

        def chunks(**kwargs):
            yield np.zeros(4800, dtype=np.float32)
            if kwargs['text'] == SLOW_START_NOTICE and not notice_held.is_set():
                # The notice's text frame follows its synthesis, so holding here keeps it from output.
                notice_held.set()
                if not notice_release.wait(45):
                    raise AssertionError('Slow-start notice synthesis was not released')
                yield np.zeros(4800, dtype=np.float32)

        brain = ScriptedBrain(['[delivery:neutral] Prepared.', '[delivery:neutral] Unheard answer.',
                               '[delivery:neutral] Second answer.'])
        self.addCleanup(brain.close)
        channel = self.slow_start_channel()
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False, channel=channel, synthesis_chunks=chunks,
        )
        service, manager = handle.service, handle.service.manager
        try:
            await asyncio.shield(service.channel.preparation)
            await wait_until(lambda: manager.status._state == 'inactive-slow', 'A slow start never showed')
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            await self.speak_request(transport, 'First question')
            notice = None

            def notice_heard():
                nonlocal notice
                notice = manager.llm.current_reply()
                return notice_held.is_set() and len(brain.requests) == 2 and notice is not None and notice.delivered

            await wait_until(notice_heard, "The notice's first audio was never heard")
            self.assertTrue(spoken.empty(), "The notice's text frame has not reached output")
            await self.speak_request(transport, 'repeat that')
            await wait_until(lambda: notice.terminal_outcome == 'interrupted', 'The notice was never interrupted')
            notice_release.set()
            await self.hear_exactly(spoken, "I haven't said anything to repeat yet.")
            await self.reply_finished(transport, spoken)
            self.assertFalse(channel.slow_start, 'A notice interrupted after its first audio counts as told')
            await self.speak_request(transport, 'Second question')
            await self.hear_exactly(spoken, 'Second answer.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Second answer.')
            await self.reply_finished(transport, spoken)
            self.assertEqual(len(brain.requests), 3)
            for message in brain.requests[2][2]['messages']:
                self.assertNotIn(SLOW_START_NOTICE, json.dumps(message))
        finally:
            notice_release.set()
            await close()

    async def test_slow_start_shows_when_voice_started_during_preparation(self):
        preparation_release = threading.Event()
        self.addCleanup(preparation_release.set)

        def held():
            if not preparation_release.wait(45):
                raise AssertionError('Held preparation was not released')
            yield {'content': '[delivery:neutral] Prepared.'}, None
            yield {}, 'stop'

        brain = ScriptedBrain([held()])
        self.addCleanup(brain.close)
        channel = self.slow_start_channel()
        handle, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False, channel=channel,
        )
        service, manager = handle.service, handle.service.manager
        try:
            self.assertEqual(await service.toggle(), 'starting')
            await asyncio.wait_for(service.started.get(), 5)
            await wait_until(lambda: manager.status._state == 'idle', 'Voice never became idle during preparation')
            self.assertFalse(service.channel.preparation.done(), 'Preparation must still be running')
            preparation_release.set()
            await wait_until(lambda: manager.status._state == 'idle-slow',
                             'The slow start never showed after preparation ended')
            self.assertTrue(spoken.empty(), 'A slow start is shown silently')
        finally:
            preparation_release.set()
            await close()

    async def test_typed_request_tells_slow_start_while_voice_is_off(self):
        brain = ScriptedBrain(['[delivery:neutral] Prepared.', '[delivery:neutral] Typed answer.'])
        self.addCleanup(brain.close)
        channel = self.slow_start_channel()
        handle, spoken, committed, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False, channel=channel,
        )
        service, manager = handle.service, handle.service.manager
        try:
            await asyncio.shield(service.channel.preparation)
            await wait_until(lambda: manager.status._state == 'inactive-slow', 'A slow start never showed')
            self.assertEqual(await service.submit('Typed question'), 'accepted')
            await self.hear_exactly(spoken, SLOW_START_NOTICE)
            await self.hear_exactly(spoken, 'Typed answer.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed answer.')
            await wait_until(lambda: manager.status._state == 'inactive', 'The told notice never cleared')
            self.assertEqual(manager.llm.last_spoken_reply, 'Typed answer.')
            self.assertEqual(await service.submit('repeat that'), 'accepted')
            await self.hear_exactly(spoken, 'Typed answer.')
            self.assertEqual(len(brain.requests), 2)
            for message in brain.requests[1][2]['messages']:
                self.assertNotIn(SLOW_START_NOTICE, json.dumps(message))
        finally:
            await close()

    async def test_missing_engine_shows_trouble_while_voice_is_off_and_explains_when_addressed(self):
        refusal = f"import json; print(json.dumps({{'error': {SOURCE_IDENTITY_REFUSAL!r}}}), flush=True)"
        handle, spoken, _, _, _, close = await self.open_session(
            None, wire=refusal, through_service=True, native_audio=True, activate=False, startup='trouble-engine-missing',
        )
        service, manager = handle.service, handle.service.manager
        try:
            self.assertEqual(manager.status._state, 'trouble-engine-missing')
            self.assertTrue(spoken.empty(), 'An engine failure is shown silently')
            for request in ('Typed question', 'Another typed question'):
                self.assertEqual(await service.submit(request), 'accepted')
                await self.hear_exactly(spoken, ENGINE_MISSING_ADVICE)
        finally:
            await close()

    async def test_failed_managed_brain_does_not_contact_unrelated_provider(self):
        for marker, error in [('1', RuntimeError('command failed')), ('1', RuntimeError('command unavailable')),
                              ('invalid', None)]:
            with self.subTest(marker=marker, status_error=error):
                brain = ScriptedBrain([[({'content': '[delivery:neutral]\nUnrelated provider reply.'}, None), ({}, 'stop')]])
                self.addCleanup(brain.close)
                command = AsyncMock(side_effect=[
                    'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
                ])
                status = AsyncMock(side_effect=error)
                with (patch.dict(os.environ, {'KESTREL_MANAGED_BRAIN': marker}),
                      patch.object(bot, 'run_local_command', status)):
                    transport, spoken, committed, _, processes, close = await self.open_session(
                        brain, local_command=command, prepare_engine=True, startup='trouble-engine',
                    )
                    try:
                        await asyncio.wait_for(asyncio.shield(transport.llm.channel.preparation or transport.llm.channel.reader), 5)
                        self.assertEqual((len(brain.requests), len(processes)), (0, 0),
                                         'Failed managed startup must not contact another provider or start Hermes')
                        self.assertIsNone(transport.llm.channel.home)
                        if marker == '1':
                            self.assertIn(f'kestrel-brain.service is unavailable: {error}. Restart Kestrel and try again.',
                                          transport.llm.channel.failure)
                        else:
                            self.assertEqual(transport.llm.channel.failure,
                                             'Hermes engine unavailable: Invalid KESTREL_MANAGED_BRAIN setting. '
                                             'Restart Kestrel and try again.')
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'mute')
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual(command.await_count, 7)
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        await self.assert_failed_reply(
                            transport, spoken, committed, 'Answer after failed managed startup.',
                            expected_advisory="I couldn't reach Kestrel's engine. Restart Kestrel and try again.",
                        )
                        self.assertEqual(brain.requests, [])
                        self.assertEqual(processes, [])
                        if marker == '1':
                            status.assert_awaited_once_with([
                                '/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'kestrel-brain.service',
                            ])
                        else:
                            status.assert_not_awaited()
                    finally:
                        await close()

    async def test_dismissed_memory_turn_finishes_before_fresh_snapshot(self):
        notes_home = tempfile.TemporaryDirectory(prefix='kestrel-memory-lifecycle-', dir=ROOT / '.runtime')
        self.addCleanup(notes_home.cleanup)
        notes = Path(notes_home.name) / 'notes'
        held, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        expected_note = 'Notebook preference nonce-519.'
        events = []

        def memory_reply():
            held.set()
            if not release.wait(45):
                raise AssertionError('Accepted memory turn was never released')
            yield {'tool_calls': [{'index': 0, 'id': 'remember', 'type': 'function', 'function': {
                'name': 'memory', 'arguments': json.dumps({
                    'action': 'add', 'target': 'memory', 'content': expected_note,
                }),
            }}]}, None
            yield {}, 'tool_calls'

        def say(text):
            return [({'content': '[delivery:neutral] ' + text}, None), ({}, 'stop')]

        brain = ScriptedBrain([say('Prepared.'), memory_reply(), say('Old unheard save.'),
                               say('Fresh note snapshot.'), say('Snapshot after revoked begin.'),
                               say('Snapshot after held acknowledgement.')])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, processes, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True,
            memory_root=notes, native_events=events,
        )
        service = handle.service
        manager = service.manager
        channel = manager.channel
        unlock = asyncio.Event()
        self.addCleanup(unlock.set)
        try:
            await asyncio.wait_for(asyncio.shield(channel.preparation), 5)
            self.assertFalse(notes.exists(), 'Inactive preparation has no memory authority')
            self.assertEqual([event for kind, event in events if kind == 'write'], [{'prepare': True}])
            self.assertEqual(await service.toggle(), 'starting')
            old = await asyncio.wait_for(service.started.get(), 5)
            await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
            await old.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(old, 'Remember old caller nonce-303.')
            self.assertTrue(await asyncio.to_thread(held.wait, 5))
            self.assertEqual(await service.toggle(), 'inactive')
            self.assertEqual(await service.toggle(), 'starting')
            self.assertFalse(old.admission.is_open())
            self.assertEqual(manager.conversation.turns, [])
            self.assertEqual(len(handle.sessions), 1)
            self.assertFalse((notes / 'MEMORY.md').exists())
            self.assertEqual(sum(event == {'begin': True} for kind, event in events if kind == 'write'), 1)
            self.assertEqual([frame async for frame in old.stt.run_stt(b'inactive private audio')], [])
            await old.llm.process_frame(LLMContextFrame(bot.LLMContext([
                {'role': 'user', 'content': 'Inactive memory authority nonce-404.'},
            ])), FrameDirection.DOWNSTREAM)
            self.assertEqual(len(brain.requests), 2)
            release.set()
            fresh = await asyncio.wait_for(service.started.get(), 5)
            await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
            note = notes / 'MEMORY.md'
            self.assertEqual(note.read_text(), expected_note)
            self.assertEqual(note.stat().st_mode & 0o777, 0o600)
            result = [message for message in brain.requests[2][2]['messages'] if message['role'] == 'tool']
            self.assertEqual(len(result), 1)
            self.assertTrue(json.loads(result[0]['content'])['success'])
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(manager.conversation.turns, [])
            self.assertIsNone(fresh.llm.last_spoken_reply)
            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(fresh, 'Fresh question nonce-606.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh note snapshot.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh note snapshot.')
            payload = brain.requests[-1][2]['messages']
            self.assertIn(expected_note, payload[0]['content'])
            self.assertNotIn('old caller nonce-303', json.dumps(payload))
            self.assertEqual([message for message in payload if message['role'] != 'system'],
                             [{'role': 'user', 'content': 'Fresh question nonce-606.'}])

            for before_write in (True, False):
                with self.subTest(begin_before_write=before_write):
                    dismissed = manager.transport
                    self.assertEqual(await service.toggle(), 'inactive')
                    cleanup = await asyncio.wait_for(asyncio.shield(dismissed.cleanup_finished), 5)
                    await asyncio.wait_for(asyncio.shield(cleanup), 5)
                    self.assertEqual(service.manager.status._state, 'inactive')
                    ready_received = asyncio.Event()
                    unlock.clear()
                    native_read = channel.read_event

                    async def held_ack():
                        event = await native_read()
                        if event == {'session_ready': True}:
                            ready_received.set()
                            await unlock.wait()
                        return event

                    binding = patch.object(channel, 'read_event', side_effect=held_ack)
                    if before_write:
                        await channel.lock.acquire()
                    else:
                        binding.start()
                    writes_before = sum(kind == 'write' and event == {'begin': True} for kind, event in events)
                    try:
                        self.assertEqual(await service.toggle(), 'starting')
                        revoked = await asyncio.wait_for(service.started.get(), 5)
                        old_ready = manager.session_ready
                        if not before_write:
                            await asyncio.wait_for(ready_received.wait(), 5)
                            note.write_text(expected_note + '\n§\nLatest snapshot nonce-928.')
                        waiting = asyncio.Event()
                        native_shield = asyncio.shield
                        driver = asyncio.current_task()

                        def shield(task):
                            if task is old_ready and asyncio.current_task() is not driver:
                                waiting.set()
                            return native_shield(task)

                        with patch.object(asyncio, 'shield', side_effect=shield):
                            await revoked.input().queue_frame(ProposedUserStartedSpeakingFrame())
                            await self.finish_user_turn(revoked, 'Revoked ordinary question nonce-707.')
                            await asyncio.wait_for(waiting.wait(), 5)
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(await service.toggle(), 'starting')
                        self.assertFalse(old_ready.done())
                        self.assertFalse(old_ready.cancelled())
                        self.assertIs(manager.session_ready, old_ready)
                        self.assertFalse(revoked.admission.is_open())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertEqual(sum(kind == 'write' and event == {'begin': True} for kind, event in events),
                                         writes_before + (not before_write))
                    finally:
                        unlock.set()
                        if before_write:
                            channel.lock.release()
                        else:
                            binding.stop()
                    current = await asyncio.wait_for(service.started.get(), 5)
                    self.assertIsNot(manager.session_ready, old_ready)
                    self.assertEqual(await asyncio.wait_for(asyncio.shield(old_ready), 5), not before_write)
                    self.assertTrue(await asyncio.wait_for(asyncio.shield(manager.session_ready), 5))
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
                    await current.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(current, 'Current fresh question.')
                    expected = ('Snapshot after revoked begin.' if before_write else
                                'Snapshot after held acknowledgement.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), expected)
                    payload = brain.requests[-1][2]['messages']
                    self.assertIn(expected_note, payload[0]['content'])
                    if not before_write:
                        self.assertIn('Latest snapshot nonce-928.', payload[0]['content'])
                    self.assertNotIn('nonce-707', json.dumps(payload))
                    self.assertEqual([message for message in payload if message['role'] != 'system'],
                                     [{'role': 'user', 'content': 'Current fresh question.'}])
            self.assertEqual(note.read_text(), expected_note + '\n§\nLatest snapshot nonce-928.')
            self.assertEqual(len(processes), 1)
        finally:
            release.set()
            unlock.set()
            await close()
        self.assertEqual(note.read_text(), expected_note + '\n§\nLatest snapshot nonce-928.')

    async def test_native_preparation_is_silent_private_and_does_not_block_mute(self):
        managed = patch.dict(os.environ, {'KESTREL_MANAGED_BRAIN': '1'})
        managed.start()
        self.addCleanup(managed.stop)
        status_patch = patch.object(bot, 'run_local_command', AsyncMock(return_value=''))
        status = status_patch.start()
        self.addCleanup(status_patch.stop)
        notes_home = tempfile.TemporaryDirectory(prefix='kestrel-notes-test-', dir=ROOT / '.runtime')
        self.addCleanup(notes_home.cleanup)
        notes = Path(notes_home.name) / 'notes'
        notes.mkdir(mode=0o700)
        note = notes / 'MEMORY.md'
        note.write_text('Current notebook nonce-847.')
        note.chmod(0o600)
        native_events = []
        held = threading.Event()
        release = threading.Event()

        def preparation_reply():
            yield {'content': '[delivery:neutral]\nPreparation nonce 731.'}, None
            held.set()
            if not release.wait(45):
                raise AssertionError('Preparation reply was not released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            preparation_reply(), [({'content': '[delivery:neutral]\nActual caller reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, local_command=command, prepare_engine=True, through_service=True,
            memory_root=notes, native_events=native_events,
        )
        preparation = transport.llm.channel.preparation
        try:
            await asyncio.wait_for(transport.service.native_written.wait(), 5)
            self.assertEqual([event for kind, event in native_events if kind == 'write'], [{'prepare': True}])
            self.assertTrue(await asyncio.to_thread(held.wait, 5))
            status.assert_awaited_once_with([
                '/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'kestrel-brain.service',
            ])
            self.assertFalse(preparation.done())
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Hello.'},
            ])
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'mute')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(command.await_count, 7)
            self.assertFalse(preparation.done())
            self.assertFalse(release.is_set())
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())

            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'what can I say?')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), bot.capability_help())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual(note.read_text(), 'Current notebook nonce-847.')

            checkpoint = asyncio.Event()
            driver = asyncio.current_task()
            native_shield = asyncio.shield
            worker_input = processes[0][0].stdin
            native_write = worker_input.write
            ordinary_writes = 0
            pending_writes = 0

            def observe_shield(task):
                future = native_shield(task)
                if task is transport.llm.session_ready and asyncio.current_task() is not driver:
                    checkpoint.set()
                return future

            def observe_write(data):
                nonlocal ordinary_writes, pending_writes
                ordinary_writes += 1
                pending_writes += not preparation.done()
                checkpoint.set()
                return native_write(data)

            with (
                patch.object(asyncio, 'shield', observe_shield),
                patch.object(worker_input, 'write', observe_write),
            ):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Answer the genuine user turn.')
                await asyncio.wait_for(checkpoint.wait(), 5)
                self.assertEqual(ordinary_writes, 0, 'Ordinary worker request preceded preparation completion')
                self.assertFalse(preparation.done())
                self.assertFalse(release.is_set())
                self.assertEqual(len(brain.requests), 1)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())

                release.set()
                await asyncio.wait_for(asyncio.shield(preparation), 5)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Actual caller reply.')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Actual caller reply.')
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                self.assertEqual(len(brain.requests), 2)
                self.assertEqual([m for m in brain.requests[1][2]['messages'] if m['role'] != 'system'], [
                    {'role': 'user', 'content': 'Answer the genuine user turn.'},
                ])
                self.assertEqual(ordinary_writes, 2)
                self.assertEqual([event for kind, event in native_events if kind == 'write'], [
                    {'prepare': True}, {'begin': True},
                    {'messages': [{'role': 'user', 'content': 'Answer the genuine user turn.'}]},
                ])
                terminal = native_events.index(('read', {'done': True}))
                begin = native_events.index(('write', {'begin': True}))
                ready = native_events.index(('read', {'session_ready': True}))
                ordinary = next(index for index, (kind, event) in enumerate(native_events)
                                if kind == 'write' and 'messages' in event)
                self.assertLess(terminal, begin)
                self.assertLess(begin, ready)
                self.assertLess(ready, ordinary)
                system = '\n'.join(message['content'] for message in brain.requests[-1][2]['messages']
                                   if message['role'] == 'system')
                self.assertIn('Current notebook nonce-847.', system)
                self.assertNotIn('Preparation nonce 731.', system)
                self.assertEqual(note.read_text(), 'Current notebook nonce-847.')
                self.assertEqual(pending_writes, 0)
        finally:
            release.set()
            await close()
        self.assertTrue(preparation.done())
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())

    async def test_failed_native_preparation_preserves_local_mute_and_reports_on_user_turn(self):
        notes_advisory = ('Local notes are unavailable or unsafe. Check note ownership, permissions, '
                          'encoding and size, then restart Kestrel.')
        for failure in ('prepare', 'begin', 'preflight'):
            with self.subTest(failure=failure):
                notes_home = tempfile.TemporaryDirectory(prefix='kestrel-failed-notes-', dir=ROOT / '.runtime')
                self.addCleanup(notes_home.cleanup)
                notes = Path(notes_home.name) / 'notes'
                if failure == 'begin':
                    notes.mkdir(mode=0o700)
                    (notes / 'MEMORY.md').write_bytes(b'\xffinvalid note nonce-811')
                    (notes / 'MEMORY.md').chmod(0o600)
                brain = ScriptedBrain([400] if failure == 'prepare' else [
                    [({'content': '[delivery:neutral] Prepared.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                command = AsyncMock(side_effect=[
                    'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
                ] * 2)
                events = []
                transport, spoken, committed, _, processes, close = await self.open_session(
                    brain, local_command=command, prepare_engine=True, through_service=True,
                    memory_root=notes, native_events=events,
                    startup='trouble-engine' if failure == 'prepare' else 'inactive',
                )
                service = transport.service
                manager = service.manager
                channel = manager.channel
                preparation = channel.preparation
                try:
                    await asyncio.wait_for(asyncio.shield(preparation), 5)
                    await asyncio.wait_for(asyncio.gather(manager.session_ready, return_exceptions=True), 5)
                    if failure == 'preflight':
                        self.assertFalse(channel.failure)
                        note = notes / 'MEMORY.md'
                        note.write_bytes(b'\xffinvalid note nonce-811')
                        note.chmod(0o600)
                        await self.assert_failed_reply(
                            transport, spoken, committed, 'Ordinary turn with unsafe notes.',
                            expected_advisory=notes_advisory,
                        )
                    self.assertTrue(channel.failure)
                    await service.state('trouble-engine' if failure == 'prepare' else 'trouble-notes')
                    self.assertIsNotNone(channel.process.returncode)
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
                    self.assertEqual(len(brain.requests), 1)
                    writes = [event for kind, event in events if kind == 'write']
                    for activation in range(2):
                        if activation:
                            self.assertEqual(await service.toggle(), 'inactive')
                            self.assertEqual(await service.toggle(), 'starting')
                            transport = await asyncio.wait_for(service.started.get(), 5)
                            await asyncio.wait_for(asyncio.gather(manager.session_ready, return_exceptions=True), 5)
                            self.assertIsNone(manager.failure, 'Known reaped engine failure leaves local activation available')
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'mute')
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual(command.await_count, 7 * (activation + 1))
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'what can I say?')
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), bot.capability_help())
                        self.assertTrue(committed.empty())
                        await self.assert_failed_reply(
                            transport, spoken, committed, 'Answer after failed native initialization.',
                            expected_advisory=("I couldn't get a complete reply from the brain. Restart Kestrel and try again."
                                               if failure == 'prepare' else notes_advisory),
                        )
                        self.assertEqual(len(brain.requests), 1)
                        self.assertEqual([event for kind, event in events if kind == 'write'], writes,
                                         'Sticky engine failure must not retry preparation, begin or ordinary messages')
                        await service.state('trouble-engine' if failure == 'prepare' else 'trouble-notes')
                    if failure != 'prepare':
                        self.assertEqual((notes / 'MEMORY.md').read_bytes(), b'\xffinvalid note nonce-811')
                finally:
                    await close()
                self.assertTrue(preparation.done())
                self.assertIsNotNone(processes[0][0].returncode)
                self.assertFalse(processes[0][1].exists())

        for cleanup_failure in (False, True):
            with self.subTest(failure='begin', stop='immediate', cleanup_failure=cleanup_failure):
                notes_home = tempfile.TemporaryDirectory(prefix='kestrel-failed-notes-', dir=ROOT / '.runtime')
                self.addCleanup(notes_home.cleanup)
                notes = Path(notes_home.name) / 'notes'
                notes.mkdir(mode=0o700)
                note = notes / 'MEMORY.md'
                corrupt_notes = b'\xffinvalid note nonce-811'
                note.write_bytes(corrupt_notes)
                note.chmod(0o600)
                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral] Prepared.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                transport, spoken, committed, _, processes, close = await self.open_session(
                    brain, prepare_engine=True, through_service=True, memory_root=notes,
                )
                service = transport.service
                manager = service.manager
                channel = manager.channel
                readiness = await asyncio.wait_for(asyncio.gather(manager.session_ready, return_exceptions=True), 5)
                self.assertIsInstance(readiness[0], RuntimeError)
                self.assertTrue(channel.reader.done())
                self.assertTrue(channel.failure)
                process, home = processes[0]
                self.assertIsNotNone(process.returncode)
                self.assertTrue(home.exists())
                self.assertIsNotNone(channel.home)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                if cleanup_failure:
                    native_reap = channel._reap
                    cleanup_error = RuntimeError('Injected close-time reap failure after confirmed exit')

                    async def reap():
                        await native_reap()
                        self.assertIsNotNone(process.returncode)
                        raise cleanup_error

                    with patch.object(channel, '_reap', side_effect=reap):
                        with self.assertRaises(RuntimeError) as raised:
                            await close()
                    self.assertIs(raised.exception, cleanup_error)
                else:
                    await close()
                self.assertIsNotNone(process.returncode)
                self.assertFalse(home.exists())
                service.recognizer.close.assert_awaited_once()
                self.assertTrue(service.recognizer.closed)
                transport.close.assert_awaited_once()
                self.assertEqual(manager.status._state, 'unavailable' if cleanup_failure else 'released')
                self.assertEqual(note.read_bytes(), corrupt_notes)

    async def test_preparation_timeout_and_shutdown_reap_owned_worker(self):
        wire = (
            'import sys; print(\'{"ready":true}\', flush=True); '
            'sys.stdin.readline(); sys.stdin.read()'
        )
        for outcome in ('timeout', 'shutdown'):
            with self.subTest(outcome=outcome):
                pending = asyncio.Event()
                reads = 0
                native_read = bot.HermesRequestChannel.read_event

                async def read_event(service):
                    nonlocal reads
                    reads += 1
                    if reads == 2:
                        pending.set()
                    return await native_read(service)

                with (
                    patch.object(bot, 'ENGINE_TIMEOUT', 1),
                    patch.object(bot.HermesRequestChannel, 'read_event', read_event),
                ):
                    transport, spoken, committed, _, processes, close = await self.open_session(
                        None, wire=wire, prepare_engine=True,
                    )
                    preparation = transport.llm.channel.preparation
                    try:
                        await asyncio.wait_for(pending.wait(), 5)
                        self.assertFalse(preparation.done())
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        if outcome == 'timeout':
                            await asyncio.wait_for(asyncio.shield(preparation), 5)
                            self.assertTrue(transport.llm.channel.failure)
                            self.assertIsNotNone(processes[0][0].returncode)
                    finally:
                        await close()
                    self.assertTrue(preparation.done())
                    self.assertIsNotNone(processes[0][0].returncode)
                    self.assertFalse(processes[0][1].exists())
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())


if __name__ == '__main__':
    unittest.main()
