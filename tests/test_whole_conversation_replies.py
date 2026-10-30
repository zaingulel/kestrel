import asyncio
from copy import deepcopy
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import numpy as np
from pipecat.frames.frames import DataFrame, ProposedUserStartedSpeakingFrame

import bot
from conversation_fixtures import WholeConversationCase
import reply_progress
import speech
from test_hermes import ScriptedBrain


class WholeConversationTests(WholeConversationCase):
    async def test_missing_engine_waits_for_user_then_speaks_failure(self):
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, _ = await self.open_session(None)
            self.assertTrue(spoken.empty(), 'Startup failure must not make Kestrel speak first')
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Hello unavailable engine.')
            failure = await asyncio.wait_for(spoken.get(), 5)
            self.assertIn("couldn't reach Kestrel's engine", failure)
            self.assertIn('Restart Kestrel', await asyncio.wait_for(spoken.get(), 5))
            self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(committed.get(), 5))
            self.assertEqual(len(processes), 1)
            self.assertIsNone(processes[0][0])

    async def test_dead_native_engine_speaks_failure(self):
        brain = ScriptedBrain([])
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        process, _ = processes[0]
        process.kill()
        await process.wait()
        await self.assert_failed_reply(transport, spoken, committed, 'Is anyone there?',
                                         expected_advisory="I couldn't reach Kestrel's engine. Restart Kestrel and try again.")
        self.assertEqual(brain.requests, [])

    async def test_brain_refusal_speaks_failure_without_retry(self):
        brain = ScriptedBrain([400])
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        generated, records = [], []

        @transport.llm.event_handler('on_before_push_frame')
        async def collect_generated(processor, frame):
            if isinstance(frame, reply_progress.REPLY_MESSAGES):
                generated.append(self.as_pushed(frame))
                if isinstance(frame, bot.LLMFullResponseStartFrame):
                    records.append(transport.llm.current_reply())

        await self.assert_failed_reply(transport, spoken, committed, 'Answer this synthetic request.',
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertIsNotNone(processes[0][0].returncode)
        await self.assert_failed_reply(transport, spoken, committed, 'Try another request.',
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertEqual(len(brain.requests), 1, 'Broken sessions never silently restart or retry')
        self.assertEqual(len(records), 2)
        self.assertIsNot(records[0], records[1])
        for interval in self.reply_intervals(generated, records):
            self.assertTrue(any(isinstance(frame, speech.SpeechAdvisoryFrame) for frame, _ in interval))

    async def test_partial_native_reply_speaks_failure(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nIncomplete synthetic reply.'}, None), ({}, 'length')]] * 4)
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        await asyncio.shield(transport.service.manager.session_ready)
        context = await self.assert_failed_reply(transport, spoken, committed, 'Answer completely.',
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertIn('Incomplete synthetic reply.', context)
        self.assertIsNotNone(processes[0][0].returncode)

    async def test_corrupt_worker_response_speaks_failure(self):
        # External process stand-ins cover malformed JSON and wrongly typed terminal events.
        cases = [
            ('malformed JSON', '{"ready":true}', 'not json'),
            ('wrong done type', '{"ready":true}', '{"delivery":"neutral"}\n{"text":"Synthetic prefix."}\n{"done":1}'),
            ('malformed incomplete', '{"ready":true}', '{"delivery":"neutral"}\n{"text":"Synthetic prefix."}\n{"incomplete":1}'),
            ('wrong ready type', '{"ready":1}', ''),
        ]
        for name, ready, response in cases:
            with self.subTest(name=name):
                wire = f'import json, sys; print({ready!r}, flush=True); '
                if name != 'wrong ready type':
                    wire += ("assert json.loads(sys.stdin.readline()) == {'begin': True}; "
                             "print('{\"session_ready\":true}', flush=True); ")
                wire += f'sys.stdin.readline(); print({response!r}, flush=True); sys.stdin.read()'
                transport, spoken, committed, _, processes, close = await self.open_session(
                    None, wire=wire, startup='trouble-engine' if name == 'wrong ready type' else 'inactive',
                )
                try:
                    self.assertTrue(spoken.empty(), 'Even corrupt startup must not speak first')
                    if name == 'wrong ready type':
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'Answer over the wire.')
                        self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(committed.get(), 5))
                        self.assertIn("couldn't reach Kestrel's engine", await asyncio.wait_for(spoken.get(), 5))
                    else:
                        await self.assert_failed_reply(transport, spoken, committed, 'Answer over the wire.',
                                             expected_advisory="I couldn't reach Kestrel's engine. Restart Kestrel and try again.")
                    self.assertIsNotNone(processes[0][0].returncode)
                finally:
                    await close()

    async def test_interrupted_partial_failure_is_reported_before_next_answer(self):
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def partial_reply():
            yield {'content': '[delivery:neutral]\nOne fact. Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted partial reply was never released')
            yield {}, 'length'
            finished.set()

        brain = ScriptedBrain([partial_reply()] + [[({'content': '[delivery:neutral]\nUnheard tail.'}, None), ({}, 'length')]] * 3)
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
                self.open_session(None, wire='import sys; sys.stdin.read()', startup='trouble-engine'), 5,
            )
            self.assertTrue(spoken.empty(), 'A hung startup must not speak first')
            await self.assert_failed_reply(
                transport, spoken, committed, 'Hello hung engine.',
                expected_advisory="I couldn't reach Kestrel's engine. Restart Kestrel and try again.",
            )
            process, home = processes[0]
            self.assertIsNotNone(process.returncode)
            await close()
            self.assertFalse(home.exists())

    async def test_engine_turn_timeout_speaks_failure_and_reaps_worker(self):
        for interrupt, deep in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(interrupted=interrupt, deep=deep), patch.object(bot, 'TURN_TIMEOUT', 1):
                wire = ("import json, sys; print('{\"ready\":true}', flush=True); "
                        "assert json.loads(sys.stdin.readline()) == {'begin': True}; "
                        "print('{\"session_ready\":true}', flush=True); sys.stdin.readline(); "
                        + ("print('{\"delivery\":\"neutral\"}', flush=True); print('{\"text\":\"One fact. Unheard continuation\"}', flush=True); " if interrupt else '')
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
                        transport, spoken, committed, ('Think more deeply about the hung answer.' if deep
                                                       else 'Answer while the engine is hung.'),
                        expected_advisory="I couldn't reach Kestrel's engine. Restart Kestrel and try again.",
                    )
                    self.assertNotIn('Unheard continuation', context)
                    self.assertIsNotNone(process.returncode)
                finally:
                    await close()
                self.assertFalse(home.exists())

    async def test_cleanup_preserves_spoken_history_and_streaming(self):
        blocked, release, finished = threading.Event(), threading.Event(), threading.Event()

        def held_reply():
            yield {'content': '[delivery:neutral]\nOne fact. Obsolete continuation `Hidden. More.'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted cleanup reply was never released')
            yield {}, 'stop'
            finished.set()

        completed = [
            ('Plain turn.', 'Hello. I am listening.', 'Hello. I am listening.'),
            ('Formatted turn.', '# **Steps**\n- Read [the guide](https://example.com/private).\n- Use `secret()` now.',
             'Steps. Read the guide. Use now. There is code in this reply.'),
            ('Unclosed turn.', 'Before. `Hidden. More.', 'Before. There is code in this reply.'),
        ]
        brain = ScriptedBrain([
            *[[({'content': '[delivery:neutral]\n' + raw}, None), ({}, 'stop')] for _, raw, _ in completed],
            held_reply(), [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        transport, spoken, committed, interrupted, processes, close = await self.open_session(brain)
        history = []
        expected_histories = []

        async def hear(expected):
            parts = []
            while ' '.join(parts) != expected:
                parts.append(await asyncio.wait_for(spoken.get(), 5))
                self.assertTrue(expected.startswith(' '.join(parts)), parts)
            self.assertEqual(' '.join(parts), expected)

        for user, _, expected in completed:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, user)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), expected)
            await hear(expected)
            expected_histories.append([*history, ('user', user)])
            history.extend([('user', user), ('assistant', expected)])
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Held turn.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        self.assertFalse(release.is_set(), 'First speech must precede provider completion')
        interrupted.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
        self.assertTrue(spoken.empty())
        expected_histories.append([*history, ('user', 'Held turn.')])
        history.extend([('user', 'Held turn.'), ('assistant', 'One fact.')])
        self.assertIsNone(processes[0][0].returncode)
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        await self.finish_user_turn(transport, 'Fresh turn.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
        await hear('Fresh reply.')
        expected_histories.append([*history, ('user', 'Fresh turn.')])
        histories = [[(m['role'], m['content'].strip()) for m in request[2]['messages']
                      if m['role'] != 'system'] for request in brain.requests]
        self.assertEqual(histories, expected_histories)
        self.assertTrue(spoken.empty())
        self.assertEqual(len(processes), 1)
        await close()

    async def test_unclosed_code_cannot_hide_engine_failure(self):
        response = '{"delivery":"neutral"}\n{"text":"```python\\nHidden. More."}\n{"done":1}'
        wire = ('import json, sys; print(\'{"ready":true}\', flush=True); '
                "assert json.loads(sys.stdin.readline()) == {'begin': True}; "
                "print('{\"session_ready\":true}', flush=True); sys.stdin.readline(); "
                f'print({response!r}, flush=True); sys.stdin.read()')
        transport, spoken, committed, _, processes, close = await self.open_session(None, wire=wire)
        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Answer over the wire.')
            expected = ("There is code in this reply. I couldn't reach Kestrel's engine. "
                        "Restart Kestrel and try again.")
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), expected)
            heard = []
            while ' '.join(heard) != expected:
                heard.append(await asyncio.wait_for(spoken.get(), 5))
                self.assertTrue(expected.startswith(' '.join(heard)), heard)
            self.assertTrue(spoken.empty())
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0][0].returncode)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'repeat that')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty(), 'Failure replay must not add duplicate context')
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0][0].returncode)
        finally:
            await close()

    async def test_interruption_before_first_commit_preserves_user_turns(self):
        synthesis_pending = asyncio.Event()
        release = asyncio.Event()
        stream_closed = asyncio.Event()
        self.addCleanup(release.set)
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nRain forms when water vapour cools.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBlue.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        native_tts = bot.VoxCPMTTS
        worker_requests = []

        def create_tts(voice, preset, *, generation_lock=None, admission=None):
            tts = native_tts(voice, preset, generation_lock=generation_lock, admission=admission)
            native_run_tts = tts.run_tts
            first_stream = True

            async def gated_tts(text, context_id):
                nonlocal first_stream
                hold = first_stream and context_id != 'warmup'
                if context_id != 'warmup':
                    first_stream = False
                stream = native_run_tts(text, context_id)
                try:
                    async for frame in stream:
                        yield frame
                        if hold:
                            synthesis_pending.set()
                            await release.wait()
                finally:
                    await stream.aclose()
                    if hold:
                        stream_closed.set()

            tts.run_tts = gated_tts
            return tts

        close = None
        try:
            with patch.object(bot, 'VoxCPMTTS', create_tts):
                transport, spoken, committed, interrupted, processes, close = await self.open_session(
                    brain, local_command=AsyncMock(side_effect=AssertionError('No desktop commands expected')),
                )
                native_exchange = transport.llm.channel.exchange

                async def capture_exchange(messages, output, *, admitted, desktop=None):
                    worker_requests.append(deepcopy(messages))
                    return await native_exchange(messages, output, admitted=admitted, desktop=desktop)

                with patch.object(transport.llm.channel, 'exchange', capture_exchange):
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'Explain how rain forms in five sentences.')
                    await asyncio.wait_for(synthesis_pending.wait(), 5)
                    self.assertTrue(committed.empty())
                    self.assertTrue(spoken.empty())
                    self.assertIsNone(transport.llm.last_spoken_reply)
                    self.assertFalse(release.is_set())
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await asyncio.wait_for(stream_closed.wait(), 5)
                    self.assertTrue(committed.empty())
                    self.assertTrue(spoken.empty())
                    self.assertIsNone(transport.llm.last_spoken_reply)
                    self.assertFalse(release.is_set(), 'Interruption closes synthesis without releasing its gate')
                    await self.finish_user_turn(transport, 'Tell me one colour instead.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Blue.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Blue.')
                    self.assertTrue(committed.empty())
                    self.assertTrue(spoken.empty())
                    self.assertEqual(worker_requests, [
                        [{'role': 'user', 'content': 'Explain how rain forms in five sentences.'}],
                        [{'role': 'user', 'content': 'Explain how rain forms in five sentences.'},
                         {'role': 'user', 'content': 'Tell me one colour instead.'}],
                    ])
                    self.assertEqual(len(brain.requests), 2)
                    await close()
                    self.assertIsNotNone(processes[0][0].returncode)
                    self.assertFalse(processes[0][1].exists())
                    self.assertEqual([m for m in brain.requests[1][2]['messages'] if m['role'] != 'system'], [
                        {'role': 'user', 'content': 'Explain how rain forms in five sentences.'},
                        {'role': 'user', 'content': 'Tell me one colour instead.'},
                    ], 'Replacement request must remain distinct from the unanswered rain request')
        finally:
            release.set()
            if close is not None:
                await close()

    async def test_conversation_preserves_context_and_interrupts_reply(self):
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def second_reply():
            yield {'content': '[delivery:reassuring]\nOne fact. [deliv'}, None
            yield {'content': 'ery:unknown] Obsolete continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted reply was never released')
            yield {'content': ' must not be spoken.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([
            [({'content': '[delivery:curious]\nHello.'}, None), ({}, 'stop')], second_reply(),
            [({'content': '[delivery:neutral]\nNext step.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFresh session.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        synthesis = []
        def finite_chunks(**kwargs):
            synthesis.append(kwargs)
            self.assertEqual(kwargs['reference_wav_path'], '/fixture/british-male.wav')
            if kwargs['text'].startswith(('(Subtly curious', '(Warm, gentle')):
                self.assertNotIn('prompt_wav_path', kwargs)
                self.assertNotIn('prompt_text', kwargs)
            else:
                self.assertEqual(kwargs['prompt_wav_path'], '/fixture/british-male.wav')
                self.assertEqual(kwargs['prompt_text'], 'British fixture.')
            yield np.zeros(4800, dtype=np.float32)

        transport, spoken, committed, interrupted, processes, close = await self.open_session(
            brain, synthesis_chunks=finite_chunks)

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
        await self.finish_user_turn(transport, 'repeat that')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(len(brain.requests), 2)
        self.assertTrue(committed.empty(), 'Replay must not commit an assistant duplicate')
        self.assertTrue(spoken.empty(), 'The unheard continuation cannot be replayed')
        self.assertFalse(finished.is_set(), 'Replay finishes before interrupted provider drainage')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
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
        transport, spoken, committed, _, _, _ = await self.open_session(brain, synthesis_chunks=finite_chunks)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'A new conversation.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh session.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh session.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'A new conversation.'}])
        self.assertTrue(all('[delivery:' not in call['text'] for call in synthesis))
        self.assertEqual([call['text'] for call in synthesis
                          if not call['text'].endswith(' Obsolete continuation')], [
            '(Subtly curious and interested, natural conversational delivery) Hello.',
            '(Warm, gentle and reassuring, speaking calmly) One fact.',
            'One fact.', 'Next step.', 'Fresh session.',
        ])


if __name__ == '__main__':
    unittest.main()
