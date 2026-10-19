"""Installed-app policy and native Gio wire proofs, without launching apps."""

from contextlib import redirect_stderr, redirect_stdout
import asyncio
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import sys
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock, patch

import app_resolver
import bot


class AppResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_uwsm_preserves_literal_app_operands(self):
        if not Path('/usr/bin/uwsm-app').is_file():
            if os.environ.get('CI') == 'true':
                self.skipTest('Hosted UWSM unavailable; native evidence requires local execution')
            self.fail('Local native UWSM is required')
        desktop_id = 'Fixture ${USER} $USER $$ $ "quote"; %n %h %%.desktop'
        home = '/fixture/home ${USER} $USER $$ $ ; "%n %h %%"'
        data_home = '/fixture/data ${USER} $USER $$ $ ; "%n %h %%"'
        data_dirs = '/fixture/a ${USER} $USER $$ $ ; "%n %h %%":/fixture/b'
        expected_env = (f'HOME={home}', f'XDG_DATA_HOME={data_home}', f'XDG_DATA_DIRS={data_dirs}',
                        'XDG_CURRENT_DESKTOP=Fixture_1')
        expected = {'id': desktop_id, 'env': {'HOME': home, 'XDG_DATA_HOME': data_home,
                                             'XDG_DATA_DIRS': data_dirs, 'XDG_CURRENT_DESKTOP': 'Fixture_1'}}
        unit = f'kestrel-app-literal-{uuid.uuid4().hex}.service'
        directory = tempfile.mkdtemp(prefix='kestrel-app-literal-')
        socket_path = str(Path(directory) / 'receipt.sock')
        receiver = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        received = None
        native_env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}',
                      'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{os.getuid()}/bus'}
        receipt = (
            'import json, os, socket, sys; '
            'payload = {"id": sys.argv[-1], "env": {key: os.environ[key] for key in '
            '("HOME", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CURRENT_DESKTOP")}}; '
            'client = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); '
            'client.connect(sys.argv[-2]); client.send(json.dumps(payload).encode()); client.close()'
        )
        calls = []
        try:
            receiver.bind(socket_path)
            receiver.setblocking(False)
            received = asyncio.create_task(asyncio.get_running_loop().sock_recv(receiver, 4096))

            async def command(argv, *, stdin_data=None):
                calls.append(argv)
                if argv[0] == '/usr/bin/env':
                    self.assertEqual(argv, ('/usr/bin/env', *expected_env, '/usr/bin/python', '-I',
                                            str(bot.ROOT / 'app_resolver.py')))
                    self.assertEqual(stdin_data, b'Fixture Query')
                    return json.dumps(desktop_id)
                self.assertIsNone(stdin_data)
                self.assertEqual(argv[:5], ('/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env'))
                self.assertEqual(argv[-2], '/usr/bin/gtk-launch')
                probe = (*argv[:3], '-u', unit, '-p', 'RuntimeMaxSec=5s', *argv[3:-2],
                         '/usr/bin/python', '-I', '-c', receipt, socket_path, argv[-1])
                return await bot.run_local_command(probe)

            with patch.object(bot.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir=home)), \
                    patch.dict(os.environ, {'XDG_DATA_HOME': data_home, 'XDG_DATA_DIRS': data_dirs,
                                            'XDG_CURRENT_DESKTOP': 'Fixture_1'}):
                name = bot.match_app_name('open Fixture Query')
                self.assertEqual(name, 'Fixture Query')
                tool = await bot.resolve_app_tool(name, command=command)
                self.assertIsNotNone(tool)
                result = await tool.run(command=command)
            self.assertTrue(result.accepted, result.reason)
            actual = json.loads(await asyncio.wait_for(received, 5))
            self.assertEqual(actual, expected, 'Native service must receive the original literal bytes')
            self.assertEqual(len(calls), 2)
        finally:
            if received is not None:
                received.cancel()
                await asyncio.gather(received, return_exceptions=True)
            receiver.close()
            stopped = subprocess.run(('/usr/bin/systemctl', '--user', 'stop', unit), env=native_env,
                                     capture_output=True, text=True, timeout=5)
            self.assertTrue(stopped.returncode == 0 or (stopped.returncode == 5
                            and unit in stopped.stderr and 'not loaded' in stopped.stderr), stopped.stderr)
            state = subprocess.run(('/usr/bin/systemctl', '--user', 'show', '--property=LoadState',
                                    '--property=ActiveState', unit), env=native_env,
                                   capture_output=True, text=True, timeout=5)
            self.assertEqual(state.returncode, 0, state.stderr)
            self.assertTrue('ActiveState=inactive' in state.stdout.splitlines()
                            or 'LoadState=not-found' in state.stdout.splitlines(), state.stdout)
            shutil.rmtree(directory)

    async def test_unique_visible_names_and_invalid_metadata(self):
        def app(name, desktop_id, visible=True):
            entry = Mock(spec=('should_show', 'get_name', 'get_id'))
            entry.should_show.return_value = visible
            entry.get_name.return_value = name
            entry.get_id.return_value = desktop_id
            return entry

        fixture = app('  Fixture App  ', 'fixture.desktop')
        self.assertEqual(app_resolver.resolve_app('FIXTURE APP', [fixture]), 'fixture.desktop')
        self.assertEqual(app_resolver.resolve_app('STRASSE', [app('Straße', 'street.desktop')]), 'street.desktop')
        self.assertEqual(app_resolver.resolve_app('Fixture App', [fixture, fixture]), 'fixture.desktop')
        self.assertIsNone(app_resolver.resolve_app('Unknown', [fixture]))
        self.assertIsNone(app_resolver.resolve_app('Fixture  App', [fixture]), 'Internal whitespace is significant')
        self.assertIsNone(app_resolver.resolve_app('Fixture App', [app('Fixture App', 'hidden.desktop', False)]))
        self.assertIsNone(app_resolver.resolve_app('Fixture App', [fixture, app('Fixture App', 'other.desktop')]))
        literal_id = 'App ; $(literal) "Name".desktop'
        self.assertEqual(app_resolver.resolve_app('Fixture App', [app('Fixture App', literal_id)]), literal_id)
        for desktop_id in (None, 12, '', '.desktop', '-x.desktop', 'x', '/x.desktop', 'x/y.desktop',
                           'x\\y.desktop', 'x:y.desktop', 'x\x00.desktop', 'x\x7f.desktop',
                           'é' * 510 + '.desktop'):
            with self.subTest(desktop_id=desktop_id):
                with self.assertRaises(ValueError):
                    app_resolver.resolve_app('Fixture App', [app('Fixture App', desktop_id)])
        self.assertIsNone(app_resolver.resolve_app('Unknown', [app('Other', None)]),
                          'Unrelated IDs are not part of the matching result')
        with self.assertRaises(ValueError):
            app_resolver.resolve_app('Fixture App', [app(None, 'bad.desktop')])
        gio = SimpleNamespace(AppInfo=SimpleNamespace(get_all=Mock(return_value=[fixture])))
        with patch.dict(sys.modules, {'gi.repository': SimpleNamespace(Gio=gio)}):
            for name, expected in (('Fixture App', 'fixture.desktop'), ('Unknown', None)):
                output, errors = io.StringIO(), io.StringIO()
                with redirect_stdout(output), redirect_stderr(errors), \
                        patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(name.encode()))):
                    self.assertEqual(app_resolver.main([]), 0)
                self.assertEqual(json.loads(output.getvalue()), expected)
                self.assertEqual(errors.getvalue(), '')
            gio.AppInfo.get_all.return_value = [app('Fixture App', '../bad.desktop')]
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors), \
                    patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b'Fixture App'))):
                self.assertEqual(app_resolver.main([]), 1)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(errors.getvalue(), 'Invalid installed-app metadata\n')
        with patch.dict(sys.modules, {'gi': None}):
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors), \
                    patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b'Fixture App'))):
                self.assertEqual(app_resolver.main([]), 1)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(errors.getvalue(), 'Gio unavailable\n')
        for args, payload in ((['a', 'b'], b'Fixture App'), (['Fixture App'], b'Fixture App'),
                              ([], b''), ([], b'  '), ([], b'a\nb'), ([], b'a\x00b'),
                              ([], b'x' * 1025), ([], b'\xff')):
            with self.subTest(args=args, payload=payload[:80]):
                output, errors = io.StringIO(), io.StringIO()
                with redirect_stdout(output), redirect_stderr(errors), \
                        patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(payload))):
                    self.assertEqual(app_resolver.main(args), 1)
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(errors.getvalue(), 'Invalid app name\n')

    async def test_native_resolver_wire_success_and_unknown(self):
        if not Path('/usr/bin/python').is_file():
            if os.environ.get('CI') == 'true':
                self.skipTest('Hosted system Python unavailable; native evidence requires local execution')
            self.fail('Local native system Python is required')
        calls = []
        private_name = 'FixturePrivateQuery_3a61'
        with tempfile.TemporaryDirectory(prefix='kestrel-apps-') as directory:
            root = Path(directory)
            caller, activation = root / 'caller ; literal', root / 'activation'
            for base, name in ((caller, private_name), (activation, 'Impostor')):
                apps = base / 'data' / 'applications'
                apps.mkdir(parents=True)
                (apps / 'fixture.desktop').write_text(
                    f'[Desktop Entry]\nType=Application\nName={name}\nExec=/usr/bin/true\n',
                )
            caller_env = {
                'XDG_DATA_HOME': str(caller / 'data'), 'XDG_DATA_DIRS': str(caller / 'empty'),
                'XDG_CURRENT_DESKTOP': 'Fixture',
            }
            activation_env = {
                **os.environ, 'HOME': str(activation), 'XDG_DATA_HOME': str(activation / 'data'),
                'XDG_DATA_DIRS': str(activation / 'empty'), 'XDG_CURRENT_DESKTOP': 'Impostor',
            }

            async def command(argv, *, stdin_data=None):
                calls.append(argv)
                if argv[0] == '/usr/bin/uwsm-app':
                    self.assertIsNone(stdin_data)
                    return ''
                process = subprocess.Popen(argv, env=activation_env, stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)

                def cleanup():
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    for pipe in (process.stdin, process.stdout, process.stderr):
                        pipe.close()

                self.addCleanup(cleanup)
                try:
                    async with asyncio.timeout(5):
                        while True:
                            if process.poll() is not None:
                                stdout, stderr = process.communicate(timeout=5)
                                self.fail(f'Native helper exited before cmdline observation: '
                                          f'{process.returncode}, {stdout[:4096]!r}, {stderr[:4096]!r}')
                            cmdline = Path(f'/proc/{process.pid}/cmdline').read_bytes()
                            parts = cmdline.split(b'\x00')
                            if parts[0] == b'/usr/bin/python' and str(bot.ROOT / 'app_resolver.py').encode() in parts:
                                break
                            await asyncio.sleep(0)
                    self.assertNotIn(private_name.encode(), cmdline, 'Private query must not enter process argv')
                    self.assertEqual(stdin_data, b'FixturePrivateQuery_3a61')
                    stdout, stderr = process.communicate(input=stdin_data, timeout=5)
                    if process.returncode != 0 and os.environ.get('CI') == 'true' and b'Gio unavailable' in stderr:
                        self.skipTest('Hosted system Python/Gio unavailable; native evidence requires local execution')
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertEqual(json.loads(stdout), 'fixture.desktop')
                    self.assertNotIn(private_name.encode(), stdout + stderr)
                    return stdout.decode()
                finally:
                    cleanup()

            with patch.object(bot.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir=str(caller))), \
                    patch.dict(os.environ, caller_env):
                name = bot.match_app_name(f'open {private_name}')
                self.assertEqual(name, 'FixturePrivateQuery_3a61')
                tool = await bot.resolve_app_tool(name, command=command)
                self.assertIsNotNone(tool)
                result = await tool.run(command=command)
            self.assertTrue(result.accepted)
            self.assertEqual(len(calls), 2)
            launch = calls[1]
            self.assertEqual(launch[:5], ('/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env'))
            self.assertEqual(launch[-2:], ('/usr/bin/gtk-launch', 'fixture.desktop'))
            # Execute the captured launch environment with a lookup probe, never the actual launcher.
            probe = (*launch[4:-2], '/usr/bin/python', '-I', str(bot.ROOT / 'app_resolver.py'))
            completed = subprocess.run(probe, input='Impostor', env=activation_env, capture_output=True, text=True, timeout=5)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIsNone(json.loads(completed.stdout), 'Captured caller roots must override activation roots')
