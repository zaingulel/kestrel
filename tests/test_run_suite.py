"""The by-module suite runner: exit status, output, and child cleanup."""

from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
import io

import run_suite

PASSING = '''import unittest

class T(unittest.TestCase):
    def test_ok(self):
        print("{marker}")
'''
FAILING = '''import unittest

class T(unittest.TestCase):
    def test_broken(self):
        self.fail("deliberate failure")
'''
IMPORT_EXIT = 'import os\nos._exit(3)\n'
SLEEPING = '''import os, time, unittest

class T(unittest.TestCase):
    def test_sleep(self):
        with open({pid_file!r}, "w") as file:
            file.write(str(os.getpid()))
        time.sleep(60)
'''


class RunSuiteTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.directory = Path(folder.name)

    def write(self, name, source):
        (self.directory / name).write_text(source)

    def run_in_process(self, arguments=()):
        output = io.StringIO()
        with redirect_stdout(output):
            code = run_suite.run_suite(self.directory, list(arguments))
        return code, output.getvalue()

    def test_all_passing_modules_return_zero_with_output_and_forwarded_arguments(self):
        self.write('test_one.py', PASSING.format(marker='marker-one'))
        self.write('test_two.py', PASSING.format(marker='marker-two'))
        code, output = self.run_in_process(['--durations', '0'])
        self.assertEqual(code, 0)
        self.assertIn('marker-one', output)
        self.assertIn('marker-two', output)
        self.assertEqual(output.count('Slowest test durations'), 2)

    def test_failing_module_fails_the_run_and_leaves_the_other_output(self):
        self.write('test_bad.py', FAILING)
        self.write('test_good.py', PASSING.format(marker='marker-good'))
        code, output = self.run_in_process()
        self.assertNotEqual(code, 0)
        self.assertIn('FAILED modules: test_bad.py', output)
        self.assertIn('marker-good', output)

    def test_module_exiting_at_import_fails_the_run(self):
        self.write('test_exits.py', IMPORT_EXIT)
        code, output = self.run_in_process()
        self.assertNotEqual(code, 0)
        self.assertIn('FAILED modules: test_exits.py', output)

    def test_empty_directory_fails_the_run(self):
        code, _ = self.run_in_process()
        self.assertNotEqual(code, 0)

    def test_sigterm_ends_the_runner_and_its_running_child(self):
        pid_file = self.directory / 'child.pid'
        self.write('test_sleeper.py', SLEEPING.format(pid_file=str(pid_file)))
        runner = subprocess.Popen(
            [sys.executable, '-c',
             f'import sys; sys.path.insert(0, {str(Path(__file__).resolve().parent)!r}); '
             f'import run_suite; sys.exit(run_suite.main({str(self.directory)!r}))'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(runner.kill)
        deadline = time.monotonic() + 30
        while not (pid_file.exists() and pid_file.read_text()):
            self.assertIsNone(runner.poll(), 'runner exited before its module ran')
            self.assertLess(time.monotonic(), deadline, 'module never started')
            time.sleep(0.05)
        child = int(pid_file.read_text())
        self.addCleanup(self.kill_quietly, child)
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=30), 143)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    @staticmethod
    def kill_quietly(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


if __name__ == '__main__':
    unittest.main()
