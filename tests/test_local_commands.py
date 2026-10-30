import asyncio
from contextlib import nullcontext
from copy import deepcopy
import io
import json
import os
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

from loguru import logger
from pipecat.frames.frames import (
    DataFrame, InputAudioRawFrame, LLMFullResponseEndFrame, InterruptionFrame, LLMContextFrame,
    ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame, TTSAudioRawFrame, TTSStartedFrame,
    TTSStoppedFrame, TTSTextFrame, VADUserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

import bot
from conversation_fixtures import WholeConversationCase, hermes_service, request_frame
import hermes_worker
import reply_progress
import speech
import tool_actions
from test_hermes import NATIVE_PYTHON, ROOT, ScriptedBrain


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
                result = await tool_actions.volume_output(percent, command=command)
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
                result = await tool_actions.volume_output(30, command=command)
                self.assertFalse(result.confirmed)
                self.assertTrue(result.attempted)
                self.assertEqual(command.await_count, 10)
                self.assertEqual(sum(c.args[0][1] == 'set-sink-volume' for c in command.await_args_list), 1)

        for readback in (self.volume(19660, 19661), '{"volume":{"mono":{"value":19660}}}'):
            with self.subTest(unconfirmed_before_unmute=readback):
                command = AsyncMock(side_effect=[
                    'selected', 'physical', self.volume(32768), 'Mute: yes', '', readback,
                ])
                result = await tool_actions.volume_output(30, command=command)
                self.assertEqual(result, tool_actions.AudioResult(False, True, 'readback unconfirmed'))
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
                result = await tool_actions.volume_output(percent, command=command)
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
                result = await tool_actions.volume_output(30, command=command)
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
            result = await tool_actions.volume_output(30, command=AsyncMock(side_effect=outputs))
            self.assertEqual(result, tool_actions.AudioResult(False, True, 'target changed'))

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
                await service.process_frame(request_frame(service, context, speculation=speculative), direction)
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
        frame = request_frame(service, context)
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

                with patch.object(tool_actions, 'VOLUME_TIMEOUT', 0.01):
                    result = await asyncio.wait_for(tool_actions.volume_output(30, command=hung), 5)
                self.assertTrue(started.is_set())
                self.assertTrue(cleaned.is_set())
                self.assertEqual(result, tool_actions.AudioResult(False, True, 'volume timeout'))
                self.assertEqual(len(calls), 5 if effect == 'set-sink-volume' else 7)
                calls.clear()
                started.clear()
                cleaned.clear()
                task = asyncio.create_task(tool_actions.volume_output(30, command=hung))
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
                self.assertEqual(tool.confirmation, f'Volume {percent}.')
                self.assertIsNot(tool, bot.LOCAL_TOOLS['set_volume'])
                command = AsyncMock()
                action = AsyncMock()
                with patch.dict(bot.LOCAL_TOOLS, set_volume=bot.LocalTool(bot.PermissionTier.FREE, action, 'volume', 'set the volume to thirty')):
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
            with patch.dict(bot.LOCAL_TOOLS, set_volume=bot.LocalTool(permission, AsyncMock(), 'volume', 'set the volume to thirty')):
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
        tool = bot.LOCAL_TOOLS['take_screenshot']
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        for text in (phrase, ' TAKE A SCREENSHOT. ', phrase + '!'):
            self.assertIs(bot.match_instant_tool(text), tool)
        for text in (phrase + '?', '"' + phrase + '"', phrase + '!!', 'do not ' + phrase,
                     phrase + ' please', 'take a\nscreenshot', phrase + '; echo bad'):
            self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, {'take_screenshot': bot.LocalTool(permission, AsyncMock(), phrase, phrase)}):
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
                    self.assertEqual(result, tool_actions.DesktopResult(confirmed, True,
                                     'confirmed' if confirmed else 'screenshot unconfirmed',
                                     None if confirmed else advisory))
                    command.assert_awaited_once_with(argv)
            for error, expected_reason in ((RuntimeError('command failed'), 'command failed'),
                                           (OSError('PRIVATE path'), 'screenshot unconfirmed'),
                                           (TimeoutError(), 'screenshot unconfirmed')):
                command = AsyncMock(side_effect=error)
                result = await tool.run(command=command)
                self.assertEqual(result, tool_actions.DesktopResult(False, True, expected_reason, advisory))
                command.assert_awaited_once_with(argv)
            command = AsyncMock(return_value=str(path))
            with patch.object(os, 'lstat', side_effect=PermissionError('PRIVATE path')):
                result = await tool.run(command=command)
            self.assertEqual(result, tool_actions.DesktopResult(False, True, 'screenshot unconfirmed', advisory))
            command = AsyncMock(side_effect=asyncio.CancelledError())
            with self.assertRaises(asyncio.CancelledError):
                await tool.run(command=command)
            command.assert_awaited_once_with(argv)

    async def test_media_actions_require_observed_state(self):
        for key, phrase, action in (('pause_media', 'pause music', 'pause'), ('next_track', 'next track', 'next')):
            self.assertIsNotNone(bot.match_instant_tool(phrase), 'Exact media turns must select local work')
            tool = bot.LOCAL_TOOLS[key]
            self.assertEqual(tool.permission, bot.PermissionTier.FREE)
            for text in (phrase, ' ' + phrase.upper() + '. ', phrase + '!'):
                self.assertIs(bot.match_instant_tool(text), tool)
            for text in (phrase + '?', '"' + phrase + '"', phrase + '!!', 'do not ' + phrase,
                         phrase + ' please', phrase.replace(' ', '\n'), phrase + '; echo bad'):
                self.assertIsNone(bot.match_instant_tool(text))
            for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
                with patch.dict(bot.LOCAL_TOOLS, {key: bot.LocalTool(permission, AsyncMock(), phrase, phrase)}):
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
            frame = request_frame(service, context)
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
                await service.process_frame(request_frame(service, context, speculation=speculative), direction)
                command.assert_not_awaited()
                self.assertEqual(context.get_messages(), messages)
        with self.assertRaises(ValueError):
            await tool_actions.media_action('playPause', command=AsyncMock())
        started, cleaned = asyncio.Event(), asyncio.Event()
        async def hanging(argv):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cleaned.set()
        with patch.object(tool_actions, 'DESKTOP_TIMEOUT', .01):
            result = await tool_actions.media_action('pause', command=hanging)
        self.assertTrue(started.is_set())
        self.assertTrue(cleaned.is_set())
        self.assertFalse(result.confirmed)
        self.assertFalse(result.attempted)
        task = asyncio.create_task(tool_actions.media_action('pause', command=hanging))
        started.clear()
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_thats_all_only_dismisses_completed_exact_turns(self):
        accepted = ("that's all", " THAT'S ALL. ", "That's all!", "that’s all", "That’s all.",
                    "thats all", "that is all", "That is all!")
        rejected = ("that's all?", "that's all!!", "that's all..", '"that\'s all"', "that's  all", "that's\nall",
                    "that's all I wanted to ask about the weather", "okay, that's all", "that's all, thanks",
                    "that's not all", "is that all", '')
        previous = [{'role': 'user', 'content': 'Previous request'},
                    {'role': 'assistant', 'content': 'Known spoken reply.'}]
        cases = [(previous + [{'role': 'user', 'content': text}], False, FrameDirection.DOWNSTREAM,
                  text in accepted, text in rejected) for text in (*accepted, *rejected)]
        text = "that's all"
        cases.extend([
            ([{'role': 'user', 'content': text}], True, FrameDirection.DOWNSTREAM, False, False),
            ([{'role': 'user', 'content': text}], False, FrameDirection.UPSTREAM, False, False),
            ([{'role': 'assistant', 'content': text}], False, FrameDirection.DOWNSTREAM, False, False),
            ([{'role': 'system', 'content': text}], False, FrameDirection.DOWNSTREAM, False, False),
            ([{'role': 'user', 'content': [{'type': 'text', 'text': text}]}], False, FrameDirection.DOWNSTREAM, False, False),
        ])
        for messages, speculative, direction, dismisses, reaches_brain in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Ending a conversation cannot call desktop commands'))
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct fixture has no engine'
                service.dismiss = Mock()
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(messages))
                request = request_frame(service, context, speculation=speculative)
                await service.process_frame(request, direction)
                self.assertEqual(context.get_messages(), messages,
                                 'Ending a conversation discards the context rather than editing it')
                if dismisses:
                    service.dismiss.assert_called_once_with()
                    service.push_frame.assert_not_awaited()
                else:
                    service.dismiss.assert_not_called()
                if reaches_brain:
                    self.assertTrue(any(isinstance(call.args[0], speech.SpeechAdvisoryFrame)
                                        for call in service.push_frame.await_args_list),
                                    'A turn that is not an exact that is all takes the brain path')
                command.assert_not_awaited()

    async def test_stop_account_retires_only_after_complete_output_delivery_without_feed(self):
        command = AsyncMock(side_effect=[self.media(), 'unhandled'])
        service = hermes_service(local_command=command)
        service.push_frame = AsyncMock()
        self.addAsyncCleanup(service.local_actions.close)

        async def request(text):
            service.push_frame.reset_mock()
            context = bot.LLMContext([{'role': 'user', 'content': text}])
            frame = request_frame(service, context)
            await service.process_frame(frame, FrameDirection.DOWNSTREAM)
            return frame

        await request('pause music')
        advisory = "I couldn't confirm pause. Check the media player. I won't retry."
        self.assertEqual(service.push_frame.await_args_list[0].args[0].text, advisory)
        end = service.push_frame.await_args_list[-1].args[0]
        self.assertFalse(end.reply_progress.answer_failed)
        service.conversation_output(end)
        await request('stop')
        account = "Stopped. Couldn't confirm: pause. I won't undo anything."
        self.assertEqual(service.push_frame.await_args_list[0].args[0].text, account)
        end = service.push_frame.await_args_list[-1].args[0]
        record = service.current_reply()
        section = record.open_section('neutral')
        start, audio, stopped = TTSStartedFrame(), TTSAudioRawFrame(bytes(960), 48000, 1), TTSStoppedFrame()
        record.starts_text(audio, account)
        for frame in (start, audio, stopped):
            record.stream_frame(frame, section)
        for frame in (start, audio, stopped, end):
            if frame is audio:
                service.conversation_audio([record.source_range(audio)])
            service.conversation_output(frame)
        self.assertEqual(service.outcomes, [])
        stop = await request('stop')
        service.push_frame.assert_awaited_once()
        completion = service.push_frame.await_args.args[0]
        self.assertIs(type(completion), LLMFullResponseEndFrame)
        self.assertIs(reply_progress.token_of(completion), stop.request_origin[0])
        self.assertFalse(completion.reply_progress.answer_failed)
        self.assertEqual(command.await_count, 2)

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
                request = request_frame(service, context, speculation=speculative)
                await service.process_frame(request, direction)
                self.assertEqual(context.get_messages(), messages[:-1] if consumes else messages,
                                 'An exact completed stop/cancel must be consumed locally')
                if consumes:
                    service.push_frame.assert_awaited_once()
                    completion = service.push_frame.await_args.args[0]
                    self.assertIs(type(completion), LLMFullResponseEndFrame)
                    self.assertIs(reply_progress.token_of(completion), request.request_origin[0])
                    self.assertFalse(completion.reply_progress.answer_failed)
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
            action = asyncio.create_task(service.process_frame(request_frame(service, context), FrameDirection.DOWNSTREAM))
            try:
                await asyncio.wait_for(started.wait(), 5)
                self.assertTrue(service.local_actions.lock.locked())
                self.assertEqual(len(service.local_actions.tasks), 1)
                local_task = next(iter(service.local_actions.tasks))
                service.indicator_user_started()
                stopping = bot.LLMContext([{'role': 'user', 'content': word}])
                stop_request = request_frame(service, stopping)
                await asyncio.wait_for(service.process_frame(stop_request, FrameDirection.DOWNSTREAM), 5)
                self.assertEqual(stopping.get_messages(), [])
                self.assertIs(service.channel.reader, held_reader)
                self.assertFalse(held_reader.done(), 'Stop does not cancel native engine drainage')
                self.assertFalse(local_task.done(), 'Stop does not cancel an attempted desktop action')
                self.assertTrue(service.local_actions.lock.locked())
                self.assertEqual(len(calls), 2)
                self.assertEqual(service.push_frame.await_args_list[0].args[0].text,
                                 "Stopped. Still finishing: pause. I won't undo anything.")
                self.assertEqual(service.push_frame.await_count, 2)
                completion = service.push_frame.await_args_list[-1].args[0]
                self.assertIs(type(completion), LLMFullResponseEndFrame)
                self.assertIs(reply_progress.token_of(completion), stop_request.request_origin[0])
                self.assertFalse(completion.reply_progress.answer_failed)
                service.push_frame.reset_mock()
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
            with patch.dict(bot.LOCAL_TOOLS, focus_workspace=bot.LocalTool(permission, AsyncMock(), 'workspace', 'workspace three')):
                self.assertIsNone(bot.match_instant_tool('workspace three'))
        command = AsyncMock()
        for value in (True, False, 0, -1, 2147483648, '3', 3.0, None):
            with self.assertRaises(ValueError):
                await tool_actions.workspace_action(value, command=command)
        command.assert_not_awaited()
        dispatch = ('/usr/bin/hyprctl', 'dispatch', 'hl.dsp.focus({ workspace = "3" })')
        advisory = "I couldn't confirm workspace 3. Check the desktop. I won't retry."
        for lag in range(3):
            command = AsyncMock(side_effect=['{"id":1}', 'ok', *['{"id":1}'] * lag, '{"id":3}'])
            with patch.object(bot.asyncio, 'sleep', AsyncMock()) as delay:
                result = await tool_actions.workspace_action(3, command=command)
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
                    result = await tool_actions.workspace_action(3, command=command)
                    self.assertFalse(result.confirmed)
                    self.assertEqual(result.attempted, stage == 2)
                    self.assertEqual(result.message, advisory)
                    self.assertEqual(command.await_args_list, [call(status), call(dispatch), call(status)][:stage + 1])
        for reply in ('unhandled', 'ok\n\n', 'ok\r\n', ' ok', 'PRIVATE', RuntimeError('PRIVATE')):
            command = AsyncMock(side_effect=['{"id":1}', reply])
            result = await tool_actions.workspace_action(3, command=command)
            self.assertFalse(result.confirmed)
            self.assertTrue(result.attempted)
            self.assertEqual(result.message, advisory)
            self.assertEqual(command.await_args_list, [call(status), call(dispatch)])
        command = AsyncMock(side_effect=['{"id":1}', 'ok', '{"id":1}', '{"id":2}', '{"id":1}'])
        with patch.object(bot.asyncio, 'sleep', AsyncMock()):
            result = await tool_actions.workspace_action(3, command=command)
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
            with patch.object(tool_actions, 'DESKTOP_TIMEOUT', .01):
                result = await tool_actions.workspace_action(3, command=hanging)
            self.assertTrue(cleaned.is_set())
            self.assertFalse(result.confirmed)
            self.assertEqual(result.attempted, hang_at == 2)
            self.assertEqual(result.message, advisory)
            self.assertEqual(calls, [status, dispatch][:hang_at])

    async def test_desktop_environment_is_local_and_bounded(self):
        selectors = {'WAYLAND_DISPLAY': 'wayland-1', 'HYPRLAND_INSTANCE_SIGNATURE': 'instance_12.ab-3'}
        uid = os.getuid()
        baseline = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C.UTF-8',
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
                  patch.object(tool_actions.pwd, 'getpwuid', return_value=Mock(pw_dir='/canonical/home')),
                  patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
                self.assertEqual(await tool_actions.run_local_command(argv), 'ok\n')
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
                            await tool_actions.run_local_command(argv)
                        spawn.assert_not_awaited()
        process = Mock(pid=9876, returncode=0)
        process.stdout.read = AsyncMock(side_effect=[b'ok', b''])
        process.wait = AsyncMock(return_value=0)
        with (patch.dict(os.environ, poisoned, clear=True),
              patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
            await tool_actions.run_local_command(('/tmp/omarchy-shell', 'media', 'status'))
            self.assertEqual(spawn.await_args.kwargs['env'], baseline)

        screenshot = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')
        for key in ('OMARCHY_SCREENSHOT_DIR', 'XDG_PICTURES_DIR'):
            for value in ('', 'relative', 'a' * 4097, '/' + 'a' * 4096, '/bad\npath', '/bad\x85path'):
                with (patch.dict(os.environ, poisoned | {key: value}, clear=True),
                      patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock()) as spawn):
                    with self.assertRaisesRegex(RuntimeError, '^screenshot destination unavailable$'):
                        await tool_actions.run_local_command(screenshot)
                    spawn.assert_not_awaited()
        for destinations in ({}, {'OMARCHY_SCREENSHOT_DIR': '/' + 'é' * 4095}):
            process = Mock(pid=9876, returncode=0)
            process.stdout.read = AsyncMock(side_effect=[b'ok', b''])
            process.wait = AsyncMock(return_value=0)
            with (patch.dict(os.environ, selectors | destinations, clear=True),
                  patch.object(tool_actions.pwd, 'getpwuid', return_value=Mock(pw_dir='/canonical/home')),
                  patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn):
                await tool_actions.run_local_command(screenshot)
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
                await tool_actions.run_local_command(argv)
                self.assertEqual(spawn.await_args.kwargs['env'], baseline)

        cases = []
        for argv in (('/usr/bin/omarchy-shell', 'media', 'status'),
                     ['/usr/bin/omarchy-shell', 'media', 'status']):
            cases.extend([(argv, 4 * 1024 * 1024, 4 * 1024 * 1024, True),
                          (argv, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, False)])
        resolver = ('/usr/bin/env', 'HOME=/fixture', '/usr/bin/python', '-I', str(bot.ROOT / 'app_resolver.py'))
        cases.extend([(resolver, 20544, 20544, True), (resolver, 20544, 20545, False)])
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
                        output = await tool_actions.run_local_command(argv)
                        self.assertEqual(len(output), size)
                        self.assertEqual(output, 'A' * size)
                        process.stdout._transport.close.assert_not_called()
                        killpg.assert_not_called()
                        process.wait.assert_awaited_once_with()
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^output too large$'):
                            await tool_actions.run_local_command(argv)
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
        with patch.object(tool_actions.pwd, 'getpwuid', return_value=Mock(pw_dir=home)), patch.dict(os.environ, {
            'HOME': '/wrong/caller/home', 'XDG_DATA_HOME': '/fixture/caller data',
            'XDG_DATA_DIRS': '/fixture/a;/literal:/fixture/b', 'XDG_CURRENT_DESKTOP': 'Hyprland:Fixture_1',
        }, clear=True):
            for phrase in ('open Fixture App', ' OPEN Fixture App. ', 'Open Fixture App!'):
                with self.subTest(phrase=phrase):
                    command = AsyncMock(return_value=json.dumps({'id': desktop_id, 'name': 'Fixture app'}))
                    name = bot.match_local_phrase(phrase)[1]['name']
                    self.assertEqual(name, 'Fixture App')
                    tool = await bot.resolve_local_tool(bot.match_instant_tool(phrase), command=command)
                    self.assertIsNotNone(tool)
                    self.assertEqual(tool.confirmation, 'Opening Fixture app.')
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
                    self.assertIsNone(bot.match_instant_tool(phrase))
            for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
                with patch.dict(bot.LOCAL_TOOLS, {'open_app': bot.LocalTool(permission, AsyncMock(), 'open app', "open followed by an installed app's exact name")}):
                    self.assertIsNone(bot.match_instant_tool('open FixtureApp'))
            for phrase, expected_name in (('open UnknownApp', 'UnknownApp'), ('open AmbiguousApp', 'AmbiguousApp'),
                                          ('open FixtureApp and tell me a fact', 'FixtureApp and tell me a fact')):
                command = AsyncMock(return_value='null\n')
                name = bot.match_local_phrase(phrase)[1]['name']
                self.assertEqual(name, expected_name)
                self.assertIsNone(await bot.resolve_local_tool(bot.match_instant_tool(phrase), command=command))
                self.assertEqual(command.await_count, 1, 'Unknown names cannot launch')
            selected = bot.match_instant_tool('open FixtureApp')
            selected_name = bot.match_local_phrase('open FixtureApp')[1]['name']
            self.assertEqual(selected_name, 'FixtureApp')
            bad_ids = ('../fixture.desktop', '-fixture.desktop', '.fixture.desktop', 'fixture', 'a:b.desktop',
                       'a\\b.desktop', 'a\n.desktop', 'é' * 510 + '.desktop')
            bad_names = (None, 3, '', '  ', 'Fixture\nApp', 'x' * (tool_actions.APP_NAME_BYTES + 1))
            for output in ('', '{', 'null null', 'false', '42', '[]', '{}', '""', '"fixture.desktop"',
                           *(json.dumps({'id': bad_id, 'name': 'FixtureApp'}) for bad_id in bad_ids),
                           json.dumps({'id': 'fixture.desktop'}),
                           json.dumps({'id': 'fixture.desktop', 'name': 'FixtureApp', 'extra': 1}),
                           *(json.dumps({'id': 'fixture.desktop', 'name': bad_name}) for bad_name in bad_names)):
                with self.subTest(output=output[:80]):
                    command = AsyncMock(return_value=output)
                    with self.assertRaises(ValueError):
                        await bot.resolve_local_tool(selected, command=command)
                    self.assertEqual(command.await_count, 1)
            command = AsyncMock(side_effect=RuntimeError('unavailable'))
            with self.assertRaises(RuntimeError):
                await bot.resolve_local_tool(selected, command=command)
            self.assertEqual(command.await_count, 1)
            for error in (RuntimeError('launch failed'), FileNotFoundError('missing'), TimeoutError()):
                command = AsyncMock(side_effect=error)
                result = await tool_actions.open_app(desktop_id, expected_env, command=command)
                self.assertFalse(result.accepted)
                self.assertTrue(result.attempted)
                self.assertEqual(result.message, "I couldn't confirm the app opened. Check the desktop. I won't retry.")
                self.assertEqual(command.await_count, 1)
        defaults = (f'HOME={home}', f'XDG_DATA_HOME={home}/.local/share',
                    'XDG_DATA_DIRS=/usr/local/share:/usr/share', 'XDG_CURRENT_DESKTOP=')
        with patch.object(tool_actions.pwd, 'getpwuid', return_value=Mock(pw_dir=home)), patch.dict(os.environ, {}, clear=True):
            command = AsyncMock(return_value='{"id": "fixture.desktop", "name": "FixtureApp"}')
            tool = await bot.resolve_local_tool(selected, command=command)
            with patch.dict(os.environ, {'XDG_DATA_HOME': '/changed', 'XDG_DATA_DIRS': '/changed'}):
                await tool.run(command=command)
            self.assertEqual(command.await_args_list[0].args[0][1:5], defaults)
            self.assertEqual(command.await_args_list[1].args[0][5:9], (
                'HOME=/fixture/home ; $$literal', 'XDG_DATA_HOME=/fixture/home ; $$literal/.local/share',
                'XDG_DATA_DIRS=/usr/local/share:/usr/share', 'XDG_CURRENT_DESKTOP=',
            ))
            for key in ('XDG_DATA_HOME', 'XDG_DATA_DIRS'):
                with patch.dict(os.environ, {key: ''}):
                    self.assertEqual(tool_actions.app_discovery_environment(), defaults)
            for key, value in (('XDG_DATA_HOME', 'relative'), ('XDG_DATA_HOME', '/a\n'),
                               ('XDG_DATA_DIRS', ':/a'), ('XDG_DATA_DIRS', '/a:'),
                               ('XDG_DATA_DIRS', '/a:relative'), ('XDG_DATA_HOME', '/' + 'a' * 4096),
                               ('XDG_CURRENT_DESKTOP', 'Hyprland;bad'), ('XDG_CURRENT_DESKTOP', 'A::B'),
                               ('XDG_CURRENT_DESKTOP', 'é')):
                with self.subTest(key=key, value=value[:80]), patch.dict(os.environ, {key: value}):
                    command = AsyncMock()
                    with self.assertRaises(ValueError):
                        await bot.resolve_local_tool(selected, command=command)
                    command.assert_not_awaited()
            for name in ('x' * 1025, 'a\x00b', 'a\tb'):
                self.assertIsNone(bot.match_instant_tool(f'open {name}'))

        ordinary = 'Ordinary interrupted request.'
        context = bot.LLMContext([{'role': 'user', 'content': ordinary}])
        captured = context.get_messages()[-1]
        command = AsyncMock(side_effect=AssertionError('Ordinary turns cannot run local commands'))
        service = hermes_service(local_command=command)
        pending = asyncio.get_running_loop().create_future()
        service.channel.reader = pending
        checkpoint, unreleased = asyncio.Event(), asyncio.Event()
        real_resolve, real_shield = bot.resolve_local_tool, asyncio.shield
        requests = []

        async def resolve_at_checkpoint(tool, *, command=tool_actions.run_local_command):
            if tool.lookup.args == (ordinary,):
                checkpoint.set()
                await unreleased.wait()
            return await real_resolve(tool, command=command)

        def shield_at_checkpoint(awaitable):
            if awaitable is pending:
                checkpoint.set()
            return real_shield(awaitable)

        async def exchange(messages, output, *, admitted, desktop=None):
            requests.append(messages)
            output.put_nowait({'delivery': 'neutral'})
            output.put_nowait(None)

        processing = None
        try:
            with (patch.object(bot, 'resolve_local_tool', resolve_at_checkpoint),
                  patch.object(bot.asyncio, 'shield', shield_at_checkpoint),
                  patch.object(service.channel, 'exchange', exchange)):
                processing = asyncio.create_task(service.process_frame(request_frame(service, context), FrameDirection.DOWNSTREAM))
                await asyncio.wait_for(checkpoint.wait(), 5)
                processing.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await processing
                self.assertTrue(any(message is captured for message in context.get_messages()),
                                'Interrupted ordinary user message must remain in context')
                context.get_messages().append({'role': 'user', 'content': 'Following ordinary request.'})
                service.channel.reader = None
                await service.process_frame(request_frame(service, context), FrameDirection.DOWNSTREAM)
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
        expected = ("I can talk with you, answer general knowledge questions and keep short notes between conversations. "
                    "You can say: mute; unmute; set the volume to thirty; pause music; next track; "
                    "workspace three; open followed by an installed app's exact name; take a screenshot. "
                    "Permission required: delete one of your notes. I'll read the request back and ask you before doing it. "
                    "You can also say repeat that, stop, that's all, or what can I say. "
                    "I have no internet or live information, and I can't see what's on your screen.")
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
                await service.process_frame(request_frame(service, context, speculation=speculative), direction)
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
                if tool.permission is bot.PermissionTier.FREE and key != 'open_app':
                    matched = bot.match_instant_tool(tool.spoken)
                    self.assertIsNotNone(matched)
                    self.assertEqual(matched.subject, tool.subject)
        action = AsyncMock(side_effect=AssertionError('Formatting help cannot execute tools'))
        free = bot.PermissionTier.FREE
        ask = bot.PermissionTier.ASK
        forbidden = bot.PermissionTier.FORBIDDEN
        intro = "I can talk with you, answer general knowledge questions and keep short notes between conversations."
        phrases = "You can also say repeat that, stop, that's all, or what can I say."
        self.assertIn(bot.HELP_PHRASES, hermes_worker.SYSTEM_PROMPT)
        limits = "I have no internet or live information, and I can't see what's on your screen."
        with patch.dict(bot.LOCAL_TOOLS, {
            'alpha': bot.LocalTool(free, action, 'alpha', 'alpha example'),
        }, clear=True):
            self.assertEqual(bot.capability_help(),
                             f'{intro} You can say: alpha example. None of these tools needs permission first. '
                             f'{phrases} {limits}')
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(free, action, 'beta', 'beta example')
            self.assertEqual(bot.capability_help(),
                             f'{intro} You can say: alpha example; beta example. None of these tools needs permission '
                             f'first. {phrases} {limits}')
            del bot.LOCAL_TOOLS['alpha']
            self.assertEqual(bot.capability_help(),
                             f'{intro} You can say: beta example. None of these tools needs permission first. '
                             f'{phrases} {limits}')
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(ask, action, 'beta', 'beta example')
            self.assertEqual(bot.capability_help(),
                             f'{intro} No local tools are available without permission. Permission required: beta example. '
                             f"I'll read the request back and ask you before doing it. {phrases} {limits}")
            bot.LOCAL_TOOLS['alpha'] = bot.LocalTool(free, action, 'alpha', 'alpha example')
            bot.LOCAL_TOOLS['gamma'] = bot.LocalTool(ask, action, 'gamma', 'gamma example')
            self.assertEqual(bot.capability_help(),
                             f'{intro} You can say: alpha example. Permission required: beta example; gamma example. '
                             f"I'll read the request back and ask you before doing it. {phrases} {limits}")
            bot.LOCAL_TOOLS['beta'] = bot.LocalTool(forbidden, action, 'beta', 'beta example')
            del bot.LOCAL_TOOLS['gamma']
            self.assertEqual(bot.capability_help(),
                             f'{intro} You can say: alpha example. None of these tools needs permission first. '
                             f'{phrases} {limits}')
            del bot.LOCAL_TOOLS['alpha']
            self.assertEqual(bot.capability_help(),
                             f"{intro} No local tools are available. Check Kestrel's setup. {phrases} {limits}")
            bot.LOCAL_TOOLS.clear()
            self.assertEqual(bot.capability_help(),
                             f"{intro} No local tools are available. Check Kestrel's setup. {phrases} {limits}")
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
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'unmute', 'set_volume', 'pause_media', 'next_track', 'focus_workspace', 'open_app', 'take_screenshot', 'delete_note'})
        for messages, speculative, direction, consumes in cases:
            with self.subTest(messages=messages, speculative=speculative, direction=direction):
                command = AsyncMock(side_effect=AssertionError('Repeat must not invoke a desktop command'))
                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
                service.last_spoken_reply = 'Known last reply.'
                service.push_frame = AsyncMock()
                context = bot.LLMContext(deepcopy(messages))
                await service.process_frame(request_frame(service, context, speculation=speculative), direction)
                self.assertEqual(context.get_messages(), [] if consumes else messages)
                replay = [args.args[0] for args in service.push_frame.await_args_list
                          if isinstance(args.args[0], bot.TTSSpeakFrame)]
                self.assertEqual([frame.text for frame in replay], ['Known last reply.'] if consumes else [])
                if consumes:
                    self.assertFalse(replay[0].append_to_context)
                command.assert_not_awaited()

    async def test_local_repeat_requires_credited_speech(self):
        def local_sentence(service, text, size, sample_rate=48000):
            token, _ = service.admission.accept_spoken()
            service.begin_reply(token)
            record = service.current_reply()
            section = record.open_section('neutral')
            start = TTSStartedFrame()
            audio = TTSAudioRawFrame(bytes(size), sample_rate, 1)
            spoken = TTSTextFrame(text, aggregated_by='sentence')
            spoken.append_to_context = False
            record.starts_text(audio, text)
            for frame in (start, audio, spoken):
                record.stream_frame(frame, section)
            service.conversation_output(start)
            return record, section, spoken

        for case in ('partial before text', 'credit after text', 'empty source',
                     'invalid metadata', 'skipped text start', 'superseded ticket'):
            with self.subTest(case=case):
                service = hermes_service()
                self.addAsyncCleanup(service.local_actions.close)
                service.last_spoken_reply = 'Previously heard reply.'
                sentence = 'This local sentence reached output.'
                size = 0 if case == 'empty source' else 960 if case in (
                    'credit after text', 'superseded ticket') else 9600
                record, section, spoken = local_sentence(
                    service, sentence, size, 24000 if case == 'invalid metadata' else 48000)

                if case == 'partial before text':
                    service.conversation_audio([(section, 0, 7680)])
                    service.conversation_output(spoken)
                    self.assertEqual(service.last_spoken_reply, sentence)
                elif case == 'credit after text':
                    service.conversation_output(spoken)
                    self.assertEqual(service.last_spoken_reply, 'Previously heard reply.')
                    service.conversation_audio([(section, 0, 960)])
                    self.assertEqual(service.last_spoken_reply, sentence)
                elif case == 'superseded ticket':
                    service.conversation_output(spoken)
                    self.assertEqual(service.last_spoken_reply, 'Previously heard reply.')
                    newer, newer_section, newer_spoken = local_sentence(
                        service, 'Newer heard reply.', 960)
                    self.assertIsNot(record.token, newer.token)
                    service.conversation_audio([(newer_section, 0, 960)])
                    service.conversation_output(newer_spoken)
                    self.assertEqual(service.last_spoken_reply, 'Newer heard reply.')
                    service.conversation_audio([(section, 0, 960)])
                    self.assertEqual(service.last_spoken_reply, 'Newer heard reply.')
                else:
                    credit = (section, 7680, 9600) if case == 'skipped text start' else (section, 0, size)
                    service.conversation_audio([credit])
                    service.conversation_output(spoken)
                    self.assertEqual(service.last_spoken_reply, 'Previously heard reply.')

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
                await service.process_frame(request_frame(service, context, speculation=speculative), direction)
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
        frame = request_frame(service, context)
        # This fixture has no output to play Muting., so the announcement bound releases at once.
        timeout = patch.object(bot, 'ANNOUNCEMENT_TIMEOUT', 0)
        timeout.start()
        self.addCleanup(timeout.stop)
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

    async def test_exact_mute_announcement_waits_for_playback_with_bounded_release(self):
        mute = ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')
        for case in ('played', 'interrupted', 'not fully played', 'synthesis failed', 'conversation ended',
                     'request superseded', 'timed out', 'stale interruption'):
            with self.subTest(case=case):
                replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
                calls = []

                async def command(argv):
                    calls.append(argv)
                    return next(replies)

                service = hermes_service(local_command=command)
                pushed = []
                first_push = asyncio.Event()

                async def push_frame(frame, direction=FrameDirection.DOWNSTREAM):
                    pushed.append(frame)
                    first_push.set()

                service.push_frame = push_frame
                start = TTSStartedFrame()
                stopped = TTSStoppedFrame()
                audio = TTSAudioRawFrame(bytes(960), 48000, 1)
                context = bot.LLMContext([{'role': 'user', 'content': 'mute'}])
                request = request_frame(service, context)
                token = request.request_origin[0]
                held = case == 'request superseded'
                if held:
                    await service.local_actions.lock.acquire()
                processing = asyncio.create_task(
                    service.process_frame(request, FrameDirection.DOWNSTREAM))
                try:
                    with (patch.object(bot.logger, 'warning') as warning,
                          patch.object(bot, 'ANNOUNCEMENT_TIMEOUT', 0) if case == 'timed out' else nullcontext()):
                        if held:
                            async def scheduled():
                                while not service.local_actions.tasks:
                                    await asyncio.sleep(0)

                            await asyncio.wait_for(scheduled(), 10)
                            service.admission.accept_spoken()
                            service.local_actions.lock.release()
                            held = False
                        elif case != 'timed out':
                            await asyncio.wait_for(first_push.wait(), 10)
                            self.assertIsInstance(pushed[0], bot.TTSSpeakFrame)
                            self.assertEqual(pushed[0].text, 'Muting.')
                            self.assertFalse(pushed[0].append_to_context)
                            self.assertIs(reply_progress.token_of(pushed[0]), token)
                            self.assertIsInstance(pushed[1], bot.AnnouncementMarkFrame)
                            self.assertEqual(calls, [])
                            played = service._announcement[2]
                            self.assertFalse(played.done())
                            marker = pushed[1]
                            record = service.current_reply()
                            audio_context = record.open_section('neutral')
                            record.starts_text(audio, 'Muting.')
                            for frame in (start, audio, stopped):
                                record.stream_frame(frame, audio_context)
                            if case == 'played':
                                for frame in (bot.AnnouncementMarkFrame(), start, audio, stopped):
                                    if frame is audio:
                                        service.conversation_audio([record.source_range(audio)])
                                    service.conversation_output(frame)
                                    self.assertFalse(played.done(), f'{type(frame).__name__} cannot confirm playback')
                                service.conversation_output(marker)
                            elif case == 'interrupted':
                                foreign_reply = reply_progress.ReplyProgress(object(), feed=None, feed_open=lambda: True)
                                foreign = speech.ConversationSynthesisFailedFrame(
                                    reply_progress=foreign_reply, section=foreign_reply.open_section('neutral'))
                                for frame in (start, audio, stopped, foreign):
                                    if frame is audio:
                                        service.conversation_audio([record.source_range(audio)])
                                    service.conversation_output(frame)
                                    self.assertFalse(played.done(), f'{type(frame).__name__} cannot release mute')
                                interruption = InterruptionFrame()
                                interruption.reply_progress = record
                                service.conversation_output(interruption)
                            elif case == 'not fully played':
                                service.conversation_output(marker)
                            elif case == 'stale interruption':
                                stale = [InterruptionFrame(), InterruptionFrame(), InterruptionFrame()]
                                stale[1].reply_progress = None
                                stale[2].reply_progress = reply_progress.ReplyProgress.silent(object())
                                for frame in stale:
                                    service.conversation_output(frame)
                                    self.assertFalse(played.done(), 'An earlier interruption cannot release mute')
                                    self.assertEqual(calls, [])
                                for frame in (start, audio, stopped, marker):
                                    if frame is audio:
                                        service.conversation_audio([record.source_range(audio)])
                                    service.conversation_output(frame)
                            elif case == 'synthesis failed':
                                service.conversation_output(speech.ConversationSynthesisFailedFrame(
                                    reply_progress=record, section=audio_context))
                            else:
                                service.admission.close()
                                service.revoke()
                        await asyncio.wait_for(processing, 10)
                    if case == 'conversation ended':
                        self.assertEqual(calls, [])
                    else:
                        self.assertEqual(calls.count(mute), 1)
                    if case == 'request superseded':
                        self.assertEqual(pushed, [])
                    if case == 'played':
                        self.assertEqual(len(pushed[2:]), 1)
                        self.assertIs(type(pushed[2]), LLMFullResponseEndFrame)
                        self.assertIs(reply_progress.token_of(pushed[2]), token)
                    if case in ('played', 'stale interruption'):
                        warning.assert_not_called()
                    else:
                        warning.assert_called_once_with(f"Playback of 'Muting.' was not confirmed: {case}")
                finally:
                    if held:
                        service.local_actions.lock.release()
                    await service.local_actions.close()
                    if not processing.done():
                        processing.cancel()
                    await asyncio.gather(processing, return_exceptions=True)

    def test_only_exact_mute_selects_a_free_tool(self):
        self.assertEqual(set(bot.LOCAL_TOOLS), {'mute', 'unmute', 'set_volume', 'pause_media', 'next_track', 'focus_workspace', 'open_app', 'take_screenshot', 'delete_note'})
        tool = bot.LOCAL_TOOLS['mute']
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        self.assertTrue(callable(tool.run))
        for text in ('mute', ' MUTE ', 'mute.', 'Mute!'):
            with self.subTest(text=text):
                self.assertIs(bot.match_instant_tool(text), tool)
        for text in ('mute?', '"mute"', 'mute!!', 'do not mute', 'mute this',
                     'please mute', 'mute; echo bad', '', 'mute\nnow'):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, mute=bot.LocalTool(permission, AsyncMock(), 'mute', 'mute')):
                self.assertIsNone(bot.match_instant_tool('mute'))


    def test_only_exact_unmute_selects_its_free_tool(self):
        tool = bot.LOCAL_TOOLS['unmute']
        self.assertEqual(tool.permission, bot.PermissionTier.FREE)
        for text in ('unmute', ' UNMUTE ', 'unmute.', 'Unmute!'):
            with self.subTest(text=text):
                self.assertIs(bot.match_instant_tool(text), tool)
        for text in ('unmute?', '"unmute"', 'unmute!!', 'do not unmute', 'unmute this', 'please unmute',
                     'un mute', 'unmute; echo bad', 'unmute\nnow'):
            with self.subTest(text=text):
                self.assertIsNone(bot.match_instant_tool(text))
        for permission in (bot.PermissionTier.ASK, bot.PermissionTier.FORBIDDEN):
            with patch.dict(bot.LOCAL_TOOLS, unmute=bot.LocalTool(permission, AsyncMock(), 'unmute', 'unmute')):
                self.assertIsNone(bot.match_instant_tool('unmute'))

    async def test_exact_unmute_says_unmuted_only_after_confirmation_and_advises_on_failure(self):
        write = ('/usr/bin/pactl', 'set-sink-mute', 'physical', '0')
        for readback in ('Mute: no', 'Mute: yes'):
            with self.subTest(readback=readback):
                events = []
                replies = iter(['selected', 'physical', 'Mute: yes', '', 'selected', 'physical', readback])

                async def command(argv):
                    events.append(argv)
                    return '' if argv[0] == '/usr/bin/notify-send' else next(replies)

                async def push_frame(frame, direction=FrameDirection.DOWNSTREAM):
                    events.append(frame)

                service = hermes_service(local_command=command)
                service.channel.failure = 'This direct processor fixture has no engine'
                service.push_frame = push_frame
                self.addAsyncCleanup(service.local_actions.close)
                context = bot.LLMContext([{'role': 'user', 'content': 'unmute'}])
                await service.process_frame(request_frame(service, context), FrameDirection.DOWNSTREAM)
                speech_frames = [event for event in events if isinstance(event, bot.TTSSpeakFrame)]
                self.assertEqual(context.get_messages(), [])
                self.assertEqual(events.count(write), 1)
                if readback == 'Mute: no':
                    self.assertEqual([frame.text for frame in speech_frames], ['Unmuted.'])
                    self.assertFalse(speech_frames[0].append_to_context)
                    self.assertGreater(events.index(speech_frames[0]),
                                       max(i for i, event in enumerate(events) if isinstance(event, tuple)))
                    self.assertEqual([(item.subject, item.result) for item in service.outcomes],
                                     [('unmute', tool_actions.AudioResult(True, True, 'confirmed'))])
                    events.clear()
                    stop = bot.LLMContext([{'role': 'user', 'content': 'stop'}])
                    await service.process_frame(request_frame(service, stop), FrameDirection.DOWNSTREAM)
                    self.assertEqual([event.text for event in events if isinstance(event, bot.TTSSpeakFrame)],
                                     ["Stopped. Done: unmute. I won't undo anything."])
                else:
                    self.assertEqual([frame.text for frame in speech_frames],
                                     ["I couldn't confirm unmute. Check the audio control. I won't retry."])
                    self.assertEqual([event for event in events if isinstance(event, tuple)
                                      and event[0] == '/usr/bin/notify-send'], [(
                        '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
                        '--hint=boolean:suppress-sound:true', 'Unmute could not be confirmed',
                        'Check the audio control. Kestrel will not retry.')])

    async def test_mute_sets_one_captured_sink_and_requires_readback(self):
        command = AsyncMock(side_effect=[
            'processing.sink\n', 'alsa_output.test\n', 'Mute: no\n', '',
            'processing.sink\n', 'alsa_output.test\n', 'Mute: yes\n',
        ])
        result = await tool_actions.set_output_mute(True, command=command)
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


    async def test_unmute_sets_one_captured_sink_and_requires_readback(self):
        reads = ('/usr/bin/pactl', 'get-default-sink'), ('/usr/bin/omarchy-audio-output-sink', 'processing.sink')
        status = ('/usr/bin/pactl', 'get-sink-mute', 'alsa_output.test')
        write = ('/usr/bin/pactl', 'set-sink-mute', 'alsa_output.test', '0')
        before = ['processing.sink\n', 'alsa_output.test\n', 'Mute: yes\n', '']
        for label, outputs, expected, calls in (
            ('success', before + ['processing.sink\n', 'alsa_output.test\n', 'Mute: no\n'],
             tool_actions.AudioResult(True, True, 'confirmed'), [*reads, status, write, *reads, status]),
            ('already unmuted', ['processing.sink\n', 'alsa_output.test\n', 'Mute: no\n',
                                'processing.sink\n', 'alsa_output.test\n', 'Mute: no\n'],
             tool_actions.AudioResult(True, False, 'already unmuted'), [*reads, status, *reads, status]),
            ('readback still muted', before + ['processing.sink\n', 'alsa_output.test\n', 'Mute: yes\n'],
             tool_actions.AudioResult(False, True, 'readback unconfirmed'), [*reads, status, write, *reads, status]),
            ('changed default', before + ['other.sink\n', 'alsa_output.test\n', 'Mute: no\n'],
             tool_actions.AudioResult(False, True, 'target changed'),
             [*reads, status, write, reads[0], ('/usr/bin/omarchy-audio-output-sink', 'other.sink'), status]),
            ('corrupt status', ['processing.sink\n', 'alsa_output.test\n', 'Mute: YES'],
             tool_actions.AudioResult(False, False, 'invalid status'), [*reads, status]),
        ):
            with self.subTest(label):
                command = AsyncMock(side_effect=outputs)
                result = await tool_actions.set_output_mute(False, command=command)
                self.assertEqual(result, expected)
                self.assertEqual(command.await_args_list, [call(argv) for argv in calls])
                writes = [c for c in command.await_args_list if c.args[0][1] == 'set-sink-mute']
                self.assertEqual(writes, [call(write)] if expected.attempted else [])
        commands = []

        async def hung(argv):
            commands.append(argv)
            if argv[1] == 'get-default-sink':
                return 'processing.sink'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'alsa_output.test'
            if argv[1] == 'get-sink-mute':
                return 'Mute: yes'
            await asyncio.Future()

        with patch.object(tool_actions, 'MUTE_TIMEOUT', 0.01):
            result = await asyncio.wait_for(tool_actions.set_output_mute(False, command=hung), 5)
        self.assertEqual(result, tool_actions.AudioResult(False, True, 'unmute timeout'))
        self.assertEqual(commands[-1], write)

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
                result = await tool_actions.set_output_mute(True, command=command)
                self.assertEqual(result, tool_actions.AudioResult(confirmed, False, reason))
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
                result = await tool_actions.set_output_mute(True, command=command)
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

        with patch.object(tool_actions, 'MUTE_TIMEOUT', 0.01):
            result = await asyncio.wait_for(tool_actions.set_output_mute(True, command=hung), 5)
        self.assertTrue(started.is_set())
        self.assertTrue(stopped.is_set())
        self.assertEqual(result, tool_actions.AudioResult(False, True, 'mute timeout'))
        self.assertEqual(len(commands), 4)
        commands.clear()
        started.clear()
        stopped.clear()
        task = asyncio.create_task(tool_actions.set_output_mute(True, command=hung))
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
        env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C.UTF-8',
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
                        self.assertEqual(await tool_actions.run_local_command(('/test/command', 'literal;arg')), 'local\n')
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^' + message + '$'):
                            await tool_actions.run_local_command(('/test/command', 'literal;arg'))
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
                await tool_actions.run_local_command(('/missing/command',))

        process = Mock(pid=9876, returncode=0)
        process.stdout.read = AsyncMock(side_effect=[b'local\n', b''])
        process.wait = AsyncMock(return_value=0)
        process.stdin.drain = AsyncMock()
        process.stdin.wait_closed = AsyncMock()
        with patch.object(bot.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn:
            self.assertEqual(await tool_actions.run_local_command(('/test/command',), stdin_data=b'private\x00input'), 'local\n')
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
                      patch.object(tool_actions, 'LOCAL_COMMAND_TIMEOUT', 0.01),
                      patch.object(tool_actions, 'LOCAL_COMMAND_CLEANUP_TIMEOUT', 0.01)):
                    task = asyncio.create_task(tool_actions.run_local_command(('/test/hung',), stdin_data=b'private input'))
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
                await tool_actions.run_local_command(('/test/descendant',))
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
            task = asyncio.create_task(tool_actions.run_local_command(('/test/cleanup',)))
            await asyncio.wait_for(cleanup_started.wait(), 5)
            task.cancel()
            release_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
            self.assertTrue(reaped.is_set(), 'Cancellation must wait for native cleanup')
            self.assertEqual(killpg.call_args_list, [call(9876, signal.SIGTERM), call(9876, signal.SIGKILL)])

    async def test_local_command_wire_success_and_failure(self):
        self.assertEqual(await tool_actions.run_local_command((
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
                  patch.object(tool_actions, 'LOCAL_COMMAND_TIMEOUT', 0.5)):
                try:
                    with self.assertRaisesRegex(RuntimeError, '^command timeout$'):
                        await tool_actions.run_local_command((sys.executable, '-c', leader))
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


    async def test_local_command_child_locale_is_utf8_when_parent_is_not(self):
        # Qt desktop commands print a warning before their JSON unless the locale is UTF-8.
        with patch.dict(os.environ, {'LC_ALL': 'C', 'LC_CTYPE': 'C', 'LANG': 'C'}):
            self.assertEqual(await tool_actions.run_local_command(('/usr/bin/locale', 'charmap')), 'UTF-8\n')

    async def test_notification_is_fixed_local_and_reports_unavailability(self):
        for subject in ('mute', 'volume'):
            argv = ('/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
                    '--hint=boolean:suppress-sound:true', f'{subject.title()} could not be confirmed',
                    'Check the audio control. Kestrel will not retry.')
            command = AsyncMock(return_value='')
            with patch.object(bot.logger, 'error') as error:
                self.assertTrue(await tool_actions.notify_audio_failure(subject, command=command))
                command.assert_awaited_once_with(argv)
                error.assert_not_called()
            for failure in (RuntimeError('private missing executable'), RuntimeError('private external output')):
                command = AsyncMock(side_effect=failure)
                with patch.object(bot.logger, 'error') as error:
                    self.assertFalse(await tool_actions.notify_audio_failure(subject, command=command))
                    command.assert_awaited_once_with(argv)
                    error.assert_called_once_with(f'{subject.title()} failure notification unavailable')
            command = AsyncMock(side_effect=asyncio.CancelledError)
            with patch.object(bot.logger, 'error') as error:
                with self.assertRaises(asyncio.CancelledError):
                    await tool_actions.notify_audio_failure(subject, command=command)
                command.assert_awaited_once_with(argv)
                error.assert_not_called()


class WholeConversationTests(WholeConversationCase):
    async def test_unconfirmed_brain_desktop_call_speaks_fixed_advisory_without_retry(self):
        brain = ScriptedBrain([
            [({'tool_calls': [{'index': 0, 'id': 'pause-first', 'type': 'function', 'function': {
                'name': 'pause_media', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            [({'tool_calls': [{'index': 0, 'id': 'next-refused', 'type': 'function', 'function': {
                'name': 'next_track', 'arguments': '{}',
            }}]}, None), ({}, 'tool_calls')],
            [({'content': '[delivery:neutral] Everything succeeded.'}, None), ({}, 'stop')],
        ])
        self.addCleanup(brain.close)
        command = AsyncMock(side_effect=[LocalDesktopTests.media(), 'unhandled'])
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, 'Please stop the music for me.')
            advisory = "I couldn't confirm pause. Check the media player. I won't retry."
            self.assertEqual(await asyncio.wait_for(committed.get(), 5), advisory)
            heard = []
            while not spoken.empty():
                heard.append(spoken.get_nowait())
            self.assertEqual(' '.join(heard), advisory)
            self.assertEqual(command.await_args_list, [
                call(('/usr/bin/omarchy-shell', 'media', 'status')),
                call(('/usr/bin/omarchy-shell', 'media', 'pause')),
            ])
            self.assertEqual(len(brain.requests), 3)
            results = [m for m in brain.requests[-1][2]['messages'] if m['role'] == 'tool']
            self.assertEqual([(m['tool_call_id'], json.loads(m['content'])) for m in results], [
                ('pause-first', {'confirmed': False, 'attempted': True, 'reason': 'action unhandled'}),
                ('next-refused', {'confirmed': False, 'attempted': False, 'reason': 'turn closed'}),
            ])
            self.assertTrue(committed.empty())
        finally:
            await close()

    async def test_brain_desktop_calls_share_instant_tools_and_observed_results(self):
        cases = [
            ('mute', {}, 'mute',
             ['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'],
             [('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
              ('/usr/bin/pactl', 'set-sink-mute', 'physical', '1'),
              ('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical')]),
            ('unmute', {}, 'unmute',
             ['selected', 'physical', 'Mute: yes', '', 'selected', 'physical', 'Mute: no'],
             [('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
              ('/usr/bin/pactl', 'set-sink-mute', 'physical', '0'),
              ('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical')]),
            ('set_volume', {'percent': 30}, 'set volume to thirty',
             ['selected', 'physical', '{"volume":{"mono":{"value":65536}}}', 'Mute: no', '',
              '{"volume":{"mono":{"value":19660}}}', 'selected', 'physical',
              '{"volume":{"mono":{"value":19660}}}', 'Mute: no'],
             [('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical'),
              ('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%'),
              ('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical'),
              ('/usr/bin/pactl', 'get-default-sink'),
              ('/usr/bin/omarchy-audio-output-sink', 'selected'),
              ('/usr/bin/pactl', '--format=json', 'get-sink-volume', 'physical'),
              ('/usr/bin/pactl', 'get-sink-mute', 'physical')]),
            ('pause_media', {}, 'pause music',
             [LocalDesktopTests.media(), 'ok', LocalDesktopTests.media(playing=False)],
             [('/usr/bin/omarchy-shell', 'media', 'status'),
              ('/usr/bin/omarchy-shell', 'media', 'pause'),
              ('/usr/bin/omarchy-shell', 'media', 'status')]),
            ('next_track', {}, 'next track',
             [LocalDesktopTests.media(), 'ok', LocalDesktopTests.media(title='Second track')],
             [('/usr/bin/omarchy-shell', 'media', 'status'),
              ('/usr/bin/omarchy-shell', 'media', 'next'),
              ('/usr/bin/omarchy-shell', 'media', 'status')]),
            ('focus_workspace', {'number': 3}, 'workspace three',
             ['{"id":1}', 'ok', '{"id":3}'],
             [('/usr/bin/hyprctl', '-j', 'activeworkspace'),
              ('/usr/bin/hyprctl', 'dispatch', 'hl.dsp.focus({ workspace = "3" })'),
              ('/usr/bin/hyprctl', '-j', 'activeworkspace')]),
        ]
        replies = []
        for name, arguments, _, _, _ in cases:
            replies.extend([
                [({'tool_calls': [{'index': 0, 'id': name, 'type': 'function', 'function': {
                    'name': name, 'arguments': json.dumps(arguments),
                }}]}, None), ({}, 'tool_calls')],
                [({'content': '[delivery:neutral] Confirmed.'}, None), ({}, 'stop')],
            ])
        brain = ScriptedBrain(replies)
        self.addCleanup(brain.close)
        command = AsyncMock()
        transport, spoken, committed, _, _, close = await self.open_session(brain, local_command=command)
        try:
            for index, (name, arguments, phrase, results, argv) in enumerate(cases):
                with self.subTest(name=name):
                    command.reset_mock(side_effect=True)
                    command.side_effect = results
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'Please use ' + name + ' for me.')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Confirmed.')
                    self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Confirmed.')
                    self.assertEqual(command.await_args_list, [call(item) for item in argv])
                    tools = [m for m in brain.requests[2 * index + 1][2]['messages'] if m['role'] == 'tool' and m['tool_call_id'] == name]
                    self.assertEqual(len(tools), 1)
                    self.assertEqual(set(tools[0]), {'role', 'tool_call_id', 'content'})
                    self.assertEqual(tools[0]['tool_call_id'], name)
                    self.assertEqual(json.loads(tools[0]['content']),
                                     {'confirmed': True, 'attempted': True, 'reason': 'confirmed'})
                    command.reset_mock(side_effect=True)
                    command.side_effect = results
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, phrase)
                    barrier = DataFrame()
                    await transport.input().queue_frame(barrier)
                    self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
                    self.assertEqual(command.await_args_list, [call(item) for item in argv])
                    self.assertEqual(len(brain.requests), 2 * index + 2)
                    if name == 'mute':
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                    if name == 'unmute':
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Unmuted.')
                    if name == 'set_volume':
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Volume 30.')
                    self.assertTrue(spoken.empty())
                    self.assertTrue(committed.empty())
        finally:
            await close()

    async def test_typed_latest_owner_preserves_accepted_actions_without_replay(self):
        first_started, release_first, second_queued = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.addCleanup(release_first.set)
        calls, effects = [], []
        level, muted = 32768, False

        async def command(argv):
            nonlocal level, muted
            calls.append(tuple(argv))
            if argv[:2] == ('/usr/bin/pactl', 'get-default-sink'):
                return 'selected'
            if argv[0] == '/usr/bin/omarchy-audio-output-sink':
                return 'physical'
            if 'get-sink-volume' in argv:
                return LocalVolumeTests.volume(level)
            if 'get-sink-mute' in argv:
                return 'Mute: yes' if muted else 'Mute: no'
            if 'set-sink-volume' in argv:
                first_started.set()
                await release_first.wait()
                level = 19660
                effects.append('volume')
                return ''
            if 'set-sink-mute' in argv:
                muted = True
                effects.append('mute')
                return ''
            raise AssertionError(f'Unexpected native command: {argv}')

        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nPrepared.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        transport, spoken, committed, interrupted, _, close = await self.open_session(
            brain, through_service=True, local_command=command,
        )
        service, manager = transport.service, transport.service.manager
        await asyncio.wait_for(asyncio.shield(service.channel.preparation), 5)
        original_run = manager.local_actions._run

        async def retained(tool, *, admitted, observe=None):
            if tool.subject == 'mute':
                second_queued.set()
            return await original_run(tool, admitted=admitted, observe=observe)

        with patch.object(manager.local_actions, '_run', side_effect=retained):
            self.assertEqual(await service.submit('volume thirty percent'), 'accepted')
            await asyncio.wait_for(first_started.wait(), 5)
            self.assertEqual(await service.submit('mute'), 'accepted')
            await asyncio.wait_for(second_queued.wait(), 5)
            self.assertEqual(await service.submit('repeat that'), 'accepted')
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
            release_first.set()
            await asyncio.wait_for(manager.local_actions.drain(), 5)
        self.assertEqual(effects, ['volume', 'mute'])
        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-volume', 'physical', '30%')), 1)
        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
        self.assertEqual(manager.llm.last_spoken_reply, "I haven't said anything to repeat yet.")
        self.assertTrue(spoken.empty())
        self.assertTrue(committed.empty())
        old_frozen, release_old, old_rejected = asyncio.Event(), asyncio.Event(), asyncio.Event()
        interruption_held, release_interruption = asyncio.Event(), asyncio.Event()
        self.addCleanup(release_old.set)
        self.addCleanup(release_interruption.set)
        native_process, native_queue = manager.llm.process_frame, manager.llm.queue_frame
        origins, acknowledgements = [], []
        hold_interruption = False

        async def process(frame, direction):
            if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
                origin = getattr(frame, 'request_origin', None)
                if origin is not None and origin[1] == 'spoken':
                    origins.append(origin)
                    old_frozen.set()
                    await release_old.wait()
                    await native_process(frame, direction)
                    old_rejected.set()
                    return
            await native_process(frame, direction)

        async def queue(frame, direction=FrameDirection.DOWNSTREAM, callback=None):
            if hold_interruption and isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
                interruption_held.set()
                await release_interruption.wait()
            await native_queue(frame, direction, callback)

        original_ack = manager.admission.take_typed

        def acknowledge(token):
            acknowledgements.append(token)
            original_ack(token)

        with patch.object(manager.llm, 'process_frame', side_effect=process), \
                patch.object(manager.llm, 'queue_frame', side_effect=queue), \
                patch.object(manager.admission, 'take_typed', side_effect=acknowledge):
            interrupted.clear()
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await asyncio.wait_for(interrupted.wait(), 5)
            await self.finish_user_turn(transport, 'mute')
            await asyncio.wait_for(old_frozen.wait(), 5)
            before = list(manager.conversation.turns)
            hold_interruption = True
            self.assertEqual(await service.submit('repeat that'), 'accepted')
            new_token = manager.handover.ticket
            self.assertIsNot(origins[0][0], new_token)
            await asyncio.wait_for(interruption_held.wait(), 5)
            release_old.set()
            await asyncio.wait_for(old_rejected.wait(), 5)
            self.assertEqual(manager.conversation.turns, before)
            self.assertEqual(acknowledgements, [])
            self.assertEqual(effects, ['volume', 'mute'])
            release_interruption.set()
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), "I haven't said anything to repeat yet.")
            self.assertEqual(acknowledgements, [new_token])
        self.assertEqual(effects, ['volume', 'mute'])
        self.assertEqual(len(brain.requests), 1)
        self.assertEqual([t['text'] for t in manager.conversation.turns if t['speaker'] == 'you'],
                         ['volume thirty percent', 'mute', 'repeat that', 'repeat that'])
        self.assertTrue(spoken.empty())
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

        async def observe(tool, *, admitted, observe=None):
            if tool.subject == 'mute':
                queued.set()
            return await native_run(tool, admitted=admitted, observe=observe)

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
                self.assertFalse(transport.admission.is_open())
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
                return 'null' if stdin_data == b'UnknownApp' else '{"id": "fixture.desktop", "name": "Fixtureapp"}'
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
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Opening Fixtureapp.')
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
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Opening Fixtureapp.')
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
                return '{"id": "fixture.desktop", "name": "FixtureApp"}'
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
                    return '{"id": "fixture.desktop", "name": "FixtureApp"}'
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

            async def observe(tool, *, admitted, observe=None):
                actions.append(asyncio.current_task())
                if len(actions) == 2:
                    queued.set()
                return await native_run(tool, admitted=admitted, observe=observe)

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
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Opening FixtureApp.')
                    self.assertTrue(spoken.empty(), 'Interrupted failure cannot queue stale speech')
                    self.assertTrue(committed.empty())
                    self.assertEqual([a[0] for a in calls],
                                     ['/usr/bin/env', '/usr/bin/uwsm-app', '/usr/bin/env', '/usr/bin/uwsm-app'])
                    self.assertEqual(owners, actions)
                    await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                    await self.finish_user_turn(transport, 'repeat that')
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Opening FixtureApp.')
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
                            return '{"id": "fixture.desktop", "name": "FixtureApp"}'
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
            for phrase, expected in ((' TAKE A SCREENSHOT! ', 'Screenshot saved.'), ('take a screenshot', advisory)):
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
                        self.transcription(transport, 'take a screenshot', '', '2026-01-01T00:00:00Z', finalized=True))
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
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Screenshot saved.')
                self.assertTrue(spoken.empty(), 'The stale failure stays silent and the confirmed save speaks once without an engine')
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
                        self.transcription(transport, 'workspace three', '', '2026-01-01T00:00:00Z', finalized=True))
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
            async def observe(tool, *, admitted, observe=None):
                actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'next track':
                    queued.set()
                return await native_run(tool, admitted=admitted, observe=observe)
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
        answers = iter([
            'selected', 'physical', LocalVolumeTests.volume(32768), 'Mute: yes', '',
            LocalVolumeTests.volume(19660), '', 'selected', 'physical', LocalVolumeTests.volume(19660), 'Mute: no',
        ])
        last_answer_held, release_last_answer = asyncio.Event(), asyncio.Event()

        async def answer(argv):
            reply = next(answers)
            if reply == 'Mute: no':
                last_answer_held.set()
                await release_last_answer.wait()
            return reply

        command = AsyncMock(side_effect=answer)
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
            await asyncio.wait_for(last_answer_held.wait(), 5)
            barrier = DataFrame()
            await transport.llm.push_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
            self.assertTrue(spoken.empty(), 'Volume confirmation waits for the confirmed result')
            release_last_answer.set()
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Volume 30.')
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
                    hermes_worker.SYSTEM_PROMPT,
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

    async def test_capability_help_is_spoken_locally_without_history(self):
        expected = bot.capability_help()
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
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
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
        await transport.input().queue_frame(self.transcription(transport, 'repeat that', '', '2026-01-01T00:00:00Z', finalized=True))
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

    async def test_exact_mute_says_muting_first_makes_no_brain_request_and_stays_out_of_history(self):
        brain = ScriptedBrain([[({'content': '[delivery:neutral]\nOrdinary reply.'}, None), ({}, 'stop')]])
        self.addCleanup(brain.close)
        completed = asyncio.Event()
        queued = asyncio.Event()
        played = asyncio.Event()
        replies = iter(['selected', 'physical', 'Mute: no', '', 'selected', 'physical', 'Mute: yes'])
        calls = []
        early = []

        async def command(argv):
            calls.append(argv)
            if not played.is_set():
                early.append(argv)
            result = next(replies)
            if len(calls) == 7:
                completed.set()
            return result

        transport, spoken, committed, _, _, _ = await self.open_session(brain, local_command=command)
        output = transport.output()

        @output.event_handler('on_after_process_frame')
        async def stop_queued(processor, frame):
            if isinstance(frame, TTSStoppedFrame):
                queued.set()

        @output.event_handler('on_after_push_frame')
        async def stop_played(processor, frame):
            if isinstance(frame, TTSStoppedFrame):
                played.set()

        output.write_gate.clear()
        with patch.object(bot.logger, 'warning', wraps=bot.logger.warning) as warning:
            await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
            await self.finish_user_turn(transport, ' MUTE! ')
            await asyncio.wait_for(queued.wait(), 5)
            self.assertEqual(calls, [], 'Mute waits while Muting. is still being played')
            output.write_gate.set()
            await asyncio.wait_for(completed.wait(), 5)
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
            self.assertEqual(early, [])
            # TTS serializes this barrier after earlier speech, before a new turn can interrupt it.
            barrier = DataFrame()
            await transport.input().queue_frame(barrier)
            self.assertIs(await asyncio.wait_for(transport.processed.get(), 5), barrier)
        self.assertEqual([entry for entry in warning.call_args_list
                          if str(entry.args[0]).startswith("Playback of 'Muting.'")], [])
        self.assertTrue(spoken.empty(), 'Confirmed mute adds nothing after Muting.')
        await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
        await self.finish_user_turn(transport, 'An ordinary conversation turn.')
        self.assertEqual(await asyncio.wait_for(committed.get(), 5), 'Ordinary reply.')
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Ordinary reply.')
        self.assertTrue(spoken.empty(), 'Mute speaks nothing after it runs')
        self.assertEqual(calls.count(('/usr/bin/pactl', 'set-sink-mute', 'physical', '1')), 1)
        self.assertEqual(len(brain.requests), 1)
        request = brain.requests[0][2]
        self.assertEqual([m for m in request['messages'] if m['role'] != 'system'], [
            {'role': 'user', 'content': 'An ordinary conversation turn.'},
        ])
        self.assertEqual({tool['function']['name'] for tool in request['tools']}, {'memory', 'mute', 'unmute', 'set_volume', 'pause_media', 'next_track', 'focus_workspace', 'open_app', 'take_screenshot', 'delete_note'})
        self.assertIn(
            hermes_worker.SYSTEM_PROMPT,
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

            async def observe_action(tool, *, admitted, observe=None):
                action_tasks[tool.subject] = asyncio.current_task()
                entered[tool.subject].set()
                result = await native_run(tool, admitted=admitted, observe=observe)
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
                    self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
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

            async def observe_shutdown_action(tool, *, admitted, observe=None):
                owned_actions[tool.subject] = asyncio.current_task()
                if tool.subject == 'mute':
                    queued_entered.set()
                return await native_run(tool, admitted=admitted, observe=observe)

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
                self.transcription(transport, segment, '', '2026-01-01T00:00:00Z', finalized=True),
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
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Volume 30.')
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
            self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
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
            self.transcription(transport, 'mute', '', '2026-01-01T00:00:00Z', finalized=True),
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
        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
        self.assertFalse(release.is_set())
        release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        await asyncio.wait_for(asyncio.shield(transport.llm.channel.preparation or transport.llm.channel.reader), 5)
        self.assertTrue(spoken.empty(), 'Nothing after Muting. and no obsolete tail may be spoken')
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
                      patch.object(tool_actions, 'MUTE_TIMEOUT', 0.01 if reason == 'timeout' else 5)):
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
                        self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
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
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
                interrupted.clear()
                await transport.input().queue_frame(ProposedUserStartedSpeakingFrame())
                await asyncio.wait_for(interrupted.wait(), 5)
                self.assertFalse(cancelled.is_set(), 'Speech interruption must not cancel an attempted local action')
                release_write.set()
                await asyncio.wait_for(notified.wait(), 5)
                await asyncio.wait_for(asyncio.shield(action_tasks[0]), 5)
                await self.finish_user_turn(transport, 'repeat that')
                self.assertEqual(await asyncio.wait_for(spoken.get(), 5), 'Muting.')
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


if __name__ == '__main__':
    unittest.main()
