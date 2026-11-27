// owner-queue.mjs — what waits on the owner in one repository, read once and printed as one JSON document by
// scripts/owner-queue.mjs, the one route by which a queue panel answer writes to a card, the one by which a merge answer
// reaches the coordinator (`relayAnswer`), the one by which its Undo
// takes a put-aside, accepted or rejected card back, the one by which its board moves a card, the one by which it sets
// or removes a card's show-me-first marker, and `report`, the read of one merge's report, which the function's own
// comment describes. `collect` writes nothing. The board reads through board-read.mjs, waiting through `pause` (a real
// wait unless given) before each retry, `run(args)` runs git with
// the repository root as its working folder, `readFile`, `listFolder` and `fileTime` (a file's modified time as an ISO
// string) read the files a job saved, `hostname` is what `hostname` prints on this machine, and `login` is the GitHub
// account `gh api user --jq .login` names (null where it cannot be read or the tracker is not GitHub). Imports are Node
// built-ins, the board toolkit's own modules, the run's card read and state-line writer and the settings validator.
//
// A merge item is an `Awaiting push` card the owner can be shown now, under the facts of the `resume` skill's batch
// review (section 7, "Batch review", step 1): its newest claim names this machine and not `Claude Code cloud`, on a
// Markdown board the intake's claim reads `branch job/<card> (local)` instead, its
// `job/<card>` worktree is here and clean, `.claude/worklog/job_<card>-review-<head>/body.md` exists there for that
// head, a body whose Evidence has no line reading "no visual change" has a screenshot beside it, and, where the card
// body's last line is a `Waiting version:` line, that line names that head and the saved files' identities. A card
// failing a fact is still a merge item, naming the first fact that failed and the owner's next step. A complete merge item
// carries `head` and `identity`, the version it was judged on as a waiting line names it, so a deliver menu offers its yes
// only for the version its job asked about. A merge item carries `reason`, the wait reasons its saved write-up holds, then `on-screen` where fetched main's wait level is on-screen and
// the work is on screen, then `show-me-first` where the card carries that label, in the order of `WAIT_REASONS`,
// semicolon-joined, with `every card waits for you: waitForOwner is always` after them where the level is always; a
// write-up the judge cannot read is a merge item missing that fact, and a level that cannot be read leaves every merge
// item missing it, so no merge is shown clear on a failed read. A question item
// is a card with a comment beginning Needs owner:, whatever its column. Proposed titles fill the suggested category.
// The digest lists the last day's merges to origin/main, as the local clone last fetched it.
//
// A bad read is a problem with its cause. A source that cannot be read (the board, card details, wait level,
// worktree list or digest) is listed in sources with its error and contributes no item. The board is a failed
// source when the GitHub read returned no card or some card's content did not resolve. Details fail when any open
// card's details or comments were not read in whole. Such a card is not classified.
//
//
// Every item carries `version`, `itemVersion` of what the panel shows and what it was drawn from, so `act` writes only
// for the item the panel drew. A suggested item carries `scope`, the body's What to build and Acceptance criteria
// sections, where it has both; a question item carries `heldOn`, the computer its hold's Job sentence names, where
// that sentence can be read. Tracker writes name the configured board repository, read once through
// configuredRepository as writeStateLine reads it, so no
// remote, `GH_REPO` or default repository redirects a call to another repository's issue.
//
// The document's `board` lists every open card of the board, a Done card left out, in the order the board read gave
// them: `card`, `title`, `column` (its Status, or null), `blockers` (the open ones), `claim` (the newest claim's
// `machine` and `runtime`, or null) and `waitsOn` (the category of the card's first queue item, or null), its
// `outcome` (the first paragraph of its What to build section as `text`, with `more` true where lines follow it; null
// where the section is empty, `{ unread }` where it could not be read), its `worktree` (the path the worktree list
// gives for the card's `job/<card>` branch, or null; absent where the worktree list could not be read), on a GitHub
// board its `showFirst` (whether the card carries the show-me-first marker, or `{ unread }` with the cause where its
// labels are not text, so an unread marker is never shown off; present where the details were not read), and its
// `order`, 1-based within its column, only from a GitHub read that left no card out. A card whose details were not read
// has `unread`, the cause, in place of `claim`, `waitsOn` and `outcome`. Without an `order` the board says
// why in `orderUnread`, and `waitsOnUnread` names the unread worktree list, so a
// card's wait is never shown where its source failed. A board that cannot be read is null, never an empty list; its
// cause is in `sources`. The board's `moves` and `places` are true only on a GitHub tracker, the only one
// `moveOnBoard` writes to, and there each card whose details were read carries a `version`, the sha256 of its number,
// title, column, `order` and body, which a move must name so that it writes only for the card the panel drew.
//
// The weekly local retro's pieces close the file: `draftFault`, the one check of a retro card draft; the body
// section the drafts wait in and `retroDrafts`, which reads it back; `fileOnce` and `placeInBacklog`, which file an
// issue no run files twice and place its card without rewriting what the owner has since set; and `fileDraft`, the
// `pick` route. On a GitHub board read with a login, a `Proposed: ` card whose body `retroDrafts` reads is a suggested
// item with `reason`, `writeUp` and `proposals` as `retroFields` says, and never `scope`, so `keep` stays refused.

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { main as moveCard } from '../board-move.mjs';
import { COMMIT_TEXT, HERDR_HOLDS, HTML_COMMENT, readable, readCard, readWaitLevel, REPLY_MAX, redact, saysNoVisualChange, SCREENSHOT, SHOW_FIRST, showFirstAmong, waitReasons, withBodyFile, withHolds } from './merge-evidence.mjs';
import { addIssueToBoard } from './board-add.mjs';
import * as boardConfig from './board-config.mjs';
import { lookupIssueBoardItem, moveCards, optionIdFor, parseSingleSelectField, placeCardAfter, singleSelectFieldQuery } from './board-move.mjs';
import { isContentUnresolved, newestClaim, normalizeItem, whatToBuildSection } from './board.mjs';
import { isFailedEmptyRead, readBoard, readDetails } from './board-read.mjs';
import { detailUnread } from './board-rules.mjs';
import { failureReport, isGitHubLogin } from './gh-exec.mjs';
import { bodyRevisions, configuredRepository, lastStateLine, readWholeCard, withLine, writeStateLine } from './pre-approved-run.mjs';
import { readSettingsHeader, SETTINGS_PATH } from './runtimes.mjs';
import { cardRef, kindTypesOf } from './tracker.mjs';

const { KIND_LABELS, ROUTING_FIELD, ROUTING_OPTIONS, TERMINAL_STATUSES } = boardConfig;

export { REPLY_MAX, redact };
export const FORMAT = 1;
const CAUSE_LIMIT = 2000;
const AWAITING_PUSH = 'Awaiting push';
const PROPOSED = 'Proposed: ';
const CLOUD_RUNTIME = 'Claude Code cloud';
const DECISION_CARD_OPEN = '<summary>Decision card</summary>';
const EMPTY_BOARD = 'the board read returned no cards: an auth, network or project problem, not an empty board';
const NO_WAITING_VERSION = 'its card names no waiting version matching its job\'s current version';
const FINISH_OR_REOPEN = 'Finish any change request in chat, or reopen the job\'s session on this machine.';
// The panel's actions; any other answer is the chat's.
export const ACTIONS = ['park', 'answer', 'keep', 'drop', 'pick'];
// Undo takes back these panel actions. A coordinator may already have read a sent answer, and a picked card is
// closed in its own project.
export const UNDOABLE = ['park', 'keep', 'drop'];
// The panel's board moves: a Backlog card to Ready, a Ready card back to Backlog, a Ready card one rank up, and a Ready
// card to a 1-based place in the build order.
export const MOVES = ['ready', 'backlog', 'up', 'place'];
// The states of a card's show-me-first marker the panel writes, and the columns whose cards it writes it on.
export const SHOW_FIRST_STATES = ['on', 'off'];
const SHOW_FIRST_COLUMNS = ['Ready', 'In progress', 'In review', 'Awaiting push'];
const TAKEN = { park: 'put aside', keep: 'accepted', drop: 'rejected' };
const PARKED_LINE = 'Parked: from the queue panel';
const GITHUB_ONLY = 'the queue panel writes only to a GitHub board: answer in chat';
const MOVES_GITHUB_ONLY = 'the panel moves cards only on a GitHub board: move them in your tracker';
const SHOW_FIRST_GITHUB_ONLY = 'the panel changes Show me first only on a GitHub board: change it in your tracker';
const UNREAD_LOGIN = 'the gh login cannot be read';
const NO_LOGIN = `${UNREAD_LOGIN}: sign in with gh auth login, then refresh the queue`;
const NOT_WRITTEN = 'the undo record is not one the queue panel wrote';
const RECORD_KEYS = 'body,column,comments,open,title';
const DIGEST = /^[0-9a-f]{64}$/;
const MERGE_ANSWER = 'a merge answer goes to the coordinator: refresh the panel';
const CREDENTIAL_REPLY = 'it looks like it holds a credential: answer in chat and describe it instead';
const NO_ORDER = 'this tracker\'s board carries no owner-set order';

// What `read(path)` returns, or null where the file does not exist; any other failure is the caller's.
function readIfPresent(read, path) {
  try {
    return read(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

const cause = (error) => error.message.replace(/\s*[\r\n]+\s*/g, ' ');

// Why a card's detail entry is unread, for an entry `detailUnread` finds so.
const unreadCause = (entry) => entry.unavailable ?? entry.commentsUnavailable;

// What `read()` returns, or undefined after listing the source as failed with its cause.
function attempt(sources, name, read) {
  try {
    return read();
  } catch (error) {
    const { headline, details } = failureReport(error);
    sources.push({ name, ok: false, error: headline, ...(details !== null && { details }) });
    return undefined;
  }
}

const manifestRelease = (root, readFile) => {
  const manifest = readIfPresent(readFile, join(root, '.agents', 'factory-manifest.json'));
  return manifest === null ? null : (JSON.parse(manifest).release?.tag ?? null);
};

// Each `job/<card>` branch → the worktree that has it checked out.
function jobWorktrees(porcelain) {
  const worktrees = new Map();
  for (const record of porcelain.split(/\r?\n\r?\n/)) {
    const lines = record.split(/\r?\n/);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((line) => line.startsWith('branch refs/heads/job/'))?.slice('branch refs/heads/'.length);
    if (path && branch) worktrees.set(branch, path);
  }
  return worktrees;
}

// The block between the Decision card summary and its closing `</details>`, or null where there is none.
function decisionCard(body) {
  const open = body.indexOf(DECISION_CARD_OPEN);
  const close = body.indexOf('</details>', open);
  if (open < 0 || close < 0) return null;
  const block = body.slice(open + DECISION_CARD_OPEN.length, close).replace(/\n{3,}/g, '\n\n').trim();
  return block === '' ? null : block;
}

const REOPEN = 'Reopen the job\'s session on this machine.';

// The card body's last line, where the run and the panel write the card's state line.
const lastLine = (body) => body.trimEnd().split(/\r?\n/).at(-1);

// The head and saved files' identities the card body's last line records as card `number`'s waiting version, or
// undefined where that line is not a whole `Waiting version:` line for that card.
const WAITING_LINE = /^Waiting version: job\/([^\s/]+) (\S+) (\S+) run \S+$/;
function recordedVersion(number, cardBody) {
  const [, card, head, identity] = (typeof cardBody === 'string' ? WAITING_LINE.exec(lastLine(cardBody)) : null) ?? [];
  return card === String(number) ? { head, identity } : undefined;
}

// The merge item for a waiting card, complete or naming the first fact of the batch review it fails, and the local
// proof it was judged on: the job worktree's head and, once the saved write-up passed, the `git hash-object
// --no-filters` identities of its body.md and then each screenshot in numeric order, comma-separated as a waiting line
// names them. A complete item carries that proof as its `head` and `identity`.
function mergeItem({ number, title, labels }, { comments, body: cardBody, claim }, { tracker, worktrees, run, readFile, listFolder, hostname, waitLevel }) {
  const item = { card: number, title, category: 'merge' };
  const proof = {};
  const missing = (fact, next) => ({ item: { ...item, missing: { fact, next } }, proof });
  if (tracker === 'markdown') {
    // A Markdown claim names no machine: a waiting job's branch is unpushed, and one also on origin may be newer here.
    if (claim !== `branch job/${number} (local)`) return missing(`its claim is not branch job/${number} (local)`, 'Review it on the machine that built it.');
  } else {
    const { machine, runtime } = newestClaim(comments);
    if (runtime === CLOUD_RUNTIME) return missing('it is claimed for a cloud build', 'Open its pull request.');
    if (machine !== hostname) return missing('its newest claim does not name this machine', 'Review it on the machine that built it.');
  }
  const worktree = worktrees.get(`job/${number}`);
  if (worktree === undefined) return missing('no job worktree for it on this machine', REOPEN);
  const head = run(['-C', worktree, 'rev-parse', 'HEAD']).trim();
  proof.head = head;
  if (run(['-C', worktree, 'status', '--porcelain', '--untracked-files=normal']) !== '') return missing('its job worktree has uncommitted changes', REOPEN);
  const review = `.claude/worklog/job_${number}-review-${head}`;
  const folder = join(worktree, ...review.split('/'));
  const saved = readIfPresent(readFile, join(folder, 'body.md'));
  if (saved === null) return missing('no saved write-up for its worktree\'s head', REOPEN);
  // Comments go first: the template's own instructions say "no visual change" and name the Decision card.
  const body = saved.replace(HTML_COMMENT, '');
  const card = decisionCard(body);
  if (card === null) return missing('its saved write-up has no decision card', REOPEN);
  const screenshots = listFolder(folder).filter((name) => SCREENSHOT.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  // Read as the guard reads it: a "no visual change" line quoted in a fenced code block is not the write-up saying it.
  const noVisualChange = saysNoVisualChange(readable(saved));
  let complete;
  if (noVisualChange) complete = { ...item, decisionCard: card, visual: 'none' };
  else if (screenshots.length === 0) return missing('its write-up has no screenshot and does not say no visual change', REOPEN);
  else complete = { ...item, decisionCard: card, screenshots: screenshots.map((name) => join(folder, name)) };
  let reasons;
  try {
    reasons = waitReasons(body, screenshots);
  } catch (error) {
    return missing(cause(error), REOPEN);
  }
  const level = waitLevel();
  if (level.error !== undefined) return missing(level.error, 'Fetch origin, then refresh the queue.');
  let marked;
  try {
    marked = showFirstAmong(number, labels);
  } catch (error) {
    return missing(cause(error), 'Check the card\'s labels on the board, then refresh the queue.');
  }
  const held = withHolds(reasons, { level: level.value, onScreen: !noVisualChange, marked });
  if (held.length > 0) {
    const { free, dependent } = splitByRoute(held);
    complete.reason = [...free, ...dependent.length > 0 ? [`outside a Herdr job also: ${dependent.join(', ')}`] : []].join('; ');
  }
  const identity = run(['-C', worktree, 'hash-object', '--no-filters', '--', ...['body.md', ...screenshots].map((name) => `${review}/${name}`)])
    .replace(/\n$/, '').split('\n').join(',');
  proof.identity = identity;
  // The head is compared as text: the line the run wrote names the head git printed.
  const waiting = typeof cardBody === 'string' && lastLine(cardBody).startsWith('Waiting version: ');
  const recorded = recordedVersion(number, cardBody);
  if (waiting && (recorded?.head !== head || recorded?.identity !== identity)) return missing(NO_WAITING_VERSION, FINISH_OR_REOPEN);
  return { item: { ...complete, head, identity }, proof };
}

// The holds that stop a merge on every route, a Herdr job's included; every other hold stops only a merge outside a Herdr job.
const ROUTE_FREE_HOLDS = [...HERDR_HOLDS, SHOW_FIRST];
const splitByRoute = (holds) => ({
  free: holds.filter((hold) => ROUTE_FREE_HOLDS.includes(hold)),
  dependent: holds.filter((hold) => !ROUTE_FREE_HOLDS.includes(hold)),
});

const heldComment = (comments) => comments.map((comment) => comment.trimStart())
  .findLast((comment) => comment.startsWith('Needs owner:'))?.split(/\r?\n/, 1)[0];

// The computer a held question's Job sentence names, or undefined where the line does not end with that sentence for
// its own card. The comment is anyone's text and the panel draws the name inside a sentence of its own, so only a
// hostname's characters are read as one.
const HOST_NAME = /^(?=.{1,253}$)[\w-]+(?:\.[\w-]+)*$/;
function holdingComputer(question, card) {
  const sentence = ` Job: job/${card} on `;
  const line = question.trimEnd();
  const at = line.lastIndexOf(sentence);
  const name = at === -1 || !line.endsWith('.') ? '' : line.slice(at + sentence.length, -1);
  return HOST_NAME.test(name) ? name : undefined;
}

// `text` with its credentials redacted, then cut to 2000 characters. Redacted whole before the cut, so the cut cannot
// split a credential into a shape the redaction misses.
export function redactedCause(text) {
  const cause = redact(text);
  return cause.length > CAUSE_LIMIT ? `${cause.slice(0, CAUSE_LIMIT - 1)}…` : cause;
}

const claimCommentUrl = (value) => typeof value === 'string' && /^https:\/\/\S+#issuecomment-[1-9]\d*$/.test(value);

// The last day's first-parent merges to `origin/main`, newest first; no fetch, so the panel shows the fetch age.
function mergeDigest(run) {
  return run(['log', '--first-parent', '--since=24.hours', '--format=%H%x09%cI%x09%s', 'origin/main'])
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => {
      const [sha, at, ...subject] = line.split('\t');
      return { sha, at, subject: subject.join('\t') };
    });
}

// Why the board read cannot be trusted, or null: GitHub listing nothing is a failed read, and a card whose content did
// not resolve is one the queue could not classify.
function boardProblem(tracker, items) {
  if (isFailedEmptyRead(tracker, items)) return EMPTY_BOARD;
  const unresolved = items.filter(isContentUnresolved).length;
  return unresolved === 0 ? null : `${unresolved} card(s) could not be read on this scan: their content did not resolve`;
}

// A suggested card's scope: its `## What to build` and `## Acceptance criteria` sections, verbatim, or undefined where
// the body is not text or lacks either.
function scopeOf(body) {
  if (typeof body !== 'string') return undefined;
  const sections = body.split(/^(?=## )/m);
  const section = (heading) => sections.find((text) => text.split(/\r?\n/, 1)[0].trim() === `## ${heading}`)?.trimEnd();
  const build = section('What to build');
  const criteria = section('Acceptance criteria');
  return build === undefined || criteria === undefined ? undefined : `${build}\n\n${criteria}`;
}

// A card's outcome: the first paragraph of its `## What to build` lines, trimmed and joined by single spaces, with
// `more` true where lines follow it; null where the section has no lines, `{ unread }` where the section could not be
// read.
function outcomeOf(detail) {
  const { lines, unread } = whatToBuildSection(detail);
  if (unread !== undefined) return { unread };
  if (lines.length === 0) return null;
  const blank = lines.findIndex((line) => line.trim() === '');
  const paragraph = blank < 0 ? lines : lines.slice(0, blank);
  return { text: paragraph.map((line) => line.trim()).join(' '), more: paragraph.length < lines.length };
}

// JSON with every object's keys in sorted order, so equal values give equal text.
const canonicalJson = (value) => JSON.stringify(value, (key, entry) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]]))
  : entry));

// An item's version: the sha256 of the canonical JSON of the item as the panel shows it and what it was drawn from, the
// card's status, whole body and comments as read, a merge job's worktree head and saved-file identities, and
// `login`. The body stands in for the card's edit time, which the detail read does not
// carry, and the comments bind the held question whole and every comment posted since the panel drew it.
export const itemVersion = (item, { status, body, comments, head, identity, login }) => createHash('sha256')
  .update(canonicalJson({ item, status, body, comments, head, identity, login })).digest('hex');

// Whether card `number` carries the show-me-first marker among its `labels`, or `{ unread }` with the cause where they
// are not text, so an unread marker is never read as off.
function showFirstOf({ number, labels }) {
  try {
    return showFirstAmong(number, labels);
  } catch (error) {
    return { unread: cause(error) };
  }
}

// The document's board: each open card with its column, place, open blockers, claim and the category of its first queue
// item and its outcome, or null where the board could not be read. `details` is undefined where the details read failed
// whole, `worktrees` where the worktree list could not be read, and `omission` is what a GitHub read that recovered
// omitted cards said.
function boardSection({ tracker, cards, details, unread, items, worktrees, sources, omission }) {
  const detailsError = sources.find((source) => source.name === 'details' && !source.ok)?.error;
  const ordered = tracker === 'github' && omission === undefined;
  const placed = new Map();
  const section = {
    moves: tracker === 'github',
    places: tracker === 'github',
    cards: cards.map((card) => {
      const place = (placed.get(card.status) ?? 0) + 1;
      placed.set(card.status, place);
      const entry = { card: card.number, title: card.title, column: card.status, ...(ordered ? { order: place } : {}), blockers: card.openBlockers,
        ...(tracker === 'github' ? { showFirst: showFirstOf(card) } : {}),
        ...(worktrees === undefined ? {} : { worktree: worktrees.get(`job/${card.number}`) ?? null }) };
      if (details === undefined) return { ...entry, unread: detailsError };
      if (unread.includes(card)) return { ...entry, unread: unreadCause(details.get(card.number)) };
      const { machine, runtime } = newestClaim(details.get(card.number).comments);
      const { body } = details.get(card.number);
      const first = items.find((item) => item.card === card.number);
      return { ...entry, claim: machine === undefined ? null : { machine, runtime }, waitsOn: first?.category ?? null,
        outcome: outcomeOf(details.get(card.number)),
        ...(tracker === 'github' ? { version: sha256(canonicalJson({ card: card.number, title: card.title, column: card.status, order: entry.order, body })) } : {}) };
    }),
  };
  if (!ordered) section.orderUnread = omission ?? NO_ORDER;
  const unreadWaits = sources.filter((source) => !source.ok && source.name === 'worktrees').map((source) => source.name);
  if (unreadWaits.length > 0) section.waitsOnUnread = unreadWaits;
  return section;
}

function notificationEvidence({ tracker, login, hostname, items, shown, executor, repository, sources }) {
  const unavailable = new Set();
  const waits = [];
  if (tracker !== 'github') unavailable.add('unsupported-tracker');
  if (!isGitHubLogin(login)) unavailable.add('login-unavailable');
  if (sources.some((source) => !source.ok)) unavailable.add('source-unavailable');
  if (tracker === 'github' && isGitHubLogin(login)) {
    for (const item of items.filter((item) => item.category === 'question' || (item.category === 'merge' && shown.has(item.card)))) {
      let metadata;
      let viewerRead = false;
      try {
        metadata = readCard(item.card, { repository: repository(), exec: (args) => {
          const text = executor(args);
          const viewer = JSON.parse(text)?.data?.viewer?.login;
          viewerRead = true;
          if (!isGitHubLogin(viewer)) unavailable.add('login-unavailable');
          else if (viewer !== login) unavailable.add('ownership-unavailable');
          return text;
        } });
      } catch {
        if (!viewerRead || !unavailable.has('login-unavailable')) unavailable.add('source-unavailable');
        continue;
      }
      if (metadata.login !== login || metadata.issue.state !== 'OPEN') continue;
      const comments = metadata.issue.comments.nodes;
      if (comments.some((comment) => comment.author?.login === login
        && (comment.editor ? comment.editor.login !== login : comment.lastEditedAt !== null))) {
        unavailable.add('ownership-unavailable');
        continue;
      }
      const at = comments.findLastIndex(({ body }) => body.trimStart().startsWith('Claim:'));
      const claim = comments[at];
      const { machine, runtime } = newestClaim(claim ? [claim.body] : []);
      if (!claim || !machine || !runtime || !claimCommentUrl(claim.url) || !Number.isFinite(Date.parse(claim.createdAt))
        || !isGitHubLogin(claim.author?.login)) {
        unavailable.add('ownership-unavailable');
        continue;
      }
      if (claim.author.login !== login || machine !== hostname || runtime === CLOUD_RUNTIME) continue;
      if (item.category === 'question') {
        const holds = comments.slice(at + 1).filter(({ body }) => body.trimStart().split(/\r?\n/, 1)[0].startsWith('Needs owner:'));
        const ownHolds = holds.filter((hold) => hold.author?.login === login
          && hold.body.trimStart().split(/\r?\n/, 1)[0].endsWith(` Job: job/${item.card} on ${hostname}.`));
        if (ownHolds.length > 1) unavailable.add('ownership-unavailable');
        if (holds.length === 1 && holds[0].author?.login === login
          && holds[0].body.trimStart().split(/\r?\n/, 1)[0].endsWith(` Job: job/${item.card} on ${hostname}.`)) {
          waits.push({ card: item.card, kind: 'question' });
        }
      } else if (typeof item.reason === 'string' && item.reason.trim()) {
        waits.push({ card: item.card, kind: 'review' });
      }
    }
  }
  const code = ['unsupported-tracker', 'login-unavailable', 'source-unavailable', 'ownership-unavailable'].find((code) => unavailable.has(code)) ?? null;
  return { login, waits: code === null ? waits : [], unavailable: code };
}

/**
 * @typedef {{
 *   root: string, tracker: keyof import('./board-read.mjs').IdentifierByTracker, executor: import('./board-read.mjs').GhExecutor,
 *   linear?: import('./board-read.mjs').LinearExecutor, jira?: import('./board-read.mjs').RequestExecutor,
 *   azure?: import('./board-read.mjs').RequestExecutor, pause?: (ms: number) => void,
 *   run: (args: string[]) => string, readFile: (path: string) => string, listFolder: (path: string) => string[],
 *   fileTime: (path: string) => string, hostname: string, login: string | null,
 * }} QueueReaders
 */

/** @typedef {{ log: (line: string) => void, error: (line: string) => void }} QueueOutput where board-move and the action report */

// The queue document, each complete merge item's worktree head and saved-file identities, and the card facts
// each item was drawn from, including its title and whether it is open.
/** @param {QueueReaders} readers */
function readQueue({ root, tracker, executor, linear, jira, azure, pause, run, readFile, listFolder, fileTime, hostname, login }) {
  const sources = [];
  let omission;
  const board = attempt(sources, 'board', () => readBoard(tracker, { executor, linear, jira, azure, pause, onOmission: (text) => { omission = text; } }));
  const problem = board === undefined ? null : boardProblem(tracker, board.items);
  if (board !== undefined) sources.push(problem === null ? { name: 'board', ok: true } : { name: 'board', ok: false, error: problem });
  const cards = (board?.items ?? []).map(normalizeItem).filter((card) => card.number != null && !TERMINAL_STATUSES.includes(card.status));
  const details = board === undefined ? undefined
    : attempt(sources, 'details', () => readDetails(tracker, { executor, linear, jira, azure, markdown: board.markdown }, cards.map((card) => card.number)));
  const unread = details === undefined ? [] : cards.filter((card) => detailUnread(details.get(card.number)));
  if (details !== undefined) {
    const error = unread.map(({ number }) => `card ${number}: ${unreadCause(details.get(number))}`).join('; ');
    sources.push(unread.length === 0 ? { name: 'details', ok: true } : { name: 'details', ok: false, error });
  }
  const readableCards = problem === null && details !== undefined ? cards.filter((card) => !unread.includes(card)) : [];
  const worktrees = attempt(sources, 'worktrees', () => jobWorktrees(run(['worktree', 'list', '--porcelain'])));
  // The wait level on fetched main, read at the first waiting merge; a failed read is listed once in `sources`.
  let level;
  const waitLevel = () => {
    if (level === undefined) {
      try {
        level = { value: readWaitLevel({ git: run }) };
      } catch (error) {
        level = { error: cause(error) };
        sources.push({ name: 'wait level', ok: false, error: level.error });
      }
    }
    return level;
  };
  const context = { tracker, worktrees, run, readFile, listFolder, hostname, waitLevel };
  const githubWithLogin = tracker === 'github' && login !== null;
  let repository;
  const repositoryOf = () => (repository ??= configuredRepository(executor));
  const items = [];
  const facts = new Map();
  const shown = new Map();
  for (const card of readableCards) {
    const { body, comments } = details.get(card.number);
    facts.set(card.number, { status: card.status, body, comments, title: card.title, open: card.state === 'OPEN' });
    const question = heldComment(comments);
    const proposed = card.title.startsWith(PROPOSED);
    const item = { card: card.number, title: card.title };
    if (question !== undefined) {
      const heldOn = holdingComputer(question, card.number);
      items.push({ ...item, category: 'question', question, ...(heldOn === undefined ? {} : { heldOn }) });
    } else if (card.status === AWAITING_PUSH) {
      if (worktrees !== undefined) {
        const merge = mergeItem(card, details.get(card.number), context);
        Object.assign(facts.get(card.number), merge.proof);
        const complete = merge.item.missing === undefined;
        if (complete) shown.set(card.number, merge.proof);
        items.push(merge.item);
      }
    } else if (proposed) {
      const retro = githubWithLogin ? retroFields(body, comments, details.get(card.number).commentSources, login) : null;
      const scope = retro === null ? scopeOf(body) : undefined;
      items.push({ ...item, category: 'suggested', ...retro, ...(scope === undefined ? {} : { scope }) });
    }
  }
  const merges = attempt(sources, 'digest', () => ({
    digest: mergeDigest(run),
    fetchedAt: readIfPresent(fileTime, resolve(root, run(['rev-parse', '--git-path', 'FETCH_HEAD']).trim())),
  }));
  const document = {
    format: FORMAT,
    release: manifestRelease(root, readFile),
    host: hostname,
    readAt: new Date().toISOString(),
    fetchedAt: merges?.fetchedAt ?? null,
    sources,
    items: items.map((item) => ({ ...item, version: itemVersion(item, { ...facts.get(item.card), login }) })),
    board: board === undefined || problem !== null ? null : boardSection({ tracker, cards, details, unread, items, worktrees, sources, omission }),
    digest: merges?.digest ?? null,
    notifications: notificationEvidence({ tracker, login, hostname, items, shown, executor,
      repository: repositoryOf, sources }),
  };
  return { document, shown, facts };
}

export const collect = (readers) => readQueue(readers).document;

// Moves card to the Status column `status` through scripts/board-move.mjs, which reports to `output`.
function moveTo(card, status, executor, output) {
  if (moveCard([String(card), status], { ghExec: executor, output }) !== 0) throw new Error(`card ${card} could not be moved to ${status}`);
}

// The owner's reply as one line, refused where it is empty or over REPLY_MAX characters or holds what `redact` takes for a
// credential. The reply is never quoted back.
function replyWords(reply) {
  const words = typeof reply === 'string' ? reply.replace(/\s+/g, ' ').trim() : '';
  if (words === '' || [...words].length > REPLY_MAX) throw new Error(`an answer needs a reply of 1 to ${REPLY_MAX} characters`);
  if (redact(words) !== words) throw new Error(CREDENTIAL_REPLY);
  return words;
}

// Whether `action` answers `item` from the panel: park a merge item, complete or missing; keep a suggestion whose scope the panel showed; drop a suggestion; pick a weekly retro proposal with an unfiled
// card draft.
const ROUTES = {
  park: (item) => item.category === 'merge',
  keep: (item) => item.category === 'suggested' && typeof item.scope === 'string',
  drop: (item) => item.category === 'suggested',
  pick: (item, proposal) => item.category === 'suggested' && item.proposals?.some(({ n, card }) => n === proposal && card === undefined) === true,
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const COMMENT_ID = /#issuecomment-(\d+)$/;
const COMMENTS_MOVED = 'a comment was added, edited or removed';
const TEXT_EDITED = 'its text was edited';

// The ` Job:` sentence that ends what the panel posts on card `card` from this machine, and the hold `park` posts.
const jobSentence = (card, hostname) => ` Job: job/${card} on ${hostname}.`;
const parkHold = (card, hostname) => `Needs owner: Parked from the queue panel: what should change?${jobSentence(card, hostname)}`;

// What `act` leaves for Undo, from the facts of its version-checked read: the card's Status (null where it has none),
// whether it is open, its title, and the sha256 hex of its body and of the canonical JSON of its comment bodies in order.
const undoRecord = ({ status, open, title, body, comments }) => ({ column: status, open, title, body: sha256(body), comments: sha256(canonicalJson(comments)) });

const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);

// Whether a well-formed record could be one `act` wrote for each action: park answers only an Awaiting push card, keep
// and drop only a `Proposed: ` title, and drop never a card in a terminal column.
const RECORDED = {
  park: ({ column }) => column === AWAITING_PUSH,
  keep: ({ title }) => title.startsWith(PROPOSED),
  drop: ({ column, title }) => title.startsWith(PROPOSED) && !TERMINAL_STATUSES.includes(column),
};

// The undo record the JSON text `text` holds for `action`, refused unless it is exactly the shape `act` logs for it.
function readRecord(text, action) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(NOT_WRITTEN);
  }
  const shaped = record !== null && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).sort().join() === RECORD_KEYS && (record.column === null || typeof record.column === 'string')
    && typeof record.open === 'boolean' && typeof record.title === 'string' && record.title !== ''
    && isDigest(record.body) && isDigest(record.comments);
  if (!shaped || !RECORDED[action](record)) throw new Error(NOT_WRITTEN);
  return record;
}

// The queue read again with `readers` and card `card`'s item in it, refused where the card is not in the queue now or
// its item is no longer at `version`, the version the panel drew.
function drawnItem(card, version, readers) {
  const read = readQueue(readers);
  const item = read.document.items.find((entry) => entry.card === card);
  if (item === undefined) throw new Error(`card ${card} is not in the queue now: refresh the queue`);
  if (item.version !== version) throw new Error(`card ${card} changed since the panel drew it: refresh the queue`);
  return { ...read, item };
}

/**
 * Writes one queue panel answer, `action` on card `card`, only where the queue read again with `login` holds that card
 * at `version` and the action answers its item. `park` writes the card's `Parked:` state line, posts the panel's hold
 * and moves the card to Backlog. An answer is refused: a merge answer goes to the coordinator through `relayAnswer`,
 * and questions go to chat. Keep removes the title's Proposed prefix and drop closes the card as
 * not planned and moves it to Done.
 * `pick` makes proposal `proposal` of a weekly retro a card, as `fileDraft` says, and takes that number, which every
 * other action refuses. Comment text goes through a file in a fresh temporary folder. Takes the readers `collect` takes and `output`, which
 * board-move reports to; after park, keep or drop it logs `owner-queue: undo record <json>` last, the record `undo`
 * takes, built from that version-checked read and never from one after the writes. Throws one line, writing nothing,
 * for any other tracker, card, action, login, reply, version, item or unreadable board repository; a write that fails
 * throws its cause, the earlier writes of the action standing.
 * @param {{ card: number, action: string | undefined, version: string | undefined, reply?: string, proposal?: number, output: QueueOutput } & QueueReaders} request
 */
export function act({ card, action, version, reply, proposal, output, ...readers }) {
  if (readers.tracker !== 'github') throw new Error(GITHUB_ONLY);
  if (!Number.isSafeInteger(card) || card <= 0) throw new Error(`${JSON.stringify(card)} is not a card number`);
  if (action === undefined || !ACTIONS.includes(action)) throw new Error(`${JSON.stringify(action)} is not a queue panel action: answer in chat`);
  if (typeof readers.login !== 'string') throw new Error(NO_LOGIN);
  if (action === 'answer') replyWords(reply);
  else if (reply !== undefined) throw new Error(`${action} takes no reply`);
  if (action === 'pick' && !(typeof proposal === 'number' && Number.isSafeInteger(proposal) && proposal > 0)) throw new Error('a pick names its proposal by a positive whole number');
  if (action !== 'pick' && proposal !== undefined) throw new Error(`${action} takes no proposal`);
  const { facts, item } = drawnItem(card, version, readers);
  if (action === 'answer' && item.category === 'merge') throw new Error(MERGE_ANSWER);
  if (!ROUTES[action]?.(item, proposal)) throw new Error(`${action} does not answer card ${card}'s ${item.category} item: answer in chat`);
  const { executor, hostname } = readers;
  const repository = configuredRepository(executor);
  const { nameWithOwner } = repository;
  if (action === 'park') {
    writeStateLine(card, PARKED_LINE, { exec: executor });
    withBodyFile(parkHold(card, hostname), (file) => executor(['issue', 'comment', String(card), '--repo', nameWithOwner, '--body-file', file]));
    moveTo(card, 'Backlog', executor, output);
  } else if (action === 'keep') executor(['issue', 'edit', String(card), '--repo', nameWithOwner, '--title', item.title.slice(PROPOSED.length)]);
  else if (action === 'pick') fileDraft({ card, proposal, body: facts.get(card).body, login: readers.login, nameWithOwner }, executor);
  else {
    executor(['issue', 'close', String(card), '--repo', nameWithOwner, '--reason', 'not planned']);
    moveTo(card, 'Done', executor, output);
  }
  output.log(`owner-queue: card ${card}: ${action} written`);
  if (UNDOABLE.includes(action)) output.log(`owner-queue: undo record ${JSON.stringify(undoRecord(facts.get(card)))}`);
}

// The line the coordinator takes as the owner's queue panel answer `words` to card `card`'s merge at `head` and the
// saved files' `identity`.
const panelAnswerLine = (card, head, identity, words) => `Queue panel answer for card ${cardRef(card)}: job/${card} at ${head} ${identity}: ${words}`;

/**
 * Sends the owner's `reply` to card `card`'s waiting merge to the coordinator as `panelAnswerLine`, at the head and
 * identity the queue read again with the readers `collect` takes drew it from, only where that read holds the card at
 * `version` as a complete merge item, on any tracker and with or without a login. `relay(line)` resolves the relay's
 * `{ code, message }`. Writes nothing to the card, logs `owner-queue: card <ref>: answer sent to the coordinator` to
 * `output`, and throws one line, sending nothing, for any other card, reply, version or item, and the relay's message
 * where it sent nothing.
 */
export async function relayAnswer({ card, version, reply, relay, output, ...readers }) {
  const words = replyWords(reply);
  const { item, shown } = drawnItem(card, version, readers);
  if (item.category !== 'merge') throw new Error(`card ${card}'s ${item.category} item takes no coordinator answer: answer in chat`);
  const proof = shown.get(card);
  if (proof === undefined) throw new Error(`card ${card}'s merge shows no waiting version: answer in your coordinator chat`);
  const { code, message } = await relay(panelAnswerLine(card, proof.head, proof.identity, words));
  if (code !== 0) throw new Error(message);
  output.log(`owner-queue: card ${cardRef(card)}: answer sent to the coordinator`);
}

/**
 * Takes back the panel's `action` (park, keep or drop) on card `card`, given in `record` the undo record JSON `act`
 * logged for it, only where the card read live is in the state that action left: the record's state with the action's
 * own writes applied. Park left the card in Backlog with the panel's hold, posted by `login` and unedited, as its newest
 * comment, and its body as it was where already parked, else the recorded body with the parked line, as the card's two
 * newest revisions show; keep left the title without `Proposed: `; drop left the card closed in Done. An edit anyone
 * made after the action's read, during the action included, is a difference, and the first one, in the order column,
 * open, title, comments, body, refuses with `card <n> moved since it was <put aside, accepted or rejected>: <what
 * moved>`, writing nothing. Every value written comes from the live card, its edit history or a constant, except drop's
 * column: park moves the card to Awaiting push, writes back the replaced revision's last state line where park changed
 * the body (none where that revision had none) and deletes the hold; keep writes `Proposed: <live title>`; drop reopens
 * the card where the record holds it open, then moves it to the recorded column or, where the record holds none, clears
 * its Status, refusing before any write where the board no longer offers the recorded column. Takes the readers `act`
 * takes and `output`, which board-move reports to, and logs `owner-queue: card <n>: <action> taken back`. Throws one
 * line, before any read, for any other tracker, card, action, login or record; a write that fails throws its cause, the
 * earlier writes standing.
 */
export function undo({ card, action, record, output, tracker, executor, hostname, login }) {
  if (tracker !== 'github') throw new Error(GITHUB_ONLY);
  if (!Number.isSafeInteger(card) || card <= 0) throw new Error(`${JSON.stringify(card)} is not a card number`);
  if (!UNDOABLE.includes(action)) throw new Error(`${JSON.stringify(action)} has no Undo: correct it in chat`);
  if (typeof login !== 'string') throw new Error(NO_LOGIN);
  const recorded = readRecord(record, action);
  const repository = configuredRepository(executor);
  const { nameWithOwner } = repository;
  const issue = readWholeCard(card, { exec: executor, repository });
  const { item } = lookupIssueBoardItem(card, executor, { fieldName: 'Status' });
  const moved = (what) => new Error(`card ${card} moved since it was ${TAKEN[action]}: ${what}`);
  const left = {
    park: { column: 'Backlog', open: recorded.open, title: recorded.title },
    keep: { column: recorded.column, open: recorded.open, title: recorded.title.slice(PROPOSED.length) },
    drop: { column: 'Done', open: false, title: recorded.title },
  }[action];
  if (item === null || item.isArchived) throw moved('it is no longer on the board');
  const column = item.value?.name ?? null;
  if (column !== left.column) throw moved(column === null ? 'it now has no Status' : `it is now in ${column}`);
  const open = issue.state === 'OPEN';
  if (open !== left.open) throw moved(open ? 'it was reopened' : 'it was closed');
  if (issue.title !== left.title) throw moved('its title was edited');
  const { comments } = issue;
  const hold = action === 'park' ? comments.at(-1) : undefined;
  if (action === 'park' && (hold?.body !== parkHold(card, hostname) || hold.author?.login !== login || hold.lastEditedAt !== null || !COMMENT_ID.test(hold.url))) {
    throw moved(COMMENTS_MOVED);
  }
  const before = action === 'park' ? comments.slice(0, -1) : comments;
  if (sha256(canonicalJson(before.map((node) => node.body))) !== recorded.comments) throw moved(COMMENTS_MOVED);
  const unchanged = sha256(issue.body) === recorded.body;
  // The body park replaced, where its state line write changed the body.
  let replaced;
  if (action !== 'park') {
    if (!unchanged) throw moved(TEXT_EDITED);
  } else if (!unchanged || withLine(issue.body, PARKED_LINE) !== issue.body) {
    const [newest, previous] = bodyRevisions(card, { exec: executor, repository });
    if (newest !== issue.body || sha256(previous) !== recorded.body || withLine(previous, PARKED_LINE) !== issue.body) throw moved(TEXT_EDITED);
    replaced = previous;
  }
  if (action === 'park') {
    moveTo(card, AWAITING_PUSH, executor, output);
    if (replaced !== undefined) writeStateLine(card, lastStateLine(replaced), { exec: executor });
    executor(['api', '-X', 'DELETE', `repos/${nameWithOwner}/issues/comments/${/** @type {RegExpExecArray} */ (COMMENT_ID.exec(hold.url))[1]}`]);
  } else if (action === 'keep') executor(['issue', 'edit', String(card), '--repo', nameWithOwner, '--title', `${PROPOSED}${issue.title}`]);
  else {
    // The Status to go back to, resolved before any write, so a column the board no longer offers writes nothing.
    const { projectId, fieldId, options } = parseSingleSelectField(executor(['api', 'graphql', '-f', `query=${singleSelectFieldQuery('Status')}`]));
    const destination = recorded.column === null ? ['--clear'] : ['--single-select-option-id', optionIdFor(options, recorded.column)];
    if (recorded.open) executor(['issue', 'reopen', String(card), '--repo', nameWithOwner]);
    executor(['project', 'item-edit', '--id', item.id, '--project-id', projectId, '--field-id', fieldId, ...destination]);
  }
  output.log(`owner-queue: card ${card}: ${action} taken back`);
}

/**
 * Moves card `card` on the board, `move` being `ready` (Backlog to Ready, placed last in the build order, the Ready cards
 * whose titles do not begin `Proposed: `), `backlog` (Ready back to Backlog), `up` (one rank up in the build order) or
 * `place` (to the 1-based place `to` in it), only where the queue read again holds the card at `version`, the version
 * the board section drew, and the move fits it.
 * Needs no login. `ready` first, where the build order has a card, places the card after the last one and then writes
 * its Status, so no read sees it in Ready ahead of that order; a placement that fails throws naming the card as not
 * moved, with no Status written. `up` places the card after
 * the card two ranks above it, or first from rank 2. `place` takes the 1-based place `to` and places the card after the
 * card that is then at the place above it, or first for place 1. Takes the readers `collect` takes and `output`, which
 * board-move reports to, and logs `owner-queue: card <n>: <move> written`. Throws one line, writing nothing, for any
 * other tracker, card, move, place or version, a board or card whose details were not read, a column the move does not
 * start from, a suggestion for `ready`, `up` or `place`, an unread build order, `up` from rank 1, or `place` at the
 * card's own place or past the last; a Status or position write that fails throws its cause.
 * @param {{ card: number, move: string | undefined, version: string | undefined, to?: number, output: QueueOutput } & QueueReaders} request
 */
export function moveOnBoard({ card, move, version, to, output, ...readers }) {
  if (readers.tracker !== 'github') throw new Error(MOVES_GITHUB_ONLY);
  if (!Number.isSafeInteger(card) || card <= 0) throw new Error(`${JSON.stringify(card)} is not a card number`);
  if (!MOVES.includes(move ?? '')) throw new Error(`${JSON.stringify(move)} is not a board move`);
  const target = typeof to === 'number' && Number.isSafeInteger(to) && to > 0 ? to : 0;
  if (move === 'place' && target === 0) throw new Error(`${JSON.stringify(to)} is not a place in the build order`);
  const { document } = readQueue(readers);
  const { board } = document;
  if (board === null) throw new Error(`the board was not read: ${document.sources.find((source) => source.name === 'board' && !source.ok).error}`);
  const entry = board.cards.find((each) => each.card === card);
  if (entry === undefined) throw new Error(`card ${card} is not on the board now: refresh the queue`);
  if (entry.unread !== undefined) throw new Error(`the details of card ${card} were not read: ${entry.unread}`);
  if (entry.version !== version) throw new Error(`card ${card} changed since the panel drew it: refresh the queue`);
  const proposed = entry.title.startsWith(PROPOSED);
  const ranked = board.cards.filter((each) => each.column === 'Ready' && !each.title.startsWith(PROPOSED));
  const rank = ranked.findIndex((each) => each.card === card);
  const { column } = entry;
  const where = `card ${card} is in ${column ?? 'no column'}`;
  if (move === 'ready') {
    if (column !== null && column !== 'Backlog') throw new Error(`${where}, not Backlog`);
    if (proposed) throw new Error(`card ${card} is a suggestion: accept it first`);
  } else if (column !== 'Ready') throw new Error(`${where}, not Ready`);
  else if (move !== 'backlog' && proposed) throw new Error(`card ${card} is a suggestion, so it has no place in the build order`);
  if (move !== 'backlog' && board.orderUnread !== undefined) throw new Error(`the build order was not read: ${board.orderUnread}`);
  if (move === 'up' && rank === 0) throw new Error(`card ${card} is first in the build order already`);
  if (move === 'place' && target > ranked.length) throw new Error(`card ${card} cannot take place ${target}: the build order ends at place ${ranked.length}`);
  if (move === 'place' && target === rank + 1) throw new Error(`card ${card} is at place ${target} already`);
  const { executor } = readers;
  if (move === 'ready') {
    if (ranked.length > 0) {
      try {
        placeCardAfter(card, ranked.at(-1).card, executor);
      } catch (error) {
        throw new Error(`card ${card} was not moved to Ready: its place last in the build order could not be set: ${cause(error)}`);
      }
    }
    moveTo(card, 'Ready', executor, output);
  } else if (move === 'backlog') moveTo(card, 'Backlog', executor, output);
  else {
    const place = move === 'up' ? rank : target;
    const others = ranked.filter((each) => each.card !== card);
    placeCardAfter(card, place >= 2 ? others[place - 2].card : null, executor);
  }
  output.log(`owner-queue: card ${card}: ${move} written`);
}

/**
 * Sets (`on`) or removes (`off`) the show-me-first marker of card `card`, only on a GitHub board and where the queue
 * read now holds the card, not a `Proposed: ` suggestion, in Ready, In progress, In review or Awaiting push with its
 * labels read, and writes only where the marker is not in that state already, by `gh issue edit --add-label` or
 * `--remove-label` on the configured board repository. Needs no login. Takes the readers `collect` takes and `output`,
 * and logs `owner-queue: card <n>: show-me-first <state> written`, or `already <state>` where it wrote nothing. Throws one
 * line, writing nothing, for any other tracker, card or state, a board that was not read, a card that is not on it, a
 * suggestion, any other column, or labels that were not read; a write that fails throws its cause.
 * @param {{ card: number, state: string | undefined, output: QueueOutput } & QueueReaders} request
 */
export function markShowFirst({ card, state, output, ...readers }) {
  if (readers.tracker !== 'github') throw new Error(SHOW_FIRST_GITHUB_ONLY);
  if (!Number.isSafeInteger(card) || card <= 0) throw new Error(`${JSON.stringify(card)} is not a card number`);
  if (!SHOW_FIRST_STATES.includes(state ?? '')) throw new Error(`${JSON.stringify(state)} is not a Show me first state`);
  const { document } = readQueue(readers);
  const { board } = document;
  if (board === null) throw new Error(`the board was not read: ${document.sources.find((source) => source.name === 'board' && !source.ok).error}`);
  const entry = board.cards.find((each) => each.card === card);
  if (entry === undefined) throw new Error(`card ${card} is not on the board now: refresh the queue`);
  if (entry.title.startsWith(PROPOSED)) throw new Error(`card ${card} is a suggestion: accept it first`);
  if (!SHOW_FIRST_COLUMNS.includes(entry.column)) throw new Error(`card ${card} is in ${entry.column ?? 'no column'}, not Ready or In progress`);
  if (entry.showFirst.unread !== undefined) throw new Error(`the labels of card ${card} were not read: ${entry.showFirst.unread}`);
  if (entry.showFirst === (state === 'on')) {
    output.log(`owner-queue: card ${card}: show-me-first already ${state}`);
    return;
  }
  const { executor } = readers;
  const { nameWithOwner } = configuredRepository(executor);
  try {
    executor(['issue', 'edit', String(card), '--repo', nameWithOwner, state === 'on' ? '--add-label' : '--remove-label', SHOW_FIRST]);
  } catch (error) {
    const fix = state === 'on' ? `; where this repository has no ${SHOW_FIRST} label, create it once with gh label create ${SHOW_FIRST}` : '';
    throw new Error(`card ${card}: ${SHOW_FIRST} was not turned ${state}: ${cause(error)}${fix}`);
  }
  output.log(`owner-queue: card ${card}: ${SHOW_FIRST} ${state} written`);
}

const COMMIT = new RegExp(`^${COMMIT_TEXT}$`);
const PULLS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    id
    defaultBranchRef { name }
    object(oid: $oid) {
      ... on Commit {
        associatedPullRequests(first: 10) {
          nodes {
            number title url body bodyHTML createdAt mergedAt merged baseRefName mergeCommit { oid }
            closingIssuesReferences(first: 2) { nodes { number } }
          }
        }
      }
    }
  }
}`;
// createdAt and label sit on the event types, not on the timeline item union, so each needs its inline fragment.
const LABEL_EVENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } }
          ... on UnlabeledEvent { createdAt label { name } }
        }
      }
    }
  }
}`;
const NOT_GITHUB_CARDS = 'this project\'s cards are not GitHub issues';
const WAITING = 'Waiting for you:';
// A paragraph opening a Decision card block after the first: a whole block label ended by a colon or `**`, or a bare screenshot-status line.
const LATER_BLOCK = /^(?:\*\*)?(?:screenshots?|what a yes accepts|risk|checks|undo|reach|passed|failed|untested)(?::|\*\*)|^(?:no visual change|screenshots under evidence)[ \t]*(?:\r?\n|$)/i;
const CHANGES_LABEL = /^(?:\*\*)?What changes(?: for you)?(?::\*\*|\*\*:?|:)[ \t]*/i;
const CHECK_LABELS = ['Passed', 'Failed', 'Untested'];
// The alt text of an uploaded screenshot image. A second copy of merge-evidence.mjs's UPLOADED_IMAGE_ALT, narrowed to
// the alt the deliver step writes, because that guard-loaded module does not export it and stays untouched.
const UPLOADED_SCREENSHOT = new RegExp(`!\\[(screenshot-\\d+ ${COMMIT_TEXT})\\]\\(https://github\\.com/user-attachments/[^\\s()]+\\)`, 'g');
const IMG_TAG = /<img\b[^>]*>/gi;
// A markdown image of any form, inline, reference, collapsed or shortcut, needs `![`, a label and a `]`.
const IMAGE_OPENER = /!\[[^\]]*\]/;
// The start of any raw HTML in markdown, a `<` and then a letter, `/`, `!` or `?` (CommonMark 0.31.2, sections 4.6 and
// 6.6), less a URI autolink, which is a link. Herdr's renderer decodes raw HTML and parses it again, so `changedOf`
// carries a summary holding it as plain text.
const RAW_HTML = /<(?![A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>)[A-Za-z/!?]/;
const ENTITIES = { amp: '&', quot: '"', '#39': '\'', lt: '<', gt: '>' };
const SHOT_TIMEOUT_MS = 15_000;
const SHOT_MAX_BYTES = 8 * 1024 * 1024;
const SHOT_MAX_REDIRECTS = 3;
const SHOT_TYPE = /^image\/(png|jpeg|gif|webp)[ \t]*(?:;|$)/i;
const UPLOAD_HOSTS = ['private-user-images.githubusercontent.com', 'objects.githubusercontent.com'];
const SHOT_TOO_LARGE = `its download is larger than ${SHOT_MAX_BYTES / 1024 / 1024} MiB`;

// Whether pull request `node` has every field the report reads, in the type it reads it.
const wellFormedPull = (node) => Number.isSafeInteger(node.number)
  && ['title', 'url', 'body', 'bodyHTML', 'createdAt', 'mergedAt'].every((field) => typeof node[field] === 'string')
  && Array.isArray(node.closingIssuesReferences?.nodes)
  && node.closingIssuesReferences.nodes.every((issue) => Number.isSafeInteger(issue?.number) && issue.number > 0);

// The pull request GitHub associates with commit `sha` in `repository` that merged into its default branch as `sha`, or
// undefined where none did; a reply for another repository, or one missing a field the report reads, is refused.
function mergedPull(sha, executor, repository) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const reply = JSON.parse(executor(['api', 'graphql', '-f', `query=${PULLS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `oid=${sha}`]));
  const answered = reply?.data?.repository;
  const unreadable = new Error(`the pull requests of commit ${sha} in ${repository.nameWithOwner} could not be read`);
  if (answered?.id !== repository.id || typeof answered.defaultBranchRef?.name !== 'string') throw unreadable;
  if (answered.object === null) return undefined;
  const nodes = answered.object?.associatedPullRequests?.nodes;
  if (!Array.isArray(nodes)) throw unreadable;
  const pull = nodes.find((node) => node?.merged === true && node.mergeCommit?.oid === sha && node.baseRefName === answered.defaultBranchRef.name);
  if (pull !== undefined && !wellFormedPull(pull)) throw unreadable;
  return pull;
}

// The pull request's card, `{ number, title }`, with its read `issue`, or `{ unread }` with the `cause` that leaves the
// outcome unread: a tracker that is not GitHub, a pull request closing no card or more than one, or a failed read. The
// first two are `lasting`: no later read changes them, as one can a failed read.
function mergedCard(pull, { tracker, executor, repository }) {
  if (tracker !== 'github') return { card: { unread: NOT_GITHUB_CARDS }, cause: `${NOT_GITHUB_CARDS}, so its waiting record cannot be read`, lasting: true };
  const closes = pull.closingIssuesReferences.nodes;
  if (closes.length !== 1) {
    const why = `pull request #${pull.number} closes ${closes.length === 0 ? 'no card' : 'more than one card'}`;
    return { card: { unread: why }, cause: why, lasting: true };
  }
  const [{ number }] = closes;
  try {
    const { issue } = readCard(number, { exec: executor, repository });
    return { card: { number, title: issue.title }, issue };
  } catch (error) {
    const why = cause(error);
    return { card: { unread: why }, cause: why };
  }
}

// The wait level in the settings file at the first parent of merge `sha`: always where that commit has none. This
// repeats readWaitLevel's read, which reads only fetched main and sits in a guard-loaded module. A failed read or a file
// the validator refuses throws one cause without git's or the file's text, which can carry credentials or untrusted values.
function levelAtFirstParent(run, sha) {
  try {
    const parent = run(['rev-parse', '--verify', '--quiet', `${sha}^1^{commit}`]).trim();
    if (!COMMIT.test(parent)) throw new Error('invalid first parent');
    const mode = run(['ls-tree', '--full-tree', '--format=%(objectmode)', parent, '--', SETTINGS_PATH]).trim();
    if (mode !== '' && mode !== '100644' && mode !== '100755') throw new Error('nonregular settings entry');
    return readSettingsHeader(mode === '' ? undefined : run(['show', `${parent}:${SETTINGS_PATH}`]), SETTINGS_PATH).waitForOwner;
  } catch {
    throw new Error(`the wait level at the first parent of ${sha} cannot be read: fetch origin, then open the report again`);
  }
}

// The names of a card's labels as readCard answers them, or a throw where they cannot all be read. A second copy of
// cardMarked's check, which the guard-loaded merge-evidence.mjs keeps private.
function labelNames(number, issue) {
  const { labels } = issue;
  if (labels?.pageInfo?.hasNextPage !== false || !Array.isArray(labels.nodes)) throw new Error(`card ${number}'s labels cannot all be read`);
  return labels.nodes.map((label) => label?.name);
}

// Whether timeline item `node` is a label event with every field labelsAtMerge reads, in the type it reads it.
const wellFormedLabelEvent = (node) => ['LabeledEvent', 'UnlabeledEvent'].includes(node?.__typename)
  && typeof node.createdAt === 'string' && typeof node.label?.name === 'string';

// Card `number`'s label `names` as they stood at `merged` (epoch ms): its label events after the merge undone, newest
// first, from the last 100 GitHub lists oldest first. Throws where that history cannot all be read, earlier pages
// included when no event on this page reaches back to the merge.
function labelsAtMerge(number, names, merged, { executor, repository }) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const text = executor(['api', 'graphql', '-f', `query=${LABEL_EVENTS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  const unreadable = new Error(`card ${number}'s label history since the merge cannot all be read`);
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    throw unreadable;
  }
  const answered = reply?.data?.repository;
  const events = answered?.issue?.timelineItems;
  if (answered?.id !== repository.id || !Array.isArray(events?.nodes) || typeof events.pageInfo?.hasPreviousPage !== 'boolean') throw unreadable;
  if (!events.nodes.every(wellFormedLabelEvent)) throw unreadable;
  if (events.pageInfo.hasPreviousPage && !events.nodes.some((event) => Date.parse(event.createdAt) <= merged)) throw unreadable;
  const atMerge = [...names];
  for (const event of events.nodes.toReversed()) {
    if (Date.parse(event.createdAt) <= merged) break;
    const at = atMerge.indexOf(event.label.name);
    if (event.__typename === 'LabeledEvent' && at >= 0) atMerge.splice(at, 1);
    else if (event.__typename === 'UnlabeledEvent' && at < 0) atMerge.push(event.label.name);
  }
  return atMerge;
}

// Why the merge did or did not wait, from its records: the newest `Waiting for you:` first line its card got from the
// window's opening to the merge, else the deliver step's judgement run again at the level of the merge's first parent,
// `nothing` where it holds nothing and `disagrees` where it holds something no waiting record answers. The window opens
// at the card's newest `Claim:` comment made no later than the merge, since a card's work starts at its claim, which can
// come before the pull request opens, and its earlier pull requests' records come before that claim; where there is no
// such comment it opens with the pull request. The judgement reads the card's labels as they stood at the merge, as the
// deliver step did.
function mergeOutcome(pull, read, { sha, run, alts, noScreen, executor, repository }) {
  if (read.issue === undefined) return { outcome: 'unread', cause: read.cause, ...(read.lasting && { lasting: true }) };
  const merged = Date.parse(pull.mergedAt);
  const records = read.issue.comments.nodes
    .map((comment) => ({ body: comment.body.trimStart(), at: Date.parse(comment.createdAt) }));
  const opened = records.findLast(({ body, at }) => body.startsWith('Claim:') && at <= merged)?.at ?? Date.parse(pull.createdAt);
  const waiting = records
    .map(({ body, at }) => ({ line: body.split(/\r?\n/, 1)[0], at }))
    .findLast(({ line, at }) => line.startsWith(WAITING) && at >= opened && at <= merged)?.line;
  if (waiting !== undefined) return { outcome: 'waited', waiting };
  try {
    const reasons = waitReasons(pull.body, alts, `pull request #${pull.number}`);
    const level = levelAtFirstParent(run, sha);
    const atMerge = labelsAtMerge(read.card.number, labelNames(read.card.number, read.issue), merged, { executor, repository });
    const marked = showFirstAmong(read.card.number, atMerge);
    const holds = withHolds(reasons, { level, onScreen: !noScreen, marked });
    if (holds.length === 0) return { outcome: 'nothing', level };
    const { free, dependent } = splitByRoute(holds);
    if (free.length > 0) return { outcome: 'disagrees', level, holds };
    return { outcome: 'unread', cause: `this merge's route cannot be read: a Herdr job merges past ${dependent.join(', ')}, other routes wait for them`, lasting: true };
  } catch (error) {
    return { outcome: 'unread', cause: cause(error) };
  }
}

// Block 1 of the Decision card `decision` as markdown: the paragraphs before the first that opens a later block, less
// one leading What changes label, or `{ unread }` where nothing is left. Where an image opener or raw HTML is present,
// which Herdr could draw as an image or as HTML, it is `{ plain }`, the paragraphs as written. `report` has already
// removed every HTML comment, as GitHub hides them, one written inside a code span included.
function changedOf(decision, number) {
  const paragraphs = decision.split(/\n\s*\n/).map((paragraph) => paragraph.trim());
  const later = paragraphs.findIndex((paragraph) => paragraph.startsWith('![') || LATER_BLOCK.test(paragraph));
  const kept = paragraphs.slice(0, later < 0 ? paragraphs.length : later)
    .map((paragraph, at) => (at === 0 ? paragraph.replace(CHANGES_LABEL, '').trim() : paragraph))
    .filter((paragraph) => paragraph !== '');
  if (kept.length === 0) return { unread: `pull request #${number}'s decision card opens with no summary` };
  const changed = kept.join('\n\n');
  return RAW_HTML.test(changed) || IMAGE_OPENER.test(changed) ? { plain: changed } : changed;
}

// Block 5 of the Decision card `decision`: its Passed:, Failed: and Untested: lines whole, in card order, or `{ unread }`
// naming the first of them it lacks.
function checksOf(decision, number) {
  const lines = decision.split('\n').map((line) => line.trim()).filter((line) => CHECK_LABELS.some((label) => line.startsWith(`${label}:`)));
  const missing = CHECK_LABELS.find((label) => !lines.some((line) => line.startsWith(`${label}:`)));
  return missing === undefined ? lines : { unread: `pull request #${number}'s decision card has no ${missing}: line` };
}

const htmlText = (text) => text.replace(/&(amp|quot|#39|lt|gt);/g, (entity, name) => ENTITIES[name]);
const attributeOf = (tag, name) => {
  const value = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
  return value === undefined ? undefined : htmlText(value);
};

// Each alt in `bodyHTML` → the `src` of the first `<img>` carrying it, whatever the attribute order.
function imageSources(bodyHTML) {
  const sources = new Map();
  for (const [tag] of bodyHTML.matchAll(IMG_TAG)) {
    const alt = attributeOf(tag, 'alt');
    const src = attributeOf(tag, 'src');
    if (alt !== undefined && src !== undefined && !sources.has(alt)) sources.set(alt, src);
  }
  return sources;
}

// Whether `address` is an https address with no credentials or port on a GitHub upload host.
function onUploadHost(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  return UPLOAD_HOSTS.includes(url.hostname) || (url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/'));
}

// The image at `src` as `{ type, data }`, data in base64, or `{ unread }` naming why not. Each redirect is followed only
// to an upload host, and every cause is fixed text, since the address is a signed link that must not leave this process.
async function downloadShot(src, fetch) {
  const signal = AbortSignal.timeout(SHOT_TIMEOUT_MS);
  let address = src;
  for (let hop = 0; hop <= SHOT_MAX_REDIRECTS; hop += 1) {
    if (!onUploadHost(address)) return { unread: hop === 0 ? 'its address is not on a GitHub upload host' : 'its download redirects off GitHub\'s upload hosts' };
    const response = await fetch(address, { redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      address = new URL(location, address).href;
      continue;
    }
    const type = SHOT_TYPE.exec(response.headers.get('content-type') ?? '')?.[1].toLowerCase();
    let unread;
    if (response.status !== 200) unread = `its download answered HTTP ${response.status}`;
    else if (type === undefined) unread = 'its download is not a PNG, JPEG, GIF or WebP image';
    else if (Number(response.headers.get('content-length')) > SHOT_MAX_BYTES) unread = SHOT_TOO_LARGE;
    if (unread !== undefined) {
      await response.body?.cancel();
      return { unread };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > SHOT_MAX_BYTES) return { unread: SHOT_TOO_LARGE };
      chunks.push(chunk);
    }
    return { type, data: Buffer.concat(chunks).toString('base64') };
  }
  return { unread: `its download redirects more than ${SHOT_MAX_REDIRECTS} times` };
}

// Screenshot `alt` of the report, downloaded from `src`, or `{ alt, unread }` with a cause that never holds `src`.
async function screenshotOf(alt, src, fetch) {
  if (src === undefined) return { alt, unread: 'no image in the pull request carries it' };
  try {
    return { alt, ...(await downloadShot(src, fetch)) };
  } catch (error) {
    return { alt, unread: /** @type {Error | undefined} */ (error)?.name === 'TimeoutError' ? `its download took over ${SHOT_TIMEOUT_MS / 1000} s` : 'its download failed' };
  }
}

/**
 * The report of merge commit `sha` (40 or 64 lowercase hex): `{ format, sha, direct: true }` where no pull request
 * merged into the default branch as `sha`, else `{ format, sha, pull, card, changed, checks, noScreen, outcome, level?,
 * waiting?, holds?, cause?, screenshots }`. Writes nothing. Reads the pull request through GitHub GraphQL in the board
 * repository with `executor`, its card through readCard only where `tracker` is GitHub, the settings file at the merge's
 * first parent through `run(args)` (git) and the card's label history through `executor` only where no waiting record
 * answers, and each screenshot through `fetch`. A pull request read that fails rejects with its cause; every other part
 * it cannot read names its cause in place. No output holds a screenshot's signed address.
 */
export async function report({ sha, executor, run, fetch, tracker }) {
  if (typeof sha !== 'string' || !COMMIT.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit`);
  const repository = configuredRepository(executor);
  const pull = mergedPull(sha, executor, repository);
  if (pull === undefined) return { format: FORMAT, sha, direct: true };
  // Comments go first, as mergeItem reads its saved write-up.
  const decision = decisionCard(pull.body.replace(HTML_COMMENT, '').replace(/\r\n/g, '\n'));
  const text = readable(pull.body);
  const noScreen = saysNoVisualChange(text);
  // One upload is one screenshot: a body repeating an image counts it once, as the deliver step counted its files.
  const alts = [...new Set([...text.matchAll(UPLOADED_SCREENSHOT)].map((image) => image[1]))];
  const read = mergedCard(pull, { tracker, executor, repository });
  const sources = imageSources(pull.bodyHTML);
  const noCard = { unread: `pull request #${pull.number} has no decision card` };
  return {
    format: FORMAT,
    sha,
    pull: { number: pull.number, title: pull.title, url: pull.url },
    card: read.card,
    changed: decision === null ? noCard : changedOf(decision, pull.number),
    checks: decision === null ? noCard : checksOf(decision, pull.number),
    noScreen,
    ...mergeOutcome(pull, read, { sha, run, alts, noScreen, executor, repository }),
    screenshots: await Promise.all(alts.map((alt) => screenshotOf(alt, sources.get(alt), fetch))),
  };
}

const DRAFT_KINDS = ['feature', 'task', 'bug', 'docs'];
const DRAFT_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const DRAFT_TITLE = /^[\p{L}\p{N} ,.:()-]{8,100}$/u;
const DRAFT_NAME = /^[\p{L}\p{N} -]{1,50}$/u;
// An unbroken run of twenty or more letters and digits holding both, as a credential of a shape `redact` does not
// know still is: a regular expression's source.
export const LONG_TOKEN = '(?<![A-Za-z0-9+])(?=[A-Za-z0-9+]*[A-Za-z])(?=[A-Za-z0-9+]*\\d)[A-Za-z0-9+]{20,}';
// What a card must not carry out of a private chat: a web address or a Markdown link of any form, an email address or account
// name, a card reference or address, a home or absolute path, and a long token. A lone `/word` is a command's name,
// not a path.
const PRIVATE_FACTS = [/\bhttps?:|\/\/\S|\bwww\.|\][([:]/i, /@\w/, /#\d|\bGH-\d|\/(?:issues|pull)\/\d/i, /~[\\/]|\b[A-Za-z]:[\\/]|(?:^|[^\w./])\/[^\s/]+\/\S/, new RegExp(LONG_TOKEN)];
const draftText = (value, limit) => typeof value === 'string' && value.trim() !== '' && value.length <= limit;

/**
 * Why `draft` is no card draft of a weekly retro, in words that hold none of its text, or null where it is one: `n` a
 * positive whole number, `repository` an owner and a name, `kind` one of feature, task, bug and docs, a title of 8 to
 * 100 letters, digits, spaces and plain punctuation, a problem of 600 characters at most, what to build of 1,000 and
 * one to five one-line criteria of 200, exactly one of `label` and `type`, that and any `workstream` a plain name, and
 * no text holding a private fact or anything `redact` changes. The weekly job offers only such a draft and the panel
 * files only such a draft, so both call this.
 */
export function draftFault(draft) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) return 'it is not a card draft';
  const { n, repository, title, problem, build, criteria, kind, label, type, workstream } = draft;
  if (!Number.isSafeInteger(n) || n < 1) return 'its number is not a positive whole number';
  if (typeof repository !== 'string' || !DRAFT_REPOSITORY.test(repository)) return 'its project is not an owner and a name';
  if (!DRAFT_KINDS.includes(kind)) return `its kind is not one of ${DRAFT_KINDS.join(', ')}`;
  if (typeof title !== 'string' || !DRAFT_TITLE.test(title) || title !== title.trim()) {
    return 'its title is not 8 to 100 letters, digits, spaces and plain punctuation';
  }
  if (!draftText(problem, 600) || !draftText(build, 1000) || !Array.isArray(criteria) || criteria.length < 1 || criteria.length > 5
    || !criteria.every((line) => draftText(line, 200) && !/[\r\n]/.test(line))) {
    return 'its problem, what to build or acceptance criteria are missing or too long';
  }
  const names = [label ?? type, ...(workstream === undefined ? [] : [workstream])];
  if ((label === undefined) === (type === undefined) || !names.every((name) => typeof name === 'string' && DRAFT_NAME.test(name))) {
    return 'its label, type or workstream is not a plain name';
  }
  if ([title, problem, build, ...criteria].some((text) => PRIVATE_FACTS.some((fact) => fact.test(text)) || redact(text) !== text)) {
    return 'its text holds a web address, an account name, a card number, a file path, a credential or a long token';
  }
  return null;
}

const RETRO_FORMAT = 1;
const BLOCK_ESCAPES = { '`': '\\u0060', '<': '\\u003c', '>': '\\u003e', '@': '\\u0040', '#': '\\u0023' };

// The section a weekly retro's body ends with: the card drafts of `week` as one line of JSON in a fenced block, every
// backtick, angle bracket, at sign and hash written as its escape, so no draft closes the block, draws HTML, names an
// account or references a card from inside the retro.
export const retroDraftsSection = (week, proposals) => '## Card drafts\n\n```json fabraik-retro\n'
  + `${JSON.stringify({ format: RETRO_FORMAT, week, proposals }).replace(/[`<>@#]/g, (character) => BLOCK_ESCAPES[character])}\n\`\`\`\n`;

const sameText = (a, b) => a.replace(/\r\n/g, '\n').trimEnd() === b.replace(/\r\n/g, '\n').trimEnd();

/**
 * The lowest-numbered issue `login` created in `repository` under exactly `title`, as `{ number, url }`, or null where
 * there is none. `since` (an ISO time no later than the issue's creation) bounds the listing, read in whole with
 * `exec`; a pull request never counts. Given `body`, the issue must also hold that text, line endings and trailing
 * space aside, and one of that title holding anything else is refused by its number, so a card someone else's work
 * already named is never taken for this one.
 * @param {{ repository: string, login: string, title: string, since: string, body?: string }} issue
 * @param {(args: string[]) => string} exec
 */
export function filedIssue({ repository, login, title, since, body }, exec) {
  const pages = JSON.parse(exec(['api', `repos/${repository}/issues?creator=${login}&state=all&since=${since}&per_page=100`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`the issues of ${repository} cannot be read`);
  const titled = pages.flat().filter((issue) => issue?.pull_request === undefined && issue?.title === title);
  if (!titled.every((issue) => Number.isSafeInteger(issue.number) && typeof issue.html_url === 'string')) {
    throw new Error(`the issues of ${repository} were read without a number or an address`);
  }
  const [first] = titled.sort((a, b) => a.number - b.number);
  if (first === undefined) return null;
  const other = body === undefined ? undefined : titled.find((issue) => typeof issue.body !== 'string' || !sameText(issue.body, body));
  if (other !== undefined) throw new Error(`card ${other.number} in ${repository} already has this title and is not this draft: answer in chat`);
  return { number: first.number, url: first.html_url };
}

/**
 * Files the issue `title` with `body` in `repository` unless `login` already filed it, and returns
 * `{ number, url, existed }`, `existed` true where it was found before anything was created. `kind` is the issue's
 * `--label` or `--type` arguments. With `exact` an issue counts as filed only where it holds `body`, as `filedIssue`
 * says. Having created one it looks again, and where a lower-numbered issue of that title
 * now stands it closes its own as not planned and returns the lower one, so two callers that both found none end on
 * the same issue as far as GitHub's listing shows a new issue at once.
 */
export function fileOnce({ repository, login, title, since, body, kind, exact = false }, exec) {
  const wanted = { repository, login, title, since, ...(exact ? { body } : {}) };
  const found = filedIssue(wanted, exec);
  if (found !== null) return { ...found, existed: true };
  const printed = withBodyFile(body, (file) => exec(['issue', 'create', '--repo', repository, '--title', title, '--body-file', file, ...kind])).trim();
  const number = Number(/\/issues\/([1-9]\d*)$/.exec(printed)?.[1]);
  if (!Number.isSafeInteger(number)) throw new Error(`gh issue create printed no issue address for ${repository}`);
  const first = filedIssue(wanted, exec);
  if (first !== null && first.number < number) {
    exec(['issue', 'close', String(number), '--repo', repository, '--reason', 'not planned']);
    return { ...first, existed: false };
  }
  return { number, url: printed, existed: false };
}

// Completes card `number`'s place on the configured board and never rewrites it: a card not on the board is added in
// Backlog with `workstream`; one already there gets Backlog, and where the board has a routing field `workstream`,
// only for a field it holds no value in. So a card the owner closed or moved keeps its column and routing value.
export function placeInBacklog(number, workstream, exec) {
  const { item } = lookupIssueBoardItem(number, exec, { fieldName: 'Status' });
  if (item === null) {
    addIssueToBoard({ issueNumber: number, statusName: 'Backlog', workstreamName: workstream }, exec);
    return;
  }
  if (item.value == null) moveCards([{ issueNumber: number, statusName: 'Backlog' }], exec);
  if (ROUTING_FIELD && lookupIssueBoardItem(number, exec, { fieldName: ROUTING_FIELD }).item?.value == null) {
    moveCards([{ issueNumber: number, statusName: workstream }], exec, ROUTING_FIELD);
  }
}

const RETRO_SECTION = /\n\n## Card drafts\n\n```json fabraik-retro\n([^\n]*)\n```\n?$/;
const RETRO_WEEK = /^\d{4}-\d{2}-\d{2}$/;
const PICKED = /^Picked: proposal ([1-9]\d*) became card ([1-9]\d*) in (\S+)\.$/;

/**
 * What a weekly retro's `body` holds, `{ writeUp, week, proposals }`, or null where it does not end with exactly the
 * section `retroDraftsSection` writes: `writeUp` is the text before that section, `week` its date and `proposals` its
 * card drafts, every one passing `draftFault` and no two sharing a number. The queue read and the pick both read the
 * drafts through this, so a draft that fails a check is neither shown nor filed.
 */
export function retroDrafts(body) {
  const text = body.replace(/\r\n/g, '\n');
  const section = RETRO_SECTION.exec(text);
  if (section === null) return null;
  let block;
  try {
    block = JSON.parse(section[1]);
  } catch {
    return null;
  }
  if (block === null || typeof block !== 'object' || block.format !== RETRO_FORMAT || typeof block.week !== 'string' || !RETRO_WEEK.test(block.week)
    || !Array.isArray(block.proposals) || block.proposals.some((draft) => draftFault(draft) !== null)
    || new Set(block.proposals.map(({ n }) => n)).size !== block.proposals.length) return null;
  return { writeUp: text.slice(0, section.index).trimEnd(), week: block.week, proposals: block.proposals };
}

const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// The fields a weekly retro adds to its suggested item, or null where `body` is no retro: `reason`, the counts of its
// numbered proposals and points; `writeUp`, as `{ plain }` where it holds an image or raw HTML, since anyone with write
// access can edit the issue; and `proposals`, each draft's fields as `pick` files them, with `card` once a comment
// `login` itself posted says which card it became. The same words from any other account mark nothing.
function retroFields(body, comments, commentSources, login) {
  const retro = retroDrafts(body);
  if (retro === null) return null;
  const { writeUp } = retro;
  const made = new Map();
  comments.forEach((comment, index) => {
    const picked = commentSources[index]?.login === login ? PICKED.exec(comment.trim()) : null;
    if (picked !== null && !made.has(Number(picked[1]))) made.set(Number(picked[1]), { repository: picked[3], number: Number(picked[2]) });
  });
  const proposals = (writeUp.match(/^### Proposal /gm) ?? []).length;
  const points = (writeUp.match(/^### Point /gm) ?? []).length;
  return {
    reason: proposals + points === 0 ? 'Nothing to report this week'
      : `${counted(proposals, 'proposal', 'proposals')} and ${counted(points, 'place', 'places')} I think you were wrong`,
    writeUp: RAW_HTML.test(writeUp) || IMAGE_OPENER.test(writeUp) ? { plain: writeUp } : writeUp,
    proposals: retro.proposals.map(({ kind, ...draft }) => (made.has(draft.n) ? { ...draft, card: made.get(draft.n) } : draft)),
  };
}

// The card a picked draft is filed as: its three sections, its routing value as a line where the card goes to another
// repository, whose own session places it, and the week of the retro it came from. Nothing else of the retro.
const draftCard = ({ problem, build, criteria, workstream }, week, own) => ['## Problem', '', problem, '', '## What to build', '', build, '',
  '## Acceptance criteria', '', ...criteria.map((line) => `- [ ] ${line}`), '',
  ...(own || workstream === undefined ? [] : [`Workstream: ${workstream}`, '']), `Local retro: ${week}`, ''].join('\n');

/**
 * Makes proposal `proposal` of the weekly retro card `card` a card: files its stored draft, read from `body` through
 * `retroDrafts`, once in the repository the draft names, places it in Backlog where that is the board's own
 * repository `nameWithOwner`, and comments `Picked: proposal <k> became card <n> in <owner/name>.` on the retro. An
 * own-repository draft must carry this board's label or type for its kind and a routing value the board offers, or
 * none where it has no routing field, checked before anything is written; another repository's `gh issue create`
 * refuses a label or type it lacks. A card of the draft's title holding another text is refused, and one holding the
 * draft is the card an earlier pick created, which is completed and never rewritten.
 */
function fileDraft({ card, proposal, body, login, nameWithOwner }, exec) {
  const { week, proposals } = /** @type {NonNullable<ReturnType<typeof retroDrafts>>} */ (retroDrafts(body));
  const draft = proposals.find(({ n }) => n === proposal);
  const own = draft.repository.toLowerCase() === nameWithOwner.toLowerCase();
  const kind = draft.label === undefined ? ['--type', draft.type] : ['--label', draft.label];
  if (own) {
    const types = kindTypesOf(boardConfig);
    const [option, name] = types ? ['--type', types[draft.kind]] : ['--label', KIND_LABELS[draft.kind]];
    if (kind[0] !== option || kind[1] !== name) throw new Error(`proposal ${proposal}'s label or type is not this board's for its kind: answer in chat`);
    if (ROUTING_FIELD ? !ROUTING_OPTIONS.includes(draft.workstream) : draft.workstream !== undefined) {
      throw new Error(`proposal ${proposal}'s routing value is not one this board takes: answer in chat`);
    }
  }
  const filed = fileOnce({ repository: draft.repository, login, title: draft.title, since: `${week}T00:00:00Z`, body: draftCard(draft, week, own), kind, exact: true }, exec);
  if (own) placeInBacklog(filed.number, draft.workstream, exec);
  withBodyFile(`Picked: proposal ${proposal} became card ${filed.number} in ${draft.repository}.`,
    (file) => exec(['issue', 'comment', String(card), '--repo', nameWithOwner, '--body-file', file]));
}
