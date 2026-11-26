// merge-watch.test.mjs: the merge watch's exit contract and required-check rules, and the draft wait's exit contract,
// through the fake-gh seam.
//
// Merge watch scenarios run `main` with an in-memory ghExec, a fake clock, an in-memory event route whose waits move
// that clock to the next scripted event or deadline, and a recording sleep the merge watch must leave unused; the
// draft wait still sleeps, and its sleep returns at once. The pull-request
// form's argument contract and terminal success/failure cases run the real command as a subprocess with the same fake
// replies, over a fake gh whose `webhook forward` starts a fake extension child. The draft wait also has positive,
// provenance-refusal and credential-diagnostic process cases in fresh Git
// repositories, isolated from machine and environment Git configuration.
// The cloud draft case also runs under an injected URL rewrite.
// The event route runs `openEventRoute` in memory with a scripted forwarder, an injected process table and process
// ender, a fake clock and a temporary record folder; its five wire cases run it in Node over that fake gh, and read
// the real process table (`ps`, or PowerShell on Windows), one of them recovering from a crashed run with the real
// process ender. One more wire case stops the command with SIGTERM.
//
// Recurring cost: no subprocess for in-memory scenarios, and one temporary record folder per in-memory route case; CLI
// wire proofs start Node for the command and each faked gh call, with no network, and the pull-request form's also
// start the fake extension child and read the process table. The three draft wire cases initialize Git repositories.
// The six event-route wire cases each start Node, the fake gh and its extension child, and read the process table; the
// recovery case starts Node twice. The pinned cleanup case initializes one Git repository with a worktree, writes its
// commit's snapshot, and starts the command twice from that snapshot.
// Removal condition: retire with scripts/merge-watch.mjs, and the draft-wait tests with its `--draft` mode.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { installFakeGh } from './fake-gh.mjs';
import { presentRuntimes } from './runtimes.mjs';
import { repairWorkflowSnapshot, workflowStore } from './workflow-pin.mjs';
// A namespace import, so a missing export fails where it is called rather than when the file loads.
import * as watchLib from './merge-watch.mjs';
import { main } from '../merge-watch.mjs';

const CLI = fileURLToPath(new URL('../merge-watch.mjs', import.meta.url));
const USAGE = 'usage: node scripts/merge-watch.mjs <pull-request-number> | --draft job/<issue>';

// Each state-view call advances the scenario; checks, workflow runs and jobs use that step and the last step repeats.
// A reply is [exit code, body]. Rules preserve gh's pagination/slurp behavior, and both paths refuse missing arguments.
function scenarioReply(args, scenario) {
  const refuse = (why) => [99, 'fake gh: ' + why + ': ' + args.join(' ')];
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (args.includes('--jq')) return refuse('the fake applies no --jq');
  if (scenario.draft) {
    // This function is serialized into fake-gh, so its command oracle cannot use the outer test constants.
    const expectedRepo = ['repo', 'view', '--json', 'id', '--', scenario.draft.origin];
    const expectedList = ['pr', 'list', '--repo', scenario.draft.origin, '--head', 'job/7', '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository'];
    if (JSON.stringify(args) === JSON.stringify(expectedRepo)) return [0, '{"id":"R_origin"}'];
    if (JSON.stringify(args) === JSON.stringify(expectedList)) return scenario.draft.reply;
    return refuse('draft read was not bound to origin');
  }
  const step = (n) => scenario.steps[Math.min(n, scenario.steps.length) - 1];
  if (args[0] === 'pr') {
    if (!args.includes('7')) return refuse('<pr> was not passed');
    if (args[1] === 'view' && flag('--json') === 'baseRefName') return scenario.base;
    const fields = args[1] === 'view' ? (flag('--json') ?? '').split(',') : [];
    if (['state', 'mergeStateStatus', 'headRefOid'].every((field) => fields.includes(field)) && fields.every((field) => ['state', 'mergeStateStatus', 'headRefOid', 'autoMergeRequest'].includes(field))) {
      scenario.n += 1;
      const [code, body] = step(scenario.n).view;
      if (code !== 0) return [code, body];
      // Real gh returns only the fields asked for.
      return [code, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(body)).filter(([field]) => fields.includes(field))))];
    }
    if (args[1] === 'checks' && args.includes('--required') && flag('--json') === 'name,bucket,link') {
      return step(scenario.n).checks;
    }
    return refuse('unexpected pr call');
  }
  if (args[0] === 'api') {
    if (args.includes('rate_limit')) return [0, JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 5000, reset: 0 } } })];
    const path = args.find((arg) => arg.startsWith('repos/'));
    if (!path || !path.startsWith('repos/{owner}/{repo}/')) return refuse('api path without repos/{owner}/{repo}/');
    if (path === 'repos/{owner}/{repo}/branches/trunk') return scenario.branch;
    if (path === 'repos/{owner}/{repo}/rules/branches/trunk') {
      const [code, pages] = scenario.rules;
      if (code !== 0) return scenario.rules;
      if (!args.includes('--paginate')) return [0, JSON.stringify(pages[0])];
      return [0, args.includes('--slurp') ? JSON.stringify(pages) : pages.map((page) => JSON.stringify(page)).join('')];
    }
    // The stall reads: the pull request's timeline, the head commit's workflow runs and a run's jobs, each paged.
    const paged = args.includes('--paginate') && args.includes('--slurp');
    const stallRead = (reply) => (paged ? reply : refuse('a stall read was not paginated and slurped'));
    if (path === 'repos/{owner}/{repo}/issues/7/timeline?per_page=100') return stallRead(scenario.timeline);
    if (/^repos\/\{owner\}\/\{repo\}\/actions\/runs\?head_sha=[0-9a-f]{40}&per_page=100$/.test(path)) {
      return stallRead(step(scenario.n).runs);
    }
    if (/^repos\/\{owner\}\/\{repo\}\/actions\/runs\/\d+\/jobs\?per_page=100$/.test(path)) return stallRead(step(scenario.n).jobs);
    if (path.startsWith('repos/{owner}/{repo}/actions/')) {
      return scenario.actions[path.slice('repos/{owner}/{repo}/actions/'.length)] ?? refuse('unknown actions path');
    }
    return refuse('the base branch was not substituted');
  }
  return refuse('unexpected gh call');
}

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_HEAD = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';

const view = (state, mergeStateStatus, headRefOid = HEAD, autoMergeRequest = /** @type {unknown} */ (null)) => [0, JSON.stringify({ state, mergeStateStatus, headRefOid, autoMergeRequest })];
const checks = (byName) => [0, JSON.stringify(Object.entries(byName).map(([name, bucket]) => ({ name, bucket })))];

const OPEN_BLOCKED = view('OPEN', 'BLOCKED');
const QUEUED = { enabledAt: '2026-01-01T10:00:00Z', mergeMethod: 'SQUASH' };
const MERGED = { view: view('MERGED', 'CLEAN'), checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) };

// The stall reads' replies: GitHub's `--paginate --slurp` pages of the head's workflow runs and a run's jobs.
const RUN_CREATED = '2026-01-01T10:01:00Z';
const runsReply = (...items) => [0, JSON.stringify([{ workflow_runs: items }])];
const workflowRun = (id, status, created_at = RUN_CREATED) => ({ id, status, created_at });
const jobsReply = (...items) => [0, JSON.stringify([{ jobs: items }])];
const testJob = (overrides = {}) => ({ id: 901, name: 'test (linux)', status: 'queued', runner_name: null, labels: ['self-hosted', 'linux'], ...overrides });

// A pass with required checks pending, so the watch waits; `runs` and `jobs` default to a finished run on the head,
// whose jobs nobody reads. A pass with no required check reported is the one the no-run clock runs on.
const PENDING = checks({ test: 'pending', 'sweep-scope': 'pending' });
const UNREPORTED = [1, "no required checks reported on the 'job/7' branch"];
const NO_RUNS = runsReply();
const NO_RUN_PASS = { view: OPEN_BLOCKED, checks: UNREPORTED, runs: NO_RUNS };
// Checks pending on a run in progress whose job has its runner, so no stall clock runs and the watch waits with no
// deadline; and the same pass while GitHub has not yet worked out whether the pull request can merge.
const CHECKS_RUNNING = {
  view: OPEN_BLOCKED,
  checks: PENDING,
  runs: runsReply(workflowRun(501, 'in_progress')),
  jobs: jobsReply(testJob({ status: 'in_progress', runner_name: 'runner-1' })),
};
const UNKNOWN_RUNNING = { ...CHECKS_RUNNING, view: view('OPEN', 'UNKNOWN') };

// The base branch requires `classic` through classic protection and `ruled` through a ruleset; the default union is
// split across the two sources so dropping either read shows. The rules come as two pages, the ruleset's checks on
// page two so reading page one alone shows; `extraRules` joins page two. `branch` or `rules` replaces that read's
// reply, and `base` the base-branch read's. `actions` maps a path under `actions/` to its reply. A step's `runs` and
// `jobs` replace that pass's workflow run and job replies. `timeline` replaces the pull request timeline's reply, which
// defaults to one page with no event, a pull request that was never a draft.
/**
 * @typedef {{ classic?: string[], ruled?: string[], extraRules?: object[], base?: unknown[], branch?: unknown[], rules?: unknown[],
 *   actions?: Record<string, unknown[]>, draft?: { origin: string, reply: unknown[] }, timeline?: unknown[] }} ScenarioOptions
 */
/** @param {object[]} steps @param {ScenarioOptions} [options] */
function createScenario(steps, { classic = ['test'], ruled = ['sweep-scope'], extraRules = [], base, branch, rules, actions = {}, draft, timeline } = {}) {
  return {
    steps: steps.map((step) => ({ runs: runsReply(workflowRun(501, 'completed')), jobs: jobsReply(), ...step })),
    draft,
    timeline: timeline ?? [0, JSON.stringify([[]])],
    n: 0,
    actions,
    base: base ?? [0, JSON.stringify({ baseRefName: 'trunk' })],
    branch: branch ?? [0, JSON.stringify({ protection: { required_status_checks: { contexts: classic } } })],
    rules: rules ?? [0, [
      [{ type: 'pull_request', parameters: {} }],
      [
        { type: 'required_status_checks', parameters: { required_status_checks: ruled.map((context) => ({ context })) } },
        ...extraRules,
      ],
    ]],
  };
}

// A scenario folder for the fake gh, holding the fake extension its `webhook forward` runs.
function writeScenario(steps, options) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-watch-scenario-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(createScenario(steps, options)));
  writeFileSync(join(dir, 'n'), '0');
  writeFileSync(join(dir, 'calls'), '');
  mkdirSync(join(dir, 'gh-webhook'));
  writeFileSync(join(dir, 'gh-webhook', 'gh-webhook.cjs'), EXTENSION_SCRIPT);
  return dir;
}

function readCalls(dir) {
  return readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function callKind([group, command, ...rest]) {
  if (group === 'pr' && command === 'view') return rest.includes('baseRefName') ? 'base' : 'view';
  if (group === 'pr' && command === 'checks') return 'checks';
  if (group === 'api' && command === 'rate_limit') return 'rate_limit';
  const apiPath = group === 'api' ? [command, ...rest].find((arg) => arg.startsWith('repos/')) ?? '' : '';
  if (apiPath.endsWith('/timeline?per_page=100')) return 'timeline';
  if (apiPath.includes('/actions/runs?head_sha=')) return 'runs';
  if (apiPath.endsWith('/jobs?per_page=100')) return 'jobs';
  if (group === 'api' && [command, ...rest].some((arg) => arg.startsWith('repos/{owner}/{repo}/actions/'))) return 'actions';
  if (group === 'api') return [command, ...rest].some((arg) => arg.includes('/rules/branches/')) ? 'rules' : 'branch';
  return 'other';
}

const WRITE_FLAG = /^(-X|--method|-f|--raw-field|-F|--field|--input)(=|$)|^-[XfF]./;

// Reads only: pull request/repository queries, or an `api` GET carrying no method, field or body flag.
function readsOnly(call) {
  const [group, command] = call;
  return (group === 'pr' && (command === 'view' || command === 'checks' || command === 'list'))
    || (group === 'repo' && command === 'view')
    || (group === 'api' && !call.some((arg) => WRITE_FLAG.test(arg)));
}

function assertReadOnly(calls) {
  for (const call of calls) {
    assert.ok(readsOnly(call), `the watch must only read GitHub state, but called: gh ${call.join(' ')}`);
  }
}

// Webhook payload bodies as a forward's stdout line carries them, shaped after GitHub's webhook payload reference; the
// ping's top-level keys are those the trial recorded.
const MIN = 60_000;
const SENDER = { repository: { id: 1, full_name: 'owner/repo' }, sender: { login: 'owner', type: 'User' } };
const PING_EVENT = {
  zen: 'Responsive is better than fast.',
  hook_id: 81,
  hook: { type: 'Repository', id: 81, name: 'cli', active: true, events: ['check_run', 'pull_request', 'push', 'status', 'workflow_job'] },
  ...SENDER,
};
const pullRequestEvent = (number, action = 'synchronize') => ({
  action,
  number,
  pull_request: { number, state: action === 'closed' ? 'closed' : 'open', merged: action === 'closed', head: { ref: 'job/7', sha: HEAD }, base: { ref: 'trunk' } },
  ...SENDER,
});
const checkRunEvent = (action, head_sha) => ({
  action,
  check_run: { id: 61, name: 'test', head_sha, status: action === 'completed' ? 'completed' : 'queued', conclusion: action === 'completed' ? 'failure' : null, pull_requests: [{ number: 7 }] },
  ...SENDER,
});
const workflowJobEvent = (action, head_sha) => ({
  action,
  workflow_job: { id: 901, run_id: 501, head_sha, name: 'test (linux)', status: action, labels: ['self-hosted', 'linux'], runner_name: null },
  ...SENDER,
});
const pushEvent = (ref) => ({ ref, before: OTHER_HEAD, after: HEAD, created: false, deleted: false, forced: false, commits: [], head_commit: null, ...SENDER });
const statusEvent = (sha) => ({ id: 71, sha, name: 'owner/repo', context: 'ci/legacy', state: 'success', target_url: null, branches: [], commit: { sha }, ...SENDER });
const PR_EVENT = pullRequestEvent(7);

// The in-memory route's scripts: no event in an hour, and no event in ten minutes, after which the route ends.
const SILENCE = { arrivals: [] };
const TEN_SILENT_MINUTES = { arrivals: [], endAt: 10 * MIN };
const ROUTE_ENDED = 'the GitHub event route stopped: the scripted silence ran out; run the watch again';
const START_CLOCK = 1_700_000_000_000;

// Runs the command in-process against the scenario. The fake clock starts at an arbitrary moment and moves only to
// where a wait on the event route ends: `events.arrivals` are [offset in ms, payload] pairs, judged relevant by the
// library's own `isRelevantEvent` against the context the watch passes, and an irrelevant one is passed over; a wait
// whose `deadline` (an absolute time on the clock) comes before the next event ends there, while an event at or before a
// due deadline is taken first, as the route takes a queued event first; with neither, the
// route ends at `events.endAt`, an hour by default. Without `events` a relevant event arrives every 30 seconds, so each
// wait ends in the next pass. Each pull request read moves the clock on by `viewTakes` ms, none by default. A sleep or
// wait past the hundredth means the watch never stopped. With `held`, the armed head of a held Claude delivery, it
// runs `watchMerge` itself on the same route, given that head as `coordinated.head`, as the held delivery passes it.
/** @typedef {{ arrivals: [number, object][], endAt?: number }} WatchEvents */
/** @param {object[]} steps @param {ScenarioOptions & { events?: WatchEvents, viewTakes?: number, held?: string }} [options] */
async function watch(steps, { events, viewTakes = 0, held, ...options } = {}) {
  const scenario = createScenario(steps, options);
  const calls = [];
  const callTimes = [];
  let clock = START_CLOCK;
  const ghExec = (args) => {
    calls.push(args);
    callTimes.push(clock - START_CLOCK);
    if (callKind(args) === 'view') clock += viewTakes;
    const [code, body] = scenarioReply(args, scenario);
    if (code === 0) return body + '\n';
    throw Object.assign(new Error(body), { status: code, stdout: '', stderr: body + '\n' });
  };
  const lines = [];
  const sleeps = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
    if (sleeps.length > 100) throw new Error('the watch did not stop');
  };
  const queue = events ? [...events.arrivals].sort((a, b) => a[0] - b[0]) : undefined;
  const endAt = events?.endAt ?? 60 * MIN;
  let nextDefault = 30_000;
  const wakes = [];
  const nextWake = async ({ deadline, context }) => {
    const wait = { at: clock - START_CLOCK, deadline: typeof deadline === 'number' ? deadline - START_CLOCK : undefined, context };
    wakes.push(wait);
    if (wakes.length > 100) throw new Error('the watch did not stop');
    for (;;) {
      const [arrival, payload] = queue ? (queue[0] ?? [Infinity]) : [nextDefault, PR_EVENT];
      // As the route does, an event that has arrived by the time a deadline is due is taken before that deadline.
      const eventFirst = arrival <= endAt && (wait.deadline === undefined || arrival <= Math.max(clock - START_CLOCK, wait.deadline));
      if (!eventFirst && wait.deadline !== undefined && wait.deadline <= endAt) {
        clock = Math.max(clock, START_CLOCK + wait.deadline);
        wait.wake = 'deadline';
        return { wake: 'deadline' };
      }
      if (arrival > endAt) {
        clock = Math.max(clock, START_CLOCK + endAt);
        wait.wake = 'ended';
        return { wake: 'ended', reason: ROUTE_ENDED };
      }
      if (queue) queue.shift();
      else nextDefault += 30_000;
      clock = Math.max(clock, START_CLOCK + arrival);
      if (watchLib.isRelevantEvent(payload, context)) {
        wait.wake = 'event';
        return { wake: 'event' };
      }
    }
  };
  let closes = 0;
  const openRoute = async () => ({ nextWake, close: async () => { closes += 1; } });
  let status;
  if (held === undefined) {
    status = await main(['7'], { ghExec, output, sleep, now: () => clock, openRoute });
  } else {
    const coordinated = { repo: 'owner/repo', beforeForward: async () => {}, head: held };
    const watchOptions = { pr: '7', ghExec, now: () => clock, nextWake, coordinated };
    const { exitCode, reason } = await watchLib.watchMerge(watchOptions);
    status = exitCode;
    lines.push(reason);
  }
  assertReadOnly(calls);
  const viewTimes = callTimes.filter((_, index) => callKind(calls[index]) === 'view');
  return {
    status, lines, last: lines.at(-1), sleeps, wakes, closes, calls, callTimes, viewTimes,
    stoppedAt: clock - START_CLOCK, reads: viewTimes.length,
  };
}

const deadlinesOf = (run) => run.wakes.map((wait) => wait.deadline);

// What every event wait holds: the timer stays unused, and the route is closed once when the watch stops.
function assertWaitedOnEvents(run, label = 'the watch') {
  assert.deepEqual(run.sleeps, [], `${label} must make no read on a timer`);
  assert.equal(run.closes, 1, `${label} must close its event route once when it stops`);
}

function runCli(args, steps = [MERGED], options) {
  const dir = writeScenario(steps, options);
  // The draft wait reads origin through git, so no machine-wide config and no config injected through the
  // environment, such as a cloud platform's url.<base>.insteadOf rewrite, may change the URL it reads. The pull
  // request form opens its event route over the same fake gh, with its record in the scenario folder.
  const env = routeGh.env(
    {
      MERGE_WATCH_SCENARIO: dir,
      XDG_STATE_HOME: join(dir, 'state'),
      GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
      GIT_CONFIG_NOSYSTEM: '1',
      ...(options?.draft ? { GH_REPO: 'foreign/elsewhere' } : {}),
    },
    ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'],
  );
  if (options?.draft) {
    for (const gitArgs of [['init', '--quiet'], ['remote', 'add', 'origin', options.draft.origin]]) {
      const setup = spawnSync('git', gitArgs, { cwd: dir, encoding: 'utf8', env });
      assert.equal(setup.status, 0, setup.stderr || setup.error?.message || 'git setup failed with no output');
    }
  }
  const run = spawnSync(process.execPath, [CLI, ...args], {
    ...(options?.draft ? { cwd: dir } : {}),
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  const calls = readCalls(dir);
  rmSync(dir, { recursive: true, force: true });
  for (const call of calls.filter((call) => call[0] === 'webhook')) assert.deepEqual(call, FORWARD_ARGS, 'the one forward is on the watched repository');
  assertOwnHookWrites(calls.filter((call) => call[0] !== 'webhook'), [WIRE_HOOK_ID]);
  return { ...run, calls, lastOut: run.stdout.trimEnd().split('\n').at(-1) };
}

test('merge-watch exits 2 with its usage before any gh call for a missing, non-numeric or extra argument, or any flag outside the draft form', () => {
  for (const args of [[], ['seven'], ['7x'], ['0'], ['7', '8'], ['--help'], ['-7'], ['7', '--interval=1'], ['--repo', '7']]) {
    const run = runCli(args);
    assert.equal(run.status, 2, `${JSON.stringify(args)} must exit 2; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.stderr.trimEnd().split('\n').at(-1), USAGE, `${JSON.stringify(args)} must print the usage last`);
    assert.equal(run.stdout, '');
    assert.deepEqual(run.calls, [], `${JSON.stringify(args)} must make no gh call`);
  }
});

test('merge-watch as a process exits 0 printing merged last, and 1 printing the reason last on a closed pull request or a gh failure', () => {
  const merged = runCli(['7']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(merged.lastOut, 'merged');

  const closed = runCli(['7'], [{ view: view('CLOSED', 'CLEAN'), checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) }]);
  assert.equal(closed.status, 1, closed.stderr);
  assert.equal(closed.lastOut, 'closed without merging');

  const auth = runCli(['7'], [{ view: [4, 'To get started with GitHub CLI, please run:  gh auth login'], checks: checks({}) }]);
  assert.equal(auth.status, 1, auth.stderr);
  assert.equal(auth.lastOut, 'To get started with GitHub CLI, please run:  gh auth login');
  const failedAt = auth.calls.findLastIndex((call) => callKind(call) === 'view');
  assert.ok(
    failedAt >= 0 && auth.calls.slice(failedAt + 1).every(isHookList),
    `the command must make no read after the failing view but its event route's own hook list, the rate-limit probe included: ${JSON.stringify(auth.calls)}`,
  );
});

test('the watch exits 1 the moment gh itself fails, with the gh error as its last line', async () => {
  const auth = await watch([{ view: [4, 'To get started with GitHub CLI, please run:  gh auth login'], checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) }]);
  assert.equal(auth.status, 1, 'an authentication failure must stop the wait');
  assert.equal(auth.reads, 1, 'an authentication failure must stop on the first read');
  assert.equal(auth.last, 'To get started with GitHub CLI, please run:  gh auth login');

  const network = await watch([
    { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) },
    { view: OPEN_BLOCKED, checks: [1, 'error connecting to api.github.com'] },
  ]);
  assert.equal(network.status, 1, 'a network failure while reading checks must stop the wait');
  assert.equal(network.reads, 2);
  assert.equal(network.last, 'error connecting to api.github.com', 'the gh error must be printed as the reason');
});

test('terminal pull request state stops before check-status read even when it would fail', async () => {
  const failingChecks = [1, 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'];
  for (const [state, status, reason] of [
    ['MERGED', 0, 'merged'],
    ['CLOSED', 1, 'closed without merging'],
  ]) {
    const terminal = await watch([{ view: view(state, 'CLEAN'), checks: failingChecks }]);
    assert.equal(terminal.status, status, `${state} must determine the exit status`);
    assert.equal(terminal.last, reason, `${state} must determine the last line`);
    assert.equal(terminal.reads, 1, `${state} must stop after one PR state read`);
    assert.equal(terminal.calls.filter((call) => callKind(call) === 'checks').length, 0, `${state} must not read checks`);
    assert.deepEqual(terminal.wakes, [], `${state} must not wait`);
  }
});

test('the watch makes exactly one attempt at the gh call that fails, and no gh call of any kind after it', async () => {
  const error = [1, 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'];
  const pending = { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) };
  for (const [kind, steps, options] of /** @type {[string, object[], ScenarioOptions][]} */ ([
    ['base', [MERGED], { base: error }],
    ['branch', [MERGED], { branch: error }],
    ['rules', [MERGED], { rules: error }],
    ['view', [{ ...pending, view: error }], {}],
    ['checks', [{ ...pending, checks: error }], {}],
  ])) {
    const failed = await watch(steps, options);
    assert.equal(failed.status, 1, `a failing ${kind} read must stop the wait`);
    assert.equal(failed.last, error[1], `a failing ${kind} read must print gh's error last`);
    assert.equal(failed.wakes.length, 0, `a failing ${kind} read must not wait and try again`);
    const kinds = failed.calls.map(callKind);
    assert.equal(kinds.filter((k) => k === kind).length, 1, `a failing ${kind} read must be attempted once`);
    assert.equal(kinds.at(-1), kind, `nothing may be read after the failing ${kind} read, the rate-limit probe included`);
  }
});

test('the watch stops on a failed required check, a dirty or behind merge, or a closed pull request, even while checks are pending', async () => {
  const failed = await watch([{ view: OPEN_BLOCKED, checks: checks({ test: 'fail', 'sweep-scope': 'pending' }) }, MERGED]);
  assert.equal(failed.status, 1);
  assert.equal(failed.reads, 1, 'a failed check must stop before the next read');
  assert.equal(failed.last, 'a required check failed: fail pending');

  for (const status of ['DIRTY', 'BEHIND']) {
    const blocked = await watch([{ view: view('OPEN', status), checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
    assert.equal(blocked.status, 1, `${status} must stop the wait`);
    assert.equal(blocked.reads, 1, `${status} must stop before the next read`);
    assert.equal(blocked.last, `merge blocked: OPEN ${status}`);
  }

  const closed = await watch([{ view: view('CLOSED', 'CLEAN'), checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
  assert.equal(closed.status, 1, 'a closed pull request must stop the wait');
  assert.equal(closed.reads, 1);
  assert.equal(closed.last, 'closed without merging');
});

test('the watch keeps waiting through BLOCKED while required checks are pending or unreported, and stops on BLOCKED once they have all finished', async () => {
  const pending = await watch([
    { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pass' }) },
    { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pass' }) },
    MERGED,
  ]);
  assert.equal(pending.status, 0, 'BLOCKED with a pending required check must not stop the wait');
  assert.equal(pending.reads, 3, 'the wait must read again after each pending pass');
  assert.equal(pending.last, 'merged');

  const unreported = await watch([
    { view: OPEN_BLOCKED, checks: [1, "no required checks reported on the 'job/7' branch"] },
    { view: OPEN_BLOCKED, checks: [1, "no checks reported on the 'job/7' branch"] },
    MERGED,
  ]);
  assert.equal(unreported.status, 0, 'a required check not yet reported must not stop the wait');
  assert.equal(unreported.reads, 3);

  const finished = await watch([{ view: OPEN_BLOCKED, checks: checks({ test: 'pass', 'sweep-scope': 'skipping' }) }, MERGED]);
  assert.equal(finished.status, 1, 'BLOCKED with every required check finished must stop the wait');
  assert.equal(finished.reads, 1);
  assert.equal(finished.last, 'merge blocked with every required check finished: OPEN BLOCKED pass skipping');
});

test('the watch keeps waiting through BLOCKED while a required check from either source has not yet appeared', async () => {
  for (const partial of [{ 'sweep-scope': 'pass' }, { test: 'pass' }]) {
    const waiting = await watch([
      { view: OPEN_BLOCKED, checks: checks(partial) },
      { view: OPEN_BLOCKED, checks: checks({ 'sweep-scope': 'pass', test: 'pending' }) },
      MERGED,
    ]);
    assert.equal(waiting.status, 0, `BLOCKED with only ${Object.keys(partial)} reported must not stop the wait`);
    assert.equal(waiting.reads, 3);
    assert.equal(waiting.last, 'merged');
  }
});

test('the watch keeps waiting on a failed required check while a newer unfinished run of the same workflow on the same head will report it again', async () => {
  const staleFailure = [0, JSON.stringify([
    { name: 'test', bucket: 'fail', link: 'https://github.com/owner/repo/actions/runs/41/job/77' },
    { name: 'sweep-scope', bucket: 'pass', link: 'https://github.com/owner/repo/actions/runs/52/job/78' },
  ])];
  for (const status of ['requested', 'queued', 'pending', 'waiting', 'in_progress']) {
    const superseded = await watch(
      [
        { view: OPEN_BLOCKED, checks: staleFailure },
        { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pass' }) },
        MERGED,
      ],
      {
        actions: {
          'runs/41': [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: HEAD })],
          [`workflows/9/runs?head_sha=${HEAD}`]: [0, JSON.stringify({
            workflow_runs: [{ run_number: 5, status }, { run_number: 4, status: 'completed' }],
          })],
        },
      },
    );
    assert.equal(superseded.last, 'merged', `a failure superseded by a ${status} run must not stop the wait`);
    assert.equal(superseded.status, 0);
    assert.deepEqual(
      superseded.calls.filter((call) => callKind(call) === 'actions'),
      [['api', 'repos/{owner}/{repo}/actions/runs/41'], ['api', `repos/{owner}/{repo}/actions/workflows/9/runs?head_sha=${HEAD}`]],
      'the failed check must be judged by its own run, then by its workflow\'s runs on that head',
    );
  }
});

test('a failed required check still stops the watch when no newer unfinished run of its own workflow exists', async () => {
  const testLink = 'https://github.com/owner/repo/actions/runs/41/job/77';
  const sweepLink = 'https://github.com/owner/repo/actions/runs/52/job/78';
  const failedTest = (link) => [
    { name: 'test', bucket: 'fail', ...(link === undefined ? {} : { link }) },
    { name: 'sweep-scope', bucket: 'pass', link: sweepLink },
  ];
  // The failed `test` check's own run is run number 4 of workflow 9; `runs` is that workflow's list on the head.
  const testRuns = (runs) => ({
    'runs/41': [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: HEAD })],
    [`workflows/9/runs?head_sha=${HEAD}`]: [0, JSON.stringify({ workflow_runs: runs })],
  });
  const sweepRuns = {
    'runs/52': [0, JSON.stringify({ workflow_id: 12, run_number: 8, head_sha: HEAD })],
    [`workflows/12/runs?head_sha=${HEAD}`]: [0, JSON.stringify({ workflow_runs: [{ run_number: 8, status: 'completed' }] })],
  };
  for (const [label, rows, actions, reason] of /** @type {[string, object[], Record<string, unknown[]> | undefined, string][]} */ ([
    ['only its own run, completed', failedTest(testLink), testRuns([{ run_number: 4, status: 'completed' }]), 'a required check failed: fail pass'],
    ['its own run still in progress', failedTest(testLink), testRuns([{ run_number: 4, status: 'in_progress' }]), 'a required check failed: fail pass'],
    ['a newer run that completed', failedTest(testLink), testRuns([{ run_number: 5, status: 'completed' }, { run_number: 4, status: 'completed' }]), 'a required check failed: fail pass'],
    ['an older run in progress', failedTest(testLink), testRuns([{ run_number: 4, status: 'completed' }, { run_number: 3, status: 'in_progress' }]), 'a required check failed: fail pass'],
    ['a link outside Actions', failedTest('https://ci.example.com/builds/41'), undefined, 'a required check failed: fail pass'],
    ['no link at all', failedTest(undefined), undefined, 'a required check failed: fail pass'],
    [
      'a superseded test beside a failed sweep-scope whose own run is not superseded',
      [{ name: 'test', bucket: 'fail', link: testLink }, { name: 'sweep-scope', bucket: 'fail', link: sweepLink }],
      { ...testRuns([{ run_number: 5, status: 'in_progress' }, { run_number: 4, status: 'completed' }]), ...sweepRuns },
      'a required check failed: unreported fail',
    ],
  ])) {
    const failed = await watch([{ view: OPEN_BLOCKED, checks: [0, JSON.stringify(rows)] }, MERGED], { actions });
    assert.equal(failed.last, reason, `${label} must print the failure as the last line`);
    assert.equal(failed.status, 1, `${label} must stop the wait`);
    assert.equal(failed.reads, 1, `${label} must stop on the first pass`);
    assert.deepEqual(failed.wakes, [], `${label} must not wait and read again`);
    if (actions === undefined) {
      assert.equal(failed.calls.filter((call) => callKind(call) === 'actions').length, 0, `${label} must read no workflow run`);
    }
  }
});

test('the watch exits 1 on its first pass when a workflow run reply it needs cannot be read', async () => {
  const failedTest = [0, JSON.stringify([
    { name: 'test', bucket: 'fail', link: 'https://github.com/owner/repo/actions/runs/41/job/77' },
    { name: 'sweep-scope', bucket: 'pass', link: 'https://github.com/owner/repo/actions/runs/52/job/78' },
  ])];
  const runRead = ['api', 'repos/{owner}/{repo}/actions/runs/41'];
  const listRead = ['api', `repos/{owner}/{repo}/actions/workflows/9/runs?head_sha=${HEAD}`];
  const readableRun = [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: HEAD })];
  const badGateway = [1, 'HTTP 502: Bad Gateway (https://api.github.com/repos/owner/repo/actions/runs/41)'];
  // A run list the watch must refuse, given as the JSON GitHub would send so the reason quotes it back exactly.
  const unreadableList = (label, runs) => [
    label,
    { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${HEAD}`]: [0, `{"workflow_runs":${runs}}`] },
    `unreadable workflow runs: ${runs}`,
    [runRead, listRead],
  ];
  for (const [label, actions, reason, reads] of [
    ['a run reply without its fields', { 'runs/41': [0, '{}'] }, 'unreadable workflow run 41: {}', [runRead]],
    [
      'a run reply whose head is a branch name',
      { 'runs/41': [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: 'main' })] },
      'unreadable workflow run 41: {"workflow_id":9,"run_number":4,"head_sha":"main"}',
      [runRead],
    ],
    [
      'a run list reply without its list',
      { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${HEAD}`]: [0, '{}'] },
      'unreadable workflow runs: null',
      [runRead, listRead],
    ],
    [
      'a run list that is not a list',
      { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${HEAD}`]: [0, JSON.stringify({ workflow_runs: {} })] },
      'unreadable workflow runs: {}',
      [runRead, listRead],
    ],
    unreadableList('a run list entry without a run number', '[{"status":"queued"}]'),
    unreadableList('a run list entry whose run number is a string', '[{"run_number":"5","status":"queued"}]'),
    unreadableList('a null entry after a newer queued run', '[{"run_number":5,"status":"queued"},null]'),
    unreadableList('a null entry before a newer queued run', '[null,{"run_number":5,"status":"queued"}]'),
    unreadableList('a run list entry without a status', '[{"run_number":5}]'),
    unreadableList('a newer run whose status is null', '[{"run_number":5,"status":null},{"run_number":4,"status":"completed"}]'),
    ['a gh failure on the run read',{ 'runs/41': badGateway }, badGateway[1], [runRead]],
  ]) {
    const unreadable = await watch([{ view: OPEN_BLOCKED, checks: failedTest }, MERGED], { actions });
    assert.equal(unreadable.last, reason, `${label} must print its reason as the last line`);
    assert.equal(unreadable.status, 1, `${label} must stop the wait`);
    assert.equal(unreadable.reads, 1, `${label} must stop on the first pass`);
    assert.deepEqual(unreadable.wakes, [], `${label} must not wait and read again`);
    assert.deepEqual(unreadable.calls.filter((call) => callKind(call) === 'actions'), reads, `${label} must make no further workflow run read`);
    assert.equal(callKind(unreadable.calls.at(-1)), 'actions', `nothing may be read after ${label}`);
  }
});

test('the watch exits 1 before its first read when the required set cannot be read', async () => {
  const forbidden = [1, 'gh: Resource not accessible by integration (HTTP 403)'];
  for (const source of ['branch', 'rules']) {
    const unreadable = await watch([MERGED], { [source]: forbidden });
    assert.equal(unreadable.status, 1, `an unreadable ${source} read must stop the wait`);
    assert.equal(unreadable.reads, 0, `an unreadable ${source} read must stop before the first read`);
    assert.equal(unreadable.last, forbidden[1], 'the gh error must reach the session');
  }
});

test('the watch stops before its first read when a ruleset requires checks it does not name', async () => {
  for (const rule of [
    { type: 'workflows', parameters: { workflows: [{ path: '.github/workflows/<workflow>.yml', repository_id: 1 }] } },
    { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL', security_alerts_threshold: 'high_or_higher', alerts_threshold: 'errors' }] } },
  ]) {
    const unnamed = await watch([MERGED], { extraRules: [rule] });
    assert.equal(unnamed.status, 1, `a ${rule.type} rule must stop the wait`);
    assert.equal(unnamed.reads, 0, `a ${rule.type} rule must stop before the first read`);
    assert.equal(
      unnamed.last,
      `a ruleset requires checks it does not name, so the full required set is unknown: ["sweep-scope",{"unnamed":"${rule.type}"}]`,
    );
  }
});

test('the watch exits 1 before its first read when a present required-check list cannot be read', async () => {
  const noContexts = { protection: { required_status_checks: { strict: true } } };
  const namelessRule = { type: 'required_status_checks', parameters: { required_status_checks: [{ integration_id: 1 }] } };
  const listlessRule = { type: 'required_status_checks', parameters: {} };
  const emptyNameRule = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: '' }] } };
  const flatPages = [{ type: 'pull_request', parameters: {} }];
  for (const [options, reason] of /** @type {[ScenarioOptions, string][]} */ ([
    [{ branch: [0, JSON.stringify(noContexts)] }, 'unreadable required set: classic required_status_checks {"strict":true}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: 'test' } } })] }, 'unreadable required set: classic required_status_checks {"contexts":"test"}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: [null] } } })] }, 'unreadable required set: classic required_status_checks {"contexts":[null]}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: ['', 'test'] } } })] }, 'unreadable required set: classic required_status_checks {"contexts":["","test"]}'],
    [{ extraRules: [namelessRule] }, `unreadable required set: rule ${JSON.stringify(namelessRule)}`],
    [{ extraRules: [listlessRule] }, `unreadable required set: rule ${JSON.stringify(listlessRule)}`],
    [{ extraRules: [emptyNameRule] }, `unreadable required set: rule ${JSON.stringify(emptyNameRule)}`],
    [{ rules: [0, flatPages] }, `unreadable required set: rules ${JSON.stringify(flatPages)}`],
  ])) {
    const unreadable = await watch([MERGED], options);
    assert.equal(unreadable.status, 1, `${reason} must stop the wait`);
    assert.equal(unreadable.reads, 0, `${reason} must stop before the first read`);
    assert.equal(unreadable.wakes.length, 0);
    assert.equal(unreadable.calls.filter((call) => callKind(call) === 'checks').length, 0, `${reason} must make no pr checks call`);
    assert.equal(unreadable.last, reason);
  }
});

test('the watch exits 1 on its first pass when a successful reply carries a pull request state or merge state it does not know', async () => {
  for (const [state, mergeStateStatus] of [[null, null], ['DRAFT', 'CLEAN'], ['OPEN', null], ['OPEN', ''], ['OPEN', 'ALIEN']]) {
    const unreadable = await watch([{ view: view(state, mergeStateStatus), checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
    assert.equal(unreadable.status, 1, `${state} ${mergeStateStatus} must stop the wait`);
    assert.equal(unreadable.reads, 1);
    assert.equal(unreadable.wakes.length, 0, `${state} ${mergeStateStatus} must not wait and read again`);
    assert.equal(unreadable.last, `unreadable pull request state: ${JSON.stringify({ state, mergeStateStatus, headRefOid: HEAD, autoMergeRequest: null })}`);
  }
});

test('the watch exits 1 on its first pass when a successful reply carries an auto-merge state it cannot read', async () => {
  const noKey = [0, JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', headRefOid: HEAD })];
  for (const [bad, autoMergeRequest] of /** @type {[[number, string], unknown][]} */ ([[noKey, undefined], [view('OPEN', 'BLOCKED', HEAD, 'yes'), 'yes'], [view('OPEN', 'BLOCKED', HEAD, []), []]])) {
    const unreadable = await watch([{ view: bad, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
    assert.equal(unreadable.status, 1, `${bad[1]} must stop the wait`);
    assert.equal(unreadable.reads, 1);
    assert.equal(unreadable.last, `unreadable pull request state: ${JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', headRefOid: HEAD, autoMergeRequest })}`);
  }
});

test('the watch exits 1 on its first pass when a required check carries no known bucket or the checks reply is not a list', async () => {
  for (const [reply, reason] of [
    [[{ name: 'test' }, { name: 'sweep-scope', bucket: 'pass' }], 'unreadable bucket on required check "test": null'],
    [[{ name: 'test', bucket: 'pass' }, { name: 'sweep-scope', bucket: 'queued' }], 'unreadable bucket on required check "sweep-scope": "queued"'],
    [{ test: 'pass' }, 'unreadable required checks: {"test":"pass"}'],
  ]) {
    const unreadable = await watch([{ view: OPEN_BLOCKED, checks: [0, JSON.stringify(reply)] }, MERGED]);
    assert.equal(unreadable.status, 1, `${reason} must stop the wait`);
    assert.equal(unreadable.reads, 1);
    assert.equal(unreadable.wakes.length, 0, `${reason} must not wait and read again`);
    assert.equal(unreadable.last, reason);
  }
});

test('the watch stops on BLOCKED at once when the base branch requires no checks', async () => {
  const none = await watch(
    [{ view: OPEN_BLOCKED, checks: [1, "no required checks reported on the 'job/7' branch"] }],
    { classic: [], ruled: [] },
  );
  assert.equal(none.status, 1);
  assert.equal(none.reads, 1);
  assert.equal(none.wakes.length, 0);
  assert.equal(none.last, 'merge blocked with every required check finished: OPEN BLOCKED');
});

// new behaviour: a held Claude delivery's watch, given its armed head, ends 0 once the pull request is open at that head
// with every required check passed or skipped, so the job runs its own pinned merge; it waits through unreported and
// pending checks and makes no merge call, and a failed check, a moved head or a closed pull request ends it 1.
test("967 a held Claude delivery ends at the armed head's passed checks", async () => {
  const PASSED = checks({ test: 'pass', 'sweep-scope': 'skipping' });
  for (const status of ['BLOCKED', 'CLEAN']) {
    const passed = await watch([{ view: view('OPEN', status), checks: PASSED }], { held: HEAD });
    assert.deepEqual([passed.status, passed.last, passed.reads], [0, `required checks passed on ${HEAD}`, 1], status);
    assert.ok(!passed.calls.some(([group, command]) => group === 'pr' && command === 'merge'), `${status}: the watch merges nothing`);
  }

  const waited = await watch([
    { view: OPEN_BLOCKED, checks: UNREPORTED, runs: runsReply(workflowRun(501, 'in_progress')) },
    CHECKS_RUNNING,
    { ...CHECKS_RUNNING, checks: checks({ test: 'pass', 'sweep-scope': 'pending' }) },
    { view: OPEN_BLOCKED, checks: PASSED },
  ], { held: HEAD });
  assert.deepEqual([waited.status, waited.last, waited.reads], [0, `required checks passed on ${HEAD}`, 4], 'it waits for every required check');

  for (const { label, step } of [
    { label: 'a failed required check', step: { view: OPEN_BLOCKED, checks: checks({ test: 'fail', 'sweep-scope': 'pass' }) } },
    { label: 'a moved head', step: { view: view('OPEN', 'BLOCKED', OTHER_HEAD), checks: PASSED } },
    { label: 'a moved head on a clean pull request', step: { view: view('OPEN', 'CLEAN', OTHER_HEAD), checks: PASSED } },
    { label: 'a closed pull request', step: { view: view('CLOSED', 'CLEAN'), checks: PASSED } },
  ]) {
    assert.equal((await watch([step], { held: HEAD })).status, 1, label);
  }
});

test('the watch exits 0 only on MERGED', async () => {
  const merged = await watch([{ view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
  assert.equal(merged.status, 0);
  assert.equal(merged.reads, 2);
  assert.equal(merged.last, 'merged');

  const pending = await watch([{ view: view('MERGED', 'UNKNOWN'), checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }]);
  assert.equal(pending.status, 0, 'MERGED must end the wait even while a required check is pending');
  assert.equal(pending.reads, 1);
  assert.equal(pending.last, 'merged');
});

const NO_RUN_REASON = `no test run has started for ${HEAD} within 10 minutes: mark the pull request as a draft, mark it ready again, then merge it again, since returning to draft cancels any queued merge`;
const runPath = (head) => `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100`;
const countOf = (run, kind) => run.calls.filter((call) => callKind(call) === kind).length;
const RUNNING = { view: OPEN_BLOCKED, checks: UNREPORTED, runs: runsReply(workflowRun(501, 'in_progress')) };
// A relevant event at each of the given minutes, and silence for the rest of the hour.
/** @param {...number} minutes */
const eventsAt = (...minutes) => ({ arrivals: minutes.map((minute) => /** @type {[number, object]} */ ([minute * MIN, PR_EVENT])) });

test('no-run stop: the watch stops 10 minutes after a required check was first unreported with no unfinished run, naming the head and the fix', async () => {
  const stalled = await watch([NO_RUN_PASS], { events: SILENCE });
  assert.equal(stalled.status, 1);
  assert.equal(stalled.last, NO_RUN_REASON);
  assert.deepEqual(stalled.viewTimes, [0, 10 * MIN], 'the watch reads at the start, then once at the 10-minute deadline, which stops it');
  assert.deepEqual(deadlinesOf(stalled), [10 * MIN]);
  assert.deepEqual(stalled.calls.filter((call) => callKind(call) === 'runs').at(0), ['api', '--paginate', '--slurp', runPath(HEAD)]);
  assert.equal(countOf(stalled, 'jobs'), 0, 'no unfinished run means no job read');
  assertWaitedOnEvents(stalled);
});

test('no-run stop: a completed unrelated run on the head commit does not disable the stop', async () => {
  const completed = { ...NO_RUN_PASS, runs: runsReply(workflowRun(500, 'completed', '2026-01-01T09:45:00Z')) };
  const stalled = await watch([completed], { events: SILENCE });
  assert.equal(stalled.status, 1);
  assert.equal(stalled.last, NO_RUN_REASON);
  assert.deepEqual(stalled.viewTimes, [0, 10 * MIN]);
  assert.equal(countOf(stalled, 'jobs'), 0, 'a finished run\'s jobs are not read');
  assertWaitedOnEvents(stalled);

  const afterRun = await watch([RUNNING, completed], { events: eventsAt(2) });
  assert.equal(afterRun.last, NO_RUN_REASON, 'a run that finished earlier does not hold the clock either');
  assert.deepEqual(afterRun.viewTimes, [0, 2 * MIN, 12 * MIN], 'the limit counts from the event pass that found the run finished');
  assertWaitedOnEvents(afterRun);
});

test('no-run stop: an unfinished run on the head commit keeps the wait going past 10 minutes', async () => {
  const waited = await watch([NO_RUN_PASS, RUNNING, MERGED], { events: eventsAt(9, 29) });
  assert.equal(waited.status, 0);
  assert.equal(waited.last, 'merged');
  assert.deepEqual(waited.viewTimes, [0, 9 * MIN, 29 * MIN]);
  assert.deepEqual(deadlinesOf(waited), [10 * MIN, undefined], 'an unfinished run leaves no deadline');
  assert.equal(countOf(waited, 'jobs'), 1, 'an unfinished run has its jobs read on its pass');
  assertWaitedOnEvents(waited);
});

test('no-run stop: the clock resets when a run becomes unfinished and starts over afterwards', async () => {
  const waited = await watch([NO_RUN_PASS, RUNNING, NO_RUN_PASS, MERGED], { events: eventsAt(9, 9.5, 19) });
  assert.equal(waited.status, 0, 'two stretches of 9.5 minutes with a run between them never reach 10 minutes');
  assert.deepEqual(deadlinesOf(waited), [10 * MIN, undefined, 19.5 * MIN]);
  assertWaitedOnEvents(waited);

  const stalled = await watch([NO_RUN_PASS, RUNNING, NO_RUN_PASS], { events: eventsAt(9, 9.5) });
  assert.equal(stalled.last, NO_RUN_REASON);
  assert.deepEqual(stalled.viewTimes, [0, 9 * MIN, 9.5 * MIN, 19.5 * MIN], 'the limit counts from the first pass after the run, not from the first pass of the watch');
  assertWaitedOnEvents(stalled);
});

test('no-run stop: the clock runs only while a required check is unreported, so it never runs on pending checks or an empty required set', async () => {
  const pending = { ...NO_RUN_PASS, checks: PENDING };
  const waiting = await watch([pending, MERGED], { events: eventsAt(40) });
  assert.equal(waiting.status, 0, 'pending checks with no run start no clock');
  assert.deepEqual(deadlinesOf(waiting), [undefined]);
  assertWaitedOnEvents(waiting);

  const reset = await watch([NO_RUN_PASS, pending, NO_RUN_PASS, MERGED], { events: eventsAt(9, 9.5, 19) });
  assert.equal(reset.status, 0, 'a pass with every required check reported restarts the clock');
  assert.deepEqual(deadlinesOf(reset), [10 * MIN, undefined, 19.5 * MIN]);
  assertWaitedOnEvents(reset);

  const nothingRequired = { view: view('OPEN', 'CLEAN'), checks: UNREPORTED, runs: NO_RUNS };
  const empty = await watch([nothingRequired, MERGED], { classic: [], ruled: [], events: eventsAt(40) });
  assert.equal(empty.status, 0, 'an empty required set has no unreported check, so no run is awaited');
  assert.deepEqual(deadlinesOf(empty), [undefined]);
  assertWaitedOnEvents(empty);
});

test('no-run stop: a draft pass makes no stall read and starts the clock over', async () => {
  const draft = { view: view('OPEN', 'DRAFT'), checks: UNREPORTED, runs: NO_RUNS };
  const waited = await watch([NO_RUN_PASS, draft, NO_RUN_PASS, MERGED], { events: eventsAt(7, 8, 17.5) });
  assert.equal(waited.status, 0, 'the draft pass restarts the 10 minutes');
  assert.equal(countOf(waited, 'runs'), 2, 'only the non-draft passes read runs');
  assert.deepEqual(deadlinesOf(waited), [10 * MIN, undefined, 18 * MIN], 'a draft has no deadline');
  assertWaitedOnEvents(waited);

  const stalled = await watch([draft, NO_RUN_PASS], { events: eventsAt(1) });
  assert.deepEqual(stalled.viewTimes, [0, MIN, 11 * MIN], 'the limit counts from the first non-draft pass');
  assert.equal(stalled.last, NO_RUN_REASON);
  assertWaitedOnEvents(stalled);
});

test('no-run stop: a new head commit starts the clock over for that head', async () => {
  const pushed = { view: view('OPEN', 'BLOCKED', OTHER_HEAD), checks: UNREPORTED, runs: NO_RUNS };
  const waited = await watch([NO_RUN_PASS, pushed, MERGED], { events: eventsAt(7, 16) });
  assert.equal(waited.status, 0);
  assert.deepEqual(waited.calls.filter((call) => callKind(call) === 'runs').at(-1), ['api', '--paginate', '--slurp', runPath(OTHER_HEAD)]);
  assert.deepEqual(deadlinesOf(waited), [10 * MIN, 17 * MIN]);
  assertWaitedOnEvents(waited);

  const stalled = await watch([NO_RUN_PASS, pushed], { events: eventsAt(7) });
  assert.equal(stalled.last, NO_RUN_REASON.replaceAll(HEAD, OTHER_HEAD), 'the reason names the head commit the limit ran out on');
  assert.deepEqual(stalled.viewTimes, [0, 7 * MIN, 17 * MIN]);
  assertWaitedOnEvents(stalled);
});

const READY_AT = '2026-01-01T10:00:00Z';
const readyEvent = (created_at) => ({ event: 'ready_for_review', created_at });
// Two pages: an earlier ready event, then a return to draft and the latest ready event.
const markedReady = [0, JSON.stringify([[readyEvent('2026-01-01T09:00:00Z'), { event: 'convert_to_draft', created_at: '2026-01-01T09:10:00Z' }], [readyEvent(READY_AT)]])];

test('no-run stop: a run created before the pull request was marked ready, still queued, does not hold the clock or trigger the queued stop', async () => {
  const draftTimeRun = {
    view: OPEN_BLOCKED,
    checks: UNREPORTED,
    runs: runsReply(workflowRun(501, 'queued', '2026-01-01T09:30:00Z')),
    jobs: jobsReply(testJob()),
  };
  const stalled = await watch([draftTimeRun], { timeline: markedReady, events: SILENCE });
  assert.equal(stalled.status, 1);
  assert.equal(stalled.last, NO_RUN_REASON, 'the latest ready time, not an earlier one, decides which runs count');
  assert.deepEqual(stalled.viewTimes, [0, 10 * MIN], 'the stop comes at 10 minutes, not at the 15 of the queued stop');
  assert.equal(countOf(stalled, 'jobs'), 0, 'a run from before the ready time has its jobs left unread');
  assertWaitedOnEvents(stalled);
});

test('no-run stop: a run created exactly when the pull request was marked ready counts, and the timeline is read once per head commit', async () => {
  const atReady = { view: OPEN_BLOCKED, checks: UNREPORTED, runs: runsReply(workflowRun(501, 'in_progress', READY_AT)), jobs: jobsReply() };
  const waited = await watch([atReady, atReady, MERGED], { timeline: markedReady, events: eventsAt(5, 30) });
  assert.equal(waited.status, 0, 'a counted unfinished run keeps the wait going past 10 minutes');
  assert.deepEqual(deadlinesOf(waited), [undefined, undefined], 'a counted unfinished run leaves no deadline');
  assert.equal(countOf(waited, 'jobs'), 2);
  assert.equal(countOf(waited, 'timeline'), 1);
  assert.deepEqual(waited.calls.find((call) => callKind(call) === 'timeline'), ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/7/timeline?per_page=100']);
  assertWaitedOnEvents(waited);

  const pushed = { ...atReady, view: view('OPEN', 'BLOCKED', OTHER_HEAD) };
  const twoHeads = await watch([atReady, atReady, pushed, pushed, MERGED], { timeline: markedReady, events: eventsAt(1, 2, 3, 4) });
  assert.equal(countOf(twoHeads, 'timeline'), 2, 'a new head commit reads the timeline again');
  assertWaitedOnEvents(twoHeads);
});

test('queued stop: the watch stops when a job of an unfinished run has waited 15 minutes with no runner, naming the machine it needs', async () => {
  const waiting = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob()) };
  const stalled = await watch([waiting], { events: SILENCE });
  assert.equal(stalled.status, 1);
  assert.equal(stalled.last, 'a test job has waited 15 minutes for a machine: test (linux) waits for a runner labelled self-hosted, linux');
  assert.deepEqual(stalled.viewTimes, [0, 15 * MIN], 'the watch reads at the start, then once at the 15-minute deadline, which stops it');
  assert.deepEqual(deadlinesOf(stalled), [15 * MIN]);
  assert.deepEqual(stalled.calls.filter((call) => callKind(call) === 'jobs').at(0), ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/actions/runs/501/jobs?per_page=100']);
  assertWaitedOnEvents(stalled);

  const finishedRun = { ...waiting, runs: runsReply(workflowRun(501, 'completed')) };
  const ignored = await watch([finishedRun, MERGED], { events: eventsAt(35) });
  assert.equal(ignored.status, 0, 'a finished run\'s jobs are not read');
  assert.equal(countOf(ignored, 'jobs'), 0);
  assert.deepEqual(deadlinesOf(ignored), [undefined]);
  assertWaitedOnEvents(ignored);
});

test('queued stop: a queued job whose runner name is an empty string counts as unassigned', async () => {
  const emptyRunner = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob({ runner_name: '' })) };
  const stalled = await watch([emptyRunner], { events: SILENCE });
  assert.equal(stalled.status, 1);
  assert.equal(stalled.last, 'a test job has waited 15 minutes for a machine: test (linux) waits for a runner labelled self-hosted, linux');
  assert.deepEqual(stalled.viewTimes, [0, 15 * MIN]);
  assertWaitedOnEvents(stalled);
});

test('queued stop: a job picked up before 15 minutes keeps the wait going, and a job that stops waiting starts its limit over', async () => {
  const jobsStep = (...items) => ({ view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'in_progress')), jobs: jobsReply(...items) });
  const queued = jobsStep(testJob());
  const pickedUp = jobsStep(testJob({ status: 'in_progress', runner_name: 'runner-1' }));
  const resumed = await watch([queued, pickedUp, queued, MERGED], { events: eventsAt(14, 14.5, 28) });
  assert.equal(resumed.status, 0, 'a job queued 14 minutes, picked up, then queued again waits afresh');
  assert.deepEqual(deadlinesOf(resumed), [15 * MIN, undefined, 29.5 * MIN]);
  assertWaitedOnEvents(resumed);

  for (const [label, job] of [
    ['queued with a runner named', testJob({ runner_name: 'runner-1' })],
    ['in progress with no runner named', testJob({ status: 'in_progress' })],
    ['completed', testJob({ status: 'completed' })],
  ]) {
    const notWaiting = await watch([jobsStep(job), MERGED], { events: eventsAt(35) });
    assert.equal(notWaiting.status, 0, `a job ${label} is not waiting for a machine`);
    assert.deepEqual(deadlinesOf(notWaiting), [undefined], `a job ${label} sets no deadline`);
    assertWaitedOnEvents(notWaiting);
  }

  const two = jobsStep(
    testJob({ id: 902, name: 'sweep-scope', labels: ['ubuntu-latest'] }),
    testJob({ id: 901, status: 'in_progress', runner_name: 'runner-1' }),
  );
  const other = await watch([two], { events: SILENCE });
  assert.equal(other.last, 'a test job has waited 15 minutes for a machine: sweep-scope waits for a runner labelled ubuntu-latest');
  assert.deepEqual(other.viewTimes, [0, 15 * MIN]);
  assertWaitedOnEvents(other);
});

test('labels: a stalled job with no labels, or only blank ones, gets a reason that never shows a blank machine', async () => {
  const noLabels = 'a test job has waited 15 minutes for a machine: test (linux) waits for a runner, but GitHub reported no runner labels';
  for (const labels of [[], [''], ['', '  ']]) {
    const waiting = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob({ labels })) };
    const stalled = await watch([waiting]);
    assert.equal(stalled.status, 1);
    assert.equal(stalled.last, noLabels, `labels ${JSON.stringify(labels)} must give the no-labels reason`);
  }

  const mixed = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob({ labels: ['', 'linux'] })) };
  const named = await watch([mixed]);
  assert.equal(named.last, 'a test job has waited 15 minutes for a machine: test (linux) waits for a runner labelled linux', 'blank labels are left out of the list');
});

test('status validation: a workflow run or job status GitHub does not document stops the watch as unreadable', async () => {
  const unfinished = (item) => ({ view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(item), jobs: jobsReply() });
  for (const status of ['unknown', 'COMPLETED', 'in-progress', '']) {
    const run = workflowRun(501, status);
    const unreadable = await watch([unfinished(run), MERGED]);
    assert.equal(unreadable.status, 1, `run status ${JSON.stringify(status)} must stop the wait`);
    assert.equal(unreadable.last, `unreadable workflow run on ${HEAD}: ${JSON.stringify(run)}`);
    assert.equal(unreadable.reads, 1);
    assert.deepEqual(unreadable.wakes, []);
    assert.equal(callKind(unreadable.calls.at(-1)), 'runs', 'nothing may be read after the unreadable run');
  }
  for (const status of ['unknown', 'cancelled', 'Queued', '']) {
    const job = testJob({ status });
    const unreadable = await watch([{ ...unfinished(workflowRun(501, 'queued')), jobs: jobsReply(job) }, MERGED]);
    assert.equal(unreadable.status, 1, `job status ${JSON.stringify(status)} must stop the wait`);
    assert.equal(unreadable.last, `unreadable job of workflow run 501: ${JSON.stringify(job)}`);
    assert.equal(unreadable.reads, 1);
    assert.deepEqual(unreadable.wakes, []);
    assert.equal(callKind(unreadable.calls.at(-1)), 'jobs', 'nothing may be read after the unreadable job');
  }

  for (const status of ['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out']) {
    const known = await watch([unfinished(workflowRun(501, status)), MERGED]);
    assert.equal(known.status, 0, `run status ${status} is a documented one`);
  }
  for (const status of ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']) {
    const known = await watch([{ ...unfinished(workflowRun(501, 'queued')), jobs: jobsReply(testJob({ status, runner_name: 'runner-1' })) }, MERGED]);
    assert.equal(known.status, 0, `job status ${status} is a documented one`);
  }
});

test('the watch exits 1 on the pass whose workflow run, job or head commit reply it cannot read, reading nothing after it', async () => {
  const badGateway = [1, 'HTTP 502: Bad Gateway (https://api.github.com/repos/owner/repo)'];
  const running = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')) };
  const badRun = (item) => ['runs', `unreadable workflow run on ${HEAD}: ${JSON.stringify(item)}`, { ...running, runs: runsReply(item) }, {}];
  const badJob = (item) => ['jobs', `unreadable job of workflow run 501: ${JSON.stringify(item)}`, { ...running, jobs: jobsReply(item) }, {}];
  const badHead = (headRefOid) => [
    'view',
    `unreadable pull request state: ${JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', headRefOid })}`,
    { ...running, view: [0, JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', headRefOid })] },
    {},
  ];
  for (const [kind, reason, step, options] of [
    ['runs', `unreadable workflow runs on ${HEAD}: {}`, { ...running, runs: [0, '{}'] }, {}],
    ['runs', `unreadable workflow runs on ${HEAD}: [{}]`, { ...running, runs: [0, '[{}]'] }, {}],
    badRun({ status: 'queued', created_at: RUN_CREATED }),
    badRun({ id: '501', status: 'queued', created_at: RUN_CREATED }),
    badRun({ id: 501, created_at: RUN_CREATED }),
    badRun({ id: 501, status: 'queued' }),
    badRun({ id: 501, status: 'queued', created_at: 'soon' }),
    ['runs', badGateway[1], { ...running, runs: badGateway }, {}],
    ['jobs', 'unreadable jobs of workflow run 501: {}', { ...running, jobs: [0, '{}'] }, {}],
    badJob({ name: 'test', status: 'queued', runner_name: null, labels: [] }),
    badJob(testJob({ id: '901' })),
    badJob(testJob({ name: 7 })),
    badJob(testJob({ status: null })),
    badJob(testJob({ labels: 'linux' })),
    badJob(testJob({ labels: ['linux', 7] })),
    badJob(testJob({ runner_name: 7 })),
    badJob(testJob({ runner_name: undefined })),
    ['jobs', badGateway[1], { ...running, jobs: badGateway }, {}],
    ['timeline', 'unreadable pull request timeline: {}', running, { timeline: [0, '{}'] }],
    ['timeline', 'unreadable pull request timeline: [{"event":"ready_for_review","created_at":"2026-01-01T10:00:00Z"}]', running, { timeline: [0, JSON.stringify([readyEvent(READY_AT)])] }],
    ['timeline', 'unreadable pull request timeline: [[{"event":"ready_for_review"}]]', running, { timeline: [0, '[[{"event":"ready_for_review"}]]'] }],
    ['timeline', 'unreadable pull request timeline: [[{"event":"ready_for_review","created_at":"soon"}]]', running, { timeline: [0, '[[{"event":"ready_for_review","created_at":"soon"}]]'] }],
    ['timeline', badGateway[1], running, { timeline: badGateway }],
    ...[undefined, null, 'main', HEAD.toUpperCase(), HEAD.slice(1), `${HEAD}0`].map(badHead),
  ]) {
    const unreadable = await watch([step, MERGED], options);
    const label = `${kind} reply ${reason}`;
    assert.equal(unreadable.status, 1, `${label} must stop the wait`);
    assert.equal(unreadable.last, reason, `${label} must print its reason last`);
    assert.equal(unreadable.reads, 1, `${label} must stop on the first pass`);
    assert.deepEqual(unreadable.wakes, [], `${label} must not wait and read again`);
    assert.equal(callKind(unreadable.calls.at(-1)), kind, `nothing may be read after ${label}`);
    assert.equal(countOf(unreadable, kind), 1, `${label} must be read once`);
  }
});

// The event wait. Every gh call is counted with the fake-clock time it was made at; the watch reads the required set
// once at the start, then the pull request, its checks and the stall reads on each pass, the timeline once per head.
const START_READS = ['base', 'branch', 'rules'];
const FIRST_PASS = ['view', 'checks', 'timeline', 'runs', 'jobs'];
const PASS = ['view', 'checks', 'runs', 'jobs'];
const callsAt = (at, kinds) => kinds.map((kind) => [at, kind]);
const timedCalls = (run) => run.calls.map((call, index) => [run.callTimes[index], callKind(call)]);
const SECOND = 1_000;
const SETTLE_STOP = 'GitHub had not worked out whether the pull request can merge 75 seconds after settling began: OPEN UNKNOWN; run the watch again';

test('request count', async () => {
  const unknowns = (count) => Array.from({ length: count }, () => UNKNOWN_RUNNING);
  for (const row of [
    {
      label: '(a) ten silent minutes on running checks make no gh call after the first pass',
      steps: [CHECKS_RUNNING],
      events: TEN_SILENT_MINUTES,
      calls: callsAt(0, [...START_READS, ...FIRST_PASS]),
      deadlines: [undefined],
      reason: ROUTE_ENDED,
      stoppedAt: 10 * MIN,
    },
    {
      label: '(b) with a stall clock running, ten silent minutes make one pass, at the deadline, which reports the stall',
      steps: [NO_RUN_PASS],
      events: TEN_SILENT_MINUTES,
      calls: [...callsAt(0, [...START_READS, 'view', 'checks', 'timeline', 'runs']), ...callsAt(10 * MIN, ['view', 'checks', 'runs'])],
      deadlines: [10 * MIN],
      reason: NO_RUN_REASON,
      stoppedAt: 10 * MIN,
    },
    {
      label: '(c) an initial read finding UNKNOWN makes no further read in ten silent minutes',
      steps: [UNKNOWN_RUNNING],
      events: TEN_SILENT_MINUTES,
      calls: callsAt(0, [...START_READS, ...FIRST_PASS]),
      deadlines: [undefined],
      reason: ROUTE_ENDED,
      stoppedAt: 10 * MIN,
    },
    {
      label: '(d) a stall-deadline read finding UNKNOWN makes no further read',
      steps: [NO_RUN_PASS, UNKNOWN_RUNNING],
      events: { arrivals: [], endAt: 20 * MIN },
      calls: [...callsAt(0, [...START_READS, 'view', 'checks', 'timeline', 'runs']), ...callsAt(10 * MIN, PASS)],
      deadlines: [10 * MIN, undefined],
      reason: ROUTE_ENDED,
      stoppedAt: 20 * MIN,
    },
    {
      label: '(e) an event read finding UNKNOWN makes at most 4 more reads, at +5, +15, +35 and +74 s',
      steps: [CHECKS_RUNNING, ...unknowns(4), CHECKS_RUNNING],
      events: /** @type {WatchEvents} */ ({ arrivals: [[MIN, PR_EVENT]], endAt: 10 * MIN }),
      calls: [
        ...callsAt(0, [...START_READS, ...FIRST_PASS]),
        ...[60, 65, 75, 95, 134].flatMap((seconds) => callsAt(seconds * SECOND, PASS)),
      ],
      deadlines: [undefined, 65 * SECOND, 75 * SECOND, 95 * SECOND, 134 * SECOND, undefined],
      reason: ROUTE_ENDED,
      stoppedAt: 10 * MIN,
    },
    {
      label: '(f) an event during the sequence reads once and leaves the anchor and remaining budget unchanged',
      steps: [CHECKS_RUNNING, ...unknowns(5), CHECKS_RUNNING],
      events: /** @type {WatchEvents} */ ({ arrivals: [[MIN, PR_EVENT], [72 * SECOND, PR_EVENT]], endAt: 10 * MIN }),
      calls: [
        ...callsAt(0, [...START_READS, ...FIRST_PASS]),
        ...[60, 65, 72, 75, 95, 134].flatMap((seconds) => callsAt(seconds * SECOND, PASS)),
      ],
      deadlines: [undefined, 65 * SECOND, 75 * SECOND, 75 * SECOND, 95 * SECOND, 134 * SECOND, undefined],
      reason: ROUTE_ENDED,
      stoppedAt: 10 * MIN,
    },
  ]) {
    const run = await watch(row.steps, { events: row.events });
    assert.deepEqual(timedCalls(run), row.calls, `${row.label}: gh calls and when each was made`);
    assert.deepEqual(deadlinesOf(run), row.deadlines, `${row.label}: the deadline of each wait`);
    assert.equal(run.last, row.reason, row.label);
    assert.equal(run.status, 1, row.label);
    assert.equal(run.stoppedAt, row.stoppedAt, `${row.label}: when the watch stopped`);
    assertWaitedOnEvents(run, row.label);
  }
});

test('an event reports the merge', async () => {
  const run = await watch([CHECKS_RUNNING, MERGED], { events: { arrivals: [[MIN, pullRequestEvent(8)], [3 * MIN, pullRequestEvent(7, 'closed')]] } });
  assert.equal(run.status, 0);
  assert.equal(run.last, 'merged');
  assert.deepEqual(run.viewTimes, [0, 3 * MIN], 'another pull request\'s event reads nothing, and this one\'s reads at once');
  assertWaitedOnEvents(run);
});

test('a completed check run reports a failed required check', async () => {
  const failed = { ...CHECKS_RUNNING, checks: checks({ test: 'fail', 'sweep-scope': 'pass' }) };
  const run = await watch([CHECKS_RUNNING, failed], {
    events: {
      arrivals: [
        [MIN, checkRunEvent('created', HEAD)],
        [2 * MIN, checkRunEvent('completed', OTHER_HEAD)],
        [4 * MIN, checkRunEvent('completed', HEAD)],
      ],
    },
  });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'a required check failed: fail pass');
  assert.deepEqual(run.viewTimes, [0, 4 * MIN], 'a check run created, or completed on another commit, reads nothing');
  assertWaitedOnEvents(run);
});

test('a push to the base reports a behind branch', async () => {
  const behind = { ...CHECKS_RUNNING, view: view('OPEN', 'BEHIND') };
  const run = await watch([CHECKS_RUNNING, behind], { events: { arrivals: [[MIN, pushEvent('refs/heads/other')], [2 * MIN, pushEvent('refs/heads/trunk')]] } });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'merge blocked: OPEN BEHIND');
  assert.deepEqual(run.viewTimes, [0, 2 * MIN], 'a push to another branch reads nothing');
  assert.deepEqual(run.wakes.map((wait) => wait.context), [{ pr: '7', base: 'trunk', head: HEAD }], 'the wait names this pull request, its base and its head');
  assertWaitedOnEvents(run);
});

test('settle reads report the conflict once GitHub has worked it out', async () => {
  const dirty = { ...CHECKS_RUNNING, view: view('OPEN', 'DIRTY') };
  const run = await watch([CHECKS_RUNNING, UNKNOWN_RUNNING, UNKNOWN_RUNNING, dirty], { events: { arrivals: [[MIN, pushEvent('refs/heads/trunk')]] } });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'merge blocked: OPEN DIRTY');
  assert.deepEqual(run.viewTimes, [0, MIN, 65 * SECOND, 75 * SECOND], 'the event read, then settle reads 5 and 15 seconds after it');
  assertWaitedOnEvents(run);
});

test('the fourth settle read still unknown stops naming it', async () => {
  const run = await watch([CHECKS_RUNNING, UNKNOWN_RUNNING], { events: { arrivals: [[MIN, PR_EVENT]] } });
  assert.equal(run.status, 1);
  assert.equal(run.last, SETTLE_STOP);
  assert.deepEqual(run.viewTimes, [0, 60, 65, 75, 95, 134].map((seconds) => seconds * SECOND));
  assert.equal(run.stoppedAt, 134 * SECOND, 'the watch stops on the fourth settle read');
  assertWaitedOnEvents(run);
});

test('settle reads start within 75 seconds of the event read when each pull request read takes 20 seconds', async () => {
  const run = await watch([CHECKS_RUNNING, UNKNOWN_RUNNING], { events: { arrivals: [[MIN, PR_EVENT]] }, viewTakes: 20 * SECOND });
  assert.equal(run.viewTimes[1], MIN, 'the event read starts when the event arrives');
  const settleReads = run.viewTimes.slice(2);
  assert.ok(settleReads.every((at) => at <= MIN + 75 * SECOND), `no settle read may start after the event read + 75 s: ${JSON.stringify(settleReads)}`);
  assert.ok(settleReads.length <= 4, `at most four settle reads: ${JSON.stringify(settleReads)}`);
  assert.equal(run.last, SETTLE_STOP);
  assert.equal(run.status, 1);
  assertWaitedOnEvents(run);
});

test('settle reads start within 75 seconds of the event read when each read takes 40 seconds', async () => {
  const run = await watch([CHECKS_RUNNING, UNKNOWN_RUNNING], { events: { arrivals: [[MIN, PR_EVENT]] }, viewTakes: 40 * SECOND });
  assert.deepEqual(run.viewTimes, [0, 60, 134].map((seconds) => seconds * SECOND), 'the event read, then the one settle read that is not late');
  assert.ok(run.viewTimes.slice(2).every((at) => at <= MIN + 75 * SECOND), `no settle read may start after the event read + 75 s: ${JSON.stringify(run.viewTimes)}`);
  assert.equal(run.last, SETTLE_STOP);
  assertWaitedOnEvents(run);
});

test('an event read at or after a settle time spends no settle read', async () => {
  const run = await watch([CHECKS_RUNNING, UNKNOWN_RUNNING], { events: { arrivals: [[SECOND, PR_EVENT], [6 * SECOND, PR_EVENT]] } });
  assert.deepEqual(run.viewTimes, [0, 1, 6, 6, 16, 36, 75].map((seconds) => seconds * SECOND), 'the event reads at 1 and 6 s, then settle reads at +5, +15, +35 and +74 s');
  assert.deepEqual(run.wakes.map((wait) => wait.wake), ['event', 'event', 'deadline', 'deadline', 'deadline', 'deadline'], 'four deadline wakes follow the two events');
  assert.equal(run.last, SETTLE_STOP);
  assert.equal(run.stoppedAt, 75 * SECOND);
  assertWaitedOnEvents(run);
});

const QUEUED_RUNNING = { ...CHECKS_RUNNING, view: view('OPEN', 'BLOCKED', HEAD, QUEUED) };
const QUEUED_BLOCKED = { ...CHECKS_RUNNING, view: view('OPEN', 'BLOCKED', HEAD, QUEUED), checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) };

test('a BLOCKED read with every required check passed and an auto-merge queued makes the settle reads and exits 0 once the pull request merges', async () => {
  const UNKNOWN_QUEUED = { ...UNKNOWN_RUNNING, view: view('OPEN', 'UNKNOWN', HEAD, QUEUED) };
  for (const [label, steps, events, times] of /** @type {[string, object[], WatchEvents, number[]][]} */ ([
    ['event case', [QUEUED_RUNNING, QUEUED_BLOCKED, MERGED], { arrivals: [[MIN, PR_EVENT]] }, [0, 60, 65]],
    ['start case', [QUEUED_BLOCKED, MERGED], { arrivals: [], endAt: 10 * MIN }, [0, 5]],
    ['mixed case', [QUEUED_RUNNING, UNKNOWN_QUEUED, QUEUED_BLOCKED, MERGED], { arrivals: [[MIN, PR_EVENT]] }, [0, 60, 65, 75]],
  ])) {
    const run = await watch(steps, { events });
    assert.equal(run.status, 0, label);
    assert.equal(run.last, 'merged', label);
    assert.deepEqual(run.viewTimes, times.map((seconds) => seconds * SECOND), label);
    assertWaitedOnEvents(run, label);
  }
});

test('a pull request still BLOCKED through every settle read with an auto-merge queued stops with its reason after the fourth', async () => {
  const run = await watch([QUEUED_RUNNING, QUEUED_BLOCKED], { events: { arrivals: [[MIN, PR_EVENT]] } });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'merge blocked with every required check finished: OPEN BLOCKED pass pass');
  assert.deepEqual(run.viewTimes, [0, 60, 65, 75, 95, 134].map((seconds) => seconds * SECOND));
  assert.equal(run.stoppedAt, 134 * SECOND);
  assertWaitedOnEvents(run);
});

test('a queued auto-merge read with every required check passed clears the stall clocks, so an unrelated runner stall does not stop the settle reads', async () => {
  const waiting = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob({ name: 'docs (linux)' })) };
  const finished = { ...waiting, view: view('OPEN', 'BLOCKED', HEAD, QUEUED), checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) };
  const run = await watch([waiting, finished, MERGED], { events: SILENCE });
  assert.equal(run.status, 0, run.last);
  assert.equal(run.last, 'merged');
  assert.deepEqual(run.viewTimes, [0, 15 * MIN, 15 * MIN + 5 * SECOND], 'the stall deadline read, then the first settle read');
  assertWaitedOnEvents(run);
});

test('a cancelled required check stops a queued auto-merge BLOCKED read at once', async () => {
  const cancelled = { ...CHECKS_RUNNING, view: view('OPEN', 'BLOCKED', HEAD, QUEUED), checks: checks({ test: 'pass', 'sweep-scope': 'cancel' }) };
  const run = await watch([cancelled, MERGED], { events: SILENCE });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'merge blocked with every required check finished: OPEN BLOCKED pass cancel');
  assert.equal(run.reads, 1, 'no settle read follows');
  assertWaitedOnEvents(run);
});

test('a settle sequence begun by a queued auto-merge BLOCKED read that stays UNKNOWN stops saying when settling began', async () => {
  const unknownQueued = { ...UNKNOWN_RUNNING, view: view('OPEN', 'UNKNOWN', HEAD, QUEUED) };
  const run = await watch([QUEUED_BLOCKED, unknownQueued], { events: SILENCE });
  assert.equal(run.status, 1);
  assert.equal(run.last, SETTLE_STOP);
  assert.deepEqual(run.viewTimes, [0, 5, 15, 35, 74].map((seconds) => seconds * SECOND));
  assertWaitedOnEvents(run);
});

test('a pull request still BLOCKED with an auto-merge queued stops with its reason when a slow read overruns every settle time', async () => {
  const run = await watch([QUEUED_BLOCKED], { events: SILENCE, viewTakes: 80 * SECOND });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'merge blocked with every required check finished: OPEN BLOCKED pass pass');
  assertWaitedOnEvents(run);
});

test('a queued job event starts the 15-minute deadline', async () => {
  const queued = { view: OPEN_BLOCKED, checks: PENDING, runs: runsReply(workflowRun(501, 'queued')), jobs: jobsReply(testJob()) };
  const run = await watch([CHECKS_RUNNING, queued], { events: { arrivals: [[2 * MIN, workflowJobEvent('queued', HEAD)]] } });
  assert.equal(run.status, 1);
  assert.equal(run.last, 'a test job has waited 15 minutes for a machine: test (linux) waits for a runner labelled self-hosted, linux');
  assert.deepEqual(run.viewTimes, [0, 2 * MIN, 17 * MIN], 'the event read finds the queued job, and the deadline read 15 minutes later reports it');
  assert.deepEqual(deadlinesOf(run), [undefined, 17 * MIN]);
  assertWaitedOnEvents(run);
});

test('isRelevantEvent infers each event from its payload shape and matches only this pull request, its head and its base', () => {
  for (const [label, payload, relevant] of /** @type {[string, object, boolean][]} */ ([
    ['the ping GitHub sends when the hook is created', PING_EVENT, false],
    ['a check run completed on the head', checkRunEvent('completed', HEAD), true],
    ['a check run completed on another commit', checkRunEvent('completed', OTHER_HEAD), false],
    ['a check run created on the head', checkRunEvent('created', HEAD), false],
    ['a check run rerequested on the head', checkRunEvent('rerequested', HEAD), false],
    ['a workflow job queued on the head', workflowJobEvent('queued', HEAD), true],
    ['a workflow job in progress on the head', workflowJobEvent('in_progress', HEAD), true],
    ['a workflow job completed on the head', workflowJobEvent('completed', HEAD), true],
    ['a workflow job queued on another commit', workflowJobEvent('queued', OTHER_HEAD), false],
    ['this pull request synchronized', pullRequestEvent(7), true],
    ['this pull request closed', pullRequestEvent(7, 'closed'), true],
    ['another pull request on the same head', pullRequestEvent(8), false],
    ['a push to the base', pushEvent('refs/heads/trunk'), true],
    ['a push to the pull request branch', pushEvent('refs/heads/job/7'), false],
    ['a push to a tag named like the base', pushEvent('refs/tags/trunk'), false],
    ['a status on the head', statusEvent(HEAD), true],
    ['a status on another commit', statusEvent(OTHER_HEAD), false],
  ])) {
    assert.equal(watchLib.isRelevantEvent(payload, CONTEXT), relevant, label);
  }
  // Lines that parse but carry no event shape GitHub sends.
  for (const line of [
    'null', '7', '"refs/heads/trunk"', '[]', '{}',
    '{"action":"completed","check_run":null}',
    `{"workflow_job":"${HEAD}"}`,
    '{"number":7,"pull_request":null}',
    '{"ref":"refs/heads/trunk"}',
    `{"sha":"${HEAD}","state":"success"}`,
  ]) {
    assert.equal(watchLib.isRelevantEvent(JSON.parse(line), CONTEXT), false, `a corrupt line ${line}`);
  }
});

const DRAFT_ORIGIN = 'git@github.com:owner/repo.git';
const DRAFT_REPO = ['repo', 'view', '--json', 'id', '--', DRAFT_ORIGIN];
const DRAFT_LIST = ['pr', 'list', '--repo', DRAFT_ORIGIN, '--head', 'job/7', '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository'];
const draftPr = (overrides = {}) => ({ number: 12, state: 'OPEN', headRefName: 'job/7', headRepository: { id: 'R_origin' }, isCrossRepository: false, ...overrides });

// Draft-list calls advance replies and the last repeats; repository lookup has its own reply. A sleep past the
// twentieth means the wait never stopped.
/** @param {unknown[][]} replies @param {string[]} [args] @param {{ origin?: string | Error, repository?: unknown[] }} [options] */
async function waitDraft(replies, args = ['--draft', 'job/7'], { origin = DRAFT_ORIGIN + '\n', repository = [0, '{"id":"R_origin"}'] } = {}) {
  const calls = [];
  const gitCalls = [];
  let reads = 0;
  const gitExec = (call) => {
    gitCalls.push(call);
    if (origin instanceof Error) throw origin;
    return origin;
  };
  const ghExec = (call) => {
    calls.push(call);
    let reply;
    if (call[0] === 'repo') reply = repository;
    else if (call[0] === 'pr' && call[1] === 'list') reply = replies[Math.min(++reads, replies.length) - 1];
    else throw new Error('unexpected gh call: ' + call.join(' '));
    const [code, body] = reply;
    if (code === 0) return body + '\n';
    throw Object.assign(new Error(body), { status: code, stdout: '', stderr: body + '\n' });
  };
  const lines = [];
  const sleeps = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const sleep = async (ms) => {
    sleeps.push(ms);
    if (sleeps.length > 20) throw new Error('the draft wait did not stop');
  };
  const status = await main(args, { gitExec, ghExec, output, sleep });
  return { status, lines, last: lines.at(-1), sleeps, calls, gitCalls };
}

test('the draft wait reads only the open pull requests on its branch, keeps waiting while there are none, and exits 0 printing the number once one opens', async () => {
  const run = await waitDraft([[0, '[]'], [0, '[]'], [0, JSON.stringify([draftPr()])]]);
  assert.equal(run.status, 0);
  assert.equal(run.last, '12');
  assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST, DRAFT_LIST, DRAFT_LIST]);
  assert.deepEqual(run.sleeps, [30_000, 30_000]);
});

test('the draft wait exits 1 the moment gh fails, with a safe reason last and no read after it', async () => {
  const unsafeUrl = 'https://user:secret-token@github.com/o/r.git?token=query-secret';
  const run = await waitDraft([[0, '[]'], [1, `error connecting to ${unsafeUrl}`]], undefined, { origin: `${unsafeUrl}\n` });
  assert.equal(run.status, 1);
  assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST, DRAFT_LIST].map((args) => args.map((arg) => (arg === DRAFT_ORIGIN ? unsafeUrl : arg))));
  assert.equal(run.sleeps.length, 1);
  for (const line of run.lines) {
    for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
      assert.ok(!line.includes(secret), `remote credentials leaked in ${JSON.stringify(line)}`);
    }
  }
  assert.equal(run.last, 'could not list origin pull requests; check Git and GitHub CLI installation, repository access and configuration');
});

test('the draft wait exits 1 without waiting on a pull request list it cannot read', async () => {
  for (const body of ['{}', '[{}]', '[null]', '[{"number":"12"}]', '[{"number":0}]']) {
    const run = await waitDraft([[0, body]]);
    assert.equal(run.status, 1, body);
    assert.equal(run.last, `unreadable pull request list: ${body}`);
    assert.equal(run.sleeps.length, 0, body);
    assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST], body);
  }
  const unsafeUrl = 'https://user:secret-token@github.com/o/r.git?token=query-secret';
  const garbled = await waitDraft([[0, `{invalid JSON: ${unsafeUrl}`]]);
  assert.equal(garbled.status, 1);
  assert.equal(garbled.sleeps.length, 0);
  assert.deepEqual(garbled.calls, [DRAFT_REPO, DRAFT_LIST]);
  for (const line of garbled.lines) {
    for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
      assert.ok(!line.includes(secret), `remote credentials leaked in ${JSON.stringify(line)}`);
    }
  }
  assert.equal(garbled.last, 'unreadable pull request list: GitHub CLI returned invalid JSON');
});

test('the draft wait exits 1 naming each number when more than one pull request is open on its branch', async () => {
  const run = await waitDraft([[0, JSON.stringify([draftPr(), draftPr({ number: 13 })])]]);
  assert.equal(run.status, 1);
  assert.equal(run.last, 'more than one open pull request on job/7: 12 13');
  assert.equal(run.sleeps.length, 0);
});

test('the draft wait accepts a job branch named by a Linear issue ID', async () => {
  const list = DRAFT_LIST.map((arg) => (arg === 'job/7' ? 'job/ENG-1' : arg));
  const run = await waitDraft([[0, JSON.stringify([draftPr({ headRefName: 'job/ENG-1' })])]], ['--draft', 'job/ENG-1']);
  assert.equal(run.status, 0);
  assert.equal(run.last, '12');
  assert.deepEqual(run.calls, [DRAFT_REPO, list]);
});

test('the draft wait exits 2 with its usage before any gh call unless given exactly --draft and a job branch', async () => {
  for (const args of [
    ['--draft'], ['--draft', '7'], ['--draft', 'job/0'], ['--draft', 'job/07'], ['--draft', 'job/7x'], ['--draft', 'job/'],
    ['--draft', 'main'], ['--draft', 'feature/job/7'], ['--draft', 'job/7', '8'], ['--draft=job/7'], ['job/7'],
    ['job/7', '--draft'], ['--draft', '--draft'],
    ['--draft', 'job/eng-1'], ['--draft', 'job/ENG-0'], ['--draft', 'job/ENG-'], ['--draft', 'job/-1'], ['--draft', 'job/ENG-1/x'],
  ]) {
    const run = await waitDraft([[0, '[{"number":12}]']], args);
    assert.equal(run.status, 2, JSON.stringify(args));
    assert.deepEqual(run.lines, [USAGE], JSON.stringify(args));
    assert.deepEqual(run.calls, [], JSON.stringify(args));
    assert.deepEqual(run.gitCalls, [], JSON.stringify(args));
  }
});

test('ANTI-REGRESSION: cloud drafts require origin repository and exact job branch', async () => {
  /** @type {[string, object][]} */
  const invalidRows = [
    ['a fork copying the commit and body', draftPr({ headRepository: { id: 'R_fork' }, isCrossRepository: true, headRefOid: 'copied', body: 'copied' })],
    ['wrong branch', draftPr({ headRefName: 'job/8' })],
    ['foreign repository with a false fork flag', draftPr({ headRepository: { id: 'R_foreign' } })],
    ['true fork flag', draftPr({ isCrossRepository: true })],
    ['nonboolean fork flag', draftPr({ isCrossRepository: 'false' })],
    ['missing fork flag', draftPr({ isCrossRepository: undefined })],
    ['missing repository', draftPr({ headRepository: undefined })],
    ['null repository', draftPr({ headRepository: null })],
    ['malformed repository', draftPr({ headRepository: 'R_origin' })],
    ['missing repository id', draftPr({ headRepository: {} })],
    ['malformed repository id', draftPr({ headRepository: { id: 7 } })],
    ['non-open state', draftPr({ state: 'CLOSED' })],
  ];
  for (const [label, pr] of invalidRows) {
    for (const rows of [[pr], [draftPr(), pr], [pr, draftPr()]]) {
      const run = await waitDraft([[0, JSON.stringify(rows)], [0, JSON.stringify([draftPr()])]]);
      assert.equal(run.status, 1, label);
      assert.equal(run.last, `foreign or unverified pull request on job/7: ${JSON.stringify(rows)}`, label);
      assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST], label + ': no read after refusal');
      assert.deepEqual(run.sleeps, [], label);
    }
  }
  const unsafeUrl = 'https://user:secret-token@github.com/o/r.git?token=query-secret';
  const malformedJson = `{invalid JSON: ${unsafeUrl}`;
  for (const body of ['null', '[]', '{}', '{"id":""}', '{"id":7}', '{"id":"R origin"}', malformedJson]) {
    const run = await waitDraft([[0, JSON.stringify([draftPr()])]], undefined, { repository: [0, body] });
    assert.equal(run.status, 1, body);
    assert.ok(run.last.trim(), body);
    assert.deepEqual(run.calls, [DRAFT_REPO], body + ': no list after refusal');
    assert.deepEqual(run.sleeps, [], body);
    for (const line of run.lines) {
      for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
        assert.ok(!line.includes(secret), `remote credentials leaked in ${JSON.stringify(line)}`);
      }
    }
    if (body === malformedJson) assert.equal(run.last, 'unreadable origin repository: GitHub CLI returned invalid JSON');
  }
  for (const origin of ['', '\n', 'first\nsecond\n', new Error('origin unavailable')]) {
    const run = await waitDraft([[0, JSON.stringify([draftPr()])]], undefined, { origin });
    assert.equal(run.status, 1, String(origin));
    assert.ok(run.last.trim());
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.sleeps, []);
  }
  const unreadable = await waitDraft([[0, malformedJson], [0, JSON.stringify([draftPr()])]]);
  assert.equal(unreadable.status, 1);
  assert.deepEqual(unreadable.calls, [DRAFT_REPO, DRAFT_LIST]);
  assert.deepEqual(unreadable.sleeps, []);
  for (const line of unreadable.lines) {
    for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
      assert.ok(!line.includes(secret), `remote credentials leaked in ${JSON.stringify(line)}`);
    }
  }
  assert.equal(unreadable.last, 'unreadable pull request list: GitHub CLI returned invalid JSON');
  const unavailable = await waitDraft([], undefined, { origin: `${unsafeUrl}\n`, repository: [1, `repository unavailable: ${unsafeUrl}`] });
  assert.equal(unavailable.status, 1);
  assert.deepEqual(unavailable.calls, [DRAFT_REPO.map((arg) => (arg === DRAFT_ORIGIN ? unsafeUrl : arg))]);
  for (const line of unavailable.lines) {
    for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
      assert.ok(!line.includes(secret), `remote credentials leaked in ${JSON.stringify(line)}`);
    }
  }
  assert.equal(unavailable.last, 'could not read origin repository; check Git and GitHub CLI installation, repository access and configuration');
  const valid = await waitDraft([[0, JSON.stringify([draftPr()])]]);
  assert.equal(valid.status, 0);
  assert.equal(valid.last, '12');
  assert.deepEqual(valid.gitCalls, [['remote', 'get-url', 'origin']]);
  assert.deepEqual(valid.calls, [DRAFT_REPO, DRAFT_LIST]);
});

test('ANTI-REGRESSION: cloud draft CLI binds reads to origin', (t) => {
  // Contaminate the Git configuration the CLI inherits: the cloud platform's url.<base>.insteadOf rewrite through the
  // environment, and a machine-wide rewrite in a global config file. runCli must isolate the CLI from both.
  const configDir = mkdtempSync(join(tmpdir(), 'merge-watch-gitconfig-'));
  const contamination = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:',
    GIT_CONFIG_GLOBAL: join(configDir, 'gitconfig'),
  };
  writeFileSync(contamination.GIT_CONFIG_GLOBAL, '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n');
  const prior = Object.fromEntries(Object.keys(contamination).map((key) => [key, process.env[key]]));
  Object.assign(process.env, contamination);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  for (const [label, pr, status] of [
    ['origin pull request', draftPr(), 0],
    ['fork copying content', draftPr({ headRepository: { id: 'R_fork' }, isCrossRepository: true, headRefOid: 'copied', body: 'copied' }), 1],
  ]) {
    const run = runCli(['--draft', 'job/7'], [], { draft: { origin: DRAFT_ORIGIN, reply: [0, JSON.stringify([pr])] } });
    assert.equal(run.status, status, label + ': ' + run.stdout + run.stderr);
    assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST], label + ': exact origin reads and no read after refusal');
    if (status === 0) assert.equal(run.lastOut, '12');
    else assert.equal(run.lastOut, `foreign or unverified pull request on job/7: ${JSON.stringify([pr])}`);
  }
});

test('ANTI-REGRESSION: draft CLI errors keep remote credentials out of both output streams', () => {
  const unsafeUrl = 'https://user:secret-token@github.com/o/r.git?token=query-secret';
  const run = runCli(['--draft', 'job/7'], [], { draft: { origin: unsafeUrl, reply: [1, `cannot access ${unsafeUrl}`] } });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST].map((args) => args.map((arg) => (arg === DRAFT_ORIGIN ? unsafeUrl : arg))));
  for (const output of [run.stdout, run.stderr]) {
    for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
      assert.ok(!output.includes(secret), `remote credentials leaked in ${JSON.stringify(output)}`);
    }
  }
  assert.equal(run.lastOut, 'could not list origin pull requests; check Git and GitHub CLI installation, repository access and configuration');
});

// The event route. GitHub's side follows the trial record: a forward's hook lists while the extension process holding
// it runs and goes when that process ends, unless a case keeps it listed.
const REPO = 'owner/repo';
const EVENTS = 'pull_request,push,check_run,status,workflow_job';
const FORWARD_ARGS = ['webhook', 'forward', '--repo', REPO, '--events', EVENTS];
const NOTICE = 'Forwarding Webhook events from GitHub...';
const RECORD_KEY = createHash('sha256').update(REPO).digest('hex').slice(0, 16);
const HOOK_ID = 81;
const OLD_HOOK_ID = 77;
const HOOK_CREATED = '2026-11-19T10:00:00Z';
const PAYLOAD_MARKER = 'payload-marker-5e1d';
const CONTEXT = { pr: '7', base: 'trunk', head: HEAD };
const INSTALL = 'install it with `gh extension install cli/gh-webhook`, then run the watch again';
const badGateway = (id) => `HTTP 502: Bad Gateway (https://api.github.com/repos/${REPO}/hooks/${id})`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const endsWith = (text) => new RegExp(`^.+${escapeRegExp(text)}$`);
const cliHook = (id, overrides = {}) => ({
  type: 'Repository',
  id,
  name: 'cli',
  active: true,
  events: EVENTS.split(',').sort(),
  config: { content_type: 'json', insecure_ssl: '0', url: 'https://webhook-forwarder.github.com/hook' },
  created_at: HOOK_CREATED,
  ...overrides,
});
const unprovedHook = (id) => `a forwarding webhook ${id} (created ${HOOK_CREATED}) is on ${REPO} and no merge watch on this machine can prove it its own; it goes when the forward holding it ends: end that forward (here, a leftover \`gh-webhook forward\` process), or if none runs anywhere delete it with \`gh api -X DELETE repos/${REPO}/hooks/${id}\`, then run the watch again`;
const notRemoved = (id, ghText) => `; the forwarding webhook ${id} on ${REPO} was not removed: ${ghText}; delete it with \`gh api -X DELETE repos/${REPO}/hooks/${id}\``;

// Process table rows: this watch, the forwarder each start spawns, and a crashed watch's processes under other PIDs.
const EXTENSION = '/home/user/.local/share/gh/extensions/gh-webhook/gh-webhook';
const SELF_STARTED = 'Thu Nov 19 10:00:00 2026';
const LATER = 'Thu Nov 19 11:00:00 2026';
const selfRow = (started = SELF_STARTED) => ({ pid: process.pid, ppid: 1, started, args: 'node scripts/merge-watch.mjs 7' });
const LAUNCHER_ROW = { pid: 5200, ppid: process.pid, started: 'Thu Nov 19 10:00:01 2026', args: `gh webhook forward --repo ${REPO} --events ${EVENTS}` };
const FORWARDER_ROW = { pid: 5300, ppid: 5200, started: 'Thu Nov 19 10:00:01 2026', args: `${EXTENSION} forward --repo ${REPO} --events ${EVENTS}` };
const OLD_WATCH = { pid: 4100, ppid: 1, started: 'Thu Nov 19 09:00:00 2026', args: 'node scripts/merge-watch.mjs 7' };
const OLD_LAUNCHER = { ...LAUNCHER_ROW, pid: 4200, ppid: 4100, started: 'Thu Nov 19 09:00:01 2026' };
const OLD_FORWARDER = { ...FORWARDER_ROW, pid: 4300, ppid: 1, started: 'Thu Nov 19 09:00:01 2026' };
const identity = ({ pid, started }) => ({ pid, started });
const crashedRecord = (overrides = {}) => ({
  watch: identity(OLD_WATCH),
  launcher: identity(OLD_LAUNCHER),
  forwarder: identity(OLD_FORWARDER),
  hookId: OLD_HOOK_ID,
  ...overrides,
});
const OPEN_RECORD = { watch: identity(selfRow()), launcher: identity(LAUNCHER_ROW), forwarder: identity(FORWARDER_ROW), hookId: HOOK_ID };

const HOOKS_LIST = /^repos\/(?:owner\/repo|\{owner\}\/\{repo\})\/hooks(?:\?per_page=\d+)?$/;
const HOOK_ITEM = /^repos\/(?:owner\/repo|\{owner\}\/\{repo\})\/hooks\/(\d+)$/;
const isHookList = (call) => readsOnly(call) && call.some((arg) => HOOKS_LIST.test(arg));
// The hook a call deletes, `gh api -X DELETE repos/<repo>/hooks/<id>`, or undefined for any other call.
function deletedHookId([group, flag, method, path, ...rest]) {
  const id = HOOK_ITEM.exec(path ?? '')?.[1];
  const deleting = group === 'api' && (flag === '-X' || flag === '--method') && method === 'DELETE' && rest.length === 0;
  return deleting && id !== undefined ? Number(id) : undefined;
}

function assertOwnHookWrites(calls, hookIds) {
  for (const call of calls) {
    assert.ok(
      readsOnly(call) || hookIds.includes(deletedHookId(call)),
      `the merge watch writes nothing to GitHub but its own forwarding hook, but called: gh ${call.join(' ')}`,
    );
  }
}

const stateDirs = [];
after(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

const GH_MISSING = Symbol('gh missing');
const CONNECTS = ['hook', ['stderr', NOTICE]];

// One route's world. `script` plays at the spawn: 'hook' creates this forward's hook, listed inactive for
// `activeAfter` lists; ['foreignHook', id] adds another forward's; ['stdout' | 'stderr', line] emits; ['exit', code]
// ends the forwarder. `world.forwarder` emits and exits on demand afterwards. `keepOwnHook` keeps this forward's hook
// listed after its forwarder ends, `orphanHookStays` the crashed watch's after its orphan is ended, and `onStop` runs
// after a stop. `record` is written as the existing record, raw when a string.
/** @typedef {{ pid: number, ppid: number, started: string, args: string }} ProcessRow */
/** @typedef {{ id: number, name?: string, active?: boolean, inactiveLists?: number }} Hook */
/**
 * @typedef {{ hooks?: Hook[], table?: ProcessRow[], script?: (string | unknown[])[], activeAfter?: number, keepOwnHook?: boolean,
 *   orphanHookStays?: boolean, onStop?: (world: ReturnType<typeof routeWorld>) => void, repoReply?: [number, string] | typeof GH_MISSING, hookList?: [number, string],
 *   deleteReply?: [number, string], tableFailure?: 'always' | 'spawned', record?: string | object, platform?: string }} RouteWorldOptions
 */
/** @param {RouteWorldOptions} [options] */
function routeWorld({
  hooks = [], table = [], script = CONNECTS, activeAfter = 0, keepOwnHook = false, orphanHookStays = false, onStop,
  repoReply, hookList, deleteReply, tableFailure, record, platform = 'linux',
} = {}) {
  const stateDir = mkdtempSync(join(realpathSync(tmpdir()), 'merge-watch-state-'));
  stateDirs.push(stateDir);
  const world = {
    stateDir,
    recordPath: join(stateDir, `${RECORD_KEY}.json`),
    hooks: hooks.map((hook) => ({ ...hook })),
    table: [selfRow(), ...table],
    calls: /** @type {string[][]} */ ([]),
    deletes: /** @type {number[]} */ ([]),
    listings: /** @type {{ at: number, ownActive: boolean | undefined }[]} */ ([]),
    spawns: /** @type {string[][]} */ ([]),
    stops: /** @type {number[]} */ ([]),
    ends: /** @type {{ pid: number, started: string }[]} */ ([]),
    sleeps: /** @type {number[]} */ ([]),
    clock: START_CLOCK,
    deleteReply,
    forwarder: /** @type {{ emit: (stream: string, line: string) => void, exit: (code: number | null) => void } | undefined} */ (undefined),
  };
  if (record !== undefined) {
    writeFileSync(world.recordPath, typeof record === 'string' ? record : JSON.stringify(record), { mode: 0o600 });
  }

  const listHooks = () => world.hooks.map((stored) => {
    const { inactiveLists, ...hook } = stored;
    if (inactiveLists === undefined) return hook;
    if (inactiveLists > 0) stored.inactiveLists = inactiveLists - 1;
    return { ...hook, active: inactiveLists === 0 };
  });
  /** @returns {[number, string]} */
  const reply = (args) => {
    if (args.includes('--jq')) return [99, 'fake gh: the fake applies no --jq'];
    const deleted = deletedHookId(args);
    if (deleted !== undefined) {
      world.deletes.push(deleted);
      if (world.deleteReply) return world.deleteReply;
      world.hooks = world.hooks.filter((hook) => hook.id !== deleted);
      return [0, ''];
    }
    if (!readsOnly(args) || args[0] !== 'api') return [99, `fake gh: unexpected call: ${args.join(' ')}`];
    if (args.includes('repos/{owner}/{repo}')) {
      if (repoReply === GH_MISSING) {
        throw Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT', syscall: 'spawnSync gh', path: 'gh' });
      }
      return repoReply ?? [0, JSON.stringify({ full_name: REPO })];
    }
    if (isHookList(args)) {
      if (!args.includes('--paginate') || !args.includes('--slurp')) return [99, 'fake gh: a hook list was not paginated and slurped'];
      const shown = listHooks();
      world.listings.push({ at: world.calls.length - 1, ownActive: shown.find((hook) => hook.id === HOOK_ID)?.active });
      return hookList ?? [0, JSON.stringify([shown])];
    }
    return [99, `fake gh: unexpected call: ${args.join(' ')}`];
  };

  world.seams = {
    ghExec: (args) => {
      world.calls.push(args);
      const [code, body] = reply(args);
      if (code === 0) return `${body}\n`;
      throw Object.assign(new Error(body), { status: code, stdout: '', stderr: `${body}\n` });
    },
    spawnForwarder: (args, { onStdout, onStderr, onExit }) => {
      world.spawns.push(args);
      world.table.push({ ...LAUNCHER_ROW }, { ...FORWARDER_ROW });
      let ended = false;
      const end = (code) => {
        if (ended) return;
        ended = true;
        world.table = world.table.filter((row) => row.pid !== LAUNCHER_ROW.pid && row.pid !== FORWARDER_ROW.pid);
        if (!keepOwnHook) world.hooks = world.hooks.filter((hook) => hook.id !== HOOK_ID);
        queueMicrotask(() => onExit(code));
      };
      const emit = (stream, line) => (stream === 'stdout' ? onStdout : onStderr)(line);
      world.forwarder = { emit, exit: end };
      const play = (action) => {
        if (action === 'hook') world.hooks.push({ ...cliHook(HOOK_ID), inactiveLists: activeAfter });
        else if (action[0] === 'foreignHook') world.hooks.push(cliHook(action[1]));
        else if (action[0] === 'exit') end(action[1]);
        else if (!ended) emit(action[0], action[1]);
      };
      script.reduce((played, action) => played.then(() => play(action)), Promise.resolve());
      return {
        pid: LAUNCHER_ROW.pid,
        stop: () => {
          world.stops.push(world.calls.length);
          end(null);
          onStop?.(world);
        },
      };
    },
    readProcessTable: () => {
      if (tableFailure === 'always' || (tableFailure === 'spawned' && world.spawns.length > 0)) {
        throw new Error('ps: cannot read the process table');
      }
      return world.table.map((row) => ({ ...row }));
    },
    endProcess: (target) => {
      world.ends.push(identity(target));
      world.table = world.table.filter((row) => row.pid !== target.pid);
      if (target.pid === OLD_FORWARDER.pid && !orphanHookStays) world.hooks = world.hooks.filter((hook) => hook.id !== OLD_HOOK_ID);
    },
    stateDir,
    sleep: async (ms) => {
      world.sleeps.push(ms);
      world.clock += ms;
      if (world.sleeps.length > 1000) throw new Error('the route did not stop sleeping');
      await new Promise((resolve) => setImmediate(resolve));
    },
    now: () => world.clock,
    platform,
  };
  return world;
}

async function openRoute(world) {
  // Called outside the try, so a missing export fails as itself.
  const opening = watchLib.openEventRoute(world.seams);
  try {
    return { route: await opening };
  } catch (error) {
    return { error };
  }
}

/**
 * @template R
 * @param {{ route?: R, error?: unknown }} opened
 * @param {string} label
 * @returns {asserts opened is { route: R }}
 */
function assertOpened(opened, label) {
  assert.ok(opened.route, `${label} must open the route, but it stopped: ${/** @type {Error | undefined} */ (opened.error)?.message}`);
}

function stopReason(opened, label) {
  assert.equal(opened.route, undefined, `${label} must not open the route`);
  const { message } = opened.error;
  assert.ok(message.trim() !== '' && !message.includes('\n'), `${label} must stop with one line: ${JSON.stringify(message)}`);
  return message;
}

const readRecord = (world) => (existsSync(world.recordPath) ? JSON.parse(readFileSync(world.recordPath, 'utf8')) : null);
const deleteAt = (world) => world.calls.findIndex((call) => deletedHookId(call) !== undefined);
const listsBetween = (world, from, to) => world.listings.filter(({ at }) => at >= from && at < to).length;
const readsNoPullRequest = (world) => world.calls.every((call) => call[0] !== 'pr' && !call.some((arg) => /\/(pulls|issues)(\/|$)/.test(arg)));

// The real process ender re-reads the table just before its signal: the recorded forwarder matches while recovery
// finds it, then its creation time differs on the ender's own read, so the live process it would have signalled stays.
test('the real process ender leaves a recorded process whose identity changed after recovery matched it', { skip: process.platform === 'win32' ? 'the claim is the POSIX TERM path of ending a recorded process' : false }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const recorded = { pid: child.pid, ppid: process.pid, started: SELF_STARTED, args: FORWARDER_ROW.args };
  const world = routeWorld({ record: crashedRecord({ launcher: null, forwarder: identity(recorded), hookId: null }) });
  const { endProcess, readProcessTable, ...seams } = world.seams;
  let reads = 0;
  const opened = await watchLib.openEventRoute({
    ...seams,
    // Reads 1 to 3 are this watch's row, the recorded watch and the recorded forwarder; read 4 is the ender's own.
    readProcessTable: () => {
      reads += 1;
      if (reads <= 3) return [selfRow(), recorded];
      return reads === 4 ? [selfRow(), { ...recorded, started: LATER }] : readProcessTable();
    },
  });
  await opened.close();
  assert.ok(reads >= 4, `the ender must have read the table itself: ${reads} reads`);
  assert.equal(isAlive(child.pid), true, 'the process whose identity changed is left running');
});

test('recovery from a record', async () => {
  for (const row of [
    {
      label: '(a) the recorded watch still running',
      options: { record: crashedRecord(), table: [OLD_WATCH, OLD_FORWARDER], hooks: [cliHook(OLD_HOOK_ID)] },
      reason: `another merge watch is running for ${REPO} (process ${OLD_WATCH.pid}); wait for it to end`,
      ends: [],
      deletes: [],
    },
    {
      label: '(b) the watch PID reused by another program',
      options: { record: crashedRecord(), table: [{ pid: OLD_WATCH.pid, ppid: 1, started: LATER, args: 'vim notes.txt' }] },
      ends: [],
      deletes: [],
    },
    {
      label: '(c) the watch PID reused by a later merge watch',
      options: { record: crashedRecord(), table: [{ ...OLD_WATCH, started: LATER, args: 'node scripts/merge-watch.mjs 9' }] },
      ends: [],
      deletes: [],
    },
    {
      label: '(d) a crash after the hook id was learned, its forwarder orphaned',
      options: { record: crashedRecord(), table: [OLD_FORWARDER], hooks: [cliHook(OLD_HOOK_ID)], orphanHookStays: true },
      ends: [identity(OLD_FORWARDER)],
      deletes: [OLD_HOOK_ID],
      listsBeforeDelete: 11,
    },
    {
      label: '(e) the same crash on Windows',
      options: { record: crashedRecord(), table: [OLD_FORWARDER], hooks: [cliHook(OLD_HOOK_ID)], orphanHookStays: true, platform: 'win32' },
      ends: [identity(OLD_FORWARDER)],
      deletes: [OLD_HOOK_ID],
      listsBeforeDelete: 11,
    },
    {
      label: '(f) a crash before the hook id was learned, a cli hook listed',
      options: { record: crashedRecord({ forwarder: null, hookId: null }), hooks: [cliHook(88)] },
      reason: unprovedHook(88),
      ends: [],
      deletes: [],
    },
    {
      label: '(h) the forwarder PID reused by another process',
      options: { record: crashedRecord(), table: [{ pid: OLD_FORWARDER.pid, ppid: 1, started: LATER, args: 'node server.js' }] },
      ends: [],
      deletes: [],
    },
  ]) {
    const world = routeWorld(row.options);
    const recorded = readFileSync(world.recordPath, 'utf8');
    const opened = await openRoute(world);
    if (row.reason === undefined) {
      assertOpened(opened, row.label);
      assert.deepEqual(world.spawns, [FORWARD_ARGS], `${row.label} must go on to start its own forwarder`);
      assert.deepEqual(readRecord(world), OPEN_RECORD, `${row.label} must replace the old record with its own`);
    } else {
      assert.equal(stopReason(opened, row.label), row.reason, row.label);
      assert.deepEqual(world.spawns, [], `${row.label} must start no forwarder`);
    }
    assert.deepEqual(world.ends, row.ends, `${row.label}: processes ended`);
    assert.deepEqual(world.deletes, row.deletes, `${row.label}: hooks deleted`);
    if (row.listsBeforeDelete !== undefined) {
      assert.equal(listsBetween(world, 0, deleteAt(world)), row.listsBeforeDelete, `${row.label} must list, then re-list 10 times while the recorded hook stays`);
    }
    if (row.label.startsWith('(a)')) assert.equal(readFileSync(world.recordPath, 'utf8'), recorded, 'a running watch keeps its record');
    if (opened.route) await opened.route.close();
  }

  /** @type {[number, string]} */
  const failure = [1, badGateway(OLD_HOOK_ID)];
  const world = routeWorld({ record: crashedRecord({ launcher: null, forwarder: null }), hooks: [cliHook(OLD_HOOK_ID)], deleteReply: failure });
  const failed = stopReason(await openRoute(world), '(g) a failed delete');
  assert.match(failed, endsWith(notRemoved(OLD_HOOK_ID, badGateway(OLD_HOOK_ID))));
  assert.equal(readRecord(world)?.hookId, OLD_HOOK_ID, '(g) a failed delete keeps the recorded hook id');
  assert.deepEqual(world.spawns, []);
  // The next start is another process, so this process's own row carries a new creation time.
  world.table = [selfRow(LATER)];
  world.deleteReply = undefined;
  const retried = await openRoute(world);
  assertOpened(retried, '(g) the next start');
  assert.deepEqual(world.deletes, [OLD_HOOK_ID, OLD_HOOK_ID], '(g) the next start deletes the kept hook id');
  assert.deepEqual(world.spawns, [FORWARD_ARGS]);
  await retried.route.close();

  const label = '(i) a recorded hook id naming a listed hook that is not a forwarding hook';
  const deployHook = cliHook(OLD_HOOK_ID, { name: 'web', config: { content_type: 'json', insecure_ssl: '0', url: 'https://deploy.example/hook' } });
  const foreign = routeWorld({ record: crashedRecord(), hooks: [deployHook] });
  const foreignRecord = readFileSync(foreign.recordPath, 'utf8');
  const foreignOpened = await openRoute(foreign);
  if (foreignOpened.route) await foreignOpened.route.close();
  assert.deepEqual(foreign.deletes, [], `${label}: deletes no hook`);
  const reason = stopReason(foreignOpened, label);
  assert.match(reason, /does not name a forwarding webhook/, `${label}: the reason says the record names no forwarding webhook`);
  assert.ok(reason.includes(foreign.recordPath), `${label}: the reason names the record: ${reason}`);
  assert.match(reason, /no merge watch .*runs, delete it/, `${label}: the reason says to delete the record once no merge watch runs`);
  assert.deepEqual(foreign.spawns, [], `${label}: starts no forwarder`);
  assert.equal(readFileSync(foreign.recordPath, 'utf8'), foreignRecord, `${label}: the record is left for the owner to delete`);
});

test('closing the route never deletes a recorded hook id whose listed hook is not a forwarding hook', async () => {
  const world = routeWorld({ keepOwnHook: true });
  const opened = await openRoute(world);
  assertOpened(opened, 'a connected forward');
  world.hooks = world.hooks.map((hook) => (hook.id === HOOK_ID ? { ...hook, name: 'web' } : hook));
  await opened.route.close().catch(() => {});
  assert.deepEqual(world.deletes, [], 'a hook listed under the recorded id but not named cli is not this watch\'s forwarding hook');
});

test('startup cleanup deletes only the hook id recorded before the forwarder stopped', async () => {
  for (const row of [
    {
      label: '(a) the notice, then never active',
      options: { activeAfter: Infinity, keepOwnHook: true },
      reason: /active/,
      deletes: [HOOK_ID],
      listsAfterStop: 6,
      clean: true,
    },
    {
      label: '(b) an exit after creation, before the id was recorded',
      options: { script: ['hook', ['stderr', 'error dialing to ws server: dial tcp: lookup webhook-forwarder.github.com: no such host'], ['exit', 1]], keepOwnHook: true },
      reason: unprovedHook(HOOK_ID),
      deletes: [],
    },
    {
      label: '(c) another forward\'s hook listed once the recorded one is gone',
      options: { activeAfter: Infinity, onStop: (world) => world.hooks.push(cliHook(99)) },
      reason: /active/,
      deletes: [],
      clean: true,
    },
    {
      label: '(d) an exit at creation',
      options: { script: [['stderr', `Error: error creating webhook: HTTP 404: Not Found (https://api.github.com/repos/${REPO}/hooks)`], ['exit', 1]] },
      reason: /error creating webhook: HTTP 404: Not Found/,
      deletes: [],
      clean: true,
    },
    {
      label: '(e) an exit at a stage the forwarder does not name',
      options: { script: ['hook', ['stderr', 'panic: runtime error: invalid memory address or nil pointer dereference'], ['exit', 2]], keepOwnHook: true },
      reason: unprovedHook(HOOK_ID),
      deletes: [],
    },
  ]) {
    const world = routeWorld(row.options);
    const reason = stopReason(await openRoute(world), row.label);
    if (typeof row.reason === 'string') assert.equal(reason, row.reason, row.label);
    else assert.match(reason, row.reason, row.label);
    assert.deepEqual(world.spawns, [FORWARD_ARGS], row.label);
    assert.ok(world.stops.length >= 1, `${row.label} must stop the forwarder`);
    assert.deepEqual(world.deletes, row.deletes, `${row.label}: hooks deleted`);
    assert.ok(readsNoPullRequest(world), `${row.label} must read no pull request`);
    if (row.listsAfterStop !== undefined) {
      assert.equal(listsBetween(world, world.stops[0], deleteAt(world)), row.listsAfterStop, `${row.label} must list, then re-list 5 times while the recorded hook stays`);
    }
    if (row.clean) assert.equal(readRecord(world), null, `${row.label}: a clean stop removes the record`);
  }
});

test('coordinated startup cleanup retains unproved forwarding hooks', {
  skip: process.platform === 'win32' && 'coordinated delivery requires POSIX ownership and private modes',
}, async () => {
  for (const outcome of ['unproved', 'unreadable relist', 'recorded']) {
    let stoppedRecord;
    const world = routeWorld({
      script: outcome === 'recorded' ? CONNECTS : ['hook', ['stderr', 'forwarder aborted'], ['exit', 1]],
      activeAfter: Infinity,
      keepOwnHook: true,
      onStop: ({ recordPath, hooks }) => {
        stoppedRecord = readFileSync(recordPath, 'utf8');
        if (outcome === 'recorded') hooks.push(cliHook(99));
      },
    });
    const ghExec = world.seams.ghExec;
    world.seams.ghExec = (args) => {
      if (outcome === 'unreadable relist' && stoppedRecord !== undefined && isHookList(args)) {
        throw new Error('fixture cannot relist hooks');
      }
      return ghExec(args);
    };
    let checked = false;
    world.seams.coordinated = {
      repo: REPO,
      beforeForward: async () => {
        assert.deepEqual(readRecord(world), { watch: identity(selfRow()), launcher: null, forwarder: null, hookId: null });
        assert.deepEqual(world.spawns, []);
        checked = true;
      },
    };
    const reason = stopReason(await openRoute(world), outcome);
    assert.deepEqual(world.spawns, [FORWARD_ARGS], outcome);
    if (outcome === 'recorded') {
      assert.match(reason, /did not become active/);
      assert.deepEqual(world.deletes, [HOOK_ID], 'only the recorded hook may be deleted');
      assert.deepEqual(world.hooks.map(({ id }) => id), [99]);
      assert.equal(readRecord(world), null);
    } else {
      if (outcome === 'unproved') assert.equal(reason, unprovedHook(HOOK_ID));
      else assert.match(reason, /could not list the forwarding webhooks.*fixture cannot relist hooks/);
      assert.deepEqual(world.deletes, [], outcome);
      assert.deepEqual(world.hooks.map(({ id }) => id), [HOOK_ID]);
      assert.equal(existsSync(world.recordPath), true, `${outcome}: retain the coordinated record for its owning job`);
      assert.equal(readFileSync(world.recordPath, 'utf8'), stoppedRecord);
    }
    assert.equal(checked, true);
  }
});

test('a hook listed after this watch\'s own forwarder has ended is never adopted', async () => {
  const world = routeWorld();
  const ghExec = world.seams.ghExec;
  let listsAfterSpawn = 0;
  // The forwarder ends while the hook list after the notice is in flight, and another forward's hook 99 takes its place.
  world.seams.ghExec = (args) => {
    if (isHookList(args) && world.spawns.length > 0 && (listsAfterSpawn += 1) === 1) {
      assert.ok(world.forwarder, 'a spawned forwarder is recorded');
      world.forwarder.exit(1);
      world.hooks.push(cliHook(99));
    }
    return ghExec(args);
  };
  const opened = await openRoute(world);
  if (opened.route) await opened.route.close().catch(() => {});
  assert.deepEqual(world.deletes, [], 'the replacement hook 99 is not deleted');
  assert.equal(stopReason(opened, 'a forwarder that ended during the hook list'), unprovedHook(99));
  assert.ok(readsNoPullRequest(world), 'the stopped start reads no pull request');
});

test('ending the watch stops the whole forwarder tree and removes the record', async () => {
  const world = routeWorld();
  const opened = await openRoute(world);
  assertOpened(opened, 'a connected forward');
  assert.ok(existsSync(world.recordPath), 'an open route keeps its record');
  await opened.route.close();
  assert.equal(world.stops.length, 1, 'the forwarder is stopped once');
  assert.equal(existsSync(world.recordPath), false, 'the record is removed');
  assert.deepEqual(world.deletes, [], 'a hook GitHub removed with its forwarder needs no delete');
  assert.deepEqual(world.ends, [], 'the live forwarder is stopped as its own tree, never ended by a recorded identity');
});

test('a hook still listed after the forwarder stops is deleted by its recorded id', async () => {
  for (const [label, deleteReply] of /** @satisfies {[string, [number, string] | undefined][]} */ ([['a delete that succeeds', undefined], ['a delete GitHub answers with 404', [1, 'gh: Not Found (HTTP 404)']]])) {
    const world = routeWorld({ keepOwnHook: true, deleteReply });
    const opened = await openRoute(world);
    assertOpened(opened, label);
    await opened.route.close();
    assert.deepEqual(world.deletes, [HOOK_ID], `${label}: the recorded hook is deleted`);
    assert.equal(listsBetween(world, world.stops[0], deleteAt(world)), 6, `${label}: list, then re-list 5 times while the hook stays`);
    assert.equal(existsSync(world.recordPath), false, `${label}: the record is removed`);
  }
});

test('a failed cleanup exits 1 with the delete command and keeps the hook id', async () => {
  /** @type {[number, string]} */
  const failure = [1, badGateway(HOOK_ID)];
  const ending = routeWorld({ keepOwnHook: true, deleteReply: failure });
  const opened = await openRoute(ending);
  assertOpened(opened, 'a connected forward');
  await assert.rejects(opened.route.close(), (err) => {
    const { message } = /** @type {Error} */ (err);
    assert.match(message, endsWith(notRemoved(HOOK_ID, badGateway(HOOK_ID))));
    assert.ok(!message.includes('\n'), 'the reason is one line');
    return true;
  });
  assert.equal(readRecord(ending)?.hookId, HOOK_ID, 'a failed delete at the end keeps the hook id');

  const starting = routeWorld({ activeAfter: Infinity, keepOwnHook: true, deleteReply: failure });
  const reason = stopReason(await openRoute(starting), 'a start whose hook never became active');
  assert.match(reason, endsWith(notRemoved(HOOK_ID, badGateway(HOOK_ID))));
  assert.match(reason, /active/, 'the reason names the startup failure before the cleanup one');
  assert.equal(readRecord(starting)?.hookId, HOOK_ID, 'a failed delete at the start keeps the hook id');
});

test('an unreadable record, process table or hook list stops with no GitHub write', async () => {
  for (const [label, raw] of [
    ['text that is not JSON', 'not json'],
    ['a list', '[]'],
    ['a PID that is a string', JSON.stringify(crashedRecord({ watch: { pid: '4100', started: OLD_WATCH.started } }))],
    ['a PID of 0', JSON.stringify(crashedRecord({ launcher: { pid: 0, started: OLD_LAUNCHER.started } }))],
    ['a negative PID', JSON.stringify(crashedRecord({ forwarder: { pid: -1, started: OLD_FORWARDER.started } }))],
    ['a creation time that is not a string', JSON.stringify(crashedRecord({ watch: { pid: OLD_WATCH.pid, started: 7 } }))],
    ['a hook id that is a string', JSON.stringify(crashedRecord({ hookId: String(OLD_HOOK_ID) }))],
  ]) {
    const world = routeWorld({ record: raw, table: [OLD_FORWARDER], hooks: [cliHook(OLD_HOOK_ID)] });
    const reason = stopReason(await openRoute(world), `a record holding ${label}`);
    assert.ok(reason.includes(world.recordPath), `a record holding ${label} must be named: ${reason}`);
    assert.deepEqual(world.spawns, [], `a record holding ${label} starts no forwarder`);
    assert.deepEqual(world.deletes, [], `a record holding ${label} deletes no hook`);
    assert.deepEqual(world.ends, [], `a record holding ${label} ends no process`);
    assert.equal(readFileSync(world.recordPath, 'utf8'), raw, `a record holding ${label} is left as it is`);
  }

  const noTable = routeWorld({ tableFailure: 'always' });
  assert.ok(stopReason(await openRoute(noTable), 'an unreadable process table').includes('ps: cannot read the process table'));
  assert.deepEqual(noTable.spawns, []);
  assert.deepEqual(noTable.deletes, []);
  assert.equal(existsSync(noTable.recordPath), false, 'no record is written without this watch\'s identity');

  const tableAfterSpawn = routeWorld({ tableFailure: 'spawned' });
  assert.ok(stopReason(await openRoute(tableAfterSpawn), 'a process table unreadable after the spawn').includes('ps: cannot read the process table'));
  assert.ok(tableAfterSpawn.stops.length >= 1, 'the forwarder is stopped');
  assert.deepEqual(tableAfterSpawn.deletes, []);
  assert.deepEqual(tableAfterSpawn.ends, []);
  assert.equal(readRecord(tableAfterSpawn), null, 'a clean stop removes the record');

  const listFailure = `HTTP 502: Bad Gateway (https://api.github.com/repos/${REPO}/hooks)`;
  for (const [label, hookList, reason] of /** @satisfies {[string, [number, string], RegExp][]} */ ([
    ['a gh failure', [1, listFailure], new RegExp(escapeRegExp(listFailure))],
    ['an object', [0, '{}'], /unreadable/],
    ['one flat page', [0, JSON.stringify([cliHook(99)])], /unreadable/],
    ['a hook id that is a string', [0, JSON.stringify([[cliHook('99')]])], /unreadable/],
  ])) {
    const world = routeWorld({ hookList });
    assert.match(stopReason(await openRoute(world), `a hook list with ${label}`), reason, `a hook list with ${label}`);
    assert.deepEqual(world.spawns, [], `a hook list with ${label} starts no forwarder`);
    assert.deepEqual(world.deletes, [], `a hook list with ${label} deletes no hook`);
    assert.equal(readRecord(world), null, `a hook list with ${label}: a clean stop removes the record`);
  }
});

test('the first pull request read comes after the hook is active', async () => {
  const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: HOOK_ID, hook: cliHook(HOOK_ID) });
  const world = routeWorld({ activeAfter: 2, script: [...CONNECTS, ['stdout', ping]] });
  const opened = await openRoute(world);
  assertOpened(opened, 'a forward whose hook turns active on the third list');
  assert.deepEqual(world.listings.map(({ ownActive }) => ownActive), [undefined, false, false, true], 'one list before the spawn, then lists until the hook is active');
  assert.equal(world.listings.at(-1)?.at, world.calls.length - 1, 'the route opens on the list that shows the hook active, with no call after it');
  assert.ok(readsNoPullRequest(world), 'the route reads no pull request');
  assert.deepEqual(readRecord(world), OPEN_RECORD, 'the record holds this watch, its forwarder and the hook id');
  assert.deepEqual(await opened.route.nextWake({ deadline: undefined, context: CONTEXT }), { wake: 'event' }, 'a line before the hook was active is a pending wake');
  await opened.route.close();
});

test('ANTI-REGRESSION: with no event route the watch stops naming the cause and what to do, and reads no pull request', async () => {
  for (const row of /** @satisfies {{ label: string, options: RouteWorldOptions, check: (reason: string) => void }[]} */ ([
    {
      label: 'gh missing',
      options: { repoReply: GH_MISSING },
      check: (reason) => {
        assert.match(reason, /GitHub CLI `gh` is not installed or not on PATH/, `the missing command must be named plainly: ${reason}`);
        assert.match(reason, /install it.*then run the watch again$/, `the reason must say what to do: ${reason}`);
      },
    },
    {
      label: 'the extension not installed',
      options: { script: [['stderr', 'unknown command "webhook" for "gh"'], ['stderr', ''], ['stderr', 'Usage:  gh <command> <subcommand> [flags]'], ['exit', 1]] },
      check: (reason) => assert.ok(reason.endsWith(INSTALL), reason),
    },
    {
      label: 'no access to repository webhooks',
      options: { script: [['stderr', 'you do not have access to this feature'], ['exit', 1]] },
      check: (reason) => {
        assert.ok(reason.includes('admin:repo_hook'), `the token scope must be named: ${reason}`);
        assert.match(reason.replaceAll('admin:repo_hook', ''), /\badmin\b/i, 'admin access must be named');
      },
    },
    { label: 'a forwarding hook already on the repository', options: { hooks: [cliHook(99)] }, check: (reason) => assert.equal(reason, unprovedHook(99)) },
    {
      label: 'a forwarding hook created while this forward started',
      options: {
        script: [
          ['foreignHook', 99],
          ['stderr', `Error: error creating webhook: HTTP 422: Validation Failed (https://api.github.com/repos/${REPO}/hooks)`],
          ['stderr', 'Hook already exists on this repository'],
          ['exit', 1],
        ],
      },
      check: (reason) => assert.equal(reason, unprovedHook(99)),
    },
    { label: 'no notice within 30 seconds', options: { script: ['hook'] }, check: (reason) => assert.match(reason, /30 seconds/) },
    { label: 'a hook never active', options: { activeAfter: Infinity }, check: (reason) => assert.match(reason, /active/) },
  ])) {
    const world = routeWorld(row.options);
    row.check(stopReason(await openRoute(world), row.label));
    assert.ok(readsNoPullRequest(world), `${row.label} must read no pull request`);
    assert.deepEqual(world.deletes, [], `${row.label} deletes no hook`);
    if (world.spawns.length > 0) assert.ok(world.stops.length >= 1, `${row.label} must stop the forwarder it started`);
    if (row.label === 'no notice within 30 seconds') assert.ok(world.clock - START_CLOCK >= 30_000, 'the notice is awaited for 30 seconds');
  }

  const world = routeWorld();
  const opened = await openRoute(world);
  assertOpened(opened, 'a connected forward');
  assert.ok(world.forwarder, 'an open route has a forwarder');
  world.forwarder.emit('stderr', 'unable to connect to webhooks server, forwarding stopped');
  world.forwarder.exit(1);
  const woke = await opened.route.nextWake({ deadline: undefined, context: CONTEXT });
  assert.equal(woke.wake, 'ended', 'a forwarder that ends mid-watch ends the wait');
  assert.ok(woke.reason, 'an ended wait carries its reason');
  assert.match(woke.reason, /^the GitHub event route stopped: .*unable to connect to webhooks server, forwarding stopped.*; run the watch again$/);
  await opened.route.close();
  assert.ok(readsNoPullRequest(world), 'a forwarder ending mid-watch reads no pull request');
  assert.equal(existsSync(world.recordPath), false);
});

test('ANTI-REGRESSION: payload text never reaches output', async (t) => {
  const printed = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest); });
  }
  for (const method of /** @type {('log' | 'error' | 'warn' | 'info' | 'debug')[]} */ (['log', 'error', 'warn', 'info', 'debug'])) {
    t.mock.method(console, method, (...args) => printed.push(args.join(' ')));
  }
  const ping = JSON.stringify({ zen: `Keep it logically awesome. ${PAYLOAD_MARKER}`, hook_id: HOOK_ID, hook: cliHook(HOOK_ID) });
  const push = JSON.stringify({ ref: 'refs/heads/trunk', before: OTHER_HEAD, after: HEAD, head_commit: { message: PAYLOAD_MARKER } });
  const world = routeWorld({ script: [...CONNECTS, ['stdout', ping]] });
  const opened = await openRoute(world);
  assertOpened(opened, 'a connected forward');
  const recordText = readFileSync(world.recordPath, 'utf8');
  assert.ok(world.forwarder, 'an open route has a forwarder');
  const nextWake = () => opened.route.nextWake({ deadline: undefined, context: CONTEXT });
  const wakes = [await nextWake()];
  world.forwarder.emit('stdout', push);
  wakes.push(await nextWake());
  world.forwarder.emit('stdout', `{"unterminated": "${PAYLOAD_MARKER}`);
  wakes.push(await nextWake());
  world.forwarder.emit('stderr', 'unable to connect to webhooks server, forwarding stopped');
  world.forwarder.exit(1);
  const ended = await nextWake();
  await opened.route.close();
  assert.deepEqual(wakes, [{ wake: 'event' }, { wake: 'event' }, { wake: 'event' }], 'a payload wakes the watch and carries nothing out');
  assert.equal(ended.wake, 'ended');

  const failing = routeWorld({ script: ['hook', ['stdout', push], ['stderr', 'error dialing to ws server: websocket: bad handshake'], ['exit', 1]] });
  const failed = stopReason(await openRoute(failing), 'a forward that fails after a payload line');
  for (const text of [recordText, JSON.stringify(ended), failed, ...printed]) {
    assert.ok(!text.includes(PAYLOAD_MARKER), `payload text reached output: ${text}`);
  }
});

test('ANTI-REGRESSION: the command with no event route stops with the reason and reads no pull request', async () => {
  const reason = `gh-webhook is not installed: ${INSTALL}`;
  const calls = [];
  const lines = [];
  const sleeps = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const status = await main(['7'], {
    ghExec: (args) => { calls.push(args); throw Object.assign(new Error('no gh reply'), { status: 1, stdout: '', stderr: '' }); },
    output,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => START_CLOCK,
    openRoute: async () => { throw new Error(reason); },
  });
  assert.equal(status, 1);
  assert.equal(lines.at(-1), reason);
  assert.deepEqual(calls.filter((call) => call[0] === 'pr'), [], 'no pull request is read');
  assert.deepEqual(sleeps, [], 'no timer wait stands in for the missing route');
});

test('ANTI-REGRESSION: the merge watch writes nothing to GitHub but its own forwarding hook', async () => {
  const run = await watch([{ view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls.map(callKind), ['base', 'branch', 'rules', 'view', 'checks', 'timeline', 'runs', 'view']);
  for (const write of [
    ['pr', 'merge', '7'], ['pr', 'ready', '7'], ['pr', 'comment', '7'], ['issue', 'edit', '7'],
    ['api', '-X', 'PATCH', 'repos/{owner}/{repo}/pulls/7'], ['api', 'repos/{owner}/{repo}/issues/7/comments', '-f', 'body=x'],
    FORWARD_ARGS, ['api', '-X', 'POST', `repos/${REPO}/hooks`], ['api', '-X', 'DELETE', `repos/${REPO}/hooks/99`],
    ['api', '-X', 'PATCH', `repos/${REPO}/hooks/${HOOK_ID}`, '-F', 'active=false'],
  ]) {
    assert.throws(() => assertOwnHookWrites([write], [HOOK_ID]), /writes nothing to GitHub but its own forwarding hook/, `the check must refuse gh ${write.join(' ')}`);
  }

  const ending = routeWorld({ keepOwnHook: true });
  const opened = await openRoute(ending);
  assertOpened(opened, 'a forward whose hook outlives it');
  await opened.route.close();
  const recovering = routeWorld({ record: crashedRecord(), table: [OLD_FORWARDER], hooks: [cliHook(OLD_HOOK_ID)], orphanHookStays: true });
  const recovered = await openRoute(recovering);
  assertOpened(recovered, 'a start after a crash');
  await recovered.route.close();
  for (const [world, hookId] of /** @type {[typeof ending, number][]} */ ([[ending, HOOK_ID], [recovering, OLD_HOOK_ID]])) {
    assertOwnHookWrites(world.calls, [hookId]);
    assert.deepEqual(world.deletes, [hookId], 'only the recorded hook is deleted');
    assert.deepEqual(world.spawns, [FORWARD_ARGS], 'the one forward is on the watched repository');
  }

  for (const fullName of ['owner/repo --url=https://attacker.example', 'owner/../other', 'owner/repo/hooks', 'owner', 7, null]) {
    const world = routeWorld({ repoReply: [0, JSON.stringify({ full_name: fullName })] });
    stopReason(await openRoute(world), `a repository named ${JSON.stringify(fullName)}`);
    assert.deepEqual(world.spawns, [], `a repository named ${JSON.stringify(fullName)} gets no forward`);
    assert.deepEqual(world.deletes, []);
  }
});

test('ANTI-REGRESSION: the watch ends only processes whose recorded identity matches', async () => {
  for (const row of [
    { label: 'a forwarder PID now running another program', table: [{ ...OLD_FORWARDER, args: 'node server.js' }], ends: [] },
    { label: 'a forwarder PID now forwarding another repository', table: [{ ...OLD_FORWARDER, args: OLD_FORWARDER.args.replace(REPO, 'owner/other') }], ends: [] },
    { label: 'a forwarder PID with another creation time', table: [{ ...OLD_FORWARDER, started: LATER }], ends: [] },
    { label: 'a launcher PID now running another gh command', table: [{ ...OLD_LAUNCHER, args: 'gh pr view 7' }], ends: [] },
    { label: 'a launcher PID with another creation time', table: [{ ...OLD_LAUNCHER, started: LATER }], ends: [] },
    { label: 'the recorded launcher and forwarder', table: [OLD_LAUNCHER, OLD_FORWARDER], ends: [identity(OLD_LAUNCHER), identity(OLD_FORWARDER)] },
  ]) {
    const world = routeWorld({ record: crashedRecord({ hookId: null }), table: row.table });
    const opened = await openRoute(world);
    assertOpened(opened, row.label);
    assert.deepEqual([...world.ends].sort((a, b) => a.pid - b.pid), row.ends, `${row.label}: processes ended`);
    await opened.route.close();
    assert.equal(world.ends.length, row.ends.length, `${row.label}: the close ends nothing by identity`);
  }

  // Both recorded processes match when the table is first read; once the first is ended, the other's PID is taken by
  // another program, so the identity read just before its own end no longer matches.
  const label = 'a recorded process whose PID is reused after the first one is ended';
  const world = routeWorld({ record: crashedRecord({ hookId: null }), table: [OLD_LAUNCHER, OLD_FORWARDER] });
  const endProcess = world.seams.endProcess;
  world.seams.endProcess = (target) => {
    endProcess(target);
    world.table = world.table.map((row) => ([OLD_LAUNCHER.pid, OLD_FORWARDER.pid].includes(row.pid) ? { ...row, args: 'node server.js' } : row));
  };
  const opened = await openRoute(world);
  assertOpened(opened, label);
  assert.equal(world.ends.length, 1, `${label}: only the first process is ended, not ${JSON.stringify(world.ends)}`);
  await opened.route.close();
});

// The route as a process: a driver opens it with its real defaults over a fake gh. The fake's `webhook forward` runs
// a fake extension child named like the real one, which records a hook GitHub lists only while that child runs, prints
// the notice and one payload line, then waits; it exits by itself after 120 seconds, well past the driver's 30-second
// limit, so only a stop that ends it can let the driver finish, and the test cleanup still ends a leftover.
const WIRE_HOOK_ID = 4242;
const EXTENSION_SCRIPT = `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.env.MERGE_WATCH_SCENARIO;
writeFileSync(join(dir, 'extension-pid'), String(process.pid));
const hooksFile = join(dir, 'hooks.json');
const hooks = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : [];
hooks.push(Object.assign(${JSON.stringify(cliHook(WIRE_HOOK_ID))}, { holder: process.pid }));
writeFileSync(hooksFile, JSON.stringify(hooks));
process.stderr.write(${JSON.stringify(`${NOTICE}\n`)});
process.stdout.write(${JSON.stringify(`${JSON.stringify({ zen: PAYLOAD_MARKER, hook_id: WIRE_HOOK_ID })}\n`)});
setTimeout(() => process.exit(0), 120_000);
`;

const routeGh = installFakeGh('merge-watch-route-', `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = process.env.MERGE_WATCH_SCENARIO;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), JSON.stringify(args) + '\\n');
const hooksFile = join(dir, 'hooks.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const liveHooks = () => (existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : []).filter((hook) => alive(hook.holder));
const done = (code, out, err) => {
  if (out) process.stdout.write(out + '\\n');
  if (err) process.stderr.write(err + '\\n');
  process.exit(code);
};
if (args[0] === 'webhook') {
  if (process.env.ROUTE_FORWARD === 'unknown') done(1, '', 'unknown command "webhook" for "gh"\\n\\nUsage:  gh <command> <subcommand> [flags]');
  writeFileSync(join(dir, 'gh-pid'), String(process.pid));
  // gh runs an extension as its child and passes no signal on to it.
  const run = spawnSync(process.execPath, [join(dir, 'gh-webhook', 'gh-webhook.cjs'), ...args.slice(1)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
if (args[0] === 'api' && (args[1] === '-X' || args[1] === '--method') && args[2] === 'DELETE' && /\\/hooks\\/\\d+$/.test(path)) {
  const id = Number(path.split('/').at(-1));
  writeFileSync(hooksFile, JSON.stringify(liveHooks().filter((hook) => hook.id !== id)));
  done(0);
}
if (args[0] === 'api' && path === 'repos/{owner}/{repo}') done(0, JSON.stringify({ full_name: 'owner/repo' }));
if (args[0] === 'api' && /\\/hooks(\\?|$)/.test(path) && !args.includes('-X')) {
  done(0, JSON.stringify([liveHooks().map(({ holder, ...hook }) => hook)]));
}
const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
scenario.n = Number(readFileSync(join(dir, 'n'), 'utf8'));
const [code, body] = (${scenarioReply.toString()})(args, scenario);
writeFileSync(join(dir, 'n'), String(scenario.n));
if (code === 0) done(0, body); else done(code, '', body);
`);
after(() => routeGh.cleanup());

test('the fake gh environment drops inherited Herdr job variables and keeps one the test sets', () => {
  const dropped = ['FABRAIK_COORDINATED_JOB', 'PRE_APPROVED_RUN_SESSION', 'PRE_APPROVED_RUN_CARD', 'HC_TERMINAL_ID', 'HC_SCOPE', 'HC_TERMINAL_SOCKET', 'HERDR_TEST_MARK'];
  const set = {
    FABRAIK_COORDINATED_JOB: '1',
    FABRAIK_WORKFLOW_ROOT: '/inherited/root',
    PRE_APPROVED_RUN_SESSION: '2026-01-01T00:00:00Z',
    PRE_APPROVED_RUN_CARD: '7',
    HC_TERMINAL_ID: 't1',
    HC_SCOPE: 'inherited-scope',
    HC_TERMINAL_SOCKET: '/inherited/socket',
    HERDR_TEST_MARK: 'inherited',
    MERGE_WATCH_UNRELATED_MARK: 'kept',
  };
  const saved = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
  Object.assign(process.env, set);
  try {
    const env = routeGh.env({ FABRAIK_WORKFLOW_ROOT: '/chosen/root' });
    for (const name of dropped) assert.ok(!Object.hasOwn(env, name), `${name} is dropped from the fake gh environment`);
    assert.equal(env.FABRAIK_WORKFLOW_ROOT, '/chosen/root');
    assert.equal(env.MERGE_WATCH_UNRELATED_MARK, 'kept');
    assert.ok(Object.hasOwn(env, 'BOARD_TOOLKIT_GH'), 'BOARD_TOOLKIT_GH is present');
    assert.ok(!Object.hasOwn(routeGh.env(), 'FABRAIK_WORKFLOW_ROOT'), 'an inherited FABRAIK_WORKFLOW_ROOT is dropped when the test sets none');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// Opens the route with its defaults, then by mode prints the open record, runs the watch, only closes it, or crashes.
const ROUTE_DRIVER = `
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import * as watchLib from ${JSON.stringify(new URL('./merge-watch.mjs', import.meta.url).href)};
import { runGh } from ${JSON.stringify(new URL('./gh-exec.mjs', import.meta.url).href)};
const [mode, recordPath] = process.argv.slice(2);
const opening = watchLib.openEventRoute({ ghExec: runGh });
let route;
try {
  route = await opening;
} catch (err) {
  console.log(err.message);
  process.exitCode = 1;
}
if (route) {
  // A crash: the driver ends with its route open, leaving its record, gh and the extension child behind.
  if (mode === 'crash') process.exit(0);
  if (mode === 'table') {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const fileMode = statSync(recordPath).mode & 0o777;
    const dirMode = statSync(dirname(recordPath)).mode & 0o777;
    console.log(JSON.stringify({ pid: process.pid, record, fileMode, dirMode }));
  }
  let result = { exitCode: 0, reason: 'stopped' };
  if (mode === 'merge') {
    result = await watchLib.watchMerge({ pr: '7', ghExec: runGh, sleep: async () => { throw new Error('the watch slept'); }, now: Date.now });
  }
  await route.close();
  console.log(result.reason);
  process.exitCode = result.exitCode;
}
`;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
};

// True once the process has ended, checked every 50 ms for up to 5 seconds while the system reaps it.
function waitGone(pid) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 5_000; waited += 50) {
    if (!isAlive(pid)) return true;
    Atomics.wait(pause, 0, 0, 50);
  }
  return !isAlive(pid);
}

// `dir` reuses an earlier run's scenario folder, so a run can recover from what the earlier one left.
function runRoute(t, mode, forward = 'connects', dir = writeScenario([MERGED])) {
  writeFileSync(join(dir, 'merge-watch-route.mjs'), ROUTE_DRIVER);
  const recordPath = join(dir, 'state', 'fabraik-merge-watch', `${RECORD_KEY}.json`);
  const run = spawnSync(process.execPath, [join(dir, 'merge-watch-route.mjs'), mode, recordPath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: routeGh.env({ MERGE_WATCH_SCENARIO: dir, ROUTE_FORWARD: forward, XDG_STATE_HOME: join(dir, 'state') }),
  });
  const pidIn = (name) => (existsSync(join(dir, name)) ? Number(readFileSync(join(dir, name), 'utf8')) : undefined);
  const ghPid = pidIn('gh-pid');
  const extensionPid = pidIn('extension-pid');
  const hooksFile = join(dir, 'hooks.json');
  const result = {
    ...run,
    calls: readCalls(dir),
    ghPid,
    extensionPid,
    liveHooks: () => (existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : []).filter((hook) => isAlive(hook.holder)),
    recordLeft: existsSync(recordPath),
    lastOut: run.stdout.trimEnd().split('\n').at(-1),
  };
  t.after(() => {
    for (const pid of [extensionPid, ghPid]) if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  return result;
}

test('the event route as a process starts its forwarder, lets the watch report the merge, then leaves no hook, record or forwarder behind', (t) => {
  const run = runRoute(t, 'merge');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.lastOut, 'merged', run.stderr);
  assert.deepEqual(run.calls.filter((call) => call[0] === 'webhook'), [FORWARD_ARGS], 'one forward on the watched repository');
  const forwardAt = run.calls.findIndex((call) => call[0] === 'webhook');
  const listAt = run.calls.findIndex((call, index) => index > forwardAt && isHookList(call));
  const pullRequestAt = run.calls.findIndex((call) => call[0] === 'pr');
  assert.ok(forwardAt >= 0 && listAt > forwardAt && pullRequestAt > listAt, `the first pull request read comes after the forward's hook is listed: ${JSON.stringify(run.calls)}`);
  assertOwnHookWrites(run.calls.filter((call) => call[0] !== 'webhook'), [WIRE_HOOK_ID]);
  assert.equal(waitGone(run.extensionPid), true, 'the extension child has ended');
  assert.deepEqual(run.liveHooks(), [], 'no forwarding hook is left');
  assert.equal(run.recordLeft, false, 'the record is removed');
  for (const output of [run.stdout, run.stderr]) assert.ok(!output.includes(PAYLOAD_MARKER), `payload text reached output: ${output}`);
});

test('the event route as a process stops naming the missing extension and reads no pull request', (t) => {
  const run = runRoute(t, 'merge', 'unknown');
  assert.ok(run.lastOut?.endsWith(INSTALL), `the reason must say how to install the extension:\n${run.stdout}${run.stderr}`);
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.calls.filter((call) => call[0] === 'pr'), [], 'no pull request is read');
  assert.deepEqual(run.calls.filter((call) => deletedHookId(call) !== undefined), [], 'no hook is deleted');
});

test('stopping the forwarder ends its child process too', (t) => {
  const run = runRoute(t, 'stop');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Number.isInteger(run.ghPid) && Number.isInteger(run.extensionPid), 'the fake gh started its extension child');
  assert.equal(waitGone(run.ghPid), true, 'gh has ended');
  assert.equal(waitGone(run.extensionPid), true, 'the extension child has ended with gh');
});

test('the process table reader returns a running child with its parent, creation time and arguments', (t) => {
  const run = runRoute(t, 'table');
  assert.equal(run.status, 0, run.stderr);
  const shownLine = run.stdout.split('\n').find((line) => line.startsWith('{'));
  assert.ok(shownLine, `the table case printed no JSON line: ${run.stdout}`);
  const shown = JSON.parse(shownLine);
  assert.equal(shown.record.watch.pid, shown.pid, 'the watch is this node process');
  assert.equal(shown.record.launcher.pid, run.ghPid, 'the launcher is the gh process');
  assert.equal(shown.record.forwarder.pid, run.extensionPid, 'the forwarder is gh\'s extension child');
  assert.equal(shown.record.hookId, WIRE_HOOK_ID);
  for (const role of ['watch', 'launcher', 'forwarder']) {
    const { started } = shown.record[role];
    assert.ok(typeof started === 'string' && started.trim() !== '', `the ${role} carries its creation time: ${JSON.stringify(started)}`);
  }
  if (process.platform !== 'win32') {
    assert.equal(shown.fileMode, 0o600, 'the record is readable by its owner only');
    assert.equal(shown.dirMode, 0o700, 'the record folder is open to its owner only');
  }
});

// A crashed route leaves its record, gh and the extension child running; the next start, with its real process ender,
// ends the recorded process whose identity matches and leaves the one whose recorded creation time differs. The record
// carries no hook id, so the start then stops on the listed hook rather than re-listing it for ten seconds.
test('recovery ends a crashed watch\'s process whose identity matches and leaves one whose creation time differs', { skip: process.platform === 'win32' ? 'the claim is the POSIX TERM path of ending a recorded process' : false }, (t) => {
  const dir = writeScenario([MERGED]);
  const crashed = runRoute(t, 'crash', 'connects', dir);
  assert.equal(crashed.status, 0, crashed.stderr);
  assert.ok(isAlive(crashed.ghPid) && isAlive(crashed.extensionPid), 'the crash leaves gh and its extension child running');
  const recordPath = join(dir, 'state', 'fabraik-merge-watch', `${RECORD_KEY}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.deepEqual([record.launcher.pid, record.forwarder.pid], [crashed.ghPid, crashed.extensionPid], 'the record names gh and its extension child');
  writeFileSync(recordPath, JSON.stringify({ ...record, forwarder: { ...record.forwarder, started: 'Thu Jan  1 00:00:00 1970' }, hookId: null }));
  const recovering = runRoute(t, 'stop', 'connects', dir);
  assert.equal(recovering.lastOut, unprovedHook(WIRE_HOOK_ID), recovering.stderr);
  assert.equal(recovering.status, 1, recovering.stderr);
  assert.equal(waitGone(crashed.ghPid), true, 'the launcher whose identity matches is ended');
  assert.equal(isAlive(crashed.extensionPid), true, 'the forwarder whose creation time differs is left running');
});

// The command waits on checks that stay pending; once it has made its first pull request read, which comes after the
// forward's notice, it is sent SIGTERM.
test('a stopped watch ends its forwarder', { skip: process.platform === 'win32' ? 'Windows has no POSIX signal delivery to send SIGTERM with' : false }, async (t) => {
  const dir = writeScenario([CHECKS_RUNNING]);
  const recordPath = join(dir, 'state', 'fabraik-merge-watch', `${RECORD_KEY}.json`);
  const child = spawn(process.execPath, [CLI, '7'], {
    env: routeGh.env({ MERGE_WATCH_SCENARIO: dir, XDG_STATE_HOME: join(dir, 'state') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const pidIn = (name) => (existsSync(join(dir, name)) ? Number(readFileSync(join(dir, name), 'utf8')) : undefined);
  t.after(() => {
    for (const pid of [child.pid, pidIn('extension-pid'), pidIn('gh-pid')]) if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  const viewed = () => readCalls(dir).some((call) => callKind(call) === 'view');
  for (let waited = 0; !viewed() && waited < 15_000; waited += 50) await delay(50);
  assert.ok(viewed(), `the watch made no pull request read: ${stdout}${stderr}`);
  child.kill('SIGTERM');
  const { code, signal } = await exited;

  assert.equal(code, 1, `the watch handles SIGTERM and exits 1 rather than dying of it (signal ${signal}): ${stdout}${stderr}`);
  assert.equal(stdout.trimEnd().split('\n').at(-1), 'stopped by SIGTERM');
  const reported = /merge watch made (\d+) gh calls: /.exec(stderr);
  assert.ok(reported, `the watch reports its gh call count: ${stderr}`);
  const invocations = readCalls(dir);
  assert.equal(Number(reported[1]), invocations.length, `the reported count includes every gh invocation, \`gh webhook forward\` among them: ${JSON.stringify(invocations)}`);
  const extensionPid = pidIn('extension-pid');
  assert.ok(Number.isInteger(extensionPid), 'the watch started its forwarder');
  assert.equal(waitGone(extensionPid), true, 'the extension child has ended');
  const hooksFile = join(dir, 'hooks.json');
  const liveHooks = (existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : []).filter((hook) => isAlive(hook.holder));
  assert.deepEqual(liveHooks, [], 'no forwarding hook is left');
  assert.equal(existsSync(recordPath), false, 'the record is removed');
});

// ── a pinned job's merge watch ───────────────────────────────────────────────
// The expected outcomes come from the plan's frozen rule: a merge watch run from a job's workflow version, named by
// FABRAIK_WORKFLOW_ROOT, verifies that version before it dispatches, with drift allowed only for the exact one-argument
// cleanup `<n>`, which under drift clears a retained record and opens no new watch. The run starts from the snapshot of a
// real repository whose one commit holds this checkout's merge watch, its library and the three shared contracts, the
// delivery-lane contract a synthetic one since an install with the Herdr add-on off has none, in a job worktree, over
// the fake gh, with or without a crashed watch's record retained in its state directory.

const CODE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const withoutClaude = !presentRuntimes(CODE_ROOT).includes('claude') && 'the settings file names no claude runtime';
const SHARED_PIN = 'scripts/lib/workflow-pin.mjs';
const SHARED_LANE = 'scripts/lib/delivery-lane-contract.test.mjs';

const gitIn = (cwd, args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};

// Gives back the write bits a read-only snapshot took, so a case can damage it or the fixture can be removed.
const unlock = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, (stat.mode & 0o7777) | 0o200);
  if (stat.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
};

function pinnedWatch(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pinned-watch-')));
  t.after(() => {
    unlock(repo);
    rmSync(repo, { recursive: true, force: true });
  });
  const library = readdirSync(join(CODE_ROOT, 'scripts/lib')).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
  for (const path of ['.claude/settings.json', 'scripts/merge-watch.mjs', ...library.map((name) => `scripts/lib/${name}`)]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(CODE_ROOT, path), join(repo, path));
  }
  writeFileSync(join(repo, SHARED_LANE), '// The fixture delivery-lane contract.\n');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'workflow']);
  const commit = gitIn(repo, ['rev-parse', 'HEAD']);
  const worktree = join(repo, '.claude/worktrees/job');
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'job/7', worktree]);
  const log = t.mock.method(console, 'log', () => {});
  repairWorkflowSnapshot({ cwd: repo, commit });
  log.mock.restore();
  return { repo, worktree, root: join(workflowStore(repo), commit) };
}

// An open draft pull request: a full watch of it waits, so only a run that opens no watch ends on it.
const OPEN_DRAFT = { view: view('OPEN', 'DRAFT'), checks: UNREPORTED, runs: NO_RUNS };

// Runs `node <root>/scripts/merge-watch.mjs 7` in the job worktree over the pull request `steps`, by default with a
// crashed watch's record retained: whether it ended, its exit status, its output, its gh calls, its forwarding launches,
// whether a record is left and whether it is the retained one with its bytes.
function pinnedCleanup(pin, { steps = [MERGED], retain = true } = {}) {
  const dir = writeScenario(steps);
  const stateDir = join(dir, 'state', 'fabraik-merge-watch');
  const recordPath = join(stateDir, `${RECORD_KEY}.json`);
  const retained = JSON.stringify(crashedRecord({ launcher: null, forwarder: null, hookId: null }));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (retain) writeFileSync(recordPath, retained, { mode: 0o600 });
  const run = spawnSync(process.execPath, [join(pin.root, 'scripts/merge-watch.mjs'), '7'], {
    cwd: pin.worktree,
    encoding: 'utf8',
    timeout: 30_000,
    env: routeGh.env({
      MERGE_WATCH_SCENARIO: dir, XDG_STATE_HOME: join(dir, 'state'), FABRAIK_COORDINATED_JOB: '1', FABRAIK_WORKFLOW_ROOT: pin.root,
    }),
  });
  const calls = readCalls(dir);
  const result = {
    ended: run.error === undefined,
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    calls,
    forwards: calls.filter((call) => call[0] === 'webhook').length,
    recordLeft: existsSync(recordPath),
    recordKept: existsSync(recordPath) && readFileSync(recordPath, 'utf8') === retained,
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('ANTI-REGRESSION: delivery stops on a changed or drifted workflow version', { skip: withoutClaude }, (t) => {
  const pin = pinnedWatch(t);
  const watched = pinnedCleanup(pin);
  // The snapshot's copy of a shared contract, which the merge watch never loads, no longer matches the commit.
  const damaged = join(pin.root, SHARED_LANE);
  const intact = readFileSync(damaged);
  unlock(damaged);
  writeFileSync(damaged, Buffer.concat([intact, Buffer.from('// not the pinned contract\n')]));
  const refused = pinnedCleanup(pin);

  writeFileSync(damaged, intact);
  // An intact pin admits only the cleanup too: pinned jobs watch only through `<pr> --held-delivery`.
  const intactDraft = pinnedCleanup(pin, { steps: [OPEN_DRAFT] });
  // The integration checkout's copy of a shared contract moves on from the pinned commit.
  const contract = readFileSync(join(pin.repo, SHARED_PIN));
  writeFileSync(join(pin.repo, SHARED_PIN), Buffer.concat([contract, Buffer.from('// moved on\n')]));
  const drifted = pinnedCleanup(pin, { steps: [OPEN_DRAFT] });
  const driftedBare = pinnedCleanup(pin, { retain: false });

  assert.deepEqual({
    'no drift': { ended: watched.ended, forwards: watched.forwards, recordLeft: watched.recordLeft },
    'no drift, a retained record and an open draft': { ended: intactDraft.ended, forwards: intactDraft.forwards, recordLeft: intactDraft.recordLeft },
    'corrupt snapshot': { refused: refused.status !== 0, namesTheDamage: refused.output.includes(damaged), ghCalls: refused.calls.length, recordKept: refused.recordKept },
    'drift, a retained record and an open draft': { ended: drifted.ended, forwards: drifted.forwards, recordLeft: drifted.recordLeft },
    'drift and no retained record': { ended: driftedBare.ended, forwards: driftedBare.forwards, recordLeft: driftedBare.recordLeft },
  }, {
    'no drift': { ended: true, forwards: 0, recordLeft: false },
    'no drift, a retained record and an open draft': { ended: true, forwards: 0, recordLeft: false },
    'corrupt snapshot': { refused: true, namesTheDamage: true, ghCalls: 0, recordKept: true },
    'drift, a retained record and an open draft': { ended: true, forwards: 0, recordLeft: false },
    'drift and no retained record': { ended: true, forwards: 0, recordLeft: false },
  }, [watched.output, refused.output, intactDraft.output, drifted.output, driftedBare.output].join('\n---\n'));
});
