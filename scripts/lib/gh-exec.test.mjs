import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyGhFailure,
  ghArgvPrefix,
  ghExec,
  GhOutputTooLargeError,
} from './gh-exec.mjs';

// Fixed epoch (independent of when this test runs) so the expected HH:MM is a
// literal, not something re-derived with the pad2 logic under test.
const RESET_EPOCH = 1751000000; // arbitrary fixed instant
const resetDate = new Date(RESET_EPOCH * 1000);
const EXPECTED_HHMM = resetDate.toTimeString().slice(0, 5); // "HH:MM", independent formatter

const EXHAUSTED_PAYLOAD = {
  resources: { graphql: { limit: 5000, remaining: 0, reset: RESET_EPOCH } },
};

test('classifyGhFailure: remaining=0 returns a NEW error naming quota, limit, reset time, and the underlying message', () => {
  const original = new Error('API rate limit exceeded for user ID 12345');
  const result = classifyGhFailure(original, EXHAUSTED_PAYLOAD);
  assert.notEqual(result, original);
  assert.match(result.message, /GitHub GraphQL quota exhausted \(0\/5000\)/);
  assert.match(result.message, /resets \d{2}:\d{2}/);
  assert.match(result.message, new RegExp(`resets ${EXPECTED_HHMM}`));
  assert.match(result.message, /underlying: API rate limit exceeded for user ID 12345/);
});

test('classifyGhFailure: remaining>0 returns the ORIGINAL error object identically', () => {
  const original = new Error('some other gh failure');
  const payload = { resources: { graphql: { limit: 5000, remaining: 42, reset: RESET_EPOCH } } };
  assert.equal(classifyGhFailure(original, payload), original);
});

test('classifyGhFailure: null/malformed probe payload returns the original error', () => {
  const original = new Error('unknown owner type');
  assert.equal(classifyGhFailure(original, null), original);
  assert.equal(classifyGhFailure(original, undefined), original);
  assert.equal(classifyGhFailure(original, {}), original);
  assert.equal(classifyGhFailure(original, { resources: {} }), original);
  assert.equal(classifyGhFailure(original, 'not json {{{'), original);
});

test('ghExec: success passes stdout through and calls execImpl once with the given args', () => {
  const calls = [];
  const execImpl = (args) => {
    calls.push(args);
    return 'ok-stdout';
  };
  const result = ghExec(['issue', 'view', '453'], execImpl);
  assert.equal(result, 'ok-stdout');
  assert.deepEqual(calls, [['issue', 'view', '453']]);
});

test('ghExec: failure + stubbed probe remaining=0 throws the quota error', () => {
  const execImpl = (args) => {
    if (args[0] === 'api' && args[1] === 'rate_limit') return JSON.stringify(EXHAUSTED_PAYLOAD);
    throw new Error('API rate limit exceeded for user ID 12345');
  };
  assert.throws(
    () => ghExec(['api', 'graphql', '-f', 'query=...'], execImpl),
    /GitHub GraphQL quota exhausted \(0\/5000\)/,
  );
});

test('ANTI-REGRESSION: ghExec rethrows an output-size error unchanged and never probes the quota', () => {
  const tooLarge = new GhOutputTooLargeError(new Error('spawnSync gh ENOBUFS'));
  const calls = [];
  const execImpl = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'rate_limit') return JSON.stringify(EXHAUSTED_PAYLOAD);
    throw tooLarge;
  };
  assert.throws(
    () => ghExec(['issue', 'view', '453'], execImpl),
    (err) => err === tooLarge && err.message === 'gh output exceeded the 64 MiB read limit',
  );
  assert.equal(calls.length, 1);
});

test('ghExec: failure + probe that ITSELF throws rethrows the ORIGINAL error (probe never masks)', () => {
  const execImpl = (args) => {
    if (args[0] === 'api' && args[1] === 'rate_limit') throw new Error('probe network failure');
    throw new Error('the real original failure');
  };
  assert.throws(() => ghExec(['issue', 'view', '453'], execImpl), /^Error: the real original failure$/);
});


test('ghArgvPrefix: unset or empty BOARD_TOOLKIT_GH is the real gh', () => {
  assert.deepEqual(ghArgvPrefix(undefined), ['gh']);
  assert.deepEqual(ghArgvPrefix(''), ['gh']);
});

test('ghArgvPrefix: a valid override is returned as the parsed argv prefix', () => {
  assert.deepEqual(ghArgvPrefix('["/usr/bin/node","/tmp/gh.cjs"]'), ['/usr/bin/node', '/tmp/gh.cjs']);
});

test('ghArgvPrefix: a value that is not JSON throws naming BOARD_TOOLKIT_GH', () => {
  assert.throws(() => ghArgvPrefix('gh'), /BOARD_TOOLKIT_GH is not valid JSON: gh/);
  assert.throws(() => ghArgvPrefix('[oops'), /BOARD_TOOLKIT_GH is not valid JSON: \[oops/);
});

test('ghArgvPrefix: a JSON value that is not an array throws naming BOARD_TOOLKIT_GH', () => {
  assert.throws(() => ghArgvPrefix('"gh"'), /BOARD_TOOLKIT_GH must be a non-empty JSON array of strings: "gh"/);
  assert.throws(
    () => ghArgvPrefix('{"cmd":"gh"}'),
    /BOARD_TOOLKIT_GH must be a non-empty JSON array of strings: \{"cmd":"gh"\}/,
  );
});

test('ghArgvPrefix: an empty array throws naming BOARD_TOOLKIT_GH', () => {
  assert.throws(() => ghArgvPrefix('[]'), /BOARD_TOOLKIT_GH must be a non-empty JSON array of strings: \[\]/);
});

test('ghArgvPrefix: an array holding a non-string throws naming BOARD_TOOLKIT_GH', () => {
  assert.throws(
    () => ghArgvPrefix('["gh", 1]'),
    /BOARD_TOOLKIT_GH must be a non-empty JSON array of strings: \["gh", 1\]/,
  );
});

// The real ghExec (no injected execImpl) reads BOARD_TOOLKIT_GH at call time, so these run it
// in a child process whose environment carries the override.
const GH_EXEC_URL = new URL('./gh-exec.mjs', import.meta.url).href;

function runRealGhExec(env) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { ghExec } from ${JSON.stringify(GH_EXEC_URL)};
process.stdout.write(ghExec(['api', 'x']));`,
    ],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } },
  );
}

test('ghExec: the real exec runs the command BOARD_TOOLKIT_GH names, with the gh args appended', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gh-exec-override-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const standIn = join(root, 'gh.cjs');
  writeFileSync(standIn, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

  const run = runRealGhExec({ BOARD_TOOLKIT_GH: JSON.stringify([process.execPath, standIn]) });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['api', 'x']);
});

test('ghExec: a malformed BOARD_TOOLKIT_GH makes the real exec throw the naming error before any gh runs', (t) => {
  // PATH holds only an empty directory, so no `gh` is reachable: a fallback to the real CLI would
  // fail with ENOENT instead of the naming error.
  const emptyBin = mkdtempSync(join(tmpdir(), 'gh-exec-empty-path-'));
  t.after(() => rmSync(emptyBin, { recursive: true, force: true }));

  const run = runRealGhExec({ BOARD_TOOLKIT_GH: 'gh', PATH: emptyBin });

  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /Error: BOARD_TOOLKIT_GH is not valid JSON: gh/);
});
