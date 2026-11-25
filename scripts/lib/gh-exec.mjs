// gh-exec.mjs — the shared `gh` CLI wrapper that reports GraphQL-quota exhaustion
// honestly.
//
// #461: when the GitHub GraphQL hourly budget is exhausted, `gh` fails with
// misleading messages ("unknown owner type", "API rate limit exceeded for user ID
// ..." with no reset time). In the 2026-07-20 incident this sent debugging toward
// auth when the real answer was "wait 90 seconds". `ghExec` runs the real command
// and, ONLY on failure, probes the free `rate_limit` endpoint (costs nothing against
// the quota) — if the quota is genuinely the culprit it rethrows a new error naming
// the true cause + reset time; otherwise it rethrows the ORIGINAL error unchanged so
// the probe can never mask a real failure.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

// Every `gh` invocation goes through one argv prefix, overridable by `BOARD_TOOLKIT_GH` (a JSON
// array). That seam exists for the tooling tests: on Windows `execFile("gh")` resolves only
// `gh.exe` through CreateProcess, so an extensionless stand-in dropped on PATH is never run and
// the test reaches LIVE GitHub instead. A malformed value throws rather than falling back to the
// real CLI, so a typo in the override can never spend a test run against real GitHub. The name
// sits outside gh's own `GH_` environment namespace on purpose, so it cannot collide with a
// variable gh itself reads.
export function ghArgvPrefix(raw = process.env.BOARD_TOOLKIT_GH) {
  if (!raw) return ['gh'];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`BOARD_TOOLKIT_GH is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((a) => typeof a !== 'string')) {
    throw new Error(`BOARD_TOOLKIT_GH must be a non-empty JSON array of strings: ${raw}`);
  }
  return parsed;
}

// gh's whole reply is buffered, and one detail read carries up to 20 cards' bodies and
// comments; Node's 1 MiB default failed valid reads.
const GH_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class GhOutputTooLargeError extends Error {
  constructor(cause) {
    super(`gh output exceeded the ${GH_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB read limit`, { cause });
  }
}

// Bounded timeout so a hung gh process (network stall, stray auth prompt) fails
// loud instead of blocking a ritual forever; 60s covers the slowest --paginate
// reads with wide margin. Applies to the rate-limit probe too (same exec).
const GH_TIMEOUT_MS = 60_000;

export function runGh(args, env = process.env) {
  // The single call with no quota probe, for a caller that must make no read beyond its own.
  const [command, ...prefix] = ghArgvPrefix();
  try {
    return execFileSync(command, [...prefix, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_OUTPUT_BYTES,
    });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOBUFS') throw err;
    throw new GhOutputTooLargeError(err);
  }
}

// Pure: the failure of a read `execFile` ran, as `runGh` reports the same failure, so a caller reads one
// wording whichever way the read was made. `execFile` names a reply over the limit by its own code, a
// read it killed at the timeout by no cause at all, and a command that never started as `spawn`, where
// `execFileSync` says `spawnSync`. Any other failure, a non-zero exit among them, already reads the same
// and is returned as it is.
export function startedReadFailure(err, command) {
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GhOutputTooLargeError(err);
  if (err.killed) {
    return Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`, { cause: err }), { code: 'ETIMEDOUT', stderr: err.stderr });
  }
  if (typeof err.syscall === 'string' && err.syscall.startsWith('spawn ')) {
    return Object.assign(new Error(`spawnSync ${command} ${err.code}`, { cause: err }), { code: err.code });
  }
  return err;
}

const execFileStarted = promisify(execFile);

// `runGh` as a started read: the same command, timeout and read limit, without blocking the caller, so
// several reads can be in flight at once. The child's input is left as `execFile` opens it: no gh call
// here reads input.
async function startGh(args) {
  const [command, ...prefix] = ghArgvPrefix();
  try {
    const { stdout } = await execFileStarted(command, [...prefix, ...args], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (err) {
    throw startedReadFailure(err, command);
  }
}

const GRAPHQL_COMMANDS = new Set(['repo', 'issue', 'pr', 'project']);

// The quota a request uses, 'graphql' or 'core', or null for a command that uses neither.
function quotaUsed(args) {
  const [command] = args;
  if (command === 'api') return args.includes('graphql') ? 'graphql' : 'core';
  return GRAPHQL_COMMANDS.has(command) ? 'graphql' : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Pure: given the error a `gh` invocation threw and the parsed (or raw-string)
// `gh api rate_limit` payload — or null/undefined when the probe itself failed —
// decide what to throw. Never masks a real failure: any payload that isn't a clean
// "the request's own quota is exhausted" shape falls through to the original error untouched. A quota is
// blamed only for a request that uses it: `gh api` with a `graphql` argument and gh's `repo`, `issue`,
// `pr` and `project` commands use `graphql`, any other `gh api` call uses `core`, and any other command
// uses neither. An exhausted quota counts only with a usable reset, a finite number above 0 that names a real
// date, and is thrown with `code: 'GH_QUOTA'` and `resetAt`, the reset in epoch milliseconds.
export function classifyGhFailure(originalError, rateLimitJson, args) {
  const used = quotaUsed(args);
  if (used === null) return originalError;
  if (rateLimitJson == null) return originalError;
  let payload;
  try {
    payload = typeof rateLimitJson === 'string' ? JSON.parse(rateLimitJson) : rateLimitJson;
  } catch {
    return originalError;
  }
  const resources = payload?.resources;
  const exhausted = resources?.[used];
  if (exhausted?.remaining !== 0) return originalError;
  if (!Number.isFinite(exhausted.reset) || exhausted.reset <= 0) return originalError;
  const kind = used === 'graphql' ? 'GraphQL' : 'REST';
  const reset = new Date(exhausted.reset * 1000);
  if (Number.isNaN(reset.getTime())) return originalError;
  const hhmm = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
  return Object.assign(
    new Error(
      `GitHub ${kind} quota exhausted (0/${exhausted.limit}) — resets ${hhmm} — retry after that\n` +
      `underlying: ${originalError.message}`,
    ),
    { code: 'GH_QUOTA', resetAt: exhausted.reset * 1000 },
  );
}

// What a failed `gh` call is reported as. It probes `rate_limit` only for a request that uses a quota,
// in its OWN try/catch — a probe failure leaves the original error, never the probe's.
function failureCause(originalError, execImpl, args) {
  // The reply's size, not the quota, is the cause; a probe could only relabel it.
  if (originalError instanceof GhOutputTooLargeError) return originalError;
  if (quotaUsed(args) === null) return originalError;
  let probePayload;
  try {
    probePayload = execImpl(['api', 'rate_limit']);
  } catch {
    return originalError;
  }
  return classifyGhFailure(originalError, probePayload, args);
}

// The wrapper CLIs call instead of invoking `gh` directly. `execImpl(args) → stdout`
// is injectable (defaults to `execFileSync` over the `ghArgvPrefix()` argv, which is
// the real `gh` unless `BOARD_TOOLKIT_GH` redirects it) so this is testable without `gh`.
// A failure is thrown as `failureCause` reports it.
export function ghExec(args, execImpl = runGh) {
  try {
    return execImpl(args);
  } catch (originalError) {
    throw failureCause(originalError, execImpl, args);
  }
}

// A real wait that blocks the caller, for a synchronous read that must pause before asking again.
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// How long a read waits before each retry of a request GitHub answered with a 502, 503 or 504: three retries,
// after 1, 4 and 9 seconds, as Octokit's retry plugin waits by default.
const TRANSIENT_RETRY_WAITS_MS = [1_000, 4_000, 9_000];

// How long one board read may spend, retries included, before it stops retrying: 30 seconds of headroom under the
// panel's 120 second collector limit (COLLECTOR_TIMEOUT_MS in .agents/herdr/fabraik-queue/queue.mjs), so a slow outage
// usually ends in a plain failure rather than the panel's timeout; a retry much slower than the attempt before it can
// still reach that timeout.
const TRANSIENT_RETRY_BUDGET_MS = 90_000;

/** The budget one read shares across all its requests: the clock it is timed by, when it started and the instant it runs out. */
export function retryBudget(now = Date.now, budgetMs = TRANSIENT_RETRY_BUDGET_MS) {
  const startedAt = now();
  return { now, startedAt, endsAt: startedAt + budgetMs };
}

// gh prints `gh: HTTP 503` when GitHub's error body is not JSON, or `gh: <message> (HTTP 503)` when it is, a message
// that may span several lines, the status ending the last. Only that ending is the request's status: an earlier line
// or a status named inside the message is not.
const TERMINAL_STATUS = /^gh: HTTP (\d{3})$|\(HTTP (\d{3})\)$/;

function terminalStatus(stderr) {
  const match = TERMINAL_STATUS.exec(stderr.trim().split(/\r?\n/).at(-1).trim());
  return match === null ? null : Number(match[1] ?? match[2]);
}

// A request GitHub still answered with a 502, 503 or 504 after the retries its budget allowed. Its message is plain,
// for a reader who needs no command line, and states the retries made; `cause` holds the last failure, raw command
// included.
export class GhUnavailableError extends Error {
  constructor(status, cause, retries = TRANSIENT_RETRY_WAITS_MS.length) {
    const made = retries === 0 ? '' : `, still after ${retries} ${retries === 1 ? 'retry' : 'retries'}`;
    super(`GitHub is temporarily unavailable (HTTP ${status})${made}. Nothing retries on its own: try again in a minute.`, { cause });
    this.code = 'GH_UNAVAILABLE';
    this.status = status;
  }
}

// `read()`'s reply, asking `again()` after each wait while the request fails with a 502, 503 or 504. Any other failure
// is thrown as it is, at once; one that is still a 502, 503 or 504 after the last retry, or when the next retry could
// not finish within `budget`, is thrown as GhUnavailableError. A retry starts only if its wait plus a repeat of the
// last attempt's length still ends by the budget. Only reads use it: a 502 or 504 on a write may already have landed.
// `firstStartedAt` is when the first attempt began, for a read a caller started before this call.
/** @param {() => unknown} read @param {(ms: number) => void} [pause] @param {() => unknown} [again] @param {ReturnType<typeof retryBudget>} [budget] @param {number} [firstStartedAt] */
export function retryTransient(read, pause = sleepSync, again = read, budget = retryBudget(), firstStartedAt) {
  for (let retry = 0; ; retry += 1) {
    const startedAt = retry === 0 && firstStartedAt !== undefined ? firstStartedAt : budget.now();
    try {
      return retry === 0 ? read() : again();
    } catch (error) {
      const status = terminalStatus(String(/** @type {{ stderr?: unknown }} */ (error)?.stderr ?? ''));
      if (status !== 502 && status !== 503 && status !== 504) throw error;
      if (retry === TRANSIENT_RETRY_WAITS_MS.length) throw new GhUnavailableError(status, error);
      const wait = TRANSIENT_RETRY_WAITS_MS[retry];
      if (budget.now() + wait + (budget.now() - startedAt) > budget.endsAt) throw new GhUnavailableError(status, error, retry);
      pause(wait);
    }
  }
}

const fold = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

// A failed read as `{ headline, details }`: the plain cause for a reader who needs no command line, and the raw
// failure for whoever does, or null where the message is already plain. The first rule that matches wins.
export function failureReport(error) {
  const message = String(error.message);
  const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? '');
  if (error instanceof GhUnavailableError) return { headline: message, details: fold(String(/** @type {Error} */ (error.cause).message)) };
  if (/** @type {{ code?: unknown }} */ (error).code === 'GH_QUOTA') {
    return { headline: message.split('\n')[0], details: fold(message.slice(message.indexOf('underlying: ') + 'underlying: '.length)) };
  }
  if (message === 'spawnSync gh ETIMEDOUT') {
    return { headline: 'GitHub did not answer within 60 seconds. Nothing retries on its own: read again in a minute.', details: message };
  }
  if (message === 'spawnSync gh ENOENT') {
    return { headline: 'The GitHub command-line tool gh was not found. Install it or put it on the PATH, then read again.', details: message };
  }
  const failed = /^Command failed: (\S+)/.exec(message);
  if (failed === null) return { headline: fold(message), details: null };
  if (terminalStatus(stderr) === 401) {
    return { headline: 'GitHub did not accept the saved sign-in (HTTP 401). Sign in again with gh auth login, then read again.', details: fold(message) };
  }
  const reason = stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')?.replace(/^gh: /, '').replace(/\.$/, '');
  const why = reason === undefined ? 'failed without saying why' : `failed: ${reason}`;
  return { headline: `The ${failed[1]} command ${why}. Nothing retries on its own: read again once the cause is fixed.`, details: fold(message) };
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Match the standalone panel's notification attribution rule for a login as stored.
export const isGitHubLogin = (value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);

// The GitHub login gh is signed in as, or null where the read fails or prints anything but one login.
/** @param {(args: string[]) => string} [execute] */
export function readGitHubLogin(execute = ghExec) {
  try {
    const login = execute(['api', 'user', '--jq', '.login']).replace(/\n$/, '');
    return GITHUB_LOGIN.test(login) ? login : null;
  } catch {
    return null;
  }
}

// `ghExec` over `rawGh` for a caller that waits out GitHub's own quota refusal: a request refused for quota calls
// `onHold(resetAt)`, then `sleepSync` for the time left until that reset, and asks that request once more; a second
// refusal reaches the caller. Marked `onePagePerRequest`, so the board reader hands it one page per call and the repeat
// asks only for the refused page.
/** @param {(args: string[]) => string} rawGh @param {{ now?: () => number, sleepSync: (ms: number) => void, onHold?: (resetAt: number) => void }} options */
export function quotaWaitingGh(rawGh, { now = Date.now, sleepSync, onHold }) {
  return Object.assign((args) => {
    try {
      return ghExec(args, rawGh);
    } catch (error) {
      const { code, resetAt } = /** @type {Error & { code?: string, resetAt: number }} */ (error);
      if (code !== 'GH_QUOTA') throw error;
      onHold?.(resetAt);
      const wait = resetAt - now();
      if (wait > 0) sleepSync(wait);
      return ghExec(args, rawGh);
    }
  }, { onePagePerRequest: true });
}

// Waits for a read and never rejects: it resolves to a function that returns the read's reply or
// throws its failure, so reads awaited together all settle before any outcome is looked at, and one
// failure cannot hide another read's result. `failure` is worked out only when that function is called.
export async function settledRead(read, failure = (error) => error) {
  try {
    const reply = await read();
    return () => reply;
  } catch (error) {
    return () => {
      throw failure(error);
    };
  }
}

// `ghExec` as a started read, for reads that do not depend on each other: the caller starts them
// together, awaits them all, then reads each outcome. A failure's quota probe is a synchronous call,
// which would hold up every read still in flight, so it runs when the outcome is read. `startImpl`
// and `execImpl` are injectable as `ghExec`'s `execImpl` is.
export const ghStart = (args, startImpl = startGh, execImpl = runGh) =>
  settledRead(() => startImpl(args), (error) => failureCause(error, execImpl, args));
