// run-log.test.mjs — scripts/run-log.mjs writes what actually happened.
//
// The log line is what a pull request body quotes as machine-written evidence, so the three
// outcomes must be distinguishable: a real exit code, a signal, and a command that never started.
// Mutation: collapse the spawn-failure branch back to `exit 1` and the third case goes red.
// Each receipt also records the commit and working-tree state; an unknown state never reads as clean.
// Resolution of bare npm/npx runs with the platform set to win32, so removing it turns the npm/npx subtest red on every platform.
// As the shim does, a CLI under the global prefix npm-prefix.js prints wins; always use the CLI beside the shim and the prefix subtest goes red.
// Most subtests call `main` in-process and start no process; the command-line subtests keep Git off PATH; only the clean and hidden-untracked subtests start real Git, because only real Git shows what its status flags report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from '../run-log.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../run-log.mjs');
const TEST_ENV = { ...process.env };
delete TEST_ENV.RUN_LOG_RERUN_REASON;
const NO_POSIX_SIGNALS = process.platform === 'win32' && 'POSIX signals and /bin/sh do not exist on Windows; a killed child exits 1 there';

function withDir(fn) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'run-log-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withRepo(fn) {
  withDir((repo) => {
    spawnSync('git', ['init', '-q', '-b', 'job/42'], { cwd: repo });
    fn(repo);
  });
}

function run(repo, args, { env = TEST_ENV } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env });
}

// The spawn result of a program that does not exist: Git off PATH, or a command that cannot be started.
function notFound() {
  return { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
}

// A spawnSync stand-in for `main`: `git` answers every Git call (node's own spawnSync gives real Git) and `child`
// answers everything else. `calls` records each call's file, arguments and options.
function fakeSpawn({ git = notFound, child = () => ({ status: 0 }) } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return file === 'git' ? git(file, args, options) : child(file, args, options);
  };
  return { spawnSync: spawn, calls };
}

// A Git that answers the four questions run-log asks from the current `state()`: `head` is a commit or null (unborn), `status` is porcelain output.
function fakeGit(state) {
  return (file, args, options) => {
    const { head, status } = state();
    const [verb, flag] = args;
    if (verb === 'branch') return { status: 0, stdout: 'job/42\n' };
    if (verb === 'rev-parse' && flag === '--show-toplevel') return { status: 0, stdout: options.cwd };
    if (verb === 'rev-parse' && flag === '--verify') return head === null ? { status: 128 } : { status: 0, stdout: `${head}\n` };
    if (verb === 'status') return { status: 0, stdout: status };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

// Runs `main` in-process against the given dependencies, collecting what it prints instead of printing it.
function runMain(dir, args, dependencies = {}) {
  let stdout = '';
  let stderr = '';
  const output = {
    log: (message) => { stdout += `${message}\n`; },
    error: (message) => { stderr += `${message}\n`; },
  };
  const { exitCode, signal } = main(args, { spawnSync: fakeSpawn().spawnSync, env: TEST_ENV, cwd: dir, output, ...dependencies });
  return { exitCode, signal, stdout, stderr };
}

// The file and arguments of every call that is not Git.
function started(calls) {
  return calls.filter(({ file }) => file !== 'git').map(({ file, args }) => [file, args]);
}

function npmBin(dir, file) {
  return join(dir, 'node_modules', 'npm', 'bin', file);
}

// A fake npm install: npm.cmd and npx.cmd, with their CLI scripts and npm-prefix.js beside them when asked. Only the files' existence matters.
function withFakeNpm(fn, { cli = true, prefixScript = false } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'run-log-npm-'));
  try {
    mkdirSync(npmBin(dir, ''), { recursive: true });
    if (prefixScript) writeFileSync(npmBin(dir, 'npm-prefix.js'), '');
    for (const tool of ['npm', 'npx']) {
      writeFileSync(join(dir, `${tool}.cmd`), '');
      if (cli) writeFileSync(npmBin(dir, `${tool}-cli.js`), '');
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fake global prefix; its npm and npx CLI scripts, when present, are empty files.
function withFakePrefix(fn, { cli = true } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'run-log-prefix-'));
  try {
    mkdirSync(npmBin(dir, ''), { recursive: true });
    if (cli) for (const tool of ['npm', 'npx']) writeFileSync(npmBin(dir, `${tool}-cli.js`), '');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The child answers for a fake npm: the prefix query prints a junk line and then `prefix`, as npm-prefix.js's last line is the prefix; any other child exits `status`.
function prefixAnswer(prefixJs, prefix, status) {
  return (file, args) => (args[0] === prefixJs ? { status: 0, stdout: `junk\n${prefix}\n` } : { status });
}

// PATH replaced whatever its case, since Windows environment names are case-insensitive.
function envWithPath(path, extra = {}) {
  const env = Object.fromEntries(Object.entries(TEST_ENV).filter(([key]) => key.toUpperCase() !== 'PATH'));
  return { ...env, ...extra, PATH: path };
}

// Outside a repository run-log names the log detached.md.
function detachedReceipt(dir) {
  return receiptFields(readFileSync(join(dir, '.claude', 'worklog', 'detached.md'), 'utf8').trimEnd().split('\n').at(-1));
}

const IDENTITY = ['-c', 'user.name=run-log-test', '-c', 'user.email=run-log@example.invalid'];

function commit(repo) {
  const r = spawnSync('git', [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function head(repo) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
}

function logLines(repo, file = 'job_42.md') {
  const lines = readFileSync(join(repo, '.claude', 'worklog', file), 'utf8').trim().split('\n');
  lines.forEach(receiptFields);
  return lines;
}

// Every stored receipt must retain complete timing, including unsuccessful child outcomes.
function receiptFields(line) {
  const match = line.match(/^- ([^ ]+) \| (.*?) \| `([^`]*)` \| (.*?) \| completed=([^ ]+) \| elapsedMs=(\d+(?:\.\d+)?) \| rerunReason=`([^`]*)` \| (head=.* tree=.*)$/);
  assert.ok(match, line);
  const [, started, label, argv, outcome, completed, elapsedMs, reason, state] = match;
  for (const timestamp of [started, completed]) {
    assert.equal(new Date(timestamp).toISOString(), timestamp, 'timestamps must be canonical UTC');
  }
  return { started, label, command: JSON.parse(argv), outcome, completed, elapsedMs: Number(elapsedMs), rerunReason: JSON.parse(reason), state };
}

// Both clocks start fixed and move only when told. Each attempted Git call, even one that fails to start, advances them by a distinct, excluded amount.
function fakeClock() {
  let tick = 1000000000n;
  let utc = Date.parse('2026-09-26T10:00:00.000Z');
  return {
    now: () => new Date(utc),
    hrtime: () => tick,
    afterGit() {
      tick += 1000000000n;
      utc += 1000;
    },
    afterChild() {
      tick += 137500000n;
      utc += 2000;
    },
  };
}

test('command receipt contract', async (t) => {
  await t.test('monotonic child duration and UTC boundaries exclude Git snapshots for every outcome', () => {
    withDir((dir) => {
      const nodeExit = (code) => [process.execPath, '-e', `process.exit(${code})`];
      const cases = [
        { command: nodeExit(0), result: { status: 0 }, exitCode: 0, signal: undefined, outcome: 'exit 0' },
        { command: nodeExit(3), result: { status: 3 }, exitCode: 3, signal: undefined, outcome: 'exit 3' },
        { command: [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], result: { status: null, signal: 'SIGKILL' }, exitCode: undefined, signal: 'SIGKILL', outcome: 'killed by SIGKILL' },
        { command: ['definitely-not-a-command-xyz'], result: notFound(), exitCode: 127, signal: undefined, outcome: 'spawn failed (ENOENT)' },
      ];
      for (const { command, result, exitCode, signal, outcome } of cases) {
        const clock = fakeClock();
        const { spawnSync: spawn } = fakeSpawn({
          git: () => {
            clock.afterGit();
            return notFound();
          },
          child: () => {
            clock.afterChild();
            return result;
          },
        });
        const r = runMain(dir, ['deterministic clock', '--', ...command], { spawnSync: spawn, now: clock.now, hrtime: clock.hrtime });
        assert.equal(r.exitCode, exitCode, r.stderr);
        assert.equal(r.signal, signal);
        const receipt = receiptFields(logLines(dir, 'detached.md').at(-1));
        assert.deepEqual(receipt.command, command);
        assert.equal(receipt.outcome, outcome);
        assert.equal(receipt.elapsedMs, 137.5, 'the child advances 137.5 milliseconds; each Git call advances a separate second');
        assert.equal(new Date(receipt.completed) - new Date(receipt.started), 2000, 'only the child advances UTC by two seconds');
        assert.equal(receipt.rerunReason, null, 'absent context must not imply a first run');
      }
    });
  });

  await t.test('receipt timestamps are the real UTC time around the run', () => {
    withDir((dir) => {
      const before = Date.now();
      const r = runMain(dir, ['real UTC observer', '--', process.execPath, '-e', 'process.exit(0)']);
      const after = Date.now();
      assert.equal(r.exitCode, 0, r.stderr);
      const receipt = receiptFields(logLines(dir, 'detached.md')[0]);
      assert.ok(before <= Date.parse(receipt.started), 'the start must not precede the run');
      assert.ok(Date.parse(receipt.started) <= Date.parse(receipt.completed));
      assert.ok(Date.parse(receipt.completed) <= after, 'the completion must not follow the run');
    });
  });

  await t.test('explicit rerun context round-trips exactly without Markdown or control injection', () => {
    withDir((dir) => {
      for (const [index, reason] of ['  Changed the assertion  ', 'line\nbreak\r\t` | <tag>&\b\x1f\x7f\u0085\u2028\u2029'].entries()) {
        const r = runMain(dir, ['explicit rerun', '--', process.execPath, '-e', 'process.exit(0)'], {
          env: { ...TEST_ENV, RUN_LOG_RERUN_REASON: reason },
        });
        assert.equal(r.exitCode, 0, r.stderr);
        const lines = logLines(dir, 'detached.md');
        const line = lines.at(-1);
        assert.equal(lines.length, index + 1, 'each invocation adds exactly one receipt line');
        assert.equal([...line.matchAll(/`/g)].length, 4, 'only the command and reason delimiters remain');
        const field = line.match(/\| rerunReason=`([^`]*)` \|/)[1];
        assert.doesNotMatch(field, /[|<>&\u007f-\u009f\u2028\u2029]/);
        assert.equal(receiptFields(line).rerunReason, reason);
      }
    });
  });

  await t.test('blank rerun context is a usage error before any child or receipt is created', () => {
    withDir((dir) => {
      for (const reason of ['', ' \t\r\n']) {
        const { spawnSync: spawn, calls } = fakeSpawn();
        const r = runMain(dir, ['invalid rerun', '--', process.execPath, '-e', 'process.exit(0)'], {
          spawnSync: spawn,
          env: { ...TEST_ENV, RUN_LOG_RERUN_REASON: reason },
        });
        assert.equal(r.exitCode, 2, r.stderr);
        assert.match(r.stderr, /RUN_LOG_RERUN_REASON must be nonblank/);
        assert.deepEqual(calls, [], 'nothing may be started, not even Git');
        assert.throws(() => logLines(dir, 'detached.md'), /ENOENT/);
      }
    });
  });

  await t.test('a passing and a failing command are logged with their real exit codes and propagated', () => {
    withDir((dir) => {
      const env = envWithPath(dir);
      const ok = run(dir, ['focused test', '--', process.execPath, '-e', 'process.exit(0)'], { env });
      assert.equal(ok.status, 0, ok.stderr);
      const red = run(dir, ['mutation red', '--', process.execPath, '-e', 'process.exit(3)'], { env });
      assert.equal(red.status, 3, red.stderr);
      const lines = logLines(dir, 'detached.md');
      assert.equal(lines.length, 2);
      assert.equal(ok.stdout.trimEnd(), lines[0], 'the command line prints the receipt it wrote');
      assert.equal(red.stdout.trimEnd(), lines[1], 'the command line prints the receipt it wrote');
      const passing = lines[0].match(/^- \d{4}-\d{2}-\d{2}T[^ ]+ \| focused test \| `([^`]*)` \| exit 0 \| .* \| head=unknown tree=unknown$/);
      assert.ok(passing, 'the passing receipt must retain its timestamp, label, command field, and exit code');
      assert.deepEqual(JSON.parse(passing[1]), [process.execPath, '-e', 'process.exit(0)']);
      assert.match(lines[1], /\| mutation red \| .* \| exit 3 \| .* \| head=unknown tree=unknown$/);
    });
  });

  await t.test('bare npm and npx start npm\'s CLI, propagate its exit code, and record the command as written', () => {
    withDir((dir) => {
      withFakeNpm((npmDir) => {
        for (const command of [['npm', 'run', 'lint'], ['npx', '--version']]) {
          const { spawnSync: spawn, calls } = fakeSpawn({ child: () => ({ status: 7 }) });
          const r = runMain(dir, ['package manager', '--', ...command], { spawnSync: spawn, env: envWithPath(npmDir), platform: 'win32' });
          assert.equal(r.exitCode, 7, r.stderr);
          assert.deepEqual(started(calls), [[process.execPath, [npmBin(npmDir, `${command[0]}-cli.js`), ...command.slice(1)]]]);
          const receipt = detachedReceipt(dir);
          assert.deepEqual(receipt.command, command);
          assert.equal(receipt.outcome, 'exit 7');
          assert.equal(receipt.state, 'head=unknown tree=unknown');
        }
        const { spawnSync: spawn, calls } = fakeSpawn({ child: () => ({ status: 7 }) });
        const r = runMain(dir, ['package manager', '--', 'npm', 'run', 'lint'], { spawnSync: spawn, env: envWithPath(npmDir), platform: 'linux' });
        assert.equal(r.exitCode, 7, r.stderr);
        assert.deepEqual(started(calls), [['npm', ['run', 'lint']]], 'off Windows the command is spawned unchanged');
      });
    });
  });

  await t.test('importing run-log from a standard-input entry runs nothing and does not throw', async () => {
    const entry = process.argv[1];
    process.argv[1] = '-';
    try {
      const imported = await import(`${pathToFileURL(SCRIPT).href}?stdin-entry`);
      assert.equal(typeof imported.main, 'function');
    } finally {
      process.argv[1] = entry;
    }
  });

  await t.test('main defaults to this process\'s monotonic clock, environment and platform', () => {
    withDir((dir) => {
      withFakeNpm((npmDir) => {
        const hrtimeBigint = process.hrtime.bigint;
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        const savedEnv = { PATH: process.env.PATH, RUN_LOG_RERUN_REASON: process.env.RUN_LOG_RERUN_REASON };
        const ticks = [1000000000n, 1137500000n];
        process.hrtime.bigint = () => (ticks.length > 1 ? ticks.shift() : ticks[0]);
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.env.PATH = npmDir;
        process.env.RUN_LOG_RERUN_REASON = 'default env';
        try {
          const { spawnSync: spawn, calls } = fakeSpawn({ child: () => ({ status: 7 }) });
          const output = { log: () => {}, error: () => {} };
          const { exitCode } = main(['defaults', '--', 'npm', 'run', 'lint'], { spawnSync: spawn, cwd: dir, output });
          assert.equal(exitCode, 7);
          assert.deepEqual(started(calls), [[process.execPath, [npmBin(npmDir, 'npm-cli.js'), 'run', 'lint']]]);
          const receipt = detachedReceipt(dir);
          assert.equal(receipt.rerunReason, 'default env');
          assert.equal(receipt.elapsedMs, 137.5);
        } finally {
          process.hrtime.bigint = hrtimeBigint;
          Object.defineProperty(process, 'platform', platform);
          for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      });
    });
  });

  await t.test('bare npm and npx start the CLI under the global prefix when it exists, as the shim does', () => {
    withDir((dir) => {
      withFakePrefix((prefix) => {
        withFakeNpm((npmDir) => {
          const prefixJs = npmBin(npmDir, 'npm-prefix.js');
          for (const command of [['npm', 'run', 'lint'], ['npx', '--version']]) {
            const { spawnSync: spawn, calls } = fakeSpawn({ child: prefixAnswer(prefixJs, prefix, 9) });
            const r = runMain(dir, ['prefix cli', '--', ...command], { spawnSync: spawn, env: envWithPath(npmDir), platform: 'win32' });
            assert.equal(r.exitCode, 9, r.stderr);
            assert.deepEqual(started(calls), [
              [process.execPath, [prefixJs]],
              [process.execPath, [npmBin(prefix, `${command[0]}-cli.js`), ...command.slice(1)]],
            ]);
            const receipt = detachedReceipt(dir);
            assert.deepEqual(receipt.command, command);
            assert.equal(receipt.outcome, 'exit 9');
          }
        }, { prefixScript: true });
      });
    });
  });

  await t.test('a global prefix without an npm CLI leaves npm on the CLI beside the shim', () => {
    withDir((dir) => {
      withFakePrefix((prefix) => {
        withFakeNpm((npmDir) => {
          const prefixJs = npmBin(npmDir, 'npm-prefix.js');
          const { spawnSync: spawn, calls } = fakeSpawn({ child: prefixAnswer(prefixJs, prefix, 7) });
          const r = runMain(dir, ['prefix without cli', '--', 'npm', 'run', 'lint'], { spawnSync: spawn, env: envWithPath(npmDir), platform: 'win32' });
          assert.equal(r.exitCode, 7, r.stderr);
          assert.deepEqual(started(calls), [
            [process.execPath, [prefixJs]],
            [process.execPath, [npmBin(npmDir, 'npm-cli.js'), 'run', 'lint']],
          ]);
          assert.equal(detachedReceipt(dir).outcome, 'exit 7');
        }, { prefixScript: true });
      }, { cli: false });
    });
  });

  await t.test('npm with an npm.cmd but no npm CLI beside it is still a spawn failure', () => {
    withDir((dir) => {
      withFakeNpm((npmDir) => {
        const { spawnSync: spawn, calls } = fakeSpawn({ child: notFound });
        const r = runMain(dir, ['no npm cli', '--', 'npm', 'run', 'lint'], { spawnSync: spawn, env: envWithPath(npmDir), platform: 'win32' });
        assert.equal(r.exitCode, 127, r.stderr);
        assert.deepEqual(started(calls), [['npm', ['run', 'lint']]]);
        const receipt = detachedReceipt(dir);
        assert.equal(receipt.outcome, 'spawn failed (ENOENT)');
        assert.deepEqual(receipt.command, ['npm', 'run', 'lint']);
      }, { cli: false });
    });
  });

  await t.test('a command that cannot be started is logged as a spawn failure, never as a red run', () => {
    withDir((dir) => {
      const r = run(dir, ['typo', '--', 'definitely-not-a-command-xyz', '--flag'], { env: envWithPath(dir) });
      assert.equal(r.status, 127);
      const [line] = logLines(dir, 'detached.md');
      const failed = line.match(/\| typo \| `([^`]*)` \| spawn failed \(ENOENT\) \| .* \| head=unknown tree=unknown$/);
      assert.ok(failed, 'the receipt must retain its label, command field, and ENOENT outcome');
      assert.deepEqual(JSON.parse(failed[1]), ['definitely-not-a-command-xyz', '--flag']);
      assert.doesNotMatch(line, /exit 1/);
    });
  });

  await t.test('a start through a symlinked directory still runs and logs', {
    skip: process.platform === 'win32' && 'directory symlinks need elevated rights on Windows',
  }, () => {
    withDir((dir) => {
      const link = join(dir, 'linked-scripts');
      symlinkSync(dirname(SCRIPT), link, 'dir');
      const r = spawnSync(process.execPath, [join(link, 'run-log.mjs'), 'typo', '--', 'definitely-not-a-command-xyz'], {
        cwd: dir,
        encoding: 'utf8',
        env: envWithPath(dir),
      });
      assert.equal(r.status, 127, r.stderr);
      const lines = logLines(dir, 'detached.md');
      assert.equal(lines.length, 1);
      assert.equal(receiptFields(lines[0]).outcome, 'spawn failed (ENOENT)');
    });
  });

  await t.test('a child signal is logged and re-raised with shell status 137', { skip: NO_POSIX_SIGNALS }, () => {
    withDir((dir) => {
      const result = spawnSync('/bin/sh', [
        '-c',
        '"$1" "$2" signal -- "$1" -e \'process.kill(process.pid, "SIGKILL")\'; exit $?',
        'run-log-test',
        process.execPath,
        SCRIPT,
      ], { cwd: dir, encoding: 'utf8', env: envWithPath(dir) });
      assert.equal(result.status, 137, result.stderr);
      const [line] = logLines(dir, 'detached.md');
      assert.match(line, /\| signal \| .* \| killed by SIGKILL \| .* \| head=unknown tree=unknown$/);
    });
  });

  // The child is a shell, not Node: Node ignores its own SIGPIPE, so a Node child could never be killed by it.
  await t.test('a child SIGPIPE, which Node ignores, is logged and exits with shell status 141', { skip: NO_POSIX_SIGNALS }, () => {
    withDir((dir) => {
      const result = spawnSync('/bin/sh', [
        '-c',
        '"$1" "$2" signal -- /bin/sh -c \'kill -PIPE $$\'; exit $?',
        'run-log-test',
        process.execPath,
        SCRIPT,
      ], { cwd: dir, encoding: 'utf8', env: envWithPath(dir) });
      assert.equal(result.status, 141, result.stderr);
      const [line] = logLines(dir, 'detached.md');
      assert.match(line, /\| signal \| .* \| killed by SIGPIPE \| .* \| head=unknown tree=unknown$/);
    });
  });

  await t.test('receipt preserves exact argument boundaries and Markdown safety', () => {
    withDir((dir) => {
      const command = [
        process.execPath,
        '-e',
        'process.exit(0)',
        'one argument',
        'back`tick',
        'line\nbreak',
        'pipe|value',
        '<tag>&',
        'controls\x7f\u0085\u2028\u2029',
      ];

      const result = runMain(dir, ['receipt safety', '--', ...command]);
      assert.equal(result.exitCode, 0, result.stderr);

      const receipt = readFileSync(join(dir, '.claude', 'worklog', 'detached.md'), 'utf8').trimEnd();
      assert.equal(receipt.split('\n').length, 1, 'the receipt must remain on one Markdown line');
      assert.equal([...receipt.matchAll(/`/g)].length, 4, 'the command and reason fields must have only their delimiters');
      const field = receipt.match(/\| receipt safety \| `([^`]*)` \| exit 0 \| .* \| head=unknown tree=unknown$/);
      assert.ok(field, 'the receipt must contain one inline-code command field');
      assert.doesNotMatch(field[1], /[|<>&\u007f-\u009f\u2028\u2029]/);
      assert.deepEqual(JSON.parse(field[1]), command, 'the receipt must preserve the exact argument vector');
    });
  });

  await t.test('a receipt-write failure cannot replace the child exit result', () => {
    withDir((dir) => {
      writeFileSync(join(dir, '.claude'), 'blocks the receipt directory');
      const red = runMain(dir, ['red without receipt', '--', process.execPath, '-e', 'process.exit(3)'], {
        spawnSync: fakeSpawn({ child: () => ({ status: 3 }) }).spawnSync,
      });
      assert.equal(red.exitCode, 3, red.stderr);
      assert.match(red.stderr, /run-log: could not write receipt/);
    });
  });

  await t.test('a receipt-write failure cannot replace the child signal result', () => {
    withDir((dir) => {
      writeFileSync(join(dir, '.claude'), 'blocks the receipt directory');
      const signalled = runMain(dir, ['signal-without-receipt', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], {
        spawnSync: fakeSpawn({ child: () => ({ status: null, signal: 'SIGKILL' }) }).spawnSync,
      });
      assert.equal(signalled.signal, 'SIGKILL', signalled.stderr);
      assert.equal(signalled.exitCode, undefined);
      assert.match(signalled.stderr, /run-log: could not write receipt/);
    });
  });

  await t.test('a successful child is incomplete evidence when its receipt cannot be written', () => {
    withDir((dir) => {
      writeFileSync(join(dir, '.claude'), 'blocks the receipt directory');

      const result = runMain(dir, [
        'green without receipt',
        '--',
        process.execPath,
        '-e',
        'process.exit(0)',
      ]);

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /run-log: could not write receipt/);
      assert.equal(readFileSync(join(dir, '.claude'), 'utf8'), 'blocks the receipt directory');
    });
  });

  await t.test('a missing label or command is a usage error and writes nothing', () => {
    withDir((dir) => {
      const { spawnSync: spawn, calls } = fakeSpawn();
      for (const args of [['--', 'true'], ['label', '--'], ['label', 'true']]) {
        const r = runMain(dir, args, { spawnSync: spawn });
        assert.equal(r.exitCode, 2);
        assert.match(r.stderr, /usage: node scripts\/run-log\.mjs/);
      }
      assert.deepEqual(calls, [], 'nothing may be started, not even Git');
      assert.throws(() => logLines(dir, 'detached.md'), /ENOENT/);
    });
  });

  await t.test('a clean committed tree is recorded with its commit and tree=clean', () => {
    withRepo((repo) => {
      commit(repo);
      const r = runMain(repo, ['clean', '--', process.execPath, '-e', 'process.exit(0)'], {
        spawnSync: fakeSpawn({ git: spawnSync }).spawnSync,
      });
      assert.equal(r.exitCode, 0, r.stderr);
      const [line] = logLines(repo);
      const state = line.match(/\| exit 0 \| .* \| head=([0-9a-f]{40}) tree=clean$/);
      assert.ok(state, line);
      assert.equal(state[1], head(repo));
    });
  });

  await t.test('an untracked file makes the recorded tree dirty even when git hides untracked files', () => {
    withRepo((repo) => {
      commit(repo);
      assert.equal(spawnSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: repo }).status, 0);
      writeFileSync(join(repo, 'scratch.txt'), 'untracked');
      const r = runMain(repo, ['untracked hidden', '--', process.execPath, '-e', 'process.exit(0)'], {
        spawnSync: fakeSpawn({ git: spawnSync }).spawnSync,
      });
      assert.equal(r.exitCode, 0, r.stderr);
      const [line] = logLines(repo);
      assert.equal(receiptFields(line).outcome, 'exit 0');
      assert.ok(line.endsWith(`| head=${head(repo)} tree=dirty`), line);
    });
  });

  await t.test('an unborn HEAD is recorded as unknown and never as a clean tree', () => {
    withDir((dir) => {
      const r = runMain(dir, ['unborn', '--', process.execPath, '-e', 'process.exit(0)'], {
        spawnSync: fakeSpawn({ git: fakeGit(() => ({ head: null, status: '' })) }).spawnSync,
      });
      assert.equal(r.exitCode, 0, r.stderr);
      const [line] = logLines(dir);
      assert.equal(receiptFields(line).outcome, 'exit 0');
      assert.ok(line.endsWith('| head=unknown tree=unknown'), line);
      assert.ok(!line.includes('tree=clean'), line);
    });
  });

  await t.test('a commit and a new file made during the run are recorded as a head change and a dirty tree', () => {
    withDir((dir) => {
      const before = 'a'.repeat(40);
      const after = 'b'.repeat(40);
      let state = { head: before, status: '' };
      const { spawnSync: spawn } = fakeSpawn({
        git: fakeGit(() => state),
        child: () => {
          state = { head: after, status: '?? made.txt\n' };
          return { status: 0 };
        },
      });
      const r = runMain(dir, ['changed', '--', process.execPath, '-e', 'process.exit(0)'], { spawnSync: spawn });
      assert.equal(r.exitCode, 0, r.stderr);
      const [line] = logLines(dir);
      assert.equal(receiptFields(line).outcome, 'exit 0');
      assert.ok(line.endsWith(`| head=${before}->${after} tree=dirty`), line);
    });
  });

  await t.test('a missing git binary is recorded as unknown state without changing the exit status', () => {
    withDir((dir) => {
      const r = runMain(dir, ['no git', '--', process.execPath, '-e', 'process.exit(0)']);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.stderr, '');
      const receipt = readFileSync(join(dir, '.claude', 'worklog', 'detached.md'), 'utf8').trimEnd();
      assert.equal(receiptFields(receipt).outcome, 'exit 0');
      assert.ok(receipt.endsWith('| head=unknown tree=unknown'), receipt);
    });
  });
});
