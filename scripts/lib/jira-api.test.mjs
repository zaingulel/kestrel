// Expectations follow Atlassian Basic auth and REST v3 status codes plus the Jira custody contract.
// Real children use the existing --import fetch-stub pattern and isolated HOME/USERPROFILE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jiraCredentialsPath, jiraExec, readJiraCredentials, requestJira } from './jira-api.mjs';

const SITE = 'https://example.atlassian.net';
const EMAIL = 'builder@example.test';
const TOKEN = 'FAKE_jira_"token\\value';
const BASIC = 'YnVpbGRlckBleGFtcGxlLnRlc3Q6RkFLRV9qaXJhXyJ0b2tlblx2YWx1ZQ==';
const ESCAPED = 'FAKE_jira_\\"token\\\\value';
const CREDENTIALS = { site: SITE, email: EMAIL, token: TOKEN };
const PAYLOAD = { method: 'GET', path: '/rest/api/3/myself' };
const CONFIG = {
  site: SITE, project: 'ENG',
  states: { Backlog: '10', Ready: '11', 'In progress': '12', 'Awaiting push': '13', 'In review': '14', Done: '15' },
  issueTypes: { epic: '10001', feature: '10002', task: '10002', bug: '10002', docs: '10002' },
  blockLinkType: '10003',
};

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

function privateText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, BASIC, ESCAPED]) assert.equal(text.includes(secret), false, text);
}

const STUB = `
import { readFileSync, writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const authorization = new Headers(init.headers).get('authorization');
  const basic = authorization.slice(6);
  const identity = Buffer.from(basic, 'base64').toString('utf8');
  const token = identity.slice(identity.indexOf(':') + 1);
  const secrets = [token, basic, JSON.stringify(token).slice(1, -1)];
  const secretInEnvironment = Object.entries(process.env).some((entry) => entry.some((value) => secrets.some((secret) => value.includes(secret))));
  const record = { url: String(url), init, argv: process.argv, execArgv: process.execArgv, secretInEnvironment };
  const records = process.env.JIRA_STUB_APPEND ? JSON.parse(readFileSync(process.env.JIRA_STUB_RECORD, 'utf8')) : [];
  records.push(record);
  writeFileSync(process.env.JIRA_STUB_RECORD, JSON.stringify(records));
  const echo = [token, basic, JSON.stringify(token).slice(1, -1)].join(' | ');
  if (process.env.JIRA_STUB_LIMIT) return new Response(JSON.stringify({ errorMessages: [echo] }), { status: 429, headers: { 'Retry-After': '37' } });
  return new Response(JSON.stringify({ accountId: 'acct-self', echo }), { status: 200 });
};
`;

test('Jira transport confines credentials and classifies every response', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jira-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const credentialPath = join(home, '.config', 'fabraik', 'jira.json');
  mkdirSync(join(home, '.config', 'fabraik'), { recursive: true });
  assert.equal(jiraCredentialsPath(home), credentialPath);
  const read = (path = credentialPath, platform = process.platform) => readJiraCredentials({ path, platform });
  assert.throws(() => read(), /Jira.*credential|credential.*Jira/i);
  assert.throws(() => read(home), /regular file/i);
  const put = (value) => {
    writeFileSync(credentialPath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
  };
  put(CREDENTIALS);
  assert.deepEqual(read(), CREDENTIALS);
  if (process.platform !== 'win32') {
    const link = join(root, 'credentials-link');
    symlinkSync(credentialPath, link);
    assert.throws(() => read(link), /regular file|symlink/i);
    chmodSync(credentialPath, 0o644);
    assert.throws(() => read(), /chmod 600|other accounts|permission/i);
    assert.deepEqual(read(credentialPath, 'win32'), CREDENTIALS);
  }
  for (const value of ['not JSON ' + TOKEN, null, [], { ...CREDENTIALS, password: TOKEN }]) {
    put(value);
    assert.throws(() => read(), (error) => { privateText(error.stack); return /credential|Jira/i.test(error.message); });
  }
  for (const field of ['site', 'email', 'token']) {
    const missing = { ...CREDENTIALS };
    delete missing[field];
    put(missing);
    assert.throws(() => read(), /credential|Jira/i);
    for (const value of ['', ' ', 'line\nbreak', 'control\u007f', null, 123]) {
      put({ ...CREDENTIALS, [field]: value });
      assert.throws(() => read(), /credential|Jira/i);
    }
  }
  for (const site of ['http://example.atlassian.net', 'https://example.atlassian.net.attacker.test', 'https://user:password@example.atlassian.net', SITE + '/']) {
    put({ ...CREDENTIALS, site });
    assert.throws(() => read(), /site|origin/i);
  }
  const contents = JSON.stringify(CREDENTIALS);
  put(contents + ' '.repeat(16 * 1024 - Buffer.byteLength(contents)));
  assert.deepEqual(read(), CREDENTIALS);
  put(contents + ' '.repeat(16 * 1024));
  assert.throws(() => read(), /16384|16 KiB/);
  put(CREDENTIALS);

  const send = (request, answer, credentials = CREDENTIALS, site = SITE) => requestJira(request, { ...answer, credentials, site });
  for (const [status, body, expected] of [[200, '{"accountId":"acct-self"}', { accountId: 'acct-self' }], [201, '{"key":"ENG-2"}', { key: 'ENG-2' }], [204, '', null]]) {
    const answer = answering(status, body);
    assert.deepEqual(await send(PAYLOAD, answer), expected);
    assert.equal(answer.calls.length, 1);
    const [{ url, init }] = answer.calls;
    assert.equal(url, SITE + '/rest/api/3/myself');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Basic ' + BASIC);
    assert.equal(init.body, undefined);
  }
  const search = answering(200, '{"issues":[]}');
  await send({ method: 'GET', path: '/rest/api/3/search/jql', query: { jql: 'project = ENG', maxResults: 50, fields: 'key,summary' } }, search);
  assert.equal(search.calls[0].url, SITE + '/rest/api/3/search/jql?jql=project+%3D+ENG&maxResults=50&fields=key%2Csummary');
  for (const method of ['POST', 'PUT']) {
    const answer = answering(201, '{"key":"ENG-2"}');
    const body = { fields: { summary: 'Synthetic card' } };
    await send({ method, path: '/rest/api/3/issue/ENG-2', body }, answer);
    assert.equal(answer.calls[0].init.method, method);
    assert.equal(new Headers(answer.calls[0].init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(answer.calls[0].init.body), body);
    privateText(answer.calls[0].init.body);
  }
  for (const [credentials, site] of [
    [{ ...CREDENTIALS, site: 'https://other.atlassian.net' }, SITE],
    [CREDENTIALS, 'https://attacker.test'], [CREDENTIALS, SITE + '/'],
  ]) {
    const answer = answering(200, '{}');
    await assert.rejects(send(PAYLOAD, answer, credentials, site), /site|origin|tenant/i);
    assert.equal(answer.calls.length, 0);
  }
  for (const request of [
    { ...PAYLOAD, method: 'DELETE' }, { ...PAYLOAD, method: 'get' }, { path: PAYLOAD.path },
    { method: 'GET' }, { ...PAYLOAD, headers: { Authorization: 'unsafe' } },
    ...['https://attacker.test/rest/api/3/myself', '//attacker.test/myself', '/rest/api/2/myself',
      '/rest/api/3/issue/../myself', '/rest/api/3/issue/%2e%2e/myself',
      '/rest/api/3/issue/ENG-2?x=1', '/rest/api/3/issue/ENG-2#fragment', '/rest/api/3/issue/ENG-2\n',
      '/rest/api/3/issue\\ENG-2', '/rest/api/3//myself'].map((path) => ({ method: 'GET', path })),
  ]) {
    const answer = answering(200, '{}');
    await assert.rejects(send(request, answer), /request|method|path|field/i);
    assert.equal(answer.calls.length, 0);
  }
  for (const [status, body, pattern] of [
    [200, '<html>bad</html>', /JSON/i], [201, '', /JSON/i], [204, 'unexpected', /204|empty/i],
    [202, '{}', /202/], [302, '{}', /302/], [500, '{"errorMessages":["failed"]}', /500/],
    [401, '{"errorMessages":["not authenticated"]}', /401.*credential|credential.*401/i],
    [403, '{"errorMessages":["not permitted"]}', /403.*permission|permission.*403/i],
  ]) {
    const answer = answering(status, body);
    await assert.rejects(send(PAYLOAD, answer), pattern);
    assert.equal(answer.calls.length, 1);
  }
  const reflected = { echo: TOKEN, basic: BASIC, escaped: ESCAPED };
  privateText(await send(PAYLOAD, answering(200, JSON.stringify(reflected))));
  for (const status of [400, 401, 403, 429]) {
    const answer = answering(status, JSON.stringify({ errorMessages: Object.values(reflected) }), { 'Retry-After': '37' });
    await assert.rejects(send(PAYLOAD, answer), (error) => {
      privateText(error.stack);
      assert.equal(error.cause, undefined);
      assert.equal(error.rateLimited === true, status === 429);
      if (status === 429) assert.match(error.message, /Retry-After.*37/);
      return true;
    });
    assert.equal(answer.calls.length, 1);
  }
  await assert.rejects(send(PAYLOAD, { fetch: async () => { throw new Error(TOKEN + BASIC + ESCAPED); } }), (error) => {
    privateText(error.stack);
    assert.match(error.message, /reach|network/i);
    return true;
  });

  const beforeOverride = process.env.BOARD_TOOLKIT_JIRA;
  t.after(() => {
    if (beforeOverride === undefined) delete process.env.BOARD_TOOLKIT_JIRA;
    else process.env.BOARD_TOOLKIT_JIRA = beforeOverride;
  });
  let spawns = 0;
  const forbiddenSpawn = () => { spawns++; throw new Error('must not spawn'); };
  for (const raw of ['', 'not JSON', '{}', '[]', '["node",""]', '["node",1]']) {
    process.env.BOARD_TOOLKIT_JIRA = raw;
    assert.throws(() => jiraExec(PAYLOAD, { spawn: forbiddenSpawn }), /BOARD_TOOLKIT_JIRA/);
  }
  assert.equal(spawns, 0);
  delete process.env.BOARD_TOOLKIT_JIRA;
  let options;
  assert.deepEqual(jiraExec(PAYLOAD, { spawn: (_command, _args, given) => {
    options = given;
    return { status: 0, stdout: '{"accountId":"acct-self"}', stderr: '' };
  } }), { accountId: 'acct-self' });
  assert.deepEqual(JSON.parse(options.input), PAYLOAD);
  privateText(JSON.stringify(options));
  assert.equal(options.timeout, 60_000);
  assert.throws(() => jiraExec(PAYLOAD, { spawn: () => ({ error: { code: 'ETIMEDOUT' } }) }), /did not answer within 60 s/);
  assert.throws(() => jiraExec(PAYLOAD, { spawn: () => ({ status: 0, stdout: 'not JSON', stderr: '' }) }), /JSON/i);

  const lib = join(root, 'lib');
  mkdirSync(lib);
  for (const name of ['jira-api.mjs', 'jira-config.mjs']) {
    copyFileSync(fileURLToPath(new URL('./' + name, import.meta.url)), join(lib, name));
  }
  writeFileSync(join(lib, 'board-config.mjs'), `export const JIRA_CONFIG = ${JSON.stringify(CONFIG)};\n`);
  const stub = join(root, 'stub.mjs');
  writeFileSync(stub, STUB);
  const record = join(root, 'request.json');
  process.env.BOARD_TOOLKIT_JIRA = JSON.stringify([process.execPath, '--import', pathToFileURL(stub).href, join(lib, 'jira-api.mjs')]);
  const spawn = (limit) => (command, args, given) => {
    const run = spawnSync(command, args, {
      ...given, env: { ...process.env, HOME: home, USERPROFILE: home, JIRA_STUB_RECORD: record, JIRA_STUB_LIMIT: limit ? '1' : '', JIRA_STUB_APPEND: existsSync(record) ? '1' : '' },
    });
    privateText(run.stdout + run.stderr);
    assert.equal(run.status, limit ? 3 : 0, run.stderr);
    return run;
  };
  const data = jiraExec(PAYLOAD, { spawn: spawn(false) });
  assert.equal(data.accountId, 'acct-self');
  privateText(data);
  assert.throws(() => jiraExec(PAYLOAD, { spawn: spawn(true) }), (error) => {
    assert.equal(error.rateLimited, true);
    assert.match(error.message, /Retry-After.*37/);
    privateText(error.stack);
    return true;
  });
  const records = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(records.length, 2, 'each child must send only one request');
  for (const request of records) {
    assert.equal(request.url, SITE + '/rest/api/3/myself');
    assert.equal(request.init.redirect, 'error');
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Basic ' + BASIC);
    assert.equal(request.init.body, undefined);
    privateText(JSON.stringify([request.argv, request.execArgv]));
    assert.equal(request.secretInEnvironment, false);
  }
});

test('Jira transport refuses malformed requests before provider work', async () => {
  const send = (request, answer, credentials = CREDENTIALS) => requestJira(request, { ...answer, credentials, site: SITE });
  const queryControl = answering(200, '{"accountId":"acct-self"}');
  assert.deepEqual(await send({ ...PAYLOAD, query: { text: 'project = ENG', count: 0, enabled: false } }, queryControl), { accountId: 'acct-self' });
  assert.equal(queryControl.calls.length, 1);
  assert.equal(queryControl.calls[0].url, SITE + '/rest/api/3/myself?text=project+%3D+ENG&count=0&enabled=false');
  const postControl = answering(201, '{"key":"ENG-2"}');
  const body = { fields: { summary: 'Jira tracer' } };
  assert.deepEqual(await send({ method: 'POST', path: '/rest/api/3/issue', body }, postControl), { key: 'ENG-2' });
  assert.equal(postControl.calls.length, 1);
  assert.deepEqual(JSON.parse(postControl.calls[0].init.body), body);

  for (const query of [null, [], 'project = ENG', 1, false]) {
    const answer = answering(200, '{}');
    await assert.rejects(send({ ...PAYLOAD, query }, answer), /query must be an object/);
    assert.equal(answer.calls.length, 0);
  }
  for (const value of [null, undefined, {}, [], NaN, Infinity, -Infinity, 1n, Symbol('query'), () => 'value']) {
    const answer = answering(200, '{}');
    await assert.rejects(send({ ...PAYLOAD, query: { value } }, answer), /query values must be strings, finite numbers or booleans/);
    assert.equal(answer.calls.length, 0);
  }
  for (const body of [{}, null, 'unexpected']) {
    const answer = answering(200, '{}');
    await assert.rejects(send({ ...PAYLOAD, body }, answer), /GET request must have no body/);
    assert.equal(answer.calls.length, 0);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  const cycleAnswer = answering(201, '{"key":"ENG-2"}');
  await assert.rejects(send({ method: 'POST', path: '/rest/api/3/issue', body: cyclic }, cycleAnswer), /body must be JSON/);
  assert.equal(cycleAnswer.calls.length, 0);
  for (const email of ['not-an-email', 'builder example@test', 'builder:password@example.test', '@example.test', 'builder@']) {
    const answer = answering(200, '{}');
    await assert.rejects(send(PAYLOAD, answer, { ...CREDENTIALS, email }), /credential email must be an account email address/);
    assert.equal(answer.calls.length, 0);
  }
});

test('Jira issue-link transport accepts native empty creation responses', async () => {
  const link = {
    method: 'POST', path: '/rest/api/3/issueLink',
    body: { type: { id: '10003' }, inwardIssue: { key: 'ENG-1' }, outwardIssue: { key: 'ENG-2' } },
  };
  const send = (request, answer) => requestJira(request, { ...answer, credentials: CREDENTIALS, site: SITE });
  for (const [request, status, body, cause] of [
    [PAYLOAD, 201, '', /JSON/],
    [{ method: 'POST', path: '/rest/api/3/issue', body: { fields: { summary: 'Jira tracer' } } }, 201, '', /JSON/],
    [link, 201, 'not JSON', /JSON/],
    [link, 202, '', /202/],
  ]) {
    const answer = answering(status, body);
    await assert.rejects(send(request, answer), cause);
    assert.equal(answer.calls.length, 1);
  }
  const answer = answering(201, '');
  const result = send(link, answer);
  assert.equal(answer.calls.length, 1);
  assert.equal(answer.calls[0].url, SITE + '/rest/api/3/issueLink');
  assert.equal(answer.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(answer.calls[0].init.body), {
    type: { id: '10003' }, inwardIssue: { key: 'ENG-1' }, outwardIssue: { key: 'ENG-2' },
  });
  assert.equal(await result, null);
});

// Keep this canonical-root fixture independent of the custody test's native temporary path so platform aliases cannot mask the explicit alias regression.
test('Jira helper runs through aliased executable paths', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jira-alias-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const credentialPath = jiraCredentialsPath(home);
  mkdirSync(join(home, '.config', 'fabraik'), { recursive: true });
  writeFileSync(credentialPath, JSON.stringify(CREDENTIALS), { mode: 0o600 });
  chmodSync(credentialPath, 0o600);
  const lib = join(root, 'lib');
  mkdirSync(lib);
  for (const name of ['jira-api.mjs', 'jira-config.mjs']) {
    copyFileSync(fileURLToPath(new URL('./' + name, import.meta.url)), join(lib, name));
  }
  writeFileSync(join(lib, 'board-config.mjs'), 'export const JIRA_CONFIG = ' + JSON.stringify(CONFIG) + ';\n');
  const stub = join(root, 'stub.mjs');
  writeFileSync(stub, STUB);
  const record = join(root, 'requests.json');
  const beforeOverride = process.env.BOARD_TOOLKIT_JIRA;
  t.after(() => {
    if (beforeOverride === undefined) delete process.env.BOARD_TOOLKIT_JIRA;
    else process.env.BOARD_TOOLKIT_JIRA = beforeOverride;
  });
  let lastWire;
  const spawn = (command, args, given) => {
    const run = spawnSync(command, args, {
      ...given,
      env: { ...process.env, HOME: home, USERPROFILE: home, JIRA_STUB_RECORD: record, JIRA_STUB_LIMIT: '', JIRA_STUB_APPEND: existsSync(record) ? '1' : '' },
    });
    privateText(run.stdout + run.stderr);
    lastWire = { status: run.status, stdout: run.stdout, stderr: run.stderr };
    assert.equal(run.status, 0, run.stderr);
    return run;
  };
  const invoke = (entry) => {
    process.env.BOARD_TOOLKIT_JIRA = JSON.stringify([process.execPath, '--import', pathToFileURL(stub).href, entry]);
    try { return jiraExec(PAYLOAD, { spawn }); }
    catch (error) {
      error.message += '; native child ' + JSON.stringify(lastWire);
      throw error;
    }
  };
  const expected = { accountId: 'acct-self', echo: '[redacted] | [redacted] | [redacted]' };
  const canonical = join(lib, 'jira-api.mjs');
  assert.deepEqual(invoke(canonical), expected);
  const canonicalRecords = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(canonicalRecords.length, 1);
  assert.equal(canonicalRecords[0].url, SITE + '/rest/api/3/myself');
  privateText(JSON.stringify([canonicalRecords[0].argv, canonicalRecords[0].execArgv]));
  assert.equal(canonicalRecords[0].secretInEnvironment, false);

  const importRecord = join(root, 'import-requests.json');
  const imported = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, '--input-type=module', '-'], {
    input: "import assert from 'node:assert/strict';\nassert.equal(process.argv[1], '-');\nawait import(" + JSON.stringify(pathToFileURL(canonical).href) + ');\n',
    encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, JIRA_STUB_RECORD: importRecord, JIRA_STUB_LIMIT: '', JIRA_STUB_APPEND: '' },
  });
  privateText(imported.stdout + imported.stderr);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  assert.equal(existsSync(importRecord), false, 'import-only child must send no request');

  const alias = join(root, 'aliased-lib');
  symlinkSync(lib, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(invoke(join(alias, 'jira-api.mjs')), expected);
  const records = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(records.length, 2, 'canonical and alias children each send exactly one request');
  for (const request of records) {
    assert.equal(request.url, SITE + '/rest/api/3/myself');
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.body, undefined);
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Basic ' + BASIC);
    privateText(JSON.stringify([request.argv, request.execArgv]));
    assert.equal(request.secretInEnvironment, false);
  }
});
