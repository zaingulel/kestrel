import asyncio
import json
import os
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, call, patch

import numpy as np
from pipecat.frames.frames import DataFrame, LLMFullResponseEndFrame, ProposedUserStartedSpeakingFrame

import bot
from conversation_fixtures import WholeConversationCase
import reply_progress
import tool_actions
from test_hermes import ROOT, ScriptedBrain


class WholeConversationTests(WholeConversationCase):
    async def test_deep_reply_is_private_and_stoppable(self):
        blocked, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def deep_reply():
            yield {'reasoning_content': 'STRUCTURED-PRIVATE-CANARY.'}, None
            yield {'content': '[delivery:neutral] <thi'}, None
            yield {'content': 'nk>PRIVATE-CANARY. '}, None
            yield {'content': '</think>Answer.'}, None
            yield {'content': ' Unheard pending'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Deep reply was never released')
            yield {'tool_calls': [{'index': 0, 'id': 'late-mute', 'type': 'function',
                                  'function': {'name': 'mute', 'arguments': '{}'}}]}, None
            yield {}, 'tool_calls'
        brain = ScriptedBrain([
            '[delivery:neutral] Prepared.', deep_reply(),
            '[delivery:neutral] Unheard continuation.', '[delivery:neutral] Next.',
        ])
        self.addCleanup(brain.close)
        local = AsyncMock(side_effect=AssertionError('Stopped turn dispatched a desktop action'))
        native_events = []
        transport, spoken, committed, interrupted, processes, close = await self.open_session(
            brain, through_service=True, native_audio=True, tts_model=None,
            local_command=local, native_events=native_events,
        )
        service = transport.service
        _, _, context = service.manager.ingress
        prompt = 'Think more deeply about this answer.'
        try:
            transport.capture.stdout.feed_data(bytes(640))
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, prompt)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Answer.')
            self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
            reader = transport.llm.channel.reader
            interrupted.clear()
            transport.capture.stdout.feed_data(bytes(640))
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Answer.')
            await self.finish_user_turn(transport, 'stop')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertFalse(reader.done(), 'Stop must finish before accepted generation drains')
            self.assertTrue(spoken.empty())
            self.assertEqual(transport.llm.last_spoken_reply, 'Answer.')
            before = sum(len(data) for child in service.audio_children for data in child.writes)
            transport.capture.stdout.feed_data(bytes(640))
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Next ordinary answer.')
            release.set()
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Next.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Next.')
            self.assertGreater(sum(len(data) for child in service.audio_children for data in child.writes), before)
            local.assert_not_awaited()
            synthesis = [item.args[0] for item in service.model.stream.call_args_list]
            self.assertEqual(synthesis, ['One moment.', 'Just a moment.', 'Give me a moment.', 'Answer.', 'Next.'])
            self.assertEqual(transport.llm.last_spoken_reply, 'Next.')
            for visible in (native_events, synthesis, context.get_messages(), service.manager.conversation.turns):
                self.assertNotIn('PRIVATE', json.dumps(visible))
            for visible in (synthesis, context.get_messages(), service.manager.conversation.turns):
                self.assertNotIn('Unheard', json.dumps(visible))
            self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': prompt},
                {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'kestrel-desktop-0', 'type': 'function',
                    'function': {'name': 'mute', 'arguments': '{}'}}]},
                {'role': 'tool', 'tool_call_id': 'kestrel-desktop-0',
                 'content': '{"confirmed": false, "attempted": false, "reason": "stopped"}'},
                {'role': 'assistant', 'content': 'Answer.'},
                {'role': 'user', 'content': 'Next ordinary answer.'},
            ])
            self.assertEqual([r[2]['max_tokens'] for r in brain.requests], [180, 16384, 16384, 180])
            self.assertTrue(any('tool_call' in event for kind, event in native_events if kind == 'read'))
            self.assertTrue(any(child.writes for child in service.audio_children if child.stdin is not None))
            self.assertTrue(spoken.empty())
        finally:
            release.set()
            await close()
        self.assertTrue(all(process.returncode is not None for process, _ in processes))

    async def test_brain_desktop_effect_after_reader_timeout_is_accounted(self):
        wire = ("import json, sys; print('{\"ready\":true}', flush=True); "
                "assert json.loads(sys.stdin.readline()) == {'begin': True}; "
                "print('{\"session_ready\":true}', flush=True); sys.stdin.readline(); "
                "print('{\"tool_call\":{\"name\":\"mute\",\"arguments\":{}}}', flush=True); sys.stdin.read()")
        started, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        calls = []
        muted = False

        async def command(argv):
            nonlocal muted
            calls.append(argv)
            if 'get-default-sink' in argv:
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if 'get-sink-mute' in argv:
                return 'Mute: yes' if muted else 'Mute: no'
            self.assertEqual(argv, ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))
            started.set()
            await release.wait()
            muted = True
            return ''

        with patch.object(bot, 'TURN_TIMEOUT', 1):
            transport, spoken, committed, interrupted, processes, close = await self.open_session(
                None, wire=wire, local_command=command,
            )
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Please silence the sound.')
                await asyncio.wait_for(started.wait(), 5)
                reader = transport.llm.channel.reader
                await asyncio.wait_for(asyncio.shield(reader), 5)
                self.assertTrue(transport.llm.channel.failure)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5),
                                 "I couldn't reach Kestrel's engine. Restart Kestrel and try again.")
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I couldn't reach Kestrel's engine.")
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Restart Kestrel and try again.')
                self.assertTrue(transport.llm.local_actions.tasks)
                self.assertIsNotNone(processes[0][0].returncode)
                release.set()
                await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
                self.assertFalse(transport.llm.local_actions.tasks)
                self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'stop')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                                 "Stopped. Done: mute. I won't undo anything.")
                self.assertTrue(spoken.empty())
            finally:
                release.set()
                await close()

    async def test_stop_accounts_for_effects_until_output_delivers_them(self):
        for scenario in ('confirmed', 'interrupted account', 'unconfirmed'):
            with self.subTest(scenario=scenario):
                brain = ScriptedBrain([
                    [({'tool_calls': [{'index': 0, 'id': 'mute-first', 'type': 'function', 'function': {
                        'name': 'mute', 'arguments': '{}',
                    }}]}, None), ({}, 'tool_calls')],
                    [({'content': '[delivery:neutral] Muted.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                calls = []
                results = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical',
                                'Mute: no' if scenario == 'unconfirmed' else 'Mute: yes'])

                async def command(argv):
                    calls.append(argv)
                    return '' if argv[0] == '/usr/bin/notify-send' else next(results)

                transport, spoken, _, interrupted, _, close = await self.open_session(brain, local_command=command)
                output = transport.output()
                delivered_end = asyncio.Event()

                @output.event_handler('on_after_push_frame')
                async def ended(processor, frame):
                    if (isinstance(frame, LLMFullResponseEndFrame)
                            and transport.llm.admission.may_speak(reply_progress.token_of(frame))):
                        delivered_end.set()

                async def start(*, hold=False):
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    barrier = DataFrame()
                    await output.queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    if hold:
                        output.write_gate.clear()

                async def stop(*, hold=False):
                    await start(hold=hold)
                    await self.finish_user_turn(transport, 'stop')

                try:
                    await start(hold=True)
                    await self.finish_user_turn(transport, 'Please silence the sound.')
                    await asyncio.wait_for(output.generation_done.wait(), 5)
                    self.assertEqual(output.audio_written, 0)
                    self.assertEqual(len(transport.llm.outcomes), 1)
                    self.assertEqual(transport.llm.outcomes[0].result.confirmed, scenario != 'unconfirmed')
                    output.generation_done.clear()
                    await stop(hold=True)
                    await asyncio.wait_for(output.generation_done.wait(), 5)
                    if scenario == 'interrupted account':
                        output.generation_done.clear()
                        await stop(hold=True)
                        await asyncio.wait_for(output.generation_done.wait(), 5)
                    self.assertEqual(len(transport.llm.outcomes), 1)
                    self.assertTrue(spoken.empty())
                    delivered_end.clear()
                    output.write_gate.set()
                    expected = ("Stopped. Couldn't confirm: mute. I won't undo anything." if scenario == 'unconfirmed'
                                else "Stopped. Done: mute. I won't undo anything.")
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                    await asyncio.wait_for(delivered_end.wait(), 5)
                    self.assertEqual(transport.llm.outcomes, [])
                    await stop()
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'A successfully delivered account is not repeated')
                    self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                    self.assertEqual(len(brain.requests), 2)
                finally:
                    output.write_gate.set()
                    await close()

    async def test_exact_volume_outcome_retires_only_after_its_confirmation_delivers(self):
        for scenario in ('undelivered', 'delivered'):
            with self.subTest(scenario=scenario):
                brain = ScriptedBrain([])
                self.addCleanup(brain.close)
                command = AsyncMock(side_effect=[
                    'selected', 'physical', '{"volume":{"mono":{"value":65536}}}', 'Mute: no', '',
                    '{"volume":{"mono":{"value":19660}}}', 'selected', 'physical',
                    '{"volume":{"mono":{"value":19660}}}', 'Mute: no'])
                transport, spoken, _, interrupted, _, close = await self.open_session(brain, local_command=command)
                output = transport.output()
                delivered_end = asyncio.Event()

                @output.event_handler('on_after_push_frame')
                async def ended(processor, frame):
                    if (isinstance(frame, LLMFullResponseEndFrame)
                            and transport.llm.admission.may_speak(reply_progress.token_of(frame))):
                        delivered_end.set()

                async def start(*, hold=False):
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    barrier = DataFrame()
                    await output.queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    if hold:
                        output.write_gate.clear()

                async def stop(*, hold=False):
                    await start(hold=hold)
                    await self.finish_user_turn(transport, 'stop')

                try:
                    await start(hold=scenario == 'undelivered')
                    await self.finish_user_turn(transport, 'set volume to thirty')
                    if scenario == 'undelivered':
                        await asyncio.wait_for(output.generation_done.wait(), 5)
                        self.assertEqual(output.audio_written, 0)
                        self.assertEqual(len(transport.llm.outcomes), 1)
                        self.assertTrue(transport.llm.outcomes[0].result.confirmed)
                        output.generation_done.clear()
                        await stop(hold=True)
                        await asyncio.wait_for(output.generation_done.wait(), 5)
                        self.assertTrue(spoken.empty())
                        delivered_end.clear()
                        output.write_gate.set()
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                                         "Stopped. Done: volume. I won't undo anything.")
                        await asyncio.wait_for(delivered_end.wait(), 5)
                    else:
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Volume 30.')
                        await asyncio.wait_for(delivered_end.wait(), 5)
                        self.assertEqual(transport.llm.outcomes, [])
                        await stop()
                    self.assertEqual(transport.llm.outcomes, [])
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'A retired volume outcome is not reported again')
                    self.assertEqual(command.await_args_list.count(
                        call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'))), 1)
                    self.assertEqual(brain.requests, [])
                finally:
                    output.write_gate.set()
                    await close()

    async def test_outside_text_refuses_brain_tools_but_exact_commands_still_work(self):
        def call_reply(name, arguments):
            return [({'tool_calls': [{'index': 0, 'id': f'call-{name}', 'type': 'function', 'function': {
                'name': name, 'arguments': json.dumps(arguments),
            }}]}, None), ({}, 'tool_calls')]

        brain = ScriptedBrain([
            call_reply('mute', {}),
            [({'content': '[delivery:neutral] Muted.'}, None), ({}, 'stop')],
            call_reply('memory', {'action': 'add', 'target': 'memory', 'content': 'Planted note nonce-871.'}),
            call_reply('open_app', {'name': 'Firefox'}),
            call_reply('mute', {}),
            [({'content': '[delivery:neutral] Hidden reply nonce-872.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        notes_home = tempfile.TemporaryDirectory(prefix='kestrel-outside-text-', dir=ROOT / '.runtime')
        self.addCleanup(notes_home.cleanup)
        notes = Path(notes_home.name) / 'notes'
        calls, written, effect = [], False, asyncio.Event()

        async def command(argv):
            nonlocal written
            calls.append(tuple(argv))
            if 'get-default-sink' in argv:
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if 'get-sink-mute' in argv:
                status, written = ('Mute: yes' if written else 'Mute: no'), False
                return status
            if 'set-sink-mute' in argv:
                written = True
                effect.set()
                return ''
            raise AssertionError(f'Only mute may run: {argv}')

        def mutes():
            return calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))

        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, local_command=command, memory_root=notes)
        try:
            with patch.object(bot, 'KESTREL_SOURCE', 'outside-fixture'):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Please silence the sound.')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muted.')
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Muted.')
            self.assertEqual(mutes(), 1)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Save a note, open Firefox and silence the sound.')
            heard = [await asyncio.wait_for(spoken.get(), 5), await asyncio.wait_for(spoken.get(), 5)]
            self.assertEqual(' '.join(heard), bot.OUTSIDE_TEXT_ADVISORY)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), bot.OUTSIDE_TEXT_ADVISORY)
            await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
            self.assertEqual(mutes(), 2)
            self.assertEqual(len(brain.requests), 6)
            self.assertFalse((notes / 'MEMORY.md').exists())
            self.assertTrue(spoken.empty())
            effect.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'mute')
            await asyncio.wait_for(effect.wait(), 5)
            await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
            self.assertEqual(mutes(), 3)
            effect.clear()
            self.assertEqual(await transport.service.submit('mute'), 'accepted')
            await asyncio.wait_for(effect.wait(), 5)
            await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
            self.assertEqual(mutes(), 4)
            self.assertEqual(len(brain.requests), 6)
            self.assertEqual({argv[0] for argv in calls}, {'/usr/bin/pactl', '/usr/bin/omarchy-audio-output-sink'})
            self.assertFalse((notes / 'MEMORY.md').exists())
        finally:
            await close()

    async def test_stop_refuses_queued_brain_and_exact_effects_and_accounts_for_in_flight(self):
        brain = ScriptedBrain([
            [({'tool_calls': [
                {'index': 0, 'id': 'held-mute', 'type': 'function', 'function': {'name': 'mute', 'arguments': '{}'}},
                {'index': 1, 'id': 'refused-next', 'type': 'function', 'function': {'name': 'next_track', 'arguments': '{}'}},
            ]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Obsolete reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral] Account remembered.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        started, release, queued = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        calls = []
        muted = False

        async def command(argv):
            nonlocal muted
            calls.append(argv)
            if 'get-default-sink' in argv:
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if 'get-sink-mute' in argv:
                return 'Mute: yes' if muted else 'Mute: no'
            if 'set-sink-mute' in argv:
                started.set()
                await release.wait()
                muted = True
                return ''
            raise AssertionError(f'Queued actions must never execute: {argv}')

        transport, spoken, committed, interrupted, _, close = await self.open_session(brain, local_command=command)
        native_run = transport.llm.local_actions._run

        async def observed(tool, *, admitted, observe=None):
            if tool.subject == 'next track':
                queued.set()
            return await native_run(tool, admitted=admitted, observe=observe)

        try:
            with patch.object(transport.llm.local_actions, '_run', observed):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Please silence the sound and advance the music.')
                await asyncio.wait_for(started.wait(), 5)
                reader = transport.llm.channel.reader
                self.assertEqual(await transport.service.submit('next track'), 'accepted')
                await asyncio.wait_for(queued.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'stop')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                                 "Stopped. Still finishing: mute. I won't undo anything.")
                self.assertFalse(reader.done())
                release.set()
                await asyncio.wait_for(asyncio.shield(reader), 5)
                await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'What happened?')
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Account remembered.')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Account remembered.')
            messages = [m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system']
            self.assertEqual(messages[0], {'role': 'user', 'content': 'Please silence the sound and advance the music.'})
            records = messages[1]['tool_calls']
            self.assertEqual([m['function']['name'] for m in records], ['mute', 'next_track'])
            self.assertEqual([json.loads(m['function']['arguments']) for m in records], [{}, {}])
            self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in messages[2:4]], [
                (records[0]['id'], {'confirmed': True, 'attempted': True, 'reason': 'confirmed'}),
                (records[1]['id'], {'confirmed': False, 'attempted': False, 'reason': 'stopped'}),
            ])
            self.assertEqual(messages[4], {'role': 'user', 'content': 'What happened?'})
            self.assertEqual(len(messages), 5)
            self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
            self.assertFalse(any(argv[:3] == ('/usr/bin/omarchy-shell', 'media', 'next') for argv in calls))
            self.assertTrue(spoken.empty())
        finally:
            release.set()
            await close()

    async def test_speaking_over_brain_desktop_reply_records_effect_without_replay(self):
        blocked, release = threading.Event(), threading.Event()

        def partial_reply():
            yield {'content': '[delivery:neutral] Muted. Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted partial reply was never released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'tool_calls': [{'index': 0, 'id': 'mute-first', 'type': 'function', 'function': {
                'name': 'mute', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            partial_reply(),
            [({'content': '[delivery:neutral] Remembered.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
        transport, spoken, committed, interrupted, _, close = await self.open_session(brain, local_command=command)
        output = transport.output()
        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please silence the sound.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muted.')
            self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Muted.')
            release.set()
            await self.finish_user_turn(transport, 'What did you do?')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Remembered.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Remembered.')
            messages = [m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system']
            self.assertEqual(messages[0], {'role': 'user', 'content': 'Please silence the sound.'})
            self.assertEqual(messages[1]['role'], 'assistant')
            call_record = messages[1]['tool_calls'][0]
            self.assertEqual(call_record['function']['name'], 'mute')
            self.assertEqual(json.loads(call_record['function']['arguments']), {})
            self.assertEqual(messages[2], {'role': 'tool', 'tool_call_id': call_record['id'],
                                         'content': json.dumps({'confirmed': True, 'attempted': True, 'reason': 'confirmed'})})
            self.assertEqual(messages[3], {'role': 'assistant', 'content': 'Muted.'})
            self.assertEqual(messages[4], {'role': 'user', 'content': 'What did you do?'})
            self.assertEqual(len(messages), 5)
            self.assertEqual([c for c in command.await_args_list if 'set-sink-mute' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))])
        finally:
            release.set()
            output.write_gate.set()
            await close()

    async def test_invalid_or_permissioned_brain_desktop_calls_execute_nothing(self):
        forbidden = "That isn't allowed by voice, so I didn't do it."
        invalid = "I couldn't use that request, so I didn't do it."
        cases = [
            ('mute', {}, 'not allowed by voice', forbidden),
            ('set_volume', {'percent': 30.5}, 'invalid arguments', invalid),
            ('set_volume', {'percent': True}, 'invalid arguments', invalid),
            ('set_volume', {'percent': 101}, 'invalid arguments', invalid),
            ('focus_workspace', {'number': 0}, 'invalid arguments', invalid),
            ('mute', {'extra': 1}, 'invalid arguments', invalid),
            ('open_app', {'name': 'Fire\x07fox'}, 'invalid arguments', invalid),
        ]
        replies = []
        for name, arguments, _, _ in cases:
            replies.extend([
                [({'tool_calls': [{'index': 0, 'id': 'refused', 'type': 'function', 'function': {
                    'name': name, 'arguments': json.dumps(arguments),
                }}]}, None), ({}, 'tool_calls')],
                [({'content': '[delivery:neutral] Untrue success claim.'}, None), ({}, 'stop')],
            ])
        brain = ScriptedBrain(replies)
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('Refused arguments must never execute'))
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            for index, (name, arguments, reason, advisory) in enumerate(cases):
                with self.subTest(name=name, arguments=arguments):
                    tool = bot.LOCAL_TOOLS['mute']
                    entry = bot.replace(tool, permission=bot.PermissionTier.FORBIDDEN) if index == 0 else tool
                    with patch.dict(bot.LOCAL_TOOLS, mute=entry):
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'Please handle this desktop request.')
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), advisory)
                    heard = []
                    while not spoken.empty():
                        heard.append(spoken.get_nowait())
                    self.assertEqual(' '.join(heard), advisory)
                    self.assertEqual(len(brain.requests), 2 * index + 2)
                    results = [m for m in brain.requests[-1][2]['messages'] if m['role'] == 'tool' and m['tool_call_id'] == 'refused']
                    self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in results], [
                        ('refused', {'confirmed': False, 'attempted': False, 'reason': reason}),
                    ])
                    command.assert_not_awaited()
        finally:
            await close()

    async def test_refusal_after_confirmed_brain_effect_disclaims_only_that_call(self):
        # Refusing a later call must not deny an earlier confirmed effect.
        invalid = "I couldn't use that request, so I didn't do it."
        forbidden = "That isn't allowed by voice, so I didn't do it."
        brain = ScriptedBrain([
            [({'tool_calls': [{'index': 0, 'id': 'mute-first', 'type': 'function', 'function': {
                'name': 'mute', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            [({'tool_calls': [{'index': 0, 'id': 'volume-refused', 'type': 'function', 'function': {
                'name': 'set_volume', 'arguments': '{"percent":101}',
            }}]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Untrue success claim.'}, None), ({}, 'stop')],
            [({'tool_calls': [{'index': 0, 'id': 'volume-first', 'type': 'function', 'function': {
                'name': 'set_volume', 'arguments': '{"percent":30}',
            }}]}, None), ({}, 'tool_calls')],
            [({'tool_calls': [{'index': 0, 'id': 'mute-refused', 'type': 'function', 'function': {
                'name': 'mute', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Untrue success claim.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
            'selected', 'physical', '{"volume":{"mono":{"value":65536}}}', 'Mute: no', '',
            '{"volume":{"mono":{"value":19660}}}', 'selected', 'physical',
            '{"volume":{"mono":{"value":19660}}}', 'Mute: no',
        ])
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            self.assertTrue(await asyncio.wait_for(asyncio.shield(transport.llm.session_ready), 5))
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please quiet things down.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), invalid)
            heard = []
            while not spoken.empty():
                heard.append(spoken.get_nowait())
            self.assertEqual(' '.join(heard), invalid)
            self.assertEqual(len(brain.requests), 3)
            results = [m for m in brain.requests[-1][2]['messages']
                       if m['role'] == 'tool' and m['tool_call_id'] in ('mute-first', 'volume-refused')]
            self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in results], [
                ('mute-first', {'confirmed': True, 'attempted': True, 'reason': 'confirmed'}),
                ('volume-refused', {'confirmed': False, 'attempted': False, 'reason': 'invalid arguments'}),
            ])
            self.assertEqual([c for c in command.await_args_list if 'set-sink-mute' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))])
            with patch.dict(bot.LOCAL_TOOLS, mute=bot.replace(bot.LOCAL_TOOLS['mute'], permission=bot.PermissionTier.FORBIDDEN)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Please make it a little quieter.')
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), forbidden)
            heard = []
            while not spoken.empty():
                heard.append(spoken.get_nowait())
            self.assertEqual(' '.join(heard), forbidden)
            self.assertEqual(len(brain.requests), 6)
            results = [m for m in brain.requests[-1][2]['messages']
                       if m['role'] == 'tool' and m['tool_call_id'] in ('volume-first', 'mute-refused')]
            self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in results], [
                ('volume-first', {'confirmed': True, 'attempted': True, 'reason': 'confirmed'}),
                ('mute-refused', {'confirmed': False, 'attempted': False, 'reason': 'not allowed by voice'}),
            ])
            self.assertEqual([c for c in command.await_args_list if 'set-sink-volume' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'))])
            self.assertEqual([c for c in command.await_args_list if 'set-sink-mute' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'))])
            self.assertEqual(command.await_count, 17)
        finally:
            await close()

    async def test_confirmed_brain_desktop_call_is_never_repeated_in_a_turn(self):
        brain = ScriptedBrain([
            [({'tool_calls': [{'index': 0, 'id': 'volume-first', 'type': 'function', 'function': {
                'name': 'set_volume', 'arguments': '{"percent":30}',
            }}]}, None), ({}, 'tool_calls')],
            [({'tool_calls': [{'index': 0, 'id': 'volume-again', 'type': 'function', 'function': {
                'name': 'set_volume', 'arguments': '{"percent":40}',
            }}]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Set to thirty.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[
            'selected', 'physical', '{"volume":{"mono":{"value":65536}}}', 'Mute: no', '',
            '{"volume":{"mono":{"value":19660}}}', 'selected', 'physical',
            '{"volume":{"mono":{"value":19660}}}', 'Mute: no',
        ])
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please turn the sound down a little.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Set to thirty.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Set to thirty.')
            self.assertEqual(len(brain.requests), 3)
            results = [m for m in brain.requests[-1][2]['messages'] if m['role'] == 'tool']
            self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in results], [
                ('volume-first', {'confirmed': True, 'attempted': True, 'reason': 'confirmed'}),
                ('volume-again', {'confirmed': False, 'attempted': False, 'reason': 'already attempted'}),
            ])
            self.assertEqual(command.await_count, 10)
            self.assertEqual([c for c in command.await_args_list if 'set-sink-volume' in c.args[0]],
                             [call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'))])
        finally:
            await close()

    @staticmethod
    def brain_tool_call(call_id, name, arguments):
        return [({'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {
            'name': name, 'arguments': json.dumps(arguments),
        }}]}, None), ({}, 'tool_calls')]

    async def test_brain_app_and_screenshot_calls_use_exact_tools_and_send_only_observed_results(self):
        clock = patch.object(time, 'time_ns', return_value=2_000_000_000_000_000_000)
        clock.start()
        self.addCleanup(clock.stop)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / 'screenshot-2026-10-18_12-34-56.png'
        path.write_bytes(b'PRIVATE screenshot content must never be opened')
        os.utime(path, ns=(2_000_000_000_000_000_000, 2_000_000_000_000_000_000))
        screenshot = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')
        screenshot_failure = "I couldn't confirm the screenshot. Check your screenshot folder. I won't retry."
        lookup_failure = "I couldn't check the installed apps. I didn't send an open request. Use the app menu."
        no_match = "I couldn't find exactly one installed app with that name, so I didn't open anything."
        discovery = tool_actions.app_discovery_environment()
        lookup = ('/usr/bin/env', *discovery, '/usr/bin/python', '-I', str(ROOT / 'app_resolver.py'))
        launch = ('/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env', *discovery,
                  '/usr/bin/gtk-launch', 'fixture.desktop')
        untrue = [({'content': '[delivery:neutral] Untrue success claim.'}, None), ({}, 'stop')]
        # Each case: user text, scripted brain replies, command answers, expected calls, tool results, speech.
        cases = [
            ('Could you start FixtureApp for me?',
             [self.brain_tool_call('known', 'open_app', {'name': 'FixtureApp'}),
              [({'content': '[delivery:neutral] Asked it to open.'}, None), ({}, 'stop')]],
             ['{"id": "fixture.desktop", "name": "FixtureApp"}', ''], [(lookup, b'FixtureApp'), (launch, None)],
             [('known', {'confirmed': True, 'attempted': True, 'reason': 'launch accepted'})], 'Asked it to open.'),
            ('Grab a picture of my screen.',
             [self.brain_tool_call('saved', 'take_screenshot', {}),
              [({'content': '[delivery:neutral] Saved a screenshot.'}, None), ({}, 'stop')]],
             [str(path) + '\n'], [(screenshot, None)],
             [('saved', {'confirmed': True, 'attempted': True, 'reason': 'confirmed'})], 'Saved a screenshot.'),
            ('Grab another picture of my screen.',
             [self.brain_tool_call('unconfirmed', 'take_screenshot', {}), untrue],
             ['PRIVATE native output'], [(screenshot, None)],
             [('unconfirmed', {'confirmed': False, 'attempted': True, 'reason': 'screenshot unconfirmed'})],
             screenshot_failure),
            ('Could you start Blorptastic for me?',
             [self.brain_tool_call('unknown', 'open_app', {'name': 'Blorptastic'}),
              self.brain_tool_call('after-closed', 'take_screenshot', {}), untrue],
             ['null'], [(lookup, b'Blorptastic')],
             [('unknown', {'confirmed': False, 'attempted': False, 'reason': 'no unique installed app'}),
              ('after-closed', {'confirmed': False, 'attempted': False, 'reason': 'turn closed'})], no_match),
            ('Could you start Unavailable for me?',
             [self.brain_tool_call('unavailable', 'open_app', {'name': 'Unavailable'}),
              self.brain_tool_call('after-failed', 'take_screenshot', {}), untrue],
             [RuntimeError('PRIVATE lookup failure')], [(lookup, b'Unavailable')],
             [('unavailable', {'confirmed': False, 'attempted': False, 'reason': 'app lookup failed'}),
              ('after-failed', {'confirmed': False, 'attempted': False, 'reason': 'turn closed'})], lookup_failure),
            ('Could you start Corrupt for me?',
             [self.brain_tool_call('corrupt', 'open_app', {'name': 'Corrupt'}), untrue],
             ['{}'], [(lookup, b'Corrupt')],
             [('corrupt', {'confirmed': False, 'attempted': False, 'reason': 'app lookup failed'})], lookup_failure),
        ]
        brain = ScriptedBrain([reply for case in cases for reply in case[1]])
        self.addCleanup(brain.close)
        answers, calls = [], []

        async def command(argv, *, stdin_data=None):
            calls.append((argv, stdin_data))
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            requests = 0
            for text, replies, outputs, expected_calls, results, speech in cases:
                with self.subTest(text=text):
                    answers[:], calls[:] = outputs, []
                    requests += len(replies)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, text)
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), speech)
                    heard = []
                    while not spoken.empty():
                        heard.append(spoken.get_nowait())
                    self.assertEqual(' '.join(heard), speech)
                    self.assertEqual(calls, expected_calls)
                    self.assertEqual(answers, [])
                    self.assertEqual(len(brain.requests), requests)
                    ids = [call_id for call_id, _ in results]
                    tools = [m for m in brain.requests[-1][2]['messages'] if m['role'] == 'tool' and m['tool_call_id'] in ids]
                    self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in tools], results)
            for _, _, body in brain.requests:
                sent = json.dumps(body)
                for private in (str(path), 'screenshot-2026', 'PRIVATE'):
                    self.assertNotIn(private, sent)
        finally:
            await close()

    async def test_stop_refuses_brain_launch_after_lookup_and_accounts_for_accepted_launch(self):
        from desktop import conversation
        brain = ScriptedBrain([
            self.brain_tool_call('held-open', 'open_app', {'name': 'FixtureApp'}),
            [({'content': '[delivery:neutral] Obsolete reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral] Account remembered.'}, None), ({}, 'stop')],
            self.brain_tool_call('accepted-open', 'open_app', {'name': 'FixtureApp'}),
            [({'content': '[delivery:neutral] Asked it to open.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        held, release = asyncio.Event(), asyncio.Event()
        self.addCleanup(release.set)
        calls = []

        async def command(argv, *, stdin_data=None):
            calls.append(argv)
            if argv[0] == '/usr/bin/env':
                self.assertEqual(stdin_data, b'FixtureApp')
                if not release.is_set():
                    held.set()
                    await release.wait()
                return '{"id": "fixture.desktop", "name": "FixtureApp"}'
            self.assertIsNone(stdin_data)
            return ''

        def chunks(**kwargs):
            if kwargs['text'] != 'Asked it to open.':
                yield np.zeros(4800, dtype=np.float32)

        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, local_command=command, synthesis_chunks=chunks,
        )
        writer = None
        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Could you start FixtureApp for me?')
            await asyncio.wait_for(held.wait(), 5)
            exchange = transport.llm.channel.reader
            epoch = transport.llm.stop_epoch
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, 'stop')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(transport.llm.stop_epoch, epoch + 1)
            self.assertFalse(exchange.done(), 'The held lookup outlives the stop')
            self.assertTrue(spoken.empty(), 'Nothing had started, so the stop has nothing to account for')
            release.set()
            await asyncio.wait_for(asyncio.shield(exchange), 5)
            await asyncio.wait_for(transport.llm.local_actions.drain(), 5)
            self.assertEqual([argv[0] for argv in calls], ['/usr/bin/env'], 'A stopped brain launch never starts')
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'What happened?')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Account remembered.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Account remembered.')
            messages = [m for m in brain.requests[2][2]['messages'] if m['role'] != 'system']
            self.assertEqual(messages[0], {'role': 'user', 'content': 'Could you start FixtureApp for me?'})
            self.assertEqual([(c['function']['name'], json.loads(c['function']['arguments']))
                              for c in messages[1]['tool_calls']], [('open_app', {'name': 'FixtureApp'})])
            self.assertEqual((messages[2]['tool_call_id'], json.loads(messages[2]['content'])),
                             (messages[1]['tool_calls'][0]['id'],
                              {'confirmed': False, 'attempted': False, 'reason': 'stopped'}))
            self.assertEqual(messages[3], {'role': 'user', 'content': 'What happened?'})
            self.assertEqual(len(messages), 4)

            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(conversation.address()), 5)

            async def rows_until(predicate):
                async with asyncio.timeout(5):
                    while True:
                        snapshot = json.loads(await reader.readline())
                        if 'turns' in snapshot and predicate(snapshot['turns']):
                            return snapshot['turns']

            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please start FixtureApp again.')
            # The text frame reaches output without audio; the failed row is the delivery oracle.
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Asked it to open.')
            rows = await rows_until(lambda rows: rows and rows[-1]['speaker'] == 'kestrel'
                                    and rows[-1]['state'] == 'failed')
            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': '', 'state': 'failed'})
            self.assertEqual([argv[0] for argv in calls], ['/usr/bin/env', '/usr/bin/env', '/usr/bin/uwsm-app'])
            self.assertEqual(calls[-1][-1], 'fixture.desktop')
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, 'stop')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                             "Stopped. Done: open app. I won't undo anything.")
            self.assertEqual(len(calls), 3)
            self.assertEqual(len(brain.requests), 5)
        finally:
            release.set()
            if writer is not None:
                writer.close()
                await writer.wait_closed()
            await close()


if __name__ == '__main__':
    unittest.main()
