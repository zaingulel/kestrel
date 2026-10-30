"""Runs each speech test module in its own unittest process, WORKERS at a time.

The exit status is authoritative: any module that does not exit 0, or an empty suite, fails the run.
"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import signal
import subprocess
import sys
import threading

WORKERS = 4
SUITE = Path(__file__).resolve().parent


def run_suite(directory, arguments):
    modules = sorted(Path(directory).glob('test*.py'))
    if not modules:
        print(f'no test modules found in {directory}', flush=True)
        return 1
    running = set()
    lock = threading.Lock()
    stopping = threading.Event()

    def run_module(module):
        with lock:
            if stopping.is_set():
                return None
            print(f'{module.name} started', flush=True)
            child = subprocess.Popen(
                [sys.executable, '-m', 'unittest', 'discover', '-s', str(directory),
                 '-p', module.name, '-v', *arguments],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, errors='replace')
            running.add(child)
        output, _ = child.communicate()
        with lock:
            running.discard(child)
        return child.returncode, output

    pool = ThreadPoolExecutor(WORKERS)
    failed = []
    try:
        futures = [pool.submit(run_module, module) for module in modules]
        for module, future in zip(modules, futures):
            code, output = future.result()
            print(f'===== {module.name} =====\n{output}', flush=True)
            if code != 0:
                failed.append(module.name)
    finally:
        with lock:
            stopping.set()
            for child in running:
                child.terminate()
        pool.shutdown(wait=True, cancel_futures=True)
    if failed:
        print(f'FAILED modules: {", ".join(failed)}', flush=True)
        return 1
    print(f'all {len(modules)} modules passed', flush=True)
    return 0


def main(directory=SUITE):
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    return run_suite(directory, sys.argv[1:])


if __name__ == '__main__':
    sys.exit(main())
