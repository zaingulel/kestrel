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
    LLMContextFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame,
    TTSSpeakFrame, TTSTextFrame,
)
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from voxcpm import VoxCPM

from app_resolver import valid_app_text, valid_desktop_id
from hermes_worker import HERMES_PYTHON, child_environment
from speech import EchoRemoval, LaptopAudioTransport, NemotronSTT, ROOT, SpeechAdvisoryFrame, VoxCPMTTS, load_voice_preset

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


class HermesLLMService(LLMService):
    def __init__(self, *, local_command=None):
        super().__init__(settings=LLMSettings(
            model=None, system_instruction=None, temperature=None, max_tokens=None,
            top_p=None, top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
            filter_incomplete_user_turns=False, user_turn_completion_config=None,
        ))
        self.process = None
        self.home = None
        self.reader = None
        self.output = None
        self.failure = None
        self.failure_advisory = None
        self.local_command = local_command if local_command is not None else run_local_command
        self.local_tasks = set()
        self.local_tool_lock = asyncio.Lock()
        self.last_spoken_reply: str | None = None

    async def run_local_tool(self, tool):
        async with self.local_tool_lock:
            result = await tool.run(command=self.local_command)
        confirmed = result.accepted if isinstance(result, AppLaunchResult) else result.confirmed
        if not confirmed:
            logger.error(f'{tool.subject.title()} could not be confirmed: {result.reason}')
            if isinstance(result, AudioResult):
                await notify_audio_failure(tool.subject, command=self.local_command)
        return result

    async def close_local_tools(self):
        tasks = tuple(self.local_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def open_engine(self):
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
            await self.reap_engine()

    def start_preparation(self):
        self.reader = asyncio.create_task(self.prepare_engine())

    async def prepare_engine(self):
        await self.open_engine()
        if not self.failure:
            await self.exchange([{'role': 'user', 'content': 'Hello.'}], asyncio.Queue())

    async def read_event(self):
        line = await self.process.stdout.readline()
        if not line or len(line) > 1024 * 1024:
            raise RuntimeError('Hermes exited or returned an oversized response')
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError('Invalid Hermes response')
        return event

    async def reap_engine(self):
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def close_engine(self):
        if self.reader is not None:
            self.reader.cancel()
            try:
                await self.reader
            except asyncio.CancelledError:
                pass
        await self.reap_engine()
        self.process = None
        self.reader = None
        self.output = None
        self.last_spoken_reply = None
        if self.home is not None:
            self.home.cleanup()
            self.home = None

    async def exchange(self, messages, output):
        advisory = "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
        try:
            async with asyncio.timeout(ENGINE_TIMEOUT):
                self.process.stdin.write(json.dumps({'messages': messages}).encode() + b'\n')
                await self.process.stdin.drain()
                has_text = False
                while True:
                    event = await self.read_event()
                    if set(event) == {'text'} and isinstance(event['text'], str) and event['text']:
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
            await self.reap_engine()
        finally:
            if self.output is output:
                output.put_nowait(None)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.get_messages()
        if (direction == FrameDirection.DOWNSTREAM and not frame.speculation and messages
                and messages[-1].get('role') == 'user'
                and isinstance(messages[-1].get('content'), str)):
            if re.fullmatch(r'(stop|cancel)[.!]?', messages[-1]['content'].strip().lower()):
                messages.pop()
                return
            if re.fullmatch(r'repeat that[.!?]?', messages[-1]['content'].strip().lower()):
                messages.pop()
                await self.push_frame(TTSSpeakFrame(
                    self.last_spoken_reply or "I haven't said anything to repeat yet.",
                    append_to_context=False,
                ))
                return
            if re.fullmatch(r'what can i say[.!?]?', messages[-1]['content'].strip().lower()):
                messages.pop()
                await self.push_frame(TTSSpeakFrame(capability_help(), append_to_context=False))
                return
            tool = match_instant_tool(messages[-1]['content'])
            name = match_app_name(messages[-1]['content']) if tool is None else None
            if name is not None:
                lookup_message = messages[-1]
                lookup = asyncio.create_task(resolve_app_tool(name, command=self.local_command))
                self.local_tasks.add(lookup)
                lookup.add_done_callback(self.local_tasks.discard)
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
                    await self.push_frame(TTSSpeakFrame(
                        "I couldn't check the installed apps. I didn't send an open request. Use the app menu.",
                        append_to_context=False,
                    ))
                    return
            if tool is not None:
                messages.pop()
                task = asyncio.create_task(self.run_local_tool(tool))
                self.local_tasks.add(task)
                task.add_done_callback(self.local_tasks.discard)
                result = await asyncio.shield(task)
                message = (result.message if isinstance(result, (DesktopResult, AppLaunchResult)) else
                           f"I couldn't confirm {tool.subject}. Check the audio control. I won't retry."
                           if not result.confirmed else None)
                if message is not None:
                    await self.push_frame(TTSSpeakFrame(message, append_to_context=False))
                return
        output = None
        try:
            if self.reader is not None:
                # Speech cancellation detaches output; native work still reaches a terminal event.
                await asyncio.shield(self.reader)
            await self.push_frame(LLMFullResponseStartFrame())
            await self.start_processing_metrics()
            if self.failure:
                raise RuntimeError(self.failure)
            output = asyncio.Queue()
            self.output = output
            self.reader = asyncio.create_task(self.exchange(deepcopy(frame.context.get_messages()), output))
            while event := await output.get():
                await self.push_frame(LLMTextFrame(event['text']))
            await asyncio.shield(self.reader)
            if self.failure:
                raise RuntimeError(self.failure)
        except Exception as error:
            logger.error(f'Hermes session cannot answer: {error}')
            advisory = self.failure_advisory or "I couldn't reach Kestrel's engine. Restart Kestrel and try again."
            await self.push_frame(SpeechAdvisoryFrame(' ' + advisory))
        finally:
            if self.output is output:
                self.output = None
            await self.stop_processing_metrics()
            await self.push_frame(LLMFullResponseEndFrame())


def make_llm():
    return HermesLLMService()


async def bot():
    preset = load_voice_preset(os.environ.get("KESTREL_VOICE", "irish-female"))
    transport = LaptopAudioTransport(ECHO_REMOVAL, on_stopped=stop_kestrel)
    stt = NemotronSTT()
    llm = None
    try:
        await transport.open()
        llm = make_llm()
        llm.start_preparation()
        logger.info("Loading local speech models for the conversation")
        await stt.load(preset.pcm)
        torch.set_num_threads(4)
        model = await asyncio.to_thread(
            VoxCPM.from_pretrained, str(ROOT / ".runtime/models/voxcpm2"),
            load_denoiser=False, optimize=False, device="cuda", local_files_only=True,
        )
        voice = VoxCPMTTS(model, preset)
        has_audio = False
        async for frame in voice.run_tts('Hello.', 'warmup'):
            has_audio = has_audio or bool(frame.audio)
        if not has_audio:
            raise RuntimeError('VoxCPM preparation produced no audio')
        await run_conversation(stt, voice, llm=llm, transport=transport, handle_signals=True)
    finally:
        try:
            if llm is not None:
                try:
                    await llm.close_local_tools()
                finally:
                    await llm.close_engine()
        finally:
            try:
                await stt.close()
            finally:
                await transport.close()
                if transport.failure:
                    raise RuntimeError(transport.failure)


async def run_conversation(stt, voice: VoxCPMTTS, *, llm, transport, user_params=None, handle_signals=False):
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

    @assistant.event_handler('on_before_push_frame')
    async def remember_assistant_reply(processor, frame):
        if isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if messages and messages[-1].get('role') == 'assistant':
                text = messages[-1].get('content')
                if isinstance(text, str) and text.strip():
                    llm.last_spoken_reply = text

    output = transport.output()

    @output.event_handler('on_after_push_frame')
    async def remember_local_reply(processor, frame):
        if isinstance(frame, TTSTextFrame) and not frame.append_to_context and frame.text.strip():
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

    def cancel():
        nonlocal stopping
        if not stopping:
            stopping = True
            task.cancel()

    def echo_stopped():
        nonlocal echo_failure
        echo_failure = "Echo removal has stopped. Restart Kestrel."
        stop_kestrel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, cancel)
    try:
        ECHO_REMOVAL.start(echo_stopped)
        try:
            await bot()
        except asyncio.CancelledError:
            pass
    finally:
        ECHO_REMOVAL.close()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
    if echo_failure:
        raise RuntimeError(echo_failure)


if __name__ == "__main__":
    asyncio.run(run_voice_service())
