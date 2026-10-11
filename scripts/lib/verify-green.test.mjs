// verify-green.test.mjs — real-shell tests for both runtime Stop gates.
//
// The gate used to `cd "$CLAUDE_PROJECT_DIR"`. Claude Code keeps that value at the project root
// where the session STARTED and moves only the working directory when the session enters a job
// worktree, so for a session working inside `.claude/worktrees/<job>` the hook inspected the CLEAN
// root checkout, matched nothing under `-- src`, and exited 0 IN SILENCE — passing on exactly the
// change it exists to check. Root now comes from `git rev-parse --show-toplevel`, with
// CLAUDE_PROJECT_DIR kept only as the fallback for a run with no work tree under it.
// These tests run both REAL hooks (read fresh off disk) in scratch git repositories. They preserve
// the runtime-specific root adapters, then distinguish inapplicable, unavailable, clean, and
// completed-with-findings lint outcomes at the shell boundary. The product gate at
// scripts/gates/stop is synthetic here and pinned on a clean tree, so its result alone decides;
// the product's own gate is tested with the product.
//
// Recurring cost: about 5 seconds for isolated Git, npm, fake-ESLint, and fake-gate subprocesses.
// Removal condition: remove with the Stop gates, or replace when the agent runtimes provide an
// equivalent native three-way outcome contract.
//
// Run: node --test scripts/lib/   (or `npm run test:scripts`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixShell } from './posix-shell.mjs';
import { presentRuntimes } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT = presentRuntimes(ROOT);
const without = (runtime) => !PRESENT.includes(runtime) && `the settings file names no ${runtime} runtime`;
// The located POSIX shell: `sh` off Windows, Git for Windows' sh.exe on it, null when there is none.
const SHELL = posixShell();
const NO_SHELL = 'a POSIX shell is required: install Git for Windows';
// Each hook with the program that launches it: Codex on native Windows runs hook commands in
// PowerShell, so its Stop hook is the Node launcher, which must reproduce the `.sh` outcome exactly.
const CLAUDE_HOOK = { launcher: SHELL, script: resolve(ROOT, '.claude/hooks/verify-green.sh') };
const CODEX_HOOK = { launcher: SHELL, script: resolve(ROOT, '.codex/hooks/verify-green.sh') };
const CODEX_LAUNCHER = { launcher: process.execPath, script: resolve(ROOT, '.codex/hooks/verify-green.mjs') };
const HOOKS = [
  ...(PRESENT.includes('claude') ? [CLAUDE_HOOK] : []),
  ...(PRESENT.includes('codex') ? [CODEX_HOOK, CODEX_LAUNCHER] : []),
];

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

// Scratch root checkout with a committed baseline: src/a.txt ("A") and a lint fixture (a
// package.json lint script and a fake ESLint whose exit FAKE_ESLINT_STATUS sets). npm on Windows runs
// the script through cmd.exe, which needs the fake's `.cmd` twin there.
function initRootRepo(scratch) {
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.txt'), 'A');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
  const eslint = join(repo, 'node_modules', '.bin', 'eslint');
  writeFileSync(eslint, '#!/bin/sh\nprintf "eslint-status-%s-sentinel\\n" "${FAKE_ESLINT_STATUS:-0}" >&2\nexit "${FAKE_ESLINT_STATUS:-0}"\n');
  chmodSync(eslint, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(`${eslint}.cmd`, '@echo off\r\necho eslint-status-%FAKE_ESLINT_STATUS%-sentinel 1>&2\r\nexit /b %FAKE_ESLINT_STATUS%\r\n');
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base']);
  return repo;
}

// The hook reads its event JSON from stdin; `{}` is a first (non-recursive) Stop event.
function runHook(hook, cwd, projectDir, { input = '{}', env = {} } = {}) {
  assert.ok(hook.launcher, NO_SHELL);
  const r = spawnSync(hook.launcher, [hook.script], {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, FAKE_ESLINT_STATUS: '0', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makePending(repo) {
  writeFileSync(join(repo, 'src', 'a.txt'), 'A2');
}

function withScratchRoot(fn) {
  // mkdtemp under realpathSync(tmpdir()): on macOS os.tmpdir() is a /var → /private/var symlink and git
  // reports the resolved form, so the fixture is built canonical rather than half-resolved.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'verify-green-'));
  try {
    fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('Stop gate: every installed runtime uses ancestor-installed ESLint for a linked worktree', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    const worktree = join(root, '.claude', 'worktrees', 'job');
    git(root, ['worktree', 'add', '-q', worktree, '-b', 'job']);
    rmSync(join(worktree, 'node_modules'), { recursive: true, force: true });
    makePending(worktree);

    for (const hook of HOOKS) {
      const result = runHook(hook, worktree, root, { env: { FAKE_ESLINT_STATUS: '1' } });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /npm run lint exited 1\. Fix before finishing/);
      assert.match(result.stderr, /eslint-status-1-sentinel/);
    }
  });
});

test('Stop gate: with no Git work tree under the working directory, CLAUDE_PROJECT_DIR is still the fallback root', { skip: without('claude') }, () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    const outside = join(scratch, 'outside');
    mkdirSync(outside);

    // Mutation guard: delete the `[ -n "$root" ] || root="$CLAUDE_PROJECT_DIR"` fallback → no root
    // resolves and the gate exits 0 with a stated could-not-verify reason instead of the silent
    // verified pass, so silence is the assertion that distinguishes the two.
    const r = runHook(CLAUDE_HOOK, outside, root);
    assert.equal(r.status, 0, `the clean fallback root must pass: ${r.stderr}`);
    assert.equal(r.stderr, '', 'a clean fallback root is a verified pass, not a could-not-verify');
  });
});

test('Stop gate: recursive Stop input is inapplicable and silent', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    writeFileSync(join(root, 'src', 'a.txt'), 'drift');
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root, { input: '{"stop_hook_active":true}' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
  });
});

test('Stop gate: a missing lint script makes lint explicitly unavailable', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /package\.json has no declared lint script, so the lint observation is unavailable/);
    }
  });
});

test('Stop gate: malformed package.json blocks and surfaces the parse failure', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    writeFileSync(join(root, 'package.json'), '{ "scripts": { "lint": ');
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /package\.json could not be read and parsed\. Fix before finishing/);
      assert.match(r.stderr, /SyntaxError/);
      assert.doesNotMatch(r.stderr, /no declared lint script/);
    }
  });
});

test('Stop gate: a missing local or ancestor ESLint executable makes lint explicitly unavailable', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    rmSync(join(root, 'node_modules', '.bin', 'eslint'));
    rmSync(join(root, 'node_modules', '.bin', 'eslint.cmd'), { force: true });
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /installed ESLint executable is unavailable/);
    }
  });
});

test('Stop gate: every completed nonzero lint result blocks with the actual ESLint output', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    for (const status of ['1', '2']) {
      for (const hook of HOOKS) {
        const r = runHook(hook, root, root, { env: { FAKE_ESLINT_STATUS: status } });
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, new RegExp(`npm run lint exited ${status}\\. Fix before finishing`));
        assert.match(r.stderr, new RegExp(`eslint-status-${status}-sentinel`));
      }
    }
  });
});

test('Stop gate: runnable lint succeeds silently', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
  });
});

// A PATH directory holding only the named commands, so a test can take away one tool the hook needs.
// Each entry is a wrapper stub rather than a symlink, because a symlink needs privilege on Windows.
function pathWithOnly(scratch, label, commands) {
  const bin = join(scratch, label);
  mkdirSync(bin);
  assert.ok(SHELL, NO_SHELL);
  for (const command of commands) {
    const found = spawnSync(SHELL, ['-c', `command -v ${command}`], { encoding: 'utf8' });
    assert.equal(found.status, 0, `fixture requires ${command}`);
    writeFileSync(join(bin, command), `#!/bin/sh\nexec "${found.stdout.trim()}" "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

// The Codex launcher finds its shell as sh.exe on PATH, which no wrapper stub is, so on Windows the
// real shell's own directory follows the stubs; that Git for Windows directory holds no node or npm.
function restrictedPath(bin) {
  if (process.platform !== 'win32') return bin;
  const shellDir = dirname(SHELL);
  for (const name of ['node.exe', 'npm', 'npm.cmd']) {
    assert.ok(
      !existsSync(join(shellDir, name)),
      `the shell's directory ${shellDir} also holds node or npm, so it cannot give the launcher its shell without restoring the tool this test removes`,
    );
  }
  return [bin, shellDir].join(delimiter);
}

test('Stop gate: missing Node makes lint explicitly unavailable', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    const path = restrictedPath(pathWithOnly(scratch, 'bin-without-node', ['cat', 'dirname', 'git', 'npm', 'sh']));
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root, { env: { PATH: path } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /node is not on PATH.*lint observation is unavailable/);
    }
  });
});

test('Stop gate: missing npm makes lint explicitly unavailable', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    makePending(root);
    const path = restrictedPath(pathWithOnly(scratch, 'bin-without-npm', ['cat', 'dirname', 'git', 'node', 'sh']));
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root, { env: { PATH: path } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /npm is not on PATH.*lint observation is unavailable/);
    }
  });
});

// Synthetic product gates at scripts/gates/stop. The passing gate writes a marker relative to its
// working directory, so the marker landing at the root also proves the gate runs from the root.
const GATE_PASSING = '#!/bin/sh\n: > gate-ran\n';
const GATE_UNAVAILABLE = '#!/bin/sh\necho "gate-unavailable-sentinel: could not verify" >&2\nexit 0\n';
const GATE_FAILING = '#!/bin/sh\necho "gate-stdout-sentinel"\necho "gate-stderr-sentinel" >&2\nexit 2\n';

function writeStopGate(repo, body, mode = 0o755) {
  const gate = join(repo, 'scripts', 'gates', 'stop');
  mkdirSync(dirname(gate), { recursive: true });
  writeFileSync(gate, body);
  chmodSync(gate, mode);
  return gate;
}

test('product gate: a passing Stop gate runs from the repository root and the hook continues', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    writeStopGate(root, GATE_PASSING);
    for (const hook of HOOKS) {
      rmSync(join(root, 'gate-ran'), { force: true });
      const r = runHook(hook, join(root, 'src'), root);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.ok(existsSync(join(root, 'gate-ran')), 'the gate must run with the repository root as working directory');
    }
    // With a src/ change pending, the shared lint step after the gate still runs and blocks.
    makePending(root);
    for (const hook of HOOKS) {
      rmSync(join(root, 'gate-ran'), { force: true });
      const r = runHook(hook, root, root, { env: { FAKE_ESLINT_STATUS: '1' } });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /npm run lint exited 1\. Fix before finishing/);
      assert.ok(existsSync(join(root, 'gate-ran')));
    }
  });
});

test('product gate: an absent Stop gate leaves the hook silent and passing', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
  });
});

test('product gate: a failing Stop gate blocks with its own output and then a reason naming the gate and code', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    writeStopGate(root, GATE_FAILING);
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      // Mutation guard: a hook that ignores the gate's exit status exits 0 on this clean tree.
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, '');
      const reason = r.stderr.search(/scripts\/gates\/stop exited 2/);
      assert.ok(reason > 0, r.stderr);
      assert.ok(r.stderr.indexOf('gate-stdout-sentinel') >= 0 && r.stderr.indexOf('gate-stdout-sentinel') < reason, r.stderr);
      assert.ok(r.stderr.indexOf('gate-stderr-sentinel') >= 0 && r.stderr.indexOf('gate-stderr-sentinel') < reason, r.stderr);
    }
  });
});

test('product gate: an unavailable Stop gate passes with only its own stated reason', () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    writeStopGate(root, GATE_UNAVAILABLE);
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, 'gate-unavailable-sentinel: could not verify\n');
    }
  });
});

test('product gate: a non-executable Stop gate blocks and names the chmod fix', { skip: process.platform === 'win32' && 'the executable bit does not exist on Windows' }, () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    const gate = writeStopGate(root, GATE_PASSING, 0o644);
    for (const hook of HOOKS) {
      const r = runHook(hook, root, root);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(`chmod +x ${gate}`), r.stderr);
    }
  });
});

test('Codex Stop launcher: no reachable POSIX shell blocks with the Git for Windows remedy', { skip: without('codex') }, () => {
  withScratchRoot((scratch) => {
    const root = initRootRepo(scratch);
    // An empty PATH leaves `sh` unspawnable (ENOENT), the same outcome as a Windows host with no shell.
    const r = runHook(CODEX_LAUNCHER, root, root, { env: { PATH: '' } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no POSIX shell found; install Git for Windows/);
  });
});
