// closeout-cleanup.mjs — the checks and removals behind scripts/closeout-cleanup.mjs.
//
// Every external call goes through one injected `run`, and each answers only the argument vectors this file
// builds. Every check fails closed: an absent tool, a failed run, unrecognised output or an unresolved path
// retains the target it was checking. Forced deletion is limited to the exact verified merged-PR job branch.

import { spawnSync } from 'node:child_process';
import {
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isGithubRepository } from './factory-sync.mjs';
import { LINEAR_IDENTIFIER } from './tracker.mjs';

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const VANISHED = /^Error(?: response from daemon)?: No such container: ([0-9a-f]{64})$/;
const LSOF_WARNING = /^lsof: WARNING: can't stat\(\) \S+ file system (\/.*)$/;
const LSOF_INCOMPLETE = '      Output information may be incomplete.';
// eslint-disable-next-line no-control-regex -- a path argument holding a control character is refused
const CONTROL = /[\u0000-\u001f\u007f]/;
const WORKTREE_ATTRIBUTES = new Set(['HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable']);
const NON_BIND_MOUNT_TYPES = new Set(['volume', 'tmpfs', 'npipe', 'cluster', 'image']);
// Only a name this plain reaches the command line; any other, whatever Docker would accept, is refused as unreadable.
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DATA_VOLUME = '/System/Volumes/Data';
const ABOVE_FIRMLINKS = new Set([DATA_VOLUME, '/System/Volumes', '/System']);
const realpath = process.platform === 'darwin' ? macRealpath : realpathSync;

// macOS's own call returns the on-disk letter case and Unicode form, which Node's JS version keeps as given. The Data
// volume's spelling of a firmlinked folder is that same folder, and a bind at that volume or above it holds every one.
function macRealpath(path) {
  const resolved = realpathSync.native(path);
  if (ABOVE_FIRMLINKS.has(resolved)) return '/';
  if (!resolved.startsWith(`${DATA_VOLUME}/`)) return resolved;
  const plain = resolved.slice(DATA_VOLUME.length);
  const plainStat = statSync(plain, { bigint: true, throwIfNoEntry: false });
  const resolvedStat = statSync(resolved, { bigint: true });
  return plainStat?.dev === resolvedStat.dev && plainStat?.ino === resolvedStat.ino ? plain : resolved;
}

function parsePr(value) {
  try {
    const url = new URL(value);
    const path = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
    if (!path || url.origin !== 'https://github.com' || url.username || url.password || url.port ||
      value !== `https://github.com${url.pathname}`) return null;
    return { url: value, repository: `${path[1]}/${path[2]}`, number: path[3] };
  } catch {
    return null;
  }
}

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

// { issue, scratch, regenerated, pr? } for a job, or { check } for a read-only check of paths, duplicates dropped in order,
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
        pr: { type: 'string', multiple: true },
      },
    });
  } catch (error) {
    return { error: error.message };
  }
  const { positionals, values } = parsed;
  if (values.check) {
    if (positionals.length || values.scratch || values.regenerated || values.pr) return { error: '--check takes no issue number and no other flag' };
    const check = unique(values.check);
    const badCheck = check.find((path) => !isCleanAbsolute(path));
    if (badCheck !== undefined) return { error: `--check needs a normalized absolute path: ${JSON.stringify(badCheck)}` };
    return { check };
  }
  if (positionals.length !== 1 || !(POSITIVE_INTEGER.test(positionals[0]) || LINEAR_IDENTIFIER.test(positionals[0]))) {
    return { error: 'expected exactly one issue number or Linear issue ID' };
  }
  const pr = values.pr?.length === 1 ? parsePr(values.pr[0]) : null;
  if (values.pr && !pr) return { error: '--pr needs exactly one canonical HTTPS GitHub pull request URL' };
  const scratch = unique(values.scratch ?? []);
  const regenerated = unique(values.regenerated ?? []);
  const badScratch = scratch.find((path) => !isCleanAbsolute(path));
  if (badScratch !== undefined) return { error: `--scratch needs a normalized absolute path: ${JSON.stringify(badScratch)}` };
  const badRegenerated = regenerated.find((path) => !isCleanRelative(path));
  if (badRegenerated !== undefined) {
    return { error: `--regenerated needs a normalized path inside the worktree: ${JSON.stringify(badRegenerated)}` };
  }
  return { issue: positionals[0], scratch, regenerated, ...(pr ? { pr } : {}) };
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
    hasRetentions() {
      return retained > 0;
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

// Job mode: the job's containers, named scratch, worktree, Codex's empty outer folder and branch, each removed only when every check passes.
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
  const codexFolder = worktree && !worktree.retained ? codexOuterFolder(worktree, seams) : null;
  if (worktree && !worktree.retained) removeWorktree(context, request.regenerated, retainWorktree, docker.verify);
  if (!worktree) report.absent('worktree', job);
  else if (worktree.retained) report.retained('worktree', worktree.path, worktree.retained);
  else report.removed('worktree', worktree.path);
  // Judged before the branch, so a retained outer folder stops the merged PR exception below.
  if (codexFolder && !worktree.retained) removeCodexOuterFolder(codexFolder, context, report);

  if (!branchPresent) {
    report.absent('branch', job);
  } else if (worktree?.retained) {
    report.retained('branch', job, 'its worktree is retained');
  } else {
    const unverified = docker?.failure ? `docker failed: ${docker.failure}` : docker?.verify();
    if (unverified) report.retained('branch', job, unverified);
    else {
      const deletion = request.pr
        ? seams.run(seams.git.command, ['branch', '-d', job], { env: { ...seams.git.env, LC_ALL: 'C' } })
        : git('branch', '-d', job);
      if (deletion.status === 0) report.removed('branch', job);
      else if (request.pr && !report.hasRetentions() && notFullyMerged(deletion, job)) {
        const reason = removeMergedBranch(request.pr, job, context);
        if (reason) report.retained('branch', job, reason);
        else {
          report.line(`verified merged PR exception for branch ${job}`);
          report.removed('branch', job);
        }
      } else report.retained('branch', job, describe(deletion));
    }
  }
  return report.finish();
}

function notFullyMerged(result, job) {
  if (result.status !== 1 || result.stdout !== '') return false;
  const error = `error: the branch '${job}' is not fully merged`;
  const advice = `If you are sure you want to delete it, run 'git branch -D ${job}'`;
  return [
    `error: The branch '${job}' is not fully merged.\n${advice}.\n`,
    `${error}.\n${advice}\n`,
    `${error}\nhint: ${advice}\nhint: Disable this message with "git config advice.forceDeleteBranch false"\n`,
    `${error}\nhint: ${advice}\nhint: Disable this message with "git config set advice.forceDeleteBranch false"\n`,
    `${error}\nhint: ${advice}\n`,
    `${error}\n`,
  ].includes(result.stderr);
}

// Only this exact delivered head is disposable; squash ancestry cannot establish head identity.
function removeMergedBranch(pr, job, { seams, git, docker }) {
  const observedLine = (result) => completeCommand(result) && completeLine(result.stdout);
  const origin = git('remote', 'get-url', 'origin');
  const remote = observedLine(origin);
  if (!remote || !isGithubRepository(remote, pr.repository)) return 'merged PR exception: origin does not verify the requested repository';
  const main = observedLine(git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'));
  if (!main || !COMMIT.test(main)) return 'merged PR exception: fetched main commit is unavailable';
  const metadata = seams.run('gh', ['pr', 'view', pr.number, '--repo', `github.com/${pr.repository}`, '--json',
    'state,mergedAt,mergeCommit,headRefName,headRefOid,isCrossRepository,baseRefName,url'],
  { env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (!completeCommand(metadata)) return 'merged PR exception: pull request metadata is unavailable';
  let proof;
  try {
    proof = JSON.parse(metadata.stdout);
  } catch {
    return 'merged PR exception: pull request metadata is unreadable';
  }
  if (!isObject(proof) || proof.url !== pr.url || proof.state !== 'MERGED' || proof.isCrossRepository !== false ||
    proof.headRefName !== job || proof.baseRefName !== 'main' || typeof proof.headRefOid !== 'string' ||
    !COMMIT.test(proof.headRefOid) || !isObject(proof.mergeCommit) || typeof proof.mergeCommit.oid !== 'string' ||
    !COMMIT.test(proof.mergeCommit.oid) || !validMergeTimestamp(proof.mergedAt)) {
    return 'merged PR exception: pull request metadata does not verify this merged job';
  }
  const ancestry = git('merge-base', '--is-ancestor', proof.mergeCommit.oid, main);
  if (!completeCommand(ancestry) || ancestry.stdout !== '') return 'merged PR exception: merge commit is not verified in fetched main';
  const tip = () => observedLine(git('rev-parse', '--verify', `refs/heads/${job}`));
  if (tip() !== proof.headRefOid) return 'merged PR exception: branch tip does not match the delivered head';
  const listing = git('worktree', 'list', '--porcelain', '-z');
  const records = completeCommand(listing) && parseWorktreeList(listing.stdout);
  if (!records || records.some(({ branch }) => branch === `refs/heads/${job}`)) return 'merged PR exception: branch worktree occupancy is not clear';
  const unverified = docker?.failure ? `docker failed: ${docker.failure}` : docker?.verify();
  if (unverified) return unverified;
  if (tip() !== proof.headRefOid) return 'merged PR exception: branch tip changed before deletion';
  const deletion = git('branch', '-D', '--', job);
  if (!completeCommand(deletion)) return 'merged PR exception: exact branch deletion failed';
  const absent = git('rev-parse', '--verify', '--quiet', `refs/heads/${job}`);
  if (absent.status !== 1 || absent.stdout !== '' || absent.stderr !== '') return 'merged PR exception: branch absence could not be verified';
  return null;
}

function validMergeTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
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
// printed anything unrecognised, else { records, command, verify, sources, volumeDevices, readsBindNames } with pinned
// local filesystem authority, sources(record) being the canonical host paths that record binds, each mounted volume's
// bind device included, and volumeDevices(record) the devices as the volumes print them. readsBindNames holds on Docker
// Desktop, where a mount field may spell a host path in a form sources cannot read.
function dockerSnapshot({ run, platform, home }) {
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
  const proof = proveDockerFilesystem(endpoint.Host, run, platform, env, home);
  if (proof.failure) return proof;
  const command = (...args) => run('docker', ['--host', proof.host, ...args], { env });
  const finish = (records) => {
    const volumes = new Map(unique(records.flatMap(volumeNames)).map((name) => [name, readVolume(name, command)]));
    const read = (record) => volumeNames(record).map((name) => volumes.get(name)).filter(Boolean);
    return {
      records,
      verify: proof.verify,
      command,
      readsBindNames: proof.readsBindNames,
      sources: (record) => [
        ...bindSources(record).map((source) => canonicalPath(proof.hostPath(source))),
        ...read(record).map((volume) => volume.unresolved ? volume : canonicalPath(proof.hostPath(volume.device))),
      ],
      volumeDevices: (record) => read(record).map(({ device }) => device).filter((device) => typeof device === 'string'),
    };
  };
  const list = command('container', 'ls', '--all', '--quiet', '--no-trunc');
  if (list.status !== 0) return { failure: describe(list) };
  const ids = list.stdout.split('\n').filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID.test(id))) return { failure: 'docker listed an unrecognised container ID' };
  if (!ids.length) return finish([]);
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
  return finish(records);
}

const dockerUnverifiable = (stage) => `Docker filesystem relationship is unverifiable: ${stage}`;
const fail = (stage) => ({ failure: dockerUnverifiable(stage) });
const nativeEnvironment = (env) => ({ ...(env.PATH === undefined ? {} : { PATH: env.PATH }), LC_ALL: 'C' });
// Docker Desktop reports a host path under its virtual machine's mount of the host.
const desktopHostPath = (source) => {
  if (source === '/host_mnt') return '/';
  return typeof source === 'string' && source.startsWith('/host_mnt/') ? source.slice('/host_mnt'.length) : source;
};
const completeCommand = (result) => result.status === 0 && result.stderr === '';
const completeLine = (text) => typeof text === 'string' && text.endsWith('\n') && !text.slice(0, -1).includes('\n') ? text.slice(0, -1) : null;
const isCleanPosixAbsolute = (path) =>
  posix.isAbsolute(path) && path === posix.normalize(path) && (path === '/' || !path.endsWith('/')) && !CONTROL.test(path);
const safeSocketPath = (path) => typeof path === 'string' && /^\/[A-Za-z0-9/._-]*$/.test(path) && isCleanPosixAbsolute(path);

// The user service manager's units do not inherit no_new_privs. --pipe with --wait returns the command's streams and
// exit status, oneshot makes a signal-killed command a failure, --quiet keeps systemd-run's notices out of stderr,
// --collect leaves no failed unit, --no-ask-password never prompts and --setenv keeps the parse locale.
// --expand-environment=no is omitted: it needs systemd 254 and no operand holds a $, since socket paths pass
// safeSocketPath and the rest are digits and literals.
const SERVICE_MANAGER_ROUTE = ['--user', '--pipe', '--wait', '--quiet', '--collect', '--no-ask-password',
  '--service-type=oneshot', '--setenv=LC_ALL=C', '--'];
const NO_NEW_PRIVS_REFUSAL = 'no_new_privs blocks sudo in this process and the user service manager route did not complete';

// This process's no_new_privs flag and real user from its /proc status, or null unless each appears once in its canonical form.
function processPrivilege(stdout) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')) return null;
  const lines = stdout.slice(0, -1).split('\n');
  const only = (prefix, pattern) => {
    const matching = lines.filter((line) => line.startsWith(prefix));
    return matching.length === 1 ? pattern.exec(matching[0]) : null;
  };
  const flag = only('NoNewPrivs:', /^NoNewPrivs:\t([01])$/);
  const user = only('Uid:', /^Uid:\t(0|[1-9][0-9]*)\t[0-9]+\t[0-9]+\t[0-9]+$/);
  return flag && user ? { noNewPrivs: flag[1] === '1', uid: user[1] } : null;
}

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

// A verifier that re-observes until the first failure or change, and from then on repeats that reason.
function latchedVerify(observe, identity) {
  let failure = null;
  return () => {
    if (!failure) {
      const current = observe();
      if (current.failure) failure = dockerUnverifiable(`native identity changed or became unreadable: ${current.failure}`);
      else if (current.identity !== identity) failure = dockerUnverifiable('native identity changed since initial observation');
    }
    return failure;
  };
}

// BSD stat's `<type>:<owner>:<device>:<inode>` rows as { type, owner }, or null unless exactly `count` complete rows.
function desktopStatRows(stdout, count) {
  if (!stdout.endsWith('\n')) return null;
  const rows = stdout.slice(0, -1).split('\n').map((line) => /^([A-Za-z ]+):([0-9]+):[0-9]+:[0-9]+$/.exec(line));
  return rows.length === count && rows.every(Boolean) ? rows.map(([, type, owner]) => ({ type, owner })) : null;
}

// The server name `docker version` printed as its one JSON string line, or null.
function desktopDaemonName(result) {
  if (!completeCommand(result)) return null;
  try {
    const name = JSON.parse(completeLine(result.stdout));
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

// A local Docker Desktop proof and a latched verifier. Desktop's daemon runs in a virtual machine, so this identifies
// the endpoint and compares no namespaces: the exact socket of this home, in real directories, all this user's, whose
// daemon names itself Docker Desktop. A daemon that does not answer is reported, never classified as stopped, because
// its containers' binds cannot be read without it.
function proveDesktopFilesystem(host, run, env, home) {
  const directory = join(home, '.docker');
  const socket = join(directory, 'run', 'docker.sock');
  if (host !== `unix://${socket}`) return fail('unsupported endpoint');
  const nativeEnv = nativeEnvironment(env);
  const caller = run('/usr/bin/id', ['-u'], { env: nativeEnv });
  const owner = completeCommand(caller) ? completeLine(caller.stdout) : null;
  if (!owner || !/^[0-9]+$/.test(owner)) return fail('caller identity observation did not complete cleanly');
  const socketMalformed = { failure: 'Docker Desktop socket observation is unsupported or malformed' };
  const observe = () => {
    const stat = run('/usr/bin/stat', ['-f', '%HT:%u:%d:%i', '--', directory, join(directory, 'run'), socket], { env: nativeEnv });
    const clean = completeCommand(stat);
    // A stat that fails on one path still prints the rows of the others. Desktop removes its socket on a clean stop.
    if (!clean && !(stat.status > 0 && stat.stdout)) return { failure: 'Docker Desktop socket observation did not complete cleanly' };
    const socketMissing = !clean && stat.stderr === `stat: ${socket}: stat: No such file or directory\n`;
    if (!clean && !socketMissing) return socketMalformed;
    const rows = desktopStatRows(stat.stdout, socketMissing ? 2 : 3);
    if (!rows) return socketMalformed;
    if (rows.some((row, index) => row.owner !== owner || row.type !== ['Directory', 'Directory', 'Socket'][index])) {
      return { failure: 'Docker Desktop socket is not a socket this user owns in real directories' };
    }
    const version = run('docker', ['--host', host, 'version', '--format', '{{json .Server.Platform.Name}}'], { env });
    if (version.status !== 0) {
      return { failure: `Docker Desktop daemon did not answer: ${describe(version)}; no stopped container's binds can be read without it, so run this again once it answers` };
    }
    if (socketMissing) return socketMalformed;
    const name = desktopDaemonName(version);
    if (name === null) return { failure: 'daemon identity observation is unsupported or malformed' };
    if (!name.startsWith('Docker Desktop ')) return { failure: 'daemon does not report itself as Docker Desktop' };
    return { identity: `${stat.stdout}${name}` };
  };
  const initial = observe();
  if (initial.failure) return fail(initial.failure);
  return { host, hostPath: desktopHostPath, readsBindNames: true, verify: latchedVerify(observe, initial.identity) };
}

// A local filesystem proof and a latched verifier: Linux below, Docker Desktop on macOS, every other platform refused.
// Native observation never inherits redirection variables.
function proveDockerFilesystem(host, run, platform, env, home) {
  if (platform === 'darwin') return proveDesktopFilesystem(host, run, env, home);
  const original = host.slice(7);
  if (platform !== 'linux' || !host.startsWith('unix://') || !safeSocketPath(original)) return fail('unsupported endpoint');
  const nativeEnv = nativeEnvironment(env);
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
  const sudoArgs = (command, args) => ['-kn', '-u', 'root', '-g', 'root', '--', `/usr/bin/${command}`, ...args];
  // Chosen on the first privileged retry from this process's no_new_privs flag, then pinned for every recheck.
  let privileged;
  let refusal = '';
  const statArgs = ['-L', '-c', '%d:%i:%Hd:%Ld:%F', '--'];
  const observationTypes = ['socket', 'namespace', 'directory', 'regular file'];
  const callerObservation = (expected) => native('stat', [...statArgs, socket, '/proc/self/ns/mnt', '/', expected]);
  const observe = (mode, initial = false) => {
    const result = mode === 'native' ? native('ss', ssArgs) : privileged('ss', ssArgs);
    if (!completeCommand(result)) return { failure: mode === 'native'
      ? 'listener observation command did not complete cleanly' : `passwordless listener observation was unavailable${refusal}` };
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
        // Caller identity must remain unprivileged: the privileged observer's namespace and root are not the caller's.
        const local = callerObservation(expected);
        if (!completeCommand(local)) return { failure: 'caller filesystem identity observation command did not complete cleanly' };
        if (!dockerIdentityRows(local.stdout, observationTypes)) return { failure: 'caller filesystem identity observation is unsupported or malformed' };
        const remote = privileged('stat', [...statArgs, `/proc/${pid}/fd/${fd}`, `/proc/${pid}/ns/mnt`, `/proc/${pid}/root`, `/proc/${pid}/exe`]);
        if (!completeCommand(remote)) return { failure: `passwordless ${role} filesystem identity observation was unavailable${refusal}` };
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
    // cat inherits this process's no_new_privs flag and user, so its own status is this process's.
    const status = native('cat', ['/proc/self/status']);
    if (!completeCommand(status)) return fail('process privilege status observation command did not complete cleanly');
    const privilege = processPrivilege(status.stdout);
    if (!privilege) return fail('process privilege status observation is unsupported or malformed');
    if (privilege.noNewPrivs) {
      const routeEnv = { ...nativeEnv, XDG_RUNTIME_DIR: `/run/user/${privilege.uid}` };
      privileged = (command, args) =>
        run('/usr/bin/systemd-run', [...SERVICE_MANAGER_ROUTE, '/usr/bin/sudo', ...sudoArgs(command, args)], { env: routeEnv });
      refusal = `: ${NO_NEW_PRIVS_REFUSAL}`;
    } else {
      privileged = (command, args) => native('/usr/bin/sudo', sudoArgs(command, args));
    }
    mode = 'privileged';
    initial = observe(mode);
  }
  if (initial.failure) return fail(initial.failure);
  return {
    host: `unix://${socket}`,
    hostPath: (source) => source,
    verify: latchedVerify(() => observe(mode), initial.identity),
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

// The volume names a container record mounts: Mounts and HostConfig.Mounts of type volume, and each HostConfig.Binds
// entry whose host part is not a path. An anonymous HostConfig.Mounts volume has no Source and is read by its Name in
// Mounts. A missing or malformed name stays in the list, to be refused as unreadable.
function volumeNames(record) {
  const list = (value) => Array.isArray(value) ? value : [];
  return [
    ...list(record.Mounts).filter((mount) => isObject(mount) && mount.Type === 'volume').map(({ Name }) => Name),
    ...list(record.HostConfig?.Mounts)
      .filter((mount) => isObject(mount) && mount.Type === 'volume' && mount.Source !== undefined && mount.Source !== '')
      .map(({ Source }) => Source),
    ...list(record.HostConfig?.Binds)
      .filter((bind) => typeof bind === 'string' && !bind.startsWith('/'))
      .map((bind) => bind.split(':', 1)[0]),
  ];
}

// What `docker volume inspect` says of one mounted volume: null when its options bind no device, { device } when the
// local driver's `o` list holds bind or rbind, or { unresolved } with the reason the volume cannot be trusted.
function readVolume(name, command) {
  if (typeof name !== 'string' || !VOLUME_NAME.test(name)) return { unresolved: 'a volume name is unreadable' };
  const unreadable = (why) => ({ unresolved: `volume ${name} options could not be read: ${why}` });
  const result = command('volume', 'inspect', '--format', '{{json .}}', name);
  if (result.status !== 0) return unreadable(describe(result));
  let volume;
  try {
    volume = JSON.parse(result.stdout);
  } catch {
    return unreadable('docker printed no readable record');
  }
  const readable = isObject(volume) && volume.Name === name && typeof volume.Driver === 'string' && volume.Driver.trim() &&
    (volume.Options === null || (isObject(volume.Options) && (volume.Options.o === undefined || typeof volume.Options.o === 'string')));
  if (!readable) return unreadable('docker printed no readable record');
  const { Driver: driver, Options: options } = volume;
  if (!options?.o?.split(',').some((flag) => flag === 'bind' || flag === 'rbind')) return null;
  if (driver !== 'local') return { unresolved: `volume ${name} uses driver ${driver}, whose bind options cannot be trusted` };
  return { device: options.device };
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
      return { path: join(realpath(prefix), ...missing) };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { unresolved: error.code ?? error.message };
      missing.unshift(basename(prefix));
    }
  }
}

const CODEX_MARKER = '.codex-worktree-name';

const CODEX_ROOT_KEY = 'git-worktree-root';
// Rust's str::trim, which Codex applies to the root: Unicode White_Space at either end, so U+0085 goes and U+FEFF stays.
const RUST_TRIM = /^\p{White_Space}+|\p{White_Space}+$/gu;

// The vendored TOML parser: { parse }, or { unavailable } with why it could not be loaded.
function loadTomlParser(path) {
  try {
    return { parse: createRequire(import.meta.url)(path).parse };
  } catch (error) {
    return { unavailable: error.code ?? error.message };
  }
}

// Codex's worktree root setting in its user settings file: {} when nothing is at the path or the file names no root
// or a blank one, { root } with the trimmed value, or { unusable } with why the file or its value cannot be used.
function codexRootSetting(file, parserPath) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' && !lstatSync(file, { throwIfNoEntry: false })) return {};
    return { unusable: `config.toml could not be read: ${error.code ?? error.message}` };
  }
  if (!stat.isFile()) return { unusable: 'config.toml is not a regular file' };
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { unusable: `config.toml could not be read: ${error.code ?? error.message}` };
  }
  const parser = loadTomlParser(parserPath);
  if (parser.unavailable) return { unusable: `the TOML parser could not be loaded: ${parser.unavailable}` };
  let config;
  try {
    config = parser.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { unusable: 'config.toml is not valid TOML' };
  }
  if (!Object.hasOwn(config, 'desktop')) return {};
  // A TOML table parses to an object with no prototype; an array, a date or any other value does not.
  if (Object.getPrototypeOf(config.desktop) !== null) return { unusable: 'desktop is not a table' };
  if (!Object.hasOwn(config.desktop, CODEX_ROOT_KEY)) return {};
  const value = config.desktop[CODEX_ROOT_KEY];
  if (typeof value !== 'string') return { unusable: 'its value is not a string' };
  const root = value.replace(RUST_TRIM, '');
  if (root === '') return {};
  if (!isCleanAbsolute(root)) return { unusable: 'its value is not a normalized absolute path' };
  return { root };
}

// Codex's worktree root for the session, read from its user settings file alone, never its other configuration
// layers: the [desktop] root of $CODEX_HOME/config.toml, else $CODEX_HOME/worktrees, with ~/.codex for an empty
// CODEX_HOME. { root } canonical; { unusable } with why the setting names no root, a CODEX_HOME (or the home folder
// standing in for an empty one) that is not a normalized absolute path included; null only when the default root
// cannot be resolved, which no resolved worktree can sit inside.
function codexWorktreeRoot({ codexHome, home, tomlParserPath }) {
  const source = codexHome === '' ? home : codexHome;
  if (!isCleanAbsolute(source)) {
    return { unusable: `${codexHome === '' ? 'the home folder' : 'CODEX_HOME'} is not a normalized absolute path` };
  }
  const base = codexHome === '' ? join(source, '.codex') : source;
  const setting = codexRootSetting(join(base, 'config.toml'), tomlParserPath);
  if (setting.unusable) return setting;
  if (setting.root) {
    const resolved = canonicalPath(setting.root);
    return resolved.path ? { root: resolved.path } : { unusable: `its value could not be resolved: ${resolved.unresolved}` };
  }
  const root = canonicalPath(join(base, 'worktrees')).path;
  return root ? { root } : null;
}

// The job worktree's parent when it sits directly inside Codex's worktree root, read before the worktree is removed
// so its removal can tell the same folder from a replacement: { path, forms, before } or { path, forms, unreadable },
// with `unusable` when the settings of Codex name no usable root, which makes every parent a candidate so that a marked
// one is retained; null for any other parent.
function codexOuterFolder(worktree, seams) {
  const path = dirname(worktree.canonical);
  const { root, unusable } = codexWorktreeRoot(seams) ?? {};
  if (!unusable && (!root || dirname(path) !== root)) return null;
  const forms = unique([dirname(worktree.path), path]);
  try {
    return { path, forms, before: lstatSync(path), unusable };
  } catch (error) {
    return { path, forms, unreadable: error.code ?? error.message, unusable };
  }
}

// What the outer folder holds, read without following a link: { marker } with the marker's lstat when it holds only
// Codex's empty marker, { unmarked } when the marker is not there, or { reason } to retain it.
function outerContents(path) {
  let entries;
  let marker;
  try {
    entries = readdirSync(path);
    if (!entries.includes(CODEX_MARKER)) return { unmarked: true };
    marker = lstatSync(join(path, CODEX_MARKER));
  } catch (error) {
    return { reason: `could not be read: ${error.code ?? error.message}` };
  }
  const others = entries.filter((entry) => entry !== CODEX_MARKER).sort();
  if (others.length) {
    const more = others.length > 1 ? ` and ${others.length - 1} more` : '';
    return { reason: `holds ${JSON.stringify(others[0])}${more}` };
  }
  if (!marker.isFile() || marker.size !== 0) return { reason: `its ${CODEX_MARKER} is not an empty file` };
  return { marker };
}

// Removes the Codex folder around a removed worktree when it holds only Codex's empty marker, nothing uses it, the
// Docker proof still holds and, read again after the checks, it is the folder read before the removal and still holds
// only the same empty marker: the marker, then the folder, never recursively. A folder without the marker is left with
// no line; every other outcome retains it with its reason; a marked folder is retained while the root setting of Codex
// is unusable.
function removeCodexOuterFolder({ path, forms, before, unreadable, unusable }, context, report) {
  const retain = (reason) => report.retained('outer folder', path, reason);
  if (unreadable) return retain(`could not be read: ${unreadable}`);
  const first = outerContents(path);
  if (first.unmarked) return;
  if (unusable) return retain(`Codex's worktree root setting is unusable: ${unusable}`);
  if (first.reason) return retain(first.reason);
  const held = useChecks(path, forms, false, true, context)?.reason ?? context.docker.verify();
  if (held) return retain(held);
  let after;
  try {
    after = lstatSync(path);
  } catch (error) {
    return retain(`could not be read again: ${error.code ?? error.message}`);
  }
  if (!sameEntry(before, after)) return retain('it changed during the checks');
  const last = outerContents(path);
  if (!last.marker || !sameEntry(first.marker, last.marker)) return retain(last.reason ?? 'it changed during the checks');
  try {
    unlinkSync(join(path, CODEX_MARKER));
  } catch (error) {
    return retain(`removal failed: ${error.code ?? error.message}`);
  }
  try {
    rmdirSync(path);
  } catch (error) {
    return retain(`removal failed: ${error.code ?? error.message}; its ${CODEX_MARKER} is already gone`);
  }
  report.removed('outer folder', path);
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
// A container whose process can still reach a parent folder of the target: only a record reading stopped has none.
const holdsFromAbove = (record, sources, forms) => record.State?.Running !== false &&
  relates(sources.map(({ path }) => path).filter(Boolean), forms, ['above']);

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

const unresolvedSource = (short, { unresolved }) => `container ${short} has a bind source that could not be resolved: ${unresolved}`;

// Stops and removes each container bound at or below the worktree, except a live one that is also bound above it,
// which is left running for containerRetention to hold; an unresolved source, which stops the container from being
// touched at all, a failed removal or, on Docker Desktop, a mount field naming the worktree where no source lies at or
// below it retains the worktree. "No such container" naming the container's own ID means it is already gone. Returns
// { gone, clean, unresolved }: the IDs no longer present, whether every container was settled with no such retention,
// and the first unresolved source's reason, undefined when none.
function removeWorktreeContainers(docker, worktree, report, retainWorktree) {
  const gone = new Set();
  let clean = true;
  let unresolvedReason;
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
    const sources = docker.sources(record);
    const unresolved = sources.find(({ unresolved }) => unresolved);
    if (unresolved) {
      clean = false;
      report.retained('container', short, `a bind source could not be resolved: ${unresolved.unresolved}`);
      const reason = unresolvedSource(short, unresolved);
      unresolvedReason ??= reason;
      retainWorktree(reason);
      continue;
    }
    const boundBelow = sources.some(({ path }) => path && atOrBelow(path, worktree.canonical));
    if (!boundBelow || holdsFromAbove(record, sources, [worktree.canonical])) {
      if (!boundBelow && docker.readsBindNames && recordNames(
        [record.Mounts, record.HostConfig?.Binds, record.HostConfig?.Mounts, docker.volumeDevices(record)],
        [worktree.path, worktree.canonical],
      )) {
        const reason = `container ${short} names it in a mount field no host path matched`;
        clean = false;
        report.retained('container', short, reason);
        retainWorktree(reason);
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
  return { gone, clean, unresolved: unresolvedReason };
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

// A standalone ignored link, or { retained } on an unsafe observation. A null reason leaves an ordinary entry
// held by the existing status diagnostic.
function readIgnoredLink(relative, worktree, records) {
  const path = join(worktree.path, relative);
  const target = readTarget(path);
  const retained = (reason) => ({ retained: `ignored entry ${relative}: ${reason}` });
  if (target.absent) return retained('could not be read: ENOENT');
  if (target.retained) return retained(target.retained);
  if (!target.before.isSymbolicLink()) return { retained: null };
  if (target.canonical !== join(worktree.canonical, relative)) return retained('has a symbolic-link parent');
  try {
    const linkText = readlinkSync(path);
    const destination = resolve(dirname(path), linkText);
    const resolved = realpath(path);
    if (relates([destination, resolved], [worktree.path, worktree.canonical], ['equal', 'below'])) {
      return retained('points inside its worktree');
    }
    for (const { path: other } of records.slice(1).filter(({ path }) => path !== worktree.path)) {
      let canonical;
      try {
        canonical = realpath(other);
      } catch (error) {
        return retained(`could not resolve another linked worktree ${other}: ${error.code ?? error.message}`);
      }
      if (relates([destination, resolved], [other, canonical], ['equal', 'below'])) {
        return retained(`points into another linked worktree ${other}`);
      }
    }
    return { before: target.before, linkText, target: resolved };
  } catch (error) {
    return retained(`could not resolve its target: ${error.code ?? error.message}`);
  }
}

// Whether a directory holds nothing but real directories, read without following a link.
const holdsNoFile = (path) => readdirSync(path, { withFileTypes: true })
  .every((entry) => entry.isDirectory() && holdsNoFile(join(path, entry.name)));

const UNREADABLE_MOUNT_TABLE = 'could not read the mount table';

// The mount points of this process's mount table, or null when it cannot be read whole. Platforms other than Linux
// have no such table to read.
function readMountPoints({ run, platform }) {
  if (platform !== 'linux') return [];
  const table = run('cat', ['/proc/self/mountinfo'], { env: nativeEnvironment(process.env) });
  if (!completeCommand(table)) return null;
  const lines = table.stdout.split('\n');
  if (lines.pop() !== '') return null;
  const points = [];
  for (const line of lines) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 5 || fields.length - separator - 1 < 3) return null;
    points.push(fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
  }
  return points;
}

// An ignored row naming a real directory in the worktree that holds no file: its lstat, null to leave the row held,
// or UNREADABLE_MOUNT_TABLE when the mount table could not be read. It protects nothing, as an empty directory git
// does not ignore, which status never lists. A mount at or beneath it holds the row, because git worktree remove
// would otherwise delete empty folders in the mount's source; platforms other than Linux have no table to read.
function readFilelessIgnoredDirectory(relative, worktree, seams) {
  const path = join(worktree.path, relative);
  let before;
  try {
    before = lstatSync(path);
    if (!before.isDirectory() || realpath(path) !== join(worktree.canonical, relative) || !holdsNoFile(path)) return null;
  } catch {
    return null;
  }
  const mounts = readMountPoints(seams);
  if (!mounts) return UNREADABLE_MOUNT_TABLE;
  return mounts.some((mount) => atOrBelow(mount, join(worktree.canonical, relative))) ? null : before;
}

// Ordinary removal deletes ignored entries and edits hidden by index flags without refusing, so verify both.
function removeWorktree({ git, worktree, records, seams }, regenerated, retainWorktree, verify) {
  const status = git('-C', worktree.path, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored=matching');
  if (status.status !== 0) return retainWorktree(`git status failed: ${describe(status)}`);
  const entries = parseStatusEntries(status.stdout);
  if (!entries) return retainWorktree('git status printed an unreadable entry');
  const directories = [];
  for (const directory of regenerated.filter((directory) =>
    entries.some(({ code, path }) => code === '!!' && path.startsWith(directory + '/')))) {
    try {
      const path = join(worktree.path, directory);
      if (!lstatSync(path).isDirectory() || realpath(path) !== join(worktree.canonical, directory)) {
        return retainWorktree(`regenerated path ${directory} is not a real directory within the worktree`);
      }
    } catch (error) {
      return retainWorktree(`could not verify regenerated directory ${directory}: ${error.code ?? error.message}`);
    }
    directories.push(directory);
  }
  const links = [];
  const fileless = [];
  const held = [];
  for (const { code, path } of entries) {
    const relative = path.endsWith('/') ? path.slice(0, -1) : path;
    if (code === '!!' && !relative.endsWith('/') && isCleanRelative(relative) &&
      directories.some((directory) => path.startsWith(directory + '/'))) continue;
    if (code === '!!' && path.endsWith('/') && isCleanRelative(relative)) {
      const before = readFilelessIgnoredDirectory(relative, worktree, seams);
      if (before === UNREADABLE_MOUNT_TABLE) return retainWorktree(before);
      if (before) {
        fileless.push({ relative, before });
        continue;
      }
    }
    if (code === '!!' && !path.endsWith('/') && isCleanRelative(path)) {
      const link = readIgnoredLink(path, worktree, records);
      if (link.retained) return retainWorktree(link.retained);
      if (link.before) {
        links.push({ relative: path, ...link });
        continue;
      }
    }
    held.push(`"${code} ${path}"`);
  }
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
  for (const link of links) {
    const after = readIgnoredLink(link.relative, worktree, records);
    if (after.retained) return retainWorktree(after.retained);
    if (!after.before || after.before.dev !== link.before.dev || after.before.ino !== link.before.ino ||
      after.linkText !== link.linkText || after.target !== link.target) {
      return retainWorktree(`ignored link ${link.relative}: changed during the checks`);
    }
  }
  for (const { relative, before } of fileless) {
    const after = readFilelessIgnoredDirectory(relative, worktree, seams);
    if (after === UNREADABLE_MOUNT_TABLE) return retainWorktree(after);
    if (!after || !sameEntry(before, after)) return retainWorktree(`ignored directory ${relative}: changed during the checks`);
  }
  const removal = git('worktree', 'remove', worktree.path);
  if (removal.status !== 0) return retainWorktree(describe(removal));
  const listing = git('worktree', 'list', '--porcelain', '-z');
  const remaining = listing.status === 0 ? parseWorktreeList(listing.stdout) : null;
  if (!remaining) return retainWorktree(`could not confirm its removal: ${listing.status === 0 ? 'an unreadable record' : describe(listing)}`);
  if (remaining.some(({ path }) => path === worktree.path)) return retainWorktree('git still registers it after its removal');
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
    // A link stays named as itself, since removing it removes the link; anything else takes its on-disk spelling whole.
    canonical = before.isSymbolicLink() ? join(realpath(dirname(path)), basename(path)) : realpath(path);
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
// container bound there unless it met a problem, so of the containers left only a live one bound above holds the
// target; outside it, every container still present is read whole.
function containerRetention(forms, inside, { docker, containers }) {
  if (docker.absent) return null;
  if (docker.failure) return unverifiable(`docker failed: ${docker.failure}`);
  const unverified = docker.verify();
  if (unverified) return unverifiable(unverified);
  if (inside && !containers.clean) return unverifiable(containers.unresolved ?? 'a container bound in the job worktree was not removed');
  for (const record of docker.records.filter(({ Id }) => !containers.gone.has(Id))) {
    const short = record.Id.slice(0, 12);
    const sources = docker.sources(record);
    if (inside) {
      if (holdsFromAbove(record, sources, forms)) return found(`container ${short} binds a parent folder of it`);
      continue;
    }
    const unresolved = sources.find(({ unresolved }) => unresolved);
    if (unresolved) return unverifiable(unresolvedSource(short, unresolved));
    if (relates(sources.map(({ path }) => path).filter(Boolean), forms, ['equal', 'below', 'above'])) return found(`container ${short} binds it`);
    if (recordNames([record, docker.volumeDevices(record)], forms)) return found(`container ${short} names it`);
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

// Whether a path still names the entry first read there: the same device, inode and file type.
const sameEntry = (before, after) =>
  after.dev === before.dev && after.ino === before.ino && (after.mode & constants.S_IFMT) === (before.mode & constants.S_IFMT);

// Removes the target unless it changed since it was first read; a link is removed, never followed.
function removal(path, before) {
  let after;
  try {
    after = lstatSync(path);
  } catch (error) {
    return `could not be read again: ${error.code ?? error.message}`;
  }
  if (!sameEntry(before, after)) return 'it changed during the checks';
  try {
    if (before.isDirectory()) rmSync(path, { recursive: true });
    else unlinkSync(path);
  } catch (error) {
    const partly = before.isDirectory() ? '; some contents may already be gone' : '';
    return `removal failed: ${error.code ?? error.message}${partly}`;
  }
  return null;
}
