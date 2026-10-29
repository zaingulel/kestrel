"""Status-only filesystem/process evidence and the fixed watcher wire."""

from contextlib import nullcontext, redirect_stderr
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop import status


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.root = Path(self.home.name)
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir(mode=0o700)
        self.proc = self.root / 'proc'
        boot = self.proc / 'sys/kernel/random'
        boot.mkdir(parents=True)
        (boot / 'boot_id').write_text('12345678-1234-1234-1234-123456789abc\n')
        self.folder = self.runtime / 'kestrel'
        self.folder.mkdir(mode=0o700)
        self.file = self.folder / 'indicator.json'
        self.now = 20_000_000_000
        self.data = {
            'version': 1, 'boot_id': '12345678-1234-1234-1234-123456789abc',
            'publisher': {'pid': 100, 'start_time': 400}, 'timestamp_ns': self.now,
            'state': 'released', 'owners': [{'pid': 101, 'start_time': 401},
                                              {'pid': 102, 'start_time': 402}],
        }
        self.write()

    def write(self, data=None):
        self.file.write_text(json.dumps(self.data if data is None else data))
        self.file.chmod(0o600)

    def process(self, pid, start, comm='sleep', args=None):
        folder = self.proc / str(pid)
        folder.mkdir(exist_ok=True)
        # Linux stat field 22 is the process start tick, independently laid out here.
        (folder / 'stat').write_text(f'{pid} ({comm}) S ' + '0 ' * 18 + str(start) + ' 0\n')
        (folder / 'comm').write_text(comm + '\n')
        if args is not None:
            (folder / 'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in args) + b'\0')
        return folder

    def read(self):
        return status.read_indicator(self.runtime, proc_root=self.proc, now_ns=self.now)

    def test_capture_owner_retirement_preserves_echo_and_refuses_live_owner(self):
        self.process(100, 400)
        self.process(101, 401)
        with patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
            publisher = status.IndicatorStatus(self.runtime)
            echo = publisher.remember_owner(101)
            self.assertEqual(echo, {'pid': 101, 'start_time': 401})
            publisher.set_state('inactive')
            for cycle in range(4):
                pid = 200 + cycle
                folder = self.process(pid, 600 + cycle)
                captured = publisher.remember_owner(pid)
                self.assertEqual(captured, {'pid': pid, 'start_time': 600 + cycle})
                with self.assertRaisesRegex(ValueError, 'not been reaped'):
                    publisher.retire_owner(captured)
                with self.assertRaises(ValueError):
                    publisher.retire_owner(captured | {'start_time': 1})
                shutil.rmtree(folder)
                publisher.retire_owner(captured)
                data = json.loads(self.file.read_text())
                self.assertEqual(data['owners'], [echo])
                self.assertEqual(data['state'], 'inactive')
                self.assertFalse(publisher._failed)
            self.assertEqual(status.read_indicator(self.runtime, proc_root=self.proc), 'inactive')
            self.assertEqual(status._WIRE['inactive'], 'D')
            self.assertTrue((self.proc / '101').exists(), 'Retiring capture must retain the echo owner')
            with self.assertRaises(ValueError):
                publisher.retire_owner(echo)

    def test_released_receipt_requires_all_owners_gone(self):
        self.assertEqual(self.read(), 'not-running')
        for pid, start in ((100, 400), (101, 401), (102, 402)):
            with self.subTest(owner=pid):
                folder = self.process(pid, start)
                self.assertEqual(self.read(), 'unavailable')
                shutil.rmtree(folder)
                self.assertEqual(self.read(), 'not-running')
        self.process(100, 999)
        self.assertEqual(self.read(), 'not-running', 'A reused PID is not the original owner')
        self.data['state'] = 'starting'
        self.write()
        self.assertEqual(self.read(), 'unavailable', 'PID reuse cannot authenticate active status')
        self.process(100, 400)
        self.assertEqual(self.read(), 'starting')
        self.data['state'] = 'released'
        self.write()
        shutil.rmtree(self.proc / '100')
        scan = os.scandir

        def changed_receipt(path):
            changed = deepcopy(self.data)
            changed['timestamp_ns'] -= 1
            self.write(changed)
            return scan(path)

        with patch.object(status.os, 'scandir', side_effect=changed_receipt):
            self.assertEqual(self.read(), 'unavailable', 'A changed lifetime invalidates the observation')

    def test_new_or_other_checkout_voice_invalidates_old_release(self):
        cases = [
            ('python3', ['/usr/bin/python3', '/root/kestrel/bot.py']),
            ('python3.12', ['/voice/bin/python', '/jobs/99/bot.py']),
            ('pipewire', ['/usr/bin/pipewire', '-c', '/jobs/99/echo-removal.conf']),
            ('pw-cat', ['pw-cat', '--record', '--properties', '{ node.name = kestrel-capture-123 }', '-']),
            ('python3', None),
            ('pipewire', ['pipewire', '-c']),
        ]
        for comm, args in cases:
            with self.subTest(comm=comm, args=args):
                folder = self.process(200, 500, comm, args)
                self.assertEqual(self.read(), 'unavailable')
                shutil.rmtree(folder)
        self.process(200, 500, 'python3', ['python3', '/other/tool.py'])
        self.assertEqual(self.read(), 'not-running')
        self.data['state'] = 'idle'
        self.write()
        self.process(100, 400)
        with patch.object(status.os, 'scandir', side_effect=AssertionError('Active status must not scan')):
            self.assertEqual(self.read(), 'idle')

    def test_hostile_or_stale_evidence_is_unavailable(self):
        sentinel = 'PRIVATE CONVERSATION SENTINEL'
        original = deepcopy(self.data)
        cases = [None, [], {}, {**original, 'version': True}, {**original, 'state': sentinel},
                 {**original, 'transcript': sentinel}, {**original, 'timestamp_ns': self.now + 1},
                 {**original, 'publisher': {'pid': True, 'start_time': 400}},
                 {**original, 'owners': original['owners'] * 2},
                 {**original, 'boot_id': 'another-boot'},
                 {**original, 'state': 'idle', 'timestamp_ns': self.now - 3_000_000_001}]
        for data in cases:
            with self.subTest(data=data):
                self.file.write_text(json.dumps(data))
                self.assertEqual(self.read(), 'unavailable')
        for raw in (b'{', b'x' * 1025, b'\xff', b'{"state":"idle","state":"released"}'):
            with self.subTest(raw=raw[:30]):
                self.file.write_bytes(raw)
                self.assertEqual(self.read(), 'unavailable')
        self.write()
        self.file.chmod(0o644)
        self.assertEqual(self.read(), 'unavailable')
        self.file.unlink()
        self.assertEqual(self.read(), 'unavailable')
        target = self.root / 'outside'
        target.write_text(json.dumps(original))
        target.chmod(0o600)
        self.file.symlink_to(target)
        self.assertEqual(self.read(), 'unavailable')
        with patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
            self.process(100, 400)
            errors = io.StringIO()
            with redirect_stderr(errors):
                publisher = status.IndicatorStatus(self.runtime)
                publisher.set_state('starting')
                publisher.set_state('idle')
            self.assertEqual(errors.getvalue().count('Microphone use unknown.'), 1)
            self.assertTrue(self.file.is_symlink(), 'Publication must refuse an unsafe existing file')
        shutil.rmtree(self.proc / '100')
        self.file.unlink()
        self.write()
        self.folder.chmod(0o755)
        self.assertEqual(self.read(), 'unavailable')
        self.folder.chmod(0o700)
        self.runtime.chmod(0o755)
        self.assertEqual(self.read(), 'unavailable')
        self.runtime.chmod(0o700)
        self.assertEqual(status.read_indicator(Path('relative'), proc_root=self.proc), 'unavailable')
        # Over-limit and unreadable candidate metadata cannot become proof of absence.
        folder = self.process(200, 500, 'python3', ['python3', '/other/tool.py'])
        (folder / 'cmdline').write_bytes(b'x' * 4097)
        self.assertEqual(self.read(), 'unavailable')
        (folder / 'cmdline').unlink()
        self.assertEqual(self.read(), 'unavailable')
        (folder / 'stat').write_text('malformed')
        self.assertEqual(self.read(), 'unavailable')
        shutil.rmtree(folder)
        with patch.object(status.time, 'monotonic_ns', side_effect=[0, 100_000_001]):
            self.assertEqual(self.read(), 'unavailable')
        with patch.object(status.os, 'scandir', side_effect=PermissionError):
            self.assertEqual(self.read(), 'unavailable')
        entry = SimpleNamespace(name='non-process')
        for count, expected in ((8192, 'not-running'), (8193, 'unavailable')):
            with self.subTest(entries=count), patch.object(
                status.os, 'scandir', return_value=nullcontext(iter([entry] * count)),
            ):
                self.assertEqual(self.read(), expected)
        with patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
            self.process(100, 400)
            publisher = status.IndicatorStatus(self.runtime)
            publisher.set_state('starting')
            publisher.remember_owner(100)
            self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(json.loads(self.file.read_text())), set(original))
            self.assertNotIn(sentinel, self.file.read_text())
            self.assertEqual(status.read_indicator(self.runtime, proc_root=self.proc), 'starting')


    def test_trouble_causes_are_closed_fixed_status(self):
        sentinel = 'PRIVATE CONVERSATION SENTINEL'
        original = deepcopy(self.data)
        causes = {'trouble-microphone': 'M', 'trouble-playback': 'P', 'trouble-recognition': 'R',
                  'trouble-voice': 'V', 'trouble-engine': 'E', 'trouble-notes': 'O',
                  'trouble-handover': 'H'}
        with patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
            self.process(100, 400)
            publisher = status.IndicatorStatus(self.runtime)
            for cause in causes:
                with self.subTest(cause=cause):
                    publisher.set_state(cause)
                    self.assertEqual(status.read_indicator(self.runtime, proc_root=self.proc), cause)
                    self.assertEqual(set(json.loads(self.file.read_text())), set(original))
                    self.assertNotIn(sentinel, self.file.read_text())
        self.process(100, 400)
        for state in ('trouble-' + sentinel, 'trouble-unknown', 'trouble-stopped',
                      'TROUBLE-MICROPHONE', 'trouble-'):
            with self.subTest(state=state):
                self.write({**original, 'state': state})
                self.assertEqual(self.read(), 'unavailable')
        for near_miss in ('trouble-' + sentinel, 'trouble-unknown', 'trouble-stopped',
                          'TROUBLE-MICROPHONE', 'trouble-'):
            with self.subTest(near_miss=near_miss), tempfile.TemporaryDirectory() as home, \
                    patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
                runtime = Path(home) / 'runtime'
                runtime.mkdir(mode=0o700)
                publisher = status.IndicatorStatus(runtime)
                publisher.set_state('trouble-microphone')
                snapshot = runtime / 'kestrel/indicator.json'
                before = snapshot.read_bytes()
                errors = io.StringIO()
                with redirect_stderr(errors):
                    publisher.set_state(near_miss)
                self.assertEqual(errors.getvalue().count('Microphone use unknown.'), 1)
                self.assertEqual(snapshot.read_bytes(), before)
                self.assertNotIn(sentinel, snapshot.read_text())
                self.assertEqual(status.read_indicator(runtime, proc_root=self.proc), 'trouble-microphone')
        self.assertEqual(status._WIRE, {
            'starting': 'A', 'idle': 'I', 'listening': 'L', 'thinking': 'T', 'speaking': 'S',
            'trouble': 'B', 'not-running': 'N', 'unavailable': 'U', 'inactive': 'D',
            'inactive-slow': 'W', 'idle-slow': 'Y', **causes})

    def test_slow_start_states_are_fixed_status(self):
        with patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
            self.process(100, 400)
            publisher = status.IndicatorStatus(self.runtime)
            for state, letter in (('inactive-slow', 'W'), ('idle-slow', 'Y')):
                with self.subTest(state=state):
                    publisher.set_state(state)
                    self.assertEqual(status.read_indicator(self.runtime, proc_root=self.proc), state)
                    self.assertEqual(status._WIRE[state], letter)
        for near_miss in ('idle-SLOW', 'inactive-slow '):
            with self.subTest(near_miss=near_miss), tempfile.TemporaryDirectory() as home, \
                    patch.object(status, '_PROC_ROOT', self.proc), patch.object(status.os, 'getpid', return_value=100):
                runtime = Path(home) / 'runtime'
                runtime.mkdir(mode=0o700)
                publisher = status.IndicatorStatus(runtime)
                publisher.set_state('inactive-slow')
                snapshot = runtime / 'kestrel/indicator.json'
                before = snapshot.read_bytes()
                errors = io.StringIO()
                with redirect_stderr(errors):
                    publisher.set_state(near_miss)
                self.assertEqual(errors.getvalue().count('Microphone use unknown.'), 1)
                self.assertEqual(snapshot.read_bytes(), before)
                self.assertEqual(status.read_indicator(runtime, proc_root=self.proc), 'inactive-slow')

    def test_trouble_status_privacy_disclosure(self):
        self.assertIn(
            'In trouble, the fixed status names one verified cause from a closed list, or none; '
            'failure text never enters the snapshot.',
            (Path(__file__).resolve().parents[1] / 'README.md').read_text(),
        )


class StatusWireTests(unittest.TestCase):
    def test_watcher_emits_only_states_and_exits_on_closed_pipe(self):
        command = [sys.executable, str(Path(status.__file__).resolve()), '--watch']
        with tempfile.TemporaryDirectory() as runtime:
            publisher = status.IndicatorStatus(Path(runtime))
            publisher.set_state('listening')
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env={**os.environ, 'XDG_RUNTIME_DIR': runtime})
            try:
                self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'Watcher must publish')
                self.assertEqual(os.read(child.stdout.fileno(), 1), b'L')
                publisher.set_state('speaking')
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(os.read(child.stdout.fileno(), 1), b'S')
                (Path(runtime) / 'kestrel/indicator.json').write_text('PRIVATE CONVERSATION SENTINEL')
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(os.read(child.stdout.fileno(), 1), b'U')
                child.stdout.close()
                self.assertEqual(child.wait(timeout=5), 0)
                self.assertEqual(child.stderr.read(), b'')
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
                child.stdout.close()
                child.stderr.close()
            # Negative wire: invalid CLI input fails before emitting any status or text.
            invalid = subprocess.run(command + ['PRIVATE CONVERSATION SENTINEL'], capture_output=True,
                                     timeout=5, env={**os.environ, 'XDG_RUNTIME_DIR': runtime})
            self.assertEqual(invalid.returncode, 2)
            self.assertEqual(invalid.stdout, b'')
            self.assertEqual(invalid.stderr, b'Usage: status.py --watch\n')
