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

import { execFileSync } from 'node:child_process';

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

export function runGh(args) {
  // Bounded timeout so a hung gh process (network stall, stray auth prompt) fails
  // loud instead of blocking a ritual forever; 60s covers the slowest --paginate
  // reads with wide margin. Applies to the rate-limit probe too (same exec).
  // The single call with no quota probe, for a caller that must make no read beyond its own.
  const [command, ...prefix] = ghArgvPrefix();
  try {
    return execFileSync(command, [...prefix, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: GH_MAX_OUTPUT_BYTES,
    });
  } catch (err) {
    if (err.code !== 'ENOBUFS') throw err;
    throw new GhOutputTooLargeError(err);
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Pure: given the error a `gh` invocation threw and the parsed (or raw-string)
// `gh api rate_limit` payload — or null/undefined when the probe itself failed —
// decide what to throw. Never masks a real failure: any payload that isn't a clean
// "graphql quota is exhausted" shape falls through to the original error untouched.
export function classifyGhFailure(originalError, rateLimitJson) {
  if (rateLimitJson == null) return originalError;
  let payload;
  try {
    payload = typeof rateLimitJson === 'string' ? JSON.parse(rateLimitJson) : rateLimitJson;
  } catch {
    return originalError;
  }
  const graphql = payload?.resources?.graphql;
  if (!graphql || graphql.remaining !== 0) return originalError;
  const reset = new Date(graphql.reset * 1000);
  const hhmm = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
  return new Error(
    `GitHub GraphQL quota exhausted (0/${graphql.limit}) — resets ${hhmm} — retry after that\n` +
    `underlying: ${originalError.message}`,
  );
}

// The wrapper CLIs call instead of invoking `gh` directly. `execImpl(args) → stdout`
// is injectable (defaults to `execFileSync` over the `ghArgvPrefix()` argv, which is
// the real `gh` unless `BOARD_TOOLKIT_GH` redirects it) so this is testable without `gh`.
// On failure, probes `rate_limit` in its OWN try/catch — a probe failure rethrows the
// original error, never the probe's.
export function ghExec(args, execImpl = runGh) {
  try {
    return execImpl(args);
  } catch (originalError) {
    // The reply's size, not the quota, is the cause; a probe could only relabel it.
    if (originalError instanceof GhOutputTooLargeError) throw originalError;
    let probePayload;
    try {
      probePayload = execImpl(['api', 'rate_limit']);
    } catch {
      throw originalError;
    }
    throw classifyGhFailure(originalError, probePayload);
  }
}
