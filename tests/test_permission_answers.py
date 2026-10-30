import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

import bot
from conversation_fixtures import ANSWER_QUIET, ANSWER_SPEECH, answer_frames, answer_vad, deletion_question, wait_until
import speech


class PermissionAnswerTests(unittest.IsolatedAsyncioTestCase):
    def test_answers_count_only_as_exact_whole_yes_or_no(self):
        # The prototype's sets at 422eeac are the oracle.
        yes = ('yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'go ahead', 'do it', 'yes please', 'please do',
               'yes go ahead')
        no = ('no', 'nope', 'no thanks', "don't", 'do not', 'stop', 'cancel', 'not now', 'never mind')
        for text in (*yes, 'Yes.', '  OK!  '):
            with self.subTest(text=text):
                self.assertEqual(bot.classify_answer(text), 'yes')
        for text in (*no, 'don’t'):
            with self.subTest(text=text):
                self.assertEqual(bot.classify_answer(text), 'no')
        for text in ('yes, but not that one', 'no, wait, yes', 'maybe', ''):
            with self.subTest(text=text):
                self.assertEqual(bot.classify_answer(text), 'unclear')

    def test_question_endings_never_classify_as_an_answer(self):
        # A recognizer that catches the tail of Kestrel's own question must not hear it as an answer.
        for note in ('yes', 'do it', 'go ahead', 'no', 'Caller keeps the red notebook in the study'):
            words = deletion_question(note).split()
            for start in range(len(words)):
                ending = ' '.join(words[start:])
                with self.subTest(ending=ending):
                    self.assertEqual(bot.classify_answer(ending), 'unclear')

    async def open_window(self, frames):
        from types import SimpleNamespace
        transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
        window = asyncio.create_task(speech.capture_answer(
            transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
        await wait_until(lambda: transport.capture_pcm is not None or window.done(), 'The answer window never opened')
        for pcm in frames:
            transport.capture_pcm(pcm)
        result = await asyncio.wait_for(window, 5)
        self.assertIsNone(transport.capture_pcm, 'The answer window must hand capture back')
        vad.set_sample_rate.assert_called_once_with(16000)
        vad.cleanup.assert_awaited_once()
        self.assertEqual(len(decisions), 1, 'Each answer window decides exactly once')
        return result

    async def test_answer_window_endpoints_and_always_restores_capture(self):
        from types import SimpleNamespace
        with self.subTest('no speech within the six second wait is silence'):
            self.assertIsNone(await self.open_window([ANSWER_QUIET] * 300 + [ANSWER_SPEECH] * 5))
        with self.subTest('speech on the last waiting frame keeps the frames just before it'):
            wav, cut_off = await self.open_window([ANSWER_QUIET] * 299 + [ANSWER_SPEECH] + [ANSWER_QUIET] * 41)
            self.assertEqual(answer_frames(wav), ANSWER_QUIET * 24 + ANSWER_SPEECH + ANSWER_QUIET * 40)
            self.assertFalse(cut_off)
        with self.subTest('0.8 seconds of quiet ends the answer and speech restarts the count'):
            wav, cut_off = await self.open_window(
                [ANSWER_SPEECH] + [ANSWER_QUIET] * 39 + [ANSWER_SPEECH] + [ANSWER_QUIET] * 40 + [ANSWER_SPEECH] * 3)
            self.assertEqual(answer_frames(wav), ANSWER_SPEECH + ANSWER_QUIET * 39 + ANSWER_SPEECH + ANSWER_QUIET * 40)
            self.assertFalse(cut_off)
        for label, tail, ending, bounded in (
                ('six seconds of speech is cut off and its tail is thrown away until 0.8 seconds of quiet',
                 [ANSWER_SPEECH] * 19 + [ANSWER_QUIET] * 39, [ANSWER_QUIET], False),
                ('speech going on past the cut-off is thrown away for at most six more seconds',
                 [ANSWER_SPEECH] * 299, [ANSWER_SPEECH] * 10, True)):
            with self.subTest(label):
                transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
                window = asyncio.create_task(speech.capture_answer(
                    transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
                await wait_until(lambda: transport.capture_pcm is not None or window.done(), 'The answer window never opened')
                fed = [ANSWER_SPEECH] * 301 + tail
                for pcm in fed:
                    transport.capture_pcm(pcm)
                await wait_until(lambda: len(vad.analysed) == len(fed) or window.done(), 'The answer window stalled')
                self.assertFalse(window.done(), f'Capture was handed back after {len(vad.analysed)} frames, inside the tail')
                self.assertIsNotNone(transport.capture_pcm)
                for pcm in ending:
                    transport.capture_pcm(pcm)
                wav, cut_off = await asyncio.wait_for(window, 5)
                self.assertIsNone(transport.capture_pcm, 'The answer window must hand capture back')
                vad.cleanup.assert_awaited_once()
                self.assertTrue(cut_off)
                # One opening frame, then the six second limit counted by frames; 422eeac's float sum reaches it one frame later.
                self.assertIn(len(answer_frames(wav)), (301 * 640, 302 * 640))
                self.assertEqual(set(answer_frames(wav)), {ord('Y')}, 'The thrown-away tail is not part of the answer')
                self.assertEqual(decisions, [len(answer_frames(wav)) // 640],
                                 'The cut-off is decided before any of the thrown-away tail is read')
                # The quiet ends the tail at the last frame fed; the six second bound ends it with frames still queued.
                handed_back = len(answer_frames(wav)) // 640 + 300 if bounded else len(fed) + len(ending)
                self.assertEqual(len(vad.analysed), handed_back)
        with self.subTest('a detector failure in the thrown-away tail still decides only once'):
            transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
            analyse, broken = vad.analyze_audio, b'T' * 640

            async def fail_in_tail(audio):
                if audio == broken:
                    raise RuntimeError('Answer detector failed: fixture')
                return await analyse(audio)

            vad.analyze_audio = fail_in_tail
            window = asyncio.create_task(speech.capture_answer(
                transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
            await wait_until(lambda: transport.capture_pcm is not None or window.done(), 'The answer window never opened')
            # One opening frame and the six second limit reach the cut-off; the next frame is the thrown-away tail.
            for pcm in [ANSWER_SPEECH] * 301 + [broken]:
                transport.capture_pcm(pcm)
            with self.assertRaises(RuntimeError):
                await asyncio.wait_for(window, 5)
            self.assertIsNone(transport.capture_pcm, 'The answer window must hand capture back')
            vad.cleanup.assert_awaited_once()
            self.assertEqual(decisions, [301], 'A failure after the cut-off was decided must not decide again')
        with self.subTest('cancellation hands capture back'):
            transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
            window = asyncio.create_task(speech.capture_answer(
                transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
            await wait_until(lambda: transport.capture_pcm is not None or window.done(), 'The answer window never opened')
            transport.capture_pcm(ANSWER_SPEECH)
            await wait_until(lambda: vad.analysed == [ANSWER_SPEECH], 'The answer window never heard the speech')
            window.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await window
            self.assertIsNone(transport.capture_pcm)
            vad.cleanup.assert_awaited_once()
            self.assertEqual(decisions, [], 'A cancelled answer window decides nothing')
        with self.subTest('a detector failure on the first frame decides once and hands capture back'):
            transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
            vad.analyze_audio = AsyncMock(side_effect=RuntimeError('Answer detector failed: fixture'))
            window = asyncio.create_task(speech.capture_answer(
                transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
            await wait_until(lambda: transport.capture_pcm is not None or window.done(), 'The answer window never opened')
            transport.capture_pcm(ANSWER_SPEECH)
            with self.assertRaises(RuntimeError):
                await asyncio.wait_for(window, 5)
            vad.analyze_audio.assert_awaited_once_with(ANSWER_SPEECH)
            self.assertIsNone(transport.capture_pcm)
            vad.cleanup.assert_awaited_once()
            self.assertEqual(len(decisions), 1, 'A failed answer window ends the answer exactly once')
        for label, failure in (('raises', AsyncMock(side_effect=RuntimeError('Nemotron recognition failed: fixture'))),
                               ('returns no text', AsyncMock(return_value=None))):
            with self.subTest(f'a recognizer that {label} breaks the asking step and hands capture back'):
                manager = bot.VoiceConversations(status=Mock(), conversation=Mock())
                transport, vad = SimpleNamespace(capture_pcm=None), answer_vad()
                manager.transport = transport
                manager.admission = Mock(**{'admits_microphone.return_value': True})
                with patch.object(bot, 'SileroVADAnalyzer', return_value=vad) as analyser, \
                        patch.object(manager.recognizer, 'transcribe', new=failure):
                    hearing = asyncio.create_task(manager.hear_answer(admitted=lambda: True, spoken=True))
                    await wait_until(lambda: transport.capture_pcm is not None or hearing.done(),
                                     'The answer window never opened')
                    for pcm in [ANSWER_SPEECH] * 3 + [ANSWER_QUIET] * 40:
                        transport.capture_pcm(pcm)
                    with self.assertRaises(RuntimeError):
                        await asyncio.wait_for(hearing, 5)
                self.assertEqual(analyser.call_args.kwargs['params'].confidence, 0.5)
                failure.assert_awaited_once()
                self.assertEqual(answer_frames(failure.await_args.args[0]), ANSWER_SPEECH * 3 + ANSWER_QUIET * 40)
                self.assertIsNone(transport.capture_pcm)
                self.assertIsNone(manager.typed_answer)
                vad.cleanup.assert_awaited_once()

    async def test_answer_window_time_limit_covers_its_frame_bounds(self):
        from types import SimpleNamespace
        real_timeout, limits = asyncio.timeout, []

        def recording_timeout(seconds):
            limits.append(seconds)
            return real_timeout(seconds)

        transport, vad, decisions = SimpleNamespace(capture_pcm=None), answer_vad(), []
        # Only the window's own time limit is recorded: the patch ends once the window is open, before wait_until sets its own.
        with patch.object(speech.asyncio, 'timeout', recording_timeout):
            window = asyncio.create_task(speech.capture_answer(
                transport, vad, admitted=lambda: True, decided=lambda: decisions.append(len(vad.analysed))))
            await asyncio.sleep(0)
        self.assertEqual(len(limits), 1, 'The answer window must set exactly one time limit')
        # The longest run: speech on the last waiting frame, then speech through the limit and the whole discard bound.
        wait, limit = (round(seconds / speech.ANSWER_FRAME_SECONDS)
                       for seconds in (speech.ANSWER_WAIT_SECONDS, speech.ANSWER_LIMIT_SECONDS))
        worst_case = (wait + limit + limit) * speech.ANSWER_FRAME_SECONDS
        self.assertGreaterEqual(limits[0], worst_case, 'The time limit would end a worst-case answer before its frame bounds')
        for pcm in [ANSWER_QUIET] * (wait - 1) + [ANSWER_SPEECH] * (1 + limit + limit):
            transport.capture_pcm(pcm)
        wav, cut_off = await asyncio.wait_for(window, 5)
        self.assertTrue(cut_off)
        self.assertEqual(decisions, [wait + limit], 'The cut-off is decided before any of the thrown-away tail is read')
        self.assertEqual(len(vad.analysed), wait + limit + limit)
        self.assertIsNone(transport.capture_pcm)


if __name__ == '__main__':
    unittest.main()
