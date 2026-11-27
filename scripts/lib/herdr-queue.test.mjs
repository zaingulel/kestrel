// herdr-queue.test.mjs — the queue panel's machine aggregator (.agents/herdr/fabraik-queue/queue.mjs).
// Run: node --test scripts/lib/herdr-queue.test.mjs
//
// The expected orders, keys, problem lines and file contents are written by hand from the queue panel plan's ranking,
// rebuild, screenshot and honesty rules, never read off the aggregator's own output. Where a problem line carries a
// thrown message, that message is the platform's (JSON.parse, the file system), worked out here from the same input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTOR_FORMAT, main as queueMain, rank, refresh, waitingMenu as waitingMenuIn } from '../../.agents/herdr/fabraik-queue/queue.mjs';
import { ownerMenu } from './owner-menu.mjs';
import { FORMAT } from './owner-queue.mjs';

const QUEUE = fileURLToPath(new URL('../../.agents/herdr/fabraik-queue/queue.mjs', import.meta.url));
// What `queue.mjs` prints on stderr, with exit 2, for any argument shape it does not take.
const QUEUE_USAGE = 'usage: node queue.mjs refresh [<terminals>] --home <dir> | menus [<terminals>] --home <dir> | clear-digest --home <dir> | act <key> <action> <version> [<reply>|<proposal>] --home <dir> | undo <key> <action> <record> --home <dir> | move <key> <move> <version> [<place>] --home <dir> | report <key> --home <dir> | show-first <key> <on|off> --home <dir> | waiting-menu <terminal> --home <dir> | answer-menu <terminal> <askId> --answer <json> --home <dir> | notify [--initialize] --home <dir> | open-coordinator <repository> <claude|codex> --home <dir>\n';

const A = join('/', 'repos', 'a');
const B = join('/', 'repos', 'b');

const RELEASE = { tag: 'v1.0.0', id: 1, assetId: 2, digest: `sha256:${'a'.repeat(64)}` };
const merge = (sha, at) => ({ sha, at, subject: `merge ${sha}` });

// The panel files a release installs under <home>/mods/fabraik-queue/, which the machine record's `files` hash.
const PANEL_FILES = { 'main.js': 'panel drawing bytes', 'queue.mjs': 'panel aggregator bytes' };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The release part of a machine record that matches PANEL_FILES.
const releaseReceipt = () => ({
  format: 1,
  release: RELEASE,
  files: Object.fromEntries(Object.entries(PANEL_FILES).map(([name, bytes]) => [name, sha256(bytes)])),
});

// The same receipt in format 2, which also hashes the tab bar and layout the install derives from Herdr's own.
const derivedReceipt = () => ({
  ...releaseReceipt(),
  format: 2,
  derived: { 'mods/fabraik-tabs/main.js': sha256('derived tab bar bytes'), 'layouts/fabraik.json': sha256('derived layout bytes') },
});

function writePanelFiles(home) {
  const panel = join(home, 'mods', 'fabraik-queue');
  mkdirSync(panel, { recursive: true });
  for (const [name, bytes] of Object.entries(PANEL_FILES)) writeFileSync(join(panel, name), bytes);
}

function temporaryFolder(t, prefix) {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// A temporary Herdr home with its state folder and, unless `record` is undefined, the machine record: `record` is
// written as JSON unless it is already text.
function temporaryHome(t, record) {
  const home = temporaryFolder(t, 'herdr-queue-home-');
  const state = join(home, 'fabraik-queue');
  mkdirSync(state);
  if (record !== undefined) {
    writeFileSync(join(state, 'machine.json'), typeof record === 'string' ? record : JSON.stringify(record));
  }
  return { home, state, cache: () => JSON.parse(readFileSync(join(state, 'queue.json'), 'utf8')) };
}

// A temporary home installed from a release: the record lists `repositories` and its receipt matches the panel files
// written there; `fields` override the record.
function releasedHome(t, repositories, fields) {
  const made = temporaryHome(t, { ...releaseReceipt(), repositories, ...fields });
  writePanelFiles(made.home);
  return made;
}

const collectorDocument = (fields) => ({
  format: 1,
  release: 'v1.0.0',
  host: 'this-machine',
  readAt: '2026-11-09T12:00:00Z',
  fetchedAt: null,
  sources: [{ name: 'board', ok: true }],
  items: [],
  digest: [],
  board: { cards: [] },
  ...fields,
});

// One herdr-core terminal as the panel passes it to a refresh: its address, its status report (`{ state, app }` or null)
// and the folder of its running program, left out where `folder` is undefined; and the list text a refresh is given.
const terminal = (address, report, folder) => ({ address, report, folder });
const terminalList = (list) => JSON.stringify(list);
const NO_TERMINALS = terminalList([]);

// Board entries without their own problem lines, which the board problems test owns, so a test of other fields holds
// whatever lines its repositories gave.
const withoutProblems = (boards) => boards.map(({ problems, ...entry }) => entry);

// The message JSON.parse throws for `text`, which is not JSON.
function parseMessage(text) {
  try {
    JSON.parse(text);
  } catch (error) {
    return /** @type {Error} */ (error).message;
  }
}

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('items rank by tier, then category, then repository and card', () => {
  // Both repositories are given shuffled: categories out of order, cards out of order, digest oldest first.
  const repositories = [
    {
      repository: A,
      items: [
        { card: 9, title: 'a9', category: 'merge', decisionCard: 'Ship it.', visual: 'none' },
        { card: 6, title: 'a6', category: 'failure', reason: 'tests red' },
        { card: 3, title: 'a3', category: 'question', question: 'Which one?' },
        { category: 'problem', problem: 'corrupt lead record 7.txt' },
        { card: 2, title: 'Proposed: a2', category: 'suggested' },
        { card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', visual: 'none' },
        { card: 4, title: 'a4', category: 'usage-limit', reason: 'limit' },
      ],
      digest: [
        { sha: 'a1', at: '2026-11-09T08:00:00Z', subject: 'older' },
        { sha: 'a2', at: '2026-11-09T09:00:00Z', subject: 'newer' },
      ],
    },
    {
      repository: B,
      items: [
        { card: 3, title: 'b3', category: 'usage-limit', reason: 'limit' },
        { card: 5, title: 'b5', category: 'failure', reason: 'crash' },
        { card: 7, title: 'Proposed: b7', category: 'suggested' },
        { card: 2, title: 'b2', category: 'question', question: 'Why?' },
        { card: 1, title: 'b1', category: 'merge', decisionCard: 'Ship it.', visual: 'none' },
      ],
      digest: [{ sha: 'b1', at: '2026-11-09T10:00:00Z', subject: 'newest' }],
    },
  ];
  const before = JSON.stringify(repositories);

  assert.deepEqual(rank(repositories).map((entry) => entry.key), [
    `${A}!corrupt lead record 7.txt`,
    `${A}#5`, `${A}#9`, `${B}#1`,
    `${A}#3`, `${B}#2`,
    `${A}#4`, `${B}#3`,
    `${A}#2`, `${B}#7`,
    `${A}#6`, `${B}#5`,
    `${A}@a2`, `${A}@a1`, `${B}@b1`,
  ]);
  assert.equal(JSON.stringify(repositories), before, 'rank leaves its input as it was');
});

test('a rebuild after restart gives the same items once each and keeps cleared digest entries cleared', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'herdr-queue-home-'));
  const repository = mkdtempSync(join(tmpdir(), 'herdr-queue-repo-'));
  const review = mkdtempSync(join(tmpdir(), 'herdr-queue-review-'));
  t.after(() => [home, repository, review].forEach((folder) => rmSync(folder, { recursive: true, force: true })));
  const state = join(home, 'fabraik-queue');
  mkdirSync(state);
  writeFileSync(join(state, 'machine.json'), JSON.stringify({ format: 1, release: null, files: {}, repositories: [repository] }));
  const screenshot = join(review, 'screenshot-1.png');
  writeFileSync(screenshot, 'png-fixture');
  // sha256 of the bytes `png-fixture`.
  const shot = 'fabraik-queue/shots/81c281b564f9924d4646d3df236882e9575ee7cbc084ef4d573327046194f28c.png';
  const merge = (sha, at) => ({ sha, at, subject: `merge ${sha}` });
  const c1 = merge('c1', '2026-11-09T08:00:00Z');
  const c2 = merge('c2', '2026-11-09T09:00:00Z');
  const c3 = merge('c3', '2026-11-09T10:00:00Z');
  const c4 = merge('c4', '2026-11-09T11:00:00Z');
  const collector = (digest) => () => ({
    format: 1,
    release: null,
    host: 'this-machine',
    readAt: '2026-11-09T12:00:00Z',
    fetchedAt: null,
    sources: [{ name: 'board', ok: true }],
    items: [{ card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', screenshots: [screenshot] }],
    digest,
  });
  const cache = () => JSON.parse(readFileSync(join(state, 'queue.json'), 'utf8'));
  const keys = () => cache().items.map((item) => item.key);

  for (let run = 0; run < 2; run += 1) {
    await refresh({ home, runCollector: collector([c3, c2, c1]) });
    assert.deepEqual(keys(), [`${repository}#5`, `${repository}@c3`, `${repository}@c2`, `${repository}@c1`]);
    assert.deepEqual(cache().items[0].screenshots, [shot]);
    assert.equal(readFileSync(join(home, ...shot.split('/')), 'utf8'), 'png-fixture');
  }

  const cleared = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home], { encoding: 'utf8' });
  assert.equal(cleared.status, 0, cleared.stderr);
  const dismissed = join(state, 'dismissed.json');
  assert.deepEqual(JSON.parse(readFileSync(dismissed, 'utf8')), { format: 1, marks: { [repository]: 'c3' } });
  const marks = readFileSync(dismissed);

  const refused = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home, '--all'], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr, QUEUE_USAGE);
  assert.deepEqual(readFileSync(dismissed), marks);

  rmSync(join(state, 'queue.json'));
  // @ts-expect-error the query string loads a fresh module instance, which the checker cannot resolve
  const restarted = await import('../../.agents/herdr/fabraik-queue/queue.mjs?after-clear');
  await restarted.refresh({ home, runCollector: collector([c4, c3, c2, c1]) });
  assert.deepEqual(keys(), [`${repository}#5`, `${repository}@c4`]);
});

test('a refresh records when its read began, before any collector ran', async (t) => {
  const repository = join(temporaryFolder(t, 'herdr-queue-repos-'), 'a');
  mkdirSync(repository);
  const { home, cache } = releasedHome(t, [repository]);
  const before = Date.now();
  let calledAt;
  await refresh({
    home,
    terminals: NO_TERMINALS,
    runCollector: async () => {
      calledAt = Date.now();
      // The clock must move past calledAt, so the read's start and the collector's call can be told apart.
      while (Date.now() <= calledAt) await new Promise((resolve) => setImmediate(resolve));
      return collectorDocument();
    },
  });
  const { readStartedAt, refreshedAt } = cache();
  assert.equal(typeof readStartedAt, 'string', 'the cache records when its read began');
  assert.ok(before <= Date.parse(readStartedAt), 'the read began no earlier than the refresh was asked');
  assert.ok(Date.parse(readStartedAt) <= calledAt, 'the read began before its collector ran');
  assert.ok(calledAt < Date.parse(refreshedAt), 'the collector ran before the cache was written');

  const empty = releasedHome(t, []);
  const emptyBefore = Date.now();
  await refresh({ home: empty.home, terminals: NO_TERMINALS });
  const emptyCache = empty.cache();
  assert.equal(typeof emptyCache.readStartedAt, 'string', 'the cache records when its read began with no repositories');
  assert.ok(emptyBefore <= Date.parse(emptyCache.readStartedAt), 'the read began no earlier than the refresh was asked');
  assert.ok(Date.parse(emptyCache.readStartedAt) <= Date.parse(emptyCache.refreshedAt), 'the read began no later than the cache was written');
});

test('unreferenced shots older than a day are pruned', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'herdr-queue-home-'));
  const repository = mkdtempSync(join(tmpdir(), 'herdr-queue-repo-'));
  const review = mkdtempSync(join(tmpdir(), 'herdr-queue-review-'));
  t.after(() => [home, repository, review].forEach((folder) => rmSync(folder, { recursive: true, force: true })));
  const state = join(home, 'fabraik-queue');
  const shots = join(state, 'shots');
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(state, 'machine.json'), JSON.stringify({ format: 1, release: null, files: {}, repositories: [repository] }));
  const screenshot = join(review, 'screenshot-1.png');
  writeFileSync(screenshot, 'png-fixture');
  // The copy of `png-fixture`, named by its sha256, is the one referenced shot; it starts two days old.
  const referenced = '81c281b564f9924d4646d3df236882e9575ee7cbc084ef4d573327046194f28c.png';
  const oldUnreferenced = 'a'.repeat(64) + '.png';
  const youngUnreferenced = 'b'.repeat(64) + '.png';
  const setAge = (name, hours) => {
    writeFileSync(join(shots, name), 'x');
    const then = new Date(Date.now() - hours * 3_600_000);
    utimesSync(join(shots, name), then, then);
  };
  setAge(referenced, 48);
  setAge(oldUnreferenced, 48);
  setAge(youngUnreferenced, 1);

  await refresh({
    home,
    runCollector: () => ({
      format: 1,
      release: null,
      host: 'this-machine',
      readAt: '2026-11-09T12:00:00Z',
      fetchedAt: null,
      sources: [{ name: 'board', ok: true }],
      items: [{ card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', screenshots: [screenshot] }],
      digest: [],
    }),
  });

  assert.deepEqual(readdirSync(shots).sort(), [youngUnreferenced, referenced].sort());
});

test('an unreadable, readerless or incompatible repository is reported, adds no items, and its board is unreadable or, readerless, left out untouched', async (t) => {
  const readerless = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [readerless]);
  const listing = () => readdirSync(home, { recursive: true }).sort();
  const before = listing();
  const readerlessBefore = readdirSync(readerless);

  const homeless = spawnSync(process.execPath, [QUEUE, 'refresh'], { cwd: home, encoding: 'utf8' });
  assert.equal(homeless.status, 2);
  assert.equal(homeless.stderr, QUEUE_USAGE);
  assert.deepEqual(listing(), before);

  const refreshed = spawnSync(process.execPath, [QUEUE, 'refresh', '--home', home], { encoding: 'utf8' });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.deepEqual(cache().problems, [
    `${basename(readerless)}: no queue reader: the Herdr add-on is off there or its release predates the panel`,
  ]);
  assert.deepEqual(cache().items, []);
  // A repository without a queue reader has no board entry, and nothing ran or was written in it.
  assert.deepEqual(cache().boards, []);
  assert.deepEqual(readdirSync(readerless), readerlessBefore);

  // One refresh over every way a repository can fail, beside a good repository and one whose details read only in
  // part: each failure is its own problem line and the other repositories' items still show.
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['good', 'absent', 'slow', 'broken', 'garbled', 'newer', 'partial'];
  for (const name of names) if (name !== 'absent') mkdirSync(join(root, name));
  const collectors = {
    good: () => collectorDocument({
      items: [{ card: 3, title: 'g3', category: 'question', question: 'Which one?' }],
      digest: [merge('g1', '2026-11-09T09:00:00Z')],
      board: { cards: [{ card: 3, title: 'g3', column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: 'question' }] },
    }),
    absent: () => collectorDocument({ items: [{ card: 9, title: 'x9', category: 'merge', decisionCard: 'Ship it.', visual: 'none' }] }),
    slow: () => Promise.reject(Object.assign(new Error('Command failed: node scripts/owner-queue.mjs'), {
      killed: true, signal: 'SIGTERM',
    })),
    broken: () => Promise.reject(Object.assign(
      new Error('Command failed: node scripts/owner-queue.mjs\nowner-queue: board exploded'),
      { killed: false, code: 1 },
    )),
    garbled: async () => JSON.parse('queue reader crashed'),
    newer: () => collectorDocument({
      format: 2,
      release: 'v9.0.0',
      items: [{ card: 7, title: 'n7', category: 'merge', decisionCard: 'Ship it.', visual: 'none' }],
      digest: [merge('n1', '2026-11-09T10:00:00Z')],
    }),
    partial: () => collectorDocument({
      sources: [{ name: 'board', ok: true }, { name: 'details', ok: false, error: 'card 4: comments unavailable' }],
      items: [{ card: 2, title: 'Proposed: p2', category: 'suggested' }],
      digest: [merge('p1', '2026-11-09T08:00:00Z')],
    }),
  };
  const many = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home: many.home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS });

  const { problems, items } = many.cache();
  const boards = withoutProblems(many.cache().boards);
  assert.equal(problems.length, 7, problems.join('\n'));
  assert.match(problems[0], new RegExp(
    `^absent: folder unreadable: ENOENT: no such file or directory, \\w+ '${literal(join(root, 'absent'))}'$`,
  ));
  assert.deepEqual(problems.slice(1), [
    'slow: the queue reader timed out after 120 s',
    'broken: the queue reader failed: owner-queue: board exploded',
    'broken: queue reader raw failure: Command failed: node scripts/owner-queue.mjs owner-queue: board exploded',
    `garbled: the queue reader failed: ${parseMessage('queue reader crashed')}`,
    'newer: on release v9.0.0, panel on release v1.0.0: its items are not shown',
    'partial: details could not be read: card 4: comments unavailable',
  ]);
  const good = join(root, 'good');
  const partial = join(root, 'partial');
  assert.deepEqual(items.map((item) => item.key), [`${good}#3`, `${partial}#2`, `${good}@g1`, `${partial}@p1`]);

  // Each failing repository's board is unreadable with its problem text, in record order; the ones that were read
  // (the good one, and the one whose details only partly read) show their cards.
  assert.equal(boards.length, 7);
  assert.deepEqual(boards[0], {
    repository: good,
    folder: realpathSync(good),
    cards: [{ card: 3, title: 'g3', column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: 'question' }],
    merged: [merge('g1', '2026-11-09T09:00:00Z')],
  });
  assert.equal(boards[1].repository, join(root, 'absent'));
  assert.match(boards[1].unreadable, new RegExp(
    `^folder unreadable: ENOENT: no such file or directory, \\w+ '${literal(join(root, 'absent'))}'$`,
  ));
  assert.deepEqual(boards.slice(2), [
    {
      repository: join(root, 'slow'),
      folder: realpathSync(join(root, 'slow')),
      unreadable: 'the queue reader timed out after 120 s',
      merged: null,
    },
    {
      repository: join(root, 'broken'),
      folder: realpathSync(join(root, 'broken')),
      unreadable: 'the queue reader failed: owner-queue: board exploded',
      merged: null,
    },
    {
      repository: join(root, 'garbled'),
      folder: realpathSync(join(root, 'garbled')),
      unreadable: `the queue reader failed: ${parseMessage('queue reader crashed')}`,
      merged: null,
    },
    {
      repository: join(root, 'newer'),
      folder: realpathSync(join(root, 'newer')),
      unreadable: 'on release v9.0.0, panel on release v1.0.0: its items are not shown',
      merged: null,
    },
    {
      repository: partial,
      folder: realpathSync(partial),
      cards: [],
      merged: [merge('p1', '2026-11-09T08:00:00Z')],
    },
  ]);

  // A Herdr home may itself be a link, so the panel's queue.mjs may run through one and must still act.
  const links = temporaryFolder(t, 'herdr-queue-links-');
  const linked = join(links, 'fabraik-queue');
  symlinkSync(dirname(QUEUE), linked, 'junction');
  const throughLink = spawnSync(process.execPath, [join(linked, 'queue.mjs'), '--all'], { encoding: 'utf8' });
  assert.equal(throughLink.status, 2);
  assert.equal(throughLink.stderr, QUEUE_USAGE);
});

test("each readable repository's board is gathered in record order, and a null, missing or malformed board is unreadable while its items still show", async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['placed', 'unplaced', 'failed', 'old', 'notlist', 'badcard', 'text', 'badoutcome'];
  for (const name of names) mkdirSync(join(root, name));
  const itemFor = (card) => ({ card, title: `t${card}`, category: 'question', question: 'Which one?' });
  const placedCards = [
    { card: 1, title: 't1', column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: 'question', outcome: { text: 'Show the sheet.', more: false } },
    { card: 2, title: 't2', column: null, order: 1, blockers: [1], claim: { machine: 'other-host', runtime: 'Claude Code' }, waitsOn: null, outcome: { unread: 'a code fence is left open' } },
    { card: 3, title: 't3', column: 'Ready', order: 2, blockers: [], unread: 'comments unavailable' },
  ];
  const unplacedCards = [{ card: 4, title: 't4', column: 'In progress', blockers: [], claim: null, waitsOn: null, outcome: null }];
  const collectors = {
    placed: () => collectorDocument({ items: [itemFor(1)], board: { cards: placedCards } }),
    unplaced: () => collectorDocument({
      items: [itemFor(4)],
      board: { cards: unplacedCards, orderUnread: 'a card was recovered from the issue list', waitsOnUnread: ['approvals'] },
    }),
    failed: () => collectorDocument({
      sources: [{ name: 'board', ok: false, error: 'board exploded' }],
      items: [itemFor(5)],
      board: null,
    }),
    old: () => collectorDocument({ items: [itemFor(6)], board: undefined }),
    notlist: () => collectorDocument({ items: [itemFor(7)], board: { cards: 'none' } }),
    badcard: () => collectorDocument({
      items: [itemFor(8)],
      board: { cards: [{ card: '8', title: 't8', column: null, blockers: [], claim: null, waitsOn: null }] },
    }),
    text: () => collectorDocument({ items: [itemFor(9)], board: 'not a board' }),
    badoutcome: () => collectorDocument({
      items: [itemFor(10)],
      board: { cards: [{ card: 10, title: 't10', column: 'Ready', blockers: [], claim: null, waitsOn: null, outcome: { text: 'x' } }] },
    }),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS });

  const notBoard = 'its board is not a board document';
  const entry = (name) => ({ repository: join(root, name), folder: realpathSync(join(root, name)), merged: [] });
  assert.deepEqual(withoutProblems(cache().boards), [
    {
      ...entry('placed'),
      cards: placedCards,
    },
    {
      ...entry('unplaced'),
      cards: unplacedCards,
      orderUnread: 'a card was recovered from the issue list',
      waitsOnUnread: ['approvals'],
    },
    { ...entry('failed'), unreadable: 'board exploded' },
    {
      ...entry('old'),
      unreadable: "its queue reader's release predates the board read",
    },
    { ...entry('notlist'), unreadable: notBoard },
    { ...entry('badcard'), unreadable: notBoard },
    { ...entry('text'), unreadable: notBoard },
    { ...entry('badoutcome'), unreadable: notBoard },
  ]);
  // Every repository's queue items still show beside its unreadable board.
  const itemCards = { placed: 1, unplaced: 4, failed: 5, old: 6, notlist: 7, badcard: 8, text: 9, badoutcome: 10 };
  assert.deepEqual(
    cache().items.map((item) => item.key).sort(),
    names.map((name) => `${join(root, name)}#${itemCards[name]}`).sort(),
  );
});

// A board entry carries what the Floor needs to draw it: its repository's real folder, the merges of its last day whole
// (the Clear marks hide them from the queue's digest, not from the board), and each card's job worktree as a real path.
test("each board carries its repository's real folder, its last-day merges whatever the Clear marks and its cards' job worktrees as real paths, and null for each it could not read", async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const [ok, odd, broken] = ['ok', 'odd', 'broken'].map((name) => join(root, name));
  for (const folder of [ok, odd, broken]) mkdirSync(folder);
  const m1 = merge('m1', '2026-11-09T08:00:00Z');
  const m2 = merge('m2', '2026-11-09T09:00:00Z');
  const { home, state, cache } = releasedHome(t, [ok, odd, broken]);
  // A job worktree named through a link, one that is gone, one that is null and one that is not named.
  const real = join(home, 'real-21');
  const link = join(home, 'link-21');
  mkdirSync(real);
  symlinkSync(real, link, 'junction');
  const card = (number, fields) => ({ card: number, title: `t${number}`, column: 'In progress', blockers: [], claim: null, waitsOn: null, ...fields });
  const cards = [
    card(21, { worktree: link }),
    card(22, { worktree: join(home, 'gone-22') }),
    card(23, { worktree: null }),
    card(24),
  ];
  const collectors = {
    ok: () => collectorDocument({ board: { cards }, digest: [m2, m1] }),
    odd: () => collectorDocument({ board: { cards: [card(25, { worktree: 7 })] } }),
    broken: () => { throw new Error('collector blew up'); },
  };
  const options = { home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS };

  await refresh(options);
  const cleared = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home], { encoding: 'utf8' });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'dismissed.json'), 'utf8')), { format: 1, marks: { [ok]: 'm2' } });
  await refresh(options);

  // The marks leave no digest item for `ok`, yet its board keeps both merges.
  assert.deepEqual(cache().items.filter((item) => item.category === 'digest'), []);
  assert.deepEqual(withoutProblems(cache().boards), [
    {
      repository: ok,
      folder: realpathSync(ok),
      cards: [
        card(21, { worktree: realpathSync(real) }),
        card(22, { worktree: null }),
        card(23, { worktree: null }),
        card(24),
      ],
      merged: [m2, m1],
    },
    {
      repository: odd,
      folder: realpathSync(odd),
      unreadable: 'its board is not a board document',
      merged: [],
    },
    {
      repository: broken,
      folder: realpathSync(broken),
      unreadable: 'the queue reader failed: collector blew up',
      merged: null,
    },
  ]);
});

// Linear keys its cards `ENG-12`, Jira `PROJ-7` and Azure Boards `AB-5`; a card's blockers carry the same keys, and its
// place in the column stays a number.
test('a board keyed by issue keys is recorded with its keys, and its place stays a number', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['linear', 'jira', 'azure', 'emptycard', 'objectcard', 'emptyblocker', 'textplace'];
  for (const name of names) mkdirSync(join(root, name));
  const keyed = (key, fields) => ({
    card: key, title: `title ${key}`, column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: null, ...fields,
  });
  const linearCards = [
    keyed('ENG-12', { blockers: ['ENG-3'], claim: { machine: 'other-host', runtime: 'Claude Code' }, waitsOn: 'question' }),
    { card: 'ENG-13', title: 'title ENG-13', column: 'Ready', order: 2, blockers: [], unread: 'comments unavailable' },
  ];
  const jiraCards = [keyed('PROJ-7', { blockers: ['PROJ-2', 'PROJ-5'] })];
  const azureCards = [keyed('AB-5', { blockers: ['AB-1'] })];
  const boards = {
    linear: { cards: linearCards },
    jira: { cards: jiraCards },
    azure: { cards: azureCards },
    emptycard: { cards: [keyed('')] },
    objectcard: { cards: [keyed({ key: 'ENG-1' })] },
    emptyblocker: { cards: [keyed('ENG-1', { blockers: [''] })] },
    textplace: { cards: [keyed('ENG-1', { order: '1' })] },
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({
    home,
    runCollector: (repository) => collectorDocument({ board: boards[basename(repository)] }),
    terminals: NO_TERMINALS,
  });

  const notBoard = 'its board is not a board document';
  const entry = (name) => ({ repository: join(root, name), folder: realpathSync(join(root, name)), merged: [] });
  assert.deepEqual(withoutProblems(cache().boards), [
    {
      ...entry('linear'),
      cards: linearCards,
    },
    { ...entry('jira'), cards: jiraCards },
    { ...entry('azure'), cards: azureCards },
    { ...entry('emptycard'), unreadable: notBoard },
    { ...entry('objectcard'), unreadable: notBoard },
    { ...entry('emptyblocker'), unreadable: notBoard },
    { ...entry('textplace'), unreadable: notBoard },
  ]);
});

test('queue items keyed by issue keys are recorded with their keys', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['linear', 'jira', 'azure', 'emptycard', 'objectcard', 'zerocard'];
  for (const name of names) mkdirSync(join(root, name));
  // One category apiece, so the ranking by category alone orders them and no two keys are compared.
  const items = {
    linear: [{ card: 'ENG-12', title: 'eng', category: 'question', question: 'Which one?' }],
    jira: [{ card: 'PROJ-7', title: 'proj', category: 'failure', reason: 'tests red' }],
    azure: [{ card: 'AB-5', title: 'ab', category: 'suggested' }],
    emptycard: [{ card: '', title: 'empty', category: 'question', question: 'Which one?' }],
    objectcard: [{ card: { key: 'ENG-1' }, title: 'object', category: 'question', question: 'Which one?' }],
    zerocard: [{ card: 0, title: 'zero', category: 'question', question: 'Which one?' }],
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({
    home,
    runCollector: (repository) => collectorDocument({ items: items[basename(repository)] }),
    terminals: NO_TERMINALS,
  });

  assert.deepEqual(
    cache().items.map(({ key, card, title, category }) => ({ key, card, title, category })),
    [
      { key: `${join(root, 'linear')}#ENG-12`, card: 'ENG-12', title: 'eng', category: 'question' },
      { key: `${join(root, 'azure')}#AB-5`, card: 'AB-5', title: 'ab', category: 'suggested' },
      { key: `${join(root, 'jira')}#PROJ-7`, card: 'PROJ-7', title: 'proj', category: 'failure' },
    ],
  );
  // A card that is neither an issue key nor a positive integer still makes its repository's queue unreadable.
  assert.deepEqual(
    cache().problems,
    ['emptycard', 'objectcard', 'zerocard'].map((name) => `${name}: the queue reader failed: its output is not a queue document`),
  );
});

// The order `compareCardIds` (scripts/lib/tracker.mjs) gives: team text, then the number by value.
test('keyed queue items in one repository and category are ordered by team, then number', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const keyed = join(root, 'keyed');
  const numbered = join(root, 'numbered');
  for (const folder of [keyed, numbered]) mkdirSync(folder);
  const question = (card) => ({ card, title: `t${card}`, category: 'question', question: 'Which one?' });
  const items = {
    keyed: ['ENG-10', 'ENG-9', 'ABC-3', 'ENG-100'].map(question),
    numbered: [12, 3].map(question),
  };
  const { home, cache } = releasedHome(t, [keyed, numbered]);

  await refresh({
    home,
    runCollector: (repository) => collectorDocument({ items: items[basename(repository)] }),
    terminals: NO_TERMINALS,
  });

  assert.deepEqual(cache().items.map((item) => item.key), [
    ...['ABC-3', 'ENG-9', 'ENG-10', 'ENG-100'].map((card) => `${keyed}#${card}`),
    ...[3, 12].map((card) => `${numbered}#${card}`),
  ]);
});

test('a cache too large with boards drops the boards first and keeps the queue', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['big', 'small'];
  for (const name of names) mkdirSync(join(root, name));
  const itemFor = (card) => ({ card, title: `t${card}`, category: 'question', question: 'Which one?' });
  const collectors = {
    // The board alone is over the cache limit; the queue is small.
    big: () => collectorDocument({
      items: [itemFor(1)],
      board: { cards: [{ card: 1, title: 'x'.repeat(1024 * 1024), column: null, blockers: [], claim: null, waitsOn: 'question' }] },
    }),
    small: () => collectorDocument({
      items: [itemFor(2)],
      board: { cards: [{ card: 2, title: 't2', column: null, blockers: [], claim: null, waitsOn: 'question' }] },
    }),
  };
  const { home, state, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS });

  assert.ok(statSync(join(state, 'queue.json')).size < 1024 * 1024);
  // Every board is replaced, the small one too; the items and the problems are the ones a small cache has.
  assert.deepEqual(withoutProblems(cache().boards), [
    { repository: join(root, 'big'), unreadable: 'too large to show' },
    { repository: join(root, 'small'), unreadable: 'too large to show' },
  ]);
  assert.deepEqual(cache().items.map((item) => item.key), [`${join(root, 'big')}#1`, `${join(root, 'small')}#2`]);
  assert.deepEqual(cache().problems, []);
});

// The panel reads herdr-core's terminal list as a refresh begins and runs `queue.mjs refresh` with that list as its one
// operand, so this runs the command as the panel does, over a queue reader that prints an empty document. The list reaches
// the refresh where the waiting menu of its blocked terminal is answerable and no line says the list was not read.
test("the panel's terminal list reaches a refresh as its one argument", (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  mkdirSync(join(repository, 'scripts'));
  writeFileSync(join(repository, 'scripts', 'owner-queue.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(collectorDocument()))});\n`);
  const { home, state, cache } = releasedHome(t, [repository]);
  const refreshWith = (...lists) => spawnSync(process.execPath, [QUEUE, 'refresh', ...lists, '--home', home], { encoding: 'utf8' });

  const id = writeAsk(home, 't1', 1);

  const answerable = () => cache().items.filter((item) => item.category === 'menu').map((item) => [item.terminal, item.askId, item.answerable]);
  const refreshed = refreshWith(blockedAt('t1'));
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.deepEqual(cache().problems, [], 'no line says the terminal list was not read');
  assert.deepEqual(answerable(), [['t1', id, true]], "the blocked terminal's waiting menu is answerable");

  // A report's app and a terminal's folder are fields no reader takes, so a sibling's malformed ones refuse nothing.
  const sibling = refreshWith(terminalList([terminal('t1', { state: 'blocked' }), terminal('t2', { state: 'working', app: 7 }, 9)]));
  assert.equal(sibling.status, 0, sibling.stderr);
  assert.deepEqual(cache().problems, [], "a sibling's malformed app and folder do not refuse the terminal list");
  assert.deepEqual(answerable(), [['t1', id, true]], "a sibling's malformed app and folder leave the blocked terminal's waiting menu answerable");

  const listing = () => readdirSync(home, { recursive: true }).sort();
  const before = listing();
  const written = readFileSync(join(state, 'queue.json'));
  const refused = refreshWith(NO_TERMINALS, NO_TERMINALS);
  assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE });
  assert.deepEqual(listing(), before);
  assert.deepEqual(readFileSync(join(state, 'queue.json')), written);

  // An operand that begins with `-` is an option the command does not know, not a terminal list.
  const optioned = refreshWith('--all');
  assert.deepEqual({ status: optioned.status, stderr: optioned.stderr }, { status: 2, stderr: QUEUE_USAGE });
  assert.deepEqual(listing(), before);
  assert.deepEqual(readFileSync(join(state, 'queue.json')), written);
});

test('a queue reader whose output is JSON but not a queue document is reported and adds no items', async (t) => {
  // The default runner returns what JSON.parse makes of the reader's output, so each stub does the same with the text
  // `null`, `[]` or `"x"`: valid JSON, but not an object.
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['good', 'nothing', 'list', 'text'];
  for (const name of names) mkdirSync(join(root, name));
  const collectors = {
    good: () => collectorDocument({ items: [{ card: 3, title: 'g3', category: 'question', question: 'Which one?' }] }),
    nothing: async () => JSON.parse('null'),
    list: async () => JSON.parse('[]'),
    text: async () => JSON.parse('"x"'),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)]() });

  const { problems, items } = cache();
  assert.deepEqual(problems, [
    'nothing: the queue reader failed: its output is not a queue document',
    'list: the queue reader failed: its output is not a queue document',
    'text: the queue reader failed: its output is not a queue document',
  ]);
  assert.deepEqual(items.map((item) => item.key), [`${join(root, 'good')}#3`]);
});

test('the collector and panel formats are equal', () => {
  assert.equal(COLLECTOR_FORMAT, FORMAT);
});

test('a corrupt machine record or marks file is reported', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const collector = () => collectorDocument({
    items: [{ card: 3, title: 'a3', category: 'question', question: 'Which one?' }],
    digest: [merge('c2', '2026-11-09T09:00:00Z'), merge('c1', '2026-11-09T08:00:00Z')],
  });
  const record = (fields) => ({ ...releaseReceipt(), repositories: [repository], ...fields });
  // Refreshes a fresh home holding `machine` (no record where undefined), after `prepare(home, state)`.
  const outcome = async (machine, /** @type {(home: string, state: string) => unknown} */ prepare = () => {}) => {
    const { home, state, cache } = temporaryHome(t, machine);
    writePanelFiles(home);
    prepare(home, state);
    await refresh({ home, runCollector: collector });
    const { problems, items } = cache();
    return { problems, keys: items.map((item) => item.key) };
  };
  const allKeys = [`${repository}#3`, `${repository}@c2`, `${repository}@c1`];

  assert.deepEqual(await outcome(undefined), {
    problems: ['No machine record: install the queue panel with node <fabraik distribution>/scripts/fabraik.mjs herdr <tag> --repository <dir>'],
    keys: [],
  });

  assert.deepEqual(await outcome('not json'), {
    problems: [`Machine record unreadable: ${parseMessage('not json')}`],
    keys: [],
  });

  // The rulings fix this line's opening only; the cause after it is the aggregator's own wording.
  const { problems } = await outcome(record({ repositories: [] }));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^Machine record unreadable: \S[^\n]*$/);

  assert.deepEqual(await outcome(record({ release: null })), {
    problems: ['not installed from a release'],
    keys: allKeys,
  });

  assert.deepEqual(await outcome(record(), (home) => {
    writeFileSync(join(home, 'mods', 'fabraik-queue', 'queue.mjs'), 'changed aggregator bytes');
  }), {
    problems: ['files differ from release v1.0.0'],
    keys: allKeys,
  });

  assert.deepEqual(await outcome(record(), (home, state) => writeFileSync(join(state, 'dismissed.json'), 'not json')), {
    problems: [`Clear marks unreadable: ${parseMessage('not json')}; the digest is shown whole`],
    keys: allKeys,
  });
});

// The Board draws its own project's lines and the machine's, so each board entry carries its repository's lines without
// the folder prefix the cache's `problems` gives them, and the cache keeps the machine record's lines apart.
test("each board entry carries its own repository's problem lines and the cache its machine-wide ones, beside the whole list", async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const [good, partial] = ['good', 'partial'].map((name) => join(root, name));
  for (const folder of [good, partial]) mkdirSync(folder);
  const collectors = {
    good: () => collectorDocument(),
    partial: () => collectorDocument({ sources: [{ name: 'board', ok: true }, { name: 'details', ok: false, error: 'card 4: comments unavailable' }] }),
  };
  const { home, cache } = releasedHome(t, [good, partial], { release: null });

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS });

  assert.deepEqual(cache().boards.map(({ repository, problems }) => ({ repository, problems })), [
    { repository: good, problems: [] },
    { repository: partial, problems: ['details could not be read: card 4: comments unavailable'] },
  ]);
  assert.deepEqual(cache().machineProblems, ['not installed from a release']);
  assert.deepEqual(cache().problems, ['not installed from a release', 'partial: details could not be read: card 4: comments unavailable']);

  // A machine with no record reads no repository, so its one line is machine-wide and no board carries it.
  const unrecorded = temporaryHome(t, undefined);
  writePanelFiles(unrecorded.home);
  await refresh({ home: unrecorded.home, runCollector: collectors.good, terminals: NO_TERMINALS });
  const noRecord = 'No machine record: install the queue panel with node <fabraik distribution>/scripts/fabraik.mjs herdr <tag> --repository <dir>';
  assert.deepEqual(unrecorded.cache().machineProblems, [noRecord]);
  assert.deepEqual(unrecorded.cache().boards, []);
});

test('an unreadable screenshot is named on its card', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const review = temporaryFolder(t, 'herdr-queue-review-');
  const { home, state, cache } = releasedHome(t, [repository]);
  const oversized = join(review, 'screenshot-1.png');
  writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
  const items = [{ card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', screenshots: [oversized] }];
  const target = join(review, 'outside.png');
  writeFileSync(target, 'png-fixture');
  const linked = join(review, 'screenshot-2.png');
  try {
    symlinkSync(target, linked, 'file');
    items.push({ card: 6, title: 'a6', category: 'merge', decisionCard: 'Ship it.', screenshots: [linked] });
  } catch (error) {
    // Windows without Developer Mode or administrator rights refuses an unprivileged file symlink with EPERM.
    if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
    t.diagnostic('this account cannot create a file symlink, so the linked screenshot case is left out');
  }

  await refresh({ home, runCollector: () => collectorDocument({ items }) });

  assert.deepEqual(cache().items, items.map(({ card, title }) => ({
    card,
    title,
    category: 'merge',
    missing: { fact: 'screenshot unreadable', next: "Reopen the job's session on this machine." },
    repository,
    key: `${repository}#${card}`,
  })));
  const shots = join(state, 'shots');
  assert.deepEqual(existsSync(shots) ? readdirSync(shots) : [], []);
});

test('a cache too large to show is replaced by a problem', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, state, cache } = temporaryHome(t, { format: 1, release: null, files: {}, repositories: [repository] });

  await refresh({
    home,
    runCollector: () => collectorDocument({
      items: [{ card: 4, title: 'x'.repeat(1024 * 1024), category: 'question', question: 'Which one?' }],
    }),
  });

  assert.ok(statSync(join(state, 'queue.json')).size < 1024 * 1024);
  assert.deepEqual(cache().problems, [
    'not installed from a release',
    'The queue is too large to show: its cache would be over 1 MiB.',
  ]);
  assert.deepEqual(cache().items, []);
});

// The cache's `fetchedAt` is the oldest fetch time among the repositories whose collector document was read and
// accepted, so the panel can say how stale the merge digest may be; null where any of them reports null or none was read.
test('the cache carries the oldest fetch time of the repositories that were read', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const fetchedAt = {
    fresh: '2026-11-09T11:00:00Z',
    oldest: '2026-11-08T07:30:00Z',
    older: '2026-11-07T01:00:00Z',
    never: null,
  };
  const names = [...Object.keys(fetchedAt), 'broken', 'newer', 'absent'];
  for (const name of names) if (name !== 'absent') mkdirSync(join(root, name));
  const collectors = {
    ...Object.fromEntries(Object.keys(fetchedAt).map((name) => [name, () => collectorDocument({ fetchedAt: fetchedAt[name] })])),
    broken: () => Promise.reject(Object.assign(new Error('Command failed: node scripts/owner-queue.mjs'), { killed: false, code: 1 })),
    newer: () => collectorDocument({ format: 2, release: 'v9.0.0', fetchedAt: '2026-01-01T00:00:00Z' }),
    absent: () => collectorDocument({ fetchedAt: '2026-01-02T00:00:00Z' }),
  };
  // The cache `fetchedAt` after refreshing a fresh home over the named repositories only.
  const fetchedAtOf = async (...read) => {
    const { home, cache } = releasedHome(t, names.filter((name) => read.includes(name)).map((name) => join(root, name)));
    await refresh({ home, runCollector: (repository) => collectors[basename(repository)]() });
    return cache().fetchedAt;
  };

  assert.equal(await fetchedAtOf('fresh', 'oldest', 'older'), '2026-11-07T01:00:00Z');
  assert.equal(await fetchedAtOf('older', 'fresh'), '2026-11-07T01:00:00Z');
  assert.equal(await fetchedAtOf('fresh', 'never', 'oldest'), null);
  assert.equal(await fetchedAtOf('never'), null);
  // A repository that failed, whatever the cause, does not count: neither its older time nor its absence of one.
  assert.equal(await fetchedAtOf('fresh', 'broken', 'newer', 'absent'), '2026-11-09T11:00:00Z');
  assert.equal(await fetchedAtOf('broken', 'newer', 'absent'), null);
});

test('clear-digest keeps the cache fetch time', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);

  await refresh({
    home,
    runCollector: () => collectorDocument({
      fetchedAt: '2026-11-08T07:30:00Z',
      digest: [merge('c2', '2026-11-09T09:00:00Z'), merge('c1', '2026-11-09T08:00:00Z')],
    }),
  });
  assert.equal(cache().fetchedAt, '2026-11-08T07:30:00Z');
  assert.deepEqual(cache().items.map((item) => item.key), [`${repository}@c2`, `${repository}@c1`]);

  const cleared = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home], { encoding: 'utf8' });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(cache().items, []);
  assert.equal(cache().fetchedAt, '2026-11-08T07:30:00Z');
});

test('a queue reader whose document is malformed is reported alone and the other repositories still show', async (t) => {
  // Each bad document is valid JSON with the right format, but a shape the aggregator cannot rank: sources that are not a
  // list, a screenshots list that is a string, a digest entry with no sha.
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['good', 'nullsources', 'stringshot', 'nosha'];
  for (const name of names) mkdirSync(join(root, name));
  const collectors = {
    good: () => collectorDocument({ items: [{ card: 3, title: 'g3', category: 'question', question: 'Which one?' }] }),
    nullsources: () => collectorDocument({ sources: null, items: [{ card: 4, title: 'n4', category: 'merge' }] }),
    stringshot: () => collectorDocument({ items: [{ card: 5, title: 's5', category: 'merge', screenshots: 'shot.png' }] }),
    nosha: () => collectorDocument({ digest: [{ at: '2026-11-09T09:00:00Z', subject: 'no sha' }] }),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)]() });

  const { problems, items } = cache();
  assert.deepEqual(problems, [
    'nullsources: the queue reader failed: its output is not a queue document',
    'stringshot: the queue reader failed: its output is not a queue document',
    'nosha: the queue reader failed: its output is not a queue document',
  ]);
  assert.deepEqual(items.map((item) => item.key), [`${join(root, 'good')}#3`]);
});

test("a board source's raw failure reaches the Board view as its own problem line, and a raw failure that is not text is refused", async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['signedout', 'notext'];
  for (const name of names) mkdirSync(join(root, name));
  const headline = 'GitHub did not accept the saved sign-in (HTTP 401). Sign in again with gh auth login, then read again.';
  const raw = 'Command failed: gh api graphql gh: Bad credentials (HTTP 401)';
  const collectors = {
    signedout: () => collectorDocument({ sources: [{ name: 'board', ok: false, error: headline, details: raw }], board: null }),
    notext: () => collectorDocument({ sources: [{ name: 'board', ok: false, error: headline, details: 42 }], board: null }),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)](), terminals: NO_TERMINALS });

  const [signedout, notext] = cache().boards;
  assert.equal(signedout.unreadable, headline);
  assert.deepEqual(signedout.problems, [`board could not be read: ${headline}`, `board raw failure: ${raw}`]);
  assert.equal(notext.unreadable, 'the queue reader failed: its output is not a queue document');
});

test('a queue reader document that breaks the item contract is reported alone and the other repositories still show', async (t) => {
  // Each bad document is valid JSON with the right format and the right outer shape, but one part of it breaks the item
  // contract the panel draws from: a source that failed with no readable error, an unknown category, an item missing a
  // field its category needs, a card that is text, a screenshots field of the wrong shape, a digest entry with no
  // subject or a time that is not a date, a weekly retro's write-up that is neither text nor `{ plain }`, or card drafts
  // that are no list of drafts.
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const draft = { n: 1, repository: 'example-owner/a', title: 'A draft', label: 'enhancement', problem: 'p', build: 'b', criteria: ['c'] };
  const retro = (fields) => ({ items: [{ card: 4, title: 'b4', category: 'suggested', writeUp: 'Nothing else.', proposals: [draft], ...fields }] });
  const bad = {
    writeupnumber: retro({ writeUp: 4 }),
    writeupplain: retro({ writeUp: { plain: 4 } }),
    proposalsobject: retro({ proposals: {} }),
    proposaltext: retro({ proposals: ['Proposal 1'] }),
    proposalzero: retro({ proposals: [{ ...draft, n: 0 }] }),
    proposalnotitle: retro({ proposals: [{ ...draft, title: undefined }] }),
    proposalcriteria: retro({ proposals: [{ ...draft, criteria: 'c' }] }),
    proposalboth: retro({ proposals: [{ ...draft, type: 'Task' }] }),
    proposalneither: retro({ proposals: [{ ...draft, label: undefined }] }),
    proposalworkstream: retro({ proposals: [{ ...draft, workstream: 4 }] }),
    proposalcard: retro({ proposals: [{ ...draft, card: { repository: 'example-owner/a', number: '7' } }] }),
    errorobject: { sources: [{ name: 'board', ok: false, error: { toString: null } }] },
    noerror: { sources: [{ name: 'board', ok: false }] },
    bogus: { items: [{ card: 4, title: 'b4', category: 'bogus' }] },
    bare: { items: [{ card: 4, title: 'b4', category: 'merge' }] },
    novisual: { items: [{ card: 4, title: 'b4', category: 'merge', decisionCard: 'Ship it.' }] },
    noshots: { items: [{ card: 4, title: 'b4', category: 'merge', decisionCard: 'Ship it.', screenshots: [] }] },
    halfmissing: { items: [{ card: 4, title: 'b4', category: 'merge', missing: { fact: 'no worktree' } }] },
    noquestion: { items: [{ card: 4, title: 'b4', category: 'question' }] },
    noreason: { items: [{ card: 4, title: 'b4', category: 'usage-limit' }] },
    textcard: { items: [{ card: '4', title: 'b4', category: 'question', question: 'Which one?' }] },
    heldnumber: { items: [{ card: 4, title: 'b4', category: 'question', question: 'Which one?', heldOn: 7 }] },
    heldblank: { items: [{ card: 4, title: 'b4', category: 'question', question: 'Which one?', heldOn: '   ' }] },
    noproblem: { items: [{ category: 'problem' }] },
    shotstext: { items: [{ card: 4, title: 'b4', category: 'question', question: 'Which one?', screenshots: 'shot.png' }] },
    shotsnull: { items: [{ card: 4, title: 'b4', category: 'merge', decisionCard: 'Ship it.', visual: 'none', screenshots: null }] },
    shotsobject: {
      items: [{ card: 4, title: 'b4', category: 'merge', missing: { fact: 'no worktree', next: 'make one' }, screenshots: {} }],
    },
    shotsnumbers: { items: [{ card: 4, title: 'b4', category: 'merge', decisionCard: 'Ship it.', screenshots: [1] }] },
    problemshots: { items: [{ category: 'problem', problem: 'broken', screenshots: 'shot.png' }] },
    nosubject: { digest: [{ sha: 'c1', at: '2026-11-09T09:00:00Z' }] },
    badtime: { digest: [{ sha: 'c1', at: 'yesterday', subject: 'merge c1' }] },
    badfetch: { fetchedAt: 'soon' },
  };
  const names = ['good', ...Object.keys(bad)];
  for (const name of names) mkdirSync(join(root, name));
  const collectors = {
    good: () => collectorDocument({ items: [{ card: 3, title: 'g3', category: 'question', question: 'Which one?' }] }),
    ...Object.fromEntries(Object.entries(bad).map(([name, fields]) => [name, () => collectorDocument(fields)])),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)]() });

  const { problems, items } = cache();
  assert.deepEqual(problems, Object.keys(bad).map(
    (name) => `${name}: the queue reader failed: its output is not a queue document`,
  ));
  assert.deepEqual(items.map((item) => item.key), [`${join(root, 'good')}#3`]);
});

test('an incomplete release receipt is reported and the repositories are still read', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const damaged = 'Machine record damaged: its release receipt is incomplete, so the panel files cannot be checked';
  const receipt = releaseReceipt();
  const damages = {
    'a tag with no files': { files: {} },
    'no tag': { release: {} },
    'a format other than 1 or 2': { format: 3 },
    'a file hash that is not a sha256': { files: { ...receipt.files, 'main.js': 'not-a-hash' } },
    'a derived hash that is not a sha256': { ...derivedReceipt(), derived: { 'layouts/fabraik.json': 'not-a-hash' } },
    'a release with only a tag': { release: { tag: 'v1.0.0' } },
    'an extra receipt key': { release: { ...RELEASE, note: 'x' } },
    'an id that is not a positive integer': { release: { ...RELEASE, id: 0 } },
    'an asset id that is text': { release: { ...RELEASE, assetId: '2' } },
    'a digest without its sha256 prefix': { release: { ...RELEASE, digest: 'a'.repeat(64) } },
    'a tag that is not a version': { release: { ...RELEASE, tag: 'latest' } },
  };

  for (const [damage, fields] of Object.entries(damages)) {
    const { home, cache } = releasedHome(t, [repository], fields);

    await refresh({
      home,
      runCollector: () => collectorDocument({ items: [{ card: 3, title: 'a3', category: 'question', question: 'Which one?' }] }),
    });

    assert.deepEqual(cache().problems, [damaged], damage);
    assert.deepEqual(cache().items.map((item) => item.key), [`${repository}#3`], damage);
  }
});

test('a format 1 and a format 2 machine record each read with no problem', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  for (const [format, receipt] of /** @type {[string, object][]} */ ([['format 1', releaseReceipt()], ['format 2', derivedReceipt()]])) {
    const { home, cache } = releasedHome(t, [repository], receipt);

    await refresh({
      home,
      runCollector: () => collectorDocument({ items: [{ card: 3, title: 'a3', category: 'question', question: 'Which one?' }] }),
    });

    assert.deepEqual(cache().problems, [], format);
    assert.deepEqual(cache().items.map((item) => item.key), [`${repository}#3`], format);
  }
});

test('a repository the machine record lists twice gives each item and problem once', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository, repository]);

  await refresh({
    home,
    runCollector: () => collectorDocument({
      sources: [{ name: 'board', ok: true }, { name: 'details', ok: false, error: 'card 4: comments unavailable' }],
      items: [{ card: 3, title: 'a3', category: 'question', question: 'Which one?' }],
      digest: [merge('c1', '2026-11-09T08:00:00Z')],
    }),
  });

  assert.deepEqual(cache().items.map((item) => item.key), [`${repository}#3`, `${repository}@c1`]);
  assert.deepEqual(cache().problems, [`${basename(repository)}: details could not be read: card 4: comments unavailable`]);
});

test('the cache is format 2 and names, in record order, the repositories whose digest was not read', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const names = ['failed', 'good', 'nodigest'];
  for (const name of names) mkdirSync(join(root, name));
  const collectors = {
    failed: () => Promise.reject(Object.assign(new Error('Command failed: node scripts/owner-queue.mjs'), { killed: false, code: 1 })),
    good: () => collectorDocument({ digest: [merge('g1', '2026-11-09T09:00:00Z')] }),
    nodigest: () => collectorDocument({ items: [{ card: 2, title: 'n2', category: 'merge', decisionCard: 'Ship it.', visual: 'none' }], digest: null }),
  };
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({ home, runCollector: (repository) => collectors[basename(repository)]() });

  assert.equal(cache().format, 2);
  assert.deepEqual(cache().digestUnread, [join(root, 'failed'), join(root, 'nodigest')]);

  const healthy = releasedHome(t, [join(root, 'good')]);
  await refresh({ home: healthy.home, runCollector: collectors.good });
  assert.deepEqual(healthy.cache().digestUnread, []);
});

// A home whose cache holds a digest and whose Clear marks are empty, with the write lock directory present. `files()`
// reads the marks and the cache, which a refused write leaves as `before` has them.
async function lockedHome(t) {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const made = releasedHome(t, [repository]);
  const marks = join(made.state, 'dismissed.json');
  writeFileSync(marks, JSON.stringify({ format: 1, marks: {} }));
  await refresh({
    home: made.home,
    runCollector: () => collectorDocument({ digest: [merge('c2', '2026-11-09T09:00:00Z'), merge('c1', '2026-11-09T08:00:00Z')] }),
  });
  const lock = join(made.state, 'write.lock');
  mkdirSync(lock);
  const files = () => [readFileSync(marks, 'utf8'), readFileSync(join(made.state, 'queue.json'), 'utf8')];
  return { ...made, repository, marks, lock, files, before: files() };
}

test('clear-digest refuses while another write holds the lock and changes nothing', async (t) => {
  const { home, files, before } = await lockedHome(t);

  const cleared = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home], { encoding: 'utf8' });

  assert.equal(cleared.status, 1, 'clear-digest should fail while the lock is held');
  assert.match(cleared.stderr, /the queue is busy/);
  assert.deepEqual(files(), before);
});

test('refresh refuses while another write holds the lock and changes nothing', async (t) => {
  const { home, files, before } = await lockedHome(t);

  await assert.rejects(
    refresh({ home, runCollector: () => collectorDocument({ items: [{ card: 9, title: 'x9', category: 'merge', decisionCard: 'Ship it.', visual: 'none' }] }) }),
    /the queue is busy/,
  );

  assert.deepEqual(files(), before);
});

test('clear-digest removes a write lock older than a minute and proceeds', async (t) => {
  const { home, repository, marks, lock } = await lockedHome(t);
  const stale = new Date(Date.now() - 120_000);
  utimesSync(lock, stale, stale);

  const cleared = spawnSync(process.execPath, [QUEUE, 'clear-digest', '--home', home], { encoding: 'utf8' });

  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marks, 'utf8')), { format: 1, marks: { [repository]: 'c2' } });
  assert.equal(existsSync(lock), false, 'the lock is released once clear-digest is done');
});

test('a screenshots folder that is a link fails the refresh and nothing outside is removed', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const outside = temporaryFolder(t, 'herdr-queue-outside-');
  const { home, state } = releasedHome(t, [repository]);
  const shots = join(state, 'shots');
  symlinkSync(outside, shots, 'junction');
  // Named like a copy and two days old, so a prune that follows the link would remove it.
  const old = join(outside, `${'a'.repeat(64)}.png`);
  writeFileSync(old, 'x');
  const then = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(old, then, then);

  await assert.rejects(
    refresh({ home, runCollector: () => collectorDocument() }),
    new RegExp(`${literal(shots)} is not a real folder`),
  );

  assert.equal(existsSync(old), true, 'the file outside the Herdr home is untouched');
  assert.equal(existsSync(join(state, 'queue.json')), false, 'a refused refresh writes no cache');
});

// `act <key> <action> <version> [<reply>]` hands a panel answer to the repository's own queue reader. The stub reader
// prints its document when run with no argument and, with arguments, records them and the folder it ran in, so a
// refusal is seen as nothing recorded.
test('queue act refuses an unknown key, an item without a version and any other argument shape', (t) => {
  const version = 'c'.repeat(64);
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'acts.jsonl');
  mkdirSync(join(repository, 'scripts'));
  const document = collectorDocument({ items: [
    { card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', visual: 'none', version },
    { card: 6, title: 'a6', category: 'merge', decisionCard: 'Ship it.', visual: 'none' },
  ] });
  writeFileSync(join(repository, 'scripts', 'owner-queue.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `if (args.length > 0) appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
    `else process.stdout.write(${JSON.stringify(JSON.stringify(document))});`,
    '',
  ].join('\n'));
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8' });
  const forwarded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const refreshed = queue('refresh', '--home', home);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const key = `${repository}#5`;

  for (const shape of [
    ['act', '--home', home],
    ['act', key, 'park', '--home', home],
    ['act', key, 'answer', version, 'Blue.', 'extra', '--home', home],
    ['act', key, 'park', version],
    ['act', key, 'park', version, '--home', home, '--all'],
    ['act', key, 'park', '--home', join(repository, 'no-such-home')],
    ['act', key, 'pick', version, '--home', home],
    ['act', key, 'pick', version, '0', '--home', home],
    ['act', key, 'pick', version, 'one', '--home', home],
    ['act', key, 'pick', version, '1', '2', '--home', home],
  ]) {
    const refused = queue(...shape);
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
  assert.deepEqual(forwarded(), [], 'a refused shape runs no queue reader');

  for (const [why, other] of [['an unknown key', `${repository}#9`], ['an item without a version', `${repository}#6`]]) {
    const refused = queue('act', other, 'park', version, '--home', home);
    assert.equal(refused.status, 1, `${why}: ${refused.stderr}`);
    assert.deepEqual(forwarded(), [], `${why} runs no queue reader`);
  }

  // The positive control: the cached item with its version reaches the reader, run in its repository.
  const acted = queue('act', key, 'park', version, '--home', home);
  assert.equal(acted.status, 0, acted.stderr);
  assert.deepEqual(forwarded().map(({ args, cwd }) => ({ args, cwd: realpathSync(cwd) })),
    [{ args: ['act', '--card=5', '--action=park', `--version=${version}`], cwd: realpathSync(repository) }]);
  // Yes is no panel action: it is refused as any other word is, and runs no queue reader.
  const yes = queue('act', key, 'yes', version, '--home', home);
  assert.deepEqual({ status: yes.status, stderr: yes.stderr }, { status: 2, stderr: QUEUE_USAGE }, 'yes is not an act action');
  assert.equal(forwarded().length, 1, 'a refused yes runs no queue reader');
});

// A merge answer goes to the coordinator, so its reader verb is `relay`; a question answer and a merge put aside keep `act`.
test('queue act hands a merge answer to its reader as relay and a question answer as act', (t) => {
  const [mergeVersion, questionVersion] = ['c'.repeat(64), 'd'.repeat(64)];
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'acts.jsonl');
  mkdirSync(join(repository, 'scripts'));
  const document = collectorDocument({ items: [
    { card: 5, title: 'a5', category: 'merge', decisionCard: 'Ship it.', visual: 'none', version: mergeVersion },
    { card: 6, title: 'a6', category: 'question', question: 'Which colour?', answerable: true, version: questionVersion },
  ] });
  writeFileSync(join(repository, 'scripts', 'owner-queue.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `if (args.length > 0) appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');`,
    `else process.stdout.write(${JSON.stringify(JSON.stringify(document))});`,
    '',
  ].join('\n'));
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8' });
  const forwarded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const refreshed = queue('refresh', '--home', home);
  assert.equal(refreshed.status, 0, refreshed.stderr);

  for (const shape of [
    ['act', `${repository}#5`, 'answer', mergeVersion, 'yes'],
    ['act', `${repository}#6`, 'answer', questionVersion, 'Blue.'],
    ['act', `${repository}#5`, 'park', mergeVersion],
  ]) {
    const acted = queue(...shape, '--home', home);
    assert.equal(acted.status, 0, `${JSON.stringify(shape)}: ${acted.stderr}`);
  }
  assert.deepEqual(forwarded(), [
    ['relay', '--card=5', `--version=${mergeVersion}`, '--reply=yes'],
    ['act', '--card=6', '--action=answer', `--version=${questionVersion}`, '--reply=Blue.'],
    ['act', '--card=5', '--action=park', `--version=${mergeVersion}`],
  ]);
});

test('queue act forwards a pick with its proposal number', (t) => {
  const version = 'c'.repeat(64);
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'acts.jsonl');
  mkdirSync(join(repository, 'scripts'));
  const proposals = [1, 2].map((n) => ({ n, repository: 'example-owner/a', title: `Proposal ${n}`, label: 'enhancement', problem: 'p', build: 'b', criteria: ['c'] }));
  const document = collectorDocument({ items: [{ card: 5, title: 'a5', category: 'suggested', version, writeUp: 'Nothing else.', proposals }] });
  writeFileSync(join(repository, 'scripts', 'owner-queue.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `if (args.length > 0) appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');`,
    `else process.stdout.write(${JSON.stringify(JSON.stringify(document))});`,
    '',
  ].join('\n'));
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8' });
  const refreshed = queue('refresh', '--home', home);
  assert.equal(refreshed.status, 0, refreshed.stderr);

  const picked = queue('act', `${repository}#5`, 'pick', version, '2', '--home', home);
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    [['act', '--card=5', '--action=pick', `--version=${version}`, '--proposal=2']]);
});

// `act` hands the reader's undo record, the text after `owner-queue: undo record ` on its last line, to the panel on
// stdout, and `undo <key> <action> <record>` runs the reader's `undo` in a repository the machine record lists. Two
// folders hold the same stub reader, which records its arguments and folder to the one acts.jsonl and answers as the
// reader's entry does; only `repository` is listed.
test("queue act passes on its reader's undo record, and queue undo runs only in a listed repository with a well-formed request", (t) => {
  const versions = { 5: 'c'.repeat(64), 7: 'd'.repeat(64) };
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const unlisted = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'acts.jsonl');
  const document = collectorDocument({ items: [5, 7].map((card) => (
    { card, title: `a${card}`, category: 'merge', decisionCard: 'Ship it.', visual: 'none', version: versions[card] }
  )) });
  for (const folder of [repository, unlisted]) {
    mkdirSync(join(folder, 'scripts'));
    writeFileSync(join(folder, 'scripts', 'owner-queue.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `if (args.length === 0) process.stdout.write(${JSON.stringify(JSON.stringify(document))});`,
      'else {',
      `  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
      "  if (args[0] === 'act' && args[1] === '--card=5') process.stdout.write('owner-queue: card 5: park written\\nowner-queue: undo record {\"r\":5}\\n');",
      "  else if (args[0] === 'act') process.stdout.write('owner-queue: card 7: park written\\n');",
      "  else if (args.includes('--record={\"r\":\"moved\"}')) {",
      "    process.stderr.write('owner-queue: card 5 moved since it was put aside: it is now in Ready\\n');",
      '    process.exitCode = 1;',
      "  } else process.stdout.write('owner-queue: card 5: park taken back\\n');",
      '}',
      '',
    ].join('\n'));
  }
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], { encoding: 'utf8' });
  const forwarded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const refreshed = queue('refresh');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const key = `${repository}#5`;

  const parked = queue('act', key, 'park', versions[5]);
  assert.deepEqual({ status: parked.status, stdout: parked.stdout }, { status: 0, stdout: '{"r":5}\n' }, parked.stderr);
  const unrecorded = queue('act', `${repository}#7`, 'park', versions[7]);
  assert.deepEqual({ status: unrecorded.status, stdout: unrecorded.stdout }, { status: 0, stdout: '' }, unrecorded.stderr);

  const taken = queue('undo', key, 'park', '{"r":5}');
  assert.equal(taken.status, 0, taken.stderr);
  assert.deepEqual(forwarded().at(-1), { args: ['undo', '--card=5', '--action=park', '--record={"r":5}'], cwd: realpathSync(repository) });
  const moved = queue('undo', key, 'park', '{"r":"moved"}');
  assert.equal(moved.status, 1, moved.stderr);
  assert.ok(moved.stderr.includes('card 5 moved since it was put aside: it is now in Ready'), moved.stderr);

  const before = forwarded().length;
  const elsewhere = queue('undo', `${unlisted}#5`, 'park', '{"r":5}');
  assert.equal(elsewhere.status, 1, elsewhere.stderr);
  assert.equal(forwarded().length, before, 'an unlisted repository runs no queue reader');
  assert.ok(forwarded().every(({ cwd }) => realpathSync(cwd) !== realpathSync(unlisted)));

  for (const shape of [['undo', key, 'answer', 'x'], ['undo', 'nokey', 'park', 'x']]) {
    const refused = queue(...shape);
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
  assert.equal(forwarded().length, before, 'a refused shape runs no queue reader');
});

// Two folders hold the same stub reader, which records its arguments and folder to the one moves.jsonl and, as the
// reader's `move` does, writes its log line to standard output; only `repository` is listed in the machine record.
function moveReaders(t) {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const unlisted = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'moves.jsonl');
  for (const folder of [repository, unlisted]) {
    mkdirSync(join(folder, 'scripts'));
    writeFileSync(join(folder, 'scripts', 'owner-queue.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
      "process.stdout.write('owner-queue: card 5: move written\\n');",
      '',
    ].join('\n'));
  }
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], { encoding: 'utf8' });
  const forwarded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { repository, unlisted, home, queue, forwarded };
}

// `move <key> <move> <version> [<place>]` hands a Board move to the repository's own queue reader and prints nothing.
test("queue move forwards its card, move, version and any place to the listed repository's reader and prints nothing", (t) => {
  const { repository, queue, forwarded } = moveReaders(t);
  const versions = { ready: 'a'.repeat(64), backlog: 'b'.repeat(64), up: '0123456789abcdef'.repeat(4), place: 'e'.repeat(64) };

  for (const [card, move, ...place] of [[5, 'ready'], [6, 'backlog'], [7, 'up'], [8, 'place', '3']]) {
    const moved = queue('move', `${repository}#${card}`, move, versions[move], ...place);
    assert.deepEqual({ status: moved.status, stdout: moved.stdout }, { status: 0, stdout: '' }, `${move}: ${moved.stderr}`);
  }
  assert.deepEqual(forwarded().map(({ args, cwd }) => ({ args, cwd: realpathSync(cwd) })), [
    { args: ['move', '--card=5', '--move=ready', `--version=${versions.ready}`], cwd: realpathSync(repository) },
    { args: ['move', '--card=6', '--move=backlog', `--version=${versions.backlog}`], cwd: realpathSync(repository) },
    { args: ['move', '--card=7', '--move=up', `--version=${versions.up}`], cwd: realpathSync(repository) },
    { args: ['move', '--card=8', '--move=place', `--version=${versions.place}`, '--to=3'], cwd: realpathSync(repository) },
  ]);
});

test('queue move runs only in a listed repository and refuses any other argument shape', async (t) => {
  const version = 'c'.repeat(64);
  const { repository, unlisted, home, queue, forwarded } = moveReaders(t);
  const key = `${repository}#5`;
  const printed = t.mock.method(console, 'error', () => {});

  const elsewhere = queue('move', `${unlisted}#5`, 'ready', version);
  assert.deepEqual(
    { status: elsewhere.status, stdout: elsewhere.stdout, stderr: elsewhere.stderr },
    { status: 1, stdout: '', stderr: `queue: ${unlisted}#5: the machine record does not list ${unlisted}\n` },
  );
  assert.deepEqual(forwarded(), [], 'an unlisted repository runs no queue reader');

  const spawned = queue('move', key, 'ready');
  assert.deepEqual({ status: spawned.status, stderr: spawned.stderr }, { status: 2, stderr: QUEUE_USAGE });
  // The other shapes run in process through `main`; the spawned refusal above proves the entry reaches it.
  const refusedIn = async (shape) => {
    printed.mock.resetCalls();
    const code = await queueMain(shape);
    assert.deepEqual({ code, printed: printed.mock.calls.map(({ arguments: args }) => args) }, { code: 2, printed: [[QUEUE_USAGE.trimEnd()]] }, JSON.stringify(shape));
  };
  for (const shape of [
    ['move', key, 'ready', 'c'.repeat(63)],
    ['move', key, 'ready', 'c'.repeat(65)],
    ['move', key, 'ready', 'C'.repeat(64)],
    ['move', key, 'ready', 'g'.repeat(64)],
    ['move', key, 'sideways', version],
    ['move', key, 'park', version],
    ['move', 'nokey', 'ready', version],
    ['move', key, 'ready', version, 'extra'],
    ['move', key, 'place', version],
    ['move', key, 'place', version, '0'],
    ['move', key, 'place', version, 'x'],
    ['move', key, 'up', version, '2'],
    ['move', key, 'place', version, '2', 'extra'],
  ]) await refusedIn([...shape, '--home', home]);
  for (const shape of [
    ['move', key, 'ready', version],
    ['move', key, 'ready', version, '--home', home, '--all'],
  ]) await refusedIn(shape);
  assert.deepEqual(forwarded(), [], 'a refused shape runs no queue reader');
});

// `show-first <key> <on|off>` hands a card's Show me first state to the repository's own queue reader and prints nothing.
test("queue show-first forwards its card and state to the listed repository's reader and prints nothing", (t) => {
  const { repository, queue, forwarded } = moveReaders(t);

  for (const [card, state] of [[5, 'on'], [6, 'off']]) {
    const marked = queue('show-first', `${repository}#${card}`, state);
    assert.deepEqual({ status: marked.status, stdout: marked.stdout }, { status: 0, stdout: '' }, `${state}: ${marked.stderr}`);
  }
  assert.deepEqual(forwarded().map(({ args, cwd }) => ({ args, cwd: realpathSync(cwd) })), [
    { args: ['show-first', '--card=5', '--state=on'], cwd: realpathSync(repository) },
    { args: ['show-first', '--card=6', '--state=off'], cwd: realpathSync(repository) },
  ]);
});

test('queue show-first runs only in a listed repository and refuses any other argument shape', (t) => {
  const { repository, unlisted, home, queue, forwarded } = moveReaders(t);
  const key = `${repository}#5`;

  const elsewhere = queue('show-first', `${unlisted}#5`, 'on');
  assert.deepEqual(
    { status: elsewhere.status, stdout: elsewhere.stdout, stderr: elsewhere.stderr },
    { status: 1, stdout: '', stderr: `queue: ${unlisted}#5: the machine record does not list ${unlisted}\n` },
  );
  assert.deepEqual(forwarded(), [], 'an unlisted repository runs no queue reader');

  for (const shape of [
    ['show-first'],
    ['show-first', key],
    ['show-first', 'on'],
    ['show-first', key, 'toggle'],
    ['show-first', key, 'ON'],
    ['show-first', key, 'ready'],
    ['show-first', 'nokey', 'on'],
    ['show-first', key, 'on', 'extra'],
  ]) {
    const refused = queue(...shape);
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
  for (const shape of [
    ['show-first', key, 'on'],
    ['show-first', key, 'on', '--home', home, '--all'],
  ]) {
    const refused = spawnSync(process.execPath, [QUEUE, ...shape], { encoding: 'utf8' });
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
  assert.deepEqual(forwarded(), [], 'a refused shape runs no queue reader');
});

// Two folders hold the same stub reader, which records its arguments and folder to the one reports.jsonl and prints the
// text of the `report.txt` beside its `scripts/` folder, as the reader's `report` prints its document; only `repository`
// is listed in the machine record. `reading(document)` sets what both readers print, a document as JSON or text.
function reportReaders(t) {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const unlisted = temporaryFolder(t, 'herdr-queue-repo-');
  const record = join(repository, 'reports.jsonl');
  for (const folder of [repository, unlisted]) {
    mkdirSync(join(folder, 'scripts'));
    writeFileSync(join(folder, 'scripts', 'owner-queue.mjs'), [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
      "process.stdout.write(readFileSync(new URL('../report.txt', import.meta.url), 'utf8'));",
      '',
    ].join('\n'));
  }
  const { home } = releasedHome(t, [repository]);
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], { encoding: 'utf8' });
  const forwarded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const reading = (document) => {
    for (const folder of [repository, unlisted]) {
      writeFileSync(join(folder, 'report.txt'), typeof document === 'string' ? document : JSON.stringify(document));
    }
  };
  const shots = join(home, 'fabraik-queue', 'shots');
  const stored = () => (existsSync(shots) ? readdirSync(shots).sort() : []);
  return { repository, unlisted, home, shots, queue, forwarded, reading, stored };
}

const MERGE_SHA = 'd'.repeat(40);
const PNG_HEAD = Buffer.from('89504e470d0a1a0a', 'hex');
const reportDocument = (fields) => ({
  format: 1,
  sha: MERGE_SHA,
  pull: { number: 12, title: 'Show the report', url: 'https://github.com/o/r/pull/12' },
  card: { number: 9, title: 'Merged work shows its report' },
  changed: 'The queue panel shows a report.',
  checks: ['Passed: the focused tests', 'Failed: none', 'Untested: nothing'],
  noScreen: false,
  outcome: 'nothing',
  level: 'when-needed',
  screenshots: [],
  ...fields,
});

// `report <key>` hands one merge's report, `<repository>@<sha>`, to the repository's reader, keeps each screenshot's
// bytes in `shots/` as `withShotCopies` does, and prints the reader's document with each `{alt, type, data}` replaced by
// `{alt, path}`: the copy's place, which Herdr's image() draws, and never the bytes.
test("queue report stores a merge's screenshots in shots and prints its report with their paths", (t) => {
  const { repository, home, shots, queue, forwarded, reading, stored } = reportReaders(t);
  const key = `${repository}@${MERGE_SHA}`;
  const first = Buffer.concat([PNG_HEAD, Buffer.from('first screenshot')]);
  const second = Buffer.concat([PNG_HEAD, Buffer.from('second screenshot')]);
  const document = reportDocument({
    screenshots: [
      { alt: 'screenshot-1 aaa', type: 'png', data: first.toString('base64') },
      { alt: 'screenshot-2 bbb', unread: 'its download answered HTTP 404' },
      { alt: 'screenshot-3 ccc', type: 'png', data: second.toString('base64') },
    ],
  });
  reading(document);

  const shown = queue('report', key);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(forwarded().map(({ args, cwd }) => ({ args, cwd: realpathSync(cwd) })), [
    { args: ['report', `--sha=${MERGE_SHA}`], cwd: realpathSync(repository) },
  ]);
  const { screenshots, ...rest } = JSON.parse(shown.stdout);
  const { screenshots: sent, ...sentRest } = document;
  assert.deepEqual(rest, sentRest, 'every other field passes through as the reader printed it');
  assert.deepEqual(screenshots.map(({ alt }) => alt), sent.map(({ alt }) => alt));
  assert.deepEqual(screenshots[1], sent[1], 'a screenshot the reader could not read passes through unchanged');
  assert.ok(!shown.stdout.includes('"data"') && !shown.stdout.includes(first.toString('base64')), 'no bytes are printed');
  assert.deepEqual(Object.keys(screenshots[0]).sort(), ['alt', 'path']);
  assert.deepEqual(Object.keys(screenshots[2]).sort(), ['alt', 'path']);

  // Each copy is named by the sha256 of its bytes (with the type's extension, as the item copies are), in `shots/`.
  for (const [shot, bytes] of [[screenshots[0], first], [screenshots[2], second]]) {
    const copy = resolve(home, shot.path);
    assert.equal(dirname(copy), shots, shot.path);
    assert.ok([sha256(bytes), `${sha256(bytes)}.png`].includes(basename(copy)), shot.path);
    assert.ok(readFileSync(copy).equals(bytes), 'the copy holds the decoded bytes');
  }
  assert.equal(stored().length, 2);

  // The same bytes again keep the one copy and refresh its time, so the prune that follows a refresh keeps it a day.
  const copy = resolve(home, screenshots[0].path);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(copy, old, old);
  const again = queue('report', key);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, shown.stdout);
  assert.equal(stored().length, 2, 'a repeat store writes no second copy');
  assert.ok(statSync(copy).mtimeMs > old.getTime(), "a repeat store refreshes the copy's time");

  // A merge with no pull request has no screenshots and passes through.
  const direct = { format: 1, sha: MERGE_SHA, direct: true };
  reading(direct);
  const pushed = queue('report', key);
  assert.deepEqual({ status: pushed.status, document: JSON.parse(pushed.stdout) }, { status: 0, document: direct }, pushed.stderr);

  // A summary the reader could not make safe markdown of is carried as plain text, and the runner passes it through.
  const plain = reportDocument({ changed: { plain: 'Run `x <card>` now.' } });
  reading(plain);
  const plainShown = queue('report', key);
  assert.deepEqual({ status: plainShown.status, document: JSON.parse(plainShown.stdout) }, { status: 0, document: plain }, plainShown.stderr);
});

test('queue report refuses a malformed key, an unlisted project and a malformed report by name', (t) => {
  const { repository, unlisted, queue, forwarded, reading, stored } = reportReaders(t);
  const key = `${repository}@${MERGE_SHA}`;
  const good = { alt: 'screenshot-1 aaa', type: 'png', data: Buffer.concat([PNG_HEAD, Buffer.from('good')]).toString('base64') };
  reading(reportDocument({ screenshots: [good] }));

  for (const shape of [
    'nokey',
    `${repository}#5`,
    `${repository}@${'d'.repeat(39)}`,
    `${repository}@${'d'.repeat(41)}`,
    `${repository}@${'D'.repeat(40)}`,
    `${repository}@${'g'.repeat(40)}`,
    `@${MERGE_SHA}`,
  ]) {
    const refused = queue('report', shape);
    assert.ok(refused.status !== 0 && refused.stdout === '' && refused.stderr !== '', `${shape}: ${refused.status} ${refused.stderr}`);
  }
  assert.deepEqual(forwarded(), [], 'a malformed key runs no queue reader');

  const elsewhere = queue('report', `${unlisted}@${MERGE_SHA}`);
  assert.deepEqual(
    { status: elsewhere.status, stdout: elsewhere.stdout, stderr: elsewhere.stderr },
    { status: 1, stdout: '', stderr: `queue: ${unlisted}@${MERGE_SHA}: the machine record does not list ${unlisted}\n` },
  );
  assert.deepEqual(forwarded(), [], 'an unlisted repository runs no queue reader');

  // Each malformed document is refused naming what it breaks, after `good`, which is valid, and nothing is stored.
  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64');
  const second = (fields) => ({ ...good, alt: 'screenshot-2 bbb', ...fields });
  for (const [name, document, names] of [
    ['output that is not JSON', 'not a document', /./],
    ['another format', reportDocument({ format: 2 }), /format/],
    ['another merge', reportDocument({ sha: 'e'.repeat(40) }), /sha/],
    ['a changed that is a number', reportDocument({ changed: 5 }), /changed/],
    ['a changed unread that is not text', reportDocument({ changed: { unread: 7 } }), /changed/],
    ['a changed plain that is not text', reportDocument({ changed: { plain: 7 } }), /changed/],
    ['a changed plain with another key', reportDocument({ changed: { plain: 'x', unread: 'y' } }), /changed/],
    ['checks that are not a list', reportDocument({ checks: 'Passed: all' }), /checks/],
    ['a noScreen that is text', reportDocument({ noScreen: 'no' }), /noScreen/],
    ['an unknown outcome', reportDocument({ outcome: 'maybe' }), /outcome/],
    ['holds on a waited outcome', reportDocument({ outcome: 'waited', waiting: 'Waiting for you: sign-off', level: undefined, holds: ['sign-off'] }), /holds/],
    ['a waited outcome with no waiting line', reportDocument({ outcome: 'waited', level: undefined }), /waiting/],
    ['a waiting line on a nothing outcome', reportDocument({ waiting: 'Waiting for you: x' }), /waiting/],
    ['a level of always on a nothing outcome', reportDocument({ level: 'always' }), /level/],
    ['holds that are not a list', reportDocument({ outcome: 'disagrees', level: 'always', holds: 'sign-off' }), /holds/],
    ['an unread outcome with no cause', reportDocument({ outcome: 'unread', level: undefined }), /cause/],
    ['lasting beside a nothing outcome', reportDocument({ lasting: true }), /malformed lasting/],
    ['lasting false beside an unread outcome', reportDocument({ outcome: 'unread', level: undefined, cause: 'x', lasting: false }), /malformed lasting/],
    ['a screenshot of an unknown type', reportDocument({ screenshots: [good, second({ type: 'svg' })] }), /screenshot/i],
    ['a screenshot whose data is a number', reportDocument({ screenshots: [good, second({ data: 5 })] }), /screenshot/i],
    ['a screenshot of over 8 MiB', reportDocument({ screenshots: [good, second({ data: tooLarge })] }), /screenshot/i],
    ['a screenshot with no alt', reportDocument({ screenshots: [good, { type: 'png', data: good.data }] }), /screenshot/i],
    ['a direct document of another merge', { format: 1, sha: 'e'.repeat(40), direct: true }, /sha/],
  ]) {
    reading(document);
    const refused = queue('report', key);
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}`);
    assert.equal(refused.stdout, '', name);
    assert.match(refused.stderr, /^queue: /, name);
    assert.match(refused.stderr, names, name);
    assert.deepEqual(stored(), [], `${name}: nothing is stored`);
  }
});

// FNV-1a, 32 bits, as published (offset basis 0x811c9dc5, prime 0x01000193) over the UTF-16 code units of `text`, in BigInt
// so it shares nothing with the product's `Math.imul` form, as eight lowercase hex characters. The product names a kept
// report `<sha>-<digest of its repository>.json`; "a" hashes to e40c292c.
function fnv1a32(text) {
  let hash = 0x811c9dc5n;
  for (let at = 0; at < text.length; at += 1) hash = ((hash ^ BigInt(text.charCodeAt(at))) * 0x01000193n) & 0xffffffffn;
  return hash.toString(16).padStart(8, '0');
}
const keptNameOf = (repository, sha) => `${sha}-${fnv1a32(repository)}.json`;

test('the kept report name rule reads the published FNV-1a value', () => {
  assert.equal(fnv1a32('a'), 'e40c292c');
});

// `report` keeps the report it read in `reports/<sha>-<digest>.json`, the digest being eight hex characters of the repository, as
// `{ format, key, report }`, `report` being the printed document, unless a part of it may read differently later: an unread outcome that is not `lasting`, or a screenshot
// the reader could not download. The print is the same either way.
test('queue report keeps a report it read whole and never one with a part it may read later', (t) => {
  const { repository, home, queue, reading } = reportReaders(t);
  const key = `${repository}@${MERGE_SHA}`;
  const kept = join(home, 'fabraik-queue', 'reports', keptNameOf(repository, MERGE_SHA));
  const withShot = Buffer.concat([PNG_HEAD, Buffer.from('kept screenshot')]).toString('base64');
  const unread = { outcome: 'unread', level: undefined, cause: 'it closes no card' };

  for (const [name, document, keeps] of [
    ['a whole nothing report with a screenshot', reportDocument({ screenshots: [{ alt: 'screenshot-1 aaa', type: 'png', data: withShot }] }), true],
    ['a merge with no pull request', { format: 1, sha: MERGE_SHA, direct: true }, true],
    ['an unread outcome that is lasting', reportDocument({ ...unread, lasting: true }), true],
    ['an unread outcome that may read differently later', reportDocument(unread), false],
    ['a screenshot that could not be downloaded', reportDocument({ screenshots: [{ alt: 'screenshot-1 aaa', unread: 'its download answered HTTP 404' }] }), false],
  ]) {
    rmSync(kept, { force: true });
    reading(document);
    const shown = queue('report', key);
    assert.equal(shown.status, 0, `${name}: ${shown.stderr}`);
    if (!document.screenshots?.some((shot) => Object.hasOwn(shot, 'data'))) {
      assert.equal(shown.stdout, `${JSON.stringify(document)}\n`, `${name}: the print is the reader's document`);
    }
    assert.equal(existsSync(kept), keeps, `${name}: ${keeps ? 'kept' : 'not kept'}`);
    if (keeps) {
      assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), { format: 1, key, report: JSON.parse(shown.stdout) }, name);
    }
  }
});

// A kept report is named `<sha>-<digest>.json`, the digest of its repository: two listed repositories holding the same merge
// commit keep two files, so reading the second leaves the first's kept report as it was, and a repository whose path stays
// under 240 characters keeps its file too when its percent-encoded key (each '€' becoming nine bytes) passes the 255-byte file name limit.
test("queue report keeps the reports of two repositories' same merge commit apart", (t) => {
  const deep = join(temporaryFolder(t, 'herdr-queue-repo-'), '€'.repeat(30));
  mkdirSync(deep, { recursive: true });
  const encodedKey = Buffer.byteLength(encodeURIComponent(`${deep}@${MERGE_SHA}`));
  assert.ok(encodedKey > 255, `the deep repository's encoded key is ${encodedKey} bytes`);
  assert.ok(deep.length < 240, `the deep repository's path is ${deep.length} characters`);
  const repositories = [temporaryFolder(t, 'herdr-queue-repo-'), deep];
  for (const [at, folder] of repositories.entries()) {
    mkdirSync(join(folder, 'scripts'));
    writeFileSync(join(folder, 'scripts', 'owner-queue.mjs'), "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(new URL('../report.txt', import.meta.url), 'utf8'));\n");
    writeFileSync(join(folder, 'report.txt'), JSON.stringify(reportDocument({ card: { number: 9, title: `Merged work of repository ${at}` } })));
  }
  const { home } = releasedHome(t, repositories);
  const keptFiles = () => readdirSync(join(home, 'fabraik-queue', 'reports'));

  for (const [at, folder] of repositories.entries()) {
    const key = `${folder}@${MERGE_SHA}`;
    const shown = spawnSync(process.execPath, [QUEUE, 'report', key, '--home', home], { encoding: 'utf8' });
    assert.equal(shown.status, 0, `repository ${at}: ${shown.stderr}`);
    assert.equal(keptFiles().length, at + 1, `repository ${at}: its report adds a file and overwrites none`);
  }
  assert.deepEqual(keptFiles().sort(), repositories.map((folder) => keptNameOf(folder, MERGE_SHA)).sort(), 'each file is named <sha>-<digest>.json');
  for (const [at, folder] of repositories.entries()) {
    const key = `${folder}@${MERGE_SHA}`;
    const kept = JSON.parse(readFileSync(join(home, 'fabraik-queue', 'reports', keptNameOf(folder, MERGE_SHA)), 'utf8'));
    assert.equal(kept.key, key, `repository ${at}: its file holds its own key`);
    assert.equal(kept.report.card.title, `Merged work of repository ${at}`, `repository ${at}: its file holds its own report`);
  }
});

test('a refresh removes kept reports over a day old and keeps the screenshots the others name', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, state } = releasedHome(t, [repository]);
  const shots = join(state, 'shots');
  const reports = join(state, 'reports');
  mkdirSync(shots);
  mkdirSync(reports);
  const aged = (folder, name, content, hours) => {
    writeFileSync(join(folder, name), content);
    const then = new Date(Date.now() - hours * 3_600_000);
    utimesSync(join(folder, name), then, then);
  };
  const [shotA, shotB, shotC] = ['a', 'b', 'c'].map((letter) => `${letter.repeat(64)}.png`);
  const keptNaming = (sha, shot) => JSON.stringify({
    format: 1,
    key: `${repository}@${sha}`,
    report: reportDocument({ sha, screenshots: [{ alt: 'screenshot-1 aaa', path: `fabraik-queue/shots/${shot}` }] }),
  });
  const [fresh, old, garbled] = ['e', 'f', '1'].map((letter) => keptNameOf(repository, letter.repeat(40)));
  for (const shot of [shotA, shotB, shotC]) aged(shots, shot, 'x', 48);
  aged(reports, fresh, keptNaming('e'.repeat(40), shotA), 1);
  aged(reports, old, keptNaming('f'.repeat(40), shotB), 25);
  aged(reports, garbled, 'not json', 1);

  await refresh({ home, runCollector: () => collectorDocument() });

  assert.deepEqual(readdirSync(shots).sort(), [shotA], 'a screenshot a kept report names stays; the others a day old go');
  assert.deepEqual(readdirSync(reports).sort(), [fresh, garbled].sort(), 'a kept report over a day old goes, a fresh one stays');
});

test('a kept reports folder that is a link fails the refresh and the report and nothing outside is removed', async (t) => {
  const { repository, home, queue, reading } = reportReaders(t);
  const outside = temporaryFolder(t, 'herdr-queue-outside-');
  const reports = join(home, 'fabraik-queue', 'reports');
  symlinkSync(outside, reports, 'junction');
  // Named like a kept report and two days old, so a prune that follows the link would remove it.
  const old = join(outside, keptNameOf(repository, MERGE_SHA));
  writeFileSync(old, 'x');
  const then = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(old, then, then);

  await assert.rejects(
    refresh({ home, runCollector: () => collectorDocument() }),
    new RegExp(`${literal(reports)} is not a real folder`),
  );
  assert.equal(existsSync(old), true, 'the file outside the Herdr home is untouched by the refresh');

  reading(reportDocument());
  const shown = queue('report', `${repository}@${MERGE_SHA}`);
  assert.deepEqual({ status: shown.status, stdout: shown.stdout }, { status: 1, stdout: '' });
  assert.match(shown.stderr, new RegExp(`${literal(reports)} is not a real folder`));
  assert.equal(existsSync(old), true, 'the file outside the Herdr home is untouched by the report');
});

// The cache keeps a board whose cards' `version` is 64 lowercase hex or absent, whose cards' `showFirst` is absent, a boolean or exactly `{ unread: <text> }`, and whose `moves` and `places`
// are each a boolean or absent; a board with any other value in any is unreadable on its own, and its repository's items
// still show. A card's `answered` key, which older readers still send, is ignored whatever its value.
test('a board whose card version, answered marker, moves or places flag or show-me-first marker is malformed is unreadable while its items still show', async (t) => {
  const root = temporaryFolder(t, 'herdr-queue-repos-');
  const version = 'a'.repeat(64);
  const card = (number, fields) => ({ card: number, title: `t${number}`, column: 'Backlog', blockers: [], claim: null, waitsOn: null, ...fields });
  const boards = {
    versioned: { cards: [card(1, { version }), card(2)], moves: true },
    plain: { cards: [card(3)], moves: false },
    shortversion: { cards: [card(4, { version: 'a'.repeat(63) })] },
    upperversion: { cards: [card(5, { version: 'A'.repeat(64) })] },
    numberversion: { cards: [card(6, { version: 6 })] },
    textmoves: { cards: [card(7)], moves: 'yes' },
    numbermoves: { cards: [card(8)], moves: 1 },
    placed: { cards: [card(16)], moves: true, places: true },
    textplaces: { cards: [card(17)], places: 'yes' },
    numberplaces: { cards: [card(18)], places: 1 },
    marked: { cards: [card(9, { showFirst: true }), card(10, { showFirst: false }), card(11, { showFirst: { unread: 'unreadable labels on card 11' } })], moves: true },
    textfirst: { cards: [card(12, { showFirst: 'on' })] },
    nullfirst: { cards: [card(13, { showFirst: null })] },
    numberunreadfirst: { cards: [card(14, { showFirst: { unread: 3 } })] },
    morefirst: { cards: [card(15, { showFirst: { unread: 'x', more: true } })] },
    answeredtrue: { cards: [card(16, { answered: true })], moves: true },
    answeredyes: { cards: [card(17, { answered: 'yes' })] },
    answeredfalse: { cards: [card(18, { answered: false })] },
  };
  const names = Object.keys(boards);
  for (const name of names) mkdirSync(join(root, name));
  const { home, cache } = releasedHome(t, names.map((name) => join(root, name)));

  await refresh({
    home,
    runCollector: (repository) => {
      const board = boards[basename(repository)];
      return collectorDocument({ items: [{ card: board.cards[0].card, title: 'q', category: 'question', question: 'Which one?' }], board });
    },
    terminals: NO_TERMINALS,
  });

  const notBoard = 'its board is not a board document';
  const entries = cache().boards.map(({ repository, cards, moves, places, unreadable }) => (
    { name: basename(repository), ...(unreadable === undefined ? { cards, moves, places } : { unreadable }) }
  ));
  assert.deepEqual(entries, names.map((name) => (
    ['versioned', 'plain', 'marked', 'answeredtrue', 'answeredyes', 'answeredfalse', 'placed'].includes(name)
      ? { name, cards: boards[name].cards, moves: boards[name].moves, places: boards[name].places }
      : { name, unreadable: notBoard }
  )));
  assert.deepEqual(
    cache().items.map((item) => item.key).sort(),
    names.map((name) => `${join(root, name)}#${boards[name].cards[0].card}`).sort(),
  );
});

// The panel (.agents/herdr/fabraik-queue/main.js) imports modules only Herdr's host provides. The test loads its text
// with the three host imports replaced by one line that takes the same names from a stub on `globalThis`, so the
// panel's own render() and click handlers run. The stub kit follows the kit's own types (gpui-kit.d.ts): its elements
// record their children, calls, click and key handlers, and a table row, head or cell its one-based `index`; a switch
// records its `checked` and `on_change` as calls; `InputState` holds a value the test types; `cx` records the focus
// handles made; a disabled button ignores a click.
const PANEL = fileURLToPath(new URL('../../.agents/herdr/fabraik-queue/main.js', import.meta.url));
const HOST_IMPORT = /^import \{ ([^}]*) \} from "(gpui-kit|gpui-base|herdr)";\n/gm;
let panelLoads = 0;

function element(kind, elementId, fields) {
  const record = { kind, elementId, kids: [], click: null, keyDown: null, linkClick: null, calls: [], ...fields };
  const self = new Proxy(record, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      // An element is not a promise, so awaiting a tree returns it.
      if (name === 'then') return undefined;
      if (Object.hasOwn(target, name)) return target[name];
      if (name === 'child') return (kid) => { target.kids.push(kid); return self; };
      if (name === 'children') return (kids) => { target.kids.push(...kids); return self; };
      if (name === 'when') return (condition, build) => { if (condition) build(self); return self; };
      if (name === 'id') return (value) => { target.elementId = value; return self; };
      if (name === 'on_click') return (handler) => { target.click = handler; return self; };
      if (name === 'on_key_down') return (handler) => { target.keyDown = handler; return self; };
      if (name === 'on_link_click') return (handler) => { target.linkClick = handler; return self; };
      return (...args) => { target.calls.push([name, args]); return self; };
    },
  });
  return self;
}

const called = (node, name) => node.calls.filter(([found]) => found === name).map(([, args]) => args);
const isDisabled = (node) => called(node, 'disabled').at(-1)?.[0] === true;

// Loads a fresh copy of the panel against a stub host whose `exec` records its calls and resolves `execResult`, or, when it is a
// function, what it returns given the call's arguments.
// `props()` gives the panel `props`, as Herdr gives a mod the props it was opened with; `run` records each Herdr command
// in `runs` and returns null, as Herdr's does, so a panel that imports it shows each command it ran; `openOverlay` records
// each spec in `overlays` and returns `overlay-<n>`, and `closeOverlay` records each id in `closedOverlays` and returns null.
// `shared()` reads `sharedState` and `setShared()` writes it, each write recorded in `sets`. `settings()` gives `settingsValue`,
// live, as Herdr's gives the person's settings, such as `zoom`; none unless a test sets it.
// `timers` records each `cx.timer.every` as `{ ms, handler, cancelled, cancel }`, which a test runs through `host.cx`.
// `terminals()` gives `terminalList` and `knownAgents()` resolves `agentPrograms`, each an empty list unless a test sets it,
// and each throws or rejects with it when it is an Error, as Herdr's do; `agents()` gives `agentList`, live, as Herdr's
// does, and `setAgentOrder` records each order in `agentOrders`. `panes()`, `spaces()` and `machines()` give `paneList`,
// `spaceList` and `machineList`, live: no pane or space, and this computer's layout read. `watchFolder` records each watch in `watches` as
// `{ path, settled, cancelled }`: it rejects at once where `refusedWatches` maps its path to a cause, `batch(path, paths)`
// resolves the open watch of `path` with that batch and settles what the panel started from it, and its `cancel()` resolves
// it with [], as Herdr's do. A task whose start opens a watch keeps watching for good, so no settle waits for it; `svg` and `image` record the path they draw.
// `setCache` sets the text `readTextFile` gives the panel's own `load()`, none where it is null; while `cacheGate` holds a
// promise, that read takes the text set at its call and resolves only once the promise does, as a slow read would. `files` maps any other path to its text, null where unset; `render` is the panel's render, which fails the
// test if it makes an `InputState`, as the kit forbids; `type` types into a drawn input and fires its change handlers, and
// `emit` fires the handlers of one of its other events, such as `focus`, `blur` and `submit`, which Enter fires.
// Focus handles hold focus one at a time, as a window does; `stopped` counts `cx.stop_propagation` calls; `opened` lists the
// address of each `cx.open_url`; a host import renamed
// with `as` keeps its new name. `bindings` records `cx.bind_keys`.
// By default `init` runs at load with a `spawn` that starts nothing, so no start-up work runs. With `lifecycle`, `init` waits
// for `started()`, which runs it with the recording `cx`, so a test sets the cache first, and settles every task it started.
/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {ExecResult | ((program: string, args: string[], options?: { timeout?: number }) => ExecResult | Promise<ExecResult>)} Exec what the stub `exec` resolves
 * @typedef {any} PanelHost the stub host a test drives: a mutable fixture, whose fields the tests set and read freely
 */
/**
 * @param {Exec} execResult
 * @param {any} [props]
 * @param {{ lifecycle?: boolean }} [options]
 * @returns {Promise<PanelHost>}
 */
async function loadPanel(execResult, props = {}, { lifecycle = false } = {}) {
  const source = readFileSync(PANEL, 'utf8');
  const imports = [...source.matchAll(HOST_IMPORT)];
  assert.deepEqual(imports.map((found) => found[2]), ['gpui-kit', 'gpui-base', 'herdr'], 'the panel imports the three host modules once each');
  const key = `fabraikQueuePanelStub${(panelLoads += 1)}`;
  const calls = [];
  const runs = [];
  const timers = [];
  const handles = [];
  const bindings = [];
  const madeWhileRendering = [];
  let cacheText;
  let rendering = false;
  // The task whose start is running, which a watch opened during it marks as a watcher.
  /** @type {{ watcher?: boolean } | null} */
  let starting = null;
  let host;
  globalThis[key] = {
    View: class {},
    div: () => element('div'),
    svg: (path) => element('svg', undefined, { path }),
    image: (path) => element('image', undefined, { path }),
    v_flex: () => element('v_flex'),
    h_flex: () => element('h_flex'),
    TextView: { markdown: (id, text) => element('markdown', id).child(text) },
    Button: { new: (id) => element('button', id) },
    Switch: { new: (id) => element('switch', id) },
    Toggle: { new: (id) => element('toggle', id) },
    Input: { new: (state) => element('input', undefined, { state }) },
    InputState: {
      new: (options = {}) => {
        if (rendering) madeWhileRendering.push(options);
        const handlers = { change: [], focus: [], blur: [], submit: [], paste_other: [] };
        return {
          placeholder: options.placeholder,
          text: options.value ?? '',
          focused: false,
          handlers,
          value() { return this.text; },
          set_value(next) { this.text = typeof next === 'string' ? next : next.text; },
          replace(text) { this.text = text; },
          set_selected_range() {},
          on(event, handler) { handlers[event].push(handler); return true; },
          focus() { this.focused = true; },
          release() { return true; },
        };
      },
    },
    Progress: { new: (id) => element('progress', id) },
    ProgressTrack: { new: () => element('progress-track') },
    ProgressIndicator: { new: () => element('progress-indicator') },
    Table: { new: (id) => element('table', id) },
    TableHeader: { new: (id) => element('table-header', id) },
    TableBody: { new: (id) => element('table-body', id) },
    TableRow: { new: (id, index) => element('table-row', id, { index }) },
    TableHead: { new: (id, index) => element('table-head', id, { index }) },
    TableCell: { new: (id, index) => element('table-cell', id, { index }) },
    exec: async (/** @type {[string, string[], { timeout?: number }?]} */ ...call) => { calls.push(call); return typeof execResult === 'function' ? execResult(...call) : execResult; },
    appHome: () => '/herdr/home',
    props: () => props,
    settings: () => host.settingsValue,
    run: (name, args) => { runs.push([name, args]); return null; },
    openOverlay: (spec) => { host.overlays.push(spec); return `overlay-${host.overlays.length}`; },
    closeOverlay: (id) => { host.closedOverlays.push(id); return null; },
    shared: (key) => host.sharedState[key],
    setShared: (key, value) => { host.sets.push([key, value]); host.sharedState[key] = value; },
    terminals: () => {
      if (host.terminalList instanceof Error) throw host.terminalList;
      return host.terminalList;
    },
    knownAgents: async () => {
      if (host.agentPrograms instanceof Error) throw host.agentPrograms;
      return host.agentPrograms;
    },
    agents: () => host.agentList,
    panes: () => host.paneList,
    spaces: () => host.spaceList,
    machines: () => host.machineList,
    setAgentOrder: (addresses) => { host.agentOrders.push(addresses); return null; },
    watchFolder: (path) => {
      if (starting !== null) starting.watcher = true;
      const entry = { path, settled: false, cancelled: false };
      /** @type {Promise<any> & { cancel?: () => void }} */
      const watch = new Promise((resolve, reject) => {
        entry.resolve = (paths) => { entry.settled = true; resolve(paths); };
        entry.reject = (error) => { entry.settled = true; reject(error); };
      });
      watch.cancel = () => { entry.cancelled = true; entry.resolve([]); };
      host.watches.push(entry);
      if (host.refusedWatches.has(path)) entry.reject(new Error(host.refusedWatches.get(path)));
      return watch;
    },
    theme: () => new Proxy({}, { get: (_target, name) => String(name) }),
    readTextFile: async (path) => {
      if (path !== '/herdr/home/fabraik-queue/queue.json') return host.files[path] ?? null;
      assert.notEqual(cacheText, undefined, 'the test set no cache for the panel to read');
      const text = cacheText;
      if (host.cacheGate) await host.cacheGate;
      return text;
    },
  };
  let mod;
  try {
    const names = imports.map((found) => found[1]).join(', ').replaceAll(' as ', ': ');
    let first = true;
    const loaded = source.replace(HOST_IMPORT, () => { const line = first ? `const { ${names} } = globalThis.${key};\n` : ''; first = false; return line; });
    mod = await import(`data:text/javascript,${encodeURIComponent(loaded)}`);
  } finally {
    delete globalThis[key];
  }
  const pending = [];
  const cx = {
    spawn: (run) => {
      const outer = starting;
      const task = {};
      starting = task;
      let done;
      try {
        done = run(cx);
      } finally {
        starting = outer;
      }
      if (!task.watcher) pending.push(done);
      return done;
    },
    notify() {},
    sleep: async () => {},
    timer: { every: (ms, handler) => { const timer = { ms, handler, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; } },
    focus_handle: () => {
      const handle = { focused: false, focus() { for (const other of handles) other.focused = false; this.focused = true; }, is_focused() { return this.focused; }, release: () => true };
      handles.push(handle);
      return handle;
    },
    stop_propagation: () => { host.stopped += 1; },
    open_url: (url) => { host.opened.push(url); },
    bind_keys: (list) => { bindings.push(...list); return list.length; },
  };
  const panel = new mod.default();
  if (!lifecycle) panel.init({}, { ...cx, spawn() {} });
  // What the tasks a handler started are still doing, from the handler's own start.
  const settled = (before) => Promise.all(pending.slice(before));
  // Settles every task started since `before`, those the tasks started in turn included.
  const drain = async (before) => {
    for (let seen = 0; pending.length - before > seen;) {
      seen = pending.length - before;
      await settled(before);
    }
  };
  // Settles every task a start started.
  const task = async (start) => {
    const before = pending.length;
    start(cx);
    await drain(before);
  };
  const render = () => {
    rendering = true;
    let tree;
    try {
      tree = panel.render(cx);
    } finally {
      rendering = false;
    }
    assert.deepEqual(madeWhileRendering, [], 'the panel makes no InputState while it renders');
    return tree;
  };
  host = {
    panel,
    calls,
    runs,
    cx,
    timers,
    overlays: [],
    closedOverlays: [],
    sharedState: {},
    settingsValue: {},
    files: {},
    cacheGate: null,
    sets: [],
    terminalList: [],
    agentPrograms: [],
    agentList: [],
    paneList: [],
    spaceList: [],
    machineList: [{ name: null, layout: 'ready' }],
    agentOrders: [],
    watches: [],
    refusedWatches: new Map(),
    handles,
    bindings,
    stopped: 0,
    opened: [],
    render,
    task,
    started: () => task((recording) => panel.init({}, recording)),
    setCache: (cache) => { cacheText = cache === null ? null : JSON.stringify(cache); },
    batch: async (path, paths) => {
      const open = host.watches.filter((watch) => watch.path === path && !watch.settled);
      assert.equal(open.length, 1, `one watch of ${path} is open, found ${open.length}`);
      const before = pending.length;
      open[0].resolve(paths);
      // The watching task runs on to its next watch, and starts what the batch asks for, before the next turn.
      await new Promise((resolve) => { setImmediate(resolve); });
      await drain(before);
    },
    click: (button) => {
      const before = pending.length;
      if (!isDisabled(button)) button.click({}, cx);
      return settled(before);
    },
    emit: (input, event) => { for (const handler of input.state.handlers[event]) handler({}, cx); },
    type: (input, text) => {
      input.state.text = text;
      for (const handler of input.state.handlers.change) handler({}, cx);
    },
    press: (keyName) => {
      const before = pending.length;
      const found = [...walk(render())].find(([node]) => node.keyDown);
      assert.ok(found, 'the panel root handles key presses');
      found[0].keyDown({ key: keyName, keystroke: keyName, key_char: keyName, modifiers: { shift: false, control: false, alt: false, platform: false, function: false } }, cx);
      return settled(before);
    },
  };
  return host;
}

// What a read of the cache does for a view with no queue command: loads the cache the test set, then reads the Board's
// merge reports, as the end of a refresh does.
const readCache = (host) => host.task((cx) => cx.spawn(async (cx) => { await host.panel.load(); host.panel.readMerges(cx); }));

const textOf = (node) => (typeof node === 'string' ? node : node.kids.map(textOf).join(' '));
function* walk(node, parent = null) {
  if (typeof node === 'string') return;
  yield [node, parent];
  for (const kid of node.kids) yield* walk(kid, node);
}
const buttonsIn = (node) => [...walk(node)].map(([found]) => found).filter((found) => found.kind === 'button');
const labelOf = (node) => called(node, 'accessibility_label').at(-1)?.[0];
// The Open log controls a tree draws.
const openLogButtons = (tree) => buttonsIn(tree).filter((button) => textOf(button).trim() === 'Open log');

// new behaviour: the panel reads no failure log, so an item's `log`, wherever it points, is dropped from the cache,
// adds no problem line, draws no Open log, and `open-log` is a command `queue.mjs` does not take.
test('a failure item with a log outside any runs folder adds no problem line, draws no Open log and has no open-log command', async (t) => {
  const log = join(temporaryFolder(t, 'herdr-queue-log-'), 'session.jsonl');
  writeFileSync(log, '{}\n');
  const reason = 'Card 81 stopped while building: tests red';
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);

  await refresh({ home, runCollector: () => collectorDocument({
    items: [{ card: 81, title: 'a81', category: 'failure', reason, log }],
  }) });

  assert.deepEqual(cache().problems, [], 'a log adds no problem line');
  assert.deepEqual(cache().items, [{ card: 81, title: 'a81', category: 'failure', reason, repository, key: `${repository}#81` }]);
  const host = await loadPanel({ code: 0, stdout: '', stderr: '' }, DECISIONS);
  host.panel.home = '/herdr/home';
  host.panel.state = { kind: 'read', cache: cache() };
  const drawn = host.render();
  assert.ok(textOf(drawn).includes(reason), `the item shows its reason: ${textOf(drawn)}`);
  assert.deepEqual(openLogButtons(drawn), [], 'an item with a log has no Open log');

  const opened = spawnSync(process.execPath, [QUEUE, 'open-log', `${repository}#81`, '--home', home], { encoding: 'utf8' });
  assert.deepEqual({ status: opened.status, stderr: opened.stderr }, { status: 2, stderr: QUEUE_USAGE });
});

test('a failure log over the cache limit is dropped and its item and a sibling both reach the cache', async (t) => {
  const reason = 'Card 81 stopped while building: tests red';
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);

  await refresh({ home, runCollector: () => collectorDocument({
    items: [
      { card: 81, title: 'a81', category: 'failure', reason, log: `/${'l'.repeat(1024 * 1024 + 1)}` },
      { card: 82, title: 'a82', category: 'question', question: 'Which one?' },
    ],
  }) });

  assert.deepEqual(cache().problems, [], 'no line says the queue is too large');
  // The cache ranks a question above a failure.
  assert.deepEqual(cache().items, [
    { card: 82, title: 'a82', category: 'question', question: 'Which one?', repository, key: `${repository}#82` },
    { card: 81, title: 'a81', category: 'failure', reason, repository, key: `${repository}#81` },
  ], 'both items reach the cache and neither carries a log');
});

// An item's controls: its response buttons hand the item's key, version and action to `queue.mjs act`. The expected
// buttons, texts and commands are written by hand from the plan's Responses, Marks, Progress and Drafts rules, never read
// off the panel.
const OK = { code: 0, stdout: '', stderr: '' };
const HOME = '/herdr/home';
const CHANGED = 'f'.repeat(64);
const BODY = {
  merge: { decisionCard: 'Ship it.', visual: 'none' },
  question: { question: 'Which colour?' },
  suggested: { reason: 'The lead proposes it.' },
  failure: { reason: 'stopped' },
  'usage-limit': { reason: 'limit' },
};
const digestEntry = { category: 'digest', repository: '/repos/a', sha: 's1', at: '2026-11-09T08:00:00Z', subject: 'merged s1' };

const keyOf = (card) => `/repos/a#${card}`;
const versionOf = (card) => card.toString(16).padStart(2, '0').repeat(32);
const queueItem = (category, card, fields) => ({
  category, key: keyOf(card), card, repository: '/repos/a', title: `a${card}`, version: versionOf(card), ...BODY[category], ...fields,
});
const panelCache = (items) => ({ format: 2, refreshedAt: new Date().toISOString(), fetchedAt: null, problems: [], digestUnread: [], items });

async function reload(host, items) {
  host.setCache(panelCache(items));
  await host.panel.load();
}

const nameOf = (button) => textOf(button).trim();
// The panel's controls that open the Decisions view and the Floor over the window.
const VIEW_BUTTONS = ['fabraik-queue-open-decisions', 'fabraik-queue-open-floor'];
const strings = (tree) => [...walk(tree)].flatMap(([node]) => node.kids.filter((kid) => typeof kid === 'string'));
const nodesOf = (tree, kind) => [...walk(tree)].map(([node]) => node).filter((node) => node.kind === kind);
// What the stub exec was asked to run: queue.mjs with `args`, then `--home`.
const queueCall = (...args) => ({ program: 'node', args: [`${HOME}/mods/fabraik-queue/queue.mjs`, ...args, '--home', HOME] });
const ran = (host) => host.calls.map(([program, args]) => ({ program, args }));

function named(tree, name) {
  const found = buttonsIn(tree).filter((button) => nameOf(button) === name || labelOf(button) === name);
  assert.equal(found.length, 1, `exactly one ${name} button is drawn, found ${found.length}`);
  return found[0];
}

// A control's name: its text, or its accessible label where it draws an icon only, as the send control does.
const controlName = (button) => nameOf(button) || labelOf(button);
const sendName = (card) => `Send answer for card ${card}`;
const iconPaths = (button) => nodesOf(button, 'svg').map((icon) => icon.path);
const SEND_ICON = 'mods/workspace-chrome/chevron-right.svg';
const SPINNER_ICON = 'mods/workspace-chrome/spinner.svg';
const MERGE_PLACEHOLDER = 'Your answer: yes, what to change, or no';
const NO_RECORD_PHRASE = 'records answers only on a GitHub board';
// The line under a merge's answer box, and the line of a merge whose waiting version the panel cannot read.
const CARRY_LINE = 'Your coordinator chat gets this answer and carries it to the job.';
const UNREAD_VERSION_LINE = "The panel cannot read this card's waiting version, so answer in your coordinator chat.";
const RECORDED = 'Answer recorded on the card; the queue confirms on its next read';
const RELAYED = 'Sent to your coordinator chat';
const heldLine = (/** @type {string} */ machine) => `This question is waiting on ${machine}. Answer it in chat.`;
const HELD_UNREAD_LINE = 'Answer this question in chat. The holding computer could not be read.';
const undoOf = (tree, card) => buttonsIn(tree).find((button) => button.elementId === `fabraik-queue-undo-${keyOf(card)}`);

test("panel controls match each item's category and send its key, version and action", async () => {
  const suggested = queueItem('suggested', 8, { scope: 'Build the thing.' });
  const merge = (fields) => queueItem('merge', 5, fields);
  const parkMerge = { press: 'Put aside', expected: ['act', keyOf(5), 'park', versionOf(5)] };
  const boxed = { responses: ['Put aside', sendName(5)], boxes: [MERGE_PLACEHOLDER] };
  const unboxed = { responses: ['Put aside'], boxes: [] };
  const linearMerge = queueItem('merge', 'ENG-7', { version: versionOf(7) });
  /** @type {{ why: string, item: any, responses: string[], boxes: string[], texts?: string[], answerLabel?: string, answer?: string, press?: string, expected?: any[] }[]} */
  const rows = [
    { why: 'a merge answered by the send control', item: merge(), ...boxed, answerLabel: 'Answer to card 5', answer: 'yes',
      texts: [CARRY_LINE], press: sendName(5), expected: ['act', keyOf(5), 'answer', versionOf(5), 'yes'] },
    { why: 'a merge put aside', item: merge(), ...boxed, texts: [CARRY_LINE], ...parkMerge },
    { why: 'a Linear merge answered by the send control', item: linearMerge, responses: ['Put aside', sendName('ENG-7')], boxes: [MERGE_PLACEHOLDER],
      answerLabel: 'Answer to card ENG-7', answer: 'yes', texts: [CARRY_LINE], press: sendName('ENG-7'), expected: ['act', keyOf('ENG-7'), 'answer', versionOf(7), 'yes'] },
    { why: 'a merge missing its proof', item: merge({ decisionCard: undefined, missing: { fact: 'screenshot unreadable', next: 'Reopen the job session.' } }), ...unboxed,
      texts: ['Proof missing: screenshot unreadable. Reopen the job session.', UNREAD_VERSION_LINE], ...parkMerge },
    { why: 'a question explicitly answerable by an older queue reader', item: queueItem('question', 6, { answerable: true }), responses: [sendName(6)], boxes: ['Your answer for a'],
      answerLabel: 'Answer to card 6', answer: 'Blue.', texts: ['Which colour?'], press: sendName(6), expected: ['act', keyOf(6), 'answer', versionOf(6), 'Blue.'] },
    { why: 'a question waiting on another computer', item: queueItem('question', 7, { heldOn: 'machine-b' }), responses: [], boxes: [], texts: [heldLine('machine-b')] },
    { why: 'a question whose holding computer was not read', item: queueItem('question', 7), responses: [], boxes: [], texts: [HELD_UNREAD_LINE] },
    { why: 'a suggested card with a scope, accepted', item: suggested, responses: ['Accept card', 'Reject'], boxes: [],
      texts: ['Build the thing.'], press: 'Accept card', expected: ['act', keyOf(8), 'keep', versionOf(8)] },
    { why: 'a suggested card with a scope, rejected', item: suggested, responses: ['Accept card', 'Reject'], boxes: [],
      press: 'Reject', expected: ['act', keyOf(8), 'drop', versionOf(8)] },
    { why: 'a suggested card without a scope', item: queueItem('suggested', 9), responses: ['Reject'], boxes: [],
      texts: ['Accept needs its What to build and acceptance criteria: answer it in chat'], press: 'Reject', expected: ['act', keyOf(9), 'drop', versionOf(9)] },
    { why: 'a failure without a log', item: queueItem('failure', 13), responses: ['Dismiss'], boxes: [] },
    { why: 'a usage-limit stop', item: queueItem('usage-limit', 11), responses: [], boxes: [] },
  ];
  for (const row of rows) {
    const host = await itemScene([row.item]);
    const tree = host.render();
    assert.ok(!strings(tree).some((text) => text.includes(NO_RECORD_PHRASE)), `${row.why}: no line says the panel records answers only on a GitHub board`);
    assert.deepEqual(itemNames(tree, row.item.key), row.responses, `${row.why}: its buttons`);
    assert.deepEqual(nodesOf(tree, 'input').map((input) => input.state.placeholder), row.boxes, `${row.why}: its boxes`);
    for (const text of row.texts ?? []) assert.ok(strings(tree).includes(text), `${row.why} draws "${text}"`);
    if (row.answer !== undefined) {
      const [box] = nodesOf(tree, 'input');
      assert.equal(labelOf(box), row.answerLabel, `${row.why}: the answer box is labelled`);
      assert.deepEqual(iconPaths(named(tree, row.press)), [SEND_ICON], `${row.why}: the send control draws the arrow`);
      assert.ok(isDisabled(named(tree, row.press)), `${row.why}: the send control is off while the box is empty`);
      host.type(box, row.answer);
      assert.ok(!isDisabled(named(host.render(), row.press)), `${row.why}: the send control is on once the box holds words`);
    }
    if (row.press !== undefined) await host.click(named(host.render(), row.press));
    assert.deepEqual(ran(host), row.press === undefined ? [] : [queueCall(.../** @type {any[]} */ (row.expected))], `${row.why}: the commands run`);
  }

  // While a command of the item runs, the pressed button reads Working or the send control shows the spinner, and the
  // item's other controls are off.
  for (const [press, receipt] of [['Put aside', 'Put aside; the queue confirms on its next read'], [sendName(5), 'Sent to your coordinator chat']]) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const working = await itemScene([merge()], () => held);
    working.type(nodesOf(working.render(), 'input')[0], 'yes');
    const pressed = working.click(named(working.render(), press));
    const during = working.render();
    const parking = press === 'Put aside';
    assert.deepEqual(iconPaths(named(during, sendName(5))), [parking ? SEND_ICON : SPINNER_ICON], `${press}: the send control shows the spinner only while it sends`);
    assert.ok(isDisabled(named(during, sendName(5))), `${press}: the send control is off while a command runs`);
    assert.ok(isDisabled(named(during, parking ? 'Working' : 'Put aside')), `${press}: the item's other control is off`);
    if (parking) assert.ok(!buttonsIn(during).some((button) => nameOf(button) === 'Put aside'), 'the pressed button no longer reads Put aside');
    await working.click(named(during, parking ? 'Working' : 'Put aside'));
    await working.click(named(during, sendName(5)));
    working.emit(nodesOf(during, 'input')[0], 'submit');
    assert.equal(working.calls.length, 1, `${press}: no second command starts while one runs, Enter included`);
    release(OK);
    await pressed;
    assert.ok(strings(working.render()).includes(receipt), `${press}: the receipt is drawn`);
  }

  // A refusal leaves the item open with one line naming the button and the reason.
  const refused = await itemScene([suggested], { code: 1, stdout: '', stderr: 'the item changed\n' });
  await refused.click(named(refused.render(), 'Accept card'));
  const after = refused.render();
  assert.ok(strings(after).includes('Accept card failed: the item changed'), `the refusal is shown: ${strings(after).join(' | ')}`);
  assert.deepEqual(itemNames(after, keyOf(8)), ['Accept card', 'Reject'], 'a refused item stays open');
  assert.ok(!strings(after).includes('Accepted; the queue confirms on its next read'), 'a refused answer leaves no receipt');

  // An empty answer or one over 500 characters runs nothing, from the send control or Enter; 500 characters go on Enter.
  const answers = await itemScene([queueItem('question', 6, { answerable: true })]);
  const [box] = nodesOf(answers.render(), 'input');
  for (const bad of ['', 'x'.repeat(501)]) {
    answers.type(box, bad);
    await answers.click(named(answers.render(), sendName(6)));
    answers.emit(box, 'submit');
  }
  assert.deepEqual(ran(answers), [], 'an empty answer and a 501-character answer run nothing');
  assert.ok(strings(answers.render()).includes('Send answer failed: the answer is 501 characters, over the 500 limit'), 'Enter on a long answer says why');
  answers.type(box, 'x'.repeat(500));
  await answers.task(() => answers.emit(box, 'submit'));
  assert.deepEqual(ran(answers), [queueCall('act', keyOf(6), 'answer', versionOf(6), 'x'.repeat(500))], 'Enter sends 500 characters');
});

// A weekly retro as the queue carries it: a suggested item with its write-up and its card drafts. Draft 1's problem is
// Markdown that would hide what it holds, a link whose address is the private text.
const RETRO_DRAFT = { n: 1, repository: 'example-owner/a', title: 'Shorter refusals in the panel', label: 'enhancement', workstream: 'Platform',
  problem: '[Queue issue](PRIVATE_CLIENT_584)', build: 'One short line for each refusal.', criteria: ['Every refusal fits one line.', 'No refusal names a credential.'] };
const RETRO_WRITE_UP = '## Proposals\n\n### Proposal 1 for example-owner/a\n\nSummary: Refusals are too long to read.';
const retroItem = (fields) => queueItem('suggested', 60, { reason: '1 proposal and 0 places I think you were wrong', writeUp: RETRO_WRITE_UP, proposals: [RETRO_DRAFT], ...fields });

test('ANTI-REGRESSION: a weekly retro draws each card draft and a plain write-up as written, never as Markdown', async () => {
  const drawn = (await itemScene([retroItem()])).render();
  const plainTexts = [...walk(drawn)].filter(([node]) => node.kind !== 'markdown').flatMap(([node]) => node.kids.filter((kid) => typeof kid === 'string'));
  const markdownTexts = nodesOf(drawn, 'markdown').map(textOf);
  assert.deepEqual(markdownTexts, [RETRO_WRITE_UP], 'the write-up is the one Markdown view');
  const { title, label, workstream, problem, build, criteria } = RETRO_DRAFT;
  for (const value of [title, label, workstream, problem, build, ...criteria]) {
    assert.ok(plainTexts.some((text) => text.includes(value)), `${value} is drawn whole as plain text: ${JSON.stringify(plainTexts)}`);
    assert.ok(!markdownTexts.some((text) => text.includes(value)), `${value} is in no Markdown view`);
  }

  const lines = ['See [docs](https://example.com/d).', '![x](https://attacker.example/x.png)', '<img src="https://attacker.example/y.png">'];
  const note = 'Shown as written, without formatting or links.';
  const plain = (await itemScene([retroItem({ writeUp: { plain: lines.join('\n') } })])).render();
  assertInOrder(flowOf(plain), [note, ...lines], 'the plain write-up follows its note, line by line');
  const noted = [...walk(plain)].map(([node]) => node).find((node) => node.kids.includes(note));
  assert.equal(called(noted, 'text_color').at(-1)?.[0], 'muted', 'the note is a muted line');
  assert.deepEqual(nodesOf(plain, 'markdown'), [], 'no Markdown view is drawn');
  assert.deepEqual(nodesOf(plain, 'image'), [], 'no image is drawn');
  assert.equal([...walk(plain)].filter(([node]) => node.linkClick !== null).length, 0, 'no node handles a link');
});

test('a weekly retro item offers one control per proposal a card can be made from and Close retro', async () => {
  const second = { ...RETRO_DRAFT, n: 2, title: 'A second card draft' };
  const made = { ...RETRO_DRAFT, n: 3, title: 'A card already made', card: { repository: 'example-owner/a', number: 71 } };
  const item = retroItem({ proposals: [RETRO_DRAFT, second, made] });
  const controls = ['Close retro', 'Make proposal 1 a card', 'Make proposal 2 a card'];
  const host = await itemScene([item]);
  const tree = host.render();
  assert.ok(strings(tree).includes('Weekly retro') && !strings(tree).includes('Suggested card'), 'the chip reads Weekly retro');
  assert.deepEqual(itemNames(tree, keyOf(60)), controls, 'one control per unmade proposal, and Close retro');
  assert.equal(labelOf(named(tree, 'Make proposal 2 a card')), 'Make proposal 2 a card: A second card draft');
  assert.ok(strings(tree).includes('Proposal 3 is now a card 71'), 'a made proposal shows its card');

  // A pick sends the key, version, action and number, keeps the item open and starts a refresh.
  const making = 'Proposal 2 is being made a card; the queue confirms on its next read';
  await host.click(named(tree, 'Make proposal 2 a card'));
  assert.deepEqual(ran(host)[0], queueCall('act', keyOf(60), 'pick', versionOf(60), '2'));
  assert.ok(ran(host).slice(1).some(({ args }) => args[1] === 'refresh'), 'a made card starts a refresh');
  const after = host.render();
  assert.deepEqual(itemNames(after, keyOf(60)), ['Close retro', 'Make proposal 1 a card'], 'the item stays open without the pressed control');
  assert.ok(strings(after).includes(making), 'the made proposal says the queue confirms it');
  await reload(host, [retroItem({ proposals: [RETRO_DRAFT, { ...second, card: { repository: 'example-owner/b', number: 9 } }, made] })]);
  const read = host.render();
  assert.ok(strings(read).includes('Proposal 2 is now b card 9') && !strings(read).includes(making), 'the next read names the card it became');
  assert.deepEqual(itemNames(read, keyOf(60)), ['Close retro', 'Make proposal 1 a card']);

  // A refusal leaves the item open with one line naming the control and the reason.
  const refused = await itemScene([item], { code: 1, stdout: '', stderr: 'the item changed\n' });
  await refused.click(named(refused.render(), 'Make proposal 1 a card'));
  assert.ok(strings(refused.render()).includes('Make proposal 1 a card failed: the item changed'), strings(refused.render()).join(' | '));
  assert.deepEqual(itemNames(refused.render(), keyOf(60)), controls, 'a refused pick keeps every control');

  const closing = await itemScene([item]);
  await closing.click(named(closing.render(), 'Close retro'));
  assert.deepEqual(ran(closing), [queueCall('act', keyOf(60), 'drop', versionOf(60))]);
  assert.ok(strings(closing.render()).includes('Closed; the queue confirms on its next read'), 'a closed retro leaves its receipt');

  const empty = (await itemScene([retroItem({ reason: 'Nothing to report this week', proposals: [] })])).render();
  assert.deepEqual(itemNames(empty, keyOf(60)), ['Close retro'], 'a retro with no draft offers only Close retro');
  assert.ok(strings(empty).includes('No card can be made from this retro.') && !strings(empty).includes('Cards you can make'));
});

test('an answer draft is cleared when its question changes', async () => {
  const notice = 'This question changed; your draft was cleared.';
  const asked = (version, question) => queueItem('question', 6, { answerable: true, version, question });
  const host = await itemScene([asked(versionOf(6), 'Which colour?')]);
  const drawn = async () => host.render();
  const boxNow = async () => nodesOf(await drawn(), 'input')[0];

  host.type(await boxNow(), 'Blue.');
  await reload(host, [asked(versionOf(6), 'Which colour?')]);
  assert.equal((await boxNow()).state.value(), 'Blue.', 'a load of the same question keeps the draft');

  await reload(host, [asked(CHANGED, 'Which colour now?')]);
  assert.ok(strings(await drawn()).includes(notice), 'the changed question says its draft was cleared');
  assert.equal((await boxNow()).state.value(), '', 'the old draft is gone');
  host.type(await boxNow(), 'Green.');

  await reload(host, []);
  await reload(host, [asked(CHANGED, 'Which colour now?')]);
  assert.equal((await boxNow()).state.value(), '', 'a draft whose question left the cache is dropped');
  host.type(await boxNow(), 'Green.');
  await host.click(named(await drawn(), sendName(6)));
  assert.deepEqual(ran(host), [queueCall('act', keyOf(6), 'answer', CHANGED, 'Green.')], 'Send passes the version its draft is keyed by');
});

test('one key clears the digest', async () => {
  const host = await itemScene([queueItem('merge', 5), digestEntry]);
  const root = [...walk(host.render())].find(([node]) => node.keyDown)?.[0];
  assert.ok(root, 'the panel root handles key presses');
  assert.equal(host.handles.length, 1, 'init makes one focus handle and render makes none');
  assert.deepEqual(called(root, 'track_focus'), [[host.handles[0]]], 'the root that takes the key tracks that handle');

  await host.press('x');
  assert.deepEqual(ran(host), [], 'another key runs nothing');

  // An input that has emitted focus and not blur holds the keyboard, so c is typed text and clears nothing.
  const [box] = nodesOf(host.render(), 'input');
  host.emit(box, 'focus');
  await host.press('c');
  assert.deepEqual(ran(host), [], 'c runs nothing while an input holds the keyboard');
  host.emit(box, 'blur');
  await host.press('c');
  assert.deepEqual(ran(host), [queueCall('clear-digest')], 'c clears the digest again after blur');

  const bare = await itemScene([queueItem('merge', 5)]);
  await bare.press('c');
  assert.deepEqual(ran(bare), [], 'c runs nothing while the digest is empty');
});

test("a handled item becomes a receipt whose Undo takes back the panel's own record and names a refusal", async () => {
  const parked = 'Put aside; the queue confirms on its next read';
  const record = { code: 0, stdout: '{"r":5}\n', stderr: '' };
  const moved = 'queue: x: card 5 moved since it was put aside: it is now in Ready';
  const noUndoCoordinator = 'No Undo: your coordinator may already have read this answer, so correct it in chat';
  const items = [queueItem('merge', 5), queueItem('merge', 6), queueItem('failure', 10),
    queueItem('question', 12, { answerable: true }), queueItem('merge', 7)];
  const results = [];
  const host = await itemScene(items, () => results.shift() ?? OK);

  // A written action leaves a receipt with Undo, which passes the queue's record back and reopens the card.
  results.push(record);
  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  let tree = host.render();
  assert.deepEqual(ran(host), [queueCall('act', keyOf(5), 'park', versionOf(5))], 'the act starts no refresh');
  assert.ok(!hasCard(tree, 5), 'the handled item is no longer a card');
  assert.ok(strings(tree).includes(parked) && strings(tree).includes('a card 5, a5'), `the receipt is drawn: ${strings(tree).join(' | ')}`);
  assert.ok(undoOf(tree, 5), 'a written action has Undo');
  assert.equal(labelOf(undoOf(tree, 5)), 'Undo for card 5', 'Undo is named for its card');

  results.push(OK);
  await host.click(undoOf(tree, 5));
  tree = host.render();
  assert.deepEqual(ran(host).at(-1), queueCall('undo', keyOf(5), 'park', '{"r":5}'), 'Undo passes the record the act returned');
  assert.ok(!strings(tree).includes(parked), 'the receipt is gone');
  buttonOf(tree, keyOf(5), 'Put aside');

  // A refusal keeps the receipt and Undo, and says why.
  results.push(record, { code: 1, stdout: '', stderr: `${moved}\n` });
  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  await host.click(undoOf(host.render(), 5));
  tree = host.render();
  assert.ok(strings(tree).includes(parked), 'the receipt stays');
  assert.ok(strings(tree).includes(`Undo failed: ${moved}`), `the refusal is shown: ${strings(tree).join(' | ')}`);
  assert.ok(!hasCard(tree, 5), 'the item stays handled');
  assert.ok(undoOf(tree, 5), 'Undo stays offered');

  // A write the queue returned no record for cannot be undone, and says why.
  results.push(OK);
  await host.click(buttonOf(host.render(), keyOf(7), 'Put aside'));
  tree = host.render();
  assert.equal(undoOf(tree, 7), undefined, 'an act without a record has no Undo');
  assert.ok(strings(tree).includes("No Undo: a's queue reader predates it"), `the reason is shown: ${strings(tree).join(' | ')}`);

  // A sent merge answer is a written action too, with no Undo: its receipt says it went to the coordinator chat, and
  // the line saying why it has no Undo follows.
  host.type(boxOf(host.render(), 'Answer to card 6'), 'yes');
  await host.click(named(host.render(), sendName(6)));
  tree = host.render();
  const lines = strings(tree);
  assert.ok(!hasCard(tree, 6) && lines.includes(RELAYED) && lines.includes('a card 6, a6'), `card 6: the answer's receipt is drawn: ${lines.join(' | ')}`);
  assert.equal(lines[lines.indexOf(RELAYED) + 1], noUndoCoordinator, 'card 6: the no-Undo line follows the receipt line');
  assert.equal(undoOf(tree, 6), undefined, 'card 6: a sent answer has no Undo');
  // A question's receipt says it was recorded, and why it has no Undo.
  host.type(boxOf(host.render(), 'Answer to card 12'), 'Blue.');
  await host.click(named(host.render(), sendName(12)));
  tree = host.render();
  assert.deepEqual(ran(host).at(-1), queueCall('act', keyOf(12), 'answer', versionOf(12), 'Blue.'));
  const receipts = strings(tree);
  assert.deepEqual([RELAYED, RECORDED, noUndoCoordinator].map((line) => receipts.filter((found) => found === line).length), [1, 1, 2], 'the question adds its receipt and no-Undo lines');
  assert.equal(receipts[receipts.indexOf(RECORDED) + 1], noUndoCoordinator, 'the no-Undo line follows the question receipt line');
  assert.equal(undoOf(tree, 12), undefined, 'an answer has no Undo');

  // A local mark has Undo, which reopens the card and runs nothing.
  await host.click(buttonOf(host.render(), keyOf(10), 'Dismiss'));
  tree = host.render();
  assert.ok(strings(tree).includes('Dismissed'));
  const callsBefore = host.calls.length;
  assert.equal(labelOf(undoOf(tree, 10)), 'Undo for card 10', 'Undo is named for its card');
  await host.click(undoOf(tree, 10));
  tree = host.render();
  assert.ok(!strings(tree).includes('Dismissed'), 'the receipt is gone');
  buttonOf(tree, keyOf(10), 'Dismiss');
  assert.equal(host.calls.length, callsBefore, 'Undo of a local mark runs nothing');

  // A load that still holds the item keeps its mark; one without its key and version drops the mark.
  await host.click(buttonOf(host.render(), keyOf(10), 'Dismiss'));
  await reload(host, items);
  assert.ok(!hasCard(host.render(), 10), 'a load that still holds the item keeps its mark');
  await reload(host, [items[0], items[1], queueItem('failure', 10, { version: CHANGED })]);
  assert.ok(hasCard(host.render(), 10), 'the card at another version is an item');
  await reload(host, items);
  tree = host.render();
  assert.ok(hasCard(tree, 10) && !strings(tree).includes('Dismissed'), 'the dropped mark does not return with its old version');
  assert.ok(!hasCard(tree, 5) && !hasCard(tree, 6), 'the other marks are kept');
});

// Card #858, criterion 5: the queue reads its tracker only when opened or refreshed, so no view starts a timer. The panel
// reads only the waiting menus and runs no `refresh` or `report`; an overlay view runs one `refresh` as it starts and one
// more at each press of its Refresh control, which is off while a refresh runs.
const LIFECYCLE_VIEWS = [
  { name: 'Decisions', props: { view: 'decisions' } },
  { name: 'the Floor', props: { view: 'floor' } },
  { name: 'the Board', props: { view: 'board', repository: '/repos/a' } },
];
const refreshesOf = (host) => ran(host).filter(({ args }) => args[1] === 'refresh');

test('no view starts a timer once it has started, and the panel runs no refresh or report', async () => {
  for (const view of LIFECYCLE_VIEWS) {
    const host = await loadPanel(OK, view.props, { lifecycle: true });
    host.setCache(panelCache([queueItem('merge', 5)]));
    await host.started();
    assert.deepEqual(host.timers, [], `${view.name} starts no timer`);
    assert.equal(refreshesOf(host).length, 1, `${view.name} runs one refresh as it starts`);
    assert.ok(ran(host).every(({ args }) => args[1] !== 'report'), `${view.name} runs no report as it starts`);
  }
  const panel = await loadPanel(OK, {}, { lifecycle: true });
  panel.setCache(panelCache([queueItem('merge', 5)]));
  await panel.started();
  assert.deepEqual(panel.timers, [], 'the panel starts no timer');
  assert.deepEqual(ran(panel), [queueCall('menus', '[]')], 'the panel runs only its read of the waiting menus as it starts');
});

test('a view runs one refresh per press of its Refresh control, which is off while one runs, and the panel has no such control', async () => {
  for (const view of LIFECYCLE_VIEWS) {
    let release = /** @type {(() => void) | null} */ (null);
    let hold = false;
    const host = await loadPanel((_program, args) => (hold && args[1] === 'refresh' ? new Promise((resolve) => { release = () => resolve(OK); }) : OK),
      view.props, { lifecycle: true });
    host.setCache(panelCache([queueItem('merge', 5)]));
    await host.started();
    assert.equal(refreshesOf(host).length, 1, `${view.name}: one refresh after it starts`);
    assert.ok(!isDisabled(named(host.render(), 'Refresh')), `${view.name}: Refresh is on once the start-up refresh ends`);

    hold = true;
    const pressing = host.click(named(host.render(), 'Refresh'));
    assert.equal(refreshesOf(host).length, 2, `${view.name}: a press runs one more refresh`);
    assert.ok(isDisabled(named(host.render(), 'Refresh')), `${view.name}: Refresh is off while the refresh runs`);
    assert.ok(release, `${view.name}: the held refresh is waiting`);
    release();
    await pressing;
    assert.equal(refreshesOf(host).length, 2, `${view.name}: the press runs no third refresh`);
    assert.ok(!isDisabled(named(host.render(), 'Refresh')), `${view.name}: Refresh is on again once it ends`);
    assert.deepEqual(host.timers, [], `${view.name} starts no timer`);
  }
  const panel = await loadPanel(OK, {}, { lifecycle: true });
  panel.setCache(panelCache([queueItem('merge', 5)]));
  await panel.started();
  assert.ok(!buttonsIn(panel.render()).some((button) => nameOf(button) === 'Refresh'), 'the panel draws no Refresh control');
});

test('a view shows when it read as a clock time, with the date when that was not today', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 19, 15, 30).getTime() });
  const read = (at) => ({ ...panelCache([queueItem('merge', 5)]), refreshedAt: new Date(at).toISOString() });
  for (const view of LIFECYCLE_VIEWS) {
    const host = await loadPanel(OK, view.props);
    host.setCache(read(new Date(2026, 10, 19, 14, 2).getTime()));
    await host.panel.load();
    assert.ok(strings(host.render()).includes('Read at 14:02'), `${view.name}: a read today shows its clock time: ${strings(host.render()).join(' | ')}`);
    host.setCache(read(new Date(2026, 10, 18, 14, 2).getTime()));
    await host.panel.load();
    assert.ok(strings(host.render()).includes('Read 18 Nov, 14:02'), `${view.name}: an earlier day's read shows its date and time`);
  }
});

// The Decisions view: the same mod in a tab made with the props `{ view: 'decisions' }`. It draws each waiting item as a
// whole card, without a row to open, in one group per project. The expected controls, commands, group order and counts
// are written by hand from the plan's Decisions view rules, `owner-queue.mjs` ROUTES (the only actions `act` writes:
// park, answer, keep, drop and pick) and each fixture's own order, never read off the panel.
const DECISIONS = { view: 'decisions' };
const QUEUE_COMMANDS = ['refresh', 'act', 'clear-digest', 'report'];
const ROUTE_ACTIONS = ['answer', 'drop', 'keep', 'park', 'pick'];
// The Herdr commands that make, show or close a space or tab, none of which a view control runs (card #858, criteria 1 and 5).
const SPACE_COMMANDS = ['space.new', 'space.select', 'tab.new', 'tab.select', 'tab.close'];
// The one window overlay Herdr's overlay contract (herdr.d.ts, OverlaySpec) gives a view: keyed, so a second view replaces
// the first in place, and 0.94 by 0.9 of the window.
const viewSpec = (view, repository) => ({ mod: 'fabraik-queue', props: { view, repository }, kind: 'window', key: 'fabraik-queue-view', width: 0.94, height: 0.9 });
const inRepository = (folder, category, card, fields) => queueItem(category, card, {
  repository: `/repos/${folder}`, key: `/repos/${folder}#${card}`, title: `${folder}${card}`, ...fields,
});
const progressText = (tree) => strings(tree).filter((line) => /^\d+ waiting, \d+ handled$/.test(line)).join();

async function decisionsScene(cache, /** @type {Exec} */ execResult = OK) {
  const host = await loadPanel(execResult, DECISIONS);
  host.setCache(cache);
  await host.panel.load();
  return host;
}

// The controls drawn for one item, which carry its key.
const itemButtons = (tree, key) => buttonsIn(tree).filter((button) => button.elementId?.endsWith(`-${key}`));

function buttonOf(tree, key, name) {
  const found = itemButtons(tree, key).filter((button) => controlName(button) === name);
  assert.equal(found.length, 1, `exactly one ${name} button is drawn for ${key}, found ${found.length}`);
  return found[0];
}

function boxOf(tree, label) {
  const found = nodesOf(tree, 'input').filter((input) => labelOf(input) === label);
  assert.equal(found.length, 1, `exactly one box labelled ${label} is drawn, found ${found.length}`);
  return found[0];
}

const itemNames = (tree, key) => itemButtons(tree, key).map(controlName).sort();
// Whether the view draws card `card` as a waiting item: it has a control of its own, which Undo of a receipt is not.
const hasCard = (tree, card) => itemButtons(tree, keyOf(card)).some((button) => controlName(button) !== 'Undo');
// The card of one item in a view that draws every card whole: the nearest element above its controls that holds the card.
function cardOf(tree, key) {
  const parents = new Map(walk(tree));
  let node = itemButtons(tree, key)[0];
  assert.ok(node, `a control of ${key} is drawn`);
  while (node !== undefined && called(node, 'overflow_hidden').length === 0) node = parents.get(node);
  assert.ok(node, `the card of ${key} is drawn`);
  return node;
}
const itemScene = (items, /** @type {Exec} */ execResult = OK) => decisionsScene(panelCache(items), execResult);

// Scope: items that are not `menu` items. A waiting menu offers its job's own choices, an approving one such as Yes, deliver
// included, and its press runs `answer-menu`, which is no queue command of this test's list; the waiting-menu test below pins it.
test('no control approves, pushes, merges or marks ready: every press runs a panel command, and only typed words answer', async () => {
  const merge = ['Put aside', sendName(5)];
  const kinds = [
    { why: 'a complete merge', item: queueItem('merge', 5), controls: merge },
    { why: 'a merge missing its proof', item: queueItem('merge', 5, { decisionCard: undefined, missing: { fact: 'screenshot unreadable', next: 'Reopen the job session.' } }), controls: ['Put aside'] },
    { why: 'an answerable question', item: queueItem('question', 6, { answerable: true }), controls: [sendName(6)] },
    { why: 'a question waiting on another computer', item: queueItem('question', 7), controls: [] },
    { why: 'a suggested card with a scope', item: queueItem('suggested', 8, { scope: 'Build the thing.' }), controls: ['Accept card', 'Reject'] },
    { why: 'a suggested card without a scope', item: queueItem('suggested', 9), controls: ['Reject'] },
    { why: 'a weekly retro', item: retroItem(), controls: ['Close retro', 'Make proposal 1 a card'] },
    { why: 'a failure without a log', item: queueItem('failure', 13), controls: ['Dismiss'] },
    { why: 'a usage-limit stop', item: queueItem('usage-limit', 11), controls: [] },
  ];
  // The owner's words, typed into each box so a send has words to carry; they stay free of the names scanned below.
  const TYPED = 'Make the title shorter';
  const hosts = [];
  // A fresh scene of the item and a digest line, as the owner meets its controls: the Decisions card as drawn, each box
  // typed into.
  const reach = async (props, item) => {
    const host = await loadPanel(OK, props);
    hosts.push(host);
    await reload(host, [item, digestEntry]);
    for (const box of nodesOf(host.render(), 'input')) host.type(box, TYPED);
    return host;
  };
  for (const [view, props] of [['the Decisions view', DECISIONS]]) {
    const before = hosts.length;
    for (const { why, item, controls } of kinds) {
      const tree = (await reach(props, item)).render();
      assert.deepEqual(itemButtons(tree, item.key).map(controlName).sort(), controls, `${why}: ${view} draws the panel's controls`);
      // Every drawn button is pressed, each in a fresh scene, then the Undo the press left, if any.
      for (const { elementId } of buttonsIn(tree)) {
        const host = await reach(props, item);
        const button = buttonsIn(host.render()).find((found) => found.elementId === elementId);
        assert.ok(button, `${why}: ${view} draws ${elementId} again`);
        await host.click(button);
        const undo = buttonsIn(host.render()).find((found) => nameOf(found) === 'Undo');
        if (undo) await host.click(undo);
      }
      // Enter in every drawn box is a press too, each in a fresh scene.
      for (const index of nodesOf(tree, 'input').keys()) {
        const host = await reach(props, item);
        await host.task(() => host.emit(nodesOf(host.render(), 'input')[index], 'submit'));
      }
    }
    // The positive control: the presses reached every command and answer the view offers.
    const executed = hosts.slice(before).flatMap((host) => host.calls.map(([, args]) => args));
    assert.deepEqual([...new Set(executed.filter((args) => args[1] === 'act').map((args) => args[3]))].sort(), ROUTE_ACTIONS, `${view}: its presses reached each answer`);
    assert.ok(executed.some((args) => args[1] === 'clear-digest'), `${view}: its presses reached Clear`);
    assert.ok(executed.some((args) => args[3] === 'answer' && args[5] === TYPED), `${view}: an answer carried the typed words`);
  }

  for (const host of hosts) {
    for (const [program, args] of host.calls) {
      assert.equal(program, 'node', 'every command is node');
      assert.equal(args[0], `${HOME}/mods/fabraik-queue/queue.mjs`, 'every command runs queue.mjs');
      assert.ok(QUEUE_COMMANDS.includes(args[1]), `queue.mjs ${args[1]} is a panel command`);
      if (args[1] === 'act') assert.ok(ROUTE_ACTIONS.includes(args[3]), `act ${args[3]} is an action ROUTES answers`);
      // The reply of an answer is the owner's words, not a name of the panel's.
      const reply = args[1] === 'act' && args[3] === 'answer' ? 5 : -1;
      args.forEach((arg, index) => {
        if (index === reply) assert.equal(arg, TYPED, 'the reply is the typed words');
        else assert.doesNotMatch(arg, /merge|push|ready|approve/i, `no argument names a merge, push, ready or approval: ${arg}`);
      });
    }
    for (const [name] of host.runs) assert.ok(!SPACE_COMMANDS.includes(name), `a press runs no Herdr ${name}`);
  }
});

// Scope: merge items, and so items that are not `menu` items. A deliver `menu` item draws a Yes, deliver button for the version its job asked about, as
// the waiting-menu test below pins; a merge item itself still offers no Yes.
test('every waiting merge offers one answer box with a send control and no Yes button in the Decisions view', async () => {
  const reason = 'check; beyond-card';
  const merges = [
    // A cache an older collector wrote may still mark a merge Yes open; no button comes of it.
    { why: 'a merge an older collector marked Yes open', item: queueItem('merge', 8, { yes: 'open' }), who: CARRY_LINE },
    { why: 'a merge holding reasons', item: queueItem('merge', 5, { reason }), reason, who: CARRY_LINE },
    { why: 'a merge holding none', item: queueItem('merge', 6), who: CARRY_LINE },
    { why: 'a merge missing its proof', item: queueItem('merge', 7, { decisionCard: undefined, missing: { fact: 'screenshot unreadable', next: 'Reopen the job session.' } }), nothing: UNREAD_VERSION_LINE },
  ];
  const noYesButton = (tree) => buttonsIn(tree).every((button) => nameOf(button) !== 'Yes' && !labelOf(button)?.startsWith('Yes to card'));

  for (const { why, item, reason: held, who, nothing } of merges) {
    const decisions = await decisionsScene(panelCache([item]));
    for (const [view, host, tree, names] of [
      ['the Decisions view', decisions, decisions.render(), (found) => itemButtons(found, item.key).map(controlName).sort()],
    ]) {
      assert.ok(noYesButton(tree), `${why}, ${view}: no Yes button`);
      assert.ok(!strings(tree).some((line) => line.startsWith('Yes approves') || line.startsWith('Your yes and any change')), `${why}, ${view}: no line promises a press approves`);
      if (held !== undefined) {
        const text = textOf(tree);
        assert.ok(strings(tree).includes(held) && text.indexOf(held) < text.indexOf('Ship it.'), `${why}, ${view}: the reasons open the detail, above the decision card`);
      }
      if (nothing !== undefined) {
        assert.deepEqual(names(tree), ['Put aside'], `${why}, ${view}: only Put aside`);
        assert.deepEqual(nodesOf(tree, 'input'), [], `${why}, ${view}: no box`);
        assert.ok(strings(tree).includes(nothing), `${why}, ${view}: it says to answer in the coordinator chat`);
        continue;
      }
      assert.deepEqual(names(tree), ['Put aside', sendName(item.card)], `${why}, ${view}: one send control beside Put aside`);
      assert.deepEqual(nodesOf(tree, 'input').map((box) => box.state.placeholder), [MERGE_PLACEHOLDER], `${why}, ${view}: one answer box`);
      assert.ok(strings(tree).includes(who), `${why}, ${view}: the line says the coordinator chat carries the answer`);
      assert.deepEqual(iconPaths(named(tree, sendName(item.card))), [SEND_ICON], `${why}, ${view}: the send control draws the arrow`);
      assert.ok(isDisabled(named(tree, sendName(item.card))), `${why}, ${view}: the send control is off while the box is empty`);
      host.type(nodesOf(tree, 'input')[0], 'yes');
      await host.task(() => host.emit(nodesOf(host.render(), 'input')[0], 'submit'));
      assert.deepEqual(ran(host), [queueCall('act', item.key, 'answer', item.version, 'yes')], `${why}, ${view}: Enter sends the answer`);
      const receipt = strings(host.render());
      assert.ok(receipt.includes(RELAYED) && !receipt.includes(who), `${why}, ${view}: the receipt says the answer went to the coordinator chat`);
    }
  }
});

// A waiting menu is a `menu` item queue.mjs lists for a job at one of Claude's menus. Each choice is a button, the approving one
// solid, beside the usual answer box; a menu of several questions or a multi-select draws toggles and a box for each question
// and one Send answers. Every send is one `queue.mjs answer-menu` call carrying one answer keyed by question text, and nothing
// types into a terminal. The expected labels, lines and records are written by hand from the plan's Visual direction and the
// answer record shape, never read off the panel.
// The version a deliver menu's job asked about, the head and identity a complete merge of its card carries as its proof.
const DELIVER_VERSION = { head: '1'.repeat(40), identity: '2'.repeat(40) };
test('a waiting menu shows each choice as a button beside its answer box, and a multi-question ask sends one question-keyed answer', async () => {
  const askId = (n) => n.toString(16).padStart(32, '0');
  const deliverQuestion = {
    question: 'Deliver card 5 now?', header: 'Deliver', multiSelect: false,
    options: [{ label: 'Yes, deliver', description: 'Merge it' }, { label: 'No, put aside', description: 'Hold it' }],
  };
  const colour = { question: 'Which colour do you pick?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] };
  const letters = { question: 'Which letters go in?', header: 'Letters', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  // Shaped as queue.mjs lists a hook's ask: the card is the string the job's mark holds, beside its repository.
  const menu = (n, card, terminalName, questions) => ({
    category: 'menu', key: `menu:${terminalName}/${askId(n)}`, terminal: terminalName, askId: askId(n), card: String(card), repository: '/repos/a',
    kind: 'question', toolName: 'AskUserQuestion', askedAt: 1_795_000_000_000, questions, answerable: true,
  });
  // The job asked about the version its merge shows, which is what draws Yes, deliver and the answer box.
  const deliver = { ...menu(1, 5, 't1', [deliverQuestion]), version: DELIVER_VERSION };
  const merge = queueItem('merge', 5, { ...DELIVER_VERSION });
  const several = menu(2, 6, 't2', [colour, letters]);
  const answerCalls = (host) => ran(host).filter(({ args }) => args[1] === 'answer-menu');
  const record = (id, answers) => ({ format: 1, askId: id, by: 'panel', answers });
  const solid = (button) => called(button, 'bg').some(([role]) => role === 'solid');

  // A deliver item: its chip, the decision card of its merge, each choice a button with the approving one solid, one answer box.
  const host = await itemScene([merge, deliver]);
  const tree = host.render();
  const choices = itemButtons(tree, deliver.key);
  assert.deepEqual(choices.map(controlName).sort(), ['No, put aside', sendName(5), 'Yes, deliver']);
  assert.deepEqual(choices.map(labelOf).filter((label) => label?.endsWith('for card 5')).sort(), ['No, put aside for card 5', sendName(5), 'Yes, deliver for card 5']);
  assert.ok(solid(named(tree, 'Yes, deliver for card 5')), 'the approving choice is the one solid button');
  assert.ok(!solid(named(tree, 'No, put aside for card 5')), 'the other choice is outlined');
  assert.deepEqual(nodesOf(tree, 'input').map((box) => box.state.placeholder), ['Or type your own answer'], 'one answer box beside the buttons');
  assert.ok(textOf(tree).includes('Ship it.'), 'the item shows the merge its card holds, decision card included');

  // Put aside on a deliver item sends the declining choice, which is what deletes the job's note; it never just hides the item.
  await host.click(named(tree, 'No, put aside for card 5'));
  assert.deepEqual(answerCalls(host), [queueCall('answer-menu', 't1', askId(1), '--answer', JSON.stringify(record(askId(1), { [deliverQuestion.question]: { choices: ['No, put aside'] } })))]);
  assert.ok(strings(host.render()).includes('Sent; waiting for the job to take it'), 'a sent answer says it waits for the job');

  // Typed words are the answer, as a text beside no choice.
  const typed = await itemScene([merge, deliver]);
  typed.type(nodesOf(typed.render(), 'input')[0], 'not yet');
  await typed.click(named(typed.render(), sendName(5)));
  assert.deepEqual(answerCalls(typed).map(({ args }) => JSON.parse(args[5])), [record(askId(1), { [deliverQuestion.question]: { text: 'not yet' } })]);

  // Two questions, the second multi-select: toggles and a box for each, one Send answers, off until every question is answered.
  const group = await itemScene([several]);
  let shown = group.render();
  assert.deepEqual(nodesOf(shown, 'toggle').map(labelOf), ['Red', 'Blue', 'A', 'B', 'C'].map((label) => `${label} for card 6`));
  assert.deepEqual(nodesOf(shown, 'input').map(labelOf), ['Other answer to Colour', 'Other answer to Letters']);
  assert.deepEqual(nodesOf(shown, 'input').map((box) => box.state.placeholder), ['Or type your own answer', 'Or type your own answer']);
  assert.ok(isDisabled(named(shown, 'Send answers')), 'Send answers is off while no question is answered');
  const toggle = (label) => nodesOf(group.render(), 'toggle').find((found) => labelOf(found) === `${label} for card 6`);
  const press = (label, on) => group.task((cx) => called(toggle(label), 'on_change').at(-1)[0](on, cx));
  await press('Blue', true);
  await press('A', true);
  await press('C', true);
  shown = group.render();
  assert.ok(called(toggle('Blue'), 'pressed').at(-1)[0] && !called(toggle('Red'), 'pressed').at(-1)[0], 'a picked choice reads as pressed');
  assert.ok(!isDisabled(named(shown, 'Send answers')), 'Send answers is on once every question has a choice');
  group.type(nodesOf(shown, 'input')[1], 'also D');
  await group.click(named(group.render(), 'Send answers'));
  const sent = answerCalls(group);
  assert.equal(sent.length, 1, 'one send for both questions');
  assert.deepEqual(sent[0].args.slice(0, 5), [`${HOME}/mods/fabraik-queue/queue.mjs`, 'answer-menu', 't2', askId(2), '--answer']);
  assert.deepEqual(JSON.parse(sent[0].args[5]), record(askId(2), { [colour.question]: { choices: ['Blue'] }, [letters.question]: { choices: ['A', 'C'], text: 'also D' } }),
    'one answer covers every question, each keyed by its text');
  assert.ok(ran(group).every(({ program, args }) => program === 'node' && args[0] === `${HOME}/mods/fabraik-queue/queue.mjs`), 'only queue.mjs runs');
});

// Waiting menus as queue.mjs lists a hook's ask: the card is the string the job's mark holds, beside the repository of the
// job's main checkout (or why it could not be read) and, for a permission prompt, whether the panel shows its call whole.
// The expected lines and controls are the approved plan's shared ask contract and its queue and panel repairs.
const menuAskId = (n) => n.toString(16).padStart(32, '0');
const DELIVER_QUESTION = {
  question: 'Deliver card 5 now?', header: 'Deliver', multiSelect: false,
  options: [{ label: 'Yes, deliver', description: 'Merge it' }, { label: 'No, put aside', description: 'Hold it' }],
};
const waitingMenu = (n, fields) => ({
  category: 'menu', key: `menu:t${n}/${menuAskId(n)}`, terminal: `t${n}`, askId: menuAskId(n), card: '5', repository: '/repos/a',
  kind: 'question', toolName: 'AskUserQuestion', askedAt: 1_795_000_000_000, questions: [DELIVER_QUESTION], answerable: true, ...fields,
});
test('a Decisions card shows when its agent asked it, as a clock time, with the date when that was not today', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 19, 15, 30).getTime() });
  const today = waitingMenu(1, { askedAt: new Date(2026, 10, 19, 14, 2).getTime() });
  const earlier = waitingMenu(2, { askedAt: new Date(2026, 10, 18, 14, 2).getTime() });
  const tree = (await decisionsScene(panelCache([today, earlier]))).render();
  const drawn = strings(tree);
  const todays = strings(cardOf(tree, today.key));
  const earliers = strings(cardOf(tree, earlier.key));
  assert.ok(drawn.includes('card 5'), `a waiting menu draws its card: ${drawn.join(' | ')}`);
  assert.ok(todays.includes(', waiting since 14:02'), `a menu asked today shows its clock time: ${todays.join(' | ')}`);
  assert.ok(!todays.includes(', waiting since 18 Nov, 14:02'), `a menu asked today shows no date: ${todays.join(' | ')}`);
  assert.ok(earliers.includes(', waiting since 18 Nov, 14:02'), `a menu asked on another day shows its date and time: ${earliers.join(' | ')}`);
  assert.ok(!earliers.includes(', waiting since 14:02'), `a menu asked on another day shows its date: ${earliers.join(' | ')}`);
});

test('a Decisions card that no agent ask times says its wait time is not recorded', async () => {
  const items = [queueItem('merge', 5), queueItem('question', 6), queueItem('usage-limit', 11), queueItem('suggested', 8), queueItem('failure', 10)];
  const drawn = strings((await decisionsScene(panelCache(items))).render());
  assert.equal(drawn.filter((line) => line === ', wait time not recorded').length, 5, `each of the five cards says so: ${drawn.join(' | ')}`);
  assert.ok(!drawn.some((line) => line.startsWith(', waiting since')), 'no card claims a time it does not have');
});

test('a waiting menu whose ask time is not a past time says its wait time is unreadable and still draws its card', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 19, 15, 30).getTime() });
  const asked = ['abc', null, undefined, Date.now() + 60000, -1e20];
  const menus = asked.map((askedAt, i) => waitingMenu(i + 1, { askedAt }));
  const drawn = strings((await decisionsScene(panelCache(menus))).render());
  assert.equal(drawn.filter((line) => line === ', wait time unreadable').length, 5, `each menu says its wait time is unreadable: ${drawn.join(' | ')}`);
  assert.equal(drawn.filter((line) => line === 'Deliver').length, 5, `each menu still draws its title: ${drawn.join(' | ')}`);
  assert.ok(!drawn.some((line) => line.includes('cannot be read')), 'nothing is drawn as a problem line');
});

// The decision cards a tree draws as Markdown.
const decisionCards = (tree) => nodesOf(tree, 'markdown').map(textOf);

test("a deliver menu shows the decision card of the merge of its own repository and numeric card, or says why it shows none", async () => {
  const mergeA = queueItem('merge', 5, { decisionCard: 'Ship card 5 of a.' });
  const mergeB = inRepository('b', 'merge', 5, { decisionCard: 'Ship card 5 of b.' });
  const menuB = waitingMenu(1, { repository: '/repos/b' });

  // The merge of the menu's own repository and numeric card, never one of another repository with the same number.
  const host = await itemScene([mergeA, mergeB, menuB]);
  assert.deepEqual(decisionCards(cardOf(host.render(), menuB.key)), ['Ship card 5 of b.'], 'the deliver menu shows its own merge');
  const elsewhere = await itemScene([mergeA, menuB]);
  const alone = cardOf(elsewhere.render(), menuB.key);
  assert.deepEqual(decisionCards(alone), [], 'a merge of another repository with the same card is never shown');

  // An ask whose repository was not read shows no decision card and says why.
  const UNREAD = 'fatal: not a repository';
  const unreadMenu = waitingMenu(2, { repository: undefined, repositoryUnread: UNREAD });
  const blind = cardOf((await itemScene([mergeA, unreadMenu])).render(), unreadMenu.key);
  assert.deepEqual(decisionCards(blind), [], 'an ask without its repository shows no decision card');
  assert.ok(textOf(blind).includes(UNREAD), `it says why no decision card is shown: ${strings(blind).join(' | ')}`);
});

test('a merge whose repository and card have a waiting menu draws no answer box and no Put aside, so the menu is the one place to answer', async () => {
  const mergeA = queueItem('merge', 5);
  const mergeB = inRepository('b', 'merge', 5);
  const menuB = waitingMenu(1, { repository: '/repos/b' });
  const decisions = (await decisionsScene(panelCache([mergeA, mergeB, menuB]))).render();
  assert.deepEqual(itemButtons(decisions, mergeB.key), [], 'the Decisions view draws no control for the merge of the waiting menu');
  assert.deepEqual(itemButtons(decisions, mergeA.key).map(controlName).sort(), ['Put aside', sendName(5)], 'the other merge keeps its controls there');
});

test('the Decisions view counts and lists waiting menus', async () => {
  const menu = waitingMenu(3, { card: '9' });
  const decisions = (await decisionsScene(panelCache([menu, queueItem('failure', 10)]))).render();
  const lines = strings(decisions);
  assert.equal(progressText(decisions), '2 waiting, 0 handled', `the Decisions header counts the menu: ${lines.join(' | ')}`);
  assert.ok(!lines.some((line) => line.startsWith('Nothing') && line.includes('waiting on you')), 'the Decisions view does not say nothing waits');
  const tile = lines.indexOf('a');
  assert.equal(lines[tile + 1], '2 need you', `the project's tile counts the menu: ${lines.join(' | ')}`);
  assert.equal(lines[lines.indexOf('a', tile + 1) + 1], '2 left', `the project's group counts the menu: ${lines.join(' | ')}`);
  assert.ok(itemButtons(decisions, menu.key).some((button) => labelOf(button) === 'No, put aside for card 9'), 'the Decisions view lists the menu, answerable');
});

// Waiting menus by card, each with how many of its questions are multi-select and the items drawn beside it: the deliver
// menu beside the merge at the version it asked about, so it draws its answer box.
const SINGLE_QUESTION = { question: 'Which colour do you pick?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] };
const MULTI_QUESTION = { question: 'Which letters go in?', header: 'Letters', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
const FORM_MENUS = [
  { item: waitingMenu(4, { card: '6', questions: [SINGLE_QUESTION, MULTI_QUESTION] }), card: 6, multiple: 1 },
  { item: waitingMenu(5, { card: '7', questions: [SINGLE_QUESTION] }), card: 7, multiple: 0 },
  { item: waitingMenu(6, { card: '8', questions: [MULTI_QUESTION] }), card: 8, multiple: 1 },
  { item: waitingMenu(1, { version: DELIVER_VERSION }), card: 5, multiple: 0, beside: [queueItem('merge', 5, { ...DELIVER_VERSION })] },
];

test('a multi-select question says in words that more than one choice may be picked', async () => {
  for (const { item, card, multiple, beside = [] } of FORM_MENUS) {
    const lines = strings(cardOf((await itemScene([...beside, item])).render(), item.key));
    assert.equal(lines.filter((line) => /more than one/i.test(line)).length, multiple, `card ${card}: one line for each multi-select question: ${lines.join(' | ')}`);
  }
});

test('every answer box of a waiting menu shows its name as a visible label', async () => {
  for (const { item, card, beside = [] } of FORM_MENUS) {
    const tree = cardOf((await itemScene([...beside, item])).render(), item.key);
    const lines = strings(tree);
    const boxes = nodesOf(tree, 'input');
    assert.ok(boxes.length > 0, `card ${card} draws an answer box`);
    for (const box of boxes) assert.ok(lines.includes(labelOf(box)), `card ${card}: the box named ${labelOf(box)} shows that name: ${lines.join(' | ')}`);
  }
});

test('a permission menu offers Allow once only where the panel shows its call whole, and says so where it does not', async () => {
  const permission = (n, fields) => waitingMenu(n, { card: '7', kind: 'permission', questions: undefined, ...fields });
  const shown = permission(7, { toolName: 'Bash', input: 'npm test', whole: true });
  const notWhole = [
    { why: 'a Write call', item: permission(8, { toolName: 'Write', input: '/jobs/job-857/notes.txt', whole: false }) },
    { why: 'a command that looks like it holds a credential', item: permission(9, { input: 'Not shown here: it looks like it holds a credential', toolName: 'Bash', whole: false }) },
    { why: 'an ask that records no whole flag', item: permission(10, { toolName: 'Bash', input: 'npm test', whole: undefined }) },
  ];
  const choices = (tree, item) => itemButtons(tree, item.key).map(controlName).filter((name) => name !== sendName(7)).sort();
  const wholeLines = (tree) => strings(tree).filter((line) => /\bwhole\b/i.test(line));

  const open = cardOf((await itemScene([shown])).render(), shown.key);
  assert.deepEqual(choices(open, shown), ['Allow once', 'Deny'], 'a call shown whole offers Allow once');
  assert.deepEqual(wholeLines(open), [], 'a call shown whole needs no line about it');
  for (const { why, item } of notWhole) {
    const tree = cardOf((await itemScene([item])).render(), item.key);
    assert.deepEqual(choices(tree, item), ['Deny'], `${why}: Deny and no Allow once`);
    assert.equal(wholeLines(tree).length, 1, `${why}: one line says the call is not shown whole: ${strings(tree).join(' | ')}`);
  }
});

const SHIP_QUESTION = { question: 'Ship it?', header: 'Ship it', multiSelect: false, options: [{ label: 'No, put aside' }, { label: 'Fix the title first' }, { label: 'Yes, deliver' }] };
const COLOUR_QUESTION = { question: 'Which colour do you pick?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] };
// A deliver menu's Yes merges the version the owner sees, so it is drawn only where the version the job asked about, its
// head and identity, is the version of the merge whose decision card the menu shows. Anywhere else a menu with one
// question offers its other choices and says why, and a menu with several questions has no answer control. The expected
// controls and lines are the approved plan's version repair.
test('a deliver menu offers Yes, deliver only where the version its job asked about is the version of the decision card it shows', async () => {
  const merge = queueItem('merge', 5, { ...DELIVER_VERSION });
  const choices = (tree, item) => itemButtons(tree, item.key).map(controlName).sort();
  const versionLines = (tree) => strings(tree).filter((line) => /\bversion\b/i.test(line));

  const matching = waitingMenu(1, { version: DELIVER_VERSION });
  const open = cardOf((await itemScene([merge, matching])).render(), matching.key);
  assert.deepEqual(choices(open, matching), ['No, put aside', sendName(5), 'Yes, deliver'], 'the version asked about is shown: Yes, deliver beside the answer box');
  assert.equal(nodesOf(open, 'input').length, 1, 'one answer box');
  assert.deepEqual(versionLines(open), [], 'a matching version needs no line about it');

  const VERSION_UNREAD = 'fatal: ambiguous argument HEAD';
  const notAskedAbout = (line) => /not the version the job asked about/i.test(line);
  const refused = [
    { why: 'another head, in the Ship it layout', item: waitingMenu(2, { questions: [SHIP_QUESTION], version: { ...DELIVER_VERSION, head: '3'.repeat(40) } }), says: notAskedAbout,
      offers: ['Fix the title first', 'No, put aside'] },
    { why: 'another identity', item: waitingMenu(3, { version: { ...DELIVER_VERSION, identity: '4'.repeat(40) } }), says: notAskedAbout },
    { why: 'a version the job could not read', item: waitingMenu(4, { versionUnread: VERSION_UNREAD }),
      says: (line) => /\bversion\b/i.test(line) && line.includes(VERSION_UNREAD) },
    { why: 'an ask that records no version, beside a merge that carries none', item: waitingMenu(5), beside: [queueItem('merge', 5)] },
    { why: 'no merge of its repository and card', item: waitingMenu(6, { version: DELIVER_VERSION, repository: '/repos/b' }) },
  ];
  for (const { why, item, says, offers = ['No, put aside'], beside = [merge] } of refused) {
    const tree = cardOf((await itemScene([...beside, item])).render(), item.key);
    assert.deepEqual(choices(tree, item), offers, `${why}: ${offers.join(', ')} only`);
    assert.deepEqual(nodesOf(tree, 'input'), [], `${why}: no answer box`);
    if (says) assert.equal(strings(tree).filter(says).length, 1, `${why}: one line says why: ${strings(tree).join(' | ')}`);
  }

  const ship = waitingMenu(7, { questions: [SHIP_QUESTION], version: DELIVER_VERSION });
  const shipOpen = cardOf((await itemScene([merge, ship])).render(), ship.key);
  assert.deepEqual(choices(shipOpen, ship), ['Fix the title first', 'No, put aside', sendName(5), 'Yes, deliver'], 'the Ship it layout at the version asked about: Yes, deliver beside the answer box');
  assert.equal(nodesOf(shipOpen, 'input').length, 1, 'the Ship it layout draws one answer box');

  const two = waitingMenu(8, { questions: [COLOUR_QUESTION, SHIP_QUESTION], version: { ...DELIVER_VERSION, head: '3'.repeat(40) } });
  const twoTree = (await itemScene([merge, two])).render();
  assert.deepEqual(itemButtons(twoTree, two.key).map(controlName), [], 'two questions at another head: no answer control');
  assert.deepEqual(nodesOf(twoTree, 'input'), [], 'two questions at another head: no answer box');
  assert.equal(strings(twoTree).filter(notAskedAbout).length, 1, `two questions at another head: one line says why: ${strings(twoTree).join(' | ')}`);
});

// The hook records a deliver ask's version only for a menu with one single-select question offering Yes, deliver; any other
// menu offering it carries the hook's cause as versionUnread, so the panel offers no yes there and says it could not read
// the version, whatever the layout.
test('a deliver menu the hook could not record offers no yes and says why', async () => {
  const CAUSE = 'the menu must hold exactly one single-choice question offering "Yes, deliver"';
  const merge = queueItem('merge', 5, { ...DELIVER_VERSION });
  const unreadLines = (tree) => strings(tree).filter((line) => line === `The job could not read the version it asked about: ${CAUSE}`);
  const offersNothing = (tree, item, why) => {
    assert.deepEqual(itemButtons(tree, item.key).map(controlName), [], `${why}: no button, so no Yes, deliver and no send`);
    assert.deepEqual(nodesOf(tree, 'toggle').map(labelOf), [], `${why}: no toggle`);
    assert.deepEqual(nodesOf(tree, 'input'), [], `${why}: no answer box`);
    assert.equal(unreadLines(tree).length, 1, `${why}: one line says why: ${strings(tree).join(' | ')}`);
  };
  const MULTI_DELIVER = { ...DELIVER_QUESTION, multiSelect: true };

  const two = waitingMenu(1, { questions: [DELIVER_QUESTION, { ...DELIVER_QUESTION, question: 'Really ship it?' }], versionUnread: CAUSE });
  offersNothing((await itemScene([merge, two])).render(), two, 'two questions offering Yes, deliver');

  const multi = waitingMenu(2, { questions: [MULTI_DELIVER], versionUnread: CAUSE });
  offersNothing((await itemScene([merge, multi])).render(), multi, 'a multi-select question offering Yes, deliver');
});

// The inbox: the panel view, drawn live from Herdr's agent list (herdr.d.ts `agents()`), whose waiting menus come from
// `queue.mjs menus` at start-up, at each batch of a `watchFolder` of the ask folder and at each change in the blocked
// sessions, never on a timer and never from the tracker. The expected cards, lines, commands and Herdr commands are written
// by hand from card #858's criteria 2, 3 and 4, the plan's S3b and Visual direction and herdr.d.ts's live-read and
// watchFolder contract; the deliver safeguard is the Decisions view's, as the test above pins it.
const ASKS_FOLDER = `${HOME}/data/fabraik-asks`;
const QUEUE_FOLDER = `${HOME}/fabraik-queue`;
const CLAUDE_CODE = { key: 'claude', name: 'Claude Code', icon: null, tint: false, tile: null, color: null, shell: false, agent: true };
// Herdr's record of the session at `address`: in space `space-<n>` named `project<n>`, tab `tab-<n>` named `job <n>`.
const herdrAgent = (address, status, n) => ({
  address, pane: `pane-${n}`, space: `space-${n}`, space_name: `project${n}`, tab: `tab-${n}`, tab_index: 1, tab_name: `job ${n}`,
  status, app: 'claude-code', program: CLAUDE_CODE, title: `job ${n}`, seq: n, pinned: false, focused: false,
});
const READ_IN_DECISIONS = "Read it in Decisions";
// A queue whose `menus` prints `printed()`, a document or raw text, as it stands at each run; every other command succeeds.
const menusPrint = (/** @type {() => any} */ printed) => (/** @type {string} */ _program, /** @type {string[]} */ args) => {
  if (args[1] !== 'menus') return OK;
  const now = printed();
  return { code: 0, stdout: typeof now === 'string' ? now : `${JSON.stringify(now)}\n`, stderr: '' };
};
const commandsRun = (host) => ran(host).map(({ args }) => args[1]);

/** @param {{ agents: any[], printed?: () => any, cache?: any, execResult?: Exec }} options */
async function inboxScene({ agents, printed = () => ({ items: [], problems: [] }), cache = panelCache([]), execResult = menusPrint(printed) }) {
  const host = await loadPanel(execResult, {}, { lifecycle: true });
  host.agentList = agents;
  host.setCache(cache);
  await host.started();
  return host;
}

test('a blocked session is a Needs you card on the next render, with its waiting menu, and leaves it once it works', async () => {
  const ask = waitingMenu(1, { card: '7', kind: 'permission', questions: undefined, toolName: 'Bash', input: 'npm test', whole: false });
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1), herdrAgent('t2', 'working', 2)], printed: () => ({ items: [ask], problems: [] }) });
  let tree = host.render();
  assert.ok(strings(tree).includes('Inbox') && strings(tree).includes('1 need you'), `the header counts who needs you: ${strings(tree).join(' | ')}`);
  const card = cardOf(tree, ask.key);
  assert.ok(['Claude Code', 'project1, job 1'].every((line) => strings(card).includes(line)), `the card names its program, project and tab: ${strings(card).join(' | ')}`);
  assert.ok(strings(card).includes('Bash: npm test'), 'the permission ask shows its command');
  assert.equal(strings(card).filter((line) => /\bwhole\b/i.test(line)).length, 1, 'and one line says the call is not shown whole');
  assert.deepEqual(itemButtons(card, ask.key).map(controlName).sort(), ['Deny', sendName(7)], 'its answers are the menu\'s');
  assert.ok(strings(tree).includes('Running') && strings(tree).includes('Claude Code, project2, job 2'), 'the working session is a Running line');
  assert.deepEqual(host.agentOrders.at(-1), ['t1', 't2'], "Herdr's next and previous agent follow the drawn order");

  host.agentList = [herdrAgent('t1', 'working', 1), herdrAgent('t2', 'working', 2)];
  tree = host.render();
  assert.deepEqual(itemButtons(tree, ask.key), [], 'no card once the session works');
  assert.ok(strings(tree).includes('Nobody needs you. 2 running.'), `the empty state counts the running sessions: ${strings(tree).join(' | ')}`);
  assert.deepEqual(host.timers, [], 'the inbox starts no timer');
  assert.ok(commandsRun(host).every((command) => command === 'menus'), `the inbox runs only menus: ${commandsRun(host).join(' ')}`);
});

test('an answer from the inbox runs answer-menu and then reads the waiting menus again, never a refresh', async () => {
  const ask = waitingMenu(1, { card: '7', kind: 'permission', questions: undefined, toolName: 'Bash', input: 'npm test', whole: true });
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1)], printed: () => ({ items: [ask], problems: [] }) });
  await host.click(buttonOf(host.render(), ask.key, 'Allow once'));
  assert.deepEqual(commandsRun(host), ['menus', 'answer-menu', 'menus'], 'the answer is sent, then the menus are read again');
  assert.deepEqual(ran(host)[1].args.slice(1, 4), ['answer-menu', 't1', ask.askId], 'the answer names its terminal and ask');
  assert.deepEqual(itemButtons(host.render(), ask.key), [], 'the sent ask offers no answer again');
});

test("Open selects the session's space, tab and pane, from a Needs you card and from a Running line", async () => {
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1), herdrAgent('t2', 'working', 2)] });
  await host.click(named(host.render(), 'Open Claude Code in project1, job 1'));
  await host.click(named(host.render(), 'Open Claude Code in project2, job 2'));
  assert.deepEqual(host.runs, [
    ['space.select', { id: 'space-1' }], ['tab.select', { id: 'tab-1' }], ['pane.focus', { terminal: 't1' }],
    ['space.select', { id: 'space-2' }], ['tab.select', { id: 'tab-2' }], ['pane.focus', { terminal: 't2' }],
  ]);
  assert.ok(strings(nodeWithId(host.render(), 'fabraik-queue-go-t1')).includes('Open'), 'the control reads Open');
});

test('each batch of changes under the ask folder reads the waiting menus once, and close cancels the watches', async () => {
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1)] });
  assert.deepEqual(commandsRun(host), ['menus'], 'one read at start-up');
  assert.deepEqual(host.watches.map(({ path }) => path).sort(), [ASKS_FOLDER, QUEUE_FOLDER], 'the inbox watches the ask folder and the saved queue');
  await host.batch(ASKS_FOLDER, [`${ASKS_FOLDER}/t1/${menuAskId(1)}/ask.json`, `${ASKS_FOLDER}/t1/${menuAskId(1)}`]);
  assert.deepEqual(commandsRun(host), ['menus', 'menus'], 'one batch, one more read');
  await host.batch(ASKS_FOLDER, [`${ASKS_FOLDER}/t1/${menuAskId(1)}/answer.json`]);
  assert.deepEqual(commandsRun(host), ['menus', 'menus', 'menus'], 'the next batch, one more read');
  await host.panel.close();
  assert.ok(host.watches.filter((watch) => !watch.settled).length === 0 && host.watches.some((watch) => watch.cancelled), 'close cancels every open watch');
  assert.deepEqual(host.timers, [], 'no timer stands in for a watch');
});

test('an ask written while its session works is answerable once the session turns blocked, which reads the menus again', async () => {
  const ask = waitingMenu(1, { card: '7', questions: [{ ...COLOUR_QUESTION, question: 'Which colour?' }] });
  let written = false;
  let host;
  // As `readMenus` does, the ask is answerable only where the terminal list it was given says its session is blocked.
  host = await inboxScene({
    agents: [herdrAgent('t1', 'working', 1)],
    printed: () => ({ items: written ? [{ ...ask, answerable: host.agentList[0].status === 'blocked' }] : [], problems: [] }),
  });
  written = true;
  await host.batch(ASKS_FOLDER, [`${ASKS_FOLDER}/t1/${menuAskId(1)}/ask.json`]);
  assert.deepEqual(commandsRun(host), ['menus', 'menus'], 'the batch reads the menus while the session works');
  host.agentList = [herdrAgent('t1', 'blocked', 1)];
  await host.task(() => host.render());
  assert.deepEqual(commandsRun(host), ['menus', 'menus', 'menus'], 'the session turning blocked reads the menus again');
  const tree = host.render();
  assert.deepEqual(itemButtons(cardOf(tree, ask.key), ask.key).map(controlName).sort(), ['Blue', 'Red', sendName(7)], 'the card offers the ask\'s answers');
  host.render();
  assert.deepEqual(commandsRun(host), ['menus', 'menus', 'menus'], 'a render with the same blocked sessions reads nothing');
});

test('waiting menus the queue cannot print are a problem line, and the blocked sessions still show', async () => {
  for (const [why, printed] of [['text that is not JSON', 'not json'], ['a document of another shape', { items: 'none', problems: [] }],
    ['an item that is no waiting menu', { items: [{ category: 'merge' }], problems: [] }]]) {
    const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1)], printed: () => printed });
    const lines = strings(host.render());
    assert.equal(lines.filter((line) => line.startsWith('Waiting menus unread: ')).length, 1, `${why}: one problem line: ${lines.join(' | ')}`);
    assert.ok(lines.includes('Claude Code') && lines.includes('Answer in its tab'), `${why}: the blocked session shows, with no answers`);
  }
  const failed = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1)], execResult: { code: 1, stdout: '', stderr: 'no home\n' } });
  assert.ok(strings(failed.render()).includes('Waiting menus unread: no home'), 'a failed run names its cause');
});

test('a session record Herdr gives without its address or status is not drawn and is counted', async () => {
  const { address: _address, ...addressless } = herdrAgent('t2', 'blocked', 2);
  const { status: _status, ...statusless } = herdrAgent('t3', 'blocked', 3);
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1), addressless, statusless] });
  const lines = strings(host.render());
  assert.ok(lines.includes('Herdr reported 2 sessions this panel cannot read'), `the skipped records are counted: ${lines.join(' | ')}`);
  assert.ok(lines.includes('1 need you') && !lines.includes('project2, job 2') && !lines.includes('project3, job 3'), 'only the whole record is drawn');
});

test('while Herdr reports a session the panel cannot read, the inbox claims neither that nobody needs you nor a zero count', async () => {
  const { status: _status, ...statusless } = herdrAgent('t1', 'blocked', 1);
  const host = await inboxScene({ agents: [statusless] });
  const lines = strings(host.render());
  assert.ok(lines.includes('Herdr reported 1 session this panel cannot read'), `the unreadable session is counted: ${lines.join(' | ')}`);
  assert.ok(!lines.some((line) => line.startsWith('Nobody needs you')), `no empty Needs you is claimed: ${lines.join(' | ')}`);
  assert.ok(!lines.some((line) => /(^|\s)0 (need you|running)\b/.test(line)), `no zero total is claimed: ${lines.join(' | ')}`);
});

test('the ask folder is watched through the data folder until it exists, and a refused watch is a problem line', async () => {
  const host = await loadPanel(menusPrint(() => ({ items: [], problems: [] })), {}, { lifecycle: true });
  host.agentList = [];
  host.setCache(null);
  host.refusedWatches.set(ASKS_FOLDER, 'no such folder');
  await host.started();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(host.watches.some((watch) => watch.path === `${HOME}/data` && !watch.settled), 'the data folder is watched while the ask folder cannot be');
  await host.batch(`${HOME}/data`, [`${HOME}/data/other`]);
  assert.deepEqual(commandsRun(host), ['menus'], 'a batch that does not name the ask folder reads nothing');
  host.refusedWatches.delete(ASKS_FOLDER);
  await host.batch(`${HOME}/data`, [ASKS_FOLDER]);
  assert.deepEqual(commandsRun(host), ['menus', 'menus'], 'the batch naming the ask folder reads the menus');
  assert.ok(host.watches.some((watch) => watch.path === ASKS_FOLDER && !watch.settled), 'and the ask folder is watched again');

  const refused = await loadPanel(menusPrint(() => ({ items: [], problems: [] })), {}, { lifecycle: true });
  refused.agentList = [];
  refused.setCache(null);
  refused.refusedWatches.set(ASKS_FOLDER, 'no such folder');
  refused.refusedWatches.set(`${HOME}/data`, 'too many folders');
  await refused.started();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(strings(refused.render()).includes('Waiting menus unread: too many folders'), 'a refused watch is a problem line');
});

// D2 a: the inbox's deliver ask keeps the Decisions view's safeguard, reading the decision card from the saved queue: Yes
// only where the saved merge is the version the job asked about, else the decline and the control that opens Decisions.
test('a deliver ask in the inbox offers Yes only where the saved queue holds the asked version, else Open Decisions', async () => {
  const deliver = waitingMenu(1, { version: DELIVER_VERSION });
  const printed = () => ({ items: [deliver], problems: [] });
  const agents = [herdrAgent('t1', 'blocked', 1)];
  const choices = (host) => itemButtons(cardOf(host.render(), deliver.key), deliver.key).map(controlName).sort();
  const cases = [
    { why: 'no saved queue', cache: null },
    { why: 'a saved card of another version', cache: panelCache([queueItem('merge', 5, { version: CHANGED, head: '3'.repeat(40), identity: '4'.repeat(40) })]), line: (found) => /not the version the job asked about/i.test(found) },
    { why: 'an unreadable saved queue', cache: { format: 1 }, line: (line) => line.startsWith('Queue cache unreadable') },
  ];
  for (const { why, cache, line } of cases) {
    const host = await inboxScene({ agents, printed, cache });
    assert.deepEqual(choices(host), ['No, put aside', READ_IN_DECISIONS], `${why}: the decline and Open Decisions, no Yes`);
    assert.deepEqual(nodesOf(cardOf(host.render(), deliver.key), 'input'), [], `${why}: no chat field`);
    if (line) assert.equal(strings(host.render()).filter(line).length, 1, `${why}: one line says why`);
    await host.click(buttonOf(host.render(), deliver.key, READ_IN_DECISIONS));
    assert.deepEqual(host.overlays, [viewSpec('decisions', undefined)], `${why}: the control opens Decisions over the window`);
  }
  const matching = panelCache([queueItem('merge', 5, { ...DELIVER_VERSION })]);
  const host = await inboxScene({ agents, printed, cache: null });
  host.setCache(matching);
  await host.batch(QUEUE_FOLDER, [`${QUEUE_FOLDER}/queue.json`]);
  assert.deepEqual(choices(host), ['No, put aside', sendName(5), 'Yes, deliver'], 'a saved card of the asked version, read at its batch, offers Yes and the chat field');
  assert.equal(nodesOf(cardOf(host.render(), deliver.key), 'input').length, 1, 'one chat field');
  assert.deepEqual(commandsRun(host), ['menus'], 'reading the saved queue runs no command');
});

test('the saved queue folder is watched again before each load of it, so a write during that load reaches the deliver menus', async () => {
  const deliver = waitingMenu(1, { version: DELIVER_VERSION });
  const host = await inboxScene({ agents: [herdrAgent('t1', 'blocked', 1)], printed: () => ({ items: [deliver], problems: [] }), cache: null });
  let release;
  host.cacheGate = new Promise((resolve) => { release = resolve; });
  host.setCache(panelCache([]));
  await host.batch(QUEUE_FOLDER, [`${QUEUE_FOLDER}/queue.json`]);
  assert.ok(host.watches.some((watch) => watch.path === QUEUE_FOLDER && !watch.settled), 'while the load a batch started is pending, the saved queue folder is watched');
  host.setCache(panelCache([queueItem('merge', 5, { ...DELIVER_VERSION })]));
  await host.batch(QUEUE_FOLDER, [`${QUEUE_FOLDER}/queue.json`]);
  host.cacheGate = null;
  release();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(itemButtons(cardOf(host.render(), deliver.key), deliver.key).map(controlName).sort(), ['No, put aside', sendName(5), 'Yes, deliver'],
    'the write made during that load is read by a later one');
});

test('the Decisions view draws every waiting item once under its project in queue order', async () => {
  const items = [
    inRepository('a', 'suggested', 7, { scope: 'Build the thing.' }),
    inRepository('b', 'question', 3),
    inRepository('d', 'failure', 2),
    inRepository('a', 'merge', 5),
    inRepository('b', 'usage-limit', 9),
    { category: 'problem', repository: '/repos/c', problem: 'corrupt record' },
    digestEntry,
  ];
  const boards = ['b', 'c', 'a'].map((folder) => ({ repository: `/repos/${folder}`, cards: [] }));
  // A group heading is its folder name followed by its count; a card is drawn by its folder and card line.
  const drawnOrder = (tree) => {
    const lines = strings(tree);
    return lines.flatMap((line, index) => {
      if (/^[a-d] card \d+$/.test(line)) return [line];
      const count = lines[index + 1] ?? '';
      return /^(\d+ left|all handled)$/.test(count) ? [`${line} ${count}`] : [];
    });
  };

  const host = await decisionsScene({ ...panelCache(items), boards });
  let tree = host.render();
  assert.deepEqual(drawnOrder(tree), ['b 2 left', 'b card 3', 'b card 9', 'a 2 left', 'a card 7', 'a card 5', 'd 1 left', 'd card 2'],
    "the boards' projects in their order, then the others in item order, each card in cache order; c waits on nothing so has no group");
  for (const ref of ['a card 7', 'b card 3', 'd card 2', 'a card 5', 'b card 9']) {
    assert.equal(strings(tree).filter((line) => line === ref).length, 1, `${ref} is drawn once`);
  }

  await host.click(buttonOf(tree, '/repos/d#2', 'Dismiss'));
  tree = host.render();
  assert.deepEqual(drawnOrder(tree), ['b 2 left', 'b card 3', 'b card 9', 'a 2 left', 'a card 7', 'a card 5', 'd all handled'], 'a group whose cards are all handled says so');

  const unboarded = await decisionsScene(panelCache(items));
  assert.deepEqual(drawnOrder(unboarded.render()), ['a 2 left', 'a card 7', 'a card 5', 'b 2 left', 'b card 3', 'b card 9', 'd 1 left', 'd card 2'],
    'without boards the projects come in item order');
});

test('a Decisions card answers through its command and names a refusal', async () => {
  const suggested = queueItem('suggested', 8, { scope: 'Build the thing.' });
  const presses = [
    { item: queueItem('merge', 5), press: 'Put aside', expected: ['act', keyOf(5), 'park', versionOf(5)] },
    { item: queueItem('merge', 5), answer: 'yes', press: sendName(5), expected: ['act', keyOf(5), 'answer', versionOf(5), 'yes'] },
    { item: queueItem('question', 6, { answerable: true }), answer: 'Blue.', press: sendName(6), expected: ['act', keyOf(6), 'answer', versionOf(6), 'Blue.'] },
    { item: suggested, press: 'Accept card', expected: ['act', keyOf(8), 'keep', versionOf(8)] },
    { item: suggested, press: 'Reject', expected: ['act', keyOf(8), 'drop', versionOf(8)] },
  ];
  for (const { item, answer, press, expected } of presses) {
    const decisions = await decisionsScene(panelCache([item]));
    if (answer !== undefined) decisions.type(boxOf(decisions.render(), `Answer to card ${item.card}`), answer);
    await decisions.click(buttonOf(decisions.render(), item.key, press));
    assert.deepEqual(ran(decisions), [queueCall(...expected)], `${press}: the Decisions card runs its command`);
  }

  const refusal = 'card 5 changed since the panel drew it: refresh the queue';
  const refusedWith = { code: 1, stdout: '', stderr: `${refusal}\n` };
  const refused = await decisionsScene(panelCache([queueItem('merge', 5)]), refusedWith);
  await refused.click(buttonOf(refused.render(), keyOf(5), 'Put aside'));
  const tree = refused.render();
  assert.ok(strings(tree).includes(`Put aside failed: ${refusal}`), `the refusal names its button: ${strings(tree).join(' | ')}`);
  assert.ok(!strings(tree).includes('Put aside; the queue confirms on its next read'), 'a refused answer leaves no receipt');
  buttonOf(tree, keyOf(5), 'Put aside');

  const unsent = await decisionsScene(panelCache([queueItem('merge', 5)]), refusedWith);
  unsent.type(boxOf(unsent.render(), 'Answer to card 5'), 'yes');
  await unsent.click(buttonOf(unsent.render(), keyOf(5), sendName(5)));
  const kept = unsent.render();
  assert.ok(strings(kept).includes(`Send answer failed: ${refusal}`), `the refused answer names the send: ${strings(kept).join(' | ')}`);
  assert.ok(!strings(kept).includes(RELAYED), 'a refused answer leaves no receipt');
  assert.equal(boxOf(kept, 'Answer to card 5').state.value(), 'yes', 'a refused answer keeps its words');
});

test('a handled Decisions card stays a receipt in its place until the read confirms it', async () => {
  const parked = 'Put aside; the queue confirms on its next read';
  const items = [queueItem('merge', 5), queueItem('merge', 6), queueItem('failure', 10)];
  // Each card in drawn order: its folder and card line, or its receipt's card and title.
  const places = (tree) => strings(tree).filter((line) => /^a card \d+(, a\d+)?$/.test(line));
  const undos = (tree) => buttonsIn(tree).filter((button) => nameOf(button) === 'Undo');
  const host = await decisionsScene(panelCache(items));
  assert.deepEqual(places(host.render()), ['a card 5', 'a card 6', 'a card 10']);

  await host.click(buttonOf(host.render(), keyOf(6), 'Put aside'));
  let tree = host.render();
  assert.deepEqual(places(tree), ['a card 5', 'a card 6, a6', 'a card 10'], 'the handled card is its receipt in its own place');
  assert.ok(strings(tree).includes(parked), `the receipt says what was done: ${strings(tree).join(' | ')}`);
  assert.deepEqual(itemButtons(tree, keyOf(6)), [], 'a written answer leaves no control, Undo included');

  await host.click(buttonOf(tree, keyOf(10), 'Dismiss'));
  tree = host.render();
  assert.deepEqual(places(tree), ['a card 5', 'a card 6, a6', 'a card 10, a10']);
  assert.equal(undos(tree).length, 1, 'only the local mark has Undo');
  await host.click(buttonOf(tree, keyOf(10), 'Undo'));
  assert.deepEqual(places(host.render()), ['a card 5', 'a card 6, a6', 'a card 10'], 'Undo restores the card in its place');

  host.setCache(panelCache(items));
  await readCache(host);
  tree = host.render();
  assert.deepEqual(places(tree), ['a card 5', 'a card 6, a6', 'a card 10'], 'a reread of the same cache keeps the receipt');
  assert.ok(strings(tree).includes(parked));

  await reload(host, [items[0], items[2]]);
  tree = host.render();
  assert.deepEqual(places(tree), ['a card 5', 'a card 10'], 'a read without the card drops its receipt');
  assert.ok(!strings(tree).includes(parked));
});

test("the Decisions progress counts the day's handled decisions after the read confirms them", async (t) => {
  const yesterday = new Date(2026, 10, 11, 12).getTime();
  const today = new Date(2026, 10, 12, 12).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: yesterday });
  const left = [queueItem('question', 7), queueItem('failure', 10)];
  const host = await decisionsScene(panelCache([queueItem('merge', 5), ...left]));
  assert.equal(progressText(host.render()), '3 waiting, 0 handled');

  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  assert.equal(progressText(host.render()), '2 waiting, 1 handled');
  await reload(host, left);
  assert.equal(progressText(host.render()), '2 waiting, 1 handled', 'the handled card stays counted after the read confirms it');

  await host.click(buttonOf(host.render(), keyOf(10), 'Dismiss'));
  assert.equal(progressText(host.render()), '1 waiting, 2 handled');
  await host.click(buttonOf(host.render(), keyOf(10), 'Undo'));
  assert.equal(progressText(host.render()), '2 waiting, 1 handled', 'Undo uncounts it');

  t.mock.timers.setTime(today);
  await reload(host, left);
  assert.equal(progressText(host.render()), '2 waiting, 0 handled', "a load on a later day drops the earlier day's handled card");
});

// One card the view cannot read is a problem line in its place; the cards beside it draw in full and the view still stands.
test('a card the view cannot read is a problem line in its place, beside the cards it can', async () => {
  const valid = inRepository('a', 'merge', 5, { decisionCard: 'Ship the valid card.' });
  const broken = inRepository('b', 'merge', 6, { decisionCard: 'Ship the broken card.', visual: undefined, screenshots: null });
  const unreadableCard = (tree) => strings(tree).filter((line) => line.includes('b card 6') && line.includes('cannot be read'));
  const failed = (tree) => strings(tree).filter((line) => line.startsWith('Queue cache unreadable'));

  const decisions = await decisionsScene(panelCache([valid, broken]));
  let tree = decisions.render();
  assert.deepEqual(failed(tree), [], 'one card the Decisions view cannot read does not fail the view');
  assert.ok(strings(tree).includes('a5') && strings(tree).includes('Ship the valid card.'), 'the valid card still draws in full');
  assert.equal(unreadableCard(tree).length, 1, 'the card it cannot read is one problem line naming its card and saying it cannot be read');
});

test('a project tile shows its waiting count and Coordinator line, and a board entry the view cannot read fails nothing', async () => {
  // A tile is the one element the Decisions view gives a 200 basis: its folder, its count, its Coordinator line, its outline.
  const tiles = (tree) => nodesOf(tree, 'v_flex').filter((node) => called(node, 'flex_basis').length > 0)
    .map((tile) => [...strings(tile), called(tile, 'border_color').at(-1)[0]]);
  const board = (folder) => ({ repository: `/repos/${folder}`, cards: [] });
  const noSpace = 'No Herdr space for this project';
  const boards = [board('empty'), board('one'), board('waits'), null, 'not an entry', board('neither')];
  const items = [
    inRepository('one', 'merge', 5),
    inRepository('one', 'failure', 6),
    inRepository('waits', 'question', 3),
    inRepository('neither', 'merge', 8),
    inRepository('elsewhere', 'merge', 4),
  ];
  const expected = (counts) => [
    ['empty', 'Nothing for you', noSpace, 'border'],
    ['one', counts.one, noSpace, 'border'],
    ['waits', '1 need you', noSpace, 'border'],
    ['neither', '1 need you', noSpace, 'border'],
    ['elsewhere', '1 need you', 'Coordinator state not in this read', 'border'],
  ];

  const host = await decisionsScene({ ...panelCache(items), boards });
  let tree = host.render();
  assert.deepEqual(tiles(tree), expected({ one: '2 need you' }), 'a tile for every boarded project then the others, each with its Coordinator line');
  assert.ok(!strings(tree).some((line) => line.startsWith('Queue cache unreadable')), 'a board entry the view cannot read does not fail the view');
  for (const ref of ['one card 5', 'neither card 8', 'elsewhere card 4']) {
    assert.ok(strings(tree).includes(ref), `${ref} is still drawn beside the unreadable entries`);
  }

  await host.click(buttonOf(tree, '/repos/one#6', 'Dismiss'));
  tree = host.render();
  assert.deepEqual(tiles(tree), expected({ one: '1 need you' }), 'a handled card no longer needs the owner');

  for (const [why, shape] of [['absent', undefined], ['null', null], ['an object', { one: 1 }], ['text', 'boards']]) {
    const unread = await decisionsScene({ ...panelCache(items), boards: shape });
    assert.deepEqual(tiles(unread.render()).map((tile) => tile.slice(0, 1).concat(tile.slice(2))), [
      ['one', 'Coordinator state not in this read', 'border'],
      ['waits', 'Coordinator state not in this read', 'border'],
      ['neither', 'Coordinator state not in this read', 'border'],
      ['elsewhere', 'Coordinator state not in this read', 'border'],
    ], `boards ${why}: a tile for each project with a waiting card`);
    assert.ok(strings(unread.render()).includes('one card 5'), `boards ${why}: the cards still draw`);
  }
});

// new behaviour: the panel knows no lead, so a project tile whose board is not in the read names its Coordinator.
test('a project tile whose board is not in the read says the Coordinator state is not in this read', async () => {
  // The tile is the one element the Decisions view gives a 200 basis; the test above keeps its own selector, which adds the outline.
  const tiles = (tree) => nodesOf(tree, 'v_flex').filter((node) => called(node, 'flex_basis').length > 0).map(strings);
  const host = await decisionsScene({ ...panelCache([inRepository('one', 'merge', 5)]), boards: [] });
  const tree = host.render();
  assert.deepEqual(tiles(tree).map((tile) => [tile[0], tile.at(-1)]), [['one', 'Coordinator state not in this read']]);
  assert.ok(strings(tree).includes('one card 5'), 'the card still draws');
});

// The Floor view: the same mod in a tab made with the props `{ view: 'floor' }`. It draws every project's open cards as a
// grid, one row per project and one column per stage. The expected cells, ids, tooltips, roles and lines are written by
// hand from the plan's Stage mapping and Project cell rules for each fixture, never read off the panel. Each board
// carries its folder and each card a null worktree, so no card shows an agent.
const FLOOR = { view: 'floor' };
const FLOOR_ID = 'fabraik-queue-floor-';
const STAGE_NAMES = ['Suggested', 'Ready to build', 'Building', 'Awaiting your yes', 'Merged today'];
const UNREADABLE_ENTRY = 'Board unreadable: its board entry is not one this view can read';
const TILE_ID = /^fabraik-queue-floor-\/repos\/[a-z0-9]+[#@]/;
// A board entry and a card as queue.mjs gives them, with the folder read and no job worktree.
const floorBoard = (folder, fields) => ({ repository: `/repos/${folder}`, folder: `/repos/${folder}`, cards: [], merged: [], ...fields });
const floorCard = (card, title, column, fields) => ({ card, title, column, blockers: [], claim: null, waitsOn: null, worktree: null, ...fields });
// This computer's spaces, their tabs and the panes in them, as Herdr's `spaces()` and `panes()` give them (herdr.d.ts).
const herdrTab = (id, name) => ({
  id, index: 1, name, named: true, active: true, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null,
});
const herdrSpace = (id, folder, tabs) => ({ id, index: 1, name: basename(folder), named: false, folder, machine: null, branch: null, active: false, status: null, tabs });
const SHELL_PROGRAM = { key: 'shell', name: 'zsh', icon: null, tint: false, tile: null, color: null, shell: true, agent: false };
const herdrPane = (pane, tab, status, program = CLAUDE_CODE) => ({
  pane, terminal: `term-${pane}`, tab, title: program.name, cwd: null, branch: null, status, app: program.agent ? 'claude-code' : null, program,
  focused: false, zoomed: false, movable: false,
});
// A local time on a day of November 2026, as the cache writes it.
const localTime = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).toISOString();
const NOON_12TH = new Date(2026, 10, 12, 12).getTime();

async function floorScene(cache, /** @type {Exec} */ execResult = OK) {
  const host = await loadPanel(execResult, FLOOR);
  host.setCache(cache);
  await host.panel.load();
  return host;
}

const inColumnOrder = (parts) => parts.sort((first, second) => first.index - second.index);
// Each body row of the grid as its cells in column order, and as those cells' strings.
const floorRows = (tree) => nodesOf(tree, 'table-body').flatMap((body) => nodesOf(body, 'table-row'))
  .map((row) => inColumnOrder(nodesOf(row, 'table-cell')));
const floorGrid = (tree) => floorRows(tree).map((cells) => cells.map(strings));
// The tiles: the elements, outside the table's own parts, whose id names a project's card or merge.
const floorTiles = (tree) => [...walk(tree)].map(([node]) => node)
  .filter((node) => !node.kind.startsWith('table') && TILE_ID.test(node.elementId ?? ''));
const tooltipOf = (node) => called(node, 'tooltip').at(-1)?.[0];

// The elements from `node` down to the one holding `text`, which must be drawn.
function pathTo(node, text) {
  const below = (from) => {
    if (from.kids.includes(text)) return [from];
    for (const kid of from.kids.filter((found) => typeof found !== 'string')) {
      const path = below(kid);
      if (path) return [from, ...path];
    }
    return null;
  };
  const path = below(node);
  assert.ok(path, `${text} is drawn`);
  return path;
}

// The colour and the size `text` is drawn in: the innermost of each set on the path from `node` to the element holding it.
const colourOf = (node, text) => pathTo(node, text).flatMap((found) => called(found, 'text_color')).at(-1)?.[0];
const sizeOf = (node, text) => pathTo(node, text).flatMap((found) => called(found, 'text_size')).at(-1)?.[0];

test('the Floor places every card of every project in the cell of its stage', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const boards = [
    floorBoard('a', {
      cards: [
        floorCard(1, 'Proposed: Add a thing', 'Backlog', { waitsOn: 'suggested' }),
        floorCard(2, 'Build it', 'Ready', { blockers: [1] }),
        floorCard(3, 'Running', 'In progress', { waitsOn: 'usage-limit' }),
        floorCard(4, 'Merging one', 'In review'),
        floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' }),
        floorCard(6, 'Later', 'Backlog'),
        floorCard(7, 'Unsorted', null),
        floorCard(8, 'Ready two', 'Ready'),
        floorCard(9, 'Asked', 'In progress', { blockers: [2, 3], waitsOn: 'question' }),
      ],
      merged: [
        { sha: 'm2', at: localTime(12, 0, 1), subject: 'Merged one (#10)' },
        { sha: 'm1', at: localTime(11, 23, 59), subject: 'Old one (#11)' },
      ],
    }),
    floorBoard('b', { cards: [floorCard('ENG-4', 'Keyed', 'Ready', { blockers: ['ENG-2'] })] }),
  ];
  const host = await floorScene({ ...panelCache([]), boards });
  const tree = host.render();
  assert.deepEqual(floorGrid(tree), [
    [
      ['a', '4 need you', 'Open board'],
      ['Suggested card', '#1', 'Add a thing'],
      ['#2', 'Build it', 'Blocked: waits for 1', '#8', 'Ready two'],
      ['Stopped at a usage limit', '#3', 'Running', '#4', 'Merging one', 'Merging', 'Blocking question', '#9', 'Asked', 'Blocked: waits for 2, 3'],
      ['Merge awaiting your yes', '#5', 'Ship it'],
      ['New', '00:01', 'Merged one (#10)'],
    ],
    [['b', 'Nothing for you', 'Open board'], [], ['ENG-4', 'Keyed', 'Blocked: waits for ENG-2'], [], [], []],
  ], "each card in its project's row and its stage's cell in board order; Backlog, a null column and yesterday's merge are not drawn");

  const tiles = floorTiles(tree);
  const ids = ['/repos/a#1', '/repos/a#2', '/repos/a#8', '/repos/a#3', '/repos/a#4', '/repos/a#9', '/repos/a#5', '/repos/a@m2', '/repos/b#ENG-4'];
  assert.deepEqual(tiles.map((tile) => tile.elementId).sort(), ids.map((id) => `${FLOOR_ID}${id}`).sort(), 'every tile has its id, once');
  const tileOf = (id) => tiles.find((tile) => tile.elementId === `${FLOOR_ID}${id}`);
  for (const [id, tooltip] of [
    ['/repos/a#1', '#1 Add a thing'],
    ['/repos/a#2', '#2 Build it. Blocked: waits for 1'],
    ['/repos/a#9', '#9 Asked. Blocked: waits for 2, 3'],
    ['/repos/a@m2', '00:01 Merged one (#10)'],
  ]) {
    assert.equal(tooltipOf(tileOf(id)), tooltip, `${id} carries its tooltip`);
  }
  const [projectA] = floorRows(tree)[0];
  assert.ok([...walk(projectA)].some(([node]) => tooltipOf(node) === 'a'), "the project's name carries its full name as a tooltip");
  const lit = { '/repos/a#1': 'accent', '/repos/a#3': 'working', '/repos/a#9': 'blocked', '/repos/a#5': 'blocked' };
  for (const tile of tiles) {
    const role = lit[tile.elementId.slice(FLOOR_ID.length)];
    assert.deepEqual([called(tile, 'border_color').at(-1)?.[0], called(tile, 'bg').at(-1)?.[0]], role ? [role, `${role}1F`] : ['border', 'raised'],
      `${tile.elementId} is ${role ? `lit in ${role}` : 'plain'}`);
  }

  const tables = nodesOf(tree, 'table');
  assert.equal(tables.length, 1, 'the Floor is one table');
  assert.equal(labelOf(tables[0]), 'Floor', 'the table root is named Floor');
  const heads = inColumnOrder(nodesOf(tree, 'table-header').flatMap((header) => nodesOf(header, 'table-head')));
  assert.deepEqual(heads.map((head) => head.index), [1, 2, 3, 4, 5, 6], 'six header columns');
  assert.equal(labelOf(heads[0]), 'Project', 'column 1 is labelled Project');
  assert.deepEqual(heads.slice(1).map(strings), STAGE_NAMES.map((name) => [name]), 'columns 2 to 6 hold the five stage names');
  assert.deepEqual(buttonsIn(tree).map((button) => button.elementId).sort(),
    [...ids.map((id) => `${FLOOR_ID}${id}`), `${FLOOR_ID}open-0`, `${FLOOR_ID}open-1`, 'fabraik-queue-view-refresh'].sort(),
    "the Floor's buttons are exactly its card and merged tiles, each project's Open board control and its header's Refresh");
  assert.equal(tileOf('/repos/a@m2').kind, 'button', 'a merged tile is a button');
  assert.deepEqual([...walk(tree)].filter(([node]) => node.keyDown).map(([node]) => node), [tree], "the Floor's one key handler is its root's");
  assert.deepEqual(host.runs, [], 'the Floor runs no Herdr command');
  assert.deepEqual(host.calls, [], 'the Floor runs no queue command');
});

// The sheet tests' expectations are written by hand from the plan's S4 section and card #668's AC 2: a card tile opens
// a dialog named "<folder> card <ref>" over a chrome shade at a 99 alpha; Esc, Close and a press outside close it, and
// focus goes back to the opening tile, or to the Floor where that tile is no longer drawn.
const SHEET_ID = `${FLOOR_ID}sheet`;
const SHEET_CLOSE_ID = `${FLOOR_ID}sheet-close`;
const SHEET_SHOTS_ID = `${FLOOR_ID}sheet-shots`;
const SHEET_CARDS = [floorCard(2, 'Build it', 'Ready'), floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' })];
const sheetCache = (cards) => ({ ...panelCache([]), boards: [floorBoard('a', { cards, merged: [{ sha: 'm2', at: localTime(12, 0, 1), subject: 'Merged one (#10)' }] })] });
const nodeWithId = (tree, id) => [...walk(tree)].map(([node]) => node).find((node) => node.elementId === id);
const cardTileOf = (tree, card) => floorTiles(tree).find((tile) => tile.elementId === `${FLOOR_ID}/repos/a#${card}`);
const hasShade = (tree) => [...walk(tree)].some(([node]) => called(node, 'bg').some(([colour]) => colour === 'chrome99'));
const trackedFocused = (node) => called(node, 'track_focus').at(-1)?.[0]?.is_focused() === true;
const onlyRefreshes = (host) => ran(host).every(({ args }) => args[1] === 'refresh');

test('a Floor card is a button that opens its sheet over a shade', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const host = await floorScene(sheetCache(SHEET_CARDS));
  await host.click(cardTileOf(host.render(), 2));
  const tree = host.render();
  const sheet = nodeWithId(tree, SHEET_ID);
  assert.ok(sheet, 'a click on a card tile draws its sheet');
  assert.equal(called(sheet, 'role').at(-1)?.[0], 'dialog', 'the sheet is a dialog');
  assert.equal(labelOf(sheet), 'a card #2', 'the sheet is named by its folder and card');
  assert.ok(hasShade(tree), 'a chrome shade at a 99 alpha is drawn behind the sheet');
  assert.ok(trackedFocused(sheet), 'focus moves into the sheet');
  const cardTiles = floorTiles(tree).filter((tile) => tile.elementId.includes('#'));
  assert.equal(cardTiles.length, 2, 'both card tiles are drawn');
  for (const tile of cardTiles) {
    assert.equal(tile.click, null, `${tile.elementId} takes no press while the sheet is open`);
    assert.equal(called(tile, 'tab_stop').at(-1)?.[0], false, `${tile.elementId} is no tab stop while the sheet is open`);
  }
  assert.ok(called(cardTileOf(tree, 2), 'track_focus').at(-1)?.[0], 'the opening tile tracks a handle');
  assert.deepEqual(host.runs, [], 'opening runs no Herdr command');
  assert.ok(onlyRefreshes(host), 'opening runs no queue command but a refresh');
});

test('Esc, Close and a press outside each close the Floor sheet and give focus back to the card that opened it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const host = await floorScene(sheetCache(SHEET_CARDS));
  const closers = /** @type {[string, () => unknown][]} */ ([
    ['Esc', () => host.press('escape')],
    ['Close', () => host.click(nodeWithId(host.render(), SHEET_CLOSE_ID))],
    ['a press outside', () => called(nodeWithId(host.render(), SHEET_ID), 'on_mouse_down_out').at(-1)[0]({}, host.cx)],
  ]);
  for (const [name, close] of closers) {
    await host.click(cardTileOf(host.render(), 2));
    await host.press('c');
    assert.ok(nodeWithId(host.render(), SHEET_ID), `before ${name}, c leaves the sheet open`);
    await close();
    const tree = host.render();
    assert.equal(nodeWithId(tree, SHEET_ID), undefined, `${name} closes the sheet`);
    assert.ok(!hasShade(tree), `${name} removes the shade`);
    assert.ok(trackedFocused(cardTileOf(tree, 2)), `${name} gives focus back to the card that opened the sheet`);
  }
  assert.deepEqual(host.runs, [], 'the sheet runs no Herdr command');
  assert.ok(onlyRefreshes(host), 'the sheet runs no queue command but a refresh');
});

test('a Floor sheet whose card is no longer drawn gives focus back to the Floor when it closes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const host = await floorScene(sheetCache(SHEET_CARDS));
  await host.click(cardTileOf(host.render(), 2));
  host.setCache(sheetCache(SHEET_CARDS.filter((card) => card.card !== 2)));
  await host.panel.load();
  await host.press('escape');
  assert.ok(trackedFocused(host.render()), 'the handle the Floor page tracks is focused');
});

// The slide's expectations are written by hand from the owner's decision: the sheet slides in from the right over about
// 150 ms and closes at once. Herdr animates only a later change, so each opening draws the panel off the sheet's right
// edge first, then at offset 0, and an earlier opening's wait never ends a later opening's first draw.
const SHEET_PANEL_ID = `${FLOOR_ID}sheet-panel`;

test('a Floor sheet slides in from the right and closes at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const host = await floorScene(sheetCache(SHEET_CARDS));
  const panelOf = () => nodeWithId(host.render(), SHEET_PANEL_ID);
  const slide = { duration: 150, easing: 'ease-out' };

  const opening = host.click(cardTileOf(host.render(), 2));
  assert.equal(called(nodeWithId(host.render(), SHEET_ID), 'bg').length, 0, 'the clipping sheet itself has no fill');
  assert.deepEqual(called(panelOf(), 'left').at(-1), [420], 'the first draw is the panel off the sheet right edge');
  assert.deepEqual(called(panelOf(), 'transition').at(-1), ['left', slide], 'the panel transitions its left offset over 150 ms, ease-out');
  await opening;
  assert.deepEqual(called(panelOf(), 'left').at(-1), [0], 'after the wait the panel is drawn at offset 0');
  assert.deepEqual(called(panelOf(), 'transition').at(-1), ['left', slide], 'the transition stays on the panel');
  await host.press('escape');
  const closed = host.render();
  assert.equal(nodeWithId(closed, SHEET_ID), undefined, 'Esc removes the sheet at once');
  assert.equal(nodeWithId(closed, SHEET_PANEL_ID), undefined, 'Esc removes the panel at once');

  // A close and quick reopen: each wait is held by the test, so the first opening's wait ends while the second is open.
  const gates = [];
  host.cx.sleep = () => new Promise((resolve) => gates.push(resolve));
  const first = host.click(cardTileOf(host.render(), 2));
  await host.press('escape');
  const second = host.click(cardTileOf(host.render(), 2));
  assert.equal(gates.length, 2, 'each opening waits once');
  gates[0]();
  await first;
  assert.deepEqual(called(panelOf(), 'left').at(-1), [420], 'an earlier opening wait does not end the later opening first draw');
  gates[1]();
  await second;
  assert.deepEqual(called(panelOf(), 'left').at(-1), [0], 'the later opening wait moves its own panel');
});

// The sheet's content tests: every expected line is written by hand from the plan's S6 "Lines" list for each fixture,
// never read off the panel, and each is read from the sheet's own strings. Opening a sheet clicks its card's tile.
const sheetKey = (card, project = 'a') => `/repos/${project}#${card}`;
const sheetTileOf = (host, key) => floorTiles(host.render()).find((tile) => tile.elementId === `${FLOOR_ID}${key}`);
const sheetLines = (host) => strings(nodeWithId(host.render(), SHEET_ID));
const putAside = (host, card) => itemButtons(host.render(), keyOf(card)).filter((button) => nameOf(button) === 'Put aside');

function assertLines(shown, expected, absent, why) {
  for (const line of expected) assert.ok(shown.includes(line), `${why}: ${line} is drawn: ${shown.join(' | ')}`);
  for (const line of absent) assert.ok(!shown.includes(line), `${why}: ${line} is not drawn: ${shown.join(' | ')}`);
}

test('ANTI-REGRESSION: a question names its holding computer when readable and routes its answer to chat', async () => {
  const views = {
    'the Decisions view': async (item) => {
      const panel = await loadPanel(OK);
      await panel.click(named(panel.render(), 'Decisions'));
      const host = await loadPanel(OK, panel.overlays[0].props);
      await reload(host, [item]);
      return host.render();
    },
    'the Floor side sheet': async (item) => {
      const host = await floorScene({ ...panelCache([item]), boards: [floorBoard('a', { cards: [floorCard(item.card, 'Held card', 'In progress')] })] });
      await host.click(sheetTileOf(host, sheetKey(item.card)));
      return nodeWithId(host.render(), SHEET_ID);
    },
  };
  const holder = 'machine-b';
  const sentences = new Set([
    heldLine(holder),
    HELD_UNREAD_LINE,
    `This question is held by the lead on ${holder}, so it is answered in chat, not here.`,
    'The computer whose lead holds this question could not be read, so it is answered in chat, not here.',
  ]);
  const questionLines = (tree) => strings(tree).filter((line) => sentences.has(line));
  for (const [view, render] of Object.entries(views)) {
    for (const [why, fields, line] of [
      ['waiting on another computer', { heldOn: holder }, heldLine(holder)],
      ['whose holding computer was not read', undefined, HELD_UNREAD_LINE],
      ['whose saved computer name is blank', { heldOn: '   ' }, HELD_UNREAD_LINE],
      ['whose saved computer name is not text', { heldOn: {} }, HELD_UNREAD_LINE],
    ]) {
      const tree = await render(queueItem('question', 7, fields));
      assert.deepEqual(questionLines(tree), [line], `a question ${why}, in ${view}`);
      assert.deepEqual(nodesOf(tree, 'input'), [], `a question ${why} is answered in chat, in ${view}`);
    }
    const answerable = await render(queueItem('question', 6, { answerable: true, heldOn: holder }));
    assert.deepEqual(questionLines(answerable), [], `a legacy answerable question, in ${view}`);
    assert.deepEqual(nodesOf(answerable, 'input').map((box) => box.state.placeholder), ['Your answer for a'],
      `the legacy answer box, in ${view}`);
    assert.ok(buttonsIn(answerable).some((button) => labelOf(button) === sendName(6)), `Send answer, in ${view}`);
  }
});

test('a Floor sheet shows its card outcome, stage, blockers, lead, agent and what it waits on from the latest read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const boards = [
    floorBoard('a', {
      cards: [
        floorCard(2, 'Build it', 'Ready', { blockers: [1], outcome: { text: 'Show the sheet.', more: true } }),
        floorCard(3, 'Review it', 'In review', { claim: { machine: 'omarchy', runtime: 'Codex' }, outcome: null }),
        floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge', outcome: { unread: 'a code fence is left open' } }),
        floorCard(9, 'Plain card', 'In progress'),
        floorCard(4, 'Unsure', 'Ready', { unread: 'comments unavailable' }),
      ],
    }),
    floorBoard('b', { waitsOnUnread: ['worktrees'], cards: [floorCard(7, 'Partly read', 'In progress', { worktree: undefined })] }),
  ];
  const host = await floorScene({ ...panelCache([queueItem('merge', 5)]), boards });
  const predates = "Outcome not read: this project's queue reader predates it";
  for (const { key, lines, absent = [] } of [
    { key: sheetKey(2), lines: ['Build it', 'Show the sheet.', 'The card text goes on past this paragraph.', 'Stage: Ready to build', 'Blocked: waits for 1',
      'No Herdr space for this project', 'Not claimed', 'Nothing here waits on you'], absent: [predates] },
    { key: sheetKey(3), lines: ['Review it', 'No What to build section in the card text', 'Stage: Building, merging', 'No open blockers',
      'No Herdr space for this project', 'Claimed on omarchy in Codex', 'Nothing here waits on you'], absent: [predates, 'Not claimed'] },
    { key: sheetKey(5), lines: ['Ship it', 'Outcome not read: a code fence is left open', 'Stage: Awaiting your yes', 'No open blockers',
      'No Herdr space for this project', 'Not claimed', 'Merge awaiting your yes'], absent: ['Nothing here waits on you'] },
    { key: sheetKey(9), lines: ['Plain card', predates, 'Stage: Building', 'No open blockers', 'No Herdr space for this project', 'Not claimed', 'Nothing here waits on you'] },
    { key: sheetKey(4), lines: ['Unsure', 'Details not read: comments unavailable', 'Stage: Ready to build', 'No open blockers', 'No Herdr space for this project'],
      absent: [predates, 'Not claimed', 'Nothing here waits on you'] },
    { key: sheetKey(7, 'b'), lines: ['Partly read', 'Stage: Building', 'What cards wait on not read: worktrees', 'Agent not matched: the worktree list was not read'],
      absent: ['Nothing here waits on you'] },
  ]) {
    await host.click(sheetTileOf(host, key));
    assertLines(sheetLines(host), lines, absent, key);
    if (key === sheetKey(5)) buttonOf(host.render(), keyOf(5), 'Put aside');
    await host.press('escape');
  }

  const worktree = worktreeIn('a', 6);
  const working = await agentScene([floorBoard('a', { cards: [floorCard(6, 'Building card', 'In progress', { worktree })] })],
    [agentTerminal('t1', { live: worktree, state: 'working' })]);
  await working.click(sheetTileOf(working, sheetKey(6)));
  assertLines(sheetLines(working), ['Building card', 'Stage: Building', 'Claude: Building now', 'Nothing here waits on you'], ['Not claimed'], 'card 6');
});

test('a Floor sheet follows its card to the latest read and names a card that left the Floor or the board', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const read = (cards, items = [], fields) => ({ ...panelCache(items), boards: [floorBoard('a', { cards, ...fields })] });
  const host = await floorScene(read([floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' })], [queueItem('merge', 5)]));
  await host.click(sheetTileOf(host, sheetKey(5)));
  assertLines(sheetLines(host), ['Stage: Awaiting your yes', 'Merge awaiting your yes'], ['Nothing here waits on you'], 'at the opening read');
  assert.equal(putAside(host, 5).length, 1, 'at the opening read the sheet draws Put aside');

  const hasStage = () => sheetLines(host).some((line) => line.startsWith('Stage: '));
  host.setCache(read([floorCard(5, 'Ship it', 'In progress')]));
  await host.panel.load();
  assertLines(sheetLines(host), ['Stage: Building', 'Nothing here waits on you'], ['Stage: Awaiting your yes', 'Merge awaiting your yes'], 'in progress with no item');
  assert.equal(putAside(host, 5).length, 0, 'a card with no item has no Put aside');

  const quiet = 'Nothing here waits on you';
  for (const [why, cache, line, waitsOnNothing = false] of [
    ['in Backlog', read([floorCard(5, 'Ship it', 'Backlog')]), 'Not on the Floor now: the card is in Backlog', true],
    ['gone from the board', read([floorCard(2, 'Build it', 'Ready')]), 'Not on the board now: this read lists no open card #5 in a, so it has closed or left the board'],
    ['on an unreadable board', read([], [], { unreadable: 'the board read failed' }), 'Board unreadable: the board read failed'],
    ['in a format 1 cache', { ...read([floorCard(5, 'Ship it', 'Awaiting push')]), format: 1 }, 'Card not shown: the queue cache is unreadable: it is not a format 2 queue cache'],
  ]) {
    host.setCache(cache);
    await host.panel.load();
    assertLines(sheetLines(host), waitsOnNothing ? [line, quiet] : [line], waitsOnNothing ? [] : [quiet], why);
    assert.ok(!hasStage(), `${why}: no stage line is drawn`);
    assert.equal(putAside(host, 5).length, 0, `${why}: no Put aside is drawn`);
  }

  // Opening a sheet reads the card's current state: the loaded read counts as current only where it began at or after the
  // opening. EARLIER is before any run of the suite; a newer cache arrives only from the exec stub standing in for the
  // queue.mjs refresh, never from the test once the Floor is drawn.
  const EARLIER = '2026-11-01T00:00:00.000Z';
  const reading = "Reading this card's current state. Until that read lands, this is the earlier read.";
  const refreshCall = queueCall('refresh', terminalList([]));
  const cacheA = { ...read([floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' })], [queueItem('merge', 5)]), readStartedAt: EARLIER };
  const cacheB = (fields) => ({ ...read([floorCard(5, 'Ship it', 'In progress')]), readStartedAt: new Date().toISOString(), ...fields });
  const openCard5 = (scene) => scene.click(sheetTileOf(scene, sheetKey(5)));

  // 1. The read lands after the opening: the sheet says it is reading over the earlier read, then follows the new one.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const changed = await floorScene(cacheA, async () => { await gate; changed.setCache(cacheB()); return OK; });
  const opening = openCard5(changed);
  assertLines(sheetLines(changed), [reading, 'Stage: Awaiting your yes'], [], 'changed before opening, while it reads');
  release();
  await opening;
  assertLines(sheetLines(changed), ['Stage: Building', quiet], [reading, 'Stage: Awaiting your yes'], 'changed before opening, once it landed');
  assert.equal(putAside(changed, 5).length, 0, 'changed before opening: no Put aside is drawn');
  assert.deepEqual(ran(changed), [refreshCall], 'changed before opening: opening runs one refresh');

  // 2. A refresh already running at the opening is not the read that was asked for, so one more runs.
  let calls = 0;
  const running = await floorScene(cacheA, async () => {
    calls += 1;
    if (calls === 2) running.setCache(cacheB());
    return OK;
  });
  await running.task((cx) => {
    running.panel.refresh(cx);
    sheetTileOf(running, sheetKey(5)).click({}, cx);
  });
  assert.deepEqual(ran(running), [refreshCall, refreshCall], 'a refresh running at opening: a second refresh runs');
  assertLines(sheetLines(running), ['Stage: Building', quiet], [reading], 'a refresh running at opening');

  // 3. A failed read says so, above the earlier read.
  const failed = await floorScene(cacheA, { code: 1, stdout: '', stderr: 'the tracker could not be reached\n' });
  await openCard5(failed);
  assertLines(sheetLines(failed), ['Current state not read: the tracker could not be reached. This is the earlier read.', 'Stage: Awaiting your yes'], [reading], 'a failed read');

  // 4. A read begun before the opening and written after this copy's is not current.
  const older = await floorScene(cacheA, async () => {
    older.setCache(cacheB());
    older.setCache(cacheA);
    return OK;
  });
  await openCard5(older);
  assertLines(sheetLines(older), [
    'Current state not read: a read begun before this sheet opened finished last. Reopen the sheet to read again; this is the earlier read.',
    'Stage: Awaiting your yes',
  ], [reading], 'an older read lands last');
  assert.deepEqual(ran(older), [refreshCall], 'an older read lands last: one refresh runs');

  // 5. A read time the panel cannot trust: none, or one later than now.
  for (const [why, fields] of [['with no read start', { readStartedAt: undefined }], ['with a read start later than now', { readStartedAt: '2999-01-01T00:00:00.000Z' }]]) {
    const untrusted = await floorScene(cacheA, async () => { untrusted.setCache(cacheB(fields)); return OK; });
    await openCard5(untrusted);
    assertLines(sheetLines(untrusted), ['Current state not confirmed: this read gives no start time the panel can trust.', 'Stage: Building'], [reading], `a read ${why}`);
  }
});

test('a Floor sheet answers through the same command as the queue and names a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const refusal = 'card 5 changed since the panel drew it: refresh the queue';
  /** @type {ExecResult | Promise<ExecResult>} */
  let answer = OK;
  const cache = { ...panelCache([queueItem('merge', 5)]), boards: [floorBoard('a', { cards: [floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' })] })] };
  const host = await floorScene(cache, () => answer);
  await host.click(sheetTileOf(host, sheetKey(5)));
  answer = { code: 1, stdout: '', stderr: `${refusal}\n` };
  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  assert.deepEqual(ran(host).filter(({ args }) => args[1] === 'act'), [queueCall('act', keyOf(5), 'park', versionOf(5))], 'the sheet runs the queue command');
  const shown = sheetLines(host);
  assert.ok(shown.includes(`Put aside failed: ${refusal}`), `the refusal names its button: ${shown.join(' | ')}`);
  assert.ok(!shown.includes('Put aside; the queue confirms on its next read'), 'a refused answer leaves no receipt');
});

// The Tab test's steps are written by hand from the plan's S10 section and card #668's AC 2 and AC 4: with the sheet open,
// Tab and Shift+Tab go through its controls in Herdr's order, Close first, and wrap at both ends whatever its body draws. The
// scripted window stands in for Herdr's order, which the plan's probes checked live.
const SHEET_END_ID = `${FLOOR_ID}sheet-end`;

test('the open Floor sheet keeps Tab and Shift-Tab inside itself, wrapping at its ends, whatever its body', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  /** @type {ExecResult | Promise<ExecResult>} */
  let answer = OK;
  const cache = { ...panelCache([queueItem('merge', 5)]), boards: [floorBoard('a', { cards: [floorCard(5, 'Ship it', 'Awaiting push', { waitsOn: 'merge' })] })] };
  const host = await floorScene(cache, () => answer);

  // The scripted window: each move records its direction and where focus was, then focus goes where `lands` says.
  /** @type {{ focus: () => void } | null} */
  let lands = null;
  const moves = [];
  const moveTo = (direction) => () => { moves.push([direction, focusedName()]); assert.ok(lands, 'the test says where focus lands'); lands.focus(); };
  // @ts-expect-error a scripted window stands in for Herdr's
  globalThis.window = { focus_next: moveTo('next'), focus_prev: moveTo('prev') };
  // @ts-expect-error the scripted window is removed again
  t.after(() => { delete globalThis.window; });

  await host.click(sheetTileOf(host, sheetKey(5)));
  const opened = host.render();
  const handleOf = (node, why) => {
    const handle = called(node, 'track_focus').at(-1)?.[0];
    assert.ok(handle && typeof handle.focus === 'function', `${why} tracks a focus handle`);
    return handle;
  };
  const sheet = handleOf(nodeWithId(opened, SHEET_ID), 'the sheet');
  const close = handleOf(nodeWithId(opened, SHEET_CLOSE_ID), 'Close');
  const end = handleOf(nodeWithId(opened, SHEET_END_ID), 'the end stop');
  const control = host.cx.focus_handle();
  const handleNames = new Map([[sheet, 'sheet'], [close, 'Close'], [end, 'end stop'], [control, 'control']]);
  assert.equal(handleNames.size, 4, 'the sheet, Close, the end stop and a body control are four handles');
  const focusedName = () => {
    const focused = host.handles.filter((handle) => handle.is_focused());
    assert.ok(focused.length <= 1, `at most one handle holds focus, found ${focused.length}`);
    return focused.length === 0 ? 'none' : handleNames.get(focused[0]) ?? 'another handle';
  };

  // The end stop is the last child of the panel, drawn after whatever the body draws, and Close tracks its handle.
  const ends = (why) => {
    const tree = host.render();
    assert.equal(called(nodeWithId(tree, SHEET_CLOSE_ID), 'track_focus').at(-1)?.[0], close, `${why}: Close tracks its handle`);
    const last = nodeWithId(tree, SHEET_PANEL_ID).kids.at(-1);
    assert.equal(last?.elementId, SHEET_END_ID, `${why}: the last child of the panel is the end stop`);
    assert.equal(called(last, 'track_focus').at(-1)?.[0], end, `${why}: the end stop tracks its handle`);
    assert.deepEqual(called(last, 'tab_stop').at(-1), [true], `${why}: the end stop is a tab stop`);
    assert.deepEqual(last.kids, [], `${why}: the end stop draws nothing`);
  };

  // A press of Tab or Shift+Tab reaches the sheet as the action its binding names.
  const tab = (keystroke) => {
    const action = keystroke === 'shift-tab' ? 'fabraik-queue-sheet-prev' : 'fabraik-queue-sheet-next';
    const found = called(nodeWithId(host.render(), SHEET_ID), 'on_action').find(([name]) => name === action);
    assert.ok(found, `the sheet handles ${action}`);
    found[1]({ action }, host.cx);
  };
  const press = (start, landsOn, keystroke) => {
    start.focus();
    moves.length = 0;
    lands = landsOn;
    tab(keystroke);
    return { moves: [...moves], focused: focusedName() };
  };

  // 1. Body one, the decision card.
  buttonOf(host.render(), keyOf(5), 'Put aside');
  ends('the decision card');
  assert.equal(focusedName(), 'sheet', 'opening puts focus on the sheet');
  for (const [number, start, landsOn, keystroke, asked, after] of [
    [1, sheet, close, 'tab', [['next', 'sheet']], 'Close'],
    [2, close, control, 'tab', [['next', 'Close']], 'control'],
    [3, control, end, 'tab', [['next', 'control']], 'Close'],
    [4, close, control, 'shift-tab', [['prev', 'end stop']], 'control'],
    [5, control, close, 'shift-tab', [['prev', 'control']], 'Close'],
    [6, sheet, control, 'shift-tab', [['prev', 'end stop']], 'control'],
    [7, end, control, 'tab', [], 'Close'],
  ]) {
    assert.deepEqual(press(start, landsOn, keystroke), { moves: asked, focused: after }, `step ${number}: ${keystroke} from ${handleNames.get(start)}`);
  }
  assert.equal(host.stopped, 7, 'each press stops there, so Herdr takes no step of its own');
  assert.deepEqual(host.bindings, [
    { keystroke: 'tab', action: 'fabraik-queue-sheet-next', context: 'FabraikQueueSheet' },
    { keystroke: 'shift-tab', action: 'fabraik-queue-sheet-prev', context: 'FabraikQueueSheet' },
  ], 'the sheet binds Tab and Shift+Tab to its own actions');
  assert.deepEqual(called(nodeWithId(host.render(), SHEET_ID), 'key_context').at(-1), ['FabraikQueueSheet'], 'the sheet is the context those bindings name');

  // 2 to 6. Each later body draws its line and the same end stop.
  const lineIs = (line, why) => assert.ok(sheetLines(host).includes(line), `${why}: ${line} is drawn: ${sheetLines(host).join(' | ')}`);
  const refusal = 'card 5 changed since the panel drew it: refresh the queue';
  answer = { code: 1, stdout: '', stderr: `${refusal}\n` };
  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  lineIs(`Put aside failed: ${refusal}`, 'a refusal');
  ends('a refusal');

  answer = OK;
  await host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
  lineIs('Put aside; the queue confirms on its next read', 'a receipt');
  ends('a receipt');

  const read = (cards, fields) => ({ ...panelCache([]), boards: [floorBoard('a', { cards })], ...fields });
  host.setCache(read([floorCard(5, 'Ship it', 'In progress')]));
  await host.panel.load();
  lineIs('Stage: Building', 'no decision card');
  assert.equal(putAside(host, 5).length, 0, 'no decision card: no Put aside is drawn');
  ends('no decision card');

  // Close is the only control of a card that is gone or not shown, so each press leaves focus on it.
  const gone = 'Not on the board now: this read lists no open card #5 in a, so it has closed or left the board';
  const notShown = 'Card not shown: the queue cache is unreadable: it is not a format 2 queue cache';
  for (const [why, shown, line] of [['gone', read([]), gone], ['not shown', read([], { format: 1 }), notShown]]) {
    host.setCache(shown);
    await host.panel.load();
    lineIs(line, why);
    ends(why);
    assert.deepEqual(press(close, close, 'shift-tab'), { moves: [['prev', 'end stop']], focused: 'Close' }, `${why}: Shift+Tab from Close`);
    assert.deepEqual(press(close, end, 'tab'), { moves: [['next', 'Close']], focused: 'Close' }, `${why}: Tab from Close`);
  }
});

// The steps are written by hand from the plan's S11 section, card #668's AC 2 and AC 4 and the drive in which Undo
// stranded the keyboard. The stand-in handle is the control a press replaces; the sheet's own handle is where opening
// leaves the keyboard, from which the drives showed Esc and Tab work.
test('the open Floor sheet takes the keyboard when a press replaces the control holding it, unless Close holds it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  /** @type {ExecResult | Promise<ExecResult>} */
  let answer = OK;
  const waiting = (version) => ({ ...sheetCache(SHEET_CARDS), items: [queueItem('merge', 5, { version })] });
  const host = await floorScene({ ...sheetCache(SHEET_CARDS), items: [queueItem('failure', 5)] }, () => answer);
  await host.click(cardTileOf(host.render(), 5));
  const close = called(nodeWithId(host.render(), SHEET_CLOSE_ID), 'track_focus').at(-1)[0];
  const control = host.cx.focus_handle();
  const holder = () => {
    const tree = host.render();
    const holds = [['sheet', trackedFocused(nodeWithId(tree, SHEET_ID))], ['Close', trackedFocused(nodeWithId(tree, SHEET_CLOSE_ID))], ['control', control.is_focused()]];
    return holds.find(([, held]) => held)?.[0] ?? 'none';
  };

  const refusal = 'card 5 changed since the panel drew it: refresh the queue';
  const refused = { code: 1, stdout: '', stderr: `${refusal}\n` };
  const line = (text) => () => assert.ok(sheetLines(host).includes(text), `${text} is drawn: ${sheetLines(host).join(' | ')}`);
  const button = (name) => () => buttonOf(host.render(), keyOf(5), name);
  const starts = { control, Close: close };

  // 1 to 6. Each press starts with the keyboard on one handle and ends with it where the press leaves it. Steps 1 to 4
  // press a failure's Dismiss, whose receipt replaces it with Undo; a read then swaps the failure for a merge, whose
  // Put aside steps 5 and 6 press.
  const pressFrom = async (/** @type {any[]} */ [number, start, name, result, after, drawn]) => {
    answer = result;
    starts[start].focus();
    await host.click(buttonOf(host.render(), keyOf(5), name));
    assert.equal(holder(), after, `step ${number}: ${name} with the keyboard on ${start}`);
    drawn();
  };
  for (const step of [
    [1, 'control', 'Dismiss', OK, 'sheet', line('Dismissed')],
    [2, 'control', 'Undo', OK, 'sheet', button('Dismiss')],
    [3, 'Close', 'Dismiss', OK, 'Close', line('Dismissed')],
    [4, 'Close', 'Undo', OK, 'Close', button('Dismiss')],
  ]) await pressFrom(step);
  host.setCache(waiting(versionOf(5)));
  await host.panel.load();
  for (const step of [
    [5, 'control', 'Put aside', refused, 'sheet', line(`Put aside failed: ${refusal}`)],
    [6, 'control', 'Put aside', OK, 'sheet', line('Put aside; the queue confirms on its next read')],
  ]) await pressFrom(step);

  // An answer that lands after its press: `meanwhile` runs between the press and the answer.
  const lands = async (meanwhile) => {
    let land;
    answer = new Promise((resolve) => { land = resolve; });
    const pressed = host.click(buttonOf(host.render(), keyOf(5), 'Put aside'));
    answer = OK;
    await meanwhile();
    land(OK);
    await pressed;
  };

  // 7. The sheet is closed when the answer lands: the keyboard stays on the tile Esc gave it to.
  host.setCache(waiting(CHANGED));
  await host.panel.load();
  await lands(() => host.press('escape'));
  assert.ok(trackedFocused(cardTileOf(host.render(), 5)), 'step 7: an answer landing after the sheet closed leaves the keyboard on the tile');

  // 8. The sheet shows another card when the answer lands: the keyboard stays where the test put it.
  host.setCache(waiting('e'.repeat(64)));
  await host.panel.load();
  await host.click(cardTileOf(host.render(), 5));
  await lands(async () => {
    await host.press('escape');
    await host.click(cardTileOf(host.render(), 2));
    control.focus();
  });
  assert.equal(holder(), 'control', 'step 8: an answer landing after the sheet moved to another card leaves the keyboard alone');

  // The Decisions view has no sheet: a press there moves no keyboard.
  const decisions = await decisionsScene(panelCache([queueItem('failure', 5)]));
  await decisions.click(buttonOf(decisions.render(), keyOf(5), 'Dismiss'));
  assert.ok(strings(decisions.render()).includes('Dismissed'), 'the Decisions view draws the receipt');
  await decisions.click(buttonOf(decisions.render(), keyOf(5), 'Undo'));
  buttonOf(decisions.render(), keyOf(5), 'Dismiss');
  assert.ok(decisions.handles.every((handle) => !handle.is_focused()), 'the Decisions view gives the keyboard to no handle');
});

// The steps are written by hand from the plan's S12 section and card #668's AC 2. A read replaces the controls of the
// sheet's card exactly as a press does, without a press: a version that left the cache releases the change box, and a
// removed item drops every body control, so the keyboard is stranded unless the sheet takes it.
test('the open Floor sheet takes the keyboard when a read changes or removes the answers of its card, unless Close holds it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const waiting = (version, ...others) => ({ ...sheetCache(SHEET_CARDS), items: [queueItem('merge', 5, { version }), ...others] });
  const host = await floorScene(waiting(versionOf(5)));
  await host.click(cardTileOf(host.render(), 5));
  const close = called(nodeWithId(host.render(), SHEET_CLOSE_ID), 'track_focus').at(-1)[0];
  const control = host.cx.focus_handle();
  const holder = () => {
    const tree = host.render();
    const holds = [['sheet', trackedFocused(nodeWithId(tree, SHEET_ID))], ['Close', trackedFocused(nodeWithId(tree, SHEET_CLOSE_ID))], ['control', control.is_focused()]];
    return holds.find(([, held]) => held)?.[0] ?? 'none';
  };
  const second = 'e'.repeat(64);
  const third = 'd'.repeat(64);

  // 1 to 5. Each read starts with the keyboard on one handle and ends with it where the read leaves it.
  for (const [number, start, cache, after, why] of [
    [1, control, waiting(CHANGED), 'sheet', 'a new version of the sheet card item'],
    [2, close, waiting(second), 'Close', 'a new version of the sheet card item, with Close holding'],
    [3, control, waiting(second), 'control', 'the same cache again'],
    [4, control, waiting(second, queueItem('merge', 2, { version: versionOf(2) })), 'control', 'an item added for another card'],
    [5, control, { ...sheetCache(SHEET_CARDS), items: [] }, 'sheet', 'no item for the sheet card'],
  ]) {
    start.focus();
    host.setCache(cache);
    await host.panel.load();
    assert.equal(holder(), after, `step ${number}: ${why}`);
  }

  // 6. A read while the sheet is closed leaves the keyboard on the tile Esc gave it to.
  host.setCache(waiting(second));
  await host.panel.load();
  await host.press('escape');
  assert.ok(trackedFocused(cardTileOf(host.render(), 5)), 'step 6: Esc gives the keyboard to the tile');
  host.setCache(waiting(third));
  await host.panel.load();
  assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, 'step 6: the closed sheet is not drawn again by a read');
  assert.ok(trackedFocused(cardTileOf(host.render(), 5)), 'step 6: a read while the sheet is closed leaves the keyboard on the tile');
});

test('a focused tile or outlined control gains a foreground border and a focused solid button turns to the accent fill', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  // Each focus declare applied to a fresh element, as the kit applies it while the element has focus.
  const declared = (node) => called(node, 'focus').flatMap(([declare]) => {
    const style = element('div');
    declare(style);
    return style.calls;
  });
  const sets = (calls, name, value) => calls.some(([found, args]) => found === name && args[0] === value);
  const host = await floorScene(sheetCache(SHEET_CARDS));
  await host.click(cardTileOf(host.render(), 2));
  const tree = host.render();
  const answers = await decisionsScene(panelCache([queueItem('merge', 5)]));
  for (const [name, node] of [['the tile of card 2', cardTileOf(tree, 2)], ["the sheet's Close", nodeWithId(tree, SHEET_CLOSE_ID)], ['the send control', named(answers.render(), sendName(5))]]) {
    assert.ok(sets(declared(node), 'border_color', 'foreground'), `${name} gains a foreground border when focused`);
    assert.notEqual(called(node, 'border_color').at(-1)?.[0], 'foreground', `${name} rests without a foreground border`);
  }

  // Show me first is a kit Toggle, which honours state styles: its focus border draws, and its hover tint only while the
  // control is off and enabled.
  const board = await boardScene('/repos/a', moveCache(SHOW_CARDS));
  const boardTree = board.render();
  const hovered = (node) => called(node, 'hover').flatMap(([declare]) => {
    const style = element('div');
    declare(style);
    return style.calls;
  });
  await board.click(titleOf(boardTree, 6));
  for (const [name, node] of [["card 6's Board control", switchOf(boardTree, 6)], ["card 6's sheet control", sheetSwitchOf(board.render())]]) {
    assert.ok(sets(declared(node), 'border_color', 'foreground'), `${name} gains a foreground border when focused`);
    assert.notEqual(called(node, 'border_color').at(-1)?.[0], 'foreground', `${name} rests without a foreground border`);
  }
  assert.ok(sets(hovered(switchOf(boardTree, 6)), 'bg', 'hover'), "card 6's control, off and enabled, tints to the hover fill");
  assert.deepEqual(hovered(switchOf(boardTree, 4)), [], "card 4's control, on, declares no hover");

  const decisions = await decisionsScene(panelCache([queueItem('failure', 5)]));
  const solid = buttonOf(decisions.render(), keyOf(5), 'Dismiss');
  assert.deepEqual([called(solid, 'bg').at(-1)?.[0], called(solid, 'border_color').at(-1)?.[0]], ['solid', 'solid'], 'a solid button rests solid, its outline included');
  const focused = declared(solid);
  for (const [name, value] of [['bg', 'accent'], ['border_color', 'accent'], ['text_color', 'accent_foreground']]) {
    assert.ok(sets(focused, name, value), `a focused solid button sets ${name} to ${value}`);
  }
});

test('the Floor draws an unreadable project as its own row with its cause, never an empty row, and names each part it could not read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const boards = [
    { repository: '/repos/c', folder: '/repos/c', unreadable: 'the board read failed' },
    floorBoard('d', { cards: 'none' }),
    floorBoard('e', { cards: [floorCard(1, 5, 'Ready')] }),
    null,
    floorBoard('f', {
      orderUnread: 'a card was recovered from the issue list',
      waitsOnUnread: ['approvals'],
      merged: null,
      cards: [
        floorCard(1, 'Odd', 'Triage'),
        { card: 2, title: 'Half', column: 'Ready', blockers: [], worktree: null, unread: 'comments unavailable' },
        floorCard(3, 'Asked', 'In progress', { waitsOn: 'question' }),
      ],
    }),
    // The cache text leaves an undefined key out, so g has no `merged`.
    floorBoard('g', { merged: undefined }),
    floorBoard('h', { merged: [{ sha: 5 }] }),
    // A repeated card identity, as a number or as its text, makes the board unreadable rather than counting one card twice.
    floorBoard('i', { cards: [floorCard(1, 'Twice', 'Ready', { waitsOn: 'question' }), floorCard(1, 'Twice', 'Ready', { waitsOn: 'question' })] }),
    floorBoard('j', { cards: [floorCard(1, 'Twice', 'Ready', { waitsOn: 'question' }), floorCard('1', 'Twice', 'Ready', { waitsOn: 'question' })] }),
    floorBoard('k', { cards: [floorCard(1, 'Odd outcome', 'Ready', { outcome: { text: 7, more: false } })] }),
  ];
  const host = await floorScene({ ...panelCache([]), boards });
  const tree = host.render();
  assert.deepEqual(floorGrid(tree), [
    [['c', 'Open board'], ['Board unreadable: the board read failed']],
    [['d', 'Open board'], [UNREADABLE_ENTRY]],
    [['e', 'Open board'], [UNREADABLE_ENTRY]],
    [
      ['f', 'At least 1 need you', 'Order not read: a card was recovered from the issue list', 'What cards wait on not read: approvals',
        'Details not read: cards #2', 'Card #1 is in Triage, which has no stage here', 'Open board'],
      [],
      ['#2', 'Half'],
      ['Blocking question', '#3', 'Asked'],
      [],
      ['Merges not read'],
    ],
    [['g', 'Nothing for you', 'Open board'], [], [], [], [], ['Merges not in this read']],
    [['h', 'Nothing for you', 'Open board'], [], [], [], [], ['Merges unreadable: an entry is not one this view can read']],
    [['i', 'Open board'], [UNREADABLE_ENTRY]],
    [['j', 'Open board'], [UNREADABLE_ENTRY]],
    [['k', 'Open board'], [UNREADABLE_ENTRY]],
  ], 'an unreadable project is its name and its cause, and a readable one names each part it could not read');
  const entryProblem = 'Problem: board entry 4 is not one this view can read';
  assert.ok(strings(tree).includes(entryProblem), `an entry with no project is a problem line: ${strings(tree).join(' | ')}`);
  assert.ok(!nodesOf(tree, 'table').some((table) => strings(table).includes(entryProblem)), 'the problem line is above the grid, not in it');

  const stale = await floorScene({
    ...panelCache([]),
    refreshedAt: localTime(11, 12),
    boards: [floorBoard('k', { merged: [{ sha: 'k1', at: localTime(11, 8), subject: 'Merged yesterday (#3)' }] })],
  });
  assert.deepEqual(floorGrid(stale.render()), [[['k', 'Nothing for you', 'Open board'], [], [], [], [], ['Not read today']]], 'a read from another day does not say what merged today');
  const none = await floorScene({ ...panelCache([]), boards: [] });
  assert.ok(strings(none.render()).includes('No projects in this read'), 'a read with no projects says so');
  for (const [why, shape] of [['absent', undefined], ['null', null], ['text', 'boards']]) {
    const unread = await floorScene({ ...panelCache([]), boards: shape });
    assert.ok(strings(unread.render()).includes('Problem: this read has no boards this view can read'), `boards ${why}: the read's boards are a problem line`);
  }
  const formatOne = await floorScene({ ...panelCache([]), format: 1, boards });
  assert.ok(strings(formatOne.render()).some((line) => line.startsWith('Queue cache unreadable:')), 'a format 1 cache is unreadable');
});

test("the Floor names a project's Coordinator only where its state is not read", async () => {
  const boards = [
    floorBoard('p1'),
    // Two of Herdr's spaces open p6's folder, so whose Coordinator it is cannot be read.
    floorBoard('p6'),
  ];
  const host = await floorScene({ ...panelCache([]), boards });
  host.spaceList = [herdrSpace('s1', '/repos/p6', [herdrTab('s1-coordinator', 'Coordinator')]), herdrSpace('s2', '/repos/p6', [])];
  host.paneList = [herdrPane('p1', 's1-coordinator', 'working')];
  const tree = host.render();
  const unread = 'Coordinator state unread: two spaces open this folder';
  assert.deepEqual(floorGrid(tree).map(([project]) => project), [
    ['p1', 'Nothing for you', 'Open board'],
    ['p6', unread, 'Nothing for you', 'Open board'],
  ], 'a project with no Herdr space has no line; a Coordinator not read has one, between the name and the count');
  const [project] = floorRows(tree)[1];
  assert.equal(colourOf(project, unread), 'muted', 'a Coordinator line not read is muted');
});

test("a board card's answered is ignored whatever its value, and nothing draws You answered this version", async () => {
  const answered = (value) => floorBoard('a', { cards: [floorCard(1, 'Answered merge', 'Awaiting push', { waitsOn: 'merge', answered: value })] });
  for (const value of [true, 'yes', false]) {
    const tree = (await floorScene({ ...panelCache([]), boards: [answered(value)] })).render();
    assert.deepEqual(floorGrid(tree), [[['a', '1 need you', 'Open board'], [], [], [], ['Merge awaiting your yes', '#1', 'Answered merge'], []]],
      `answered: ${JSON.stringify(value)} is ignored and the merge still awaits the owner's yes`);
    assert.ok(!strings(tree).includes('You answered this version'), `answered: ${JSON.stringify(value)} draws no answered line`);
  }
});

// The agent on a Floor card: Herdr's live terminal list ties an agent to a card by the card's job worktree holding the
// terminal's live folder, then its launch folder; a card no terminal ties shows the program its claim's runtime names. The expected marks, lines, colours and counts are worked
// by hand from the plan's "Agent on a card" table and lighting rule for each fixture, never read off the panel.
const SPINNER = 'mods/workspace-chrome/spinner.svg';
const CLAUDE = { key: 'claude', name: 'Claude', icon: 'icons/claude.svg', tint: true, agent: true };
const CODEX = { key: 'codex', name: 'Codex', icon: 'icons/codex.svg', tint: false, agent: true };
const SHELL = { key: 'shell', name: 'zsh', icon: 'icons/shell.svg', tint: true, agent: false };
// The agents Herdr's knownAgents() gives, each with the menu fields it adds to a program.
const KNOWN_AGENTS = [{ ...CLAUDE, run: ['claude'], installed: true }, { ...CODEX, run: ['codex'], installed: true }];
const CLAUDE_MARK = { kind: 'svg', path: 'icons/claude.svg', label: 'Claude' };
const CODEX_MARK = { kind: 'image', path: 'icons/codex.svg', label: 'Codex' };
// A Decisions card's icon is unlabelled because its name stands beside it.
const CLAUDE_ICON = { ...CLAUDE_MARK, label: undefined };
const CODEX_ICON = { ...CODEX_MARK, label: undefined };
const PLAIN = ['border', 'raised'];
const litIn = (role) => [role, `${role}1F`];
const worktreeIn = (project, card) => `/repos/${project}/.claude/worktrees/job-${card}`;
// A terminal as Herdr's terminals() gives it: `cwd` is the folder it was launched in, `live` its running program's folder,
// and a null `state` is no report.
const agentTerminal = (address, /** @type {{ name?: string | null, cwd?: string | null, live?: string | null, state?: string | null, app?: string, program?: any }} */ { name = null, cwd = null, live = null, state = null, app = 'claude-code', program = CLAUDE } = {}) => ({
  address, name, cwd, foreground: live === null ? null : { cwd: live }, report: state === null ? null : { state, app }, program,
});

// floorScene loads at once, and the Floor asks knownAgents() as it loads, so Herdr's two lists are set first here.
async function agentScene(boards, terminalList, /** @type {any} */ agentPrograms = KNOWN_AGENTS) {
  const host = await loadPanel(OK, FLOOR);
  host.terminalList = terminalList;
  host.agentPrograms = agentPrograms;
  host.setCache({ ...panelCache([]), boards });
  await host.panel.load();
  return host;
}

// Each mark under a node: an svg or image other than the spinner, with the label on it or around it.
function marksIn(node) {
  const marks = [];
  const visit = (found, label) => {
    const own = labelOf(found) ?? label;
    if (['svg', 'image'].includes(found.kind) && found.path !== SPINNER) marks.push({ kind: found.kind, path: found.path, label: own });
    for (const kid of found.kids.filter((part) => typeof part !== 'string')) visit(kid, own);
  };
  visit(node, undefined);
  return marks;
}

// What a card's tile shows: its strings in order; its marks; the turn time of each spinner; and its border and fill.
function tileView(tree, id) {
  const tile = floorTiles(tree).find((found) => found.elementId === `${FLOOR_ID}${id}`);
  assert.ok(tile, `${id} is drawn`);
  const marks = marksIn(tile);
  const spins = nodesOf(tile, 'svg').filter((node) => node.path === SPINNER).map((node) => called(node, 'spin').at(-1)?.[0]);
  return { strings: strings(tile), marks, spins, lit: [called(tile, 'border_color').at(-1)?.[0], called(tile, 'bg').at(-1)?.[0]] };
}

// The agent mark of a Decisions card: the runtime its card's newest claim names, joined through the cache's boards. The
// expected marks, sizes and words are worked by hand from card 689's acceptance text and the design handoff's DecisionCard
// (agent icon 18px + title), never read off the panel.
// A card's agent marks: Herdr's program icons, not the glyphs of its controls.
const agentMarksIn = (node) => marksIn(node).filter((mark) => mark.path.startsWith('icons/'));

async function decisionsAgentScene(items, boards, agentPrograms = KNOWN_AGENTS) {
  const host = await loadPanel(OK, DECISIONS);
  host.agentPrograms = agentPrograms;
  host.setCache({ ...panelCache(items), boards });
  await host.panel.load();
  return host;
}

test("a Decisions card leads its title with the icon of the runtime its card's claim names", async () => {
  const claimed = (runtime) => ({ machine: 'omarchy', runtime });
  const boards = [floorBoard('a', { cards: [
    floorCard(5, 'Claude card', 'In review', { claim: claimed('Claude Code') }),
    floorCard(6, 'Codex card', 'In review', { claim: claimed('Codex') }),
    floorCard(7, 'Gemini card', 'In review', { claim: claimed('Gemini') }),
    floorCard(8, 'Menu card', 'In review', { claim: claimed('Claude Code') }),
  ] })];
  const merge = queueItem('merge', 5);
  const codex = queueItem('question', 6, { answerable: true });
  const gemini = queueItem('question', 7, { answerable: true });
  const menu = waitingMenu(1, { card: '8' });
  const host = await decisionsAgentScene([merge, codex, gemini, menu], boards);
  const tree = host.render();
  const marks = (item) => agentMarksIn(cardOf(tree, item.key));
  assert.deepEqual(marks(merge), [CLAUDE_ICON], 'the merge of card 5 shows the Claude mark alone');
  assert.deepEqual(marks(codex), [CODEX_ICON], 'the question of card 6 shows the Codex mark alone');
  assert.deepEqual(marks(menu), [CLAUDE_ICON], 'the menu, whose card is the text 8, shows the Claude mark alone');
  assert.deepEqual(marks(gemini), [], 'Herdr gives Gemini no icon, so no mark is drawn');
  assert.ok(strings(cardOf(tree, gemini.key)).includes('Gemini'), `the Gemini card says its runtime: ${strings(cardOf(tree, gemini.key)).join(' | ')}`);
  assert.ok(!strings(tree).includes('Agent unknown'), 'no card says its agent is unknown');
  const svg = nodesOf(cardOf(tree, merge.key), 'svg').find((node) => node.path === CLAUDE_MARK.path);
  assert.deepEqual(svg && called(svg, 'size'), [[18]], 'the Claude icon is 18');
  const image = nodesOf(cardOf(tree, codex.key), 'image').find((node) => node.path === CODEX_MARK.path);
  assert.deepEqual(image && [called(image, 'w'), called(image, 'h')], [[[18]], [[18]]], 'the Codex icon is 18 by 18');

  host.agentPrograms = new Error('herdr is starting');
  await host.panel.load();
  const unread = host.render();
  assert.deepEqual(agentMarksIn(cardOf(unread, codex.key)), [], 'with Herdr unread, the Codex card draws no icon');
  assert.ok(strings(cardOf(unread, codex.key)).includes('Codex'), 'with Herdr unread, the Codex card says its runtime by name');
});

test("a Decisions card names its agent beside the agent's icon", async () => {
  const claimed = (runtime) => ({ machine: 'omarchy', runtime });
  const boards = [floorBoard('a', { cards: [
    floorCard(5, 'Claude card', 'In review', { claim: claimed('Claude Code') }),
    floorCard(6, 'Codex card', 'In review', { claim: claimed('Codex') }),
  ] })];
  const merge = queueItem('merge', 5);
  const codex = queueItem('question', 6, { answerable: true });
  const tree = (await decisionsAgentScene([merge, codex], boards)).render();
  for (const [item, mark, name] of [[merge, CLAUDE_ICON, 'Claude'], [codex, CODEX_ICON, 'Codex']]) {
    const card = cardOf(tree, item.key);
    assert.deepEqual(agentMarksIn(card), [mark], `${name}: the icon is still drawn`);
    assert.equal(strings(card).filter((line) => line === name).length, 1, `${name}: the card names its agent once: ${strings(card).join(' | ')}`);
    assert.ok(![...walk(card)].some(([node]) => labelOf(node) === name), `${name}: no node is labelled with the name, which the word already gives`);
    const [titleNode, row] = [...walk(card)].find(([node]) => node.kids.includes(item.title));
    const within = (kid) => [...walk(kid)].map(([node]) => node);
    const place = (found) => row.kids.findIndex((kid) => typeof kid !== 'string' && within(kid).includes(found));
    const markNode = within(row).find((node) => node.kind === 'svg' || node.kind === 'image');
    assert.ok(place(markNode) < place(titleNode), `${name}: the agent mark comes before the title in its row`);
  }
  const unnamed = KNOWN_AGENTS.map((program) => (program.key === 'claude' ? { ...program, name: '' } : program));
  const blank = cardOf((await decisionsAgentScene([merge], boards, unnamed)).render(), merge.key);
  assert.deepEqual(agentMarksIn(blank), [CLAUDE_ICON], 'a program with no name still draws its icon');
  assert.equal(strings(blank).filter((line) => line === 'Claude Code').length, 1, `a program with no name is named by its runtime: ${strings(blank).join(' | ')}`);
});

test('a Decisions card says its agent is unknown where its board is ambiguous or its card unread', async () => {
  const claim = (runtime) => ({ machine: 'omarchy', runtime });
  const boards = [
    floorBoard('d', { cards: [floorCard(30, 'Twice read', 'In progress', { claim: claim('Claude Code') })] }),
    floorBoard('d', { cards: [floorCard(30, 'Twice read', 'In progress', { claim: claim('Codex') })] }),
    floorBoard('e', { cards: [floorCard(31, 'Details unread', 'In progress', { unread: 'a code fence is left open', claim: claim('Claude Code') })] }),
    floorBoard('f', { cards: [floorCard(32, 'Blank runtime', 'In progress', { claim: claim('  ') })] }),
  ];
  const items = [30, 31, 32].map((card, at) => inRepository(['d', 'e', 'f'][at], 'question', card, { answerable: true }));
  const tree = (await decisionsAgentScene(items, boards)).render();
  for (const item of items) {
    const card = cardOf(tree, item.key);
    assert.ok(strings(card).includes('Agent unknown'), `${item.key} says its agent is unknown: ${strings(card).join(' | ')}`);
    assert.deepEqual(agentMarksIn(card), [], `${item.key} draws no agent mark`);
  }
});

test('a Decisions card says its agent is unknown where the read gives no runtime for it, and still draws', async () => {
  const boards = [
    floorBoard('a', { cards: [
      floorCard(10, 'No claim', 'Ready', { claim: null }),
      floorCard(11, 'Claim without runtime', 'In progress', { claim: { machine: 'omarchy' } }),
      floorCard(12, 'Claim with empty runtime', 'In progress', { claim: { machine: 'omarchy', runtime: '' } }),
      { ...floorCard(14, 'Details unread', 'In progress', { unread: 'a code fence is left open' }), claim: undefined },
    ] }),
    floorBoard('u', { unreadable: 'folder unreadable' }),
    floorBoard('x', { cards: 'not a list' }),
  ];
  const items = [10, 11, 12, 13, 14].map((card) => queueItem('question', card, { answerable: true }));
  items.push(
    inRepository('u', 'question', 20, { answerable: true }),
    inRepository('x', 'question', 21, { answerable: true }),
    inRepository('none', 'question', 22, { answerable: true }),
    waitingMenu(2, { repository: undefined }),
  );
  const tree = (await decisionsAgentScene(items, boards)).render();
  for (const item of items) {
    const card = cardOf(tree, item.key);
    assert.ok(strings(card).includes('Agent unknown'), `${item.key} says its agent is unknown: ${strings(card).join(' | ')}`);
    if (item.title !== undefined) assert.ok(strings(card).includes(item.title), `${item.key} still draws its title: ${strings(card).join(' | ')}`);
    assert.deepEqual(agentMarksIn(card), [],`${item.key} draws no agent mark`);
  }
  assert.ok(!strings(tree).some((line) => line.includes('cannot be read')), `no card falls back to its problem line: ${strings(tree).join(' | ')}`);
});

test("a Decisions card takes its agent from its own project's board, not another project's card of the same number", async () => {
  const claimed = (runtime) => ({ machine: 'omarchy', runtime });
  const boards = [
    floorBoard('b', { cards: [floorCard(5, 'Codex card of b', 'In review', { claim: claimed('Codex') })] }),
    floorBoard('a', { cards: [floorCard(5, 'Claude card of a', 'In review', { claim: claimed('Claude Code') })] }),
  ];
  const ofA = queueItem('question', 5, { answerable: true });
  const ofB = inRepository('b', 'question', 5, { answerable: true });
  const tree = (await decisionsAgentScene([ofA, ofB], boards)).render();
  assert.deepEqual(agentMarksIn(cardOf(tree, ofA.key)), [CLAUDE_ICON], "a's card 5 shows the Claude mark, though b's card 5 is listed first");
  assert.deepEqual(agentMarksIn(cardOf(tree, ofB.key)), [CODEX_ICON], "b's card 5 shows the Codex mark");
  const svg = nodesOf(cardOf(tree, ofA.key), 'svg').find((node) => node.path === CLAUDE_MARK.path);
  assert.equal(svg && called(svg, 'text_color').at(-1)?.[0], 'muted', 'the Claude mark is drawn in the muted colour');
});

test('a Floor tile draws its agent mark at 13', async () => {
  const boards = [floorBoard('p', { cards: [floorCard(20, 'Card 20', 'In progress', { claim: { machine: 'omarchy', runtime: 'Claude Code' } })] })];
  const tree = (await agentScene(boards, [])).render();
  const tile = floorTiles(tree).find((found) => found.elementId === `${FLOOR_ID}/repos/p#20`);
  assert.ok(tile, 'the tile of card 20 is drawn');
  const svg = nodesOf(tile, 'svg').find((node) => node.path === CLAUDE_MARK.path);
  assert.deepEqual(svg && called(svg, 'size'), [[13]], 'the Claude mark on a tile is 13');
});

// A line above the grid: drawn, and not inside the table.
function assertProblemLine(tree, line) {
  assert.ok(strings(tree).includes(line), `${line} is drawn: ${strings(tree).join(' | ')}`);
  assert.ok(!nodesOf(tree, 'table').some((table) => strings(table).includes(line)), `${line} is above the grid, not in it`);
}

// Test D's projects p and q and Herdr's terminals beside them.
function agentFloor() {
  const W = (card) => worktreeIn('p', card);
  const card = (id, column, fields) => floorCard(id, `Card ${id}`, column, fields);
  const boards = [
    floorBoard('p', {
      cards: [
        card(20, 'In progress', { worktree: W(20), claim: { machine: 'vps', runtime: 'Codex' } }),
        card(21, 'Awaiting push', { waitsOn: 'merge', worktree: '/jobs/21' }),
        card(22, 'In progress', { worktree: W(22) }),
        card(23, 'In progress', { worktree: W(23) }),
        card(24, 'Ready', { worktree: W(24), claim: { machine: 'vps', runtime: 'Codex' } }),
        card(25, 'Ready', { claim: { machine: 'vps', runtime: 'Claude Code cloud' } }),
        card(26, 'In progress', { claim: { machine: 'm' } }),
        card(27, 'In progress', { worktree: W(27) }),
        card(28, 'In progress', { claim: { machine: 'vps', runtime: 'Claude Code' }, unread: 'comments unavailable' }),
        card(29, 'In review', { worktree: W(29) }),
        card(30, 'In progress', { claim: { machine: 'vps', runtime: 'Gemini CLI' } }),
        floorCard(31, 'Proposed: Idea', 'Backlog', { waitsOn: 'suggested', worktree: W(31), claim: { machine: 'vps', runtime: 'Claude Code' } }),
      ],
    }),
    floorBoard('q', { cards: [card(22, 'In progress', { worktree: worktreeIn('q', 22) })] }),
  ];
  const terminals = [
    agentTerminal('t1', { cwd: '/jobs/21', live: `${W(20)}/src`, state: 'working' }),
    agentTerminal('t2', { cwd: '/jobs/21', live: '/srv/o', state: 'idle', app: 'codex', program: CODEX }),
    agentTerminal('t3', { live: W(22), state: 'blocked' }),
    agentTerminal('t4', { live: W(23), state: 'done' }),
    agentTerminal('t5', { cwd: W(23), state: 'working' }),
    agentTerminal('t6', { live: W(23), state: 'error' }),
    agentTerminal('t7', { live: W(27), program: SHELL }),
    agentTerminal('remote/t8', { live: W(27), state: 'working' }),
    agentTerminal('t9', { live: W(270), state: 'working' }),
    agentTerminal('t10', { cwd: worktreeIn('q', 22), state: 'working' }),
    agentTerminal('t12', { live: W(29) }),
    agentTerminal('t13', { live: W(31), state: 'working' }),
  ];
  return { boards, terminals };
}

const AGENT_PROBLEMS = /^(Problem:|Agent state not read|Agent icons not read|Sessions not matched|Agents in job worktrees not matched)/;

test('each Floor card shows the agent Herdr shows on it and whether it works now, else the agent its claim names, and no agent it cannot read', async () => {
  const { boards, terminals } = agentFloor();
  const host = await agentScene(boards, terminals);
  const tree = host.render();
  const shows = (lines, marks, spins, lit) => ({ strings: lines, marks, spins, lit });
  for (const [id, expected, why] of [
    ['/repos/p#20', shows(['#20', 'Card 20', 'Building now'], [CLAUDE_MARK], [900], PLAIN), "its live folder under the worktree ties t1 before its launch folder in #21's, and Herdr beats the claim"],
    ['/repos/p#21', shows(['Merge awaiting your yes', '#21', 'Card 21', 'Agent idle'], [CODEX_MARK], [], litIn('blocked')), 'its launch folder ties t2 where its live folder does not'],
    ['/repos/p#22', shows(['Agent waiting on you', '#22', 'Card 22'], [CLAUDE_MARK], [], litIn('blocked')), 'its live folder in the worktree ties t3'],
    ['/repos/p#23', shows(['#23', 'Card 23', 'Building now'], [CLAUDE_MARK], [900], PLAIN), 'working outranks done and error'],
    ['/repos/p#24', shows(['#24', 'Card 24'], [CODEX_MARK], [], PLAIN), "no terminal is in its worktree, so its claim names Codex"],
    ['/repos/p#25', shows(['#25', 'Card 25'], [CLAUDE_MARK], [], PLAIN), 'Claude Code cloud is the Claude program'],
    ['/repos/p#26', shows(['#26', 'Card 26'], [], [], PLAIN), 'a claim without a runtime names no agent'],
    ['/repos/p#27', shows(['#27', 'Card 27'], [], [], PLAIN), "a shell, another machine's terminal and a folder beside the worktree tie nothing"],
    ['/repos/p#28', shows(['#28', 'Card 28'], [], [], PLAIN), 'an unread card shows no agent'],
    ['/repos/p#29', shows(['#29', 'Card 29', 'Merging', 'Agent state not reported'], [CLAUDE_MARK], [], PLAIN), 'a terminal with no report'],
    ['/repos/p#30', shows(['Gemini CLI', '#30', 'Card 30'], [], [], PLAIN), 'a runtime Herdr has no program for is its name'],
    ['/repos/p#31', shows(['Suggested card', '#31', 'Idea'], [], [], litIn('accent')), 'a Suggested card shows no agent'],
    ['/repos/q#22', shows(['#22', 'Card 22', 'Building now'], [CLAUDE_MARK], [900], PLAIN), "its launch folder in q's worktree ties t10, never t3 in p's"],
  ]) {
    assert.deepEqual(tileView(tree, id), expected, `${id}: ${why}`);
  }
  assert.equal(sizeOf(floorTiles(tree).find((tile) => tile.elementId === `${FLOOR_ID}/repos/p#30`), 'Gemini CLI'), 11, 'a runtime word is 11 px');
  assert.deepEqual(strings(tree).filter((line) => AGENT_PROBLEMS.test(line)), [], 'every agent fact was read, so no line names one unread');
});

test('the Floor names every agent fact it could not read instead of showing a card without one', async () => {
  const { boards, terminals } = agentFloor();
  for (const [why, list, line] of [
    ['a terminal list that throws', new Error('herdr is starting'), 'Agent state not read: herdr is starting'],
    ['a terminal list holding a state it does not know', [...terminals, agentTerminal('t99', { live: '/srv/o', state: 'busy' })],
      'Agent state not read: the terminal list is not one this view can read'],
  ]) {
    const tree = (await agentScene(boards, list)).render();
    assertProblemLine(tree, line);
    assert.deepEqual(tileView(tree, '/repos/p#20'), { strings: ['#20', 'Card 20'], marks: [CODEX_MARK], spins: [], lit: PLAIN }, `${why}: #20 falls back to its claim`);
  }
  for (const [why, programs, line] of [
    ['a program table that rejects', new Error('shell timed out'), 'Agent icons not read: shell timed out'],
    ['a program table that is not a list', {}, 'Agent icons not read: it is not a program list'],
  ]) {
    const tree = (await agentScene(boards, terminals, programs)).render();
    assertProblemLine(tree, line);
    assert.deepEqual(tileView(tree, '/repos/p#24'), { strings: ['Codex', '#24', 'Card 24'], marks: [], spins: [], lit: PLAIN }, `${why}: #24 shows its claim's runtime word`);
  }
  // A report's app is a field no tie reads, so a sibling's malformed one leaves the terminal list readable.
  const odd = { ...agentTerminal('t14', { live: '/srv/o', state: 'idle' }), report: { state: 'idle', app: 7 } };
  const oddTree = (await agentScene(boards, [...terminals, odd])).render();
  assert.ok(!strings(oddTree).some((line) => line.startsWith('Agent state not read')), `a malformed app is not an unread terminal list: ${strings(oddTree).join(' | ')}`);
  assert.deepEqual(tileView(oddTree, '/repos/p#20'), { strings: ['#20', 'Card 20', 'Building now'], marks: [CLAUDE_MARK], spins: [900], lit: PLAIN },
    "a sibling's malformed app leaves #20 tied to t1");

  const asked = (card, fields) => [floorCard(card, 'Asks', 'In progress', { waitsOn: 'question', ...fields })];
  // The cache text leaves an undefined key out, so w1's and w2's cards have no `worktree` key.
  const rows = [
    floorBoard('w1', { waitsOnUnread: ['worktrees'], cards: asked(51, { worktree: undefined }) }),
    floorBoard('w2', { cards: asked(52, { worktree: undefined }) }),
    floorBoard('x1', { cards: [floorCard(53, 'Odd', 'In progress', { worktree: 7 })] }),
    floorBoard('x2', { cards: [floorCard(54, 'Odd', 'In progress', { claim: 'omarchy' })] }),
  ];
  const tree = (await agentScene(rows, [])).render();
  const building = (card) => [[], [], ['Blocking question', `#${card}`, 'Asks'], [], []];
  assert.deepEqual(floorGrid(tree), [
    [['w1', 'At least 1 need you', 'What cards wait on not read: worktrees', 'Agents in job worktrees not matched to cards: the worktree list was not read', 'Open board'], ...building(51)],
    [['w2', 'At least 1 need you', "Agents in job worktrees not matched to cards: its queue reader's release predates worktree reading", 'Open board'], ...building(52)],
    [['x1', 'Open board'], [UNREADABLE_ENTRY]],
    [['x2', 'Open board'], [UNREADABLE_ENTRY]],
  ], 'a worktree list not read is named and makes the count a floor; a worktree or claim the view cannot read makes the board unreadable');
});

test('the Floor lights a card whose agent waits on you and counts it once', async () => {
  const R = (card) => worktreeIn('r', card);
  const cards = [
    floorCard(40, 'Waits alone', 'In progress', { worktree: R(40) }),
    floorCard(41, 'Asks too', 'In progress', { waitsOn: 'question', worktree: R(41) }),
    floorCard(42, 'Builds', 'In progress', { worktree: R(42) }),
    floorCard(43, 'Paused', 'In progress', { waitsOn: 'usage-limit', worktree: R(43) }),
  ];
  // t19 comes first, so a card whose first tied terminal wins would read as building.
  const terminals = [
    agentTerminal('t19', { cwd: R(40), state: 'working' }),
    agentTerminal('t15', { live: R(40), state: 'blocked' }),
    agentTerminal('t16', { live: R(41), state: 'blocked' }),
    agentTerminal('t17', { live: R(42), state: 'working' }),
    agentTerminal('t18', { live: R(43), state: 'blocked' }),
  ];
  const tilesOf = (tree) => [40, 41, 42, 43].map((card) => tileView(tree, `/repos/r#${card}`));
  const view = (lines, spins, lit, marks) => ({ strings: lines, marks, spins, lit });
  const read = [
    view(['Agent waiting on you', '#40', 'Waits alone'], [], litIn('blocked'), [CLAUDE_MARK]),
    view(['Blocking question', '#41', 'Asks too', 'Agent waiting on you'], [], litIn('blocked'), [CLAUDE_MARK]),
    view(['#42', 'Builds', 'Building now'], [900], PLAIN, [CLAUDE_MARK]),
    view(['Stopped at a usage limit', '#43', 'Paused', 'Agent waiting on you'], [], litIn('working'), [CLAUDE_MARK]),
  ];
  const projectCell = (tree) => floorGrid(tree)[0][0];

  const tree = (await agentScene([floorBoard('r', { cards })], terminals)).render();
  assert.deepEqual(tilesOf(tree), read, 'blocked outranks working; an agent waiting lights an unlit card in blocked and adds its line to a lit one, which keeps its kind');
  assert.deepEqual(projectCell(tree), ['r', '3 need you', 'Open board'], 'three lit tiles, each counted once');

  const unread = (await agentScene([floorBoard('r', { cards })], new Error('herdr is starting'))).render();
  assert.deepEqual(tilesOf(unread), [
    view(['#40', 'Waits alone'], [], PLAIN, []),
    view(['Blocking question', '#41', 'Asks too'], [], litIn('blocked'), []),
    view(['#42', 'Builds'], [], PLAIN, []),
    view(['Stopped at a usage limit', '#43', 'Paused'], [], litIn('working'), []),
  ], 'with no terminal list each card shows only its own kind, and no claim names an agent');
  assert.deepEqual(projectCell(unread), ['r', 'At least 2 need you', 'Open board'], 'a terminal list not read makes the count a floor');

  const folderless = (await agentScene([floorBoard('r', { folder: null, cards })], terminals)).render();
  assert.deepEqual(tilesOf(folderless), read, 'the worktree ties hold without the folder');
  assert.deepEqual(projectCell(folderless), ['r', '3 need you', 'Open board'],
    'no tie rule reads the folder, so a folder not read leaves the count exact and adds no line');
});

// new behaviour: a merge answer goes to the coordinator chat, so a merge awaiting push waits on the owner until it merges.
// Card 60 carries `answered: true`, the marker an older reader still sends where a card comment recorded the answer.
test('the Floor lights and counts a waiting merge whose answer was relayed', async () => {
  const cards = [
    floorCard(60, 'Relayed merge', 'Awaiting push', { waitsOn: 'merge', answered: true, worktree: worktreeIn('r', 60) }),
    floorCard(61, 'Waiting merge', 'Awaiting push', { waitsOn: 'merge' }),
  ];
  const terminals = [agentTerminal('t1', { live: worktreeIn('r', 60), state: 'working' })];
  const tree = (await agentScene([floorBoard('r', { cards })], terminals)).render();
  assert.deepEqual(floorGrid(tree), [[
    ['r', '2 need you', 'Open board'],
    [],
    [],
    [],
    ['Merge awaiting your yes', '#60', 'Relayed merge', 'Building now', 'Merge awaiting your yes', '#61', 'Waiting merge'],
    [],
  ]], 'both merges stay in Awaiting your yes and both are counted');
  assert.deepEqual(tileView(tree, '/repos/r#60'), {
    strings: ['Merge awaiting your yes', '#60', 'Relayed merge', 'Building now'], marks: [CLAUDE_MARK], spins: [900], lit: litIn('blocked'),
  }, 'the relayed merge is lit as a merge and keeps its agent line');
  assert.deepEqual(tileView(tree, '/repos/r#61'), {
    strings: ['Merge awaiting your yes', '#61', 'Waiting merge'], marks: [], spins: [], lit: litIn('blocked'),
  }, 'the other merge is lit as before');
});

const BOARD_ID = 'fabraik-queue-board-';
const BOARD_COLUMN_IDS = ['needs', 'backlog', 'ready', 'progress', 'merged'].map((column) => `${BOARD_ID}column-${column}`);
const boardOf = (folder, cards, fields) => floorBoard(folder, { cards, ...fields });
const boardCard = (card, title, column, order, fields) => floorCard(card, title, column, { order, ...fields });
const boardColumnOf = (tree, column) => nodeWithId(tree, `${BOARD_ID}column-${column}`);
const boardColumns = (tree) => [...walk(tree)].map(([node]) => node).filter((node) => BOARD_COLUMN_IDS.includes(node.elementId));
const titleOf = (tree, card) => nodeWithId(tree, `${BOARD_ID}title-${card}`);
const titlesIn = (node) => buttonsIn(node).filter((button) => button.elementId?.startsWith(`${BOARD_ID}title-`)).map(nameOf);
const boardCardOf = (tree, card) => nodeWithId(tree, `${BOARD_ID}card-${card}`);
const BADGE = /^(Next, card|Card) /;

async function boardScene(repository, cache, /** @type {Exec} */ execResult = OK) {
  const host = await loadPanel(execResult, { view: 'board', repository });
  host.setCache(cache);
  await host.panel.load();
  return host;
}

test('the Board heads its project and places each card in its column, a proposal and an unknown column included', async () => {
  const cards = [
    boardCard(1, 'Later', 'Backlog', 1),
    boardCard(2, 'Proposed: Add a thing', 'Backlog', 2, { waitsOn: 'suggested' }),
    boardCard(3, 'Unsorted', null, 1),
    boardCard(4, 'Build it', 'Ready', 1),
    boardCard(5, 'Proposed: Ready idea', 'Ready', 2),
    boardCard(6, 'Running', 'In progress', 1),
    boardCard(7, 'Merging one', 'In review', 1),
    boardCard(8, 'Ship it', 'Awaiting push', 1, { waitsOn: 'merge' }),
    boardCard(9, 'Odd', 'Triage', 1),
  ];
  const boards = [boardOf('b', [boardCard(1, 'Elsewhere', 'Ready', 1)]), boardOf('a', cards)];
  const tree = (await boardScene('/repos/a', { ...panelCache([]), boards })).render();
  const shown = strings(tree);
  assert.ok(shown.includes('a'), `the header shows a: ${shown.join(' | ')}`);
  assert.ok(shown.some((line) => /^Read at \d\d:\d\d$/.test(line)), 'the header shows when the queue was read');
  assert.equal(sizeOf(tree, 'a'), 16, 'the folder name is 16');

  assert.deepEqual(boardColumns(tree).map((column) => strings(column).slice(0, 2)),
    [['Needs you', '0'], ['Backlog', '4'], ['Ready to build', '1'], ['In progress', '3'], ['Merged', '0 new']], 'five columns in order, each with its count');
  assert.deepEqual(titlesIn(boardColumnOf(tree, 'backlog')), ['Later', 'Add a thing', 'Unsorted', 'Ready idea'],
    'Backlog holds Backlog, no column and every proposal, in board order');
  assert.deepEqual(titlesIn(boardColumnOf(tree, 'ready')), ['Build it'], 'Ready holds the Ready card that is no proposal');
  assert.deepEqual(titlesIn(boardColumnOf(tree, 'progress')), ['Running', 'Merging one', 'Ship it'], 'In progress holds In progress, In review and Awaiting push');
  const suggested = 'Suggested card: accept or reject it in Needs you';
  assert.equal(strings(boardColumnOf(tree, 'backlog')).filter((line) => line === suggested).length, 2, 'each proposal says where it is answered');
  for (const line of ['Merging', 'Awaiting your yes']) assert.ok(strings(boardColumnOf(tree, 'progress')).includes(line), `In progress says ${line}`);
  assert.ok(strings(boardColumnOf(tree, 'needs')).includes('Nothing waiting on you'), 'an empty Needs you says so');
  const unknown = 'Card #9 is in Triage, which has no column here';
  assert.ok(shown.includes(unknown), 'a card in a column with no place is a problem line');
  assert.equal(colourOf(tree, unknown), 'foreground', 'the problem line is in the foreground');
  assert.ok(!boardColumns(tree).some((column) => strings(column).includes(unknown)), 'the problem line is in no column');
  assert.ok(!titlesIn(tree).includes('Odd') && !titlesIn(tree).includes('Elsewhere'), "neither that card nor another project's is drawn");
});

// Every Coordinator line card 858's plan writes, so a test can see that a view draws exactly one of them.
const COORDINATOR_LINES = ['Coordinator working', 'Coordinator waiting on you', 'Coordinator done', 'Coordinator idle', 'Coordinator starting',
  "No Coordinator tab in this project's space", 'Coordinator not running', 'No Herdr space for this project',
  "Coordinator state unread: Herdr is still loading this computer's spaces", "Coordinator state unread: Herdr reports this computer's layout unavailable",
  'Coordinator state unread: two spaces open this folder'];
// The strings a tree shows as lines: a Coordinator line's muted label is drawn apart from its state word, so the two join.
const shownLines = (shown) => shown.flatMap((text, index) => {
  if (text === 'Coordinator ') return [`${text}${shown[index + 1]}`];
  return shown[index - 1] === 'Coordinator ' ? [] : [text];
});

test("ANTI-REGRESSION: a project with no lead shows its own Coordinator's state from Herdr's live panes, never no lead running, and says why where it cannot be read", async () => {
  const project = (tabs) => herdrSpace('s1', '/repos/a', tabs);
  const jobs = herdrTab('s1-jobs', 'Jobs');
  const coordinator = herdrTab('s1-coordinator', 'Coordinator');
  // Another project's space, whose Coordinator works, and another computer whose layout is not read: neither is this
  // project's.
  const other = herdrSpace('s9', '/repos/other', [herdrTab('s9-coordinator', 'Coordinator')]);
  const machines = (layout) => [{ name: null, layout }, { name: 'mac', layout: layout === 'ready' ? 'unavailable' : 'ready' }];
  const scene = (status) => {
    // An agent in another tab of the space, and the other project's Coordinator, each in a state this case does not show.
    const elsewhere = status === 'blocked' ? 'done' : 'blocked';
    return { spaces: [other, project([jobs, coordinator])], machines: machines('ready'), panes: [
      herdrPane('p9', 's9-coordinator', elsewhere), herdrPane('p2', 's1-jobs', elsewhere),
      herdrPane('p0', 's1-coordinator', null, SHELL_PROGRAM), herdrPane('p1', 's1-coordinator', status),
    ] };
  };
  /** @type {[string, any, string][]} */
  const cases = [
    ['a working Coordinator', scene('working'), 'Coordinator working'],
    ['a Coordinator waiting on you', scene('blocked'), 'Coordinator waiting on you'],
    ['a Coordinator that finished', scene('done'), 'Coordinator done'],
    ['an idle Coordinator', scene('idle'), 'Coordinator idle'],
    ['a Coordinator that reports no state yet', scene(null), 'Coordinator starting'],
    ['a space with no Coordinator tab', { spaces: [other, project([jobs])], machines: machines('ready'),
      panes: [herdrPane('p9', 's9-coordinator', 'working'), herdrPane('p2', 's1-jobs', 'working')] }, "No Coordinator tab in this project's space"],
    ['a Coordinator tab holding only a shell', { spaces: [other, project([jobs, coordinator])], machines: machines('ready'),
      panes: [herdrPane('p9', 's9-coordinator', 'working'), herdrPane('p2', 's1-jobs', 'working'), herdrPane('p0', 's1-coordinator', null, SHELL_PROGRAM)] },
    'Coordinator not running'],
    ['an empty Coordinator tab', { spaces: [other, project([coordinator])], machines: machines('ready'), panes: [herdrPane('p9', 's9-coordinator', 'working')] },
      'Coordinator not running'],
    ['no space for the project', { spaces: [other], machines: machines('ready'), panes: [herdrPane('p9', 's9-coordinator', 'working')] },
      'No Herdr space for this project'],
    ["this computer's spaces still loading", { spaces: [], machines: machines('loading'), panes: [] },
      "Coordinator state unread: Herdr is still loading this computer's spaces"],
    ["this computer's layout unavailable", { spaces: [], machines: machines('unavailable'), panes: [] },
      "Coordinator state unread: Herdr reports this computer's layout unavailable"],
    ['two spaces on its folder', { spaces: [project([coordinator]), herdrSpace('s2', '/repos/a', [jobs])], machines: machines('ready'),
      panes: [herdrPane('p1', 's1-coordinator', 'working')] }, 'Coordinator state unread: two spaces open this folder'],
  ];
  for (const [why, { spaces, panes, machines: layouts }, line] of cases) {
    const board = await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', [])] });
    Object.assign(board, { spaceList: spaces, paneList: panes, machineList: layouts });
    const shown = strings(board.render());
    assert.deepEqual(shownLines(shown).filter((text) => COORDINATOR_LINES.includes(text)), [line], `${why}: the Board header says ${line}: ${shown.join(' | ')}`);
    assert.ok(!shown.some((text) => text.includes('No lead running here')), `${why}: the Board never says no lead runs here`);

    const floor = await floorScene({ ...panelCache([]), boards: [floorBoard('a')] });
    Object.assign(floor, { spaceList: spaces, paneList: panes, machineList: layouts });
    const row = floorGrid(floor.render())[0][0];
    assert.ok(!row.some((text) => text.includes('No lead running here')), `${why}: the Floor never says no lead runs here`);
    if (line.startsWith('Coordinator state unread: ')) assert.ok(row.includes(line), `${why}: the Floor names why it was not read: ${row.join(' | ')}`);
  }
});

test('ANTI-REGRESSION: a Coordinator tab holding agents in several states says working over done, and waiting on you over both', async () => {
  const spaces = [herdrSpace('s1', '/repos/a', [herdrTab('s1-coordinator', 'Coordinator')])];
  for (const [states, line] of /** @type {[string[], string][]} */ ([
    [['done', 'working'], 'Coordinator working'],
    [['working', 'done'], 'Coordinator working'],
    [['idle', 'done', 'working'], 'Coordinator working'],
    [['working', 'blocked'], 'Coordinator waiting on you'],
    [['done', 'working', 'blocked'], 'Coordinator waiting on you'],
  ])) {
    const board = await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', [])] });
    Object.assign(board, { spaceList: spaces, paneList: states.map((status, n) => herdrPane(`p${n}`, 's1-coordinator', status)) });
    const shown = strings(board.render());
    assert.deepEqual(shownLines(shown).filter((text) => COORDINATOR_LINES.includes(text)), [line], `panes ${states.join(', ')}: the Board header says ${line}: ${shown.join(' | ')}`);
  }
});

test('a coordinator line draws its label muted and its state word in the foreground, on the Board header, the Floor row and the Decisions tile', async () => {
  const spaces = [herdrSpace('s1', '/repos/a', [herdrTab('s1-coordinator', 'Coordinator')])];
  // A blocked Coordinator, since the Floor row draws a coordinator line only when it waits on the owner.
  const scene = (host) => Object.assign(host, { spaceList: spaces, paneList: [herdrPane('p1', 's1-coordinator', 'blocked')], machineList: [{ name: null, layout: 'ready' }] });
  const board = scene(await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', [])] })).render();
  const floor = scene(await floorScene({ ...panelCache([]), boards: [floorBoard('a')] })).render();
  const decisions = scene(await decisionsScene({ ...panelCache([]), boards: [boardOf('a', [])] })).render();
  for (const [why, tree] of [['the Board header', board], ['the Floor row', floorRows(floor)[0][0]], ['the Decisions tile', decisions]]) {
    assert.equal(colourOf(tree, 'Coordinator '), 'muted', `${why}: the label is muted`);
    assert.equal(colourOf(tree, 'waiting on you'), 'foreground', `${why}: the state word is in the foreground`);
  }
});

test('929 dispatches one coordinator open from a registered project', async (t) => {
  const scratch = realpathSync(temporaryFolder(t, 'herdr-coordinator-'));
  const repository = join(scratch, 'Project With Spaces');
  const unlisted = join(scratch, 'Unlisted');
  const escaped = join(scratch, 'Escaped');
  const alias = join(scratch, 'Alias');
  const record = join(scratch, 'calls.jsonl');
  const stub = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input: readFileSync(0, 'utf8') }) + '\\n');
if (process.argv.at(-1) === 'claude') {
  console.log('Coordinator is already open.');
  process.exitCode = 5;
}`;
  for (const root of [repository, unlisted]) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'coordinator.mjs'), stub);
  }
  mkdirSync(escaped);
  symlinkSync(join(unlisted, 'scripts'), join(escaped, 'scripts'), 'junction');
  symlinkSync(repository, alias, 'junction');
  const { home } = releasedHome(t, [repository, alias, escaped]);
  rmSync(alias, { recursive: true });
  symlinkSync(unlisted, alias, 'junction');
  const cli = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], {
    encoding: 'utf8', input: 'this must not reach the opener', timeout: 10_000,
  });
  const opened = cli('open-coordinator', repository, 'codex');
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const already = cli('open-coordinator', repository, 'claude');
  assert.equal(already.status, 5, already.stdout + already.stderr);
  assert.match(already.stdout + already.stderr, /already open/i);
  for (const [root, reason] of /** @type {[string, RegExp][]} */ ([[unlisted, /machine record does not list/], [alias, /Register the project's real root to open its Coordinator\./],
    [escaped, /coordinator\.mjs|opener/i]])) {
    const fail = cli('open-coordinator', root, 'codex');
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    assert.match(fail.stdout + fail.stderr, reason);
  }
  for (const args of [[], [repository], [repository, 'other'], [repository, 'codex', '--login', 'octocat']]) {
    const bad = cli('open-coordinator', ...args);
    assert.deepEqual({ status: bad.status, stderr: bad.stderr }, { status: 2, stderr: QUEUE_USAGE });
  }
  assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
    { cwd: repository, args: ['open', '--runtime', 'codex'], input: '' },
    { cwd: repository, args: ['open', '--runtime', 'claude'], input: '' },
  ], 'each allowed press starts one opener with fixed arguments, and refusals start none');

  const { home: panelHome, cache: panelCacheRead } = releasedHome(t, [repository]);
  const claude = 'Open Claude Code once';
  const codex = 'Open Codex once';
  const saved = { runtime: 'claude', installed: ['claude', 'codex'] };
  const github = { cards: [], moves: true, places: true, coordinator: saved };
  const refreshWith = async (runCollector) => {
    await refresh({ home: panelHome, runCollector, terminals: NO_TERMINALS });
    return panelCacheRead();
  };
  const scene = (/** @type {{ runtime?: string, installed?: string[], unread?: string }} */ coordinator = saved, /** @type {Exec} */ execResult = OK) => decisionsScene({ ...panelCache([]), boards: [
    { ...github, repository, folder: repository, coordinator },
  ] }, execResult);
  const controls = (tree) => buttonsIn(tree).filter((button) => [claude, codex].includes(controlName(button)));
  const enabled = (tree) => controls(tree).filter((button) => !isDisabled(button)).map(controlName);
  const refuses = async (host, reason) => {
    const tree = host.render();
    if (reason) assert.match(strings(tree).join('\n'), reason);
    assert.deepEqual(enabled(tree), []);
    for (const button of controls(tree)) await host.click(button);
    assert.deepEqual(ran(host), []);
    assert.deepEqual(host.runs, []);
  };

  const cacheWithBoth = await refreshWith(() => collectorDocument({ board: github }));
  assert.deepEqual(cacheWithBoth.boards[0].coordinator, saved, 'refresh keeps the valid optional field');
  const replies = [];
  const host = await decisionsScene(cacheWithBoth, () => new Promise((resolve) => replies.push(resolve)));
  const tree = host.render();
  for (const line of ['Nothing for you', 'Saved default: Claude Code', 'Choose for this session']) {
    assert.ok(strings(tree).includes(line), line);
  }
  assert.equal(colourOf(tree, 'Saved default: Claude Code'), 'muted');
  assert.deepEqual(enabled(tree), [claude, codex]);
  for (const button of controls(tree)) {
    assert.deepEqual([called(button, 'h').at(-1), called(button, 'px').at(-1), called(button, 'border_1').length], [[24], [8], 1]);
  }
  assert.deepEqual(ran(host), [], 'render starts no executor');
  const opening = host.click(named(tree, codex));
  await new Promise(setImmediate);
  const pending = host.render();
  assert.ok(strings(pending).includes('Opening…'));
  assert.deepEqual(enabled(pending), []);
  await host.click(named(pending, claude));
  const duplicate = host.click(named(tree, codex)); // A second click using the previous rendered control also refuses.
  assert.deepEqual(ran(host), [queueCall('open-coordinator', repository, 'codex')]);
  assert.deepEqual(host.runs, [], 'the mod uses no direct Herdr command');
  replies[0](OK);
  await Promise.all([opening, duplicate]);
  const requestText = strings(host.render());
  assert.ok(requestText.includes('Requested Codex for this session.'));
  assert.ok(requestText.includes('Saved default: Claude Code'));
  assert.ok(!requestText.includes('Opening…'));

  const single = await scene({ runtime: 'codex', installed: ['codex'] });
  assert.ok(strings(single.render()).includes('Saved default: Codex'));
  assert.deepEqual(enabled(single.render()), [codex]);
  const nonGitHub = await decisionsScene({ ...panelCache([]), boards: [{ repository, folder: repository, cards: [], moves: false, places: false }] });
  await refuses(nonGitHub);
  assert.doesNotMatch(strings(nonGitHub.render()).join('\n'), /Saved default|Choose for this session/);

  const legacy = await decisionsScene(await refreshWith(() => collectorDocument({ board: { ...github, coordinator: undefined } })));
  await refuses(legacy, /Saved default unavailable\. Refresh after updating this project's Fabraik release\./);
  await refuses(await scene({ unread: 'settings could not be read' }), /settings could not be read/);
  for (const [runtime, savedLabel, installed, installedLabel, button] of [
    ['codex', 'Codex', 'claude', 'Claude Code', claude],
    ['claude', 'Claude Code', 'codex', 'Codex', codex],
  ]) {
    const unavailable = { runtime, installed: [installed] };
    const cache = await refreshWith(() => collectorDocument({ board: { ...github, coordinator: unavailable } }));
    assert.deepEqual(cache.boards[0].coordinator, unavailable, 'refresh keeps the unavailable saved default');
    for (const fallback of [await decisionsScene(cache), await scene(unavailable)]) {
      const view = fallback.render();
      assert.ok(strings(view).includes(`Saved default: ${savedLabel}`));
      assert.ok(strings(view).includes('The saved default is unavailable because it is not installed.'));
      assert.deepEqual(controls(view).map(controlName), [button]);
      assert.deepEqual(enabled(view), [button]);
      await fallback.click(named(view, button));
      assert.deepEqual(ran(fallback), [queueCall('open-coordinator', repository, installed)]);
      assert.ok(strings(fallback.render()).includes(`Requested ${installedLabel} for this session.`));
    }
  }
  const unknown = { runtime: 'other', installed: ['claude'] };
  const corrupt = await refreshWith(() => collectorDocument({ board: { ...github, coordinator: unknown } }));
  assert.deepEqual(corrupt.boards[0].coordinator, { unread: 'the queue reader returned invalid coordinator settings' });
  await refuses(await decisionsScene(corrupt), /invalid coordinator settings/);
  await refuses(await scene(unknown), /invalid coordinator settings/);
  const boardOutage = await refreshWith(() => collectorDocument({ board: null,
    sources: [{ name: 'board', ok: false, error: 'board access denied' }] }));
  await refuses(await decisionsScene(boardOutage), /board access denied/);
  const collectorOutage = await refreshWith(() => { throw new Error('collector stopped'); });
  await refuses(await decisionsScene(collectorOutage), /the queue reader failed: collector stopped/);

  const project = (tabs) => herdrSpace('s1', repository, tabs);
  const tab = herdrTab('s1-coordinator', 'Coordinator');
  const shell = herdrPane('p1', tab.id, null, SHELL_PROGRAM);
  for (const [spaces, panes] of [[[project([herdrTab('jobs', 'Jobs')])], []], [[project([tab])], [shell]]]) {
    const available = await scene();
    Object.assign(available, { spaceList: spaces, paneList: panes });
    assert.deepEqual(enabled(available.render()), [claude, codex]);
    assert.deepEqual(ran(available), []);
  }
  for (const state of ['working', 'idle', 'done', 'blocked', null]) {
    const live = await scene();
    Object.assign(live, { spaceList: [project([tab])], paneList: [herdrPane('p1', tab.id, state)] });
    await refuses(live, /Coordinator is already open\./);
  }
  for (const [spaces, panes] of [
    [[project([tab])], []],
    [[project([tab, tab])], [shell]],
    [[project([tab, herdrTab('s1-duplicate', 'Coordinator')])], [shell]],
    [[project([tab])], [shell, shell]],
    [[project([{ ...tab, id: null }])], [shell]],
    [[project([tab])], [{ ...shell, program: null }]],
    [[project([tab])], [herdrPane('p1', tab.id, null, { ...SHELL_PROGRAM, shell: false })]],
    [[project([tab])], [herdrPane('p1', tab.id, 'working', SHELL_PROGRAM)]],
  ]) {
    const unread = await scene();
    Object.assign(unread, { spaceList: spaces, paneList: panes });
    await refuses(unread, /Coordinator state unread: \S/);
  }
  const loading = await scene();
  loading.machineList = [{ name: null, layout: 'loading' }];
  await refuses(loading, /Coordinator state unread: Herdr is still loading/);

  for (const [code, cause] of /** @type {[number, string][]} */ ([[1, 'opener could not fetch settings'], [5, 'Coordinator is already open.']])) {
    const failed = await scene(saved, () => ({ code, stdout: code === 5 ? cause : '', stderr: code === 1 ? cause : '' }));
    const buttons = failed.render();
    if (code === 5) assert.deepEqual(enabled(buttons), [claude, codex]);
    await failed.click(named(buttons, claude));
    const result = failed.render();
    const lines = strings(result);
    const text = lines.join('\n');
    if (code === 5) {
      assert.ok(lines.includes(cause), text);
      assert.equal(colourOf(result, cause), 'muted');
    } else {
      assert.ok(text.includes(cause), text);
    }
    assert.doesNotMatch(text, /Requested Claude Code for this session|Opening…/);
    assert.deepEqual(ran(failed), [queueCall('open-coordinator', repository, 'claude')]);
    assert.deepEqual(failed.runs, []);
  }
});

// The cache's lines as a refresh writes them: the machine's first, then each repository's under its folder name.
const RECORD_LINE = 'not installed from a release';
const A_LINE = 'details could not be read: card 4: comments unavailable';
const B_LINE = 'details could not be read: card 9: comments unavailable';
const PROBLEMS_UNREADABLE = 'Project problems unreadable: the queue entry is not a list';
const projectProblemsCache = (fields = {}, boardFields = {}) => ({
  ...panelCache([]),
  problems: [RECORD_LINE, `a: ${A_LINE}`, `b: ${B_LINE}`],
  machineProblems: [RECORD_LINE],
  boards: [boardOf('a', [boardCard(1, 'Build it', 'Ready', 1)], { problems: [A_LINE], ...boardFields }), boardOf('b', [], { problems: [B_LINE] })],
  ...fields,
});

test("ANTI-REGRESSION: a Board draws its own project's problems and every machine-wide one, never another project's", async () => {
  for (const [project, own, others] of [['a', A_LINE, B_LINE], ['b', B_LINE, A_LINE]]) {
    const shown = strings((await boardScene(`/repos/${project}`, projectProblemsCache())).render());
    assert.ok(shown.some((text) => text.includes(own)), `Board ${project} draws its own problem: ${shown.join(' | ')}`);
    assert.ok(shown.some((text) => text.includes(RECORD_LINE)), `Board ${project} draws the machine's problem: ${shown.join(' | ')}`);
    assert.ok(!shown.some((text) => text.includes(others)), `Board ${project} draws no other project's problem: ${shown.join(' | ')}`);
  }
});

test('a Board with no board entry for its project because the machine record was not read says so, then the cause', async () => {
  const cause = 'Machine record unreadable: Unexpected end of JSON input';
  const tree = (await boardScene('/repos/a', { ...panelCache([]), problems: [cause], machineProblems: [cause], boards: [] })).render();
  const text = textOf(tree);
  const missing = text.indexOf('No board read for this project');
  assert.ok(missing >= 0, `the Board says no board was read for its project: ${strings(tree).join(' | ')}`);
  assert.ok(text.lastIndexOf(cause) > missing, `the record's cause follows it: ${strings(tree).join(' | ')}`);
  assert.deepEqual(boardColumns(tree), [], 'no column is drawn');
});

test('a Board with no board entry for its project because it has no queue reader says so, then its own cause and no other project\'s', async () => {
  const NO_READER = 'no queue reader: the Herdr add-on is off there or its release predates the panel';
  // As a refresh writes them: a readerless project has no board entry, and its cause is only in the whole list.
  const cache = {
    ...panelCache([]),
    problems: [RECORD_LINE, `a: ${NO_READER}`, `b: ${B_LINE}`, `c: ${NO_READER}`],
    machineProblems: [RECORD_LINE],
    boards: [boardOf('b', [], { problems: [B_LINE] })],
  };
  for (const [project, other] of [['a', 'c'], ['c', 'a']]) {
    const tree = (await boardScene(`/repos/${project}`, cache)).render();
    const text = textOf(tree);
    const shown = strings(tree).join(' | ');
    const missing = text.indexOf('No board read for this project');
    assert.ok(missing >= 0, `Board ${project} says no board was read for its project: ${shown}`);
    assert.ok(text.indexOf(NO_READER, missing) > missing, `Board ${project}'s own cause follows it: ${shown}`);
    assert.equal(text.split(NO_READER).length - 1, 1, `Board ${project} draws one no-reader cause, its own: ${shown}`);
    assert.ok(!text.includes(`${other}: ${NO_READER}`) && !text.includes(B_LINE), `Board ${project} draws no other project's cause: ${shown}`);
  }
});

test("a Board names its project's or the machine's problem list that is not a list instead of drawing none", async () => {
  for (const [why, cache] of [
    ['a board problems text', projectProblemsCache({}, { problems: 'details failed' })],
    ['a board problems object', projectProblemsCache({}, { problems: { 0: A_LINE } })],
    ['a machine problems text', projectProblemsCache({ machineProblems: RECORD_LINE })],
    ['a null machine problems', projectProblemsCache({ machineProblems: null })],
  ]) {
    const shown = strings((await boardScene('/repos/a', cache)).render());
    assert.ok(shown.some((text) => text.includes(PROBLEMS_UNREADABLE)), `${why}: ${PROBLEMS_UNREADABLE} is drawn: ${shown.join(' | ')}`);
  }
});

// new behaviour: a merge answer goes to the coordinator chat, so a card awaiting push says so until it merges. Card 60
// carries `answered: true`, the marker an older reader still sends where a card comment recorded the answer.
test('a Board card awaiting push says Awaiting your yes', async () => {
  const cards = [
    boardCard(60, 'Relayed merge', 'Awaiting push', 1, { waitsOn: 'merge', answered: true }),
    boardCard(61, 'Waiting merge', 'Awaiting push', 2, { waitsOn: 'merge' }),
  ];
  const tree = (await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', cards)] })).render();
  const lines = (card) => strings(boardCardOf(tree, card)).filter((line) => line === 'You answered this version' || line === 'Awaiting your yes');
  assert.deepEqual(lines(60), ['Awaiting your yes'], 'the relayed card still awaits your yes');
  assert.deepEqual(lines(61), ['Awaiting your yes'], 'the other card says what it said before');
});

test('the Board badges Ready cards by build rank, proposals unranked, and marks the first as next', async () => {
  const cards = [
    boardCard(5, 'Proposed: First idea', 'Ready', 1),
    boardCard(4, 'Top work', 'Ready', 2),
    boardCard(2, 'Second work', 'Ready', 3),
    boardCard(6, 'Third work', 'Ready', 4),
    boardCard(7, 'Not ready', 'Backlog', 1),
  ];
  const tree = (await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', cards)] })).render();
  const ready = boardColumnOf(tree, 'ready');
  assert.deepEqual(titlesIn(ready), ['Top work', 'Second work', 'Third work'], 'Ready holds its cards in build order');
  assert.deepEqual(strings(ready).filter((line) => BADGE.test(line)), ['Next, card 4', 'Card 2', 'Card 6'], 'the first ranked card is next');
  for (const [card, rank, fill, text] of [[4, '1', 'accent', 'accent_foreground'], [2, '2', 'selected', 'foreground'], [6, '3', 'selected', 'foreground']]) {
    const badge = pathTo(boardCardOf(tree, card), rank).at(-1);
    assert.deepEqual([called(badge, 'bg').at(-1)?.[0], called(badge, 'text_color').at(-1)?.[0]], [fill, text], `card ${card} carries rank ${rank} in ${fill}`);
  }
  assert.equal(colourOf(boardCardOf(tree, 4), 'Next, card 4'), 'foreground', 'the next label is in the foreground');
  assert.deepEqual(strings(boardColumnOf(tree, 'backlog')).filter((line) => BADGE.test(line) || /^\d+$/.test(line)), ['2'],
    'no card outside Ready carries a rank, the proposal included: the one number in Backlog is its count');
});

test('a Board blocker on the board links to its sheet, and one off the board is named without a link', async () => {
  const long = 'Base work '.repeat(12).trim();
  const cards = [boardCard(11, 'Needs both', 'Ready', 1, { blockers: [12, 3] }), boardCard(12, long, 'In progress', 1)];
  const host = await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', cards)] });
  const tree = host.render();
  const card = boardCardOf(tree, 11);
  const offBoard = 'card 3, not on this board, so the panel cannot open it';
  const shown = strings(card);
  for (const line of [offBoard, 'Blocked', 'Skipped until these blockers merge.']) assert.ok(shown.includes(line), `card 11 shows ${line}: ${shown.join(' | ')}`);
  const links = buttonsIn(card).filter((button) => button.elementId !== `${BOARD_ID}title-11`);
  const linkText = `card 12, ${long}`;
  assert.deepEqual(links.map(nameOf), [linkText], 'one link, to the blocker on the board');
  assert.ok(called(links[0], 'underline').length > 0, 'the link is underlined');
  assert.equal(colourOf(card, linkText), 'foreground', 'the link is in the foreground');
  assert.equal(called(links[0], 'max_w_full').length, 1, 'a name longer than the note is bounded by the note, not as wide as its text');
  assert.ok(!links[0].kids.includes(linkText) && links[0].kids.some((kid) => typeof kid !== 'string' && kid.kids.includes(linkText)),
    'the link holds its text in a child node that wraps inside the link');
  assert.deepEqual(called(pathTo(links[0], linkText).at(-1), 'line_height').at(-1), [1.4],
    "the link's text keeps the blocked note's line height, which the kit button resets");
  assert.ok(!buttonsIn(tree).some((button) => textOf(button).includes(offBoard)), 'the blocker off the board is no control');
  assert.equal(labelOf(titleOf(tree, 11)), '#11 Needs both. Blocked: waits for 12, 3', "the card's title names what it waits for");
  await host.click(links[0]);
  assert.equal(labelOf(nodeWithId(host.render(), SHEET_ID)), 'a card #12', "the link opens the blocker's own sheet");
});

// The expectation is written by hand from card #850's third criterion and the Needs you title seen cramped in the drive:
// a Board card's title, a Needs you entry's title and a merged entry's title all wrap at the card title's 19px line height.
test("every title on the Board wraps at the card title's line height", async () => {
  const merged = [{ sha: 'm2', at: localTime(12, 9, 5), subject: 'Merged one (#10)' }];
  const cards = [boardCard(4, 'Top work', 'Ready', 1), boardCard(5, 'Ship it', 'Awaiting push', 1, { waitsOn: 'merge' })];
  const host = await boardScene('/repos/a', { ...panelCache([queueItem('merge', 5)]), boards: [boardOf('a', cards, { merged })] });
  const tree = host.render();
  const titles = [
    ['a Board card', nodeWithId(tree, `${BOARD_ID}title-4`), 'Top work'],
    ['a Needs you entry', nodeWithId(tree, `${BOARD_ID}needs-${keyOf(5)}`), 'a5'],
    ['a merged entry', nodeWithId(tree, `${BOARD_ID}merged-m2`), 'Merged one (#10)'],
  ];
  for (const [what, opener, text] of titles) {
    assert.ok(opener, `${what} is drawn`);
    assert.deepEqual(called(pathTo(opener, text).at(-1), 'line_height').at(-1), ['19px'], `${what} wraps at the card title's line height`);
  }
});

test("the Board strip counts other projects' waiting items and opens each in place", async () => {
  const items = [
    inRepository('a', 'merge', 1),
    inRepository('b', 'merge', 5),
    inRepository('b', 'question', 6),
    inRepository('c', 'usage-limit', 2),
    inRepository('c', 'failure', 3),
    { ...digestEntry, repository: '/repos/b' },
  ];
  const boards = [
    boardOf('a', [boardCard(1, 'Ship a', 'Awaiting push', 1, { waitsOn: 'merge' })]),
    boardOf('b', [boardCard(5, 'Ship b', 'Awaiting push', 1, { waitsOn: 'merge' }), boardCard(6, 'Ask b', 'In progress', 1, { waitsOn: 'question' })]),
    boardOf('c', [boardCard(2, 'Stopped c', 'In progress', 1, { waitsOn: 'usage-limit' }), boardCard(3, 'Broke c', 'In progress', 2, { waitsOn: 'failure' })]),
  ];
  const host = await boardScene('/repos/a', { ...panelCache(items), boards });
  const tree = host.render();
  assert.ok(strings(tree).includes('Also waiting on you 4'), `the strip counts the other projects' waiting items: ${strings(tree).join(' | ')}`);
  const chips = (drawn) => buttonsIn(drawn).filter((button) => button.elementId?.startsWith(`${BOARD_ID}strip-`));
  assert.deepEqual(chips(tree).map(nameOf), ['b: merge card 5', 'b: question card 6', 'c: stopped card 2'], 'three chips, by short kind');
  assert.deepEqual(chips(tree).map(tooltipOf), ['Merge awaiting your yes, b card 5, b5', 'Blocking question, b card 6, b6', 'Stopped at a usage limit, c card 2, c2'],
    'each chip carries its full label as its tooltip');
  named(tree, '1 more');
  await host.click(chips(tree)[0]);
  assert.equal(labelOf(nodeWithId(host.render(), SHEET_ID)), 'b card #5', 'a chip opens its card in a sheet');
  assert.deepEqual(host.runs, [], 'in place, with no Herdr command');
  await host.press('escape');
  await host.click(named(host.render(), '1 more'));
  assert.deepEqual(host.overlays, [viewSpec('decisions', undefined)], 'the rest are in Decisions, over the window');
  assert.deepEqual(host.runs, [], 'which makes no space or tab');

  const alone = await boardScene('/repos/a', { ...panelCache([inRepository('a', 'merge', 1)]), boards });
  assert.ok(!strings(alone.render()).some((line) => line.startsWith('Also waiting on you')), 'no strip while nothing else waits');
});

test("the Board Needs you column lists this project's waiting items and their receipts", async () => {
  const items = [queueItem('merge', 5), queueItem('failure', 7), inRepository('b', 'question', 3)];
  const boards = [
    boardOf('a', [boardCard(7, 'Broke', 'In progress', 1, { waitsOn: 'failure' }), boardCard(5, 'Ship it', 'Awaiting push', 2, { waitsOn: 'merge' })]),
    boardOf('b', [boardCard(3, 'Asked', 'In progress', 1, { waitsOn: 'question' })]),
  ];
  const host = await boardScene('/repos/a', { ...panelCache(items), boards });
  const needs = () => boardColumnOf(host.render(), 'needs');
  const entries = (column) => buttonsIn(column).filter((button) => button.elementId?.startsWith(`${BOARD_ID}needs-`));
  assert.deepEqual(entries(needs()).map(labelOf), ['Merge awaiting your yes, card 5, a5', 'Run failed, card 7, a7'], "this project's items, in queue order");
  assert.deepEqual(strings(needs()).slice(0, 2), ['Needs you', '2'], 'the column counts them');
  for (const line of ['Ship it.', 'stopped']) assert.ok(strings(needs()).includes(line), `an item shows its summary ${line}`);

  await host.click(entries(needs())[1]);
  assert.equal(labelOf(nodeWithId(host.render(), SHEET_ID)), 'a card #7', 'an item opens its card in the sheet');
  await host.click(buttonOf(host.render(), keyOf(7), 'Dismiss'));
  await host.press('escape');
  assert.deepEqual(entries(needs()).map(labelOf), ['Merge awaiting your yes, card 5, a5'], 'a handled item is no longer an entry');
  for (const line of ['a card 7, a7', 'Dismissed']) assert.ok(strings(needs()).includes(line), `its receipt shows ${line}`);
  assert.deepEqual(strings(needs()).slice(0, 2), ['Needs you', '1'], 'the count leaves the handled item out');

  const empty = await boardScene('/repos/a', { ...panelCache([inRepository('b', 'question', 3)]), boards });
  assert.ok(strings(boardColumnOf(empty.render(), 'needs')).includes('Nothing waiting on you'), 'a project with nothing waiting says so');
});

test("the Board's Needs you claims no count and nothing waiting while some cards were not read", async () => {
  const incomplete = 'Not every card was read, so more may be waiting on you';
  const unreadCard = boardCard(3, 'Unread one', 'In progress', 1, { unread: 'its details were not read' });
  const readCard = boardCard(3, 'Read one', 'In progress', 1);
  for (const [why, items, cards, fields, cacheFields] of /** @type {[string, any[], any[], Record<string, any>?, Record<string, any>?][]} */ ([
    ['a card whose details were not read', [], [unreadCard]],
    ["its own project's problem item", [{ category: 'problem', repository: '/repos/a', problem: 'could not be read' }], [readCard]],
    ["its own project's problem line", [], [readCard], { problems: [A_LINE] }],
    ['a machine-wide problem line', [], [readCard], {}, { machineProblems: [RECORD_LINE] }],
    ['a source of what cards wait on that was not read', [], [readCard], { waitsOnUnread: ['worktrees'] }],
  ])) {
    const needs = boardColumnOf((await boardScene('/repos/a', { ...panelCache(items), ...cacheFields, boards: [boardOf('a', cards, fields)] })).render(), 'needs');
    const shown = strings(needs);
    assert.deepEqual(shown.slice(0, 2), ['Needs you', incomplete], `${why}: no count is drawn, the notice follows the header: ${shown.join(' | ')}`);
    assert.equal(colourOf(needs, incomplete), 'foreground', `${why}: the notice is a problem line`);
    assert.ok(!shown.includes('Nothing waiting on you'), `${why}: no column says nothing waits`);
  }

  const others = [{ category: 'problem', repository: '/repos/b', problem: 'could not be read' }];
  const shown = strings(boardColumnOf((await boardScene('/repos/a', { ...panelCache(others), boards: [boardOf('a', [readCard])] })).render(), 'needs'));
  assert.ok(!shown.includes(incomplete), `another project's problem item leaves the count: ${shown.join(' | ')}`);

  const waiting = await boardScene('/repos/a', { ...panelCache([queueItem('failure', 7)]), boards: [boardOf('a', [unreadCard])] });
  const column = boardColumnOf(waiting.render(), 'needs');
  assert.deepEqual(strings(column).slice(0, 2), ['Needs you', incomplete], 'with an item waiting the count is still left out');
  assert.equal(buttonsIn(column).filter((button) => button.elementId?.startsWith(`${BOARD_ID}needs-`)).length, 1, 'the waiting item still draws');
});

test('closing a sheet opened from a Needs you entry that became a receipt gives the keyboard to the view', async () => {
  const boards = [boardOf('a', [boardCard(7, 'Broke', 'In progress', 1, { waitsOn: 'failure' })])];
  const host = await boardScene('/repos/a', { ...panelCache([queueItem('failure', 7)]), boards });
  const entry = () => buttonsIn(boardColumnOf(host.render(), 'needs')).find((button) => button.elementId?.startsWith(`${BOARD_ID}needs-`));
  await host.click(entry());
  assert.equal(labelOf(nodeWithId(host.render(), SHEET_ID)), 'a card #7', 'the entry opens its card in the sheet');
  await host.click(buttonOf(host.render(), keyOf(7), 'Dismiss'));
  assert.equal(entry(), undefined, 'the handled item is a receipt, no longer an entry that tracks the sheet\'s return handle');
  await host.press('escape');
  assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, 'Esc closes the sheet');
  assert.ok(host.handles[0].is_focused(), 'the view holds the keyboard');
});

test("the Board Merged column lists the last day's merges and names a merge list it cannot read", async () => {
  const merged = [{ sha: 'm2', at: localTime(12, 9, 5), subject: 'Merged one (#10)' }, { sha: 'm1', at: localTime(11, 23, 59), subject: 'Old one (#11)' }];
  const host = await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', [], { merged })] });
  assert.deepEqual(strings(boardColumnOf(host.render(), 'merged')),
    ['Merged', '2 new', 'Mark all seen', 'Merged one (#10)', 'New', 'merged at 09:05', 'Mark as seen', 'Old one (#11)', 'New', 'merged at 23:59', 'Mark as seen'],
    'each merge of the last day with its time, the count of those still New and the controls that mark them seen');
  const titles = merged.map(({ sha }) => nodeWithId(host.render(), `${BOARD_ID}merged-${sha}`));
  assert.equal(titles.length, 2, 'the Merged column draws a title button for each merge');
  for (const [at, { subject }] of merged.entries()) {
    assert.equal(titles[at]?.kind, 'button', `the title of ${subject} is a button`);
    assert.deepEqual(strings(titles[at]), [subject], `the title of ${subject} holds only its subject`);
  }
  for (const [why, shape, line, colour] of [
    ['not read', null, 'Merges not read', 'foreground'],
    ['absent', undefined, 'Merges not in this read', 'foreground'],
    ['holding an entry it cannot read', [{ sha: 5 }], 'Merges unreadable: an entry is not one this view can read', 'foreground'],
    ['empty', [], 'Nothing merged in the last day', 'muted'],
  ]) {
    const tree = (await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', [], { merged: shape })] })).render();
    const column = boardColumnOf(tree, 'merged');
    assert.ok(strings(column).includes(line), `a merge list ${why}: ${strings(column).join(' | ')}`);
    assert.equal(colourOf(column, line), colour, `a merge list ${why} is in ${colour}`);
  }
});

test('a Board sheet opens from a card and gives focus back to it when it closes', async () => {
  const cards = [boardCard(2, 'Build it', 'Ready', 1), boardCard(5, 'Ship it', 'Awaiting push', 1, { waitsOn: 'merge' })];
  const host = await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', cards)] });
  for (const [name, close] of /** @type {[string, () => unknown][]} */ ([['Esc', () => host.press('escape')], ['Close', () => host.click(nodeWithId(host.render(), SHEET_CLOSE_ID))]])) {
    await host.click(titleOf(host.render(), 2));
    const tree = host.render();
    const sheet = nodeWithId(tree, SHEET_ID);
    assert.equal(labelOf(sheet), 'a card #2', `${name}: the title opens its card's sheet`);
    assert.ok(trackedFocused(sheet), `${name}: focus moves into the sheet`);
    assert.ok(strings(sheet).includes('Column: Ready'), `${name}: the sheet names the card's column: ${strings(sheet).join(' | ')}`);
    for (const card of [2, 5]) {
      assert.equal(titleOf(tree, card).click, null, `${name}: card ${card} takes no press while the sheet is open`);
      assert.equal(called(titleOf(tree, card), 'tab_stop').at(-1)?.[0], false, `${name}: card ${card} is no tab stop while the sheet is open`);
    }
    await close();
    const closed = host.render();
    assert.equal(nodeWithId(closed, SHEET_ID), undefined, `${name} closes the sheet`);
    assert.ok(trackedFocused(titleOf(closed, 2)), `${name} gives focus back to the card's title`);
  }
  assert.deepEqual(host.runs, [], 'the sheet runs no Herdr command');
  assert.ok(onlyRefreshes(host), 'the sheet runs no queue command but a refresh');
});

test('the Board names a tab without a project, a project the read lacks and an unreadable board instead of drawing one', async () => {
  const cards = [boardCard(2, 'Build it', 'Ready', 1)];
  const noProject = 'Board not shown: this tab names no project';
  for (const [why, repository, boards, line] of [
    ['a tab with no project', undefined, [boardOf('a', cards)], noProject],
    ['a tab whose project is not text', 7, [boardOf('a', cards)], noProject],
    ['a project the read lacks', '/repos/z', [boardOf('a', cards)], 'No board read for this project'],
    ['an unreadable board', '/repos/a', [boardOf('a', [], { unreadable: 'the board read failed' })], 'Board unreadable: the board read failed'],
    ['a card version that is not 64 hex', '/repos/a', [boardOf('a', [boardCard(2, 'Build it', 'Ready', 1, { version: 'abc' })])], UNREADABLE_ENTRY],
    ['a card version in capitals', '/repos/a', [boardOf('a', [boardCard(2, 'Build it', 'Ready', 1, { version: 'A'.repeat(64) })])], UNREADABLE_ENTRY],
    ['a moves flag that is not true or false', '/repos/a', [boardOf('a', cards, { moves: 'yes' })], UNREADABLE_ENTRY],
    ['a places flag that is not true or false', '/repos/a', [boardOf('a', cards, { places: 'yes' })], UNREADABLE_ENTRY],
  ]) {
    const tree = (await boardScene(repository, { ...panelCache([]), boards })).render();
    assert.ok(strings(tree).includes(line), `${why}: ${line} is drawn: ${strings(tree).join(' | ')}`);
    assert.equal(colourOf(tree, line), 'foreground', `${why}: the line is in the foreground`);
    assert.deepEqual(boardColumns(tree), [], `${why}: no column is drawn`);
  }
  const versioned = [boardOf('a', [boardCard(2, 'Build it', 'Ready', 1, { version: versionOf(2) })], { moves: true })];
  const readable = (await boardScene('/repos/a', { ...panelCache([]), boards: versioned })).render();
  assert.deepEqual(titlesIn(boardColumnOf(readable, 'ready')), ['Build it'], 'a card with a 64 hex version on a board with moves is drawn');
});

test("the Board shows the build order as not read, with no badge, where the cache's order is missing or malformed", async () => {
  const MALFORMED = "the cache's build order is malformed";
  const ready = (orders) => orders.map((order, index) => boardCard(index + 4, `Work ${index + 1}`, 'Ready', order));
  for (const [why, cards, fields, cause] of [
    ['a Ready order that is not a number', ready(['invalid']), {}, MALFORMED],
    ['a Ready card with no order', ready([undefined]), {}, MALFORMED],
    ['Ready orders that skip a place', ready([1, 3]), {}, MALFORMED],
    ['an order the cache says it could not read', ready([1, 2]), { orderUnread: 'the order file was not readable' }, 'the order file was not readable'],
  ]) {
    const column = boardColumnOf((await boardScene('/repos/a', { ...panelCache([]), boards: [boardOf('a', cards, fields)] })).render(), 'ready');
    const shown = strings(column);
    const line = `Order not read: ${cause}`;
    assert.ok(shown.includes(line), `${why}: ${line} is drawn under the Ready note: ${shown.join(' | ')}`);
    const note = shown.indexOf('Cards start from the top.');
    assert.ok(note >= 0, `${why}: the Ready note is drawn`);
    assert.equal(shown[note + 1], line, `${why}: the line follows the Ready note`);
    assert.deepEqual(shown.filter((text) => BADGE.test(text) || /^\d+$/.test(text)), [String(cards.length)],
      `${why}: no card carries a rank, the one number in Ready is its count`);
  }
});

// Board moves: the controls a GitHub board's cards carry and what a press runs and draws. The expected names, commands,
// lines and guards are written by hand from the plan's Moves and Move run contract and each fixture's own columns and
// places, never read off the panel. Each card carries its own version, so a neighbour's sent in its place would show.
const MOVED_TO_READY = 'Moved to Ready; the board confirms on its next read';
const NOT_GITHUB = 'Moves and Show me first not offered: the panel changes cards only on a GitHub board; change them in your tracker';
const OLD_READER = "Moves and Show me first not offered: this project's queue reader predates them";
const PLACES_OLD_READER = "Dragging a card within Ready to build not offered: this project's queue reader predates it";
const MOVE_NAME = /^Move card \S+ (to Ready|back to Backlog|up to place \d+)$/;
// Card 1 in Backlog, the proposal 2 beside it, cards 4 and 6 ranked 1 and 2 in Ready, card 8 in progress.
const MOVE_CARDS = [
  boardCard(1, 'Later', 'Backlog', 1, { version: versionOf(1) }),
  boardCard(2, 'Proposed: An idea', 'Backlog', 2, { version: versionOf(2) }),
  boardCard(4, 'Top work', 'Ready', 1, { version: versionOf(4) }),
  boardCard(6, 'Second work', 'Ready', 2, { version: versionOf(6) }),
  boardCard(8, 'Running', 'In progress', 1, { version: versionOf(8) }),
];
// The board a read gives once card 1 is in Ready, last in the build order.
const READIED_CARDS = [
  boardCard(2, 'Proposed: An idea', 'Backlog', 1, { version: versionOf(2) }),
  boardCard(4, 'Top work', 'Ready', 1, { version: versionOf(4) }),
  boardCard(6, 'Second work', 'Ready', 2, { version: versionOf(6) }),
  boardCard(1, 'Later', 'Ready', 3, { version: CHANGED }),
  boardCard(8, 'Running', 'In progress', 1, { version: versionOf(8) }),
];
const moveCache = (cards = MOVE_CARDS, fields = {}, items = []) => ({ ...panelCache(items), boards: [boardOf('a', cards, { moves: true, places: true, ...fields })] });
// A control's accessible name: its label, else its text.
const accessibleName = (button) => labelOf(button) ?? nameOf(button);
const moveNames = (tree) => buttonsIn(tree).map(accessibleName).filter((name) => MOVE_NAME.test(name)).sort();
// The queue.mjs command the stub exec was last asked to run.
const lastCommand = (host) => host.calls.at(-1)[1][1];
// Presses a drawn move control and settles what the press started, the refresh after it included.
function pressMove(host, name) {
  const button = named(host.render(), name);
  return host.task((cx) => button.click({}, cx));
}

test("a Board move press runs queue move with the card's key, its move and its drawn version, then refreshes", async () => {
  for (const [name, card, move] of [['Move card 1 to Ready', 1, 'ready'], ['Move card 4 back to Backlog', 4, 'backlog'], ['Move card 6 up to place 1', 6, 'up']]) {
    const host = await boardScene('/repos/a', moveCache());
    await pressMove(host, name);
    assert.deepEqual(ran(host), [queueCall('move', keyOf(card), move, versionOf(card)), queueCall('refresh', terminalList([]))],
      `${name} runs its move with card ${card}'s own version, then a refresh`);
  }
});

test('while a Board move runs or its line shows every Board move control is off, and the line clears once a later read lands', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const at = (ms) => new Date(ms).toISOString();
  const others = ['Move card 4 back to Backlog', 'Move card 6 back to Backlog', 'Move card 6 up to place 1'];
  const drawn = ['Move card 1 to Ready', ...others];
  const assertOff = (tree, names, off, why) => {
    for (const name of names) assert.equal(isDisabled(named(tree, name)), off, `${why}: ${name} is ${off ? 'off' : 'on'}`);
  };

  // 1. The move runs from noon to a minute past. The read after it began half a minute past, before the move's end, so
  // the line stays; a read begun at the move's end clears it.
  const end = NOON_12TH + 60_000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [{ ...moveCache(), readStartedAt: at(NOON_12TH + 30_000) }, { ...moveCache(READIED_CARDS), readStartedAt: at(end) }];
  const host = await boardScene('/repos/a', { ...moveCache(), readStartedAt: at(NOON_12TH - 60_000) }, async () => {
    if (lastCommand(host) === 'move') {
      await gate;
      return OK;
    }
    host.setCache(reads.shift());
    return OK;
  });
  const pressing = pressMove(host, 'Move card 1 to Ready');
  const during = host.render();
  assert.ok(isDisabled(named(during, 'Working')), 'the pressed control reads Working and is off');
  assertOff(during, others, true, 'while the move runs');
  t.mock.timers.tick(60_000);
  release();
  await pressing;
  const stale = host.render();
  assert.ok(strings(stale).includes(MOVED_TO_READY), `the success line shows: ${strings(stale).join(' | ')}`);
  assertOff(stale, drawn, true, 'through a read begun before the move ended');
  await host.task((cx) => host.panel.refresh(cx));
  const landed = host.render();
  assert.ok(!strings(landed).includes(MOVED_TO_READY), "a read begun at the move's end clears the line");
  const moved = ['Move card 1 back to Backlog', 'Move card 1 up to place 2', ...others].sort();
  assert.deepEqual(moveNames(landed), moved, 'the landed read draws card 1 in Ready, third');
  assertOff(landed, moved, false, 'once a later read landed');
  assert.equal(ran(host).filter(({ args }) => args[1] === 'move').length, 1, 'one move ran');

  // 2. A refresh that fails clears the line too, though the read loaded is still the one begun before the move ended.
  const outcomes = [
    (scene) => { scene.setCache({ ...moveCache(), readStartedAt: at(end - 1000) }); return OK; },
    () => ({ code: 1, stdout: '', stderr: 'the tracker could not be reached\n' }),
  ];
  const failing = await boardScene('/repos/a', { ...moveCache(), readStartedAt: at(NOON_12TH) }, async () => (
    lastCommand(failing) === 'move' ? OK : /** @type {(scene: PanelHost) => ExecResult} */ (outcomes.shift())(failing)));
  await pressMove(failing, 'Move card 1 to Ready');
  assert.ok(strings(failing.render()).includes(MOVED_TO_READY), 'the success line shows after the move');
  assertOff(failing.render(), drawn, true, 'while the line shows');
  await failing.task((cx) => failing.panel.refresh(cx));
  const cleared = failing.render();
  assert.ok(!strings(cleared).includes(MOVED_TO_READY), 'a failed refresh clears the line');
  assertOff(cleared, drawn, false, 'once a refresh failed');
});

test('a queue cache whose waiting item names no repository is unreadable, so the Board says so instead of failing', async () => {
  const boards = [boardOf('a', [boardCard(7, 'Broke', 'In progress', 1, { waitsOn: 'failure' })])];
  const tree = (await boardScene('/repos/a', { ...panelCache([queueItem('failure', 7, { repository: null })]), boards })).render();
  const line = 'Queue cache unreadable: an entry is not one this view can read';
  assert.ok(strings(tree).includes(line), `the Board says the cache is unreadable: ${strings(tree).join(' | ')}`);
  assert.deepEqual(boardColumns(tree), [], 'no column is drawn');
});

test('a refused Board move names its reason on its card', async () => {
  for (const [name, card, label] of [['Move card 1 to Ready', 1, 'Move to Ready'], ['Move card 4 back to Backlog', 4, 'Back to Backlog'], ['Move card 6 up to place 1', 6, 'Move up']]) {
    const refusal = `card ${card} changed since the panel drew it: refresh the queue`;
    const host = await boardScene('/repos/a', moveCache(), () => (lastCommand(host) === 'move' ? { code: 1, stdout: '', stderr: `${refusal}\n` } : OK));
    await pressMove(host, name);
    const tree = host.render();
    const line = `${label} failed: ${refusal}`;
    assert.ok(strings(boardCardOf(tree, card)).includes(line), `${name}: card ${card} names the refusal: ${strings(tree).join(' | ')}`);
    assert.equal(strings(tree).filter((text) => text === line).length, 1, `${name}: the refusal is drawn once, on its card`);
    assert.ok(!strings(tree).some((text) => text.startsWith('Moved ')), `${name}: a refused move draws no success line`);
  }
});

test("the Board offers no move where its project's moves, order or card details are not read, and still offers Back to Backlog where only the order is not", async () => {
  // Every card carries a version, so each refusal below stands on its own guard.
  const offered = async (cards, fields) => (await boardScene('/repos/a', moveCache(cards, fields))).render();
  const full = await offered(MOVE_CARDS);
  named(full, 'Move card 1 to Ready');
  assert.deepEqual(moveNames(full), ['Move card 1 to Ready', 'Move card 4 back to Backlog', 'Move card 6 back to Backlog', 'Move card 6 up to place 1'],
    'a GitHub board offers its moves, none on the proposal or the card in progress, and no Move up on rank 1');
  for (const line of [NOT_GITHUB, OLD_READER]) assert.ok(!strings(full).includes(line), `a GitHub board draws no "${line}"`);

  for (const [why, fields, line] of [['a board on another tracker', { moves: false }, NOT_GITHUB], ['a board from a reader that predates moves', { moves: undefined }, OLD_READER]]) {
    const tree = await offered(MOVE_CARDS, fields);
    assert.ok(strings(tree).includes(line), `${why}: ${line} is drawn: ${strings(tree).join(' | ')}`);
    assert.deepEqual(moveNames(tree), [], `${why}: no move is offered`);
  }
  assert.deepEqual(moveNames(await offered(MOVE_CARDS, { orderUnread: 'the order file was not readable' })),
    ['Move card 4 back to Backlog', 'Move card 6 back to Backlog'], 'an order not read: no Move to Ready and no Move up, Back to Backlog stays');
  const unread = MOVE_CARDS.map((card) => (card.card === 4 ? { ...card, unread: 'its details were not read' } : card));
  assert.deepEqual(moveNames(await offered(unread)), ['Move card 1 to Ready', 'Move card 6 back to Backlog', 'Move card 6 up to place 1'],
    'a card whose details were not read carries no control; the others keep theirs');
});

test("a GitHub board from a reader that predates places says once that dragging within Ready to build is not offered", async () => {
  const tree = (await boardScene('/repos/a', moveCache(MOVE_CARDS, { places: undefined }))).render();
  const drawn = strings(tree).filter((line) => line === PLACES_OLD_READER);
  assert.equal(drawn.length, 1, `the line is drawn once: ${strings(tree).join(' | ')}`);
  assert.equal(colourOf(tree, PLACES_OLD_READER), 'muted', 'the line is muted');
  for (const [why, cache] of [
    ['a default board', moveCache()],
    ['a board on another tracker', moveCache(MOVE_CARDS, { moves: false, places: undefined })],
    ['a board from a reader that predates moves', moveCache(MOVE_CARDS, { moves: undefined, places: undefined })],
  ]) {
    const other = (await boardScene('/repos/a', cache)).render();
    assert.ok(!strings(other).includes(PLACES_OLD_READER), `${why} draws no "${PLACES_OLD_READER}"`);
  }
});

test('a card with no column, drawn in Backlog, offers Move to Ready', async () => {
  const unsorted = boardCard(3, 'Unsorted', null, 1, { version: versionOf(3) });
  const tree = (await boardScene('/repos/a', moveCache([unsorted]))).render();
  assert.deepEqual(titlesIn(boardColumnOf(tree, 'backlog')), ['Unsorted'], 'the card is drawn in Backlog');
  assert.deepEqual(moveNames(tree), ['Move card 3 to Ready'], 'it offers Move to Ready like a Backlog card');
});

test("a Board move press keeps the keyboard on the moved card's title", async () => {
  const raised = [MOVE_CARDS[0], MOVE_CARDS[1], { ...MOVE_CARDS[3], order: 1 }, { ...MOVE_CARDS[2], order: 2 }, MOVE_CARDS[4]];
  for (const [name, card, after, ready] of /** @type {[string, number, any[], string[]][]} */ ([
    ['Move card 1 to Ready', 1, READIED_CARDS, ['Top work', 'Second work', 'Later']],
    ['Move card 6 up to place 1', 6, raised, ['Second work', 'Top work']],
  ])) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const host = await boardScene('/repos/a', moveCache(), async () => {
      if (lastCommand(host) === 'move') {
        await gate;
        return OK;
      }
      host.setCache(moveCache(after));
      return OK;
    });
    assert.ok(!trackedFocused(titleOf(host.render(), card)), `${name}: before the press card ${card}'s title does not hold the keyboard`);
    const pressing = pressMove(host, name);
    assert.ok(trackedFocused(titleOf(host.render(), card)), `${name}: the press moves the keyboard to card ${card}'s title`);
    release();
    await pressing;
    const tree = host.render();
    assert.deepEqual(titlesIn(boardColumnOf(tree, 'ready')), ready, `${name}: the read after the move draws the card in its new place`);
    assert.ok(trackedFocused(titleOf(tree, card)), `${name}: card ${card}'s title keeps the keyboard in its new place`);
  }
});

test("the Board's move controls are off while the side sheet is open", async () => {
  const host = await boardScene('/repos/a', moveCache());
  const names = ['Move card 1 to Ready', 'Move card 4 back to Backlog', 'Move card 6 back to Backlog', 'Move card 6 up to place 1'];
  for (const name of names) assert.ok(!isDisabled(named(host.render(), name)), `${name} is on while no sheet is open`);
  await host.click(titleOf(host.render(), 4));
  const open = host.render();
  assert.ok(nodeWithId(open, SHEET_ID), 'the title opens the sheet');
  for (const name of names) {
    assert.ok(isDisabled(named(open, name)), `${name} is off while the sheet is open`);
    await host.click(named(open, name));
  }
  assert.deepEqual(ran(host).filter(({ args }) => args[1] === 'move'), [], 'pressing a move control while the sheet is open runs no move');
  await host.press('escape');
  for (const name of names) assert.ok(!isDisabled(named(host.render(), name)), `${name} is on again once the sheet closed`);
});

// Board drags. The kit has no drag API, so the Board follows a drag through its cards', its columns' and its root's
// mouse handlers, which a test fires as the window does: a press fires the card's on_mouse_down, then the root's; a move
// fires the card under the pointer, then its column, then the root; a release fires the column's on_mouse_up, then the
// root's. Each event carries its position and the receiving element's own bounds, each handler gets the stub's cx with a
// notify that records the redraw it asks for, and the tree is drawn again only after a step that asked for one. The
// bounds, positions, places, marks and commands are written by hand from the plan's event model and gap rule, never read
// off the panel: Ready cards are 72 high with the list's 8 between them.
const DRAG_COLUMNS = { backlog: { x: 300, y: 100, width: 280, height: 600 }, ready: { x: 590, y: 100, width: 280, height: 600 } };
const readyAt = (rank) => ({ x: 598, y: 160 + 80 * (rank - 1), width: 264, height: 72 });
// Card 1 first in Backlog; cards 4, 6 and 7 at Ready ranks 1, 2 and 3.
const DRAG_CARDS = { 1: { x: 308, y: 160, width: 264, height: 72 }, 4: readyAt(1), 6: readyAt(2), 7: readyAt(3) };
const WINDOW_BOUNDS = { x: 0, y: 0, width: 1600, height: 900 };
const centreOf = (card) => ({ x: DRAG_CARDS[card].x + 132, y: DRAG_CARDS[card].y + 36 });
const topHalf = (card) => ({ x: 700, y: DRAG_CARDS[card].y + 18 });
const bottomHalf = (card) => ({ x: 700, y: DRAG_CARDS[card].y + 54 });
const BELOW_7 = { x: 700, y: 420 };
const BETWEEN_6_AND_7 = { x: 700, y: 316 };
// Between Backlog and Ready to build, in no column.
const OUTSIDE = { x: 585, y: 300 };
// Each column below its cards, and a point past the Board.
const IN_READY = { x: 700, y: 500 };
const IN_BACKLOG = { x: 440, y: 400 };
const PAST_BOARD = { x: 1700, y: 50 };
const PLACE_CARDS = [
  boardCard(1, 'Later', 'Backlog', 1, { version: versionOf(1) }),
  boardCard(4, 'Top work', 'Ready', 1, { version: versionOf(4) }),
  boardCard(6, 'Second work', 'Ready', 2, { version: versionOf(6) }),
  boardCard(7, 'Third work', 'Ready', 3, { version: versionOf(7) }),
];
const NO_MARKS = { outlined: [], filled: [], dim: [], marks: [] };
const inside = (point, box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
const handlerOf = (node, name) => called(node, name).at(-1)?.at(-1);
const boardCardsIn = (tree) => [...walk(tree)].map(([node]) => node).filter((node) => node.elementId?.startsWith(`${BOARD_ID}card-`));
const cardNumber = (node) => Number(node.elementId.slice(`${BOARD_ID}card-`.length));

// What a drag shows: the columns outlined in `accent`, the lists under the 8 percent `accent` fill, the cards drawn at
// 60 percent opacity, and each 2 high mark as its card and the edge it sits on.
function marked(tree) {
  const nodes = [...walk(tree)].map(([node]) => node);
  const ids = (prefix, test) => nodes.filter((node) => node.elementId?.startsWith(prefix) && test(node)).map((node) => node.elementId.slice(prefix.length));
  const edgeOf = (kid) => (typeof kid === 'string' || called(kid, 'absolute').length === 0 || called(kid, 'h').at(-1)?.[0] !== 2 ? null
    : called(kid, 'top').at(-1)?.[0] === 0 ? 'top' : called(kid, 'bottom').at(-1)?.[0] === 0 ? 'bottom' : null);
  return {
    outlined: ids(`${BOARD_ID}column-`, (node) => called(node, 'border_color').at(-1)?.[0] === 'accent'),
    filled: ids(`${BOARD_ID}list-`, (node) => called(node, 'bg').at(-1)?.[0] === 'accent14'),
    dim: boardCardsIn(tree).filter((node) => called(node, 'opacity').at(-1)?.[0] === 0.6).map(cardNumber),
    marks: boardCardsIn(tree).flatMap((node) => node.kids.map(edgeOf).filter((edge) => edge !== null).map((edge) => [cardNumber(node), edge])),
  };
}

// Fires a drag's events at a Board as the window does; `columnFirst` fires a move's column before its card. `asked` says
// whether the last step asked for a redraw, and `tree` is the tree drawn after the last step that did.
function dragOn(host, { columnFirst = false } = {}) {
  let asked = false;
  const cx = { ...host.cx, notify: () => { asked = true; } };
  const drag = { tree: host.render(), asked: false };
  const fire = (node, name, position, bounds) => handlerOf(node, name)?.({ button: 'left', click_count: 1, position, bounds }, cx);
  const settle = () => {
    drag.asked = asked;
    if (asked) drag.tree = host.render();
    asked = false;
  };
  const cardUnder = (position) => Object.keys(DRAG_CARDS).map(Number)
    .find((card) => inside(position, DRAG_CARDS[card]) && boardCardOf(drag.tree, card) !== undefined);
  const columnUnder = (position) => Object.keys(DRAG_COLUMNS).find((column) => inside(position, DRAG_COLUMNS[column]));
  drag.press = (card, position) => {
    if (card !== null) fire(boardCardOf(drag.tree, card), 'on_mouse_down', position, DRAG_CARDS[card]);
    fire(drag.tree, 'on_mouse_down', position, WINDOW_BOUNDS);
    settle();
  };
  drag.move = (position) => {
    const card = cardUnder(position);
    const column = columnUnder(position);
    const steps = [
      ...(card === undefined ? [] : [() => fire(boardCardOf(drag.tree, card), 'on_mouse_move', position, DRAG_CARDS[card])]),
      ...(column === undefined ? [] : [() => fire(boardColumnOf(drag.tree, column), 'on_mouse_move', position, DRAG_COLUMNS[column])]),
    ];
    for (const step of columnFirst ? steps.reverse() : steps) step();
    fire(drag.tree, 'on_mouse_move', position, WINDOW_BOUNDS);
    settle();
  };
  drag.release = async (position) => {
    const column = columnUnder(position);
    await host.task(() => {
      if (column !== undefined) fire(boardColumnOf(drag.tree, column), 'on_mouse_up', position, DRAG_COLUMNS[column]);
      fire(drag.tree, 'on_mouse_up', position, WINDOW_BOUNDS);
    });
    settle();
  };
  drag.pressOutside = (position) => {
    fire(drag.tree, 'on_mouse_down_out', position, WINDOW_BOUNDS);
    settle();
  };
  return drag;
}

// Presses `card` at its centre, moves it through `path` and releases it at the path's end.
async function dragCard(host, card, path, options) {
  const drag = dragOn(host, options);
  drag.press(card, centreOf(card));
  for (const point of path) drag.move(point);
  await drag.release(path.at(-1));
}

test('dropping a Backlog card on Ready to build or a Ready card on Backlog runs the queue move its button runs, then refreshes, and keeps the keyboard on its title', async () => {
  for (const [card, move, over] of [[1, 'ready', IN_READY], [4, 'backlog', IN_BACKLOG], [6, 'backlog', IN_BACKLOG]]) {
    const host = await boardScene('/repos/a', moveCache());
    await dragCard(host, card, [over]);
    assert.deepEqual(ran(host), [queueCall('move', keyOf(card), move, versionOf(card)), queueCall('refresh', terminalList([]))],
      `card ${card} dropped on ${move} runs its ${move} move with its own version, then a refresh`);
    assert.ok(trackedFocused(titleOf(host.render(), card)), `card ${card}'s title holds the keyboard after the drop`);
  }
});

test('dropping a Ready card among the others runs queue move place with the place it takes, and a drop at its own place runs nothing', async () => {
  for (const columnFirst of [false, true]) {
    for (const [card, path, place] of [
      [4, [bottomHalf(7)], '3'],
      [4, [topHalf(7)], '2'],
      [7, [topHalf(4)], '1'],
      [7, [bottomHalf(4)], '2'],
      [6, [topHalf(6)], null],
      [6, [topHalf(7)], null],
      [4, [topHalf(7), BELOW_7], '3'],
      [4, [topHalf(6), BETWEEN_6_AND_7], '2'],
    ]) {
      const host = await boardScene('/repos/a', moveCache(PLACE_CARDS));
      await dragCard(host, card, path, { columnFirst });
      const expected = place === null ? [] : [queueCall('move', keyOf(card), 'place', versionOf(card), place), queueCall('refresh', terminalList([]))];
      assert.deepEqual(ran(host), expected,
        `${columnFirst ? 'column first' : 'card first'}: card ${card} through ${JSON.stringify(path)} runs ${place === null ? 'nothing' : `place ${place}`}`);
    }
  }
});

test('a refused place drop names Move to place and its reason on its card', async () => {
  const refusal = 'card 4 changed since the panel drew it: refresh the queue';
  const host = await boardScene('/repos/a', moveCache(PLACE_CARDS), () => (lastCommand(host) === 'move' ? { code: 1, stdout: '', stderr: `${refusal}\n` } : OK));
  await dragCard(host, 4, [bottomHalf(7)]);
  const tree = host.render();
  const line = `Move to place 3 failed: ${refusal}`;
  assert.ok(strings(boardCardOf(tree, 4)).includes(line), `card 4 names the refusal: ${strings(tree).join(' | ')}`);
  assert.equal(strings(tree).filter((text) => text === line).length, 1, 'the refusal is drawn once, on its card');
  assert.ok(!strings(tree).some((text) => text.startsWith('Moved ')), 'a refused drop draws no success line');
});

test('while a card is dragged over a column that would take it the column is outlined and filled, the card dims and Ready marks where it goes, and anywhere else nothing is marked', async () => {
  const host = await boardScene('/repos/a', moveCache());
  const drag = dragOn(host);
  assert.deepEqual(marked(drag.tree), NO_MARKS, 'nothing is marked before a drag');
  drag.press(1, centreOf(1));
  drag.move(IN_READY);
  assert.deepEqual(marked(drag.tree), { outlined: ['ready'], filled: ['ready'], dim: [1], marks: [[6, 'bottom']] },
    'card 1 over Ready: Ready outlined and filled, card 1 dim, the mark under the last card');
  drag.move(OUTSIDE);
  assert.deepEqual(marked(drag.tree), NO_MARKS, 'card 1 outside every column marks nothing');
  drag.move(IN_BACKLOG);
  assert.deepEqual(marked(drag.tree), NO_MARKS, 'card 1 over its own Backlog marks nothing');
  await drag.release(IN_BACKLOG);
  drag.press(6, centreOf(6));
  drag.move(topHalf(4));
  assert.deepEqual(marked(drag.tree), { outlined: ['ready'], filled: ['ready'], dim: [6], marks: [[4, 'top']] },
    "card 6 over card 4's top half: Ready outlined and filled, card 6 dim, the mark over card 4");
  drag.move(IN_BACKLOG);
  assert.deepEqual(marked(drag.tree), { outlined: ['backlog'], filled: ['backlog'], dim: [6], marks: [] },
    'card 6 over Backlog: Backlog outlined and filled, card 6 dim, no mark');
  assert.deepEqual(ran(host), [], 'a release over a column that would not take the card runs nothing');
});

test('a release away from a column that takes the card, Esc from the press on, or a press after a release the Board never saw ends the drag with no move', async () => {
  for (const [why, end, drop] of /** @type {[string, (drag: any, host?: any) => unknown, boolean][]} */ ([
    ['a release outside every column', async (drag) => { drag.move(OUTSIDE); await drag.release(OUTSIDE); }, false],
    ['Esc', (_drag, host) => host.press('escape'), true],
    ['a press elsewhere on the Board', (drag) => drag.press(null, IN_READY), true],
    ['a press outside the Board', (drag) => drag.pressOutside(PAST_BOARD), true],
  ])) {
    const host = await boardScene('/repos/a', moveCache());
    const drag = dragOn(host);
    drag.press(1, centreOf(1));
    drag.move(IN_READY);
    assert.deepEqual(marked(drag.tree).outlined, ['ready'], `${why}: card 1 over Ready is taken first`);
    await end(drag, host);
    if (drop) {
      await drag.release(IN_READY);
    } else {
      drag.move(IN_READY);
      assert.deepEqual(marked(drag.tree), NO_MARKS, `${why}: over Ready afterwards nothing is marked`);
    }
    assert.deepEqual(ran(host), [], `${why}: no move runs`);
  }

  const host = await boardScene('/repos/a', moveCache());
  const drag = dragOn(host);
  drag.press(1, centreOf(1));
  assert.ok(drag.asked, "the press asks for a redraw, which draws the Board's Esc");
  assert.ok(trackedFocused(drag.tree), 'the press gives the keyboard to the Board');
  drag.move(IN_BACKLOG);
  await host.press('escape');
  drag.move(IN_READY);
  assert.deepEqual(marked(drag.tree), NO_MARKS, 'Esc before any target: over Ready afterwards nothing is marked');
  await drag.release(IN_READY);
  assert.deepEqual(ran(host), [], 'Esc before any target: the drop on Ready runs no move');
});

test('only a card with a move control that is on drags', async () => {
  const draggable = (tree) => boardCardsIn(tree)
    .filter((node) => called(node, 'cursor_grab').length > 0 && called(node, 'on_mouse_down').length > 0).map(cardNumber).sort((a, b) => a - b);
  const drawn = async (cards, fields) => (await boardScene('/repos/a', moveCache(cards, fields))).render();
  const unread = MOVE_CARDS.map((card) => (card.card === 4 ? { ...card, unread: 'its details were not read' } : card));
  for (const [why, tree, cards] of [
    ['a GitHub board', await drawn(MOVE_CARDS), [1, 4, 6]],
    ['a board on another tracker', await drawn(MOVE_CARDS, { moves: false }), []],
    ['an order not read', await drawn(MOVE_CARDS, { orderUnread: 'the order file was not readable' }), [4, 6]],
    ['card 4 not read', await drawn(unread), [1, 6]],
  ]) assert.deepEqual(draggable(tree), cards, `${why}: the cards that drag`);

  const sheet = await boardScene('/repos/a', moveCache());
  await sheet.click(titleOf(sheet.render(), 4));
  assert.deepEqual(draggable(sheet.render()), [], 'no card drags while the side sheet is open');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = await boardScene('/repos/a', moveCache(), async () => {
    if (lastCommand(running) === 'move') await gate;
    return OK;
  });
  const pressing = pressMove(running, 'Move card 1 to Ready');
  assert.deepEqual(draggable(running.render()), [], 'no card drags while a move runs');
  release();
  await pressing;
});

test("a press on a card's move button or Show me first switch stops there, starts no drag and ends one in progress", async () => {
  const host = await boardScene('/repos/a', moveCache(SHOW_CARDS));
  const press = (node) => handlerOf(node, 'on_mouse_down')({ button: 'left', click_count: 1, position: centreOf(4) }, host.cx);
  const tree = host.render();
  const controls = [['move button', named(tree, 'Move card 4 back to Backlog')], ['Show me first switch', switchOf(tree, 4)]];
  for (const [what, control] of controls) {
    const before = host.stopped;
    press(control);
    assert.equal(host.stopped, before + 1, `a press on the ${what} stops there`);
    const drag = dragOn(host);
    drag.move(IN_BACKLOG);
    assert.deepEqual(marked(host.render()), NO_MARKS, `a press on the ${what} holds no drag`);
  }

  const drag = dragOn(host);
  drag.press(4, centreOf(4));
  drag.move(IN_BACKLOG);
  assert.deepEqual(marked(drag.tree).outlined, ['backlog'], "card 4's own press holds a drag over Backlog");
  press(controls[0][1]);
  drag.move(IN_BACKLOG);
  assert.deepEqual(marked(host.render()), NO_MARKS, "a press on a card's move button ends the drag in progress");
  assert.deepEqual(ran(host), [], 'no move runs');
});

test('on a board whose reader predates places a Ready card drags only to Backlog', async () => {
  const host = await boardScene('/repos/a', moveCache(MOVE_CARDS, { places: undefined }));
  const drag = dragOn(host);
  drag.press(6, centreOf(6));
  drag.move(topHalf(4));
  assert.deepEqual(marked(drag.tree), NO_MARKS, "card 6 over card 4's top half marks nothing");
  await drag.release(topHalf(4));
  assert.deepEqual(ran(host), [], 'a drop within Ready to build runs nothing');
  drag.press(6, centreOf(6));
  drag.move(IN_BACKLOG);
  assert.deepEqual(marked(drag.tree).outlined, ['backlog'], 'card 6 over Backlog is outlined');
});

// Show me first: the switch a GitHub board's Ready to build and In progress cards, and their Board sheets, carry. The
// expected lines, names, ids, commands and states are written by hand from the plan's S3 section, its S4 pattern bullet
// and its Visual direction, never read off the panel: the switch draws the marker its read gives, a press writes the
// opposite state, and an unread marker is a line in its place, never a switch drawn off.
const SHOW_FIRST_OLD_READER = "Show me first not offered: this project's queue reader predates it";
const SHOW_FIRST_QUEUED = 'If its merge is already queued, Show me first does not stop it: use Disable auto-merge on its pull request';
const TURNED_ON = 'Show me first turned on; the board confirms on its next read';
const SHOW_FIRST_NOT_READ = 'Show me first not read: its labels are not text';
const SHEET_SHOW_FIRST_ID = `${FLOOR_ID}sheet-show-first`;
// Card 1, marked, in Backlog; the proposal 2 in the Ready column, which the Board draws in Backlog; cards 4, marked, and
// 6 ranked 1 and 2 in Ready; card 8, marked, in progress; card 7 merging; card 5 awaiting a yes, its labels not read.
const SHOW_CARDS = [
  boardCard(1, 'Later', 'Backlog', 1, { version: versionOf(1), showFirst: true }),
  boardCard(2, 'Proposed: An idea', 'Ready', 1, { version: versionOf(2), showFirst: false }),
  boardCard(4, 'Top work', 'Ready', 2, { version: versionOf(4), showFirst: true }),
  boardCard(6, 'Second work', 'Ready', 3, { version: versionOf(6), showFirst: false }),
  boardCard(8, 'Running', 'In progress', 1, { version: versionOf(8), showFirst: true }),
  boardCard(7, 'Merging one', 'In review', 1, { version: versionOf(7), showFirst: false }),
  boardCard(5, 'Ship it', 'Awaiting push', 1, { version: versionOf(5), showFirst: { unread: 'its labels are not text' } }),
];
const SWITCH_CARDS = [4, 6, 7, 8];
const SHOW_MOVES = ['Move card 1 to Ready', 'Move card 4 back to Backlog', 'Move card 6 back to Backlog', 'Move card 6 up to place 1'];
// SHOW_CARDS with one card's marker replaced; undefined leaves the field out of the cache, as a reader that predates it does.
const markedAs = (number, showFirst) => SHOW_CARDS.map((card) => (card.card === number ? { ...card, showFirst } : card));
const switchesIn = (node) => nodesOf(node, 'toggle');
const checkedOf = (toggle) => called(toggle, 'pressed').at(-1)?.[0];
// A switch's words, its parts joined: "Show me first: on", "Show me first: off" or "Working".
const switchText = (toggle) => strings(toggle).join(' ').replace(/\s+/g, ' ').trim();
const isSemibold = (node, text) => pathTo(node, text).some((found) => called(found, 'font_semibold').length > 0);
const drawOrder = (tree, node) => [...walk(tree)].findIndex(([found]) => found === node);
const showFirstCalls = (host) => ran(host).filter(({ args }) => args[1] === 'show-first');

function switchOf(tree, card) {
  const found = nodeWithId(tree, `${BOARD_ID}show-first-${card}`);
  assert.equal(found?.kind, 'toggle', `card ${card} draws a Show me first toggle`);
  return found;
}

function sheetSwitchOf(tree) {
  const found = nodeWithId(nodeWithId(tree, SHEET_ID), SHEET_SHOW_FIRST_ID);
  assert.equal(found?.kind, 'toggle', 'the sheet draws a Show me first toggle');
  return found;
}

// Presses a drawn switch as the kit does, handing its change handler the opposite of the state it draws, unless it is
// off, and settles what the press started, the refresh after it included.
function pressSwitch(host, toggle) {
  const change = called(toggle, 'on_change').at(-1)?.[0];
  return host.task((cx) => { if (!isDisabled(toggle)) change(!checkedOf(toggle), cx); });
}

test('ANTI-REGRESSION: a Board card shows Show me first as its read holds it, says when its marker was not read and never draws that as off', async () => {
  const tree = (await boardScene('/repos/a', moveCache(SHOW_CARDS))).render();
  for (const [card, on] of [[4, true], [6, false], [8, true], [7, false]]) {
    const toggle = switchOf(tree, card);
    const word = on ? 'on' : 'off';
    assert.equal(checkedOf(toggle), on, `card ${card}'s switch is ${word}, as its read gives`);
    assert.equal(switchText(toggle), `Show me first: ${word}`, `card ${card}'s switch says its state in words`);
    assert.ok(isSemibold(toggle, word), `card ${card}'s state word is semibold`);
    assert.ok(!isSemibold(toggle, strings(toggle).find((text) => text.trim().startsWith('Show me first'))), `card ${card}'s switch name is not`);
    assert.equal(labelOf(toggle), `Show me first for card ${card}`, `card ${card}'s switch is named for its card`);
    assert.ok(!isDisabled(toggle), `card ${card}'s switch is on while nothing runs`);
    const [, row] = [...walk(boardCardOf(tree, card))].find(([node]) => node === toggle);
    assert.equal(row.kids.at(-1), toggle, `card ${card}'s switch is last in its control row`);
    assert.ok(called(row, 'flex_wrap').length > 0 && called(row, 'gap').at(-1)?.[0] === 6, `card ${card}'s control row wraps with a gap of 6`);
  }
  const [, row6] = [...walk(boardCardOf(tree, 6))].find(([node]) => node === switchOf(tree, 6));
  assert.deepEqual(buttonsIn(row6).map(accessibleName), ['Move card 6 back to Backlog', 'Move card 6 up to place 1'], "card 6's switch shares the row of its moves");
  assert.deepEqual(switchesIn(tree).map(labelOf).sort(), SWITCH_CARDS.map((card) => `Show me first for card ${card}`),
    'only the Ready to build and In progress cards whose marker was read carry a switch: none on Backlog, the proposal or card 5');

  const unread = boardCardOf(tree, 5);
  assert.ok(strings(unread).includes(SHOW_FIRST_NOT_READ), `card 5 says its marker was not read: ${strings(unread).join(' | ')}`);
  assert.equal(colourOf(unread, SHOW_FIRST_NOT_READ), 'foreground', 'the not-read line is a problem line');
  assert.equal(sizeOf(unread, SHOW_FIRST_NOT_READ), 12, 'the not-read line is 12');
  assert.ok(!strings(unread).some((text) => /^(on|off)$/.test(text.trim()) || text.includes('Show me first:')), 'card 5 draws no state, never off');
  assert.equal(strings(tree).filter((text) => text.startsWith('Show me first not read')).length, 1, 'only card 5 says its marker was not read');

  const merging = boardCardOf(tree, 7);
  const queued = pathTo(merging, SHOW_FIRST_QUEUED).at(-1);
  assert.equal(colourOf(merging, SHOW_FIRST_QUEUED), 'muted', 'the In review line is muted');
  assert.equal(sizeOf(merging, SHOW_FIRST_QUEUED), 12, 'the In review line is 12');
  assert.ok(drawOrder(merging, queued) > drawOrder(merging, switchOf(tree, 7)), 'the In review line is under its switch');
  assert.equal(strings(tree).filter((text) => text === SHOW_FIRST_QUEUED).length, 1, 'only the In review card says a queued merge is not stopped');
  for (const line of [NOT_GITHUB, OLD_READER, SHOW_FIRST_OLD_READER]) assert.ok(!strings(tree).includes(line), `a board whose cards all carry their marker draws no "${line}"`);

  for (const [why, cards, fields, line, switches] of /** @type {[string, any[], Record<string, any>, string, number[]][]} */ ([
    ['a board on another tracker', SHOW_CARDS, { moves: false }, NOT_GITHUB, []],
    ['a reader that predates moves', SHOW_CARDS, { moves: undefined }, OLD_READER, []],
    ['a reader that predates Show me first on one card', markedAs(4, undefined), {}, SHOW_FIRST_OLD_READER, [6, 7, 8]],
  ])) {
    const notes = (await boardScene('/repos/a', moveCache(cards, fields))).render();
    assert.ok(strings(notes).includes(line), `${why}: ${line} is drawn: ${strings(notes).join(' | ')}`);
    assert.equal(colourOf(notes, line), 'muted', `${why}: the line is muted`);
    for (const other of [NOT_GITHUB, OLD_READER, SHOW_FIRST_OLD_READER].filter((text) => text !== line)) {
      assert.ok(!strings(notes).includes(other), `${why}: no "${other}"`);
    }
    assert.deepEqual(switchesIn(notes).map(labelOf).sort(), switches.map((card) => `Show me first for card ${card}`), `${why}: the switches drawn`);
  }

  for (const showFirst of ['on', null, { unread: 3 }, { unread: 'x', more: true }]) {
    const malformed = (await boardScene('/repos/a', moveCache(markedAs(4, showFirst)))).render();
    assert.ok(strings(malformed).includes(UNREADABLE_ENTRY), `a marker of ${JSON.stringify(showFirst)} makes the board unreadable: ${strings(malformed).join(' | ')}`);
    assert.deepEqual(boardColumns(malformed), [], `a marker of ${JSON.stringify(showFirst)}: no column is drawn`);
  }
});

test("a Show me first press runs queue show-first with the card's key and the state pressed, keeps the keyboard on its title, then refreshes", async () => {
  for (const [card, state] of [[4, 'off'], [6, 'on'], [8, 'off'], [7, 'on']]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const host = await boardScene('/repos/a', moveCache(SHOW_CARDS), async () => {
      if (lastCommand(host) === 'show-first') await gate;
      return OK;
    });
    assert.ok(!trackedFocused(titleOf(host.render(), card)), `card ${card}: before the press its title does not hold the keyboard`);
    const pressing = pressSwitch(host, switchOf(host.render(), card));
    assert.ok(trackedFocused(titleOf(host.render(), card)), `card ${card}: the press moves the keyboard to its title`);
    release();
    await pressing;
    assert.deepEqual(ran(host), [queueCall('show-first', keyOf(card), state), queueCall('refresh', terminalList([]))],
      `card ${card}: the press writes ${state} with its own key, then a refresh`);
    assert.ok(trackedFocused(titleOf(host.render(), card)), `card ${card}: its title keeps the keyboard through the refresh`);
  }
});

test('while Show me first runs or its line shows every Board control is off and the switch draws the written state, until a later read lands', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const at = (ms) => new Date(ms).toISOString();
  const assertOff = (tree, off, why) => {
    for (const name of SHOW_MOVES) assert.equal(isDisabled(named(tree, name)), off, `${why}: ${name} is ${off ? 'off' : 'on'}`);
    for (const card of SWITCH_CARDS) assert.equal(isDisabled(switchOf(tree, card)), off, `${why}: card ${card}'s switch is ${off ? 'off' : 'on'}`);
  };
  const turnedOn = markedAs(6, true);

  // 1. Card 6 is turned on from noon to a minute past. The read after it began half a minute past, before the write's
  // end, and still gives off; a read begun at the write's end clears the line.
  const end = NOON_12TH + 60_000;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [{ ...moveCache(SHOW_CARDS), readStartedAt: at(NOON_12TH + 30_000) }, { ...moveCache(turnedOn), readStartedAt: at(end) }];
  const host = await boardScene('/repos/a', { ...moveCache(SHOW_CARDS), readStartedAt: at(NOON_12TH - 60_000) }, async () => {
    if (lastCommand(host) === 'show-first') {
      await gate;
      return OK;
    }
    host.setCache(reads.shift());
    return OK;
  });
  const pressing = pressSwitch(host, switchOf(host.render(), 6));
  const during = host.render();
  assert.equal(switchText(switchOf(during, 6)), 'Working', 'the pressed switch reads Working');
  assertOff(during, true, 'while Show me first runs');
  t.mock.timers.tick(60_000);
  release();
  await pressing;
  const stale = host.render();
  assert.ok(strings(boardCardOf(stale, 6)).includes(TURNED_ON), `the success line shows on card 6: ${strings(stale).join(' | ')}`);
  assert.equal(checkedOf(switchOf(stale, 6)), true, 'the switch draws the written state, on, though the read still gives off');
  assert.equal(switchText(switchOf(stale, 6)), 'Show me first: on', 'the switch says the written state');
  assertOff(stale, true, 'through a read begun before the write ended');
  await host.task((cx) => host.panel.refresh(cx));
  const landed = host.render();
  assert.ok(!strings(landed).includes(TURNED_ON), "a read begun at the write's end clears the line");
  assert.equal(checkedOf(switchOf(landed, 6)), true, 'the landed read gives on');
  assertOff(landed, false, 'once a later read landed');
  assert.deepEqual(showFirstCalls(host), [queueCall('show-first', keyOf(6), 'on')], 'one write ran');

  // 2. A refresh that fails clears the line too, and the switch draws the read loaded, begun before the write ended.
  const outcomes = [
    (scene) => { scene.setCache({ ...moveCache(SHOW_CARDS), readStartedAt: at(end - 1000) }); return OK; },
    () => ({ code: 1, stdout: '', stderr: 'the tracker could not be reached\n' }),
  ];
  const failing = await boardScene('/repos/a', { ...moveCache(SHOW_CARDS), readStartedAt: at(NOON_12TH) }, async () => (
    lastCommand(failing) === 'show-first' ? OK : /** @type {(scene: PanelHost) => ExecResult} */ (outcomes.shift())(failing)));
  await pressSwitch(failing, switchOf(failing.render(), 6));
  assert.ok(strings(failing.render()).includes(TURNED_ON), 'the success line shows after the write');
  assert.equal(checkedOf(switchOf(failing.render(), 6)), true, 'the switch draws the written state while the line shows');
  assertOff(failing.render(), true, 'while the line shows');
  await failing.task((cx) => failing.panel.refresh(cx));
  const cleared = failing.render();
  assert.ok(!strings(cleared).includes(TURNED_ON), 'a failed refresh clears the line');
  assert.equal(checkedOf(switchOf(cleared, 6)), false, 'once nothing confirms the write the switch draws the read it has, off');
  assertOff(cleared, false, 'once a refresh failed');

  // 3. A move of a marked card leaves its switch on its read state: Move up on card 6, marked, runs and succeeds, and
  // its switch says on throughout, never Working.
  let releaseMove;
  const moveGate = new Promise((resolve) => { releaseMove = resolve; });
  const marked = await boardScene('/repos/a', { ...moveCache(turnedOn), readStartedAt: at(end - 60_000) }, async () => {
    if (lastCommand(marked) === 'move') {
      await moveGate;
      return OK;
    }
    marked.setCache({ ...moveCache(turnedOn), readStartedAt: at(end - 1000) });
    return OK;
  });
  const moving = pressMove(marked, 'Move card 6 up to place 1');
  const running = marked.render();
  assert.equal(switchText(switchOf(running, 6)), 'Show me first: on', 'a move of card 6 leaves its switch saying its state, not Working');
  assert.ok(isDisabled(switchOf(running, 6)), "card 6's switch is off while its move runs");
  releaseMove();
  await moving;
  const moved = marked.render();
  assert.ok(strings(moved).includes('Moved up; the board confirms on its next read'), `the move's line shows: ${strings(moved).join(' | ')}`);
  assert.equal(checkedOf(switchOf(moved, 6)), true, "through the move's success line card 6's switch still draws on");
  assert.equal(switchText(switchOf(moved, 6)), 'Show me first: on', "through the move's success line card 6's switch still says on");
});

test('a refused Show me first names its reason on its card', async () => {
  for (const [card, state] of [[6, 'on'], [8, 'off']]) {
    const refusal = `card ${card} is in Backlog, not Ready or In progress`;
    const host = await boardScene('/repos/a', moveCache(SHOW_CARDS), () => (lastCommand(host) === 'show-first' ? { code: 1, stdout: '', stderr: `${refusal}\n` } : OK));
    await pressSwitch(host, switchOf(host.render(), card));
    const tree = host.render();
    const line = `Show me first failed: ${refusal}`;
    assert.deepEqual(showFirstCalls(host), [queueCall('show-first', keyOf(card), state)], `card ${card}: the press wrote ${state}`);
    assert.ok(strings(boardCardOf(tree, card)).includes(line), `card ${card} names the refusal: ${strings(tree).join(' | ')}`);
    assert.equal(colourOf(boardCardOf(tree, card), line), 'foreground', `card ${card}: the refusal is a problem line`);
    assert.equal(strings(tree).filter((text) => text === line).length, 1, `card ${card}: the refusal is drawn once, on its card`);
    assert.ok(!strings(tree).some((text) => text.startsWith('Show me first turned ')), `card ${card}: a refused write draws no success line`);
    assert.equal(checkedOf(switchOf(tree, card)), state === 'off', `card ${card}: the switch keeps the state its read gives`);
    assert.ok(!isDisabled(switchOf(tree, card)), `card ${card}: the switch is on again after the refusal`);
  }
});

test("the side sheet of a Board card in Ready or In progress offers Show me first and keeps the keyboard in the sheet, while the Board's switches are off", async () => {
  const host = await boardScene('/repos/a', moveCache(SHOW_CARDS));
  for (const [card, on, column] of [[6, false, 'Ready'], [8, true, 'In progress'], [7, false, 'In review']]) {
    await host.click(titleOf(host.render(), card));
    const tree = host.render();
    const sheet = nodeWithId(tree, SHEET_ID);
    const toggle = sheetSwitchOf(tree);
    assert.equal(labelOf(toggle), `Show me first for card ${card}`, `card ${card}: the sheet's switch is named for its card`);
    assert.equal(checkedOf(toggle), on, `card ${card}: the sheet's switch draws the read state`);
    assert.equal(switchText(toggle), `Show me first: ${on ? 'on' : 'off'}`, `card ${card}: the sheet's switch says its state`);
    assert.ok(!isDisabled(toggle), `card ${card}: the sheet's switch is on while its sheet is open`);
    const stage = pathTo(sheet, `Column: ${column}`).at(-1);
    const blockers = pathTo(sheet, 'No open blockers').at(-1);
    assert.ok(drawOrder(sheet, stage) < drawOrder(sheet, toggle) && drawOrder(sheet, toggle) < drawOrder(sheet, blockers),
      `card ${card}: the sheet's switch sits under its stage line`);
    assert.equal(strings(sheet).includes(SHOW_FIRST_QUEUED), column === 'In review', `card ${card}: the queued-merge line shows only for In review`);
    for (const other of SWITCH_CARDS) assert.ok(isDisabled(switchOf(tree, other)), `card ${card}: card ${other}'s Board switch is off while the sheet is open`);
    await host.press('escape');
  }
  for (const card of [1, 5]) {
    await host.click(titleOf(host.render(), card));
    assert.deepEqual(switchesIn(nodeWithId(host.render(), SHEET_ID)), [], `card ${card}'s sheet offers no switch`);
    await host.press('escape');
  }

  await host.click(titleOf(host.render(), 6));
  await pressSwitch(host, switchOf(host.render(), 4));
  assert.deepEqual(showFirstCalls(host), [], 'a Board switch pressed while the sheet is open writes nothing');
  await pressSwitch(host, sheetSwitchOf(host.render()));
  const pressed = host.render();
  assert.deepEqual(showFirstCalls(host), [queueCall('show-first', keyOf(6), 'on')], "the sheet's switch writes its card's state pressed");
  assert.deepEqual(ran(host).at(-1), queueCall('refresh', terminalList([])), 'then a refresh');
  assert.ok(trackedFocused(nodeWithId(pressed, SHEET_ID)), 'the keyboard stays in the sheet');
  assert.ok(!trackedFocused(titleOf(pressed, 6)), "the keyboard does not go to the Board card's title");
  assert.ok(strings(nodeWithId(pressed, SHEET_ID)).includes(TURNED_ON), `the sheet shows the success line: ${strings(pressed).join(' | ')}`);
  assert.equal(checkedOf(sheetSwitchOf(pressed)), true, "the sheet's switch draws the written state");
  assert.ok(isDisabled(sheetSwitchOf(pressed)), "the sheet's switch is off while its line shows");
  for (const other of SWITCH_CARDS) assert.ok(isDisabled(switchOf(pressed, other)), `card ${other}'s Board switch stays off`);

  const refusal = 'card 8 is in Backlog, not Ready or In progress';
  const refused = await boardScene('/repos/a', moveCache(SHOW_CARDS), () => (lastCommand(refused) === 'show-first' ? { code: 1, stdout: '', stderr: `${refusal}\n` } : OK));
  await refused.click(titleOf(refused.render(), 8));
  await pressSwitch(refused, sheetSwitchOf(refused.render()));
  assert.ok(strings(nodeWithId(refused.render(), SHEET_ID)).includes(`Show me first failed: ${refusal}`), 'the sheet names a refused write');

  const floor = await floorScene(moveCache(SHOW_CARDS));
  await floor.click(cardTileOf(floor.render(), 6));
  const floorSheet = nodeWithId(floor.render(), SHEET_ID);
  assert.ok(floorSheet, 'the Floor tile opens its sheet');
  assert.deepEqual(switchesIn(floorSheet), [], "the Floor's sheet offers no Show me first");
});

test('ANTI-REGRESSION: on the Board only Move to Ready on a Backlog card marks a card ready, and no control approves ahead, merges or pushes', async () => {
  const cards = [
    boardCard(1, 'Later', 'Backlog', 1, { version: versionOf(1), showFirst: false }),
    boardCard(2, 'Proposed: An idea', 'Backlog', 2, { waitsOn: 'suggested', version: versionOf(2), showFirst: false }),
    boardCard(4, 'Top work', 'Ready', 1, { version: versionOf(4), showFirst: true }),
    boardCard(6, 'Second work', 'Ready', 2, { blockers: [8, 3], version: versionOf(6), showFirst: false }),
    boardCard(8, 'Running', 'In progress', 1, { version: versionOf(8), showFirst: true }),
    boardCard(5, 'Ship it', 'Awaiting push', 1, { waitsOn: 'merge', version: versionOf(5), showFirst: false }),
  ];
  const items = [
    queueItem('merge', 5), queueItem('suggested', 2, { scope: 'Build the idea.' }),
    inRepository('b', 'merge', 5), inRepository('b', 'question', 6), inRepository('c', 'failure', 3), inRepository('c', 'usage-limit', 2),
  ];
  const scene = () => boardScene('/repos/a', moveCache(cards, {}, items));
  const first = (await scene()).render();
  named(first, 'Move card 1 to Ready');

  // Every control the Board draws is pressed, each in a fresh scene, and what the press started is settled.
  const presses = [];
  for (const [index, name] of buttonsIn(first).map(accessibleName).entries()) {
    const host = await scene();
    const button = buttonsIn(host.render())[index];
    assert.equal(accessibleName(button), name, `${name} is drawn again in its place`);
    await host.task((cx) => { if (button.click !== null && !isDisabled(button)) button.click({}, cx); });
    presses.push({ name, host });
  }
  // Every switch the Board draws is pressed too, each in a fresh scene, as the kit presses it.
  for (const [index, name] of switchesIn(first).map(labelOf).entries()) {
    const host = await scene();
    const toggle = switchesIn(host.render())[index];
    assert.equal(labelOf(toggle), name, `${name} is drawn again in its place`);
    await pressSwitch(host, toggle);
    presses.push({ name, host });
  }
  // The positive control: the presses reached every move the Board offers.
  const moves = presses.flatMap(({ host }) => ran(host).filter(({ args }) => args[1] === 'move').map(({ args }) => args[3]));
  assert.deepEqual([...new Set(moves)].sort(), ['backlog', 'ready', 'up'], 'the presses reached each move');
  // The positive control: the presses reached Show me first on and off, each with its own card's key.
  const marks = presses.flatMap(({ host }) => showFirstCalls(host).map(({ args }) => `${args[2]} ${args[3]}`));
  assert.deepEqual(marks.sort(), [`${keyOf(4)} off`, `${keyOf(5)} on`, `${keyOf(6)} on`, `${keyOf(8)} off`], 'the presses reached Show me first on and off');

  const marksReady = (host) => ran(host).filter(({ args }) => args.some((arg) => /ready/i.test(arg)));
  const readying = presses.filter(({ host }) => marksReady(host).length > 0);
  assert.deepEqual(readying.map(({ name }) => name), ['Move card 1 to Ready'], 'only Move to Ready on the Backlog card sends ready');
  assert.deepEqual(marksReady(readying[0].host), [queueCall('move', keyOf(1), 'ready', versionOf(1))], 'it marks only its own card ready, at its drawn version');
  for (const { name, host } of presses) {
    for (const [program, args] of host.calls) {
      assert.equal(program, 'node', `${name}: every command is node`);
      assert.equal(args[0], `${HOME}/mods/fabraik-queue/queue.mjs`, `${name}: every command runs queue.mjs`);
      assert.ok([...QUEUE_COMMANDS, 'move', 'show-first'].includes(args[1]), `${name}: queue.mjs ${args[1]} is a panel command`);
      for (const arg of args) assert.doesNotMatch(arg, /merge|push|approve/i, `${name}: no argument names a merge, push or approval: ${arg}`);
    }
    for (const [run] of host.runs) assert.ok(!SPACE_COMMANDS.includes(run), `${name}: a press runs no Herdr ${run}`);
  }
  assert.ok(presses.some(({ host }) => host.overlays.length > 0), 'the presses reached the strip control that opens Decisions');
});

// The merge sheet's expectations are written by hand from card #759's acceptance criterion 2, the sheet rules in
// docs/DESIGN-SYSTEM.md and the plan's Shade safety and Visual direction: each merged digest line, Floor tile and Board
// entry is a button that opens a dialog named "<folder> merge <sha7>" and runs `queue.mjs report <repository>@<sha>`,
// never a refresh; while the sheet is open no control beneath takes a press or Tab and no key reaches the view; Esc, Close
// and a press outside give focus back to the opener, or to the view where it is gone; a failed run reads "Report not read:
// <cause>" with Try again and Mark as seen. The reading line's words are not fixed, so only its "Reading" start is.
const mergeOf = (sha, subject, time) => ({ sha, at: localTime(12, 9, Number(time.slice(3))), subject, time });
const MERGES = [
  mergeOf('1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d', 'Show the report (#12)', '09:05'),
  mergeOf('fedcba9876543210fedcba9876543210fedcba98', 'Mark it seen (#13)', '09:20'),
];
const mergeCache = (merges = MERGES, items = []) => ({
  ...panelCache([...items, ...merges.map(({ sha, at, subject }) => ({ category: 'digest', repository: '/repos/a', sha, at, subject }))]),
  boards: [floorBoard('a', { merged: merges.map(({ sha, at, subject }) => ({ sha, at, subject })) })],
});
const mergeKey = (merge) => `/repos/a@${merge.sha}`;
// Where the queue keeps the report of the merge whose key is `key`, `<repository>@<sha>`: the file is named by its sha and a digest of its repository.
const keptFileOf = (key) => `${HOME}/fabraik-queue/reports/${keptNameOf(key.slice(0, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1))}`;
const mergeSheetName = (merge) => `a merge ${merge.sha.slice(0, 7)}`;
const reportRead = (merge) => ({ code: 0, stdout: `${JSON.stringify(reportDocument({ sha: merge.sha }))}\n`, stderr: '' });
const digestOpener = (tree, merge) => buttonsIn(tree).find((button) => strings(button).includes(`a: ${merge.subject}, ${merge.time}`));
// Each view with its scene from a whole cache and the button that opens a merge in it, undefined where none is drawn.
// `chipRow` is the element whose first child is the New chip while the merge is unseen: the opener, or on the Board the
// merged entry's bottom line.
const floorTileOf = (tree, merge) => floorTiles(tree).find((tile) => tile.elementId === `${FLOOR_ID}${mergeKey(merge)}` && tile.kind === 'button');
const MERGE_VIEWS = [
  { name: 'the Decisions view', scene: decisionsScene, opener: digestOpener, chipRow: digestOpener },
  { name: 'the Floor', scene: floorScene, opener: floorTileOf, chipRow: floorTileOf },
  {
    name: 'the Board',
    scene: (cache, execResult) => boardScene('/repos/a', cache, execResult),
    opener: (tree, merge) => buttonsIn(boardColumnOf(tree, 'merged')).find((button) => strings(button).includes(merge.subject)),
    chipRow: (tree, merge) => nodeWithId(tree, `${BOARD_ID}merged-line-${merge.sha}`),
  },
];
// A key as the kit delivers it while focus is in the sheet: to each key handler drawn, innermost first, as it bubbles
// from the sheet out to the view's root, until a handler stops it.
const keyIn = (host, keyName) => host.task((cx) => {
  const modifiers = { shift: false, control: false, alt: false, platform: false, function: false };
  const stopped = host.stopped;
  for (const [node] of [...walk(host.render())].reverse()) {
    if (host.stopped > stopped) break;
    node.keyDown?.({ key: keyName, keystroke: keyName, key_char: keyName, modifiers }, cx);
  }
});
const sheetButtons = (host, name) => buttonsIn(nodeWithId(host.render(), SHEET_ID)).filter((button) => nameOf(button) === name);

// Views over the window. The expectations are written by hand from card #858's criteria 1 and 5 (the workflow makes no
// space; a view opens over the window and closes with Esc, leaving sessions as they were) and Herdr's overlay contract in
// herdr.d.ts: a window overlay is dragged by any press its mod does not stop, takes no keyboard unless the mod focuses
// itself, and closes through closeOverlay(props().overlay).
test("the panel's Decisions and Floor controls and the Floor's Open board open one overlay over the window and make no space or tab", async () => {
  const panel = await loadPanel(OK);
  const controls = buttonsIn(panel.render()).filter((button) => VIEW_BUTTONS.includes(button.elementId));
  assert.deepEqual(controls.map(nameOf), ['Decisions', 'Floor'], 'the panel draws a Decisions and a Floor control');
  for (const control of controls) {
    assert.deepEqual([called(control, 'h').at(-1), called(control, 'border_1').length, called(control, 'border_color').at(-1)], [[24], 1, ['border']],
      `${nameOf(control)} is an outlined control 24 high`);
  }
  await panel.click(named(panel.render(), 'Decisions'));
  await panel.click(named(panel.render(), 'Floor'));
  assert.deepEqual(panel.overlays, [viewSpec('decisions', undefined), viewSpec('floor', undefined)],
    'each opens its view in the one keyed window overlay, so Floor takes the place of Decisions');

  const floor = await floorScene({ ...panelCache([]), boards: [floorBoard('a'), floorBoard('b')] });
  await floor.click(named(floor.render(), 'Open the b board'));
  assert.deepEqual(floor.overlays, [viewSpec('board', '/repos/b')], "Open board opens that project's Board in the same overlay");

  for (const host of [panel, floor]) {
    assert.deepEqual(host.runs.filter(([name]) => SPACE_COMMANDS.includes(name)), [], 'no press makes, shows or closes a space or tab');
    assert.deepEqual(host.closedOverlays, [], 'no press closes an overlay');
  }
});

test('a view in an overlay takes the keyboard, keeps presses from dragging the window, and Esc ends a drag, then closes the sheet, then the overlay', async () => {
  const host = await loadPanel(OK, { view: 'board', repository: '/repos/a', overlay: 'overlay-7' }, { lifecycle: true });
  host.setCache(moveCache());
  await host.started();
  assert.ok(host.panel.focusHandle.is_focused(), 'the overlay copy holds the keyboard from its start');
  assert.deepEqual(host.runs.filter(([name]) => SPACE_COMMANDS.includes(name)), [], 'its start makes, shows or closes no space or tab');
  const tree = host.render();
  assert.deepEqual(called(tree, 'track_focus'), [[host.panel.focusHandle]], 'its root tracks the handle it focused');
  const before = host.stopped;
  handlerOf(tree, 'on_mouse_down')({ button: 'left', click_count: 1, position: IN_READY }, host.cx);
  assert.equal(host.stopped, before + 1, 'a press that reaches its root stops there, so it drags no window');

  // Esc during a drag ends the drag only.
  const drag = dragOn(host);
  drag.press(1, centreOf(1));
  drag.move(IN_READY);
  assert.notEqual(host.panel.drag, null, 'the drag is under way');
  await host.press('escape');
  assert.equal(host.panel.drag, null, 'Esc ends the drag');
  assert.deepEqual(host.closedOverlays, [], 'and leaves the overlay open');

  // Esc with the sheet open closes the sheet only, whether it reaches the sheet first or the root.
  for (const [why, esc] of /** @type {[string, () => unknown][]} */ ([['in the sheet', () => keyIn(host, 'escape')], ['at the root', () => host.press('escape')]])) {
    await host.click(titleOf(host.render(), 1));
    assert.ok(nodeWithId(host.render(), SHEET_ID), `${why}: the sheet is open`);
    assert.equal(nodeWithId(host.render(), 'fabraik-queue-view-close').click, null, `${why}: Close lies inert beneath the sheet`);
    await esc();
    assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, `${why}: Esc closes the sheet`);
    assert.deepEqual(host.closedOverlays, [], `${why}: and leaves the overlay open`);
  }

  // A second Esc, with no drag or sheet, closes the overlay, as its header's Close does.
  await host.press('escape');
  assert.deepEqual(host.closedOverlays, ['overlay-7'], 'the next Esc closes the overlay');
  const close = nodeWithId(host.render(), 'fabraik-queue-view-close');
  assert.equal(nameOf(close), 'Close', 'the header draws Close');
  await host.click(close);
  assert.deepEqual(host.closedOverlays, ['overlay-7', 'overlay-7'], 'Close closes the overlay');
  assert.deepEqual(host.runs.filter(([name]) => SPACE_COMMANDS.includes(name)), [], 'closing makes, shows or closes no space or tab');

  // A copy in its place in the layout keeps its keyboard as the owner left it, lets presses through and draws no Close.
  const placed = await boardScene('/repos/a', moveCache());
  assert.equal(placed.panel.focusHandle.is_focused(), false, 'a copy outside an overlay takes no keyboard');
  handlerOf(placed.render(), 'on_mouse_down')({ button: 'left', click_count: 1, position: IN_READY }, placed.cx);
  assert.equal(placed.stopped, 0, 'and stops no press');
  assert.equal(nodeWithId(placed.render(), 'fabraik-queue-view-close'), undefined, 'and draws no Close');
  await placed.press('escape');
  assert.deepEqual(placed.closedOverlays, [], 'and Esc closes no overlay');
});

test("a merged line, tile or entry is a button that opens its merge's sheet in every view", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  for (const { name, scene, opener } of MERGE_VIEWS) {
    for (const merge of MERGES) {
      const host = await scene(mergeCache(), () => reportRead(merge));
      const button = opener(host.render(), merge);
      assert.ok(button, `${name}: ${merge.subject} is drawn as a button`);
      assert.ok(button.click !== null && !isDisabled(button), `${name}: ${merge.subject} takes a press`);
      await host.click(button);
      const tree = host.render();
      const sheet = nodeWithId(tree, SHEET_ID);
      assert.ok(sheet, `${name}: a press on ${merge.subject} draws the sheet`);
      assert.equal(called(sheet, 'role').at(-1)?.[0], 'dialog', `${name}: the sheet is a dialog`);
      assert.equal(labelOf(sheet), mergeSheetName(merge), `${name}: the sheet is named by its folder and merge`);
      assert.ok(hasShade(tree), `${name}: a chrome shade is drawn behind the sheet`);
      assert.ok(trackedFocused(sheet), `${name}: focus moves into the sheet`);
      assert.deepEqual(ran(host), [queueCall('report', mergeKey(merge))], `${name}: opening runs the queue's report of that merge and no refresh`);
      assert.deepEqual(host.runs, [], `${name}: opening runs no Herdr command`);
    }
  }
});

test('the merge sheet keeps the keyboard, leaves the view beneath inert and gives focus back to its opener', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  const reply = () => reportRead(merge);

  // 1. In the Decisions view every control the plan lists is drawn beneath the sheet, and none takes a press or Tab; c
  // clears nothing while the sheet is open, and clears the digest once it is closed.
  const items = [queueItem('merge', 5), queueItem('suggested', 8, { scope: 'Build the thing.' }),
    queueItem('failure', 10), queueItem('failure', 13)];
  const listed = {
    'the Decisions view': ['Accept card', 'Clear (c)', 'Dismiss', 'Put aside', 'Reject', 'Undo', sendName(5)],
  };
  for (const { name, scene, opener } of MERGE_VIEWS.slice(0, 1)) {
    const host = await scene(mergeCache(MERGES, items), reply);
    await host.click(buttonOf(host.render(), keyOf(13), 'Dismiss'));
    const button = opener(host.render(), merge);
    assert.ok(button, `${name}: ${merge.subject} is drawn as a button`);
    await host.click(button);
    const tree = host.render();
    const inSheet = new Set(buttonsIn(nodeWithId(tree, SHEET_ID)));
    const beneath = buttonsIn(tree).filter((found) => !inSheet.has(found));
    const names = beneath.map(controlName);
    for (const control of listed[name]) assert.ok(names.includes(control), `${name}: ${control} is drawn beneath the sheet: ${names.join(' | ')}`);
    for (const drawn of MERGES) assert.ok(beneath.includes(opener(tree, drawn)), `${name}: the line of ${drawn.subject} is beneath the sheet`);
    for (const found of beneath) {
      assert.equal(found.click, null, `${name}: ${controlName(found)} takes no press while the sheet is open`);
      assert.equal(called(found, 'tab_stop').at(-1)?.[0], false, `${name}: ${controlName(found)} is no tab stop while the sheet is open`);
    }
    const answer = nodesOf(tree, 'input').find((box) => labelOf(box) === 'Answer to card 5');
    assert.ok(answer, `${name}: the answer box for card 5 is drawn beneath the sheet`);
    assert.equal(called(answer, 'tab_stop').at(-1)?.[0], false, `${name}: the answer box is no tab stop while the sheet is open`);
    assert.ok(isDisabled(answer), `${name}: the answer box is disabled while the sheet is open`);
    await keyIn(host, 'c');
    assert.deepEqual(ran(host), [queueCall('report', mergeKey(merge))], `${name}: c runs nothing while the sheet is open`);
    await keyIn(host, 'escape');
    await keyIn(host, 'c');
    assert.deepEqual(ran(host).at(-1), queueCall('clear-digest'), `${name}: c clears the digest once the sheet is closed`);
  }

  // 2. In every view Tab and Shift+Tab stay in the sheet, the merge openers beneath take no press or Tab, and Esc, Close and
  // a press outside give focus back to the opener, or to the view once the opener is gone.
  /** @type {PanelHost | null} */
  let shown = null;
  /** @type {{ focus: () => void } | null} */
  let lands = null;
  const moves = [];
  const moveFrom = (direction) => () => {
    assert.ok(shown && lands, 'the test says which view is open and where focus lands');
    moves.push([direction, shown.handles.find((handle) => handle.is_focused())]);
    lands.focus();
  };
  // @ts-expect-error a scripted window stands in for Herdr's
  globalThis.window = { focus_next: moveFrom('next'), focus_prev: moveFrom('prev') };
  // @ts-expect-error the scripted window is removed again
  t.after(() => { delete globalThis.window; });
  for (const { name, scene, opener } of MERGE_VIEWS) {
    const host = await scene(mergeCache(), reply);
    shown = host;
    const closers = /** @type {[string, () => unknown][]} */ ([
      ['Esc', () => keyIn(host, 'escape')],
      ['Close', () => host.click(nodeWithId(host.render(), SHEET_CLOSE_ID))],
      ['a press outside', () => called(nodeWithId(host.render(), SHEET_ID), 'on_mouse_down_out').at(-1)[0]({}, host.cx)],
    ]);
    for (const [closer, close] of closers) {
      const button = opener(host.render(), merge);
      assert.ok(button, `${name}: ${merge.subject} is drawn as a button`);
      await host.click(button);
      const tree = host.render();
      assert.deepEqual(called(nodeWithId(tree, SHEET_ID), 'key_context').at(-1), ['FabraikQueueSheet'], `${name}: the sheet is the context of its Tab bindings`);
      for (const beneath of MERGES.map((drawn) => opener(tree, drawn))) {
        assert.equal(beneath.click, null, `${name}: a merge opener takes no press while the sheet is open`);
        assert.equal(called(beneath, 'tab_stop').at(-1)?.[0], false, `${name}: a merge opener is no tab stop while the sheet is open`);
      }
      const handleOf = (id) => called(nodeWithId(tree, id), 'track_focus').at(-1)?.[0];
      const [closeHandle, end, body] = [handleOf(SHEET_CLOSE_ID), handleOf(SHEET_END_ID), host.cx.focus_handle()];
      const step = (from, to, action) => {
        from.focus();
        lands = to;
        moves.length = 0;
        const found = called(nodeWithId(host.render(), SHEET_ID), 'on_action').find(([actionName]) => actionName === action);
        assert.ok(found, `${name}: the sheet handles ${action}`);
        found[1]({ action }, host.cx);
      };
      step(body, end, 'fabraik-queue-sheet-next');
      assert.ok(closeHandle.is_focused(), `${name}: Tab past the sheet's last control wraps to Close`);
      step(closeHandle, body, 'fabraik-queue-sheet-prev');
      assert.deepEqual(moves, [['prev', end]], `${name}: Shift+Tab from Close steps back from the sheet's end`);
      assert.ok(body.is_focused(), `${name}: Shift+Tab from Close lands inside the sheet`);
      await close();
      const closed = host.render();
      assert.equal(nodeWithId(closed, SHEET_ID), undefined, `${name}: ${closer} closes the sheet`);
      assert.ok(!hasShade(closed), `${name}: ${closer} removes the shade`);
      assert.ok(trackedFocused(opener(closed, merge)), `${name}: ${closer} gives focus back to the merge's opener`);
    }
    await host.click(opener(host.render(), merge));
    host.setCache(mergeCache([other]));
    await host.panel.load();
    await keyIn(host, 'escape');
    assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, `${name}: Esc closes the sheet whose opener is gone`);
    assert.ok(host.handles[0].is_focused(), `${name}: with its opener gone, the view holds the keyboard`);
  }
});

test('the merge sheet says it is reading, names a failed read and reads again on Try again', async () => {
  const [merge, other] = MERGES;
  const replies = [];
  const pending = () => new Promise((resolve) => replies.push(resolve));
  const failedRun = (cause) => ({ code: 1, stdout: '', stderr: `${cause}\n` });
  const host = await decisionsScene(mergeCache(), pending);
  const reading = () => sheetLines(host).filter((line) => /^Reading\b/.test(line));
  const failures = () => sheetLines(host).filter((line) => line.startsWith('Report not read'));

  const button = digestOpener(host.render(), merge);
  assert.ok(button, `${merge.subject} is drawn as a button`);
  const opening = host.click(button);
  await new Promise(setImmediate);
  assert.equal(reading().length, 1, `while the queue runs, the sheet says it is reading: ${sheetLines(host).join(' | ')}`);
  assert.deepEqual([failures(), sheetButtons(host, 'Try again')], [[], []], 'no failure and no Try again while it reads');
  const cause = `${mergeKey(merge)}: the reader could not reach its tracker`;
  replies[0](failedRun(cause));
  await opening;
  assert.deepEqual(failures(), [`Report not read: ${cause}`], `a failed run names its cause: ${sheetLines(host).join(' | ')}`);
  assert.deepEqual(reading(), [], 'the reading line is gone once the run ends');
  assert.equal(sheetButtons(host, 'Try again').length, 1, 'a failed read offers Try again');
  assert.equal(sheetButtons(host, 'Mark as seen').length, 1, 'a failed read offers Mark as seen');

  const again = host.click(sheetButtons(host, 'Try again')[0]);
  await new Promise(setImmediate);
  assert.deepEqual(ran(host), [queueCall('report', mergeKey(merge)), queueCall('report', mergeKey(merge))], 'Try again runs the report again, and nothing else ran');
  assert.equal(reading().length, 1, `Try again says it is reading again: ${sheetLines(host).join(' | ')}`);
  assert.deepEqual(failures(), [], 'the failed read is not shown while it reads again');
  replies[1](reportRead(merge));
  await again;
  assert.deepEqual([reading(), failures(), sheetButtons(host, 'Try again')], [[], [], []], 'a report read ends the reading and the failure');

  // A reply to an earlier opening is not this sheet's, whether it lands before or after the later opening's own.
  for (const staleFirst of [true, false]) {
    replies.length = 0;
    const scene = await decisionsScene(mergeCache(), pending);
    const first = scene.click(digestOpener(scene.render(), merge));
    await new Promise(setImmediate);
    await keyIn(scene, 'escape');
    const second = scene.click(digestOpener(scene.render(), other));
    await new Promise(setImmediate);
    assert.equal(labelOf(nodeWithId(scene.render(), SHEET_ID)), mergeSheetName(other), 'the later opening shows its own merge');
    const stale = 'the earlier opening failed';
    const fresh = 'the later opening failed';
    if (staleFirst) {
      replies[0](failedRun(stale));
      await first;
      assert.ok(!sheetLines(scene).includes(`Report not read: ${stale}`), `an earlier reply landing first is not drawn: ${sheetLines(scene).join(' | ')}`);
      assert.ok(sheetLines(scene).some((line) => /^Reading\b/.test(line)), 'the later opening still says it is reading');
      replies[1](failedRun(fresh));
      await second;
    } else {
      replies[1](failedRun(fresh));
      await second;
      replies[0](failedRun(stale));
      await first;
    }
    const drawn = sheetLines(scene).filter((line) => line.startsWith('Report not read'));
    assert.deepEqual(drawn, [`Report not read: ${fresh}`], `${staleFirst ? 'stale first' : 'stale last'}: only the later opening's reply is drawn`);
  }
});

// A report the queue kept, <home>/fabraik-queue/reports/<sha>-<digest of its repository>.json = { format: 1, key: "<repository>@<sha>", report }, opens at
// once in every view: no reading line, no run of the queue, and the merge marked seen, as card #849's first criterion says
// ("shows the report with no reading state and no new request to GitHub"). A kept file that is not that merge's valid report
// is ignored and the report is read by a run. The expectations are written by hand from the criterion.
test('a merge whose report the queue kept opens at once in every view and a kept file that is not its report is read again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  const kept = { format: 1, key: mergeKey(merge), report: reportDocument({ sha: merge.sha, card: { number: 9, title: 'Kept report' } }) };
  const keptPath = keptFileOf(mergeKey(merge));
  const READ_AGAIN = {
    'text that is not json': 'not json',
    'a key for another repository': { ...kept, key: `/repos/b@${merge.sha}` },
    'another format': { ...kept, format: 2 },
    "another merge's report": { ...kept, report: { ...kept.report, sha: other.sha } },
    'an outcome the panel does not know': { ...kept, report: { ...kept.report, outcome: 'maybe' } },
  };
  for (const view of MERGE_VIEWS) {
    const keptHost = await view.scene(mergeCache(), () => reportRead(merge));
    keptHost.files[keptPath] = JSON.stringify(kept);
    const opening = keptHost.click(openerOf(view, keptHost, merge));
    assert.ok(nodeWithId(keptHost.render(), SHEET_ID), `${view.name}: the press draws the sheet`);
    assert.deepEqual(sheetLines(keptHost).filter((line) => /^Reading\b/.test(line)), [], `${view.name}: a kept report shows no reading line at the press: ${sheetLines(keptHost).join(' | ')}`);
    await opening;
    const shown = sheetLines(keptHost);
    assert.ok(shown.includes('Kept report') && shown.includes('Merged, nothing needed you'), `${view.name}: the kept report is drawn: ${shown.join(' | ')}`);
    assert.deepEqual(ran(keptHost), [], `${view.name}: a kept report runs no queue command`);
    assert.deepEqual(seenWrites(keptHost).at(-1), { [mergeKey(merge)]: SEEN_NOW }, `${view.name}: a kept report marks its merge seen`);

    for (const [what, file] of Object.entries(READ_AGAIN)) {
      const host = await view.scene(mergeCache(), () => reportRead(merge));
      host.files[keptPath] = typeof file === 'string' ? file : JSON.stringify(file);
      await host.click(openerOf(view, host, merge));
      const lines = sheetLines(host);
      assert.deepEqual(ran(host), [queueCall('report', mergeKey(merge))], `${view.name}: ${what} in the kept file runs the report once`);
      assert.ok(lines.includes('Merged work shows its report') && !lines.includes('Kept report'), `${view.name}: ${what} in the kept file is not drawn: ${lines.join(' | ')}`);
    }
  }
});

// Two listed repositories holding the one merge commit keep two files, so opening a merge shows the report of its own
// repository, which is read from its file with no run, whatever the other repository's file holds.
test('an open shows a kept report of the same merge commit for its own repository with no new run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge] = MERGES;
  const keptFor = (key, title) => JSON.stringify({ format: 1, key, report: reportDocument({ sha: merge.sha, card: { number: 9, title } }) });
  for (const view of MERGE_VIEWS) {
    const host = await view.scene(mergeCache(), () => reportRead(merge));
    host.files[keptFileOf(`/repos/b@${merge.sha}`)] = keptFor(`/repos/b@${merge.sha}`, 'Report of repository b');
    host.files[keptFileOf(mergeKey(merge))] = keptFor(mergeKey(merge), 'Report of repository a');
    await host.click(openerOf(view, host, merge));
    const shown = sheetLines(host);
    assert.ok(shown.includes('Report of repository a') && !shown.includes('Report of repository b'), `${view.name}: the open shows its own repository's report: ${shown.join(' | ')}`);
    assert.deepEqual(ran(host), [], `${view.name}: its own repository's kept report runs no queue command`);
  }
});

// The Board's background read is written by hand from card #849's criteria 1 and 4 and the plan's Decisions item 4: after
// a queue read the Board alone runs `queue.mjs report` for each merge its board lists, in the list's order (newest first),
// one at a time and skipping one already noted; an open of the merge being read joins that run; the first failed run starts
// no further run in the pass and only a read with a new refreshedAt starts another, which begins just after the merge whose
// run failed; the pass marks no merge seen. The fake queue keeps the report it prints, as `queue.mjs report` keeps a whole one.
test('the Board reads the reports of its merges in the background one at a time and an open joins the read in flight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [older, newest] = MERGES;
  const cache = mergeCache([newest, older]);
  const board = MERGE_VIEWS[2];
  const replies = [];
  const host = await boardScene('/repos/a', cache, (_program, args) => new Promise((resolve) => replies.push({ sha: args[2].split('@')[1], resolve })));
  // Answers the oldest run still waiting with its merge's report, keeping it first.
  const answer = () => {
    const { sha, resolve } = replies.shift();
    host.files[keptFileOf(mergeKey({ sha }))] = JSON.stringify({ format: 1, key: mergeKey({ sha }), report: reportDocument({ sha }) });
    resolve(reportRead({ sha }));
  };
  const reportShown = (scene) => sheetLines(scene).includes('Merged work shows its report');
  const turn = () => new Promise(setImmediate);

  const rereading = readCache(host);
  await turn();
  assert.deepEqual(ran(host), [queueCall('report', mergeKey(newest))], 'a queue read starts one report run, for the newest merge');
  const opening = host.click(openerOf(board, host, newest));
  await turn();
  assert.deepEqual(ran(host), [queueCall('report', mergeKey(newest))], 'opening the merge being read joins its run');
  assert.equal(sheetLines(host).filter((line) => /^Reading\b/.test(line)).length, 1, `the sheet says it is reading: ${sheetLines(host).join(' | ')}`);
  answer();
  await opening;
  assert.ok(reportShown(host), `the joined run's report is drawn: ${sheetLines(host).join(' | ')}`);
  await turn();
  assert.deepEqual(ran(host), [queueCall('report', mergeKey(newest)), queueCall('report', mergeKey(older))], 'the next merge is read once the first read ends');
  answer();
  await rereading;
  assert.deepEqual(seenWrites(host), [{ [mergeKey(newest)]: SEEN_NOW }], 'only the opening marked its merge seen, the background reads none');
  await keyIn(host, 'escape');
  await host.click(openerOf(board, host, older));
  assert.ok(reportShown(host), `the merge the background read opens with its report: ${sheetLines(host).join(' | ')}`);
  await readCache(host);
  assert.equal(ran(host).length, 2, 'opening a merge already read and rereading the same read run nothing');

  const failing = await boardScene('/repos/a', cache, () => UNREACHABLE);
  await readCache(failing);
  assert.deepEqual(ran(failing), [queueCall('report', mergeKey(newest))], 'the first failed read ends the pass');
  await readCache(failing);
  assert.deepEqual(ran(failing), [queueCall('report', mergeKey(newest))], 'a reread of the same read starts no pass');
  failing.setCache({ ...cache, refreshedAt: new Date(NOON_12TH + 60000).toISOString() });
  await readCache(failing);
  assert.deepEqual(ran(failing), [queueCall('report', mergeKey(newest)), queueCall('report', mergeKey(older))],
    'a read with a new refreshedAt reads again, starting just after the merge whose run failed');
  assert.deepEqual(seenWrites(failing), [], 'a background read marks no merge seen');

  // The panel is given the Board's project, so only its view, not a missing project, keeps it from reading.
  const panel = await loadPanel(() => reportRead(newest), { repository: '/repos/a' });
  panel.setCache(cache);
  await readCache(panel);
  assert.deepEqual(ran(panel), [], 'the queue panel reads no report in the background');
});

// The pass's carrying on past a failed run is written by hand from the plan's revised decision 4: a pass looks at every kept
// report, starts no run once one has failed, and the next pass starts just after the merge whose run failed, so a merge whose
// run always fails blocks no other. Five merges newest first; the run of the second fails, the first and fourth are kept
// (the fourth `disagrees`) and the third and fifth are not.
test("the Board's background read looks at kept reports past a failed run and starts its next pass after the merge whose run failed", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const merges = ['5', '4', '3', '2', '1'].map((digit, at) => mergeOf(digit.repeat(40), `Merge number ${at + 1} (#${20 + at})`, `09:${digit}0`));
  const [m1, m2, m3, m4, m5] = merges;
  const cache = mergeCache(merges);
  const host = await boardScene('/repos/a', cache, (_program, args) => {
    const sha = args[2].split('@')[1];
    return sha === m2.sha ? UNREACHABLE : reportRead({ sha });
  });
  const keepReport = (merge, fields) => {
    host.files[keptFileOf(mergeKey(merge))] = JSON.stringify({ format: 1, key: mergeKey(merge), report: reportDocument({ sha: merge.sha, ...fields }) });
  };
  keepReport(m1, {});
  keepReport(m4, { outcome: 'disagrees', level: 'always', holds: ['a change'] });
  const titles = () => {
    const prefix = `${BOARD_ID}merged-`;
    return buttonsIn(boardColumnOf(host.render(), 'merged'))
      .map((button) => merges.find((merge) => button.elementId === `${prefix}${merge.sha}`)?.subject)
      .filter((subject) => subject !== undefined);
  };

  await readCache(host);
  assert.deepEqual(ran(host), [queueCall('report', mergeKey(m2))], 'the pass makes the one failing run and starts none after it');
  assert.deepEqual(titles(), [m1, m2, m3, m4].map((merge) => merge.subject), 'the fourth merge was noted from its kept report past the failed run and shows with the newest three');

  host.setCache({ ...cache, refreshedAt: new Date(NOON_12TH + 60000).toISOString() });
  await readCache(host);
  assert.deepEqual(ran(host), [m2, m3, m5, m2].map((merge) => queueCall('report', mergeKey(merge))),
    'the next pass runs the third and the fifth merge before the second, whose run failed');
});

// A run's report that is unread for a passing reason (no `lasting: true`) is not noted, as the queue keeps no file of it, so
// the next pass on a new read runs it again and it can show its real outcome; a lasting unread is noted like any other outcome.
test("the Board's background read runs a merge again on a new read when its report was unread for a passing reason and not when it was lasting", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [newer, older] = MERGES;
  const cache = mergeCache([newer, older]);
  const unread = { outcome: 'unread', level: undefined, cause: 'its card could not be read' };
  const host = await boardScene('/repos/a', cache, (_program, args) => {
    const sha = args[2].split('@')[1];
    const fields = sha === newer.sha ? unread : { ...unread, lasting: true };
    return { code: 0, stdout: `${JSON.stringify(reportDocument({ sha, ...fields }))}\n`, stderr: '' };
  });

  await readCache(host);
  assert.deepEqual(ran(host), [newer, older].map((merge) => queueCall('report', mergeKey(merge))), 'the first pass runs both merges');
  host.setCache({ ...cache, refreshedAt: new Date(NOON_12TH + 60000).toISOString() });
  await readCache(host);
  assert.deepEqual(ran(host).slice(2), [queueCall('report', mergeKey(newer))],
    'a new read runs only the merge whose unread report was for a passing reason');
});

// The merge report's body is written by hand from the order the owner set on card #759 and the plan's Visual direction:
// the outcome chip, the card's title, "What changed", "Why it did not wait" (or "Why it waited"), the screenshots, or with
// no screen the test results, then the muted word Seen (the report is read, so it is seen) and the pull request link; a field the reader sent as `{unread}` says
// "<group heading> not read: <why>", and a report the panel cannot read says so, never an empty sheet (criterion 1).
const REPORT_MERGE = MERGES[0];
const reportOf = (fields) => reportDocument({ sha: REPORT_MERGE.sha, ...fields });
const shotOf = (k, path) => ({ alt: `screenshot-${k} ${String(k).repeat(3)}`, path });
const WHEN_NEEDED = 'This project merges finished work on its evidence unless something needs you.';
const ON_SCREEN = 'This project merges finished work on its evidence unless it changes what you see.';
const SAYS_NO_SCREEN = 'It says it has no visual change.';
const SHOWS_SCREEN = 'It shows its screenshots.';
const NOTHING_NEEDED = [
  'Its checks passed with nothing failed or untested, and its review settled every finding.',
  'It finished everything its card asked.',
  'It needed no sign-off and is easy to undo.',
  'Its card had no Show me first label when it merged.',
];
const CANNOT_READ = 'Report not read: the queue printed a report this panel cannot read';
// Opens the merge's sheet in the Decisions view with `reply` as what the queue printed: a document, or raw text.
const openedReport = async (reply) => {
  const stdout = typeof reply === 'string' ? reply : `${JSON.stringify(reply)}\n`;
  const host = await decisionsScene(mergeCache(), () => ({ code: 0, stdout, stderr: '' }));
  await host.click(digestOpener(host.render(), REPORT_MERGE));
  return host;
};
// What the sheet draws, top to bottom: its strings and, for each image, `image <path>`.
const flowOf = (node) => (typeof node === 'string' ? [node] : node.kind === 'image' ? [`image ${node.path}`] : node.kids.flatMap(flowOf));
const sheetFlow = (host) => flowOf(nodeWithId(host.render(), SHEET_ID));
const assertInOrder = (flow, expected, message) => {
  const text = flow.join('\n');
  const places = expected.map((line) => text.indexOf(line));
  const astray = expected.filter((_line, at) => places[at] < 0 || (at > 0 && places[at] <= places[at - 1]));
  assert.deepEqual(astray, [], `${message}: missing or out of order in ${JSON.stringify(flow)}`);
};
const chipRole = (host, text) => {
  const chip = [...walk(nodeWithId(host.render(), SHEET_ID))].map(([node]) => node).find((node) => node.kids.includes(text));
  return chip && called(chip, 'border_color').at(-1)?.[0];
};

test('the merge report shows its chip, title, what changed, why it did not wait, screenshots and pull request in order', async () => {
  const [first, second] = [shotOf(1, 'fabraik-queue/shots/one.png'), shotOf(2, 'fabraik-queue/shots/two.png')];
  const host = await openedReport(reportOf({ changed: 'The panel now shows each merge as a report.', screenshots: [first, second] }));
  const flow = sheetFlow(host);

  assertInOrder(flow, [
    'Merged, nothing needed you',
    'Merged work shows its report',
    'What changed',
    'The panel now shows each merge as a report.',
    'Why it did not wait',
    WHEN_NEEDED,
    SHOWS_SCREEN,
    ...NOTHING_NEEDED,
    'Screenshot 1',
    `image ${first.path}`,
    'Screenshot 2',
    `image ${second.path}`,
    'Seen',
    'Open pull request #12',
  ], "the report is laid out in the owner's order");
  assert.equal(chipRole(host, 'Merged, nothing needed you'), 'done', 'the chip is outlined in done');
  const text = flow.join('\n');
  assert.ok(!text.includes('Show the report'), "the card was read, so its title leads, not the pull request's");
  assert.ok(!text.includes('Test results') && !text.includes('No visual change'), 'a merge with a screen shows no test results');
  assert.ok(!text.includes('Why it waited'), 'a merge that did not wait is not told why it waited');
  assertSeenWord(host, 'a report that loaded');
  assert.equal(sheetButtons(host, 'Open pull request #12').length, 1, 'the pull request link is a control of the sheet');
});

// GPUI gives an image whose width is a share, such as w_full, its picture's own pixel height, and an image whose width is
// in pixels the height its proportions give, so a screenshot drawn at its column's measured width has no band (#800).
test('a merge report draws each screenshot at the measured width of its column, never at a share of it, and at most 360 high', async () => {
  const shots = [shotOf(1, 'fabraik-queue/shots/wide.png'), shotOf(2, 'fabraik-queue/shots/tall.png')];
  const host = await openedReport(reportOf({ screenshots: shots }));
  const images = () => nodesOf(nodeWithId(host.render(), SHEET_ID), 'image');
  // Gives the screenshots' column `width`, as Herdr does after layout, and says whether a redraw was asked.
  const measure = (width) => {
    let asked = false;
    const cx = { ...host.cx, notify: () => { asked = true; } };
    for (const [handler] of called(nodeWithId(host.render(), SHEET_SHOTS_ID), 'on_size_change')) handler({ width, height: 400 }, cx);
    return asked;
  };
  const asked = measure(387);
  assert.equal(images().length, 2, 'both screenshots are drawn');
  for (const picture of images()) {
    assert.deepEqual(called(picture, 'w'), [[387]], `${picture.path}: the screenshot takes its column's measured width in pixels`);
    assert.deepEqual(called(picture, 'w_full'), [], `${picture.path}: no share of the width, which gives the picture's own pixel height`);
    assert.deepEqual(called(picture, 'max_h'), [[360]], `${picture.path}: a tall screenshot is held to 360 high`);
    for (const set of ['h', 'h_full', 'min_h', 'size']) assert.deepEqual(called(picture, set), [], `${picture.path}: no ${set} bands or crops it`);
  }
  assert.ok(asked, 'a new width asks for a redraw');
  assert.ok(!measure(387), 'the same width again asks for no redraw');
  measure(300);
  for (const picture of images()) assert.deepEqual(called(picture, 'w'), [[300]], `${picture.path}: a narrower sheet narrows its screenshots`);
});

test('a merge report divides the measured width of its screenshots by the person\'s zoom, since Herdr scales the width it draws', async () => {
  const shots = [shotOf(1, 'fabraik-queue/shots/wide.png'), shotOf(2, 'fabraik-queue/shots/tall.png')];
  const host = await openedReport(reportOf({ screenshots: shots }));
  const images = () => nodesOf(nodeWithId(host.render(), SHEET_ID), 'image');
  const measure = (width) => {
    for (const [handler] of called(nodeWithId(host.render(), SHEET_SHOTS_ID), 'on_size_change')) handler({ width, height: 400 }, host.cx);
  };
  const tenths = (calls) => calls.map(([width]) => [Math.round(width * 10) / 10]);
  host.settingsValue = { zoom: 0.9 };
  measure(348.3);
  assert.equal(images().length, 2, 'both screenshots are drawn');
  for (const picture of images()) {
    assert.deepEqual(tenths(called(picture, 'w')), [[387]], `${picture.path}: at zoom 0.9 a measured 348.3 is drawn at 387`);
    assert.deepEqual(called(picture, 'max_h'), [[360]], `${picture.path}: a tall screenshot is held to 360 high`);
  }
  host.settingsValue = { zoom: 1.25 };
  measure(400);
  for (const picture of images()) assert.deepEqual(tenths(called(picture, 'w')), [[320]], `${picture.path}: at zoom 1.25 a measured 400 is drawn at 320`);
  host.settingsValue = {};
  measure(300);
  for (const picture of images()) assert.deepEqual(tenths(called(picture, 'w')), [[300]], `${picture.path}: with no zoom a measured 300 is drawn at 300`);
});

test('a merge with no screen shows its test results, and each report state says what it is', async () => {
  // Nothing needed the owner: each level and each screen state picks its own sentences.
  const checks = ['Passed: the focused tests', 'Failed: none', 'Untested: the owner drive'];
  for (const level of ['when-needed', 'on-screen']) {
    for (const noScreen of [false, true]) {
      const name = `${level}, ${noScreen ? 'no screen' : 'a screen'}`;
      const path = 'fabraik-queue/shots/only.png';
      const host = await openedReport(reportOf({ level, noScreen, checks, screenshots: noScreen ? [] : [shotOf(1, path)] }));
      const flow = sheetFlow(host);
      const text = flow.join('\n');
      assertSeenWord(host, name);
      assert.ok(text.includes(level === 'on-screen' ? ON_SCREEN : WHEN_NEEDED), `${name}: the level sentence follows level`);
      assert.ok(!text.includes(level === 'on-screen' ? WHEN_NEEDED : ON_SCREEN), `${name}: the other level's sentence is not drawn`);
      assert.ok(text.includes(noScreen ? SAYS_NO_SCREEN : SHOWS_SCREEN), `${name}: the screen sentence follows noScreen`);
      assert.ok(!text.includes(noScreen ? SHOWS_SCREEN : SAYS_NO_SCREEN), `${name}: the other screen sentence is not drawn`);
      for (const sentence of NOTHING_NEEDED) assert.ok(text.includes(sentence), `${name}: ${sentence}`);
      if (noScreen) {
        assertInOrder(flow, ['Why it did not wait', ...NOTHING_NEEDED, 'No visual change', 'Test results', ...checks, 'Seen', 'Open pull request #12'], `${name}: the test results take the screenshots' place`);
        assert.ok(!flow.some((line) => line.startsWith('image ')) && !/Screenshot \d/.test(text), `${name}: no screenshot is drawn`);
      } else {
        assertInOrder(flow, ['Why it did not wait', ...NOTHING_NEEDED, 'Screenshot 1', `image ${path}`, 'Seen'], `${name}: the screenshot follows the reasons`);
        assert.ok(!text.includes('Test results') && !text.includes('No visual change'), `${name}: a merge with a screen shows no test results`);
      }
    }
  }

  // It waited: the record, as it was written, under its own heading.
  const waiting = 'Waiting for you: the change needs your sign-off';
  let host = await openedReport(reportOf({ outcome: 'waited', level: undefined, waiting }));
  let flow = sheetFlow(host);
  assertInOrder(flow, ['Merged after it waited for you', 'Merged work shows its report', 'What changed', 'Why it waited', waiting, 'Seen', 'Open pull request #12'], 'a merge that waited shows the record');
  assert.equal(chipRole(host, 'Merged after it waited for you'), 'done', 'the waited chip is outlined in done');
  assert.ok(!flow.join('\n').includes('Why it did not wait') && !flow.join('\n').includes('unless something needs you'), 'a merge that waited is given no reason it did not');

  // The record does not add up: its holds are named, and the chip is blocked.
  host = await openedReport(reportOf({ outcome: 'disagrees', level: 'always', holds: ['sign-off', 'no screenshot'] }));
  flow = sheetFlow(host);
  assertInOrder(flow, ['Merged, but its record does not add up', 'Why it did not wait', 'Not known: its write-up holds sign-off; no screenshot and its card has no Waiting for you comment.'], 'a merge whose record disagrees names its holds');
  assert.equal(chipRole(host, 'Merged, but its record does not add up'), 'blocked', 'the disagreeing chip is outlined in blocked');

  // Its reasons could not be read: the cause under the heading, and no chip says how it went.
  const cause = 'its card could not be read: the tracker answered HTTP 502';
  host = await openedReport(reportOf({ outcome: 'unread', level: undefined, cause }));
  flow = sheetFlow(host);
  assert.ok(flow.includes(`Why it did not wait not read: ${cause}`), `the cause is shown: ${JSON.stringify(flow)}`);
  assert.ok(!/Merged(,| after)/.test(flow.join('\n')), 'an unread outcome draws no chip');

  // A field the reader could not read says so under its own heading, and draws no empty group.
  const unreadChanged = 'pull request #12 has no decision card';
  host = await openedReport(reportOf({ changed: { unread: unreadChanged } }));
  flow = sheetFlow(host);
  assert.ok(flow.includes(`What changed not read: ${unreadChanged}`), `an unread changed says why: ${JSON.stringify(flow)}`);
  assert.deepEqual(nodesOf(nodeWithId(host.render(), SHEET_ID), 'markdown'), [], 'no empty what-changed text is drawn beside it');
  const unreadChecks = "pull request #12's decision card has no Untested: line";
  host = await openedReport(reportOf({ noScreen: true, checks: { unread: unreadChecks } }));
  flow = sheetFlow(host);
  assert.ok(flow.includes(`Test results not read: ${unreadChecks}`), `unread checks say why: ${JSON.stringify(flow)}`);

  // A screenshot the reader could not fetch is a problem line, and the others are still drawn.
  const good = shotOf(1, 'fabraik-queue/shots/good.png');
  host = await openedReport(reportOf({ screenshots: [good, { alt: 'screenshot-2 bbb', unread: 'its download answered HTTP 404' }] }));
  flow = sheetFlow(host);
  assertInOrder(flow, ['Screenshot 1', `image ${good.path}`, 'Screenshot 2 not read: its download answered HTTP 404', 'Seen'], 'an unread screenshot keeps its place');

  // A change that went to main with no pull request has no report to show.
  host = await openedReport({ format: 1, sha: REPORT_MERGE.sha, direct: true });
  flow = sheetFlow(host);
  assert.ok(flow.includes('No report: this change went to main without a pull request.'), `a direct push says so: ${JSON.stringify(flow)}`);
  assert.ok(!flow.join('\n').includes('What changed'), 'a direct push draws no report body');
});

test('a merge report with neither screenshots nor a no-visual-change line names its missing screenshots', async () => {
  const missing = 'Screenshots not read: it shows no screenshot, and its Evidence section has no line saying no visual change';
  let host = await openedReport(reportOf({ noScreen: false, screenshots: [] }));
  let flow = sheetFlow(host);
  assert.equal(flow.filter((line) => line === missing).length, 1, `the missing screenshots are named once: ${JSON.stringify(flow)}`);
  assertInOrder(flow, ['Why it did not wait', ...NOTHING_NEEDED, missing, 'Seen', 'Open pull request #12'], 'the problem line takes the screenshots\' place');

  host = await openedReport(reportOf({ noScreen: false, screenshots: [shotOf(1, 'fabraik-queue/shots/one.png')] }));
  flow = sheetFlow(host);
  assert.ok(!flow.some((line) => line.startsWith('Screenshots not read')), `a report that shows a screenshot names none missing: ${JSON.stringify(flow)}`);
});

test('a link in what changed opens only through Herdr\'s open_url, never the text view\'s own opening', async () => {
  const host = await openedReport(reportOf({ changed: 'Each merge opens its [preview](https://example.com/a).' }));
  const changed = nodeWithId(host.render(), `queue-report-changed-${REPORT_MERGE.sha}`);
  assert.equal(typeof changed?.linkClick, 'function', 'the what-changed text sets its own link handler');
  changed.linkClick('https://example.com/a', host.cx);
  assert.deepEqual(host.opened, ['https://example.com/a'], 'the link is handed to cx.open_url as written');
});

test('a plain what changed is drawn as its own lines, with no markdown, image or link handler', async () => {
  const lines = ['See [docs](https://example.com/d).', '![x](https://attacker.example/x.png)', '<img src="https://attacker.example/y.png">'];
  const note = 'Shown as written, without formatting or links.';
  const host = await openedReport(reportOf({ changed: { plain: lines.join('\n') } }));
  const sheet = nodeWithId(host.render(), SHEET_ID);
  const flow = flowOf(sheet);
  assertInOrder(flow, ['What changed', note, ...lines, 'Why it did not wait'], 'the plain summary follows its heading and note');
  for (const line of lines) assert.ok(flow.includes(line), `${line} is drawn as its own text: ${JSON.stringify(flow)}`);
  const noted = [...walk(sheet)].map(([node]) => node).find((node) => node.kids.includes(note));
  assert.equal(called(noted, 'text_color').at(-1)?.[0], 'muted', 'the note is a muted line');
  assert.deepEqual(nodesOf(sheet, 'markdown'), [], 'no markdown text is drawn');
  assert.deepEqual(nodesOf(sheet, 'image'), [], 'no image is drawn');
  assert.equal([...walk(sheet)].filter(([node]) => node.linkClick !== null).length, 0, 'no node handles a link');
});

test('a malformed report from the queue is named, never drawn as an empty report', async () => {
  const whole = reportOf({});
  const without = (field) => Object.fromEntries(Object.entries(whole).filter(([name]) => name !== field));
  const malformed = [
    ['output that is not JSON', 'queue: the reader printed this instead\n'],
    ['output that is empty', ''],
    ['a wrong format', reportOf({ format: 2 })],
    ['a pull request address that is not https', reportOf({ pull: { ...whole.pull, url: 'http://github.com/o/r/pull/12' } })],
    ['a pull request address that is a file', reportOf({ pull: { ...whole.pull, url: 'file:///etc/passwd' } })],
    ['a changed plain that is not text', reportOf({ changed: { plain: 7 } })],
    ...['pull', 'card', 'changed', 'checks', 'noScreen', 'outcome', 'screenshots'].map((field) => [`a report with no ${field}`, without(field)]),
  ];
  for (const [name, reply] of malformed) {
    const host = await openedReport(reply);
    const flow = sheetFlow(host);
    assert.deepEqual(flow.filter((line) => line.startsWith('Report not read')), [CANNOT_READ], `${name}: the sheet names it: ${JSON.stringify(flow)}`);
    assert.equal(sheetButtons(host, 'Try again').length, 1, `${name}: it offers Try again`);
    assert.equal(sheetButtons(host, 'Mark as seen').length, 1, `${name}: it offers Mark as seen`);
    const text = flow.join('\n');
    assert.ok(!text.includes('What changed') && !text.includes('Why it') && !text.includes('Merged'), `${name}: no report body is drawn`);
    assert.deepEqual(host.opened, [], `${name}: nothing is opened`);
  }

  // The positive control: the same harness reads a whole report.
  const control = sheetFlow(await openedReport(whole));
  assert.ok(control.includes('What changed') && !control.some((line) => line.startsWith('Report not read')), `a whole report is read: ${JSON.stringify(control)}`);
});

// The New mark's expectations are written by hand from card #759's acceptance criterion 3, the owner's answer to when a
// merge stops being New ("Once its report is read"), the plan's D1 and seen store, and Herdr's documented persistence of
// `shared()`: an unseen merge carries the chip in every view; a report that loaded clears it and its sheet then says "Seen";
// a failed report stays New until Mark as seen; the marks live in `shared("fabraik-queue.seen")` as
// { "<repository>@<sha>": "<ISO time>" }, so a restarted copy and every other view find them, and each write drops marks older
// than 48 hours; a store the panel cannot read is named and shows every merge as New. The unreadable-store line's words are
// not fixed, so only that it says "seen" and "not read" is.
const SEEN_KEY = 'fabraik-queue.seen';
const SEEN_NOW = new Date(NOON_12TH).toISOString();
const hoursBefore = (hours) => new Date(NOON_12TH - hours * 3600000).toISOString();
// Each view's props, in MERGE_VIEWS order.
const MERGE_VIEW_PROPS = [DECISIONS, FLOOR, { view: 'board', repository: '/repos/a' }];
const REPORT_URL = 'https://github.com/o/r/pull/12';
const UNREACHABLE = { code: 1, stdout: '', stderr: 'the reader could not reach its tracker\n' };
// A scene as `MERGE_VIEWS` makes one, with `sharedState` in place before the panel reads, as a restarted copy finds it.
async function seenScene(props, cache, /** @type {Exec} */ execResult, sharedState) {
  const host = await loadPanel(execResult, props);
  host.sharedState = sharedState;
  host.setCache(cache);
  await host.panel.load();
  return host;
}
function openerOf(view, host, merge) {
  const found = view.opener(host.render(), merge);
  assert.ok(found, `${view.name}: ${merge.subject} is drawn as a button`);
  return found;
}
function chipRowOf(view, host, merge) {
  const found = view.chipRow(host.render(), merge);
  assert.ok(found, `${view.name}: ${merge.subject} draws its chip row`);
  return found;
}
// The chip is the one element holding the word New, outlined in accent and leading its chip row.
function assertNew(row, marked, message) {
  const chips = [...walk(row)].map(([node]) => node).filter((node) => node.kids.includes('New'));
  assert.equal(chips.length, marked ? 1 : 0, `${message}: ${marked ? 'marked New' : 'not marked New'}`);
  if (!marked) return;
  assert.equal(called(chips[0], 'border_color').at(-1)?.[0], 'accent', `${message}: the chip is outlined in accent`);
  assert.equal(flowOf(row)[0], 'New', `${message}: the chip leads its row`);
}
const seenWrites = (host) => host.sets.filter(([key]) => key === SEEN_KEY).map(([, value]) => value);
// The sheet's control once its merge is seen: the muted word, in place of the Mark as seen button.
function assertSeenWord(host, message) {
  assert.deepEqual(sheetButtons(host, 'Mark as seen'), [], `${message}: Mark as seen is gone`);
  const word = [...walk(nodeWithId(host.render(), SHEET_ID))].map(([node]) => node).find((node) => node.kids.includes('Seen'));
  assert.ok(word, `${message}: the sheet says Seen: ${sheetLines(host).join(' | ')}`);
  assert.equal(called(word, 'text_color').at(-1)?.[0], 'muted', `${message}: the word is muted`);
}

test('an unopened merge is marked New in every view until its report is read or marked seen', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  for (const [at, view] of MERGE_VIEWS.entries()) {
    /** @type {ExecResult | Promise<ExecResult>} */
    let reply = UNREACHABLE;
    const host = await seenScene(MERGE_VIEW_PROPS[at], mergeCache(), () => reply, {});
    const chip = (drawn, marked, when) => assertNew(chipRowOf(view, host, drawn), marked, `${view.name}: ${drawn.subject} ${when}`);

    for (const drawn of MERGES) chip(drawn, true, 'before it is opened');
    assert.deepEqual(seenWrites(host), [], `${view.name}: drawing the merges marks none seen`);

    // A report that did not load, whether the run failed or printed what the panel cannot read, leaves the merge New.
    for (const failed of [UNREACHABLE, { code: 0, stdout: 'the queue printed this instead\n', stderr: '' }]) {
      reply = failed;
      await host.click(openerOf(view, host, merge));
      assert.ok(sheetLines(host).some((line) => line.startsWith('Report not read')), `${view.name}: the read failed: ${sheetLines(host).join(' | ')}`);
      await keyIn(host, 'escape');
      chip(merge, true, 'after a report that did not load');
      chip(other, true, 'beside a report that did not load');
    }
    assert.deepEqual(seenWrites(host), [], `${view.name}: a report that did not load marks none seen`);

    // A report that loaded clears its merge, says Seen in place of the button, and leaves the other merge New.
    reply = reportRead(merge);
    await host.click(openerOf(view, host, merge));
    assertSeenWord(host, `${view.name}: a loaded report`);
    assert.deepEqual(seenWrites(host).at(-1), { [mergeKey(merge)]: SEEN_NOW }, `${view.name}: the loaded report is marked seen in the shared store`);
    assert.equal(sheetButtons(host, 'Open pull request #12').length, 1, `${view.name}: the pull request link stays`);
    await host.click(sheetButtons(host, 'Open pull request #12')[0]);
    assert.deepEqual(host.opened, [REPORT_URL], `${view.name}: Open pull request opens that report's pull request address`);
    await keyIn(host, 'escape');
    chip(merge, false, 'after its report was read');
    chip(other, true, 'beside a merge whose report was read');

    // Another view reads the same store, now and after the next mark.
    const [next, nextProps] = [MERGE_VIEWS[(at + 1) % MERGE_VIEWS.length], MERGE_VIEW_PROPS[(at + 1) % MERGE_VIEWS.length]];
    const beside = await seenScene(nextProps, mergeCache(), OK, host.sharedState);
    assertNew(chipRowOf(next, beside, merge), false, `${next.name}: ${merge.subject} read in ${view.name}`);
    assertNew(chipRowOf(next, beside, other), true, `${next.name}: ${other.subject} unread in ${view.name}`);

    // Mark as seen on a report that failed to load clears the merge, and the sheet says Seen in place of the button.
    reply = UNREACHABLE;
    await host.click(openerOf(view, host, other));
    await host.click(sheetButtons(host, 'Mark as seen')[0]);
    assert.deepEqual(seenWrites(host).at(-1), { [mergeKey(merge)]: SEEN_NOW, [mergeKey(other)]: SEEN_NOW }, `${view.name}: Mark as seen writes the merge beside the earlier mark`);
    assertSeenWord(host, `${view.name}: a failed report marked seen`);
    await keyIn(host, 'escape');
    chip(other, false, 'after Mark as seen');
    assertNew(chipRowOf(next, beside, other), false, `${next.name}: ${other.subject} marked seen in ${view.name}, drawn again`);
  }
});

test('the seen mark survives a restart and marks older than two days are dropped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  const [stale, recent] = [`/repos/b@${'c'.repeat(40)}`, `/repos/b@${'e'.repeat(40)}`];
  for (const [at, view] of MERGE_VIEWS.entries()) {
    const props = MERGE_VIEW_PROPS[at];

    // Herdr keeps shared values in shared.json, so a restarted copy finds what that file would hold.
    const first = await seenScene(props, mergeCache(), () => reportRead(merge), {});
    await first.click(openerOf(view, first, merge));
    const stored = JSON.parse(JSON.stringify(first.sharedState));
    assert.deepEqual(stored[SEEN_KEY], { [mergeKey(merge)]: SEEN_NOW }, `${view.name}: the mark is in the shared store`);
    const restarted = await seenScene(props, mergeCache(), OK, stored);
    assertNew(chipRowOf(view, restarted, merge), false, `${view.name}: ${merge.subject} after a restart`);
    assertNew(chipRowOf(view, restarted, other), true, `${view.name}: ${other.subject} after a restart`);

    // Each write keeps the marks of the last two days and drops the older.
    const aged = await seenScene(props, mergeCache(), () => reportRead(merge), { [SEEN_KEY]: { [stale]: hoursBefore(49), [recent]: hoursBefore(47) } });
    await aged.click(openerOf(view, aged, merge));
    assert.deepEqual(seenWrites(aged).at(-1), { [recent]: hoursBefore(47), [mergeKey(merge)]: SEEN_NOW }, `${view.name}: the write drops the mark of 49 hours ago and keeps the rest`);
  }
});

test('an unreadable seen store is named and every merge shows as New', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge] = MERGES;
  const unreadable = [
    ['a string', 'seen it'],
    ['an array', [mergeKey(merge)]],
    ['a value that is not a time', { [mergeKey(merge)]: 'yesterday' }],
  ];
  const namesStore = (host) => strings(host.render()).filter((line) => /seen/i.test(line) && /not read/i.test(line));
  for (const [at, view] of MERGE_VIEWS.entries()) {
    const props = MERGE_VIEW_PROPS[at];

    // The positive controls: no store yet, and a readable one, name nothing, and the readable one's mark clears its merge.
    const unwritten = await seenScene(props, mergeCache(), OK, {});
    assert.deepEqual(namesStore(unwritten), [], `${view.name}: a store never written is not unreadable`);
    for (const drawn of MERGES) assertNew(chipRowOf(view, unwritten, drawn), true, `${view.name}: ${drawn.subject} with no store`);
    const readable = await seenScene(props, mergeCache(), OK, { [SEEN_KEY]: { [mergeKey(merge)]: SEEN_NOW } });
    assert.deepEqual(namesStore(readable), [], `${view.name}: a readable store is not named`);
    assertNew(chipRowOf(view, readable, merge), false, `${view.name}: ${merge.subject} with a readable store`);

    for (const [what, value] of unreadable) {
      const host = await seenScene(props, mergeCache(), OK, { [SEEN_KEY]: value });
      assert.ok(namesStore(host).length > 0, `${view.name}: ${what} is named: ${JSON.stringify(strings(host.render()))}`);
      for (const drawn of MERGES) assertNew(chipRowOf(view, host, drawn), true, `${view.name}: ${drawn.subject} with ${what} in the store`);
    }
  }
});

test('a report that loads after its sheet is closed leaves the merge New until it is opened and read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  for (const [at, view] of MERGE_VIEWS.entries()) {
    /** @type {ExecResult | Promise<ExecResult>} */
    let reply = OK;
    const host = await seenScene(MERGE_VIEW_PROPS[at], mergeCache(), () => reply, {});
    const chip = (drawn, marked, when) => assertNew(chipRowOf(view, host, drawn), marked, `${view.name}: ${drawn.subject} ${when}`);

    // The sheet is closed while the queue still reads; the report's reply lands afterwards and is read by no one.
    let release;
    reply = new Promise((resolve) => { release = resolve; });
    const opening = host.click(openerOf(view, host, merge));
    await keyIn(host, 'escape');
    assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, `${view.name}: Esc closes the sheet while its report is still read`);
    release(reportRead(merge));
    await opening;
    assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, `${view.name}: a reply landing after the close does not draw the sheet again`);
    assert.deepEqual(seenWrites(host), [], `${view.name}: a report that loaded into a closed sheet marks none seen`);
    chip(merge, true, 'after its report loaded into a closed sheet');
    chip(other, true, 'beside it');

    // Opened again, its report loads into the open sheet, and that marks it seen.
    reply = reportRead(merge);
    await host.click(openerOf(view, host, merge));
    assertSeenWord(host, `${view.name}: a report that loaded into the open sheet`);
    assert.deepEqual(seenWrites(host).at(-1), { [mergeKey(merge)]: SEEN_NOW }, `${view.name}: the report read in the open sheet is marked seen`);
    await keyIn(host, 'escape');
    chip(merge, false, 'after it was opened and read');
    chip(other, true, 'beside a merge that was read');
  }
});

// The real-window drive of card #759 found two layout defects the tests above never looked at. Each digest line is a button
// whose content Herdr centres unless it is told to start at the left, so lines of different length began at different
// indents; and in a long report the sheet's footer sat inside the scrolling body, so Tab moved focus to a control that was
// off screen. The expectations are written by hand from the drive's screenshots: every digest line starts at the left, and
// the footer is a row of the sheet's panel below the scrolling body.
const DIGEST_ID = 'fabraik-queue-digest-';
const SHEET_BODY_ID = `${FLOOR_ID}sheet-body`;
const SHEET_SEEN_ID = `${FLOOR_ID}sheet-seen`;
const SHEET_PULL_ID = `${FLOOR_ID}sheet-pull`;

test('every merged digest line in the Decisions view starts at the left of its box', async () => {
  for (const { name, scene } of MERGE_VIEWS.slice(0, 1)) {
    const host = await scene(mergeCache(), OK);
    const lines = buttonsIn(host.render()).filter((button) => button.elementId?.startsWith(DIGEST_ID));
    assert.equal(lines.length, MERGES.length, `${name}: each merge is drawn as a digest line`);
    for (const line of lines) assert.equal(called(line, 'justify_start').length, 1, `${name}: ${line.elementId} is told to start at the left`);
  }
});

// Whether `inner` is `outer` or drawn beneath it.
const drawnIn = (outer, inner) => [...walk(outer)].some(([node]) => node === inner);

test("the merge sheet's footer is a row of its panel below the scrolling body, for a loaded report and a failed read", async () => {
  const loaded = await openedReport(reportOf({}));
  const failed = await openedReport('queue: the reader printed this instead\n');
  for (const [name, host, footer] of [
    ['a loaded report', loaded, [SHEET_PULL_ID, 'Seen']],
    ['a failed read', failed, [SHEET_SEEN_ID]],
  ]) {
    const tree = host.render();
    const panel = nodeWithId(tree, SHEET_PANEL_ID);
    const body = nodeWithId(tree, SHEET_BODY_ID);
    assert.ok(panel && body, `${name}: the sheet draws its panel and its scrolling body`);
    for (const control of footer) {
      const node = nodeWithId(tree, control) ?? [...walk(panel)].map(([found]) => found).find((found) => found.kids.includes(control));
      assert.ok(node, `${name}: ${control} is drawn`);
      assert.ok(drawnIn(panel, node), `${name}: ${control} is in the sheet panel`);
      assert.ok(!drawnIn(body, node), `${name}: ${control} is outside the scrolling body, so it is always on screen`);
    }
  }
  const content = [...walk(nodeWithId(loaded.render(), SHEET_BODY_ID))].map(([node]) => node);
  for (const text of ['Merged work shows its report', 'What changed']) {
    assert.ok(content.some((node) => node.kids.includes(text)), `a loaded report: ${text} stays in the scrolling body`);
  }
});

// The same drive found the Merged column cutting an unseen merge's chip off at the left edge and drawing its title past the
// right edge: the row holding the chip had no width limit and its first line could not shrink below its text. The
// expectations are written by hand from the drive's screenshot: the row is bounded by its opener, the chip keeps its size
// and the first line may shrink and wrap. The Board's entry no longer holds the chip in its title, so only the Floor does.
test("an unseen merge's New chip row stays inside its opener on the Floor", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const long = mergeOf('1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d', `${'Keep a long merge subject inside its box '.repeat(4)}(#12)`, '09:05');
  const view = MERGE_VIEWS[1];
  const host = await view.scene(mergeCache([long]), OK);
  const opener = openerOf(view, host, long);
  const chips = [...walk(opener)].filter(([node]) => node.kids.includes('New'));
  assert.equal(chips.length, 1, `${view.name}: the unseen merge is marked New`);
  const [[chip, row]] = chips;
  assert.equal(row.kids.length, 2, `${view.name}: the chip and the first line are the row's two children`);
  const first = row.kids.find((kid) => kid !== chip);
  assert.equal(called(row, 'max_w_full').length, 1, `${view.name}: the row is bounded by its opener's width`);
  assert.equal(called(chip, 'flex_none').length, 1, `${view.name}: the chip keeps its size`);
  assert.equal(called(first, 'min_w_0').length, 1, `${view.name}: the first line may shrink and wrap`);
});

// The Board's merged entry and Merged column controls are written by hand from card #849's acceptance criteria 2, 3 and 5,
// the plan's decisions 5 and 6 and its Visual direction: the title button holds the subject alone at the entry's full
// width; the bottom line holds the New chip, the time and an outlined Mark as seen of at least 24 by 24 that marks the merge
// seen in one shared-store write, opens no sheet, runs no command and moves focus to that title; the column's Mark all seen
// marks every unseen listed merge in one write, keeps the marks of the last two days only, and moves focus to the first
// title; while the sheet is open none of them takes a press or Tab; and a restarted copy shows no New and no control.
test('a Board merged entry and the Merged column mark merges seen without opening a report and the marks survive a restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const [merge, other] = MERGES;
  const [view, props] = [MERGE_VIEWS[2], MERGE_VIEW_PROPS[2]];
  const [stale, recent] = [`/repos/b@${'c'.repeat(40)}`, `/repos/b@${'e'.repeat(40)}`];
  const idOf = (what, drawn) => `${BOARD_ID}merged-${what}-${drawn.sha}`;
  const all = (host) => nodeWithId(host.render(), `${BOARD_ID}merged-seen-all`);
  const controls = (host) => [...MERGES.map((drawn) => nodeWithId(host.render(), idOf('seen', drawn))), all(host)].filter(Boolean);
  const header = (host) => {
    const column = strings(boardColumnOf(host.render(), 'merged'));
    return column.slice(0, column.indexOf(merge.subject));
  };

  // 1. The card: the title alone on the top row at full width, then the bottom line with the chip, the time and the control.
  const host = await seenScene(props, mergeCache(), OK, {});
  for (const drawn of MERGES) {
    const tree = host.render();
    const entry = nodeWithId(tree, idOf('entry', drawn));
    const title = nodeWithId(tree, `${BOARD_ID}merged-${drawn.sha}`);
    const line = nodeWithId(tree, idOf('line', drawn));
    const seen = nodeWithId(tree, idOf('seen', drawn));
    assert.ok(entry && title && line && seen, `${drawn.subject}: the entry, its title, its bottom line and its Mark as seen are drawn`);
    assert.ok(drawnIn(entry, title) && drawnIn(entry, line), `${drawn.subject}: the title and the bottom line are the entry's rows`);
    assert.ok(!drawnIn(title, seen) && !drawnIn(title, line) && !drawnIn(line, title), `${drawn.subject}: no button holds another`);
    assert.equal(title.elementId, `${BOARD_ID}merged-${drawn.sha}`, `${drawn.subject}: the title keeps its id`);
    assert.equal(called(title, 'w_full').length, 1, `${drawn.subject}: the title takes the entry's full width`);
    assert.deepEqual(strings(title), [drawn.subject], `${drawn.subject}: the title holds the subject alone`);
    assert.equal(labelOf(title), `New, ${drawn.subject}, merged at ${drawn.time}`, `${drawn.subject}: the title is named for the screen reader, New first`);
    assert.deepEqual(flowOf(line), ['New', `merged at ${drawn.time}`, 'Mark as seen'], `${drawn.subject}: the bottom line reads chip, time, control`);
    assert.equal(called(line, 'flex_wrap').length, 1, `${drawn.subject}: the bottom line wraps on a narrow column`);
    const chip = [...walk(line)].map(([node]) => node).find((node) => node.kids.includes('New'));
    assert.equal(called(chip, 'flex_none').length, 1, `${drawn.subject}: the chip keeps its size`);
    assert.equal(called(seen, 'h').at(-1)?.[0], 24, `${drawn.subject}: Mark as seen is 24 high`);
    assert.equal(called(seen, 'min_w').at(-1)?.[0], 24, `${drawn.subject}: Mark as seen is 24 wide at least`);
    assert.equal(labelOf(seen), `Mark ${drawn.subject} as seen`, `${drawn.subject}: Mark as seen names its merge`);
  }
  assert.deepEqual(header(host), ['Merged', '2 new', 'Mark all seen'], 'the header counts the merges still New and offers Mark all seen');
  assert.equal(called(all(host), 'h').at(-1)?.[0], 24, 'Mark all seen is 24 high');
  assert.equal(called(all(host), 'min_w').at(-1)?.[0], 24, 'Mark all seen is 24 wide at least');

  // 2. Mark as seen on the second merge: one write, no sheet, no command, focus on that title, the rest untouched.
  await host.click(nodeWithId(host.render(), idOf('seen', other)));
  assert.deepEqual(seenWrites(host), [{ [mergeKey(other)]: SEEN_NOW }], 'Mark as seen writes that merge once');
  assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, 'Mark as seen opens no sheet');
  assert.deepEqual(ran(host), [], 'Mark as seen runs no command, so no report is read');
  assert.deepEqual(host.runs, [], 'Mark as seen runs no Herdr command');
  assert.ok(trackedFocused(openerOf(view, host, other)), 'focus moves to that merge title');
  assertNew(chipRowOf(view, host, other), false, 'the merge marked seen');
  assertNew(chipRowOf(view, host, merge), true, 'the merge beside it');
  assert.deepEqual(flowOf(chipRowOf(view, host, other)), [`merged at ${other.time}`], 'a seen merge keeps its time alone');
  assert.equal(nodeWithId(host.render(), idOf('seen', other)), undefined, 'a seen merge offers no Mark as seen');
  assert.equal(labelOf(openerOf(view, host, other)), `${other.subject}, merged at ${other.time}`, 'a seen merge title no longer leads with New');
  assert.deepEqual(header(host), ['Merged', '1 new', 'Mark all seen'], 'the count falls to the merges still New');

  // 3. Mark all seen: one write for the unseen merge, focus on the first title, then no New and no control remain.
  await host.click(all(host));
  assert.equal(seenWrites(host).length, 2, 'Mark all seen is one more write');
  assert.deepEqual(seenWrites(host).at(-1), { [mergeKey(other)]: SEEN_NOW, [mergeKey(merge)]: SEEN_NOW }, 'it keeps the earlier mark and adds the unseen merge');
  assert.equal(nodeWithId(host.render(), SHEET_ID), undefined, 'Mark all seen opens no sheet');
  assert.deepEqual(ran(host), [], 'Mark all seen runs no command');
  assert.ok(trackedFocused(openerOf(view, host, merge)), 'focus moves to the first title');
  assert.deepEqual(header(host), ['Merged', '0 new'], 'the header counts none and offers no Mark all seen');
  assert.deepEqual(controls(host), [], 'no Mark as seen is drawn once every merge is seen');
  for (const drawn of MERGES) assertNew(chipRowOf(view, host, drawn), false, `${drawn.subject} after Mark all seen`);

  // 4. A restarted copy finds the marks in the shared store: no New, no control.
  const restarted = await seenScene(props, mergeCache(), OK, JSON.parse(JSON.stringify(host.sharedState)));
  for (const drawn of MERGES) assertNew(chipRowOf(view, restarted, drawn), false, `${drawn.subject} after a restart`);
  assert.deepEqual(controls(restarted), [], 'a restarted copy draws no control');
  assert.deepEqual(header(restarted), ['Merged', '0 new'], 'a restarted copy counts none');

  // 5. Mark all seen writes once, marks every unseen listed merge, drops a mark of 49 hours and keeps one of 47.
  const aged = await seenScene(props, mergeCache(), OK, { [SEEN_KEY]: { [stale]: hoursBefore(49), [recent]: hoursBefore(47) } });
  await aged.click(all(aged));
  assert.deepEqual(seenWrites(aged), [{ [recent]: hoursBefore(47), [mergeKey(merge)]: SEEN_NOW, [mergeKey(other)]: SEEN_NOW }],
    'one write holds every listed merge and the mark of 47 hours, and not the mark of 49');
  assert.ok(trackedFocused(openerOf(view, aged, merge)), 'focus is on the first title');

  // 6. While the sheet is open no control takes a press or Tab, and the failed read leaves the merges New.
  const open = await seenScene(props, mergeCache(), () => UNREACHABLE, {});
  await open.click(openerOf(view, open, merge));
  assert.ok(nodeWithId(open.render(), SHEET_ID), 'the sheet is open');
  assert.equal(controls(open).length, MERGES.length + 1, 'every Mark as seen and Mark all seen is drawn beneath the sheet');
  for (const control of controls(open)) {
    assert.equal(control.click, null, `${controlName(control)} takes no press while the sheet is open`);
    assert.equal(called(control, 'tab_stop').at(-1)?.[0], false, `${controlName(control)} is no tab stop while the sheet is open`);
  }
  assert.deepEqual(seenWrites(open), [], 'nothing is marked seen beneath the open sheet');
});

// The Merged column's collapse is written by hand from card #849's criteria 3 and 4 and the plan's decision 5: with more than
// three merges the column shows the newest three and every merge a report says does not add up (`disagrees`), in the list's
// order, then one control naming the whole count, which shows every merge and reads "Show fewer" until pressed again; while
// collapsed and a hidden merge is not noted, or noted `unread`, the column's notice says not every hidden merge was checked.
// The merges' outcomes are known from the reports the queue kept, which the Board's background read notes after a read.
test('the Merged column shows the newest three and every merge whose record does not add up and says when a hidden merge was not checked', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_12TH });
  const merges = ['5', '4', '3', '2', '1'].map((digit, at) => mergeOf(digit.repeat(40), `Merge number ${at + 1} (#${20 + at})`, `09:${digit}0`));
  const [m1, m2, m3, m4, m5] = merges;
  const NOTICE = 'Not every hidden merge has been checked, so one whose record does not add up may be among them';
  const keepReport = (host, merge, fields) => {
    host.files[keptFileOf(mergeKey(merge))] = JSON.stringify({ format: 1, key: mergeKey(merge), report: reportDocument({ sha: merge.sha, ...fields }) });
  };
  const DISAGREES = { outcome: 'disagrees', level: 'always', holds: ['a change'] };
  // A scene whose kept reports are `kept`, each `nothing` unless `fields` gives its merge's own fields.
  const sceneOf = async (listed, /** @type {Exec} */ execResult, kept, /** @type {Map<object, object>} */ fields = new Map([[m5, DISAGREES]])) => {
    const host = await boardScene('/repos/a', mergeCache(listed), execResult);
    for (const merge of kept) keepReport(host, merge, fields.get(merge) ?? {});
    return host;
  };
  // The merges the column lists, in the order it draws their title buttons.
  const titles = (host) => {
    const prefix = `${BOARD_ID}merged-`;
    return buttonsIn(boardColumnOf(host.render(), 'merged'))
      .map((button) => merges.find((merge) => button.elementId === `${prefix}${merge.sha}`)?.subject)
      .filter((subject) => subject !== undefined);
  };
  const more = (host) => nodeWithId(host.render(), `${BOARD_ID}merged-more`);
  const noticed = (host) => strings(boardColumnOf(host.render(), 'merged')).includes(NOTICE);
  const subjects = (...shown) => shown.map((merge) => merge.subject);

  // 1. Before any background read has landed nothing is noted, so the newest three show and the notice says so.
  const host = await sceneOf(merges, () => UNREACHABLE, merges);
  assert.deepEqual(titles(host), subjects(m1, m2, m3), 'collapsed, the column lists the newest three');
  assert.equal(nameOf(more(host)), 'Show all 5 merges', 'the control names the whole count');
  assert.ok(noticed(host), 'a hidden merge not yet checked is named in the notice');

  // 2. Once the read has noted all five, the one that disagrees shows beside the newest three and no notice remains.
  await readCache(host);
  assert.deepEqual(ran(host), [], 'every report was the kept one, so no report was run');
  assert.deepEqual(titles(host), subjects(m1, m2, m3, m5), 'the merge whose record does not add up shows with the newest three, in list order');
  assert.equal(nameOf(more(host)), 'Show all 5 merges', 'the control still names the whole count');
  assert.ok(!noticed(host), 'every hidden merge was checked, so there is no notice');

  // 3. Show all lists every merge and reads Show fewer, with no notice; Show fewer restores the collapsed column.
  await host.click(more(host));
  assert.deepEqual(titles(host), subjects(m1, m2, m3, m4, m5), 'expanded, the column lists every merge');
  assert.equal(nameOf(more(host)), 'Show fewer', 'the expanded control offers Show fewer');
  assert.ok(!noticed(host), 'the expanded column shows no notice');
  await host.click(more(host));
  assert.deepEqual(titles(host), subjects(m1, m2, m3, m5), 'Show fewer restores the collapsed column');
  assert.equal(nameOf(more(host)), 'Show all 5 merges', 'the control names the whole count again');
  assert.ok(!noticed(host), 'the restored column shows no notice');

  // 4. A merge whose report cannot be read stays unchecked, though the kept report beyond it is noted, so the notice stays.
  const stopped = await sceneOf(merges, () => UNREACHABLE, [m1, m2, m3, m5]);
  await readCache(stopped);
  assert.deepEqual(titles(stopped), subjects(m1, m2, m3, m5), 'a merge never checked is not known to disagree, but the kept report beyond it is noted and shows');
  assert.equal(nameOf(more(stopped)), 'Show all 5 merges', 'the control names the whole count');
  assert.ok(noticed(stopped), 'a hidden merge that was not checked is named in the notice');

  // 5. With exactly three merges collapsing hides none, so there is no control and no notice, read or not.
  const three = await sceneOf([m1, m2, m3], () => UNREACHABLE, [m1, m2, m3]);
  for (const when of ['before the read', 'after the read']) {
    if (when === 'after the read') await readCache(three);
    assert.deepEqual(titles(three), subjects(m1, m2, m3), `three merges are all listed ${when}`);
    assert.equal(more(three), undefined, `three merges draw no control ${when}`);
    assert.ok(!noticed(three), `three merges draw no notice ${when}`);
  }

  // 6. A hidden merge noted unread has not been checked either, so the notice stays though every merge is noted.
  const unread = await sceneOf(merges, () => UNREACHABLE, merges, new Map(/** @type {[object, object][]} */ ([[m4, { outcome: 'unread', level: undefined, cause: 'its card could not be read', lasting: true }], [m5, DISAGREES]])));
  await readCache(unread);
  assert.deepEqual(ran(unread), [], 'every report was the kept one, so no report was run');
  assert.deepEqual(titles(unread), subjects(m1, m2, m3, m5), 'a merge noted unread is hidden, and the one that disagrees shows');
  assert.ok(noticed(unread), 'a hidden merge noted unread is named in the notice');

  // 7. While a merge's sheet is open the control takes no press and no Tab, and the column keeps its merges.
  const open = await sceneOf(merges, () => UNREACHABLE, merges);
  await readCache(open);
  const before = titles(open);
  await open.click(nodeWithId(open.render(), `${BOARD_ID}merged-${m1.sha}`));
  assert.ok(nodeWithId(open.render(), SHEET_ID), 'the sheet is open');
  assert.ok(more(open), 'the control is drawn beneath the sheet');
  assert.equal(more(open).click, null, 'the control takes no press while the sheet is open');
  assert.equal(called(more(open), 'tab_stop').at(-1)?.[0], false, 'the control is no tab stop while the sheet is open');
  assert.deepEqual(titles(open), before, 'opening the sheet changes no merge listed');
});


// One public initialization per group supplies the opaque source fingerprint; the remaining cases clone its
// valid journal and inject only the clock, collectors and native command boundary. No account or network is used.
/** @typedef {any} NotificationBox one case of the fixture: a mutable record the tests read and the injected boundaries write */
function notificationFixture(t, notificationTick) {
  const folder = realpathSync(temporaryFolder(t, 'herdr-notification-'));
  const roots = [join(folder, 'first'), join(folder, 'second')];
  const account = join(folder, 'account');
  const trustedDirectory = join(folder, 'sender');
  const configHome = join(folder, 'config');
  const stateHome = join(folder, 'state');
  for (const path of [...roots, account, trustedDirectory, join(configHome, 'fabraik'), stateHome]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const { home } = releasedHome(t, roots);
  const configuration = { format: 1, login: 'owner', claudeConfigDir: account, trustedDirectory,
    morning: { time: '08:00', timeZone: 'Europe/London' } };
  const configPath = join(configHome, 'fabraik', 'notifications.json');
  const writeConfiguration = (value = configuration) => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  writeConfiguration();
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome };
  const initialize = () => spawnSync(process.execPath, [QUEUE, 'notify', '--initialize', '--home', home], { env, encoding: 'utf8' });
  const initialized = initialize();
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.stdout, 'notification: initialized\n');
  assert.equal(initialized.stderr, '');
  const initialState = join(stateHome, 'fabraik-lead');
  const initializedJournal = join(initialState, 'notifications', 'journal.json');
  const seed = JSON.parse(readFileSync(initializedJournal, 'utf8'));
  assert.deepEqual(Object.keys(seed).sort(), ['format', 'profile', 'morning', 'sourcesKey', 'recordingStartedAt',
    'lastAttemptAt', 'morningKey', 'pending', 'events'].sort());
  assert.deepEqual(seed.profile, { login: 'owner', account });
  assert.deepEqual(seed.morning, configuration.morning);
  assert.match(seed.sourcesKey, /^[0-9a-f]{64}$/);
  assert.equal(seed.lastAttemptAt, null);
  assert.equal(seed.morningKey, null);
  assert.equal(seed.pending, null);
  assert.deepEqual(seed.events, []);
  const before = readFileSync(initializedJournal);
  const repeated = initialize();
  assert.equal(repeated.status, 1, 'initialization cannot replace established reservations');
  assert.equal(repeated.stderr, 'queue: notification unavailable: state-unavailable\n');
  assert.deepEqual(readFileSync(initializedJournal), before);
  let serial = 0;
  const make = (/** @type {{ at?: string, started?: string, morningKey?: string | null, lastAttemptAt?: string | number | null, events?: any[], waits?: any[], morning?: any }} */ {
    at = '2026-11-06T03:00:00Z', started = '2026-11-05T14:00:00Z', morningKey = null,
    lastAttemptAt = null, events = [], waits = [{ card: 1, kind: 'question' }], morning = configuration.morning } = {}) => {
    writeConfiguration({ ...configuration, morning });
    const state = join(folder, `case-${++serial}`);
    const directory = join(state, 'notifications');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const journal = join(directory, 'journal.json');
    const lock = join(directory, 'journal.lock');
    const initial = { ...seed, morning, recordingStartedAt: new Date(started).toISOString(), morningKey,
      lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(), pending: null, events };
    const save = (value) => writeFileSync(journal, JSON.stringify(value), { mode: 0o600 });
    save(initial);
    writeFileSync(lock, '', { mode: 0o600 });
    /** @type {NotificationBox} */
    const box = { state, directory, journal, lock, initial, save, epoch: Date.parse(at), calls: [], logs: [], collected: [],
      read: () => JSON.parse(readFileSync(journal, 'utf8')) };
    const document = collectorDocument({ notifications: { login: 'owner', waits, unavailable: null } });
    const native = async (file, argv, options) => {
      box.calls.push({ file, argv, options });
      assert.equal(file, 'claude');
      assert.equal(options.cwd, trustedDirectory);
      assert.equal(options.windowsHide, true);
      assert.ok(Number.isInteger(options.timeout) && options.timeout > 0 && options.timeout <= 30_000);
      if (argv[0] === '--bg') {
        const pending = box.read().pending;
        assert.ok(pending, 'reservation is durable before launch');
        assert.equal(box.read().lastAttemptAt, new Date(box.epoch).toISOString());
        assert.deepEqual(argv.slice(0, -1), ['--bg', '--remote-control', pending.name, '--name', pending.name,
          '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--']);
        assert.deepEqual(pending, { name: pending.name, cwd: trustedDirectory, id: null });
        assert.match(pending.name, /^fabraik-notify-[0-9a-f-]{36}$/);
        return { stdout: 'launch prose is ignored', stderr: '' };
      }
      if (argv[0] === 'agents') {
        assert.deepEqual(argv, ['agents', '--json', '--all', '--cwd', trustedDirectory]);
        const pending = box.read().pending;
        return { stdout: JSON.stringify([{ id: '7a4c17cf', name: pending.name, cwd: trustedDirectory,
          kind: 'background', startedAt: 1793923200000, state: 'done' }]), stderr: '' };
      }
      assert.deepEqual(argv, ['stop', '7a4c17cf']);
      assert.equal(box.read().pending.id, '7a4c17cf', 'owned identity is persisted before cleanup');
      return { stdout: '', stderr: '' };
    };
    box.options = { home, configHome, state, now: () => new Date(box.epoch),
      runCollector: async (root) => {
        box.collected.push(root);
        return structuredClone(root === roots[0] ? document : { ...document, notifications: { ...document.notifications, waits: [] } });
      },
      exec: { run: native, wait: async (ms) => {
        assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 5000);
        box.epoch += ms;
      } }, output: { log: (line) => { assert.equal(typeof line, 'string'); box.logs.push(line); } } };
    box.tick = async (overrides = {}) => {
      box.logs.length = 0;
      const result = await notificationTick({ ...box.options, ...overrides });
      assert.equal(result, undefined);
      return box.logs;
    };
    box.prompt = () => box.calls.filter(({ argv }) => argv[0] === '--bg').at(-1)?.argv.at(-1);
    return box;
  };
  const event = (card, at, /** @type {Record<string, any>} */ fields = {}) => ({ format: 1, root: roots[0], login: 'owner', account,
    card, phase: 'build', disposition: 'built', at: new Date(at).toISOString(), id: sha256(`${card}/${at}/${JSON.stringify(fields)}`), ...fields });
  return { folder, roots, home, account, trustedDirectory, configuration, configHome, configPath, writeConfiguration,
    stateHome, initialState, initializedJournal, env, make, event };
}

function notificationSentence(box, expected) {
  assert.equal(box.prompt(), `Reply with exactly this sentence and nothing else: ${expected}`);
  assert.deepEqual(box.logs, ['notification: completed']);
  assert.equal(box.read().pending, null);
}

async function notificationRefusal(box, code, overrides) {
  await assert.rejects(() => box.tick(overrides), (/** @type {Error} */ error) => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, `notification unavailable: ${code}`);
    assert.deepEqual(Object.keys(error), [], 'private native causes and fields are not retained');
    return true;
  });
  assert.deepEqual(box.logs, []);
}

function notificationPlatformRefusal() {
  const result = spawnSync(process.execPath, [QUEUE, 'notify', '--home', '/unavailable-notification-home'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'queue: notification unavailable: unsupported-platform\n');
}

test('phone notifications enforce daily morning summaries and shared durable rolling cap', async (t) => {
  const notificationModule = await import('../../.agents/herdr/fabraik-queue/queue.mjs');
  assert.equal(typeof notificationModule.notificationTick, 'function',
    'notificationTick is absent before implementation');
  if (process.platform !== 'linux') {
    notificationPlatformRefusal();
    await t.test('Linux notification evidence', {
      skip: 'notification flock, private modes, directory sync and shell wire require Linux',
    }, () => {});
    return;
  }
  const fixture = notificationFixture(t, notificationModule.notificationTick);
  const { make, event, roots } = fixture;
  const ordinary = 'Waiting: 2 questions and 1 reviews. Check Herdr for full status.';
  const morning = (n, q = 0, m = 0) => `Saved work records cover ${n} items. Waiting: ${q} questions and ${m} reviews. Check Herdr for full status.`;
  const waits = [{ card: 1, kind: 'question' }, { card: 2, kind: 'question' }, { card: 3, kind: 'review' }];
  for (const at of ['2026-11-06T00:00:00Z', '2026-11-06T03:00:00Z', '2026-11-06T07:59:00Z', '2026-11-06T23:45:00Z']) {
    await t.test(`owner waits and empty queues at ${at}`, async () => {
      const box = make({ at, waits, morningKey: '2026-11-06' });
      await box.tick();
      notificationSentence(box, ordinary);
      const empty = make({ at, waits: [], morningKey: '2026-11-06' });
      assert.deepEqual(await empty.tick(), ['notification: empty']);
      assert.equal(empty.calls.length, 0);
    });
  }
  await t.test('elapsed cap survives restart and is shared by both roots and the morning', async () => {
    const box = make({ at: '2026-11-06T03:00:00Z', waits });
    await box.tick();
    assert.deepEqual(box.collected, roots);
    box.epoch = Date.parse('2026-11-06T03:59:59Z');
    const collected = box.collected.length;
    const called = box.calls.length;
    assert.deepEqual(await box.tick(), ['notification: capped']);
    assert.equal(box.collected.length, collected);
    assert.equal(box.calls.length, called);
    box.epoch = Date.parse('2026-11-06T04:00:00Z');
    await box.tick();
    assert.equal(box.calls.filter(({ argv }) => argv[0] === '--bg').length, 2);
    assert.equal(box.read().lastAttemptAt, '2026-11-06T04:00:00.000Z');
    // A separate invocation has no in-memory scheduler state to reuse.
    await notificationModule.notificationTick({ ...box.options, output: { log: (line) => assert.equal(line, 'notification: capped') } });
    assert.equal(box.calls.filter(({ argv }) => argv[0] === '--bg').length, 2);
  });
  await t.test('07:45 send defers the due 08 morning until 08:45 without losing its date', async () => {
    const box = make({ at: '2026-11-06T07:45:00Z', waits });
    await box.tick();
    notificationSentence(box, ordinary);
    box.epoch = Date.parse('2026-11-06T08:00:00Z');
    assert.deepEqual(await box.tick(), ['notification: capped']);
    assert.equal(box.read().morningKey, null);
    box.epoch = Date.parse('2026-11-06T08:45:00Z');
    await box.tick();
    notificationSentence(box, morning(0, 2, 1));
    assert.equal(box.read().morningKey, '2026-11-06');
  });
  await t.test('first morning after midday setup uses saved records since setup, deduplicated by root and card', async () => {
    const box = make({ at: '2026-11-06T08:00:00Z', waits: [], events: [
      event(10, '2026-11-05T13:59:59Z'), event(11, '2026-11-05T14:00:00Z'),
      event(11, '2026-11-05T15:00:00Z', { phase: 'deliver', disposition: 'merged' }),
      event(11, '2026-11-05T16:00:00Z', { root: roots[1] }), event(12, '2026-11-06T07:59:59Z'),
      event(13, '2026-11-06T08:00:00Z'),
    ] });
    await box.tick();
    notificationSentence(box, morning(3));
    assert.equal(box.read().morningKey, '2026-11-06');
    box.epoch += 3600_000;
    assert.deepEqual(await box.tick(), ['notification: empty']);
    const setupAtTarget = make({ at: '2026-11-06T08:00:00Z', started: '2026-11-06T08:00:00Z', waits: [] });
    assert.deepEqual(await setupAtTarget.tick(), ['notification: empty']);
  });
  for (const [name, start, target] of [
    ['23-hour spring day', '2026-03-28T08:00:00Z', '2026-03-29T07:00:00Z'],
    ['25-hour autumn day', '2026-10-24T07:00:00Z', '2026-10-25T08:00:00Z'],
  ]) {
    await t.test(name, async () => {
      const box = make({ at: target, started: '2026-03-01T00:00:00Z', waits: [], events: [
        event(1, new Date(Date.parse(start) - 1000).toISOString()), event(2, start),
        event(3, new Date(Date.parse(target) - 1000).toISOString()), event(4, target),
      ] });
      await box.tick();
      notificationSentence(box, morning(2));
    });
  }
  for (const [name, configured, before, target, key] of /** @type {[string, { time: string, timeZone: string }, string, string, string][]} */ ([
    ['configured 08:07 first quarter-hour tick', { time: '08:07', timeZone: 'Europe/London' }, '2026-11-06T08:00:00Z', '2026-11-06T08:15:00Z', '2026-11-06'],
    ['fold uses earlier 01:30', { time: '01:30', timeZone: 'Europe/London' }, '2026-10-25T00:29:00Z', '2026-10-25T00:30:00Z', '2026-10-25'],
    ['gap advances to first valid local minute', { time: '01:30', timeZone: 'Europe/London' }, '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-03-29'],
  ])) {
    await t.test(name, async () => {
      const box = make({ at: before, started: new Date(Date.parse(before) - 12 * 3600_000).toISOString(), waits: [], morning: configured });
      assert.deepEqual(await box.tick(), ['notification: empty']);
      box.epoch = Date.parse(target);
      await box.tick();
      notificationSentence(box, morning(0));
      assert.equal(box.read().morningKey, key);
      if (name.startsWith('fold')) {
        box.epoch = Date.parse('2026-10-25T01:30:00Z');
        assert.deepEqual(await box.tick(), ['notification: empty']);
      }
    });
  }
  await t.test('collection crossing the target chooses the newly due morning', async () => {
    const box = make({ at: '2026-11-06T07:59:00Z', waits: [] });
    const collector = box.options.runCollector;
    await box.tick({ runCollector: async (root) => { const result = await collector(root); box.epoch = Date.parse('2026-11-06T08:00:00Z'); return result; } });
    notificationSentence(box, morning(0));
    assert.equal(box.read().morningKey, '2026-11-06');
  });
  await t.test('multi-day restart sends only latest morning', async () => {
    const box = make({ at: '2026-11-09T09:00:00Z', started: '2026-11-05T14:00:00Z', waits: [], events: [
      event(1, '2026-11-07T15:00:00Z'), event(2, '2026-11-08T08:00:00Z'), event(3, '2026-11-09T08:00:00Z'),
    ] });
    await box.tick();
    notificationSentence(box, morning(1));
    assert.equal(box.read().morningKey, '2026-11-09');
    assert.equal(box.calls.filter(({ argv }) => argv[0] === '--bg').length, 1);
  });
  await t.test('simultaneous invocations share one durable reservation', async () => {
    const box = make();
    await Promise.all([notificationModule.notificationTick(box.options), notificationModule.notificationTick(box.options)]);
    assert.equal(box.calls.filter(({ argv }) => argv[0] === '--bg').length, 1);
    assert.deepEqual([...box.logs].sort(), ['notification: capped', 'notification: completed']);
  });
  await t.test('morning configuration and source-set changes reset coverage but retain cap and pending', async () => {
    for (const change of ['morning', 'sources']) {
      const box = make({ at: '2026-11-06T14:00:00Z', lastAttemptAt: '2026-11-06T12:00:00Z', morningKey: '2026-11-06', waits: [] });
      const pending = { name: 'fabraik-notify-11111111-1111-4111-8111-111111111111', cwd: fixture.trustedDirectory, id: '7a4c17cf' };
      box.save({ ...box.initial, pending });
      if (change === 'morning') fixture.writeConfiguration({ ...fixture.configuration, morning: { time: '08:07', timeZone: 'Europe/London' } });
      const machinePath = join(fixture.home, 'fabraik-queue', 'machine.json');
      const machine = readFileSync(machinePath);
      if (change === 'sources') {
        const third = join(fixture.folder, 'third');
        mkdirSync(third, { recursive: true });
        writeFileSync(machinePath, JSON.stringify({ ...JSON.parse(machine.toString()), repositories: [...roots, third] }));
      }
      const original = box.options.exec.run;
      try {
        await box.tick({ exec: { ...box.options.exec, run: async (file, argv, options) => {
          assert.equal(box.read().lastAttemptAt, '2026-11-06T12:00:00.000Z');
          assert.deepEqual(box.read().pending, pending, 'coverage reset cannot erase pending cleanup');
          return original(file, argv, options);
        } } });
        assert.equal(box.read().recordingStartedAt, '2026-11-06T14:00:00.000Z');
        assert.equal(box.read().lastAttemptAt, '2026-11-06T12:00:00.000Z');
        box.epoch = Date.parse('2026-11-07T08:15:00Z');
        await box.tick();
        notificationSentence(box, morning(0));
      } finally { writeFileSync(machinePath, machine); }
    }
  });
  for (const variant of ['missing', 'corrupt', 'oversized', 'journal symlink', 'journal hardlink', 'lock symlink', 'lock hardlink', 'directory symlink', 'unwritable']) {
    await t.test(`hostile ${variant} state fails closed`, async () => {
      const box = make();
      if (variant === 'missing') rmSync(box.journal);
      if (variant === 'corrupt') writeFileSync(box.journal, '{');
      if (variant === 'oversized') writeFileSync(box.journal, 'x'.repeat(1024 * 1024 + 1));
      if (variant.includes('link')) {
        const path = variant.startsWith('lock') ? box.lock : variant.startsWith('directory') ? box.directory : box.journal;
        const target = `${path}-target`;
        if (variant.endsWith('hardlink')) linkSync(path, target);
        else { const bytes = variant.startsWith('directory') ? null : readFileSync(path); rmSync(path, { recursive: true });
          if (bytes === null) { mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'journal.json'), JSON.stringify(box.initial), { mode: 0o600 }); }
          else writeFileSync(target, bytes, { mode: 0o600 });
          symlinkSync(target, path); }
      }
      const before = existsSync(box.journal) ? readFileSync(box.journal) : null;
      if (variant === 'unwritable') chmodSync(box.directory, 0o500);
      try { await notificationRefusal(box, 'state-unavailable'); }
      finally { if (variant === 'unwritable') chmodSync(box.directory, 0o700); }
      assert.equal(box.calls.length, 0);
      if (before !== null) assert.deepEqual(readFileSync(box.journal), before);
      else assert.equal(existsSync(box.journal), false);
    });
  }
  await t.test('failed reservation never launches and invalid or backward clocks preserve reservations', async () => {
    for (const clock of ['2026-11-06T02:59:59Z', 'invalid']) {
      const box = make({ lastAttemptAt: '2026-11-06T03:00:00Z' });
      const before = readFileSync(box.journal);
      box.epoch = Date.parse(clock);
      await notificationRefusal(box, 'clock-unavailable');
      assert.deepEqual(readFileSync(box.journal), before);
      assert.equal(box.calls.length, 0);
      assert.equal(box.collected.length, 0);
    }
  });
  await t.test('off configuration and invalid CLI shapes perform no effects', async () => {
    const box = make();
    rmSync(fixture.configPath);
    assert.deepEqual(await box.tick(), ['notification: off']);
    assert.equal(box.calls.length + box.collected.length, 0);
    for (const args of [['notify', '--unknown'], ['notify', '--initialize', '--initialize'], ['notify', 'extra'], ['notify', '--initialize', 'extra']]) {
      const result = spawnSync(process.execPath, [QUEUE, ...args, '--home', fixture.home], { env: fixture.env, encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.equal(result.stderr, QUEUE_USAGE);
      assert.equal(result.stdout, '');
    }
  });
});


test('phone notifications exclude private and foreign-account evidence', async (t) => {
  const notificationModule = await import('../../.agents/herdr/fabraik-queue/queue.mjs');
  assert.equal(typeof notificationModule.notificationTick, 'function',
    'notificationTick is absent before implementation');
  if (process.platform !== 'linux') {
    notificationPlatformRefusal();
    await t.test('Linux notification evidence', {
      skip: 'notification flock, private modes, directory sync and shell wire require Linux',
    }, () => {});
    return;
  }
  const fixture = notificationFixture(t, notificationModule.notificationTick);
  const { make, event, roots } = fixture;
  const markers = ['QUESTION_PRIVATE_583', 'SCREENSHOT_PRIVATE_583', 'RETRO_NOTIFICATION_PRIVATE_583', 'ERROR_PRIVATE_583', 'AUTH_PRIVATE_583'];
  const screenshot = join(fixture.folder, `${markers[1]}.png`);
  writeFileSync(screenshot, markers[1]);
  const privateDocument = () => collectorDocument({
    items: [{ card: 11, category: 'question', title: markers[0], question: markers[0], screenshots: [screenshot] },
      { card: 12, category: 'failure', reason: markers[3] }, { card: 13, category: 'suggested', title: markers[2] }],
    digest: [{ sha: 'a'.repeat(40), at: '2026-11-05T15:00:00Z', subject: markers[2] }],
    sources: [{ name: 'private', ok: false, error: markers[3] }],
    notifications: { login: 'owner', waits: [{ card: 11, kind: 'question' }, { card: 14, kind: 'review' }], unavailable: null },
  });
  const clean = (value) => {
    const bytes = JSON.stringify(value);
    for (const marker of markers) assert.equal(bytes.includes(marker), false, `${marker} must not cross a native or logging boundary`);
  };
  await t.test('only current-account count projection crosses every native boundary', async () => {
    const box = make();
    const old = {};
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'FABRAIK_PRIVATE']) {
      old[key] = process.env[key]; process.env[key] = markers[4];
    }
    try {
      await box.tick({ runCollector: async (root) => root === roots[0] ? privateDocument()
        : collectorDocument({ notifications: { login: 'owner', waits: [], unavailable: null } }) });
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    notificationSentence(box, 'Waiting: 1 questions and 1 reviews. Check Herdr for full status.');
    const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CLAUDE_CONFIG_DIR'];
    for (const { options } of box.calls) {
      assert.ok(Object.keys(options.env).every((key) => allowed.includes(key)));
      assert.equal(options.env.CLAUDE_CONFIG_DIR, fixture.account);
      assert.deepEqual(readdirSync(options.cwd), [], 'sender runs in a neutral empty directory');
    }
    clean([box.calls, box.logs, box.read()]);
  });
  for (const [name, document, code] of [
    ['foreign metadata login', collectorDocument({ notifications: { login: 'foreign', waits: [{ card: 1, kind: 'question' }], unavailable: null } }), 'ownership-unavailable'],
    ['missing metadata', collectorDocument({}), 'source-unavailable'],
    ['invalid wait', collectorDocument({ notifications: { login: 'owner', waits: [{ card: 1, kind: 'failure' }], unavailable: null } }), 'source-unavailable'],
    ...['unsupported-tracker', 'login-unavailable', 'source-unavailable', 'ownership-unavailable'].map((code) => [code,
      collectorDocument({ notifications: { login: 'owner', waits: [], unavailable: code } }), code]),
  ]) {
    await t.test(`refuse ${name} before reservation or native work`, async () => {
      const box = make();
      const before = readFileSync(box.journal);
      await notificationRefusal(box, code, { runCollector: async () => document });
      assert.deepEqual(readFileSync(box.journal), before);
      assert.equal(box.calls.length, 0);
      clean(box.logs);
    });
  }
  await t.test('one incompatible registered source refuses the entire tick', async () => {
    const box = make();
    const before = readFileSync(box.journal);
    await notificationRefusal(box, 'source-unavailable', { runCollector: async (root) => root === roots[0] ? privateDocument() : collectorDocument({}) });
    assert.deepEqual(readFileSync(box.journal), before);
    assert.equal(box.calls.length, 0);
  });
  await t.test('collector rejection discards its private cause', async () => {
    const box = make();
    const before = readFileSync(box.journal);
    await notificationRefusal(box, 'source-unavailable', { runCollector: async () => { throw new Error(markers[3]); } });
    assert.deepEqual(readFileSync(box.journal), before);
    assert.equal(box.calls.length, 0);
  });
  await t.test('foreign journal profile refuses without repair', async () => {
    const box = make();
    box.save({ ...box.initial, profile: { login: 'foreign', account: fixture.account } });
    const before = readFileSync(box.journal);
    await notificationRefusal(box, 'ownership-unavailable');
    assert.deepEqual(readFileSync(box.journal), before);
    assert.equal(box.calls.length, 0);
  });
  await t.test('failed launch burns the morning key and shared slot across restart', async () => {
    const box = make({ at: '2026-11-06T08:00:00Z', waits: [], events: [event(10, '2026-11-05T15:00:00Z')] });
    await notificationRefusal(box, 'native-launch-unavailable', { exec: { ...box.options.exec, run: async () => {
      assert.equal(box.read().lastAttemptAt, '2026-11-06T08:00:00.000Z');
      assert.equal(box.read().morningKey, '2026-11-06');
      assert.ok(box.read().pending);
      throw Object.assign(new Error(markers[3]), { stdout: markers[0], stderr: markers[3] });
    } } });
    const reserved = box.read();
    const reservedBytes = readFileSync(box.journal, 'utf8');
    assert.deepEqual(reserved.pending, { name: reserved.pending.name, cwd: fixture.trustedDirectory, id: null });
    const collected = box.collected.length;
    box.epoch = Date.parse('2026-11-06T08:59:59Z');
    assert.deepEqual(await box.tick(), ['notification: capped']);
    assert.equal(readFileSync(box.journal, 'utf8'), reservedBytes);
    assert.equal(box.collected.length, collected);
    assert.equal(box.calls.length, 0);
    box.epoch = Date.parse('2026-11-06T09:00:00Z');
    const recoveryCalls = [];
    await box.tick({ exec: { ...box.options.exec, run: async (file, argv) => {
      recoveryCalls.push({ file, argv });
      assert.equal(file, 'claude');
      assert.deepEqual(argv, ['agents', '--json', '--all', '--cwd', fixture.trustedDirectory]);
      return { stdout: JSON.stringify([{ id: 'deadbeef', name: 'unrelated', cwd: fixture.trustedDirectory,
        kind: 'background', startedAt: 1793923200000, state: 'working', futureField: 'ignored' }]), stderr: '' };
    } } });
    assert.deepEqual(box.logs, ['notification: cleanup-completed']);
    assert.deepEqual(recoveryCalls.map(({ argv }) => argv), [['agents', '--json', '--all', '--cwd', fixture.trustedDirectory]]);
    assert.deepEqual(box.read(), { ...reserved, pending: null });
    assert.equal(readFileSync(box.journal, 'utf8'), reservedBytes.replace(/"pending": \{[^}]+\}/, '"pending": null'));
    assert.equal(box.calls.length, 0);
    box.epoch = Date.parse('2026-11-06T09:00:01Z');
    const collector = box.options.runCollector;
    await box.tick({ runCollector: async (root) => {
      const document = await collector(root);
      if (root === roots[0]) document.notifications.waits = [{ card: 1, kind: 'question' }];
      return document;
    } });
    notificationSentence(box, 'Waiting: 1 questions and 0 reviews. Check Herdr for full status.');
    assert.equal(box.read().lastAttemptAt, '2026-11-06T09:00:01.000Z');
    assert.equal(box.read().morningKey, '2026-11-06');
    assert.equal(box.calls.filter(({ argv }) => argv[0] === '--bg').length, 1);
    clean([reserved, recoveryCalls, box.calls, box.logs]);
  });
  const entry = (box, fields = {}) => ({ id: '7a4c17cf', name: box.read().pending.name, cwd: fixture.trustedDirectory,
    kind: 'background', startedAt: 1793923200000, state: 'done', ...fields });
  for (const [name, response] of /** @type {[string, (box?: any) => string][]} */ ([
    ['invalid JSON', () => markers[3]],
    ['object instead of array', () => '{}'],
    ['missing identity', () => '[]'],
    ['unrelated identity', (box) => JSON.stringify([entry(box, { name: 'someone-else', id: 'deadbeef' })])],
    ['duplicate identity', (box) => JSON.stringify([entry(box), entry(box, { id: 'deadbeef' })])],
    ['invalid short ID', (box) => JSON.stringify([entry(box, { id: '../private' })])],
    ['invalid native timestamp', (box) => JSON.stringify([entry(box, { startedAt: '2026-11-06T00:00:00Z' })])],
    ['invalid status', (box) => JSON.stringify([entry(box, { state: 'invented' })])],
    ['foreign cwd', (box) => JSON.stringify([entry(box, { cwd: roots[0] })])],
  ])) {
    await t.test(`native ${name} never authorizes an unrelated stop`, async () => {
      const box = make();
      const native = box.options.exec.run;
      await notificationRefusal(box, 'native-status-unavailable', { exec: { ...box.options.exec, run: async (file, argv, options) => {
        if (argv[0] === 'agents') {
          assert.deepEqual(argv, ['agents', '--json', '--all', '--cwd', fixture.trustedDirectory]);
          return { stdout: response(box), stderr: markers[3] };
        }
        return native(file, argv, options);
      } } });
      assert.ok(box.read().pending, 'uncertain identity remains reserved for recovery');
      assert.equal(box.read().lastAttemptAt, '2026-11-06T03:00:00.000Z');
      assert.equal(box.calls.some(({ argv }) => argv.includes('stop')), false);
      clean([box.logs, box.read()]);
    });
  }
  for (const [name, response, id = null] of /** @type {[string, (box?: any) => string, string?][]} */ ([
    ['invalid JSON', () => markers[3]],
    ['object instead of array', () => '{}'],
    ['null unrelated entry', () => '[null]'],
    ['array unrelated entry', () => '[[]]'],
    ['relative unrelated cwd', (box) => JSON.stringify([entry(box, { name: 'unrelated', cwd: 'relative' })])],
    ['unnormalized unrelated cwd', (box) => JSON.stringify([entry(box, { name: 'unrelated', cwd: `${fixture.trustedDirectory}/..` })])],
    ['invalid unrelated kind', (box) => JSON.stringify([entry(box, { name: 'unrelated', kind: 'invented' })])],
    ['invalid unrelated timestamp', (box) => JSON.stringify([entry(box, { name: 'unrelated', startedAt: '2026-11-06T00:00:00Z' })])],
    ['invalid unrelated name', (box) => JSON.stringify([entry(box, { name: 7 })])],
    ['invalid unrelated short ID', (box) => JSON.stringify([entry(box, { name: 'unrelated', id: '../private' })])],
    ['invalid unrelated status', (box) => JSON.stringify([entry(box, { name: 'unrelated', state: 'invented' })])],
    ['duplicate unrelated IDs', (box) => JSON.stringify([entry(box, { name: 'unrelated' }), entry(box, { name: 'another' })])],
    ['duplicate reserved name', (box) => JSON.stringify([entry(box), entry(box, { id: 'deadbeef' })])],
    ['reserved name directory conflict', (box) => JSON.stringify([entry(box), entry(box, { id: 'deadbeef', cwd: roots[0] })])],
    ['reserved name kind conflict', (box) => JSON.stringify([entry(box), entry(box, { id: 'deadbeef', kind: 'interactive' })])],
    ['known-ID absence', (box) => JSON.stringify([entry(box, { name: 'unrelated', id: 'deadbeef' })]), '7a4c17cf'],
  ])) {
    await t.test(`recovery ${name} retains pending and reservations without launch or stop`, async () => {
      const box = make({ at: '2026-11-06T09:00:00Z', lastAttemptAt: '2026-11-06T08:00:00Z',
        morningKey: '2026-11-06', waits: [], events: [event(10, '2026-11-05T15:00:00Z')] });
      const pending = { name: 'fabraik-notify-11111111-1111-4111-8111-111111111111', cwd: fixture.trustedDirectory, id };
      box.save({ ...box.initial, pending });
      const before = readFileSync(box.journal);
      const calls = [];
      await notificationRefusal(box, 'native-status-unavailable', { exec: { ...box.options.exec, run: async (file, argv) => {
        calls.push({ file, argv });
        return { stdout: response(box), stderr: markers[3] };
      } } });
      assert.deepEqual(readFileSync(box.journal), before);
      assert.deepEqual(calls, [{ file: 'claude', argv: ['agents', '--json', '--all', '--cwd', fixture.trustedDirectory] }]);
      assert.equal(box.calls.length, 0);
      clean([calls, box.logs, box.read()]);
    });
  }
  for (const status of ['failed', 'stopped']) {
    await t.test(`identified ${status} status burns the slot with scoped cleanup`, async () => {
      const box = make();
      const native = box.options.exec.run;
      const stops = [];
      await notificationRefusal(box, 'native-failed', { exec: { ...box.options.exec, run: async (file, argv, options) => {
        if (argv[0] === 'agents') return { stdout: JSON.stringify([entry(box, { state: status }),
          entry(box, { id: 'deadbeef', name: 'unrelated', state: 'working' })]), stderr: markers[3] };
        if (argv[0] === 'stop') stops.push(argv);
        return native(file, argv, options);
      } } });
      assert.deepEqual(stops, status === 'stopped' ? [] : [['stop', '7a4c17cf']]);
      assert.equal(box.read().pending, null);
      assert.equal(box.read().lastAttemptAt, '2026-11-06T03:00:00.000Z');
      clean(box.logs);
    });
  }
  await t.test('bounded polling times out and stops only the owned ID', async () => {
    const box = make();
    const native = box.options.exec.run;
    let waited = 0;
    const stops = [];
    await notificationRefusal(box, 'native-timeout', { exec: {
      run: async (file, argv, options) => {
        assert.ok(box.epoch - Date.parse('2026-11-06T03:00:00Z') <= 180_000);
        if (argv[0] === 'agents') {
          assert.ok(waited <= 120_000, 'polling stays within the existing 120-second bound');
          return { stdout: JSON.stringify([entry(box, { state: 'working' })]), stderr: markers[3] };
        }
        if (argv[0] === 'stop') stops.push(argv);
        return native(file, argv, options);
      },
      wait: async (ms) => {
        assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 5000);
        waited += ms; box.epoch += ms;
        assert.ok(waited <= 120_000);
      },
    } });
    assert.ok(waited > 0);
    assert.deepEqual(stops, [['stop', '7a4c17cf']]);
    assert.equal(box.read().pending, null);
  });
  await t.test('poll-wait and agents errors are safely bounded after reservation', async () => {
    for (const stage of ['wait', 'agents']) {
      const box = make();
      const native = box.options.exec.run;
      await notificationRefusal(box, stage === 'wait' ? 'native-timeout' : 'native-status-unavailable', { exec: {
        run: async (file, argv, options) => {
          if (argv[0] === 'agents') {
            if (stage === 'agents') throw Object.assign(new Error(markers[3]), { stderr: markers[3] });
            return { stdout: JSON.stringify([entry(box, { state: 'working' })]), stderr: markers[3] };
          }
          return native(file, argv, options);
        },
        wait: async () => { throw new Error(markers[3]); },
      } });
      assert.equal(box.read().lastAttemptAt, '2026-11-06T03:00:00.000Z');
      clean([box.calls, box.logs, box.read()]);
    }
  });
  for (const id of [null, '7a4c17cf']) {
    await t.test(`crash recovery ${id === null ? 'identifies' : 'revalidates'} only the persisted owned session`, async () => {
      const box = make({ at: '2026-11-06T04:00:00Z', lastAttemptAt: '2026-11-06T03:00:00Z', waits: [] });
      const pending = { name: 'fabraik-notify-11111111-1111-4111-8111-111111111111', cwd: fixture.trustedDirectory, id };
      box.save({ ...box.initial, pending });
      const calls = [];
      const run = async (file, argv) => {
        calls.push({ file, argv });
        if (argv[0] === 'stop') {
          assert.deepEqual(argv, ['stop', '7a4c17cf']);
          assert.equal(box.read().pending.id, '7a4c17cf');
          throw new Error(markers[3]);
        }
        assert.deepEqual(argv, ['agents', '--json', '--all', '--cwd', fixture.trustedDirectory]);
        return { stdout: JSON.stringify([entry(box), entry(box, { id: 'deadbeef', name: 'unrelated', state: 'working' })]), stderr: markers[3] };
      };
      await notificationRefusal(box, 'cleanup-unavailable', { exec: { ...box.options.exec, run } });
      assert.equal(box.read().pending.id, '7a4c17cf');
      assert.equal(box.read().lastAttemptAt, '2026-11-06T03:00:00.000Z');
      assert.equal(calls.some(({ argv }) => argv[0] === '--bg'), false);
      await box.tick();
      assert.deepEqual(box.logs, ['notification: cleanup-completed']);
      assert.equal(box.read().pending, null);
      assert.equal(box.read().lastAttemptAt, '2026-11-06T03:00:00.000Z');
      assert.equal(box.calls.some(({ argv }) => argv[0] === '--bg'), false);
      clean([calls, box.calls, box.logs]);
    });
  }
  await t.test('real default native CLI wire accepts counts and safely refuses failed launch', () => {
    const bin = join(fixture.folder, 'bin');
    mkdirSync(bin);
    const captured = join(fixture.folder, 'native-calls.jsonl');
    const identity = join(fixture.folder, 'native-name');
    const failure = join(fixture.folder, 'fail-launch');
    // This disposable executable implements only the official launch/list/owned-stop wire used here.
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nconst fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify({args,cwd:process.cwd(),env:process.env})+'\\n');\n` +
      `if(args[0]==='--bg'){if(fs.existsSync(${JSON.stringify(failure)})){console.error(${JSON.stringify(markers[3])});process.exit(1);}fs.writeFileSync(${JSON.stringify(identity)},args[2]);console.log(${JSON.stringify(markers[2])});}\n` +
      `else if(args[1]==='--json')console.log(JSON.stringify([{id:'7a4c17cf',name:fs.readFileSync(${JSON.stringify(identity)},'utf8'),cwd:${JSON.stringify(fixture.trustedDirectory)},kind:'background',startedAt:1793923200000,state:'done'}]));\n` +
      `else if(args.join(' ')!=='stop 7a4c17cf')process.exit(7);\n`, { mode: 0o755 });
    for (const root of roots) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      const document = root === roots[0] ? privateDocument() : collectorDocument({ notifications: { login: 'owner', waits: [], unavailable: null } });
      writeFileSync(join(root, 'scripts', 'owner-queue.mjs'), `console.log(${JSON.stringify(JSON.stringify(document))});\n`);
    }
    const env = { ...fixture.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: markers[4],
      CLAUDE_CODE_OAUTH_TOKEN: markers[4], FABRAIK_PRIVATE: markers[4] };
    const run = () => spawnSync(process.execPath, [QUEUE, 'notify', '--home', fixture.home], { env, encoding: 'utf8' });
    const positive = run();
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(positive.stdout, 'notification: completed\n');
    assert.equal(positive.stderr, '');
    const requests = readFileSync(captured, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(requests.filter(({ args }) => args[0] === '--bg').length, 1);
    assert.equal(requests[0].args.at(-1),
      'Reply with exactly this sentence and nothing else: Waiting: 1 questions and 1 reviews. Check Herdr for full status.');
    assert.deepEqual(requests[0].args.slice(0, -1), ['--bg', '--remote-control', requests[0].args[2], '--name', requests[0].args[2],
      '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--']);
    for (const request of requests) {
      assert.equal(request.cwd, fixture.trustedDirectory);
      assert.equal(request.env.CLAUDE_CONFIG_DIR, fixture.account);
      assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(request.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    }
    clean([requests, positive.stdout, positive.stderr]);
    const saved = JSON.parse(readFileSync(fixture.initializedJournal, 'utf8'));
    writeFileSync(fixture.initializedJournal, JSON.stringify({ ...saved, lastAttemptAt: null, pending: null }));
    writeFileSync(failure, 'fail');
    const negative = run();
    assert.equal(negative.status, 1);
    assert.equal(negative.stdout, '');
    assert.equal(negative.stderr, 'queue: notification unavailable: native-launch-unavailable\n');
    const reserved = JSON.parse(readFileSync(fixture.initializedJournal, 'utf8'));
    assert.ok(reserved.lastAttemptAt);
    assert.ok(reserved.pending);
    clean([negative.stdout, negative.stderr, reserved]);
  });
});

// --- Waiting menus: the delivery states the queue reports ---
//
// A coordinated job that waits at one of Claude's menus records its ask under
// <home>/data/fabraik-asks/<terminal>/<askId>/ (ask.json, then answer.json, taken.json, rejected.json and end.json, in the
// shapes scripts/lib/owner-menu.mjs writes), and `refresh` lists each as a `menu` item among the cache's items: `terminal`,
// `askId`, `answerable` (true only where it can be answered now), `delivery` (`sent`, `delivered` or `undelivered`) and, for an
// undelivered one, its `cause`. The expected states are the approved plan's delivery-state table, never read off the
// aggregator.

const MENU_START = 1_795_000_000_000;
const COLOUR = {
  question: 'Which colour do you pick?', header: 'Colour', multiSelect: false,
  options: [{ label: 'Red', description: 'The warm one' }, { label: 'Blue', description: 'The cool one' }],
};
const LETTERS = {
  question: 'Which letters go in?', header: 'Letters', multiSelect: true,
  options: ['A', 'B', 'C'].map((label) => ({ label, description: `The letter ${label}` })),
};
const askIdOf = (n) => n.toString(16).padStart(32, '0');
const askFolder = (home, terminalName, id) => join(home, 'data', 'fabraik-asks', terminalName, id);
// The pid of a program that has ended, so the hook that held it is gone.
const GONE_PID = spawnSync(process.execPath, ['-e', '']).pid;
const blockedAt = (...addresses) => terminalList(addresses.map((address) => terminal(address, { state: 'blocked', app: 'claude-code' })));

// Writes ask number `n` of `terminalName` under `home` with the files named in `files` (a record is written as JSON, text as
// it is), and returns its id. The ask is shaped as the hook writes it: its card the string the job's mark holds, and the
// repository of the job's main checkout. `fields` override the ask record; a field set to undefined is left out.
function writeAsk(home, terminalName, n, { fields = {}, files = {} } = {}) {
  const id = askIdOf(n);
  const folder = askFolder(home, terminalName, id);
  mkdirSync(folder, { recursive: true });
  const ask = {
    format: 1, id, terminal: terminalName, pid: process.pid, worktree: '/jobs/job-857', repository: A, card: '857', kind: 'question',
    toolName: 'AskUserQuestion', questions: [COLOUR], askedAt: MENU_START + n * 1000, ...fields,
  };
  const text = (content) => (typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  writeFileSync(join(folder, 'ask.json'), text(ask));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, `${name}.json`), text(content));
  return id;
}

// Writes ask number `n` of `terminalName` as a bare record: only what the hook counts as an ask (format, id, terminal, askedAt).
const writeBareAsk = (home, terminalName, n) => writeAsk(home, terminalName, n, { fields: {
  card: undefined, kind: undefined, pid: undefined, repository: undefined, worktree: undefined, toolName: undefined, questions: undefined,
} });

const colourAnswer = (id, text) => ({ format: 1, askId: id, by: 'panel', answers: { [COLOUR.question]: { text } } });
const permissionAnswer = (id) => ({ format: 1, askId: id, by: 'panel', choice: 'Allow once' });
const PERMISSION = { kind: 'permission', toolName: 'Bash', questions: undefined, input: 'npm test', whole: true };
const TAKEN = { takenAt: MENU_START + 5000 };
const DELIVERED = { reason: 'delivered', via: 'panel' };
const TAB = { reason: "answered in the job's tab" };
const DELIVERY_STATES = ['sent', 'delivered', 'undelivered'];

const menuItem = (queue, id) => queue.items.find((item) => item.category === 'menu' && item.askId === id);

// `queue.mjs menus [<terminals>] --home <dir>` prints what a refresh lists of the waiting menus, `{ items, problems }`, as JSON,
// and writes nothing; any other argument shape exits 2 with the usage line. Written by hand from the plan's S3b.
test('queue menus prints the waiting menus as JSON, writes nothing and refuses any other argument shape', (t) => {
  const home = temporaryFolder(t, 'herdr-queue-home-');
  const id = writeAsk(home, 't1', 1);
  const menus = (...args) => spawnSync(process.execPath, [QUEUE, 'menus', ...args], { encoding: 'utf8' });
  const files = () => readdirSync(home, { recursive: true }).sort();
  const before = files();

  const read = menus(blockedAt('t1'), '--home', home);
  assert.equal(read.status, 0, read.stderr);
  const printed = JSON.parse(read.stdout);
  assert.deepEqual(printed.problems, [], 'the ask is well formed');
  assert.deepEqual(printed.items.map((item) => [item.category, item.terminal, item.askId, item.answerable]), [['menu', 't1', id, true]],
    'the ask of the blocked terminal is listed, answerable');
  const listless = menus('--home', home);
  assert.equal(listless.status, 0, listless.stderr);
  const unlisted = JSON.parse(listless.stdout);
  assert.ok(unlisted.items.every((item) => item.answerable !== true), 'without a terminal list no ask is answerable');
  assert.equal(unlisted.problems.length, 1, 'and one problem line says the terminal list was not read');
  assert.deepEqual(files(), before, 'menus writes nothing');

  for (const shape of [[blockedAt('t1'), 'more', '--home', home], ['--terminals', '--home', home], [blockedAt('t1')], ['--home'], ['--home', home, '--all']]) {
    const refused = menus(...shape);
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
  // A newer record the panel cannot list but the hook counts still supersedes the older waiting question.
  const older = writeAsk(home, 't9', 31, { fields: { askedAt: MENU_START + 1000 } });
  writeAsk(home, 't9', 32, { fields: { ...PERMISSION, input: undefined, askedAt: MENU_START + 2000 } });
  const superseded = JSON.parse(menus(blockedAt('t1', 't9'), '--home', home).stdout);
  assert.ok(superseded.items.every((item) => item.askId !== older || item.answerable !== true), 'an ask a newer record has superseded is not answerable');
  assert.ok(superseded.items.some((item) => item.terminal === 't1' && item.askId === id && item.answerable === true), 't1 stays listed as answerable');
  assert.ok(superseded.problems.some((problem) => problem.startsWith(`Waiting menu t9/${askIdOf(32)}:`)), 'the malformed newer record of t9 is an advisory');

  // A newer ask.json that is a named pipe is never opened: the command returns, no ask of the job is answerable and the panel
  // and waiting-menu say why.
  const pipeId = writeAsk(home, 't7', 1);
  const pipeFolder = askFolder(home, 't7', askIdOf(2));
  mkdirSync(pipeFolder, { recursive: true });
  const made = process.platform === 'win32' ? undefined : spawnSync('mkfifo', [join(pipeFolder, 'ask.json')]);
  if (made !== undefined && /** @type {NodeJS.ErrnoException | undefined} */ (made.error)?.code !== 'ENOENT') {
    assert.equal(made.error, undefined, 'mkfifo starts');
    assert.equal(made.status, 0, `the named pipe is made: ${made.stderr}`);
    const piped = spawnSync(process.execPath, [QUEUE, 'menus', blockedAt('t7'), '--home', home], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(piped.status, 0, `menus returns with a named pipe as a newer ask: ${piped.stderr}`);
    const listed = JSON.parse(piped.stdout);
    assert.ok(listed.items.every((item) => item.terminal !== 't7' || item.answerable !== true), "no ask of the terminal is answerable");
    const stuckLines = listed.problems.filter((problem) => problem.startsWith(`Waiting menu t7/${askIdOf(2)}:`));
    assert.deepEqual(stuckLines, [`Waiting menu t7/${askIdOf(2)}: ask.json is no regular file, so the job's hook may be stuck`],
      'the panel says the record is no regular file, in exactly one line');
    const refused = spawnSync(process.execPath, [QUEUE, 'waiting-menu', 't7', '--home', home], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(refused.status, 1, `waiting-menu refuses: ${refused.stderr}`);
    assert.ok(refused.stderr.includes(`t7/${pipeId}: no waiting ask: a record of the job is no regular file`), refused.stderr);
  }

  // A newer record behind a directory link, which the panel cannot show, replaces the older ask and the panel says so.
  const hidden = writeAsk(home, 't17', 1);
  const outside = temporaryFolder(t, 'herdr-queue-linked-dir-');
  writeBareAsk(outside, 't17', 2);
  let linked = true;
  try {
    symlinkSync(askFolder(outside, 't17', askIdOf(2)), askFolder(home, 't17', askIdOf(2)), 'dir');
  } catch (error) {
    // Windows without Developer Mode or administrator rights refuses an unprivileged symlink with EPERM.
    if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
    linked = false;
  }
  if (linked) {
    const replaced = JSON.parse(menus(blockedAt('t17'), '--home', home).stdout);
    assert.ok(replaced.items.every((item) => item.askId !== hidden || item.answerable !== true), 'the replaced ask is not answerable');
    const replacedLines = replaced.problems.filter((problem) => problem.startsWith(`Waiting menu t17/${hidden}:`));
    assert.deepStrictEqual(replacedLines, [`Waiting menu t17/${hidden}: a newer ask record of the job replaced it`],
      'the panel says a newer record replaced it, in exactly one line');
  }
});

test("a menu answer reads delivered only once the job's own hook signal shows it, and an interrupted or superseded one stays listed as not delivered with its words", async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);
  const WORDS = 'the green one, please';
  const rejection = 'the choices are not distinct labels it offers';
  const answered = (id) => ({ answer: colourAnswer(id, WORDS) });
  const taken = (id) => ({ answer: colourAnswer(id, WORDS), taken: TAKEN });
  const undelivered = { answerable: false, delivery: 'undelivered', words: WORDS };
  // Each ask by its number: its terminal, that terminal's state (null: not in the list), the files it holds, and what the
  // queue must show. `answerable` is checked where given; `delivery` undefined means none of the three states.
  /** @type {Record<number, { [field: string]: any }>} */
  const asks = {
    1: { at: 't1', state: 'blocked', expect: { answerable: true } },
    2: { at: 't2', state: 'blocked', files: answered, expect: { answerable: false, delivery: 'sent' } },
    3: { at: 't3', state: 'blocked', files: taken, expect: { answerable: false, delivery: 'sent' } },
    4: { at: 't4', state: 'working', pid: GONE_PID, files: (id) => ({ ...taken(id), end: DELIVERED }), expect: { answerable: false, delivery: 'delivered' } },
    5: { at: 't5', state: 'working', pid: GONE_PID, files: (id) => ({ ...answered(id), end: TAB }), expect: undelivered },
    6: { at: 't6', state: 'blocked', pid: GONE_PID, files: taken, expect: undelivered },
    7: { at: 't7', state: null, pid: GONE_PID, files: answered, expect: undelivered },
    8: { at: 't8', state: 'blocked', files: () => ({ rejected: { format: 1, reason: rejection } }), expect: { delivery: 'undelivered', words: rejection } },
    // A permission answer reads delivered only from the end.json its hook writes as it decides: a taken one whose hook is gone
    // reads undelivered whether its terminal moved on, still waits, or asked again.
    9: { at: 't9', state: 'working', pid: GONE_PID, fields: PERMISSION, files: (id) => ({ answer: permissionAnswer(id), taken: TAKEN }), expect: { ...undelivered, words: 'Allow once' } },
    10: { at: 't10', state: 'blocked', pid: GONE_PID, fields: PERMISSION, files: (id) => ({ answer: permissionAnswer(id), taken: TAKEN }), expect: { ...undelivered, words: 'Allow once' } },
    13: { at: 't13', state: 'working', pid: GONE_PID, fields: PERMISSION, files: (id) => ({ answer: permissionAnswer(id), taken: TAKEN, end: DELIVERED }), expect: { answerable: false, delivery: 'delivered' } },
    23: { at: 't23', state: 'blocked', pid: GONE_PID, fields: PERMISSION, files: (id) => ({ answer: permissionAnswer(id), taken: TAKEN }), expect: { ...undelivered, words: 'Allow once' } },
    24: { at: 't23', state: 'blocked', expect: { answerable: true } },
    // A terminal that is not blocked, and a hook that is gone, each leave an unanswered ask unanswerable.
    11: { at: 't11', state: 'working', expect: { answerable: false, optional: true } },
    12: { at: 't12', state: 'blocked', pid: GONE_PID, expect: { answerable: false, optional: true } },
    // Three asks of one terminal: the oldest holds no answer and is not listed, the next holds an answer its superseded hook
    // took and stays listed as not delivered, and the newest waits.
    20: { at: 't20', state: 'blocked', pid: GONE_PID, expect: { unlisted: true } },
    21: { at: 't20', state: 'blocked', pid: GONE_PID, files: taken, expect: undelivered },
    22: { at: 't20', state: 'blocked', expect: { answerable: true } },
  };
  for (const [n, ask] of Object.entries(asks)) {
    writeAsk(home, ask.at, Number(n), { fields: { ...(ask.pid && { pid: ask.pid }), ...ask.fields }, files: ask.files?.(askIdOf(Number(n))) });
  }
  const states = new Map(Object.values(asks).map((ask) => [ask.at, ask.state]));
  const list = terminalList([...states].filter(([, state]) => state !== null)
    .map(([address, state]) => terminal(address, { state, app: 'claude-code' })));

  await refresh({ home, runCollector: () => collectorDocument(), terminals: list });
  const queue = cache();

  for (const [n, { expect }] of Object.entries(asks)) {
    const item = menuItem(queue, askIdOf(Number(n)));
    if (expect.unlisted) {
      assert.equal(item, undefined, `ask ${n} holds no answer and is not listed`);
      continue;
    }
    if (expect.optional && item === undefined) continue;
    assert.ok(item, `ask ${n} is listed`);
    if (expect.answerable === true) assert.equal(item.answerable, true, `ask ${n} is answerable`);
    if (expect.answerable === false) assert.notEqual(item.answerable, true, `ask ${n} is not answerable`);
    if (expect.delivery === undefined) assert.ok(!DELIVERY_STATES.includes(item.delivery), `ask ${n} has no answer to read as sent, delivered or undelivered`);
    else assert.equal(item.delivery, expect.delivery, `ask ${n} delivery`);
    if (expect.delivery === 'undelivered') {
      assert.equal(typeof item.cause, 'string', `ask ${n} names its cause`);
      assert.notEqual(item.cause, '', `ask ${n} names its cause`);
      assert.ok(JSON.stringify(item).includes(expect.words), `ask ${n} keeps its words: ${JSON.stringify(item)}`);
    }
  }
  assert.deepEqual(queue.problems, [], 'every ask and answer file above is well formed');
});

// The shared ask contract: every ask records the repository of the job's main checkout, or why it could not be read, and a
// permission ask records whether the panel can show its call whole. A menu item carries each as its ask holds it.
test("a menu item carries its ask's repository, or why that was not read, and whether a permission call is shown whole", async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);
  const UNREAD = 'fatal: not a git repository';
  const asks = {
    1: { fields: { repository: B }, expect: { repository: B } },
    2: { fields: { repository: undefined, repositoryUnread: UNREAD }, expect: { repositoryUnread: UNREAD } },
    3: { fields: PERMISSION, expect: { repository: A, whole: true } },
    4: { fields: { ...PERMISSION, toolName: 'Write', input: '/jobs/job-857/notes.txt', whole: false }, expect: { repository: A, whole: false } },
  };
  for (const [n, { fields }] of Object.entries(asks)) writeAsk(home, `t${n}`, Number(n), { fields });

  await refresh({ home, runCollector: () => collectorDocument(), terminals: blockedAt(...Object.keys(asks).map((n) => `t${n}`)) });
  const queue = cache();

  for (const [n, { expect }] of Object.entries(asks)) {
    const item = menuItem(queue, askIdOf(Number(n)));
    assert.ok(item, `ask ${n} is listed`);
    assert.equal(item.card, '857', `ask ${n} keeps the card its hook recorded`);
    for (const [field, value] of Object.entries(expect)) assert.equal(item[field], value, `ask ${n} ${field}: ${JSON.stringify(item)}`);
    if (expect.repositoryUnread !== undefined) assert.equal(item.repository, undefined, `ask ${n} names no repository it did not read`);
  }
  assert.deepEqual(queue.problems, []);
});

// A deliver ask records the version its job asked about, the head and the identity of its saved write-up, or why the job
// could not read it. A menu item carries each as its ask holds it, for the panel to match against the merge it shows.
test('a deliver menu item carries the version its ask records, or why the job could not read it', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);
  const VERSION = { head: '1'.repeat(40), identity: ['2'.repeat(40), '3'.repeat(40)].join(',') };
  const UNREAD = 'fatal: ambiguous argument HEAD';
  const asks = {
    1: { fields: { version: VERSION }, expect: { version: VERSION } },
    2: { fields: { versionUnread: UNREAD }, expect: { versionUnread: UNREAD } },
  };
  for (const [n, { fields }] of Object.entries(asks)) writeAsk(home, `t${n}`, Number(n), { fields: { questions: [DELIVER_QUESTION], ...fields } });

  await refresh({ home, runCollector: () => collectorDocument(), terminals: blockedAt(...Object.keys(asks).map((n) => `t${n}`)) });
  const queue = cache();

  for (const [n, { expect }] of Object.entries(asks)) {
    const item = menuItem(queue, askIdOf(Number(n)));
    assert.ok(item, `ask ${n} is listed`);
    assert.deepEqual({ version: item.version, versionUnread: item.versionUnread }, { version: undefined, versionUnread: undefined, ...expect },
      `ask ${n}: ${JSON.stringify(item)}`);
  }
  assert.deepEqual(queue.problems, []);
});

// The hook records a card as the string the job's mark holds, a positive whole number. An ask holding any other card is a
// problem line, so it never stands in for the merge of a like number and takes that merge's controls from it.
test('an ask whose card is not a positive whole number as text is a problem line, and the merge of its repository keeps its controls', async (t) => {
  const cards = { 'a list holding the number': [857], 'a record holding the number': { number: 857 } };
  for (const [why, card] of Object.entries(cards)) {
    const repository = temporaryFolder(t, 'herdr-queue-repo-');
    const { home, cache } = releasedHome(t, [repository]);
    const id = writeAsk(home, 't1', 1, { fields: { repository, card } });
    const merge = { card: 857, title: 'a857', category: 'merge', decisionCard: 'Ship card 857.', visual: 'none', version: 'e'.repeat(64) };

    await refresh({ home, runCollector: () => collectorDocument({ items: [merge] }), terminals: blockedAt('t1') });
    const queue = cache();

    assert.ok(queue.problems.some((problem) => problem.includes(id)), `${why}: a problem line names the ask ${id}: ${JSON.stringify(queue.problems)}`);
    assert.equal(menuItem(queue, id), undefined, `${why}: no waiting menu is listed for it`);
    const tree = (await itemScene(queue.items)).render();
    assert.deepEqual(itemNames(tree, `${repository}#857`), ['Put aside', sendName(857)], `${why}: the merge keeps its own controls`);
    assert.deepEqual(decisionCards(tree), ['Ship card 857.'], `${why}: the merge shows its decision card`);
  }
});

test('a corrupt, oversized or foreign ask or answer file is a problem line, never buttons', async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home, cache } = releasedHome(t, [repository]);
  const ASK_CAP = 1024 * 1024;
  const ANSWER_CAP = 64 * 1024;
  const askText = (n, fields) => JSON.stringify({
    format: 1, id: askIdOf(n), terminal: `t${n}`, pid: process.pid, worktree: '/jobs/job-857', repository: A, card: '857', kind: 'question',
    toolName: 'AskUserQuestion', questions: [COLOUR], askedAt: MENU_START + n * 1000, ...fields,
  });
  const answer = (n) => colourAnswer(askIdOf(n), 'the green one, please');
  // Each folder by its ask number (at the terminal `t<n>`), with the ask file text, any answer file text, and why it is refused.
  const bad = {
    1: { why: 'ask.json is not JSON', ask: '{"format": 1, "id": ' },
    2: { why: 'ask.json is over the size cap', ask: `${askText(2)}${' '.repeat(ASK_CAP + 1)}` },
    3: { why: 'ask.json names another id than its folder', ask: askText(3, { id: askIdOf(99) }) },
    4: { why: 'ask.json names another terminal than its folder', ask: askText(4, { terminal: 'elsewhere' }) },
    5: { why: 'ask.json is another format', ask: askText(5, { format: 2 }) },
    6: { why: 'answer.json is not JSON', ask: askText(6), answer: '{"format": 1, "askId": ' },
    7: { why: 'answer.json is over the size cap', ask: askText(7), answer: `${JSON.stringify(answer(7))}${' '.repeat(ANSWER_CAP + 1)}` },
    8: { why: 'answer.json names another ask', ask: askText(8), answer: JSON.stringify({ ...answer(8), askId: askIdOf(98) }) },
    9: { why: 'answer.json is another format', ask: askText(9), answer: JSON.stringify({ ...answer(9), format: 2 }) },
  };
  for (const [n, { ask, answer: answerText }] of Object.entries(bad)) {
    const folder = askFolder(home, `t${n}`, askIdOf(Number(n)));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'ask.json'), ask);
    if (answerText !== undefined) writeFileSync(join(folder, 'answer.json'), answerText);
  }

  await refresh({ home, runCollector: () => collectorDocument(), terminals: blockedAt(...Object.keys(bad).map((n) => `t${n}`)) });
  const queue = cache();

  for (const [n, { why }] of Object.entries(bad)) {
    const id = askIdOf(Number(n));
    assert.ok(queue.problems.some((problem) => problem.includes(id)), `${why}: a problem line names the ask ${id}: ${JSON.stringify(queue.problems)}`);
    const item = menuItem(queue, id);
    assert.notEqual(item?.answerable, true, `${why}: no buttons`);
    assert.ok(!['sent', 'delivered'].includes(item?.delivery), `${why}: not read as sent or delivered`);
  }
});

// `answer-menu <terminal> <askId> --answer <json> --home <dir>` writes the answer record its payload holds into that ask's
// folder, only where that exact ask still waits, and prints nothing; every refusal is a `queue: ` line with exit 1.
test("answer-menu writes only the named ask's answer and refuses a changed, answered or no longer waiting ask", (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  const { home } = releasedHome(t, [repository]);
  const answerMenu = (terminalName, id, payload) => spawnSync(process.execPath, [QUEUE, 'answer-menu', terminalName, id, '--answer',
    typeof payload === 'string' ? payload : JSON.stringify(payload), '--home', home], { encoding: 'utf8' });
  // Every file under the asks store with its bytes.
  const tree = () => {
    const root = join(home, 'data', 'fabraik-asks');
    return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
      .filter((name) => statSync(join(root, name)).isFile()).map((name) => [name, readFileSync(join(root, name), 'utf8')]));
  };
  const reply = (n, answers) => ({ format: 1, askId: askIdOf(n), by: 'panel', answers });
  const blue = { [COLOUR.question]: { choices: ['Blue'] } };
  const text = (value) => ({ [COLOUR.question]: { text: value } });

  const open = writeAsk(home, 't1', 1);
  writeAsk(home, 't2', 2);
  // Each refusal by why: the terminal and ask named, and the payload that would otherwise be taken.
  const refusals = {
    'an ask that is not there': { at: 't3', id: askIdOf(90), payload: reply(90, blue) },
    'a payload that names another ask': { at: 't4', id: writeAsk(home, 't4', 4), payload: reply(2, blue) },
    'a payload that is not JSON': { at: 't5', id: writeAsk(home, 't5', 5), payload: '{"format": 1,' },
    // Three-byte characters pass the 64 KiB cap in bytes while the command line stays under Windows' 32,767 characters.
    'a payload over the size cap': { at: 't6', id: writeAsk(home, 't6', 6), payload: `${JSON.stringify(reply(6, blue))}${'€'.repeat(21_846)}` },
    'a choice the ask does not offer': { at: 't7', id: writeAsk(home, 't7', 7), payload: reply(7, { [COLOUR.question]: { choices: ['Green'] } }) },
    'two choices for a single-select question': { at: 't8', id: writeAsk(home, 't8', 8), payload: reply(8, { [COLOUR.question]: { choices: ['Red', 'Blue'] } }) },
    'a question left out': { at: 't9', id: writeAsk(home, 't9', 9, { fields: { questions: [COLOUR, LETTERS] } }), payload: reply(9, blue) },
    'a key the record may not hold': { at: 't10', id: writeAsk(home, 't10', 10), payload: { ...reply(10, blue), choice: 'Blue' } },
    'text over 500 characters': { at: 't11', id: writeAsk(home, 't11', 11), payload: reply(11, text('x'.repeat(501))) },
    'text that looks like a credential': { at: 't12', id: writeAsk(home, 't12', 12), payload: reply(12, text('use ghp_abcdefghijklmnopqrstuvwxyz0123456789')) },
    'an ask that already holds an answer': { at: 't13', id: writeAsk(home, 't13', 13, { files: { answer: 'an earlier answer, kept as it is' } }), payload: reply(13, blue) },
    'an ask whose hook already took an answer': { at: 't14', id: writeAsk(home, 't14', 14, { files: { taken: TAKEN } }), payload: reply(14, blue) },
    'an ask that has ended': { at: 't15', id: writeAsk(home, 't15', 15, { files: { end: TAB } }), payload: reply(15, blue) },
    'an ask whose hook is gone': { at: 't16', id: writeAsk(home, 't16', 16, { fields: { pid: GONE_PID } }), payload: reply(16, blue) },
    'an ask a newer ask of its terminal has superseded': { at: 't17', id: writeAsk(home, 't17', 17), payload: reply(17, blue), newer: writeAsk(home, 't17', 18) },
    'an ask a newer bare record of its terminal has superseded': { at: 't21', id: writeAsk(home, 't21', 21), payload: reply(21, blue), newer: writeBareAsk(home, 't21', 22) },
    'an ask whose file names another id': { at: 't19', id: writeAsk(home, 't19', 19, { fields: { id: askIdOf(97) } }), payload: reply(19, blue) },
    'an ask whose file is corrupt': { at: 't20', id: writeAsk(home, 't20', 20, { files: {} }), payload: reply(20, blue) },
  };
  writeFileSync(join(askFolder(home, 't20', askIdOf(20)), 'ask.json'), '{"format": 1, "id": ');

  for (const [why, { at, id, payload }] of Object.entries(refusals)) {
    const before = tree();
    const result = answerMenu(at, id, payload);
    assert.equal(result.status, 1, `${why}: exits 1, stderr: ${result.stderr}`);
    assert.match(result.stderr, /^queue: /, `${why}: stderr is a queue refusal`);
    if (why === 'a payload over the size cap') assert.match(result.stderr, /the answer is over 65536 bytes/, `${why}: stderr names why`);
    if (why === 'an ask a newer bare record of its terminal has superseded') assert.match(result.stderr, /a newer ask of the job has replaced it/, `${why}: stderr names why`);
    assert.equal(result.stdout, '', `${why}: prints nothing`);
    assert.deepEqual(tree(), before, `${why}: writes nothing`);
  }

  const before = tree();
  const payload = reply(1, blue);
  const taken = answerMenu('t1', open, payload);
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(taken.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(join(askFolder(home, 't1', open), 'answer.json'), 'utf8')), payload);
  const after = tree();
  assert.deepEqual(Object.keys(after).filter((name) => !Object.hasOwn(before, name)), [join('t1', open, 'answer.json')],
    'only the named ask gains a file, and no staging file is left');
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([name]) => Object.hasOwn(before, name))), before, 'no file already there changes');

  const again = answerMenu('t1', open, payload);
  assert.equal(again.status, 1, 'a second answer to the same ask is refused');
  assert.deepEqual(tree(), after);
});

test("waiting-menu prints a terminal's one waiting ask and refuses loudly where none can be answered", (t) => {
  const home = temporaryFolder(t, 'herdr-queue-home-');
  const waitingMenu = (...args) => spawnSync(process.execPath, [QUEUE, 'waiting-menu', ...args], { encoding: 'utf8' });
  // Every file under the asks store with its bytes.
  const tree = () => {
    const root = join(home, 'data', 'fabraik-asks');
    return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
      .filter((name) => statSync(join(root, name)).isFile()).map((name) => [name, readFileSync(join(root, name), 'utf8')]));
  };
  const corrupt = (terminalName, n) => writeFileSync(join(askFolder(home, terminalName, askIdOf(n)), 'ask.json'), '{"format": 1,');

  writeAsk(home, 't1', 1, { files: { end: TAB } });
  writeAsk(home, 't1', 3, { files: {} });
  corrupt('t1', 3);
  writeAsk(home, 't1', 2);
  writeAsk(home, 't2', 1, { fields: PERMISSION });
  /** @type {Record<string, { phrase: string, clear: boolean, make?: () => unknown }>} */
  const refusals = {
    t3: { phrase: 'has asked nothing', clear: true },
    t4: { phrase: 'no ask of the job can be read', clear: false, make: () => { writeAsk(home, 't4', 1, { files: {} }); corrupt('t4', 1); } },
    t5: { phrase: 'already answered or ended', clear: false, make: () => writeAsk(home, 't5', 1, { files: { answer: colourAnswer(askIdOf(1), 'Blue') } }) },
    t6: { phrase: 'already answered or ended', clear: false, make: () => writeAsk(home, 't6', 1, { files: { taken: TAKEN } }) },
    t7: { phrase: 'already answered or ended', clear: false, make: () => writeAsk(home, 't7', 1, { files: { end: TAB } }) },
    t8: { phrase: 'its hook has ended', clear: true, make: () => writeAsk(home, 't8', 1, { fields: { pid: GONE_PID } }) },
    t9: { phrase: '2 asks of the job wait at once', clear: false, make: () => { writeAsk(home, 't9', 1); writeAsk(home, 't9', 2); } },
    // A newer record the hook counts as an ask replaces the waiting one, whatever else it lacks.
    t10: {
      phrase: 'a newer ask of the job has replaced it',
      clear: false,
      make: () => {
        writeAsk(home, 't10', 1);
        writeBareAsk(home, 't10', 2);
      },
    },
    // A permission ask that records no visible tool or input cannot be printed or answered.
    t11: {
      phrase: 'holds no tool or input',
      clear: false,
      make: () => writeAsk(home, 't11', 1, { fields: { ...PERMISSION, toolName: undefined } }),
    },
    t14: {
      phrase: 'holds no tool or input',
      clear: false,
      make: () => writeAsk(home, 't14', 1, { fields: { ...PERMISSION, input: ' ' } }),
    },
    t16: {
      phrase: 'holds no tool or input',
      clear: false,
      make: () => writeAsk(home, 't16', 1, { fields: { ...PERMISSION, toolName: ' ' } }),
    },
    // A newer ask folder that is a directory symbolic link still replaces the waiting ask, as the hook lists it.
    t17: {
      phrase: 'a newer ask of the job has replaced it',
      clear: false,
      make: () => {
        writeAsk(home, 't17', 1);
        const outside = temporaryFolder(t, 'herdr-queue-linked-dir-');
        writeBareAsk(outside, 't17', 2);
        try {
          symlinkSync(askFolder(outside, 't17', askIdOf(2)), askFolder(home, 't17', askIdOf(2)), 'dir');
        } catch (error) {
          // Windows without Developer Mode or administrator rights refuses an unprivileged symlink with EPERM.
          if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
          delete refusals.t17;
        }
      },
    },
    // A newer record the hook reads through a symbolic link still replaces the waiting ask.
    t15: {
      phrase: 'a newer ask of the job has replaced it',
      clear: false,
      make: () => {
        writeAsk(home, 't15', 1);
        const outside = temporaryFolder(t, 'herdr-queue-linked-');
        writeBareAsk(outside, 't15', 2);
        const target = join(askFolder(outside, 't15', askIdOf(2)), 'ask.json');
        const folder = askFolder(home, 't15', askIdOf(2));
        mkdirSync(folder, { recursive: true });
        try {
          symlinkSync(target, join(folder, 'ask.json'), 'file');
        } catch (error) {
          // Windows without Developer Mode or administrator rights refuses an unprivileged file symlink with EPERM.
          if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
          rmSync(join(home, 'data', 'fabraik-asks', 't15'), { recursive: true });
          delete refusals.t15;
        }
      },
    },
  };
  for (const { make } of Object.values(refusals)) make?.();
  writeAsk(home, 't12', 1, { fields: { askedAt: MENU_START + 1000 }, files: { end: TAB } });
  writeAsk(home, 't12', 2, { fields: { askedAt: MENU_START + 1000 } });
  writeAsk(home, 't13', 1, { fields: { kind: 'plan', toolName: 'ExitPlanMode', plan: 'Build it.', questions: undefined } });

  const first = waitingMenu('t1', '--home', home);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    terminal: 't1', askId: askIdOf(2), card: '857', kind: 'question', toolName: 'AskUserQuestion', askedAt: MENU_START + 2000, questions: [COLOUR],
  }, 'the newest readable ask that waits, with its questions');
  const permission = waitingMenu('t2', '--home', home);
  assert.equal(permission.status, 0, permission.stderr);
  assert.deepEqual(JSON.parse(permission.stdout), {
    terminal: 't2', askId: askIdOf(1), card: '857', kind: 'permission', toolName: 'Bash', askedAt: MENU_START + 1000, input: 'npm test', whole: true,
  }, 'a permission ask prints its input and whole, and no questions');
  const tied = waitingMenu('t12', '--home', home);
  assert.equal(tied.status, 0, tied.stderr);
  assert.equal(JSON.parse(tied.stdout).askId, askIdOf(2), 'of asks asked at the same time, the one that still waits');
  const plan = waitingMenu('t13', '--home', home);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout), {
    terminal: 't13', askId: askIdOf(1), card: '857', kind: 'plan', toolName: 'ExitPlanMode', askedAt: MENU_START + 1000, plan: 'Build it.',
  }, 'a plan ask prints its plan and no questions');

  // A refusal ends with this clause exactly where the terminal's ask store is clear, so the job waits on nothing the relay can
  // answer and the owner's words may be typed into it. Every entry's mismatch is collected, and the test fails once listing them.
  const CLEAR = '; the relay allows typing into the job';
  const mismatches = [];
  const judge = (label, message, clear) => {
    if (message.endsWith(CLEAR) !== clear) mismatches.push(`${label}: ${clear ? 'misses' : 'carries'} the clause: ${message}`);
  };
  // The refusal of an in-process lookup, judged for the clause.
  const judgeIn = (label, args, clear) => {
    let message;
    try {
      waitingMenuIn({ home, ...args });
    } catch (error) {
      message = /** @type {Error} */ (error).message;
    }
    if (message === undefined) mismatches.push(`${label}: did not refuse`);
    else judge(label, message, clear);
  };

  for (const [at, { phrase, clear }] of Object.entries(refusals)) {
    const before = tree();
    const result = waitingMenu(at, '--home', home);
    assert.equal(result.status, 1, `${at}: exits 1, stderr: ${result.stderr}`);
    assert.match(result.stderr, /^queue: /, `${at}: stderr is a queue refusal`);
    assert.ok(result.stderr.includes(phrase), `${at}: stderr names why: ${result.stderr}`);
    assert.equal(result.stdout, '', `${at}: prints nothing`);
    assert.deepEqual(tree(), before, `${at}: writes nothing`);
    judge(at, result.stderr.replace(/\n$/, ''), clear);
  }

  // Each of these holds a take or an end, or has a hook that is gone, so the clause depends on the ask store alone.
  const T = MENU_START;
  const setTime = (terminalName, n, file, ms) => utimesSync(join(askFolder(home, terminalName, askIdOf(n)), file), ms / 1000, ms / 1000);
  const goneWith = (files, fields = {}) => ({ fields: { pid: GONE_PID, ...fields }, files });
  const blue = (n) => colourAnswer(askIdOf(n), 'Blue');
  const PLAN = { kind: 'plan', toolName: 'ExitPlanMode', plan: 'Build it.', questions: undefined };

  writeAsk(home, 't18', 1, goneWith({ answer: blue(1) }));
  judgeIn('t18', { terminal: 't18' }, true);

  writeAsk(home, 't19', 1, { fields: PERMISSION, files: { answer: permissionAnswer(askIdOf(1)), taken: TAKEN } });
  setTime('t19', 1, 'taken.json', Date.now() - 60_000);
  writeAsk(home, 't19', 2, { fields: { pid: GONE_PID } });
  judgeIn('t19', { terminal: 't19' }, false);

  writeAsk(home, 't21', 1, goneWith({ answer: permissionAnswer(askIdOf(1)), taken: TAKEN, end: DELIVERED }, PERMISSION));
  setTime('t21', 1, 'taken.json', T);
  judgeIn('t21 at T + 9_999', { terminal: 't21', now: () => T + 9_999 }, false);
  judgeIn('t21 at T + 10_000', { terminal: 't21', now: () => T + 10_000 }, true);

  writeAsk(home, 't23', 1, goneWith({ answer: blue(1), taken: TAKEN, end: DELIVERED }));
  setTime('t23', 1, 'taken.json', T);
  judgeIn('t23', { terminal: 't23', now: () => T }, true);

  writeAsk(home, 't24', 1, goneWith({ answer: { format: 1, askId: askIdOf(1), by: 'panel', choice: 'Keep planning' }, taken: TAKEN }, PLAN));
  setTime('t24', 1, 'taken.json', T);
  judgeIn('t24 at T + 9_999', { terminal: 't24', now: () => T + 9_999 }, false);

  writeAsk(home, 't25', 1, goneWith({ answer: blue(1), taken: TAKEN, end: {} }));
  setTime('t25', 1, 'taken.json', T);
  judgeIn('t25', { terminal: 't25', now: () => T }, false);

  // A pid Node rejects is not shown gone.
  writeAsk(home, 't26', 1, { fields: { pid: 2147483648 } });
  judgeIn('t26', { terminal: 't26' }, false);

  // A newer ask folder that is a directory link still counts, so a scan that followed it would find the settled ask alone.
  writeAsk(home, 't20', 1, goneWith({ end: TAB }));
  const linkedOutside = temporaryFolder(t, 'herdr-queue-linked-dir-');
  writeAsk(linkedOutside, 't20', 2, { fields: { pid: GONE_PID } });
  // A taken.json that is a dangling link is no regular file, so the take counts as in flight.
  writeAsk(home, 't22', 1, goneWith({ answer: permissionAnswer(askIdOf(1)), end: TAB }, PERMISSION));
  try {
    symlinkSync(askFolder(linkedOutside, 't20', askIdOf(2)), askFolder(home, 't20', askIdOf(2)), 'dir');
    judgeIn('t20', { terminal: 't20' }, false);
    symlinkSync(join(linkedOutside, 'missing'), join(askFolder(home, 't22', askIdOf(1)), 'taken.json'), 'file');
    judgeIn('t22', { terminal: 't22' }, false);
  } catch (error) {
    // Windows without Developer Mode or administrator rights refuses an unprivileged symlink with EPERM.
    if (process.platform !== 'win32' || /** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
  }

  assert.deepEqual(mismatches, [], 'the clause ends exactly the refusals of a clear ask store');

  for (const shape of [['--home', home], ['a/b', '--home', home], ['t1', 'x', '--home', home], ['--unknown', '--home', home]]) {
    const refused = waitingMenu(...shape);
    assert.deepEqual({ status: refused.status, stderr: refused.stderr }, { status: 2, stderr: QUEUE_USAGE }, JSON.stringify(shape));
  }
});

test('no panel or queue path writes input to a job terminal', {
  skip: process.platform === 'win32' && 'the stand-in commands are shell scripts',
}, async (t) => {
  const repository = temporaryFolder(t, 'herdr-queue-repo-');
  mkdirSync(join(repository, 'scripts'));
  writeFileSync(join(repository, 'scripts', 'owner-queue.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(collectorDocument()))});\n`);
  const { home } = releasedHome(t, [repository]);
  const open = writeAsk(home, 't1', 1);
  // Stand-ins for the commands that reach a terminal, each recording its arguments.
  const bin = temporaryFolder(t, 'herdr-queue-bin-');
  const record = join(bin, 'calls');
  for (const program of ['hc', 'herdr-app']) {
    writeFileSync(join(bin, program), `#!/bin/sh\n{ printf '${program}'; printf ' %s' "$@"; printf '\\n'; } >> '${record}'\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], { encoding: 'utf8', env });

  const refreshed = queue('refresh', blockedAt('t1'));
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const answered = queue('answer-menu', 't1', open, '--answer', JSON.stringify({ format: 1, askId: open, by: 'panel', answers: { [COLOUR.question]: { choices: ['Blue'] } } }));
  assert.equal(answered.status, 0, answered.stderr);
  assert.ok(existsSync(join(askFolder(home, 't1', open), 'answer.json')), 'the answer is a file the job hook reads');
  const calls = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  for (const call of calls) assert.doesNotMatch(call, /\b(send|keys|interrupt|put|paste|type)\b/, `a queue path reached a terminal: ${call}`);

  // The panel runs only the queue script and no Herdr action that sends input, and neither file names hc or herdr-app as a
  // program. Both are read through ESLint's parser, so no quoting or spacing hides a call: each call of Herdr's exec or run
  // has a fixed string first, read whatever its quotes, and a string anywhere naming either program is found as written.
  // The parser is a development package, which an installed copy may lack: there this check skips and the rest still runs.
  let espree;
  try {
    espree = await import('espree');
  } catch {
    t.skip('espree is not installed, so the source structure check cannot run here');
    return;
  }
  const parsed = (name) => espree.parse(readFileSync(join(dirname(QUEUE), name), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', loc: true });
  const panel = parsed('main.js');
  const aggregator = parsed('queue.mjs');
  const imports = (tree, from) => tree.body.filter((node) => node.type === 'ImportDeclaration' && from.includes(node.source.value)).flatMap((node) => node.specifiers);
  const herdr = imports(panel, ['herdr']);
  assert.ok(herdr.length > 0 && herdr.every((specifier) => specifier.type === 'ImportSpecifier'), 'the panel imports Herdr by name');
  for (const { imported } of herdr) assert.doesNotMatch(imported.name, /send|input|key|paste|type|write/i, `the panel imports Herdr's ${imported.name}`);
  const local = (name) => herdr.find((specifier) => specifier.imported.name === name)?.local.name;
  const firstArguments = (name) => [...syntaxNodes(panel)]
    .filter((node) => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === local(name))
    .map((node) => fixedText(node.arguments[0]));
  assert.deepEqual([...new Set(firstArguments('exec'))], ['node'], 'the panel execs only node');
  // The panel may run no Herdr action at all; the exec check above proves the call search finds calls.
  for (const action of firstArguments('run')) {
    assert.equal(typeof action, 'string', 'every Herdr action the panel runs is a fixed name');
    assert.doesNotMatch(action, /send|input|key|paste|type|text/, `the panel runs ${action}`);
  }
  assert.deepEqual(imports(panel, ['child_process', 'node:child_process']), [], 'the panel starts no process of its own');
  for (const { imported } of imports(aggregator, ['child_process', 'node:child_process'])) {
    assert.ok(['execFile', 'execFileSync'].includes(imported.name), `queue.mjs starts processes only without a shell, not by ${imported.name}`);
  }
  for (const [file, tree] of [['main.js', panel], ['queue.mjs', aggregator]]) {
    for (const node of syntaxNodes(tree)) {
      const text = node.type === 'Literal' ? node.value : node.type === 'TemplateElement' ? node.value.cooked : null;
      if (typeof text === 'string') assert.doesNotMatch(text, /(^|[\\/])(hc|herdr-app)(\s|$)/, `${file} line ${node.loc.start.line} names a terminal program`);
    }
  }
});

// Every syntax node under `node`, `node` included, in source order.
function* syntaxNodes(node) {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof child.type === 'string') yield* syntaxNodes(child);
    }
  }
}

// The string `node` holds whatever its quotes: a string literal, or a template without substitutions; null where it is computed.
const fixedText = (node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null);

// `answer-menu` repeats the hook's answer checks, because the queue runs outside any repository. The same answers go to both and
// each must give the same verdict: the wrong shapes are the owner-menu test's, the valid ones a multi-question answer whose second
// question is multi-select and an answer whose text is at the 500 character limit. A permission prompt takes an allow only where
// the panel showed its call whole: an uncut Bash command is, a Write call is not; each side reads the same call, the hook as
// Claude Code gives it and the queue as the hook records it.
test('answer-menu accepts and refuses exactly the answers the owner-menu hook accepts and refuses', async (t) => {
  const queueHome = temporaryFolder(t, 'herdr-queue-parity-');
  const hookHome = temporaryFolder(t, 'herdr-hook-parity-');
  const questions = [COLOUR, LETTERS];
  const valid = { [COLOUR.question]: { choices: ['Red'] }, [LETTERS.question]: { choices: ['A', 'C'], text: 'also D' } };
  const record = (id, answers = valid, askId = id) => ({ format: 1, askId, by: 'panel', answers });
  const colour = (id, entry) => record(id, { ...valid, [COLOUR.question]: entry });
  const QUESTIONS = { call: { tool_name: 'AskUserQuestion', tool_input: { questions } }, ask: { questions } };
  const BASH = { call: { tool_name: 'Bash', tool_input: { command: 'npm test' } }, ask: PERMISSION };
  const WRITE = {
    call: { tool_name: 'Write', tool_input: { file_path: '/jobs/job-857/notes.txt', content: 'notes' } },
    ask: { ...PERMISSION, toolName: 'Write', input: '/jobs/job-857/notes.txt', whole: false },
  };
  const answers = {
    'an allow on a permission call shown whole': { accepted: true, on: BASH, make: permissionAnswer },
    'an allow on a permission call not shown whole': { on: WRITE, make: permissionAnswer },
    'a valid multi-question answer': { accepted: true, make: (id) => record(id) },
    'text of exactly 500 characters': { accepted: true, make: (id) => colour(id, { text: 'x'.repeat(500) }) },
    'a wrong askId': { make: (id) => record(id, valid, '0'.repeat(32)) },
    'a label not offered': { make: (id) => colour(id, { choices: ['Green'] }) },
    'two choices for a single-select question': { make: (id) => colour(id, { choices: ['Red', 'Blue'] }) },
    'a missing question': { make: (id) => record(id, { [LETTERS.question]: { choices: ['B'] } }) },
    'an extra key': { make: (id) => record(id, { ...valid, 'Which shape?': { choices: ['Square'] } }) },
    'text over 500 characters': { make: (id) => colour(id, { text: 'x'.repeat(501) }) },
    'text holding a credential': { make: (id) => colour(id, { text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' }) },
  };

  // The verdict of the hook: it takes an answer file written at its first look, or sets it aside and waits, and the second look
  // ends it as if the job's tab had answered.
  let clock = MENU_START;
  const hookVerdict = async (make, on) => {
    const store = join(hookHome, 'data', 'fabraik-asks', 't1');
    const before = new Set(existsSync(store) ? readdirSync(store) : []);
    let looks = 0;
    const result = await ownerMenu({ hook_event_name: 'PermissionRequest', cwd: hookHome, ...on.call }, {
      env: { FABRAIK_COORDINATED_JOB: '1', PRE_APPROVED_RUN_CARD: '857', HC_TERMINAL_ID: 't1', HERDR_APP_HOME: hookHome },
      git: () => { throw new Error('the parity folder is no checkout'); },
      hc: async () => ({ code: 0, stdout: JSON.stringify({ status: { state: 'blocked' } }), stderr: '' }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        looks += 1;
        assert.ok(looks <= 2, 'the hook looked a third time');
        const id = readdirSync(store).find((name) => !before.has(name));
        assert.ok(id, 'the hook made its ask');
        if (looks === 1) writeFileSync(join(store, id, 'answer.json'), JSON.stringify(make(id)));
        else writeFileSync(join(store, id, 'end.json'), `${JSON.stringify(TAB)}\n`);
      },
    });
    return result === undefined ? 'refused' : 'accepted';
  };
  const queueVerdict = (make, on, n) => {
    const id = writeAsk(queueHome, `p${n}`, n, { fields: on.ask });
    const result = spawnSync(process.execPath, [QUEUE, 'answer-menu', `p${n}`, id, '--answer', JSON.stringify(make(id)), '--home', queueHome], { encoding: 'utf8' });
    if (result.status === 0) return 'accepted';
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^queue: /);
    return 'refused';
  };

  const expected = Object.values(answers).map(({ accepted }) => (accepted ? 'accepted' : 'refused'));
  const hook = [];
  for (const { make, on = QUESTIONS } of Object.values(answers)) hook.push(await hookVerdict(make, on));
  const queue = Object.values(answers).map(({ make, on = QUESTIONS }, index) => queueVerdict(make, on, index + 1));
  assert.deepEqual(hook, expected, 'the hook gives the verdicts the plan states');
  assert.deepEqual(queue, hook, `answer-menu and the hook differ over ${Object.keys(answers).join(' | ')}`);
});

// The coordinator holds only the job's terminal: `waiting-menu` tells it the ask and `answer-menu` built from that output alone
// answers the real hook, which returns the owner's words as the answer to the question.
test("a coordinator relay through waiting-menu and answer-menu reaches the job's waiting hook", async (t) => {
  const home = temporaryFolder(t, 'herdr-relay-');
  const WORDS = "it's the green one, please";
  let clock = MENU_START;
  let looks = 0;
  const result = await ownerMenu({ hook_event_name: 'PermissionRequest', cwd: home, tool_name: 'AskUserQuestion', tool_input: { questions: [COLOUR] } }, {
    env: { FABRAIK_COORDINATED_JOB: '1', PRE_APPROVED_RUN_CARD: '857', HC_TERMINAL_ID: 't1', HERDR_APP_HOME: home },
    git: () => { throw new Error('the relay folder is no checkout'); },
    hc: async () => ({ code: 0, stdout: JSON.stringify({ status: { state: 'blocked' } }), stderr: '' }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      looks += 1;
      assert.ok(looks <= 5, 'the hook looked a sixth time');
      if (looks > 1) return;
      const waiting = spawnSync(process.execPath, [QUEUE, 'waiting-menu', 't1', '--home', home], { encoding: 'utf8' });
      assert.equal(waiting.status, 0, waiting.stderr);
      const { askId, questions } = JSON.parse(waiting.stdout);
      const answer = { format: 1, askId, by: 'coordinator', answers: { [questions[0].question]: { text: WORDS } } };
      // The argument as the relay instruction writes it: the JSON in single quotes with each `'` written `'\''`, which a shell
      // delivers as one argument. Windows has no such shell, so there the JSON is the one argument.
      const quoted = `'${JSON.stringify(answer).replaceAll("'", "'\\''")}'`;
      const answered = process.platform === 'win32'
        ? spawnSync(process.execPath, [QUEUE, 'answer-menu', 't1', askId, '--answer', JSON.stringify(answer), '--home', home], { encoding: 'utf8' })
        : spawnSync('sh', ['-c', `exec "$0" "$1" answer-menu t1 ${askId} --answer ${quoted} --home "$2"`, process.execPath, QUEUE, home], { encoding: 'utf8' });
      assert.equal(answered.status, 0, answered.stderr);
    },
  });
  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions: [COLOUR], answers: { [COLOUR.question]: WORDS } } },
    },
  });
});
