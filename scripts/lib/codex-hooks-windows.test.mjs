// codex-hooks-windows.test.mjs — each Codex hook's Windows registration enforces its rule.
//
// Codex on native Windows runs a hook's `commandWindows` as `<PowerShell> -NoProfile -Command <string>`,
// with the event JSON on stdin and the session working directory. This runs every `commandWindows` in
// .codex/hooks.json, read fresh off disk, exactly that way through each PowerShell on PATH: Windows
// PowerShell 5.1, which Codex detects on stock Windows, and pwsh 7. PowerShell `-Command` collapses a
// native exit code other than 0 or 1 to 1, so a blocking hook's exit 2 survives only through the
// string's own `exit $LASTEXITCODE`. Any native command resets $LASTEXITCODE, the path's `git rev-parse`
// included, so the seed of 1 comes after it: a `node` PowerShell cannot find then exits 1, not 0.
//
// A failing `git rev-parse` falls back to the working directory, as the POSIX form does.
//
// Recurring cost: seven hook runs per PowerShell found, each a PowerShell and Node start, and one
// `npm run lint` per PowerShell, plus two scratch Git repositories and one scratch directory; nothing
// where no PowerShell is on PATH.
// Removal condition: remove when Codex fires hooks on native Windows in a live-session test that
// replaces this registration proof.
//
// Run: node --test scripts/lib/   (or `npm run test:scripts`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { hooks } = JSON.parse(readFileSync(resolve(ROOT, '.codex/hooks.json'), 'utf8'));
const windowsCommand = (event, matcher) => hooks[event].find((h) => h.matcher === matcher).hooks[0].commandWindows;
const BASH_GUARD = windowsCommand('PreToolUse', 'Bash');
const HANDOFF_GUARD = windowsCommand('PreToolUse', 'collaborationspawn_agent');
const STOP = windowsCommand('Stop', undefined);

// The first file on PATH with any of the names, as a full path.
const findOnPath = (names) => (process.env.PATH ?? '').split(delimiter)
  .flatMap((dir) => (dir ? names.map((name) => join(dir, name)) : []))
  .find((file) => existsSync(file));
// Windows PowerShell, then pwsh, each by whichever of its names is on PATH.
const POWERSHELLS = [['powershell.exe', 'powershell'], ['pwsh.exe', 'pwsh']]
  .map(findOnPath)
  .filter(Boolean);
const NEEDS_POWERSHELL = { skip: POWERSHELLS.length === 0 && 'no PowerShell on PATH: this proof runs on the Windows CI job' };

function runEach(commandWindows, { cwd, input, env = {} }) {
  return POWERSHELLS.map((ps) => {
    const r = spawnSync(ps, ['-NoProfile', '-Command', commandWindows], {
      cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { ps, status: r.status, stderr: r.stderr };
  });
}

test('Bash guard commandWindows blocks a forced push', NEEDS_POWERSHELL, () => {
  const input = JSON.stringify({ cwd: ROOT, tool_input: { command: 'git push --force origin main' } });
  for (const r of runEach(BASH_GUARD, { cwd: ROOT, input })) {
    assert.equal(r.status, 2, `${r.ps}: ${r.stderr}`);
    assert.match(r.stderr, /Blocked: git push --force/, r.ps);
  }
});

test('Bash guard commandWindows falls back to the working directory when git cannot answer', NEEDS_POWERSHELL, () => {
  // GIT_DIR naming no repository makes `git rev-parse` fail, as the POSIX form's `dirname ""` yields `.`.
  const scratch = mkdtempSync(join(tmpdir(), 'codex hooks windows-'));
  try {
    const input = JSON.stringify({ cwd: ROOT, tool_input: { command: 'git push --force origin main' } });
    for (const r of runEach(BASH_GUARD, { cwd: ROOT, input, env: { GIT_DIR: join(scratch, 'missing') } })) {
      assert.equal(r.status, 2, `${r.ps}: ${r.stderr}`);
      assert.match(r.stderr, /Blocked: git push --force/, r.ps);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Bash guard commandWindows allows an ordinary command', NEEDS_POWERSHELL, () => {
  const input = JSON.stringify({ cwd: ROOT, tool_input: { command: 'ls -la' } });
  for (const r of runEach(BASH_GUARD, { cwd: ROOT, input })) {
    assert.equal(r.status, 0, `${r.ps}: ${r.stderr}`);
  }
});

// A PATH holding git and every PowerShell but not node, unless node shares a directory with one of them.
const GIT = findOnPath(['git.exe', 'git']);
const NO_NODE_PATH = [GIT, ...POWERSHELLS].filter(Boolean).map((file) => dirname(file));
const NEEDS_NODE_APART = POWERSHELLS.length === 0 ? NEEDS_POWERSHELL : {
  skip: NO_NODE_PATH.includes(dirname(process.execPath)) && 'node shares a directory with git or PowerShell, so no PATH can hold them without it',
};

test('Bash guard commandWindows fails, not passes, when node is not on PATH', NEEDS_NODE_APART, () => {
  assert.ok(GIT, 'git is not on PATH');
  // An allowed command, so only a node that never ran can make the hook exit non-zero.
  const input = JSON.stringify({ cwd: ROOT, tool_input: { command: 'ls -la' } });
  for (const r of runEach(BASH_GUARD, { cwd: ROOT, input, env: { PATH: NO_NODE_PATH.join(delimiter) } })) {
    assert.notEqual(r.status, 0, `${r.ps}: ${r.stderr}`);
    assert.notEqual(r.stderr, '', r.ps);
  }
});

test('builder-handoff guard commandWindows blocks an incomplete builder handoff', NEEDS_POWERSHELL, () => {
  const input = JSON.stringify({ tool_input: { agent_type: 'builder', message: 'x' } });
  for (const r of runEach(HANDOFF_GUARD, { cwd: ROOT, input })) {
    assert.equal(r.status, 2, `${r.ps}: ${r.stderr}`);
    assert.match(r.stderr, /Blocked:/, r.ps);
  }
});

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

// A scratch repository holding the Stop hook's files at their repository paths, a lint fixture (a
// package.json lint script and a fake ESLint whose exit FAKE_ESLINT_STATUS sets, with the `.cmd` twin
// npm on Windows runs through cmd.exe), and a committed src/a.txt with a pending change. The space in
// its path proves the resolved hook path reaches node as one argument.
function withStopRepo(fn) {
  // realpathSync(tmpdir()): on macOS os.tmpdir() is a /var → /private/var symlink and git reports
  // the resolved form.
  const repo = mkdtempSync(join(realpathSync(tmpdir()), 'codex hooks windows-'));
  try {
    for (const file of ['.codex/hooks/verify-green.mjs', '.codex/hooks/verify-green.sh', 'scripts/lib/posix-shell.mjs']) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      copyFileSync(resolve(ROOT, file), join(repo, file));
    }
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.txt'), 'A');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    const eslint = join(repo, 'node_modules', '.bin', 'eslint');
    mkdirSync(dirname(eslint), { recursive: true });
    writeFileSync(eslint, '#!/bin/sh\nexit "${FAKE_ESLINT_STATUS:-0}"\n');
    chmodSync(eslint, 0o755);
    if (process.platform === 'win32') {
      writeFileSync(`${eslint}.cmd`, '@echo off\r\nexit /b %FAKE_ESLINT_STATUS%\r\n');
    }
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base']);
    writeFileSync(join(repo, 'src', 'a.txt'), 'A2');
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('Stop commandWindows blocks a failing lint on a pending src/ change', NEEDS_POWERSHELL, () => {
  withStopRepo((repo) => {
    for (const r of runEach(STOP, { cwd: repo, input: '{}', env: { FAKE_ESLINT_STATUS: '1' } })) {
      assert.equal(r.status, 2, `${r.ps}: ${r.stderr}`);
      assert.match(r.stderr, /npm run lint exited 1/, r.ps);
    }
  });
});

test('Stop commandWindows exits 0 silently on a recursive Stop', NEEDS_POWERSHELL, () => {
  withStopRepo((repo) => {
    // The failing lint and pending change make silence prove the recursion guard read stdin.
    for (const r of runEach(STOP, { cwd: repo, input: '{"stop_hook_active":true}', env: { FAKE_ESLINT_STATUS: '1' } })) {
      assert.equal(r.status, 0, `${r.ps}: ${r.stderr}`);
      assert.equal(r.stderr, '', r.ps);
    }
  });
});
