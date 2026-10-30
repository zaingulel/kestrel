import asyncio
import json
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from loguru import logger
from pipecat.frames.frames import DataFrame, InputAudioRawFrame, ProposedUserStartedSpeakingFrame

import bot
from conversation_fixtures import (
    ANSWER_QUIET, ANSWER_SPEECH, WholeConversationCase, answer_frames, answer_vad, deletion_question, wait_until,
)
import speech
from test_hermes import ROOT, ScriptedBrain, note_bytes, read_notes, scripted_call, scripted_say, tool_contents
from tool_catalogue import brain_result


APPROVAL = {'approved': True, 'source': 'kestrel'}


class WholeConversationTests(WholeConversationCase):
    def private_notes(self, *, memory=(), user=()):
        """An isolated private note store holding exactly these entries, never the owner's notes."""
        home = tempfile.TemporaryDirectory(prefix='kestrel-notes-test-', dir=ROOT / '.runtime')
        self.addCleanup(home.cleanup)
        notes = Path(home.name) / 'notes'
        notes.mkdir(mode=0o700)
        for name, entries in (('MEMORY.md', memory), ('USER.md', user)):
            for path, content in ((notes / name, note_bytes(*entries)), (notes / (name + '.lock'), b'')):
                path.write_bytes(content)
                path.chmod(0o600)
        return notes

    def watch_answer_windows(self):
        """Queues (transport, value) for every capture_pcm change after construction on each laptop transport opened later."""
        changes = asyncio.Queue()

        class ObservedTransport(speech.LaptopAudioTransport):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.observed = True

            @property
            def capture_pcm(self):
                return self.__dict__.get('_capture_pcm')

            @capture_pcm.setter
            def capture_pcm(self, value):
                if self.__dict__.get('observed'):
                    changes.put_nowait((self, value))
                self.__dict__['_capture_pcm'] = value

        binding = patch.object(speech, 'LaptopAudioTransport', ObservedTransport)
        binding.start()
        self.addCleanup(binding.stop)
        return changes

    async def window_change(self, windows, transport):
        changed, value = await asyncio.wait_for(windows.get(), 5)
        self.assertIs(changed, transport, 'Only the conversation capture may open an answer window')
        return value

    def fake_answer_recognizer(self, service, text, *, entered=None, release=None):
        """Replaces recognition with a fixed transcript, recording the audio and whether the turn was admitted."""
        heard = []

        async def transcribe(audio, *, admitted):
            heard.append((audio, admitted()))
            if entered is not None:
                entered.set()
                await release.wait()
            return text

        binding = patch.object(service.recognizer, 'transcribe', new=AsyncMock(side_effect=transcribe))
        binding.start()
        self.addCleanup(binding.stop)
        return heard

    def assert_refused_once(self, events, mark):
        writes = [event for kind, event in events[mark:] if kind == 'write']
        self.assertNotIn(APPROVAL, writes)
        results = [json.loads(event['tool_result']) for event in writes if 'tool_result' in event]
        self.assertEqual([(result['confirmed'], result['attempted']) for result in results], [(False, False)])

    def assert_approved_once(self, events, mark):
        self.assertEqual([event for kind, event in events[mark:] if kind == 'write' and set(event) != {'messages'}],
                         [APPROVAL])
        self.assertEqual([event for kind, event in events[mark:] if kind == 'read' and 'tool_observed' in event],
                         [{'tool_observed': brain_result(True, True, 'confirmed')}])

    async def test_note_that_ends_a_sentence_gets_no_second_full_stop(self):
        # Each pair is the exact wording Kestrel must speak: the question, then the removal confirmation.
        cases = (
            ('The library books are due back on Friday.',
             "I'm about to delete the note: The library books are due back on Friday. Shall I?",
             'I removed the note: The library books are due back on Friday.'),
            ('Watch the step!',
             "I'm about to delete the note: Watch the step! Shall I?",
             'I removed the note: Watch the step!'),
            ('Is the gate locked?',
             "I'm about to delete the note: Is the gate locked? Shall I?",
             'I removed the note: Is the gate locked?'),
            ('Call the dentist',
             "I'm about to delete the note: Call the dentist. Shall I?",
             'I removed the note: Call the dentist.'),
        )
        notes = self.private_notes(memory=[case[0] for case in cases])
        windows = self.watch_answer_windows()
        brain = ScriptedBrain([
            '[delivery:neutral] Prepared.',
            *(reply for index, (note, _, _) in enumerate(cases)
              for reply in (scripted_call(f'note-{index}', 'delete_note', {'note': note}), scripted_say('Unspoken remark.'))),
        ])
        self.addCleanup(brain.close)
        transport, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
        )
        service = transport.service
        try:
            await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)
            for note, question, removal in cases:
                with self.subTest(note=note):
                    self.fake_answer_recognizer(service, 'Yes.')
                    await self.speak_request(transport, 'Please delete that note.')
                    await self.hear_exactly(spoken, question)
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                    self.assertIsNone(await self.window_change(windows, transport))
                    await self.hear_exactly(spoken, removal)
                    await self.reply_finished(transport, spoken)
        finally:
            await close()

    def test_removal_confirmation_adds_no_second_full_stop_after_a_sentence_ending(self):
        for note, confirmation in (
                ('The spare bike key is in the blue drawer.', 'I removed the note: The spare bike key is in the blue drawer.'),
                ('Watch the step!', 'I removed the note: Watch the step!'),
                ('Is the gate locked?', 'I removed the note: Is the gate locked?'),
                ('Call the dentist', 'I removed the note: Call the dentist.')):
            with self.subTest(note=note):
                self.assertEqual(bot.local_tool('delete_note', note).confirmation, confirmation)

    async def test_note_deletion_runs_only_after_a_clear_spoken_yes(self):
        target = 'Caller keeps the red notebook in the study'
        kept = 'Caller prefers cedar tea'
        long_note = 'Long note ' + 'x' * 290
        self.assertEqual(len(long_note), 300)
        notes = self.private_notes(memory=[kept, target], user=[long_note])
        seeded = read_notes(notes)
        windows = self.watch_answer_windows()
        events = []
        brain = ScriptedBrain([
            '[delivery:neutral] Prepared.',
            scripted_call('first', 'delete_note', {'note': target}), scripted_say('Unspoken remark.'),
            scripted_call('long', 'delete_note', {'note': long_note}), scripted_say('Unspoken remark.'),
        ])
        self.addCleanup(brain.close)
        transport, spoken, _, interrupted, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
            native_events=events,
        )
        service = transport.service
        recognised = self.fake_answer_recognizer(service, 'Yes.')
        output = transport.output()
        try:
            await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)
            mark = len(events)
            await self.speak_request(transport, 'Please delete my red notebook note.')
            await self.hear_exactly(spoken, deletion_question(target))
            self.assertIsNotNone(await self.window_change(windows, transport), 'The answer window opens after the question')
            self.assertEqual(read_notes(notes), seeded, 'Nothing is deleted before the answer')
            self.assertNotIn(APPROVAL, [event for kind, event in events if kind == 'write'])
            transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
            self.assertIsNone(await self.window_change(windows, transport), 'The endpointed answer hands capture back')
            await self.hear_exactly(spoken, f'I removed the note: {target}.')
            await self.reply_finished(transport, spoken)
            self.assertEqual([(answer_frames(audio), admitted) for audio, admitted in recognised],
                             [(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40, True)])
            self.assert_approved_once(events, mark)
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': seeded['USER.md']})
            self.assertEqual(len(brain.requests), 3)
            self.assertEqual(tool_contents(brain.requests[-1]), [brain_result(True, True, 'confirmed')])

            # A long readback still waits for the question to play, well past the announcement bound.
            mark = len(events)
            asked = ('read', {'tool_call': {'name': 'delete_note', 'arguments': {'note': long_note}}})
            with patch.object(bot, 'ANNOUNCEMENT_TIMEOUT', 0.05):
                transport.capture.stdout.feed_data(bytes(640))
                output.generation_done.clear()
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                barrier = DataFrame()
                await output.queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                output.write_gate.clear()
                await self.finish_user_turn(transport, 'Please forget my long note.')
                await wait_until(lambda: asked in events[mark:], 'The engine never asked about the long note')
                await asyncio.sleep(0.3)
                self.assertTrue(windows.empty(), 'No answer window opens while the question is still unplayed')
                self.assertTrue(spoken.empty())
                output.write_gate.set()
                await self.hear_exactly(spoken, deletion_question(long_note))
                self.assertIsNotNone(await self.window_change(windows, transport))
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                self.assertIsNone(await self.window_change(windows, transport))
                await self.hear_exactly(spoken, f'I removed the note: {long_note}.')
                await self.reply_finished(transport, spoken)
            self.assert_approved_once(events, mark)
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': note_bytes()})
            self.assertEqual(len(brain.requests), 5)
            self.assertEqual(len(recognised), 2)
        finally:
            output.write_gate.set()
            await close()

        with self.subTest('a delivery label before the call'):
            # Real replies open with a delivery label, so the question can follow a reply start that carries no text.
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            labelled = [({'content': '[delivery:neutral] '}, None)]
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                [*labelled, *scripted_call('labelled-yes', 'delete_note', {'note': target})], scripted_say('Unspoken remark.'),
                [*labelled, *scripted_call('labelled-no', 'delete_note', {'note': kept})], scripted_say('Unspoken remark.'),
            ])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            try:
                await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)
                for note, answer, line, settled in (
                        (target, 'Yes.', f'I removed the note: {target}.', self.assert_approved_once),
                        (kept, 'No.', "Okay, I won't.", self.assert_refused_once)):
                    recognised = self.fake_answer_recognizer(service, answer)
                    mark = len(events)
                    await self.speak_request(transport, 'Please delete that note.')
                    await self.hear_exactly(spoken, deletion_question(note))
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                    self.assertIsNone(await self.window_change(windows, transport))
                    await self.hear_exactly(spoken, line)
                    await self.reply_finished(transport, spoken)
                    self.assertEqual(len(recognised), 1)
                    settled(events, mark)
                self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': seeded['USER.md']})
                self.assertEqual(len(brain.requests), 5)
            finally:
                await close()

        with self.subTest('a yes whose deletion is not confirmed closes the turn'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('changed', 'delete_note', {'note': target}), scripted_call('after', 'mute', {}),
                scripted_say('Unspoken remark.'),
            ])
            self.addCleanup(brain.close)
            command = AsyncMock(return_value='')
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events, local_command=command,
            )
            service = transport.service
            self.fake_answer_recognizer(service, 'Yes.')
            try:
                await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)
                mark = len(events)
                await self.speak_request(transport, 'Please delete my red notebook note.')
                await self.hear_exactly(spoken, deletion_question(target))
                self.assertIsNotNone(await self.window_change(windows, transport))
                # The note changes on disk after the question, so the approved removal is not confirmed.
                changed = note_bytes(kept, 'Caller keeps the blue notebook in the study')
                (notes / 'MEMORY.md').write_bytes(changed)
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                self.assertIsNone(await self.window_change(windows, transport))
                await self.hear_exactly(spoken, "I couldn't confirm the note was removed. I won't retry.")
                await wait_until(lambda: len(brain.requests) == 4, 'The turn never finished')
                self.assertEqual(tool_contents(brain.requests[-1]), [brain_result(False, True, 'note removal failed'),
                                                                     brain_result(False, False, 'turn closed')])
                command.assert_not_awaited()
                self.assertIn(APPROVAL, [event for kind, event in events[mark:] if kind == 'write'])
                self.assertEqual(read_notes(notes), {'MEMORY.md': changed, 'USER.md': seeded['USER.md']})
                await self.reply_finished(transport, spoken)
            finally:
                await close()

    async def test_question_after_the_waiting_acknowledgement_is_confirmed_as_played(self):
        bike = 'Caller keeps the bike key under the blue pot'
        garden = 'Caller plans tomatoes along the south fence'
        notes = self.private_notes(memory=[bike, garden])
        windows = self.watch_answer_windows()
        events, logs = [], []
        sink = logger.add(lambda message: logs.append(str(message).strip()), format='{message}')
        self.addCleanup(logger.remove, sink)
        calls = {'bike': threading.Event(), 'garden': threading.Event()}

        def replies():
            yield '[delivery:neutral] Prepared.'
            for (call_id, call_due), note in zip(calls.items(), (bike, garden)):
                # Holding the call keeps the turn waiting long enough for its acknowledgement to fall due.
                if not call_due.wait(45):
                    raise AssertionError('The held delete_note call was not released')
                yield scripted_call(call_id, 'delete_note', {'note': note})
                yield scripted_say('Unspoken remark.')

        brain = ScriptedBrain(replies())
        self.addCleanup(brain.close)
        for call_due in calls.values():
            self.addCleanup(call_due.set)
        transport, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
            native_events=events,
        )
        service = transport.service
        timers, acknowledgement_time = service.acknowledgement_timers, service.acknowledgement_time
        output = transport.output()
        self.fake_answer_recognizer(service, 'Yes.')
        native_write = output._write_audio_locked
        playing, release_acknowledgement = asyncio.Event(), asyncio.Event()

        async def hold_after_first_acknowledgement_chunk(frame, record):
            written = await native_write(frame, record)
            if getattr(frame, 'prepared_credit', None) is not None and not playing.is_set():
                playing.set()
                await release_acknowledgement.wait()
            return written

        def verdicts():
            return [line for line in logs if line.startswith('The permission question')]

        async def answer_yes_and_hear_removal(note, mark):
            await wait_until(verdicts, 'The question was never judged')
            self.assertRegex(verdicts()[-1], r'^The permission question played in \d+\.\d s$')
            self.assertIsNotNone(await self.window_change(windows, transport), 'The answer window opens after the question')
            transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
            self.assertIsNone(await self.window_change(windows, transport))
            await self.hear_exactly(spoken, f'I removed the note: {note}.')
            await self.reply_finished(transport, spoken)
            self.assert_approved_once(events, mark)

        try:
            await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)

            # The acknowledgement plays whole before the question.
            mark = len(events)
            await self.speak_request(transport, 'Please delete my bike key note.')
            callback, args, deadline = await asyncio.wait_for(timers.get(), 5)
            acknowledgement_time[0] = max(acknowledgement_time[0], deadline)
            callback(*args)
            await self.hear_exactly(spoken, 'One moment.')
            calls['bike'].set()
            await self.hear_exactly(spoken, deletion_question(bike))
            await answer_yes_and_hear_removal(bike, mark)
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(garden), 'USER.md': note_bytes()})

            # The question arrives while the acknowledgement is mid-play and cuts it off.
            logs.clear()
            mark = len(events)
            with patch.object(output, '_write_audio_locked', new=hold_after_first_acknowledgement_chunk):
                await self.speak_request(transport, 'Please delete my garden plan note.')
                callback, args, deadline = await asyncio.wait_for(timers.get(), 5)
                acknowledgement_time[0] = max(acknowledgement_time[0], deadline)
                callback(*args)
                await asyncio.wait_for(playing.wait(), 5)
                calls['garden'].set()
                await wait_until(lambda: output.acknowledgement_record is None,
                                 'The question never cut off the acknowledgement')
                release_acknowledgement.set()
                await self.hear_exactly(spoken, deletion_question(garden))
                await answer_yes_and_hear_removal(garden, mark)
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(), 'USER.md': note_bytes()})
        finally:
            release_acknowledgement.set()
            await close()

    async def test_reply_speech_behind_a_cut_acknowledgement_still_plays(self):
        bike, garden = 'Caller keeps the bike key under the blue pot', 'Caller plans tomatoes along the south fence'
        notes = self.private_notes(memory=[bike, garden])
        windows = self.watch_answer_windows()
        events, logs = [], []
        sink = logger.add(lambda message: logs.append(str(message).strip()), format='{message}')
        self.addCleanup(logger.remove, sink)
        speech_due, call_due = threading.Event(), threading.Event()
        self.addCleanup(speech_due.set)
        self.addCleanup(call_due.set)

        def look_then_call():
            # Holding the speech until the acknowledgement is due makes the speech play it first; holding the call
            # keeps the question behind that speech. 'Checking.' is the lookahead that releases 'Let me look.'
            # to synthesis before the call; it is itself held until the reply ends.
            for due, delta in ((speech_due, [({'content': '[delivery:neutral] Let me look. Checking.'}, None)]),
                               (call_due, scripted_call('bike', 'delete_note', {'note': bike}))):
                if not due.wait(45):
                    raise AssertionError('The held reply was not released')
                yield from delta

        brain = ScriptedBrain(['[delivery:neutral] Prepared.', look_then_call(), scripted_say('Unspoken remark.')])
        self.addCleanup(brain.close)
        transport, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
            native_events=events,
        )
        service = transport.service
        output = transport.output()
        self.fake_answer_recognizer(service, 'Yes.')
        native_write = output._write_audio_locked
        playing, release_acknowledgement = asyncio.Event(), asyncio.Event()

        async def hold_after_first_acknowledgement_chunk(frame, record):
            written = await native_write(frame, record)
            if getattr(frame, 'prepared_credit', None) is not None and not playing.is_set():
                playing.set()
                await release_acknowledgement.wait()
            return written

        def verdicts():
            return [line for line in logs if line.startswith('The permission question')]

        try:
            await asyncio.wait_for(asyncio.shield(service.manager.session_ready), 5)
            mark = len(events)
            with patch.object(output, '_write_audio_locked', new=hold_after_first_acknowledgement_chunk):
                await self.speak_request(transport, 'Please delete my bike key note.')
                # The acknowledgement falls due without its own frame, so the reply speech plays it first.
                _, _, deadline = await asyncio.wait_for(service.acknowledgement_timers.get(), 5)
                service.acknowledgement_time[0] = max(service.acknowledgement_time[0], deadline)
                speech_due.set()
                await asyncio.wait_for(playing.wait(), 5)
                call_due.set()
                await wait_until(lambda: output.acknowledgement_record is None,
                                 'The question never cut off the acknowledgement')
                release_acknowledgement.set()
                await self.hear_exactly(spoken, f'Let me look. {deletion_question(bike)}')
                await wait_until(verdicts, 'The question was never judged')
                self.assertRegex(verdicts()[-1], r'^The permission question played in \d+\.\d s$')
                # The panel shows only speech whose audio reached the output.
                self.assertEqual(service.manager.conversation.turns[-1]['text'],
                                 f'One moment. Let me look. {deletion_question(bike)}')
                self.assertIsNotNone(await self.window_change(windows, transport), 'The answer window opens after the question')
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                self.assertIsNone(await self.window_change(windows, transport))
                await self.hear_exactly(spoken, f'I removed the note: {bike}.')
            self.assert_approved_once(events, mark)
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(garden), 'USER.md': note_bytes()})
        finally:
            release_acknowledgement.set()
            await close()

    async def test_typed_answers_settle_a_pending_question(self):
        first, second, third = ('Caller keeps the red notebook in the study', 'Caller walks at dawn',
                                'Caller works late on Thursdays')
        kept = 'Caller prefers cedar tea'
        requests = ['Please delete my notebook note.', 'Delete the notebook note after all.',
                    'Delete the notebook note, really.', 'Delete the notebook note now.',
                    'Please delete my dawn note.', 'Please delete my Thursday note.', 'Replacement request']
        refusal_lines = {'no': "Okay, I won't.", 'unclear': "I didn't catch a clear yes, so I won't."}
        windows = self.watch_answer_windows()

        with self.subTest('voice on'):
            notes = self.private_notes(memory=[kept, first, second], user=[third])
            seeded = read_notes(notes)
            events, analysers = [], []

            def vad_factory(*, params):
                analysers.append(answer_vad(params=params))
                return analysers[-1]

            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                *[reply for note in (first, first, first, first, second)
                  for reply in (scripted_call('asked', 'delete_note', {'note': note}), scripted_say('Unspoken remark.'))],
                scripted_call('stale', 'delete_note', {'note': third}), scripted_say('Unspoken remark.'),
                scripted_say('Replacement answer.'),
            ])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=vad_factory, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            manager = service.manager
            entered, release = asyncio.Event(), asyncio.Event()
            self.addCleanup(release.set)
            recognised = self.fake_answer_recognizer(service, 'yes', entered=entered, release=release)
            try:
                await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                for request, answer, outcome in ((requests[0], 'No thanks.', 'no'), (requests[1], 'maybe later', 'unclear'),
                                                 (requests[2], '   ', 'unclear')):
                    mark = len(events)
                    await self.speak_request(transport, request)
                    await self.hear_exactly(spoken, deletion_question(first))
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    if answer.strip():
                        self.assertEqual(await service.submit(answer), 'accepted')
                    else:
                        self.assertEqual(manager.submit(answer), 'accepted', 'The panel cannot send blank text')
                    self.assertIsNone(await self.window_change(windows, transport))
                    await self.hear_exactly(spoken, refusal_lines[outcome])
                    await self.reply_finished(transport, spoken)
                    self.assert_refused_once(events, mark)
                    self.assertEqual(read_notes(notes), seeded)

                mark = len(events)
                await self.speak_request(transport, requests[3])
                await self.hear_exactly(spoken, deletion_question(first))
                self.assertIsNotNone(await self.window_change(windows, transport))
                self.assertEqual(await service.submit('Yes'), 'accepted')
                self.assertIsNone(await self.window_change(windows, transport), 'A typed answer hands capture back')
                await self.hear_exactly(spoken, f'I removed the note: {first}.')
                await self.reply_finished(transport, spoken)
                self.assert_approved_once(events, mark)
                self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept, second), 'USER.md': seeded['USER.md']})
                self.assertEqual(len(brain.requests), 9, 'A typed answer is not a brain request')

                # A typed answer during spoken capture wins before the speech endpoints.
                mark = len(events)
                await self.speak_request(transport, requests[4])
                await self.hear_exactly(spoken, deletion_question(second))
                self.assertIsNotNone(await self.window_change(windows, transport))
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 5)
                await wait_until(lambda: sum(vad.analysed.count(ANSWER_SPEECH) for vad in analysers) == 5,
                                 'Spoken capture never heard the answer begin')
                self.assertEqual(await service.submit('yes'), 'accepted')
                self.assertIsNone(await self.window_change(windows, transport))
                await self.hear_exactly(spoken, f'I removed the note: {second}.')
                await self.reply_finished(transport, spoken)
                self.assert_approved_once(events, mark)
                self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': seeded['USER.md']})
                self.assertEqual(recognised, [], 'A typed answer never reaches recognition')

                # A spoken yes recognised only after a replacement request superseded its turn approves nothing.
                mark = len(events)
                settled = read_notes(notes)
                await self.speak_request(transport, requests[5])
                await self.hear_exactly(spoken, deletion_question(third))
                self.assertIsNotNone(await self.window_change(windows, transport))
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                self.assertIsNone(await self.window_change(windows, transport))
                await asyncio.wait_for(entered.wait(), 5)
                self.assertEqual(manager.submit(requests[6]), 'accepted')
                release.set()
                await self.hear_exactly(spoken, 'Replacement answer.')
                self.assertEqual([admitted for _, admitted in recognised], [True])
                writes = [event for kind, event in events[mark:] if kind == 'write']
                self.assertNotIn(APPROVAL, writes)
                self.assertIn({'tool_result': brain_result(False, False, 'request superseded'), 'source': 'kestrel'}, writes)
                self.assertEqual(read_notes(notes), settled)
                self.assertEqual(len(brain.requests), 14)
                you = [turn['text'] for turn in manager.conversation.turns if turn['speaker'] == 'you']
                self.assertEqual([text for text in you if text not in requests], [], 'Typed answers are not panel turns')
                for request in brain.requests:
                    self.assertEqual([m['content'] for m in request[2]['messages']
                                      if m['role'] == 'user' and m['content'] not in requests and m['content'] != 'Hello.'], [])
                context = manager.ingress[2].get_messages()
                self.assertEqual([m['content'] for m in context if m['role'] == 'user' and m['content'] not in requests], [])
            finally:
                release.set()
                await close()

        with self.subTest('voice off'):
            notes = self.private_notes(memory=[kept, first], user=[third])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('typed', 'delete_note', {'note': first}), scripted_say('Unspoken remark.'),
                scripted_call('unanswered', 'delete_note', {'note': third}), scripted_say('Unspoken remark.'),
            ])
            self.addCleanup(brain.close)
            handle, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, activate=False, memory_root=notes, native_events=events,
            )
            service = handle.service
            manager = service.manager
            try:
                startup = await asyncio.wait_for(service.waiting.get(), 5)
                self.assertEqual(await service.submit(requests[0]), 'accepted')
                transport = await asyncio.wait_for(service.started.get(), 5)
                # The typed request itself begins the conversation, so only writes after that begin are counted.
                await wait_until(lambda: ('write', {'begin': True}) in events, 'The typed request began no conversation')
                mark = len(events)
                await self.hear_exactly(spoken, deletion_question(first))
                await wait_until(lambda: manager.typed_answer is not None, 'The question opened no typed answer')
                self.assertEqual(manager.submit('yes'), 'accepted')
                await self.hear_exactly(spoken, f'I removed the note: {first}.')
                await self.reply_finished(transport, spoken)
                self.assert_approved_once(events, mark)
                self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': seeded['USER.md']})
                fresh = await asyncio.wait_for(service.waiting.get(), 5)
                self.assertIsNot(fresh, startup)
                self.assertIsNotNone(fresh.capture_pcm, 'Wake capture returns intact after the answer')

                mark = len(events)
                settled = read_notes(notes)
                with patch.object(bot, 'ANSWER_TYPED_SECONDS', 0.05):
                    self.assertEqual(await service.submit(requests[4]), 'accepted')
                    await self.hear_exactly(spoken, deletion_question(third))
                    await self.hear_exactly(spoken, "I didn't get an answer, so I won't.")
                    await self.reply_finished(transport, spoken)
                self.assert_refused_once(events, mark)
                self.assertEqual(read_notes(notes), settled)
                self.assertIsNotNone((await asyncio.wait_for(service.waiting.get(), 5)).capture_pcm)
                self.assertTrue(windows.empty(), 'A typed-only question never touches capture')
                self.assertNotIn('capture_pcm', vars(transport))
                self.assertEqual(len(brain.requests), 5)
                self.assertEqual([turn['text'] for turn in manager.conversation.turns if turn['speaker'] == 'you'],
                                 [requests[0], requests[4]])
            finally:
                await close()

        with self.subTest('text typed once the spoken answer has ended is a new request'):
            notes = self.private_notes(memory=[kept, first])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('asked', 'delete_note', {'note': first}), scripted_say('Unspoken remark.'),
                scripted_say('Yes to what?'),
            ])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            manager = service.manager
            self.fake_answer_recognizer(service, 'No.')
            ended_answer = bot.capture_answer
            typed = []

            async def answer_then_type(*args, **kwargs):
                # Queued after the spoken answer completes, so the typed yes lands before the asking step resumes.
                asyncio.current_task().add_done_callback(lambda capture: typed.append(manager.submit('yes')))
                return await ended_answer(*args, **kwargs)

            try:
                await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                mark = len(events)
                with patch.object(bot, 'capture_answer', answer_then_type):
                    await self.speak_request(transport, requests[0])
                    await self.hear_exactly(spoken, deletion_question(first))
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                    self.assertIsNone(await self.window_change(windows, transport))
                    await wait_until(lambda: len(brain.requests) >= 3, 'The asking turn never settled')
                self.assertEqual(typed, ['accepted'])
                self.assertNotIn(APPROVAL, [event for kind, event in events[mark:] if kind == 'write'],
                                 'Text typed after the spoken answer ended must not approve')
                self.assertEqual(read_notes(notes), seeded)
                await self.hear_exactly(spoken, 'Yes to what?')
                await self.reply_finished(transport, spoken)
                self.assertEqual(len(brain.requests), 4)
                self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] == 'user'][-1],
                                 {'role': 'user', 'content': 'yes'}, 'The typed yes is an ordinary request')
                self.assertEqual(read_notes(notes), seeded)
            finally:
                await close()

        with self.subTest('text typed once the spoken answer is decided is a new request'):
            notes = self.private_notes(memory=[kept, first])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('asked', 'delete_note', {'note': first}), scripted_say('Unspoken remark.'),
                scripted_say('Yes to what?'),
            ])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            manager = service.manager
            self.fake_answer_recognizer(service, 'No.')
            decided_answer = bot.capture_answer
            typed = []

            async def decide_then_type(transport, vad, **kwargs):
                detector_cleanup = vad.cleanup

                async def cleanup():
                    # Capture awaits cleanup only once the answer is decided, so the typed yes is queued ahead of the
                    # capture task's done callbacks.
                    asyncio.get_running_loop().call_soon(lambda: typed.append(manager.submit('yes')))
                    await detector_cleanup()

                vad.cleanup = cleanup
                return await decided_answer(transport, vad, **kwargs)

            try:
                await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                mark = len(events)
                with patch.object(bot, 'capture_answer', decide_then_type):
                    await self.speak_request(transport, requests[0])
                    await self.hear_exactly(spoken, deletion_question(first))
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
                    self.assertIsNone(await self.window_change(windows, transport))
                    await wait_until(lambda: len(brain.requests) >= 3, 'The asking turn never settled')
                self.assertEqual(typed, ['accepted'])
                self.assertNotIn(APPROVAL, [event for kind, event in events[mark:] if kind == 'write'],
                                 'Text typed after the spoken answer was decided must not approve')
                self.assertEqual(read_notes(notes), seeded)
                await self.hear_exactly(spoken, 'Yes to what?')
                await self.reply_finished(transport, spoken)
                self.assertEqual(len(brain.requests), 4)
                self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] == 'user'][-1],
                                 {'role': 'user', 'content': 'yes'}, 'The typed yes is an ordinary request')
                self.assertEqual(read_notes(notes), seeded)
            finally:
                await close()

        with self.subTest('text typed once the answer window has failed is a new request'):
            notes = self.private_notes(memory=[kept, first])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('asked', 'delete_note', {'note': first}), scripted_say('Unspoken remark.'),
                scripted_say('Yes to what?'),
            ])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            manager = service.manager
            self.fake_answer_recognizer(service, 'No.')
            failed_answer = bot.capture_answer
            typed = []

            async def fail_then_type(transport, vad, **kwargs):
                async def analyse(audio):
                    # Queued as the window fails, so the typed yes lands ahead of the capture task's done callbacks.
                    asyncio.get_running_loop().call_soon(lambda: typed.append(manager.submit('yes')))
                    raise RuntimeError('Answer detector failed: fixture')

                vad.analyze_audio = analyse
                return await failed_answer(transport, vad, **kwargs)

            try:
                await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                mark = len(events)
                with patch.object(bot, 'capture_answer', fail_then_type):
                    await self.speak_request(transport, requests[0])
                    await self.hear_exactly(spoken, deletion_question(first))
                    self.assertIsNotNone(await self.window_change(windows, transport))
                    transport.capture.stdout.feed_data(ANSWER_SPEECH)
                    self.assertIsNone(await self.window_change(windows, transport))
                    await wait_until(lambda: len(brain.requests) >= 3, 'The asking turn never settled')
                self.assertEqual(typed, ['accepted'])
                writes = [event for kind, event in events[mark:] if kind == 'write']
                self.assertNotIn(APPROVAL, writes, 'Text typed after the answer window failed must not approve')
                self.assertIn({'tool_result': brain_result(False, False, 'permission step failed'), 'source': 'kestrel'},
                              writes, 'A failed answer window is a broken asking step')
                self.assertEqual(read_notes(notes), seeded)
                # The typed request already holds the speaker, so the broken step's advisory is never heard.
                await self.hear_exactly(spoken, 'Yes to what?')
                await self.reply_finished(transport, spoken)
                self.assertEqual(len(brain.requests), 4)
                self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] == 'user'][-1],
                                 {'role': 'user', 'content': 'yes'}, 'The typed yes is an ordinary request')
                self.assertEqual(read_notes(notes), seeded)
            finally:
                await close()

    async def test_permission_step_refuses_when_asking_cannot_complete(self):
        target = 'Caller keeps the red notebook in the study'
        kept = 'Caller prefers cedar tea'
        request = 'Please delete my notebook note.'
        broken = "I couldn't ask for permission, so I didn't do it."
        windows = self.watch_answer_windows()

        with self.subTest('capture lost before the answer window opens'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain(['[delivery:neutral] Prepared.', scripted_call('asked', 'delete_note', {'note': target}),
                                   scripted_say('Unspoken remark.')])
            self.addCleanup(brain.close)
            transport, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = transport.service
            manager = service.manager
            recognised = self.fake_answer_recognizer(service, 'yes')
            native_capture = bot.capture_answer
            started, release = asyncio.Event(), asyncio.Event()

            async def held_capture(*args, **kwargs):
                started.set()
                await release.wait()
                return await native_capture(*args, **kwargs)

            try:
                with patch.object(bot, 'capture_answer', held_capture), patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0):
                    await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
                    await self.speak_request(transport, request)
                    await self.hear_exactly(spoken, deletion_question(target))
                    await asyncio.wait_for(started.wait(), 5)
                    self.assertIsNone(transport.capture_pcm)
                    lost = transport.capture
                    lost.stdout.feed_eof()
                    await wait_until(lambda: transport.capture is not lost and transport.verified and not manager.switching_output,
                                     'Capture never reopened')
                    release.set()
                    await self.hear_exactly(spoken, broken)
                    self.assertIsNone(manager.failure)
                    self.assertIs(manager.transport, transport)
                    self.assertIsNone(transport.capture_pcm)
                    self.assertEqual(recognised, [])
            finally:
                await close()
            self.assertNotIn(APPROVAL, [event for kind, event in events if kind == 'write'])
            self.assertEqual(read_notes(notes), seeded)

        with self.subTest('a typed-only question survives a lost capture'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain(['[delivery:neutral] Prepared.', scripted_call('asked', 'delete_note', {'note': target}),
                                   scripted_say('Unspoken remark.')])
            self.addCleanup(brain.close)
            handle, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, activate=False, vad_factory=answer_vad, memory_root=notes,
                native_events=events,
            )
            service = handle.service
            manager = service.manager
            try:
                self.assertEqual(await service.submit(request), 'accepted')
                await asyncio.wait_for(service.started.get(), 5)
                await self.hear_exactly(spoken, deletion_question(target))
                await wait_until(lambda: manager.typed_answer is not None, 'The question opened no typed answer')
                with patch.object(bot, 'CAPTURE_RETRY_PAUSE', 0):
                    manager.capture_lost()
                    self.assertFalse(manager.typed_answer.done(), 'A typed wait has no capture to lose')
                    self.assertEqual(await service.submit('yes'), 'accepted')
                    await self.hear_exactly(spoken, f'I removed the note: {target}.')
            finally:
                await close()
            self.assertEqual(read_notes(notes), {'MEMORY.md': note_bytes(kept), 'USER.md': seeded['USER.md']})

        with self.subTest('a tool that cannot be read back, a local tool, or a question that never plays'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain([
                '[delivery:neutral] Prepared.',
                scripted_call('unread', 'mute', {}), scripted_say('Untrue success claim.'),
                scripted_call('local', 'mute', {}), scripted_say('Untrue success claim.'),
                scripted_call('unplayed', 'delete_note', {'note': target}), scripted_say('Unspoken remark.'),
            ])
            self.addCleanup(brain.close)
            command = AsyncMock(side_effect=AssertionError('A broken asking step must not run the tool'))
            transport, spoken, committed, interrupted, _, close = await self.open_session(
                brain, through_service=True, local_command=command, memory_root=notes, native_events=events,
            )
            output = transport.output()
            try:
                await asyncio.wait_for(asyncio.shield(transport.service.manager.session_ready), 5)
                mute = bot.LOCAL_TOOLS['mute']
                for index, entry in enumerate((bot.replace(mute, permission=bot.PermissionTier.ASK),
                                               bot.replace(mute, permission=bot.PermissionTier.ASK,
                                                           read_back='mute the sound'))):
                    mark = len(events)
                    with patch.dict(bot.LOCAL_TOOLS, mute=entry):
                        await self.speak_request(transport, 'Please silence the sound.')
                        await self.hear_exactly(spoken, broken)
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), broken)
                        await self.reply_finished(transport, spoken)
                    self.assert_refused_once(events, mark)
                    self.assertEqual(len(brain.requests), 2 * index + 3)
                    command.assert_not_awaited()

                mark = len(events)
                with patch.object(bot, 'QUESTION_TIMEOUT', 0.05):
                    output.generation_done.clear()
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    barrier = DataFrame()
                    await output.queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    output.write_gate.clear()
                    await self.finish_user_turn(transport, request)
                    await wait_until(lambda: any(kind == 'write' and 'tool_result' in event for kind, event in events[mark:]),
                                     'The unplayed question was never refused')
                    self.assertEqual(read_notes(notes), seeded)
                    output.write_gate.set()
                    heard = ''
                    while not heard.endswith(broken):
                        part = await asyncio.wait_for(spoken.get(), 5)
                        heard = f'{heard} {part}' if heard else part
                    self.assertIn(heard, (broken, f'{deletion_question(target)} {broken}'))
                    await self.reply_finished(transport, spoken)
                self.assert_refused_once(events, mark)
                self.assertEqual(read_notes(notes), seeded)
            finally:
                output.write_gate.set()
                await close()

        with self.subTest('dismissal during the typed-only wait'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            events = []
            brain = ScriptedBrain(['[delivery:neutral] Prepared.', scripted_call('asked', 'delete_note', {'note': target}),
                                   scripted_say('Unspoken remark.')])
            self.addCleanup(brain.close)
            handle, spoken, _, _, _, close = await self.open_session(
                brain, through_service=True, activate=False, memory_root=notes, native_events=events,
            )
            service = handle.service
            manager = service.manager
            try:
                mark = len(events)
                self.assertEqual(await service.submit(request), 'accepted')
                await asyncio.wait_for(service.started.get(), 5)
                await self.hear_exactly(spoken, deletion_question(target))
                await wait_until(lambda: manager.typed_answer is not None, 'The question opened no typed answer')
                self.assertEqual(await service.toggle(), 'starting')
                await asyncio.wait_for(service.started.get(), 5)
                await wait_until(lambda: any(kind == 'write' and 'tool_result' in event for kind, event in events[mark:]),
                                 'The dismissed question was never refused')
                await wait_until(lambda: len(brain.requests) == 3, 'The refused turn never finished')
                self.assert_refused_once(events, mark)
                self.assertEqual(read_notes(notes), seeded)
                self.assertIsNone(manager.typed_answer)
                self.assertTrue(spoken.empty(), 'A dismissed question speaks nothing more')
            finally:
                await close()

        with self.subTest('engine pipe break'):
            notes = self.private_notes(memory=[kept, target])
            seeded = read_notes(notes)
            brain = ScriptedBrain(['[delivery:neutral] Prepared.', scripted_call('asked', 'delete_note', {'note': target}),
                                   scripted_say('Unspoken remark.')])
            self.addCleanup(brain.close)
            handle, spoken, _, _, processes, close = await self.open_session(
                brain, through_service=True, activate=False, memory_root=notes,
            )
            service = handle.service
            manager = service.manager
            try:
                self.assertEqual(await service.submit(request), 'accepted')
                await asyncio.wait_for(service.started.get(), 5)
                await self.hear_exactly(spoken, deletion_question(target))
                await wait_until(lambda: manager.typed_answer is not None, 'The question opened no typed answer')
                process, _ = processes[0]
                process.kill()
                await process.wait()
                self.assertEqual(manager.submit('yes'), 'accepted')
                await self.hear_exactly(spoken, "I couldn't reach Kestrel's engine. Restart Kestrel and try again.")
                self.assertEqual(read_notes(notes), seeded)
            finally:
                await close()
        self.assertTrue(windows.empty(), 'No step here opens an answer window')

    async def test_forbidden_tools_are_refused_without_asking_and_cannot_be_preapproved(self):
        target = 'Caller keeps the red notebook in the study'
        notes = self.private_notes(memory=['Caller prefers cedar tea', target])
        seeded = read_notes(notes)
        windows = self.watch_answer_windows()
        events = []
        brain = ScriptedBrain([
            '[delivery:neutral] Prepared.', scripted_say('Yes to what?'),
            scripted_call('forbidden', 'delete_note', {'note': target}), scripted_say('Unspoken remark.'),
            scripted_call('asked', 'delete_note', {'note': target}), scripted_say('Unspoken remark.'),
        ])
        self.addCleanup(brain.close)
        handle, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, activate=False, memory_root=notes, native_events=events,
        )
        service = handle.service
        manager = service.manager
        try:
            await asyncio.wait_for(service.waiting.get(), 5)
            self.assertEqual(await service.submit('yes'), 'accepted')
            transport = await asyncio.wait_for(service.started.get(), 5)
            await self.hear_exactly(spoken, 'Yes to what?')
            await self.reply_finished(transport, spoken)
            self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] == 'user'],
                             [{'role': 'user', 'content': 'yes'}], 'A yes before any question is an ordinary request')
            await asyncio.wait_for(service.waiting.get(), 5)

            mark = len(events)
            forbidden = bot.replace(bot.LOCAL_TOOLS['delete_note'], permission=bot.PermissionTier.FORBIDDEN)
            with patch.dict(bot.LOCAL_TOOLS, delete_note=forbidden):
                transport.output().generation_done.clear()
                self.assertEqual(await service.submit('Please delete my notebook note.'), 'accepted')
                await self.hear_exactly(spoken, "That isn't allowed by voice, so I didn't do it.")
                await self.reply_finished(transport, spoken)
            self.assertIsNone(manager.typed_answer)
            self.assertEqual([event for kind, event in events[mark:] if kind == 'write' and 'tool_result' in event],
                             [{'tool_result': brain_result(False, False, 'not allowed by voice'), 'source': 'kestrel'}])
            self.assertNotIn(APPROVAL, [event for kind, event in events if kind == 'write'])
            self.assertEqual(tool_contents(brain.requests[-1]), [brain_result(False, False, 'not allowed by voice')])
            self.assertEqual(read_notes(notes), seeded)
            await asyncio.wait_for(service.waiting.get(), 5)

            # The earlier yes approves nothing: the next asking question still waits for its own answer.
            mark = len(events)
            with patch.object(bot, 'ANSWER_TYPED_SECONDS', 0.05):
                transport.output().generation_done.clear()
                self.assertEqual(await service.submit('Please delete my notebook note.'), 'accepted')
                await self.hear_exactly(spoken, deletion_question(target))
                await self.hear_exactly(spoken, "I didn't get an answer, so I won't.")
                await self.reply_finished(transport, spoken)
            self.assert_refused_once(events, mark)
            self.assertEqual(read_notes(notes), seeded)
            self.assertEqual(len(brain.requests), 6)
            self.assertTrue(windows.empty())
        finally:
            await close()

    async def test_permission_answer_audio_never_enters_the_conversation(self):
        target = 'Caller keeps the red notebook in the study'
        request = 'Please delete my notebook note.'
        sentinel = 'nonce-951'
        notes = self.private_notes(memory=['Caller prefers cedar tea', target])
        seeded = read_notes(notes)
        traces_home = tempfile.TemporaryDirectory(prefix='kestrel-answer-traces-')
        self.addCleanup(traces_home.cleanup)
        traces = Path(traces_home.name) / 'traces'
        traces.mkdir(mode=0o700)
        windows = self.watch_answer_windows()
        events = []
        brain = ScriptedBrain(['[delivery:neutral] Prepared.', scripted_call('asked', 'delete_note', {'note': target}),
                               scripted_say('Unspoken remark.'), scripted_call('long', 'delete_note', {'note': target}),
                               scripted_say('Unspoken remark.')])
        self.addCleanup(brain.close)
        analysers = []

        def vad_factory(*, params):
            analysers.append(answer_vad(params=params))
            return analysers[-1]

        transport, spoken, _, _, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, vad_factory=vad_factory, memory_root=notes,
            native_events=events, trace_root=traces,
        )
        service = transport.service
        manager = service.manager
        recognised = self.fake_answer_recognizer(service, f'Maybe {sentinel}.')
        pipeline_audio, recognition_audio = [], []

        @transport.input().event_handler('on_after_push_frame')
        async def entered_pipeline(processor, frame):
            if isinstance(frame, InputAudioRawFrame):
                pipeline_audio.append(frame.audio)

        @manager.stt.event_handler('on_before_process_frame')
        async def entered_recognition(processor, frame):
            if isinstance(frame, InputAudioRawFrame):
                recognition_audio.append(frame.audio)

        try:
            await asyncio.wait_for(asyncio.shield(manager.session_ready), 5)
            await self.speak_request(transport, request)
            await self.hear_exactly(spoken, deletion_question(target))
            self.assertIsNotNone(await self.window_change(windows, transport))
            transport.capture.stdout.feed_data(ANSWER_SPEECH * 10 + ANSWER_QUIET * 40)
            self.assertIsNone(await self.window_change(windows, transport))
            await self.hear_exactly(spoken, "I didn't catch a clear yes, so I won't.")
            await self.reply_finished(transport, spoken)
            self.assertEqual(len(recognised), 1)
            # Ordinary capture after the window reaches both observers, so their silence about answer frames is real.
            transport.capture.stdout.feed_data(b'z' * 640)
            await wait_until(lambda: b'z' * 640 in pipeline_audio and b'z' * 640 in recognition_audio,
                             'Ordinary capture never reached the pipeline observers')
            for observed in (pipeline_audio, recognition_audio):
                self.assertEqual([audio for audio in observed if audio in (ANSWER_SPEECH, ANSWER_QUIET)], [])

            with self.subTest('speech past the cut-off is thrown away'):
                await self.speak_request(transport, request)
                await self.hear_exactly(spoken, deletion_question(target))
                self.assertIsNotNone(await self.window_change(windows, transport))
                heard = sum(vad.analysed.count(ANSWER_SPEECH) for vad in analysers)
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 301)
                await wait_until(lambda: sum(vad.analysed.count(ANSWER_SPEECH) for vad in analysers) == heard + 301,
                                 'Spoken capture never heard the answer reach its cut-off')
                # Speech still going two seconds past the six second cut-off, arriving after it, then the quiet that ends it.
                transport.capture.stdout.feed_data(ANSWER_SPEECH * 99 + ANSWER_QUIET * 40)
                self.assertIsNone(await self.window_change(windows, transport))
                await self.hear_exactly(spoken, "I didn't catch a clear yes, so I won't.")
                transport.capture.stdout.feed_data(b'x' * 640)
                await wait_until(lambda: b'x' * 640 in pipeline_audio and b'x' * 640 in recognition_audio,
                                 'Ordinary capture never resumed after the thrown-away tail')
                for observed in (pipeline_audio, recognition_audio):
                    self.assertEqual(sum(audio in (ANSWER_SPEECH, ANSWER_QUIET) for audio in observed), 0,
                                     'Answer frames entered the conversation')
                self.assertEqual(len(recognised), 1, 'A cut-off answer is never recognised')
                await self.reply_finished(transport, spoken)
                self.assertEqual(len(brain.requests), 5)
            self.assertEqual(read_notes(notes), seeded)
            self.assertNotIn(sentinel, json.dumps(manager.ingress[2].get_messages()))
            self.assertNotIn(sentinel, json.dumps(manager.conversation.turns))
            for brain_request in brain.requests:
                self.assertNotIn(sentinel, json.dumps(brain_request[2]))
            self.assertNotIn(sentinel, json.dumps([event for kind, event in events if kind == 'write']))
        finally:
            await close()
        private_traces = list(traces.glob('session-*/events.jsonl'))
        self.assertTrue(private_traces)
        self.assertTrue(any(request in trace.read_text() for trace in private_traces))
        for trace in private_traces:
            self.assertNotIn(sentinel, trace.read_text())


if __name__ == '__main__':
    unittest.main()
