// The coordinator's shared cap lock.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { insideWindowsProfile, isCanonicalLeadFolder, MAX_CAP } from './pre-approved-run.mjs';

const ACL_CHANGE_RIGHTS = ['add_file', 'add_subdirectory', 'delete_child', 'delete', 'writesecurity', 'chown'];

// The first allow entry in a macOS `ls -lde` listing that lets a principal other than `user` or root change the folder's entries, or undefined.
// An inherit-only entry counts only when `includeInheritOnly` is true.
export function aclGrantsOthers(listing, user, includeInheritOnly = false) {
  return listing.split('\n').slice(1).find((line) => {
    const entry = /^\s*\d+: (.+?) (?:inherited )?(allow|deny) (\S+)$/.exec(line);
    const rights = entry?.[3].split(',') ?? [];
    // An inherit-only entry does not apply to the folder it sits on, so an ancestor's is skipped; the lock folder's own reaches the lock files it holds.
    return entry?.[2] === 'allow' && entry[1] !== `user:${user}` && entry[1] !== 'user:root' && (includeInheritOnly || !rights.includes('only_inherit')) && rights.some((right) => ACL_CHANGE_RIGHTS.includes(right));
  });
}

const DEFAULT_CAP = 4;
const SQLITE_BUSY = 5;
const BUSY_RETRY_MS = 100;

// Windows has no owner ids or file modes to compare, so `platform` win32 skips those two checks.
export function checkLeadFile(fd, path, platform = process.platform) {
  const file = fstatSync(fd);
  const named = lstatSync(path);
  const mode = file.mode & 0o7777;
  const posix = platform !== 'win32';
  const fault = !file.isFile() ? 'is not a regular file' : file.nlink !== 1 ? 'has more than one link'
    : posix && file.uid !== /** @type {() => number} */ (process.getuid)() ? 'belongs to another user' : posix && mode !== 0o600 ? `has mode ${mode.toString(8).padStart(4, '0')}, not 0600`
      : file.dev !== named.dev || file.ino !== named.ino ? 'was replaced while the lead opened it' : undefined;
  if (fault) throw new Error(`${path} ${fault}`);
}

export function openLeadFile(path, platform = process.platform) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw /** @type {NodeJS.ErrnoException} */ (error).code === 'ELOOP' ? new Error(`${path} is a symbolic link, not a lead file`) : error;
  }
  try {
    checkLeadFile(fd, path, platform);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

// Runs work under the cap lock in state, so no other coordinator takes or probes a place meanwhile.
export async function capLock(state, work) {
  const path = join(state, 'cap.lock');
  const lock = await lockLeadFile(path);
  if (lock === undefined) throw new Error(`${path} stayed locked for 5 s`);
  try {
    return await work();
  } finally {
    lock.release();
  }
}

// Off Windows the folder must be private to this account, no ancestor changeable by another; on Windows, whose folder permissions Node cannot read, it
// must lie inside the user profile, whose default permissions the lock relies on.
function checkLockFolder(folder) {
  if (process.platform === 'win32') {
    const home = realpathSync.native(homedir());
    if (insideWindowsProfile(home, realpathSync.native(folder))) return;
    throw new Error(`${folder} must be inside the user profile ${home} on Windows`);
  }
  if (!isCanonicalLeadFolder(folder)) throw new Error(`${folder} must be a physical folder owned by this account with mode 0700`);
  // On macOS the folder's own access control list, inherit-only entries included, can let another account change the lock files.
  if (process.platform === 'darwin' && aclGrantsOthers(execFileSync('/bin/ls', ['-lde', folder], { encoding: 'utf8' }), userInfo().username, true)) {
    throw new Error(`${folder} has an access control list that lets another account change it`);
  }
  const uid = /** @type {() => number} */ (process.getuid)();
  for (let ancestor = dirname(folder); ; ancestor = dirname(ancestor)) {
    const { uid: owner, mode } = lstatSync(ancestor);
    if ((owner !== 0 && owner !== uid) || ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)) {
      throw new Error(`${folder} has an ancestor ${ancestor} that another account can change`);
    }
    // On macOS an access control list can let another account change entries whatever the mode says.
    if (process.platform === 'darwin' && aclGrantsOthers(execFileSync('/bin/ls', ['-lde', ancestor], { encoding: 'utf8' }), userInfo().username)) {
      throw new Error(`${folder} has an ancestor ${ancestor} that another account can change`);
    }
    if (dirname(ancestor) === ancestor) return;
  }
}

// Why the bigint stat `file` of `path` is not a lock file, or undefined when it is one.
function lockFileFault(path, file) {
  const mode = Number(file.mode & 0o7777n);
  const posix = process.platform !== 'win32';
  if (file.isSymbolicLink()) return 'is a symbolic link';
  if (!file.isFile()) return 'is not a regular file';
  if (file.nlink !== 1n) return 'has more than one link';
  if (file.size !== 0n) return 'is not empty';
  if (posix && file.uid !== BigInt(/** @type {() => number} */ (process.getuid)())) return 'belongs to another user';
  if (posix && mode !== 0o600) return `has mode ${mode.toString(8).padStart(4, '0')}, not 0600`;
  // SQLite would roll a journal beside the file back into it, so the lock file would no longer be empty.
  if (['-journal', '-wal'].some((suffix) => lstatSync(path + suffix, { throwIfNoEntry: false }))) return 'a SQLite journal is beside it';
  return undefined;
}

function admit(path) {
  const file = lstatSync(path, { bigint: true });
  const fault = lockFileFault(path, file);
  if (fault) throw new Error(`${path} is not a lock file: ${fault}`);
  return file;
}

// Why `path` no longer holds the `admitted` lock file, or undefined while it does. SQLite opens by name, so only
// this re-check ties a lock to the file that was admitted.
function lockFileChange(path, admitted) {
  const file = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!file) return 'another file took its place';
  return lockFileFault(path, file) ?? (file.dev !== admitted.dev || file.ino !== admitted.ino ? 'another file took its place' : undefined);
}

function createLockFile(path) {
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
  }
}

// One lock attempt on the admitted file: its handle, or undefined when another holder has it.
function attemptLock(path, admitted, { shared, create, open }) {
  let database;
  try {
    let busy = false;
    let refusal;
    try {
      database = open(path, { timeout: 0, readOnly: !create });
      if (shared) {
        database.exec('BEGIN');
        database.prepare('SELECT count(*) FROM sqlite_schema').get();
      } else {
        // A real SQLite database keeps page 1 in its main file, so a swapped-in one is refused before the pragma can touch it.
        if (database.prepare('PRAGMA page_count').get().page_count !== 0) {
          refusal = new Error(`${path} is not a lock file: is not empty`);
          throw refusal;
        }
        // SQLite's default journal would create `<path>-journal`, which admission refuses; MEMORY keeps it in RAM.
        database.exec('PRAGMA journal_mode = MEMORY');
        database.exec('BEGIN EXCLUSIVE');
      }
    } catch (error) {
      if (error === refusal) throw error;
      const { errcode, message } = /** @type {{ errcode?: number, message: string }} */ (error);
      if (errcode !== SQLITE_BUSY) throw new Error(`${path} could not be locked: ${message}`);
      busy = true;
    }
    const change = lockFileChange(path, admitted);
    if (change) throw new Error(`${path} changed while it was being locked: ${change}`);
    if (busy) {
      database?.close();
      return undefined;
    }
  } catch (error) {
    database?.close();
    throw error;
  }
  const held = /** @type {DatabaseSync} */ (database);
  let released = false;
  return {
    identity: { dev: admitted.dev, ino: admitted.ino },
    check() {
      const change = lockFileChange(path, admitted);
      if (change) throw new Error(`${path} changed while locked: ${change}`);
    },
    release() {
      if (released) return;
      released = true;
      try {
        held.exec('ROLLBACK');
      } finally {
        held.close();
      }
    },
  };
}

// Locks the empty lock file at `path` through SQLite, whose operating-system lock its holder's death frees: a handle
// `{ identity, check(), release() }`, or undefined when another holder kept it for `waitMs`. Shared probes discover
// exclusive holders without blocking one another, and a probe with `create: false` opens read-only and creates nothing.
/** @param {{ waitMs?: number, signal?: AbortSignal, shared?: boolean, create?: boolean, open?: (path: string, options: { timeout: number, readOnly: boolean }) => DatabaseSync }} [options] */
export async function lockLeadFile(path, options = {}) {
  const { waitMs = 5000, signal, shared = false, create = true, open = (file, settings) => new DatabaseSync(file, settings) } = options;
  if (!create && !shared) throw new Error(`${path} can be locked exclusively only by a lock that may create it`);
  checkLockFolder(dirname(path));
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    if (create && !lstatSync(path, { throwIfNoEntry: false })) createLockFile(path);
    const lock = attemptLock(path, admit(path), { shared, create, open });
    if (lock !== undefined || performance.now() >= deadline) return lock;
    await delay(BUSY_RETRY_MS, undefined, { signal }).catch((error) => { throw signal?.aborted ? signal.reason : error; });
  }
}

// The shared cap from the file at `path`: DEFAULT_CAP when there is none; throws, naming the cause, when it cannot be read.
export function readCap(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code === 'ENOENT') return DEFAULT_CAP;
    throw new Error(`${path} cannot be read: ${code ?? message}`);
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${/** @type {Error} */ (error).message}`);
  }
  const cap = settings?.cap;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) throw new Error(`${path} must set cap to a whole number from 1 to ${MAX_CAP}, not ${JSON.stringify(cap)}`);
  return cap;
}
