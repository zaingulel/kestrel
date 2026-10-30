import unittest
from unittest.mock import patch

import numpy as np
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

import bot


# Owner-reported missed first Hi: 120 native 16 kHz confidence/volume pairs.
# Original grouping: 608 bytes, then 192 calls of 640 bytes; no audio retained.
MEASURED_FIRST_HI_SCORES = (
    (0.035760074853897095, 0.0),
    (0.042612940073013306, 0.0),
    (0.015511929988861084, 0.0),
    (0.007798254489898682, 0.0),
    (0.0035187900066375732, 0.0),
    (0.0022649765014648438, 0.0),
    (0.001963675022125244, 0.0),
    (0.002105116844177246, 0.0),
    (0.002015054225921631, 0.0),
    (0.0016650557518005371, 0.0),
    (0.0014693140983581543, 0.0),
    (0.0017132759094238281, 0.0),
    (0.001630246639251709, 0.0),
    (0.0014463961124420166, 0.0),
    (0.0014960169792175293, 0.0),
    (0.0015066266059875488, 0.0),
    (0.0015057623386383057, 0.0),
    (0.0013019144535064697, 0.0),
    (0.0014729797840118408, 0.0),
    (0.0016672313213348389, 0.0),
    (0.001694321632385254, 0.0),
    (0.0019553005695343018, 0.0),
    (0.002029716968536377, 0.0),
    (0.0018465220928192139, 0.0),
    (0.0016760528087615967, 0.0),
    (0.0018802285194396973, 0.0),
    (0.0017756521701812744, 0.0),
    (0.0016661584377288818, 0.0),
    (0.001847296953201294, 0.0),
    (0.002141594886779785, 0.0),
    (0.0023184120655059814, 0.0),
    (0.002285301685333252, 0.0),
    (0.001959860324859619, 0.0),
    (0.0018923580646514893, 0.0),
    (0.0019429028034210205, 0.0),
    (0.0019373297691345215, 0.0),
    (0.0017479956150054932, 0.0),
    (0.0017497539520263672, 0.0),
    (0.0017401576042175293, 0.0),
    (0.0016838908195495605, 0.0),
    (0.002042055130004883, 0.0),
    (0.0026062726974487305, 0.0),
    (0.0031073391437530518, 0.0),
    (0.002686738967895508, 0.0),
    (0.00195467472076416, 0.0),
    (0.0020296573638916016, 0.0),
    (0.0023779571056365967, 0.0),
    (0.0041973888874053955, 0.0),
    (0.00376051664352417, 0.0),
    (0.002471715211868286, 0.0),
    (0.006078243255615234, 0.0),
    (0.0034498274326324463, 0.0),
    (0.0025340616703033447, 0.0),
    (0.0023952722549438477, 0.0),
    (0.002611815929412842, 0.0),
    (0.0022572875022888184, 0.0),
    (0.0022135674953460693, 0.0),
    (0.002370983362197876, 0.0),
    (0.002327054738998413, 0.0),
    (0.0022734403610229492, 0.0),
    (0.0028052330017089844, 0.0),
    (0.004387080669403076, 0.0),
    (0.009391814470291138, 0.0),
    (0.0062309205532073975, 0.0),
    (0.0035817325115203857, 0.0),
    (0.0025302469730377197, 0.0),
    (0.002326756715774536, 0.0),
    (0.002389371395111084, 0.0),
    (0.002673536539077759, 0.0),
    (0.0025735199451446533, 0.0),
    (0.0026831328868865967, 0.0),
    (0.0027323663234710693, 0.0),
    (0.0022645890712738037, 0.0),
    (0.0020789802074432373, 0.0),
    (0.0022986233234405518, 0.0),
    (0.002722442150115967, 0.0),
    (0.004207879304885864, 0.0),
    (0.0038622617721557617, 0.0),
    (0.0033617615699768066, 0.0),
    (0.011775791645050049, 0.0),
    (0.00656282901763916, 0.0),
    (0.004483073949813843, 0.0),
    (0.003920257091522217, 0.0),
    (0.005175530910491943, 0.0),
    (0.004033148288726807, 0.0),
    (0.0031639933586120605, 0.0),
    (0.0031841695308685303, 0.0),
    (0.021679610013961792, 0.0),
    (0.5163999795913696, 0.1417),
    (0.8240758180618286, 0.27426),
    (0.8167110681533813, 0.386508),
    (0.8132230043411255, 0.4783064),
    (0.7796355485916138, 0.55334512),
    (0.7537122964859009, 0.614976096),
    (0.7427810430526733, 0.6646808768),
    (0.7743226289749146, 0.7044447014399999),
    (0.7462644577026367, 0.736455761152),
    (0.648710310459137, 0.7620646089216),
    (0.5401208400726318, 0.78255168713728),
    (0.33245888352394104, 0.798941349709824),
    (0.1715717315673828, 0.8120530797678592),
    (0.09255599975585938, 0.8213424638142874),
    (0.05153355002403259, 0.82497397105143),
    (0.03331121802330017, 0.824879176841144),
    (0.024947047233581543, 0.8218033414729152),
    (0.019566744565963745, 0.8121426731783322),
    (0.01666972041130066, 0.7944141385426657),
    (0.014286190271377563, 0.7692313108341325),
    (0.014123111963272095, 0.738285048667306),
    (0.011937946081161499, 0.7035280389338449),
    (0.011484354734420776, 0.6583224311470759),
    (0.011275827884674072, 0.5266579449176607),
    (0.010425686836242676, 0.4213263559341286),
    (0.009507685899734497, 0.3370610847473029),
    (0.00925135612487793, 0.2696488677978423),
    (0.009106159210205078, 0.21571909423827385),
    (0.008544832468032837, 0.17257527539061907),
    (0.008592069149017334, 0.13806022031249526),
    (0.035856425762176514, 0.11044817624999621),
    (0.0331246554851532, 0.08835854099999697),
)


class GreetingAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def configured_analyzer(self):
        analyzer = None

        class AnalyzerSelected(Exception):
            pass

        def capture(context, *, params, input_paused):
            nonlocal analyzer
            analyzer = params.vad_analyzer
            raise AnalyzerSelected()

        with patch.object(bot, 'ConversationUserAggregator', side_effect=capture):
            with self.assertRaises(AnalyzerSelected):
                await bot.run_conversation(None, None, llm=object(), transport=object(), on_frame_completed=None, typed_origin=None)
        return analyzer

    async def test_measured_first_short_greeting_is_admitted_once(self):
        analyzer = await self.configured_analyzer()
        try:
            analyzer.set_sample_rate(16000)
            confidence_scores = iter(pair[0] for pair in MEASURED_FIRST_HI_SCORES)
            volume_scores = iter(pair[1] for pair in MEASURED_FIRST_HI_SCORES)
            episodes = 0
            previous = VADState.QUIET
            with (
                patch.object(analyzer, 'voice_confidence', side_effect=lambda buffer: np.array(
                    [next(confidence_scores)], dtype=np.float32,
                )) as confidence,
                patch.object(analyzer, '_get_smoothed_volume', side_effect=lambda audio: next(
                    volume_scores,
                )) as volume,
            ):
                for index, byte_count in enumerate([608] + [640] * 192):
                    state = analyzer._run_analyzer(bytes(byte_count))
                    if index < 50:
                        self.assertNotEqual(state, VADState.SPEAKING)
                    if state == VADState.SPEAKING and previous in (VADState.QUIET, VADState.STARTING):
                        episodes += 1
                    previous = state
            self.assertEqual(confidence.call_count, 120)
            self.assertEqual(volume.call_count, 120)
            with self.assertRaises(StopIteration):
                next(confidence_scores)
            with self.assertRaises(StopIteration):
                next(volume_scores)
            self.assertEqual(episodes, 1)
            self.assertEqual(state, VADState.QUIET)
        finally:
            await analyzer.cleanup()

    async def test_brief_or_quiet_sound_does_not_start_speech(self):
        for label, confidence_score, volume_score, windows in [
            ('brief', 1.0, 1.0, 5),
            ('quiet', 1.0, 0.59, 8),
            ('low_confidence', 0.49, 1.0, 8),
        ]:
            with self.subTest(label=label):
                analyzer = await self.configured_analyzer()
                try:
                    analyzer.set_sample_rate(16000)
                    confidence_scores = iter([confidence_score] * windows + [0.0] * 8)
                    volume_scores = iter([volume_score] * windows + [0.0] * 8)
                    with (
                        patch.object(analyzer, 'voice_confidence', side_effect=lambda buffer: np.array(
                            [next(confidence_scores)], dtype=np.float32,
                        )),
                        patch.object(analyzer, '_get_smoothed_volume', side_effect=lambda audio: next(
                            volume_scores,
                        )),
                    ):
                        for _ in range(windows + 8):
                            state = analyzer._run_analyzer(bytes(1024))
                            self.assertNotEqual(state, VADState.SPEAKING)
                    self.assertEqual(state, VADState.QUIET)
                finally:
                    await analyzer.cleanup()


class TurnFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_uncertain_turn_uses_600ms_fallback_and_keeps_semantic_completion(self):
        class SelectionCaptured(Exception):
            pass

        captured = []
        vad_analyzers = []
        original_post_init = UserTurnStrategies.__post_init__
        original_vad = bot.SileroVADAnalyzer

        def capture_selection(strategies):
            original_post_init(strategies)
            captured.append(strategies)
            raise SelectionCaptured

        def capture_vad(*args, **kwargs):
            analyzer = original_vad(*args, **kwargs)
            vad_analyzers.append(analyzer)
            return analyzer

        try:
            with patch.object(UserTurnStrategies, '__post_init__', capture_selection), \
                    patch.object(bot, 'SileroVADAnalyzer', capture_vad):
                with self.assertRaises(SelectionCaptured):
                    await bot.run_conversation(None, None, llm=object(), transport=object(), on_frame_completed=None, typed_origin=None)
            self.assertEqual(len(captured), 1)
            strategies = captured[0]
            self.assertEqual([type(strategy) for strategy in strategies.stop],
                             [TurnAnalyzerUserTurnStopStrategy, bot.TypedTurnStopStrategy])
            self.assertIsInstance(strategies.stop[0], TurnAnalyzerUserTurnStopStrategy)
            self.assertEqual(
                [type(strategy) for strategy in strategies.start],
                [VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy],
            )
            analyzer = strategies.stop[0]._turn_analyzer
            analyzer.set_sample_rate(16000)
            # 320 PCM16 samples at 16 kHz are 20 ms per chunk.
            chunk = bytes(640)
            predictions = [
                {'prediction': 0, 'probability': 0.0},
                {'prediction': 1, 'probability': 1.0},
            ]
            with patch.object(analyzer, '_predict_endpoint', side_effect=predictions) as predict:
                for _ in range(2):
                    analyzer.append_audio(chunk, is_speech=True)
                state, _ = await analyzer.analyze_end_of_turn()
                self.assertEqual(state, EndOfTurnState.INCOMPLETE)
                for _ in range(29):
                    self.assertEqual(
                        analyzer.append_audio(chunk, is_speech=False), EndOfTurnState.INCOMPLETE,
                    )
                self.assertEqual(
                    analyzer.append_audio(chunk, is_speech=False), EndOfTurnState.COMPLETE,
                )
                self.assertFalse(analyzer.speech_triggered)
                for _ in range(2):
                    analyzer.append_audio(chunk, is_speech=True)
                self.assertEqual(
                    analyzer.append_audio(chunk, is_speech=False), EndOfTurnState.INCOMPLETE,
                )
                state, _ = await analyzer.analyze_end_of_turn()
                self.assertEqual(state, EndOfTurnState.COMPLETE)
                self.assertEqual(predict.call_count, 2)
        finally:
            try:
                for strategies in captured:
                    for strategy in strategies.start + strategies.stop:
                        await strategy.cleanup()
            finally:
                for analyzer in vad_analyzers:
                    await analyzer.cleanup()


if __name__ == '__main__':
    unittest.main()
