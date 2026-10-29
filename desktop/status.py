"""Private, status-only evidence for the native Kestrel indicator."""

import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

_PROC_ROOT = Path('/proc')
_WIRE = {
    'starting': 'A', 'idle': 'I', 'listening': 'L', 'thinking': 'T', 'speaking': 'S', 'trouble': 'B',
    'trouble-microphone': 'M', 'trouble-playback': 'P', 'trouble-recognition': 'R', 'trouble-voice': 'V',
    'trouble-engine': 'E', 'trouble-notes': 'O', 'trouble-handover': 'H',
    'not-running': 'N', 'unavailable': 'U', 'inactive': 'D', 'inactive-slow': 'W', 'idle-slow': 'Y',
}
_STATES = {'inactive', 'inactive-slow', 'starting', 'idle', 'idle-slow', 'listening', 'thinking', 'speaking',
           'trouble', 'trouble-microphone', 'trouble-playback', 'trouble-recognition', 'trouble-voice',
           'trouble-engine', 'trouble-notes', 'trouble-handover', 'unavailable', 'released'}
_ADVISORY = 'Kestrel indicator status unavailable. Microphone use unknown.'


def _bounded(path: Path, limit: int = 4096) -> bytes:
    with path.open('rb') as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError('Metadata limit')
    return value


def _boot(proc_root: Path) -> str:
    value = _bounded(proc_root / 'sys/kernel/random/boot_id').decode('ascii').strip()
    if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is None:
        raise ValueError('Boot identity')
    return value


def _identity(pid: int, proc_root: Path) -> dict:
    raw = _bounded(proc_root / str(pid) / 'stat').decode('utf-8')
    prefix, closing = raw.find(' ('), raw.rfind(')')
    fields = raw[closing + 2:].split()
    if (prefix < 1 or closing <= prefix or raw[:prefix] != str(pid)
            or len(fields) < 20 or len(fields[0]) != 1 or not fields[19].isdigit()):
        raise ValueError('Process identity')
    start = int(fields[19])
    if start <= 0:
        raise ValueError('Process start')
    return {'pid': pid, 'start_time': start}


def _live(identity: dict, proc_root: Path) -> bool:
    try:
        return _identity(identity['pid'], proc_root) == identity
    except FileNotFoundError:
        if not (proc_root / str(identity['pid'])).exists():
            return False
        raise


def _directory(runtime_dir: Path, *, create: bool = False) -> int:
    if not runtime_dir.is_absolute():
        raise ValueError('Absolute runtime directory required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in runtime_dir.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        metadata = os.fstat(fd)
        if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ValueError('Unsafe runtime directory')
        if create:
            try:
                os.mkdir('kestrel', 0o700, dir_fd=fd)
            except FileExistsError:
                pass
        child = os.open('kestrel', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    finally:
        os.close(fd)
    metadata = os.fstat(child)
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        os.close(child)
        raise ValueError('Unsafe status directory')
    return child


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate field')
        result[key] = value
    return result


def _snapshot(directory: int) -> dict:
    fd = os.open('indicator.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 1024):
            raise ValueError('Unsafe snapshot')
        raw = source.read(1025)
    if len(raw) > 1024:
        raise ValueError('Snapshot limit')
    data = json.loads(raw, object_pairs_hook=_object)
    if (not isinstance(data, dict)
            or set(data) != {'version', 'boot_id', 'publisher', 'timestamp_ns', 'state', 'owners'}
            or type(data['version']) is not int or data['version'] != 1
            or not isinstance(data['boot_id'], str)
            or type(data['timestamp_ns']) is not int or data['timestamp_ns'] < 0
            or not isinstance(data['state'], str) or data['state'] not in _STATES
            or not isinstance(data['owners'], list) or len(data['owners']) > 3):
        raise ValueError('Snapshot schema')
    identities = [data['publisher'], *data['owners']]
    for owner in identities:
        if (not isinstance(owner, dict) or set(owner) != {'pid', 'start_time'}
                or any(type(owner[key]) is not int or owner[key] <= 0 for key in owner)):
            raise ValueError('Owner identity')
    if len({(item['pid'], item['start_time']) for item in identities}) != len(identities):
        raise ValueError('Duplicate owner')
    return data


def _no_owners(proc_root: Path) -> bool:
    deadline = time.monotonic_ns() + 100_000_000
    with os.scandir(proc_root) as entries:
        for count, entry in enumerate(entries, 1):
            if count > 8192 or time.monotonic_ns() > deadline:
                return False
            if not entry.name.isdecimal():
                continue
            process = Path(entry.path)
            try:
                if entry.stat(follow_symlinks=False).st_uid != os.getuid():
                    continue
                if not entry.is_dir(follow_symlinks=False):
                    return False
                _identity(int(entry.name), proc_root)
                comm = _bounded(process / 'comm').decode('utf-8').strip()
                if not comm or '\x00' in comm or '\n' in comm:
                    return False
                if re.fullmatch(r'(?:python(?:[0-9.]+)?|pypy(?:[0-9.]+)?|pipewire|pw-cat)', comm) is None:
                    continue
                raw = _bounded(process / 'cmdline')
                if not raw or not raw.endswith(b'\x00'):
                    return False
                argv = raw[:-1].decode('utf-8').split('\x00')
                if not argv[0]:
                    return False
                if comm.startswith(('python', 'pypy')):
                    if any(Path(arg).name == 'bot.py' for arg in argv[1:]):
                        return False
                elif comm == 'pipewire':
                    if any(arg == '-c' and index + 1 < len(argv)
                           and Path(argv[index + 1]).name == 'echo-removal.conf'
                           for index, arg in enumerate(argv)):
                        return False
                    if '-c' in argv and argv[-1] == '-c':
                        return False
                elif 'kestrel-capture-' in '\x00'.join(argv):
                    return False
            except FileNotFoundError:
                if process.exists():
                    return False
            if time.monotonic_ns() > deadline:
                return False
    return time.monotonic_ns() <= deadline


def read_indicator(runtime_dir: Path, *, proc_root: Path = Path('/proc'), now_ns: int | None = None) -> str:
    """Return a fixed state; uncertain evidence never establishes release."""
    try:
        directory = _directory(runtime_dir)
        try:
            data = _snapshot(directory)
            now = time.monotonic_ns() if now_ns is None else now_ns
            if data['boot_id'] != _boot(proc_root) or data['timestamp_ns'] > now:
                return 'unavailable'
            if data['state'] != 'released':
                if now - data['timestamp_ns'] > 3_000_000_000 or not _live(data['publisher'], proc_root):
                    return 'unavailable'
                return data['state']
            if any(_live(owner, proc_root) for owner in [data['publisher'], *data['owners']]):
                return 'unavailable'
            if not _no_owners(proc_root) or _snapshot(directory) != data:
                return 'unavailable'
            return 'not-running'
        finally:
            os.close(directory)
    except (OSError, ValueError, UnicodeError, TypeError, KeyError):
        return 'unavailable'


class IndicatorStatus:
    """Own the publisher heartbeat without making voice depend on publication."""

    def __init__(self, runtime_dir: Path | None = None):
        self.runtime_dir = runtime_dir if runtime_dir is not None else Path(os.environ.get('XDG_RUNTIME_DIR', ''))
        self._state = 'starting'
        self._owners = []
        self._failed = False
        try:
            self._publisher = _identity(os.getpid(), _PROC_ROOT)
            self._boot_id = _boot(_PROC_ROOT)
        except (OSError, ValueError, UnicodeError):
            self._fail()

    def _fail(self):
        if not self._failed:
            try:
                print(_ADVISORY, file=sys.stderr)
            except OSError:
                pass
        self._failed = True

    def _publish(self):
        if self._failed:
            return
        directory = None
        temporary = None
        try:
            directory = _directory(self.runtime_dir, create=True)
            try:
                existing = os.stat('indicator.json', dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                if (not stat.S_ISREG(existing.st_mode) or existing.st_uid != os.getuid()
                        or stat.S_IMODE(existing.st_mode) != 0o600):
                    raise ValueError('Unsafe existing snapshot')
            data = {'version': 1, 'boot_id': self._boot_id, 'publisher': self._publisher,
                    'timestamp_ns': time.monotonic_ns(), 'state': self._state, 'owners': self._owners}
            raw = json.dumps(data, separators=(',', ':')).encode('ascii')
            if len(raw) > 1024:
                raise ValueError('Snapshot limit')
            candidate = '.indicator-' + secrets.token_hex(12)
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            temporary = candidate
            with os.fdopen(fd, 'wb') as target:
                os.fchmod(target.fileno(), 0o600)
                target.write(raw)
            os.replace(temporary, 'indicator.json', src_dir_fd=directory, dst_dir_fd=directory)
            temporary = None
        except (OSError, ValueError, TypeError):
            self._fail()
        finally:
            if directory is not None:
                if temporary is not None:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except OSError:
                        self._fail()
                os.close(directory)

    def set_state(self, state: str) -> None:
        if state not in _STATES or state == 'released':
            self._fail()
            return
        self._state = state
        self._publish()

    def remember_owner(self, pid: int) -> dict | None:
        if self._failed:
            return
        try:
            if type(pid) is not int or pid <= 0:
                raise ValueError('Owner PID')
            owner = _identity(pid, _PROC_ROOT)
            if owner != self._publisher and owner not in self._owners:
                if len(self._owners) == 3:
                    raise ValueError('Owner limit')
                self._owners.append(owner)
            self._publish()
            return owner.copy()
        except (OSError, ValueError, UnicodeError):
            self._fail()
            return None

    def retire_owner(self, identity: dict) -> None:
        if self._failed:
            return
        if identity not in self._owners or _live(identity, _PROC_ROOT):
            raise ValueError('Audio owner has not been reaped')
        self._owners.remove(identity)
        self._publish()

    def mark_released(self) -> None:
        self._state = 'released'
        self._publish()

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(1)
            self._publish()


def _watch() -> int:
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', ''))
    try:
        while True:
            os.write(sys.stdout.fileno(), _WIRE[read_indicator(runtime)].encode('ascii'))
            time.sleep(1)
    except BrokenPipeError:
        return 0


if __name__ == '__main__':
    if sys.argv[1:] != ['--watch']:
        print('Usage: status.py --watch', file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(_watch())
