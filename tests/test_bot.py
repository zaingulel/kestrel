import asyncio
from copy import deepcopy
import io
import hashlib
import json
import struct
import wave
from functools import partial
import os
import signal
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import numpy as np
from loguru import logger
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, DataFrame, InputAudioRawFrame, LLMFullResponseEndFrame, LLMTextFrame, InterruptionFrame, LLMContextAssistantTurnFrame, LLMContextFrame, ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame, StartFrame, TranscriptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame, TTSTextFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams
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


def hermes_service(*, local_command=None):
    session_ready = asyncio.get_running_loop().create_future()
    session_ready.set_result(True)
    return bot.HermesLLMService(
        bot.HermesRequestChannel(), local_actions=bot.LocalActions(command=local_command), admitted=lambda: True,
        session_ready=session_ready,
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
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
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

        service = hermes_service(local_command=command)
        service.channel.failure = 'This direct processor fixture has no engine'
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
            self.assertFalse(service.local_actions.tasks)
        finally:
            release.set()
            await service.local_actions.close()
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
            'volume thirty%': 30, 'please volume 30%': 30, 'volume 30 percent please': 30,
            'volume fifty%': 50, 'volume two percent': 2, 'volume 0%': 0, 'set volume 30': 30,
            'set volume to thirty percent': 30, 'set the volume thirty-one': 31,
            'set the volume to forty two %': 42, 'please set volume to 100': 100,
            'set the volume to one hundred percent please!': 100,
            ' PLEASE SET THE VOLUME TO ZERO. ': 0, 'set volume to 1% please.': 1,
            **{f'set the volume to {percent}': percent for percent in range(101)},
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
                with patch.dict(bot.LOCAL_TOOLS, volume=bot.LocalTool(bot.PermissionTier.FREE, action, 'volume', 'set the volume to thirty')):
                    tool = bot.match_instant_tool(text)
                    await tool.run(command=command)
                    action.assert_awaited_once_with(percent, command=command)
        for text in (
            'volume one', 'Volume two.', 'volume zero', 'volume 30',
            'please volume two', 'volume zero please!',
            'volume 101 percent', 'volume -1 percent', 'volume +30 percent',
            'volume 030 percent', 'volume 00%', 'volume 30.0 percent', 'volume ٣٠ percent',
            'volume hundred percent', 'volume twenty ten percent',
            'volume thirty  one percent', 'volume thirty--one percent', 'volume thirty percent?',
            'volume 30%!!', '"volume 30%"', 'do not volume 30%',
            'volume 30 percent and mute', 'volume\n30 percent',
            'volume\t30 percent', 'volume  30 percent', 'volume 1e2 percent', '',
            '30', 'volume to 30', 'set the volume to', 'set volume to 101',
            'set the volume to -1', 'set the volume to +30', 'set the volume to 030',
            'set the volume to 00', 'set the volume to 30.0', 'set the volume to ٣٠',
            'set the volume to hundred', 'set volume to twenty ten', 'set volume to 1e2',
            'please set volume to 30 please', 'please please volume 30',
            'set volume to 30 please please', 'set the volume to 30?',
            '"set the volume to 30"', 'set the volume to 30!!',
            'do not set the volume to 30', "don't set the volume to 30",
            'never set the volume to 30', 'set the volume to 30 and mute',
            'please set the volume to 30 and tell me a fact',
            'set  the volume to 30', 'set the volume  to 30', 'set the volume to  30',
            'set the volume to\n30', 'set the volume to\t30',
        ):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, volume=bot.LocalTool(permission, AsyncMock(), 'volume', 'set the volume to thirty')):
                self.assertIsNone(bot.match_instant_tool('set the volume to 30'))


class LocalDesktopTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def media(**changes):
        return json.dumps(dict(hasPlayer=True, playing=True, canGoNext=True,
                               identity='Player', desktopEntry='player.desktop',
                               title='First track', artist='Artist', album='Album') | changes)

    async def test_screenshot_requires_fresh_file_without_reading_content(self):
        phrase = 'take a screenshot'
        self.assertIsNotNone(bot.match_instant_tool(phrase), 'Exact screenshot turns must select local work')
        tool = bot.LOCAL_TOOLS[phrase]
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        for text in (phrase, ' TAKE A SCREENSHOT. ', phrase + '!'):
            self.assertIs(bot.match_instant_tool(text), tool)
        for text in (phrase + '?', '"' + phrase + '"', phrase + '!!', 'do not ' + phrase,
                     phrase + ' please', 'take a\nscreenshot', phrase + '; echo bad'):
            self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, {phrase: bot.LocalTool(permission, AsyncMock(), phrase, phrase)}):
                self.assertIsNone(bot.match_instant_tool(phrase))
        argv = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')
        advisory = "I couldn't confirm the screenshot. Check your screenshot folder. I won't retry."
        started = 2_000_000_000_000_000_000
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'screenshot-2026-10-18_12-34-56.png'
            path.write_bytes(b'Not image content: metadata alone confirms the native save')
            os.utime(path, ns=(started, started))
            empty = Path(folder) / 'screenshot-2026-10-18_12-34-57.png'
            empty.touch()
            old = Path(folder) / 'screenshot-2026-10-18_12-34-58.png'
            old.write_bytes(b'old')
            os.utime(old, ns=(started - 1, started - 1))
            link = Path(folder) / 'screenshot-2026-10-18_12-34-59.png'
            link.symlink_to(path)
            directory = Path(folder) / 'screenshot-2026-10-18_12-35-00.png'
            directory.mkdir()
            for output, confirmed in ((str(path), True), (str(path) + '\n', True),
                                      ('', False), ('\n', False), ('relative.png', False),
                                      (str(path) + '\n\n', False), (str(path) + '\r\n', False),
                                      (str(path) + '\n/other.png', False),
                                      (str(path).replace('screenshot-', 'other-'), False),
                                      (str(path).replace('.png', '.jpg'), False),
                                      (str(path).replace('/screenshot-', '/bad\x85/screenshot-'), False),
                                      (str(path.parent / 'screenshot-2026-10-18_00-00-00.png'), False),
                                      (str(empty), False), (str(old), False), (str(link), False),
                                      (str(directory), False)):
                with self.subTest(output=output):
                    command = AsyncMock(return_value=output)
                    with (patch.object(time, 'time_ns', return_value=started),
                          patch('builtins.open', side_effect=AssertionError('Screenshot content must not be opened')),
                          patch.object(io, 'open', side_effect=AssertionError('Screenshot content must not be opened')),
                          patch.object(os, 'open', side_effect=AssertionError('Screenshot content must not be opened'))):
                        result = await tool.run(command=command)
                    self.assertEqual(result, bot.DesktopResult(confirmed, True,
                                     'confirmed' if confirmed else 'screenshot unconfirmed',
                                     None if confirmed else advisory))
                    command.assert_awaited_once_with(argv)
            for error, expected_reason in ((RuntimeError('command failed'), 'command failed'),
                                           (OSError('PRIVATE path'), 'screenshot unconfirmed'),
                                           (TimeoutError(), 'screenshot unconfirmed')):
                command = AsyncMock(side_effect=error)
                result = await tool.run(command=command)
                self.assertEqual(result, bot.DesktopResult(False, True, expected_reason, advisory))
                command.assert_awaited_once_with(argv)
            command = AsyncMock(return_value=str(path))
            with patch.object(os, 'lstat', side_effect=PermissionError('PRIVATE path')):
                result = await tool.run(command=command)
            self.assertEqual(result, bot.DesktopResult(False, True, 'screenshot unconfirmed', advisory))
            command = AsyncMock(side_effect=asyncio.CancelledError())
            with self.assertRaises(asyncio.CancelledError):
                await tool.run(command=command)
            command.assert_awaited_once_with(argv)

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
                with patch.dict(bot.LOCAL_TOOLS, {phrase: bot.LocalTool(permission, AsyncMock(), phrase, phrase)}):
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
            artwork = 'data:image/jpeg;base64,' + 'A' * (64 * 1024)
            command = AsyncMock(side_effect=[self.media(artUrl=artwork), 'ok',
                                             json.dumps(json.loads(good) | {'artUrl': artwork})])
            result = await tool.run(command=command)
            self.assertTrue(result.confirmed, 'Valid embedded artwork must not prevent observed media confirmation')
            self.assertTrue(result.attempted)
            self.assertIsNone(result.message, 'Ignored artwork cannot supply speech')
            self.assertEqual(command.await_args_list, [call(status), call(write), call(status)])
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
            service = hermes_service(local_command=blocked_command)
            service.channel.failure = 'No engine in this direct fixture'
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
                self.assertFalse(service.local_actions.tasks)
            finally:
                release.set()
                await service.local_actions.close()
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
                service = hermes_service(local_command=command)
                service.channel.failure = 'No engine in this direct fixture'
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
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct fixture has no engine'
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
                self.assertFalse(service.local_actions.tasks)

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
            service = hermes_service(local_command=command)
            service.channel.failure = 'This direct fixture has no engine'
            service.push_frame = AsyncMock()
            held_reader = asyncio.create_task(asyncio.Event().wait())
            service.channel.reader = held_reader
            context = bot.LLMContext([{'role': 'user', 'content': 'pause music'}])
            action = asyncio.create_task(service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM))
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertTrue(service.local_actions.lock.locked())
                self.assertEqual(len(service.local_actions.tasks), 1)
                local_task = next(iter(service.local_actions.tasks))
                stopping = bot.LLMContext([{'role': 'user', 'content': word}])
                await asyncio.wait_for(service.process_frame(LLMContextFrame(stopping), FrameDirection.DOWNSTREAM), 5)
                self.assertEqual(stopping.get_messages(), [])
                self.assertIs(service.channel.reader, held_reader)
                self.assertFalse(held_reader.done(), 'Stop does not cancel native engine drainage')
                self.assertFalse(local_task.done(), 'Stop does not cancel an attempted desktop action')
                self.assertTrue(service.local_actions.lock.locked())
                self.assertEqual(len(calls), 2)
                service.push_frame.assert_not_awaited()
                release.set()
                await asyncio.wait_for(action, 5)
                self.assertEqual(calls.count(('/usr/bin/omarchy-shell', 'media', 'pause')), 1)
                self.assertFalse(service.local_actions.tasks)
                service.push_frame.assert_not_awaited()
            finally:
                release.set()
                await service.local_actions.close()
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
            with patch.dict(bot.LOCAL_TOOLS, workspace=bot.LocalTool(permission, AsyncMock(), 'workspace', 'workspace three')):
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
                                'HTTP_PROXY': 'http://remote', 'PYTHONPATH': '/poison',
                                'OMARCHY_SCREENSHOT_DIR': '/shots/$(literal)',
                                'XDG_PICTURES_DIR': '/pictures/white space'}
        for argv in (('/usr/bin/omarchy-shell', 'media', 'status'),
                     ('/usr/bin/hyprctl', '-j', 'activeworkspace'),
                     ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')):
            process = Mock(pid=9876, returncode=0)
            process.stdout.read = AsyncMock(side_effect=[b'ok\n', b''])
            process.wait = AsyncMock(return_value=0)
            expected = baseline | selectors
            if argv[0] == '/usr/bin/omarchy-shell':
                expected['OMARCHY_PATH'] = '/usr/share/omarchy'
            if argv[0] == '/usr/bin/omarchy':
                expected |= {'HOME': '/canonical/home', 'OMARCHY_PATH': '/usr/share/omarchy',
                             'OMARCHY_SCREENSHOT_DIR': '/shots/$(literal)',
                             'XDG_PICTURES_DIR': '/pictures/white space'}
            with (patch.dict(os.environ, poisoned, clear=True),
                  patch.object(bot.pwd, 'getpwuid', return_value=Mock(pw_dir='/canonical/home')),
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

        screenshot = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')
        for key in ('OMARCHY_SCREENSHOT_DIR', 'XDG_PICTURES_DIR'):
            for value in ('', 'relative', 'a' * 4097, '/' + 'a' * 4096, '/bad\npath', '/bad\x85path'):
                with (patch.dict(os.environ, poisoned | {key: value}, clear=True),
                      patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock()) as spawn):
                    with self.assertRaisesRegex(RuntimeError, '^screenshot destination unavailable$'):
                        await bot.run_local_command(screenshot)
                    spawn.assert_not_awaited()
        for destinations in ({}, {'OMARCHY_SCREENSHOT_DIR': '/' + 'é' * 4095}):
            process = Mock(pid=9876, returncode=0)
            process.stdout.read = AsyncMock(side_effect=[b'ok', b''])
            process.wait = AsyncMock(return_value=0)
            with (patch.dict(os.environ, selectors | destinations, clear=True),
                  patch.object(bot.pwd, 'getpwuid', return_value=Mock(pw_dir='/canonical/home')),
                  patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
                await bot.run_local_command(screenshot)
                self.assertEqual(spawn.await_args.kwargs['env'], baseline | selectors | destinations |
                                 {'HOME': '/canonical/home', 'OMARCHY_PATH': '/usr/share/omarchy'})
        for argv in (('/tmp/omarchy', 'capture', 'screenshot', 'fullscreen', 'save'),
                     ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'copy'),
                     (*screenshot, 'extra'), screenshot[:-1]):
            process = Mock(pid=9876, returncode=0)
            process.stdout.read = AsyncMock(side_effect=[b'ok', b''])
            process.wait = AsyncMock(return_value=0)
            with (patch.dict(os.environ, poisoned, clear=True),
                  patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
                await bot.run_local_command(argv)
                self.assertEqual(spawn.await_args.kwargs['env'], baseline)

        cases = []
        for argv in (('/usr/bin/omarchy-shell', 'media', 'status'),
                     ['/usr/bin/omarchy-shell', 'media', 'status']):
            cases.extend([(argv, 4 * 1024 * 1024, 4 * 1024 * 1024, True),
                          (argv, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, False)])
        cases.extend((argv, 4096, 4097, False) for argv in (
            ('/usr/bin/omarchy-shell', 'media', 'pause'),
            ('/usr/bin/omarchy-shell', 'media', 'next'),
            ('/usr/bin/hyprctl', '-j', 'activeworkspace'),
            ('/usr/bin/omarchy-shell', 'media', 'status', 'extra'),
            ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save'),
        ))
        for argv, budget, size, accepted in cases:
            with self.subTest(argv=argv, size=size):
                payload = b'A' * size
                cursor = 0
                async def read(n):
                    nonlocal cursor
                    self.assertGreater(n, 0)
                    self.assertLessEqual(n, budget + 1)
                    chunk = payload[cursor:cursor + n]
                    cursor += len(chunk)
                    return chunk
                process = Mock(pid=9876, returncode=0)
                process.stdout.read = AsyncMock(side_effect=read)
                process.wait = AsyncMock(return_value=0)
                with (patch.dict(os.environ, poisoned, clear=True),
                      patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg') as killpg):
                    if accepted:
                        output = await bot.run_local_command(argv)
                        self.assertEqual(len(output), size)
                        self.assertEqual(output, 'A' * size)
                        process.stdout._transport.close.assert_not_called()
                        killpg.assert_not_called()
                        process.wait.assert_awaited_once_with()
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^output too large$'):
                            await bot.run_local_command(argv)
                        process.stdout._transport.close.assert_called_once_with()
                        self.assertEqual(killpg.call_args_list,
                                         [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])
                        self.assertEqual(process.wait.await_count, 2, 'Overflow cleanup must reap its child')
                    spawn.assert_awaited_once()
                    self.assertEqual(spawn.await_args.args, tuple(argv))
                    self.assertEqual(cursor, size)



class LocalAppTests(unittest.IsolatedAsyncioTestCase):
    async def test_open_app_resolution_and_literal_dispatch(self):
        desktop_id = 'Fixture ; $(literal) "App".desktop'
        home = '/fixture/home ; $literal'
        expected_env = (
            f'HOME={home}', 'XDG_DATA_HOME=/fixture/caller data',
            'XDG_DATA_DIRS=/fixture/a;/literal:/fixture/b', 'XDG_CURRENT_DESKTOP=Hyprland:Fixture_1',
        )
        expected_launch_env = (
            'HOME=/fixture/home ; $$literal', 'XDG_DATA_HOME=/fixture/caller data',
            'XDG_DATA_DIRS=/fixture/a;/literal:/fixture/b', 'XDG_CURRENT_DESKTOP=Hyprland:Fixture_1',
        )
        with patch.object(bot.pwd, 'getpwuid', return_value=Mock(pw_dir=home)), patch.dict(os.environ, {
            'HOME': '/wrong/caller/home', 'XDG_DATA_HOME': '/fixture/caller data',
            'XDG_DATA_DIRS': '/fixture/a;/literal:/fixture/b', 'XDG_CURRENT_DESKTOP': 'Hyprland:Fixture_1',
        }, clear=True):
            for phrase in ('open Fixture App', ' OPEN Fixture App. ', 'Open Fixture App!'):
                with self.subTest(phrase=phrase):
                    command = AsyncMock(return_value=json.dumps(desktop_id))
                    name = bot.match_app_name(phrase)
                    self.assertEqual(name, 'Fixture App')
                    tool = await bot.resolve_app_tool(name, command=command)
                    self.assertIsNotNone(tool)
                    self.assertEqual(tool.permission, bot.PermissionTier.FREE)
                    command.assert_awaited_once_with((
                        '/usr/bin/env', *expected_env, '/usr/bin/python', '-I',
                        str(ROOT / 'app_resolver.py'),
                    ), stdin_data=b'Fixture App')
                    with patch.dict(os.environ, {'XDG_DATA_HOME': '/activation/data', 'XDG_DATA_DIRS': '/activation/dirs'}):
                        result = await tool.run(command=command)
                    self.assertTrue(result.accepted)
                    self.assertTrue(result.attempted)
                    self.assertIsNone(result.message, 'Exit status cannot establish visible success')
                    self.assertEqual(command.await_args_list[-1], call((
                        '/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env', *expected_launch_env,
                        '/usr/bin/gtk-launch', 'Fixture ; $$(literal) "App".desktop',
                    )))
                    self.assertEqual(command.await_count, 2, 'Exactly one lookup and one launch request')
            for phrase in ('open', 'open  ', 'open FixtureApp?', 'please open FixtureApp',
                           '"open FixtureApp"', "'open FixtureApp'", 'open Fixture\nApp', 'do not open FixtureApp'):
                with self.subTest(nonmatch=phrase):
                    self.assertIsNone(bot.match_app_name(phrase))
            for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
                with patch.dict(bot.LOCAL_TOOLS, {'open app': bot.LocalTool(permission, AsyncMock(), 'open app', "open followed by an installed app's exact name")}):
                    self.assertIsNone(bot.match_app_name('open FixtureApp'))
            for phrase, expected_name in (('open UnknownApp', 'UnknownApp'), ('open AmbiguousApp', 'AmbiguousApp'),
                                          ('open FixtureApp and tell me a fact', 'FixtureApp and tell me a fact')):
                command = AsyncMock(return_value='null\n')
                name = bot.match_app_name(phrase)
                self.assertEqual(name, expected_name)
                self.assertIsNone(await bot.resolve_app_tool(name, command=command))
                self.assertEqual(command.await_count, 1, 'Unknown names cannot launch')
            selected_name = bot.match_app_name('open FixtureApp')
            self.assertEqual(selected_name, 'FixtureApp')
            for output in ('', '{', 'null null', 'false', '42', '[]', '{}', '""',
                           '"../fixture.desktop"', '"-fixture.desktop"', '".fixture.desktop"',
                           '"fixture"', '"a:b.desktop"', '"a\\\\b.desktop"', '"a\\n.desktop"',
                           json.dumps('é' * 510 + '.desktop')):
                with self.subTest(output=output[:80]):
                    command = AsyncMock(return_value=output)
                    with self.assertRaises(ValueError):
                        await bot.resolve_app_tool(selected_name, command=command)
                    self.assertEqual(command.await_count, 1)
            command = AsyncMock(side_effect=RuntimeError('unavailable'))
            with self.assertRaises(RuntimeError):
                await bot.resolve_app_tool(selected_name, command=command)
            self.assertEqual(command.await_count, 1)
            for error in (RuntimeError('launch failed'), FileNotFoundError('missing'), TimeoutError()):
                command = AsyncMock(side_effect=error)
                result = await bot.open_app(desktop_id, expected_env, command=command)
                self.assertFalse(result.accepted)
                self.assertTrue(result.attempted)
                self.assertEqual(result.message, "I couldn't confirm the app opened. Check the desktop. I won't retry.")
                self.assertEqual(command.await_count, 1)
        defaults = (f'HOME={home}', f'XDG_DATA_HOME={home}/.local/share',
                    'XDG_DATA_DIRS=/usr/local/share:/usr/share', 'XDG_CURRENT_DESKTOP=')
        with patch.object(bot.pwd, 'getpwuid', return_value=Mock(pw_dir=home)), patch.dict(os.environ, {}, clear=True):
            command = AsyncMock(return_value='"fixture.desktop"')
            tool = await bot.resolve_app_tool(selected_name, command=command)
            with patch.dict(os.environ, {'XDG_DATA_HOME': '/changed', 'XDG_DATA_DIRS': '/changed'}):
                await tool.run(command=command)
            self.assertEqual(command.await_args_list[0].args[0][1:5], defaults)
            self.assertEqual(command.await_args_list[1].args[0][5:9], (
                'HOME=/fixture/home ; $$literal', 'XDG_DATA_HOME=/fixture/home ; $$literal/.local/share',
                'XDG_DATA_DIRS=/usr/local/share:/usr/share', 'XDG_CURRENT_DESKTOP=',
            ))
            for key in ('XDG_DATA_HOME', 'XDG_DATA_DIRS'):
                with patch.dict(os.environ, {key: ''}):
                    self.assertEqual(bot.app_discovery_environment(), defaults)
            for key, value in (('XDG_DATA_HOME', 'relative'), ('XDG_DATA_HOME', '/a\n'),
                               ('XDG_DATA_DIRS', ':/a'), ('XDG_DATA_DIRS', '/a:'),
                               ('XDG_DATA_DIRS', '/a:relative'), ('XDG_DATA_HOME', '/' + 'a' * 4096),
                               ('XDG_CURRENT_DESKTOP', 'Hyprland;bad'), ('XDG_CURRENT_DESKTOP', 'A::B'),
                               ('XDG_CURRENT_DESKTOP', 'é')):
                with self.subTest(key=key, value=value[:80]), patch.dict(os.environ, {key: value}):
                    command = AsyncMock()
                    with self.assertRaises(ValueError):
                        await bot.resolve_app_tool(selected_name, command=command)
                    command.assert_not_awaited()
            for name in ('x' * 1025, 'a\x00b', 'a\tb'):
                self.assertIsNone(bot.match_app_name(f'open {name}'))

        ordinary = 'Ordinary interrupted request.'
        context = bot.LLMContext([{'role': 'user', 'content': ordinary}])
        captured = context.get_messages()[-1]
        command = AsyncMock(side_effect=AssertionError('Ordinary turns cannot run local commands'))
        service = hermes_service(local_command=command)
        pending = asyncio.get_running_loop().create_future()
        service.channel.reader = pending
        checkpoint, unreleased = asyncio.Event(), asyncio.Event()
        real_resolve, real_shield = bot.resolve_app_tool, asyncio.shield
        requests = []

        async def resolve_at_checkpoint(text, *, command=bot.run_local_command):
            if text == ordinary:
                checkpoint.set()
                await unreleased.wait()
            return await real_resolve(text, command=command)

        def shield_at_checkpoint(awaitable):
            if awaitable is pending:
                checkpoint.set()
            return real_shield(awaitable)

        async def exchange(messages, output, *, admitted):
            requests.append(messages)
            output.put_nowait({'delivery': 'neutral'})
            output.put_nowait(None)

        processing = None
        try:
            with (patch.object(bot, 'resolve_app_tool', resolve_at_checkpoint),
                  patch.object(bot.asyncio, 'shield', shield_at_checkpoint),
                  patch.object(service.channel, 'exchange', exchange)):
                processing = asyncio.create_task(service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM))
                await asyncio.wait_for(checkpoint.wait(), 5)
                processing.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await processing
                self.assertTrue(any(message is captured for message in context.get_messages()),
                                'Interrupted ordinary user message must remain in context')
                context.get_messages().append({'role': 'user', 'content': 'Following ordinary request.'})
                service.channel.reader = None
                await service.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
                self.assertEqual(requests, [[
                    {'role': 'user', 'content': 'Ordinary interrupted request.'},
                    {'role': 'user', 'content': 'Following ordinary request.'},
                ]])
                command.assert_not_awaited()
        finally:
            if processing is not None:
                processing.cancel()
            pending.cancel()
            await service.local_actions.close()
            tasks = [pending]
            if processing is not None:
                tasks.append(processing)
            if service.channel.reader is not None:
                service.channel.reader.cancel()
                tasks.append(service.channel.reader)
            await asyncio.gather(*tasks, return_exceptions=True)


class LocalMuteTests(unittest.IsolatedAsyncioTestCase):
    async def test_help_only_handles_completed_exact_user_turns(self):
        expected = ("You can say: mute; set the volume to thirty; pause music; next track; "
                    "workspace three; open followed by an installed app's exact name; take a screenshot. "
                    "None of these tools needs permission first.")
        accepted = ('what can I say', ' WHAT CAN I SAY. ', 'What can I say!', ' What Can I Say? ')
        rejected = ('"what can I say"', 'what can I say!!', 'what can I say??',
                    'do not tell me what can I say', 'what can I say please', 'what can I say? now',
                    'what can I say; mute', 'what can I say && delete everything', 'what\ncan I say', '')
        prior = [{'role': 'user', 'content': 'Earlier question.'},
                 {'role': 'assistant', 'content': 'Earlier answer.'}]
        cases = [([{'role': 'user', 'content': text}], False, FrameDirection.DOWNSTREAM,
                  text in accepted) for text in (*accepted, *rejected)]
        cases.extend([
            ([{'role': 'user', 'content': 'what can I say'}], True, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'user', 'content': 'what can I say'}], False, FrameDirection.UPSTREAM, False),
            ([{'role': 'assistant', 'content': 'what can I say'}], False, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'system', 'content': 'what can I say'}], False, FrameDirection.DOWNSTREAM, False),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': 'what can I say'}]}],
             False, FrameDirection.DOWNSTREAM, False),
            ([], False, FrameDirection.DOWNSTREAM, False),
        ])
        for messages, speculative, direction, consumes in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Help must not invoke a desktop command'))
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(prior + messages))
                await service.process_frame(LLMContextFrame(context, speculation=speculative), direction)
                self.assertEqual(context.get_messages(), prior if consumes else prior + messages)
                replies = [args.args[0] for args in service.push_frame.await_args_list
                           if isinstance(args.args[0], bot.TTSSpeakFrame)]
                self.assertEqual([frame.text for frame in replies], [expected] if consumes else [])
                if consumes:
                    self.assertFalse(replies[0].append_to_context)
                command.assert_not_awaited()

    def test_help_tracks_registry_permissions_without_inventing_tools(self):
        for key, tool in bot.LOCAL_TOOLS.items():
            with self.subTest(tool=key):
                self.assertIsInstance(tool.spoken, str)
                self.assertTrue(tool.spoken.strip())
                if tool.permission is bot.PermissionTier.FREE and key != 'open app':
                    matched = bot.match_instant_tool(tool.spoken)
                    self.assertIsNotNone(matched)
                    self.assertEqual(matched.subject, tool.subject)
        action = AsyncMock(side_effect=AssertionError('Formatting help cannot execute tools'))
        free = bot.PermissionTier.FREE
        ask = bot.PermissionTier.ASK
        forbidden = bot.PermissionTier.FORBIDDEN
        with patch.dict(bot.LOCAL_TOOLS, {
            'alpha': bot.LocalTool(free, action, 'alpha', 'alpha example'),
        }, clear=True):
            self.assertEqual(bot.capability_help(),
                             'You can say: alpha example. None of these tools needs permission first.')
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(free, action, 'beta', 'beta example')
            self.assertEqual(bot.capability_help(),
                             'You can say: alpha example; beta example. None of these tools needs permission first.')
            del bot.LOCAL_TOOLS['alpha']
            self.assertEqual(bot.capability_help(),
                             'You can say: beta example. None of these tools needs permission first.')
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(ask, action, 'beta', 'beta example')
            self.assertEqual(bot.capability_help(),
                             'No local tools are available without permission. Permission required: beta example. '
                             "These tools aren't available by voice yet.")
            bot.LOCAL_TOOLS['alpha'] = bot.LocalTool(free, action, 'alpha', 'alpha example')
            bot.LOCAL_TOOLS['gamma'] = bot.LocalTool(ask, action, 'gamma', 'gamma example')
            self.assertEqual(bot.capability_help(),
                             'You can say: alpha example. Permission required: beta example; gamma example. '
                             "These tools aren't available by voice yet.")
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(forbidden, action, 'beta', 'beta example')
            del bot.LOCAL_TOOLS['gamma']
            self.assertEqual(bot.capability_help(),
                             'You can say: alpha example. None of these tools needs permission first.')
            del bot.LOCAL_TOOLS['alpha']
            self.assertEqual(bot.capability_help(), "No local tools are available. Check Kestrel's setup.")
            bot.LOCAL_TOOLS.clear()
            self.assertEqual(bot.capability_help(), "No local tools are available. Check Kestrel's setup.")
        action.assert_not_called()

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
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'volume', 'pause music', 'next track', 'workspace', 'open app', 'take a screenshot'})
        for messages, speculative, direction, consumes in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Repeat must not invoke a desktop command'))
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
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
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
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

        service = hermes_service(local_command=command)
        service.channel.failure = 'This direct processor fixture has no engine'
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
            self.assertFalse(service.local_actions.tasks)
        finally:
            release.set()
            await service.local_actions.close()
            if not processing.done():
                processing.cancel()
            await asyncio.gather(processing, return_exceptions=True)

    def test_only_exact_mute_selects_a_free_tool(self):
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'volume', 'pause music', 'next track', 'workspace', 'open app', 'take a screenshot'})
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
            with patch.dict(bot.LOCAL_TOOLS, mute=bot.LocalTool(permission, AsyncMock(), 'mute', 'mute')):
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

        process = Mock(pid=9876, returncode=0)
        process.stdout.read = AsyncMock(side_effect=[b'local\n', b''])
        process.wait = AsyncMock(return_value=0)
        process.stdin.drain = AsyncMock()
        process.stdin.wait_closed = AsyncMock()
        with patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn:
            self.assertEqual(await bot.run_local_command(('/test/command',), stdin_data=b'private\x00input'), 'local\n')
            self.assertEqual(spawn.await_args.kwargs['stdin'], asyncio.subprocess.PIPE)
            process.stdin.write.assert_called_once_with(b'private\x00input')
            process.stdin.drain.assert_awaited_once_with()
            process.stdin.close.assert_called_once_with()
            process.stdin.wait_closed.assert_awaited_once_with()
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                started = asyncio.Event()
                stopped = asyncio.Event()
                reaped = asyncio.Event()
                process = Mock(pid=9876, returncode=None)

                async def drain():
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

                process.stdin.drain = AsyncMock(side_effect=drain)
                process.stdin.wait_closed = AsyncMock()
                process.stdout.read = AsyncMock(side_effect=AssertionError('Input must finish before reading output'))
                process.wait = AsyncMock(side_effect=wait)
                with (patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn,
                      patch.object(bot.os, 'killpg', side_effect=signal_group) as killpg,
                      patch.object(bot, 'LOCAL_COMMAND_TIMEOUT', 0.01, create=True),
                      patch.object(bot, 'LOCAL_COMMAND_CLEANUP_TIMEOUT', 0.01, create=True)):
                    task = asyncio.create_task(bot.run_local_command(('/test/hung',), stdin_data=b'private input'))
                    await asyncio.wait_for(started.wait(), 5)
                    if cancel:
                        task.cancel()
                    with self.assertRaises(asyncio.CancelledError if cancel else RuntimeError):
                        await asyncio.wait_for(task, 5)
                    self.assertTrue(stopped.is_set())
                    self.assertTrue(reaped.is_set())
                    process.stdin.write.assert_called_once_with(b'private input')
                    process.stdin.close.assert_called_once_with()
                    process.stdout.read.assert_not_awaited()
                    self.assertEqual(spawn.await_args.kwargs['stdin'], asyncio.subprocess.PIPE)
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
            sys.executable, '-c', "import sys; assert sys.stdin.buffer.read() == b'wire input'; print('local wire', flush=True)",
        ), stdin_data=b'wire input'), 'local wire\n')
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
                await service.channel.exchange([{'role': 'user', 'content': 'Hello.'}], output, admitted=service.admitted)
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
                bot.LLMContextFrame(bot.LLMContext([{'role': 'user', 'content': 'Hello.'}])),
                FrameDirection.DOWNSTREAM,
            )
            frames = [call.args[0] for call in service.push_frame.call_args_list]
            starts = [f for f in frames if isinstance(f, bot.LLMFullResponseStartFrame)]
            self.assertEqual(len(starts), 1)
            self.assertEqual(starts[0].speech_delivery, delivery)
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
            bot.LLMContextFrame(bot.LLMContext([{'role': 'user', 'content': 'Old request.'}])),
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
            self.assertEqual(starts[0].speech_delivery, 'neutral')
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
                         close=AsyncMock(), drain=AsyncMock(), failure=None, reader=None, preparation=None),
        ))
        engine.start()
        self.addCleanup(engine.stop)
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

            def adapter(channel, *, local_actions, admitted, session_ready, status, conversation):
                prototype.session_ready = session_ready
                prototype.admitted = admitted
                prototype.status = status
                prototype.conversation = conversation
                return prototype

            async def activate_fixture():
                with patch.object(bot, 'HermesLLMService', side_effect=adapter):
                    await activate()

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

    async def run_bot(self):
        from desktop import control
        manager = bot.VoiceConversations(status=bot.IndicatorStatus(), conversation=bot.ConversationFeed())
        command = control.ConversationControl(manager.toggle)
        try:
            await command.start()
            await manager.prepare()
            self.assertEqual(await control.toggle(), 'starting')
            await manager.activate()
            if manager.pipeline is not None:
                await manager.pipeline
        finally:
            try:
                await manager.close()
            finally:
                await command.close()

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
            self.assertEqual(observations[0], ('echo-start', True, 'starting'))
            self.assertEqual([row[0] for row in observations], ['echo-start', 'transport-close', 'echo-close'])
            self.assertTrue(all(row[2] != 'released' for row in observations[1:]))
            self.assertTrue(snapshot.exists(), 'Cleanup must leave a release receipt')
            self.assertEqual(json.loads(snapshot.read_text())['state'], 'released')

    async def test_indicator_publication_failure_preserves_voice(self):
        for failure in ('publication', 'delayed-startup', 'model-startup', 'transport-close', 'echo-close', 'echo-failure', 'transport-close-interrupted'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as runtime:
                self.audio.capture = None
                self.audio.reset_mock()
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

        async def conversation(stt, voice, *, llm, transport, handle_signals, status=None, conversation=None):
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
                    self.assertEqual(self.voice.generate_streaming.call_count, 1)
                    os.environ['KESTREL_VOICE'] = 'unknown'
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
            patch.object(bot, "NemotronRecognizer", return_value=stt),
            patch.object(bot.VoxCPM, "from_pretrained", side_effect=load_model) as load,
            patch.object(bot, "run_conversation", new_callable=AsyncMock) as conversation,
            patch.object(bot.torch, "set_num_threads"),
        ):
            conversation.side_effect = lambda *args, **kwargs: events.append('conversation')
            await self.run_bot()
            await self.run_bot()
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
                self.audio.output.return_value = Forward(output=True)
                native_conversation = bot.run_conversation

                async def conversation(stt, voice, *, llm, transport, handle_signals, status=None, conversation=None):
                    self.assertIs(llm, service)
                    self.assertIs(transport, self.audio)
                    self.assertFalse(handle_signals)
                    await native_conversation(stt, voice, llm=llm, transport=transport,
                        handle_signals=handle_signals, status=status, conversation=conversation, user_params=bot.LLMUserAggregatorParams(
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

        transport = Mock(input=Mock(return_value=Forward()), output=Mock(return_value=Forward()))
        params = bot.LLMUserAggregatorParams(user_turn_strategies=ExternalUserTurnStrategies(), empty_user_turn=None)
        voice = speech.VoxCPMTTS(self.voice, speech.load_voice_preset('irish-female', voices_dir=self.voices))
        llm = Forward()
        llm.admitted = lambda: True
        llm.conversation_output = Mock()
        with patch.object(bot, "PipelineWorker", side_effect=capture_worker):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=llm, transport=transport, user_params=params,
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
        llm = Forward()
        llm.admitted = lambda: True
        llm.conversation_output = Mock()
        with (patch.object(bot, "UserBotLatencyObserver", return_value=observer),
              patch.object(bot.logger, "info", side_effect=log)):
            task = asyncio.create_task(bot.run_conversation(
                Forward(), voice, llm=llm, transport=transport, user_params=params,
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
    async def open_session(self, brain, *, wire=None, local_command=None, prepare_engine=False, status=None,
                           synthesis_chunks=None, through_service=False, channel=None, local_actions=None,
                           admitted=None, activate=True, native_audio=False, trace_root=None, memory_root=None, native_events=None):
        if brain is not None:
            require_native_hermes()
        from desktop import control, status as status_module
        from types import SimpleNamespace
        started, prepared = asyncio.Queue(), asyncio.Event()
        native_written = asyncio.Event()
        spoken, committed, processed = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
        interrupted = asyncio.Event()
        sessions, processes, bindings, audio_children = [], [], [], []
        controller = None
        service_task = None
        completion_observed = False
        handlers = {}
        runtime = os.environ.get('XDG_RUNTIME_DIR', '')
        owned_runtimes = getattr(self, '_service_runtimes', set())
        self._service_runtimes = owned_runtimes
        if not runtime.startswith('/tmp/') or runtime in owned_runtimes:
            home = tempfile.TemporaryDirectory(prefix='kestrel-service-test-')
            self.addCleanup(home.cleanup)
            runtime = home.name
            owned_runtimes.add(runtime)
        environment = patch.dict(os.environ, XDG_RUNTIME_DIR=runtime)
        environment.start()
        bindings.append(environment)
        self.addCleanup(environment.stop)
        proc_home = tempfile.TemporaryDirectory(prefix='kestrel-proc-test-')
        self.addCleanup(proc_home.cleanup)
        proc_root = Path(proc_home.name)
        boot = proc_root / 'sys/kernel/random'
        boot.mkdir(parents=True)
        (boot / 'boot_id').write_text('12345678-1234-1234-1234-123456789abc')

        def identity(pid):
            folder = proc_root / str(pid)
            folder.mkdir(exist_ok=True)
            (folder / 'stat').write_text(f'{pid} (fixture) S ' + '0 ' * 18 + str(pid + 1000) + ' 0\n')
            return folder

        identity(os.getpid())
        identity(70001)
        supplied_channel = channel if channel is not None else bot.HermesRequestChannel()
        actions = local_actions if local_actions is not None else bot.LocalActions(command=local_command)
        recognizer = speech.NemotronRecognizer()
        recognizer.load = AsyncMock(side_effect=lambda pcm: prepared.set())
        recognizer.close = AsyncMock(wraps=recognizer.close)
        preset = speech.VoicePreset(Path('/fixture/british-male.wav'), 'British fixture.', bytes(9600))
        calls = 0

        def chunks(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.assertEqual(kwargs['text'], 'Hello.')
                yield np.zeros(4800, dtype=np.float32)
            elif synthesis_chunks is not None:
                yield from synthesis_chunks(**kwargs)
            else:
                self.assertEqual(kwargs['prompt_text'], 'British fixture.')
                yield np.zeros(4800, dtype=np.float32)

        model = Mock(generate_streaming=chunks)
        native_stt = speech.NemotronSTT

        def new_stt(recognizer, *, admitted):
            adapter = native_stt(recognizer, admitted=admitted)
            sessions[-1].stt = adapter
            return adapter

        native_spawn = asyncio.create_subprocess_exec

        async def spawn(*command, **kwargs):
            self.assertEqual(command, (str(bot.HERMES_PYTHON), str(ROOT / 'hermes_worker.py')))
            home = Path(kwargs['env']['HERMES_HOME'])
            try:
                if wire is not None:
                    command = (sys.executable, '-c', wire)
                elif brain is None:
                    raise OSError('No controlled provider')
                else:
                    command = WorkerProcess.command(home, brain, trace_root=trace_root, memory_root=memory_root)
                process = await native_spawn(*command, **kwargs)
            except OSError:
                processes.append((None, home))
                raise
            processes.append((process, home))
            if native_events is not None:
                native_write = process.stdin.write

                def write(data):
                    native_events.append(('write', json.loads(data)))
                    native_written.set()
                    return native_write(data)

                process.stdin.write = write
            return process

        native_transport = speech.LaptopAudioTransport

        def child(*, capture):
            pid = 71000 + len(audio_children)
            folder = identity(pid)
            process = Mock(pid=pid, returncode=None, stdin=None, stdout=None)
            process.reaped = asyncio.Event()
            process.writes = []
            if capture:
                process.stdout = asyncio.StreamReader()
                process.stdout.feed_data(bytes(640))
            else:
                process.stdin = Mock()
                process.stdin.write.side_effect = process.writes.append
                process.stdin.drain = AsyncMock()
                process.stdin.wait_closed = AsyncMock()

            exited = asyncio.Event()
            process.kill.side_effect = exited.set
            process.terminate.side_effect = exited.set

            async def wait():
                await exited.wait()
                process.returncode = 0
                (folder / 'stat').unlink(missing_ok=True)
                if folder.exists():
                    folder.rmdir()
                process.reaped.set()
                return 0

            process.wait = AsyncMock(side_effect=wait)
            audio_children.append(process)
            return process

        def new_transport(echo, *, on_stopped, admitted):
            active = admitted
            if admitted_override is not None:
                active = lambda: admitted() and admitted_override()
            if native_audio:
                transport = native_transport(echo, on_stopped=on_stopped, admitted=active)

                async def spawn_audio(*argv, **kwargs):
                    return child(capture='--record' in argv)

                transport._spawn = spawn_audio
                original_open = transport.open

                async def open_audio():
                    await original_open()
                    transport.llm = controller.llm

                transport.open = open_audio
            else:
                class Input(FrameProcessor):
                    async def process_frame(self, frame, direction):
                        if isinstance(frame, DataFrame) and not active():
                            return
                        await super().process_frame(frame, direction)
                        await self.push_frame(frame, direction)

                class Output(BaseOutputTransport):
                    def __init__(self):
                        super().__init__(TransportParams(audio_out_enabled=True, audio_out_sample_rate=48000))
                        self.write_gate = asyncio.Event()
                        self.write_gate.set()

                    async def start(self, frame):
                        await super().start(frame)
                        await self.set_transport_ready(frame)

                    async def write_audio_frame(self, frame):
                        await self.write_gate.wait()
                        written = active() and not transport.closed
                        if written:
                            self.audio_written += 1
                        return written

                transport = Mock(capture=None, failure=None, closed=False, admitted=active)
                transport.input.return_value = Input()
                transport.output.return_value = Output()

                async def open_audio():
                    transport.llm = controller.llm

                async def close_audio():
                    transport.closed = True
                    transport.output().write_gate.set()

                transport.open = AsyncMock(side_effect=open_audio)
                transport.close = AsyncMock(side_effect=close_audio)
            output = transport.output()
            output.generation_done = asyncio.Event()
            output.audio_written = 0
            transport.processed = processed
            transport.sessions = sessions
            transport.audio_children = audio_children
            transport.service = service_handle
            transport.cleanup_finished = asyncio.get_running_loop().create_future()
            sessions.append(transport)

            @output.event_handler('on_after_process_frame')
            async def received(processor, frame):
                if isinstance(frame, StartFrame):
                    started.put_nowait(transport)
                elif isinstance(frame, LLMFullResponseEndFrame):
                    output.generation_done.set()

            @output.event_handler('on_after_push_frame')
            async def observe(processor, frame):
                if isinstance(frame, InterruptionFrame):
                    interrupted.set()
                elif type(frame) is DataFrame:
                    processed.put_nowait(frame)
                elif active():
                    if isinstance(frame, TTSTextFrame):
                        spoken.put_nowait(frame.text)
                    elif isinstance(frame, LLMContextAssistantTurnFrame):
                        committed.put_nowait(frame.text.strip())

            return transport

        native_conversations = bot.VoiceConversations
        admitted_override = admitted
        service_handle = SimpleNamespace(sessions=sessions, audio_children=audio_children, started=started,
                                         recognizer=recognizer, model=model, channel=supplied_channel, native_written=native_written)

        def conversations(**kwargs):
            nonlocal controller
            controller = native_conversations(**kwargs)
            service_handle.manager = controller
            native_finish = controller.finish_conversation

            async def finish_conversation():
                transport = controller.transport
                try:
                    return await native_finish()
                finally:
                    if transport is not None and not transport.cleanup_finished.done():
                        transport.cleanup_finished.set_result(asyncio.current_task())

            controller.finish_conversation = finish_conversation
            return controller

        if native_events is not None:
            native_read = supplied_channel.read_event

            async def read_event():
                event = await native_read()
                native_events.append(('read', event))
                return event

            binding = patch.object(supplied_channel, 'read_event', side_effect=read_event)
            binding.start()
            bindings.append(binding)
            self.addCleanup(binding.stop)

        native_prepare = supplied_channel.prepare

        async def prepare():
            if supplied_channel.process is not None:
                return
            if prepare_engine or through_service:
                await native_prepare()
            else:
                await supplied_channel._open()

        async def toggle():
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(control.address()), 1)
            try:
                writer.write(b'toggle\n')
                await writer.drain()
                writer.write_eof()
                reply = await asyncio.wait_for(reader.read(13), 1)
                self.assertIn(reply, (b'starting\n', b'inactive\n', b'unavailable\n'))
                return reply.decode().strip()
            finally:
                await control.close_writer(writer)

        service_handle.toggle = toggle

        async def state(expected):
            changed = asyncio.Event()
            original = controller.status.set_state
            if controller.status._state == expected:
                return

            def observe(value):
                original(value)
                if value == expected:
                    changed.set()

            with patch.object(controller.status, 'set_state', side_effect=observe):
                await asyncio.wait_for(changed.wait(), 5)

        service_handle.state = state

        async def close():
            nonlocal completion_observed
            try:
                if service_task is not None and not service_task.done():
                    callback, arguments = handlers[signal.SIGTERM]
                    callback(*arguments)
                if service_task is not None and not completion_observed:
                    try:
                        await asyncio.wait_for(service_task, 5)
                    except TimeoutError:
                        raise
                    except RuntimeError as error:
                        completion_observed = True
                        if controller.failure is None:
                            raise
                        service_handle.shutdown_error = error
                    except BaseException:
                        completion_observed = True
                        raise
                    else:
                        completion_observed = True
            finally:
                for binding in reversed(bindings):
                    binding.stop()
            for process, home in processes:
                if process is not None:
                    self.assertIsNotNone(process.returncode)
                self.assertFalse(home.exists())
            for process in audio_children:
                self.assertIsNotNone(process.returncode)

        self.addAsyncCleanup(close)
        loop = asyncio.get_running_loop()

        def register(sig, callback, *arguments):
            handlers[sig] = callback, arguments

        for binding in (
            patch.object(bot.asyncio, 'create_subprocess_exec', spawn),
            patch('pipecat.services.openai.llm.OpenAILLMService.get_chat_completions',
                  side_effect=AssertionError('Direct provider bypass is prohibited')),
            patch.object(bot, 'VoiceConversations', side_effect=conversations),
            patch.object(bot, 'NemotronRecognizer', return_value=recognizer),
            patch.object(bot, 'NemotronSTT', side_effect=new_stt),
            patch.object(bot, 'HermesRequestChannel', return_value=supplied_channel),
            patch.object(bot, 'LocalActions', return_value=actions),
            patch.object(bot, 'LaptopAudioTransport', side_effect=new_transport),
            patch.object(supplied_channel, 'prepare', side_effect=prepare),
            patch.object(bot.VoxCPM, 'from_pretrained', return_value=model),
            patch.object(bot, 'load_voice_preset', return_value=preset),
            patch.object(bot, 'UserTurnStrategies', side_effect=lambda **kwargs: ExternalUserTurnStrategies()),
            patch.object(bot, 'SileroVADAnalyzer', return_value=None),
            patch.object(bot, 'LocalSmartTurnAnalyzerV3', return_value=object()),
            patch.object(bot.ECHO_REMOVAL, 'start'), patch.object(bot.ECHO_REMOVAL, 'close'),
            patch.object(bot.ECHO_REMOVAL, 'process', Mock(pid=70001)),
            patch.object(bot.ECHO_REMOVAL, 'microphone_serial', return_value=900),
            patch.object(status_module, '_PROC_ROOT', proc_root),
            patch.object(bot.torch, 'set_num_threads'),
            patch.object(loop, 'add_signal_handler', side_effect=register),
            patch.object(loop, 'remove_signal_handler'),
            *([patch.object(bot, 'IndicatorStatus', return_value=status)] if status is not None else []),
        ):
            binding.start()
            bindings.append(binding)
            self.addCleanup(binding.stop)
        service_task = asyncio.create_task(bot.run_voice_service())
        await asyncio.wait_for(prepared.wait(), 5)
        await state('inactive')
        if activate:
            self.assertEqual(await toggle(), 'starting')
            transport = await asyncio.wait_for(started.get(), 5)
        else:
            transport = SimpleNamespace(service=service_handle, sessions=sessions, audio_children=audio_children)
        return transport, spoken, committed, interrupted, processes, close

    async def finish_user_turn(self, transport, text):
        await transport.input().queue_frame(
            TranscriptionFrame(text, '', '2026-01-01T00:00:00Z', finalized=True)
        )
        await transport.input().queue_frame(ProposedUserStoppedSpeakingFrame())

    async def test_inactive_capture_never_reaches_recognition_or_actions(self):
        command = AsyncMock(side_effect=AssertionError('Inactive input cannot execute local commands'))
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        handle, spoken, committed, interrupted, _, close = await self.open_session(
            brain, local_command=command, through_service=True, activate=False, native_audio=True,
        )
        service = handle.service
        try:
            self.assertEqual(handle.sessions, [], 'Inactive startup opens no capture or playback')
            self.assertIsNone(service.recognizer.reader)
            self.assertEqual(await service.toggle(), 'starting')
            transport = await asyncio.wait_for(service.started.get(), 5)
            llm = transport.llm
            old_stt = speech.NemotronSTT(service.recognizer, admitted=transport.admitted)
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await transport.input().queue_frame(InputAudioRawFrame(b'private inactive audio', 16000, 1))
            self.assertEqual(await service.toggle(), 'inactive')
            cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
            await asyncio.wait_for(asyncio.shield(cleanup), 5)
            self.assertEqual(service.manager.status._state, 'inactive')
            transport.capture.stdout.feed_data(b'private stale capture' * 100)
            self.assertTrue(transport.reader.done())
            self.assertTrue(transport.capture.reaped.is_set())
            self.assertEqual([frame async for frame in old_stt.run_stt(b'private stale audio')], [])
            await llm.process_frame(LLMContextFrame(bot.LLMContext([{'role': 'user', 'content': 'mute'}])),
                                    FrameDirection.DOWNSTREAM)
            self.assertFalse(await transport.output().write_audio_frame(TTSAudioRawFrame(bytes(640), 48000, 1)))
            self.assertEqual(command.await_count, 0, 'An inactive service must reject ordinary input')
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(service.manager.conversation.turns, [])
            self.assertIsNone(llm.last_spoken_reply)
            self.assertEqual(service.manager.status._state, 'inactive')
        finally:
            await close()

    async def test_dismiss_revokes_partial_turn_and_queued_action(self):
        effect_started, release_effect, queued = asyncio.Event(), asyncio.Event(), asyncio.Event()
        partial_seen, native_written = asyncio.Event(), asyncio.Event()
        calls, writes, consumers = [], [], []
        level = 32768
        self.addCleanup(release_effect.set)

        async def command(argv):
            nonlocal level
            calls.append(tuple(argv))
            if argv[:2] == ('/usr/bin/pactl', 'get-default-sink'):
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if 'get-sink-volume' in argv:
                return LocalVolumeTests.volume(level)
            if 'get-sink-mute' in argv:
                return 'Mute: no'
            if 'set-sink-volume' in argv:
                effect_started.set()
                await release_effect.wait()
                level = 19660
                return ''
            raise AssertionError(f'Unexpected external action: {argv}')

        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, local_command=command, through_service=True, native_audio=True,
        )
        self.addCleanup(release_effect.set)
        service = transport.service
        manager = service.manager
        old_stt = transport.stt
        process = Mock(returncode=None)
        process.stdin.drain = AsyncMock()
        process.wait = AsyncMock()
        process.stdout = asyncio.StreamReader()

        def write(request):
            writes.append(request)
            native_written.set()

        process.stdin.write.side_effect = write
        service.recognizer.process = process

        async def consume():
            return [frame.text async for frame in old_stt.run_stt(b'held native audio')]

        async def clean_consumers():
            process.stdout.feed_data(b'{"text":"cleanup"}\n')
            release_effect.set()
            await asyncio.gather(*consumers, return_exceptions=True)

        self.addAsyncCleanup(clean_consumers)

        @old_stt.event_handler('on_after_process_frame')
        async def partial(processor, frame):
            if isinstance(frame, InputAudioRawFrame) and frame.audio == b'\x01\x00' * 320:
                partial_seen.set()

        native_run = manager.local_actions._run

        async def observe(tool, *, admitted):
            if tool.subject == 'mute':
                queued.set()
            return await native_run(tool, admitted=admitted)

        try:
            await transport.input().queue_frame(VADUserStartedSpeakingFrame())
            await transport.input().queue_frame(InputAudioRawFrame(b'\x01\x00' * 320, 16000, 1))
            await asyncio.wait_for(partial_seen.wait(), 5)
            self.assertEqual(writes, [], 'An incomplete segment has made no native request')
            consumer = asyncio.create_task(consume())
            consumers.append(consumer)
            await asyncio.wait_for(native_written.wait(), 5)
            with patch.object(manager.local_actions, '_run', side_effect=observe):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'volume thirty percent')
                await asyncio.wait_for(effect_started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                await self.finish_user_turn(transport, 'mute')
                await asyncio.wait_for(queued.wait(), 5)
                self.assertEqual(await service.toggle(), 'inactive')
                self.assertEqual(await service.toggle(), 'starting')
                self.assertEqual(await service.toggle(), 'inactive')
                self.assertFalse(transport.admitted())
                self.assertEqual(manager.conversation.turns, [])
                self.assertEqual(len(transport.sessions), 1)
                process.stdout.feed_data(b'{"text":"old private transcript"}\n')
                release_effect.set()
                cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                await asyncio.wait_for(asyncio.shield(cleanup), 5)
                self.assertEqual(service.manager.status._state, 'inactive')
            self.assertEqual(await asyncio.wait_for(consumer, 5), [])
            self.assertEqual(len(writes), 1)
            self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')), 1)
            self.assertFalse(any('set-sink-mute' in argv for argv in calls))
            self.assertFalse(manager.local_actions.tasks)
            self.assertTrue(transport.capture.reaped.is_set())
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 1)
        finally:
            process.stdout.feed_data(b'{"text":"cleanup"}\n')
            release_effect.set()
            await close()

    async def test_rapid_dismiss_summon_has_fresh_history_and_no_old_output(self):
        with self.subTest(outcome='dismiss_during_feed_reset'):
            entered, release, reset_finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
            self.addCleanup(release.set)
            brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
            self.addCleanup(brain.close)
            handle, spoken, committed, _, _, close = await self.open_session(
                brain, through_service=True, activate=False, native_audio=True,
            )
            service = handle.service
            begin_session = service.manager.conversation.begin_session

            async def held_reset():
                await begin_session()
                entered.set()
                await release.wait()
                reset_finished.set()

            try:
                with patch.object(service.manager.conversation, 'begin_session', side_effect=held_reset):
                    self.assertEqual(await service.toggle(), 'starting')
                    await asyncio.wait_for(entered.wait(), 5)
                    self.assertEqual(await service.toggle(), 'inactive')
                    release.set()
                    await asyncio.wait_for(reset_finished.wait(), 5)
                    self.assertEqual(service.manager.status._state, 'inactive')
                self.assertEqual(handle.sessions, [], 'Dismissed activation must create no capture or adapter')
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
            finally:
                release.set()
                await close()

        for mode in ('fresh', 'held_close_failure', 'watchdog'):
            with self.subTest(outcome=mode):
                loop = asyncio.get_running_loop()
                next_entered, close_entered = asyncio.Event(), asyncio.Event()
                release_next, release_close = threading.Event(), threading.Event()
                expire, watchdog_seen = asyncio.Event(), asyncio.Event()
                events = []
                self.addCleanup(release_next.set)
                self.addCleanup(release_close.set)

                def chunks(**kwargs):
                    text = kwargs['text']
                    events.append(('model', text))
                    if text != 'Old reply.':
                        yield np.zeros(4800, dtype=np.float32)
                        return
                    try:
                        yield np.zeros(4800, dtype=np.float32)
                        loop.call_soon_threadsafe(next_entered.set)
                        if not release_next.wait(45):
                            raise AssertionError('Synthetic native chunk never released')
                        yield np.zeros(4800, dtype=np.float32)
                    finally:
                        loop.call_soon_threadsafe(close_entered.set)
                        if not release_close.wait(45):
                            raise AssertionError('Synthetic native close never released')
                        events.append(('closed', text))
                        if mode == 'held_close_failure':
                            raise RuntimeError('held_close_failure')

                brain = ScriptedBrain([
                    [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nOld reply.'}, None), ({}, 'stop')],
                    [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
                ])
                self.addCleanup(brain.close)
                transport, spoken, committed, interrupted, _, close = await self.open_session(
                    brain, through_service=True, synthesis_chunks=chunks, native_audio=True,
                )
                self.addCleanup(release_next.set)
                self.addCleanup(release_close.set)
                service = transport.service
                manager = service.manager
                old_voice, old_llm, pipeline = manager.voice, manager.llm, manager.pipeline
                transport.output().write_gate.clear()
                native_wait_for = asyncio.wait_for
                states = []
                native_set_state = manager.status.set_state

                def set_state(value):
                    states.append(value)
                    native_set_state(value)

                async def wait_for(awaitable, timeout):
                    if timeout == 90 and mode == 'watchdog':
                        watchdog_seen.set()
                        await expire.wait()
                        return await native_wait_for(awaitable, 0)
                    return await native_wait_for(awaitable, timeout)

                try:
                    with (
                        patch.object(bot.asyncio, 'wait_for', side_effect=wait_for),
                        patch.object(manager.status, 'set_state', side_effect=set_state),
                    ):
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await asyncio.wait_for(interrupted.wait(), 5)
                        await self.finish_user_turn(transport, 'Old private request.')
                        await asyncio.wait_for(next_entered.wait(), 5)
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(manager.status._state, 'inactive')
                        self.assertFalse(transport.admitted())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertEqual(await service.toggle(), 'starting')
                        self.assertEqual(manager.status._state, 'starting')
                        self.assertEqual(await service.toggle(), 'inactive')
                        self.assertEqual(manager.status._state, 'inactive')
                        self.assertFalse(transport.admitted())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertEqual(await service.toggle(), 'starting')
                        self.assertEqual(manager.status._state, 'starting')
                        self.assertFalse(transport.admitted())
                        self.assertEqual(len(transport.sessions), 1)
                        if mode == 'watchdog':
                            await asyncio.wait_for(watchdog_seen.wait(), 5)
                            cleanup = manager.cleanup
                            expire.set()
                            await service.state('trouble')
                            self.assertIs(manager.cleanup, cleanup)
                            self.assertFalse(cleanup.done())
                            self.assertFalse(manager.desired_active)
                            self.assertEqual(await service.toggle(), 'unavailable')
                        release_next.set()
                        await asyncio.wait_for(close_entered.wait(), 5)
                        cleanup = manager.cleanup
                        self.assertFalse(cleanup.done())
                        self.assertTrue(manager.generation_lock.locked())
                        self.assertEqual(manager.conversation.turns, [])
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                        release_close.set()
                        if mode == 'held_close_failure':
                            with self.assertRaisesRegex(RuntimeError, 'generation cleanup failed'):
                                await asyncio.wait_for(asyncio.shield(cleanup), 5)
                            await service.state('trouble')
                            self.assertTrue(old_voice.generation_cleanup_failed)
                        else:
                            await asyncio.wait_for(asyncio.shield(cleanup), 5)
                            self.assertFalse(old_voice.generation_cleanup_failed)
                        self.assertTrue(pipeline.done())
                        self.assertIsNone(old_llm.last_spoken_reply)
                        if mode == 'fresh':
                            fresh = await asyncio.wait_for(service.started.get(), 5)
                            self.assertIsNot(fresh, transport)
                            self.assertIsNot(fresh.llm, old_llm)
                            self.assertIsNone(fresh.llm.last_spoken_reply)
                            self.assertTrue(transport.capture.reaped.is_set())
                            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
                            await self.finish_user_turn(fresh, 'Fresh private request.')
                            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
                            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
                            caller = [message for message in brain.requests[-1][2]['messages'] if message['role'] != 'system']
                            self.assertEqual(caller, [{'role': 'user', 'content': 'Fresh private request.'}])
                            self.assertLess(events.index(('closed', 'Old reply.')), events.index(('model', 'Fresh reply.')))
                        else:
                            self.assertEqual(await service.toggle(), 'unavailable', 'Failed cleanup must refuse activation')
                            self.assertEqual(manager.status._state, 'trouble')
                            self.assertEqual(len(transport.sessions), 1)
                            self.assertIs(manager.cleanup, cleanup, 'Late completion retains the original cleanup owner')
                            self.assertEqual(events, [('model', 'Old reply.'), ('closed', 'Old reply.')])
                        self.assertNotIn('released', states)
                finally:
                    expire.set()
                    release_next.set()
                    release_close.set()
                    await close()

    async def test_repeated_conversation_close_retains_echo_owner_and_private_traces(self):
        from desktop import conversation
        traces_home = tempfile.TemporaryDirectory(prefix='kestrel-retained-traces-')
        self.addCleanup(traces_home.cleanup)
        traces = Path(traces_home.name) / 'traces'
        traces.mkdir(mode=0o700)
        sentinel = traces / 'retained-private-sentinel'
        sentinel.write_bytes(b'pre-existing private trace')
        sentinel.chmod(0o600)
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            *[[({'content': f'[delivery:neutral]\nReply {cycle}.'}, None), ({}, 'stop')] for cycle in range(4)],
        ])
        self.addCleanup(brain.close)
        handle, spoken, committed, _, processes, close = await self.open_session(
            brain, through_service=True, activate=False, native_audio=True, trace_root=traces,
        )
        service = handle.service
        manager = service.manager
        states, identities, processors = [], [], []
        set_state = manager.status.set_state

        def observe(state):
            states.append(state)
            set_state(state)

        async def snapshot():
            reader, writer = await asyncio.open_unix_connection(conversation.address())
            row = json.loads(await asyncio.wait_for(reader.readline(), 1))
            return reader, writer, row

        reader, writer, row = await snapshot()
        previous_session = row['session']
        try:
            with patch.object(manager.status, 'set_state', side_effect=observe):
                for cycle in range(4):
                    if cycle == 0:
                        closing, release = asyncio.Event(), asyncio.Event()
                        self.addCleanup(release.set)
                        close_writer = conversation.close_writer

                        async def held_close(writer):
                            closing.set()
                            await release.wait()
                            await close_writer(writer)

                        with patch.object(conversation, 'close_writer', side_effect=held_close):
                            self.assertEqual(await service.toggle(), 'starting')
                            await asyncio.wait_for(closing.wait(), 5)
                            incoming, incoming_writer = await asyncio.open_unix_connection(conversation.address())
                            try:
                                self.assertEqual(manager.conversation.session, previous_session)
                                self.assertEqual(handle.sessions, [])
                                self.assertEqual(await asyncio.wait_for(incoming.read(1), 1), b'',
                                                 'Readers arriving during reset must receive clean EOF')
                            finally:
                                release.set()
                                await close_writer(incoming_writer)
                            transport = await asyncio.wait_for(service.started.get(), 5)
                    else:
                        self.assertEqual(await service.toggle(), 'starting')
                        transport = await asyncio.wait_for(service.started.get(), 5)
                    async with asyncio.timeout(1):
                        while line := await reader.readline():
                            conversation.validate_record(line, previous_session)
                    self.assertTrue(reader.at_eof(), 'A new UUID disconnects the old reader first')
                    await conversation.close_writer(writer)
                    reader, writer, row = await snapshot()
                    self.assertNotEqual(row['session'], previous_session)
                    previous_session = row['session']
                    self.assertEqual(row['turns'], [])
                    self.assertIsNone(transport.llm.last_spoken_reply)
                    self.assertTrue(all(transport.stt is not old for old in processors))
                    processors.append(transport.stt)
                    self.assertEqual(len(manager.status._owners), 2)
                    identities.append(manager.capture_owner)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'repeat that')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                    self.assertTrue(committed.empty())
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, f'Cycle {cycle}.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), f'Reply {cycle}.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), f'Reply {cycle}.')
                    self.assertEqual(await service.toggle(), 'inactive')
                    self.assertEqual(manager.conversation.turns, [])
                    cleanup = await asyncio.wait_for(asyncio.shield(transport.cleanup_finished), 5)
                    await asyncio.wait_for(asyncio.shield(cleanup), 5)
                    self.assertEqual(service.manager.status._state, 'inactive')
                    self.assertTrue(transport.capture.reaped.is_set())
                    self.assertIsNone(transport.playback)
                    self.assertTrue(all(child.reaped.is_set() for child in transport.audio_children))
                    self.assertEqual(manager.status._owners, [{'pid': 70001, 'start_time': 71001}])
                    self.assertFalse(manager.status._failed)
                    self.assertEqual(sentinel.read_bytes(), b'pre-existing private trace')
            self.assertEqual(len(handle.sessions), 4)
            self.assertEqual(len({identity['pid'] for identity in identities}), 4)
            self.assertNotIn('released', states)
            self.assertEqual(len(processes), 1, 'The same native Hermes worker stays warm')
            self.assertEqual([[message for message in request[2]['messages'] if message['role'] != 'system']
                              for request in brain.requests[1:]],
                             [[{'role': 'user', 'content': f'Cycle {cycle}.'}] for cycle in range(4)])
            private_traces = list(traces.glob('session-*/events.jsonl'))
            self.assertTrue(private_traces)
            for trace in private_traces:
                self.assertEqual(trace.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('private stale capture', trace.read_text())
        finally:
            await conversation.close_writer(writer)
            await close()
        self.assertEqual(sentinel.read_bytes(), b'pre-existing private trace')
        self.assertTrue(all(trace.exists() for trace in private_traces))

    async def test_cancelled_session_detaches_native_reply(self):
        blocked, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def old_reply():
            blocked.set()
            if not release.wait(45):
                raise AssertionError('Synthetic native reply was never released')
            yield {'content': '[delivery:neutral]\nOld unheard reply.'}, None
            yield {}, 'stop'
            finished.set()

        brain = ScriptedBrain([
            old_reply(),
            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        allowed = True
        old, spoken, committed, interrupted, processes, close_old = await self.open_session(
            brain, admitted=lambda: allowed,
        )
        channel = old.llm.channel
        self.addCleanup(release.set)
        await old.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        interrupted.clear()
        await self.finish_user_turn(old, 'Old request.')
        self.assertTrue(await asyncio.to_thread(blocked.wait, 5))
        native_reader = channel.reader
        stale_output = old.llm.output
        self.assertIsNotNone(stale_output)
        self.assertFalse(native_reader.done())

        queued_entered = asyncio.Event()
        queued_output = asyncio.Queue()
        queued_allowed = True

        async def queued_exchange():
            queued_entered.set()
            await channel.exchange(
                [{'role': 'user', 'content': 'Revoked request.'}], queued_output,
                admitted=lambda: queued_allowed,
            )

        queued = asyncio.create_task(queued_exchange())
        async def close_queued():
            queued.cancel()
            await asyncio.gather(queued, return_exceptions=True)

        self.addAsyncCleanup(close_queued)
        await asyncio.wait_for(queued_entered.wait(), 5)
        queued_allowed = False
        allowed = False
        old.llm.revoke()
        self.assertIsNone(channel.output, 'Revocation synchronously detaches the native sink')
        await old.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await asyncio.wait_for(interrupted.wait(), 5)
        self.assertIs(channel.reader, native_reader)
        self.assertFalse(native_reader.done(), 'Cancelling speech must retain the native response reader')
        release.set()
        await asyncio.wait_for(channel.drain(), 5)
        await asyncio.wait_for(queued, 5)
        self.assertIsNone(await asyncio.wait_for(queued_output.get(), 5))
        self.assertEqual(len(brain.requests), 1, 'Revoked queued work never reaches the provider')
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        self.assertTrue(stale_output.empty(), 'Native completion cannot append to the detached sink')
        self.assertIsNone(old.llm.last_spoken_reply)

        fresh, new_spoken, new_committed, _, _, close_fresh = await self.open_session(
            brain, channel=channel, local_actions=old.llm.local_actions,
        )
        try:
            await fresh.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(fresh, 'Fresh request.')
            self.assertEqual((await asyncio.wait_for(new_spoken.get(), 5)).strip(), 'Fresh reply.')
            self.assertEqual(await asyncio.wait_for(new_committed.get(), 5), 'Fresh reply.')
            self.assertTrue(spoken.empty())
            self.assertTrue(committed.empty())
            self.assertEqual(len(brain.requests), 2)
            caller = [message for message in brain.requests[-1][2]['messages'] if message['role'] != 'system']
            self.assertEqual(caller, [{'role': 'user', 'content': 'Fresh request.'}])
        finally:
            await close_fresh()
            await close_old()
        self.assertIsNotNone(processes[0][0].returncode)
        self.assertFalse(processes[0][1].exists())

    async def test_panel_reveals_chunk_on_first_successful_output(self):
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

        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
            transport, _, _, interrupted, _, close = await self.open_session(
                brain, through_service=True, synthesis_chunks=chunks,
            )
            output = transport.output()
            write = output.write_audio_frame
            delivered, second_write, future_write, ended = (asyncio.Event() for _ in range(4))
            written, texts = [], []
            current_context = None
            fail_output = False

            @output.event_handler('on_after_push_frame')
            async def observe(processor, frame):
                nonlocal current_context
                if isinstance(frame, TTSStartedFrame):
                    current_context = frame.conversation_audio_context
                elif isinstance(frame, TTSAudioRawFrame) and frame.audio:
                    delivered.set()
                elif isinstance(frame, TTSTextFrame):
                    texts.append(frame.text)
                elif isinstance(frame, LLMFullResponseEndFrame):
                    ended.set()

            async def controlled_write(frame):
                if fail_output:
                    current_context.write_failed = True
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
            address = '\0kestrel.conversation.' + str(os.getuid()) + '.' + hashlib.sha256(runtime.encode()).hexdigest()

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
        loop = asyncio.get_running_loop()
        release_failure, release_provider = threading.Event(), threading.Event()
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
        retirement.start()
        self.addCleanup(retirement.stop)

        def recreated():
            yield {'content': '[delivery:neutral]\nSpoken first. Failed recreated'}, None
            loop.call_soon_threadsafe(provider_paused.set)
            if not release_provider.wait(45):
                raise AssertionError('Synthetic provider context was never released')
            yield {'content': ' context.'}, None
            yield {}, 'stop'

        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nSpoken first. Unheard second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nSpoken first. Failed before audio.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBoundary first. Failed after audio. B'}, None),
             ({'content': 'oundary second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBoundary first. Failed after audio. U'}, None),
             ({'content': 'nheard second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBoundary first. Failed after audio. U'}, None),
             ({'content': 'nheard second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nSpoken first. Failed after stop.'}, None), ({}, 'stop')],
            recreated(),
            [({'content': '[delivery:neutral]\nBoundary first. Boundary second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nBoundary first. Boundary second.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nClean later.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)

        def finite_chunks(**kwargs):
            if kwargs['text'] in ('Failed before audio.', 'Failed recreated context.'):
                raise RuntimeError('Synthetic synthesis failure before audio')
            if kwargs['text'] == 'Failed after stop.':
                if not release_failure.wait(45):
                    raise AssertionError('Synthetic delayed failure was never released')
                raise RuntimeError('Synthetic synthesis failure after native stop')
            if kwargs['text'] == 'Failed after audio.':
                yield np.full(2340, 0.25, dtype=np.float32)
                raise RuntimeError('Synthetic synthesis failure after partial audio')
            if kwargs['text'] != 'Unheard second.':
                value = 0.25 if kwargs['text'] == 'Boundary second.' else 0.5
                yield np.full(5760 if kwargs['text'] == 'Spoken first.' else 1500, value, dtype=np.float32)

        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
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
            address = '\0kestrel.conversation.' + str(os.getuid()) + '.' + hashlib.sha256(runtime.encode()).hexdigest()
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(address), 1)

            async def rows_until(predicate):
                async with asyncio.timeout(5):
                    while True:
                        snapshot = json.loads(await reader.readline())
                        if 'turns' in snapshot:
                            for turn in snapshot['turns']:
                                if turn['speaker'] == 'kestrel':
                                    self.assertNotIn('Unheard second.', turn['text'])
                            if predicate(snapshot['turns']):
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
                await start('Mixed synthesis.')
                rows = await rows_until(lambda rows: rows and rows[-1]['speaker'] == 'kestrel'
                                        and rows[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(rows[-1]['text'], 'Spoken first.')
                self.assertEqual(rows[-1]['state'], 'failed')
                self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                stale_text = text_frames[0]

                written.clear()
                await start('Failure before synthesis audio.')
                rows = await rows_until(lambda rows: rows[-2]['text'] == 'Failure before synthesis audio.'
                                        and rows[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)
                stale_failure = synthesis_failures[-1]

                written.clear()
                final_write.clear()
                release_write.clear()
                hold_final = True
                await start('Audible segment after synthesis failure.')
                await asyncio.wait_for(final_write.wait(), 5)
                rows = await rows_until(lambda rows: rows[-2]['text'] == 'Audible segment after synthesis failure.'
                                        and rows[-1]['text'].startswith('Boundary first.'))
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio.', 'state': 'speaking'})
                self.assertEqual(written, [b'\xff\x3f' * 1500 + b'\xff\x1f' * 420])
                release_write.set()
                rows = await rows_until(lambda rows: rows[-2]['text'] == 'Audible segment after synthesis failure.'
                                        and rows[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio. Boundary second.', 'state': 'failed'})
                self.assertEqual(b''.join(written), b'\xff\x3f' * 1500 + b'\xff\x1f' * 3840 + bytes(840))

                for interrupt in (False, True):
                    with self.subTest(exception_interrupted=interrupt):
                        written.clear()
                        output.generation_done.clear()
                        final_write.clear()
                        release_write.clear()
                        hold_final = True
                        prompt = 'Interrupted synthesis failure.' if interrupt else 'Partial synthesis failure.'
                        await start(prompt)
                        await asyncio.wait_for(final_write.wait(), 5)
                        rows = await rows_until(lambda rows: rows[-2]['text'] == prompt
                                                and rows[-1]['text'].startswith('Boundary first.'))
                        self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio.', 'state': 'speaking'})
                        self.assertEqual(written, [b'\xff\x3f' * 1500 + b'\xff\x1f' * 420])
                        await asyncio.wait_for(output.generation_done.wait(), 5)
                        if interrupt:
                            interrupted.clear()
                            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                            await asyncio.wait_for(interrupted.wait(), 5)
                            rows = await rows_until(lambda rows: rows[-1]['state'] == 'interrupted')
                            self.assertEqual(rows[-1]['text'], 'Boundary first. Failed after audio.')
                            self.assertEqual(len(written), 1)
                        else:
                            release_write.set()
                            rows = await rows_until(lambda rows: rows[-1]['state'] in ('complete', 'failed'))
                            self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Boundary first. Failed after audio.', 'state': 'failed'})
                            self.assertEqual(b''.join(written), b'\xff\x3f' * 1500 + b'\xff\x1f' * 2340)

                hold_final = False
                release_write.set()
                written.clear()
                started_contexts.clear()
                stopped_contexts.clear()
                context_started.clear()
                context_stopped.clear()
                await self.finish_user_turn(transport, 'Delayed synthesis failure.')
                await asyncio.wait_for(context_started.wait(), 5)
                await matching_context(context_stopped, stopped_contexts, started_contexts[0])
                release_failure.set()
                rows = await rows_until(lambda rows: rows[-2]['text'] == 'Delayed synthesis failure.'
                                        and rows[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)

                written.clear()
                started_contexts.clear()
                stopped_contexts.clear()
                retired_contexts.clear()
                context_started.clear()
                context_stopped.clear()
                context_retired.clear()
                await start('Recreated synthesis context failure.')
                await asyncio.wait_for(provider_paused.wait(), 5)
                await asyncio.wait_for(context_started.wait(), 5)
                first_context = started_contexts[0]
                await matching_context(context_stopped, stopped_contexts, first_context)
                await matching_context(context_retired, retired_contexts, first_context)
                release_provider.set()
                rows = await rows_until(lambda rows: rows[-2]['text'] == 'Recreated synthesis context failure.'
                                        and rows[-1]['state'] in ('complete', 'failed'))
                self.assertEqual(started_contexts, [first_context, first_context])
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': 'Spoken first.', 'state': 'failed'})
                self.assertEqual(b''.join(written), b'\xff\x3f' * 5760)

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
            finally:
                release_failure.set()
                release_provider.set()
                release_write.set()
                writer.close()
                await writer.wait_closed()
                await close()

    async def test_panel_receives_final_turns_and_spoken_prefix(self):
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

        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
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
                    output_order.append(('end', frame.indicator_reply_token))
                    if cancel_without_audio:
                        old_end_output.set()
                elif isinstance(frame, InterruptionFrame):
                    output_order.append(('interruption', getattr(frame, 'conversation_reply_token', None)))

            @transport.llm.event_handler('on_before_push_frame')
            async def generated_text(processor, frame):
                if cancel_without_audio and isinstance(frame, InterruptionFrame) and frame.conversation_reply_token is not None:
                    await asyncio.wait_for(old_end_output.wait(), 5)
                if hold_text and isinstance(frame, LLMTextFrame):
                    generated.set()
                    await release_text.wait()

            async def start():
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)

            async def barrier():
                frame = DataFrame()
                await transport.input().queue_frame(frame)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), frame)

            await start()
            await self.finish_user_turn(transport, 'Hello Kestrel.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Hello.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Hello.')
            delivered = []
            address = '\0kestrel.conversation.' + str(os.getuid()) + '.' + hashlib.sha256(runtime.encode()).hexdigest()
            reader = writer = None
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

            try:
                self.assertEqual(delivered, [
                    {'speaker': 'you', 'text': 'Hello Kestrel.', 'state': 'complete'},
                    {'speaker': 'kestrel', 'text': 'Hello.', 'state': 'complete'},
                ])
                for utterance in ('repeat that', 'what can I say?'):
                    await start()
                    await self.finish_user_turn(transport, utterance)
                    expected = ('Hello.' if utterance == 'repeat that' else
                                "You can say: mute; set the volume to thirty; pause music; next track; "
                                "workspace three; open followed by an installed app's exact name; take a screenshot. "
                                "None of these tools needs permission first.")
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                    rows = await turns_until(lambda turns: turns[-2]['text'] == utterance and turns[-1]['state'] == 'complete')
                    self.assertEqual(rows[-2:], [
                        {'speaker': 'you', 'text': utterance, 'state': 'complete'},
                        {'speaker': 'kestrel', 'text': expected, 'state': 'complete'},
                    ])
                    self.assertTrue(committed.empty(), 'Local spoken responses never enter engine history')
                output.write_gate.clear()
                playback_started.clear()
                await start()
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
                old_token = transport.llm._conversation_attempt
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
                    token = transport.llm._conversation_attempt
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
                    self.assertIsNone(transport.llm._conversation_attempt)
                    # A delayed native end cannot change a terminal row or a newer attempt.
                    late = LLMFullResponseEndFrame()
                    late.indicator_reply_token = token
                    late.conversation_reply_failed = False
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
                rows = await turns_until(lambda turns: turns[-1]['text'] == 'mute')
                self.assertEqual(len(rows), count_before_mute + 1, 'A silent tool creates only the finalized user row')
                self.assertEqual(rows[-1], {'speaker': 'you', 'text': 'mute', 'state': 'complete'})
                self.assertTrue(spoken.empty())
                self.assertEqual(len(brain.requests), 5, 'Silent controls make no engine request')
                await start()
                await self.finish_user_turn(transport, 'Brain failure turn')
                expected_failure = "I couldn't get a complete reply from the brain. Restart Kestrel and try again."
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I couldn't get a complete reply from the brain.")
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Restart Kestrel and try again.')
                rows = await turns_until(lambda turns: turns[-1]['state'] == 'failed')
                self.assertEqual(rows[-1], {'speaker': 'kestrel', 'text': expected_failure, 'state': 'failed'})
                late = LLMFullResponseEndFrame()
                late.indicator_reply_token = old_token
                late.conversation_reply_failed = False
                await output.push_frame(late)
                await barrier()
                self.assertNotIn('Unheard', json.dumps(rows))
                status = json.loads((Path(runtime) / 'kestrel/indicator.json').read_text())
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

                expected_help = (
                    "You can say: mute; set the volume to thirty; pause music; next track; "
                    "workspace three; open followed by an installed app's exact name; take a screenshot. "
                    "None of these tools needs permission first."
                )
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

                with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, XDG_RUNTIME_DIR=runtime):
                    transport, spoken, committed, interrupted, _, close = await self.open_session(
                        preparation, through_service=True, synthesis_chunks=no_audio,
                    )
                    endpoint = '\0kestrel.conversation.' + str(os.getuid()) + '.' + hashlib.sha256(runtime.encode()).hexdigest()
                    reader, writer = await asyncio.open_unix_connection(endpoint)
                    try:
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
                            {'speaker': 'you', 'text': 'what can I say?', 'state': 'complete'},
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
                            await service.state('trouble')
                            self.assertEqual(manager.failure, 'Voice generation cleanup failed. Restart Kestrel.')
                            self.assertTrue(manager.cleanup.done())
                            self.assertFalse(manager.admission.is_set())
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
                                    self.assertEqual(snapshot['state'], 'trouble' if failing else 'idle',
                                                     'A failed native voice cannot appear ready after a local turn')
                                    self.assertEqual(output_events, [], 'No audio means no native speaking event')
                                    self.assertTrue(committed.empty())
                                    self.assertEqual(contexts[-1], [], 'Local speech stays outside brain history')
                                    self.assertEqual(len(attempts), 1 if failing else index + 1)
                                    if failing:
                                        if index == 0:
                                            first_fault = next((position for position, transition in enumerate(transitions)
                                                                if transition == ('trouble', True)), None)
                                            self.assertIsNotNone(first_fault, 'Native voice failure must publish trouble')
                                        if first_fault is not None:
                                            self.assertTrue(all(state == 'trouble'
                                                                for state, _ in transitions[first_fault:]), transitions)
                            self.assertEqual(len(attempts), 1 if failing else 2)
                            self.assertEqual(brain.requests, [])
                            command.assert_not_awaited()
                    finally:
                        if voice.generation_cleanup_failed:
                            self.assertEqual(await service.toggle(), 'inactive')
                            await service.state('trouble')
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
                    while not changes.empty():
                        changes.get_nowait()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await state('listening')

                async def barrier():
                    frame = DataFrame()
                    await transport.input().queue_frame(frame)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), frame)

                try:
                    await state('idle')
                    output.write_gate.clear()
                    await start()
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
                        output.write_gate.clear()
                        await start()
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
                transport, spoken, _, _, _, close = await self.open_session(brain, status=status)
                output = transport.output()
                try:
                    await state('idle')
                    output.write_gate.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await state('listening')
                    await self.finish_user_turn(transport, 'PRIVATE transcript sentinel')
                    await state('speaking')
                    await asyncio.wait_for(output.generation_done.wait(), 5)
                    self.assertEqual(current(), 'speaking', 'Failure advisory uses real output events')
                    output.write_gate.set()
                    await state('trouble')
                    self.assertIn("couldn't get a complete reply", await asyncio.wait_for(spoken.get(), 5))
                    for phrase in ('repeat that', 'what can i say'):
                        while not changes.empty():
                            changes.get_nowait()
                        output.write_gate.clear()
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await state('listening')
                        await self.finish_user_turn(transport, phrase)
                        await state('speaking')
                        output.write_gate.set()
                        await state('trouble')
                    for phrase in ('stop', 'cancel', 'mute'):
                        while not changes.empty():
                            changes.get_nowait()
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await state('listening')
                        if phrase == 'mute':
                            transport.llm.local_actions.command = AsyncMock(side_effect=[
                                'fixture-output', 'fixture-output', 'Mute: yes',
                                'fixture-output', 'fixture-output', 'Mute: yes',
                            ])
                        await self.finish_user_turn(transport, phrase)
                        barrier = DataFrame()
                        await transport.input().queue_frame(barrier)
                        self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                        self.assertEqual(current(), 'trouble', 'Engine trouble survives local turns')
                    self.assertEqual(len(brain.requests), 1)
                    self.assertFalse(transport.llm.local_actions.tasks)
                finally:
                    output.write_gate.set()
                    await close()

    async def test_open_app_routes_unknown_without_losing_context(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\nPrior reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nUnknown reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nUnexpected brain dispatch.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        calls = []

        async def command(argv, *, stdin_data=None):
            calls.append(argv)
            if argv[0] == '/usr/bin/env':
                self.assertIn(stdin_data, (b'UnknownApp', b'FixtureApp'))
                return 'null' if stdin_data == b'UnknownApp' else '"fixture.desktop"'
            self.assertIsNone(stdin_data)
            return ''

        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            for text, reply in (('Tell me something.', 'Prior reply.'), ('OPEN UnknownApp!', 'Unknown reply.')):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, text)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), reply)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), reply)
            self.assertEqual([m for m in brain.requests[-1][2]['messages'] if m['role'] != 'system'], [
                {'role': 'user', 'content': 'Tell me something.'},
                {'role': 'assistant', 'content': 'Prior reply.'},
                {'role': 'user', 'content': 'OPEN UnknownApp!'},
            ])
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Open FixtureApp.')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(len(brain.requests), 2, 'A known installed app must stay local')
            self.assertEqual([a[0] for a in calls], ['/usr/bin/env', '/usr/bin/env', '/usr/bin/uwsm-app'])
            self.assertEqual(calls[-1][-1], 'fixture.desktop')
            self.assertTrue(spoken.empty(), 'Accepted dispatch does not claim a visible window')
            self.assertTrue(committed.empty())
        finally:
            await close()
        calls.clear()
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, close = await self.open_session(None, local_command=command)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'open FixtureApp')
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertEqual([a[0] for a in calls], ['/usr/bin/env', '/usr/bin/uwsm-app'])
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                self.assertIsNone(processes[0][0])
            finally:
                await close()

    async def test_open_app_attempt_is_owned_and_never_retried(self):
        launch_failure = "I couldn't confirm the app opened. Check the desktop. I won't retry."
        lookup_failure = "I couldn't check the installed apps. I didn't send an open request. Use the app menu."
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        calls = []

        async def failing(argv, *, stdin_data=None):
            calls.append(argv)
            if stdin_data == b'Unavailable':
                raise RuntimeError('PRIVATE lookup failure')
            if stdin_data == b'Corrupt':
                return '{}'
            if argv[0] == '/usr/bin/env':
                self.assertEqual(stdin_data, b'FixtureApp')
                return '"fixture.desktop"'
            self.assertIsNone(stdin_data)
            raise RuntimeError('PRIVATE launch failure')

        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=failing)
        try:
            for phrase, expected in (('open Unavailable', lookup_failure), ('open Corrupt', lookup_failure),
                                     ('open FixtureApp', launch_failure), ('repeat that', launch_failure)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, phrase)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(committed.empty(), 'Local advisories do not enter brain history')
                self.assertEqual(brain.requests, [])
            self.assertEqual([a[0] for a in calls], ['/usr/bin/env'] * 3 + ['/usr/bin/uwsm-app'])
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'A fresh question.')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Fresh reply.')
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Fresh reply.')
            self.assertEqual(len(brain.requests), 1)
            self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'],
                             [{'role': 'user', 'content': 'A fresh question.'}])
            self.assertEqual(len(calls), 4, 'Brain fallback and repeat never retry a failed launch')
            self.assertFalse(transport.llm.local_actions.tasks)
        finally:
            await close()

        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
            calls, owners = [], []

            async def blocked(argv, *, stdin_data=None):
                calls.append(argv)
                if argv[0] == '/usr/bin/env':
                    self.assertEqual(stdin_data, b'FixtureApp')
                    return '"fixture.desktop"'
                self.assertIsNone(stdin_data)
                owners.append(asyncio.current_task())
                if len(owners) == 1:
                    entered.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        cancelled.set()
                        raise
                    raise RuntimeError('unconfirmed')
                return ''

            transport, spoken, committed, interrupted, _, close = await self.open_session(None, local_command=blocked)
            native_run = transport.llm.local_actions._run
            queued, actions = asyncio.Event(), []

            async def observe(tool, *, admitted):
                actions.append(asyncio.current_task())
                if len(actions) == 2:
                    queued.set()
                return await native_run(tool, admitted=admitted)

            try:
                with patch.object(transport.llm.local_actions, '_run', observe):
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'open FixtureApp')
                    await asyncio.wait_for(entered.wait(), 5)
                    interrupted.clear()
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await asyncio.wait_for(interrupted.wait(), 5)
                    self.assertFalse(cancelled.is_set(), 'Speech interruption retains an attempted launch')
                    await self.finish_user_turn(transport, 'open FixtureApp')
                    await asyncio.wait_for(queued.wait(), 5)
                    self.assertEqual(len(owners), 1, 'The next explicit request waits for the older action')
                    release.set()
                    await asyncio.wait_for(asyncio.gather(*actions), 5)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertTrue(spoken.empty(), 'Interrupted failure cannot queue stale speech')
                    self.assertTrue(committed.empty())
                    self.assertEqual([a[0] for a in calls],
                                     ['/usr/bin/env', '/usr/bin/uwsm-app', '/usr/bin/env', '/usr/bin/uwsm-app'])
                    self.assertEqual(owners, actions)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'repeat that')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
                    self.assertEqual(len(calls), 4)
                    self.assertFalse(transport.llm.local_actions.tasks)
            finally:
                release.set()
                await close()

            for stage in ('lookup', 'launch'):
                with self.subTest(cancelled_stage=stage):
                    entered, cancelled, cleanup_release, cleaned = (
                        asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event(),
                    )
                    calls, owners = [], []

                    async def hanging(argv, *, stdin_data=None):
                        calls.append(argv)
                        self.assertEqual(stdin_data, b'FixtureApp' if argv[0] == '/usr/bin/env' else None)
                        if stage == 'launch' and argv[0] == '/usr/bin/env':
                            return '"fixture.desktop"'
                        owners.append(asyncio.current_task())
                        entered.set()
                        try:
                            await asyncio.Event().wait()
                        except asyncio.CancelledError:
                            cancelled.set()
                            await cleanup_release.wait()
                            cleaned.set()
                            raise

                    following_brain = None
                    if stage == 'lookup':
                        following_brain = ScriptedBrain([[({'content': '[delivery:neutral]\nAfter cancellation.'}, None), ({}, 'stop')]])
                        self.addCleanup(following_brain.close)
                    with patch.object(bot, 'HERMES_PYTHON', NATIVE_PYTHON if stage == 'lookup'
                                      else Path('/nonexistent-kestrel-hermes/python')):
                        transport, spoken, committed, interrupted, _, close = await self.open_session(
                            following_brain, local_command=hanging,
                        )
                    closing = None
                    try:
                        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                        await self.finish_user_turn(transport, 'open FixtureApp')
                        await asyncio.wait_for(entered.wait(), 5)
                        self.assertIn(owners[0], transport.llm.local_actions.tasks)
                        if stage == 'lookup':
                            interrupted.clear()
                            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                            await asyncio.wait_for(cancelled.wait(), 5)
                        else:
                            closing = asyncio.create_task(close())
                            await asyncio.wait_for(cancelled.wait(), 5)
                            self.assertFalse(closing.done(), 'Shutdown joins attempted-command cleanup')
                        self.assertFalse(owners[0].done(), 'Ownership continues until cleanup finishes')
                        cleanup_release.set()
                        await asyncio.gather(*owners, return_exceptions=True)
                        self.assertTrue(cleaned.is_set())
                        if closing is not None:
                            await asyncio.wait_for(closing, 5)
                        else:
                            await asyncio.wait_for(interrupted.wait(), 5)
                            await self.finish_user_turn(transport, 'After canceled lookup.')
                            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'After cancellation.')
                            self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'After cancellation.')
                            barrier = DataFrame()
                            await transport.input().queue_frame(barrier)
                            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                            self.assertEqual(len(following_brain.requests), 1)
                            self.assertEqual([m for m in following_brain.requests[0][2]['messages']
                                              if m['role'] != 'system'],
                                             [{'role': 'user', 'content': 'After canceled lookup.'}],
                                             'A canceled app lookup must not enter the next brain request')
                        self.assertTrue(owners[0].cancelled())
                        self.assertFalse(transport.llm.local_actions.tasks)
                        self.assertEqual([a[0] for a in calls],
                                         ['/usr/bin/env'] + (['/usr/bin/uwsm-app'] if stage == 'launch' else []))
                        self.assertTrue(spoken.empty())
                        self.assertTrue(committed.empty())
                    finally:
                        cleanup_release.set()
                        if closing is not None:
                            await asyncio.gather(closing, return_exceptions=True)
                        await close()

    async def test_stop_cancel_discard_reply_without_brain_request(self):
        cases = [(word, heard, threading.Event(), threading.Event(), threading.Event())
                 for word in ('stop', 'cancel') for heard in (False, True)]
        def held_reply(heard, blocked, release, finished):
            yield {'content': '[delivery:neutral]\n' + ('Heard prefix. Unheard fragment' if heard else 'Unheard fragment')}, None
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
                            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')]])
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
                    reader = transport.llm.channel.reader
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
                    self.assertIs(transport.llm.channel.reader, reader)
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
            self.assertFalse(transport.llm.local_actions.tasks)
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

    async def test_screenshot_turn_stays_local_without_content(self):
        clock = patch.object(time, 'time_ns', return_value=2_000_000_000_000_000_000)
        clock.start()
        self.addCleanup(clock.stop)
        replies = ('Longer request remains conversation.', 'Question remains conversation.',
                   'Negation remains conversation.', 'Newline remains conversation.')
        ordinary = ('take a screenshot please', 'take a screenshot?', 'do not take a screenshot',
                    'take a\nscreenshot')
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\n' + text}, None), ({}, 'stop')] for text in replies])
        self.addCleanup(brain.close)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / 'screenshot-2026-10-18_12-34-56.png'
        path.write_bytes(b'PRIVATE screenshot content must never be opened')
        os.utime(path, ns=(2_000_000_000_000_000_000, 2_000_000_000_000_000_000))
        argv = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')
        advisory = "I couldn't confirm the screenshot. Check your screenshot folder. I won't retry."
        command = AsyncMock(side_effect=[str(path) + '\n', 'PRIVATE native output'])
        logs = []
        sink = logger.add(lambda message: logs.append(str(message)))
        self.addCleanup(logger.remove, sink)
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            for phrase, expected in ((' TAKE A SCREENSHOT! ', None), ('take a screenshot', advisory)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, phrase)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                if expected:
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty(), 'Screenshot advice must not enter conversation history')
                self.assertEqual(brain.requests, [])
                self.assertFalse(transport.llm.local_actions.tasks)
            self.assertEqual(command.await_args_list, [call(argv), call(argv)])
            for index, (text, reply) in enumerate(zip(ordinary, replies)):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                if index == 0:
                    await transport.input().queue_frame(
                        TranscriptionFrame('take a screenshot', '', '2026-01-01T00:00:00Z', finalized=True))
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertEqual(command.await_count, 2, 'A segment cannot dispatch before a complete turn')
                    self.assertEqual(brain.requests, [])
                    await self.finish_user_turn(transport, 'please')
                else:
                    await self.finish_user_turn(transport, text)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), reply)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), reply)
                self.assertEqual(len(brain.requests), index + 1)
                users = [m for m in brain.requests[index][2]['messages'] if m['role'] == 'user']
                self.assertEqual(users, [{'role': 'user', 'content': t} for t in ordinary[:index + 1]])
                history = json.dumps(brain.requests[index][2])
                self.assertNotIn(advisory, history)
                self.assertNotIn(str(path), history)
                self.assertNotIn('PRIVATE', history)
                self.assertEqual(command.await_count, 2, 'Screenshot failure and nonmatches never retry')
        finally:
            await close()
        # A newer local turn leaves the native save owned, while suppressing its stale failure speech.
        started, release = asyncio.Event(), asyncio.Event()
        calls, pending = [], []
        async def blocked(argv):
            calls.append(argv)
            if len(calls) == 1:
                pending.append(asyncio.current_task())
                started.set()
                await release.wait()
                return 'PRIVATE native output'
            return str(path)
        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, interrupted, processes, close = await self.open_session(None, local_command=blocked)
            try:
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'take a screenshot')
                await asyncio.wait_for(started.wait(), 5)
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertFalse(pending[0].done())
                release.set()
                await asyncio.wait_for(pending[0], 5)
                await self.finish_user_turn(transport, 'take a screenshot.')
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertEqual(calls, [argv, argv])
                self.assertTrue(spoken.empty(), 'Stale failure and confirmed save stay silent without an engine')
                self.assertTrue(committed.empty())
                self.assertFalse(transport.llm.local_actions.tasks)
                self.assertEqual(len(processes), 1)
                self.assertIsNone(processes[0][0])
            finally:
                release.set()
                await close()
        self.assertNotIn(str(path), ''.join(logs))
        self.assertNotIn('PRIVATE', ''.join(logs))

    async def test_workspace_turn_is_local_and_nonmatches_reach_brain(self):
        replies = ('Longer phrase remains conversation.', 'Invalid number remains conversation.',
                   'Command text remains conversation.')
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\n' + text}, None), ({}, 'stop')] for text in replies])
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
                self.assertFalse(transport.llm.local_actions.tasks)
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
                self.assertFalse(transport.llm.local_actions.tasks)
            finally:
                await close()

    async def test_media_turns_are_local_and_owned(self):
        no_player = "I couldn't find a playing media player."
        failed_next = "I couldn't confirm next track. Check the media player. I won't retry."
        status = ('/usr/bin/omarchy-shell', 'media', 'status')
        pause = ('/usr/bin/omarchy-shell', 'media', 'pause')
        advance = ('/usr/bin/omarchy-shell', 'media', 'next')
        media = LocalDesktopTests.media
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nOrdinary follow-up.'}, None), ({}, 'stop')]])
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
            self.assertFalse(transport.llm.local_actions.tasks)
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
            native_run = transport.llm.local_actions._run
            async def observe(tool, *, admitted):
                actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'next track':
                    queued.set()
                return await native_run(tool, admitted=admitted)
            with patch.object(transport.llm.local_actions, '_run', observe):
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
                    self.assertFalse(transport.llm.local_actions.tasks)
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
            native_run = transport.llm.local_actions._run
            closing = None
            with patch.object(transport.llm.local_actions, '_run', observe):
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
                    self.assertFalse(transport.llm.local_actions.tasks)
                    self.assertEqual(calls, [status, pause], 'Shutdown starts no queued effect or readback')
                finally:
                    release_cleanup.set()
                    if closing is not None:
                        await asyncio.gather(closing, return_exceptions=True)
                    await close()

    async def test_volume_bypasses_pending_brain_and_history(self):
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('KESTREL_MANAGED_BRAIN', None)
        status_patch = patch.object(bot, 'run_local_command', AsyncMock())
        status = status_patch.start()
        self.addCleanup(status_patch.stop)
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
            'selected', 'physical', LocalVolumeTests.volume(32768), 'Mute: yes', '',
            LocalVolumeTests.volume(19660), '', 'selected', 'physical', LocalVolumeTests.volume(19660), 'Mute: no',
        ])
        transport, spoken, committed, _, processes, close = await self.open_session(
            brain, local_command=command, prepare_engine=True,
        )
        preparation = transport.llm.channel.preparation
        session_ready = transport.llm.session_ready
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
            await self.finish_user_turn(transport, 'set the volume to 30')
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertEqual(command.await_count, 11)
            self.assertEqual(command.await_args_list.count(
                call(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')),
            ), 1)
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
                if task is session_ready and asyncio.current_task() is not driver:
                    checkpoint.set()
                return future

            def observe_write(data):
                nonlocal ordinary_writes, pending_writes
                if 'messages' in json.loads(data):
                    ordinary_writes += 1
                    pending_writes += not session_ready.done()
                    checkpoint.set()
                return native_write(data)

            with (
                patch.object(asyncio, 'shield', observe_shield),
                patch.object(worker_input, 'write', observe_write),
            ):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, 'Answer the genuine user turn.')
                await asyncio.wait_for(checkpoint.wait(), 5)
                self.assertEqual(ordinary_writes, 0, 'Ordinary worker request preceded session readiness')
                self.assertFalse(session_ready.done())
                self.assertFalse(preparation.done())
                self.assertFalse(release.is_set())
                self.assertEqual(len(brain.requests), 1)
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())

                release.set()
                await asyncio.wait_for(asyncio.shield(session_ready), 5)
                self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Actual caller reply.')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Actual caller reply.')
                self.assertTrue(spoken.empty())
                self.assertTrue(committed.empty())
                self.assertEqual(len(brain.requests), 2)
                self.assertIn(
                    'Kestrel handles volume <level> percent or %, set volume [to] <level>, and set the volume [to] <level> locally.',
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
        status.assert_not_awaited()

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
                        brain, local_command=command, prepare_engine=True,
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
            self.assertFalse(old.admitted())
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
                        self.assertFalse(revoked.admitted())
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
                    await service.state('trouble')
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
                        await service.state('trouble')
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

    async def test_capability_help_is_spoken_locally_without_history(self):
        expected = ("You can say: mute; set the volume to thirty; pause music; next track; "
                    "workspace three; open followed by an installed app's exact name; take a screenshot. "
                    "None of these tools needs permission first.")
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nOrdinary reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('Help cannot execute desktop actions'))
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        for text in ('what can I say?', 'repeat that'):
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, text)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(committed.empty())
            self.assertEqual(brain.requests, [])
            command.assert_not_awaited()
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'An ordinary question.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary reply.')
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([m for m in brain.requests[0][2]['messages'] if m['role'] != 'system'],
                         [{'role': 'user', 'content': 'An ordinary question.'}])
        command.assert_not_awaited()
        await close()

        with patch.object(bot, 'HERMES_PYTHON', Path('/nonexistent-kestrel-hermes/python')):
            transport, spoken, committed, _, processes, close = await self.open_session(None, local_command=command)
            for text in ('what can I say', 'repeat that'):
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await self.finish_user_turn(transport, text)
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), expected)
                barrier = DataFrame()
                await transport.input().queue_frame(barrier)
                self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                self.assertTrue(committed.empty())
                self.assertEqual(len(brain.requests), 1)
                self.assertEqual(len(processes), 1)
                self.assertIsNone(processes[0][0])
                command.assert_not_awaited()
            await close()

    async def test_repeat_preserves_spoken_reply_without_brain_or_history(self):
        brain = ScriptedBrain([
            [({'content': '[delivery:neutral]\n' + r'Literal \`tick\` stays with ●, ◐ and ○.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nNewer normal reply.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nFresh reply.'}, None), ({}, 'stop')],
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
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nOrdinary reply.'}, None), ({}, 'stop')]])
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
        self.assertEqual({tool['function']['name'] for tool in request['tools']}, {'memory'})
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
            native_run = transport.llm.local_actions._run

            async def observe_action(tool, *, admitted):
                action_tasks[tool.subject] = asyncio.current_task()
                entered[tool.subject].set()
                result = await native_run(tool, admitted=admitted)
                results[tool.subject] = result
                completion_order.append(tool.subject)
                completed_events[tool.subject].set()
                return result

            try:
                with patch.object(transport.llm.local_actions, '_run', observe_action):
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
                    self.assertFalse(transport.llm.local_actions.tasks)
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
                self.assertFalse(transport.llm.local_actions.tasks)
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
            native_run = transport.llm.local_actions._run
            queued_entered = asyncio.Event()
            owned_actions = {}

            async def observe_shutdown_action(tool, *, admitted):
                owned_actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'mute':
                    queued_entered.set()
                return await native_run(tool, admitted=admitted)

            action_observer = patch.object(transport.llm.local_actions, '_run', observe_shutdown_action)
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
                self.assertFalse(transport.llm.local_actions.tasks)
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
            [({'content': '[delivery:neutral]\nInvalid level is conversation.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nLonger phrase is conversation.'}, None), ({}, 'stop')],
            [({'content': '[delivery:neutral]\nNegated request is conversation.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=AssertionError('An invalid or longer turn cannot act'))
        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        for index, segment, tail, expected, reply in (
            (0, 'set the volume to 101', None, 'set the volume to 101', 'Invalid level is conversation.'),
            (1, 'set the volume to thirty percent', 'and tell me a fact.',
             'set the volume to thirty percent and tell me a fact.', 'Longer phrase is conversation.'),
            (2, 'do not set the volume to 30', None,
             'do not set the volume to 30', 'Negated request is conversation.'),
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
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nOrdinary longer reply.'}, None), ({}, 'stop')]])
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
            yield {'content': '[delivery:neutral]\nOne fact. Obsolete continuation'}, None
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
        await asyncio.wait_for(asyncio.shield(transport.llm.channel.preparation or transport.llm.channel.reader), 5)
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
                self.assertFalse(transport.llm.local_actions.tasks)
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
                self.assertFalse(transport.llm.local_actions.tasks)
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
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertIsNotNone(processes[0][0].returncode)
        await self.assert_failed_reply(transport, spoken, committed, 'Try another request.',
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertEqual(len(brain.requests), 1, 'Broken sessions never silently restart or retry')

    async def test_partial_native_reply_speaks_failure(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nIncomplete synthetic reply.'}, None), ({}, 'length')]] * 4)
        self.addCleanup(brain.close)
        transport, spoken, committed, _, processes, _ = await self.open_session(brain)
        context = await self.assert_failed_reply(transport, spoken, committed, 'Answer completely.',
                                         expected_advisory="I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
        self.assertIn('Incomplete synthetic reply.', context)
        self.assertIsNotNone(processes[0][0].returncode)

    async def test_corrupt_worker_response_speaks_failure(self):
        # External process stand-ins cover malformed JSON and wrongly typed terminal events.
        cases = [
            ('malformed JSON', '{"ready":true}', 'not json'),
            ('wrong done type', '{"ready":true}', '{"delivery":"neutral"}\n{"text":"Synthetic prefix."}\n{"done":1}'),
            ('wrong ready type', '{"ready":1}', ''),
        ]
        for name, ready, response in cases:
            with self.subTest(name=name):
                wire = f'import json, sys; print({ready!r}, flush=True); '
                if name != 'wrong ready type':
                    wire += ("assert json.loads(sys.stdin.readline()) == {'begin': True}; "
                             "print('{\"session_ready\":true}', flush=True); ")
                wire += f'sys.stdin.readline(); print({response!r}, flush=True); sys.stdin.read()'
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

        def create_tts(voice, preset, *, generation_lock=None, admitted=lambda: True):
            tts = native_tts(voice, preset, generation_lock=generation_lock, admitted=admitted)
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

                async def capture_exchange(messages, output, *, admitted):
                    worker_requests.append(deepcopy(messages))
                    return await native_exchange(messages, output, admitted=admitted)

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
