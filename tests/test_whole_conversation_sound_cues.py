import asyncio
import json
import threading
import unittest
from unittest.mock import AsyncMock

import numpy as np
from pipecat.frames.frames import DataFrame, LLMFullResponseEndFrame, ProposedUserStartedSpeakingFrame

import bot
from conversation_fixtures import WholeConversationCase
import reply_progress
from test_hermes import ScriptedBrain


class WholeConversationTests(WholeConversationCase):
    @staticmethod
    def sound_pcm(service):
        return b''.join(data for child in service.audio_children for data in child.writes)

    def assert_sound_cue(self, pcm, kind):
        # Independent issue-42 oracle: literal sample counts and spectral measurements, no generated reference clip.
        tones, gap, size = {
            'listening': (((660, 2880), (880, 2880)), 960, 13440),
            'heard': (((660, 3360),), 0, 6720),
            'finished': (((880, 2880), (660, 2880)), 960, 13440),
            'failed': (((330, 4320), (330, 4320)), 1920, 21120),
        }[kind]
        self.assertEqual(len(pcm), size, f'{kind} cue must write its complete native PCM at the lifecycle boundary')
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float64)
        offset = 0
        for index, (frequency, count) in enumerate(tones):
            tone = samples[offset:offset + count]
            self.assertGreater(np.max(np.abs(tone)), 3200)
            self.assertLessEqual(np.max(np.abs(tone)), 3277)
            self.assertEqual(tone[0], 0)
            self.assertLessEqual(abs(tone[-1]), 1)
            steady = tone[480:-480]
            spectrum = np.abs(np.fft.rfft(steady))
            measured = np.fft.rfftfreq(len(steady), 1 / 48000)[np.argmax(spectrum)]
            self.assertAlmostEqual(measured, frequency, delta=25)
            rms = np.sqrt(np.mean(steady ** 2))
            self.assertGreater(rms, 2200)
            self.assertLess(np.sqrt(np.mean(tone[:480] ** 2)), .8 * rms)
            self.assertLess(np.sqrt(np.mean(tone[-480:] ** 2)), .8 * rms)
            offset += count
            if index + 1 < len(tones):
                self.assertEqual(pcm[offset * 2:(offset + gap) * 2], bytes(gap * 2))
                offset += gap

    @staticmethod
    def sound_completions(manager):
        completed = asyncio.Queue()
        original = manager.reply_finished

        def finished(token):
            original(token)
            completed.put_nowait(token)

        manager.reply_finished = finished
        return completed

    async def test_sound_cues_follow_activation_and_accepted_requests(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def chunks(**kwargs):
            if kwargs['text'] == 'Typed answer.':
                entered.set()
                if not release.wait(45):
                    raise AssertionError('Typed synthesis was not released')
            yield np.zeros(4800, dtype=np.float32)

        brain = ScriptedBrain(['[delivery:neutral] Prepared.', '[delivery:neutral] Spoken answer.',
                               '[delivery:neutral] Typed answer.', 400])
        self.addCleanup(brain.close)
        handle, spoken, committed, interrupted, _, close = await self.open_session(
            brain, through_service=True, native_audio=True, activate=False, synthesis_chunks=chunks,
        )
        service, manager = handle.service, handle.service.manager
        finished = self.sound_completions(manager)
        drained, release_drain = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_drain.set)
        try:
            waiting = await asyncio.wait_for(service.waiting.get(), 5)
            await asyncio.shield(service.channel.preparation)
            self.assertEqual(self.sound_pcm(service), b'', 'Inactive preparation must never sound listening')
            self.assertEqual(manager.conversation.turns, [])
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            self.assertTrue(waiting.capture.reaped.is_set())
            self.assertTrue(transport.verified)
            self.assertTrue(transport.input().ready)
            self.assertGreater(len(self.sound_pcm(service)), 0)
            await asyncio.wait_for(next(child for child in service.audio_children if child.stdin is not None).reaped.wait(), 5)
            self.assert_sound_cue(self.sound_pcm(service), 'listening')
            _, _, context = manager.ingress
            self.assertEqual(context.get_messages(), [])
            self.assertEqual(manager.conversation.turns, [])
            self.assertIsNone(manager.llm.last_spoken_reply)
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)
            before = len(self.sound_pcm(service))
            transport.capture.stdout.feed_data(bytes(640))
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(len(self.sound_pcm(service)), before, 'Speech start is not another activation')
            await self.finish_user_turn(transport, 'Spoken question')
            await asyncio.wait_for(finished.get(), 5)
            pcm = self.sound_pcm(service)[before:]
            self.assert_sound_cue(pcm[:6720], 'heard')
            self.assert_sound_cue(pcm[-13440:], 'finished')
            self.assertFalse(any(pcm[6720:-13440]), 'Cue bytes cannot become synthetic speech')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Spoken answer.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Spoken answer.')
            self.assertEqual(manager.llm.last_spoken_reply, 'Spoken answer.')
            self.assertEqual(manager.conversation.turns, [
                {'speaker': 'you', 'text': 'Spoken question', 'state': 'complete', 'source': 'spoken'},
                {'speaker': 'kestrel', 'text': 'Spoken answer.', 'state': 'complete'},
            ])
            before = len(self.sound_pcm(service))
            rejected = self.transcription(transport, 'Unadmitted cue canary')
            rejected.input_mark = object()
            await transport.input().queue_frame(rejected)
            await self.finish_user_turn(transport, '')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(len(self.sound_pcm(service)), before)
            self.assertEqual(len(brain.requests), 2)
            self.assertEqual(await service.toggle(), 'inactive')
            await asyncio.wait_for(service.waiting.get(), 5)
            self.assertEqual(len(self.sound_pcm(service)), before, 'Dismissal is silent')
            self.assertEqual(await service.submit('Typed question'), 'accepted')
            typed = await asyncio.wait_for(service.started.get(), 5)
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            self.assertIsNone(typed.capture)
            self.assertFalse(manager.desired_active)
            self.assertFalse(manager.admission.admits_microphone())
            self.assert_sound_cue(self.sound_pcm(service)[before:before + 6720], 'heard')
            spawn = typed._spawn

            async def hold_terminal(*argv, **kwargs):
                child = await spawn(*argv, **kwargs)
                native_closed = child.stdin.wait_closed

                async def wait_closed():
                    if len(b''.join(child.writes)) == 13440:
                        drained.set()
                        await release_drain.wait()
                    await native_closed()

                child.stdin.wait_closed = AsyncMock(side_effect=wait_closed)
                return child

            typed._spawn = hold_terminal
            release.set()
            await asyncio.wait_for(drained.wait(), 5)
            pcm = self.sound_pcm(service)[before:]
            self.assert_sound_cue(pcm[-13440:], 'finished')
            self.assertIsNotNone(manager.wake_reply_token, 'Typed wake suppression includes cue drainage')
            self.assertIsNone(manager.waiting_transport)
            self.assertTrue(finished.empty())
            release_drain.set()
            await asyncio.wait_for(finished.get(), 5)
            await asyncio.wait_for(service.waiting.get(), 5)
            self.assertIsNone(manager.wake_reply_token)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Typed answer.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Typed answer.')
            self.assertEqual(manager.llm.last_spoken_reply, 'Typed answer.')
            self.assertEqual(manager.conversation.turns, [
                {'speaker': 'you', 'text': 'Typed question', 'state': 'complete', 'source': 'typed'},
                {'speaker': 'kestrel', 'text': 'Typed answer.', 'state': 'complete'},
            ])
            self.assertEqual([m for m in brain.requests[2][2]['messages'] if m['role'] != 'system'],
                             [{'role': 'user', 'content': 'Typed question'}])
            before = len(self.sound_pcm(service))
            self.assertEqual(await service.submit('Provider refusal question'), 'accepted')
            await asyncio.wait_for(finished.get(), 5)
            pcm = self.sound_pcm(service)[before:]
            self.assert_sound_cue(pcm[:6720], 'heard')
            self.assert_sound_cue(pcm[-21120:], 'failed')
            self.assertFalse(any(pcm[6720:-21120]), 'Failure replaces the finished cue, exactly once')
            self.assertEqual(len(brain.requests), 4, 'No provider retry')
            self.assertEqual([m for m in brain.requests[3][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Typed question'},
                {'role': 'assistant', 'content': 'Typed answer.'},
                {'role': 'user', 'content': 'Provider refusal question'},
            ])
            self.assertTrue(all(row['text'] for row in manager.conversation.turns))
        finally:
            release.set()
            release_drain.set()
            await close()

    async def test_sound_cues_preserve_interruption_and_silent_controls(self):
        for replacement in ('replace', 'dismiss'):
            with self.subTest(replacement=replacement):
                command = AsyncMock(side_effect=['selected', 'physical', 'Mute: no', '',
                                                'selected', 'physical', 'Mute: yes'])
                handle, spoken, committed, _, _, close = await self.open_session(
                    None, through_service=True, native_audio=True, local_command=command, activate=False,
                )
                service, manager = handle.service, handle.service.manager
                finished = self.sound_completions(manager)
                self.assertEqual(await service.toggle(), 'starting')
                transport = await asyncio.wait_for(service.started.get(), 5)
                await asyncio.wait_for(next(child for child in service.audio_children if child.stdin is not None).reaped.wait(), 5)
                held, release = asyncio.Event(), asyncio.Event()
                self.addCleanup(release.set)
                target = []
                spawn = transport._spawn

                async def hold_finished(*argv, **kwargs):
                    child = await spawn(*argv, **kwargs)

                    async def drain():
                        pcm = b''.join(child.writes)
                        samples = np.frombuffer(pcm, dtype='<i2')
                        if not target and len(samples) and np.any(samples):
                            frequency = np.fft.rfftfreq(len(samples), 1 / 48000)[np.argmax(np.abs(np.fft.rfft(samples)))]
                            if frequency > 800:
                                target.append(child)
                                held.set()
                                await release.wait()

                    child.stdin.drain = AsyncMock(side_effect=drain)
                    return child

                transport._spawn = hold_finished
                try:
                    await asyncio.gather(asyncio.shield(manager.session_ready), return_exceptions=True)
                    self.assertEqual(await service.submit('what can I say?'), 'accepted')
                    await asyncio.wait_for(held.wait(), 5)
                    old_child = target[0]
                    old_bytes = b''.join(old_child.writes)
                    self.assertGreater(len(old_bytes), 0)
                    self.assertLess(len(old_bytes), 13440, 'Hold the terminal cue before its tail writes')
                    if replacement == 'dismiss':
                        self.assertEqual(await service.toggle(), 'inactive')
                        revoked_bytes = len(self.sound_pcm(service))
                        release.set()
                        await asyncio.wait_for(service.waiting.get(), 5)
                        self.assertEqual(len(self.sound_pcm(service)), revoked_bytes)
                        self.assertEqual(manager.conversation.turns, [])
                        while not finished.empty():
                            finished.get_nowait()
                        self.assertEqual(await service.toggle(), 'starting')
                        transport = await asyncio.wait_for(service.started.get(), 5)
                    else:
                        self.assertEqual(await service.submit('what can I say?'), 'accepted')
                        replacement_token = manager.wake_reply_token
                        self.assertIsNotNone(replacement_token)
                        release.set()
                        for _ in range(2):
                            if await asyncio.wait_for(finished.get(), 5) is replacement_token:
                                break
                        else:
                            self.fail('Replacement reply did not complete with its matching token')
                    self.assertEqual(b''.join(old_child.writes), old_bytes, 'Superseded cue tail cannot reach playback')
                    self.assertTrue(old_child.reaped.is_set())
                    while not spoken.empty():
                        self.assertEqual(spoken.get_nowait(), bot.capability_help())
                    for text in ('stop', 'cancel'):
                        before = len(self.sound_pcm(service))
                        self.assertEqual(await service.submit(text), 'accepted')
                        await asyncio.wait_for(finished.get(), 5)
                        self.assertEqual(len(self.sound_pcm(service)), before, f'{text} adds no cues')
                        self.assertTrue(spoken.empty())
                    before = len(self.sound_pcm(service))
                    self.assertEqual(await service.submit('mute'), 'accepted')
                    await asyncio.wait_for(finished.get(), 5)
                    pcm = self.sound_pcm(service)[before:]
                    self.assertGreater(len(pcm), 0)
                    self.assertFalse(any(pcm), 'Successful mute retains only its existing announcement')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
                    before = len(self.sound_pcm(service))
                    self.assertEqual(await service.submit('what can I say?'), 'accepted')
                    await asyncio.wait_for(finished.get(), 5)
                    pcm = self.sound_pcm(service)[before:]
                    self.assert_sound_cue(pcm[:6720], 'heard')
                    self.assert_sound_cue(pcm[-13440:], 'finished')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), bot.capability_help())
                    self.assertTrue(spoken.empty())
                finally:
                    release.set()
                    await close()

    async def test_sound_cues_report_failed_local_and_brain_results(self):
        for case in ('workspace', 'media', 'readback', 'empty_synthesis', 'failed_synthesis', 'provider'):
            with self.subTest(case=case):
                workspace, playing = 1, True
                calls, syntheses = [], []

                async def command(argv):
                    nonlocal workspace, playing
                    calls.append(argv)
                    if argv == ('/usr/bin/hyprctl', '-j', 'activeworkspace'):
                        return 'malformed readback' if case == 'readback' and workspace == 3 else json.dumps({'id': workspace})
                    if argv[:2] == ('/usr/bin/hyprctl', 'dispatch'):
                        workspace = 3
                        return 'ok'
                    if argv == ('/usr/bin/omarchy-shell', 'media', 'status'):
                        return json.dumps({'hasPlayer': True, 'playing': playing, 'canGoNext': True,
                                           'identity': 'fixture', 'desktopEntry': 'fixture',
                                           'title': 'track', 'artist': 'artist', 'album': 'album'})
                    self.assertEqual(argv, ('/usr/bin/omarchy-shell', 'media', 'pause'))
                    playing = False
                    return 'ok'

                def chunks(**kwargs):
                    syntheses.append(kwargs['text'])
                    if case == 'failed_synthesis':
                        raise RuntimeError('Controlled synthesis failure')
                    if case != 'empty_synthesis':
                        yield np.zeros(4800, dtype=np.float32)

                brain = ScriptedBrain(['[delivery:neutral] Prepared.', 400]) if case == 'provider' else None
                if brain is not None:
                    self.addCleanup(brain.close)
                handle, spoken, committed, _, processes, close = await self.open_session(
                    brain, through_service=True, native_audio=True, local_command=command, synthesis_chunks=chunks, activate=False,
                )
                service, manager = handle.service, handle.service.manager
                finished = self.sound_completions(manager)
                try:
                    self.assertEqual(await service.toggle(), 'starting')
                    await asyncio.wait_for(service.started.get(), 5)
                    await asyncio.wait_for(next(child for child in service.audio_children if child.stdin is not None).reaped.wait(), 5)
                    if case == 'provider':
                        await asyncio.shield(manager.session_ready)
                    else:
                        await asyncio.gather(asyncio.shield(manager.session_ready), return_exceptions=True)
                    before = len(self.sound_pcm(service))
                    text = ('workspace three' if case in ('workspace', 'readback') else 'pause music' if case == 'media'
                            else 'Refused provider request' if case == 'provider' else 'what can I say?')
                    self.assertEqual(await service.submit(text), 'accepted')
                    await asyncio.wait_for(finished.get(), 5)
                    pcm = self.sound_pcm(service)[before:]
                    self.assert_sound_cue(pcm[:6720], 'heard')
                    successful = case in ('workspace', 'media')
                    size = 13440 if successful else 21120
                    self.assert_sound_cue(pcm[-size:], 'finished' if successful else 'failed')
                    self.assertFalse(any(pcm[6720:-size]), 'One terminal cue, no contradictory success or retry')
                    self.assertTrue(finished.empty())
                    if successful:
                        self.assertEqual(len(pcm), 6720 + 13440)
                        self.assertEqual(syntheses, [])
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        self.assertEqual(manager.conversation.turns, [
                            {'speaker': 'you', 'text': text, 'state': 'complete', 'source': 'typed'},
                        ])
                    elif case in ('empty_synthesis', 'failed_synthesis'):
                        self.assertEqual(syntheses, [bot.capability_help()])
                        self.assertEqual(len(pcm), 6720 + 21120)
                        self.assertTrue(committed.empty())
                        self.assertEqual(manager.conversation.turns[-1]['state'], 'failed')
                        self.assertIsNone(manager.llm.last_spoken_reply)
                    elif case == 'provider':
                        self.assertEqual(len(brain.requests), 2)
                        self.assertEqual(manager.conversation.turns[-1]['state'], 'failed')
                        self.assertIsNotNone(service.channel.failure)
                        self.assertTrue(all(process.returncode is not None for process, _ in processes if process is not None))
                    else:
                        self.assertEqual(sum(argv[:2] == ('/usr/bin/hyprctl', 'dispatch') for argv in calls), 1)
                        self.assertTrue(syntheses, 'Unconfirmed readback retains its spoken advisory')
                        self.assertEqual(manager.conversation.turns[-1]['state'], 'complete')
                        self.assertEqual(manager.llm.outcomes, [])
                        pcm_length, synthesis_count = len(self.sound_pcm(service)), len(syntheses)
                        self.assertEqual(await service.submit('stop'), 'accepted')
                        await asyncio.wait_for(finished.get(), 5)
                        self.assertEqual(len(self.sound_pcm(service)), pcm_length)
                        self.assertEqual(len(syntheses), synthesis_count)
                        self.assertEqual(manager.llm.outcomes, [])
                        self.assertTrue(finished.empty())
                    if case == 'failed_synthesis':
                        self.assertTrue(manager.voice.generation_cleanup_failed)
                        self.assertEqual(await service.toggle(), 'inactive')
                        await service.state('trouble-voice')
                        self.assertEqual(await service.toggle(), 'unavailable')
                finally:
                    await close()
                if case == 'failed_synthesis':
                    self.assertEqual(str(service.shutdown_error), 'Voice generation cleanup failed. Restart Kestrel.')

        with self.subTest(case='early_synthesis_failure_late_brain_end'):
            held, release = threading.Event(), threading.Event()
            self.addCleanup(release.set)

            def continuing():
                yield {'content': '[delivery:neutral] First sentence. Next'}, None
                held.set()
                if not release.wait(45):
                    raise AssertionError('Late brain end was not released')
                yield {'content': ' sentence.'}, None
                yield {}, 'stop'

            syntheses = []

            def chunks(**kwargs):
                syntheses.append(kwargs['text'])
                if kwargs['text'] == 'First sentence.':
                    yield np.array(['controlled invalid PCM'], dtype=object)
                else:
                    yield np.zeros(4800, dtype=np.float32)

            brain = ScriptedBrain(['[delivery:neutral] Prepared.', continuing()])
            self.addCleanup(brain.close)
            handle, _, _, _, _, close = await self.open_session(
                brain, through_service=True, native_audio=True, synthesis_chunks=chunks, activate=False,
            )
            service, manager = handle.service, handle.service.manager
            finished = self.sound_completions(manager)
            token, late_end = None, asyncio.Event()
            try:
                self.assertEqual(await service.toggle(), 'starting')
                transport = await asyncio.wait_for(service.started.get(), 5)
                voice = manager.voice
                await asyncio.wait_for(next(child for child in service.audio_children if child.stdin is not None).reaped.wait(), 5)
                await asyncio.shield(manager.session_ready)

                @transport.output().event_handler('on_after_push_frame')
                async def ended(processor, frame):
                    if isinstance(frame, LLMFullResponseEndFrame) and reply_progress.token_of(frame) is token:
                        late_end.set()

                before = len(self.sound_pcm(service))
                self.assertEqual(await service.submit('Fail before the brain finishes'), 'accepted')
                token = await asyncio.wait_for(finished.get(), 5)
                self.assertTrue(held.is_set())
                self.assertFalse(release.is_set())
                self.assertEqual(syntheses, ['First sentence.'])
                pcm = self.sound_pcm(service)[before:]
                self.assertEqual(len(pcm), 6720 + 21120)
                self.assert_sound_cue(pcm[:6720], 'heard')
                self.assert_sound_cue(pcm[6720:], 'failed')
                self.assertTrue(finished.empty())
                self.assertFalse(voice.generation_cleanup_failed)
                late_end.clear()
                transport.capture.stdout.feed_data(bytes(640))
                release.set()
                await asyncio.wait_for(late_end.wait(), 5)
                with self.subTest(oracle='terminal_pcm'):
                    additional = self.sound_pcm(service)[before + len(pcm):]
                    self.assertEqual(np.count_nonzero(np.frombuffer(additional, dtype='<i2')), 0,
                                     'A late brain end cannot sound another terminal cue')
                with self.subTest(oracle='completion_callback'):
                    self.assertTrue(finished.empty(), 'The accepted token completes only once')
            finally:
                release.set()
                await close()
            self.assertFalse(voice.generation_cleanup_failed)
            self.assertIsNone(getattr(service, 'shutdown_error', None))


if __name__ == '__main__':
    unittest.main()
