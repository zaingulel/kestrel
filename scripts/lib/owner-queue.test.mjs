// @ts-nocheck
// owner-queue.test.mjs — the owner-queue collector (scripts/lib/owner-queue.mjs).
// Run: node --test scripts/lib/owner-queue.test.mjs
//
// `collect` is called with a recording board executor, a scripted `git` and saved files, in a toolkit copy wired to
// a literal configuration. The wire fixture uses the actual standalone panel commands and a fake GitHub command.
// Expected items come from the resume batch review, the queue panel plan and the retirement contract.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_TEST_CONFIG, copyToolkit } from './board-toolkit-copy.mjs';
import { installFakeGh } from './fake-gh.mjs';
import { gitEnvironment } from './factory-sync.mjs';

// The collector entry and its run/body helpers are outside the shipped board toolkit.
function copyOwnerQueueToolkit() {
  const copied = copyToolkit(GITHUB_TEST_CONFIG);
  copyFileSync(new URL('./pre-approved-run.mjs', import.meta.url), copied.script('lib/pre-approved-run.mjs'));
  copyFileSync(new URL('./closeout-cleanup.mjs', import.meta.url), copied.script('lib/closeout-cleanup.mjs'));
  copyFileSync(new URL('./run-folder.mjs', import.meta.url), copied.script('lib/run-folder.mjs'));
  copyFileSync(new URL('./owner-queue.mjs', import.meta.url), copied.script('lib/owner-queue.mjs'));
  copyFileSync(new URL('../owner-queue.mjs', import.meta.url), copied.script('owner-queue.mjs'));
  return copied;
}

const toolkit = copyOwnerQueueToolkit();
after(() => toolkit.cleanup());
const { act, collect, markShowFirst, moveOnBoard, report, undo } = await toolkit.load('lib/owner-queue.mjs');
const { main: readerMain } = await toolkit.load('owner-queue.mjs');
const { boardReadExec, hydratedItem, issueItemReply, issuesPage, leanBoardPage, leanNode, membership, walkedIssue } = await toolkit.load('lib/board-fixtures.mjs');
const { BOARD_OWNER, BOARD_OWNER_TYPE, BOARD_REPOSITORY, ROUTING_FIELD, ROUTING_OPTIONS, STATUS_OPTIONS } = await toolkit.load('lib/board-config.mjs');

const QUEUE = fileURLToPath(new URL('../../.agents/herdr/fabraik-queue/queue.mjs', import.meta.url));

const HOST = 'machine-a';
const OWNED_HISTORY_SKIP = typeof process.getuid === 'function' ? false : 'owned private lead history requires process.getuid';
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'owner-queue-model-root-')));
mkdirSync(join(ROOT, '.git'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const worktreeOf = (card) => join(ROOT, '.claude', 'worktrees', `job-${card}`);
const reviewFolder = (card, head) => join(worktreeOf(card), '.claude', 'worklog', `job_${card}-review-${head}`);

const card = (number, title, status, labels = []) => leanNode({
  id: `PVTI_${number}`,
  content: { __typename: 'Issue', number, title, labels },
  status,
  routing: 'Platform',
});

// One comment as the card detail read returns it: its text, its address and the account that posted it.
const commentNode = (body, index = 0) => ({ body, url: `https://github.com/example-owner/example/issues/1#issuecomment-${index + 1}`, author: { login: 'example-owner' } });

const detail = (number, body, comments) => ({
  number,
  body,
  parent: null,
  comments: {
    totalCount: comments.length,
    pageInfo: { hasPreviousPage: false, startCursor: null },
    nodes: comments.map(commentNode),
  },
});

// The identity a scripted `git hash-object` gives a saved file: the sha1 hex of its path inside the worktree, written
// with `/`, so a file's identity changes with its name and folder.
const pathIdentity = (path) => createHash('sha1').update(path).digest('hex');
const RUN_MARK = '2026-11-08T19:00:00Z';

// The identity of card's saved write-up at `head`: the identities of `names` in that review folder (body.md, then each
// screenshot in numeric order), comma-separated.
const ids = (card, head, names) => names.map((name) => pathIdentity(`.claude/worklog/job_${card}-review-${head}/${name}`)).join(',');

// The waiting line a stop leaves for card's saved write-up at `head`: its identity and a run mark.
const waitingLine = (card, head, names) => `Waiting version: job/${card} ${head} ${ids(card, head, names)} run ${RUN_MARK}`;

// A git whose answers are scripted per job: the worktree list, and each worktree's head, status (empty unless the job
// is listed as dirty) and `hash-object` identities, then where FETCH_HEAD lives and the last day's merges (`digest`, one
// line per merge), and the fetched-main settings reads, which `settingsGit` answers with its when-needed file.
function scriptedGit(jobs, dirty = [], digest = '') {
  const answers = new Map([['worktree list --porcelain', [
    `worktree ${ROOT}\nHEAD 0000000\nbranch refs/heads/main`,
    ...Object.entries(jobs).map(([number, head]) => `worktree ${worktreeOf(number)}\nHEAD ${head}\nbranch refs/heads/job/${number}`),
  ].join('\n\n') + '\n'],
  [`-C ${ROOT} rev-parse --path-format=absolute --git-common-dir`, `${join(ROOT, '.git')}\n`],
  ['rev-parse --git-path FETCH_HEAD', '.git/FETCH_HEAD\n'],
  ['log --first-parent --since=24.hours --format=%H%x09%cI%x09%s origin/main', digest]]);
  for (const [number, head] of Object.entries(jobs)) {
    answers.set(`-C ${worktreeOf(number)} rev-parse HEAD`, `${head}\n`);
    answers.set(`-C ${worktreeOf(number)} status --porcelain --untracked-files=normal`, dirty.includes(Number(number)) ? ' M notes.md\n' : '');
  }
  return (args) => {
    const [flag, worktree, command, noFilters, separator, ...paths] = args;
    if (flag === '-C' && Object.keys(jobs).some((number) => worktreeOf(number) === worktree)
      && `${command} ${noFilters} ${separator}` === 'hash-object --no-filters --' && paths.length > 0) {
      return paths.map((path) => `${pathIdentity((isAbsolute(path) ? relative(worktree, path) : path).split(sep).join('/'))}\n`).join('');
    }
    const answer = answers.get(args.join(' '));
    if (answer !== undefined) return answer;
    try {
      return settingsGit()(args);
    } catch {
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
  };
}

// Saved files by path; a folder lists the files and folders directly inside it, and a missing file or a folder holding
// none fails as the filesystem does.
function folder(files) {
  return {
    readFile: (path) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
    listFolder: (path) => {
      const names = [...new Set(Object.keys(files).filter((file) => file.startsWith(`${path}${sep}`))
        .map((file) => file.slice(path.length + 1).split(sep)[0]))];
      if (names.length === 0) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return names;
    },
  };
}

const notFound = () => {
  throw Object.assign(new Error('ENOENT: FETCH_HEAD'), { code: 'ENOENT' });
};

const read = ({
  page, details, jobs, files = {}, dirty, digest, fileTime = notFound, issues, items,
  other = { data: { repository: details } }, run = scriptedGit(jobs, dirty, digest),
}) => {
  const { exec, calls } = boardReadExec({ board: [page], other, issues, items });
  const document = collect({
    root: ROOT, tracker: 'github', executor: exec, run, hostname: HOST, login: 'owner', fileTime, ...folder(files),
  });
  return { document, calls };
};

// A real git command in `cwd` under a test committer, its exit asserted 0; its output, trimmed.
const realGit = (cwd, ...args) => {
  const done = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnvironment() });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};

// Each item's `version`, checked as 64 lowercase hex and taken off, so an expected list names what the panel shows.
const shown = (items) => items.map(({ version, ...item }) => {
  assert.ok(typeof version === 'string' && /^[0-9a-f]{64}$/.test(version), `no version on ${JSON.stringify(item)}: ${version}`);
  return item;
});

// The board with each card's `version` checked and taken off, so an expected board names what the panel shows: 64
// lowercase hex on each read card of a GitHub board, and absent on an unread card and on every card of another tracker.
const unversioned = (board, { github = true } = {}) => ({ ...board, cards: board.cards.map((entry) => {
  const { version, ...shownCard } = entry;
  if (github && entry.unread === undefined) assert.ok(typeof version === 'string' && /^[0-9a-f]{64}$/.test(version), `no version on ${JSON.stringify(entry)}`);
  else assert.ok(!('version' in entry), `a version on ${JSON.stringify(entry)}`);
  return shownCard;
}) });

// The lines a saved write-up carries for the judge of finished work: nothing failed or untested, an easy undo, nothing
// left undone and one settled review. A write-up ending in them waits for no reason.
const CLEAR_PROOF = [
  'Failed: none',
  'Untested: none',
  'Undo: easy',
  '',
  '## Not done',
  '',
  'Nothing',
  '',
  '## Review',
  '',
  'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0',
  '',
].join('\n');

test('an awaiting card with a saved write-up becomes a merge item', () => {
  const body7 = [
    '## Summary',
    '',
    'Closes #7',
    '',
    '## Evidence',
    '',
    '<!-- Say "no visual change" when true. -->',
    '',
    '- **Before:** no panel',
    '  **After:** the panel',
    '',
    '<details>',
    '',
    '<summary>Decision card</summary>',
    '',
    '<!-- Blocks 1 to 5 of the card. -->',
    '',
    'The panel now lists what waits on you.',
    '',
    '<!-- A comment between two paragraphs. -->',
    '',
    '**Risk:** Undo: revert the commit.',
    '',
    '</details>',
    '',
    CLEAR_PROOF,
  ].join('\n');
  const body12 = [
    '## Evidence',
    '',
    'No visual change.',
    '',
    '<details>',
    '',
    '<summary>Decision card</summary>',
    '',
    'The collector now reads the board once.',
    '',
    '</details>',
    '',
    CLEAR_PROOF,
  ].join('\n');
  const page = leanBoardPage([
    card(7, 'The queue panel', 'Awaiting push'),
    card(9, 'A shipped card', 'Done'),
    card(10, 'A card still being picked', 'Ready'),
    card(12, 'The collector reads once', 'Awaiting push'),
  ]);
  const details = {
    i7: detail(7, waitingLine(7, 'aaa7', ['body.md', 'screenshot-2.png', 'screenshot-10.jpg']),
      ['Claim: machine-b, Codex, 2026-11-01T09:00Z', 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z']),
    i10: detail(10, '', []),
    i12: detail(12, waitingLine(12, 'bbb12', ['body.md']), ['Claim: machine-a, Codex, 2026-11-03T09:00Z']),
  };
  const files = {
    [join(reviewFolder(7, 'aaa7'), 'body.md')]: body7,
    [join(reviewFolder(7, 'aaa7'), 'screenshot-2.png')]: '',
    [join(reviewFolder(7, 'aaa7'), 'screenshot-10.jpg')]: '',
    [join(reviewFolder(7, 'aaa7'), 'shown-hash')]: '',
    [join(reviewFolder(12, 'bbb12'), 'body.md')]: body12,
  };

  const { document, calls } = read({ page, details, jobs: { 7: 'aaa7', 12: 'bbb12' }, files });

  assert.deepEqual(shown(document.items), [
    {
      card: 7,
      title: 'The queue panel',
      category: 'merge',
      decisionCard: 'The panel now lists what waits on you.\n\n**Risk:** Undo: revert the commit.',
      screenshots: [join(reviewFolder(7, 'aaa7'), 'screenshot-2.png'), join(reviewFolder(7, 'aaa7'), 'screenshot-10.jpg')],
      actedOnBy: 'coordinator',
      head: 'aaa7',
      identity: ids(7, 'aaa7', ['body.md', 'screenshot-2.png', 'screenshot-10.jpg']),
    },
    {
      card: 12,
      title: 'The collector reads once',
      category: 'merge',
      decisionCard: 'The collector now reads the board once.',
      visual: 'none',
      actedOnBy: 'coordinator',
      head: 'bbb12',
      identity: ids(12, 'bbb12', ['body.md']),
    },
  ]);
  assert.equal(document.format, 1);
  assert.equal(document.host, HOST);
  const detailQuery = calls.flat().find((arg) => arg.startsWith('query=') && arg.includes('CardDetails'));
  assert.deepEqual([7, 9, 10, 12].map((number) => detailQuery.includes(`i${number}:`)), [true, false, true, true]);
});

test('a held card shows its question even when awaiting push', () => {
  const page = leanBoardPage([
    card(21, 'A parked job', 'Awaiting push'),
    card(22, 'A backlog card', 'Backlog'),
    card(23, 'A card that only mentions it', 'Backlog'),
  ]);
  const details = {
    i21: detail(21, '', ['Claim: machine-a, Claude Code, 2026-11-02T09:00Z', '  Needs owner: Pick the panel colours. Job: job/21 on machine-a.']),
    i22: detail(22, '', ['Needs owner: Which tracker should this use?']),
    i23: detail(23, '', ['See the Needs owner: note on card 22.']),
  };
  // A complete saved write-up for 21, so only the held comment keeps it from being a merge item.
  const files = {
    [join(reviewFolder(21, 'ccc21'), 'body.md')]: '## Evidence\n\nno visual change\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n',
  };

  const { document } = read({ page, details, jobs: { 21: 'ccc21' }, files });

  assert.deepEqual(shown(document.items), [
    { card: 21, title: 'A parked job', category: 'question', question: 'Needs owner: Pick the panel colours. Job: job/21 on machine-a.', heldOn: 'machine-a' },
    { card: 22, title: 'A backlog card', category: 'question', question: 'Needs owner: Which tracker should this use?' },
  ]);
});

test('a question item names only the first line of its comment', () => {
  const page = leanBoardPage([card(63, 'A question with a link', 'Backlog')]);
  const details = { i63: detail(63, '', ['Needs owner: Which colour?\n[click](https://example.com)']) };

  const { document } = read({ page, details, jobs: {} });

  assert.deepEqual(shown(document.items), [
    { card: 63, title: 'A question with a link', category: 'question', question: 'Needs owner: Which colour?' },
  ]);
});

test('an awaiting card names the first batch-review fact that fails', () => {
  const HERE = 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z';
  const complete = '## Evidence\n\nno visual change\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n';
  const noDecisionCard = '## Evidence\n\nno visual change\n';
  const noScreenshot = '## Evidence\n\nBefore and after, in words.\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n';
  const saved = (number, head, body) => ({ [join(reviewFolder(number, head), 'body.md')]: body });

  const page = leanBoardPage([31, 32, 33, 34, 35, 36, 37, 38, 39].map((number) => card(number, `Card ${number}`, 'Awaiting push')));
  const details = {
    i31: detail(31, '', ['Claim: machine-a, Claude Code cloud, 2026-11-02T09:00Z']),
    i32: detail(32, '', ['Claim: machine-b, Claude Code, 2026-11-02T09:00Z']),
    i33: detail(33, '', []),
    i34: detail(34, '', [HERE]),
    i35: detail(35, '', [HERE]),
    i36: detail(36, '', [HERE]),
    i37: detail(37, '', [HERE]),
    i38: detail(38, '', [HERE]),
    // Fails the claim and has no worktree: only the first fact is named.
    i39: detail(39, '', ['Claim: machine-b, Claude Code, 2026-11-02T09:00Z']),
  };
  const files = {
    ...saved(31, 'h31', complete),
    ...saved(32, 'h32', complete),
    ...saved(35, 'h35', complete),
    ...saved(37, 'h37', noDecisionCard),
    ...saved(38, 'h38', noScreenshot),
  };
  const jobs = { 31: 'h31', 32: 'h32', 33: 'h33', 35: 'h35', 36: 'h36', 37: 'h37', 38: 'h38' };

  const { document } = read({ page, details, jobs, files, dirty: [35] });

  const missing = (number, fact, next) => ({ card: number, title: `Card ${number}`, category: 'merge', missing: { fact, next } });
  const reopen = 'Reopen the job\'s session on this machine.';
  const notHere = ['its newest claim does not name this machine', 'Review it on the machine that built it.'];
  assert.deepEqual(shown(document.items), [
    missing(31, 'it is claimed for a cloud build', 'Open its pull request.'),
    missing(32, ...notHere),
    missing(33, ...notHere),
    missing(34, 'no job worktree for it on this machine', reopen),
    missing(35, 'its job worktree has uncommitted changes', reopen),
    missing(36, 'no saved write-up for its worktree\'s head', reopen),
    missing(37, 'its saved write-up has no decision card', reopen),
    missing(38, 'its write-up has no screenshot and does not say no visual change', reopen),
    missing(39, ...notHere),
  ]);
});

test('an Evidence section that only mentions visual change still needs a screenshot', () => {
  const HERE = 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z';
  const pending = '## Evidence\n\nNo visual change evidence yet; screenshots are pending.\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n';
  const page = leanBoardPage([card(64, 'Screenshots still pending', 'Awaiting push')]);
  const details = { i64: detail(64, '', [HERE]) };
  const files = { [join(reviewFolder(64, 'ddd64'), 'body.md')]: pending };

  const { document } = read({ page, details, jobs: { 64: 'ddd64' }, files });

  assert.deepEqual(shown(document.items), [
    {
      card: 64,
      title: 'Screenshots still pending',
      category: 'merge',
      missing: { fact: 'its write-up has no screenshot and does not say no visual change', next: 'Reopen the job\'s session on this machine.' },
    },
  ]);
});

test('an Evidence line that reads exactly No visual change. still counts as no visual change', () => {
  const HERE = 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z';
  const exact = `## Evidence\n\nNo visual change.\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n${CLEAR_PROOF}`;
  const page = leanBoardPage([card(65, 'Exactly no visual change', 'Awaiting push')]);
  const details = { i65: detail(65, waitingLine(65, 'eee65', ['body.md']), [HERE]) };
  const files = { [join(reviewFolder(65, 'eee65'), 'body.md')]: exact };

  const { document } = read({ page, details, jobs: { 65: 'eee65' }, files });

  assert.deepEqual(shown(document.items), [
    { card: 65, title: 'Exactly no visual change', category: 'merge', decisionCard: 'A card.', visual: 'none', actedOnBy: 'coordinator', head: 'eee65', identity: ids(65, 'eee65', ['body.md']) },
  ]);
});

test('each card takes its first matching category', () => {
  const page = leanBoardPage([
    card(51, 'Held and waiting', 'Awaiting push'),
    card(52, 'Waiting for approval', 'Awaiting push'),
    card(53, 'Proposed: Waiting for approval', 'Awaiting push'),
    card(54, 'Proposed: Held for a question', 'Backlog'),
    card(56, 'Ready and plain', 'Ready'),
    card(57, 'Ready and held', 'Ready'),
    card(58, 'Ready and claimed', 'Ready'),
    card(59, 'Proposed: Ready and proposed', 'Ready'),
  ]);
  const details = {
    i51: detail(51, '', ['Needs owner: Which colour?']),
    i52: detail(52, '', []),
    i53: detail(53, '', []),
    i54: detail(54, '', ['Needs owner: Which size?']),
    i56: detail(56, '', []),
    i57: detail(57, '', ['Needs owner: Which tracker?']),
    i58: detail(58, '', ['Claim: machine-b, Codex, 2026-11-02T09:00Z']),
    i59: detail(59, '', []),
  };

  const { document } = read({ page, details, jobs: {} });

  const missing = { fact: 'its newest claim does not name this machine', next: 'Review it on the machine that built it.' };
  assert.deepEqual(shown(document.items), [
    { card: 51, title: 'Held and waiting', category: 'question', question: 'Needs owner: Which colour?' },
    { card: 52, title: 'Waiting for approval', category: 'merge', missing },
    { card: 53, title: 'Proposed: Waiting for approval', category: 'merge', missing },
    { card: 54, title: 'Proposed: Held for a question', category: 'question', question: 'Needs owner: Which size?' },
    { card: 57, title: 'Ready and held', category: 'question', question: 'Needs owner: Which tracker?' },
    { card: 59, title: 'Proposed: Ready and proposed', category: 'suggested' },
  ]);
});

// The `git` that answers the fetched-main settings reads, `settings.settingText` being the text of
// `.agents/factory-settings.json` on fetched main; any other read is unexpected.
function settingsGit(settings = {}) {
  const {
    settingOid = 'a'.repeat(40),
    settingMode = '100644\n',
    settingText = '{"version":1,"waitForOwner":"when-needed"}',
  } = settings;
  return (callArgs) => {
    const command = JSON.stringify(callArgs);
    if (command === JSON.stringify(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'])) return `${settingOid}\n`;
    if (command === JSON.stringify(['ls-tree', '--full-tree', '--format=%(objectmode)', settingOid, '--', '.agents/factory-settings.json'])) return settingMode;
    if (command === JSON.stringify(['show', `${settingOid}:.agents/factory-settings.json`])) return settingText;
    throw new Error(`unexpected settings git read: ${callArgs.join(' ')}`);
  };
}

test('an unclaimed Ready card is never a queue item of its own', () => {
  const page = leanBoardPage([
    card(56, 'Ready and plain', 'Ready'),
    card(57, 'Ready and plain too', 'Ready'),
    card(58, 'Ready and claimed', 'Ready'),
    card(59, 'Proposed: Ready and proposed', 'Ready'),
  ]);
  const details = {
    i56: detail(56, '', []),
    i57: detail(57, '', []),
    i58: detail(58, '', ['Claim: machine-b, Codex, 2026-11-02T09:00Z']),
    i59: detail(59, '', []),
  };
  // The reader the collector once asked about each unclaimed Ready card: no card waits for an approval any more.
  const asked = [];
  const approvals = (numbers) => {
    asked.push(numbers);
    return { lines: numbers.map((number) => `not approved ${number}: no record`), exitCode: 0 };
  };

  const { document } = read({ page, details, jobs: {}, approvals });

  assert.deepEqual(shown(document.items), [{ card: 59, title: 'Proposed: Ready and proposed', category: 'suggested' }]);
  assert.deepEqual(document.sources, [{ name: 'board', ok: true }, { name: 'details', ok: true }]);
  assert.deepEqual(asked, [], 'no card is asked about');
});

test('the digest lists the last day\'s first-parent merges newest first', () => {
  const page = leanBoardPage([]);
  const digest = [
    'c3c3c3\t2026-11-09T09:30:00+00:00\tThe queue panel shows the digest (#600)',
    'b2b2b2\t2026-11-09T01:15:00+00:00\tFix a typo\twith a tab',
    'a1a1a1\t2026-11-08T22:00:00+01:00\tMerge pull request #599',
  ].join('\n') + '\n';
  const fetchedHead = (path) => {
    if (path !== resolve(ROOT, '.git', 'FETCH_HEAD')) throw new Error(`unexpected file time ${path}`);
    return '2026-11-09T10:00:00.000Z';
  };

  const withFetch = read({ page, details: {}, jobs: {}, digest, fileTime: fetchedHead });

  assert.deepEqual(withFetch.document.digest, [
    { sha: 'c3c3c3', at: '2026-11-09T09:30:00+00:00', subject: 'The queue panel shows the digest (#600)' },
    { sha: 'b2b2b2', at: '2026-11-09T01:15:00+00:00', subject: 'Fix a typo\twith a tab' },
    { sha: 'a1a1a1', at: '2026-11-08T22:00:00+01:00', subject: 'Merge pull request #599' },
  ]);
  assert.equal(withFetch.document.fetchedAt, '2026-11-09T10:00:00.000Z');

  const neverFetched = read({ page, details: {}, jobs: {} });
  assert.deepEqual(neverFetched.document.digest, []);
  assert.equal(neverFetched.document.fetchedAt, null);
});

// The sources that failed, whatever else was read.
const failedSources = (document) => document.sources.filter((source) => !source.ok);

test('a failed source is reported with its cause', (t) => {
  const unresolved = leanNode({ id: 'PVTI_unresolved', content: { __typename: 'Issue', title: 'Content that did not resolve' }, status: 'Backlog', routing: 'Platform' });
  const page = leanBoardPage([card(7, 'A ready card', 'Ready'), card(8, 'A waiting card', 'Awaiting push'), unresolved]);
  const other = (args) => {
    if (args.includes('before=c8')) throw new Error('older page offline');
    return {
      data: {
        repository: {
          i7: { ...detail(7, '', []), body: null },
          i8: {
            number: 8,
            body: '',
            parent: null,
            comments: {
              totalCount: 150,
              pageInfo: { hasPreviousPage: true, startCursor: 'c8' },
              nodes: Array.from({ length: 100 }, (_, index) => commentNode(`comment ${index}`, index)),
            },
          },
        },
      },
    };
  };

  const unread = read({ page, other, jobs: {} });

  assert.deepEqual(failedSources(unread.document), [
    { name: 'board', ok: false, error: '1 card(s) could not be read on this scan: their content did not resolve' },
    { name: 'details', ok: false, error: 'card 7: malformed detail: body; card 8: older page offline' },
  ]);
  assert.deepEqual(shown(unread.document.items), []);

  // A GitHub board that lists nothing is an auth, network or project problem, not an empty board.
  const empty = read({ page: leanBoardPage([]), details: {}, jobs: {} });
  assert.deepEqual(failedSources(empty.document), [
    { name: 'board', ok: false, error: 'the board read returned no cards: an auth, network or project problem, not an empty board' },
  ]);
  assert.deepEqual(shown(empty.document.items), []);

  // A merge digest that cannot be read is null, never the empty list that reads as "nothing merged".
  const waiting = leanBoardPage([card(12, 'A backlog card', 'Backlog')]);
  const waitingDetails = { i12: detail(12, '', []) };
  const unreadableDigest = read({
    page: waiting,
    details: waitingDetails,
    jobs: {},
    run: (args) => {
      if (args[0] === 'log') throw new Error("fatal: bad revision 'origin/main'");
      return scriptedGit({})(args);
    },
  });
  const [digestSource] = failedSources(unreadableDigest.document);
  assert.equal(failedSources(unreadableDigest.document).length, 1);
  assert.equal(digestSource.name, 'digest');
  assert.equal(digestSource.ok, false);
  assert.ok(digestSource.error.includes("fatal: bad revision 'origin/main'"), digestSource.error);
  assert.equal(unreadableDigest.document.digest, null);

  // Without the worktree list no waiting card can be judged, so none is shown as a merge.
  const here = detail(13, '', ['Claim: machine-a, Claude Code, 2026-11-02T09:00Z']);
  const noWorktrees = read({
    page: leanBoardPage([card(13, 'A waiting card', 'Awaiting push')]),
    details: { i13: here },
    jobs: {},
    run: (args) => {
      if (args[0] === 'worktree') throw new Error('fatal: not a git repository');
      return scriptedGit({})(args);
    },
  });
  assert.deepEqual(failedSources(noWorktrees.document), [{ name: 'worktrees', ok: false, error: 'fatal: not a git repository' }]);
  assert.deepEqual(shown(noWorktrees.document.items), []);

  // The entry point reports a failed board read as a document, not a crash.
  const offline = installFakeGh('owner-queue-offline-', "process.stderr.write('fake gh: offline'); process.exitCode = 1;");
  t.after(() => offline.cleanup());
  const entry = toolkit.script('owner-queue.mjs');
  const printed = spawnSync(process.execPath, [entry], { cwd: toolkit.root, encoding: 'utf8', timeout: 30_000, env: offline.env() });
  assert.equal(printed.status, 0, printed.stderr);
  const document = JSON.parse(printed.stdout);
  assert.equal(document.format, 1);
  const board = document.sources.find((source) => source.name === 'board');
  assert.equal(board.ok, false);
  assert.ok(board.error.includes('fake gh: offline'), board.error);

  // An argument is refused before any read.
  const refused = spawnSync(process.execPath, [entry, '--all'], { cwd: toolkit.root, encoding: 'utf8', timeout: 30_000, env: offline.env() });
  assert.equal(refused.status, 2);
  assert.ok(refused.stderr.startsWith('usage: node scripts/owner-queue.mjs'), refused.stderr);
  assert.equal(refused.stdout, '');
});

test('a card whose comments were not all read is reported and never classified', () => {
  const page = leanBoardPage([card(7, 'A ready card', 'Ready'), card(8, 'A ready card with an older page', 'Ready')]);
  // Card 8's loaded comment is a held question, so a reader that classified partial evidence would emit it.
  const other = (args) => {
    if (args.includes('before=c8')) throw new Error('older page offline');
    return {
      data: {
        repository: {
          i7: detail(7, '', ['Needs owner: Which colour?']),
          i8: {
            number: 8,
            body: '',
            parent: null,
            comments: {
              totalCount: 3,
              pageInfo: { hasPreviousPage: true, startCursor: 'c8' },
              nodes: ['Needs owner: Which tracker?', 'A later comment'].map(commentNode),
            },
          },
        },
      },
    };
  };

  const { document } = read({ page, other, jobs: {} });

  assert.deepEqual(failedSources(document), [{ name: 'details', ok: false, error: 'card 8: older page offline' }]);
  assert.deepEqual(shown(document.items), [
    { card: 7, title: 'A ready card', category: 'question', question: 'Needs owner: Which colour?' },
  ]);
});

const NO_WAITING_VERSION = {
  fact: 'its card names no waiting version matching its job\'s current version',
  next: 'Finish any change request in chat, or reopen the job\'s session on this machine.',
};

test('a merge item is missing only where its card ends with a waiting version that does not match its worktree', () => {
  const HERE = 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z';
  const head = '6'.repeat(40);
  const names = ['body.md', 'screenshot-1.png'];
  const files = {
    [join(reviewFolder(66, head), 'body.md')]: `## Evidence\n\nBefore and after.\n\n<details>\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n${CLEAR_PROOF}`,
    [join(reviewFolder(66, head), 'screenshot-1.png')]: '',
  };
  const complete = {
    card: 66, title: 'A waiting card', category: 'merge', decisionCard: 'A card.', screenshots: [join(reviewFolder(66, head), 'screenshot-1.png')], actedOnBy: 'coordinator',
    head, identity: ids(66, head, names),
  };
  const missing = { card: 66, title: 'A waiting card', category: 'merge', missing: NO_WAITING_VERSION };
  const rows = [
    ['no state line', 'Scope of card 66.', complete],
    ['a line naming another head', `Scope of card 66.\n${waitingLine(66, '7'.repeat(40), names)}`, missing],
    ['a line naming another identity', `Scope of card 66.\n${waitingLine(66, head, ['body.md'])}`, missing],
    ['a line naming another card', `Scope of card 66.\n${waitingLine(66, head, names).replace('job/66 ', 'job/67 ')}`, missing],
    ['a line that is not the last line', `Scope of card 66.\n${waitingLine(66, head, names)}\nA later note.`, complete],
    ['a parked line', 'Scope of card 66.\nParked: from the queue panel', complete],
    ['a matching line', `Scope of card 66.\n${waitingLine(66, head, names)}`, complete],
  ];
  const observed = rows.map(([row, body]) => {
    const page = leanBoardPage([card(66, 'A waiting card', 'Awaiting push')]);
    const { document } = read({ page, details: { i66: detail(66, body, [HERE]) }, jobs: { 66: head }, files });
    return { row, items: shown(document.items) };
  });
  assert.deepEqual(observed, rows.map(([row, , item]) => ({ row, items: [item] })));
});

// A deliver menu draws its Yes only where the version its job asked about is the version its merge shows, so a complete
// merge item carries the proof it was judged on: its worktree's head and the identities of its saved write-up and
// screenshots, as a waiting line names them.
test('a complete merge item carries the head and identity of the proof it was judged on', () => {
  const HERE = 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z';
  const head = '5'.repeat(40);
  const names = ['body.md', 'screenshot-1.png', 'screenshot-2.png'];
  const files = {
    [join(reviewFolder(67, head), 'body.md')]: `## Evidence\n\nBefore and after.\n\n<details>\n\n<summary>Decision card</summary>\n\nA card.\n\n</details>\n${CLEAR_PROOF}`,
    [join(reviewFolder(67, head), 'screenshot-1.png')]: '',
    [join(reviewFolder(67, head), 'screenshot-2.png')]: '',
  };
  for (const body of ['Scope of card 67.', `Scope of card 67.\n${waitingLine(67, head, names)}`]) {
    const page = leanBoardPage([card(67, 'A card with a proof', 'Awaiting push')]);
    const { document } = read({ page, details: { i67: detail(67, body, [HERE]) }, jobs: { 67: head }, files });
    const [item] = shown(document.items);
    assert.equal(item.missing, undefined, `the merge is complete: ${JSON.stringify(item)}`);
    assert.deepEqual({ head: item.head, identity: item.identity }, { head, identity: ids(67, head, names) }, `its proof, under the card body ${JSON.stringify(body)}`);
  }
});

// The board the collector shows beside its queue, expected as written by hand: each open card in the order the board
// listed it, its column, its place within that column, the open blockers, the newest claim and the first queue item it
// waits on. A Done card is left out, and a card whose comments were not all read says so and shows no claim or wait. A
// GitHub board says it moves and places cards, and each card it read carries a version.
test('every open card of a fixed board carries its column, place, open blockers, claim, what it waits on, its outcome and its job worktree', () => {
  const claimed = leanNode({
    id: 'PVTI_11',
    content: { __typename: 'Issue', number: 11, title: 'A claimed job', blockers: [{ number: 3, state: 'OPEN' }, { number: 4, state: 'CLOSED', stateReason: 'COMPLETED' }] },
    status: 'In progress',
    routing: 'Platform',
  });
  const page = leanBoardPage([
    card(10, 'A plain ready card', 'Ready'),
    claimed,
    card(12, 'A shipped card', 'Done'),
    card(13, 'A ready card with a question', 'Ready'),
    card(14, 'A card whose comments were not all read', 'In progress'),
  ]);
  const other = (args) => {
    if (args.includes('before=c14')) throw new Error('older page offline');
    return {
      data: {
        repository: {
          i10: detail(10, ['## Problem', '', 'Why.', '', '## What to build', '', 'Show the sheet', 'from the right.', '', 'Then more.', '', '## Acceptance criteria', '', '- [ ] It opens.', ''].join('\n'), []),
          i11: detail(11, '## What to build\n\nOne paragraph only.\n', ['Claim: machine-a, Claude Code, 2026-11-01T09:00Z', 'Claim: machine-b, Codex, 2026-11-02T09:00Z']),
          i13: detail(13, '```\n## What to build\n', ['Needs owner: Which colour?']),
          i14: {
            number: 14,
            body: '',
            parent: null,
            comments: { totalCount: 3, pageInfo: { hasPreviousPage: true, startCursor: 'c14' }, nodes: ['A later comment', 'Another comment'].map(commentNode) },
          },
        },
      },
    };
  };

  const { document } = read({ page, other, jobs: { 11: 'a'.repeat(40) } });

  assert.deepEqual(unversioned(document.board), {
    moves: true,
    places: true,
    cards: [
      { card: 10, title: 'A plain ready card', column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: null, outcome: { text: 'Show the sheet from the right.', more: true }, showFirst: false, worktree: null },
      { card: 11, title: 'A claimed job', column: 'In progress', order: 1, blockers: [3], claim: { machine: 'machine-b', runtime: 'Codex' }, waitsOn: null, outcome: { text: 'One paragraph only.', more: false }, showFirst: false, worktree: worktreeOf(11) },
      { card: 13, title: 'A ready card with a question', column: 'Ready', order: 2, blockers: [], claim: null, waitsOn: 'question', outcome: { unread: 'a code fence is left open' }, showFirst: false, worktree: null },
      { card: 14, title: 'A card whose comments were not all read', column: 'In progress', order: 2, blockers: [], unread: 'older page offline', showFirst: false, worktree: null },
    ],
  });
});

test('a board that cannot be read is null, never empty', () => {
  const offline = collect({
    root: ROOT, tracker: 'github', executor: () => { throw new Error('gh: offline'); }, run: scriptedGit({}), hostname: HOST, login: 'owner', fileTime: notFound, ...folder({}),
  });
  // A GitHub board that lists nothing is an auth, network or project problem, not an empty board.
  const { document: empty } = read({ page: leanBoardPage([]), details: {}, jobs: {} });

  assert.deepEqual(failedSources(offline), [{ name: 'board', ok: false, error: 'gh: offline' }]);
  assert.deepEqual(failedSources(empty), [
    { name: 'board', ok: false, error: 'the board read returned no cards: an auth, network or project problem, not an empty board' },
  ]);
  assert.deepEqual([offline.board, empty.board], [null, null]);
});

test('a board that stays unavailable is reported in plain words with no raw command', () => {
  const pauses = [];
  // A failed `gh` call as Node's execFileSync throws it when GitHub's error body is not JSON.
  const unavailable = () => Object.assign(new Error('Command failed: gh api graphql --paginate --slurp -f query=...\ngh: HTTP 503\n'), { status: 1, stderr: 'gh: HTTP 503\n' });

  const document = collect({
    root: ROOT, tracker: 'github', executor: () => { throw unavailable(); }, pause: (ms) => pauses.push(ms), run: scriptedGit({}), hostname: HOST, login: 'owner', fileTime: notFound, ...folder({}),
  });

  const board = document.sources.find((source) => source.name === 'board');
  assert.equal(board.error, 'GitHub is temporarily unavailable (HTTP 503), still after 3 retries. Nothing retries on its own: try again in a minute.');
  assert.doesNotMatch(board.error, /query=/);
  assert.deepEqual(pauses, [1000, 4000, 9000]);
});

test('a board read refused for an expired sign-in is reported in plain words, with the raw failure as its details', () => {
  const refused = Object.assign(new Error('Command failed: gh api graphql -f query=q\ngh: Bad credentials (HTTP 401)\n'), { status: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' });

  const document = collect({
    root: ROOT, tracker: 'github', executor: () => { throw refused; }, pause: () => {}, run: scriptedGit({}), hostname: HOST, login: 'owner', fileTime: notFound, ...folder({}),
  });

  assert.deepEqual(document.sources.find((source) => source.name === 'board'), {
    name: 'board',
    ok: false,
    error: 'GitHub did not accept the saved sign-in (HTTP 401). Sign in again with gh auth login, then read again.',
    details: 'Command failed: gh api graphql -f query=q gh: Bad credentials (HTTP 401)',
  });
});

// A board read that is whole on GitHub keeps the board's own order, and every other read has none to keep: a card
// GitHub's listing left out is read back after the listed ones, and the other trackers list their cards by id or key.
// A GitHub board still moves and places cards and versions each one it read; another tracker's board does none of them.
test('a board read that recovered omitted cards, or another tracker\'s, carries no order and says why', (t) => {
  const omitted = { id: 'PVTI_12', content: { __typename: 'Issue', number: 12, title: 'An omitted card' }, status: 'Ready', routing: 'Platform' };
  const recovered = read({
    page: leanBoardPage([card(10, 'A listed card', 'Ready')]),
    details: { i10: detail(10, '', []), i12: detail(12, '', []) },
    jobs: {},
    issues: [issuesPage([walkedIssue(10, [membership('PVTI_10')]), walkedIssue(12, [membership('PVTI_12')])])],
    items: [hydratedItem(omitted)],
  });

  assert.deepEqual(unversioned(recovered.document.board), {
    moves: true,
    places: true,
    cards: [
      { card: 10, title: 'A listed card', column: 'Ready', blockers: [], claim: null, waitsOn: null, outcome: null, showFirst: false, worktree: null },
      { card: 12, title: 'An omitted card', column: 'Ready', blockers: [], claim: null, waitsOn: null, outcome: null, showFirst: false, worktree: null },
    ],
    orderUnread: 'GitHub\'s project listing left out 1 card(s) that are on the board, read from their issues instead: #12 (PVTI_12). They are already on the board, so do not add them again.',
  });

  // A markdown install is a real repository of its own, started clean here whatever an earlier test left in the copy.
  const clean = () => {
    rmSync(join(toolkit.root, '.git'), { recursive: true, force: true });
    rmSync(join(toolkit.root, '.agents', 'cards'), { recursive: true, force: true });
  };
  const origin = mkdtempSync(join(tmpdir(), 'owner-queue-origin-'));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  clean();
  t.after(clean);
  realGit(origin, 'init', '--bare', '-b', 'main');
  realGit(toolkit.root, 'init', '-b', 'main');
  mkdirSync(join(toolkit.root, '.agents', 'cards'), { recursive: true });
  for (const [number, status] of [[8, 'Ready'], [9, 'Backlog']]) {
    writeFileSync(join(toolkit.root, '.agents', 'cards', `${number}.md`), [`# Card ${number}`, '', `Status: ${status}`, 'Kind: task', 'Workstream: Product', '', 'Body of the card.', ''].join('\n'));
  }
  realGit(toolkit.root, 'add', '.agents/cards');
  realGit(toolkit.root, 'commit', '-m', 'file the cards');
  realGit(toolkit.root, 'remote', 'add', 'origin', origin);
  realGit(toolkit.root, 'push', 'origin', 'main');
  const never = () => {
    throw new Error('neither a pull request nor an approval is asked on a markdown board');
  };
  const markdown = collect({
    root: ROOT, tracker: 'markdown', executor: never, run: scriptedGit({}), hostname: HOST, login: null, fileTime: notFound, ...folder({}),
  });

  assert.deepEqual(failedSources(markdown), []);
  assert.deepEqual(unversioned(markdown.board, { github: false }), {
    moves: false,
    places: false,
    cards: [
      { card: 8, title: 'Card 8', column: 'Ready', blockers: [], claim: null, waitsOn: null, outcome: null, worktree: null },
      { card: 9, title: 'Card 9', column: 'Backlog', blockers: [], claim: null, waitsOn: null, outcome: null, worktree: null },
    ],
    orderUnread: 'this tracker\'s board carries no owner-set order',
  });
});

test('a board whose worktrees could not be read explains why its waits are unreadable', () => {
  const { exec } = boardReadExec({ board: [leanBoardPage([card(8, 'A ready card', 'Ready')])], other: { data: { repository: { i8: detail(8, '', []) } } } });
  const run = (args) => {
    if (args[0] === 'worktree') throw new Error('fatal: not a git repository');
    return scriptedGit({})(args);
  };
  const document = collect({
    root: ROOT, tracker: 'github', executor: exec, run, hostname: HOST, login: 'owner', fileTime: notFound, ...folder({}),
  });

  assert.deepEqual(failedSources(document).map((source) => source.name), ['worktrees']);
  assert.deepEqual(unversioned(document.board), {
    moves: true,
    places: true,
    cards: [{ card: 8, title: 'A ready card', column: 'Ready', order: 1, blockers: [], claim: null, waitsOn: null, outcome: null, showFirst: false }],
    waitsOnUnread: ['worktrees'],
  });
});

// A GitHub board card carries whether the tracker holds the show-me-first marker on it, read with the board and so
// present on a card whose details were not read; labels that are not text give the cause, never an absent marker.
test('ANTI-REGRESSION: each GitHub board card carries its show-me-first marker as the tracker holds it, and a card whose labels are not text as unread, never off', () => {
  const page = leanBoardPage([
    card(10, 'A card marked in lower case', 'Ready', ['bug', 'show-me-first']),
    card(11, 'A card marked in another case with spaces', 'In progress', [' Show-Me-First ']),
    card(12, 'A card with other labels only', 'Ready', ['bug']),
    card(13, 'A card with no labels', 'Ready'),
    card(14, 'A card whose labels are not text', 'Ready', [7]),
    card(15, 'A marked card whose comments were not all read', 'In progress', ['show-me-first']),
  ]);
  const other = (args) => {
    if (args.includes('before=c15')) throw new Error('older page offline');
    return {
      data: {
        repository: {
          ...Object.fromEntries([10, 11, 12, 13, 14].map((number) => [`i${number}`, detail(number, '', [])])),
          i15: { number: 15, body: '', parent: null, comments: { totalCount: 2, pageInfo: { hasPreviousPage: true, startCursor: 'c15' }, nodes: [commentNode('A later comment')] } },
        },
      },
    };
  };

  const { document } = read({ page, other, jobs: {} });

  assert.deepEqual(document.board.cards.map((entry) => [entry.card, entry.showFirst]), [
    [10, true],
    [11, true],
    [12, false],
    [13, false],
    [14, { unread: 'unreadable labels on card 14' }],
    [15, true],
  ]);
  assert.equal(document.board.cards.find((entry) => entry.card === 15).unread, 'older page offline');
});

// A card's version binds a board move to the card as the panel drew it: what the owner approves and where it lands.
test('a card version is fixed by its number, title, column, place and body and by nothing else the board shows', () => {
  // Card `number` as a board read draws it: listed after card 9, which is in `before`, with its own title, column, open
  // blockers and body and comments, read beside the job heads `jobs`.
  const drawn = ({
    number = 11, title = 'A versioned card', column = 'Ready', before = 'In progress', blockers = [], body = 'Scope of the card.', comments = [], jobs = {},
  } = {}) => {
    const page = leanBoardPage([
      card(9, 'A card listed first', before),
      leanNode({ id: `PVTI_${number}`, content: { __typename: 'Issue', number, title, blockers }, status: column, routing: 'Platform' }),
    ]);
    const { document } = read({ page, details: { i9: detail(9, '', []), [`i${number}`]: detail(number, body, comments) }, jobs });
    return document.board.cards.find((entry) => entry.card === number);
  };
  const base = drawn();
  assert.match(String(base.version), /^[0-9a-f]{64}$/);
  assert.equal(drawn().version, base.version, 'the same card read again keeps its version');

  const changed = {
    number: drawn({ number: 12 }),
    title: drawn({ title: 'A renamed card' }),
    column: drawn({ column: 'Backlog' }),
    place: drawn({ before: 'Ready' }),
    body: drawn({ body: 'Another scope.' }),
  };
  assert.deepEqual([base, changed.column, changed.place].map((entry) => [entry.column, entry.order]), [['Ready', 1], ['Backlog', 1], ['Ready', 2]]);
  assert.deepEqual(Object.entries(changed).filter(([, entry]) => entry.version === base.version).map(([name]) => name), []);

  const kept = {
    claim: drawn({ comments: ['Claim: machine-a, Claude Code, 2026-11-01T09:00Z'] }),
    waitsOn: drawn({ comments: ['Needs owner: Which colour?'] }),
    worktree: drawn({ jobs: { 11: 'a'.repeat(40) } }),
    blockers: drawn({ blockers: [{ number: 3, state: 'OPEN' }] }),
  };
  assert.deepEqual([kept.claim.claim, kept.waitsOn.waitsOn, kept.worktree.worktree, kept.blockers.blockers],
    [{ machine: 'machine-a', runtime: 'Claude Code' }, 'question', worktreeOf(11), [3]]);
  assert.deepEqual(Object.entries(kept).filter(([, entry]) => entry.version !== base.version).map(([name]) => name), []);
});

// What the panel and `act` read in one repository: a board of cards with their bodies and comments, the job heads and
// dirty worktrees, saved files, and `login`: the text the login read prints, or a function
// that prints or throws instead.
const H7 = '7'.repeat(40);
const H8 = '8'.repeat(40);
const H9 = '9'.repeat(40);
const H9B = 'b'.repeat(40);
const commentUrl = (number, id) => `https://github.com/${BOARD_OWNER}/${BOARD_REPOSITORY}/issues/${number}#issuecomment-${id}`;
const comment = (number, id, body, login = 'owner') => ({
  author: { login }, body, createdAt: new Date(Date.parse('2026-11-08T18:00:00Z') + id * 1000).toISOString(), url: commentUrl(number, id),
});
const writeUp = (decision, evidence, proof = CLEAR_PROOF) => `## Evidence\n\n${evidence}\n\n<details>\n\n<summary>Decision card</summary>\n\n${decision}\n\n</details>\n${proof}`;
const SCOPED = ['## Why', '', 'The panel needs it.', '', '## What to build', '', 'A Keep control.', '', '## Acceptance criteria', '', '- [ ] Keep files it.', ''].join('\n');

function actModel() {
  return {
    login: 'owner',
    heads: { 7: H7, 8: H8, 9: H9 },
    dirty: [],
    files: {
      [join(reviewFolder(7, H7), 'body.md')]: writeUp('Card 7 ships the panel.', 'Before and after.'),
      [join(reviewFolder(7, H7), 'screenshot-1.png')]: '',
      [join(reviewFolder(8, H8), 'body.md')]: writeUp('Card 8 reads once.', 'No visual change.'),
      [join(reviewFolder(9, H9), 'body.md')]: writeUp('Card 9 waits.', 'Before and after.'),
      [join(reviewFolder(9, H9), 'screenshot-1.png')]: '',
      [join(reviewFolder(9, H9B), 'body.md')]: writeUp('Card 9 waits.', 'Before and after.'),
      [join(reviewFolder(9, H9B), 'screenshot-1.png')]: '',
    },
    cards: {
      7: { title: 'A built merge', status: 'Awaiting push', body: `Scope of card 7.\n${waitingLine(7, H7, ['body.md', 'screenshot-1.png'])}`,
        comments: [comment(7, 3007, 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z')] },
      8: { title: 'A merge with no visual change', status: 'Awaiting push', body: `Scope of card 8.\n${waitingLine(8, H8, ['body.md'])}`,
        comments: [comment(8, 3008, 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z')] },
      9: { title: 'A merge whose card names another version', status: 'Awaiting push', body: `Scope of card 9.\n${waitingLine(9, '6'.repeat(40), ['body.md', 'screenshot-1.png'])}`,
        comments: [comment(9, 3009, 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z')] },
      // An earlier Park left an answered return before the latest question.
      21: { title: 'A question after a return', status: 'Backlog', body: 'Scope of card 21.', comments: [
        comment(21, 3021, 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z'),
        comment(21, 3022, 'Returned: Pick one. Job: job/21 on machine-a.'),
        comment(21, 3023, 'Needs owner: Which colour? Job: job/21 on machine-a.\nBlue or green.'),
      ] },
      22: { title: 'A question with no machine', status: 'Backlog', body: 'Scope of card 22.',
        comments: [comment(22, 3122, 'Needs owner: Which tracker should this use?')] },
      // An ordinary local job's hold names its job and machine.
      23: { title: 'A local job\'s question', status: 'Backlog', body: 'Scope of card 23.', comments: [
        comment(23, 3231, 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z'),
        comment(23, 3232, 'Needs owner: Which size? Job: job/23 on machine-a.'),
      ] },
      41: { title: 'Work in progress', status: 'In progress', body: 'Scope of card 41.', comments: [] },
      54: { title: 'Proposed: A scoped suggestion', status: 'Backlog', body: SCOPED, comments: [] },
      55: { title: 'Proposed: An unscoped suggestion', status: 'Backlog', body: '## Why\n\nThe panel needs it.', comments: [] },
    },
  };
}

const commentId = (url) => Number(/#issuecomment-(\d+)$/.exec(url)[1]);

// The executor `collect`, `act` and `undo` read and write the model through: the board read, every other read they
// make, and each write, which changes the model as GitHub would and is recorded in order as its arguments, a body file's
// path written `<file>`, and the text it carries, read at call time. An `issue` call is matched without its `--repo`
// pair and recorded with it, so what the call names is the test's to assert. The card read names `owner` as the
// signed-in account, a comment a write posts is by `owner`, and the item lookup finds no board item for a card marked
// `offBoard`. The issues listing a filing reads answers `model.filed`'s issues for the repository it names; an issue
// create is numbered from 900, joins that list and is recorded with its body file's text, and one in the board
// repository becomes a card off the board that the board read does not list; the add-item and field-value mutations a
// placement makes are recorded as `{ board: { card, added } }` and `{ board: { card, field, value } }`. The card detail
// read names each comment's own author. After recording any write it calls `model.duringAct` with the write's arguments, where the model has one,
// so a row can edit the card while an action writes. A `show-me-first` label edit adds the label to the card's labels or
// removes it whatever its case, as `gh` matches a label name. Its Status field offers every configured column but the model's
// `removedColumn`, where it names one. A card read answers 100 comments at most, as GitHub does; the whole card read
// pages on from the cursor `c<n>`, n the comments before the page; a model's `foreignLaterPage` answers those later pages
// for another repository. The board lists the open cards in `model.order` where the model has one, else by number, and
// `model.issues` and `model.items`, where given, are the issue walk and item hydration a recovering read makes. A
// position write, as GitHub's `updateProjectV2ItemPosition` takes it, sends `afterId` exactly when it names an after
// item; it is recorded as `{ position: { item, after } }`, `after` null for first, and moves the card in `model.order`
// after that item or first, unless the model's `positionReply` answers it instead and nothing moves.
const BOARD_SLUG = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
// The option id the fake Status fields give the column `name`.
const optionId = (name) => `opt-${name.toLowerCase().replaceAll(' ', '-')}`;

function actExec(model) {
  const writes = [];
  const bodyFiles = [];
  const options = STATUS_OPTIONS.filter((name) => name !== model.removedColumn).map((name) => ({ id: optionId(name), name }));
  const routes = ROUTING_OPTIONS.map((name) => ({ id: `route-${name.toLowerCase()}`, name }));
  const cardOf = (number) => {
    const entry = model.cards[number];
    assert.ok(entry, `unexpected card ${number}`);
    return entry;
  };
  const fileText = (path) => {
    bodyFiles.push(path);
    return readFileSync(path, 'utf8');
  };
  const respond = (args) => {
    const call = args.join(' ');
    const repoAt = args.indexOf('--repo');
    const bare = args[0] === 'issue' && repoAt > 0 ? args.filter((_, at) => at !== repoAt && at !== repoAt + 1) : args;
    const bareCall = bare.join(' ');
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (call === 'api user --jq .login') return typeof model.login === 'function' ? model.login() : `${model.login}\n`;
    if (call === `repo view ${BOARD_SLUG} --json id,nameWithOwner`) return { id: 'R_act', nameWithOwner: BOARD_SLUG };
    if (query.includes('CardDetails')) {
      const asked = [...query.matchAll(/\bi(\d+): issue\(number:/g)].map(([, number]) => Number(number));
      return { data: { repository: Object.fromEntries(asked.map((number) => {
        const { body, comments } = cardOf(number);
        const read = detail(number, body, comments.map((each) => each.body));
        read.comments.nodes.forEach((node, index) => { node.author = { login: comments[index].author.login }; });
        return [`i${number}`, read];
      })) } };
    }
    // The whole card read, which Undo and the state line writer make: 100 comments to a page, from the comment the
    // cursor `c<n>` names.
    if (query.includes('comments(first: 100, after: $after)')) {
      const entry = cardOf(Number(args.find((arg) => arg.startsWith('number=')).slice('number='.length)));
      const start = Number(args.find((arg) => arg.startsWith('after='))?.slice('after=c'.length) ?? 0);
      const nodes = entry.comments.slice(start, start + 100).map((node) => ({ lastEditedAt: null, ...node }));
      return { data: { repository: { id: model.foreignLaterPage && start > 0 ? 'R_other' : 'R_act', issue: {
        state: entry.closed ? 'CLOSED' : 'OPEN', title: entry.title, body: entry.body,
        comments: { pageInfo: { hasNextPage: start + nodes.length < entry.comments.length, endCursor: `c${start + nodes.length}` }, nodes },
      } } } };
    }
    if (query.includes('comments(first: 100)')) {
      const entry = cardOf(Number(args.find((arg) => arg.startsWith('number=')).slice('number='.length)));
      return { data: { viewer: { login: 'owner' }, repository: { id: 'R_act', issue: {
        state: entry.closed ? 'CLOSED' : 'OPEN', title: entry.title, body: entry.body, lastEditedAt: entry.lastEditedAt ?? null,
        comments: { pageInfo: { hasNextPage: entry.comments.length > 100 }, nodes: entry.comments.slice(0, 100).map((node) => ({ lastEditedAt: null, ...node })) },
      } } } };
    }
    // A card's two newest revisions after a body edit: the edit's text and the body it replaced.
    if (query.includes('userContentEdits(first: 2)')) {
      const entry = cardOf(Number(args.find((arg) => arg.startsWith('number=')).slice('number='.length)));
      assert.ok(entry.history, `unexpected edit history read: ${call}`);
      return { data: { repository: { id: 'R_act', issue: { userContentEdits: { nodes: entry.history.map((diff) => ({ diff })) } } } } };
    }
    if (query.includes('field(name:"Status")')) {
      return { data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_act', field: { id: 'PVTSSF_status', options } } } } };
    }
    if (query.includes('projectItems(first:20)')) {
      const number = Number(/issue\(number:(\d+)\)/.exec(query)[1]);
      const entry = cardOf(number);
      return issueItemReply(entry.offBoard ? [] : [{ ...membership(`PVTI_${number}`), value: { name: entry.status } }], { issueId: `I_${number}` });
    }
    const edit = new RegExp(`^api -X PATCH repos/${BOARD_SLUG}/issues/(\\d+) -f body=`).exec(call);
    if (edit && args.length === 6) {
      const entry = cardOf(Number(edit[1]));
      const text = args[5].slice('body='.length);
      entry.history = [text, entry.body];
      entry.body = text;
      entry.lastEditedAt = '2026-11-09T09:00:00Z';
      writes.push({ args: [...args.slice(0, 5), 'body=<text>'], text: entry.body });
      return { number: Number(edit[1]), body: entry.body };
    }
    if (bare[0] === 'issue' && bare[1] === 'comment' && bare[3] === '--body-file' && bare.length === 5) {
      const id = 5000 + writes.length;
      const text = fileText(bare[4]);
      cardOf(Number(bare[2])).comments.push(comment(Number(bare[2]), id, text));
      writes.push({ args: [...args.slice(0, -1), '<file>'], text });
      return `${commentUrl(Number(bare[2]), id)}\n`;
    }
    if (bare[0] === 'issue' && bare[1] === 'edit' && bare[3] === '--title' && bare.length === 5) {
      cardOf(Number(bare[2])).title = bare[4];
      writes.push({ args });
      return {};
    }
    if (bare.length === 5 && bare[0] === 'issue' && bare[1] === 'edit' && ['--add-label', '--remove-label'].includes(bare[3]) && bare[4] === 'show-me-first') {
      const entry = cardOf(Number(bare[2]));
      const labels = entry.labels ?? [];
      entry.labels = bare[3] === '--add-label' ? [...labels, bare[4]] : labels.filter((name) => name.toLowerCase() !== bare[4]);
      writes.push({ args });
      return '';
    }
    if (bare.length === 5 && bareCall === `issue close ${bare[2]} --reason not planned`) {
      cardOf(Number(bare[2])).closed = true;
      writes.push({ args });
      return '';
    }
    const move = /^project item-edit --id PVTI_(\d+) --project-id PVT_act --field-id PVTSSF_status --single-select-option-id (\S+)$/.exec(call);
    if (move) {
      const option = options.find(({ id }) => id === move[2]);
      assert.ok(option, `unexpected option ${move[2]}`);
      cardOf(Number(move[1])).status = option.name;
      writes.push({ args });
      return '';
    }
    if (bare.length === 3 && bareCall === `issue reopen ${bare[2]}`) {
      cardOf(Number(bare[2])).closed = false;
      writes.push({ args });
      return '';
    }
    const removal = new RegExp(`^api -X DELETE repos/${BOARD_SLUG}/issues/comments/(\\d+)$`).exec(call);
    if (removal) {
      const holder = Object.values(model.cards).find((entry) => entry.comments.some(({ url }) => commentId(url) === Number(removal[1])));
      assert.ok(holder, `unexpected comment ${removal[1]}`);
      holder.comments.splice(holder.comments.findIndex(({ url }) => commentId(url) === Number(removal[1])), 1);
      writes.push({ args });
      return '';
    }
    const cleared = /^project item-edit --id PVTI_(\d+) --project-id PVT_act --field-id PVTSSF_status --clear$/.exec(call);
    if (cleared) {
      cardOf(Number(cleared[1])).status = null;
      writes.push({ args });
      return '';
    }
    if (args[0] === 'api' && args[1] === 'graphql' && query.includes('updateProjectV2ItemPosition')) {
      const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const [item, after] = [field('item'), field('after') ?? null];
      assert.equal(field('project'), 'PVT_act', `unexpected project: ${call}`);
      assert.equal(query.includes('afterId: $after'), after !== null, `afterId travels exactly when an after item is sent: ${call}`);
      const itemOf = (id) => {
        const number = Number(/^PVTI_(\d+)$/.exec(id)?.[1]);
        assert.ok(model.order.includes(number), `unexpected item ${id}`);
        return number;
      };
      const [moved, anchor] = [itemOf(item), after === null ? null : itemOf(after)];
      writes.push({ position: { item, after } });
      if (model.positionReply !== undefined) return model.positionReply;
      model.order.splice(model.order.indexOf(moved), 1);
      model.order.splice(anchor === null ? 0 : model.order.indexOf(anchor) + 1, 0, moved);
      return { data: { updateProjectV2ItemPosition: { clientMutationId: null } } };
    }
    const listed = /^api repos\/([^/]+\/[^/?]+)\/issues\?creator=owner&state=all&since=[^&]+&per_page=100 --paginate --slurp$/.exec(call);
    if (listed) return JSON.stringify([model.filed?.[listed[1]] ?? []]);
    if (args.length === 10 && call.startsWith('issue create --repo ') && args[4] === '--title' && args[6] === '--body-file' && ['--label', '--type'].includes(args[8])) {
      const number = 900 + writes.filter((write) => write.args?.[1] === 'create').length;
      const text = fileText(args[7]);
      const issue = { number, title: args[5], body: text, state: 'open', html_url: `https://github.com/${args[3]}/issues/${number}` };
      ((model.filed ??= {})[args[3]] ??= []).push(issue);
      if (args[3] === BOARD_SLUG) model.cards[number] = { title: args[5], status: null, body: text, comments: [], offBoard: true, unlisted: true };
      writes.push({ args: [...args.slice(0, 7), '<file>', ...args.slice(8)], text });
      return `${issue.html_url}\n`;
    }
    const added = /addProjectV2ItemById\(input:\{projectId:"PVT_act", contentId:"I_(\d+)"\}/.exec(query);
    if (added) {
      cardOf(Number(added[1])).offBoard = false;
      writes.push({ board: { card: Number(added[1]), added: true } });
      return { data: { addProjectV2ItemById: { item: { id: `PVTI_${added[1]}` } } } };
    }
    const set = /updateProjectV2ItemFieldValue\(input:\{projectId:"PVT_act", itemId:"PVTI_(\d+)", fieldId:"(PVTSSF_status|PVTSSF_routing)", value:\{singleSelectOptionId:"([^"]+)"\}\}/.exec(query);
    if (set) {
      const [field, offered, key] = set[2] === 'PVTSSF_status' ? ['Status', options, 'status'] : [ROUTING_FIELD, routes, 'routing'];
      const option = offered.find(({ id }) => id === set[3]);
      assert.ok(option, `unexpected option ${set[3]}`);
      cardOf(Number(set[1]))[key] = option.name;
      writes.push({ board: { card: Number(set[1]), field, value: option.name } });
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${set[1]}` } } } };
    }
    if (query.includes(`field(name:"${ROUTING_FIELD}")`)) {
      return { data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_act', field: { id: 'PVTSSF_routing', options: routes } } } } };
    }
    throw new Error(`unexpected gh ${call}`);
  };
  const other = (args) => {
    const recorded = writes.length;
    const reply = respond(args);
    if (writes.length > recorded) model.duringAct?.(args);
    return reply;
  };
  const board = () => [leanBoardPage((model.order ?? Object.keys(model.cards).map(Number)).filter((number) => !cardOf(number).closed && !cardOf(number).unlisted)
    .map((number) => card(number, model.cards[number].title, model.cards[number].status, model.cards[number].labels)))];
  const { exec, calls } = boardReadExec({ board, other, issues: model.issues, items: model.items });
  return { exec, calls, writes, bodyFiles };
}

// The readers `collect` and `act` share over the model, as the entry point passes them. Its git answers the three
// fetched-main settings reads from `model.settingText` and `model.settingOid` as `settingsGit` does, and every other read from the jobs.
const modelReaders = (model) => {
  const settings = settingsGit({ settingText: model.settingText, settingOid: model.settingOid });
  const jobs = scriptedGit(model.heads, model.dirty);
  const run = (args) => {
    try {
      return settings(args);
    } catch (error) {
      if (!error.message.startsWith('unexpected settings git read')) throw error;
      return jobs(args);
    }
  };
  return { root: ROOT, run, hostname: HOST, fileTime: notFound, ...folder(model.files) };
};

// The model's queue as `collect` reads it for `login` on `host`, with the calls it made.
function collectModel(model, { login = 'owner', host = HOST } = {}) {
  const { exec, calls } = actExec(model);
  return { document: collect({ ...modelReaders(model), hostname: host, tracker: 'github', executor: exec, login }), calls };
}

const versionsOf = (model, options) => new Map(collectModel(model, options).document.items.map((item) => [item.card, item.version]));

// `act` over the model: the writes it made, the body files it named, the lines it logged, and the line it refused with
// where it refused. The login it is given is what the model's login read prints, or null where that read cannot be
// used, as the entry point gives it.
async function acting(model, request, { tracker = 'github' } = {}) {
  const { exec, calls, writes, bodyFiles } = actExec(model);
  const logged = [];
  const login = typeof model.login === 'string' ? model.login : null;
  try {
    await act({ ...modelReaders(model), tracker, executor: exec, login, output: { log: (line) => logged.push(line), error: () => {} }, ...request });
    return { calls, writes, bodyFiles, logged };
  } catch (error) {
    return { calls, writes, bodyFiles, logged, refused: error.message };
  }
}

// `undo` over the model as `acting` runs `act`, on a fresh executor: its calls, its writes, the lines it logged, and the
// line it refused with where it refused.
async function undoing(model, request, { tracker = 'github' } = {}) {
  const { exec, calls, writes } = actExec(model);
  const logged = [];
  const login = typeof model.login === 'string' ? model.login : null;
  try {
    await undo({ ...modelReaders(model), tracker, executor: exec, login, output: { log: (line) => logged.push(line), error: () => {} }, ...request });
    return { calls, writes, logged };
  } catch (error) {
    return { calls, writes, logged, refused: error.message };
  }
}

// The undo record an action logged: the text after its prefix on the last logged line, or undefined where that line
// holds none.
const RECORD_PREFIX = 'owner-queue: undo record ';
const recordOf = (logged) => {
  const last = logged.at(-1) ?? '';
  return last.startsWith(RECORD_PREFIX) ? last.slice(RECORD_PREFIX.length) : undefined;
};

// The proof lines of a saved write-up, as the judge of finished work reads them, each holding nothing unless it is given.
const proofOf = ({
  failed = 'none', untested = 'none', undo = 'easy', notDone = 'Nothing', review = 'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0',
}) => `Failed: ${failed}\nUntested: ${untested}\nUndo: ${undo}\n\n## Not done\n\n${notDone}\n\n## Review\n\n${review}\n`;

test('ANTI-REGRESSION: a held merge names each reason its saved write-up holds, and one the judge cannot read is a missing-proof item, never a clear one', async (t) => {
  // Each card is claimed here and ends in its waiting line, so only its saved write-up differs. The reasons are written
  // by hand in the order the owner reads them: check, screenshot, beyond-card, sign-off, hard-to-undo.
  const signOff = 'Review: tier=sign-off rounds=1 raised=0 fixed=0 dismissed=0 deferred=0';
  const writeUps = {
    11: proofOf({ failed: 'the lint step' }),
    12: proofOf({ undo: 'hard, the release cannot be recalled', notDone: '- the second panel', review: signOff }),
    13: proofOf({ failed: 'two tests', untested: 'npm run lint:docs', undo: 'hard', notDone: '- the second panel', review: signOff }),
    14: '',
    15: proofOf({ undo: 'maybe' }),
  };
  const heldModel = (settings = {}) => {
    const model = Object.assign(actModel(), settings);
    for (const [number, proof] of Object.entries(writeUps)) {
      const head = `held${number}`;
      model.heads[number] = head;
      model.files[join(reviewFolder(number, head), 'body.md')] = writeUp(`Card ${number} waits.`, 'No visual change.', proof);
      model.cards[number] = { title: `A merge ${number}`, status: 'Awaiting push', body: `Scope of card ${number}.\n${waitingLine(number, head, ['body.md'])}`,
        comments: [comment(number, 3000 + Number(number), 'Claim: machine-a, Claude Code, 2026-11-02T09:00Z')] };
    }
    return model;
  };
  const mergesOf = (document) => shown(document.items).filter((item) => item.category === 'merge' && item.card >= 8);
  const held = (number, reason) => ({
    card: number, title: `A merge ${number}`, category: 'merge', decisionCard: `Card ${number} waits.`, visual: 'none', reason, actedOnBy: 'coordinator',
    head: `held${number}`, identity: ids(number, `held${number}`, ['body.md']),
  });
  const proof8 = { head: H8, identity: ids(8, H8, ['body.md']) };
  const everyCardWaits = 'every card waits for you: waitForOwner is always';
  const outsideHerdr = (holds) => `outside a Herdr job also: ${holds}`;

  // The wait level is read from fetched main's settings; at `always` every card waits, whatever its write-up holds.
  await t.test('at always every merge also waits on the level, after the reasons its write-up holds', () => {
    const { document } = collectModel(heldModel({ settingText: '{"version":1,"waitForOwner":"always"}' }));
    const items = mergesOf(document);
    const named = (number) => items.find((item) => item.card === number);
    assert.deepEqual(named(8), { card: 8, title: 'A merge with no visual change', category: 'merge', decisionCard: 'Card 8 reads once.', visual: 'none', reason: outsideHerdr(everyCardWaits), actedOnBy: 'coordinator', ...proof8 });
    assert.deepEqual(named(11), held(11, `check; ${outsideHerdr(everyCardWaits)}`));
    assert.deepEqual(named(13), held(13, `check; ${outsideHerdr(`beyond-card, sign-off, hard-to-undo, ${everyCardWaits}`)}`));
  });
  await t.test('at when-needed a merge holds only its write-up reasons', () => {
    const { document } = collectModel(heldModel({ settingText: '{"version":1,"waitForOwner":"when-needed"}' }));
    const items = mergesOf(document);
    assert.deepEqual(items.find((item) => item.card === 8), { card: 8, title: 'A merge with no visual change', category: 'merge', decisionCard: 'Card 8 reads once.', visual: 'none', actedOnBy: 'coordinator', ...proof8 });
    assert.deepEqual(items.find((item) => item.card === 11), held(11, 'check'));
  });
  await t.test('a level that cannot be read is a failed source and leaves no merge clear', () => {
    const { document } = collectModel(heldModel({ settingOid: 'not-an-object' }));
    assert.equal(document.sources.filter((source) => !source.ok).length, 1, `one failed source: ${JSON.stringify(document.sources)}`);
    const merges = mergesOf(document);
    assert.ok(merges.length >= 2);
    for (const merge of merges) assert.ok(merge.reason !== undefined || merge.missing !== undefined, `card ${merge.card} is not shown as clear: ${JSON.stringify(merge)}`);
  });

  const model = heldModel();
  const items = shown(collectModel(model).document.items).filter((item) => item.category === 'merge' && item.card >= 8);
  const named = (number) => items.find((item) => item.card === number);

  assert.deepEqual([named(8), named(11), named(12), named(13)], [
    { card: 8, title: 'A merge with no visual change', category: 'merge', decisionCard: 'Card 8 reads once.', visual: 'none', actedOnBy: 'coordinator', ...proof8 },
    held(11, 'check'),
    held(12, outsideHerdr('beyond-card, sign-off, hard-to-undo')),
    held(13, `check; ${outsideHerdr('beyond-card, sign-off, hard-to-undo')}`),
  ]);
  // A write-up the judge cannot read names what is missing and is no decision card: never a merge with no reason.
  for (const [number, cause] of [[14, /Failed/], [15, /Undo/]]) {
    assert.deepEqual(Object.keys(named(number)).sort(), ['card', 'category', 'missing', 'title'], `card ${number} is a missing-proof item`);
    assert.match(named(number).missing.fact, cause, `card ${number} names the line the judge could not read`);
    assert.equal(typeof named(number).missing.next, 'string');
  }
});

test('ANTI-REGRESSION: a merge card carrying show-me-first waits naming it, and work on screen waits at on-screen', () => {
  const model = (settingText, marked = []) => {
    const built = Object.assign(actModel(), { settingText });
    for (const number of marked) built.cards[number].labels = ['show-me-first'];
    return built;
  };
  const reasonOf = (document, number) => document.items.find((item) => item.card === number && item.category === 'merge').reason;
  const level = (name) => `{"version":1,"waitForOwner":"${name}"}`;
  const everyCardWaits = 'every card waits for you: waitForOwner is always';
  const outsideHerdr = (holds) => `outside a Herdr job also: ${holds}`;

  // A card with no visual change still shows its decision card and says so, and the label alone holds it.
  const { document } = collectModel(model(level('when-needed'), [8]));
  assert.deepEqual(shown(document.items).find((item) => item.card === 8),
    { card: 8, title: 'A merge with no visual change', category: 'merge', decisionCard: 'Card 8 reads once.', visual: 'none', reason: 'show-me-first', actedOnBy: 'coordinator',
      head: H8, identity: ids(8, H8, ['body.md']) });
  assert.equal(reasonOf(document, 7), undefined, 'a card without the label is not held by it');
  assert.equal(reasonOf(collectModel(model(level('when-needed'))).document, 8), undefined);
  assert.equal(reasonOf(collectModel(model(level('always'), [8])).document, 8), `show-me-first; ${outsideHerdr(everyCardWaits)}`);

  // At on-screen the work on screen waits and work with no visual change merges, so a marked card is held only by its label.
  const onScreen = collectModel(model(level('on-screen'))).document;
  assert.equal(reasonOf(onScreen, 7), outsideHerdr('on-screen'));
  assert.equal(reasonOf(onScreen, 8), undefined);
  assert.equal(reasonOf(collectModel(model(level('on-screen'), [7, 8])).document, 7), `show-me-first; ${outsideHerdr('on-screen')}`);
  assert.equal(reasonOf(collectModel(model(level('on-screen'), [8])).document, 8), 'show-me-first');

  // A "no visual change" line quoted in a fenced code block is not the write-up saying it, as the guard reads it, and
  // the label is matched by its name trimmed and lower-cased, so a near-miss spelling still holds the card.
  const quoted = model(level('on-screen'));
  quoted.files[join(reviewFolder(7, H7), 'body.md')] = writeUp('Card 7 ships the panel.', 'Before and after.\n\n```\nno visual change\n```');
  const nearMiss = model(level('when-needed'));
  nearMiss.cards[8].labels = [' Show-Me-First '];
  assert.deepEqual({
    'on-screen, no visual change quoted in a fence': reasonOf(collectModel(quoted).document, 7),
    'when-needed, a card labelled " Show-Me-First "': reasonOf(collectModel(nearMiss).document, 8),
  }, {
    'on-screen, no visual change quoted in a fence': outsideHerdr('on-screen'),
    'when-needed, a card labelled " Show-Me-First "': 'show-me-first',
  });
});

test('ANTI-REGRESSION: a merge card whose labels are not text is reported unreadable on its own, and its sibling still reads', () => {
  // Card 7's board answer gives a label that is not text; card 8 is healthy and carries show-me-first.
  const model = Object.assign(actModel(), { settingText: '{"version":1,"waitForOwner":"when-needed"}' });
  model.cards[7].labels = [7];
  model.cards[8].labels = ['show-me-first'];

  const { document } = collectModel(model);
  const merge = (number) => document.items.find((item) => item.card === number && item.category === 'merge');
  assert.equal(merge(8)?.reason, 'show-me-first', 'the healthy sibling keeps its own hold');
  assert.deepEqual(merge(7)?.missing, {
    fact: 'unreadable labels on card 7',
    next: 'Check the card\'s labels on the board, then refresh the queue.',
  });
});

test('every queue item carries a version bound to what the panel shows, the account and the local proof', () => {
  const baseline = versionsOf(actModel());
  assert.deepEqual([...baseline.keys()], [7, 8, 9, 21, 22, 23, 54, 55]);
  for (const [number, version] of baseline) assert.match(String(version), /^[0-9a-f]{64}$/, `card ${number}'s version`);
  assert.deepEqual(versionsOf(actModel()), baseline, 'the same inputs give the same versions');
  const rows = [
    ['the title', (model) => { model.cards[23].title = 'A local job\'s renamed question'; }, [23]],
    ['the held comment past its first line', (model) => { model.cards[21].comments[2].body = 'Needs owner: Which colour? Job: job/21 on machine-a.\nRed or green.'; }, [21]],
    ['the decision card', (model) => { model.files[join(reviewFolder(8, H8), 'body.md')] = writeUp('Card 8 reads twice.', 'No visual change.'); }, [8]],
    ['the screenshots', (model) => {
      model.files[join(reviewFolder(7, H7), 'screenshot-2.png')] = '';
      model.cards[7].body = `Scope of card 7.\n${waitingLine(7, H7, ['body.md', 'screenshot-1.png', 'screenshot-2.png'])}`;
    }, [7]],
    ['the missing fact', (model) => { model.dirty.push(9); }, [9]],
    ['the scope', (model) => { model.cards[54].body = SCOPED.replace('- [ ] Keep files it.', '- [ ] Keep files it at once.'); }, [54]],
    ['the status', (model) => { model.cards[22].status = 'Ready'; }, [22]],
    ['the body', (model) => { model.cards[55].body = '## Why\n\nThe panel needs it now.'; }, [55]],
    ['the worktree head', (model) => { model.heads[9] = H9B; }, [9]],
    ['the saved identity', (model) => { model.files[join(reviewFolder(9, H9), 'screenshot-2.png')] = ''; }, [9]],
  ];
  const changed = (versions) => [...baseline].filter(([number, version]) => versions.get(number) !== version).map(([number]) => number);
  const observed = rows.map(([row, change]) => {
    const model = actModel();
    change(model);
    return { row, changed: changed(versionsOf(model)) };
  });
  observed.push({ row: 'the account', changed: changed(versionsOf(actModel(), { login: 'someone' })) });
  assert.deepEqual(observed, [...rows.map(([row, , cards]) => ({ row, changed: cards })), { row: 'the account', changed: [...baseline.keys()] }]);

  const items = shown(collectModel(actModel()).document.items);
  const scoped = items.find((item) => item.card === 54);
  assert.equal(typeof scoped.scope, 'string', 'a suggestion with both sections carries its scope');
  for (const line of ['## What to build', 'A Keep control.', '## Acceptance criteria', '- [ ] Keep files it.']) assert.ok(scoped.scope.includes(line), `its scope holds ${line}`);
  assert.equal(scoped.scope.includes('The panel needs it.'), false, 'its scope holds only those two sections');
  assert.equal(Object.hasOwn(items.find((item) => item.card === 55), 'scope'), false, 'a suggestion lacking a section has no scope');
});

test('ANTI-REGRESSION: a question names the computer its hold\'s Job sentence names, and names none where that sentence cannot be read', () => {
  // Card 22's one comment is its hold; the reader runs on machine-a.
  const questionOf = (body) => {
    const model = actModel();
    model.cards[22].comments[0].body = body;
    return collectModel(model).document.items.find((item) => item.card === 22);
  };
  for (const [why, body, machine] of [
    ['another computer', 'Needs owner: Which tracker? Job: job/22 on machine-b.', 'machine-b'],
    ['this computer', 'Needs owner: Which tracker? Job: job/22 on machine-a.', 'machine-a'],
    ['a dotted name', 'Needs owner: Which tracker? Job: job/22 on build-01.example.com.', 'build-01.example.com'],
    ['the sentence that ends the line, past one the question quotes', 'Needs owner: Is "Job: job/22 on machine-c." right? Job: job/22 on machine-b.', 'machine-b'],
    ['the first line alone', 'Needs owner: Which tracker? Job: job/22 on machine-b.\nMore words. Job: job/22 on machine-c.', 'machine-b'],
    ['spaces after the sentence', 'Needs owner: Which tracker? Job: job/22 on machine-b.  \nMore words.', 'machine-b'],
  ]) assert.equal(questionOf(body).heldOn, machine, `${why}: the question names ${machine}`);
  for (const [why, body] of [
    ['no Job sentence', 'Needs owner: Which tracker should this use?'],
    ['another card\'s Job sentence', 'Needs owner: Which tracker? Job: job/24 on machine-b.'],
    ['a Job sentence the line does not end with', 'Needs owner: Which tracker? Job: job/22 on machine-b. Thanks'],
    ['a Job sentence on a later line', 'Needs owner: Which tracker?\nJob: job/22 on machine-b.'],
    ['a name with a space', 'Needs owner: Which tracker? Job: job/22 on machine b.'],
    ['a name with markup', 'Needs owner: Which tracker? Job: job/22 on <b>machine-b</b>.'],
    ['a name ending in a dot', 'Needs owner: Which tracker? Job: job/22 on machine-b..'],
    ['an empty name', 'Needs owner: Which tracker? Job: job/22 on .'],
    ['a name of 254 characters', `Needs owner: Which tracker? Job: job/22 on ${'m'.repeat(254)}.`],
  ]) {
    const item = questionOf(body);
    assert.equal(item.category, 'question', `${why}: the card is still a question`);
    assert.equal(Object.hasOwn(item, 'heldOn'), false, `${why}: the question names no computer, got ${item.heldOn}`);
  }
});

test('ANTI-REGRESSION: a waiting merge says who acts on an answer and shows the answer its card records, and one whose comments cannot be read names the failed read and guesses neither', () => {
  const answerLine = (head, names, words) => `Owner answer: job/7 at ${head} ${ids(7, head, names)}: ${words}`;
  const answer = answerLine(H7, ['body.md', 'screenshot-1.png'], 'yes');
  const modelWith = ({ body = answer, login = 'owner' } = {}) => {
    const model = actModel();
    model.cards[7].comments.push(comment(7, 3100, body, login));
    return model;
  };
  const itemOf = (document, card) => document.items.find((item) => item.card === card);
  // The editor-aware card read of card 7, by which the queue reads its answer.
  const cardRead = (args) => args.some((arg) => arg.startsWith('query=') && arg.includes('comments(first: 100)')) && args.includes('number=7');

  // The failed read: the one comment read for card 7 throws, and the queue lists it and guesses nothing.
  const failing = modelWith();
  const { exec } = actExec(failing);
  const unreadable = (args) => {
    if (cardRead(args)) throw new Error('gh: comments unreadable');
    return exec(args);
  };
  const failed = collect({ ...modelReaders(failing), hostname: HOST, tracker: 'github', executor: unreadable, login: 'owner' });
  const unread = itemOf(failed, 7);
  assert.deepEqual(
    { source: failed.sources.find((source) => source.name === 'card 7 comments'), actedOnBy: unread.actedOnBy, answered: Object.hasOwn(unread, 'answered') },
    { source: { name: 'card 7 comments', ok: false, error: 'gh: comments unreadable' }, actedOnBy: 'unread', answered: false },
    'a failed comment read lists its source and guesses neither who acts nor an answer',
  );

  // A reply whose list holds an element that is no comment record is as unreadable as a failed read, and reads no further.
  const malformed = (args) => {
    if (!cardRead(args)) return exec(args);
    const reply = JSON.parse(exec(args));
    reply.data.repository.issue.comments.nodes.push(null);
    return JSON.stringify(reply);
  };
  const broken = collect({ ...modelReaders(failing), hostname: HOST, tracker: 'github', executor: malformed, login: 'owner' });
  const lost = itemOf(broken, 7);
  assert.deepEqual(
    { source: broken.sources.find((source) => source.name === 'card 7 comments')?.ok, actedOnBy: lost.actedOnBy, answered: Object.hasOwn(lost, 'answered') },
    { source: false, actedOnBy: 'unread', answered: false },
    'a comment list holding a malformed record lists its source as failed and guesses neither who acts nor an answer',
  );
  assert.deepEqual(broken.items.map((item) => item.card), failed.items.map((item) => item.card), 'every other card is still returned');

  // Each row: card 7 read from the model, and what it says of who acts and of the answer it records.
  const quoted = `Quote: ${answer}`;
  const superseded = modelWith();
  superseded.cards[7].comments.push(comment(7, 3101, `Owner answer: job/7 at ${H7} ${ids(7, H7, ['body.md', 'screenshot-1.png'])}:\nhold it`));
  const foreignEdited = modelWith();
  foreignEdited.cards[7].comments.at(-1).editor = { login: 'someone' };
  const rows = [
    ['an answer for the displayed version', modelWith(), { actedOnBy: 'coordinator', answered: 'yes' }],
    ['an answer by another account', modelWith({ login: 'someone' }), { actedOnBy: 'coordinator' }],
    ['an answer for another head', modelWith({ body: answerLine(H8, ['body.md', 'screenshot-1.png'], 'yes') }), { actedOnBy: 'coordinator' }],
    ['an answer with another identity', modelWith({ body: answerLine(H7, ['body.md'], 'yes') }), { actedOnBy: 'coordinator' }],
    ['an answer quoted after other text', modelWith({ body: quoted }), { actedOnBy: 'coordinator' }],
    ['an answer, then a newer one with its words on the second line', superseded, { actedOnBy: 'coordinator' }],
    ['an answer another account last edited', foreignEdited, { actedOnBy: 'coordinator' }],
  ];
  const observed = rows.map(([row, model]) => {
    const item = itemOf(collectModel(model).document, 7);
    return { row, actedOnBy: item.actedOnBy, ...Object.hasOwn(item, 'answered') && { answered: item.answered } };
  });
  assert.deepEqual(observed, rows.map(([row, , expected]) => ({ row, ...expected })));

  // A card with no answer makes no read for merge routing.
  const quiet = collectModel(actModel());
  assert.deepEqual(
    { actedOnBy: itemOf(quiet.document, 8).actedOnBy, reads: quiet.calls.filter((args) => args[0] === 'issue' && args[2] === '8') },
    { actedOnBy: 'coordinator', reads: [] },
  );
});

test('ANTI-REGRESSION: a board card carries answered only where its waiting version\'s newest owner answer names that version, never where the answer is unread', () => {
  const answerLine = (head, names, words) => `Owner answer: job/7 at ${head} ${ids(7, head, names)}: ${words}`;
  const modelWith = ({ body = answerLine(H7, ['body.md', 'screenshot-1.png'], 'yes'), login = 'owner' } = {}) => {
    const model = actModel();
    if (body !== null) model.cards[7].comments.push(comment(7, 3100, body, login));
    return model;
  };
  const boardCard7 = (document) => document.board.cards.find((entry) => entry.card === 7);
  const cardRead = (args) => args.some((arg) => arg.startsWith('query=') && arg.includes('comments(first: 100)')) && args.includes('number=7');

  // The card 7 comment read throws, as the failed read of the merge-route test does.
  const failing = modelWith();
  const { exec } = actExec(failing);
  const unreadable = (args) => {
    if (cardRead(args)) throw new Error('gh: comments unreadable');
    return exec(args);
  };
  const unread = collect({ ...modelReaders(failing), hostname: HOST, tracker: 'github', executor: unreadable, login: 'owner' });

  const rows = [
    ['an answer for the shown head and identity by the owner', boardCard7(collectModel(modelWith()).document)],
    ['no answer', boardCard7(collectModel(modelWith({ body: null })).document)],
    ['an answer for another head', boardCard7(collectModel(modelWith({ body: answerLine(H8, ['body.md', 'screenshot-1.png'], 'yes') })).document)],
    ['an answer with another identity', boardCard7(collectModel(modelWith({ body: answerLine(H7, ['body.md'], 'yes') })).document)],
    ['an answer by another account', boardCard7(collectModel(modelWith({ login: 'someone' })).document)],
    ['a comment read that fails', boardCard7(unread)],
  ];
  assert.deepEqual(
    rows.map(([row, card]) => ({ row, waitsOn: card.waitsOn, answered: Object.hasOwn(card, 'answered') ? card.answered : 'absent' })),
    [
      { row: 'an answer for the shown head and identity by the owner', waitsOn: 'merge', answered: true },
      { row: 'no answer', waitsOn: 'merge', answered: 'absent' },
      { row: 'an answer for another head', waitsOn: 'merge', answered: 'absent' },
      { row: 'an answer with another identity', waitsOn: 'merge', answered: 'absent' },
      { row: 'an answer by another account', waitsOn: 'merge', answered: 'absent' },
      { row: 'a comment read that fails', waitsOn: 'merge', answered: 'absent' },
    ],
  );
});

test('ANTI-REGRESSION: a card being rebuilt after the owner answered its recorded waiting version stays answered, and only that version counts', () => {
  const names = ['body.md', 'screenshot-1.png'];
  const answerLine = (head, words) => `Owner answer: job/7 at ${head} ${ids(7, head, names)}: ${words}`;
  // Card 7's worktree is being rebuilt: dirty at its head, or moved to a head with no saved write-up. Its body still
  // records the waiting version of H7 unless `body` says otherwise.
  const rebuilding = ({ reply = answerLine(H7, 'fix it'), login = 'owner', dirty = true, moved = false, body } = {}) => {
    const model = actModel();
    if (dirty) model.dirty.push(7);
    if (moved) model.heads[7] = H8;
    if (body !== undefined) model.cards[7].body = body;
    model.cards[7].comments.push(comment(7, 3100, reply, login));
    return model;
  };
  const boardCard7 = (document) => document.board.cards.find((entry) => entry.card === 7);
  const cardRead = (args) => args.some((arg) => arg.startsWith('query=') && arg.includes('comments(first: 100)')) && args.includes('number=7');
  const observe = (row, document) => {
    const card = boardCard7(document);
    return { row, waitsOn: card.waitsOn, answered: Object.hasOwn(card, 'answered') ? card.answered : 'absent' };
  };

  // The card 7 comment read throws, as the failed read of the merge-route test does.
  const failing = rebuilding();
  const { exec } = actExec(failing);
  const unreadable = (args) => {
    if (cardRead(args)) throw new Error('gh: comments unreadable');
    return exec(args);
  };
  const unread = collect({ ...modelReaders(failing), hostname: HOST, tracker: 'github', executor: unreadable, login: 'owner' });

  const dirtyAnswered = collectModel(rebuilding()).document;
  assert.deepEqual(
    [
      observe('a dirty worktree, its recorded waiting version answered by the owner', dirtyAnswered),
      observe('a moved head with no saved write-up, the recorded waiting version answered by the owner', collectModel(rebuilding({ dirty: false, moved: true })).document),
      observe('a dirty worktree, an answer for another head', collectModel(rebuilding({ reply: answerLine(H8, 'fix it') })).document),
      observe('a dirty worktree, an answer by another account', collectModel(rebuilding({ login: 'someone' })).document),
      observe('a dirty worktree, a card body with no waiting version', collectModel(rebuilding({ body: 'Scope of card 7.' })).document),
      observe('a dirty worktree, a comment read that fails', unread),
    ],
    [
      { row: 'a dirty worktree, its recorded waiting version answered by the owner', waitsOn: 'merge', answered: true },
      { row: 'a moved head with no saved write-up, the recorded waiting version answered by the owner', waitsOn: 'merge', answered: true },
      { row: 'a dirty worktree, an answer for another head', waitsOn: 'merge', answered: 'absent' },
      { row: 'a dirty worktree, an answer by another account', waitsOn: 'merge', answered: 'absent' },
      { row: 'a dirty worktree, a card body with no waiting version', waitsOn: 'merge', answered: 'absent' },
      { row: 'a dirty worktree, a comment read that fails', waitsOn: 'merge', answered: 'absent' },
    ],
  );
  // The Decisions view and the panel's list are unchanged: the card is still a merge item with its missing fact.
  assert.equal(dirtyAnswered.items.find((item) => item.card === 7).missing.fact, 'its job worktree has uncommitted changes');
});

const TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;
const UNREAD_LOGIN = 'the gh login cannot be read';
const CREDENTIAL_REPLY = 'it looks like it holds a credential: answer in chat and describe it instead';

test('ANTI-REGRESSION: a panel answer on a changed, foreign or impersonated item writes nothing', async () => {
  const answer = { card: 7, action: 'answer', reply: 'Shorter.' };
  // Each row: the request (`item` names the card whose version it carries, where that is not its own), a change made
  // before the panel draws the item, a change made after, the line it must refuse with where that line is fixed, and
  // the tracker.
  const rows = [
    ['a new comment', answer, null, (model) => { model.cards[7].comments.push(comment(7, 3024, 'A later note.')); }],
    ['a status move', { card: 54, action: 'keep' }, null, (model) => { model.cards[54].status = 'Ready'; }],
    ['a body edit', { card: 7, action: 'park' }, null, (model) => { model.cards[7].body = model.cards[7].body.replace('Scope of card 7.', 'Scope of card 7, revised.'); }],
    ['an account switch', { card: 7, action: 'park' }, null, (model) => { model.login = 'someone'; }],
    ['a failed login read', { card: 7, action: 'park' }, null, (model) => { model.login = () => { throw new Error('gh: HTTP 401: Bad credentials'); }; }, UNREAD_LOGIN],
    ['a login read that is not one login', { card: 7, action: 'park' }, null, (model) => { model.login = () => 'owner\nsomeone\n'; }, UNREAD_LOGIN],
    ['a changed worktree head', { card: 7, action: 'park' }, null, (model) => { model.heads[7] = 'c'.repeat(40); }],
    ['a changed category', { card: 55, action: 'drop' }, null, (model) => { model.cards[55].comments.push(comment(55, 3551, 'Needs owner: Keep it?')); }],
    ['keep without a scope', { card: 55, action: 'keep' }],
    ['park on a question', { card: 21, action: 'park' }],
    ['answer on an unanswerable question', { card: 22, action: 'answer', reply: 'Blue.' }, null, null, 'does not answer card 22'],
    ['yes', { card: 7, action: 'yes' }, null, null, 'is not a queue panel action'],
    ['fix', { card: 7, action: 'fix', reply: 'Shorter.' }],
    ['a reply holding a token', { ...answer, reply: `Use ${TOKEN} for it.` }, null, null, CREDENTIAL_REPLY],
    ['an empty reply', { ...answer, reply: '' }],
    ['a reply of 501 characters', { ...answer, reply: 'x'.repeat(501) }],
    ['a non-GitHub tracker', answer, null, null, null, 'markdown'],
    ...[0, -21, 21.5, '21'].map((number) => [`card ${JSON.stringify(number)}`, { ...answer, card: number, item: 21 }]),
  ];
  // A refusal is one line naming no fixture failure and no credential; a fixed line is matched within it.
  const refusal = (message, fixed) => {
    if (typeof message !== 'string' || message === '' || /[\r\n]/.test(message) || /^unexpected (?:gh|git) /.test(message) || message.includes(TOKEN)) return message;
    if (!fixed) return 'one line';
    return message.includes(fixed) ? fixed : message;
  };
  // The positive control: the unchanged merge uses the ordinary tracker answer route.
  const control = actModel();
  const controlled = await acting(control, { ...answer, version: versionsOf(control).get(answer.card) });
  const observed = [{ row: 'the current answer', writes: controlled.writes.length, refused: controlled.refused }];
  for (const [row, { item, ...request }, before, after, fixed, tracker] of rows) {
    const model = actModel();
    before?.(model);
    const version = versionsOf(model).get(item ?? request.card);
    after?.(model);
    const { writes, refused } = await acting(model, { ...request, version }, { tracker });
    observed.push({ row, writes: writes.length, refused: refusal(refused, fixed) });
  }
  assert.deepEqual(observed, [
    { row: 'the current answer', writes: 1, refused: undefined },
    ...rows.map(([row, , , , fixed]) => ({ row, writes: 0, refused: fixed ?? 'one line' })),
  ]);
});

test('each panel action writes exactly its existing route', async () => {
  const parked = (number, body) => [
    { args: ['api', '-X', 'PATCH', `repos/${BOARD_OWNER}/${BOARD_REPOSITORY}/issues/${number}`, '-f', 'body=<text>'], text: `${body}\nParked: from the queue panel` },
    { args: ['issue', 'comment', String(number), '--repo', BOARD_SLUG, '--body-file', '<file>'],
      text: `Needs owner: Parked from the queue panel: what should change? Job: job/${number} on ${HOST}.` },
    { args: ['project', 'item-edit', '--id', `PVTI_${number}`, '--project-id', 'PVT_act', '--field-id', 'PVTSSF_status', '--single-select-option-id', 'opt-backlog'] },
  ];
  const rows = [
    ['park a complete merge', { card: 7, action: 'park' }, parked(7, 'Scope of card 7.')],
    ['park a missing merge', { card: 9, action: 'park' }, parked(9, 'Scope of card 9.')],
    ['keep a scoped suggestion', { card: 54, action: 'keep' }, [{ args: ['issue', 'edit', '54', '--repo', BOARD_SLUG, '--title', 'A scoped suggestion'] }]],
    ['drop a suggestion', { card: 55, action: 'drop' }, [
      { args: ['issue', 'close', '55', '--repo', BOARD_SLUG, '--reason', 'not planned'] },
      { args: ['project', 'item-edit', '--id', 'PVTI_55', '--project-id', 'PVT_act', '--field-id', 'PVTSSF_status', '--single-select-option-id', 'opt-done'] },
    ]],
  ];
  assert.deepEqual(shown(collectModel(actModel()).document.items).find((item) => item.card === 9), {
    card: 9, title: 'A merge whose card names another version', category: 'merge', missing: NO_WAITING_VERSION,
  });
  const observed = [];
  const placeholders = [];
  for (const [row, request] of rows) {
    const model = actModel();
    const { calls, writes, bodyFiles, refused } = await acting(model, { ...request, version: versionsOf(model).get(request.card) });
    observed.push({ row, writes, refused, left: bodyFiles.filter((path) => existsSync(path)) });
    placeholders.push(...calls.filter((args) => args.some((arg) => /\{owner\}|\{repo\}/.test(arg))));
  }
  assert.deepEqual(observed, rows.map(([row, , writes]) => ({ row, writes, refused: undefined, left: [] })));
  assert.deepEqual(placeholders, [], 'no call leaves the repository to gh\'s placeholders');
});

test('ANTI-REGRESSION: a queue panel answer to a waiting merge records the owner answer for that card at its shown head and identity, and nothing else', async () => {
  const recorded = (number, head, names, words) => [{ args: ['issue', 'comment', String(number), '--repo', BOARD_SLUG, '--body-file', '<file>'],
    text: `Owner answer: job/${number} at ${head} ${ids(number, head, names)}: ${words}` }];
  const reply = 'shorten the title, then merge it';
  // Each row: the request, the tracker, the writes it makes, and the line it refuses with: `fixed` where that line is
  // fixed, otherwise any one line naming no fixture failure.
  const rows = [
    ['a complete merge with a screenshot', { card: 7, action: 'answer', reply }, 'github', recorded(7, H7, ['body.md', 'screenshot-1.png'], reply)],
    ['a complete merge with no visual change', { card: 8, action: 'answer', reply: 'yes' }, 'github', recorded(8, H8, ['body.md'], 'yes')],
    ['a missing merge', { card: 9, action: 'answer', reply }, 'github', [], 'one line'],
    ['a reply holding a token', { card: 7, action: 'answer', reply: `Merge it with ${TOKEN}.` }, 'github', [], CREDENTIAL_REPLY],
    ['a non-GitHub tracker', { card: 7, action: 'answer', reply }, 'linear', [], 'one line'],
  ];
  const refusal = (message, fixed) => {
    if (typeof message !== 'string' || message === '' || /[\r\n]/.test(message) || /^unexpected (?:gh|git) /.test(message) || message.includes(TOKEN)) return message;
    return fixed === 'one line' || message === fixed ? fixed : message;
  };
  const observed = [];
  for (const [row, request, tracker, , fixed] of rows) {
    const model = actModel();
    const { writes, refused } = await acting(model, { ...request, version: versionsOf(model).get(request.card) }, { tracker });
    observed.push({ row, writes, refused: refusal(refused, fixed) });
  }
  assert.deepEqual(observed, rows.map(([row, , , writes, fixed]) => ({ row, writes, refused: fixed })));
});

test('ANTI-REGRESSION: Undo takes back park, keep and drop while the card is as the action left it, and names what moved', async () => {
  const moved = (args) => ({ args });
  const statusTo = (number, option) => moved(['project', 'item-edit', '--id', `PVTI_${number}`, '--project-id', 'PVT_act', '--field-id', 'PVTSSF_status', '--single-select-option-id', option]);
  const bodyTo = (text) => ({ args: ['api', '-X', 'PATCH', `repos/${BOARD_SLUG}/issues/7`, '-f', 'body=<text>'], text });
  const holdRemoved = (id) => moved(['api', '-X', 'DELETE', `repos/${BOARD_SLUG}/issues/comments/${id}`]);
  const titleTo = (title) => moved(['issue', 'edit', '54', '--repo', BOARD_SLUG, '--title', title]);
  const reopened = moved(['issue', 'reopen', '55', '--repo', BOARD_SLUG]);
  const set = (number, fields) => (model) => { Object.assign(model.cards[number], fields); };
  // A hook that edits the card once, on the action's first write of the `issue` verb the row names.
  const during = (verb, change) => (model) => {
    model.duringAct = (args) => {
      if (args[0] !== 'issue' || args[1] !== verb) return;
      delete model.duringAct;
      change(model);
    };
  };
  // Ninety-nine comments before card 7's claim, so park's hold is its 101st and Undo reads it on a second page.
  const pastOnePage = (model) => { model.cards[7].comments.unshift(...Array.from({ length: 99 }, (_, at) => comment(7, 2000 + at, `Earlier comment ${at + 1}.`))); };
  const PARKED_BODY = 'Scope of card 7.\nParked: from the queue panel';
  // Each row: the card and action, a change made before the action, an edit made after it, and either the writes Undo
  // makes or the line it refuses with.
  const controls = [
    ['C1 park', 7, 'park', null, null, [statusTo(7, 'opt-awaiting-push'), bodyTo(`Scope of card 7.\n${waitingLine(7, H7, ['body.md', 'screenshot-1.png'])}`), holdRemoved(5001)]],
    ['C2 park a body with no state line', 7, 'park', set(7, { body: 'Scope of card 7.' }), null, [statusTo(7, 'opt-awaiting-push'), bodyTo('Scope of card 7.'), holdRemoved(5001)]],
    ['C3 park a body already parked', 7, 'park', set(7, { body: PARKED_BODY }), null, [statusTo(7, 'opt-awaiting-push'), holdRemoved(5000)]],
    ['C4 keep', 54, 'keep', null, null, [titleTo('Proposed: A scoped suggestion')]],
    ['C5 keep a doubled prefix', 54, 'keep', set(54, { title: 'Proposed: Proposed: A scoped suggestion' }), null, [titleTo('Proposed: Proposed: A scoped suggestion')]],
    ['C6 drop from Ready', 55, 'drop', set(55, { status: 'Ready' }), null, [reopened, statusTo(55, 'opt-ready')]],
    ['C7 drop from no Status', 55, 'drop', set(55, { status: null }), null,
      [reopened, moved(['project', 'item-edit', '--id', 'PVTI_55', '--project-id', 'PVT_act', '--field-id', 'PVTSSF_status', '--clear'])]],
    ['C8 park a card whose comments run past one page', 7, 'park', pastOnePage, null,
      [statusTo(7, 'opt-awaiting-push'), bodyTo(`Scope of card 7.\n${waitingLine(7, H7, ['body.md', 'screenshot-1.png'])}`), holdRemoved(5001)]],
  ];
  const commentMoved = 'a comment was added, edited or removed';
  const movedRows = [
    ['M1 park, then Ready', 7, 'park', null, set(7, { status: 'Ready' }), 'card 7 moved since it was put aside: it is now in Ready'],
    ['M2 park, then off the board', 7, 'park', null, set(7, { offBoard: true }), 'card 7 moved since it was put aside: it is no longer on the board'],
    ['M3 keep, then In progress', 54, 'keep', null, set(54, { status: 'In progress' }), 'card 54 moved since it was accepted: it is now in In progress'],
    ['M4 drop, then Backlog', 55, 'drop', null, set(55, { status: 'Backlog' }), 'card 55 moved since it was rejected: it is now in Backlog'],
    ['M5 drop, then reopened', 55, 'drop', null, set(55, { closed: false }), 'card 55 moved since it was rejected: it was reopened'],
    ['M6 keep, the title edited during the action', 54, 'keep', during('edit', set(54, { title: 'A scoped suggestion, renamed' })), null,
      'card 54 moved since it was accepted: its title was edited'],
    ['M7 park, then a comment', 7, 'park', null, (model) => { model.cards[7].comments.push(comment(7, 5100, 'Still there?')); },
      `card 7 moved since it was put aside: ${commentMoved}`],
    ['M8 park, a comment posted during the action', 7, 'park', during('comment', (model) => { model.cards[7].comments.push(comment(7, 5100, 'Me too.', 'someone')); }), null,
      `card 7 moved since it was put aside: ${commentMoved}`],
    ['M9 keep, then the body edited', 54, 'keep', null, set(54, { body: `${SCOPED}Edited after the answer.` }), 'card 54 moved since it was accepted: its text was edited'],
    ['M10 park, then the replaced revision edited', 7, 'park', null, (model) => { model.cards[7].history[1] = 'Something else.'; },
      'card 7 moved since it was put aside: its text was edited'],
    ['M11 drop from Ready, then Ready removed from the board', 55, 'drop', set(55, { status: 'Ready' }), (model) => { model.removedColumn = 'Ready'; },
      `unknown Status "Ready" — valid options: ${STATUS_OPTIONS.filter((name) => name !== 'Ready').join(', ')}`],
    ['M12 park, then the hold reposted word for word by another account', 7, 'park', null,
      (model) => { const [hold] = model.cards[7].comments.splice(-1); model.cards[7].comments.push(comment(7, 5101, hold.body, 'someone')); },
      `card 7 moved since it was put aside: ${commentMoved}`],
    ['M13 park, then the hold edited', 7, 'park', null, (model) => { model.cards[7].comments.at(-1).lastEditedAt = '2026-11-09T10:00:00Z'; },
      `card 7 moved since it was put aside: ${commentMoved}`],
    ['M14 park past one page, then an unreadable hold address', 7, 'park', pastOnePage, (model) => { model.cards[7].comments.at(-1).url = null; },
      `unreadable card read for card 7 in ${BOARD_SLUG}`],
    ['M15 park past one page, then a later page answered for another repository', 7, 'park', pastOnePage, (model) => { model.foreignLaterPage = true; },
      `the card read answered for repository "R_other", not origin's ${BOARD_SLUG}`],
  ];
  const cardState = ({ status, closed, title, body, comments }) => structuredClone({ status, closed, title, body, comments });
  const observed = [];
  const expected = [];
  for (const [row, number, action, before, after, outcome] of [...controls, ...movedRows]) {
    const model = actModel();
    model.cards[number].closed = false;
    before?.(model);
    const snapshot = cardState(model.cards[number]);
    const acted = await acting(model, { card: number, action, version: versionsOf(model).get(number) });
    after?.(model);
    const { writes, refused } = await undoing(model, { card: number, action, record: recordOf(acted.logged) });
    if (Array.isArray(outcome)) {
      observed.push({ row, acted: acted.refused, refused, writes, card: cardState(model.cards[number]) });
      expected.push({ row, acted: undefined, refused: undefined, writes: outcome, card: snapshot });
    } else {
      observed.push({ row, acted: acted.refused, refused, writes });
      expected.push({ row, acted: undefined, refused: outcome, writes: [] });
    }
  }
  assert.deepEqual(observed, expected);
});

// What the entry prints for any argument shape it refuses.
const READER_USAGE = 'usage: node scripts/owner-queue.mjs [act --card=<n> --action=<park|answer|keep|drop|pick> --version=<v> [--reply=<text>] [--proposal=<k>] | undo --card=<n> --action=<park|keep|drop> --record=<json> | move --card=<n> --move=<ready|backlog|up|place> --version=<v> [--to=<k>] | show-first --card=<n> --state=<on|off>]';

test('ANTI-REGRESSION: Undo refuses a record the panel did not write and any other request shape, before any read', async () => {
  const hex = (digit) => digit.repeat(64);
  const park = { column: 'Awaiting push', open: true, title: 'A built merge', body: hex('a'), comments: hex('b') };
  const keep = { column: 'Backlog', open: true, title: 'Proposed: A scoped suggestion', body: hex('c'), comments: hex('d') };
  const drop = { column: 'Backlog', open: true, title: 'Proposed: An unscoped suggestion', body: hex('e'), comments: hex('f') };
  const noComments = { ...park };
  delete noComments.comments;
  const notWritten = 'the undo record is not one the queue panel wrote';
  // Each row: the request, the tracker, a change to the model, and the line Undo refuses with.
  const rows = [
    ['record {', { card: 7, action: 'park', record: '{' }, 'github', null, notWritten],
    ['record []', { card: 7, action: 'park', record: '[]' }, 'github', null, notWritten],
    ['record null', { card: 7, action: 'park', record: 'null' }, 'github', null, notWritten],
    ['a record missing comments', { card: 7, action: 'park', record: JSON.stringify(noComments) }, 'github', null, notWritten],
    ['a record with an extra from', { card: 7, action: 'park', record: JSON.stringify({ ...park, from: 'elsewhere' }) }, 'github', null, notWritten],
    ['open yes', { card: 7, action: 'park', record: JSON.stringify({ ...park, open: 'yes' }) }, 'github', null, notWritten],
    ['a park record in Backlog', { card: 7, action: 'park', record: JSON.stringify({ ...park, column: 'Backlog' }) }, 'github', null, notWritten],
    ['a keep record without Proposed', { card: 54, action: 'keep', record: JSON.stringify({ ...keep, title: 'A scoped suggestion' }) }, 'github', null, notWritten],
    ['a drop record in Done', { card: 55, action: 'drop', record: JSON.stringify({ ...drop, column: 'Done' }) }, 'github', null, notWritten],
    ['a drop record without Proposed', { card: 55, action: 'drop', record: JSON.stringify({ ...drop, title: 'An unscoped suggestion' }) }, 'github', null, notWritten],
    ['a body of 64 X', { card: 7, action: 'park', record: JSON.stringify({ ...park, body: 'X'.repeat(64) }) }, 'github', null, notWritten],
    ['action answer', { card: 7, action: 'answer', record: JSON.stringify(park) }, 'github', null, '"answer" has no Undo: correct it in chat'],
    ['tracker linear', { card: 7, action: 'park', record: JSON.stringify(park) }, 'linear', null, 'the queue panel writes only to a GitHub board: answer in chat'],
    ['card 0', { card: 0, action: 'park', record: JSON.stringify(park) }, 'github', null, '0 is not a card number'],
    ['card "7"', { card: '7', action: 'park', record: JSON.stringify(park) }, 'github', null, '"7" is not a card number'],
  ];
  // The login row's line is the one `act` refuses an unreadable login with.
  const unread = actModel();
  unread.login = null;
  const actRefusal = (await acting(unread, { card: 7, action: 'park', version: hex('c') })).refused;
  assert.match(String(actRefusal), new RegExp(`^${UNREAD_LOGIN}`));
  rows.push(['login unreadable', { card: 7, action: 'park', record: JSON.stringify(park) }, 'github', (model) => { model.login = null; }, actRefusal]);
  const observed = [];
  for (const [row, request, tracker, change] of rows) {
    const model = actModel();
    change?.(model);
    const { calls, refused } = await undoing(model, request, { tracker });
    observed.push({ row, calls: calls.length, refused });
  }
  assert.deepEqual(observed, rows.map(([row, , , , refused]) => ({ row, calls: 0, refused })));

  // The entry refuses any other argument shape with its usage, before any read.
  const shapes = [
    ['undo'],
    ['undo', '--card=7', '--action=park'],
    ['undo', '--card=7', '--action=answer', '--record={}'],
    ['undo', '--card=0', '--action=park', '--record={}'],
    ['undo', '--card=7', '--action=park', '--record={}', `--version=${'c'.repeat(64)}`],
  ];
  const entered = shapes.map((args) => {
    const logged = [];
    const errors = [];
    const code = readerMain(args, { log: (line) => logged.push(line), error: (line) => errors.push(line) });
    return { args, code, errors, logged };
  });
  assert.deepEqual(entered, shapes.map((args) => ({ args, code: 2, errors: [READER_USAGE], logged: [] })));
});

// A board for the move tests, listed in `order`: card 31 in Backlog; Ready holding 32, the suggestion 33, 34 and 35, so
// the build order ranks 32, 34 and 35; then 36 in progress, 37 with no column and the suggestion 38 in Backlog.
function moveModel() {
  const entry = (title, status) => ({ title, status, body: `Scope: ${title}.`, comments: [] });
  return {
    login: 'owner',
    heads: {},
    dirty: [],
    files: {},
    order: [31, 32, 33, 34, 35, 36, 37, 38],
    cards: {
      31: entry('A backlog card', 'Backlog'),
      32: entry('The first card to build', 'Ready'),
      33: entry('Proposed: A suggestion in Ready', 'Ready'),
      34: entry('The second card to build', 'Ready'),
      35: entry('The third card to build', 'Ready'),
      36: entry('A card in progress', 'In progress'),
      37: entry('A card with no column', null),
      38: entry('Proposed: A suggestion in Backlog', 'Backlog'),
    },
  };
}

// The move board read back with a card GitHub's listing left out: card 40, in Ready, which the issue walk finds.
function omittedModel() {
  const model = moveModel();
  model.cards[40] = { title: 'An omitted card', status: 'Ready', body: 'Scope: An omitted card.', comments: [] };
  model.issues = [issuesPage([...model.order, 40].map((number) => walkedIssue(number, [membership(`PVTI_${number}`)])))];
  model.items = [hydratedItem({ id: 'PVTI_40', content: { __typename: 'Issue', number: 40, title: 'An omitted card' }, status: 'Ready', routing: 'Platform' })];
  return model;
}

// Card `number` as the model's board read draws it, or undefined where the read has no board or no such card.
const boardCard = (model, number) => collectModel(model).document.board?.cards.find((entry) => entry.card === number);

// The cards of the model's Ready column, read back in board order.
const readyCards = (model) => collectModel(model).document.board.cards.filter((entry) => entry.column === 'Ready').map((entry) => entry.card);

// The writes a move makes, as `actExec` records them: card `number`'s Status set to `column`, and its position write
// after card `after`'s item, or first where `after` is null.
const statusWrite = (number, column) => ({ args: ['project', 'item-edit', '--id', `PVTI_${number}`, '--project-id', 'PVT_act', '--field-id', 'PVTSSF_status', '--single-select-option-id', optionId(column)] });
const positionWrite = (number, after) => ({ position: { item: `PVTI_${number}`, after: after === null ? null : `PVTI_${after}` } });

// `moveOnBoard` over the model as `acting` runs `act`, with the version the model's board read drew for the card unless
// the request names one, and `change` made to the model after that read: its writes, the lines it logged, and the line
// it refused with where it refused. A TypeError is a defect of the code under test, never a refusal, so it fails the
// test as itself.
async function moving(model, request, { tracker = 'github', change } = {}) {
  const version = 'version' in request ? request.version : boardCard(model, request.card)?.version;
  change?.(model);
  const { exec, writes } = actExec(model);
  const logged = [];
  try {
    await moveOnBoard({ ...modelReaders(model), tracker, executor: exec, login: model.login, output: { log: (line) => logged.push(line), error: () => {} }, ...request, version });
    return { writes, logged };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return { writes, logged, refused: error.message };
  }
}

// The writes list records each write as it is made, so its order is the order the Status write met the position write in.
test('Move to Ready places the card after the last ranked Ready card, then writes Ready', async () => {
  const observed = [];
  for (const number of [31, 37]) {
    const model = moveModel();
    const { writes, logged, refused } = await moving(model, { card: number, move: 'ready' });
    observed.push({ number, writes, refused, last: logged.at(-1), ready: readyCards(model) });
  }
  assert.deepEqual(observed, [31, 37].map((number) => ({
    number, writes: [positionWrite(number, 35), statusWrite(number, 'Ready')], refused: undefined, last: `owner-queue: card ${number}: ready written`, ready: [32, 33, 34, 35, number],
  })));
});

test('the first card moved to an empty build order makes no position write', async () => {
  const model = moveModel();
  for (const number of [32, 33, 34, 35]) model.cards[number].status = 'Backlog';

  const { writes, logged, refused } = await moving(model, { card: 31, move: 'ready' });

  assert.deepEqual({ writes, refused, last: logged.at(-1), ready: readyCards(model) },
    { writes: [statusWrite(31, 'Ready')], refused: undefined, last: 'owner-queue: card 31: ready written', ready: [31] });
});

test('Back to Backlog writes Backlog and makes no position write', async () => {
  const model = moveModel();

  const { writes, logged, refused } = await moving(model, { card: 34, move: 'backlog' });

  assert.deepEqual({ writes, refused, last: logged.at(-1), ready: readyCards(model) },
    { writes: [statusWrite(34, 'Backlog')], refused: undefined, last: 'owner-queue: card 34: backlog written', ready: [32, 33, 35] });
});

test('Move up places the card after the card two ranks above it, and first from rank 2', async () => {
  // Each row: the card moved up, the card it is placed after (null for first) and the Ready column read back.
  const rows = [[35, 32, [32, 35, 33, 34]], [34, null, [34, 32, 33, 35]]];
  const observed = [];
  for (const [number] of rows) {
    const model = moveModel();
    const { writes, logged, refused } = await moving(model, { card: number, move: 'up' });
    observed.push({ number, writes, refused, last: logged.at(-1), ready: readyCards(model) });
  }
  assert.deepEqual(observed, rows.map(([number, after, ready]) => ({
    number, writes: [positionWrite(number, after)], refused: undefined, last: `owner-queue: card ${number}: up written`, ready,
  })));
});

test('a place move puts a Ready card at the place it names in the build order, place 1 first', async () => {
  // Each row: the card, the place it takes, the card it is placed after (null for first) and the Ready column read back.
  const rows = [[32, 3, 35, [33, 34, 35, 32]], [35, 1, null, [35, 32, 33, 34]], [32, 2, 34, [33, 34, 32, 35]], [35, 2, 32, [32, 35, 33, 34]]];
  const observed = [];
  for (const [number, to] of rows) {
    const model = moveModel();
    const { writes, logged, refused } = await moving(model, { card: number, move: 'place', to });
    observed.push({ number, to, writes, refused, last: logged.at(-1), ready: readyCards(model) });
  }
  assert.deepEqual(observed, rows.map(([number, to, after, ready]) => ({
    number, to, writes: [positionWrite(number, after)], refused: undefined, last: `owner-queue: card ${number}: place written`, ready,
  })));
});

test('the build order ranks only cards whose titles are not proposals', async () => {
  // Ready lists the suggestion 33, then 32 and 34, then the suggestion 39: the build order is 32, then 34.
  const ranked = () => {
    const model = moveModel();
    delete model.cards[35];
    model.cards[39] = { title: 'Proposed: A late suggestion', status: 'Ready', body: 'Scope: A late suggestion.', comments: [] };
    model.order = [31, 33, 32, 34, 39, 36, 37, 38];
    return model;
  };
  // Each row: the request, its writes, and the words its refusal holds where it refuses.
  const rows = [
    ['up from rank 1 behind a suggestion', { card: 32, move: 'up' }, [], 'first in the build order already'],
    ['up from rank 2', { card: 34, move: 'up' }, [positionWrite(34, null)]],
    ['ready after the last ranked card', { card: 31, move: 'ready' }, [positionWrite(31, 34), statusWrite(31, 'Ready')]],
  ];
  const observed = [];
  for (const [row, request, , words] of rows) {
    const { writes, refused } = await moving(ranked(), request);
    observed.push({ row, writes, refused: words !== undefined && refused?.includes(words) && !/[\r\n]/.test(refused) ? words : refused });
  }
  assert.deepEqual(observed, rows.map(([row, , writes, words]) => ({ row, writes, refused: words })));
});

test('ANTI-REGRESSION: a board move writes nothing where the tracker, card, details, version, column, proposal, order or rank refuses it', async () => {
  const hex = 'a'.repeat(64);
  const { orderUnread } = collectModel(omittedModel()).document.board;
  assert.match(String(orderUnread), /^GitHub's project listing left out 1 card/);
  // A refusal the plan words only in part is one line holding `includes`; ONE_LINE is any one line naming no fixture
  // failure.
  const ONE_LINE = { includes: '' };
  const refusedAs = (message, expected) => (typeof expected === 'string' || typeof message !== 'string' || message === ''
    || /[\r\n]/.test(message) || /^unexpected /.test(message) || !message.includes(expected.includes) ? message : expected);
  const unreadOrder = { includes: `the build order was not read: ${orderUnread}` };
  // Each row: the request, the model it runs on, the tracker, a change made after the panel drew the board, and the
  // line it refuses with.
  const rows = [
    { row: 'a tracker other than GitHub', request: { card: 31, move: 'ready' }, tracker: 'linear',
      refused: 'the panel moves cards only on a GitHub board: move them in your tracker' },
    { row: 'card 0', request: { card: 0, move: 'ready', version: hex }, refused: ONE_LINE },
    { row: 'move down', request: { card: 31, move: 'down' }, refused: ONE_LINE },
    { row: 'a board that cannot be read', request: { card: 31, move: 'ready' }, change: (model) => { model.cards = {}; model.order = []; }, refused: ONE_LINE },
    { row: 'a card not on the board', request: { card: 99, move: 'ready', version: hex }, refused: 'card 99 is not on the board now: refresh the queue' },
    { row: 'a card whose details were not read', request: { card: 31, move: 'ready' }, change: (model) => { model.cards[31].body = null; },
      refused: 'the details of card 31 were not read: malformed detail: body' },
    { row: 'a card changed since it was drawn', request: { card: 31, move: 'ready' }, change: (model) => { model.cards[31].title = 'A renamed backlog card'; },
      refused: 'card 31 changed since the panel drew it: refresh the queue' },
    { row: 'ready from In progress', request: { card: 36, move: 'ready' }, refused: ONE_LINE },
    { row: 'ready on a suggestion', request: { card: 38, move: 'ready' }, refused: { includes: 'accept it first' } },
    { row: 'ready with the build order unread', request: { card: 31, move: 'ready' }, model: omittedModel, refused: unreadOrder },
    { row: 'backlog from Backlog', request: { card: 31, move: 'backlog' }, refused: ONE_LINE },
    { row: 'up from Backlog', request: { card: 31, move: 'up' }, refused: ONE_LINE },
    { row: 'up on a suggestion in Ready', request: { card: 33, move: 'up' }, refused: ONE_LINE },
    { row: 'up with the build order unread', request: { card: 34, move: 'up' }, model: omittedModel, refused: unreadOrder },
    { row: 'up from rank 1', request: { card: 32, move: 'up' }, refused: { includes: 'first in the build order already' } },
    { row: 'place from Backlog', request: { card: 31, move: 'place', to: 1 }, refused: ONE_LINE },
    { row: 'place on a suggestion in Ready', request: { card: 33, move: 'place', to: 1 }, refused: ONE_LINE },
    { row: 'place with the build order unread', request: { card: 34, move: 'place', to: 1 }, model: omittedModel, refused: unreadOrder },
    { row: 'place at its own place', request: { card: 34, move: 'place', to: 2 }, refused: 'card 34 is at place 2 already' },
    { row: 'place past the last', request: { card: 32, move: 'place', to: 4 }, refused: 'card 32 cannot take place 4: the build order ends at place 3' },
    { row: 'place 0', request: { card: 32, move: 'place', to: 0 }, refused: '0 is not a place in the build order' },
  ];
  const observed = [];
  for (const { row, request, model = moveModel, tracker, change, refused: expected } of rows) {
    const { writes, refused } = await moving(model(), request, { tracker, change });
    observed.push({ row, writes, refused: refusedAs(refused, expected) });
  }
  assert.deepEqual(observed, rows.map(({ row, refused }) => ({ row, writes: [], refused })));
});

test('a Move to Ready whose placement fails writes no Status and names the card as not moved', async () => {
  const model = moveModel();
  model.positionReply = { data: {} };

  const { writes, logged, refused } = await moving(model, { card: 31, move: 'ready' });

  assert.deepEqual({ writes, refused, written: logged.includes('owner-queue: card 31: ready written') }, {
    writes: [positionWrite(31, 35)],
    refused: 'card 31 was not moved to Ready: its place last in the build order could not be set: position write GraphQL response has no updateProjectV2ItemPosition object',
    written: false,
  });
});

test('the move command refuses any other argument shape with exit 2 before any read', () => {
  const hex = 'c'.repeat(64);
  const shapes = [
    ['move'],
    ['move', '--card=31', '--move=ready'],
    ['move', '--card=0', '--move=ready', `--version=${hex}`],
    ['move', '--card=31', '--move=down', `--version=${hex}`],
    ['move', '--card=31', '--move=ready', `--version=${'C'.repeat(64)}`],
    ['move', '--card=31', '--move=ready', `--version=${'c'.repeat(63)}`],
    ['move', '--card=31', '--move=ready', `--version=${hex}`, '--reply=yes'],
    ['move', '--card=31', '--move=ready', `--version=${hex}`, 'extra'],
    ['move', '--card=32', '--move=place', `--version=${hex}`],
    ['move', '--card=32', '--move=place', `--version=${hex}`, '--to=0'],
    ['move', '--card=32', '--move=place', `--version=${hex}`, '--to=two'],
    ['move', '--card=32', '--move=up', `--version=${hex}`, '--to=1'],
  ];
  const entered = shapes.map((args) => {
    const logged = [];
    const errors = [];
    const code = readerMain(args, { log: (line) => logged.push(line), error: (line) => errors.push(line) });
    return { args, code, errors, logged };
  });
  assert.deepEqual(entered, shapes.map((args) => ({ args, code: 2, errors: [READER_USAGE], logged: [] })));
});

// The move board with an In review card, 41, and an Awaiting push card, 42, added.
function showFirstModel() {
  const model = moveModel();
  const entry = (title, status) => ({ title, status, body: `Scope: ${title}.`, comments: [] });
  Object.assign(model.cards, { 41: entry('A card in review', 'In review'), 42: entry('A card awaiting its push', 'Awaiting push') });
  model.order.push(41, 42);
  return model;
}

// The label write `gh` is asked for to set or remove card `number`'s marker, as `actExec` records it.
const labelWrite = (number, flag) => ({ args: ['issue', 'edit', String(number), '--repo', BOARD_SLUG, flag, 'show-me-first'] });

// `markShowFirst` over the model as `moving` runs `moveOnBoard`, with `change` made to the model first and, where
// `failing` is given, every label write failing with that text: its writes, the lines it logged and the line it refused
// with where it refused. A TypeError is a defect of the code under test, never a refusal, so it fails the test as itself.
function marking(model, request, { tracker = 'github', change, failing } = {}) {
  change?.(model);
  const { exec, writes } = actExec(model);
  const executor = failing === undefined ? exec : (args) => {
    if (args[0] === 'issue' && args[1] === 'edit') throw new Error(failing);
    return exec(args);
  };
  const logged = [];
  try {
    markShowFirst({ ...modelReaders(model), tracker, executor, login: model.login, output: { log: (line) => logged.push(line), error: () => {} }, ...request });
    return { writes, logged };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return { writes, logged, refused: error.message };
  }
}

test('ANTI-REGRESSION: show-first writes the marker only where the card is in Ready or In progress and its state differs, and writes nothing where the tracker, card, state, board, column, suggestion or labels refuse it', () => {
  const ADD = '--add-label';
  const REMOVE = '--remove-label';
  const MARKER = 'show-me-first';
  const notRead = 'the board was not read: the board read returned no cards: an auth, network or project problem, not an empty board';
  // Each row: the request, the labels its card holds first, the tracker, a change made to the model, the writes it
  // makes, the last line it logs or the line it refuses with, and the labels the card holds after.
  const rows = [
    { row: 'on in Ready', request: { card: 32, state: 'on' }, writes: [labelWrite(32, ADD)], last: 'owner-queue: card 32: show-me-first on written', after: [MARKER] },
    { row: 'on in In progress', request: { card: 36, state: 'on' }, writes: [labelWrite(36, ADD)], last: 'owner-queue: card 36: show-me-first on written', after: [MARKER] },
    { row: 'on in In review', request: { card: 41, state: 'on' }, writes: [labelWrite(41, ADD)], last: 'owner-queue: card 41: show-me-first on written', after: [MARKER] },
    { row: 'on in Awaiting push', request: { card: 42, state: 'on' }, writes: [labelWrite(42, ADD)], last: 'owner-queue: card 42: show-me-first on written', after: [MARKER] },
    { row: 'on beside another label', request: { card: 32, state: 'on' }, labels: ['bug'], writes: [labelWrite(32, ADD)], last: 'owner-queue: card 32: show-me-first on written', after: ['bug', MARKER] },
    { row: 'off in Ready', request: { card: 34, state: 'off' }, labels: [MARKER], writes: [labelWrite(34, REMOVE)], last: 'owner-queue: card 34: show-me-first off written', after: [] },
    { row: 'off on a case variant, keeping another label', request: { card: 35, state: 'off' }, labels: ['Show-Me-First', 'bug'], writes: [labelWrite(35, REMOVE)], last: 'owner-queue: card 35: show-me-first off written', after: ['bug'] },
    { row: 'on where it is on already', request: { card: 34, state: 'on' }, labels: [MARKER], last: 'owner-queue: card 34: show-me-first already on', after: [MARKER] },
    { row: 'on where a case variant with spaces is on already', request: { card: 34, state: 'on' }, labels: [' Show-Me-First '], last: 'owner-queue: card 34: show-me-first already on', after: [' Show-Me-First '] },
    { row: 'off where it is off already', request: { card: 32, state: 'off' }, last: 'owner-queue: card 32: show-me-first already off', after: [] },
    { row: 'a tracker other than GitHub', request: { card: 32, state: 'on' }, tracker: 'linear', refused: 'the panel changes Show me first only on a GitHub board: change it in your tracker' },
    { row: 'card 0', request: { card: 0, state: 'on' }, refused: '0 is not a card number' },
    { row: 'card "32"', request: { card: '32', state: 'on' }, refused: '"32" is not a card number' },
    { row: 'state toggle', request: { card: 32, state: 'toggle' }, refused: '"toggle" is not a Show me first state' },
    { row: 'a board that cannot be read', request: { card: 32, state: 'on' }, change: (model) => { model.cards = {}; model.order = []; }, refused: notRead },
    { row: 'a card not on the board', request: { card: 99, state: 'on' }, refused: 'card 99 is not on the board now: refresh the queue' },
    { row: 'a suggestion in Ready', request: { card: 33, state: 'on' }, refused: 'card 33 is a suggestion: accept it first' },
    { row: 'a suggestion in Backlog', request: { card: 38, state: 'off' }, refused: 'card 38 is a suggestion: accept it first' },
    { row: 'Backlog', request: { card: 31, state: 'on' }, refused: 'card 31 is in Backlog, not Ready or In progress' },
    { row: 'no column', request: { card: 37, state: 'off' }, refused: 'card 37 is in no column, not Ready or In progress' },
    { row: 'labels that are not text', request: { card: 32, state: 'on' }, labels: [7], refused: 'the labels of card 32 were not read: unreadable labels on card 32' },
    { row: 'Backlog with labels that are not text', request: { card: 31, state: 'off' }, labels: [7], refused: 'card 31 is in Backlog, not Ready or In progress' },
  ];
  const observed = [];
  for (const { row, request, labels = [], tracker, change } of rows) {
    const model = showFirstModel();
    if (model.cards[request.card]) model.cards[request.card].labels = labels;
    const { writes, logged, refused } = marking(model, request, { tracker, change });
    observed.push({ row, writes, refused, last: logged.at(-1), labels: model.cards[request.card]?.labels ?? [] });
  }
  assert.deepEqual(observed, rows.map(({ row, writes = [], refused, last, labels = [], after = labels }) => ({
    row, writes, refused, last, labels: after,
  })));

  // A label write that fails names the card and its cause, with the one-time fix where the label may be missing, and
  // leaves the card as it was.
  const failed = ['on', 'off'].map((state) => {
    const model = showFirstModel();
    model.cards[32].labels = state === 'on' ? [] : [MARKER];
    const { writes, refused } = marking(model, { card: 32, state }, { failing: 'label not found' });
    return { state, writes, refused, labels: model.cards[32].labels };
  });
  assert.deepEqual(failed, [
    { state: 'on', writes: [], labels: [],
      refused: 'card 32: show-me-first was not turned on: label not found; where this repository has no show-me-first label, create it once with gh label create show-me-first' },
    { state: 'off', writes: [], labels: [MARKER], refused: 'card 32: show-me-first was not turned off: label not found' },
  ]);
});

test('a card switched on while it is built is held at its merge by show-me-first, and switched off is not', () => {
  const model = Object.assign(actModel(), { settingText: '{"version":1,"waitForOwner":"when-needed"}' });
  // Card 8 is switched while it is in progress, then reaches its merge, where the queue reads whether it waits.
  const atMerge = (state) => {
    model.cards[8].status = 'In progress';
    const { writes, refused } = marking(model, { card: 8, state });
    model.cards[8].status = 'Awaiting push';
    const merge = collectModel(model).document.items.find((item) => item.card === 8 && item.category === 'merge');
    return { writes: writes.length, refused, reason: merge.reason };
  };

  assert.deepEqual([atMerge('on'), atMerge('off')], [
    { writes: 1, refused: undefined, reason: 'show-me-first' },
    { writes: 1, refused: undefined, reason: undefined },
  ]);
});

test('the show-first command refuses any other argument shape with exit 2 before any read', () => {
  const shapes = [
    ['show-first'],
    ['show-first', '--card=32'],
    ['show-first', '--state=on'],
    ['show-first', '--card=0', '--state=on'],
    ['show-first', '--card=032', '--state=on'],
    ['show-first', '--card=32', '--state=ON'],
    ['show-first', '--card=32', '--state=toggle'],
    ['show-first', '--card=32', '--state=on', `--version=${'c'.repeat(64)}`],
    ['show-first', '--card=32', '--state=on', '--reply=yes'],
    ['show-first', '--card=32', '--state=on', 'extra'],
  ];
  const entered = shapes.map((args) => {
    const logged = [];
    const errors = [];
    const code = readerMain(args, { log: (line) => logged.push(line), error: (line) => errors.push(line) });
    return { args, code, errors, logged };
  });
  assert.deepEqual(entered, shapes.map((args) => ({ args, code: 2, errors: [READER_USAGE], logged: [] })));
});

// The wire pair runs the panel's real commands,`queue.mjs refresh` and then `queue.mjs act`, on a Herdr home whose
// machine record lists the toolkit copy, whose `scripts/owner-queue.mjs` reads through a fake `gh`. The fake answers
// the reads, both card reads, the Status field read, the item lookup by card number and the pull requests associated
// with a commit among them, from a replies file
// the test may rewrite between the commands, answers a comment edit and a title edit of the replies' card, a Status
// write, a position write and the card's show-me-first label edit, refuses any other call, and records each call with
// the text of the body file it names, read at call time.
const WIRE_GH = String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const replies = JSON.parse(readFileSync(process.env.WIRE_REPLIES, 'utf8'));
const call = args.join(' ');
const query = args.find((arg) => arg.startsWith('query=')) || '';
const file = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : (args.find((arg) => arg.startsWith('body=@')) || '').slice('body=@'.length);
let reply;
if (call === 'api user --jq .login') reply = 'owner\n';
else if (query.includes('associatedPullRequests')) reply = JSON.stringify(replies.pulls);
else if (/\bprojectV2\(number:/.test(query) && /\bitems\(first:/.test(query)) reply = JSON.stringify(replies.board);
else if (/\bissues\(/.test(query)) reply = JSON.stringify(replies.issues);
else if (query.includes('CardDetails')) reply = JSON.stringify(replies.details);
else if (query.includes('comments(first: 100')) reply = JSON.stringify(replies.issue);
else if (query.includes('projectItems(first:20)')) reply = JSON.stringify(replies.items[/issue\(number:(\d+)\)/.exec(query)[1]]);
else if (query.includes('field(name:"Status")')) reply = JSON.stringify(replies.field);
else if (call === 'repo view ${BOARD_SLUG} --json id,nameWithOwner') reply = JSON.stringify({ id: 'R_wire', nameWithOwner: '${BOARD_SLUG}' });
else if (call === 'issue view ' + replies.card + ' --repo ${BOARD_SLUG} --json comments') reply = JSON.stringify(replies.comments);
const kind = reply === undefined ? 'write' : 'read';
if (/^api -X PATCH repos\/${BOARD_SLUG.replace('/', '\\/')}\/issues\/comments\/\d+ -F body=@/.test(call)) reply = '{}';
if (args.length === 7 && call.startsWith('issue edit ' + replies.card + ' --repo ${BOARD_SLUG} --title ')) reply = '';
if (args.length === 7 && ['--add-label', '--remove-label'].some((flag) => call === 'issue edit ' + replies.card + ' --repo ${BOARD_SLUG} ' + flag + ' show-me-first')) reply = '';
if (/^project item-edit --id PVTI_\d+ --project-id PVT_wire --field-id PVTSSF_wire --single-select-option-id opt-[a-z-]+$/.test(call)) reply = '';
if (args[0] === 'api' && args[1] === 'graphql' && query.includes('updateProjectV2ItemPosition')) reply = JSON.stringify({ data: { updateProjectV2ItemPosition: { clientMutationId: null } } });
appendFileSync(process.env.WIRE_CALLS, JSON.stringify({ kind, args, text: file ? readFileSync(file, 'utf8') : undefined }) + '\n');
if (reply === undefined) {
  process.stderr.write('fake gh: unexpected call ' + call);
  process.exitCode = 1;
} else process.stdout.write(reply);
`;

// Card 27 has a genuine chat question and matching legacy lead evidence in the toolkit copy. `selection` is the
// fixture-private selection file, `answer(title)` writes the replies with that title, `suggest(title)` writes them
// for card 27 as a scoped suggestion in Backlog whose only comment
// is the claim, `ranked(title)` writes them for card 27 in Backlog with no comment, listed after card 28, the one card in
// Ready, `building(labels)` writes them for card 27 in In progress holding `labels`, `merged(pulls, issue)` writes the
// replies a merge's report reads, the pull requests associated with its commit and the read of its card, `queue(...args)` runs a queue command on the Herdr home, `reader(...args)` runs the toolkit copy's
// `scripts/owner-queue.mjs` from its root, `writes()` lists the recorded writes with each body file's path written
// `<file>`, and `cached()` reads the card's cached item.
function wireRepository(t, copied = toolkit) {
  const { root } = copied;
  if (!existsSync(join(root, '.git'))) realGit(root, 'init', '-q', '-b', 'main');
  const host = hostname();
  const number = 27;
  const fake = installFakeGh('owner-queue-wire-', WIRE_GH);
  t.after(() => fake.cleanup());
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'owner-queue-wire-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, 'herdr');
  mkdirSync(join(home, 'fabraik-queue'), { recursive: true });
  writeFileSync(join(home, 'fabraik-queue', 'machine.json'), JSON.stringify({ format: 1, release: null, files: {}, repositories: [root] }));
  const xdgState = join(scratch, 'xdg');
  const runs = join(xdgState, 'fabraik-lead', 'runs', '2026-11-08T190000Z-wire27');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const selection = join(runs, `select-${number}.selected.json`);
  writeFileSync(selection, JSON.stringify({
    runStart: RUN_MARK, card: number, claimUrl: commentUrl(number, 3271), priorClaimUrls: [], branch: `job/${number}`, worktree: join(scratch, `job-${number}`), base: 'f'.repeat(40),
  }), { mode: 0o600 });
  const phaseId = randomBytes(16).toString('hex');
  const directory = join(runs, 'units', phaseId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'intent.json'), JSON.stringify({ phaseId, phase: `select-${number}`,
    unit: `fabraik-lead-${createHash('sha256').update(join(xdgState, 'fabraik-lead')).digest('hex').slice(0, 8)}-slot1-${phaseId}.service`,
    bootId: '00000000-0000-4000-8000-000000000001', root, runStart: RUN_MARK,
    controllerPid: process.pid, controllerStartTicks: '1' }), { flag: 'wx', mode: 0o600 });
  const comments = [
    comment(number, 3271, `Claim: ${host}, Claude Code, 2026-11-02T09:00Z`),
    comment(number, 3272, `Needs owner: Which colour? Job: job/${number} on ${host}.`),
  ];
  const replies = join(scratch, 'replies.json');
  const calls = join(scratch, 'calls.jsonl');
  const answer = (title) => writeFileSync(replies, JSON.stringify({
    card: number,
    board: [leanBoardPage([card(number, title, 'Backlog')])],
    issues: [issuesPage([])],
    details: { data: { repository: { [`i${number}`]: detail(number, `Scope of card ${number}.`, comments.map(({ body }) => body)) } } },
    comments: { comments },
    issue: { data: { viewer: { login: 'owner' }, repository: { id: 'R_wire', issue: {
      state: 'OPEN', title, body: `Scope of card ${number}.`, lastEditedAt: null,
      comments: { pageInfo: { hasNextPage: false }, nodes: comments.map((entry) => ({ lastEditedAt: null, ...entry })) },
    } } } },
  }));
  answer('A held wire question');
  const claim = comments[0];
  const suggest = (title) => writeFileSync(replies, JSON.stringify({
    card: number,
    board: [leanBoardPage([card(number, title, 'Backlog')])],
    issues: [issuesPage([])],
    details: { data: { repository: { [`i${number}`]: detail(number, SCOPED, [claim.body]) } } },
    comments: { comments: [claim] },
    issue: { data: { viewer: { login: 'owner' }, repository: { id: 'R_wire', issue: {
      state: 'OPEN', title, body: SCOPED, lastEditedAt: null,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ lastEditedAt: null, ...claim }] },
    } } } },
    items: { [number]: issueItemReply([{ ...membership(`PVTI_${number}`), value: { name: 'Backlog' } }], { issueId: `I_${number}` }) },
  }));
  const ranked = (title, column = 'Backlog') => writeFileSync(replies, JSON.stringify({
    card: number,
    board: [leanBoardPage([card(28, 'A wire card to build', 'Ready'), card(number, title, column)])],
    issues: [issuesPage([])],
    details: { data: { repository: { i28: detail(28, 'Scope of card 28.', []), [`i${number}`]: detail(number, `Scope of card ${number}.`, []) } } },
    field: { data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_wire', field: { id: 'PVTSSF_wire', options: STATUS_OPTIONS.map((name) => ({ id: optionId(name), name })) } } } } },
    items: Object.fromEntries([[28, 'Ready'], [number, column]].map(([at, column]) => [at, issueItemReply([{ ...membership(`PVTI_${at}`), value: { name: column } }], { issueId: `I_${at}` })])),
  }));
  const building = (labels) => writeFileSync(replies, JSON.stringify({
    card: number,
    board: [leanBoardPage([card(number, 'A wire card in build', 'In progress', labels)])],
    issues: [issuesPage([])],
    details: { data: { repository: { [`i${number}`]: detail(number, `Scope of card ${number}.`, [claim.body]) } } },
  }));
  const merged = (pulls, issue) => writeFileSync(replies, JSON.stringify({ card: number, pulls, issue }));
  const env = fake.env({ WIRE_REPLIES: replies, WIRE_CALLS: calls, XDG_STATE_HOME: xdgState });
  const queue = (...args) => spawnSync(process.execPath, [QUEUE, ...args, '--home', home], { encoding: 'utf8', timeout: 30_000, env });
  const reader = (...args) => spawnSync(process.execPath, [copied.script('owner-queue.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env });
  const writes = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
    .filter(({ kind }) => kind === 'write')
    .map(({ args, text }) => ({ args: args.map((arg) => (arg.startsWith('body=@') ? 'body=@<file>' : arg)), text }));
  const cached = () => JSON.parse(readFileSync(join(home, 'fabraik-queue', 'queue.json'), 'utf8')).items.find((item) => item.key === `${root}#${number}`);
  return { host, number, selection, answer, suggest, ranked, building, merged, queue, reader, writes, cached };
}

test('929 reads the saved coordinator choice from fetched main', (t) => {
  const copied = copyOwnerQueueToolkit();
  t.after(() => copied.cleanup());
  const wire = wireRepository(t, copied);
  const settings = '.agents/factory-settings.json';
  mkdirSync(dirname(join(copied.root, settings)), { recursive: true });
  const textFor = (runtime, runtimes) => JSON.stringify({ version: 1, herdr: true, coordinator: { runtime }, runtimes });
  const dirty = textFor('claude', ['claude']);
  const readWith = (text) => {
    writeFileSync(join(copied.root, settings), text);
    realGit(copied.root, 'add', '--', settings);
    realGit(copied.root, 'commit', '-qm', 'Seed main settings');
    realGit(copied.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(copied.root, settings), dirty);
    const read = wire.reader();
    assert.equal(read.status, 0, read.stdout + read.stderr);
    const document = JSON.parse(read.stdout);
    assert.ok(document.sources.some(({ name, ok }) => name === 'board' && ok), 'the board read succeeds');
    assert.ok(document.board?.cards.some(({ card }) => card === wire.number), 'the board contains the offline fixture card');
    assert.equal(readFileSync(join(copied.root, settings), 'utf8'), dirty, 'the read leaves the dirty settings untouched');
    return document.board.coordinator;
  };

  assert.deepEqual(readWith(textFor('codex', ['claude', 'codex'])), { runtime: 'codex', installed: ['claude', 'codex'] });
  assert.deepEqual(readWith(textFor('codex', ['codex'])), { runtime: 'codex', installed: ['codex'] });
  const corrupt = readWith('{"corrupt-contents-marker":');
  assert.deepEqual(Object.keys(corrupt), ['unread']);
  assert.match(corrupt.unread, /setting/i);
  assert.doesNotMatch(corrupt.unread, /corrupt-contents-marker/);
});

test('ANTI-REGRESSION: retired lead evidence grants no queue authority', { skip: OWNED_HISTORY_SKIP }, (t) => {
  const wire = wireRepository(t);
  const refreshed = wire.queue('refresh');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const item = wire.cached();
  const question = {
    category: 'question',
    question: `Needs owner: Which colour? Job: job/27 on ${wire.host}.`,
    heldOn: wire.host,
  };
  const shownQuestion = (entry) => ({ category: entry?.category, question: entry?.question, heldOn: entry?.heldOn });
  assert.deepEqual(shownQuestion(item), question);
  assert.match(String(item.version), /^[0-9a-f]{64}$/, JSON.stringify(item));

  const acted = wire.reader('act', '--card=27', '--action=answer', `--version=${item.version}`, '--reply=Use the blue one.');
  const writes = wire.writes();

  writeFileSync(wire.selection, '{');
  const read = wire.reader();
  assert.equal(read.status, 0, read.stdout + read.stderr);
  const document = JSON.parse(read.stdout);
  const corrupt = document.items.find(({ card }) => card === 27);
  const retiredSources = document.sources.filter(({ name }) => name === 'lead selections' || name === 'lead records');

  assert.deepEqual({
    valid: { ...shownQuestion(item), answerable: item.answerable },
    action: {
      status: acted.status,
      diagnostic: /answer in chat/i.test(acted.stderr) ? 'answer in chat' : (acted.stderr || acted.stdout).trim(),
      writes,
    },
    corrupt: { ...shownQuestion(corrupt), answerable: corrupt?.answerable, retiredSources },
  }, {
    valid: { ...question, answerable: undefined },
    action: { status: 1, diagnostic: 'answer in chat', writes: [] },
    corrupt: { ...question, answerable: undefined, retiredSources: [] },
  });
});

test('the real undo command takes back an accepted card and refuses one whose title was edited since', (t) => {
  const wire = wireRepository(t);
  wire.suggest('Proposed: A wire suggestion');
  const refreshed = wire.queue('refresh');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const item = wire.cached();
  assert.equal(item?.category, 'suggested', JSON.stringify(item));
  assert.match(String(item.version), /^[0-9a-f]{64}$/, JSON.stringify(item));

  const acted = wire.reader('act', '--card=27', '--action=keep', `--version=${item.version}`);
  assert.equal(acted.status, 0, acted.stderr);
  const recorded = acted.stdout.trimEnd().split('\n').at(-1);
  assert.ok(recorded.startsWith(RECORD_PREFIX), `the act's last line holds no undo record: ${acted.stdout}`);
  const undoArgs = ['undo', '--card=27', '--action=keep', `--record=${recorded.slice(RECORD_PREFIX.length)}`];
  const titled = (title) => ({ args: ['issue', 'edit', '27', '--repo', BOARD_SLUG, '--title', title], text: undefined });

  wire.suggest('A wire suggestion');
  const undone = wire.reader(...undoArgs);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(undone.stdout.trimEnd().split('\n').at(-1), 'owner-queue: card 27: keep taken back');
  const written = [titled('A wire suggestion'), titled('Proposed: A wire suggestion')];
  assert.deepEqual(wire.writes(), written);

  wire.suggest('A wire suggestion, renamed');
  const refused = wire.reader(...undoArgs);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr, 'owner-queue: card 27 moved since it was accepted: its title was edited\n');
  assert.deepEqual(wire.writes(), written);
});

test("the real show-first command chain turns a building card's marker on and off", (t) => {
  const wire = wireRepository(t);
  const key = `${toolkit.root}#${wire.number}`;
  const labelled = (flag) => ({ args: ['issue', 'edit', String(wire.number), '--repo', BOARD_SLUG, flag, 'show-me-first'], text: undefined });

  wire.building([]);
  const on = wire.queue('show-first', key, 'on');
  assert.deepEqual({ status: on.status, stdout: on.stdout }, { status: 0, stdout: '' }, on.stderr);
  assert.deepEqual(wire.writes(), [labelled('--add-label')]);

  wire.building(['show-me-first']);
  const off = wire.queue('show-first', key, 'off');
  assert.deepEqual({ status: off.status, stdout: off.stdout }, { status: 0, stdout: '' }, off.stderr);
  assert.deepEqual(wire.writes(), [labelled('--add-label'), labelled('--remove-label')]);
});

// Card 27's version as the real reader's document draws it, the board read through the fake.
function wireVersion(wire) {
  const read = wire.reader();
  assert.equal(read.status, 0, read.stderr);
  return JSON.parse(read.stdout).board.cards.find((entry) => entry.card === wire.number)?.version;
}

test('the real move command chain moves a card to Ready and places it last', (t) => {
  const wire = wireRepository(t);
  wire.ranked('A wire card');
  const version = wireVersion(wire);

  const moved = wire.reader('move', `--card=${wire.number}`, '--move=ready', `--version=${version}`);

  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout.trimEnd().split('\n').at(-1), `owner-queue: card ${wire.number}: ready written`);
  // The position write as GitHub's updateProjectV2ItemPosition takes it, with afterId naming card 28's item.
  const placeAfter = 'mutation($project: ID!, $item: ID!, $after: ID!) { updateProjectV2ItemPosition(input: {projectId: $project, itemId: $item, afterId: $after}) { clientMutationId } }';
  assert.deepEqual(wire.writes(), [
    { args: ['api', 'graphql', '-f', `query=${placeAfter}`, '-f', 'project=PVT_wire', '-f', `item=PVTI_${wire.number}`, '-f', 'after=PVTI_28'], text: undefined },
    { args: ['project', 'item-edit', '--id', `PVTI_${wire.number}`, '--project-id', 'PVT_wire', '--field-id', 'PVTSSF_wire', '--single-select-option-id', optionId('Ready')], text: undefined },
  ]);
});

test('the real move command chain places a Ready card at the place it names', (t) => {
  const wire = wireRepository(t);
  wire.ranked('A wire card', 'Ready');
  const version = wireVersion(wire);

  const moved = wire.reader('move', `--card=${wire.number}`, '--move=place', `--version=${version}`, '--to=1');

  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout.trimEnd().split('\n').at(-1), `owner-queue: card ${wire.number}: place written`);
  // The position write as GitHub's updateProjectV2ItemPosition takes it for first place: no afterId.
  const placeFirst = 'mutation($project: ID!, $item: ID!) { updateProjectV2ItemPosition(input: {projectId: $project, itemId: $item}) { clientMutationId } }';
  assert.deepEqual(wire.writes(), [
    { args: ['api', 'graphql', '-f', `query=${placeFirst}`, '-f', 'project=PVT_wire', '-f', `item=PVTI_${wire.number}`], text: undefined },
  ]);
});

test('the real move command chain refuses a card changed since it was drawn and writes nothing', (t) => {
  const wire = wireRepository(t);
  wire.ranked('A wire card');
  const version = wireVersion(wire);
  wire.ranked('A wire card, renamed');

  const moved = wire.reader('move', `--card=${wire.number}`, '--move=ready', `--version=${version}`);

  assert.equal(moved.status, 1, moved.stderr);
  assert.equal(moved.stderr, `owner-queue: card ${wire.number} changed since the panel drew it: refresh the queue\n`);
  assert.deepEqual(wire.writes(), []);
});

// A merge's report reads the merged pull request GitHub associates with the merge commit, its card, the wait level at
// the merge's first parent and its screenshots, each through a fake. The pull request bodies are synthetic text in the
// three Decision card shapes the resume skill's chat presentation (review-and-push.md, blocks 1 to 5) has produced:
// labelled blocks, heading paragraphs and unlabelled paragraphs. The expected reports are written by hand from that
// presentation, the `Waiting for you:` comment the deliver step posts and the wait judgement of merge-evidence.mjs.
// A weekly retro as the local job files it: the write-up the owner reads, then the card drafts as one line of JSON in
// a fenced block. Draft 1 is for another repository, draft 2 for the board's own, and proposal 3 carries no draft.
const OTHER_SLUG = 'example-owner/other-repo';
const RETRO = 60;
const RETRO_WEEK = '2026-11-02';
const RETRO_MARKER = 'PRIVATE_RETRO_584';
const RETRO_DRAFTS = [
  { n: 1, repository: OTHER_SLUG, title: 'Shorter refusals in the queue panel', problem: 'A refusal runs past the width of the panel.',
    build: 'One short line for each refusal.', criteria: ['Every refusal fits one line.', 'No refusal names a credential.'], kind: 'feature', label: 'enhancement', workstream: 'Platform' },
  { n: 2, repository: BOARD_SLUG, title: 'A plainer name for the build order', problem: 'The build order is named two ways.',
    build: 'One name on every screen.', criteria: ['Each screen uses the one name.'], kind: 'task', label: 'task', workstream: 'Product' },
];
const RETRO_WRITE_UP = [
  'This is the weekly retro written on your laptop from your own chats.', '',
  '## Proposals', '',
  `### Proposal 1 for ${OTHER_SLUG}`, '', 'Summary: Refusals are too long to read.', '', `> make the refusals shorter ${RETRO_MARKER}`, '', 'other-repo, Claude Code, 3 November, owner', '',
  `### Proposal 2 for ${BOARD_SLUG}`, '', 'Summary: The build order has two names.', '', '> call it one thing', '', 'example-repo, Codex, 4 November, owner', '',
  `### Proposal 3 for ${BOARD_SLUG}`, '', 'Summary: Fewer status words.', '', '> too many words', '', 'example-repo, Codex, 5 November, owner', '', 'No card offered: none was drafted.', '',
  '## Where I think you were wrong', '', '### Point 1', '', 'Claim: The panel should stay as it is.', '', 'Why: You asked for the opposite a day later.', '', '> leave the panel alone', '', 'example-repo, Claude Code, 6 November, owner', '',
  '## Left out', '', 'Nothing was left out.',
].join('\n');
const retroBody = (proposals, writeUp) => `${writeUp}\n\n## Card drafts\n\n\`\`\`json fabraik-retro\n${JSON.stringify({ format: 1, week: RETRO_WEEK, proposals })}\n\`\`\`\n`;

// The act model with the weekly retro as card RETRO, a suggestion in Backlog.
function retroModel(proposals = RETRO_DRAFTS, writeUp = RETRO_WRITE_UP) {
  const model = actModel();
  model.cards[RETRO] = { title: `Proposed: Weekly retro for the week of ${RETRO_WEEK}`, status: 'Backlog', body: retroBody(proposals, writeUp), comments: [] };
  return model;
}

const retroItem = (model) => collectModel(model).document.items.find((item) => item.card === RETRO);

// The card a picked draft is filed as: its three sections, its routing line where it goes to another repository, and
// the week of the retro it came from. Nothing else.
const pickedCard = (draft) => ['## Problem', '', draft.problem, '', '## What to build', '', draft.build, '', '## Acceptance criteria', '',
  ...draft.criteria.map((line) => `- [ ] ${line}`), '',
  ...(draft.repository !== BOARD_SLUG && draft.workstream !== undefined ? [`Workstream: ${draft.workstream}`, ''] : []),
  `Local retro: ${RETRO_WEEK}`, ''].join('\n');
const pickedLine = (proposal, number, repository) => ({ args: ['issue', 'comment', String(RETRO), '--repo', BOARD_SLUG, '--body-file', '<file>'],
  text: `Picked: proposal ${proposal} became card ${number} in ${repository}.` });

test('ANTI-REGRESSION: picking a retro proposal posts only its stored draft to the repository the draft names', async () => {
  const pick = (model, proposal, version = versionsOf(model).get(RETRO)) => acting(model, { card: RETRO, action: 'pick', proposal, version });
  const created = (draft) => ({ args: ['issue', 'create', '--repo', draft.repository, '--title', draft.title, '--body-file', '<file>', '--label', draft.label], text: pickedCard(draft) });

  const [elsewhere, own] = RETRO_DRAFTS;
  const sent = await pick(retroModel(), 1);
  assert.equal(sent.refused, undefined, 'a draft for another repository is picked');
  assert.deepEqual(sent.writes, [created(elsewhere), pickedLine(1, 900, OTHER_SLUG)], 'one card in the repository the draft names, then the note on the retro');
  assert.equal(sent.logged.at(-1), `owner-queue: card ${RETRO}: pick written`);
  assert.deepEqual(sent.bodyFiles.filter((path) => existsSync(path)), [], 'no body file is left');

  const kept = await pick(retroModel(), 2);
  assert.equal(kept.refused, undefined, 'a draft for the board\'s own repository is picked');
  assert.deepEqual(kept.writes, [
    created(own),
    { board: { card: 900, added: true } },
    { board: { card: 900, field: 'Status', value: 'Backlog' } },
    { board: { card: 900, field: ROUTING_FIELD, value: 'Product' } },
    pickedLine(2, 900, BOARD_SLUG),
  ], 'one card in the own repository, placed in Backlog with its routing value, then the note on the retro');

  for (const { calls, writes } of [sent, kept]) {
    assert.equal(JSON.stringify([calls, writes]).includes(RETRO_MARKER), false, 'nothing of the write-up is in any call or write');
  }

  // Each row: the model, the proposal picked, and a change made after the panel drew the item.
  const edited = (change) => RETRO_DRAFTS.map((draft) => ({ ...draft, ...change(draft) }));
  const rows = [
    ['a proposal with no draft', retroModel(), 3],
    ['a proposal already picked', (() => { const model = retroModel(); model.cards[RETRO].comments.push(comment(RETRO, 3601, `Picked: proposal 1 became card 77 in ${OTHER_SLUG}.`)); return model; })(), 1],
    ['a retro edited since the panel drew it', retroModel(), 1, (model) => { model.cards[RETRO].body = retroBody(edited((draft) => ({ build: `${draft.build} And more.` })), RETRO_WRITE_UP); }],
    ['a draft holding a web address', retroModel(edited((draft) => (draft.n === 1 ? { problem: 'See https://example.com/page for it.' } : {}))), 1],
    ['an own-repository draft with a label the board lacks', retroModel(edited((draft) => (draft.n === 2 ? { label: 'chore' } : {}))), 2],
    ['a card of that title with another body', Object.assign(retroModel(), { filed: { [OTHER_SLUG]: [
      { number: 31, title: elsewhere.title, body: 'Another card.', state: 'open', html_url: `https://github.com/${OTHER_SLUG}/issues/31` }] } }), 1,
    null, `card 31 in ${OTHER_SLUG} already has this title and is not this draft: answer in chat`],
  ];
  const refusal = (message, fixed) => {
    if (typeof message !== 'string' || message === '' || /[\r\n]/.test(message) || /^unexpected (?:gh|git) /.test(message) || message.includes(RETRO_MARKER)) return message;
    return fixed === undefined || message === fixed ? fixed ?? 'one line' : message;
  };
  const observed = [];
  for (const [row, model, proposal, after, fixed] of rows) {
    const version = versionsOf(model).get(RETRO);
    after?.(model);
    const { writes, refused } = await pick(model, proposal, version);
    observed.push({ row, writes, refused: refusal(refused, fixed) });
  }
  assert.deepEqual(observed, rows.map(([row, , , , fixed]) => ({ row, writes: [], refused: fixed ?? 'one line' })));
});

test('ANTI-REGRESSION: a weekly retro write-up holding an image or raw HTML is carried as plain text', () => {
  const image = `${RETRO_WRITE_UP}\n\n![shot](https://example.com/a.png)`;
  const html = `${RETRO_WRITE_UP}\n\n<img src="https://example.com/a.png">`;
  assert.deepEqual([image, html, RETRO_WRITE_UP].map((writeUp) => retroItem(retroModel(RETRO_DRAFTS, writeUp)).writeUp), [{ plain: image }, { plain: html }, RETRO_WRITE_UP]);
});

test('a retro proposal already picked is marked with its card', () => {
  const cardsOf = (login) => {
    const model = retroModel();
    model.cards[RETRO].comments.push(comment(RETRO, 3601, `Picked: proposal 2 became card 77 in ${BOARD_SLUG}.`, login));
    const { proposals } = retroItem(model);
    assert.ok(Array.isArray(proposals), 'the retro item carries its proposals');
    return proposals.map(({ n, card: made }) => ({ n, card: made ?? null }));
  };
  assert.deepEqual(cardsOf('owner'), [{ n: 1, card: null }, { n: 2, card: { repository: BOARD_SLUG, number: 77 } }]);
  assert.deepEqual(cardsOf('someone'), [{ n: 1, card: null }, { n: 2, card: null }], 'the same words from another account mark nothing');
});

test('a weekly retro issue reads as a suggested item with its write-up and proposals', () => {
  const item = retroItem(retroModel());
  assert.equal(item.category, 'suggested');
  assert.equal(item.writeUp, RETRO_WRITE_UP, 'the write-up is the body before the card drafts');
  assert.deepEqual(item.proposals, RETRO_DRAFTS.map((draft) => Object.fromEntries(Object.entries(draft).filter(([name]) => name !== 'kind'))));
  const section = (heading, count) => Array.from({ length: count }, (_, index) => `### ${heading} ${index + 1}\n\nSummary: One line.`).join('\n\n');
  const reasonOf = (proposals, points) => retroItem(retroModel([], `Opening line.\n\n## Proposals\n\n${section('Proposal', proposals)}\n\n## Where I think you were wrong\n\n${section('Point', points)}`)).reason;
  assert.deepEqual([item.reason, reasonOf(1, 2), reasonOf(0, 0)],
    ['3 proposals and 1 place I think you were wrong', '1 proposal and 2 places I think you were wrong', 'Nothing to report this week']);

  const unread = collectModel(retroModel(), { login: null }).document.items.find((each) => each.card === RETRO);
  assert.deepEqual([unread.category, unread.writeUp, unread.proposals], ['suggested', undefined, undefined], 'read with no login it is an ordinary suggested card');
});

test('a retro issue with a malformed drafts block reads as a plain suggested card', () => {
  const [first] = RETRO_DRAFTS;
  const lines = [
    ['a block that is not JSON', '{"format": 1, "week":'],
    ['another format number', JSON.stringify({ format: 2, week: RETRO_WEEK, proposals: RETRO_DRAFTS })],
    ['a draft holding a web address', JSON.stringify({ format: 1, week: RETRO_WEEK, proposals: [{ ...first, problem: 'See https://example.com/page for it.' }] })],
    ['two drafts of one number', JSON.stringify({ format: 1, week: RETRO_WEEK, proposals: [first, first] })],
  ];
  const observed = lines.map(([row, line]) => {
    const model = retroModel();
    model.cards[RETRO].body = `${RETRO_WRITE_UP}\n\n## Card drafts\n\n\`\`\`json fabraik-retro\n${line}\n\`\`\`\n`;
    const { category, writeUp, proposals } = retroItem(model);
    return { row, category, writeUp, proposals };
  });
  assert.deepEqual(observed, lines.map(([row]) => ({ row, category: 'suggested', writeUp: undefined, proposals: undefined })));
});

test('a pick finishes a card an earlier pick created and closes a racing twin', async () => {
  const [, own] = RETRO_DRAFTS;
  const twin = { number: 31, title: own.title, body: pickedCard(own), state: 'open', html_url: `https://github.com/${BOARD_SLUG}/issues/31` };
  const standing = (entry) => ({ title: own.title, body: pickedCard(own), comments: [], ...entry });
  const pick = (model) => acting(model, { card: RETRO, action: 'pick', proposal: 2, version: versionsOf(model).get(RETRO) });
  const placed = [
    { board: { card: 31, added: true } },
    { board: { card: 31, field: 'Status', value: 'Backlog' } },
    { board: { card: 31, field: ROUTING_FIELD, value: 'Product' } },
  ];

  const created = Object.assign(retroModel(), { filed: { [BOARD_SLUG]: [twin] } });
  created.cards[31] = standing({ status: null, offBoard: true, unlisted: true });
  const finished = await pick(created);
  assert.equal(finished.refused, undefined);
  assert.deepEqual(finished.writes, [...placed, pickedLine(2, 31, BOARD_SLUG)], 'a card an earlier pick created is placed and noted, never created again');

  const moved = Object.assign(retroModel(), { filed: { [BOARD_SLUG]: [twin] } });
  moved.cards[31] = standing({ status: 'Ready' });
  const noted = await pick(moved);
  assert.equal(noted.refused, undefined);
  assert.deepEqual(noted.writes, [pickedLine(2, 31, BOARD_SLUG)], 'a card the owner has since moved keeps its column and routing value');
  assert.equal(moved.cards[31].status, 'Ready');

  const racing = retroModel();
  racing.duringAct = (args) => {
    if (args[1] !== 'create') return;
    racing.filed[BOARD_SLUG].unshift(twin);
    racing.cards[31] = standing({ status: null, offBoard: true, unlisted: true });
  };
  const raced = await pick(racing);
  assert.equal(raced.refused, undefined);
  assert.deepEqual(raced.writes, [
    { args: ['issue', 'create', '--repo', BOARD_SLUG, '--title', own.title, '--body-file', '<file>', '--label', own.label], text: pickedCard(own) },
    { args: ['issue', 'close', '900', '--repo', BOARD_SLUG, '--reason', 'not planned'] },
    ...placed,
    pickedLine(2, 31, BOARD_SLUG),
  ], 'the card created beside a lower-numbered twin is closed, and the twin is the one placed and named');
});

test('picking a retro proposal works on a board with no routing field', async (t) => {
  const unrouted = copyToolkit(GITHUB_TEST_CONFIG
    .replace("export const ROUTING_FIELD = 'Workstream';", 'export const ROUTING_FIELD = null;')
    .replace("export const ROUTING_OPTIONS = ['Go-to-market', 'Product', 'Platform'];", 'export const ROUTING_OPTIONS = [];'));
  t.after(() => unrouted.cleanup());
  for (const name of ['lib/pre-approved-run.mjs', 'lib/closeout-cleanup.mjs', 'lib/run-folder.mjs', 'lib/owner-queue.mjs']) {
    mkdirSync(dirname(unrouted.script(name)), { recursive: true });
    copyFileSync(toolkit.script(name), unrouted.script(name));
  }
  const held = await unrouted.load('lib/board-config.mjs');
  assert.equal(held.ROUTING_FIELD, null, 'the copy has no routing field');
  const reader = await unrouted.load('lib/owner-queue.mjs');
  const [, own] = RETRO_DRAFTS;
  const plain = Object.fromEntries(Object.entries(own).filter(([name]) => name !== 'workstream'));
  const pick = async (draft) => {
    const model = retroModel([draft]);
    const readers = { ...modelReaders(model), tracker: 'github', login: 'owner' };
    const version = reader.collect({ ...readers, hostname: HOST, executor: actExec(model).exec }).items.find((item) => item.card === RETRO).version;
    const { exec, writes } = actExec(model);
    try {
      await reader.act({ ...readers, executor: exec, output: { log: () => {}, error: () => {} }, card: RETRO, action: 'pick', proposal: 2, version });
      return { writes };
    } catch (error) {
      return { writes, refused: error.message };
    }
  };
  assert.deepEqual(await pick(plain), { writes: [
    { args: ['issue', 'create', '--repo', BOARD_SLUG, '--title', own.title, '--body-file', '<file>', '--label', own.label], text: pickedCard(plain) },
    { board: { card: 900, added: true } },
    { board: { card: 900, field: 'Status', value: 'Backlog' } },
    pickedLine(2, 900, BOARD_SLUG),
  ] }, 'a draft with no routing value is filed and placed with a column alone');
  assert.deepEqual(await pick(own), { writes: [], refused: 'proposal 2\'s routing value is not one this board takes: answer in chat' });
});

test('the act command takes a proposal for a pick and for no other action, refusing any other shape with exit 2 before any read', () => {
  const hex = 'c'.repeat(64);
  const shapes = [
    ['act', '--card=60', '--action=pick', `--version=${hex}`],
    ['act', '--card=60', '--action=pick', `--version=${hex}`, '--proposal=0'],
    ['act', '--card=60', '--action=pick', `--version=${hex}`, '--proposal=one'],
    ['act', '--card=60', '--action=keep', `--version=${hex}`, '--proposal=1'],
    ['act', '--card=60', '--action=answer', `--version=${hex}`, '--reply=yes', '--proposal=1'],
  ];
  const entered = shapes.map((args) => {
    const logged = [];
    const errors = [];
    const code = readerMain(args, { log: (line) => logged.push(line), error: (line) => errors.push(line) });
    return { args, code, errors, logged };
  });
  assert.deepEqual(entered, shapes.map((args) => ({ args, code: 2, errors: [READER_USAGE], logged: [] })));
});

const MERGE = '5d41402abc4b2a76b9719d911017c592ae2f9b1e';
const MERGE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FIRST_PARENT = '7c4a8d09ca3762af61e59520943dc26494f8941b';
const OTHER_MERGE = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const FETCHED_MAIN = 'de9f2c7fd25e1b3afad3e85a0bd17d9b100db4b3';
const PULL = 812;
const PULL_TITLE = 'Each merged line opens its report';
const PULL_URL = `https://github.com/${BOARD_SLUG}/pull/${PULL}`;
const MERGED_CARD = 801;
const MERGED_CARD_TITLE = 'Merged work shows its report';
const OPENED = '2026-11-14T09:00:00Z';
const MERGED_AT = '2026-11-14T12:00:00Z';
const CLAIM = { body: 'Claim: machine-a, Claude Code, 2026-11-14T08:00Z', createdAt: '2026-11-14T08:00:00Z' };
const levelText = (level) => JSON.stringify({ version: 1, waitForOwner: level });

const CHECK_LINES = ['Passed: lint and the script suite on the final commit; the focused tests of every slice.', 'Failed: none', 'Untested: none'];
const RISK_LINES = ['Undo: easy. A later release corrects a wrong shared file.', 'Reach: wide. Every adopter running Herdr receives it.'];

// Screenshot k: its alt text as the deliver step writes it, its markdown image in the body, the signed address GitHub's
// bodyHTML gives its `<img>` on `host`, and that `<img>` with its attributes in either order.
const shotAlt = (k) => `screenshot-${k} ${createHash('sha1').update(`synthetic screenshot ${k}`).digest('hex')}`;
const shotUuid = (k) => `0b5e1a2c-4d3f-4e6a-9b7c-${String(k).padStart(12, '0')}`;
const shotImage = (k) => `![${shotAlt(k)}](https://github.com/user-attachments/assets/${shotUuid(k)})`;
const shotSrc = (k, host = 'private-user-images.githubusercontent.com') => `https://${host}/90001/41700${k}-${shotUuid(k)}.png?jwt=FAKE.signed.${k}`;
const imgTag = (alt, src, altFirst = false) => `<p><a target="_blank" rel="noopener noreferrer" href="${src}">${altFirst
  ? `<img alt="${alt}" src="${src}" style="max-width: 100%;">` : `<img src="${src}" alt="${alt}" style="max-width: 100%;">`}</a></p>`;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('first screenshot')]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('second screenshot')]);
// A download's reply, made afresh for each fetch.
const imageReply = (bytes, type) => () => new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });

// The three Decision card shapes, each with block 1, a screenshot block, a yes, the risk and the check lines.
const LABELLED_CHANGED = 'Opening a merged line shows what it changed and why it did not wait.\n\nPicked: the side sheet the Floor already uses.';
const LABELLED_OPENING = `**What changes for you:** ${LABELLED_CHANGED}`;
const labelledCard = (screenshot = 'screenshots under Evidence') => [
  '<!-- Block 1: the Summary\'s opening sentences. -->',
  '',
  LABELLED_OPENING,
  '',
  `**Screenshot:** ${screenshot}`,
  '',
  '**What a yes accepts:** Nothing',
  '',
  '**Risk:**',
  ...RISK_LINES,
  '',
  '**Checks:**',
  ...CHECK_LINES,
].join('\n');
const HEADING_CHANGED = 'Each merged line in the queue panel opens a report of what it changed and why it did not wait.';
const headingCard = (screenshot = ['no visual change']) => [
  '**What changes**', '', HEADING_CHANGED, '',
  '**Screenshot**', '', ...screenshot.flatMap((line) => [line, '']),
  '**What a yes accepts**', '', '- Nothing beyond the card.', '',
  '**Risk**', '', ...RISK_LINES, '',
  '**Checks**', '', ...CHECK_LINES,
].join('\n');
const UNLABELLED_CHANGED = 'A merged line on the Floor opens its report.\nThe report names its pull request.';
const unlabelledCard = () => [
  UNLABELLED_CHANGED, '',
  'Screenshots: none, the work has no visual change.', '',
  'What a yes accepts:', '- Nothing beyond the card.', '',
  ...RISK_LINES, '',
  ...CHECK_LINES,
].join('\n');

// A merged pull request's body as the pull request template lays it out, its Evidence holding `evidence` and its
// Decision card `decision` (none where it is null), with a settled review. `undo` false leaves out every Undo: line
// outside the Decision card.
function pullBody({ decision, evidence = ['No visual change.'], undo = true }) {
  return [
    '## Summary', '', 'Each merged line opens its report.', '', `Closes #${MERGED_CARD}`, '',
    '## Not done', '', 'Nothing', '',
    '## Merge Danger', '', ...(undo ? RISK_LINES : RISK_LINES.slice(1)), '',
    '## Evidence', '', ...evidence.flatMap((line) => [line, '']), ...CHECK_LINES, '',
    ...(decision === null ? [] : ['<details>', '', '<summary>Decision card</summary>', '', decision, '', '</details>', '']),
    '## Review', '', 'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0', '',
  ].join('\n');
}

// A pull request as GitHub's associatedPullRequests lists it, merged by default into `main` as MERGE, closing card
// `closes` titled `closesTitle`.
const pullNode = ({ number = PULL, oid = MERGE, merged = true, body, bodyHTML = '', closes = MERGED_CARD, closesTitle = MERGED_CARD_TITLE }) => ({
  number, title: PULL_TITLE, url: `https://github.com/${BOARD_SLUG}/pull/${number}`, body, bodyHTML,
  createdAt: OPENED, mergedAt: merged ? MERGED_AT : null, merged, baseRefName: 'main', mergeCommit: merged ? { oid } : null,
  closingIssuesReferences: { nodes: [{ number: closes, title: closesTitle }] },
});

// The pull requests GitHub associates with MERGE: an earlier one merged as another commit and an open one, listed ahead
// of the one MERGE merged, which has `body` and `bodyHTML`.
const associated = (body, bodyHTML = '') => [
  pullNode({ number: 790, oid: OTHER_MERGE, body: pullBody({ decision: unlabelledCard() }) }),
  pullNode({ number: 811, merged: false, body: pullBody({ decision: unlabelledCard() }) }),
  pullNode({ body, bodyHTML }),
];

// The GraphQL reply of the associated pull request read: `nodes` where the query names the commit, no commit otherwise.
const pullsRead = (repositoryId, nodes, named = true) => ({ data: { repository: {
  id: repositoryId, nameWithOwner: BOARD_SLUG, defaultBranchRef: { name: 'main' }, object: named ? { associatedPullRequests: { nodes } } : null,
} } });

// readCard's reply for card `number`: its `comments` ({ body, createdAt }) by `owner`, unedited, and its `labels`.
const cardRead = (repositoryId, number, title, comments, labels = []) => ({ data: { viewer: { login: 'owner' }, repository: { id: repositoryId, issue: {
  state: 'CLOSED', title, body: `Scope of card ${number}.`, lastEditedAt: null,
  comments: { pageInfo: { hasNextPage: false }, nodes: comments.map(({ body, createdAt }, at) => ({
    author: { login: 'owner' }, editor: null, createdAt, lastEditedAt: null, url: commentUrl(number, 4000 + at), body,
  })) },
  labels: { pageInfo: { hasNextPage: false }, nodes: labels.map((name) => ({ name })) },
} } } });

// The GraphQL reply of a card's label history: its label `events` ({ __typename, createdAt, label }), oldest first as
// GitHub's timeline lists them, on one page with no earlier page.
const labelHistory = (repositoryId, events) => ({ data: { repository: { id: repositoryId, issue: {
  timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: events },
} } } });

const PULL_FAILURE = 'gh: HTTP 502 Bad Gateway on the pull request read';
const CARD_FAILURE = 'gh: HTTP 504 Gateway Timeout on the card read';

// The gh `report` reads through, each call recorded: the board repository as configuredRepository reads it, the pull
// requests associated with a commit, card MERGED_CARD's read and its label history, which holds `events`. `fail` names
// the read that fails with gh's text.
function reportExec({ nodes, comments, labels, events = [], fail }) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const call = args.join(' ');
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (call === `repo view ${BOARD_SLUG} --json id,nameWithOwner`) return JSON.stringify({ id: 'R_report', nameWithOwner: BOARD_SLUG });
    if (query.includes('associatedPullRequests')) {
      if (fail === 'pull') throw new Error(PULL_FAILURE);
      return JSON.stringify(pullsRead('R_report', nodes, args.some((arg) => arg.includes(MERGE))));
    }
    if (query.includes('comments(first: 100)')) {
      if (fail === 'card') throw new Error(CARD_FAILURE);
      assert.ok(args.includes(`number=${MERGED_CARD}`), `unexpected card read: ${call}`);
      return JSON.stringify(cardRead('R_report', MERGED_CARD, MERGED_CARD_TITLE, comments, labels));
    }
    if (query.includes('timelineItems')) {
      if (fail === 'history') return 'not json';
      return JSON.stringify(labelHistory('R_report', events));
    }
    throw new Error(`unexpected gh ${call}`);
  };
  return { exec, calls };
}

// A git where fetched main's settings file holds `fetchedText` and the merge's first parent's holds `parentText`, or
// none where it is undefined. It answers readWaitLevel's three reads at fetched main, and the same reads at the first
// parent however git is asked to name it: `<merge>^`, `<merge>^1`, `<merge>~1` or its sha.
function mergeGit({ parentText, fetchedText }) {
  const fetched = settingsGit({ settingOid: FETCHED_MAIN, settingText: fetchedText });
  const settings = '.agents/factory-settings.json';
  const names = [`${MERGE}^`, `${MERGE}^1`, `${MERGE}~1`, FIRST_PARENT];
  return (args) => {
    const command = JSON.stringify(args);
    for (const name of names) {
      if (command === JSON.stringify(['rev-parse', '--verify', '--quiet', `${name}^{commit}`])) return `${FIRST_PARENT}\n`;
      if (command === JSON.stringify(['ls-tree', '--full-tree', '--format=%(objectmode)', name, '--', settings])) return parentText === undefined ? '' : '100644\n';
      if (command === JSON.stringify(['show', `${name}:${settings}`]) && parentText !== undefined) return parentText;
    }
    return fetched(args);
  };
}

const WHEN_NEEDED_AT_PARENT = mergeGit({ parentText: levelText('when-needed'), fetchedText: levelText('on-screen') });

// The merge's report, read with the level when-needed at its first parent and on-screen on fetched main unless `git`
// says otherwise, the card's label history holding no event unless `events` says otherwise, and `shots` answering the
// downloads by address: the report, the gh calls, the addresses fetched and the `redirect` and `signal` each download was
// made with.
// `alter` is `[query, change]`: the reply to each gh call whose query holds `query` is parsed and its repository edited by
// `change` before the report reads it.
async function reporting({ nodes, comments = [CLAIM], labels = [], events, fail, shots = {}, tracker = 'github', git = WHEN_NEEDED_AT_PARENT, alter }) {
  const { exec: read, calls } = reportExec({ nodes, comments, labels, events, fail });
  const exec = alter === undefined ? read : (args) => {
    const reply = read(args);
    if (!args.some((arg) => arg.startsWith('query=') && arg.includes(alter[0]))) return reply;
    const parsed = JSON.parse(reply);
    alter[1](parsed.data.repository);
    return JSON.stringify(parsed);
  };
  const fetched = [];
  const settings = [];
  const fetch = async (url, init) => {
    fetched.push(String(url));
    settings.push({ redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
    const reply = shots[String(url)];
    if (reply === undefined) throw new Error('unexpected download');
    return reply();
  };
  const document = await report({ sha: MERGE, executor: exec, run: git, fetch, tracker });
  return { document, calls, fetched, settings };
}

// A merge that shows its work: the Evidence shows screenshots 1 and 2, the second `<img>` writing alt before src, and
// the heading-paragraph Decision card repeats screenshot 1, whose repeat GitHub signs at another address.
const REPEAT_SRC = shotSrc(1).replace('FAKE.signed.1', 'FAKE.signed.1.repeat');
const ON_SCREEN_BODY = pullBody({ decision: headingCard([shotImage(1)]), evidence: [shotImage(1), shotImage(2)] });
const ON_SCREEN_HTML = ['<h2>Evidence</h2>', imgTag(shotAlt(1), shotSrc(1)), imgTag(shotAlt(2), shotSrc(2), true),
  '<details><summary>Decision card</summary>', imgTag(shotAlt(1), REPEAT_SRC), '</details>'].join('\n');
const ON_SCREEN_SHOTS = { [shotSrc(1)]: imageReply(PNG, 'image/png'), [shotSrc(2)]: imageReply(JPEG, 'image/jpeg') };

// The outcome fields a report carries, each only where it carries it.
const outcomeFields = (document) => Object.fromEntries(['outcome', 'level', 'waiting', 'holds', 'cause', 'lasting'].filter((key) => key in document).map((key) => [key, document[key]]));

test('the report of a merge that did not wait says what changed, why nothing needed the owner and carries its screenshots', async () => {
  const { document, fetched, settings } = await reporting({ nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS });

  assert.deepEqual(document, {
    format: 1,
    sha: MERGE,
    pull: { number: PULL, title: PULL_TITLE, url: PULL_URL },
    card: { number: MERGED_CARD, title: MERGED_CARD_TITLE },
    changed: HEADING_CHANGED,
    checks: CHECK_LINES,
    noScreen: false,
    outcome: 'nothing',
    level: 'when-needed',
    screenshots: [
      { alt: shotAlt(1), type: 'png', data: PNG.toString('base64') },
      { alt: shotAlt(2), type: 'jpeg', data: JPEG.toString('base64') },
    ],
  });
  assert.deepEqual(fetched.sort(), [shotSrc(1), shotSrc(2)].sort(), 'each screenshot is downloaded once, from its first <img>');
  assert.deepEqual(settings, fetched.map(() => ({ redirect: 'manual', signal: true })), 'each download follows no redirect itself and carries a timeout signal');
});

test('the report names why a merge waited, or that its record does not add up', async () => {
  const fetchedWhenNeeded = (parentText) => mergeGit({ parentText, fetchedText: levelText('when-needed') });
  // Each row: what differs from the merge of the test above (the card's comments, its labels or the git) and the
  // outcome fields its report carries. A waiting record counts only from the card's newest claim before the merge (or from
  // the pull request opening where the card has no claim) up to the merge, and the newest one's first line is quoted; the
  // level is read at the merge's first parent.
  const rows = [
    ['waited', {
      comments: [
        CLAIM,
        { body: 'Waiting for you: check', createdAt: '2026-11-14T08:30:00Z' },
        { body: 'Waiting for you: screenshot', createdAt: '2026-11-14T10:00:00Z' },
        { body: 'Waiting for you: on-screen; show-me-first\nThe owner sees the sheet first.', createdAt: '2026-11-14T11:00:00Z' },
        { body: 'Waiting for you: hard-to-undo', createdAt: '2026-11-14T13:00:00Z' },
      ],
    }, { outcome: 'waited', waiting: 'Waiting for you: on-screen; show-me-first' }],
    ['on-screen at the first parent, marked show me first', {
      comments: [{ body: 'Waiting for you: check', createdAt: '2026-11-14T07:30:00Z' }, CLAIM],
      labels: ['show-me-first'],
      git: fetchedWhenNeeded(levelText('on-screen')),
    }, { outcome: 'disagrees', level: 'on-screen', holds: ['on-screen', 'show-me-first'] }],
    ['no settings file at the first parent', { git: fetchedWhenNeeded(undefined) },
      { outcome: 'unread', cause: 'this merge\'s route cannot be read: a Herdr job merges past every card waits for you: waitForOwner is always, other routes wait for them', lasting: true }],
  ];
  const observed = [];
  for (const [row, given] of rows) {
    const { document } = await reporting({ nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, ...given });
    observed.push({ row, ...outcomeFields(document) });
  }
  assert.deepEqual(observed, rows.map(([row, , fields]) => ({ row, ...fields })));
});

// The report cannot tell which route a merge took, so a hold only the route decides is unread, never a disagreement.
test('967 a merge report says when only its route decides', async () => {
  const reviewed = `Reviewed commit: ${FIRST_PARENT}`;
  const clean = pullBody({ decision: headingCard(), evidence: ['No visual change.', reviewed] });
  const outcomeAt = async (level, body) => outcomeFields((await reporting({ nodes: associated(body), git: mergeGit({ parentText: levelText(level), fetchedText: levelText(level) }) })).document);

  assert.deepEqual(await outcomeAt('always', clean.replace('tier=code', 'tier=sign-off')), {
    outcome: 'unread',
    cause: 'this merge\'s route cannot be read: a Herdr job merges past sign-off, every card waits for you: waitForOwner is always, other routes wait for them',
    lasting: true,
  });
  const failing = clean.replaceAll('Failed: none', 'Failed: the lint step');
  assert.deepEqual(await outcomeAt('when-needed', failing), { outcome: 'disagrees', level: 'when-needed', holds: ['check'] });
  assert.deepEqual(await outcomeAt('when-needed', clean), { outcome: 'nothing', level: 'when-needed' });
});

// The workflow posts `Waiting for you:` at push, which can be before the draft pull request opens (OPENED is 09:00).
const waitingAt = (line, createdAt) => ({ body: line, createdAt });
const outcomeOf = async (comments) => outcomeFields((await reporting({ nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, comments })).document);

test('a waiting record posted after the newest claim and before the pull request opened is the merge\'s waiting record', async () => {
  const comments = [CLAIM, waitingAt('Waiting for you: check; beyond-card', '2026-11-14T08:49:00Z'), { body: 'Owner answer: Yes', createdAt: '2026-11-14T08:50:00Z' }];
  assert.deepEqual(await outcomeOf(comments), { outcome: 'waited', waiting: 'Waiting for you: check; beyond-card' });
});

test('a waiting record from an earlier job, before the newest claim, is not counted', async () => {
  // The earlier job posted it after its own claim and before the newest one.
  const comments = [{ body: 'Claim: machine-b, Codex, 2026-11-13T06:00Z', createdAt: '2026-11-13T06:00:00Z' },
    waitingAt('Waiting for you: check', '2026-11-13T07:00:00Z'), CLAIM];
  assert.deepEqual(await outcomeOf(comments), { outcome: 'nothing', level: 'when-needed' });
});

test('with no claim comment, a waiting record posted before the pull request opened is not counted', async () => {
  assert.deepEqual(await outcomeOf([waitingAt('Waiting for you: check', '2026-11-14T08:30:00Z')]), { outcome: 'nothing', level: 'when-needed' });
});

// A card can be claimed again after a merge, and that later claim opens no window for this merge.
test('a claim made after the merge does not hide that merge\'s waiting record', async () => {
  const comments = [CLAIM, waitingAt('Waiting for you: check; beyond-card', '2026-11-14T08:49:00Z'),
    { body: 'Claim: machine-b, Codex, 2026-11-14T13:00Z', createdAt: '2026-11-14T13:00:00Z' }];
  assert.deepEqual(await outcomeOf(comments), { outcome: 'waited', waiting: 'Waiting for you: check; beyond-card' });
});

test('a report it cannot read says why, and a screenshot it cannot fetch names its cause without its address', async () => {
  // Every message and report this test reads, none of which may hold a signed address.
  const printed = [];
  // No merged pull request has the merge commit: an earlier merge and an open pull request only.
  const direct = await reporting({ nodes: associated(ON_SCREEN_BODY).slice(0, 2) });
  assert.deepEqual(direct.document, { format: 1, sha: MERGE, direct: true });

  // A pull request read that fails is refused with gh's cause.
  const { exec } = reportExec({ fail: 'pull' });
  const noDownload = async () => {
    throw new Error('unexpected download');
  };
  await assert.rejects(report({ sha: MERGE, executor: exec, run: WHEN_NEEDED_AT_PARENT, fetch: noDownload, tracker: 'github' }), (error) => {
    printed.push(error.message);
    return error.message.includes(PULL_FAILURE);
  });

  // A card read that fails, a write-up the judge refuses and a tracker that is not GitHub each leave the outcome unread;
  // only the last, which no later read changes, is `lasting`.
  const noUndo = pullBody({ decision: unlabelledCard().replace(`${RISK_LINES[0]}\n`, ''), undo: false });
  const unread = [];
  for (const given of [
    { nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, fail: 'card' },
    { nodes: associated(noUndo) },
    { nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, tracker: 'linear' },
  ]) {
    const { document, calls } = await reporting(given);
    printed.push(JSON.stringify(document));
    unread.push({ document, cardRead: calls.some((args) => args.some((arg) => arg.includes('comments(first: 100)'))) });
  }
  const [cardFails, refused, linear] = unread;
  assert.ok(String(cardFails.document.card?.unread).includes(CARD_FAILURE), JSON.stringify(cardFails.document.card));
  assert.deepEqual(Object.keys(outcomeFields(cardFails.document)).sort(), ['cause', 'outcome']);
  assert.equal(cardFails.document.outcome, 'unread');
  assert.ok(String(cardFails.document.cause).includes(CARD_FAILURE), cardFails.document.cause);
  assert.deepEqual(outcomeFields(refused.document), { outcome: 'unread', cause: `pull request #${PULL} has no Undo: line` });
  assert.ok(typeof linear.document.card?.unread === 'string' && linear.document.card.unread !== '', JSON.stringify(linear.document.card));
  assert.deepEqual(outcomeFields(linear.document),
    { outcome: 'unread', cause: 'this project\'s cards are not GitHub issues, so its waiting record cannot be read', lasting: true });
  assert.equal(linear.cardRead, false, 'no card is read on a tracker that is not GitHub');

  // Screenshot 1 downloads; 2 is on a host off the list, 3 is 9 MiB, 4 is a web page and 5's download fails naming its
  // address.
  const hostile = pullBody({ decision: headingCard(), evidence: [1, 2, 3, 4, 5].map(shotImage) });
  const offList = shotSrc(2, 'private-user-images.githubusercontent.com.example.net');
  const hostileHtml = [imgTag(shotAlt(1), shotSrc(1)), imgTag(shotAlt(2), offList), imgTag(shotAlt(3), shotSrc(3)),
    imgTag(shotAlt(4), shotSrc(4)), imgTag(shotAlt(5), shotSrc(5))].join('\n');
  const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
  const { document, fetched } = await reporting({ nodes: associated(hostile, hostileHtml), shots: {
    [shotSrc(1)]: imageReply(PNG, 'image/png'),
    [offList]: imageReply(PNG, 'image/png'),
    [shotSrc(3)]: imageReply(huge, 'image/png'),
    [shotSrc(4)]: imageReply(Buffer.from('<!doctype html><title>Sign in</title>'), 'text/html; charset=utf-8'),
    [shotSrc(5)]: () => Promise.reject(new TypeError(`fetch failed: ${shotSrc(5)}`)),
  } });
  printed.push(JSON.stringify(document));
  assert.deepEqual(fetched.sort(), [shotSrc(1), shotSrc(3), shotSrc(4), shotSrc(5)].sort(), 'a host off the list is never fetched');
  assert.deepEqual(document.screenshots[0], { alt: shotAlt(1), type: 'png', data: PNG.toString('base64') });
  const failed = document.screenshots.slice(1);
  assert.deepEqual(failed.map((shot) => ({ alt: shot.alt, keys: Object.keys(shot).sort(), oneLine: /^[^\r\n]+$/.test(String(shot.unread)) })),
    [2, 3, 4, 5].map((k) => ({ alt: shotAlt(k), keys: ['alt', 'unread'], oneLine: true })));
  assert.equal(new Set(failed.map((shot) => shot.unread)).size, 4, `each failure names its own cause: ${JSON.stringify(failed)}`);

  for (const text of printed) {
    assert.ok(!text.includes('jwt'), `a signed address leaked: ${text}`);
    for (const src of [shotSrc(1), offList, shotSrc(3), shotSrc(4), shotSrc(5), REPEAT_SRC]) assert.ok(!text.includes(src), `an address leaked: ${text}`);
  }
});

test('the reader\'s report command takes one commit, prints its report and refuses any other shape', async (t) => {
  const wire = wireRepository(t);
  const title = 'A wire merge';
  const body = pullBody({ decision: labelledCard('no visual change') });
  wire.merged(pullsRead('R_wire', [pullNode({ body, closes: wire.number, closesTitle: title })]),
    cardRead('R_wire', wire.number, title, [CLAIM, { body: 'Waiting for you: check', createdAt: '2026-11-14T10:00:00Z' }]));

  const read = wire.reader('report', `--sha=${MERGE}`);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), {
    format: 1,
    sha: MERGE,
    pull: { number: PULL, title: PULL_TITLE, url: PULL_URL },
    card: { number: wire.number, title },
    changed: LABELLED_CHANGED,
    checks: CHECK_LINES,
    noScreen: true,
    outcome: 'waited',
    waiting: 'Waiting for you: check',
    screenshots: [],
  });
  const direct = wire.reader('report', `--sha=${MERGE_SHA256}`);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), { format: 1, sha: MERGE_SHA256, direct: true });
  assert.deepEqual(wire.writes(), []);

  // Any other shape is refused with the usage line and exit 2, before any read.
  const shapes = [
    ['report'],
    ['report', `--sha=${MERGE.slice(1)}`],
    ['report', `--sha=${MERGE}a`],
    ['report', `--sha=${MERGE.toUpperCase()}`],
    ['report', `--sha=${'g'.repeat(40)}`],
    ['report', `--sha=${MERGE}`, `--card=${MERGED_CARD}`],
    ['report', `--sha=${MERGE}`, 'extra'],
    ['report', MERGE],
  ];
  const entered = [];
  for (const args of shapes) {
    const logged = [];
    const errors = [];
    const code = await readerMain(args, { log: (line) => logged.push(line), error: (line) => errors.push(line) });
    entered.push({ args, code, usage: errors.length === 1 && errors[0].startsWith('usage: node scripts/owner-queue.mjs '), logged });
  }
  assert.deepEqual(entered, shapes.map((args) => ({ args, code: 2, usage: true, logged: [] })));
});

test('the report reads what changed and its checks from each decision card shape', async () => {
  const noCard = { unread: `pull request #${PULL} has no decision card` };
  const noSummary = { unread: `pull request #${PULL}'s decision card opens with no summary` };
  // Each row: the Decision card (null for none), and what the report reads from it.
  const rows = [
    ['labelled', labelledCard('no visual change'), { changed: LABELLED_CHANGED, checks: CHECK_LINES }],
    ['heading paragraphs', headingCard(), { changed: HEADING_CHANGED, checks: CHECK_LINES }],
    ['unlabelled', unlabelledCard(), { changed: UNLABELLED_CHANGED, checks: CHECK_LINES }],
    ['no decision card', null, { changed: noCard, checks: noCard }],
    ['opens with a later block', labelledCard('no visual change').replace(`${LABELLED_OPENING}\n\n`, ''), { changed: noSummary, checks: CHECK_LINES }],
    ['opens with an empty label', labelledCard('no visual change').replace(LABELLED_OPENING, '**What changes for you:**'), { changed: noSummary, checks: CHECK_LINES }],
    ['no Untested: line', unlabelledCard().replace('\nUntested: none', ''),
      { changed: UNLABELLED_CHANGED, checks: { unread: `pull request #${PULL}'s decision card has no Untested: line` } }],
  ];
  const observed = [];
  for (const [row, decision] of rows) {
    const { document } = await reporting({ nodes: associated(pullBody({ decision })) });
    observed.push({ row, changed: document.changed, checks: document.checks });
  }
  assert.deepEqual(observed, rows.map(([row, , read]) => ({ row, ...read })));
});

test('the report reads what changed whole where its opening words only begin like a block label', async () => {
  const standard = ['**Screenshot:** no visual change', '', '**What a yes accepts:** Nothing', '', '**Risk:**', ...RISK_LINES, '', '**Checks:**', ...CHECK_LINES];
  const card = (opening, after = standard) => [opening, '', ...after].join('\n');
  // Each row: the Decision card and the sentence the report reads as what changed.
  const rows = [
    ['opening words that begin Checks', card('Checksums now protect downloads.'), 'Checksums now protect downloads.'],
    ['opening words that begin Risk', card('Risky downloads are refused.'), 'Risky downloads are refused.'],
    ['opening words that begin What changes', card('What changes after restart is preserved.'), 'What changes after restart is preserved.'],
    ['labelled opening with words that begin Checks', card('**What changes for you:** Checksums now protect downloads.'), 'Checksums now protect downloads.'],
    ['bold Risk label ends the first block', card('Each merged line opens its report.', ['**Risk:**', ...RISK_LINES, '', ...CHECK_LINES]), 'Each merged line opens its report.'],
    ['bare Undo line ends the first block', card('Each merged line opens its report.', [...RISK_LINES, '', ...CHECK_LINES]), 'Each merged line opens its report.'],
    ['bare Passed line ends the first block', card('Each merged line opens its report.', CHECK_LINES), 'Each merged line opens its report.'],
  ];
  const observed = [];
  for (const [row, decision] of rows) {
    const { document } = await reporting({ nodes: associated(pullBody({ decision })) });
    observed.push({ row, changed: document.changed });
  }
  assert.deepEqual(observed, rows.map(([row, , changed]) => ({ row, changed })));
});

test('a summary holding an image is shown as plain text as written, and an ordinary link stays markdown', async () => {
  const link = '[preview](https://example.com/a)';
  const standard = ['**Screenshot:** no visual change', '', '**What a yes accepts:** Nothing', '', '**Risk:**', ...RISK_LINES, '', '**Checks:**', ...CHECK_LINES];
  // Each row: the opening of the Decision card, which anyone with write access can edit, and what the report reads from it.
  // Plain text loads nothing, so a plain row's text is the opening as written, the image and all.
  const plainRow = (row, opening) => [row, opening, { plain: opening }];
  const rows = [
    plainRow('a markdown image', `Each merged line opens its report ![x](https://attacker.example/p.png?u=1) in the sheet, with a ${link} beside it.`),
    plainRow('an HTML image', `Each merged line opens its report <img src="https://attacker.example/q.png" alt="y"> in the sheet, with a ${link} beside it.`),
    plainRow('a reference image', `Each merged line opens its report ![x][img] in the sheet, with a ${link} beside it.\n\n[img]: https://attacker.example/r.png`),
    plainRow('a collapsed reference image', `Each merged line opens its report ![x][] in the sheet, with a ${link} beside it.\n\n[x]: https://attacker.example/c.png`),
    plainRow('a shortcut reference image', `Each merged line opens its report ![x] in the sheet, with a ${link} beside it.\n\n[x]: https://attacker.example/s.png`),
    plainRow('an HTML image followed by a link', `Each merged line opens its report !<img src="https://example.com/removed.png">[x](https://attacker.example/loaded.png) in the sheet, with a ${link} beside it.`),
    plainRow('a markdown image followed by a link', `Each merged line opens its report !![y](https://example.com/removed.png)[x](https://attacker.example/nested.png) in the sheet, with a ${link} beside it.`),
    plainRow('an HTML image tag spelled image', `Each merged line opens its report <image src="https://attacker.example/i.png"> in the sheet, with a ${link} beside it.`),
    plainRow('an upper-case HTML image tag spelled image', `Each merged line opens its report <IMAGE SRC="https://attacker.example/u.png"> in the sheet, with a ${link} beside it.`),
    plainRow('an HTML image split around another', `Each merged line opens its report <im<img src="https://example.com/removed.png">g src="https://attacker.example/split.png"> in the sheet, with a ${link} beside it.`),
    ['an ordinary link and no image', `Each merged line opens its report in the sheet, with a ${link} beside it.`,
      `Each merged line opens its report in the sheet, with a ${link} beside it.`],
  ];
  const observed = [];
  for (const [row, opening] of rows) {
    const { document } = await reporting({ nodes: associated(pullBody({ decision: [opening, '', ...standard].join('\n') })) });
    observed.push({ row, changed: document.changed });
  }
  assert.deepEqual(observed, rows.map(([row, , changed]) => ({ row, changed })));
});

test('a summary the panel cannot render safely is carried as plain text as written, and an autolink or a less-than sign stays markdown', async () => {
  const noSummary = { unread: `pull request #${PULL}'s decision card opens with no summary` };
  const autolink = 'Each merged line opens its report, as <https://example.com/guide> shows.';
  const lessThan = 'Each merged line opens its report in under 2 s when 3 < 4.';
  const standard = ['**Screenshot:** no visual change', '', '**What a yes accepts:** Nothing', '', '**Risk:**', ...RISK_LINES, '', '**Checks:**', ...CHECK_LINES];
  // Each row: the opening of the Decision card, which anyone with write access can edit, and what the report reads from it.
  // A plain row's text is the opening as written, an image and all, because plain text loads nothing.
  const plainRow = (row, opening, written = opening) => [row, opening, { plain: written }];
  const rows = [
    plainRow('a command with a placeholder in a code span', 'Run `node scripts/board-move.mjs --top <card> <status>` now.'),
    plainRow('an HTML image split by a blank line in a processing instruction', '<?a><img\n\nsrc="https://attacker.example/pi.png"> ?>'),
    plainRow('an HTML image split by a blank line in a pre block', '<pre><img\n\nsrc="https://attacker.example/pre.png"></pre>'),
    plainRow('an HTML image split by a blank line in a CDATA section', '<![CDATA[><img\n\nsrc="https://attacker.example/cd2.png"> ]]>'),
    plainRow('an escaped image tag in a pre block', '<pre>&lt;img src="https://attacker.example/ent.png"&gt;</pre>'),
    plainRow('a numerically escaped image tag in a pre block', '<pre>&#60;img src=https://attacker.example/num.png></pre>'),
    plainRow('a line break tag', 'Each merged line opens its report.<br>It names its card.'),
    plainRow('markdown images nested five deep', 'Each merged line opens its report !!!!![a](https://example.com/1.png)[b](https://example.com/2.png)[c](https://example.com/3.png)[d](https://example.com/4.png)[e](https://attacker.example/deep.png) in the sheet.'),
    plainRow('a tag between two backticks that no code span holds', '[a](b`c) <i> `d` e'),
    plainRow('a tag after an escaped backtick', '\\`<b>`'),
    plainRow('code spans over three lines with a tag between them', '``see `a``,\n`<div>`,\n``b` end``'),
    plainRow('a label over a code span holding a placeholder', '**What changes:** Run `x <card>`.', 'Run `x <card>`.'),
    ['an autolink', autolink, autolink],
    ['a less-than sign in prose', lessThan, lessThan],
    plainRow('only an HTML image', '<img src="https://attacker.example/a.png">'),
    plainRow('a sentence naming img tags', 'Strips `<img>` tags from the summary.'),
    plainRow('a sentence naming markdown images', 'Drops `![alt](url)` images.'),
    plainRow('only a markdown image in a code span', '`![alt](url)`'),
    ['an opening image, read as the screenshot block', '![a]', noSummary],
    plainRow('only a file name in angle brackets', '<image.png>'),
    plainRow('a shortcut image in a sentence', 'Shows ![the screenshot] inline.'),
    plainRow('an image label across a line break', 'Shows ![the\nscreenshot](u) inline.'),
    ['only a label', '**What changes:**', noSummary],
  ];
  const observed = [];
  for (const [row, opening] of rows) {
    const { document } = await reporting({ nodes: associated(pullBody({ decision: [opening, '', ...standard].join('\n') })) });
    observed.push({ row, changed: document.changed });
  }
  assert.deepEqual(observed, rows.map(([row, , changed]) => ({ row, changed })));
});

// The reader's screenshot and pull request safeguards. A redirect, a stream and a failure are made by the fake fetch; the
// altered gh replies are those `reporting` edits through its `alter`.
const redirectTo = (address) => () => new Response(null, { status: 302, headers: { location: address } });
const uploadAddress = (k, hop) => `https://objects.githubusercontent.com/github-production-user-asset/${k}/${hop}?X-Amz-Signature=FAKE.redirect.${k}.${hop}`;
// The downloads of screenshot k: its address redirects `hops` times through upload addresses, the last answering `last`.
const redirected = (k, hops, last) => ({
  ...Object.fromEntries(Array.from({ length: hops }, (_, hop) => [hop === 0 ? shotSrc(k) : uploadAddress(k, hop), redirectTo(uploadAddress(k, hop + 1))])),
  [uploadAddress(k, hops)]: last,
});
// A PNG download of `megabytes` MiB streamed with no declared length, made afresh for each fetch.
const unsizedReply = (megabytes) => () => {
  let left = megabytes;
  return new Response(new ReadableStream({ pull(controller) {
    if (left-- > 0) controller.enqueue(new Uint8Array(1024 * 1024));
    else controller.close();
  } }), { status: 200, headers: { 'content-type': 'image/png' } });
};
const failedReply = (status, type) => () => new Response('not an image', { status, headers: { 'content-type': type } });
const screenshotBody = (count) => ({
  body: pullBody({ decision: headingCard(), evidence: Array.from({ length: count }, (_, at) => shotImage(at + 1)) }),
  html: Array.from({ length: count }, (_, at) => imgTag(shotAlt(at + 1), shotSrc(at + 1))).join('\n'),
});
// Asserts that no text holds a signed address: a signed query, or any of `addresses`.
function assertNoAddress(printed, addresses) {
  for (const text of printed) {
    assert.ok(!/jwt|X-Amz-Signature|FAKE/.test(text), `a signed address leaked: ${text}`);
    for (const address of addresses) assert.ok(!text.includes(address), `an address leaked: ${text}`);
  }
}

test('a screenshot download follows at most three redirects and re-checks the https upload hosts on each hop', async () => {
  const evil = 'https://evil.example.net/steal?token=FAKE.redirect.evil';
  const plain = 'http://objects.githubusercontent.com/github-production-user-asset/4/2?X-Amz-Signature=FAKE.redirect.http';
  const { body, html } = screenshotBody(4);
  // Screenshot 1 redirects three times and downloads; 2 redirects four times; 3 redirects once on the list, then off it;
  // 4 redirects once, then to a plain-http address on the upload host.
  const shots = {
    ...redirected(1, 3, imageReply(PNG, 'image/png')),
    ...redirected(2, 4, imageReply(PNG, 'image/png')),
    ...redirected(3, 1, redirectTo(evil)),
    ...redirected(4, 1, redirectTo(plain)),
  };
  const { document, fetched } = await reporting({ nodes: associated(body, html), shots });

  assert.deepEqual(document.screenshots, [
    { alt: shotAlt(1), type: 'png', data: PNG.toString('base64') },
    { alt: shotAlt(2), unread: 'its download redirects more than 3 times' },
    { alt: shotAlt(3), unread: 'its download redirects off GitHub\'s upload hosts' },
    { alt: shotAlt(4), unread: 'its download redirects off GitHub\'s upload hosts' },
  ]);
  const chain = (k, length) => [shotSrc(k), ...Array.from({ length: length - 1 }, (_, at) => uploadAddress(k, at + 1))];
  assert.deepEqual(fetched.sort(), [...chain(1, 4), ...chain(2, 4), ...chain(3, 2), ...chain(4, 2)].sort(), 'a fourth redirect and a host off the list are never fetched');
  assertNoAddress([JSON.stringify(document)], [evil, plain, ...[1, 2, 3, 4].flatMap((k) => [shotSrc(k), ...[1, 2, 3, 4].map((hop) => uploadAddress(k, hop))])]);
});

test('a screenshot that times out, answers an error, or streams or declares past 8 MiB names its cause without its address', async () => {
  const { body, html } = screenshotBody(6);
  const timeout = () => Promise.reject(new DOMException(`The operation timed out fetching ${shotSrc(1)}`, 'TimeoutError'));
  // Screenshot 6 declares 9 MiB with a small body, so only its declared length is over the cap.
  const { document } = await reporting({ nodes: associated(body, html), shots: {
    [shotSrc(1)]: timeout,
    [shotSrc(2)]: failedReply(403, 'application/xml'),
    [shotSrc(3)]: failedReply(500, 'image/png'),
    [shotSrc(4)]: unsizedReply(9),
    [shotSrc(5)]: unsizedReply(8),
    [shotSrc(6)]: () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) } }),
  } });

  assert.deepEqual(document.screenshots.map(({ alt, unread, type }) => ({ alt, unread, type })), [
    { alt: shotAlt(1), unread: 'its download took over 15 s', type: undefined },
    { alt: shotAlt(2), unread: 'its download answered HTTP 403', type: undefined },
    { alt: shotAlt(3), unread: 'its download answered HTTP 500', type: undefined },
    { alt: shotAlt(4), unread: 'its download is larger than 8 MiB', type: undefined },
    { alt: shotAlt(5), unread: undefined, type: 'png' },
    { alt: shotAlt(6), unread: 'its download is larger than 8 MiB', type: undefined },
  ]);
  assertNoAddress([JSON.stringify(document)], [1, 2, 3, 4, 5, 6].map((k) => shotSrc(k)));
});

test('a report names why it cannot read its card, or refuses a pull request another repository answered', async () => {
  const alter = (change) => ['associatedPullRequests', change];
  const closing = (numbers) => alter((repository) => {
    repository.object.associatedPullRequests.nodes.at(-1).closingIssuesReferences.nodes = numbers.map((number) => ({ number }));
  });
  const labelsOf = (change) => ['comments(first: 100)', (repository) => change(repository.issue)];
  const nodes = associated(ON_SCREEN_BODY, ON_SCREEN_HTML);
  const cardReads = (calls) => calls.some((args) => args.some((arg) => arg.includes('comments(first: 100)')));
  const printed = [];
  // Each row: what the gh replies change, the card the report names, and its outcome fields.
  const rows = [
    ['closes no card', closing([]), { unread: `pull request #${PULL} closes no card` },
      { outcome: 'unread', cause: `pull request #${PULL} closes no card`, lasting: true }, false],
    ['closes two cards', closing([MERGED_CARD, MERGED_CARD + 1]), { unread: `pull request #${PULL} closes more than one card` },
      { outcome: 'unread', cause: `pull request #${PULL} closes more than one card`, lasting: true }, false],
    ['more labels than one read holds', labelsOf((issue) => { issue.labels.pageInfo.hasNextPage = true; }),
      { number: MERGED_CARD, title: MERGED_CARD_TITLE }, { outcome: 'unread', cause: `card ${MERGED_CARD}'s labels cannot all be read` }, true],
    ['no label list', labelsOf((issue) => { issue.labels.nodes = null; }),
      { number: MERGED_CARD, title: MERGED_CARD_TITLE }, { outcome: 'unread', cause: `card ${MERGED_CARD}'s labels cannot all be read` }, true],
    ['no labels at all', labelsOf((issue) => { delete issue.labels; }),
      { number: MERGED_CARD, title: MERGED_CARD_TITLE }, { outcome: 'unread', cause: `card ${MERGED_CARD}'s labels cannot all be read` }, true],
  ];
  const observed = [];
  for (const [row, alterReply] of rows) {
    const { document, calls } = await reporting({ nodes, shots: ON_SCREEN_SHOTS, alter: alterReply });
    printed.push(JSON.stringify(document));
    observed.push({ row, card: document.card, ...outcomeFields(document), cardRead: cardReads(calls) });
  }
  assert.deepEqual(observed, rows.map(([row, , card, fields, cardRead]) => ({ row, card, ...fields, cardRead })));

  // A reply for another repository's id is refused, however well formed its pull request is.
  await assert.rejects(reporting({ nodes, shots: ON_SCREEN_SHOTS, alter: alter((repository) => { repository.id = 'R_other'; }) }), (error) => {
    printed.push(error.message);
    return error.message === `the pull requests of commit ${MERGE} in ${BOARD_SLUG} could not be read`;
  });
  assertNoAddress(printed, [shotSrc(1), shotSrc(2), REPEAT_SRC]);
});

// The deliver step judged the merge by the card's labels at MERGED_AT (12:00), so the report reads them there: today's
// labels with each label event after the merge undone, newest first. An event at or before the merge stands.
const BEFORE_MERGE = '2026-11-14T11:00:00Z';
const AFTER_MERGE = '2026-11-14T13:00:00Z';
const LATER_AFTER_MERGE = '2026-11-14T14:00:00Z';
const labelEvent = (typename, createdAt) => ({ __typename: typename, createdAt, label: { name: 'show-me-first' } });
const added = (createdAt) => labelEvent('LabeledEvent', createdAt);
const removed = (createdAt) => labelEvent('UnlabeledEvent', createdAt);
const timeline = (change) => ['timelineItems', change];
const earlierPages = timeline((repository) => { repository.issue.timelineItems.pageInfo.hasPreviousPage = true; });
const MARKED_AT_MERGE = { outcome: 'disagrees', level: 'when-needed', holds: ['show-me-first'] };
const UNMARKED_AT_MERGE = { outcome: 'nothing', level: 'when-needed' };
// Each row's name and outcome fields, the row's `given` changing the merge of the first report test.
const labelOutcomes = async (rows) => {
  const observed = [];
  for (const [row, given] of rows) {
    const { document } = await reporting({ nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, ...given });
    observed.push({ row, ...outcomeFields(document) });
  }
  return observed;
};

test('a show-me-first label added after the merge does not make a merge that needed nothing disagree', async () => {
  const rows = [['added after the merge', { labels: ['show-me-first'], events: [added(AFTER_MERGE)] }, UNMARKED_AT_MERGE]];
  assert.deepEqual(await labelOutcomes(rows), rows.map(([row, , fields]) => ({ row, ...fields })));
});

test('a show-me-first label removed after the merge disagrees as a card still marked does', async () => {
  const rows = [
    ['still marked', { labels: ['show-me-first'] }, MARKED_AT_MERGE],
    ['removed after the merge', { labels: [], events: [added(BEFORE_MERGE), removed(AFTER_MERGE)] }, MARKED_AT_MERGE],
    ['removed and added again after the merge',
      { labels: ['show-me-first'], events: [added(BEFORE_MERGE), removed(AFTER_MERGE), added(LATER_AFTER_MERGE)] }, MARKED_AT_MERGE],
  ];
  assert.deepEqual(await labelOutcomes(rows), rows.map(([row, , fields]) => ({ row, ...fields })));
});

test('a label event at or before the merge counts as it stands', async () => {
  const rows = [
    ['added before the merge', { labels: ['show-me-first'], events: [added(BEFORE_MERGE)] }, MARKED_AT_MERGE],
    ['added at the merge', { labels: ['show-me-first'], events: [added(MERGED_AT)] }, MARKED_AT_MERGE],
    ['removed at the merge', { labels: [], events: [added(BEFORE_MERGE), removed(MERGED_AT)] }, UNMARKED_AT_MERGE],
    ['earlier pages, with this page reaching back past the merge',
      { labels: ['show-me-first'], events: [added(BEFORE_MERGE)], alter: earlierPages }, MARKED_AT_MERGE],
  ];
  assert.deepEqual(await labelOutcomes(rows), rows.map(([row, , fields]) => ({ row, ...fields })));
});

test('a label history since the merge that cannot all be read leaves the outcome unread, guessing no label', async () => {
  const unread = { outcome: 'unread', cause: `card ${MERGED_CARD}'s label history since the merge cannot all be read` };
  const lastEvent = (change) => timeline((repository) => change(repository.issue.timelineItems.nodes.at(-1)));
  const rows = [
    ['another repository\'s id', { alter: timeline((repository) => { repository.id = 'R_other'; }) }],
    ['no event list', { alter: timeline((repository) => { repository.issue.timelineItems.nodes = null; }) }],
    ['an event of another type', { alter: lastEvent((event) => { event.__typename = 'AssignedEvent'; }) }],
    ['an event with no time', { alter: lastEvent((event) => { delete event.createdAt; }) }],
    ['an event with no label name', { alter: lastEvent((event) => { event.label = null; }) }],
    ['earlier pages, with every event on this page after the merge', { alter: earlierPages }],
    ['page information that is not a yes or no',
      { alter: timeline((repository) => { repository.issue.timelineItems.pageInfo.hasPreviousPage = null; }) }],
    ['a reply that is not JSON', { fail: 'history' }],
  ].map(([row, extra]) => [row, { labels: ['show-me-first'], events: [added(AFTER_MERGE)], ...extra }, unread]);
  assert.deepEqual(await labelOutcomes(rows), rows.map(([row, , fields]) => ({ row, ...fields })));
});

test('only a merge no waiting record answers reads the card\'s label history, once', async () => {
  const historyReads = (calls) => calls.filter((args) => args.some((arg) => arg.startsWith('query=') && arg.includes('timelineItems')))
    .map((args) => args.map((arg) => (arg.startsWith('query=') ? 'query=<label history>' : arg)));
  const given = { nodes: associated(ON_SCREEN_BODY, ON_SCREEN_HTML), shots: ON_SCREEN_SHOTS, labels: ['show-me-first'], events: [added(AFTER_MERGE)] };
  const waited = await reporting({ ...given, comments: [CLAIM, waitingAt('Waiting for you: check', '2026-11-14T10:00:00Z')] });
  const judged = await reporting(given);
  assert.deepEqual({ outcome: waited.document.outcome, reads: historyReads(waited.calls) }, { outcome: 'waited', reads: [] });
  assert.deepEqual(historyReads(judged.calls),
    [['api', 'graphql', '-f', 'query=<label history>', '-f', `owner=${BOARD_OWNER}`, '-f', `name=${BOARD_REPOSITORY}`, '-F', `number=${MERGED_CARD}`]]);
});

// Existing card models supply editor-aware GitHub reads for in-process notification attribution.
test('phone notifications classify only unanswered owner waits', async (t) => {
  const question = (number = 23) => {
    const model = actModel();
    model.cards = { [number]: model.cards[number] };
    return model;
  };
  const review = () => {
    const model = actModel();
    model.cards = { 7: model.cards[7] };
    model.files[join(reviewFolder(7, H7), 'body.md')] = writeUp('A private review decision.', 'Before and after.', proofOf({ failed: 'one required check' }));
    return model;
  };
  const answer = (head = H7, names = ['body.md', 'screenshot-1.png']) => `Owner answer: job/7 at ${head} ${ids(7, head, names)}: yes`;
  const expected = (waits, unavailable = null, login = 'owner') => ({ login, waits, unavailable });
  const q = (card = 23) => [{ card, kind: 'question' }];
  const r = [{ card: 7, kind: 'review' }];
  const readNotifications = (model, { login = 'owner', tracker = 'github', change, fail } = {}) => {
    const { exec } = actExec(model);
    const executor = (args) => {
      if (fail?.(args)) throw new Error('PRIVATE_SOURCE_ERROR_583');
      const reply = exec(args);
      if (!change) return reply;
      const parsed = JSON.parse(reply);
      change(parsed, args);
      return JSON.stringify(parsed);
    };
    return collect({ ...modelReaders(model), tracker, login, hostname: HOST, executor });
  };
  const cardQuery = (args) => args.some((arg) => arg.startsWith('query=') && arg.includes('comments(first: 100)'));
  for (const [name, number] of [['question after a return', 21], ['local job question', 23]]) {
    await t.test(name, () => {
      const document = readNotifications(question(number));
      assert.deepEqual(document.notifications, expected(q(number)));
      assert.equal(document.items.find((item) => item.card === number).category, 'question');
      assert.equal(document.items.find((item) => item.card === number).answerable, undefined,
        'notification attribution keeps the question in chat');
    });
  }
  await t.test('held review', () => {
    const document = readNotifications(review());
    assert.deepEqual(document.notifications, expected(r));
    assert.equal(document.items.find((item) => item.card === 7).category, 'merge');
    assert.ok(document.items.find((item) => item.card === 7).reason.trim(), 'the saved proof actually holds for owner review');
  });
  const cases = [
    ['clear merge does not wait', () => { const model = review(); model.files[join(reviewFolder(7, H7), 'body.md')] = writeUp('Clear.', 'Before and after.'); return model; }, []],
    ['incomplete merge does not wait', () => { const model = review(); delete model.files[join(reviewFolder(7, H7), 'body.md')]; return model; }, []],
    ['matching version is answered', () => { const model = review(); model.cards[7].comments.push(comment(7, 3100, answer())); return model; }, []],
    ['other head is unanswered', () => { const model = review(); model.cards[7].comments.push(comment(7, 3100, answer(H8))); return model; }, r],
    ['other identity is unanswered', () => { const model = review(); model.cards[7].comments.push(comment(7, 3100, answer(H7, ['body.md']))); return model; }, r],
    ['foreign answer is unanswered', () => { const model = review(); model.cards[7].comments.push(comment(7, 3100, answer(), 'someone')); return model; }, r],
    ['quoted answer is unanswered', () => { const model = review(); model.cards[7].comments.push(comment(7, 3100, `Quoted: ${answer()}`)); return model; }, r],
    ['Returned hold is resolved', () => { const model = question(); model.cards[23].comments[1].body = 'Returned: Use blue. Job: job/23 on machine-a.'; return model; }, []],
    ['hold before current claim is excluded', () => { const model = question(); model.cards[23].comments.reverse(); return model; }, []],
    ['two own unresolved holds are unavailable', () => { const model = question(); model.cards[23].comments.push(comment(23, 3233, 'Needs owner: Which colour? Job: job/23 on machine-a.')); return model; }, [], 'ownership-unavailable'],
    ['unscoped hold is excluded', () => { const model = question(); model.cards[23].comments[1].body = 'Needs owner: Which size?'; return model; }, []],
    ['foreign-machine hold is excluded', () => { const model = question(); model.cards[23].comments[1].body = 'Needs owner: Which size? Job: job/23 on machine-b.'; return model; }, []],
    ['foreign-card hold is excluded', () => { const model = question(); model.cards[23].comments[1].body = 'Needs owner: Which size? Job: job/24 on machine-a.'; return model; }, []],
    ['foreign-authored hold is excluded', () => { const model = question(); model.cards[23].comments[1].author.login = 'someone'; return model; }, []],
    ['foreign-account claim is excluded', () => { const model = question(); model.cards[23].comments[0].author.login = 'someone'; return model; }, []],
    ['foreign-machine latest claim is excluded', () => { const model = question(); model.cards[23].comments.push(comment(23, 3234, 'Claim: machine-b, Codex, 2026-11-08T20:00Z')); return model; }, []],
    ['missing claim is unavailable', () => { const model = question(); model.cards[23].comments.shift(); return model; }, [], 'ownership-unavailable'],
    ['malformed latest claim is unavailable', () => { const model = question(); model.cards[23].comments.push(comment(23, 3234, 'Claim:')); return model; }, [], 'ownership-unavailable'],
    ['foreign editor of own claim is unavailable', () => { const model = question(); model.cards[23].comments[0].editor = { login: 'someone' }; return model; }, [], 'ownership-unavailable'],
    ['unknown editor of own hold is unavailable', () => { const model = question(); Object.assign(model.cards[23].comments[1], { lastEditedAt: '2026-11-08T20:00:00Z', editor: null }); return model; }, [], 'ownership-unavailable'],
    ['foreign editor of own hold is unavailable', () => { const model = question(); model.cards[23].comments[1].editor = { login: 'someone' }; return model; }, [], 'ownership-unavailable'],
    ['foreign editor of own answer is unavailable', () => { const model = review(); model.cards[7].comments.push({ ...comment(7, 3100, answer()), editor: { login: 'someone' } }); return model; }, [], 'ownership-unavailable'],
    ['work without an owner wait is excluded', () => { const model = actModel(); model.cards = { 41: model.cards[41] }; return model; }, []],
    ['suggestions are excluded', () => { const model = actModel(); model.cards = { 54: model.cards[54] }; return model; }, []],
    ['a weekly retro is excluded', () => { const model = retroModel(); model.cards = { [RETRO]: model.cards[RETRO] }; return model; }, []],
    ['closed work is excluded', () => { const model = question(); model.cards[23].closed = true; model.cards[99] = { title: 'Plain card', status: 'Ready', body: '', comments: [] }; return model; }, []],
  ];
  for (const [name, make, waits, unavailable = null] of cases) {
    await t.test(name, () => {
      const document = readNotifications(make());
      assert.deepEqual(document.notifications, expected(waits, unavailable));
      assert.equal(JSON.stringify(document.notifications).includes('PRIVATE'), false, 'metadata contains only its fixed safe schema');
    });
  }
  const unavailable = [
    ['missing input login', { login: null }, 'login-unavailable', null],
    ['malformed input login', { login: 'bad login' }, 'login-unavailable', 'bad login'],
    ['viewer differs from input', { login: 'someone' }, 'ownership-unavailable', 'someone'],
    ['viewer absent', { change: (reply) => { if (reply.data?.viewer) delete reply.data.viewer; } }, 'login-unavailable'],
    ['viewer malformed', { change: (reply) => { if (reply.data?.viewer) reply.data.viewer.login = 7; } }, 'login-unavailable'],
    ['attribution unreadable', { fail: cardQuery }, 'source-unavailable'],
    ['board unreadable', { fail: (args) => args.some((arg) => arg.includes('projectV2(')) }, 'source-unavailable'],
    ['details unreadable', { fail: (args) => args.some((arg) => arg.includes('CardDetails')) }, 'source-unavailable'],
    ['unsupported tracker has first priority', { tracker: 'unsupported', login: null, fail: () => true }, 'unsupported-tracker', null],
    ['login has priority over source', { login: null, fail: () => true }, 'login-unavailable', null],
    ['source has priority over ownership', { login: 'someone', fail: (args) => args.some((arg) => arg.includes('CardDetails')) }, 'source-unavailable', 'someone'],
  ];
  for (const [name, options, code, login = 'owner'] of unavailable) {
    await t.test(name, () => {
      const document = readNotifications(question(), options);
      assert.deepEqual(document.notifications, expected([], code, login));
      assert.equal(JSON.stringify(document.notifications).includes('PRIVATE_SOURCE_ERROR_583'), false);
    });
  }
});
