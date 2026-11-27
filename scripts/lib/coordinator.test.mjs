// coordinator.test.mjs: the coordinator command, which opens a project's coordinator as a Coordinator tab in the
// project's Herdr space, lists the startable Ready cards and the unfinished jobs, and starts one card's job as a kept Claude session running the
// resume skill, in its own tab `job N`, under its run mark and bound to its one card, as the coordinator's own hc child.
//
// The library cases run openCoordinator, listCards, listUnfinished and startJob with an injected git, a fake herdrApp and a fake
// hc, each answering { code, stdout, stderr }, so they reach no Herdr; the git fake serves the fetch, the fetched-main settings
// read, so the settings come through the real readCoordinator, and the job branch and worktree reads. The tracker cases hand
// listCards, listUnfinished and startJob a fake raw `gh` behind the real tracker gate, so they reach no GitHub. The
// coordinator wire cases run scripts/coordinator.mjs with command doubles on PATH, from a fixture repository root.
// Delivery cases run the installed merge-watch entry with the real lane lock, isolated state and controlled provider and native
// replies. Their subprocess admission checks use a temporary Git tree and block native calls before dispatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, sep, win32 } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as mergeWatch } from '../merge-watch.mjs';
import { BOARD_OWNER, BOARD_OWNER_TYPE, BOARD_REPOSITORY, KIND_LABELS } from './board-config.mjs';
import { KIND_TYPES } from './board.mjs';
import { boardReadExec, boardRequestKind, issueItemReply, issuesPage, leanBoardPage, leanNode, membership, onePageAtATime } from './board-fixtures.mjs';
import { wakeCoordinator as wakeAfterMove } from './board-move.mjs';
import { coordinatorTerminals, forwardedNotes, forwardNotes, jobPrompt, launchCoordinator, listCards, listUnfinished, openCoordinator, sameLaunchFolder, startForwarder, startJob, wakeCoordinator } from './coordinator.mjs';
// relayToCoordinator through the namespace, so the file still loads where the export is missing.
import * as coordinator from './coordinator.mjs';
import { installFakeGh } from './fake-gh.mjs';
import { runGh } from './gh-exec.mjs';
import { aclGrantsOthers, capLock, lockLeadFile, readCap } from './cap-lock.mjs';
import { openEventRoute } from './merge-watch.mjs';
import { isHerdrPath } from './runtimes.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { repairWorkflowSnapshot, verifyWorkflowSnapshot } from './workflow-pin.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND = join(SCRIPTS, 'coordinator.mjs');
// Why a case that starts or delivers a job skips here, or undefined on Linux. The "cap lock: " cases run on every platform except
// the symbolic-link test where file symlinks cannot be made, the folder-mode and file-mode tests on Windows, the profile test off
// Windows, and the two tests that rename a held file on Windows.
const OFF_LINUX = process.platform === 'linux' ? undefined : `the coordinator starts and delivers jobs on Linux only, not ${process.platform}`;
const NO_EXTENSIONLESS_FAKES = process.platform === 'win32' && 'the fixture\'s fake git and hc are extensionless #! scripts on a colon-separated PATH, which Windows cannot run';

const prompt = (login) => `Coordinate this project from its Herdr space: read .agents/skills/resume/references/herdr-lead.md whole and follow its "Coordinator" section.\n{"login":"${login}"}`;
const argvFor = (model, effort, login) => ['/usr/bin/env', `ANTHROPIC_MODEL=${model}`, `CLAUDE_CODE_EFFORT_LEVEL=${effort}`, 'claude',
  '--permission-mode', 'auto', '--', prompt(login)];

const OID = 'a'.repeat(40);
const settingsText = (extra = {}) => JSON.stringify({ version: 1, herdr: true, waitForOwner: 'on-screen', ...extra });

// A git that answers the fetch and the fetched-main settings read, recording each call. It also answers the repository's job
// branches and worktrees as `for-each-ref` and `worktree list --porcelain` print them: `repository.branches` the cards with a
// branch job/N, `repository.worktrees` the cards with a worktree <root>/.claude/worktrees/job-N, on job/N where that branch
// exists and detached where it does not; `registered` adds independently named paths. The main worktree is the root.
/** @type {(text: string, calls: string[][], repository?: { root?: string, branches?: number[], worktrees?: number[], registered?: { path: string, branch?: string }[] }) => (args: string[]) => string} */
function gitFor(text, calls, { root = ROOT, branches = [], worktrees = [], registered = [] } = {}) {
  const records = [
    { path: root, branch: 'refs/heads/main' },
    ...worktrees.map((card) => ({ path: `${root}/.claude/worktrees/job-${card}`, branch: branches.includes(card) ? `refs/heads/job/${card}` : undefined })),
    ...registered,
  ];
  return (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (line === 'for-each-ref --format=%(refname) refs/heads/job/') return branches.map((card) => `refs/heads/job/${card}\n`).join('');
    if (line === 'worktree list --porcelain' || line === 'worktree list --porcelain -z') {
      const separator = args.includes('-z') ? '\0' : '\n';
      return records.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${OID}`, branch ? `branch ${branch}` : 'detached', '', ''].join(separator)).join('');
    }
    if (line === 'fetch --no-prune origin main') return '';
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'ls-tree') return '100644\n';
    if (args[0] === 'show') return text;
    throw new Error(`unexpected git call: ${line}`);
  };
}

// The project folder the in-process cases open and start from; a space is this project's only when its folder is this.
const ROOT = '/srv/projects/fabraik';

/** @type {(id: string, name: string, tabs?: [string, string][], machine?: string | null, folder?: string) => { id: string, name: string, folder: string, machine: string | null, active: boolean, tabs: { id: string, name: string }[] }} */
const space = (id, name, tabs = [], machine = null, folder = '/home/someone') => ({ id, name, folder, machine, active: false, tabs: tabs.map(([tabId, tabName]) => ({ id: tabId, name: tabName })) });

// A herdrApp whose `ls` answers `listing` (a value, or a { code, stdout, stderr } to answer as it is) and which records
// every call; `do` answers success.
function herdrAppFor(listing, calls) {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'ls') return listing.code === undefined ? { code: 0, stdout: JSON.stringify(listing), stderr: '' } : listing;
    return { code: 0, stdout: '{}', stderr: '' };
  };
}

const withCoordinator = (project, addresses = ['t0']) => ({ ...project, tabs: [...project.tabs,
  { id: 'tbc', name: 'Coordinator', terminals: addresses.map((terminal) => ({ terminal })) }] });

// The flags of a `do <command>` call, by name, with the --argv value parsed.
function flagsOf(args) {
  const flags = {};
  for (let i = 2; i < args.length; i += 2) flags[args[i].slice(2)] = args[i + 1];
  if (flags.argv !== undefined) flags.argv = JSON.parse(flags.argv);
  return flags;
}

// A hc whose `get` answers the record `records` holds by address, or fails where there is none, recording every call.
function hcFor(records, calls) {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'get') return records[args[1]] === undefined ? { code: 1, stdout: '', stderr: 'no such terminal' } : { code: 0, stdout: JSON.stringify(records[args[1]]), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

// One open of the coordinator over `listing`, the `hc get` records `records` and a settings file of `text`, on `platform` (Linux
// unless given) with `node` as the Node executable: its exit code and what it did.
/** @param {{ listing: any, records?: Record<string, unknown>, text?: string, root?: string, login?: string, platform?: string, node?: string }} options */
async function opened({ listing, records = {}, text = settingsText(), root = ROOT, login = 'owner', platform = 'linux', node }) {
  const git = [];
  const app = [];
  const hcCalls = [];
  const lines = [];
  const options = { root, login, git: gitFor(text, git), herdrApp: herdrAppFor(listing, app), hc: hcFor(records, hcCalls), capLock: (work) => work(),
    platform, node, print: (line) => lines.push(line) };
  const code = await openCoordinator(options);
  return { code, git, app, hcCalls, said: lines.join('\n') };
}

test('ANTI-REGRESSION: the coordinator opens in the project space at the settings model and effort with no tool denied', async () => {
  const root = '/srv/projects/fabraik';
  const listing = { spaces: [space('spother', 'elsewhere'), space('spproject1', 'fabraik', [['tb1', '1'], ['tbq', 'Queue']], null, ROOT)] };

  const opens = await opened({ listing, text: settingsText({ coordinator: { model: 'sonnet', effort: 'high' } }) });
  assert.equal(opens.code, 0);
  assert.deepEqual(opens.git[0], ['fetch', '--no-prune', 'origin', 'main']);
  assert.deepEqual(opens.app.map((args) => args.slice(0, 2)), [['ls'], ['do', 'tab.new']]);
  assert.deepEqual(flagsOf(opens.app[1]), { space: 'spproject1', name: 'Coordinator', folder: root, argv: argvFor('sonnet', 'high', 'owner') });

  const defaults = await opened({ listing });
  assert.equal(defaults.code, 0);
  assert.deepEqual(flagsOf(defaults.app[1]).argv, argvFor('opus', 'medium', 'owner'));

  const there = await opened({ listing: coordinatorListing(listed('t9')), records: { t9: liveRecord() } });
  assert.equal(there.code, 5);
  assert.match(there.said, /tbc/);
  assert.deepEqual(there.app, [['ls']]);

  const off = await opened({ listing, text: settingsText({ herdr: false }) });
  assert.equal(off.code, 3);
  assert.deepEqual(off.app, []);
});

test('coordinator opens a new project space when none has the repository\'s folder', async () => {
  const root = ROOT;
  // A space of the same folder on another machine, and a local space of the same name with another folder, are not this project's.
  const aside = space('spaside', 'fabraik', [['tb3', 'Coordinator']], null, '/srv/projects/other');
  const listing = { spaces: [space('spother', 'elsewhere', [['tb1', 'Coordinator']]), space('spremote', 'fabraik', [['tb2', 'Coordinator']], 'laptop', root), aside] };
  const opens = await opened({ listing });
  assert.equal(opens.code, 0);
  assert.deepEqual(opens.app.map((args) => args.slice(0, 2)), [['ls'], ['do', 'space.new']]);
  assert.deepEqual(flagsOf(opens.app[1]), { name: 'fabraik', folder: root, tab: 'Coordinator', machine: '', argv: argvFor('opus', 'medium', 'owner') });

  const job = jobFixture({ spaces: [aside], pages: READY_BOARD() });
  assert.equal(await job.start(5), 1);
  assert.deepEqual(job.lines, [`No Herdr space has folder ${root}; open the coordinator first.`]);
  assert.deepEqual(job.app, [['ls']]);
});

test('coordinator refuses an ambiguous or unreadable Herdr space list', async () => {
  const twins = await opened({ listing: { spaces: [space('spone', 'fabraik', [], null, ROOT), space('sptwo', 'other', [], null, ROOT), space('spother', 'elsewhere')] } });
  assert.equal(twins.code, 1);
  assert.equal(twins.said, `Herdr spaces spone, sptwo all have folder ${ROOT}; close all but one.`);
  assert.deepEqual(twins.app, [['ls']]);

  for (const listing of [{ code: 1, stdout: '', stderr: 'no window' }, { code: 0, stdout: 'not json', stderr: '' }, { code: 0, stdout: '{"spaces":"none"}', stderr: '' },
    { code: 0, stdout: '{"spaces":[{"id":"spone","name":"fabraik","folder":"/home/someone","machine":null,"tabs":"none"}]}', stderr: '' },
    { code: 0, stdout: '{"spaces":[{"id":"spone","name":"fabraik","machine":null,"tabs":[]}]}', stderr: '' }]) {
    const refused = await opened({ listing });
    assert.equal(refused.code, 1, JSON.stringify(listing));
    assert.match(refused.said, /herdr-app ls/);
    assert.deepEqual(refused.app, [['ls']]);
  }
});

// A board card as the project listing returns it: an open issue of the configured repository with the given blockers.
/** @type {(number: number, options?: { status?: string, blockers?: { number: number, state: string, stateReason?: string }[] }) => ReturnType<typeof leanNode>} */
const issue = (number, { status = 'Ready', blockers = [] } = {}) =>
  leanNode({ id: `PVTI_${number}`, title: `Card ${number}`, status, content: { __typename: 'Issue', number, blockers } });

// Card `number` as the card detail read answers it: an empty body, no parent and its comments, oldest first: `comments` all of
// them, or `{ newest, older }` the newest ones with `older` earlier comments on a page before them (`older-<number>`).
/** @type {(number: number, comments: string[] | { newest: string[], older: number }) => Record<string, unknown>} */
const cardDetail = (number, comments) => {
  const { newest, older } = Array.isArray(comments) ? { newest: comments, older: 0 } : comments;
  return { number, body: '', parent: null, comments: { totalCount: older + newest.length,
    pageInfo: older > 0 ? { hasPreviousPage: true, startCursor: `older-${number}` } : { hasPreviousPage: false, startCursor: null },
    nodes: newest.map((body, index) => ({ body, url: `https://example.test/issues/${number}#comment-${older + index + 1}`, author: { login: 'owner' } })) } };
};

// A claim by this machine, which the fixtures name `here`.
const CLAIM_HERE = 'Claim: here, Claude Code, 2026-11-18T09:00Z';

const RESET_SECONDS = 600;

// The tracker side of a test: a raw `gh` that answers the board read one page per request from `pages`, behind the real
// tracker gate. `options` is what listCards and startJob take; `log` holds each raw `gh` request as its kind and what
// the coordinator was told. With `refuseSecondPage` the first request for the listing's second page is refused for quota,
// and the `rate_limit` probe that follows answers that the allowance resets at RESET_SECONDS; without it the probe answers an
// allowance left, so a failed read stays the failure it is. The card detail read
// (`details` in the log) answers each card's comments from `details` by card number (see cardDetail), a complete read of none
// for a card it does not name; a read of the older comments (`older comments`) fails. The open draft pull request list
// (`drafts`) answers `drafts`, each `{ number, headRefName }`. Where `details` or `drafts` is a function, its read answers what
// the function returns, or fails with what it throws. A direct read of one card's issue (`issue` in the log) answers that card's
// state from `issues` by card number, only for the exact `--repo <board repository> --json state` form, and fails as GitHub does for a card it does not name.
/** @typedef {Record<number, string[] | { newest: string[], older: number }> | ((args: string[]) => string)} DetailReplies */
/** @typedef {{ number: number, headRefName: string }[] | ((args: string[]) => string)} DraftReplies */
/** @param {{ pages: unknown, refuseSecondPage?: boolean, refuseDetails?: boolean, refuseOlder?: boolean, details?: DetailReplies, drafts?: DraftReplies, issues?: Record<number, string> }} options */
function trackerFor({ pages, refuseSecondPage = false, refuseDetails = false, refuseOlder = false, details = {}, drafts = [], issues = {} }) {
  const paged = onePageAtATime(boardReadExec({ board: pages }).exec);
  /** @type {{ gh: string[], calls: string[][] }} */
  const log = { gh: [], calls: [] };
  let refused = false;
  let detailsRefused = false;
  const rawGh = (args) => {
    log.calls.push(args);
    if (args[1] === 'rate_limit') {
      log.gh.push('probe');
      return JSON.stringify({ resources: { graphql: { limit: 5000, remaining: refuseSecondPage || refuseDetails || refuseOlder ? 0 : 4999, reset: RESET_SECONDS } } });
    }
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('--draft')) {
      log.gh.push('drafts');
      return typeof drafts === 'function' ? drafts(args) : JSON.stringify(drafts);
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      log.gh.push('issue');
      if (JSON.stringify(args) !== JSON.stringify(['issue', 'view', args[2], '--repo', `${BOARD_OWNER}/${BOARD_REPOSITORY}`, '--json', 'state'])) {
        throw new Error(`unexpected issue read: ${JSON.stringify(args)}`);
      }
      const state = issues[Number(args[2])];
      if (state === undefined) throw new Error(`GraphQL: Could not resolve to an issue with the number of ${args[2]}.`);
      return JSON.stringify({ state });
    }
    if (args.some((arg) => arg.startsWith('before='))) {
      log.gh.push('older comments');
      throw new Error(refuseOlder ? 'API rate limit exceeded for user ID 12345' : 'HTTP 502: Bad Gateway');
    }
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    if (query.includes('fragment CardDetails')) {
      log.gh.push('details');
      if (refuseDetails && !detailsRefused) {
        detailsRefused = true;
        throw new Error('API rate limit exceeded for user ID 12345');
      }
      if (typeof details === 'function') return details(args);
      const cards = [...query.matchAll(/\bi(\d+): issue\(number:/g)].map(([, number]) => Number(number));
      return JSON.stringify({ data: { repository: Object.fromEntries(cards.map((number) => [`i${number}`, cardDetail(number, details[number] ?? [])])) } });
    }
    const kind = boardRequestKind(args);
    const later = args.some((arg) => arg.startsWith('endCursor='));
    log.gh.push(later ? `${kind} next` : kind);
    if (refuseSecondPage && kind === 'board' && later && !refused) {
      refused = true;
      throw new Error('API rate limit exceeded for user ID 12345');
    }
    return paged(args);
  };
  const options = { rawGh };
  return { options, log };
}

// What one board walk asks `gh` for: the project listing, the repository's open issue walk and its recently closed issue walk.
const WALK = ['board', 'issues', 'closedIssues'];
// What a start of a card with no branch, worktree or draft pull request asks `gh` for, in order: the open draft pull requests that
// tell whether the card has one, then the board walk the startable rule reads. It reads no card details.
const START_READS = ['drafts', ...WALK];

test('coordinator lists the startable cards in build order and leaves out blocked ones', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // The listing's own order puts 12 before 4 and 6: build order follows it, not the card numbers. 9 has an open blocker; 8's
  // blocker was closed as not planned and 10's closed with no reason, so each still holds its card; 6's was completed; 15 is
  // in Backlog.
  const nodes = [issue(12), issue(4), issue(9, { blockers: [{ number: 20, state: 'OPEN' }] }), issue(15, { status: 'Backlog' }),
    issue(6, { blockers: [{ number: 2, state: 'CLOSED', stateReason: 'COMPLETED' }] }),
    issue(8, { blockers: [{ number: 3, state: 'CLOSED', stateReason: 'NOT_PLANNED' }] }),
    issue(10, { blockers: [{ number: 5, state: 'CLOSED' }] })];
  const { options, log } = trackerFor({ pages: [leanBoardPage(nodes)] });
  const lines = [];
  assert.equal(await listCards({ ...options, print: (line) => lines.push(line) }), 0);
  assert.deepEqual(lines, ['#12 Card 12', '#4 Card 4', '#6 Card 6']);
  assert.deepEqual(log.gh.sort(), [...WALK].sort());

  const none = trackerFor({ pages: [leanBoardPage([issue(15, { status: 'Backlog' }), issue(9, { blockers: [{ number: 20, state: 'OPEN' }] })])] });
  const said = [];
  assert.equal(await listCards({ ...none.options, print: (line) => said.push(line) }), 0);
  assert.equal(said.length, 1);
  assert.match(said[0], /no startable/i);
});

test('a refused coordinator read prints its reset time and exits 6 without waiting or repeating', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const reset = new Date(RESET_SECONDS * 1000).toISOString();
  const line = `GitHub refused a coordinator tracker read for quota; repeat it after ${reset}.`;
  const pages = [leanBoardPage([issue(12)], { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'page-1' } }), leanBoardPage([issue(4)], { totalCount: 2 })];
  const { options, log } = trackerFor({ pages, refuseSecondPage: true });
  const lines = [];
  assert.equal(await listCards({ ...options, print: (text) => lines.push(text) }), 6);
  assert.deepEqual(lines, [line]);
  assert.deepEqual([log.gh.filter((kind) => kind === 'board').length, log.gh.filter((kind) => kind === 'board next').length, log.gh.filter((kind) => kind === 'probe').length], [1, 1, 1], 'the refused page is not repeated');

  // The board page succeeds and the card detail read is the refused one: its failure is not an unknown job.
  // 21 cards in progress, each with a job branch, so card details are read in two batches and the second must not follow the refused first.
  const numbers = Array.from({ length: 21 }, (_, i) => i + 1);
  const many = numbers.map((number) => issue(number, { status: 'In progress' }));
  const job = unfinishedFixture(many, { refuseDetails: true, branches: numbers });
  assert.equal(await job.unfinished(), 6, job.lines.join('\n'));
  assert.deepEqual(job.lines, [line], 'no verdict is printed');
  assert.equal(job.tracker.log.gh.filter((kind) => kind === 'details').length, 1, 'no read follows the refused batch');

  // The same refused detail read on a start of card 5: it ends with the same reset, before any verdict or start.
  const nodes = [issue(5, { status: 'In progress' })];
  const started = unfinishedFixture(nodes, { refuseDetails: true, branches: [5] });
  assert.equal(await started.start(5), 6, started.lines.join('\n'));
  assert.deepEqual(started.lines, [line], 'no verdict or start line is printed');
  assert.deepEqual(started.runs(), [], 'nothing is launched');
  assert.ok(!started.calls.some((args) => ['label', 'send'].includes(args[0])), 'no label or send');
  assert.ok(!started.app.some((args) => args.includes('tab.new')), 'no tab is opened');

  // A held card whose Needs owner: comment is in the first page and whose older comments are the refused read: the verdict is `held`
  // before the unread comments matter, so only the gate's own check ends the start with the reset.
  const held = unfinishedFixture(nodes, { refuseOlder: true, details: { 5: { newest: ['Needs owner: Pick the panel colours.'], older: 1 } }, branches: [5] });
  assert.equal(await held.start(5), 6, held.lines.join('\n'));
  assert.deepEqual(held.lines, [line], 'only the reset line is printed');
  assert.deepEqual(held.runs(), [], 'nothing is launched');
  assert.ok(!held.calls.some((args) => ['label', 'send'].includes(args[0])), 'no label or send');
  assert.ok(!held.app.some((args) => args.includes('tab.new')), 'no tab is opened');
});

// One project's coordinator tools over fakes: `spaces` is what herdr-app lists. A `tab.new` adds a tab with either a
// shell or a help pane, and `hc run` attaches to the tab in its labels. The fake hc answers by subcommand: `ls` lists
// `terminals` (those carrying every `--label k=v` it is given, by the labels of their entry or else of their `details`
// record, as a real Herdr filters; a finished one only with `--all`, an entry with no state of its own by the state of its record), `get` answers `details` by address (a real `hc get
// --json` record, where its `pid`, `foreground.pid` and `argv` tell a running program from the shell Herdr substituted, or what `replies` holds by
// address; `ls` answers what `replies.ls` holds where it holds one), `run` answers `launch`, `kill` finishes the
// terminal it names, keeping its record and labels, and answers that record, and `rm` removes it.
// A test changes `terminals` and `details` between starts. `start` runs from coordinator terminal t0 unless its options say
// otherwise, with the injected clock, session id, host name `here`, transcript lookup, model and effort a coordinator
// wires; the repository holds the job branches `branches` and job worktrees `worktrees` (see gitFor), and the tracker answers
// the card comments `details` and the draft pull requests `drafts` (see trackerFor). `unfinished` lists the unfinished jobs over
// the same tools.
// The transcript lookup answers what `{id}.jsonl` is in a Claude project folder: 'file' a regular file, 'link' a symbolic
// link, undefined none; by default there is none.
const SESSION = '11111111-1111-4111-8111-111111111111';
const RUN_AT = '2026-11-19T12:00:00Z';
const JOB_PROMPT = (card) => `Run the resume skill for card #${card} as a Herdr job.`;
const CODEX_BIND_FIRST = 'First run exactly node scripts/coordinator.mjs bind-job from the integration root. Stop if it fails.';
const CODEX_DELIVERY_GUIDANCE = 'For delivery follow the Codex Herdr job route in .agents/skills/resume/references/herdr-job.md. Merge only with the pinned merge once the required checks pass; only the show-me-first label waits for the owner.';
const CODEX_JOB_PROMPT = (card) => `${CODEX_BIND_FIRST} ${JOB_PROMPT(card)} ${CODEX_DELIVERY_GUIDANCE}`;
// `text` as a regular expression that matches it literally.
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {{ root?: string, spaces: any[], pages: unknown, refuseDetails?: boolean, refuseOlder?: boolean, details?: DetailReplies, drafts?: DraftReplies, issues?: Record<number, string>, branches?: number[], worktrees?: number[], tabNew?: { code: number, stdout: string, stderr: string }, onLaunch?: () => void }} options */
function jobFixture({ root = ROOT, spaces, pages, refuseDetails, refuseOlder, details, drafts, issues, branches = [], worktrees = [], tabNew, onLaunch }) {
  const tracker = trackerFor({ pages, refuseDetails, refuseOlder, details, drafts, issues });
  const fixture = { terminals: /** @type {Record<string, any>[]} */ ([]),
    details: /** @type {Record<string, any>} */ ({ t0: { ...liveRecord({ foregroundPid: 100 }), address: 't0', cwd: root } }),
    coordinatorAddresses: ['t0'], app: /** @type {string[][]} */ ([]), helpPanes: new Set(),
    paneCloses: /** @type {{ pane: string, listed: any[] }[]} */ ([]),
    replies: /** @type {Record<string, { code: number, stdout: string, stderr: string }>} */ ({}),
    launch: { code: 0, stdout: JSON.stringify({ address: 't10' }), stderr: '' },
    calls: /** @type {string[][]} */ ([]), lines: /** @type {string[]} */ ([]), tracker };
  let lastListing = [];
  const herdrApp = async (args) => {
    fixture.app.push(args);
    if (args[0] === 'ls') {
      if (fixture.replies['app ls']) return fixture.replies['app ls'];
      const projected = spaces.map((project) => project.folder === root && project.machine === null
        ? withCoordinator(project, fixture.coordinatorAddresses) : project);
      lastListing = structuredClone(projected);
      return { code: 0, stdout: JSON.stringify({ spaces: projected }), stderr: '' };
    }
    if (args[1] === 'tab.new') {
      if (tabNew) return tabNew;
      const { space, name, mod } = flagsOf(args);
      const tab = `tb-${name.replace(' ', '-')}`;
      const terminals = [];
      spaces.find(({ id }) => id === space).tabs.push({ id: tab, name, terminals });
      const pane = `p-${tab}`;
      if (mod === 'help') {
        fixture.helpPanes.add(pane);
        return { code: 0, stdout: JSON.stringify({ space, tab, pane }), stderr: '' };
      }
      const terminal = 't99';
      terminals.push({ terminal, pane });
      return { code: 0, stdout: JSON.stringify({ space, tab, terminal }), stderr: '' };
    }
    if (args[1] === 'pane.close') {
      const { pane } = args.length === 3 ? JSON.parse(args[2]) : flagsOf(args);
      fixture.paneCloses.push({ pane, listed: lastListing });
      if (!fixture.helpPanes.delete(pane)) return { code: 1, stdout: '', stderr: 'no help pane to close' };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const hc = async (args) => {
    fixture.calls.push(args);
    if (args[0] === 'ls') {
      if (fixture.replies.ls) return fixture.replies.ls;
      const wanted = args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.split('=')] : []));
      const listed = fixture.terminals.filter(({ address, state = fixture.details[address]?.state, labels = fixture.details[address]?.labels }) =>
        (state === 'live' || args.includes('--all')) && wanted.every(([key, value]) => labels?.[key] === value));
      return { code: 0, stdout: JSON.stringify({ hidden_finished: 0, machines: [], terminals: listed }), stderr: '' };
    }
    const record = fixture.details[args[1]];
    const missing = { code: 1, stdout: '', stderr: `no terminal ${args[1]}` };
    if (args[0] === 'get') {
      if (fixture.replies[args[1]]) return fixture.replies[args[1]];
      return record ? { code: 0, stdout: JSON.stringify(record), stderr: '' } : missing;
    }
    if (args[0] === 'kill') {
      if (!record) return missing;
      delete record.foreground;
      Object.assign(record, { state: 'finished', reason: 'killed', signal: 1, finished_ms: 1795090122648 });
      Object.assign(fixture.terminals.find(({ address }) => address === args[1]) ?? {}, { state: 'finished' });
      return { code: 0, stdout: JSON.stringify(record), stderr: '' };
    }
    if (args[0] === 'rm') {
      if (!record) return missing;
      delete fixture.details[args[1]];
      fixture.terminals = fixture.terminals.filter(({ address }) => address !== args[1]);
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'label') {
      if (!record) return missing;
      const [key, value] = args[2].split('=');
      record.labels = { ...record.labels, [key]: value };
      return { code: 0, stdout: JSON.stringify(record), stderr: '' };
    }
    if (args[0] === 'send') return fixture.replies[`send ${args[1]}`] ?? { code: 0, stdout: '{}', stderr: '' };
    if (args[0] === 'read') return fixture.replies[`read ${args[1]}`] ?? missing;
    if (args[0] === 'run' && fixture.launch.code === 0) {
      const label = (name) => args.find((arg, index) => args[index - 1] === '--label' && arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const tab = spaces.find(({ id }) => id === label('herdr.space'))?.tabs.find(({ id }) => id === label('herdr.tab'));
      const { address } = JSON.parse(fixture.launch.stdout);
      if (tab && address) (tab.terminals ??= []).push({ terminal: address, pane: `p-${address}` });
      onLaunch?.();
    }
    return fixture.launch;
  };
  const git = gitFor(settingsText({ coordinator: { model: 'sonnet', effort: 'high' } }), [], { root, branches, worktrees });
  // The options a coordinator wires beyond the tracker tools are typed loosely so the fake hands startJob what the command does.
  fixture.hc = hc;
  fixture.start = (card, options = {}) => startJob(/** @type {any} */ ({ root, login: 'owner', card, herdrApp, hc, parent: 't0', ...tracker.options, now: () => Date.parse(RUN_AT),
    newSessionId: () => SESSION, hostname: 'here', transcript: () => undefined, cap: () => 10, capLock: (work) => work(), git,
    ...options, print: (line) => fixture.lines.push(line) }));
  fixture.unfinished = (options = {}) => listUnfinished(/** @type {any} */ ({ root, login: 'owner', herdrApp, hc, ...tracker.options, hostname: 'here', git,
    ...options, print: (line) => fixture.lines.push(line) }));
  fixture.forward = (options = {}) => startForwarder(/** @type {any} */ ({ root, herdrApp, hc, parent: 't0', ...options, print: (line) => fixture.lines.push(line) }));
  fixture.runs = () => fixture.calls.filter((args) => args[0] === 'run');
  // A live job terminal of card `card` as `hc ls --json` lists it (no labels, as a real Herdr lists) and `hc get --json` reads it
  // (with its labels), running `foreground`: 'bash' is the shell a kept terminal holds once its program is gone, any other name a
  // program started by the launch form `/usr/bin/env ...`, which keeps the terminal's pid.
  // Its `hc get` status is `status` (a real Herdr state: `working`, `blocked` at a question menu, `done`), or null where the session is still starting.
  // `labels` are further labels of its record, such as the `fabraik.stopped` kind. A test sets `replies['send <address>']` to make
  // `hc send` answer otherwise than exit 0, and `replies['read <address>']` to answer `hc read`, which fails otherwise;
  // `hc label <address> k=v` (or `k=`) sets that label on the record.
  fixture.addJob = (address, card, foreground, status = 'done', labels = {}) => {
    const name = `fabraik-job-${card}`;
    const pid = 1000 + Number(address.slice(1));
    fixture.terminals.push({ address, agent: 'claude', cwd: ROOT, name, parent: 't0', state: 'live', turn: 1 });
    fixture.details[address] = { address, name, state: 'live', keep: true, pid, argv: foreground === 'bash' ? ['/usr/bin/bash'] : ['/usr/bin/env', 'claude'],
      foreground: { name: foreground, pid }, status: status === null ? null : { app: 'claude-code', state: status },
      labels: { 'fabraik.role': 'job', 'fabraik.space': 'spproject1', 'fabraik.card': String(card), ...labels } };
  };
  return fixture;
}

const READY_BOARD = () => [leanBoardPage([issue(5), issue(6), issue(7), issue(9, { blockers: [{ number: 20, state: 'OPEN' }] })])];

// The exact `hc run` of card `card`'s job session in the tab `tab` of space spproject1, from the coordinator t0, started from
// the real repository `root` under its local main.
const jobRunArgs = (name, card, tab, root) => {
  const main = pinGit(root, 'rev-parse', 'refs/heads/main');
  return ['run', '--bg', '--keep', '--parent', 't0', '--outlive-parent', '--name', name, '--cwd', root,
    '--label', 'herdr.space=spproject1', '--label', `herdr.tab=${tab}`, '--label', 'fabraik.role=job', '--label', 'fabraik.space=spproject1',
    '--label', `fabraik.card=${card}`, '--label', `fabraik.session=${SESSION}`, '--label', `fabraik.workflow=${main}`, '--label', `fabraik.runstart=${RUN_AT}`,
    '--json', '--', '/usr/bin/env', `PRE_APPROVED_RUN_SESSION=${RUN_AT}`, `PRE_APPROVED_RUN_CARD=${card}`, 'FABRAIK_COORDINATED_JOB=1', pinMark(root, main),
    'ANTHROPIC_MODEL=sonnet', 'CLAUDE_CODE_EFFORT_LEVEL=high', 'claude', '--permission-mode', 'auto', '--session-id', SESSION, '--', JOB_PROMPT(card)];
};
// Makes the folder `root` a repository whose main and origin/main hold one empty commit, so a start can pin its workflow; `root`.
function committedRoot(root) {
  mkdirSync(root, { recursive: true });
  pinGit(root, 'init', '-b', 'main');
  pinGit(root, 'commit', '--allow-empty', '-m', 'root');
  pinGit(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}
// A clone of workflowRepository's repository in a folder named fabraik, so its jobs carry ROOT's job names; the clone's path.
function fabraikRepository(t) {
  const source = workflowRepository(t);
  pinGit(source, 'clone', '--quiet', source, 'fabraik');
  return join(source, 'fabraik');
}

test('coordinator starts card N as a kept Claude session running resume in its tab job N', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);

  // No tab job 5 yet: the coordinator opens it in the project space, then runs the kept session as its own child with the exact command.
  const opens = jobFixture({ root, spaces: [space('spother', 'elsewhere'), space('spproject1', 'fabraik', [['tb1', '1']], null, root)], pages: READY_BOARD() });
  assert.equal(await opens.start(5), 0, opens.lines.join('\n'));
  const tabNews = opens.app.filter((args) => args[1] === 'tab.new');
  assert.equal(tabNews.length, 1);
  assert.equal(flagsOf(tabNews[0]).name, 'job 5');
  assert.deepEqual(opens.runs(), [jobRunArgs('fabraik-job-5', 5, 'tb-job-5', root)]);
  assert.equal(opens.calls.at(-1)?.[0], 'run', 'the run is the last hc call');
  assert.deepEqual(opens.lines, [`Card 5's job session fabraik-job-5 is starting in tab job 5 with session ${SESSION}, not yet confirmed: hc get fabraik-job-5 --json shows it.`]);
  assert.deepEqual(opens.tracker.log.gh, START_READS, 'one board read per start');

  // Tab job 6 is open already with no job terminal in it: it is reused, not refused, and no second tab opens.
  const there = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1'], ['tbjob6', 'job 6']], null, root)], pages: READY_BOARD() });
  assert.equal(await there.start(6), 0, there.lines.join('\n'));
  assert.deepEqual(there.runs(), [jobRunArgs('fabraik-job-6', 6, 'tbjob6', root)]);
  assert.ok(!there.app.some((args) => args[1] === 'tab.new'), 'the open tab is reused');

  // The name is the folder, lowercased, outside a-z0-9_- as a hyphen, cut so that with -job-7 it holds 32 characters.
  const longName = 'Fab Raik.Project-With-A-Very-Long-Name';
  const longRoot = committedRoot(join(root, longName));
  const long = jobFixture({ root: longRoot, spaces: [space('spproject1', longName, [], null, longRoot)], pages: READY_BOARD() });
  assert.equal(await long.start(7), 0, long.lines.join('\n'));
  const [run] = long.runs();
  assert.equal(run[run.indexOf('--name') + 1], 'fab-raik-project-with-a-ve-job-7');

  // A card that is not startable (blocked, or not on the board) and has no branch starts nothing and opens no tab.
  for (const card of [9, 99]) {
    const refused = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: READY_BOARD() });
    assert.equal(await refused.start(card), 1);
    assert.match(refused.lines.join('\n'), new RegExp(`card ${card}\\b.*startable`, 'i'));
    assert.deepEqual(refused.runs(), []);
    assert.ok(!refused.app.some((args) => args[0] === 'do'), 'no tab is opened for a card that does not start');
  }

  // A coordinator setting on fetched main that cannot be read refuses the start, names the cause, and opens and reads nothing.
  /** @type {[string, (args: string[]) => string][]} */
  /** @type {[string, (args: string[]) => string, RegExp][]} */
  const unreadable = [['an effort that is no level', gitFor(settingsText({ coordinator: { effort: 'extreme' } }), []), /coordinator\.effort: must be/],
    ['settings that are not JSON', gitFor('not json', []), /is not valid JSON/],
    ['a fetched main that cannot be resolved', () => { throw new Error('fatal: no origin/main'); }, /unavailable on fetched main/]];
  for (const [label, git, cause] of unreadable) {
    const bare = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: READY_BOARD() });
    assert.equal(await bare.start(5, { git }), 1, label);
    assert.match(bare.lines.join('\n'), cause, label);
    assert.deepEqual(bare.runs(), [], label);
    assert.ok(!bare.app.some((args) => args[1] === 'tab.new'), `${label} opens no tab`);
    assert.deepEqual(bare.tracker.log.gh, [], `${label} reads no GitHub`);
  }

  const none = jobFixture({ spaces: [space('spother', 'elsewhere')], pages: READY_BOARD() });
  assert.equal(await none.start(5), 1);
  assert.match(none.lines.join('\n'), /fabraik/);
  assert.deepEqual(none.calls, []);
  assert.deepEqual(none.tracker.log.gh, []);

  const twins = jobFixture({ spaces: [space('spone', 'fabraik', [], null, ROOT), space('sptwo', 'fabraik', [], null, ROOT)], pages: READY_BOARD() });
  assert.equal(await twins.start(5), 1);
  assert.match(twins.lines.join('\n'), /spone/);
  assert.deepEqual(twins.calls, []);

  const failed = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [], null, root)], pages: READY_BOARD(), tabNew: { code: 1, stdout: '', stderr: 'name taken' } });
  assert.equal(await failed.start(5), 1);
  assert.match(failed.lines.join('\n'), /name taken/);
});

test('A fresh Herdr job tab keeps only its own terminal', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const existingTab = { id: 'tb1', name: 'work', terminals: [{ terminal: 't8', pane: 'p-user' }] };
  const project = (tabs) => [{ ...space('spproject1', 'fabraik', [], null, root), tabs }];
  const closeCalls = (job) => job.app.filter(([, command]) => command === 'pane.close' || command === 'tab.close');
  const terminalAddresses = (tab) => tab.terminals.map(({ terminal }) => terminal);

  const [freshSpace] = project([structuredClone(existingTab)]);
  const fresh = jobFixture({ root, spaces: [freshSpace], pages: READY_BOARD() });
  fresh.launch = { code: 0, stdout: JSON.stringify({ address: 't14g' }), stderr: '' };
  assert.equal(await fresh.start(5), 0, fresh.lines.join('\n'));
  const freshTab = freshSpace.tabs.find(({ name }) => name === 'job 5');
  assert.deepEqual(terminalAddresses(freshTab), ['t14g'], 'the fresh job tab contains only the job terminal');
  const [created] = fresh.app.filter(([, command]) => command === 'tab.new');
  assert.deepEqual(flagsOf(created), { space: 'spproject1', name: 'job 5', folder: root, focus: 'false', mod: 'help' });
  assert.deepEqual(fresh.runs(), [jobRunArgs('fabraik-job-5', 5, freshTab.id, root)]);
  assert.equal(closeCalls(fresh).length, 1);
  const [{ pane, listed }] = fresh.paneCloses;
  assert.equal(pane, 'p-tb-job-5');
  const attached = listed.find(({ id }) => id === freshSpace.id)?.tabs.find(({ id }) => id === freshTab.id);
  assert.deepEqual(terminalAddresses(attached), ['t14g'], 'the app listed the exact job in the new tab before the help pane closed');
  assert.equal(fresh.helpPanes.size, 0);
  assert.deepEqual(freshSpace.tabs[0], existingTab);

  const reusedTab = { ...structuredClone(existingTab), id: 'tb-existing', name: 'job 5' };
  const reused = jobFixture({ root, spaces: project([reusedTab]), pages: READY_BOARD() });
  assert.equal(await reused.start(5), 0, reused.lines.join('\n'));
  assert.ok(!reused.app.some(([, command]) => command === 'tab.new'));
  assert.deepEqual(closeCalls(reused), []);
  assert.deepEqual(reusedTab.terminals, [...existingTab.terminals, { terminal: 't10', pane: 'p-t10' }]);

  const [unreadableSpace] = project([structuredClone(existingTab)]);
  const unreadable = jobFixture({ root, spaces: [unreadableSpace], pages: READY_BOARD(), onLaunch: () => {
    unreadable.replies['app ls'] = { code: 1, stdout: '', stderr: 'layout read refused' };
  } });
  await unreadable.start(5);
  assert.match(unreadable.lines.join('\n'), /layout read refused/);
  assert.deepEqual(closeCalls(unreadable), []);
  assert.deepEqual(unreadableSpace.tabs[0], existingTab);
  assert.deepEqual(terminalAddresses(unreadableSpace.tabs[1]), ['t10'], 'the launched terminal is preserved');
  assert.ok(unreadable.helpPanes.has('p-tb-job-5'));
});

test('ANTI-REGRESSION: a coordinated job session starts under its run mark, bound to its one card', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const sessions = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'];
  for (const [index, card] of [5, 6].entries()) {
    const job = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, root)], pages: READY_BOARD() });
    assert.equal(await job.start(card, { newSessionId: () => sessions[index] }), 0, job.lines.join('\n'));
    assert.equal(job.runs().length, 1);
    const [run] = job.runs();
    const command = run.slice(run.indexOf('--', run.indexOf('--label')) + 1);
    const launched = command.slice(command.indexOf('/usr/bin/env') + 1, command.indexOf('claude'));
    // The guard's environment contract: the run mark is a run start in the RUN_START form and the binding is this card alone.
    assert.deepEqual(launched.filter((word) => word.startsWith('PRE_APPROVED_RUN_')), [`PRE_APPROVED_RUN_SESSION=${RUN_AT}`, `PRE_APPROVED_RUN_CARD=${card}`]);
    // The labels hold the same mark and card, and the one session id the command carries.
    const labels = Object.fromEntries(run.flatMap((word, i) => (run[i - 1] === '--label' ? [word.split('=')] : [])));
    assert.equal(labels['fabraik.runstart'], RUN_AT);
    assert.equal(labels['fabraik.card'], String(card));
    assert.equal(labels['fabraik.session'], sessions[index]);
    assert.equal(command[command.indexOf('--session-id') + 1], sessions[index]);
    assert.equal(command.at(-1), JOB_PROMPT(card), 'the prompt names the same card the binding does');
  }
});

test('ANTI-REGRESSION: a coordinator start refuses a held unfinished job and starts a released one', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const spaces = () => [space('spproject1', 'fabraik', [['tb1', '1']], null, root)];
  // Card 7's branch job/7 exists and its newest comment asks the owner; card 8's worktree job-8 exists while its card is in
  // Backlog. Each is held as resume holds it: the start refuses, naming the hold, and opens and runs nothing.
  const board = (column) => [leanBoardPage([issue(7, { status: 'In progress' }), issue(8, { status: column })])];
  const details = { 7: [CLAIM_HERE, 'Needs owner: Pick the panel colours. Job: job/7 on here.'] };
  /** @type {[number, string][]} */
  const holds = [[7, 'held: its card has a Needs owner: comment'], [8, 'held: its card is in Backlog']];
  for (const [card, hold] of holds) {
    const job = jobFixture({ root, spaces: spaces(), pages: board('Backlog'), details, branches: [7], worktrees: [8] });
    assert.equal(await job.start(card), 1, `card ${card}: ${job.lines.join('\n')}`);
    assert.equal(job.lines.length, 1, job.lines.join('\n'));
    assert.match(job.lines[0], new RegExp(`^Card ${card} is not started: .*${escaped(hold)}`));
    assert.deepEqual(job.runs(), [], `card ${card} starts nothing`);
    assert.ok(!job.app.some((args) => args[0] === 'do'), `card ${card} opens no tab`);
  }

  // Moving card 8 to Ready releases its column hold: its job starts.
  const released = jobFixture({ root, spaces: spaces(), pages: board('Ready'), details, branches: [7], worktrees: [8] });
  assert.equal(await released.start(8), 0, released.lines.join('\n'));
  assert.deepEqual(released.runs(), [jobRunArgs('fabraik-job-8', 8, 'tb-job-8', root)]);

  // A stopped live terminal of a held card is not continued: the start refuses, changes no label, sends nothing, and unfinished says held.
  const stopped = jobFixture({ root, spaces: spaces(), pages: board('In progress'), details, branches: [7] });
  stopped.addJob('t7', 7, 'claude', 'done', { 'fabraik.stopped': 'limit' });
  assert.equal(await stopped.start(7), 1, stopped.lines.join('\n'));
  assert.equal(stopped.lines.length, 1, stopped.lines.join('\n'));
  assert.match(stopped.lines[0], /^Card 7 is not started: .*held: its card has a Needs owner: comment/);
  assert.deepEqual(stopped.calls.filter(([kind]) => ['label', 'send', 'run'].includes(kind)), [], 'no label, send or launch');
  assert.equal(stopped.details.t7.labels['fabraik.stopped'], 'limit');
  stopped.lines.length = 0;
  assert.equal(await stopped.unfinished(), 0, stopped.lines.join('\n'));
  assert.deepEqual(stopped.lines, ['#7 held: its card has a Needs owner: comment']);
});

// The unfinished jobs' fixture: a project space, the board `nodes` (unless `rest` names its `pages`), and what `rest` says the
// repository and the tracker hold.
const unfinishedFixture = (nodes, rest) => jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: [leanBoardPage(nodes)], ...rest });
// Card `number` closed as completed, in Done.
const closedIssue = (number) => leanNode({ id: `PVTI_${number}`, title: `Card ${number}`, status: 'Done', content: { __typename: 'Issue', number, state: 'CLOSED', blockers: [] } });
// Adds the live terminal `address` holding only its shell, in folder `cwd`, with no label, as `hc ls --json` and `hc get --json` show it.
function addShell(job, address, cwd) {
  const pid = 2000 + Number(address.slice(1));
  job.terminals.push({ address, agent: 'bash', cwd, name: `shell-${address}`, parent: null, state: 'live', turn: 0 });
  job.details[address] = { address, cwd, state: 'live', keep: true, pid, argv: ['/usr/bin/bash'], foreground: { name: 'bash', pid }, status: null, labels: {} };
}
const worktreeOf = (card) => `${ROOT}/.claude/worktrees/job-${card}`;

test('ANTI-REGRESSION: unfinished lists each job from its branch, worktree or draft pull request with the verdict its card and Herdr give', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const nodes = [issue(5, { status: 'In progress' }), issue(6, { status: 'In progress' }), issue(7, { status: 'In progress' }), issue(8, { status: 'Backlog' }),
    issue(9, { status: 'In review' }), issue(10, { status: 'In review' }), issue(11), closedIssue(12), issue(13, { status: 'In progress' }),
    issue(14, { status: 'In review' })];
  // Each draft's newest claim decides, whatever an older claim says.
  const details = { 7: [CLAIM_HERE, 'Needs owner: Pick the panel colours. Job: job/7 on here.'],
    9: [CLAIM_HERE, 'Claim: there, Claude Code, 2026-11-18T10:00Z'], 10: ['Claim: there, Claude Code, 2026-11-18T08:00Z', CLAIM_HERE],
    14: ['Claim: here, Claude Code cloud, 2026-11-18T09:00Z'] };
  const drafts = [{ number: 40, headRefName: 'job/9' }, { number: 41, headRefName: 'job/10' }, { number: 42, headRefName: 'job/14' }];
  const job = unfinishedFixture(nodes, { details, drafts, branches: [5, 6, 7, 11, 12], worktrees: [8, 13] });
  // Card 6's job runs Claude in its labelled terminal; card 13's worktree holds only a shell, which runs nothing for it.
  job.addJob('t6', 6, 'claude', 'working');
  addShell(job, 't13', worktreeOf(13));

  assert.equal(await job.unfinished(), 0, job.lines.join('\n'));
  const expected = [/^#5 continue: .*\bjob\/5\b/, /^#6 running: terminal t6$/, /^#7 held: its card has a Needs owner: comment$/,
    /^#8 held: its card is in Backlog$/, /^#9 elsewhere: draft pull request #40, claimed by there, Claude Code$/, /^#10 continue: .*#41\b/,
    /^#11 continue: .*\bjob\/11\b/, /^#12 held: its card is closed$/, /^#13 continue: .*\bjob-13\b/,
    /^#14 elsewhere: draft pull request #42, claimed by here, Claude Code cloud$/];
  assert.equal(job.lines.length, expected.length, job.lines.join('\n'));
  expected.forEach((line, index) => assert.match(job.lines[index], line));
  assert.deepEqual(job.calls.filter(([kind]) => !['ls', 'get'].includes(kind)), [], 'listing only reads Herdr');
  assert.deepEqual(job.app.filter(([kind]) => kind === 'do'), [], 'listing opens nothing');
});

test('ANTI-REGRESSION: unfinished whose Herdr, repository or tracker read fails prints no verdict and exits 1', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // Card 6 has its branch and a labelled job terminal, card 13 its worktree and a shell in it, card 9 a draft claimed elsewhere.
  const nodes = [issue(6, { status: 'In progress' }), issue(9, { status: 'In review' }), issue(13, { status: 'In progress' })];
  const base = { details: { 9: ['Claim: there, Claude Code, 2026-11-18T10:00Z'] }, drafts: [{ number: 40, headRefName: 'job/9' }], branches: [6], worktrees: [13] };
  const arrange = (job) => {
    job.addJob('t6', 6, 'claude', 'working');
    addShell(job, 't13', worktreeOf(13));
  };
  const failing = (text) => () => { throw new Error(text); };
  const repositoryFails = (verb) => () => {
    const git = gitFor(settingsText(), [], { branches: [6], worktrees: [13] });
    return { git: (args) => (args[0] === verb ? failing(`fatal: ${verb} failed`)() : git(args)) };
  };
  /** @type {[string, Record<string, unknown>, (job: any) => Record<string, unknown> | void, RegExp][]} */
  const cases = [
    ['the branch read failing', {}, repositoryFails('for-each-ref'), /for-each-ref failed/],
    ['the worktree read failing', {}, repositoryFails('worktree'), /worktree failed/],
    ['hc ls failing', {}, (job) => { job.replies.ls = { code: 1, stdout: '', stderr: 'herdr is not running' }; }, /herdr is not running/],
    ['hc ls answering what is no listing', {}, (job) => { job.replies.ls = { code: 0, stdout: 'not json', stderr: '' }; }, /hc ls/],
    ['hc get of a listed job terminal exiting 3', {}, (job) => { job.replies.t6 = { code: 3, stdout: '', stderr: 'not_found: t6' }; }, /\bt6\b/],
    ['hc get of a shell in a job worktree exiting 3', {}, (job) => { job.replies.t13 = { code: 3, stdout: '', stderr: 'not_found: t13' }; }, /\bt13\b/],
    ['the board read failing', { pages: failing('HTTP 502: Bad Gateway') }, () => {}, /./],
    ['the card detail read failing', { details: failing('HTTP 502: Bad Gateway') }, () => {}, /./],
    ['a draft-only card whose newest comments hold no claim and whose older ones were not read',
      { details: { 9: { newest: ['A later comment'], older: 1 } } }, () => {}, /./],
    ['the draft pull request list failing', { drafts: failing('HTTP 502: Bad Gateway') }, () => {}, /./],
    ['the draft pull request list answering what is no list', { drafts: () => '{"number":40}' }, () => {}, /./],
  ];
  for (const [label, tracker, fail, cause] of cases) {
    const job = unfinishedFixture(nodes, { ...base, ...tracker });
    arrange(job);
    const options = fail(job) ?? {};
    assert.equal(await job.unfinished(options), 1, `${label}: ${job.lines.join('\n')}`);
    assert.equal(job.lines.length, 1, `${label}: ${job.lines.join('\n')}`);
    assert.match(job.lines[0], /^Unfinished jobs unknown: \S/, label);
    assert.match(job.lines[0], cause, `${label} names its cause`);
  }

  // A running job's failed card detail read is not hidden by its running terminal, whatever else is unfinished.
  const alone = unfinishedFixture([issue(6, { status: 'In progress' })], { details: failing('HTTP 502: Bad Gateway'), branches: [6] });
  alone.addJob('t6', 6, 'claude', 'working');
  assert.equal(await alone.unfinished(), 1, alone.lines.join('\n'));
  assert.equal(alone.lines.length, 1, alone.lines.join('\n'));
  assert.match(alone.lines[0], /^Unfinished jobs unknown: \S/);
});

test('ANTI-REGRESSION: unfinished reads the issue of a card missing from the board read', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // The board holds only card 5; card 29 has a job branch but is not on the board read.
  const board = [issue(5, { status: 'In progress' })];
  const closed = unfinishedFixture(board, { branches: [5, 29], issues: { 29: 'CLOSED' } });
  assert.equal(await closed.unfinished(), 0, closed.lines.join('\n'));
  assert.deepEqual(closed.lines, ['#5 continue: branch job/5', '#29 held: its card is closed']);

  const open = unfinishedFixture(board, { branches: [5, 29], issues: { 29: 'OPEN' } });
  assert.equal(await open.unfinished(), 1, open.lines.join('\n'));
  assert.equal(open.lines.length, 1, open.lines.join('\n'));
  assert.equal(open.lines[0], 'Unfinished jobs unknown: card #29 is open but not on the board read');

  const unreadable = unfinishedFixture(board, { branches: [5, 29], issues: {} });
  assert.equal(await unreadable.unfinished(), 1, unreadable.lines.join('\n'));
  assert.equal(unreadable.lines.length, 1, unreadable.lines.join('\n'));
  assert.match(unreadable.lines[0], /^Unfinished jobs unknown: .*#29\b.*Could not resolve to an issue/);
});

test('a coordinator start refuses a card whose job session still runs, and reads nothing', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const spaces = [space('spproject1', 'fabraik', [['tb1', '1']], null, root)];
  const job = jobFixture({ root, spaces, pages: READY_BOARD() });

  // An accepted start reads the board once.
  assert.equal(await job.start(5), 0, job.lines.join('\n'));
  assert.deepEqual(job.tracker.log.gh, START_READS);
  assert.equal(job.runs().length, 1);

  // Its job terminal now runs Claude: asking again is refused, naming it, with no read of GitHub and no start. Another card's
  // terminal and an unlabelled one are not this card's.
  job.addJob('t9', 5, 'claude');
  job.addJob('t8', 6, 'claude');
  job.terminals.push({ address: 't3', agent: 'node', cwd: ROOT, name: 'someone-else', parent: 't0', state: 'live', turn: 0 });
  job.lines.length = 0;
  const tabsBefore = job.app.filter((args) => args[1] === 'tab.new').length;
  assert.equal(await job.start(5), 1);
  assert.equal(job.lines.length, 1);
  assert.match(job.lines[0], /^Card 5 not started: .*\bt9\b/);
  assert.doesNotMatch(job.lines[0], /\bt8\b|\bt3\b/);
  assert.deepEqual(job.tracker.log.gh, START_READS, 'a refused start reads nothing from GitHub');
  assert.equal(job.runs().length, 1, 'a refused start runs nothing');
  assert.equal(job.app.filter((args) => args[1] === 'tab.new').length, tabsBefore);

  // A recovered shell in which Claude was later run by hand (its foreground is another process than the terminal's own) still
  // runs Claude for its card: refused as running, with no kill and no launch.
  const hand = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: READY_BOARD() });
  hand.addJob('t70', 5, 'claude');
  Object.assign(hand.details.t70, { pid: 6775, argv: ['/usr/bin/bash'], foreground: { name: 'claude', pid: 26544 } });
  assert.equal(await hand.start(5), 1);
  assert.match(hand.lines.join('\n'), /^Card 5 not started: .*\bt70\b.* is still running a program for it/);
  assert.deepEqual(hand.calls.filter(([kind]) => ['kill', 'run'].includes(kind)), [], 'a refused start kills and runs nothing');

  // A coordinator terminal that names no HC_TERMINAL_ID refuses before it reads anything.
  const callsBefore = job.calls.length;
  const appBefore = job.app.length;
  job.lines.length = 0;
  assert.equal(await job.start(6, { parent: undefined }), 1);
  assert.deepEqual(job.lines, ['Card 6 not started: HC_TERMINAL_ID names no coordinator terminal.']);
  assert.equal(job.calls.length, callsBefore);
  assert.equal(job.app.length, appBefore, 'no herdr-app call');
  assert.deepEqual(job.tracker.log.gh, START_READS);
});

test('coordinator refuses a board read whose card content did not resolve', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // Card 5 is startable; the second Ready item's content did not resolve, so the read cannot say what else is startable.
  const board = () => [leanBoardPage([issue(5), leanNode({ id: 'PVTI_unresolved', title: 'Unresolved', status: 'Ready', content: null })])];
  const listed = trackerFor({ pages: board() });
  const lines = [];
  assert.equal(await listCards({ ...listed.options, print: (line) => lines.push(line) }), 1, lines.join('\n'));
  assert.ok(lines.some((line) => /unresolved/i.test(line)), `the refusal names the unresolved content: ${lines.join('\n')}`);
  assert.ok(!lines.some((line) => /no startable/i.test(line)), 'an incomplete read never reports an empty Ready column');

  const job = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: board() });
  assert.equal(await job.start(5), 1, job.lines.join('\n'));
  assert.ok(job.lines.some((line) => /unresolved/i.test(line)), `the refusal names the unresolved content: ${job.lines.join('\n')}`);
  assert.deepEqual(job.runs(), [], 'no job driver starts');
  assert.ok(!job.app.some((args) => args[0] === 'do'), 'no tab is opened');
});

test('coordinator lists and starts only the cards the lead\'s candidate rule takes', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // A Ready card as the lead's candidate rule judges it: card 6 is still a proposal, card 7 is assigned and card 8 is an
  // epic parent, so only card 5 is a candidate.
  const card = (number, title, content = {}) =>
    leanNode({ id: `PVTI_${number}`, title, status: 'Ready', content: { __typename: 'Issue', number, title, blockers: [], ...content } });
  const board = () => [leanBoardPage([card(5, 'Card 5'), card(6, 'Proposed: Card 6'), card(7, 'Card 7', { assignees: ['owner'] }),
    card(8, 'Card 8', { ...(KIND_TYPES ? { issueType: { name: KIND_TYPES.epic } } : { labels: [KIND_LABELS.epic] }), subIssuesSummary: { total: 2, completed: 0 } })])];
  const listed = trackerFor({ pages: board() });
  const lines = [];
  assert.equal(await listCards({ ...listed.options, print: (line) => lines.push(line) }), 0);
  assert.deepEqual(lines, ['#5 Card 5']);

  for (const number of [6, 7, 8]) {
    const refused = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: board() });
    assert.equal(await refused.start(number), 1, `card ${number}: ${refused.lines.join('\n')}`);
    assert.deepEqual(refused.runs(), [], `card ${number} starts no job driver`);
    assert.ok(!refused.app.some((args) => args[0] === 'do'), `card ${number} opens no tab`);
  }
  const root = fabraikRepository(t);
  const started = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, root)], pages: board() });
  assert.equal(await started.start(5), 0, started.lines.join('\n'));
  assert.ok(started.app.some((args) => args[1] === 'tab.new'), 'card 5 opens its tab');
});

test('a coordinator start counts running places from Herdr, and a job waiting on the owner takes none', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const spaces = () => [space('spproject1', 'fabraik', [['tb1', '1']], null, root)];
  // Two jobs run, one waits on the owner at a question menu, and a kept terminal holds a shell where Claude ran.
  const crowd = (job) => {
    job.addJob('t11', 11, 'claude', 'working');
    job.addJob('t12', 12, 'claude', 'blocked');
    job.addJob('t13', 13, 'bash');
    job.addJob('t14', 14, 'claude', 'done');
  };

  // At the cap of two the waiting job and the shell take no place: cards 11 and 14 do, so the start is refused and launches nothing.
  const full = jobFixture({ root, spaces: spaces(), pages: READY_BOARD() });
  crowd(full);
  assert.equal(await full.start(5, { cap: () => 2 }), 1);
  assert.deepEqual(full.lines, ['Card 5 not started: 2 of 2 running places are taken (cards 11, 14); a job waiting on the owner takes none.']);
  assert.deepEqual(full.runs(), []);
  assert.ok(!full.app.some((args) => args[0] === 'do'), 'a refused start opens no tab');

  // Under the cap of three the same crowd leaves a place, and the launch happens inside the lock.
  const room = jobFixture({ root, spaces: spaces(), pages: READY_BOARD() });
  crowd(room);
  const capLock = async (work) => {
    room.calls.push(['<lock>']);
    try {
      return await work();
    } finally {
      room.calls.push(['</lock>']);
    }
  };
  assert.equal(await room.start(5, { cap: () => 3, capLock }), 0, room.lines.join('\n'));
  const names = room.calls.map(([kind]) => kind);
  assert.deepEqual(room.runs(), [jobRunArgs('fabraik-job-5', 5, 'tb-job-5', root)]);
  assert.ok(names.indexOf('<lock>') < names.indexOf('run') && names.indexOf('run') < names.indexOf('</lock>'), `the launch is inside the lock: ${names}`);
  assert.ok(room.calls.some(([kind, ...rest]) => kind === 'ls' && rest.includes('fabraik.role=job') && !rest.some((word) => word.startsWith('fabraik.card='))),
    'running places are listed across every job, not only this card');

  // A job just launched still shows the launch form's `env` in the foreground and no status: it takes a place at a cap of one, so
  // two quick starts cannot both take it.
  const starting = jobFixture({ root, spaces: spaces(), pages: READY_BOARD() });
  starting.addJob('t11', 11, 'env', null);
  assert.equal(await starting.start(5, { cap: () => 1 }), 1);
  assert.deepEqual(starting.lines, ['Card 5 not started: 1 of 1 running places are taken (cards 11); a job waiting on the owner takes none.']);
  assert.deepEqual(starting.runs(), []);

  // A record that holds only the shell Herdr's keep substituted takes none.
  const shell = jobFixture({ root, spaces: spaces(), pages: READY_BOARD() });
  shell.addJob('t13', 13, 'bash', null);
  assert.equal(await shell.start(5, { cap: () => 1 }), 0, shell.lines.join('\n'));
  assert.deepEqual(shell.runs(), [jobRunArgs('fabraik-job-5', 5, 'tb-job-5', root)]);
});

test('a coordinator start does not count a stopped job\'s place, and counts it again once it works', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const arrange = (status) => {
    const job = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, root)], pages: [leanBoardPage([issue(12)])] });
    job.addJob('t11', 11, 'claude', status, { 'fabraik.stopped': 'context' });
    return job;
  };

  // A live Claude that is not working and carries the diagnosis label frees its place at a cap of one: card 12 starts.
  const stopped = arrange('done');
  assert.equal(await stopped.start(12, { cap: () => 1 }), 0, stopped.lines.join('\n'));
  assert.deepEqual(stopped.runs(), [jobRunArgs('fabraik-job-12', 12, 'tb-job-12', root)]);

  // The same job working again takes its place back, whatever its label says: the start is refused and launches nothing.
  const working = arrange('working');
  assert.equal(await working.start(12, { cap: () => 1 }), 1);
  assert.deepEqual(working.lines, ['Card 12 not started: 1 of 1 running places are taken (cards 11); a job waiting on the owner takes none.']);
  assert.deepEqual(working.runs(), []);
});

test('a coordinator start continues a stopped live job in its own terminal only when a place is free', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const arrange = () => {
    const job = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: [leanBoardPage([issue(11, { status: 'In progress' })])], branches: [11] });
    job.addJob('t11', 11, 'claude', 'done', { 'fabraik.stopped': 'context' });
    return job;
  };
  const changes = (job) => job.calls.filter(([kind]) => ['label', 'send', 'run', 'kill', 'rm'].includes(kind));

  // At the cap of one another running job holds the only place: refused, the label stays and nothing is sent.
  const full = arrange();
  full.addJob('t12', 12, 'claude', 'working');
  assert.equal(await full.start(11, { cap: () => 1 }), 1);
  assert.match(full.lines.join('\n'), /^Card 11 not started: 1 of 1 running places are taken \(cards 12\)/);
  assert.deepEqual(changes(full), [], 'a full cap changes nothing and sends nothing');
  assert.equal(full.details.t11.labels['fabraik.stopped'], 'context');

  // With a place free the label goes first, then the message is sent to the same terminal with no force, and no session launches.
  const room = arrange();
  assert.equal(await room.start(11, { cap: () => 1 }), 0, room.lines.join('\n'));
  assert.deepEqual(changes(room), [['label', 't11', 'fabraik.stopped='], ['send', 't11', 'Carry on with card #11.']]);
  assert.equal(room.details.t11.labels['fabraik.stopped'], '');
  assert.deepEqual(room.app.filter((args) => args[1] === 'tab.new'), [], 'no tab opens');

  // A stopped terminal with no job labels, found by its folder in the card's worktree, is continued in place, and no session starts beside it.
  const unlabelled = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: [leanBoardPage([issue(11, { status: 'In progress' })])],
    branches: [11], worktrees: [11] });
  unlabelled.addJob('t11', 11, 'claude', 'done', { 'fabraik.stopped': 'overload' });
  Object.assign(unlabelled.terminals[0], { cwd: worktreeOf(11) });
  unlabelled.details.t11.labels = { 'fabraik.stopped': 'overload' };
  assert.equal(await unlabelled.start(11, { cap: () => 1 }), 0, unlabelled.lines.join('\n'));
  assert.deepEqual(changes(unlabelled), [['label', 't11', 'fabraik.stopped='], ['send', 't11', 'Carry on with card #11.']]);
  assert.deepEqual(unlabelled.app.filter((args) => args[1] === 'tab.new'), [], 'no tab opens');
});

test('ANTI-REGRESSION: a coordinator start whose running places or cap cannot be read starts nothing and says why', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const bad = (address, replace) => (job) => {
    job.addJob(address, 11, 'claude', 'working');
    replace(job, address);
  };
  /** @type {[string, (job: any) => void, Record<string, unknown>, RegExp][]} */
  const cases = [
    ['malformed JSON from hc get', bad('t11', (job, a) => { job.replies[a] = { code: 0, stdout: '{not json', stderr: '' }; }), {}, /t11/],
    ['hc get exiting 1', bad('t11', (job, a) => { job.replies[a] = { code: 1, stdout: '', stderr: 'no terminal t11' }; }), {}, /t11/],
    ['a missing status', bad('t11', (job, a) => { delete job.details[a].status; }), {}, /t11/],
    ['a live terminal with no foreground', bad('t11', (job, a) => { delete job.details[a].foreground; }), {}, /t11/],
    ['a live foreground with no pid', bad('t11', (job, a) => { job.details[a].foreground = {}; }), {}, /t11/],
    ['a live record with an empty argv', bad('t11', (job, a) => { job.details[a].argv = []; }), {}, /t11/],
    ['an hc ls entry with no state', bad('t11', (job) => { delete job.terminals[0].state; }), {}, /t11/],
    ['a cap of 0', (job) => job.addJob('t11', 11, 'claude', 'working'), { cap: () => 0 }, /cap/i],
    ['a cap file that cannot be read', () => {}, { cap: () => { throw new Error('lead.json is not JSON: Unexpected token'); } }, /lead\.json is not JSON/],
    ['a lock that stayed locked', () => {}, { capLock: async () => { throw new Error('cap.lock stayed locked for 5 s'); } }, /cap\.lock stayed locked/],
  ];
  for (const [label, arrange, options, cause] of cases) {
    const job = jobFixture({ spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)], pages: READY_BOARD() });
    arrange(job);
    assert.equal(await job.start(5, options), 1, `${label}: ${job.lines.join('\n')}`);
    assert.deepEqual(job.runs(), [], `${label} starts nothing`);
    assert.match(job.lines.join('\n'), /^Card 5 not started: /, label);
    assert.match(job.lines.join('\n'), cause, `${label} names its cause`);
  }
});

// A kept job session as the S1 live check recorded it (iv and v): its session, its
// run start, and the prompt it is resumed with.
const KEPT_SESSION = '9cfca99b-cf2b-447c-a7c8-bfca98b32db7';
const KEPT_RUN = '2026-11-19T12:06:00Z';
const RESUME_PROMPT = (card) => `Your session was resumed after a restart. If you were waiting on the owner, first re-run node scripts/board.mjs --waits ${card} --herdr; if it still names show-me-first, ask again through your question menu with the answer I removed the marker. Otherwise carry on with card #${card}.`;
const keptLabels = (card, { session = KEPT_SESSION, runStart = KEPT_RUN } = {}) => ({ 'fabraik.card': String(card), 'fabraik.role': 'job',
  'fabraik.runstart': runStart, 'fabraik.session': session, 'fabraik.space': 'spproject1', 'herdr.space': 'spproject1', 'herdr.tab': `tbjob${card}` });

// Card `card`'s job terminal whose Claude is gone, in the shapes `hc ls --all --json` and `hc get --json` print (S1): `live`, a
// kept terminal Herdr recovered with a shell in Claude's place (iv); `finished`, one whose Claude exited 1 (v).
function keptTerminal(address, card, state, labels = keptLabels(card)) {
  const name = `fabraik-job-${card}`;
  const common = { address, cwd: ROOT, die_with_parent: false, identity: 'ghostty', keep: true, labels, name, notify: true, parent: 't0',
    reported: false, rm: false, screen: 'exact', signal: null, status: null, template: null };
  return state === 'live'
    ? { entry: { address, agent: 'bash', cwd: ROOT, name, parent: 't0', state, turn: 1 },
      record: { ...common, argv: ['/usr/bin/bash'], cols: 200, created_ms: 1795089982434, exit_code: null, finished_ms: null,
        foreground: { argv: ['/usr/bin/bash'], cwd: ROOT, name: 'bash', pid: 3853863 }, pid: 3853863, reason: null, rows: 120, state,
        status_ms: 1795089999871, title: 'user@host:~/project', turn: 1 } }
    : { entry: { address, agent: 'claude', cwd: ROOT, exit_code: 1, name, parent: 't0', reason: 'exited', state, turn: 0 },
      record: { ...common, argv: ['claude', '--resume', labels['fabraik.session']], cols: 21, created_ms: 1795089909960, exit_code: 1,
        finished_ms: 1795089911239, pid: 3736801, reason: 'exited', rows: 56, state, status_ms: null, title: '', turn: 0 } };
}

// Adds a kept terminal to a job fixture.
function addKept(job, address, card, state, labels) {
  const { entry, record } = keptTerminal(address, card, state, labels);
  job.terminals.push(entry);
  job.details[address] = record;
}

// Makes the fixture's `hc run` launch the replacement `address`, live and running Claude, which `hc get` reads with `labels`.
function launchesReplacement(job, address, labels) {
  job.launch = { code: 0, stdout: JSON.stringify({ address, agent: 'claude', cwd: ROOT, name: 'fabraik-job-5', parent: 't0', state: 'live', turn: 0 }), stderr: '' };
  job.details[address] = { address, argv: ['/usr/bin/env'], cwd: ROOT, exit_code: null, finished_ms: null, foreground: { name: 'claude' }, keep: true, labels,
    name: 'fabraik-job-5', parent: 't0', state: 'live', status: null };
}

// The exact `hc run` that resumes card `card`'s kept session in its tab `tab`, under the recorded session and run start, from
// the real repository `root` under the workflow version `commit`.
const resumeRunArgs = (card, tab, root, commit) => ['run', '--bg', '--keep', '--parent', 't0', '--outlive-parent', '--name', `fabraik-job-${card}`, '--cwd', root,
  '--label', 'herdr.space=spproject1', '--label', `herdr.tab=${tab}`, '--label', 'fabraik.role=job', '--label', 'fabraik.space=spproject1',
  '--label', `fabraik.card=${card}`, '--label', `fabraik.session=${KEPT_SESSION}`, '--label', `fabraik.workflow=${commit}`, '--label', `fabraik.runstart=${KEPT_RUN}`,
  '--json', '--', '/usr/bin/env', `PRE_APPROVED_RUN_SESSION=${KEPT_RUN}`, `PRE_APPROVED_RUN_CARD=${card}`, 'FABRAIK_COORDINATED_JOB=1', pinMark(root, commit),
  'ANTHROPIC_MODEL=sonnet', 'CLAUDE_CODE_EFFORT_LEVEL=high', 'claude', '--permission-mode', 'auto', '--resume', KEPT_SESSION, '--', RESUME_PROMPT(card)];

// The line a start prints when card `card`'s session `id` cannot be resumed, its record at `address`; the cause is free.
const unresumable = (card, id, address) =>
  new RegExp(`^Card ${card}'s session ${escaped(id)} could not be resumed: (.+); nothing was started\\. hc rm ${escaped(address)} lets start begin card ${card} as a new session\\.$`);

// Card 5's job with its tab open and its branch job/5; the options give it the recorded transcript `kind`.
const resumeFixture = (root = ROOT) => jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1'], ['tbjob5', 'job 5']], null, root)], pages: READY_BOARD(), branches: [5] });
const resumeOptions = (kind) => ({ transcript: (id) => (id === KEPT_SESSION ? kind : undefined) });

test('a coordinator start resumes a job whose kept terminal lost its session, under its recorded session and run start', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // After a restart card 5's kept terminal holds a shell where Claude ran; at a cap of one it takes no place, so its own
  // recovery is not refused.
  // Its record carries no workflow version, so it resumes under local main.
  const root = fabraikRepository(t);
  const main = pinGit(root, 'rev-parse', 'refs/heads/main');
  const job = resumeFixture(root);
  addKept(job, 't11', 5, 'live');
  launchesReplacement(job, 't20', workflowLabels(main));
  const looked = [];
  const options = { cap: () => 1, transcript: (id) => { looked.push(id); return id === KEPT_SESSION ? 'file' : undefined; } };
  assert.equal(await job.start(5, options), 0, job.lines.join('\n'));
  assert.ok(looked.includes(KEPT_SESSION), 'the recorded transcript is checked');

  // The old shell is ended, the replacement launched and read, and only then the old record removed.
  const effects = job.calls.filter(([kind, target]) => ['kill', 'run', 'rm'].includes(kind) || (kind === 'get' && target === 't20'))
    .map(([kind, target]) => (kind === 'run' ? 'run' : `${kind} ${target}`));
  assert.deepEqual(effects, ['kill t11', 'run', 'get t20', 'rm t11']);
  // The replacement resumes the recorded session under the same labels, run mark and card binding, as this coordinator's child.
  assert.deepEqual(job.runs(), [resumeRunArgs(5, 'tbjob5', root, main)]);

  // It is reported as resuming and not yet confirmed, never as resumed.
  const said = job.lines.join('\n');
  assert.match(said, /resuming/i);
  assert.match(said, /not yet confirmed/i);
  assert.doesNotMatch(said, /\bresumed\b/i);
});

// new behaviour: a Herdr job waits in Awaiting push only for the show-me-first marker, so a restart resumes a card there
// as it resumes an underway job only while the card carries the marker; its prompt has it re-run the Herdr wait verdict
// and, where the card is still marked, ask the owner again through its question menu. A claim does not record Herdr, so
// an unmarked card in Awaiting push is an ordinary job waiting on the owner and stays held.
test('967 an Awaiting push card restarts only while it carries show-me-first', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const root = fabraikRepository(t);
  const main = pinGit(root, 'rev-parse', 'refs/heads/main');
  const waiting = (labels) => {
    const job = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1'], ['tbjob5', 'job 5']], null, root)],
      pages: [leanBoardPage([leanNode({ id: 'PVTI_5', title: 'Card 5', status: 'Awaiting push', content: { __typename: 'Issue', number: 5, blockers: [], labels } })])],
      branches: [5] });
    addKept(job, 't11', 5, 'live');
    launchesReplacement(job, 't20', workflowLabels(main));
    return job;
  };

  const marked = waiting(['show-me-first']);
  assert.equal(await marked.start(5, { cap: () => 1, ...resumeOptions('file') }), 0, marked.lines.join('\n'));
  assert.deepEqual(marked.runs(), [resumeRunArgs(5, 'tbjob5', root, main)]);

  const unmarked = waiting([]);
  assert.equal(await unmarked.start(5, { cap: () => 1, ...resumeOptions('file') }), 1, unmarked.lines.join('\n'));
  assert.match(unmarked.lines.join('\n'), /^Card 5 is not started: .*held: .*Awaiting push/m);
  assert.deepEqual(unmarked.runs(), [], 'nothing is launched');
});

// A real repository standing for the root checkout a coordinator starts jobs from, so version selection, the snapshot
// store and drift run on git itself. It holds the shared contracts drift compares, and its main and origin/main start at
// one commit; git, never the coordinator, says which commit each ref names.
const pinGit = (cwd, ...args) => {
  const done = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...gitEnvironment(), GIT_NO_REPLACE_OBJECTS: '1' } });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
};
const LANE_CONTRACT = 'scripts/lib/delivery-lane-contract.test.mjs';
// Gives every directory under `path` back its write bit, so a read-only snapshot can be removed.
function writable(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, (stat.mode & 0o7777) | 0o700);
  for (const name of readdirSync(path)) writable(join(path, name));
}
function workflowRepository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-pin-')));
  t.after(() => {
    writable(root);
    rmSync(root, { recursive: true, force: true });
  });
  commitWorkflow(root);
  return root;
}
// Makes `root` a repository whose one commit M1, on main and origin/main, holds the three shared contracts and notes.txt.
function commitWorkflow(root) {
  pinGit(root, 'init', '-b', 'main');
  for (const [path, text] of [['.claude/settings.json', '{"hooks":{}}\n'], ['scripts/lib/workflow-pin.mjs', '// pin\n'], [LANE_CONTRACT, '// lane\n'], ['notes.txt', 'M1\n']]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  pinGit(root, 'add', '.');
  pinGit(root, 'commit', '-m', 'M1');
  pinGit(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return pinGit(root, 'rev-parse', 'HEAD');
}
// Commits a change to a file no shared contract names and moves origin/main with main; the new commit.
function advanceMain(root, text) {
  writeFileSync(join(root, 'notes.txt'), `${text}\n`);
  pinGit(root, 'commit', '-am', text);
  pinGit(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return pinGit(root, 'rev-parse', 'refs/heads/main');
}
const pinnedRoot = (root, commit) => join(root, '.git', 'fabraik-workflow', commit);
const pinMark = (root, commit) => `FABRAIK_WORKFLOW_ROOT=${pinnedRoot(root, commit)}`;
// The argv Herdr retains for a Claude job of card 5 launched with the extra launch marks `marks`.
const retainedArgv = (marks) => ['/usr/bin/env', `PRE_APPROVED_RUN_SESSION=${KEPT_RUN}`, 'PRE_APPROVED_RUN_CARD=5', 'FABRAIK_COORDINATED_JOB=1', ...marks,
  'ANTHROPIC_MODEL=sonnet', 'CLAUDE_CODE_EFFORT_LEVEL=high', 'claude', '--permission-mode', 'auto', '--resume', KEPT_SESSION, '--', RESUME_PROMPT(5)];
const workflowLabels = (commit) => ({ ...keptLabels(5), 'fabraik.workflow': commit });
// Adds card 5's finished kept terminal `address`, whose Claude exited, with its retained `argv` and `labels`.
function addRetained(job, address, argv, labels) {
  addKept(job, address, 5, 'finished', labels);
  job.details[address].argv = argv;
}
// The workflow root marks between /usr/bin/env and claude, and the fabraik.workflow labels, of one `hc run`.
function launchedPin(run) {
  const command = run.slice(run.indexOf('--json') + 2);
  return { marks: command.slice(0, command.indexOf('claude')).filter((word) => word.startsWith('FABRAIK_WORKFLOW_ROOT=')),
    labels: run.filter((word, i) => run[i - 1] === '--label' && word.startsWith('fabraik.workflow=')) };
}
const launchedUnder = (root, commit) => ({ marks: [pinMark(root, commit)], labels: [`fabraik.workflow=${commit}`] });
// Card 5's job over the real repository `root`, its tab open and its branch job/5; `onLaunch` runs at its `hc run`.
const pinnedFixture = (root, onLaunch) => jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1'], ['tbjob5', 'job 5']], null, root)],
  pages: READY_BOARD(), branches: [5], onLaunch });
const endsLaunchesOrRemoves = (job) => job.calls.filter(([kind]) => ['kill', 'run', 'rm'].includes(kind));
// Everything a start told the coordinator or the job: its printed lines, the launched prompts and any text sent.
const toldOf = (job) => [...job.lines, ...job.runs().map((run) => run.at(-1)),
  ...job.calls.filter(([kind]) => kind === 'send').map((args) => args.slice(2).join(' '))].join('\n');

test('ANTI-REGRESSION: a resumed Herdr job keeps its recorded workflow version', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);

  await t.test('a fresh start records local main in its argv mark and label', async (t) => {
    const root = workflowRepository(t);
    const main = pinGit(root, 'rev-parse', 'refs/heads/main');
    // origin/main is one reviewed commit ahead, with the newest snapshot in the store; local main stays the version.
    const ahead = advanceMain(root, 'ahead');
    pinGit(root, 'reset', '--hard', main);
    repairWorkflowSnapshot({ cwd: root, commit: ahead });
    const job = jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, root)], pages: READY_BOARD() });
    assert.equal(await job.start(5), 0, job.lines.join('\n'));
    assert.equal(job.runs().length, 1);
    assert.deepEqual(launchedPin(job.runs()[0]), launchedUnder(root, main));
    verifyWorkflowSnapshot({ cwd: root, commit: main, dir: pinnedRoot(root, main) });
  });

  await t.test('a resume after main moved keeps the recorded commit', async (t) => {
    const root = workflowRepository(t);
    const recorded = pinGit(root, 'rev-parse', 'refs/heads/main');
    repairWorkflowSnapshot({ cwd: root, commit: recorded });
    const moved = advanceMain(root, 'moved');
    assert.notEqual(moved, recorded);
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([pinMark(root, recorded)]), workflowLabels(recorded));
    launchesReplacement(job, 't20', workflowLabels(recorded));
    assert.equal(await job.start(5, resumeOptions('file')), 0, job.lines.join('\n'));
    assert.equal(job.runs().length, 1);
    assert.deepEqual(launchedPin(job.runs()[0]), launchedUnder(root, recorded));
  });

  await t.test('an argv mark and label that disagree are refused', async (t) => {
    const root = workflowRepository(t);
    const marked = pinGit(root, 'rev-parse', 'refs/heads/main');
    const labelled = advanceMain(root, 'labelled');
    for (const commit of [marked, labelled]) repairWorkflowSnapshot({ cwd: root, commit });
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([pinMark(root, marked)]), workflowLabels(labelled));
    launchesReplacement(job, 't20', workflowLabels(labelled));
    assert.equal(await job.start(5, resumeOptions('file')), 1, job.lines.join('\n'));
    assert.equal(job.lines.length, 1, job.lines.join('\n'));
    const [, cause] = job.lines[0].match(unresumable(5, KEPT_SESSION, 't11')) ?? [];
    assert.ok(cause, `the refusal line: ${job.lines[0]}`);
    assert.match(cause, /workflow/i);
    assert.deepEqual(endsLaunchesOrRemoves(job), []);
  });

  await t.test('a replacement carrying another workflow label is removed and its predecessor left untouched', async (t) => {
    const root = workflowRepository(t);
    const recorded = pinGit(root, 'rev-parse', 'refs/heads/main');
    repairWorkflowSnapshot({ cwd: root, commit: recorded });
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([pinMark(root, recorded)]), workflowLabels(recorded));
    launchesReplacement(job, 't20', workflowLabels('b'.repeat(40)));
    assert.equal(await job.start(5, resumeOptions('file')), 1, job.lines.join('\n'));
    const said = job.lines.join('\n');
    assert.ok(said.startsWith(`Card 5's session ${KEPT_SESSION} could not be resumed: `), said);
    assert.match(said, /fabraik\.workflow/);
    assert.deepEqual(job.calls.filter(([kind]) => kind === 'kill' || kind === 'rm').map(([kind, target]) => `${kind} ${target}`), ['kill t20', 'rm t20']);
    assert.ok(job.terminals.some(({ address }) => address === 't11'), 'the predecessor record is kept');
  });

  await t.test('a restored shell with an agreeing label resumes under it, and a lost label beside a pin mark is refused', async (t) => {
    const root = workflowRepository(t);
    const recorded = pinGit(root, 'rev-parse', 'refs/heads/main');
    repairWorkflowSnapshot({ cwd: root, commit: recorded });
    advanceMain(root, 'moved');
    const restored = pinnedFixture(root);
    addKept(restored, 't11', 5, 'live', workflowLabels(recorded));
    launchesReplacement(restored, 't20', workflowLabels(recorded));
    assert.equal(await restored.start(5, resumeOptions('file')), 0, restored.lines.join('\n'));
    assert.deepEqual(launchedPin(restored.runs()[0]), launchedUnder(root, recorded));

    const lost = pinnedFixture(root);
    addRetained(lost, 't11', retainedArgv([pinMark(root, recorded)]), keptLabels(5));
    assert.equal(await lost.start(5, resumeOptions('file')), 1, lost.lines.join('\n'));
    assert.equal(lost.lines.length, 1, lost.lines.join('\n'));
    assert.match(lost.lines[0], unresumable(5, KEPT_SESSION, 't11'));
    assert.deepEqual(endsLaunchesOrRemoves(lost), []);
  });

  await t.test('a recorded commit that is not on the reviewed main is refused, and nothing is materialized or launched', async (t) => {
    const root = workflowRepository(t);
    // A readable commit on no branch: a child of main that origin/main never reached.
    const unreviewed = pinGit(root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unreviewed');
    const job = pinnedFixture(root);
    addKept(job, 't11', 5, 'live', workflowLabels(unreviewed));
    launchesReplacement(job, 't20', workflowLabels(unreviewed));
    assert.equal(await job.start(5, resumeOptions('file')), 1, job.lines.join('\n'));
    const said = job.lines.join('\n');
    assert.ok(said.startsWith(`Card 5's session ${KEPT_SESSION} could not be resumed: `), said);
    assert.ok(said.includes(unreviewed) && said.includes('origin/main') && said.includes('nothing was started'), said);
    assert.deepEqual(endsLaunchesOrRemoves(job), []);
    assert.equal(existsSync(pinnedRoot(root, unreviewed)), false, 'no snapshot of the unreviewed commit is materialized');
  });

  await t.test('a proven pre-pin record records current main and says so', async (t) => {
    const root = workflowRepository(t);
    const main = advanceMain(root, 'current');
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([]), keptLabels(5));
    launchesReplacement(job, 't20', workflowLabels(main));
    assert.equal(await job.start(5, resumeOptions('file')), 0, job.lines.join('\n'));
    assert.deepEqual(launchedPin(job.runs()[0]), launchedUnder(root, main));
    verifyWorkflowSnapshot({ cwd: root, commit: main, dir: pinnedRoot(root, main) });
    assert.ok(job.lines.some((line) => line.includes(main) && /workflow version/i.test(line)), `a line names the recorded main: ${job.lines.join('\n')}`);
  });

  await t.test('drift keeps the version and sends the recovery notice', async (t) => {
    const root = workflowRepository(t);
    const recorded = pinGit(root, 'rev-parse', 'refs/heads/main');
    repairWorkflowSnapshot({ cwd: root, commit: recorded });
    writeFileSync(join(root, LANE_CONTRACT), '// a changed lane\n');
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([pinMark(root, recorded)]), workflowLabels(recorded));
    launchesReplacement(job, 't20', workflowLabels(recorded));
    assert.equal(await job.start(5, resumeOptions('file')), 0, job.lines.join('\n'));
    assert.deepEqual(launchedPin(job.runs()[0]), launchedUnder(root, recorded));
    const told = toldOf(job);
    assert.ok(told.split('\n').some((line) => line.includes(LANE_CONTRACT) && line.includes(recorded)), `the notice names the drifted contract and the kept version: ${told}`);
    // The withdrawal applies only while the pull request is still open: its step, from the sentence or clause that
    // names it up to the cleanup command, states a condition on the pull request being open.
    const notice = told.split('\n').find((line) => line.includes('Workflow drift') && line.includes('--undo')) ?? '';
    const withdraw = notice.indexOf('--undo');
    const withdrawStep = notice.slice(Math.max(notice.lastIndexOf(';', withdraw), notice.lastIndexOf('. ', withdraw)) + 1, notice.indexOf('merge-watch.mjs', withdraw));
    assert.ok(withdraw >= 0 && /\b(if|while|only|when)\b/i.test(withdrawStep) && /\bopen\b/i.test(withdrawStep), `the withdrawal is conditional on an open pull request: ${withdrawStep || told}`);
  });

  await t.test('a damaged or deleted snapshot is repaired before relaunch, and an unreadable commit is refused with the owner route', async (t) => {
    const logged = [];
    t.mock.method(console, 'log', (...words) => { logged.push(words.join(' ')); });
    for (const harm of ['damaged', 'deleted']) {
      const root = workflowRepository(t);
      const recorded = pinGit(root, 'rev-parse', 'refs/heads/main');
      repairWorkflowSnapshot({ cwd: root, commit: recorded });
      const canonical = pinnedRoot(root, recorded);
      writable(canonical);
      if (harm === 'damaged') {
        chmodSync(join(canonical, 'notes.txt'), 0o644);
        writeFileSync(join(canonical, 'notes.txt'), 'tampered\n');
      } else {
        rmSync(canonical, { recursive: true, force: true });
      }
      logged.length = 0;
      let intactAtLaunch;
      const job = pinnedFixture(root, () => {
        try {
          verifyWorkflowSnapshot({ cwd: root, commit: recorded, dir: canonical });
          intactAtLaunch = true;
        } catch (error) {
          intactAtLaunch = /** @type {Error} */ (error).message;
        }
      });
      addRetained(job, 't11', retainedArgv([pinMark(root, recorded)]), workflowLabels(recorded));
      launchesReplacement(job, 't20', workflowLabels(recorded));
      assert.equal(await job.start(5, resumeOptions('file')), 0, `${harm}: ${job.lines.join('\n')}`);
      assert.equal(intactAtLaunch, true, `${harm}: the snapshot verifies when the job relaunches`);
      assert.deepEqual(launchedPin(job.runs()[0]), launchedUnder(root, recorded), harm);
      const printed = [...logged, ...job.lines].join('\n');
      assert.ok(printed.includes(canonical), `${harm}: the repaired path is printed: ${printed}`);
      if (harm === 'damaged') {
        assert.ok(existsSync(`${canonical}.damaged-1`), 'the damaged copy is kept');
        assert.ok(printed.includes(`${canonical}.damaged-1`), `the kept path is printed: ${printed}`);
      }
    }

    const root = workflowRepository(t);
    const unreadable = 'f'.repeat(40);
    const job = pinnedFixture(root);
    addRetained(job, 't11', retainedArgv([pinMark(root, unreadable)]), workflowLabels(unreadable));
    launchesReplacement(job, 't20', workflowLabels(unreadable));
    assert.equal(await job.start(5, resumeOptions('file')), 1, job.lines.join('\n'));
    const said = job.lines.join('\n');
    assert.ok(said.includes(unreadable), `the refusal names the commit: ${said}`);
    assert.match(said, /draft/i, 'the owner route converts the pull request to draft');
    assert.match(said, /auto-merge/i, 'the owner route turns off auto-merge');
    assert.deepEqual(endsLaunchesOrRemoves(job), []);
    assert.ok(!existsSync(pinnedRoot(root, unreadable)), 'no snapshot is written for an unreadable commit');
  });
});

test('ANTI-REGRESSION: a job whose session cannot be resumed is reported with its cause and no session starts', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // Each failed check refuses before any kill or launch, naming the session, its cause and the record to remove.
  /** @type {[string, (job: any) => void, string | undefined, string, string, RegExp][]} */
  const checks = [
    ['a missing transcript', (job) => addKept(job, 't11', 5, 'finished'), undefined, KEPT_SESSION, 't11', /transcript/i],
    ['a session label that is no v4 UUID', (job) => addKept(job, 't11', 5, 'live', keptLabels(5, { session: '11111111-1111-1111-8111-111111111111' })),
      'file', '11111111-1111-1111-8111-111111111111', 't11', /session/i],
    ['a session label that is a path', (job) => addKept(job, 't11', 5, 'live', keptLabels(5, { session: '../../../tmp/x' })), 'file', '../../../tmp/x', 't11', /session/i],
    ['a run start not in the RUN_START form', (job) => addKept(job, 't11', 5, 'live', keptLabels(5, { runStart: '2026-11-19T12:06:00.000Z' })),
      'file', KEPT_SESSION, 't11', /run ?start/i],
    ['a transcript that is a link', (job) => addKept(job, 't11', 5, 'live'), 'link', KEPT_SESSION, 't11', /link/i],
  ];
  for (const [label, arrange, transcript, id, address, cause] of checks) {
    const job = resumeFixture();
    arrange(job);
    assert.equal(await job.start(5, resumeOptions(transcript)), 1, `${label}: ${job.lines.join('\n')}`);
    assert.equal(job.lines.length, 1, `${label}: ${job.lines.join('\n')}`);
    const [, said] = job.lines[0].match(unresumable(5, id, address)) ?? [];
    assert.ok(said, `${label} prints the refusal line: ${job.lines[0]}`);
    assert.match(said, cause, `${label} names its cause`);
    assert.deepEqual(job.calls.filter(([kind]) => ['kill', 'run', 'rm'].includes(kind)), [], `${label} ends, launches and removes nothing`);
  }

  // Records of card 5 carrying different sessions refuse, naming each record.
  const twins = resumeFixture();
  addKept(twins, 't11', 5, 'live');
  addKept(twins, 't12', 5, 'finished', keptLabels(5, { session: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb' }));
  assert.equal(await twins.start(5, resumeOptions('file')), 1, twins.lines.join('\n'));
  assert.equal(twins.lines.length, 1, twins.lines.join('\n'));
  assert.match(twins.lines[0], /^Card 5's session .+ could not be resumed: .+; nothing was started\. hc rm .+ lets start begin card 5 as a new session\.$/);
  assert.match(twins.lines[0], /\bt11\b/);
  assert.match(twins.lines[0], /\bt12\b/);
  assert.deepEqual(twins.calls.filter(([kind]) => ['kill', 'run', 'rm'].includes(kind)), []);

  // A launch that fails, or a replacement whose labels differ, removes only the replacement and keeps the old record so a
  // later start tries again; nothing falls back to a fresh session.
  /** @type {[string, (job: any) => void, string[], RegExp][]} */
  const launches = [
    ['hc run failing', (job) => { job.launch = { code: 1, stdout: '', stderr: 'name_taken: fabraik-job-5' }; }, [], /name_taken/],
    ['a replacement whose labels differ', (job) => launchesReplacement(job, 't20', keptLabels(5, { runStart: '2026-11-19T13:00:00Z' })), ['t20'], /./],
  ];
  const root = fabraikRepository(t);
  for (const [label, arrange, removed, cause] of launches) {
    const job = resumeFixture(root);
    addKept(job, 't11', 5, 'live');
    arrange(job);
    assert.equal(await job.start(5, resumeOptions('file')), 1, `${label}: ${job.lines.join('\n')}`);
    const said = job.lines.join('\n');
    assert.ok(said.startsWith(`Card 5's session ${KEPT_SESSION} could not be resumed: `), `${label}: ${said}`);
    assert.match(said, cause, `${label} names its cause`);
    assert.deepEqual(job.calls.filter(([kind]) => kind === 'rm').map(([, target]) => target), removed, `${label} removes only the replacement`);
    assert.ok(job.terminals.some(({ address }) => address === 't11'), `${label} keeps the old record`);
    assert.equal(job.runs().length, 1, `${label} launches once`);
    assert.ok(job.runs().every((run) => run.includes('--resume') && !run.includes('--session-id')), `${label} starts no fresh session`);
    assert.doesNotMatch(said, /\bresuming\b/i);
  }
});

// A project space whose Coordinator tab holds the terminals `entries`, as `herdr-app ls` lists them.
const coordinatorListing = (terminals) => ({ spaces: [{ ...space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT),
  tabs: [{ id: 'tb1', name: '1', terminals: [] }, { id: 'tbc', name: 'Coordinator', terminals }] }] });
const listed = (...addresses) => addresses.map((terminal) => ({ terminal }));

// The `hc get --json` record of a live terminal running `foreground`, started through `argv`, at `status`.
/** @param {{ foreground?: string, argv?: string[], status?: { state: string } | null, pid?: number, foregroundPid?: number, state?: string }} [fields] */
const liveRecord = ({ foreground = 'claude', argv = ['/usr/bin/env', 'claude'], status = { state: 'idle' }, pid = 100, foregroundPid = 101, state = 'live' } = {}) =>
  ({ state, pid, argv, foreground: { name: foreground, pid: foregroundPid }, status });

const trackerWrites = (job) => job.tracker.log.calls.filter(([tool, verb, ...args]) => !(tool === 'pr' && verb === 'list')
  && !(tool === 'api' && verb === 'graphql' && args.some((arg) => arg.startsWith('query=') && !/^query=\s*mutation\b/.test(arg))));

function assertStartReadsOnly(job, reason) {
  assert.deepEqual({
    app: job.app.filter(([kind]) => kind !== 'ls'),
    terminals: job.calls.filter(([kind]) => !['ls', 'get'].includes(kind)),
    tracker: trackerWrites(job),
  }, { app: [], terminals: [], tracker: [] }, reason);
}

test('929 routes fresh jobs from their verified current coordinator', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const ready = (root = ROOT) => jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tbjob5', 'job 5']], null, root)], pages: READY_BOARD() });
  const settings = (runtime, runtimes = ['claude', 'codex']) => gitFor(settingsText({ runtimes, coordinator: { runtime, model: 'sonnet', effort: 'high' } }), []);
  const observedCodex = { ...liveRecord({ foreground: 'codex', argv: ['/usr/bin/env', 'codex', '--no-daemon'], foregroundPid: 100 }), cwd: ROOT };

  const root = fabraikRepository(t);
  const claude = ready(root);
  assert.equal(await claude.start(5, { git: settings('codex') }), 0, claude.lines.join('\n'));
  assert.deepEqual(claude.runs(), [jobRunArgs('fabraik-job-5', 5, 'tbjob5', root)], 'the live Claude Coordinator supplies the unchanged child even when Codex is saved');

  const codex = ready();
  codex.details.t0 = { ...observedCodex, address: 't0' };
  const codexExit = await codex.start(5, { git: settings('claude') });
  assertStartReadsOnly(codex, 'the live Codex override must hold, never start a Claude child');
  assert.equal(codexExit, 1, codex.lines.join('\n'));
  assert.match(codex.lines.join('\n'), /(?=.*\bCodex\b)(?=.*(?:bind|guard))/i, 'the hold names the remaining activation gate');

  const wrongCaller = ready();
  const wrongCallerExit = await wrongCaller.start(5, { parent: 't99' });
  assertStartReadsOnly(wrongCaller, 'a different caller address authorizes no mutation');
  assert.equal(wrongCallerExit, 1, wrongCaller.lines.join('\n'));
  assert.match(wrongCaller.lines.join('\n'), /coordinator|parent/i);

  const replaced = ready();
  replaced.details.t1 = { ...replaced.details.t0, address: 't1' };
  const replacedExit = await replaced.start(5, { capLock: (work) => {
    replaced.coordinatorAddresses = ['t1'];
    return work();
  } });
  assertStartReadsOnly(replaced, 'a Coordinator replaced before taking the lock authorizes no mutation');
  assert.equal(replacedExit, 1, replaced.lines.join('\n'));
  assert.match(replaced.lines.join('\n'), /coordinator|parent/i);

  const stopped = ready();
  stopped.details.t0 = { ...liveRecord({ foreground: 'bash', argv: ['/usr/bin/bash'], status: null, foregroundPid: 100 }), address: 't0', cwd: ROOT };
  const stoppedExit = await stopped.start(5);
  assertStartReadsOnly(stopped, 'a kept shell cannot route a fresh job');
  assert.equal(stoppedExit, 1, stopped.lines.join('\n'));
  assert.match(stopped.lines.join('\n'), /coordinator/i);

  const mixed = ready();
  mixed.coordinatorAddresses.push('t1');
  mixed.details.t1 = { ...observedCodex, address: 't1' };
  const mixedExit = await mixed.start(5);
  assertStartReadsOnly(mixed, 'multiple live runtimes do not authorize a child');
  assert.equal(mixedExit, 1, mixed.lines.join('\n'));
  assert.match(mixed.lines.join('\n'), /coordinator/i);

  const uninstalled = ready();
  uninstalled.details.t0 = { ...observedCodex, address: 't0' };
  const uninstalledExit = await uninstalled.start(5, { git: settings('claude', ['claude']) });
  assertStartReadsOnly(uninstalled, 'the foreground runtime must be installed');
  assert.equal(uninstalledExit, 1, uninstalled.lines.join('\n'));
  assert.match(uninstalled.lines.join('\n'), /not installed/i);
});

const codexExecutable = '/fixture/codex/0.173.0-alpha.4/codex';
const resumedPrompt = `${CODEX_BIND_FIRST} Your session was resumed after a restart. Carry on with card #5. ${CODEX_DELIVERY_GUIDANCE}`;
const codexJobRunArgs = (parent, runStart, thread, program = codexExecutable) => ['run', '--bg', '--keep', '--parent', parent, '--outlive-parent',
  '--name', 'fabraik-job-5', '--cwd', ROOT, '--label', 'herdr.space=spproject1', '--label', 'herdr.tab=tbjob5',
  '--label', 'fabraik.role=job', '--label', 'fabraik.space=spproject1', '--label', 'fabraik.card=5',
  '--label', 'fabraik.runtime=codex', '--label', `fabraik.runstart=${runStart}`, '--json', '--', '/usr/bin/env',
  `PRE_APPROVED_RUN_SESSION=${runStart}`, 'PRE_APPROVED_RUN_CARD=5', 'FABRAIK_COORDINATED_JOB=1',
  program, '--no-daemon', '--enable', 'default_mode_request_user_input',
  ...(thread ? ['resume', thread] : []), '--', thread ? resumedPrompt : CODEX_JOB_PROMPT(5)];
// A Codex job launch keeps the menu flag but carries no session hook setting.
const assertNoHookSetting = (runs, label) => {
  assert.ok(runs.length > 0, `${label}: a launch ran`);
  for (const args of runs) {
    assert.ok(!args.some((arg) => /hooks\.(?:Pre|Post)ToolUse|matcher="\^?request_user_input/.test(arg)), `${label}: no hook setting`);
  }
};

const nativeArgv = (command) => command.slice(command.indexOf('--') + 1);
const codex = liveRecord({ foreground: 'codex', argv: ['codex', '--no-daemon'], status: { state: 'working' }, foregroundPid: 100 });
/** @param {boolean} [restart] @param {[string, string][]} [tabs] @param {{ branches?: number[], pages?: unknown }} [tracker] */
const codexJobFixture = (restart = false, tabs = [['tbjob5', 'job 5']], {
  branches = restart ? [5] : [],
  pages = restart ? [leanBoardPage([issue(5, { status: 'In progress' })])] : READY_BOARD(),
} = {}) => {
  const receipts = new Map();
  let onLaunch = () => {};
  const job = jobFixture({ spaces: [space('spproject1', 'fabraik', tabs, null, ROOT)],
    pages, branches, onLaunch: () => onLaunch() });
  job.coordinatorAddresses = ['t90'];
  job.details.t90 = { ...codex, status: { app: 'codex', state: 'working' }, address: 't90', cwd: ROOT };
  const record = (address, parent, runStart, argv, state) => {
    const labels = { 'herdr.space': 'spproject1', 'herdr.tab': 'tbjob5', 'fabraik.role': 'job', 'fabraik.space': 'spproject1',
      'fabraik.card': '5', 'fabraik.runtime': 'codex', 'fabraik.runstart': runStart };
    const created_ms = 1795090122648 + Number.parseInt(address.slice(1), 36);
    const entry = { address, agent: 'codex', cwd: ROOT, name: 'fabraik-job-5', parent, state };
    const foreground = state === 'live' ? { name: 'codex', pid: codex.pid, argv, cwd: ROOT } : undefined;
    job.terminals.push(entry);
    job.details[address] = { ...entry, keep: true, created_ms, pid: codex.pid, argv, labels, foreground,
      status: state === 'live' ? { app: 'codex', state: 'working' } : null };
    return { version: 1, root: ROOT, repositoryId: 'R_1', card: 5, runStart, terminalAddress: address,
      terminalCreatedMs: created_ms, parentAddress: parent, threadId: KEPT_SESSION };
  };
  if (restart) receipts.set('t10', record('t10', 't90', KEPT_RUN, nativeArgv(codexJobRunArgs('t90', KEPT_RUN, undefined, 'codex')), 'finished'));
  const launch = (address, parent, runStart, alter = (receipt) => receipt) => {
    job.launch = { code: 0, stdout: JSON.stringify({ address }), stderr: '' };
    onLaunch = () => {
      const receipt = record(address, parent, runStart, nativeArgv(job.runs().at(-1)), 'live');
      receipts.set(address, alter(receipt));
    };
  };
  /** @param {{ verifyExecutable?: () => void, [key: string]: unknown }} [options] */
  const start = ({ verifyExecutable = () => {}, ...options } = {}) => job.start(5, {
    parent: 't90',
    git: gitFor(settingsText({ runtimes: ['claude', 'codex'], coordinator: { runtime: 'claude', model: 'sonnet', effort: 'high' } }), [], { branches }),
    checkCodexHooks: async ({ root }) => {
      job.calls.push(['<hooks>', root]);
      return { status: 'ready', executable: codexExecutable, verifyExecutable: () => {
        job.calls.push(['<verify-executable>']);
        verifyExecutable();
      } };
    },
    readCodexBinding: ({ root, address }) => {
      const receipt = receipts.get(address);
      const observed = typeof receipt === 'function' ? receipt() : receipt ?? null;
      job.calls.push(['<binding>', root, address, observed?.threadId ?? 'absent']);
      return observed;
    },
    capLock: async (work) => {
      job.calls.push(['<lock>']);
      try { return await work(); } finally { job.calls.push(['</lock>']); }
    },
    ...options,
  });
  return { job, launch, receipts, start };
};

test('967 sends Herdr delivery instructions only to Codex Herdr jobs', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const freshArgs = codexJobRunArgs('t90', RUN_AT, undefined);
  const firstResume = codexJobRunArgs('t90', KEPT_RUN, KEPT_SESSION);
  const secondResume = codexJobRunArgs('t2', KEPT_RUN, KEPT_SESSION);
  const effects = (job) => {
    assert.deepEqual(trackerWrites(job), [], 'binding and ordinary recovery leave the claim unchanged');
    assert.deepEqual(job.app.filter(([kind]) => kind !== 'ls'), [], 'the existing job tab is reused');
    return job.calls.filter(([kind]) => !['ls', 'get'].includes(kind) && !kind.includes('<'));
  };
  const preserved = (job) => job.terminals.map(({ address }) => address).sort();
  const stop = (job, address) => {
    const entry = job.terminals.find((terminal) => terminal.address === address);
    assert.ok(entry, `the native job ${address} was launched`);
    entry.state = 'finished';
    Object.assign(job.details[address], { state: 'finished', foreground: undefined, status: null });
  };
  const assertFinalVerification = (job) => {
    const checks = job.calls.flatMap(([kind], index) => kind === '<verify-executable>' ? [index] : []);
    assert.deepEqual(checks, [job.calls.findIndex(([kind]) => kind === 'run') - 1], 'the final verification directly precedes launch');
  };
  const assertCleanupOrder = (job, original, replacement) => {
    const closeLaunchLock = job.calls.findIndex(([kind]) => kind === '</lock>');
    const run = job.calls.findIndex(([kind]) => kind === 'run');
    const binding = job.calls.findIndex(([kind, root, address, thread]) => kind === '<binding>' && root === ROOT && address === replacement
      && thread === KEPT_SESSION);
    const reopen = job.calls.findIndex(([kind], index) => kind === '<lock>' && index > closeLaunchLock);
    const remove = job.calls.findIndex(([kind, address]) => kind === 'rm' && address === original);
    assert.ok(job.calls.findIndex(([kind]) => kind === '<lock>') < run && run < closeLaunchLock, 'the exact launch is under the cap lock');
    assert.ok(closeLaunchLock < binding && binding < reopen, 'the exact new address is observed outside the cap lock');
    assert.ok(reopen < remove && remove < job.calls.findLastIndex(([kind]) => kind === '</lock>'), 'only later cleanup holds the cap lock again');
    const rereads = job.calls.slice(reopen + 1, remove);
    assert.ok(rereads.some(([kind]) => kind === 'ls'), 'cleanup rereads native holders');
    assert.ok(rereads.some(([kind, address]) => kind === 'get' && address === original), 'cleanup rereads the stopped predecessor');
    const predecessor = job.calls.findIndex(([kind, , address]) => kind === '<binding>' && address === original);
    assertFinalVerification(job);
    assert.ok(predecessor >= 0 && predecessor < run - 1, 'the predecessor binding is read before final verification');
  };

  const fresh = codexJobFixture();
  fresh.launch('t14g', 't90', RUN_AT);
  assert.equal(await fresh.start(), 0, fresh.job.lines.join('\n'));
  assert.deepEqual(effects(fresh.job), [freshArgs]);
  assertNoHookSetting(fresh.job.runs(), 'fresh launch');
  assertFinalVerification(fresh.job);
  assert.deepEqual(fresh.job.calls.filter(([kind]) => kind === '<hooks>'), [['<hooks>', ROOT]]);
  assert.deepEqual(preserved(fresh.job), ['t14g']);

  const recovery = codexJobFixture(true);
  addKept(recovery.job, 't9', 6, 'finished');
  let receiptReads = 0;
  recovery.launch('t14h', 't90', KEPT_RUN, (receipt) => () => (++receiptReads === 1 ? null : receipt));
  assert.equal(await recovery.start(), 0, recovery.job.lines.join('\n'));
  assert.deepEqual(effects(recovery.job), [firstResume, ['rm', 't10']]);
  assertNoHookSetting(recovery.job.runs(), 'first resume');
  assert.ok(receiptReads >= 2, 'cleanup waits for the replacement’s own acknowledgment');
  assertCleanupOrder(recovery.job, 't10', 't14h');
  assert.deepEqual(preserved(recovery.job), ['t14h', 't9']);

  recovery.job.calls.length = 0;
  recovery.job.lines.length = 0;
  stop(recovery.job, 't14h');
  recovery.job.coordinatorAddresses = ['t2'];
  recovery.job.details.t2 = { ...liveRecord({ foregroundPid: 100 }), address: 't2', cwd: ROOT };
  recovery.launch('t14j', 't2', KEPT_RUN);
  assert.equal(await recovery.start({ parent: 't2' }), 0, recovery.job.lines.join('\n'));
  assert.deepEqual(effects(recovery.job), [secondResume, ['rm', 't14h']]);
  assertNoHookSetting(recovery.job.runs(), 'second resume');
  assertCleanupOrder(recovery.job, 't14h', 't14j');
  assert.deepEqual(preserved(recovery.job), ['t14j', 't9']);

  const generationChanged = 'native Codex executable generation changed';
  const changedFresh = codexJobFixture(false, []);
  assert.equal(await changedFresh.start({ verifyExecutable: () => {
    const opened = changedFresh.job.app.findIndex(([kind, command]) => kind === 'do' && command === 'tab.new');
    assert.ok(opened >= 0 && changedFresh.job.app.slice(opened + 1).some(([kind]) => kind === 'ls'),
      'the new job tab is opened and confirmed before final verification');
    throw new Error(generationChanged);
  } }), 1, changedFresh.job.lines.join('\n'));
  assert.match(changedFresh.job.lines.join('\n'), new RegExp(generationChanged));
  assert.deepEqual(changedFresh.job.runs(), []);

  const changedResume = codexJobFixture(true);
  const kept = structuredClone(changedResume.job.details.t10);
  assert.equal(await changedResume.start({ verifyExecutable: () => {
    throw new Error(generationChanged);
  } }), 1, changedResume.job.lines.join('\n'));
  assert.match(changedResume.job.lines.join('\n'), new RegExp(generationChanged));
  assert.deepEqual(effects(changedResume.job), []);
  assert.deepEqual(preserved(changedResume.job), ['t10']);
  assert.deepEqual(changedResume.job.details.t10, kept);

  const untrusted = codexJobFixture(true);
  untrusted.launch('t11', 't90', KEPT_RUN);
  assert.equal(await untrusted.start({ checkCodexHooks: async () => { throw new Error('installed Bash hook is missing'); } }), 1);
  assert.match(untrusted.job.lines.join('\n'), /installed Bash hook is missing/);
  assert.deepEqual(effects(untrusted.job), []);
  assert.deepEqual(preserved(untrusted.job), ['t10']);

  for (const { reason, alter } of [
    { reason: 'missing prior receipt', alter: () => null },
    { reason: 'corrupt prior receipt', alter: () => () => { throw new Error('corrupt Codex binding'); } },
    { reason: 'receipt for a different address', alter: (receipt) => ({ ...receipt, terminalAddress: 't99' }) },
    { reason: 'receipt for a different launch', alter: (receipt) => ({ ...receipt, terminalCreatedMs: receipt.terminalCreatedMs + 1 }) },
  ]) {
    const refused = codexJobFixture(true);
    refused.receipts.set('t10', alter(refused.receipts.get('t10')));
    assert.equal(await refused.start(), 1, `${reason}: ${refused.job.lines.join('\n')}`);
    assert.deepEqual(effects(refused.job), [], reason);
    assert.deepEqual(preserved(refused.job), ['t10'], reason);
  }

  for (const { reason, alter } of [
    { reason: 'no new receipt', alter: () => null },
    { reason: 'a different root thread', alter: (receipt) => ({ ...receipt, threadId: SESSION }) },
    { reason: 'the old address with the right thread', alter: (receipt) => ({ ...receipt, terminalAddress: 't10' }) },
  ]) {
    const refused = codexJobFixture(true);
    refused.launch('t11', 't90', KEPT_RUN, alter);
    assert.equal(await refused.start(), 1, `${reason}: ${refused.job.lines.join('\n')}`);
    assert.deepEqual(effects(refused.job), [firstResume], reason);
    assert.deepEqual(preserved(refused.job), ['t10', 't11'], reason);
  }

  const mismarked = codexJobFixture(true);
  mismarked.launch('t11', 't90', KEPT_RUN, (receipt) => {
    mismarked.job.details.t11.argv = mismarked.job.details.t11.argv.filter((arg) => arg !== 'FABRAIK_COORDINATED_JOB=1');
    mismarked.job.details.t11.foreground.argv = mismarked.job.details.t11.argv;
    return receipt;
  });
  assert.equal(await mismarked.start(), 1, mismarked.job.lines.join('\n'));
  assert.deepEqual(effects(mismarked.job), [firstResume], 'an acknowledgment cannot replace the native launch marks');
  assert.deepEqual(preserved(mismarked.job), ['t10', 't11']);

  const contested = codexJobFixture(true);
  contested.launch('t11', 't90', KEPT_RUN);
  let locks = 0;
  assert.equal(await contested.start({ capLock: (work) => {
    if (++locks === 2) contested.job.addJob('t20', 5, 'claude', 'working');
    return work();
  } }), 1, contested.job.lines.join('\n'));
  assert.ok(locks >= 2, 'the competing holder appears after the launch and before cleanup');
  assert.deepEqual(effects(contested.job), [firstResume]);
  assert.deepEqual(preserved(contested.job), ['t10', 't11', 't20']);

  const missingAddress = codexJobFixture(true);
  missingAddress.launch('t11', 't90', KEPT_RUN);
  missingAddress.job.launch.stdout = '{}';
  assert.equal(await missingAddress.start(), 1, missingAddress.job.lines.join('\n'));
  assert.deepEqual(effects(missingAddress.job), [firstResume], 'inventory cannot replace the address from this launch reply');
  assert.deepEqual(preserved(missingAddress.job), ['t10', 't11']);

  const ambiguous = codexJobFixture(true);
  ambiguous.launch('t11', 't90', KEPT_RUN, (receipt) => {
    stop(ambiguous.job, 't11');
    ambiguous.job.details.t11.labels['fabraik.session'] = KEPT_SESSION;
    return { ...receipt, threadId: SESSION };
  });
  assert.equal(await ambiguous.start(), 1, ambiguous.job.lines.join('\n'));
  assert.deepEqual(effects(ambiguous.job), [firstResume]);
  ambiguous.job.calls.length = 0;
  assert.equal(await ambiguous.start(), 1, ambiguous.job.lines.join('\n'));
  assert.deepEqual(effects(ambiguous.job), [], 'copied labels cannot authorize a later replacement of ambiguous records');
  assert.deepEqual(preserved(ambiguous.job), ['t10', 't11']);

  const failed = codexJobFixture(true);
  failed.job.launch = { code: 1, stdout: '', stderr: 'native launch failed' };
  assert.equal(await failed.start(), 1, failed.job.lines.join('\n'));
  assert.match(failed.job.lines.join('\n'), /native launch failed/);
  assert.deepEqual(effects(failed.job), [firstResume]);
  assert.deepEqual(preserved(failed.job), ['t10']);
});

test('929 repairs a Codex stale claim only for its verified current parent', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const repo = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
  const issueUrl = `https://github.com/${repo}/issues/5`;
  const earlierClaim = { id: 'IC_prior', author: { login: 'owner' }, createdAt: '2026-11-19T11:50:00Z',
    url: `${issueUrl}#issuecomment-4123456788`, body: 'Claim: here, Codex, 2026-11-19T11:50Z' };
  const claim = { id: 'IC_current', author: { login: 'owner' }, createdAt: '2026-11-19T12:11:00Z',
    url: `${issueUrl}#issuecomment-4123456789`, body: 'Claim: here, Codex, 2026-11-19T12:11Z' };
  const laterClaim = { ...claim, id: 'IC_later', createdAt: '2026-11-19T12:12:00Z', url: `${issueUrl}#issuecomment-4123456790`,
    body: 'Claim: here, Codex, 2026-11-19T12:12Z' };
  const replacementClaim = { ...laterClaim, createdAt: '2026-11-19T12:31:00Z', body: 'Claim: here, Codex, 2026-11-19T12:31Z' };
  const claimLine = ({ createdAt, url, body }, index) => JSON.stringify(['claim', index + 1, 'owner', createdAt, url, body]);
  const claimReceipt = (posted, prior) => ({
    turnId: `turn-${posted.id}`,
    startedAtMs: Date.parse(posted.createdAt) - 1000,
    completedAtMs: Date.parse(posted.createdAt) + 1000,
    item: {
      type: 'commandExecution', id: `command-${posted.id}`, cwd: ROOT, status: 'completed', exitCode: 0,
      command: "/usr/bin/bash -lc 'node scripts/board-claim.mjs 5 --intake intake.txt --runtime Codex'",
      aggregatedOutput: [
        'before: ["state","OPEN"]',
        'before: ["assignees",[]]',
        ...prior.map((comment, index) => `before: ${claimLine(comment, index)}`),
        `before: ["comments",${prior.length}]`,
        'before: ["board","Ready"]',
        'before: ["boards",1]',
        'wrote: ["column","In progress"]',
        'wrote: ["assignee","@me"]',
        `wrote: ${JSON.stringify(['claim', posted.body, posted.url])}`,
        'after: ["state","OPEN"]',
        'after: ["assignees",["owner"]]',
        ...[...prior, posted].map((comment, index) => `after: ${claimLine(comment, index)}`),
        `after: ["comments",${prior.length + 1}]`,
        `outcome: Free: the session's own claim, comment ${prior.length + 1} at ${posted.url}, is the first new claim, so it holds the card`,
        '',
      ].join('\n'),
    },
  });
  const history = [claimReceipt(claim, [earlierClaim])];
  const removeAssignee = ['issue', 'edit', '5', '--remove-assignee', 'owner'];
  const moveReady = ['project', 'item-edit', '--id', 'PVTI_5', '--project-id', 'PVT_fixture',
    '--field-id', 'PVTSSF_status', '--single-select-option-id', 'opt-ready'];
  const staleClaim = ({ parent = 't90', items = history, ready = false, trackerChanged = false, herdrChanged = false,
    afterLaunch = '', sourceAppears = false } = {}) => {
    let status = ready ? 'Ready' : 'In progress';
    let assignees = ready ? [] : ['owner'];
    let evidence = ready ? [earlierClaim] : [earlierClaim, claim];
    let itemId = 'PVTI_5';
    let commentReads = 0;
    const branches = [];
    const { job, start, launch } = codexJobFixture(true, undefined, { branches, pages: () => {
      job.calls.push(['<board>', status, itemId]);
      return [leanBoardPage([leanNode({ id: itemId, title: 'Card 5', status, content: { __typename: 'Issue', number: 5, assignees } })])];
    } });
    job.coordinatorAddresses = [parent];
    job.details[parent] = { ...job.details.t90, address: parent };
    const publishReplacementClaim = (verified) => {
      status = 'In progress';
      assignees = ['owner'];
      if (verified) items = [...items, claimReceipt(replacementClaim, evidence)];
      evidence = [...evidence, replacementClaim];
      job.calls.push(['<replacement-claim>']);
    };
    launch('t11', parent, KEPT_RUN, (receipt) => {
      if (sourceAppears) branches.push(5);
      if (afterLaunch === 'different item') itemId = 'PVTI_replaced';
      if (afterLaunch.endsWith(' claim')) {
        if (afterLaunch === 'late verified claim') {
          // The replacement finishes claiming during the cleanup read of the old Herdr record.
          Object.defineProperty(job.replies, 't10', { get: () => {
            if (status === 'Ready') publishReplacementClaim(true);
            return undefined;
          } });
        } else {
          publishReplacementClaim(afterLaunch === 'verified claim');
        }
        const created = Date.parse('2026-11-19T12:30:00Z');
        job.details.t11.created_ms = created;
        return { ...receipt, terminalCreatedMs: created };
      }
      return receipt;
    });
    const original = structuredClone(job.details.t10);
    const rawGh = (args) => {
      const [tool, verb, number] = args;
      const repoFlag = args.indexOf('--repo');
      assert.ok(repoFlag === -1 || args[repoFlag + 1] === repo, 'issue calls target the configured repository');
      const invocation = repoFlag === -1 ? args : args.filter((_, i) => i !== repoFlag && i !== repoFlag + 1);
      if (tool === 'issue' && verb === 'view') {
        assert.equal(number, '5');
        const fields = invocation[invocation.indexOf('--json') + 1].split(',');
        const comments = fields.includes('comments');
        job.tracker.log.calls.push(args);
        job.calls.push(['<card>', assignees.join(','), ...(comments ? ['comments'] : [])]);
        if (comments && trackerChanged && ++commentReads === 2) {
          evidence = [...evidence, laterClaim];
          job.calls.push(['<tracker-changed>']);
        }
        const reply = { state: 'OPEN', assignees: assignees.map((login) => ({ login })), comments: evidence };
        return JSON.stringify(Object.fromEntries(fields.map((field) => [field, reply[field]])));
      }
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('field(name:"Status")')) {
        return JSON.stringify({ data: { [BOARD_OWNER_TYPE]: { projectV2: { id: 'PVT_fixture', field: {
          id: 'PVTSSF_status', options: [{ id: 'opt-ready', name: 'Ready' }, { id: 'opt-progress', name: 'In progress' }],
        } } } } });
      }
      if (query.includes('projectItems(first:20)') && query.includes('issue(number:5)')) {
        job.calls.push(['<board>', status, itemId]);
        return JSON.stringify(issueItemReply([{ ...membership(itemId), value: { name: status } }]));
      }
      if (tool === 'issue' && verb === 'edit' || tool === 'project' && verb === 'item-edit') {
        job.tracker.log.calls.push(invocation);
        if (tool === 'issue') {
          assert.deepEqual(invocation, removeAssignee);
          assignees = [];
          job.calls.push(['<remove-assignee>']);
        } else {
          assert.deepEqual(invocation, moveReady);
          status = 'Ready';
          job.calls.push(['<move-ready>']);
        }
        return '{}';
      }
      return job.tracker.options.rawGh(args);
    };
    const run = () => start({ parent, rawGh, now: () => Date.parse('2026-11-19T12:30:00Z'),
      readCodexClaimHistory: ({ root, threadId }) => {
        job.calls.push(['<claim-history>', root, threadId]);
        if (herdrChanged && !job.details.t20) job.addJob('t20', 5, 'claude', 'working');
        return root === ROOT && threadId === KEPT_SESSION ? structuredClone(items) : [];
      },
    });
    const writes = () => trackerWrites(job).filter(([tool, verb]) => !(tool === 'issue' && verb === 'view'));
    return { job, run, writes, original };
  };

  const resumed = codexJobRunArgs('t90', KEPT_RUN, KEPT_SESSION);
  const terminalWrites = (job) => job.calls.filter(([kind]) => !['ls', 'get'].includes(kind) && !kind.includes('<'));
  const replacementBoundAt = (job) => job.calls.findIndex(([kind, root, address, thread]) => kind === '<binding>' && root === ROOT
    && address === 't11' && thread === KEPT_SESSION);

  const mismatched = structuredClone(history);
  mismatched[0].item.aggregatedOutput = mismatched[0].item.aggregatedOutput.replaceAll(claim.url, laterClaim.url);
  for (const { reason, ...options } of [
    { reason: 'same parent without a native claim receipt', items: [] },
    { reason: 'same parent with a receipt for a different claim', items: mismatched },
    { reason: 'a replacement Coordinator', parent: 't2' },
    { reason: 'a different tracker claim on reread', trackerChanged: true },
    { reason: 'a competing Herdr holder on reread', herdrChanged: true },
  ]) {
    const { job, run, writes, original } = staleClaim(options);
    assert.equal(await run(), 1, `${reason}: ${job.lines.join('\n')}`);
    assert.deepEqual(writes(), [], reason);
    assert.deepEqual(job.app.filter(([kind]) => kind !== 'ls'), [], reason);
    assert.deepEqual(terminalWrites(job), [], reason);
    assert.deepEqual(job.details.t10, original, reason);
  }

  const { job, run, writes } = staleClaim();
  assert.equal(await run(), 0, job.lines.join('\n'));
  assert.deepEqual(writes(), [removeAssignee, moveReady]);
  assert.deepEqual(job.runs(), [resumed]);
  assertNoHookSetting(job.runs(), 'resumed launch');
  assert.deepEqual(job.app.filter(([kind]) => kind !== 'ls'), [], 'the resumed job uses the existing tab');
  const removeAt = job.calls.findIndex(([kind]) => kind === '<remove-assignee>');
  const moveAt = job.calls.findIndex(([kind]) => kind === '<move-ready>');
  const runAt = job.calls.findIndex(([kind]) => kind === 'run');
  const beforeRepair = job.calls.slice(0, removeAt);
  const historyAt = beforeRepair.findIndex(([kind, root, thread]) => kind === '<claim-history>' && root === ROOT && thread === KEPT_SESSION);
  assert.ok(historyAt >= 0, 'repair observes native history for the verified project and original thread');
  assert.ok(beforeRepair.slice(0, historyAt).some(([kind, , evidence]) => kind === '<card>' && evidence === 'comments'));
  const rereads = beforeRepair.slice(historyAt + 1);
  assert.ok(rereads.some(([kind, , evidence]) => kind === '<card>' && evidence === 'comments'), 'the tracker claim is rechecked before repair');
  assert.ok(rereads.some(([kind, status]) => kind === '<board>' && status === 'In progress'), 'the board is rechecked before repair');
  assert.ok(rereads.some(([kind, address]) => kind === 'get' && address === 't10'), 'the stopped Herdr record is rechecked before repair');
  const readback = job.calls.slice(moveAt + 1, runAt);
  assert.ok(readback.some(([kind, assignees]) => kind === '<card>' && assignees === ''), 'resume checks that the assignee was cleared');
  assert.ok(readback.some(([kind, status]) => kind === '<board>' && status === 'Ready'), 'resume checks the board move');

  await t.test('resumes an untouched Ready card without a tracker write', async () => {
    const { job, run, writes } = staleClaim({ ready: true, items: [] });
    const code = await run();
    assert.deepEqual(writes(), []);
    assert.equal(code, 0, job.lines.join('\n'));
    assert.deepEqual(terminalWrites(job), [resumed, ['rm', 't10']]);
    assert.deepEqual(job.app.filter(([kind]) => kind !== 'ls'), []);
    const launchAt = job.calls.findIndex(([kind]) => kind === 'run');
    const boundAt = replacementBoundAt(job);
    const removeAt = job.calls.findIndex(([kind]) => kind === 'rm');
    assert.ok(launchAt < boundAt && boundAt < removeAt, 'cleanup follows the replacement’s exact binding');
    const checksReady = (calls) => calls.some(([kind, status, id]) => kind === '<board>' && status === 'Ready' && id === 'PVTI_5');
    const checksUnassigned = (calls) => calls.some(([kind, assignee, field]) => kind === '<card>' && assignee === '' && field === 'comments');
    assert.ok(checksReady(job.calls.slice(0, launchAt)) && checksUnassigned(job.calls.slice(0, launchAt)), 'launch checks the Ready item and tracker evidence');
    assert.ok(checksReady(job.calls.slice(boundAt + 1, removeAt)) && checksUnassigned(job.calls.slice(boundAt + 1, removeAt)),
      'cleanup rereads the Ready item and tracker evidence');
  });

  await t.test('keeps the predecessor if Ready evidence changes before launch', async () => {
    const { job, run, writes, original } = staleClaim({ ready: true, items: [], trackerChanged: true });
    assert.equal(await run(), 1, job.lines.join('\n'));
    assert.deepEqual(writes(), []);
    assert.deepEqual(terminalWrites(job), []);
    assert.deepEqual(job.details.t10, original);
    assert.ok(job.calls.some(([kind]) => kind === '<tracker-changed>'), 'the change reaches the pre-launch reread');
  });

  for (const { name, afterLaunch, code, sourceAppears } of [
    { name: 'keeps the predecessor if the Ready item changes before cleanup', afterLaunch: 'different item', code: 1 },
    { name: 'keeps the predecessor if the replacement claim is unproved', afterLaunch: 'unverified claim', code: 1 },
    { name: 'keeps the predecessor with a new job branch and an unproved claim', afterLaunch: 'unverified claim', code: 1, sourceAppears: true },
    { name: 'removes the predecessor once the replacement proves its own claim', afterLaunch: 'verified claim', code: 0 },
  ]) {
    await t.test(name, async () => {
      const { job, run, writes, original } = staleClaim({ ready: true, items: [], afterLaunch, sourceAppears });
      const result = await run();
      assert.deepEqual(writes(), []);
      assert.deepEqual(terminalWrites(job), code === 0 ? [resumed, ['rm', 't10']] : [resumed], job.lines.join('\n'));
      assert.equal(result, code, job.lines.join('\n'));
      assert.deepEqual(job.details.t10, code === 0 ? undefined : original);
    });
  }

  await t.test('removes the predecessor when the replacement proves its claim during the Herdr read', async () => {
    const { job, run, writes } = staleClaim({ ready: true, items: [], afterLaunch: 'late verified claim' });
    const result = await run();
    const boundAt = replacementBoundAt(job);
    const claimAt = job.calls.findIndex(([kind]) => kind === '<replacement-claim>');
    assert.ok(boundAt >= 0 && boundAt < claimAt, 'the bound replacement finishes claiming during cleanup');
    assert.deepEqual(writes(), []);
    assert.equal(result, 0, job.lines.join('\n'));
    assert.deepEqual(terminalWrites(job), [resumed, ['rm', 't10']]);
    assert.ok(claimAt < job.calls.findIndex(([kind]) => kind === 'rm'), 'cleanup follows the durable claim');
    assert.deepEqual(job.terminals.map(({ address }) => address), ['t11']);
  });

  const quoted = claimReceipt(claim, [earlierClaim]);
  quoted.item.command = `/usr/bin/bash -lc 'node scripts/board-claim.mjs 5 --intake intake.txt --runtime "Codex"'`;
  for (const { name, items } of [
    { name: 'accepts the quoted operational Codex runtime', items: [quoted] },
    { name: 'ignores a successful claim from an earlier launch', items: [claimReceipt(earlierClaim, []), ...history] },
  ]) {
    await t.test(name, async () => {
      const { job, run, writes } = staleClaim({ items });
      assert.equal(await run(), 0, job.lines.join('\n'));
      assert.deepEqual(writes(), [removeAssignee, moveReady]);
      assert.deepEqual(terminalWrites(job), [resumed, ['rm', 't10']]);
    });
  }
});

test('929 refuses a live holder in a registered sibling worktree', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const job = (root = ROOT) => jobFixture({ root, spaces: [space('spproject1', 'fabraik', [['tbjob11', 'job 11']], null, root)],
    pages: [leanBoardPage([issue(11, { status: 'In progress' })])] });
  const branched = { path: '/srv/projects/jobs/Card 11 work', branch: 'refs/heads/job/11' };
  const detached = { path: '/srv/projects/jobs/11' };
  const legacy = { path: '/srv/projects/fabraik/.claude/worktrees/job-11', branch: 'refs/heads/job/11' };
  const registered = (...records) => gitFor(settingsText({ coordinator: { model: 'sonnet', effort: 'high' } }), [],
    { branches: records.some(({ branch }) => branch === 'refs/heads/job/11') ? [11] : [], registered: records });
  const addHolder = (fixture, cwd) => {
    fixture.terminals.push({ address: 't40', agent: 'codex', cwd, name: 'manual-codex', parent: null, state: 'live' });
    fixture.details.t40 = { ...liveRecord({ foreground: 'codex', argv: ['/usr/bin/codex', '--no-daemon'], status: { state: 'working' }, foregroundPid: 100 }),
      address: 't40', cwd, labels: {} };
  };

  const beside = job();
  beside.addJob('t11', 11, 'claude', 'done', { 'fabraik.stopped': 'context' });
  addHolder(beside, branched.path);
  const besideExit = await beside.start(11, { git: registered(branched) });
  assertStartReadsOnly(beside, 'an active registered holder takes precedence over a diagnosis-stopped terminal');
  assert.equal(besideExit, 1, beside.lines.join('\n'));
  assert.match(beside.lines.join('\n'), /\bt40\b/);
  assert.equal(beside.details.t11.labels['fabraik.stopped'], 'context');

  for (const { record, cwd } of [{ record: detached, cwd: `${detached.path}/src` }, { record: legacy, cwd: legacy.path }]) {
    const occupied = job();
    addHolder(occupied, cwd);
    const exit = await occupied.start(11, { git: registered(record) });
    assertStartReadsOnly(occupied, cwd);
    assert.equal(exit, 1, occupied.lines.join('\n'));
    assert.match(occupied.lines.join('\n'), /\bt40\b/);
  }

  const appeared = job();
  const appearedExit = await appeared.start(11, { git: registered(branched), capLock: (work) => {
    addHolder(appeared, `${branched.path}/src`);
    return work();
  } });
  assertStartReadsOnly(appeared, 'worktree holders must be rechecked under the cap lock');
  assert.equal(appearedExit, 1, appeared.lines.join('\n'));
  assert.match(appeared.lines.join('\n'), /\bt40\b/);

  const root = fabraikRepository(t);
  const prefixOnly = job(root);
  addHolder(prefixOnly, `${branched.path}-other/src`);
  assert.equal(await prefixOnly.start(11, { git: registered(branched) }), 0, prefixOnly.lines.join('\n'));
  assert.deepEqual(prefixOnly.runs(), [jobRunArgs('fabraik-job-11', 11, 'tbjob11', root)], 'a similarly prefixed sibling does not hold the worktree');

  const malformed = job();
  const correct = registered(branched);
  const malformedExit = await malformed.start(11, { git: (args) => args.join(' ') === 'worktree list --porcelain -z'
    ? `worktree ${branched.path}\0HEAD ${OID}\0branch refs/heads/job/11` : correct(args) });
  assertStartReadsOnly(malformed, 'an incomplete worktree tuple does not authorize a launch');
  assert.equal(malformedExit, 1, malformed.lines.join('\n'));
  assert.match(malformed.lines.join('\n'), /worktree/i);

  const duplicate = job();
  const duplicateExit = await duplicate.start(11, { git: registered(branched, { ...branched, path: '/srv/projects/jobs/another-11' }) });
  assertStartReadsOnly(duplicate, 'two registered paths for the card do not authorize a launch');
  assert.equal(duplicateExit, 1, duplicate.lines.join('\n'));
  assert.match(duplicate.lines.join('\n'), /worktree/i);
});

// One wake over `listing` and the `hc get` records `records` by address; its exit code, output and the calls of both fakes.
async function woke({ listing, records = {} }) {
  const app = [];
  const hcCalls = [];
  const lines = [];
  const code = await wakeCoordinator({ root: ROOT, herdrApp: herdrAppFor(listing, app), hc: hcFor(records, hcCalls), print: (line) => lines.push(line) });
  return { code, hcCalls, sends: hcCalls.filter(([kind]) => kind === 'send'), said: lines.join('\n') };
}

test('coordinator wake types the fixed line into an idle Claude coordinator without force', async () => {
  const woken = await woke({ listing: coordinatorListing(listed('t9')), records: { t9: liveRecord() } });
  assert.equal(woken.code, 0, woken.said);
  assert.deepEqual(woken.sends, [['send', 't9', 'A card moved to Ready.']]);
});

test('929 wakes a Codex coordinator only when it can receive the notice', async () => {
  const codex = (state) => liveRecord({
    foreground: 'codex', argv: ['/usr/bin/env', 'codex', '--no-daemon'], foregroundPid: 100,
    status: state === null ? null : { state },
  });
  const notice = 'A card moved to Ready.';
  const wakeOne = (state) => woke({ listing: coordinatorListing(listed('t9')), records: { t9: codex(state) } });
  for (const state of ['idle', 'done', 'working']) {
    const result = await wakeOne(state);
    assert.equal(result.code, 0, `${state}: ${result.said}`);
    assert.deepEqual(result.sends, [['send', 't9', notice]], state);
  }
  const refusedStates = [
    { state: null, cause: /still starting/ },
    { state: 'blocked', cause: /asking the owner/ },
    { state: 'error', cause: /\berror\b/ },
    { state: 'unknown-status', cause: /\bunknown-status\b/ },
  ];
  for (const { state, cause } of refusedStates) {
    const result = await wakeOne(state);
    assert.deepEqual(result.sends, [], result.said);
    assert.match(result.said, cause);
  }

  const wakePair = (other) => woke({ listing: coordinatorListing(listed('t9', 't8')), records: { t9: codex('done'), t8: other } });
  const starting = liveRecord({ foreground: 'env', status: null, foregroundPid: 100 });
  for (const other of [codex('idle'), starting]) {
    const ambiguous = await wakePair(other);
    assert.deepEqual(ambiguous.sends, [], ambiguous.said);
    assert.match(ambiguous.said, /ambiguous|more than one/i);
  }

  const claude = await wakePair(liveRecord());
  assert.equal(claude.code, 0, claude.said);
  assert.deepEqual(claude.sends, [['send', 't8', notice]]);
  const blockedClaude = await wakePair(liveRecord({ status: { state: 'blocked' } }));
  assert.equal(blockedClaude.code, 4, blockedClaude.said);
  assert.deepEqual(blockedClaude.sends, []);
  assert.match(blockedClaude.said, /t8 is asking the owner/);
});

test('coordinator wake sends nothing to a coordinator asking the owner', async () => {
  const woken = await woke({ listing: coordinatorListing(listed('t9')), records: { t9: liveRecord({ status: { state: 'blocked' } }) } });
  assert.equal(woken.code, 4);
  assert.deepEqual(woken.sends, []);
  assert.match(woken.said, /asking the owner/);
});

test('coordinator wake sends nothing to a coordinator still starting', async () => {
  const starting = liveRecord({ foreground: 'env', status: null, foregroundPid: 100 });
  const woken = await woke({ listing: coordinatorListing(listed('t9')), records: { t9: starting } });
  assert.equal(woken.code, 4);
  assert.deepEqual(woken.sends, []);
  assert.match(woken.said, /still starting/);
});

test('coordinator wake sends nothing to a tab that holds only a shell', async () => {
  const shell = liveRecord({ foreground: 'bash', argv: ['/usr/bin/bash'], status: null, foregroundPid: 100 });
  const woken = await woke({ listing: coordinatorListing(listed('t9')), records: { t9: shell } });
  assert.equal(woken.code, 4);
  assert.deepEqual(woken.sends, []);
  assert.match(woken.said, /No coordinator is running Claude/);
});

test('coordinator wake exits 4 where the project has no Coordinator tab', async () => {
  const woken = await woke({ listing: { spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)] } });
  assert.equal(woken.code, 4);
  assert.deepEqual(woken.hcCalls, []);
});

test('coordinator wake exits 1 and sends nothing where the Coordinator tab lists terminals it cannot read', async () => {
  const woken = await woke({ listing: coordinatorListing({}) });
  assert.equal(woken.code, 1);
  assert.deepEqual(woken.sends, []);
  assert.match(woken.said, /terminals this command does not read/);
});

// One relay of the panel line over `listing` and the `hc get` records `records` by address: its result and the sends.
// The namespace is read through the relay's own shape, so the file type-checks where the export is missing.
/** @typedef {{ relayToCoordinator: (options: { root: string, herdrApp: Function, hc: Function, line: string, platform?: NodeJS.Platform }) => Promise<{ code: number, message: string }> }} Relay */
/** @param {{ listing: any, records?: Record<string, any> }} scene */
async function relayed({ listing, records = {} }) {
  const hcCalls = [];
  const result = await /** @type {Relay} */ (/** @type {unknown} */ (coordinator)).relayToCoordinator({ root: ROOT, herdrApp: herdrAppFor(listing, []), hc: hcFor(records, hcCalls), line: PANEL_LINE });
  return { ...result, sends: hcCalls.filter(([kind]) => kind === 'send') };
}
const PANEL_LINE = `Queue panel answer for card #27: job/27 at ${'a'.repeat(40)} ${'b'.repeat(40)}: yes`;

test('relay sends the panel line only to the one receptive coordinator terminal and sends nothing to a blocked, starting, missing or doubled coordinator', async () => {
  const codex = (state) => liveRecord({ foreground: 'codex', argv: ['/usr/bin/env', 'codex', '--no-daemon'], foregroundPid: 100, status: state === null ? null : { state } });
  const starting = liveRecord({ foreground: 'env', status: null, foregroundPid: 100 });
  const shell = liveRecord({ foreground: 'bash', argv: ['/usr/bin/bash'], status: null, foregroundPid: 100 });
  const one = (record) => ({ listing: coordinatorListing(listed('t9')), records: { t9: record } });
  const two = (first, second) => ({ listing: coordinatorListing(listed('t9', 't8')), records: { t9: first, t8: second } });
  for (const [why, scene] of /** @type {[string, { listing: any, records?: Record<string, any> }][]} */ ([
    ['an idle Claude Code coordinator', one(liveRecord())],
    ['an idle Codex coordinator', one(codex('idle'))],
    ['a Codex coordinator that is done', one(codex('done'))],
  ])) {
    const result = await relayed(scene);
    assert.equal(result.code, 0, `${why}: ${result.message}`);
    assert.deepEqual(result.sends, [['send', 't9', PANEL_LINE]], `${why}: the one line is sent to it`);
  }
  for (const [why, scene] of /** @type {[string, { listing: any, records?: Record<string, any> }][]} */ ([
    ['a Claude Code coordinator asking the owner', one(liveRecord({ status: { state: 'blocked' } }))],
    ['a working Codex coordinator', one(codex('working'))],
    ['a Codex coordinator still starting', one(codex(null))],
    ['a coordinator still starting', one(starting)],
    ['a Coordinator tab holding only a shell', one(shell)],
    ['a project with no Coordinator tab', { listing: { spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)] } }],
    ['two idle Claude Code coordinators', two(liveRecord(), liveRecord())],
    ['an idle Codex and an idle Claude Code coordinator', two(codex('idle'), liveRecord())],
  ])) {
    const result = await relayed(scene);
    assert.equal(result.code, 4, `${why}: ${result.message}`);
    assert.deepEqual(result.sends, [], `${why}: nothing is sent`);
    assert.match(result.message, /^[^\n]+$/, `${why}: one line says why`);
  }
});

const closes = (app) => app.filter(([kind, command]) => kind === 'do' && command === 'tab.close');
const newTabs = (app) => app.filter(([kind, command]) => kind === 'do' && command === 'tab.new');

test('coordinator open replaces a Coordinator tab in which nothing runs', async () => {
  const shell = liveRecord({ foreground: 'bash', argv: ['/usr/bin/bash'], status: null, foregroundPid: 100 });
  const replaced = await opened({ listing: coordinatorListing(listed('t8', 't9')), records: { t8: liveRecord({ state: 'finished' }), t9: shell } });
  assert.equal(replaced.code, 0, replaced.said);
  assert.deepEqual(replaced.app.filter(([kind]) => kind === 'do').map((args) => args.slice(0, 2)), [['do', 'tab.close'], ['do', 'tab.new']]);
  assert.deepEqual(flagsOf(closes(replaced.app)[0]), { id: 'tbc' });
  assert.equal(flagsOf(newTabs(replaced.app)[0]).name, 'Coordinator');
  assert.match(replaced.said, /Replaced the Coordinator tab tbc, in which nothing ran\./);
});

test('929 reopens a sole stopped Coordinator tab in its existing space', async () => {
  const codexArgv = ['/usr/bin/env', 'codex', '--no-daemon', '--enable', 'default_mode_request_user_input', '--', prompt('owner')];
  for (const outcome of ['replaced', 'launch failed', 'close failed', 'old tab changed', 'old terminal running']) {
    const listing = withCoordinator(space('spproject1', 'fabraik', [], null, ROOT));
    const shell = liveRecord({ foreground: 'bash', argv: ['/usr/bin/bash', '-i'], status: null, foregroundPid: 100 });
    const records = { t0: shell, t1: shell };
    const app = [];
    const lines = [];
    const herdrApp = async (args) => {
      app.push(args);
      if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ spaces: [listing] }), stderr: '' };
      if (args[1] === 'tab.new') {
        if (outcome === 'launch failed') return { code: 1, stdout: '', stderr: 'native launch failed' };
        const { argv } = flagsOf(args);
        listing.tabs.push({ id: 'tbnew', name: 'Coordinator', terminals: listed('tnew') });
        records.tnew = liveRecord({ foreground: 'codex', argv, foregroundPid: 100, status: null });
        if (outcome === 'old tab changed') listing.tabs[0].terminals = listed('t1');
        if (outcome === 'old terminal running') records.t0 = liveRecord();
        return { code: 0, stdout: '{"space":"spproject1","tab":"tbnew","terminal":"tnew"}', stderr: '' };
      }
      assert.equal(args[1], 'tab.close');
      // In Herdr a last-tab close delegates to space.close and needs confirmation.
      if (listing.tabs.length === 1) return { code: 1, stdout: '', stderr: 'space.close needs confirmation' };
      if (outcome === 'close failed') return { code: 1, stdout: '', stderr: 'native close failed' };
      listing.tabs = listing.tabs.filter(({ id }) => id !== flagsOf(args).id);
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const code = await openCoordinator({ root: ROOT, login: 'owner', runtimeOverride: 'codex', platform: 'linux',
      git: gitFor(settingsText({ runtimes: ['claude', 'codex'], coordinator: { runtime: 'claude' } }), []),
      herdrApp, hc: hcFor(records, []), capLock: (work) => work(), print: (line) => lines.push(line) });

    const said = lines.join('\n');
    assert.equal(code, outcome === 'replaced' ? 0 : 1, `${outcome}: ${said}`);
    assert.deepEqual(newTabs(app).map(flagsOf), [{ space: 'spproject1', name: 'Coordinator', folder: ROOT, argv: codexArgv }], outcome);
    const shouldClose = outcome === 'replaced' || outcome === 'close failed';
    assert.deepEqual(closes(app).map(flagsOf), shouldClose ? [{ id: 'tbc' }] : [], outcome);
    assert.deepEqual(app.filter(([kind]) => kind === 'do').map(([, command]) => command),
      shouldClose ? ['tab.new', 'tab.close'] : ['tab.new'], outcome);
    assert.deepEqual(listing.tabs.map(({ id }) => id),
      outcome === 'replaced' ? ['tbnew'] : outcome === 'launch failed' ? ['tbc'] : ['tbc', 'tbnew'], outcome);
    if (shouldClose) {
      const created = app.indexOf(newTabs(app)[0]);
      const closing = app.indexOf(closes(app)[0]);
      assert.ok(app.slice(created + 1, closing).some(([kind]) => kind === 'ls'), 'read back the same space before closing');
    }
    if (outcome === 'launch failed') {
      assert.match(said, /native launch failed/);
    } else if (outcome !== 'replaced') {
      assert.match(said, /\bopened\b/i, outcome);
      assert.doesNotMatch(said, /\bnot opened\b/i, outcome);
      assert.match(said, /\btbc\b/, outcome);
      if (outcome === 'close failed') assert.match(said, /native close failed/);
    }
  }
});

test('929 recognizes the stopped native Herdr Coordinator shell', async () => {
  // Herdr keeps its original launch argv after the wrapper execs an interactive shell at the same PID.
  const bash = '/usr/bin/bash';
  const launchArgv = [bash, '-ic', '"$@"; exec "$0" -i', bash, ...argvFor('opus', 'medium', 'owner')];
  const wrapper = liveRecord({ foreground: 'bash', argv: launchArgv, status: null, foregroundPid: 100 });
  const shell = { ...wrapper, foreground: { ...wrapper.foreground, argv: [bash, '-i'] } };
  const listing = coordinatorListing(listed('t9'));
  const replaced = await opened({ listing, records: { t9: shell } });
  assert.equal(replaced.code, 0, replaced.said);
  assert.deepEqual(closes(replaced.app).map(flagsOf), [{ id: 'tbc' }]);
  assert.equal(newTabs(replaced.app).length, 1);

  for (const { kind, record } of [
    { kind: 'wrapper still running', record: { ...wrapper, foreground: { ...wrapper.foreground, argv: launchArgv } } },
    { kind: 'child process', record: { ...shell, foreground: { ...shell.foreground, pid: 101 } } },
    { kind: 'active status', record: { ...shell, status: { state: 'working' } } },
    { kind: 'different live task', record: { ...shell, foreground: { ...shell.foreground, argv: [bash, '-c', 'other-task'] } } },
    { kind: 'unreadable foreground', record: { ...shell, foreground: { ...shell.foreground, argv: [] } } },
  ]) {
    const kept = await opened({ listing, records: { t9: record } });
    assert.notEqual(kept.code, 0, kind);
    assert.deepEqual(kept.app, [['ls']], kind);
    if (kind === 'unreadable foreground') assert.match(kept.said, /hc get t9/);
  }
});

// The project folder and Node executable of the Windows cases; a project space at `folder` with no Coordinator tab; and a project
// space at the Windows folder whose Coordinator tab holds `terminals`.
const WINDOWS_ROOT = 'C:\\r';
const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const windowsSpace = (folder = WINDOWS_ROOT) => ({ spaces: [space('spproject1', 'r', [['tb1', '1']], null, folder)] });
const windowsListing = (terminals) => {
  const listing = coordinatorListing(terminals);
  listing.spaces[0].folder = WINDOWS_ROOT;
  return listing;
};
// `hc get --json` records recorded on Windows, labelled with this fixture's space and tab: a coordinator running through Herdr's
// PowerShell wrapper, the same wrapper after its program exited to the `-NoExit` shell, and a Coordinator tab Herdr restored after a restart.
const WINDOWS_RUNNING = JSON.parse(String.raw`{"address":"t5","argv":["powershell.exe","-NoExit","-Command","& 'node' 'C:\\r\\scripts\\coordinator.mjs' 'launch' '--runtime' 'claude' '--login' 'owner' '--model' 'opus' '--effort' 'medium'"],"cols":120,"created_ms":1795726188608,"cwd":"C:\\Users\\tester","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["C:\\Program Files\\nodejs\\node.exe","C:\\r\\scripts\\coordinator.mjs","launch","--runtime","claude","--login","owner","--model","opus","--effort","medium"],"cwd":"C:\\Users\\tester","name":"node.exe","pid":6080},"identity":"ghostty","keep":true,"labels":{"herdr.seen":"0","herdr.space":"spproject1","herdr.tab":"tbc","where":"~ / probe-claude"},"name":null,"notify":true,"parent":null,"pid":5180,"reason":null,"reported":false,"rm":false,"rows":33,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"claude","turn":0}`);
const WINDOWS_EXITED = JSON.parse(String.raw`{"address":"t6","argv":["powershell.exe","-NoExit","-Command","& 'node' 'C:\\r\\scripts\\coordinator.mjs' 'launch' '--runtime' 'claude' '--login' 'owner'"],"cols":120,"created_ms":1795726203733,"cwd":"C:\\Users\\tester","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","-NoExit","-Command","& 'node' 'C:\\r\\scripts\\coordinator.mjs' 'launch' '--runtime' 'claude' '--login' 'owner'"],"cwd":"C:\\Users\\tester","name":"powershell.exe","pid":3220},"identity":"ghostty","keep":true,"labels":{"herdr.seen":"0","herdr.space":"spproject1","herdr.tab":"tbc","where":"~ / probe-exited"},"name":null,"notify":true,"parent":null,"pid":3220,"reason":null,"reported":false,"rm":false,"rows":33,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"Administrator: C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","turn":0}`);
const WINDOWS_RESTORED = JSON.parse(String.raw`{"address":"t1","argv":["powershell.exe","-NoExit","-Command","$global:__hc_prompt = $function:prompt; function global:prompt { $p = & $global:__hc_prompt; $l = $ExecutionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }; $p }"],"cols":120,"created_ms":1795725665994,"cwd":"C:\\Users\\tester","die_with_parent":false,"exit_code":null,"finished_ms":null,"foreground":{"argv":["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","-NoExit","-Command","$global:__hc_prompt = $function:prompt; function global:prompt { $p = & $global:__hc_prompt; $l = $ExecutionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }; $p }"],"cwd":"C:\\Users\\tester","name":"powershell.exe","pid":5124},"identity":"ghostty","keep":true,"labels":{"herdr.seen":"0","herdr.space":"spproject1","herdr.tab":"tbc","where":"~ / 1"},"name":null,"notify":true,"parent":null,"pid":5124,"reason":null,"reported":false,"rm":false,"rows":33,"screen":"exact","signal":null,"state":"live","status":null,"status_ms":null,"template":null,"title":"Administrator: C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","turn":0}`);

// new behaviour: on Windows the Coordinator tab runs this Node through the coordinator command's launch, with no prompt in its argv
test('on Windows the coordinator opens a tab that runs the launch command with the settings model and effort', async () => {
  const listing = windowsSpace();
  const claude = await opened({ listing, root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE,
    text: settingsText({ coordinator: { model: 'sonnet', effort: 'high' } }) });
  assert.equal(claude.code, 0, claude.said);
  assert.deepEqual(newTabs(claude.app).map(flagsOf), [{ space: 'spproject1', name: 'Coordinator', folder: 'C:\\r',
    argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\r\\scripts\\coordinator.mjs', 'launch', '--runtime', 'claude', '--login', 'owner',
      '--model', 'sonnet', '--effort', 'high'] }]);

  const codex = await opened({ listing, root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE,
    text: settingsText({ runtimes: ['codex'], coordinator: { runtime: 'codex' } }) });
  assert.equal(codex.code, 0, codex.said);
  assert.deepEqual(newTabs(codex.app).map((args) => flagsOf(args).argv),
    [['C:\\Program Files\\nodejs\\node.exe', 'C:\\r\\scripts\\coordinator.mjs', 'launch', '--runtime', 'codex', '--login', 'owner']]);
});

// new behaviour: Herdr lists a Windows space's folder with forward slashes, which is still the project's folder
test("on Windows the coordinator opens its tab in the project's space where Herdr lists that space's folder with forward slashes", async () => {
  const opens = await opened({ listing: windowsSpace('C:/r'), root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(opens.code, 0, opens.said);
  assert.deepEqual(opens.app.filter(([kind]) => kind === 'do').map((args) => args.slice(0, 2)), [['do', 'tab.new']]);
  assert.equal(flagsOf(newTabs(opens.app)[0]).space, 'spproject1');
});

test("on Windows the coordinator reads the Coordinator tab of the project's space that Herdr lists with forward slashes", async () => {
  const listing = withCoordinator(space('spproject1', 'r', [['tb1', '1']], null, 'C:/r'), ['t5']);
  const read = await coordinatorTerminals({ root: WINDOWS_ROOT, platform: 'win32', herdrApp: herdrAppFor({ spaces: [listing] }, []),
    hc: hcFor({ t5: WINDOWS_RUNNING }, []) });
  assert.equal(read.space?.id, 'spproject1');
  assert.deepEqual(read.terminals.map(({ address, running }) => ({ address, running })), [{ address: 't5', running: true }]);
});

// A Windows project whose git prints its worktrees with forward slashes: the main worktree and the detached job worktrees at `paths`.
const forwardSlashJobs = (paths, cards) => {
  const windowsRoot = 'C:\\ft\\repo';
  const job = jobFixture({ root: windowsRoot, spaces: [space('spproject1', 'repo', [['tb1', '1']], null, windowsRoot)],
    pages: [leanBoardPage(cards.map((card) => issue(card, { status: 'In progress' })))] });
  const git = gitFor(settingsText(), [], { root: 'C:/ft/repo', registered: paths.map((path) => ({ path })) });
  return { job, unfinished: () => job.unfinished({ root: windowsRoot, platform: 'win32', git }) };
};

test("on Windows the unfinished jobs check reads git's forward-slash worktree paths in both job layouts", async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { job, unfinished } = forwardSlashJobs(['C:/ft/repo/.claude/worktrees/job-7', 'C:/ft/jobs/8'], [7, 8]);
  assert.equal(await unfinished(), 0, job.lines.join('\n'));
  assert.equal(job.lines.length, 2, job.lines.join('\n'));
  assert.match(job.lines[0], /^#7 continue: /);
  assert.match(job.lines[1], /^#8 continue: /);
});

test('on Windows a job terminal whose Herdr folder uses forward slashes is matched to its backslash worktree', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { job, unfinished } = forwardSlashJobs(['C:/ft/jobs/8'], [8]);
  job.addJob('t8', 8, 'claude', 'working');
  job.terminals[0].cwd = 'C:/FT/jobs/8/src';
  job.details.t8.cwd = 'C:/FT/jobs/8/src';
  job.details.t8.labels = {};
  assert.equal(await unfinished(), 0, job.lines.join('\n'));
  assert.equal(job.lines.length, 1, job.lines.join('\n'));
  assert.match(job.lines[0], /^#8 running: terminal t8$/);
});

test("on Windows the unfinished-jobs list reads job tabs of the project's space that Herdr lists with forward slashes", async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const job = jobFixture({ spaces: [space('spproject1', 'r', [['tb1', '1']], null, 'C:/r')], pages: [leanBoardPage([issue(6, { status: 'In progress' })])], branches: [6] });
  job.addJob('t6', 6, 'claude', 'working');
  assert.equal(await job.unfinished({ root: WINDOWS_ROOT, platform: 'win32' }), 0, job.lines.join('\n'));
  assert.equal(job.lines.length, 1, job.lines.join('\n'));
  assert.match(job.lines[0], /^#6 running: terminal t6$/);
});

// new behaviour: an empty or relative folder is resolved against no directory, so it is no project's root, however the command's
// working directory sits against the root
test('on Windows the coordinator matches no space whose listed folder is empty, relative or the current directory', async () => {
  const here = process.cwd();
  for (const [folder, root] of [['', here], ['.', here], ['sub', `${here}/sub`], ['..\\r', `${here}/../r`]]) {
    const listing = withCoordinator(space('spproject1', 'r', [['tb1', '1']], null, folder), ['t5']);
    const read = await coordinatorTerminals({ root, platform: 'win32', herdrApp: herdrAppFor({ spaces: [listing] }, []), hc: hcFor({ t5: WINDOWS_RUNNING }, []) });
    assert.equal(read.space, undefined, `${JSON.stringify(folder)} against ${root}`);
    assert.deepEqual(read.terminals, [], JSON.stringify(folder));
  }
});

test('on Linux the coordinator matches a project space only by its exact folder', async () => {
  const listing = space('spproject1', 'r', [['tb1', '1']], null, '/srv//r');
  const read = await coordinatorTerminals({ root: '/srv/r', platform: 'linux', herdrApp: herdrAppFor({ spaces: [withCoordinator(listing, ['t5'])] }, []), hc: hcFor({ t5: liveRecord() }, []) });
  assert.equal(read.space, undefined);
  assert.deepEqual(read.terminals, []);
});

// new behaviour: Herdr wraps a Windows tab's argv in single-quoted PowerShell, so a path holding a single quote is refused before any tab
test('on Windows the coordinator refuses a Node or project path holding a single quote before opening any tab', async () => {
  const quotedRoot = "C:\\o'r";
  const byRoot = await opened({ listing: windowsSpace(quotedRoot), root: quotedRoot, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(byRoot.code, 1, byRoot.said);
  assert.equal(byRoot.said, "Coordinator not opened: C:\\o'r holds a single quote, which a Windows Herdr tab cannot pass.");
  assert.deepEqual(byRoot.app.filter(([kind]) => kind === 'do'), []);

  const quotedNode = "C:\\it's\\node.exe";
  const byNode = await opened({ listing: windowsSpace(), root: WINDOWS_ROOT, platform: 'win32', node: quotedNode });
  assert.equal(byNode.code, 1, byNode.said);
  assert.equal(byNode.said, "Coordinator not opened: C:\\it's\\node.exe holds a single quote, which a Windows Herdr tab cannot pass.");
  assert.deepEqual(byNode.app.filter(([kind]) => kind === 'do'), []);
});

// new behaviour: a coordinator running through Herdr's PowerShell wrapper is kept
test('on Windows a Coordinator tab whose wrapper runs the coordinator is kept', async () => {
  const kept = await opened({ listing: windowsListing(listed('t5')), records: { t5: WINDOWS_RUNNING }, root: WINDOWS_ROOT, platform: 'win32',
    node: WINDOWS_NODE });
  assert.equal(kept.code, 5, kept.said);
  assert.equal(kept.said, 'The Coordinator tab tbc is already open in space spproject1; use it.');
  assert.deepEqual(kept.app, [['ls']]);
});

// new behaviour: the wrapper's -NoExit shell left after the coordinator exits, and a tab Herdr restored after a restart, are stopped
test('on Windows a Coordinator tab left at its PowerShell prompt or restored after a restart is replaced', async () => {
  for (const [address, record] of [['t6', WINDOWS_EXITED], ['t1', WINDOWS_RESTORED]]) {
    const replaced = await opened({ listing: windowsListing(listed(address)), records: { [address]: record }, root: WINDOWS_ROOT, platform: 'win32',
      node: WINDOWS_NODE });
    assert.equal(replaced.code, 0, `${address}: ${replaced.said}`);
    assert.deepEqual(replaced.app.filter(([kind]) => kind === 'do').map((args) => args.slice(0, 2)), [['do', 'tab.close'], ['do', 'tab.new']], address);
    assert.deepEqual(flagsOf(closes(replaced.app)[0]), { id: 'tbc' }, address);
    assert.equal(replaced.said, 'Replaced the Coordinator tab tbc, in which nothing ran.\nCoordinator opened in space spproject1.', address);
  }
});

test('on Windows a Coordinator tab whose PowerShell wrapper lacks -NoExit is not read as a stopped coordinator', async () => {
  const [program, , ...command] = WINDOWS_EXITED.argv;
  const unread = await opened({ listing: windowsListing(listed('t6')), records: { t6: { ...WINDOWS_EXITED, argv: [program, '-NoLogo', ...command] } },
    root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(unread.code, 1, unread.said);
  assert.deepEqual(unread.app, [['ls']]);
  assert.match(unread.said, /hc get t6/);
});

// new behaviour: a program the wrapper's shell started that is not Node is no coordinator, whatever its process id
test('on Windows a Coordinator tab whose foreground is another program than node.exe is not read as a coordinator or as a stopped one', async () => {
  for (const [name, argv, pid] of /** @type {[string, string[], number][]} */ ([['ping.exe', ['C:\\WINDOWS\\System32\\PING.EXE', 'localhost'], 4242],
    ['powershell.exe', ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile'], 4243]])) {
    const record = { ...WINDOWS_EXITED, foreground: { ...WINDOWS_EXITED.foreground, name, argv, pid } };
    const unread = await opened({ listing: windowsListing(listed('t6')), records: { t6: record }, root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
    assert.equal(unread.code, 1, `${name}: ${unread.said}`);
    assert.deepEqual(unread.app, [['ls']], name);
    assert.match(unread.said, /hc get t6/, name);
  }
});

// new behaviour: only a node.exe running this project's launch command is a coordinator; another Node program is neither it nor a stopped tab
const WINDOWS_LAUNCHER = [WINDOWS_NODE, 'C:\\r\\scripts\\coordinator.mjs', 'launch', '--runtime', 'claude', '--login', 'owner', '--model', 'opus', '--effort', 'medium'];
const withNodeForeground = (argv) => ({ ...WINDOWS_RUNNING, foreground: { ...WINDOWS_RUNNING.foreground, name: 'node.exe', argv } });

test('on Windows a Coordinator tab whose foreground node.exe runs the coordinator launch command is kept', async () => {
  const kept = await opened({ listing: windowsListing(listed('t5')), records: { t5: withNodeForeground(WINDOWS_LAUNCHER) }, root: WINDOWS_ROOT,
    platform: 'win32', node: WINDOWS_NODE });
  assert.equal(kept.code, 5, kept.said);
  assert.deepEqual(kept.app, [['ls']]);
});

// new behaviour: on Windows the relay and the wake reach a coordinator running under the launcher once Herdr reports its status, by the Linux rules
test('on Windows the relay and the wake reach a launcher coordinator by its status', async () => {
  const listing = windowsListing(listed('t5'));
  const scene = async (status) => {
    const records = { t5: { ...withNodeForeground(WINDOWS_LAUNCHER), status } };
    const relayCalls = [];
    const relay = await /** @type {Relay} */ (/** @type {unknown} */ (coordinator)).relayToCoordinator({ root: WINDOWS_ROOT, platform: 'win32', herdrApp: herdrAppFor(listing, []), hc: hcFor(records, relayCalls), line: PANEL_LINE });
    const wakeCalls = [];
    const wakeLines = [];
    const wakeCode = await wakeCoordinator({ root: WINDOWS_ROOT, platform: 'win32', herdrApp: herdrAppFor(listing, []), hc: hcFor(records, wakeCalls), print: (line) => wakeLines.push(line) });
    return { relay, relaySends: relayCalls.filter(([kind]) => kind === 'send'), wakeCode, wakeSends: wakeCalls.filter(([kind]) => kind === 'send'), said: wakeLines.join('\n') };
  };

  const done = await scene({ app: 'claude-code', state: 'done' });
  assert.equal(done.relay.code, 0, done.relay.message);
  assert.deepEqual(done.relaySends, [['send', 't5', PANEL_LINE]]);
  assert.equal(done.wakeCode, 0, done.said);
  assert.deepEqual(done.wakeSends, [['send', 't5', 'A card moved to Ready.']]);

  const blocked = await scene({ app: 'claude-code', state: 'blocked' });
  assert.equal(blocked.relay.code, 4, blocked.relay.message);
  assert.deepEqual(blocked.relaySends, []);
  assert.equal(blocked.wakeCode, 4, blocked.said);
  assert.deepEqual(blocked.wakeSends, []);
  assert.match(blocked.said, /is asking the owner/);
});

test('on Linux the relay and the wake never call a running Coordinator terminal whose foreground is named node.exe the Windows launcher', async () => {
  const listing = coordinatorListing(listed('t9'));
  const records = { t9: liveRecord({ foreground: 'node.exe', status: null, foregroundPid: 100 }) };

  const relayCalls = [];
  const relay = await /** @type {Relay} */ (/** @type {unknown} */ (coordinator)).relayToCoordinator({ root: ROOT, platform: 'linux', herdrApp: herdrAppFor(listing, []), hc: hcFor(records, relayCalls), line: PANEL_LINE });
  assert.equal(relay.code, 4, relay.message);
  assert.deepEqual(relayCalls.filter(([kind]) => kind === 'send'), []);
  assert.doesNotMatch(relay.message, /Windows launcher/);

  const wakeCalls = [];
  const wakeLines = [];
  const wakeCode = await wakeCoordinator({ root: ROOT, platform: 'linux', herdrApp: herdrAppFor(listing, []), hc: hcFor(records, wakeCalls), print: (line) => wakeLines.push(line) });
  const said = wakeLines.join('\n');
  assert.equal(wakeCode, 4, said);
  assert.deepEqual(wakeCalls.filter(([kind]) => kind === 'send'), []);
  assert.doesNotMatch(said, /Windows launcher/);
});

test('on Windows a Coordinator tab whose foreground node.exe runs another program is not read as a coordinator or as a stopped one', async () => {
  for (const [kind, argv] of /** @type {[string, string[]][]} */ ([['another script', [WINDOWS_NODE, 'C:\\tools\\build.mjs']],
    ['the Node interactive shell', [WINDOWS_NODE]], ['launch of another script', [WINDOWS_NODE, 'C:\\tools\\other.mjs', 'launch']]])) {
    const unread = await opened({ listing: windowsListing(listed('t5')), records: { t5: withNodeForeground(argv) }, root: WINDOWS_ROOT, platform: 'win32',
      node: WINDOWS_NODE });
    assert.equal(unread.code, 1, `${kind}: ${unread.said}`);
    assert.deepEqual(unread.app, [['ls']], kind);
    assert.match(unread.said, /hc get t5/, kind);
  }
});

test('on Windows a Coordinator tab whose foreground node.exe runs coordinator.mjs with another command than launch is not read as a coordinator or as a stopped one', async () => {
  const unread = await opened({ listing: windowsListing(listed('t5')), records: { t5: withNodeForeground([WINDOWS_NODE, 'C:\\r\\scripts\\coordinator.mjs', 'status']) },
    root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(unread.code, 1, unread.said);
  assert.deepEqual(unread.app, [['ls']]);
  assert.match(unread.said, /hc get t5/);
});

test('on Windows a Coordinator tab whose foreground node.exe runs another script given the coordinator launch as arguments is not read as a coordinator or as a stopped one', async () => {
  const unread = await opened({ listing: windowsListing(listed('t5')),
    records: { t5: withNodeForeground([WINDOWS_NODE, 'C:\\tools\\watch.mjs', 'C:\\r\\scripts\\coordinator.mjs', 'launch', '--runtime', 'claude', '--login', 'owner']) },
    root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(unread.code, 1, unread.said);
  assert.deepEqual(unread.app, [['ls']]);
  assert.match(unread.said, /hc get t5/);
});

test('on Windows a Coordinator tab whose foreground node.exe takes a Node option naming coordinator.mjs is not read as a coordinator or as a stopped one', async () => {
  const unread = await opened({ listing: windowsListing(listed('t5')),
    records: { t5: withNodeForeground([WINDOWS_NODE, '--import=file:///C:/tools/coordinator.mjs', 'launch']) },
    root: WINDOWS_ROOT, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(unread.code, 1, unread.said);
  assert.deepEqual(unread.app, [['ls']]);
  assert.match(unread.said, /hc get t5/);
});

// new behaviour: Herdr's spelling of a Windows folder may differ from the project's in the drive letter's case, a trailing separator or case
test("on Windows the coordinator reads the Coordinator tab of the project's space that Herdr lists with another drive letter case or a trailing separator", async () => {
  for (const [folder, root] of [['c:/r', WINDOWS_ROOT], ['C:/r/', WINDOWS_ROOT], ['c:/R/', WINDOWS_ROOT], ['C:/r', 'C:\\r\\']]) {
    const listing = withCoordinator(space('spproject1', 'r', [['tb1', '1']], null, folder), ['t5']);
    const read = await coordinatorTerminals({ root, platform: 'win32', herdrApp: herdrAppFor({ spaces: [listing] }, []), hc: hcFor({ t5: WINDOWS_RUNNING }, []) });
    assert.equal(read.space?.id, 'spproject1', `${folder} against ${root}`);
  }
});

test('on Windows the coordinator opens a new space named for the last folder of the project path', async () => {
  const root = 'C:\\work\\proj';
  const opens = await opened({ listing: windowsSpace(), root, platform: 'win32', node: WINDOWS_NODE });
  assert.equal(opens.code, 0, opens.said);
  assert.deepEqual(opens.app.map((args) => args.slice(0, 2)), [['ls'], ['do', 'space.new']]);
  assert.equal(flagsOf(opens.app[1]).name, 'proj');
  assert.equal(flagsOf(opens.app[1]).folder, root);
});

test('on Windows the sole stopped Coordinator tab is closed only after its replacement is verified against the Windows terminal record', async () => {
  const listing = withCoordinator(space('spproject1', 'r', [], null, WINDOWS_ROOT), ['t6']);
  const app = [];
  const herdrApp = async (args) => {
    app.push(args);
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ spaces: [listing] }), stderr: '' };
    if (args[1] === 'tab.new') {
      listing.tabs.push({ id: 'tbnew', name: 'Coordinator', terminals: listed('tnew') });
      return { code: 0, stdout: '{"space":"spproject1","tab":"tbnew","terminal":"tnew"}', stderr: '' };
    }
    listing.tabs = listing.tabs.filter(({ id }) => id !== flagsOf(args).id);
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const lines = [];
  const code = await openCoordinator({ root: WINDOWS_ROOT, login: 'owner', git: gitFor(settingsText(), []), herdrApp, hc: hcFor({ t6: WINDOWS_EXITED }, []),
    capLock: (work) => work(), platform: 'win32', node: WINDOWS_NODE, print: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(app.filter(([kind]) => kind === 'do').map(([, command]) => command), ['tab.new', 'tab.close']);
  assert.deepEqual(listing.tabs.map(({ id }) => id), ['tbnew']);
});

// new behaviour: only Windows takes the launch form; macOS opens the same tab argv as Linux
test('on macOS the coordinator opens the same tab argv as on Linux', async () => {
  const listing = { spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)] };
  const mac = await opened({ listing, platform: 'darwin', node: '/usr/local/bin/node' });
  assert.equal(mac.code, 0, mac.said);
  assert.deepEqual(newTabs(mac.app).map((args) => flagsOf(args).argv), [argvFor('opus', 'medium', 'owner')]);
});

// One launch with a recording `spawn` answering `reply`: its exit code, the spawn calls and what it printed.
/** @param {Record<string, string>} options @param {{ status: number | null, signal: string | null, error?: Error }} [reply] */
async function launched(options, reply = { status: 0, signal: null }) {
  const calls = [];
  const lines = [];
  const code = await launchCoordinator({ ...options, env: { PATH: 'C:\\bin' }, print: (line) => lines.push(line),
    spawn: (program, args, spawnOptions) => {
      calls.push({ program, args, stdio: spawnOptions.stdio, env: spawnOptions.env });
      return reply;
    } });
  return { code, calls, said: lines.join('\n') };
}

// new behaviour: the launch passes the prompt as one argument, so its double quotes reach the runtime intact
test('the coordinator launch starts Claude with the prompt intact and the model and effort in its environment, and Codex with neither', async () => {
  const coordinatorPromptText = 'Coordinate this project from its Herdr space: read .agents/skills/resume/references/herdr-lead.md whole and follow its "Coordinator" section.\n{"login":"owner"}';
  const claude = await launched({ runtime: 'claude', login: 'owner', model: 'sonnet', effort: 'high' });
  assert.equal(claude.code, 0, claude.said);
  assert.deepEqual(claude.calls, [{ program: 'claude', args: ['--permission-mode', 'auto', '--', coordinatorPromptText], stdio: 'inherit',
    env: { PATH: 'C:\\bin', ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_EFFORT_LEVEL: 'high' } }]);

  const codex = await launched({ runtime: 'codex', login: 'owner' }, { status: 3, signal: null });
  assert.equal(codex.code, 3, codex.said);
  assert.deepEqual(codex.calls, [{ program: 'codex', args: ['--no-daemon', '--enable', 'default_mode_request_user_input', '--', coordinatorPromptText],
    stdio: 'inherit', env: { PATH: 'C:\\bin' } }]);
});

// new behaviour: a runtime that cannot be started is named with its cause
test('the coordinator launch prints why the runtime did not run and exits 1', async () => {
  const failed = await launched({ runtime: 'claude', login: 'owner', model: 'opus', effort: 'medium' },
    { error: new Error('spawnSync claude ENOENT'), status: null, signal: null });
  assert.equal(failed.code, 1);
  assert.equal(failed.said, 'Coordinator not started: claude did not run: spawnSync claude ENOENT');
});

test('the coordinator launch exits 1 where a signal ended the runtime', async () => {
  const ended = await launched({ runtime: 'claude', login: 'owner', model: 'opus', effort: 'medium' }, { status: null, signal: 'SIGTERM', error: undefined });
  assert.equal(ended.code, 1, ended.said);
});

test('the coordinator cap reader defaults to 4 and accepts only whole numbers from 1 to 16', (t) => {
  const state = mkdtempSync(join(tmpdir(), 'coordinator-cap-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const path = join(state, 'lead.json');

  assert.equal(readCap(path), 4);
  for (const cap of [1, 16]) {
    writeFileSync(path, JSON.stringify({ cap }));
    assert.equal(readCap(path), cap);
  }
  for (const cap of [0, 17, '4']) {
    writeFileSync(path, JSON.stringify({ cap }));
    assert.throws(() => readCap(path), { message: `${path} must set cap to a whole number from 1 to 16, not ${JSON.stringify(cap)}` });
  }
  writeFileSync(path, '{');
  assert.throws(() => readCap(path), (error) => error instanceof Error && error.message.startsWith(`${path} is not JSON: `));
});

test('two coordinator opens racing leave one Coordinator tab, and the second closes no starting coordinator', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const state = mkdtempSync(join(tmpdir(), 'coordinator-race-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const spaces = [space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT)];
  const app = [];
  const herdrApp = async (args) => {
    app.push(args);
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ spaces }), stderr: '' };
    if (args[1] === 'tab.new') spaces[0].tabs.push(/** @type {any} */ ({ id: 'tbnew', name: 'Coordinator', terminals: [{ terminal: 'tnew' }] }));
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const starting = liveRecord({ foreground: 'env', status: null, foregroundPid: 100 });
  const open = () => openCoordinator({ root: ROOT, login: 'owner', git: gitFor(settingsText(), []), herdrApp, hc: hcFor({ tnew: starting }, []),
    capLock: (work) => capLock(state, work), print: () => {} });
  const codes = await Promise.all([open(), open()]);
  assert.deepEqual([...codes].sort(), [0, 5]);
  assert.equal(newTabs(app).length, 1, 'one Coordinator tab is made');
  assert.deepEqual(closes(app), [], 'the starting coordinator is not closed');
});

// Whether this machine lets an unprivileged process create a file symlink. Copied from factory-sync.test.mjs, which no test file imports from.
function fileSymlinksAvailable() {
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync('target', join(dir, 'link'), 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM') return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE_SYMLINKS = fileSymlinksAvailable();
const NEEDS_FILE_SYMLINK = { skip: !FILE_SYMLINKS && 'creating a file symlink on Windows needs Developer Mode or administrator rights' };
const CAP_LOCK_URL = new URL('./cap-lock.mjs', import.meta.url).href;

// What a child process's exclusive `lockLeadFile(path, { waitMs: 0 })` finds: `busy` or `free`.
function externalLockProbe(path) {
  const code = `import { lockLeadFile } from ${JSON.stringify(CAP_LOCK_URL)};
    const lock = await lockLeadFile(${JSON.stringify(path)}, { waitMs: 0 });
    lock?.release();
    console.log(lock === undefined ? 'busy' : 'free');`;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  return probe.stdout.trim();
}

// A child process that holds `lockLeadFile(path)` exclusively, or `capLock` over `path`'s folder when `viaCap`, prints `held`
// and stays alive until `stop` kills it.
async function lockHolder(path, viaCap = false) {
  const code = `import { capLock, lockLeadFile } from ${JSON.stringify(CAP_LOCK_URL)};
    const hold = () => { console.log('held'); return new Promise(() => setInterval(() => {}, 1e6)); };
    ${viaCap ? `await capLock(${JSON.stringify(dirname(path))}, hold);` : `await lockLeadFile(${JSON.stringify(path)}); await hold();`}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  const first = await Promise.race([once(child.stdout, 'data').then(([chunk]) => String(chunk).trim()), closed.then(([code, signal]) => `exited with ${code ?? signal} before holding the lock`)]);
  assert.equal(first, 'held');
  return { running: () => child.exitCode === null, stop: async () => { child.kill('SIGKILL'); await closed; } };
}

// existing behaviour: the cap lock makes the count and the launch one step across coordinators
test('cap lock: two coordinator starts at a cap of one launch one job and refuse the other', async (t) => {
  const state = lockFolder(t);
  const cardOf = (fixture) => fixture.runs().at(-1).find((arg, index, args) => args[index - 1] === '--label' && arg.startsWith('fabraik.card=')).slice('fabraik.card='.length);
  const rootA = workflowRepository(t);
  const first = jobFixture({ root: rootA, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, rootA)], pages: READY_BOARD(),
    onLaunch: () => first.addJob('t10', cardOf(first), 'env', null) });
  const rootB = workflowRepository(t);
  const second = jobFixture({ root: rootB, spaces: [space('spproject2', 'fabraik2', [['tb1', '1']], null, rootB)], pages: READY_BOARD(),
    onLaunch: () => second.addJob('t20', cardOf(second), 'env', null, { 'fabraik.space': 'spproject2' }) });
  second.coordinatorAddresses = ['t1'];
  second.details.t1 = { ...liveRecord({ foregroundPid: 101 }), address: 't1', cwd: rootB };
  delete second.details.t0;
  second.launch = { code: 0, stdout: JSON.stringify({ address: 't20' }), stderr: '' };

  // Each contender lists the jobs of both fixtures, waiting up to 1 s for the other to reach its own listing first.
  const listed = [];
  const arrived = Promise.withResolvers();
  let arrivals = 0;
  const machine = (own, other) => async (args) => {
    if (args.join(' ') === 'ls --label fabraik.role=job --json') {
      if (++arrivals === 2) arrived.resolve(undefined);
      const timer = setTimeout(() => arrived.resolve(undefined), 1000);
      await arrived.promise;
      clearTimeout(timer);
      const terminals = (await Promise.all([own.hc(args), other.hc(args)])).flatMap((reply) => JSON.parse(reply.stdout).terminals);
      listed.push(terminals.length);
      return { code: 0, stdout: JSON.stringify({ hidden_finished: 0, machines: [], terminals }), stderr: '' };
    }
    const reply = await own.hc(args);
    return args[0] === 'get' && reply.code !== 0 ? other.hc(args) : reply;
  };
  const options = (own, other) => ({ cap: () => 1, capLock: (work) => capLock(state, work), hc: machine(own, other) });
  const codes = await Promise.all([first.start(5, { ...options(first, second), parent: 't0' }), second.start(6, { ...options(second, first), parent: 't1' })]);
  assert.deepEqual([...codes].sort(), [0, 1]);
  assert.equal(first.runs().length + second.runs().length, 1);
  assert.deepEqual(listed, [0, 1], 'the second count saw the first launch');
  const [[winner], [loser, refused]] = codes[0] === 0 ? [[5, first], [6, second]] : [[6, second], [5, first]];
  assert.deepEqual(refused.lines, [`Card ${loser} not started: 1 of 1 running places are taken (cards ${winner}); a job waiting on the owner takes none.`]);
});

// existing behaviour: a lock lives as long as its holding process and no longer
test('cap lock: a live holder in another process keeps the lock and a dead one frees it', async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const holder = await lockHolder(path, true);
  try {
    assert.equal(await lockLeadFile(path, { waitMs: 0 }), undefined, 'a live holder keeps the lock');
    assert.equal(holder.running(), true, 'the holder is still alive after the busy check');
  } finally {
    await holder.stop();
  }
  assert.equal(await capLock(state, () => 'worked'), 'worked', 'a killed holder frees the lock');
});

// the wait budget runs on the monotonic clock: a wall clock that stands still must not keep a waiter waiting
test('cap lock: the wait budget ignores a wall clock that stands still', { timeout: 5000 }, async (t) => {
  const path = join(lockFolder(t), 'cap.lock');
  const holder = await lockHolder(path);
  try {
    t.mock.timers.enable({ apis: ['Date'] });
    assert.equal(await lockLeadFile(path, { waitMs: 200 }), undefined, 'the waiter gave up on a stopped wall clock');
  } finally {
    t.mock.timers.reset();
    await holder.stop();
  }
});

// existing behaviour: shared probes wait for no one but an exclusive holder
test('cap lock: shared probes see an exclusive holder and do not block each other', async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const holder = await lockHolder(path);
  try {
    assert.equal(await lockLeadFile(path, { shared: true, waitMs: 0, create: false }), undefined, 'an exclusive holder is seen');
  } finally {
    await holder.stop();
  }
  const one = await lockLeadFile(path, { shared: true, waitMs: 0, create: false });
  const two = await lockLeadFile(path, { shared: true, waitMs: 0, create: false });
  try {
    assert.notEqual(one, undefined);
    assert.notEqual(two, undefined, 'a second shared probe is not blocked');
    assert.equal(await lockLeadFile(path, { waitMs: 0 }), undefined, 'shared holders keep an exclusive lock out');
  } finally {
    for (const lock of [one, two]) lock?.release();
  }
  const gone = join(state, 'gone.lock');
  await assert.rejects(lockLeadFile(gone, { create: false, shared: true, waitMs: 0 }));
  assert.equal(existsSync(gone), false, 'a read-only probe creates no file');
});

// existing behaviour: a symbolic link is never opened as a lock file
test('cap lock: a symbolic link in place of a lock file is refused', NEEDS_FILE_SYMLINK, async (t) => {
  const state = lockFolder(t);
  writeFileSync(join(state, 'target.lock'), '', { mode: 0o600 });
  symlinkSync('target.lock', join(state, 'cap.lock'), 'file');
  await assert.rejects(lockLeadFile(join(state, 'cap.lock')), (/** @type {Error} */ error) => /symbolic link/.test(error.message) && !/while it was being locked/.test(error.message));
});

// A physical lock folder of mode 0700, as the lock requires of its folder off Windows.
function lockFolder(t) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-cap-lock-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return state;
}

// The error a lock refuses with, after checking that the work it guards never ran; `take` locks and runs the work it is given.
async function refusal(take) {
  let ran = false;
  const error = await take(() => { ran = true; }).then(() => undefined, (/** @type {Error} */ failure) => failure);
  assert.equal(ran, false, 'the work never runs');
  assert.ok(error instanceof Error, 'the lock is refused');
  return error;
}

// Runs work under an exclusive `lockLeadFile(path, options)` as `capLock` runs its work, releasing the lock after.
const underLock = (path, options) => async (work) => {
  const lock = await lockLeadFile(path, options);
  assert.ok(lock, 'the lock is acquired');
  try {
    return work();
  } finally {
    lock.release();
  }
};

// The lock's own way of opening a file, which an injected `open` calls once it has changed the file.
const openDefault = (path, options) => new DatabaseSync(path, options);

// new behaviour: a lock file holding data is not a lock file
test('cap lock: a lock file holding data is refused', async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  writeFileSync(path, 'not a lock', { mode: 0o600 });
  assert.match((await refusal((work) => capLock(state, work))).message, /is not a lock file/);
  await assert.rejects(lockLeadFile(path, { shared: true, waitMs: 0 }), /is not a lock file/);
});

// new behaviour: a lock file is refused while a SQLite journal sits beside it
test('cap lock: a lock file with a SQLite journal beside it is refused', async (t) => {
  const state = lockFolder(t);
  writeFileSync(join(state, 'cap.lock'), '', { mode: 0o600 });
  writeFileSync(join(state, 'cap.lock-journal'), '', { mode: 0o600 });
  assert.match((await refusal((work) => capLock(state, work))).message, /a SQLite journal is beside it/);
});

// new behaviour: a lock folder others can read is refused, naming the folder, and a private one is used
test('cap lock: a lock folder not private to this account is refused', { skip: process.platform === 'win32' && 'Windows has no folder modes' }, async (t) => {
  const state = lockFolder(t);
  chmodSync(state, 0o755);
  const { message } = await refusal((work) => capLock(state, work));
  assert.ok(message.startsWith(`${state} must be `), message);
  chmodSync(state, 0o700);
  assert.equal(await capLock(state, () => 'worked'), 'worked');

  // A private folder under a parent another account can change is refused too.
  const parent = lockFolder(t);
  const folder = join(parent, 'state');
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(parent, 0o770);
  const ancestor = await refusal((work) => capLock(folder, work));
  assert.equal(ancestor.message, `${folder} has an ancestor ${parent} that another account can change`);
  chmodSync(parent, 0o700);
  assert.equal(await capLock(folder, () => 'worked'), 'worked');

  // On macOS an access control list lets another account change a 0700 parent's entries.
  if (process.platform === 'darwin') {
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_subdirectory,delete_child', parent]);
    const listed = await refusal((work) => capLock(folder, work));
    assert.equal(listed.message, `${folder} has an ancestor ${parent} that another account can change`);
    execFileSync('/bin/chmod', ['-N', parent]);
    assert.equal(await capLock(folder, () => 'worked'), 'worked');

    // An inherit-only entry on the lock folder reaches the lock files it holds.
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_file,file_inherit,only_inherit', folder]);
    const own = await refusal((work) => capLock(folder, work));
    assert.equal(own.message, `${folder} has an access control list that lets another account change it`);
    execFileSync('/bin/chmod', ['-N', folder]);
    assert.equal(await capLock(folder, () => 'worked'), 'worked');
  }
});

// new behaviour: a macOS access control list entry that lets another account change entries is a grant
test('cap lock: an access control list that lets another account change entries is a grant', () => {
  const head = 'drwx------+ 3 me  staff  96 Nov 26 10:00 /tmp/x';
  const listing = (...entries) => [head, ...entries].join('\n');
  const owner = ' 0: user:me allow add_subdirectory,delete_child';
  const denied = ' 0: group:everyone deny delete';
  const staff = ' 0: group:staff inherited allow list,add_subdirectory';
  const root = ' 0: user:root allow delete_child';
  const other = ' 1: user:other allow writesecurity';
  const spaced = ' 0: group:Domain Users allow add_subdirectory,delete_child';
  const inheritOnly = ' 0: group:staff allow delete,file_inherit,only_inherit';
  assert.equal(aclGrantsOthers(listing(owner), 'me'), undefined);
  assert.equal(aclGrantsOthers(listing(denied), 'me'), undefined);
  assert.equal(aclGrantsOthers(listing(staff), 'me'), staff);
  assert.equal(aclGrantsOthers(listing(root), 'me'), undefined);
  assert.equal(aclGrantsOthers(head, 'me'), undefined);
  assert.equal(aclGrantsOthers(listing(owner, other), 'me'), other);
  assert.equal(aclGrantsOthers(listing(spaced), 'me'), spaced);
  assert.equal(aclGrantsOthers(listing(inheritOnly), 'me'), undefined);
  assert.equal(aclGrantsOthers(listing(inheritOnly), 'me', true), inheritOnly);
});

// new behaviour: on Windows the lock refuses a folder outside the user profile, whose default permissions it relies on
test('cap lock: on Windows a lock folder outside the user profile is refused', { skip: process.platform !== 'win32' && 'the user profile boundary applies on Windows only' }, async (t) => {
  const state = lockFolder(t);
  const elsewhere = lockFolder(t);
  const code = `import { capLock } from ${JSON.stringify(CAP_LOCK_URL)};
    console.log(await capLock(${JSON.stringify(state)}, () => 'worked'));`;
  const run = (profile) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, USERPROFILE: profile } });
  const outside = run(elsewhere);
  assert.notEqual(outside.status, 0, outside.stdout);
  assert.match(outside.stderr, /must be inside the user profile/);
  const inside = run(dirname(state));
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(inside.stdout.trim(), 'worked');
});

// new behaviour: a held lock whose file another takes the place of fails its check
test('cap lock: a held lock whose file is replaced fails its check', { skip: process.platform === 'win32' && 'a held file cannot be renamed on Windows' }, async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const lock = await lockLeadFile(path);
  assert.ok(lock, 'the lock is acquired');
  t.after(() => lock.release());
  writeFileSync(join(state, 'fresh.lock'), '', { mode: 0o600 });
  renameSync(join(state, 'fresh.lock'), path);
  assert.throws(() => lock.check(), /changed while locked: another file took its place/);
});

// new behaviour: a lock file swapped for another between its admission and its lock is refused
test('cap lock: a lock file replaced before it is locked is refused', async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const fresh = join(state, 'fresh.lock');
  const open = (file, options) => {
    writeFileSync(fresh, '', { mode: 0o600 });
    renameSync(fresh, file);
    return openDefault(file, options);
  };
  const { message } = await refusal(underLock(path, { open }));
  assert.match(message, /changed while it was being locked: another file took its place/);
});

// new behaviour: a busy answer from a file swapped in before the lock is refused rather than reported as busy
test('cap lock: a busy lock file replaced before it is locked is refused', { skip: process.platform === 'win32' && 'a held file cannot be renamed on Windows' }, async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const other = join(state, 'other.lock');
  const holder = await lockHolder(other);
  try {
    const open = (file, options) => {
      renameSync(other, file);
      return openDefault(file, options);
    };
    await assert.rejects(lockLeadFile(path, { waitMs: 0, open }), /changed while it was being locked: another file took its place/);
  } finally {
    await holder.stop();
  }
});

// new behaviour: a probe never creates the lock file it reads, even when the file vanishes after admission
test('cap lock: a probe whose lock file vanishes before it opens creates no file', async (t) => {
  const state = lockFolder(t);
  const gone = join(state, 'gone.lock');
  writeFileSync(gone, '', { mode: 0o600 });
  const open = (file, options) => {
    unlinkSync(file);
    return openDefault(file, options);
  };
  await assert.rejects(lockLeadFile(gone, { shared: true, waitMs: 0, create: false, open }));
  assert.equal(existsSync(gone), false, 'the probe creates no file');
});

// new behaviour: a lock file whose properties stop qualifying while it is locked is refused
test('cap lock: a lock file that stops qualifying while it is being locked is refused', { skip: process.platform === 'win32' && 'Windows has no file modes' }, async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const open = (file, options) => {
    chmodSync(file, 0o644);
    return openDefault(file, options);
  };
  const { message } = await refusal(underLock(path, { open }));
  assert.match(message, /changed while it was being locked: .*mode 0644/);
});

// new behaviour: a SQLite database swapped in at the lock path keeps its journal mode, because the lock refuses a file with pages before its pragma
test('cap lock: a SQLite database swapped in before it is locked keeps its journal mode', async (t) => {
  const state = lockFolder(t);
  const path = join(state, 'cap.lock');
  const staged = join(state, 'staged.db');
  const database = new DatabaseSync(staged);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('row')");
  database.close();
  const journalMode = (file) => [...readFileSync(file).subarray(18, 20)];
  assert.deepEqual(journalMode(staged), [2, 2]);
  const open = (file, options) => {
    renameSync(staged, file);
    return openDefault(file, options);
  };
  const { message } = await refusal(underLock(path, { open }));
  assert.deepEqual(journalMode(path), [2, 2]);
  const swapped = new DatabaseSync(path);
  try {
    assert.equal(swapped.prepare('SELECT value FROM kept').get()?.value, 'row');
  } finally {
    swapped.close();
  }
  assert.equal(message, `${path} is not a lock file: is not empty`);
});

test('ANTI-REGRESSION: coordinator open closes nothing it cannot prove stopped', async () => {
  const running = await opened({ listing: coordinatorListing(listed('t9')), records: { t9: liveRecord() } });
  assert.equal(running.code, 5);
  assert.deepEqual(closes(running.app), []);
  assert.deepEqual(newTabs(running.app), []);

  const unreadable = await opened({ listing: coordinatorListing(listed('t9')) });
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.said, /hc get t9/);
  assert.deepEqual(closes(unreadable.app), []);
  assert.deepEqual(newTabs(unreadable.app), []);

  const unknown = await opened({ listing: coordinatorListing(listed('t9')), records: { t9: liveRecord({ state: 'unknown' }) } });
  assert.equal(unknown.code, 1);
  assert.deepEqual(closes(unknown.app), []);
  assert.deepEqual(newTabs(unknown.app), []);
});

test('coordinator open refuses a space holding more than one Coordinator tab', async () => {
  const listing = { spaces: [{ ...space('spproject1', 'fabraik', [['tb1', '1']], null, ROOT),
    tabs: [{ id: 'tb1', name: '1', terminals: [] }, { id: 'tbc1', name: 'Coordinator', terminals: listed('t8') }, { id: 'tbc2', name: 'Coordinator', terminals: listed('t9') }] }] };
  const refused = await opened({ listing, records: { t8: liveRecord({ state: 'finished' }), t9: liveRecord() } });
  assert.equal(refused.code, 1);
  assert.deepEqual(closes(refused.app), []);
  assert.deepEqual(newTabs(refused.app), []);
  assert.match(refused.said, /tbc1/);
  assert.match(refused.said, /tbc2/);
});

// A project folder and a bin folder of fakes whose every call is appended to one log.
// `hc` is the fake hc's answer per subcommand (its stdout), empty for any it does not name, or a function of the project's
// local main commit that returns them. An answer that is a list is given in order, one per call, its last once used up;
// a counter file in the bin folder holds each list's place. `events` prints its answer and exits, as a stream that ends. The project folder holds only a repository of one empty commit (see committedRoot):
// the fake git passes the workflow version's selection, snapshot and drift reads through to the real git there. It also answers the
// job branches and worktrees `repository` names, as gitFor does. The fake gh answers the tracker reads one page per request
// as the tracker gate makes them: the board listing of `tracker.nodes`, empty open and recently closed issue walks, each board card's
// comments from `tracker.comments` (none where it names none), the open draft pull requests `tracker.drafts`, and a
// `rate_limit` probe with an allowance left; any other call fails. When enabled, the fake Codex records the app-server
// working directory and the incoming messages in the same log as Herdr.
/** @param {import('node:test').TestContext} t @param {{ listing: any, hc?: Record<string, string | string[]> | ((main: string) => Record<string, string | string[]>), text?: string, login?: string | null, codexHooks?: (root: string) => unknown, repository?: { branches: number[], worktrees: number[] }, tracker?: { nodes: any[], comments: Record<number, string[]>, drafts: { number: number, headRefName: string }[] } }} options */
function wireFixture(t, { listing, hc = {}, text = settingsText({ coordinator: { model: 'sonnet', effort: 'high' } }),
  login = 'octocat\n', codexHooks, repository = { branches: [], worktrees: [] },
  tracker = { nodes: [], comments: {}, drafts: [] } }) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-wire-'))), 'Wire Project');
  const main = pinGit(committedRoot(root), 'rev-parse', 'refs/heads/main');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const hcReplies = typeof hc === 'function' ? hc(main) : hc;
  const bin = join(dirname(root), 'bin');
  mkdirSync(bin);
  const log = join(dirname(root), 'calls.jsonl');
  t.after(() => {
    writable(dirname(root));
    rmSync(dirname(root), { recursive: true, force: true });
  });
  const fake = (name, answer) => {
    const source = [`#!${process.execPath}`, `const args = process.argv.slice(2);`,
      `const record = (entry) => require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');`,
      `record({ tool: ${JSON.stringify(name)}, args${name === 'codex' ? ', cwd: process.cwd()' : ''} });`, answer].join('\n');
    writeFileSync(join(bin, name), `${source}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const jobs = gitFor(text, [], { root, ...repository });
  const branchRead = ['for-each-ref', '--format=%(refname)', 'refs/heads/job/'];
  const worktreeRead = ['worktree', 'list', '--porcelain'];
  const worktreeReadNul = [...worktreeRead, '-z'];
  fake('git', `const line = args.join(' ');
const say = (text) => process.stdout.write(text);
if (line.includes('--end-of-options') || ['merge-base', 'cat-file'].includes(args[0]) || line === 'rev-parse --show-object-format') {
  const done = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { input: require('node:fs').readFileSync(0), maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(done.stdout);
  process.stderr.write(done.stderr);
  process.exit(done.status ?? 1);
}
else if (line.includes('--local-env-vars')) say('GIT_DIR\\n');
else if (line.includes('--git-common-dir')) say(${JSON.stringify(`${join(root, '.git')}\n`)});
else if (line.includes('--show-toplevel')) say(${JSON.stringify(`${root}\n`)});
else if (${Boolean(codexHooks)} && line === ${JSON.stringify(`-C ${root} config --type=bool core.fileMode`)}) say('true\\n');
else if (line.startsWith('fetch')) say('');
else if (line.startsWith('rev-parse --verify')) say(${JSON.stringify(`${OID}\n`)});
else if (args[0] === 'ls-tree') say('100644\\n');
else if (args[0] === 'show') say(${JSON.stringify(text)});
else if (line === ${JSON.stringify(branchRead.join(' '))}) say(${JSON.stringify(jobs(branchRead))});
else if (line === ${JSON.stringify(worktreeRead.join(' '))}) say(${JSON.stringify(jobs(worktreeRead))});
else if (line === ${JSON.stringify(worktreeReadNul.join(' '))}) say(${JSON.stringify(jobs(worktreeReadNul))});
else { process.stderr.write('fake git: unexpected ' + line); process.exit(1); }`);
  fake('herdr-app', `process.stdout.write(args[0] === 'ls' ? ${JSON.stringify(JSON.stringify(listing(basename(root), root)))} : '{}');`);
  fake('hc', `const replies = ${JSON.stringify(hcReplies)};
const key = [args.join(':'), args[0]].find((name) => replies[name] !== undefined);
let reply = key === undefined ? '' : replies[key];
if (Array.isArray(reply)) {
  const fs = require('node:fs');
  const counter = require('node:path').join(${JSON.stringify(bin)}, 'hc-' + encodeURIComponent(key) + '.count');
  const used = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(used + 1));
  reply = reply[Math.min(used, reply.length - 1)];
}
process.stdout.write(reply);`);
  if (codexHooks) fake('codex', `const hooks = ${JSON.stringify(codexHooks(root))};
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  record({ tool: 'codex-rpc', message });
  const reply = (result) => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  if (message.method === 'initialize') {
    reply({ userAgent: 'codex/0.171.0', codexHome: process.env.HOME, platformFamily: 'unix', platformOs: 'linux' });
  } else if (message.method === 'hooks/list') {
    if (hooks === null) process.exit(1);
    reply(hooks);
  } else if (message.method !== 'initialized') {
    process.exit(1);
  }
});`);
  const details = Object.fromEntries(tracker.nodes.map(({ content }) => [content.number, cardDetail(content.number, tracker.comments[content.number] ?? [])]));
  const replies = { board: leanBoardPage(tracker.nodes), issues: issuesPage([]), details, drafts: tracker.drafts };
  fake('gh', `const replies = ${JSON.stringify(replies)};
const query = args.find((arg) => arg.startsWith('query=')) ?? '';
const say = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === 'api' && args[1] === 'rate_limit') say({ resources: { graphql: { limit: 5000, remaining: 4999, reset: 1 }, core: { limit: 5000, remaining: 4999, reset: 1 } } });
else if (args.join(' ') === 'api user --jq .login') {
  const login = ${JSON.stringify(login)};
  if (login === null) { process.stderr.write('fake gh: login unavailable'); process.exit(1); }
  process.stdout.write(login);
}
else if (args[0] === 'pr' && args[1] === 'list' && args.includes('--draft')) say(replies.drafts);
else if (query.includes('fragment CardDetails')) say({ data: { repository: Object.fromEntries([...query.matchAll(/\\bi(\\d+): issue\\(number:/g)].map(([, n]) => ['i' + n, replies.details[n] ?? null])) } });
else if (/\\bissues\\(/.test(query)) say(replies.issues);
else if (/\\bprojectV2\\(number:/.test(query) && /\\bitems\\(first:/.test(query) && !args.some((arg) => arg.startsWith('endCursor='))) say(replies.board);
else { process.stderr.write('fake gh: unexpected ' + args.join(' ')); process.exit(1); }`);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const run = (args, env = {}, cwd = root) => spawnSync(process.execPath, [COMMAND, ...args], { cwd, encoding: 'utf8', timeout: 20_000,
    // The temporary folder variables pass through so the command writes inside the run's own folder.
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dirname(root), TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
      BOARD_TOOLKIT_GH: JSON.stringify([join(bin, 'gh')]), ...env } });
  return { root, main, calls, run };
}

const DELIVERY_OFF = 'Herdr delivery is unavailable: the Herdr add-on is off.';
const DELIVERY_MISSING = 'Herdr delivery is unavailable: install the Herdr add-on files, then retry.';
const DELIVERY_REPO = 'example/one';
const DELIVERY_ID = 'R_kgDO/fabraik-947';
const DELIVERY_ORIGIN = 'https://github.com/example/one.git';
const DELIVERY_LOCK_LEAF = '683c0e8bf0d96e4a52ac6df91d99f17cc0e0cc5a233dc106aad1d1685513f8b0';
const DELIVERY_LINUX_ONLY = process.platform === 'linux' ? undefined : 'requires Linux /proc process identity';

// The shared launcher is exercised from its own temporary installation, with no attached Herdr terminal.
function deliveryWire(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-wire-')));
  const root = join(scratch, 'repo');
  const callsFile = join(scratch, 'calls.jsonl');
  const settings = join(root, '.agents', 'factory-settings.json');
  const optionalModule = join(root, 'scripts', 'lib', 'coordinator.mjs');
  const cli = join(root, 'scripts', 'merge-watch.mjs');
  const home = join(scratch, 'home');
  const state = join(scratch, 'state');
  const temporary = join(scratch, 'tmp');
  for (const path of [dirname(settings), home, state, temporary]) mkdirSync(path, { recursive: true });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fake = installFakeGh('delivery-gh-', `
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ tool: 'gh', args }) + '\\n');
const replies = [
  [['repo', 'view', '--json', 'id', '--', '${DELIVERY_ORIGIN}'], { id: '${DELIVERY_ID}' }],
  [['pr', 'list', '--repo', '${DELIVERY_ORIGIN}', '--head', 'job/17', '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository'],
    [{ number: 17, state: 'OPEN', headRefName: 'job/17', headRepository: { id: '${DELIVERY_ID}' }, isCrossRepository: false }]],
  [['pr', 'view', '17', '--json', 'baseRefName'], { baseRefName: 'main' }],
  [['api', 'repos/{owner}/{repo}/branches/main'], { protected: false }],
  [['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/rules/branches/main'], [[]]],
  [['pr', 'view', '17', '--json', 'state,mergeStateStatus,headRefOid,autoMergeRequest'],
    { state: 'MERGED', mergeStateStatus: 'CLEAN', headRefOid: '${OID}', autoMergeRequest: null }],
];
const reply = replies.find(([request]) => JSON.stringify(request) === JSON.stringify(args));
if (!reply) throw new Error('unexpected provider call: ' + args.join(' '));
process.stdout.write(JSON.stringify(reply[1]));
`);
  t.after(fake.cleanup);
  // Trap native calls before the launcher imports its subprocess bindings, including on Windows.
  const preload = 'data:text/javascript,' + encodeURIComponent(`
import child from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = child[key];
  child[key] = (file, ...args) => {
    if (/(?:^|[\\\\/])(?:hc|herdr-app)(?:\\.exe)?$/i.test(file)) {
      appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ tool: file }) + '\\n');
      throw new Error('fixture blocks Herdr calls');
    }
    return original(file, ...args);
  };
}
syncBuiltinESMExports();
`);
  const env = fake.env({
    HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    GIT_CONFIG_GLOBAL: join(scratch, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1',
  }, Object.keys(process.env).filter((name) =>
    (name.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(name))
    || name === 'NODE_OPTIONS'));
  /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
  const options = { cwd: root, env, encoding: 'utf8', timeout: 20_000 };
  const git = (args) => {
    const result = spawnSync('git', args, options);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  };
  cpSync(SCRIPTS, join(root, 'scripts'), { recursive: true, filter: (source) => {
    const name = relative(dirname(SCRIPTS), source).split(sep).join('/');
    return !isHerdrPath(name) && !name.endsWith('.test.mjs');
  } });
  const configure = (enabled) => {
    writeFileSync(settings, settingsText({ herdr: enabled }));
    git(['add', '--', '.agents/factory-settings.json']);
  };
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', DELIVERY_ORIGIN]);
  configure(false);
  git(['add', '--', 'scripts']);
  const calls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  const run = (args) => spawnSync(process.execPath, ['--import', preload, cli, ...args], options);
  const runOrdinary = (args) => spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e',
    `import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
process.exitCode = await main(${JSON.stringify(args)}, {
  openRoute: async () => ({
    nextWake: () => { throw new Error('the fixture PR is already merged'); },
    close: async () => {},
  }),
});`], options);
  const assertNoEffects = () => {
    assert.deepEqual(calls(), []);
    for (const path of [home, state, temporary]) assert.deepEqual(readdirSync(path), []);
  };
  return { configure, optionalModule, calls, run, runOrdinary, assertNoEffects };
}

function assertDeliveryOff(wire) {
  const run = wire.run(['--hold-delivery']);
  wire.assertNoEffects();
  assertDisabledDelivery(run);
}

function assertDisabledDelivery(run) {
  assert.equal(run.status, 3, run.error?.message ?? run.stdout + run.stderr);
  assert.equal((run.stdout + run.stderr).trimEnd(), DELIVERY_OFF);
}

test('Herdr delivery dispatch is optional and leaves the ordinary watch available', (t) => {
  const wire = deliveryWire(t);
  const disabled = wire.run(['--hold-delivery']);
  wire.assertNoEffects();
  wire.configure(true);
  assert.equal(existsSync(wire.optionalModule), false);
  const missing = wire.run(['--hold-delivery']);
  wire.assertNoEffects();

  wire.configure(false);
  writeFileSync(wire.optionalModule, 'throw new Error("ordinary watches may not import the optional coordinator");\n');
  for (const [args, expected] of [[['17'], 'merged'], [['--draft', 'job/17'], '17']]) {
    const result = wire.runOrdinary(args);
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    assert.equal(result.stdout.trimEnd(), expected);
  }
  assert.equal(wire.calls().length, 6);
  assert.ok(wire.calls().every(({ tool }) => tool === 'gh'));
  assertDisabledDelivery(disabled);
  assert.equal(missing.status, 1, missing.error?.message ?? missing.stdout + missing.stderr);
  assert.equal((missing.stdout + missing.stderr).trimEnd(), DELIVERY_MISSING);
});

// A settings file the delivery form refuses (`content` null means a directory at its path) exits 1 with one logged reason
// and runs no gh, git or hc call.
async function refusedSettings(t, label, content, reason) {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-settings-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.agents'));
  if (content === null) mkdirSync(join(cwd, '.agents', 'factory-settings.json'));
  else writeFileSync(join(cwd, '.agents', 'factory-settings.json'), content);
  const lines = [];
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return { code: 0, stdout: '', stderr: '' }; };
  const result = await mergeWatch(['--hold-delivery'], {
    cwd, output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    ghExec: record('gh'), gitExec: record('git'), hc: record('hc'),
  });
  assert.equal(result, 1, label);
  assert.equal(lines.length, 1, label);
  assert.match(lines[0], reason, label);
  assert.deepEqual(calls, [], label);
}

// existing behaviour: the settings check refuses these files at delivery today.
test('ANTI-REGRESSION: Herdr delivery refuses a malformed or forbidden settings file before any delivery step', async (t) => {
  /** @type {[string, string | null, RegExp][]} */
  const cases = [
    ['not JSON', 'not json', /is not valid JSON/],
    ['not an object', '[]', /file: must hold one JSON object/],
    ['version 2', '{"version":2,"herdr":true}', /version: is unsupported/],
    ['herdr "yes"', '{"version":1,"herdr":"yes"}', /herdr: must be true or false/],
    ['docsSite "hosted"', '{"version":1,"herdr":true,"docsSite":"hosted"}', /docsSite: must be off, local or online/],
    ['preApprovedRun', '{"version":1,"herdr":true,"preApprovedRun":true}', /preApprovedRun is retired/],
    ['productManager', '{"version":1,"herdr":true,"productManager":true}', /productManager is retired/],
    ['a directory', null, /is not a regular file/],
  ];
  for (const [label, content, reason] of cases) await refusedSettings(t, label, content, reason);
});

const DELIVERY_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,autoMergeRequest,mergedAt,mergeCommit';
const PREVIOUS_WAIT = 'Waiting for GitHub to settle previous pull request example/one#17.';
const WATCH_WAIT = 'Waiting for the previous merge watch to finish cleaning up.';
const WATCH_RETAINED = 'Delivery stopped: previous pull request example/one#17 still needs its merge-watch cleanup. In the original job run `node scripts/merge-watch.mjs 17` once its old watch has ended.';
const PR_UNVERIFIED = 'Delivery stopped: GitHub could not confirm the exact previous pull request example/one#17 on its recorded head. Check that pull request in its original job before retrying delivery.';
const EXISTING_WATCH = 'Delivery stopped: an existing merge watch for example/one still needs cleanup. Check its owning job before retrying.';
const CONTENTION_WAIT = 'Waiting for another delivery in this repository';
const WATCH_RECORD = 'f2d370c2dba7ae00.json';
const READY = ['--delivery-ready', '1'];
const ARM_PREVIOUS = ['--delivery-pr', '17', OID, '--arm'];
const HOLD = ['--hold-delivery'];

const OPEN_PR = {
  number: 17, url: 'https://github.com/example/one/pull/17', state: 'OPEN', isDraft: false, isCrossRepository: false,
  headRefName: 'job/17', headRefOid: OID, baseRefName: 'main', autoMergeRequest: null, mergedAt: null, mergeCommit: null,
};
const QUEUED_PR = {
  ...OPEN_PR, autoMergeRequest: { enabledAt: RUN_AT, enabledBy: { login: 'octocat' }, mergeMethod: 'SQUASH' },
};
const MERGED_PR = { ...OPEN_PR, state: 'MERGED', mergedAt: '2026-11-19T12:03:00Z', mergeCommit: { oid: 'c'.repeat(40) } };

function deliveryWorld(t, { previous = OPEN_PR } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-state-')));
  t.after(() => rmSync(scratch, { force: true, recursive: true }));
  const accountHome = join(scratch, 'account');
  const lockRoot = join(scratch, 'lanes');
  const durableDir = join(accountHome, '.local', 'state', 'fabraik-merge-watch');
  const durable = join(durableDir, `delivery-${DELIVERY_LOCK_LEAF}.json`);
  const watchStateDir = join(accountHome, 'xdg', 'fabraik-merge-watch');
  const watchFile = join(watchStateDir, WATCH_RECORD);
  const notifications = new EventEmitter();
  const originalRepo = join(scratch, 'one');
  const otherRepo = join(scratch, 'two');
  for (const folder of [lockRoot, accountHome, watchStateDir, originalRepo, otherRepo]) mkdirSync(folder, { mode: 0o700, recursive: true });
  let now = Date.parse(RUN_AT);
  let provider = previous;
  let differentPull = { ...OPEN_PR, number: 18, url: 'https://github.com/example/one/pull/18' };
  /** @type {Set<{ address: string, until: number, resolve: () => void }>} */
  const sleeps = new Set();
  const sleepCalls = [];
  const tick = (ms) => {
    now += ms;
    for (const sleeper of sleeps) if (sleeper.until <= now) sleeper.resolve();
  };
  const observed = async (predicate) => {
    const signal = AbortSignal.timeout(5000);
    while (!predicate()) await once(notifications, 'receipt', { signal });
  };
  /** @type {Map<string, any>} */
  const terminals = new Map();
  /** @type {{ address: string, phase: string, reason?: string, repo?: string, pr?: number }[]} */
  const labels = [];
  /** @type {{ at: number, address: string, args: string[] }[]} */
  const reads = [];
  const emit = () => notifications.emit('receipt');
  /** @type {{ pid: number, ppid: number, started: string, args: string }[]} */
  const watchProcesses = [];
  const hc = async (args) => {
    const [command, address, label] = args;
    // Keep the wire-format expectation independent of the production validator.
    assert.match(address, /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/, args.join(' '));
    const terminal = terminals.get(address);
    if (command === 'get') {
      assert.deepEqual(args, ['get', address, '--json']);
      return terminal ? { code: 0, stdout: JSON.stringify(terminal), stderr: '' } : { code: 1, stdout: '', stderr: 'no such terminal' };
    }
    assert.equal(command, 'label');
    assert.ok(terminal, 'a disappeared native terminal can receive no label');
    assert.ok(label?.startsWith('fabraik.delivery='), args.join(' '));
    const value = label.slice('fabraik.delivery='.length);
    if (value) {
      const state = JSON.parse(value);
      terminal.labels['fabraik.delivery'] = value;
      labels.push({ address, ...state });
    } else {
      delete terminal.labels['fabraik.delivery'];
    }
    emit();
    return { code: 0, stdout: '', stderr: '' };
  };

  function job(card, { address = `t${card}`, parent = 't1', codex = false, repo = DELIVERY_REPO,
    pid = process.pid, terminalPid = process.pid, watchDir = watchStateDir } = {}) {
    const root = repo === DELIVERY_REPO ? originalRepo : otherRepo;
    const id = repo === DELIVERY_REPO ? DELIVERY_ID : 'R_example_two';
    const origin = repo === DELIVERY_REPO ? DELIVERY_ORIGIN : 'https://github.com/example/two.git';
    const worktree = join(root, 'jobs', String(card));
    mkdirSync(join(worktree, '.agents'), { recursive: true });
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(worktree, '.agents', 'factory-settings.json'), settingsText());
    writeFileSync(join(root, '.agents', 'factory-settings.json'), settingsText());
    const terminal = {
      address, state: 'live', cwd: root, created_ms: now + card, parent, pid: terminalPid,
      ...(codex ? {} : { foreground: { name: 'claude', cwd: worktree } }),
      status: { state: 'idle' }, labels: {
        'fabraik.role': 'job', 'fabraik.card': String(card), 'fabraik.runstart': RUN_AT,
        ...(codex ? { 'fabraik.runtime': 'codex' } : { 'fabraik.session': SESSION }),
      },
    };
    terminals.set(address, terminal);
    const gitCalls = [];
    const worktrees = gitFor(settingsText(), gitCalls, { root, registered: [{ path: worktree, branch: `refs/heads/job/${card}` }] });
    const gitExec = (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args.at(-1) === 'origin') return origin + '\n';
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return worktree + '\n';
      return worktrees(args);
    };
    const ghExec = (args) => {
      if (args[0] === 'repo') {
        assert.deepEqual(args, ['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', origin]);
        return JSON.stringify({ id, nameWithOwner: repo, defaultBranchRef: { name: 'main' } });
      }
      const number = Number(args[4]);
      assert.deepEqual(args, ['pr', 'view', '--repo', `github.com/${repo}`, String(number), '--json', DELIVERY_FIELDS]);
      assert.ok(number === 17 || number === 18);
      reads.push({ at: now, address, args });
      emit();
      if (number === 18) return JSON.stringify(differentPull);
      return typeof provider === 'string' ? provider : JSON.stringify(provider);
    };
    let stop = Promise.withResolvers();
    const output = [];
    const dependencies = {
      cwd: worktree, root, lockRoot, accountHome, watchStateDir: watchDir, pid,
      env: { HC_TERMINAL_ID: address, ...(codex ? { CODEX_THREAD_ID: SESSION } : {}) },
      ghExec, gitExec, hc,
      readLiveCodexBinding: async ({ root: boundRoot }) => {
        assert.equal(boundRoot, root);
        assert.equal(codex, true);
        return { version: 1, root, repositoryId: id, card, runStart: RUN_AT, terminalAddress: address,
          terminalCreatedMs: terminal.created_ms, parentAddress: parent, threadId: SESSION };
      },
      readProcessTable: () => [...watchProcesses],
      now: () => now,
      sleep: (ms, _value, options) => new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) { reject(signal.reason); return; }
        const done = () => {
          sleeps.delete(sleeper);
          signal?.removeEventListener('abort', abort);
          resolve(undefined);
        };
        const abort = () => {
          sleeps.delete(sleeper);
          reject(signal.reason);
        };
        const sleeper = { address, until: now + ms, resolve: done };
        signal?.addEventListener('abort', abort, { once: true });
        sleeps.add(sleeper);
        sleepCalls.push(address);
        emit();
      }),
      output: { log: (line) => output.push(line), error: (line) => output.push(line) },
      untilSignal: () => stop.promise,
    };
    const run = (args, overrides = {}) => mergeWatch(args, { ...dependencies, ...overrides });
    const go = (args, overrides = {}) => {
      const operation = { done: false, result: run(args, overrides) };
      void operation.result.then(() => { operation.done = true; emit(); }, () => { operation.done = true; emit(); });
      return operation;
    };
    const history = () => labels.filter((label) => label.address === address);
    const waitLabel = (reason) => observed(() => history().some((label) => label.reason === reason));
    return { address, terminal, root, worktree, ghExec, run, go, history, waitLabel, output, stop: () => stop.resolve('SIGTERM'), restart: () => { stop = Promise.withResolvers(); } };
  }
  return {
    job, scratch, repository: originalRepo, lockRoot, durable, durableDir, watchStateDir, watchFile, watchProcesses, terminals, reads, tick, observed,
    sleeping: (job, through = 0) => [...sleeps].some((sleeper) => sleeper.address === job.address && sleeper.until >= now + through),
    sleepCount: (job) => sleepCalls.filter((address) => address === job.address).length,
    setProvider: (reply) => { provider = reply; },
    setNextBranch: (branch) => { differentPull = { ...differentPull, headRefName: branch }; },
  };
}

async function heldDelivery(world, job, hold = job.go(HOLD)) {
  await world.observed(() => hold.done || world.sleeping(job));
  assert.equal(hold.done, false, job.output.join('\n'));
  assert.equal(await job.run(READY), 0, job.output.join('\n'));
  return hold;
}

async function stopDelivery(job, hold, expected = 0) {
  job.stop();
  assert.equal(await hold.result, expected);
}

test('Herdr delivery queues jobs on the same repository and isolates other repositories', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  assertDeliveryOff(deliveryWire(t));
  const world = deliveryWorld(t);
  const a = world.job(17);
  const b = world.job(18);
  const c = world.job(19, { repo: 'example/two' });
  /** @type {[any, { result: Promise<number> }][]} */
  const holds = [];
  try {
    const first = a.go(HOLD);
    holds.push([a, first]);
    await heldDelivery(world, a, first);
    assert.deepEqual(readdirSync(world.lockRoot), [DELIVERY_LOCK_LEAF]);
    assert.equal(existsSync(join(world.lockRoot, 'R_kgDO')), false);
    const leaf = join(world.lockRoot, DELIVERY_LOCK_LEAF);
    const record = lstatSync(join(leaf, 'ready.json'), { bigint: true });
    const results = [];
    for (const path of [join(leaf, 'delivery.lock'), join(leaf, `ready-${record.dev}-${record.ino}.lock`)]) {
      const probe = await lockLeadFile(path, { shared: true, waitMs: 0, create: false });
      probe?.release();
      results.push(probe);
    }
    assert.deepEqual(results, [undefined, undefined], 'the first job holds both delivery locks');
    const stableLock = join(leaf, 'delivery.lock');
    const inode = lstatSync(stableLock).ino;
    // The record lock's first attempt reports one used-up wait; the holder retries instead of stopping.
    const recordCalls = [];
    const lockRecord = (path, options) => {
      recordCalls.push(path);
      return recordCalls.length === 1 ? undefined : lockLeadFile(path, options);
    };
    const competing = b.go(HOLD, { lockRecord });
    holds.push([b, competing]);
    await b.waitLabel(CONTENTION_WAIT);
    assert.equal(b.history().at(-1)?.phase, 'waiting');
    assert.equal(competing.done, false);
    const independent = c.go(HOLD);
    holds.push([c, independent]);
    await heldDelivery(world, c, independent);
    assert.equal(first.done, false);
    assert.equal(competing.done, false);
    assert.equal(await a.run(READY), 0);
    await stopDelivery(a, first);
    await heldDelivery(world, b, competing);
    assert.doesNotMatch(b.output.join('\n'), /could not be locked/);
    assert.equal(lstatSync(stableLock).ino, inode);
    assert.equal(externalLockProbe(stableLock), 'busy');
    await stopDelivery(b, competing);
    await stopDelivery(c, independent);

    // A job whose terminal vanishes while its record lock is busy stops on the liveness check, not after another wait.
    const gone = world.job(20);
    const vanishCalls = [];
    const vanish = (path, options) => {
      vanishCalls.push(path);
      if (vanishCalls.length > 1) return lockLeadFile(path, options);
      world.terminals.delete(gone.address);
      return undefined;
    };
    const vanished = gone.go(HOLD, { lockRecord: vanish });
    holds.push([gone, vanished]);
    await world.observed(() => vanished.done || world.sleeping(gone));
    assert.deepEqual([recordCalls.length, vanishCalls.length], [2, 1]);
    assert.equal(recordCalls[1], recordCalls[0]);
    assert.match(recordCalls[0], /ready-\d+-\d+\.lock$/);
    assert.equal(vanished.done, true);
    assert.equal(await vanished.result, 1);
    assert.match(gone.output.join('\n'), /could not verify the delivery job: no such terminal/);
    const free = await lockLeadFile(stableLock, { waitMs: 0 });
    assert.ok(free, 'the lane is free');
    free.release();

    for (const loss of ['holder process', 'terminal']) {
      const next = deliveryWorld(t);
      const runtime = await nodeProcessFixture(t, { root: next.scratch }, 'scripts/merge-watch.mjs', '--hold-delivery');
      const former = next.job(17, { pid: runtime.pid });
      const later = next.job(18);
      const holding = await heldDelivery(next, former);
      const contender = later.go(HOLD);
      await later.waitLabel(CONTENTION_WAIT);
      if (loss === 'holder process') {
        const exited = once(runtime.child, 'exit');
        runtime.child.kill('SIGTERM');
        await exited;
      } else {
        next.terminals.delete(former.address);
      }
      next.tick(5_000);
      assert.equal(await holding.result, 1);
      assert.match(former.output.join('\n'), /delivery stopped/i);
      if (loss === 'holder process') assert.equal(former.history().at(-1)?.phase, 'stopped');
      else assert.deepEqual(former.history().filter(({ phase }) => phase === 'stopped'), []);
      await heldDelivery(next, later, contender);
      await stopDelivery(later, contender);
    }
  } finally {
    for (const [job] of holds) job.stop();
    for (const [, hold] of holds) await hold.result;
  }
});

// new behaviour: a held delivery whose record lock file is replaced ends, and no later hold removes the replacement
test('ANTI-REGRESSION: a Herdr delivery holder stops when its record lock is replaced', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job17 = world.job(17);
  const job18 = world.job(18);
  const hold = job17.go(HOLD);
  let next;
  try {
    await heldDelivery(world, job17, hold);
    const lane = join(world.lockRoot, DELIVERY_LOCK_LEAF);
    const sidecars = readdirSync(lane).filter((name) => /^ready-.*\.lock$/.test(name));
    assert.equal(sidecars.length, 1, `the lane holds one record lock: ${readdirSync(lane).join(', ')}`);
    const sidecar = join(lane, sidecars[0]);
    const replacement = join(lane, 'replacement.lock');
    writeFileSync(replacement, 'recovery', { flag: 'wx', mode: 0o600 });
    const replacedInode = lstatSync(replacement).ino;
    renameSync(replacement, sidecar);

    const sleeps = world.sleepCount(job17);
    world.tick(5_000);
    await world.observed(() => hold.done || world.sleepCount(job17) > sleeps);
    assert.equal(hold.done, true, 'the holder stops instead of sleeping again');
    assert.equal(await hold.result, 1);
    assert.match(job17.output.join('\n'), /changed while locked/);

    // Whether this hold succeeds depends on whether its record reuses the inode; either way the replacement stays.
    const later = job18.go(HOLD);
    next = later;
    await world.observed(() => later.done || world.sleeping(job18));
    assert.equal(lstatSync(sidecar).ino, replacedInode);
    assert.equal(readFileSync(sidecar, 'utf8'), 'recovery');
  } finally {
    job17.stop();
    await hold.result;
    if (next) {
      job18.stop();
      await next.result;
    }
  }
});

// new behaviour: a delivery form passes over a top-level settings key its pinned copy does not know and still refuses a
// retired one beside it; the pull request's own required check judges the new key.
test('ANTI-REGRESSION: Herdr delivery holds and readies a pull request whose settings add a key its pinned copy does not know', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  await refusedSettings(t, 'preApprovedRun', '{"version":1,"herdr":true,"futureSetting":"on","preApprovedRun":true}', /preApprovedRun is retired/);

  const world = deliveryWorld(t);
  const job = world.job(17);
  writeFileSync(join(job.worktree, '.agents', 'factory-settings.json'), settingsText({ futureSetting: 'on' }));
  const hold = await heldDelivery(world, job);
  try {
    await armPrior(world, job);
    const watched = [];
    assert.equal(await job.run(['17', '--held-delivery'], { watch: async (_pr, { output, coordinated }) => {
      watched.push(coordinated.head);
      output.log(`required checks passed on ${coordinated.head}`);
      return 0;
    } }), 0, job.output.join('\n'));
    assert.deepEqual(watched, [OID]);
    world.setProvider(MERGED_PR);
    assert.equal(await job.run(['--delivery-pr', '17', OID]), 0, job.output.join('\n'));
    assert.equal(job.history().at(-1)?.phase, 'merged', 'the exact read of the merged pull request labels the row merged');
  } finally {
    await stopDelivery(job, hold);
  }
  assert.equal(job.output.some((line) => /holds a key besides/.test(line)), false, job.output.join('\n'));
});

// The Windows process chain a job's delivery runs in: the delivery under claude.exe, which the job terminal's foreground (pid 4100) started.
const windowsProcessTable = () => [
    { pid: process.pid, ppid: 4300, name: 'node.exe', started: '20261126210300.000000+000', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\r\\scripts\\merge-watch.mjs --hold-delivery' },
    { pid: 4300, ppid: 4100, name: 'claude.exe', started: '20261126210200.000000+000', args: 'C:\\Users\\a\\.local\\bin\\claude.exe' },
];

// new behaviour: on Windows the delivery lane, like the cap lock, accepts only a folder inside the user profile.
test('ANTI-REGRESSION: on Windows the delivery lane refuses a lane folder outside the user profile', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(world.scratch, 'outside-lanes');
  mkdirSync(lockRoot, { mode: 0o700 });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const table = windowsProcessTable();
  const overrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the delivery lane directory must be inside the user profile on Windows.']);
  assert.deepEqual(readdirSync(lockRoot), [], 'no reservation is left in the lane folder');
  assert.notEqual(job.history().at(-1)?.phase, 'waiting', 'the job holds no waiting reservation');
});

// new behaviour: on Windows the merge-watch state folder, like the lane, accepts only a folder inside the user profile.
// The state folder is checked before the lane, so a lane the profile rule would refuse never masks it. The existing lane
// test is the control: with the default state folder inside the profile, the refusal moves on to the lane.
test('ANTI-REGRESSION: on Windows the delivery state folder is refused outside the user profile', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const outsideState = join(world.scratch, 'outside-state');
  mkdirSync(outsideState, { mode: 0o700 });
  const job = world.job(17, { watchDir: outsideState });
  const accountHome = join(world.scratch, 'account');
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const table = windowsProcessTable();
  const overrides = { platform: 'win32', accountHome, lockRoot: world.lockRoot, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the merge-watch state directory must be inside the user profile on Windows.']);
});

// new behaviour: on Windows the job proof walks the delivery's parent processes to the first claude.exe, whose parent must
// be the job terminal's foreground. The foreground passes the Linux name and folder check, so only the chain can refuse it.
test('ANTI-REGRESSION: on Windows delivery refuses a process chain with no claude.exe under the job terminal', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const table = [
    { pid: process.pid, ppid: 4200, started: '20261126210300.000000+000', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\r\\scripts\\merge-watch.mjs --hold-delivery' },
    { pid: 4200, ppid: 4100, started: '20261126210200.000000+000', args: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile' },
    { pid: 4100, ppid: 4000, started: '20261126210100.000000+000', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\r\\scripts\\coordinator.mjs launch-job' },
    { pid: 4000, ppid: 1, started: '20261126210000.000000+000', args: 'powershell.exe -NoExit' },
  ];
  const overrides = { platform: 'win32', accountHome: join(world.scratch, 'account'), readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the native job does not match its registered physical worktree.']);
  assert.deepEqual(readdirSync(world.lockRoot), [], 'no reservation is left in the lane folder');
  assert.notEqual(job.history().at(-1)?.phase, 'waiting', 'the job holds no waiting reservation');
});

// new behaviour: on Windows the job proof walks past the delivery's intermediate parents to the nearest claude.exe.
test('on Windows delivery passes the job proof through an intermediate parent below claude.exe', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(accountHome, 'lanes');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const table = [
    { pid: process.pid, ppid: 4200, name: 'node.exe', started: '20261126210300.000000+000', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\r\\scripts\\merge-watch.mjs --hold-delivery' },
    { pid: 4200, ppid: 4300, name: 'powershell.exe', started: '20261126210250.000000+000', args: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile' },
    { pid: 4300, ppid: 4100, name: 'claude.exe', started: '20261126210200.000000+000', args: 'C:\\Users\\a\\.local\\bin\\claude.exe' },
  ];
  const overrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  // This host is not Windows, so the lane folder's own check is the next to refuse; reaching it shows the proof passed.
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the delivery lane path must be physical and absolute.']);
});

// Simulates on Linux a path the host normalize rewrites: git for Windows and Herdr print one the host form differs from.
const unnormalized = (path) => path.replace(/\/([^/]+)$/, '//$1');

// new behaviour: on Windows delivery compares the paths git and Herdr print after normalizing them, not in their own form.
test("on Windows delivery compares git's and Herdr's paths in their normalized form", async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(accountHome, 'lanes');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100, cwd: unnormalized(job.worktree) });
  job.terminal.cwd = unnormalized(job.root);
  const listed = gitFor(settingsText(), [], { root: unnormalized(job.root), registered: [{ path: unnormalized(job.worktree), branch: 'refs/heads/job/17' }] });
  const gitExec = (args) => {
    if (args[0] === 'remote' && args[1] === 'get-url' && args.at(-1) === 'origin') return DELIVERY_ORIGIN + '\n';
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return unnormalized(job.worktree) + '\n';
    return listed(args);
  };
  const table = windowsProcessTable();
  const overrides = { platform: 'win32', accountHome, lockRoot, gitExec, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  // This host is not Windows, so the lane folder's own check is the next to refuse; reaching it shows the worktree check passed.
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the delivery lane path must be physical and absolute.']);
});

// new behaviour: Windows paths are case-insensitive, so Herdr's launch folder in another letter case is the same folder.
test("on Windows delivery reads git's and Herdr's paths as the same folder whatever their letter case", async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(accountHome, 'lanes');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  job.terminal.cwd = job.root.toUpperCase();
  assert.notEqual(job.terminal.cwd, job.root);
  const table = windowsProcessTable();
  const overrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  // This host is not Windows, so the lane folder's own check is the next to refuse; reaching it shows the worktree check passed.
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the delivery lane path must be physical and absolute.']);

  // A launch from the worktree in another letter case is the same folder too.
  const worktreeJob = world.job(18);
  assert.ok(worktreeJob.terminal.foreground);
  Object.assign(worktreeJob.terminal.foreground, { pid: 4100 });
  worktreeJob.terminal.cwd = worktreeJob.worktree.toUpperCase();
  assert.notEqual(worktreeJob.terminal.cwd, worktreeJob.worktree);
  const worktreeOverrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: windowsProcessTable, readProcessStart: () => '638680000000000000' };
  assert.equal(await worktreeJob.run(HOLD, worktreeOverrides), 1, worktreeJob.output.join('\n'));
  assert.deepEqual(worktreeJob.output, ['Delivery stopped: the delivery lane path must be physical and absolute.']);
});

// new behaviour: the state folder exclusion compares case-insensitively on Windows. The registered worktree is real on disk,
// and only git's listing spells it in another letter case, so only the exclusion can refuse the state folder inside it.
test('ANTI-REGRESSION: on Windows the delivery state folder is refused inside a job worktree spelled with another letter case', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const accountHome = join(world.scratch, 'account');
  const other = join(accountHome, 'other-worktree');
  const insideOther = join(other, 'state');
  mkdirSync(insideOther, { recursive: true, mode: 0o700 });
  const job = world.job(17, { watchDir: insideOther });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const listed = gitFor(settingsText(), [], { root: job.root, registered: [
    { path: job.worktree, branch: 'refs/heads/job/17' }, { path: other.toUpperCase(), branch: 'refs/heads/job/18' }] });
  const gitExec = (args) => {
    if (args[0] === 'remote' && args[1] === 'get-url' && args.at(-1) === 'origin') return DELIVERY_ORIGIN + '\n';
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return job.worktree + '\n';
    return listed(args);
  };
  const table = windowsProcessTable();
  const overrides = { platform: 'win32', accountHome, lockRoot: world.lockRoot, gitExec, readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the merge-watch state path is within a writable job or temporary directory.']);
});

// new behaviour: on Windows delivery refuses a job whose Herdr launch folder is missing, as the exact comparison did.
test('ANTI-REGRESSION: on Windows delivery refuses a job whose Herdr launch folder is missing', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(accountHome, 'lanes');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  Object.assign(job.terminal, { cwd: null });
  const overrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: windowsProcessTable, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the native job does not match its registered physical worktree.']);
});

// new behaviour: on Windows delivery refuses a launch folder that names another folder, as the exact comparison did.
test('ANTI-REGRESSION: on Windows delivery refuses a job whose Herdr launch folder names another folder', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const accountHome = join(world.scratch, 'account');
  const lockRoot = join(accountHome, 'lanes');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const overrides = { platform: 'win32', accountHome, lockRoot, readProcessTable: windowsProcessTable, readProcessStart: () => '638680000000000000' };
  const job = world.job(17);
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  Object.assign(job.terminal, { cwd: world.job(37, { repo: 'example/two' }).root });
  assert.equal(await job.run(HOLD, overrides), 1, `another folder: ${job.output.join('\n')}`);
  assert.deepEqual(job.output, ['Delivery stopped: the native job does not match its registered physical worktree.'], 'another folder');
});

// new behaviour: the comparison resolves nothing, so a launch folder without a drive is never the current drive's folder.
test('ANTI-REGRESSION: on Windows a launch folder that names no drive is not the drive\'s folder', () => {
  for (const folder of ['\\r', 'C:r', null]) assert.equal(sameLaunchFolder(folder, 'C:\\r', 'win32'), false, String(folder));
  assert.equal(sameLaunchFolder('c:\\R', 'C:\\r', 'win32'), true);
  assert.equal(sameLaunchFolder('/r', '/r', 'linux'), true);
  assert.equal(sameLaunchFolder('/R', '/r', 'linux'), false);
});

// new behaviour: on Windows the nearest claude.exe must be a child of the job terminal's foreground, however it is named.
test('on Windows delivery refuses a nearest claude.exe that the job terminal did not start', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  assert.ok(job.terminal.foreground);
  Object.assign(job.terminal.foreground, { pid: 4100 });
  const table = [
    { pid: process.pid, ppid: 4300, name: 'node.exe', started: '20261126210300.000000+000', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\r\\scripts\\merge-watch.mjs --hold-delivery' },
    { pid: 4300, ppid: 4000, name: 'claude.exe', started: '20261126210200.000000+000', args: 'C:\\Users\\a\\.local\\bin\\claude.exe' },
    { pid: 4000, ppid: 4100, name: 'powershell.exe', started: '20261126210100.000000+000', args: 'powershell.exe -NoExit' },
  ];
  const overrides = { platform: 'win32', accountHome: join(world.scratch, 'account'), readProcessTable: () => table, readProcessStart: () => '638680000000000000' };
  assert.equal(await job.run(HOLD, overrides), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: the native job does not match its registered physical worktree.']);
});

// new behaviour: Windows has no /proc, so the delivery reads its own start time from Get-Process.
// The namespace is read through the reader's own shape, so the file type-checks where the export is missing.
/** @typedef {{ deliveryProcessStart: (pid: number, platform: string, exec: Function) => string }} StartReader */
test('on Windows the delivery process start time is read through PowerShell', () => {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args, pid: options.env.FABRAIK_DELIVERY_PID });
    return '638680000000000000\r\n';
  };
  const start = /** @type {StartReader} */ (/** @type {unknown} */ (coordinator)).deliveryProcessStart(4242, 'win32', exec);
  assert.equal(start, '638680000000000000');
  assert.deepEqual(calls, [{ file: 'powershell.exe', pid: '4242',
    args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $env:FABRAIK_DELIVERY_PID).StartTime.ToUniversalTime().Ticks'] }]);
});

// existing behaviour: coordinated delivery runs on Linux and Windows only.
test('delivery on macOS is still refused', { timeout: 30_000 }, async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const job = deliveryWorld(t).job(17);
  assert.equal(await job.run(HOLD, { platform: 'darwin' }), 1, job.output.join('\n'));
  assert.deepEqual(job.output, ['Delivery stopped: coordinated delivery requires Linux.']);
});

test('ANTI-REGRESSION: Herdr readiness waits for the new attempt after a stopped delivery', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  job.terminal.labels['fabraik.delivery'] = JSON.stringify({ phase: 'stopped', reason: 'The previous delivery ended.' });
  const readyPath = join(world.lockRoot, DELIVERY_LOCK_LEAF, 'ready.json');
  const readiness = job.go(READY);
  let hold;
  try {
    await world.observed(() => readiness.done || world.sleeping(job));
    const waitedBeforeHold = !readiness.done;
    hold = job.go(HOLD);
    const holder = hold;
    await world.observed(() => holder.done || existsSync(readyPath));
    assert.equal(holder.done, false, job.output.join('\n'));
    assert.ok(existsSync(readyPath));
    world.tick(1_000);
    assert.equal(await readiness.result, 0, job.output.join('\n'));
    assert.equal(waitedBeforeHold, true, 'readiness waits while the new reservation is pending');
  } finally {
    job.stop();
    await readiness.result;
    await hold?.result;
  }
});

test('ANTI-REGRESSION: Herdr clears a completed wait from the reservation row', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const b = world.job(18);
  const first = a.go(HOLD);
  let competing;
  try {
    await heldDelivery(world, a, first);
    competing = b.go(HOLD);
    await b.waitLabel(CONTENTION_WAIT);
    assert.equal(b.history().at(-1)?.phase, 'waiting');
    a.stop();
    await first.result;
    await heldDelivery(world, b, competing);
    assert.equal(b.terminal.labels['fabraik.delivery'], undefined);
  } finally {
    a.stop();
    b.stop();
    await first.result;
    await competing?.result;
  }
});

test('ANTI-REGRESSION: Herdr releases a ready reservation without reporting failure', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const open = { phase: 'open', repo: DELIVERY_REPO, pr: 17 };
  const releases = [];
  for (const observeOpen of [false, true]) {
    const world = deliveryWorld(t);
    const job = world.job(17);
    const hold = job.go(HOLD);
    let exit;
    try {
      await heldDelivery(world, job, hold);
      if (observeOpen) {
        assert.equal(await job.run(['--delivery-pr', '17', OID]), 0, job.output.join('\n'));
        assert.deepEqual(JSON.parse(job.terminal.labels['fabraik.delivery']), open);
      }
    } finally {
      job.stop();
      exit = await hold.result;
    }
    const value = job.terminal.labels['fabraik.delivery'];
    releases.push({ exit, label: value && JSON.parse(value) });
  }
  assert.deepEqual(releases, [{ exit: 0, label: undefined }, { exit: 0, label: open }]);
});

test('ANTI-REGRESSION: Herdr viewing a delivery keeps its live reservation', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17, { address: 't14g', parent: 't9y' });
  const hold = job.go(HOLD);
  const open = { phase: 'open', repo: DELIVERY_REPO, pr: 17 };
  try {
    await heldDelivery(world, job, hold);
    assert.equal(await job.run(['--delivery-pr', '17', OID]), 0, job.output.join('\n'));
    assert.deepEqual(JSON.parse(job.terminal.labels['fabraik.delivery']), open);

    const labels = { ...job.terminal.labels, 'herdr.seen': '0', 'herdr.pinned': '1' };
    job.terminal.labels = labels;
    const sleepCount = world.sleepCount(job);
    world.tick(5_000);
    await world.observed(() => hold.done || world.sleepCount(job) > sleepCount);

    assert.equal(hold.done, false, job.output.join('\n'));
    assert.equal(await job.run(READY), 0, job.output.join('\n'));
    assert.deepEqual(JSON.parse(job.terminal.labels['fabraik.delivery']), open);
  } finally {
    job.stop();
    await hold.result;
  }
});

test('ANTI-REGRESSION: Herdr readiness ignores malformed records for unrelated repositories', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const foreign = world.job(18, { repo: 'example/two' });
  const hold = job.go(HOLD);
  try {
    await heldDelivery(world, job, hold);
    const repositoryId = 'R_example_two';
    const foreignLane = join(world.lockRoot, createHash('sha256').update(repositoryId).digest('hex'));
    mkdirSync(foreignLane, { mode: 0o700 });
    const foreignReady = join(foreignLane, 'ready.json');
    writeFileSync(foreignReady, JSON.stringify({
      repositoryId, origin: 'https://github.com/example/two.git', worktree: foreign.worktree,
      terminal: { address: foreign.address },
    }), { flag: 'wx', mode: 0o600 });
    const invalidRecord = await job.run(READY);
    writeFileSync(foreignReady, '{');
    const invalidJson = await job.run(READY);
    assert.deepEqual({ invalidRecord, invalidJson }, { invalidRecord: 0, invalidJson: 0 }, job.output.join('\n'));
  } finally {
    job.stop();
    await hold.result;
  }
});

// existing behaviour: a held delivery whose readiness record was replaced ends instead of sleeping again
test('ANTI-REGRESSION: Herdr readiness requires the original locked record', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17, { codex: true });
  const holder = await heldDelivery(world, job);
  const lane = join(world.lockRoot, DELIVERY_LOCK_LEAF);
  const ready = join(lane, 'ready.json');
  const replacement = join(lane, 'replacement.json');
  const record = readFileSync(ready);
  try {
    const originalInode = lstatSync(ready).ino;
    writeFileSync(replacement, record, { flag: 'wx', mode: 0o600 });
    renameSync(replacement, ready);
    assert.notEqual(lstatSync(ready).ino, originalInode);
    assert.deepEqual(readFileSync(ready), record);
    assert.equal(externalLockProbe(join(lane, 'delivery.lock')), 'busy', 'the same-repository lock remains held');

    assert.equal(await job.run(READY), 1, 'the unlocked replacement cannot confirm readiness');
    assert.match(job.output.at(-1) ?? '', /reservation/i);

    const sleeps = world.sleepCount(job);
    world.tick(5_000);
    await world.observed(() => holder.done || world.sleepCount(job) > sleeps);
    assert.equal(holder.done, true, 'the holder stops instead of sleeping again');
    assert.equal(await holder.result, 1);
    assert.match(job.output.join('\n'), /ready\.json has more than one link/);
  } finally {
    job.stop();
    await holder.result;
  }
  assert.deepEqual(readFileSync(ready), record, 'the prior holder leaves the replacement alone');
});

// existing behaviour: a held delivery whose readiness record stops being a private file ends
test('ANTI-REGRESSION: a Herdr delivery holder stops when its readiness record stops being private', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17, { codex: true });
  const holder = await heldDelivery(world, job);
  try {
    chmodSync(join(world.lockRoot, DELIVERY_LOCK_LEAF, 'ready.json'), 0o644);
    const sleeps = world.sleepCount(job);
    world.tick(5_000);
    await world.observed(() => holder.done || world.sleepCount(job) > sleeps);
    assert.equal(holder.done, true, 'the holder stops instead of sleeping again');
    assert.equal(await holder.result, 1);
    assert.match(job.output.join('\n'), /not an owned private file/);
  } finally {
    job.stop();
    await holder.result;
  }
});

// existing behaviour: a Codex job's launch cwd must be the repository root
test('ANTI-REGRESSION: Herdr delivery refuses a Codex job not launched from the repository root', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const refused = world.job(17, { codex: true });
  refused.terminal.cwd = refused.worktree;
  assert.equal(await refused.run(['--delivery-pr', '17', OID]), 1, refused.output.join('\n'));
  assert.ok(refused.output.join('\n').split('\n').includes('Delivery stopped: the native job does not match its registered physical worktree.'), refused.output.join('\n'));
  const allowed = world.job(18, { codex: true });
  const hold = await heldDelivery(world, allowed);
  await stopDelivery(allowed, hold);
});

// The launch folder and exactly the labels a start sent its job's terminal, so a fixture default cannot hide a missing label.
function adoptLaunch(job, started) {
  const launch = started.runs().at(-1);
  job.terminal.cwd = launch[launch.indexOf('--cwd') + 1];
  job.terminal.labels = {};
  for (const [index, arg] of launch.entries()) {
    if (launch[index - 1] !== '--label') continue;
    const at = arg.indexOf('=');
    job.terminal.labels[arg.slice(0, at)] = arg.slice(at + 1);
  }
}

// new behaviour: a Claude job that start launches runs from the root, its Claude session in the worktree
test('a Claude job that start launches fresh passes the delivery worktree match', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(5);
  committedRoot(job.root);
  const started = jobFixture({ root: job.root, spaces: [space('spproject1', 'fabraik', [['tb1', '1']], null, job.root)], pages: READY_BOARD() });
  assert.equal(await started.start(5), 0, started.lines.join('\n'));
  adoptLaunch(job, started);
  await stopDelivery(job, await heldDelivery(world, job));
});

// new behaviour: a Claude job that start resumes runs from the root, its Claude session in the worktree
test('a Claude job that start resumes passes the delivery worktree match', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(5);
  const main = pinGit(committedRoot(job.root), 'rev-parse', 'refs/heads/main');
  const started = resumeFixture(job.root);
  addKept(started, 't11', 5, 'live');
  launchesReplacement(started, 't20', workflowLabels(main));
  assert.equal(await started.start(5, { cap: () => 1, ...resumeOptions('file') }), 0, started.lines.join('\n'));
  adoptLaunch(job, started);
  await stopDelivery(job, await heldDelivery(world, job));
});

// new behaviour: a Claude job is admitted only while its live Claude session is in its registered worktree
test('ANTI-REGRESSION: Herdr delivery admits a Claude job only while its live Claude session is in its registered worktree', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const refusal = 'Delivery stopped: the native job does not match its registered physical worktree.';
  const refuses = async (card, edit) => {
    const job = world.job(card);
    edit(job.terminal, job);
    assert.equal(await job.run(['--delivery-pr', String(card), OID]), 1, job.output.join('\n'));
    assert.ok(job.output.join('\n').split('\n').includes(refusal), job.output.join('\n'));
  };
  await refuses(31, (terminal, job) => { terminal.foreground.cwd = job.root; });
  await refuses(32, (terminal) => { terminal.foreground.cwd = world.job(36).worktree; });
  await refuses(33, (terminal) => { delete terminal.foreground; });
  await refuses(34, (terminal, job) => { terminal.foreground = { name: 'bash', cwd: job.worktree }; });
  await refuses(35, (terminal) => { terminal.cwd = world.job(37, { repo: 'example/two' }).root; });
  await refuses(38, (terminal, job) => { terminal.cwd = job.worktree; terminal.foreground = { name: 'bash', cwd: job.worktree }; });

  const root = world.job(17);
  await stopDelivery(root, await heldDelivery(world, root));
  const relaunched = world.job(18);
  relaunched.terminal.cwd = relaunched.worktree;
  await stopDelivery(relaunched, await heldDelivery(world, relaunched));
});

const WATCH_TIME = 'Thu Nov 19 12:00:00 2026';
const WATCH_SELF = { pid: process.pid, ppid: 1, started: WATCH_TIME, args: 'node scripts/merge-watch.mjs 17 --held-delivery' };
const WATCH_LAUNCH = { pid: 4200, ppid: process.pid, started: WATCH_TIME, args: 'gh webhook forward --repo example/one --events pull_request' };
const WATCH_FORWARD = { pid: 4300, ppid: 4200, started: WATCH_TIME, args: 'gh-webhook forward --repo example/one --events pull_request' };
const WATCH_IDENTITY = ({ pid, started }) => ({ pid, started });
const replacementRecord = () => ({
  watch: { pid: 4100, started: WATCH_TIME }, launcher: WATCH_IDENTITY(WATCH_LAUNCH), forwarder: WATCH_IDENTITY(WATCH_FORWARD), hookId: 77,
});

// The real event route handles its record, while the fixture controls the process table and hook replies.
function deliveryEventHost(world, { failDelete = false } = {}) {
  const calls = [];
  const ended = [];
  const claims = [];
  const hooks = new Set();
  const beforeClose = Promise.withResolvers();
  const started = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const routeOptions = {
    stateDir: world.watchStateDir,
    readProcessTable: () => [WATCH_SELF, ...world.watchProcesses],
    endProcess: async (row) => { ended.push(row.pid); },
    sleep: async (_ms, value) => value,
    ghExec: (args) => {
      calls.push(args);
      const line = args.join(' ');
      if (line === 'api repos/{owner}/{repo}') return '{"full_name":"example/one"}';
      if (line === 'api --paginate --slurp repos/example/one/hooks?per_page=100') {
        return JSON.stringify([[...hooks].map((id) => ({ id, name: 'cli', active: true, created_at: RUN_AT }))]);
      }
      if (line === 'api -X DELETE repos/example/one/hooks/77') {
        if (failDelete) throw new Error('fixture hook deletion refused');
        hooks.delete(77);
        return '';
      }
      const ordinary = new Map([
        ['pr view 17 --json baseRefName', '{"baseRefName":"main"}'],
        ['api repos/{owner}/{repo}/branches/main', '{"protected":false}'],
        ['api --paginate --slurp repos/{owner}/{repo}/rules/branches/main', '[[]]'],
        ['pr view 17 --json state,mergeStateStatus,headRefOid,autoMergeRequest', JSON.stringify({ state: 'MERGED', mergeStateStatus: 'CLEAN', headRefOid: OID, autoMergeRequest: null })],
      ]);
      assert.ok(ordinary.has(line), `unexpected watcher provider call: ${line}`);
      return ordinary.get(line);
    },
    spawnForwarder: async (args, { onStderr, onExit }) => {
      calls.push(args);
      world.watchProcesses.push(WATCH_LAUNCH, WATCH_FORWARD);
      hooks.add(77);
      onStderr('Forwarding Webhook events from GitHub');
      return {
        pid: WATCH_LAUNCH.pid,
        stop: async () => {
          world.watchProcesses.length = 0;
          onExit(null);
        },
      };
    },
  };
  const open = (coordinated) => {
    const options = { ...routeOptions, coordinated: coordinated && {
      ...coordinated,
      beforeForward: () => {
        claims.push(JSON.parse(readFileSync(world.watchFile, 'utf8')));
        return coordinated.beforeForward();
      },
    } };
    return openEventRoute(options);
  };
  const watch = async (pr, { coordinated, untilSignal, output }) => {
    assert.equal(pr, '17');
    try {
      const route = await open(coordinated);
      world.watchProcesses.push(WATCH_SELF);
      started.resolve(undefined);
      await untilSignal();
      closing.resolve(undefined);
      await beforeClose.promise;
      await route.close();
    } catch (error) {
      output.log(/** @type {Error} */ (error).message);
    }
    return 1;
  };
  const watchCommand = (pr, { output, coordinated, untilSignal }) => mergeWatch([pr], {
    output, untilSignal,
    ghExec: routeOptions.ghExec,
    openRoute: () => open(coordinated),
  });
  const standalone = (lines) => watchCommand('17', {
    output: { log: (line) => lines.push(line), error: () => {} }, coordinated: undefined, untilSignal: undefined,
  });
  return { started: started.promise, closing: closing.promise, releaseCleanup: () => beforeClose.resolve(undefined),
    watch, watchCommand, standalone, calls, ended, claims, hooks };
}

async function armPrior(world, job) {
  assert.equal(await job.run(ARM_PREVIOUS), 0, job.output.join('\n'));
  return readFileSync(world.durable, 'utf8');
}

test('ANTI-REGRESSION: a held Herdr watch pins every GitHub subprocess to its verified repository', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const job = world.job(17);
  const calls = join(world.scratch, 'gh-calls.jsonl');
  const hook = join(world.scratch, 'hook');
  const stopped = join(world.scratch, 'forwarder-stopped');
  const extension = join(world.scratch, 'gh-webhook.cjs');
  const record = `
const { appendFileSync, existsSync, unlinkSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const record = (tool) => appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  tool, args, target: [process.env.GH_HOST, process.env.GH_REPO],
}) + '\\n');
`;
  writeFileSync(extension, `${record}
record('extension');
const expiry = setTimeout(() => process.exit(1), 30_000);
process.once('SIGTERM', () => {
  writeFileSync(${JSON.stringify(stopped)}, '');
  clearTimeout(expiry);
});
writeFileSync(${JSON.stringify(hook)}, '');
process.stderr.write('Forwarding Webhook events from GitHub\\n');
`);
  const fake = installFakeGh('held-watch-gh-', `${record}
record('gh');
const hook = ${JSON.stringify(hook)};
const command = args.join(' ');
if (command.startsWith('webhook forward --repo example/one --events ')) {
  const { spawn } = require('node:child_process');
  // Reap the extension after both processes receive the watch's group stop.
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, [${JSON.stringify(extension)}, ...args.slice(1)], { stdio: 'inherit' });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
} else if (command === 'api -X DELETE repos/example/one/hooks/77') {
  unlinkSync(hook);
} else {
  const replies = {
    'api --paginate --slurp repos/example/one/hooks?per_page=100':
      [existsSync(hook) ? [{ id: 77, name: 'cli', active: true, created_at: ${JSON.stringify(RUN_AT)} }] : []],
    'pr view 17 --json baseRefName': { baseRefName: 'main' },
    'api repos/{owner}/{repo}/branches/main': { protected: false },
    'api --paginate --slurp repos/{owner}/{repo}/rules/branches/main': [[]],
    'pr view 17 --json state,mergeStateStatus,headRefOid,autoMergeRequest': { state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: ${JSON.stringify(OID)}, autoMergeRequest: null },
    'pr checks 17 --required --json name,bucket,link': [],
  };
  if (!Object.hasOwn(replies, command)) throw new Error('unexpected provider call: ' + command);
  process.stdout.write(JSON.stringify(replies[command]));
}
`);
  t.after(fake.cleanup);
  const { BOARD_TOOLKIT_GH } = /** @type {{ BOARD_TOOLKIT_GH: string }} */ (fake.env());
  const shadow = { BOARD_TOOLKIT_GH, GH_HOST: 'shadow.invalid', GH_REPO: 'shadow.invalid/example/wrong' };
  const saved = new Map(Object.keys(shadow).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, shadow);

  const holder = job.go(HOLD);
  try {
    await heldDelivery(world, job, holder);
    await armPrior(world, job);
    const status = await job.run(['17', '--held-delivery'], {
      ghExec: (...invocation) => {
        const [args] = invocation;
        if (args[0] === 'repo' || args.includes(DELIVERY_FIELDS)) return job.ghExec(args);
        return Reflect.apply(runGh, undefined, invocation);
      },
    });
    assert.equal(status, 0, job.output.join('\n'));
    assert.equal(job.history().at(-1)?.phase, 'open');
    assert.equal(existsSync(world.watchFile), false);
    assert.equal(existsSync(stopped), true, 'the extension received the stop signal');
    assert.equal(existsSync(hook), false, 'the watch deleted its recorded hook');
  } finally {
    await stopDelivery(job, holder);
  }

  const receipts = readFileSync(calls, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const commands = receipts.map(({ tool, args }) => [tool, ...args].join(' '));
  const events = 'pull_request,push,check_run,status,workflow_job';
  for (const command of [
    'gh pr view 17 --json baseRefName',
    'gh api repos/{owner}/{repo}/branches/main',
    'gh pr view 17 --json state,mergeStateStatus,headRefOid,autoMergeRequest',
    'gh pr checks 17 --required --json name,bucket,link',
    `gh webhook forward --repo example/one --events ${events}`,
    `extension forward --repo example/one --events ${events}`,
    'gh api -X DELETE repos/example/one/hooks/77',
  ]) {
    assert.equal(commands.filter((actual) => actual === command).length, 1, `one actual process for ${command}`);
  }
  assert.deepEqual(receipts.map(({ target }, index) => [commands[index], target]),
    commands.map((command) => [command, ['github.com', 'github.com/example/one']]));
});

test('ANTI-REGRESSION: a stopped Herdr auto-merge settles before the next delivery', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  assertDeliveryOff(deliveryWire(t));
  const world = deliveryWorld(t);
  const a = world.job(17);
  const outsider = world.job(18);
  const b = world.job(19, { codex: true });
  const codexFirst = await heldDelivery(world, b);
  assert.equal(await b.run(ARM_PREVIOUS), 1);
  assert.equal(existsSync(world.durableDir), false, 'a Codex holder cannot create the protected directory');
  await stopDelivery(b, codexFirst);

  const owned = await heldDelivery(world, a);
  assert.equal(await outsider.run(ARM_PREVIOUS), 1);
  assert.equal(existsSync(world.durable), false);
  const armed = await armPrior(world, a);
  assert.equal(await a.run(['--delivery-pr', '18', OID, '--arm']), 1);
  assert.equal(readFileSync(world.durable, 'utf8'), armed);
  world.setProvider(QUEUED_PR);
  await stopDelivery(a, owned);
  assert.equal(a.terminal.state, 'live');
  assert.equal(readFileSync(world.durable, 'utf8'), armed);
  rmSync(join(world.lockRoot, DELIVERY_LOCK_LEAF), { force: true, recursive: true });

  const codexSuccessor = world.job(20, { codex: true });
  const recovering = codexSuccessor.go(HOLD);
  const priorReads = () => world.reads.filter(({ address }) => address === codexSuccessor.address);
  await codexSuccessor.waitLabel(PREVIOUS_WAIT);
  await world.observed(() => recovering.done || world.sleeping(codexSuccessor, 5_000));
  const sleepCount = world.sleepCount(codexSuccessor);
  const readiness = codexSuccessor.go(READY);
  await world.observed(() => readiness.done || world.sleepCount(codexSuccessor) > sleepCount);
  world.tick(1_000);
  assert.equal(await readiness.result, 75, codexSuccessor.output.join('\n'));
  assert.equal(recovering.done, false, 'a local readiness timeout does not cancel its holder');
  let elapsed = 1_000;
  for (const [index, at] of [5_000, 15_000, 35_000, 74_000].entries()) {
    world.tick(at - elapsed);
    await world.observed(() => recovering.done || priorReads().length === index + 2);
    assert.equal(recovering.done, false);
    assert.equal(priorReads().at(-1)?.at, priorReads()[0].at + at);
    elapsed = at;
    await world.observed(() => recovering.done || world.sleeping(codexSuccessor));
  }
  assert.equal(codexSuccessor.history().at(-1)?.reason, PREVIOUS_WAIT);
  assert.equal(readdirSync(join(world.lockRoot, DELIVERY_LOCK_LEAF)).length, 1, 'pending settlement publishes only the lock');
  assert.equal(readFileSync(world.durable, 'utf8'), armed);
  world.setProvider(MERGED_PR);
  // Advance the local probes one deadline at a time while keeping the same holder alive across windows.
  for (let advanced = 0; advanced < 74_000; advanced += 5_000) {
    world.tick(Math.min(5_000, 74_000 - advanced));
    await world.observed(() => recovering.done || world.sleeping(codexSuccessor, 1));
  }
  await world.observed(() => recovering.done || priorReads().length === 6);
  await heldDelivery(world, codexSuccessor, recovering);
  assert.equal(priorReads().at(-1)?.at, priorReads()[0].at + 148_000);
  assert.equal(readFileSync(world.durable, 'utf8'), armed);
  await stopDelivery(codexSuccessor, recovering);
  const claudeSuccessor = world.job(21);
  const cleaned = await heldDelivery(world, claudeSuccessor);
  assert.equal(existsSync(world.durable), false);
  await stopDelivery(claudeSuccessor, cleaned);

  const surplus = deliveryWorld(t);
  const surplusFirst = surplus.job(17);
  const surplusHold = await heldDelivery(surplus, surplusFirst);
  const surplusReceipt = JSON.stringify({ ...JSON.parse(await armPrior(surplus, surplusFirst)), surplus: true });
  await stopDelivery(surplusFirst, surplusHold);
  writeFileSync(surplus.durable, surplusReceipt);
  surplus.setProvider(MERGED_PR);
  assert.equal(existsSync(surplus.watchFile), false);
  const surplusNext = surplus.job(18);
  assert.equal(await surplusNext.run(HOLD), 1, surplusNext.output.join('\n'));
  assert.equal(surplusNext.history().at(-1)?.reason,
    'Delivery stopped: the previous delivery receipt does not match the verified repository and merge-watch state context.');
  assert.equal(readFileSync(surplus.durable, 'utf8'), surplusReceipt, 'a refused receipt keeps its bytes');

  await previousRouteRecovery(t);
  await lateWatchRecovery(t);
});

// new behaviour: a held Claude delivery arms its watch only on a pull request with no auto-merge request, since the
// job merges the checked head itself; one already queued is refused, even where the job's own receipt names it, and
// the receipt keeps its bytes.
test('967 a held Claude delivery arms only a pull request with no auto-merge request', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const holder = await heldDelivery(world, a);
  world.setProvider(QUEUED_PR);
  assert.equal(await a.run(ARM_PREVIOUS), 1, 'a queued pull request with no receipt');
  assert.equal(existsSync(world.durable), false, 'the refused arm writes no receipt');
  world.setProvider(OPEN_PR);
  const armed = await armPrior(world, a);
  world.setProvider(QUEUED_PR);
  assert.equal(await a.run(ARM_PREVIOUS), 1, a.output.join('\n'));
  assert.equal(readFileSync(world.durable, 'utf8'), armed);
  await stopDelivery(a, holder);
});

// existing behaviour: a held watch that ends on a failed required check leaves the delivery unsettled. The job returns
// the pull request to draft (gh pr ready 17 --undo) and releases its reservation, so the next queued job settles the
// receipt, takes the turn and is ready. The first job then holds again behind it, and once it has the turn back it
// marks its repaired head ready, arms and watches that head as it did the first.
test('967 a held Claude delivery whose watch failed a required check releases for its repair, lets the next job deliver and rearms its repaired head', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const b = world.job(19);
  const aHold = a.go(HOLD);
  let bHold;
  try {
    await heldDelivery(world, a, aHold);
    await armPrior(world, a);
    const failed = 'required check "test" failed';
    assert.equal(await a.run(['17', '--held-delivery'], { watch: async (_pr, { output }) => { output.log(failed); return 1; } }), 1, a.output.join('\n'));
    assert.match(a.history().at(-1)?.reason ?? '', new RegExp(escaped(failed)));

    bHold = b.go(HOLD);
    await b.waitLabel(CONTENTION_WAIT);
    world.setProvider({ ...OPEN_PR, isDraft: true });
    await stopDelivery(a, aHold);
    await heldDelivery(world, b, bHold);
    assert.equal(existsSync(world.durable), false, "the released job's receipt is settled");

    a.restart();
    const retake = a.go(HOLD);
    try {
      await a.waitLabel(CONTENTION_WAIT);
      assert.equal(a.history().at(-1)?.phase, 'waiting');
      assert.equal(retake.done, false);
      assert.equal(bHold.done, false);
      await stopDelivery(b, bHold);
      await heldDelivery(world, a, retake);

      // The repair: the repaired head pushed, then gh pr ready 17 again, so GitHub reads it ready there.
      const repaired = 'b'.repeat(40);
      world.setProvider({ ...OPEN_PR, headRefOid: repaired });
      assert.equal(await a.run(READY), 0, a.output.join('\n'));
      assert.equal(await a.run(['--delivery-pr', '17', repaired, '--arm']), 0, a.output.join('\n'));
      assert.equal(JSON.parse(readFileSync(world.durable, 'utf8')).head, repaired, 'the receipt names the repaired head');
      const watched = [];
      assert.equal(await a.run(['17', '--held-delivery'], { watch: async (pr, { output, coordinated }) => {
        watched.push([pr, coordinated.head]);
        output.log(`required checks passed on ${coordinated.head}`);
        return 0;
      } }), 0, a.output.join('\n'));
      assert.deepEqual(watched, [['17', repaired]]);
      assert.equal(a.output.at(-1), `required checks passed on ${repaired}`);
      assert.equal(a.history().at(-1)?.phase, 'open');
    } finally {
      a.stop();
      await retake.result;
    }
  } finally {
    a.stop();
    b.stop();
    await aHold.result;
    await bHold?.result;
  }
});

// existing behaviour: a held Claude delivery whose still-ready pull request now shows a head the job did not arm
// rearms that head itself (its own receipt is replaced), returns the pull request to draft and releases, so the next
// queued job settles a receipt naming the head GitHub shows, takes the turn and the receipt is gone.
test('967 a held Claude delivery whose pull request head moved rearms the moved head, returns to draft and lets the next job deliver', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const b = world.job(19);
  const aHold = a.go(HOLD);
  let bHold;
  try {
    await heldDelivery(world, a, aHold);
    await armPrior(world, a);
    bHold = b.go(HOLD);
    await b.waitLabel(CONTENTION_WAIT);

    const moved = 'c'.repeat(40);
    world.setProvider({ ...OPEN_PR, headRefOid: moved });
    assert.equal(await a.run(['--delivery-pr', '17', moved, '--arm']), 0, a.output.join('\n'));
    assert.equal(JSON.parse(readFileSync(world.durable, 'utf8')).head, moved, 'the receipt names the moved head');
    world.setProvider({ ...OPEN_PR, headRefOid: moved, isDraft: true });
    await stopDelivery(a, aHold);
    await heldDelivery(world, b, bHold);
    assert.equal(existsSync(world.durable), false, "the released job's receipt is settled");
  } finally {
    a.stop();
    b.stop();
    await aHold.result;
    await bHold?.result;
  }
});

// existing behaviour: a released Claude delivery that no other job followed still holds its own receipt, and its own
// next hold settles and removes that receipt; with the turn back it marks its repaired head ready and arms it.
test('967 a released Claude delivery with no successor settles its own receipt when it holds again and arms its repaired head', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const aHold = a.go(HOLD);
  let retake;
  try {
    await heldDelivery(world, a, aHold);
    await armPrior(world, a);
    world.setProvider({ ...OPEN_PR, isDraft: true });
    await stopDelivery(a, aHold);
    assert.equal(existsSync(world.durable), true, 'with no successor the receipt still stands');

    a.restart();
    retake = a.go(HOLD);
    await heldDelivery(world, a, retake);
    assert.equal(existsSync(world.durable), false, 'its own hold settles and removes its receipt');

    const repaired = 'b'.repeat(40);
    world.setProvider({ ...OPEN_PR, headRefOid: repaired });
    assert.equal(await a.run(['--delivery-pr', '17', repaired, '--arm']), 0, a.output.join('\n'));
    assert.equal(JSON.parse(readFileSync(world.durable, 'utf8')).head, repaired, 'the receipt names the repaired head');
  } finally {
    a.stop();
    await aHold.result;
    await retake?.result;
  }
});

// existing behaviour: while a held Claude delivery's receipt stands, arming another pull request, or the same pull
// request under another holder, is refused and the receipt keeps its bytes; only its own holder rearms its own pull
// request on a repaired head.
test("967 a held Claude delivery never replaces another pull request's receipt", async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const refusal = 'another armed pull request still owns the delivery receipt.';
  const world = deliveryWorld(t);
  const a = world.job(17);
  const holder = await heldDelivery(world, a);
  const armed = await armPrior(world, a);
  a.output.length = 0;
  assert.equal(await a.run(['--delivery-pr', '18', OID, '--arm']), 1, 'another pull request');
  assert.ok(a.output.join('\n').includes(refusal), a.output.join('\n'));
  assert.equal(readFileSync(world.durable, 'utf8'), armed);

  // Its own holder rearming its own pull request on a repaired head replaces the receipt.
  const repaired = 'b'.repeat(40);
  world.setProvider({ ...OPEN_PR, headRefOid: repaired });
  assert.equal(await a.run(['--delivery-pr', '17', repaired, '--arm']), 0, a.output.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(world.durable, 'utf8')), { ...JSON.parse(armed), head: repaired }, 'the receipt is the armed one on the repaired head');
  world.setProvider(OPEN_PR);

  // A standing receipt that names another holder of the same pull request is not this holder's to replace.
  const elsewhere = JSON.stringify({ ...JSON.parse(armed), holder: { pid: process.ppid, start: '1' } });
  writeFileSync(world.durable, elsewhere);
  a.output.length = 0;
  assert.equal(await a.run(ARM_PREVIOUS), 1, 'another holder');
  assert.ok(a.output.join('\n').includes(refusal), a.output.join('\n'));
  assert.equal(readFileSync(world.durable, 'utf8'), elsewhere);
  await stopDelivery(a, holder);
});

// existing behaviour: before a held Claude delivery's merge watch opens its webhook, the watch confirms with GitHub
// that the verified origin is the armed repository, and stops the delivery before any forwarder starts when it is not.
test('967 a held Claude delivery stops before the webhook when GitHub does not confirm the armed repository', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = deliveryWorld(t);
  const a = world.job(17);
  const holder = await heldDelivery(world, a);
  await armPrior(world, a);
  const confirming = (verified) => (args) => args[0] === 'repo'
    ? JSON.stringify({ id: DELIVERY_ID, nameWithOwner: DELIVERY_REPO, defaultBranchRef: { name: 'main' }, ...verified })
    : a.ghExec(args);
  const unconfirmed = /** @type {{ differs: string, verified: { id?: string, nameWithOwner?: string } }[]} */ ([
    { differs: 'the id', verified: { id: 'R_other_repository' } },
    { differs: 'the name', verified: { nameWithOwner: 'Example/One' } },
  ]);
  for (const { differs, verified } of unconfirmed) {
    const routes = deliveryEventHost(world);
    // A watch that reached the webhook ends at once, so the assertions below fail instead of the run waiting.
    routes.releaseCleanup();
    const endAtOnce = (pr, options) => routes.watch(pr, { ...options, untilSignal: async () => 'stopped' });
    a.output.length = 0;
    assert.equal(await a.run(['17', '--held-delivery'], { ghExec: confirming(verified), watch: endAtOnce }), 1, differs);
    assert.ok(a.output.includes('Delivery stopped: GitHub did not confirm the armed repository.'), `${differs}: ${a.output.join('\n')}`);
    assert.deepEqual(routes.calls, [], `${differs}: no forwarder or hook call`);
    assert.equal(routes.hooks.size, 0, differs);
  }

  const routes = deliveryEventHost(world);
  const watching = a.go(['17', '--held-delivery'], { ghExec: confirming({}), watch: routes.watch });
  await Promise.race([routes.started, watching.result]);
  assert.equal(watching.done, false, a.output.join('\n'));
  assert.equal(routes.hooks.has(77), true, 'a confirmed repository opens the webhook');
  routes.releaseCleanup();
  a.stop();
  await watching.result;
  await holder.result;
});

async function previousRouteRecovery(t) {
  for (const condition of ['draft', 'wrong head', 'malformed', 'mismatched watch root', 'unsafe watch root', 'unreadable record', 'retained watch']) {
    const world = deliveryWorld(t);
    const a = world.job(17);
    const holder = await heldDelivery(world, a);
    const armed = await armPrior(world, a);
    await stopDelivery(a, holder);
    const routes = deliveryEventHost(world);
    let watchDir = world.watchStateDir;
    if (condition === 'mismatched watch root') {
      watchDir = join(dirname(world.watchStateDir), 'separate-state');
      mkdirSync(watchDir, { mode: 0o700 });
    }
    if (condition === 'unsafe watch root') {
      const ancestor = dirname(world.watchStateDir);
      const moved = join(dirname(ancestor), 'real-xdg');
      renameSync(ancestor, moved);
      symlinkSync(moved, ancestor, 'dir');
    }
    if (condition === 'retained watch' || condition === 'unreadable record') {
      writeFileSync(world.watchFile, JSON.stringify({ ...replacementRecord(), launcher: null, forwarder: null, hookId: null }),
        { mode: condition === 'unreadable record' ? 0o644 : 0o600 });
      routes.hooks.add(99);
    }
    world.setProvider(condition === 'malformed' ? '{' : {
      ...OPEN_PR, isDraft: condition !== 'wrong head', ...(condition === 'wrong head' ? { headRefOid: 'b'.repeat(40) } : {}),
    });
    const b = world.job(18, { codex: true, watchDir });
    if (condition === 'draft') {
      const next = await heldDelivery(world, b);
      await stopDelivery(b, next);
    } else {
      assert.equal(await b.run(HOLD), 1, condition);
      assert.equal(b.history().at(-1)?.phase, 'stopped', condition);
      if (condition === 'wrong head' || condition === 'malformed') assert.equal(b.history().at(-1)?.reason, PR_UNVERIFIED);
      assert.deepEqual(routes.calls, [], condition);
    }
    assert.equal(readFileSync(world.durable, 'utf8'), armed, condition);
    if (condition === 'retained watch') {
      assert.equal(b.history().at(-1)?.reason, WATCH_RETAINED);
      const retained = readFileSync(world.watchFile, 'utf8');
      const lines = [];
      assert.equal(await routes.standalone(lines), 1);
      assert.match(lines.at(-1) ?? '', /forwarding webhook 99.*no merge watch.*prove/);
      assert.equal(readFileSync(world.watchFile, 'utf8'), retained);
      assert.equal(routes.calls.some((args) => args.includes('DELETE')), false);
      assert.equal(routes.hooks.delete(99), true, 'fixture host confirms removal of the unproved hook');
      assert.equal(await routes.standalone(lines), 0);
      assert.equal(existsSync(world.watchFile), false);
      assert.deepEqual(routes.calls.filter((args) => args.includes('DELETE')), [['api', '-X', 'DELETE', 'repos/example/one/hooks/77']]);
      const next = await heldDelivery(world, b);
      await stopDelivery(b, next);
    }
  }
}

async function lateWatchRecovery(t) {
  for (const result of ['kept shell', 'claim abandoned', 'existing record', 'success while open', 'cleanup failed', 'confirmed merged']) {
    const world = deliveryWorld(t);
    const a = world.job(17);
    const b = world.job(18, { codex: result !== 'existing record' });
    const routes = deliveryEventHost(world, { failDelete: result === 'cleanup failed' });
    const holder = await heldDelivery(world, a);
    const armed = await armPrior(world, a);
    const watchArgs = ['17', '--held-delivery'];
    if (['success while open', 'cleanup failed', 'confirmed merged'].includes(result)) {
      let atWatchExit;
      let commandStatus;
      const watched = await a.run(watchArgs, { watch: async (pr, options) => {
        commandStatus = await routes.watchCommand(pr, options);
        atWatchExit = world.reads.length;
        return commandStatus;
      } });
      assert.equal(typeof watched, 'number');
      assert.ok(atWatchExit !== undefined, 'the held watcher reached its ordinary command outcome');
      assert.equal(commandStatus, result === 'cleanup failed' ? 1 : 0);
      if (result !== 'cleanup failed') {
        assert.ok(world.reads.length > atWatchExit, 'successful watch must be followed by provider verification');
        assert.equal(a.history().at(-1)?.phase, 'open', result);
      }
      // The job's own pinned merge follows the held watch; the exact read after it labels the row merged.
      if (result === 'confirmed merged') {
        world.setProvider(MERGED_PR);
        assert.equal(await a.run(['--delivery-pr', '17', OID]), 0, a.output.join('\n'));
      }
      assert.equal(a.history().some(({ phase }) => phase === 'merged'), result === 'confirmed merged', result);
      if (result === 'cleanup failed') {
        assert.ok(a.output.some((line) => line.includes('fixture hook deletion refused')));
        assert.equal(existsSync(world.watchFile), true);
        assert.equal(routes.hooks.has(77), true);
        assert.equal(a.history().at(-1)?.phase, 'stopped');
      }
      if (result === 'confirmed merged') {
        assert.deepEqual(a.history().at(-1), { address: a.address, phase: 'merged', repo: DELIVERY_REPO, pr: 17 });
        const last = a.history().at(-1);
        a.stop();
        await holder.result;
        assert.deepEqual(a.history().at(-1), last, 'lease shutdown preserves the confirmed merged label');
      } else await stopDelivery(a, holder);
      continue;
    }
    if (result === 'kept shell') {
      const kept = await nodeProcessFixture(t, { root: world.scratch }, 'fixture/kept-shell.mjs');
      a.terminal.status.state = 'working';
      const watch = a.go(watchArgs, { watch: routes.watch });
      await Promise.race([routes.started, watch.result]);
      assert.equal(watch.done, false);
      const recorded = readFileSync(world.watchFile, 'utf8');
      a.terminal.status.state = 'idle';
      world.tick(5_000);
      await world.observed(() => watch.done || world.sleeping(a, 5_000));
      assert.equal(await a.run(READY), 0);
      assert.equal(readFileSync(world.watchFile, 'utf8'), recorded);
      assert.equal(watch.done, false);
      const waiting = b.go(HOLD);
      await b.waitLabel(CONTENTION_WAIT);
      a.terminal.pid = kept.pid;
      world.setProvider(MERGED_PR);
      world.tick(5_000);
      assert.equal(await holder.result, 1);
      await Promise.race([routes.closing, watch.result]);
      await b.waitLabel(WATCH_WAIT);
      assert.equal(waiting.done, false);
      assert.equal(readFileSync(world.watchFile, 'utf8'), recorded);
      routes.releaseCleanup();
      assert.equal(await watch.result, 1);
      world.tick(5_000);
      await heldDelivery(world, b, waiting);
      assert.equal(a.history().at(-1)?.phase, 'stopped');
      assert.equal(readFileSync(world.durable, 'utf8'), armed);
      assert.equal(existsSync(world.watchFile), false);
      await stopDelivery(b, waiting);
      continue;
    }

    const began = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const watch = a.go(watchArgs, { watch: async (pr, options) => {
      began.resolve(undefined);
      await resume.promise;
      return routes.watch(pr, options);
    } });
    await Promise.race([began.promise, watch.result]);
    assert.equal(watch.done, false);
    await stopDelivery(a, holder);
    world.setProvider(MERGED_PR);
    const successor = await heldDelivery(world, b);
    const replacement = JSON.stringify(replacementRecord());
    let protectedReceipt = armed;
    if (result === 'existing record') {
      world.setNextBranch('job/18');
      assert.equal(await b.run(['--delivery-pr', '18', OID, '--arm']), 0);
      protectedReceipt = readFileSync(world.durable, 'utf8');
      assert.notEqual(protectedReceipt, armed);
      writeFileSync(world.watchFile, replacement, { mode: 0o600 });
      world.watchProcesses.push(WATCH_LAUNCH, WATCH_FORWARD);
      routes.hooks.add(77);
    }
    const reads = world.reads.length;
    resume.resolve(undefined);
    assert.equal(await watch.result, 1);
    assert.deepEqual(routes.calls, [], result);
    assert.deepEqual(routes.ended, [], result);
    assert.equal(world.reads.length, reads, result);
    if (result === 'existing record') {
      assert.ok(a.output.includes(EXISTING_WATCH), a.output.join('\n'));
      assert.equal(readFileSync(world.watchFile, 'utf8'), replacement);
      assert.equal(routes.hooks.has(77), true);
      assert.deepEqual(routes.claims, []);
    } else {
      assert.deepEqual(routes.claims, [{ watch: WATCH_IDENTITY(WATCH_SELF), launcher: null, forwarder: null, hookId: null }]);
      assert.equal(existsSync(world.watchFile), false);
    }
    assert.equal(await b.run(READY), 0);
    assert.equal(readFileSync(world.durable, 'utf8'), protectedReceipt);
    await stopDelivery(b, successor);
  }
}

// ── a pinned Claude job's delivery ───────────────────────────────────────────
// The expected outcomes come from the plan: for a pinned record, the reserve and readiness routes check drift at
// their head, before any lane, lock or lease access, and a stopped delivery names the repair-first recovery order with
// the owner route as a separate alternative. Unpinned jobs keep today's outcomes.

// A delivery world whose repository example/one is a real Git repository at the commit `commitWorkflow` makes, with
// that commit's verified snapshot at its canonical store path. `pinned(job)` labels a Claude job of it with that
// commit, as Herdr records a pinned job, and returns the run overrides carrying the job's launch marks.
function pinnedDeliveryWorld(t) {
  let repository;
  // Registered before the world's own removal, which cannot remove a read-only snapshot.
  t.after(() => {
    if (repository) writable(repository);
  });
  const world = deliveryWorld(t);
  repository = world.repository;
  const commit = commitWorkflow(repository);
  repairWorkflowSnapshot({ cwd: repository, commit });
  const pinned = (job) => {
    job.terminal.labels['fabraik.workflow'] = commit;
    return { env: { HC_TERMINAL_ID: job.address, FABRAIK_COORDINATED_JOB: '1', FABRAIK_WORKFLOW_ROOT: pinnedRoot(repository, commit) } };
  };
  return { ...world, pinned };
}

test('ANTI-REGRESSION: delivery routes check drift before the lease', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = pinnedDeliveryWorld(t);
  const lane = join(world.lockRoot, DELIVERY_LOCK_LEAF);
  const lock = join(lane, 'delivery.lock');
  const drifted = 'scripts/lib/workflow-pin.mjs';
  // Runs one route to its end, ticking a readiness wait past its deadline or releasing a held reservation. The lane and
  // its lock are read once the route has stopped or waits, and the lease reader counts its calls and finds no lease.
  const route = async (job, args) => {
    let leaseReads = 0;
    const readDeliveryLease = async () => {
      leaseReads += 1;
      return undefined;
    };
    const operation = job.go(args, { ...world.pinned(job), readDeliveryLease });
    await world.observed(() => operation.done || world.sleeping(job));
    const present = { lane: existsSync(lane), lock: existsSync(lock) };
    if (!operation.done && args === READY) world.tick(1_000);
    else if (!operation.done) job.stop();
    const status = await operation.result;
    const line = job.output.at(-1);
    const reason = line?.startsWith('Delivery stopped: ') && line.includes(drifted) ? 'the drift reason' : line;
    return { status, reason, leaseReads, ...present };
  };

  const contract = readFileSync(join(world.repository, drifted));
  writeFileSync(join(world.repository, drifted), Buffer.concat([contract, Buffer.from('// moved on\n')]));
  const a = world.job(17);
  const driftReadiness = await route(a, READY);
  const driftReserve = await route(a, HOLD);
  writeFileSync(join(world.repository, drifted), contract);
  const b = world.job(18);
  const readiness = await route(b, READY);
  const reserve = await route(b, HOLD);

  assert.deepEqual({
    'drift: readiness': { status: driftReadiness.status, reason: driftReadiness.reason, leaseReads: driftReadiness.leaseReads },
    'drift: reserve': { status: driftReserve.status, reason: driftReserve.reason, lane: driftReserve.lane, lock: driftReserve.lock },
    'no drift: readiness': { status: readiness.status, reason: readiness.reason, leaseRead: readiness.leaseReads > 0 },
    'no drift: reserve': { status: reserve.status, lane: reserve.lane, lock: reserve.lock },
  }, {
    'drift: readiness': { status: 1, reason: 'the drift reason', leaseReads: 0 },
    'drift: reserve': { status: 1, reason: 'the drift reason', lane: false, lock: false },
    'no drift: readiness': { status: 75, reason: 'Waiting for delivery readiness.', leaseRead: true },
    'no drift: reserve': { status: 0, lane: true, lock: true },
  }, [...a.output, '---', ...b.output].join('\n'));
});

// The labels of the `steps` that `text` names in order, stopping at the first it does not name after the one before.
function namedInOrder(text, steps) {
  const named = [];
  let at = 0;
  for (const step of steps) {
    const rest = text.slice(at);
    const index = typeof step === 'string' ? rest.indexOf(step) : rest.search(step);
    if (index < 0) break;
    named.push(String(step));
    at += index + 1;
  }
  return named;
}

test('ANTI-REGRESSION: a stopped Claude delivery names the repair-first recovery', async (t) => {
  if (DELIVERY_LINUX_ONLY) return t.skip(DELIVERY_LINUX_ONLY);
  const world = pinnedDeliveryWorld(t);
  const a = world.job(17);
  const holder = await heldDelivery(world, a);
  await armPrior(world, a);
  await stopDelivery(a, holder);
  // The previous job's watch has ended and left its record behind.
  writeFileSync(world.watchFile, JSON.stringify({ ...replacementRecord(), launcher: null, forwarder: null, hookId: null }), { mode: 0o600 });
  const b = world.job(18);
  assert.equal(await b.run(HOLD, world.pinned(b)), 1, b.output.join('\n'));
  // The plan's recovery order: resume the job, which repairs its snapshot; withdraw; run the pinned cleanup until no
  // record is retained; only then start a new job. Then the separate owner route, which prints the watch-state
  // directory the record was read from and runs the root checkout's cleanup with that directory as the state directory.
  const steps = [
    /\bresume\b/i, 'gh pr ready 17 --undo', 'node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" 17', /\bnew job\b/i,
    /\bowner route\b/i, world.watchStateDir, 'XDG_STATE_HOME', 'node scripts/merge-watch.mjs 17',
  ];
  assert.deepEqual(namedInOrder(b.output.at(-1) ?? '', steps), steps.map(String), b.output.join('\n'));
  // The withdrawal applies only while the pull request is still open: its step, from the clause that names it up to the
  // cleanup command, states a condition on the pull request being open.
  const stopped = b.output.at(-1) ?? '';
  const withdraw = stopped.indexOf('gh pr ready 17 --undo');
  const withdrawStep = stopped.slice(stopped.lastIndexOf(';', withdraw) + 1, stopped.indexOf('node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" 17', withdraw));
  assert.ok(/\b(if|while|only|when)\b/i.test(withdrawStep) && /\bopen\b/i.test(withdrawStep), `the withdrawal is conditional on an open pull request: ${withdrawStep}`);

  // The foreground readiness check after that stop gives the whole recovery, in its output or in a file its output
  // names, never one cut short.
  const outputBefore = b.output.length;
  const readiness = b.go(READY, world.pinned(b));
  await world.observed(() => readiness.done || world.sleeping(b));
  if (!readiness.done) world.tick(1_000);
  assert.equal(await readiness.result, 1, b.output.join('\n'));
  const said = b.output.slice(outputBefore).join('\n');
  const named = [...said.matchAll(/\/[^\s`'"]+/g)].map(([path]) => path.replace(/[.,;:]+$/, ''))
    .filter((path) => existsSync(path) && lstatSync(path).isFile()).map((path) => readFileSync(path, 'utf8'));
  const fullest = [said, ...named].map((text) => namedInOrder(text, steps)).sort((x, y) => y.length - x.length)[0];
  assert.deepEqual(fullest, steps.map(String), said);
});

function bindReadbackFixture(t, { address = 't10', parent = 't9', live = {}, labels = {}, record = {}, file = 'regular' } = {}) {
  const hc = {};
  const created = 1795090122648;
  const { root, calls, run } = wireFixture(t, { hc, listing: (_name, root) => {
    hc[`get:${address}:--json`] = JSON.stringify({ address, state: 'live', cwd: root, created_ms: created, parent, ...live,
      labels: { 'fabraik.role': 'job', 'fabraik.runtime': 'codex', 'fabraik.card': '5', 'fabraik.runstart': RUN_AT, ...labels } });
    return { spaces: [] };
  } });
  const state = join(dirname(root), 'state');
  const lead = join(state, 'fabraik-lead');
  const delivery = join(lead, 'codex-delivery');
  mkdirSync(delivery, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(`${root}\0${address}`).digest('hex');
  const bind = join(delivery, `bind-${hash}.json`);
  const content = JSON.stringify({ version: 1, root, repositoryId: 'R_1', card: 5, runStart: RUN_AT, terminalAddress: address,
    terminalCreatedMs: created, parentAddress: parent, threadId: SESSION, ...record });
  if (file === 'symlink' || file === 'hard link') {
    const original = join(delivery, 'original.json');
    writeFileSync(original, content, { mode: 0o600 });
    if (file === 'symlink') symlinkSync(original, bind);
    else linkSync(original, bind);
  } else if (file !== 'absent') {
    writeFileSync(bind, file === 'corrupt' ? '{' : content, { mode: 0o600 });
  }
  const snapshot = () => [state, lead, delivery, ...readdirSync(delivery).sort().map((name) => join(delivery, name))].map((path) => {
    const stat = lstatSync(path);
    const { mode, dev, ino, nlink } = stat;
    const contents = stat.isDirectory() ? readdirSync(path).sort() : stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
    return { path, mode, dev, ino, nlink, contents };
  });
  return { calls, snapshot, run: (env = {}, args = []) => run(['bind-job', ...args],
    { XDG_STATE_HOME: state, HC_TERMINAL_ID: address, CODEX_THREAD_ID: SESSION, ...env }) };
}

test('929 reads only its own host-confirmed Herdr bind', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const fixture = bindReadbackFixture(t, { address: 't14g', parent: 't9y' });
  const original = fixture.snapshot();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, `Bound Codex Herdr job #5 at t14g to thread ${SESSION}.\n`);
  assert.equal(result.stderr, '');
  assert.deepEqual(fixture.calls(), [
    { tool: 'git', args: ['rev-parse', '--local-env-vars'] },
    { tool: 'git', args: ['rev-parse', '--path-format=absolute', '--git-common-dir'] },
    { tool: 'hc', args: ['get', 't14g', '--json'] },
  ]);
  assert.deepEqual(fixture.snapshot(), original, 'the existing bind is read without replacing or changing it');
});

test('929 refuses malformed or unavailable Herdr bind read-back', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const cases = [
    { name: 'extra arguments', args: ['extra'], cause: /^usage: node scripts\/coordinator\.mjs / },
    { name: 'absent record', file: 'absent', cause: /absent|missing|not found|does not exist|ENOENT/i },
    { name: 'symbolic link', file: 'symlink', cause: /symbolic link|symlink/i },
    { name: 'hard link', file: 'hard link', cause: /hard.link|link count|single.link/i },
    { name: 'corrupt record', file: 'corrupt', cause: /corrupt|JSON|pars(?:e|ing)/i },
    { name: 'wrong address', record: { terminalAddress: 't11' }, cause: /address/i },
    { name: 'wrong thread', record: { threadId: KEPT_SESSION }, cause: /thread/i },
    { name: 'wrong root', record: { root: realpathSync(tmpdir()) }, cause: /root/i },
    { name: 'reused terminal address', live: { created_ms: 1795090122649 }, cause: /creation|generation|created/i },
    { name: 'live card mismatch', labels: { 'fabraik.card': '6' }, cause: /\bcard\b/i },
    { name: 'live run mismatch', labels: { 'fabraik.runstart': '2026-11-19T13:00:00Z' }, cause: /\brun(?:start)?\b/i },
    { name: 'live parent mismatch', live: { parent: 't1' }, cause: /\bparent\b/i },
    { name: 'missing terminal context', env: { HC_TERMINAL_ID: undefined }, cause: /HC_TERMINAL_ID|terminal/i },
    { name: 'machine-qualified terminal', env: { HC_TERMINAL_ID: 'remote/t14g' }, cause: /local terminal/i },
    { name: 'malformed terminal', env: { HC_TERMINAL_ID: 't14a' }, cause: /local terminal/i },
    { name: 'missing thread context', env: { CODEX_THREAD_ID: undefined }, cause: /CODEX_THREAD_ID|thread/i },
  ];

  const outcomes = cases.map(({ name, args, env, cause, ...recordOptions }) => {
    const fixture = bindReadbackFixture(t, recordOptions);
    const original = fixture.snapshot();
    const result = fixture.run(env, args);
    assert.deepEqual(fixture.snapshot(), original, `${name} leaves the bind and its directory intact`);
    const calls = fixture.calls();
    assert.deepEqual(calls.filter(({ tool, args }) => tool === 'gh' || tool === 'herdr-app' ||
      (tool === 'hc' && !['ls', 'get'].includes(args[0]))), [], `${name} makes no provider call or Herdr mutation`);
    if (args) assert.deepEqual(calls, [], 'argument refusal precedes external work');
    return { name, args, cause, result };
  });
  for (const { name, args, cause, result } of outcomes) {
    const output = result.stdout + result.stderr;
    if (args) {
      assert.equal(result.status, 2, output);
      assert.match(result.stderr, cause);
      assert.equal(result.stdout, '');
    } else {
      assert.equal(result.status, 1, `${name}: ${output}`);
      assert.match(output, /bind/i, name);
      assert.match(output, cause, name);
    }
  }
});

test('coordinator command refuses unknown arguments with exit 2', (t) => {
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] }) });
  const unknown = [[], ['open'], ['open', '--login'], ['open', '--login', 'bad/name'], ['open', '--login', 'owner', '--extra', 'x'], ['frobnicate', '--login', 'owner'], ['host', '--space', 'sp1'],
    ['cards'], ['cards', '--login', 'owner', '--extra', 'x'], ['start', '--login', 'owner'], ['start', '0', '--login', 'owner'], ['start', 'five', '--login', 'owner'],
    ['start', '5', '6', '--login', 'owner'], ['start', '5', '--login', 'owner', '--extra', 'x'], ['start', '5'], ['wake', 'now'], ['wake', '--login', 'owner'],
    ['unfinished'], ['unfinished', '--login'], ['unfinished', '--login', 'bad/name'], ['unfinished', '--login', 'owner', '--extra', 'x'], ['unfinished', '5', '--login', 'owner']];
  for (const args of unknown) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, /^usage: node scripts\/coordinator\.mjs /);
    assert.equal(refused.stdout, '');
  }
  assert.deepEqual(calls(), [], 'a refused command reaches neither git, herdr-app nor hc');
});

// new behaviour: the launch command refuses a malformed model, an unknown effort and a missing login before any call
test('coordinator launch refuses a malformed model, an unknown effort or a missing login with its usage and exit 2', (t) => {
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] }) });
  for (const args of [['launch', '--runtime', 'claude', '--login', 'owner', '--model', 'a b', '--effort', 'medium'],
    ['launch', '--runtime', 'claude', '--login', 'owner', '--model', 'opus', '--effort', 'huge'],
    ['launch', '--runtime', 'claude', '--model', 'opus', '--effort', 'medium']]) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, /^usage: node scripts\/coordinator\.mjs .*\blaunch --runtime\b/, args.join(' '));
    assert.equal(refused.stdout, '');
  }
  assert.deepEqual(calls(), [], 'a refused launch reaches neither git, herdr-app nor hc');
});

test('coordinator launch refuses a login that is not a GitHub login with its usage and exit 2', (t) => {
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] }) });
  for (const login of ['bad login', 'bad/name', 'owner-']) {
    const refused = run(['launch', '--runtime', 'codex', '--login', login]);
    assert.equal(refused.status, 2, login);
    assert.match(refused.stderr, /^usage: node scripts\/coordinator\.mjs .*\blaunch --runtime\b/, login);
    assert.equal(refused.stdout, '');
  }
  assert.deepEqual(calls(), [], 'a refused launch reaches neither git, herdr-app nor hc');
});

test('coordinator command lists unfinished jobs through the tools on PATH', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // Card 5's branch is underway, card 7's asks the owner, and card 9's draft is newest claimed by this machine.
  const { calls, run } = wireFixture(t, { listing: (name, folder) => ({ spaces: [space('spproject1', name, [['tb1', '1']], null, folder)] }),
    hc: { ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [] }) },
    repository: { branches: [5, 7], worktrees: [] },
    tracker: { nodes: [issue(5, { status: 'In progress' }), issue(7, { status: 'In progress' }), issue(9, { status: 'In review' })],
      comments: { 7: ['Needs owner: Pick the panel colours.'], 9: [`Claim: ${hostname()}, Claude Code, 2026-11-18T09:00Z`] },
      drafts: [{ number: 40, headRefName: 'job/9' }] } });
  const listed = run(['unfinished', '--login', 'owner']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const lines = listed.stdout.trim().split('\n');
  assert.equal(lines.length, 3, listed.stdout);
  assert.match(lines[0], /^#5 continue: .*\bjob\/5\b/);
  assert.equal(lines[1], '#7 held: its card has a Needs owner: comment');
  assert.match(lines[2], /^#9 continue: .*#40\b/);
  assert.ok(calls().some(({ tool, args }) => tool === 'gh' && args[0] === 'pr'), 'the draft pull requests are read through the gh on PATH');
  assert.ok(calls().some(({ tool, args }) => tool === 'git' && args[0] === 'for-each-ref'), 'the branches are read through the git on PATH');
  assert.ok(calls().some(({ tool, args }) => tool === 'hc' && args[0] === 'ls'), 'Herdr is read through the hc on PATH');
  assert.deepEqual(calls().filter(({ tool, args }) => (tool === 'hc' && !['ls', 'get'].includes(args[0])) || (tool === 'herdr-app' && args[0] === 'do')), [],
    'listing changes nothing in Herdr');
});

test('coordinator command reads the cards where no state folder can be created', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { root, calls, run } = wireFixture(t, { listing: (name, folder) => ({ spaces: [space('spproject1', name, [['tb1', '1']], null, folder)] }) });
  // The state path lies under a regular file, so no folder can be made there.
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, '');
  const listed = run(['cards', '--login', 'owner'], { XDG_STATE_HOME: blocker });
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.ok(calls().some(({ tool }) => tool === 'gh'), 'the board is read through the gh on PATH');
});

test('coordinator command opens through the herdr-app on PATH', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { root, calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [['tb1', '1']], null, root)] }) });
  const opened = run(['open', '--login', 'owner']);
  assert.equal(opened.status, 0, opened.stderr);
  const made = calls().filter(({ tool }) => tool === 'herdr-app');
  assert.deepEqual(made.map(({ args }) => args.slice(0, 2)), [['ls'], ['do', 'tab.new']]);
  assert.deepEqual(flagsOf(made[1].args), { space: 'spproject1', name: 'Coordinator', folder: root, argv: argvFor('sonnet', 'high', 'owner') });
  assert.ok(calls().some(({ tool, args }) => tool === 'git' && args.join(' ') === 'fetch --no-prune origin main'), 'main is fetched first');
  assert.ok(!calls().some(({ tool }) => tool === 'hc'), 'opening the coordinator starts no job');
});

test('929 opens the selected installed coordinator runtime', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const listing = (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] });
  const open = ['open', '--login', 'owner'];
  const codex = ['/usr/bin/env', 'codex', '--no-daemon', '--enable', 'default_mode_request_user_input', '--', prompt('owner')];
  const openedArgv = (fixture) => newTabs(fixture.calls().filter(({ tool }) => tool === 'herdr-app').map(({ args }) => args))
    .map((args) => flagsOf(args).argv);

  // The wire fixture returns the same empty layout on each open, modeling a fresh tab after the one-off ends.
  const claudeDefault = wireFixture(t, { listing, text: settingsText({ runtimes: ['claude', 'codex'],
    coordinator: { runtime: 'claude', model: 'sonnet', effort: 'high' } }) });
  const once = claudeDefault.run([...open, '--runtime', 'codex']);
  assert.equal(once.status, 0, once.stdout + once.stderr);
  assert.deepEqual(openedArgv(claudeDefault), [codex]);
  assert.equal(existsSync(join(claudeDefault.root, '.agents', 'factory-settings.json')), false);
  const normal = claudeDefault.run(open);
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.deepEqual(openedArgv(claudeDefault), [codex, argvFor('sonnet', 'high', 'owner')]);

  const codexDefault = wireFixture(t, { listing, text: settingsText({ runtimes: ['codex'], coordinator: { runtime: 'codex' } }) });
  const saved = codexDefault.run(open);
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  assert.deepEqual(openedArgv(codexDefault), [codex]);

  const runningCodex = wireFixture(t, {
    listing: (name, root) => ({ spaces: [{ ...space('spproject1', name, [], null, root),
      tabs: [{ id: 'tbc', name: 'Coordinator', terminals: listed('t1') }] }] }),
    hc: { get: JSON.stringify({ ...liveRecord({ foreground: 'codex', argv: codex, foregroundPid: 100 }),
      status: { app: 'codex', state: 'working' } }) },
  });
  const repeat = runningCodex.run([...open, '--runtime', 'codex']);
  assert.equal(repeat.status, 5, repeat.stdout + repeat.stderr);
  assert.deepEqual(runningCodex.calls().filter(({ tool }) => tool === 'herdr-app').map(({ args }) => args), [['ls']]);

  const claudeOnly = wireFixture(t, { listing, text: settingsText({ runtimes: ['claude'] }) });
  const malformed = claudeOnly.run([...open, '--runtime', 'unknown']);
  assert.equal(malformed.status, 2, malformed.stdout + malformed.stderr);
  assert.deepEqual(claudeOnly.calls(), []);
  const uninstalled = claudeOnly.run([...open, '--runtime', 'codex']);
  assert.equal(uninstalled.status, 1, uninstalled.stdout + uninstalled.stderr);
  assert.match(uninstalled.stdout + uninstalled.stderr, /codex.*not installed/i);
  assert.deepEqual(claudeOnly.calls().filter(({ tool }) => tool === 'herdr-app' || tool === 'hc'), []);
});

async function nodeProcessFixture(t, { root }, scriptArg, ...args) {
  const scriptPath = join(root, scriptArg);
  mkdirSync(dirname(scriptPath));
  writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\nprocess.send("ready");\n');
  const child = spawn(process.execPath, ['--no-warnings', scriptArg, ...args],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { child.kill('SIGKILL'); });

  const timeout = AbortSignal.timeout(5000);
  const wait = new AbortController();
  const signal = AbortSignal.any([timeout, wait.signal]);
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal }),
      once(child, 'exit', { signal }).then(([code, exitSignal]) => {
        throw new Error(`Node fixture ${scriptArg} exited before readiness (code ${code}, signal ${exitSignal})`);
      }),
    ]);
    assert.equal(message, 'ready', `Node fixture ${scriptArg} sent an unexpected readiness message`);
  } catch (error) {
    if (timeout.aborted) throw new Error(`Timed out waiting for Node fixture ${scriptArg} readiness`, { cause: error });
    throw error;
  } finally {
    wait.abort();
  }

  const pid = child.pid;
  assert.ok(pid, `the ready Node fixture ${scriptArg} has a PID`);
  return { pid, child };
}

const chooserHerdrCalls = (fixture) => fixture.calls().filter(({ tool }) => tool === 'herdr-app' || tool === 'hc');

test('929 resolves the session chooser login at the project root', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const open = ['open', '--runtime', 'codex'];
  const text = settingsText({ runtimes: ['claude', 'codex'], coordinator: { runtime: 'claude' } });
  const listing = (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] });
  const fixture = (options = {}) => wireFixture(t, { listing, text, ...options });
  const gh = (made) => made.calls().filter(({ tool }) => tool === 'gh').map(({ args }) => args);
  const loginRead = ['api', 'user', '--jq', '.login'];
  const assertRefusal = (made, result, cause) => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, cause);
    assert.deepEqual(chooserHerdrCalls(made), [], 'a refusal before launch reaches no Herdr command');
  };

  const ready = fixture();
  const opened = ready.run(open);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.deepEqual(gh(ready), [loginRead]);
  const calls = ready.calls();
  assert.ok(calls.findIndex(({ tool }) => tool === 'gh') < calls.findIndex(({ tool }) => tool === 'herdr-app'));
  assert.deepEqual(chooserHerdrCalls(ready).map(({ args }) => args.slice(0, 2)), [['ls'], ['do', 'tab.new']]);
  assert.deepEqual(flagsOf(chooserHerdrCalls(ready)[1].args), { space: 'spproject1', name: 'Coordinator', folder: ready.root,
    argv: ['/usr/bin/env', 'codex', '--no-daemon', '--enable', 'default_mode_request_user_input', '--', prompt('octocat')] });

  for (const login of ['bad/name\n', null]) {
    const refused = fixture({ login });
    assertRefusal(refused, refused.run(open), /login/i);
    assert.deepEqual(gh(refused), [loginRead]);
  }
  const offRoot = fixture();
  const nested = join(offRoot.root, 'nested');
  mkdirSync(nested);
  assertRefusal(offRoot, offRoot.run(open, {}, nested), /root/i);
  assert.deepEqual(gh(offRoot), [], 'a different working folder is refused before the login read');

  const coordinator = (id, terminals) => ({ id, name: 'Coordinator', terminals });
  for (const { cause, tabs, hc, noCoordinatorReads } of [
    { cause: /tab|duplicate/i, tabs: [coordinator('tbc', listed('t1')), coordinator('tbc', listed('t2'))] },
    { cause: 'herdr-app ls lists duplicate terminals in the Coordinator tab tbc', tabs: [coordinator('tbc', listed('t1', 't1'))], noCoordinatorReads: true },
    { cause: /terminal|state/i, tabs: [coordinator('tbc', listed('t1'))], hc: { get: JSON.stringify({ state: 'unknown' }) } },
    { cause: /terminal|state/i, tabs: [coordinator('tbc', listed('t1'))],
      hc: { get: JSON.stringify(liveRecord({ foreground: 'unknown', argv: ['unknown'] })) } },
  ]) {
    const changed = fixture({ hc, listing: (name, root) => ({ spaces: [{ ...space('spproject1', name, [], null, root), tabs }] }) });
    const refused = changed.run(open);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    if (typeof cause === 'string') assert.equal(refused.stdout.trim(), cause);
    else assert.match(refused.stdout + refused.stderr, cause);
    if (noCoordinatorReads) assert.deepEqual(changed.calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'get'), [],
      'duplicate terminals are rejected before any coordinator terminal is read');
    assert.deepEqual(chooserHerdrCalls(changed).filter(({ tool, args }) => tool === 'herdr-app' && args[0] === 'do'), [],
      'the locked opener changes no tab when the layout became ambiguous');
  }
});

test('coordinator command opens a missing coordinator with only PATH and HOME set', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] }) });
  const opened = run(['open', '--login', 'owner'], { BOARD_TOOLKIT_GH: undefined });
  assert.equal(opened.status, 0, opened.stderr);
  const made = newTabs(calls().filter(({ tool }) => tool === 'herdr-app').map(({ args }) => args));
  assert.equal(made.length, 1);
  assert.deepEqual(flagsOf(made[0]).argv, argvFor('sonnet', 'high', 'owner'));
});

test('coordinator wake command refuses an extra argument with exit 2', (t) => {
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [space('spproject1', name, [], null, root)] }) });
  const refused = run(['wake', 'now']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /\| wake$/m);
  assert.deepEqual(calls(), []);
});

test('ANTI-REGRESSION: waking the coordinator makes no tracker request', (t) => {
  if (NO_EXTENSIONLESS_FAKES) return t.skip(NO_EXTENSIONLESS_FAKES);
  const { calls, run } = wireFixture(t, { listing: (name, root) => ({ spaces: [{ ...space('spproject1', name, [], null, root), tabs: [{ id: 'tbc', name: 'Coordinator', terminals: [{ terminal: 't9' }] }] }] }),
    hc: { get: JSON.stringify(liveRecord()) } });
  const woken = run(['wake']);
  assert.equal(woken.status, 0, woken.stdout + woken.stderr);
  assert.deepEqual(calls().filter(({ tool }) => tool === 'gh'), [], 'no gh call');
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'git' && args[0] === 'fetch'), [], 'no fetch');
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'send').map(({ args }) => args), [['send', 't9', 'A card moved to Ready.']]);
});

// The board tools' wake, run through the real coordinator.mjs under the wire fixture's folder and fakes.
function wakeAfterMoveIn(root, command = COMMAND) {
  const env = { PATH: `${join(dirname(root), 'bin')}:/usr/bin:/bin`, HOME: dirname(root) };
  return wakeAfterMove(command, (file, args, options) => spawnSync(file, args, { ...options, cwd: root, env }));
}

test('board wake sends one hc send through the real command and returns undefined', (t) => {
  if (NO_EXTENSIONLESS_FAKES) return t.skip(NO_EXTENSIONLESS_FAKES);
  const { root, calls } = wireFixture(t, { listing: (name, folder) => ({ spaces: [{ ...space('spproject1', name, [], null, folder), tabs: [{ id: 'tbc', name: 'Coordinator', terminals: [{ terminal: 't9' }] }] }] }),
    hc: { get: JSON.stringify(liveRecord()) } });
  assert.equal(wakeAfterMoveIn(root), undefined);
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'send').map(({ args }) => args), [['send', 't9', 'A card moved to Ready.']]);
});

test('board wake returns the cause when the real command exits 1 on unreadable Herdr output', (t) => {
  const { root, calls } = wireFixture(t, { listing: () => 'not a listing' });
  const cause = wakeAfterMoveIn(root);
  assert.equal(typeof cause, 'string');
  assert.notEqual(cause, '');
  assert.deepEqual(calls().filter(({ tool }) => tool === 'hc'), []);
});

test('board wake returns undefined and runs nothing when the command path is missing', (t) => {
  const { root, calls } = wireFixture(t, { listing: (name, folder) => ({ spaces: [space('spproject1', name, [], null, folder)] }) });
  assert.equal(wakeAfterMoveIn(root, join(root, 'absent', 'coordinator.mjs')), undefined);
  assert.deepEqual(calls(), []);
});

// What forwardedNotes reads of one job terminal: card `card`'s job, a child of `parent`, live at `status` since `statusMs`
// unless `state` is finished.
const forwardJob = (card, { parent = 't2', state = 'live', status = 'working', statusMs = 100 } = {}) =>
  ({ state, status: state === 'live' ? status : null, statusMs: state === 'live' ? statusMs : null, parent, card });
const jobsBy = (entries) => new Map(Object.entries(entries));

// new behaviour: a job an earlier coordinator started is forwarded once on each change to blocked, done, error or finished
test('forwardedNotes sends one line per change of a job an earlier coordinator started', () => {
  const before = jobsBy({ t5: forwardJob('42'), t6: forwardJob('43'), t7: forwardJob('44', { status: 'done' }), t8: forwardJob('45') });
  const after = jobsBy({ t5: forwardJob('42', { status: 'blocked', statusMs: 200 }), t6: forwardJob('43', { state: 'finished' }),
    t7: forwardJob('44', { status: 'done', statusMs: 300 }), t8: forwardJob('45', { status: 'error', statusMs: 200 }) });
  assert.deepEqual(forwardedNotes(before, after, 't9').sort(), [
    "Card 42's job t5, started by an earlier coordinator, is blocked. See: hc read t5",
    "Card 43's job t6, started by an earlier coordinator, is finished. See: hc read t6",
    "Card 44's job t7, started by an earlier coordinator, is done. See: hc read t7",
    "Card 45's job t8, started by an earlier coordinator, is error. See: hc read t8",
  ]);
});

// new behaviour: the coordinator's own children keep Herdr's native notes, and a job with no new state is not forwarded again
test('forwardedNotes skips the coordinator own jobs and unchanged ones', () => {
  const before = jobsBy({ t4: forwardJob('41'), t5: forwardJob('42', { parent: 't9' }), t6: forwardJob('43', { status: 'blocked' }),
    t7: forwardJob('44', { status: 'blocked' }), t8: forwardJob('45', { parent: 't9' }) });
  const after = jobsBy({ t4: forwardJob('41', { status: 'done', statusMs: 200 }), t5: forwardJob('42', { parent: 't9', status: 'blocked', statusMs: 200 }),
    t6: forwardJob('43', { status: 'blocked' }), t7: forwardJob('44', { status: 'working', statusMs: 200 }), t8: forwardJob('45', { parent: 't9', state: 'finished' }) });
  assert.deepEqual(forwardedNotes(before, after, 't9'), ["Card 41's job t4, started by an earlier coordinator, is done. See: hc read t4"]);
});

// new behaviour: a card or address the line would carry is checked before it is typed into the coordinator
test('forwardedNotes refuses a record with a malformed card or address', () => {
  assert.throws(() => forwardedNotes(jobsBy({ t5: forwardJob('04') }), jobsBy({ t5: forwardJob('04', { status: 'blocked', statusMs: 200 }) }), 't9'),
    /\bt5\b/);
  assert.throws(() => forwardedNotes(jobsBy({ 'host:t5': forwardJob('42') }),
    jobsBy({ 'host:t5': forwardJob('42', { status: 'blocked', statusMs: 200 }) }), 't9'), /host:t5/);
});

// The `hc get --json` record of card `card`'s job terminal, a child of `parent` in space sp1, live at `status` since
// `statusMs` unless `state` is finished.
const forwardRecord = (card, { parent = 't2', state = 'live', status = 'working', statusMs = 100 } = {}) => ({
  state, pid: 200, argv: ['/usr/bin/env', 'claude'], foreground: { name: 'claude', pid: 201 }, parent,
  status: state === 'live' ? { state: status } : null, status_ms: state === 'live' ? statusMs : null,
  labels: { 'fabraik.role': 'job', 'fabraik.space': 'sp1', 'fabraik.card': card } });

// The first line `hc events --json` prints: Herdr's subscription snapshot, as observed live.
const SUBSCRIPTION_SNAPSHOT = JSON.stringify({ channel: null, seq: 79880, terminals: [] });

// A hc over the job terminals `jobs` holds by address, which a case changes as its events arrive, recording every call:
// `ls` lists the live ones, finished ones too with --all, and each address `twice` holds two times; `get` answers a record;
// `send` answers the codes `sendCodes` gives in order, then 0.
/** @param {Record<string, any>} jobs @param {string[][]} calls @param {number[]} sendCodes @param {Set<string>} twice */
function forwardHc(jobs, calls, sendCodes, twice) {
  return async (args) => {
    calls.push(args);
    if (args[0] === 'ls') {
      const terminals = Object.entries(jobs).filter(([, { state }]) => state === 'live' || args.includes('--all'))
        .flatMap(([address, { state }]) => Array.from({ length: twice.has(address) ? 2 : 1 }, () => ({ address, state })));
      return { code: 0, stdout: JSON.stringify({ terminals }), stderr: '' };
    }
    if (args[0] === 'get' && jobs[args[1]]) return { code: 0, stdout: JSON.stringify({ address: args[1], ...jobs[args[1]] }), stderr: '' };
    if (args[0] === 'send') {
      const code = sendCodes.shift() ?? 0;
      return { code, stdout: '', stderr: code === 9 ? 'blocked' : '' };
    }
    return { code: 1, stdout: '', stderr: `fake hc: unexpected ${args.join(' ')}` };
  };
}

// One forwardNotes run for coordinator t9 in space sp1 over `jobs`. Its event stream gives Herdr's subscription snapshot
// first, then one line per entry of `changes`, each only once the watch has printed forward-ready and after making its
// change; then it ends, or, where `open`, waits with no further line. Without `snapshot` the stream ends before any line.
// `twice` holds the addresses hc ls lists two times. Its exit code, the hc calls, the sends, the printed lines, and `early`:
// each hc call (joined) and printed line made before the snapshot arrived.
/** @param {Record<string, object>} jobs @param {(() => void)[]} changes @param {{ sendCodes?: number[], open?: boolean, snapshot?: boolean, twice?: Set<string> }} [options] */
async function forwarded(jobs, changes, { sendCodes = [], open = false, snapshot = true, twice = new Set() } = {}) {
  const calls = [];
  const said = [];
  const early = [];
  let subscribed = false;
  const { promise: isReady, resolve: ready } = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
  let next = 0;
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (!snapshot) return { done: true, value: undefined };
      if (!subscribed) {
        subscribed = true;
        return { done: false, value: SUBSCRIPTION_SNAPSHOT };
      }
      await isReady;
      if (next < changes.length) {
        changes[next++]();
        return { done: false, value: '{"event":"terminal_status_changed"}' };
      }
      return open ? new Promise(() => {}) : { done: true, value: undefined };
    },
    async return() { return { done: true, value: undefined }; },
  };
  const hc = forwardHc(jobs, calls, sendCodes, twice);
  const code = await forwardNotes({ hc: (args) => {
    if (!subscribed) early.push(args.join(' '));
    return hc(args);
  }, events: () => stream, coordinator: 't9', space: 'sp1',
  print: (line) => {
    if (!subscribed) early.push(line);
    said.push(line);
    if (line.includes('forward-ready')) ready();
  } });
  return { code, calls, sends: calls.filter(([verb]) => verb === 'send'), said: said.join('\n'), early };
}

// new behaviour: a send the blocked coordinator refuses with exit 9 is reported and the watch forwards the next change
test('forwardNotes goes on after a send the blocked coordinator refuses', async () => {
  const jobs = { t5: forwardRecord('42'), t6: forwardRecord('43') };
  const run = await forwarded(jobs, [() => { jobs.t5 = forwardRecord('42', { state: 'finished' }); },
    () => { jobs.t6 = forwardRecord('43', { state: 'finished' }); }], { sendCodes: [9] });
  assert.equal(run.code, 0, run.said);
  assert.deepEqual(run.sends, [
    ['send', 't9', "Card 42's job t5, started by an earlier coordinator, is finished. See: hc read t5"],
    ['send', 't9', "Card 43's job t6, started by an earlier coordinator, is finished. See: hc read t6"],
  ]);
  assert.match(run.said, /not forwarded while the coordinator asks the owner/);
});

// new behaviour: a stream that ends while a job of an earlier coordinator still runs fails loudly, and the baseline sends nothing
test('forwardNotes exits 1 when the event stream ends with a job still running', async () => {
  const run = await forwarded({ t5: forwardRecord('42', { status: 'blocked' }) }, [() => {}]);
  assert.equal(run.code, 1, run.said);
  assert.deepEqual(run.sends, []);
  assert.match(run.said, /hc events ended/);
});

// new behaviour: the watch ends by itself once only the coordinator's own jobs run, without waiting for the stream to end
test('forwardNotes exits 0 once no job of an earlier coordinator is running', async () => {
  const jobs = { t5: forwardRecord('42'), t7: forwardRecord('44', { parent: 't9' }) };
  const run = await forwarded(jobs, [() => { jobs.t5 = forwardRecord('42', { state: 'finished' }); }], { open: true });
  assert.equal(run.code, 0, run.said);
  assert.deepEqual(run.sends, [['send', 't9', "Card 42's job t5, started by an earlier coordinator, is finished. See: hc read t5"]]);
  assert.match(run.said, /forward-ready/);
});

// new behaviour: the watch makes its baseline read and shows forward-ready only once Herdr's subscription snapshot has arrived
test('forwardNotes reads its baseline and shows forward-ready only after Herdr\'s subscription snapshot', async () => {
  const jobs = { t5: forwardRecord('42') };
  const run = await forwarded(jobs, [() => { jobs.t5 = forwardRecord('42', { state: 'finished' }); }]);
  assert.equal(run.code, 0, run.said);
  assert.deepEqual(run.early, [], 'no read and no forward-ready before the snapshot');
  assert.match(run.said, /^forward-ready$/m);
  assert.deepEqual(run.sends, [['send', 't9', "Card 42's job t5, started by an earlier coordinator, is finished. See: hc read t5"]]);
});

// new behaviour: the snapshot line is the subscription, not a change, so it starts no second read of the jobs
test('forwardNotes takes the subscription snapshot as no cue to read the jobs again', async () => {
  const run = await forwarded({ t5: forwardRecord('42', { status: 'blocked' }) }, []);
  assert.equal(run.code, 1, run.said);
  assert.equal(run.calls.filter(([verb]) => verb === 'ls').length, 1, 'only the baseline read lists the jobs');
  assert.deepEqual(run.sends, []);
});

// new behaviour: a stream that ends before Herdr's snapshot fails loudly with no baseline read and no forward-ready
test('forwardNotes exits 1 with no baseline read when the stream ends before Herdr\'s snapshot', async () => {
  const run = await forwarded({ t5: forwardRecord('42', { status: 'blocked' }) }, [], { snapshot: false });
  assert.equal(run.code, 1, run.said);
  assert.deepEqual(run.calls, [], 'no hc ls, get or send');
  assert.doesNotMatch(run.said, /forward-ready/);
});

// new behaviour: a job record whose state or parent Herdr cannot produce stops the watch, naming the job, and sends nothing
test('forwardNotes refuses a job record whose state or parent Herdr cannot produce', async () => {
  const blocked = forwardRecord('42', { status: 'blocked', statusMs: 200 });
  for (const [label, record] of /** @type {[string, object][]} */ ([['state running', forwardRecord('42', { state: 'running' })],
    ['remote parent', { ...blocked, parent: 'host:t3' }], ['null parent', { ...blocked, parent: null }],
    ['numeric parent', { ...blocked, parent: 3 }], ['no parent', { ...blocked, parent: undefined }]])) {
    const jobs = /** @type {Record<string, object>} */ ({ t5: forwardRecord('42') });
    const run = await forwarded(jobs, [() => { jobs.t5 = record; }]);
    assert.equal(run.code, 1, `${label}: ${run.said}`);
    assert.match(run.said, /\bt5\b/, label);
    assert.deepEqual(run.sends, [], label);
  }
});

// new behaviour: a job listing that names one address twice stops the watch, naming the address, and sends nothing
test('forwardNotes refuses a job listing that names the same address twice', async () => {
  const jobs = { t5: forwardRecord('42') };
  const twice = new Set();
  const run = await forwarded(jobs, [() => {
    jobs.t5 = forwardRecord('42', { state: 'finished' });
    twice.add('t5');
  }], { twice });
  assert.equal(run.code, 1, run.said);
  assert.match(run.said, /\bt5\b/);
  assert.deepEqual(run.sends, []);
});

// The forward-watch wire listing: the project space with its Coordinator tab holding t9.
const forwardListing = (name, folder) => ({ spaces: [{ ...space('sp1', name, [], null, folder), tabs: [{ id: 'tbc', name: 'Coordinator', terminals: [{ terminal: 't9' }] }] }] });

// new behaviour: the forward-watch command reads only Herdr and types one line into the coordinator
test('ANTI-REGRESSION: forwarding an earlier coordinator job notes makes no tracker request', (t) => {
  if (NO_EXTENSIONLESS_FAKES) return t.skip(NO_EXTENSIONLESS_FAKES);
  const { calls, run } = wireFixture(t, { listing: forwardListing, hc: {
    events: `${SUBSCRIPTION_SNAPSHOT}\n{"event":"terminal_status_changed"}\n`,
    ls: [JSON.stringify({ terminals: [{ address: 't5', state: 'live' }] }), JSON.stringify({ terminals: [{ address: 't5', state: 'finished' }] })],
    'get:t5:--json': [JSON.stringify({ address: 't5', ...forwardRecord('42') }), JSON.stringify({ address: 't5', ...forwardRecord('42', { state: 'finished' }) })],
  } });
  const watched = run(['forward-watch', '--coordinator', 't9', '--space', 'sp1']);
  assert.equal(watched.status, 0, watched.stdout + watched.stderr);
  assert.match(watched.stdout, /^forward-ready$/m);
  assert.deepEqual(calls().filter(({ tool }) => tool === 'gh'), [], 'no gh call');
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'git' && args[0] === 'fetch'), [], 'no fetch');
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'events').map(({ args }) => args),
    [['events', '--label', 'fabraik.role=job', '--label', 'fabraik.space=sp1', '--json']]);
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'send').map(({ args }) => args),
    [['send', 't9', "Card 42's job t5, started by an earlier coordinator, is finished. See: hc read t5"]]);
});

// new behaviour: forward-watch refuses a malformed operand shape with exit 2 and its usage, before any call
test('forward-watch with malformed operands prints usage and calls nothing', (t) => {
  const { calls, run } = wireFixture(t, { listing: forwardListing });
  for (const operands of [[], ['--coordinator', 't9'], ['--space', 'sp1'], ['--coordinator', 'host:t9', '--space', 'sp1'],
    ['--coordinator', 't9', '--space', 'sp1', 'extra'], ['--coordinator', 't9', '--space']]) {
    const refused = run(['forward-watch', ...operands]);
    assert.equal(refused.status, 2, `${operands.join(' ')}: ${refused.stdout}${refused.stderr}`);
    assert.ok(refused.stderr.includes('forward-watch --coordinator <address> --space <space id>'), refused.stderr);
  }
  assert.deepEqual(calls(), []);
});

// A jobFixture for the coordinator `coordinator` (t1 unless given) of space spproject1, whose tabs are `tabs`, holding `jobs`:
// each a job terminal of card `card`, a child of `parent`, `working` unless finished; and `forwarders`: each a note forwarder
// terminal, a child of `parent`, live or finished with `exit`, labelled `herdr.tab=<tab>` where it names a `tab`. `ls` and `get`
// both carry each terminal's parent and state. `forward` runs from `coordinator` unless its options say otherwise.
/** @param {{ coordinator?: string, tabs?: [string, string][], jobs?: { address: string, card: number, parent: string, state?: string }[], forwarders?: { address: string, parent: string, state?: string, exit?: number | null, tab?: string }[] }} options */
function forwardFixture({ coordinator = 't1', tabs = [['tb1', '1']], jobs = [], forwarders = [] }) {
  const fixture = jobFixture({ spaces: [space('spproject1', 'fabraik', tabs, null, ROOT)], pages: READY_BOARD() });
  const record = fixture.details.t0;
  delete fixture.details.t0;
  fixture.details[coordinator] = { ...record, address: coordinator };
  fixture.coordinatorAddresses = [coordinator];
  const forward = fixture.forward;
  fixture.forward = (options = {}) => forward({ parent: coordinator, ...options });
  for (const { address, card, parent, state = 'live' } of jobs) {
    fixture.addJob(address, card, 'claude', 'working');
    Object.assign(fixture.terminals[fixture.terminals.length - 1], { parent, state });
    Object.assign(fixture.details[address], { parent, state, status_ms: 100 });
    if (state !== 'live') Object.assign(fixture.details[address], { status: null, status_ms: null, exit_code: 0, reason: 'exited' });
  }
  for (const { address, parent, state = 'finished', exit = 0, tab } of forwarders) {
    const finished = state === 'finished' ? { exit_code: exit, reason: 'exited' } : { exit_code: null };
    fixture.terminals.push({ address, name: `${parent}-notes`, parent, state, ...finished });
    fixture.details[address] = { address, name: `${parent}-notes`, state, parent, pid: 300, argv: [process.execPath], foreground: { name: 'node', pid: 300 },
      status: null, ...finished, labels: { 'fabraik.role': 'forwarder', 'fabraik.space': 'spproject1', ...(tab ? { 'herdr.tab': tab } : {}) } };
  }
  return fixture;
}

// new behaviour: with only the coordinator's own jobs live, forward closes the tab of the finished forwarder it removes, and only
// that job notes tab, and starts none
test('forward starts nothing when no job of an earlier coordinator runs', async () => {
  const fixture = forwardFixture({ tabs: [['tb1', '1'], ['tbnotes', 'job notes'], ['tbother', 'job notes']],
    jobs: [{ address: 't4', card: 41, parent: 't1' }, { address: 't5', card: 42, parent: 't3', state: 'finished' }],
    forwarders: [{ address: 't6', parent: 't1', exit: 0, tab: 'tbnotes' }] });
  assert.equal(await fixture.forward(), 0, fixture.lines.join('\n'));
  assert.equal(fixture.lines.at(-1), 'No job of an earlier coordinator is running.');
  assert.deepEqual(fixture.runs(), []);
  assert.deepEqual(fixture.calls.filter(([verb]) => verb === 'rm'), [['rm', 't6']]);
  assert.equal(fixture.app.filter(([, command, ...rest]) => command === 'tab.close' && rest.includes('tbnotes')).length, 1, 'the job notes tab is closed');
  assert.ok(!fixture.app.some(([, command, ...rest]) => command === 'tab.close' && rest.includes('tbother')), 'a job notes tab no removed forwarder names stays open');
  assert.ok(!fixture.app.some(([, command]) => command === 'tab.new'), 'no tab is opened');
});

// new behaviour: a live job of an earlier coordinator starts one notifying forwarder, the coordinator's child, in tab job notes
test('forward starts the watch in the job notes tab as a child of the coordinator', async () => {
  const fixture = forwardFixture({ jobs: [{ address: 't5', card: 42, parent: 't3' }] });
  fixture.replies['read t10'] = { code: 0, stdout: 'forward-ready\n', stderr: '' };
  assert.equal(await fixture.forward(), 0, fixture.lines.join('\n'));
  const [created] = fixture.app.filter(([, command]) => command === 'tab.new');
  assert.deepEqual(flagsOf(created), { space: 'spproject1', name: 'job notes', folder: ROOT, focus: 'false', mod: 'help' });
  assert.deepEqual(fixture.runs(), [['run', '--bg', '--parent', 't1', '--name', 't1-notes', '--cwd', ROOT,
    '--label', 'herdr.space=spproject1', '--label', 'herdr.tab=tb-job-notes', '--label', 'fabraik.role=forwarder', '--label', 'fabraik.space=spproject1',
    '--json', '--', process.execPath, join(ROOT, 'scripts', 'coordinator.mjs'), 'forward-watch', '--coordinator', 't1', '--space', 'spproject1']]);
  for (const flag of ['--no-notify', '--keep', '--outlive-parent']) assert.ok(!fixture.runs()[0].includes(flag), `the run carries no ${flag}`);
  assert.equal(fixture.helpPanes.size, 0, 'the Help pane is closed once the watch is adopted');
  assert.deepEqual(fixture.calls.filter(([verb]) => verb === 'read').at(-1), ['read', 't10', '--lines', '5']);
});

// new behaviour: forward refuses before any change unless HC_TERMINAL_ID is the sole running Claude or Codex Coordinator
test('forward refuses when it is not run from the sole coordinator', async () => {
  const other = forwardFixture({ jobs: [{ address: 't5', card: 42, parent: 't3' }] });
  const twin = forwardFixture({ jobs: [{ address: 't5', card: 42, parent: 't3' }] });
  twin.coordinatorAddresses = ['t1', 't8'];
  twin.details.t8 = { ...liveRecord({ foregroundPid: 100 }), address: 't8', cwd: ROOT };
  for (const [label, fixture, parent] of /** @type {const} */ ([['another terminal', other, 't7'], ['a second coordinator', twin, 't1'], ['no terminal', other, undefined]])) {
    fixture.lines.length = 0;
    assert.equal(await fixture.forward({ parent }), 1, label);
    assert.match(fixture.lines.join('\n'), /HC_TERMINAL_ID/, label);
    assert.deepEqual(fixture.calls.filter(([verb]) => ['run', 'rm', 'send', 'kill'].includes(verb)), [], label);
    assert.ok(!fixture.app.some(([verb]) => verb === 'do'), `${label} changes no tab`);
  }
});

// new behaviour: the coordinator's own forwarder that stopped with a failure is reported, kept for reading, and not replaced
test('forward reports a stopped forwarder and starts none', async () => {
  const fixture = forwardFixture({ tabs: [['tb1', '1'], ['tbnotes', 'job notes']], jobs: [{ address: 't5', card: 42, parent: 't3' }],
    forwarders: [{ address: 't6', parent: 't1', exit: 1 }] });
  const lastLine = 'Job notes stopped: hc events ended while a job of an earlier coordinator is still running.';
  fixture.replies['read t6'] = { code: 0, stdout: `forward-ready\n${lastLine}\n`, stderr: '' };
  assert.equal(await fixture.forward(), 1, fixture.lines.join('\n'));
  const said = fixture.lines.join('\n');
  assert.ok(said.includes(lastLine), said);
  assert.match(said, /\bexit\b[^\n]*\b1\b/i, 'its exit is printed');
  assert.deepEqual(fixture.runs(), []);
  assert.deepEqual(fixture.calls.filter(([verb]) => verb === 'rm' || verb === 'kill'), [], 'the stopped forwarder is kept');
});

// new behaviour: a watch that never prints forward-ready fails the start and stays visible for the coordinator to read
test('forward fails when the watch never shows forward-ready', async () => {
  const fixture = forwardFixture({ jobs: [{ address: 't5', card: 42, parent: 't3' }] });
  fixture.replies['read t10'] = { code: 0, stdout: 'Job notes stopped: hc ls could not list the job terminals: exit 1\n', stderr: '' };
  assert.equal(await fixture.forward(), 1, fixture.lines.join('\n'));
  assert.ok(fixture.lines.length > 0, 'the failure is printed');
  assert.equal(fixture.runs().length, 1);
  assert.deepEqual(fixture.calls.filter(([verb]) => verb === 'read'), Array.from({ length: 50 }, () => ['read', 't10', '--lines', '5']));
  assert.deepEqual(fixture.calls.filter(([verb]) => verb === 'rm' || verb === 'kill'), [], 'the watch terminal is left visible');
});

// new behaviour: a coordinator address Herdr cannot give is refused before any change, even from the sole coordinator
test('forward refuses a coordinator address that is no local Herdr terminal', async () => {
  const fixture = forwardFixture({ coordinator: 't0', tabs: [['tb1', '1'], ['tbnotes', 'job notes']], jobs: [{ address: 't5', card: 42, parent: 't3' }],
    forwarders: [{ address: 't6', parent: 't3', exit: 0 }] });
  fixture.replies['read t10'] = { code: 0, stdout: 'forward-ready\n', stderr: '' };
  assert.equal(await fixture.forward(), 1, fixture.lines.join('\n'));
  assert.match(fixture.lines.join('\n'), /HC_TERMINAL_ID/);
  assert.deepEqual(fixture.calls.filter(([verb]) => ['run', 'rm', 'send', 'kill'].includes(verb)), []);
  assert.ok(!fixture.app.some(([verb]) => verb === 'do'), 'it changes no tab');
});

// new behaviour: the forward-watch operands forward launches are accepted by the real command, so the watch starts past its usage
test('forward launches a forward-watch the real command accepts', async (t) => {
  const fixture = forwardFixture({ jobs: [{ address: 't5', card: 42, parent: 't3' }] });
  fixture.replies['read t10'] = { code: 0, stdout: 'forward-ready\n', stderr: '' };
  assert.equal(await fixture.forward(), 0, fixture.lines.join('\n'));
  const [launched] = fixture.runs();
  const watch = launched.slice(launched.indexOf('--') + 3);
  assert.equal(watch[0], 'forward-watch');
  if (NO_EXTENSIONLESS_FAKES) return t.skip(NO_EXTENSIONLESS_FAKES);
  const { run } = wireFixture(t, { listing: forwardListing, hc: { events: `${SUBSCRIPTION_SNAPSHOT}\n`, ls: JSON.stringify({ terminals: [] }) } });
  const watched = run(watch);
  assert.equal(watched.status, 0, watched.stdout + watched.stderr);
  assert.ok(!watched.stderr.includes('forward-watch --coordinator <address>'), watched.stderr);
  assert.match(watched.stdout, /^No job of an earlier coordinator is running\.$/m);
});

// Card 5's job underway: its branch job/5 exists and its card is In progress, with no comment and no draft pull request.
const CARD_5_UNDERWAY = {
  repository: { branches: [5], worktrees: [] },
  tracker: { nodes: [issue(5, { status: 'In progress' })], comments: {}, drafts: [] },
  listing: (name, folder) => ({ spaces: [withCoordinator(space('spproject1', name, [['tb1', '1'], ['tbjob5', 'job 5']], null, folder))] }),
};
const WIRE_COORDINATOR_GET = { 'get:t0:--json': JSON.stringify({ ...liveRecord({ foregroundPid: 100 }), address: 't0' }) };

test('929 admits only a known versioned native Codex install', async (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const requireVersionedCodex = Reflect.get(await import('./coordinator.mjs'), 'requireVersionedCodex');
  assert.equal(typeof requireVersionedCodex, 'function', 'version-addressed mise Codex installation verifier is unavailable');

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-mise-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = '0.173.0-alpha.4';
  const installs = join(root, 'mise', 'installs', 'codex');
  const releaseDir = join(installs, release);
  const makeCodex = (folder) => {
    const executable = join(folder, 'bin', 'codex');
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, '', { mode: 0o755 });
    return executable;
  };
  const executable = makeCodex(releaseDir);
  const lookedUp = [];
  assert.equal(requireVersionedCodex(executable, (requestedRelease) => {
    lookedUp.push(requestedRelease);
    return releaseDir;
  }), undefined);
  assert.deepEqual(lookedUp, [release], 'mise must be asked for the concrete release');

  const fixed = makeCodex(join(root, 'fixed'));
  const foreign = makeCodex(join(root, 'foreign', release));
  const otherRelease = join(installs, '0.173.0-alpha.3');
  makeCodex(otherRelease);
  const alias = join(root, 'alias', release);
  mkdirSync(dirname(alias));
  symlinkSync(releaseDir, alias);
  const missing = join(root, 'missing', release);
  const unavailable = /version-addressed mise Codex installation/;
  assert.throws(() => requireVersionedCodex(fixed, () => releaseDir), unavailable, 'fixed path');
  assert.throws(() => requireVersionedCodex(foreign, () => releaseDir), unavailable, 'same release at a foreign path');
  assert.throws(() => requireVersionedCodex(executable, () => otherRelease), unavailable, 'lookup reports a different release');
  assert.throws(() => requireVersionedCodex(join(alias, 'bin', 'codex'), () => releaseDir), unavailable, 'symlink release path');
  assert.throws(() => requireVersionedCodex(executable, () => alias), unavailable, 'lookup reports a symlink release directory');
  assert.throws(() => requireVersionedCodex(join(missing, 'bin', 'codex'), () => missing), unavailable, 'nonexistent install');
  assert.throws(() => requireVersionedCodex(executable, () => { throw new Error('release unavailable'); }), unavailable, 'missing lookup');
});

// existing behaviour
test('967 holds real Codex child launch until the Bash guard is verified', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const bash = 'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/block-unsafe-git.mjs"';
  const hookConfig = '.codex/hooks.json';
  const rows = (root) => {
    const projectSource = join(root, hookConfig);
    return [
      { key: `${projectSource}:pre_tool_use:0:0`, eventName: 'preToolUse', command: bash, matcher: 'Bash', sourcePath: projectSource,
        source: 'project', currentHash: 'sha256:0fec215ff240b47cd1bbb60855b6aa0d637329ec0ba48b01696af90fa5d615bc' },
    ].map((hook, displayOrder) => ({ ...hook, handlerType: 'command', async: false, timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
      pluginId: null, environmentId: null, displayOrder, enabled: true, isManaged: false, trustStatus: 'trusted' }));
  };
  /** @param {(root: string) => unknown} [result] */
  const fixture = (result = (root) => ({ data: [{ cwd: root, hooks: rows(root), errors: [] }] })) => {
    const hc = { ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [] }), run: JSON.stringify({ address: 't10' }) };
    const made = wireFixture(t, { hc, codexHooks: result, text: settingsText({ runtimes: ['claude', 'codex'], coordinator: { runtime: 'claude' } }),
      tracker: { nodes: [issue(5)], comments: {}, drafts: [] },
      listing: (name, root) => {
        hc['get:t0:--json'] = JSON.stringify({ ...liveRecord({ foreground: 'codex',
          argv: ['/usr/bin/env', 'codex', '--no-daemon'], foregroundPid: 100 }), address: 't0', cwd: root,
          status: { app: 'codex', state: 'working' } });
        return { spaces: [withCoordinator(space('spproject1', name, [['tbjob5', 'job 5']], null, root))] };
      } });
    const files = {
      [hookConfig]: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: bash }] }] } }),
      '.codex/hooks/block-unsafe-git.mjs': 'export {};\n',
    };
    const entries = Object.entries(files).map(([path, contents]) => {
      const file = join(made.root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      return { path, sha256: createHash('sha256').update(contents).digest('hex') };
    });
    mkdirSync(join(made.root, '.agents'), { recursive: true });
    writeFileSync(join(made.root, '.agents', 'factory-manifest.json'), JSON.stringify({ canonical: 'example-owner/example-repo', entries }));
    return made;
  };
  const start = (made) => made.run(['start', '5', '--login', 'octocat'], { HC_TERMINAL_ID: 't0' });
  const isGitHubRead = (args) => args.join(' ') === 'api rate_limit' || args.join(' ') === 'api user --jq .login'
    || (args[0] === 'pr' && args[1] === 'list')
    || (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => /^query=query[ (]/.test(arg)));
  const isMutation = ({ tool, args }) => (tool === 'herdr-app' && args[0] !== 'ls')
    || (tool === 'hc' && !['ls', 'get'].includes(args[0]))
    || (tool === 'gh' && !isGitHubRead(args));
  const callsOfInterest = (made) => made.calls().filter((call) => ['codex', 'codex-rpc'].includes(call.tool) || isMutation(call));
  const assertRead = (made, calls, label) => {
    const [launch, initialize, initialized, list] = calls;
    assert.deepEqual(launch, { tool: 'codex', args: ['app-server', '--listen', 'stdio://'], cwd: made.root }, label);
    assert.ok(!launch.args.some((arg) => /request_user_input|fabraik-codex-delivery|hooks\.(?:Pre|Post)ToolUse/.test(arg)), `${label}: no delivery hook flag`);
    assert.deepEqual([initialize, initialized, list].map((call) => call?.message?.method), ['initialize', 'initialized', 'hooks/list'], label);
    assert.match(initialize.message.params.clientInfo.name, /^fabraik\b/i, label);
    assert.equal(initialize.message.params.capabilities.experimentalApi, true, label);
    assert.equal(initialized.message.id, undefined, label);
    assert.deepEqual(list.message.params, { cwds: [made.root] }, label);
  };

  const trusted = fixture();
  const held = start(trusted);
  const calls = callsOfInterest(trusted);
  assertRead(trusted, calls, 'the native hook inventory is read with no delivery hook flag');
  const output = held.stdout + held.stderr;
  assert.equal(held.status, 1, output);
  // The fixture executable is a script. Its responding process runs Node, so a valid inventory cannot establish Codex identity.
  assert.match(output, /^(?=.*\bnative Codex executable\b)(?=.*\bidentity\b)(?=.*\b(?:unverified|could not|cannot|failed)\b)/im);
  assert.deepEqual(calls.slice(4), [], 'trusted registrations hold before any Herdr or GitHub mutation');

  const report = (change) => (root) => ({ data: [{ cwd: root, hooks: change(rows(root)), errors: [] }] });
  // Each cause names only its own refusal, so none can pass on the later executable identity refusal.
  /** @type {[string, (root: string) => unknown, RegExp][]} */
  const rejected = [
    ['missing Bash guard', report(() => []), /hooks\/list reported 0 registrations for the project Bash guard/],
    ['untrusted Bash guard', report(([guard]) => [{ ...guard, trustStatus: 'untrusted' }]), /\bis untrusted\b/],
    // Only the guard's own check refuses an enabled managed guard; the prompting check passes a managed registration.
    ['managed Bash guard', report(([guard]) => [{ ...guard, trustStatus: 'managed' }]), /the project Bash guard is managed\b/],
    // Only the prompting check refuses a trusted guard beside another enabled registration awaiting review.
    ['modified second registration', report(([guard]) => [guard, { ...guard, key: guard.key.replace(':pre_tool_use:', ':post_tool_use:'),
      eventName: 'postToolUse', displayOrder: 1, trustStatus: 'modified' }]), /enabled registration [^\n]*:post_tool_use:0:0 is modified\b/],
    ['malformed hook row', report(([guard]) => [{ ...guard, async: null }]), /the project Bash guard differs from the required registration/],
    ['foreign project result', (root) => ({ data: [{ cwd: dirname(root), hooks: rows(root), errors: [] }] }),
      /hooks\/list did not report exactly the integration root/],
    ['app-server process failure', () => null, /app-server exited with code 1/],
  ];
  for (const [label, result, cause] of rejected) {
    const refused = fixture(result);
    const held = start(refused);
    assert.equal(held.status, 1, `${label}: ${held.stdout}${held.stderr}`);
    assert.match(held.stdout + held.stderr, cause, label);
    assert.doesNotMatch(held.stdout + held.stderr, /native Codex executable[^\n]*identity/, `${label}: not the identity refusal`);
    const calls = callsOfInterest(refused);
    assertRead(refused, calls, label);
    assert.deepEqual(calls.slice(4), [], `${label} holds before any Herdr or GitHub mutation`);
  }
});

test('coordinator command starts an unfinished job through the hc on PATH under its run mark', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { root, main, calls, run } = wireFixture(t, { ...CARD_5_UNDERWAY,
    hc: { ...WIRE_COORDINATOR_GET, ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [] }), run: JSON.stringify({ address: 't10' }) } });
  const started = run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0' });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const hcCalls = calls().filter(({ tool }) => tool === 'hc').map(({ args }) => args[0]);
  assert.ok(hcCalls.indexOf('ls') !== -1 && hcCalls.indexOf('ls') < hcCalls.indexOf('run'), `hc ls precedes hc run: ${hcCalls}`);
  const runs = calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'run');
  assert.equal(runs.length, 1);
  const { args } = runs[0];
  const labels = Object.fromEntries(args.flatMap((word, i) => (args[i - 1] === '--label' ? [word.split('=')] : [])));
  const runStart = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  assert.match(labels['fabraik.runstart'], runStart);
  assert.match(labels['fabraik.session'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(args[args.indexOf('--session-id') + 1], labels['fabraik.session']);
  assert.equal(labels['fabraik.card'], '5');
  assert.equal(labels['herdr.tab'], 'tbjob5');
  assert.equal(labels['fabraik.workflow'], main);
  const command = args.slice(args.indexOf('--') + 1);
  assert.deepEqual(command.slice(0, command.indexOf('claude')), ['/usr/bin/env', `PRE_APPROVED_RUN_SESSION=${labels['fabraik.runstart']}`, 'PRE_APPROVED_RUN_CARD=5',
    'FABRAIK_COORDINATED_JOB=1', pinMark(root, main), 'ANTHROPIC_MODEL=sonnet', 'CLAUDE_CODE_EFFORT_LEVEL=high']);
  assert.equal(command.at(-1), JOB_PROMPT(5));
  assert.ok(args.includes('--keep'), 'the session is kept');
});

test('coordinator command starts the job at the settings model and effort whatever its environment holds', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const hc = { ...WIRE_COORDINATOR_GET, ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [] }), run: JSON.stringify({ address: 't10' }) };
  const modelOf = (calls) => calls().find(({ tool, args }) => tool === 'hc' && args[0] === 'run').args.filter((word) => /^(ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL)=/.test(word));

  // The settings name sonnet at high: a coordinator environment of haiku at low changes nothing.
  const named = wireFixture(t, { ...CARD_5_UNDERWAY, hc });
  const overridden = named.run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0', ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'low' });
  assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
  assert.deepEqual(modelOf(named.calls), ['ANTHROPIC_MODEL=sonnet', 'CLAUDE_CODE_EFFORT_LEVEL=high']);

  // The settings name no coordinator and the environment holds neither variable: the default opus at medium starts.
  const bare = wireFixture(t, { ...CARD_5_UNDERWAY, hc, text: settingsText() });
  const defaulted = bare.run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0' });
  assert.equal(defaulted.status, 0, defaulted.stdout + defaulted.stderr);
  assert.deepEqual(modelOf(bare.calls), ['ANTHROPIC_MODEL=opus', 'CLAUDE_CODE_EFFORT_LEVEL=medium']);
});

test('coordinator command refuses a start whose coordinator setting cannot be read, names the fault and opens nothing', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  const { calls, run } = wireFixture(t, { listing: (name, folder) => ({ spaces: [space('spproject1', name, [['tb1', '1']], null, folder)] }),
    text: settingsText({ coordinator: { model: 'sonnet', effort: 'extreme' } }) });
  const refused = run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0' });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /Card 5 not started: .*coordinator\.effort/);
  assert.ok(!calls().some(({ tool, args }) => (tool === 'hc' && args[0] === 'run') || (tool === 'herdr-app' && args[1] === 'tab.new')), 'nothing is opened');
});

test('coordinator command refuses a job whose session cannot be resumed and starts nothing', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // Card 5's resume failed (S1, v); its record keeps good labels, but the fixture's home holds no transcript of its session.
  const { entry, record } = keptTerminal('t11', 5, 'finished');
  const { calls, run } = wireFixture(t, { ...CARD_5_UNDERWAY,
    hc: { ...WIRE_COORDINATOR_GET, ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [entry] }), get: JSON.stringify(record), run: JSON.stringify({ address: 't20' }) } });
  const refused = run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0' });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const [, cause] = refused.stdout.trim().match(unresumable(5, KEPT_SESSION, 't11')) ?? [];
  assert.ok(cause, `the refusal line: ${refused.stdout}`);
  assert.match(cause, /transcript/i);
  assert.deepEqual(calls().filter(({ tool, args }) => tool === 'hc' && ['kill', 'run', 'rm'].includes(args[0])), [], 'nothing is ended, launched or removed');
});

test('coordinator command resumes a session whose transcript is a regular file and refuses one that is a symbolic link', (t) => {
  if (OFF_LINUX) return t.skip(OFF_LINUX);
  // The real transcript lookup reads {CLAUDE_CONFIG_DIR}/projects/*/{session}.jsonl; the fixture's recovered record holds only a shell.
  /** @type {[string, boolean, boolean][]} */
  const transcripts = [['a regular file', false, true], ['a symbolic link', true, false]];
  for (const [label, link, resumed] of transcripts) {
    const { entry, record } = keptTerminal('t11', 5, 'live');
    const { calls, run } = wireFixture(t, { ...CARD_5_UNDERWAY,
      // Its replacement t20 carries the record's labels and local main as its workflow version.
      hc: (main) => ({ ...WIRE_COORDINATOR_GET, ls: JSON.stringify({ hidden_finished: 0, machines: [], terminals: [entry] }), get: JSON.stringify(record),
        'get:t20:--json': JSON.stringify({ ...record, address: 't20', labels: workflowLabels(main) }), run: JSON.stringify({ address: 't20' }) }) });
    const config = mkdtempSync(join(tmpdir(), 'coordinator-config-'));
    t.after(() => rmSync(config, { recursive: true, force: true }));
    const project = join(config, 'projects', 'any-project');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${KEPT_SESSION}.jsonl`);
    if (link) {
      writeFileSync(join(config, 'elsewhere.jsonl'), '{}\n');
      symlinkSync(join(config, 'elsewhere.jsonl'), transcript);
    } else {
      writeFileSync(transcript, '{}\n');
    }
    const started = run(['start', '5', '--login', 'owner'], { HC_TERMINAL_ID: 't0', CLAUDE_CONFIG_DIR: config });
    const runs = calls().filter(({ tool, args }) => tool === 'hc' && args[0] === 'run');
    if (resumed) {
      assert.equal(started.status, 0, `${label}: ${started.stdout}${started.stderr}`);
      assert.equal(runs.length, 1, label);
      assert.equal(runs[0].args[runs[0].args.indexOf('--resume') + 1], KEPT_SESSION, `${label} resumes the recorded session`);
      assert.match(started.stdout, /is resuming session/, label);
    } else {
      assert.equal(started.status, 1, `${label}: ${started.stdout}${started.stderr}`);
      const [, cause] = started.stdout.trim().match(unresumable(5, KEPT_SESSION, 't11')) ?? [];
      assert.ok(cause, `${label} prints the refusal line: ${started.stdout}`);
      assert.match(cause, /symbolic link/i, `${label} names its cause`);
      assert.deepEqual(runs, [], `${label} launches nothing`);
    }
  }
});

test('the resume skill names the job prompt the coordinator sends', () => {
  const skill = readFileSync(join(SCRIPTS, '..', '.agents', 'skills', 'resume', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(`\`${jobPrompt('<N>')}\``), `SKILL.md names the job prompt ${jobPrompt('<N>')} in backticks`);
});

// new behaviour: Windows has no /usr/bin/env, so the job tab runs the coordinator command's launch-job with the same marks and claude arguments
test('on Windows a job starts in a tab that runs the launch-job command with the job marks', async (t) => {
  const root = fabraikRepository(t);
  const project = withCoordinator(space('spproject1', 'fabraik', [['tb1', '1']], null, `${root.toUpperCase()}/`));
  const job = jobFixture({ root, spaces: [project], pages: READY_BOARD() });
  job.details.t0 = { ...WINDOWS_RUNNING, address: 't0' };
  assert.equal(await job.start(5, { platform: 'win32' }), 0, job.lines.join('\n'));
  // Git prints the profile's long name where the temporary folder may hold its 8.3 short one, and the pinned root is built from git's.
  const common = pinGit(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const linux = jobRunArgs('fabraik-job-5', 5, 'tb-job-5', root).map((word) => word.startsWith('FABRAIK_WORKFLOW_ROOT=')
    ? `FABRAIK_WORKFLOW_ROOT=${join(common, 'fabraik-workflow', pinGit(root, 'rev-parse', 'refs/heads/main'))}` : word);
  const env = linux.indexOf('/usr/bin/env');
  assert.deepEqual(job.runs(), [[...linux.slice(0, env), process.execPath, win32.join(root, 'scripts', 'coordinator.mjs'), 'launch-job', ...linux.slice(env + 1)]]);
  assert.equal(job.helpPanes.size, 0);
});

test('the launch-job command starts claude with the job marks in its environment', { skip: process.platform === 'win32' && 'the fake claude is a POSIX shell script' }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'launch-job-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "A=$A B=$B"\necho "args=$*"\nexit 7\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const run = spawnSync(process.execPath, [COMMAND, 'launch-job', 'A=1', 'B=2', 'claude', '--x', 'y'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(run.stdout, 'A=1 B=2\nargs=--x y\n', run.stderr);
  assert.equal(run.status, 7);
});
