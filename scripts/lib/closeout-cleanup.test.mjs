// closeout-cleanup.test.mjs: the closeout cleanup command removes a job's containers, named scratch, worktree and
// branch only when every check passes, and retains each target a check or a refusal holds back, with its reason.
//
// In-process cases run `main` with a fake `run` that answers only the command's own argument vectors over small
// temporary trees; the runner proofs start real processes, and the CLI proofs run the command against real git.
//
// Recurring cost: small in-process native-observation cases, representative real-Git CLI fixtures and one live
// Unix listener. No daemon, image or network service is started. Remove with the cleanup boundary.

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
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

const PROOF_HOST = 'unix:///tmp/proof.sock';
const PROOF_SS = 'u_str LISTEN 0 4096 /tmp/proof.sock 700 * 0 users:(("dockerd",pid=71,fd=3)) <-> ino:90 dev:0/5 peers:\n';
const PROOF_STAT = [
  '100:90:0:5:socket', '10:700:0:10:socket',
  '40:1000:0:40:regular empty file', '40:1000:0:40:regular empty file',
  '50:2:0:50:directory', '50:2:0:50:directory',
  '60:80:0:60:regular file', '60:80:0:60:regular file', '',
].join('\n');
const PROOF_VECTORS = {
  readlink: ['-e', '--', '/tmp/proof.sock'],
  sh: ['-c', 'command -v dockerd'],
  ss: ['-H', '-xlnpe', 'src', '/tmp/proof.sock'],
  stat: ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--', '/tmp/proof.sock', '/proc/71/fd/3',
    '/proc/self/ns/mnt', '/proc/71/ns/mnt', '/', '/proc/71/root', '/usr/bin/dockerd', '/proc/71/exe'],
};
const PROOF_REPLIES = {
  readlink: reply(0, '/tmp/proof.sock\n'), sh: reply(0, '/usr/bin/dockerd\n'),
  ss: reply(0, PROOF_SS), stat: reply(0, PROOF_STAT),
};

// Hand-worked procfs tuples: both owners share socket 700, namespace 1000 and root 2;
// systemd's executable inode 81 is distinct from dockerd's inode 80.
const SYSTEMD_STAT = [
  '100:90:0:5:socket', '10:700:0:10:socket',
  '40:1000:0:40:regular empty file', '40:1000:0:40:regular empty file',
  '50:2:0:50:directory', '50:2:0:50:directory',
  '60:81:0:60:regular file', '60:81:0:60:regular file', '',
].join('\n');
const CALLER_STAT = '100:90:0:5:socket\n40:1000:0:40:regular empty file\n50:2:0:50:directory\n60:80:0:60:regular file\n';
const SYSTEMD_CALLER_STAT = '100:90:0:5:socket\n40:1000:0:40:regular empty file\n50:2:0:50:directory\n60:81:0:60:regular file\n';
const DAEMON_PROC_STAT = '10:700:0:10:socket\n40:1000:0:40:regular empty file\n50:2:0:50:directory\n60:80:0:60:regular file\n';
const SYSTEMD_PROC_STAT = '10:700:0:10:socket\n40:1000:0:40:regular empty file\n50:2:0:50:directory\n60:81:0:60:regular file\n';
const ACTIVATED_SS = PROOF_SS.replace('fd=3))', 'fd=3),("systemd",pid=1,fd=9))');
const OWNERLESS_SS = PROOF_SS.replace('users:(("dockerd",pid=71,fd=3)) ', '');
const SYSTEMD_VECTOR = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--', '/tmp/proof.sock', '/proc/1/fd/9',
  '/proc/self/ns/mnt', '/proc/1/ns/mnt', '/', '/proc/1/root', '/usr/lib/systemd/systemd', '/proc/1/exe'];
const CALLER_VECTOR = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--', '/tmp/proof.sock', '/proc/self/ns/mnt', '/', '/usr/bin/dockerd'];
const SYSTEMD_CALLER_VECTOR = [...CALLER_VECTOR.slice(0, -1), '/usr/lib/systemd/systemd'];
const DAEMON_PROC_VECTOR = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--', '/proc/71/fd/3', '/proc/71/ns/mnt', '/proc/71/root', '/proc/71/exe'];
const SYSTEMD_PROC_VECTOR = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--', '/proc/1/fd/9', '/proc/1/ns/mnt', '/proc/1/root', '/proc/1/exe'];
const SUDO_PREFIX = ['-kn', '-u', 'root', '-g', 'root', '--'];

// Fake Docker selection is synchronous and cannot inherit or permanently alter the caller's selection.
function withoutDockerSelection(invoke) {
  const names = ['DOCKER_HOST', 'DOCKER_CONTEXT'];
  const original = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    return invoke();
  } finally {
    for (const [index, name] of names.entries()) {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    }
  }
}

// A job worktree at <root>/wt on job/23 beside a main checkout at <root>/main, and a fake `run` answering only the
// command's argument vectors from `state`: `docker` or `lsof` set to null is not installed, and any other call is
// recorded in `unexpected` and answers status 99. The fake worktree removal deletes the directory, as git does;
// `tracked` lists each worktree's tracked paths, `lsof.open` the files processes hold and `processes` the ps rows.
function scenario(t) {
  const capturedPath = { ...process.env }.PATH;
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
    index: reply(0, 'H kept.txt\0'),
    docker: { containers: [], vanished: [] },
    native: {},
    lsof: { listeners: [], open: [] },
    tracked: {},
    processes: [{ pid: 1, ppid: 0, args: '/sbin/init splash' }],
  };
  const calls = [];
  const executions = [];
  const unexpected = [];
  const answer = (name, args, options) => {
    const key = args.join(' ');
    if (name === 'git') {
      assert.equal(options.env, GIT.env, `git ran without the seam's environment: ${key}`);
      if (key === 'worktree list --porcelain -z') return state.worktreeList ?? reply(0, worktreeListing(state.records));
      if (key === 'rev-parse --verify --quiet refs/heads/job/23') return state.branch ? reply(0, `${HEAD}\n`) : reply(1);
      if (key === `-C ${worktree} status --porcelain -z --untracked-files=normal --ignored=matching`) {
        state.onStatus?.();
        return reply(0, state.status);
      }
      if (key === `-C ${worktree} ls-files -v -z`) {
        assert.deepEqual(args, ['-C', worktree, 'ls-files', '-v', '-z']);
        return state.index;
      }
      if (args.length === 7 && args[0] === '--literal-pathspecs' && args[1] === '-C' &&
        state.records.some(({ path }) => path === args[2]) && args.slice(3, 6).join(' ') === 'ls-files -z --') {
        const listed = (state.tracked[args[2]] ?? []).filter((path) => path === args[6] || path.startsWith(`${args[6]}/`));
        return reply(0, listed.map((path) => `${path}\0`).join(''));
      }
      if (key === `worktree remove ${worktree}`) {
        if (state.removeRefusal) return reply(128, '', state.removeRefusal);
        rmSync(worktree, { recursive: true });
        state.records = state.records.filter((record) => record.path !== worktree);
        state.onWorktreeRemoved?.();
        return reply(0);
      }
      if (key === 'branch -d job/23') {
        if (state.branchRefusal) return reply(1, '', state.branchRefusal);
        state.branch = false;
        return reply(0, 'Deleted branch job/23 (was 1111111).\n');
      }
    }
    if (name === 'docker') {
      assert.equal(options.env.DOCKER_HOST, undefined);
      assert.equal(options.env.DOCKER_CONTEXT, undefined);
      if (key === 'context inspect --format {{json .Endpoints.docker}}') {
        if (!state.docker) return { absent: true };
        return typeof state.metadata === 'function' ? state.metadata() : state.metadata ?? reply(0, JSON.stringify({ Host: PROOF_HOST }));
      }
      assert.deepEqual(args.slice(0, 2), ['--host', PROOF_HOST]);
      const result = dockerAnswer(state.docker, args.slice(2));
      state.onDocker?.(args.slice(2));
      return result;
    }
    if (name === 'sudo' || name in PROOF_VECTORS) {
      assert.deepEqual(options.env, { ...(capturedPath === undefined ? {} : { PATH: capturedPath }), LC_ALL: 'C' });
      if (name === 'sudo') {
        assert.deepEqual(args.slice(0, 6), SUDO_PREFIX);
        const binary = args[6];
        assert.ok(['/usr/bin/ss', '/usr/bin/stat'].includes(binary));
        const operands = args.slice(7);
        if (binary === '/usr/bin/ss') assert.deepEqual(operands, PROOF_VECTORS.ss);
        else assert.ok([DAEMON_PROC_VECTOR, SYSTEMD_PROC_VECTOR, SYSTEMD_PROC_VECTOR.with(4, '/proc/1/fd/10')].some((vector) => JSON.stringify(vector) === JSON.stringify(operands)));
        const result = state.privileged?.[binary === '/usr/bin/ss' ? 'ss' : 'stat'] ?? { absent: true };
        return typeof result === 'function' ? result(operands) : result;
      }
      let fallback = PROOF_REPLIES[name];
      if (name === 'stat') {
        const vectors = [[PROOF_VECTORS.stat, PROOF_STAT], [SYSTEMD_VECTOR, SYSTEMD_STAT],
          [CALLER_VECTOR, CALLER_STAT], [SYSTEMD_CALLER_VECTOR, SYSTEMD_CALLER_STAT]];
        const vector = vectors.find(([expected]) => JSON.stringify(expected) === JSON.stringify(args));
        assert.ok(vector, `unexpected native stat: ${args.join(' ')}`);
        fallback = reply(0, vector[1]);
      } else assert.deepEqual(args, PROOF_VECTORS[name]);
      const result = state.native[name] ?? fallback;
      return typeof result === 'function' ? result(args) : result;
    }
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
        const raw = !state.lsof.l3Target || state.lsof.l3Target === target;
        if (raw && state.lsof.l3) return state.lsof.l3;
        const rows = state.lsof.open.filter(({ name: open }) => open === target || open.startsWith(`${target}/`));
        const fields = rows.map(({ pid, command, name: open }) => `p${pid}\nc${command}\nf3\nn${open}\n`).join('');
        return reply(rows.length ? 0 : 1, fields, raw ? state.lsof.l3Stderr ?? '' : '');
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
    executions.push({ command, args, env: options.env });
    const result = answer(name, args, options);
    if (result) return result;
    unexpected.push([name, ...args]);
    return reply(99);
  };
  const cleanup = async (args = ['23'], seams = {}) => {
    const out = [];
    const err = [];
    const output = { log: (line) => out.push(line), error: (line) => err.push(line) };
    const exitCode = withoutDockerSelection(() => main(args, {
      output, run, platform: 'linux', cwd: mainDir, home: root, pid: process.pid,
      scriptPath: join(mainDir, 'scripts', 'closeout-cleanup.mjs'), git: GIT, ...seams,
    }));
    return { exitCode, out, err };
  };
  return { root, mainDir, worktree, state, calls, executions, unexpected, cleanup };
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
  for (const [name, stdout] of [
    ['empty index', ''],
    ['ordinary filenames with spaces and newlines', 'H kept.txt\0H spaced name.txt\0H line\nbreak.txt\0'],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.docker = null;
      s.state.index = reply(0, stdout);
      assert.deepEqual(await s.cleanup(), {
        exitCode: 0,
        out: ['skipped containers: docker is not installed', `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
        err: [],
      });
      assert.equal(existsSync(s.worktree), false);
      assert.ok(!s.calls.some((call) => call.includes('-D')));
      assert.deepEqual(s.unexpected, []);
    });
  }
});

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);
const dockerCalls = (s, verb) => s.calls
  .filter(([name, flag, host, first]) => name === 'docker' && flag === '--host' && host === PROOF_HOST && first === verb)
  .map(([name, , , ...args]) => [name, ...args]);

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

function assertWorktreeNotRemoved(s) {
  assert.equal(s.state.branch, true);
  assert.deepEqual(s.calls.filter(([name, ...args]) => name === 'git' &&
    (args[0] === 'branch' || args[0] === 'worktree' && args[1] === 'remove')), []);
}

// lsof's warnings for file systems it cannot stat, as lsof 4.99.7 prints them.
const LSOF_WARNINGS = [
  "lsof: WARNING: can't stat() nsfs file system /run/docker/netns/default",
  '      Output information may be incomplete.',
  "lsof: WARNING: can't stat() overlay file system /var/lib/docker/rootfs/overlayfs/dd64fc883c08",
  '      Output information may be incomplete.',
  '',
].join('\n');

test('a non-listening process using the worktree retains it and the branch', { skip: SKIP_POSIX }, async (t) => {
  for (const use of ['open file', 'working directory', 'arguments']) {
    const s = scenario(t);
    let reason;
    if (use === 'open file') {
      const path = placeFile(join(s.worktree, 'logs', 'output.log'));
      s.state.lsof.open = [{ pid: 31337, command: 'tail', name: path }];
      reason = 'pid 31337 (tail) uses it';
    } else if (use === 'working directory') {
      s.state.lsof.l3 = reply(0, `p4242\ncbash\nfcwd\nn${s.worktree}\n`);
      reason = 'pid 4242 (bash) uses it';
    } else {
      s.state.processes.push({ pid: 5150, ppid: 1, args: `node ${s.worktree}/worker.js --secret=private` });
      reason = 'pid 5150 names it in its arguments';
    }
    assertWorktreeRetained(s, await s.cleanup(['23'], { pid: 4242 }), reason);
    assertWorktreeNotRemoved(s);
  }
});

test('unavailable worktree use observations retain it and the branch', { skip: SKIP_POSIX }, async (t) => {
  for (const observation of ['directory lookup timeout', 'absent ps']) {
    const s = scenario(t);
    let reason;
    if (observation === 'directory lookup timeout') {
      s.state.lsof.l3Target = s.worktree;
      s.state.lsof.l3 = { failed: 'ETIMEDOUT' };
      reason = 'lsof failed: ETIMEDOUT';
    } else {
      s.state.ps = { absent: true };
      reason = 'no process check: ps is not installed';
    }
    assertWorktreeRetained(s, await s.cleanup(), reason);
    assertWorktreeNotRemoved(s);
  }
});

test('malformed worktree use observations retain it and the branch', { skip: SKIP_POSIX }, async (t) => {
  for (const observation of ['unexpected lsof field', 'unreadable ps row']) {
    const s = scenario(t);
    let reason;
    if (observation === 'unexpected lsof field') {
      s.state.lsof.l3Target = s.worktree;
      s.state.lsof.l3 = reply(0, `p4242\ncvim\nf3\ntREG\nn${s.worktree}/notes.md\n`);
      reason = 'lsof printed a field it was not asked for';
    } else {
      s.state.ps = reply(0, 'unreadable process row --secret=private\n');
      reason = 'ps printed a row that could not be read';
    }
    assertWorktreeRetained(s, await s.cleanup(), reason);
    assertWorktreeNotRemoved(s);
  }
});

test('only the cleanup process and its ancestors naming the worktree allow cleanup', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.processes = [
    { pid: 1, ppid: 0, args: '/sbin/init splash' },
    { pid: 4100, ppid: 1, args: `bash -c node ${s.worktree}/scripts/closeout-cleanup.mjs 23` },
    { pid: 4242, ppid: 4100, args: `node ${s.worktree}/scripts/closeout-cleanup.mjs 23` },
  ];
  assert.deepEqual(await s.cleanup(['23'], { pid: 4242 }), {
    exitCode: 0,
    out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.equal(existsSync(s.worktree), false);
  assert.equal(s.state.branch, false);
  assert.deepEqual(s.unexpected, []);
});

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

test('ANTI-REGRESSION: unsafe index observations retain the worktree and branch', { skip: SKIP_POSIX }, async (t) => {
  const rejected = 'git index flags are hidden or unreadable; inspect git ls-files -v, resolve index flags and review local changes before retrying';
  for (const [name, index, reason] of [
    ['absent executable', { absent: true }, 'could not read git index flags: not installed'],
    ['timeout', { failed: 'ETIMEDOUT' }, 'could not read git index flags: failed: ETIMEDOUT'],
    ['nonzero exit', reply(128, '', 'fatal: index unavailable\n'), 'could not read git index flags: fatal: index unavailable'],
    ['successful stderr', reply(0, 'H kept.txt\0', 'warning: incomplete index\n'), rejected],
    ['missing terminal NUL', reply(0, 'H kept.txt'), rejected],
    ['empty filename', reply(0, 'H \0'), rejected],
    ['interior empty record', reply(0, 'H kept.txt\0\0H other.txt\0'), rejected],
    ['unknown tag', reply(0, 'X kept.txt\0'), rejected],
    ['ordinary record followed by hidden record', reply(0, 'H kept.txt\0S hidden.txt\0'), rejected],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.index = index;
      assertWorktreeRetained(s, await s.cleanup(), reason);
      assertWorktreeNotRemoved(s);
    });
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
  s.state.lsof.l3Target = target;
  s.state.lsof.l3 = reply(0, `p4242\ncless\nf3\nn${s.root}/r\\xc3\\xa9sum\\xc3\\xa9/report.log\n`);
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'pid 4242 (less) uses it');
});

test('an lsof warning on the mount holding the scratch target retains it', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  const mount = join(s.root, 'scratch');
  s.state.lsof.l3Target = target;
  s.state.lsof.l3Stderr = `lsof: WARNING: can't stat() overlay file system ${mount}\n      Output information may be incomplete.\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lookup incomplete: lsof could not stat the file system at ${mount}`);
});

test('an lsof warning on a mount below the scratch directory retains it', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  const mount = join(target, 'cache');
  mkdirSync(mount);
  s.state.lsof.l3Target = target;
  s.state.lsof.l3Stderr = `lsof: WARNING: can't stat() fuse.sshfs file system ${mount}\n      Output information may be incomplete.\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lookup incomplete: lsof could not stat the file system at ${mount}`);
});

test('an lsof warning on an unrelated mount is ignored and the scratch target removed', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
  s.state.lsof.l3Target = target;
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
  s.state.lsof.l3Target = target;
  s.state.lsof.l3Stderr = `lsof: status error on ${target}: Permission denied\n`;
  assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, `lsof reported: lsof: status error on ${target}: Permission denied`);
});

test('an lsof field the command did not ask for retains the scratch target', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'notes.md'));
  s.state.lsof.l3Target = target;
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
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 4,
    out: [
      `retained scratch ${target}: ps failed: exit status 1`,
      `retained worktree ${s.worktree}: ps failed: exit status 1`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(target));
  assert.ok(existsSync(s.worktree));
  assertWorktreeNotRemoved(s);
  assert.deepEqual(s.unexpected, []);
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
const DOCKER_LOCAL = `
if [ "$*" = 'context inspect --format {{json .Endpoints.docker}}' ]; then
  printf '%s\\n' '{"Host":"unix:///tmp/proof.sock","SkipTLSVerify":false}'
  exit 0
fi
[ -z "\${DOCKER_HOST+x}" ] && [ -z "\${DOCKER_CONTEXT+x}" ] || exit 98
[ "$1" = '--host' ] && [ "$2" = 'unix:///tmp/proof.sock' ] || exit 97
shift 2
`;
const DOCKER_EMPTY = `${DOCKER_LOCAL}[ "$*" = "container ls --all --quiet --no-trunc" ] && exit 0\necho "unexpected docker call: $*" >&2\nexit 99\n`;
const DOCKER_DOWN = `${DOCKER_LOCAL}echo '${DAEMON_DOWN}' >&2\nexit 1\n`;
// lsof prints nothing and exits 1 when nothing matches; any other call prints a line the command retains on.
const LSOF_FAKE = 'case "$*" in\n  "-nP -iTCP -sTCP:LISTEN -Fpc"|"-nP -Fpcfn /"*|"-nP -Fpcfn -x f +D /"*) exit 1 ;;\nesac\necho "unexpected lsof call: $*" >&2\nexit 1\n';
const PS_FAKE = '[ "$*" = "-ww -A -o pid= -o ppid= -o args=" ] || exit 99\necho \'      1       0 /sbin/init splash\'\n';

// A real repository with job/23 checked out in a linked worktree that holds an ignored node_modules, an outside
// scratch file, sh fakes for docker, lsof and ps first on PATH, and GIT_DIR naming a decoy repository the command's
// git calls must not read.
function cliFixture(t, docker, overrides = {}) {
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
  writeFileSync(join(repository, 'kept.txt'), 'committed\n');
  ok(git(['-C', repository, 'add', '--', 'kept.txt']), 'track kept.txt');
  ok(git(['-C', repository, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture baseline']), 'baseline commit');
  ok(git(['-C', repository, 'worktree', 'add', '-q', '-b', 'job/23', worktree]), 'job worktree');
  mkdirSync(join(repository, '.git', 'info'), { recursive: true });
  writeFileSync(join(repository, '.git', 'info', 'exclude'), 'node_modules/\n');
  placeFile(join(worktree, 'node_modules', 'left-pad', 'index.js'));
  ok(git(['init', '-q', join(root, 'decoy')]), 'decoy git init');
  const scratch = placeFile(join(root, 'scratch', 'notes.md'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const dockerLog = join(root, 'docker.log');
  for (const [name, body] of [['docker', `printf '%s\\n' "$*" >> "$FIXTURE_DOCKER_LOG"\n${docker}`], ['lsof', LSOF_FAKE], ['ps', PS_FAKE],
    ...Object.entries(PROOF_VECTORS).map(([name, args]) => [name,
      `[ "$*" = '${args.join(' ')}' ] || exit 96\nprintf '%s' '${PROOF_REPLIES[name].stdout}'\n`])]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  }
  const cleanup = (extraEnv = {}) => spawnSync(process.execPath, [CLI, '23', '--scratch', scratch, '--regenerated', 'node_modules'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, GIT_DIR: join(root, 'decoy', '.git'),
      FIXTURE_DOCKER_LOG: dockerLog, DOCKER_HOST: '', DOCKER_CONTEXT: '', DOCKER_CONFIG: join(root, 'docker-config'), ...overrides, ...extraEnv },
  });
  const branchStatus = () => git(['-C', repository, 'rev-parse', '--verify', '--quiet', 'refs/heads/job/23']).status;
  const registered = () => git(['-C', repository, 'worktree', 'list', '--porcelain']).stdout.includes(`worktree ${worktree}\n`);
  const dockerCalls = () => readFileSync(dockerLog, 'utf8').trim().split('\n');
  return { worktree, scratch, cleanup, branchStatus, registered, dockerCalls, git };
}

test('the CLI removes an outside scratch file, the worktree with its regenerated directory and the branch through real git', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
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

test('ANTI-REGRESSION: the CLI retains tracked edits hidden by index flags', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, async (t) => {
  for (const [mark, tag] of [['skip-worktree', 'S'], ['assume-unchanged', 'h']]) {
    await t.test(mark, (t) => {
      const f = cliFixture(t, DOCKER_EMPTY);
      const marked = f.git(['-C', f.worktree, 'update-index', `--${mark}`, '--', 'kept.txt']);
      assert.equal(marked.status, 0, marked.stderr);
      writeFileSync(join(f.worktree, 'kept.txt'), 'local edit\n');
      const status = f.git(['-C', f.worktree, 'status', '--porcelain']);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.stdout, '');
      const flags = f.git(['-C', f.worktree, 'ls-files', '-v', '-z']);
      assert.equal(flags.status, 0, flags.stderr);
      assert.equal(flags.stdout, `${tag} kept.txt\0`);
      const run = f.cleanup();
      assert.equal(run.status, 4, run.stdout + run.stderr);
      assert.equal(run.stderr, '');
      assert.match(run.stdout, /retained worktree .*: git index flags are hidden or unreadable/);
      assert.match(run.stdout, /retained branch job\/23: its worktree is retained/);
      assert.equal(readFileSync(join(f.worktree, 'kept.txt'), 'utf8'), 'local edit\n');
      assert.equal(f.registered(), true);
      assert.equal(f.branchStatus(), 0);
      assert.equal(existsSync(f.scratch), false);
    });
  }
});

test('the CLI retains every target when the docker daemon is unreachable', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
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

const REMOTE_DOCKER = `
if [ "$*" = 'context inspect --format {{json .Endpoints.docker}}' ]; then
  [ "\${DOCKER_HOST-}" = "$FIXTURE_EXPECT_HOST" ] && [ "\${DOCKER_CONTEXT-}" = "$FIXTURE_EXPECT_CONTEXT" ] || exit 98
  printf '%s\\n' '{"Host":"ssh://fixture-remote.invalid"}'
  exit 0
fi
# Retain exact old vectors so an explicit-selection regression still reaches the wrong cleanup.
if [ "$*" = '--host ssh://fixture-remote.invalid context inspect --format {{json .Endpoints.docker}}' ]; then
  printf '%s\\n' '{"Host":"ssh://fixture-remote.invalid"}'
  exit 0
fi
if [ "$*" = '--context fixture-local context inspect --format {{json .Endpoints.docker}}' ]; then
  printf '%s\\n' '{"Host":"unix:///tmp/proof.sock"}'
  exit 0
fi
if [ "$1" = "--host" ]; then shift 2; fi
case "$*" in
  'container ls --all --quiet --no-trunc') printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  'inspect --type container --format {{json .}} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    printf '%s\n' "$FIXTURE_RECORD" ;;
  'stop aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'|'rm aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') exit 0 ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`;

test('ANTI-REGRESSION: the CLI retains every target when a remote Docker bind matches the local worktree path', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, environment] of [
    ['host-selected SSH', { DOCKER_HOST: 'ssh://fixture-remote.invalid' }],
    ['both host and context selectors', { DOCKER_HOST: 'ssh://fixture-remote.invalid', DOCKER_CONTEXT: 'fixture-local' }],
    ['saved remote context', { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined }],
  ]) {
    await t.test(name, (t) => {
      const f = cliFixture(t, REMOTE_DOCKER, {
        ...environment, FIXTURE_EXPECT_HOST: environment.DOCKER_HOST ?? '', FIXTURE_EXPECT_CONTEXT: environment.DOCKER_CONTEXT ?? '',
      });
      // This real path is the remote daemon's bind spelling, never authority over the local worktree.
      const record = containerRecord('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        running: true, mounts: [bindMount(f.worktree)],
      });
      const run = f.cleanup({ FIXTURE_RECORD: JSON.stringify(record) });
      const calls = f.dockerCalls();
      assert.deepEqual({
        exit: run.status, destructive: calls.filter((call) => /^(?:--host \S+ )?(?:stop|rm) /.test(call)),
        scratch: existsSync(f.scratch), ignored: existsSync(join(f.worktree, 'node_modules', 'left-pad', 'index.js')),
        registered: f.registered(), branch: f.branchStatus(),
      }, { exit: 4, destructive: [], scratch: true, ignored: true, registered: true, branch: 0 });
      assert.match(run.stdout, /Docker filesystem relationship is unverifiable: unsupported endpoint/);
      assert.equal(run.stderr, '');
      assert.doesNotMatch(run.stdout, /fixture-remote|ssh:\/\//);
      assert.deepEqual(calls, ['context inspect --format {{json .Endpoints.docker}}']);
    });
  }
});

function passwordlessProof(s, owners = ACTIVATED_SS) {
  s.state.native.ss = reply(0, OWNERLESS_SS);
  s.state.privileged = {
    ss: reply(0, owners),
    stat: (args) => reply(0, args[4].startsWith('/proc/1/fd/') ? SYSTEMD_PROC_STAT : DAEMON_PROC_STAT),
  };
}

function proofTargets(s) {
  const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
  s.state.docker.containers = [
    containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] }),
    containerRecord(ID_B, { running: true, mounts: [bindMount(s.mainDir)] }),
  ];
  return scratch;
}

function assertProofRetained(s, result, scratch) {
  assert.equal(result.exitCode, 4);
  assert.match(result.out.join('\n'), /Docker filesystem relationship is unverifiable: \S/);
  assert.doesNotMatch(result.out.join('\n'), /fixture-secret|fixture warning|removed (?:container|scratch|worktree|branch)/);
  assert.ok(existsSync(scratch));
  assert.ok(existsSync(s.worktree));
  assertWorktreeNotRemoved(s);
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.unexpected, []);
}

test('ANTI-REGRESSION: passwordless Docker proof verifies every socket activation owner', async (t) => {
  for (const [name, privileged, owners] of [
    ['native singleton', false, PROOF_SS], ['native activated', false, ACTIVATED_SS],
    ['privileged singleton', true, PROOF_SS], ['privileged activated', true, ACTIVATED_SS],
    ['reversed display order', true, ACTIVATED_SS.replace('("dockerd",pid=71,fd=3),("systemd",pid=1,fd=9)',
      '("systemd",pid=1,fd=9),("dockerd",pid=71,fd=3)')],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      if (privileged) passwordlessProof(s, owners);
      else s.state.native.ss = reply(0, owners);
      // A display-order-only change between rechecks must keep the same canonical identity.
      if (name === 'reversed display order') {
        let reads = 0;
        s.state.privileged.ss = () => reply(0, ++reads % 2 ? owners : ACTIVATED_SS);
      }
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.equal(result.exitCode, 0, result.out.join('\n'));
      assert.equal(existsSync(scratch), false);
      assert.equal(existsSync(s.worktree), false);
      assert.equal(s.state.branch, false);
      assert.deepEqual(s.state.docker.containers.map(({ Id, State }) => [Id, State.Running]), [[ID_B, true]]);
      assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
      assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
      assert.deepEqual(s.unexpected, []);
    });
  }
  for (const [name, owners, stat, reason] of [
    ['systemd executable', ACTIVATED_SS, SYSTEMD_PROC_STAT.replace('60:81:', '60:82:'), 'systemd executable differs from resolved executable'],
    ['systemd namespace', ACTIVATED_SS, SYSTEMD_PROC_STAT.replace('40:1000:', '40:1001:'), 'systemd mount namespace differs from local process'],
    ['systemd root', ACTIVATED_SS, SYSTEMD_PROC_STAT.replace('50:2:', '50:3:'), 'systemd root differs from local root'],
    ['systemd descriptor', ACTIVATED_SS, SYSTEMD_PROC_STAT.replace('10:700:', '10:701:'), 'socket descriptor does not match listener'],
    ['non-PID-1 second owner', ACTIVATED_SS.replace('pid=1,', 'pid=2,'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['systemd alone', PROOF_SS.replace('("dockerd",pid=71,fd=3)', '("systemd",pid=1,fd=9)'), undefined, 'daemon executable differs from resolved executable'],
    ['duplicate PID', ACTIVATED_SS.replace('("dockerd",pid=71,fd=3)', '("systemd",pid=1,fd=10)'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['duplicate tuple', ACTIVATED_SS.replace('("systemd",pid=1,fd=9)', '("dockerd",pid=71,fd=3)'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['extra owner', ACTIVATED_SS.replace('fd=9))', 'fd=9),("other",pid=2,fd=4))'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['empty users', PROOF_SS.replace('("dockerd",pid=71,fd=3)', ''), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['malformed owner', ACTIVATED_SS.replace('pid=1,fd=9', 'pid=1'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['truncated listener', ACTIVATED_SS.slice(0, -1), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['oversized PID', ACTIVATED_SS.replace('pid=1,', 'pid=2147483648,'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['oversized FD', ACTIVATED_SS.replace('fd=9', 'fd=2147483648'), undefined, 'listener ownership observation is missing, ambiguous or unsupported'],
    ['partial stat', ACTIVATED_SS, SYSTEMD_PROC_STAT.split('\n').slice(0, 3).join('\n') + '\n', 'filesystem identity observation is unsupported or malformed'],
    ['truncated stat', ACTIVATED_SS, SYSTEMD_PROC_STAT.slice(0, -1), 'filesystem identity observation is unsupported or malformed'],
    ['malformed stat', ACTIVATED_SS, SYSTEMD_PROC_STAT.replace('40:1000:', '40:-1:'), 'filesystem identity observation is unsupported or malformed'],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      passwordlessProof(s, owners);
      if (stat) s.state.privileged.stat = (args) => reply(0, args[4] === '/proc/1/fd/9' ? stat : DAEMON_PROC_STAT);
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assertProofRetained(s, result, scratch);
      assert.equal(result.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
    });
  }
});

test('ANTI-REGRESSION: passwordless Docker proof preserves caller identity and latches changes', async (t) => {
  for (const [name, caller, reason] of [
    ['caller namespace', SYSTEMD_CALLER_STAT.replace('40:1000:', '40:1001:'), 'systemd mount namespace differs from local process'],
    ['caller root', SYSTEMD_CALLER_STAT.replace('50:2:', '50:3:'), 'systemd root differs from local root'],
    ['caller executable', SYSTEMD_CALLER_STAT.replace('60:81:', '60:82:'), 'systemd executable differs from resolved executable'],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      passwordlessProof(s);
      s.state.native.stat = (args) => reply(0, args.at(-1) === '/usr/lib/systemd/systemd' ? caller : CALLER_STAT);
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assertProofRetained(s, result, scratch);
      assert.equal(result.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
    });
  }
  for (const change of ['remove systemd', 'change systemd descriptor', 'change systemd identity', 'one failed recheck']) {
    await t.test(change, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      passwordlessProof(s);
      let failedReads = 0;
      s.state.onDocker = ([verb]) => {
        if (verb !== 'stop') return;
        if (change === 'remove systemd') s.state.privileged.ss = reply(0, PROOF_SS);
        if (change === 'change systemd descriptor') s.state.privileged.ss = reply(0, ACTIVATED_SS.replace('fd=9', 'fd=10'));
        if (change === 'change systemd identity') {
          s.state.native.stat = (args) => reply(0, args.at(-1) === '/usr/lib/systemd/systemd'
            ? SYSTEMD_CALLER_STAT.replace('60:81:', '60:82:') : CALLER_STAT);
          s.state.privileged.stat = (args) => reply(0, args[4] === '/proc/1/fd/9'
            ? SYSTEMD_PROC_STAT.replace('60:81:', '60:82:') : DAEMON_PROC_STAT);
        }
        if (change === 'one failed recheck') s.state.privileged.ss = () => ++failedReads === 1 ? reply(1) : reply(0, ACTIVATED_SS);
      };
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.equal(result.exitCode, 4);
      const reason = change === 'one failed recheck'
        ? 'native identity changed or became unreadable: passwordless listener observation was unavailable'
        : 'native identity changed since initial observation';
      assert.deepEqual(result.out.filter((line) => line.startsWith('retained container ')), [
        `retained container aaaaaaaaaaaa: Docker filesystem relationship is unverifiable: ${reason}`,
      ]);
      assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
      assert.deepEqual(dockerCalls(s, 'rm'), []);
      assert.ok(existsSync(scratch));
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.equal(s.state.docker.containers[1].State.Running, true);
      if (change === 'one failed recheck') assert.equal(failedReads, 1);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('ANTI-REGRESSION: Docker privilege fallback is bounded and never prompts', async (t) => {
  for (const trigger of ['native success', 'ownerless']) {
    await t.test(trigger, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      if (trigger !== 'native success') passwordlessProof(s);
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.equal(result.exitCode, 0, result.out.join('\n'));
      const sudo = s.executions.filter(({ command }) => command === '/usr/bin/sudo');
      if (trigger === 'native success') assert.deepEqual(sudo, []);
      else {
        assert.ok(sudo.length > 0);
        assert.deepEqual(sudo[0].args, [...SUDO_PREFIX, '/usr/bin/ss', ...PROOF_VECTORS.ss]);
        for (const { command, args } of sudo) {
          assert.equal(command, '/usr/bin/sudo');
          assert.deepEqual(args.slice(0, 6), SUDO_PREFIX);
          if (args[6] === '/usr/bin/stat') {
            assert.ok([DAEMON_PROC_VECTOR, SYSTEMD_PROC_VECTOR].some((vector) => JSON.stringify(vector) === JSON.stringify(args.slice(7))));
          }
        }
        assert.ok(s.executions.some(({ command, args }) => command === 'stat' && JSON.stringify(args) === JSON.stringify(CALLER_VECTOR)));
        assert.ok(s.executions.some(({ command, args }) => command === 'stat' && JSON.stringify(args) === JSON.stringify(SYSTEMD_CALLER_VECTOR)));
        const observations = s.executions.filter(({ command }) => command === 'ss');
        assert.equal(observations.length, 1, 'rechecks must pin privileged mode');
      }
      assert.deepEqual(s.unexpected, []);
    });
  }
  await t.test('native nonzero identity stat does not elevate', async (t) => {
    const s = scenario(t);
    const scratch = proofTargets(s);
    passwordlessProof(s);
    s.state.native.ss = PROOF_REPLIES.ss;
    s.state.native.stat = (args) => args.length === 12 ? reply(1)
      : reply(0, args.at(-1) === '/usr/lib/systemd/systemd' ? SYSTEMD_CALLER_STAT : CALLER_STAT);
    assertProofRetained(s, await s.cleanup(['23', '--scratch', scratch]), scratch);
    assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo'), []);
    assert.deepEqual(s.executions.filter(({ command, args }) => command === 'stat' && args.length === 8), []);
  });
  for (const [name, native] of [
    ['absent native stat', { absent: true }], ['failed native execution', { failed: 'EACCES' }],
    ['malformed native stat', reply(0, 'partial\n')], ['native stderr', reply(0, PROOF_STAT, 'fixture warning')],
    ['native mismatch', reply(0, PROOF_STAT.replace('50:2:', '50:3:'))],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      s.state.native.stat = native;
      assertProofRetained(s, await s.cleanup(['23', '--scratch', scratch]), scratch);
      assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo'), []);
    });
  }
  for (const [name, result] of [
    ['absent', { absent: true }], ['denied', reply(1, '', 'fixture-secret')], ['failed', { failed: 'ETIMEDOUT' }],
    ['stderr', reply(0, ACTIVATED_SS, 'fixture warning')], ['partial', reply(0, 'u_str LISTEN\n')],
  ]) {
    for (const stage of ['ss', 'stat']) {
      await t.test(`privileged ${stage} ${name}`, async (t) => {
        const s = scenario(t);
        const scratch = proofTargets(s);
        passwordlessProof(s);
        s.state.privileged[stage] = stage === 'stat' && name === 'stderr' ? reply(0, DAEMON_PROC_STAT, 'fixture warning') : result;
        const observed = await s.cleanup(['23', '--scratch', scratch]);
        assertProofRetained(s, observed, scratch);
        const reason = name === 'partial'
          ? stage === 'ss' ? 'listener ownership observation is missing, ambiguous or unsupported'
            : 'filesystem identity observation is unsupported or malformed'
          : stage === 'ss' ? 'passwordless listener observation was unavailable'
            : 'passwordless systemd filesystem identity observation was unavailable';
        assert.equal(observed.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
      });
    }
  }
  for (const [name, baseline] of [['partial', reply(0, 'partial\n')], ['stderr', reply(0, CALLER_STAT, 'fixture warning')], ['nonzero', reply(1)]]) {
    await t.test(`privileged caller baseline ${name}`, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      passwordlessProof(s);
      s.state.native.stat = baseline;
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assertProofRetained(s, result, scratch);
      const reason = name === 'partial' ? 'caller filesystem identity observation is unsupported or malformed'
        : 'caller filesystem identity observation command did not complete cleanly';
      assert.equal(result.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
      assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo').map(({ args }) => args),
        [[...SUDO_PREFIX, '/usr/bin/ss', ...PROOF_VECTORS.ss]]);
    });
  }
  await t.test('native mode never elevates a failed recheck', async (t) => {
    const s = scenario(t);
    const scratch = proofTargets(s);
    s.state.onDocker = ([verb]) => { if (verb === 'stop') s.state.native.stat = reply(1); };
    const result = await s.cleanup(['23', '--scratch', scratch]);
    assert.equal(result.exitCode, 4);
    assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assert.ok(existsSync(scratch));
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo'), []);
  });
});

test('Docker filesystem proof rejects incomplete, ambiguous or mismatched native observations', async (t) => {
  const cases = [];
  for (const [name, stage] of [
    ['readlink', 'socket path observation command did not complete cleanly'],
    ['sh', 'daemon executable lookup command did not complete cleanly'],
    ['ss', 'listener observation command did not complete cleanly'],
    ['stat', 'filesystem identity observation command did not complete cleanly'],
  ]) {
    for (const [kind, result] of [
      ['absent', { absent: true }], ['failed execution', { failed: 'EACCES' }],
      ['nonzero', reply(1)], ['stderr', reply(0, PROOF_REPLIES[name].stdout, 'fixture warning')],
    ]) cases.push([`${name} ${kind}`, (s) => { s.state.native[name] = result; }, stage]);
  }
  for (const [name, result, stage] of [
    ['failed context inspection', reply(1), 'endpoint inspection failed'], ['failed context execution', { failed: 'EACCES' }, 'endpoint inspection failed'],
    ['context stderr', reply(0, '{"Host":"unix:///tmp/proof.sock"}', 'warning'), 'endpoint inspection failed'],
    ['malformed JSON', reply(0, '{'), 'endpoint metadata is unreadable'], ['array metadata', reply(0, '[]'), 'endpoint metadata is unreadable'],
    ['null metadata', reply(0, 'null'), 'endpoint metadata is unreadable'], ['missing Host', reply(0, '{}'), 'endpoint metadata is unreadable'],
    ['non-string Host', reply(0, '{"Host":3}'), 'endpoint metadata is unreadable'], ['empty Host', reply(0, '{"Host":""}'), 'endpoint metadata is unreadable'],
    ['control-bearing Host', reply(0, JSON.stringify({ Host: 'unix:///tmp/proof.sock\n' })), 'endpoint metadata is unreadable'],
    ['credential-bearing remote endpoint', reply(0, '{"Host":"ssh://user:fixture-secret@remote.invalid"}'), 'unsupported endpoint'],
    ['TCP endpoint', reply(0, '{"Host":"tcp://127.0.0.1:2375"}'), 'unsupported endpoint'],
    ['abstract socket', reply(0, '{"Host":"unix://@abstract"}'), 'unsupported endpoint'],
    ['unnormalized socket', reply(0, '{"Host":"unix:///tmp/../proof.sock"}'), 'unsupported endpoint'],
    ['unsupported socket spelling', reply(0, '{"Host":"unix:///tmp/proof socket"}'), 'unsupported endpoint'],
  ]) cases.push([name, (s) => { s.state.metadata = result; }, stage]);
  for (const [name, stdout] of [
    ['missing listener', ''], ['duplicate listener', PROOF_SS + PROOF_SS],
    ['duplicate owner', PROOF_SS.replace('fd=3))', 'fd=3),("dockerd",pid=72,fd=4))')],
    ['missing owner', PROOF_SS.replace('users:(("dockerd",pid=71,fd=3)) ', '')],
    ['wrong local address', PROOF_SS.replace('/tmp/proof.sock', '/tmp/other.sock')],
    ['trailing field', PROOF_SS.replace('peers:', 'peers: extra:1')],
    ['truncated listener', PROOF_SS.slice(0, -1)],
    ['zero kernel inode', PROOF_SS.replace('700 *', '0 *')],
    ['zero filesystem inode', PROOF_SS.replace('ino:90', 'ino:0')],
    ['zero PID', PROOF_SS.replace('pid=71', 'pid=0')],
    ['oversized PID', PROOF_SS.replace('pid=71', 'pid=2147483648')],
    ['negative FD', PROOF_SS.replace('fd=3', 'fd=-1')],
    ['oversized FD', PROOF_SS.replace('fd=3', 'fd=2147483648')],
    ['duplicate identity', PROOF_SS.replace('peers:', 'ino:90 peers:')],
  ]) cases.push([name, (s) => { s.state.native.ss = reply(0, stdout); },
    name === 'missing owner' ? 'passwordless listener observation was unavailable' :
      'listener ownership observation is missing, ambiguous or unsupported']);
  for (const [name, stdout, stage] of [
    ['partial stat', PROOF_STAT.split('\n').slice(0, 7).join('\n') + '\n', 'filesystem identity observation is unsupported or malformed'],
    ['truncated stat', PROOF_STAT.slice(0, -1), 'filesystem identity observation is unsupported or malformed'],
    ['filesystem socket inode mismatch', PROOF_STAT.replace('100:90:', '100:91:'), 'filesystem socket inode does not match listener'],
    ['filesystem socket device mismatch', PROOF_STAT.replace('100:90:0:5', '100:90:0:6'), 'filesystem socket device does not match listener'],
    ['descriptor kernel-inode mismatch', PROOF_STAT.replace('10:700:', '10:90:'), 'socket descriptor does not match listener'],
    ['proxy named dockerd with different executed binary', PROOF_STAT.replace(/60:80:0:60:regular file\n$/, '60:81:0:60:regular file\n'), 'daemon executable differs from resolved executable'],
    ['different mount namespace', PROOF_STAT.replace('40:1000:', '40:1001:'), 'daemon mount namespace differs from local process'],
    ['different root', PROOF_STAT.replace('50:2:', '50:3:'), 'daemon root differs from local root'],
    ['wrong socket type', PROOF_STAT.replace('100:90:0:5:socket', '100:90:0:5:directory'), 'filesystem identity observation is unsupported or malformed'],
    ['unknown stat type', PROOF_STAT.replace('regular empty file', 'mystery'), 'filesystem identity observation is unsupported or malformed'],
    ['unsafe stat integer', PROOF_STAT.replace('100:90:', '100:-90:'), 'filesystem identity observation is unsupported or malformed'],
  ]) cases.push([name, (s) => { s.state.native.stat = reply(0, stdout); }, stage]);
  cases.push(['unresolved canonical path', (s) => { s.state.native.readlink = reply(0, '/tmp/../proof.sock\n'); }, 'socket path observation is unsupported or malformed']);
  cases.push(['multiple canonical paths', (s) => { s.state.native.readlink = reply(0, '/tmp/proof.sock\n/tmp/other.sock\n'); }, 'socket path observation is unsupported or malformed']);
  cases.push(['relative daemon executable', (s) => { s.state.native.sh = reply(0, 'dockerd\n'); }, 'daemon executable observation is unsupported or malformed']);
  cases.push(['Darwin Docker-present refusal', () => {}, 'unsupported endpoint', { platform: 'darwin' }]);
  for (const [name, configure, stage, seams] of cases) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const target = placeFile(join(s.root, 'scratch', 'proof.txt'));
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      configure(s);
      const result = await s.cleanup(['23', '--scratch', target], seams);
      assert.equal(result.exitCode, 4);
      const reason = `Docker filesystem relationship is unverifiable: ${stage}`;
      assert.deepEqual(result.out, [
        `retained scratch ${target}: docker failed: ${reason}`,
        `retained worktree ${s.worktree}: docker failed: ${reason}`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 3 retained',
      ]);
      assert.doesNotMatch(result.out.join('\n'), /fixture-secret|remote\.invalid|fixture warning/);
      assert.ok(existsSync(target));
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.equal(s.state.branch, true);
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('Docker cleanup pins its endpoint after selection', async (t) => {
  const s = scenario(t);
  const capturedPath = { ...process.env }.PATH;
  let selections = 0;
  s.state.metadata = () => reply(0, JSON.stringify({ Host: ++selections === 1 ? PROOF_HOST : 'ssh://changed.invalid' }));
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
  const result = await s.cleanup();
  assert.equal(result.exitCode, 0);
  assert.equal(selections, 1);
  const actions = s.executions.filter(({ command, args }) => command === 'docker' && args[0] !== 'context');
  assert.deepEqual(actions.map(({ args }) => args), [
    ['--host', PROOF_HOST, 'container', 'ls', '--all', '--quiet', '--no-trunc'],
    ['--host', PROOF_HOST, 'inspect', '--type', 'container', '--format', '{{json .}}', ID_A],
    ['--host', PROOF_HOST, 'stop', ID_A], ['--host', PROOF_HOST, 'rm', ID_A],
  ]);
  for (const { env } of actions) {
    assert.equal(env.DOCKER_CONTEXT, undefined);
    assert.equal(env.DOCKER_HOST, undefined);
    assert.equal(env.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
    assert.equal(env.PATH, capturedPath);
  }
  assert.deepEqual(s.unexpected, []);
});

test('Docker cleanup retains remaining targets when filesystem proof changes', async (t) => {
  await t.test('after a verified stop', async (t) => {
    const s = scenario(t);
    const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
    s.state.docker.containers = [
      containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] }),
      containerRecord(ID_B, { running: true, mounts: [bindMount(s.mainDir)] }),
    ];
    s.state.onDocker = ([verb]) => {
      if (verb === 'stop') s.state.native.ss = reply(0, PROOF_SS.replace('700 *', '701 *'));
    };
    const result = await s.cleanup(['23', '--scratch', scratch]);
    assert.equal(result.exitCode, 4);
    assert.equal(dockerCalls(s, 'stop').length, 1);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assert.equal(s.state.docker.containers[0].State.Running, false);
    assert.equal(s.state.docker.containers[1].State.Running, true);
    const reason = 'Docker filesystem relationship is unverifiable: native identity changed or became unreadable: socket descriptor does not match listener';
    assert.deepEqual(result.out.filter((line) => line.startsWith('retained container ')), [
      `retained container aaaaaaaaaaaa: ${reason}`,
    ]);
    assert.doesNotMatch(result.out.join('\n'), /bbbbbbbbbbbb/);
    assert.equal(result.out.at(-1), 'closeout-cleanup: 0 removed, 4 retained');
    assert.deepEqual(result.out.filter((line) => line.startsWith('unverifiable remaining container relationships:')), [
      `unverifiable remaining container relationships: ${reason}`,
    ]);
    assert.ok(existsSync(scratch));
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.match(result.out.join('\n'), /native identity changed/);
    assert.doesNotMatch(result.out.join('\n'), /removed container|removed scratch|removed worktree|removed branch/);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('valid changed fingerprint is retained', async (t) => {
    const s = scenario(t);
    const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
    s.state.onDocker = ([verb]) => {
      if (verb === 'stop') {
        s.state.native.ss = reply(0, PROOF_SS.replace('700 *', '701 *'));
        s.state.native.stat = reply(0, PROOF_STAT.replace('10:700:', '10:701:'));
      }
    };
    const result = await s.cleanup(['23', '--scratch', scratch]);
    const reason = 'Docker filesystem relationship is unverifiable: native identity changed since initial observation';
    assert.equal(result.exitCode, 4);
    assert.deepEqual(result.out, [
      `retained container aaaaaaaaaaaa: ${reason}`,
      `retained scratch ${scratch}: ${reason}`,
      `retained worktree ${s.worktree}: ${reason}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 4 retained',
    ]);
    assert.equal(dockerCalls(s, 'stop').length, 1);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assert.equal(s.state.docker.containers[0].State.Running, false);
    assert.ok(existsSync(scratch));
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.equal(s.state.branch, true);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('first failed recheck stays latched', async (t) => {
    const s = scenario(t);
    const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
    let observations = 0;
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
    s.state.onDocker = ([verb]) => {
      if (verb === 'stop') {
        s.state.native.ss = () => ++observations === 1 ? reply(1, 'fixture-secret', 'fixture warning') : PROOF_REPLIES.ss;
      }
    };
    const result = await s.cleanup(['23', '--scratch', scratch]);
    const reason = 'Docker filesystem relationship is unverifiable: native identity changed or became unreadable: listener observation command did not complete cleanly';
    assert.equal(result.exitCode, 4);
    assert.equal(observations, 1);
    assert.deepEqual(result.out, [
      `retained container aaaaaaaaaaaa: ${reason}`,
      `retained scratch ${scratch}: ${reason}`,
      `retained worktree ${s.worktree}: ${reason}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 4 retained',
    ]);
    assert.equal(dockerCalls(s, 'stop').length, 1);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assert.equal(s.state.docker.containers[0].State.Running, false);
    assert.ok(existsSync(scratch));
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.equal(s.state.branch, true);
    assert.deepEqual(s.unexpected, []);
  });
  for (const boundary of ['scratch use check', 'worktree use check', 'worktree status', 'branch deletion']) {
    await t.test(boundary, async (t) => {
      const s = scenario(t);
      const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
      const change = () => { s.state.native.stat = reply(0, PROOF_STAT.replace('50:2:', '50:3:')); };
      if (boundary.includes('use check')) s.state.onPs = change;
      if (boundary === 'worktree status') s.state.onStatus = change;
      if (boundary === 'branch deletion') s.state.onWorktreeRemoved = change;
      const result = await s.cleanup(boundary === 'scratch use check' ? ['23', '--scratch', scratch] : ['23']);
      assert.equal(result.exitCode, 4);
      const reason = 'Docker filesystem relationship is unverifiable: native identity changed or became unreadable: daemon root differs from local root';
      let subject = `worktree ${s.worktree}`;
      if (boundary === 'scratch use check') subject = `scratch ${scratch}`;
      if (boundary === 'branch deletion') subject = 'branch job/23';
      assert.ok(result.out.includes(`retained ${subject}: ${reason}`));
      assert.equal(s.state.branch, true);
      if (boundary === 'scratch use check') assert.ok(existsSync(scratch));
      if (boundary === 'branch deletion') {
        assert.equal(existsSync(s.worktree), false);
        assert.ok(result.out.includes(`removed worktree ${s.worktree}`));
      } else assertWorktreeNotRemoved(s);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('check mode reports an unverified Docker filesystem relationship', async (t) => {
  const s = scenario(t);
  const target = placeFile(join(s.root, 'scratch', 'proof.txt'));
  s.state.native.stat = reply(0, PROOF_STAT.replace('50:2:', '50:3:'));
  const result = await s.cleanup(['--check', target]);
  assert.equal(result.exitCode, 4);
  assert.equal(result.out[0], `unverifiable path ${target}: docker failed: Docker filesystem relationship is unverifiable: daemon root differs from local root`);
  assert.equal(result.out.at(-1), SUMMARY(0, 0, 0, 1));
  assert.ok(existsSync(target));
  assertNothingChanged(s);
});

test('the CLI removes verified-local Docker containers and job targets through real git', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, `${DOCKER_LOCAL}${REMOTE_DOCKER.slice(REMOTE_DOCKER.indexOf('case "$*"'))}`);
  const record = containerRecord('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    running: true, mounts: [bindMount(f.worktree)],
  });
  const result = f.cleanup({ FIXTURE_RECORD: JSON.stringify(record) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'removed container aaaaaaaaaaaa', `removed scratch ${f.scratch}`, `removed worktree ${f.worktree}`,
    'removed branch job/23', 'closeout-cleanup: 4 removed, 0 retained', '',
  ].join('\n'));
  assert.deepEqual(f.dockerCalls().filter((call) => / (?:stop|rm) /.test(call)), [
    '--host unix:///tmp/proof.sock stop aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--host unix:///tmp/proof.sock rm aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  assert.equal(existsSync(f.scratch), false);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.registered(), false);
  assert.equal(f.branchStatus(), 1);
});

test('native Linux socket observations bind a listener to its descriptor and filesystem view', { skip: process.platform !== 'linux' && 'native socket observations require Linux' }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-native-')));
  const directory = join(root, 'real');
  const alias = join(root, 'alias');
  mkdirSync(directory);
  symlinkSync('real', alias, 'dir');
  const socket = join(alias, 'proof.sock');
  const canonicalSocket = join(directory, 'proof.sock');
  const target = placeFile(join(root, 'scratch.txt'));
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  let executable = process.execPath;
  const observations = [];
  const run = (command, args, options) => {
    if (command === 'docker') {
      if (args.join(' ') === 'context inspect --format {{json .Endpoints.docker}}') return reply(0, JSON.stringify({ Host: `unix://${socket}` }));
      assert.deepEqual(args, ['--host', `unix://${canonicalSocket}`, 'container', 'ls', '--all', '--quiet', '--no-trunc']);
      return reply(0);
    }
    if (command === 'sh') {
      assert.deepEqual(args, ['-c', 'command -v dockerd']);
      return reply(0, `${executable}\n`);
    }
    if (command === 'lsof') return reply(1);
    if (command === 'ps') return reply(0, '1 0 /sbin/init\n');
    const result = runCommand(command, args, options);
    observations.push({ command, args, result });
    return result;
  };
  const invoke = () => {
    const out = [];
    const err = [];
    const exitCode = withoutDockerSelection(() => main(['--check', target], {
      run, platform: 'linux', output: { log: (line) => out.push(line), error: (line) => err.push(line) },
    }));
    return { exitCode, out, err };
  };
  const positive = invoke();
  const unavailable = observations.find(({ result }) => result.absent || result.failed || result.status !== 0 || result.stderr);
  if (unavailable) {
    t.skip(`native ${unavailable.command} tools/permissions unavailable`);
    return;
  }
  // Missing ownership is a permission limit; a different complete native shape must fail visibly, never skip.
  if (observations.some(({ command, result }) => command === 'ss' && result.stdout !== '' && !result.stdout.includes('users:'))) {
    t.skip('native socket ownership unavailable');
    return;
  }
  assert.deepEqual(positive, { exitCode: 0, out: [`unused path ${target}`, SUMMARY(1, 0, 0, 0)], err: [] },
    JSON.stringify(observations.map(({ command, result }) => ({
      command, status: result.status, absent: result.absent, failed: result.failed,
      stdoutFirst2048: result.stdout?.slice(0, 2048), stderrFirst512: result.stderr?.slice(0, 512),
    }))));
  for (const { args } of observations.filter(({ command }) => command === 'ss')) {
    assert.deepEqual(args, ['-H', '-xlnpe', '(', 'src', socket, 'or', 'src', canonicalSocket, ')']);
  }
  assert.ok(observations.some(({ command }) => command === 'stat'));
  const positiveStats = observations.filter(({ command }) => command === 'stat').length;
  executable = '/bin/sh';
  const negative = invoke();
  assert.equal(negative.exitCode, 4);
  assert.match(negative.out[0], /^unverifiable path .*Docker filesystem relationship is unverifiable/);
  assert.ok(observations.filter(({ command }) => command === 'stat').length > positiveStats);
  assert.ok(existsSync(target));
});


test('ANTI-REGRESSION: optional socket shutdown markers never replace filesystem identity', async (t) => {
  for (const [name, marker, admitted, foreignDescriptor] of [
    ['absent marker', '', true, false],
    ['bidirectional marker', '<->', true, false],
    ['left marker', '<--', true, false],
    ['right marker', '-->', true, false],
    ['closed marker', '---', true, false],
    ['unknown marker', '<?>', false, false],
    ['absent marker with foreign descriptor', '', false, true],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      s.state.native.ss = reply(0, PROOF_SS.replace('<-> ', marker ? `${marker} ` : ''));
      if (foreignDescriptor) {
        s.state.native.stat = reply(0, PROOF_STAT.replace('10:700:0:10:socket', '10:701:0:10:socket'));
      }
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.deepEqual(result.err, []);
      if (admitted) {
        assert.equal(result.exitCode, 0);
        assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
        assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
        assert.equal(existsSync(scratch), false);
        assert.equal(existsSync(s.worktree), false);
        assert.equal(s.state.branch, false);
      } else {
        assert.equal(result.exitCode, 4);
        assert.match(result.out.join('\n'), /Docker filesystem relationship is unverifiable/);
        assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
        assert.ok(existsSync(scratch));
        assert.ok(existsSync(s.worktree));
        assertWorktreeNotRemoved(s);
      }
      assert.deepEqual(s.unexpected, []);
    });
  }
});


test('ANTI-REGRESSION: Docker socket device encodings preserve filesystem identity', async (t) => {
  for (const [name, printedDevice, socketRow, admitted] of [
    ['hosted physical device', '0/2049', '2049:95390:8:1:socket', true],
    ['high minor bit', '1/2048', '1050624:95390:8:256:socket', true],
    ['full 32-bit boundary', '4095/1048575', '4294967295:95390:4095:1048575:socket', true],
    ['foreign major', '0/2049', '2305:95390:9:1:socket', false],
    ['foreign minor', '0/2049', '2050:95390:8:2:socket', false],
    ['printed major overflow', '4096/2049', '2049:95390:8:1:socket', false],
    ['printed minor overflow', '0/1050625', '2049:95390:8:1:socket', false],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = placeFile(join(s.root, 'scratch', 'proof.txt'));
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      s.state.native.ss = reply(0, PROOF_SS.replace('700 *', '17069 *')
        .replace('ino:90', 'ino:95390').replace('dev:0/5', `dev:${printedDevice}`));
      s.state.native.stat = reply(0, PROOF_STAT.replace('100:90:0:5:socket', socketRow)
        .replace('10:700:0:10:socket', '9:17069:0:9:socket'));
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.deepEqual(result.err, []);
      assert.deepEqual(s.unexpected, []);
      if (admitted) {
        assert.equal(result.exitCode, 0, result.out.join('\n'));
        assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
        assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
        assert.ok(s.calls.findIndex(([name, , , verb]) => name === 'docker' && verb === 'stop') <
          s.calls.findIndex(([name, , , verb]) => name === 'docker' && verb === 'rm'));
        assert.equal(existsSync(scratch), false);
        assert.equal(existsSync(s.worktree), false);
        assert.equal(s.state.branch, false);
      } else {
        assert.equal(result.exitCode, 4);
        assert.match(result.out.join('\n'), /Docker filesystem relationship is unverifiable/);
        assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
        assert.ok(existsSync(scratch));
        assert.ok(existsSync(s.worktree));
        assertWorktreeNotRemoved(s);
      }
    });
  }
});
