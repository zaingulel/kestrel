#!/usr/bin/env node
// product-manager-run.mjs — runs a product manager run, or with --pre-approved a pre-approved run, on Codex from a
// terminal outside any session. Product manager cards run serially; pre-approved builds can run concurrently with one
// delivery lane. Normally one final end-session message is printed once.
// Exit 0 when the run ended and the end session's message was printed; 1 when the repository root could not be worked
// out, pre-approved opt-in was disabled or unavailable, attention could not be queued, or a session was interrupted
// or failed to summarize; 2 on bad arguments.
// Each session's logs and last message stay in a temporary results folder named in the end session's prompt.
// A product manager run marks each session PRODUCT_MANAGER_RUN_SESSION=1; a pre-approved run takes one start time and
// marks every session PRE_APPROVED_RUN_SESSION=<that time>, with no product manager mark.
// Run: node scripts/product-manager-run.mjs --coordinator <chat UUID> [--pre-approved]
// Or --claude-card <absolute logs base> for one Claude child carrying exactly one inherited run mark. Its stdout/stderr
// stay in .json/.stderr.log; cancellation/spawn failure exits 1, ordinary numeric child status is unchanged. The launch
// requires CLAUDE_CODE_SESSION_ID, the launching Claude Code session, and records it in .coordinator before the child.
// With --carry <logs base>.answer.json it instead resumes the ended card session the answer names, with the owner's
// words, only for the session recorded as that card's coordinator; a refused carry exits 2 and starts no session.
// An answer that also holds `shown` is a push yes for the decision card shown: it resumes only that card's built session
// while its clean job/<card> worktree still holds that card, marked only CARRIED_PUSH_YES=<card> and with no deny rules.
// Or --check-admission <absolute request file> to judge one pre-approved admission request without starting a session:
// it prints one JSON decision and exits 0 for allow, 3 for wait and 1 for unavailable; malformed arguments exit 2.
// Or --bind-app-job <absolute request file> to bind a verified detached checkout without starting a session:
// it prints one JSON bound decision on success, exits 1 if binding is unavailable or 2 for invalid arguments.
// Or --prepare-app-phase <absolute phase-log-base> <ready-session-uuid> <original-claim-created-at>
// [<absolute admission-request-file>] to retain an admitted native phase and return its prompt without dispatch.
// It exits 0 for allow, 3 for wait, 1 for unavailable or 2 for invalid arguments.
// The Herdr lead (scripts/lead.mjs) starts its Claude sessions through the same managed launcher under the lead profile;
// each lead unit's observers run this script with --observe-lead-phase=<slot>.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gitEnvironment } from './lib/factory-sync.mjs';
import { ghExec } from './lib/gh-exec.mjs';
import { requirePreApprovedRun } from './lib/advance-approval.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';
import { codexAppRunBindingPath, codexAppRunDesignationPath, isCodexAppRunRecord, readAppRunConnection, resolveCodexAppWorktree } from './lib/checkout-context.mjs';
import { cancellationReason, CARD_PROMPT, PRE_APPROVED_CARD_PROMPT, SESSION_ID, admitWholeJob, inspectAdmission, prepareAppPhase, readWorktreeInventory, retainPreparedContext, runRun, runWholeJobs, verifyCarriedAnswer, verifyPreparedContext } from './lib/product-manager-run.mjs';

const USAGE = 'usage: node scripts/product-manager-run.mjs --coordinator <chat UUID> [--pre-approved [--continue-card <card>]] | --admit-job build|deliver <absolute request file> | --claude-card <absolute logs base> [--prepared-context <absolute context file> | --carry <absolute logs base>.answer.json] | --check-admission <absolute request file> | --bind-app-job <absolute request file> | --prepare-app-phase <absolute phase-log-base> <ready-session-uuid> <original-claim-created-at> [<absolute admission-request-file>]';
const RUN_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Argument validation stays local to the CLI; the library policy remains private.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const MAX_BIND_REQUEST_BYTES = 16 * 1024;
const ADMISSION_EXIT = { allow: 0, wait: 3, unavailable: 1 };

// The root the way .codex/hooks.json works it out: the parent of the absolute common directory.
export function repositoryRoot(git = (args) => execFileSync('git', args, { encoding: 'utf8', env: gitEnvironment(), stdio: 'pipe' })) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return dirname(common.trim());
}

// Every default Git reader shares admission's bounded output budget. Raw bytes decode strictly, so malformed UTF-8
// fails instead of aliasing U+FFFD and a leading U+FEFF in a filename is kept.
function gitReader(root, executable = 'git') {
  return (args) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(execFileSync(executable, args, {
    cwd: root, env: gitEnvironment(), stdio: 'pipe', timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  }));
}

class AppBindRefusal extends Error {}

// Requests accept a worktree path and must reject malformed UTF-8 before interpreting it.
function readAppBindRequest(path) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_BIND_REQUEST_BYTES) throw new AppBindRefusal('Invalid bind request file');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BIND_REQUEST_BYTES || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new AppBindRefusal('Invalid opened bind request file');
    }
    const bytes = Buffer.alloc(MAX_BIND_REQUEST_BYTES + 1);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== opened.size) throw new AppBindRefusal('Bind request file changed during read');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(descriptor);
  }
}

function bindAppJob(requestPath) {
  const { worktree: selected, base, ...record } = readAppBindRequest(requestPath);
  if (!isCodexAppRunRecord(record) || typeof selected !== 'string' || !isAbsolute(selected) || normalize(selected) !== selected || CONTROL.test(selected)
    || typeof base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw new AppBindRefusal('Invalid bind request');

  const env = gitEnvironment();
  const executable = gitExecutable({ env });
  if (!executable || env.PRODUCT_MANAGER_RUN_SESSION !== undefined || env.PRE_APPROVED_RUN_SESSION !== undefined) {
    throw new AppBindRefusal('Bind requires Git and an unmarked coordinator');
  }
  const root = realpathSync.native(repositoryRoot(gitReader(process.cwd(), executable)));
  const worktree = realpathSync.native(selected);
  const { gitDir, linked } = resolveCodexAppWorktree(worktree, root, env);
  if (!linked) throw new AppBindRefusal('The selected checkout is outside the operating repository’s linked worktrees');

  const git = gitReader(root, executable);
  const worktreeGit = (args) => git(['-C', worktree, ...args]);
  try {
    worktreeGit(['symbolic-ref', '--quiet', 'HEAD']);
    throw new AppBindRefusal('The selected checkout is attached');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (worktreeGit(['rev-parse', '--verify', 'HEAD']).trim() !== base) {
    throw new AppBindRefusal('The selected checkout HEAD differs from the requested base');
  }
  if (worktreeGit([
    '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ]) !== '') throw new AppBindRefusal('The selected checkout is dirty');

  // Verify opt-in against the same fetched object that proves the requested base.
  const fetchedMain = 'refs/remotes/origin/main^{commit}';
  const gitAtBase = (args) => {
    const result = git(args);
    if (args.includes(fetchedMain) && result.trim() !== base) throw new AppBindRefusal('Fetched main differs from the requested base');
    return result;
  };
  if (record.kind === 'pre-approved') requirePreApprovedRun({ git: gitAtBase });
  else gitAtBase(['rev-parse', '--verify', '--quiet', fetchedMain]);

  const designation = codexAppRunDesignationPath(root, worktree);
  const binding = codexAppRunBindingPath(gitDir);
  const designationDir = dirname(designation);
  const directory = lstatSync(designationDir, { throwIfNoEntry: false });
  if (directory && !directory.isDirectory()) throw new AppBindRefusal('The designation directory is not a real directory');
  const existingDesignation = lstatSync(designation, { throwIfNoEntry: false });
  const existingBinding = lstatSync(binding, { throwIfNoEntry: false });
  if (existingDesignation || existingBinding) throw new AppBindRefusal('Existing app binding evidence');
  if (!directory) mkdirSync(designationDir, { mode: 0o700 });

  // Leave a designation for the guard if the private binding cannot be created or verified.
  const privateWrite = { flag: 'wx', mode: 0o600 };
  writeFileSync(designation, `${record.sessionId}\n`, privateWrite);
  writeFileSync(binding, JSON.stringify(record), privateWrite);
  const verified = readAppRunConnection({ sessionCwd: worktree, sessionId: record.sessionId, reportedCwd: worktree, env, operatingRoot: root });
  if (verified?.worktree !== worktree || Object.entries(record).some(([key, value]) => verified[key] !== value)) {
    throw new AppBindRefusal('The binding did not verify');
  }
  return { decision: 'bound', sessionId: record.sessionId, worktree };
}

function runAppPhase(args, dependencies, output) {
  const [logBase, sessionId, claimTime, admissionFile] = args;
  const paths = admissionFile === undefined ? [logBase] : [logBase, admissionFile];
  const claimCreatedAt = Date.parse(claimTime);
  if (args.length < 3 || args.length > 4 || paths.some((path) => !isAbsolute(path) || normalize(path) !== path || CONTROL.test(path))
    || sessionId.length !== 36 || !SESSION_ID.test(sessionId)
    || !RUN_START.test(claimTime) || !Number.isFinite(claimCreatedAt) || new Date(claimCreatedAt).toISOString() !== `${claimTime.slice(0, -1)}.000Z`) {
    output.error(USAGE);
    return 2;
  }

  let answer;
  try {
    const env = gitEnvironment();
    const executable = gitExecutable({ env });
    if (!executable) throw new Error('Git is unavailable');
    const root = realpathSync.native(repositoryRoot(gitReader(process.cwd(), executable)));
    const readConnection = (worktree) => readAppRunConnection({ sessionCwd: worktree, sessionId, reportedCwd: worktree, env, operatingRoot: root });
    answer = prepareAppPhase(logBase, {
      claimCreatedAt, admissionFile, readConnection, root, exec: dependencies.exec ?? ghExec, git: dependencies.git ?? gitReader(root, executable),
    });
  } catch (error) {
    answer = { decision: 'unavailable', reasons: [error.message] };
  }
  if (answer === null) {
    output.error(USAGE);
    return 2;
  }
  output.log(JSON.stringify(answer));
  return ADMISSION_EXIT[answer.decision];
}

const CLEANUP_WINDOW_MS = 5000;
// A child takes only the mark its launcher gives it, never an identity or mark inherited from the launching session.
const INHERITED_SESSION_ENVIRONMENT = ['PRODUCT_MANAGER_RUN_SESSION', 'PRE_APPROVED_RUN_SESSION', 'CARRIED_PUSH_YES', 'CLAUDE_CODE_SESSION_ID'];

// The legacy Unix route owns only the model's process group.
function sessionStarter(command, mark, {
  scheduleCleanupTimer = setTimeout, cancelCleanupTimer = clearTimeout, sendSignal = process.kill,
  terminationCommand = ['taskkill'],
}, { stdoutSuffix = '.jsonl', openFlags = 'w' } = {}) {
  return ({ argv, root, logs }) => {
    const env = { ...process.env };
    for (const key of INHERITED_SESSION_ENVIRONMENT) delete env[key];
    const out = openSync(`${logs}${stdoutSuffix}`, openFlags);
    let err;
    try {
      err = openSync(`${logs}.stderr.log`, openFlags);
    } catch (error) {
      closeSync(out);
      throw error;
    }
    return new Promise((done) => {
      const child = spawn(command[0], [...command.slice(1), ...argv], {
        cwd: root, stdio: ['ignore', out, err], detached: process.platform !== 'win32',
        env: { ...env, ...mark, RUN_CARD_FILE: `${logs}.card` },
      });
      let noteClosed;
      const closed = new Promise((resolve) => { noteClosed = resolve; });
      const timers = new Set();
      let finished = false;
      let didClose = false;
      let stopping = false;
      const interruptHandlers = {
        SIGINT: () => cancelOwned('SIGINT'),
        SIGTERM: () => cancelOwned('SIGTERM'),
      };
      const schedule = (callback, milliseconds) => {
        const handle = scheduleCleanupTimer(callback, milliseconds);
        timers.add(handle);
        return handle;
      };
      const finish = (outcome) => {
        if (finished) return;
        finished = true;
        for (const [signal, handler] of Object.entries(interruptHandlers)) process.off(signal, handler);
        for (const handle of timers) cancelCleanupTimer(handle);
        timers.clear();
        done(outcome);
      };
      const ownedAlive = () => {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      // Confirmation covers only the targeted group/PID, not tools in separate sessions.
      const confirmStopped = () => new Promise((resolve, reject) => {
        let settled = false;
        let probe;
        let limit;
        const settle = (value, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(probe);
          cancelCleanupTimer(limit);
          timers.delete(limit);
          if (error) reject(error);
          else resolve(value);
        };
        const inspect = () => {
          if (settled) return;
          clearTimeout(probe);
          try {
            if (didClose && !ownedAlive()) settle(true);
            else probe = setTimeout(inspect, 10);
          } catch (error) {
            settle(false, error);
          }
        };
        limit = schedule(() => settle(false), CLEANUP_WINDOW_MS);
        closed.then(inspect);
        inspect();
      });
      async function cancelOwned(interrupted) {
        if (finished || stopping) return;
        stopping = true;
        let terminationFailure;
        try {
          if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error('the owned process PID is unavailable');
          if (process.platform === 'win32') {
            await new Promise((resolve, reject) => {
              execFile(terminationCommand[0], [...terminationCommand.slice(1), '/pid', String(child.pid), '/t', '/f'],
                { cwd: root, encoding: 'utf8', timeout: CLEANUP_WINDOW_MS, maxBuffer: 65536 }, (error, _stdout, stderr) => {
                  if (error) reject(new Error((stderr.trim() || error.message).slice(0, 2000)));
                  else resolve();
                });
            });
            if (!await confirmStopped()) throw new Error('owned process death was not confirmed after the tree stop command');
          } else {
            sendSignal(-child.pid, interrupted);
            if (!await confirmStopped()) {
              // The group can disappear at the grace boundary; never send a stale signal after confirmed exit.
              if (ownedAlive()) sendSignal(-child.pid, 'SIGKILL');
              if (!await confirmStopped()) throw new Error('owned process group death was not confirmed after SIGKILL');
            }
          }
        } catch (error) {
          terminationFailure = error.message;
          child.unref();
        }
        finish({ exitCode: null, interrupted, terminationFailure, pid: child.pid });
      }
      child.once('error', (error) => {
        noteClosed();
        finish({ exitCode: null, spawnError: `could not start ${command[0]} (${error.code})` });
      });
      child.once('close', (code, signal) => {
        didClose = true;
        noteClosed();
        if (!stopping) finish({ exitCode: code ?? signal });
      });
      for (const [signal, handler] of Object.entries(interruptHandlers)) process.on(signal, handler);
    }).finally(() => {
      closeSync(out);
      closeSync(err);
    });
  };
}

const PHASE_ID = /^[0-9a-f]{32}$/;
const WHOLE_JOB_NAME = /^job-([1-9]\d*)$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RECORD_LIMIT = 16 * 1024;
const CGROUP_ROOT = '/sys/fs/cgroup';
// What one kind of managed session differs by; the unit's stop proof is shared by every profile.
export const CODEX_PROFILE = {
  label: 'Codex',
  observer: '--observe-codex-phase',
  unit: (phaseId) => `fabraik-codex-${phaseId}.service`,
  phaseName: /^(?:job-[1-9]\d*|end)$/,
  markers: { managed: 'FABRAIK_CODEX_MANAGED', folder: 'FABRAIK_CODEX_INVOCATION_FOLDER' },
  environment: ['HOME', 'PATH', 'CODEX_HOME', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK'],
  resultsFolder: (folder) => dirname(folder) === realpathSync(tmpdir()) && /^product-manager-run-[a-zA-Z0-9]{6}$/.test(basename(folder)),
  seals: { hiddenBus: true, readOnlyControlGroups: true, busProxy: true },
};
// The variables a lead session takes from the lead's environment where set, with every LC_ variable.
const LEAD_ENVIRONMENT = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'TERM', 'TZ', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GH_CONFIG_DIR', 'WAYLAND_DISPLAY', 'DISPLAY',
  'HYPRLAND_INSTANCE_SIGNATURE'];
const LEAD_MARKERS = { managed: 'FABRAIK_LEAD_MANAGED', folder: 'FABRAIK_LEAD_INVOCATION_FOLDER' };
const LEAD_OBSERVER = /^--observe-lead-phase=([1-9]\d*)$/;

// The start of every unit name of the lead whose canonical state folder is `state`, so one lead never counts or stops
// another's units.
export function leadUnitPrefix(state) {
  return `fabraik-lead-${createHash('sha256').update(state).digest('hex').slice(0, 8)}-`;
}

// A lead session on running place `slot`: its results lie under <state>/runs/, its command sees only the allowlist, the
// run markers and `settings`, the name and value pairs the lead gives every session; nothing else is sealed, so the
// session reaches what the lead's user reaches. A hangup stops its unit as SIGINT and SIGTERM do, since the lead stops
// on all three. A lead observer, which needs no settings, takes its slot from its flag.
export function leadProfile(state, slot, settings = []) {
  return {
    label: 'lead',
    observer: `--observe-lead-phase=${slot}`,
    unit: (phaseId) => `${leadUnitPrefix(state)}slot${slot}-${phaseId}.service`,
    phaseName: /^(?:select-[1-9]\d*|job-[1-9]\d*-(?:prepare|build|deliver)|end)$/,
    markers: LEAD_MARKERS,
    environment: [...LEAD_ENVIRONMENT, ...Object.keys(process.env).filter((name) => name.startsWith('LC_'))],
    settings,
    resultsFolder: (folder) => dirname(folder) === join(state, 'runs') && /^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-zA-Z0-9]{6}$/.test(basename(folder)),
    seals: { hiddenBus: false, readOnlyControlGroups: false, busProxy: false },
    sealed: true,
    stopSignals: ['SIGINT', 'SIGTERM', 'SIGHUP'],
  };
}

function managedPath(path) {
  return typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !CONTROL.test(path);
}

function managedDirectory(path, privateMode = false) {
  if (!managedPath(path) || realpathSync(path) !== path) throw new Error('managed directory is not canonical');
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (privateMode && (entry.mode & 0o7777) !== 0o700)) {
    throw new Error('managed directory is not an owned directory with the required access');
  }
}

function verifyOutsideCheckouts(path, root) {
  const pathKey = path.normalize('NFC').toLowerCase();
  if (readWorktreeInventory(gitReader(root)).some(({ key }) => pathKey === key || pathKey.startsWith(key.endsWith('/') ? key : key + '/'))) {
    throw new Error('managed results path is inside a registered checkout');
  }
}

function verifyInvocationFolder(profile, folder, root) {
  if (!managedPath(folder) || !profile.resultsFolder(folder)) {
    throw new Error('managed invocation is outside the canonical temporary results root');
  }
  managedDirectory(folder, true);
  verifyOutsideCheckouts(folder, root);
}

function phaseDirectory(folder, phaseId) {
  const units = join(folder, 'units');
  const directory = join(units, phaseId);
  managedDirectory(folder, true);
  managedDirectory(units, true);
  managedDirectory(directory, true);
  return directory;
}

function writeManagedRecord(directory, name, record) {
  const file = openSync(join(directory, name), 'wx', 0o600);
  try {
    writeFileSync(file, JSON.stringify(record));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function readManagedRecord(path, limit = RECORD_LIMIT) {
  const privateFile = (entry) => entry.isFile() && entry.nlink === 1 && entry.uid === process.getuid()
    && (entry.mode & 0o7777) === 0o600 && entry.size <= limit;
  const entry = lstatSync(path);
  if (!privateFile(entry)) throw new Error('invalid private managed record');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(file);
    if (!privateFile(opened) || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error('managed record identity changed');
    const bytes = Buffer.alloc(opened.size + 1);
    const length = readSync(file, bytes, 0, bytes.length, 0);
    if (length !== opened.size) throw new Error('managed record changed during read');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } finally {
    closeSync(file);
  }
}

function nativeBootId() {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) throw new Error('local boot identity unavailable');
  return bootId;
}

function nativeStartTicks(pid) {
  const record = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = record.slice(record.lastIndexOf(')') + 2).split(' ');
  if (/^[ZX]$/.test(fields[0]) || !/^[1-9]\d*$/.test(fields[19])) throw new Error('live controller identity unavailable');
  return fields[19];
}

function verifyManagedIntent(profile, intent, { phaseId, phase, root, runStart }) {
  const { controllerPid, controllerStartTicks, card, priorClaimUrls, base } = intent;
  const expected = { phaseId, phase, unit: profile.unit(phaseId), bootId: nativeBootId(), root, runStart, controllerPid, controllerStartTicks };
  const whole = WHOLE_JOB_NAME.exec(phase);
  if (whole) Object.assign(expected, { card, priorClaimUrls, base });
  if (!PHASE_ID.test(phaseId) || typeof phase !== 'string' || !profile.phaseName.test(phase)
    || typeof runStart !== 'string' || !RUN_START.test(runStart) || Number.isNaN(Date.parse(runStart))
    || !Number.isSafeInteger(controllerPid) || controllerPid < 1
    || typeof controllerStartTicks !== 'string' || !/^[1-9]\d*$/.test(controllerStartTicks)
    || (whole && (!Number.isSafeInteger(card) || Number(whole[1]) !== card || typeof base !== 'string' || !GIT_OID.test(base)
      || !Array.isArray(priorClaimUrls) || new Set(priorClaimUrls).size !== priorClaimUrls.length
      || priorClaimUrls.some((url) => typeof url !== 'string' || !/^https:\/\/\S+$/.test(url))))
    || !isDeepStrictEqual(intent, expected)) throw new Error('managed intent identity mismatch');
  return intent;
}

function createManagedIntent(profile, folder, phase, root, runStart, job) {
  const phaseId = randomBytes(16).toString('hex');
  const intent = { phaseId, phase, unit: profile.unit(phaseId), bootId: nativeBootId(), root, runStart,
    controllerPid: process.pid, controllerStartTicks: nativeStartTicks(process.pid), ...job };
  mkdirSync(join(folder, 'units', phaseId), { mode: 0o700 });
  const directory = phaseDirectory(folder, phaseId);
  writeManagedRecord(directory, 'intent.json', intent);
  return { intent, intentPath: join(directory, 'intent.json') };
}

function readWholeIntent(profile, path, root) {
  if (!managedPath(path) || basename(path) !== 'intent.json') throw new Error('whole job intent path is invalid');
  const phaseId = basename(dirname(path));
  const folder = dirname(dirname(dirname(path)));
  if (!PHASE_ID.test(phaseId) || dirname(dirname(path)) !== join(folder, 'units')) throw new Error('whole job intent path is invalid');
  const intent = readManagedRecord(join(phaseDirectory(folder, phaseId), 'intent.json'));
  if (!WHOLE_JOB_NAME.test(intent.phase)) throw new Error('whole job intent phase is invalid');
  return { folder, intent: verifyManagedIntent(profile, intent, { phaseId, phase: intent.phase, root, runStart: intent.runStart }) };
}

function readWorkerIdentity() {
  return { cwd: process.cwd(), invocationId: process.env.INVOCATION_ID,
    cgroup: /^0::([^\n]+)\n?$/.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1] };
}

function receiptIdentity(intent, invocationId, cgroup) {
  return { phaseId: intent.phaseId, unit: intent.unit, bootId: intent.bootId, invocationId, cgroup };
}

function readManagedReceipt(folder, intent, role) {
  let receipt;
  try {
    receipt = readManagedRecord(join(phaseDirectory(folder, intent.phaseId), `${role}.json`));
  } catch (error) {
    throw new Error(`${role} receipt ${error.code === 'ENOENT' ? 'missing' : 'invalid or unreadable'}`, { cause: error });
  }
  if (!receipt || typeof receipt.invocationId !== 'string' || !PHASE_ID.test(receipt.invocationId)
    || !managedPath(receipt.cgroup) || basename(receipt.cgroup) !== intent.unit || nativeBootId() !== intent.bootId
    || !isDeepStrictEqual(receipt, receiptIdentity(intent, receipt.invocationId, receipt.cgroup))) {
    throw new Error(`${role} receipt identity mismatch`);
  }
  return receipt;
}

// Locks the open file `fd` exclusively through /usr/bin/flock, waiting up to `seconds` or, at 0, trying once. Resolves
// to flock's exit status: 0 when locked, 75 when another open file holds the lock.
export function flockDescriptor(fd, seconds = 5) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['-x', ...(seconds ? ['-w', String(seconds)] : ['-n']), '-E', '75', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function openWholeJobStore(commonDir, root) {
  const key = createHash('sha256').update(commonDir).digest('hex');
  const directory = join('/tmp', `fabraik-preapproved-${process.getuid()}-${key}`);
  const lockPath = join(directory, 'lock');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  managedDirectory(directory, true);
  const original = lstatSync(directory);
  const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
  function verifyDirectory() {
    managedDirectory(directory, true);
    if (!sameInode(lstatSync(directory), original)) throw new Error('whole-job store directory identity changed');
  }
  function verifyLock(fd) {
    verifyDirectory();
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.nlink !== 1 || lock.uid !== process.getuid() || (lock.mode & 0o7777) !== 0o600
      || !sameInode(lock, lstatSync(lockPath))) throw new Error('whole-job store lock identity is invalid');
  }
  function recordPath(card) { return join(directory, `job-${card}.json`); }
  return {
    async locked(operation) {
      verifyDirectory();
      const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        verifyLock(fd);
        const status = await flockDescriptor(fd);
        if (status === 75) throw Object.assign(new Error('whole-job admission lock contention'), { code: 'WHOLE_JOB_LOCK_BUSY' });
        if (status !== 0) throw new Error('whole-job admission lock is unavailable');
        verifyLock(fd);
        const result = operation();
        verifyLock(fd);
        return result;
      } finally { closeSync(fd); }
    },
    records() {
      return new Map(readdirSync(directory).filter((name) => name !== 'lock').map((name) => {
        const card = Number(/^job-([1-9]\d*)\.json$/.exec(name)?.[1]);
        if (!Number.isSafeInteger(card)) throw new Error(`invalid whole-job store record name: ${name}`);
        try { return [card, readManagedRecord(recordPath(card), 64 * 1024 * 1024)]; }
        catch (error) { throw new Error(`whole-job store record for card ${card} is invalid or unreadable: ${error.message}`); }
      }));
    },
    write(card, record) {
      const temporary = `.${randomBytes(16).toString('hex')}`;
      writeManagedRecord(directory, temporary, record);
      renameSync(join(directory, temporary), recordPath(card));
    },
    remove(card) { unlinkSync(recordPath(card)); },
    watch(change) { return watch(directory, change); },
    attempt(intentPath) {
      const { intent, folder } = readWholeIntent(CODEX_PROFILE, intentPath, root);
      function receipt(role) {
        try { return readManagedReceipt(folder, intent, role); }
        catch (error) { if (error.cause?.code !== 'ENOENT') throw error; }
      }
      return { intent, folder, start: () => receipt('start'), stop: () => receipt('stop') };
    },
  };
}

function wholeJobStore(root) {
  const git = gitReader(root);
  const commonDir = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\r?\n$/, ''));
  return openWholeJobStore(commonDir, root);
}

function cgroupOnlyObserver(root) {
  const members = readFileSync(join(root, 'cgroup.procs'), 'utf8').trim().split(/\s+/);
  // Delegate=no and, where the profile seals it, the read-only cgroup mount prohibit the worker from creating subgroups;
  // a subgroup a lead session makes fails this check, so its stop stays unproven.
  return members.length === 1 && members[0] === String(process.pid)
    && !readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

function runManagedObserver(profile, args, output) {
  const [, role, phaseId] = args;
  if (process.platform !== 'linux' || args.length !== 3 || !['start', 'stop'].includes(role) || !PHASE_ID.test(phaseId)) return 2;
  try {
    const root = process.cwd();
    const folder = process.env[profile.markers.folder];
    if (root !== realpathSync(repositoryRoot())) throw new Error('managed observer is outside its operating root');
    verifyInvocationFolder(profile, folder, root);
    const directory = phaseDirectory(folder, phaseId);
    const intent = readManagedRecord(join(directory, 'intent.json'));
    const { phase, runStart, controllerPid, controllerStartTicks } = intent;
    verifyManagedIntent(profile, intent, { phaseId, phase, root, runStart });
    if (process.env[profile.markers.managed] !== '1' || process.env.PRE_APPROVED_RUN_SESSION !== runStart
      || process.env.PRODUCT_MANAGER_RUN_SESSION !== undefined || process.env.RUN_CARD_FILE !== join(folder, `${phase}.card`)) {
      throw new Error('managed observer intent identity mismatch');
    }
    const { invocationId, cgroup } = readWorkerIdentity();
    if (typeof invocationId !== 'string' || !PHASE_ID.test(invocationId) || !managedPath(cgroup) || basename(cgroup) !== intent.unit) {
      throw new Error('managed observer native unit identity unavailable');
    }
    const receipt = receiptIdentity(intent, invocationId, cgroup);
    if (role === 'start') {
      if (nativeStartTicks(controllerPid) !== controllerStartTicks) throw new Error('managed controller identity changed before start');
    } else if (!isDeepStrictEqual(receipt, readManagedReceipt(folder, intent, 'start')) || !cgroupOnlyObserver(join(CGROUP_ROOT, cgroup))) {
      throw new Error('stop observer cannot confirm the exact unit and sole remaining process');
    }
    writeManagedRecord(directory, `${role}.json`, receipt);
    return 0;
  } catch (error) {
    output.error(`Managed ${profile.label} ${role} observer refused: ${error.message}`);
    return 1;
  }
}

function managedDeadline(promise, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), CLEANUP_WINDOW_MS);
  })]).finally(() => clearTimeout(timer));
}

async function waitForManagedEvidence(read, message) {
  const deadline = performance.now() + CLEANUP_WINDOW_MS;
  for (;;) {
    const evidence = read();
    if (evidence !== undefined) return evidence;
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function confirmManagedStop(folder, intent) {
  const start = readManagedReceipt(folder, intent, 'start');
  const stop = readManagedReceipt(folder, intent, 'stop');
  if (!isDeepStrictEqual(start, stop)) throw new Error('stop receipt does not match start receipt');
  const cgroup = join(CGROUP_ROOT, stop.cgroup);
  await waitForManagedEvidence(() => {
    try {
      if (/^populated 0$/m.test(readFileSync(join(cgroup, 'cgroup.events'), 'utf8'))) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        lstatSync(cgroup);
      } catch (entryError) {
        if (entryError.code === 'ENOENT') return true;
        throw entryError;
      }
    }
    return undefined;
  }, 'stop proof incomplete: native control group is still populated or unreadable');
  return stop;
}

function systemctl(...args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: CLEANUP_WINDOW_MS, maxBuffer: 65536 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

async function stopManagedUnit(folder, intent, clientClosed) {
  const start = await waitForManagedEvidence(() => {
    try {
      return readManagedReceipt(folder, intent, 'start');
    } catch (error) {
      if (error.cause?.code === 'ENOENT' && !clientClosed()) return undefined;
      throw error;
    }
  }, 'start receipt did not appear during cancellation');
  const fields = ['Id', 'InvocationID', 'ControlGroup', 'ActiveState'];
  const pairs = (await systemctl('show', `--property=${fields.join(',')}`, intent.unit)).trimEnd().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  const current = Object.fromEntries(pairs);
  const { Id, InvocationID, ControlGroup, ActiveState } = current;
  if (pairs.length !== fields.length || fields.some((field) => !Object.hasOwn(current, field))
    || Id !== intent.unit || nativeBootId() !== start.bootId) throw new Error('current native unit identity unavailable');
  if (ControlGroup === '' && ['inactive', 'failed'].includes(ActiveState) && ['', '0'.repeat(32), start.invocationId].includes(InvocationID)) return;
  if (InvocationID !== start.invocationId || ControlGroup !== start.cgroup || !['active', 'activating', 'reloading', 'deactivating'].includes(ActiveState)) {
    throw new Error('current native unit identity differs from the start receipt');
  }
  await systemctl('stop', intent.unit);
}

function nativeRuntimeDirectory() {
  const path = execFileSync('/usr/bin/loginctl', ['show-user', String(process.getuid()), '--property=RuntimePath', '--value'],
    { encoding: 'utf8', timeout: CLEANUP_WINDOW_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  managedDirectory(path);
  // Native D-Bus addresses and the systemd path list must name one literal socket each.
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(path)) throw new Error('native user runtime path contains unsupported socket characters');
  return path;
}

async function openManagedProxy(folder, runtimeDir) {
  const socket = join(folder, 'bus');
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(socket)) throw new Error('managed proxy socket path contains unsupported characters');
  const processLifetime = new AbortController();
  let closing = false;
  let spawnError;
  const child = spawn('/usr/bin/xdg-dbus-proxy', ['--fd=3', `unix:path=${runtimeDir}/bus`, socket, '--filter', '--talk=org.freedesktop.secrets'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const fd = child.stdio[3];
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error.code; });
    child.once('close', (code, signal) => {
      if (!closing) processLifetime.abort(new Error(`managed Secret Service proxy ended early (${spawnError ?? code ?? signal})`));
      resolve();
    });
  });
  const ready = new Promise((resolve, reject) => {
    fd.once('data', (bytes) => {
      if (bytes.length !== 1 || bytes[0] !== 0x78) reject(new Error('managed Secret Service proxy sent invalid readiness'));
      else resolve();
    });
    fd.on('error', (error) => reject(error));
  });
  async function close() {
    closing = true;
    fd.destroy();
    try {
      await managedDeadline(closed, 'managed Secret Service proxy did not settle after its descriptor closed');
    } catch (error) {
      child.kill('SIGKILL');
      await closed;
      throw error;
    }
  }
  try {
    await managedDeadline(Promise.race([ready, closed.then(() => { throw processLifetime.signal.reason; })]),
      'managed Secret Service proxy readiness unavailable');
    processLifetime.signal.throwIfAborted();
    const entry = lstatSync(socket);
    if (!entry.isSocket() || entry.uid !== process.getuid()) throw new Error('managed Secret Service proxy did not create an owned socket');
    return { address: `unix:path=${socket}`, signal: processLifetime.signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function systemdLiteral(path) {
  if (!managedPath(path)) throw new Error('managed observer path is not an absolute literal');
  return `"${path.replace(/["\\]/g, '\\$&').replaceAll('$', () => '$$')}"`;
}

// The signals that stop a managed unit unless its profile names its own.
const MANAGED_STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

async function runManagedClient(args, { root, logs, folder, intent, proxy, stopSignals }) {
  let out;
  let err;
  try {
    out = openSync(`${logs}.jsonl`, 'wx', 0o600);
    err = openSync(`${logs}.stderr.log`, 'wx', 0o600);
    const child = spawn('systemd-run', args, { cwd: root, stdio: ['ignore', out, err], detached: true });
    let spawnError;
    let clientClosed = false;
    const closed = new Promise((resolve) => {
      child.once('error', (error) => { spawnError = `native managed service launch unavailable (${error.code})`; });
      child.once('close', (code, signal) => {
        clientClosed = true;
        resolve({ exitCode: code ?? signal, spawnError });
      });
    });
    let finishStop;
    const stopRequested = new Promise((resolve) => { finishStop = resolve; });
    let stopping;
    let interrupted;
    function requestStop(signal) {
      interrupted ??= signal;
      if (clientClosed || stopping) return;
      stopping = (async () => {
        try {
          await stopManagedUnit(folder, intent, () => clientClosed);
          return await managedDeadline(closed, 'native launch client did not settle after the exact unit stop');
        } catch (error) {
          child.unref();
          return { stopFailure: error.message };
        }
      })();
      finishStop(stopping);
    }
    const onSignal = (signal) => requestStop(signal);
    const onProxyLoss = () => requestStop();
    for (const signal of stopSignals) process.on(signal, onSignal);
    proxy?.signal.addEventListener('abort', onProxyLoss, { once: true });
    try {
      if (proxy?.signal.aborted) onProxyLoss();
      const result = await Promise.race([closed, stopRequested]);
      const settled = stopping ? await stopping : result;
      const intentPath = join(folder, 'units', intent.phaseId, 'intent.json');
      try {
        if (settled.stopFailure || settled.spawnError) throw new Error(settled.stopFailure ?? settled.spawnError);
        const proof = await confirmManagedStop(folder, intent);
        return { ...settled, interrupted, managedFailure: proxy?.signal.reason?.message, managedStop: { disposition: 'verified-local', proof, intentPath } };
      } catch (error) {
        const reason = `managed local stop proof unavailable: ${error.message}`;
        return { interrupted, managedFailure: reason, managedStop: { disposition: 'unverified', reason, intentPath } };
      }
    } finally {
      for (const signal of stopSignals) process.off(signal, onSignal);
      proxy?.signal.removeEventListener('abort', onProxyLoss);
    }
  } finally {
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
  }
}

export async function managedSession(profile, { folder, root, runStart, command }) {
  if (process.platform !== 'linux') throw new Error(`managed ${profile.label} requires a Linux user service manager`);
  managedDirectory(folder, true);
  const { hiddenBus, readOnlyControlGroups, busProxy } = profile.seals;
  const runtimeDir = hiddenBus || busProxy ? nativeRuntimeDirectory() : undefined;
  const observer = `${systemdLiteral(process.execPath)} ${systemdLiteral(fileURLToPath(import.meta.url))} ${profile.observer}`;
  const proxy = busProxy ? await openManagedProxy(folder, runtimeDir) : undefined;
  return {
    close: async () => { await proxy?.close(); },
    signal: proxy?.signal,
    async startSession({ argv, logs, intentPath }) {
      try {
        proxy?.signal.throwIfAborted();
        const phase = basename(logs);
        if (dirname(logs) !== folder || !profile.phaseName.test(phase)) throw new Error('managed phase log identity is invalid');
        let intent;
        if (WHOLE_JOB_NAME.test(phase)) {
          const registered = readWholeIntent(profile, intentPath, root);
          intent = registered.intent;
          if (registered.folder !== folder || intent.phase !== phase || intent.controllerPid !== process.pid
            || intent.controllerStartTicks !== nativeStartTicks(process.pid)) throw new Error('managed launch intent differs from registration');
        } else {
          ({ intent, intentPath } = createManagedIntent(profile, folder, phase, root, runStart));
        }
        const { phaseId } = intent;
        const variables = [['PRE_APPROVED_RUN_SESSION', intent.runStart], ['RUN_CARD_FILE', `${logs}.card`],
          [profile.markers.folder, folder], [profile.markers.managed, '1'],
          ...proxy ? [['DBUS_SESSION_BUS_ADDRESS', proxy.address]] : [],
          ...profile.environment.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
          ...profile.settings ?? []];
        const args = ['--user', '--wait', '--pipe', '--quiet', '--expand-environment=no', `--unit=${intent.unit}`,
          '--property=Type=exec', '--property=ExitType=main', '--property=KillMode=control-group', '--property=Restart=no',
          '--property=TimeoutStopSec=2s', '--property=Delegate=no', `--working-directory=${root}`,
          `--property=ExecStartPre=${observer} start ${phaseId}`, `--property=ExecStopPost=${observer} stop ${phaseId}`,
          ...hiddenBus ? [`--property=InaccessiblePaths=-${runtimeDir}/bus -${runtimeDir}/systemd/private -/run/dbus/system_bus_socket`] : [],
          ...readOnlyControlGroups ? [`--property=ReadOnlyPaths=${CGROUP_ROOT}`] : [],
          '--property=UnsetEnvironment=PRODUCT_MANAGER_RUN_SESSION',
          ...variables.map(([key, value]) => `--setenv=${key}=${value}`),
          // A sealed command drops the manager's block; its values travel in the unit's command line, so a sealed
          // profile's environment list must name no secret.
          ...profile.sealed ? ['/usr/bin/env', '-i', ...variables.map(([key, value]) => `${key}=${value}`)] : [],
          ...command, ...argv];
        return await runManagedClient(args, { root, logs, folder, intent, proxy, stopSignals: profile.stopSignals ?? MANAGED_STOP_SIGNALS });
      } catch (error) {
        const reason = `managed ${profile.label} phase unavailable: ${error.message}`;
        return { managedFailure: reason, managedStop: { disposition: 'unverified', reason, intentPath } };
      }
    },
  };
}

function managedCodex(options) {
  return managedSession(CODEX_PROFILE, options);
}

// A pre-approved run can queue to its active coordinator despite this exact resume warning.
function attentionSender(command, coordinator, root, preApproved) {
  const activeWriterWarning = `Warning: message was queued, but could not resume thread ${coordinator}: ` +
    `thread/resume failed: thread ${coordinator} already has an active writer (code -32600)`;
  return ({ folder, name }) => new Promise((done, reject) => {
    const argv = [
      ...command.slice(1), 'queue', '--thread', coordinator, '--message',
      'Fabraik run update: ' + JSON.stringify({ folder, name }), '--resume',
    ];
    execFile(command[0], argv, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 65536 }, (error, _stdout, stderr) => {
      const diagnostic = stderr.trim() || error?.message;
      const queuedToActiveCoordinator = preApproved && diagnostic === activeWriterWarning;
      if (error || (diagnostic && !queuedToActiveCoordinator)) {
        reject(new Error(`Native owner attention queue unavailable: ${diagnostic.slice(0, 2000)}`));
      } else done();
    });
  });
}

// A carried answer is the result of verifyCarriedAnswer for an answer file that is exactly `<base>.answer.json`.
function readCarriedAnswer(file, base, caller, git) {
  if (file !== `${base}.answer.json`) throw new Error(`the answer file must be ${base}.answer.json`);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${file} must be a regular unlinked file`);
  let answer;
  try {
    answer = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not readable JSON (${error.message})`);
  }
  return verifyCarriedAnswer(answer, { caller, readFile: (path) => readFileSync(path, 'utf8'), listFolder: (path) => readdirSync(path), git });
}

async function runClaudeCard(base, root, runMark, dependencies, output, { preparedContext, caller, carried }) {
  const mark = carried?.pushYes ? { CARRIED_PUSH_YES: String(carried.card) } : runMark;
  const pm = mark.PRODUCT_MANAGER_RUN_SESSION === '1';
  let prompt = carried?.prompt ?? (pm ? CARD_PROMPT : `${PRE_APPROVED_CARD_PROMPT}\n${JSON.stringify({ runStart: mark.PRE_APPROVED_RUN_SESSION })}`);
  if (preparedContext !== undefined) {
    try {
      const verified = verifyPreparedContext(preparedContext, {
        runStart: mark.PRE_APPROVED_RUN_SESSION, exec: dependencies.exec ?? ghExec,
        git: dependencies.git ?? gitReader(root),
      });
      retainPreparedContext(preparedContext, base, verified.jobWorktrees);
      ({ prompt } = verified);
    } catch (error) {
      output.error(`Claude prepared context unavailable: ${error.message}`);
      return 1;
    }
  }
  if (carried) {
    try {
      writeFileSync(`${base}.card`, `${carried.card}\n`, { flag: 'wx' });
    } catch (error) {
      output.error(`Carried answer refused: cannot record card ${carried.card} in ${base}.card (${error.message})`);
      return 2;
    }
  }
  const argv = ['-p', ...(carried ? ['--resume', carried.sessionId] : []), '--permission-mode', 'auto'];
  if (pm) argv.push('--disallowedTools', 'Bash(git push *)', 'Bash(gh pr create *)', 'Bash(gh pr ready *)', 'Bash(gh pr merge *)');
  argv.push('--output-format', 'json', prompt);
  const retained = `Outputs: ${base}.json; ${base}.stderr.log; identity: ${base}.card`;
  const startSession = dependencies.startSession ?? sessionStarter(dependencies.command ?? ['claude'], mark, dependencies, { stdoutSuffix: '.json', openFlags: 'wx' });
  let outcome;
  try {
    writeFileSync(`${base}.coordinator`, `${caller}\n`, { flag: 'wx' });
    outcome = await startSession({ argv, root, logs: base });
  } catch (error) {
    output.error(`Claude card could not launch: ${error.message}. ${retained}`);
    return 1;
  }
  if (outcome.interrupted) {
    const reason = cancellationReason(outcome, 'card', `${base}.card`, 'guard evidence was not verified by the wrapper');
    output.error(`${reason}. ${retained}`);
    return 1;
  }
  if (typeof outcome.exitCode === 'number') {
    if (outcome.exitCode !== 0) output.error(`Claude card exited with ${outcome.exitCode}. ${retained}`);
    return outcome.exitCode;
  }
  output.error(`Claude card failed: ${outcome.spawnError ?? outcome.exitCode}. ${retained}`);
  return 1;
}

// Only tests replace the commands, starter, sender or coordinator route.
export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  if (args[0] === CODEX_PROFILE.observer) return runManagedObserver(CODEX_PROFILE, args, output);
  const leadSlot = LEAD_OBSERVER.exec(args[0] ?? '')?.[1];
  // The results folder lies in <state>/runs/; the observer refuses one that does not.
  if (leadSlot) return runManagedObserver(leadProfile(dirname(dirname(process.env[LEAD_MARKERS.folder] ?? '')), Number(leadSlot)), args, output);
  if (args[0] === '--bind-app-job') {
    if (args.length !== 2 || !isAbsolute(args[1]) || CONTROL.test(args[1])) {
      output.error(USAGE);
      return 2;
    }
    try {
      output.log(JSON.stringify(bindAppJob(args[1])));
      return 0;
    } catch (error) {
      const reason = error instanceof AppBindRefusal ? error.message : 'inspect the request, selected checkout and binding metadata';
      output.error(`Native app job binding unavailable: ${reason}`);
      return 1;
    }
  }
  if (args[0] === '--prepare-app-phase') return runAppPhase(args.slice(1), dependencies, output);
  if (args[0] === '--admit-job') {
    if (process.platform !== 'linux' || args.length !== 3 || !['build', 'deliver'].includes(args[1]) || !managedPath(args[2])) {
      output.error(USAGE);
      return 2;
    }
    let answer;
    try {
      const identity = (dependencies.readWorkerIdentity ?? readWorkerIdentity)();
      const cwd = process.cwd();
      const root = realpathSync(repositoryRoot(gitReader(cwd)));
      if (!managedPath(identity.cwd) || realpathSync(identity.cwd) !== realpathSync(cwd)) throw new Error('caller native identity has no matching checkout');
      answer = await admitWholeJob(args[1], args[2], { identity, store: wholeJobStore(root), output,
        exec: dependencies.exec ?? ghExec, git: dependencies.git ?? gitReader(root) });
    } catch (error) {
      answer = { decision: error.code === 'WHOLE_JOB_LOCK_BUSY' ? 'wait' : 'unavailable', reasons: [error.message] };
    }
    output.log(JSON.stringify(answer));
    return ADMISSION_EXIT[answer.decision];
  }
  const admissionFile = args[0] === '--check-admission';
  const admissionInput = dependencies.admissionRequest !== undefined;
  if (admissionFile || admissionInput) {
    if (admissionInput ? args.length !== 0 : args.length !== 2 || !isAbsolute(args[1]) || CONTROL.test(args[1])) {
      output.error('usage: node scripts/product-manager-run.mjs --check-admission <absolute request file>');
      return 2;
    }
    let answer;
    try {
      let request = dependencies.admissionRequest;
      if (!admissionInput) {
        if (!lstatSync(args[1]).isFile()) throw new Error('admission request must be a regular file');
        try { request = JSON.parse(readFileSync(args[1], 'utf8')); }
        catch { throw new Error('admission request file is not readable JSON'); }
      }
      const root = repositoryRoot();
      answer = inspectAdmission(request, { root, exec: dependencies.exec ?? ghExec, git: dependencies.git ?? gitReader(root) });
    } catch (error) {
      answer = { decision: 'unavailable', reasons: [error.message] };
    }
    output.log(JSON.stringify(answer));
    return ADMISSION_EXIT[answer.decision];
  }
  let coordinator;
  let coordinatorOption = false;
  let claudeCard = dependencies.claudeCard;
  let claudeOption = false;
  let preparedFile;
  let preparedOption = false;
  let preparedContext = dependencies.preparedContext;
  let carryFile;
  let preApproved = false;
  let invalid = false;
  let continueCard;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--coordinator' && coordinator === undefined && i + 1 < args.length) {
      coordinatorOption = true;
      coordinator = args[++i];
    } else if (args[i] === '--claude-card' && !claudeOption && i + 1 < args.length) {
      claudeOption = true;
      claudeCard = args[++i];
    } else if (args[i] === '--prepared-context' && !preparedOption && i + 1 < args.length) {
      preparedOption = true;
      preparedFile = args[++i];
    } else if (args[i] === '--carry' && carryFile === undefined && i + 1 < args.length) {
      carryFile = args[++i];
    } else if (args[i] === '--continue-card' && continueCard === undefined && /^[1-9]\d*$/.test(args[i + 1] ?? '')) {
      continueCard = Number(args[++i]);
      if (!Number.isSafeInteger(continueCard)) invalid = true;
    } else if (args[i] === '--pre-approved' && !preApproved) preApproved = true;
    else {
      invalid = true;
      break;
    }
  }
  const claudeMode = claudeOption || dependencies.claudeCard !== undefined;
  const hasPrepared = preparedOption || preparedContext !== undefined;
  if (hasPrepared && (!claudeMode || (preparedOption && preparedContext !== undefined)
    || (preparedOption && (!isAbsolute(preparedFile) || CONTROL.test(preparedFile))))) invalid = true;
  if (carryFile !== undefined && (!claudeMode || hasPrepared)) invalid = true;
  let inheritedMark;
  let caller;
  let carried;
  if (claudeMode) {
    const pm = process.env.PRODUCT_MANAGER_RUN_SESSION;
    const pre = process.env.PRE_APPROVED_RUN_SESSION;
    if (pm === '1' && pre === undefined) inheritedMark = { PRODUCT_MANAGER_RUN_SESSION: pm };
    else if (pm === undefined && typeof pre === 'string' && RUN_START.test(pre) && !Number.isNaN(Date.parse(pre))) inheritedMark = { PRE_APPROVED_RUN_SESSION: pre };
    if (invalid || coordinatorOption || preApproved || continueCard !== undefined || !inheritedMark || typeof claudeCard !== 'string'
      || !isAbsolute(claudeCard) || CONTROL.test(claudeCard) || (hasPrepared && pm === '1')) {
      output.error(USAGE);
      return 2;
    }
    caller = process.env.CLAUDE_CODE_SESSION_ID;
    if (!SESSION_ID.test(caller ?? '')) {
      output.error('Claude card launch refused: CLAUDE_CODE_SESSION_ID must hold the launching Claude Code session ID');
      return 2;
    }
    if (preparedOption) {
      try {
        if (preparedFile !== claudeCard + '.request.json') throw new Error('prepared request does not match the fixed phase input identity');
        const stat = lstatSync(preparedFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('prepared context must be a regular unlinked file');
        preparedContext = JSON.parse(readFileSync(preparedFile, 'utf8'));
      } catch (error) {
        output.error(`Prepared context unavailable: ${error.message}`);
        return 1;
      }
    }
    for (const suffix of ['.json', '.stderr.log', '.card', '.coordinator']) {
      try {
        lstatSync(claudeCard + suffix);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        output.error(`Cannot inspect Claude output ${claudeCard + suffix}: ${error.message}`);
        return 2;
      }
      output.error(`Refusing existing Claude output: ${claudeCard + suffix}`);
      return 2;
    }
    if (carryFile !== undefined) {
      try {
        carried = readCarriedAnswer(carryFile, claudeCard, caller, dependencies.git ?? ((gitArgs) => gitReader(repositoryRoot())(gitArgs)));
      } catch (error) {
        output.error(`Carried answer refused: ${error.message}`);
        return 2;
      }
    }
  }
  coordinator ??= dependencies.coordinator;
  if (!claudeMode && (invalid || (continueCard !== undefined && (!preApproved || process.platform !== 'linux')) || typeof coordinator !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(coordinator))) {
    output.error(USAGE);
    return 2;
  }
  const kind = preApproved ? 'pre-approved' : 'product-manager';
  let root;
  try {
    root = repositoryRoot();
  } catch (error) {
    output.error(`cannot work out the repository root (${error.message})`);
    return 1;
  }
  if (preApproved || inheritedMark?.PRE_APPROVED_RUN_SESSION !== undefined) {
    try {
      requirePreApprovedRun({ git: dependencies.git ?? gitReader(root) });
    } catch (error) {
      output.error(error.message);
      return 1;
    }
  }
  if (claudeMode) return runClaudeCard(claudeCard, root, inheritedMark, dependencies, output, { preparedContext, caller, carried });
  const adapter = dependencies.managedPhase;
  const selectedManaged = preApproved && (adapter === true || typeof adapter === 'function'
    || (process.platform === 'linux' && dependencies.command === undefined && dependencies.startSession === undefined));
  const start = (dependencies.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const mark = kind === 'pre-approved' ? { PRE_APPROVED_RUN_SESSION: start } : { PRODUCT_MANAGER_RUN_SESSION: '1' };
  const command = dependencies.command ?? ['codex'];
  const notify = dependencies.notify ?? attentionSender(dependencies.queueCommand ?? ['codex'], coordinator, root, preApproved);
  const run = (folder, startSession) => runRun({ startSession, notify, root, folder, output, kind, runStart: start,
    exec: dependencies.exec ?? ghExec,
    git: dependencies.git ?? gitReader(root),
    inspectAdmission: dependencies.inspectAdmission ?? inspectAdmission });
  if (!selectedManaged && continueCard !== undefined) {
    output.error(USAGE);
    return 2;
  }
  if (!selectedManaged) return run(mkdtempSync(join(tmpdir(), 'product-manager-run-')),
    dependencies.startSession ?? sessionStarter(command, mark, dependencies));
  let folder;
  try {
    const temporary = realpathSync(tmpdir());
    const operatingRoot = realpathSync(root);
    verifyOutsideCheckouts(temporary, operatingRoot);
    folder = mkdtempSync(join(temporary, 'product-manager-run-'));
    mkdirSync(join(folder, 'units'), { mode: 0o700 });
    const store = wholeJobStore(operatingRoot);
    const launch = (startSession) => runWholeJobs({ startSession, notify, root: operatingRoot, folder, output, runStart: start,
      continueCard, store, exec: dependencies.exec ?? ghExec, git: dependencies.git ?? gitReader(operatingRoot),
      createIntent: (job, runStart) => createManagedIntent(CODEX_PROFILE, folder, `job-${job.card}`, operatingRoot, runStart, job).intentPath });
    if (typeof adapter === 'function') return await launch(adapter);
    const managed = await managedCodex({ folder, root: operatingRoot, runStart: start, command });
    let code;
    try {
      code = await launch(managed.startSession);
    } finally {
      await managed.close();
    }
    managed.signal.throwIfAborted();
    return code;
  } catch (error) {
    output.error(`Managed Codex run unavailable: ${error.message}.${folder ? ` Results: ${folder}` : ''}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
