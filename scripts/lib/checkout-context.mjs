// Resolves Git checkout identity for the root-checkout guard rule and the app run connection.
// Git decides whether a directory is the root checkout or a linked worktree. In the root checkout,
// --git-dir and --git-common-dir name the same .git directory. A linked worktree has a private
// Git directory under the shared common directory. The guard takes this context as an injected input.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { gitExecutable } from './posix-shell.mjs';

const isMainWorkingTree = (dir) => {
  // By path on Windows, whose bare-name search reaches the working directory first.
  const git = gitExecutable();
  if (!git) throw new Error('no git.exe in an absolute PATH entry');
  const [gitDir, commonDir] = execFileSync(
    git,
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim().split('\n');
  return gitDir === commonDir;
};

// Returns { checkout } for blockReason, carrying the platform whose path rules the walk resolves
// with, or { unresolved } naming why the hook's working directory could not be read (git missing,
// not a repository, a directory that does not exist). The hook then applies every other rule and
// says on stderr that this one was not applied: the guard is an accident-catcher, and wedging
// every Bash call on an unreadable directory is the wrong failure.
export function checkoutContext(cwd) {
  try {
    isMainWorkingTree(cwd);
  } catch {
    return { unresolved: `git cannot resolve the working directory ${cwd}` };
  }
  const isRootCheckout = (dir) => {
    // A directory git cannot read (a typo, a removed worktree, a path outside any repository) is
    // not the root checkout. That is the honest answer for the directory named; whether the shell
    // actually got there is the walk's business, and it names the `;`-chained failed cd as its
    // fail-open residual.
    try {
      return isMainWorkingTree(dir);
    } catch {
      return false;
    }
  };
  return { checkout: { cwd, isRootCheckout, platform: process.platform } };
}

export const CODEX_APP_RUN_UNAVAILABLE = 'a native app run connection is unavailable: ask the coordinator to inspect its designation and binding';
const APP_RUN_STEM = 'fabraik-app-run';
const MAX_APP_RUN_BYTES = 4096;
const APP_RUN_FIELDS = ['sessionId', 'kind', 'runStart', 'card'];
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export function isCodexAppRunRecord(record) {
  if (!record || typeof record !== 'object' || Object.keys(record).length !== APP_RUN_FIELDS.length ||
      !APP_RUN_FIELDS.every((name) => Object.hasOwn(record, name))) return false;
  const { sessionId, kind, runStart, card } = record;
  if (typeof sessionId !== 'string' || sessionId.length !== 36 || !SESSION_UUID.test(sessionId) ||
      (kind !== 'product-manager' && kind !== 'pre-approved') || !Number.isSafeInteger(card) || card <= 0 ||
      typeof runStart !== 'string' || !UTC_SECOND.test(runStart)) return false;
  const time = Date.parse(runStart);
  return Number.isFinite(time) && new Date(time).toISOString() === `${runStart.slice(0, -1)}.000Z`;
}

export function codexAppRunDesignationPath(operatingRoot, worktree) {
  const digest = createHash('sha256').update(worktree, 'utf8').digest('hex');
  return join(operatingRoot, '.git', APP_RUN_STEM, `${digest}.session`);
}

export const codexAppRunBindingPath = (gitDir) => join(gitDir, `${APP_RUN_STEM}.json`);

// `worktree` is the canonical session path, never the submitted command's working directory.
export function resolveCodexAppWorktree(worktree, operatingRoot, env = process.env) {
  const git = gitExecutable({ env });
  if (!git) throw new Error('Git is unavailable');
  const output = execFileSync(git, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], {
    cwd: worktree, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024,
  });
  const paths = output.replace(/\r?\n$/, '').split(/\r?\n/);
  if (paths.length !== 3 || !paths.every(isAbsolute)) throw new Error('Git worktree paths are unavailable');
  const [gitDir, commonDir, topLevel] = paths.map((path) => realpathSync.native(path));
  return { gitDir, linked: topLevel === worktree && gitDir !== commonDir && commonDir === join(realpathSync.native(operatingRoot), '.git') };
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function readAppRunFile(path) {
  const entry = statIfPresent(path);
  if (entry === null) return null;
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_APP_RUN_BYTES) throw new Error('Invalid app run file');
  // Check the opened entry as well so replacement after lstat cannot redirect the read.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.size > MAX_APP_RUN_BYTES || file.dev !== entry.dev || file.ino !== entry.ino) {
      throw new Error('Invalid app run file');
    }
    const bytes = Buffer.alloc(MAX_APP_RUN_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== file.size) throw new Error('App run file changed during read');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Null is affirmative exclusion of both entries; any failure to establish the pair stays unavailable.
export function readAppRunConnection({ sessionCwd, sessionId, reportedCwd, env = process.env, operatingRoot }) {
  const unavailable = { runUnavailable: CODEX_APP_RUN_UNAVAILABLE };
  try {
    const worktree = realpathSync.native(sessionCwd);
    const designationPath = codexAppRunDesignationPath(operatingRoot, worktree);
    const designationDir = statIfPresent(dirname(designationPath));
    if (designationDir && !designationDir.isDirectory()) return unavailable;
    const designation = designationDir === null ? null : readAppRunFile(designationPath);
    const { gitDir, linked } = resolveCodexAppWorktree(worktree, operatingRoot, env);
    const binding = readAppRunFile(codexAppRunBindingPath(gitDir));
    if (designation === null && binding === null) return null;
    if (designation === null || binding === null || !linked ||
        env.PRODUCT_MANAGER_RUN_SESSION !== undefined || env.PRE_APPROVED_RUN_SESSION !== undefined) return unavailable;
    const record = JSON.parse(binding);
    if (!isCodexAppRunRecord(record) || designation !== `${record.sessionId}\n` || sessionId !== record.sessionId ||
        typeof reportedCwd !== 'string' || !isAbsolute(reportedCwd) || realpathSync.native(reportedCwd) !== worktree) return unavailable;
    return { ...record, worktree };
  } catch {
    return unavailable;
  }
}
