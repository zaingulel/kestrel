// board-cli.test.mjs — end-to-end tests for the one board command, scripts/board.mjs.
// Run: node --test scripts/lib/   (or `npm run test:scripts`)
//
// parseBoardArgs, scanBoard and scanOutcome are each proven pure elsewhere; nothing
// there proves they are WIRED. main() could hand scanOutcome a hard-coded
// `closeout: false`, print the scan on the wrong stream, or drop the exit code, and
// every other test in this repository would stay green while the session-start and
// closeout bookends silently degraded to report-only. The wiring is tested by calling
// main with a recording executor and output sink; one positive and one negative proof
// still start the real process against a fake `gh` (`BOARD_TOOLKIT_GH`), so a guard that
// never calls main, or drops its status, cannot pass.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installFakeGh } from './fake-gh.mjs';
import { GITHUB_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

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
  READD_WARNING,
  walkedIssue,
} = await toolkit.load('lib/board-fixtures.mjs');
const { BOARD_OWNER, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
const { BOARD_HELP } = await toolkit.load('lib/board.mjs');
const { main: boardMain } = await toolkit.load('board.mjs');

const SCRIPT = toolkit.script('board.mjs');
const UNQUALIFIED_CLEAN = 'board: no drift found.';

// Only the calls the command makes on these fixtures are answered, each told apart by the
// fixtures' own boardRequestKind: the single-process board walk, and only when it carries
// `--paginate --slurp` (#1155), from FAKE_BOARD; the repository issue walk from FAKE_ISSUES.
// The --intake mode's card-detail reads are `api graphql` without `--paginate`, answered
// from FAKE_DETAILS when a test sets it; unset, the call is unexpected, which is how a
// test makes the detail read fail.
// Anything else fails the fake loud (exit 2) rather than being swallowed, so an
// unanticipated read surfaces here as a failed run instead of a quietly broadened fake.
// Every invocation is logged as a JSON line so a caller can assert that GitHub was never reached.
// Where a test sets FAKE_GH_FLIGHT to a folder, an answered read first marks itself in flight there and holds
// its answer until the folder holds as many marks of its group as the test expects (the two opening reads, or
// FAKE_GH_FLIGHT_DETAILS detail reads) or a bound passes, then records whether it saw them. No mark is ever
// removed, so of reads made one after another the first gives up alone and records that it did.
const fakeGh = installFakeGh('board-cli-', `#!/usr/bin/env node
const { appendFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
async function hold(group, expected) {
  const folder = process.env.FAKE_GH_FLIGHT;
  if (!folder) return;
  writeFileSync(join(folder, group + '-' + process.pid), '');
  const inFlight = () => readdirSync(folder).filter((name) => name.startsWith(group + '-')).length;
  const giveUp = Date.now() + 8000;
  while (inFlight() < expected && Date.now() < giveUp) await new Promise((resolve) => setTimeout(resolve, 10));
  writeFileSync(join(folder, 'seen-' + group + '-' + process.pid), String(inFlight() >= expected));
}
import(${JSON.stringify(pathToFileURL(toolkit.script('lib/board-fixtures.mjs')).href)}).then(async ({ boardRequestKind }) => {
  const kind = boardRequestKind(args);
  if (kind === 'board' && args[0] === 'api' && args[1] === 'graphql' && args.includes('--paginate') && args.includes('--slurp')) {
    await hold('opening', 2);
    process.stdout.write(process.env.FAKE_BOARD);
  } else if (kind === 'issues') {
    await hold('opening', 2);
    process.stdout.write(process.env.FAKE_ISSUES);
  } else if (kind === 'closedIssues') {
    process.stdout.write(process.env.FAKE_ISSUES);
  } else if (kind === 'other' && args[0] === 'api' && args[1] === 'graphql' && !args.includes('--paginate') && process.env.FAKE_DETAILS) {
    await hold('detail', Number(process.env.FAKE_GH_FLIGHT_DETAILS));
    process.stdout.write(process.env.FAKE_DETAILS);
  } else {
    process.stderr.write('unexpected gh invocation: ' + args.join(' '));
    process.exitCode = 2;
  }
});
`);
after(() => fakeGh.cleanup());

// Returns the run plus every `gh` invocation the fake logged, so a caller can assert how
// many calls the command made, not only what it printed. A fresh calls file per run, so
// one run's log can never satisfy another's "no external call happened" assertion.
// `extraEnv` adds to the environment, for the answer to a detail read. The child runs in a fresh folder outside
// any repository and holds no GIT_* variable, so the intake's fetched-main setting read fails the same way in
// every checkout.
function runBoard(args, page, extraEnv = {}) {
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: newIntakeFolder(),
    // One slurped page: the array shape `--slurp` returns. The issue walk finds no card the
    // listing lacks.
    env: fakeGh.env({
      FAKE_BOARD: JSON.stringify([page]),
      FAKE_ISSUES: JSON.stringify([issuesPage([])]),
      FAKE_GH_CALLS: callsFile,
      ...extraEnv,
    }, Object.keys(process.env).filter((name) => name.startsWith('GIT_'))),
  });
  return { ...run, calls: readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

// The in-process twin of runBoard: main is called with an executor that records every call's
// arguments and answers as the fake `gh` does — the slurped board walk, the repository issue
// walk and item reads from `recovery` (by default a walk that finds nothing the listing lacks),
// and a detail read only when `details` is supplied; anything else throws, as a failing `gh`
// makes the real executor throw — and an output sink that collects each stream. `injected`
// adds to main's dependencies, for a write or a directory creation that fails.
async function runBoardInProcess(args, page, details, recovery = {}, injected = {}) {
  let stdout = '';
  let stderr = '';
  const { exec: ghExec, calls } = boardReadExec({ board: [page], other: details, ...recovery });
  const output = {
    log: (line) => { stdout += `${line}\n`; },
    error: (line) => { stderr += `${line}\n`; },
  };
  const status = await boardMain(args, { ghExec, output, ...injected });
  return { status, stdout, stderr, calls };
}

// One raw boardQuery page carrying exactly one nullable-content card. It has enough
// field values to fire no unfielded row, so `unreadable` is the only changed outcome.
const UNREADABLE_PAGE = leanBoardPage([
  leanNode({ id: 'PVTI_unresolved_e2e', content: null, status: 'In progress', routing: 'Product' }),
]);

// A shipped, correctly-parked card: nothing here drifts, so the page is the clean board
// the coverage guard needs to prove it accepts an exact read.
function cleanPage(totalCount) {
  return leanBoardPage([
    leanNode({
      id: 'PVTI_shipped_e2e',
      content: { __typename: 'Issue', number: 610, title: 'Fail loud on an incomplete board read', state: 'CLOSED' },
      status: 'Done',
      routing: 'Platform',
    }),
  ], { totalCount });
}

// The #272 shape, and a PICKABLE one so the same card is both in the default selection
// and in the drift channel — which is what lets the --json test prove the two go to
// different streams.
const DRIFTED_PAGE = leanBoardPage([
  leanNode({
    id: 'PVTI_closed_in_backlog',
    content: { __typename: 'Issue', number: 272, title: 'CVE sweep', state: 'CLOSED' },
    status: 'Backlog',
    routing: 'Product',
  }),
]);

test('board CLI: an unrecognised argument fails loud in the script idiom before any GitHub read', () => {
  // parseBoardArgs throws correctly, but main() must CATCH it: otherwise the operator
  // reads an unhandled-rejection dump above the clear message. The parse runs before the
  // read, so the fake logs nothing — a metered read must never be spent on a typo.
  const run = runBoard(['--closout'], UNREADABLE_PAGE);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /^board: unrecognised argument "--closout"/m);
  assert.match(run.stderr, /usage: node scripts\/board\.mjs/);
  assert.equal(/node:internal|at parseBoardArgs|\n\s+at /.test(run.stderr), false, run.stderr);
  assert.equal(run.stdout, '');
  assert.deepEqual(run.calls, []);
});

test('board CLI: --help prints the modes on stdout and exits 0 before any tracker or GitHub read', async () => {
  const inProcess = await runBoardInProcess(['--help'], UNREADABLE_PAGE);
  assert.equal(inProcess.status, 0);
  assert.equal(inProcess.stdout, `${BOARD_HELP}\n`);
  assert.equal(inProcess.stderr, '');
  assert.deepEqual(inProcess.calls, []);

  const run = runBoard(['--help'], UNREADABLE_PAGE);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${BOARD_HELP}\n`);
  assert.equal(run.stderr, '');
  assert.deepEqual(run.calls, []);
});

// The same #598 defect class one step further in: `--status=Rady` is a well-formed flag,
// so only the column vocabulary can reject it — and it has to reject it HERE, before the
// metered read, or the command spends a board read to report `Rady: 0 of N item(s)`.
test('board CLI: a --status= value that is not a board column fails loud before any GitHub read', async () => {
  const run = await runBoardInProcess(['--status=Rady'], UNREADABLE_PAGE);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /^board: --status=Rady is not a board column/m);
  assert.match(run.stderr, /usage: node scripts\/board\.mjs/);
  assert.equal(run.stdout, '');
  assert.deepEqual(run.calls, []);
});

test('ANTI-REGRESSION (#600 closeout gate, end to end): the real command fails an unreadable board ONLY when --closeout is passed', async () => {
  const ordinary = await runBoardInProcess([], UNREADABLE_PAGE);

  // An ordinary interactive read reports the unread card but is never stranded by it.
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(ordinary.stdout, /⚠ BOARD READ INCOMPLETE/);
  assert.match(ordinary.stdout, /PVTI_unresolved_e2e/);
  // …and still never claims coverage it does not have.
  assert.equal(ordinary.stdout.includes(UNQUALIFIED_CLEAN), false, ordinary.stdout);
  // One read answers both halves: the listing and the scan come off the same walk.
  assert.equal(ordinary.calls.filter((call) => boardRequestKind(call) === 'board').length, 1, ordinary.calls.join('\n'));
  assert.match(
    ordinary.stdout,
    new RegExp(`^Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 0 of 1 item\\(s\\)$`, 'm'),
  );

  // The closeout gate certifies the board, so an admittedly partial read cannot pass.
  // This is the run that dies if `closeout` stops reaching scanOutcome.
  const closeout = await runBoardInProcess(['--closeout'], UNREADABLE_PAGE);

  assert.equal(closeout.status, 1, closeout.stdout);
  assert.match(closeout.stdout, /⚠ BOARD READ INCOMPLETE/);
  assert.match(closeout.stdout, /PVTI_unresolved_e2e/);
  // The gate prints the scan and nothing else — no listing, no header.
  assert.equal(closeout.stdout.includes(`Board ${BOARD_OWNER}`), false, closeout.stdout);
});

test('ANTI-REGRESSION (#610 board coverage, end to end): closeout fails when the board read returns fewer items than totalCount and accepts an exact read', async () => {
  const incomplete = await runBoardInProcess(['--closeout'], cleanPage(2));

  assert.equal(incomplete.status, 1, incomplete.stdout);
  assert.match(incomplete.stderr, /board: failed to read the GitHub Projects board — incomplete board items read:/);
  assert.match(incomplete.stderr, /GitHub reported 2 board items but 1 were fetched/);

  const exact = await runBoardInProcess(['--closeout'], cleanPage(1));

  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.stderr, '');
  assert.equal(exact.stdout, `${UNQUALIFIED_CLEAN}\n`);
});

// --json's stdout is a document a caller parses, so a scan line printed there would
// corrupt it — and a verdict withheld entirely would be the silent-clean defect the scan
// exists to prevent. Both halves are asserted, plus the exit code the ordinary read now
// carries: drift fails the session-start bookend.
test('board CLI: --json puts the selection on stdout and the scan on stderr, and drift still exits 1', async () => {
  const run = await runBoardInProcess(['--json'], DRIFTED_PAGE);

  assert.equal(run.status, 1, run.stderr);
  const selection = JSON.parse(run.stdout);
  assert.deepEqual(selection.map((card) => [card.number, card.status]), [[272, 'Backlog']]);
  assert.equal(run.stdout.includes('BOARD DRIFT'), false, run.stdout);
  assert.match(run.stderr, /⚠ BOARD DRIFT/);
  assert.match(run.stderr, /^#272 \[Backlog\] CVE sweep — issue closed but card still in "Backlog" \(not Done\)$/m);
});

// One open, fielded Backlog card: it fires no drift rule and is the one card the intake
// document details.
const PICKABLE_PAGE = leanBoardPage([
  leanNode({
    id: 'PVTI_pickable_e2e',
    content: { __typename: 'Issue', number: 20, title: 'Pickable card', assignees: ['dev-one'] },
    status: 'Backlog',
    routing: 'Product',
  }),
]);

// The address of a card's one test comment.
const commentUrl = (number) => `https://github.com/example-owner/example/issues/${number}#issuecomment-1`;

// What the single detail read answers for each [number, body, comment] card, each with one comment.
const detailsFor = (...cards) => JSON.stringify({
  data: {
    repository: Object.fromEntries(cards.map(([number, body, comment]) => [`i${number}`, {
      number,
      body,
      parent: null,
      comments: {
        totalCount: 1,
        pageInfo: { hasPreviousPage: false, startCursor: null },
        nodes: [{ body: comment, url: commentUrl(number), author: { login: 'example-owner' } }],
      },
    }])),
  },
});

const linesOf = (stream) => stream.slice(0, -1).split('\n');

// Each --intake run writes its card files into a fresh folder of its own, removed when the file ends.
const intakeFolders = [];
function newIntakeFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'intake-'));
  intakeFolders.push(folder);
  return folder;
}
after(() => intakeFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

test('ANTI-REGRESSION: board CLI --intake puts only the summary on stdout with its true line count, writes each card\'s full text to its file, and puts the scan and outcome on stderr', () => {
  const folder = newIntakeFolder();
  const run = runBoard(['--intake', folder], PICKABLE_PAGE, { FAKE_DETAILS: detailsFor([20, 'Outcome line\nsecond line', 'Claim: m, codex, t']) });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.endsWith('\n'), true);
  const document = linesOf(run.stdout);
  assert.match(
    document[0],
    new RegExp(`^Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 1 of 1 item\\(s\\)$`),
  );
  assert.ok(document.includes('Card summaries: 1 pickable card(s), then 0 claimed card(s) with no closing pull request.'), run.stdout);
  // Nothing stands between the board line and the summaries: the card is named in its summary alone.
  assert.equal(document.indexOf('Card summaries: 1 pickable card(s), then 0 claimed card(s) with no closing pull request.'), 2, run.stdout);
  // The card's summary, written by hand: its facts, its claim and the path and length of its file, but not its body.
  const card = document.indexOf('=== #20 [Backlog] Pickable card ===');
  assert.deepEqual(document.slice(card, card + 13), [
    '=== #20 [Backlog] Pickable card ===',
    'Workstream: Product',
    'labels: —',
    'parent: none',
    'open blockers: none',
    'assignees: @dev-one',
    'proposal: no',
    'claim: comment 1 of 1',
    '| Claim: m, codex, t',
    'owner questions: 0',
    'returned comments: 0',
    'what to build: none in the card text',
    `card text: ${join(folder, '20.txt')}, 15 line(s)`,
  ]);
  assert.equal(run.stdout.includes('Outcome line'), false, run.stdout);
  // The file holds the legend and the card's whole section, ending with a newline.
  assert.equal(readFileSync(join(folder, '20.txt'), 'utf8'), [
    'Lines starting "| " are card text, and "|+ " continues the line above it.',
    '=== #20 [Backlog] Pickable card ===',
    'Workstream: Product',
    'labels: —',
    'parent: none',
    'open blockers: none',
    'assignees: @dev-one',
    'claim: comment 1 of 1',
    '| Claim: m, codex, t',
    'body: 2 line(s)',
    '| Outcome line',
    '| second line',
    'comments: 1',
    '--- comment 1 of 1 ---',
    '| Claim: m, codex, t',
    '',
  ].join('\n'));
  assert.deepEqual(readdirSync(folder), ['20.txt']);
  // The end line counts every line of stdout, itself included, and so does stderr's.
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
  assert.equal(run.stdout.includes(UNQUALIFIED_CLEAN), false, run.stdout);
  assert.deepEqual(linesOf(run.stderr), [
    UNQUALIFIED_CLEAN,
    'board intake: details complete for 1 card(s).',
    `board intake: ${document.length} line(s) on stdout.`,
  ]);
  // The board read, then one detail read: nothing else reached the host but the repository issue walk.
  const kinds = run.calls.map(boardRequestKind);
  assert.equal(kinds.filter((kind) => kind === 'board').length, 1, kinds.join('\n'));
  assert.equal(kinds.filter((kind) => kind === 'other').length, 1, kinds.join('\n'));
  assert.ok(kinds.every((kind) => ['board', 'issues', 'closedIssues', 'other'].includes(kind)), kinds.join('\n'));
});

// Two pickable Backlog cards and one claimed card with no closing pull request. The claim is the stalled-claim
// advisory, so this board exits as the drifted intake does.
const TWO_PICKABLE_PAGE = leanBoardPage([
  leanNode({
    id: 'PVTI_two_first',
    content: { __typename: 'Issue', number: 20, title: 'First pickable card', assignees: ['dev-one'] },
    status: 'Backlog',
    routing: 'Product',
  }),
  leanNode({
    id: 'PVTI_two_second',
    content: { __typename: 'Issue', number: 21, title: 'Second pickable card', assignees: ['dev-one'] },
    status: 'Backlog',
    routing: 'Product',
  }),
  leanNode({
    id: 'PVTI_two_claimed',
    content: { __typename: 'Issue', number: 22, title: 'Claimed card', assignees: ['dev-one'] },
    status: 'In progress',
    routing: 'Product',
  }),
]);

test('the intake summary carries no approval line and makes no approval read', async () => {
  const details = detailsFor([20, 'First outcome', 'a comment'], [21, 'Second outcome', 'a comment'], [22, 'Claimed outcome', 'a comment']);
  // Whatever an approval reader were handed, it records the call; none is made.
  const reads = [];
  const reader = (callArgs) => {
    reads.push(callArgs);
    throw new Error(`an approval read: ${callArgs.join(' ')}`);
  };
  const run = await runBoardInProcess(['--intake', newIntakeFolder()], TWO_PICKABLE_PAGE, details, {}, { approval: { exec: reader, git: reader } });
  const document = linesOf(run.stdout);

  assert.deepEqual(reads, []);
  assert.doesNotMatch(run.stdout, /advance approval|\bapproved\b/i);
  assert.doesNotMatch(run.stderr, /advance approval|\bapproved\b/i);
  // The board line, the listing's blank line, then the summaries.
  assert.equal(document.findIndex((line) => line.startsWith('Card summaries:')), 2, run.stdout);
  assert.equal(run.status, 3, run.stderr);
});

// ── --waits ──────────────────────────────────────────────────────────────────
// `--waits <card>` runs as a real process in a throwaway repository: its fetched main holds the settings file (or
// there is no fetched main), and the saved write-up of card 7 sits in the review folder named for its HEAD. The fake gh
// is on the path and logs every call, so a run that reads GitHub shows in the log. The write-ups are written by hand
// from the pull request template's grammar, and the expected lines from the order of the wait reasons.
const WAIT_REVIEW = 'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0';
const WAIT_CLEAR = [
  '## Not done', '', 'Nothing', '',
  '## Merge Danger', '', 'Undo: easy, a later commit reverts it.', 'Reach: narrow, one file.', '',
  '## Evidence', '', 'no visual change', '', 'Passed: focused tests and lint.', 'Failed: none', 'Untested: none', '',
  '## Review', '', WAIT_REVIEW, '',
].join('\n');
// The reasons of this write-up are check and beyond-card, although its Not done section stands before its Failed line.
const WAIT_TWO_REASONS = WAIT_CLEAR.replace('Nothing', '- The Windows suite was skipped.').replace('Failed: none', 'Failed: lint, cause unknown');
const WAIT_NO_FAILED_LINE = WAIT_CLEAR.replace('Failed: none\n', '');
const waitSettings = (level) => `{"version":1,"waitForOwner":"${level}"}`;
const WAIT_USAGE = '--waits <card>';
const WAIT_ALWAYS = 'every card waits for you: waitForOwner is always';
const WAIT_GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

// A repository whose fetched main holds `settings` (no fetched main when null) and whose review folder of card `card`
// holds `writeUp` (no folder when null) and, given `screenshot`, a saved screenshot. Returns the folder the command runs in.
/** @type {(options: { settings: string | null, writeUp: string | null, card?: number | string, screenshot?: boolean }) => string} */
function waitsRepository({ settings, writeUp, card = 7, screenshot = false }) {
  const folder = newIntakeFolder();
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: folder, encoding: 'utf8', env: WAIT_GIT_ENV });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q');
  mkdirSync(join(folder, '.agents'));
  writeFileSync(join(folder, '.agents', 'factory-settings.json'), settings ?? '{"version":1}');
  git('add', '.');
  git('commit', '-q', '-m', 'settings');
  if (settings !== null) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (writeUp !== null) {
    const review = join(folder, '.claude', 'worklog', `job_${card}-review-${git('rev-parse', 'HEAD')}`);
    mkdirSync(review, { recursive: true });
    writeFileSync(join(review, 'body.md'), writeUp);
    if (screenshot) writeFileSync(join(review, 'screenshot-1.png'), 'Screenshot 1 of the header.\n');
  }
  return folder;
}

// The environment of a fake board holding each [number, labels] card, which the command's board read is answered from.
const waitsBoard = (...cards) => ({
  FAKE_BOARD: JSON.stringify([leanBoardPage(cards.map(([number, labels]) => leanNode({
    id: `PVTI_waits_${number}`,
    content: { __typename: 'Issue', number, title: `Waits card ${number}`, labels },
    status: 'In progress',
    routing: 'Product',
  })))]),
  FAKE_ISSUES: JSON.stringify([issuesPage([])]),
});

// Whether every call a run made is a read of the board, so none reached a pull request.
const readsBoardOnly = (calls) => calls.length > 0 && calls.every((args) => ['board', 'issues', 'closedIssues'].includes(boardRequestKind(args)));

function runWaits(args, folder, extraEnv = {}) {
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: folder,
    env: fakeGh.env({ FAKE_GH_CALLS: callsFile, ...extraEnv }, Object.keys(process.env).filter((name) => name.startsWith('GIT_'))),
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls: readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

test('ANTI-REGRESSION: board --waits prints each reason the saved write-up of the card at HEAD holds, merges where none holds, waits for every card at always, exits 2 for an unreadable write-up or setting and 1 with usage for rejected arguments', () => {
  const whenNeeded = waitSettings('when-needed');
  const always = waitSettings('always');
  const answered = /** @type {[string, { settings: string | null, writeUp: string | null }, string][]} */ ([
    ['a clear write-up at when-needed', { settings: whenNeeded, writeUp: WAIT_CLEAR }, 'merges 7\n'],
    ['two reasons, in the order of the wait reasons', { settings: whenNeeded, writeUp: WAIT_TWO_REASONS }, 'waits 7: check; beyond-card\n'],
    ['a clear write-up at always', { settings: always, writeUp: WAIT_CLEAR }, `waits 7: ${WAIT_ALWAYS}\n`],
    ['a held write-up at always', { settings: always, writeUp: WAIT_TWO_REASONS }, `waits 7: check; beyond-card; ${WAIT_ALWAYS}\n`],
  ]);
  for (const [row, repository, stdout] of answered) {
    const { calls, ...run } = runWaits(['--waits', '7'], waitsRepository(repository), waitsBoard([7, []]));
    assert.deepEqual(run, { status: 0, stdout, stderr: '' }, row);
    assert.ok(readsBoardOnly(calls), `${row}: ${JSON.stringify(calls)}`);
  }

  const unreadable = /** @type {[string, { settings: string | null, writeUp: string | null }][]} */ ([
    ['no saved write-up at HEAD', { settings: whenNeeded, writeUp: null }],
    ['a write-up with no Failed line', { settings: whenNeeded, writeUp: WAIT_NO_FAILED_LINE }],
    ['no fetched main', { settings: null, writeUp: WAIT_CLEAR }],
    ['a level the setting does not allow', { settings: waitSettings('sometimes'), writeUp: WAIT_CLEAR }],
  ]);
  for (const [row, repository] of unreadable) {
    const run = runWaits(['--waits', '7'], waitsRepository(repository));
    assert.equal(run.status, 2, `${row}: ${run.stderr}`);
    assert.equal(run.stdout, '', row);
    assert.ok(run.stderr.split('\n').some((line) => line.startsWith('unreadable 7: ')), `${row}: ${run.stderr}`);
    assert.deepEqual(run.calls, [], row);
  }

  const folder = waitsRepository({ settings: whenNeeded, writeUp: WAIT_CLEAR });
  const rejected = /** @type {[string, string[]][]} */ ([
    ['no card', ['--waits']],
    ['a card that is neither a number nor an identifier', ['--waits', 'abc']],
    ['two cards', ['--waits', '7', '8']],
    ['another mode beside it', ['--waits', '7', '--intake', newIntakeFolder()]],
  ]);
  for (const [row, args] of rejected) {
    const run = runWaits(args, folder);
    assert.equal(run.status, 1, `${row}: ${run.stderr}`);
    assert.equal(run.stdout, '', row);
    assert.ok(run.stderr.includes(WAIT_USAGE), `${row}: ${run.stderr}`);
    assert.deepEqual(run.calls, [], row);
  }
});

test('ANTI-REGRESSION: the waits command holds a card carrying show-me-first, holds work on screen at on-screen, and exits 2 when the board cannot show the card', () => {
  const whenNeeded = waitSettings('when-needed');
  const onScreen = waitSettings('on-screen');
  const always = waitSettings('always');
  const screenWork = WAIT_CLEAR.replace('no visual change\n\n', '');
  const marked = waitsBoard([7, ['show-me-first']]);
  const unmarked = waitsBoard([7, []]);
  const answered = /** @type {[string, { settings: string | null, writeUp: string | null, screenshot?: boolean }, ReturnType<typeof waitsBoard>, string][]} */ ([
    ['a marked card with a clear write-up at when-needed', { settings: whenNeeded, writeUp: WAIT_CLEAR }, marked, 'waits 7: show-me-first\n'],
    ['a marked card at always, before the line for every card', { settings: always, writeUp: WAIT_CLEAR }, marked, `waits 7: show-me-first; ${WAIT_ALWAYS}\n`],
    ['unmarked work on screen at on-screen', { settings: onScreen, writeUp: screenWork, screenshot: true }, unmarked, 'waits 7: on-screen\n'],
    ['marked work on screen at on-screen', { settings: onScreen, writeUp: screenWork, screenshot: true }, marked, 'waits 7: on-screen; show-me-first\n'],
    ['unmarked work on screen at when-needed', { settings: whenNeeded, writeUp: screenWork, screenshot: true }, unmarked, 'merges 7\n'],
    ['unmarked work with no visual change at on-screen', { settings: onScreen, writeUp: WAIT_CLEAR }, unmarked, 'merges 7\n'],
  ]);
  for (const [row, repository, board, stdout] of answered) {
    const { calls, ...run } = runWaits(['--waits', '7'], waitsRepository(repository), board);
    assert.deepEqual(run, { status: 0, stdout, stderr: '' }, row);
    assert.ok(readsBoardOnly(calls), `${row}: ${JSON.stringify(calls)}`);
  }

  const settled = { settings: whenNeeded, writeUp: WAIT_CLEAR };
  const unreadable = /** @type {[string, string[], string, ReturnType<typeof waitsBoard>, string][]} */ ([
    ['a card the board does not hold', ['--waits', '7'], waitsRepository(settled), waitsBoard([8, []]), 'unreadable 7: card 7 is not on the board'],
    ['an identifier the board does not hold', ['--waits', 'ABC-7'], waitsRepository({ ...settled, card: 'ABC-7' }), unmarked, 'unreadable ABC-7: card ABC-7 is not on the board'],
  ]);
  for (const [row, args, folder, board, line] of unreadable) {
    const run = runWaits(args, folder, board);
    assert.equal(run.status, 2, `${row}: ${run.stderr}`);
    assert.equal(run.stdout, '', row);
    assert.ok(run.stderr.split('\n').includes(line), `${row}: ${run.stderr}`);
    assert.ok(readsBoardOnly(run.calls), `${row}: ${JSON.stringify(run.calls)}`);
  }

  // A board read that fails: the board answers bytes that are not JSON.
  const failed = runWaits(['--waits', '7'], waitsRepository(settled), { ...unmarked, FAKE_BOARD: 'not json' });
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.stdout, '');
  assert.ok(failed.stderr.split('\n').some((line) => line.startsWith('unreadable 7: ')), failed.stderr);
  assert.ok(readsBoardOnly(failed.calls), JSON.stringify(failed.calls));
});

// new behaviour: in a Herdr job only the show-me-first marker holds, so `--herdr` prints the verdict a Herdr job's guard
// makes, where an unmarked card's sign-off tier and the level always hold nothing; without it the line is unchanged.
test('967 board --waits --herdr prints the Herdr verdict', () => {
  const signOff = { settings: waitSettings('always'), writeUp: WAIT_CLEAR.replace('tier=code', 'tier=sign-off') };
  const rows = /** @type {[string, string[], string][]} */ ([
    ['with --herdr', ['--waits', '7', '--herdr'], 'merges 7\n'],
    ['without --herdr', ['--waits', '7'], `waits 7: sign-off; ${WAIT_ALWAYS}\n`],
  ]);
  for (const [row, args, stdout] of rows) {
    const { calls, ...run } = runWaits(args, waitsRepository(signOff), waitsBoard([7, []]));
    assert.deepEqual(run, { status: 0, stdout, stderr: '' }, row);
    assert.ok(readsBoardOnly(calls), `${row}: ${JSON.stringify(calls)}`);
  }
});

test('ANTI-REGRESSION: an intake board read that failed, drift and an unavailable card detail exit 2, 3 and 4', async () => {
  const failed = await runBoardInProcess(['--intake', newIntakeFolder()], cleanPage(2));

  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /board: failed to read the GitHub Projects board — incomplete board items read:/);
  assert.match(failed.stderr, /GitHub reported 2 board items but 1 were fetched/);

  const driftFolder = newIntakeFolder();
  const drifted = await runBoardInProcess(['--intake', driftFolder], DRIFTED_PAGE, detailsFor([272, 'CVE body', 'a comment']));

  assert.equal(drifted.status, 3, drifted.stderr);
  assert.ok(linesOf(drifted.stdout).includes('=== #272 [Backlog] CVE sweep ==='), drifted.stdout);
  assert.ok(linesOf(drifted.stdout).includes(`card text: ${join(driftFolder, '272.txt')}, 13 line(s)`), drifted.stdout);
  assert.match(readFileSync(join(driftFolder, '272.txt'), 'utf8'), /^\| CVE body$/m);
  assert.match(drifted.stderr, /⚠ BOARD DRIFT/);
  assert.match(drifted.stderr, /^board intake: details complete for 1 card\(s\)\.$/m);

  // No details supplied: the executor refuses the detail read, so the card's details are unread.
  const unreadFolder = newIntakeFolder();
  const unread = await runBoardInProcess(['--intake', unreadFolder], PICKABLE_PAGE);

  assert.equal(unread.status, 4, unread.stderr);
  const document = linesOf(unread.stdout);
  assert.ok(document.some((line) => line.startsWith('details: UNAVAILABLE — ')), unread.stdout);
  assert.equal(document.some((line) => line.startsWith('body:') || line.startsWith('card text:')), false, unread.stdout);
  assert.deepEqual(readdirSync(unreadFolder), []);
  assert.match(unread.stderr, /^board intake: details UNAVAILABLE in whole or part for 1 of 1 card\(s\): #20\.$/m);
});

// Twenty-one open, fielded Backlog cards: one more than a detail read names, so the intake reads their details
// in two batches, cards 1 to 20 and then card 21.
const TWO_BATCH_NUMBERS = Array.from({ length: 21 }, (_, index) => index + 1);
const TWO_BATCH_PAGE = leanBoardPage(TWO_BATCH_NUMBERS.map((number) => leanNode({
  id: `PVTI_batch_${number}`,
  content: { __typename: 'Issue', number, title: `Batch card ${number}` },
  status: 'Backlog',
  routing: 'Product',
})));

test('ANTI-REGRESSION: one intake detail batch that fails among several leaves only its own cards UNAVAILABLE and exits 4', async () => {
  const folder = newIntakeFolder();
  // The read naming card 1 fails as a failing `gh` does; the read of card 21 alone answers.
  const details = (args) => {
    if (/\bi1: /.test(args.at(-1))) throw Object.assign(new Error('Command failed: gh api graphql'), { stderr: 'HTTP 502: Bad Gateway\n' });
    return detailsFor([21, 'Card 21 outcome', 'a comment']);
  };

  const run = await runBoardInProcess(['--intake', folder], TWO_BATCH_PAGE, details);

  assert.equal(run.status, 4, run.stderr);
  const document = linesOf(run.stdout);
  assert.equal(document.filter((line) => line === 'details: UNAVAILABLE — HTTP 502: Bad Gateway').length, 20, run.stdout);
  // Card 21's file: the legend, its seven facts, its one-line body under a count, and its one comment under a count and a rule.
  assert.deepEqual(document.filter((line) => line.startsWith('card text: ')), [`card text: ${join(folder, '21.txt')}, 13 line(s)`]);
  assert.match(readFileSync(join(folder, '21.txt'), 'utf8'), /^\| Card 21 outcome$/m);
  assert.deepEqual(readdirSync(folder), ['21.txt']);
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
  const lost = TWO_BATCH_NUMBERS.slice(0, 20).map((number) => `#${number}`).join(', ');
  assert.ok(linesOf(run.stderr).includes(`board intake: details UNAVAILABLE in whole or part for 20 of 21 card(s): ${lost}.`), run.stderr);
});

test('ANTI-REGRESSION: an every-issue read that fails beside a good listing fails the board read with its cause, and a failed listing is the cause named when both fail', async () => {
  const walkFails = { issues: () => { throw new Error('the every-issue read failed: HTTP 502'); } };

  const plain = await runBoardInProcess([], PICKABLE_PAGE, undefined, walkFails);

  assert.equal(plain.status, 1, plain.stderr);
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, 'board: failed to read the GitHub Projects board — the every-issue read failed: HTTP 502\n');

  const folder = newIntakeFolder();
  const intake = await runBoardInProcess(['--intake', folder], PICKABLE_PAGE, detailsFor([20, 'Outcome', 'a comment']), walkFails);

  assert.equal(intake.status, 2, intake.stderr);
  assert.equal(intake.stdout, '');
  assert.equal(intake.stderr, 'board: failed to read the GitHub Projects board — the every-issue read failed: HTTP 502\n');
  assert.deepEqual(readdirSync(folder), []);

  const bothFolder = newIntakeFolder();
  const both = await runBoardInProcess(['--intake', bothFolder], PICKABLE_PAGE, detailsFor([20, 'Outcome', 'a comment']), {
    ...walkFails,
    board: () => { throw new Error('the listing failed: HTTP 401'); },
  });

  assert.equal(both.status, 2, both.stderr);
  assert.equal(both.stdout, '');
  assert.equal(both.stderr, 'board: failed to read the GitHub Projects board — the listing failed: HTTP 401\n');
  assert.deepEqual(readdirSync(bothFolder), []);
});

test('a board that stays unavailable prints the plain cause, then the raw command as a details line', async () => {
  // A failed `gh` call as Node's execFileSync throws it when GitHub's error body is not JSON.
  const unavailable = () => { throw Object.assign(new Error('Command failed: gh api graphql --paginate --slurp -f query=...\ngh: HTTP 503\n'), { status: 1, stderr: 'gh: HTTP 503\n' }); };
  const pauses = [];

  const run = await runBoardInProcess([], PICKABLE_PAGE, undefined, { board: unavailable, issues: unavailable, closedIssues: unavailable }, { pause: (ms) => pauses.push(ms) });

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, [
    'board: failed to read the GitHub Projects board — GitHub is temporarily unavailable (HTTP 503), still after 3 retries. Nothing retries on its own: try again in a minute.',
    'board: details: Command failed: gh api graphql --paginate --slurp -f query=... gh: HTTP 503',
    '',
  ].join('\n'));
  assert.deepEqual(pauses, [1000, 4000, 9000]);
});

test("the command's retry budget starts before its opening reads", async () => {
  let clock = 0;
  const pauses = [];
  // The listing takes 89 500 ms to answer 503, so a retry that waits and takes as long again cannot finish in 90 000.
  const slowUnavailable = () => {
    clock += 89_500;
    throw Object.assign(new Error('Command failed: gh api graphql --paginate --slurp -f query=...\ngh: HTTP 503\n'), { status: 1, stderr: 'gh: HTTP 503\n' });
  };

  const run = await runBoardInProcess([], PICKABLE_PAGE, undefined, { board: slowUnavailable }, { now: () => clock, pause: (ms) => pauses.push(ms) });

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, [
    'board: failed to read the GitHub Projects board — GitHub is temporarily unavailable (HTTP 503). Nothing retries on its own: try again in a minute.',
    'board: details: Command failed: gh api graphql --paginate --slurp -f query=... gh: HTTP 503',
    '',
  ].join('\n'));
  assert.deepEqual(pauses, []);
});

test('a board read refused for an expired sign-in prints the plain cause, then the raw failure as a details line', async () => {
  const refused = () => { throw Object.assign(new Error('Command failed: gh api graphql -f query=q\ngh: Bad credentials (HTTP 401)\n'), { status: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' }); };

  const run = await runBoardInProcess([], PICKABLE_PAGE, undefined, { board: refused, issues: refused, closedIssues: refused }, { pause: () => {} });

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, [
    'board: failed to read the GitHub Projects board — GitHub did not accept the saved sign-in (HTTP 401). Sign in again with gh auth login, then read again.',
    'board: details: Command failed: gh api graphql -f query=q gh: Bad credentials (HTTP 401)',
    '',
  ].join('\n'));
});

test('a --waits read that stays unavailable prints the plain cause, then the raw command as a details line', async () => {
  const unavailable = () => { throw Object.assign(new Error('Command failed: gh api graphql --paginate --slurp -f query=...\ngh: HTTP 503\n'), { status: 1, stderr: 'gh: HTTP 503\n' }); };

  // The command judges the saved write-up at HEAD of the working directory before it reads the board.
  const folder = waitsRepository({ settings: waitSettings('when-needed'), writeUp: WAIT_CLEAR, card: 20 });
  const home = process.cwd();
  process.chdir(folder);
  let run;
  try {
    run = await runBoardInProcess(['--waits', '20'], PICKABLE_PAGE, undefined, { board: unavailable, issues: unavailable, closedIssues: unavailable }, { pause: () => {} });
  } finally {
    process.chdir(home);
  }

  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, [
    'unreadable 20: GitHub is temporarily unavailable (HTTP 503), still after 3 retries. Nothing retries on its own: try again in a minute.',
    'board: details: Command failed: gh api graphql --paginate --slurp -f query=... gh: HTTP 503',
    '',
  ].join('\n'));
});

test('the closed issue walk is requested only after the open issue walk has answered, so an issue closed between them is recovered', async () => {
  const card = { id: 'PVTI_closed_between', content: { __typename: 'Issue', number: 41, title: 'Closed between the walks', state: 'CLOSED' }, status: 'Done', routing: 'Product' };
  let openWalkAnswered = false;
  const { exec } = boardReadExec({
    board: [PICKABLE_PAGE],
    // The open walk answers without #41, which closed by then; the closed walk has it only once it starts late.
    issues: [issuesPage([walkedIssue(20, [membership('PVTI_pickable_e2e')])])],
    closedIssues: () => [issuesPage([...(openWalkAnswered ? [walkedIssue(41, [membership(card.id)])] : [])])],
    items: [hydratedItem(card)],
  });
  // A read is answered from what GitHub holds when it starts, and delivered a turn of the event loop later; the
  // open walk's delivery is what the closed walk must start after.
  const ghStart = (args) => new Promise((resolve) => {
    const kind = boardRequestKind(args);
    const reply = (() => { try { const value = exec(args); return () => value; } catch (error) { return () => { throw error; }; } })();
    setImmediate(() => {
      if (kind === 'issues') openWalkAnswered = true;
      resolve(reply);
    });
  });

  const run = await runBoardInProcess(['--json', '--all'], PICKABLE_PAGE, undefined, {}, { ghExec: exec, ghStart });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).map((item) => item.number).filter((number) => number === 41), [41]);
});

// What each held read of a group recorded in the flight folder: whether it saw its whole group in flight
// before it answered.
const flightSeen = (folder, group) => readdirSync(folder)
  .filter((name) => name.startsWith(`seen-${group}-`))
  .map((name) => readFileSync(join(folder, name), 'utf8'));

const TWO_BATCH_DETAILS = detailsFor(...TWO_BATCH_NUMBERS.map((number) => [number, `Card ${number} outcome`, 'a comment']));

test('the plain board read has its listing and the open issue walk in flight at the same time', () => {
  const flight = newIntakeFolder();

  const run = runBoard([], PICKABLE_PAGE, { FAKE_GH_FLIGHT: flight });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(flightSeen(flight, 'opening'), ['true', 'true']);
});

test('the intake has its listing and the open issue walk in flight at the same time, and then its detail batches', () => {
  const flight = newIntakeFolder();
  const folder = newIntakeFolder();

  const run = runBoard(['--intake', folder], TWO_BATCH_PAGE, { FAKE_DETAILS: TWO_BATCH_DETAILS, FAKE_GH_FLIGHT: flight, FAKE_GH_FLIGHT_DETAILS: '2' });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(readdirSync(folder).length, TWO_BATCH_NUMBERS.length);
  assert.deepEqual(flightSeen(flight, 'opening'), ['true', 'true']);
  assert.deepEqual(flightSeen(flight, 'detail'), ['true', 'true']);
});

test('the intake starts its detail batches together', async () => {
  const { exec } = boardReadExec({ board: [TWO_BATCH_PAGE], other: TWO_BATCH_DETAILS });
  // A started read is in flight from its start until it settles, a turn of the event loop later.
  const inFlight = new Set();
  let mostDetailReadsInFlight = 0;
  const ghStart = (args) => new Promise((resolve) => {
    const read = { kind: boardRequestKind(args) };
    inFlight.add(read);
    mostDetailReadsInFlight = Math.max(mostDetailReadsInFlight, [...inFlight].filter(({ kind }) => kind === 'other').length);
    setImmediate(() => {
      inFlight.delete(read);
      const reply = exec(args);
      resolve(() => reply);
    });
  });

  const run = await runBoardInProcess(['--intake', newIntakeFolder()], TWO_BATCH_PAGE, TWO_BATCH_DETAILS, {}, { ghStart });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(mostDetailReadsInFlight, 2, 'the two detail batches were not started together');
});

test('ANTI-REGRESSION: an intake card text that cannot be written leaves that card UNAVAILABLE with no file named and exits 4', async () => {
  const recovery = recoveryOf('PVTI_pickable_e2e', 20, RECOVERED_PICKABLE);
  const details = detailsFor([20, 'Listed outcome', 'a comment'], [21, 'Recovered outcome', 'a comment']);
  const folder = newIntakeFolder();
  const writeFile = (path, text) => {
    if (path.endsWith('21.txt')) throw new Error('no space left on device');
    writeFileSync(path, text);
  };

  const run = await runBoardInProcess(['--intake', folder], PICKABLE_PAGE, details, recovery, { writeFile });

  assert.equal(run.status, 4, run.stderr);
  const document = linesOf(run.stdout);
  const unavailable = document.indexOf('=== #21 [Backlog] Recovered card ===');
  assert.deepEqual(document.slice(unavailable, unavailable + 6), [
    '=== #21 [Backlog] Recovered card ===',
    'Workstream: Product',
    'labels: —',
    'open blockers: none',
    'assignees: none',
    'details: UNAVAILABLE — could not write the card text: no space left on device',
  ]);
  assert.equal(document.filter((line) => line.startsWith('card text: ')).length, 1, run.stdout);
  assert.ok(document.some((line) => line.startsWith(`card text: ${join(folder, '20.txt')}, `)), run.stdout);
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
  assert.match(run.stderr, /^board intake: details UNAVAILABLE in whole or part for 1 of 2 card\(s\): #21\.$/m);
  assert.deepEqual(readdirSync(folder), ['20.txt']);
});

test('ANTI-REGRESSION: an intake folder that cannot be created exits 1 before any board read', async () => {
  const folder = join(tmpdir(), 'intake-never-made');
  const makeDirectory = () => { throw new Error('read-only file system'); };

  const run = await runBoardInProcess(['--intake', folder], PICKABLE_PAGE, undefined, {}, { makeDirectory });

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, `board: could not create ${folder}: read-only file system\n`);
  assert.deepEqual(run.calls, []);
});

test('board CLI: --intake without a folder is a rejected argument that reads nothing', async () => {
  const run = await runBoardInProcess(['--intake'], PICKABLE_PAGE);

  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^board: --intake takes one folder and no other argument — /);
  assert.deepEqual(run.calls, []);
});

// The #504 incident end to end: GitHub's project listing leaves out a card that is on the board,
// and the repository issue walk finds it. Each expected line is written by hand from the fixtures.
const recoveryOf = (listedId, listedNumber, card) => ({
  issues: [issuesPage([
    walkedIssue(listedNumber, [membership(listedId)]),
    walkedIssue(card.content.number, [membership(card.id)]),
  ])],
  items: [hydratedItem(card)],
});

const RECOVERED_PICKABLE = {
  id: 'PVTI_recovered_e2e',
  content: { __typename: 'Issue', number: 21, title: 'Recovered card' },
  status: 'Backlog',
  routing: 'Product',
};

const RECOVERED_CLOSED_IN_BACKLOG = {
  id: 'PVTI_recovered_closed_e2e',
  content: { __typename: 'Issue', number: 272, title: 'CVE sweep', state: 'CLOSED' },
  status: 'Backlog',
  routing: 'Product',
};

// The omission advisory names each recovered card and its item and warns against adding it again.
function assertOmissionAdvisory(stream, card) {
  assert.match(stream, new RegExp(`#${card.content.number}(?!\\d)`));
  assert.ok(stream.includes(card.id), stream);
  assert.match(stream, READD_WARNING);
}

test('ANTI-REGRESSION: recovered cards reach intake and closeout', async () => {
  const recovery = recoveryOf('PVTI_pickable_e2e', 20, RECOVERED_PICKABLE);
  const details = detailsFor([20, 'Listed outcome', 'a comment'], [21, 'Recovered outcome', 'a comment']);

  const folder = newIntakeFolder();
  const intake = await runBoardInProcess(['--intake', folder], PICKABLE_PAGE, details, recovery);

  assert.equal(intake.status, 0, intake.stderr);
  const document = linesOf(intake.stdout);
  assert.match(
    document[0],
    new RegExp(`^Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 2 of 2 item\\(s\\)$`),
  );
  assert.ok(document.includes('=== #21 [Backlog] Recovered card ==='), intake.stdout);
  assert.ok(document.includes(`card text: ${join(folder, '21.txt')}, 13 line(s)`), intake.stdout);
  assert.match(readFileSync(join(folder, '21.txt'), 'utf8'), /^\| Recovered outcome$/m);
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
  assert.equal(intake.stdout.includes(RECOVERED_PICKABLE.id), false, intake.stdout);
  assertOmissionAdvisory(intake.stderr, RECOVERED_PICKABLE);
  assert.match(intake.stderr, /^board intake: details complete for 2 card\(s\)\.$/m);

  // Under --json stdout stays the parseable selection, the recovered card in it, and the advisory goes to stderr.
  const json = await runBoardInProcess(['--json'], PICKABLE_PAGE, undefined, recovery);

  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).map((card) => card.number).sort((a, b) => a - b), [20, 21]);
  assertOmissionAdvisory(json.stderr, RECOVERED_PICKABLE);

  // A recovered closed card still in Backlog is closeout drift, so the proof gate refuses.
  const closeout = await runBoardInProcess(
    ['--closeout'],
    cleanPage(1),
    undefined,
    recoveryOf('PVTI_shipped_e2e', 610, RECOVERED_CLOSED_IN_BACKLOG),
  );

  assert.equal(closeout.status, 1, closeout.stdout + closeout.stderr);
  assert.match(closeout.stdout, /⚠ BOARD DRIFT/);
  assert.match(closeout.stdout, /^#272 \[Backlog\] CVE sweep — issue closed but card still in "Backlog" \(not Done\)$/m);
  assert.equal(closeout.stdout.includes(RECOVERED_CLOSED_IN_BACKLOG.id), false, closeout.stdout);
  assertOmissionAdvisory(closeout.stderr, RECOVERED_CLOSED_IN_BACKLOG);
});

const BOARD_LINE = (shown, total) => new RegExp(
  `^Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: ${shown} of ${total} item\\(s\\)$`,
);

test('the intake document names each card once, with its labels in its section', async () => {
  // Two pickable cards, one labelled, and one claimed card with no closing pull request.
  const page = leanBoardPage([
    leanNode({
      id: 'PVTI_once_labelled',
      content: { __typename: 'Issue', number: 30, title: 'Labelled card', labels: ['type:task', 'plan-first'] },
      status: 'Ready',
      routing: 'Platform',
    }),
    leanNode({
      id: 'PVTI_once_plain',
      content: { __typename: 'Issue', number: 31, title: 'Plain card' },
      status: 'Backlog',
      routing: 'Product',
    }),
    leanNode({
      id: 'PVTI_once_claimed',
      content: { __typename: 'Issue', number: 32, title: 'Claimed card', assignees: ['dev-one'] },
      status: 'In progress',
      routing: 'Product',
    }),
  ]);
  const details = detailsFor([30, 'Labelled outcome', 'a comment'], [31, 'Plain outcome', 'a comment'], [32, 'Claimed outcome', 'a comment']);

  const run = await runBoardInProcess(['--intake', newIntakeFolder()], page, details);

  const document = linesOf(run.stdout);
  assert.match(document[0], BOARD_LINE(2, 3));
  // The board line and the summaries: no listing of the cards stands before them.
  assert.deepEqual(document.slice(1, 4), [
    '',
    'Card summaries: 2 pickable card(s), then 1 claimed card(s) with no closing pull request.',
    // The GitHub read keeps the board's own order, and no Ready card here is missing from the listing.
    "Ready order: the board's, top of the column first; Backlog follows by card number.",
  ]);
  for (const number of [30, 31, 32]) {
    const naming = new RegExp(`^(?:=== )?#${number} \\[`);
    assert.deepEqual(
      document.filter((line) => naming.test(line)).length,
      1,
      `card #${number} is named on more or fewer lines than one:\n${run.stdout}`,
    );
  }
  assert.deepEqual(document.filter((line) => line.startsWith('── ')), [], run.stdout);
  // The labels the listing row gave now stand in the card's own section, under its Workstream.
  const labelled = document.indexOf('=== #30 [Ready] Labelled card ===');
  assert.deepEqual(document.slice(labelled, labelled + 3), [
    '=== #30 [Ready] Labelled card ===',
    'Workstream: Platform',
    'labels: type:task, plan-first',
  ]);
  const plain = document.indexOf('=== #31 [Backlog] Plain card ===');
  assert.deepEqual(document.slice(plain + 1, plain + 3), ['Workstream: Product', 'labels: —']);
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
});

test('the intake keeps a row for a pickable card with no number and the warning for an unrecognised Workstream', async () => {
  // A draft has no issue number, so it has no summary; the row is the only place the document names it.
  const page = leanBoardPage([
    leanNode({ id: 'PVTI_numberless_draft', content: { __typename: 'DraftIssue' }, title: 'draft note', status: 'Backlog', routing: 'Product' }),
    leanNode({
      id: 'PVTI_unknown_workstream',
      content: { __typename: 'Issue', number: 40, title: 'Zulu card' },
      status: 'Backlog',
      routing: 'Zulu',
    }),
  ]);

  const run = await runBoardInProcess(['--intake', newIntakeFolder()], page, detailsFor([40, 'Zulu outcome', 'a comment']));

  const document = linesOf(run.stdout);
  assert.match(document[0], BOARD_LINE(2, 2));
  assert.deepEqual(document.slice(1, 10), [
    '',
    'Pickable cards with no issue number, which have no summary: 1',
    '── Product (1) ──',
    '#? [Backlog] draft note',
    '    —',
    '',
    'WARNING: unrecognised Workstream value: Zulu; add Zulu to ROUTING_OPTIONS in scripts/lib/board-config.mjs.',
    '',
    'Card summaries: 1 pickable card(s), then 0 claimed card(s) with no closing pull request. 1 card(s) with no issue number have no details.',
  ]);
  // The numbered card is named in its summary alone.
  assert.equal(document.filter((line) => /^(?:=== )?#40 \[/.test(line)).length, 1, run.stdout);
  assert.equal(document.at(-1), `board intake: end of document, ${document.length} line(s).`);
});

test('the intake names who posted a held card\'s question and where', async () => {
  const run = await runBoardInProcess(
    ['--intake', newIntakeFolder()],
    PICKABLE_PAGE,
    detailsFor([20, 'Outcome', 'Needs owner: Which tracker?']),
  );

  assert.equal(run.status, 0, run.stderr);
  const document = linesOf(run.stdout);
  const question = document.indexOf('owner questions: 1');
  assert.deepEqual(document.slice(question, question + 5), [
    'owner questions: 1',
    '--- comment 1 of 1 ---',
    `posted by: @example-owner ${commentUrl(20)}`,
    '| Needs owner: Which tracker?',
    'returned comments: 0',
  ]);
});
