// merge-watch.test.mjs: the merge watch's exit contract and required-check rules, and the draft wait's exit contract,
// through the fake-gh seam.
//
// Polling scenarios run `main` with an in-memory ghExec and a recording sleep that returns at once. The pull-request
// form's argument contract and terminal success/failure cases run the real command as a subprocess with the same fake
// replies. The draft wait also has one positive and one negative process case in fresh Git repositories, isolated from
// the machine's and the environment's Git configuration. The cloud draft case also runs under an injected URL rewrite.
//
// Recurring cost: no subprocess or disk state for in-memory polling; CLI wire proofs start Node for the command and
// each faked gh call, with no network. Only the two draft wire cases initialize Git repositories.
// Removal condition: retire with scripts/merge-watch.mjs, and the draft-wait tests with its `--draft` mode.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { installFakeGh } from './fake-gh.mjs';
import { main } from '../merge-watch.mjs';

const CLI = fileURLToPath(new URL('../merge-watch.mjs', import.meta.url));
const USAGE = 'usage: node scripts/merge-watch.mjs <pull-request-number> | --draft job/<issue>';

// Each state-view call advances the scenario; checks use that step and the last step repeats. A reply is
// [exit code, body]. Rules preserve gh's pagination/slurp behavior, and both paths refuse missing arguments.
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
    if (args[1] === 'view' && flag('--json') === 'state,mergeStateStatus') {
      scenario.n += 1;
      return step(scenario.n).view;
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
    if (path.startsWith('repos/{owner}/{repo}/actions/')) {
      return scenario.actions[path.slice('repos/{owner}/{repo}/actions/'.length)] ?? refuse('unknown actions path');
    }
    return refuse('the base branch was not substituted');
  }
  return refuse('unexpected gh call');
}

// The CLI shim logs argv and persists the read counter across separate gh processes.
const fakeGh = installFakeGh('merge-watch-', `
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.env.MERGE_WATCH_SCENARIO;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls'), JSON.stringify(args) + '\\n');
const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
scenario.n = Number(readFileSync(join(dir, 'n'), 'utf8'));
const [code, body] = (${scenarioReply.toString()})(args, scenario);
writeFileSync(join(dir, 'n'), String(scenario.n));
if (code === 0) process.stdout.write(body + '\\n'); else process.stderr.write(body + '\\n');
process.exit(code);
`);
after(() => fakeGh.cleanup());

const view = (state, mergeStateStatus) => [0, JSON.stringify({ state, mergeStateStatus })];
const checks = (byName) => [0, JSON.stringify(Object.entries(byName).map(([name, bucket]) => ({ name, bucket })))];

const OPEN_BLOCKED = view('OPEN', 'BLOCKED');
const MERGED = { view: view('MERGED', 'CLEAN'), checks: checks({ test: 'pass', 'sweep-scope': 'pass' }) };

// The base branch requires `classic` through classic protection and `ruled` through a ruleset; the default union is
// split across the two sources so dropping either read shows. The rules come as two pages, the ruleset's checks on
// page two so reading page one alone shows; `extraRules` joins page two. `branch` or `rules` replaces that read's
// reply, and `base` the base-branch read's. `actions` maps a path under `actions/` to its reply.
function createScenario(steps, { classic = ['test'], ruled = ['sweep-scope'], extraRules = [], base, branch, rules, actions = {}, draft } = {}) {
  return {
    steps,
    draft,
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

function writeScenario(steps, options) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-watch-scenario-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(createScenario(steps, options)));
  writeFileSync(join(dir, 'n'), '0');
  writeFileSync(join(dir, 'calls'), '');
  return dir;
}

function readCalls(dir) {
  return readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function callKind([group, command, ...rest]) {
  if (group === 'pr' && command === 'view') return rest.includes('baseRefName') ? 'base' : 'view';
  if (group === 'pr' && command === 'checks') return 'checks';
  if (group === 'api' && command === 'rate_limit') return 'rate_limit';
  if (group === 'api' && [command, ...rest].some((arg) => arg.startsWith('repos/{owner}/{repo}/actions/'))) return 'actions';
  if (group === 'api') return [command, ...rest].some((arg) => arg.includes('/rules/branches/')) ? 'rules' : 'branch';
  return 'other';
}

// Reads only: pull request/repository queries, or an `api` GET carrying no method, field or body flag.
function assertReadOnly(calls) {
  const writeFlag = /^(-X|--method|-f|--raw-field|-F|--field|--input)(=|$)|^-[XfF]./;
  for (const call of calls) {
    const [group, command] = call;
    const read = (group === 'pr' && (command === 'view' || command === 'checks' || command === 'list'))
      || (group === 'repo' && command === 'view')
      || (group === 'api' && !call.some((arg) => writeFlag.test(arg)));
    assert.ok(read, `the watch must only read GitHub state, but called: gh ${call.join(' ')}`);
  }
}

// Runs the command in-process against the scenario; a sleep past the twentieth means the watch never stopped.
async function watch(steps, options) {
  const scenario = createScenario(steps, options);
  const calls = [];
  const ghExec = (args) => {
    calls.push(args);
    const [code, body] = scenarioReply(args, scenario);
    if (code === 0) return body + '\n';
    throw Object.assign(new Error(body), { status: code, stdout: '', stderr: body + '\n' });
  };
  const lines = [];
  const sleeps = [];
  const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const sleep = async (ms) => {
    sleeps.push(ms);
    if (sleeps.length > 20) throw new Error('the watch did not stop');
  };
  const status = await main(['7'], { ghExec, output, sleep });
  assertReadOnly(calls);
  return { status, lines, last: lines.at(-1), sleeps, calls, reads: calls.filter((call) => callKind(call) === 'view').length };
}

function runCli(args, steps = [MERGED], options) {
  const dir = writeScenario(steps, options);
  // The draft wait reads origin through git, so no machine-wide config and no config injected through the
  // environment, such as a cloud platform's url.<base>.insteadOf rewrite, may change the URL it reads.
  const env = fakeGh.env(
    {
      MERGE_WATCH_SCENARIO: dir,
      GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
      GIT_CONFIG_NOSYSTEM: '1',
      ...(options?.draft ? { GH_REPO: 'foreign/elsewhere' } : {}),
    },
    ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'],
  );
  if (options?.draft) {
    for (const gitArgs of [['init', '--quiet'], ['remote', 'add', 'origin', options.draft.origin]]) {
      const setup = spawnSync('git', gitArgs, { cwd: dir, encoding: 'utf8', env });
      assert.equal(setup.status, 0, setup.stderr || setup.error?.message);
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
  assertReadOnly(calls);
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
  assert.equal(callKind(auth.calls.at(-1)), 'view', 'the command must make no read after the failing view, the rate-limit probe included');
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
  assert.equal(network.sleeps.length, 1);
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
    assert.deepEqual(terminal.sleeps, [], `${state} must not sleep`);
  }
});

test('the watch makes exactly one attempt at the gh call that fails, and no gh call of any kind after it', async () => {
  const error = [1, 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'];
  const pending = { view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) };
  for (const [kind, steps, options] of [
    ['base', [MERGED], { base: error }],
    ['branch', [MERGED], { branch: error }],
    ['rules', [MERGED], { rules: error }],
    ['view', [{ ...pending, view: error }], {}],
    ['checks', [{ ...pending, checks: error }], {}],
  ]) {
    const failed = await watch(steps, options);
    assert.equal(failed.status, 1, `a failing ${kind} read must stop the wait`);
    assert.equal(failed.last, error[1], `a failing ${kind} read must print gh's error last`);
    assert.equal(failed.sleeps.length, 0, `a failing ${kind} read must not wait and try again`);
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
  assert.deepEqual(pending.sleeps, [30_000, 30_000], 'the wait must sleep 30 seconds between reads');
  assert.equal(pending.last, 'merged');

  const unreported = await watch([
    { view: OPEN_BLOCKED, checks: [1, "no required checks reported on the 'job/7' branch"] },
    { view: OPEN_BLOCKED, checks: [1, "no checks reported on the 'job/7' branch"] },
    MERGED,
  ]);
  assert.equal(unreported.status, 0, 'a required check not yet reported must not stop the wait');
  assert.equal(unreported.reads, 3);
  assert.equal(unreported.sleeps.length, 2);

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
    assert.equal(waiting.sleeps.length, 2);
    assert.equal(waiting.last, 'merged');
  }
});

test('the watch keeps waiting on a failed required check while a newer unfinished run of the same workflow on the same head will report it again', async () => {
  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
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
          'runs/41': [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: head })],
          [`workflows/9/runs?head_sha=${head}`]: [0, JSON.stringify({
            workflow_runs: [{ run_number: 5, status }, { run_number: 4, status: 'completed' }],
          })],
        },
      },
    );
    assert.equal(superseded.last, 'merged', `a failure superseded by a ${status} run must not stop the wait`);
    assert.equal(superseded.status, 0);
    assert.deepEqual(superseded.sleeps, [30_000, 30_000]);
    assert.deepEqual(
      superseded.calls.filter((call) => callKind(call) === 'actions'),
      [['api', 'repos/{owner}/{repo}/actions/runs/41'], ['api', `repos/{owner}/{repo}/actions/workflows/9/runs?head_sha=${head}`]],
      'the failed check must be judged by its own run, then by its workflow\'s runs on that head',
    );
  }
});

test('a failed required check still stops the watch when no newer unfinished run of its own workflow exists', async () => {
  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const testLink = 'https://github.com/owner/repo/actions/runs/41/job/77';
  const sweepLink = 'https://github.com/owner/repo/actions/runs/52/job/78';
  const failedTest = (link) => [
    { name: 'test', bucket: 'fail', ...(link === undefined ? {} : { link }) },
    { name: 'sweep-scope', bucket: 'pass', link: sweepLink },
  ];
  // The failed `test` check's own run is run number 4 of workflow 9; `runs` is that workflow's list on the head.
  const testRuns = (runs) => ({
    'runs/41': [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: head })],
    [`workflows/9/runs?head_sha=${head}`]: [0, JSON.stringify({ workflow_runs: runs })],
  });
  const sweepRuns = {
    'runs/52': [0, JSON.stringify({ workflow_id: 12, run_number: 8, head_sha: head })],
    [`workflows/12/runs?head_sha=${head}`]: [0, JSON.stringify({ workflow_runs: [{ run_number: 8, status: 'completed' }] })],
  };
  for (const [label, rows, actions, reason] of [
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
  ]) {
    const failed = await watch([{ view: OPEN_BLOCKED, checks: [0, JSON.stringify(rows)] }, MERGED], { actions });
    assert.equal(failed.last, reason, `${label} must print the failure as the last line`);
    assert.equal(failed.status, 1, `${label} must stop the wait`);
    assert.equal(failed.reads, 1, `${label} must stop on the first pass`);
    assert.deepEqual(failed.sleeps, [], `${label} must not wait and read again`);
    if (actions === undefined) {
      assert.equal(failed.calls.filter((call) => callKind(call) === 'actions').length, 0, `${label} must read no workflow run`);
    }
  }
});

test('the watch exits 1 on its first pass when a workflow run reply it needs cannot be read', async () => {
  const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const failedTest = [0, JSON.stringify([
    { name: 'test', bucket: 'fail', link: 'https://github.com/owner/repo/actions/runs/41/job/77' },
    { name: 'sweep-scope', bucket: 'pass', link: 'https://github.com/owner/repo/actions/runs/52/job/78' },
  ])];
  const runRead = ['api', 'repos/{owner}/{repo}/actions/runs/41'];
  const listRead = ['api', `repos/{owner}/{repo}/actions/workflows/9/runs?head_sha=${head}`];
  const readableRun = [0, JSON.stringify({ workflow_id: 9, run_number: 4, head_sha: head })];
  const badGateway = [1, 'HTTP 502: Bad Gateway (https://api.github.com/repos/owner/repo/actions/runs/41)'];
  // A run list the watch must refuse, given as the JSON GitHub would send so the reason quotes it back exactly.
  const unreadableList = (label, runs) => [
    label,
    { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${head}`]: [0, `{"workflow_runs":${runs}}`] },
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
      { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${head}`]: [0, '{}'] },
      'unreadable workflow runs: null',
      [runRead, listRead],
    ],
    [
      'a run list that is not a list',
      { 'runs/41': readableRun, [`workflows/9/runs?head_sha=${head}`]: [0, JSON.stringify({ workflow_runs: {} })] },
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
    assert.deepEqual(unreadable.sleeps, [], `${label} must not wait and read again`);
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
  for (const [options, reason] of [
    [{ branch: [0, JSON.stringify(noContexts)] }, 'unreadable required set: classic required_status_checks {"strict":true}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: 'test' } } })] }, 'unreadable required set: classic required_status_checks {"contexts":"test"}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: [null] } } })] }, 'unreadable required set: classic required_status_checks {"contexts":[null]}'],
    [{ branch: [0, JSON.stringify({ protection: { required_status_checks: { contexts: ['', 'test'] } } })] }, 'unreadable required set: classic required_status_checks {"contexts":["","test"]}'],
    [{ extraRules: [namelessRule] }, `unreadable required set: rule ${JSON.stringify(namelessRule)}`],
    [{ extraRules: [listlessRule] }, `unreadable required set: rule ${JSON.stringify(listlessRule)}`],
    [{ extraRules: [emptyNameRule] }, `unreadable required set: rule ${JSON.stringify(emptyNameRule)}`],
    [{ rules: [0, flatPages] }, `unreadable required set: rules ${JSON.stringify(flatPages)}`],
  ]) {
    const unreadable = await watch([MERGED], options);
    assert.equal(unreadable.status, 1, `${reason} must stop the wait`);
    assert.equal(unreadable.reads, 0, `${reason} must stop before the first read`);
    assert.equal(unreadable.sleeps.length, 0);
    assert.equal(unreadable.calls.filter((call) => callKind(call) === 'checks').length, 0, `${reason} must make no pr checks call`);
    assert.equal(unreadable.last, reason);
  }
});

test('the watch exits 1 on its first pass when a successful reply carries a pull request state or merge state it does not know', async () => {
  for (const [state, mergeStateStatus] of [[null, null], ['DRAFT', 'CLEAN'], ['OPEN', null], ['OPEN', ''], ['OPEN', 'ALIEN']]) {
    const unreadable = await watch([{ view: view(state, mergeStateStatus), checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
    assert.equal(unreadable.status, 1, `${state} ${mergeStateStatus} must stop the wait`);
    assert.equal(unreadable.reads, 1);
    assert.equal(unreadable.sleeps.length, 0, `${state} ${mergeStateStatus} must not wait and read again`);
    assert.equal(unreadable.last, `unreadable pull request state: ${JSON.stringify({ state, mergeStateStatus })}`);
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
    assert.equal(unreadable.sleeps.length, 0, `${reason} must not wait and read again`);
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
  assert.equal(none.sleeps.length, 0);
  assert.equal(none.last, 'merge blocked with every required check finished: OPEN BLOCKED');
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

test('the watch only ever reads GitHub state', async () => {
  const run = await watch([{ view: OPEN_BLOCKED, checks: checks({ test: 'pending', 'sweep-scope': 'pending' }) }, MERGED]);
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls.map(callKind), ['base', 'branch', 'rules', 'view', 'checks', 'view']);
  for (const write of [['pr', 'merge', '7'], ['pr', 'ready', '7'], ['pr', 'comment', '7'], ['issue', 'edit', '7'], ['api', '-X', 'PATCH', 'repos/{owner}/{repo}/pulls/7'], ['api', 'repos/{owner}/{repo}/issues/7/comments', '-f', 'body=x']]) {
    assert.throws(() => assertReadOnly([write]), /must only read/, `the read-only check must refuse gh ${write.join(' ')}`);
  }
});

const DRAFT_ORIGIN = 'git@github.com:owner/repo.git';
const DRAFT_REPO = ['repo', 'view', '--json', 'id', '--', DRAFT_ORIGIN];
const DRAFT_LIST = ['pr', 'list', '--repo', DRAFT_ORIGIN, '--head', 'job/7', '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository'];
const draftPr = (overrides = {}) => ({ number: 12, state: 'OPEN', headRefName: 'job/7', headRepository: { id: 'R_origin' }, isCrossRepository: false, ...overrides });

// Draft-list calls advance replies and the last repeats; repository lookup has its own reply. A sleep past the
// twentieth means the wait never stopped.
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

test('the draft wait exits 1 the moment gh fails, with the gh error as its last line and no read after it', async () => {
  const run = await waitDraft([[0, '[]'], [1, 'error connecting to api.github.com']]);
  assert.equal(run.status, 1);
  assert.equal(run.last, 'error connecting to api.github.com');
  assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST, DRAFT_LIST]);
  assert.equal(run.sleeps.length, 1);
});

test('the draft wait exits 1 without waiting on a pull request list it cannot read', async () => {
  for (const body of ['{}', '[{}]', '[null]', '[{"number":"12"}]', '[{"number":0}]']) {
    const run = await waitDraft([[0, body]]);
    assert.equal(run.status, 1, body);
    assert.equal(run.last, `unreadable pull request list: ${body}`);
    assert.equal(run.sleeps.length, 0, body);
    assert.deepEqual(run.calls, [DRAFT_REPO, DRAFT_LIST], body);
  }
  const garbled = await waitDraft([[0, 'not json']]);
  assert.equal(garbled.status, 1);
  assert.match(garbled.last, /JSON/);
  assert.equal(garbled.sleeps.length, 0);
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
  for (const body of ['null', '[]', '{}', '{"id":""}', '{"id":7}', '{"id":"R origin"}', 'not json']) {
    const run = await waitDraft([[0, JSON.stringify([draftPr()])]], undefined, { repository: [0, body] });
    assert.equal(run.status, 1, body);
    assert.ok(run.last.trim(), body);
    assert.deepEqual(run.calls, [DRAFT_REPO], body + ': no list after refusal');
    assert.deepEqual(run.sleeps, [], body);
  }
  for (const origin of ['', '\n', 'first\nsecond\n', new Error('origin unavailable')]) {
    const run = await waitDraft([[0, JSON.stringify([draftPr()])]], undefined, { origin });
    assert.equal(run.status, 1, String(origin));
    assert.ok(run.last.trim());
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.sleeps, []);
  }
  const unreadable = await waitDraft([[0, 'not json'], [0, JSON.stringify([draftPr()])]]);
  assert.equal(unreadable.status, 1);
  assert.deepEqual(unreadable.calls, [DRAFT_REPO, DRAFT_LIST]);
  assert.deepEqual(unreadable.sleeps, []);
  const unavailable = await waitDraft([], undefined, { repository: [1, 'repository unavailable'] });
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.last, 'repository unavailable');
  assert.deepEqual(unavailable.calls, [DRAFT_REPO]);
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
