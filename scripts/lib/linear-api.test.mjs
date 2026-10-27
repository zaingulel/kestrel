// linear-api.test.mjs — tests of the Linear transport.
// Run: node --test scripts/lib/linear-api.test.mjs
//
// Expected values come from Linear's documents: the GraphQL page gives the endpoint
// https://api.linear.app/graphql, a personal API key sent as `Authorization: <KEY>` with no Bearer
// prefix, and "Always check for the errors array"; the rate limiting page gives HTTP 429, the
// RATELIMITED code, Retry-After in seconds and the X-RateLimit reset headers in epoch milliseconds;
// the SDK's error page gives the extensions.type values. The wire tests spawn the real child process
// with a `--import` stub that replaces `fetch`, so no test reaches the network. HOME and USERPROFILE
// are both redirected, because Node's homedir() reads USERPROFILE on Windows and HOME elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LINEAR_ENDPOINT, linearExec, linearKeyPath, readLinearKey, requestLinear } from './linear-api.mjs';

const LINEAR_API = fileURLToPath(new URL('./linear-api.mjs', import.meta.url));
const KEY = 'lin_api_TESTKEY0123456789';
const QUERY = 'query Viewer($id: String!) { user(id: $id) { id } }';
const VARIABLES = { id: 'u1' };
const DATA = { user: { id: 'u1' } };

// The stub records the request, and the child's argv and environment, to LINEAR_STUB_RECORD before
// doing anything else, so a call that threw is still seen. It throws when LINEAR_STUB_THROW is set.
// LINEAR_STUB_ANSWER (JSON { status, body, headers }) replaces the answer with DATA; each
// `<authorization>` in its body becomes the Authorization header received, so an answer can echo the
// key while the environment never holds it.
const STUB = `
import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const authorization = new Headers(init.headers).get('authorization');
  writeFileSync(process.env.LINEAR_STUB_RECORD, JSON.stringify({
    url, headers: init.headers, authorization, body: init.body,
    argv: process.argv, execArgv: process.execArgv, env: process.env,
  }));
  if (process.env.LINEAR_STUB_THROW) throw new Error('fetch must not be called');
  const answer = process.env.LINEAR_STUB_ANSWER
    ? JSON.parse(process.env.LINEAR_STUB_ANSWER)
    : { status: 200, body: JSON.stringify({ data: ${JSON.stringify(DATA)} }) };
  return new Response(answer.body.replaceAll('<authorization>', authorization), { status: answer.status, headers: answer.headers });
};
`;

function wire(t, { keyFile }) {
  const root = mkdtempSync(join(tmpdir(), 'linear-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  if (keyFile) {
    mkdirSync(join(home, '.config', 'fabraik'), { recursive: true });
    writeFileSync(linearKeyPath(home), `${KEY}\n`, { mode: 0o600 });
  }
  const stub = join(root, 'stub.mjs');
  writeFileSync(stub, STUB);
  return {
    home,
    record: join(root, 'request.json'),
    argv: [process.execPath, '--import', pathToFileURL(stub).href, LINEAR_API],
  };
}

// Sets each variable for the rest of the test, so linearExec's child inherits it, and restores it after.
// An undefined value removes the variable.
function setEnvironment(t, environment) {
  for (const [name, value] of Object.entries(environment)) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}

// An injected fetch that records each call and answers as Linear's server would.
function answering(status, body, headers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

// What a fetch that never reached Linear throws: undici's TypeError with the system error as its cause.
function failingNetwork(causeMessage, code) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(causeMessage), { code }) });
  };
  return { fetch, calls };
}

// The text a caller sees: the returned data, or the thrown message.
async function outcomeText(promise) {
  try {
    return String(JSON.stringify(await promise));
  } catch (error) {
    return String(error.message);
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the request resolved instead of failing');
}

function exception(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('linearExec returned instead of failing');
}

test('requestLinear posts the payload as JSON to api.linear.app with the key as the bare Authorization header and returns the data', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify({ data: DATA }) };
  };
  const payload = { query: QUERY, variables: VARIABLES };

  const data = await requestLinear(payload, { fetch, key: KEY });

  assert.deepEqual(data, DATA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.linear.app/graphql');
  assert.equal(LINEAR_ENDPOINT, 'https://api.linear.app/graphql');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { Authorization: KEY, 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
});

test('the Linear transport posts the payload with the key from the file and prints only the data', (t) => {
  const { home, record, argv } = wire(t, { keyFile: true });
  setEnvironment(t, { HOME: home, USERPROFILE: home, BOARD_TOOLKIT_LINEAR: JSON.stringify(argv), LINEAR_STUB_RECORD: record });

  // linearExec parses the child's whole stdout as JSON, so any extra output fails here.
  assert.deepEqual(linearExec(QUERY, VARIABLES), DATA);

  const request = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(request.url, 'https://api.linear.app/graphql');
  assert.deepEqual(request.headers, { Authorization: KEY, 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { query: QUERY, variables: VARIABLES });
});

test('the Linear transport refuses before any network call when no key file exists', (t) => {
  const { home, record, argv } = wire(t, { keyFile: false });
  const [command, ...args] = argv;

  const run = spawnSync(command, args, {
    input: JSON.stringify({ query: QUERY, variables: VARIABLES }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, LINEAR_STUB_RECORD: record, LINEAR_STUB_THROW: '1' },
  });

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(linearKeyPath(home)), run.stderr);
  assert.equal(existsSync(record), false, 'fetch was called');
});

// Every classified failure, each answer echoing the key it was sent.
const ECHOING_FAILURES = [
  ['an authentication answer', () => answering(401, { errors: [{ message: `Invalid API key ${KEY}`, extensions: { type: 'authentication error' } }] })],
  ['a forbidden answer', () => answering(403, { errors: [{ message: `Key ${KEY} may not read this team`, extensions: { type: 'forbidden' } }] })],
  ['a rate limit', () => answering(429, { errors: [{ message: `Too many requests for ${KEY}` }] }, { 'Retry-After': '37' })],
  ['RATELIMITED inside HTTP 200', () => answering(200, { data: null, errors: [{ message: `Too many requests for ${KEY}`, extensions: { code: 'RATELIMITED' } }] })],
  ['errors beside partial data', () => answering(200, { data: { issue: null }, errors: [{ message: `Entity not found for ${KEY}`, extensions: { type: 'invalid input' } }] })],
  ['usage limit exceeded', () => answering(200, { errors: [{ message: `The workspace of ${KEY} is over its usage`, extensions: { type: 'usage limit exceeded' } }] })],
  ['a body that is not JSON', () => answering(502, `<html>Bad gateway for ${KEY}</html>`)],
  ['no data field', () => answering(200, { echo: KEY })],
  ['a network failure', () => failingNetwork(`connect ECONNREFUSED ${KEY}`, 'ECONNREFUSED')],
];

test('ANTI-REGRESSION: the Linear key reaches only the Authorization header of a request to api.linear.app', async (t) => {
  const payload = { query: QUERY, variables: VARIABLES };
  for (const [failure, answer] of ECHOING_FAILURES) {
    const { fetch, calls } = answer();
    const text = await outcomeText(requestLinear(payload, { fetch, key: KEY }));
    assert.equal(text.includes(KEY), false, `${failure} echoed the key: ${text}`);
    for (const { url, init } of calls) {
      assert.equal(String(url), 'https://api.linear.app/graphql', failure);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), KEY, failure);
      for (const [name, value] of headers) {
        if (name !== 'authorization') assert.equal(value.includes(KEY), false, `${failure}: the key is in the ${name} header`);
      }
      assert.equal(String(init.body).includes(KEY), false, `${failure}: the key is in the body`);
    }
  }

  // The real child, answered by a Linear error that echoes the key it was sent.
  const { home, record, argv } = wire(t, { keyFile: true });
  setEnvironment(t, {
    HOME: home,
    USERPROFILE: home,
    BOARD_TOOLKIT_LINEAR: JSON.stringify(argv),
    LINEAR_STUB_RECORD: record,
    LINEAR_STUB_ANSWER: JSON.stringify({
      status: 401,
      body: JSON.stringify({ errors: [{ message: 'Invalid API key <authorization>', extensions: { type: 'authentication error' } }] }),
    }),
  });
  let childText;
  try {
    childText = String(JSON.stringify(linearExec(QUERY, VARIABLES)));
  } catch (error) {
    childText = String(error.message);
  }
  assert.equal(childText.includes(KEY), false, `the child echoed the key: ${childText}`);
  const request = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(request.url, 'https://api.linear.app/graphql');
  assert.equal(request.authorization, KEY);
  assert.equal(request.body.includes(KEY), false, 'the key is in the request body');
  assert.equal(JSON.stringify([request.argv, request.execArgv]).includes(KEY), false, "the key is in the child's argv");
  assert.equal(JSON.stringify(request.env).includes(KEY), false, "the key is in the child's environment");
});

test('ANTI-REGRESSION: the helper replaces the Linear key with [key] in a successful answer it prints', (t) => {
  const { home, record, argv } = wire(t, { keyFile: true });
  const [command, ...args] = argv;

  const run = spawnSync(command, args, {
    input: JSON.stringify({ query: QUERY, variables: VARIABLES }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LINEAR_STUB_RECORD: record,
      LINEAR_STUB_ANSWER: JSON.stringify({ status: 200, body: JSON.stringify({ data: { echo: '<authorization>' } }) }),
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).authorization, KEY, 'the answer did not echo the key it was sent');
  assert.equal(run.stdout.includes(KEY), false, `the helper printed the key: ${run.stdout}`);
  assert.ok(run.stdout.includes('[key]'), run.stdout);
});

test('readLinearKey refuses an absent file, a link, a directory, a file other accounts can read, an oversized file and a key with whitespace or control characters, naming the path and never the content', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'linear-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = (name, content, mode = 0o600) => {
    const path = join(root, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };
  const refusals = [['an absent file', join(root, 'absent')]];
  const link = join(root, 'link');
  try {
    symlinkSync(keyFile('target', `${KEY}\n`), link);
    refusals.push(['a link', link]);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('the link case is left out: this Windows account may not create symbolic links (EPERM)');
  }
  const directory = join(root, 'directory');
  mkdirSync(directory);
  refusals.push(['a directory', directory]);
  if (process.platform === 'win32') {
    t.diagnostic('the mode case is left out: Windows has no group and other permission bits, and the user profile is private by default');
  } else {
    refusals.push(
      ['a file other accounts can read', keyFile('shared', `${KEY}\n`, 0o644), 'chmod 600 '],
      ['a file the group can read', keyFile('group', `${KEY}\n`, 0o640), 'chmod 600 '],
      ['a file anyone else can read', keyFile('other', `${KEY}\n`, 0o604), 'chmod 600 '],
    );
  }
  refusals.push(
    ['an oversized file', keyFile('oversized', KEY.padEnd(4097, 'A'))],
    ['a key with a space', keyFile('space', 'lin_api_TEST KEY\n')],
    ['a key with a tab', keyFile('tab', 'lin_api_TEST\tKEY\n')],
    ['a key with a control character', keyFile('control', 'lin_api_TEST\u0001KEY\n')],
    ['a key with DEL', keyFile('delete', 'lin_api_TEST\u007FKEY\n')],
    ['a key of only whitespace', keyFile('blank', ' \t\n')],
  );

  for (const [refusal, path, remedy = ''] of refusals) {
    assert.throws(() => readLinearKey({ path, platform: process.platform }), (error) => {
      assert.ok(error.message.includes(`${remedy}${path}`), `${refusal} does not name ${remedy}${path}: ${error.message}`);
      assert.equal(error.message.includes('lin_api_'), false, `${refusal} echoes the content: ${error.message}`);
      return true;
    }, `${refusal} was read as a key`);
  }
});

test("requestLinear names Linear's rate limit with Retry-After and the reset times on HTTP 429 and on RATELIMITED inside HTTP 200, and says nothing further was sent", async () => {
  // The reset headers are epoch milliseconds: 1767225600000 is 2026-01-01T00:00:00.000Z.
  const cases = [
    [
      'HTTP 429',
      answering(429, { errors: [{ message: 'Too many requests' }] }, {
        'Retry-After': '37',
        'X-RateLimit-Requests-Reset': '1767225600000',
        'X-RateLimit-Complexity-Reset': '1767225660000',
      }),
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'],
    ],
    [
      'RATELIMITED inside HTTP 200',
      answering(200, { data: null, errors: [{ message: 'Too many requests', extensions: { code: 'RATELIMITED' } }] }, {
        'Retry-After': '37',
        'X-RateLimit-Requests-Reset': '1767225600000',
      }),
      ['2026-01-01T00:00:00.000Z', 'not given'],
    ],
  ];
  for (const [answer, { fetch, calls }, resets] of cases) {
    const error = await rejection(requestLinear({ query: QUERY, variables: VARIABLES }, { fetch, key: KEY }));
    assert.equal(error.rateLimited, true, `${answer} is not marked rateLimited: ${error.message}`);
    assert.match(error.message, /rate limit/i, answer);
    assert.match(error.message, /Retry-After/, answer);
    assert.match(error.message, /\b37\b/, answer);
    for (const reset of resets) assert.ok(error.message.includes(reset), `${answer} does not name the reset ${reset}: ${error.message}`);
    assert.match(error.message, /nothing further was sent/i, answer);
    assert.equal(calls.length, 1, `${answer} sent ${calls.length} requests`);
  }
});

test('requestLinear fails whole on an HTTP 200 answer that carries errors beside partial data', async () => {
  const { fetch } = answering(200, {
    data: { issue: { id: 'issue-1', title: 'Partial' }, team: null },
    errors: [
      { message: 'Entity not found: Team', path: ['team'], extensions: { type: 'invalid input' } },
      { message: 'Internal failure', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    ],
  });

  const error = await rejection(requestLinear({ query: QUERY, variables: VARIABLES }, { fetch, key: KEY }));

  for (const part of ['invalid input', 'Entity not found: Team', 'INTERNAL_SERVER_ERROR', 'Internal failure']) {
    assert.ok(error.message.includes(part), `the message does not name ${part}: ${error.message}`);
  }
});

test('requestLinear names the key file and the access it needs on an authentication or forbidden answer', async () => {
  const cases = [
    ['HTTP 401', answering(401, { errors: [{ message: 'Not authenticated' }] })],
    ['HTTP 403', answering(403, { errors: [{ message: 'Not allowed' }] })],
    ['type authentication error', answering(400, { errors: [{ message: 'Invalid API key', extensions: { type: 'authentication error' } }] })],
    ['type forbidden', answering(400, { errors: [{ message: 'No access to this team', extensions: { type: 'forbidden' } }] })],
  ];
  for (const [answer, { fetch }] of cases) {
    const error = await rejection(requestLinear({ query: QUERY, variables: VARIABLES }, { fetch, key: KEY }));
    assert.ok(error.message.includes(linearKeyPath()), `${answer} does not name the key file ${linearKeyPath()}: ${error.message}`);
    assert.match(error.message, /Read and Write/, answer);
  }
});

test('requestLinear names usage limit exceeded, a body that is not JSON, a missing data field and a network failure, each as its own cause, and never names the issue cap', async () => {
  const messages = [];
  const failure = async (answer, { fetch }) => {
    const error = await rejection(requestLinear({ query: QUERY, variables: VARIABLES }, { fetch, key: KEY }));
    assert.doesNotMatch(error.message, /250|\bcap\b/i, `${answer} names the issue cap`);
    messages.push(error.message);
    return error.message;
  };

  const usage = await failure('usage limit exceeded', answering(200, {
    errors: [{ message: 'Upgrade to keep creating issues', extensions: { type: 'usage limit exceeded' } }],
  }));
  assert.match(usage, /usage limit/i);
  assert.ok(usage.includes('Upgrade to keep creating issues'), `Linear's message is missing: ${usage}`);

  const notJson = await failure('a body that is not JSON', answering(200, '<html>Bad gateway</html>'));
  assert.match(notJson, /not JSON/);
  assert.match(notJson, /\b200\b/);

  assert.match(await failure('a missing data field', answering(200, {})), /no data/i);

  const network = await failure('a network failure', failingNetwork('getaddrinfo ENOTFOUND api.linear.app', 'ENOTFOUND'));
  assert.ok(network.includes('ENOTFOUND'), `the cause code is missing: ${network}`);
  assert.equal(network.includes('getaddrinfo') || network.includes('fetch failed'), false, `the raw error passed through: ${network}`);

  assert.equal(new Set(messages).size, messages.length, `two causes share a message: ${messages.join(' | ')}`);
});

test('linearExec refuses a BOARD_TOOLKIT_LINEAR that is not a JSON array of non-empty strings, reports a timeout as Linear not answering, and marks only a rate-limited answer from the child as rateLimited', (t) => {
  // One restore per variable, of its value before this test; each case below assigns directly.
  setEnvironment(t, {
    BOARD_TOOLKIT_LINEAR: undefined,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LINEAR_STUB_RECORD: undefined,
    LINEAR_STUB_ANSWER: undefined,
  });
  const spawned = [];
  const recordingSpawn = (...call) => {
    spawned.push(call);
    throw new Error('spawn must not be called');
  };
  for (const value of [
    JSON.stringify('/nonexistent/linear-transport'),
    'not JSON',
    '{}',
    JSON.stringify([process.execPath, '']),
    JSON.stringify([process.execPath, 1]),
  ]) {
    process.env.BOARD_TOOLKIT_LINEAR = value;
    const error = exception(() => linearExec(QUERY, VARIABLES, { spawn: recordingSpawn }));
    assert.ok(error.message.includes('BOARD_TOOLKIT_LINEAR'), `${value} was not refused by name: ${error.message}`);
    assert.equal(spawned.length, 0, `${value} reached spawn`);
  }

  // The timeout: spawnSync's own result when its timeout fires. Should the seam be ignored, the real
  // child finds no key file in the empty home and fails at once, before any network call.
  const empty = mkdtempSync(join(tmpdir(), 'linear-api-home-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  delete process.env.BOARD_TOOLKIT_LINEAR;
  process.env.HOME = empty;
  process.env.USERPROFILE = empty;
  const timedOut = [];
  const timingOutSpawn = (command, args, options) => {
    timedOut.push(options);
    return {
      pid: 0, output: null, stdout: '', stderr: '', status: null, signal: 'SIGTERM',
      error: Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT', syscall: `spawnSync ${command}` }),
    };
  };
  const timeout = exception(() => linearExec(QUERY, VARIABLES, { spawn: timingOutSpawn }));
  assert.match(timeout.message, /did not answer within 60 s/, timeout.message);
  assert.notEqual(timeout.rateLimited, true, 'a timeout is marked rateLimited');
  assert.equal(timedOut.length, 1, 'the injected spawn was not used');
  assert.equal(timedOut[0].timeout, 60_000);

  // The real child, answered by Linear's HTTP 429.
  const { home, record, argv } = wire(t, { keyFile: true });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    BOARD_TOOLKIT_LINEAR: JSON.stringify(argv),
    LINEAR_STUB_RECORD: record,
    LINEAR_STUB_ANSWER: JSON.stringify({
      status: 429,
      body: JSON.stringify({ errors: [{ message: 'Too many requests' }] }),
      headers: { 'Retry-After': '37', 'X-RateLimit-Requests-Reset': '1767225600000', 'X-RateLimit-Complexity-Reset': '1767225660000' },
    }),
  });
  const limited = exception(() => linearExec(QUERY, VARIABLES));
  assert.equal(limited.rateLimited, true, `the rate limit is not marked rateLimited: ${limited.message}`);
  assert.match(limited.message, /rate limit/i);
  assert.match(limited.message, /Retry-After/);
});
