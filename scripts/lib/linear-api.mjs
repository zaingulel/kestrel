// linear-api.mjs — the transport to Linear's GraphQL API: the key from its private file, one POST,
// and the answer's data or one classified failure.
//
// `linearExec` is the synchronous seam the board tools call, shaped like `ghExec`. It runs this
// file as a child process, so only that child ever holds the key: the payload goes in on stdin, the
// data comes back on stdout, and neither the key nor anything derived from it crosses the
// parent's argv or environment. Every text the child emits has the key replaced by `[key]`.
// The child exits 0 with the data, 3 for Linear's rate limit, and 1 for any other failure.

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

const RATE_LIMIT_EXIT = 3;
const MAX_KEY_FILE_BYTES = 4096;

/** @typedef {Error & { rateLimited?: boolean }} TransportError */
/** @typedef {{ error: NodeJS.ErrnoException, status: number | null, signal: NodeJS.Signals | null, stdout?: string | null, stderr?: string | null } | { error?: undefined, status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }} TransportRun */
/** @typedef {(command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => TransportRun} TransportSpawn */

export function linearKeyPath(home = homedir()) {
  return join(home, '.config', 'fabraik', 'linear-api-key');
}

// Every refusal names the path and never the file's content.
export function readLinearKey({ path, platform }) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (caught) {
    const error = /** @type {NodeJS.ErrnoException} */ (caught);
    if (error.code === 'ENOENT') throw new Error(`No Linear API key file at ${path}`);
    throw new Error(`The Linear API key file ${path} could not be read: ${error.code}`);
  }
  if (!stats.isFile()) throw new Error(`The Linear API key file ${path} is not a regular file`);
  // Windows has no group and other permission bits; the user profile is private by default.
  if (platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`The Linear API key file ${path} is open to other accounts: run chmod 600 ${path}`);
  }
  if (stats.size > MAX_KEY_FILE_BYTES) {
    throw new Error(`The Linear API key file ${path} is over ${MAX_KEY_FILE_BYTES} bytes`);
  }
  const key = readFileSync(path, 'utf8').trim();
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new Error(`The Linear API key file ${path} holds no key, or a key with whitespace or control characters`);
  }
  return key;
}

const AUTHENTICATION_TYPES = new Set(['authentication error', 'forbidden']);

function describeErrors(errors) {
  return errors.map((error) => `${error?.extensions?.type ?? error?.extensions?.code ?? 'error'}: ${error?.message}`).join('; ');
}

// The reset headers are epoch milliseconds.
function resetTime(headers, name) {
  const value = headers.get(name);
  if (value === null) return 'not given';
  const time = new Date(/^\d+$/.test(value) ? Number(value) : Number.NaN);
  return Number.isNaN(time.getTime()) ? `unreadable (${value})` : time.toISOString();
}

function rateLimitError(headers) {
  /** @type {TransportError} */
  const error = new Error(
    `Linear's API rate limit stopped the request: retry after the seconds in Retry-After (${headers.get('retry-after') ?? 'not given'}); ` +
      `requests reset at ${resetTime(headers, 'x-ratelimit-requests-reset')}, ` +
      `complexity resets at ${resetTime(headers, 'x-ratelimit-complexity-reset')}; nothing further was sent`,
  );
  error.rateLimited = true;
  return error;
}

/** Whether a thrown value is an error from any realm or a live wrapper around one; a revoked proxy is not. */
function isThrownError(caught) {
  try {
    return Error.isError(caught) || caught instanceof Error;
  } catch {
    return false;
  }
}

/** A thrown value read in one guarded step: a revoked proxy or a throwing getter gives a fixed message, never its text. */
function unreachable(caught) {
  if (!isThrownError(caught)) return 'Linear could not be reached: a non-error value was thrown';
  try {
    const error = /** @type {Error} */ (caught);
    const { cause } = error;
    const fields = /** @type {{ code?: unknown, name?: unknown }} */ ((typeof cause === 'object' || typeof cause === 'function') && cause !== null ? cause : {});
    for (const read of [() => fields.code, () => fields.name, () => error.name]) {
      const reason = read();
      if (typeof reason === 'string' || typeof reason === 'number') return `Linear could not be reached: ${reason}`;
    }
  } catch {
    // Fall through to the fixed message.
  }
  return 'Linear could not be reached: its error could not be read';
}

async function exchange(payload, { fetch, key }) {
  let response;
  let text;
  try {
    // A personal API key goes in the Authorization header as it is, with no `Bearer` prefix.
    response = await fetch(LINEAR_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    text = await response.text();
  } catch (caught) {
    throw new Error(unreachable(caught));
  }
  const { status } = response;
  let body;
  let parsed = true;
  try {
    body = JSON.parse(text);
  } catch {
    parsed = false;
  }
  // Linear's documents: "Always check for the errors array"; data beside errors is never returned.
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (status === 429 || errors.some((error) => error?.extensions?.code === 'RATELIMITED' || error?.extensions?.type === 'ratelimited')) {
    throw rateLimitError(response.headers);
  }
  if (status === 401 || status === 403 || errors.some((error) => AUTHENTICATION_TYPES.has(error?.extensions?.type))) {
    const said = errors.length > 0 ? `; Linear said ${describeErrors(errors)}` : '';
    throw new Error(
      `Linear refused the API key in ${linearKeyPath()} (HTTP ${status}): it needs Read and Write access to the board's team${said}`,
    );
  }
  if (!parsed) throw new Error(`Linear answered HTTP ${status} with a body that is not JSON`);
  const usage = errors.find((error) => error?.extensions?.type === 'usage limit exceeded');
  if (usage) throw new Error(`Linear's usage limit stopped the request: ${usage.message}`);
  if (errors.length > 0) throw new Error(`Linear answered HTTP ${status} with errors: ${describeErrors(errors)}`);
  if (status !== 200) throw new Error(`Linear answered HTTP ${status}`);
  if (body?.data == null) throw new Error(`Linear answered HTTP ${status} with no data`);
  return body.data;
}

const UNREADABLE_ERROR = 'Linear request failed: its error could not be read';

/** A thrown value read in one guarded step: a revoked proxy or a throwing getter gives a fixed message, never its text. */
function safeError(caught, key) {
  if (!isThrownError(caught)) return new Error('Linear request failed: a non-error value was thrown');
  try {
    const error = /** @type {TransportError} */ (caught);
    const text = error.message;
    if (typeof text !== 'string') return new Error(UNREADABLE_ERROR);
    // A fresh Error, so no stack recorded with the unredacted message survives.
    const redacted = /** @type {TransportError} */ (new Error(text.replaceAll(key, '[key]')));
    if (error.rateLimited === true) redacted.rateLimited = true;
    return redacted;
  } catch {
    return new Error(UNREADABLE_ERROR);
  }
}

// Returns the answer's data, or throws one classified Error with the key redacted; a rate limit
// carries `rateLimited: true`. Sends exactly one request.
export async function requestLinear(payload, { fetch, key }) {
  try {
    return await exchange(payload, { fetch, key });
  } catch (caught) {
    throw safeError(caught, key);
  }
}

// `BOARD_TOOLKIT_LINEAR` (a JSON argv array) redirects the child for the tooling tests, as
// `BOARD_TOOLKIT_GH` does for `gh`. A malformed value throws rather than falling back to the real
// transport, so a typo can never send a test run to Linear.
function transportArgv(raw = process.env.BOARD_TOOLKIT_LINEAR) {
  if (!raw) return [process.execPath, fileURLToPath(import.meta.url)];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`BOARD_TOOLKIT_LINEAR is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((arg) => typeof arg !== 'string' || arg === '')) {
    throw new Error(`BOARD_TOOLKIT_LINEAR must be a non-empty JSON array of non-empty strings: ${raw}`);
  }
  return parsed;
}

// `spawn` is the test seam that lets a timeout be observed without a real 60 s wait; callers pass
// two arguments.
/**
 * @param {string} query
 * @param {unknown} variables
 * @param {{ spawn?: TransportSpawn }} [seams]
 */
export function linearExec(query, variables, { spawn = spawnSync } = {}) {
  const [command, ...args] = transportArgv();
  const run = spawn(command, args, {
    input: JSON.stringify({ query, variables }),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (run.error?.code === 'ETIMEDOUT') throw new Error('Linear did not answer within 60 s');
  if (run.error) throw run.error;
  if (run.status === 0) return JSON.parse(run.stdout);
  /** @type {TransportError} */
  const error = new Error(run.stderr.trim() || `The Linear transport ended with ${run.signal ?? `exit ${run.status}`} and no message`);
  if (run.status === RATE_LIMIT_EXIT) error.rateLimited = true;
  throw error;
}

async function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const key = readLinearKey({ path: linearKeyPath(), platform: process.platform });
    const data = await requestLinear(payload, { fetch, key });
    // The key as it appears inside a JSON string, so an answer that echoes it is redacted too.
    process.stdout.write(JSON.stringify(data).replaceAll(JSON.stringify(key).slice(1, -1), '[key]'));
  } catch (caught) {
    const error = /** @type {TransportError} */ (caught);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.rateLimited ? RATE_LIMIT_EXIT : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
