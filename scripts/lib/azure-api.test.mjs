// Literal Microsoft REST endpoints/authentication and the approved custody contract are the oracle.
// Two real children cover the stdin/stdout wire; all hostile inputs use direct seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AZURE_TEST_CONFIG } from './board-toolkit-copy.mjs';
import { azureCredentialsPath, azureExec, readAzureCredentials, requestAzure } from './azure-api.mjs';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'FAKE_azure_"token\\value';
const ESCAPED = 'FAKE_azure_\\"token\\\\value';
const BASIC = 'OkZBS0VfYXp1cmVfInRva2VuXHZhbHVl';
const CREDENTIALS = { organization: 'example-org', authentication: 'entra', token: TOKEN };
const CONFIG = {
  organization: 'example-org', project: PROJECT,
  workItemTypes: { epic: 'Epic', feature: 'User Story', task: 'Task', bug: 'Bug', docs: 'Task' },
  states: Object.fromEntries(['Epic', 'User Story', 'Task', 'Bug'].map((type) => [type, {
    Backlog: 'New', Ready: 'Ready', 'In progress': 'Active', 'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed',
  }])),
};
const PAYLOAD = { method: 'GET', path: '/_apis/projects/' + PROJECT, query: { 'api-version': '7.1' } };

function privateText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, ESCAPED, BASIC, 'Bearer ' + TOKEN, 'Basic ' + BASIC]) {
    assert.equal(text.includes(secret), false, 'secret reached observable output');
  }
}

function answering(status, body, headers = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return { status, headers: new Headers(headers), text: async () => body };
    },
  };
}

const send = (request, answer, credentials = CREDENTIALS) => requestAzure(request, { ...answer, credentials, config: CONFIG });

test('Azure transport rejects token edge whitespace before fetch', async () => {
  for (const authentication of ['entra', 'pat']) {
    for (const edge of ['leading', 'trailing']) {
      const sentinel = `SYNTHETIC_SECRET_408_${authentication}_${edge}`;
      const token = edge === 'leading' ? ' ' + sentinel : sentinel + ' ';
      const answer = answering(200, '{}');
      await assert.rejects(send(PAYLOAD, answer, { ...CREDENTIALS, authentication, token }), (error) => {
        assert.match(error.message, /token|whitespace/i);
        assert.equal(error.message.includes(token), false, 'raw token reached validation output');
        assert.equal(error.message.includes(sentinel), false, 'trimmed token reached validation output');
        return true;
      });
      assert.equal(answer.calls.length, 0, 'malformed token reached fetch');
    }
  }
});

const STUB = `
import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const authorization = new Headers(init.headers).get('authorization');
  const token = authorization.slice(7);
  const basic = Buffer.from(':' + token).toString('base64');
  const secrets = [token, basic, JSON.stringify(token).slice(1, -1)];
  writeFileSync(process.env.AZURE_STUB_RECORD, JSON.stringify({
    url: String(url), init, argv: process.argv, execArgv: process.execArgv,
    secretInEnvironment: Object.values(process.env).some((value) => secrets.some((secret) => value.includes(secret))),
  }));
  const echo = [token, basic, JSON.stringify(token).slice(1, -1), authorization].join(' | ');
  return new Response(JSON.stringify({ id: 'project-self', echo }), { status: 200 });
};
`;

test('Azure transport confines credentials and destinations', async (t) => {
  assert.deepEqual(azureExec(PAYLOAD, { spawn: (_command, _args, options) => {
    assert.equal(options.timeout, 60000);
    assert.equal(options.maxBuffer, 64 * 1024 * 1024);
    assert.equal(options.input, JSON.stringify(PAYLOAD));
    return { status: 0, stdout: '{"id":299}', stderr: '' };
  } }), { id: 299 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'azure-api-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(repositoryRoot);
  const home = join(root, 'home');
  const path = join(home, '.config', 'fabraik', 'azure.json');
  mkdirSync(join(home, '.config', 'fabraik'), { recursive: true });
  assert.equal(azureCredentialsPath(home), path);
  const read = (given = path) => readAzureCredentials({ path: given, platform: process.platform, repositoryRoot });
  const put = (value) => {
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  assert.throws(() => read(), /credential.*read|credential.*missing/i);
  assert.throws(() => read(home), /regular file/i);
  put(CREDENTIALS);
  assert.deepEqual(read(), CREDENTIALS);
  const internal = join(repositoryRoot, 'azure.json');
  writeFileSync(internal, JSON.stringify(CREDENTIALS), { mode: 0o600 });
  assert.throws(() => read(internal), /outside.*repository|inside.*repository/i);
  const hardlink = join(root, 'hardlink.json');
  linkSync(path, hardlink);
  assert.throws(() => read(), /hard.link|one link/i);
  rmSync(hardlink);
  if (process.platform !== 'win32') {
    const symlink = join(root, 'symlink.json');
    symlinkSync(path, symlink);
    assert.throws(() => read(symlink), /symlink|regular file/i);
    const alias = join(root, 'repo-alias');
    symlinkSync(repositoryRoot, alias, 'dir');
    assert.throws(() => read(join(alias, 'azure.json')), /outside.*repository|inside.*repository/i);
    chmodSync(path, 0o644);
    assert.throws(() => read(), /private|permission|chmod/i);
    chmodSync(path, 0o600);
  }
  for (const value of ['not JSON ' + TOKEN, null, [], { ...CREDENTIALS, extra: TOKEN },
    { ...CREDENTIALS, authentication: 'oauth' }, { ...CREDENTIALS, organization: 'https://dev.azure.com/example-org' }]) {
    put(value);
    assert.throws(() => read(), (error) => { privateText(error.stack); return /credential/i.test(error.message); });
  }
  for (const field of ['organization', 'authentication', 'token']) {
    const missing = { ...CREDENTIALS };
    delete missing[field];
    put(missing);
    assert.throws(() => read(), /credential/i);
    for (const value of ['', ' ', 'line\nbreak', 'control\u007f', null, 123]) {
      put({ ...CREDENTIALS, [field]: value });
      assert.throws(() => read(), /credential/i);
    }
  }
  const contents = JSON.stringify(CREDENTIALS);
  put(contents + ' '.repeat(16384 - Buffer.byteLength(contents)));
  assert.deepEqual(read(), CREDENTIALS);
  put(contents + ' '.repeat(16384));
  assert.throws(() => read(), /16384|16 KiB/);
  put(CREDENTIALS);

  const allowed = [
    [PAYLOAD, 'https://dev.azure.com/example-org/_apis/projects/11111111-1111-4111-8111-111111111111?api-version=7.1'],
    [{ method: 'GET', path: '/_apis/wit/workitemrelationtypes' }, 'https://dev.azure.com/example-org/_apis/wit/workitemrelationtypes'],
    [{ method: 'GET', path: '/' + PROJECT + '/_apis/wit/workitems/299' }, 'https://dev.azure.com/example-org/11111111-1111-4111-8111-111111111111/_apis/wit/workitems/299'],
    [{ method: 'GET', path: '/_apis/profile/profiles/me', profile: true, query: { 'api-version': '7.1', details: true } }, 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1&details=true'],
    [{ method: 'GET', path: '/' + PROJECT + '/_apis/wit/workitemtypes/User%20Story/states' }, 'https://dev.azure.com/example-org/11111111-1111-4111-8111-111111111111/_apis/wit/workitemtypes/User%20Story/states'],
  ];
  for (const [request, url] of allowed) {
    const answer = answering(200, '{"id":299}');
    assert.deepEqual(await send(request, answer), { id: 299 });
    assert.equal(answer.calls.length, 1);
    assert.equal(answer.calls[0].url, url);
    assert.equal(answer.calls[0].init.redirect, 'error');
    assert.equal(new Headers(answer.calls[0].init.headers).get('authorization'), 'Bearer ' + TOKEN);
  }
  const pat = answering(200, '{}');
  await send(PAYLOAD, pat, { ...CREDENTIALS, authentication: 'pat' });
  assert.equal(new Headers(pat.calls[0].init.headers).get('authorization'), 'Basic ' + BASIC);
  for (const request of [
    { ...PAYLOAD, path: 'https://attacker.test/x' }, { ...PAYLOAD, path: '//attacker.test/x' },
    { ...PAYLOAD, path: '/example-org/_apis/projects/' + PROJECT },
    { ...PAYLOAD, path: '/other-org/_apis/wit/workitems/299' },
    { ...PAYLOAD, path: '/22222222-2222-4222-8222-222222222222/_apis/wit/workitems/299' },
    { ...PAYLOAD, path: '/_apis/projects/' + PROJECT + '?redirect=evil' },
    { ...PAYLOAD, path: '/_apis/projects/' + PROJECT + '#fragment' },
    { ...PAYLOAD, path: '/_apis/../projects/' + PROJECT },
    { ...PAYLOAD, path: '/' + PROJECT + '/_apis/wit/workitemtypes/%2e%2e/states' },
    { ...PAYLOAD, path: '/' + PROJECT + '/_apis/wit/workitemtypes/Task%2Fother/states' },
    { ...PAYLOAD, path: '/_apis/projects/other@evil' },
    { ...PAYLOAD, method: 'DELETE' }, { ...PAYLOAD, profile: true },
    { method: 'POST', path: '/_apis/profile/profiles/me', profile: true },
    { method: 'GET', path: '/_apis/profile/profiles/other', profile: true },
    { ...PAYLOAD, headers: { Authorization: 'evil' } }, { ...PAYLOAD, body: {} },
    { ...PAYLOAD, query: null }, { ...PAYLOAD, query: { extra: {} } },
    { ...PAYLOAD, query: { bypassRules: true } },
    { method: 'POST', path: '/' + PROJECT + '/_apis/wit/wiql', query: { $top: 1 }, body: {} },
    { ...PAYLOAD, query: { 'api-version': '1.0' } },
  ]) {
    const answer = answering(200, '{}');
    await assert.rejects(send(request, answer), /request|path|profile|method|query|body/i);
    assert.equal(answer.calls.length, 0);
    if (!request.path.startsWith('/22222222-') && !request.path.includes('Task%2Fother')) {
      let started = false;
      assert.throws(() => azureExec(request, { spawn: () => { started = true; } }));
      assert.equal(started, false, 'malformed raw request must fail before child credential loading');
    }
  }
  const foreign = answering(200, '{}');
  await assert.rejects(send(PAYLOAD, foreign, { ...CREDENTIALS, organization: 'other-org' }), /organization.*match/i);
  assert.equal(foreign.calls.length, 0);
  const redirect = answering(302, '');
  await assert.rejects(send(PAYLOAD, redirect), /302|redirect/i);
  assert.equal(redirect.calls.length, 1);

  // Only the child receives HOME, and it obtains the literal sentinel from its private file.
  const lib = join(repositoryRoot, 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  for (const name of ['azure-api.mjs', 'azure-config.mjs']) {
    copyFileSync(fileURLToPath(new URL('./' + name, import.meta.url)), join(lib, name));
  }
  writeFileSync(join(lib, 'board-config.mjs'), AZURE_TEST_CONFIG);
  const stub = join(root, 'stub.mjs');
  writeFileSync(stub, STUB);
  const record = join(root, 'request.json');
  const before = process.env.BOARD_TOOLKIT_AZURE;
  t.after(() => {
    if (before === undefined) delete process.env.BOARD_TOOLKIT_AZURE;
    else process.env.BOARD_TOOLKIT_AZURE = before;
  });
  process.env.BOARD_TOOLKIT_AZURE = JSON.stringify([process.execPath, '--import', pathToFileURL(stub).href, join(lib, 'azure-api.mjs')]);
  for (const wrongProject of [false, true]) {
    if (wrongProject) {
      rmSync(path);
      rmSync(record);
    }
    const request = wrongProject ? { ...PAYLOAD, path: '/_apis/projects/22222222-2222-4222-8222-222222222222' } : PAYLOAD;
    const spawn = (command, args, given) => {
      privateText(JSON.stringify([command, args, given]));
      const run = spawnSync(command, args, {
        ...given, env: { ...process.env, HOME: home, USERPROFILE: home, AZURE_STUB_RECORD: record },
      });
      privateText(run.stdout + run.stderr);
      assert.equal(run.status, wrongProject ? 1 : 0, run.stderr);
      return run;
    };
    if (wrongProject) {
      assert.throws(() => azureExec(request, { spawn }), (error) => {
        privateText(error.stack);
        assert.match(error.message, /configured project/);
        assert.doesNotMatch(error.message, /credential/);
        return true;
      });
      assert.equal(existsSync(record), false, 'wrong project fails before credential loading or fetch');
      continue;
    }
    const data = azureExec(request, { spawn });
    assert.equal(data.id, 'project-self');
    privateText(data);
    const wire = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(wire.url, 'https://dev.azure.com/example-org/_apis/projects/11111111-1111-4111-8111-111111111111?api-version=7.1');
    assert.equal(wire.init.redirect, 'error');
    assert.equal(wire.init.method, 'GET');
    assert.equal(new Headers(wire.init.headers).get('authorization'), 'Bearer ' + TOKEN);
    privateText(JSON.stringify([wire.argv, wire.execArgv]));
    assert.equal(wire.secretInEnvironment, false);
  }
});

test('Azure transport classifies failures without leaking secrets', async () => {
  const echo = [TOKEN, ESCAPED, BASIC, 'Bearer ' + TOKEN, 'Basic ' + BASIC].join(' | ');
  for (const [status, message] of [[401, /credential|authentication/i], [403, /permission|access/i], [429, /Retry-After.*37/], [413, /limit|large|413/i], [500, /500/]]) {
    const answer = answering(status, JSON.stringify({ message: echo }), { 'Retry-After': '37' });
    await assert.rejects(send(PAYLOAD, answer), (error) => {
      privateText(error.stack);
      assert.match(error.message, message);
      assert.equal(Boolean(error.rateLimited), status === 429);
      return true;
    });
    assert.equal(answer.calls.length, 1);
  }
  await assert.rejects(send(PAYLOAD, answering(429, '{}', { 'Retry-After': echo })), (error) => {
    privateText(error.message);
    privateText(error.stack);
    assert.equal(error.rateLimited, true);
    return true;
  });
  for (const body of ['not JSON ' + echo, 'null', '[]', '42', '"text"']) {
    await assert.rejects(send(PAYLOAD, answering(200, body)), /JSON|object|response/i);
  }
  const success = await send(PAYLOAD, answering(200, JSON.stringify({ [TOKEN]: echo, nested: [echo] })));
  privateText(success);
  for (const authentication of ['entra', 'pat']) {
    const failure = { fetch: async () => { throw new Error(echo); } };
    await assert.rejects(send(PAYLOAD, failure, { ...CREDENTIALS, authentication }), (error) => {
      privateText(error.stack);
      return /could not be reached|request failed/i.test(error.message);
    });
  }
  const patch = [{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/fields/System.Title', value: 'Changed' }];
  const writes = [
    [{ method: 'PATCH', path: '/' + PROJECT + '/_apis/wit/workitems/299', body: patch }, 'application/json-patch+json'],
    [{ method: 'POST', path: '/' + PROJECT + '/_apis/wit/workitems/$User%20Story', body: patch }, 'application/json-patch+json'],
    [{ method: 'POST', path: '/' + PROJECT + '/_apis/wit/workitems/299/comments', body: { text: 'Claim: synthetic' } }, 'application/json'],
    [{ method: 'PATCH', path: '/' + PROJECT + '/_apis/wit/workitems/299/comments/9', body: { text: 'Withdrawn' } }, 'application/json'],
    [{ method: 'POST', path: '/' + PROJECT + '/_apis/wit/wiql', body: { query: 'SELECT [System.Id] FROM WorkItems' } }, 'application/json'],
    [{ method: 'POST', path: '/' + PROJECT + '/_apis/wit/workitemsbatch', body: { ids: [299] } }, 'application/json'],
  ];
  for (const [request, contentType] of writes) {
    const answer = answering(200, '{"id":299}');
    await send(request, answer);
    assert.equal(answer.calls.length, 1);
    assert.equal(new Headers(answer.calls[0].init.headers).get('content-type'), contentType);
    assert.deepEqual(JSON.parse(answer.calls[0].init.body), request.body);
  }
  const mutation = writes[0][0];
  for (const answer of [
    { fetch: async () => { throw Object.assign(new Error(echo), { name: 'TimeoutError' }); } },
    answering(200, 'not JSON'), answering(500, '{"message":"failed"}'),
  ]) {
    await assert.rejects(send(mutation, answer), /outcome unknown.*inspect.*before retry/i);
  }
  assert.throws(() => azureExec(mutation, { spawn: () => ({ error: { code: 'ETIMEDOUT' } }) }), /outcome unknown.*inspect.*before retry/i);
  assert.throws(() => azureExec(PAYLOAD, { spawn: () => ({ error: { code: 'ETIMEDOUT' } }) }), /60 s/);
  assert.throws(() => azureExec(PAYLOAD, { spawn: () => ({ error: { code: 'ENOBUFS' } }) }), {
    message: 'Azure transport failed: ENOBUFS',
  });
  assert.throws(() => azureExec(PAYLOAD, { spawn: () => ({ status: 3, stderr: 'Azure rate limit: Retry-After 37', stdout: '' }) }), (error) => {
    assert.equal(error.rateLimited, true);
    assert.match(error.message, /Retry-After.*37/);
    return true;
  });
  const oversized = answering(200, '{}');
  await assert.rejects(send({ ...mutation, body: { text: 'x'.repeat(64 * 1024 * 1024) } }, oversized), /limit|large|67108864/i);
  assert.equal(oversized.calls.length, 0);
  const cyclic = {};
  cyclic.self = cyclic;
  const answer = answering(200, '{}');
  await assert.rejects(send({ ...mutation, body: cyclic }, answer), /JSON/);
  assert.equal(answer.calls.length, 0);
  for (const value of [null, [], { ...CREDENTIALS, token: 'line\nbreak' }, { ...CREDENTIALS, extra: TOKEN }]) {
    await assert.rejects(send(PAYLOAD, answer, value), (error) => { privateText(error.stack); return /credential/i.test(error.message); });
  }
});
