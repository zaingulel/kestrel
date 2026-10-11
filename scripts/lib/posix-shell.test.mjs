import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitExecutable, posixShell } from './posix-shell.mjs';

// Every expected path below is a hand-written literal, never re-derived with path.win32, so the
// resolution logic under test is not also the oracle.
const GIT_EXEC_PATH = 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core';
const GIT_SH = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';

const existsOnly = (...paths) => (candidate) => paths.includes(candidate);

test('a non-win32 platform uses sh from PATH', () => {
  assert.equal(
    posixShell({ platform: 'darwin', env: {}, gitExecPath: '', exists: () => false }),
    'sh',
  );
});

test('win32 returns the first sh.exe found on PATH', () => {
  assert.equal(
    posixShell({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32;C:\\tools\\msys\\bin;C:\\other\\bin' },
      gitExecPath: GIT_EXEC_PATH,
      exists: existsOnly('C:\\tools\\msys\\bin\\sh.exe', 'C:\\other\\bin\\sh.exe', GIT_SH),
    }),
    'C:\\tools\\msys\\bin\\sh.exe',
  );
});

test('win32 without sh.exe on PATH falls back to the sh.exe beside Git', () => {
  assert.equal(
    posixShell({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32' },
      gitExecPath: GIT_EXEC_PATH,
      exists: existsOnly(GIT_SH),
    }),
    GIT_SH,
  );
});

test('win32 with neither a PATH sh.exe nor Git\'s sh.exe returns null', () => {
  assert.equal(
    posixShell({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32' },
      gitExecPath: GIT_EXEC_PATH,
      exists: () => false,
    }),
    null,
  );
});

test('win32 with an empty git exec path returns null instead of throwing', () => {
  assert.equal(
    posixShell({
      platform: 'win32',
      env: {},
      gitExecPath: '',
      exists: (candidate) => candidate === GIT_SH,
    }),
    null,
  );
});

test('win32 with a relative git exec path returns null instead of resolving against the working directory', () => {
  assert.equal(
    posixShell({
      platform: 'win32',
      env: {},
      gitExecPath: 'mingw64\\libexec\\git-core',
      exists: () => true,
    }),
    null,
  );
});

test('win32 with no sh.exe or git.exe on PATH probes only PATH entries and returns null', () => {
  const probed = [];
  assert.equal(
    posixShell({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32;C:\\tools\\bin' },
      exists: (candidate) => {
        probed.push(candidate);
        return false;
      },
    }),
    null,
  );
  assert.deepEqual(probed, [
    'C:\\Windows\\System32\\sh.exe',
    'C:\\tools\\bin\\sh.exe',
    'C:\\Windows\\System32\\git.exe',
    'C:\\tools\\bin\\git.exe',
  ]);
});

test('win32 skips relative PATH entries, which resolve against the working directory', () => {
  const probed = [];
  // `.` joins to a bare `sh.exe`; every relative spelling is accepted, so only a skip can return null.
  const relative = ['sh.exe', '.\\sh.exe', 'relative\\bin\\sh.exe', 'git.exe', '.\\git.exe', 'relative\\bin\\git.exe'];
  assert.equal(
    posixShell({
      platform: 'win32',
      env: { PATH: '.;relative\\bin;C:\\abs' },
      exists: (candidate) => {
        probed.push(candidate);
        return relative.includes(candidate);
      },
    }),
    null,
  );
  assert.deepEqual(probed, ['C:\\abs\\sh.exe', 'C:\\abs\\git.exe']);
});

test('a non-win32 platform runs git by name', () => {
  assert.equal(gitExecutable({ platform: 'darwin', env: {}, exists: () => false }), 'git');
});

test('win32 runs the git.exe in an absolute PATH entry, never one in a relative entry', () => {
  assert.equal(
    gitExecutable({
      platform: 'win32',
      env: { PATH: '.;relative\\bin;C:\\Program Files\\Git\\cmd' },
      exists: existsOnly('git.exe', 'relative\\bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'),
    }),
    'C:\\Program Files\\Git\\cmd\\git.exe',
  );
});

test('win32 with no git.exe in an absolute PATH entry returns null', () => {
  assert.equal(
    gitExecutable({
      platform: 'win32',
      env: { PATH: '.;C:\\Windows\\System32' },
      exists: existsOnly('git.exe'),
    }),
    null,
  );
});

// Windows' default executable search tries the working directory before PATH, so a hook run in a
// repository holding a git.exe would run it. The planted git.exe is a copy of node, which rejects
// --exec-path, so a shell found through it would be none at all.
// Recurring cost: one copy of the node binary, one node start and one git start, on Windows only.
// Removal condition: remove when posixShell no longer asks git for its exec path.
test('win32 posixShell ignores a git.exe in the working directory', {
  skip: process.platform !== 'win32' && 'the working-directory executable search exists only on Windows',
}, (t) => {
  const nodeDir = path.dirname(process.execPath);
  if (['sh.exe', 'git.exe'].some((name) => existsSync(path.join(nodeDir, name)))) {
    t.skip('node shares a directory with sh.exe or git.exe, so no PATH can hold node without them');
    return;
  }
  const gitDir = (process.env.PATH ?? '').split(';').filter(Boolean)
    .find((dir) => existsSync(path.join(dir, 'git.exe')) && !existsSync(path.join(dir, 'sh.exe')));
  assert.ok(gitDir, 'no PATH directory holds git.exe without sh.exe');
  const gitExecPath = execFileSync(path.join(gitDir, 'git.exe'), ['--exec-path'], { encoding: 'utf8' }).trim();
  const expected = path.resolve(gitExecPath, '..', '..', '..', 'usr', 'bin', 'sh.exe');
  assert.ok(existsSync(expected), `Git ships no sh.exe at ${expected}`);

  const planted = mkdtempSync(path.join(tmpdir(), 'posix-shell-'));
  try {
    copyFileSync(process.execPath, path.join(planted, 'git.exe'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('./posix-shell.mjs', import.meta.url))).href;
    const r = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { posixShell } from ${JSON.stringify(moduleUrl)}; console.log(posixShell());`,
    ], { cwd: planted, env: { ...env, PATH: [gitDir, nodeDir].join(';') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const printed = r.stdout.trim();
    assert.equal(printed.toLowerCase(), expected.toLowerCase());
    assert.ok(!printed.toLowerCase().startsWith(planted.toLowerCase() + path.sep), printed);
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});
