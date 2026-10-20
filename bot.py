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
    UserStoppedSpeakingFrame, LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    TTSSpeakFrame, TTSTextFrame, InterruptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from desktop.conversation import ConversationFeed
from desktop.status import IndicatorStatus
from app_resolver import valid_app_text, valid_desktop_id
from hermes_worker import DELIVERY_LABELS, HERMES_PYTHON, child_environment
from speech import ConversationSynthesisFailedFrame, EchoRemoval, LaptopAudioTransport, NemotronRecognizer, NemotronSTT, ROOT, SpeechAdvisoryFrame, VoxCPMTTS, load_voice_preset

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


def match_instant_tool(text):
    text = text.strip().lower()
    if text in ('mute', 'mute.', 'mute!'):
        tool = LOCAL_TOOLS['mute']
        return tool if tool.permission is PermissionTier.FREE else None
    match = re.fullmatch(r'(pause music|next track|take a screenshot)[.!]?', text)
    if match:
        tool = LOCAL_TOOLS[match[1]]
        return tool if tool.permission is PermissionTier.FREE else None
    match = re.fullmatch(r'workspace ([1-9][0-9]{0,9})[.!]?', text)
    if match:
        number = int(match[1])
    else:
        match = re.fullmatch(r'workspace ([a-z -]+)[.!]?', text)
        number = NUMBER_WORDS.get(match[1]) if match else None
    if number is not None and 1 <= number <= 2147483647:
        tool = LOCAL_TOOLS['workspace']
        return replace(tool, run=partial(tool.run, number)) if tool.permission is PermissionTier.FREE else None
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
    tool = LOCAL_TOOLS['volume']
    return replace(tool, run=partial(tool.run, percent)) if tool.permission is PermissionTier.FREE else None


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

    async def drain(self):
        if self.reader is not None:
            task = self.reader
            await asyncio.shield(task)
            if task.done():
                self.reader = None

    async def exchange(self, messages, output, *, admitted):
        async with self.lock:
            await self.drain()
            if not admitted() or self.closed or self.failure:
                output.put_nowait(None)
                return
            self.output = output
            self.reader = asyncio.create_task(self._exchange(messages, output, admitted=admitted))
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
            await self.exchange([{'role': 'user', 'content': 'Hello.'}], asyncio.Queue(), admitted=lambda: True)

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
        if self.reader is not None:
            self.reader.cancel()
            try:
                await self.reader
            except asyncio.CancelledError:
                pass
        await self._reap()
        self.process = None
        self.reader = None
        self.output = None
        if self.home is not None:
            self.home.cleanup()
            self.home = None

    async def _exchange(self, messages, output, *, admitted):
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                if not admitted():
                    return
                self.process.stdin.write(json.dumps({'messages': messages}).encode() + b'\n')
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
                    elif set(event) == {'done'} and event['done'] is True and has_text:
                        break
                    elif set(event) == {'error'} and isinstance(event['error'], str) and event['error'].strip():
                        advisory = "I couldn't get a complete reply from the brain. Restart Kestrel and try again."
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
                raise asyncio.CancelledError
            started = False

            async def command(argv, **kwargs):
                nonlocal started
                if not started:
                    if self.closed or not admitted():
                        raise asyncio.CancelledError
                    started = True
                return await self.command(argv, **kwargs)

            result = await tool.run(command=command)
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


class HermesLLMService(LLMService):
    def __init__(self, channel: HermesRequestChannel, *, local_actions: LocalActions, admitted, status=None, conversation=None):
        super().__init__(settings=LLMSettings(
            model=None, system_instruction=None, temperature=None, max_tokens=None,
            top_p=None, top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
            filter_incomplete_user_turns=False, user_turn_completion_config=None,
        ))
        self.output = None
        self.channel = channel
        self.local_actions = local_actions
        self.admitted = admitted
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
        self._indicator_user = False
        self._indicator_output = False
        self._indicator_pending = False
        self._indicator_reply = object()
        self._indicator_output_reply = None
        self.last_spoken_reply: str | None = None

    def refresh_indicator(self):
        if self.admitted() and self.status is not None and self._indicator_ready:
            state = ('listening' if self._indicator_user else
                     'speaking' if self._indicator_output else
                     'thinking' if self._indicator_pending else
                     'trouble' if self.channel.failure else 'idle')
            self.status.set_state(state)

    def indicator_input_ready(self):
        self._indicator_ready = True
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
        self._indicator_reply = object()
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

    def conversation_output(self, frame):
        if not self.admitted() or self.conversation is None:
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
        if not self.admitted():
            return
        end = LLMFullResponseEndFrame()
        # The output queue, not generation completion, owns the visible reply's end.
        end.indicator_reply_token = token
        end.conversation_reply_failed = failed
        await self.push_frame(end)

    async def speak_local_reply(self, message, token):
        if not self.admitted():
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

    def revoke(self):
        self.channel.detach(self.output)
        self.output = None
        self.last_spoken_reply = None
        if self.lookup is not None:
            self.lookup.cancel()

    def start_preparation(self):
        self.channel.preparation = asyncio.create_task(self.channel.prepare())

    async def process_frame(self, frame, direction):
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            frame.conversation_reply_token = self._conversation_attempt
            self._conversation_interrupting = self._conversation_attempt
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        if not self.admitted():
            self.revoke()
            return
        token = self._indicator_reply
        self._indicator_user = False
        self._indicator_pending = True
        self.refresh_indicator()
        messages = frame.context.get_messages()
        if (direction == FrameDirection.DOWNSTREAM and not frame.speculation and messages
                and messages[-1].get('role') == 'user'
                and isinstance(messages[-1].get('content'), str)):
            if self.conversation is not None:
                self.conversation.user(messages[-1]['content'])
            if re.fullmatch(r'(stop|cancel)[.!]?', messages[-1]['content'].strip().lower()):
                self.finish_conversation_reply(self._conversation_attempt, interrupted=True)
                messages.pop()
                self.indicator_reply_finished(token)
                return
            if re.fullmatch(r'repeat that[.!?]?', messages[-1]['content'].strip().lower()):
                messages.pop()
                await self.speak_local_reply(
                    self.last_spoken_reply or "I haven't said anything to repeat yet.", token,
                )
                return
            if re.fullmatch(r'what can i say[.!?]?', messages[-1]['content'].strip().lower()):
                messages.pop()
                await self.speak_local_reply(capability_help(), token)
                return
            tool = match_instant_tool(messages[-1]['content'])
            name = match_app_name(messages[-1]['content']) if tool is None else None
            if name is not None:
                lookup_message = messages[-1]
                lookup = asyncio.create_task(resolve_app_tool(name, command=self.local_actions.command))
                self.lookup = self.local_actions.retain(lookup)
                try:
                    tool = await lookup
                except asyncio.CancelledError:
                    current_messages = frame.context.get_messages()
                    for index, message in enumerate(current_messages):
                        if message is lookup_message:
                            del current_messages[index]
                            break
                    raise
                except (ValueError, RuntimeError, OSError, TimeoutError):
                    messages.pop()
                    await self.speak_local_reply(
                        "I couldn't check the installed apps. I didn't send an open request. Use the app menu.", token,
                    )
                    return
            if tool is not None:
                messages.pop()
                result = await self.local_actions.run(tool, admitted=self.admitted)
                if not self.admitted():
                    return
                message = (result.message if isinstance(result, (DesktopResult, AppLaunchResult)) else
                           f"I couldn't confirm {tool.subject}. Check the audio control. I won't retry."
                           if not result.confirmed else None)
                if message is not None:
                    await self.speak_local_reply(message, token)
                else:
                    self.indicator_reply_finished(token)
                return
        output = None
        failed = False
        started = False
        request = None

        async def push_reply_start(delivery):
            if not self.admitted():
                return
            start = LLMFullResponseStartFrame()
            start.conversation_reply_token = self._conversation_attempt
            start.speech_delivery = delivery
            await self.push_frame(start)

        try:
            if self.channel.preparation is not None:
                await asyncio.shield(self.channel.preparation)
            await self.channel.drain()
            if not self.admitted():
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
            request = asyncio.create_task(self.channel.exchange(deepcopy(frame.context.get_messages()), output, admitted=self.admitted))
            while event := await output.get():
                if not self.admitted():
                    self.revoke()
                    return
                if 'delivery' in event:
                    await push_reply_start(event['delivery'])
                    started = True
                else:
                    await self.push_frame(LLMTextFrame(event['text']))
            await request
            if self.admitted() and self.channel.failure:
                raise RuntimeError(self.channel.failure)
        except Exception as error:
            failed = True
            logger.error(f'Hermes session cannot answer: {error}')
            advisory = self.channel.failure_advisory or "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            if not started:
                await push_reply_start('neutral')
                started = True
            if self.admitted():
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


def make_llm():
    return HermesLLMService(HermesRequestChannel(), local_actions=LocalActions(), admitted=lambda: True)


async def bot(*, status=None, on_transport_released=None, conversation=None):
    preset = load_voice_preset(os.environ.get("KESTREL_VOICE", "irish-female"))
    transport = LaptopAudioTransport(ECHO_REMOVAL, on_stopped=stop_kestrel)
    recognizer = NemotronRecognizer()
    stt = NemotronSTT(recognizer, admitted=lambda: True)
    llm = None
    try:
        await transport.open()
        if status is not None and transport.capture is not None:
            status.remember_owner(transport.capture.pid)
        llm = make_llm()
        llm.start_preparation()
        logger.info("Loading local speech models for the conversation")
        await recognizer.load(preset.pcm)
        torch.set_num_threads(4)
        model = await asyncio.to_thread(
            VoxCPM.from_pretrained, str(ROOT / ".runtime/models/voxcpm2"),
            load_denoiser=False, optimize=False, device="cuda", local_files_only=True,
        )
        voice = VoxCPMTTS(model, preset, generation_lock=asyncio.Lock())
        has_audio = False
        async for frame in voice.run_tts('Hello.', 'warmup'):
            has_audio = has_audio or bool(frame.audio)
        if not has_audio:
            raise RuntimeError('VoxCPM preparation produced no audio')
        await run_conversation(stt, voice, llm=llm, transport=transport, handle_signals=True, status=status, conversation=conversation)
    finally:
        try:
            if llm is not None:
                try:
                    await llm.local_actions.close()
                finally:
                    await llm.channel.close()
        finally:
            try:
                await recognizer.close()
            finally:
                await transport.close()
                if on_transport_released is not None:
                    on_transport_released()
                if transport.failure:
                    raise RuntimeError(transport.failure)


async def run_conversation(stt, voice: VoxCPMTTS, *, llm, transport, user_params=None, handle_signals=False, status=None, conversation=None):
    if user_params is None:
        user_params = LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5)), empty_user_turn=None,
            user_turn_strategies=UserTurnStrategies(stop=[
                TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=0.6)),
                ),
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
            if isinstance(frame, UserStartedSpeakingFrame):
                llm.indicator_user_started()
            elif isinstance(frame, UserStoppedSpeakingFrame):
                llm.indicator_user_stopped()

    @assistant.event_handler('on_before_push_frame')
    async def remember_assistant_reply(processor, frame):
        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'assistant':
                text = messages[-1].get('content')
                if llm.admitted() and isinstance(text, str) and text.strip():
                    llm.last_spoken_reply = text

    output = transport.output()

    @output.event_handler('on_after_push_frame')
    async def on_output_frame(processor, frame):
        if status is not None or conversation is not None:
            if isinstance(frame, BotStartedSpeakingFrame):
                llm.indicator_output_started()
            elif isinstance(frame, BotStoppedSpeakingFrame):
                llm.indicator_output_stopped()
            elif isinstance(frame, LLMFullResponseEndFrame):
                llm.indicator_reply_finished(frame.indicator_reply_token)
        llm.conversation_output(frame)
        if llm.admitted() and isinstance(frame, TTSTextFrame) and not frame.append_to_context and frame.text.strip():
            llm.last_spoken_reply = frame.text

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
    transport_released = False
    status = IndicatorStatus()
    status.set_state('starting')

    def cancel():
        nonlocal stopping
        if not stopping:
            stopping = True
            task.cancel()

    def echo_stopped():
        nonlocal echo_failure
        echo_failure = "Echo removal has stopped. Restart Kestrel."
        stop_kestrel()

    def transport_closed():
        nonlocal transport_released
        transport_released = True

    conversation = ConversationFeed()
    heartbeat = asyncio.create_task(status.heartbeat())
    try:
        await conversation.start()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, cancel)
        ECHO_REMOVAL.start(echo_stopped)
        if ECHO_REMOVAL.process is not None:
            status.remember_owner(ECHO_REMOVAL.process.pid)
        try:
            await bot(status=status, on_transport_released=transport_closed, conversation=conversation)
        except asyncio.CancelledError:
            orderly = stopping
        else:
            orderly = True
    finally:
        try:
            ECHO_REMOVAL.close()
            if orderly and echo_failure is None and transport_released:
                status.mark_released()
            else:
                status.set_state('unavailable')
        except BaseException:
            status.set_state('unavailable')
            raise
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await conversation.close()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)
    if echo_failure:
        raise RuntimeError(echo_failure)


if __name__ == "__main__":
    asyncio.run(run_voice_service())
