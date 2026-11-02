// closeout-cleanup.test.mjs: the closeout cleanup command removes a job's containers, named scratch, worktree, the
// empty folder Codex made around the worktree and branch only when every check passes, and retains each target a check or a refusal holds back, with its reason.
//
// In-process cases run `main` with a fake `run` that answers only the command's own argument vectors over small
// temporary trees; the runner proofs start real processes, and the CLI proofs run the command against real git.
//
// Recurring cost: small in-process native-observation cases, representative real-Git CLI fixtures, one live
// Unix listener each on Linux and macOS and two short child Node processes carrying no_new_privs. No daemon, image or
// network service is started. Remove with the cleanup boundary.

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { delimiter, dirname, join, parse, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runCommand } from './closeout-cleanup.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { main } from '../closeout-cleanup.mjs';

const USAGE = 'usage: node scripts/closeout-cleanup.mjs <issue> [--pr <canonical HTTPS GitHub PR URL>] [--scratch <absolute path>]... [--regenerated <worktree-relative path>]...';
const GIT = { command: 'git', env: { GIT_TERMINAL_PROMPT: '0' } };
const HEAD = '1'.repeat(40);
const MERGE = '2'.repeat(40);
const MAIN = '3'.repeat(40);
const PR_URL = 'https://github.com/example/workflow/pull/42';
const NOT_MERGED = "error: the branch 'job/23' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D job/23'\nhint: Disable this message with \"git config set advice.forceDeleteBranch false\"\n";
const PR_FIELDS = 'state,mergedAt,mergeCommit,headRefName,headRefOid,isCrossRepository,baseRefName,url';
const mergedPr = () => ({ state: 'MERGED', mergedAt: '2026-10-18T10:00:00Z', mergeCommit: { oid: MERGE },
  headRefName: 'job/23', headRefOid: HEAD, isCrossRepository: false, baseRefName: 'main', url: PR_URL });
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
// The process status names real user 4242 apart from its effective, saved and filesystem users, so a route taking
// any other user fails.
const PROCESS_STATUS = 'Name:\tnode\nUid:\t4242\t4343\t4444\t4545\nGid:\t4242\t4242\t4242\t4242\nNoNewPrivs:\t0\nSeccomp:\t0\n';
const NO_NEW_PRIVS_STATUS = PROCESS_STATUS.replace('NoNewPrivs:\t0', 'NoNewPrivs:\t1');
// A /proc/self/mountinfo line as proc(5) writes it: ids, device and root, the mount point, its options, the optional
// fields up to the lone `-`, then the file system type, source and super options. A space in the mount point is `\040`.
const mountinfoLine = (mountPoint, optional = []) =>
  ['36 35 98:0 /mnt1', mountPoint, 'rw,noatime', ...optional, '- ext3 /dev/root rw,errors=continue'].join(' ');
const mountinfo = (...lines) => reply(0, `${lines.join('\n')}\n`);
const ROOT_MOUNT = mountinfoLine('/', ['shared:1']);
const ROUTE_PREFIX = ['--user', '--pipe', '--wait', '--quiet', '--collect', '--no-ask-password',
  '--service-type=oneshot', '--setenv=LC_ALL=C', '--', '/usr/bin/sudo'];
const NO_NEW_PRIVS_CAUSE = 'no_new_privs blocks sudo in this process and the user service manager route did not complete';

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
// `tracked` lists each worktree's tracked paths, `lsof.open` the files processes hold and `processes` the ps rows;
// `processStatus` is the status of this process (no no_new_privs flag unless set), `mountinfo` the mount table (only
// the root mount unless set) and `privileged` answers both the
// direct sudo and the user service manager route. `host` is the endpoint docker selects, PROOF_HOST unless set, and
// `desktop` holds the replies to the macOS observations: `id`, `stat` and the daemon's `version`.
function scenario(t, worktreeParts = ['wt']) {
  const capturedPath = { ...process.env }.PATH;
  const nativeEnv = { ...(capturedPath === undefined ? {} : { PATH: capturedPath }), LC_ALL: 'C' };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mainDir = join(root, 'main');
  const worktree = join(root, ...worktreeParts);
  mkdirSync(mainDir);
  mkdirSync(worktree, { recursive: true });
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
  const privilegedAnswer = (sudoArgs) => {
    assert.deepEqual(sudoArgs.slice(0, 6), SUDO_PREFIX);
    const binary = sudoArgs[6];
    assert.ok(['/usr/bin/ss', '/usr/bin/stat'].includes(binary));
    const operands = sudoArgs.slice(7);
    if (binary === '/usr/bin/ss') assert.deepEqual(operands, PROOF_VECTORS.ss);
    else assert.ok([DAEMON_PROC_VECTOR, SYSTEMD_PROC_VECTOR, SYSTEMD_PROC_VECTOR.with(4, '/proc/1/fd/10')].some((vector) => JSON.stringify(vector) === JSON.stringify(operands)));
    const result = state.privileged?.[binary === '/usr/bin/ss' ? 'ss' : 'stat'] ?? { absent: true };
    return typeof result === 'function' ? result(operands) : result;
  };
  const answer = (name, args, options) => {
    const key = args.join(' ');
    if (name === 'git') {
      if (state.pr && key === 'branch -d job/23') assert.deepEqual(options.env, { ...GIT.env, LC_ALL: 'C' });
      else assert.equal(options.env, GIT.env, `git ran without the seam's environment: ${key}`);
      if (state.pr) {
        if (key === 'remote get-url origin') return state.origin ?? reply(0, 'https://github.com/example/workflow.git\n');
        if (key === 'rev-parse --verify --quiet refs/remotes/origin/main') return state.main ?? reply(0, `${MAIN}\n`);
        if (key === `merge-base --is-ancestor ${MERGE} ${MAIN}`) return state.ancestor ?? reply(0);
        if (key === 'rev-parse --verify refs/heads/job/23') return state.tip?.() ?? reply(0, `${HEAD}\n`);
        if (key === 'branch -D -- job/23') {
          if (state.force) return state.force;
          state.branch = false;
          return reply(0);
        }
      }
      if (key === 'worktree list --porcelain -z') return state.worktreeList ?? reply(0, worktreeListing(state.records));
      if (key === 'rev-parse --verify --quiet refs/heads/job/23') return state.branch ? reply(0, `${HEAD}\n`) : reply(1);
      if (key === `-C ${worktree} status --porcelain -z --untracked-files=normal --ignored=matching`) {
        state.onStatus?.();
        return reply(0, state.status);
      }
      if (key === `-C ${worktree} ls-files -v -z`) {
        assert.deepEqual(args, ['-C', worktree, 'ls-files', '-v', '-z']);
        state.onIndex?.();
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
        if (state.deletion) return state.deletion;
        if (state.branchRefusal) return reply(1, '', state.branchRefusal);
        state.branch = false;
        return reply(0, 'Deleted branch job/23 (was 1111111).\n');
      }
    }
    if (name === 'gh' && state.pr) {
      assert.deepEqual(args, ['pr', 'view', '42', '--repo', 'github.com/example/workflow', '--json', PR_FIELDS]);
      assert.equal(options.env.GH_PROMPT_DISABLED, '1');
      return typeof state.pr === 'function' ? state.pr() : state.pr;
    }
    if (name === 'docker') {
      assert.equal(options.env.DOCKER_HOST, undefined);
      assert.equal(options.env.DOCKER_CONTEXT, undefined);
      if (key === 'context inspect --format {{json .Endpoints.docker}}') {
        if (!state.docker) return { absent: true };
        return typeof state.metadata === 'function' ? state.metadata() : state.metadata ?? reply(0, JSON.stringify({ Host: state.host ?? PROOF_HOST }));
      }
      assert.deepEqual(args.slice(0, 2), ['--host', state.host ?? PROOF_HOST]);
      if (state.desktop && args[2] === 'version') {
        assert.deepEqual(args.slice(3), ['--format', '{{json .Server.Platform.Name}}']);
        return state.desktop.version;
      }
      const result = dockerAnswer(state.docker, args.slice(2));
      state.onDocker?.(args.slice(2));
      return result;
    }
    if (name === 'systemd-run') {
      assert.deepEqual(options.env, { ...nativeEnv, XDG_RUNTIME_DIR: '/run/user/4242' });
      assert.deepEqual(args.slice(0, ROUTE_PREFIX.length), ROUTE_PREFIX);
      return privilegedAnswer(args.slice(ROUTE_PREFIX.length));
    }
    if (name === 'cat') {
      assert.deepEqual(options.env, nativeEnv);
      if (key === '/proc/self/mountinfo') return state.mountinfo ?? mountinfo(ROOT_MOUNT);
      assert.deepEqual(args, ['/proc/self/status']);
      return state.processStatus ?? reply(0, PROCESS_STATUS);
    }
    if (state.desktop && (name === 'id' || name === 'stat')) {
      assert.deepEqual(options.env, nativeEnv);
      const docker = join(root, '.docker');
      assert.deepEqual(args, name === 'id' ? ['-u']
        : ['-f', '%HT:%u:%d:%i', '--', docker, join(docker, 'run'), join(docker, 'run', 'docker.sock')]);
      const result = state.desktop[name];
      return typeof result === 'function' ? result() : result;
    }
    if (name === 'sudo' || name in PROOF_VECTORS) {
      assert.deepEqual(options.env, nativeEnv);
      if (name === 'sudo') return privilegedAnswer(args);
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
      output, run, platform: 'linux', cwd: mainDir, home: root, codexHome: '', pid: process.pid,
      scriptPath: join(mainDir, 'scripts', 'closeout-cleanup.mjs'), git: GIT, ...seams,
    }));
    return { exitCode, out, err };
  };
  return { root, mainDir, worktree, state, calls, executions, unexpected, run, cleanup };
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
  if (args.length === 5 && args.slice(0, 4).join(' ') === 'volume inspect --format {{json .}}') {
    return docker.volumes?.[args[4]] ?? reply(1, '', `Error response from daemon: get ${args[4]}: no such volume\n`);
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
const volumeMount = (name) => ({
  Type: 'volume', Name: name, Source: `/var/lib/docker/volumes/${name}/_data`, Destination: '/data', Driver: 'local', Mode: 'z', RW: true, Propagation: '',
});
// docker volume inspect's reply for a named volume: the keys it prints, Options as given.
const volumeInspect = (name, Options, Driver = 'local') => reply(0, `${JSON.stringify({
  CreatedAt: '2026-10-14T10:00:00Z', Driver, Labels: null, Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Name: name, Options, Scope: 'local',
})}\n`);
const bindOptions = (device, o = 'bind') => ({ type: 'none', o, device });
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
    [], ['0'], ['023'], ['abc'], ['eng-1'], ['ENG-0'], ['23', '24'], ['23', '--force'], ['23', '--scratch'],
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

test('a Linear issue ID is accepted as the issue and names the job/<ID> branch', async (t) => {
  const s = scenario(t);
  const calls = [];
  const run = (command, args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'worktree list --porcelain -z') return reply(0, worktreeListing([{ path: s.mainDir, branch: 'refs/heads/main' }]));
    if (key === 'rev-parse --verify --quiet refs/heads/job/ENG-1') return reply(1);
    return reply(99);
  };
  assert.deepEqual(await s.cleanup(['ENG-1'], { run }), {
    exitCode: 3,
    out: ['absent worktree job/ENG-1', 'absent branch job/ENG-1', 'closeout-cleanup: nothing to do'],
    err: [],
  });
  assert.deepEqual(calls, ['worktree list --porcelain -z', 'rev-parse --verify --quiet refs/heads/job/ENG-1']);
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
  .filter(([name, flag, host, first]) => name === 'docker' && flag === '--host' && host === (s.state.host ?? PROOF_HOST) && first === verb)
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

test('ANTI-REGRESSION: a running container bound above the worktree retains it and the branch and is not stopped', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, record] of [
    ['running', (s) => containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })],
    ['State: {}', (s) => ({ ...containerRecord(ID_A, { mounts: [bindMount(s.root)] }), State: {} })],
    ['bound above and at worktree/data', (s) => containerRecord(ID_A, {
      running: true, mounts: [bindMount(s.root), bindMount(join(s.worktree, 'data'))],
    })],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.docker.containers = [record(s)];
      assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
      assertWorktreeNotRemoved(s);
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    });
  }
});

test('a stopped container bound above the worktree, or a running one only naming it, leaves the worktree removable', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, record] of [
    ['stopped, bound at s.root', (s) => containerRecord(ID_A, { mounts: [bindMount(s.root)] })],
    ['running, with label proof.output set to the worktree', (s) => ({
      ...containerRecord(ID_A, { running: true }), Config: { Labels: { 'proof.output': s.worktree }, WorkingDir: '' },
    })],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.docker.containers = [record(s)];
      assert.deepEqual(await s.cleanup(), {
        exitCode: 0,
        out: [`removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
        err: [],
      });
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('a bind source in a symlink loop retains the worktree and reports the container', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  symlinkSync('loop', join(s.root, 'loop'));
  s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(join(s.root, 'loop', 'x'))] })];
  assert.deepEqual(await s.cleanup(), {
    exitCode: 4,
    out: [
      'retained container aaaaaaaaaaaa: a bind source could not be resolved: ELOOP',
      `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved: ELOOP`,
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
        `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved: not a normalized absolute path`,
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
  const mounts = ['volume', 'tmpfs', 'npipe', 'cluster', 'image'].map((Type) => ({
    Type, Source: join(s.worktree, 'data'), ...(Type === 'volume' ? { Name: 'plain' } : {}),
  }));
  s.state.docker.volumes = { plain: volumeInspect('plain', {}) };
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
    if (listed === '!! .env') {
      mkdirSync(join(s.worktree, 'node_modules'));
      placeFile(join(s.worktree, '.env'));
    }
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
  mkdirSync(join(directory.worktree, 'node_modules'));
  directory.state.status = '!! node_modules/\0';
  assert.deepEqual(await directory.cleanup(['23', '--regenerated', 'node_modules']), {
    exitCode: 0,
    out: [`removed worktree ${directory.worktree}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(directory.unexpected, []);
  const file = scenario(t);
  placeFile(join(file.worktree, '.env'));
  file.state.status = '!! .env\0';
  assertWorktreeRetained(file, await file.cleanup(['23', '--regenerated', '.env']), 'git status lists "!! .env"');
});

test('ANTI-REGRESSION: unsafe ignored-link observations retain the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const name of ['absent', 'dangling', 'looping', 'inside target', 'symlink parent', 'unresolvable other checkout']) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const sentinel = placeFile(join(s.root, 'outside', 'sentinel'));
      let path = 'link';
      let reason;
      if (name === 'absent') reason = 'could not be read: ENOENT';
      else if (name === 'dangling') {
        symlinkSync(join(s.root, 'missing'), join(s.worktree, path));
        reason = 'could not resolve its target: ENOENT';
      } else if (name === 'looping') {
        symlinkSync('link', join(s.worktree, path));
        reason = 'could not resolve its target: ELOOP';
      } else if (name === 'inside target') {
        const inside = placeFile(join(s.worktree, 'inside'));
        symlinkSync(inside, join(s.worktree, path));
        reason = 'points inside its worktree';
      } else if (name === 'symlink parent') {
        symlinkSync(dirname(sentinel), join(s.worktree, 'alias'), 'dir');
        path = 'alias/link';
        symlinkSync(sentinel, join(s.worktree, path));
        reason = 'has a symbolic-link parent';
      } else {
        const other = join(s.root, 'other-checkout');
        symlinkSync('other-checkout', other, 'dir');
        s.state.records.push({ path: other, detached: '' });
        symlinkSync(sentinel, join(s.worktree, path));
        reason = `could not resolve another linked worktree ${other}: ELOOP`;
      }
      s.state.status = `!! ${path}\0`;
      assertWorktreeRetained(s, await s.cleanup(), `ignored entry ${path}: ${reason}`);
      assertWorktreeNotRemoved(s);
      assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
      if (name === 'inside target') assert.equal(readFileSync(join(s.worktree, 'inside'), 'utf8'), 'scratch\n');
    });
  }
});

test('ANTI-REGRESSION: changed ignored links retain the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const name of ['replaced leaf', 'retargeted intermediate alias']) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const first = placeFile(join(s.root, 'first', 'sentinel'));
      const second = placeFile(join(s.root, 'second', 'sentinel'));
      const alias = join(s.root, 'alias');
      const link = join(s.worktree, 'link');
      symlinkSync(dirname(first), alias, 'dir');
      symlinkSync(join(alias, 'sentinel'), link);
      s.state.status = '!! link\0';
      s.state.onIndex = () => {
        if (name === 'replaced leaf') {
          rmSync(link);
          writeFileSync(link, 'replacement\n');
        } else {
          rmSync(alias);
          symlinkSync(dirname(second), alias, 'dir');
        }
      };
      assertWorktreeRetained(s, await s.cleanup(), 'ignored link link: changed during the checks');
      assertWorktreeNotRemoved(s);
      assert.equal(readFileSync(first, 'utf8'), 'scratch\n');
      assert.equal(readFileSync(second, 'utf8'), 'scratch\n');
      if (name === 'replaced leaf') assert.equal(readFileSync(link, 'utf8'), 'replacement\n');
      else assert.equal(lstatSync(link).isSymbolicLink(), true);
    });
  }
});

test('ANTI-REGRESSION: an ignored real directory holding no file does not hold the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, directory] of [['empty', ['.claude', 'worklog']], ['only nested empty directories', ['.claude', 'worklog', 'deep', 'deeper']]]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      mkdirSync(join(s.worktree, ...directory), { recursive: true });
      s.state.status = '!! .claude/worklog/\0';
      assert.deepEqual(await s.cleanup(), {
        exitCode: 0, out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'], err: [],
      });
      assert.equal(existsSync(s.worktree), false);
      assert.equal(s.state.branch, false);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('ANTI-REGRESSION: a mount at or inside an ignored directory holding no file retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, mounted, made, optional] of [
    ['mount at the row', '.claude/worklog', '.claude/worklog', []],
    ['mount on a nested directory', '.claude/worklog/deep', '.claude/worklog/deep', ['shared:1']],
    ['mount path containing a space', '.claude/worklog/has\\040space', '.claude/worklog/has space', ['shared:2', 'master:1']],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      mkdirSync(join(s.worktree, made), { recursive: true });
      s.state.status = '!! .claude/worklog/\0';
      s.state.mountinfo = mountinfo(ROOT_MOUNT, mountinfoLine(join(s.worktree, mounted), optional));
      assertWorktreeRetained(s, await s.cleanup(), 'git status lists "!! .claude/worklog/"');
      assertWorktreeNotRemoved(s);
      assert.equal(lstatSync(join(s.worktree, made)).isDirectory(), true);
    });
  }
  await t.test('mount appearing during the checks', async (t) => {
    const s = scenario(t);
    const worklog = join(s.worktree, '.claude', 'worklog');
    mkdirSync(worklog, { recursive: true });
    s.state.status = '!! .claude/worklog/\0';
    s.state.onIndex = () => {
      s.state.mountinfo = mountinfo(ROOT_MOUNT, mountinfoLine(worklog));
    };
    assertWorktreeRetained(s, await s.cleanup(), 'ignored directory .claude/worklog: changed during the checks');
    assertWorktreeNotRemoved(s);
    assert.equal(lstatSync(worklog).isDirectory(), true);
  });
});

test('ANTI-REGRESSION: an unreadable mount table retains an ignored directory holding no file', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, table] of [
    ['cat exits nonzero', reply(1, '', 'cat: /proc/self/mountinfo: No such file or directory\n')],
    ['a line with no separator and too few fields', mountinfo(ROOT_MOUNT, '36 35 98:0 /mnt1 /mnt rw')],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const worklog = join(s.worktree, '.claude', 'worklog');
      mkdirSync(worklog, { recursive: true });
      s.state.status = '!! .claude/worklog/\0';
      s.state.mountinfo = table;
      assertWorktreeRetained(s, await s.cleanup(), 'could not read the mount table');
      assertWorktreeNotRemoved(s);
      assert.equal(lstatSync(worklog).isDirectory(), true);
    });
  }
});

test('an ignored directory holding no file ignores mounts elsewhere', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  mkdirSync(join(s.worktree, '.claude', 'worklog'), { recursive: true });
  mkdirSync(join(s.worktree, '.claude', 'worklog-other'));
  s.state.status = '!! .claude/worklog/\0';
  s.state.mountinfo = mountinfo(ROOT_MOUNT, mountinfoLine(s.root, ['shared:1']),
    mountinfoLine(join(s.worktree, '.claude', 'worklog-other')));
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0, out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'], err: [],
  });
  assert.equal(existsSync(s.worktree), false);
  assert.equal(s.state.branch, false);
  assert.deepEqual(s.unexpected, []);
});

test('ANTI-REGRESSION: an ignored directory that may hold content retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, row, place] of [
    ['file', '!! .claude/worklog/', (s) => ({ files: [placeFile(join(s.worktree, '.claude', 'worklog', 'job.md'))] })],
    ['nested file', '!! .claude/worklog/', (s) => ({ files: [placeFile(join(s.worktree, '.claude', 'worklog', 'deep', 'job.md'))] })],
    ['link to an outside folder', '!! .claude/worklog/', (s) => {
      const sentinel = placeFile(join(s.root, 'outside', 'sentinel'));
      const worklog = join(s.worktree, '.claude', 'worklog');
      mkdirSync(worklog, { recursive: true });
      symlinkSync(dirname(sentinel), join(worklog, 'link'), 'dir');
      return { files: [sentinel, join(worklog, 'link', 'sentinel')] };
    }],
    ['link to an outside folder holding no file', '!! .claude/worklog/', (s) => {
      const empty = join(s.root, 'outside-empty');
      mkdirSync(empty);
      const worklog = join(s.worktree, '.claude', 'worklog');
      mkdirSync(worklog, { recursive: true });
      symlinkSync(empty, join(worklog, 'link'), 'dir');
      return { directories: [empty] };
    }],
    ['symlink parent', '!! alias/empty/', (s) => {
      const sentinel = placeFile(join(s.root, 'outside', 'sentinel'));
      const empty = join(dirname(sentinel), 'empty');
      mkdirSync(empty);
      symlinkSync(dirname(sentinel), join(s.worktree, 'alias'), 'dir');
      return { files: [sentinel], directories: [empty] };
    }],
    ['traversal', '!! ../outside-empty/', (s) => {
      const empty = join(s.root, 'outside-empty');
      mkdirSync(empty);
      return { directories: [empty] };
    }],
    ['absent', '!! gone/', () => ({})],
    ['file at the path', '!! notes/', (s) => ({ files: [placeFile(join(s.worktree, 'notes'))] })],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const { files = [], directories = [] } = place(s);
      s.state.status = `${row}\0`;
      assertWorktreeRetained(s, await s.cleanup(), `git status lists "${row}"`);
      assertWorktreeNotRemoved(s);
      for (const file of files) assert.equal(readFileSync(file, 'utf8'), 'scratch\n');
      for (const directory of directories) assert.equal(lstatSync(directory).isDirectory(), true);
    });
  }
});

test('ANTI-REGRESSION: an ignored empty directory changed during the checks retains the worktree', { skip: SKIP_POSIX }, async (t) => {
  for (const name of ['file added', 'replaced']) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const worklog = join(s.worktree, '.claude', 'worklog');
      const late = join(worklog, 'late.md');
      const moved = join(s.root, 'moved-worklog');
      mkdirSync(worklog, { recursive: true });
      s.state.status = '!! .claude/worklog/\0';
      s.state.onIndex = () => {
        if (name === 'file added') placeFile(late);
        else {
          renameSync(worklog, moved);
          mkdirSync(worklog);
        }
      };
      assertWorktreeRetained(s, await s.cleanup(), 'ignored directory .claude/worklog: changed during the checks');
      assertWorktreeNotRemoved(s);
      if (name === 'file added') assert.equal(readFileSync(late, 'utf8'), 'scratch\n');
      else {
        assert.equal(lstatSync(moved).isDirectory(), true);
        assert.equal(lstatSync(worklog).isDirectory(), true);
      }
    });
  }
});

test('ANTI-REGRESSION: regenerated directory descendants preserve the directory-only boundary', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, directory, status] of [
    ['collapsed root', 'node_modules', '!! node_modules/\0'],
    ['file descendant', 'node_modules', '!! node_modules/.gitignore\0'],
    ['directory descendant', 'node_modules', '!! node_modules/left-pad/\0'],
    ['nested named root', 'build/cache', '!! build/cache/result\0'],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      placeFile(join(s.worktree, directory, 'sentinel'));
      s.state.status = status;
      assert.deepEqual(await s.cleanup(['23', '--regenerated', directory]), {
        exitCode: 0, out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'], err: [],
      });
      assert.equal(existsSync(s.worktree), false);
      assert.equal(s.state.branch, false);
      assert.deepEqual(s.unexpected, []);
    });
  }
  for (const name of ['sibling prefix', 'named file', 'forged file descendant', 'root symlink', 'intermediate symlink', 'missing root', 'looping parent']) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      let directory = 'node_modules';
      let status = '!! node_modules/child\0';
      let reason = 'regenerated path node_modules is not a real directory within the worktree';
      let sentinel;
      if (name === 'sibling prefix') {
        mkdirSync(join(s.worktree, directory));
        sentinel = placeFile(join(s.worktree, 'node_modules-other', 'child'));
        status = '!! node_modules/child\0!! node_modules-other/child\0';
        reason = 'git status lists "!! node_modules-other/child"';
      } else if (name === 'named file') {
        sentinel = placeFile(join(s.worktree, directory));
        status = '!! node_modules/\0';
      } else if (name === 'forged file descendant') {
        directory = '.env';
        sentinel = placeFile(join(s.worktree, directory));
        status = '!! .env/child\0';
        reason = 'regenerated path .env is not a real directory within the worktree';
      } else if (name === 'root symlink') {
        sentinel = placeFile(join(s.root, 'external', 'child'));
        symlinkSync(dirname(sentinel), join(s.worktree, directory), 'dir');
      } else if (name === 'intermediate symlink') {
        directory = 'alias/cache';
        sentinel = placeFile(join(s.worktree, 'real', 'cache', 'child'));
        symlinkSync('real', join(s.worktree, 'alias'), 'dir');
        status = '!! alias/cache/child\0';
        reason = 'regenerated path alias/cache is not a real directory within the worktree';
      } else if (name === 'missing root') {
        reason = 'could not verify regenerated directory node_modules: ENOENT';
      } else {
        directory = 'loop/cache';
        symlinkSync('loop', join(s.worktree, 'loop'), 'dir');
        status = '!! loop/cache/child\0';
        reason = 'could not verify regenerated directory loop/cache: ELOOP';
      }
      s.state.status = status;
      assertWorktreeRetained(s, await s.cleanup(['23', '--regenerated', directory]), reason);
      assertWorktreeNotRemoved(s);
      if (sentinel) assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
    });
  }
});

test('ANTI-REGRESSION: regenerated descendants reject unsafe status paths', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, status, reason] of [
    ['modified descendant', ' M node_modules/child\0', 'git status lists " M node_modules/child"'],
    ['untracked descendant', '?? node_modules/child\0', 'git status lists "?? node_modules/child"'],
    ['absolute path', '!! /node_modules/child\0', 'git status lists "!! /node_modules/child"'],
    ['traversal', '!! node_modules/../outside\0', 'git status lists "!! node_modules/../outside"'],
    ['repeated separators', '!! node_modules//child\0!! node_modules/child//\0', 'git status lists "!! node_modules//child", "!! node_modules/child//"'],
    ['control characters', '!! node_modules/a\nb\0', 'git status lists "!! node_modules/a\nb"'],
    ['missing terminal NUL', '!! node_modules/child', 'git status printed an unreadable entry'],
    ['malformed record', '!! node_modules/child\0invalid\0', 'git status printed an unreadable entry'],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const sentinel = placeFile(join(s.worktree, 'node_modules', 'child'));
      s.state.status = status;
      assertWorktreeRetained(s, await s.cleanup(['23', '--regenerated', 'node_modules']), reason);
      assertWorktreeNotRemoved(s);
      assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
    });
  }
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

test('ANTI-REGRESSION: merged PR cleanup authorizes the exact job branch', { skip: SKIP_POSIX }, async (t) => {
  // Released C-locale messages: git/git v2.42.0 and v2.43.0 builtin/branch.c;
  // v2.44.0 builtin/branch.c + advice.c; v2.50.1 advice.c.
  const releasedRefusals = [
    ['Git 2.42 two-line refusal', "error: The branch 'job/23' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D job/23'.\n"],
    ['Git 2.43 two-line refusal', "error: the branch 'job/23' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D job/23'\n"],
    ['Git 2.44 default advice', "error: the branch 'job/23' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D job/23'\nhint: Disable this message with \"git config advice.forceDeleteBranch false\"\n"],
    ['modern default advice with config set', NOT_MERGED],
    ['modern advice explicitly enabled', "error: the branch 'job/23' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D job/23'\n"],
    ['modern advice disabled', "error: the branch 'job/23' is not fully merged\n"],
  ];
  for (const [name, origin, absent, refusal = NOT_MERGED] of [
    ['HTTPS origin', 'https://github.com/example/workflow.git', false],
    ['scp SSH origin', 'git@github.com:example/workflow.git', false],
    ['SSH URL origin', 'ssh://git@github.com/example/workflow', false],
    ['absent worktree', 'https://github.com/example/workflow', true],
    ...releasedRefusals.map(([name, refusal]) => [name, 'https://github.com/example/workflow.git', false, refusal]),
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.pr = reply(0, JSON.stringify(mergedPr()));
      s.state.origin = reply(0, `${origin}\n`);
      s.state.branchRefusal = refusal;
      if (absent) s.state.records.pop();
      const result = await s.cleanup(['23', '--pr', PR_URL]);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(s.state.branch, false);
      assert.deepEqual(s.calls.filter(([name, command]) => name === 'git' && command === 'branch'), [
        ['git', 'branch', '-d', 'job/23'], ['git', 'branch', '-D', '--', 'job/23'],
      ]);
      assert.match(result.out.join('\n'), /verified merged PR exception/);
      assert.equal(result.out.at(-1), `closeout-cleanup: ${absent ? 1 : 2} removed, 0 retained`);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('ANTI-REGRESSION: merged PR cleanup rejects invalid proof', { skip: SKIP_POSIX }, async (t) => {
  const invalidUrls = [
    'http://github.com/example/workflow/pull/42', 'https://elsewhere.invalid/example/workflow/pull/42',
    'https://user@github.com/example/workflow/pull/42', 'https://user:secret@github.com/example/workflow/pull/42',
    'https://github.com:443/example/workflow/pull/42', `${PR_URL}?x=1`, `${PR_URL}#x`, `${PR_URL}/`,
    'https://github.com/example/workflow/pull/0', 'https://github.com/example/workflow/pull/042',
    'https://github.com/example/workflow/issues/42', 'https://github.com/example/../workflow/pull/42',
    'https://github.com/example/work%66low/pull/42', 'https://GITHUB.COM/example/workflow/pull/42',
  ];
  const invalidArgs = [
    ...invalidUrls.map((url) => ['23', '--pr', url]),
    ['23', '--pr'], ['23', '--pr', PR_URL, '--pr', PR_URL], ['--check', '/tmp', '--pr', PR_URL],
  ];
  for (const [index, args] of invalidArgs.entries()) {
    await t.test(`invalid PR argument ${index + 1}`, async (t) => {
      const s = scenario(t);
      assert.equal((await s.cleanup(args)).exitCode, 2);
      assert.deepEqual(s.calls, []);
      assert.equal(s.state.branch, true);
    });
  }
  const metadata = [
    ['missing URL', { url: undefined }], ['foreign URL', { url: 'https://github.com/other/repo/pull/42' }],
    ['open PR', { state: 'OPEN' }], ['cross repository', { isCrossRepository: true }],
    ['missing repository kind', { isCrossRepository: undefined }], ['wrong branch', { headRefName: 'job/24' }],
    ['wrong base', { baseRefName: 'develop' }], ['wrong head', { headRefOid: MAIN }],
    ['short head', { headRefOid: '1111111' }], ['nonstring head', { headRefOid: 111 }],
    ['missing merge commit', { mergeCommit: null }], ['short merge commit', { mergeCommit: { oid: '2222222' } }],
    ['nonstring merge commit', { mergeCommit: { oid: 222 } }], ['missing timestamp', { mergedAt: null }],
    ['unparseable timestamp', { mergedAt: 'not a date' }], ['invalid calendar timestamp', { mergedAt: '2026-02-30T10:00:00Z' }],
    ['nonstring state', { state: { MERGED: true } }], ['nonboolean repository kind', { isCrossRepository: 'false' }],
  ].map(([name, change]) => [name, (s) => { s.state.pr = reply(0, JSON.stringify({ ...mergedPr(), ...change })); }]);
  const cases = [
    ['absent opt-in', (s) => { s.args = ['23']; s.state.pr = null; }],
    ['wrong origin', (s) => { s.state.origin = reply(0, 'https://github.com/other/workflow.git\n'); }],
    ['unsupported origin', (s) => { s.state.origin = reply(0, 'file:///tmp/workflow\n'); }],
    ['blank origin', (s) => { s.state.origin = reply(0, '\n'); }],
    ['multiple origins', (s) => { s.state.origin = reply(0, 'https://github.com/example/workflow\nhttps://github.com/other/repo\n'); }],
    ['origin unavailable', (s) => { s.state.origin = reply(1); }],
    ['origin warning', (s) => { s.state.origin = reply(0, 'https://github.com/example/workflow\n', 'warning\n'); }],
    ['malformed JSON', (s) => { s.state.pr = reply(0, '{secret'); }],
    ['array metadata', (s) => { s.state.pr = reply(0, '[]'); }],
    ['null metadata', (s) => { s.state.pr = reply(0, 'null'); }],
    ['gh absent', (s) => { s.state.pr = { absent: true }; }],
    ['gh failure', (s) => { s.state.pr = reply(1, '', 'secret'); }],
    ['gh warning', (s) => { s.state.pr = reply(0, JSON.stringify(mergedPr()), 'secret'); }],
    ['missing main', (s) => { s.state.main = reply(1); }],
    ['malformed main', (s) => { s.state.main = reply(0, 'short\n'); }],
    ['nonancestor merge', (s) => { s.state.ancestor = reply(1); }],
    ['ancestry warning', (s) => { s.state.ancestor = reply(0, '', 'warning'); }],
    ['other deletion refusal', (s) => { s.state.branchRefusal = 'error: permission denied\n'; }],
    ['invented lowercase advice with final period', (s) => { s.state.branchRefusal = "error: the branch 'job/23' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D job/23'.\n"; }],
    ['invented period before hinted advice', (s) => { s.state.branchRefusal = "error: the branch 'job/23' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D job/23'\n"; }],
    ['extra deletion error', (s) => { s.state.branchRefusal = `${NOT_MERGED}error: another failure\n`; }],
    ['deletion output', (s) => { s.state.deletion = reply(1, 'unexpected', NOT_MERGED); }],
    ['initial tip mismatch', (s) => { s.state.tip = () => reply(0, `${MAIN}\n`); }],
    ['reread tip mismatch', (s) => { let reads = 0; s.state.tip = () => reply(0, `${++reads === 1 ? HEAD : MAIN}\n`); }],
    ['occupied branch', (s) => { s.state.pr = () => { s.state.records.push({ path: s.root, branch: 'refs/heads/job/23' }); return reply(0, JSON.stringify(mergedPr())); }; }],
    ['unreadable occupancy', (s) => { s.state.pr = () => { s.state.worktreeList = reply(0, 'unreadable'); return reply(0, JSON.stringify(mergedPr())); }; }],
    ['Docker proof changed', (s) => { s.state.pr = () => { s.state.native.stat = reply(1); return reply(0, JSON.stringify(mergedPr())); }; }],
    ['Docker failure', (s) => { s.state.metadata = reply(1); }],
    ['process retention', (s) => { s.state.processes.push({ pid: 999, ppid: 1, args: `server ${s.worktree}` }); }],
    ['scratch retention', (s) => { s.args.push('--scratch', s.sentinel); s.state.processes.push({ pid: 999, ppid: 1, args: `tail ${s.sentinel}` }); }],
    ['worktree retention', (s) => { s.state.removeRefusal = 'error: worktree is locked\n'; }],
    ['failed force', (s) => { s.state.force = reply(1); }, true],
    ['absence readback fails', (s) => { s.state.force = reply(0); }, true],
    ...metadata,
  ];
  for (const [name, configure, force = false] of cases) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      s.state.pr = reply(0, JSON.stringify(mergedPr()));
      s.state.branchRefusal = NOT_MERGED;
      s.args = ['23', '--pr', PR_URL];
      s.sentinel = placeFile(join(s.root, 'sentinel'));
      configure(s);
      const result = await s.cleanup(s.args);
      assert.equal(result.exitCode, 4, JSON.stringify(result));
      assert.match(result.out.join('\n'), /retained branch job\/23: \S/);
      assert.doesNotMatch(result.out.join('\n'), /secret/);
      assert.equal(s.calls.filter((call) => call.join(' ') === 'git branch -D -- job/23').length, force ? 1 : 0);
      assert.equal(s.state.branch, true);
      assert.equal(readFileSync(s.sentinel, 'utf8'), 'scratch\n');
      assert.deepEqual(s.unexpected, []);
    });
  }
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

test('ANTI-REGRESSION: a running container bound above the worktree retains inside scratch', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  const target = dirname(placeFile(join(s.worktree, '_site', 'page.md')));
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })];
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 4,
    out: [
      `retained scratch ${target}: container aaaaaaaaaaaa binds a parent folder of it`,
      `retained worktree ${s.worktree}: holds retained scratch ${target}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(target));
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

// ID_A, running, mounting each named volume of `volumes` (the replies docker volume inspect gives by name).
function mountVolumes(s, volumes, extra = {}) {
  s.state.docker.volumes = volumes;
  s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: Object.keys(volumes).map(volumeMount), ...extra })];
}

// The one container, the worktree and the branch are retained for an unresolved bind source, with nothing stopped or removed.
function assertUnresolvedSource(s, result, reason) {
  assert.deepEqual(result, {
    exitCode: 4,
    out: [
      `retained container aaaaaaaaaaaa: a bind source could not be resolved: ${reason}`,
      `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved: ${reason}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(s.worktree));
  assertWorktreeNotRemoved(s);
  assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
  assert.deepEqual(s.unexpected, []);
}

const NO_SUCH_VOLUME = 'Error response from daemon: get v: no such volume';
const missingVolume = reply(1, '', `${NO_SUCH_VOLUME}\n`);

test('a container mounting a named volume bound inside the worktree is stopped and removed before the worktree', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t);
  s.state.docker.volumes = {
    'a-site': volumeInspect('a-site', bindOptions(join(s.worktree, 'site'))),
    'b-work': volumeInspect('b-work', bindOptions(s.worktree, 'rw,rbind')),
    'c-data': volumeInspect('c-data', bindOptions(join(s.worktree, 'data'))),
  };
  s.state.docker.containers = [
    containerRecord(ID_A, { running: true, mounts: [volumeMount('a-site')] }),
    containerRecord(ID_B, { binds: ['b-work:/work:rw'] }),
    containerRecord(ID_C, { hostMounts: [{ Type: 'volume', Source: 'c-data', Target: '/data' }] }),
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

  const refused = scenario(t);
  const refusal = 'Error response from daemon: cannot stop container: permission denied';
  mountVolumes(refused, { 'a-site': volumeInspect('a-site', bindOptions(join(refused.worktree, 'site'))) });
  refused.state.docker.refuse = { stop: `${refusal}\n` };
  assert.deepEqual(await refused.cleanup(), {
    exitCode: 4,
    out: [
      `retained container aaaaaaaaaaaa: docker stop failed: ${refusal}`,
      `retained worktree ${refused.worktree}: container aaaaaaaaaaaa could not be removed`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(refused.worktree));
  assert.deepEqual(dockerCalls(refused, 'rm'), []);
  assert.deepEqual(refused.unexpected, []);
});

test('ANTI-REGRESSION: a running container mounting a named volume bound above the worktree retains it and is not stopped', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, volumes] of [
    ['bound at s.root', (s) => ({ above: volumeInspect('above', bindOptions(s.root)) })],
    ['bound at s.root and a second volume inside the worktree', (s) => ({
      above: volumeInspect('above', bindOptions(s.root)), inside: volumeInspect('inside', bindOptions(join(s.worktree, 'data'))),
    })],
  ]) {
    const s = scenario(t);
    mountVolumes(s, volumes(s));
    assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], [], name);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A], name);
  }
});

test('a named volume with no bind device or one outside the target changes no result', { skip: SKIP_POSIX }, async (t) => {
  for (const [index, volume] of [
    () => volumeInspect('v', null),
    () => volumeInspect('v', {}),
    () => volumeInspect('v', { type: 'tmpfs', device: 'tmpfs', o: 'size=100m,uid=1000' }),
    () => volumeInspect('v', { type: 'nfs', o: 'addr=192.168.1.1,rw', device: ':/path/to/dir' }),
    () => volumeInspect('v', { type: 'nfs', o: 'addr=bind.example.com,rw', device: ':/x' }),
    (s) => volumeInspect('v', { type: 'ext4', device: join(s.worktree, 'data') }),
    (s) => volumeInspect('v', bindOptions(s.mainDir)),
    () => volumeInspect('v', { type: 'x' }, 'acme'),
  ].entries()) {
    const s = scenario(t);
    mountVolumes(s, { v: volume(s) });
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
      err: [],
    }, `case ${index}`);
    assert.deepEqual(dockerCalls(s, 'volume'), [['docker', 'volume', 'inspect', '--format', '{{json .}}', 'v']], `case ${index}`);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], [], `case ${index}`);
    assert.deepEqual(s.unexpected, [], `case ${index}`);
  }
  // An anonymous volume has no source in HostConfig.Mounts; its generated name is read once from Mounts.
  const anonymous = scenario(t);
  mountVolumes(anonymous, { '0f3a': volumeInspect('0f3a', null) }, { hostMounts: [{ Type: 'volume', Target: '/data' }] });
  assert.deepEqual(await anonymous.cleanup(), {
    exitCode: 0,
    out: [...jobRemoved(anonymous), 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(dockerCalls(anonymous, 'volume'), [['docker', 'volume', 'inspect', '--format', '{{json .}}', '0f3a']]);
  assert.deepEqual([...dockerCalls(anonymous, 'stop'), ...dockerCalls(anonymous, 'rm')], []);
  assert.deepEqual(anonymous.unexpected, []);
  // A HostConfig.Mounts volume with an empty Source names no volume to read.
  const unnamed = scenario(t);
  unnamed.state.docker.containers = [
    containerRecord(ID_A, { running: true, hostMounts: [{ Type: 'volume', Source: '', Target: '/data' }] }),
  ];
  assert.deepEqual(await unnamed.cleanup(), {
    exitCode: 0,
    out: [...jobRemoved(unnamed), 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(dockerCalls(unnamed, 'volume'), []);
  assert.deepEqual([...dockerCalls(unnamed, 'stop'), ...dockerCalls(unnamed, 'rm')], []);
  assert.deepEqual(unnamed.unexpected, []);
});

test('ANTI-REGRESSION: a volume whose options cannot be read retains the worktree and names the reason', { skip: SKIP_POSIX }, async (t) => {
  const cannotRead = (why) => `volume v options could not be read: ${why}`;
  for (const [volume, reason] of [
    [() => missingVolume, cannotRead(NO_SUCH_VOLUME)],
    [() => ({ failed: 'ETIMEDOUT' }), cannotRead('failed: ETIMEDOUT')],
    [() => reply(0, 'nonsense\n'), cannotRead('docker printed no readable record')],
    [() => volumeInspect('other', {}), cannotRead('docker printed no readable record')],
    [() => volumeInspect('v', undefined), cannotRead('docker printed no readable record')],
    [() => volumeInspect('v', []), cannotRead('docker printed no readable record')],
    [() => volumeInspect('v', { o: 3, type: 'none', device: '/x' }), cannotRead('docker printed no readable record')],
    [() => reply(0, '3\n'), cannotRead('docker printed no readable record')],
    [() => reply(0, 'null\n'), cannotRead('docker printed no readable record')],
    [() => reply(0, `${JSON.stringify({ Name: 'v', Options: { type: 'x' } })}\n`), cannotRead('docker printed no readable record')],
    [() => volumeInspect('v', { type: 'x' }, ' '), cannotRead('docker printed no readable record')],
    [(s) => volumeInspect('v', bindOptions(join(s.worktree, 'site')), 'acme'), 'volume v uses driver acme, whose bind options cannot be trusted'],
  ]) {
    const s = scenario(t);
    mountVolumes(s, { v: volume(s) });
    assertUnresolvedSource(s, await s.cleanup(), reason);
  }
  // A readable volume bound inside the worktree does not let the container be stopped while another volume is unreadable.
  const mixed = scenario(t);
  mountVolumes(mixed, { ok: volumeInspect('ok', bindOptions(join(mixed.worktree, 'site'))), v: missingVolume });
  assertUnresolvedSource(mixed, await mixed.cleanup(), cannotRead(NO_SUCH_VOLUME));
  for (const [field, extra] of [
    ['a volume mount with no Name', { mounts: [{ Type: 'volume' }] }],
    ['an empty Name', { mounts: [volumeMount('')] }],
    ['a relative HostConfig.Binds name', { binds: ['relative/data:/x'] }],
    ['a HostConfig.Binds name spelling a flag', { binds: ['--format=x:/x'] }],
    ['a HostConfig.Mounts source spelling a flag', { hostMounts: [{ Type: 'volume', Source: '--flag', Target: '/data' }] }],
  ]) {
    const s = scenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { running: true, ...extra })];
    assertUnresolvedSource(s, await s.cleanup(), 'a volume name is unreadable');
    assert.deepEqual(dockerCalls(s, 'volume'), [], field);
  }
  for (const [field, record] of [
    ['a null entry of Mounts', containerRecord(ID_A, { running: true, mounts: [null] })],
    ['a non-string entry of HostConfig.Binds', containerRecord(ID_A, { running: true, binds: [3] })],
    ['a null entry of HostConfig.Mounts', containerRecord(ID_A, { running: true, hostMounts: [null] })],
    ['a Mounts that is not a list', { ...containerRecord(ID_A, { running: true }), Mounts: 'x' }],
  ]) {
    const s = scenario(t);
    s.state.docker.containers = [record];
    assertUnresolvedSource(s, await s.cleanup(), 'not a normalized absolute path');
    assert.deepEqual(dockerCalls(s, 'volume'), [], field);
  }
});

test('a bind device that is not a normalized absolute path retains the worktree with its reason', { skip: SKIP_POSIX }, async (t) => {
  for (const options of [bindOptions('relative/path'), bindOptions(3), { type: 'none', o: 'bind' }]) {
    const s = scenario(t);
    mountVolumes(s, { v: volumeInspect('v', options) });
    assertUnresolvedSource(s, await s.cleanup(), 'not a normalized absolute path');
  }
});

test('check mode gives the same finding as cleanup for a named volume', { skip: SKIP_POSIX }, async (t) => {
  const fixture = (volumes) => {
    const s = scenario(t);
    const target = dirname(placeFile(join(s.root, 'scratch', 'out', 'log.txt')));
    mountVolumes(s, volumes(target));
    return { s, target };
  };
  for (const device of [(target) => target, (target) => join(target, 'sub'), (target) => dirname(target)]) {
    const { s, target } = fixture((path) => ({ v: volumeInspect('v', bindOptions(device(path))) }));
    assert.deepEqual(await s.cleanup(['--check', target]), {
      exitCode: 4,
      out: [`in use path ${target}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)],
      err: [],
    });
    assertNothingChanged(s);
    assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'container aaaaaaaaaaaa binds it');
  }
  const cause = `volume v options could not be read: ${NO_SUCH_VOLUME}`;
  const reason = `container aaaaaaaaaaaa has a bind source that could not be resolved: ${cause}`;
  for (const volumes of [
    () => ({ v: missingVolume }),
    (target) => ({ ok: volumeInspect('ok', bindOptions(target)), v: missingVolume }),
  ]) {
    const { s, target } = fixture(volumes);
    assert.deepEqual(await s.cleanup(['--check', target]), {
      exitCode: 4,
      out: [`unverifiable path ${target}: ${reason}`, SUMMARY(0, 0, 0, 1)],
      err: [],
    });
    assertNothingChanged(s);
    assert.deepEqual(await s.cleanup(['--check', s.worktree]), {
      exitCode: 4,
      out: [`unverifiable path ${s.worktree}: ${reason}`, SUMMARY(0, 0, 0, 1)],
      err: [],
    });
    assertNothingChanged(s);
    assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
      exitCode: 4,
      out: [
        `retained container aaaaaaaaaaaa: a bind source could not be resolved: ${cause}`,
        `retained scratch ${target}: ${reason}`,
        `retained worktree ${s.worktree}: ${reason}`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 4 retained',
      ],
      err: [],
    });
    assert.ok(existsSync(target));
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.unexpected, []);
  }
  // A scratch folder inside the worktree gives the same finding, not the worktree's own container retention.
  const inside = scenario(t);
  const folder = dirname(placeFile(join(inside.worktree, 'out', 'log.txt')));
  mountVolumes(inside, { v: missingVolume });
  assert.deepEqual(await inside.cleanup(['--check', folder]), {
    exitCode: 4,
    out: [`unverifiable path ${folder}: ${reason}`, SUMMARY(0, 0, 0, 1)],
    err: [],
  });
  assertNothingChanged(inside);
  const scratch = await inside.cleanup(['23', '--scratch', folder]);
  assert.ok(scratch.out.includes(`retained scratch ${folder}: ${reason}`), scratch.out.join('\n'));
  assert.ok(existsSync(folder));
  assert.deepEqual([...dockerCalls(inside, 'stop'), ...dockerCalls(inside, 'rm')], []);
  assert.deepEqual(inside.unexpected, []);
  const { s, target } = fixture(() => ({ v: volumeInspect('v', null) }));
  assert.deepEqual(await s.cleanup(['--check', target]), { exitCode: 0, out: [`unused path ${target}`, SUMMARY(1, 0, 0, 0)], err: [] });
  assertNothingChanged(s);
  assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
    exitCode: 0,
    out: [`removed scratch ${target}`, ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(s.unexpected, []);
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
function cliFixture(t, docker, overrides = {}, worktreeParts = ['job-23']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  const worktree = join(root, ...worktreeParts);
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
  mkdirSync(dirname(worktree), { recursive: true });
  ok(git(['-C', repository, 'worktree', 'add', '-q', '-b', 'job/23', worktree]), 'job worktree');
  placeFile(join(worktree, 'node_modules', 'left-pad', 'index.js'));
  writeFileSync(join(worktree, 'node_modules', '.gitignore'), '*\n');
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
  const cleanup = (extraEnv = {}, extraArgs = []) => spawnSync(process.execPath, [CLI, '23', '--scratch', scratch, '--regenerated', 'node_modules', ...extraArgs], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, GIT_DIR: join(root, 'decoy', '.git'),
      FIXTURE_DOCKER_LOG: dockerLog, DOCKER_HOST: '', DOCKER_CONTEXT: '', DOCKER_CONFIG: join(root, 'docker-config'),
      CODEX_HOME: join(root, 'codex-home'), ...overrides, ...extraEnv },
  });
  const branchStatus = () => git(['-C', repository, 'rev-parse', '--verify', '--quiet', 'refs/heads/job/23']).status;
  const registered = () => git(['-C', repository, 'worktree', 'list', '--porcelain']).stdout.includes(`worktree ${worktree}\n`);
  const dockerCalls = () => readFileSync(dockerLog, 'utf8').trim().split('\n');
  return { repository, worktree, scratch, cleanup, branchStatus, registered, dockerCalls, git, bin };
}

test('ANTI-REGRESSION: merged PR cleanup crosses the CLI boundary', { skip: process.platform !== 'linux' && 'real Git fixture uses native Linux command fakes' }, async (t) => {
  for (const mismatch of [false, true]) {
    await t.test(mismatch ? 'mismatched head retains ref and sentinel' : 'squash head deletes only the authorized ref', (t) => {
      const f = cliFixture(t, DOCKER_EMPTY);
      const git = (...args) => {
        const result = f.git(['-C', f.repository, ...args]);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git('branch', '-M', 'main');
      writeFileSync(join(f.worktree, 'kept.txt'), 'delivered squash content\n');
      git('-C', f.worktree, 'add', '--', 'kept.txt');
      git('-C', f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'job changes');
      const head = git('rev-parse', 'refs/heads/job/23');
      git('merge', '--squash', 'job/23');
      git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'squash delivery');
      const merged = git('rev-parse', 'main');
      assert.equal(f.git(['-C', f.repository, 'merge-base', '--is-ancestor', head, merged]).status, 1);
      git('remote', 'add', 'origin', 'https://github.com/example/workflow.git');
      git('update-ref', 'refs/remotes/origin/main', merged);
      const ordinary = f.cleanup();
      assert.equal(ordinary.status, 4, ordinary.stdout + ordinary.stderr);
      assert.match(ordinary.stdout, /not fully merged/);
      assert.equal(f.branchStatus(), 0);
      assert.equal(f.registered(), false);
      const sentinel = placeFile(join(f.repository, 'sentinel'));
      // Only GitHub metadata is fake here; branch tips, ancestry and ordinary refusal come from real Git.
      const proof = { ...mergedPr(), headRefOid: mismatch ? merged : head, mergeCommit: { oid: merged } };
      writeFileSync(join(f.bin, 'gh'), `#!/bin/sh\n[ "$*" = 'pr view 42 --repo github.com/example/workflow --json ${PR_FIELDS}' ] || exit 97\n[ "$GH_PROMPT_DISABLED" = 1 ] || exit 98\nprintf '%s' '${JSON.stringify(proof)}'\n`, { mode: 0o755 });
      const result = f.cleanup({ GH_REPO: 'hostile/other', GH_HOST: 'elsewhere.invalid' }, ['--pr', PR_URL]);
      assert.equal(result.status, mismatch ? 4 : 0, result.stdout + result.stderr);
      assert.equal(f.branchStatus(), mismatch ? 0 : 1);
      assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
      if (mismatch) assert.equal(git('rev-parse', 'refs/heads/job/23'), head);
      else assert.match(result.stdout, /verified merged PR exception/);
      assert.equal(result.stderr, '');
    });
  }
});

test('the CLI removes an outside scratch file, the worktree with its regenerated directory and the branch through real git', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const status = f.git(['-C', f.worktree, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(status.stdout.split('\0').sort(), ['', '!! node_modules/.gitignore', '!! node_modules/left-pad/']);
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

test('the CLI retains a real worktree and branch while a process sits in it and removes them on a later run once it has gone', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const hold = join(f.bin, 'hold');
  writeFileSync(hold, '');
  writeFileSync(join(f.bin, 'lsof'), `#!/bin/sh\nif [ -e '${hold}' ] && [ "$*" = '-nP -Fpcfn -x f +D ${f.worktree}' ]; then\n  printf 'p4242\\ncbash\\nfcwd\\nn${f.worktree}\\n'\n  exit 0\nfi\n${LSOF_FAKE}`, { mode: 0o755 });
  const held = f.cleanup();
  assert.equal(held.status, 4, held.stdout + held.stderr);
  assert.equal(held.stderr, '');
  assert.ok(held.stdout.includes(`retained worktree ${f.worktree}: pid 4242 (bash) uses it`), held.stdout);
  assert.equal(f.registered(), true);
  assert.equal(f.branchStatus(), 0);
  rmSync(hold);
  const released = f.cleanup();
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.equal(released.stderr, '');
  assert.ok(released.stdout.includes(`absent scratch ${f.scratch}`), released.stdout);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.registered(), false);
  assert.equal(f.branchStatus(), 1);
});

test('ANTI-REGRESSION: ignored external links preserve targets during real Git cleanup', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const externalFile = placeFile(join(dirname(f.repository), 'external-file'));
  const externalDirectory = dirname(placeFile(join(dirname(f.repository), 'external-directory', 'sentinel')));
  const sharedInstall = dirname(placeFile(join(f.repository, 'shared-install', 'sentinel')));
  rmSync(join(f.worktree, 'node_modules'), { recursive: true });
  const links = [
    ['absolute-file', externalFile], ['relative-file', relative(f.worktree, externalFile)],
    ['absolute-directory', externalDirectory], ['relative-directory', relative(f.worktree, externalDirectory)],
    ['node_modules', sharedInstall],
  ];
  writeFileSync(join(f.repository, '.git', 'info', 'exclude'), links.map(([name]) => name).join('\n') + '\n');
  for (const [name, destination] of links) symlinkSync(destination, join(f.worktree, name));
  const status = f.git(['-C', f.worktree, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(status.stdout.split('\0').sort(), ['', ...links.map(([name]) => `!! ${name}`)].sort());
  const run = f.cleanup();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.registered(), false);
  assert.equal(f.branchStatus(), 1);
  for (const sentinel of [externalFile, join(externalDirectory, 'sentinel'), join(sharedInstall, 'sentinel')]) {
    assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
  }
});

test('ANTI-REGRESSION: ignored links into another worktree retain both worktrees', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const other = join(dirname(f.repository), 'other-job');
  const added = f.git(['-C', f.repository, 'worktree', 'add', '-q', '--detach', other]);
  assert.equal(added.status, 0, added.stderr);
  const sentinel = placeFile(join(other, 'sentinel'));
  const alias = join(dirname(f.repository), 'other-alias');
  symlinkSync(other, alias, 'dir');
  rmSync(join(f.worktree, 'node_modules'), { recursive: true });
  symlinkSync(alias, join(f.worktree, 'node_modules'), 'dir');
  writeFileSync(join(f.repository, '.git', 'info', 'exclude'), 'node_modules\n');
  const status = f.git(['-C', f.worktree, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '!! node_modules\0');
  const run = f.cleanup();
  assert.equal(run.status, 4, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(run.stdout.includes(`ignored entry node_modules: points into another linked worktree ${other}`), run.stdout);
  assert.equal(f.registered(), true);
  assert.equal(f.branchStatus(), 0);
  assert.equal(lstatSync(join(f.worktree, 'node_modules')).isSymbolicLink(), true);
  const listing = f.git(['-C', f.repository, 'worktree', 'list', '--porcelain']);
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes(`worktree ${other}\n`), listing.stdout);
  assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
});

test('ANTI-REGRESSION: the CLI retains ignored sibling prefixes of a regenerated directory', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  const sentinel = placeFile(join(f.worktree, 'node_modules-other', 'sentinel'));
  writeFileSync(join(f.worktree, 'node_modules-other', '.gitignore'), '*\n');
  const status = f.git(['-C', f.worktree, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(status.stdout.split('\0').sort(), [
    '', '!! node_modules-other/.gitignore', '!! node_modules-other/sentinel',
    '!! node_modules/.gitignore', '!! node_modules/left-pad/',
  ]);
  const run = f.cleanup();
  assert.equal(run.status, 4, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `removed scratch ${f.scratch}`,
    `retained worktree ${f.worktree}: git status lists "!! node_modules-other/.gitignore", "!! node_modules-other/sentinel"`,
    'retained branch job/23: its worktree is retained', 'closeout-cleanup: 1 removed, 2 retained', '',
  ].join('\n'));
  assert.equal(f.registered(), true);
  assert.equal(f.branchStatus(), 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'scratch\n');
  assert.equal(existsSync(f.scratch), false);
});

test('ANTI-REGRESSION: the CLI removes a real worktree whose ignored scratch folder the run emptied', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  writeFileSync(join(f.repository, '.git', 'info', 'exclude'), '.claude/*\n');
  const file = placeFile(join(f.worktree, '.claude', 'worklog', 'job.md'));
  const run = f.cleanup({}, ['--scratch', file]);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `removed scratch ${f.scratch}`, `removed scratch ${file}`, `removed worktree ${f.worktree}`, 'removed branch job/23',
    'closeout-cleanup: 4 removed, 0 retained', '',
  ].join('\n'));
  assert.equal(run.status, 0);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(f.registered(), false);
  assert.equal(f.branchStatus(), 1);
  assert.equal(existsSync(dirname(f.scratch)), true);
});

test('ANTI-REGRESSION: the CLI retains a real ignored folder holding anything else', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY);
  writeFileSync(join(f.repository, '.git', 'info', 'exclude'), '.claude/*\n');
  const file = placeFile(join(f.worktree, '.claude', 'worklog', 'job.md'));
  const other = placeFile(join(f.worktree, '.claude', 'worklog', 'other.md'));
  const run = f.cleanup({}, ['--scratch', file]);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `removed scratch ${f.scratch}`, `removed scratch ${file}`,
    `retained worktree ${f.worktree}: git status lists "!! .claude/worklog/"`,
    'retained branch job/23: its worktree is retained', 'closeout-cleanup: 2 removed, 2 retained', '',
  ].join('\n'));
  assert.equal(run.status, 4);
  assert.equal(f.registered(), true);
  assert.equal(f.branchStatus(), 0);
  assert.equal(readFileSync(other, 'utf8'), 'scratch\n');
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

// The same proof, with this process carrying no_new_privs, so the observations go through the user service manager.
function routedProof(s, owners = ACTIVATED_SS) {
  passwordlessProof(s, owners);
  s.state.processStatus = reply(0, NO_NEW_PRIVS_STATUS);
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
  for (const [name, mode, owners] of [
    ['native singleton', 'native', PROOF_SS], ['native activated', 'native', ACTIVATED_SS],
    ['privileged singleton', 'privileged', PROOF_SS], ['privileged activated', 'privileged', ACTIVATED_SS],
    ['routed singleton', 'routed', PROOF_SS], ['routed activated', 'routed', ACTIVATED_SS],
    ['reversed display order', 'privileged', ACTIVATED_SS.replace('("dockerd",pid=71,fd=3),("systemd",pid=1,fd=9)',
      '("systemd",pid=1,fd=9),("dockerd",pid=71,fd=3)')],
  ]) {
    await t.test(name, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      if (mode === 'privileged') passwordlessProof(s, owners);
      else if (mode === 'routed') routedProof(s, owners);
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
      if (mode === 'routed') {
        assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo'), []);
        assert.ok(s.executions.some(({ command }) => command === '/usr/bin/systemd-run'));
      }
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
  for (const change of ['remove systemd', 'change systemd descriptor', 'change systemd identity', 'one failed recheck', 'one failed routed recheck']) {
    await t.test(change, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      if (change === 'one failed routed recheck') routedProof(s);
      else passwordlessProof(s);
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
        if (change.startsWith('one failed')) s.state.privileged.ss = () => ++failedReads === 1 ? reply(1) : reply(0, ACTIVATED_SS);
      };
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.equal(result.exitCode, 4);
      const reason = {
        'one failed recheck': 'native identity changed or became unreadable: passwordless listener observation was unavailable',
        'one failed routed recheck': `native identity changed or became unreadable: passwordless listener observation was unavailable: ${NO_NEW_PRIVS_CAUSE}`,
      }[change] ?? 'native identity changed since initial observation';
      assert.deepEqual(result.out.filter((line) => line.startsWith('retained container ')), [
        `retained container aaaaaaaaaaaa: Docker filesystem relationship is unverifiable: ${reason}`,
      ]);
      assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
      assert.deepEqual(dockerCalls(s, 'rm'), []);
      assert.ok(existsSync(scratch));
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.equal(s.state.docker.containers[1].State.Running, true);
      if (change.startsWith('one failed')) assert.equal(failedReads, 1);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('ANTI-REGRESSION: Docker privilege fallback is bounded and never prompts', async (t) => {
  for (const trigger of ['native success', 'ownerless', 'ownerless under no_new_privs']) {
    await t.test(trigger, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      if (trigger === 'ownerless') passwordlessProof(s);
      if (trigger === 'ownerless under no_new_privs') routedProof(s);
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assert.equal(result.exitCode, 0, result.out.join('\n'));
      const sudo = s.executions.filter(({ command }) => command === '/usr/bin/sudo');
      const routes = s.executions.filter(({ command }) => command === '/usr/bin/systemd-run');
      const statuses = s.executions.filter(({ command }) => command === 'cat');
      if (trigger === 'native success') assert.deepEqual([...sudo, ...routes, ...statuses], []);
      else {
        assert.equal(statuses.length, 1);
        const routed = trigger !== 'ownerless';
        assert.deepEqual(routed ? sudo : routes, []);
        for (const { args } of routes) assert.deepEqual(args.slice(0, ROUTE_PREFIX.length), ROUTE_PREFIX);
        // What sudo was asked to run: directly, or after the route's own flags.
        const asked = routed ? routes.map(({ args }) => args.slice(ROUTE_PREFIX.length)) : sudo.map(({ args }) => args);
        assert.ok(asked.length > 0);
        assert.deepEqual(asked[0], [...SUDO_PREFIX, '/usr/bin/ss', ...PROOF_VECTORS.ss]);
        for (const args of asked) {
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
    for (const [mode, stage] of [['privileged', 'ss'], ['privileged', 'stat'], ['routed', 'ss'], ['routed', 'stat']]) {
      await t.test(`${mode} ${stage} ${name}`, async (t) => {
        const s = scenario(t);
        const scratch = proofTargets(s);
        if (mode === 'routed') routedProof(s);
        else passwordlessProof(s);
        s.state.privileged[stage] = stage === 'stat' && name === 'stderr' ? reply(0, DAEMON_PROC_STAT, 'fixture warning') : result;
        const observed = await s.cleanup(['23', '--scratch', scratch]);
        assertProofRetained(s, observed, scratch);
        const cause = mode === 'routed' ? `: ${NO_NEW_PRIVS_CAUSE}` : '';
        const reason = name === 'partial'
          ? stage === 'ss' ? 'listener ownership observation is missing, ambiguous or unsupported'
            : 'filesystem identity observation is unsupported or malformed'
          : stage === 'ss' ? `passwordless listener observation was unavailable${cause}`
            : `passwordless systemd filesystem identity observation was unavailable${cause}`;
        assert.equal(observed.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
        if (mode === 'routed') assert.deepEqual(s.executions.filter(({ command }) => command === '/usr/bin/sudo'), []);
      });
    }
  }
  const UNFINISHED = 'process privilege status observation command did not complete cleanly';
  const MALFORMED = 'process privilege status observation is unsupported or malformed';
  for (const [name, status, reason] of [
    ['absent', { absent: true }, UNFINISHED], ['failed', { failed: 'EACCES' }, UNFINISHED], ['nonzero', reply(1), UNFINISHED],
    ['stderr', reply(0, PROCESS_STATUS, 'fixture warning'), UNFINISHED],
    ['missing flag', reply(0, PROCESS_STATUS.replace('NoNewPrivs:\t0\n', '')), MALFORMED],
    ['unknown flag value', reply(0, PROCESS_STATUS.replace('NoNewPrivs:\t0', 'NoNewPrivs:\t2')), MALFORMED],
    ['duplicate flag', reply(0, PROCESS_STATUS + 'NoNewPrivs:\t1\n'), MALFORMED],
    ['missing user', reply(0, PROCESS_STATUS.replace('Uid:\t4242\t4343\t4444\t4545\n', '')), MALFORMED],
    ['noncanonical user', reply(0, PROCESS_STATUS.replace('Uid:\t4242', 'Uid:\t04242')), MALFORMED],
    ['truncated', reply(0, PROCESS_STATUS.slice(0, -1)), MALFORMED],
  ]) {
    await t.test(`process status ${name}`, async (t) => {
      const s = scenario(t);
      const scratch = proofTargets(s);
      passwordlessProof(s);
      s.state.processStatus = status;
      const result = await s.cleanup(['23', '--scratch', scratch]);
      assertProofRetained(s, result, scratch);
      assert.equal(result.out[0], `retained scratch ${scratch}: docker failed: Docker filesystem relationship is unverifiable: ${reason}`);
      assert.deepEqual(s.executions.filter(({ command }) => ['/usr/bin/sudo', '/usr/bin/systemd-run'].includes(command)), []);
    });
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

const nativeKey = (...argv) => JSON.stringify(argv);
const routedKey = (binary, operands) => nativeKey('/usr/bin/systemd-run', ...ROUTE_PREFIX, ...SUDO_PREFIX, binary, ...operands);
const ROUTED_SS = routedKey('/usr/bin/ss', PROOF_VECTORS.ss);
const ROUTED_STAT = routedKey('/usr/bin/stat', DAEMON_PROC_VECTOR);
// The child imports the command and answers every call from its reply table except a `cat` of its own process
// status, which runs for real so the kernel reports the flag; it prints what it saw as JSON.
const NO_NEW_PRIVS_CHILD = `
import { readFileSync } from 'node:fs';
const { target, replies, cli, lib } = JSON.parse(readFileSync(0, 'utf8'));
const { main } = await import(cli);
const { runCommand } = await import(lib);
const calls = [];
const unexpected = [];
const run = (command, args, options = {}) => {
  const key = JSON.stringify([command, ...args]);
  let result = key === JSON.stringify(['cat', '/proc/self/status']) ? runCommand(command, args, options) : replies[key];
  if (!result) {
    unexpected.push([command, ...args]);
    result = { status: 99, stdout: '', stderr: '' };
  }
  calls.push({ command, args, env: options.env, result });
  return result;
};
const out = [];
const exitCode = main(['--check', target], { run, output: { log: (line) => out.push(line), error: (line) => out.push(line) } });
process.stdout.write(JSON.stringify({ exitCode, out, calls, unexpected }));
`;

// `--check` of a fresh file in a child Node process that really carries no_new_privs, whose native listener shows no
// owner: { target, exitCode, out, calls, unexpected }, or undefined, after a skip, when no child can carry the flag.
function checkWithNoNewPrivs(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'closeout-cleanup-nnp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = placeFile(join(root, 'scratch.txt'));
  const replies = {
    [nativeKey('docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker}}')]: reply(0, JSON.stringify({ Host: PROOF_HOST })),
    [nativeKey('readlink', ...PROOF_VECTORS.readlink)]: PROOF_REPLIES.readlink,
    [nativeKey('sh', ...PROOF_VECTORS.sh)]: PROOF_REPLIES.sh,
    [nativeKey('ss', ...PROOF_VECTORS.ss)]: reply(0, OWNERLESS_SS),
    [nativeKey('stat', ...CALLER_VECTOR)]: reply(0, CALLER_STAT),
    [ROUTED_SS]: reply(0, PROOF_SS),
    [ROUTED_STAT]: reply(0, DAEMON_PROC_STAT),
    [nativeKey('docker', '--host', PROOF_HOST, 'container', 'ls', '--all', '--quiet', '--no-trunc')]: reply(0),
    [nativeKey('lsof', '-nP', '-Fpcfn', target)]: reply(1),
    [nativeKey('ps', '-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=')]: reply(0, '      1       0 /sbin/init\n'),
    ...overrides,
  };
  const request = {
    target, replies, cli: new URL('../closeout-cleanup.mjs', import.meta.url).href,
    lib: new URL('./closeout-cleanup.mjs', import.meta.url).href,
  };
  // The kernel hands the flag to every child, so a process that carries it needs no helper to pass it on.
  const carries = /^NoNewPrivs:\t1$/m.test(readFileSync('/proc/self/status', 'utf8'));
  const childArgs = ['--input-type=module', '-e', NO_NEW_PRIVS_CHILD];
  const child = spawnSync(carries ? process.execPath : 'setpriv', carries ? childArgs : ['--no-new-privs', process.execPath, ...childArgs], {
    input: JSON.stringify(request), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 60_000,
  });
  if (child.error?.code === 'ENOENT') {
    t.skip('setpriv is not installed and this process lacks no_new_privs');
    return undefined;
  }
  assert.equal(child.status, 0, child.stderr);
  return { target, ...JSON.parse(child.stdout) };
}

// The kernel's own status line is the oracle that the child carried the flag, and the route never reaches sudo directly.
function assertRealFlagRoute(observed) {
  const status = observed.calls.find(({ command }) => command === 'cat');
  assert.equal(status.result.status, 0);
  assert.match(status.result.stdout, /^NoNewPrivs:\t1$/m);
  assert.deepEqual(observed.calls.filter(({ command }) => command === '/usr/bin/sudo'), []);
  for (const { env } of observed.calls.filter(({ command }) => command === '/usr/bin/systemd-run')) {
    assert.deepEqual(env, { PATH: process.env.PATH, LC_ALL: 'C', XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` });
  }
  assert.deepEqual(observed.unexpected, []);
}

const routedCalls = (observed) => observed.calls
  .filter(({ command }) => command === '/usr/bin/systemd-run').map(({ command, args }) => nativeKey(command, ...args));

test('ANTI-REGRESSION: real no_new_privs routes privileged Docker observation through the user service manager and names the flag when refused',
  { skip: process.platform !== 'linux' && 'no_new_privs is a Linux process flag' }, async (t) => {
    await t.test('routed observation clears the path', (t) => {
      const observed = checkWithNoNewPrivs(t);
      if (!observed) return;
      assert.equal(observed.exitCode, 0, observed.out.join('\n'));
      assert.deepEqual(observed.out, [`unused path ${observed.target}`, SUMMARY(1, 0, 0, 0)]);
      assert.deepEqual(routedCalls(observed), [ROUTED_SS, ROUTED_STAT, ROUTED_SS, ROUTED_STAT]);
      assertRealFlagRoute(observed);
    });
    await t.test('refused route names no_new_privs', (t) => {
      const observed = checkWithNoNewPrivs(t, {
        [ROUTED_SS]: reply(1, '', 'Failed to connect to user scope bus via local transport: No such file or directory\n'),
      });
      if (!observed) return;
      assert.equal(observed.exitCode, 4);
      assert.deepEqual(observed.out, [
        `unverifiable path ${observed.target}: docker failed: Docker filesystem relationship is unverifiable: passwordless listener observation was unavailable: ${NO_NEW_PRIVS_CAUSE}`,
        SUMMARY(0, 0, 0, 1),
      ]);
      assert.deepEqual(routedCalls(observed), [ROUTED_SS]);
      assertRealFlagRoute(observed);
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

test('ANTI-REGRESSION: the CLI retains a real worktree and branch under a running container bound above it and does not stop it', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, `${DOCKER_LOCAL}${REMOTE_DOCKER.slice(REMOTE_DOCKER.indexOf('case "$*"'))}`);
  const record = containerRecord('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
    running: true, mounts: [bindMount(dirname(f.worktree))],
  });
  const result = f.cleanup({ FIXTURE_RECORD: JSON.stringify(record) });
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    `retained scratch ${f.scratch}: container aaaaaaaaaaaa binds it`,
    `retained worktree ${f.worktree}: container aaaaaaaaaaaa binds a parent folder of it`,
    'retained branch job/23: its worktree is retained', 'closeout-cleanup: 0 removed, 3 retained', '',
  ].join('\n'));
  assert.equal(result.status, 4);
  assert.deepEqual(f.dockerCalls().filter((call) => / (?:stop|rm) /.test(call)), []);
  assert.ok(existsSync(f.worktree));
  assert.equal(f.registered(), true);
  assert.equal(f.branchStatus(), 0);
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

// Codex's desktop app puts a worktree at <root>/<name>/<repository> beside an empty marker in the outer <name> folder.
const CODEX_MARKER = '.codex-worktree-name';

function codexScenario(t, worktreeParts = ['.codex', 'worktrees', 'job-23', 'repository']) {
  const s = scenario(t, worktreeParts);
  const outer = dirname(s.worktree);
  const marker = join(outer, CODEX_MARKER);
  writeFileSync(marker, '');
  return { ...s, outer, marker };
}

// Runs `act` once, on the first process listing after the worktree is gone: the outer folder's own process check.
function afterWorktreeRemoved(s, act) {
  let done = false;
  s.state.onPs = () => {
    if (done || existsSync(s.worktree)) return;
    done = true;
    act();
  };
}

test('a removed Codex worktree takes its outer folder when only the empty marker is left', { skip: SKIP_POSIX }, async (t) => {
  const s = codexScenario(t);
  assert.deepEqual(await s.cleanup(), {
    exitCode: 0,
    out: [`removed worktree ${s.worktree}`, `removed outer folder ${s.outer}`, 'removed branch job/23', 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.equal(existsSync(s.outer), false);
  assert.ok(existsSync(join(s.root, '.codex', 'worktrees')));
  assert.deepEqual(s.unexpected, []);
});

test('the CLI removes a real Codex worktree and its outer folder from the root CODEX_HOME names', { skip: process.platform !== 'linux' && 'Docker-present CLI proof requires native Linux' }, (t) => {
  const f = cliFixture(t, DOCKER_EMPTY, {}, ['codex-home', 'worktrees', 'job-23', 'repository']);
  const outer = dirname(f.worktree);
  writeFileSync(join(outer, CODEX_MARKER), '');
  const codexHome = join(dirname(f.repository), 'codex-home');
  const run = f.cleanup({ CODEX_HOME: codexHome });
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, [
    `removed scratch ${f.scratch}`, `removed worktree ${f.worktree}`, `removed outer folder ${outer}`, 'removed branch job/23',
    'closeout-cleanup: 4 removed, 0 retained', '',
  ].join('\n'));
  assert.equal(run.status, 0);
  assert.equal(existsSync(outer), false);
  assert.ok(existsSync(join(codexHome, 'worktrees')));
  assert.equal(f.registered(), false);
  assert.equal(f.branchStatus(), 1);
});

test('ANTI-REGRESSION: a Codex outer folder holding anything but its empty marker is kept and reported', { skip: SKIP_POSIX }, async (t) => {
  const markerReason = `its ${CODEX_MARKER} is not an empty file`;
  const changed = 'it changed during the checks';
  const marked = (s) => assert.ok(existsSync(s.marker));
  const cases = [
    { name: 'a directory', reason: 'holds "other-repo"',
      place: (s) => mkdirSync(join(s.outer, 'other-repo')),
      check: (s) => assert.ok(lstatSync(join(s.outer, 'other-repo')).isDirectory()) },
    { name: 'two files', reason: 'holds "alpha.txt" and 1 more',
      place: (s) => { placeFile(join(s.outer, 'zeta.txt')); placeFile(join(s.outer, 'alpha.txt')); },
      check: (s) => { assert.ok(existsSync(join(s.outer, 'zeta.txt'))); assert.ok(existsSync(join(s.outer, 'alpha.txt'))); } },
    { name: 'a newline in a name', reason: 'holds "line\\nbreak"',
      place: (s) => placeFile(join(s.outer, 'line\nbreak')),
      check: (s) => assert.ok(existsSync(join(s.outer, 'line\nbreak'))) },
    { name: 'a marker holding text', reason: markerReason,
      place: (s) => writeFileSync(s.marker, 'x'),
      check: (s) => assert.equal(readFileSync(s.marker, 'utf8'), 'x') },
    { name: 'a marker that is a symbolic link', reason: markerReason,
      place: (s) => {
        const target = join(s.root, 'empty.txt');
        writeFileSync(target, '');
        rmSync(s.marker);
        symlinkSync(target, s.marker);
      },
      check: (s) => { assert.ok(lstatSync(s.marker).isSymbolicLink()); assert.ok(existsSync(join(s.root, 'empty.txt'))); } },
    { name: 'a marker that is an empty FIFO', reason: markerReason,
      place: (s) => {
        rmSync(s.marker);
        assert.equal(spawnSync('mkfifo', [s.marker]).status, 0);
      },
      check: (s) => assert.ok(lstatSync(s.marker).isFIFO()) },
    { name: 'a process using the folder', reason: 'pid 4242 (bash) uses it',
      place: (s) => { s.state.lsof.open = [{ pid: 4242, command: 'bash', name: s.outer }]; },
      check: marked },
    { name: 'the folder gone after the worktree is', reason: 'could not be read: ENOENT',
      place: (s) => { s.state.onWorktreeRemoved = () => rmSync(s.outer, { recursive: true }); },
      check: (s) => assert.equal(existsSync(s.outer), false) },
    { name: 'late: the folder renamed and its name linked to it', reason: changed,
      late: (s) => { renameSync(s.outer, join(s.root, 'elsewhere')); symlinkSync(join(s.root, 'elsewhere'), s.outer); },
      check: (s) => { assert.ok(existsSync(join(s.root, 'elsewhere', CODEX_MARKER))); assert.ok(lstatSync(s.outer).isSymbolicLink()); } },
    { name: 'late: the folder renamed and another made at its name', reason: changed,
      late: (s) => { renameSync(s.outer, join(s.root, 'elsewhere')); mkdirSync(s.outer); writeFileSync(s.marker, ''); },
      check: (s) => { assert.ok(existsSync(join(s.root, 'elsewhere', CODEX_MARKER))); marked(s); } },
    { name: 'late: text written into the marker', reason: markerReason,
      late: (s) => writeFileSync(s.marker, 'x'),
      check: (s) => assert.equal(readFileSync(s.marker, 'utf8'), 'x') },
    { name: 'late: another empty file renamed over the marker', reason: changed,
      late: (s) => { const next = join(s.outer, '.next'); writeFileSync(next, ''); renameSync(next, s.marker); },
      check: (s) => assert.equal(readFileSync(s.marker, 'utf8'), '') },
    { name: 'late: a file added', reason: 'holds "late.txt"',
      late: (s) => writeFileSync(join(s.outer, 'late.txt'), 'x'),
      check: (s) => { marked(s); assert.ok(existsSync(join(s.outer, 'late.txt'))); } },
  ];
  for (const { name, reason, place, late, check } of cases) {
    await t.test(name, async (t) => {
      const s = codexScenario(t);
      place?.(s);
      if (late) afterWorktreeRemoved(s, () => late(s));
      assert.deepEqual(await s.cleanup(), {
        exitCode: 4,
        out: [`removed worktree ${s.worktree}`, `retained outer folder ${s.outer}: ${reason}`, 'removed branch job/23', 'closeout-cleanup: 2 removed, 1 retained'],
        err: [],
      });
      check(s);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('a retained Codex worktree leaves its outer folder untouched', { skip: SKIP_POSIX }, async (t) => {
  const s = codexScenario(t);
  s.state.status = '?? notes.txt\0';
  assertWorktreeRetained(s, await s.cleanup(), 'git status lists "?? notes.txt"');
  assert.equal(readFileSync(s.marker, 'utf8'), '');
});

test('ANTI-REGRESSION: a parent folder outside the Codex worktree root is untouched, stray marker and all', { skip: SKIP_POSIX }, async (t) => {
  const s = scenario(t, ['.claude', 'worktrees', 'job-23']);
  const outer = dirname(s.worktree);
  const marker = join(outer, CODEX_MARKER);
  writeFileSync(marker, '');
  assert.deepEqual(await s.cleanup(['23']), {
    exitCode: 0,
    out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
    err: [],
  });
  assert.ok(existsSync(outer));
  assert.ok(existsSync(marker));
  assert.deepEqual(s.unexpected, []);
});

test('ANTI-REGRESSION: a failed Docker recheck keeps the Codex outer folder and the branch', { skip: SKIP_POSIX }, async (t) => {
  const reason = 'Docker filesystem relationship is unverifiable: native identity changed or became unreadable: daemon root differs from local root';
  for (const boundary of ['worktree removal', 'outer folder process check']) {
    await t.test(boundary, async (t) => {
      const s = codexScenario(t);
      const change = () => { s.state.native.stat = reply(0, PROOF_STAT.replace('50:2:', '50:3:')); };
      if (boundary === 'worktree removal') s.state.onWorktreeRemoved = change;
      else afterWorktreeRemoved(s, change);
      assert.deepEqual(await s.cleanup(), {
        exitCode: 4,
        out: [`removed worktree ${s.worktree}`, `retained outer folder ${s.outer}: ${reason}`, `retained branch job/23: ${reason}`, 'closeout-cleanup: 1 removed, 2 retained'],
        err: [],
      });
      assert.ok(existsSync(s.marker));
      assert.equal(s.state.branch, true);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('ANTI-REGRESSION: a kept Codex outer folder stops the merged PR branch exception', { skip: SKIP_POSIX }, async (t) => {
  const s = codexScenario(t);
  const notes = placeFile(join(s.outer, 'notes.txt'));
  s.state.pr = reply(0, JSON.stringify(mergedPr()));
  s.state.branchRefusal = NOT_MERGED;
  assert.deepEqual(await s.cleanup(['23', '--pr', PR_URL]), {
    exitCode: 4,
    out: [`removed worktree ${s.worktree}`, `retained outer folder ${s.outer}: holds "notes.txt"`,
      "retained branch job/23: error: the branch 'job/23' is not fully merged", 'closeout-cleanup: 1 removed, 2 retained'],
    err: [],
  });
  assert.ok(!s.calls.some((call) => call.join(' ') === 'git branch -D -- job/23'));
  assert.equal(s.state.branch, true);
  assert.equal(readFileSync(notes, 'utf8'), 'scratch\n');
  assert.deepEqual(s.unexpected, []);
});

// Codex's settings name the worktree root in the [desktop] table of the user-layer <CODEX_HOME>/config.toml; the scenario's
// CODEX_HOME is empty, so the file is <root>/.codex/config.toml.
const ROOT_KEY = 'git-worktree-root';

function codexConfig(s, text) {
  const path = join(s.root, '.codex', 'config.toml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const rootSetting = (value) => `[desktop]\n${ROOT_KEY} = ${value}\n`;
const CUSTOM_PARTS = ['custom', 'job-23', 'repository'];

// The cleanup output when the worktree, its outer folder and the branch are removed, and when only the worktree and the branch are.
const outerRemoved = (s) => ({
  exitCode: 0,
  out: [`removed worktree ${s.worktree}`, `removed outer folder ${s.outer}`, 'removed branch job/23', 'closeout-cleanup: 3 removed, 0 retained'],
  err: [],
});
const outerUntouched = (s) => ({ exitCode: 0, out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'], err: [] });

test("a Codex outer folder inside the worktree root Codex's settings name is removed", { skip: SKIP_POSIX }, async (t) => {
  const s = codexScenario(t, CUSTOM_PARTS);
  codexConfig(s, rootSetting(JSON.stringify(`  ${join(s.root, 'custom')}  `)));
  assert.deepEqual(await s.cleanup(), outerRemoved(s));
  assert.equal(existsSync(s.outer), false);
  assert.ok(existsSync(join(s.root, 'custom')));
  assert.deepEqual(s.unexpected, []);
});

test("ANTI-REGRESSION: with a worktree root in Codex's settings the default root no longer counts", { skip: SKIP_POSIX }, async (t) => {
  const s = codexScenario(t);
  codexConfig(s, rootSetting(JSON.stringify(`  ${join(s.root, 'custom')}  `)));
  assert.deepEqual(await s.cleanup(), outerUntouched(s));
  assert.ok(existsSync(s.marker));
  assert.deepEqual(s.unexpected, []);
});

test('ANTI-REGRESSION: an unusable Codex worktree root setting keeps the outer folder and says why, under the default root too', { skip: SKIP_POSIX }, async (t) => {
  const invalidToml = 'config.toml is not valid TOML';
  const notDesktopTable = 'desktop is not a table';
  const notAbsolute = 'its value is not a normalized absolute path';
  const custom = (s) => JSON.stringify(join(s.root, 'custom'));
  const cases = [
    { name: 'a table header left open', reason: invalidToml, place: (s) => codexConfig(s, '[desktop') },
    { name: 'a quoted value holding a raw 0xff byte', reason: invalidToml,
      place: (s) => codexConfig(s, Buffer.concat([Buffer.from(`[desktop]\n${ROOT_KEY} = "`), Buffer.from([0xff]), Buffer.from('"\n')])) },
    { name: 'desktop an integer', reason: notDesktopTable, place: (s) => codexConfig(s, 'desktop = 5\n') },
    { name: 'desktop an array of tables', reason: notDesktopTable, place: (s) => codexConfig(s, '[[desktop]]\n') },
    { name: 'desktop a date', reason: notDesktopTable, place: (s) => codexConfig(s, 'desktop = 1979-05-27\n') },
    { name: 'a root that is an integer', reason: 'its value is not a string', place: (s) => codexConfig(s, rootSetting('5')) },
    { name: 'a relative root', reason: notAbsolute, place: (s) => codexConfig(s, rootSetting(JSON.stringify('relative/wt'))) },
    { name: 'a root starting with a tilde', reason: notAbsolute, place: (s) => codexConfig(s, rootSetting(JSON.stringify('~/wt'))) },
    { name: 'a root that is not normalized', reason: notAbsolute, place: (s) => codexConfig(s, rootSetting(JSON.stringify(`${s.root}/x/../custom`))) },
    { name: 'a root holding a byte order mark escape', reason: notAbsolute, place: (s) => codexConfig(s, rootSetting('"\\uFEFF"')) },
    { name: 'a root that is a symbolic link to itself', reason: 'its value could not be resolved: ELOOP',
      place: (s) => {
        const loop = join(s.root, 'loop');
        symlinkSync(loop, loop);
        codexConfig(s, rootSetting(JSON.stringify(loop)));
      } },
    { name: 'config.toml a folder', reason: 'config.toml is not a regular file',
      place: (s) => mkdirSync(join(s.root, '.codex', 'config.toml'), { recursive: true }) },
    { name: 'config.toml a symbolic link to itself', reason: 'config.toml could not be read: ELOOP',
      place: (s) => {
        const path = join(s.root, '.codex', 'config.toml');
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(path, path);
      } },
    { name: 'config.toml a symbolic link to a missing file', reason: 'config.toml could not be read: ENOENT',
      place: (s) => {
        const path = join(s.root, '.codex', 'config.toml');
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(join(s.root, 'absent.toml'), path);
      } },
    { name: 'a parser path that is missing', reason: 'the TOML parser could not be loaded: MODULE_NOT_FOUND',
      place: (s) => codexConfig(s, rootSetting(custom(s))), seams: (s) => ({ tomlParserPath: join(s.root, 'missing.cjs') }) },
    { name: 'a parser file that throws', reason: 'the TOML parser could not be loaded: broken parser',
      place: (s) => {
        codexConfig(s, rootSetting(custom(s)));
        writeFileSync(join(s.root, 'broken.cjs'), "throw new Error('broken parser');\n");
      },
      seams: (s) => ({ tomlParserPath: join(s.root, 'broken.cjs') }) },
    { name: 'a CODEX_HOME that is not normalized', reason: 'CODEX_HOME is not a normalized absolute path', place: () => {},
      seams: (s) => ({ codexHome: `${s.root}/elsewhere/../.codex` }) },
    { name: 'a home folder that is not absolute while CODEX_HOME is empty', reason: 'the home folder is not a normalized absolute path', place: () => {},
      seams: () => ({ home: 'relative/home' }) },
    { name: 'a home folder that is not normalized while CODEX_HOME is empty', reason: 'the home folder is not a normalized absolute path', place: () => {},
      seams: (s) => ({ home: `${s.root}/x/..` }) },
    { name: 'a home folder ending in a slash while CODEX_HOME is empty', reason: 'the home folder is not a normalized absolute path', place: () => {},
      seams: (s) => ({ home: `${s.root}/` }) },
  ];
  for (const { name, reason, place, seams = () => ({}) } of cases) {
    for (const [placement, parts] of [['default placement', undefined], ['custom placement', CUSTOM_PARTS]]) {
      await t.test(`${name}, ${placement}`, async (t) => {
        const s = codexScenario(t, parts);
        place(s);
        assert.deepEqual(await s.cleanup(['23'], seams(s)), {
          exitCode: 4,
          out: [`removed worktree ${s.worktree}`, `retained outer folder ${s.outer}: Codex's worktree root setting is unusable: ${reason}`,
            'removed branch job/23', 'closeout-cleanup: 2 removed, 1 retained'],
          err: [],
        });
        assert.ok(existsSync(s.marker));
        assert.deepEqual(s.unexpected, []);
      });
    }
  }
});

test('ANTI-REGRESSION: a parent folder without the Codex marker is untouched with no line, even while the root setting is unusable', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, build] of [
    ['a Claude Code worktree under an invalid config.toml', (t) => {
      const s = scenario(t, ['.claude', 'worktrees', 'job-23']);
      codexConfig(s, '[desktop');
      return s;
    }],
    ['an unmarked folder inside the default Codex root', (t) => {
      const s = codexScenario(t);
      rmSync(s.marker);
      return s;
    }],
  ]) {
    await t.test(name, async (t) => {
      const s = build(t);
      assert.deepEqual(await s.cleanup(), outerUntouched(s));
      assert.ok(existsSync(dirname(s.worktree)));
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test("ANTI-REGRESSION: a worktree root in Codex's settings does not make a folder outside it removable", { skip: SKIP_POSIX }, async (t) => {
  for (const [name, parts] of [
    ['a folder beside the root', ['other', 'job-23', 'repository']],
    ['a folder two levels below the root', ['custom', 'job-23', 'deeper', 'repository']],
  ]) {
    await t.test(name, async (t) => {
      const s = codexScenario(t, parts);
      codexConfig(s, rootSetting(JSON.stringify(join(s.root, 'custom'))));
      assert.deepEqual(await s.cleanup(), outerUntouched(s));
      assert.ok(existsSync(s.outer));
      assert.ok(existsSync(s.marker));
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test("with no effective worktree root in Codex's settings the default root applies, a blank value included", { skip: SKIP_POSIX }, async (t) => {
  const cases = [
    { name: 'an empty file', config: '' },
    { name: 'a desktop table alone', config: '[desktop]\n' },
    { name: 'the key in another table', config: (s) => `[other]\n${ROOT_KEY} = ${JSON.stringify(join(s.root, 'custom'))}\n` },
    { name: 'an empty string root', config: rootSetting('""') },
    { name: 'a root of a space and a tab', config: rootSetting(JSON.stringify(' \t')) },
    { name: 'a root of a next line character escape', config: rootSetting('"\\u0085"') },
    { name: 'no file and a parser that could not load', seams: (s) => ({ tomlParserPath: join(s.root, 'missing.cjs') }) },
  ];
  for (const { name, config, seams = () => ({}) } of cases) {
    await t.test(name, async (t) => {
      const s = codexScenario(t);
      if (config !== undefined) codexConfig(s, typeof config === 'function' ? config(s) : config);
      assert.deepEqual(await s.cleanup(['23'], seams(s)), outerRemoved(s));
      assert.equal(existsSync(s.outer), false);
      assert.deepEqual(s.unexpected, []);
    });
  }
  await t.test('a blank root leaves a folder under a custom folder untouched', async (t) => {
    const s = codexScenario(t, CUSTOM_PARTS);
    codexConfig(s, rootSetting(JSON.stringify('  ')));
    assert.deepEqual(await s.cleanup(), outerUntouched(s));
    assert.ok(existsSync(s.marker));
    assert.deepEqual(s.unexpected, []);
  });
});

// BSD stat rows and daemon names as Docker Desktop 4.96.0 printed them on a Mac, and Docker's documented example name.
const DESKTOP_DOT_DOCKER = 'Directory:501:16777234:296204636';
const DESKTOP_RUN = 'Directory:501:16777234:296204694';
const DESKTOP_SOCKET = 'Socket:501:16777234:543703623';
const DESKTOP_STAT = `${DESKTOP_DOT_DOCKER}\n${DESKTOP_RUN}\n${DESKTOP_SOCKET}\n`;
const DESKTOP_NAME = '"Docker Desktop 4.96.0 (243774)"\n';
const DOCUMENTED_DESKTOP_NAME = '"Docker Desktop 4.49.0 (12345)"\n';
const cleanStopReply = (socket) => `failed to connect to the docker API at unix://${socket}; check if the path is correct and if the daemon is running: dial unix ${socket}: connect: no such file or directory`;
const staleSocketReply = (socket) => `Cannot connect to the Docker daemon at unix://${socket}. Is the docker daemon running?`;
const missingSocket = (s) => `stat: ${s.socket}: stat: No such file or directory\n`;
const desktopReason = (stage) => `Docker filesystem relationship is unverifiable: ${stage}`;
const stoppedStage = (line) => `Docker Desktop daemon did not answer: ${line}; no stopped container's binds can be read without it, so run this again once it answers`;
const STOPPED_ENDING = 'so run this again once it answers';

// The stopped reason found in the text, naming the reply whole or bounded at the 200 characters the command prints of
// a reply line: a clean stop's reply is always longer than that, and either form names it.
const stoppedReasonIn = (text, line) => desktopReason(
  [line, line.slice(0, 200)].map(stoppedStage).find((stage) => text.includes(stage)) ?? stoppedStage(line),
);

// A job on a Mac whose Docker Desktop answers at <root>/.docker/run/docker.sock, with one scratch file; the worktree
// stands at <root>/<worktreeParts>.
function desktopScenario(t, worktreeParts) {
  const s = scenario(t, worktreeParts);
  const socket = join(s.root, '.docker', 'run', 'docker.sock');
  s.state.host = `unix://${socket}`;
  s.state.desktop = { id: reply(0, '501\n'), stat: reply(0, DESKTOP_STAT), version: reply(0, DESKTOP_NAME) };
  return {
    ...s, socket, target: placeFile(join(s.root, 'scratch', 'proof.txt')),
    cleanup: (args, seams) => s.cleanup(args, { platform: 'darwin', ...seams }),
  };
}

// The observed replies of a cleanly stopped Desktop, whose socket file is gone; returns the daemon's reply line.
function stopDesktopCleanly(s) {
  s.state.desktop.stat = reply(1, `${DESKTOP_DOT_DOCKER}\n${DESKTOP_RUN}\n`, missingSocket(s));
  s.state.desktop.version = reply(1, '', `${cleanStopReply(s.socket)}\n`);
  return cleanStopReply(s.socket);
}

// The observed reply of a stopped Desktop that left its socket file behind; returns the daemon's reply line.
function leaveStaleSocket(s) {
  s.state.desktop.version = reply(1, '', `${staleSocketReply(s.socket)}\n`);
  return staleSocketReply(s.socket);
}

// Scratch, worktree and branch all retained for the reason, and the daemon asked for nothing but its version.
function assertEveryTargetRetained(s, result, reason) {
  assert.deepEqual(result, {
    exitCode: 4,
    out: [
      `retained scratch ${s.target}: docker failed: ${reason}`,
      `retained worktree ${s.worktree}: docker failed: ${reason}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(s.target));
  assert.ok(existsSync(s.worktree));
  assertWorktreeNotRemoved(s);
  assert.deepEqual(s.calls.filter(([name, flag, , first]) => name === 'docker' && flag === '--host' && first !== 'version'), []);
  assert.deepEqual(s.unexpected, []);
}

test('macOS Docker Desktop: a running daemon with no bound container removes the scratch, the worktree and the branch', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, version] of [['observed name', DESKTOP_NAME], ['documented name', DOCUMENTED_DESKTOP_NAME]]) {
    await t.test(name, async (t) => {
      const s = desktopScenario(t);
      s.state.desktop.version = reply(0, version);
      assert.deepEqual(await s.cleanup(['23', '--scratch', s.target]), {
        exitCode: 0,
        out: [`removed scratch ${s.target}`, `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 3 removed, 0 retained'],
        err: [],
      });
      assert.equal(existsSync(s.target), false);
      assert.equal(existsSync(s.worktree), false);
      assert.equal(s.state.branch, false);
      const observers = s.executions.filter(({ command }) => ['id', 'stat'].includes(parse(command).name));
      assert.deepEqual([...new Set(observers.map(({ command }) => command))].sort(), ['/usr/bin/id', '/usr/bin/stat']);
      assert.deepEqual(s.calls.filter(([command]) => ['ss', 'readlink', 'sudo', 'systemd-run', 'cat', 'sh'].includes(command)), []);
      assert.deepEqual(s.unexpected, []);
    });
  }
});

test('macOS Docker Desktop: containers bound in the worktree are stopped and removed first, or retain it with the reason', { skip: SKIP_POSIX }, async (t) => {
  await t.test('running gets stop then rm and stopped gets rm, before the worktree', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [
      containerRecord(ID_A, { running: true, mounts: [bindMount(join(s.worktree, 'site'))] }),
      containerRecord(ID_B, { mounts: [bindMount(s.worktree)] }),
    ];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: [
        'removed container aaaaaaaaaaaa', 'removed container bbbbbbbbbbbb',
        `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 4 removed, 0 retained',
      ],
      err: [],
    });
    assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
    assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A], ['docker', 'rm', ID_B]]);
    const steps = s.calls.flatMap(([name, ...args]) => {
      if (name === 'docker' && ['stop', 'rm'].includes(args[2])) return [args[2]];
      return name === 'git' && args[0] === 'worktree' && args[1] === 'remove' ? ['remove worktree'] : [];
    });
    assert.deepEqual(steps, ['stop', 'rm', 'rm', 'remove worktree']);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a refused stop retains the container, the worktree and the branch', async (t) => {
    const s = desktopScenario(t);
    const refusal = 'Error response from daemon: fixture refusal';
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
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
    assertWorktreeNotRemoved(s);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a running container bound above the worktree retains it and is not stopped', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.root)] })];
    assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  });
});

test('macOS Docker Desktop: an endpoint other than the local Desktop socket retains every target and makes no daemon call', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, host] of [
    ['TCP', () => 'tcp://127.0.0.1:2375'],
    ['SSH', () => 'ssh://fixture.invalid'],
    ['the system socket', () => 'unix:///var/run/docker.sock'],
    ['the cloud socket', (s) => `unix://${join(s.root, '.docker', 'cloud', 'docker-cloud.sock')}`],
    ['another home', () => 'unix:///Users/someone-else/.docker/run/docker.sock'],
    ['an unnormalized path', (s) => `unix://${s.root}/.docker/run/../run/docker.sock`],
  ]) {
    await t.test(name, async (t) => {
      const s = desktopScenario(t);
      s.state.host = host(s);
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      assertEveryTargetRetained(s, await s.cleanup(['23', '--scratch', s.target]), desktopReason('unsupported endpoint'));
      assert.deepEqual(s.calls.filter(([command, flag]) => ['id', 'stat'].includes(command) || (command === 'docker' && flag === '--host')), []);
    });
  }
});

test('macOS Docker Desktop: a socket or daemon that fails identification retains every target with its reason', { skip: SKIP_POSIX }, async (t) => {
  const caller = 'caller identity observation did not complete cleanly';
  const unclean = 'Docker Desktop socket observation did not complete cleanly';
  const malformed = 'Docker Desktop socket observation is unsupported or malformed';
  const notOwned = 'Docker Desktop socket is not a socket this user owns in real directories';
  const daemonMalformed = 'daemon identity observation is unsupported or malformed';
  const notDesktop = 'daemon does not report itself as Docker Desktop';
  const rows = (...lines) => reply(0, `${lines.join('\n')}\n`);
  const LINK_DOT_DOCKER = 'Symbolic Link:501:16777234:296204636';
  const LINK_RUN = 'Symbolic Link:501:16777234:296204694';
  const cases = [];
  for (const [name, result] of [
    ['absent', { absent: true }], ['failed', { failed: 'EACCES' }], ['nonzero', reply(1)],
    ['stderr', reply(0, '501\n', 'fixture warning')], ['malformed', reply(0, 'not-a-user\n')],
  ]) cases.push([`id ${name}`, (s) => { s.state.desktop.id = result; }, caller]);
  for (const [name, result] of [
    ['absent', { absent: true }], ['failed', { failed: 'EACCES' }], ['nonzero', reply(1)],
    ['stderr', reply(0, DESKTOP_STAT, 'fixture warning')],
  ]) cases.push([`stat ${name}`, (s) => { s.state.desktop.stat = result; }, unclean]);
  for (const [name, result] of [
    ['two rows', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN)],
    ['four rows', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, DESKTOP_SOCKET, DESKTOP_SOCKET)],
    ['a truncated listing', reply(0, DESKTOP_STAT.slice(0, -1))],
    ['a non-numeric owner', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Socket:abc:16777234:543703623')],
    ['a missing inode', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Socket:501:16777234:')],
  ]) cases.push([`stat ${name}`, (s) => { s.state.desktop.stat = result; }, malformed]);
  for (const [name, result] of [
    ['a link at .docker', rows(LINK_DOT_DOCKER, DESKTOP_RUN, DESKTOP_SOCKET)],
    ['a link at run', rows(DESKTOP_DOT_DOCKER, LINK_RUN, DESKTOP_SOCKET)],
    ['a link at the socket', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Symbolic Link:501:16777234:543703623')],
    ['a regular file at the socket', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Regular File:501:16777234:543703623')],
    ['a directory at the socket', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Directory:501:16777234:543703623')],
    ['another owner of .docker', rows('Directory:0:16777234:296204636', DESKTOP_RUN, DESKTOP_SOCKET)],
    ['another owner of run', rows(DESKTOP_DOT_DOCKER, 'Directory:0:16777234:296204694', DESKTOP_SOCKET)],
    ['another owner of the socket', rows(DESKTOP_DOT_DOCKER, DESKTOP_RUN, 'Socket:0:16777234:543703623')],
  ]) cases.push([`stat ${name}`, (s) => { s.state.desktop.stat = result; }, notOwned]);
  cases.push(['a different caller', (s) => { s.state.desktop.id = reply(0, '502\n'); }, notOwned]);
  // A missing socket settles nothing about a stopped daemon unless both directories above it are real and the caller's.
  for (const [name, listing, stage] of [
    ['a link at .docker', `${LINK_DOT_DOCKER}\n${DESKTOP_RUN}\n`, notOwned],
    ['a link at run', `${DESKTOP_DOT_DOCKER}\n${LINK_RUN}\n`, notOwned],
    ['a regular file at run', `${DESKTOP_DOT_DOCKER}\nRegular File:501:16777234:296204694\n`, notOwned],
    ['another owner of run', `${DESKTOP_DOT_DOCKER}\nDirectory:0:16777234:296204694\n`, notOwned],
    ['an unreadable row', `${DESKTOP_DOT_DOCKER}\nDirectory:abc:16777234:296204694\n`, malformed],
  ]) {
    cases.push([`missing socket under ${name}`, (s) => {
      stopDesktopCleanly(s);
      s.state.desktop.stat = reply(1, listing, missingSocket(s));
    }, stage]);
  }
  cases.push(['missing socket yet a daemon that answers', (s) => {
    s.state.desktop.stat = reply(1, `${DESKTOP_DOT_DOCKER}\n${DESKTOP_RUN}\n`, missingSocket(s));
    s.state.desktop.version = reply(0, DESKTOP_NAME);
  }, malformed]);
  cases.push(['an absent run directory', (s) => {
    stopDesktopCleanly(s);
    s.state.desktop.stat = reply(1, `${DESKTOP_DOT_DOCKER}\n`,
      `stat: ${dirname(s.socket)}: stat: No such file or directory\n${missingSocket(s)}`);
  }, malformed]);
  for (const [name, result] of [
    ['non-JSON', reply(0, 'Docker Desktop 4.96.0 (243774)\n')], ['null', reply(0, 'null\n')],
    ['a number', reply(0, '3\n')], ['two lines', reply(0, `${DESKTOP_NAME}${DESKTOP_NAME}`)],
    ['no final newline', reply(0, DESKTOP_NAME.slice(0, -1))], ['empty', reply(0)],
    ['stderr', reply(0, DESKTOP_NAME, 'fixture warning')],
  ]) cases.push([`version ${name}`, (s) => { s.state.desktop.version = result; }, daemonMalformed]);
  for (const name of ['Docker Engine - Community', 'Docker Desktop', 'Docker Desktopish 4.96.0']) {
    cases.push([`server named ${name}`, (s) => { s.state.desktop.version = reply(0, `${JSON.stringify(name)}\n`); }, notDesktop]);
  }
  for (const [name, result, line] of [
    ['absent', { absent: true }, 'not installed'], ['failed', { failed: 'EACCES' }, 'failed: EACCES'], ['silent nonzero', reply(1), 'exit status 1'],
  ]) cases.push([`version ${name}`, (s) => { s.state.desktop.version = result; }, stoppedStage(line)]);
  for (const [name, configure, stage] of cases) {
    await t.test(name, async (t) => {
      const s = desktopScenario(t);
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      configure(s);
      const result = await s.cleanup(['23', '--scratch', s.target]);
      assertEveryTargetRetained(s, result, desktopReason(stage));
      assert.doesNotMatch(result.out.join('\n'), /fixture warning/);
    });
  }
});

test('macOS Docker Desktop: a stopped daemon retains every target with its reason, a stopped bound container included', { skip: SKIP_POSIX }, async (t) => {
  for (const [name, stop] of [
    ['a clean stop, with no socket file', stopDesktopCleanly],
    ['a stale socket file that refuses', leaveStaleSocket],
    ['only the first line of a longer reply', (s) => {
      const line = leaveStaleSocket(s);
      s.state.desktop.version = reply(1, '', `${line}\nfixture second line\n`);
      return line;
    }],
  ]) {
    await t.test(name, async (t) => {
      const s = desktopScenario(t);
      s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(s.worktree)] })];
      const line = stop(s);
      const result = await s.cleanup(['23', '--scratch', s.target]);
      assertEveryTargetRetained(s, result, stoppedReasonIn(result.out[0] ?? '', line));
      assert.ok(result.out[0].endsWith(STOPPED_ENDING), result.out[0]);
      assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    });
  }
});

test('macOS Docker Desktop: a changed socket or a daemon that stops answering latches retention', { skip: SKIP_POSIX }, async (t) => {
  const changed = /^Docker filesystem relationship is unverifiable: native identity changed since initial observation$/;
  const unreadable = /^Docker filesystem relationship is unverifiable: native identity changed or became unreadable: ./;
  for (const [name, change, expected] of [
    ['a changed socket inode', (s) => { s.state.desktop.stat = reply(0, DESKTOP_STAT.replace(':543703623', ':543703624')); }, changed],
    ['a changed daemon name', (s) => { s.state.desktop.version = reply(0, '"Docker Desktop 4.97.0 (243775)"\n'); }, changed],
    ['a daemon that refuses, its socket file left behind', leaveStaleSocket, unreadable],
    ['a clean stop, its socket file gone', stopDesktopCleanly, unreadable],
  ]) {
    await t.test(name, async (t) => {
      const s = desktopScenario(t);
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
      s.state.onDocker = ([verb]) => { if (verb === 'stop') change(s); };
      const result = await s.cleanup(['23', '--scratch', s.target]);
      const reason = result.out[0]?.slice('retained container aaaaaaaaaaaa: '.length);
      assert.match(reason ?? '', expected, result.out.join('\n'));
      assert.deepEqual(result, {
        exitCode: 4,
        out: [
          `retained container aaaaaaaaaaaa: ${reason}`,
          `retained scratch ${s.target}: ${reason}`,
          `retained worktree ${s.worktree}: ${reason}`,
          'retained branch job/23: its worktree is retained',
          'closeout-cleanup: 0 removed, 4 retained',
        ],
        err: [],
      });
      assert.equal(dockerCalls(s, 'stop').length, 1);
      assert.deepEqual(dockerCalls(s, 'rm'), []);
      assert.ok(existsSync(s.target));
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.deepEqual(s.unexpected, []);
    });
  }
  await t.test('the first failed recheck stays latched', async (t) => {
    const s = desktopScenario(t);
    let observations = 0;
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
    s.state.onDocker = ([verb]) => {
      if (verb === 'stop') s.state.desktop.stat = () => (++observations === 1 ? reply(1, '', 'fixture warning') : reply(0, DESKTOP_STAT));
    };
    const reason = desktopReason('native identity changed or became unreadable: Docker Desktop socket observation did not complete cleanly');
    assert.deepEqual(await s.cleanup(['23', '--scratch', s.target]), {
      exitCode: 4,
      out: [
        `retained container aaaaaaaaaaaa: ${reason}`,
        `retained scratch ${s.target}: ${reason}`,
        `retained worktree ${s.worktree}: ${reason}`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 4 retained',
      ],
      err: [],
    });
    assert.equal(observations, 1);
    assert.deepEqual(dockerCalls(s, 'rm'), []);
    assertWorktreeNotRemoved(s);
    assert.deepEqual(s.unexpected, []);
  });
});

test("macOS Docker Desktop: check mode gives cleanup's answer for the same target", { skip: SKIP_POSIX }, async (t) => {
  await t.test('no container: unused, then removed', async (t) => {
    const s = desktopScenario(t);
    assert.deepEqual(await s.cleanup(['--check', s.target]), { exitCode: 0, out: [`unused path ${s.target}`, SUMMARY(1, 0, 0, 0)], err: [] });
    assert.ok(existsSync(s.target));
    assertNothingChanged(s);
    const { exitCode, out } = await s.cleanup(['23', '--scratch', s.target]);
    assert.equal(exitCode, 0);
    assert.equal(out[0], `removed scratch ${s.target}`);
    assert.equal(existsSync(s.target), false);
    assert.deepEqual(s.unexpected, []);
  });
  for (const [name, refuse] of [
    ['a remote endpoint', (s) => { s.state.host = 'tcp://127.0.0.1:2375'; return () => desktopReason('unsupported endpoint'); }],
    ['a cleanly stopped daemon', (s) => { const line = stopDesktopCleanly(s); return (text) => stoppedReasonIn(text, line); }],
    ['a stale socket file', (s) => { const line = leaveStaleSocket(s); return (text) => stoppedReasonIn(text, line); }],
  ]) {
    await t.test(`${name}: the identical reason`, async (t) => {
      const s = desktopScenario(t);
      const reasonIn = refuse(s);
      const checked = await s.cleanup(['--check', s.target]);
      const reason = reasonIn(checked.out[0] ?? '');
      assert.deepEqual(checked, { exitCode: 4, out: [`unverifiable path ${s.target}: docker failed: ${reason}`, SUMMARY(0, 0, 0, 1)], err: [] });
      assertNothingChanged(s);
      assertEveryTargetRetained(s, await s.cleanup(['23', '--scratch', s.target]), reason);
    });
  }
  await t.test('a bound container: in use, then stopped and removed', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(s.worktree)] })];
    assert.deepEqual(await s.cleanup(['--check', s.worktree]), {
      exitCode: 4, out: [`in use path ${s.worktree}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)], err: [],
    });
    assertNothingChanged(s);
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: ['removed container aaaaaaaaaaaa', `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual(dockerCalls(s, 'stop'), [['docker', 'stop', ID_A]]);
    assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
    assert.deepEqual(s.unexpected, []);
  });
});

test('macOS Docker Desktop: the real stat reads a socket and refuses a link in its place', { skip: process.platform !== 'darwin' && 'the observation is BSD stat on macOS' }, async (t) => {
  // Under /private/tmp, because a socket path under the macOS temporary folder can exceed the 104-byte limit.
  const base = realpathSync(mkdtempSync('/private/tmp/closeout-desktop-'));
  const runDirectory = (home) => join(home, '.docker', 'run');
  const realHome = join(base, 'real');
  const realSocket = join(runDirectory(realHome), 'docker.sock');
  mkdirSync(runDirectory(realHome), { recursive: true });
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(realSocket, resolve); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  });
  // Only the two observations reach the real system: the daemon, git and the in-use checks stay faked.
  const realObservations = (s) => (command, args, options) => (
    ['/usr/bin/id', '/usr/bin/stat'].includes(command) ? runCommand(command, args, options) : s.run(command, args, options));
  const invoke = async (t, home) => {
    const s = desktopScenario(t);
    s.state.host = `unix://${join(runDirectory(home), 'docker.sock')}`;
    s.state.desktop = { version: reply(0, DESKTOP_NAME) };
    return { s, result: await s.cleanup(['23', '--scratch', s.target], { home, run: realObservations(s) }) };
  };
  await t.test('a real socket proceeds', async (t) => {
    const { s, result } = await invoke(t, realHome);
    assert.deepEqual(result, {
      exitCode: 0,
      out: [`removed scratch ${s.target}`, `removed worktree ${s.worktree}`, 'removed branch job/23', 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a link at the socket is retained', async (t) => {
    const home = join(base, 'socket-link');
    mkdirSync(runDirectory(home), { recursive: true });
    symlinkSync(realSocket, join(runDirectory(home), 'docker.sock'));
    const { s, result } = await invoke(t, home);
    assertEveryTargetRetained(s, result, desktopReason('Docker Desktop socket is not a socket this user owns in real directories'));
  });
  await t.test('a link at the directory above it is retained', async (t) => {
    const home = join(base, 'directory-link');
    mkdirSync(join(home, '.docker'), { recursive: true });
    symlinkSync(runDirectory(realHome), runDirectory(home));
    const { s, result } = await invoke(t, home);
    assertEveryTargetRetained(s, result, desktopReason('Docker Desktop socket is not a socket this user owns in real directories'));
  });
  await t.test('a native observation receives only PATH and LC_ALL, never a redirection variable of the caller', async (t) => {
    const s = desktopScenario(t);
    const original = process.env.DYLD_INSERT_LIBRARIES;
    process.env.DYLD_INSERT_LIBRARIES = join(base, 'no-such-library.dylib');
    try {
      await s.cleanup(['23', '--scratch', s.target]);
    } finally {
      if (original === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = original;
    }
    const observers = s.executions.filter(({ command }) => ['/usr/bin/id', '/usr/bin/stat'].includes(command));
    assert.deepEqual([...new Set(observers.map(({ command }) => command))].sort(), ['/usr/bin/id', '/usr/bin/stat']);
    for (const { env } of observers) assert.deepEqual(env, { PATH: process.env.PATH, LC_ALL: 'C' });
  });
});

test('macOS Docker Desktop: a bind spelled under the VM mount prefix counts as its host path', { skip: SKIP_POSIX }, async (t) => {
  await t.test('a stopped container bound in the worktree gets rm alone, before the worktree and the branch', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(`/host_mnt${s.worktree}/site`)] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: ['removed container aaaaaaaaaaaa', ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual(dockerCalls(s, 'stop'), []);
    assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
    assert.equal(existsSync(s.worktree), false);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a running container bound above the worktree holds it and is not stopped', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(`/host_mnt${s.root}`)] })];
    assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  });
  await t.test('a running container bound at exactly the prefix counts as bound at the root and holds the worktree', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount('/host_mnt')] })];
    assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
  });
  await t.test('a running container with one bind in the worktree and one above it holds it with no names-it line', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [
      containerRecord(ID_A, { running: true, mounts: [bindMount(`/host_mnt${s.worktree}/site`), bindMount(`/host_mnt${s.root}`)] }),
    ];
    // assertWorktreeRetained takes the whole output, so a retained container line for a mount field naming it fails.
    assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
  });
  await t.test('a container bound at a target outside the worktree binds it', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(`/host_mnt${s.target}`)] })];
    assertScratchRetained(s, await s.cleanup(['23', '--scratch', s.target]), s.target, 'container aaaaaaaaaaaa binds it');
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
  });
  await t.test('a longer first component is not the prefix, so its container is not removed', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(`/host_mntx${s.worktree}/site`)] })];
    // The source stays absolute and readable; the worktree's own fate here belongs to the test of an unknown prefix.
    const { out } = await s.cleanup();
    assert.doesNotMatch(out.join('\n'), /could not be resolved/);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('an unrelated source under a longer first component leaves the worktree removable and its container alone', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount('/host_mntx/elsewhere')] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
      err: [],
    });
    assert.equal(existsSync(s.worktree), false);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a non-string source stays unresolved and retains the worktree', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(3)] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 4,
      out: [
        'retained container aaaaaaaaaaaa: a bind source could not be resolved: not a normalized absolute path',
        `retained worktree ${s.worktree}: container aaaaaaaaaaaa has a bind source that could not be resolved: not a normalized absolute path`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 3 retained',
      ],
      err: [],
    });
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('the same record on Linux keeps its prefix, so its container is not removed', async (t) => {
    const s = scenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(`/host_mnt${s.worktree}/site`)] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    assert.deepEqual(s.unexpected, []);
  });
});

test('macOS Docker Desktop: a named volume bind device follows the host path and name rules', { skip: SKIP_POSIX }, async (t) => {
  const desktopVolume = (device) => {
    const s = desktopScenario(t);
    mountVolumes(s, { v: volumeInspect('v', bindOptions(device(s))) });
    return s;
  };
  const inside = desktopVolume((s) => `/host_mnt${s.worktree}/site`);
  assert.deepEqual(await inside.cleanup(), {
    exitCode: 0,
    out: ['removed container aaaaaaaaaaaa', ...jobRemoved(inside), 'closeout-cleanup: 3 removed, 0 retained'],
    err: [],
  });
  assert.deepEqual(dockerCalls(inside, 'stop'), [['docker', 'stop', ID_A]]);
  assert.deepEqual(dockerCalls(inside, 'rm'), [['docker', 'rm', ID_A]]);
  assert.equal(existsSync(inside.worktree), false);
  assert.deepEqual(inside.unexpected, []);

  const above = desktopVolume((s) => `/host_mnt${s.root}`);
  assertWorktreeRetained(above, await above.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
  assertWorktreeNotRemoved(above);
  assert.deepEqual([...dockerCalls(above, 'stop'), ...dockerCalls(above, 'rm')], []);

  const unknownPrefix = desktopVolume((s) => `/run/x${s.worktree}`);
  const reason = 'container aaaaaaaaaaaa names it in a mount field no host path matched';
  assert.deepEqual(await unknownPrefix.cleanup(), {
    exitCode: 4,
    out: [
      `retained container aaaaaaaaaaaa: ${reason}`,
      `retained worktree ${unknownPrefix.worktree}: ${reason}`,
      'retained branch job/23: its worktree is retained',
      'closeout-cleanup: 0 removed, 3 retained',
    ],
    err: [],
  });
  assert.ok(existsSync(unknownPrefix.worktree));
  assertWorktreeNotRemoved(unknownPrefix);
  assert.deepEqual([...dockerCalls(unknownPrefix, 'stop'), ...dockerCalls(unknownPrefix, 'rm')], []);
  assert.deepEqual(unknownPrefix.unexpected, []);

  const named = desktopVolume((s) => `/run/x${s.target}`);
  assert.deepEqual(await named.cleanup(['--check', named.target]), {
    exitCode: 4,
    out: [`in use path ${named.target}: container aaaaaaaaaaaa names it`, SUMMARY(0, 0, 1, 0)],
    err: [],
  });
  assertNothingChanged(named);
  assertScratchRetained(named, await named.cleanup(['23', '--scratch', named.target]), named.target, 'container aaaaaaaaaaaa names it');
});

test('macOS Docker Desktop: a bind source naming the worktree under an unknown prefix retains it', { skip: SKIP_POSIX }, async (t) => {
  const boundUnderUnknownPrefix = (s) => [containerRecord(ID_A, { running: true, mounts: [bindMount(`/run/x${s.worktree}`)] })];
  await t.test('on a Mac nothing is stopped or removed and a retained line says the mount field names it', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = boundUnderUnknownPrefix(s);
    const { exitCode, out, err } = await s.cleanup();
    assert.equal(exitCode, 4, out.join('\n'));
    assert.ok(out.some((line) => line.startsWith(`retained worktree ${s.worktree}: container aaaaaaaaaaaa names it`)), out.join('\n'));
    assert.deepEqual(err, []);
    assert.ok(existsSync(s.worktree));
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('a scratch folder inside the worktree stays with it', async (t) => {
    const s = desktopScenario(t);
    const target = dirname(placeFile(join(s.worktree, '_site', 'page.md')));
    s.state.docker.containers = boundUnderUnknownPrefix(s);
    const reason = 'container aaaaaaaaaaaa names it in a mount field no host path matched';
    assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
      exitCode: 4,
      out: [
        `retained container aaaaaaaaaaaa: ${reason}`,
        `retained scratch ${target}: a container bound in the job worktree was not removed`,
        `retained worktree ${s.worktree}: ${reason}`,
        'retained branch job/23: its worktree is retained',
        'closeout-cleanup: 0 removed, 4 retained',
      ],
      err: [],
    });
    assert.ok(existsSync(target));
    assertWorktreeNotRemoved(s);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.unexpected, []);
  });
  const namingIt = {
    'HostConfig.Binds alone': (source) => containerRecord(ID_A, { running: true, binds: [`${source}:/work`] }),
    'HostConfig.Mounts alone': (source) => containerRecord(ID_A, { running: true, hostMounts: [bindMount(source)] }),
  };
  for (const [field, record] of Object.entries(namingIt)) {
    await t.test(`a record naming the worktree in ${field} retains it`, async (t) => {
      const s = desktopScenario(t);
      s.state.docker.containers = [record(`/run/x${s.worktree}`)];
      const { exitCode, out, err } = await s.cleanup();
      assert.equal(exitCode, 4, out.join('\n'));
      assert.ok(out.some((line) => line.startsWith(`retained worktree ${s.worktree}: container aaaaaaaaaaaa names it`)), out.join('\n'));
      assert.deepEqual(err, []);
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.unexpected, []);
    });
  }
  // The worktree stands at <root>/link/wt, where link is a symbolic link to <root>/real.
  const behindLink = (t) => {
    const s = desktopScenario(t, ['link', 'wt']);
    renameSync(join(s.root, 'link'), join(s.root, 'real'));
    symlinkSync('real', join(s.root, 'link'), 'dir');
    return { s, canonical: join(s.root, 'real', 'wt') };
  };
  for (const [form, spelled] of [['given', (s) => s.worktree], ['canonical', (s, canonical) => canonical]]) {
    await t.test(`a record naming only the worktree's ${form} path retains it`, async (t) => {
      const { s, canonical } = behindLink(t);
      assert.notEqual(canonical, s.worktree);
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(`/run/x${spelled(s, canonical)}`)] })];
      const { exitCode, out, err } = await s.cleanup();
      assert.equal(exitCode, 4, out.join('\n'));
      assert.ok(out.some((line) => line.startsWith(`retained worktree ${s.worktree}: container aaaaaaaaaaaa names it`)), out.join('\n'));
      assert.deepEqual(err, []);
      assert.ok(existsSync(s.worktree));
      assertWorktreeNotRemoved(s);
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.unexpected, []);
    });
  }
  await t.test('on Linux the worktree is removed', async (t) => {
    const s = scenario(t);
    s.state.docker.containers = boundUnderUnknownPrefix(s);
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: [...jobRemoved(s), 'closeout-cleanup: 2 removed, 0 retained'],
      err: [],
    });
    assert.equal(existsSync(s.worktree), false);
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.unexpected, []);
  });
});

const SKIP_NOT_MACOS = process.platform !== 'darwin' && 'the folder spelling is read from the macOS disk';
const CASE_SENSITIVE = 'the scratch volume is case-sensitive';
const onCaseSensitiveVolume = (t) => !existsSync(join(desktopScenario(t).root, 'WT'));

test('macOS: a bind spelled in another letter case matches the real path', { skip: SKIP_NOT_MACOS }, async (t) => {
  if (onCaseSensitiveVolume(t)) {
    t.skip(CASE_SENSITIVE);
    return;
  }
  await t.test('a stopped container bound in the worktree gets rm and the worktree is removed', async (t) => {
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(join(s.root, 'WT', 'site'))] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: ['removed container aaaaaaaaaaaa', ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual(dockerCalls(s, 'stop'), []);
    assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
    assert.equal(existsSync(s.worktree), false);
    assert.deepEqual(s.unexpected, []);
  });
  await t.test('check mode answers in use for a target spelled in a third case', async (t) => {
    const s = desktopScenario(t);
    mkdirSync(join(s.worktree, 'site'));
    const target = join(s.root, 'WT', 'site');
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(join(s.root, 'Wt', 'site'))] })];
    assert.deepEqual(await s.cleanup(['--check', target]), {
      exitCode: 4, out: [`in use path ${target}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)], err: [],
    });
    assertNothingChanged(s);
  });
});

test('macOS: a target named in another letter case matches a bind at its real spelling', { skip: SKIP_NOT_MACOS }, async (t) => {
  if (onCaseSensitiveVolume(t)) {
    t.skip(CASE_SENSITIVE);
    return;
  }
  // The scenario's scratch folder renamed, since on this volume a second folder could not differ from it by case alone.
  const boundScratch = (t) => {
    const s = desktopScenario(t);
    const real = join(s.root, 'Scratch');
    renameSync(dirname(s.target), real);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(real)] })];
    return { s, real, target: join(s.root, 'SCRATCH') };
  };
  await t.test('check mode answers in use', async (t) => {
    const { s, target } = boundScratch(t);
    assert.deepEqual(await s.cleanup(['--check', target]), {
      exitCode: 4, out: [`in use path ${target}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)], err: [],
    });
    assertNothingChanged(s);
  });
  await t.test('cleanup retains it and the folder remains', async (t) => {
    const { s, real, target } = boundScratch(t);
    assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'container aaaaaaaaaaaa binds it');
    assert.ok(existsSync(real));
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
  });
});

const DATA_VOLUME = '/System/Volumes/Data';

// A folder's spelling through the Data volume; the fixture fails unless a stat shows both spellings are one folder.
function dataSpelling(path) {
  const spelled = join(DATA_VOLUME, path);
  const [ordinary, data] = [path, spelled].map((spelling) => statSync(spelling, { bigint: true }));
  assert.deepEqual([data.dev, data.ino], [ordinary.dev, ordinary.ino]);
  return spelled;
}

test('macOS: a folder spelled through the Data volume is the same folder', { skip: SKIP_NOT_MACOS }, async (t) => {
  // The scenario's scratch folder held by a stopped container bound at its ordinary spelling.
  const boundScratch = (t) => {
    const s = desktopScenario(t);
    const scratch = dirname(s.target);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(scratch)] })];
    return { s, scratch, target: dataSpelling(scratch) };
  };
  await t.test('check mode answers in use for a target in the Data spelling', async (t) => {
    const { s, scratch, target } = boundScratch(t);
    assert.deepEqual(await s.cleanup(['--check', target]), {
      exitCode: 4, out: [`in use path ${target}: container aaaaaaaaaaaa binds it`, SUMMARY(0, 0, 1, 0)], err: [],
    });
    assert.ok(existsSync(scratch));
    assertNothingChanged(s);
  });
  await t.test('check mode answers not in use for a Data-spelled folder that differs from its ordinary spelling', async (t) => {
    const target = join(DATA_VOLUME, 'usr');
    const [ordinary, data] = ['/usr', target].map((spelling) => statSync(spelling, { bigint: true, throwIfNoEntry: false }));
    if (!data) {
      t.skip(`${target} does not exist on this Mac`);
      return;
    }
    assert.equal(data.dev, ordinary.dev);
    assert.notEqual(data.ino, ordinary.ino);
    const s = desktopScenario(t);
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount('/usr')] })];
    assert.deepEqual(await s.cleanup(['--check', target]), { exitCode: 0, out: [`unused path ${target}`, SUMMARY(1, 0, 0, 0)], err: [] });
    assertNothingChanged(s);
  });
  await t.test('cleanup retains a scratch target in the Data spelling and the folder remains', async (t) => {
    const { s, scratch, target } = boundScratch(t);
    assertScratchRetained(s, await s.cleanup(['23', '--scratch', target]), target, 'container aaaaaaaaaaaa binds it');
    assert.ok(existsSync(scratch));
    assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
    assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
  });
  const assertBoundContainerRemoved = async (s, source) => {
    s.state.docker.containers = [containerRecord(ID_A, { mounts: [bindMount(source)] })];
    assert.deepEqual(await s.cleanup(), {
      exitCode: 0,
      out: ['removed container aaaaaaaaaaaa', ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.deepEqual(dockerCalls(s, 'stop'), []);
    assert.deepEqual(dockerCalls(s, 'rm'), [['docker', 'rm', ID_A]]);
    assert.equal(existsSync(s.worktree), false);
    assert.deepEqual(s.unexpected, []);
  };
  await t.test('a stopped container bound in the worktree in the Data spelling gets rm and the worktree is removed', async (t) => {
    const s = desktopScenario(t);
    await assertBoundContainerRemoved(s, join(dataSpelling(s.worktree), 'site'));
  });
  await t.test('the same with a component below the Data prefix in another letter case', async (t) => {
    if (onCaseSensitiveVolume(t)) {
      t.skip(CASE_SENSITIVE);
      return;
    }
    const s = desktopScenario(t);
    await assertBoundContainerRemoved(s, join(dataSpelling(s.root), 'WT', 'site'));
  });
  await t.test('a running container bound at the Data volume or above it holds the worktree and is not stopped', async (t) => {
    for (const source of [DATA_VOLUME, '/System/Volumes', '/System']) {
      const s = desktopScenario(t);
      s.state.docker.containers = [containerRecord(ID_A, { running: true, mounts: [bindMount(source)] })];
      assertWorktreeRetained(s, await s.cleanup(), 'container aaaaaaaaaaaa binds a parent folder of it');
      assertWorktreeNotRemoved(s);
      assert.deepEqual([...dockerCalls(s, 'stop'), ...dockerCalls(s, 'rm')], []);
      assert.deepEqual(s.state.docker.containers.map(({ Id }) => Id), [ID_A]);
    }
  });
  await t.test('a target in the Data spelling with no container relationship is removed', async (t) => {
    const s = desktopScenario(t);
    const scratch = dirname(s.target);
    const target = dataSpelling(scratch);
    assert.deepEqual(await s.cleanup(['23', '--scratch', target]), {
      exitCode: 0,
      out: [`removed scratch ${target}`, ...jobRemoved(s), 'closeout-cleanup: 3 removed, 0 retained'],
      err: [],
    });
    assert.equal(existsSync(scratch), false);
    assert.deepEqual(s.unexpected, []);
  });
});
