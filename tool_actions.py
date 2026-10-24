"""Kestrel's tool run steps, the open-app lookup step and the shared safe local-command runner; the engine process never loads this module."""

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import time

from loguru import logger

from app_resolver import valid_app_text, valid_desktop_id

ROOT = Path(__file__).parent

MUTE_TIMEOUT = 5
VOLUME_TIMEOUT = 5
DESKTOP_TIMEOUT = 5
LOCAL_COMMAND_TIMEOUT = 2
LOCAL_COMMAND_CLEANUP_TIMEOUT = 1
# An installed name casefolds to a request of at most 1,024 bytes. Full case folding shrinks a character's UTF-8
# at most threefold (U+212A) and expands it at most threefold (U+0390), so a match is at most 9 * 1,024 bytes.
APP_NAME_BYTES = 9 * 1024
# JSON escaping at most doubles each admitted field; 64 bytes cover the object syntax.
APP_RESOLUTION_BUDGET = 2 * (1024 + APP_NAME_BYTES) + 64
SCREENSHOT_COMMAND = ('/usr/bin/omarchy', 'capture', 'screenshot', 'fullscreen', 'save')


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
    # Native media status may embed cover art, and the app resolver returns an installed name; only those reads
    # need a larger allowance.
    if tuple(argv) == ('/usr/bin/omarchy-shell', 'media', 'status'):
        budget = 4 * 1024 * 1024
    elif tuple(argv[-3:]) == ('/usr/bin/python', '-I', str(ROOT / 'app_resolver.py')):
        budget = APP_RESOLUTION_BUDGET
    else:
        budget = 4096
    uid = os.getuid()
    env = {
        'PATH': '/usr/bin:/bin', 'LC_ALL': 'C.UTF-8',
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


async def set_output_mute(muted: bool, *, command=run_local_command) -> AudioResult:
    wanted = 'Mute: yes' if muted else 'Mute: no'
    attempted = False
    try:
        async with asyncio.timeout(MUTE_TIMEOUT):
            default, sink = await read_selected_output(command=command)
            already_set = await read_output_mute(sink, command=command) == wanted
            if not already_set:
                attempted = True
                await command(('/usr/bin/pactl', 'set-sink-mute', sink, '1' if muted else '0'))
            after_default, after_sink = await read_selected_output(command=command)
            status = await read_output_mute(sink, command=command)
            if default != after_default or sink != after_sink:
                return AudioResult(False, attempted, 'target changed')
            if status != wanted:
                return AudioResult(False, attempted, 'readback unconfirmed')
            return AudioResult(True, attempted, ('already muted' if muted else 'already unmuted') if already_set
                               else 'confirmed')
    except TimeoutError:
        return AudioResult(False, attempted, 'mute timeout' if muted else 'unmute timeout')
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


async def resolve_app(name: str, *, command=run_local_command) -> tuple[dict, tuple[str, ...]] | None:
    discovery_env = app_discovery_environment()
    output = await command(('/usr/bin/env', *discovery_env, '/usr/bin/python', '-I',
                            str(ROOT / 'app_resolver.py')), stdin_data=name.encode('utf-8'))
    match = json.loads(output)
    if match is None:
        return None
    if (not isinstance(match, dict) or match.keys() != {'id', 'name'} or not valid_desktop_id(match['id'])
            or not valid_app_text(match['name'], APP_NAME_BYTES) or not match['name'].strip()):
        raise ValueError('invalid app resolution')
    return match, discovery_env
