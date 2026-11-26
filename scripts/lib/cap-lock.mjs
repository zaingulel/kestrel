// The coordinator's shared cap lock and checks for a still-running legacy lead.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MAX_CAP } from './pre-approved-run.mjs';

const DEFAULT_CAP = 4;

export function checkLeadFile(fd, path) {
  const file = fstatSync(fd);
  const named = lstatSync(path);
  const mode = file.mode & 0o7777;
  const fault = !file.isFile() ? 'is not a regular file' : file.nlink !== 1 ? 'has more than one link'
    : file.uid !== /** @type {() => number} */ (process.getuid)() ? 'belongs to another user' : mode !== 0o600 ? `has mode ${mode.toString(8).padStart(4, '0')}, not 0600`
      : file.dev !== named.dev || file.ino !== named.ino ? 'was replaced while the lead opened it' : undefined;
  if (fault) throw new Error(`${path} ${fault}`);
}

function openLeadFile(path, readOnly) {
  let fd;
  try {
    const access = readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_CREAT;
    fd = openSync(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    throw /** @type {NodeJS.ErrnoException} */ (error).code === 'ELOOP' ? new Error(`${path} is a symbolic link, not a lead file`) : error;
  }
  try {
    checkLeadFile(fd, path);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

// Runs `work` under the cap lock in `state`, so no other lead or coordinator takes or probes a place meanwhile.
export async function capLock(state, work) {
  const path = join(state, 'cap.lock');
  const lock = await lockLeadFile(path);
  if (lock === undefined) throw new Error(`${path} stayed locked for 5 s`);
  try {
    return await work();
  } finally {
    closeSync(lock);
  }
}

// Locks a checked descriptor. Shared probes discover exclusive holders without blocking one another.
/** @param {{ wait?: string[], signal?: AbortSignal, readOnly?: boolean, shared?: boolean }} [options] */
export async function lockLeadFile(path, options = {}) {
  const { wait = ['-w', '5'], signal, readOnly = false, shared = false } = options;
  const fd = openLeadFile(path, readOnly);
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/flock', [shared ? '-s' : '-x', ...wait, '-E', '75', '3'],
        { stdio: ['ignore', 'ignore', 'ignore', fd], signal });
      let fault;
      child.once('error', (error) => { fault = error; });
      child.once('close', (code) => fault ? reject(fault) : resolve(code));
    });
    if (status === 0 || status === 75) checkLeadFile(fd, path);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (status === 0) return fd;
  closeSync(fd);
  if (status !== 75) throw new Error(`${path} could not be locked: flock exited ${status}`);
  return undefined;
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

// The arguments of process `pid`, read from its whole NUL-ended command line of at most 64 KiB; throws when that
// cannot be read, so a longer one counts as unreadable, and an empty one as ESRCH, gone.
function processArguments(pid) {
  const limit = 64 * 1024;
  const fd = openSync(`/proc/${pid}/cmdline`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = readSync(fd, bytes, length, bytes.length - length, null);
    // Linux gives an exiting or zombie process an empty command line, so it counts as gone, as `standingLead` already treats ESRCH.
    if (length === 0) throw Object.assign(new Error(`process ${pid} has exited`), { code: 'ESRCH' });
    if (length > limit || bytes[length - 1] !== 0) throw new Error(`process ${pid}'s command line is unavailable`);
    return bytes.subarray(0, length - 1).toString('utf8').split('\0');
  } finally {
    closeSync(fd);
  }
}

const NODE_NON_FILE_OPTIONS = new Set(['-e', '-pe', '-p', '--eval', '--print', '--run']);
const NODE_OPTIONS_WITH_OPERANDS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '-C', '--conditions', '--env-file', '--env-file-if-exists',
]);

function nodeEntryCandidates(args) {
  const entries = [];
  let uncertain = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '-') break;
    if (argument === '--') {
      if (args[index + 1] !== undefined && args[index + 1] !== '-') entries.push(index + 1);
      break;
    }
    if (!argument.startsWith('-')) {
      if (argument !== 'inspect') entries.push(index);
      break;
    }
    const flag = argument.split('=', 1)[0].replaceAll('_', '-');
    if (NODE_NON_FILE_OPTIONS.has(flag)) break;
    if (argument.includes('=')) continue;
    if (NODE_OPTIONS_WITH_OPERANDS.has(flag)) {
      index++;
      continue;
    }
    const base = flag.replace(/^--(?:no-)?/, '');
    if (flag.startsWith('--') && process.allowedNodeEnvironmentFlags.has(`--no-${base}`)) continue;

    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      // It could be the entry itself. Keep walking in case the option consumed it instead.
      uncertain = true;
      index++;
      if (next !== 'inspect') entries.push(index);
    }
  }
  return { entries, uncertain };
}

// A removed script can still be running, so use its physical parent when the script entry is absent.
function leadScriptPath(folder, argument) {
  const name = basename(argument);
  if (name !== 'lead.mjs') return '';
  const path = resolve(folder, argument);
  try {
    return realpathSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return '';
  }
  try {
    lstatSync(path);
    // A dangling symlink still occupies the script entry.
    return '';
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return '';
  }
  try {
    return join(realpathSync(dirname(path)), name);
  } catch {
    // Without a resolvable parent, the missing script has no project identity.
    return '';
  }
}

// Keep possible standalone script identities separate from a proven entry.
export function standingLeadProcessCommand(pid) {
  const args = processArguments(pid);
  const folder = realpathSync(`/proc/${pid}/cwd`);
  const { entries, uncertain } = nodeEntryCandidates(args);
  if (!uncertain) {
    const [entry] = entries;
    return { args, script: leadScriptPath(folder, args[entry] ?? ''), entry };
  }
  const uncertainScripts = [];
  for (const entry of entries) {
    if (args.includes('--space', entry + 1)) continue;
    const script = leadScriptPath(folder, args[entry]);
    if (script) uncertainScripts.push(script);
  }
  return { args, script: '', uncertainScripts };
}

// The standing lead running the project at `root`: `{ pid }`, `{}` where none runs, or `{ cause, fix }` where that
// cannot be read. A standing lead is a Node process running this project's scripts/lead.mjs without `--space`.
// Legacy coordinated drivers used `--space`. Off Linux there is no /proc to identify these processes.
export function standingLead({ root, machine, env, command }) {
  const linux = `run ${command} on the Linux machine that runs Herdr`;
  if (machine.platform !== 'linux') return { cause: `${machine.platform} has no /proc to read running processes from`, fix: linux };
  const run = machine.run('pgrep', ['-u', String(machine.account.uid), '-f', 'scripts/lead\\.mjs'], { env });
  if (run.status === 1) return {};
  if (run.status !== 0) return { cause: run.stderr?.trim() || 'pgrep did not answer', fix: `check that pgrep runs, then rerun ${command}` };
  const lead = join(root, 'scripts', 'lead.mjs');
  for (const pid of run.stdout.trim().split('\n')) {
    let running;
    try {
      running = machine.processCommand(pid);
    } catch (error) {
      const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
      if (code === 'ENOENT' || code === 'ESRCH') continue;
      return { cause: message, fix: linux };
    }
    if (!['node', 'nodejs'].includes(basename(running.args[0]))) continue;
    if (running.script === lead && !running.args.includes('--space', (running.entry ?? 1) + 1)) return { pid };
    if (running.uncertainScripts?.includes(lead)) {
      return {
        cause: `Node options make it unclear whether process ${pid} runs ${lead}. Inspect its invocation`,
        fix: `rerun ${command} once the process entry point is clear`,
      };
    }
  }
  return {};
}
