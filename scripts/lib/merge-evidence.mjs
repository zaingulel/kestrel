// Merge-on-evidence policy for a run session's own open, claimed card and origin repository. The board reads
// heldReasons for its wait listing. The publication guard checks the live delivery route and its approval witness:
// card comments for an ordinary run; a Herdr job on either runtime has none, since only its card's marker holds it.
// Git and GitHub reads are injected at the command boundary and default to a 15 s timeout per read.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghExecutable, gitExecutable } from './posix-shell.mjs';
import { readSettingsHeader } from './runtimes.mjs';

// The saved write-up in a job's review folder: its screenshot files, the HTML comments taken out before it is read,
// and whether its Evidence says there is no visual change.
export const SCREENSHOT = /^screenshot-\d+\.(?:png|jpe?g|gif|webp)$/i;
export const HTML_COMMENT = /<!--[\s\S]*?-->/g;
export const INVALID_ORIGIN_REPOSITORY_METADATA = 'unreadable origin repository: GitHub CLI returned invalid repository metadata';

// True when a line of the Evidence section reads `no visual change`, in any case, with an optional final full stop.
// `body` is the write-up with its HTML comments taken out.
export const saysNoVisualChange = (body) => {
  const evidence = body.split(/^## /m).find((section) => section.split(/\r?\n/, 1)[0].trim() === 'Evidence');
  return /^\s*no visual change\.?\s*$/im.test(evidence ?? '');
};

// A complete Markdown image whose target is a GitHub upload, capturing its alt text.
const UPLOADED_IMAGE_ALT = /!\[([^\]\n]*)\]\(https:\/\/github\.com\/user-attachments\/[^\s()]+\)/g;

const REFUSAL = 'a pre-approved run session ';
const RUN_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// One GraphQL reply carries up to 100 comment bodies; Node's 1 MiB default would refuse a valid read.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Bounds how many screenshots a saved review may hash: one full object ID each, after the write-up's.
const MAX_REVIEW_HASH_BYTES = 16 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// The issue selection the card read asks for. Comments come oldest first; comments and labels each stop at 100, so a
// card with more is unavailable, never read in part: cardOf refuses more comments and cardMarked more labels.
const ISSUE_FIELDS = `
      state
      title
      body
      lastEditedAt
      comments(first: 100) { pageInfo { hasNextPage } nodes { author { login } editor { login } createdAt lastEditedAt url body } }
      labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
    `;
const CARD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {${ISSUE_FIELDS}}
  }
}`;

const PINNED_PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      number state headRefName baseRefName headRepository { id }
      isCrossRepository headRefOid baseRefOid isDraft autoMergeRequest { enabledAt }
      isInMergeQueue isMergeQueueEnabled
    }
  }
}`;
const CODE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SETTING_UNAVAILABLE = 'pre-approved run setting unavailable on fetched main; fetch origin and verify .agents/factory-settings.json on main';
const CHECKOUT_BEHIND = `pre-approved run setting unreadable by the checkout at ${dirname(dirname(CODE_DIRECTORY))}, which is older than fetched main; bring that checkout up to date with fetched main, then retry`;
const pinBehind = (root) => `pre-approved run setting unreadable by this job's workflow version at ${root}, which is older than fetched main and does not know that setting; this job cannot publish: withdraw it and start a fresh job from current main`;

/** @typedef {{ commit: string, root: string }} WorkflowPin */

// The refusal where the running code's validator refused fetched main's settings at `oid`: the behind message when
// that code is strictly behind oid, with no commit of its own and at least one that only oid reaches, and otherwise
// the unavailable one. The running code is the job's verified workflow version `workflowPin` where the guard passes
// one, and otherwise HEAD of the checkout holding this module, since the guard runs the code of the root checkout from
// a job worktree. A failed read or any other reply, a missing object, a directory outside a repository and unrelated
// history included, is not behind, and its text is dropped.
function settingsRefusal(git, oid, workflowPin) {
  const range = workflowPin ? ['rev-list', '--left-right', '--count', `${workflowPin.commit}...${oid}`]
    : ['-C', CODE_DIRECTORY, 'rev-list', '--left-right', '--count', `HEAD...${oid}`];
  let behind;
  try {
    behind = /^0\t[1-9]\d*$/.test(git(range).trim());
  } catch {
    behind = false;
  }
  if (!behind) return SETTING_UNAVAILABLE;
  return workflowPin ? pinBehind(workflowPin.root) : CHECKOUT_BEHIND;
}

// A commit or object name as git prints it: 40 lowercase hex characters, or 64 in a SHA-256 repository.
export const COMMIT_TEXT = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const COMMIT = new RegExp(`^${COMMIT_TEXT}$`);

// Pin one local fetched-main object so a ref moving between reads cannot mix settings versions, and give the settings
// header of its settings file (readSettingsHeader's result), where the file or a key is absent as the header defaults
// it. With `herdr`, the same settings must also turn the Herdr add-on on. `workflowPin` is the job's verified workflow
// version where the guard runs from one.
/** @param {{ git: (args: string[]) => string, herdr?: boolean, workflowPin?: WorkflowPin }} options */
function readFetchedSettings({ git, herdr = false, workflowPin }) {
  let oid;
  let text;
  try {
    oid = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']).trim();
    if (!new RegExp(`^${COMMIT_TEXT}$`).test(oid)) throw new Error('invalid fetched-main object');
    const mode = git(['ls-tree', '--full-tree', '--format=%(objectmode)', oid, '--', '.agents/factory-settings.json']).trim();
    if (mode) {
      if (mode !== '100644' && mode !== '100755') throw new Error('nonregular settings entry');
      text = git(['show', `${oid}:.agents/factory-settings.json`]);
    }
  } catch {
    // Child errors can contain credentials.
    throw new Error(SETTING_UNAVAILABLE);
  }
  let header;
  try {
    header = readSettingsHeader(text, '.agents/factory-settings.json');
  } catch {
    // Refusals can carry untrusted settings values; code older than fetched main refuses settings it does not know.
    throw new Error(settingsRefusal(git, oid, workflowPin));
  }
  if (herdr && !header.herdr) throw Object.assign(new Error('Herdr add-on off on fetched main; herdr must be true in .agents/factory-settings.json on main'), { code: 'HERDR_OFF' });
  return { ...header, oid };
}

// Fetched main's wait level, one of WAIT_LEVELS: always where the file or the key is absent.
export const readWaitLevel = (options) => readFetchedSettings(options).waitForOwner;

// Fetched main's coordinator defaults to Claude with opus at medium. The opener can also read the installed runtimes from the same commit.
/** @typedef {{ git: (args: string[]) => string, herdr?: boolean }} CoordinatorRead */
/** @overload @param {CoordinatorRead & { includeInstalled: true }} options @returns {ReturnType<typeof readFetchedSettings>['coordinator'] & { installed: ReturnType<typeof readFetchedSettings>['runtimes'] }} */
/** @overload @param {CoordinatorRead & { includeInstalled?: false }} options @returns {ReturnType<typeof readFetchedSettings>['coordinator']} */
/** @param {CoordinatorRead & { includeInstalled?: boolean }} options */
export function readCoordinator(options) {
  const { coordinator, runtimes } = readFetchedSettings(options);
  return options.includeInstalled ? { ...coordinator, installed: runtimes } : coordinator;
}

// Fetched main's wait level once it lets finished work merge on its evidence: refuses,
// with code ALWAYS_WAITS, unless waitForOwner is on-screen or when-needed.
export function requireMergeOnEvidence({ git, herdr = false }) {
  return deliverySettings({ git, herdr }).waitForOwner;
}

/** @param {{ git: (args: string[]) => string, herdr?: boolean, workflowPin?: WorkflowPin }} options */
function deliverySettings({ git, herdr = false, workflowPin }) {
  const settings = readFetchedSettings({ git, herdr, workflowPin });
  if (settings.waitForOwner !== 'on-screen' && settings.waitForOwner !== 'when-needed') throw Object.assign(new Error('pre-approved run disabled on fetched main; waitForOwner must be on-screen or when-needed in .agents/factory-settings.json on main'), { code: 'ALWAYS_WAITS' });
  return settings;
}

export const trackerLine = (tracker) => `a run needs GitHub issues; this repository's tracker is ${tracker}`;

// The runner throws on its first call, naming the missing executable, when the lookup found none.
/** @type {(file: string | null, name: string, options: { cwd?: string, env?: NodeJS.ProcessEnv, strictUtf8?: boolean }) => (args: string[]) => string} */
export function defaultRunner(file, name, { cwd, env, strictUtf8 = false }) {
  return (args) => {
    if (!file) throw new Error(`found no ${name} in an absolute PATH entry`);
    try {
      const result = execFileSync(file, args, { cwd, env, encoding: strictUtf8 ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: MAX_OUTPUT_BYTES });
      return typeof result === 'string' ? result : STRICT_UTF8.decode(result);
    } catch (error) {
      throw Object.assign(new Error(/** @type {{ stderr?: string | Buffer }} */ (error).stderr?.toString().trim() || /** @type {Error} */ (error).message), { status: /** @type {{ status?: number | null }} */ (error).status });
    }
  };
}

const isText = (value) => typeof value === 'string';
const isTime = (value) => value === null || isText(value);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Rules that make GitHub require checks the rule does not name.
const UNNAMED_RULE_TYPES = new Set(['workflows', 'code_scanning']);
const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);

export function readRequiredSet(baseRefName, ghExec) {
  const branch = JSON.parse(ghExec(['api', `repos/{owner}/{repo}/branches/${baseRefName}`]));
  if (!isObject(branch) || (!isObject(branch.protection) && !(branch.protection === undefined && branch.protected === false))) {
    throw new Error(`unreadable required status checks: branch protection ${JSON.stringify(branch?.protection ?? null)}`);
  }
  const classicChecks = branch.protection?.required_status_checks;
  const classic = classicChecks == null ? [] : classicChecks.contexts;
  if (!Array.isArray(classic) || !classic.every((name) => isText(name) && name !== '')) {
    throw new Error(`unreadable required set: classic required_status_checks ${JSON.stringify(classicChecks)}`);
  }
  const pages = JSON.parse(ghExec(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/rules/branches/${baseRefName}`]));
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
    throw new Error(`unreadable required set: rules ${JSON.stringify(pages)}`);
  }
  const ruled = [];
  for (const rule of pages.flat()) {
    if (!isText(rule?.type) || rule.type === '') throw new Error(`unreadable required set: rule ${JSON.stringify(rule)}`);
    if (rule.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks) || !checks.every((check) => isText(check?.context) && check.context !== '')) {
        throw new Error(`unreadable required set: rule ${JSON.stringify(rule)}`);
      }
      ruled.push(...checks.map((check) => check.context));
    } else if (UNNAMED_RULE_TYPES.has(rule.type)) {
      ruled.push({ unnamed: rule.type });
    }
  }
  return { classic, ruled };
}

export const requiredCheckArgs = (pr) => ['pr', 'checks', pr, '--required', '--json', 'name,bucket,link'];

// GitHub lists a required check only once it reports, so the independent set supplies missing names.
export function parseRequiredReports(output, required) {
  const checks = JSON.parse(output);
  if (!Array.isArray(checks)) throw new Error(`unreadable required checks: ${JSON.stringify(checks)}`);
  for (const check of checks) {
    if (!isText(check?.name) || check.name === '') {
      throw new Error(`unreadable name on required check: ${JSON.stringify(check)}`);
    }
    if (!BUCKETS.has(check.bucket)) {
      throw new Error(`unreadable bucket on required check ${JSON.stringify(check.name)}: ${JSON.stringify(check.bucket ?? null)}`);
    }
  }
  const reported = new Set(checks.map((check) => check.name));
  const unreported = [...required].filter((name) => !reported.has(name));
  return { checks, unreported };
}

// Read the single matching fetch/push destination without exposing remote diagnostics.
function originRemote(git) {
  let pushUrls, fetchUrl;
  try {
    pushUrls = git(['remote', 'get-url', '--push', '--all', 'origin']).trim().split(/\r?\n/);
    fetchUrl = git(['remote', 'get-url', 'origin']).trim();
  } catch { throw new Error('origin remote is unreadable'); }
  if (pushUrls.length !== 1 || pushUrls[0] !== fetchUrl) {
    throw new Error('origin does not have exactly one push destination matching the repository it fetches from');
  }
  return fetchUrl;
}

export function readOrigin({ git }) {
  const fetchUrl = originRemote(git);
  if (/[?#]/.test(fetchUrl)) throw new Error('admission origin must not contain query or fragment credentials');
  const scpOrigin = /^(?:[^/@:\s]+@)?[^/@:\s]+:\/?[^/@:\s]+\/[^/@:\s]+$/;
  if (!scpOrigin.test(fetchUrl)) {
    if (!/^(?:https?|ssh|git):\/\//i.test(fetchUrl)) throw new Error('admission origin URL is invalid');
    let originUrl;
    try {
      originUrl = new URL(fetchUrl);
    } catch {
      throw new Error('admission origin URL is invalid');
    }
    if (!originUrl.hostname || !/^\/[^/@:\s]+\/[^/@:\s]+$/.test(originUrl.pathname)) throw new Error('admission origin URL is invalid');
    if (originUrl.password || (['http:', 'https:', 'git:'].includes(originUrl.protocol) && originUrl.username)) {
      throw new Error('admission origin must not contain credentials');
    }
  }
  return fetchUrl;
}

// Publication retains its existing remote reads; a prepared origin must still match before provider lookup.
/** @param {{ git: (args: string[]) => string, exec: (args: string[]) => string, origin?: string }} options */
export function originRepository({ git, exec, origin }) {
  const fetchUrl = originRemote(git);
  if (origin !== undefined && origin !== fetchUrl) throw new Error('origin changed since repository preparation');
  let reply;
  try {
    reply = exec(['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', fetchUrl]);
  } catch (error) {
    const cause = /** @type {{ message?: unknown } | null | undefined} */ (error)?.message;
    if (cause === 'found no gh.exe in an absolute PATH entry') {
      // Reconstruct the validated fixed reason because the child Error object remains untrusted.
      throw new Error(cause);
    }
    throw new Error('unreadable origin repository: the GitHub CLI lookup failed; check that gh is installed on PATH and can access the repository');
  }
  let repository;
  try {
    repository = JSON.parse(reply);
  } catch {
    throw new Error('unreadable origin repository: GitHub CLI returned invalid JSON');
  }
  const defaultBranch = repository?.defaultBranchRef?.name;
  if (!isText(repository?.id) || !/^\S+$/.test(repository.id) || !/^[^/\s]+\/[^/\s]+$/.test(repository?.nameWithOwner)
    || !isText(defaultBranch) || !/^\S+$/.test(defaultBranch)) {
    throw new Error(INVALID_ORIGIN_REPOSITORY_METADATA);
  }
  return { id: repository.id, nameWithOwner: repository.nameWithOwner, defaultBranch, origin: fetchUrl };
}

// Writes `text` to a file in a fresh temporary folder, passes its path to `write`, and removes the folder after.
export function withBodyFile(text, write) {
  const folder = mkdtempSync(join(tmpdir(), 'merge-evidence-body-'));
  try {
    const file = join(folder, 'body.md');
    writeFileSync(file, text);
    return write(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Returns { login, issue } for one card of `repository` from what a read answered, or throws when the
// reply is for another repository, is malformed, or has more comments than one read holds.
function cardOf(card, { login, repositoryId, issue }, repository) {
  if (repositoryId !== repository.id) {
    throw new Error(`the card read answered for repository ${JSON.stringify(repositoryId)}, not origin's ${repository.nameWithOwner}`);
  }
  const wellFormed = isText(login) && isText(issue?.state) && isText(issue.title) && isTime(issue.lastEditedAt)
    && typeof issue.comments?.pageInfo?.hasNextPage === 'boolean' && Array.isArray(issue.comments.nodes)
    && issue.comments.nodes.every((comment) => isText(comment?.body) && isText(comment.createdAt) && isTime(comment.lastEditedAt) && isText(comment.url));
  if (!wellFormed) throw new Error(`unreadable card read for card ${card} in ${repository.nameWithOwner}`);
  if (issue.comments.pageInfo.hasNextPage) throw new Error(`card ${card} has more than 100 comments, so its comments cannot all be read`);
  return { login, issue };
}

// Returns { login, issue } for one card of `repository`. Native delivery requires a complete GraphQL reply.
export function readCard(card, { exec, repository, complete = false }) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const reply = JSON.parse(exec(['api', 'graphql', '-f', `query=${CARD_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${card}`]));
  if (complete && reply?.errors !== undefined) throw new Error('GitHub returned an incomplete card read');
  const answered = reply?.data?.repository;
  return cardOf(card, { login: reply?.data?.viewer?.login, repositoryId: answered?.id, issue: answered?.issue }, repository);
}

// Whether card `card`, as a read answers it, carries a label isShowFirst matches, or a throw naming the card where its
// labels cannot all be read: absent, malformed, or more than one read holds.
function cardMarked(card, issue) {
  const labels = issue.labels;
  if (typeof labels?.pageInfo?.hasNextPage !== 'boolean' || !Array.isArray(labels.nodes) || !labels.nodes.every((label) => isText(label?.name))) {
    throw new Error(`unreadable labels on card ${card}`);
  }
  if (labels.pageInfo.hasNextPage) throw new Error(`card ${card} has more than 100 labels, so its labels cannot all be read`);
  return labels.nodes.some((label) => isShowFirst(label.name));
}

// Why a card, as a read answers it, cannot be delivered, or '' when it is open and not a proposal.
export const cardIneligibility = (issue) => {
  if (issue.state !== 'OPEN') return 'the card is closed';
  return issue.title.startsWith('Proposed: ') ? 'the card is still a proposal' : '';
};

// Mirrors isClaim in board.mjs, which the guard must not load because it loads the board configuration.
const isClaim = (comment) => comment.trimStart().startsWith('Claim:');

// Why a run did not claim its card, or '' when its acting account made the newest claim at or after its start.
const claimLapse = (card, login, newest, start) => {
  if (!newest) return `card ${card} has no Claim comment`;
  const author = newest.author?.login ?? 'a deleted account';
  if (author !== login) return `the newest claim on card ${card} was made by ${author}, not ${login}`;
  if (!(Date.parse(newest.createdAt) >= Date.parse(start))) return `the newest claim on card ${card} was made at ${newest.createdAt}, not at or after this run's start at ${start}`;
  return '';
};

// The two records a card comment can hold, each on its first line: the owner's answer for the saved card at a head,
// named by its identity, and a fix built at a new head from an answered one. Each captures the card, the head, the
// identity or the head built from, and the words.
const OWNER_ANSWER = new RegExp(`^Owner answer: job/([1-9]\\d*) at (${COMMIT_TEXT}) (${COMMIT_TEXT}(?:,${COMMIT_TEXT})*): (.*)$`);
const FIX_BUILT = new RegExp(`^Fix built: job/([1-9]\\d*) at (${COMMIT_TEXT}) from (${COMMIT_TEXT}): (.*)$`);

// The record a card comment's `body` holds for card `card`, read on its first line after leading blanks as isClaim
// reads a claim: { kind: 'answer', head, identity, words } or { kind: 'fix', head, from, words }, or undefined where
// that line is neither, names another card or holds blank words.
export function cardRecord(body, card) {
  const line = body.trimStart().split(/\r?\n/, 1)[0];
  const [, named, head, other, words] = OWNER_ANSWER.exec(line) ?? FIX_BUILT.exec(line) ?? [];
  if (named !== String(card) || words.trim() === '') return undefined;
  return line.startsWith('Owner answer: ') ? { kind: 'answer', head, identity: other, words } : { kind: 'fix', head, from: other, words };
}

// Text that quotes error output or a command, such as a lead's reason, may carry a credential, so each credential shape in it becomes `[redacted]`: GitHub's token prefixes,
// Anthropic keys, a bearer token, a URL's user information and the value of a secret-named parameter.
const CREDENTIALS = [
  [/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted]'],
  [/\bgithub_pat_\w+/g, '[redacted]'],
  [/\bsk-ant-[\w-]+/g, '[redacted]'],
  [/\b(bearer\s+)\S+/gi, '$1[redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@'],
  [/(token|secret|password|key)=[^\s&]+/gi, '$1=[redacted]'],
];
export const redact = (text) => CREDENTIALS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);

export const REPLY_MAX = 500;

// The one form of the owner answer record cardRecord reads.
export const ownerAnswerLine = (card, head, identity, words) => `Owner answer: job/${card} at ${head} ${identity}: ${words}`;

// The newest owner answer on card `card` by `login` among `comments`, oldest first: { at, comment, answer }, with `at`
// its index in `comments` and `answer` the record cardRecord reads, or undefined where no answer holds. The newest
// comment of that account whose first line begins `Owner answer: job/<card> ` is the answer, and none holds where it is
// not a whole record, since an older answer never stands in for one the owner replaced, or where any comment of that
// account names, as `editor`, another account as its last editor. A comment edited with no `editor` counts as edited by
// another account, since GitHub names no editor it no longer has.
export function newestOwnerAnswer(card, comments, login) {
  const own = (comment) => comment.author?.login === login;
  if (comments.some((comment) => own(comment) && (comment.editor ? comment.editor.login !== login : comment.lastEditedAt !== null))) return undefined;
  const at = comments.findLastIndex((comment) => own(comment) && comment.body.trimStart().startsWith(`Owner answer: job/${card} `));
  const answer = at === -1 ? undefined : cardRecord(comments[at].body, card);
  return answer && { at, comment: comments[at], answer };
}

// The marker by which the owner holds a card for their own answer, whatever the wait level.
export const SHOW_FIRST = 'show-me-first';

// Whether label `name` is that marker: its name, trimmed and lower-cased, is SHOW_FIRST.
const isShowFirst = (name) => name.trim().toLowerCase() === SHOW_FIRST;

// Whether any of a card's `labels` is that marker, or a throw naming the card where one is not text, so an unreadable
// label is never read as an absent marker.
export const showFirstAmong = (card, labels) => {
  if (!labels.every(isText)) throw new Error(`unreadable labels on card ${card}`);
  return labels.some(isShowFirst);
};

// The reasons finished work waits for the owner, in the order they are reported: the five a write-up holds, which
// waitReasons reads, then the two withHolds adds.
export const WAIT_REASONS = ['check', 'screenshot', 'beyond-card', 'sign-off', 'hard-to-undo', 'on-screen', SHOW_FIRST];

// The line that follows them where fetched main's wait level is always.
export const EVERY_CARD_WAITS = 'every card waits for you: waitForOwner is always';

// The write-up's reasons a Herdr job still waits on: the ones the job itself must put right.
export const HERDR_HOLDS = ['check', 'screenshot'];

// `reasons`, held reasons in WAIT_REASONS order, with what the wait level and the card add: on-screen where the level
// is on-screen and the work is on screen, SHOW_FIRST where the card carries that marker, then EVERY_CARD_WAITS where
// the level is always. With `herdr`, for a job a Herdr coordinator started, only the card's marker holds for the
// owner: of `reasons` only HERDR_HOLDS are kept, and the wait level adds nothing.
export function withHolds(reasons, { level, onScreen, marked, herdr = false }) {
  const held = new Set(herdr ? [...reasons].filter((reason) => HERDR_HOLDS.includes(reason)) : reasons);
  if (!herdr && level === 'on-screen' && onScreen) held.add('on-screen');
  if (marked) held.add(SHOW_FIRST);
  const ordered = WAIT_REASONS.filter((reason) => held.has(reason));
  return !herdr && level === 'always' ? [...ordered, EVERY_CARD_WAITS] : ordered;
}

// The review line's two forms, as the pull request template defines them: six fields, or nine with the add-on's three.
const COUNT = String.raw`(0|[1-9]\d*)`;
const REVIEW_LINE = new RegExp(`^Review: tier=(document|code|sign-off) rounds=${COUNT} raised=${COUNT} fixed=${COUNT} dismissed=${COUNT} deferred=${COUNT}`
  + `(?: greptile_rounds=${COUNT} greptile_raised=${COUNT} greptile_true=${COUNT})?$`);
const FALLBACK_LINE = /^Primary review fallback: completed=codex unavailable=claude-code cause=(?:quota|login|service) evidence=([\s\S]*)$/u;
const INVISIBLE_EVIDENCE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE_EVIDENCE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;
const DETAILS_TAG = /<(\/)details[ \t\n\f\r]*>|<details(?:[ \t\n\f\r](?:[^"'<>]|"[^"]*"|'[^']*')*)?\/?>/gi;

// The write-up with its fenced code blocks taken out, line by line; an unclosed fence runs to the end.
const withoutFences = (text) => {
  let fence;
  return text.split(/\r?\n/).filter((line) => {
    if (fence === undefined) {
      fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      return fence === undefined;
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
    if (close?.[0] === fence[0] && /** @type {string} */ (close).length >= fence.length) fence = undefined;
    return false;
  }).join('\n');
};

// Remove comments and fenced examples before assessing review declarations. The body assessment first refuses
// unclosed comments so missing evidence cannot be hidden by an unreadable write-up.
export const readable = (body) => withoutFences(body.replace(HTML_COMMENT, ''));

// An ATX heading's text, without its marker and closing sequence, and a setext heading's underline.
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const SECTION_START = /^## /m;
const sectionName = (section) => section.split(/\r?\n/, 1)[0].trim();

// The lines of the section headed `## <name>`, or undefined when the write-up has none; throws, naming the write-up as
// `source`, when it has more than one or heads one in any other form than `## <name>`, which the split would miss.
const sectionLines = (text, name, source) => {
  const all = text.split(/\r?\n/);
  const misheaded = all.some((line, at) => !(line.startsWith('## ') && line.slice(3).trim() === name)
    && (ATX_HEADING.exec(line)?.[1] === name
      || (/^ {0,3}\S/.test(line) && line.trim() === name && SETEXT_UNDERLINE.test(all[at + 1] ?? ''))));
  if (misheaded) throw new Error(`${source} has a ${name} heading that is not written as ## ${name}`);
  const sections = text.split(SECTION_START).slice(1).filter((section) => sectionName(section) === name);
  if (sections.length > 1) throw new Error(`${source} has more than one ${name} section`);
  return sections[0]?.split(/\r?\n/).slice(1);
};

// A details block interrupts prose and keeps its contents raw until a blank line.
const RAW_DETAILS_START = /(?:^|\n) {0,3}<\/?details(?=[ \t\n\v\f\r]|\/?>|$)/i;

function* activeDetailsTags(text) {
  const proseTokens = new RegExp(/\\[\\`<]|(`+)|/.source + DETAILS_TAG.source, 'gi');
  const backtickRuns = /`+/g;
  const emptyAtxHeading = /^ {0,3}#{1,6}$/;
  const thematicBreak = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
  for (const block of text.split(/\n(?:[ \t]*\n)+/)) {
    const rawStart = block.search(RAW_DETAILS_START);
    const prose = rawStart === -1 ? block : block.slice(0, rawStart);
    const lines = prose.split('\n');
    const proseParts = [];
    let start = 0;
    for (const [index, line] of lines.entries()) {
      if (ATX_HEADING.test(line) || emptyAtxHeading.test(line)
        || SETEXT_UNDERLINE.test(line) || thematicBreak.test(line)) {
        proseParts.push(lines.slice(start, index).join('\n'), line);
        start = index + 1;
      }
    }
    proseParts.push(lines.slice(start).join('\n'));
    for (const part of proseParts) {
      proseTokens.lastIndex = 0;
      let token;
      while ((token = proseTokens.exec(part))) {
        const [value, opener, closing] = token;
        if (value.startsWith('<')) yield closing;
        if (!opener) continue;
        // Inside a code span, a backslash does not escape the closing delimiter.
        backtickRuns.lastIndex = proseTokens.lastIndex;
        let closer;
        while ((closer = backtickRuns.exec(part))) {
          if (closer[0].length !== opener.length) continue;
          proseTokens.lastIndex = backtickRuns.lastIndex;
          break;
        }
      }
    }
    if (rawStart !== -1) {
      for (const [, closing] of block.slice(rawStart).matchAll(DETAILS_TAG)) yield closing;
    }
  }
}

// A fallback heading inside collapsed content cannot disclose the fallback visibly.
const detailsBalancedBeforeReview = (text) => {
  const sections = text.split(SECTION_START);
  const reviewHeading = sections.findIndex((section, index) => index > 0 && sectionName(section) === 'Review');
  const prefix = sections.slice(0, reviewHeading).join('## ');
  let depth = 0;
  for (const closing of activeDetailsTags(prefix)) {
    depth += closing ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
};

// Report whether the review settled and carry its validated fallback line for comparison with the published body.
const reviewSettled = (text, source) => {
  const lines = sectionLines(text, 'Review', source) ?? [];
  const reviewLines = lines.filter((line) => line.startsWith('Review: '));
  const fields = reviewLines.length === 1 ? REVIEW_LINE.exec(reviewLines[0].trimEnd()) : null;
  if (!fields) return { settled: false, fallback: undefined };
  const [rounds, raised, fixed, dismissed, deferred, onRounds = 0, onRaised = 0, onTrue = 0] = fields.slice(2).filter((count) => count !== undefined).map(Number);
  const nested = onRounds <= rounds && onTrue <= onRaised && onTrue <= fixed + deferred
    && onRaised - onTrue <= dismissed && (onRounds > 0 || onRaised === 0);
  if (rounds < 1 || raised !== fixed + dismissed + deferred || deferred !== 0 || !nested) {
    return { settled: false, fallback: undefined };
  }

  const after = lines.slice(lines.indexOf(reviewLines[0]) + 1);
  const collapsed = after.findIndex((line) => line.startsWith('<details>'));
  const declarations = (collapsed === -1 ? after : after.slice(0, collapsed)).filter((line) => line.trim() !== '');
  // Scan the whole section so a duplicate or misplaced declaration cannot pass as an ordinary review.
  const markers = lines.filter((line) => line.trimStart().startsWith('Primary review fallback:')).length;
  if (declarations.length === 0 && markers === 0) return { settled: true, fallback: undefined };
  // The nested counts already require zero add-on findings when there are zero add-on rounds.
  if (declarations.length === 1 && markers === 1 && fields[1] === 'code' && onRounds === 0) {
    const fallback = declarations[0];
    const evidence = FALLBACK_LINE.exec(fallback)?.[1];
    if (evidence && VISIBLE_EVIDENCE.test(evidence) && !INVISIBLE_EVIDENCE.test(evidence)
      && lines.find((line) => line.trim() !== '') === reviewLines[0] && detailsBalancedBeforeReview(text)) {
      return { settled: true, fallback };
    }
  }
  return { settled: false, fallback: undefined };
};

// The values of the write-up's `<label>:` lines; a write-up with none is unreadable, never clear.
const lineValues = (text, label, source) => {
  const values = [...text.matchAll(new RegExp(`^${label}:[ \\t]*(.*?)[ \\t]*$`, 'gm'))].map((match) => match[1]);
  if (values.length === 0) throw new Error(`${source} has no ${label}: line`);
  return values;
};
// The commit the write-up's one `Reviewed commit: C` line in its Evidence section names, C a full commit ID, or
// undefined where that section has no such line, more than one, or one in any other form. `text` is already readable.
const reviewedCommit = (text, source) => {
  const lines = (sectionLines(text, 'Evidence', source) ?? []).filter((line) => line.trimStart().startsWith('Reviewed commit:'));
  const commit = lines.length === 1 ? /^Reviewed commit: (\S+)$/.exec(lines[0].trimEnd())?.[1] : undefined;
  return commit !== undefined && COMMIT.test(commit) ? commit : undefined;
};
// The refusal a Herdr publication of `head` meets where `source` names, as `reviewed`, no single reviewed commit or
// another commit, or undefined where it names `head`.
const reviewLapse = (source, reviewed, head) => {
  if (reviewed === undefined) return `publishes only the head its review named, and ${source} names no single Reviewed commit line in ## Evidence`;
  return reviewed === head ? undefined : `publishes only the head its review named: the review covered ${reviewed}, not ${head}`;
};
// A line reading `none`, with an optional final full stop, is clear; any other value is not.
const isNone = (value) => /^none\.?$/i.test(value);
const SAVED_WRITE_UP = 'the saved write-up';

// The reasons a write-up holds finished work for the owner, in WAIT_REASONS order. `body` is the write-up and
// `screenshots` the names of the screenshot files saved in its review folder. Pure: it reads nothing, and throws,
// naming the write-up as `source` and what is missing, for a write-up it cannot read: no Failed, Untested or Undo line,
// an Undo answer that is not easy or hard, no Not done section, a Review or Not done section given twice or under a
// heading in any other form than `## <name>`, an Evidence section given twice or under another heading, or an HTML
// comment with no closing `-->` anywhere, inline code and fenced blocks included.
export function waitReasons(body, screenshots, source = SAVED_WRITE_UP) {
  return assessReviewBody(body, screenshots, source).reasons;
}

function assessReviewBody(body, screenshots, source = SAVED_WRITE_UP) {
  if (body.replace(HTML_COMMENT, '').includes('<!--')) throw new Error(`${source} has an unclosed HTML comment`);
  const text = readable(body);
  const failed = lineValues(text, 'Failed', source);
  const untested = lineValues(text, 'Untested', source);
  const undo = lineValues(text, 'Undo', source);
  if (!undo.every((value) => /^(?:easy|hard)\b/.test(value))) throw new Error(`${source} has an Undo: line that is neither easy nor hard`);
  const notDone = sectionLines(text, 'Not done', source);
  if (notDone === undefined) throw new Error(`${source} has no Not done section`);
  // Read for its throw: a doubled or misheaded Evidence section is unreadable, so saysNoVisualChange reads the one safely.
  sectionLines(text, 'Evidence', source);
  const { settled, fallback } = reviewSettled(text, source);
  const onScreen = !saysNoVisualChange(text);
  const held = new Set();
  if (!failed.every(isNone) || !untested.every(isNone) || !settled) held.add('check');
  if (screenshots.length === 0 && onScreen) held.add('screenshot');
  if (notDone.join('\n').trim() !== 'Nothing') held.add('beyond-card');
  if (/^Review: tier=sign-off /m.test(text)) held.add('sign-off');
  if (undo.some((value) => value.startsWith('hard'))) held.add('hard-to-undo');
  return { reasons: WAIT_REASONS.filter((reason) => held.has(reason)), fallback, onScreen, reviewed: reviewedCommit(text, source) };
}

// The screenshot files among `names`, in numeric order.
const screenshotNames = (names) => names.filter((name) => SCREENSHOT.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

// Replaced screenshots need new attachments even when their names stayed the same.
function unattachedAlt(published, screenshots, hashes) {
  const alts = new Set([...published.matchAll(UPLOADED_IMAGE_ALT)].map((image) => image[1]));
  return screenshots.map((name, at) => `${name.slice(0, name.lastIndexOf('.'))} ${hashes[at]}`).find((alt) => !alts.has(alt));
}

// The published body of pull request #`number`, or a throw naming why it could not be read.
function publishedBody(number, exec) {
  let body;
  try {
    body = JSON.parse(exec(['pr', 'view', number, '--json', 'body'])).body;
  } catch (error) {
    throw new Error(`could not read the published body of pull request #${number}: ${/** @type {Error} */ (error).message}`);
  }
  if (!isText(body)) throw new Error(`the published body of pull request #${number} is not text`);
  return body;
}

// The review folder of card `card` at `head`, relative to the session's working directory, where the saved card is.
const reviewFolder = (card, head) => `.claude/worklog/job_${card}-review-${head}`;

// Read the saved card's review folder, screenshot names and body assessment for the given head.
function savedCard(card, cwd, head) {
  const folder = reviewFolder(card, head);
  let writeUp;
  let names;
  try {
    writeUp = readFileSync(join(cwd, folder, 'body.md'), 'utf8');
    names = readdirSync(join(cwd, folder));
  } catch (error) {
    throw new Error(`${folder} holds no readable saved write-up (${/** @type {NodeJS.ErrnoException} */ (error).code ?? /** @type {Error} */ (error).message})`);
  }
  const screenshots = screenshotNames(names);
  return { folder, screenshots, ...assessReviewBody(writeUp, screenshots) };
}

// The identity of the saved card of card `card` at `head` in `cwd`: the `git hash-object --no-filters` values of its
// body.md and then each screenshot in numeric order, comma-joined as the Waiting version line writes them. `git` runs
// in `cwd`. It throws for a folder it cannot read.
export function savedIdentity(card, cwd, head, git) {
  const folder = reviewFolder(card, head);
  const files = ['body.md', ...screenshotNames(readdirSync(join(cwd, folder)))];
  return git(['hash-object', '--no-filters', '--', ...files.map((name) => `${folder}/${name}`)]).trim().split(/\r?\n/).join(',');
}

// The reasons the saved card of card `card` at `head` in `cwd` holds, with what wait level `level` and the marker,
// `marked`, add, as withHolds gives them, in Herdr mode where `herdr` is set; no published body is read. It throws as
// savedCard does.
export function folderReasons(card, cwd, head, { level, marked, herdr }) {
  const { reasons, onScreen } = savedCard(card, cwd, head);
  return withHolds(reasons, { level, onScreen, marked, herdr });
}

// The reasons the saved write-up of card `card` at HEAD in `cwd` holds its finished work for the owner, as waitReasons
// gives them, read from the review folder `.claude/worklog/job_<card>-review-<head>/` with its `screenshot-<n>` files.
// Given `pull`, { number, headRefOid }, its head must be HEAD, the reasons waitReasons finds in its published body, read
// once, hold too, since the owner and the review read that body. A mismatch in fallback declarations also holds
// under check. Work on screen, declared by either copy, waits under screenshot while an image
// `screenshot-<k> <hash>` of the folder is missing from that body, as unattachedAlt reads it. The work is on screen
// where the write-up, or given `pull` either copy, does not say no visual change. withHolds adds what wait level
// `level` and whether the card carries the marker, `marked`, hold, in Herdr mode where `herdr` is set. It throws for a
// folder with no readable write-up, a head other than HEAD, a published body it cannot fetch, or a write-up or
// published body waitReasons cannot read.
/** @type {(card, cwd, runners: { git, exec? }, pull, options: { level, marked, herdr?: boolean }) => string[]} */
export function heldReasons(card, cwd, { git, exec }, pull, { level, marked, herdr }) {
  const head = git(['rev-parse', 'HEAD']).trim();
  if (pull && pull.headRefOid !== head) throw new Error(`pull request #${pull.number} head ${pull.headRefOid} does not match the checked HEAD ${head}`);
  const saved = savedCard(card, cwd, head);
  if (!pull) return withHolds(saved.reasons, { level, marked, herdr, onScreen: saved.onScreen });
  const published = publishedBody(pull.number, exec);
  return pullReviewHolds(saved, published, pull.number, { level, marked, herdr }, () =>
    git(['hash-object', '--no-filters', '--', ...saved.screenshots.map((name) => `${saved.folder}/${name}`)]).trim().split(/\r?\n/));
}

function pullReviewHolds(saved, published, number, { level, marked, herdr }, screenshotHashes) {
  const { reasons, screenshots } = saved;
  const publishedReview = assessReviewBody(published, screenshots, `the published body of pull request #${number}`);
  const held = new Set([...reasons, ...publishedReview.reasons]);
  if (saved.fallback !== publishedReview.fallback) held.add('check');
  const onScreen = saved.onScreen || publishedReview.onScreen;
  if (screenshots.length > 0 && onScreen && unattachedAlt(published, screenshots, screenshotHashes()) !== undefined) held.add('screenshot');
  return withHolds(held, { level, onScreen, marked, herdr });
}

// The bytes of `file`, refused unless it is a regular file with one link, opened without following a link, no larger
// than MAX_OUTPUT_BYTES and unchanged while it is read; a throw names the file and why.
export function boundedBytes(file) {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const entry = fstatSync(descriptor);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_OUTPUT_BYTES) throw new Error('expected a bounded regular file');
    const bytes = readFileSync(descriptor);
    const current = lstatSync(file);
    if (bytes.length !== entry.size || entry.dev !== current.dev || entry.ino !== current.ino || entry.ctimeMs !== current.ctimeMs) {
      throw new Error('file changed during capture');
    }
    return bytes;
  } catch (error) {
    throw new Error(`${file} is unreadable: ${/** @type {Error} */ (error).message}`);
  } finally {
    closeSync(descriptor);
  }
}

// Hash the bytes already captured for the review, without asking Git to reopen the saved files.
function deliveryReview(card, cwd, head, git, objects) {
  const format = git(['rev-parse', '--show-object-format']).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('unreadable Git object format for the native delivery version');
  const width = format === 'sha1' ? 40 : 64;
  if (!objects.every((id) => isText(id) && COMMIT.test(id) && id.length === width)) {
    throw new Error('native delivery version has a missing or unreadable full Git object ID');
  }
  const folder = join(cwd, reviewFolder(card, head));
  if (realpathSync.native(folder) !== folder || !lstatSync(folder).isDirectory()) {
    throw new Error(`${folder} is not a physical saved review directory`);
  }
  const bodyFile = join(folder, 'body.md');
  const body = boundedBytes(bodyFile);
  let writeUp;
  try {
    writeUp = STRICT_UTF8.decode(body);
  } catch {
    throw new Error(`saved write-up ${bodyFile} is not valid UTF-8`);
  }
  const screenshots = screenshotNames(readdirSync(folder));
  if (width + screenshots.length * (width + 1) > MAX_REVIEW_HASH_BYTES) throw new Error('saved review holds more screenshots than its size limit allows');
  const blob = (bytes) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const hashes = screenshots.map((name) => blob(boundedBytes(join(folder, name))));
  if (realpathSync.native(folder) !== folder) throw new Error(`${folder} changed during saved review capture`);
  return { ...assessReviewBody(writeUp, screenshots), screenshots, hashes };
}

// Whether the owner's recorded answer lets pull request head `head` of card `card` mark ready or merge while the wait
// reasons `held` hold, judged from the card read `read`, whose comments come oldest first: undefined where it does, ''
// where no answer holds for the acting account, as newestOwnerAnswer reads it, and otherwise
// `, and ` then why not. That answer must name the identity of the saved card at the head it answers, and admits that
// head only where every reason held is one that saved card holds, as folderReasons reads it at wait level `level`, so a
// reason only the published body adds still holds. It admits a later head only where the card does not carry the
// show-me-first label, `marked`, read now since no record says whether the card carried it when the owner answered; a
// later fix line by that account names that head and the head answered; the head answered is an ancestor of it; and no
// reason held there is check or failed to hold at the head answered, as folderReasons reads that head. `git` runs in
// `cwd`, and a failed ancestor read throws. A Herdr job never asks: only its card's marker holds it.
function answerLapse(card, { login, issue }, { cwd, git, head, held, level, marked }) {
  const lapse = (why) => `, and ${why}`;
  const newest = newestOwnerAnswer(card, issue.comments.nodes, login);
  if (!newest) return '';
  const { at, answer } = newest;
  const source = `the newest owner answer on card ${card}`;
  let identity;
  try {
    identity = savedIdentity(card, cwd, answer.head, git);
  } catch {
    // An unreadable saved card names nothing.
  }
  if (identity !== answer.identity) return lapse(`${source} does not name the saved card at ${answer.head}`);
  if (answer.head !== head) {
    if (marked) return lapse(`card ${card} asks to see every version first, so the fix at ${head} needs an owner answer of its own`);
    const fixed = issue.comments.nodes.slice(at + 1).some((comment) => {
      const record = comment.author?.login === login ? cardRecord(comment.body, card) : undefined;
      return record?.kind === 'fix' && record.head === head && record.from === answer.head;
    });
    if (!fixed) return lapse(`the newest owner answer on card ${card} names ${answer.head}, and no fix built from it by ${login} names ${head}`);
    // Git exits 0 where the first commit is an ancestor of the second, and 1 where it is not.
    try {
      git(['merge-base', '--is-ancestor', answer.head, head]);
    } catch (error) {
      if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
      return lapse(`${answer.head}, which the newest owner answer on card ${card} names, is not an ancestor of ${head}`);
    }
    if (held.includes('check')) return lapse(`the fix at ${head} has failed, untested or unsettled evidence`);
  }
  const answered = folderReasons(card, cwd, answer.head, { level, marked, herdr: false });
  if (held.every((reason) => answered.includes(reason))) return undefined;
  return lapse(answer.head === head
    ? `the saved card ${source} names does not hold every wait reason that holds for HEAD`
    : `the fix at ${head} holds a wait reason that did not hold at ${answer.head}`);
}

// The version deliver.md's squash showed, read in the session checkout by `git` with replacement refs disabled, as the
// pre-push gate reads them: { head, tree, base, squash } where HEAD has the tree of ORIG_HEAD and one parent, fetched
// main, which must be an ancestor of ORIG_HEAD. A mismatch returns { why }. Where the
// worktree has no ORIG_HEAD file Git resolves a ref of that name, or refs/remotes/ORIG_HEAD/HEAD, instead, so a ref of
// exactly one of those names refuses; any other ref below one, such as refs/heads/ORIG_HEAD/notes, is not one Git
// resolves. Git exits 1 where ORIG_HEAD names no commit and where the parent is not an ancestor; any other failed read throws.
function squashedVersion(git) {
  const read = (...args) => git(['--no-replace-objects', ...args]).trim();
  const names = ['refs/ORIG_HEAD', 'refs/tags/ORIG_HEAD', 'refs/heads/ORIG_HEAD', 'refs/remotes/ORIG_HEAD', 'refs/remotes/ORIG_HEAD/HEAD'];
  if (read('for-each-ref', '--format=%(refname)', ...names).split(/\r?\n/).some((line) => names.includes(line))) {
    return { why: 'a ref named ORIG_HEAD exists, so ORIG_HEAD is ambiguous' };
  }
  let head;
  try {
    head = read('rev-parse', '--verify', '--quiet', 'ORIG_HEAD^{commit}');
  } catch (error) {
    if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
    return { why: 'there is no ORIG_HEAD, so no version it showed' };
  }
  const [squash, ...parents] = read('rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
  if (parents.length !== 1) return { why: `HEAD has ${parents.length} parents, not one` };
  const [parent] = parents;
  const fetched = read('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}');
  if (parent !== fetched) return { why: `HEAD's parent ${parent} is not fetched main ${fetched}` };
  const [pushed, shown] = read('rev-parse', 'HEAD^{tree}', `${head}^{tree}`).split(/\r?\n/);
  if (pushed !== shown) return { why: `HEAD's tree is not the tree of ${head}` };
  try {
    git(['--no-replace-objects', 'merge-base', '--is-ancestor', parent, head]);
  } catch (error) {
    if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
    return { why: `fetched main ${parent} is not an ancestor of ${head}` };
  }
  return { head, tree: shown, base: parent, squash };
}

// Why the pre-push gate on the remote's main would not judge a push from the session checkout, read by `git` from any
// folder inside it, or undefined where it would: Git runs the pre-push hook from core.hooksPath, relative to the
// worktree top, exactly as set, read with --null so only the one NUL Git ends it with is removed, so that must be
// .githooks, HEAD's .githooks fetched main's, the top's working-tree .githooks unchanged and, off Windows, where Git
// runs only a hook the session user may execute, the top's pre-push `executable`. Unchanged is judged by bytes and
// modes, never by Git's index, whose stat, assume-unchanged, skip-worktree and monitor answers a checkout's settings
// can make report an edit clean: fetched main's .githooks, listed with --full-tree so from any folder, must hold only
// regular files, `listHooks` must find the same names at the top, each a regular file and, off Windows, where Git
// records the execute bit from disk, executable exactly where fetched main's mode is 100755, and hash-object
// --no-filters must give each the oid fetched main's tree holds. Git exits 1 where core.hooksPath is unset; any other
// failed read throws.
function gateLapse(git, { platform, executable, listHooks }) {
  let hooksPath;
  try {
    hooksPath = git(['config', '--null', '--get', 'core.hooksPath']).replace(/\0$/, '');
  } catch (error) {
    if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
  }
  if (hooksPath !== '.githooks') return 'core.hooksPath is not .githooks';
  const [pushed, fetched] = git(['--no-replace-objects', 'rev-parse', 'HEAD:.githooks', 'refs/remotes/origin/main:.githooks']).trim().split(/\r?\n/);
  if (pushed !== fetched) return "HEAD's .githooks is not fetched main's";
  const top = git(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
  // Under -z each entry is `<mode> <type> <oid>\t<name>` ended by a NUL, the name unquoted and slash-separated.
  const tree = git(['--no-replace-objects', 'ls-tree', '--full-tree', '-r', '-z', 'refs/remotes/origin/main:.githooks']).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    return { mode, type, oid, name: entry.slice(tab + 1) };
  });
  if (tree.some(({ mode, type }) => type !== 'blob' || (mode !== '100644' && mode !== '100755'))) return ".githooks is not fetched main's";
  const folder = join(top, '.githooks');
  const disk = listHooks(folder);
  const modes = new Map(tree.map(({ name, mode }) => [name, mode]));
  if (disk.some(({ file }) => !file) || disk.length !== modes.size || !disk.every(({ name }) => modes.has(name))) return '.githooks has uncommitted changes';
  if (platform !== 'win32' && disk.some(({ name, executable: bit }) => bit !== (modes.get(name) === '100755'))) return '.githooks has uncommitted changes';
  const hashed = git(['hash-object', '--no-filters', '--', ...tree.map(({ name }) => join(folder, ...name.split('/')))]).split(/\r?\n/);
  if (tree.some(({ oid }, index) => hashed[index] !== oid)) return '.githooks has uncommitted changes';
  if (platform !== 'win32' && !executable(join(top, '.githooks', 'pre-push'))) return '.githooks/pre-push is not executable';
  return undefined;
}

// Whether `path` is a file the session user may execute, as Git asks before running a hook; a missing file is not.
function isExecutable(path) {
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Every entry below `folder` other than a folder, with its slash-separated name relative to `folder`, whether it is a
// regular file and, for a regular file, whether its owner execute bit is set, the bit Git records as mode 100755; a
// symbolic link is listed, never followed, so it is not a file, and a `folder` that is not a directory, a link to one
// included, is listed as one unnamed entry that is not a file.
function readHooks(folder) {
  if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) return [{ name: '', file: false }];
  const walk = (at, prefix) => readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const path = join(at, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return walk(path, `${name}/`);
    return entry.isFile() ? [{ name, file: true, executable: (lstatSync(path).mode & 0o100) !== 0 }] : [{ name, file: false }];
  });
  return walk(folder, '');
}

function readPinnedPull(number, origin, exec) {
  const [owner, name] = origin.nameWithOwner.split('/');
  const reply = JSON.parse(exec(['api', 'graphql', '-f', `query=${PINNED_PULL_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]));
  const repository = reply?.data?.repository;
  const pull = repository?.pullRequest;
  if (reply?.errors !== undefined || repository?.id !== origin.id || pull?.number !== Number(number)) {
    throw new Error(`could not verify pull request #${number} in origin ${origin.nameWithOwner}`);
  }
  return pull;
}

function requiredChecksLapse(number, baseRefName, exec) {
  try {
    const { classic, ruled } = readRequiredSet(baseRefName, exec);
    if (ruled.some((entry) => typeof entry !== 'string')) return 'a ruleset does not name every required check';
    const { checks, unreported } = parseRequiredReports(exec(requiredCheckArgs(number)), new Set([...classic, ...ruled]));
    if (checks.some(({ link }) => !isText(link))) return 'required checks returned an unreadable link';
    if (unreported.length) return `required checks have not reported: ${unreported.join(', ')}`;
    const unresolved = checks.find(({ bucket }) => bucket !== 'pass' && bucket !== 'skipping');
    if (unresolved) return `required check ${unresolved.name} is ${unresolved.bucket}`;
    return '';
  } catch (error) {
    return `could not verify required checks: ${/** @type {Error} */ (error).message}`;
  }
}

/** @typedef {{ worktree: string, card: number, repositoryId: string, runStart: string }} CodexDeliveryBinding */
/** @typedef {{ env?: NodeJS.ProcessEnv, exec?, git?, platform?: NodeJS.Platform, exists?: typeof existsSync, executable?: (path: string) => boolean, listHooks?: (folder: string) => { name: string, file: boolean, executable?: boolean }[] }} PublicationObservations */
/** @typedef {PublicationObservations & { start, tracker, boundCard?, coordinated?: boolean, appJob?, codexHerdr?: CodexDeliveryBinding, pinnedMerge?: { head: string, number: string }, pinnedSource?: string, workflowPin?: WorkflowPin, cwd }} PublicationOptions */

// The guard checks its existing route restrictions before accepting held work on its runtime's approval witness.
// Withdrawal to draft need not satisfy the publication policy.
/** @type {(kind, segment, options: PublicationOptions) => string} */
export function publishCheck(kind, segment, options) {
  return publicationDecision(kind, segment, options);
}

/** @param {string} kind @param {string} segment @param {PublicationOptions} options @returns {string} */
function publicationDecision(kind, segment, { start, tracker, boundCard, coordinated = false, appJob, codexHerdr, pinnedMerge, pinnedSource, workflowPin,
  env = process.env, exec, git, platform = process.platform, exists = existsSync, executable = isExecutable, listHooks = readHooks, cwd }) {
  const refuse = (why) => `${REFUSAL}${why}`;
  if (tracker !== 'github') return refuse(`publishes nothing: ${trackerLine(tracker)}`);
  const named = ['GH_REPO', 'GH_HOST'].find((name) => env[name] !== undefined);
  if (named) return refuse(`publishes nothing with ${named} set: gh would act on what it names, not on origin`);
  if (!RUN_START.test(start) || Number.isNaN(Date.parse(start))) {
    return refuse(`publishes nothing: its mark ${JSON.stringify(start)} is not a run start written YYYY-MM-DDTHH:MM:SSZ`);
  }
  try {
    const lookup = { platform, env, exists };
    const gitEnv = codexHerdr ? { ...env, GIT_NO_REPLACE_OBJECTS: '1' } : env;
    const gitPath = git ? null : gitExecutable(lookup);
    const gitAt = (at) => git ?? defaultRunner(gitPath, 'git.exe', { cwd: at, env: gitEnv });
    let readCwd = cwd;
    if (codexHerdr) {
      try {
        const top = gitAt(cwd)(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
        if (realpathSync.native(top) !== codexHerdr.worktree) return refuse('publishes only from its bound worktree');
        readCwd = codexHerdr.worktree;
      } catch {
        return refuse('could not verify its bound worktree');
      }
    }
    const runners = {
      git: gitAt(readCwd),
      exec: exec ?? defaultRunner(ghExecutable(lookup), 'gh.exe', { cwd: readCwd, env, strictUtf8: !!codexHerdr }),
    };
    const head = runners.git(appJob ? ['symbolic-ref', '--quiet', 'HEAD'] : ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    if (appJob && head !== `refs/heads/job/${appJob.card}`) return refuse('publishes only its bound card');
    const card = appJob ? String(appJob.card) : /^job\/([1-9]\d*)$/.exec(head)?.[1];
    if (!card) return refuse(`publishes only from a job branch, and HEAD is ${JSON.stringify(head)}`);
    if ((boundCard !== undefined && card !== boundCard) || (codexHerdr && card !== String(codexHerdr.card))) {
      return refuse('publishes only its bound card');
    }
    if (codexHerdr && start !== codexHerdr.runStart) return refuse('publishes only during its bound run');
    const pushes = [`git push -u origin job/${card}`, `git push --force-with-lease origin job/${card}`];
    const legacyDirect = !codexHerdr && coordinated;
    const direct = kind === 'push' && (codexHerdr ? pinnedSource !== undefined : legacyDirect && segment === 'git push origin HEAD:main');
    if (kind === 'push' && !direct && !pushes.includes(segment)) {
      const mainForm = codexHerdr ? ' or main as `git push --no-follow-tags origin <squash>^{object}:refs/heads/main`'
        : legacyDirect ? ' or main as `git push origin HEAD:main`' : '';
      return refuse(`pushes only its own branch, as ${pushes.join(' or ')}${mainForm}`);
    }
    if (appJob && !codexHerdr) {
      try {
        const topLevel = runners.git(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
        if (realpathSync.native(topLevel) !== appJob.worktree) return refuse('publishes only from its bound worktree');
      } catch {
        return refuse('could not verify its bound worktree');
      }
    }
    const origin = originRepository(runners);
    if (codexHerdr && origin.id !== codexHerdr.repositoryId) return refuse('publishes only in its bound origin repository');
    const acting = JSON.parse(runners.exec(['repo', 'view', '--json', 'id']));
    if (acting?.id !== origin.id) return refuse(`publishes only where gh acts on origin, ${origin.nameWithOwner}, and here it acts on ${JSON.stringify(acting?.id)}`);
    // Git exits 1 with no output where these configuration keys are unset; any other failure refuses.
    if (kind === 'push') {
      let refspecs = '';
      try {
        refspecs = runners.git(['config', '--get-all', 'remote.origin.push']).trim();
      } catch (error) {
        if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
      }
      if (refspecs) return refuse(`pushes nothing while remote.origin.push is set, since it can send the push to another branch: ${refspecs.split(/\r?\n/).join(', ')}`);
    }
    if (kind === 'create') {
      let mergeBase;
      try {
        mergeBase = runners.git(['config', '--get', `branch.job/${card}.gh-merge-base`]).trim();
      } catch (error) {
        if (/** @type {{ status?: number | null }} */ (error).status !== 1) throw error;
      }
      if (mergeBase !== undefined) return refuse(`opens a pull request only into the default branch, and branch.job/${card}.gh-merge-base is set: ${mergeBase}`);
    }
    // A Herdr job, Claude Code's coordinated one or Codex's bound one, ignores the wait level: only the marker holds it.
    // It marks ready and merges only on its exact pull request.
    const herdr = coordinated || !!codexHerdr;
    let number;
    let pr;
    if (kind === 'ready' || kind === 'merge') {
      const undo = /(?:^|\s)--undo(?:\s|$)/.test(segment);
      const exact = herdr && !undo;
      number = pinnedMerge?.number ?? /** @type {RegExpExecArray} */ (/\d+/.exec(segment))[0];
      if (exact && (!Number.isSafeInteger(Number(number)) || Number(number) < 1)) {
        return refuse('acts only on its own pull request with a positive safe decimal number');
      }
      pr = exact ? readPinnedPull(number, origin, runners.exec)
        : JSON.parse(runners.exec(['pr', 'view', number, '--json', 'state,headRefName,baseRefName,headRepository,isCrossRepository,headRefOid']));
      if (pr?.state !== 'OPEN' || pr.headRefName !== `job/${card}` || pr.headRepository?.id !== origin.id || pr.isCrossRepository !== false) {
        return refuse(`acts only on its own job pull request: #${number} is not open from job/${card} in ${origin.nameWithOwner}`);
      }
      if (pr.baseRefName !== origin.defaultBranch) {
        return refuse(`acts only on its own job pull request into the default branch: #${number} targets ${pr.baseRefName}, not ${origin.defaultBranch}`);
      }
      // Taking its own pull request back to draft reads no setting, card or write-up, so work can always be
      // withdrawn, whatever holds it.
      if (undo) return '';
      if (exact) {
        if (pr.isDraft !== (kind === 'ready')) return refuse(`acts only on its own ${kind === 'ready' ? 'draft' : 'ready'} pull request: #${number} has a different draft state`);
        if (!isText(pr.headRefOid) || !COMMIT.test(pr.headRefOid) || (pinnedMerge && pr.headRefOid !== pinnedMerge.head)) {
          return refuse(`acts only on a pull request with a matching full head commit: #${number} has a different or unreadable head`);
        }
        if (!isText(pr.baseRefOid) || !COMMIT.test(pr.baseRefOid)) {
          return refuse(`acts only on a pull request with a readable full base commit: #${number} has an unreadable base`);
        }
        if (pr.isInMergeQueue !== false || pr.isMergeQueueEnabled !== false) {
          return refuse(`acts only on a pull request with no active or enabled merge queue: #${number} has a different or unreadable queue state`);
        }
        if (pr.autoMergeRequest !== null) return refuse(`acts only on a pull request with no auto-merge: #${number} has an active or unreadable auto-merge state`);
      }
    }
    const { waitForOwner: level, oid: settingsBase } = (herdr ? readFetchedSettings : deliverySettings)({ git: runners.git, workflowPin });
    let read;
    try {
      read = readCard(card, { exec: runners.exec, repository: origin, complete: !!codexHerdr });
    } catch (error) {
      return refuse(`could not read card ${card}: ${/** @type {Error} */ (error).message}`);
    }
    const ineligible = cardIneligibility(read.issue);
    if (ineligible) return refuse(`publishes nothing: ${ineligible}`);
    const newest = read.issue.comments.nodes.findLast((comment) => isClaim(comment.body));
    const unclaimed = claimLapse(card, read.login, newest, start);
    if (unclaimed) return refuse(`publishes only a card its GitHub account claimed during this run, and ${unclaimed}, so the card waits for the owner's yes`);
    if (kind === 'ready' || kind === 'merge') {
      const marked = cardMarked(card, read.issue);
      const policy = { level, marked, herdr };
      const heldAction = `${kind === 'ready' ? 'marks ready' : 'merges'} nothing while a wait reason holds for HEAD`;
      if (herdr) {
        const localHead = runners.git(['rev-parse', 'HEAD']).trim();
        if (pr.headRefOid !== localHead) throw new Error(`pull request #${number} head ${pr.headRefOid} does not match the checked HEAD ${localHead}`);
        const shown = { head: localHead, base: pr.baseRefOid };
        const review = deliveryReview(card, readCwd, localHead, runners.git, [localHead, shown.base]);
        const published = publishedBody(number, runners.exec);
        if (!published.isWellFormed()) throw new Error(`the published body of pull request #${number} is not valid UTF-8`);
        // The saved write-up and the published body each name the one commit their review covered, and it is HEAD.
        const publishedSource = `the published body of pull request #${number}`;
        const lapse = reviewLapse(SAVED_WRITE_UP, review.reviewed, localHead)
          ?? reviewLapse(publishedSource, reviewedCommit(readable(published), publishedSource), localHead);
        if (lapse) return refuse(lapse);
        const holds = pullReviewHolds(review, published, number, policy, () => review.hashes);
        const savedHolds = withHolds(review.reasons, { ...policy, onScreen: review.onScreen });
        if (holds.some((reason) => !savedHolds.includes(reason))) {
          return refuse(`${heldAction}: ${holds.join(', ')}, and the published body adds a wait reason absent from the saved review`);
        }
        if (holds.length) return refuse(`${heldAction}: ${holds.join(', ')}`);
      } else {
        const held = heldReasons(card, cwd, runners, { number, headRefOid: pr.headRefOid }, policy);
        if (held.length > 0) {
          const lapse = answerLapse(card, read, { cwd, git: runners.git, head: pr.headRefOid, held, level, marked });
          if (lapse !== undefined) return refuse(`${heldAction}: ${held.join(', ')}${lapse}`);
        }
      }
      if (pinnedMerge) {
        const lapse = requiredChecksLapse(number, pr.baseRefName, runners.exec);
        if (lapse) return refuse(`merges only after all required checks pass or skip: ${lapse}`);
      }
    }
    if (direct) {
      const shown = squashedVersion(runners.git);
      if ('why' in shown && shown.why !== undefined) return refuse(`pushes main only as the one commit deliver.md squashes from the version it showed: ${shown.why}`);
      if (pinnedSource !== undefined && (!('squash' in shown) || shown.squash !== pinnedSource)) {
        return refuse('pushes main only when the literal source object matches the checked-out squash');
      }
      if (codexHerdr && shown.base !== settingsBase) return refuse('pushes main only while the reviewed base matches the fetched main used for delivery policy');
      const ungated = gateLapse(runners.git, { platform, executable, listHooks });
      if (ungated !== undefined) return refuse(`pushes main only where the pre-push hook on the remote's main judges it: ${ungated}`);
      const marked = cardMarked(card, read.issue);
      const heldAction = `pushes nothing to main while a wait reason holds for ${shown.head}`;
      const review = codexHerdr
        ? deliveryReview(card, readCwd, shown.head, runners.git, [shown.head, shown.tree, shown.base, shown.squash])
        : savedCard(card, cwd, shown.head);
      // The saved write-up of the version the squash was made from names that version as the one its review covered.
      const lapse = herdr ? reviewLapse(SAVED_WRITE_UP, review.reviewed, shown.head) : undefined;
      if (lapse) return refuse(lapse);
      const holds = withHolds(review.reasons, { level, marked, herdr, onScreen: review.onScreen });
      if (holds.length) return refuse(`${heldAction}: ${holds.join(', ')}`);
    }
    if (kind === 'push') {
      // GitHub keeps a queued auto-merge after a push by someone with write access, so a commit pushed to a pull
      // request that is ready or has its merge queued would merge without heldReasons judging it; a fork's pull request
      // is skipped, since pushing this repository's branch cannot update its head; gh lists 30 by default, so a full
      // reply may be cut short.
      const open = JSON.parse(runners.exec(['pr', 'list', '--head', `job/${card}`, '--state', 'open', '--json', 'number,isDraft,autoMergeRequest,isCrossRepository', '--limit', '100']));
      if (!Array.isArray(open) || !open.every((pull) => Number.isInteger(pull?.number) && typeof pull.isDraft === 'boolean' && pull.autoMergeRequest !== undefined && typeof pull.isCrossRepository === 'boolean')) {
        throw new Error(`unreadable list of open pull requests from job/${card}`);
      }
      if (open.length >= 100) {
        throw new Error(`unreadable list of open pull requests from job/${card}: a reply of 100 may be cut short`);
      }
      const live = open.find((pull) => !pull.isCrossRepository && (!pull.isDraft || pull.autoMergeRequest !== null))?.number;
      if (live !== undefined) {
        return refuse(`pushes nothing while pull request #${live} is ready or has a merge queued, since GitHub would merge the pushed commit unjudged: take it back to draft with \`gh pr ready ${live} --undo\` first, and where its merge stays queued the owner turns it off with \`gh pr merge --disable-auto ${live}\``);
      }
    }
    return '';
  } catch (error) {
    return refuse(`publishes nothing: ${/** @type {Error} */ (error).message}`);
  }
}
