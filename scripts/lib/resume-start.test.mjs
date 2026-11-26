// Tests for resume-start.mjs, resume's fixed opening steps as one command.
//
// Recurring cost: the unit tests run no process; the two `as a process` tests each build a temporary
// origin and clone with real git and spawn the command once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFakeGh } from './fake-gh.mjs';
import { gitExecutable } from './posix-shell.mjs';
import * as boardConfig from './board-config.mjs';
import { RESUME_START_EXIT, RESUME_START_HELP, main } from './resume-start.mjs';
import { trackerOf } from './tracker.mjs';

const TARGET = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const WORKTREES = `worktree /repo\nHEAD ${TARGET}\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/job-9\nHEAD ${OTHER}\nbranch refs/heads/job/9\n`;
const DOCUMENT = 'Board example-owner/2 — 1 pickable card\n#7 A card\nboard intake: end of document, 3 line(s).\n';
const INTAKE_STDERR = 'board: no drift found.\nboard intake: 3 line(s) on stdout.\n';
const PULL_REQUESTS = '[{"number":12,"title":"A draft","headRefName":"job/9","isDraft":true,"url":"https://example.invalid/pull/12"}]\n';
const DRIFT_STDERR = 'board: 1 card(s) drifted.\nboard intake: 3 line(s) on stdout.\n';
const REPOSITORY = 'example-owner/example-repo';
const CONFIG = { BOARD_OWNER: 'example-owner', BOARD_REPOSITORY: 'example-repo' };
const SEARCH_NONE = JSON.stringify([{ total_count: 0, incomplete_results: false, items: [] }]);

// The exact gh arguments of closeout's discovery search and of one card's comment read.
const searchArgs = (repository) => ['api', '-X', 'GET', '--paginate', '--slurp', 'search/issues', '-f', `q=repo:${repository} is:issue in:comments "Cleanup pending"`, '-f', 'per_page=100'];
const commentArgs = (repository, number) => ['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`];
const byText = (left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1);

const FETCH = 'fetch --no-prune origin main';
const TARGET_READ = 'rev-parse refs/remotes/origin/main';
const HEAD_READ = 'rev-parse HEAD';
const BRANCH_READ = 'branch --show-current';
const STATUS_READ = 'status --porcelain';
const WORKTREE_READ = 'worktree list --porcelain';
const TREE_READ = 'rev-parse --path-format=absolute --git-dir --git-common-dir';
const READ_ONLY = new Set([TARGET_READ, HEAD_READ, BRANCH_READ, STATUS_READ, WORKTREE_READ, TREE_READ]);

function outputSink() {
  const sink = { stdout: '', stderr: '' };
  sink.log = (line) => { sink.stdout += `${line}\n`; };
  sink.error = (line) => { sink.stderr += `${line}\n`; };
  return sink;
}

// A clean main checkout at the fetched commit. A test overrides a command's reply: an Error is thrown, and a
// list gives the reply of each successive call, the last one repeating.
const ORDINARY_GIT = {
  [FETCH]: '',
  [TARGET_READ]: `${TARGET}\n`,
  [HEAD_READ]: `${TARGET}\n`,
  [BRANCH_READ]: 'main\n',
  [STATUS_READ]: '',
  [WORKTREE_READ]: WORKTREES,
  [TREE_READ]: '/repo/.git\n/repo/.git\n',
};

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// Runs the command over doubles of every seam and records the order things happened in.
// A cleanup reply is an Error, thrown when the reply is read, or the text gh would print.
/**
 * @param {{ args?: string[], git?: Record<string, string | Error | (string | Error)[]>, intake?: { status: number | null, stdout: string, stderr: string }, pullRequests?: () => string, writeError?: Error, config?: Record<string, unknown>, cleanup?: { search: string | Error, comments: Record<string, string | Error> } }} [options]
 */
async function run({ args = ['scratch'], git = {}, intake = { status: 0, stdout: DOCUMENT, stderr: INTAKE_STDERR }, pullRequests = () => PULL_REQUESTS, writeError, config = CONFIG, cleanup = { search: SEARCH_NONE, comments: {} } } = {}) {
  const replies = { ...ORDINARY_GIT, ...git };
  const seen = {};
  const events = [];
  const gitCalls = [];
  const written = [];
  const cleanupCalls = [];
  const sink = outputSink();
  const status = await main(args, {
    output: sink,
    config,
    git: (gitArgs) => {
      const command = gitArgs.join(' ');
      gitCalls.push(command);
      events.push(`git ${command}`);
      if (!Object.hasOwn(replies, command)) throw new Error(`unexpected git ${command}`);
      seen[command] = (seen[command] ?? 0) + 1;
      const reply = Array.isArray(replies[command]) ? replies[command][Math.min(seen[command], replies[command].length) - 1] : replies[command];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    intake: async (folder) => {
      events.push(`intake start ${folder}`);
      await tick();
      events.push('intake end');
      return intake;
    },
    pullRequests: async () => {
      events.push('pull requests start');
      return pullRequests;
    },
    cleanupRead: async (ghArgs) => {
      events.push('cleanup read');
      cleanupCalls.push(ghArgs);
      const number = /\/issues\/(\d+)\/comments/.exec(ghArgs[3] ?? '')?.[1];
      /** @type {string | Error} */
      let reply = new Error(`unexpected gh ${ghArgs.join(' ')}`);
      if (ghArgs.includes('search/issues')) reply = cleanup.search;
      else if (number !== undefined && Object.hasOwn(cleanup.comments, number)) reply = cleanup.comments[number];
      return () => {
        if (reply instanceof Error) throw reply;
        return reply;
      };
    },
    writeFile: (path, text) => {
      events.push('write');
      if (writeError) throw writeError;
      written.push([path, text]);
    },
  });
  return { status, events, gitCalls, written, cleanupCalls, stdout: sink.stdout, stderr: sink.stderr };
}

const readsStarted = (events) => events.filter((event) => event.startsWith('intake start') || event === 'pull requests start' || event === 'cleanup read');

// What every stop holds: its code, one closing stderr line naming the step, nothing on stdout, only the fetch
// and read-only git commands, and no saved document.
function assertStop(result, code, step) {
  assert.equal(result.status, code, result.stderr);
  const lines = result.stderr.trimEnd().split('\n');
  assert.ok(lines.at(-1).startsWith(`resume-start: stopped at ${step}: `), result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.gitCalls[0], FETCH);
  assert.deepEqual(result.gitCalls.slice(1).filter((command) => !READ_ONLY.has(command)), []);
  assert.deepEqual(result.written, []);
}

const REFUSED_ARGS = {
  'no arguments': [],
  'two folders': ['scratch', 'other'],
  'an empty folder': [''],
  'an unknown flag': ['--intake'],
  'a short flag': ['-x'],
  '--help with a folder': ['--help', 'scratch'],
  'a folder with --help': ['scratch', '--help'],
};

test('resume-start refuses every argument list but one folder or --help before any command', async () => {
  for (const [name, args] of Object.entries(REFUSED_ARGS)) {
    const result = await run({ args });
    assert.equal(result.status, RESUME_START_EXIT.refused, name);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /^resume-start: /, name);
    assert.deepEqual(result.events, [], name);
  }
});

test('resume-start --help prints the usage and runs nothing', async () => {
  const result = await run({ args: ['--help'] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${RESUME_START_HELP}\n`);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.events, []);
});

test('resume-start stops with 10 when the fetch fails', async () => {
  const result = await run({ git: { [FETCH]: new Error('fatal: unable to access origin') } });
  assertStop(result, 10, 'the fetch');
  assert.match(result.stderr, /unable to access origin/);
  assert.deepEqual(result.gitCalls, [FETCH]);
  assert.deepEqual(readsStarted(result.events), []);
});

test('resume-start stops with 11 when an inventory read fails', async () => {
  for (const read of READ_ONLY) {
    const result = await run({ git: { [read]: new Error(`fatal: ${read} failed`) } });
    assertStop(result, 11, 'the local inventory');
    assert.ok(result.stderr.includes(`fatal: ${read} failed`), read);
    assert.deepEqual(readsStarted(result.events), [], read);
  }
});

test('resume-start stops with 12 in a linked worktree', async () => {
  const result = await run({ git: { [TREE_READ]: '/repo/.git/worktrees/job-9\n/repo/.git\n', [BRANCH_READ]: 'job/9\n' } });
  assertStop(result, 12, 'the main checkout');
  assert.match(result.stderr, /linked worktree/);
  assert.deepEqual(readsStarted(result.events), []);
});

test('resume-start stops with 13 when the main checkout is not on main', async () => {
  for (const [branch, named] of [['job/9\n', 'job/9'], ['\n', 'no branch']]) {
    const result = await run({ git: { [BRANCH_READ]: branch } });
    assertStop(result, 13, 'the main checkout');
    assert.ok(result.stderr.includes(named), result.stderr);
    assert.deepEqual(readsStarted(result.events), []);
  }
});

test('resume-start stops with 14 when the main checkout is not at the fetched commit', async () => {
  const result = await run({ git: { [HEAD_READ]: `${OTHER}\n` } });
  assertStop(result, 14, 'the main checkout');
  assert.ok(result.stderr.includes(OTHER) && result.stderr.includes(TARGET), result.stderr);
  assert.deepEqual(readsStarted(result.events), []);
});

test('resume-start stops with 15 when the main checkout has changes', async () => {
  const result = await run({ git: { [STATUS_READ]: ' M AGENTS.md\n?? notes.txt\n' } });
  assertStop(result, 15, 'the main checkout');
  assert.match(result.stderr, /2 changed or untracked path\(s\)/);
  assert.deepEqual(readsStarted(result.events), []);
});

test('resume-start stops with 16 when the board intake fails or is incomplete', async () => {
  for (const status of [1, 2, 4, 5, null]) {
    const result = await run({ intake: { status, stdout: DOCUMENT, stderr: 'board: the board read failed.\n' } });
    assertStop(result, 16, 'the board intake');
    assert.ok(result.stderr.startsWith('board: the board read failed.\n'), result.stderr);
    assert.ok(result.stderr.includes(status === null ? 'did not run' : `exit ${status}`), result.stderr);
  }
});

test('resume-start stops with 17 when the open pull request read fails or returns no list', async () => {
  const failed = await run({ pullRequests: () => { throw new Error('gh: not logged in'); } });
  assertStop(failed, 17, 'the open pull request read');
  assert.match(failed.stderr, /gh: not logged in/);
  for (const reply of ['', 'not json', '{"number":12}', 'null']) {
    assertStop(await run({ pullRequests: () => reply }), 17, 'the open pull request read');
  }
});

test('resume-start stops with 18 when the main checkout moved or changed during the reads', async () => {
  const moved = await run({ git: { [HEAD_READ]: [`${TARGET}\n`, `${OTHER}\n`] } });
  assertStop(moved, 18, 'the closing recheck');
  assert.ok(moved.stderr.includes(OTHER), moved.stderr);
  assert.ok(!moved.events.includes('write'), moved.events.join(', '));
  const changed = await run({ git: { [STATUS_READ]: ['', ' M AGENTS.md\n'] } });
  assertStop(changed, 18, 'the closing recheck');
  assert.ok(!changed.events.includes('write'), changed.events.join(', '));
  // Leaving main without moving HEAD: another branch at the same commit, or a detached HEAD.
  for (const [branchNow, named] of [['job/9\n', 'job/9'], ['\n', 'no branch']]) {
    const left = await run({ git: { [BRANCH_READ]: ['main\n', branchNow] } });
    assertStop(left, 18, 'the closing recheck');
    assert.ok(left.stderr.includes(named), left.stderr);
    assert.ok(!left.events.includes('write'), left.events.join(', '));
  }
  const unread = await run({ git: { [HEAD_READ]: [`${TARGET}\n`, new Error('fatal: not a repository')] } });
  assertStop(unread, 18, 'the closing recheck');
});

test('resume-start stops with 19 when the intake document cannot be saved', async () => {
  const result = await run({ writeError: new Error('EACCES: permission denied') });
  assertStop(result, 19, 'saving the intake document');
  assert.match(result.stderr, /EACCES: permission denied/);
});

test('resume-start in the ordinary case saves the intake document unchanged and reports every step', async () => {
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.status, RESUME_START_EXIT.ordinary);
  assert.deepEqual(result.written, [[join('scratch', 'board-intake.txt'), DOCUMENT]]);
  assert.ok(result.events.includes(`intake start ${join('scratch', 'intake')}`), result.events.join(', '));
  assert.equal(result.gitCalls[0], FETCH);
  assert.deepEqual(result.gitCalls.slice(1).filter((command) => !READ_ONLY.has(command)), []);
  // The recheck follows both reads, and the document is saved only after it.
  assert.deepEqual(result.events.slice(result.events.indexOf('intake end') + 1), [`git ${HEAD_READ}`, `git ${BRANCH_READ}`, `git ${STATUS_READ}`, 'write']);
  for (const part of [
    `fetched commit: ${TARGET}\n`,
    'branch: main\n',
    WORKTREES,
    'main checkout: on main at the fetched commit, no change\n',
    `board intake: exit 0, document ${join('scratch', 'board-intake.txt')}, card files ${join('scratch', 'intake')}\n`,
    INTAKE_STDERR,
    DOCUMENT,
    PULL_REQUESTS,
    'deferred cleanup: complete, 0 card(s) found, 0 pending\n',
    `recheck before saving: on main at HEAD ${TARGET}, no change\n`,
  ]) assert.ok(result.stdout.includes(part), `${JSON.stringify(part)} is missing from:\n${result.stdout}`);
  // The document closes with its own true line count, which stderr repeats for the session's bounded reads.
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), `resume-start: end of document, ${lines.length} line(s).`);
  assert.equal(result.stderr, `resume-start: ${lines.length} line(s) on stdout.\n`);
});

test('resume-start exits 3 in the ordinary case when the intake reports drift', async () => {
  const result = await run({ intake: { status: 3, stdout: DOCUMENT, stderr: DRIFT_STDERR } });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.status, RESUME_START_EXIT.drift);
  assert.deepEqual(result.written, [[join('scratch', 'board-intake.txt'), DOCUMENT]]);
  assert.ok(result.stdout.includes('board intake: exit 3, '), result.stdout);
  assert.ok(result.stdout.includes(DRIFT_STDERR), result.stdout);
});

test('resume-start starts the board intake, the pull request read and the cleanup search together', async () => {
  const { events } = await run();
  const started = events.indexOf('pull requests start');
  assert.ok(started > -1, events.join(', '));
  assert.ok(started < events.indexOf('intake end'), events.join(', '));
  const searched = events.indexOf('cleanup read');
  assert.ok(searched > -1, events.join(', '));
  assert.ok(searched < events.indexOf('intake end'), events.join(', '));
});

const pageOf = (numbers) => ({ total_count: 11, incomplete_results: false, items: numbers.map((number) => ({ number })) });
const comment = (id, body) => ({ id, body });

test('resume-start lists each card with a Cleanup pending comment that no later Cleanup resolved comment links', async () => {
  const result = await run({
    cleanup: {
      search: JSON.stringify([pageOf([19, 11, 20, 12, 18, 21]), pageOf([13, 17, 14, 16, 15, 11])]),
      comments: {
        // Pending, unanswered record.
        11: JSON.stringify([[comment(100, '**Cleanup pending**\nRetained: worktree job-11')]]),
        // Settled: the resolved comment links the record.
        12: JSON.stringify([[comment(100, '## Cleanup pending\nRetained: worktree job-12'), comment(200, '## Cleanup resolved\nSettles example-owner/example-repo/issues/12#issuecomment-100')]]),
        // Pending, no link.
        13: JSON.stringify([[comment(100, '**Cleanup pending**'), comment(200, '**Cleanup resolved**\nEverything removed.')]]),
        // Pending, the link is earlier than the record.
        14: JSON.stringify([[comment(50, '**Cleanup resolved**\nSee #issuecomment-100'), comment(100, '**Cleanup pending**')]]),
        // Settled, the record was edited into the resolved comment.
        15: JSON.stringify([[comment(100, '**Cleanup resolved**\nThis was Cleanup pending for job-15.')]]),
        // Pending, no positive evidence of resolution.
        16: JSON.stringify([[comment(100, 'Merged and closed.')]]),
        // Pending, a record in any letter case.
        17: JSON.stringify([[comment(100, '\n**Trial retired; local CLEANUP PENDING**')]]),
        // Pending, the phrase is past the first line.
        18: JSON.stringify([[comment(100, 'Returned: needs a look\n\nCleanup pending on the old host.')]]),
        // Pending, the link names another comment id.
        19: JSON.stringify([[comment(100, '**Cleanup pending**'), comment(200, '**Cleanup resolved**\n#issuecomment-1001')]]),
        // Settled across two pages.
        20: JSON.stringify([[comment(100, '**Cleanup pending**')], [comment(200, '**Cleanup resolved**\n#issuecomment-100')]]),
        // Pending, a mention of the words is no resolved heading.
        21: JSON.stringify([[comment(100, '## Cleanup pending: no Cleanup resolved receipt yet\nRetained: worktree job-21')]]),
      },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('deferred cleanup: complete, 11 card(s) found, 8 pending\n'), result.stdout);
  assert.ok(result.stdout.includes('deferred cleanup pending: #11 #13 #14 #16 #17 #18 #19 #21\n'), result.stdout);
  assert.ok(!result.stdout.includes('deferred cleanup unread'), result.stdout);
  assert.deepEqual(result.cleanupCalls[0], searchArgs(REPOSITORY));
  const numbers = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  assert.deepEqual(result.cleanupCalls.slice(1).sort(byText), numbers.map((number) => commentArgs(REPOSITORY, number)).sort(byText));
});

const SEARCH_FAILURES = {
  'a thrown error': new Error('gh: HTTP 503'),
  'an empty reply': '',
  'a reply that is no JSON': 'not json',
  'an object reply': '{}',
  'an empty list': '[]',
  'a card number that is a string': JSON.stringify([{ total_count: 1, incomplete_results: false, items: [{ number: '7' }] }]),
  'no incomplete_results flag': JSON.stringify([{ total_count: 1, items: [{ number: 7 }] }]),
};
const ONE_PENDING = { 7: JSON.stringify([[comment(100, '**Cleanup pending**')]]) };

// What every incomplete list holds: still the whole document saved and closed with its own line count.
function assertDocumentKept(result) {
  assert.deepEqual(result.written, [[join('scratch', 'board-intake.txt'), DOCUMENT]]);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), `resume-start: end of document, ${lines.length} line(s).`);
}

test('ANTI-REGRESSION: resume-start reports an incomplete cleanup list as incomplete, never empty, and exits 4 or 5', async () => {
  for (const [name, search] of Object.entries(SEARCH_FAILURES)) {
    const result = await run({ cleanup: { search, comments: ONE_PENDING } });
    assert.equal(result.status, 4, name);
    assert.equal(result.status, RESUME_START_EXIT.cleanupIncomplete, name);
    assert.ok(result.stdout.includes('deferred cleanup: incomplete (the search failed), no card read\n'), `${name}: ${result.stdout}`);
    assert.ok(!result.stdout.includes('deferred cleanup pending'), `${name}: ${result.stdout}`);
    assertDocumentKept(result);
  }
  const flagged = await run({ cleanup: { search: JSON.stringify([{ total_count: 1, incomplete_results: true, items: [{ number: 7 }] }]), comments: ONE_PENDING } });
  assert.equal(flagged.status, 4, flagged.stderr);
  assert.ok(flagged.stdout.includes('deferred cleanup: incomplete (the search reported incomplete results), 1 card(s) found, 1 pending\n'), flagged.stdout);
  const short = await run({ cleanup: { search: JSON.stringify([{ total_count: 3, incomplete_results: false, items: [{ number: 7 }] }]), comments: ONE_PENDING } });
  assert.equal(short.status, 4, short.stderr);
  assert.ok(short.stdout.includes('deferred cleanup: incomplete (the search found 3 card(s) but returned 1), 1 card(s) found, 1 pending\n'), short.stdout);
  const unread = await run({
    cleanup: {
      search: JSON.stringify([{ total_count: 3, incomplete_results: false, items: [{ number: 7 }, { number: 8 }, { number: 9 }] }]),
      comments: { ...ONE_PENDING, 8: new Error('gh: HTTP 502'), 9: JSON.stringify([{ id: 1, body: 'x' }]) },
    },
  });
  assert.equal(unread.status, 4, unread.stderr);
  assert.ok(unread.stdout.includes('deferred cleanup: incomplete (2 card(s) could not be read), 3 card(s) found, 1 pending\n'), unread.stdout);
  assert.ok(unread.stdout.includes('deferred cleanup pending: #7\n'), unread.stdout);
  assert.ok(unread.stdout.includes('deferred cleanup unread: #8 #9\n'), unread.stdout);
  const drifted = await run({ intake: { status: 3, stdout: DOCUMENT, stderr: DRIFT_STDERR }, cleanup: { search: new Error('gh: HTTP 503'), comments: {} } });
  assert.equal(drifted.status, 5, drifted.stderr);
  assert.equal(drifted.status, RESUME_START_EXIT.driftAndCleanupIncomplete);
});

test('ANTI-REGRESSION: resume-start prints no comment text, even from a reply it cannot parse', async () => {
  const result = await run({
    cleanup: {
      search: JSON.stringify([{ total_count: 3, incomplete_results: false, items: [{ number: 7 }, { number: 8 }, { number: 9 }] }]),
      comments: {
        7: JSON.stringify([[comment(100, '**Cleanup pending**\nEVIL injected text')]]),
        8: JSON.stringify([[comment(100, '**Cleanup pending**'), comment(200, '**Cleanup resolved**\n#issuecomment-100 EVIL')]]),
        // Node's parse error message quotes this reply.
        9: 'EVIL',
      },
    },
  });
  assert.equal(result.status, 4, result.stderr);
  assert.ok(result.stdout.includes('deferred cleanup: incomplete (1 card(s) could not be read), 3 card(s) found, 1 pending\n'), result.stdout);
  assert.ok(result.stdout.includes('deferred cleanup pending: #7\n'), result.stdout);
  assert.ok(result.stdout.includes('deferred cleanup unread: #9\n'), result.stdout);
  assert.ok(!result.stdout.includes('EVIL'), result.stdout);
  assert.ok(!result.stderr.includes('EVIL'), result.stderr);
  const unparsed = await run({ cleanup: { search: 'EVIL', comments: {} } });
  assert.equal(unparsed.status, 4, unparsed.stderr);
  assert.ok(unparsed.stdout.includes('deferred cleanup: incomplete (the search failed), no card read\n'), unparsed.stdout);
  assert.ok(!unparsed.stdout.includes('EVIL'), unparsed.stdout);
  assert.ok(!unparsed.stderr.includes('EVIL'), unparsed.stderr);
});

test('resume-start makes no cleanup read where the tracker keeps no Cleanup pending record', async () => {
  const result = await run({ config: { TRACKER: 'markdown' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('deferred cleanup: not applicable, the markdown tracker keeps no Cleanup pending record\n'), result.stdout);
  assert.deepEqual(result.cleanupCalls, []);
});

// The process tests: real git on a temporary origin and clone, the command copied beside a stand-in
// board.mjs, since a real intake would need a whole faked board, and the pull request read through fake gh.

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT = gitExecutable();
const COMMIT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty'];

const STAND_IN_BOARD = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [flag, folder] = process.argv.slice(2);
if (flag !== '--intake' || !folder) process.exit(1);
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, '7.txt'), 'card seven\\n');
process.stdout.write(process.env.STAND_IN_DOCUMENT);
process.stderr.write('board intake: 3 line(s) on stdout.\\n');
`;

const FAKE_GH = `const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') process.stdout.write(process.env.FAKE_GH_PULL_REQUESTS);
else if (args[0] === 'api' && args.includes('search/issues')) process.stdout.write(process.env.FAKE_GH_SEARCH);
else if (args[0] === 'api' && /\\/issues\\/\\d+\\/comments/.test(args.join(' '))) process.stdout.write(process.env.FAKE_GH_COMMENTS);
else process.exit(1);
`;

const fakeGh = installFakeGh('resume-start-gh-', FAKE_GH);
after(() => fakeGh.cleanup());

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'resume-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(GIT, 'resume-start fixtures need Git: gitExecutable() found none on PATH');
  const git = (cwd, ...args) => execFileSync(GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(root, 'origin.git');
  const checkout = join(root, 'checkout');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', checkout);
  git(checkout, ...COMMIT, '-m', 'first');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  const scripts = join(root, 'tool', 'scripts');
  cpSync(HERE, join(scripts, 'lib'), { recursive: true, filter: (source) => !source.endsWith('.test.mjs') });
  copyFileSync(join(HERE, '..', 'resume-start.mjs'), join(scripts, 'resume-start.mjs'));
  writeFileSync(join(scripts, 'board.mjs'), STAND_IN_BOARD);
  const scratch = join(root, 'scratch');
  const run = () => {
    const callsFile = fakeGh.newCallsFile();
    writeFileSync(callsFile, '');
    const result = spawnSync(process.execPath, [join(scripts, 'resume-start.mjs'), scratch], {
      cwd: checkout,
      encoding: 'utf8',
      timeout: 60_000,
      env: fakeGh.env({
        FAKE_GH_CALLS: callsFile,
        FAKE_GH_PULL_REQUESTS: PULL_REQUESTS,
        FAKE_GH_SEARCH: JSON.stringify([{ total_count: 1, incomplete_results: false, items: [{ number: 41 }] }]),
        FAKE_GH_COMMENTS: JSON.stringify([[{ id: 101, body: '**Cleanup pending**\nEVIL' }]]),
        STAND_IN_DOCUMENT: DOCUMENT,
      }),
    });
    const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { result, calls };
  };
  return { root, origin, checkout, scratch, git, run };
}

test('resume-start as a process: a clean main checkout at the fetched commit exits 0 and saves the document', (t) => {
  const f = fixture(t);
  const head = f.git(f.checkout, 'rev-parse', 'HEAD').trim();
  const { result, calls } = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`fetched commit: ${head}\n`), result.stdout);
  assert.ok(result.stdout.includes(DOCUMENT), result.stdout);
  assert.equal(readFileSync(join(f.scratch, 'board-intake.txt'), 'utf8'), DOCUMENT);
  assert.equal(readFileSync(join(f.scratch, 'intake', '7.txt'), 'utf8'), 'card seven\n');
  const pullRequestRead = ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url'];
  // Installed configurations run other trackers: the default one gets the cleanup reads, any other none.
  if (trackerOf(boardConfig) === trackerOf({})) {
    const repository = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
    assert.ok(result.stdout.includes('deferred cleanup: complete, 1 card(s) found, 1 pending\n'), result.stdout);
    assert.ok(result.stdout.includes('deferred cleanup pending: #41\n'), result.stdout);
    assert.ok(!result.stdout.includes('EVIL'), result.stdout);
    assert.deepEqual([...calls].sort(byText), [pullRequestRead, searchArgs(repository), commentArgs(repository, 41)].sort(byText));
  } else {
    assert.ok(result.stdout.includes(`deferred cleanup: not applicable, the ${trackerOf(boardConfig)} tracker keeps no Cleanup pending record\n`), result.stdout);
    assert.deepEqual(calls, [pullRequestRead]);
  }
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
});

test('resume-start as a process: a main checkout behind the fetched commit exits 14 and writes nothing', (t) => {
  const f = fixture(t);
  const head = f.git(f.checkout, 'rev-parse', 'HEAD').trim();
  const other = join(f.root, 'other');
  f.git(f.root, 'clone', '-q', f.origin, other);
  f.git(other, ...COMMIT, '-m', 'second');
  f.git(other, 'push', '-q', 'origin', 'main');
  const ahead = f.git(other, 'rev-parse', 'HEAD').trim();
  const { result, calls } = f.run();
  assert.equal(result.status, 14, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(head) && result.stderr.includes(ahead), result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(f.scratch), false);
  assert.deepEqual(calls, []);
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(f.git(f.checkout, 'status', '--porcelain'), '');
});
