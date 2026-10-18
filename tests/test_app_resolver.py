"""Installed-app policy and native Gio wire proofs, without launching apps."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import app_resolver
import bot


class AppResolverTests(unittest.IsolatedAsyncioTestCase):
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
                with redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(app_resolver.main([name]), 0)
                self.assertEqual(json.loads(output.getvalue()), expected)
                self.assertEqual(errors.getvalue(), '')
            gio.AppInfo.get_all.return_value = [app('Fixture App', '../bad.desktop')]
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(app_resolver.main(['Fixture App']), 1)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(errors.getvalue(), 'Invalid installed-app metadata\n')
        with patch.dict(sys.modules, {'gi': None}):
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(app_resolver.main(['Fixture App']), 1)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(errors.getvalue(), 'Gio unavailable\n')
        for args in ([], ['a', 'b'], [''], ['  '], ['a\nb'], ['a\x00b'], ['x' * 1025]):
            with self.subTest(args=args):
                output, errors = io.StringIO(), io.StringIO()
                with redirect_stdout(output), redirect_stderr(errors):
                    self.assertEqual(app_resolver.main(args), 1)
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(errors.getvalue(), 'Invalid app name\n')

    async def test_native_resolver_wire_success_and_unknown(self):
        if not Path('/usr/bin/python').is_file():
            if os.environ.get('CI') == 'true':
                self.skipTest('Hosted system Python unavailable; native evidence requires local execution')
            self.fail('Local native system Python is required')
        calls = []
        with tempfile.TemporaryDirectory(prefix='kestrel-apps-') as directory:
            root = Path(directory)
            caller, activation = root / 'caller ; literal', root / 'activation'
            for base, name in ((caller, 'FixtureApp'), (activation, 'Impostor')):
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

            async def command(argv):
                calls.append(argv)
                if argv[0] == '/usr/bin/uwsm-app':
                    return ''
                completed = subprocess.run(argv, env=activation_env, capture_output=True, text=True, timeout=5)
                if completed.returncode != 0 and os.environ.get('CI') == 'true' and 'Gio unavailable' in completed.stderr:
                    self.skipTest('Hosted system Python/Gio unavailable; native evidence requires local execution')
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout), 'fixture.desktop')
                return completed.stdout

            with patch.object(bot.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir=str(caller))), \
                    patch.dict(os.environ, caller_env):
                tool = await bot.resolve_app_tool('open FixtureApp', command=command)
                self.assertIsNotNone(tool)
                result = await tool.run(command=command)
            self.assertTrue(result.accepted)
            self.assertEqual(len(calls), 2)
            launch = calls[1]
            self.assertEqual(launch[:5], ('/usr/bin/uwsm-app', '-t', 'service', '--', '/usr/bin/env'))
            self.assertEqual(launch[-2:], ('/usr/bin/gtk-launch', 'fixture.desktop'))
            # Execute the captured launch environment with a lookup probe, never the actual launcher.
            probe = (*launch[4:-2], '/usr/bin/python', '-I', str(bot.ROOT / 'app_resolver.py'), 'Impostor')
            completed = subprocess.run(probe, env=activation_env, capture_output=True, text=True, timeout=5)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIsNone(json.loads(completed.stdout), 'Captured caller roots must override activation roots')
