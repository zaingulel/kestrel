import asyncio
import io
import hashlib
import json
import struct
import wave
from functools import partial
import os
import runpy
import signal
import socket
import sys
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, create_autospec, patch

import numpy as np
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, LLMFullResponseEndFrame, LLMTextFrame, StartFrame, TTSAudioRawFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from admission import Admission
import bot
from conversation_fixtures import (
    ENGINE_LOAD_REFUSAL, ENGINE_MISSING_ADVICE, SOURCE_IDENTITY_REFUSAL, hermes_service, request_frame,
)
import reply_progress
import speech
import tool_actions


# SessionTests.setUp replaces bot.VoiceConversations with a mock; tests of its real methods use this import-time class.
NATIVE_VOICE_CONVERSATIONS = bot.VoiceConversations


class AcknowledgementTests(unittest.IsolatedAsyncioTestCase):
    async def test_ordinary_turn_deadline_survives_readiness_and_generation(self):
        for outcome in ('complete', 'failure', 'revoke'):
            with self.subTest(outcome=outcome):
                service = hermes_service()
                output = speech.LaptopOutput(Mock(admission=service.admission), TransportParams(
                    audio_out_enabled=True, audio_out_sample_rate=48000,
                ))
                service.acknowledgement_output = output
                armed, draining, generating = asyncio.Event(), asyncio.Event(), asyncio.Event()
                release_drain, release_generation = asyncio.Event(), asyncio.Event()
                ready = service.session_ready = asyncio.get_running_loop().create_future()
                native_arm = output.arm_acknowledgement
                output.cancel_acknowledgement = Mock(wraps=output.cancel_acknowledgement)

                def arm(record):
                    native_arm(record)
                    output.acknowledgement_timer.cancel()
                    output.cancel_acknowledgement.reset_mock()
                    armed.set()

                output.arm_acknowledgement = Mock(side_effect=arm)

                async def drain():
                    draining.set()
                    await release_drain.wait()

                async def exchange(history, events, *, admitted, desktop):
                    events.put_nowait({'delivery': 'neutral'})
                    events.put_nowait({'text': 'An answer.'})
                    generating.set()
                    await release_generation.wait()
                    if outcome == 'failure':
                        events.put_nowait({'advisory': 'The engine failed.'})
                    events.put_nowait(None)

                service.channel.drain = drain
                service.channel.exchange = exchange
                service.push_frame = AsyncMock()
                service.start_processing_metrics = AsyncMock()
                service.stop_processing_metrics = AsyncMock()
                task = asyncio.create_task(service.process_frame(
                    request_frame(service, bot.LLMContext([{'role': 'user', 'content': 'An ordinary question.'}])),
                    FrameDirection.DOWNSTREAM,
                ))
                try:
                    await asyncio.wait_for(armed.wait(), 5)
                    record = output.arm_acknowledgement.call_args.args[0]
                    self.assertIs(service.current_reply(), record)
                    output.cancel_acknowledgement.assert_not_called()
                    ready.set_result(True)
                    await asyncio.wait_for(draining.wait(), 5)
                    self.assertIs(service.current_reply(), record)
                    output.cancel_acknowledgement.assert_not_called()
                    release_drain.set()
                    await asyncio.wait_for(generating.wait(), 5)
                    self.assertIs(service.current_reply(), record)
                    output.arm_acknowledgement.assert_called_once_with(record)
                    output.cancel_acknowledgement.assert_not_called()
                    if outcome == 'revoke':
                        service.admission.close()
                        service.revoke()
                        self.assertTrue(output.cancel_acknowledgement.called)
                    release_generation.set()
                    await asyncio.wait_for(task, 5)
                    if outcome == 'complete':
                        output.cancel_acknowledgement.assert_not_called()
                        record.finish()
                        output.cancel_acknowledgement.assert_called_with(record)
                    elif outcome == 'failure':
                        output.cancel_acknowledgement.assert_called_with(record)
                    else:
                        self.assertTrue(output.cancel_acknowledgement.called)
                finally:
                    release_drain.set()
                    release_generation.set()
                    if not ready.done():
                        ready.set_result(True)
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    await output._observe_acknowledgement_tasks()
        service = hermes_service()
        service.acknowledgement_output = output = Mock(spec=speech.LaptopOutput)
        service.push_frame = AsyncMock()
        await service.process_frame(
            request_frame(service, bot.LLMContext([{'role': 'user', 'content': 'What can I say?'}])),
            FrameDirection.DOWNSTREAM,
        )
        output.arm_acknowledgement.assert_not_called()


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_detached_incomplete_turn_drains_and_next_exchange_succeeds(self):
        channel = bot.HermesRequestChannel()
        process = channel.process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.wait = AsyncMock()
        detached_output = asyncio.Queue()
        events = iter([{'incomplete': True}, {'delivery': 'neutral'}, {'text': 'Fifteen.'}, {'done': True}])

        async def read_event():
            event = next(events)
            if event == {'incomplete': True}:
                channel.detach(detached_output)
            return json.dumps(event).encode() + b'\n'

        process.stdout.readline = AsyncMock(side_effect=read_event)
        await channel.exchange([{'role': 'user', 'content': 'Old request.'}], detached_output,
                               admitted=lambda: True)
        self.assertTrue(detached_output.empty(), 'Detached completion cannot append an advisory or terminal marker')
        self.assertIsNone(channel.failure)
        self.assertIsNone(channel.failure_advisory)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
        process.wait.assert_not_awaited()

        output = asyncio.Queue()
        await channel.exchange([{'role': 'user', 'content': 'What is seven plus eight?'}], output,
                               admitted=lambda: True)
        self.assertEqual([output.get_nowait() for _ in range(output.qsize())],
                         [{'delivery': 'neutral'}, {'text': 'Fifteen.'}, None])
        self.assertTrue(detached_output.empty())
        self.assertIs(channel.process, process)
        self.assertIsNone(channel.failure)
        self.assertIsNone(channel.failure_advisory)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
        process.wait.assert_not_awaited()
        self.assertEqual([json.loads(c.args[0]) for c in process.stdin.write.call_args_list], [
            {'messages': [{'role': 'user', 'content': 'Old request.'}]},
            {'messages': [{'role': 'user', 'content': 'What is seven plus eight?'}]},
        ])

    async def test_desktop_call_envelopes_are_validated_before_execution(self):
        valid = {'tool_call': {'name': 'mute', 'arguments': {}}}
        cases = [
            (valid, True),
            ({'tool_call': {'name': 'mute', 'arguments': {}}, 'text': 'Hidden.'}, False),
            ({'tool_call': {'name': 'mute', 'arguments': {}, 'extra': True}}, False),
            ({'tool_call': {'arguments': {}}}, False),
            ({'tool_call': {'name': 'mute'}}, False),
            ({'tool_call': {'name': 'launch_app', 'arguments': {}}}, False),
            ({'tool_call': {'name': ['mute'], 'arguments': {}}}, False),
            ({'tool_call': {'name': 'mute', 'arguments': []}}, False),
            ({'tool_call': []}, False),
            ({'tool_call': None}, False),
        ]
        content = '{"confirmed":true,"attempted":true,"reason":"confirmed"}'
        continuation = [{'delivery': 'neutral'}, {'text': 'Confirmed.'}, {'done': True}]
        for event, accepted in cases:
            with self.subTest(event=event):
                service = hermes_service()
                process = service.channel.process = Mock(returncode=None)
                process.stdin.drain = AsyncMock()
                process.stdout.readline = AsyncMock(side_effect=[
                    json.dumps(item).encode() + b'\n' for item in [event, *continuation]
                ])
                process.wait = AsyncMock()
                desktop = AsyncMock(return_value=content)
                output = asyncio.Queue()
                await service.channel.exchange([{'role': 'user', 'content': 'Please mute.'}], output,
                                               admitted=service.admission.is_open, desktop=desktop)
                writes = [json.loads(c.args[0]) for c in process.stdin.write.call_args_list]
                self.assertEqual(writes[0], {'messages': [{'role': 'user', 'content': 'Please mute.'}]})
                observed = []
                while not output.empty():
                    observed.append(output.get_nowait())
                if accepted:
                    desktop.assert_awaited_once_with('mute', {})
                    self.assertEqual(writes[1:], [{'tool_result': content, 'source': 'kestrel'}])
                    self.assertEqual(observed, [*continuation[:-1], None])
                    self.assertIsNone(service.channel.failure)
                    process.terminate.assert_not_called()
                else:
                    desktop.assert_not_awaited()
                    self.assertEqual(writes[1:], [])
                    self.assertEqual(observed, [None])
                    self.assertIn('Invalid or incomplete Hermes response', service.channel.failure)
                    process.terminate.assert_called_once()
                    process.wait.assert_awaited_once()
        service = hermes_service()
        process = service.channel.process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.stdout.readline = AsyncMock(return_value=json.dumps(valid).encode() + b'\n')
        process.wait = AsyncMock()
        output = asyncio.Queue()
        await service.channel._request({'prepare': True}, output, admitted=service.admission.is_open)
        self.assertIn('Invalid or incomplete Hermes response', service.channel.failure)
        self.assertEqual([json.loads(c.args[0]) for c in process.stdin.write.call_args_list], [{'prepare': True}])
        self.assertIsNone(output.get_nowait())
        self.assertTrue(output.empty())
        process.terminate.assert_called_once()
        process.wait.assert_awaited_once()

    async def test_outside_text_refusal_events_are_validated_and_spoken_once(self):
        refusal = {'tool_refused': True}
        continuation = [{'delivery': 'neutral'}, {'text': 'Done.'}, {'done': True}]
        cases = [
            ([refusal, refusal], True),
            ([{'tool_refused': False}], False),
            ([{'tool_refused': 'memory'}], False),
            ([{'tool_refused': True, 'text': 'Hidden.'}], False),
        ]
        for events, accepted in cases:
            with self.subTest(events=events):
                service = hermes_service()
                process = service.channel.process = Mock(returncode=None)
                process.stdin.drain = AsyncMock()
                process.stdout.readline = AsyncMock(side_effect=[
                    json.dumps(item).encode() + b'\n' for item in [*events, *continuation]
                ])
                process.wait = AsyncMock()
                output = asyncio.Queue()
                await service.channel.exchange([{'role': 'user', 'content': 'Please save a note.'}], output,
                                               admitted=service.admission.is_open, desktop=AsyncMock())
                observed = []
                while not output.empty():
                    observed.append(output.get_nowait())
                if accepted:
                    self.assertEqual(observed, [{'advisory': bot.OUTSIDE_TEXT_ADVISORY}, *continuation[:-1], None])
                    self.assertIsNone(service.channel.failure)
                    process.terminate.assert_not_called()
                else:
                    self.assertEqual(observed, [None])
                    self.assertIn('Invalid or incomplete Hermes response', service.channel.failure)
                    process.terminate.assert_called_once()
        service = hermes_service()
        process = service.channel.process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.stdout.readline = AsyncMock(side_effect=[json.dumps(refusal).encode() + b'\n'])
        process.wait = AsyncMock()
        output = asyncio.Queue()
        await service.channel._request({'prepare': True}, output, admitted=service.admission.is_open)
        self.assertIn('Invalid or incomplete Hermes response', service.channel.failure)
        self.assertIsNone(output.get_nowait())
        self.assertTrue(output.empty())
        process.terminate.assert_called_once()

    async def test_brain_app_and_screenshot_arguments_are_refused_before_lookup_or_effect(self):
        cases = [
            ('take_screenshot', {'extra': 1}),
            ('open_app', {}),
            ('open_app', {'name': 123}),
            ('open_app', {'name': ''}),
            ('open_app', {'name': '   '}),
            ('open_app', {'name': 'Fire\x07fox'}),
            # Within the shared 1,024-character bound, beyond the resolver's 1,024-byte limit.
            ('open_app', {'name': 'é' * 600}),
            ('open_app', {'name': 'x' * 1025}),
            ('open_app', {'name': 'A', 'extra': 1}),
        ]
        command = AsyncMock(side_effect=AssertionError('Refused arguments must never reach lookup or effect'))
        service = hermes_service(local_command=command)
        for name, arguments in cases:
            with self.subTest(name=name, arguments=arguments):
                # An unknown name is refused before any argument check, so each case must name a desktop tool.
                self.assertIn(name, bot.TOOL_CATALOGUE)
                turn = bot.BrainTurn(names=set(), user={'role': 'user', 'content': 'Open it.'},
                                     epoch=service.stop_epoch, records=[])
                result = await service.desktop_call(turn, object(), asyncio.Queue(), name, arguments)
                self.assertEqual(json.loads(result), {'confirmed': False, 'attempted': False, 'reason': 'invalid arguments'})
                self.assertTrue(turn.closed)
                self.assertEqual(turn.records, [])
        command.assert_not_awaited()

    async def test_delivery_events_are_validated_before_text(self):
        cases = [
            ([{'delivery': 'curious'}, {'text': 'Hello.'}, {'done': True}], True),
            ([{'delivery': ['curious']}], False),
            ([{'delivery': 'unknown'}], False),
            ([{'delivery': 'neutral', 'text': 'Hidden.'}], False),
            ([{'text': 'Hidden.'}], False),
            ([{'delivery': 'curious'}, {'delivery': 'neutral'}], False),
            ([{'delivery': 'curious'}, {'text': 'Hello.'}, {'delivery': 'neutral'}], False),
            ([{'delivery': 'neutral'}, {'done': True}], False),
            ([{'delivery': 'neutral'}, {'text': ' '}, {'done': True}], False),
            ([{'done': True}], False),
        ]
        for events, valid in cases:
            with self.subTest(events=events):
                service = hermes_service()
                service.channel.process = Mock(returncode=None)
                service.channel.process.stdin.drain = AsyncMock()
                service.channel.process.stdout.readline = AsyncMock(
                    side_effect=[json.dumps(event).encode() + b'\n' for event in events])
                service.channel.process.wait = AsyncMock()
                output = asyncio.Queue()
                service.output = output
                await service.channel.exchange([{'role': 'user', 'content': 'Hello.'}], output, admitted=service.admission.is_open)
                observed = []
                while not output.empty():
                    observed.append(output.get_nowait())
                self.assertIsNone(observed.pop())
                self.assertEqual(service.channel.failure is None, valid)
                if valid:
                    self.assertEqual(observed, events[:-1])
                    service.channel.process.terminate.assert_not_called()
                else:
                    self.assertIn('Invalid or incomplete Hermes response', service.channel.failure)
                    service.channel.process.terminate.assert_called_once()
                    service.channel.process.wait.assert_awaited_once()
                    self.assertNotIn({'text': 'Hidden.'}, observed)
        for events, delivery in [
            ([{'delivery': 'reassuring'}, {'text': 'Hello.'}, {'done': True}], 'reassuring'),
            ([{'text': 'Hidden.'}], 'neutral'),
        ]:
            service = hermes_service()
            service.channel.process = Mock(returncode=None)
            service.channel.process.stdin.drain = AsyncMock()
            service.channel.process.stdout.readline = AsyncMock(
                side_effect=[json.dumps(event).encode() + b'\n' for event in events])
            service.channel.process.wait = AsyncMock()
            service.push_frame = AsyncMock()
            service.start_processing_metrics = AsyncMock()
            service.stop_processing_metrics = AsyncMock()
            await service.process_frame(
                request_frame(service, bot.LLMContext([{'role': 'user', 'content': 'Hello.'}])),
                FrameDirection.DOWNSTREAM,
            )
            frames = [call.args[0] for call in service.push_frame.call_args_list]
            starts = [f for f in frames if isinstance(f, bot.LLMFullResponseStartFrame)]
            self.assertEqual(len(starts), 1)
            self.assertEqual(starts[0].reply_progress.delivery, delivery)
            self.assertEqual(sum(isinstance(f, LLMFullResponseEndFrame) for f in frames), 1)
            self.assertEqual([f.text.strip() for f in frames if isinstance(f, LLMTextFrame)],
                             ['Hello.'] if delivery == 'reassuring' else
                             ["I couldn't reach Kestrel's engine. Restart Kestrel and try again."])

        entered, release = asyncio.Event(), asyncio.Event()
        service = hermes_service()
        service.channel.process = Mock(returncode=None)
        service.channel.process.stdin.drain = AsyncMock()
        events = iter([{'delivery': 'curious'}, {'text': 'Old reply.'}, {'done': True}])
        async def read_response():
            entered.set()
            await release.wait()
            return json.dumps(next(events)).encode() + b'\n'
        service.channel.process.stdout.readline = read_response
        service.push_frame = AsyncMock()
        service.start_processing_metrics = AsyncMock()
        service.stop_processing_metrics = AsyncMock()
        pending = asyncio.create_task(service.process_frame(
            request_frame(service, bot.LLMContext([{'role': 'user', 'content': 'Old request.'}])),
            FrameDirection.DOWNSTREAM,
        ))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            release.set()
            await asyncio.wait_for(service.channel.reader, 5)
            frames = [call.args[0] for call in service.push_frame.call_args_list]
            starts = [f for f in frames if isinstance(f, bot.LLMFullResponseStartFrame)]
            self.assertEqual(len(starts), 1)
            self.assertEqual(starts[0].reply_progress.delivery, 'neutral')
            self.assertEqual(sum(isinstance(f, LLMFullResponseEndFrame) for f in frames), 1)
            self.assertFalse(any(isinstance(f, LLMTextFrame) for f in frames))
            self.assertIsNone(service.output)
        finally:
            release.set()
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            if service.channel.reader is not None:
                await service.channel.reader

    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.voices = Path(home.name)
        self.reference_pcm = b'\x01\x00' * 480
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(self.reference_pcm)
        self.reference_wav = output.getvalue()
        for name, transcript in [('irish-female', 'Irish fixture.'), ('british-male', 'British fixture.'),
                                 ('third', 'Third fixture.')]:
            (self.voices / (name + '.wav')).write_bytes(self.reference_wav)
            (self.voices / (name + '.txt')).write_text(transcript)
        selection = patch.object(bot, 'load_voice_preset', partial(speech.load_voice_preset, voices_dir=self.voices))
        selection.start()
        self.addCleanup(selection.stop)
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('KESTREL_VOICE', None)
        os.environ['KESTREL_TTS_MODEL'] = 'voxcpm2'
        runtime = self.voices / 'runtime'
        runtime.mkdir(mode=0o700)
        os.environ['XDG_RUNTIME_DIR'] = str(runtime)
        self.audio = Mock(open=AsyncMock(), close=AsyncMock(), failure=None)
        audio = patch.object(bot, "LaptopAudioTransport", return_value=self.audio)
        audio.start()
        self.addCleanup(audio.stop)
        def chunks(**kwargs):
            yield np.zeros(8, dtype=np.float32)

        self.voice = Mock(generate_streaming=Mock(side_effect=chunks))
        voice = patch.object(bot.VoxCPM, "from_pretrained", return_value=self.voice)
        voice.start()
        self.addCleanup(voice.stop)
        engine = patch.object(self, 'startup_service', side_effect=lambda: Mock(
            local_actions=Mock(close=AsyncMock(), drain=AsyncMock()),
            channel=Mock(prepare=AsyncMock(), begin_conversation=AsyncMock(return_value=True),
                         close=AsyncMock(), drain=AsyncMock(), known_unavailable=Mock(return_value=False),
                         failure=None, reader=None, preparation=None),
        ))
        engine.start()
        self.addCleanup(engine.stop)
        self.output_watch = Mock(start=AsyncMock(), close=AsyncMock(), revision=0)
        watcher = patch.object(bot, 'OutputDeviceWatch', return_value=self.output_watch)
        watcher.start()
        self.addCleanup(watcher.stop)
        native_conversations = bot.VoiceConversations

        def conversations(**kwargs):
            prototype = self.startup_service()
            with (patch.object(bot, 'HermesRequestChannel', return_value=prototype.channel),
                  patch.object(bot, 'LocalActions', return_value=prototype.local_actions)):
                manager = native_conversations(**kwargs)
            if not isinstance(manager.recognizer, speech.NemotronRecognizer):
                manager.recognizer.drain = AsyncMock()
                manager.recognizer.failure = None
            activate = manager.activate

            def adapter(channel, *, local_actions, admission, session_ready, dismiss, status, conversation, acknowledgement_output,
                        hear_answer):
                prototype.session_ready = session_ready
                prototype.dismiss = dismiss
                prototype.admission = admission
                prototype.status = status
                prototype.conversation = conversation
                prototype.acknowledgement_output = acknowledgement_output
                prototype.hear_answer = hear_answer
                return prototype

            async def activate_fixture(*, capture_enabled=True):
                manager.lifecycle_changed = False
                with patch.object(bot, 'HermesLLMService', side_effect=adapter):
                    await activate(capture_enabled=capture_enabled)

            manager.activate = activate_fixture

            async def run_fixture():
                from desktop import control
                self.assertEqual(await control.toggle(), 'starting')
                await manager.activate()
                if manager.pipeline is not None:
                    await manager.pipeline

            manager.run = run_fixture
            return manager

        binding = patch.object(bot, 'VoiceConversations', side_effect=conversations)
        binding.start()
        self.addCleanup(binding.stop)

    def startup_service(self):
        return hermes_service()

    async def run_bot(self, *, activations=1):
        from desktop import control
        manager = bot.VoiceConversations(status=bot.IndicatorStatus(), conversation=bot.ConversationFeed())
        command = control.ConversationControl(manager.toggle)
        try:
            await command.start()
            await manager.prepare()
            self.assertEqual(await control.toggle(), 'starting')
            manager.lifecycle_changed = False
            for index in range(activations):
                await manager.activate()
                if manager.pipeline is not None:
                    await manager.pipeline
                if index + 1 < activations:
                    await manager.finish_conversation()
        finally:
            try:
                await manager.close()
            finally:
                await command.close()

    async def test_catalogue_mismatch_refuses_startup_before_resources(self):
        actions = tool_actions.TOOL_ACTIONS.copy()
        cases = [
            ('missing: mute', {key: action for key, action in actions.items() if key != 'mute'}),
            ('extra: extra_tool', actions | {'extra_tool': tool_actions.ToolAction(AsyncMock())}),
            ('invalid run: mute', actions | {'mute': tool_actions.ToolAction(None)}),
            ('invalid lookup: open_app', actions | {'open_app': bot.replace(actions['open_app'], lookup=None)}),
            ('invalid lookup: open_app', actions | {'open_app': bot.replace(actions['open_app'], lookup=1)}),
            ('invalid lookup: mute', actions | {'mute': bot.replace(actions['mute'], lookup=AsyncMock())}),
        ]
        original_bot = sys.modules['bot']
        original_tool = bot.LocalTool
        module_name = '_kestrel_catalogue_startup_test'
        missing = object()
        original_slot = sys.modules.get(module_name, missing)
        original_argv0 = sys.argv[0]
        echoes = []
        stt = Mock(load=AsyncMock())

        def echo_removal():
            echo = Mock(start=Mock())
            echoes.append(echo)
            return echo

        with (
            patch('desktop.status.IndicatorStatus') as status,
            patch('desktop.conversation.ConversationFeed') as feed,
            patch('desktop.control.ConversationControl') as control,
            patch.object(speech, 'EchoRemoval', side_effect=echo_removal) as echo_factory,
            patch.object(speech, 'NemotronSTT', return_value=stt) as recognizer_adapter,
            patch.object(speech, 'NemotronRecognizer', return_value=stt) as recognizer,
            patch('voxcpm.VoxCPM.from_pretrained') as voxcpm,
            patch.object(speech, 'load_phonon') as phonon,
        ):
            for problem, configured in [(None, actions), *cases]:
                with self.subTest(problem=problem, lookup=configured.get('open_app')):
                    try:
                        try:
                            with patch.dict(tool_actions.TOOL_ACTIONS, configured, clear=True):
                                if problem is None:
                                    namespace = runpy.run_module('bot', run_name=module_name, alter_sys=True)
                                    self.assertEqual(set(namespace['LOCAL_TOOLS']), {
                                        'mute', 'unmute', 'set_volume', 'pause_media', 'next_track',
                                        'focus_workspace', 'open_app', 'take_screenshot', 'delete_note',
                                    })
                                else:
                                    with self.assertRaisesRegex(RuntimeError, '^Kestrel tool catalogue mismatch') as refused:
                                        runpy.run_module('bot', run_name=module_name, alter_sys=True)
                                    self.assertIn(problem, str(refused.exception))
                                    self.assertIn('Check the tool catalogue and run steps, then restart Kestrel.',
                                                  str(refused.exception))
                        finally:
                            self.assertIs(sys.modules['bot'], original_bot)
                            self.assertIs(bot.LocalTool, original_tool)
                            self.assertIs(sys.modules.get(module_name, missing), original_slot)
                            self.assertEqual(sys.argv[0], original_argv0)
                        status.assert_not_called()
                        feed.assert_not_called()
                        control.assert_not_called()
                        echo_factory.assert_called_once_with()
                        self.assertEqual(len(echoes), 1)
                        echoes[0].start.assert_not_called()
                        recognizer_adapter.assert_not_called()
                        recognizer.assert_not_called()
                        stt.load.assert_not_awaited()
                        voxcpm.assert_not_called()
                        phonon.assert_not_called()
                    finally:
                        for observer in (status, feed, control, echo_factory, recognizer_adapter, recognizer,
                                         stt.load, voxcpm, phonon):
                            observer.reset_mock()
                        echoes.clear()

    async def test_indicator_startup_and_release_order(self):
        with tempfile.TemporaryDirectory() as runtime:
            snapshot = Path(runtime) / 'kestrel/indicator.json'
            observations = []
            self.audio.capture = None

            def observe(boundary):
                exists = snapshot.exists()
                state = json.loads(snapshot.read_text())['state'] if exists else None
                observations.append((boundary, exists, state))

            stt = Mock(load=AsyncMock(), close=AsyncMock())
            self.output_watch.start.side_effect = lambda on_change, on_failed: observe('watch-start')
            self.output_watch.close.side_effect = lambda: observe('watch-close')
            self.audio.close.side_effect = lambda: observe('transport-close')
            loop = asyncio.get_running_loop()
            with (
                patch.dict(os.environ, XDG_RUNTIME_DIR=runtime),
                patch.object(bot, 'NemotronSTT', return_value=stt),
                patch.object(bot, 'NemotronRecognizer', return_value=stt),
                patch.object(bot, 'run_conversation', new=AsyncMock()),
                patch.object(bot.ECHO_REMOVAL, 'start', side_effect=lambda callback: observe('echo-start')),
                patch.object(bot.ECHO_REMOVAL, 'close', side_effect=lambda: observe('echo-close')),
                patch.object(loop, 'add_signal_handler'),
                patch.object(loop, 'remove_signal_handler'),
                patch.object(bot.torch, 'set_num_threads'),
            ):
                await bot.run_voice_service()
            self.assertTrue(observations[0][1], 'Starting status must exist before microphone startup')
            self.assertEqual(observations[0], ('watch-start', True, 'starting'))
            self.assertEqual(observations[1], ('echo-start', True, 'starting'))
            self.assertEqual([row[0] for row in observations],
                             ['watch-start', 'echo-start', 'watch-close', 'transport-close', 'echo-close'])
            self.output_watch.start.assert_awaited_once()
            self.output_watch.close.assert_awaited_once_with()
            self.assertTrue(all(row[2] != 'released' for row in observations[1:]))
            self.assertTrue(snapshot.exists(), 'Cleanup must leave a release receipt')
            self.assertEqual(json.loads(snapshot.read_text())['state'], 'released')

    async def test_indicator_publication_failure_preserves_voice(self):
        for failure in ('publication', 'delayed-startup', 'model-startup', 'transport-close', 'echo-close', 'echo-failure', 'transport-close-interrupted'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as runtime:
                self.audio.capture = None
                self.audio.reset_mock()
                self.output_watch.reset_mock()
                self.audio.close.side_effect = RuntimeError('transport cleanup failed') if failure == 'transport-close' else None
                if failure == 'publication':
                    (Path(runtime) / 'kestrel').symlink_to(self.voices, target_is_directory=True)
                entered, release = asyncio.Event(), asyncio.Event()

                async def load(reference_pcm):
                    entered.set()
                    if failure == 'delayed-startup':
                        await release.wait()
                    if failure == 'model-startup':
                        raise RuntimeError('model startup failed')

                stt = Mock(load=AsyncMock(side_effect=load), close=AsyncMock())
                loop = asyncio.get_running_loop()
                handlers, echo_callbacks = {}, []

                if failure == 'transport-close-interrupted':
                    async def interrupted_close():
                        handlers[signal.SIGTERM]()
                        raise asyncio.CancelledError

                    self.audio.close.side_effect = interrupted_close

                async def converse(*args, **kwargs):
                    if failure == 'echo-failure':
                        echo_callbacks[0]()
                        await asyncio.Event().wait()

                conversation = AsyncMock(side_effect=converse)
                errors = io.StringIO()
                with (
                    patch.dict(os.environ, XDG_RUNTIME_DIR=runtime),
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot, 'run_conversation', conversation),
                    patch.object(bot.ECHO_REMOVAL, 'start', side_effect=echo_callbacks.append),
                    patch.object(bot.ECHO_REMOVAL, 'close', side_effect=(
                        RuntimeError('echo cleanup failed') if failure == 'echo-close' else None)),
                    patch.object(loop, 'add_signal_handler', side_effect=lambda sig, callback: handlers.update({sig: callback})),
                    patch.object(loop, 'remove_signal_handler'),
                    patch.object(bot.os, 'kill', side_effect=lambda pid, sig: handlers[sig]()),
                    patch.object(bot.torch, 'set_num_threads'),
                    patch('sys.stderr', errors),
                ):
                    task = asyncio.create_task(bot.run_voice_service())
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        snapshot = Path(runtime) / 'kestrel/indicator.json'
                        if failure == 'delayed-startup':
                            self.assertEqual(json.loads(snapshot.read_text())['state'], 'starting')
                            self.assertFalse(task.done())
                        release.set()
                        if failure == 'transport-close-interrupted':
                            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
                        elif failure in ('model-startup', 'transport-close', 'echo-close', 'echo-failure'):
                            with self.assertRaises(RuntimeError):
                                await asyncio.wait_for(task, 5)
                        else:
                            await asyncio.wait_for(task, 5)
                        stt.close.assert_awaited_once()
                        self.output_watch.start.assert_awaited_once()
                        self.output_watch.close.assert_awaited_once_with()
                        if failure == 'model-startup':
                            self.audio.close.assert_not_awaited()
                        else:
                            self.audio.close.assert_awaited_once()
                        if failure == 'publication':
                            conversation.assert_awaited_once()
                            self.assertEqual(errors.getvalue().count('Microphone use unknown.'), 1)
                            self.assertFalse(snapshot.exists())
                        else:
                            self.assertTrue(snapshot.exists())
                            expected = 'released' if failure == 'delayed-startup' else 'unavailable'
                            self.assertEqual(json.loads(snapshot.read_text())['state'], expected)
                    finally:
                        release.set()
                        if not task.done():
                            task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

    async def prepared_channel(self, times, *, fail_open=False):
        channel = bot.HermesRequestChannel()

        async def open_engine():
            if fail_open:
                channel.failure = 'Hermes engine unavailable: boom'

        channel._open = AsyncMock(side_effect=open_engine)
        channel._request = AsyncMock()
        with patch.object(channel, '_now', side_effect=times) as now:
            await channel.prepare()
        return channel, now

    async def test_preparation_at_eight_seconds_is_not_slow(self):
        channel, now = await self.prepared_channel([100.0, 108.0])
        self.assertEqual(now.call_count, 2)
        self.assertFalse(channel.slow_start)

    async def test_preparation_over_eight_seconds_marks_slow_start(self):
        channel, now = await self.prepared_channel([100.0, 108.5])
        self.assertEqual(now.call_count, 2)
        self.assertTrue(channel.slow_start)
        self.assertTrue(channel.slow_start_pending())

    async def test_failed_slow_preparation_never_marks_slow_start(self):
        channel = bot.HermesRequestChannel()

        async def fail_request(*args, **kwargs):
            channel.failure = 'Hermes reply failed: TimeoutError'

        channel._open = AsyncMock()
        channel._request = AsyncMock(side_effect=fail_request)
        with patch.object(channel, '_now', side_effect=[100.0, 109.0]):
            await channel.prepare()
        self.assertFalse(channel.slow_start)
        self.assertFalse(channel.slow_start_pending())

    async def test_engine_failure_ends_pending_slow_start(self):
        channel, _ = await self.prepared_channel([100.0, 108.5])
        self.assertTrue(channel.slow_start_pending())
        channel.failure = 'Hermes reply failed: RuntimeError'
        self.assertFalse(channel.slow_start_pending())

    async def test_failed_engine_open_is_never_timed(self):
        channel, now = await self.prepared_channel([], fail_open=True)
        now.assert_not_called()
        channel._request.assert_not_awaited()
        self.assertFalse(channel.slow_start)

    async def opened_channel(self, spawned):
        """Opens a real channel whose engine spawn raises `spawned`, or starts a worker whose first event is `spawned`."""
        channel = bot.HermesRequestChannel()
        self.addAsyncCleanup(channel.close)
        if isinstance(spawned, BaseException):
            spawn = AsyncMock(side_effect=spawned)
        else:
            process = Mock(returncode=0)
            process.stdout.readline = AsyncMock(return_value=json.dumps(spawned).encode() + b'\n')
            spawn = AsyncMock(return_value=process)
        with patch.dict(os.environ), patch.object(bot.asyncio, 'create_subprocess_exec', spawn):
            os.environ.pop('KESTREL_MANAGED_BRAIN', None)
            await channel._open()
        spawn.assert_awaited_once()
        return channel

    async def test_engine_open_names_only_verified_missing_causes(self):
        generic = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        for cause, spawned, advisory in (
            ('spawn finds no interpreter', FileNotFoundError(2, 'No such file or directory'), ENGINE_MISSING_ADVICE),
            ('spawn may not run the interpreter', PermissionError(13, 'Permission denied'), ENGINE_MISSING_ADVICE),
            ('spawn hits another system error', OSError(24, 'Too many open files'), generic),
            ('worker refuses the source identity', {'error': SOURCE_IDENTITY_REFUSAL}, ENGINE_MISSING_ADVICE),
            ('worker cannot load engine files', {'error': ENGINE_LOAD_REFUSAL}, ENGINE_MISSING_ADVICE),
            ('identity refusal cut short',
             {'error': SOURCE_IDENTITY_REFUSAL[:SOURCE_IDENTITY_REFUSAL.index(' Reinstall')]}, generic),
            ('error that is a list', {'error': [SOURCE_IDENTITY_REFUSAL]}, generic),
            ('ready', {'ready': True}, None),
        ):
            with self.subTest(cause=cause):
                channel = await self.opened_channel(spawned)
                self.assertEqual(channel.failure_advisory, advisory)
                if advisory is None:
                    self.assertIsNone(channel.failure)
                elif isinstance(spawned, dict) and isinstance(spawned['error'], list):
                    self.assertEqual(channel.failure, f'Hermes engine unavailable: {[SOURCE_IDENTITY_REFUSAL]}')

    async def test_engine_trouble_shows_whether_voice_is_on_or_off(self):
        from types import SimpleNamespace
        missing = await self.opened_channel(FileNotFoundError(2, 'No such file or directory'))
        self.assertEqual(missing.failure_advisory, ENGINE_MISSING_ADVICE)
        # Engine trouble outranks a slow start, whichever came first.
        missing.slow_start = True
        llm = SimpleNamespace(
            status=Mock(), admission=SimpleNamespace(is_open=lambda: True), channel=missing, _indicator_ready=True,
            _indicator_voice_failed=False, _indicator_user=False, _indicator_output=False, _indicator_pending=False,
        )
        bot.HermesLLMService.refresh_indicator(llm)
        self.assertEqual(llm.status.set_state.call_args_list, [call('trouble-engine-missing')])
        self.assertEqual(NATIVE_VOICE_CONVERSATIONS.inactive_state(SimpleNamespace(channel=missing)), 'trouble-engine-missing')

    async def test_any_engine_failure_shows_trouble_while_voice_is_off(self):
        from types import SimpleNamespace
        unreached = await self.opened_channel(OSError(24, 'Too many open files'))
        self.assertEqual(unreached.failure_advisory, "I couldn't reach Kestrel's engine. Restart Kestrel and try again.")
        self.assertEqual(NATIVE_VOICE_CONVERSATIONS.inactive_state(SimpleNamespace(channel=unreached)), 'trouble-engine')

    async def test_engine_preparation_overlaps_local_models_and_is_closed_on_early_exit(self):
        preparing = asyncio.Event()
        loading = asyncio.Event()
        release_local = asyncio.Event()
        hold_preparation = asyncio.Event()
        received_services = []
        preparation_pending = []

        async def prepare():
            preparing.set()
            await hold_preparation.wait()

        async def load_local(reference_pcm):
            loading.set()
            await release_local.wait()

        service = hermes_service()
        service.channel.prepare = AsyncMock(side_effect=prepare)
        service.local_actions.close = AsyncMock(wraps=service.local_actions.close)
        service.channel.close = AsyncMock(wraps=service.channel.close)
        stt = Mock(load=AsyncMock(side_effect=load_local), close=AsyncMock())

        async def conversation(stt, voice, *, llm, transport, handle_signals, on_frame_completed, typed_origin, status=None, conversation=None, on_ingress_ready=None, on_reply_finished=None, input_paused=lambda: False):
            received_services.append(llm)
            preparation_pending.append(llm is not None and not llm.channel.preparation.done())

        with (
            patch.object(bot, 'NemotronSTT', return_value=stt),
            patch.object(bot, 'NemotronRecognizer', return_value=stt),
            patch.object(self, 'startup_service', return_value=service),
            patch.object(bot, 'run_conversation', conversation),
            patch.object(bot.torch, 'set_num_threads'),
        ):
            task = asyncio.create_task(self.run_bot())
            try:
                await asyncio.wait_for(loading.wait(), 5)
                self.assertTrue(preparing.is_set(), 'Engine preparation starts while local loading is held')
                reader = service.channel.preparation
                self.assertFalse(reader.done())
                release_local.set()
                await asyncio.wait_for(task, 5)
                self.assertEqual(received_services, [service])
                self.assertEqual(preparation_pending, [True])
                self.assertTrue(reader.done())
                service.local_actions.close.assert_awaited_once()
                service.channel.close.assert_awaited_once()
                stt.close.assert_awaited_once()
                self.audio.close.assert_awaited()
            finally:
                release_local.set()
                hold_preparation.set()
                await asyncio.wait_for(task, 5)

        for failure in ('local_model_failure', 'early_shutdown', 'conversation_failure'):
            with self.subTest(failure=failure):
                self.audio.reset_mock()
                service = hermes_service()
                service.channel.prepare = AsyncMock(side_effect=asyncio.Event().wait)
                service.local_actions.close = AsyncMock(wraps=service.local_actions.close)
                native_close = service.channel.close
                readers = []

                async def close_engine():
                    readers.append(service.channel.preparation)
                    await native_close()

                service.channel.close = AsyncMock(side_effect=close_engine)
                stt = Mock(load=AsyncMock(), close=AsyncMock())
                if failure == 'local_model_failure':
                    stt.load.side_effect = RuntimeError('local model failed')
                elif failure == 'early_shutdown':
                    stt.load.side_effect = asyncio.CancelledError
                conversation = AsyncMock(
                    side_effect=RuntimeError('conversation construction failed')
                    if failure == 'conversation_failure' else None,
                )
                with (
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(self, 'startup_service', return_value=service),
                    patch.object(bot, 'run_conversation', conversation),
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    if failure == 'early_shutdown':
                        with self.assertRaises(asyncio.CancelledError):
                            await self.run_bot()
                    else:
                        with self.assertRaises(RuntimeError):
                            await self.run_bot()
                    service.local_actions.close.assert_awaited_once()
                    service.channel.close.assert_awaited_once()
                    self.assertTrue(readers[0].done())
                    stt.close.assert_awaited_once()
                    if failure == 'conversation_failure':
                        self.audio.close.assert_awaited()
                        self.assertIs(conversation.await_args.kwargs['llm'], service)
                    else:
                        self.audio.close.assert_not_awaited()
                        conversation.assert_not_awaited()

    async def test_invalid_voice_presets_stop_before_model_loading(self):
        cases = [('', 'name'), ('../private-transcript', 'name'), ('unknown', 'missing')]
        for label, suffix, data, reason in [
            ('missing-text', 'txt', None, 'missing'),
            ('invalid-utf8', 'txt', b'\xffprivate transcript', 'UTF-8'),
            ('blank', 'txt', b' \t\n', 'blank'),
            ('control', 'txt', b'private transcript\x00', 'control'),
            ('large-text', 'txt', b'x' * 4097, '4096'),
            ('malformed', 'wav', b'not a WAV', 'malformed WAV'),
            ('truncated', 'wav', self.reference_wav[:-2], 'truncated'),
            ('empty', 'wav', self.reference_wav[:40] + struct.pack('<I', 0), 'nonempty'),
            ('large-wav', 'wav', self.reference_wav + bytes(1048577), '1048576'),
        ]:
            (self.voices / (label + '.wav')).write_bytes(self.reference_wav)
            (self.voices / (label + '.txt')).write_text('private transcript')
            asset = self.voices / (label + '.' + suffix)
            if data is None:
                asset.unlink()
            else:
                asset.write_bytes(data)
            cases.append((label, reason))
        for label, channels, width, rate, frames in [
            ('stereo', 2, 2, 48000, 1), ('wrong-width', 1, 1, 48000, 1),
            ('wrong-rate', 1, 2, 44100, 1), ('overlong', 1, 2, 48000, 480001),
        ]:
            with wave.open(str(self.voices / (label + '.wav')), 'wb') as audio:
                audio.setnchannels(channels)
                audio.setsampwidth(width)
                audio.setframerate(rate)
                audio.writeframes(bytes(channels * width * frames))
            (self.voices / (label + '.txt')).write_text('private transcript')
            cases.append((label, 'mono 48 kHz PCM16'))
        for suffix in ('wav', 'txt'):
            for kind in ('directory', 'unreadable', 'escaping'):
                label = kind + '-' + suffix
                (self.voices / (label + '.wav')).write_bytes(self.reference_wav)
                (self.voices / (label + '.txt')).write_text('private transcript')
                asset = self.voices / (label + '.' + suffix)
                asset.unlink()
                if kind == 'directory':
                    asset.mkdir()
                elif kind == 'unreadable':
                    asset.write_bytes(self.reference_wav if suffix == 'wav' else b'private transcript')
                    asset.chmod(0)
                    self.addCleanup(asset.chmod, 0o600)
                else:
                    outside = self.voices.parent / (self.voices.name + '-outside-' + suffix)
                    outside.write_bytes(self.reference_wav if suffix == 'wav' else b'private transcript')
                    self.addCleanup(outside.unlink)
                    asset.symlink_to(outside)
                reason = {'directory': 'not a regular file', 'unreadable': 'cannot read',
                          'escaping': 'immediately inside'}[kind]
                cases.append((label, reason))
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        for name, reason in cases:
            with (
                self.subTest(name=name),
                patch.dict(os.environ, {'KESTREL_VOICE': name}),
                patch.object(bot, 'NemotronSTT', return_value=stt),
                patch.object(bot, 'NemotronRecognizer', return_value=stt),
                patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                patch.object(bot.torch, 'set_num_threads'),
            ):
                with self.assertRaises(RuntimeError) as failure:
                    await self.run_bot()
                message = str(failure.exception)
                self.assertIn(reason, message)
                self.assertIn('Check the voice files and restart Kestrel.', message)
                self.assertNotIn('private transcript', message)
                self.assertNotIn('../private-transcript', message)
                if name and '/' not in name:
                    self.assertIn(name, message)
                bot.VoxCPM.from_pretrained.assert_not_called()
                stt.load.assert_not_awaited()
                conversation.assert_not_awaited()
                self.audio.open.assert_not_awaited()
                bot.LaptopAudioTransport.assert_not_called()
                bot.NemotronSTT.assert_not_called()

    async def test_selected_preset_survives_startup_and_replies(self):
        for name, transcript in [('irish-female', 'Irish fixture.'), ('british-male', 'British fixture.'),
                                 ('third', 'Third fixture.')]:
            with self.subTest(name=name):
                self.voice.generate_streaming.reset_mock()
                if name == 'irish-female':
                    os.environ.pop('KESTREL_VOICE', None)
                else:
                    os.environ['KESTREL_VOICE'] = name
                stt = Mock(load=AsyncMock(), close=AsyncMock())

                async def conversation(recognition, voice, **kwargs):
                    self.assertIs(recognition, stt)
                    self.assertIsInstance(voice, speech.VoxCPMTTS)
                    self.assertEqual(self.voice.generate_streaming.call_count, 3)
                    os.environ['KESTREL_VOICE'] = 'unknown'
                    start = bot.LLMFullResponseStartFrame()
                    start.reply_progress = reply_progress.ReplyProgress(
                        kwargs['llm'].admission.accept_spoken()[0], feed=None, feed_open=lambda: True)
                    await voice.process_frame(start, FrameDirection.DOWNSTREAM)
                    await voice.on_turn_context_created('reply')
                    await voice.create_audio_context('reply')
                    for sentence in ('First reply.', 'Second reply.'):
                        frames = [frame async for frame in voice.run_tts(sentence, 'reply')]
                        self.assertEqual(len(frames), 1)

                with (
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot, 'run_conversation', side_effect=conversation),
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    await self.run_bot()
                stt.load.assert_awaited_once_with(self.reference_pcm)
                calls = self.voice.generate_streaming.call_args_list
                self.assertEqual([item.kwargs['text'] for item in calls], ['One moment.', 'Just a moment.', 'Give me a moment.', 'First reply.', 'Second reply.'])
                for item in calls:
                    self.assertEqual(item.kwargs['prompt_wav_path'], str(self.voices / (name + '.wav')))
                    self.assertEqual(item.kwargs['reference_wav_path'], str(self.voices / (name + '.wav')))
                    self.assertEqual(item.kwargs['prompt_text'], transcript)

    async def test_phonon_default_and_explicit_vox_selection(self):
        for selection in (None, 'phonon', 'voxcpm2'):
            with self.subTest(selection=selection):
                if selection is None:
                    os.environ.pop('KESTREL_TTS_MODEL', None)
                else:
                    os.environ['KESTREL_TTS_MODEL'] = selection
                stt = Mock(load=AsyncMock(), close=AsyncMock())
                streams = []

                def stream(text, *, voice, seed):
                    self.assertEqual((voice, seed), ('bryony', 1234))
                    native = Mock(sample_rate=24000, close=Mock())
                    native.__iter__ = Mock(return_value=iter([np.zeros(2400, dtype=np.float32)]))
                    streams.append(native)
                    return native

                phonon = Mock(stream=Mock(side_effect=stream))
                self.voice.generate_streaming.reset_mock()
                locks = []

                async def conversation(recognition, voice, **kwargs):
                    expected = speech.VoxCPMTTS if selection == 'voxcpm2' else speech.PhononTTS
                    self.assertIs(recognition, stt)
                    self.assertIsInstance(voice, expected)
                    self.assertIs(voice.model, self.voice if selection == 'voxcpm2' else phonon)
                    locks.append(voice._generation_lock)
                    # A later environment edit cannot switch an already prepared service.
                    os.environ['KESTREL_TTS_MODEL'] = 'unknown'
                    start = bot.LLMFullResponseStartFrame()
                    start.reply_progress = reply_progress.ReplyProgress(
                        kwargs['llm'].admission.accept_spoken()[0], feed=None, feed_open=lambda: True)
                    await voice.process_frame(start, FrameDirection.DOWNSTREAM)
                    await voice.on_turn_context_created('reply')
                    await voice.create_audio_context('reply')
                    frames = [frame async for frame in voice.run_tts('Reply.', 'reply')]
                    self.assertTrue(any(frame.audio for frame in frames))

                with (
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot, 'load_phonon', return_value=phonon) as load,
                    patch.object(bot, 'run_conversation', side_effect=conversation),
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    bot.VoxCPM.from_pretrained.reset_mock()
                    await self.run_bot(activations=2)
                    stt.load.assert_awaited_once_with(self.reference_pcm)
                    self.assertEqual(len(locks), 2)
                    self.assertIs(locks[0], locks[1])
                    if selection == 'voxcpm2':
                        load.assert_not_called()
                        bot.VoxCPM.from_pretrained.assert_called_once_with(
                            str(bot.ROOT / '.runtime/models/voxcpm2'), load_denoiser=False,
                            optimize=False, device='cuda', local_files_only=True,
                        )
                        self.assertEqual([item.kwargs['text'] for item in self.voice.generate_streaming.call_args_list],
                                         ['One moment.', 'Just a moment.', 'Give me a moment.', 'Reply.', 'Reply.'])
                        for item in self.voice.generate_streaming.call_args_list:
                            self.assertEqual(item.kwargs['prompt_text'], 'Irish fixture.')
                            self.assertEqual(item.kwargs['prompt_wav_path'], str(self.voices / 'irish-female.wav'))
                    else:
                        load.assert_called_once_with()
                        bot.VoxCPM.from_pretrained.assert_not_called()
                        self.assertEqual([item.args[0] for item in phonon.stream.call_args_list],
                                         ['One moment.', 'Just a moment.', 'Give me a moment.', 'Reply.', 'Reply.'])
                        for native in streams:
                            native.close.assert_called_once_with()

        for selection in ('', 'unknown', 'Phonon'):
            with self.subTest(invalid=selection), patch.dict(os.environ, KESTREL_TTS_MODEL=selection):
                stt = Mock(load=AsyncMock(), close=AsyncMock())
                with (
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot, 'load_phonon') as load,
                    patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                ):
                    bot.VoxCPM.from_pretrained.reset_mock()
                    with self.assertRaisesRegex(RuntimeError, 'KESTREL_TTS_MODEL'):
                        await self.run_bot()
                    load.assert_not_called()
                    bot.VoxCPM.from_pretrained.assert_not_called()
                    stt.load.assert_not_awaited()
                    conversation.assert_not_awaited()

        for failure in ('load', 'synthesis'):
            with self.subTest(phonon_failure=failure), patch.dict(os.environ, KESTREL_TTS_MODEL='phonon'):
                stt = Mock(load=AsyncMock(), close=AsyncMock())
                model = Mock(stream=Mock(side_effect=RuntimeError('native synthesis failed')))
                with (
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot, 'load_phonon', return_value=model,
                                 side_effect=RuntimeError('Phonon assets unavailable') if failure == 'load' else None),
                    patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                ):
                    bot.VoxCPM.from_pretrained.reset_mock()
                    with self.assertRaisesRegex(RuntimeError, 'Phonon'):
                        await self.run_bot()
                    bot.VoxCPM.from_pretrained.assert_not_called()
                    conversation.assert_not_awaited()
                    stt.close.assert_awaited_once()

    async def test_voice_weights_are_prepared_once_per_service_lifetime(self):
        stt = Mock(load=AsyncMock(), close=AsyncMock())
        events = []

        def chunks(**kwargs):
            events.append('warm')
            try:
                yield np.zeros(8, dtype=np.float32)
            finally:
                events.append('closed')

        model = Mock(generate_streaming=Mock(side_effect=chunks))

        def load_model(*args, **kwargs):
            events.append('load')
            return model

        with (
            patch.object(bot, "NemotronSTT", return_value=stt),
            patch.object(bot, "NemotronRecognizer", return_value=stt),
            patch.object(bot.VoxCPM, "from_pretrained", side_effect=load_model) as load,
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            conversation.side_effect = lambda *args, **kwargs: events.append('conversation')
            await self.run_bot()
            await self.run_bot()
            self.assertEqual(load.call_count, 2)
            self.assertEqual(model.generate_streaming.call_count, 6)
            self.assertEqual([item.kwargs['text'] for item in model.generate_streaming.call_args_list],
                             ['One moment.', 'Just a moment.', 'Give me a moment.',
                              'One moment.', 'Just a moment.', 'Give me a moment.'])
            self.assertEqual(events, ['load', 'warm', 'closed', 'warm', 'closed', 'warm', 'closed', 'conversation',
                                      'load', 'warm', 'closed', 'warm', 'closed', 'warm', 'closed', 'conversation'])
            self.assertEqual(conversation.await_count, 2)
            self.assertIs(conversation.await_args.args[1].model, model)
            self.assertIsNot(conversation.await_args_list[0].args[1], conversation.await_args_list[1].args[1])
            self.assertEqual(stt.close.await_count, 2)
            self.assertEqual(self.audio.close.await_count, 2)

    async def test_voice_preparation_finishes_before_conversation_and_failure_stops_startup(self):
        loop = asyncio.get_running_loop()
        activity = asyncio.Event()
        release = threading.Event()
        events = []
        managers = []
        construct = bot.VoiceConversations.side_effect

        def manager(**kwargs):
            value = construct(**kwargs)
            managers.append(value)
            return value

        def gated_chunks(**kwargs):
            text = kwargs['text']
            try:
                events.append((text, 'first_chunk'))
                yield np.zeros(8, dtype=np.float32)
                if text == 'Give me a moment.':
                    events.append((text, 'gated'))
                    loop.call_soon_threadsafe(activity.set)
                    if not release.wait(5):
                        raise AssertionError('Voice preparation gate was not released')
                yield np.zeros(8, dtype=np.float32)
                events.append((text, 'exhausted'))
            finally:
                events.append((text, 'closed'))

        stt = Mock(load=AsyncMock(), close=AsyncMock())
        model = Mock(generate_streaming=Mock(side_effect=gated_chunks))
        with (
            patch.object(bot, 'VoiceConversations', side_effect=manager),
            patch.object(bot, 'NemotronSTT', return_value=stt),
            patch.object(bot, 'NemotronRecognizer', return_value=stt),
            patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
            patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, 'set_num_threads'),
        ):
            conversation.side_effect = lambda *args, **kwargs: events.append('conversation')
            task = asyncio.create_task(self.run_bot())
            task.add_done_callback(lambda completed: activity.set())
            try:
                await asyncio.wait_for(activity.wait(), 5)
                conversation.assert_not_awaited()
                self.assertFalse(task.done())
                self.assertFalse(managers[0].prepared)
                self.assertEqual(managers[0].prepared_acknowledgements, ())
                self.audio.open.assert_not_awaited()
                self.assertEqual(events, [
                    ('One moment.', 'first_chunk'), ('One moment.', 'exhausted'), ('One moment.', 'closed'),
                    ('Just a moment.', 'first_chunk'), ('Just a moment.', 'exhausted'), ('Just a moment.', 'closed'),
                    ('Give me a moment.', 'first_chunk'), ('Give me a moment.', 'gated'),
                ])
                release.set()
                await asyncio.wait_for(task, 5)
                self.assertEqual(events[-3:], [
                    ('Give me a moment.', 'exhausted'), ('Give me a moment.', 'closed'), 'conversation',
                ])
                self.assertTrue(managers[0].prepared)
                clips = managers[0].prepared_acknowledgements
                self.assertIsInstance(clips, tuple)
                self.assertEqual([(clip.text, clip.pcm) for clip in clips], [
                    ('One moment.', bytes(32)), ('Just a moment.', bytes(32)), ('Give me a moment.', bytes(32)),
                ])
                with self.assertRaises(AttributeError):
                    clips[0].text = 'Changed.'
                self.assertEqual(managers[0].conversation.turns, [])
                conversation.assert_awaited_once()
            finally:
                release.set()
                await asyncio.wait_for(task, 5)

        for label in ('late_failure', 'empty'):
            with self.subTest(label=label):
                self.audio.reset_mock()
                failed_events = []

                def failed_chunks(**kwargs):
                    try:
                        failed_events.append('first_chunk')
                        yield np.zeros(8, dtype=np.float32)
                        raise RuntimeError('Voice preparation failed')
                    finally:
                        failed_events.append('closed')

                def empty_chunks(**kwargs):
                    yield from ()

                stt = Mock(load=AsyncMock(), close=AsyncMock())
                generator = failed_chunks if label == 'late_failure' else empty_chunks
                model = Mock(generate_streaming=Mock(side_effect=generator))
                with (
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'NemotronRecognizer', return_value=stt),
                    patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
                    patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    with self.assertRaisesRegex(RuntimeError, '[Pp]reparation'):
                        await self.run_bot()
                    conversation.assert_not_awaited()
                    if label == 'late_failure':
                        self.assertEqual(failed_events, ['first_chunk', 'closed'])
                    stt.close.assert_awaited_once()
                    self.audio.close.assert_not_awaited()

    async def test_acknowledgement_preparation_refuses_invalid_audio(self):
        preset = speech.load_voice_preset('irish-female', voices_dir=self.voices)
        for provider in ('phonon', 'voxcpm2'):
            for case in ('empty', 'rate', 'channels', 'nonbytes', 'odd', 'oversized', 'overflow', 'generation', 'valid'):
                with self.subTest(provider=provider, case=case):
                    closed = []

                    def chunks():
                        try:
                            if case == 'empty':
                                return
                            yield np.zeros(2400, dtype=np.float32)
                            if case == 'generation':
                                raise RuntimeError('fixture generation failed')
                        finally:
                            closed.append(True)

                    def stream(*args, **kwargs):
                        source = chunks()
                        native = Mock(sample_rate=24000, close=Mock(side_effect=source.close))
                        native.__iter__ = Mock(return_value=source)
                        return native

                    model = Mock(stream=Mock(side_effect=stream),
                                 generate_streaming=Mock(side_effect=lambda **kwargs: chunks()))
                    lock = asyncio.Lock()
                    voice = (speech.PhononTTS(model, generation_lock=lock) if provider == 'phonon' else
                             speech.VoxCPMTTS(model, preset, generation_lock=lock))
                    voice.push_frame = AsyncMock()
                    original = voice.run_tts

                    async def frames(text, context_id):
                        source = original(text, context_id)
                        try:
                            first = True
                            async for frame in source:
                                if case in ('empty', 'generation'):
                                    yield frame
                                    continue
                                if not first:
                                    continue
                                first = False
                                # Inject malformed provider output after the real adapter's generation boundary.
                                yield TTSAudioRawFrame(b'', 48000, 1)
                                frame.audio = bytes(288000 if case == 'valid' else 288002 if case == 'oversized' else
                                                    144000 if case == 'overflow' else 1 if case == 'odd' else 16)
                                if case == 'rate':
                                    frame.sample_rate = 24000
                                elif case == 'channels':
                                    frame.num_channels = 2
                                elif case == 'nonbytes':
                                    frame.audio = bytearray(16)
                                yield frame
                                if case == 'overflow':
                                    yield TTSAudioRawFrame(bytes(144002), 48000, 1)
                        finally:
                            await source.aclose()

                    voice.run_tts = frames
                    if case == 'valid':
                        clips = await speech.prepare_acknowledgements(voice)
                        self.assertEqual([(clip.text, len(clip.pcm)) for clip in clips], [
                            ('One moment.', 288000), ('Just a moment.', 288000), ('Give me a moment.', 288000),
                        ])
                        self.assertEqual(sum(len(clip.pcm) for clip in clips), 864000)
                        self.assertEqual(len(closed), 3)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'preparation failed:') as failed:
                            await speech.prepare_acknowledgements(voice)
                        self.assertIn('Check the voice log, then restart Kestrel.', str(failed.exception))
                        self.assertIsNotNone(failed.exception.__cause__)
                        self.assertEqual(len(closed), 1)
                        calls = model.stream if provider == 'phonon' else model.generate_streaming
                        self.assertEqual(calls.call_count, 1, 'Invalid preparation must not retry or continue')
                    self.assertFalse(lock.locked())
                    voice.push_frame.assert_not_awaited()

        loop = asyncio.get_running_loop()
        native_timeout = asyncio.timeout
        for case in ('timeout', 'cancellation'):
            with self.subTest(case=case):
                entered = asyncio.Event()
                release = threading.Event()
                closed = threading.Event()
                deadlines = []

                def held_chunks(**kwargs):
                    try:
                        yield np.zeros(8, dtype=np.float32)
                        loop.call_soon_threadsafe(entered.set)
                        if not release.wait(5):
                            raise AssertionError('Preparation cleanup gate was not released')
                    finally:
                        closed.set()

                def timeout(delay):
                    self.assertEqual(delay, 45)
                    deadline = native_timeout(delay)
                    deadlines.append(deadline)
                    return deadline

                model = Mock(generate_streaming=Mock(side_effect=held_chunks))
                lock = asyncio.Lock()
                voice = speech.VoxCPMTTS(model, preset, generation_lock=lock)
                voice.push_frame = AsyncMock()
                with patch.object(speech.asyncio, 'timeout', side_effect=timeout):
                    task = asyncio.create_task(speech.prepare_acknowledgements(voice))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        self.assertEqual(len(deadlines), 1)
                        if case == 'timeout':
                            deadlines[0].reschedule(loop.time())
                        else:
                            task.cancel()
                        await asyncio.sleep(0)
                        await asyncio.sleep(0)
                        self.assertGreater(task.cancelling(), 0)
                        self.assertFalse(task.done(), 'Native generation must finish before failure escapes')
                        self.assertTrue(lock.locked())
                        self.assertFalse(closed.is_set())
                        release.set()
                        if case == 'timeout':
                            with self.assertRaisesRegex(RuntimeError, 'preparation failed: TimeoutError') as failed:
                                await asyncio.wait_for(task, 5)
                            self.assertIn('Check the voice log, then restart Kestrel.', str(failed.exception))
                        else:
                            with self.assertRaises(asyncio.CancelledError):
                                await asyncio.wait_for(task, 5)
                        self.assertTrue(closed.is_set())
                        self.assertFalse(lock.locked())
                        self.assertEqual(model.generate_streaming.call_count, 1)
                        voice.push_frame.assert_not_awaited()
                    finally:
                        release.set()
                        if not task.done():
                            task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

    async def test_model_load_failure_closes_recognition_and_audio(self):
        stt = Mock(load=AsyncMock(side_effect=RuntimeError("load failed")), close=AsyncMock())
        with (patch.object(bot, "NemotronSTT", return_value=stt),
              patch.object(bot, "NemotronRecognizer", return_value=stt)):
            with self.assertRaisesRegex(RuntimeError, "load failed"):
                await self.run_bot()
        stt.close.assert_awaited_once()
        self.audio.close.assert_not_awaited()

    async def test_native_startup_and_stop_release_resources_without_network_listener(self):
        for phase, echo_failure in (("preparation", False), ("conversation", False), ("conversation", True)):
            with self.subTest(phase=phase, echo_failure=echo_failure):
                preparing, active, loading = asyncio.Event(), asyncio.Event(), asyncio.Event()
                held = asyncio.Event()
                service = hermes_service()
                home = tempfile.TemporaryDirectory(prefix="kestrel-native-test-")
                home_path = Path(home.name)
                service.channel.home = home
                child = Mock(returncode=None)

                async def reap():
                    child.returncode = 0
                    return 0

                child.wait = AsyncMock(side_effect=reap)
                service.channel.process = child
                mute_work = asyncio.create_task(held.wait())
                service.local_actions.tasks.add(mute_work)

                async def prepare():
                    preparing.set()
                    await held.wait()

                async def load(reference_pcm):
                    loading.set()
                    if phase == "preparation":
                        await held.wait()

                class Forward(FrameProcessor):
                    def __init__(self, *, output=False):
                        super().__init__()
                        self.output = output

                    async def process_frame(self, frame, direction):
                        await super().process_frame(frame, direction)
                        if self.output and isinstance(frame, StartFrame):
                            active.set()
                        await self.push_frame(frame, direction)

                self.audio.input.return_value = Forward()
                output = Forward(output=True)
                output.output_buffer = reply_progress.OutputBuffer(48000, 3840)
                output.cancel_acknowledgement = create_autospec(speech.LaptopOutput, instance=True).cancel_acknowledgement
                self.audio.output.return_value = output
                native_conversation = bot.run_conversation

                async def conversation(stt, voice, *, llm, transport, handle_signals, on_frame_completed, typed_origin, status=None, conversation=None, on_ingress_ready=None, on_reply_finished=None, input_paused=lambda: False):
                    self.assertIs(llm, service)
                    self.assertIs(transport, self.audio)
                    self.assertFalse(handle_signals)
                    await native_conversation(stt, voice, llm=llm, transport=transport,
                        handle_signals=handle_signals, on_frame_completed=on_frame_completed, typed_origin=typed_origin, status=status, conversation=conversation,
                        on_ingress_ready=on_ingress_ready, on_reply_finished=on_reply_finished, input_paused=input_paused, user_params=bot.LLMUserAggregatorParams(
                            user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
                        ))

                service.channel.prepare = AsyncMock(side_effect=prepare)
                stt = Forward()
                stt.load = AsyncMock(side_effect=load)
                stt.close = AsyncMock()
                self.audio.reset_mock()
                handlers = {}
                loop = asyncio.get_running_loop()

                def register(sig, handler):
                    handlers[sig] = handler

                def start_echo(callback):
                    self.assertEqual(set(handlers), {signal.SIGINT, signal.SIGTERM})

                def signal_request(pid, sig):
                    self.assertEqual(pid, os.getpid())
                    handlers[sig]()

                bound = []
                native_bind = socket.socket.bind

                def private_bind(peer, endpoint):
                    self.assertEqual(peer.family, socket.AF_UNIX, 'Voice must never bind a network listener')
                    self.assertIn(endpoint, {'\0kestrel.' + namespace + '.' + str(os.getuid()) + '.' +
                                     hashlib.sha256(os.environ['XDG_RUNTIME_DIR'].encode()).hexdigest()
                                     for namespace in ('control', 'conversation')})
                    bound.append(endpoint)
                    return native_bind(peer, endpoint)

                with (
                    tempfile.TemporaryDirectory() as runtime,
                    patch.dict(os.environ, XDG_RUNTIME_DIR=runtime),
                    patch.object(self, "startup_service", return_value=service),
                    patch.object(bot, "NemotronSTT", return_value=stt),
                    patch.object(bot, "NemotronRecognizer", return_value=stt),
                    patch.object(bot, "run_conversation", conversation),
                    patch.object(bot.ECHO_REMOVAL, "start", side_effect=start_echo) as echo_start,
                    patch.object(bot.ECHO_REMOVAL, "close") as echo_close,
                    patch.object(loop, "add_signal_handler", side_effect=register),
                    patch.object(loop, "remove_signal_handler") as remove_signal,
                    patch.object(bot.os, "kill", side_effect=signal_request),
                    patch("socket.socket.bind", private_bind),
                    patch.object(bot.torch, "set_num_threads"),
                ):
                    task = asyncio.create_task(bot.run_voice_service())
                    try:
                        await asyncio.wait_for((loading if phase == "preparation" else active).wait(), 5)
                        self.assertTrue(preparing.is_set())
                        if echo_failure:
                            echo_start.call_args.args[0]()
                            with self.assertRaisesRegex(RuntimeError, "Echo removal has stopped. Restart Kestrel"):
                                await asyncio.wait_for(task, 5)
                        else:
                            handlers[signal.SIGTERM]()
                            handlers[signal.SIGTERM]()
                            await asyncio.wait_for(task, 5)
                        self.assertEqual(len(bound), 2)
                        if phase == 'preparation':
                            self.audio.open.assert_not_awaited()
                            self.audio.close.assert_not_awaited()
                        else:
                            self.audio.open.assert_awaited_once()
                            self.audio.close.assert_awaited_once()
                        stt.close.assert_awaited_once()
                        child.terminate.assert_called_once_with()
                        child.wait.assert_awaited_once()
                        self.assertIsNone(service.channel.reader)
                        self.assertTrue(mute_work.done())
                        self.assertFalse(home_path.exists())
                        echo_close.assert_called_once_with()
                        self.assertEqual(remove_signal.call_count, 2)
                    finally:
                        held.set()
                        if not task.done():
                            task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        await service.local_actions.close()
                        await service.channel.close()

    async def test_conversation_has_no_idle_deadline_and_stops_on_request(self):
        started = asyncio.Event()
        worker = None
        native_worker = bot.PipelineWorker

        class Forward(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)

        def capture_worker(*args, **kwargs):
            nonlocal worker
            worker = native_worker(*args, **kwargs)

            @worker.event_handler("on_pipeline_started")
            async def on_pipeline_started(worker, frame):
                started.set()

            return worker

        output = Forward()
        output.output_buffer = reply_progress.OutputBuffer(48000, 3840)
        transport = Mock(input=Mock(return_value=Forward()), output=Mock(return_value=output))
        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        voice = speech.VoxCPMTTS(self.voice, speech.load_voice_preset('irish-female', voices_dir=self.voices))
        llm = Forward()
        llm.conversation_output = Mock()
        llm.remember_assistant_reply = Mock()
        llm._assistant_reply_token = None
        llm.current_reply = Mock(return_value=None)
        with patch.object(bot, "PipelineWorker", side_effect=capture_worker):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=llm, transport=transport, user_params=params,
                on_frame_completed=Mock(), typed_origin=Mock(return_value=None),
            ))
            try:
                await asyncio.wait_for(started.wait(), 5)
                # Pipecat 1.12.0 starts its idle monitor before the started event; no public getter exists.
                self.assertIsNone(worker._idle_timeout_secs)
                self.assertIsNone(worker._idle_monitor_task)
                self.assertFalse(task.done())
                await worker.cancel()
                await asyncio.wait_for(task, 5)
            finally:
                if not task.done():
                    if worker is not None:
                        await worker.cancel()
                    else:
                        task.cancel()
                    await asyncio.wait_for(task, 5)

    async def test_pipeline_latency_log_contains_only_numeric_measurement(self):
        started, measured = asyncio.Event(), asyncio.Event()
        messages = []

        class Forward(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    started.set()
                await self.push_frame(frame, direction)

        output = Forward()
        output.output_buffer = reply_progress.OutputBuffer(48000, 3840)
        transport = Mock(input=Mock(return_value=Forward()), output=Mock(return_value=output))
        observer = bot.AnswerLatencyObserver(time_source=lambda: 100.25)

        def log(message):
            messages.append(message)
            if message == "0.250":
                measured.set()

        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        voice = speech.VoxCPMTTS(self.voice, speech.load_voice_preset('irish-female', voices_dir=self.voices))
        llm = Forward()
        llm.conversation_output = Mock()
        llm.remember_assistant_reply = Mock()
        llm._assistant_reply_token = None
        llm.current_reply = Mock(return_value=None)
        with (patch.object(bot, "AnswerLatencyObserver", return_value=observer),
              patch.object(bot.logger, "info", side_effect=log)):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=llm, transport=transport, user_params=params,
                on_frame_completed=Mock(), typed_origin=Mock(return_value=None),
            ))
            try:
                await asyncio.wait_for(started.wait(), 5)
                await transport.input().queue_frame(VADUserStoppedSpeakingFrame(timestamp=100.0))
                await transport.input().queue_frame(BotStartedSpeakingFrame())
                await asyncio.wait_for(measured.wait(), 5)
                self.assertEqual([message for message in messages if message == "0.250"], ["0.250"])
                self.assertEqual(float(messages[-1]), 0.25)
                self.assertNotIn("private transcript", " ".join(messages))
            finally:
                task.cancel()
                await asyncio.wait_for(task, 5)

    def test_kestrel_is_told_to_stop_when_echo_removal_stops(self):
        with patch.object(bot.os, "kill") as kill:
            bot.stop_kestrel()
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)


class TroubleCauseTests(unittest.IsolatedAsyncioTestCase):
    async def test_trouble_names_its_first_verified_cause(self):
        from desktop import status as status_module
        from types import SimpleNamespace
        sentinel = 'PRIVATE FAILURE SENTINEL'
        voice_failure = 'Voice generation cleanup failed. Restart Kestrel.'

        def transport(failure=None, close=None):
            return SimpleNamespace(failure=failure, close=close or AsyncMock())

        def finished_pipeline(manager, error=None):
            manager.pipeline = asyncio.get_running_loop().create_future()
            if error is None:
                manager.pipeline.set_result(None)
            else:
                manager.pipeline.set_exception(error)
            manager.admission = Admission(voice=True, output_switching=lambda: False)

        def failed_transport(manager, failure):
            manager.transport = transport(failure)
            manager.failed_transport()

        def microphone(manager):
            failed_transport(manager, speech.LAPTOP_CAPTURE_FAILURE)

        def playback(manager):
            failed_transport(manager, speech.LAPTOP_PLAYBACK_FAILURE)

        def recognition(manager):
            manager.transport = transport()
            manager.recognizer.failure = sentinel
            finished_pipeline(manager)

        def voice(manager):
            manager.transport = transport()
            manager.voice = SimpleNamespace(generation_cleanup_failed=True)
            manager.lifecycle_changed = True

        def exceptional_pipeline(manager):
            manager.transport = transport()
            finished_pipeline(manager, RuntimeError(sentinel))

        def unexplained_close(manager):
            manager.transport = transport(close=AsyncMock(side_effect=RuntimeError(sentinel)))
            manager.lifecycle_changed = True

        def microphone_then_voice(manager):
            manager.voice = SimpleNamespace(generation_cleanup_failed=True)
            microphone(manager)

        for name, arrange, expected, failure in (
            ('microphone', microphone, 'trouble-microphone', None),
            ('playback', playback, 'trouble-playback', None),
            ('recognition behind a finished pipeline', recognition, 'trouble-recognition', None),
            ('voice', voice, 'trouble-voice', None),
            ('exceptional pipeline completion', exceptional_pipeline, 'trouble', None),
            ('unexplained close failure', unexplained_close, 'trouble', None),
            ('first verified cause wins', microphone_then_voice, 'trouble-microphone', voice_failure),
        ):
            with self.subTest(name), tempfile.TemporaryDirectory() as runtime:
                status = bot.IndicatorStatus(Path(runtime))
                manager = bot.VoiceConversations(status=status, conversation=Mock(spec=bot.ConversationFeed))
                published = asyncio.Queue()
                native_set = status.set_state

                def observe(state):
                    native_set(state)
                    published.put_nowait(state)

                status.set_state = observe
                arrange(manager)
                task = asyncio.create_task(manager.run())
                try:
                    first_two = [await asyncio.wait_for(published.get(), 5) for _ in range(2)]
                    self.assertEqual(first_two, ['inactive', expected])
                    self.assertEqual(status_module.read_indicator(Path(runtime)), expected)
                    self.assertNotIn(sentinel.encode(), (Path(runtime) / 'kestrel/indicator.json').read_bytes())
                    if failure is not None:
                        self.assertEqual(manager.failure, failure)
                finally:
                    manager.closed = True
                    manager.changed.set()
                    await asyncio.wait_for(task, 5)


if __name__ == '__main__':
    unittest.main()
