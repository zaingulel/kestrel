import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ghExecModule from './gh-exec.mjs';
import {
  classifyGhFailure,
  ghArgvPrefix,
  ghExec,
  GhOutputTooLargeError,
  GhUnavailableError,
  ghStart,
  quotaWaitingGh,
  startedReadFailure,
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
  const result = classifyGhFailure(original, EXHAUSTED_PAYLOAD, ['api', 'graphql']);
  assert.notEqual(result, original);
  assert.match(result.message, /GitHub GraphQL quota exhausted \(0\/5000\)/);
  assert.match(result.message, /resets \d{2}:\d{2}/);
  assert.match(result.message, new RegExp(`resets ${EXPECTED_HHMM}`));
  assert.match(result.message, /underlying: API rate limit exceeded for user ID 12345/);
});

test('an exhausted REST or GraphQL quota carries its code and reset time', () => {
  const exhaustedOf = (resource, remaining = 0) => ({ resources: { [resource]: { limit: 5000, remaining, reset: 600 } } });
  const original = new Error('API rate limit exceeded for user ID 12345');
  const restCall = ['api', 'repos/o/r/issues'];
  const graphqlCalls = [
    ['api', 'graphql', '-f', 'query=...'],
    ['repo', 'view', 'o/r'],
    ['issue', 'view', '1'],
    ['pr', 'view', '1'],
    ['project', 'list'],
  ];
  const pairs = { core: [restCall], graphql: graphqlCalls };
  for (const [resource, calls] of Object.entries(pairs)) {
    for (const args of calls) {
      const label = `${resource} ${args.join(' ')}`;
      const result = classifyGhFailure(original, exhaustedOf(resource), args);
      assert.notEqual(result, original, label);
      assert.equal(result.code, 'GH_QUOTA', label);
      assert.equal(result.resetAt, 600000, label);
      assert.equal(classifyGhFailure(original, exhaustedOf(resource, 1), args), original, label);
    }
  }
  // A quota the request does not use is never blamed for it.
  assert.equal(classifyGhFailure(original, exhaustedOf('core'), graphqlCalls[0]), original, 'core, api graphql');
  assert.equal(classifyGhFailure(original, exhaustedOf('core'), graphqlCalls[2]), original, 'core, issue');
  assert.equal(classifyGhFailure(original, exhaustedOf('graphql'), restCall), original, 'graphql, rest api');
  const both = { resources: { core: { limit: 5000, remaining: 0, reset: 600 }, graphql: { limit: 5000, remaining: 0, reset: 600 } } };
  assert.equal(classifyGhFailure(original, both, ['run', 'list']), original, 'run list');
});

test('classifyGhFailure: remaining>0 returns the ORIGINAL error object identically', () => {
  const original = new Error('some other gh failure');
  const payload = { resources: { graphql: { limit: 5000, remaining: 42, reset: RESET_EPOCH } } };
  assert.equal(classifyGhFailure(original, payload, ['api', 'graphql']), original);
});

test('classifyGhFailure: null/malformed probe payload returns the original error', () => {
  const original = new Error('unknown owner type');
  assert.equal(classifyGhFailure(original, null, ['api', 'graphql']), original);
  assert.equal(classifyGhFailure(original, undefined, ['api', 'graphql']), original);
  assert.equal(classifyGhFailure(original, {}, ['api', 'graphql']), original);
  assert.equal(classifyGhFailure(original, { resources: {} }, ['api', 'graphql']), original);
  assert.equal(classifyGhFailure(original, 'not json {{{', ['api', 'graphql']), original);
  // An exhausted quota counts only with a usable reset: a finite number above 0 that names a real date.
  const withReset = (entry) => ({ resources: { graphql: { limit: 5000, remaining: 0, ...entry } } });
  const unusableResets = [{}, { reset: null }, { reset: 'soon' }, { reset: 0 }, { reset: -1 }, { reset: 1e20 }];
  for (const entry of unusableResets) {
    assert.equal(classifyGhFailure(original, withReset(entry), ['api', 'graphql']), original, JSON.stringify(entry));
  }
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
    (err) => err === tooLarge && /** @type {Error} */ (err).message === 'gh output exceeded the 64 MiB read limit',
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

test('ghExec: a failed command that uses no quota rethrows its error and makes no quota probe', () => {
  const calls = [];
  const execImpl = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'rate_limit') return JSON.stringify(EXHAUSTED_PAYLOAD);
    throw new Error('the real original failure');
  };
  assert.throws(() => ghExec(['run', 'list'], execImpl), /^Error: the real original failure$/);
  assert.deepEqual(calls, [['run', 'list']]);
});

test('ghStart: a started read settles to its reply, or to its failure classified as ghExec classifies it once the outcome is read', async () => {
  const noProbe = () => {
    throw new Error('a read that replied makes no quota probe');
  };
  const replied = await ghStart(['issue', 'view', '453'], async (args) => `reply to ${args.join(' ')}`, noProbe);
  assert.equal(replied(), 'reply to issue view 453');

  const probes = [];
  const execImpl = (args) => {
    probes.push(args);
    return JSON.stringify(EXHAUSTED_PAYLOAD);
  };
  const startImpl = async () => {
    throw new Error('API rate limit exceeded for user ID 12345');
  };
  const failed = await ghStart(['api', 'graphql', '-f', 'query=...'], startImpl, execImpl);
  assert.deepEqual(probes, [], 'the quota probe ran before the outcome was read');
  assert.throws(failed, /GitHub GraphQL quota exhausted \(0\/5000\)/);
  assert.deepEqual(probes, [['api', 'rate_limit']]);
});

test('startedReadFailure: a read killed at its timeout and a command that never started report in the synchronous runner\'s words', () => {
  const killed = Object.assign(new Error('Command failed: gh api graphql\n'), { code: null, killed: true, signal: 'SIGTERM', stderr: 'what gh had written' });
  const timedOut = startedReadFailure(killed, 'gh');
  assert.equal(timedOut.message, 'spawnSync gh ETIMEDOUT');
  assert.equal(timedOut.code, 'ETIMEDOUT');
  assert.equal(timedOut.stderr, 'what gh had written');
  assert.equal(timedOut.cause, killed);

  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', syscall: 'spawn gh', path: 'gh' });
  const neverStarted = startedReadFailure(missing, 'gh');
  assert.equal(neverStarted.message, 'spawnSync gh ENOENT');
  assert.equal(neverStarted.code, 'ENOENT');
  assert.equal(neverStarted.cause, missing);

  const exited = Object.assign(new Error('Command failed: gh api graphql\ngh: Not Found\n'), { code: 1, killed: false, signal: null, stderr: 'gh: Not Found\n' });
  assert.equal(startedReadFailure(exited, 'gh'), exited);
});

test('startedReadFailure: a reply over the read limit is the output-size error', () => {
  const overLimit = Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  const failure = startedReadFailure(overLimit, 'gh');
  assert.ok(failure instanceof GhOutputTooLargeError);
  assert.equal(failure.message, 'gh output exceeded the 64 MiB read limit');
  assert.equal(failure.cause, overLimit);
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

// The real ghExec and ghStart (no injected implementation) read BOARD_TOOLKIT_GH at call time, so
// these run them in a child process whose environment carries the override.
const GH_EXEC_URL = new URL('./gh-exec.mjs', import.meta.url).href;

const runGhExecModule = (script, env) => spawnSync(
  process.execPath,
  ['--input-type=module', '-e', script],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } },
);

const runRealGhExec = (env) => runGhExecModule(
  `import { ghExec } from ${JSON.stringify(GH_EXEC_URL)};
process.stdout.write(ghExec(['api', 'x']));`,
  env,
);

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

test('ghStart: the real start rejects a reply over the 64 MiB read limit as the output-size error', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gh-start-over-limit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const standIn = join(root, 'gh.cjs');
  writeFileSync(standIn, "process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, 'a'));\n");

  const run = runGhExecModule(
    `import { ghStart } from ${JSON.stringify(GH_EXEC_URL)};
const outcome = await ghStart(['api', 'x']);
try {
  outcome();
} catch (err) {
  process.stdout.write(err.constructor.name + ': ' + err.message);
}`,
    { BOARD_TOOLKIT_GH: JSON.stringify([process.execPath, standIn]) },
  );

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'GhOutputTooLargeError: gh output exceeded the 64 MiB read limit');
});

// One fake clock at 0 ms that `now()` reads and `sleepSync(ms)` advances; the allowance resets at 600 s, so the reset
// named is 600000 ms. `rawGh` is the bare runner behind `quotaWaitingGh`, recording each call's time and arguments.
function quotaClock(rawGh) {
  /** @type {{ time: number, waits: number[], holds: number[], rawCalls: [number, string[]][] }} */
  const clock = { time: 0, waits: [], holds: [], rawCalls: [] };
  const exec = quotaWaitingGh((args) => {
    clock.rawCalls.push([clock.time, args]);
    return rawGh(args);
  }, {
    now: () => clock.time,
    sleepSync: (ms) => {
      clock.waits.push(ms);
      clock.time += ms;
    },
    onHold: (resetAt) => clock.holds.push(resetAt),
  });
  return { clock, exec };
}

const quotaProbe = (args) => (args[0] === 'api' && args[1] === 'rate_limit'
  ? JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 0, reset: 600 } } })
  : undefined);

test('quotaWaitingGh waits out a refused read until the reset GitHub names and asks again once', () => {
  const quotaGone = (args) => {
    const probe = quotaProbe(args);
    if (probe !== undefined) return probe;
    throw new Error('API rate limit exceeded for user ID 12345');
  };
  const request = ['api', 'graphql', '-f', 'query=q'];

  // (a) the read is refused, the wait runs to the reset and the one repeat succeeds.
  let asked = 0;
  const first = quotaClock((args) => quotaProbe(args) ?? ((asked += 1) > 1 ? 'the reply' : quotaGone(args)));
  assert.equal(first.exec(request), 'the reply');
  assert.deepEqual(first.clock.rawCalls.map(([time]) => time), [0, 0, 600000]);
  assert.deepEqual(first.clock.waits, [600000]);
  assert.deepEqual(first.clock.holds, [600000]);

  // (b) the repeat is refused too: it is not asked again and the quota code reaches the caller.
  const second = quotaClock(quotaGone);
  assert.throws(() => second.exec(request), (error) => /** @type {Error & { code?: string }} */ (error).code === 'GH_QUOTA');
  assert.deepEqual(second.clock.rawCalls.map(([time]) => time), [0, 0, 600000, 600000]);
  assert.deepEqual(second.clock.waits, [600000]);
  assert.deepEqual(second.clock.holds, [600000]);
});

test('quotaWaitingGh repeats only the refused page of a paged read after the reset', () => {
  // Page 2's first request is refused, and nothing else is.
  let page2Asked = 0;
  const t = quotaClock((args) => {
    const probe = quotaProbe(args);
    if (probe !== undefined) return probe;
    if (args.includes('endCursor=page-1') && (page2Asked += 1) === 1) throw new Error('API rate limit exceeded for user ID 12345');
    return args.includes('endCursor=page-1') ? 'page 2' : 'page 1';
  });
  const pageRequest = (...cursor) => ['api', 'graphql', '-f', 'query=q', ...cursor];
  const refused = pageRequest('-f', 'endCursor=page-1');
  const pages = [t.exec(pageRequest()), t.exec(refused)];
  assert.deepEqual(pages, ['page 1', 'page 2']);
  assert.deepEqual(t.clock.rawCalls.map(([time, args]) => [time, args.includes('endCursor=page-1') ? 'page 2' : args[1] === 'rate_limit' ? 'probe' : 'page 1']),
    [[0, 'page 1'], [0, 'page 2'], [0, 'probe'], [600000, 'page 2']]);
  assert.deepEqual(t.clock.rawCalls[3][1], ['api', 'graphql', '-f', 'query=q', '-f', 'endCursor=page-1']);
  assert.deepEqual(t.clock.waits, [600000]);
  assert.deepEqual(t.clock.holds, [600000]);
});

test('a failed read is reported in plain words with its raw failure kept as details', () => {
  const failureReport = (error) => /** @type {any} */ (ghExecModule).failureReport(error);
  const quota = classifyGhFailure(new Error('API rate limit exceeded for user ID 12345\nsecond line'), EXHAUSTED_PAYLOAD, ['api', 'graphql']);
  const unavailable = new GhUnavailableError(503, new Error('Command failed: gh api graphql\ngh: HTTP 503\n'));

  assert.deepEqual(failureReport(Object.assign(new Error('Command failed: gh api graphql -f query=q\ngh: Bad credentials (HTTP 401)\n'), { status: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' })), {
    headline: 'GitHub did not accept the saved sign-in (HTTP 401). Sign in again with gh auth login, then read again.',
    details: 'Command failed: gh api graphql -f query=q gh: Bad credentials (HTTP 401)',
  });
  assert.deepEqual(failureReport(Object.assign(new Error('Command failed: gh api graphql -f query=q\ngh: Not Found (HTTP 404)\n'), { status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })), {
    headline: 'The gh command failed: Not Found (HTTP 404). Nothing retries on its own: read again once the cause is fixed.',
    details: 'Command failed: gh api graphql -f query=q gh: Not Found (HTTP 404)',
  });
  assert.deepEqual(failureReport(Object.assign(new Error('Command failed: gh api graphql -f query=q'), { status: 1, stderr: '' })), {
    headline: 'The gh command failed without saying why. Nothing retries on its own: read again once the cause is fixed.',
    details: 'Command failed: gh api graphql -f query=q',
  });
  assert.deepEqual(failureReport(new Error('spawnSync gh ETIMEDOUT')), {
    headline: 'GitHub did not answer within 60 seconds. Nothing retries on its own: read again in a minute.',
    details: 'spawnSync gh ETIMEDOUT',
  });
  assert.deepEqual(failureReport(new Error('spawnSync gh ENOENT')), {
    headline: 'The GitHub command-line tool gh was not found. Install it or put it on the PATH, then read again.',
    details: 'spawnSync gh ENOENT',
  });
  const report = failureReport(quota);
  assert.equal(report.headline, quota.message.split('\n')[0]);
  assert.doesNotMatch(report.headline, /Command failed/);
  assert.equal(report.details, 'API rate limit exceeded for user ID 12345 second line');
  assert.deepEqual(failureReport(unavailable), { headline: unavailable.message, details: 'Command failed: gh api graphql gh: HTTP 503' });
  assert.deepEqual(failureReport(new Error('something else\nbroke')), { headline: 'something else broke', details: null });
});

test('a slow outage stops retrying while the read can still finish within its retry budget', () => {
  const retryTransient = /** @type {any} */ (ghExecModule).retryTransient;
  let t = 0;
  const pauses = [];
  const read = () => {
    t += 30_000;
    throw Object.assign(new Error('Command failed: gh api graphql\ngh: HTTP 503\n'), { status: 1, stderr: 'gh: HTTP 503\n' });
  };

  assert.throws(
    () => retryTransient(read, (ms) => { pauses.push(ms); t += ms; }, read, { now: () => t, endsAt: 90_000 }),
    (error) => error instanceof GhUnavailableError
      && error.message === 'GitHub is temporarily unavailable (HTTP 503), still after 1 retry. Nothing retries on its own: try again in a minute.',
  );
  assert.deepEqual(pauses, [1000]);
});

test("only the status ending gh's message decides a retry or the sign-in advice", () => {
  const retryTransient = /** @type {any} */ (ghExecModule).retryTransient;
  const failureReport = /** @type {any} */ (ghExecModule).failureReport;
  const failure = (stderr) => Object.assign(new Error(`Command failed: gh api graphql -f query=q\n${stderr}`), { status: 1, stderr });

  const denied = failure('gh: Internal diagnostic (HTTP 503)\nResource access denied (HTTP 403)\n');
  const pauses = [];
  assert.throws(
    () => retryTransient(() => { throw denied; }, (ms) => pauses.push(ms)),
    (error) => error === denied,
  );
  assert.deepEqual(pauses, []);

  const missing = failure('gh: Resource named HTTP 401 is missing (HTTP 404)\n');
  assert.deepEqual(failureReport(missing), {
    headline: 'The gh command failed: Resource named HTTP 401 is missing (HTTP 404). Nothing retries on its own: read again once the cause is fixed.',
    details: 'Command failed: gh api graphql -f query=q gh: Resource named HTTP 401 is missing (HTTP 404)',
  });

  let attempts = 0;
  const twoLine = failure('gh: Service unavailable\nPlease try again (HTTP 503)\n');
  const reply = retryTransient(() => { attempts += 1; if (attempts === 1) throw twoLine; return 'answered'; }, () => {});
  assert.equal(reply, 'answered');
});
