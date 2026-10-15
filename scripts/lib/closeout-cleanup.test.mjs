// closeout-cleanup.test.mjs: the closeout cleanup command removes a job's containers, named scratch, worktree and
// branch only when every check passes, and retains each target a check or a refusal holds back, with its reason.
//
// In-process cases run `main` with a fake `run` that answers only the command's own argument vectors over small
// temporary trees; the runner proofs start real processes, and the CLI proofs run the command against real git.
//
// Recurring cost: in-process cases over small temporary trees, milliseconds each; three runner proofs and two CLI
// runs with a real git fixture, about a second. Remove with the command.

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, parse } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runCommand } from './closeout-cleanup.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { main } from '../closeout-cleanup.mjs';

const USAGE = 'usage: node scripts/closeout-cleanup.mjs <issue> [--scratch <absolute path>]... [--regenerated <worktree-relative path>]...';
const GIT = { command: 'git', env: { GIT_TERMINAL_PROMPT: '0' } };
const HEAD = '1'.repeat(40);
const reply = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

// A job worktree at <root>/wt on job/23 beside a main checkout at <root>/main, and a fake `run` answering only the
// command's argument vectors from `state`: `docker` or `lsof` set to null is not installed, and any other call is
// recorded in `unexpected` and answers status 99. The fake worktree removal deletes the directory, as git does;
// `tracked` lists each worktree's tracked paths, `lsof.open` the files processes hold and `processes` the ps rows.
function scenario(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mainDir = join(root, 'main');
  const worktree = join(root, 'wt');
  mkdirSync(mainDir);
  mkdirSync(worktree);
  const state = {
    records: [{ path: mainDir, branch: 'refs/heads/main' }, { path: worktree, branch: 'refs/heads/job/23' }],
    branch: true,
    status: '',
    docker: { containers: [], vanished: [] },
    lsof: { listeners: [], open: [] },
    tracked: {},
    processes: [{ pid: 1, ppid: 0, args: '/sbin/init splash' }],
  };
  const calls = [];
  const unexpected = [];
  const answer = (name, args, options) => {
    const key = args.join(' ');
    if (name === 'git') {
      assert.equal(options.env, GIT.env, `git ran without the seam's environment: ${key}`);
      if (key === 'worktree list --porcelain -z') return state.worktreeList ?? reply(0, worktreeListing(state.records));
      if (key === 'rev-parse --verify --quiet refs/heads/job/23') return state.branch ? reply(0, `${HEAD}\n`) : reply(1);
      if (key === `-C ${worktree} status --porcelain -z --untracked-files=normal --ignored=matching`) return reply(0, state.status);
      if (args.length === 7 && args[0] === '--literal-pathspecs' && args[1] === '-C' &&
        state.records.some(({ path }) => path === args[2]) && args.slice(3, 6).join(' ') === 'ls-files -z --') {
        const listed = (state.tracked[args[2]] ?? []).filter((path) => path === args[6] || path.startsWith(`${args[6]}/`));
        return reply(0, listed.map((path) => `${path}\0`).join(''));
      }
      if (key === `worktree remove ${worktree}`) {
        if (state.removeRefusal) return reply(128, '', state.removeRefusal);
        rmSync(worktree, { recursive: true });
        state.records = state.records.filter((record) => record.path !== worktree);
        return reply(0);
      }
      if (key === 'branch -d job/23') {
        if (state.branchRefusal) return reply(1, '', state.branchRefusal);
        state.branch = false;
        return reply(0, 'Deleted branch job/23 (was 1111111).\n');
      }
    }
    if (name === 'docker' && state.docker) return dockerAnswer(state.docker, args);
    if (name === 'docker' && key === 'container ls --all --quiet --no-trunc') return { absent: true };
    if (name === 'lsof' && state.lsof) {
      const { listeners } = state.lsof;
      if (key === '-nP -iTCP -sTCP:LISTEN -Fpc') {
        return state.lsof.l1 ?? reply(listeners.length ? 0 : 1, listeners.map(({ pid, command }) => `p${pid}\nc${command}\n`).join(''));
      }
      if (listeners.length && key === `-nP -a -p ${listeners.map(({ pid }) => pid).join(',')} -d cwd -Fpn`) {
        const rows = listeners.filter(({ cwd }) => cwd).map(({ pid, cwd }) => `p${pid}\nn${cwd}\n`).join('');
        return reply(0, rows, state.lsof.l2Stderr ?? '');
      }
      const target = lsofTarget(args);
      if (target) {
        if (state.lsof.l3) return state.lsof.l3;
        const rows = state.lsof.open.filter(({ name: open }) => open === target || open.startsWith(`${target}/`));
        const fields = rows.map(({ pid, command, name: open }) => `p${pid}\nc${command}\nf3\nn${open}\n`).join('');
        return reply(rows.length ? 0 : 1, fields, state.lsof.l3Stderr ?? '');
      }
    }
    if (name === 'lsof' && (key === '-nP -iTCP -sTCP:LISTEN -Fpc' || lsofTarget(args))) return { absent: true };
    if (name === 'ps' && key === '-ww -A -o pid= -o ppid= -o args=') {
      state.onPs?.();
      const rows = state.processes.map(({ pid, ppid, args: line }) => `${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${line}\n`);
      return state.ps ?? reply(0, rows.join(''));
    }
    return undefined;
  };
  const run = (command, args, options = {}) => {
    const name = parse(command).name;
    calls.push([name, ...args]);
    const result = answer(name, args, options);
    if (result) return result;
    unexpected.push([name, ...args]);
    return reply(99);
  };
  const cleanup = async (args = ['23'], seams = {}) => {
    const out = [];
    const err = [];
    const output = { log: (line) => out.push(line), error: (line) => err.push(line) };
    const exitCode = await main(args, {
      output, run, platform: 'linux', cwd: mainDir, home: root, pid: process.pid,
      scriptPath: join(mainDir, 'scripts', 'closeout-cleanup.mjs'), git: GIT, ...seams,
    });
    return { exitCode, out, err };
  };
  return { root, mainDir, worktree, state, calls, unexpected, cleanup };
}

// The path of an in-use lookup, `lsof -nP -Fpcfn [-x f +D] <path>`, when `-x f +D` is given exactly for a directory.
function lsofTarget(args) {
  const directory = args.length === 6 && args.slice(2, 5).join(' ') === '-x f +D';
  if (args[0] !== '-nP' || args[1] !== '-Fpcfn' || args.length !== (directory ? 6 : 3)) return null;
  const path = args.at(-1);
  return (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false) === directory ? path : null;
}

function worktreeListing(records) {
  return records.map(({ path, branch, prunable }) => [
    `worktree ${path}`, `HEAD ${HEAD}`, branch ? `branch ${branch}` : 'detached',
    ...(prunable ? ['prunable gitdir file points to non-existent location'] : []), '',
  ].join('\0') + '\0').join('');
}

// docker inspect prints one JSON line per found container and exits 1 naming each vanished one on stderr.
function dockerAnswer(docker, args) {
  const key = args.join(' ');
  const find = (id) => docker.containers.find((record) => record.Id === id);
  if (key === 'container ls --all --quiet --no-trunc') {
    return docker.ls ?? reply(0, [...docker.containers.map(({ Id }) => Id), ...docker.vanished].map((id) => `${id}\n`).join(''));
  }
  if (key.startsWith('inspect --type container --format {{json .}} ')) {
    if (docker.inspect) return docker.inspect;
    const ids = args.slice(5);
    const missing = ids.filter((id) => !find(id));
    const stdout = ids.filter(find).map((id) => `${JSON.stringify(find(id))}\n`).join('');
    return reply(missing.length ? 1 : 0, stdout, missing.map((id) => `Error response from daemon: No such container: ${id}\n`).join(''));
  }
  if ((args[0] === 'stop' || args[0] === 'rm') && args.length === 2 && find(args[1])) {
    if (docker.refuse?.[args[0]]) return reply(1, '', docker.refuse[args[0]]);
    if (args[0] === 'stop') find(args[1]).State.Running = false;
    else docker.containers = docker.containers.filter(({ Id }) => Id !== args[1]);
    return reply(0, `${args[1]}\n`);
  }
  return undefined;
}

// A container record with the keys docker inspect prints; HostConfig.Mounts is omitted when unset, as docker does.
function containerRecord(id, { running = false, mounts = [], binds = null, hostMounts } = {}) {
  return {
    Id: id, Created: '2026-10-14T10:00:00.000000000Z', Path: 'sh', Args: [],
    State: { Status: running ? 'running' : 'exited', Running: running }, Image: `sha256:${'f'.repeat(64)}`,
    Name: `/job-${id.slice(0, 4)}`, HostConfig: { Binds: binds, ...(hostMounts ? { Mounts: hostMounts } : {}) },
    Mounts: mounts, Config: { Labels: {}, WorkingDir: '' },
  };
}

const bindMount = (source) => ({ Type: 'bind', Source: source, Destination: '/work', Mode: '', RW: true, Propagation: 'rprivate' });
const SKIP_POSIX = process.platform === 'win32' && 'the command removes nothing on Windows, which has no in-use check';

test('runCommand reports a command that is not installed as absent', () => {
  assert.deepEqual(runCommand('closeout-cleanup-no-such-command', []), { absent: true });
});

test('runCommand returns the exit status, stdout and stderr of a finished command', () => {
  const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
  assert.deepEqual(runCommand(process.execPath, ['-e', script]), { status: 3, stdout: 'out', stderr: 'err' });
});

test('runCommand reports a child killed by a signal as failed', { skip: process.platform === 'win32' && 'Windows has no POSIX signals' }, () => {
  assert.deepEqual(runCommand(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"]), { failed: 'SIGKILL' });
});

test('each invalid argument exits 2 with usage and no external call', async (t) => {
  const s = scenario(t);
  const invalid = [
    [], ['0'], ['023'], ['abc'], ['23', '24'], ['23', '--force'], ['23', '--scratch'],
    ['23', '--scratch', 'relative/path'], ['23', '--scratch', '/tmp/x/'], ['23', '--scratch', '/tmp/../x'],
    ['23', '--scratch', '/tmp/a\nb'], ['23', '--regenerated', '/abs'], ['23', '--regenerated', '.'],
    ['23', '--regenerated', '..'], ['23', '--regenerated', '../x'], ['23', '--regenerated', 'a/../b'],
    ['23', '--regenerated', 'a\tb'],
  ];
  for (const args of invalid) {
    const { exitCode, out, err } = await s.cleanup(args);
    assert.equal(exitCode, 2, JSON.stringify(args));
    assert.deepEqual(out, [], JSON.stringify(args));
    assert.equal(err.at(-1), USAGE, JSON.stringify(args));
  }
  assert.deepEqual(s.calls, []);
});

test('an unreadable worktree list exits 1 having done nothing', async (t) => {
  const s = scenario(t);
  for (const [worktreeList, message] of [
    [reply(128, '', 'fatal: not a git repository\n'), 'closeout-cleanup: could not read the worktree list: fatal: not a git repository'],
    [reply(0, 'worktree relative\0\0'), 'closeout-cleanup: could not read the worktree list: an unreadable record'],
  ]) {
    s.state.worktreeList = worktreeList;
    const { exitCode, out, err } = await s.cleanup();
    assert.equal(exitCode, 1);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [message]);
  }
  assert.deepEqual(s.calls, [['git', 'worktree', 'list', '--porcelain', '-z'], ['git', 'worktree', 'list', '--porcelain', '-z']]);
  assert.deepEqual(s.unexpected, []);
});

test('nothing present exits 3', async (t) => {
  const s = scenario(t);
  s.state.records = s.state.records.slice(0, 1);
  s.state.branch = false;
  assert.deepEqual(await s.cleanup(), {
    exitCode: 3,
    out: ['absent worktree job/23', 'absent branch job/23', 'closeout-cleanup: nothing to do'],
    err: [],
  });
  assert.deepEqual(s.unexpected, []);
});

test('docker not installed skips containers and still removes the worktree and the branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker = null;
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: ['skipped containers: docker is not installed', `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.equal(existsSync(s.worktree), false);
  assert.ok(!s.calls.some((call) => call.includes('-D')));
  assert.deepEqual(s.unexpected, []);
});

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);
const dockerCalls = (s, verb) => s.calls.filter(([name, first]) => name === 'docker' && first === verb);

test('a container bound below the worktree is stopped and removed, then the worktree and the branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.containers = [
    containerRecord(ID_A, { running: true, mounts: [bindMount(join(s.worktree, 'site'))] }),
    containerRecord(ID_B, { binds: [`${s.worktree}:/work:rw`] }),
    containerRecord(ID_C, { hostMounts: [bindMount(join(s.worktree, 'data'))] }),
  ];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [
      'removed container aaaaaaaaaaaa', 'removed container bbbbbbbbbbbb', 'removed container cccccccccccc',
      `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 5 removed, 0 retained',
    ],
    err: [],
  });
  assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
  assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A], ['docker', 'rm', ID_B], ['docker', 'rm', ID_C]]);
  assert.deepEqual(s.state.docker.containers, []);
  assert.deepEqual(s.unexpected, []);
});

test('a container whose bind source is above the worktree is left', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [`removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.equal(dockerCalls(s, 'inspect').length, 1);
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
});

test('a bind source in a symlink loop retains the worktree and reports the container', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  symlinkSync('loop', join(s.root, 'loop'));
  s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(join(s.root, 'loop', 'x'))] })];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [
      'retained container aaaaaaaaaaaa: a bind source could not be resolved: ELOOP',
      `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(s.worktree));
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
});

test('a mount entry with no type retains the worktree and the branch and reports the container', { skip: SKIP_POSIX }, async (t) => {
  const untyped = [{}, { Type: '' }, { Type: 'invalid' }];
  for (const typing of untyped) {
    const s = scenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [{ ...typing, Source: join(s.worktree, 'data') }] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 4,
      out: [
        'retained container aaaaaaaaaaaa: a bind source could not be resolved: not a normalized absolute path',
        `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 3 retained',
      ],
      err: [],
    });
    assert.ok(existsSync(s.worktree));
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.unexpected, []);
  }
});

test('a recognised non-bind mount type is ignored and the worktree is removed', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const mounts = ['volume', 'tmpfs', 'npipe', 'cluster', 'image'].map((Type) => ({ Type, Source: join(s.worktree, 'data') }));
  s.state.docker.containers = [containerRecord(ID_A, { mounts })];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [`removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
});

test('an unreachable docker daemon retains the worktree and the branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const refusal = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  s.state.docker.ls = reply(1, '', `${refusal}\n`);
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [
      `retained worktree ${s.worktree}: docker failed: ${refusal}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 2 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(s.worktree));
  assert.ok(!s.calls.some(([name, ...args]) => name === 'git' && ['remove', '-d'].some((word) => args.includes(word))));
  assert.deepEqual(s.unexpected, []);
});

test('a container that vanished before inspection is read as gone', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(s.mainDir)] })];
  s.state.docker.vanished = [ID_B];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [`removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(dockerCalls(s, 'inspect'), [['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', ID_A, ID_B]]);
  assert.deepEqual(s.unexpected, []);
});

test('a "No such container" reply naming another container retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const refusal = `Error response from daemon: No such container: ${ID_B}`;
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(join(s.worktree, 'site'))] })];
  s.state.docker.refuse = { stop: `${refusal}\n` };
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [
      `retained container aaaaaaaaaaaa: docker stop failed: ${refusal}`,
      `retained worktree ${s.worktree}: container aaaaaaaaaaaa could not be removed`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(s.worktree));
  assert.deepEqual(dockerCalls(s, 'rm'), []);
  assert.deepEqual(s.unexpected, []);
});

test('a stop reply naming the container itself as no such container reports it absent and removes the worktree and branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const refusal = `Error response from daemon: No such container: ${ID_A}`;
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(join(s.worktree, 'site'))] })];
  s.state.docker.refuse = { stop: `${refusal}\n` };
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [
      'absent container aaaaaaaaaaaa', `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained',
    ],
    err: [],
  });
  assert.equal(existsSync(s.worktree), false);
  assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
  assert.deepEqual(dockerCalls(s, 'rm'), []);
  assert.deepEqual(s.unexpected, []);
});

// The worktree and its branch are both retained for the reason, nothing is removed and the directory survives.
function assertWorktreeRetained(s, result, reason) {
  assert.deepEqual(result, {
    exitCode: 4,
    out: [`retained worktree ${s.worktree}: ${reason}`, 'retained branch job/23: its worktree is retained', 'closeout-cleanup: 0 removed, 2 retained'],
    err: [],
  });
  assert.ok(existsSync(s.worktree));
  assert.deepEqual(s.unexpected, []);
}

// lsof's warnings for file systems it cannot stat, as lsof 4.99.7 prints them.
const LSOF_WARNINGS = [
  "lsof: WARNING: can't stat() nsfs file system /run/docker/netns/default",
  '      Output information may be incomplete.',
  "lsof: WARNING: can't stat() overlay file system /var/lib/docker/rootfs/overlayfs/dd64fc883c08",
  '      Output information may be incomplete.',
  '',
].join('\n');

test('a server listening from inside the worktree retains it and the branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.lsof.listeners = [
    { pid: 2927820, command: 'python3', cwd: s.mainDir },
    { pid: 2468002, command: 'node', cwd: join(s.worktree, 'site') },
  ];
  assertWorktreeRetained(s, await s.cleanup(), 'pid 2468002 (node) serves it');
});

test('a listener whose working directory cannot be read retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.lsof.listeners = [{ pid: 2927820, command: 'python3', cwd: s.mainDir }, { pid: 1, command: 'systemd' }];
  s.state.lsof.l2Stderr = LSOF_WARNINGS;
  assertWorktreeRetained(s, await s.cleanup(), 'pid 1 (systemd) listens, and its working directory could not be read');
});

test('lsof not installed retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.lsof = null;
  assertWorktreeRetained(s, await s.cleanup(), 'no in-use check: lsof is not installed');
});

test('a listener lookup that timed out retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.lsof.l1 = { failed: 'ETIMEDOUT' };
  assertWorktreeRetained(s, await s.cleanup(), 'lsof failed: ETIMEDOUT');
});

test('a modified, an untracked or an unnamed ignored entry retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const [status, listed] of [[' M tracked.txt\0', ' M tracked.txt'], ['?? new.txt\0', '?? new.txt'], ['!! node_modules/\0!! .env\0', '!! .env']]) {
    const s = scenario(t);
    s.state.status = status;
    assertWorktreeRetained(s, await s.cleanup(['23', '--regenerated', 'node_modules']), `git status lists "${listed}"`);
  }
});

test('a named regenerated directory is removed with the worktree, a named ignored file is not', { skip: SKIP_POSIX }, async (t) => {
  const directory = scenario(t);
  directory.state.status = '!! node_modules/\0';
  assert.deepEqual(await directory.cleanup(['23', '--regenerated', 'node_modules']), {
    exitCode: 0,
    out: [`removed worktree ${directory.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(directory.unexpected, []);
  const file = scenario(t);
  file.state.status = '!! .env\0';
  assertWorktreeRetained(file, await file.cleanup(['23', '--regenerated', '.env']), 'git status lists "!! .env"');
});

test('a refused worktree removal keeps the branch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.removeRefusal = `fatal: '${s.worktree}' contains modified or untracked files, use --force to delete it\n`;
  assertWorktreeRetained(s, await s.cleanup(), `fatal: '${s.worktree}' contains modified or untracked files, use --force to delete it`);
  assert.ok(!s.calls.some(([name, verb]) => name === 'git' && verb === 'branch'));
});

test('a refused branch delete is reported and never forced', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.branchRefusal = "error: the branch 'job/23' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D job/23'\n";
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [`removed worktree ${s.worktree}`, "retained branch job/23: error: the branch 'job/23' is not fully merged.", 'closeout-cleanup: 1 removed, 1 retained'],
    err: [],
  });
  assert.deepEqual(s.calls.filter(([name, verb]) => name === 'git' && verb === 'branch'), [['git', 'branch', '-d', 'job/23']]);
  assert.deepEqual(s.unexpected, []);
});

const onlyStepOne = [['git', 'worktree', 'list', '--porcelain', '-z'], ['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/job/23']];

test('a working directory inside the worktree retains it and the branch but removes its containers', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
  assert.deepEqual(await s.cleanup(['23'], { cwd: join(s.worktree, 'scripts') }), {
    exitCode: 4,
    out: [
      'removed container aaaaaaaaaaaa',
      `retained worktree ${s.worktree}: the command runs inside it`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 1 removed, 2 retained',
    ],
    err: [],
  });
  assert.deepEqual(s.state.docker.containers, []);
  assert.ok(existsSync(s.worktree));
  assert.deepEqual(s.unexpected, []);
});

test("the job worktree's own copy of the command retains everything with no docker call", { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
  const reason = "this is the job worktree's copy of the command; run the verifier checkout's copy";
  assert.deepEqual(await s.cleanup(['23'], { scriptPath: join(s.worktree, 'scripts', 'closeout-cleanup.mjs') }), {
    exitCode: 4,
    out: [`retained worktree ${s.worktree}: ${reason}`, `retained branch job/23: ${reason}`, 'closeout-cleanup: 0 removed, 2 retained'],
    err: [],
  });
  assert.deepEqual(s.calls, onlyStepOne);
});

test('the job branch checked out in the main worktree retains everything', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.records = [{ path: s.mainDir, branch: 'refs/heads/job/23' }];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [`retained branch job/23: job/23 is checked out in the main worktree ${s.mainDir}`, 'closeout-cleanup: 0 removed, 1 retained'],
    err: [],
  });
  assert.deepEqual(s.calls, onlyStepOne);
});

test('a prunable worktree record retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.records[1].prunable = true;
  rmSync(s.worktree, { recursive: true });
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [
      `retained worktree ${s.worktree}: run \`git worktree prune\`, then this command again`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 2 retained',
    ],
    err: [],
  });
  assert.deepEqual(s.unexpected, []);
});

test('on Windows every target is retained with no docker, lsof or ps call', async (t) => {
  const s = scenario(t);
  const reason = 'no in-use check on this platform';
  assert.deepEqual(await s.cleanup(['23'], { platform: 'win32' }), {
    exitCode: 4,
    out: [`retained worktree ${s.worktree}: ${reason}`, `retained branch job/23: ${reason}`, 'closeout-cleanup: 0 removed, 2 retained'],
    err: [],
  });
  assert.deepEqual(s.calls, onlyStepOne);
});

test('malformed docker inspect output retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  const malformed = (s) => [
    reply(0, 'not json\n'),
    reply(0, '[]\n'),
    reply(0, `${JSON.stringify({ Id: ID_C })}\n`),
    reply(0, ''),
    reply(1, '', `Error response from daemon: No such container: ${ID_C}\n`),
    reply(1, `${JSON.stringify(s.state.docker.containers[0])}\n`, 'Error: something else\n'),
  ];
  for (let index = 0; index < 6; index += 1) {
    const s = scenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(s.mainDir)] })];
    s.state.docker.inspect = malformed(s)[index];
    const { exitCode, out } = await s.cleanup();
    assert.equal(exitCode, 4, `case ${index}`);
    assert.match(out[0], new RegExp(`^retained worktree ${s.worktree}: docker failed: `), `case ${index}`);
    assert.deepEqual(out.slice(1), ['retained branch job/23: its worktree is retained', 'closeout-cleanup: 0 removed, 2 retained']);
    assert.ok(existsSync(s.worktree), `case ${index}`);
    assert.deepEqual(s.unexpected, []);
  }
});

// A file at the path, its directories made.
function placeFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'scratch\n');
  return path;
}

const jobRemoved = (s) => [`removed worktree ${s.worktree}`, 'removed branch job/23'];

// The one scratch target is retained for the reason and survives, while the worktree and the branch are removed.
function assertScratchRetained(s, result, target, reason) {
  assert.deepEqual(result, {
    exitCode: 4,
    out: [`retained scratch ${target}: ${reason}`, ...jobRemoved(s), 'closeout-cleanup: 2 removed, 1 retained'],
    err: [],
  });
  assert.ok(existsSync(target));
  assert.deepEqual(s.unexpected, []);
}

test('an absent scratch target is reported absent', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = join(s.root, 'scratch', 'gone.md');
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 0,
    out: [`absent scratch ${target}`, ...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(s.unexpected, []);
});

test('a scratch file, directory and symlink are removed and the symlink target survives', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const file = placeFile(join(s.root, 'scratch', 'notes.md'));
  const directory = dirname(placeFile(join(s.root, 'scratch', 'report', 'page.md')));
  const kept = dirname(placeFile(join(s.root, 'kept', 'data.txt')));
  const link = join(s.root, 'scratch', 'link');
  symlinkSync(kept, link);
  assert.deepEqual(await s.cleanup(['23', '--scratch', file, '--scratch', directory, '--scratch', link]), {
    exitCode: 0,
    out: [
      `removed scratch ${file}`, `removed scratch ${directory}`, `removed scratch ${link}`, ...jobRemoved(s),
      'closeout-cleanup: 5 removed, 0 retained',
    ],
    err: [],
  });
  assert.deepEqual([file, directory, link].map((path) => lstatSync(path, { throwIfNoEntry: false })), [undefined, undefined, undefined]);
  assert.ok(existsSync(join(kept, 'data.txt')));
  assert.deepEqual(s.unexpected, []);
});

test('a scratch target below a symlink loop is retained', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  symlinkSync('loop', join(s.root, 'loop'));
  const target = join(s.root, 'loop', 'notes.md');
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 4,
    out: [`retained scratch ${target}: could not be read: ELOOP`, ...jobRemoved(s), 'closeout-cleanup: 2 removed, 1 retained'],
    err: [],
  });
  assert.deepEqual(s.unexpected, []);
});

test('a scratch target at or above the home or the working directory is retained', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const home = join(s.root, 'home');
  const work = join(s.root, 'scratch', 'work');
  mkdirSync(home);
  mkdirSync(join(work, 'sub'), { recursive: true });
  assert.deepEqual(await s.cleanup(['23', '--scratch', home, '--scratch', work], { home, cwd: join(work, 'sub') }), {
    exitCode: 4,
    out: [
      `retained scratch ${home}: holds the home directory`, `retained scratch ${work}: holds the working directory`,
      ...jobRemoved(s), 'closeout-cleanup: 2 removed, 2 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(home) && existsSync(work));
  assert.deepEqual(s.unexpected, []);
});

test('a scratch target holding a registered worktree is retained', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const other = join(s.root, 'other');
  mkdirSync(join(other, 'wt2'), { recursive: true });
  s.state.records.push({ path: join(other, 'wt2'), branch: 'refs/heads/job/24' });
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', other]), other, `holds the registered worktree ${join(other, 'wt2')}`);
});

test('a scratch target holding a tracked file is retained', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.mainDir, 'build', 'out.txt'));
  s.state.tracked[s.mainDir] = ['build/out.txt'];
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'holds tracked files');
  assert.deepEqual(
    s.calls.filter(([name, first]) => name === 'git' && first === '--literal-pathspecs'),
    [['git', '--literal-pathspecs', '-C', s.mainDir, 'ls-files', '-z', '--', 'build/out.txt']],
  );
});

test('outside scratch is retained by a container bound at, below or above it, or naming it in a label or working directory', { skip: SKIP_POSIX }, async (t) => {
  const cases = [
    [(target) => containerRecord(ID_A, { mounts: [bindMount(target)] }), 'binds it'],
    [(target) => containerRecord(ID_A, { binds: [`${join(target, 'site')}:/site:ro`] }), 'binds it'],
    [(target) => containerRecord(ID_A, { hostMounts: [bindMount(dirname(target))] }), 'binds it'],
    [(target) => ({ ...containerRecord(ID_A), Config: { Labels: { 'proof.output': target }, WorkingDir: '' } }), 'names it'],
    [(target) => ({ ...containerRecord(ID_A), Config: { Labels: {}, WorkingDir: `${target}/run` } }), 'names it'],
  ];
  for (const [record, reason] of cases) {
    const s = scenario(t);
    const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
    s.state.docker.containers = [record(target)];
    assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `container aaaaaaaaaaaa ${reason}`);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  }
});

test('a container bound above the worktree does not retain inside scratch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.worktree, '_site', 'page.md')));
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })];
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 0,
    out: [`removed scratch ${target}`, ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
});

test('inside scratch is retained when a container bound in the worktree could not be removed', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.worktree, '_site', 'page.md')));
  const refusal = 'Error response from daemon: removal of container aaaaaaaaaaaa is already in progress';
  s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(join(s.worktree, 'data'))] })];
  s.state.docker.refuse = { rm: refusal };
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 4,
    out: [
      `retained container aaaaaaaaaaaa: docker rm failed: ${refusal}`,
      `retained scratch ${target}: a container bound in the job worktree was not removed`,
      `retained worktree ${s.worktree}: container aaaaaaaaaaaa could not be removed`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 4 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(target));
  assert.deepEqual(s.unexpected, []);
});

test('a process holding a file in the scratch target retains it', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  s.state.lsof.open = [{ pid: 31337, command: 'tail', name: join(target, 'log.txt') }];
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'pid 31337 (tail) uses it');
});

test('an lsof row whose name lsof escaped still retains the scratch target', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'résumé', 'report.log')));
  // lsof prints a name's non-ASCII bytes as \xNN escapes, so the name it prints differs from the path it matched.
  s.state.lsof.l3 = reply(0, `p4242\ncless\nf3\nn${s.root}/r\\xc3\\xa9sum\\xc3\\xa9/report.log\n`);
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'pid 4242 (less) uses it');
});

test('an lsof warning on the mount holding the scratch target retains it', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  const mount = join(s.root, 'scratch');
  s.state.lsof.l3Stderr = `lsof: WARNING: can't stat() overlay file system ${mount}\n      Output information may be incomplete.\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lookup incomplete: lsof could not stat the file system at ${mount}`);
});

test('an lsof warning on a mount below the scratch directory retains it', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  const mount = join(target, 'cache');
  mkdirSync(mount);
  s.state.lsof.l3Stderr = `lsof: WARNING: can't stat() fuse.sshfs file system ${mount}\n      Output information may be incomplete.\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lookup incomplete: lsof could not stat the file system at ${mount}`);
});

test('an lsof warning on an unrelated mount is ignored and the scratch target removed', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  s.state.lsof.l3Stderr = LSOF_WARNINGS;
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 0,
    out: [`removed scratch ${target}`, ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.equal(existsSync(target), false);
  assert.deepEqual(s.unexpected, []);
});

test('unrecognised lsof stderr retains the scratch target', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.lsof.l3Stderr = `lsof: status error on ${target}: Permission denied\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lsof reported: lsof: status error on ${target}: Permission denied`);
});

test('an lsof field the command did not ask for retains the scratch target', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.lsof.l3 = reply(0, `p4242\ncvim\nf3\ntREG\nn${target}\n`);
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'lsof printed a field it was not asked for');
});

test('a process outside the ancestor chain naming the scratch target retains it, an ancestor does not', { skip: SKIP_POSIX }, async (t) => {
  const ancestors = (target) => [
    { pid: 1, ppid: 0, args: '/sbin/init splash' },
    { pid: 4100, ppid: 1, args: `bash -c node scripts/closeout-cleanup.mjs 23 --scratch ${target}` },
    { pid: 4242, ppid: 4100, args: `node scripts/closeout-cleanup.mjs 23 --scratch ${target}` },
  ];
  const named = scenario(t);
  const target = placeFile(join(named.root, 'scratch', 'notes.md'));
  named.state.processes = [...ancestors(target), { pid: 5150, ppid: 1, args: `less ${target}` }];
  assertScratchRetained(named, await named.cleanup(['23', '--scratch', target], { pid: 4242 }), target, 'pid 5150 names it in its arguments');
  const own = scenario(t);
  const ownTarget = placeFile(join(own.root, 'scratch', 'notes.md'));
  own.state.processes = ancestors(ownTarget);
  assert.deepEqual(await own.cleanup(['23', '--scratch', ownTarget], { pid: 4242 }), {
    exitCode: 0,
    out: [`removed scratch ${ownTarget}`, ...jobRemoved(own), 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(own.unexpected, []);
});

test('a ps run exiting non-zero with empty output retains the scratch target', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.ps = reply(1);
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'ps failed: exit status 1');
});

test('a scratch target replaced during the checks is retained', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.onPs = () => renameSync(placeFile(join(s.root, 'scratch', 'replacement.md')), target);
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'it changed during the checks');
});

test('a retained scratch file inside the worktree retains the worktree and its branch with no status read, removal or branch delete', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.worktree, '_site', 'proof.log'));
  s.state.status = '!! _site/\0';
  s.state.lsof.open = [{ pid: 31337, command: 'tail', name: target }];
  assert.deepEqual(await s.cleanup(['23', '--scratch', target, '--regenerated', '_site']), {
    exitCode: 4,
    out: [
      `retained scratch ${target}: pid 31337 (tail) uses it`,
      `retained worktree ${s.worktree}: holds retained scratch ${target}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(target));
  assert.deepEqual(s.calls.filter(([name, ...args]) => name === 'git' && ['status', 'remove', 'branch'].some((word) => args.includes(word))), []);
  assert.deepEqual(s.unexpected, []);
});

const CHECK_USAGE = 'usage: node scripts/closeout-cleanup.mjs --check <absolute path> [--check <absolute path>]...';
const SUMMARY = (unused, absent, inUse, unverifiable) =>
  `closeout-cleanup: ${unused} unused, ${absent} absent, ${inUse} in use, ${unverifiable} unverifiable`;

// A check run reads docker, lsof and ps alone: no git call, no container stopped or removed, no undeclared call.
function assertNothingChanged(s) {
  assert.deepEqual(s.calls.filter(([name]) => name === 'git'), []);
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
}

test('each invalid --check argument exits 2 with the check usage and no external call', async (t) => {
  const s = scenario(t);
  const invalid = [
    ['--check'], ['--check', 'relative/path'], ['--check', '/tmp/x/'], ['--check', '/tmp/../x'], ['--check', '/tmp/a\nb'],
    ['23', '--check', '/tmp'], ['--check', '/tmp', '23'], ['--check', '/tmp', '--scratch', '/tmp/x'],
    ['--check', '/tmp', '--regenerated', 'x'],
  ];
  for (const args of invalid) {
    const { exitCode, out, err } = await s.cleanup(args);
    assert.equal(exitCode, 2, JSON.stringify(args));
    assert.deepEqual(out, [], JSON.stringify(args));
    assert.equal(err.at(-1), CHECK_USAGE, JSON.stringify(args));
  }
  assert.deepEqual(s.calls, []);
});

test('a checked path nothing uses is reported unused and left in place', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  assert.deepEqual(await s.cleanup(['--check', target]), { exitCode: 0, out: [`unused path ${target}`, SUMMARY(1, 0, 0, 0)], err: [] });
  assert.ok(existsSync(target));
  assertNothingChanged(s);
});

test('a checked path an lsof row holds is reported in use', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.lsof.open = [{ pid: 31337, command: 'tail', name: target }];
  assert.deepEqual(await s.cleanup(['--check', target]), {
    exitCode: 4,
    out: [`in use path ${target}: pid 31337 (tail) uses it`, SUMMARY(0, 0, 1, 0)],
    err: [],
  });
  assert.ok(existsSync(target));
  assertNothingChanged(s);
});

test('a checked path under a bind source of a container is reported in use', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })];
  assert.deepEqual(await s.cleanup(['--check', target]), {
    exitCode: 4,
    out: [`in use path ${target}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)],
    err: [],
  });
  assert.ok(existsSync(target));
  assertNothingChanged(s);
});

test('a checked path is unverifiable, never unused, when lsof is not installed', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.lsof = null;
  assert.deepEqual(await s.cleanup(['--check', target]), {
    exitCode: 4,
    out: [`unverifiable path ${target}: no in-use check: lsof is not installed`, SUMMARY(0, 0, 0, 1)],
    err: [],
  });
  assert.ok(existsSync(target));
  assertNothingChanged(s);
});

test('on Windows a checked path is unverifiable with no docker, lsof or ps call', async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  assert.deepEqual(await s.cleanup(['--check', target], { platform: 'win32' }), {
    exitCode: 4,
    out: [`unverifiable path ${target}: no in-use check on this platform`, SUMMARY(0, 0, 0, 1)],
    err: [],
  });
  assert.ok(existsSync(target));
  assert.deepEqual(s.calls, []);
});

test('an absent checked path is reported absent with no external call', async (t) => {
  const s = scenario(t);
  const target = join(s.root, 'scratch', 'gone.md');
  assert.deepEqual(await s.cleanup(['--check', target]), { exitCode: 0, out: [`absent path ${target}`, SUMMARY(0, 1, 0, 0)], err: [] });
  assert.deepEqual(s.calls, []);
});

test('a check of several paths reports each on its own line and exits 4 when one is in use', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const free = placeFile(join(s.root, 'scratch', 'free.md'));
  const gone = join(s.root, 'scratch', 'gone.md');
  const busy = placeFile(join(s.root, 'scratch', 'busy.md'));
  s.state.lsof.open = [{ pid: 31337, command: 'tail', name: busy }];
  assert.deepEqual(await s.cleanup(['--check', free, '--check', gone, '--check', busy, '--check', free]), {
    exitCode: 4,
    out: [`unused path ${free}`, `absent path ${gone}`, `in use path ${busy}: pid 31337 (tail) uses it`, SUMMARY(1, 1, 1, 0)],
    err: [],
  });
  assert.ok(existsSync(free) && existsSync(busy));
  assertNothingChanged(s);
});

const CLI = fileURLToPath(new URL('../closeout-cleanup.mjs', import.meta.url));
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const DOCKER_EMPTY = '[ "$*" = "container ls --all --quiet --no-trunc" ] && exit 0\necho "unexpected docker call: $*" >&2\nexit 99\n';
const DOCKER_DOWN = `echo '${DAEMON_DOWN}' >&2\nexit 1\n`;
// lsof prints nothing and exits 1 when nothing matches; any other call prints a line the command retains on.
const LSOF_FAKE = 'case "$*" in\n  "-nP -iTCP -sTCP:LISTEN -Fpc"|"-nP -Fpcfn /"*) exit 1 ;;\nesac\necho "unexpected lsof call: $*" >&2\nexit 1\n';
const PS_FAKE = '[ "$*" = "-ww -A -o pid= -o ppid= -o args=" ] || exit 99\necho \'      1       0 /sbin/init splash\'\n';

// A real repository with job/23 checked out in a linked worktree that holds an ignored node_modules, an outside
// scratch file, sh fakes for docker, lsof and ps first on PATH, and GIT_DIR naming a decoy repository the command's
// git calls must not read.
function cliFixture(t, docker) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  const worktree = join(root, 'job-23');
  const env = {
    ...gitEnvironment(),
    GIT_AUTHOR_NAME: 'Closeout Cleanup Test',
    GIT_AUTHOR_EMAIL: 'closeout-cleanup-test@workflow.invalid',
    GIT_COMMITTER_NAME: 'Closeout Cleanup Test',
    GIT_COMMITTER_EMAIL: 'closeout-cleanup-test@workflow.invalid',
    // Hostile ambient signing config keeps the command-local `commit.gpgsign=false` override load-bearing.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gpg.format',
    GIT_CONFIG_VALUE_1: 'openpgp',
    GIT_CONFIG_KEY_2: 'user.signingKey',
    GIT_CONFIG_VALUE_2: 'closeout-cleanup-test-missing-key',
  };
  const git = (args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  const ok = (result, what) => assert.equal(result.status, 0, `${what} failed: ${result.stderr}`);
  ok(git(['init', '-q', repository]), 'git init');
  ok(git(['-C', repository, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture baseline']), 'baseline commit');
  ok(git(['-C', repository, 'worktree', 'add', '-q', '-b', 'job/23', worktree]), 'job worktree');
  mkdirSync(join(repository, '.git', 'info'), { recursive: true });
  writeFileSync(join(repository, '.git', 'info', 'exclude'), 'node_modules/\n');
  placeFile(join(worktree, 'node_modules', 'left-pad', 'index.js'));
  ok(git(['init', '-q', join(root, 'decoy')]), 'decoy git init');
  const scratch = placeFile(join(root, 'scratch', 'notes.md'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['docker', docker], ['lsof', LSOF_FAKE], ['ps', PS_FAKE]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  }
  const cleanup = () => spawnSync(process.execPath, [CLI, '23', '--scratch', scratch, '--regenerated', 'node_modules'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, GIT_DIR: join(root, 'decoy', '.git') },
  });
  const branchStatus = () => git(['-C', repository, 'rev-parse', '--verify', '--quiet', 'refs/heads/job/23']).status;
  return { worktree, scratch, cleanup, branchStatus };
}

test('the CLI removes an outside scratch file, the worktree with its regenerated directory and the branch through real git', { skip: SKIP_POSIX }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const run = f.cleanup();
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `removed scratch ${f.scratch}`, `removed worktree ${f.worktree}`, 'removed branch job/23',
    'closeout-cleanup: 3 removed, 0 retained', '',
  ].join('\n'));
  assert.equal(run.status, 0);
  assert.equal(existsSync(f.scratch), false);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.branchStatus(), 1);
});

test('the CLI retains every target when the docker daemon is unreachable', { skip: SKIP_POSIX }, (t) => {
  const f = cliFixture(t, DOCKER_DOWN);
  const run = f.cleanup();
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `retained scratch ${f.scratch}: docker failed: ${DAEMON_DOWN}`,
    `retained worktree ${f.worktree}: docker failed: ${DAEMON_DOWN}`,
    'retained branch job/23: its worktree is retained',
    'closeout-cleanup: 0 removed, 3 retained', '',
  ].join('\n'));
  assert.equal(run.status, 4);
  assert.ok(existsSync(f.scratch));
  assert.ok(existsSync(join(f.worktree, 'node_modules', 'left-pad', 'index.js')));
  assert.equal(f.branchStatus(), 0);
});
