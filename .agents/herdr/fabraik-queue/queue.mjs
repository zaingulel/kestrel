// @ts-nocheck
// queue.mjs — the queue panel's machine aggregator. It reads every repository the machine record lists and writes
// the one ranked list the panel draws. Node built-ins only: the file is copied to the Herdr home, outside any
// repository.
//
//   node queue.mjs notify [--initialize] --home <dir>
//                                                initialize notification state or run one scheduled tick
//   node queue.mjs refresh [<terminals>] --home <dir>
//                                                rebuild the cache from each repository's collector
//   node queue.mjs menus [<terminals>] --home <dir>
//                                                print the waiting menus as JSON `{ items, problems }`, writing nothing
//   node queue.mjs clear-digest --home <dir>     mark each repository's newest merge as read and drop the digest
//   node queue.mjs open-log <key> --home <dir>   open the log of the cached failure item `key` with xdg-open
//   node queue.mjs act <key> <action> <version> [<reply>|<proposal>] --home <dir>
//                                                hand a panel answer on the cached item `key` to its repository
//   node queue.mjs undo <key> <action> <record> --home <dir>
//                                                take back a panel answer on the cached item `key` with its record
//   node queue.mjs move <key> <move> <version> [<place>] --home <dir>
//                                                hand a Board move on the cached item `key` to its repository
//   node queue.mjs report <key> --home <dir>     print the report of the merge `key`, `<repository>@<sha>`
//   node queue.mjs waiting-menu <terminal> --home <dir>
//                                                print the one waiting menu ask of `terminal` that `answer-menu` would accept
//   node queue.mjs answer-menu <terminal> <askId> --answer <json> --home <dir>
//                                                write the answer record `<json>` into the waiting menu ask `askId` of `terminal`
//   node queue.mjs show-first <key> <on|off> --home <dir>
//                                                hand a card's Show me first state on the cached item `key` to its repository
//
//   node queue.mjs open-coordinator <repository> <claude|codex> --home <dir>
//                                                ask a registered project to open its Coordinator for this session
//
// Exit 0: done. 1: it could not (the reason is one line on stderr). 2: any other argument shape, refused before any
// read or write. 5: the project's Coordinator is already open. The panel's state is under <home>/fabraik-queue/:
// the cache `queue.json`, Clear marks
// `dismissed.json` and screenshot copies in `shots/`. This folder also holds `machine.json`, which notification
// commands read without changing. They read <configHome>/fabraik/notifications.json and use state only under
// <state>/notifications/. That state can include events saved by earlier installations.
// A refresh removes shot copies no item names once they are a day old. A `shots` that is a link or a file,
// not a real folder, fails the refresh before anything is written.
//
// A refresh rebuilds the cache whole from the collectors, never from the previous cache, so a rebuild after a restart
// gives the same items once each; the cache is derived and deleting it loses nothing. The Clear marks are the one
// thing a refresh keeps, read from disk each time: a repository's digest shows only the merges newer than its mark.
//
// The cache's `fetchedAt` is the oldest time the repositories' own remotes were last fetched, among those whose queue
// document was read and accepted, so the panel can say how stale the merge digest may be; null where any of them reports
// none or none was read. `digestUnread` lists, in record order, the repositories whose digest was not read (their
// collector failed or gave no digest), so the panel never reads a missing digest as a quiet day. `clear-digest` keeps both.
//
// Whatever a refresh cannot read is a line in the cache's `problems`, never an empty or silently partial queue: the
// machine lines first (record, release, panel files, Clear marks), then each repository's lines in record order, each
// `<folder name>: <text>`. A failing repository adds no items and never stops the others; an absent or unreadable
// machine record reads no repository; a cache over the panel's 1 MiB read limit keeps only its problems,
// `digestUnread`, `machineProblems` and `boards`. `machineProblems` holds the lines that belong to no one repository, the
// machine record's and the waiting menus', unprefixed, so a project's Board can draw them beside its own.
//
// The cache's `boards` has one entry per repository the record lists, in record order, except one with no queue reader:
// `{ repository, folder, merged, problems, cards, moves?, places?, orderUnread?, waitsOnUnread? }` from the collector document's
// `board`, or `{ repository, folder, merged, problems, unreadable }` with the cause where the repository failed (its problem line's text), the
// document's board source failed or its `board` is null, absent (a reader that predates it) or not a board document, so the
// panel never reads a board it could not read as an empty one. The queue items of such a repository still show. `folder`
// is the repository's real path, null where it cannot be resolved; `problems` is its own lines of the cache's `problems`
// without their folder prefix; `merged` is the collector's digest whole, whatever the
// Clear marks hide from the queue's digest, null where it was not read; and each card that has a `worktree` carries it as
// a real path, null where it does not resolve. Each card may carry its `version`, 64 lowercase hex, the digest the panel
// draws a Board move against, and a board its `moves` and `places`, true only on a GitHub board, the one that takes moves. A cache
// over the limit first makes every board `unreadable: 'too large to show'`, keeping its `problems` and `lead` and dropping those fields,
// then drops the items as above.
//
// Each board entry also carries `lead`, the state of the repository's lead, read once per refresh for the whole
// machine, after the collectors and only when some repository has an entry, from `<terminals>`: the herdr-core terminal
// list the panel read as the refresh began, as JSON, each terminal's address, status report and running program's
// folder, or `{ unread }` with why the panel could not read it. The lead reports from its own terminal under the app
// `fabraik-lead`, and reports its `unknown` as `error`, which herdr-core has in its place. `here` is
// `[{ terminal, state }]` in list order for each such terminal whose folder, as a real path, is the repository's real
// path, `error` recorded as `unknown`, `[]` meaning no lead is running. In its place `hereUnread` gives why that is not
// known, the first that holds: its queue reader predates the board read (so its lead predates state reporting), the
// refresh was given no list, the panel could not read it or it is not a terminal list, or no lead terminal is the
// repository's while some lead terminal's folder is missing or cannot be resolved, so it may be. `elsewhere` is
// `[{ machine, cards }]`, in the order the board gives the cards, for the machines other than this one whose non-cloud
// claims are on its cards, and null where its board is unreadable; `claimsUnread` lists the cards whose details were
// not read, so whose claims are not known, where any.
//
// An item's `log`, the lead's session log for a failure, is kept only where it is an absolute, normalized path to a
// regular file, not a link, inside the lead's runs folder `<state>/runs/`, `<state>` being
// `${XDG_STATE_HOME:-~/.local/state}/fabraik-lead` read at each refresh; any other is left off the item, which keeps its
// reason, and adds its repository's line naming the card and why.
//
// `open-log` writes nothing. It finds the cached failure item whose `key` is the one given and checks its `log` again
// under that rule, as the file is when it opens, so a log moved or made a link since the refresh opens nothing; only a
// log that passes goes, as the one argument and with no shell, to `xdg-open`, which it waits for. No such item, a
// refused log or a failed `xdg-open` exits 1 naming the key or card and why.
//
// `act` writes nothing local and takes no write lock. Its action is `park`, `answer`, `keep`, `drop` or `pick` and its
// version 64 lowercase hex; a `pick` takes the number of the weekly retro proposal to make a card, in place of a reply.
// It finds the cached item whose `key` is the one given and runs `node
// <repository>/scripts/owner-queue.mjs act --card=<n> --action=<action> --version=<version> [--reply=<reply>]
// [--proposal=<k>]` in that
// repository, with no shell and the collector's timeout; that command reads the queue again and writes to the card only
// for the item the panel drew. No such item, an item without a version (from an older collector) or a refusal there
// exits 1 with the reason. Where the reader's last line is `owner-queue: undo record <record>`, `act` prints the record
// and a newline on stdout for the panel to hold; otherwise it prints nothing.
//
// `undo <key> <action> <record>` takes back a `park`, `keep` or `drop` as the record the reader gave says, and writes
// nothing local. The key's repository must be one the machine record lists; it runs `node
// <repository>/scripts/owner-queue.mjs undo --card=<n> --action=<action> --record=<record>` there, with no shell and the
// collector's timeout, and prints nothing. An unlisted repository, a repository without a queue reader or a refusal
// there exits 1 with the reason.
//
// `move <key> <move> <version> [<place>]` hands a Board move, `ready`, `backlog`, `up` or `place`, on the card in `key` at
// the version the panel drew, and writes nothing local; `place` takes the 1-based place in the build order and no other
// move does. It runs `node <repository>/scripts/owner-queue.mjs move --card=<n> --move=<move> --version=<version>`, with
// `--to=<place>` for `place`, there, with no shell and the collector's timeout, and prints nothing. An unlisted repository, a
// repository without a queue reader or a refusal there exits 1 with the reason.
//
// `show-first <key> <on|off>` hands the Show me first state of the card in `key` to its repository, and writes nothing
// local. It runs `node <repository>/scripts/owner-queue.mjs show-first --card=<n> --state=<on|off>` there, with no shell and
// the collector's timeout, and prints nothing. An unlisted repository, a repository without a queue reader or a refusal
// there exits 1 with the reason.
//
// `report <key>` prints the report of the merge in `key`, `<repository>@<sha>`, the sha 40 or 64 lowercase hex. The
// repository must be one the machine record lists. It runs `node <repository>/scripts/owner-queue.mjs report --sha=<sha>`
// there, with no shell, the collector's timeout and a 64 MiB output limit, and checks the document it prints, the field
// types, the fields each outcome carries and `sha` being the key's, before it writes anything. Under the write lock it then
// stores each screenshot's bytes in `shots/`, named by their sha256 and the type, as an item's copies are, refreshing the
// time of a copy already there so the next refresh's prune keeps it a day, and prints the document with each
// `{ alt, type, data }` replaced by `{ alt, path }`, the copy's place relative to the Herdr home, and never the bytes. A
// screenshot the reader could not read, `{ alt, unread }`, and every other field pass through unchanged. An unlisted
// repository, a repository without a queue reader, a refusal there or a report that fails its check exits 1 with the
// reason, printing and storing nothing.
//
// Under the same lock `report` also keeps what it printed whole in `<home>/fabraik-queue/reports/<sha>-<digest>.json`,
// `<digest>` being eight lowercase hex characters of the repository, so the name stays short whatever its path and two
// repositories holding one merge commit keep apart, as
// `{ "format": 1, "key": "<repository>@<sha>", "report": <the printed document> }`, so a later view shows the merge at
// once. It keeps a `direct` report, and any other unless a part of it may read differently later: an `unread` outcome
// that does not carry `lasting: true`, or a screenshot `{ alt, unread }`. `changed` and `checks` may be unread, as the pull
// request body alone gives them. A refresh removes the regular files in `reports/` over a day old, and keeps every copy in
// `shots/` that a remaining one names, so a kept report never names a pruned copy; an entry that is not a regular file is
// left, and one that does not parse names nothing and goes at a day. A `reports` or `shots` that is a link or a file fails
// refresh and report.
//
// One write lock, the directory `<home>/fabraik-queue/write.lock`, serialises the writes of refresh, clear-digest and report: a refresh holds
// it from the end of the collectors through writing the cache and pruning the shots and kept reports, `clear-digest` for its whole run.
// A lock held for under a minute is waited for up to 2 s, then the command fails writing nothing; an older one is left
// by a crashed command and is removed.
//
// Order: `problem` items (such as a corrupt lead record from an older collector), then tier 1 (merge awaiting a
// yes, blocking question, usage-limit stop), then tier 2 (suggested card, unrecovered failure), then tier 3, the
// digest. Within a category the repositories keep the order the machine record lists them in, and a repository's cards
// run by card number, lowest first; its digest entries run newest first, and its problems keep the order the collector
// gave.

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
  utimesSync, writeFileSync, readSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';

export const COLLECTOR_FORMAT = 1;

const CACHE_FORMAT = 2;
const MARKS_FORMAT = 1;
const STATE_FOLDER = 'fabraik-queue';
const COLLECTOR_TIMEOUT_MS = 120_000;
const COLLECTOR_MAX_BUFFER = 8 * 1024 * 1024;
const SHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHOT_MAX_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// The release receipt's patterns and keys restate the panel installer's `validateReceipt` check, because this file
// loads Node built-ins only.
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RELEASE_KEYS = ['assetId', 'digest', 'id', 'tag'];
// The panel reads no larger cache.
const CACHE_MAX_BYTES = 1024 * 1024;
const USAGE = 'usage: node queue.mjs refresh [<terminals>] --home <dir> | menus [<terminals>] --home <dir> | clear-digest --home <dir> | open-log <key> --home <dir> | act <key> <action> <version> [<reply>|<proposal>] --home <dir> | undo <key> <action> <record> --home <dir> | move <key> <move> <version> [<place>] --home <dir> | report <key> --home <dir> | show-first <key> <on|off> --home <dir> | waiting-menu <terminal> --home <dir> | answer-menu <terminal> <askId> --answer <json> --home <dir> | notify [--initialize] --home <dir> | open-coordinator <repository> <claude|codex> --home <dir>';
// The project's coordinator setting names one of these runtimes (scripts/lib/runtimes.mjs).
const COORDINATOR_RUNTIMES = ['claude', 'codex'];
// The panel's answers, as the repository's `owner-queue.mjs act` takes them, and those of them it can take back; an
// answer and a pick have no Undo.
const ACTIONS = ['park', 'answer', 'keep', 'drop', 'pick'];
const POSITIVE_WHOLE = /^[1-9]\d*$/;
const UNDOABLE = ['park', 'keep', 'drop'];
// The Board moves, as the repository's `owner-queue.mjs move` takes them.
const MOVES = ['ready', 'backlog', 'up', 'place'];
// The Show me first states, as the repository's `owner-queue.mjs show-first` takes them.
const SHOW_FIRST_STATES = ['on', 'off'];
const CARD_KEY = /^(.+)#([1-9]\d*)$/;
const REPORT_KEY = /^(.+)@([0-9a-f]{40}|[0-9a-f]{64})$/;
const REPORT_MAX_BUFFER = 64 * 1024 * 1024;
const UNDO_RECORD = 'owner-queue: undo record ';

const NO_RECORD = 'No machine record: install the queue panel with node <fabraik distribution>/scripts/fabraik.mjs herdr <tag> --repository <dir>';
const NO_READER = 'no queue reader: the Herdr add-on is off there or its release predates the panel';
const TIMED_OUT = `the queue reader timed out after ${COLLECTOR_TIMEOUT_MS / 1000} s`;
const TOO_LARGE = 'The queue is too large to show: its cache would be over 1 MiB.';
const BOARD_TOO_LARGE = 'too large to show';
const BOARD_PREDATES = "its queue reader's release predates the board read";
const NOT_A_BOARD = 'its board is not a board document';
const LEAD_PREDATES = "its lead's release predates state reporting";
const TERMINALS_UNREAD = "Herdr's terminal list could not be read";
const LEAD_FOLDER_UNREAD = "a lead terminal's folder could not be read, so it may be this repository's";
const RECEIPT_DAMAGED = 'Machine record damaged: its release receipt is incomplete, so the panel files cannot be checked';
const QUEUE_BUSY = `the queue is busy: another refresh or Clear held its write lock for ${LOCK_WAIT_MS / 1000} s`;
const SHOT_UNREADABLE = { fact: 'screenshot unreadable', next: "Reopen the job's session on this machine." };

// Older lead reports use this name. The cloud claim label matches scripts/lib/board-claim.mjs.
// These values are repeated because the standalone panel uses only Node built-ins.
const LEAD_AGENT = 'fabraik-lead';
const CLOUD_RUNTIME = 'Claude Code cloud';
// The states of a herdr-core status report; `clear` removes a report, so a terminal list never holds it.
const REPORT_STATES = ['idle', 'working', 'blocked', 'done', 'error'];

const CATEGORY_ORDER = ['problem', 'merge', 'question', 'usage-limit', 'suggested', 'failure', 'digest'];

// The stable identity of an entry across refreshes: a card, a merge commit, or (a problem has neither) its text.
function keyOf(repository, entry) {
  if (entry.category === 'digest') return `${repository}@${entry.sha}`;
  if (entry.category === 'problem') return `${repository}!${entry.problem}`;
  return `${repository}#${entry.card}`;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Mirrors `compareCardIds` in scripts/lib/tracker.mjs: numbers first and by value, then issue keys by team text, digit count
// and digits, so ENG-9 comes before ENG-10.
function compareCards(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (typeof a === 'string') - (typeof b === 'string') || a - b;
  const [teamA, digitsA] = [a.slice(0, a.lastIndexOf('-')), a.slice(a.lastIndexOf('-') + 1)];
  const [teamB, digitsB] = [b.slice(0, b.lastIndexOf('-')), b.slice(b.lastIndexOf('-') + 1)];
  return compareText(teamA, teamB) || digitsA.length - digitsB.length || compareText(digitsA, digitsB);
}

function withinRepository(a, b) {
  if (a.category === 'digest') return Date.parse(b.at) - Date.parse(a.at);
  return a.category === 'problem' ? 0 : compareCards(a.card, b.card);
}

/**
 * The ranked list for `repositories`, in machine-record order: each entry is `{ repository, items, digest }` with
 * the collector document's `items` and `digest` (null where the digest could not be read). Every returned entry is
 * its item or digest entry plus `repository`, `category` ('digest' for a digest entry) and `key`.
 */
export function rank(repositories) {
  const entries = repositories.flatMap(({ repository, items, digest }, index) => [
    ...items,
    ...(digest ?? []).map((merge) => ({ ...merge, category: 'digest' })),
  ].map((entry) => ({ ...entry, repository, key: keyOf(repository, entry), index })));
  return entries
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      || a.index - b.index
      || withinRepository(a, b))
    .map(({ index, ...entry }) => entry);
}

function statePaths(home) {
  const folder = join(home, STATE_FOLDER);
  return {
    record: join(folder, 'machine.json'),
    cache: join(folder, 'queue.json'),
    marks: join(folder, 'dismissed.json'),
    shots: join(folder, 'shots'),
    reports: join(folder, 'reports'),
    lock: join(folder, 'write.lock'),
  };
}

// Refuses a `shots` or `reports` that is a link or a file: a prune through a link would remove files outside the Herdr home.
function requireRealFolder(folder) {
  let stats;
  try {
    stats = lstatSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isDirectory()) throw new Error(`${folder} is not a real folder; move it aside, then refresh`);
}

// Runs `write` holding the write lock; `mkdirSync` fails with EEXIST while another command holds it.
function withWriteLock(lock, write) {
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let held;
    try {
      held = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (held > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    else if (Date.now() >= giveUp) throw new Error(QUEUE_BUSY);
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
  try {
    return write();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// A reader never sees a half-written file: the bytes go to a uniquely named sibling, which is renamed over the target.
function writeAtomically(path, data) {
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, data, { flag: 'wx' });
  renameSync(staging, path);
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (path, value) => writeAtomically(path, jsonText(value));

// A thrown message as one problem or stderr line: its line breaks become single spaces.
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const NOTIFICATION_MAX_BYTES = 1024 * 1024;
const NOTIFICATION_RETENTION_MS = 72 * 60 * 60 * 1000;
const NOTIFICATION_PAIRS = {
  prepare: ['prepared', 'parked'], build: ['built', 'parked'],
  deliver: ['awaiting-push', 'merged', 'parked'], continue: ['awaiting-push', 'merged', 'parked'],
};
const notificationTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z');
export const notificationLogin = (value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
const notificationKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const notificationPath = (value) => typeof value === 'string' && isAbsolute(value) && normalize(value) === value;
export const notificationPair = (phase, disposition) => Object.hasOwn(NOTIFICATION_PAIRS, phase) && NOTIFICATION_PAIRS[phase].includes(disposition);

function notificationDirectory(path, privateMode = false) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || realpathSync(path) !== path
    || (privateMode && (info.mode & 0o777) !== 0o700)) throw new Error('notification directory unavailable');
  return info;
}

function notificationFile(fd, path) {
  const info = fstatSync(fd);
  const named = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
    || !named.isFile() || named.dev !== info.dev || named.ino !== info.ino || named.nlink !== 1
    || realpathSync(path) !== path) throw new Error('notification file unavailable');
  return info;
}

function readNotificationJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (notificationFile(fd, path).size > NOTIFICATION_MAX_BYTES) throw new Error('notification state oversized');
    const bytes = Buffer.alloc(NOTIFICATION_MAX_BYTES + 1);
    let used = 0;
    let size;
    while ((size = readSync(fd, bytes, used, bytes.length - used, null)) > 0) {
      used += size;
      if (used > NOTIFICATION_MAX_BYTES) throw new Error('notification state oversized');
    }
    notificationFile(fd, path);
    return JSON.parse(bytes.subarray(0, used).toString('utf8'));
  } finally { closeSync(fd); }
}

function notificationMorning(value) {
  if (!notificationKeys(value, ['time', 'timeZone'])
    || typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)
    || typeof value.timeZone !== 'string' || /^[+-]/.test(value.timeZone)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); return true; }
  catch { return false; }
}

export function notificationConfiguration(configHome) {
  const path = join(configHome, 'fabraik', 'notifications.json');
  let config;
  try { config = readNotificationJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!notificationKeys(config, ['format', 'login', 'claudeConfigDir', 'trustedDirectory', 'morning']) || config.format !== 1
    || !notificationLogin(config.login) || !notificationMorning(config.morning)
    || !notificationPath(config.claudeConfigDir) || !notificationPath(config.trustedDirectory)) throw new Error('notification configuration unavailable');
  notificationDirectory(config.claudeConfigDir);
  notificationDirectory(config.trustedDirectory);
  if (readdirSync(config.trustedDirectory).length !== 0) throw new Error('notification configuration unavailable');
  for (let parent = config.trustedDirectory;; parent = dirname(parent)) {
    const marker = join(parent, '.git');
    if ((existsSync(marker) && (!lstatSync(marker).isDirectory() || existsSync(join(marker, 'HEAD'))))
      || (existsSync(join(parent, 'HEAD')) && existsSync(join(parent, 'objects')) && existsSync(join(parent, 'refs')))) {
      throw new Error('notification configuration unavailable');
    }
    if (dirname(parent) === parent) break;
  }
  return config;
}

function notificationJournal(value) {
  if (!notificationKeys(value, ['format', 'profile', 'morning', 'sourcesKey', 'recordingStartedAt', 'lastAttemptAt', 'morningKey', 'pending', 'events'])
    || value.format !== 1 || !notificationKeys(value.profile, ['login', 'account']) || !notificationLogin(value.profile.login)
    || !notificationPath(value.profile.account) || !notificationMorning(value.morning)
    || typeof value.sourcesKey !== 'string' || !SHA256_HEX.test(value.sourcesKey)
    || !notificationTime(value.recordingStartedAt) || (value.lastAttemptAt !== null && !notificationTime(value.lastAttemptAt))
    || (value.morningKey !== null && (typeof value.morningKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.morningKey)))
    || !Array.isArray(value.events)) throw new Error('notification journal unavailable');
  const pending = value.pending;
  if (pending !== null && (!notificationKeys(pending, ['name', 'cwd', 'id'])
    || typeof pending.name !== 'string' || !/^fabraik-notify-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.name)
    || !notificationPath(pending.cwd) || (pending.id !== null && (typeof pending.id !== 'string' || !/^[0-9a-f]{8}$/.test(pending.id))))) {
    throw new Error('notification pending unavailable');
  }
  const ids = new Set();
  for (const event of value.events) {
    if (!notificationKeys(event, ['format', 'root', 'login', 'account', 'card', 'phase', 'disposition', 'at', 'id']) || event.format !== 1
      || !notificationPath(event.root) || event.login !== value.profile.login || event.account !== value.profile.account
      || !isPositiveId(event.card) || !notificationPair(event.phase, event.disposition) || !notificationTime(event.at)
      || typeof event.id !== 'string' || !SHA256_HEX.test(event.id) || ids.has(event.id)) throw new Error('notification event unavailable');
    ids.add(event.id);
  }
  return value;
}

// Every reader and writer shares the checked flock inode, never a replaceable lock directory.
function withNotificationJournal(state, work, initial) {
  const directory = join(state, 'notifications');
  if (initial !== undefined) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    notificationDirectory(state);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  notificationDirectory(directory, true);
  const path = join(directory, 'journal.json');
  const lock = join(directory, 'journal.lock');
  const fd = openSync(lock, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (initial === undefined ? 0 : constants.O_CREAT), 0o600);
  try {
    notificationFile(fd, lock);
    execFileSync('/usr/bin/flock', ['-x', '-w', '5', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 6000 });
    notificationDirectory(directory, true);
    notificationFile(fd, lock);
    const absent = () => {
      try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw new Error('notification state already exists');
    };
    if (initial !== undefined) absent();
    return work(notificationJournal(initial === undefined ? readNotificationJson(path) : initial), (journal) => {
      notificationJournal(journal);
      const bytes = jsonText(journal);
      if (Buffer.byteLength(bytes) > NOTIFICATION_MAX_BYTES) throw new Error('notification state oversized');
      const staging = join(directory, `.${randomUUID()}.tmp`);
      let target;
      try {
        target = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(target, bytes);
        fsyncSync(target);
        notificationFile(target, staging);
        notificationDirectory(directory, true);
        // Recheck the established destination before replacing it; never repair linked or missing state.
        if (initial === undefined) readNotificationJson(path);
        else absent();
        notificationFile(fd, lock);
        renameSync(staging, path);
        const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      } finally {
        if (target !== undefined) closeSync(target);
        if (existsSync(staging)) unlinkSync(staging);
      }
    });
  } finally { closeSync(fd); }
}

const notificationConfigHome = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const notificationStateHome = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'fabraik-lead');
const NOTIFICATION_CAP_MS = 3600_000;
const NOTIFICATION_CODES = ['unsupported-tracker', 'login-unavailable', 'source-unavailable', 'ownership-unavailable'];

// Private errors carry only a fixed code; the public boundary always creates an ordinary, cause-free Error.
class NotificationUnavailable extends Error {
  constructor(code) { super(code); }
}
const notificationFail = (code) => { throw new NotificationUnavailable(code); };
function notificationEffect(code, work) {
  try { return work(); }
  catch (error) {
    if (error instanceof NotificationUnavailable) throw error;
    return notificationFail(code);
  }
}

function notificationClock(now, journal) {
  let date;
  try { date = now(); } catch { return notificationFail('clock-unavailable'); }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())
    || (journal && (date.getTime() < Date.parse(journal.recordingStartedAt)
      || (journal.lastAttemptAt !== null && date.getTime() < Date.parse(journal.lastAttemptAt))))) {
    return notificationFail('clock-unavailable');
  }
  return date;
}

function notificationProfile(config, journal) {
  if (journal.profile.login !== config.login || journal.profile.account !== config.claudeConfigDir) {
    notificationFail('ownership-unavailable');
  }
}

function notificationSources(home) {
  return notificationEffect('source-unavailable', () => {
    const record = readRecord(statePaths(home), home);
    if (record.problems.length !== 0 || record.repositories.length === 0) notificationFail('source-unavailable');
    const repositories = [...new Set(record.repositories.map((path) => {
      if (!notificationPath(path)) notificationFail('source-unavailable');
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) notificationFail('source-unavailable');
      return canonical;
    }))];
    return { repositories, key: sha256(JSON.stringify([...repositories].sort())) };
  });
}

function initializeNotifications({ home, configHome = notificationConfigHome(), state = notificationStateHome() }) {
  try {
    if (process.platform !== 'linux') notificationFail('unsupported-platform');
    const config = notificationEffect('configuration-unavailable', () => notificationConfiguration(configHome));
    if (config === null) notificationFail('configuration-unavailable');
    const sources = notificationSources(home);
    const initial = { format: 1, profile: { login: config.login, account: config.claudeConfigDir },
      morning: config.morning, sourcesKey: sources.key, recordingStartedAt: new Date().toISOString(),
      lastAttemptAt: null, morningKey: null, pending: null, events: [] };
    notificationEffect('state-unavailable', () => withNotificationJournal(state, (journal, save) => save(journal), initial));
    console.log('notification: initialized');
  } catch (error) {
    throw new Error(`notification unavailable: ${error instanceof NotificationUnavailable ? error.message : 'state-unavailable'}`);
  }
}

// Resolve a local date once, choosing the first occurrence at a fold and first valid minute after a gap.
function notificationMorningWindow(morning, date) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: morning.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (epoch) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map(({ type, value }) => [type, value]));
    return { key: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  };
  const shift = (key, days) => new Date(Date.parse(`${key}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
  const target = (key) => {
    const noon = Date.parse(`${key}T12:00:00Z`);
    // IANA offsets fit inside this UTC range, including a whole skipped local date.
    for (let minute = noon - 36 * 3600_000; minute <= noon + 36 * 3600_000; minute += 60_000) {
      const value = local(minute);
      if (value.key > key || (value.key === key && value.time >= morning.time)) return minute;
    }
    return notificationFail('clock-unavailable');
  };
  let key = local(date.getTime()).key;
  let end = target(key);
  if (end > date.getTime()) { key = shift(key, -1); end = target(key); }
  return { key, end, start: target(shift(key, -1)) };
}

async function notificationCounts(repositories, config, runCollector) {
  const read = await Promise.all(repositories.map(async (repository) => {
    try {
      const document = await runCollector(repository);
      const value = document?.notifications;
      if (!isObject(document) || document.format !== COLLECTOR_FORMAT
        || !notificationKeys(value, ['login', 'waits', 'unavailable'])
        || !(notificationLogin(value.login) || value.login === null)
        || !Array.isArray(value.waits) || !value.waits.every((wait) => notificationKeys(wait, ['card', 'kind'])
          && isPositiveId(wait.card) && ['question', 'review'].includes(wait.kind))
        || !(value.unavailable === null || NOTIFICATION_CODES.includes(value.unavailable))) {
        return { code: 'source-unavailable' };
      }
      if (value.unavailable !== null) return { code: value.unavailable };
      if (value.login !== config.login) return { code: 'ownership-unavailable' };
      const questions = new Set(value.waits.filter(({ kind }) => kind === 'question').map(({ card }) => card));
      const reviews = new Set(value.waits.filter(({ kind }) => kind === 'review').map(({ card }) => card));
      return { questions: questions.size, reviews: reviews.size };
    } catch { return { code: 'source-unavailable' }; }
  }));
  const unavailable = NOTIFICATION_CODES.find((code) => read.some((value) => value.code === code));
  if (unavailable) notificationFail(unavailable);
  const counts = read.reduce((total, value) => ({ questions: total.questions + value.questions,
    reviews: total.reviews + value.reviews }), { questions: 0, reviews: 0 });
  if (!Object.values(counts).every(Number.isSafeInteger)) notificationFail('source-unavailable');
  return counts;
}

function notificationEnvironment(config) {
  const env = {};
  for (const name of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, CLAUDE_CONFIG_DIR: config.claudeConfigDir };
}

async function notificationNative({ config, pending, exec, now, update, recovery = false }) {
  const began = notificationClock(now).getTime();
  const wallBegan = performance.now();
  const elapsed = () => Math.max(notificationClock(now).getTime() - began, performance.now() - wallBegan);
  const env = notificationEnvironment(config);
  const run = async (argv, code) => {
    const remaining = 180_000 - elapsed();
    if (remaining <= 0) notificationFail('native-timeout');
    try {
      const result = await exec.run('claude', argv, { cwd: pending.cwd, env,
        timeout: Math.max(1, Math.floor(Math.min(30_000, remaining))), windowsHide: true });
      if (!isObject(result) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
        notificationFail('native-status-unavailable');
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof NotificationUnavailable) throw error;
      return notificationFail(code);
    }
  };
  const identify = async () => {
    const stdout = await run(['agents', '--json', '--all', '--cwd', pending.cwd], 'native-status-unavailable');
    let sessions;
    try { sessions = JSON.parse(stdout); } catch { return notificationFail('native-status-unavailable'); }
    if (!Array.isArray(sessions)) notificationFail('native-status-unavailable');
    const states = ['working', 'blocked', 'done', 'failed', 'stopped'];
    const validBackground = (session) => typeof session.id === 'string' && /^[0-9a-f]{8}$/.test(session.id)
      && Number.isFinite(session.startedAt) && states.includes(session.state);
    if (recovery) {
      const named = sessions.filter((session) => isObject(session) && session.name === pending.name);
      if (named.length > 1 || named.some((session) => session.cwd !== pending.cwd || session.kind !== 'background')) {
        notificationFail('native-status-unavailable');
      }
      if (pending.id === null && named.length === 0) {
        const ids = new Set();
        for (const session of sessions) {
          if (!isObject(session) || !notificationPath(session.cwd) || !['interactive', 'background'].includes(session.kind)
            || !Number.isFinite(session.startedAt)
            || (Object.hasOwn(session, 'name') && typeof session.name !== 'string')) notificationFail('native-status-unavailable');
          if (session.kind === 'background') {
            if (!validBackground(session) || ids.has(session.id)) notificationFail('native-status-unavailable');
            ids.add(session.id);
          }
        }
        return null;
      }
    }
    const matches = sessions.filter((session) => isObject(session) && session.name === pending.name
      && session.cwd === pending.cwd && session.kind === 'background');
    const session = matches[0];
    if (matches.length !== 1 || !validBackground(session)
      || (pending.id !== null && session.id !== pending.id)
      || sessions.some((other) => other !== session && isObject(other) && other.id === session.id)) {
      notificationFail('native-status-unavailable');
    }
    if (pending.id === null) { pending.id = session.id; update({ ...pending }); }
    return session.state;
  };
  const cleanup = async (status) => {
    if (status !== 'stopped') await run(['stop', pending.id], 'cleanup-unavailable');
    update(null);
  };
  if (recovery) {
    const status = await identify();
    if (status === null) update(null);
    else await cleanup(status);
    return;
  }
  await run(['--bg', '--remote-control', pending.name, '--name', pending.name, '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--', pending.prompt], 'native-launch-unavailable');
  const pollBegan = elapsed();
  let status;
  try {
    for (;;) {
      status = await identify();
      if (['done', 'failed', 'stopped'].includes(status)) break;
      const remaining = Math.min(120_000 - (elapsed() - pollBegan), 180_000 - elapsed());
      if (remaining <= 0) notificationFail('native-timeout');
      try { await exec.wait(Math.max(1, Math.floor(Math.min(5000, remaining)))); }
      catch { notificationFail('native-timeout'); }
      if (elapsed() - pollBegan >= 120_000) notificationFail('native-timeout');
    }
  } catch (error) {
    // Failed identity reads authorize no stop, even when an earlier poll found the session.
    if (error instanceof NotificationUnavailable && error.message === 'native-timeout' && pending.id !== null) {
      await cleanup(status);
    }
    throw error;
  }
  await cleanup(status);
  if (status !== 'done') notificationFail('native-failed');
}

/** Runs one account-scoped notification tick; completion observes the native turn, never phone delivery. */
export async function notificationTick({ home, configHome = notificationConfigHome(), state = notificationStateHome(),
  now = () => new Date(), runCollector = runCollectorProcess,
  exec = { run: (file, argv, options) => execFileAsync(file, argv, options), wait }, output = console }) {
  try {
    if (process.platform !== 'linux') notificationFail('unsupported-platform');
    const config = notificationEffect('configuration-unavailable', () => notificationConfiguration(configHome));
    if (config === null) { output.log('notification: off'); return; }
    const transaction = (work) => notificationEffect('state-unavailable', () => withNotificationJournal(state, (journal, save) => {
      notificationProfile(config, journal);
      notificationClock(now, journal);
      return work(journal, save);
    }));
    const capped = (journal, date) => journal.lastAttemptAt !== null
      && date.getTime() - Date.parse(journal.lastAttemptAt) < NOTIFICATION_CAP_MS;
    const initial = transaction((journal) => journal);
    if (capped(initial, notificationClock(now, initial))) { output.log('notification: capped'); return; }
    const sources = notificationSources(home);
    const counts = await notificationCounts(sources.repositories, config, runCollector);
    let cleaned = false;
    const update = (name, pending) => transaction((journal, save) => {
      if (journal.pending?.name !== name) notificationFail('state-unavailable');
      journal.pending = pending;
      save(journal);
    });
    // A coverage reset preserves pending cleanup and the burned hourly reservation.
    const snapshot = transaction((journal, save) => {
      if (capped(journal, notificationClock(now, journal))) return null;
      if (journal.morning.time !== config.morning.time || journal.morning.timeZone !== config.morning.timeZone
        || journal.sourcesKey !== sources.key) {
        journal.morning = config.morning;
        journal.sourcesKey = sources.key;
        journal.recordingStartedAt = notificationClock(now, journal).toISOString();
        journal.morningKey = null;
        save(journal);
      }
      return journal;
    });
    if (snapshot === null) { output.log('notification: capped'); return; }
    if (snapshot.pending !== null) {
      notificationEffect('configuration-unavailable', () => notificationDirectory(snapshot.pending.cwd));
      const name = snapshot.pending.name;
      await notificationNative({ config, pending: snapshot.pending, exec, now, recovery: true,
        update: (pending) => update(name, pending) });
      cleaned = true;
    }
    const reserved = transaction((journal, save) => {
      const date = notificationClock(now, journal);
      if (capped(journal, date)) return { status: 'capped' };
      if (journal.pending !== null) notificationFail('state-unavailable');
      const target = notificationMorningWindow(config.morning, date);
      const due = target.end > Date.parse(journal.recordingStartedAt) && journal.morningKey !== target.key;
      if (!due && counts.questions + counts.reviews === 0) return { status: cleaned ? 'cleanup-completed' : 'empty' };
      const work = new Set(journal.events.filter((event) => sources.repositories.includes(event.root)
        && Date.parse(event.at) >= Math.max(target.start, Date.parse(journal.recordingStartedAt))
        && Date.parse(event.at) < target.end).map((event) => JSON.stringify([event.root, event.card]))).size;
      const sentence = `${due ? `Saved work records cover ${work} items. ` : ''}Waiting: ${counts.questions} questions and ${counts.reviews} reviews. Check Herdr for full status.`;
      const pending = { name: `fabraik-notify-${randomUUID()}`, cwd: config.trustedDirectory, id: null };
      journal.lastAttemptAt = date.toISOString();
      if (due) journal.morningKey = target.key;
      journal.pending = pending;
      journal.events = journal.events.filter((event) => date.getTime() - Date.parse(event.at) <= NOTIFICATION_RETENTION_MS);
      save(journal);
      return { pending, prompt: `Reply with exactly this sentence and nothing else: ${sentence}` };
    });
    if (reserved.status) { output.log(`notification: ${reserved.status}`); return; }
    await notificationNative({ config, pending: { ...reserved.pending, prompt: reserved.prompt }, exec, now,
      update: (pending) => update(reserved.pending.name, pending === null ? null
        : { name: pending.name, cwd: pending.cwd, id: pending.id }) });
    output.log('notification: completed');
  } catch (error) {
    throw new Error(`notification unavailable: ${error instanceof NotificationUnavailable ? error.message : 'state-unavailable'}`);
  }
}

// The sha256 of the file at `path`, or null where there is none.
function fileSha256(path) {
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Each repository's Clear mark, the sha of the newest merge it had when the owner cleared it; none before any Clear.
// A file that is not JSON or holds no `marks` object throws.
function readMarks(path) {
  let marks;
  try {
    marks = JSON.parse(readFileSync(path, 'utf8'))?.marks;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) {
    throw new Error('dismissed.json holds no marks object');
  }
  return marks;
}

const isPositiveId = (value) => Number.isSafeInteger(value) && value > 0;
// A card is a positive integer or, for Linear, Jira and Azure Boards, an issue key such as `ENG-12`.
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const isCardId = (value) => isPositiveId(value) || (typeof value === 'string' && ISSUE_KEY.test(value));

const isReleaseReceipt = (release) => isObject(release)
  && Object.keys(release).sort().join() === RELEASE_KEYS.join()
  && typeof release.tag === 'string' && RELEASE_TAG.test(release.tag)
  && isPositiveId(release.id) && isPositiveId(release.assetId)
  && typeof release.digest === 'string' && RELEASE_DIGEST.test(release.digest);

/**
 * The machine record's repositories, each once in the order first listed, its release tag (null where it was not
 * installed from a release or its receipt is incomplete) and its problem lines. An absent or unreadable record gives no
 * repositories and its one line; a release receipt that is not the installer's receipt (exactly a tag, id, asset id and
 * sha256 digest of the right shapes) of format 1 or 2 with a non-empty map of sha256 hashes, and a `derived` map of sha256
 * hashes where one is present, gives its one damaged line, and a
 * release whose panel files at `<home>/mods/fabraik-queue/` differ from the receipt gives its line; both still give the
 * repositories.
 */
function readRecord(paths, home) {
  let record;
  try {
    record = JSON.parse(readFileSync(paths.record, 'utf8'));
  } catch (error) {
    const problem = error.code === 'ENOENT' ? NO_RECORD : `Machine record unreadable: ${oneLine(error.message)}`;
    return { repositories: [], tag: null, problems: [problem] };
  }
  const { repositories: listed, format, release, files, derived } = record ?? {};
  if (!Array.isArray(listed) || listed.length === 0
    || !listed.every((folder) => typeof folder === 'string' && folder !== '')) {
    return {
      repositories: [],
      tag: null,
      problems: ['Machine record unreadable: its repositories are not a non-empty list of folders'],
    };
  }
  const repositories = [...new Set(listed)];
  if (release === null || release === undefined) return { repositories, tag: null, problems: ['not installed from a release'] };
  const hashes = isObject(files) ? Object.entries(files) : [];
  const isHash = (hash) => typeof hash === 'string' && SHA256_HEX.test(hash);
  if (!isReleaseReceipt(release) || ![1, 2].includes(format) || hashes.length === 0 || !hashes.every(([, hash]) => isHash(hash))
    || (derived !== undefined && !(isObject(derived) && Object.values(derived).every(isHash)))) {
    return { repositories, tag: null, problems: [RECEIPT_DAMAGED] };
  }
  const panel = join(home, 'mods', 'fabraik-queue');
  const differ = hashes.some(([name, hash]) => fileSha256(join(panel, name)) !== hash);
  return { repositories, tag: release.tag, problems: differ ? [`files differ from release ${release.tag}`] : [] };
}

// The merges newer than `mark` (the digest runs newest first); all of them where the mark is not among them.
function unmarked(digest, mark) {
  const at = digest?.findIndex((merge) => merge.sha === mark) ?? -1;
  return at < 0 ? digest : digest.slice(0, at);
}

const execFileAsync = promisify(execFile);

// The default runner's refusal for a repository without the collector, told apart from a collector that failed.
class NoQueueReader extends Error {}

async function runCollectorProcess(repository) {
  const reader = join(repository, 'scripts', 'owner-queue.mjs');
  if (!existsSync(reader)) throw new NoQueueReader(NO_READER);
  const { stdout } = await execFileAsync(process.execPath, [reader], {
    cwd: repository,
    timeout: COLLECTOR_TIMEOUT_MS,
    maxBuffer: COLLECTOR_MAX_BUFFER,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

const isString = (value) => typeof value === 'string';
const listOf = (value, valid) => Array.isArray(value) && value.every(valid);
const isTime = (value) => isString(value) && !Number.isNaN(Date.parse(value));

// What a merge item carries besides its card: the proof it is missing, or a decision card with its screenshots (a
// non-empty list) or the statement that it has no visual change.
function hasMergeProof(item) {
  if (item.missing !== undefined) return isObject(item.missing) && isString(item.missing.fact) && isString(item.missing.next);
  return isString(item.decisionCard)
    && (item.visual === 'none' || (listOf(item.screenshots, isString) && item.screenshots.length > 0));
}

// The field each category needs beyond its card and title (a problem has neither, only its text).
const CATEGORY_FIELDS = {
  merge: hasMergeProof,
  question: (item) => isString(item.question),
  'usage-limit': (item) => isString(item.reason),
  failure: (item) => isString(item.reason),
};

const isCount = (value) => Number.isSafeInteger(value) && value > 0;

// A weekly retro's card draft as the panel draws it: its number, project, title and three sections, a label or a type,
// and, where present, its routing value and the card it was made.
function isProposal(draft) {
  return isObject(draft) && isCount(draft.n) && [draft.repository, draft.title, draft.problem, draft.build].every(isString)
    && listOf(draft.criteria, isString) && (draft.label === undefined) !== (draft.type === undefined)
    && isString(draft.label ?? draft.type) && (draft.workstream === undefined || isString(draft.workstream))
    && (draft.card === undefined || (isObject(draft.card) && isString(draft.card.repository) && isCount(draft.card.number)));
}

// Whether `item` is a collector item of the shape its category is drawn from; the collector's categories are the ranked
// ones but the digest. Whatever the category, its screenshots, where present, are a list of strings, its version 64
// lowercase hex, its `answerable` true, its scope a string, its `heldOn` one unbroken word, its write-up a string or
// `{ plain }` and its proposals a list of card drafts.
function isItem(item) {
  if (!isObject(item) || item.category === 'digest' || !CATEGORY_ORDER.includes(item.category)) return false;
  if (item.screenshots !== undefined && !listOf(item.screenshots, isString)) return false;
  if (item.version !== undefined && !(isString(item.version) && SHA256_HEX.test(item.version))) return false;
  if ((item.answerable !== undefined && item.answerable !== true) || (item.scope !== undefined && !isString(item.scope))) return false;
  if (item.heldOn !== undefined && !(isString(item.heldOn) && /^\S+$/.test(item.heldOn))) return false;
  if (item.writeUp !== undefined && !isString(item.writeUp) && !isPlain(item.writeUp)) return false;
  if (item.proposals !== undefined && !listOf(item.proposals, isProposal)) return false;
  if (item.category === 'problem') return isString(item.problem);
  return isCardId(item.card) && isString(item.title) && (CATEGORY_FIELDS[item.category]?.(item) ?? true);
}

// Whether the document's sources, items, digest and fetch time have the shapes the aggregator reads and the panel draws:
// a source is a name and whether it was read (with the error text where it was not), each item has the fields of its
// category (and a list of strings as its screenshots, where it has them), each digest entry a sha, a subject and a time
// `Date.parse` reads, and the fetch time is absent, null or such a time.
function isQueueDocument({ sources, items, digest, fetchedAt }) {
  return listOf(sources, (source) => isObject(source) && isString(source.name) && typeof source.ok === 'boolean'
      && (source.ok || isString(source.error)) && (source.details === undefined || isString(source.details)))
    && listOf(items, isItem)
    && (digest === null || listOf(digest, (merge) => isObject(merge) && isString(merge.sha) && isString(merge.subject)
      && isTime(merge.at)))
    && (fetchedAt === undefined || fetchedAt === null || isTime(fetchedAt));
}

// A card of the board section: its number or issue key, title and column (a Status or null), then its place, open blockers,
// claim and what it waits on (a ranked category or null), and why its details were not read where they were not; the last three
// are absent from a card whose details were not read. Its answered marker is absent or exactly `true`, where the owner
// has answered the version it waits on. Its outcome is absent, null, `{ unread }` or `{ text, more }`;
// its version is absent or 64 lowercase hex; its job worktree is absent, null or a path; its Show me first marker is absent,
// a boolean or `{ unread }`.
const isBoardCard = (card) => isObject(card) && isCardId(card.card) && isString(card.title)
  && (card.column === null || isString(card.column))
  && (card.order === undefined || isPositiveId(card.order))
  && listOf(card.blockers, isCardId)
  && (card.claim === undefined || card.claim === null || (isObject(card.claim) && isString(card.claim.machine)
    && (card.claim.runtime === undefined || isString(card.claim.runtime))))
  && (card.waitsOn === undefined || card.waitsOn === null
    || (CATEGORY_ORDER.includes(card.waitsOn) && card.waitsOn !== 'problem' && card.waitsOn !== 'digest'))
  && (card.answered === undefined || card.answered === true)
  && (card.unread === undefined || isString(card.unread))
  && (card.version === undefined || (isString(card.version) && SHA256_HEX.test(card.version)))
  && (card.outcome === undefined || card.outcome === null
    || (isObject(card.outcome) && isString(card.outcome.unread))
    || (isObject(card.outcome) && isString(card.outcome.text) && typeof card.outcome.more === 'boolean'))
  && (card.worktree === undefined || card.worktree === null || isString(card.worktree))
  && (card.showFirst === undefined || typeof card.showFirst === 'boolean' || isUnread(card.showFirst));

// Whether `board` is the document's board section: its cards, where present whether the panel may move them and place
// them, and where present why their order or what they wait on was not read.
const isBoard = (board) => isObject(board) && listOf(board.cards, isBoardCard)
  && (board.moves === undefined || typeof board.moves === 'boolean')
  && (board.places === undefined || typeof board.places === 'boolean')
  && (board.orderUnread === undefined || isString(board.orderUnread))
  && (board.waitsOnUnread === undefined || listOf(board.waitsOnUnread, isString));

// The document's board as its cache entry less the repository: the cards, or why they cannot be shown.
function boardOf({ board, sources }) {
  if (board === undefined) return { unreadable: BOARD_PREDATES };
  if (board === null) return { unreadable: sources.find((source) => source.name === 'board' && !source.ok)?.error ?? NOT_A_BOARD };
  if (!isBoard(board)) return { unreadable: NOT_A_BOARD };
  const { coordinator } = board;
  if (coordinator === undefined) return board;
  if (isUnread(coordinator) && firstLine(coordinator.unread)) {
    return { ...board, coordinator: { unread: firstLine(coordinator.unread).slice(0, 500) } };
  }
  // The saved runtime may be uninstalled. The mod repeats this check because it reads the cache without loading this file.
  const valid = isObject(coordinator) && Object.keys(coordinator).length === 2 && COORDINATOR_RUNTIMES.includes(coordinator.runtime)
    && listOf(coordinator.installed, (runtime) => COORDINATOR_RUNTIMES.includes(runtime)) && coordinator.installed.length > 0
    && new Set(coordinator.installed).size === coordinator.installed.length;
  return valid ? board : { ...board, coordinator: { unread: 'the queue reader returned invalid coordinator settings' } };
}

const firstLine = (text) => text.trim().split(/\r?\n/)[0];

// Whether `entry` is a terminal of the panel's list as far as the panel reads it: an address, an own status report
// (null where the terminal has none) and the folder of its running program where herdr-core gives one.
const isTerminal = (entry) => isObject(entry) && isString(entry.address)
  && (entry.report === null || (isObject(entry.report) && REPORT_STATES.includes(entry.report.state)
    && (entry.report.app === undefined || entry.report.app === null || isString(entry.report.app))))
  && (entry.folder === undefined || entry.folder === null || isString(entry.folder));

// The real path of an absolute `folder`, or null where it is not one or cannot be resolved.
function realFolder(folder) {
  if (!isString(folder) || !isAbsolute(folder)) return null;
  try {
    return realpathSync(folder);
  } catch {
    return null;
  }
}

/**
 * The lead terminals of the panel's terminal list `text` (the refresh's argument, undefined where none was given),
 * `{ terminals: [{ terminal, state, folder }] }` in list order with `error` recorded as `unknown` and each `folder` a
 * real path or null where it is missing or cannot be resolved; or `{ unread }`, why the list is unknown: none given,
 * the panel's `{ unread }` cause, or text that is not a terminal list. A list is checked whole before any terminal is
 * set aside.
 */
function leadTerminals(text) {
  if (text === undefined) return { unread: `${TERMINALS_UNREAD}: the refresh was given none` };
  let list = null;
  try {
    list = JSON.parse(text);
  } catch {
    // Not JSON: told apart below from a list only by not being one.
  }
  if (isObject(list) && isString(list.unread)) return { unread: `${TERMINALS_UNREAD}: ${firstLine(list.unread)}` };
  if (!listOf(list, isTerminal)) return { unread: `${TERMINALS_UNREAD}: it is not a terminal list` };
  // A `machine/address` terminal belongs to another machine; only a bare address is this machine's.
  return {
    terminals: list.filter((entry) => entry.report?.app === LEAD_AGENT && !entry.address.includes('/')).map(({ address, report, folder }) => ({
      terminal: address,
      state: report.state === 'error' ? 'unknown' : report.state,
      folder: realFolder(folder),
    })),
  };
}

// The machines other than this one that claim a card in `cards`, each with its cards in board order; cloud claims and
// cards whose details were not read have none to count.
function claimsElsewhere(cards) {
  const byMachine = new Map();
  for (const { card, claim } of cards) {
    if (claim && claim.machine !== hostname() && claim.runtime !== CLOUD_RUNTIME) {
      byMachine.set(claim.machine, [...(byMachine.get(claim.machine) ?? []), card]);
    }
  }
  return [...byMachine].map(([machine, claimed]) => ({ machine, cards: claimed }));
}

// A board entry's `lead` from the lead terminals read once for the machine (`leadTerminals`).
function leadOf({ folder, cards, unreadable }, { terminals, unread }) {
  const lead = { elsewhere: cards ? claimsElsewhere(cards) : null };
  const claimsUnread = cards?.filter((card) => card.unread !== undefined).map((card) => card.card) ?? [];
  if (claimsUnread.length > 0) lead.claimsUnread = claimsUnread;
  if (unreadable === BOARD_PREDATES) return { hereUnread: LEAD_PREDATES, ...lead };
  if (unread !== undefined) return { hereUnread: unread, ...lead };
  const here = terminals.filter((entry) => folder !== null && entry.folder === folder)
    .map(({ terminal, state }) => ({ terminal, state }));
  if (here.length === 0 && terminals.some((entry) => entry.folder === null)) return { hereUnread: LEAD_FOLDER_UNREAD, ...lead };
  return { here, ...lead };
}

/**
 * Every repository's board entry that has one, in record order, each with its own problem lines and its `lead`; the
 * terminal list `terminals` is read once, and only where there is an entry.
 */
function boardsWithLeads(repositories, read, terminals) {
  const withRealWorktree = (card) => (card.worktree === undefined ? card : { ...card, worktree: realFolder(card.worktree) });
  const boards = repositories.flatMap((repository, index) => {
    const { board, digest, problems } = read[index];
    if (board === null) return [];
    return [{
      repository,
      folder: realFolder(repository),
      ...board,
      ...(board.cards && { cards: board.cards.map(withRealWorktree) }),
      merged: digest,
      problems,
    }];
  });
  if (boards.length === 0) return boards;
  const leads = leadTerminals(terminals);
  return boards.map((board) => ({ ...board, lead: leadOf(board, leads) }));
}

/**
 * Why `log` is not a session log of the lead's runs folder, or undefined where it is one: it must be an absolute,
 * normalized path to a regular file that is not a link, whose real path lies inside the runs folder's real path, so a
 * link anywhere along the way cannot lead outside it.
 */
function whyLogRefused(log) {
  if (!isString(log)) return 'is not a path';
  if (!isAbsolute(log)) return 'is not an absolute path';
  if (normalize(log) !== log) return 'is not a normalized path';
  let stats;
  try {
    stats = lstatSync(log);
  } catch (error) {
    return `cannot be read: ${error.code ?? oneLine(error.message)}`;
  }
  if (stats.isSymbolicLink()) return 'is a symbolic link';
  if (!stats.isFile()) return 'is not a regular file';
  const runs = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'fabraik-lead', 'runs');
  let inside;
  try {
    inside = realpathSync(log).startsWith(`${realpathSync(runs)}${sep}`);
  } catch (error) {
    return `cannot be checked against the lead's runs folder ${runs}: ${error.code ?? oneLine(error.message)}`;
  }
  return inside ? undefined : `is outside the lead's runs folder ${runs}`;
}

/**
 * One repository's problem lines, items, digest and board from its collector document, with the document's `fetchedAt`
 * (null where it has none) only for a document that was read and accepted. Its `board` is the cache's board entry less
 * the repository (`boardOf`), the cause of its failure being its problem line, and null for a repository with no queue
 * reader, which has no entry. An unreadable folder, a missing, timed-out or
 * failed collector, output that is not a queue document (not an object, or a source, item, digest entry or fetch time
 * that breaks the shapes `isQueueDocument` checks), or a document of another format is one problem line with no items, a null digest and no `fetchedAt`;
 * each source the document could not read, and each item whose `log` `whyLogRefused` refuses, which is kept without that
 * `log`, is a problem line beside its items.
 */
async function readRepository(repository, runCollector, tag) {
  const failed = (problem, rawLine) => ({
    problems: rawLine === undefined ? [problem] : [problem, rawLine], items: [], digest: null, board: { unreadable: problem },
  });
  try {
    readdirSync(repository);
  } catch (error) {
    return failed(`folder unreadable: ${oneLine(error.message)}`);
  }
  let document;
  try {
    document = await runCollector(repository);
  } catch (error) {
    if (error instanceof NoQueueReader) return { ...failed(error.message), board: null };
    if (error.killed) return failed(TIMED_OUT);
    const message = String(error.message);
    if (!message.startsWith('Command failed: ')) return failed(`the queue reader failed: ${oneLine(message)}`);
    const reason = oneLine(message.split('\n').slice(1).join('\n'));
    return failed(`the queue reader failed: ${reason || 'it stopped without saying why'}`, `queue reader raw failure: ${oneLine(message)}`);
  }
  const notDocument = 'the queue reader failed: its output is not a queue document';
  if (!isObject(document)) return failed(notDocument);
  if (document.format !== COLLECTOR_FORMAT) {
    return failed(`on release ${document.release ?? 'no release'}, panel on release ${tag ?? 'no release'}: its items are not shown`);
  }
  if (!isQueueDocument(document)) return failed(notDocument);
  const refusedLogs = [];
  const items = document.items.map((item) => {
    if (item.log === undefined) return item;
    const why = whyLogRefused(item.log);
    if (why === undefined) return item;
    refusedLogs.push(`card ${item.card} failure log ${why}`);
    const { log, ...kept } = item;
    return kept;
  });
  return {
    fetchedAt: document.fetchedAt ?? null,
    problems: [
      ...document.sources.filter((source) => !source.ok).flatMap((source) => [
        `${source.name} could not be read: ${source.error}`,
        ...(source.details === undefined ? [] : [`${source.name} raw failure: ${source.details}`]),
      ]),
      ...refusedLogs,
    ],
    items,
    digest: document.digest,
    board: boardOf(document),
  };
}

// The screenshot's bytes, or undefined where it cannot be read or is not a regular file of at most 8 MiB; a link is
// refused, never followed.
function readShot(source) {
  try {
    const stats = lstatSync(source);
    return stats.isFile() && stats.size <= SHOT_MAX_BYTES ? readFileSync(source) : undefined;
  } catch {
    return undefined;
  }
}

// Herdr's image() draws nothing outside the Herdr home, so each screenshot is copied into `shots/`, named by the
// sha256 of its bytes, and the item names the copy relative to the Herdr home with `/` separators. An item with an
// unreadable screenshot becomes missing proof naming it, and none of its screenshots is copied.
function withShotCopies(item, shots) {
  if (item.screenshots === undefined) return item;
  const shotBytes = item.screenshots.map(readShot);
  if (shotBytes.includes(undefined)) {
    return { card: item.card, title: item.title, category: 'merge', missing: SHOT_UNREADABLE };
  }
  mkdirSync(shots, { recursive: true });
  return {
    ...item,
    screenshots: item.screenshots.map((source, index) => storeShot(shots, shotBytes[index], extname(source).toLowerCase())),
  };
}

// Keeps `bytes` in `shots/` as `<sha256><extension>` and returns the copy's place relative to the Herdr home. A copy
// already there is not rewritten but gets a fresh time, so `pruneShots` keeps it a day from now.
function storeShot(shots, bytes, extension) {
  const name = `${sha256(bytes)}${extension}`;
  const copy = join(shots, name);
  if (existsSync(copy)) utimesSync(copy, new Date(), new Date());
  else writeAtomically(copy, bytes);
  return `${STATE_FOLDER}/shots/${name}`;
}

// Removes the kept reports in `reports/` that are more than a day old, and returns the names of the copies in `shots/`
// the others name. An entry that is not a regular file is left and names nothing, and a file that does not parse names
// nothing; an absent folder has nothing to remove.
function keptShots(reports, now) {
  let names;
  try {
    names = readdirSync(reports);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const named = [];
  for (const name of names) {
    const file = join(reports, name);
    const stats = lstatSync(file);
    if (!stats.isFile()) continue;
    if (now - stats.mtimeMs > SHOT_MAX_AGE_MS) {
      unlinkSync(file);
      continue;
    }
    try {
      named.push(...JSON.parse(readFileSync(file, 'utf8')).report.screenshots.map((shot) => basename(shot.path)));
    } catch {
      // Names nothing; it goes when it is a day old.
    }
  }
  return named;
}

// Removes the copies in `shots/` that `referenced` does not name and that are more than a day old; an absent folder has
// nothing to remove.
function pruneShots(shots, referenced, now) {
  let names;
  try {
    names = readdirSync(shots);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const copy = join(shots, name);
    if (!referenced.has(name) && now - statSync(copy).mtimeMs > SHOT_MAX_AGE_MS) unlinkSync(copy);
  }
}

// The oldest of the fetch times, as the collector wrote it; null where there is none or any of them is null.
function oldestFetch(times) {
  if (times.length === 0 || times.includes(null)) return null;
  return times.reduce((oldest, time) => (Date.parse(time) < Date.parse(oldest) ? time : oldest));
}

// Writes the cache, or where it would be over the panel's read limit first with every board unreadable, keeping its problem
// lines, and its lead cut to `here` or `hereUnread` (the machines claiming its cards, and the cards unread, may be as large as
// the board), then with only its problems and the too-large line (it keeps `digestUnread` and `machineProblems` either way), then prunes the kept reports over a day old and the
// shots neither it nor a remaining kept report names.
function writeCache(paths, readStartedAt, problems, machineProblems, items, digestUnread, fetchedAt, boards) {
  const now = new Date();
  const cache = (shown) => jsonText({
    format: CACHE_FORMAT, readStartedAt, refreshedAt: now.toISOString(), fetchedAt, digestUnread, machineProblems, ...shown,
  });
  const tooLarge = (shown) => Buffer.byteLength(cache(shown)) > CACHE_MAX_BYTES;
  let shown = { problems, items, boards };
  if (tooLarge(shown)) {
    shown = {
      ...shown,
      boards: boards.map(({ repository, problems: own, lead: { here, hereUnread } }) => ({
        repository, unreadable: BOARD_TOO_LARGE, problems: own, lead: { ...(here === undefined ? { hereUnread } : { here }), elsewhere: null },
      })),
    };
  }
  if (tooLarge(shown)) shown = { ...shown, problems: [...problems, TOO_LARGE], items: [] };
  writeAtomically(paths.cache, cache(shown));
  const referenced = new Set([
    ...shown.items.flatMap((item) => item.screenshots ?? []).map((name) => basename(name)),
    ...keptShots(paths.reports, now.getTime()),
  ]);
  pruneShots(paths.shots, referenced, now.getTime());
}

/**
 * Rebuilds `<home>/fabraik-queue/queue.json` from the collector of every repository the machine record lists.
 * `runCollector(repository)` returns, or resolves to, that repository's collector document; by default it runs
 * `node <repository>/scripts/owner-queue.mjs` there, all repositories at once. It throws before writing anything where
 * `shots` or `reports` is not a real folder. `terminals` is the herdr-core terminal list text the panel read as the refresh began,
 * undefined where none was given; once the collectors have finished it reads lead state from it, once and only where
 * some repository has a board entry, then holds the write lock through its writes. The cache records when its read began,
 * so a reader can tell a read begun after it asked from one begun before.
 */
export async function refresh({ home, runCollector = runCollectorProcess, terminals }) {
  const readStartedAt = new Date().toISOString();
  const paths = statePaths(home);
  requireRealFolder(paths.shots);
  requireRealFolder(paths.reports);
  const record = readRecord(paths, home);
  if (record.repositories.length === 0) return withWriteLock(paths.lock, () => writeCache(paths, readStartedAt, record.problems, record.problems, [], [], null, []));
  const read = await Promise.all(record.repositories.map((repository) => readRepository(repository, runCollector, record.tag)));
  const boards = boardsWithLeads(record.repositories, read, terminals);
  return withWriteLock(paths.lock, () => {
    const collected = record.repositories.map((repository, index) => ({
      repository,
      items: read[index].items.map((item) => withShotCopies(item, paths.shots)),
      digest: read[index].digest,
    }));
    const problems = [...record.problems];
    // Read under the lock and written before it is released, so a Clear made while the collectors ran still holds.
    let marks = {};
    try {
      marks = readMarks(paths.marks);
    } catch (error) {
      problems.push(`Clear marks unreadable: ${oneLine(error.message)}; the digest is shown whole`);
    }
    problems.push(...record.repositories.flatMap((repository, index) => read[index].problems
      .map((problem) => `${basename(repository)}: ${problem}`)));
    const ranked = rank(collected.map((entry) => ({ ...entry, digest: unmarked(entry.digest, marks[entry.repository]) })));
    const menus = readMenus(home, terminals);
    problems.push(...menus.problems);
    const machineProblems = [...record.problems, ...menus.problems];
    const after = ranked.findIndex((item) => ['suggested', 'failure', 'digest'].includes(item.category));
    const items = after === -1 ? [...ranked, ...menus.items] : [...ranked.slice(0, after), ...menus.items, ...ranked.slice(after)];
    const digestUnread = record.repositories.filter((repository, index) => read[index].digest === null);
    const accepted = read.filter((entry) => entry.fetchedAt !== undefined);
    writeCache(paths, readStartedAt, problems, machineProblems, items, digestUnread, oldestFetch(accepted.map((entry) => entry.fetchedAt)), boards);
  });
}

/**
 * Marks each repository's newest merge in the cache as read, then rewrites the cache without the digest, keeping its
 * other fields. It holds the write lock for its whole run.
 */
export function clearDigest({ home }) {
  const paths = statePaths(home);
  withWriteLock(paths.lock, () => {
    const cache = JSON.parse(readFileSync(paths.cache, 'utf8'));
    const newest = {};
    // The cache lists a repository's digest newest first, so its first entry is the newest.
    for (const item of cache.items) if (item.category === 'digest') newest[item.repository] ??= item.sha;
    writeJson(paths.marks, { format: MARKS_FORMAT, marks: { ...readMarks(paths.marks), ...newest } });
    writeJson(paths.cache, { ...cache, items: cache.items.filter((item) => item.category !== 'digest') });
  });
}

/**
 * Opens the log of the cached failure item whose `key` is `key` with `xdg-open`, after checking it again with
 * `whyLogRefused` as the file is now. It throws, opening nothing, where there is no such item or the log is refused, and
 * throws naming the error where `xdg-open` fails.
 */
function openLog({ home, key }) {
  const { items } = JSON.parse(readFileSync(statePaths(home).cache, 'utf8'));
  const item = items.find((entry) => entry.category === 'failure' && entry.key === key);
  if (item === undefined) throw new Error(`${key}: no cached failure item`);
  const why = whyLogRefused(item.log);
  if (why !== undefined) throw new Error(`card ${item.card} failure log ${why}`);
  execFileSync('xdg-open', [item.log], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Runs `args` through `repository`'s `scripts/owner-queue.mjs` with no shell and returns its stdout, of at most
 * `maxBuffer` bytes. It throws, running
 * nothing, where the repository has no queue reader, and throws the reader's reason, named by `key`, where it refuses or
 * fails.
 */
async function runReader(key, repository, args, maxBuffer = COLLECTOR_MAX_BUFFER) {
  const reader = join(repository, 'scripts', 'owner-queue.mjs');
  if (!existsSync(reader)) throw new Error(`${key}: ${NO_READER}`);
  try {
    const { stdout } = await execFileAsync(process.execPath, [reader, ...args], {
      cwd: repository,
      timeout: COLLECTOR_TIMEOUT_MS,
      maxBuffer,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new Error(error.killed ? TIMED_OUT : `${key}: ${oneLine(error.stderr || error.message)}`);
  }
}

/**
 * Hands `action` on the cached item whose `key` is `key`, with `version` and any `reply`, to its repository's
 * `scripts/owner-queue.mjs act`; a `pick`'s reply is its proposal number, handed on as `--proposal`. It returns the undo record the reader's last line gives, or null where it gives none.
 * It throws, running nothing, where there is no such item, the item has no version or the repository has no queue
 * reader, and throws the reader's reason where it refuses or fails.
 */
async function act({ home, key, action, version, reply }) {
  const { items } = JSON.parse(readFileSync(statePaths(home).cache, 'utf8'));
  const item = items.find((entry) => entry.key === key);
  if (item === undefined) throw new Error(`${key}: no cached item`);
  if (item.version === undefined) throw new Error(`${key}: the cached item has no version, so its queue reader cannot take an answer`);
  const args = ['act', `--card=${item.card}`, `--action=${action}`, `--version=${version}`,
    ...(reply === undefined ? [] : [`--${action === 'pick' ? 'proposal' : 'reply'}=${reply}`])];
  const last = (await runReader(key, item.repository, args)).split('\n').findLast((line) => line.trim() !== '');
  return last?.startsWith(UNDO_RECORD) ? last.slice(UNDO_RECORD.length) : null;
}

// Throws, running nothing, where the machine record does not list `repository`, the one `key` names.
function requireListed(home, key, repository) {
  if (!readRecord(statePaths(home), home).repositories.includes(repository)) {
    throw new Error(`${key}: the machine record does not list ${repository}`);
  }
}

// Check the registered root and both parts of the opener path before running code from the project.
function openCoordinator({ home, repository, runtime }) {
  requireListed(home, 'open coordinator', repository);
  if (realFolder(repository) !== repository) throw new Error("Register the project's real root to open its Coordinator.");
  const scripts = realFolder(join(repository, 'scripts'));
  const opener = realFolder(join(repository, 'scripts', 'coordinator.mjs'));
  const inside = (path) => path?.startsWith(repository.endsWith(sep) ? repository : `${repository}${sep}`);
  if (!inside(scripts) || !inside(opener) || !statSync(opener, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('scripts/coordinator.mjs must be a regular file inside the registered project.');
  }
  try {
    execFileSync(process.execPath, [opener, 'open', '--runtime', runtime], {
      cwd: repository, encoding: 'utf8', timeout: COLLECTOR_TIMEOUT_MS, maxBuffer: COLLECTOR_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return 0;
  } catch (error) {
    const { status, stderr, stdout, code, message } = error;
    const cause = firstLine(stderr || stdout || (code ? message : '')).slice(0, 500);
    if (status === 5) {
      console.log(cause || 'Coordinator is already open.');
      return 5;
    }
    throw new Error(cause || `the Coordinator opener exited with status ${status}`);
  }
}

// The `<repository>#<card>` key's repository and card, checked against the machine record.
function listedCard(home, key) {
  const [, repository, card] = CARD_KEY.exec(key);
  requireListed(home, key, repository);
  return { repository, card };
}

/**
 * Hands the reader's undo `record` for `action` on the card in `key`, `<repository>#<card>`, to the repository's
 * `scripts/owner-queue.mjs undo`. It throws, running nothing, where the machine record does not list the repository or
 * it has no queue reader, and throws the reader's reason where it refuses or fails.
 */
async function undo({ home, key, action, record }) {
  const { repository, card } = listedCard(home, key);
  await runReader(key, repository, ['undo', `--card=${card}`, `--action=${action}`, `--record=${record}`]);
}

/**
 * Hands the Board `move` with `version` on the card in `key`, `<repository>#<card>`, to the repository's
 * `scripts/owner-queue.mjs move`. It throws, running nothing, where the machine record does not list the repository or
 * it has no queue reader, and throws the reader's reason where it refuses or fails.
 */
async function moveCard({ home, key, move, version, place }) {
  const { repository, card } = listedCard(home, key);
  await runReader(key, repository, ['move', `--card=${card}`, `--move=${move}`, `--version=${version}`, ...(place === undefined ? [] : [`--to=${place}`])]);
}

/**
 * Hands the Show me first `state` of the card in `key`, `<repository>#<card>`, to the repository's
 * `scripts/owner-queue.mjs show-first`. It throws, running nothing, where the machine record does not list the repository
 * or it has no queue reader, and throws the reader's reason where it refuses or fails.
 */
async function markCard({ home, key, state }) {
  const { repository, card } = listedCard(home, key);
  await runReader(key, repository, ['show-first', `--card=${card}`, `--state=${state}`]);
}

const SHOT_TYPES = ['png', 'jpeg', 'gif', 'webp'];
const WAIT_LEVELS = ['when-needed', 'on-screen'];
const isUnread = (value) => isObject(value) && Object.keys(value).join() === 'unread' && isString(value.unread);
const readOrUnread = (valid) => (value) => valid(value) || isUnread(value);
const isPlain = (value) => isObject(value) && Object.keys(value).join() === 'plain' && isString(value.plain);
// The fields the report of a pull request's merge always carries, with their checks.
const REPORT_FIELDS = {
  pull: (value) => isObject(value) && Number.isInteger(value.number) && isString(value.title) && isString(value.url),
  card: readOrUnread((value) => isObject(value) && Number.isInteger(value.number) && isString(value.title)),
  changed: readOrUnread((value) => isString(value) || isPlain(value)),
  checks: readOrUnread((value) => listOf(value, isString)),
  noScreen: (value) => typeof value === 'boolean',
  outcome: (value) => Object.hasOwn(OUTCOME_FIELDS, value),
  screenshots: Array.isArray,
};
// The fields only an outcome carries, with their checks: each of `level`, `waiting`, `holds`, `cause` and `lasting`
// appears on the outcomes listed here and on no other. `lasting` is `true` where no later read changes an unread cause.
const OUTCOME_FIELDS = {
  nothing: { level: (value) => WAIT_LEVELS.includes(value) },
  waited: { waiting: isString },
  disagrees: { level: (value) => [...WAIT_LEVELS, 'always'].includes(value), holds: (value) => listOf(value, isString) },
  unread: { cause: isString, lasting: (value) => value === undefined || value === true },
};

// Whether `shot` is `{ alt, unread }` or `{ alt, type, data }` with data in base64 of at most 8 MiB once decoded.
function validShot(shot) {
  if (!isObject(shot) || !isString(shot.alt)) return false;
  if (Object.hasOwn(shot, 'unread')) return isString(shot.unread) && Object.keys(shot).length === 2;
  return Object.keys(shot).length === 3 && SHOT_TYPES.includes(shot.type) && isString(shot.data)
    && Buffer.byteLength(shot.data, 'base64') <= SHOT_MAX_BYTES;
}

// The name of the first part of the reader's `document` that breaks the report format for merge `sha`, or undefined
// where it keeps it.
function reportFault(document, sha) {
  if (!isObject(document)) return 'document';
  if (document.format !== 1) return 'format';
  if (document.sha !== sha) return 'sha';
  if (Object.hasOwn(document, 'direct')) return document.direct === true && Object.keys(document).length === 3 ? undefined : 'direct';
  const field = Object.keys(REPORT_FIELDS).find((name) => !REPORT_FIELDS[name](document[name]));
  if (field !== undefined) return field;
  const carried = OUTCOME_FIELDS[document.outcome];
  const extra = ['level', 'waiting', 'holds', 'cause', 'lasting']
    .find((name) => (carried[name] === undefined ? Object.hasOwn(document, name) : !carried[name](document[name])));
  if (extra !== undefined) return extra;
  const shot = document.screenshots.findIndex((entry) => !validShot(entry));
  return shot === -1 ? undefined : `screenshot ${shot + 1}`;
}

// A kept report's file name: the merge sha and the 32-bit FNV-1a hash of the repository in eight hex characters, so the
// name stays short whatever the repository's path. main.js computes the same name.
function keptReportName(repository, sha) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < repository.length; at += 1) hash = Math.imul(hash ^ repository.charCodeAt(at), 0x01000193);
  return `${sha}-${(hash >>> 0).toString(16).padStart(8, '0')}.json`;
}

/**
 * Prints the report of the merge in `key`, `<repository>@<sha>`, from the repository's `scripts/owner-queue.mjs report`,
 * as JSON with each screenshot's bytes stored in `shots/` under the write lock and replaced by its `path`, and keeps a
 * report with no part that may read differently later in `reports/`. It throws,
 * running and storing nothing, where the machine record does not list the repository, throws the reader's reason where it
 * refuses or fails, and throws naming the part where its document breaks the report format, before it stores anything.
 */
async function report({ home, key }) {
  const [, repository, sha] = REPORT_KEY.exec(key);
  requireListed(home, key, repository);
  let document;
  try {
    document = JSON.parse(await runReader(key, repository, ['report', `--sha=${sha}`], REPORT_MAX_BUFFER));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const fault = reportFault(document, sha);
  if (fault !== undefined) throw new Error(`${key}: the reader's report has a malformed ${fault}`);
  const stores = document.screenshots?.some((shot) => Object.hasOwn(shot, 'data'));
  const keeps = document.direct === true
    || ((document.outcome !== 'unread' || document.lasting === true) && !document.screenshots.some((shot) => Object.hasOwn(shot, 'unread')));
  if (!stores && !keeps) return JSON.stringify(document);
  const paths = statePaths(home);
  return JSON.stringify(withWriteLock(paths.lock, () => {
    requireRealFolder(paths.shots);
    requireRealFolder(paths.reports);
    let shown = document;
    if (stores) {
      mkdirSync(paths.shots, { recursive: true });
      shown = {
        ...document,
        screenshots: document.screenshots.map((shot) => (Object.hasOwn(shot, 'data')
          ? { alt: shot.alt, path: storeShot(paths.shots, Buffer.from(shot.data, 'base64'), `.${shot.type}`) }
          : shot)),
      };
    }
    if (keeps) {
      mkdirSync(paths.reports, { recursive: true });
      writeJson(join(paths.reports, keptReportName(repository, sha)), { format: 1, key, report: shown });
    }
    return shown;
  }));
}

// --- Waiting menus ---------------------------------------------------------------------------------------------------
//
// A coordinated job that waits at one of Claude's menus records its ask under `<home>/data/fabraik-asks/<terminal>/<askId>/`
// (`ask.json`, then `answer.json`, `taken.json`, `rejected.json` and `end.json`, as `scripts/lib/owner-menu.mjs` writes them).
// A refresh lists each terminal's newest ask that waits or holds an answer, and every older one whose answer was not
// delivered, as a `menu` item: `terminal`, `askId`, `answerable` (true only while the terminal is blocked, the hook that waits
// for the answer is alive, the ask is its terminal's newest and holds no answer), `delivery` (`sent`, `delivered` or
// `undelivered`) and, for an undelivered one, its `cause`, with the answer's `words`. Each item carries its ask's
// `repository`, the job's main checkout, or `repositoryUnread`, why the hook could not read it, and a permission prompt's
// `whole`, true only where the recorded call is shown whole, and a deliver question's `version`, the `head` and `identity`
// its job asked about, or `versionUnread`, why the job could not read it. An answer reads delivered only on the job's own signal: the
// `end.json` its PostToolUse hook, or for a permission prompt its PermissionRequest hook as it decides, wrote. An ask or
// answer file that is corrupt, over its cap or names another ask, and an ask whose card is not a positive whole number
// written as text, as the job's mark holds it, is a problem line and never a menu item with controls.
// `answer-menu` writes the one `answer.json` of the named ask by create-if-absent. Nothing here sends input to a terminal.
// `waiting-menu`'s refusal ends with a clause saying the relay allows typing into the job exactly where the terminal's ask
// store holds only readable asks and none is in flight.
//
// The limits, labels and answer checks below, the refusal of an allow on a call not shown whole included, repeat
// `scripts/lib/owner-menu.mjs` (its NOT_WHOLE among them) and `scripts/lib/owner-queue.mjs` (its REPLY_MAX, CREDENTIALS and
// `redact`), because this file runs outside any repository with Node built-ins only;
// `scripts/lib/herdr-queue.test.mjs` pins the answer checks to the hook's.

const MENU_ASK_MAX = 1024 * 1024;
const MENU_ANSWER_MAX = 64 * 1024;
const MENU_REPLY_MAX = 500;
// How long after a take with no proof Claude Code applied it the answer still counts as in flight: the owner decided such a take
// counts as applied 10 seconds after it was made.
const MENU_APPLIED_MS = 10_000;
const MENU_TYPING_CLAUSE = '; the relay allows typing into the job';
const MENU_CREDENTIAL = 'it looks like it holds a credential';
const MENU_NOT_WHOLE = 'the panel did not show this call whole, so it cannot allow it';
const MENU_TERMINAL = /^[A-Za-z0-9_-]+$/;
const MENU_ASK_ID = /^[0-9a-f]{32}$/;
const MENU_LABELS = { permission: ['Allow once', 'Deny'], plan: ['Approve plan', 'Keep planning'] };
const CREDENTIALS = [
  [/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted]'],
  [/\bgithub_pat_\w+/g, '[redacted]'],
  [/\bsk-ant-[\w-]+/g, '[redacted]'],
  [/\b(bearer\s+)\S+/gi, '$1[redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@'],
  [/(token|secret|password|key)=[^\s&]+/gi, '$1=[redacted]'],
];
const redact = (text) => CREDENTIALS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);

const menuFolder = (home, ...names) => join(home, 'data', 'fabraik-asks', ...names);

// The text of the regular file `path`, refused where it is a link, not a file or over `max` bytes.
function readMenuFile(path, max) {
  const stats = lstatSync(path);
  if (!stats.isFile()) throw new Error(`${basename(path)} is not a regular file`);
  if (stats.size > max) throw new Error(`${basename(path)} is over ${max} bytes`);
  return readFileSync(path, 'utf8');
}

// Mirrors `wellFormed` in owner-menu.mjs: AskUserQuestion's list of distinct questions with labelled options.
const menuQuestions = (questions) => Array.isArray(questions) && questions.length > 0 && questions.every((q) => isObject(q)
  && isString(q.question) && isString(q.header) && typeof q.multiSelect === 'boolean' && Array.isArray(q.options) && q.options.length > 0
  && q.options.every((option) => isObject(option) && isString(option.label)))
  && new Set(questions.map((q) => q.question)).size === questions.length;

const isNonBlankString = (value) => isString(value) && value.trim() !== '';

// The ask record in `folder`, which must be ask `id` of `terminal`, or throws why it is not one.
function readMenuAsk(terminal, id, folder) {
  const ask = JSON.parse(readMenuFile(join(folder, 'ask.json'), MENU_ASK_MAX));
  if (!isObject(ask) || ask.format !== 1) throw new Error('ask.json is not a format 1 record');
  if (ask.id !== id) throw new Error('ask.json names another ask than its folder');
  if (ask.terminal !== terminal) throw new Error('ask.json names another terminal than its folder');
  if (!Number.isFinite(ask.askedAt) || !Number.isSafeInteger(ask.pid) || ask.pid <= 0) throw new Error('ask.json holds no time or hook process');
  if (!isString(ask.card) || !/^[1-9]\d*$/.test(ask.card)) throw new Error('ask.json holds no card written as a positive whole number');
  if (!['question', 'permission', 'plan'].includes(ask.kind)) throw new Error('ask.json is of no kind this panel answers');
  if (ask.kind === 'question' && !menuQuestions(ask.questions)) throw new Error('ask.json holds no well formed questions');
  if (ask.kind === 'plan' && !isString(ask.plan)) throw new Error('ask.json holds no plan');
  if (ask.kind === 'permission' && !(isNonBlankString(ask.toolName) && isNonBlankString(ask.input))) {
    throw new Error('ask.json holds no tool or input');
  }
  if (!isString(ask.repository) && !isString(ask.repositoryUnread)) throw new Error('ask.json records neither its repository nor why it was not read');
  return ask;
}

// The `askedAt` of ask `id` as the hook counts it for a newer ask (owner-menu.mjs `readAsk`), or undefined where its file is no
// such record. It needs no more than the hook does, so a record the menus cannot list, or a linked one, still supersedes; a file
// that is not a regular one is never opened, since a named pipe would block the read.
function menuAskedAt(id, folder) {
  try {
    const file = join(folder, 'ask.json');
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MENU_ASK_MAX) throw new Error('ask.json is no regular file within the size cap');
    const ask = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(ask) && ask.format === 1 && ask.id === id && Number.isFinite(ask.askedAt) ? ask.askedAt : undefined;
  } catch {
    return undefined;
  }
}

// What a valid ask `ask` shows of its content: its questions, plan or input, and for a permission whether it was shown whole.
function menuContent(ask) {
  const content = ask.kind === 'question' ? { questions: ask.questions } : ask.kind === 'plan' ? { plan: ask.plan } : { input: ask.input };
  return ask.kind === 'permission' ? { ...content, whole: ask.whole === true } : content;
}

// Whether the ask in `folder` holds an answer, a take or an end.
const menuClosed = (folder) => ['answer', 'taken', 'end'].some((name) => existsSync(join(folder, `${name}.json`)));

// The owner's words as one line, refused as the queue panel refuses a reply (owner-menu.mjs `replyWords`).
function menuWords(text) {
  const words = isString(text) ? text.replace(/\s+/g, ' ').trim() : '';
  if (words === '' || [...words].length > MENU_REPLY_MAX) throw new Error(`an answer's text needs 1 to ${MENU_REPLY_MAX} characters`);
  if (redact(words) !== words) throw new Error(MENU_CREDENTIAL);
  return words;
}

function menuOnlyKeys(record, allowed, what) {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${what} holds keys it may not: ${extra.join(', ')}`);
}

// What question `q`'s answer entry says: its chosen labels in option order, then its text (owner-menu.mjs `joinedAnswer`).
function menuJoined(q, entry) {
  if (!isObject(entry)) throw new Error(`the answer to "${q.header}" is not a record`);
  menuOnlyKeys(entry, ['choices', 'text'], `the answer to "${q.header}"`);
  const labels = q.options.map((option) => option.label);
  const choices = entry.choices ?? [];
  if (!Array.isArray(choices) || ('choices' in entry && choices.length === 0)) throw new Error(`the choices for "${q.header}" are not a list of labels`);
  if (choices.some((choice) => !labels.includes(choice)) || new Set(choices).size !== choices.length) {
    throw new Error(`the choices for "${q.header}" are not distinct labels it offers`);
  }
  const text = 'text' in entry ? [menuWords(entry.text)] : [];
  if (choices.length + text.length === 0) throw new Error(`"${q.header}" has no choice and no text`);
  if (!q.multiSelect && choices.length + text.length !== 1) throw new Error(`"${q.header}" takes one choice or a text`);
  return [...labels.filter((label) => choices.includes(label)), ...text].join(', ');
}

// The words answer `record` gives ask `ask`, or throws why the hook would refuse it (owner-menu.mjs `decide`).
function menuAnswerWords(ask, record) {
  if (!isObject(record) || record.format !== 1) throw new Error('the answer is not a format 1 record');
  if (record.askId !== ask.id) throw new Error('the answer names another ask');
  if (record.by !== 'panel' && record.by !== 'coordinator') throw new Error('the answer names no panel or coordinator');
  if (ask.kind === 'question') {
    menuOnlyKeys(record, ['format', 'askId', 'by', 'answers'], 'the answer');
    if (!isObject(record.answers)) throw new Error('the answer holds no answers record');
    const texts = ask.questions.map((q) => q.question);
    menuOnlyKeys(record.answers, texts, 'the answers record');
    const missing = texts.filter((text) => !Object.hasOwn(record.answers, text));
    if (missing.length > 0) throw new Error(`the answers record misses ${missing.length} question(s)`);
    const values = ask.questions.map((q) => menuJoined(q, record.answers[q.question]));
    return values.length === 1 ? values[0] : ask.questions.map((q, index) => `${q.header}: ${values[index]}`).join('; ');
  }
  menuOnlyKeys(record, ['format', 'askId', 'by', 'choice', 'text'], 'the answer');
  if (('choice' in record) === ('text' in record)) throw new Error('the answer needs exactly one of a choice and a text');
  if ('text' in record) return menuWords(record.text);
  if (!MENU_LABELS[ask.kind].includes(record.choice)) throw new Error("the answer's choice is not one this menu offers");
  if (record.choice === 'Allow once' && ask.whole !== true) throw new Error(MENU_NOT_WHOLE);
  return record.choice;
}

// Whether process `pid` is running; a process that exists but is another account's still is.
function menuAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The names of the folders in `path` (none where it is missing); a link or a file is not one.
function menuNames(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// The names of every entry in `path` as the hook lists the candidates for a newer ask (none where it is missing), directory links
// included.
function menuEntries(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Whether ask `id`'s `ask.json` exists and is no regular file (a link to a pipe included), which may leave the hook stuck reading it.
function menuStuck(id, folder) {
  try {
    return !statSync(join(folder, id, 'ask.json')).isFile();
  } catch {
    return false;
  }
}

// Each terminal's status state from the panel's terminal list `text`, as a Map by address; undefined where it is not one.
function menuTerminalStates(text) {
  try {
    const list = JSON.parse(text);
    if (listOf(list, isTerminal)) return new Map(list.filter((entry) => !entry.address.includes('/')).map((entry) => [entry.address, entry.report?.state ?? 'none']));
  } catch {
    // Not JSON: told apart from a list only by not being one.
  }
  return undefined;
}

// The record in `folder`'s file `name`: undefined where there is none, the parsed JSON, or throws why it is unreadable.
function menuRecord(folder, name, max) {
  const path = join(folder, name);
  return existsSync(path) ? JSON.parse(readMenuFile(path, max)) : undefined;
}

// The state of one valid ask `ask` as a menu item, or undefined where it shows nothing. `superseded` is whether a newer ask of
// its terminal exists; `state` is the terminal's state, undefined where it is not in the list. A file that cannot be read
// is a problem line and the ask shows nothing.
function menuItem(ask, folder, { superseded, stuck, state, problems }) {
  let answer;
  let words;
  let end;
  let rejected;
  try {
    answer = menuRecord(folder, 'answer.json', MENU_ANSWER_MAX);
    if (answer !== undefined) words = menuAnswerWords(ask, answer);
    end = menuRecord(folder, 'end.json', MENU_ASK_MAX);
    rejected = menuRecord(folder, 'rejected.json', MENU_ASK_MAX);
    if ((end !== undefined && !isString(end?.reason)) || (rejected !== undefined && !isString(rejected?.reason))) throw new Error('end.json or rejected.json holds no reason');
  } catch (error) {
    problems.push(`Waiting menu ${ask.terminal}/${ask.id}: a file of the ask cannot be used: ${oneLine(error.message)}`);
    return undefined;
  }
  const taken = existsSync(join(folder, 'taken.json'));
  const alive = menuAlive(ask.pid);
  const blocked = state === 'blocked';
  const where = isString(ask.repository) ? { repository: ask.repository } : { repositoryUnread: ask.repositoryUnread };
  const { version } = ask;
  const asked = isObject(version) && isString(version.head) && isString(version.identity) ? { version: { head: version.head, identity: version.identity } }
    : isString(ask.versionUnread) ? { versionUnread: ask.versionUnread } : {};
  const item = { category: 'menu', key: `menu:${ask.terminal}/${ask.id}`, terminal: ask.terminal, askId: ask.id, card: ask.card, ...where, ...asked,
    kind: ask.kind, toolName: ask.toolName, askedAt: ask.askedAt, ...menuContent(ask),
    answerable: false };
  const given = { ...item, ...(words !== undefined && { words }) };
  const undelivered = (cause) => ({ ...given, delivery: 'undelivered', cause });
  if (end !== undefined) {
    if (end.reason === 'delivered') return { ...given, delivery: 'delivered' };
    return words === undefined ? undefined : undelivered(`the job did not take it: ${end.reason}`);
  }
  if (answer === undefined && !taken) {
    if (rejected !== undefined) return undelivered(`the job's hook set it aside: ${rejected.reason}`);
    return superseded || stuck || !alive || !blocked ? undefined : { ...item, answerable: true };
  }
  if (state === undefined) return undelivered("the job's session is gone");
  if (taken) {
    if (superseded) return undelivered('a newer ask of the job replaced it');
    if (alive) return { ...given, delivery: 'sent' };
    return undelivered('the job did not report that it received it, so it may not have');
  }
  if (superseded) return undelivered('a newer ask of the job replaced it before the job took it');
  if (!alive) return undelivered("the job's hook ended before it took it");
  return blocked ? { ...given, delivery: 'sent' } : undelivered('the job is no longer waiting at this menu');
}

/**
 * The `menu` items and problem lines of the ask store under `home`, read against the terminal list `terminals` (the refresh's
 * argument). Each terminal shows its newest ask where it waits or holds an answer, and any older ask whose answer was not
 * delivered.
 */
function readMenus(home, terminals) {
  const problems = [];
  const items = [];
  const root = menuFolder(home);
  const names = menuNames(root);
  if (names.length === 0) return { items, problems };
  const states = menuTerminalStates(terminals);
  if (states === undefined) problems.push(`Waiting menus: ${TERMINALS_UNREAD}, so none can be answered or read as delivered`);
  for (const terminal of names.filter((name) => MENU_TERMINAL.test(name))) {
    const asks = [];
    const failed = new Map();
    for (const id of menuNames(join(root, terminal))) {
      try {
        if (!MENU_ASK_ID.test(id)) throw new Error('its folder is not named for an ask id');
        asks.push(readMenuAsk(terminal, id, join(root, terminal, id)));
      } catch (error) {
        failed.set(id, `Waiting menu ${terminal}/${id}: ${oneLine(error.message)}`);
      }
    }
    asks.sort((a, b) => a.askedAt - b.askedAt);
    const read = new Map(asks.map((ask) => [ask.id, ask.askedAt]));
    const entries = menuEntries(join(root, terminal));
    const stuck = entries.filter((id) => menuStuck(id, join(root, terminal)));
    for (const [id, line] of failed) if (!stuck.includes(id)) problems.push(line);
    for (const id of stuck) problems.push(`Waiting menu ${terminal}/${id}: ask.json is no regular file, so the job's hook may be stuck`);
    const hookTimes = entries.map((id) => read.get(id) ?? menuAskedAt(id, join(root, terminal, id)));
    const newest = asks.at(-1);
    if (newest !== undefined && entries.some((id, index) => !read.has(id) && !failed.has(id) && hookTimes[index] > newest.askedAt)) {
      problems.push(`Waiting menu ${terminal}/${newest.id}: a newer ask record of the job replaced it`);
    }
    for (const [index, ask] of asks.entries()) {
      const superseded = index !== asks.length - 1 || hookTimes.some((askedAt) => askedAt > ask.askedAt);
      const state = states?.has(terminal) ? states.get(terminal) : undefined;
      const item = menuItem(ask, join(root, terminal, ask.id), { superseded, stuck: stuck.length > 0, state, problems });
      if (item !== undefined && (!superseded || item.delivery === 'undelivered')) items.push(item);
    }
  }
  return { items, problems };
}

/**
 * The ask `askId` of `terminal` where it still waits: its file is valid, it holds no answer, take or end, its hook is alive and
 * no newer ask of its terminal exists. It throws why not, naming the terminal and the ask.
 */
function waitingAsk(home, terminal, askId) {
  const folder = menuFolder(home, terminal, askId);
  const refuse = (why) => new Error(`${terminal}/${askId}: ${why}`);
  let ask;
  try {
    ask = readMenuAsk(terminal, askId, folder);
  } catch (error) {
    throw refuse(`no such waiting ask: ${error.message}`);
  }
  if (menuClosed(folder)) throw refuse('it is already answered or ended');
  if (!menuAlive(ask.pid)) throw refuse('its hook has ended, so the job no longer waits for an answer');
  for (const other of menuEntries(menuFolder(home, terminal)).filter((name) => name !== askId)) {
    if (menuStuck(other, menuFolder(home, terminal))) throw refuse('no waiting ask: a record of the job is no regular file, so its hook may be stuck; he answers in the job\'s tab');
    if (menuAskedAt(other, menuFolder(home, terminal, other)) > ask.askedAt) throw refuse('a newer ask of the job has replaced it');
  }
  return ask;
}

// Whether process `pid` is shown gone: looking it up failed with ESRCH. Any other outcome, a refused pid included, is not.
function menuGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// Whether `ask`'s `end.json` is the job's own proof that a question or plan was delivered or answered in its tab. A file that
// cannot be read, or holds another shape, is none.
function menuSettled(ask, folder) {
  if (ask.kind === 'permission') return false;
  try {
    const end = menuRecord(folder, 'end.json', MENU_ASK_MAX);
    const expected = end?.reason === 'delivered' ? { reason: 'delivered', via: 'panel' } : { reason: "answered in the job's tab" };
    return isObject(end) && JSON.stringify(Object.entries(end).sort()) === JSON.stringify(Object.entries(expected).sort());
  } catch {
    return false;
  }
}

// Whether `ask`'s answer may still be on its way into the job: its hook is not shown gone, or its take is not settled and either
// was made less than `MENU_APPLIED_MS` before `now` or cannot be read as a regular file.
function menuInFlight(ask, folder, now) {
  if (!menuGone(ask.pid)) return true;
  let taken;
  try {
    taken = lstatSync(join(folder, 'taken.json'));
  } catch (error) {
    return error.code !== 'ENOENT' && !menuSettled(ask, folder);
  }
  return !menuSettled(ask, folder) && (!taken.isFile() || now() - taken.mtimeMs < MENU_APPLIED_MS);
}

// Whether every entry of `terminal`'s ask store is a real folder holding a readable ask and none is in flight; true for an empty store.
function menuClear(home, terminal, now) {
  const folder = menuFolder(home, terminal);
  return menuEntries(folder).every((id) => {
    try {
      if (!lstatSync(join(folder, id)).isDirectory()) return false;
      return !menuInFlight(readMenuAsk(terminal, id, join(folder, id)), join(folder, id), now);
    } catch {
      return false;
    }
  });
}

/**
 * The one ask of `terminal` that `answerMenu` would accept, as JSON: its newest readable ask, where that waits and no other
 * readable ask of the job waits too. It throws why none can be answered, writing nothing; where the terminal's ask store is
 * clear, as `menuClear` judges at the clock `now`, the message ends with the clause that the relay allows typing into the job.
 */
export function waitingMenu({ home, terminal, now = Date.now }) {
  try {
    return waitingMenuJson({ home, terminal });
  } catch (error) {
    if (menuClear(home, terminal, now)) error.message += MENU_TYPING_CLAUSE;
    throw error;
  }
}

// `waitingMenu` without the clause: the ask of `terminal` that waits, or throws why none does.
function waitingMenuJson({ home, terminal }) {
  const refuse = (why) => new Error(`${terminal}: no waiting ask: ${why}`);
  const names = menuNames(menuFolder(home, terminal)).filter((name) => MENU_ASK_ID.test(name));
  if (names.length === 0) throw refuse('the job has asked nothing at its menus');
  const asks = [];
  let firstError;
  for (const name of names) {
    try {
      asks.push(readMenuAsk(terminal, name, menuFolder(home, terminal, name)));
    } catch (error) {
      firstError ??= error.message;
    }
  }
  if (asks.length === 0) throw refuse(`no ask of the job can be read: ${firstError}`);
  const waits = (other) => menuAlive(other.pid) && !menuClosed(menuFolder(home, terminal, other.id));
  const newestAt = Math.max(...asks.map((other) => other.askedAt));
  const newest = asks.filter((other) => other.askedAt === newestAt);
  const ask = waitingAsk(home, terminal, (newest.find(waits) ?? newest[0]).id);
  const waiting = asks.filter(waits).length;
  if (waiting > 1) throw new Error(`${terminal}: ${waiting} asks of the job wait at once, so which one the owner answered is unclear; he answers in the job's tab`);
  return JSON.stringify({ terminal, askId: ask.id, card: ask.card, kind: ask.kind, toolName: ask.toolName, askedAt: ask.askedAt, ...menuContent(ask) });
}

/**
 * Writes `payload`, the answer record as JSON, as the `answer.json` of the ask `askId` of `terminal`, only where that exact ask
 * still waits, as `waitingAsk` checks. The answer is checked as the hook checks it, then created where none is, by a link from
 * a staged file, so two answers cannot both land. It throws, writing nothing, where any of that fails.
 */
export function answerMenu({ home, terminal, askId, payload }) {
  const folder = menuFolder(home, terminal, askId);
  const refuse = (why) => new Error(`${terminal}/${askId}: ${why}`);
  const ask = waitingAsk(home, terminal, askId);
  if (Buffer.byteLength(payload) > MENU_ANSWER_MAX) throw refuse(`the answer is over ${MENU_ANSWER_MAX} bytes`);
  let record;
  try {
    record = JSON.parse(payload);
  } catch (error) {
    throw refuse(`the answer is not JSON: ${error.message}`);
  }
  try {
    menuAnswerWords(ask, record);
  } catch (error) {
    throw refuse(error.message);
  }
  const staged = join(folder, `answer.json.${randomUUID()}.tmp`);
  writeFileSync(staged, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  try {
    linkSync(staged, join(folder, 'answer.json'));
  } catch (error) {
    throw refuse(error.code === 'EEXIST' ? 'it is already answered' : error.message);
  } finally {
    unlinkSync(staged);
  }
}

const COMMANDS = {
  notify: ({ home, operands }) => operands.length === 0 ? notificationTick({ home }) : initializeNotifications({ home }),
  refresh: ({ home, operands: [terminals] }) => refresh({ home, terminals }),
  menus: ({ home, operands: [terminals] }) => JSON.stringify(readMenus(home, terminals)),
  'clear-digest': ({ home }) => clearDigest({ home }),
  'open-log': ({ home, operands: [key] }) => openLog({ home, key }),
  act: ({ home, operands: [key, action, version, reply] }) => act({ home, key, action, version, reply }),
  undo: ({ home, operands: [key, action, record] }) => undo({ home, key, action, record }),
  move: ({ home, operands: [key, move, version, place] }) => moveCard({ home, key, move, version, place }),
  report: ({ home, operands: [key] }) => report({ home, key }),
  'show-first': ({ home, operands: [key, state] }) => markCard({ home, key, state }),
  'waiting-menu': ({ home, operands: [terminal] }) => waitingMenu({ home, terminal }),
  'answer-menu': ({ home, operands: [terminal, askId, , payload] }) => answerMenu({ home, terminal, askId, payload }),
  'open-coordinator': ({ home, operands: [repository, runtime] }) => openCoordinator({ home, repository, runtime }),
};

const isValue = (value) => Boolean(value) && !value.startsWith('--');

// What each command takes before `--home <dir>`: `refresh` and `menus` an optional terminal list; `open-log` a key; `act` a key, a
// panel action, a version of 64 lowercase hex and an optional reply, which for a `pick` is its proposal number and
// required; `undo` a `<repository>#<card>` key, an action
// that can be taken back and a non-empty record; `move` a `<repository>#<card>` key, a Board move, a version of
// 64 lowercase hex and, for `place` only, a place number; `report` a `<repository>@<sha>` key, the sha 40 or 64 lowercase hex; `show-first` a
// `<repository>#<card>` key and `on` or `off`; `clear-digest` nothing; `waiting-menu` a terminal name; `answer-menu` a terminal
// name, a 32-hex ask id and `--answer` with the answer record as JSON; `notify` only an optional `--initialize`;
// `open-coordinator` the registered project path and a runtime.
const OPERANDS = {
  notify: (operands) => operands.length === 0 || (operands.length === 1 && operands[0] === '--initialize'),
  refresh: ([terminals, ...extra]) => !terminals?.startsWith('-') && extra.length === 0,
  menus: ([terminals, ...extra]) => !terminals?.startsWith('-') && extra.length === 0,
  'clear-digest': (operands) => operands.length === 0,
  'open-log': ([key, ...extra]) => isValue(key) && extra.length === 0,
  act: ([key, action, version, ...reply]) => isValue(key) && ACTIONS.includes(action) && SHA256_HEX.test(version ?? '')
    && (action === 'pick' ? reply.length === 1 && POSITIVE_WHOLE.test(reply[0]) : reply.length <= 1),
  undo: ([key, action, record, ...extra]) => CARD_KEY.test(key ?? '') && UNDOABLE.includes(action) && Boolean(record)
    && extra.length === 0,
  move: ([key, move, version, ...place]) => CARD_KEY.test(key ?? '') && MOVES.includes(move)
    && SHA256_HEX.test(version ?? '')
    && (move === 'place' ? place.length === 1 && POSITIVE_WHOLE.test(place[0]) : place.length === 0),
  report: ([key, ...extra]) => REPORT_KEY.test(key ?? '') && extra.length === 0,
  'show-first': ([key, state, ...extra]) => CARD_KEY.test(key ?? '') && SHOW_FIRST_STATES.includes(state) && extra.length === 0,
  'waiting-menu': ([terminal, ...extra]) => MENU_TERMINAL.test(terminal ?? '') && !terminal.startsWith('-') && extra.length === 0,
  'answer-menu': ([terminal, askId, flag, payload, ...extra]) => MENU_TERMINAL.test(terminal ?? '') && MENU_ASK_ID.test(askId ?? '')
    && flag === '--answer' && isString(payload) && extra.length === 0,
  'open-coordinator': ([repository, runtime, ...extra]) => isValue(repository) && COORDINATOR_RUNTIMES.includes(runtime) && extra.length === 0,
};

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const operands = rest.slice(0, -2);
  const [flag, home] = rest.slice(-2);
  if (!Object.hasOwn(COMMANDS, command) || flag !== '--home' || !isValue(home) || !OPERANDS[command](operands)) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await COMMANDS[command]({ home: resolve(home), operands });
    if (typeof result === 'number') return result;
    if (typeof result === 'string') console.log(result);
    return 0;
  } catch (error) {
    console.error(`queue: ${oneLine(error.message)}`);
    return 1;
  }
}

// Both sides through realpath: a Herdr home may be a link, and Node loads a linked entry by its real path. An entry
// that is not a file, such as standard input, is never this module.
if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
