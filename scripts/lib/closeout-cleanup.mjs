// closeout-cleanup.mjs — the checks and removals behind scripts/closeout-cleanup.mjs.
//
// Every external call goes through one injected `run`, and each answers only the argument vectors this file
// builds. Every check fails closed: an absent tool, a failed run, unrecognised output or an unresolved path
// retains the target it was checking, and nothing is ever forced.

import { spawnSync } from 'node:child_process';
import { constants, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const VANISHED = /^Error(?: response from daemon)?: No such container: ([0-9a-f]{64})$/;
const LSOF_WARNING = /^lsof: WARNING: can't stat\(\) \S+ file system (\/.*)$/;
const LSOF_INCOMPLETE = '      Output information may be incomplete.';
// eslint-disable-next-line no-control-regex -- a path argument holding a control character is refused
const CONTROL = /[\u0000-\u001f\u007f]/;
const WORKTREE_ATTRIBUTES = new Set(['HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable']);
const NON_BIND_MOUNT_TYPES = new Set(['volume', 'tmpfs', 'npipe', 'cluster', 'image']);

// One external command, no shell and no working directory: { absent: true } when it is not installed,
// { failed: <code or signal> } when it could not finish, else { status, stdout, stderr }.
export function runCommand(command, args, { env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env,
  });
  if (result.error?.code === 'ENOENT') return { absent: true };
  if (result.error) return { failed: result.error.code ?? result.error.message };
  if (result.signal) return { failed: result.signal };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const unique = (values) => [...new Set(values)];
const isCleanAbsolute = (path) =>
  isAbsolute(path) && path === normalize(path) && (path === '/' || !path.endsWith('/')) && !CONTROL.test(path);
const isCleanRelative = (path) =>
  !isAbsolute(path) && path === normalize(path) && path !== '.' && path !== '..' && !path.startsWith('../') &&
  !CONTROL.test(path);

// { issue, scratch, regenerated } for a job, or { check } for a read-only check of paths, duplicates dropped in order,
// or { error } for anything else.
export function parseCleanupArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        scratch: { type: 'string', multiple: true },
        regenerated: { type: 'string', multiple: true },
        check: { type: 'string', multiple: true },
      },
    });
  } catch (error) {
    return { error: error.message };
  }
  const { positionals, values } = parsed;
  if (values.check) {
    if (positionals.length || values.scratch || values.regenerated) return { error: '--check takes no issue number and no other flag' };
    const check = unique(values.check);
    const badCheck = check.find((path) => !isCleanAbsolute(path));
    if (badCheck !== undefined) return { error: `--check needs a normalized absolute path: ${JSON.stringify(badCheck)}` };
    return { check };
  }
  if (positionals.length !== 1 || !POSITIVE_INTEGER.test(positionals[0])) return { error: 'expected exactly one issue number' };
  const scratch = unique(values.scratch ?? []);
  const regenerated = unique(values.regenerated ?? []);
  const badScratch = scratch.find((path) => !isCleanAbsolute(path));
  if (badScratch !== undefined) return { error: `--scratch needs a normalized absolute path: ${JSON.stringify(badScratch)}` };
  const badRegenerated = regenerated.find((path) => !isCleanRelative(path));
  if (badRegenerated !== undefined) {
    return { error: `--regenerated needs a normalized path inside the worktree: ${JSON.stringify(badRegenerated)}` };
  }
  return { issue: positionals[0], scratch, regenerated };
}

// The records of `git worktree list --porcelain -z`, the main worktree first, each { path, ...attributes } with an
// attribute's value '' when it has none; null when any record is unreadable.
export function parseWorktreeList(stdout) {
  const fields = stdout.split('\0');
  if (fields.pop() !== '') return null;
  const records = [];
  let record = null;
  for (const field of fields) {
    if (field === '') {
      if (!record) return null;
      records.push(record);
      record = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (!record) {
      if (key !== 'worktree' || !isAbsolute(value)) return null;
      record = { path: value };
    } else if (WORKTREE_ATTRIBUTES.has(key) && !(key in record)) {
      record[key] = value;
    } else {
      return null;
    }
  }
  return record || records.length === 0 ? null : records;
}

// Subprocess text as one report line: its first non-blank line, at most 200 characters.
function firstLine(text) {
  return (text.split('\n').map((line) => line.trimEnd()).find(Boolean) ?? '').slice(0, 200);
}

function describe(result) {
  if (result.absent) return 'not installed';
  if (result.failed) return `failed: ${result.failed}`;
  return firstLine(result.stderr) || `exit status ${result.status}`;
}

function createReport() {
  const lines = [];
  let removed = 0;
  let retained = 0;
  return {
    removed(kind, subject) {
      removed += 1;
      lines.push(`removed ${kind} ${subject}`);
    },
    retained(kind, subject, reason) {
      retained += 1;
      lines.push(`retained ${kind} ${subject}: ${reason}`);
    },
    absent(kind, subject) {
      lines.push(`absent ${kind} ${subject}`);
    },
    line(text) {
      lines.push(text);
    },
    finish() {
      lines.push(removed || retained ? `closeout-cleanup: ${removed} removed, ${retained} retained` : 'closeout-cleanup: nothing to do');
      return { lines, exitCode: retained ? 4 : removed ? 0 : 3 };
    },
  };
}

const failure = (message) => ({ lines: [`closeout-cleanup: ${message}`], exitCode: 1 });

// The reason the whole run retains every target, or null: the job branch is the main worktree's, the command is
// the job worktree's own copy, or the platform has no in-use check.
function wholeRunRefusal(mainRecord, job, worktree, seams) {
  if (mainRecord.branch === `refs/heads/${job}`) return `${job} is checked out in the main worktree ${mainRecord.path}`;
  if (worktree) {
    const script = canonicalPath(seams.scriptPath);
    if (script.unresolved) return `the command's own path could not be resolved: ${script.unresolved}`;
    if (worktree.canonical && atOrBelow(script.path, worktree.canonical)) {
      return "this is the job worktree's copy of the command; run the verifier checkout's copy";
    }
  }
  if (seams.platform === 'win32') return 'no in-use check on this platform';
  return null;
}

// Job mode: the job's containers, named scratch, worktree and branch, each removed only when every check passes.
export function cleanupJob(request, seams) {
  const job = `job/${request.issue}`;
  const git = (...args) => seams.run(seams.git.command, args, { env: seams.git.env });
  const listing = git('worktree', 'list', '--porcelain', '-z');
  if (listing.status !== 0) return failure(`could not read the worktree list: ${describe(listing)}`);
  const records = parseWorktreeList(listing.stdout);
  if (!records) return failure('could not read the worktree list: an unreadable record');
  const ref = git('rev-parse', '--verify', '--quiet', `refs/heads/${job}`);
  const branchPresent = ref.status === 0 && ref.stdout.trim() !== '';
  if (!branchPresent && !(ref.status === 1 && ref.stdout === '')) return failure(`could not read the branch ${job}: ${describe(ref)}`);

  const [mainRecord, ...linked] = records;
  const record = linked.find(({ branch }) => branch === `refs/heads/${job}`);
  const worktree = record && { path: record.path, retained: null };
  const retainWorktree = (reason) => {
    worktree.retained ??= reason;
  };
  const canonical = worktree && canonicalPath(worktree.path);
  if (canonical?.unresolved) retainWorktree(`could not be resolved: ${canonical.unresolved}`);
  if (canonical?.path) worktree.canonical = canonical.path;

  const report = createReport();
  const refusal = wholeRunRefusal(mainRecord, job, worktree, seams);
  if (refusal) {
    for (const path of request.scratch) report.retained('scratch', path, refusal);
    if (worktree) report.retained('worktree', worktree.path, refusal);
    if (branchPresent) report.retained('branch', job, refusal);
    return report.finish();
  }

  const docker = worktree || request.scratch.length ? dockerSnapshot(seams) : null;
  if (docker?.absent) report.line('skipped containers: docker is not installed');

  let containers = { gone: new Set(), clean: false };
  if (worktree?.canonical) {
    if (docker?.failure) retainWorktree(`docker failed: ${docker.failure}`);
    const cwd = canonicalPath(seams.cwd);
    if (cwd.unresolved) retainWorktree(`the working directory could not be resolved: ${cwd.unresolved}`);
    else if (atOrBelow(cwd.path, worktree.canonical)) retainWorktree('the command runs inside it');
    if (record.prunable !== undefined) retainWorktree('run `git worktree prune`, then this command again');
    if (!worktree.retained) {
      const listener = listenerRetention(seams.run, [worktree.path, worktree.canonical]);
      if (listener) retainWorktree(listener);
    }
    if (docker?.records) containers = removeWorktreeContainers(docker, worktree, report, retainWorktree);
  }

  const context = { seams, git, records, worktree, docker, containers };
  for (const path of request.scratch) {
    const { absent, retained, forms } = removeScratch(path, context);
    if (absent) {
      report.absent('scratch', path);
    } else if (!retained) {
      report.removed('scratch', path);
    } else {
      report.retained('scratch', path, retained);
      // Removing the worktree would delete a retained target inside it.
      const places = worktree ? [worktree.path, worktree.canonical].filter(Boolean) : [];
      if (relates(forms, places, ['equal', 'below'])) retainWorktree(`holds retained scratch ${path}`);
    }
  }

  if (worktree && !worktree.retained) {
    const held = useChecks(worktree.path, [worktree.path, worktree.canonical], true, true, context);
    if (held) retainWorktree(held.reason);
  }
  if (worktree && !worktree.retained) removeWorktree(git, worktree, request.regenerated, retainWorktree, docker.verify);
  if (!worktree) report.absent('worktree', job);
  else if (worktree.retained) report.retained('worktree', worktree.path, worktree.retained);
  else report.removed('worktree', worktree.path);

  if (!branchPresent) {
    report.absent('branch', job);
  } else if (worktree?.retained) {
    report.retained('branch', job, 'its worktree is retained');
  } else {
    const unverified = docker?.failure ? `docker failed: ${docker.failure}` : docker?.verify();
    if (unverified) report.retained('branch', job, unverified);
    else {
      const deletion = git('branch', '-d', job);
      if (deletion.status === 0) report.removed('branch', job);
      else report.retained('branch', job, describe(deletion));
    }
  }
  return report.finish();
}

// Check mode: reads whether anything uses each path and removes nothing, making no call to the version control tool.
// One line per path, then a summary; exit 4 when any path is in use or could not be checked.
export function checkPaths(paths, seams) {
  const tally = { unused: 0, absent: 0, 'in use': 0, unverifiable: 0 };
  let docker;
  const lines = paths.map((path) => {
    const { verb, reason } = checkPath(path, seams, () => (docker ??= dockerSnapshot(seams)));
    tally[verb] += 1;
    return `${verb} path ${path}${reason ? `: ${reason}` : ''}`;
  });
  lines.push(`closeout-cleanup: ${tally.unused} unused, ${tally.absent} absent, ${tally['in use']} in use, ${tally.unverifiable} unverifiable`);
  return { lines, exitCode: tally['in use'] || tally.unverifiable ? 4 : 0 };
}

// One path's verdict: { verb: 'unused' | 'absent' | 'in use' | 'unverifiable', reason }. Only a completed check
// that found nothing says unused; the Docker snapshot is taken only when a path gets that far.
function checkPath(path, seams, snapshot) {
  const target = readTarget(path);
  if (target.absent) return { verb: 'absent' };
  if (target.retained) return { verb: 'unverifiable', reason: target.retained };
  if (seams.platform === 'win32') return { verb: 'unverifiable', reason: 'no in-use check on this platform' };
  const held = useChecks(path, target.forms, false, target.before.isDirectory(), {
    seams, docker: snapshot(), containers: { gone: new Set() },
  });
  if (!held) return { verb: 'unused' };
  return { verb: held.inUse ? 'in use' : 'unverifiable', reason: held.reason };
}

// Every container's whole record: { absent: true } when docker is not installed, { failure } when docker failed or
// printed anything unrecognised, else { records, command, verify } with pinned local filesystem authority.
function dockerSnapshot({ run, platform }) {
  const inspectionEnv = { ...process.env };
  const metadata = run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker}}'], { env: inspectionEnv });
  if (metadata.absent) return { absent: true, verify: () => null };
  if (!completeCommand(metadata)) return { failure: dockerUnverifiable('endpoint inspection failed') };
  let endpoint;
  try {
    endpoint = JSON.parse(metadata.stdout);
  } catch {
    return { failure: dockerUnverifiable('endpoint metadata is unreadable') };
  }
  if (!isObject(endpoint) || typeof endpoint.Host !== 'string' || !endpoint.Host || CONTROL.test(endpoint.Host)) {
    return { failure: dockerUnverifiable('endpoint metadata is unreadable') };
  }
  const env = { ...inspectionEnv };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const proof = proveDockerFilesystem(endpoint.Host, run, platform, env);
  if (proof.failure) return proof;
  const command = (...args) => run('docker', ['--host', proof.host, ...args], { env });
  const snapshot = { verify: proof.verify, command };
  const list = command('container', 'ls', '--all', '--quiet', '--no-trunc');
  if (list.status !== 0) return { failure: describe(list) };
  const ids = list.stdout.split('\n').filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID.test(id))) return { failure: 'docker listed an unrecognised container ID' };
  if (!ids.length) return { ...snapshot, records: [] };
  const inspect = command('inspect', '--type', 'container', '--format', '{{json .}}', ...ids);
  if (inspect.status === undefined) return { failure: describe(inspect) };
  let gone = [];
  if (inspect.status !== 0) {
    const errors = inspect.stderr.split('\n').filter(Boolean);
    gone = errors.map((line) => VANISHED.exec(line)?.[1]);
    if (!errors.length || gone.some((id) => !ids.includes(id))) return { failure: describe(inspect) };
  }
  const expected = ids.filter((id) => !gone.includes(id));
  const records = [];
  for (const line of inspect.stdout.split('\n').filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return { failure: 'docker inspect printed a line that is not JSON' };
    }
    if (!isObject(record) || !expected.includes(record.Id) || records.some(({ Id }) => Id === record.Id)) {
      return { failure: 'docker inspect printed a record for no listed container' };
    }
    records.push(record);
  }
  if (records.length !== expected.length) {
    return { failure: `docker inspect printed ${records.length} records for ${expected.length} containers` };
  }
  return { ...snapshot, records };
}

const dockerUnverifiable = (stage) => `Docker filesystem relationship is unverifiable: ${stage}`;
const completeCommand = (result) => result.status === 0 && result.stderr === '';
const completeLine = (text) => typeof text === 'string' && text.endsWith('\n') && !text.slice(0, -1).includes('\n') ? text.slice(0, -1) : null;
const isCleanPosixAbsolute = (path) =>
  posix.isAbsolute(path) && path === posix.normalize(path) && (path === '/' || !path.endsWith('/')) && !CONTROL.test(path);
const safeSocketPath = (path) => typeof path === 'string' && /^\/[A-Za-z0-9/._-]*$/.test(path) && isCleanPosixAbsolute(path);

// Socket diagnostics identify both the filesystem socket and the distinct kernel socket behind its descriptor.
function dockerListener(stdout, sockets) {
  const line = completeLine(stdout);
  if (!line) return null;
  const match = /^u_str[ \t]+LISTEN[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+(\S+)[ \t]+([0-9]+)[ \t]+\*[ \t]+0[ \t]+(?:users:\((\("[A-Za-z0-9._-]+",pid=[0-9]+,fd=[0-9]+\)(?:,\("[A-Za-z0-9._-]+",pid=[0-9]+,fd=[0-9]+\))?)\)[ \t]+)?(?:(?:<->|<--|-->|---)[ \t]+)?ino:([0-9]+)[ \t]+dev:([0-9]+)\/([0-9]+)(?:[ \t]+peers:(?:[ \t]+[0-9]+)*)?[ \t]*$/.exec(line);
  if (!match || !sockets.includes(match[1])) return null;
  const [kernel, inode, printedMajor, printedMinor] = [match[2], ...match.slice(4)].map((value) => BigInt(value));
  if (kernel <= 0n || inode <= 0n || printedMajor > 0xfffn || printedMinor > 0xfffffn) return null;
  const owners = [...(match[3] ?? '').matchAll(/\("[A-Za-z0-9._-]+",pid=([0-9]+),fd=([0-9]+)\)/g)]
    .map((owner) => ({ pid: BigInt(owner[1]), fd: BigInt(owner[2]) }));
  if (owners.some(({ pid, fd }) => pid <= 0n || pid > 2147483647n || fd > 2147483647n) ||
    new Set(owners.map(({ pid }) => pid)).size !== owners.length) return null;
  owners.sort((left, right) => left.pid < right.pid ? -1 : 1);
  // ss prints the kernel's 32-bit device through libc's different major/minor encoding.
  return { kernel, inode, major: printedMinor >> 8n, minor: (printedMajor << 8n) | (printedMinor & 0xffn), owners };
}

function dockerIdentityRows(stdout, types) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')) return null;
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length !== types.length) return null;
  const rows = [];
  for (const line of lines) {
    const row = /^([0-9]+):([0-9]+):([0-9]+):([0-9]+):(socket|directory|regular file|regular empty file)$/.exec(line);
    if (!row) return null;
    rows.push({ numbers: row.slice(1, 5).map((value) => BigInt(value)), type: row[5] });
  }
  return rows.some(({ type }, index) => types[index] === 'namespace'
    ? !['regular file', 'regular empty file'].includes(type) : type !== types[index]) ? null : rows;
}

function dockerIdentity(stdout, listener, role) {
  const rows = dockerIdentityRows(stdout,
    ['socket', 'socket', 'namespace', 'namespace', 'directory', 'directory', 'regular file', 'regular file']);
  if (!rows) return { failure: 'filesystem identity observation is unsupported or malformed' };
  const [socket, descriptor] = rows.map(({ numbers }) => numbers);
  if (socket[1] !== listener.inode) return { failure: 'filesystem socket inode does not match listener' };
  if (socket[2] !== listener.major || socket[3] !== listener.minor) return { failure: 'filesystem socket device does not match listener' };
  if (descriptor[1] !== listener.kernel) return { failure: 'socket descriptor does not match listener' };
  for (const [index, failure] of [
    [2, `${role} mount namespace differs from local process`],
    [4, `${role} root differs from local root`],
    [6, `${role} executable differs from resolved executable`],
  ]) {
    if (rows[index].numbers[0] !== rows[index + 1].numbers[0] || rows[index].numbers[1] !== rows[index + 1].numbers[1]) return { failure };
  }
  return { identity: rows.map(({ numbers, type }) => `${numbers.join(':')}:${type}`).join('\n') };
}

// A local Linux proof and a latched verifier. Native observation never inherits redirection variables.
function proveDockerFilesystem(host, run, platform, env) {
  const fail = (stage) => ({ failure: dockerUnverifiable(stage) });
  const original = host.slice(7);
  if (platform !== 'linux' || !host.startsWith('unix://') || !safeSocketPath(original)) return fail('unsupported endpoint');
  const nativeEnv = { ...(env.PATH === undefined ? {} : { PATH: env.PATH }), LC_ALL: 'C' };
  const native = (command, args) => run(command, args, { env: nativeEnv });
  const link = native('readlink', ['-e', '--', original]);
  if (!completeCommand(link)) return fail('socket path observation command did not complete cleanly');
  const socket = completeLine(link.stdout);
  if (!safeSocketPath(socket)) return fail('socket path observation is unsupported or malformed');
  const sockets = unique([original, socket]);
  const ssArgs = sockets.length === 1 ? ['-H', '-xlnpe', 'src', socket] :
    ['-H', '-xlnpe', '(', 'src', original, 'or', 'src', socket, ')'];
  const located = native('sh', ['-c', 'command -v dockerd']);
  if (!completeCommand(located)) return fail('daemon executable lookup command did not complete cleanly');
  const executable = completeLine(located.stdout);
  if (!executable || !isCleanPosixAbsolute(executable)) return fail('daemon executable observation is unsupported or malformed');
  // Command-scoped -k bypasses cached credentials without invalidating or updating the cache.
  const privileged = (command, args) => native('/usr/bin/sudo', ['-kn', '-u', 'root', '-g', 'root', '--', `/usr/bin/${command}`, ...args]);
  const statArgs = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--'];
  const observationTypes = ['socket', 'namespace', 'directory', 'regular file'];
  const callerObservation = (expected) => native('stat', [...statArgs, socket, '/proc/self/ns/mnt', '/', expected]);
  const observe = (mode, initial = false) => {
    const result = mode === 'native' ? native('ss', ssArgs) : privileged('ss', ssArgs);
    if (!completeCommand(result)) return { failure: mode === 'native'
      ? 'listener observation command did not complete cleanly' : 'passwordless listener observation was unavailable' };
    const listener = dockerListener(result.stdout, sockets);
    const ownershipFailure = { failure: 'listener ownership observation is missing, ambiguous or unsupported' };
    if (!listener) return ownershipFailure;
    if (!listener.owners.length) return initial ? { retry: true } : ownershipFailure;
    if (listener.owners.length === 2 && listener.owners[0].pid !== 1n) return ownershipFailure;
    const identities = [];
    for (const { pid, fd } of listener.owners) {
      const role = listener.owners.length === 2 && pid === 1n ? 'systemd' : 'daemon';
      const expected = role === 'systemd' ? '/usr/lib/systemd/systemd' : executable;
      let stdout;
      if (mode === 'native') {
        const stat = native('stat', [...statArgs, socket, `/proc/${pid}/fd/${fd}`,
          '/proc/self/ns/mnt', `/proc/${pid}/ns/mnt`, '/', `/proc/${pid}/root`, expected, `/proc/${pid}/exe`]);
        if (!completeCommand(stat)) return { failure: 'filesystem identity observation command did not complete cleanly' };
        stdout = stat.stdout;
      } else {
        // Caller identity must remain unprivileged: sudo's namespace and root are not the caller's.
        const local = callerObservation(expected);
        if (!completeCommand(local)) return { failure: 'caller filesystem identity observation command did not complete cleanly' };
        if (!dockerIdentityRows(local.stdout, observationTypes)) return { failure: 'caller filesystem identity observation is unsupported or malformed' };
        const remote = privileged('stat', [...statArgs, `/proc/${pid}/fd/${fd}`, `/proc/${pid}/ns/mnt`, `/proc/${pid}/root`, `/proc/${pid}/exe`]);
        if (!completeCommand(remote)) return { failure: `passwordless ${role} filesystem identity observation was unavailable` };
        if (!dockerIdentityRows(remote.stdout, observationTypes)) {
          return { failure: 'filesystem identity observation is unsupported or malformed' };
        }
        const processRows = remote.stdout.slice(0, -1).split('\n');
        stdout = local.stdout.slice(0, -1).split('\n').flatMap((row, index) => [row, processRows[index]]).join('\n') + '\n';
      }
      const observed = dockerIdentity(stdout, listener, role);
      if (observed.failure) return observed;
      identities.push(`${pid}:${fd}\n${observed.identity}`);
    }
    return { identity: `${listener.kernel}:${listener.inode}:${listener.major}:${listener.minor}\n${identities.join('\n')}` };
  };
  let mode = 'native';
  let initial = observe(mode, true);
  if (initial.retry) {
    mode = 'privileged';
    initial = observe(mode);
  }
  if (initial.failure) return fail(initial.failure);
  let failure = null;
  return {
    host: `unix://${socket}`,
    verify() {
      if (!failure) {
        const current = observe(mode);
        if (current.failure) failure = dockerUnverifiable(`native identity changed or became unreadable: ${current.failure}`);
        else if (current.identity !== initial.identity) failure = dockerUnverifiable('native identity changed since initial observation');
      }
      return failure;
    },
  };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The host paths a container record binds: Mounts and HostConfig.Mounts of type bind, and each HostConfig.Binds
// entry whose host part is a path rather than a named volume. A malformed HostConfig, list or entry, a mount whose
// Type is neither bind nor one of Docker's other mount types included, gives a null source.
export function bindSources(record) {
  const sources = [];
  const fromMounts = (mounts) => {
    if (mounts == null) return;
    if (!Array.isArray(mounts)) return sources.push(null);
    for (const mount of mounts) {
      if (isObject(mount) && mount.Type === 'bind') sources.push(mount.Source);
      else if (!isObject(mount) || !NON_BIND_MOUNT_TYPES.has(mount.Type)) sources.push(null);
    }
    return undefined;
  };
  fromMounts(record.Mounts);
  if (record.HostConfig != null && !isObject(record.HostConfig)) sources.push(null);
  const binds = record.HostConfig?.Binds;
  if (binds != null && !Array.isArray(binds)) sources.push(null);
  for (const bind of Array.isArray(binds) ? binds : []) {
    if (typeof bind !== 'string') sources.push(null);
    else if (bind.startsWith('/')) sources.push(bind.split(':', 1)[0]);
  }
  fromMounts(record.HostConfig?.Mounts);
  return sources;
}

// A path's canonical form, its longest existing prefix resolved plus the missing suffix: { path }, or { unresolved }
// with the error code when a link, a permission or a malformed path prevents it.
function canonicalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== normalize(path)) {
    return { unresolved: 'not a normalized absolute path' };
  }
  const missing = [];
  for (let prefix = path; ; prefix = dirname(prefix)) {
    try {
      return { path: join(realpathSync(prefix), ...missing) };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { unresolved: error.code ?? error.message };
      missing.unshift(basename(prefix));
    }
  }
}

// How one normalized absolute path stands to another, compared by whole components.
export function pathRelation(path, other) {
  const within = (inner, outer) => inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  if (path === other) return 'equal';
  if (within(path, other)) return 'below';
  if (within(other, path)) return 'above';
  return 'unrelated';
}

const atOrBelow = (path, other) => ['equal', 'below'].includes(pathRelation(path, other));
const relates = (paths, others, relations) =>
  paths.some((path) => others.some((other) => relations.includes(pathRelation(path, other))));

// The processes and names of lsof's field output (-F with p, c, f and n); null on any other line.
export function parseLsof(stdout) {
  const processes = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [field, value] = [line[0], line.slice(1)];
    const current = processes.at(-1);
    if (field === 'p' && POSITIVE_INTEGER.test(value)) processes.push({ pid: value, command: '', names: [] });
    else if (!current || !['c', 'f', 'n'].includes(field)) return null;
    else if (field === 'c') current.command = value;
    else if (field === 'n') current.names.push(value);
  }
  return processes;
}

// The rows of `ps -ww -A -o pid= -o ppid= -o args=`, right-aligned numbers then the arguments, each
// { pid, ppid, args }; null when any row is unreadable.
export function parsePs(stdout) {
  const rows = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const row = /^ *(\d+) +(\d+)(?: (.*))?$/.exec(line);
    if (!row) return null;
    rows.push({ pid: row[1], ppid: row[2], args: row[3] ?? '' });
  }
  return rows;
}

// lsof's stderr as the mounts it warned it could not stat: { mounts }, or { unrecognised } with the first line that
// is not such a warning and its continuation.
export function classifyLsofStderr(stderr) {
  const lines = stderr.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const mounts = [];
  for (let index = 0; index < lines.length; index += 2) {
    const warning = LSOF_WARNING.exec(lines[index]);
    if (!warning || lines[index + 1] !== LSOF_INCOMPLETE) return { unrecognised: lines[index] };
    mounts.push(warning[1]);
  }
  return { mounts };
}

// Every lsof result read one way: { processes }, or { retain } with the reason when lsof is absent or failed,
// printed unrecognised output, or warned about a mount holding a target or at or below one. Its exit status is
// never read: it exits 1 both when nothing matches and when it warns.
function readLsof(result, targets) {
  if (result.absent) return { retain: 'no in-use check: lsof is not installed' };
  if (result.failed) return { retain: `lsof failed: ${result.failed}` };
  const stderr = classifyLsofStderr(result.stderr);
  if (stderr.unrecognised !== undefined) return { retain: `lsof reported: ${firstLine(stderr.unrecognised)}` };
  const mount = stderr.mounts.find((path) => relates(targets, [path], ['equal', 'below', 'above']));
  if (mount) return { retain: `lookup incomplete: lsof could not stat the file system at ${mount}` };
  const processes = parseLsof(result.stdout);
  if (!processes) return { retain: 'lsof printed a field it was not asked for' };
  return { processes };
}

// The reason a listening process serves the worktree, or null when none does.
function listenerRetention(run, targets) {
  const listening = readLsof(run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpc']), targets);
  if (listening.retain) return listening.retain;
  if (!listening.processes.length) return null;
  const pids = listening.processes.map(({ pid }) => pid).join(',');
  const directories = readLsof(run('lsof', ['-nP', '-a', '-p', pids, '-d', 'cwd', '-Fpn']), targets);
  if (directories.retain) return directories.retain;
  for (const { pid, command } of listening.processes) {
    const cwd = directories.processes.find((entry) => entry.pid === pid)?.names[0];
    if (cwd === undefined) return `pid ${pid} (${command}) listens, and its working directory could not be read`;
    if (targets.some((target) => atOrBelow(cwd, target))) return `pid ${pid} (${command}) serves it`;
  }
  return null;
}

// Stops and removes each container bound at or below the worktree; an unresolved source or a failed removal
// retains the worktree. "No such container" naming the container's own ID means it is already gone. Returns
// { gone, clean }: the IDs no longer present, and whether every container was settled with no unresolved source or
// failed removal.
function removeWorktreeContainers(docker, worktree, report, retainWorktree) {
  const gone = new Set();
  let clean = true;
  const retainUnverified = (short) => {
    const unverified = docker.verify();
    if (!unverified) return false;
    clean = false;
    report.retained('container', short, unverified);
    retainWorktree(unverified);
    return true;
  };
  for (const record of docker.records) {
    const unverified = docker.verify();
    if (unverified) {
      clean = false;
      retainWorktree(unverified);
      report.line(`unverifiable remaining container relationships: ${unverified}`);
      break;
    }
    const short = record.Id.slice(0, 12);
    const sources = bindSources(record).map(canonicalPath);
    if (!sources.some(({ path }) => path && atOrBelow(path, worktree.canonical))) {
      const unresolved = sources.find(({ unresolved }) => unresolved);
      if (unresolved) {
        clean = false;
        report.retained('container', short, `a bind source could not be resolved: ${unresolved.unresolved}`);
        retainWorktree(`container ${short} has a bind source that could not be resolved`);
      }
      continue;
    }
    const steps = record.State?.Running === true ? ['stop', 'rm'] : ['rm'];
    for (const step of steps) {
      if (retainUnverified(short)) break;
      const result = docker.command(step, record.Id);
      if (result.status === 0 && step === 'rm') {
        gone.add(record.Id);
        report.removed('container', short);
      }
      if (result.status === 0) continue;
      if (result.status !== undefined && VANISHED.exec(firstLine(result.stderr))?.[1] === record.Id) {
        gone.add(record.Id);
        report.absent('container', short);
      } else {
        clean = false;
        report.retained('container', short, `docker ${step} failed: ${describe(result)}`);
        retainWorktree(`container ${short} could not be removed`);
      }
      break;
    }
  }
  return { gone, clean };
}

// The entries of `git status --porcelain -z`, each { code, path }, a rename's or copy's source dropped; null when
// any entry is unreadable.
export function parseStatusEntries(stdout) {
  const fields = stdout.split('\0');
  if (fields.pop() !== '') return null;
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = /^([ MTADRCU?!]{2}) (.+)$/s.exec(fields[index]);
    if (!entry) return null;
    const [, code, path] = entry;
    if (/[RC]/.test(code) && !fields[(index += 1)]) return null;
    entries.push({ code, path });
  }
  return entries;
}

// Requires ordinary index flags as well as status showing only regenerated ignored directories: ordinary removal
// deletes ignored files and edits hidden by skip-worktree or assume-unchanged without refusing.
function removeWorktree(git, worktree, regenerated, retainWorktree, verify) {
  const status = git('-C', worktree.path, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching');
  if (status.status !== 0) return retainWorktree(`git status failed: ${describe(status)}`);
  const entries = parseStatusEntries(status.stdout);
  if (!entries) return retainWorktree('git status printed an unreadable entry');
  const held = entries
    .filter(({ code, path }) => !(code === '!!' && path.endsWith('/') && regenerated.includes(path.slice(0, -1))))
    .map(({ code, path }) => `"${code} ${path}"`);
  if (held.length) {
    const more = held.length > 5 ? ` and ${held.length - 5} more` : '';
    return retainWorktree(`git status lists ${held.slice(0, 5).join(', ')}${more}`);
  }
  const index = git('-C', worktree.path, 'ls-files', '-v', '-z');
  if (index.status !== 0) return retainWorktree(`could not read git index flags: ${describe(index)}`);
  if (index.stderr !== '' || index.stdout !== '' && (!index.stdout.endsWith('\0') ||
    !index.stdout.slice(0, -1).split('\0').every((record) => record.startsWith('H ') && record.length > 2))) {
    return retainWorktree('git index flags are hidden or unreadable; inspect git ls-files -v, resolve index flags and review local changes before retrying');
  }
  const unverified = verify();
  if (unverified) return retainWorktree(unverified);
  const removal = git('worktree', 'remove', worktree.path);
  if (removal.status !== 0) return retainWorktree(describe(removal));
  const listing = git('worktree', 'list', '--porcelain', '-z');
  const records = listing.status === 0 ? parseWorktreeList(listing.stdout) : null;
  if (!records) return retainWorktree(`could not confirm its removal: ${listing.status === 0 ? 'an unreadable record' : describe(listing)}`);
  if (records.some(({ path }) => path === worktree.path)) return retainWorktree('git still registers it after its removal');
  return undefined;
}

// One named scratch target, stopping at the first check that fails: { absent: true }, or { retained, forms } where
// retained is the reason it was kept or null once it is removed, and forms are the target as given and canonical.
function removeScratch(path, context) {
  const target = readTarget(path);
  if (target.absent || target.retained) return target;
  const { before, canonical, forms } = target;
  const inside = Boolean(context.worktree?.canonical) && atOrBelow(canonical, context.worktree.canonical);
  const retained = placeRetention(forms, context) ?? useChecks(path, forms, inside, before.isDirectory(), context)?.reason ??
    context.docker.verify() ?? removal(path, before);
  return { retained, forms };
}

// A target read for the first time: { absent: true }, { retained, forms } when it cannot be read or resolved, else
// { before, canonical, forms } with its lstat, its canonical path and both forms of it.
function readTarget(path) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { absent: true };
    return { retained: `could not be read: ${error.code ?? error.message}`, forms: [path] };
  }
  let canonical;
  try {
    canonical = join(realpathSync(dirname(path)), basename(path));
  } catch (error) {
    return { retained: `could not be resolved: ${error.code ?? error.message}`, forms: [path] };
  }
  return { before, canonical, forms: unique([path, canonical]) };
}

// Whether anything uses the target, in the order a removal checks: { reason, inUse } for the first container,
// lsof or process check that holds it (inUse when it found a use, else it could not tell), or null.
function useChecks(path, forms, inside, directory, { seams, docker, containers }) {
  return containerRetention(forms, inside, { docker, containers }) ?? useRetention(path, forms, directory, seams.run) ??
    processRetention(forms, seams);
}

const unverifiable = (reason) => ({ reason, inUse: false });
const found = (reason) => ({ reason, inUse: true });

// A path as given and canonical, { forms }, or { unresolved } with the reason it could not be resolved.
function pathForms(path) {
  const canonical = canonicalPath(path);
  return canonical.unresolved ? canonical : { forms: unique([path, canonical.path]) };
}

// The reason the target's place forbids its removal, or null: it holds the home or the working directory or a
// registered worktree, or git tracks something at or below it in a worktree it lies in.
function placeRetention(forms, { seams, git, records }) {
  for (const [place, reason] of [[seams.home, 'holds the home directory'], [seams.cwd, 'holds the working directory']]) {
    const resolved = pathForms(place);
    if (resolved.unresolved) return `could not be compared with ${place}: ${resolved.unresolved}`;
    if (relates(resolved.forms, forms, ['equal', 'below'])) return reason;
  }
  const worktrees = [];
  for (const { path } of records) {
    const resolved = pathForms(path);
    if (resolved.unresolved) return `could not be compared with the registered worktree ${path}: ${resolved.unresolved}`;
    if (relates(resolved.forms, forms, ['equal', 'below'])) return `holds the registered worktree ${path}`;
    worktrees.push({ path, places: resolved.forms });
  }
  for (const { path, places } of worktrees) {
    const within = places.flatMap((place) => forms.filter((form) => pathRelation(form, place) === 'below').map((form) => relative(place, form)));
    for (const target of unique(within)) {
      const listed = git('--literal-pathspecs', '-C', path, 'ls-files', '-z', '--', target);
      if (listed.status !== 0) return `git ls-files failed: ${describe(listed)}`;
      if (listed.stdout !== '') return 'holds tracked files';
    }
  }
  return null;
}

// The hold a container puts on the target, or null. Inside the job worktree step 5 already removed every
// container bound there unless it met a problem; outside it, every container still present is read whole.
function containerRetention(forms, inside, { docker, containers }) {
  if (docker.absent) return null;
  if (docker.failure) return unverifiable(`docker failed: ${docker.failure}`);
  const unverified = docker.verify();
  if (unverified) return unverifiable(unverified);
  if (inside) return containers.clean ? null : unverifiable('a container bound in the job worktree was not removed');
  for (const record of docker.records.filter(({ Id }) => !containers.gone.has(Id))) {
    const short = record.Id.slice(0, 12);
    const sources = bindSources(record).map(canonicalPath);
    if (relates(sources.map(({ path }) => path).filter(Boolean), forms, ['equal', 'below', 'above'])) return found(`container ${short} binds it`);
    if (sources.some(({ unresolved }) => unresolved)) return unverifiable(`container ${short} has a bind source that could not be resolved`);
    if (recordNames(record, forms)) return found(`container ${short} names it`);
  }
  return null;
}

// The hold a process with the target or something below it open puts on it, or null; lsof is read as readLsof says.
// `-x f` makes +D cross into file systems mounted below the target. lsof lists only processes using the target, and
// may escape bytes of the names it prints, so every row it returns is a use whatever its names read.
function useRetention(path, forms, directory, run) {
  const lsof = readLsof(run('lsof', directory ? ['-nP', '-Fpcfn', '-x', 'f', '+D', path] : ['-nP', '-Fpcfn', path]), forms);
  if (lsof.retain) return unverifiable(lsof.retain);
  const [user] = lsof.processes;
  return user ? found(`pid ${user.pid} (${user.command}) uses it`) : null;
}

// The hold a process other than this command and its ancestors puts on the target by naming it in its arguments, or
// null. The listing is read only from a ps run that exited 0. The arguments are not reported, since they may carry
// secrets.
function processRetention(forms, { run, pid }) {
  const ps = run('ps', ['-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']);
  if (ps.absent) return unverifiable('no process check: ps is not installed');
  if (ps.failed) return unverifiable(`ps failed: ${ps.failed}`);
  if (ps.status !== 0) return unverifiable(`ps failed: ${describe(ps)}`);
  const rows = parsePs(ps.stdout);
  if (!rows) return unverifiable('ps printed a row that could not be read');
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const ancestors = new Set();
  for (let current = String(pid); current !== undefined && !ancestors.has(current); current = parents.get(current)) {
    ancestors.add(current);
  }
  const user = rows.find((row) => !ancestors.has(row.pid) && forms.some((form) => names(row.args, form)));
  return user ? found(`pid ${user.pid} names it in its arguments`) : null;
}

// Whether text names the path: holds it followed by its end or a character no path component continues with.
function names(text, path) {
  for (let index = text.indexOf(path); index !== -1; index = text.indexOf(path, index + 1)) {
    if (!/[A-Za-z0-9._-]/.test(text.charAt(index + path.length))) return true;
  }
  return false;
}

// Whether any key or string in a container record, walked whole, names one of the paths.
function recordNames(value, forms) {
  if (typeof value === 'string') return forms.some((form) => names(value, form));
  if (Array.isArray(value)) return value.some((item) => recordNames(item, forms));
  if (isObject(value)) return Object.entries(value).some(([key, item]) => recordNames(key, forms) || recordNames(item, forms));
  return false;
}

// Removes the target unless it changed since it was first read; a link is removed, never followed.
function removal(path, before) {
  let after;
  try {
    after = lstatSync(path);
  } catch (error) {
    return `could not be read again: ${error.code ?? error.message}`;
  }
  const type = (stats) => stats.mode & constants.S_IFMT;
  if (after.dev !== before.dev || after.ino !== before.ino || type(after) !== type(before)) return 'it changed during the checks';
  try {
    if (before.isDirectory()) rmSync(path, { recursive: true });
    else unlinkSync(path);
  } catch (error) {
    const partly = before.isDirectory() ? '; some contents may already be gone' : '';
    return `removal failed: ${error.code ?? error.message}${partly}`;
  }
  return null;
}
