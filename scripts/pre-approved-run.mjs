#!/usr/bin/env node
// Native app job binding, phase preparation and admission. These commands do not dispatch a session.
// --pre-approved exits 2 with guidance to start the run in the Codex app at the repository root.
// Run: node scripts/pre-approved-run.mjs
// --check-admission <absolute request file> to judge one pre-approved admission request without starting a session:
// it prints one JSON decision and exits 0 for allow, 3 for wait and 1 for unavailable; malformed arguments exit 2.
// Or --bind-app-job <absolute request file> to bind a verified detached checkout without starting a session:
// it prints one JSON bound decision on success, exits 1 if binding is unavailable or 2 for invalid arguments.
// Or --prepare-app-phase <absolute phase-log-base> <ready-session-uuid> <original-claim-created-at>
// [<absolute admission-request-file>] to retain an admitted native phase and return its prompt without dispatch.
// It exits 0 for allow, 3 for wait, 1 for unavailable or 2 for invalid arguments.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitEnvironment } from './lib/factory-sync.mjs';
import { ghExec } from './lib/gh-exec.mjs';
import { requireMergeOnEvidence } from './lib/merge-evidence.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';
import { codexAppRunBindingPath, codexAppRunDesignationPath, isCodexAppRunRecord, readAppRunConnection, resolveCodexAppWorktree } from './lib/checkout-context.mjs';
import { SESSION_ID, inspectAdmission, prepareAppPhase } from './lib/pre-approved-run.mjs';

const USAGE = 'usage: node scripts/pre-approved-run.mjs --check-admission <absolute request file> | --bind-app-job <absolute request file> | --prepare-app-phase <absolute phase-log-base> <ready-session-uuid> <original-claim-created-at> [<absolute admission-request-file>]';
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

  const env = /** @type {NodeJS.ProcessEnv} */ (gitEnvironment());
  const executable = gitExecutable({ env });
  // The retired product manager mark still counts as a mark: an environment that carries it is no unmarked coordinator.
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
    if (/** @type {NodeJS.ErrnoException & { status?: number | null }} */ (error).status !== 1) throw error;
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
  requireMergeOnEvidence({ git: gitAtBase });

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
    answer = { decision: 'unavailable', reasons: [/** @type {Error} */ (error).message] };
  }
  if (answer === null) {
    output.error(USAGE);
    return 2;
  }
  output.log(JSON.stringify(answer));
  return ADMISSION_EXIT[answer.decision];
}

// Only tests replace the output, readers and admission request.
export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
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
  const admissionFile = args[0] === '--check-admission';
  const admissionInput = dependencies.admissionRequest !== undefined;
  if (admissionFile || admissionInput) {
    if (admissionInput ? args.length !== 0 : args.length !== 2 || !isAbsolute(args[1]) || CONTROL.test(args[1])) {
      output.error('usage: node scripts/pre-approved-run.mjs --check-admission <absolute request file>');
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
      answer = { decision: 'unavailable', reasons: [/** @type {Error} */ (error).message] };
    }
    output.log(JSON.stringify(answer));
    return ADMISSION_EXIT[answer.decision];
  }
  if (args.includes('--pre-approved')) {
    output.error('Pre-approved Codex run refused: start the run in the Codex app at the repository root so every card has a visible chat.');
    return 2;
  }
  output.error(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
