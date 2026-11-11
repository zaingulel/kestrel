import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { installFakeGh } from './fake-gh.mjs';
import { GITHUB_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';

// The command runs from a toolkit copy wired to the literal test configuration, so no case
// depends on the board this install's own board-config.mjs names.
const toolkit = copyToolkit(GITHUB_TEST_CONFIG);
after(() => toolkit.cleanup());
const { BOARD_CLAIM_HELP, RUNTIMES, main } = await toolkit.load('lib/board-claim.mjs');
const { BOARD_OWNER, BOARD_OWNER_TYPE, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY } = await toolkit.load('lib/board-config.mjs');
const { claimLines } = await toolkit.load('lib/board.mjs');

const SCRIPT = toolkit.script('board-claim.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'board-claim-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function outputSink() {
  const sink = { stdout: '', stderr: '' };
  sink.log = (line) => { sink.stdout += `${line}\n`; };
  sink.error = (line) => { sink.stderr += `${line}\n`; };
  return sink;
}

// Every `gh` call is recorded and fails, so a call that should not happen is both counted and
// unable to make a card look free.
function recordingExec() {
  const calls = [];
  return { calls, exec: (args) => { calls.push(args); throw new Error('unexpected gh call'); } };
}

const GOOD = ['616', '--intake', 'intake.txt', '--runtime', 'Codex'];
const GOOD_CHECK = ['616', '--intake', 'intake.txt', '--check'];

function run(args, deps = {}) {
  const sink = outputSink();
  const { exec, calls } = recordingExec();
  const status = main(args, { ghExec: exec, output: sink, tracker: 'github', hostname: 'runner-1.local', ...deps });
  return { status, calls, stdout: sink.stdout, stderr: sink.stderr };
}

const REFUSED_ARGS = {
  'no arguments': [],
  'a card number of zero': ['0', '--intake', 'intake.txt', '--check'],
  'a negative card number': ['-3', '--intake', 'intake.txt', '--check'],
  'a card number with trailing text': ['12x', '--intake', 'intake.txt', '--check'],
  'a decimal card number': ['1.5', '--intake', 'intake.txt', '--check'],
  'a zero-led card number': ['007', '--intake', 'intake.txt', '--check'],
  'a card number beyond the safe integers': ['99999999999999999999', '--intake', 'intake.txt', '--check'],
  'a missing --intake': ['616', '--check'],
  'an --intake with no value': ['616', '--check', '--intake'],
  'an --intake whose value is a flag': ['616', '--intake', '--check'],
  'neither --runtime nor --check': ['616', '--intake', 'intake.txt'],
  'both --runtime and --check': ['616', '--intake', 'intake.txt', '--runtime', 'Codex', '--check'],
  'a --runtime with no value': ['616', '--intake', 'intake.txt', '--runtime'],
  'an unknown flag': ['616', '--intake', 'intake.txt', '--check', '--force'],
  'a repeated --intake': ['616', '--intake', 'a.txt', '--intake', 'b.txt', '--check'],
  'a repeated --check': ['616', '--intake', 'intake.txt', '--check', '--check'],
  'a stray extra argument': ['616', 'extra', '--intake', 'intake.txt', '--check'],
  '--help with another argument': ['--help', '616'],
};

for (const [name, args] of Object.entries(REFUSED_ARGS)) {
  test(`board-claim refuses ${name} with exit 1 and no gh call`, () => {
    const { status, calls, stdout, stderr } = run(args);
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^board-claim: /);
    assert.deepEqual(calls, []);
  });
}

for (const runtime of ['Codex ', 'codex', 'Claude', 'Claude Code ', 'Claude Code Cloud', '']) {
  test(`board-claim refuses --runtime ${JSON.stringify(runtime)} with exit 1 and no gh call`, () => {
    const { status, calls, stderr } = run(['616', '--intake', 'intake.txt', '--runtime', runtime]);
    assert.equal(status, 1);
    assert.match(stderr, /--runtime must be exactly one of "Claude Code", "Codex", "Claude Code cloud"/);
    assert.deepEqual(calls, []);
  });
}

for (const hostname of ['', '-host', '.host', 'host name', 'host;touch x', 'a_b', 'host\n', 'höst']) {
  test(`board-claim refuses the hostname ${JSON.stringify(hostname)} in claim mode with exit 1 and no gh call`, () => {
    const { status, calls, stderr } = run(GOOD, { hostname });
    assert.equal(status, 1);
    assert.match(stderr, /cannot go into a claim comment/);
    assert.deepEqual(calls, []);
  });
}

for (const tracker of ['markdown', 'linear', 'jira', 'azure']) {
  test(`board-claim refuses the ${tracker} tracker with exit 1, naming claim-reads.md, and no gh call`, () => {
    for (const args of [GOOD, GOOD_CHECK]) {
      const { status, calls, stderr } = run(args, { tracker });
      assert.equal(status, 1);
      assert.match(stderr, new RegExp(`"${tracker}".*references/claim-reads\\.md`));
      assert.deepEqual(calls, []);
    }
  });
}

test('board-claim --help prints the modes and exits 0 with no gh call', () => {
  const { status, calls, stdout, stderr } = run(['--help']);
  assert.equal(status, 0);
  assert.equal(stdout, `${BOARD_CLAIM_HELP}\n`);
  assert.equal(stderr, '');
  assert.deepEqual(calls, []);
});

// The free check. Each case is a card picked from an intake document, in the form `board.mjs
// --intake` prints it, judged against the two live reads the resume skill's "3. Start the job"
// names: the card read's `--json state,assignees,comments` reply and the board read's GraphQL
// `projectItems` reply, each as gh returns it.

const ISSUE = 616;
const BOARD_LINE = `Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 2 of 2 item(s)`;
const CLAIM = 'Claim: omarchy, Claude Code, 2026-11-10T21:10Z';

// A claim whose first line is longer than the 1,000 characters one intake line carries. By hand:
// the first 1,000 hold the 47-character prefix and 953 x's, so the cut falls after the prefix's
// last space, and the remaining 995 characters fit on one `|+ ` line.
const LONG_PREFIX = 'Claim: omarchy, Claude Code, 2026-11-10T21:10Z ';
const LONG_CLAIM = `${LONG_PREFIX}${'x'.repeat(990)} tail`;
const LONG_CLAIM_LINES = [`| ${LONG_PREFIX}`, `|+ ${'x'.repeat(990)} tail`];

// The card's summary section, as the intake prints it.
function cardSection({ column = 'Ready', assignees = 'none', claim = ['claim: none in 0 comment(s)'] } = {}) {
  return [
    `=== #${ISSUE} [${column}] One claim command ===`,
    'Workstream: Product',
    'parent: none',
    'open blockers: none',
    `assignees: ${assignees}`,
    'proposal: no',
    ...claim,
    'owner questions: 0',
    'what to build: 1 line(s)',
    '| One command claims a picked card.',
    `card text: /tmp/board-intake/${ISSUE}.txt, 30 line(s)`,
  ];
}

// Another card's section first, carrying a claim of its own, so the card's section is found by
// its own heading and not by being the first.
const OTHER_SECTION = [
  '=== #617 [Backlog] Another card ===',
  'Workstream: Product',
  'parent: none',
  'open blockers: none',
  'assignees: @elsewhere',
  'proposal: no',
  'claim: comment 1 of 1',
  '| Claim: elsewhere, Codex, 2026-11-09T10:00Z',
  'owner questions: 0',
  'what to build: 1 line(s)',
  '| Another outcome.',
  'card text: /tmp/board-intake/617.txt, 20 line(s)',
];

// The intake document: the listing, then the card summaries, then the end line counting every
// line including itself. `endShift` miscounts that end line, and `endLine: false` leaves it out, as a
// truncated capture would.
function intakeFile({ board = BOARD_LINE, section = cardSection(), endShift = 0, endLine = true } = {}) {
  const lines = [
    board,
    '',
    '── Product (2) ──',
    `#${ISSUE} [Ready] One claim command`,
    '    task',
    '#617 [Backlog] Another card',
    '    task',
    '',
    'Card summaries: 2 pickable card(s), then 0 claimed card(s) with no closing pull request.',
    'Lines starting "| " are card text, and "|+ " continues the line above it. Each card\'s full body and comments are in the file its "card text:" line names.',
    '',
    ...OTHER_SECTION,
    ...(section === null ? [] : ['', ...section]),
    '',
  ];
  const all = endLine ? [...lines, `board intake: end of document, ${lines.length + 1 + endShift} line(s).`] : lines;
  const path = join(mkdtempSync(join(scratch, 'intake-')), 'board-intake.txt');
  writeFileSync(path, `${all.join('\n')}\n`);
  return path;
}

// A comment as the card read returns it: a body alone, or a comment whose fields replace the defaults.
const commentOf = (comment, index) => ({
  id: `IC_kwDOcomment${index + 1}`,
  author: { login: 'carol' },
  authorAssociation: 'OWNER',
  createdAt: `2026-11-10T21:${String(10 + index).padStart(2, '0')}:00Z`,
  url: `https://github.com/${BOARD_OWNER}/${BOARD_REPOSITORY}/issues/${ISSUE}#issuecomment-${4000 + index}`,
  ...(typeof comment === 'string' ? { body: comment } : comment),
});

// The card read's reply, oldest comment first, as `gh issue view --json state,assignees,comments` gives it.
function cardReply({ state = 'OPEN', assignees = [], comments = [] } = {}) {
  return JSON.stringify({
    state,
    assignees: assignees.map((login) => ({ id: `U_${login}`, login, name: '' })),
    comments: comments.map(commentOf),
  });
}

const boardNode = (owner, number, column) => ({
  project: { number, owner: { login: owner } },
  fieldValueByName: column === null ? null : { name: column },
});

// The board read's reply. By default the card is also on another project of the same owner whose
// column is null, which the skill allows.
function boardReply({ nodes = [boardNode(BOARD_OWNER, 9, null), boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, 'Ready')], totalCount = nodes.length } = {}) {
  return JSON.stringify({ data: { repository: { issue: { projectItems: { totalCount, nodes } } } } });
}

// A call that would change the card: an assignee edit, a posted comment or a board move.
const isWrite = (args) =>
  (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) ||
  args.includes('item-edit') ||
  args.includes('POST') ||
  args.some((arg) => /issues\/\d+\/comments/.test(arg) || /^query=\s*mutation\b/.test(arg));

// The claim's writes and its confirming read. The session's machine is `omarchy`, and its clock
// reads 21:38 and 59.999 seconds, which `date -u +%Y-%m-%dT%H:%MZ` prints as 21:38, never 21:39.
const REPO = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
const CLOCK = () => new Date('2026-11-10T21:38:59.999Z');
const CARD_READ = ['issue', 'view', String(ISSUE), '--repo', REPO, '--json', 'state,assignees,comments'];
const claimBody = (runtime) => `Claim: omarchy, ${runtime}, 2026-11-10T21:38Z`;

// The board's Status field and the card's item on it, as the two GraphQL reads `moveCards` makes
// return them; the card sits in Ready, so the move edits it.
const STATUS_FIELD_REPLY = JSON.stringify({ data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_board', field: { id: 'PVTSSF_status', options: [
  { id: 'opt-backlog', name: 'Backlog' },
  { id: 'opt-ready', name: 'Ready' },
  { id: 'opt-inprogress', name: 'In progress' },
  { id: 'opt-awaiting', name: 'Awaiting push' },
  { id: 'opt-inreview', name: 'In review' },
  { id: 'opt-done', name: 'Done' },
] } } } } });
const BOARD_ITEM_REPLY = JSON.stringify({ data: { repository: { issue: { id: 'I_kwDOcard616', projectItems: { totalCount: 2, nodes: [
  { id: 'PVTI_elsewhere', isArchived: false, project: { number: 9, owner: { login: BOARD_OWNER } }, value: null },
  { id: 'PVTI_card616', isArchived: false, project: { number: BOARD_PROJECT_NUMBER, owner: { login: BOARD_OWNER } }, value: { name: 'Ready' } },
] } } } } });

const ITEM_EDIT = ['project', 'item-edit', '--id', 'PVTI_card616', '--project-id', 'PVT_board', '--field-id', 'PVTSSF_status', '--single-select-option-id', 'opt-inprogress'];
const ASSIGN = ['issue', 'edit', String(ISSUE), '--repo', REPO, '--add-assignee', '@me'];
const postClaim = (runtime) => ['api', '-X', 'POST', `repos/${REPO}/issues/${ISSUE}/comments`, '-f', `body=${claimBody(runtime)}`];
const claimWrites = (runtime) => [ITEM_EDIT, ASSIGN, postClaim(runtime)];

// GitHub's "Create an issue comment" reply for the posted body; `id: null` leaves the id out.
const OWN_ID = 4123456789;
const OWN_URL = `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${OWN_ID}`;
function commentCreated(body, { id = OWN_ID } = {}) {
  return JSON.stringify({
    ...(id === null ? {} : { id }),
    node_id: 'IC_kwDOown',
    url: `https://api.github.com/repos/${REPO}/issues/comments/${OWN_ID}`,
    html_url: OWN_URL,
    body,
    user: { login: 'carol', id: 1001, type: 'User' },
    created_at: '2026-11-10T21:38:59Z',
    updated_at: '2026-11-10T21:38:59Z',
    issue_url: `https://api.github.com/repos/${REPO}/issues/${ISSUE}`,
    author_association: 'OWNER',
  });
}

// The session's own claim as the card read shows it, and a claim another session posted.
const ownClaim = (body) => ({ id: 'IC_kwDOown', body, createdAt: '2026-11-10T21:38:59Z', url: OWN_URL });
const FOREIGN_CLAIM = {
  id: 'IC_kwDOforeign',
  author: { login: 'dave' },
  body: 'Claim: elsewhere, Codex, 2026-11-10T21:38Z',
  createdAt: '2026-11-10T21:38:58Z',
  url: `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-4123456700`,
};

// The card read after the claim: the card read before it, with the session's account assigned
// and the comments given added after the existing ones, in that order.
function withComments(card, ...comments) {
  const reply = JSON.parse(card);
  if (!reply.assignees.some((a) => a.login === 'carol')) reply.assignees.push({ id: 'U_carol', login: 'carol', name: '' });
  reply.comments.push(...comments.map((comment, i) => commentOf(comment, reply.comments.length + i)));
  return JSON.stringify(reply);
}

// Answers this card's reads and writes, each with its reply or by throwing the error given; every
// other call is recorded and fails. The card read answers `card` until a claim is posted, then
// `after`; `post` and `after` may be functions of the posted body.
function boardExec({
  card = cardReply(),
  board = boardReply(),
  move = '',
  assign = `https://github.com/${REPO}/issues/${ISSUE}\n`,
  post = (body) => commentCreated(body),
  after = (body) => withComments(card, ownClaim(body)),
}) {
  const calls = [];
  let posted = null;
  const answer = (reply, body) => {
    const value = typeof reply === 'function' ? reply(body) : reply;
    if (value instanceof Error) throw value;
    return value;
  };
  const exec = (args) => {
    calls.push(args);
    const text = args.join(' ');
    const names = (word) => new RegExp(`(^|[^\\w-])${word}([^\\w-]|$)`).test(text);
    const thisCard = names(String(ISSUE)) && names(BOARD_OWNER) && names(BOARD_REPOSITORY);
    const graphql = args[0] === 'api' && args[1] === 'graphql' && !isWrite(args);
    if (args[0] === 'issue' && args[1] === 'view' && thisCard) return posted === null ? answer(card) : answer(after, posted);
    if (graphql && text.includes(`projectV2(number:${BOARD_PROJECT_NUMBER})`) && names(BOARD_OWNER)) return STATUS_FIELD_REPLY;
    if (graphql && thisCard && text.includes('isArchived')) return BOARD_ITEM_REPLY;
    if (graphql && thisCard && text.includes('projectItems')) return answer(board);
    if (args[0] === 'project' && args[1] === 'item-edit') return answer(move);
    if (args[0] === 'issue' && args[1] === 'edit' && thisCard) return answer(assign);
    if (args[0] === 'api' && args.includes('POST') && thisCard) {
      const body = args.find((arg) => arg.startsWith('body='))?.slice('body='.length);
      const reply = answer(post, body);
      posted = body;
      return reply;
    }
    throw new Error(`unexpected gh call ${JSON.stringify(args)}`);
  };
  return { calls, exec };
}

const MODES = ['--check', ...RUNTIMES];

function judge(scenario, mode) {
  const sink = outputSink();
  const { exec, calls } = boardExec(scenario);
  const intake = scenario.intake ?? intakeFile();
  const args = [String(ISSUE), '--intake', intake, ...(mode === '--check' ? ['--check'] : ['--runtime', mode])];
  const status = main(args, { ghExec: exec, output: sink, tracker: 'github', hostname: 'omarchy', now: CLOCK });
  return { status, calls, stdout: sink.stdout, stderr: sink.stderr };
}

// Judges the scenario in `--check` and in claim mode for every runtime, each expecting its exit,
// an `outcome:` last line naming its outcome, and exactly the writes given: none for `--check`.
function assertJudged(scenario, { check, claim, writes = () => [] }) {
  for (const mode of MODES) {
    const [status, outcome] = mode === '--check' ? check : claim;
    const result = judge(scenario, mode);
    assert.equal(result.status, status, `${mode}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`(^|\\n)outcome: ${outcome}: [^\\n]+\\n$`), mode);
    assert.deepEqual(result.calls.filter(isWrite), mode === '--check' ? [] : writes(mode), mode);
  }
}

// Claim mode on a free card makes the claim's three writes and holds the card.
const FREE = { check: [0, 'Free'], claim: [0, 'Free'], writes: claimWrites };
const NOT_FREE = { check: [3, 'Not free'], claim: [3, 'Not free'] };
const UNCONFIRMED = { check: [2, 'Could not confirm'], claim: [2, 'Could not confirm'] };

test('board-claim judges a card with no claim Free: --check exits 0 and claim mode claims it', () => {
  assertJudged({}, FREE);
});

test('board-claim --check needs no hostname: a free card exits 0 whatever the hostname', () => {
  const sink = outputSink();
  const { exec } = boardExec({});
  const status = main([String(ISSUE), '--intake', intakeFile(), '--check'], { ghExec: exec, output: sink, tracker: 'github', hostname: 'bad host' });
  assert.equal(status, 0, sink.stdout + sink.stderr);
});

test('board-claim judges a card whose newest claim is the one the intake shows Free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ assignees: '@carol', claim: ['claim: comment 2 of 3', `| ${CLAIM}`] }) }),
    card: cardReply({ assignees: ['carol'], comments: ['Picked up for a look.', `${CLAIM}\nWorking in job/616.`, 'Parked for now.'] }),
  }, FREE);
});

test('board-claim judges a card whose long claim line the intake folded Free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', ...LONG_CLAIM_LINES] }) }),
    card: cardReply({ comments: [`${LONG_CLAIM}\nsecond line`] }),
  }, FREE);
});

test('board-claim judges a card whose assignees are the same in another order Free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ assignees: '@alice, @bob' }) }),
    card: cardReply({ assignees: ['bob', 'alice'] }),
  }, FREE);
});

test('board-claim judges a card with a comment that is not a claim added since intake Free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', `| ${CLAIM}`] }) }),
    card: cardReply({ comments: [CLAIM, 'A note added after the intake.'] }),
  }, FREE);
});

test('board-claim judges Free the claim lines the intake renders for the same comments', () => {
  const comments = ['A note.', ` \t${LONG_CLAIM}\r\nsecond line`, 'Later note.'];
  const claim = claimLines({ comments, commentCount: comments.length, commentsUnavailable: null });
  assertJudged({ intake: intakeFile({ section: cardSection({ claim }) }), card: cardReply({ comments }) }, FREE);
});

test('board-claim judges a closed card Not free', () => {
  assertJudged({ card: cardReply({ state: 'CLOSED' }) }, NOT_FREE);
});

test('board-claim judges a card whose column differs from the intake Not free', () => {
  assertJudged({ board: boardReply({ nodes: [boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, 'In progress')] }) }, NOT_FREE);
});

test('board-claim judges a card with an assignee added since intake Not free', () => {
  assertJudged({ card: cardReply({ assignees: ['alice'] }) }, NOT_FREE);
});

test('board-claim judges a card with an assignee gone since intake Not free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ assignees: '@alice, @bob' }) }),
    card: cardReply({ assignees: ['bob'] }),
  }, NOT_FREE);
});

test('board-claim judges a card with a new claim since intake Not free', () => {
  assertJudged({ card: cardReply({ comments: ['Claim: elsewhere, Codex, 2026-11-10T21:40Z'] }) }, NOT_FREE);
  assertJudged({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', `| ${CLAIM}`] }) }),
    card: cardReply({ comments: [CLAIM, 'Claim: elsewhere, Codex, 2026-11-10T21:40Z'] }),
  }, NOT_FREE);
});

test('board-claim judges a card whose newest claim has a different first line Not free', () => {
  assertJudged({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', `| ${CLAIM}`] }) }),
    card: cardReply({ comments: ['Claim: omarchy, Codex, 2026-11-10T21:10Z'] }),
  }, NOT_FREE);
  // The difference lies only in the part the intake folded onto its `|+ ` line.
  assertJudged({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', ...LONG_CLAIM_LINES] }) }),
    card: cardReply({ comments: [`${LONG_PREFIX}${'x'.repeat(990)} tale`] }),
  }, NOT_FREE);
});

test('board-claim judges a card with a whitespace-led Needs owner comment Not free', () => {
  assertJudged({ card: cardReply({ comments: [' \n\tNeeds owner: which board should this use?'] }) }, NOT_FREE);
});

test('board-claim cannot confirm a card whose card read fails', () => {
  assertJudged({ card: new Error('gh: HTTP 502') }, UNCONFIRMED);
});

test('board-claim cannot confirm a card whose board read fails', () => {
  assertJudged({ board: new Error('gh: HTTP 502') }, UNCONFIRMED);
});

test('board-claim cannot confirm a card when a read returns malformed JSON', () => {
  assertJudged({ card: '{"state":"OPEN","assignees":[' }, UNCONFIRMED);
  assertJudged({ board: '{"data":{"repository":{"issue":' }, UNCONFIRMED);
});

test('board-claim cannot confirm a card whose boards count differs from its board lines', () => {
  assertJudged({ board: boardReply({ nodes: [boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, 'Ready')], totalCount: 2 }) }, UNCONFIRMED);
});

test('board-claim cannot confirm a card on no project matching the configured board', () => {
  assertJudged({ board: boardReply({ nodes: [boardNode(BOARD_OWNER, 9, 'Ready'), boardNode('someone-else', BOARD_PROJECT_NUMBER, 'Ready')] }) }, UNCONFIRMED);
});

test('board-claim cannot confirm a card with two board lines matching the configured board', () => {
  assertJudged({ board: boardReply({ nodes: [boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, 'Ready'), boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, 'Ready')] }) }, UNCONFIRMED);
});

test('board-claim cannot confirm a card whose matching board line has a blank column', () => {
  for (const column of [null, '', '  ']) {
    assertJudged({ board: boardReply({ nodes: [boardNode(BOARD_OWNER, BOARD_PROJECT_NUMBER, column)] }) }, UNCONFIRMED);
  }
});

test('board-claim cannot confirm a card when the intake file is missing', () => {
  assertJudged({ intake: join(scratch, 'no-such-intake.txt') }, UNCONFIRMED);
});

test('board-claim cannot confirm a card when the intake names a different board', () => {
  for (const board of [
    `Board someone-else/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 2 of 2 item(s)`,
    `Board ${BOARD_OWNER}/other-repo project ${BOARD_PROJECT_NUMBER} — Backlog/Ready: 2 of 2 item(s)`,
    `Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER + 1} — Backlog/Ready: 2 of 2 item(s)`,
  ]) {
    assertJudged({ intake: intakeFile({ board }) }, UNCONFIRMED);
  }
});

test('board-claim cannot confirm a card when the intake end line is wrong or missing', () => {
  for (const intake of [intakeFile({ endShift: 1 }), intakeFile({ endShift: -1 }), intakeFile({ endLine: false })]) {
    assertJudged({ intake }, UNCONFIRMED);
  }
});

test('board-claim cannot confirm a card the intake has no section for', () => {
  assertJudged({ intake: intakeFile({ section: null }) }, UNCONFIRMED);
});

test('board-claim cannot confirm a card whose intake claim line is UNAVAILABLE', () => {
  const claim = ['claim: UNAVAILABLE — no Claim in the newest 100 of 140 comment(s) and the older ones were not read'];
  assertJudged({ intake: intakeFile({ section: cardSection({ claim }) }) }, UNCONFIRMED);
});

// The claim: the move to In progress, the assignee and the `Claim:` comment, in that order, then the
// card read again. Of the claims that read shows and the read before the claim did not, the first
// in GitHub's comment order holds the card.

// A call as the claim sequence names it: a read by its role, a write by its exact arguments.
function callKind(args) {
  if (isDeepStrictEqual(args, CARD_READ)) return 'card read';
  const text = args.join(' ');
  if (args[0] === 'api' && args[1] === 'graphql' && text.includes('projectV2(number:')) return 'status field';
  if (args[0] === 'api' && args[1] === 'graphql' && text.includes('isArchived')) return 'board item';
  if (args[0] === 'api' && args[1] === 'graphql' && text.includes('projectItems')) return 'board read';
  return args;
}

// The `wrote:` lines name the writes made, in order: the move, the assignee, then the claim comment.
function assertWrote(stdout, runtime, count) {
  const lines = stdout.split('\n').filter((line) => line.startsWith('wrote: '));
  assert.equal(lines.length, count, stdout);
  if (count > 0) assert.match(lines[0], /In progress/);
  if (count > 1) assert.match(lines[1], /@me/);
  if (count > 2) assert.ok(lines[2].includes(claimBody(runtime)), lines[2]);
}

const outcomeLine = (outcome) => new RegExp(`(^|\\n)outcome: ${outcome}: [^\\n]+\\n$`);

test('board-claim claims a free card: the move, the assignee and the claim comment in order, then the card read again, exit 0 Free', () => {
  for (const runtime of RUNTIMES) {
    const { status, calls, stdout, stderr } = judge({}, runtime);
    assert.equal(status, 0, `${runtime}: ${stdout}${stderr}`);
    const kinds = calls.map(callKind);
    assert.deepEqual(kinds.slice(0, 2).sort(), ['board read', 'card read'], runtime);
    assert.deepEqual(kinds.slice(2), ['status field', 'board item', ITEM_EDIT, ASSIGN, postClaim(runtime), 'card read'], runtime);
    assert.match(stdout, /^(before: [^\n]+\n)+(intake: [^\n]+\n)+(wrote: [^\n]+\n){3}(after: [^\n]+\n)+outcome: Free: [^\n]+\n$/, runtime);
    assertWrote(stdout, runtime, 3);
    assert.ok(stdout.split('\n').find((line) => line.startsWith('wrote: ') && line.includes(claimBody(runtime))).includes(OWN_URL), stdout);
    assert.ok(stdout.split('\n').some((line) => line.startsWith('after: ') && line.includes(OWN_URL)), stdout);
  }
});

test('board-claim exits 4 Another claim is first when a new claim precedes its own', () => {
  const { status, calls, stdout } = judge({ after: (body) => withComments(cardReply(), FOREIGN_CLAIM, ownClaim(body)) }, 'Codex');
  assert.equal(status, 4, stdout);
  assert.match(stdout, outcomeLine('Another claim is first'));
  assertWrote(stdout, 'Codex', 3);
  assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
});

test('board-claim exits 0 Free when its own claim precedes another new claim', () => {
  const { status, stdout } = judge({ after: (body) => withComments(cardReply(), ownClaim(body), FOREIGN_CLAIM) }, 'Codex');
  assert.equal(status, 0, stdout);
  assert.match(stdout, outcomeLine('Free'));
});

test('board-claim ignores a claim the read before the claim already showed', () => {
  const card = cardReply({ comments: [CLAIM] });
  const { status, stdout } = judge({
    intake: intakeFile({ section: cardSection({ claim: ['claim: comment 1 of 1', `| ${CLAIM}`] }) }),
    card,
    after: (body) => withComments(card, ownClaim(body)),
  }, 'Codex');
  assert.equal(status, 0, stdout);
  assert.match(stdout, outcomeLine('Free'));
});

test('board-claim judges which claim is first by GitHub\'s comment order, not by createdAt', () => {
  const later = { ...FOREIGN_CLAIM, createdAt: '2026-11-10T21:39:30Z' };
  const first = judge({ after: (body) => withComments(cardReply(), later, ownClaim(body)) }, 'Codex');
  assert.equal(first.status, 4, first.stdout);
  assert.match(first.stdout, outcomeLine('Another claim is first'));

  const earlier = { ...FOREIGN_CLAIM, createdAt: '2026-11-10T21:37:00Z' };
  const second = judge({ after: (body) => withComments(cardReply(), ownClaim(body), earlier) }, 'Codex');
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, outcomeLine('Free'));
});

test('board-claim exits 5 when the move write fails, naming no write and making no other', () => {
  const { status, calls, stdout } = judge({ move: new Error('gh: HTTP 502') }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 0);
  assert.deepEqual(calls.filter(isWrite), [ITEM_EDIT]);
});

test('board-claim exits 5 when the assignee write fails, naming only the move and posting no claim', () => {
  const { status, calls, stdout } = judge({ assign: new Error('gh: HTTP 422 could not add assignee') }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 1);
  assert.deepEqual(calls.filter(isWrite), [ITEM_EDIT, ASSIGN]);
});

test('board-claim exits 5 when posting the claim fails, naming the move and the assignee', () => {
  const { status, calls, stdout } = judge({ post: new Error('gh: HTTP 502') }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 2);
  assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
});

test('board-claim exits 5 when the posted claim\'s reply has no id, naming all three writes', () => {
  const { status, calls, stdout } = judge({ post: (body) => commentCreated(body, { id: null }) }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 3);
  assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
});

test('board-claim exits 5 when the card read after the claim fails, naming all three writes', () => {
  const { status, calls, stdout } = judge({ after: new Error('gh: HTTP 502') }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 3);
  assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
  assert.equal(callKind(calls.at(-1)), 'card read');
});

test('board-claim exits 5 when the card read after the claim returns malformed JSON, naming all three writes', () => {
  const { status, calls, stdout } = judge({ after: '{"state":"OPEN","assignees":[' }, 'Codex');
  assert.equal(status, 5, stdout);
  assert.match(stdout, outcomeLine('Could not confirm'));
  assertWrote(stdout, 'Codex', 3);
  assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
  assert.equal(callKind(calls.at(-1)), 'card read');
});

test('board-claim exits 5 when the card read after the claim lacks its own claim, naming all three writes', () => {
  for (const after of [cardReply(), withComments(cardReply(), FOREIGN_CLAIM)]) {
    const { status, calls, stdout } = judge({ after }, 'Codex');
    assert.equal(status, 5, stdout);
    assert.match(stdout, outcomeLine('Could not confirm'));
    assertWrote(stdout, 'Codex', 3);
    assert.deepEqual(calls.filter(isWrite), claimWrites('Codex'));
  }
});

// The real command through a fake `gh` that logs every invocation and answers this card's reads
// and the claim's writes with the replies its environment carries. Once a claim is posted, the
// card read adds it, with the posted body, at the address the posted reply gives.
const fakeGh = installFakeGh('board-claim-', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const earlier = fs.readFileSync(process.env.FAKE_GH_CALLS, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line));
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
const text = args.join(' ');
const bodyOf = (call) => call.find((arg) => arg.startsWith('body=')).slice('body='.length);
const posted = earlier.find((call) => call[0] === 'api' && call.includes('POST'));
const created = JSON.parse(process.env.FAKE_GH_COMMENT);
if (args[0] === 'issue' && args[1] === 'view') {
  const card = JSON.parse(process.env.FAKE_GH_CARD);
  if (posted) {
    card.assignees.push({ id: 'U_carol', login: 'carol', name: '' });
    card.comments.push({ id: 'IC_kwDOown', author: { login: 'carol' }, authorAssociation: 'OWNER', body: bodyOf(posted), createdAt: created.created_at, url: created.html_url });
  }
  process.stdout.write(JSON.stringify(card));
} else if (args[0] === 'api' && args[1] === 'graphql' && text.includes('projectV2(number:')) {
  process.stdout.write(process.env.FAKE_GH_STATUS_FIELD);
} else if (args[0] === 'api' && args[1] === 'graphql' && text.includes('isArchived')) {
  process.stdout.write(process.env.FAKE_GH_BOARD_ITEM);
} else if (args[0] === 'api' && args[1] === 'graphql' && !text.includes('mutation')) {
  process.stdout.write(process.env.FAKE_GH_BOARD);
} else if (args[0] === 'project' && args[1] === 'item-edit') {
  process.stdout.write('');
} else if (args[0] === 'issue' && args[1] === 'edit') {
  process.stdout.write(process.env.FAKE_GH_ISSUE_URL + '\\n');
} else if (args[0] === 'api' && args.includes('POST')) {
  process.stdout.write(JSON.stringify({ ...created, body: bodyOf(args) }));
} else {
  process.stderr.write('unexpected gh invocation');
  process.exitCode = 2;
}
`);
after(() => fakeGh.cleanup());

function runProcess(args) {
  const callsFile = fakeGh.newCallsFile();
  writeFileSync(callsFile, '');
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: fakeGh.env({
      FAKE_GH_CALLS: callsFile,
      FAKE_GH_CARD: cardReply(),
      FAKE_GH_BOARD: boardReply(),
      FAKE_GH_STATUS_FIELD: STATUS_FIELD_REPLY,
      FAKE_GH_BOARD_ITEM: BOARD_ITEM_REPLY,
      FAKE_GH_ISSUE_URL: `https://github.com/${REPO}/issues/${ISSUE}`,
      FAKE_GH_COMMENT: commentCreated(''),
    }),
  });
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { result, calls };
}

test('board-claim as a process: --check on a free card makes the card read and the board read and exits 0 Free', () => {
  const { result, calls } = runProcess([String(ISSUE), '--intake', intakeFile(), '--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^outcome: Free: /m);
  assert.ok(calls.some((args) => args[0] === 'issue' && args[1] === 'view'), JSON.stringify(calls));
  assert.ok(calls.some((args) => args[0] === 'api' && args[1] === 'graphql'), JSON.stringify(calls));
  assert.deepEqual(calls.filter(isWrite), []);
});

test('board-claim as a process: claim mode on a free card moves it, assigns it, posts the claim and exits 0 Free', () => {
  const { result, calls } = runProcess([String(ISSUE), '--intake', intakeFile(), '--runtime', 'Codex']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(^|\n)outcome: Free: [^\n]+\n$/);
  const writes = calls.filter(isWrite);
  assert.deepEqual(writes.slice(0, 2), [ITEM_EDIT, ASSIGN], JSON.stringify(calls));
  assert.deepEqual(writes[2].slice(0, 5), postClaim('Codex').slice(0, 5), JSON.stringify(calls));
  // The real process takes its machine name and time from the host, so only their form is fixed.
  assert.match(writes[2][5], /^body=Claim: [A-Za-z0-9][A-Za-z0-9.-]*, Codex, \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
  assert.equal(writes.length, 3, JSON.stringify(calls));
  assert.deepEqual(calls.at(-1), CARD_READ);
});

test('board-claim as a process: --runtime "Codex " exits 1 and makes no gh call', () => {
  const { result, calls } = runProcess([String(ISSUE), '--intake', intakeFile(), '--runtime', 'Codex ']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--runtime must be exactly one of/);
  assert.deepEqual(calls, []);
});
