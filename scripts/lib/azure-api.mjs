// Only the short-lived child reads credentials; requests cross stdin and sanitized JSON crosses stdout.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as boardConfig from './board-config.mjs';
import { validateAzureConfig } from './azure-config.mjs';

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const RATE_LIMIT_EXIT = 3;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,47}[A-Za-z0-9])?$/;
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function azureCredentialsPath(home = homedir()) {
  return join(home, '.config', 'fabraik', 'azure.json');
}

function checkedCredentials(value) {
  const names = ['organization', 'authentication', 'token'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== names.length || !names.every((name) => Object.hasOwn(value, name))) {
    throw new Error('Azure credentials must contain exactly organization, authentication and token');
  }
  // eslint-disable-next-line no-control-regex -- Credentials reject ASCII and C1 controls before header construction.
  if (!names.every((name) => typeof value[name] === 'string' && value[name].trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value[name]))) {
    throw new Error('Azure credential values must be nonblank strings without control characters');
  }
  if (!ORGANIZATION.test(value.organization)) throw new Error('Azure credential organization must be an organization slug');
  if (!['entra', 'pat'].includes(value.authentication)) throw new Error('Azure credential authentication must be entra or pat');
  if (value.token !== value.token.trim()) throw new Error('Azure credential token must have no leading or trailing whitespace');
  return Object.freeze({ organization: value.organization, authentication: value.authentication, token: value.token });
}

export function readAzureCredentials({ path, platform, repositoryRoot = REPOSITORY_ROOT }) {
  let descriptor;
  let bytes;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile()) throw new Error('must be a regular file, never a symlink');
    const location = relative(realpathSync(repositoryRoot), realpathSync(path));
    if (!isAbsolute(location) && location !== '..' && !location.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('must be outside the repository');
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.dev !== entry.dev || stats.ino !== entry.ino) throw new Error('must be the checked regular file');
    if (stats.nlink !== 1) throw new Error('must have one link, never a hard-linked file');
    // POSIX mode bits do not establish Windows access-control-list privacy.
    if (platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new Error('must be private; run chmod 600 on the credential file');
    if (stats.size > MAX_CREDENTIAL_BYTES) throw new Error('exceeds 16384 bytes');
    bytes = readFileSync(descriptor);
    if (bytes.length > MAX_CREDENTIAL_BYTES) throw new Error('exceeds 16384 bytes');
  } catch (error) {
    throw new Error(`Azure credentials could not be read: ${error.code ?? error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Azure credentials are not valid JSON'); }
  return checkedCredentials(value);
}

function positiveId(value) {
  return /^[1-9][0-9]*$/.test(value) && Number(value) <= 2147483647;
}

function requestParts(request, config) {
  const names = ['method', 'path', 'query', 'body', 'profile'];
  if (request === null || typeof request !== 'object' || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => !names.includes(key))) throw new Error('Azure request has unsupported fields');
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) throw new Error('Azure request method must be GET, POST or PATCH');
  if (typeof request.path !== 'string' || (request.profile !== undefined && request.profile !== true)) throw new Error('Azure request path/profile is invalid');
  let endpoint;
  let project;
  let type;
  let methods;
  if (request.profile === true) {
    if (request.path !== '/_apis/profile/profiles/me') throw new Error('Azure profile request path must be the exact profile-me endpoint');
    endpoint = 'profile';
    methods = ['GET'];
  } else if (new RegExp('^/_apis/projects/(' + UUID + ')$').test(request.path)) {
    endpoint = 'project';
    project = request.path.slice('/_apis/projects/'.length);
    methods = ['GET'];
  } else if (request.path === '/_apis/wit/workitemrelationtypes') {
    endpoint = 'relations';
    methods = ['GET'];
  } else {
    const match = new RegExp('^/(' + UUID + ')/_apis/wit/(.+)$').exec(request.path);
    if (!match) throw new Error('Azure request path must be an allowed organization-relative endpoint');
    project = match[1];
    const tail = match[2];
    if (tail === 'workitemtypes') { endpoint = 'types'; methods = ['GET']; }
    else if (tail === 'wiql' || tail === 'workitemsbatch') { endpoint = tail; methods = ['POST']; }
    else {
      let segment;
      const states = /^workitemtypes\/([^/]+)\/states$/.exec(tail);
      const create = /^workitems\/\$([^/]+)$/.exec(tail);
      const item = /^workitems\/([1-9][0-9]*)(?:\/(comments)(?:\/([1-9][0-9]*))?)?$/.exec(tail);
      if (states) { endpoint = 'states'; methods = ['GET']; segment = states[1]; }
      else if (create) { endpoint = 'create'; methods = ['POST']; segment = create[1]; }
      else if (item && positiveId(item[1]) && (!item[3] || positiveId(item[3]))) {
        endpoint = item[3] ? 'comment' : item[2] ? 'comments' : 'item';
        methods = item[3] ? ['PATCH'] : item[2] ? ['GET', 'POST'] : ['GET', 'PATCH'];
      } else throw new Error('Azure request path is not an allowed work-item endpoint');
      if (segment !== undefined) {
        try { type = decodeURIComponent(segment); } catch { throw new Error('Azure request path type encoding is invalid'); }
        // Canonical encoding keeps configured native names within one segment; dot traversal remains forbidden.
        if (!type.trim() || type === '.' || type === '..' || encodeURIComponent(type) !== segment) {
          throw new Error('Azure request path type must be a safe encoded native type');
        }
      }
    }
  }
  if (!methods.includes(request.method)) throw new Error('Azure request method is not allowed for this endpoint');
  if (config && ((project !== undefined && project !== config.project) ||
      (type !== undefined && !Object.values(config.workItemTypes).includes(type)))) throw new Error('Azure request path does not match the configured project or work item types');
  const query = new URLSearchParams();
  if (request.query !== undefined) {
    if (request.query === null || typeof request.query !== 'object' || Array.isArray(request.query)) throw new Error('Azure request query must be an object');
    for (const [key, value] of Object.entries(request.query)) {
      let allowed = key === 'api-version' && value === (['comments', 'comment'].includes(endpoint) ? '7.1-preview.4' : '7.1');
      if (endpoint === 'profile') allowed ||= key === 'details' && value === true;
      if (endpoint === 'item' && request.method === 'GET') allowed ||= key === '$expand' && value === 'All';
      if (endpoint === 'create' || (endpoint === 'item' && request.method === 'PATCH')) allowed ||= key === 'validateOnly' && typeof value === 'boolean';
      if (endpoint === 'comments' && request.method === 'GET') {
        allowed ||= (key === '$top' && value === 100) || (key === 'includeDeleted' && value === true) ||
          (key === 'order' && value === 'asc') || (key === 'continuationToken' && typeof value === 'string' && value.trim() !== '');
      }
      if (['comments', 'comment'].includes(endpoint) && request.method !== 'GET') allowed ||= key === 'format' && value === 'markdown';
      if (!allowed) throw new Error('Azure request query contains an unsupported parameter or value');
      query.append(key, String(value));
    }
  }
  if (request.method === 'GET' && request.body !== undefined) throw new Error('Azure GET request must have no body');
  let body;
  try {
    body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (request.body !== undefined && body === undefined) throw new Error();
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw new Error('limit');
  } catch (error) {
    throw new Error(error.message === 'limit' ? 'Azure request/body exceeds the 67108864 byte limit' : 'Azure request body must be JSON');
  }
  return {
    path: request.path + (query.size ? `?${query}` : ''), body,
    contentType: ['create', 'item'].includes(endpoint) && request.method !== 'GET' ? 'application/json-patch+json' : 'application/json',
    mutation: request.method !== 'GET' && !['wiql', 'workitemsbatch'].includes(endpoint),
  };
}

function redactor(credentials) {
  const basic = Buffer.from(':' + credentials.token).toString('base64');
  const secrets = [...new Set([credentials.token, JSON.stringify(credentials.token).slice(1, -1), basic,
    'Bearer ' + credentials.token, 'Basic ' + basic])].sort((a, b) => b.length - a.length);
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

function unknownOutcome(message) {
  return `${message}; outcome unknown: inspect the Azure project/work item before retry`;
}

export async function requestAzure(request, { fetch, credentials, config }) {
  requestParts(request);
  const checked = checkedCredentials(credentials);
  const redact = redactor(checked);
  try {
    const mapping = validateAzureConfig(config);
    const parts = requestParts(request, mapping);
    if (checked.organization !== mapping.organization) throw new Error('Azure credential organization does not match the configured organization');
    const authorization = checked.authentication === 'entra' ? 'Bearer ' + checked.token : 'Basic ' + Buffer.from(':' + checked.token).toString('base64');
    const base = request.profile ? 'https://app.vssps.visualstudio.com' : 'https://dev.azure.com/' + mapping.organization;
    let response;
    let text;
    try {
      response = await fetch(base + parts.path, {
        method: request.method, redirect: 'error',
        headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': parts.contentType },
        ...(parts.body === undefined ? {} : { body: parts.body }),
      });
      text = await response.text();
    } catch {
      const message = 'Azure could not be reached or its response could not be read';
      throw new Error(parts.mutation ? unknownOutcome(message) : message);
    }
    const { status } = response;
    const detail = (message) => parts.mutation && ![400, 401, 403, 404, 409, 412, 413, 422, 429].includes(status) ? unknownOutcome(message) : message;
    if (status === 429) {
      const error = new Error(`Azure rate limit (HTTP 429): Retry-After ${response.headers.get('retry-after') ?? 'not given'}; no retry was sent`);
      error.rateLimited = true;
      throw error;
    }
    if (status === 401) throw new Error('Azure refused credentials (HTTP 401); renew the configured authentication token');
    if (status === 403) throw new Error('Azure permission refused (HTTP 403); check access to the project and this operation');
    if (status === 413) throw new Error('Azure request/body size limit exceeded (HTTP 413)');
    if (status !== 200 && status !== 201) throw new Error(detail(`Azure answered unexpected HTTP ${status}`));
    let data;
    try {
      data = JSON.parse(text);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { throw new Error(parts.mutation ? unknownOutcome('Azure response is not a JSON object') : 'Azure response is not a JSON object'); }
    return privateData(data, redact);
  } catch (error) {
    // Fresh errors retain no unredacted provider stack or cause.
    const safe = new Error(redact(error.message));
    if (error.rateLimited) safe.rateLimited = true;
    throw safe;
  }
}

function transportArgv(raw = process.env.BOARD_TOOLKIT_AZURE) {
  if (raw === undefined) return [process.execPath, fileURLToPath(import.meta.url)];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('BOARD_TOOLKIT_AZURE is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((arg) => typeof arg !== 'string' || arg === '')) {
    throw new Error('BOARD_TOOLKIT_AZURE must be a non-empty JSON array of non-empty strings');
  }
  return parsed;
}

export function azureExec(request, { spawn = spawnSync } = {}) {
  const parts = requestParts(request);
  const [command, ...args] = transportArgv();
  const run = spawn(command, args, {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 60_000,
    maxBuffer: MAX_REQUEST_BYTES, windowsHide: true,
  });
  if (run.error?.code === 'ETIMEDOUT') {
    const message = 'Azure did not answer within 60 s';
    throw new Error(parts.mutation ? unknownOutcome(message) : message);
  }
  if (run.error) throw new Error(parts.mutation ? unknownOutcome('Azure transport failed') : `Azure transport failed: ${run.error.code ?? 'spawn error'}`);
  if (run.status === 0) {
    try { return JSON.parse(run.stdout); }
    catch { throw new Error(parts.mutation ? unknownOutcome('Azure transport returned output that is not JSON') : 'Azure transport returned output that is not JSON'); }
  }
  const message = run.stderr.trim() || `Azure transport ended with ${run.signal ?? `exit ${run.status}`} and no message`;
  const error = new Error(parts.mutation && run.signal ? unknownOutcome(message) : message);
  if (run.status === RATE_LIMIT_EXIT) error.rateLimited = true;
  throw error;
}

async function main() {
  try {
    let request;
    try {
      const input = readFileSync(0, 'utf8');
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new Error();
      request = JSON.parse(input);
    } catch { throw new Error('Azure request on stdin must be JSON within the 67108864 byte limit'); }
    const config = validateAzureConfig(boardConfig.AZURE_CONFIG, 'board-config.mjs AZURE_CONFIG');
    requestParts(request, config);
    const credentials = readAzureCredentials({ path: azureCredentialsPath(), platform: process.platform });
    const data = await requestAzure(request, { fetch, credentials, config });
    process.stdout.write(JSON.stringify(data));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.rateLimited ? RATE_LIMIT_EXIT : 1;
  }
}

// Node canonicalizes aliases in module URLs; compare physical entry files.
if (process.argv[1] && existsSync(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
