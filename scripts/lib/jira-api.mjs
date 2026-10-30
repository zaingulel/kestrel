// Only the short-lived child reads Jira credentials; request data crosses stdin and JSON crosses stdout.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as boardConfig from './board-config.mjs';
import { validateJiraConfig } from './jira-config.mjs';

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const RATE_LIMIT_EXIT = 3;

export function jiraCredentialsPath(home = homedir()) {
  return join(home, '.config', 'fabraik', 'jira.json');
}

// The standalone request seam checks its own destination before it can send an Authorization header.
function siteOrigin(site) {
  let url;
  try {
    url = new URL(site);
  } catch {
    throw new Error('Jira site must be an exact HTTPS tenant origin');
  }
  if (typeof site !== 'string' || url.protocol !== 'https:' || url.origin !== site ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(url.hostname)) {
    throw new Error('Jira site must be an exact https://<tenant>.atlassian.net origin');
  }
  return site;
}

function checkedCredentials(value) {
  const names = ['site', 'email', 'token'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || !names.every((name) => Object.hasOwn(value, name))) {
    throw new Error('Jira credentials must contain exactly site, email and token');
  }
  // eslint-disable-next-line no-control-regex -- Credentials must reject ASCII and C1 control characters.
  if (!names.every((name) => typeof value[name] === 'string' && value[name].trim() !== '' && !/[\x00-\x1f\x7f-\x9f]/.test(value[name]))) {
    throw new Error('Jira credential values must be nonblank strings without control characters');
  }
  siteOrigin(value.site);
  if (!/^[^\s:]+@[^\s:]+$/.test(value.email)) throw new Error('Jira credential email must be an account email address');
  return Object.freeze({ site: value.site, email: value.email, token: value.token });
}

export function readJiraCredentials({ path, platform }) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new Error(`Jira credentials at ${path} could not be read: ${error.code}`);
  }
  if (!entry.isFile()) throw new Error(`Jira credentials at ${path} must be a regular file, never a symlink`);
  let descriptor;
  let bytes;
  try {
    // O_NOFOLLOW closes the gap between checking the path and opening it on platforms that support it.
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('not a regular file');
    // Windows has no Unix group/other permission bits.
    if (platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error(`open to other accounts; run chmod 600 ${path}`);
    }
    if (stats.size > MAX_CREDENTIAL_BYTES) throw new Error(`over ${MAX_CREDENTIAL_BYTES} bytes`);
    bytes = readFileSync(descriptor);
    if (bytes.length > MAX_CREDENTIAL_BYTES) throw new Error(`over ${MAX_CREDENTIAL_BYTES} bytes`);
  } catch (error) {
    throw new Error(`Jira credentials at ${path}: ${error.code ?? error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Jira credentials at ${path} are not valid JSON`);
  }
  return checkedCredentials(value);
}

function requestParts(request) {
  const names = ['method', 'path', 'query', 'body'];
  if (request === null || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some((key) => !names.includes(key))) throw new Error('Jira request has unsupported fields');
  if (!['GET', 'POST', 'PUT'].includes(request.method)) throw new Error('Jira request method must be GET, POST or PUT');
  if (typeof request.path !== 'string' || !/^\/rest\/api\/3\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(request.path)) {
    throw new Error('Jira request path must be a /rest/api/3 path with safe identifier segments');
  }
  const query = new URLSearchParams();
  if (request.query !== undefined) {
    if (request.query === null || typeof request.query !== 'object' || Array.isArray(request.query)) throw new Error('Jira request query must be an object');
    for (const [key, value] of Object.entries(request.query)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error('Jira request query values must be strings, finite numbers or booleans');
      }
      query.append(key, String(value));
    }
  }
  if (request.method === 'GET' && request.body !== undefined) throw new Error('Jira GET request must have no body');
  let body;
  try {
    body = request.body === undefined ? undefined : JSON.stringify(request.body);
  } catch {
    throw new Error('Jira request body must be JSON');
  }
  return { path: request.path + (query.size ? `?${query}` : ''), body };
}

function redactor(credentials) {
  const basic = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const secrets = [...new Set([credentials.token, JSON.stringify(credentials.token).slice(1, -1), basic])].sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[redacted]'), String(text));
}

function privateData(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => privateData(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), privateData(item, redact)]));
  }
  return value;
}

function details(body) {
  const messages = Array.isArray(body?.errorMessages) ? body.errorMessages.filter((message) => typeof message === 'string') : [];
  if (body?.errors && typeof body.errors === 'object') {
    messages.push(...Object.entries(body.errors).map(([field, message]) => `${field}: ${message}`));
  }
  return messages.length ? `; Jira said ${messages.join('; ')}` : '';
}

export async function requestJira(request, { fetch, credentials, site }) {
  const checked = checkedCredentials(credentials);
  const redact = redactor(checked);
  try {
    siteOrigin(site);
    if (checked.site !== site) throw new Error('Jira credential site does not match the configured tenant site');
    const { path, body } = requestParts(request);
    const authorization = 'Basic ' + Buffer.from(`${checked.email}:${checked.token}`).toString('base64');
    let response;
    let text;
    try {
      response = await fetch(site + path, {
        method: request.method, redirect: 'error',
        headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      text = await response.text();
    } catch (error) {
      throw new Error(`Jira could not be reached: ${error.cause?.code ?? error.cause?.name ?? error.name}`);
    }
    const { status } = response;
    let data;
    let parsed = true;
    try { data = JSON.parse(text); } catch { parsed = false; }
    if (status === 429) {
      const error = new Error(`Jira rate limit (HTTP 429): Retry-After ${response.headers.get('retry-after') ?? 'not given'}; nothing further was sent`);
      error.rateLimited = true;
      throw error;
    }
    if (status === 401) throw new Error(`Jira refused credentials (HTTP 401); check the account email and classic API token${details(data)}`);
    if (status === 403) throw new Error(`Jira permission refused (HTTP 403); check Browse Projects and the permissions for this operation${details(data)}`);
    if (status === 204) {
      if (text !== '') throw new Error('Jira answered HTTP 204 with a nonempty body');
      return null;
    }
    if (status !== 200 && status !== 201) throw new Error(`Jira answered unexpected HTTP ${status}${details(data)}`);
    if (status === 201 && request.method === 'POST' && request.path === '/rest/api/3/issueLink' && text === '') return null;
    if (!parsed) throw new Error(`Jira answered HTTP ${status} with a body that is not JSON`);
    return privateData(data, redact);
  } catch (error) {
    // Fresh errors retain no unredacted stack or cause from provider data.
    const safe = new Error(redact(error.message));
    if (error.rateLimited) safe.rateLimited = true;
    throw safe;
  }
}

function transportArgv(raw = process.env.BOARD_TOOLKIT_JIRA) {
  if (raw === undefined) return [process.execPath, fileURLToPath(import.meta.url)];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('BOARD_TOOLKIT_JIRA is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((arg) => typeof arg !== 'string' || arg === '')) {
    throw new Error('BOARD_TOOLKIT_JIRA must be a non-empty JSON array of non-empty strings');
  }
  return parsed;
}

export function jiraExec(request, { spawn = spawnSync } = {}) {
  requestParts(request);
  const [command, ...args] = transportArgv();
  const run = spawn(command, args, {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (run.error?.code === 'ETIMEDOUT') throw new Error('Jira did not answer within 60 s');
  if (run.error) throw new Error(`Jira transport could not start: ${run.error.code ?? 'spawn error'}`);
  if (run.status === 0) {
    try { return JSON.parse(run.stdout); } catch { throw new Error('Jira transport returned output that is not JSON'); }
  }
  const error = new Error(run.stderr.trim() || `Jira transport ended with ${run.signal ?? `exit ${run.status}`} and no message`);
  if (run.status === RATE_LIMIT_EXIT) error.rateLimited = true;
  throw error;
}

async function main() {
  try {
    let request;
    try { request = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('Jira request on stdin is not JSON'); }
    requestParts(request);
    const config = validateJiraConfig(boardConfig.JIRA_CONFIG, 'board-config.mjs JIRA_CONFIG');
    const credentials = readJiraCredentials({ path: jiraCredentialsPath(), platform: process.platform });
    const data = await requestJira(request, { fetch, credentials, site: config.site });
    process.stdout.write(JSON.stringify(data));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.rateLimited ? RATE_LIMIT_EXIT : 1;
  }
}

// Node canonicalizes filesystem aliases in module URLs; compare physical entry files.
if (process.argv[1] && existsSync(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
