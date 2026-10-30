import asyncio
from copy import deepcopy
import json
import os
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, DataFrame, LLMFullResponseEndFrame, LLMTextFrame,
    InterruptionFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame, TTSAudioRawFrame, TTSStartedFrame,
    TTSStoppedFrame, TTSTextFrame,
)

import bot
from conversation_fixtures import WholeConversationCase
import reply_progress
import speech
from test_hermes import ScriptedBrain


class WholeConversationFixtureTests(unittest.TestCase):
    def test_startup_failure_restores_runtime(self):
        for method in (
            'test_missing_delivery_header_allows_next_turn',
            'test_stop_accounts_for_confirmed_effect_after_empty_synthesis',
            'test_panel_reveals_chunk_on_first_successful_output',
            'test_panel_attributes_each_synthesis_to_delivered_audio',
            'test_panel_receives_final_turns_and_spoken_prefix',
            'test_panel_marks_empty_or_failed_synthesis',
            'test_capped_native_turn_fails_alone_and_conversation_continues',
        ):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
                result = unittest.TestResult()
                result.failfast = True
                with patch(f'{__name__}.ScriptedBrain', autospec=True) as brain, \
                        patch('conversation_fixtures.require_native_hermes'), \
                        patch('speech.NemotronRecognizer', side_effect=RuntimeError('fixture-startup-canary')) as recognizer:
                    brain.return_value.close = Mock()
                    WholeConversationTests(method).run(result)
                self.assertEqual(result.testsRun, 1)
                self.assertEqual(result.skipped, [])
                self.assertEqual(result.failures, [])
                self.assertEqual(len(result.errors), 1)
                self.assertIn('RuntimeError: fixture-startup-canary', result.errors[0][1])
                recognizer.assert_called_once_with()
                brain.return_value.close.assert_called_once_with()
                self.assertEqual(os.environ['XDG_RUNTIME_DIR'], runtime)
                self.assertTrue(Path(runtime).is_dir())


class WholeConversationTests(WholeConversationCase):
    async def test_stop_accounts_for_confirmed_effect_after_empty_synthesis(self):
        from desktop import conversation
        brain = ScriptedBrain([
            [({'tool_calls': [{'index': 0, 'id': 'mute-first', 'type': 'function', 'function': {
                'name': 'mute', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Muted.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])

        def chunks(**kwargs):
            if kwargs['text'] != 'Muted.':
                yield np.zeros(4800, dtype=np.float32)

        transport, spoken, _, interrupted, _, close = await self.open_session(
            brain, local_command=command, synthesis_chunks=chunks,
        )
        address = conversation.address()
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 5)

        async def rows_until(predicate):
            async with asyncio.timeout(5):
                while True:
                    snapshot = json.loads(await reader.readline())
                    if 'turns' in snapshot and predicate(snapshot['turns']):
                        return snapshot['turns']

        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please silence the sound.')
            # The text frame reaches output without audio; the failed row is the delivery oracle.
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muted.')
            rows = await rows_until(lambda rows: rows and rows[-1]['speaker'] == 'kestrel'
                                    and rows[-1]['state'] == 'failed')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': '', 'state': 'failed'})
            self.assertEqual(transport.output().audio_written, 0)
            self.assertEqual([c for c in command.await_args_list if 'set-sink-mute' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))])
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, 'stop')
            account = "Stopped. Done: mute. I won't undo anything."
            rows = await rows_until(lambda rows: rows and rows[-1].get('text') == account
                                    and rows[-1]['state'] == 'complete')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': account, 'state': 'complete'})
            self.assertEqual(transport.llm.outcomes, [])
            self.assertEqual(len(brain.requests), 2)
        finally:
            writer.close()
            await writer.wait_closed()
            await close()

    async def test_panel_reveals_chunk_on_first_successful_output(self):
        from desktop import conversation
        loop = asyncio.get_running_loop()
        release_generation = threading.Event()
        generation_held = asyncio.Event()
        release_second, release_future = asyncio.Event(), asyncio.Event()
        for release in (release_generation, release_second, release_future):
            self.addCleanup(release.set)
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nStarting chunk. Future chunk.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nEmpty chunk.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFailed output.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)

        def chunks(**kwargs):
            text = kwargs['text']
            yield np.zeros(0, dtype=np.float32)
            if text == 'Empty chunk.':
                return
            yield np.full(1920, 0.5, dtype=np.float32)
            if text == 'Starting chunk.':
                loop.call_soon_threadsafe(generation_held.set)
                if not release_generation.wait(45):
                    raise AssertionError('Synthetic chunk generation was never released')
                yield np.full(1920, 0.5, dtype=np.float32)

        transport, _, _, interrupted, _, close = await self.open_session(
            brain, through_service=True, synthesis_chunks=chunks,
        )
        output = transport.output()
        write = output.write_audio_frame
        delivered, second_write, future_write, ended = (asyncio.Event() for _ in range(4))
        written, texts = [], []
        current_reply = None
        fail_output = False

        @output.event_handler('on_after_push_frame')
        async def observe(processor, frame):
            nonlocal current_reply
            if isinstance(frame, TTSStartedFrame):
                current_reply = frame.reply_progress
            elif isinstance(frame, TTSAudioRawFrame) and frame.audio:
                delivered.set()
            elif isinstance(frame, TTSTextFrame):
                texts.append(frame.text)
            elif isinstance(frame, LLMFullResponseEndFrame):
                ended.set()

        async def controlled_write(frame):
            if fail_output:
                current_reply.output_write_failed()
                output.output_buffer.write_failed(frame)
                return False
            if len(written) == 1:
                second_write.set()
                await release_second.wait()
            elif len(written) == 2:
                future_write.set()
                await release_future.wait()
            success = await write(frame)
            if success:
                written.append(frame.audio)
            return success

        output.write_audio_frame = controlled_write
        address = conversation.address()

        async def snapshot():
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)
            try:
                return json.loads(await asyncio.wait_for(reader.readline(), 1))['turns']
            finally:
                peer = transport.llm.conversation.reader_task
                writer.close()
                await writer.wait_closed()
                if peer is not None:
                    await asyncio.wait_for(peer, 1)

        async def start(text):
            interrupted.clear()
            ended.clear()
            output.generation_done.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, text)

        try:
            await asyncio.shield(transport.service.manager.session_ready)
            await start('Show chunks as they start.')
            await asyncio.wait_for(delivered.wait(), 5)
            await asyncio.wait_for(generation_held.wait(), 5)
            rows = await snapshot()
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Starting chunk.', 'state': 'speaking'})
            self.assertEqual(texts, [])
            self.assertFalse(output.generation_done.is_set())
            self.assertEqual(written, [b'\xff\x3f' * 1920])

            release_generation.set()
            await asyncio.wait_for(second_write.wait(), 5)
            await asyncio.wait_for(output.generation_done.wait(), 5)
            self.assertEqual((await snapshot())[-1]['text'], 'Starting chunk.')
            release_second.set()
            await asyncio.wait_for(future_write.wait(), 5)
            self.assertEqual((await snapshot())[-1]['text'], 'Starting chunk.')
            self.assertEqual(written, [b'\xff\x3f' * 1920] * 2)
            release_future.set()
            await asyncio.wait_for(ended.wait(), 5)
            self.assertEqual((await snapshot())[-1], {
                'speaker': 'kestrel', 'text': 'Starting chunk. Future chunk.', 'state': 'complete',
            })
            self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)

            for prompt, failed in (('No output.', False), ('Reject output.', True)):
                with self.subTest(failed_output=failed):
                    written.clear()
                    fail_output = failed
                    await start(prompt)
                    await asyncio.wait_for(ended.wait(), 5)
                    self.assertEqual((await snapshot())[-1], {'speaker': 'kestrel', 'text': '', 'state': 'failed'})
                    self.assertEqual(written, [])
        finally:
            release_generation.set()
            release_second.set()
            release_future.set()
            await close()

    async def test_panel_attributes_each_synthesis_to_delivered_audio(self):
        from desktop import conversation
        stale_failure = None
        # The healthy scenario consumes the failure receipt from this prior closed session.
        for scenario in (
            'Failure before synthesis audio.',
            'Audible segment after synthesis failure.',
            'Partial synthesis failure.',
            'Interrupted synthesis failure.',
            'Delayed synthesis failure.',
            'Recreated synthesis context failure.',
            'Healthy synthesis.',
        ):
            with self.subTest(scenario=scenario):
                loop = asyncio.get_running_loop()
                release_failure, release_provider = threading.Event(), threading.Event()
                native_failure = threading.Event()
                release_write = asyncio.Event()
                for release in (release_failure, release_provider, release_write):
                    self.addCleanup(release.set)
                provider_paused = asyncio.Event()
                context_started, context_stopped, context_retired = asyncio.Event(), asyncio.Event(), asyncio.Event()
                started_contexts, stopped_contexts, retired_contexts = [], [], []
                native_completed = speech.VoxCPMTTS.on_audio_context_completed

                async def observe_completed(voice, context_id):
                    await native_completed(voice, context_id)
                    retired_contexts.append(context_id)
                    context_retired.set()

                retirement = patch.object(speech.VoxCPMTTS, 'on_audio_context_completed', observe_completed)

                def recreated():
                    yield {'content': '[delivery:neutral]\nSpoken first. Failed recreated'}, None
                    loop.call_soon_threadsafe(provider_paused.set)
                    if not release_provider.wait(45):
                        raise AssertionError('Synthetic provider context was never released')
                    yield {'content': ' context.'}, None
                    yield {}, 'stop'

                if scenario == 'Failure before synthesis audio.':
                    replies = [[({'content': '[delivery:neutral]\nSpoken first. Failed before audio.'}, None), ({}, 'stop')]]
                elif scenario == 'Audible segment after synthesis failure.':
                    replies = [[({'content': '[delivery:neutral]\nBoundary first. Failed after audio. B'}, None),
                                ({'content': 'oundary second.'}, None), ({}, 'stop')]]
                elif scenario in ('Partial synthesis failure.', 'Interrupted synthesis failure.'):
                    replies = [[({'content': '[delivery:neutral]\nBoundary first. Failed after audio. U'}, None),
                                ({'content': 'nheard second.'}, None), ({}, 'stop')]]
                elif scenario == 'Delayed synthesis failure.':
                    replies = [[({'content': '[delivery:neutral]\nSpoken first. Failed after stop.'}, None), ({}, 'stop')]]
                elif scenario == 'Recreated synthesis context failure.':
                    replies = [recreated()]
                else:
                    replies = [
                        [({'content': '[delivery:neutral]\nSpoken first. Unheard second.'}, None), ({}, 'stop')],
                        [({'content': '[delivery:neutral]\nBoundary first. Boundary second.'}, None), ({}, 'stop')],
                        [({'content': '[delivery:neutral]\nBoundary first. Boundary second.'}, None), ({}, 'stop')],
                        [({'content': '[delivery:neutral]\nClean later.'}, None), ({}, 'stop')],
                    ]
                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
                    *replies,
                ])
                self.addCleanup(brain.close)

                attempts = []

                def finite_chunks(**kwargs):
                    attempts.append(kwargs['text'])
                    if kwargs['text'] in ('Failed before audio.', 'Failed recreated context.'):
                        raise RuntimeError('Synthetic synthesis failure before audio')
                    if kwargs['text'] == 'Failed after stop.':
                        if not release_failure.wait(45):
                            raise AssertionError('Synthetic delayed failure was never released')
                        raise RuntimeError('Synthetic synthesis failure after native stop')
                    if kwargs['text'] == 'Failed after audio.':
                        try:
                            yield np.full(2340, 0.25, dtype=np.float32)
                            raise RuntimeError('Synthetic synthesis failure after partial audio')
                        finally:
                            native_failure.set()
                    if kwargs['text'] != 'Unheard second.':
                        value = 0.25 if kwargs['text'] == 'Boundary second.' else 0.5
                        yield np.full(5760 if kwargs['text'] == 'Spoken first.' else 1500, value, dtype=np.float32)

                with retirement:
                    transport, _, _, interrupted, _, close = await self.open_session(
                        brain, through_service=True, synthesis_chunks=finite_chunks,
                    )
                    output = transport.output()
                    write = output.write_audio_frame
                    written = []
                    final_write = asyncio.Event()
                    hold_final = False
                    text_frames = []
                    synthesis_failures = []

                    @output.event_handler('on_after_push_frame')
                    async def retain_receipt(processor, frame):
                        if isinstance(frame, TTSTextFrame):
                            text_frames.append(frame)
                        elif isinstance(frame, TTSStartedFrame):
                            started_contexts.append(frame.context_id)
                            context_started.set()
                        elif isinstance(frame, TTSStoppedFrame):
                            stopped_contexts.append(frame.context_id)
                            context_stopped.set()
                        elif type(frame).__name__ == 'ConversationSynthesisFailedFrame':
                            synthesis_failures.append(frame)

                    async def observe_write(frame):
                        if hold_final and len(written) == 1:
                            final_write.set()
                            await release_write.wait()
                        success = await write(frame)
                        if success:
                            written.append(frame.audio)
                        return success

                    output.write_audio_frame = observe_write
                    address = conversation.address()
                    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)

                    async def rows_until(predicate):
                        async with asyncio.timeout(5):
                            while True:
                                snapshot = json.loads(await reader.readline())
                                if 'turns' in snapshot:
                                    for turn in snapshot['turns']:
                                        if turn['speaker'] == 'kestrel':
                                            self.assertNotIn('Unheard second.', turn['text'])
                                    if len(snapshot['turns']) >= 2 and predicate(snapshot['turns']):
                                        return snapshot['turns']

                    async def start(text):
                        interrupted.clear()
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await asyncio.wait_for(interrupted.wait(), 5)
                        await self.finish_user_turn(transport, text)

                    async def matching_context(event, observed, context_id):
                        async with asyncio.timeout(5):
                            while context_id not in observed:
                                event.clear()
                                await event.wait()

                    try:
                        await asyncio.wait_for(asyncio.shield(transport.llm.channel.preparation or transport.llm.channel.reader), bot.ENGINE_TIMEOUT)
                        if scenario == 'Failure before synthesis audio.':
                            await start(scenario)
                            rows = await rows_until(lambda rows: rows[-2]['text'] == scenario
                                                    and rows[-1]['state'] in ('complete', 'failed'))
                            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                            self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                            stale_failure = synthesis_failures[-1]
                        elif scenario in ('Audible segment after synthesis failure.',
                                          'Partial synthesis failure.', 'Interrupted synthesis failure.'):
                            release_write.clear()
                            hold_final = True
                            await start(scenario)
                            await asyncio.wait_for(final_write.wait(), 5)
                            rows = await rows_until(lambda rows: rows[-2]['text'] == scenario
                                                    and rows[-1]['text'].startswith('Boundary first.'))
                            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio.', 'state': 'speaking'})
                            self.assertEqual(written, [b'\xff\x3f' * 1500 + b'\xff\x1f' * 420])
                            self.assertTrue(await asyncio.to_thread(native_failure.wait, 5))
                            if scenario == 'Interrupted synthesis failure.':
                                interrupted.clear()
                                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                                await asyncio.wait_for(interrupted.wait(), 5)
                                rows = await rows_until(lambda rows: rows[-1]['state'] == 'interrupted')
                                self.assertEqual(rows[-1]['text'], 'Boundary first. Failed after audio.')
                                self.assertEqual(len(written), 1)
                            else:
                                release_write.set()
                                rows = await rows_until(lambda rows: rows[-2]['text'] == scenario
                                                        and rows[-1]['state'] in ('complete', 'failed'))
                                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio.', 'state': 'failed'})
                                self.assertEqual(b''.join(written), b'\xff\x3f' * 1500 + b'\xff\x1f' * 2340)
                            self.assertNotIn('Boundary second.', attempts)
                            self.assertNotIn('Unheard second.', attempts)
                        elif scenario == 'Delayed synthesis failure.':
                            await start(scenario)
                            await asyncio.wait_for(context_started.wait(), 5)
                            await matching_context(context_stopped, stopped_contexts, started_contexts[0])
                            release_failure.set()
                            rows = await rows_until(lambda rows: rows[-2]['text'] == scenario
                                                    and rows[-1]['state'] in ('complete', 'failed'))
                            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                            self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                        elif scenario == 'Recreated synthesis context failure.':
                            await start(scenario)
                            await asyncio.wait_for(provider_paused.wait(), 5)
                            await asyncio.wait_for(context_started.wait(), 5)
                            first_context = started_contexts[0]
                            await matching_context(context_stopped, stopped_contexts, first_context)
                            await matching_context(context_retired, retired_contexts, first_context)
                            release_provider.set()
                            rows = await rows_until(lambda rows: rows[-2]['text'] == scenario
                                                    and rows[-1]['state'] in ('complete', 'failed'))
                            self.assertEqual(started_contexts, [first_context, first_context])
                            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                            self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                        else:
                            await start('Mixed synthesis.')
                            rows = await rows_until(lambda rows: rows and rows[-1]['speaker'] == 'kestrel'
                                                    and rows[-1]['state'] in ('complete', 'failed'))
                            self.assertEqual(rows[-1]['text'], 'Spoken first.')
                            self.assertEqual(rows[-1]['state'], 'failed')
                            self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                            stale_text = text_frames[0]

                            for interrupt in (False, True):
                                with self.subTest(interrupt=interrupt):
                                    written.clear()
                                    final_write.clear()
                                    release_write.clear()
                                    hold_final = True
                                    await start('Interrupted boundary.' if interrupt else 'Completed boundary.')
                                    await asyncio.wait_for(final_write.wait(), 5)
                                    rows = await rows_until(lambda rows: rows[-2]['text'] in
                                                            ('Interrupted boundary.', 'Completed boundary.')
                                                            and rows[-1]['text'].startswith('Boundary first.'))
                                    self.assertEqual(rows[-1]['text'], 'Boundary first. Boundary second.')
                                    self.assertEqual(written, [b'\xff\x3f' * 1500 + b'\xff\x1f' * 420])
                                    transport.llm.conversation_output(stale_text)
                                    if not interrupt:
                                        self.assertIsNotNone(
                                            stale_failure,
                                            'prior closed synthesis failure must precede the healthy scenario',
                                        )
                                        transport.llm.conversation_output(stale_failure)
                                    if interrupt:
                                        interrupted.clear()
                                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                                        await asyncio.wait_for(interrupted.wait(), 5)
                                        rows = await rows_until(lambda rows: rows[-1]['state'] == 'interrupted')
                                        self.assertEqual(rows[-1]['text'], 'Boundary first. Boundary second.')
                                        self.assertEqual(len(written), 1)
                                    else:
                                        release_write.set()
                                        rows = await rows_until(lambda rows: rows[-1]['state'] == 'complete')
                                        self.assertEqual(rows[-1]['text'], 'Boundary first. Boundary second.')
                                        self.assertEqual(b''.join(written), b'\xff\x3f' * 1500 + b'\xff\x1f' * 1500 + bytes(1680))

                            hold_final = False
                            release_write.set()
                            written.clear()
                            await self.finish_user_turn(transport, 'A clean later turn.')
                            rows = await rows_until(lambda rows: rows[-2]['text'] == 'A clean later turn.'
                                                    and rows[-1]['state'] == 'complete')
                            self.assertEqual(rows[-1]['text'], 'Clean later.')
                            self.assertEqual(rows[-3], {'speaker': 'kestrel', 'text': 'Boundary first. Boundary second.', 'state': 'interrupted'})

                        if scenario != 'Healthy synthesis.':
                            release_failure.set()
                            release_provider.set()
                            release_write.set()
                            service = transport.service
                            self.assertTrue(service.manager.voice.generation_cleanup_failed)
                            attempted = list(attempts)
                            self.assertEqual(await service.toggle(), 'inactive')
                            await service.state('trouble-voice')
                            self.assertEqual(await service.toggle(), 'unavailable')
                            self.assertEqual(attempts, attempted)
                            self.assertEqual(len(transport.sessions), 1)
                    finally:
                        release_failure.set()
                        release_provider.set()
                        release_write.set()
                        writer.close()
                        await writer.wait_closed()
                        await close()
                    if scenario != 'Healthy synthesis.':
                        self.assertEqual(str(transport.service.shutdown_error), 'Voice generation cleanup failed. Restart Kestrel.')

    async def test_panel_resumes_text_from_replacement_audio_context(self):
        from desktop import conversation
        loop = asyncio.get_running_loop()
        release_first, release_second = threading.Event(), threading.Event()
        for release in (release_first, release_second):
            self.addCleanup(release.set)
        first_held, second_held = asyncio.Event(), asyncio.Event()
        retirement_seen, frame_pushed = asyncio.Event(), asyncio.Event()
        retired, pushed = [], []
        native_completed = speech.VoxCPMTTS.on_audio_context_completed

        async def observe_completed(voice, context_id):
            await native_completed(voice, context_id)
            retired.append(context_id)
            retirement_seen.set()

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nHeld first. Ends late. Cut short. Then more.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)

        def chunks(**kwargs):
            text = kwargs['text']
            if text == 'Cut short.':
                # 1000 bytes stay under one 3840-byte output chunk, so the transport never writes them.
                yield np.full(500, 0.5, dtype=np.float32)
                loop.call_soon_threadsafe(second_held.set)
                if not release_second.wait(45):
                    raise AssertionError('Synthetic second hold was never released')
                return
            yield np.full(1920, 0.5, dtype=np.float32)
            if text == 'Held first.':
                loop.call_soon_threadsafe(first_held.set)
                if not release_first.wait(45):
                    raise AssertionError('Synthetic first hold was never released')
                yield np.full(1920, 0.5, dtype=np.float32)

        async def until(event, predicate):
            async with asyncio.timeout(5):
                while not predicate():
                    event.clear()
                    await event.wait()

        def stopped_after_ends_late():
            ends_late = next((index for index, frame in enumerate(pushed)
                              if isinstance(frame, TTSTextFrame) and frame.text == 'Ends late.'), None)
            return ends_late is not None and any(isinstance(frame, BotStoppedSpeakingFrame)
                                                 for frame in pushed[ends_late + 1:])

        with patch.object(speech.VoxCPMTTS, 'on_audio_context_completed', observe_completed):
            transport, _, _, interrupted, _, close = await self.open_session(
                brain, through_service=True, synthesis_chunks=chunks,
            )
            output = transport.output()
            generated, delivered, records = [], [], []

            @output.event_handler('on_after_push_frame')
            async def collect(processor, frame):
                pushed.append(frame)
                if isinstance(frame, reply_progress.REPLY_MESSAGES):
                    delivered.append(self.as_pushed(frame))
                frame_pushed.set()

            @transport.llm.event_handler('on_before_push_frame')
            async def collect_generated(processor, frame):
                if isinstance(frame, reply_progress.REPLY_MESSAGES):
                    generated.append(self.as_pushed(frame))
                    if isinstance(frame, bot.LLMFullResponseStartFrame):
                        records.append(transport.llm.current_reply())

            address = conversation.address()

            async def snapshot():
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)
                try:
                    return json.loads(await asyncio.wait_for(reader.readline(), 1))['turns']
                finally:
                    peer = transport.llm.conversation.reader_task
                    writer.close()
                    await writer.wait_closed()
                    if peer is not None:
                        await asyncio.wait_for(peer, 1)

            writer = None
            try:
                await asyncio.shield(transport.service.manager.session_ready)
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'Resume after a held stream.')
                await asyncio.wait_for(first_held.wait(), 5)
                await until(retirement_seen, lambda: len(retired) >= 1)
                held_first = (await snapshot())[-1]
                release_first.set()
                await asyncio.wait_for(second_held.wait(), 5)
                await until(retirement_seen, lambda: len(retired) >= 2)
                await until(frame_pushed, stopped_after_ends_late)
                held_second = (await snapshot())[-1]
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)
                release_second.set()
                async with asyncio.timeout(5):
                    while True:
                        rows = json.loads(await reader.readline()).get('turns')
                        if rows and len(rows) >= 2 and rows[-2]['text'] == 'Resume after a held stream.' \
                                and rows[-1]['state'] not in ('thinking', 'speaking'):
                            break
                retirements = len(retired)
                self.assertEqual(rows[-1]['state'], 'failed')
                self.assertEqual(rows[-1]['text'], 'Held first. Ends late. Then more.')
                self.assertEqual(held_first, {'speaker': 'kestrel', 'text': 'Held first.', 'state': 'speaking'})
                self.assertEqual(held_second, {'speaker': 'kestrel', 'text': 'Held first. Ends late.', 'state': 'speaking'})
                self.assertEqual(len([frame for frame in pushed if isinstance(frame, TTSStartedFrame)]), 1)
                self.assertEqual(retirements, 3)
                self.assertEqual(b''.join(frame.audio for frame in pushed if isinstance(frame, TTSAudioRawFrame)),
                                 b'\xff\x3f' * 1920 * 4)
                self.assertEqual(len(records), 1)
                self.reply_intervals(generated, records)
                self.reply_intervals(delivered, records)
            finally:
                release_first.set()
                release_second.set()
                if writer is not None:
                    writer.close()
                    await writer.wait_closed()
                await close()

    async def test_panel_new_reply_ignores_stale_output_after_unawaited_interruption(self):
        from desktop import conversation
        loop = asyncio.get_running_loop()
        release_held = threading.Event()
        self.addCleanup(release_held.set)
        held, boundary_text = asyncio.Event(), asyncio.Event()
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBoundary first. Held second.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)

        def chunks(**kwargs):
            text = kwargs['text']
            if text == 'Held second.':
                loop.call_soon_threadsafe(held.set)
                if not release_held.wait(45):
                    raise AssertionError('Synthetic held sentence was never released')
                return
            # 3000 bytes stay under one 3840-byte output chunk, so 'Boundary first.' keeps a pending span.
            yield np.full(1500 if text == 'Boundary first.' else 1920, 0.5, dtype=np.float32)

        transport, _, _, interrupted, _, close = await self.open_session(
            brain, through_service=True, synthesis_chunks=chunks,
        )

        @transport.output().event_handler('on_after_push_frame')
        async def observe(processor, frame):
            if isinstance(frame, TTSTextFrame) and frame.text == 'Boundary first.':
                boundary_text.set()

        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(conversation.address()), 1)

        async def rows_until(predicate):
            async with asyncio.timeout(5):
                while True:
                    rows = json.loads(await reader.readline()).get('turns')
                    if rows and len(rows) >= 4 and rows[-2]['text'] == 'What can I say?' and predicate(rows):
                        return rows

        try:
            await asyncio.shield(transport.service.manager.session_ready)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, 'Start a boundary reply.')
            await asyncio.wait_for(boundary_text.wait(), 5)
            await asyncio.wait_for(held.wait(), 5)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'What can I say?')
            await rows_until(lambda rows: rows[-3]['state'] == 'interrupted' and rows[-1]['state'] == 'thinking')
            release_held.set()
            rows = await rows_until(lambda rows: rows[-1]['state'] not in ('thinking', 'speaking'))
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': bot.capability_help(), 'state': 'complete'})
            self.assertEqual(rows[-3], {'speaker': 'kestrel', 'text': '', 'state': 'interrupted'})
        finally:
            release_held.set()
            writer.close()
            await writer.wait_closed()
            await close()

    async def test_panel_receives_final_turns_and_spoken_prefix(self):
        from desktop import conversation
        blocked, release = threading.Event(), threading.Event()

        def partial():
            yield {'content': '[delivery:reassuring]\nOne fact. [deliv'}, None
            yield {'content': 'ery:unknown] Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Synthetic partial reply was never released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:gently_pleased]\nHello. [deliv'}, None),
             ({'content': 'ery:reassuring]'}, None), ({}, 'stop')], partial(),
            [({'content': '[delivery:neutral]\nUnheard stop canary.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nUnheard cancel canary.'}, None), ({}, 'stop')], 400,
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        cancel_without_audio = False
        synthesis = []

        def finite_chunks(**kwargs):
            synthesis.append(kwargs)
            self.assertEqual(kwargs['reference_wav_path'], '/fixture/british-male.wav')
            if kwargs['text'].startswith(('(Gently pleased,', '(Warm, gentle')):
                self.assertNotIn('prompt_wav_path', kwargs)
                self.assertNotIn('prompt_text', kwargs)
            else:
                self.assertEqual(kwargs['prompt_text'], 'British fixture.')
            if not cancel_without_audio:
                # Whole native chunks, so no tail waits for the stop flush.
                yield np.zeros(5760, dtype=np.float32)

        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, through_service=True, synthesis_chunks=finite_chunks,
        )
        output = transport.output()
        generated, release_text = asyncio.Event(), asyncio.Event()
        hold_text = False
        output_order = []
        playback_started = asyncio.Event()
        old_end_output = asyncio.Event()

        @output.event_handler('on_after_push_frame')
        async def frame_order(processor, frame):
            if isinstance(frame, BotStartedSpeakingFrame):
                playback_started.set()
            elif isinstance(frame, LLMFullResponseEndFrame):
                output_order.append(('end', reply_progress.token_of(frame)))
                if cancel_without_audio:
                    old_end_output.set()
            elif isinstance(frame, InterruptionFrame):
                output_order.append(('interruption', reply_progress.token_of(frame)))

        @transport.llm.event_handler('on_before_push_frame')
        async def generated_text(processor, frame):
            if cancel_without_audio and isinstance(frame, InterruptionFrame) and reply_progress.token_of(frame) is not None:
                # Model an already-admitted end delayed downstream of the output gate.
                late = LLMFullResponseEndFrame()
                late.reply_progress = frame.reply_progress
                await speech.BaseOutputTransport.push_frame(output, late)
                await asyncio.wait_for(old_end_output.wait(), 5)
            if hold_text and isinstance(frame, LLMTextFrame):
                generated.set()
                await release_text.wait()

        async def start():
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await barrier()

        async def barrier():
            frame = DataFrame()
            await transport.input().queue_frame(frame)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), frame)

        reader = writer = None
        try:
            await asyncio.shield(transport.service.manager.session_ready)
            await start()
            await self.finish_user_turn(transport, 'Hello Kestrel.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Hello.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Hello.')
            delivered = []
            address = conversation.address()
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)
            except (OSError, TimeoutError):
                pass
            else:
                snapshot = json.loads(await asyncio.wait_for(reader.readline(), 1))
                delivered = snapshot['turns']

            async def turns_until(predicate):
                async with asyncio.timeout(5):
                    while True:
                        row = json.loads(await reader.readline())
                        if 'turns' in row and predicate(row['turns']):
                            return row['turns']

            self.assertEqual(delivered, [
                {'speaker': 'you', 'text': 'Hello Kestrel.', 'state': 'complete', 'source': 'spoken'},
                {'speaker': 'kestrel', 'text': 'Hello.', 'state': 'complete'},
            ])
            for utterance in ('repeat that', 'what can I say?'):
                await start()
                await self.finish_user_turn(transport, utterance)
                expected = 'Hello.' if utterance == 'repeat that' else bot.capability_help()
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                rows = await turns_until(lambda turns: turns[-2]['text'] == utterance and turns[-1]['state'] == 'complete')
                self.assertEqual(rows[-2:], [
                    {'speaker': 'you', 'text': utterance, 'state': 'complete', 'source': 'spoken'},
                    {'speaker': 'kestrel', 'text': expected, 'state': 'complete'},
                ])
                self.assertTrue(committed.empty(), 'Local spoken responses never enter engine history')
            playback_started.clear()
            await start()
            output.write_gate.clear()
            await self.finish_user_turn(transport, 'what can I say?')
            await asyncio.wait_for(playback_started.wait(), 5)
            await start()
            rows = await turns_until(lambda turns: turns[-1]['state'] == 'interrupted')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': '', 'state': 'interrupted'})
            self.assertTrue(spoken.empty(), 'Interrupted local help cannot publish its unheard text')
            await self.finish_user_turn(transport, 'cancel')
            await barrier()
            output.write_gate.set()
            written_before = output.audio_written
            await start()
            await self.finish_user_turn(transport, 'Tell me more.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
            self.assertEqual(output.audio_written, written_before + 3)
            rows = await turns_until(lambda turns: turns[-1]['state'] == 'speaking')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'One fact.', 'state': 'speaking'})
            self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
            old_token = transport.llm.current_reply().token
            await start()
            rows = await turns_until(lambda turns: turns[-1]['state'] == 'interrupted')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'One fact.', 'state': 'interrupted'})
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
            release.set()
            await self.finish_user_turn(transport, 'stop')
            await barrier()
            rows = await turns_until(lambda turns: turns[-1]['text'] == 'stop')
            self.assertEqual(rows[-2]['state'], 'interrupted')
            self.assertEqual(transport.llm.last_spoken_reply, 'One fact.')
            pre_audio_tokens = []
            for stop_word in ('stop', 'cancel'):
                hold_text = True
                generated.clear()
                release_text.clear()
                await start()
                await self.finish_user_turn(transport, 'Before audio ' + stop_word)
                await asyncio.wait_for(generated.wait(), 5)
                rows = await turns_until(lambda turns: turns[-1]['state'] == 'thinking')
                self.assertEqual(rows[-1]['text'], '')
                token = transport.llm.current_reply().token
                pre_audio_tokens.append(token)
                old_end_output.clear()
                playback_started.clear()
                written_before = output.audio_written
                cancel_without_audio = True
                await start()
                await self.finish_user_turn(transport, stop_word)
                await barrier()
                rows = await turns_until(lambda turns: turns[-1]['text'] == stop_word)
                self.assertEqual(rows[-2], {'speaker': 'kestrel', 'text': '', 'state': 'interrupted'})
                self.assertEqual(output.audio_written, written_before)
                self.assertFalse(playback_started.is_set(), 'No audio starts for this attempted reply')
                while not spoken.empty():
                    self.assertNotIn('canary', spoken.get_nowait(), 'Unheard generated text is never delivered')
                self.assertIsNone(transport.llm.current_reply())
                # A delayed native end cannot change a terminal row or a newer attempt.
                late = LLMFullResponseEndFrame()
                late.reply_progress = reply_progress.ReplyProgress.silent(token)
                await output.push_frame(late)
                hold_text = False
                cancel_without_audio = False
            self.assertTrue(any(
                ('end', token) in output_order and ('interruption', token) in output_order
                and output_order.index(('end', token)) < output_order.index(('interruption', token))
                for token in pre_audio_tokens
            ), output_order)
            count_before_mute = len(rows)
            transport.llm.local_actions.command = AsyncMock(side_effect=[
                'fixture-output', 'fixture-output', 'Mute: yes',
                'fixture-output', 'fixture-output', 'Mute: yes',
            ])
            await start()
            await self.finish_user_turn(transport, 'mute')
            await barrier()
            rows = await turns_until(
                lambda turns: turns[-1] == {'speaker': 'kestrel', 'text': 'Muting.', 'state': 'complete'})
            self.assertEqual(len(rows), count_before_mute + 2, 'Mute creates the finalized user row and its Muting. reply')
            self.assertEqual(rows[-2], {'speaker': 'you', 'text': 'mute', 'state': 'complete', 'source': 'spoken'})
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
            self.assertTrue(spoken.empty())
            self.assertEqual(len(brain.requests), 5, 'Local controls make no engine request')
            await start()
            await self.finish_user_turn(transport, 'Brain failure turn')
            expected_failure = "I couldn't get a complete reply from the brain. Restart Kestrel and try again."
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I couldn't get a complete reply from the brain.")
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Restart Kestrel and try again.')
            rows = await turns_until(lambda turns: turns[-1]['state'] == 'failed')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': expected_failure, 'state': 'failed'})
            late = LLMFullResponseEndFrame()
            late.reply_progress = reply_progress.ReplyProgress.silent(old_token)
            await output.push_frame(late)
            await barrier()
            self.assertNotIn('Unheard', json.dumps(rows))
            status = json.loads((Path(os.environ['XDG_RUNTIME_DIR']) / 'kestrel/indicator.json').read_text())
            self.assertEqual(set(status), {'version', 'boot_id', 'publisher', 'timestamp_ns', 'state', 'owners'})
            self.assertNotIn('Hello', json.dumps(status))
            self.assertNotIn('canary', json.dumps(status))
            self.assertEqual(len(brain.requests), 6)
            history = [m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system']
            self.assertNotIn('what can I say', json.dumps(history))
            self.assertNotIn('Unheard continuation', json.dumps(history))
            async with asyncio.timeout(5):
                while await committed.get() != expected_failure:
                    pass
            local_histories = []

            @transport.llm.event_handler('on_after_process_frame')
            async def local_history(processor, frame):
                if isinstance(frame, LLMContextFrame):
                    local_histories.append(deepcopy(frame.context.get_messages()))

            expected_help = bot.capability_help()
            for local_turn in ('what can I say?', 'repeat that'):
                await start()
                await self.finish_user_turn(transport, local_turn)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected_help)
                await barrier()
                rows = await turns_until(lambda turns: turns[-2]['text'] == local_turn
                                         and turns[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': expected_help, 'state': 'complete'})
                self.assertEqual(len(brain.requests), 6, 'Local speech after failure makes no brain request')
                self.assertTrue(committed.empty(), 'Local speech after failure adds no assistant context')
                self.assertTrue(local_histories)
                self.assertNotIn(local_turn, json.dumps(local_histories[-1]))
                self.assertNotIn(expected_help, json.dumps(local_histories[-1]))
        finally:
            release.set()
            release_text.set()
            output.write_gate.set()
            if writer is not None:
                writer.close()
                await writer.wait_closed()
            await close()

    async def test_panel_marks_empty_or_failed_synthesis(self):
        from desktop import conversation
        for failing in (False, True):
            with self.subTest(synthesis='failed' if failing else 'empty'):
                preparation = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
                self.addCleanup(preparation.close)
                attempts = []

                def no_audio(**kwargs):
                    attempts.append(kwargs['text'])
                    if failing:
                        raise RuntimeError('Synthetic synthesis failure')
                    yield from ()

                transport, spoken, committed, interrupted, _, close = await self.open_session(
                    preparation, through_service=True, synthesis_chunks=no_audio,
                )
                endpoint = conversation.address()
                reader, writer = await asyncio.open_unix_connection(endpoint)
                try:
                    await asyncio.shield(transport.service.manager.session_ready)
                    self.assertEqual(json.loads(await asyncio.wait_for(reader.readline(), 1))['turns'], [])
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await self.finish_user_turn(transport, 'what can I say?')
                    async with asyncio.timeout(5):
                        while True:
                            snapshot = json.loads(await reader.readline())
                            if 'turns' in snapshot and snapshot['turns'] and snapshot['turns'][-1]['state'] == 'failed':
                                break
                    self.assertEqual(snapshot['turns'], [
                        {'speaker': 'you', 'text': 'what can I say?', 'state': 'complete', 'source': 'spoken'},
                        {'speaker': 'kestrel', 'text': '', 'state': 'failed'},
                    ])
                    self.assertEqual(transport.output().audio_written, 0)
                    self.assertTrue(committed.empty())
                    self.assertEqual(len(attempts), 1, 'Warmup uses the existing asserted finite audio fixture')
                    if failing:
                        service = transport.service
                        manager = service.manager
                        self.assertTrue(manager.voice.generation_cleanup_failed)
                        self.assertEqual(await service.toggle(), 'inactive')
                        await service.state('trouble-voice')
                        self.assertEqual(manager.failure, 'Voice generation cleanup failed. Restart Kestrel.')
                        self.assertTrue(manager.cleanup.done())
                        self.assertFalse(manager.admission is not None and manager.admission.is_open())
                        self.assertEqual(await service.toggle(), 'unavailable')
                        self.assertEqual(len(transport.sessions), 1)
                        self.assertEqual(len(attempts), 1)
                        self.assertEqual(transport.output().audio_written, 0)
                        self.assertTrue(committed.empty())
                finally:
                    writer.close()
                    await writer.wait_closed()
                    await close()
                if failing:
                    self.assertEqual(str(service.shutdown_error), 'Voice generation cleanup failed. Restart Kestrel.')

    async def test_indicator_local_speech_without_audio_finishes_turn(self):
        phrases = ('repeat that', 'what can i say')
        for failing, local_turns in ((False, phrases), (True, phrases), (True, phrases[::-1])):
            with self.subTest(synthesis='failure' if failing else 'empty', first_phrase=local_turns[0]):
                brain = ScriptedBrain([])
                self.addCleanup(brain.close)
                attempts = []

                def chunks(**kwargs):
                    attempts.append(kwargs['text'])
                    if failing:
                        raise RuntimeError('Finite synthesis failure')
                    yield from ()

                command = AsyncMock(side_effect=AssertionError('Local speech cannot invoke a tool'))
                with tempfile.TemporaryDirectory() as runtime:
                    status = bot.IndicatorStatus(Path(runtime))
                    transport, _, committed, _, _, close = await self.open_session(
                        brain, local_command=command, status=status, synthesis_chunks=chunks,
                    )
                    service = transport.service
                    voice = service.manager.voice
                    output_events, contexts, transitions = [], [], []
                    native_set = status.set_state

                    def observe(state):
                        native_set(state)
                        transitions.append((state, voice.generation_cleanup_failed))

                    @transport.output().event_handler('on_after_push_frame')
                    async def output_event(processor, frame):
                        if isinstance(frame, BotStartedSpeakingFrame):
                            output_events.append(frame)

                    @transport.llm.event_handler('on_after_process_frame')
                    async def context_after_turn(processor, frame):
                        if isinstance(frame, LLMContextFrame):
                            contexts.append(deepcopy(frame.context.get_messages()))

                    try:
                        with patch.object(status, 'set_state', observe):
                            first_fault = None
                            for index, phrase in enumerate(local_turns):
                                with self.subTest(phrase=phrase, refusal_probe=failing and index == 1):
                                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                                    await self.finish_user_turn(transport, phrase)
                                    barrier = DataFrame()
                                    await transport.input().queue_frame(barrier)
                                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                                    snapshot = json.loads((Path(runtime) / 'kestrel/indicator.json').read_text())
                                    self.assertEqual(voice.generation_cleanup_failed, failing)
                                    self.assertEqual(snapshot['state'], 'trouble-voice' if failing else 'idle',
                                                     'A failed native voice cannot appear ready after a local turn')
                                    self.assertEqual(output_events, [], 'No audio means no native speaking event')
                                    self.assertTrue(committed.empty())
                                    self.assertEqual(contexts[-1], [], 'Local speech stays outside brain history')
                                    self.assertEqual(len(attempts), 1 if failing else index + 1)
                                    if index == 0:
                                        transition_count = len(transitions)
                                        passive_frame = DataFrame()
                                        await transport.output().push_frame(passive_frame)
                                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), passive_frame)
                                        self.assertEqual(len(transitions), transition_count,
                                                         'Passive output cannot republish indicator status')
                                    if failing:
                                        if index == 0:
                                            first_fault = next((position for position, transition in enumerate(transitions)
                                                                if transition == ('trouble-voice', True)), None)
                                            self.assertIsNotNone(first_fault, 'Native voice failure must publish trouble')
                                        if first_fault is not None:
                                            self.assertTrue(all(state == 'trouble-voice'
                                                                for state, _ in transitions[first_fault:]), transitions)
                            self.assertEqual(len(attempts), 1 if failing else 2)
                            self.assertEqual(brain.requests, [])
                            command.assert_not_awaited()
                    finally:
                        if voice.generation_cleanup_failed:
                            self.assertEqual(await service.toggle(), 'inactive')
                            await service.state('trouble-voice')
                            self.assertEqual(await service.toggle(), 'unavailable')
                            self.assertEqual(len(attempts), 1)
                        await close()
                    if failing:
                        self.assertEqual(str(service.shutdown_error), 'Voice generation cleanup failed. Restart Kestrel.')

    async def test_indicator_tracks_output_interruption_and_local_turns(self):
        blocked, release = threading.Event(), threading.Event()
        mute_entered, mute_release = asyncio.Event(), asyncio.Event()

        def interrupted_reply():
            yield {'content': '[delivery:neutral]\nOne fact. Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Indicator reply was never released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nHello.'}, None), ({}, 'stop')], interrupted_reply(),
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)

        with tempfile.TemporaryDirectory() as runtime:
            status = bot.IndicatorStatus(Path(runtime))
            changes = asyncio.Queue()
            native_set = status.set_state

            def observe(state):
                native_set(state)
                changes.put_nowait(state)

            with patch.object(status, 'set_state', observe):
                transport, spoken, _, interrupted, _, close = await self.open_session(brain, status=status)
                output = transport.output()
                text_seen, text_release = asyncio.Event(), asyncio.Event()
                native_events = asyncio.Queue()

                @transport.llm.event_handler('on_before_push_frame')
                async def generated(processor, frame):
                    if isinstance(frame, LLMTextFrame):
                        text_seen.set()
                        await text_release.wait()

                @output.event_handler('on_after_push_frame')
                async def playback(processor, frame):
                    if isinstance(frame, (BotStartedSpeakingFrame, BotStoppedSpeakingFrame)):
                        native_events.put_nowait(type(frame))

                def current():
                    return json.loads((Path(runtime) / 'kestrel/indicator.json').read_text())['state']

                async def state(expected):
                    while await asyncio.wait_for(changes.get(), 5) != expected:
                        pass
                    self.assertEqual(current(), expected)

                async def start():
                    interrupted.clear()
                    while not changes.empty():
                        changes.get_nowait()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await state('listening')
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await barrier()

                async def barrier():
                    frame = DataFrame()
                    await transport.input().queue_frame(frame)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), frame)

                try:
                    await state('idle')
                    await start()
                    output.write_gate.clear()
                    await self.finish_user_turn(transport, 'Say hello.')
                    await asyncio.wait_for(text_seen.wait(), 5)
                    self.assertEqual(current(), 'thinking', 'Generated text is not playback')
                    text_release.set()
                    await state('speaking')
                    self.assertIs(await asyncio.wait_for(native_events.get(), 5), BotStartedSpeakingFrame)
                    await asyncio.wait_for(output.generation_done.wait(), 5)
                    self.assertEqual(current(), 'speaking', 'LLM completion cannot finish queued audio')
                    output.write_gate.set()
                    await state('idle')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Hello.')
                    while await asyncio.wait_for(native_events.get(), 5) is not BotStoppedSpeakingFrame:
                        pass
                    for phrase in ('repeat that', 'what can i say'):
                        await start()
                        output.write_gate.clear()
                        await self.finish_user_turn(transport, phrase)
                        await state('speaking')
                        output.write_gate.set()
                        await state('idle')
                    await start()
                    await self.finish_user_turn(transport, 'Tell me more.')
                    self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
                    await state('speaking')
                    old_reader = transport.llm.channel.reader
                    interrupted.clear()
                    await start()
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await self.finish_user_turn(transport, 'Wait for the old reply.')
                    await state('thinking')
                    await start()
                    release.set()
                    await asyncio.wait_for(asyncio.shield(old_reader), 5)
                    await barrier()
                    self.assertEqual(current(), 'listening', 'Old drainage cannot resurrect a reply')
                    await self.finish_user_turn(transport, 'stop')
                    await barrier()
                    self.assertEqual(current(), 'idle')
                    for phrase in ('cancel', 'mute'):
                        await start()
                        if phrase == 'mute':
                            results = iter(['fixture-output', 'fixture-output', 'Mute: yes'] * 2)

                            async def command(argv, *, stdin_data=None):
                                mute_entered.set()
                                await mute_release.wait()
                                return next(results)

                            transport.llm.local_actions.command = command
                        await self.finish_user_turn(transport, phrase)
                        if phrase == 'mute':
                            await asyncio.wait_for(mute_entered.wait(), 5)
                            await state('thinking')
                            mute_release.set()
                        await barrier()
                        self.assertEqual(current(), 'idle')
                    self.assertEqual(len(brain.requests), 2)
                    self.assertFalse(transport.llm.local_actions.tasks)
                finally:
                    mute_release.set()
                    release.set()
                    text_release.set()
                    output.write_gate.set()
                    await close()

    async def test_indicator_reports_engine_trouble(self):
        brain = ScriptedBrain([400])
        self.addCleanup(brain.close)
        with tempfile.TemporaryDirectory() as runtime:
            status = bot.IndicatorStatus(Path(runtime))
            changes = asyncio.Queue()
            native_set = status.set_state

            def observe(value):
                native_set(value)
                changes.put_nowait(value)

            def current():
                data = json.loads((Path(runtime) / 'kestrel/indicator.json').read_text())
                self.assertEqual(set(data), {'version', 'boot_id', 'publisher', 'timestamp_ns', 'state', 'owners'})
                self.assertNotIn('PRIVATE transcript sentinel', json.dumps(data))
                return data['state']

            async def state(expected):
                while await asyncio.wait_for(changes.get(), 5) != expected:
                    pass
                self.assertEqual(current(), expected)

            with patch.object(status, 'set_state', observe):
                transport, spoken, _, interrupted, _, close = await self.open_session(brain, status=status)
                output = transport.output()

                async def start():
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await state('listening')
                    await asyncio.wait_for(interrupted.wait(), 5)
                    barrier = DataFrame()
                    await output.queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)

                try:
                    await state('idle')
                    await start()
                    output.write_gate.clear()
                    await self.finish_user_turn(transport, 'PRIVATE transcript sentinel')
                    await state('speaking')
                    await asyncio.wait_for(output.generation_done.wait(), 5)
                    self.assertEqual(current(), 'speaking', 'Failure advisory uses real output events')
                    output.write_gate.set()
                    await state('trouble-engine')
                    self.assertIn("couldn't get a complete reply", await asyncio.wait_for(spoken.get(), 5))
                    for phrase in ('repeat that', 'what can i say'):
                        while not changes.empty():
                            changes.get_nowait()
                        await start()
                        output.write_gate.clear()
                        await self.finish_user_turn(transport, phrase)
                        await state('speaking')
                        output.write_gate.set()
                        await state('trouble-engine')
                    for phrase in ('stop', 'cancel', 'mute'):
                        while not changes.empty():
                            changes.get_nowait()
                        await start()
                        if phrase == 'mute':
                            transport.llm.local_actions.command = AsyncMock(side_effect=[
                                'fixture-output', 'fixture-output', 'Mute: yes',
                                'fixture-output', 'fixture-output', 'Mute: yes',
                            ])
                        await self.finish_user_turn(transport, phrase)
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual(current(), 'trouble-engine', 'Engine trouble survives local turns')
                    self.assertEqual(len(brain.requests), 1)
                    self.assertFalse(transport.llm.local_actions.tasks)
                finally:
                    output.write_gate.set()
                    await close()

    async def test_missing_delivery_header_allows_next_turn(self):
        from desktop import conversation
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': ' \nPlain '}, None), ({'content': 'answer [deliv'}, None),
             ({'content': 'ery:reassuring] stays clear.'}, None), ({}, 'stop')],
            [({'content': '[delivery:curious]\nWhat happened next?'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        synthesis = []

        def finite_chunks(**kwargs):
            synthesis.append(kwargs)
            self.assertEqual(kwargs['reference_wav_path'], '/fixture/british-male.wav')
            yield np.zeros(5760, dtype=np.float32)

        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, through_service=True, synthesis_chunks=finite_chunks,
        )
        channel = transport.service.channel
        worker = channel.process
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Tell me something.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Plain answer stays clear.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Plain answer stays clear.')

        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(conversation.address()), 1)
        try:
            snapshot = json.loads(await asyncio.wait_for(reader.readline(), 1))
            self.assertEqual(snapshot['turns'], [
                {'speaker': 'you', 'text': 'Tell me something.', 'state': 'complete', 'source': 'spoken'},
                {'speaker': 'kestrel', 'text': 'Plain answer stays clear.', 'state': 'complete'},
            ])
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'And then?')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'What happened next?')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'What happened next?')
            async with asyncio.timeout(5):
                while True:
                    snapshot = json.loads(await reader.readline())
                    if snapshot.get('turns', [])[-1:] == [
                        {'speaker': 'kestrel', 'text': 'What happened next?', 'state': 'complete'},
                    ]:
                        break
            self.assertEqual(snapshot['turns'][-2:], [
                {'speaker': 'you', 'text': 'And then?', 'state': 'complete', 'source': 'spoken'},
                {'speaker': 'kestrel', 'text': 'What happened next?', 'state': 'complete'},
            ])
        finally:
            writer.close()
            await writer.wait_closed()

        self.assertEqual(len(brain.requests), 3, 'Preparation and two turns run without retry')
        self.assertEqual([[(m['role'], m['content'].strip()) for m in request[2]['messages']
                          if m['role'] != 'system'] for request in brain.requests], [
            [('user', 'Hello.')],
            [('user', 'Tell me something.')],
            [('user', 'Tell me something.'), ('assistant', 'Plain answer stays clear.'), ('user', 'And then?')],
        ])
        self.assertEqual([call['text'] for call in synthesis], [
            'Plain answer stays clear.',
            '(Subtly curious and interested, natural conversational delivery) What happened next?',
        ])
        self.assertEqual(synthesis[0]['prompt_wav_path'], '/fixture/british-male.wav')
        self.assertEqual(synthesis[0]['prompt_text'], 'British fixture.')
        self.assertNotIn('prompt_wav_path', synthesis[1])
        self.assertNotIn('prompt_text', synthesis[1])
        self.assertEqual(len(processes), 1)
        self.assertIs(channel.process, worker)
        self.assertIsNone(worker.returncode)
        self.assertIsNone(channel.failure)
        self.assertIsNone(channel.failure_advisory)
        await close()

    async def test_capped_native_turn_fails_alone_and_conversation_continues(self):
        from desktop import conversation
        invalid_calls = [[({'tool_calls': [{'index': 0, 'id': f'invalid-{index}', 'type': 'function',
                          'function': {'name': 'memory', 'arguments': '{"target":"memory"}'}}]}, None),
                         ({}, 'tool_calls')] for index in range(8)]
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral] Checking now.'}, None),
             ({'tool_calls': [{'index': 0, 'id': 'mute-first', 'type': 'function', 'function': {
                 'name': 'mute', 'arguments': '{}',
             }}]}, None), ({}, 'tool_calls')],
            *invalid_calls,
            '[delivery:neutral] Muted and searched nonce-931.',
            [({'content': '[delivery:neutral] Fifteen.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
        first_reply = "Checking now. I couldn't get a complete reply from the brain."

        with tempfile.TemporaryDirectory() as runtime:
            status = bot.IndicatorStatus(Path(runtime))
            changes = asyncio.Queue()
            native_set = status.set_state

            def observe(state):
                native_set(state)
                changes.put_nowait(state)

            with patch.object(status, 'set_state', observe):
                transport, spoken, committed, _, processes, close = await self.open_session(
                    brain, local_command=command, status=status,
                )
                channel = transport.llm.channel
                worker = channel.process
                address = conversation.address()
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 5)

                async def rows_until(predicate):
                    async with asyncio.timeout(5):
                        while True:
                            snapshot = json.loads(await reader.readline())
                            if 'turns' in snapshot and predicate(snapshot['turns']):
                                return snapshot['turns']

                try:
                    while not changes.empty():
                        changes.get_nowait()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'Please silence the sound.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), first_reply)
                    heard = []
                    while not spoken.empty():
                        heard.append(spoken.get_nowait())
                    self.assertEqual(' '.join(heard), first_reply)
                    rows = await rows_until(lambda rows: rows and rows[-1]['speaker'] == 'kestrel'
                                            and rows[-1]['state'] == 'failed')
                    self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': first_reply, 'state': 'failed'})
                    async with asyncio.timeout(5):
                        while (state := await changes.get()) != 'idle':
                            self.assertFalse(state.startswith('trouble'), state)
                    self.assertIsNone(channel.failure)
                    self.assertIsNone(channel.failure_advisory)
                    self.assertEqual(len(processes), 1)
                    self.assertIsNone(worker.returncode)
                    self.assertEqual(len(brain.requests), 10)
                    self.assertFalse(brain.requests[9][2].get('stream', False))

                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'What is seven plus eight?')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fifteen.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fifteen.')
                    next_rows = await rows_until(lambda rows: rows and rows[-1]['text'] == 'Fifteen.'
                                                 and rows[-1]['state'] == 'complete')
                    self.assertEqual(len(brain.requests), 11)
                    messages = [m for m in brain.requests[10][2]['messages'] if m['role'] != 'system']
                    self.assertEqual(messages[0], {'role': 'user', 'content': 'Please silence the sound.'})
                    self.assertEqual(messages[1]['role'], 'assistant')
                    record = messages[1]['tool_calls'][0]
                    self.assertEqual(len(messages[1]['tool_calls']), 1)
                    self.assertEqual(record['function']['name'], 'mute')
                    self.assertEqual(json.loads(record['function']['arguments']), {})
                    self.assertEqual(messages[2], {'role': 'tool', 'tool_call_id': record['id'],
                                                 'content': json.dumps({'confirmed': True, 'attempted': True, 'reason': 'confirmed'})})
                    self.assertEqual(messages[3], {'role': 'assistant', 'content': first_reply})
                    self.assertEqual(messages[4], {'role': 'user', 'content': 'What is seven plus eight?'})
                    self.assertEqual(len(messages), 5)
                    self.assertEqual([c for c in command.await_args_list if 'set-sink-mute' in c.args[0]],
                                     [call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))])
                    self.assertEqual(command.await_count, 7)
                    self.assertEqual(len(processes), 1)
                    self.assertIs(channel.process, worker)
                    self.assertIsNone(worker.returncode)
                    self.assertNotIn('nonce-931', json.dumps(heard + [first_reply, 'Fifteen.', rows, next_rows]))
                    self.assertNotIn('nonce-931', json.dumps(brain.requests[10]))
                    self.assertTrue(spoken.empty())
                finally:
                    writer.close()
                    await writer.wait_closed()
                    await close()


if __name__ == '__main__':
    unittest.main()
