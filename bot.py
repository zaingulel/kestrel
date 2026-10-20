"""Local Kestrel conversation orchestration."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass, replace
from functools import partial
from enum import Enum
import json
import os
import pwd
import re
import signal
import stat
import tempfile
import time

import torch
from loguru import logger
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, StartFrame, UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame, ProposedUserStoppedSpeakingFrame, LLMMessagesAppendFrame, LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    TTSSpeakFrame, TTSTextFrame, InterruptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from desktop.conversation import ConversationFeed
from desktop.control import ConversationControl
from desktop.status import IndicatorStatus
from app_resolver import valid_app_text, valid_desktop_id
from hermes_worker import DELIVERY_LABELS, DESKTOP_TOOLS, HERMES_PYTHON, MEMORY_ERROR, child_environment, valid_desktop_arguments
from speech import ConversationSynthesisFailedFrame, EchoRemoval, LaptopAudioTransport, NemotronRecognizer, NemotronSTT, ROOT, SpeechAdvisoryFrame, VoxCPMTTS, load_voice_preset
from wakeword import WakeWordDetector, ADVICE as WAKE_ADVICE

ECHO_REMOVAL = EchoRemoval()
ENGINE_TIMEOUT = 45
MUTE_TIMEOUT = 5
VOLUME_TIMEOUT = 5
DESKTOP_TIMEOUT = 5
LOCAL_COMMAND_TIMEOUT = 2
LOCAL_COMMAND_CLEANUP_TIMEOUT = 1
SCREENSHOT_COMMAND = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')


class PermissionTier(Enum):
    FREE = 'free'
    ASK = 'ask'
    FORBIDDEN = 'forbidden'


@dataclass(frozen=True)
class LocalTool:
    permission: PermissionTier
    run: object
    subject: str
    spoken: str


@dataclass(frozen=True)
class AudioResult:
    confirmed: bool
    attempted: bool
    reason: str


@dataclass(frozen=True)
class DesktopResult:
    confirmed: bool
    attempted: bool
    reason: str
    message: str | None


@dataclass(frozen=True)
class AppLaunchResult:
    accepted: bool
    attempted: bool
    reason: str
    message: str | None


async def run_local_command(argv, *, stdin_data: bytes | None = None):
    # Native media status may embed cover art; only that read needs a larger allowance.
    budget = (4 * 1024 * 1024 if tuple(argv) == ('/usr/bin/omarchy-shell', 'media', 'status')
              else 4096)
    uid = os.getuid()
    env = {
        'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
        'XDG_RUNTIME_DIR': f'/run/user/{uid}',
        'PULSE_SERVER': f'unix:/run/user/{uid}/pulse/native',
        'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus',
    }
    screenshot = tuple(argv) == SCREENSHOT_COMMAND
    if screenshot or argv[0] in ('/usr/bin/omarchy-shell', '/usr/bin/hyprctl'):
        for key in ('WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE'):
            value = os.environ.get(key, '')
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,256}', value):
                raise RuntimeError('desktop session unavailable')
            env[key] = value
        if screenshot or argv[0] == '/usr/bin/omarchy-shell':
            env['OMARCHY_PATH'] = '/usr/share/omarchy'
    if screenshot:
        env['HOME'] = pwd.getpwuid(uid).pw_dir
        for key in ('OMARCHY_SCREENSHOT_DIR', 'XDG_PICTURES_DIR'):
            if key in os.environ:
                value = os.environ[key]
                if (not os.path.isabs(value) or len(value) > 4096
                        or re.search(r'[\x00-\x1f\x7f-\x9f]', value)):
                    raise RuntimeError('screenshot destination unavailable')
                env[key] = value
    process = None

    async def reap():
        if process is None:
            return
        if stdin_data is not None:
            process.stdin.close()
        # Closing the read pipe prevents buffered output from holding process.wait open.
        process.stdout._transport.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), LOCAL_COMMAND_CLEANUP_TIMEOUT)
        except TimeoutError:
            pass
        # The leader may exit while descendants still own the session's pipes.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()

    async def finish_cleanup():
        cleanup = asyncio.create_task(reap())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        await cleanup
        if cancelled:
            raise asyncio.CancelledError

    try:
        async with asyncio.timeout(LOCAL_COMMAND_TIMEOUT):
            process = await asyncio.create_subprocess_exec(
                *argv, env=env, stdin=asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            if stdin_data is not None:
                process.stdin.write(stdin_data)
                await process.stdin.drain()
                process.stdin.close()
                await process.stdin.wait_closed()
            output = bytearray()
            while chunk := await process.stdout.read(budget + 1 - len(output)):
                output.extend(chunk)
                if len(output) > budget:
                    raise RuntimeError('output too large')
            if await process.wait() != 0:
                raise RuntimeError('command failed')
            try:
                return output.decode('utf-8', errors='strict')
            except UnicodeDecodeError:
                raise RuntimeError('invalid output') from None
    except asyncio.CancelledError:
        await finish_cleanup()
        raise
    except (OSError, RuntimeError, TimeoutError) as error:
        await finish_cleanup()
        if isinstance(error, TimeoutError):
            reason = 'command timeout'
        elif isinstance(error, OSError):
            reason = 'command unavailable'
        else:
            reason = str(error)
        raise RuntimeError(reason) from None


async def read_output_name(argv, *, command=run_local_command) -> str:
    name = (await command(argv)).removesuffix('\n')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}', name):
        raise ValueError('invalid sink')
    return name


async def read_selected_output(*, command=run_local_command) -> tuple[str, str]:
    default = await read_output_name(('/usr/bin/pactl', 'get-default-sink'), command=command)
    sink = await read_output_name(('/usr/bin/omarchy-audio-output-sink', default), command=command)
    return default, sink


async def read_output_mute(sink: str, *, command=run_local_command) -> str:
    status = (await command(('/usr/bin/pactl', 'get-sink-mute', sink))).removesuffix('\n')
    if status not in ('Mute: yes', 'Mute: no'):
        raise ValueError('invalid status')
    return status


async def mute_output(*, command=run_local_command):
    attempted = False
    try:
        async with asyncio.timeout(MUTE_TIMEOUT):
            default, sink = await read_selected_output(command=command)
            already_muted = await read_output_mute(sink, command=command) == 'Mute: yes'
            if not already_muted:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '1'))
            after_default, after_sink = await read_selected_output(command=command)
            status = await read_output_mute(sink, command=command)
            if default != after_default or sink != after_sink:
                return AudioResult(False, attempted, 'target changed')
            if status != 'Mute: yes':
                return AudioResult(False, attempted, 'readback unconfirmed')
            return AudioResult(True, attempted, 'already muted' if already_muted else 'confirmed')
    except TimeoutError:
        return AudioResult(False, attempted, 'mute timeout')
    except ValueError as error:
        return AudioResult(False, attempted, str(error))
    except RuntimeError:
        return AudioResult(False, attempted, 'command failed')


async def notify_audio_failure(subject: str, *, command=run_local_command) -> bool:
    try:
        await command((
            '/usr/bin/notify-send', '--app-name=Kestrel', '--transient',
            '--hint=boolean:suppress-sound:true',
            f'{subject.title()} could not be confirmed',
            'Check the audio control. Kestrel will not retry.',
        ))
    except RuntimeError:
        logger.error(f'{subject.title()} failure notification unavailable')
        return False
    # Command acceptance does not establish visible delivery by the desktop.
    return True


async def read_output_volume(sink: str, *, command=run_local_command) -> dict[str, int]:
    output = await command(('/usr/bin/pactl', '--format=json', 'get-sink-volume', sink))

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('invalid volume')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('invalid volume')

    try:
        data = json.loads(output, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        if not isinstance(data, dict):
            raise ValueError
        volume = data.get('volume')
        if not isinstance(volume, dict) or not 1 <= len(volume) <= 32:
            raise ValueError
        values = {}
        for name, channel in volume.items():
            if not name or not isinstance(channel, dict):
                raise ValueError
            value = channel.get('value')
            if type(value) is not int or not 0 <= value <= 2147483647:
                raise ValueError
            values[name] = value
        return values
    except (ValueError, RecursionError):
        raise ValueError('invalid volume') from None


async def volume_output(percent: int, *, command=run_local_command) -> AudioResult:
    attempted = False
    target = percent * 65536 // 100
    try:
        async with asyncio.timeout(VOLUME_TIMEOUT):
            default, sink = await read_selected_output(command=command)
            initial = await read_output_volume(sink, command=command)
            expected = {channel: target for channel in initial}
            muted = await read_output_mute(sink, command=command) == 'Mute: yes'
            if initial != expected:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-volume', sink, f'{percent}%'))
                verified = await read_output_volume(sink, command=command)
                if verified != expected:
                    return AudioResult(False, attempted, 'readback unconfirmed')
            if muted:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '0'))
            after_default, after_sink = await read_selected_output(command=command)
            after = await read_output_volume(sink, command=command)
            status = await read_output_mute(sink, command=command)
            if default != after_default or sink != after_sink:
                return AudioResult(False, attempted, 'target changed')
            if after != expected or status != 'Mute: no':
                return AudioResult(False, attempted, 'readback unconfirmed')
            return AudioResult(True, attempted, 'confirmed' if attempted else 'already set')
    except TimeoutError:
        return AudioResult(False, attempted, 'volume timeout')
    except ValueError as error:
        return AudioResult(False, attempted, str(error))
    except RuntimeError:
        return AudioResult(False, attempted, 'command failed')


def decode_desktop_status(output: str) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('invalid desktop status')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('invalid desktop status')

    try:
        data = json.loads(output, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (ValueError, TypeError, RecursionError):
        raise ValueError('invalid desktop status') from None


async def read_media_status(*, command=run_local_command) -> dict:
    data = decode_desktop_status(await command(('/usr/bin/omarchy-shell', 'media', 'status')))
    if any(type(data.get(key)) is not bool for key in ('hasPlayer', 'playing', 'canGoNext')):
        raise ValueError('invalid media status')
    if any(not isinstance(data.get(key), str)
           for key in ('identity', 'desktopEntry', 'title', 'artist', 'album')):
        raise ValueError('invalid media status')
    if not data['hasPlayer'] and data['playing']:
        raise ValueError('invalid media status')
    return data


async def media_action(action: str, *, command=run_local_command) -> DesktopResult:
    if action not in ('pause', 'next'):
        raise ValueError('invalid media action')
    subject = 'pause' if action == 'pause' else 'next track'
    advisory = f"I couldn't confirm {subject}. Check the media player. I won't retry."
    attempted = False
    try:
        async with asyncio.timeout(DESKTOP_TIMEOUT):
            before = await read_media_status(command=command)
            if not before['hasPlayer'] or not before['playing']:
                return DesktopResult(False, False, 'not playing', "I couldn't find a playing media player.")
            identity = (before['identity'], before['desktopEntry'])
            metadata = tuple(before[key] for key in ('title', 'artist', 'album'))
            if action == 'next' and (not before['canGoNext'] or not all(part.strip() for part in identity) or not before['title'].strip()):
                return DesktopResult(False, False, 'next unavailable', advisory)
            attempted = True
            reply = await command(('/usr/bin/omarchy-shell', 'media', action))
            if reply not in ('ok', 'ok\n'):
                return DesktopResult(False, True, 'action unhandled', advisory)
            for delay in (0, .15, .35):
                if delay:
                    await asyncio.sleep(delay)
                after = await read_media_status(command=command)
                same_player = (after['hasPlayer'] and all(part.strip() for part in identity)
                               and identity == (after['identity'], after['desktopEntry']))
                after_metadata = tuple(after[key] for key in ('title', 'artist', 'album'))
                observed = (not after['playing'] and metadata == after_metadata if action == 'pause' else
                            after['playing'] and bool(after['title'].strip()) and metadata != after_metadata)
                if same_player and observed:
                    return DesktopResult(True, True, 'confirmed', None)
            return DesktopResult(False, True, 'readback unconfirmed', advisory)
    except TimeoutError:
        return DesktopResult(False, attempted, 'desktop timeout', advisory)
    except ValueError:
        return DesktopResult(False, attempted, 'invalid media status', advisory)
    except RuntimeError:
        return DesktopResult(False, attempted, 'command failed', advisory)


async def workspace_action(number: int, *, command=run_local_command) -> DesktopResult:
    if type(number) is not int or not 1 <= number <= 2147483647:
        raise ValueError('invalid workspace')
    advisory = f"I couldn't confirm workspace {number}. Check the desktop. I won't retry."
    attempted = False

    async def current_workspace():
        data = decode_desktop_status(await command(('/usr/bin/hyprctl', '-j', 'activeworkspace')))
        if type(data.get('id')) is not int:
            raise ValueError('invalid workspace status')
        return data['id']

    try:
        async with asyncio.timeout(DESKTOP_TIMEOUT):
            if await current_workspace() == number:
                return DesktopResult(True, False, 'already focused', None)
            attempted = True
            reply = await command(('/usr/bin/hyprctl', 'dispatch', f'hl.dsp.focus({{ workspace = "{number}" }})'))
            if reply not in ('ok', 'ok\n'):
                return DesktopResult(False, True, 'action unhandled', advisory)
            for delay in (0, .15, .35):
                if delay:
                    await asyncio.sleep(delay)
                if await current_workspace() == number:
                    return DesktopResult(True, True, 'confirmed', None)
            return DesktopResult(False, True, 'readback unconfirmed', advisory)
    except TimeoutError:
        return DesktopResult(False, attempted, 'desktop timeout', advisory)
    except ValueError:
        return DesktopResult(False, attempted, 'invalid workspace status', advisory)
    except RuntimeError:
        return DesktopResult(False, attempted, 'command failed', advisory)


async def screenshot_action(*, command=run_local_command) -> DesktopResult:
    advisory = "I couldn't confirm the screenshot. Check your screenshot folder. I won't retry."
    started = time.time_ns()
    try:
        path = (await command(SCREENSHOT_COMMAND)).removesuffix('\n')
        if (not os.path.isabs(path) or re.search(r'[\x00-\x1f\x7f-\x9f]', path)
                or not re.fullmatch(r'screenshot-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.png',
                                    os.path.basename(path))):
            return DesktopResult(False, True, 'screenshot unconfirmed', advisory)
        metadata = os.lstat(path)
        if stat.S_ISREG(metadata.st_mode) and metadata.st_size > 0 and metadata.st_mtime_ns >= started:
            return DesktopResult(True, True, 'confirmed', None)
    except RuntimeError as error:
        return DesktopResult(False, True, str(error), advisory)
    except (OSError, TimeoutError):
        pass
    return DesktopResult(False, True, 'screenshot unconfirmed', advisory)


def app_discovery_environment() -> tuple[str, ...]:
    home = pwd.getpwuid(os.getuid()).pw_dir
    data_home = os.environ.get('XDG_DATA_HOME') or os.path.join(home, '.local/share')
    data_dirs = os.environ.get('XDG_DATA_DIRS') or '/usr/local/share:/usr/share'
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '')
    values = (home, data_home, data_dirs, desktop)
    if any(not valid_app_text(value, 4096) for value in values):
        raise ValueError('invalid app discovery environment')
    if (not os.path.isabs(home) or not os.path.isabs(data_home)
            or not all(os.path.isabs(path) for path in data_dirs.split(':'))
            or (desktop and not re.fullmatch(r'[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*', desktop))):
        raise ValueError('invalid app discovery environment')
    return tuple(f'{key}={value}' for key, value in zip(
        ('HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_CURRENT_DESKTOP'), values,
    ))


async def open_app(desktop_id: str, discovery_env: tuple[str, ...], *, command=run_local_command) -> AppLaunchResult:
    try:
        # systemd-run expands dollars in service arguments; double them once at this boundary.
        await command(('/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env',
                       *(value.replace('$', '$$') for value in discovery_env),
                       '/usr/bin/gtk-launch', desktop_id.replace('$', '$$')))
        return AppLaunchResult(True, True, 'launch accepted', None)
    except (RuntimeError, OSError, TimeoutError):
        return AppLaunchResult(False, True, 'launch unconfirmed',
                               "I couldn't confirm the app opened. Check the desktop. I won't retry.")


def match_app_name(text: str) -> str | None:
    match = re.fullmatch(r'open ([^\r\n?!]+?)[.!]?', text.strip(), re.IGNORECASE)
    if not match:
        return None
    tool = LOCAL_TOOLS['open app']
    if tool.permission is not PermissionTier.FREE:
        return None
    name = match[1].strip()
    if not name or not valid_app_text(name, 1024):
        return None
    return name


async def resolve_app_tool(name: str, *, command=run_local_command) -> LocalTool | None:
    discovery_env = app_discovery_environment()
    output = await command(('/usr/bin/env', *discovery_env, '/usr/bin/python', '-I',
                            str(ROOT / 'app_resolver.py')), stdin_data=name.encode('utf-8'))
    desktop_id = json.loads(output)
    if desktop_id is None:
        return None
    if not valid_desktop_id(desktop_id):
        raise ValueError('invalid app resolution')
    tool = LOCAL_TOOLS['open app']
    return replace(tool, run=partial(tool.run, desktop_id, discovery_env))


LOCAL_TOOLS = {
    'mute': LocalTool(PermissionTier.FREE, mute_output, 'mute', 'mute'),
    'volume': LocalTool(PermissionTier.FREE, volume_output, 'volume', 'set the volume to thirty'),
    'pause music': LocalTool(PermissionTier.FREE, partial(media_action, 'pause'), 'pause', 'pause music'),
    'next track': LocalTool(PermissionTier.FREE, partial(media_action, 'next'), 'next track', 'next track'),
    'workspace': LocalTool(PermissionTier.FREE, workspace_action, 'workspace', 'workspace three'),
    'open app': LocalTool(PermissionTier.FREE, open_app, 'open app', "open followed by an installed app's exact name"),
    'take a screenshot': LocalTool(PermissionTier.FREE, screenshot_action, 'screenshot', 'take a screenshot'),
}


NUMBER_BASE_WORDS = (
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
)
NUMBER_TENS = ('twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety')
NUMBER_WORDS = {
    **{name: value for value, name in enumerate(NUMBER_BASE_WORDS)},
    **{name: value * 10 for value, name in enumerate(NUMBER_TENS, 2)},
    **{
        f'{name}{separator}{unit}': value * 10 + digit
        for value, name in enumerate(NUMBER_TENS, 2)
        for digit, unit in enumerate(NUMBER_BASE_WORDS[1:10], 1)
        for separator in (' ', '-')
    },
    'one hundred': 100,
}


def capability_help() -> str:
    free = []
    ask = []
    for tool in LOCAL_TOOLS.values():
        if tool.permission == PermissionTier.FREE:
            free.append(tool.spoken)
        elif tool.permission == PermissionTier.ASK:
            ask.append(tool.spoken)
    if not free and not ask:
        return "No local tools are available. Check Kestrel's setup."
    message = ('You can say: ' + '; '.join(free) + '.' if free else
               'No local tools are available without permission.')
    if ask:
        return (message + ' Permission required: ' + '; '.join(ask)
                + ". These tools aren't available by voice yet.")
    return message + ' None of these tools needs permission first.'


def free_tool(key, *arguments) -> LocalTool | None:
    tool = LOCAL_TOOLS[key]
    if tool.permission is not PermissionTier.FREE:
        return None
    return replace(tool, run=partial(tool.run, *arguments)) if arguments else tool


def local_result_message(tool, result) -> str | None:
    return (result.message if isinstance(result, (DesktopResult, AppLaunchResult)) else
            f"I couldn't confirm {tool.subject}. Check the audio control. I won't retry."
            if not result.confirmed else None)


def brain_result(confirmed, attempted, reason) -> str:
    return json.dumps({'confirmed': confirmed, 'attempted': attempted, 'reason': reason})


def match_instant_tool(text):
    text = text.strip().lower()
    if text in ('mute', 'mute.', 'mute!'):
        return free_tool('mute')
    match = re.fullmatch(r'(pause music|next track|take a screenshot)[.!]?', text)
    if match:
        return free_tool(match[1])
    match = re.fullmatch(r'workspace ([1-9][0-9]{0,9})[.!]?', text)
    if match:
        number = int(match[1])
    else:
        match = re.fullmatch(r'workspace ([a-z -]+)[.!]?', text)
        number = NUMBER_WORDS.get(match[1]) if match else None
    if number is not None and 1 <= number <= 2147483647:
        return free_tool('workspace', number)
    match = re.fullmatch(
        r'(?:(?P<leading_please>please) )?'
        r'(?P<command>volume|set (?:the )?volume(?: to)?) '
        r'(?P<level>0|[1-9][0-9]?|100|[a-z]+(?:[ -][a-z]+)*?)'
        r'(?P<unit> percent| ?%)?(?: (?P<trailing_please>please))?[.!]?', text,
    )
    if not match or (match['leading_please'] and match['trailing_please']):
        return None
    if match['command'] == 'volume' and match['unit'] is None:
        return None
    percent = int(match['level']) if match['level'].isdecimal() else NUMBER_WORDS.get(match['level'])
    if percent is None:
        return None
    return free_tool('volume', percent)


def stop_kestrel():
    os.kill(os.getpid(), signal.SIGTERM)


class HermesRequestChannel:
    def __init__(self):
        self.process = None
        self.home = None
        self.reader = None
        self.preparation = None
        self.output = None
        self.failure = None
        self.failure_advisory = None
        self.lock = asyncio.Lock()
        self.closed = False

    def detach(self, output):
        if self.output is output:
            self.output = None

    def known_unavailable(self) -> bool:
        return (bool(self.failure) and (self.reader is None or self.reader.done())
                and (self.process is None or self.process.returncode is not None))

    async def drain(self):
        if self.reader is not None:
            task = self.reader
            try:
                await asyncio.shield(task)
            finally:
                if task.done():
                    self.reader = None

    async def exchange(self, messages, output, *, admitted, desktop=None):
        await self._request({'messages': messages}, output, admitted=admitted, desktop=desktop)

    async def _request(self, request, output, *, admitted, desktop=None):
        async with self.lock:
            await self.drain()
            if not admitted() or self.closed or self.failure:
                output.put_nowait(None)
                return
            self.output = output
            self.reader = asyncio.create_task(self._exchange(request, output, admitted=admitted, desktop=desktop))
            try:
                await asyncio.shield(self.reader)
            finally:
                self.detach(output)

    async def _open(self):
        try:
            managed_brain = os.environ.get('KESTREL_MANAGED_BRAIN', '')
            if managed_brain not in ('', '1'):
                raise RuntimeError('Invalid KESTREL_MANAGED_BRAIN setting. Restart Kestrel and try again.')
            if managed_brain == '1':
                try:
                    await run_local_command([
                        '/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'kestrel-brain.service',
                    ])
                except Exception as error:
                    raise RuntimeError(f'kestrel-brain.service is unavailable: {error}. Restart Kestrel and try again.') from error
            self.home = tempfile.TemporaryDirectory(prefix='hermes-session-', dir=(ROOT / '.runtime').resolve())
            async with asyncio.timeout(ENGINE_TIMEOUT):
                self.process = await asyncio.create_subprocess_exec(
                    str(HERMES_PYTHON), str(ROOT / 'hermes_worker.py'),
                    env=child_environment(self.home.name),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    limit=1024 * 1024 + 1,
                )
                event = await self.read_event()
                if set(event) != {'ready'} or event['ready'] is not True:
                    raise RuntimeError(event.get('error') or 'Hermes did not become ready')
        except Exception as error:
            self.failure_advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            self.failure = f'Hermes engine unavailable: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self._reap()

    async def prepare(self):
        await self._open()
        if not self.failure:
            await self._request({'prepare': True}, asyncio.Queue(), admitted=lambda: True)

    async def begin_conversation(self, *, admitted) -> bool:
        if self.preparation is not None:
            await asyncio.shield(self.preparation)
        if self.failure:
            raise RuntimeError(self.failure)
        async with self.lock:
            await self.drain()
            if self.failure:
                raise RuntimeError(self.failure)
            self.reader = asyncio.create_task(self._begin(admitted=admitted))
            return await asyncio.shield(self.reader)

    async def _begin(self, *, admitted) -> bool:
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                if not admitted() or self.closed:
                    return False
                self.process.stdin.write(b'{"begin": true}\n')
                await self.process.stdin.drain()
                event = await self.read_event()
                if set(event) == {'session_ready'} and event['session_ready'] is True:
                    return True
                if set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                    advisory = (MEMORY_ERROR if event['error'] == MEMORY_ERROR else
                                "I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
                    raise RuntimeError(event['error'])
                raise RuntimeError('Invalid Hermes conversation readiness response')
        except Exception as error:
            self.failure_advisory = advisory
            self.failure = f'Hermes conversation unavailable: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self._reap()
            raise

    async def read_event(self):
        line = await self.process.stdout.readline()
        if not line or len(line) > 1024 * 1024:
            raise RuntimeError('Hermes exited or returned an oversized response')
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError('Invalid Hermes response')
        return event

    async def _reap(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await asyncio.wait_for(self.process.wait(), 5)

    async def close(self):
        self.closed = True
        self.output = None
        if self.preparation is not None:
            self.preparation.cancel()
            await asyncio.gather(self.preparation, return_exceptions=True)
            self.preparation = None
        errors = []
        reader = self.reader
        known_unavailable = self.known_unavailable()
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
            except Exception as error:
                if not known_unavailable:
                    errors.append(error)
            finally:
                if reader.done():
                    self.reader = None
        try:
            await self._reap()
        except Exception as error:
            errors.append(error)
        finally:
            if self.process is None or self.process.returncode is not None:
                if self.home is not None:
                    try:
                        self.home.cleanup()
                    except Exception as error:
                        errors.append(error)
                    else:
                        self.home = None
                if self.home is None:
                    self.process = None
        if len(errors) == 1:
            raise errors[0]
        if errors:
            raise ExceptionGroup('Hermes channel cleanup failed', errors)  # noqa: F821 - The voice runtime uses Python 3.12.

    async def _exchange(self, request, output, *, admitted, desktop=None):
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                if not admitted():
                    return
                self.process.stdin.write(json.dumps(request).encode() + b'\n')
                await self.process.stdin.drain()
                has_text = False
                delivery = None
                while True:
                    event = await self.read_event()
                    if (set(event) == {'delivery'} and delivery is None
                            and isinstance(event['delivery'], str) and event['delivery'] in DELIVERY_LABELS):
                        delivery = event['delivery']
                        if self.output is output:
                            output.put_nowait(event)
                    elif (set(event) == {'text'} and delivery is not None
                          and isinstance(event['text'], str) and event['text']):
                        has_text = has_text or bool(event['text'].strip())
                        if self.output is output:
                            output.put_nowait(event)
                    elif (set(event) == {'tool_call'} and desktop is not None
                          and isinstance(event['tool_call'], dict)
                          and set(event['tool_call']) == {'name', 'arguments'}
                          and isinstance(event['tool_call']['name'], str)
                          and event['tool_call']['name'] in DESKTOP_TOOLS
                          and isinstance(event['tool_call']['arguments'], dict)):
                        call = event['tool_call']
                        content = await desktop(call['name'], call['arguments'])
                        self.process.stdin.write(json.dumps({'tool_result': content}).encode() + b'\n')
                        await self.process.stdin.drain()
                    elif set(event) == {'done'} and event['done'] is True and has_text:
                        break
                    elif set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                        advisory = (MEMORY_ERROR if event['error'] == MEMORY_ERROR else
                                    "I couldn't get a complete reply from the brain. Restart Kestrel and try again.")
                        raise RuntimeError(event['error'])
                    else:
                        raise RuntimeError('Invalid or incomplete Hermes response')
        except Exception as error:
            self.failure_advisory = advisory
            self.failure = f'Hermes reply failed: {str(error) or type(error).__name__}'
            logger.error(self.failure)
            await self._reap()
        finally:
            if self.output is output:
                output.put_nowait(None)


class LocalActions:
    def __init__(self, *, command=None):
        self.command = command if command is not None else run_local_command
        self.lock = asyncio.Lock()
        self.tasks = set()
        self.closed = False

    def retain(self, task):
        self.tasks.add(task)
        task.add_done_callback(self._completed)
        return task

    def _completed(self, task):
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def run(self, tool, *, admitted):
        task = self.retain(asyncio.create_task(self._run(tool, admitted=admitted)))
        # An already-started external effect belongs to the service, not its caller.
        return await asyncio.shield(task)

    async def _run(self, tool, *, admitted):
        async with self.lock:
            if self.closed or not admitted():
                return None
            started = False
            refused = False

            async def command(argv, **kwargs):
                nonlocal started, refused
                if not started:
                    if self.closed or not admitted():
                        refused = True
                        raise asyncio.CancelledError
                    started = True
                return await self.command(argv, **kwargs)

            try:
                result = await tool.run(command=command)
            except asyncio.CancelledError:
                if not refused:
                    raise
                return None
        confirmed = result.accepted if isinstance(result, AppLaunchResult) else result.confirmed
        if not confirmed:
            logger.error(f'{tool.subject.title()} could not be confirmed: {result.reason}')
            if isinstance(result, AudioResult):
                await notify_audio_failure(tool.subject, command=self.command)
        return result

    async def drain(self):
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)

    async def close(self):
        self.closed = True
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class TypedTurnStopStrategy(BaseUserTurnStopStrategy):
    @property
    def resolves_proposed_turn_stop_frames(self):
        return True

    async def process_frame(self, frame):
        if isinstance(frame, ProposedUserStoppedSpeakingFrame):
            await self.trigger_user_turn_stopped()
        return ProcessFrameResult.CONTINUE


@dataclass
class BrainTurn:
    names: set
    closed: bool = False


class HermesLLMService(LLMService):
    def __init__(self, channel: HermesRequestChannel, *, local_actions: LocalActions, admitted, session_ready, dismiss, status=None, conversation=None, voice_active=None, request_admitted=None, input_epoch=None):
        super().__init__(settings=LLMSettings(
            model=None, system_instruction=None, temperature=None, max_tokens=None,
            top_p=None, top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
            filter_incomplete_user_turns=False, user_turn_completion_config=None,
        ))
        self.output = None
        self.channel = channel
        self.local_actions = local_actions
        self.admitted = admitted
        self.session_ready = session_ready
        self.dismiss = dismiss
        self.voice_active = voice_active or admitted
        self.request_admitted = request_admitted
        self.typed_origin = None
        self.spoken_origin = None
        self.input_epoch = input_epoch if input_epoch is not None else lambda: 0
        self.frame_completions = {}
        self._assistant_reply_token = None
        self._last_spoken_token = None
        self._heard_prefix_token = None
        self.lookup = None
        self.status = status
        self.conversation = conversation
        self._conversation_attempt = None
        self._conversation_interrupting = None
        self._conversation_output_context = None
        self._conversation_output_bytes = 0
        self._conversation_pending_spans = []
        self._conversation_incomplete = False
        self._conversation_synthesis_failed = False
        self._indicator_ready = False
        self._indicator_voice_failed = False
        self._indicator_user = False
        self._indicator_output = False
        self._indicator_pending = False
        self._indicator_reply = object()
        self._indicator_output_reply = None
        self.last_spoken_reply: str | None = None

    def accept_request(self, token):
        self._indicator_reply = token
        self._indicator_output = False
        self._indicator_pending = False

    def owns_request(self, token):
        return token is not None and self.admitted() and token is self._indicator_reply

    def valid_origin(self, frame):
        origin = getattr(frame, 'request_origin', None)
        if origin is None:
            return False
        token, source, message, text, epoch = origin
        return (isinstance(text, str) and self.owns_request(token) and (source != 'spoken' or epoch == self.input_epoch())
                and any(item is message for item in frame.context.get_messages())
                and message.get('role') == 'user' and message.get('content') == text)

    def frame_completed(self, role, frame):
        future = self.frame_completions.get((role, frame.id))
        if future is not None and not future.done():
            future.set_result(None)

    def refresh_indicator(self):
        if self.voice_active() and self.admitted() and self.status is not None and self._indicator_ready:
            state = ('trouble' if self._indicator_voice_failed else
                     'listening' if self._indicator_user else
                     'speaking' if self._indicator_output else
                     'thinking' if self._indicator_pending else
                     'trouble' if self.channel.failure else 'idle')
            self.status.set_state(state)

    def indicator_input_ready(self):
        self._indicator_ready = True
        self.refresh_indicator()

    def indicator_voice_failed(self) -> None:
        if not self._indicator_voice_failed:
            self._indicator_voice_failed = True
            self.refresh_indicator()

    def indicator_user_stopped(self):
        self._indicator_user = False
        self.refresh_indicator()

    def indicator_output_started(self):
        if not self._indicator_user:
            self._indicator_output_reply = self._indicator_reply
            self._indicator_output = True
            self.refresh_indicator()

    def indicator_output_stopped(self):
        if self._indicator_output_reply is self._indicator_reply:
            self._indicator_output = False
            self.refresh_indicator()

    def indicator_user_started(self):
        self.accept_request(object())
        self.spoken_origin = (self._indicator_reply, self.input_epoch())
        self._indicator_user = True
        self._indicator_output = False
        self._indicator_pending = False
        self.refresh_indicator()

    def indicator_reply_finished(self, token):
        if token is self._indicator_reply:
            self._indicator_pending = False
            self.refresh_indicator()

    def finish_conversation_reply(self, token, *, interrupted=False, failed=False):
        if self.admitted() and self.conversation is not None:
            self.conversation.finish(token, interrupted=interrupted, failed=failed)
        if self._conversation_attempt is token:
            self._conversation_attempt = None
            self._conversation_output_context = None
            self._conversation_output_bytes = 0
            self._conversation_pending_spans.clear()
            self._conversation_incomplete = False
            self._conversation_synthesis_failed = False
        if self._conversation_interrupting is token:
            self._conversation_interrupting = None

    def remember_assistant_reply(self, text):
        token = self._assistant_reply_token
        if (self.admitted() and isinstance(text, str) and text.strip()
                and (self.owns_request(token) or (token is not None and token is self._heard_prefix_token
                     and self._last_spoken_token is not self._indicator_reply))):
            self.last_spoken_reply = text
            self._last_spoken_token = token

    def conversation_output(self, frame):
        if isinstance(frame, (TTSStartedFrame, LLMFullResponseStartFrame)):
            context = getattr(frame, 'conversation_audio_context', None)
            self._assistant_reply_token = context.reply_token if context is not None else getattr(frame, 'conversation_reply_token', None)
        self._conversation_feed_output(frame)
        if self.owns_request(self._assistant_reply_token) and isinstance(frame, TTSTextFrame) and not frame.append_to_context and frame.text.strip():
            self.last_spoken_reply = frame.text
            self._last_spoken_token = self._assistant_reply_token

    def _conversation_feed_output(self, frame):
        if not self.admitted() or self.conversation is None:
            return
        if not isinstance(frame, InterruptionFrame) and not self.owns_request(self._conversation_attempt):
            return
        if isinstance(frame, ConversationSynthesisFailedFrame):
            token = frame.context.reply_token
            if token is None or token is not self._conversation_attempt:
                return
            self._conversation_synthesis_failed = True
            if frame.context.output_stopped and self._conversation_output_context is None:
                self.finish_conversation_reply(token, failed=True, interrupted=token is self._conversation_interrupting)
            return
        if isinstance(frame, InterruptionFrame):
            self.finish_conversation_reply(getattr(frame, 'conversation_reply_token', None), interrupted=True)
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            token = frame.indicator_reply_token
            if token is self._conversation_attempt:
                context = self._conversation_output_context
                self.finish_conversation_reply(
                    token, interrupted=token is self._conversation_interrupting,
                    failed=frame.conversation_reply_failed or self._conversation_incomplete or self._conversation_synthesis_failed
                    or bool(self._conversation_pending_spans) or bool(context and context.write_failed),
                )
            return
        if isinstance(frame, TTSStartedFrame):
            context = getattr(frame, 'conversation_audio_context', None)
            if context is not None and context.reply_token is not None and context.reply_token is self._conversation_attempt:
                previous = self._conversation_output_context
                self._conversation_incomplete |= bool(self._conversation_pending_spans) or bool(previous and previous.write_failed)
                self._conversation_output_context = context
                self._conversation_output_bytes = 0
                self._conversation_pending_spans.clear()
            return
        context = self._conversation_output_context
        if isinstance(frame, TTSTextFrame) and frame.text.strip():
            span = getattr(frame, 'conversation_audio_span', None)
            if span is not None and span[0] is not None and span[0] is not context:
                return
            if context is None and self._conversation_attempt is not None:
                self._conversation_incomplete = True
        if context is None or context.reply_token is not self._conversation_attempt:
            return
        if isinstance(frame, TTSAudioRawFrame):
            if frame.sample_rate == 48000 and frame.num_channels == 1 and len(frame.audio) % 2 == 0:
                self._conversation_output_bytes += len(frame.audio)
            else:
                self._conversation_incomplete = True
        elif isinstance(frame, TTSTextFrame) and frame.text.strip():
            if span is None or span[0] is not context or not span[3] or span[2] <= span[1]:
                self._conversation_incomplete = True
            else:
                self._conversation_pending_spans.append(span[2])
        elif isinstance(frame, TTSStoppedFrame):
            if getattr(frame, 'conversation_audio_context', None) is not context:
                return
        else:
            return
        if not context.write_failed:
            while context.pending_text_starts and self._conversation_output_bytes > context.pending_text_starts[0][0]:
                _, text = context.pending_text_starts.pop(0)
                self.conversation.spoken(context.reply_token, text)
            while self._conversation_pending_spans and self._conversation_pending_spans[0] <= self._conversation_output_bytes:
                self._conversation_pending_spans.pop(0)
        if isinstance(frame, TTSStoppedFrame):
            context.output_stopped = True
            self._conversation_incomplete |= bool(self._conversation_pending_spans) or context.write_failed
            self._conversation_pending_spans.clear()
            self._conversation_output_context = None
            self._conversation_output_bytes = 0
            if self._conversation_synthesis_failed:
                self.finish_conversation_reply(context.reply_token, failed=True, interrupted=context.reply_token is self._conversation_interrupting)

    async def push_reply_end(self, token, *, failed=False):
        if not self.owns_request(token):
            return
        end = LLMFullResponseEndFrame()
        # The output queue, not generation completion, owns the visible reply's end.
        end.indicator_reply_token = token
        end.conversation_reply_failed = failed
        await self.push_frame(end)

    async def speak_local_reply(self, message, token):
        if not self.owns_request(token):
            return
        if self.conversation is not None:
            self._conversation_attempt = token
            self._conversation_incomplete = False
            self._conversation_synthesis_failed = False
            self.conversation.begin_reply(token)
        frame = TTSSpeakFrame(message, append_to_context=False)
        frame.conversation_reply_token = self._conversation_attempt
        await self.push_frame(frame)
        await self.push_reply_end(token)

    async def desktop_call(self, turn, token, output, name, arguments) -> str:
        def advise(text):
            if self.channel.output is output and self.owns_request(token):
                output.put_nowait({'advisory': text})

        if not valid_desktop_arguments(name, arguments):
            turn.closed = True
            advise("I couldn't use that request, so I didn't change anything.")
            return brain_result(False, False, 'invalid arguments')
        if name in turn.names:
            return brain_result(False, False, 'already attempted')
        turn.names.add(name)
        if turn.closed:
            return brain_result(False, False, 'turn closed')
        key, _, bounds = DESKTOP_TOOLS[name]
        tool = free_tool(key, *(arguments[key] for key in bounds))
        if tool is None:
            turn.closed = True
            advise("That needs permission, which isn't available by voice yet. I didn't change anything.")
            return brain_result(False, False, 'permission required')
        result = await self.local_actions.run(tool, admitted=self.admitted)
        if result is None:
            return brain_result(False, False, 'conversation ended')
        if not result.confirmed:
            turn.closed = True
            advise(local_result_message(tool, result))
        return brain_result(result.confirmed, result.attempted, result.reason)

    def revoke(self):
        self.channel.detach(self.output)
        self.output = None
        self.last_spoken_reply = None
        if self.lookup is not None:
            self.lookup.cancel()

    async def process_frame(self, frame, direction):
        user_request = isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM and not frame.speculation
        if user_request and not self.valid_origin(frame):
            return
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            frame.conversation_reply_token = self._conversation_attempt
            self._conversation_interrupting = self._conversation_attempt
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        if not user_request or not self.valid_origin(frame):
            return
        token, source, original, text, _ = frame.request_origin
        self._indicator_user = False
        self._indicator_pending = True
        self.refresh_indicator()
        messages = frame.context.get_messages()

        def remove_original():
            for index, message in enumerate(messages):
                if message is original:
                    del messages[index]
                    break

        if self.conversation is not None:
            self.conversation.user(text, source=source)
        if source == 'typed':
            self.typed_origin = None
            if self.request_admitted is not None:
                self.request_admitted(token)
        if re.fullmatch(r"that(?:['’]?s| is) all[.!]?", text.strip().lower()):
            # Dismissal discards this context and revokes reply ownership, so no reply end or history removal follows.
            self.dismiss()
            return
        if re.fullmatch(r'(stop|cancel)[.!]?', text.strip().lower()):
            self.finish_conversation_reply(self._conversation_attempt, interrupted=True)
            remove_original()
            await self.push_reply_end(token)
            return
        if re.fullmatch(r'repeat that[.!?]?', text.strip().lower()):
            remove_original()
            await self.speak_local_reply(self.last_spoken_reply or "I haven't said anything to repeat yet.", token)
            return
        if re.fullmatch(r'what can i say[.!?]?', text.strip().lower()):
            remove_original()
            await self.speak_local_reply(capability_help(), token)
            return
        tool = match_instant_tool(text)
        name = match_app_name(text) if tool is None else None
        if name is not None:
            lookup = asyncio.create_task(resolve_app_tool(name, command=self.local_actions.command))
            self.lookup = self.local_actions.retain(lookup)
            try:
                tool = await lookup
            except asyncio.CancelledError:
                remove_original()
                raise
            except (ValueError, RuntimeError, OSError, TimeoutError):
                remove_original()
                await self.speak_local_reply(
                    "I couldn't check the installed apps. I didn't send an open request. Use the app menu.", token,
                )
                return
        if tool is not None:
            if not self.valid_origin(frame):
                return
            remove_original()
            # LocalActions owns an accepted action independently of later reply ownership.
            result = await self.local_actions.run(tool, admitted=self.admitted)
            if result is None or not self.owns_request(token):
                return
            message = local_result_message(tool, result)
            if message is not None:
                await self.speak_local_reply(message, token)
            else:
                await self.push_reply_end(token)
            return
        output = None
        failed = False
        started = False
        request = None

        async def push_reply_start(delivery):
            if not self.owns_request(token):
                return
            if self.conversation is not None and self._conversation_attempt is not token:
                self._conversation_attempt = token
                self._conversation_incomplete = False
                self._conversation_synthesis_failed = False
                self.conversation.begin_reply(token)
            start = LLMFullResponseStartFrame()
            start.conversation_reply_token = token
            start.speech_delivery = delivery
            await self.push_frame(start)

        try:
            ready = await asyncio.shield(self.session_ready)
            if not self.valid_origin(frame) or not ready:
                return
            await self.channel.drain()
            if not self.valid_origin(frame):
                return
            if self.conversation is not None:
                self._conversation_attempt = token
                self._conversation_incomplete = False
                self._conversation_synthesis_failed = False
                self.conversation.begin_reply(token)
            await self.start_processing_metrics()
            if self.channel.failure:
                raise RuntimeError(self.channel.failure)
            output = asyncio.Queue()
            self.output = output
            if not self.valid_origin(frame):
                return
            turn = BrainTurn(names=set())
            request = asyncio.create_task(self.channel.exchange(
                deepcopy(frame.context.get_messages()), output, admitted=lambda: self.owns_request(token),
                desktop=partial(self.desktop_call, turn, token, output),
            ))
            while event := await output.get():
                if not self.owns_request(token):
                    self.revoke()
                    return
                if 'advisory' in event:
                    if not started:
                        await push_reply_start('neutral')
                        started = True
                    await self.push_frame(SpeechAdvisoryFrame(' ' + event['advisory']))
                    failed = True
                elif not failed:
                    if 'delivery' in event:
                        await push_reply_start(event['delivery'])
                        started = True
                    else:
                        await self.push_frame(LLMTextFrame(event['text']))
            await request
            if self.owns_request(token) and self.channel.failure:
                raise RuntimeError(self.channel.failure)
        except Exception as error:
            failed = True
            logger.error(f'Hermes session cannot answer: {error}')
            advisory = self.channel.failure_advisory or "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            if not started:
                await push_reply_start('neutral')
                started = True
            if self.owns_request(token):
                await self.push_frame(SpeechAdvisoryFrame(' ' + advisory))
        finally:
            self.channel.detach(output)
            if self.output is output:
                self.output = None
            if request is not None:
                if not request.done():
                    request.cancel()
                await asyncio.gather(request, return_exceptions=True)
            await self.stop_processing_metrics()
            if not started:
                await push_reply_start('neutral')
            await self.push_reply_end(token, failed=failed)


class VoiceConversations:
    def __init__(self, *, status, conversation):
        self.status = status
        self.conversation = conversation
        self.recognizer = NemotronRecognizer()
        self.channel = HermesRequestChannel()
        self.local_actions = LocalActions()
        self.generation_lock = asyncio.Lock()
        self.model = None
        self.preset = None
        self.desired_active = False
        self.changed = asyncio.Event()
        self.pipeline = None
        self.cleanup = None
        self.transport = None
        self.llm = None
        self.voice = None
        self.admission = None
        self.capture_owner = None
        self.session_ready = None
        self.failure = None
        self.closed = False
        self.prepared = False
        self.transitioning = False
        self.lifecycle_changed = False
        self.pending_submit = None
        self.submission_task = None
        self.submission_ack = None
        self.input_epoch = 0
        self.ingress = None
        self.stt = None
        self.waiting_transport = None
        self.waiting_owner = None
        self.wake_detector = None
        self.wake_startup = None
        self.wake_interval = None
        self.wake_disabled = False
        self.wake_reply_token = None

    def invalidate_wake(self):
        self.wake_interval = None

    def wake_start(self, interval):
        if self.wake_interval is interval and not self.failure:
            self.toggle()

    def reply_finished(self, token):
        if token is self.wake_reply_token:
            self.wake_reply_token = None
            self.changed.set()

    def wake_failed(self):
        if not self.wake_disabled:
            self.wake_disabled = True
            self.invalidate_wake()
            logger.warning(WAKE_ADVICE)
            self.changed.set()

    async def open_waiting(self, interval):
        detector = self.wake_detector
        await detector.start()
        if self.wake_interval is not interval:
            return
        self.waiting_transport = LaptopAudioTransport(
            ECHO_REMOVAL, on_stopped=self.wake_failed,
            admitted=lambda: self.wake_interval is interval, input_admitted=lambda: False,
            capture_pcm=lambda pcm: detector.submit(pcm) if self.wake_interval is interval else None,
        )
        await self.waiting_transport.open()
        if self.waiting_transport.capture is not None:
            self.waiting_owner = self.status.remember_owner(self.waiting_transport.capture.pid)

    async def close_waiting(self):
        self.invalidate_wake()
        if self.wake_startup is not None:
            self.wake_startup.cancel()
            await asyncio.gather(self.wake_startup, return_exceptions=True)
            self.wake_startup = None
        if self.waiting_transport is not None:
            await self.waiting_transport.close()
            if self.waiting_owner is not None:
                self.status.retire_owner(self.waiting_owner)
                self.waiting_owner = None
            self.waiting_transport = None
        if self.wake_detector is not None:
            await self.wake_detector.close()
            self.wake_detector = None

    def speech_admitted(self):
        return bool(self.admission is not None and self.admission.is_set() and self.desired_active
                    and self.pending_submit is None)

    def submit(self, text):
        if self.closed or self.failure or not self.prepared:
            return 'unavailable'
        if self.transitioning or self.lifecycle_changed or self.pending_submit is not None:
            return 'busy'
        if self.transport is not None and self.ingress is None:
            return 'busy'
        token = object()
        self.input_epoch += 1
        self.invalidate_wake()
        self.wake_reply_token = token
        self.pending_submit = (text, token)
        if self.llm is not None:
            self.llm.accept_request(token)
        self.changed.set()
        return 'accepted'

    def fail_submission(self):
        if self.pending_submit is None:
            return
        text, token = self.pending_submit
        published = self.submission_ack is not None and self.submission_ack.done() and not self.submission_ack.cancelled()
        if not published:
            self.conversation.user(text, source='typed')
        self.conversation.begin_reply(token)
        self.conversation.finish(token, failed=True)

    def request_admitted(self, token):
        if self.pending_submit is not None and self.pending_submit[1] is token:
            if self.submission_ack is not None and not self.submission_ack.done():
                self.submission_ack.set_result(None)

    def ingress_ready(self, worker, user, context):
        self.ingress = (worker, user, context)
        self.changed.set()

    def toggle(self) -> str:
        return self.request_active(not self.desired_active)

    def request_active(self, active: bool) -> str:
        if self.failure or self.closed:
            return 'unavailable'
        self.desired_active = active
        self.lifecycle_changed = True
        self.revoke()
        if not active:
            self.conversation.clear()
        self.status.set_state('starting' if active else 'inactive')
        self.changed.set()
        return 'starting' if active else 'inactive'

    def revoke(self):
        self.invalidate_wake()
        self.wake_reply_token = None
        self.input_epoch += 1
        self.pending_submit = None
        if self.submission_task is not None and self.submission_task is not asyncio.current_task():
            self.submission_task.cancel()
        if self.submission_ack is not None and not self.submission_ack.done():
            self.submission_ack.cancel()
        if self.llm is not None:
            self.llm.typed_origin = None
            for future in self.llm.frame_completions.values():
                if not future.done():
                    future.cancel()
        if self.admission is not None:
            self.admission.clear()
        if self.llm is not None:
            self.llm.revoke()

    async def prepare(self):
        self.preset = load_voice_preset(os.environ.get('KESTREL_VOICE', 'irish-female'))
        self.channel.preparation = asyncio.create_task(self.channel.prepare())
        await self.recognizer.load(self.preset.pcm)
        torch.set_num_threads(4)
        self.model = await asyncio.to_thread(
            VoxCPM.from_pretrained, str(ROOT / '.runtime/models/voxcpm2'),
            load_denoiser=False, optimize=False, device='cuda', local_files_only=True,
        )
        voice = VoxCPMTTS(self.model, self.preset, generation_lock=self.generation_lock)
        has_audio = False
        async for frame in voice.run_tts('Hello.', 'warmup'):
            has_audio |= bool(frame.audio)
        if not has_audio:
            raise RuntimeError('VoxCPM preparation produced no audio')
        self.prepared = True

    async def activate(self, *, capture_enabled=True):
        epoch = self.input_epoch
        await self.conversation.begin_session()
        if self.closed or self.lifecycle_changed or self.input_epoch != epoch or (capture_enabled and not self.desired_active):
            return
        self.admission = asyncio.Event()
        self.admission.set()
        admitted = self.admission.is_set
        self.session_ready = asyncio.create_task(self.channel.begin_conversation(admitted=admitted))
        self.transport = LaptopAudioTransport(ECHO_REMOVAL, on_stopped=self.failed_transport, admitted=admitted,
                                             input_admitted=self.speech_admitted, capture_enabled=capture_enabled,
                                             reply_admitted=lambda token: self.llm is not None and self.llm.owns_request(token))
        self.llm = HermesLLMService(self.channel, local_actions=self.local_actions, admitted=admitted, session_ready=self.session_ready,
                                    dismiss=partial(self.request_active, False), status=self.status, conversation=self.conversation, voice_active=lambda: self.desired_active,
                                    request_admitted=self.request_admitted, input_epoch=lambda: self.input_epoch)
        if self.pending_submit is not None:
            self.llm.accept_request(self.pending_submit[1])
        adapter = self.llm

        def readiness_finished(task):
            if not task.cancelled():
                task.exception()
            if self.llm is adapter and admitted():
                adapter.refresh_indicator()

        self.session_ready.add_done_callback(readiness_finished)
        self.voice = VoxCPMTTS(self.model, self.preset, generation_lock=self.generation_lock, admitted=admitted, reply_admitted=self.llm.owns_request)
        await self.transport.open()
        if self.transport.capture is not None:
            self.capture_owner = self.status.remember_owner(self.transport.capture.pid)
        if not admitted():
            return
        self.stt = NemotronSTT(self.recognizer, admitted=self.speech_admitted, input_epoch=lambda: self.input_epoch)
        self.pipeline = asyncio.create_task(run_conversation(
            self.stt, self.voice, llm=self.llm,
            transport=self.transport, status=self.status, conversation=self.conversation, handle_signals=False,
            on_ingress_ready=self.ingress_ready, on_reply_finished=self.reply_finished,
        ))
        self.pipeline.add_done_callback(lambda task: self.changed.set())

    def failed_transport(self):
        self.failure = self.transport.failure
        self.desired_active = False
        self.revoke()
        self.changed.set()

    async def finish_conversation(self):
        self.revoke()
        if self.submission_task is not None:
            await asyncio.gather(self.submission_task, return_exceptions=True)
            self.submission_task = None
        self.ingress = None
        closing = asyncio.create_task(self.transport.close()) if self.transport is not None else None
        if self.pipeline is not None:
            self.pipeline.cancel()
        outcomes = await asyncio.gather(
            *([closing] if closing is not None else []),
            *([self.pipeline] if self.pipeline is not None else []), return_exceptions=True,
        )
        if self.capture_owner is not None and (closing is None or closing.exception() is None):
            self.status.retire_owner(self.capture_owner)
            self.capture_owner = None
        readiness = await asyncio.gather(
            *([asyncio.shield(self.session_ready)] if self.session_ready is not None else []),
            return_exceptions=True,
        )
        native = await asyncio.gather(self.channel.drain(), return_exceptions=True)
        known_unavailable = self.channel.known_unavailable()
        if not known_unavailable:
            outcomes.extend(readiness)
            outcomes.extend(native)
        outcomes.extend(await asyncio.gather(
            self.recognizer.drain(), self.local_actions.drain(),
            *([asyncio.shield(self.channel.preparation)] if self.channel.preparation is not None else []),
            return_exceptions=True,
        ))
        async with self.generation_lock:
            pass
        if self.voice is not None and self.voice.generation_cleanup_failed:
            raise RuntimeError('Voice generation cleanup failed. Restart Kestrel.')
        if not self.closed and self.recognizer.failure:
            raise RuntimeError(self.recognizer.failure)
        for outcome in outcomes:
            if isinstance(outcome, Exception):
                raise outcome
        if self.transport is not None and self.transport.failure:
            raise RuntimeError(self.transport.failure)
        self.transport = self.pipeline = self.llm = self.voice = self.admission = self.session_ready = None

    async def submit_pending(self):
        text, token = self.pending_submit
        worker, user, _ = self.ingress
        llm = self.llm
        completions = []

        async def completed(role, frame, queue):
            future = asyncio.get_running_loop().create_future()
            llm.frame_completions[(role, frame.id)] = future
            completions.append((role, frame.id))
            await queue(frame)
            await future

        try:
            async with asyncio.timeout(5):
                interruption = InterruptionFrame()
                output_done = asyncio.get_running_loop().create_future()
                assistant_done = asyncio.get_running_loop().create_future()
                for role, future in (('output', output_done), ('assistant', assistant_done)):
                    llm.frame_completions[(role, interruption.id)] = future
                    completions.append((role, interruption.id))
                await worker.queue_frame(interruption)
                await asyncio.gather(output_done, assistant_done)
                await self.stt.discard_pending()
                await user.reset()
                await completed('user', ProposedUserStoppedSpeakingFrame(), user.queue_frame)
                message = {'role': 'user', 'content': text}
                llm.typed_origin = (token, 'typed', message, text, self.input_epoch)
                self.submission_ack = asyncio.get_running_loop().create_future()
                await completed('user', LLMMessagesAppendFrame(messages=[message], run_llm=True), user.queue_frame)
                await self.submission_ack
                self.pending_submit = None
        except Exception:
            self.fail_submission()
            self.failure = 'Kestrel input handover failed. Restart Kestrel.'
            self.desired_active = False
            self.revoke()
            self.status.set_state('trouble')
        finally:
            for key in completions:
                future = llm.frame_completions.pop(key, None)
                if future is not None and not future.done():
                    future.cancel()
            llm.typed_origin = None
            self.submission_ack = None
            self.changed.set()

    async def run(self):
        self.status.set_state('inactive')
        self.changed.set()
        while not self.closed:
            await self.changed.wait()
            self.changed.clear()
            try:
                if self.wake_startup is not None and self.wake_startup.done():
                    if not self.wake_startup.cancelled() and self.wake_startup.exception() is not None:
                        self.wake_failed()
                if (self.wake_detector is not None and
                        (self.desired_active or self.pending_submit is not None or self.wake_disabled
                         or self.lifecycle_changed or self.failure or self.wake_reply_token is not None)):
                    await self.close_waiting()
                if self.submission_task is not None and self.submission_task.done():
                    if not self.submission_task.cancelled():
                        self.submission_task.result()
                    self.submission_task = None
                if self.failure and self.cleanup is not None:
                    self.status.set_state('trouble')
                    continue
                stopped = self.pipeline is not None and self.pipeline.done() and self.admission.is_set()
                if stopped:
                    self.failure = 'Kestrel conversation stopped unexpectedly. Restart Kestrel.'
                if self.transport is not None and (self.lifecycle_changed or self.failure):
                    self.transitioning = True
                    self.cleanup = asyncio.create_task(self.finish_conversation())
                    await asyncio.wait_for(asyncio.shield(self.cleanup), 90)
                if self.failure:
                    raise RuntimeError(self.failure)
                self.lifecycle_changed = False
                if self.transport is None and (self.desired_active or self.pending_submit is not None):
                    self.transitioning = True
                    self.cleanup = None
                    await self.activate(capture_enabled=self.desired_active)
                self.transitioning = False
                if self.pending_submit is not None and self.ingress is not None and self.submission_task is None:
                    self.submission_task = asyncio.create_task(self.submit_pending())
                if not self.desired_active:
                    self.status.set_state('inactive')
                    if self.prepared and not self.wake_disabled and self.pending_submit is None and self.wake_reply_token is None and self.wake_detector is None:
                        interval = object()
                        self.wake_interval = interval
                        self.wake_detector = WakeWordDetector(
                            on_detected=lambda interval=interval: self.wake_start(interval), on_failed=self.wake_failed,
                        )
                        self.wake_startup = asyncio.create_task(self.open_waiting(interval))
                        self.wake_startup.add_done_callback(lambda task: self.changed.set())
            except Exception as error:
                self.fail_submission()
                self.failure = str(error) or 'Kestrel conversation cleanup failed. Restart Kestrel.'
                self.desired_active = False
                self.revoke()
                self.status.set_state('trouble')

    async def close(self):
        self.closed = True
        self.desired_active = False
        self.revoke()
        self.changed.set()
        try:
            try:
                await self.close_waiting()
            finally:
                try:
                    await self.local_actions.close()
                finally:
                    try:
                        await self.channel.close()
                    finally:
                        await self.recognizer.close()
        finally:
            if self.cleanup is not None:
                await asyncio.shield(self.cleanup)
            elif self.transport is not None:
                await self.finish_conversation()


async def run_conversation(stt, voice: VoxCPMTTS, *, llm, transport, user_params=None, handle_signals=False, status=None, conversation=None, on_ingress_ready=None, on_reply_finished=None):
    if user_params is None:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5)), empty_user_turn=None,
            user_turn_strategies=UserTurnStrategies(stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=0.6)),
                ),
                TypedTurnStopStrategy(),
            ]),
        )
    context = LLMContext([])
    aggregators = LLMContextAggregatorPair(context, user_params=user_params)
    assistant = aggregators.assistant()
    llm.conversation = conversation
    if status is not None or conversation is not None:
        llm.status = status

        @transport.input().event_handler('on_after_process_frame')
        async def indicator_input_ready(processor, frame):
            if isinstance(frame, StartFrame):
                llm.indicator_input_ready()

    @aggregators.user().event_handler('on_before_push_frame')
    async def indicator_user_turn(processor, frame):
        if isinstance(frame, UserStartedSpeakingFrame) and stt.admitted():
            llm.indicator_user_started()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            llm.indicator_user_stopped()
        elif isinstance(frame, LLMContextFrame) and not frame.speculation:
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'user':
                message = messages[-1]
                if llm.typed_origin is not None and llm.typed_origin[2] is message:
                    frame.request_origin = llm.typed_origin
                elif llm.spoken_origin is not None:
                    token, epoch = llm.spoken_origin
                    frame.request_origin = (token, 'spoken', message, message.get('content'), epoch)

    @aggregators.user().event_handler('on_after_process_frame')
    async def user_frame_completed(processor, frame):
        llm.frame_completed('user', frame)
        if isinstance(frame, StartFrame) and on_ingress_ready is not None:
            on_ingress_ready(worker, processor, context)

    @assistant.event_handler('on_before_process_frame')
    async def assistant_frame_starting(processor, frame):
        if isinstance(frame, InterruptionFrame):
            llm._heard_prefix_token = getattr(frame, 'conversation_reply_token', None)

    @assistant.event_handler('on_after_process_frame')
    async def assistant_frame_completed(processor, frame):
        if isinstance(frame, InterruptionFrame):
            llm._heard_prefix_token = None
        llm.frame_completed('assistant', frame)

    @transport.output().event_handler('on_after_process_frame')
    async def output_frame_completed(processor, frame):
        llm.frame_completed('output', frame)

    @assistant.event_handler('on_before_push_frame')
    async def remember_assistant_reply(processor, frame):
        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'assistant':
                llm.remember_assistant_reply(messages[-1].get('content'))

    output = transport.output()

    @output.event_handler('on_after_push_frame')
    async def on_output_frame(processor, frame):
        if voice.generation_cleanup_failed:
            llm.indicator_voice_failed()
        if status is not None or conversation is not None:
            if isinstance(frame, BotStartedSpeakingFrame):
                llm.indicator_output_started()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                llm.indicator_output_stopped()
            elif isinstance(frame, LLMFullResponseEndFrame):
                llm.indicator_reply_finished(frame.indicator_reply_token)
        llm.conversation_output(frame)
        if isinstance(frame, LLMFullResponseEndFrame) and on_reply_finished is not None:
            on_reply_finished(frame.indicator_reply_token)

    pipeline = Pipeline([
        transport.input(), stt, aggregators.user(), llm,
        voice, output, assistant,
    ])
    latency_observer = UserBotLatencyObserver()

    @latency_observer.event_handler("on_latency_measured")
    async def on_latency_measured(observer, latency_seconds):
        logger.info(f"{latency_seconds:.3f}")

    worker = PipelineWorker(
        pipeline,
        idle_timeout_secs=None,
        observers=[latency_observer],
        params=PipelineParams(
            audio_in_sample_rate=16000, audio_out_sample_rate=48000,
            enable_metrics=True,
        ),
    )

    runner = WorkerRunner(handle_sigint=handle_signals, handle_sigterm=handle_signals)
    await runner.add_workers(worker)
    logger.info("Kestrel is ready. Speak, pause for a reply, and interrupt naturally.")
    await runner.run()


async def run_voice_service():
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    stopping = False
    echo_failure = None
    orderly = False
    status = IndicatorStatus()
    status.set_state('starting')
    conversation = ConversationFeed()
    conversations = VoiceConversations(status=status, conversation=conversation)
    control = ConversationControl(conversations.toggle, submit=conversations.submit)
    heartbeat = asyncio.create_task(status.heartbeat())

    def cancel():
        nonlocal stopping
        if not stopping:
            stopping = True
            conversations.revoke()
            task.cancel()

    def echo_stopped():
        nonlocal echo_failure
        echo_failure = 'Echo removal has stopped. Restart Kestrel.'
        stop_kestrel()

    try:
        # Owning the command endpoint precedes microphone/model preparation.
        await control.start()
        await conversation.start()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, cancel)
        ECHO_REMOVAL.start(echo_stopped)
        if ECHO_REMOVAL.process is not None:
            status.remember_owner(ECHO_REMOVAL.process.pid)
        try:
            await conversations.prepare()
            await conversations.run()
        except asyncio.CancelledError:
            orderly = stopping
        else:
            orderly = True
    finally:
        try:
            try:
                await conversations.close()
            finally:
                ECHO_REMOVAL.close()
            if orderly and echo_failure is None and not conversations.failure:
                status.mark_released()
            else:
                status.set_state('unavailable')
        except BaseException:
            status.set_state('unavailable')
            raise
        finally:
            await control.close()
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await conversation.close()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)
    if echo_failure:
        raise RuntimeError(echo_failure)


if __name__ == "__main__":
    asyncio.run(run_voice_service())
