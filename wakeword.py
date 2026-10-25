"""Bounded private wake detector and its isolated native worker."""

import asyncio
import hashlib
import math
import numbers
import os
from pathlib import Path
import resource
import sys
import stat
import struct

ROOT = Path(__file__).parent
RUNTIME = ROOT / '.runtime/wakeword'
WAKE_BAR = 0.5
BURST_FLOOR = 0.2
# About one second of 80-millisecond scores; bounds the line and the delay.
BURST_LIMIT = 12
ADVICE = 'Wake phrase unavailable. Press Super + Shift + K to start. Check the service log and restart Kestrel.'
CLEANUP_ADVICE = 'Wake capture cleanup failed. Restart Kestrel.'
PACKAGE = Path("venv/lib/python3.12/site-packages/pyopen_wakeword")
ASSET_IDENTITIES = {
    str(PACKAGE / '__init__.py'): (202, 'e7b7baebc5abde645115f5ce4582a22ebd3f95a028e3c9863b6370fdfbdafbf9'),
    str(PACKAGE / 'const.py'): (231, '99409b54aa7ed4390096de10b9aa09ac6c474e8881348d4e04a9732540c8cb46'),
    str(PACKAGE / 'openwakeword.py'): (14252, 'c7558168729bc13a9b10330206fc8573871f8d7fe9f94e32655e0aa7969659e9'),
    str(PACKAGE / 'wakeword.py'): (3861, '4cdc1daad709a004f42f242c0c2031120eff91bef67c0c4b12e49854c56708f6'),
    str(PACKAGE / 'models/melspectrogram.tflite'): (1092516, '96fa0adccb6e8cf95cb14465409a1a2898ee4a96a85bb9ed3c7eb0e68bf163e8'),
    str(PACKAGE / 'models/embedding_model.tflite'): (1330312, 'c0aea21eb84a4ce90a08c870da41b7a7173b45269e6a3207c71d67c40f3a59d8'),
    str(PACKAGE / 'lib/libtensorflowlite_c.so'): (4835320, '25465edb5cd7aadd00249d4d28f1d922ce5cc90195ad4403458111dd63493bae'),
    'hey_kestrel.tflite': (206764, '9a74847c8ba90dcf82c210c62d30e51ad84cf5682426c28509b0c0a9fe8797a9'),
}


def load_detector(runtime: Path):
    try:
        directories = {runtime}
        for name in ASSET_IDENTITIES:
            path = runtime / name
            directories.update(path.parents)
        directories = {path for path in directories if path == runtime or runtime in path.parents}
        for directory in directories:
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError
        package = runtime / PACKAGE
        if (package / '__pycache__').exists() or (package / '__pycache__').is_symlink():
            raise ValueError
        for name, (size, digest) in ASSET_IDENTITIES.items():
            path = runtime / name
            descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022
                        or info.st_nlink != 1 or info.st_size != size):
                    raise ValueError
                data = source.read(size + 1)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError
        import numpy as np
        import pyopen_wakeword as sdk
        if np.__version__ != '2.5.4' or sdk.__file__ != str(package / '__init__.py'):
            raise ValueError
    except (OSError, ValueError, ImportError):
        raise RuntimeError(ADVICE) from None
    options = dict(models_dir=str(package / 'models'), libtensorflowlite_c_path=str(package / 'lib/libtensorflowlite_c.so'))
    model = sdk.OpenWakeWord.from_model(str(runtime / 'hey_kestrel.tflite'), libtensorflowlite_c_path=options['libtensorflowlite_c_path'])
    try:
        return model, sdk.OpenWakeWordFeatures.from_builtin(**options)
    except BaseException:
        model.close()
        raise


def scores(model, features, pcm: bytes) -> list[float]:
    found = []
    for embedding in features.process_streaming(pcm):
        for score in model.process_streaming(embedding):
            if (isinstance(score, bool) or not isinstance(score, numbers.Real)
                    or not math.isfinite(score) or not 0 <= score <= 1 or len(found) >= 1000):
                raise ValueError('Invalid wake score')
            found.append(float(score))
    return found


def wire_score(payload: bytes) -> float:
    score, = struct.unpack('>f', payload)
    if not 0 <= score <= 1:
        raise ValueError('Invalid wake score')
    return score


def burst_line(outcome: str, burst: list[float]) -> str:
    return f'Wake scores: {outcome}, peak {max(burst):.3f}:' + ''.join(f' {score:.3f}' for score in burst)


def serve(requests, protocol):
    model = features = None
    refused = False
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        model, features = load_detector(RUNTIME)
        # Complete native streaming autofill before admitting microphone frames.
        scores(model, features, bytes(640))
        protocol.write(b'R')
        protocol.flush()
        while True:
            pcm = requests.read(640)
            if not pcm:
                break
            if len(pcm) != 640:
                raise ValueError('Invalid wake frame')
            found = scores(model, features, pcm)
            if len(found) > 1:
                raise ValueError('Invalid wake score')
            protocol.write(b'S' + struct.pack('>f', found[0]) if found else b'N')
            protocol.flush()
    except Exception:
        refused = True
        print('Wake worker refused input or assets', file=sys.stderr)
        protocol.write(b'E')
        protocol.flush()
    finally:
        cleanup_failed = False
        for native in (model, features):
            if native is not None:
                try:
                    native.close()
                except Exception:
                    cleanup_failed = True
        if cleanup_failed:
            print('Wake worker cleanup failed', file=sys.stderr)
            if not refused:
                protocol.write(b'E')
                protocol.flush()


class WakeWordDetector:
    def __init__(self, *, on_detected, on_failed):
        self.on_detected = on_detected
        self.on_failed = on_failed
        self.process = None
        self.task = None
        self.queue = asyncio.Queue(maxsize=4)
        self.failed = False
        self.closed = False
        self.close_task = None
        self.burst = []

    def scored(self, score: float):
        if score > BURST_FLOOR:
            self.burst.append(score)
            if len(self.burst) < BURST_LIMIT:
                return
        elif not self.burst:
            return
        burst, self.burst = self.burst, []
        woke = max(burst) > WAKE_BAR
        # imported here: the isolated wake interpreter has no loguru
        from loguru import logger
        logger.info(burst_line('woke' if woke else 'did not wake', burst))
        if woke:
            self.on_detected()

    def fail(self):
        if not self.failed and not self.closed:
            self.failed = True
            self.on_failed()

    async def start(self):
        try:
            async with asyncio.timeout(30):
                self.process = await asyncio.create_subprocess_exec(
                    'setpriv', '--pdeathsig', 'KILL', 'sh', '-c',
                    'test "$PPID" = "$1" && shift && exec "$@"', 'sh', str(os.getpid()),
                    str(RUNTIME / 'venv/bin/python'), '-I', '-B', str(ROOT / 'wakeword.py'),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, limit=16, start_new_session=True,
                )
                if await self.process.stdout.readexactly(1) != b'R':
                    raise ValueError('Invalid wake readiness')
            self.task = asyncio.create_task(self._run())
        except asyncio.CancelledError:
            await self.close()
            raise
        except (OSError, ValueError, TimeoutError, asyncio.IncompleteReadError):
            self.fail()
            await self.close()

    def submit(self, pcm: bytes):
        if self.closed or self.failed:
            return
        if type(pcm) is not bytes or len(pcm) != 640:
            self.fail()
            return
        try:
            self.queue.put_nowait(pcm)
        except asyncio.QueueFull:
            self.fail()

    async def _run(self):
        try:
            while not self.failed:
                pcm = await self.queue.get()
                async with asyncio.timeout(1):
                    self.process.stdin.write(pcm)
                    await self.process.stdin.drain()
                    result = await self.process.stdout.readexactly(1)
                    if result == b'S':
                        payload = await self.process.stdout.readexactly(4)
                if result == b'S':
                    self.scored(wire_score(payload))
                elif result != b'N':
                    raise ValueError('Invalid wake response')
        except (OSError, ValueError, RuntimeError, TimeoutError, asyncio.IncompleteReadError):
            self.fail()

    async def close(self):
        if self.close_task is None:
            self.closed = True
            self.close_task = asyncio.create_task(self._close())
        try:
            await asyncio.shield(self.close_task)
        except asyncio.CancelledError:
            await asyncio.shield(self.close_task)
            raise

    async def _close(self):
        if self.burst:
            # imported here: the isolated wake interpreter has no loguru
            from loguru import logger
            logger.info(burst_line('interrupted', self.burst))
            self.burst = []
        if self.task is not None:
            self.task.cancel()
            await asyncio.wait_for(asyncio.gather(self.task, return_exceptions=True), 5)
        while not self.queue.empty():
            self.queue.get_nowait()
        process = self.process
        if process is None:
            return
        errors = []
        try:
            process.stdin.close()
            await asyncio.wait_for(process.stdin.wait_closed(), 5)
        except (OSError, RuntimeError, TimeoutError) as error:
            errors.append(error)
        try:
            # StreamReader exposes no public pipe-close method; retain the existing speech boundary.
            if process.stdout._transport is not None:
                process.stdout._transport.close()
        except (OSError, RuntimeError) as error:
            errors.append(error)
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await asyncio.wait_for(process.wait(), 5)
        if errors:
            raise RuntimeError(CLEANUP_ADVICE)


if __name__ == '__main__':
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        serve(sys.stdin.buffer, protocol)
