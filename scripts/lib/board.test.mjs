// board.test.mjs — mutation-proof unit tests for the board read+filter+format logic.
// Run: node --test scripts/lib/   (or `npm run test:scripts`)
//
// Guards the /resume Step-1 failure mode: ad-hoc board parsing broke on shell
// quoting and silently mis-filtered. These pin the contract the CLI depends on —
// pickable = Backlog+Ready only, one fused read that carries every field the board
// rules judge a card on, fail-loud with a remedy on every malformed or truncated
// response, and the routing view carrying #, status, title and labels.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeGh } from './fake-gh.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GITHUB_TEST_CONFIG, NEEDS_PARSER, copyToolkit, flagLiterals } from './board-toolkit-copy.mjs';

const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
after(() => toolkit.cleanup());

const {
  boardReadExec,
  boardRequestKind,
  hydratedItem,
  issuesPage,
  leanBoardPage,
  leanNode,
  membership,
  membershipsPage,
  READD_WARNING,
  walkedIssue,
} = await toolkit.load('lib/board-fixtures.mjs');
const { closedNotDoneDrift } = await toolkit.load('lib/board-rules.mjs');
// The copy's own gh-exec: the board reader tells an oversized read apart by the error class its own copy exports.
const { ghExec } = await toolkit.load('lib/gh-exec.mjs');
const {
  BOARD_OWNER,
  BOARD_OWNER_TYPE,
  BOARD_PROJECT_NUMBER,
  BOARD_REPOSITORY,
  PICKABLE_STATUSES,
  ROUTING_FIELD,
  ROUTING_OPTIONS,
  STATUS_OPTIONS,
} = await toolkit.load('lib/board-config.mjs');
const board = await toolkit.load('lib/board.mjs');
// The command itself, for the approval-mode test at the end of the file.
const { main: boardMain } = await toolkit.load('board.mjs');
const {
  BOARD_HELP,
  DETAIL_BATCH_SIZE,
  cardDetailsQuery,
  fetchBoard,
  fetchCardDetails,
  intakeCardFileName,
  intakeCardFiles,
  intakeSummary,
  boardQuery,
  parseBoardArgs,
  parseBoardPage,
  parkedLine,
  pickable,
  isContentUnresolved,
  normalizeItem,
  sortForDisplay,
  formatRow,
  formatList,
  groupByRouting,
  formatGrouped,
} = board;

// A representative board spanning pickable + non-pickable columns.
const BOARD = {
  items: [
    { status: 'Ready', title: 'Funnel reader CLI', routing: 'Product',
      labels: ['type:task', 'autonomy:autonomous'], content: { number: 266 } },
    { status: 'Backlog', title: 'Review batch 5',
      labels: ['tripwire', 'plan-first'], content: { number: 264 } },
    { status: 'Done', title: 'Already done', labels: [], content: { number: 293 } },
    { status: 'In review', title: 'Mid flight', content: { number: 296 } },
  ],
};

test('pickable keeps ONLY Backlog + Ready — excludes Done / In review', () => {
  const nums = pickable(BOARD.items).map((i) => i.content.number).sort();
  assert.deepEqual(nums, [264, 266]);
  // Mutation guard: a Done item must never be pickable.
  assert.equal(pickable(BOARD.items).some((i) => i.status === 'Done'), false);
});

test("parkedLine prints nothing under this repository's own config, which parks no lane", () => {
  const laned = { status: 'Ready', lane: 'To Sebastiano', content: { number: 12 } };
  assert.equal(parkedLine([...BOARD.items, laned], parseBoardArgs([])), null);
});

test('PICKABLE_STATUSES is exactly the two draw columns', () => {
  assert.deepEqual([...PICKABLE_STATUSES].sort(), ['Backlog', 'Ready']);
});

test('parseBoardArgs: the default read, each selection, and --closeout', () => {
  assert.deepEqual(parseBoardArgs([]), { all: false, status: null, json: false, closeout: false, intake: null });
  assert.deepEqual(parseBoardArgs(['--all', '--json']), { all: true, status: null, json: true, closeout: false, intake: null });
  assert.deepEqual(parseBoardArgs(['--status=Ready']), { all: false, status: 'Ready', json: false, closeout: false, intake: null });
  assert.deepEqual(parseBoardArgs(['--closeout']), { all: false, status: null, json: false, closeout: true, intake: null });
  assert.deepEqual(parseBoardArgs(['--intake', 'out/folder']), { all: false, status: null, json: false, closeout: false, intake: 'out/folder' });
});

// #598's defect class: this command's exit code is a proof contract, so a typo must never
// be discarded into a read that then certifies the board clean — nor into a metered read
// that answers a question the operator did not ask.
test('parseBoardArgs: fails loud on an unrecognised argument or a valueless --status=', () => {
  for (const bad of ['--closout', '-closeout', '--closeout=true', '--status=', '--all=yes', 'Ready']) {
    assert.throws(
      () => parseBoardArgs([bad]),
      (err) => err.message.includes(bad) && err.message.includes('usage: node scripts/board.mjs'),
      bad,
    );
  }
  assert.throws(() => parseBoardArgs(['--json', '--verbose']), /--verbose/);
});

test('parseBoardArgs: --closeout is exclusive, --all and --status= are exclusive, and --status= may not repeat', () => {
  // --closeout prints the scan alone, so any companion flag would promise output it never
  // emits. Every pairing, so no single flag can slip through beside the proof gate.
  for (const other of ['--all', '--json', '--status=Ready']) {
    assert.throws(() => parseBoardArgs(['--closeout', other]), /--closeout takes no other argument/, other);
    assert.throws(() => parseBoardArgs([other, '--closeout']), /--closeout takes no other argument/, other);
  }
  // --all with --status= selects by --all but would label the header with the status.
  assert.throws(() => parseBoardArgs(['--all', '--status=Ready']), /--all and --status=Ready are exclusive/);
  // A repeat silently kept the FIRST, so the answer was never the question asked.
  assert.throws(
    () => parseBoardArgs(['--status=Ready', '--status=Done']),
    /only one --status= filter is allowed, got --status=Ready --status=Done/,
  );
});

test('parseBoardArgs: --intake takes one folder and no other argument', () => {
  // --intake writes into one folder and prints one fixed summary, so a missing folder, a second
  // value, a value that looks like a flag and every companion flag are refused. Both orders.
  const refused = /--intake takes one folder and no other argument — usage: node scripts\/board\.mjs/;
  assert.throws(() => parseBoardArgs(['--intake']), refused);
  assert.throws(() => parseBoardArgs(['--intake', '']), refused);
  assert.throws(() => parseBoardArgs(['--intake', 'one', 'two']), refused);
  for (const value of ['-x', '--all', '--status=Ready', '--json', '--closeout', '--intake']) {
    assert.throws(() => parseBoardArgs(['--intake', value]), refused, value);
  }
  for (const other of ['--all', '--status=Ready', '--json', '--closeout']) {
    assert.throws(() => parseBoardArgs(['--intake', 'folder', other]), refused, other);
    assert.throws(() => parseBoardArgs([other, '--intake', 'folder']), refused, other);
  }
  assert.equal(parseBoardArgs(['--intake', 'folder']).intake, 'folder');
});

test('parseBoardArgs: --help takes no other argument', () => {
  assert.deepEqual(parseBoardArgs(['--help']), { help: true });
  for (const other of ['--all', '--status=Ready', '--json', '--closeout', '--intake']) {
    assert.throws(() => parseBoardArgs(['--help', other]), /--help takes no other argument/, other);
    assert.throws(() => parseBoardArgs([other, '--help']), /--help takes no other argument/, other);
  }
  assert.throws(() => parseBoardArgs(['--approval', 'check', '1', '--help']), /--help takes no other argument/);
});

// The help is the one place an agent learns the modes, so it must name exactly the flags the
// command accepts. The accepted set is read from the real source through a parser, not from
// BOARD_FLAGS: a flag the command handles outside BOARD_FLAGS, in parseBoardArgs or in
// scripts/board.mjs, is in the set too, so a flag added without the help, or dropped from the help,
// differs here. A flag the parser stops accepting fails the parse half.
test('BOARD_HELP names exactly the flags the parser accepts, and each one parses', NEEDS_PARSER, () => {
  const accepted = [...new Set([
    ...flagLiterals(fileURLToPath(new URL('../board.mjs', import.meta.url))),
    ...flagLiterals(fileURLToPath(new URL('./board.mjs', import.meta.url)), ['parseBoardArgs', 'BOARD_FLAGS']),
  ])].sort();
  const helped = new Set(BOARD_HELP.match(/--[a-z][a-z-]*=?/g));
  assert.deepEqual([...helped].sort(), accepted);
  const validForm = {
    '--status=': ['--status=Ready'],
    '--approval': ['--approval', 'check', '1'],
    '--intake': ['--intake', 'folder'],
  };
  for (const flag of accepted) {
    assert.doesNotThrow(() => parseBoardArgs(validForm[flag] ?? [flag]), flag);
  }
});

// A pattern that accepts more than the flag it spells (`--all-items` through a group and a suffix)
// would hide an accepted flag from the help check, so the scan throws instead of reading it.
test('flagLiterals: reads a flag from `--name=` or `--name$` in a regular expression, and throws when a suffix could follow', NEEDS_PARSER, () => {
  const dir = mkdtempSync(join(tmpdir(), 'flag-literals-'));
  try {
    const grouped = join(dir, 'grouped.mjs');
    const readable = join(dir, 'readable.mjs');
    writeFileSync(grouped, 'export const accepts = (arg) => /^(--all|--json)(?:-items)?$/.test(arg);\n');
    writeFileSync(readable, 'export const accepts = (arg) => /^--status=.+$/.test(arg) || /^--all$/.test(arg);\n');
    assert.throws(() => flagLiterals(grouped), /cannot read the flags .* accepts from the regular expression .*spell each flag as a string literal/);
    assert.deepEqual(flagLiterals(readable), ['--all', '--status=']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// STATUS_OPTIONS is the board's whole column vocabulary, so a value outside it selects
// nothing — and the command would spend a metered read to report `Rady: 0 of 171
// item(s)`, an answer to a question nobody asked (the same #598 defect class the
// unrecognised-argument guard covers). Exact, never fuzzy: a near-miss the parser
// "corrected" would answer a different question just as silently.
test('parseBoardArgs: rejects a --status= value that is not a board column, and accepts every one that is', () => {
  assert.throws(
    () => parseBoardArgs(['--status=Rady']),
    (err) => err.message.includes('--status=Rady is not a board column')
      && STATUS_OPTIONS.every((column) => err.message.includes(column))
      && err.message.includes('usage: node scripts/board.mjs'),
  );
  // Case is part of the name: the board has no lower-case column.
  assert.throws(() => parseBoardArgs([`--status=${STATUS_OPTIONS[1].toLowerCase()}`]), /is not a board column/);
  for (const column of STATUS_OPTIONS) {
    assert.deepEqual(
      parseBoardArgs([`--status=${column}`]),
      { all: false, status: column, json: false, closeout: false, intake: null },
      column,
    );
  }
});

// #461: boardQuery/parseBoardPage replaced `gh project item-list` (203 GraphQL
// points/read) with a ~2-points-per-page hand-rolled query. These values come from a
// REAL captured page-1 response (2026-07-20, project 2). The shared builder supplies
// the current connection counts and queried typenames; the empty `{}` unmatched-fragment
// field values remain captured exactly, and so do the Model/Effort values the board
// still carries and this reader deliberately ignores.
const REAL_ISSUE_NODE = leanNode({
  id: 'PVTI_lAHOA50uGs4BcfoOzgx01fY',
  content: {
    __typename: 'Issue',
    number: 319,
    title: 'Move refresh() and upsertChart into their own source pieces',
    labels: [],
  },
  fieldValues: [
    {},
    { text: 'Move refresh() and upsertChart into their own source pieces', field: { name: 'Title' } },
    { name: 'Done', field: { name: 'Status' } },
    { name: 'Product', field: { name: 'Workstream' } },
    { name: 'Sonnet 5', field: { name: 'Model' } },
  ],
});
const REAL_LABELLED_NODE = leanNode({
  id: 'PVTI_lAHOA50uGs4BcfoOzgxw3wE',
  content: {
    __typename: 'Issue',
    number: 263,
    title: 'Review batch 4 — interaction/desktop breaks',
    labels: ['type:feature', 'area:ui', 'area:desktop', 'autonomy:supervised'],
    assignees: [BOARD_OWNER],
    blockers: [{ number: 261, state: 'OPEN' }, { number: 262, state: 'CLOSED' }],
    closingPullRequests: [{ number: 1133 }],
    subIssuesSummary: { total: 2, completed: 1 },
  },
  fieldValues: [
    {},
    {},
    { text: 'Review batch 4 — interaction/desktop breaks', field: { name: 'Title' } },
    { name: 'Done', field: { name: 'Status' } },
    { name: 'Opus 4.8', field: { name: 'Model' } },
    { name: 'high', field: { name: 'Effort' } },
    { name: 'Product', field: { name: 'Workstream' } },
  ],
});
// Captured before the query asked for `content { __typename }`. The typename is restored here
// because a draft is numberless BY DESIGN: without it isContentUnresolved() would call this fixture an
// unresolved read, so the canonical draft node would silently exercise the lagging-read path instead (#572).
const REAL_DRAFT_NODE = leanNode({
  id: 'PVTI_lAHOA50uGs4BcfoOzgx0mxg',
  content: { __typename: 'DraftIssue' },
  fieldValues: [
    { text: 'Trial Blacksmith CI runners (free 3k min/mo) — maybe for a future project', field: { name: 'Title' } },
    { name: 'Backlog', field: { name: 'Status' } },
    { name: 'Platform', field: { name: 'Workstream' } },
  ],
});
const BOARD_PAGE = leanBoardPage(
  [REAL_ISSUE_NODE, REAL_LABELLED_NODE, REAL_DRAFT_NODE],
  {
    pageInfo: {
      hasNextPage: true,
      endCursor: 'Y3Vyc29yOnYyOpK5MDAwMDAwMDAuMDA5MzQ1Nzk0MzkyNTIzM84Mz1dk',
    },
  },
);

// #1155: `gh api graphql --paginate` walks the pages itself, on exactly this contract —
// a declared `$endCursor` variable fed to the items connection, and ONE pageInfo it can
// find. A second pageInfo (say on labels) would have gh page the wrong connection.
test('boardQuery declares the $endCursor variable gh --paginate walks on, and carries exactly one pageInfo', () => {
  const q = boardQuery();
  assert.match(q, /^query\(\$endCursor: String\) \{/);
  assert.match(q, /items\(first:100, after:\$endCursor\)/);
  assert.equal(q.split('pageInfo').length - 1, 1);
  assert.match(q, /pageInfo \{ hasNextPage endCursor \}/);
});

test('boardQuery asks for every field the fused read carries, each capped sub-list with its totalCount', () => {
  const q = boardQuery();
  // Drop state or the summary and the epic passes fail the scan loud instead of two gh
  // calls per epic quietly coming back (#1154).
  assert.match(q, /\.\.\. on Issue \{ number title state repository \{ nameWithOwner \} subIssuesSummary \{ total completed \}/);
  assert.match(q, /labels\(first:20\) \{ totalCount nodes \{ name \} \}/);
  assert.match(q, /assignees\(first:20\) \{ totalCount nodes \{ login \} \}/);
  assert.match(q, /blockedBy\(first:20\) \{ totalCount nodes \{ number state \} \}/);
  assert.match(q, /closedByPullRequestsReferences\(first:20\) \{ totalCount nodes \{ number \} \}/);
  assert.match(q, /items\(first:100, after:\$endCursor\) \{ totalCount/);
  assert.match(q, /fieldValues\(first:20\) \{ totalCount/);
});

test('boardQuery asks for the project identity and field schema every page is checked against', () => {
  const q = boardQuery();
  assert.match(q, new RegExp(`${BOARD_OWNER_TYPE}\\(login:"${BOARD_OWNER}"\\) \\{ login`));
  assert.match(q, new RegExp(`projectV2\\(number:${BOARD_PROJECT_NUMBER}\\) \\{ id number closed`));
  assert.match(q, /fields\(first:50\) \{ totalCount nodes \{ \.\.\. on ProjectV2FieldCommon \{ name dataType \}/);
  assert.match(q, /\.\.\. on ProjectV2SingleSelectField \{ options \{ name \} \}/);
});

// #1155: the whole walk is ONE gh process. The executor is called once, with
// `--paginate --slurp` and the $endCursor query, and hands back the slurped page
// array; every walk check the page-by-page loop used to make now runs over that array.
test('fetchBoard walks the slurped pages of one gh call in order and fails loud on malformed or failed reads', () => {
  const firstPage = structuredClone(BOARD_PAGE);
  firstPage.data[BOARD_OWNER_TYPE].projectV2.items.totalCount = 2;
  firstPage.data[BOARD_OWNER_TYPE].projectV2.items.nodes = [REAL_ISSUE_NODE];
  firstPage.data[BOARD_OWNER_TYPE].projectV2.items.pageInfo = { hasNextPage: true, endCursor: 'page-one-cursor' };
  const secondPage = structuredClone(BOARD_PAGE);
  secondPage.data[BOARD_OWNER_TYPE].projectV2.items.totalCount = 2;
  secondPage.data[BOARD_OWNER_TYPE].projectV2.items.nodes = [REAL_DRAFT_NODE];
  secondPage.data[BOARD_OWNER_TYPE].projectV2.items.pageInfo = { hasNextPage: false, endCursor: null };
  const { exec, calls } = boardReadExec({ board: [firstPage, secondPage] });
  const items = fetchBoard(exec);

  assert.deepEqual(items, [
    {
      id: 'PVTI_lAHOA50uGs4BcfoOzgx01fY', status: 'Done',
      title: 'Move refresh() and upsertChart into their own source pieces',
      routing: 'Product', labels: [], assignees: [], blockers: [], closingPullRequests: [],
      content: { __typename: 'Issue', number: 319, state: 'OPEN', subIssuesSummary: { total: 0, completed: 0 } },
    },
    {
      id: 'PVTI_lAHOA50uGs4BcfoOzgx0mxg', status: 'Backlog',
      title: 'Trial Blacksmith CI runners (free 3k min/mo) — maybe for a future project',
      routing: 'Platform', labels: [], assignees: [], blockers: [], closingPullRequests: [],
      content: { __typename: 'DraftIssue' },
    },
  ]);
  assert.equal(calls.filter((args) => boardRequestKind(args) === 'board').length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ['api', 'graphql', '--paginate', '--slurp', '-f']);
  assert.equal(calls[0][5], `query=${boardQuery()}`);

  // Unslurped output: a bare page object (what a one-page board yields without --slurp)
  // or an empty walk is never a board.
  assert.throws(() => fetchBoard(() => JSON.stringify(firstPage)), /--slurp/);
  assert.throws(() => fetchBoard(() => '[]'), /--slurp/);
  assert.throws(() => fetchBoard(() => '[[]]'), /--slurp/);
  assert.throws(() => fetchBoard(() => '[{}]'), /board page/);
  assert.throws(() => fetchBoard(() => { throw new Error('offline'); }), /offline/);

  const missingCursorPage = structuredClone(firstPage);
  missingCursorPage.data[BOARD_OWNER_TYPE].projectV2.items.pageInfo.endCursor = null;
  assert.throws(
    () => fetchBoard(() => JSON.stringify([missingCursorPage, secondPage])),
    /pagination.*endCursor/,
  );
  assert.throws(
    () => fetchBoard(() => JSON.stringify([firstPage, firstPage, secondPage])),
    /pagination.*repeated.*page-one-cursor/,
  );
  // gh stopped early: the final page still points onward.
  assert.throws(
    () => fetchBoard(() => JSON.stringify([firstPage])),
    /incomplete board items read.*last page still reports hasNextPage.*rerun/i,
  );
  // A page after the one gh should have stopped on.
  assert.throws(
    () => fetchBoard(() => JSON.stringify([secondPage, secondPage])),
    /incomplete board items read.*page 1 of 2 reports no next page.*rerun/i,
  );
});

test('fetchBoard rejects a short read and accepts an exact one', () => {
  const page = ({ totalCount, nodes = [REAL_ISSUE_NODE], hasNextPage = false, endCursor = null }) =>
    leanBoardPage(nodes, { totalCount, pageInfo: { hasNextPage, endCursor } });
  const fetchPages = (...pages) => fetchBoard(boardReadExec({ board: pages }).exec);

  assert.equal(fetchPages(page({ totalCount: 1 })).length, 1);
  assert.throws(
    () => fetchPages(page({ totalCount: 2 })),
    /incomplete board items read.*2.*1.*rerun/i,
  );

  assert.throws(
    () => fetchPages(
      page({ totalCount: 2, hasNextPage: true, endCursor: 'next' }),
      page({ totalCount: 3, nodes: [REAL_DRAFT_NODE] }),
    ),
    /incomplete board items read.*totalCount.*2.*3.*rerun/i,
  );
});

// Guard 6: the walk must be one project's, read against one field schema. A page
// answered for a different project, or read after the Status/routing options changed
// mid-walk, is two half-boards spliced together — every rule downstream would judge
// cards against a schema the read never saw whole.
test('fetchBoard throws when the project identity or the field schema changes across pages', () => {
  const first = leanBoardPage([REAL_ISSUE_NODE], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' } });
  const second = leanBoardPage([REAL_DRAFT_NODE], { totalCount: 2 });
  const fetchPages = (...pages) => fetchBoard(boardReadExec({ board: pages }).exec);

  assert.equal(fetchPages(first, second).length, 2);

  const otherProject = structuredClone(second);
  otherProject.data[BOARD_OWNER_TYPE].projectV2.id = 'PVT_someone_else';
  assert.throws(() => fetchPages(first, otherProject), /project identity changed across pages.*rerun/i);

  // A field added mid-walk: the per-page schema guard passes it (it is neither Status
  // nor the routing field), so only the across-pages comparison can see it.
  const otherSchema = structuredClone(second);
  otherSchema.data[BOARD_OWNER_TYPE].projectV2.fields.nodes.push({ name: 'Notes', dataType: 'TEXT' });
  otherSchema.data[BOARD_OWNER_TYPE].projectV2.fields.totalCount += 1;
  assert.throws(() => fetchPages(first, otherSchema), /field schema changed across pages.*rerun/i);
});

// ── cards the project listing omits ─────────────────────────────────────────
// GitHub's project item list can leave out a card that is on the board (#504), so the read also
// walks the repository's issues in both states, each with its project memberships, and reads by id
// each unarchived membership on this board the listing lacked. Every expectation below is written
// by hand from the fixtures: an unarchived membership on this board is a card exactly once, and
// nothing else is.

const RECOVERY_LISTED = leanNode({
  id: 'PVTI_listed',
  content: { __typename: 'Issue', number: 10, title: 'Listed card' },
  status: 'Ready',
  routing: 'Product',
});

const omittedCard = (id, number, state, status) => ({
  id,
  content: { __typename: 'Issue', number, title: `Omitted card ${number}`, state },
  status,
  routing: 'Platform',
});

// Memberships of one issue on other projects, enough of them to push its board membership past
// the walk's first page of 100.
const elsewhere = (count, from = 0) =>
  Array.from({ length: count }, (_, i) => membership(`PVTI_elsewhere_${from + i}`, { project: 1000 + from + i }));

const sortedById = (items) => [...items].sort((a, b) => a.id.localeCompare(b.id));
const escapeForPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesId = (text, id) => new RegExp(`${escapeForPattern(id)}(?![\\w-])`).test(text);
const namesNumber = (text, number) => new RegExp(`#${number}(?!\\d)`).test(text);

test('ANTI-REGRESSION: board reads recover independently visible GitHub cards', () => {
  const draft = leanNode({ id: 'PVTI_listed_draft', content: { __typename: 'DraftIssue' }, title: 'draft note', status: 'Backlog', routing: 'Product' });
  const unresolved = leanNode({ id: 'PVTI_listed_unresolved', content: null, status: 'Backlog', routing: 'Product' });
  const recovered = [
    omittedCard('PVTI_open_backlog', 11, 'OPEN', 'Backlog'),
    omittedCard('PVTI_closed_done', 12, 'CLOSED', 'Done'),
    omittedCard('PVTI_closed_backlog', 13, 'CLOSED', 'Backlog'),
    omittedCard('PVTI_overflow', 15, 'OPEN', 'Ready'),
  ];
  const advisories = [];
  const { exec, calls } = boardReadExec({
    board: [leanBoardPage([RECOVERY_LISTED, draft, unresolved])],
    issues: [
      issuesPage([
        walkedIssue(10, [membership('PVTI_listed')]),
        walkedIssue(11, [membership('PVTI_open_backlog')]),
        walkedIssue(12, [
          membership('PVTI_closed_done'),
          membership('PVTI_other_project', { project: BOARD_PROJECT_NUMBER + 1 }),
          membership('PVTI_other_owner', { owner: 'someone-else' }),
        ]),
      ], { totalCount: 6, pageInfo: { hasNextPage: true, endCursor: 'issues-1' } }),
      issuesPage([
        walkedIssue(13, [membership('PVTI_closed_backlog')]),
        walkedIssue(14, [membership('PVTI_archived', { isArchived: true })]),
        walkedIssue(15, elsewhere(100), { totalCount: 101 }),
      ], { totalCount: 6 }),
    ],
    memberships: {
      15: [
        membershipsPage(15, elsewhere(100), { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'members-1' } }),
        membershipsPage(15, [membership('PVTI_overflow')], { totalCount: 101 }),
      ],
    },
    // Every item the walk names is readable, so leaving one out is the reader's own decision.
    items: [
      hydratedItem(RECOVERY_LISTED),
      ...recovered.map((card) => hydratedItem(card)),
      hydratedItem(omittedCard('PVTI_archived', 14, 'CLOSED', 'Done'), { isArchived: true }),
      hydratedItem(omittedCard('PVTI_other_project', 12, 'CLOSED', 'Done'), { project: BOARD_PROJECT_NUMBER + 1 }),
      hydratedItem(omittedCard('PVTI_other_owner', 12, 'CLOSED', 'Done'), { owner: 'someone-else' }),
    ],
  });

  const items = fetchBoard(exec, { onOmission: (advisory) => advisories.push(advisory) });

  // The listed card once though the walk found it too, the draft and the unresolved card kept, the
  // open, closed and past-the-first-page cards recovered, and the archived and other-board items left out.
  assert.deepEqual(sortedById(items).map((i) => [i.id, i.content.number ?? null, i.status, i.content.state ?? null]), [
    ['PVTI_closed_backlog', 13, 'Backlog', 'CLOSED'],
    ['PVTI_closed_done', 12, 'Done', 'CLOSED'],
    ['PVTI_listed', 10, 'Ready', 'OPEN'],
    ['PVTI_listed_draft', null, 'Backlog', null],
    ['PVTI_listed_unresolved', null, 'Backlog', null],
    ['PVTI_open_backlog', 11, 'Backlog', 'OPEN'],
    ['PVTI_overflow', 15, 'Ready', 'OPEN'],
  ]);
  // A recovered card is the same raw item a listed one is, so every board rule reads it alike.
  const closedInBacklog = items.find((i) => i.id === 'PVTI_closed_backlog');
  assert.deepEqual(closedInBacklog, {
    id: 'PVTI_closed_backlog', status: 'Backlog', title: 'Omitted card 13', routing: 'Platform',
    labels: [], assignees: [], blockers: [], closingPullRequests: [],
    content: { __typename: 'Issue', number: 13, state: 'CLOSED', subIssuesSummary: { total: 0, completed: 0 } },
  });
  assert.equal(closedNotDoneDrift(normalizeItem(closedInBacklog)).reason, 'issue closed but card still in "Backlog" (not Done)');
  assert.equal(closedNotDoneDrift(normalizeItem(items.find((i) => i.id === 'PVTI_closed_done'))), null);

  assert.equal(advisories.length, 1, advisories.join('\n'));
  const [advisory] = advisories;
  assert.equal(typeof advisory, 'string');
  for (const card of recovered) {
    assert.ok(namesNumber(advisory, card.content.number), advisory);
    assert.ok(namesId(advisory, card.id), advisory);
  }
  for (const id of ['PVTI_listed', 'PVTI_listed_draft', 'PVTI_listed_unresolved', 'PVTI_archived', 'PVTI_other_project', 'PVTI_other_owner']) {
    assert.equal(namesId(advisory, id), false, `${id}: ${advisory}`);
  }
  for (const number of [10, 14]) assert.equal(namesNumber(advisory, number), false, advisory);
  assert.match(advisory, READD_WARNING);

  // The walk asks for open AND closed issues and their archived memberships, in one paginated process.
  const issueWalks = calls.filter((args) => boardRequestKind(args) === 'issues');
  assert.equal(issueWalks.length, 1);
  assert.ok(issueWalks[0].includes('--paginate') && issueWalks[0].includes('--slurp'), issueWalks[0].join(' '));
  const issueQuery = issueWalks[0].find((arg) => arg.startsWith('query='));
  assert.match(issueQuery, /states:\s*\[\s*OPEN\s*,\s*CLOSED\s*\]/);
  assert.match(issueQuery, /includeArchived:\s*true/);
  assert.equal(boardRequestKind(calls[0]), 'board');

  // Nothing omitted: the listing stands as read, and no advisory is raised.
  const quiet = [];
  const listedOnly = boardReadExec({
    board: [leanBoardPage([RECOVERY_LISTED, draft])],
    issues: [issuesPage([walkedIssue(10, [membership('PVTI_listed')])])],
  });
  assert.deepEqual(
    sortedById(fetchBoard(listedOnly.exec, { onOmission: (advisory) => quiet.push(advisory) })).map((i) => i.id),
    ['PVTI_listed', 'PVTI_listed_draft'],
  );
  assert.deepEqual(quiet, []);
});

// One card listed (#10), one omitted (#11) and one omitted past the first page of 100
// memberships (#12, its board membership the first one the walk saw): the read the refusal
// cases below each break one fact of.
function recoveryBase() {
  const firstObservation = [membership('PVTI_overflow'), ...elsewhere(99)];
  return {
    board: [leanBoardPage([RECOVERY_LISTED])],
    issues: [
      issuesPage([
        walkedIssue(10, [membership('PVTI_listed')]),
        walkedIssue(11, [membership('PVTI_omitted')]),
      ], { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'issues-1' } }),
      issuesPage([walkedIssue(12, firstObservation, { totalCount: 101 })], { totalCount: 3 }),
    ],
    memberships: {
      12: [
        membershipsPage(12, structuredClone(firstObservation), { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'members-1' } }),
        membershipsPage(12, elsewhere(1, 99), { totalCount: 101 }),
      ],
    },
    items: [
      hydratedItem(omittedCard('PVTI_omitted', 11, 'OPEN', 'Backlog')),
      hydratedItem(omittedCard('PVTI_overflow', 12, 'OPEN', 'Ready')),
    ],
  };
}

const walked = (base, page, index) => base.issues[page].data.repository.issues.nodes[index];
const issuesOf = (base, page) => base.issues[page].data.repository.issues;
const overflowPage = (base, page) => base.memberships[12][page].data.repository.issue;
const failing = () => { throw new Error('gh: HTTP 502'); };

const REFUSED_RECOVERY = [
  // Malformed, failed and null replies.
  ['the issue walk is not JSON', (b) => { b.issues = 'not json'; }],
  ['the issue walk is not slurped', (b) => { b.issues = b.issues[0]; }],
  ['the issue walk is empty', (b) => { b.issues = []; }],
  ['the issue walk fails', (b) => { b.issues = failing; }],
  ['an issue walk page carries GraphQL errors', (b) => { b.issues[1] = { errors: [{ message: 'Something went wrong' }] }; }],
  ['an issue walk page is null', (b) => { b.issues[1] = null; }],
  ['an issue walk page has a null repository', (b) => { b.issues[1].data.repository = null; }],
  ['an issue walk page has no issues connection', (b) => { b.issues[1].data.repository.issues = null; }],
  ['a walked issue is null', (b) => { issuesOf(b, 0).nodes[1] = null; }],
  ['a walked issue has no number', (b) => { walked(b, 0, 1).number = null; }],
  ['a walked issue has no membership connection', (b) => { walked(b, 0, 1).projectItems = null; }],
  ['a membership is null', (b) => { walked(b, 0, 1).projectItems.nodes = [null]; }],
  ['a membership has no project', (b) => { walked(b, 0, 1).projectItems.nodes[0].project = null; }],
  ['a membership has no project owner', (b) => { walked(b, 0, 1).projectItems.nodes[0].project.owner = null; }],
  ['a membership has no id', (b) => { walked(b, 0, 1).projectItems.nodes[0].id = null; }],
  ['a membership archive flag is not a boolean', (b) => { walked(b, 0, 1).projectItems.nodes[0].isArchived = 'false'; }],
  ['a membership has project number 0', (b) => { walked(b, 0, 1).projectItems.nodes[0].project.number = 0; }],
  ['a membership has a negative project number', (b) => { walked(b, 0, 1).projectItems.nodes[0].project.number = -1; }],
  ['a membership has a blank project owner login', (b) => { walked(b, 0, 1).projectItems.nodes[0].project.owner.login = '   '; }],
  ['the item read fails', (b) => { b.items = failing; }],
  ['the item read carries GraphQL errors', (b) => { b.items = { errors: [{ message: 'Something went wrong' }] }; }],
  ['the item read answers no node list', (b) => { b.items = { data: { nodes: null } }; }],
  ['the item read answers null for an item', (b) => { b.items = [b.items[1]]; }],
  ['the overflow walk fails', (b) => { b.memberships[12] = failing; }],
  ['the overflow walk answers no issue', (b) => { b.memberships[12] = [{ data: { repository: { issue: null } } }]; }],
  // Truncated walks.
  ['the issue walk stops while a page remains', (b) => { b.issues = [b.issues[0]]; }],
  ['the issue walk continues past a page with no next page', (b) => { issuesOf(b, 0).pageInfo = { hasNextPage: false, endCursor: null }; }],
  ['an issue walk page reports a next page with no cursor', (b) => { issuesOf(b, 0).pageInfo.endCursor = null; }],
  ['the issue walk fetches fewer issues than its count', (b) => { issuesOf(b, 0).totalCount = 4; issuesOf(b, 1).totalCount = 4; }],
  ['a walked issue holds fewer memberships than its count under the cap', (b) => { walked(b, 0, 1).projectItems.totalCount = 2; }],
  ['a walked issue holds more memberships than its count', (b) => { walked(b, 0, 1).projectItems.totalCount = 0; }],
  ['the overflow walk stops while a page remains', (b) => { b.memberships[12] = [b.memberships[12][0]]; }],
  ['the overflow walk fetches fewer memberships than its count', (b) => { overflowPage(b, 1).projectItems.nodes = []; }],
  ['the project walk is short of its count however many cards recovery finds', (b) => { b.board = [leanBoardPage([RECOVERY_LISTED], { totalCount: 3 })]; }],
  // Repeated cursors.
  ['the issue walk repeats a cursor', (b) => {
    b.issues.splice(1, 0, issuesPage([], { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'issues-1' } }));
  }],
  ['the overflow walk repeats a cursor', (b) => {
    b.memberships[12].splice(1, 0, membershipsPage(12, [], { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'members-1' } }));
  }],
  // Counts that change.
  ['the issue count changes across pages', (b) => { issuesOf(b, 1).totalCount = 4; }],
  ['the overflow membership count changes across pages', (b) => { overflowPage(b, 1).projectItems.totalCount = 102; }],
  ['the overflow walk counts differently from the first observation', (b) => {
    for (const page of [0, 1]) overflowPage(b, page).projectItems.totalCount = 102;
    overflowPage(b, 1).projectItems.nodes.push(membership('PVTI_elsewhere_extra', { project: 2000 }));
  }],
  ['the overflow walk loses the board membership the first observation saw', (b) => {
    overflowPage(b, 0).projectItems.nodes[0] = membership('PVTI_elsewhere_swapped', { project: 3000 });
  }],
  ['the overflow walk answers for another issue', (b) => { for (const page of [0, 1]) overflowPage(b, page).number = 13; }],
  // Duplicate and conflicting identities.
  ['an issue is walked twice', (b) => {
    issuesOf(b, 1).nodes.push(walkedIssue(11, [membership('PVTI_omitted')]));
    for (const page of [0, 1]) issuesOf(b, page).totalCount = 4;
  }],
  ['one item id is walked under two issues', (b) => {
    issuesOf(b, 1).nodes.push(walkedIssue(13, [membership('PVTI_omitted')]));
    for (const page of [0, 1]) issuesOf(b, page).totalCount = 4;
  }],
  ['one item id is listed twice under one issue', (b) => {
    walked(b, 0, 1).projectItems = { totalCount: 2, nodes: [membership('PVTI_omitted'), membership('PVTI_omitted')] };
  }],
  ['one issue holds two items on this board', (b) => {
    walked(b, 0, 1).projectItems = { totalCount: 2, nodes: [membership('PVTI_omitted'), membership('PVTI_omitted_twin')] };
    b.items.push(hydratedItem(omittedCard('PVTI_omitted_twin', 11, 'OPEN', 'Backlog')));
  }],
  ['the listed item is walked under another issue', (b) => {
    walked(b, 0, 0).projectItems = { totalCount: 0, nodes: [] };
    walked(b, 0, 1).projectItems = { totalCount: 2, nodes: [membership('PVTI_omitted'), membership('PVTI_listed')] };
  }],
  // The overflow walk alone holds every id once, so only the first page can show the repeat.
  ['one item id is listed twice in an overflowing first page', (b) => {
    const firstPage = walked(b, 1, 0).projectItems.nodes;
    firstPage[99] = structuredClone(firstPage[98]);
  }],
  ['the item read answers one item twice', (b) => { b.items = { data: { nodes: [b.items[0], b.items[0]] } }; }],
  ['the item read answers another item id', (b) => { b.items = { data: { nodes: [{ ...b.items[0], id: 'PVTI_someone_else' }, b.items[1]] } }; }],
  // Wrong repository, project or content.
  ['a read item belongs to another repository', (b) => { b.items[0].content.repository = { nameWithOwner: 'someone-else/other-repo' }; }],
  ['a read item is on another project', (b) => { b.items[0].project.number = BOARD_PROJECT_NUMBER + 1; }],
  ["a read item is on another owner's project", (b) => { b.items[0].project.owner.login = 'someone-else'; }],
  ['the listed item is walked on another project', (b) => { walked(b, 0, 0).projectItems.nodes[0].project.number = BOARD_PROJECT_NUMBER + 1; }],
  ["the listed item is walked on another owner's project", (b) => { walked(b, 0, 0).projectItems.nodes[0].project.owner.login = 'someone-else'; }],
  ['a read item has no project', (b) => { b.items[0].project = null; }],
  ['a read item resolves to another issue', (b) => { b.items[0].content.number = 99; }],
  ['a read item has no issue content', (b) => { b.items[0].content = null; }],
  // Archive observations that disagree.
  ['a read item is archived though its membership is not', (b) => { b.items[0].isArchived = true; }],
  ['the overflow walk sees the board membership archived', (b) => { overflowPage(b, 0).projectItems.nodes[0].isArchived = true; }],
  ['a listed card is archived on its issue', (b) => { walked(b, 0, 0).projectItems.nodes[0].isArchived = true; }],
];

test('ANTI-REGRESSION: board reads refuse inconsistent recovery evidence', () => {
  assert.doesNotThrow(() => fetchBoard(boardReadExec(recoveryBase()).exec));
  for (const [label, breakRead] of REFUSED_RECOVERY) {
    const base = recoveryBase();
    breakRead(base);
    assert.throws(
      () => fetchBoard(boardReadExec(base).exec),
      (error) => {
        // A request the fixture never expected is a broken test, not a refusal by the reader.
        assert.doesNotMatch(error.message, /unexpected gh invocation/, label);
        return true;
      },
      label,
    );
  }
  // The unbroken read is what each case departs from, so it has to be accepted whole.
  assert.deepEqual(sortedById(fetchBoard(boardReadExec(recoveryBase()).exec)).map((i) => [i.id, i.content.number]), [
    ['PVTI_listed', 10],
    ['PVTI_omitted', 11],
    ['PVTI_overflow', 12],
  ]);
});

test('parseBoardPage maps a fully-fielded issue card to the exact raw shape', () => {
  const { items } = parseBoardPage(BOARD_PAGE);
  assert.deepEqual(items[0], {
    id: 'PVTI_lAHOA50uGs4BcfoOzgx01fY',
    status: 'Done',
    title: 'Move refresh() and upsertChart into their own source pieces',
    routing: 'Product',
    labels: [],
    assignees: [],
    blockers: [],
    closingPullRequests: [],
    content: { __typename: 'Issue', number: 319, state: 'OPEN', subIssuesSummary: { total: 0, completed: 0 } },
  });
});

test('parseBoardPage carries labels, assignees, blockers and closing pull requests through one read', () => {
  const { items } = parseBoardPage(BOARD_PAGE);
  assert.deepEqual(items[1], {
    id: 'PVTI_lAHOA50uGs4BcfoOzgxw3wE',
    status: 'Done',
    title: 'Review batch 4 — interaction/desktop breaks',
    routing: 'Product',
    labels: ['type:feature', 'area:ui', 'area:desktop', 'autonomy:supervised'],
    assignees: [BOARD_OWNER],
    blockers: [{ number: 261, state: 'OPEN' }, { number: 262, state: 'CLOSED' }],
    closingPullRequests: [{ number: 1133 }],
    content: { __typename: 'Issue', number: 263, state: 'OPEN', subIssuesSummary: { total: 2, completed: 1 } },
  });
  // The normalized card keeps only the OPEN blockers: a closed blocker blocks nothing.
  assert.deepEqual(normalizeItem(items[1]).openBlockers, [261]);
});

test('parseBoardPage carries a draft\'s __typename through with the Title fieldValue text fallback (no content.number)', () => {
  const { items } = parseBoardPage(BOARD_PAGE);
  assert.deepEqual(items[2], {
    id: 'PVTI_lAHOA50uGs4BcfoOzgx0mxg',
    status: 'Backlog',
    title: 'Trial Blacksmith CI runners (free 3k min/mo) — maybe for a future project',
    routing: 'Platform',
    labels: [],
    assignees: [],
    blockers: [],
    closingPullRequests: [],
    content: { __typename: 'DraftIssue' },
  });
  // Feeds normalizeItem exactly like a real board item: no linked issue → null number. The typename
  // is what keeps that numberlessness a DESIGN fact rather than an unresolved read (#572).
  assert.equal(normalizeItem(items[2]).number, null);
  assert.equal(isContentUnresolved(items[2]), false);
});

// NOT guards, deliberately: this board legitimately holds draft cards, pull-request
// cards, and cards an item-add left with no Status and no routing value. They are
// reported as drift rows downstream, so a parser that threw on them would strand
// every session instead.
test('parseBoardPage accepts the numberless and unfielded cards this board legitimately holds', () => {
  const { items } = parseBoardPage(leanBoardPage([
    leanNode({ id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, title: 'a draft note', status: 'Backlog', routing: 'Product' }),
    leanNode({ id: 'PVTI_pr', content: { __typename: 'PullRequest' }, title: 'a pull request card', status: 'Ready', routing: 'Product' }),
    leanNode({ id: 'PVTI_no_status', content: { __typename: 'Issue', number: 11, title: 'no status' }, routing: 'Product' }),
    leanNode({ id: 'PVTI_no_routing', content: { __typename: 'Issue', number: 12, title: 'no routing' }, status: 'Ready' }),
  ]));

  assert.deepEqual(items.map((i) => [i.id, i.status, i.routing]), [
    ['PVTI_draft', 'Backlog', 'Product'],
    ['PVTI_pr', 'Ready', 'Product'],
    ['PVTI_no_status', null, 'Product'],
    ['PVTI_no_routing', 'Ready', null],
  ]);
});

test('fixture keeps unresolved content null until the board parser normalizes it', () => {
  const unresolvedNode = leanNode({ id: 'PVTI_unresolved', content: null, status: 'In progress' });

  assert.equal(unresolvedNode.content, null);
  const { items } = parseBoardPage(leanBoardPage([unresolvedNode]));
  assert.deepEqual(items[0].content, {});
  assert.equal(isContentUnresolved(items[0]), true);
});

test('fixture rejects explicit field values mixed with named field shorthands', () => {
  assert.throws(
    () => leanNode({ fieldValues: [], status: 'Ready' }),
    /either fieldValues or named field shorthands/,
  );
});

test('parseBoardPage passes pageInfo through as hasNextPage/endCursor', () => {
  const page = parseBoardPage(BOARD_PAGE);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, 'Y3Vyc29yOnYyOpK5MDAwMDAwMDAuMDA5MzQ1Nzk0MzkyNTIzM84Mz1dk');
  assert.equal(page.totalCount, 3);
});

// One numbered issue card, fully fielded — the base every guard test below mutates
// into the malformed shape it is about.
const guardNode = (content = {}, node = {}) => leanNode({
  id: 'PVTI_guard',
  content: { __typename: 'Issue', number: 9, title: 'a card', ...content },
  status: 'Ready',
  routing: 'Product',
  ...node,
});
const parseNodes = (...nodes) => parseBoardPage(leanBoardPage(nodes));
const parseMutated = (mutate, nodes = [guardNode()]) => {
  const page = leanBoardPage(nodes);
  mutate(page.data[BOARD_OWNER_TYPE].projectV2, page.data[BOARD_OWNER_TYPE], page);
  return parseBoardPage(page);
};

// Guard 1. A read that came back as anything but one GraphQL data object is a failed
// read, and must never be parsed into a small board.
test('parseBoardPage throws on unparseable JSON, on a non-object, and on a response carrying GraphQL errors', () => {
  assert.throws(() => parseBoardPage('{not json'), /board page JSON could not be parsed.*rerun the board read/s);
  assert.throws(() => parseBoardPage('"a string"'), /board page.*not a GraphQL data object.*rerun the board read/s);
  assert.throws(() => parseBoardPage(null), /board page.*not a GraphQL data object.*rerun the board read/s);
  assert.throws(() => parseBoardPage({ data: null }), new RegExp(`board page carried no ${BOARD_OWNER_TYPE} data.*rerun the board read`, 's'));
  assert.throws(
    () => parseBoardPage({ errors: [{ message: 'Could not resolve to a User' }] }),
    /board read returned GraphQL errors: Could not resolve to a User/,
  );
});

// Guard 2. `totalCount` is the only evidence a connection came back whole, so a
// missing or non-integer one is a broken read, never a pass.
test('parseBoardPage throws when a connection has no integer totalCount or no nodes array', () => {
  for (const broken of [undefined, '1', -1, 1.5, null]) {
    assert.throws(
      () => parseMutated((project) => { project.items.totalCount = broken; }),
      /malformed items connection.*integer totalCount.*rerun the board read/s,
    );
  }
  assert.throws(
    () => parseMutated((project) => { project.items.nodes = null; }),
    /malformed items connection.*nodes\[\] array.*rerun the board read/s,
  );
  assert.throws(
    () => parseNodes(guardNode({ labels: { totalCount: '2', nodes: [] } })),
    /malformed labels connection.*integer totalCount/s,
  );
  assert.throws(
    () => parseMutated((project) => { project.fields.totalCount = undefined; }),
    /malformed project fields connection.*integer totalCount/s,
  );
});

// Guard 3. A card with more labels/assignees/blockers/closing references than the
// `first:` cap would otherwise be silently narrowed (#464 review) — and a dropped
// closing reference would make an in-flight claim read as stalled.
test('parseBoardPage throws when any capped sub-list is truncated, naming the cap to raise', () => {
  const truncated = (make) => ({ totalCount: 25, nodes: Array.from({ length: 20 }, (_, i) => make(i)) });
  const cases = [
    ['labels', guardNode({ labels: truncated((i) => ({ name: `l${i}` })) })],
    ['assignees', guardNode({ assignees: truncated((i) => ({ login: `u${i}` })) })],
    ['blockedBy', guardNode({ blockers: truncated((i) => ({ number: i + 1, state: 'OPEN' })) })],
    ['closedByPullRequestsReferences', guardNode({ closingPullRequests: truncated((i) => ({ number: i + 1 })) })],
  ];
  for (const [what, node] of cases) {
    assert.throws(
      () => parseNodes(node),
      new RegExp(`board item PVTI_guard has 25 ${what} but only 20 fetched — raise the ${what} first: cap in boardQuery`),
    );
  }

  const fieldValuesNode = guardNode();
  fieldValuesNode.fieldValues = { totalCount: 25, nodes: fieldValuesNode.fieldValues.nodes };
  assert.throws(() => parseNodes(fieldValuesNode), /has 25 fieldValues but only 2 fetched.*raise the fieldValues first: cap in boardQuery/);

  // Exactly at the cap → fine.
  const full = { totalCount: 20, nodes: Array.from({ length: 20 }, (_, i) => ({ name: `l${i}` })) };
  assert.equal(parseNodes(guardNode({ labels: full })).items[0].labels.length, 20);
});

// Guard 3b. The capped sub-lists are fetched WHOLE, so the count and the nodes must
// agree in BOTH directions. A totalCount SMALLER than the nodes returned is an
// under-reporting response, and it is not harmless: a closing reference arriving under
// `totalCount: 0` comes from a response that contradicts itself, and closing references
// are what decide whether an in-flight claim reads as stalled.
test('parseBoardPage throws when a capped sub-list reports FEWER than the nodes it carries', () => {
  const cases = [
    ['closedByPullRequestsReferences', 0, 1, guardNode({
      closingPullRequests: { totalCount: 0, nodes: [{ number: 1133 }] },
    })],
    ['labels', 1, 2, guardNode({
      labels: { totalCount: 1, nodes: [{ name: 'type:task' }, { name: 'plan-first' }] },
    })],
  ];
  for (const [what, totalCount, fetched, node] of cases) {
    assert.throws(
      () => parseNodes(node),
      new RegExp(
        `board item PVTI_guard returned ${fetched} ${what} but reports totalCount ${totalCount}.*rerun the board read`,
        's',
      ),
      what,
    );
  }
});

// Guard 3c. gh --paginate decides whether to ask for another page from this pair alone,
// so a coerced one is a page decision made on a malformed value: a string "false" reads
// as true, a missing hasNextPage as false, and either silently truncates or loops the
// walk. A next page also has to say WHERE, so hasNextPage without a usable cursor is a
// broken read rather than a walk that quietly stops.
test('parseBoardPage throws on a non-boolean hasNextPage and on a next page with no usable cursor', () => {
  for (const bad of ['true', 'false', 1, 0, null, undefined]) {
    assert.throws(
      () => parseMutated((project) => { project.items.pageInfo = { hasNextPage: bad, endCursor: 'c1' }; }),
      /board page pagination carried no boolean hasNextPage.*rerun the board read/s,
      String(bad),
    );
  }
  assert.throws(
    () => parseMutated((project) => { delete project.items.pageInfo; }),
    /board page pagination carried no boolean hasNextPage/,
  );
  for (const cursor of [null, undefined, '', '   ', 7]) {
    assert.throws(
      () => parseMutated((project) => { project.items.pageInfo = { hasNextPage: true, endCursor: cursor }; }),
      /board page pagination reports hasNextPage without a non-empty endCursor.*rerun the board read/s,
      String(cursor),
    );
  }
  // The final page legitimately carries a null cursor.
  const last = parseMutated((project) => { project.items.pageInfo = { hasNextPage: false, endCursor: null }; });
  assert.equal(last.hasNextPage, false);
  assert.equal(last.endCursor, null);
});

// Guard 4. A single-select field holds one value per card. Two would make which one
// the reader picked an accident of node order.
test('parseBoardPage throws on a duplicate Status or routing value on one card', () => {
  const duplicated = (name) => leanNode({
    id: 'PVTI_guard',
    content: { __typename: 'Issue', number: 9, title: 'a card' },
    fieldValues: [
      { name: name === 'Status' ? 'Ready' : 'Product', field: { name } },
      { name: name === 'Status' ? 'Backlog' : 'Platform', field: { name } },
    ],
  });
  assert.throws(() => parseNodes(duplicated('Status')), /board item PVTI_guard carried 2 "Status" values.*one value per card/s);
  assert.throws(
    () => parseNodes(duplicated(ROUTING_FIELD)),
    new RegExp(`board item PVTI_guard carried 2 "${ROUTING_FIELD}" values`),
  );
});

// Guard 5. Every page must be the configured project's. #572: an absence probe once
// asked a different project than the board read it was confirming.
test('parseBoardPage throws when a page is not the configured, open project', () => {
  const wrongProjectNumber = BOARD_PROJECT_NUMBER + 1;
  assert.throws(
    () => parseMutated((project, owner) => { owner.login = 'someone-else'; }),
    new RegExp(`answered for ${BOARD_OWNER_TYPE} "someone-else".*BOARD_OWNER is "${BOARD_OWNER}".*board-config\\.mjs`, 's'),
  );
  assert.throws(
    () => parseMutated((project) => { project.number = wrongProjectNumber; }),
    new RegExp(`answered for project ${wrongProjectNumber}.*BOARD_PROJECT_NUMBER is ${BOARD_PROJECT_NUMBER}.*board-config\\.mjs`, 's'),
  );
  assert.throws(
    () => parseMutated((project) => { project.id = '   '; }),
    /carried no project id.*rerun the board read/s,
  );
  assert.throws(
    () => parseMutated((project) => { project.closed = true; }),
    /board project .* is closed.*reopen it.*board-config\.mjs/s,
  );
  assert.throws(
    () => parseMutated((project) => { delete project.closed; }),
    /carried no boolean closed flag.*rerun the board read/s,
  );
});

// Guard 5, for either kind of owner. The check judges a page against the board it is
// handed, so an install can ask it about a board of the other kind; handed nothing it
// judges against the configured one.
test('assertProject judges a page against the owner, owner type and project it is handed, and against the configured board when handed none', () => {
  const other = BOARD_OWNER_TYPE === 'user' ? 'organization' : 'user';
  const login = `${BOARD_OWNER}-other`;
  const pageUnder = (root) => ({
    data: { [root]: { login, projectV2: { id: 'PVT_other', number: 9, closed: false } } },
  });
  assert.equal(board.assertProject(pageUnder(other), login, 9, other).identity, `${login} project 9 (PVT_other)`);
  assert.throws(
    () => board.assertProject(pageUnder(other), login, 9, BOARD_OWNER_TYPE),
    new RegExp(`board page carried no ${BOARD_OWNER_TYPE} data`),
  );
  assert.throws(
    () => board.assertProject(pageUnder(BOARD_OWNER_TYPE)),
    new RegExp(`answered for ${BOARD_OWNER_TYPE} "${login}".*BOARD_OWNER is "${BOARD_OWNER}"`, 's'),
  );
});

// Guard 9. The reader's whole vocabulary is board-config's option lists; a live board
// that no longer matches them is judged against names it does not have.
test('parseBoardPage throws when Status or the routing field is missing, not single-select, or offers other options', () => {
  const fieldIndex = { Status: 1, [ROUTING_FIELD]: 2 };
  for (const [name, index] of Object.entries(fieldIndex)) {
    assert.throws(
      () => parseMutated((project) => { project.fields.nodes.splice(index, 1); project.fields.totalCount -= 1; }),
      new RegExp(`board has no "${name}" field.*board-config\\.mjs`, 's'),
    );
    assert.throws(
      () => parseMutated((project) => { project.fields.nodes[index].dataType = 'TEXT'; }),
      new RegExp(`"${name}" is a TEXT field, not SINGLE_SELECT.*board-config\\.mjs`, 's'),
    );
    assert.throws(
      () => parseMutated((project) => { project.fields.nodes[index].options.push({ name: 'Nope' }); }),
      new RegExp(`"${name}" field offers .*Nope.*board-config\\.mjs configures`, 's'),
    );
  }
  // The message names both sets so the operator can see which side moved.
  assert.throws(
    () => parseMutated((project) => { project.fields.nodes[1].options.pop(); }),
    new RegExp(STATUS_OPTIONS.join(', ')),
  );
  assert.throws(
    () => parseMutated((project) => { project.fields.nodes[2].options.pop(); }),
    new RegExp(ROUTING_OPTIONS.join(', ')),
  );
});

// Guard 10. A numbered Issue card is the shape every downstream rule judges, so a
// field it came back malformed in stops the read rather than being defaulted: an
// unnumbered closing reference or a missing state would silently flip a verdict.
test('parseBoardPage throws on a malformed numbered Issue card', () => {
  assert.throws(
    () => parseNodes(guardNode({ state: 'DRAFT' })),
    /board card #9 came back with state "DRAFT".*expected OPEN or CLOSED.*rerun the board read/s,
  );
  assert.throws(
    () => parseNodes(guardNode({ state: null })),
    /board card #9 came back with state "null".*expected OPEN or CLOSED/s,
  );
  for (const summary of [null, { total: 2 }, { total: 1, completed: 2 }, { total: -1, completed: 0 }]) {
    assert.throws(
      () => parseNodes(guardNode({ subIssuesSummary: summary })),
      /board card #9 carried no usable sub-issue summary.*total.*completed.*rerun the board read/s,
    );
  }
  for (const reference of [{}, { number: 0 }, { number: '5' }]) {
    assert.throws(
      () => parseNodes(guardNode({ closingPullRequests: [reference] })),
      /board card #9 carried a closing pull-request reference without a number.*rerun the board read/s,
    );
  }
  for (const blocker of [{ number: 5 }, { state: 'OPEN' }, { number: 5, state: 'MERGED' }]) {
    assert.throws(
      () => parseNodes(guardNode({ blockers: [blocker] })),
      /board card #9 carried a blocker without a number and an OPEN or CLOSED state.*rerun the board read/s,
    );
  }
  assert.throws(
    () => parseNodes(guardNode({ repository: { nameWithOwner: `${BOARD_OWNER}/other-repo` } })),
    new RegExp(`board card #9 belongs to ${BOARD_OWNER}/other-repo, not ${BOARD_OWNER}/${BOARD_REPOSITORY}.*board-config\\.mjs`, 's'),
  );
  assert.throws(
    () => parseNodes(guardNode({ repository: null })),
    new RegExp(`board card #9 belongs to no repository, not ${BOARD_OWNER}/${BOARD_REPOSITORY}`, 's'),
  );
});

// Guard 10b. An assignee the read cannot name would count as an assignment in the
// drift scan and print as an account on the intake document, so the read stops on it.
test('ANTI-REGRESSION: parseBoardPage throws on an assignee without a usable login', () => {
  for (const assignee of [{}, null, { login: '' }, { login: '  ' }, { login: 7 }]) {
    assert.throws(
      () => parseNodes(guardNode({ assignees: { totalCount: 1, nodes: [assignee] } })),
      /board card #9 carried an assignee without a usable login.*rerun the board read/s,
    );
  }
});

// Guard 11. One issue, one card. Two cards for the same number make every count and
// every per-card verdict ambiguous, and one of them is stale by definition.
test('parseBoardPage and fetchBoard throw when the same issue number appears on two cards', () => {
  const twice = [
    guardNode({}, { id: 'PVTI_a' }),
    guardNode({}, { id: 'PVTI_b' }),
  ];
  assert.throws(() => parseNodes(...twice), /issue #9 appears on 2 board cards.*remove the duplicate card/s);

  // Across pages too: neither page is duplicated on its own.
  const first = leanBoardPage([twice[0]], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' } });
  const second = leanBoardPage([twice[1]], { totalCount: 2 });
  assert.throws(
    () => fetchBoard(() => JSON.stringify([first, second])),
    /issue #9 appears on 2 board cards.*remove the duplicate card/s,
  );
});

// Guard 12. The item id is the card's own identity, so the SAME id twice is not two
// cards but one card the response repeated — a doubled row and a doubled count out of a
// read that never saw two. Distinct issue numbers, so guard 11 cannot be what fires.
test('parseBoardPage and fetchBoard throw when the same item id is returned on two cards', () => {
  const twice = [
    guardNode({ number: 9 }, { id: 'PVTI_same' }),
    guardNode({ number: 10 }, { id: 'PVTI_same' }),
  ];
  assert.throws(() => parseNodes(...twice), /board item PVTI_same was returned on 2 cards.*rerun the board read/s);

  // Across pages too: neither page repeats the id on its own.
  const first = leanBoardPage([twice[0]], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' } });
  const second = leanBoardPage([twice[1]], { totalCount: 2 });
  assert.throws(
    () => fetchBoard(() => JSON.stringify([first, second])),
    /board item PVTI_same was returned on 2 cards.*rerun the board read/s,
  );
});

test('normalizeItem flattens exactly the fields the board rules judge a card on', () => {
  const { items } = parseBoardPage(BOARD_PAGE);
  assert.deepEqual(normalizeItem(items[1]), {
    number: 263,
    status: 'Done',
    title: 'Review batch 4 — interaction/desktop breaks',
    routing: 'Product',
    parked: false,
    labels: ['type:feature', 'area:ui', 'area:desktop', 'autonomy:supervised'],
    state: 'OPEN',
    assignees: [BOARD_OWNER],
    openBlockers: [261],
    closingPullRequests: [{ number: 1133 }],
    subIssues: { total: 2, completed: 1 },
  });
  // Missing fields default, never throw (the "In review" item carries nothing but a number).
  const bare = normalizeItem(BOARD.items[3]);
  assert.equal(bare.number, 296);
  assert.equal(bare.routing, null);
  assert.equal(bare.state, null);
  assert.equal(bare.subIssues, null);
  assert.deepEqual(bare.labels, []);
  assert.deepEqual(bare.openBlockers, []);
});

test('normalizeItem publishes the routing view only — no Model, no Effort, no internal unresolved-content flag', () => {
  // `board --json` prints normalizeItem's output verbatim, so an internal flag added for
  // issue-publish must never widen that published shape (#572), and the board's Model and
  // Effort fields have left this reader entirely.
  assert.deepEqual(Object.keys(normalizeItem(BOARD.items[0])).sort(), [
    'assignees', 'closingPullRequests', 'labels', 'number', 'openBlockers',
    'parked', 'routing', 'state', 'status', 'subIssues', 'title',
  ]);
});

test('sortForDisplay ranks Ready before Backlog, then ascending number', () => {
  const sorted = sortForDisplay(pickable(BOARD.items)).map((i) => i.content.number);
  assert.deepEqual(sorted, [266, 264]); // Ready(266) before Backlog(264) despite 266>264
});

test('formatRow renders #num, [status], title and labels — and no Model/Effort suffix', () => {
  const row = formatRow(BOARD.items[1]);
  assert.equal(row, '#264 [Backlog] Review batch 5\n    tripwire, plan-first');
});

test('formatRow degrades gracefully with no labels (— placeholder)', () => {
  assert.equal(formatRow(BOARD.items[3]), '#296 [In review] Mid flight\n    —');
});

test('formatList orders then renders the given selection', () => {
  const out = formatList(pickable(BOARD.items));
  // #266 (Ready) block appears before #264 (Backlog) block.
  assert.ok(out.indexOf('#266') < out.indexOf('#264'));
  // It renders only what it was given — Done #293 is absent.
  assert.equal(out.includes('#293'), false);
});

// Product outnumbers Go-to-market (2 vs 1) and sorts earlier by number —
// the mutation guard: a flat/number-ordered list would put #200 before #391.
const ROUTED_ITEMS = [
  { status: 'Backlog', title: 'Product A', routing: 'Product', content: { number: 100 } },
  { status: 'Backlog', title: 'Product B', routing: 'Product', content: { number: 200 } },
  { status: 'Backlog', title: 'GTM item', routing: 'Go-to-market', content: { number: 391 } },
  { status: 'Backlog', title: 'No routing', routing: null, content: { number: 500 } },
  { status: 'Backlog', title: 'New field', routing: 'Legal', content: { number: 600 } },
];

test('groupByRouting puts Go-to-market FIRST even though Product outnumbers it and sorts earlier by number', () => {
  const groups = groupByRouting(ROUTED_ITEMS);
  assert.equal(groups[0].routing, 'Go-to-market');
  assert.deepEqual(groups[0].items.map((i) => i.content.number), [391]);
});

test('groupByRouting keeps an unfielded item in the trailing Unfielded group — never dropped', () => {
  const groups = groupByRouting(ROUTED_ITEMS);
  const unfielded = groups.find((g) => g.routing === 'Unfielded');
  assert.ok(unfielded);
  assert.deepEqual(unfielded.items.map((i) => i.content.number), [500]);
  // No item lost across the split.
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, ROUTED_ITEMS.length);
});

// An empty-string field is absent, not a group named "" — else the reader
// renders a nameless `── (1) ──` heading.
test('groupByRouting treats an empty-string routing value as Unfielded, not an unnamed group', () => {
  const groups = groupByRouting([
    { status: 'Backlog', title: 'Blank field', routing: '', content: { number: 700 } },
  ]);
  assert.deepEqual(groups.map((g) => g.routing), ['Unfielded']);
});

test('groupByRouting omits empty groups (no Platform group when nothing is on it)', () => {
  const groups = groupByRouting(ROUTED_ITEMS);
  assert.equal(groups.some((g) => g.routing === 'Platform'), false);
});

test('groupByRouting surfaces an unrecognised routing value after the known ones, before Unfielded', () => {
  const groups = groupByRouting(ROUTED_ITEMS);
  assert.deepEqual(groups.map((g) => g.routing), ['Go-to-market', 'Product', 'Legal', 'Unfielded']);
});

// Every routing option carries a card, plus Brand, which is not an option and must
// still reach the unrecognised-value fallback AFTER all of them. Brand sorts
// alphabetically before two of the three names, so a grouping that fell back to
// alphabetical order would flip the head of this list.
const ALL_ROUTED_ITEMS = [
  { status: 'Backlog', title: 'Brand item', routing: 'Brand', content: { number: 602 } },
  { status: 'Backlog', title: 'Platform item', routing: 'Platform', content: { number: 603 } },
  { status: 'Backlog', title: 'Product item', routing: 'Product', content: { number: 604 } },
  { status: 'Backlog', title: 'GTM item', routing: 'Go-to-market', content: { number: 605 } },
];

test('groupByRouting orders groups by ROUTING_OPTIONS and still falls back for a value outside it', () => {
  // The live board's routing field offers exactly these three. Pinned literally
  // so adding a fourth option, or reordering them, fails here first.
  assert.deepEqual(ROUTING_OPTIONS, ['Go-to-market', 'Product', 'Platform']);
  // The owner type is the GraphQL root the board is read under, so it is one of the two GitHub offers.
  assert.ok(['user', 'organization'].includes(BOARD_OWNER_TYPE));
  const groups = groupByRouting(ALL_ROUTED_ITEMS);
  assert.deepEqual(groups.map((g) => g.routing), [
    'Go-to-market',
    'Product',
    'Platform',
    'Brand',
  ]);
  // The fallback survives the enumerated options: Brand is still caught, and is its
  // own named group rather than being swept into Unfielded.
  assert.deepEqual(
    groups.find((g) => g.routing === 'Brand').items.map((i) => i.content.number),
    [602],
  );
});

test('formatGrouped renders the Go-to-market heading before the Product heading', () => {
  const out = formatGrouped(ROUTED_ITEMS);
  assert.ok(out.indexOf('Go-to-market') < out.indexOf('Product'));
  assert.match(out, /── Go-to-market \(1\) ──/);
  assert.match(out, /── Product \(2\) ──/);
});

test('formatGrouped warns when an unrecognised routing value is rendered without dropping or reordering its cards', () => {
  const items = [
    { status: 'Backlog', title: 'Go-to-market card', routing: 'Go-to-market', content: { number: 701 } },
    { status: 'Ready', title: 'Product card', routing: 'Product', content: { number: 702 } },
    { status: 'Backlog', title: 'Research card', routing: 'Research', content: { number: 703 } },
    { status: 'Backlog', title: 'Unfielded card', content: { number: 704 } },
  ];

  const out = formatGrouped(items);
  const headings = ['Go-to-market', 'Product', 'Research', 'Unfielded'];
  const headingPositions = headings.map((routing) => out.indexOf(`── ${routing} (1) ──`));
  assert.ok(headingPositions.every((position) => position >= 0));
  assert.deepEqual([...headingPositions].sort((a, b) => a - b), headingPositions);
  for (const number of [701, 702, 703, 704]) {
    assert.equal(out.split(`#${number}`).length - 1, 1);
  }
  assert.match(out, /WARNING: unrecognised Workstream value: Research/);
  assert.match(out, /add Research to ROUTING_OPTIONS in scripts\/lib\/board-config\.mjs\./);
  // The skill is one repository's file and this toolkit is copied verbatim into another; the
  // warning must name the config that travels with it, never a path that may not exist there.
  assert.doesNotMatch(out, /\.agents\/skills\/to-issues\/SKILL\.md/);
  assert.doesNotMatch(out, /unrecognised Workstream value: Unfielded/);

  const multipleUnknown = formatGrouped([
    { status: 'Backlog', title: 'Zulu card', routing: 'Zulu', content: { number: 707 } },
    { status: 'Backlog', title: 'Alpha card', routing: 'Alpha', content: { number: 708 } },
  ]);
  assert.match(multipleUnknown, /WARNING: unrecognised Workstream values: Alpha, Zulu/);
  assert.ok(multipleUnknown.indexOf('── Alpha (1) ──') < multipleUnknown.indexOf('── Zulu (1) ──'));
  for (const number of [707, 708]) {
    assert.equal(multipleUnknown.split(`#${number}`).length - 1, 1);
  }

  const syntheticUnfielded = formatGrouped([
    { status: 'Backlog', title: 'Missing routing card', content: { number: 705 } },
  ]);
  assert.match(syntheticUnfielded, /── Unfielded \(1\) ──/);
  assert.equal(syntheticUnfielded.split('#705').length - 1, 1);
  assert.doesNotMatch(syntheticUnfielded, /WARNING: unrecognised Workstream/);

  const literalUnfielded = formatGrouped([
    { status: 'Backlog', title: 'Literal Unfielded card', routing: 'Unfielded', content: { number: 706 } },
  ]);
  assert.match(literalUnfielded, /── Unfielded \(1\) ──/);
  assert.equal(literalUnfielded.split('#706').length - 1, 1);
  assert.match(literalUnfielded, /WARNING: unrecognised Workstream value: Unfielded/);
});

const commentPage = (bodies, { totalCount = bodies.length, hasPreviousPage = false, startCursor = null } = {}) => ({
  totalCount,
  pageInfo: { hasPreviousPage, startCursor },
  nodes: bodies.map((body) => ({ body })),
});
const detailIssue = (number, overrides = {}) => ({
  number, body: `body of ${number}`, parent: null, comments: commentPage([]), ...overrides,
});
const detailBatch = (aliases, errors) =>
  JSON.stringify({ data: { repository: aliases }, ...(errors ? { errors } : {}) });
const olderCommentPage = (number, comments) =>
  JSON.stringify({ data: { repository: { issue: { number, comments } } } });

test('ANTI-REGRESSION: a card detail that failed or came back malformed is unavailable, never empty', () => {
  // Every unavailable entry is compared whole, so a `body`, `comments` or `commentCount`
  // riding along beside the reason, which a caller could print as empty, fails the case.
  const unavailable = (number, reason) => ({ number, unavailable: reason });

  const numbers = Array.from({ length: DETAIL_BATCH_SIZE + 1 }, (_, index) => index + 1);
  const last = DETAIL_BATCH_SIZE + 1;
  const split = fetchCardDetails((args) => {
    if (/\bi1:/.test(args.at(-1))) {
      throw Object.assign(new Error('Command failed'), { stderr: '\ngh: timed out\nsecond line' });
    }
    return detailBatch({ [`i${last}`]: detailIssue(last) });
  }, numbers);
  assert.deepEqual([...split], [
    ...numbers.slice(0, DETAIL_BATCH_SIZE).map((number) => [number, unavailable(number, 'gh: timed out')]),
    [last, { number: last, body: `body of ${last}`, parent: null, comments: [], commentCount: 0, commentsUnavailable: null }],
  ]);

  const one = (response) => fetchCardDetails(() => response, [7]).get(7);
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7) }, [{ message: 'Could not resolve' }, { message: 'later error' }])),
    unavailable(7, 'GraphQL errors: Could not resolve'),
  );
  assert.deepEqual(one(detailBatch({ i7: null })), unavailable(7, 'GitHub returned no issue for this card'));
  assert.deepEqual(one(detailBatch({ i7: detailIssue(8) })), unavailable(7, 'GitHub returned issue #8 for this card'));
  assert.deepEqual(one(detailBatch({ i7: detailIssue(7, { body: null }) })), unavailable(7, 'malformed detail: body'));
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7, { parent: { number: 0 } }) })),
    unavailable(7, 'malformed detail: parent'),
  );
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7, { parent: { number: -1 } }) })),
    unavailable(7, 'malformed detail: parent'),
  );
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7, { comments: commentPage(['only'], { totalCount: '1' }) }) })),
    unavailable(7, 'malformed detail: comments'),
  );
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7, { comments: commentPage(['only'], { totalCount: 3 }) }) })),
    unavailable(7, 'malformed detail: comments'),
  );

  const newest = commentPage(['fourth', 'fifth'], { totalCount: 5, hasPreviousPage: true, startCursor: 'cursor-a' });
  const paged = (continuation) => fetchCardDetails(
    (args) => (args.includes('before=cursor-a') ? continuation() : detailBatch({ i7: detailIssue(7, { comments: newest }) })),
    [7],
  ).get(7);
  const partial = (comments, reason) => ({
    number: 7, body: 'body of 7', parent: null, comments, commentCount: 5, commentsUnavailable: reason,
  });
  assert.deepEqual(paged(() => { throw new Error('offline'); }), partial(['fourth', 'fifth'], 'offline'));
  assert.deepEqual(
    paged(() => olderCommentPage(7, commentPage([], { totalCount: 5 }))),
    partial(['fourth', 'fifth'], 'malformed comment page'),
  );
  assert.deepEqual(
    paged(() => olderCommentPage(7, commentPage(['second', 'third'], { totalCount: 5 }))),
    partial(['second', 'third', 'fourth', 'fifth'], 'GitHub reported 5 comment(s) but 4 were read'),
  );
  // The continuation holds exactly the three unread comments, so only its count says the
  // list changed between the two pages.
  assert.deepEqual(
    paged(() => olderCommentPage(7, commentPage(['first', 'second', 'third'], { totalCount: 6 }))),
    partial(['fourth', 'fifth'], 'comment count changed while reading'),
  );

  // A value that cannot be turned into text must not throw out of the read, which would
  // lose the valid card beside it.
  const untextable = { toString: null };
  assert.deepEqual(
    [...fetchCardDetails(() => detailBatch({ i7: detailIssue(7, { number: untextable }), i8: detailIssue(8) }), [7, 8])],
    [
      [7, unavailable(7, 'GitHub returned a different issue for this card')],
      [8, { number: 8, body: 'body of 8', parent: null, comments: [], commentCount: 0, commentsUnavailable: null }],
    ],
  );
  assert.deepEqual(
    one(detailBatch({ i7: detailIssue(7) }, [{ message: untextable }])),
    unavailable(7, 'malformed detail response'),
  );
});

// Points the real wrapper at a fake gh that answers `api rate_limit` with `{}` and every other
// call with `reply`, a JavaScript statement; restores the environment and removes the fake after
// the test.
function useFakeGh(t, reply) {
  const fakeGh = installFakeGh('board-details-', `
    if (process.argv.includes('rate_limit')) { process.stdout.write('{}'); process.exit(0); }
    process.stdout.on('error', () => {});
    ${reply}
  `);
  const previous = process.env.BOARD_TOOLKIT_GH;
  process.env.BOARD_TOOLKIT_GH = fakeGh.env().BOARD_TOOLKIT_GH;
  t.after(() => {
    if (previous === undefined) delete process.env.BOARD_TOOLKIT_GH;
    else process.env.BOARD_TOOLKIT_GH = previous;
    fakeGh.cleanup();
  });
}

test('ANTI-REGRESSION: a card detail response larger than 1 MiB is read whole through the real gh wrapper', (t) => {
  const body = 'x'.repeat(1.5 * 1024 * 1024);
  const reply = detailBatch({ i7: detailIssue(7, { body }), i8: detailIssue(8, { body: 'short' }) });
  useFakeGh(t, `process.stdout.write(${JSON.stringify(reply)});`);

  const details = fetchCardDetails(ghExec, [7, 8]);

  assert.equal(details.get(7).body, body);
  assert.equal(details.get(8).body, 'short');
  assert.equal('unavailable' in details.get(7), false);
  assert.equal('unavailable' in details.get(8), false);
});

// Recurring cost: this one test pipes two replies of about 64 MiB each through a real subprocess
// on every run: the whole batch, then card 7 alone.
test('ANTI-REGRESSION: a card detail batch beyond the gh output limit is read again in halves, and only the oversized card is unavailable, with a reason naming the size', (t) => {
  const short = detailBatch({ i8: detailIssue(8) });
  useFakeGh(t, `
    if (process.argv.some((arg) => arg.includes('i7:'))) process.stdout.write(Buffer.alloc(${64 * 1024 * 1024 + 1}, 'x'));
    else process.stdout.write(${JSON.stringify(short)});
  `);

  assert.deepEqual([...fetchCardDetails(ghExec, [7, 8])], [
    [7, { number: 7, unavailable: 'gh output exceeded the 64 MiB read limit' }],
    [8, { number: 8, body: 'body of 8', parent: null, comments: [], commentCount: 0, commentsUnavailable: null }],
  ]);
});

test('fetchCardDetails: reads body, parent and every comment page, oldest comment first', () => {
  // The shape a live backward read returns: every page reports the whole count, and the
  // final page is short, has no previous page and still carries a cursor.
  const whole = { totalCount: 5 };
  const newest = commentPage(['fourth', 'fifth'], { ...whole, hasPreviousPage: true, startCursor: 'cursor-a' });
  const olderPages = {
    'before=cursor-a': commentPage(['second', 'third'], { ...whole, hasPreviousPage: true, startCursor: 'cursor-b' }),
    'before=cursor-b': commentPage(['first'], { ...whole, startCursor: 'cursor-c' }),
  };
  const calls = [];
  const details = fetchCardDetails((args) => {
    const before = args.find((arg) => arg.startsWith('before='));
    calls.push(before);
    if (before === undefined && calls.length === 1) {
      return detailBatch({ i7: detailIssue(7, { parent: { number: 3 }, comments: newest }) });
    }
    if (!Object.hasOwn(olderPages, before)) assert.fail(`unexpected call: ${args.join(' ')}`);
    return olderCommentPage(7, olderPages[before]);
  }, [7]);

  assert.deepEqual([...details], [[7, {
    number: 7,
    body: 'body of 7',
    parent: 3,
    comments: ['first', 'second', 'third', 'fourth', 'fifth'],
    commentCount: 5,
    commentsUnavailable: null,
  }]]);
  // The read turns a throwing call into a reason, so the call list is what refuses a stray call.
  assert.deepEqual(calls, [undefined, 'before=cursor-a', 'before=cursor-b']);
});

test('cardDetailsQuery asks for body, parent and the newest comment page with its backward cursor, one alias per card', () => {
  const query = cardDetailsQuery([7, 12]);
  assert.deepEqual(
    [...query.matchAll(/(\w+): issue\(number:(\d+)\) \{ \.\.\.CardDetails \}/g)].map(([, alias, number]) => [alias, number]),
    [['i7', '7'], ['i12', '12']],
  );
  assert.equal(query.split('issue(').length - 1, 2);
  assert.ok(query.includes(`repository(owner:"${BOARD_OWNER}" name:"${BOARD_REPOSITORY}")`));
  assert.ok(query.endsWith(
    'fragment CardDetails on Issue { number body parent { number } '
    + 'comments(last:100) { totalCount pageInfo { hasPreviousPage startCursor } nodes { body } } }',
  ));
  // gh --paginate needs $endCursor and only walks forward; comments page backward.
  assert.doesNotMatch(query, /\$endCursor/);

  for (const numbers of [[], [7, 1.5], ['7']]) {
    assert.throws(() => cardDetailsQuery(numbers), /at least one card number, each an integer/);
  }
});

// Every expected line below is written by hand from the intake contract (the summary on
// stdout, one text file per card), never produced by the function under test.
const intakeCard = (number, status, title, { routing = 'Product', openBlockers = [], assignees = [] } = {}) => ({
  number, status, title, routing, openBlockers, assignees,
});
const LISTING = 'LISTING HEADER\n\nLISTING BODY';
const [BACKLOG, READY] = PICKABLE_STATUSES;
const routingLine = (value) => (ROUTING_FIELD ? [`${ROUTING_FIELD}: ${value}`] : []);
const DIRECTORY = 'intake-out';
const CARD_TEXT_LEGEND = 'Lines starting "| " are card text, and "|+ " continues the line above it.';
const SUMMARY_LEGEND = `${CARD_TEXT_LEGEND} Each card's full body and comments are in the file its "card text:" line names.`;

// The files and the summary of one intake, the way the command builds them.
function intakeOf({ numberless = 0, ...cards }) {
  const files = new Map(intakeCardFiles(cards).map((file) => [file.number, file]));
  return { files, summary: intakeSummary({ listing: LISTING, numberless, ...cards, directory: DIRECTORY, files }) };
}

// One card's section: its header up to the blank line that ends it. A blank line inside
// card text prints as a bare `|`, so the first blank line is always the end.
function sectionOf(lines, number) {
  const start = lines.findIndex((line) => line.startsWith(`=== #${number} `));
  return lines.slice(start, start + lines.slice(start).indexOf(''));
}

test('ANTI-REGRESSION: an unavailable card prints no body, claim, comment count or card text line, and unread older comments never read as no claim', () => {
  const details = new Map([
    [5, { number: 5, unavailable: 'gh: timed out' }],
    [6, {
      number: 6, body: 'six body', parent: null, comments: ['hello', 'plain'], commentCount: 5, commentsUnavailable: 'offline',
    }],
    [7, {
      number: 7, body: '', parent: 2, comments: ['older', '  Claim: m1, codex, t1'], commentCount: 4, commentsUnavailable: 'offline',
    }],
  ]);

  const { files, summary } = intakeOf({
    candidates: [
      intakeCard(5, BACKLOG, 'Unread card', { assignees: ['dev-one'] }),
      intakeCard(6, READY, 'Partly read', { openBlockers: [3, 4] }),
    ],
    claims: [intakeCard(7, 'In progress', 'Claimed card', { routing: null, assignees: ['dev-one', 'dev-two'] })],
    details,
  });

  // An unread card has no text file and its summary names none.
  assert.deepEqual([...files.keys()], [6, 7]);
  assert.deepEqual(sectionOf(summary, 5), [
    '=== #5 [Backlog] Unread card ===',
    ...routingLine('Product'),
    'open blockers: none',
    'assignees: @dev-one',
    'details: UNAVAILABLE — gh: timed out',
  ]);

  // The newest 2 of 5 comments were read and neither is a claim: that is not "no claim".
  const sixFile = [
    CARD_TEXT_LEGEND,
    '=== #6 [Ready] Partly read ===',
    ...routingLine('Product'),
    'parent: none',
    'open blockers: #3, #4',
    'assignees: none',
    'claim: UNAVAILABLE — no Claim in the newest 2 of 5 comment(s) and the older ones were not read',
    'body: 1 line(s)',
    '| six body',
    'comments: 5, UNAVAILABLE before the newest 2 — offline',
    '--- comment 4 of 5 ---',
    '| hello',
    '--- comment 5 of 5 ---',
    '| plain',
  ];
  assert.equal(files.get(6).name, '6.txt');
  assert.deepEqual(files.get(6).lines, sixFile);
  assert.deepEqual(sectionOf(summary, 6), [
    '=== #6 [Ready] Partly read ===',
    ...routingLine('Product'),
    'parent: none',
    'open blockers: #3, #4',
    'assignees: none',
    'proposal: no',
    'claim: UNAVAILABLE — no Claim in the newest 2 of 5 comment(s) and the older ones were not read',
    'owner questions: 0 in the newest 2 of 5 comment(s), UNAVAILABLE before them — offline',
    'what to build: none in the card text',
    `card text: ${join(DIRECTORY, '6.txt')}, ${sixFile.length} line(s)`,
  ]);

  // A claim found in the newest pages is the latest claim even when older pages failed,
  // and it is numbered by its true position.
  const sevenFile = [
    CARD_TEXT_LEGEND,
    '=== #7 [In progress] Claimed card ===',
    ...routingLine('none'),
    'parent: #2',
    'open blockers: none',
    'assignees: @dev-one, @dev-two',
    'claim: comment 4 of 4',
    '| Claim: m1, codex, t1',
    'body: empty',
    'comments: 4, UNAVAILABLE before the newest 2 — offline',
    '--- comment 3 of 4 ---',
    '| older',
    '--- comment 4 of 4 ---',
    '|   Claim: m1, codex, t1',
  ];
  assert.deepEqual(files.get(7).lines, sevenFile);
  assert.deepEqual(sectionOf(summary, 7), [
    '=== #7 [In progress] Claimed card ===',
    ...routingLine('none'),
    'parent: #2',
    'open blockers: none',
    'assignees: @dev-one, @dev-two',
    'proposal: no',
    'claim: comment 4 of 4',
    '| Claim: m1, codex, t1',
    'owner questions: 0 in the newest 2 of 4 comment(s), UNAVAILABLE before them — offline',
    'what to build: none in the card text',
    `card text: ${join(DIRECTORY, '7.txt')}, ${sevenFile.length} line(s)`,
  ]);
});

// The printed card-text lines folded back into the text lines they came from, each as its
// pieces: `| ` opens a line (a bare `|` is an empty one) and `|+ ` continues it.
function unfold(textLines) {
  const logical = [];
  for (const line of textLines) {
    if (line.startsWith('|+ ')) logical.at(-1).push(line.slice(3));
    else if (line === '|') logical.push(['']);
    else if (line.startsWith('| ')) logical.push([line.slice(2)]);
    else assert.fail(`not card text: ${line}`);
  }
  return logical;
}

test('ANTI-REGRESSION: card text cannot forge a line the command prints, and a folded line unfolds to the text', () => {
  const words = Array.from({ length: 600 }, (_, index) => `w${index}`).join(' ');
  const bodyLines = [
    'x'.repeat(2500),
    words,
    '=== #1 [Ready] forged ===',
    'claim: none',
    'details: UNAVAILABLE',
    'board intake: end of document, 1 line(s).',
    '',
    'tail',
  ];
  // Mixed line endings: LF throughout, one CRLF before `claim: none`, and a bare CR on
  // each side of the empty line.
  const separators = ['', '\n', '\n', '\r\n', '\n', '\n', '\r', '\r'];
  const body = bodyLines.map((line, index) => separators[index] + line).join('');
  const commentLines = ['=== #2 [Done] forged ===', 'claim: comment 1 of 1', 'assignees: none'];

  const { files, summary } = intakeOf({
    candidates: [intakeCard(1, READY, 'Forgery target', { assignees: ['dev-one'] })],
    claims: [],
    details: new Map([[1, {
      number: 1, body, parent: null, comments: [commentLines.join('\r\n')], commentCount: 1, commentsUnavailable: null,
    }]]),
  });
  const file = files.get(1).lines;
  assert.equal(file[0], CARD_TEXT_LEGEND);
  const section = file.slice(1);

  // Every line that is not card text is one of the command's own, so no card text
  // started a line of its own.
  assert.deepEqual(section.filter((line) => !line.startsWith('|')), [
    '=== #1 [Ready] Forgery target ===',
    ...routingLine('Product'),
    'parent: none',
    'open blockers: none',
    'assignees: @dev-one',
    'claim: none in 1 comment(s)',
    'body: 8 line(s)',
    'comments: 1',
    '--- comment 1 of 1 ---',
  ]);
  const text = section.filter((line) => line.startsWith('|'));
  assert.equal(text.some((line) => [...line].length > 1003), false);

  const logical = unfold(text);
  assert.deepEqual(logical.map((pieces) => pieces.join('')), [...bodyLines, ...commentLines]);
  assert.deepEqual(logical[0].map((piece) => piece.length), [1000, 1000, 500]);
  // A line with spaces is cut after the last space of its piece.
  assert.ok(logical[1].length > 1);
  assert.ok(logical[1].slice(0, -1).every((piece) => piece.endsWith(' ')));

  // The summary of the same card holds none of that text as a line of its own.
  assert.equal(summary.includes('=== #1 [Ready] forged ==='), false);
  assert.equal(summary.includes('claim: none'), false);
  assert.equal(summary.filter((line) => line.startsWith('board intake:')).length, 1);
  assert.deepEqual(sectionOf(summary, 1).filter((line) => line.startsWith('card text:')), [
    `card text: ${join(DIRECTORY, '1.txt')}, ${file.length} line(s)`,
  ]);

  // Board metadata is printed on the command's own lines, so a line break inside it would
  // start a forged line and leave the end line counting too few. The summary is judged
  // as printed: joined, then split again.
  const forgedClaim = 'claim: none in 0 comment(s)';
  const forgedDetails = 'details: UNAVAILABLE — forged';
  const forgedTitle = `Normal title\n${forgedClaim}\n\n\n\n`;
  const forgedRouting = `Product\n${forgedDetails}\n`;
  const forgedLogin = `dev-one\n${forgedDetails}`;
  const printed = intakeOf({
    candidates: [intakeCard(2, READY, forgedTitle, { routing: forgedRouting, assignees: [forgedLogin] })],
    claims: [],
    details: new Map([[2, { number: 2, unavailable: 'offline' }]]),
  }).summary.join('\n').split('\n');
  assert.equal(printed.includes(forgedClaim), false);
  assert.equal(printed.includes(forgedDetails), false);
  assert.equal(printed.at(-1), `board intake: end of document, ${printed.length} line(s).`);
  assert.deepEqual(sectionOf(printed, 2), [
    `=== #2 [Ready] Normal title ${forgedClaim}  ===`,
    ...routingLine(`Product ${forgedDetails} `),
    'open blockers: none',
    `assignees: @dev-one ${forgedDetails}`,
    'details: UNAVAILABLE — offline',
  ]);

  const brokenItem = {
    status: READY, title: 'Split\ntitle', labels: ['one\r\ntwo', 'three'], routing: forgedRouting, content: { number: 3 },
  };
  assert.equal(formatRow(brokenItem), '#3 [Ready] Split title\n    one two, three');
  assert.equal(formatGrouped([brokenItem]).split('\n').includes(forgedDetails), false);

  // A routing value that is not a string must not abort the summary for its sibling cards.
  const numeric = intakeOf({
    candidates: [intakeCard(4, READY, 'Numeric routing', { routing: 123 }), intakeCard(5, READY, 'Ordinary')],
    claims: [],
    details: new Map([[4, { number: 4, unavailable: 'offline' }], [5, { number: 5, unavailable: 'offline' }]]),
  }).summary;
  assert.equal(numeric.includes('=== #4 [Ready] Numeric routing ==='), true);
  assert.equal(numeric.includes('=== #5 [Ready] Ordinary ==='), true);
  assert.deepEqual(sectionOf(numeric, 4).slice(1, 1 + routingLine('123').length), routingLine('123'));
});

test('intakeCardFiles and intakeSummary: a complete card prints its summary and keeps its whole text in its file', () => {
  // Two claims with a plain comment after the newer one: the claim line names the newer.
  const { files, summary } = intakeOf({
    candidates: [intakeCard(9, READY, 'Complete card', { openBlockers: [4], assignees: ['dev-one', 'dev-two'] })],
    claims: [],
    details: new Map([[9, {
      number: 9,
      body: 'first\nsecond\n\nfourth',
      parent: 2,
      comments: ['Claim: m0, claude, t0', 'plain', 'Claim: m1, codex, t1\nextra line', 'thanks'],
      commentCount: 4,
      commentsUnavailable: null,
    }]]),
  });

  assert.deepEqual(files.get(9), {
    number: 9,
    name: '9.txt',
    lines: [
      CARD_TEXT_LEGEND,
      '=== #9 [Ready] Complete card ===',
      ...routingLine('Product'),
      'parent: #2',
      'open blockers: #4',
      'assignees: @dev-one, @dev-two',
      'claim: comment 3 of 4',
      '| Claim: m1, codex, t1',
      'body: 4 line(s)',
      '| first',
      '| second',
      '|',
      '| fourth',
      'comments: 4',
      '--- comment 1 of 4 ---',
      '| Claim: m0, claude, t0',
      '--- comment 2 of 4 ---',
      '| plain',
      '--- comment 3 of 4 ---',
      '| Claim: m1, codex, t1',
      '| extra line',
      '--- comment 4 of 4 ---',
      '| thanks',
    ],
  });
  assert.equal(files.get(9).lines.length, 22 + routingLine('Product').length);

  assert.deepEqual(summary, [
    'LISTING HEADER',
    '',
    'LISTING BODY',
    '',
    'Card summaries: 1 pickable card(s), then 0 claimed card(s) with no closing pull request.',
    SUMMARY_LEGEND,
    '',
    '=== #9 [Ready] Complete card ===',
    ...routingLine('Product'),
    'parent: #2',
    'open blockers: #4',
    'assignees: @dev-one, @dev-two',
    'proposal: no',
    'claim: comment 3 of 4',
    '| Claim: m1, codex, t1',
    'owner questions: 0',
    'what to build: none in the card text',
    `card text: ${join(DIRECTORY, '9.txt')}, ${22 + routingLine('Product').length} line(s)`,
    '',
    `board intake: end of document, ${19 + routingLine('Product').length} line(s).`,
  ]);
});

test('intakeSummary: a suggested card says so, and the numberless cards are counted', () => {
  const read = { body: '', parent: null, comments: [], commentCount: 0, commentsUnavailable: null };
  const { summary } = intakeOf({
    candidates: [
      intakeCard(1, READY, '  Proposed: a change'),
      intakeCard(2, READY, 'proposed: lower case'),
      intakeCard(3, READY, 'Proposed:no space'),
    ],
    claims: [],
    numberless: 2,
    details: new Map([1, 2, 3].map((number) => [number, { ...read, number }])),
  });
  assert.equal(summary.includes('Card summaries: 3 pickable card(s), then 0 claimed card(s) with no closing pull request. 2 card(s) with no issue number have no details.'), true);
  assert.deepEqual(
    [1, 2, 3].map((number) => sectionOf(summary, number).find((line) => line.startsWith('proposal:'))),
    ['proposal: yes', 'proposal: no', 'proposal: no'],
  );
});

test('intakeSummary: owner questions are the whole Needs owner comments, numbered by their true position', () => {
  const ownerPart = (section) => section.slice(
    section.findIndex((line) => line.startsWith('owner questions:')),
    section.findIndex((line) => line.startsWith('what to build:')),
  );
  const comments = ['  Needs owner: pick a, b or c?\nsecond line\n\nlast line', 'a reply that says Needs owner: later', 'Needs owner: again'];
  const whole = intakeOf({
    candidates: [intakeCard(1, READY, 'Asked')],
    claims: [],
    details: new Map([[1, { number: 1, body: '', parent: null, comments, commentCount: 3, commentsUnavailable: null }]]),
  }).summary;
  assert.deepEqual(ownerPart(sectionOf(whole, 1)), [
    'owner questions: 2',
    '--- comment 1 of 3 ---',
    '|   Needs owner: pick a, b or c?',
    '| second line',
    '|',
    '| last line',
    '--- comment 3 of 3 ---',
    '| Needs owner: again',
  ]);

  // Only the newest 3 of 7 comments were read: the heading says the older four are unknown.
  const partial = intakeOf({
    candidates: [intakeCard(2, READY, 'Asked, partly read')],
    claims: [],
    details: new Map([[2, { number: 2, body: '', parent: null, comments, commentCount: 7, commentsUnavailable: 'offline' }]]),
  }).summary;
  assert.deepEqual(ownerPart(sectionOf(partial, 2)), [
    'owner questions: 2 in the newest 3 of 7 comment(s), UNAVAILABLE before them — offline',
    '--- comment 5 of 7 ---',
    '|   Needs owner: pick a, b or c?',
    '| second line',
    '|',
    '| last line',
    '--- comment 7 of 7 ---',
    '| Needs owner: again',
  ]);
});

// The What to build lines of a card holding this body.
function whatToBuild(body, bodyFormat) {
  const detail = { number: 1, body, parent: null, comments: [], commentCount: 0, commentsUnavailable: null, ...(bodyFormat ? { bodyFormat } : {}) };
  const section = sectionOf(intakeOf({
    candidates: [intakeCard(1, READY, 'Card')],
    claims: [],
    details: new Map([[1, detail]]),
  }).summary, 1);
  const from = section.findIndex((line) => line.startsWith('what to build:'));
  return section.slice(from, section.findIndex((line) => line.startsWith('card text:')));
}

test('intakeSummary: what to build is the body section under its heading, bounded by the next heading of its level or higher', () => {
  // A deeper subheading stays inside; a same-level heading ends the section; blank lines around it are trimmed.
  assert.deepEqual(whatToBuild('## Parent\nelsewhere\n\n## What to build\n\n\nBuild it.\n\n### Detail\nmore\n\n\n## Acceptance\ncriteria'), [
    'what to build: 4 line(s)',
    '| Build it.',
    '|',
    '| ### Detail',
    '| more',
  ]);
  // A higher-level heading ends a deeper section, and a heading is matched without regard to case, closing hashes or level.
  assert.deepEqual(whatToBuild('Intro\n### what to build ###\nline one\n#### Sub\nline two\n## Next\nline three'), [
    'what to build: 3 line(s)',
    '| line one',
    '| #### Sub',
    '| line two',
  ]);
  // The section runs to the end of the body when no heading follows, and a long line folds.
  assert.deepEqual(whatToBuild(`# What to build\n${'y'.repeat(1001)}`), [
    'what to build: 1 line(s)',
    `| ${'y'.repeat(1000)}`,
    '|+ y',
  ]);
  // A missing or empty section, a heading with other words around it, and an HTML body are said plainly.
  assert.deepEqual(whatToBuild('Just text\n## Other\nx'), ['what to build: none in the card text']);
  assert.deepEqual(whatToBuild('## What to build\n\n\n## Next\nx'), ['what to build: none in the card text']);
  assert.deepEqual(whatToBuild('## What to build next\nx'), ['what to build: none in the card text']);
  assert.deepEqual(whatToBuild('<h2>What to build</h2><p>x</p>', 'html'), ['what to build: not extracted from an HTML body, read the card text']);
});

// CommonMark: an ATX heading has 0 to 3 leading spaces, and a line inside a fenced code block
// (3+ backticks or tildes, closed by the same character at least as long) is never a heading.
test('612 fix B1: a heading inside a fenced code block does not end the What to build section', () => {
  assert.deepEqual(
    whatToBuild('## What to build\nGenerate this document:\n```markdown\n## Result\nContents\n```\nThen validate it.'),
    [
      'what to build: 6 line(s)',
      '| Generate this document:',
      '| ```markdown',
      '| ## Result',
      '| Contents',
      '| ```',
      '| Then validate it.',
    ],
  );
});

test('612 fix B2: a What to build heading inside a fenced code block does not start the section', () => {
  assert.deepEqual(
    whatToBuild('```\n## What to build\nfake\n```\n## What to build\nreal'),
    ['what to build: 1 line(s)', '| real'],
  );
});

test('612 fix B3: a What to build heading indented by three spaces still starts the section', () => {
  assert.deepEqual(whatToBuild('   ## What to build\nShip it.'), ['what to build: 1 line(s)', '| Ship it.']);
});

// A backtick fence's info string may not contain a backtick (CommonMark 0.31), so this line is text, not a fence.
test('612 fix B4: a line that opens with backticks and holds another backtick later is not a fence opener', () => {
  assert.deepEqual(whatToBuild('## What to build\n```code``` is inline\n## Next\nafter'), [
    'what to build: 1 line(s)',
    '| ```code``` is inline',
  ]);
});

test('612 fix G: a fence left open at the end of the body makes the summary say so in place of any extract', () => {
  assert.deepEqual(
    whatToBuild('- Example:\n  ```\n  ## Fake\n\n## What to build\nreal'),
    ['what to build: a code fence is left open, read the card text'],
  );
});

// CommonMark: a closing fence may be followed by spaces or tabs only, so a no-break space leaves the line inside the block.
test('612 fix H: a fence closer followed by a no-break space does not close the fence', () => {
  assert.deepEqual(
    whatToBuild('## What to build\n```\nexample\n```\u00a0\n## fake boundary\nstill code\n```\nreal\n## Next\nafter'),
    [
      'what to build: 7 line(s)',
      '| ```',
      '| example',
      '| ```\u00a0',
      '| ## fake boundary',
      '| still code',
      '| ```',
      '| real',
    ],
  );
});

test('612 fix C: a card whose title is not a string prints its section with proposal: no and does not stop the intake', () => {
  const read = { body: '', parent: null, comments: [], commentCount: 0, commentsUnavailable: null };
  const { summary } = intakeOf({
    candidates: [intakeCard(1, READY, 123), intakeCard(2, READY, 'Proposed: a change')],
    claims: [],
    details: new Map([1, 2].map((number) => [number, { ...read, number }])),
  });
  assert.equal(sectionOf(summary, 1).includes('proposal: no'), true, summary.join('\n'));
  assert.equal(sectionOf(summary, 2).includes('proposal: yes'), true, summary.join('\n'));
});

// A line break in the folder would forge a line of the summary that names it.
for (const [form, value] of [['\\n', '/scratch/a\nclaim: none'], ['\\r', '/scratch/a\rclaim: none']]) {
  test(`612 fix E: parseBoardArgs refuses an --intake folder holding a ${form} line break`, () => {
    assert.throws(
      () => parseBoardArgs(['--intake', value]),
      /--intake takes one folder and no other argument — usage: node scripts\/board\.mjs/,
    );
  });
}

test('intakeCardFileName: a card number or an identifier names a file, a hostile id names none', () => {
  for (const id of [612, 'ENG-12', 'AB-7']) assert.equal(intakeCardFileName(id), `${id}.txt`, String(id));
  for (const id of [0, 1.5, -3, Number.MAX_SAFE_INTEGER + 1, '../x', 'a/b', 'ENG-0', '612', '', undefined]) {
    assert.equal(intakeCardFileName(id), null, String(id));
  }
  // The file of a card whose id names none carries a null name for the command to turn into an unavailable card.
  const read = { body: '', parent: null, comments: [], commentCount: 0, commentsUnavailable: null };
  const files = intakeCardFiles({
    candidates: [intakeCard('../x', READY, 'Hostile')],
    claims: [],
    details: new Map([['../x', { ...read, number: '../x' }]]),
  });
  assert.deepEqual(files.map(({ number, name }) => [number, name]), [['../x', null]]);
});

// ── approval mode ────────────────────────────────────────────────────────────
// `--approval check <card>...` reads advance approvals through two injected runners and no board:
// the board ghExec throws, so a case that reads the board fails loud. The runners answer GitHub's
// own GraphQL field names for acme/widgets, and the expected lines are written by hand from the
// fixed approval diagnostics and exit codes. Each run is given its environment, so a run mark
// in the environment running the suite cannot change a line.

const APPROVAL_REPOSITORY = { id: 'R_kgDOwidgets', nameWithOwner: 'acme/widgets' };
const APPROVAL_RECORD_URL = 'https://github.com/acme/widgets/issues/7#issuecomment-1';
const APPROVAL_USAGE = '--approval check <card>...';
// The approval command runs advance-approval.mjs from the toolkit copy, so the checkout holding the running code is
// read through the copy's scripts/lib, never the process directory.
const APPROVAL_CODE_DIRECTORY = join(toolkit.root, 'scripts', 'lib');
const APPROVAL_SETTING_CALLS = [
  'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}',
  `git ls-tree --full-tree --format=%(objectmode) ${'a'.repeat(40)} -- .agents/factory-settings.json`,
  `git show ${'a'.repeat(40)}:.agents/factory-settings.json`,
];
const APPROVAL_ANCESTRY_READ = `git -C ${APPROVAL_CODE_DIRECTORY} rev-list --left-right --count HEAD...${'a'.repeat(40)}`;
const APPROVAL_SETTING_UNAVAILABLE = 'pre-approved run setting unavailable on fetched main; fetch origin and verify .agents/factory-settings.json on main';
// A key the validator in this copy refuses and names, so a leaked refusal would show the marker.
const APPROVAL_REFUSED_SETTINGS = '{"version":1,"preApprovedRun":true,"synthetic-setting-secret":true}';

// The two approval runners and the calls they record: viewer `zain`, card 7 holding a valid record, card 8 none,
// card 9 an unavailable read.
function approvalRunners(settings = {}) {
  const {
    settingOid = 'a'.repeat(40),
    settingMode = '100644\n',
    settingText = '{"version":1,"preApprovedRun":true}',
    settingError,
    jobText,
    ancestry,
  } = settings;
  const calls = [];
  const exec = (callArgs) => {
    calls.push(`gh ${callArgs.join(' ')}`);
    const card = Number(callArgs[callArgs.indexOf('-F') + 1].replace('number=', ''));
    if (card === 9) throw new Error('gh: HTTP 502');
    const comments = card === 7
      ? [{ author: { login: 'zain' }, createdAt: '2026-11-03T09:00:00Z', lastEditedAt: null, url: APPROVAL_RECORD_URL, body: 'Approved: card=7 edited=none' }]
      : [];
    return JSON.stringify({
      data: {
        viewer: { login: 'zain' },
        repository: {
          id: APPROVAL_REPOSITORY.id,
          issue: {
            state: 'OPEN',
            title: 'Show the logo',
            lastEditedAt: null,
            timelineItems: { nodes: [] },
            comments: { pageInfo: { hasNextPage: false }, nodes: comments },
          },
        },
      },
    });
  };
  const git = (callArgs) => {
    calls.push(`git ${callArgs.join(' ')}`);
    const command = JSON.stringify(callArgs);
    if (command === JSON.stringify(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'])) {
      if (settingError) throw settingError;
      return `${settingOid}\n`;
    }
    if (command === JSON.stringify(['ls-tree', '--full-tree', '--format=%(objectmode)', settingOid, '--', '.agents/factory-settings.json'])) return settingMode;
    if (command === JSON.stringify(['show', `${settingOid}:.agents/factory-settings.json`])) return settingText;
    if (command === JSON.stringify(['show', 'HEAD:.agents/factory-settings.json'])) return jobText;
    if (ancestry !== undefined && command === JSON.stringify(['-C', APPROVAL_CODE_DIRECTORY, 'rev-list', '--left-right', '--count', `HEAD...${settingOid}`])) {
      if (ancestry instanceof Error) throw ancestry;
      return ancestry;
    }
    throw new Error(`unexpected approval-mode git read: ${callArgs.join(' ')}`);
  };
  return { exec, git, calls };
}

function approvalRun(args, env = {}, settings = {}) {
  const { exec, git, calls } = approvalRunners(settings);
  let stdout = '';
  let stderr = '';
  const boardRead = (callArgs) => {
    throw new Error(`the approval mode must not read the board: ${callArgs.join(' ')}`);
  };
  const output = {
    log: (line) => { stdout += `${line}\n`; },
    error: (line) => { stderr += `${line}\n`; },
  };
  const status = boardMain(args, { ghExec: boardRead, output, env, approval: { exec, git, repository: APPROVAL_REPOSITORY } });
  return { status, stdout, stderr, calls };
}

function assertSettingRefusal(read, stdout, status, calls = APPROVAL_SETTING_CALLS) {
  assert.equal(read.stdout, stdout);
  assert.equal(read.status, status, read.stderr);
  assert.equal(read.stderr, '');
  assert.doesNotMatch(read.stdout, /post:|synthetic-setting-secret|synthetic\.invalid/);
  assert.deepEqual(read.calls, calls);
}

test("ANTI-REGRESSION: board --approval check prints each card's advance approval line and uses exit 0 for completed judgements, 2 for unavailable reads, and 1 with usage for rejected arguments", () => {
  const read = approvalRun(['--approval', 'check', '7', '8']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(
    read.stdout,
    `approved 7 2026-11-03T09:00:00Z ${APPROVAL_RECORD_URL}\nnot approved 8: no record; post: Approved: card=8 edited=none\n`,
  );
  assert.equal(read.stderr, '');

  const unread = approvalRun(['--approval', 'check', '8', '9']);
  assert.equal(unread.status, 2, unread.stderr);
  assert.equal(unread.stdout, 'not approved 8: no record; post: Approved: card=8 edited=none\nunavailable 9: gh: HTTP 502\n');

  for (const args of [
    ['--approval'],
    ['--approval', 'check'],
    ['--approval', 'check', '0'],
    ['--approval', 'check', 'x'],
    ['--approval', 'line', '7'],
    ['--approval', 'check', '7', '--json'],
  ]) {
    const refused = approvalRun(args);
    const label = args.join(' ');
    assert.equal(refused.status, 1, label);
    assert.match(refused.stderr, /^board: /, label);
    assert.ok(refused.stderr.includes(APPROVAL_USAGE), `${label}: ${refused.stderr}`);
    assert.equal(refused.stdout, '', label);
    assert.deepEqual(refused.calls, [], label);
  }
});

test('ANTI-REGRESSION: board --approval check leaves out the post text under either run mark', () => {
  for (const mark of [{ PRE_APPROVED_RUN_SESSION: '2026-11-04T12:00:00Z' }, { PRODUCT_MANAGER_RUN_SESSION: '1' }]) {
    const read = approvalRun(['--approval', 'check', '7', '8'], mark);
    const label = JSON.stringify(mark);
    assert.equal(read.status, 0, `${label}: ${read.stderr}`);
    assert.equal(read.stdout, `approved 7 2026-11-03T09:00:00Z ${APPROVAL_RECORD_URL}\nnot approved 8: no record\n`, label);
  }
});

test('ANTI-REGRESSION: fetched-main pre-approved setting gates ordinary approval checks', () => {
  const disabled = 'pre-approved run disabled on fetched main; preApprovedRun must be true in .agents/factory-settings.json on main';
  const mainOff = { settingText: '{"version":1,"preApprovedRun":false}', jobText: '{"version":1,"preApprovedRun":true}' };
  const mainOn = { jobText: '{"version":1,"preApprovedRun":false}' };

  const off = approvalRun(['--approval', 'check', '7'], {}, mainOff);
  assertSettingRefusal(off, `not approved 7: ${disabled}\n`, 0);

  const enabled = approvalRun(['--approval', 'check', '7', '8'], {}, mainOn);
  assert.equal(enabled.stdout, `approved 7 2026-11-03T09:00:00Z ${APPROVAL_RECORD_URL}\nnot approved 8: no record; post: Approved: card=8 edited=none\n`);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.stderr, '');
  assert.deepEqual(enabled.calls.filter((call) => call.startsWith('git ')), APPROVAL_SETTING_CALLS);
  assert.equal(enabled.calls.filter((call) => call.startsWith('gh ')).length, 2);
  assert.equal(enabled.calls.some((call) => call.includes('HEAD:.agents/factory-settings.json')), false);

  for (const settings of [
    { settingMode: '' },
    { settingText: '{"version":1}' },
    mainOff,
  ]) {
    for (const cards of [['7'], ['7', '8']]) {
      // The first invocation already covers the single-card false setting.
      if (settings === mainOff && cards.length === 1) continue;
      const read = approvalRun(['--approval', 'check', ...cards], {}, settings);
      const stdout = cards.map((card) => `not approved ${card}: ${disabled}\n`).join('');
      assertSettingRefusal(read, stdout, 0, settings.settingMode === '' ? APPROVAL_SETTING_CALLS.slice(0, 2) : APPROVAL_SETTING_CALLS);
    }
  }

  const reserved = approvalRun(['--approval', 'check', '7', '8'], { PRODUCT_MANAGER_RUN_SESSION: '1' }, mainOff);
  assertSettingRefusal(reserved, `not approved 7: ${disabled}\nnot approved 8: ${disabled}\n`, 0);

  for (const settings of [
    { settingText: '{"version":1,"preApprovedRun":synthetic-setting-secret}' },
    { settingError: Object.assign(new Error('synthetic-setting-secret https://synthetic.invalid/private'), { code: 'PRE_APPROVED_RUN_DISABLED' }) },
  ]) {
    const read = approvalRun(['--approval', 'check', '7', '8'], {}, settings);
    assertSettingRefusal(read, `unavailable 7: ${APPROVAL_SETTING_UNAVAILABLE}\nunavailable 8: ${APPROVAL_SETTING_UNAVAILABLE}\n`, 2, settings.settingError ? APPROVAL_SETTING_CALLS.slice(0, 1) : [...APPROVAL_SETTING_CALLS, APPROVAL_ANCESTRY_READ]);
  }
});

test('ANTI-REGRESSION: an approval check from a checkout behind fetched main names the out-of-date checkout where its code refuses the fetched-main settings', () => {
  const behind = `pre-approved run setting unreadable by the checkout at ${dirname(dirname(APPROVAL_CODE_DIRECTORY))}, which is older than fetched main; bring that checkout up to date with fetched main, then retry`;
  const read = approvalRun(['--approval', 'check', '7', '8'], {}, { settingText: APPROVAL_REFUSED_SETTINGS, ancestry: '0\t3\n' });
  assertSettingRefusal(read, `unavailable 7: ${behind}\nunavailable 8: ${behind}\n`, 2, [...APPROVAL_SETTING_CALLS, APPROVAL_ANCESTRY_READ]);
});

test('ANTI-REGRESSION: an approval check keeps the unavailable message where the checkout is not behind fetched main or the fetched-main settings were never read', () => {
  const secret = new Error('synthetic-setting-secret https://synthetic.invalid/private');
  const refused = [...APPROVAL_SETTING_CALLS, APPROVAL_ANCESTRY_READ];
  for (const [settings, calls] of [
    [{ settingText: APPROVAL_REFUSED_SETTINGS, ancestry: '0\t0\n' }, refused],
    [{ settingText: APPROVAL_REFUSED_SETTINGS, ancestry: '2\t0\n' }, refused],
    [{ settingText: APPROVAL_REFUSED_SETTINGS, ancestry: '2\t3\n' }, refused],
    [{ settingText: APPROVAL_REFUSED_SETTINGS, ancestry: secret }, refused],
    [{ settingText: APPROVAL_REFUSED_SETTINGS, ancestry: 'synthetic-setting-secret\n' }, refused],
    [{ settingError: secret, ancestry: '0\t3\n' }, APPROVAL_SETTING_CALLS.slice(0, 1)],
    [{ settingMode: '120000\n', ancestry: '0\t3\n' }, APPROVAL_SETTING_CALLS.slice(0, 2)],
  ]) {
    assertSettingRefusal(approvalRun(['--approval', 'check', '7'], {}, settings), `unavailable 7: ${APPROVAL_SETTING_UNAVAILABLE}\n`, 2, calls);
  }
});
