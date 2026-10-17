import asyncio
from copy import deepcopy
import io
import json
import struct
import wave
from functools import partial
import os
import signal
import sys
import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, DataFrame, InterruptionFrame, LLMContextAssistantTurnFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSTextFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies, UserTurnStrategies

import bot
import speech
from test_hermes import NATIVE_PYTHON, ROOT, ScriptedBrain, WorkerProcess, require_native_hermes


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


class LocalVolumeTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def volume(left, right=None):
        return json.dumps({'volume': {
            'front-left': {'value': left, 'value_percent': '30%'},
            'front-right': {'value': left if right is None else right},
        }})

    async def test_captured_output_and_ordered_writes(self):
        for percent, target in ((30, 19660), (0, 0), (100, 65536)):
            with self.subTest(percent=percent):
                command = AsyncMock(side_effect=[
                    'selected', 'physical', self.volume(32768), 'Mute: yes', '',
                    self.volume(target), '', 'selected', 'physical', self.volume(target), 'Mute: no',
                ])
                result = await bot.volume_output(percent, command=command)
                self.assertTrue(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertEqual(command.await_args_list, [
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', 'selected')),
                    call(('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical')),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                    call(('/usr/bin/pactl', 'set-sink-volume', 'physical', f'{percent}%')),
                    call(('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical')),
                    call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '0')),
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', 'selected')),
                    call(('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical')),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                ])
        for default, sink, after_volume in (
            ('changed', 'physical', self.volume(19660)),
            ('selected', 'different', self.volume(19660)),
            ('selected', 'physical', '{"volume":{"mono":{"value":19660}}}'),
        ):
            with self.subTest(default=default, sink=sink, volume=after_volume):
                command = AsyncMock(side_effect=[
                    'selected', 'physical', self.volume(32768), 'Mute: no', '', self.volume(19660),
                    default, sink, after_volume, 'Mute: no',
                ])
                result = await bot.volume_output(30, command=command)
                self.assertFalse(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertEqual(command.await_count, 10)
                self.assertEqual(sum(c.args[0][1] == 'set-sink-volume' for c in command.await_args_list), 1)

        for readback in (self.volume(19660, 19661), '{"volume":{"mono":{"value":19660}}}'):
            with self.subTest(unconfirmed_before_unmute=readback):
                command = AsyncMock(side_effect=[
                    'selected', 'physical', self.volume(32768), 'Mute: yes', '', readback,
                ])
                result = await bot.volume_output(30, command=command)
                self.assertEqual(result, bot.AudioResult(False, True, 'readback unconfirmed'))
                self.assertEqual(command.await_count, 6)
                self.assertFalse(any(c.args[0][1] == 'set-sink-mute' for c in command.await_args_list))

    async def test_verified_noop_and_zero(self):
        for percent, target, initial, muted in (
            (30, 19660, 19660, False), (30, 19660, 19660, True),
            (0, 0, 0, False), (0, 0, 0, True), (30, 19660, 19661, False),
        ):
            with self.subTest(percent=percent, initial=initial, muted=muted):
                outputs = ['selected', 'physical', self.volume(initial), 'Mute: yes' if muted else 'Mute: no']
                writes = []
                if initial != target:
                    outputs += ['', self.volume(target)]
                    writes.append(('/usr/bin/pactl', 'set-sink-volume', 'physical', f'{percent}%'))
                if muted:
                    outputs.append('')
                    writes.append(('/usr/bin/pactl', 'set-sink-mute', 'physical', '0'))
                outputs += ['selected', 'physical', self.volume(target), 'Mute: no']
                command = AsyncMock(side_effect=outputs)
                result = await bot.volume_output(percent, command=command)
                self.assertTrue(result.confirmed)
                self.assertEqual(result.attempted, bool(writes))
                self.assertEqual([c.args[0] for c in command.await_args_list if c.args[0][1].startswith('set-')], writes)
                self.assertEqual(command.await_count, len(outputs))

    async def test_invalid_readback_and_no_retry(self):
        invalid = [
            '', 'private malformed output', '[]', 'null', 'true', '{}',
            '{"volume":{"left":{"value":19660}},"metadata":NaN}',
            '{"volume":{"left":{"value":19660}},"metadata":Infinity}',
            '{"volume":[]}', '{"volume":{}}', '{"volume":{"": {"value":1}}}',
            '{"volume":{"left":null}}', '{"volume":{"left":{}}}',
            '{"volume":{"left":{"value":true}}}', '{"volume":{"left":{"value":1.0}}}',
            '{"volume":{"left":{"value":"19660"}}}', '{"volume":{"left":{"value":-1}}}',
            '{"volume":{"left":{"value":2147483648}}}',
            '{"volume":{"left":{"value":19660,"value":19660}}}',
            '{"volume":{"left":{"value":19660},"left":{"value":19660}}}',
            '{"volume":{},"volume":{"left":{"value":19660}}}',
            json.dumps({'volume': {str(n): {'value': 19660} for n in range(33)}}),
            '[' * 1100 + '0' + ']' * 1100,
        ]
        base = ['selected', 'physical', self.volume(32768), 'Mute: yes', '',
                self.volume(19660), '', 'selected', 'physical', self.volume(19660), 'Mute: no']
        cases = [(stage, value, 'invalid volume') for stage in (2, 5, 9) for value in invalid]
        cases += [(stage, RuntimeError('private command failure'), 'command failed') for stage in range(11)]
        cases += [(stage, value, reason) for stage, value, reason in (
            (0, 'bad name;', 'invalid sink'), (1, '@DEFAULT_SINK@', 'invalid sink'),
            (3, 'Mute: unknown', 'invalid status'), (7, 'bad\nname', 'invalid sink'),
            (8, '-option', 'invalid sink'), (10, 'Mute: no\r\n', 'invalid status'),
            (5, self.volume(19660, 19661), 'readback unconfirmed'),
            (5, '{"volume":{"mono":{"value":19660}}}', 'readback unconfirmed'),
            (9, self.volume(19660, 19661), 'readback unconfirmed'),
            (10, 'Mute: yes', 'readback unconfirmed'),
        )]
        for stage, value, reason in cases:
            with self.subTest(stage=stage, value=str(value)[:80]):
                outputs = base.copy()
                outputs[stage] = value
                command = AsyncMock(side_effect=outputs)
                result = await bot.volume_output(30, command=command)
                self.assertFalse(result.confirmed)
                self.assertEqual(result.attempted, stage >= 4)
                self.assertEqual(result.reason, reason)
                self.assertEqual(command.await_count, 11 if stage == 9 and reason == 'readback unconfirmed' else stage + 1)
                writes = [c.args[0] for c in command.await_args_list if c.args[0][1].startswith('set-')]
                self.assertEqual(writes, [
                    ('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'),
                    ('/usr/bin/pactl', 'set-sink-mute', 'physical', '0'),
                ][:int(stage >= 4) + int(stage >= 6)])
        for default, sink in (('changed', 'physical'), ('selected', 'changed')):
            outputs = base.copy()
            outputs[7:9] = [default, sink]
            result = await bot.volume_output(30, command=AsyncMock(side_effect=outputs))
            self.assertEqual(result, bot.AudioResult(False, True, 'target changed'))

    async def test_completed_user_turn_and_consumption(self):
        cases = [
            ([{'role': 'user', 'content': 'volume thirty percent'}], True, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': 'volume thirty percent'}], False, FrameDirection.UPSTREAM),
            ([{'role': 'assistant', 'content': 'volume thirty percent'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'system', 'content': 'volume thirty percent'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'assistant', 'content': '', 'tool_calls': [
                {'type': 'function', 'function': {'name': 'volume thirty percent', 'arguments': '{}'}},
            ]}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': 'volume thirty percent'}]}], False, FrameDirection.DOWNSTREAM),
            ([], False, FrameDirection.DOWNSTREAM),
        ]
        for messages, speculative, direction in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Only a completed downstream text-user turn may act'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'This direct processor fixture has no engine'
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                command.assert_not_awaited()
                self.assertEqual(context.get_messages(), messages)

        started = asyncio.Event()
        release = asyncio.Event()
        calls = []
        replies = iter(['selected', 'physical', self.volume(32768), 'Mute: no', '', self.volume(19660), 'selected', 'physical', self.volume(19660), 'Mute: no'])

        async def command(argv):
            calls.append(argv)
            if len(calls) == 1:
                started.set()
                await release.wait()
            return next(replies)

        service = bot.HermesLLMService(local_command=command)
        service.failure = 'This direct processor fixture has no engine'
        context = bot.LLMContext([{'role': 'user', 'content': 'volume thirty percent'}])
        frame = LLMContextFrame(context)
        processing = asyncio.create_task(service.process_frame(frame, FrameDirection.DOWNSTREAM))
        try:
            await asyncio.wait_for(started.wait(), 5)
            self.assertEqual(context.get_messages(), [], 'Consumption precedes the first native-command await')
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 1, 'Replayed context cannot start another action while the first is pending')
            release.set()
            await asyncio.wait_for(processing, 5)
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 10)
            self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')), 1)
            self.assertFalse(service.local_tasks)
        finally:
            release.set()
            await service.close_local_tools()
            if not processing.done():
                processing.cancel()
            await asyncio.gather(processing, return_exceptions=True)

    async def test_timeout_and_cancellation(self):
        for effect in ('set-sink-volume', 'set-sink-mute'):
            with self.subTest(effect=effect):
                started, cleaned = asyncio.Event(), asyncio.Event()
                calls = []

                async def hung(argv):
                    calls.append(argv)
                    if argv[1] == effect:
                        started.set()
                        try:
                            await asyncio.Future()
                        finally:
                            cleaned.set()
                    if argv[1] == 'get-default-sink':
                        return 'selected'
                    if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                        return 'physical'
                    if argv[1] == '--format=json':
                        return self.volume(32768 if len(calls) == 3 else 19660)
                    if argv[1] == 'get-sink-mute':
                        return 'Mute: yes'
                    return ''

                with patch.object(bot, 'VOLUME_TIMEOUT', 0.01):
                    result = await asyncio.wait_for(bot.volume_output(30, command=hung), 5)
                self.assertTrue(started.is_set())
                self.assertTrue(cleaned.is_set())
                self.assertEqual(result, bot.AudioResult(False, True, 'volume timeout'))
                self.assertEqual(len(calls), 5 if effect == 'set-sink-volume' else 7)
                calls.clear()
                started.clear()
                cleaned.clear()
                task = asyncio.create_task(bot.volume_output(30, command=hung))
                try:
                    await asyncio.wait_for(started.wait(), 5)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    self.assertTrue(cleaned.is_set())
                    self.assertEqual(len(calls), 5 if effect == 'set-sink-volume' else 7)
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_exact_volume_grammar_and_permission(self):
        phrases = {
            'volume zero percent': 0, 'volume one percent': 1, 'volume nine percent': 9,
            'volume ten percent': 10, 'volume eleven percent': 11, 'volume twelve percent': 12,
            'volume thirteen percent': 13, 'volume fourteen percent': 14,
            'volume fifteen percent': 15, 'volume sixteen percent': 16,
            'volume seventeen percent': 17, 'volume eighteen percent': 18,
            'volume nineteen percent': 19, 'volume twenty percent': 20,
            'volume twenty-one percent': 21, 'volume thirty percent': 30,
            'volume forty two percent': 42, 'volume fifty-three percent': 53,
            'volume sixty four percent': 64, 'volume seventy-five percent': 75,
            'volume eighty six percent': 86, 'volume ninety-nine percent': 99,
            'volume one hundred percent': 100, 'volume 0 percent': 0,
            'volume 30%': 30, 'volume 30 %': 30, 'volume 100 percent': 100,
            ' VOLUME THIRTY PERCENT! ': 30, 'Volume 1%.': 1,
        }
        for text, percent in phrases.items():
            with self.subTest(text=text):
                tool = bot.match_instant_tool(text)
                self.assertIsNotNone(tool)
                self.assertEqual(tool.permission, bot.PermissionTier.FREE)
                self.assertEqual(tool.subject, 'volume')
                self.assertIsNot(tool, bot.LOCAL_TOOLS['volume'])
                command = AsyncMock()
                action = AsyncMock()
                with patch.dict(bot.LOCAL_TOOLS, volume=bot.LocalTool(bot.PermissionTier.FREE, action, 'volume')):
                    tool = bot.match_instant_tool(text)
                    await tool.run(command=command)
                    action.assert_awaited_once_with(percent, command=command)
        for text in (
            'volume 101 percent', 'volume -1 percent', 'volume +30 percent',
            'volume 030 percent', 'volume 00%', 'volume 30.0 percent', 'volume ٣٠ percent',
            'volume thirty%', 'volume hundred percent', 'volume twenty ten percent',
            'volume thirty  one percent', 'volume thirty--one percent', 'volume thirty percent?',
            'volume 30%!!', '"volume 30%"', 'do not volume 30%', 'please volume 30%',
            'volume 30 percent please', 'volume 30 percent and mute', 'volume\n30 percent',
            'volume\t30 percent', 'volume  30 percent', 'volume 1e2 percent', '',
        ):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, volume=bot.LocalTool(permission, AsyncMock(), 'volume')):
                self.assertIsNone(bot.match_instant_tool('volume thirty percent'))


class LocalDesktopTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def media(**changes):
        return json.dumps(dict(hasPlayer=True, playing=True, canGoNext=True,
                               identity='Player', desktopEntry='player.desktop',
                               title='First track', artist='Artist', album='Album') | changes)

    async def test_media_actions_require_observed_state(self):
        for phrase, action in (('pause music', 'pause'), ('next track', 'next')):
            self.assertIsNotNone(bot.match_instant_tool(phrase), 'Exact media turns must select local work')
            tool = bot.LOCAL_TOOLS[phrase]
            self.assertEqual(tool.permission, bot.PermissionTier.FREE)
            for text in (phrase, ' ' + phrase.upper() + '. ', phrase + '!'):
                self.assertIs(bot.match_instant_tool(text), tool)
            for text in (phrase + '?', '"' + phrase + '"', phrase + '!!', 'do not ' + phrase,
                         phrase + ' please', phrase.replace(' ', '\n'), phrase + '; echo bad'):
                self.assertIsNone(bot.match_instant_tool(text))
            for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
                with patch.dict(bot.LOCAL_TOOLS, {phrase: bot.LocalTool(permission, AsyncMock(), phrase)}):
                    self.assertIsNone(bot.match_instant_tool(phrase))
            status = ('/usr/bin/omarchy-shell', 'media', 'status')
            write = ('/usr/bin/omarchy-shell', 'media', action)
            good = self.media(playing=False) if action == 'pause' else self.media(title='Second track')
            failure = ("I couldn't confirm pause. Check the media player. I won't retry." if action == 'pause'
                       else "I couldn't confirm next track. Check the media player. I won't retry.")
            for initial in (self.media(hasPlayer=False, playing=False), self.media(playing=False)):
                command = AsyncMock(return_value=initial)
                result = await tool.run(command=command)
                self.assertFalse(result.confirmed)
                self.assertFalse(result.attempted)
                self.assertEqual(result.message, "I couldn't find a playing media player.")
                self.assertEqual(command.await_args_list, [call(status)])
            for lag in range(3):
                command = AsyncMock(side_effect=[self.media(), 'ok\n', *[self.media()] * lag, good])
                with patch.object(bot.asyncio, 'sleep', AsyncMock()) as delay:
                    result = await tool.run(command=command)
                self.assertTrue(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertIsNone(result.message)
                self.assertEqual(command.await_args_list, [call(status), call(write)] + [call(status)] * (lag + 1))
                self.assertEqual(delay.await_args_list, [call(.15), call(.35)][:lag])
            for reply in ('unhandled', 'ok\n\n', 'ok\r\n', ' ok', 'PRIVATE OUTPUT', RuntimeError('PRIVATE')):
                command = AsyncMock(side_effect=[self.media(), reply])
                result = await tool.run(command=command)
                self.assertFalse(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertEqual(result.message, failure)
                self.assertEqual(command.await_args_list, [call(status), call(write)])
            invalid = ['', 'null', '[]', '{}', 'PRIVATE', '{"hasPlayer":true,"hasPlayer":false}',
                       self.media(playing=1), self.media(canGoNext='true'), self.media(hasPlayer=False),
                       self.media(title=None), self.media(identity=[]), self.media(album=3),
                       self.media(artist=True), self.media(desktopEntry={}), self.media(hasPlayer=1),
                       self.media(title=float('nan')), '[' * 1100 + '0' + ']' * 1100, ' ' * 4097]
            missing = json.loads(self.media())
            del missing['album']
            invalid.append(json.dumps(missing))
            for output in invalid:
                with self.subTest(action=action, invalid=output[:80]):
                    command = AsyncMock(return_value=output)
                    result = await tool.run(command=command)
                    self.assertFalse(result.confirmed)
                    self.assertFalse(result.attempted)
                    self.assertEqual(result.message, failure)
                    self.assertEqual(command.await_args_list, [call(status)])
            corrupt = [self.media(identity='Other'), self.media(desktopEntry='other'),
                       self.media(identity=''), self.media(desktopEntry=''),
                       self.media(hasPlayer=False, playing=False), self.media(), '{}']
            corrupt += ([self.media(playing=False, title='Other')] if action == 'pause' else
                        [self.media(playing=False, title='Second'), self.media(title='')])
            for after in corrupt:
                with self.subTest(action=action, readback=after):
                    command = AsyncMock(side_effect=[self.media(), 'ok', after, after, after])
                    with patch.object(bot.asyncio, 'sleep', AsyncMock()):
                        result = await tool.run(command=command)
                    self.assertFalse(result.confirmed)
                    self.assertTrue(result.attempted)
                    self.assertEqual(result.message, failure)
                    self.assertEqual(command.await_args_list.count(call(write)), 1)
                    self.assertLessEqual(command.await_count, 5)
            for stage in (0, 2):
                command = AsyncMock(side_effect=([RuntimeError('PRIVATE')] if stage == 0 else
                                                 [self.media(), 'ok', RuntimeError('PRIVATE')]))
                result = await tool.run(command=command)
                self.assertFalse(result.confirmed)
                self.assertEqual(result.attempted, stage == 2)
                self.assertEqual(result.message, failure)
            for initial in ([self.media(canGoNext=False), self.media(title=''), self.media(identity=''),
                             self.media(desktopEntry='')] if action == 'next' else []):
                command = AsyncMock(return_value=initial)
                result = await tool.run(command=command)
                self.assertFalse(result.confirmed)
                self.assertFalse(result.attempted)
                self.assertEqual(result.message, failure)
                self.assertEqual(command.await_count, 1)

            # The completed-turn path must consume before a blocked native read and never replay it.
            started, release = asyncio.Event(), asyncio.Event()
            async def blocked_command(argv):
                started.set()
                await release.wait()
                return self.media(playing=False)
            service = bot.HermesLLMService(local_command=blocked_command)
            service.failure = 'No engine in this direct fixture'
            service.push_frame = AsyncMock()
            context = bot.LLMContext([{'role': 'user', 'content': phrase}])
            frame = LLMContextFrame(context)
            processing = asyncio.create_task(service.process_frame(frame, FrameDirection.DOWNSTREAM))
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertEqual(context.get_messages(), [])
                await service.process_frame(frame, FrameDirection.DOWNSTREAM)
                release.set()
                await asyncio.wait_for(processing, 5)
                notices = [c.args[0] for c in service.push_frame.await_args_list
                           if isinstance(c.args[0], bot.TTSSpeakFrame)]
                self.assertEqual([n.text for n in notices], ["I couldn't find a playing media player."])
                self.assertFalse(notices[0].append_to_context)
                self.assertFalse(service.local_tasks)
            finally:
                release.set()
                await service.close_local_tools()
                processing.cancel()
                await asyncio.gather(processing, return_exceptions=True)
            for messages, speculative, direction in (
                ([{'role': 'user', 'content': phrase}], True, FrameDirection.DOWNSTREAM),
                ([{'role': 'user', 'content': phrase}], False, FrameDirection.UPSTREAM),
                ([{'role': 'assistant', 'content': phrase}], False, FrameDirection.DOWNSTREAM),
                ([{'role': 'system', 'content': phrase}], False, FrameDirection.DOWNSTREAM),
                ([{'role': 'user', 'content': [{'type': 'text', 'text': phrase}]}], False, FrameDirection.DOWNSTREAM),
            ):
                command = AsyncMock(side_effect=AssertionError('Ineligible media cannot run'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'No engine in this direct fixture'
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                command.assert_not_awaited()
                self.assertEqual(context.get_messages(), messages)
        with self.assertRaises(ValueError):
            await bot.media_action('playPause', command=AsyncMock())
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def hanging(argv):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cleaned.set()
        with patch.object(bot, 'DESKTOP_TIMEOUT', .01):
            result = await bot.media_action('pause', command=hanging)
        self.assertTrue(started.is_set())
        self.assertTrue(cleaned.is_set())
        self.assertFalse(result.confirmed)
        self.assertFalse(result.attempted)
        task = asyncio.create_task(bot.media_action('pause', command=hanging))
        started.clear()
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_stop_cancel_only_consume_completed_exact_turns(self):
        accepted = ('stop', ' STOP. ', 'Stop!', 'cancel', ' CANCEL. ', 'Cancel!')
        rejected = ('stop?', 'cancel?', 'stop!!', 'cancel!!', '"stop"', '"cancel"',
                    'do not stop', 'please cancel', 'stop now', 'cancel that', 'st\nop', 'can\ncel', '')
        previous = [{'role': 'user', 'content': 'Previous request'},
                    {'role': 'assistant', 'content': 'Known spoken reply.'}]
        cases = [(previous + [{'role': 'user', 'content': word}], False, FrameDirection.DOWNSTREAM,
                  word in accepted) for word in (*accepted, *rejected)]
        for word in ('stop', 'cancel'):
            cases.extend([
                ([{'role': 'user', 'content': word}], True, FrameDirection.DOWNSTREAM, False),
                ([{'role': 'user', 'content': word}], False, FrameDirection.UPSTREAM, False),
                ([{'role': 'assistant', 'content': word}], False, FrameDirection.DOWNSTREAM, False),
                ([{'role': 'system', 'content': word}], False, FrameDirection.DOWNSTREAM, False),
                ([{'role': 'user', 'content': [{'type': 'text', 'text': word}]}], False, FrameDirection.DOWNSTREAM, False),
            ])
        for messages, speculative, direction, consumes in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Stopping a reply cannot call desktop commands'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'This direct fixture has no engine'
                service.last_spoken_reply = 'Known spoken reply.'
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                self.assertEqual(context.get_messages(), messages[:-1] if consumes else messages,
                                 'An exact completed stop/cancel must be consumed locally')
                if consumes:
                    service.push_frame.assert_not_awaited()
                command.assert_not_awaited()
                self.assertEqual(service.last_spoken_reply, 'Known spoken reply.')
                self.assertFalse(service.local_tasks)

        for word in ('stop', 'cancel'):
            started, release = asyncio.Event(), asyncio.Event()
            calls = []
            paused = False
            async def command(argv):
                nonlocal paused
                calls.append(argv)
                if argv == ('/usr/bin/omarchy-shell', 'media', 'pause'):
                    started.set()
                    await release.wait()
                    paused = True
                    return 'ok'
                self.assertEqual(argv, ('/usr/bin/omarchy-shell', 'media', 'status'))
                return self.media(playing=not paused)
            service = bot.HermesLLMService(local_command=command)
            service.failure = 'This direct fixture has no engine'
            service.push_frame = AsyncMock()
            held_reader = asyncio.create_task(asyncio.Event().wait())
            service.reader = held_reader
            context = bot.LLMContext([{'role': 'user', 'content': 'pause music'}])
            action = asyncio.create_task(service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM))
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertTrue(service.local_tool_lock.locked())
                self.assertEqual(len(service.local_tasks), 1)
                local_task = next(iter(service.local_tasks))
                stopping = bot.LLMContext([{'role': 'user', 'content': word}])
                await asyncio.wait_for(service.process_frame(LLMContextFrame(stopping), FrameDirection.DOWNSTREAM), 5)
                self.assertEqual(stopping.get_messages(), [])
                self.assertIs(service.reader, held_reader)
                self.assertFalse(held_reader.done(), 'Stop does not cancel native engine drainage')
                self.assertFalse(local_task.done(), 'Stop does not cancel an attempted desktop action')
                self.assertTrue(service.local_tool_lock.locked())
                self.assertEqual(len(calls), 2)
                service.push_frame.assert_not_awaited()
                release.set()
                await asyncio.wait_for(action, 5)
                self.assertEqual(calls.count(('/usr/bin/omarchy-shell', 'media', 'pause')), 1)
                self.assertFalse(service.local_tasks)
                service.push_frame.assert_not_awaited()
            finally:
                release.set()
                await service.close_local_tools()
                held_reader.cancel()
                action.cancel()
                await asyncio.gather(held_reader, action, return_exceptions=True)

    async def test_workspace_focus_requires_matching_readback(self):
        self.assertIsNotNone(bot.match_instant_tool('workspace three'),
                             'A completed numbered workspace phrase must select local work')
        status = ('/usr/bin/hyprctl', '-j', 'activeworkspace')
        for phrase, number in (('workspace three', 3), (' WORKSPACE 3. ', 3), ('workspace eleven!', 11),
                               ('workspace 11', 11), ('workspace one hundred', 100), ('workspace 100', 100),
                               ('workspace twenty-one', 21), ('workspace twenty one', 21),
                               ('workspace 2147483647', 2147483647)):
            with self.subTest(phrase=phrase):
                tool = bot.match_instant_tool(phrase)
                self.assertIsNotNone(tool)
                self.assertEqual(tool.permission, bot.PermissionTier.FREE)
                dispatch = ('/usr/bin/hyprctl', 'dispatch', f'hl.dsp.focus({{ workspace = "{number}" }})')
                command = AsyncMock(side_effect=['{"id":-99}', 'ok\n', json.dumps({'id': number})])
                result = await tool.run(command=command)
                self.assertTrue(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertIsNone(result.message)
                self.assertEqual(command.await_args_list, [call(status), call(dispatch), call(status)])
                command = AsyncMock(return_value=json.dumps({'id': number}))
                result = await tool.run(command=command)
                self.assertTrue(result.confirmed)
                self.assertFalse(result.attempted)
                self.assertIsNone(result.message)
                self.assertEqual(command.await_args_list, [call(status)])
        for text in ('workspace 0', 'workspace zero', 'workspace -3', 'workspace 03', 'workspace ٣',
                     'workspace ３', 'workspace 2147483648', 'workspace 999999999999999999999999',
                     'workspace three please', 'workspace three?', 'workspace\nthree',
                     'workspace 3; exec bad', 'workspace $(id)', 'workspace +3', 'workspace 3.0',
                     'workspace three!!', '"workspace three"', 'do not workspace three',
                     'workspace one hundred one', 'workspace 1' + '0' * 5000):
            self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, workspace=bot.LocalTool(permission, AsyncMock(), 'workspace')):
                self.assertIsNone(bot.match_instant_tool('workspace three'))
        command = AsyncMock()
        for value in (True, False, 0, -1, 2147483648, '3', 3.0, None):
            with self.assertRaises(ValueError):
                await bot.workspace_action(value, command=command)
        command.assert_not_awaited()
        dispatch = ('/usr/bin/hyprctl', 'dispatch', 'hl.dsp.focus({ workspace = "3" })')
        advisory = "I couldn't confirm workspace 3. Check the desktop. I won't retry."
        for lag in range(3):
            command = AsyncMock(side_effect=['{"id":1}', 'ok', *['{"id":1}'] * lag, '{"id":3}'])
            with patch.object(bot.asyncio, 'sleep', AsyncMock()) as delay:
                result = await bot.workspace_action(3, command=command)
            self.assertTrue(result.confirmed)
            self.assertTrue(result.attempted)
            self.assertIsNone(result.message)
            self.assertEqual(command.await_args_list, [call(status), call(dispatch)] + [call(status)] * (lag + 1))
            self.assertEqual(delay.await_args_list, [call(.15), call(.35)][:lag])
        invalid = ['', 'PRIVATE', 'null', '[]', '{}', '{"id":true}', '{"id":"3"}', '{"id":3.0}',
                   '{"id":3,"id":11}', '{"id":NaN}', '{"id":Infinity}', '{"id":null}',
                   '[' * 1100 + '0' + ']' * 1100, ' ' * 4097]
        for stage in (0, 2):
            for output in invalid + [RuntimeError('PRIVATE command output')]:
                with self.subTest(stage=stage, output=str(output)[:80]):
                    command = AsyncMock(side_effect=([output] if stage == 0 else ['{"id":1}', 'ok', output]))
                    result = await bot.workspace_action(3, command=command)
                    self.assertFalse(result.confirmed)
                    self.assertEqual(result.attempted, stage == 2)
                    self.assertEqual(result.message, advisory)
                    self.assertEqual(command.await_args_list, [call(status), call(dispatch), call(status)][:stage + 1])
        for reply in ('unhandled', 'ok\n\n', 'ok\r\n', ' ok', 'PRIVATE', RuntimeError('PRIVATE')):
            command = AsyncMock(side_effect=['{"id":1}', reply])
            result = await bot.workspace_action(3, command=command)
            self.assertFalse(result.confirmed)
            self.assertTrue(result.attempted)
            self.assertEqual(result.message, advisory)
            self.assertEqual(command.await_args_list, [call(status), call(dispatch)])
        command = AsyncMock(side_effect=['{"id":1}', 'ok', '{"id":1}', '{"id":2}', '{"id":1}'])
        with patch.object(bot.asyncio, 'sleep', AsyncMock()):
            result = await bot.workspace_action(3, command=command)
        self.assertFalse(result.confirmed)
        self.assertTrue(result.attempted)
        self.assertEqual(result.message, advisory)
        self.assertEqual(command.await_args_list, [call(status), call(dispatch), call(status), call(status), call(status)])
        for hang_at in (1, 2):
            calls = []
            cleaned = asyncio.Event()
            async def hanging(argv):
                calls.append(argv)
                if len(calls) != hang_at:
                    return '{"id":1}'
                try:
                    await asyncio.Future()
                finally:
                    cleaned.set()
            with patch.object(bot, 'DESKTOP_TIMEOUT', .01):
                result = await bot.workspace_action(3, command=hanging)
            self.assertTrue(cleaned.is_set())
            self.assertFalse(result.confirmed)
            self.assertEqual(result.attempted, hang_at == 2)
            self.assertEqual(result.message, advisory)
            self.assertEqual(calls, [status, dispatch][:hang_at])

    async def test_desktop_environment_is_local_and_bounded(self):
        selectors = {'WAYLAND_DISPLAY': 'wayland-1', 'HYPRLAND_INSTANCE_SIGNATURE': 'instance_12.ab-3'}
        uid = os.getuid()
        baseline = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
                    'XDG_RUNTIME_DIR': f'/run/user/{uid}',
                    'PULSE_SERVER': f'unix:/run/user/{uid}/pulse/native',
                    'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus'}
        poisoned = selectors | {'PATH': '/poison', 'HOME': '/poison', 'OMARCHY_PATH': '/poison',
                                'PULSE_SERVER': 'tcp:remote', 'DBUS_SESSION_BUS_ADDRESS': 'tcp:remote',
                                'HTTP_PROXY': 'http://remote', 'PYTHONPATH': '/poison'}
        for argv in (('/usr/bin/omarchy-shell', 'media', 'status'),
                     ('/usr/bin/hyprctl', '-j', 'activeworkspace')):
            process = Mock(pid=9876, returncode=0)
            process.stdout.read = AsyncMock(side_effect=[b'ok\n', b''])
            process.wait = AsyncMock(return_value=0)
            expected = baseline | selectors
            if argv[0] == '/usr/bin/omarchy-shell':
                expected['OMARCHY_PATH'] = '/usr/share/omarchy'
            with (patch.dict(os.environ, poisoned, clear=True),
                  patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
                self.assertEqual(await bot.run_local_command(argv), 'ok\n')
                spawn.assert_awaited_once_with(
                    *argv, env=expected, stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                    start_new_session=True,
                )
            for key in selectors:
                for value in (None, '', 'a' * 257, '../session', 'session:remote', 'bad\nvalue',
                              'bad;command', 'é', '$(id)', 'white space'):
                    env = poisoned.copy()
                    if value is None:
                        env.pop(key)
                    else:
                        env[key] = value
                    with (patch.dict(os.environ, env, clear=True),
                          patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock()) as spawn):
                        with self.assertRaisesRegex(RuntimeError, '^desktop session unavailable$'):
                            await bot.run_local_command(argv)
                        spawn.assert_not_awaited()
        process = Mock(pid=9876, returncode=0)
        process.stdout.read = AsyncMock(side_effect=[b'ok', b''])
        process.wait = AsyncMock(return_value=0)
        with (patch.dict(os.environ, poisoned, clear=True),
              patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
            await bot.run_local_command(('/tmp/omarchy-shell', 'media', 'status'))
            self.assertEqual(spawn.await_args.kwargs['env'], baseline)



class LocalMuteTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeat_only_handles_completed_exact_user_turns(self):
        accepted = ('repeat that', ' REPEAT THAT. ', 'Repeat that!', ' Repeat That? ')
        rejected = ('"repeat that"', 'repeat that!!', 'repeat that??', 'do not repeat that',
                    'repeat that please', 'repeat\nthat', '')
        cases = [([{'role': 'user', 'content': text}], False, FrameDirection.DOWNSTREAM,
                  text in accepted) for text in (*accepted, *rejected)]
        cases.extend([
            ([{'role': 'user', 'content': 'repeat that'}], True, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'user', 'content': 'repeat that'}], False, FrameDirection.UPSTREAM, False),
            ([{'role': 'assistant', 'content': 'repeat that'}], False, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'system', 'content': 'repeat that'}], False, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': 'repeat that'}]}],
             False, FrameDirection.DOWNSTREAM, False),
            ([], False, FrameDirection.DOWNSTREAM, False),
        ])
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'volume', 'pause music', 'next track', 'workspace'})
        for messages, speculative, direction, consumes in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Repeat must not invoke a desktop command'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'This direct processor fixture has no engine'
                service.last_spoken_reply = 'Known last reply.'
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                self.assertEqual(context.get_messages(), [] if consumes else messages)
                replay = [args.args[0] for args in service.push_frame.await_args_list
                          if isinstance(args.args[0], bot.TTSSpeakFrame)]
                self.assertEqual([frame.text for frame in replay], ['Known last reply.'] if consumes else [])
                if consumes:
                    self.assertFalse(replay[0].append_to_context)
                command.assert_not_awaited()

    async def test_processor_excludes_speculative_nonuser_and_upstream_mute(self):
        cases = [
            ([{'role': 'user', 'content': 'mute'}], True, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': 'mute'}], False, FrameDirection.UPSTREAM),
            ([{'role': 'assistant', 'content': 'mute'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'system', 'content': 'mute'}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'assistant', 'content': '', 'tool_calls': [
                {'type': 'function', 'function': {'name': 'mute', 'arguments': '{}'}},
            ]}], False, FrameDirection.DOWNSTREAM),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': 'mute'}]}], False, FrameDirection.DOWNSTREAM),
            ([], False, FrameDirection.DOWNSTREAM),
        ]
        for messages, speculative, direction in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Only a completed downstream text-user turn may act'))
                service = bot.HermesLLMService(local_command=command)
                service.failure = 'This direct processor fixture has no engine'
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                command.assert_not_awaited()
                self.assertEqual(context.get_messages(), messages)

    async def test_processor_consumes_mute_before_await_and_cannot_replay_context(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])

        async def command(argv):
            calls.append(argv)
            if len(calls) == 1:
                started.set()
                await release.wait()
            return next(replies)

        service = bot.HermesLLMService(local_command=command)
        service.failure = 'This direct processor fixture has no engine'
        context = bot.LLMContext([{'role': 'user', 'content': 'mute'}])
        frame = LLMContextFrame(context)
        processing = asyncio.create_task(service.process_frame(frame, FrameDirection.DOWNSTREAM))
        try:
            await asyncio.wait_for(started.wait(), 5)
            self.assertEqual(context.get_messages(), [], 'Consumption precedes the first native-command await')
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 1, 'Replayed context cannot start another action while the first is pending')
            release.set()
            await asyncio.wait_for(processing, 5)
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            self.assertEqual(len(calls), 7)
            self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
            self.assertFalse(service.local_tasks)
        finally:
            release.set()
            await service.close_local_tools()
            if not processing.done():
                processing.cancel()
            await asyncio.gather(processing, return_exceptions=True)

    def test_only_exact_mute_selects_a_free_tool(self):
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'volume', 'pause music', 'next track', 'workspace'})
        tool = bot.LOCAL_TOOLS['mute']
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        self.assertTrue(callable(tool.run))
        for text in ('mute', ' MUTE ', 'mute.', 'Mute!'):
            with self.subTest(text=text):
                self.assertIs(bot.match_instant_tool(text), tool)
        for text in ('mute?', '"mute"', 'mute!!', 'do not mute', 'mute this',
                     'unmute', 'please mute', 'mute; echo bad', '', 'mute\nnow'):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, mute=bot.LocalTool(permission, AsyncMock(), 'mute')):
                self.assertIsNone(bot.match_instant_tool('mute'))


    async def test_mute_sets_one_captured_sink_and_requires_readback(self):
        command = AsyncMock(side_effect=[
            'processing.sink\n', 'alsa_output.test\n', 'Mute: no\n', '',
            'processing.sink\n', 'alsa_output.test\n', 'Mute: yes\n',
        ])
        result = await bot.mute_output(command=command)
        self.assertTrue(result.confirmed)
        self.assertTrue(result.attempted)
        self.assertEqual(command.await_args_list, [
            call(('/usr/bin/pactl', 'get-default-sink')),
            call(('/usr/bin/omarchy-audio-output-sink', 'processing.sink')),
            call(('/usr/bin/pactl', 'get-sink-mute', 'alsa_output.test')),
            call(('/usr/bin/pactl', 'set-sink-mute', 'alsa_output.test', '1')),
            call(('/usr/bin/pactl', 'get-default-sink')),
            call(('/usr/bin/omarchy-audio-output-sink', 'processing.sink')),
            call(('/usr/bin/pactl', 'get-sink-mute', 'alsa_output.test')),
        ])


    async def test_already_muted_is_a_verified_noop(self):
        for after_default, after_sink, after_status, confirmed, reason in (
            ('selected', 'physical', 'Mute: yes', True, 'already muted'),
            ('changed', 'physical', 'Mute: yes', False, 'target changed'),
            ('selected', 'different', 'Mute: yes', False, 'target changed'),
            ('selected', 'physical', 'Mute: no', False, 'readback unconfirmed'),
        ):
            with self.subTest(reason=reason, target=(after_default, after_sink)):
                command = AsyncMock(side_effect=[
                    'selected\n', 'physical\n', 'Mute: yes\n',
                    after_default, after_sink, after_status,
                ])
                result = await bot.mute_output(command=command)
                self.assertEqual(result, bot.AudioResult(confirmed, False, reason))
                self.assertEqual(command.await_args_list, [
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', 'selected')),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                    call(('/usr/bin/pactl', 'get-default-sink')),
                    call(('/usr/bin/omarchy-audio-output-sink', after_default)),
                    call(('/usr/bin/pactl', 'get-sink-mute', 'physical')),
                ])

    async def test_corrupt_status_or_changed_target_is_unconfirmed_without_retry(self):
        hostile = ('', 'one\ntwo\n', 'a' * 257, '@DEFAULT_SINK@', '-option',
                   '.hidden', ':alias', 'name;touch file', 'name$(id)', 'speaker é',
                   'space name', 'name\n\n', 'name\r\n')
        cases = []
        for name in hostile:
            cases.append(([name], False, 1, 'invalid sink'))
            cases.append((['selected\n', name], False, 2, 'invalid sink'))
        for status in ('', 'Mute: unknown\n', 'Mute: yes\n\n', 'Mute: YES', ' Mute: no', 'Mute: no\r\n'):
            cases.append((['selected', 'physical', status], False, 3, 'invalid status'))
        prefix = ['selected', 'physical', 'Mute: no', '']
        cases.extend([
            (prefix + ['changed', 'physical', 'Mute: yes'], True, 7, 'target changed'),
            (prefix + ['selected', 'different', 'Mute: yes'], True, 7, 'target changed'),
            (prefix + ['selected', 'physical', 'Mute: no'], True, 7, 'readback unconfirmed'),
            (prefix + ['selected', 'physical', 'bad status'], True, 7, 'invalid status'),
            (['selected', 'physical', 'Mute: no', RuntimeError('private error')], True, 4, 'command failed'),
            ([RuntimeError('missing')], False, 1, 'command failed'),
            (prefix + [RuntimeError('private output')], True, 5, 'command failed'),
        ])
        for outputs, attempted, count, reason in cases:
            with self.subTest(outputs=outputs):
                command = AsyncMock(side_effect=outputs)
                result = await bot.mute_output(command=command)
                self.assertFalse(result.confirmed)
                self.assertEqual(result.attempted, attempted)
                self.assertEqual(result.reason, reason)
                self.assertEqual(command.await_count, count)
                writes = [c for c in command.await_args_list if c.args[0][1] == 'set-sink-mute']
                self.assertEqual(len(writes), int(attempted))
                if writes:
                    self.assertEqual(writes[0], call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')))
        started = asyncio.Event()
        stopped = asyncio.Event()
        commands = []

        async def hung(argv):
            commands.append(argv)
            if argv[1] == 'get-default-sink':
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if argv[1] == 'get-sink-mute':
                return 'Mute: no'
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        with patch.object(bot, 'MUTE_TIMEOUT', 0.01, create=True):
            result = await asyncio.wait_for(bot.mute_output(command=hung), 5)
        self.assertTrue(started.is_set())
        self.assertTrue(stopped.is_set())
        self.assertEqual(result, bot.AudioResult(False, True, 'mute timeout'))
        self.assertEqual(len(commands), 4)
        commands.clear()
        started.clear()
        stopped.clear()
        task = asyncio.create_task(bot.mute_output(command=hung))
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        self.assertEqual(len(commands), 4)


    async def test_local_command_is_bounded_and_cannot_inherit_remote_routing(self):
        poisoned = {'PATH': '/poison', 'LC_ALL': 'other', 'HOME': '/poison',
                    'PULSE_SERVER': 'tcp:remote', 'DBUS_SESSION_BUS_ADDRESS': 'tcp:remote',
                    'HTTP_PROXY': 'http://remote', 'PYTHONPATH': '/poison',
                    'XDG_RUNTIME_DIR': '/poison'}
        uid = os.getuid()
        env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
               'XDG_RUNTIME_DIR': f'/run/user/{uid}',
               'PULSE_SERVER': f'unix:/run/user/{uid}/pulse/native',
               'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus'}
        for output, exitcode, message in [
            (b'local\n', 0, None), (b'x' * 4097, 0, 'output too large'),
            (b'\xff', 0, 'invalid output'), (b'private text', 2, 'command failed'),
        ]:
            with self.subTest(message=message):
                process = Mock(pid=9876, returncode=exitcode)
                process.stdout.read = AsyncMock(side_effect=[output, b''])
                process.wait = AsyncMock(return_value=exitcode)
                with (patch.dict(os.environ, poisoned),
                      patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg') as killpg):
                    if message is None:
                        self.assertEqual(await bot.run_local_command(('/test/command', 'literal;arg')), 'local\n')
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^' + message + '$'):
                            await bot.run_local_command(('/test/command', 'literal;arg'))
                    spawn.assert_awaited_once_with(
                        '/test/command', 'literal;arg', env=env,
                        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
                    )
                    self.assertTrue(all(0 < c.args[0] <= 4097 for c in process.stdout.read.await_args_list))
                    if message:
                        self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
                    else:
                        killpg.assert_not_called()
        with patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(side_effect=FileNotFoundError())):
            with self.assertRaisesRegex(RuntimeError, '^command unavailable$'):
                await bot.run_local_command(('/missing/command',))

        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                started = asyncio.Event()
                stopped = asyncio.Event()
                reaped = asyncio.Event()
                process = Mock(pid=9876, returncode=None)

                async def read(size):
                    self.assertLessEqual(size, 4097)
                    started.set()
                    try:
                        await asyncio.Future()
                    finally:
                        stopped.set()

                async def wait():
                    if process.returncode is None:
                        await asyncio.Future()
                    reaped.set()
                    return process.returncode

                def signal_group(pid, sig):
                    self.assertEqual(pid, 9876)
                    if sig == signal.SIGKILL:
                        process.returncode = -signal.SIGKILL

                process.stdout.read = AsyncMock(side_effect=read)
                process.wait = AsyncMock(side_effect=wait)
                with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg', side_effect=signal_group) as killpg,
                      patch.object(bot, 'LOCAL_COMMAND_TIMEOUT', 0.01, create=True),
                      patch.object(bot, 'LOCAL_COMMAND_CLEANUP_TIMEOUT', 0.01, create=True)):
                    task = asyncio.create_task(bot.run_local_command(('/test/hung',)))
                    await asyncio.wait_for(started.wait(), 5)
                    if cancel:
                        task.cancel()
                    with self.assertRaises(asyncio.CancelledError if cancel else RuntimeError):
                        await asyncio.wait_for(task, 5)
                    self.assertTrue(stopped.is_set())
                    self.assertTrue(reaped.is_set())
                    self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
                    spawn.assert_awaited_once()

        # The leader can exit gracefully while a descendant ignores TERM.
        process = Mock(pid=9876, returncode=None)
        process.stdout.read = AsyncMock(return_value=b'x' * 4097)
        process.wait = AsyncMock(return_value=-signal.SIGTERM)
        descendant_alive = True

        def signal_descendant(pid, sig):
            nonlocal descendant_alive
            if sig == signal.SIGTERM:
                process.returncode = -signal.SIGTERM
            elif sig == signal.SIGKILL:
                descendant_alive = False

        with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)),
              patch.object(bot.os, 'killpg', side_effect=signal_descendant) as killpg):
            with self.assertRaisesRegex(RuntimeError, '^output too large$'):
                await bot.run_local_command(('/test/descendant',))
            self.assertFalse(descendant_alive)
            self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
            self.assertTrue(process.wait.await_count)


        cleanup_started = asyncio.Event()
        release_cleanup = asyncio.Event()
        reaped = asyncio.Event()
        process = Mock(pid=9876, returncode=None)
        process.stdout.read = AsyncMock(return_value=b'x' * 4097)

        async def wait_during_cleanup():
            cleanup_started.set()
            await release_cleanup.wait()
            reaped.set()
            return -signal.SIGTERM

        process.wait = AsyncMock(side_effect=wait_during_cleanup)
        with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)),
              patch.object(bot.os, 'killpg') as killpg):
            task = asyncio.create_task(bot.run_local_command(('/test/cleanup',)))
            await asyncio.wait_for(cleanup_started.wait(), 5)
            task.cancel()
            release_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
            self.assertTrue(reaped.is_set(), 'Cancellation must wait for native cleanup')
            self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])

    async def test_local_command_wire_success_and_failure(self):
        self.assertEqual(await bot.run_local_command((
            sys.executable, '-c', "print('local wire', flush=True)",
        )), 'local wire\n')
        real_spawn = asyncio.create_subprocess_exec
        processes = []

        async def spawn(*args, **kwargs):
            process = await real_spawn(*args, **kwargs)
            processes.append(process)
            return process

        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / 'child.pid'
            child = ("import os, signal, time; from pathlib import Path; "
                     "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                     f"Path({str(pid_path)!r}).write_text(str(os.getpid())); "
                     "print('ready', flush=True); time.sleep(60)")
            leader = ("import subprocess, sys; "
                      f"subprocess.Popen([sys.executable, '-c', {child!r}])")
            with (patch.object(bot.asyncio, 'create_subprocess_exec', spawn),
                  patch.object(bot, 'LOCAL_COMMAND_TIMEOUT', 0.5)):
                try:
                    with self.assertRaisesRegex(RuntimeError, '^command timeout$'):
                        await bot.run_local_command((sys.executable, '-c', leader))
                    self.assertEqual(len(processes), 1)
                    self.assertEqual(processes[0].returncode, 0)
                    try:
                        fd = os.pidfd_open(int(pid_path.read_text()))
                    except ProcessLookupError:
                        pass
                    else:
                        exited = asyncio.Event()
                        loop = asyncio.get_running_loop()
                        loop.add_reader(fd, exited.set)
                        try:
                            await asyncio.wait_for(exited.wait(), 5)
                        finally:
                            loop.remove_reader(fd)
                            os.close(fd)
                finally:
                    for process in processes:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await process.wait()


    async def test_notification_is_fixed_local_and_reports_unavailability(self):
        for subject in ('mute', 'volume'):
            argv = ('/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
                    '--hint=boolean:suppress-sound:true', f'{subject.title()} could not be confirmed',
                    'Check the audio control. Kestrel will not retry.')
            command = AsyncMock(return_value='')
            with patch.object(bot.logger, 'error') as error:
                self.assertTrue(await bot.notify_audio_failure(subject, command=command))
                command.assert_awaited_once_with(argv)
                error.assert_not_called()
            for failure in (RuntimeError('private missing executable'), RuntimeError('private external output')):
                command = AsyncMock(side_effect=failure)
                with patch.object(bot.logger, 'error') as error:
                    self.assertFalse(await bot.notify_audio_failure(subject, command=command))
                    command.assert_awaited_once_with(argv)
                    error.assert_called_once_with(f'{subject.title()} failure notification unavailable')
            command = AsyncMock(side_effect=asyncio.CancelledError)
            with patch.object(bot.logger, 'error') as error:
                with self.assertRaises(asyncio.CancelledError):
                    await bot.notify_audio_failure(subject, command=command)
                command.assert_awaited_once_with(argv)
                error.assert_not_called()


class GreetingAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def configured_analyzer(self):
        analyzer = None

        class AnalyzerSelected(Exception):
            pass

        def capture(context, *, user_params):
            nonlocal analyzer
            analyzer = user_params.vad_analyzer
            raise AnalyzerSelected()

        with patch.object(bot, 'LLMContextAggregatorPair', side_effect=capture):
            with self.assertRaises(AnalyzerSelected):
                await bot.run_conversation(None, None, llm=object(), transport=object())
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
                    await bot.run_conversation(None, None, llm=object(), transport=object())
            self.assertEqual(len(captured), 1)
            strategies = captured[0]
            self.assertEqual(len(strategies.stop), 1)
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


class SessionTests(unittest.IsolatedAsyncioTestCase):
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
        engine = patch.object(bot, 'make_llm', side_effect=lambda: Mock(
            start_preparation=Mock(), close_local_tools=AsyncMock(), close_engine=AsyncMock(),
        ))
        engine.start()
        self.addCleanup(engine.stop)

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

        service = bot.HermesLLMService()
        service.prepare_engine = AsyncMock(side_effect=prepare)
        service.close_local_tools = AsyncMock(wraps=service.close_local_tools)
        service.close_engine = AsyncMock(wraps=service.close_engine)
        stt = Mock(load=AsyncMock(side_effect=load_local), close=AsyncMock())

        async def conversation(stt, voice, *, llm, transport, handle_signals):
            received_services.append(llm)
            preparation_pending.append(llm is not None and not llm.reader.done())

        with (
            patch.object(bot, 'NemotronSTT', return_value=stt),
            patch.object(bot, 'make_llm', return_value=service),
            patch.object(bot, 'run_conversation', conversation),
            patch.object(bot.torch, 'set_num_threads'),
        ):
            task = asyncio.create_task(bot.bot())
            try:
                await asyncio.wait_for(loading.wait(), 5)
                self.assertTrue(preparing.is_set(), 'Engine preparation starts while local loading is held')
                reader = service.reader
                self.assertFalse(reader.done())
                release_local.set()
                await asyncio.wait_for(task, 5)
                self.assertEqual(received_services, [service])
                self.assertEqual(preparation_pending, [True])
                self.assertTrue(reader.done())
                service.close_local_tools.assert_awaited_once()
                service.close_engine.assert_awaited_once()
                stt.close.assert_awaited_once()
                self.audio.close.assert_awaited()
            finally:
                release_local.set()
                hold_preparation.set()
                await asyncio.wait_for(task, 5)

        for failure in ('local_model_failure', 'early_shutdown', 'conversation_failure'):
            with self.subTest(failure=failure):
                service = bot.HermesLLMService()
                service.prepare_engine = AsyncMock(side_effect=asyncio.Event().wait)
                service.close_local_tools = AsyncMock(wraps=service.close_local_tools)
                native_close = service.close_engine
                readers = []

                async def close_engine():
                    readers.append(service.reader)
                    await native_close()

                service.close_engine = AsyncMock(side_effect=close_engine)
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
                    patch.object(bot, 'make_llm', return_value=service),
                    patch.object(bot, 'run_conversation', conversation),
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    if failure == 'early_shutdown':
                        with self.assertRaises(asyncio.CancelledError):
                            await bot.bot()
                    else:
                        with self.assertRaises(RuntimeError):
                            await bot.bot()
                    service.close_local_tools.assert_awaited_once()
                    service.close_engine.assert_awaited_once()
                    self.assertTrue(readers[0].done())
                    stt.close.assert_awaited_once()
                    self.audio.close.assert_awaited()
                    if failure == 'conversation_failure':
                        self.assertIs(conversation.await_args.kwargs['llm'], service)
                    else:
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
                patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                patch.object(bot.torch, 'set_num_threads'),
            ):
                with self.assertRaises(RuntimeError) as failure:
                    await bot.bot()
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
                    self.assertEqual(self.voice.generate_streaming.call_count, 1)
                    os.environ['KESTREL_VOICE'] = 'unknown'
                    for sentence in ('First reply.', 'Second reply.'):
                        frames = [frame async for frame in voice.run_tts(sentence, 'reply')]
                        self.assertEqual(len(frames), 1)

                with (
                    patch.object(bot, 'NemotronSTT', return_value=stt),
                    patch.object(bot, 'run_conversation', side_effect=conversation),
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    await bot.bot()
                stt.load.assert_awaited_once_with(self.reference_pcm)
                calls = self.voice.generate_streaming.call_args_list
                self.assertEqual([item.kwargs['text'] for item in calls], ['Hello.', 'First reply.', 'Second reply.'])
                for item in calls:
                    self.assertEqual(item.kwargs['prompt_wav_path'], str(self.voices / (name + '.wav')))
                    self.assertEqual(item.kwargs['reference_wav_path'], str(self.voices / (name + '.wav')))
                    self.assertEqual(item.kwargs['prompt_text'], transcript)

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
            patch.object(bot.VoxCPM, "from_pretrained", side_effect=load_model) as load,
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            conversation.side_effect = lambda *args, **kwargs: events.append('conversation')
            await bot.bot()
            await bot.bot()
            self.assertEqual(load.call_count, 2)
            self.assertEqual(model.generate_streaming.call_count, 2)
            self.assertEqual(model.generate_streaming.call_args.kwargs['text'], 'Hello.')
            self.assertEqual(events, ['load', 'warm', 'closed', 'conversation', 'load', 'warm', 'closed', 'conversation'])
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

        def gated_chunks(**kwargs):
            try:
                events.append('first_chunk')
                yield np.zeros(8, dtype=np.float32)
                events.append('gated')
                loop.call_soon_threadsafe(activity.set)
                if not release.wait(5):
                    raise AssertionError('Voice preparation gate was not released')
                events.append('remaining_chunk')
                yield np.zeros(8, dtype=np.float32)
                events.append('exhausted')
            finally:
                events.append('closed')

        stt = Mock(load=AsyncMock(), close=AsyncMock())
        model = Mock(generate_streaming=Mock(side_effect=gated_chunks))
        with (
            patch.object(bot, 'NemotronSTT', return_value=stt),
            patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
            patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, 'set_num_threads'),
        ):
            conversation.side_effect = lambda *args, **kwargs: events.append('conversation')
            task = asyncio.create_task(bot.bot())
            task.add_done_callback(lambda completed: activity.set())
            try:
                await asyncio.wait_for(activity.wait(), 5)
                conversation.assert_not_awaited()
                self.assertFalse(task.done())
                self.assertEqual(events, ['first_chunk', 'gated'])
                release.set()
                await asyncio.wait_for(task, 5)
                self.assertEqual(events, [
                    'first_chunk', 'gated', 'remaining_chunk', 'exhausted', 'closed', 'conversation',
                ])
                conversation.assert_awaited_once()
            finally:
                release.set()
                await asyncio.wait_for(task, 5)

        for label in ('late_failure', 'empty'):
            with self.subTest(label=label):
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
                    patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
                    patch.object(bot, 'run_conversation', new_callable=AsyncMock) as conversation,
                    patch.object(bot.torch, 'set_num_threads'),
                ):
                    with self.assertRaisesRegex(RuntimeError, '[Pp]reparation'):
                        await bot.bot()
                    conversation.assert_not_awaited()
                    if label == 'late_failure':
                        self.assertEqual(failed_events, ['first_chunk', 'closed'])
                    stt.close.assert_awaited_once()
                    self.audio.close.assert_awaited()

    async def test_model_load_failure_closes_recognition_and_audio(self):
        stt = Mock(load=AsyncMock(side_effect=RuntimeError("load failed")), close=AsyncMock())
        with patch.object(bot, "NemotronSTT", return_value=stt):
            with self.assertRaisesRegex(RuntimeError, "load failed"):
                await bot.bot()
        stt.close.assert_awaited_once()
        self.audio.close.assert_awaited_once()

    async def test_native_startup_and_stop_release_resources_without_listening(self):
        for phase, echo_failure in (("preparation", False), ("conversation", False), ("conversation", True)):
            with self.subTest(phase=phase, echo_failure=echo_failure):
                preparing, active, loading = asyncio.Event(), asyncio.Event(), asyncio.Event()
                held = asyncio.Event()
                service = bot.HermesLLMService()
                home = tempfile.TemporaryDirectory(prefix="kestrel-native-test-")
                home_path = Path(home.name)
                service.home = home
                child = Mock(returncode=None)

                async def reap():
                    child.returncode = 0
                    return 0

                child.wait = AsyncMock(side_effect=reap)
                service.process = child
                mute_work = asyncio.create_task(held.wait())
                service.local_tasks.add(mute_work)

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
                self.audio.output.return_value = Forward(output=True)
                native_conversation = bot.run_conversation

                async def conversation(stt, voice, *, llm, transport, handle_signals):
                    self.assertIs(llm, service)
                    self.assertIs(transport, self.audio)
                    self.assertTrue(handle_signals)
                    await native_conversation(stt, voice, llm=llm, transport=transport,
                        handle_signals=handle_signals, user_params=bot.LLMUserAggregatorParams(
                            user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
                        ))

                service.prepare_engine = AsyncMock(side_effect=prepare)
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

                with (
                    patch.object(bot, "make_llm", return_value=service),
                    patch.object(bot, "NemotronSTT", return_value=stt),
                    patch.object(bot, "run_conversation", conversation),
                    patch.object(bot.ECHO_REMOVAL, "start", side_effect=start_echo) as echo_start,
                    patch.object(bot.ECHO_REMOVAL, "close") as echo_close,
                    patch.object(loop, "add_signal_handler", side_effect=register),
                    patch.object(loop, "remove_signal_handler") as remove_signal,
                    patch.object(bot.os, "kill", side_effect=signal_request),
                    patch("socket.socket.bind", side_effect=AssertionError("A native service must never listen")) as bind,
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
                        bind.assert_not_called()
                        self.audio.open.assert_awaited_once()
                        self.audio.close.assert_awaited_once()
                        stt.close.assert_awaited_once()
                        child.terminate.assert_called_once_with()
                        child.wait.assert_awaited_once()
                        self.assertIsNone(service.reader)
                        self.assertTrue(mute_work.done())
                        self.assertFalse(home_path.exists())
                        echo_close.assert_called_once_with()
                        self.assertEqual(remove_signal.call_count, 2)
                    finally:
                        held.set()
                        if not task.done():
                            task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        await service.close_local_tools()
                        await service.close_engine()

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

        transport = Mock(input=Mock(return_value=Forward()), output=Mock(return_value=Forward()))
        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        voice = speech.VoxCPMTTS(self.voice, speech.load_voice_preset('irish-female', voices_dir=self.voices))
        with patch.object(bot, "PipelineWorker", side_effect=capture_worker):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=Forward(), transport=transport, user_params=params,
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

        transport = Mock(input=Mock(return_value=Forward()), output=Mock(return_value=Forward()))
        observer = UserBotLatencyObserver(time_source=lambda: 100.25)

        def log(message):
            messages.append(message)
            if message == "0.250":
                measured.set()

        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        voice = speech.VoxCPMTTS(self.voice, speech.load_voice_preset('irish-female', voices_dir=self.voices))
        with (patch.object(bot, "UserBotLatencyObserver", return_value=observer),
              patch.object(bot.logger, "info", side_effect=log)):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=Forward(), transport=transport, user_params=params,
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


class WholeConversationTests(unittest.IsolatedAsyncioTestCase):
    async def open_session(self, brain, *, wire=None, local_command=None, prepare_engine=False):
        if brain is not None:
            require_native_hermes()
        started = asyncio.Event()
        spoken = asyncio.Queue()
        committed = asyncio.Queue()
        interrupted = asyncio.Event()
        processed = asyncio.Queue()

        class Input(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                await self.push_frame(frame, direction)

        class Output(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, StartFrame):
                    started.set()
                elif isinstance(frame, TTSTextFrame) and direction == FrameDirection.DOWNSTREAM:
                    spoken.put_nowait(frame.text)
                elif isinstance(frame, LLMContextAssistantTurnFrame) and direction == FrameDirection.UPSTREAM:
                    committed.put_nowait(frame.text.strip())
                elif isinstance(frame, InterruptionFrame):
                    interrupted.set()
                elif type(frame) is DataFrame:
                    processed.put_nowait(frame)
                await self.push_frame(frame, direction)

        transport = Mock()
        transport.input.return_value = Input()
        transport.output.return_value = Output()
        transport.processed = processed
        preset = speech.VoicePreset(Path('/fixture/british-male.wav'), 'British fixture.', bytes(9600))

        def chunks(**kwargs):
            self.assertEqual(kwargs['prompt_wav_path'], '/fixture/british-male.wav')
            self.assertEqual(kwargs['reference_wav_path'], '/fixture/british-male.wav')
            self.assertEqual(kwargs['prompt_text'], 'British fixture.')
            yield np.zeros(4800, dtype=np.float32)

        real_spawn = asyncio.create_subprocess_exec
        processes = []

        async def spawn(*command, **kwargs):
            self.assertEqual(command, (str(bot.HERMES_PYTHON), str(ROOT / 'hermes_worker.py')))
            home = Path(kwargs['env']['HERMES_HOME'])
            logger.debug(f'Owned session test home: {home}')
            if wire is not None:
                command = (sys.executable, '-c', wire)
            elif command[0] == str(NATIVE_PYTHON):
                command = WorkerProcess.command(home, brain)
            try:
                process = await real_spawn(*command, **kwargs)
            except OSError:
                processes.append((None, home))
                raise
            processes.append((process, home))
            return process

        direct = patch('pipecat.services.openai.llm.OpenAILLMService.get_chat_completions',
                       side_effect=RuntimeError('Direct brain bypass is prohibited in this native-session proof'))
        direct.start()
        self.addCleanup(direct.stop)
        spawn_patch = patch.object(bot.asyncio, 'create_subprocess_exec', spawn)
        spawn_patch.start()
        self.addCleanup(spawn_patch.stop)
        supplied_llm = bot.HermesLLMService(local_command=local_command)
        transport.llm = supplied_llm
        session = None

        async def close():
            try:
                if session is not None:
                    try:
                        if not session.done():
                            session.cancel()
                    finally:
                        try:
                            await asyncio.wait_for(session, 5)
                        except asyncio.CancelledError:
                            pass
            finally:
                try:
                    await supplied_llm.close_local_tools()
                finally:
                    await supplied_llm.close_engine()
            for process, home in processes:
                if process is not None:
                    self.assertIsNotNone(process.returncode)
                self.assertFalse(home.exists())
            spawn_patch.stop()

        self.addAsyncCleanup(close)
        if prepare_engine:
            supplied_llm.start_preparation()
        else:
            # Unrelated turn/history cases project an already-ready worker, not production startup.
            await supplied_llm.open_engine()
        user_params = bot.LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None,
        )
        session = asyncio.create_task(bot.run_conversation(
            bot.NemotronSTT(), bot.VoxCPMTTS(Mock(generate_streaming=chunks), preset),
            llm=supplied_llm, transport=transport, user_params=user_params,
        ))
        await asyncio.wait_for(started.wait(), 45)
        return transport, spoken, committed, interrupted, processes, close

    async def finish_user_turn(self, transport, text):
        await transport.input().queue_frame(
            TranscriptionFrame(text, '', '2026-01-01T00:00:00Z', finalized=True)
        )
        await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

    async def test_stop_cancel_discard_reply_without_brain_request(self):
        cases = [(word, heard, threading.Event(), threading.Event(), threading.Event())
                 for word in ('stop', 'cancel') for heard in (False, True)]
        def held_reply(heard, blocked, release, finished):
            yield {'content': 'Heard prefix. Unheard fragment' if heard else 'Unheard fragment'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Stopped provider reply was never released')
            yield {'content': ' forbidden tail.'}, None
            yield {}, 'stop'
            finished.set()
        scripts = []
        for _, heard, blocked, release, finished in cases:
            self.addCleanup(release.set)
            scripts.extend([held_reply(heard, blocked, release, finished),
                            [({'content': 'Fresh reply.'}, None), ({}, 'stop')]])
        brain = ScriptedBrain(scripts)
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('Stop/cancel cannot invoke native desktop commands'))
        transport, spoken, committed, interrupted, processes, close = await self.open_session(brain, local_command=command)
        try:
            for index, (word, heard, blocked, release, finished) in enumerate(cases):
                with self.subTest(word=word, heard=heard):
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, f'Blocked request {index}.')
                    self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
                    if heard:
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Heard prefix.')
                    else:
                        self.assertTrue(spoken.empty())
                    reader = transport.llm.reader
                    self.assertFalse(reader.done())
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await self.finish_user_turn(transport, word)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    if heard:
                        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Heard prefix.')
                    self.assertTrue(committed.empty(), 'Only an observed heard prefix can be committed')
                    self.assertTrue(spoken.empty(), 'Stopping adds no acknowledgement')
                    self.assertEqual(len(brain.requests), index * 2 + 1)
                    self.assertIs(transport.llm.reader, reader)
                    self.assertFalse(reader.done(), 'Local stop finishes while native drainage is blocked')
                    self.assertFalse(finished.is_set())
                    self.assertIsNone(processes[0][0].returncode)
                    release.set()
                    self.assertTrue(await asyncio.to_thread(finished.wait, 5))
                    await asyncio.wait_for(asyncio.shield(reader), 5)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'Released native drainage cannot speak its stopped tail')
                    self.assertTrue(committed.empty(), 'Stopped tail cannot enter assistant history')
                    self.assertEqual(len(brain.requests), index * 2 + 1)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, f'Fresh request {index}.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
                    self.assertTrue(spoken.empty())
                    self.assertEqual(len(brain.requests), index * 2 + 2)
                    messages = brain.requests[-1][2]['messages']
                    self.assertEqual(messages[-1], {'role': 'user', 'content': f'Fresh request {index}.'})
                    self.assertNotIn('Unheard fragment', json.dumps(messages))
                    self.assertNotIn('forbidden tail', json.dumps(messages))
                    self.assertFalse(any(m['role'] == 'user' and m['content'] in ('stop', 'cancel') for m in messages))
                    prefixes = [m['content'].strip() for m in messages
                                if m['role'] == 'assistant' and 'Heard prefix' in m['content']]
                    self.assertTrue(all(text == 'Heard prefix.' for text in prefixes))
                    self.assertEqual(len(prefixes), sum(item[1] for item in cases[:index + 1]))
                    command.assert_not_awaited()
            self.assertEqual(len(processes), 1, 'Stopping never restarts the native worker')
            self.assertFalse(transport.llm.local_tasks)
        finally:
            for _, _, _, release, _ in cases:
                release.set()
            await close()
        command = AsyncMock(side_effect=AssertionError('Idle stop cannot invoke desktop commands'))
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, close = await self.open_session(None, local_command=command)
            try:
                for phrase in ('stop', 'CANCEL!', 'Stop.'):
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, phrase)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'Idle stop is silent even without an engine')
                    self.assertTrue(committed.empty())
                    command.assert_not_awaited()
                self.assertEqual(len(processes), 1)
                self.assertIsNone(processes[0][0])
            finally:
                await close()

    async def test_workspace_turn_is_local_and_nonmatches_reach_brain(self):
        replies = ('Longer phrase remains conversation.', 'Invalid number remains conversation.',
                   'Command text remains conversation.')
        brain = ScriptedBrain([[({'content': text}, None), ({}, 'stop')] for text in replies])
        self.addCleanup(brain.close)
        status = ('/usr/bin/hyprctl', '-j', 'activeworkspace')
        focus_three = ('/usr/bin/hyprctl', 'dispatch', 'hl.dsp.focus({ workspace = "3" })')
        focus_eleven = ('/usr/bin/hyprctl', 'dispatch', 'hl.dsp.focus({ workspace = "11" })')
        command = AsyncMock(side_effect=['{"id":-99}', 'ok', '{"id":3}', '{"id":3}', 'PRIVATE unhandled'])
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        advisory = "I couldn't confirm workspace 11. Check the desktop. I won't retry."
        try:
            for phrase, expected in (('workspace three', None), ('workspace 11', advisory)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, phrase)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                if expected:
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                self.assertEqual(brain.requests, [])
                self.assertFalse(transport.llm.local_tasks)
            self.assertEqual(command.await_args_list, [call(status), call(focus_three), call(status),
                                                       call(status), call(focus_eleven)])
            ordinary = ('workspace three please', 'workspace 2147483648', 'workspace 3; exec bad')
            for index, (text, reply) in enumerate(zip(ordinary, replies)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                if index == 0:
                    await transport.input().queue_frame(
                        TranscriptionFrame('workspace three', '', '2026-01-01T00:00:00Z', finalized=True))
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertEqual(command.await_count, 5, 'A segment cannot dispatch before the completed turn')
                    self.assertEqual(brain.requests, [])
                    await self.finish_user_turn(transport, 'please')
                else:
                    await self.finish_user_turn(transport, text)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), reply)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), reply)
                self.assertEqual(len(brain.requests), index + 1)
                users = [m for m in brain.requests[index][2]['messages'] if m['role'] == 'user']
                self.assertEqual(users, [{'role': 'user', 'content': t} for t in ordinary[:index + 1]])
                self.assertNotIn(advisory, json.dumps(brain.requests[index][2]))
                self.assertNotIn('PRIVATE', json.dumps(brain.requests[index][2]))
                self.assertEqual(command.await_count, 5, 'Nonmatching phrases cannot cause a local effect')
        finally:
            await close()
        command = AsyncMock(side_effect=['{"id":-99}', 'ok\n', '{"id":11}'])
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, close = await self.open_session(None, local_command=command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'workspace eleven!')
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(spoken.empty(), 'Confirmed local focus stays silent without an engine')
                self.assertTrue(committed.empty())
                self.assertEqual(command.await_args_list, [call(status), call(focus_eleven), call(status)])
                self.assertEqual(len(processes), 1)
                self.assertIsNone(processes[0][0])
                self.assertFalse(transport.llm.local_tasks)
            finally:
                await close()

    async def test_media_turns_are_local_and_owned(self):
        no_player = "I couldn't find a playing media player."
        failed_next = "I couldn't confirm next track. Check the media player. I won't retry."
        status = ('/usr/bin/omarchy-shell', 'media', 'status')
        pause = ('/usr/bin/omarchy-shell', 'media', 'pause')
        advance = ('/usr/bin/omarchy-shell', 'media', 'next')
        media = LocalDesktopTests.media
        brain = ScriptedBrain([[({'content': 'Ordinary follow-up.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[
            media(hasPlayer=False, playing=False), media(playing=False),
            media(), 'ok', media(playing=False),
            media(), 'ok', media(title='Second track'),
            media(), 'PRIVATE unhandled output',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(brain, local_command=command)
        try:
            for phrase, expected in (('pause music', no_player), ('next track', no_player),
                                     ('pause music!', None), ('NEXT TRACK.', None), ('next track', failed_next)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, phrase)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                if expected:
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty(), 'Local media speech must not be committed')
                self.assertEqual(brain.requests, [], 'Exact media turns never reach the brain')
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'next track please')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary follow-up.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary follow-up.')
            messages = [m for m in brain.requests[0][2]['messages'] if m['role'] != 'system']
            self.assertEqual(messages, [{'role': 'user', 'content': 'next track please'}])
            self.assertEqual(command.await_args_list, [call(status), call(status),
                call(status), call(pause), call(status), call(status), call(advance), call(status),
                call(status), call(advance)])
            self.assertFalse(transport.llm.local_tasks)
            self.assertEqual(len(processes), 1)
        finally:
            await close()

        # Keep attempted work owned through interruption; a queued action must share its lock.
        writes_started, release, queued = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls, actions = [], {}
        replies = iter([media(), 'ok', media(), media(), media(), media(playing=False)])
        async def blocked(argv):
            calls.append(argv)
            if argv == pause:
                writes_started.set()
                await release.wait()
            return next(replies)
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, interrupted, processes, close = await self.open_session(None, local_command=blocked)
            native_run = transport.llm.run_local_tool
            async def observe(tool):
                actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'next track':
                    queued.set()
                return await native_run(tool)
            with patch.object(transport.llm, 'run_local_tool', observe):
                try:
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'pause music')
                    await asyncio.wait_for(writes_started.wait(), 5)
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    self.assertFalse(actions['pause'].done())
                    await self.finish_user_turn(transport, 'next track')
                    await asyncio.wait_for(queued.wait(), 5)
                    self.assertEqual(calls, [status, pause], 'The queued media read shares the mutation lock')
                    self.assertFalse(actions['next track'].done())
                    release.set()
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), no_player)
                    await asyncio.wait_for(asyncio.gather(*actions.values()), 5)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'Detached pause failure cannot queue stale speech')
                    self.assertTrue(committed.empty())
                    self.assertEqual(calls, [status, pause, status, status, status, status])
                    self.assertFalse(transport.llm.local_tasks)
                    self.assertEqual(len(processes), 1)
                    self.assertIsNone(processes[0][0])
                finally:
                    release.set()
                    await close()

            writes_started, cancelled, release_cleanup, cleaned = (
                asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event())
            calls, actions = [], {}
            queued = asyncio.Event()
            async def hanging(argv):
                calls.append(argv)
                if argv == status:
                    return media()
                self.assertEqual(argv, pause)
                writes_started.set()
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    cancelled.set()
                    await release_cleanup.wait()
                    cleaned.set()
                    raise
            transport, _, _, interrupted, _, close = await self.open_session(None, local_command=hanging)
            native_run = transport.llm.run_local_tool
            closing = None
            with patch.object(transport.llm, 'run_local_tool', observe):
                try:
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'pause music')
                    await asyncio.wait_for(writes_started.wait(), 5)
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await self.finish_user_turn(transport, 'next track')
                    await asyncio.wait_for(queued.wait(), 5)
                    closing = asyncio.create_task(close())
                    await asyncio.wait_for(cancelled.wait(), 5)
                    self.assertFalse(closing.done(), 'Shutdown joins native command cleanup')
                    release_cleanup.set()
                    await asyncio.wait_for(closing, 5)
                    self.assertTrue(cleaned.is_set())
                    self.assertTrue(all(task.done() and task.cancelled() for task in actions.values()))
                    self.assertFalse(transport.llm.local_tasks)
                    self.assertEqual(calls, [status, pause], 'Shutdown starts no queued effect or readback')
                finally:
                    release_cleanup.set()
                    if closing is not None:
                        await asyncio.gather(closing, return_exceptions=True)
                    await close()

    async def test_volume_bypasses_pending_brain_and_history(self):
        held = threading.Event()
        release = threading.Event()

        def preparation_reply():
            yield {'content': 'Preparation nonce 731.'}, None
            held.set()
            if not release.wait(45):
                raise AssertionError('Preparation reply was not released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            preparation_reply(), [({'content': 'Actual caller reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=[
            'selected', 'physical', LocalVolumeTests.volume(32768), 'Mute: yes', '',
            LocalVolumeTests.volume(19660), '', 'selected', 'physical', LocalVolumeTests.volume(19660), 'Mute: no',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, local_command=command, prepare_engine=True,
        )
        preparation = transport.llm.reader
        try:
            self.assertTrue(await asyncio.to_thread(held.wait, 5))
            self.assertFalse(preparation.done())
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Hello.'},
            ])
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'volume thirty percent')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(command.await_count, 11)
            self.assertFalse(preparation.done())
            self.assertFalse(release.is_set())
            self.assertEqual(len(brain.requests), 1)
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())

            checkpoint = asyncio.Event()
            driver = asyncio.current_task()
            native_shield = asyncio.shield
            worker_input = processes[0][0].stdin
            native_write = worker_input.write
            ordinary_writes = 0
            pending_writes = 0

            def observe_shield(task):
                future = native_shield(task)
                if task is preparation and asyncio.current_task() is not driver:
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
                self.assertIn(
                    'Kestrel handles volume <level> percent locally, from zero to one hundred percent.',
                    ' '.join(m['content'] for m in brain.requests[1][2]['messages'] if m['role'] == 'system'),
                )
                self.assertEqual([m for m in brain.requests[1][2]['messages'] if m['role'] != 'system'], [
                    {'role': 'user', 'content': 'Answer the genuine user turn.'},
                ])
                self.assertEqual(ordinary_writes, 1)
                self.assertEqual(pending_writes, 0)
        finally:
            release.set()
            await close()
        self.assertTrue(preparation.done())
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())

    async def test_native_preparation_is_silent_private_and_does_not_block_mute(self):
        held = threading.Event()
        release = threading.Event()

        def preparation_reply():
            yield {'content': 'Preparation nonce 731.'}, None
            held.set()
            if not release.wait(45):
                raise AssertionError('Preparation reply was not released')
            yield {}, 'stop'

        brain = ScriptedBrain([
            preparation_reply(), [({'content': 'Actual caller reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, local_command=command, prepare_engine=True,
        )
        preparation = transport.llm.reader
        try:
            self.assertTrue(await asyncio.to_thread(held.wait, 5))
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
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())

            checkpoint = asyncio.Event()
            driver = asyncio.current_task()
            native_shield = asyncio.shield
            worker_input = processes[0][0].stdin
            native_write = worker_input.write
            ordinary_writes = 0
            pending_writes = 0

            def observe_shield(task):
                future = native_shield(task)
                if task is preparation and asyncio.current_task() is not driver:
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
                self.assertEqual(ordinary_writes, 1)
                self.assertEqual(pending_writes, 0)
        finally:
            release.set()
            await close()
        self.assertTrue(preparation.done())
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())

    async def test_failed_native_preparation_preserves_local_mute_and_reports_on_user_turn(self):
        brain = ScriptedBrain([400])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, local_command=command, prepare_engine=True,
        )
        preparation = transport.llm.reader
        try:
            await asyncio.wait_for(asyncio.shield(preparation), 5)
            self.assertTrue(transport.llm.failure)
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'mute')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(command.await_count, 7)
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            await self.assert_failed_reply(
                transport, spoken, committed, 'Answer after failed preparation.',
                expected_advisory="I couldn't get a complete reply from the brain on the Ally. Restart Kestrel and try again.",
            )
            self.assertEqual(len(brain.requests), 1)
        finally:
            await close()
        self.assertTrue(preparation.done())
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())

    async def test_preparation_timeout_and_shutdown_reap_owned_worker(self):
        wire = (
            'import sys; print(\'{"ready":true}\', flush=True); '
            'sys.stdin.readline(); sys.stdin.read()'
        )
        for outcome in ('timeout', 'shutdown'):
            with self.subTest(outcome=outcome):
                pending = asyncio.Event()
                reads = 0
                native_read = bot.HermesLLMService.read_event

                async def read_event(service):
                    nonlocal reads
                    reads += 1
                    if reads == 2:
                        pending.set()
                    return await native_read(service)

                with (
                    patch.object(bot, 'ENGINE_TIMEOUT', 1),
                    patch.object(bot.HermesLLMService, 'read_event', read_event),
                ):
                    transport, spoken, committed, _, processes, close = await self.open_session(
                        None, wire=wire, prepare_engine=True,
                    )
                    preparation = transport.llm.reader
                    try:
                        await asyncio.wait_for(pending.wait(), 5)
                        self.assertFalse(preparation.done())
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        if outcome == 'timeout':
                            await asyncio.wait_for(asyncio.shield(preparation), 5)
                            self.assertTrue(transport.llm.failure)
                            self.assertIsNotNone(processes[0][0].returncode)
                    finally:
                        await close()
                    self.assertTrue(preparation.done())
                    self.assertIsNotNone(processes[0][0].returncode)
                    self.assertFalse(processes[0][1].exists())
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())

    async def test_repeat_preserves_spoken_reply_without_brain_or_history(self):
        brain = ScriptedBrain([
            [({'content': r'Literal \`tick\` stays with ●, ◐ and ○.'}, None), ({}, 'stop')],
            [({'content': 'Newer normal reply.'}, None), ({}, 'stop')],
            [({'content': 'Fresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: no', '',
        ])
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'repeat that')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertTrue(committed.empty())
        self.assertEqual(len(brain.requests), 0)

        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Give the literal reply.')
        await asyncio.wait_for(committed.get(), 5)  # Turn summaries strip markers; only a completion barrier.
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Literal `tick` stays with ●, ◐ and ○.')
        for text in ('repeat that', ' REPEAT THAT. ', 'Repeat that!', ' Repeat That? '):
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, text)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Literal `tick` stays with ●, ◐ and ○.')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)

        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'mute')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                         "I couldn't confirm mute. Check the audio control. I won't retry.")
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(command.await_count, 8)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'repeat that')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5),
                         "I couldn't confirm mute. Check the audio control. I won't retry.")
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(command.await_count, 8)
        self.assertEqual(len(brain.requests), 1)
        self.assertTrue(committed.empty())

        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await transport.input().queue_frame(TranscriptionFrame('repeat that', '', '2026-01-01T00:00:00Z', finalized=True))
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertTrue(spoken.empty())
        self.assertEqual(len(brain.requests), 1)
        await self.finish_user_turn(transport, 'with more detail.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Newer normal reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Newer normal reply.')
        self.assertEqual([[m for m in request[2]['messages'] if m['role'] != 'system']
                          for request in brain.requests], [
            [{'role': 'user', 'content': 'Give the literal reply.'}],
            [{'role': 'user', 'content': 'Give the literal reply.'},
             {'role': 'assistant', 'content': 'Literal `tick` stays with ●, ◐ and ○.'},
             {'role': 'user', 'content': 'repeat that with more detail.'}],
        ])
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'repeat that')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Newer normal reply.')
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertTrue(committed.empty())
        self.assertEqual(len(brain.requests), 2)
        old_service = transport.llm
        self.assertEqual(old_service.last_spoken_reply, 'Newer normal reply.')
        await close()
        self.assertIsNone(old_service.last_spoken_reply)

        transport, spoken, committed, _, _, _ = await self.open_session(brain)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'repeat that')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(len(brain.requests), 2)
        self.assertTrue(committed.empty())
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'A fresh question.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'A fresh question.'}])

    async def test_exact_mute_is_silent_makes_no_brain_request_and_stays_out_of_history(self):
        brain = ScriptedBrain([[({'content': 'Ordinary reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        completed = asyncio.Event()
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
        calls = []

        async def command(argv):
            calls.append(argv)
            result = next(replies)
            if len(calls) == 7:
                completed.set()
            return result

        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, ' MUTE! ')
        await asyncio.wait_for(completed.wait(), 5)
        # TTS serializes this barrier after earlier speech, before a new turn can interrupt it.
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertTrue(spoken.empty(), 'Confirmed mute must be silent before the next user turn')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'An ordinary conversation turn.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary reply.')
        self.assertTrue(spoken.empty(), 'Confirmed mute emits no acknowledgement')
        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
        self.assertEqual(len(brain.requests), 1)
        request = brain.requests[0][2]
        self.assertEqual([m for m in request['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'An ordinary conversation turn.'},
        ])
        self.assertFalse(request.get('tools'))
        self.assertIn(
            'Kestrel handles the exact spoken command mute locally. You cannot invoke that action; '
            'for a request to mute, explain that the owner must say mute on its own.',
            ' '.join(m['content'] for m in request['messages'] if m['role'] == 'system'),
        )

    async def test_volume_failure_interruption_and_shutdown(self):
        notification = (
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true', 'Volume could not be confirmed',
            'Check the audio control. Kestrel will not retry.',
        )
        failure = "I couldn't confirm volume. Check the audio control. I won't retry."
        failed_readback = ['selected', 'physical', LocalVolumeTests.volume(32768), 'Mute: yes', '',
                           LocalVolumeTests.volume(32768)]
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            readback_entered, release_readback = asyncio.Event(), asyncio.Event()
            entered = {'volume': asyncio.Event(), 'mute': asyncio.Event()}
            completed_events = {'volume': asyncio.Event(), 'mute': asyncio.Event()}
            action_tasks, results, completion_order, commands, effects = {}, {}, [], [], []
            level, muted = 32768, True

            async def ordered_command(argv):
                nonlocal level, muted
                owner = asyncio.current_task()
                commands.append((owner, argv))
                if argv == ('/usr/bin/pactl', 'get-default-sink'):
                    return 'selected'
                if argv == ('/usr/bin/omarchy-audio-output-sink', 'selected'):
                    return 'physical'
                if argv == ('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical'):
                    if level == 19660 and not readback_entered.is_set():
                        readback_entered.set()
                        await release_readback.wait()
                    return LocalVolumeTests.volume(level)
                if argv == ('/usr/bin/pactl', 'get-sink-mute', 'physical'):
                    return 'Mute: yes' if muted else 'Mute: no'
                if argv == ('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'):
                    effects.append((owner, argv))
                    level = 19660
                    return ''
                if argv[:3] == ('/usr/bin/pactl', 'set-sink-mute', 'physical'):
                    effects.append((owner, argv))
                    self.assertIn(argv[3], ('0', '1'))
                    muted = argv[3] == '1'
                    return ''
                raise AssertionError(f'Unexpected command: {argv}')

            transport, spoken, committed, interrupted, _, close = await self.open_session(
                None, local_command=ordered_command,
            )
            native_run = transport.llm.run_local_tool

            async def observe_action(tool):
                action_tasks[tool.subject] = asyncio.current_task()
                entered[tool.subject].set()
                result = await native_run(tool)
                results[tool.subject] = result
                completion_order.append(tool.subject)
                completed_events[tool.subject].set()
                return result

            try:
                with patch.object(transport.llm, 'run_local_tool', observe_action):
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'volume thirty percent')
                    await asyncio.wait_for(readback_entered.wait(), 5)
                    self.assertTrue(entered['volume'].is_set())
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    await self.finish_user_turn(transport, 'mute')
                    await asyncio.wait_for(entered['mute'].wait(), 5)
                    self.assertEqual([argv for owner, argv in commands if owner is action_tasks['mute']], [],
                                     'A later mute must wait for the retained volume action before native work')
                    self.assertNotIn('mute', results, 'A later mute cannot confirm before the older action finishes')
                    release_readback.set()
                    await asyncio.wait_for(completed_events['volume'].wait(), 5)
                    await asyncio.wait_for(completed_events['mute'].wait(), 5)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(results['volume'].confirmed)
                    self.assertTrue(results['mute'].confirmed)
                    self.assertEqual(completion_order, ['volume', 'mute'])
                    self.assertEqual(effects, [
                        (action_tasks['volume'], ('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')),
                        (action_tasks['volume'], ('/usr/bin/pactl', 'set-sink-mute', 'physical', '0')),
                        (action_tasks['mute'], ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')),
                    ])
                    self.assertEqual(level, 19660)
                    self.assertTrue(muted, 'The later completed mute remains effective')
                    self.assertTrue(all(task.done() for task in action_tasks.values()))
                    self.assertFalse(transport.llm.local_tasks)
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
            finally:
                release_readback.set()
                await close()

            command = AsyncMock(side_effect=failed_readback + [''])
            transport, spoken, committed, _, _, close = await self.open_session(None, local_command=command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'volume thirty percent')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), failure)
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'repeat that')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), failure)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty(), 'Local failure speech does not enter brain history')
                self.assertEqual(command.await_count, 7, 'Repeat cannot redo a local effect')
                self.assertEqual(command.await_args_list[-1], call(notification))
                self.assertEqual(command.await_args_list.count(
                    call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')),
                ), 1)
                self.assertFalse(any(c.args[0][1] == 'set-sink-mute' for c in command.await_args_list))
            finally:
                await close()

            writes_started, release_write, cancelled, notified = (
                asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event(),
            )
            calls, action_tasks = [], []
            replies = iter(failed_readback)

            async def interrupted_command(argv):
                calls.append(argv)
                if argv[0] == '/usr/bin/notify-send':
                    notified.set()
                    return ''
                if argv[1] == 'set-sink-volume':
                    action_tasks.append(asyncio.current_task())
                    writes_started.set()
                    try:
                        await release_write.wait()
                    except asyncio.CancelledError:
                        cancelled.set()
                        raise
                return next(replies)

            transport, spoken, committed, interrupted, _, close = await self.open_session(
                None, local_command=interrupted_command,
            )
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'volume thirty percent')
                await asyncio.wait_for(writes_started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertFalse(cancelled.is_set(), 'Speech interruption retains attempted effects')
                release_write.set()
                await asyncio.wait_for(notified.wait(), 5)
                await asyncio.wait_for(asyncio.shield(action_tasks[0]), 5)
                await self.finish_user_turn(transport, 'repeat that')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(spoken.empty(), 'An interrupted local action cannot queue stale failure speech')
                self.assertTrue(committed.empty())
                self.assertEqual(calls[-1], notification)
                self.assertEqual(len(calls), 7)
                self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')), 1)
                self.assertFalse(transport.llm.local_tasks)
            finally:
                release_write.set()
                await close()

            writes_started, cancelled, release_cleanup, cleaned = (
                asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event(),
            )
            calls, action_tasks = [], []
            replies = iter(failed_readback[:4])

            async def hanging_command(argv):
                calls.append(argv)
                if argv[1] == 'set-sink-volume':
                    action_tasks.append(asyncio.current_task())
                    writes_started.set()
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        cancelled.set()
                        await release_cleanup.wait()
                        cleaned.set()
                        raise
                return next(replies)

            transport, _, _, interrupted, _, close = await self.open_session(None, local_command=hanging_command)
            native_run = transport.llm.run_local_tool
            queued_entered = asyncio.Event()
            owned_actions = {}

            async def observe_shutdown_action(tool):
                owned_actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'mute':
                    queued_entered.set()
                return await native_run(tool)

            action_observer = patch.object(transport.llm, 'run_local_tool', observe_shutdown_action)
            action_observer.start()
            closing = None
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'volume thirty percent')
                await asyncio.wait_for(writes_started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(queued_entered.wait(), 5)
                self.assertEqual(set(owned_actions), {'volume', 'mute'})
                self.assertFalse(owned_actions['mute'].done(), 'Queued mute remains owned until shutdown')
                closing = asyncio.create_task(close())
                await asyncio.wait_for(cancelled.wait(), 5)
                self.assertFalse(closing.done(), 'Shutdown joins command cleanup')
                release_cleanup.set()
                await asyncio.wait_for(closing, 5)
                self.assertTrue(cleaned.is_set())
                self.assertIs(action_tasks[0], owned_actions['volume'])
                self.assertTrue(all(task.done() and task.cancelled() for task in owned_actions.values()))
                self.assertFalse(transport.llm.local_tasks)
                self.assertEqual(calls, [
                    ('/usr/bin/pactl', 'get-default-sink'),
                    ('/usr/bin/omarchy-audio-output-sink', 'selected'),
                    ('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical'),
                    ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
                    ('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'),
                ], 'Shutdown starts no later command')
            finally:
                release_cleanup.set()
                if closing is not None:
                    await asyncio.gather(closing, return_exceptions=True)
                await close()
                action_observer.stop()

    async def test_invalid_volume_turns_reach_brain_unchanged(self):
        brain = ScriptedBrain([
            [({'content': 'Invalid level is conversation.'}, None), ({}, 'stop')],
            [({'content': 'Longer phrase is conversation.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('An invalid or longer turn cannot act'))
        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        for index, segment, tail, expected, reply in (
            (0, 'volume 101 percent', None, 'volume 101 percent', 'Invalid level is conversation.'),
            (1, 'volume thirty percent', 'and tell me a fact.',
             'volume thirty percent and tell me a fact.', 'Longer phrase is conversation.'),
        ):
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await transport.input().queue_frame(
                TranscriptionFrame(segment, '', '2026-01-01T00:00:00Z', finalized=True),
            )
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            command.assert_not_awaited()
            self.assertEqual(len(brain.requests), index, 'A finalized segment is not a completed turn')
            if tail is None:
                await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())
            else:
                await self.finish_user_turn(transport, tail)
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), reply)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), reply)
            command.assert_not_awaited()
            self.assertEqual(len(brain.requests), index + 1)
            users = [m for m in brain.requests[index][2]['messages'] if m['role'] == 'user']
            self.assertEqual(users[-1], {'role': 'user', 'content': expected})

    async def test_volume_without_engine(self):
        command = AsyncMock(side_effect=[
            'selected', 'physical', LocalVolumeTests.volume(32768), 'Mute: yes', '',
            LocalVolumeTests.volume(19660), '', 'selected', 'physical', LocalVolumeTests.volume(19660), 'Mute: no',
        ])
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, _, _, processes, _ = await self.open_session(None, local_command=command)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'volume thirty percent.')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(spoken.empty(), 'A handled volume action must not speak an engine error')
            self.assertEqual(command.await_count, 11)
            self.assertEqual(command.await_args_list.count(
                call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')),
            ), 1)
            self.assertEqual(len(processes), 1)
            self.assertIsNone(processes[0][0])

    async def test_exact_mute_works_when_the_local_engine_is_missing(self):
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, _, _, processes, _ = await self.open_session(None, local_command=command)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'mute.')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(spoken.empty(), 'A handled mute must not speak an engine error')
            self.assertEqual(command.await_count, 7)
            self.assertEqual(command.await_args_list.count(
                call(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')),
            ), 1)
            self.assertEqual(len(processes), 1)
            self.assertIsNone(processes[0][0])

    async def test_longer_mute_turn_waits_for_completion_and_reaches_brain_unchanged(self):
        brain = ScriptedBrain([[({'content': 'Ordinary longer reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('A longer turn cannot invoke a local command'))
        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await transport.input().queue_frame(
            TranscriptionFrame('mute', '', '2026-01-01T00:00:00Z', finalized=True),
        )
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        command.assert_not_awaited()
        self.assertEqual(brain.requests, [], 'A finalized segment is not a completed user turn')
        await self.finish_user_turn(transport, 'this phrase is ordinary conversation.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary longer reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary longer reply.')
        command.assert_not_awaited()
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'mute this phrase is ordinary conversation.'},
        ])

    async def test_mute_does_not_wait_for_interrupted_brain_work(self):
        blocked = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def reply():
            yield {'content': 'One fact. Obsolete continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted interrupted reply was never released')
            yield {'content': ' must not be spoken.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([reply()])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        command = AsyncMock(side_effect=[
            'selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes',
        ])
        transport, spoken, committed, interrupted, _, _ = await self.open_session(brain, local_command=command)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'Tell me something.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'One fact.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        interrupted.clear()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'One fact.')
        await self.finish_user_turn(transport, 'mute')
        barrier = DataFrame()
        await transport.input().queue_frame(barrier)
        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual(command.await_count, 7, 'Local mute completes before the blocked provider is released')
        self.assertFalse(release.is_set())
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        await asyncio.wait_for(asyncio.shield(transport.llm.reader), 5)
        self.assertTrue(spoken.empty(), 'Neither mute acknowledgement nor obsolete tail may be spoken')
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'Tell me something.'},
        ])

    async def test_unconfirmed_mute_speaks_and_notifies_without_retry(self):
        notification = (
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true', 'Mute could not be confirmed',
            'Check the audio control. Kestrel will not retry.',
        )
        failure = "I couldn't confirm mute. Check the audio control. I won't retry."
        for reason in ('readback', 'timeout', 'notification unavailable'):
            with self.subTest(reason=reason):
                calls = []
                replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: no'])

                async def command(argv):
                    calls.append(argv)
                    if argv[0] == '/usr/bin/notify-send':
                        if reason == 'notification unavailable':
                            raise RuntimeError('notification unavailable')
                        return ''
                    if reason == 'timeout' and argv[1] == 'set-sink-mute':
                        await asyncio.Event().wait()
                    return next(replies)

                with (patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')),
                      patch.object(bot, 'MUTE_TIMEOUT', 0.01 if reason == 'timeout' else 5)):
                    transport, spoken, committed, _, processes, close = await self.open_session(
                        None, local_command=command,
                    )
                    try:
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'mute')
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual([argv for argv in calls if argv[0] == '/usr/bin/notify-send'],
                                         [notification])
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), failure)
                        self.assertTrue(spoken.empty())
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'An ordinary unavailable-engine turn.')
                        context = await asyncio.wait_for(committed.get(), 5)
                        self.assertIn("couldn't reach Kestrel's engine", context)
                        self.assertNotIn(failure, context, 'Local failure speech is never committed to history')
                        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                        self.assertEqual(len(processes), 1)
                        self.assertIsNone(processes[0][0])
                    finally:
                        await close()

    async def test_interruption_finishes_attempted_mute_without_replay_and_shutdown_reaps_it(self):
        writes_started = asyncio.Event()
        release_write = asyncio.Event()
        cancelled = asyncio.Event()
        notified = asyncio.Event()
        calls = []
        action_tasks = []
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: no'])

        async def command(argv):
            calls.append(argv)
            if argv[0] == '/usr/bin/notify-send':
                notified.set()
                return ''
            if argv[1] == 'set-sink-mute':
                action_tasks.append(asyncio.current_task())
                writes_started.set()
                try:
                    await release_write.wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            return next(replies)

        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, interrupted, _, close = await self.open_session(None, local_command=command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(writes_started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertFalse(cancelled.is_set(), 'Speech interruption must not cancel an attempted local action')
                release_write.set()
                await asyncio.wait_for(notified.wait(), 5)
                await asyncio.wait_for(asyncio.shield(action_tasks[0]), 5)
                await self.finish_user_turn(transport, 'repeat that')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(spoken.empty(), 'An unheard mute notice cannot replace the last reply')
                self.assertTrue(committed.empty())
                self.assertEqual(len(calls), 8, 'Repeat cannot redo the interrupted mute command')
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'An ordinary follow-up after interruption.')
                context = await asyncio.wait_for(committed.get(), 5)
                self.assertIn("couldn't reach Kestrel's engine", context)
                heard = []
                while not spoken.empty():
                    heard.append(spoken.get_nowait())
                self.assertNotIn("couldn't confirm mute", ' '.join(heard), 'Detached actions cannot queue stale speech')
                self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
                self.assertEqual(sum(argv[0] == '/usr/bin/notify-send' for argv in calls), 1)
                self.assertFalse(transport.llm.local_tasks)
            finally:
                release_write.set()
                await close()

            writes_started = asyncio.Event()
            cancelled = asyncio.Event()
            release_cleanup = asyncio.Event()
            cleaned = asyncio.Event()
            calls = []
            action_tasks = []
            replies = iter(['selected', 'physical', 'Mute: no'])

            async def hanging_command(argv):
                calls.append(argv)
                if argv[1] == 'set-sink-mute':
                    action_tasks.append(asyncio.current_task())
                    writes_started.set()
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        cancelled.set()
                        await release_cleanup.wait()
                        cleaned.set()
                        raise
                return next(replies)

            transport, _, _, _, _, close = await self.open_session(None, local_command=hanging_command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(writes_started.wait(), 5)
                closing = asyncio.create_task(close())
                await asyncio.wait_for(cancelled.wait(), 5)
                self.assertFalse(closing.done(), 'Shutdown must join command cleanup before finishing')
                release_cleanup.set()
                await asyncio.wait_for(closing, 5)
                self.assertTrue(cleaned.is_set())
                self.assertTrue(action_tasks[0].cancelled())
                self.assertFalse(transport.llm.local_tasks)
                self.assertEqual(calls, [
                    ('/usr/bin/pactl', 'get-default-sink'),
                    ('/usr/bin/omarchy-audio-output-sink', 'selected'),
                    ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
                    ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'),
                ], 'Shutdown launches no readback, retry, notification or unmute')
            finally:
                release_cleanup.set()
                await close()

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

    async def assert_failed_reply(self, transport, spoken, committed, text, *, expected_advisory):
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, text)
        context = await asyncio.wait_for(committed.get(), 5)
        self.assertIn(expected_advisory, context)
        heard = []
        while not spoken.empty():
            heard.append(spoken.get_nowait())
        self.assertIn(expected_advisory, ' '.join(heard))
        return context

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
        await self.assert_failed_reply(transport, spoken, committed, 'Answer this synthetic request.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Restart Kestrel and try again.")
        self.assertIsNotNone(processes[0][0].returncode)
        await self.assert_failed_reply(transport, spoken, committed, 'Try another request.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Restart Kestrel and try again.")
        self.assertEqual(len(brain.requests), 1, 'Broken sessions never silently restart or retry')

    async def test_partial_native_reply_speaks_failure(self):
        brain = ScriptedBrain([[({'content': 'Incomplete synthetic reply.'}, None), ({}, 'length')]] * 4)
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        context = await self.assert_failed_reply(transport, spoken, committed, 'Answer completely.',
                                         expected_advisory="I couldn't get a complete reply from the brain on the Ally. Restart Kestrel and try again.")
        self.assertIn('Incomplete synthetic reply.', context)
        self.assertIsNotNone(processes[0][0].returncode)

    async def test_corrupt_worker_response_speaks_failure(self):
        # External process stand-ins cover malformed JSON and wrongly typed terminal events.
        cases = [
            ('malformed JSON', '{"ready":true}', 'not json'),
            ('wrong done type', '{"ready":true}', '{"text":"Synthetic prefix."}\n{"done":1}'),
            ('wrong ready type', '{"ready":1}', ''),
        ]
        for name, ready, response in cases:
            with self.subTest(name=name):
                wire = (f'import sys; print({ready!r}, flush=True); sys.stdin.readline(); '
                        f'print({response!r}, flush=True); sys.stdin.read()')
                transport, spoken, committed, _, processes, close = await self.open_session(None, wire=wire)
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
            yield {'content': 'One fact. Unheard continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted partial reply was never released')
            yield {}, 'length'
            finished.set()

        brain = ScriptedBrain([partial_reply()] + [[({'content': 'Unheard tail.'}, None), ({}, 'length')]] * 3)
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
                self.open_session(None, wire='import sys; sys.stdin.read()'), 5,
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
        for interrupt in (False, True):
            with self.subTest(interrupted=interrupt), patch.object(bot, 'ENGINE_TIMEOUT', 1, create=True):
                wire = ("import sys; print('{\"ready\":true}', flush=True); sys.stdin.readline(); "
                        + ("print('{\"text\":\"One fact. Unheard continuation\"}', flush=True); " if interrupt else '')
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
                        transport, spoken, committed, 'Answer while the engine is hung.',
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
            yield {'content': 'One fact. Obsolete continuation `Hidden. More.'}, None
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
            *[[({'content': raw}, None), ({}, 'stop')] for _, raw, _ in completed],
            held_reply(), [({'content': 'Fresh reply.'}, None), ({}, 'stop')],
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
        response = '{"text":"```python\\nHidden. More."}\n{"done":1}'
        wire = ('import sys; print(\'{"ready":true}\', flush=True); sys.stdin.readline(); '
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
            [({'content': 'Rain forms when water vapour cools.'}, None), ({}, 'stop')],
            [({'content': 'Blue.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        native_tts = bot.VoxCPMTTS
        worker_requests = []

        def create_tts(voice, preset):
            tts = native_tts(voice, preset)
            native_run_tts = tts.run_tts
            first_stream = True

            async def gated_tts(text, context_id):
                nonlocal first_stream
                hold = first_stream
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
                native_exchange = transport.llm.exchange

                async def capture_exchange(messages, output):
                    worker_requests.append(deepcopy(messages))
                    return await native_exchange(messages, output)

                with patch.object(transport.llm, 'exchange', capture_exchange):
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
                        {'role': 'user', 'content': [
                            {'type': 'text', 'text': 'Explain how rain forms in five sentences.'},
                        ]},
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
            yield {'content': 'One fact. Obsolete continuation'}, None
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Scripted reply was never released')
            yield {'content': ' must not be spoken.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([
            [({'content': 'Hello.'}, None), ({}, 'stop')], second_reply(),
            [({'content': 'Next step.'}, None), ({}, 'stop')],
            [({'content': 'Fresh session.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        self.addCleanup(release.set)
        transport, spoken, committed, interrupted, processes, close = await self.open_session(brain)
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
        transport, spoken, committed, _, _, _ = await self.open_session(brain)
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'A new conversation.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh session.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh session.')
        self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'A new conversation.'}])


if __name__ == '__main__':
    unittest.main()
