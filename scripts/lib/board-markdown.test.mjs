// board-markdown.test.mjs — direct tests of the markdown tracker's card reader.
// Run: node --test scripts/lib/board-markdown.test.mjs
//
// Every test loads the module from a copy wired to the literal markdown configuration, never
// to this install's own board-config.mjs, so they hold under any tracker. Git and `gh` are
// injected: each expected value below is written by hand from the card format and git's
// documented output formats, not computed by the module. The temporary-repository tests that
// prove the same reads against real refs are in board-portability.test.mjs.
//
// Price tag: recurring cost is one toolkit copy and a handful of small temporary folders, about
// 20 ms per suite run.
// Removal condition: retire it with the markdown tracker.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKDOWN_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

const toolkit = copyToolkit(MARKDOWN_TEST_CONFIG);
after(() => toolkit.cleanup());

const {
  CARDS_DIR,
  containCards,
  configuredTracker,
  deriveColumn,
  jobRefs,
  markdownBoardItems,
  markdownCardDetails,
  openPullRequests,
  parseCard,
  publishedStatuses,
  readCards,
} = await toolkit.load('lib/board-markdown.mjs');
const { verifyMarkdownPublication } = await toolkit.load('lib/issue-publish.mjs');

const VOCABULARY = {
  kinds: ['epic', 'feature', 'task', 'bug', 'docs'],
  routingField: 'Workstream',
  routingOptions: ['Go-to-market', 'Product', 'Platform'],
  statuses: ['Backlog', 'Ready', 'Done'],
};
const NO_ROUTING_VOCABULARY = { ...VOCABULARY, routingField: null, routingOptions: [] };
const FILE = '.agents/cards/7.md';
const lines = (...parts) => `${parts.join('\n')}\n`;

const WELL_FORMED = lines(
  '# Fix the thing',
  '',
  'Status: Ready',
  'Kind: bug',
  'Workstream: Product',
  'Parent: 3',
  'Blocked by: 4, 5',
  '',
  'Body line one',
  '',
  'Body line two',
  '',
  '## Comments',
  '',
  '### host-a 2026-01-01',
  'First comment',
  'more',
  '',
  '### host-b',
  'Second',
);

test('configuredTracker reads the markdown configuration', () => {
  assert.equal(configuredTracker(), 'markdown');
});

test('parseCard reads the whole card format and treats CRLF line endings as LF', () => {
  const expected = {
    number: 7,
    title: 'Fix the thing',
    status: 'Ready',
    kind: 'bug',
    routing: 'Product',
    parent: 3,
    blockedBy: [4, 5],
    body: 'Body line one\n\nBody line two',
    comments: [
      { heading: 'host-a 2026-01-01', text: 'First comment\nmore' },
      { heading: 'host-b', text: 'Second' },
    ],
    fieldLines: { Parent: 6, 'Blocked by': 7 },
  };
  assert.deepEqual(parseCard(FILE, WELL_FORMED, VOCABULARY), expected);
  assert.deepEqual(parseCard(FILE, WELL_FORMED.replaceAll('\n', '\r\n'), VOCABULARY), expected);
});

test('parseCard reads a card with no optional fields, no body and no comments', () => {
  const card = parseCard(FILE, lines('# Bare', '', 'Status: Done', 'Kind: task', 'Workstream: Platform'), VOCABULARY);
  assert.deepEqual(card, {
    number: 7,
    title: 'Bare',
    status: 'Done',
    kind: 'task',
    routing: 'Platform',
    parent: null,
    blockedBy: [],
    body: '',
    comments: [],
    fieldLines: {},
  });
});

test('parseCard on a vocabulary with no routing field requires none and refuses one as an unknown field', () => {
  const bare = lines('# Bare', '', 'Status: Ready', 'Kind: task');
  assert.equal(parseCard(FILE, bare, NO_ROUTING_VOCABULARY).routing, null);
  assert.throws(
    () => parseCard(FILE, lines('# Bare', '', 'Status: Ready', 'Kind: task', 'Workstream: Product'), NO_ROUTING_VOCABULARY),
    { message: `${FILE}:5: unknown field "Workstream"` },
  );
});

test('parseCard refuses an unknown or duplicate key, naming the file and line', () => {
  assert.throws(
    () => parseCard(FILE, lines('# T', '', 'Status: Ready', 'Kind: bug', 'Colour: red', 'Workstream: Product'), VOCABULARY),
    { message: `${FILE}:5: unknown field "Colour"` },
  );
  assert.throws(
    () => parseCard(FILE, lines('# T', '', 'Status: Ready', 'Kind: bug', 'Kind: task', 'Workstream: Product'), VOCABULARY),
    { message: `${FILE}:5: duplicate field "Kind"` },
  );
});

test('parseCard refuses each malformed title, field, reference and section, naming the file and line', () => {
  const head = ['Status: Ready', 'Kind: bug', 'Workstream: Product'];
  const refusals = [
    ['no title heading', lines('Fix', '', ...head), `${FILE}:1: expected "# <title>"`],
    ['empty title', lines('# ', '', ...head), `${FILE}:1: expected "# <title>"`],
    ['no blank line after the title', lines('# T', ...head), `${FILE}:2: expected a blank line after the title`],
    ['field with no value separator', lines('# T', '', 'Status Ready', 'Kind: bug', 'Workstream: Product'), `${FILE}:3: expected "<Field>: <value>"`],
    ['missing Status', lines('# T', '', 'Kind: bug', 'Workstream: Product', ''), `${FILE}:5: missing required field "Status"`],
    ['missing Kind', lines('# T', '', 'Status: Ready', 'Workstream: Product', ''), `${FILE}:5: missing required field "Kind"`],
    ['missing routing field', lines('# T', '', 'Status: Ready', 'Kind: bug', ''), `${FILE}:5: missing required field "Workstream"`],
    ['an in-flight Status', lines('# T', '', 'Status: In progress', 'Kind: bug', 'Workstream: Product'), `${FILE}:3: Status must be one of Backlog, Ready, Done; found "In progress"`],
    ['an unknown Kind', lines('# T', '', 'Status: Ready', 'Kind: chore', 'Workstream: Product'), `${FILE}:4: Kind must be one of epic, feature, task, bug, docs; found "chore"`],
    ['an unknown routing option', lines('# T', '', ...head.slice(0, 2), 'Workstream: Sales'), `${FILE}:5: Workstream must be one of Go-to-market, Product, Platform; found "Sales"`],
    ['a Parent that is not a number', lines('# T', '', ...head, 'Parent: x'), `${FILE}:6: Parent must be a card number; found "x"`],
    ['a Parent with a leading zero', lines('# T', '', ...head, 'Parent: 03'), `${FILE}:6: Parent must be a card number; found "03"`],
    ['a Parent beyond the safe integers', lines('# T', '', ...head, 'Parent: 9007199254740993'), `${FILE}:6: Parent must be a card number; found "9007199254740993"`],
    ['the card as its own Parent', lines('# T', '', ...head, 'Parent: 7'), `${FILE}:6: Parent must not name the card itself`],
    ['Blocked by without a comma and space', lines('# T', '', ...head, 'Blocked by: 4,5'), `${FILE}:6: Blocked by must be card numbers separated by ", "; found "4,5"`],
    ['a blocker beyond the safe integers', lines('# T', '', ...head, 'Blocked by: 4, 9007199254740993'), `${FILE}:6: Blocked by must be card numbers separated by ", "; found "4, 9007199254740993"`],
    ['a repeated blocker', lines('# T', '', ...head, 'Blocked by: 4, 4'), `${FILE}:6: Blocked by names card 4 twice`],
    ['the card as its own blocker', lines('# T', '', ...head, 'Blocked by: 4, 7'), `${FILE}:6: Blocked by must not name the card itself`],
    ['a second Comments heading', lines('# T', '', ...head, '', '## Comments', '### a', 'x', '## Comments'), `${FILE}:10: a second "## Comments" heading`],
    ['text before the first comment heading', lines('# T', '', ...head, '', '## Comments', 'loose text'), `${FILE}:8: text under "## Comments" before the first "### " comment heading`],
    ['a comment heading with no text', lines('# T', '', ...head, '', '## Comments', '### '), `${FILE}:8: a comment heading needs text after "### "`],
  ];
  for (const [what, text, message] of refusals) {
    assert.throws(() => parseCard(FILE, text, VOCABULARY), { message }, what);
  }
});

const NONE = { local: false, localTipDone: false, remote: false, openPullRequests: [] };

test('deriveColumn applies rules 1 to 4 in order', () => {
  // 4: nothing in flight reads as the published status.
  assert.equal(deriveColumn('Backlog', NONE), 'Backlog');
  assert.equal(deriveColumn('Ready', NONE), 'Ready');
  // 3: a local branch, or one origin lists.
  assert.equal(deriveColumn('Ready', { ...NONE, local: true }), 'In progress');
  assert.equal(deriveColumn('Ready', { ...NONE, remote: true }), 'In progress');
  // 2: a local branch whose tip's copy says Done beats rule 3.
  assert.equal(deriveColumn('Ready', { ...NONE, local: true, localTipDone: true }), 'Awaiting push');
  assert.equal(deriveColumn('Ready', { ...NONE, local: true, localTipDone: true, remote: true }), 'Awaiting push');
  // 1: an open pull request beats rule 2.
  assert.equal(deriveColumn('Ready', { local: true, localTipDone: true, remote: true, openPullRequests: [{ number: 5 }] }), 'In review');
  // A published Done is Done whatever branches exist.
  assert.equal(deriveColumn('Done', { local: true, localTipDone: true, remote: true, openPullRequests: [{ number: 5 }] }), 'Done');
});

test('deriveColumn reads a pushed branch with no open pull request as In progress', () => {
  assert.equal(deriveColumn('Ready', { ...NONE, local: true, remote: true }), 'In progress');
  assert.equal(deriveColumn('Backlog', { ...NONE, remote: true }), 'In progress');
});

const card = (number, overrides = {}) => ({
  number,
  title: `Card ${number}`,
  status: 'Ready',
  kind: 'task',
  routing: 'Product',
  parent: null,
  blockedBy: [],
  body: '',
  comments: [],
  fieldLines: {},
  ...overrides,
});
const OID = 'a'.repeat(40);

test('markdownBoardItems keeps a Done written only on job/<N> OPEN and Awaiting push', () => {
  const cards = new Map([[5, card(5, { status: 'Done' })]]);
  const published = new Map([[5, { status: 'Ready', onMain: true }]]);
  const refs = { local: new Map([[5, 'Done']]), remote: new Map() };

  const [item] = markdownBoardItems(cards, published, refs, new Map());

  assert.equal(item.content.state, 'OPEN');
  assert.equal(item.status, 'Awaiting push');
  assert.deepEqual(item.closingPullRequests, []);
});

test('markdownBoardItems derives every item field from the cards, the published statuses, the refs and the pull requests', () => {
  const cards = new Map([
    [1, card(1, { kind: 'epic' })],
    [2, card(2, { title: 'Second', parent: 1, blockedBy: [3] })],
    [3, card(3, { status: 'Done' })],
    [4, card(4, { parent: 1 })],
  ]);
  const published = new Map([
    [1, { status: 'Backlog', onMain: true }],
    [2, { status: 'Ready', onMain: true }],
    [3, { status: 'Done', onMain: true }],
    [4, { status: 'Done', onMain: true }],
  ]);
  const refs = { local: new Map(), remote: new Map([[2, OID], [3, OID]]) };
  const pulls = new Map([[2, [{ number: 12 }]], [3, [{ number: 13 }]]]);

  const items = markdownBoardItems(cards, published, refs, pulls);

  assert.deepEqual(items[1], {
    id: '.agents/cards/2.md',
    status: 'In review',
    title: 'Second',
    routing: 'Product',
    labels: ['task'],
    assignees: [],
    blockers: [{ number: 3, state: 'CLOSED' }],
    closingPullRequests: [{ number: 12 }],
    jobBranch: { local: false, remote: true },
    content: { number: 2, state: 'OPEN', subIssuesSummary: { total: 0, completed: 0 } },
  });
  // The epic counts its two children, one of them published Done.
  assert.deepEqual(items[0].content, { number: 1, state: 'OPEN', subIssuesSummary: { total: 2, completed: 1 } });
  assert.deepEqual(items[0].labels, ['epic']);
  assert.equal('jobBranch' in items[0], false);
  // A published Done is CLOSED and Done: a stale branch and a stale pull request change nothing.
  assert.equal(items[2].status, 'Done');
  assert.equal(items[2].content.state, 'CLOSED');
  assert.deepEqual(items[2].closingPullRequests, []);
});

test('markdownBoardItems counts a pull request only for a card published Backlog or Ready', () => {
  const cards = new Map([[3, card(3)], [4, card(4)]]);
  const published = new Map([[3, { status: 'Ready', onMain: true }], [4, { status: 'Done', onMain: true }]]);
  const pulls = new Map([[3, [{ number: 13 }]], [4, [{ number: 14 }]]]);

  const items = markdownBoardItems(cards, published, { local: new Map(), remote: new Map() }, pulls);

  assert.deepEqual(items.map((item) => item.closingPullRequests), [[{ number: 13 }], []]);
});

// What `git cat-file --batch` answers (its documented `<oid> blob <size>` header, the bytes, a
// newline, or `<name> missing`), what `for-each-ref` and `ls-remote --heads` print, and a
// failing ref lookup, as one injected runner that also records every call.
function fakeGit({ ref = true, blobs = {}, locals = '', remotes = '' } = {}) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    switch (args[0]) {
      case 'rev-parse':
        if (!ref) throw new Error('fatal: Needed a single revision');
        return `${OID}\n`;
      case 'for-each-ref':
        return locals;
      case 'ls-remote':
        if (remotes instanceof Error) throw remotes;
        return remotes;
      case 'cat-file':
        return input.split('\n').filter(Boolean)
          .map((spec) => (spec in blobs ? `${OID} blob ${Buffer.byteLength(blobs[spec])}\n${blobs[spec]}\n` : `${spec} missing\n`))
          .join('');
      default:
        throw new Error(`unexpected git call ${args.join(' ')}`);
    }
  };
  return { run, calls };
}

const ON_MAIN = (n) => `refs/remotes/origin/main:.agents/cards/${n}.md`;
const AT_TIP = (n) => `refs/heads/job/${n}:.agents/cards/${n}.md`;
const publishedCopy = (title, status) => lines(`# ${title}`, '', `Status: ${status}`, 'Kind: task', 'Workstream: Product');

test('publishedStatuses reads every card from origin/main in one batch call, framing multi-byte text by its byte length', () => {
  const git = fakeGit({ blobs: { [ON_MAIN(1)]: publishedCopy('Café → ok', 'Ready'), [ON_MAIN(2)]: publishedCopy('Second', 'Done') } });
  const cards = new Map([[1, card(1, { status: 'Backlog' })], [2, card(2, { status: 'Done' })]]);

  const published = publishedStatuses(git.run, cards);

  assert.deepEqual([...published], [[1, { status: 'Ready', onMain: true }], [2, { status: 'Done', onMain: true }]]);
  const batches = git.calls.filter((call) => call.args[0] === 'cat-file');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].args, ['cat-file', '--batch']);
  assert.equal(batches[0].input, `${ON_MAIN(1)}\n${ON_MAIN(2)}\n`);
});

test('publishedStatuses refuses a missing origin/main, naming the fetch', () => {
  assert.throws(
    () => publishedStatuses(fakeGit({ ref: false }).run, new Map([[1, card(1)]])),
    { message: /^refs\/remotes\/origin\/main is missing; run: git fetch origin main \(fatal: Needed a single revision\)$/ },
  );
});

test('publishedStatuses refuses an origin/main copy that does not parse, naming it and the line', () => {
  const broken = lines('# T', '', 'Status: Ready', 'Kind: task', 'Workstream: Product', 'Colour: red');
  assert.throws(
    () => publishedStatuses(fakeGit({ blobs: { [ON_MAIN(1)]: broken } }).run, new Map([[1, card(1)]])),
    { message: 'origin/main:.agents/cards/1.md:6: unknown field "Colour"' },
  );
});

test('publishedStatuses refuses a card absent from origin/main whose checkout copy says Done, naming the initial publication', () => {
  assert.throws(
    () => publishedStatuses(fakeGit().run, new Map([[3, card(3, { status: 'Done' })]])),
    { message: '.agents/cards/3.md says Done but is not on origin/main; a card is first published as Backlog or Ready through a merged change' },
  );
});

test('publishedStatuses reads a card absent from origin/main as its checkout copy when that says Ready or Backlog', () => {
  const cards = new Map([[3, card(3, { status: 'Ready' })], [4, card(4, { status: 'Backlog' })]]);

  assert.deepEqual([...publishedStatuses(fakeGit().run, cards)], [
    [3, { status: 'Ready', onMain: false }],
    [4, { status: 'Backlog', onMain: false }],
  ]);
});

test('publishedStatuses refuses a batch answer whose size does not frame the content', () => {
  const run = (args) => (args[0] === 'rev-parse' ? `${OID}\n` : `${OID} blob 99\nshort\n`);
  assert.throws(
    () => publishedStatuses(run, new Map([[1, card(1)]])),
    { message: `cat-file --batch answered ${ON_MAIN(1)} with a size that does not frame its content` },
  );
});

const REMOTE_A = 'b'.repeat(40);
const REMOTE_B = 'c'.repeat(64);

test('jobRefs reads the local and origin job branches, the local tips\' card status included, and ignores other branches and a number beyond the safe integers', () => {
  const git = fakeGit({
    locals: 'refs/heads/job/12\nrefs/heads/job/7\nrefs/heads/job/notes\nrefs/heads/job/9007199254740993\n',
    remotes: `${REMOTE_A}\trefs/heads/job/7\n${REMOTE_A}\trefs/heads/main\n${REMOTE_B}\trefs/heads/job/20\n${REMOTE_A}\trefs/heads/job/07\n${REMOTE_A}\trefs/heads/job/9007199254740993\n`,
    blobs: { [AT_TIP(12)]: publishedCopy('Done on the branch', 'Done') },
  });

  const refs = jobRefs(git.run);

  assert.deepEqual([...refs.local], [[12, 'Done'], [7, null]]);
  assert.deepEqual([...refs.remote], [[7, REMOTE_A], [20, REMOTE_B]]);
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['for-each-ref', '--format=%(refname)', 'refs/heads/job/'],
    ['ls-remote', '--heads', 'origin'],
    ['cat-file', '--batch'],
  ]);
});

test('jobRefs fails the read when ls-remote fails', () => {
  assert.throws(
    () => jobRefs(fakeGit({ remotes: new Error('fatal: unable to access origin') }).run),
    { message: "cannot read origin's branches (git ls-remote --heads origin): fatal: unable to access origin" },
  );
});

test('jobRefs fails the read on an ls-remote line that is not an object id, a tab and a branch', () => {
  for (const line of ['garbage', `${REMOTE_A} refs/heads/job/7`, `${REMOTE_A}\trefs/tags/job/7`]) {
    assert.throws(
      () => jobRefs(fakeGit({ remotes: `${line}\n` }).run),
      { message: `git ls-remote --heads origin returned a line that is not "<object id><tab>refs/heads/<name>": ${JSON.stringify(line)}` },
      line,
    );
  }
});

test('jobRefs refuses a local branch tip whose card copy does not parse, naming it and the line', () => {
  const broken = lines('# T', '', 'Status: Ready', 'Colour: red');
  assert.throws(
    () => jobRefs(fakeGit({ locals: 'refs/heads/job/12\n', blobs: { [AT_TIP(12)]: broken } }).run),
    { message: 'job/12:.agents/cards/12.md:4: unknown field "Colour"' },
  );
});

const JOB_3_REPLY = [
  { number: 5, headRefName: 'job/3', isCrossRepository: false },
  { number: 6, headRefName: 'job/3', isCrossRepository: true },
  { number: 7, headRefName: 'job/30', isCrossRepository: false },
];

test('openPullRequests binds the read to the configured repository and counts only its own job branch', () => {
  const sent = [];
  const gh = (args) => {
    sent.push(args);
    return JSON.stringify(args.includes('job/3') ? JOB_3_REPLY : []);
  };

  const pulls = openPullRequests([3, 4], gh, 'octocat/widgets');

  assert.deepEqual(sent, [
    ['pr', 'list', '--repo', 'octocat/widgets', '--head', 'job/3', '--state', 'open', '--json', 'number,headRefName,isCrossRepository'],
    ['pr', 'list', '--repo', 'octocat/widgets', '--head', 'job/4', '--state', 'open', '--json', 'number,headRefName,isCrossRepository'],
  ]);
  assert.deepEqual([...pulls], [[3, [{ number: 5 }]], [4, []]]);
});

test('openPullRequests refuses a malformed reply and a failed call', () => {
  const replies = [
    'not json',
    '{}',
    'null',
    '[null]',
    JSON.stringify([{ number: '5', headRefName: 'job/3', isCrossRepository: false }]),
    JSON.stringify([{ number: 0, headRefName: 'job/3', isCrossRepository: false }]),
    JSON.stringify([{ number: -5, headRefName: 'job/3', isCrossRepository: false }]),
    JSON.stringify([{ number: Number.MAX_SAFE_INTEGER + 1, headRefName: 'job/3', isCrossRepository: false }]),
    JSON.stringify([{ number: 5, headRefName: 3, isCrossRepository: false }]),
    JSON.stringify([{ number: 5, headRefName: 'job/3', isCrossRepository: 'false' }]),
    JSON.stringify([{ number: 5, headRefName: 'job/3' }]),
  ];
  for (const reply of replies) {
    assert.throws(() => openPullRequests([3], () => reply, 'octocat/widgets'), { message: /^the pull-request list for job\/3 is malformed: / }, reply);
  }
  assert.throws(
    () => openPullRequests([3], () => { throw new Error('gh: not logged in'); }, 'octocat/widgets'),
    { message: 'cannot read the pull requests of job/3: gh: not logged in' },
  );
});

function cardsRoot(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'board-markdown-cards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, CARDS_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, CARDS_DIR, name), text);
  return root;
}

test('readCards lists the cards in number order, and an absent folder is an empty board', (t) => {
  const root = cardsRoot(t, {
    '10.md': lines('# Ten', '', 'Status: Backlog', 'Kind: docs', 'Workstream: Platform', 'Parent: 2'),
    '2.md': WELL_FORMED.replaceAll('Parent: 3\nBlocked by: 4, 5\n', ''),
  });

  const cards = readCards(root);

  assert.deepEqual([...cards.keys()], [2, 10]);
  assert.equal(cards.get(10).title, 'Ten');
  assert.deepEqual(readCards(join(root, 'nowhere')), new Map());
});

test('readCards refuses anything in the folder that is not a card file, naming it', (t) => {
  const valid = lines('# T', '', 'Status: Ready', 'Kind: bug', 'Workstream: Product');
  const refusals = [
    ['notes.txt', 'a file with another name'],
    ['01.md', 'a file with another name'],
    ['0.md', 'a file with another name'],
    ['9007199254740992.md', 'a card number beyond the safe integers'],
    ['9007199254740993.md', 'a card number beyond the safe integers'],
  ];
  for (const [name, found] of refusals) {
    const root = cardsRoot(t, { '1.md': valid, [name]: valid });
    assert.throws(
      () => readCards(root),
      { message: `.agents/cards/${name}: only regular files named <N>.md, N a positive safe integer with no leading zero, belong in .agents/cards; found ${found}` },
      name,
    );
  }
  const root = cardsRoot(t, { '1.md': valid });
  mkdirSync(join(root, CARDS_DIR, '2.md'));
  assert.throws(() => readCards(root), { message: /^\.agents\/cards\/2\.md: only regular files named .*; found a directory$/ });
});

test('readCards refuses a Parent or a blocker that names no card, naming the line', (t) => {
  const plain = lines('# T', '', 'Status: Ready', 'Kind: bug', 'Workstream: Product');
  const withField = (field) => `${plain}${field}\n`;
  assert.throws(
    () => readCards(cardsRoot(t, { '2.md': withField('Parent: 9') })),
    { message: '.agents/cards/2.md:6: Parent names card 9, which has no file in .agents/cards' },
  );
  assert.throws(
    () => readCards(cardsRoot(t, { '1.md': plain, '2.md': withField('Blocked by: 1, 9') })),
    { message: '.agents/cards/2.md:6: Blocked by names card 9, which has no file in .agents/cards' },
  );
});

test('readCards stops the whole read on one corrupt card, naming the file and line', (t) => {
  const valid = lines('# T', '', 'Status: Ready', 'Kind: bug', 'Workstream: Product');
  const root = cardsRoot(t, { '1.md': valid, '2.md': valid.replace('Kind: bug', 'Kind: chore') });
  assert.throws(() => readCards(root), { message: /^\.agents\/cards\/2\.md:4: Kind must be one of / });
});

test('containCards refuses a cards folder or a parent that is a link and passes an absent folder', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-markdown-contain-'));
  const outside = mkdtempSync(join(tmpdir(), 'board-markdown-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  assert.doesNotThrow(() => containCards(root, `${CARDS_DIR}/1.md`));
  mkdirSync(join(root, '.agents'));
  symlinkSync(outside, join(root, CARDS_DIR), 'junction');
  assert.throws(() => containCards(root, `${CARDS_DIR}/1.md`), { message: /is a symlink/ });
});

test('markdownCardDetails gives each requested card its body, parent, comments and branch claim', () => {
  const cards = new Map([
    [1, card(1, { body: 'Do it\nnow', comments: [{ heading: 'host-a', text: 'First' }, { heading: 'host-b', text: '' }] })],
    [2, card(2, { parent: 1 })],
    [3, card(3)],
    [4, card(4)],
  ]);
  const refs = { local: new Map([[1, null], [2, null]]), remote: new Map([[2, OID], [3, OID]]) };

  const details = markdownCardDetails(cards, [1, 2, 3, 4], refs);

  assert.deepEqual(details.get(1), {
    number: 1,
    body: 'Do it\nnow',
    parent: null,
    comments: ['host-a\nFirst', 'host-b'],
    commentCount: 2,
    commentsUnavailable: null,
    claim: 'branch job/1 (local)',
  });
  assert.equal(details.get(2).parent, 1);
  assert.deepEqual([2, 3, 4].map((n) => details.get(n).claim), ['branch job/2 (local and origin)', 'branch job/3 (origin)', 'none']);
  assert.deepEqual([...markdownCardDetails(cards, [3], refs).keys()], [3]);
});

const publication = (...cards) => new Map(cards.map((entry) => [entry.number, entry]));

test('verifyMarkdownPublication verifies fields, kind and children from the card files, and names a missing card file', () => {
  const cards = publication(card(7), card(8, { kind: 'epic' }), card(9, { parent: 8 }), card(10, { parent: 8 }), card(11, { parent: 8 }));

  assert.deepEqual(verifyMarkdownPublication(['7'], cards), [
    'issue-publish: card files verified for #7.',
    'issue-publish: Statuses and Workstreams verified for #7.',
    'issue-publish: exactly one kind verified for #7.',
    'issue-publish: #7 verified as a standalone card; it has 0 child cards (none supplied; pass them as arguments to verify an Epic).',
  ]);
  assert.deepEqual(verifyMarkdownPublication(['8'], cards).at(-1),
    'issue-publish: #8 verified as a standalone card; it has 3 child cards (none supplied; pass them as arguments to verify an Epic).');
  assert.deepEqual(verifyMarkdownPublication(['8', '9', '10', '11'], cards), [
    'issue-publish: card files verified for #8, #9, #10, #11.',
    'issue-publish: Statuses and Workstreams verified for #8, #9, #10, #11.',
    'issue-publish: exactly one kind verified for #8, #9, #10, #11.',
    'issue-publish: child card set verified: #8 has exactly the 3 supplied child cards.',
  ]);
  assert.throws(
    () => verifyMarkdownPublication(['8', '9', '7'], cards),
    { message: 'Epic #8 child mismatch: supplied but not native children: #7; native children but not supplied: #10, #11' },
  );
  assert.throws(() => verifyMarkdownPublication(['12'], cards), { message: `#12 has no card file ${CARDS_DIR}/12.md in this checkout` });
  assert.throws(() => verifyMarkdownPublication(['8', '12'], cards), { message: `#12 has no card file ${CARDS_DIR}/12.md in this checkout` });
  assert.throws(() => verifyMarkdownPublication([], cards), { message: 'expected an issue number, optionally followed by child numbers' });
});
