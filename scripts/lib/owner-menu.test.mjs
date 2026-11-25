// owner-menu.test.mjs: the owner-menu hook. A menu answer from the queue panel or the coordinator reaches a coordinated
// job's session only as a PermissionRequest decision for the exact ask it names, an answer given in the job's tab ends
// the waiting hook with no decision.
//
// The contract scripts/lib/owner-menu.mjs meets:
// - It exports APPROVE_LABEL and `ownerMenu(input, { env, git, hc, now, sleep })`, a
//   promise of the object the hook prints as JSON, or of undefined where it prints nothing.
// - `input` is the hook's stdin as Claude Code writes it: `hook_event_name` (PermissionRequest or PostToolUse), `cwd`, the
//   job worktree, `tool_name`, `tool_input` and, after the tool, `tool_response`.
// - `env` holds FABRAIK_COORDINATED_JOB, PRE_APPROVED_RUN_CARD, HC_TERMINAL_ID and HERDR_APP_HOME, the Herdr home its ask
//   store `data/fabraik-asks/<terminal>/<askId>/` sits under.
// - `git(args)` runs git in the worktree and returns its stdout; every ask reads the job's main checkout as the parent folder
//   of `git rev-parse --path-format=absolute --git-common-dir`.
// - `hc(args)` resolves to `{ code, stdout, stderr }`; the hook reads its terminal's status as `hc get <terminal> --json`.
// - `now()` is the clock in milliseconds and `sleep(ms)` resolves when the waiting hook may look again.
// .claude/hooks/owner-menu.mjs reads stdin, calls ownerMenu with the real seams and prints what it returns.
//
// The library cases run ownerMenu on a real temporary Herdr home and worktree with a fake git, which hashes the saved
// card's files as git hashes a blob, a fake hc and a fake clock whose sleep runs each case's scripted step, so nothing
// really waits. Expected decisions are Claude Code's documented PermissionRequest output in the shapes the card's spike
// observed; the labels, messages and joined value are the approved plan's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVE_LABEL, ownerMenu } from './owner-menu.mjs';
import { presentRuntimes } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = join(ROOT, '.claude/hooks/owner-menu.mjs');
const withoutClaude = !presentRuntimes(ROOT).includes('claude') && 'the settings file names no claude runtime';

const CARD = '857';
const TERMINAL = 't7';
const HEAD = '3f2a9c1e5b7d4068a1c2e3f4a5b6c7d8e9f0a1b2';
const BODY = 'Ready to deliver: the deliver question and the guard.\n';
const REVIEW_BODY = `.claude/worklog/job_${CARD}-review-${HEAD}/body.md`;
// The fake clock's start, in milliseconds.
const START = 1_795_000_000_000;
// A step returns AGAIN to run once more at the hook's next look instead of moving on.
const AGAIN = Symbol('again');

const COLOUR = { question: 'Which colour do you pick?', header: 'Colour', multiSelect: false,
  options: [{ label: 'Red', description: 'The warm one' }, { label: 'Blue', description: 'The cool one' }] };
const LETTERS = { question: 'Which letters go in?', header: 'Letters', multiSelect: true,
  options: ['A', 'B', 'C', 'D'].map((label) => ({ label, description: `The letter ${label}` })) };
const DELIVER = { question: 'Deliver card 857 at the version the decision card shows?', header: 'Deliver', multiSelect: false,
  options: [{ label: 'Yes, deliver', description: 'Push and merge this version' }, { label: 'No, put aside', description: 'Keep it unmerged' }] };

// git's blob id of `bytes`, the value `git hash-object --no-filters` prints for a file holding them.
const blobId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

const hookInput = (event, cwd, toolName, toolInput, toolResponse) => ({
  session_id: '0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b', transcript_path: join(cwd, 'transcript.jsonl'), cwd, permission_mode: 'auto',
  hook_event_name: event, tool_name: toolName, tool_input: toolInput, ...(toolResponse ? { tool_response: toolResponse } : {}),
});
const permissionRequest = (cwd, toolName, toolInput) => hookInput('PermissionRequest', cwd, toolName, toolInput);
// The PostToolUse input after AskUserQuestion returned `answers`, which Claude Code carries in both the input and the response.
const answered = (cwd, questions, answers) => hookInput('PostToolUse', cwd, 'AskUserQuestion', { questions, answers }, { questions, answers });
const decided = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

// A Herdr home and a job worktree for card 857 holding its saved card at HEAD, with the fakes ownerMenu takes. `main` is the
// job's main checkout, whose git folder the fake git names as the common one until `state.commonDir` holds an error.
function menuFixture(t, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'owner-menu-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'herdr');
  const main = join(root, 'main');
  const worktree = join(root, 'job-857');
  mkdirSync(dirname(join(worktree, REVIEW_BODY)), { recursive: true });
  writeFileSync(join(worktree, REVIEW_BODY), BODY);
  const store = join(home, 'data', 'fabraik-asks', TERMINAL);
  const state = { head: HEAD, clock: START, git: /** @type {string[][]} */ ([]), hc: /** @type {string[][]} */ ([]),
    commonDir: /** @type {string | Error} */ (join(main, '.git')) };
  const git = (args) => {
    state.git.push(args);
    if (args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir') {
      if (state.commonDir instanceof Error) throw state.commonDir;
      return `${state.commonDir}\n`;
    }
    if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') return `${state.head}\n`;
    if (args[0] === 'hash-object') return `${args.slice(args.indexOf('--') + 1).map((file) => blobId(readFileSync(join(worktree, file)))).join('\n')}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const hc = async (args) => {
    state.hc.push(args);
    if (args.join(' ') === `get ${TERMINAL} --json`) {
      const status = { app: 'claude-code', kind: 'question', msg: 'answer: a menu', state: 'blocked' };
      return { code: 0, stdout: JSON.stringify({ address: TERMINAL, name: `fabraik-job-${CARD}`, state: 'live', status }), stderr: '' };
    }
    throw new Error(`unexpected hc ${args.join(' ')}`);
  };
  // The seams of one hook run. Each sleep advances the clock and runs the first remaining step; a run that keeps waiting
  // past its steps fails instead of hanging. With no steps, sleeping at all fails.
  const seams = (steps) => ({
    env: { FABRAIK_COORDINATED_JOB: '1', PRE_APPROVED_RUN_CARD: CARD, HC_TERMINAL_ID: TERMINAL, HERDR_APP_HOME: home, ...env },
    git, hc, now: () => state.clock,
    sleep: async (ms) => {
      if (!steps) throw new Error('this hook run must not wait');
      state.clock += ms;
      if (state.clock > START + 3_600_000) throw new Error('the hook kept waiting past its scripted steps');
      if (steps.length > 0 && (await steps[0]()) !== AGAIN) steps.shift();
    },
  });
  const asks = () => (existsSync(store) ? readdirSync(store) : []);
  const file = (id, name) => join(store, id, name);
  const json = (id, name) => JSON.parse(readFileSync(file(id, name), 'utf8'));
  const answer = (id, record) => writeFileSync(file(id, 'answer.json'), JSON.stringify(record));
  // Every file of ask `id`, by name, with its text.
  const snapshot = (id) => Object.fromEntries(readdirSync(join(store, id)).sort().map((name) => [name, readFileSync(file(id, name), 'utf8')]));
  return { home, main, worktree, store, state, seams, asks, file, json, answer, snapshot };
}

// Runs the PermissionRequest hook for `input` and resolves to what it returns, with the id of the ask it opened. `script`
// takes that ask's context and gives the steps to run while it waits; its first step runs once the ask's folder exists.
async function waitOn(fx, input, script) {
  const before = new Set(fx.asks());
  const ask = { id: '' };
  const opened = () => {
    const added = fx.asks().filter((name) => !before.has(name));
    if (added.length !== 1) return AGAIN;
    ask.id = added[0];
    return undefined;
  };
  const steps = [opened, ...script(ask)];
  const result = await ownerMenu(input, fx.seams(steps));
  return { result, ...ask };
}

// A step that waits for the hook to deal with the answer file, then checks it was refused and not taken.
const refusedIn = (fx, ask) => () => {
  if (existsSync(fx.file(ask.id, 'answer.json'))) return AGAIN;
  assert.ok(existsSync(fx.file(ask.id, 'rejected.json')), 'the refused answer is kept as rejected.json');
  assert.ok(!existsSync(fx.file(ask.id, 'taken.json')), 'a refused answer is never taken');
  return undefined;
};

test('the deliver question\'s approving choice is Yes, deliver', () => {
  assert.equal(APPROVE_LABEL, 'Yes, deliver');
});

test('outside a coordinated Herdr job the hook prints nothing, writes nothing and asks nothing', async (t) => {
  for (const missing of ['FABRAIK_COORDINATED_JOB', 'PRE_APPROVED_RUN_CARD', 'HC_TERMINAL_ID']) {
    const fx = menuFixture(t, { [missing]: undefined });
    const asked = await ownerMenu(permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [DELIVER] }), fx.seams(null));
    const after = await ownerMenu(answered(fx.worktree, [DELIVER], { [DELIVER.question]: APPROVE_LABEL }), fx.seams(null));
    assert.equal(asked, undefined, `without ${missing}`);
    assert.equal(after, undefined, `without ${missing}`);
    assert.ok(!existsSync(join(fx.home, 'data')), `without ${missing} no ask is stored`);
    assert.deepEqual([fx.state.git, fx.state.hc], [[], []], `without ${missing} neither git nor hc runs`);
  }
});

test('a panel choice for a one-question ask allows with the chosen label, records the take and claims no delivery', async (t) => {
  const fx = menuFixture(t);
  const questions = [COLOUR];
  const asked = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), (ask) => [
    () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', answers: { [COLOUR.question]: { choices: ['Blue'] } } }),
  ]);
  assert.deepEqual(asked.result, decided({ behavior: 'allow', updatedInput: { questions, answers: { [COLOUR.question]: 'Blue' } } }));

  assert.match(asked.id, /^[0-9a-f]{32}$/);
  const record = fx.json(asked.id, 'ask.json');
  assert.deepEqual({ format: record.format, id: record.id, terminal: record.terminal, worktree: record.worktree, kind: record.kind,
    toolName: record.toolName, questions: record.questions },
  { format: 1, id: asked.id, terminal: TERMINAL, worktree: fx.worktree, kind: 'question', toolName: 'AskUserQuestion', questions });
  assert.equal(record.version, undefined, 'only a deliver question captures a version');

  assert.deepEqual(Object.keys(fx.json(asked.id, 'taken.json')), ['takenAt']);
  const files = fx.snapshot(asked.id);
  assert.ok(!('end.json' in files), 'the hook never writes the end signal itself');
  for (const [name, text] of Object.entries(files)) assert.doesNotMatch(`${name} ${text}`, /delivered/i, `${name} claims no delivery`);
});

test('a multi-question answer joins each question\'s choices in option order and then its typed text', async (t) => {
  const fx = menuFixture(t);
  const questions = [COLOUR, LETTERS];
  const asked = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), (ask) => [
    () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel',
      answers: { [COLOUR.question]: { choices: ['Red'] }, [LETTERS.question]: { choices: ['C', 'A'], text: 'also D' } } }),
  ]);
  assert.deepEqual(asked.result, decided({ behavior: 'allow',
    updatedInput: { questions, answers: { [COLOUR.question]: 'Red', [LETTERS.question]: 'A, C, also D' } } }));
});

test('an answer wrong in shape is set aside as rejected.json with no decision, and the hook waits on for a valid one', async (t) => {
  const fx = menuFixture(t);
  const questions = [COLOUR, LETTERS];
  const valid = { [COLOUR.question]: { choices: ['Red'] }, [LETTERS.question]: { choices: ['B'] } };
  const wrong = {
    'a wrong askId': () => ({ format: 1, askId: '0'.repeat(32), by: 'panel', answers: valid }),
    'a label not offered': (id) => ({ format: 1, askId: id, by: 'panel', answers: { ...valid, [COLOUR.question]: { choices: ['Green'] } } }),
    'two choices for a single-select question': (id) => ({ format: 1, askId: id, by: 'panel', answers: { ...valid, [COLOUR.question]: { choices: ['Red', 'Blue'] } } }),
    'a missing question': (id) => ({ format: 1, askId: id, by: 'panel', answers: { [LETTERS.question]: { choices: ['B'] } } }),
    'an extra key': (id) => ({ format: 1, askId: id, by: 'panel', answers: { ...valid, 'Which shape?': { choices: ['Square'] } } }),
    'text over 500 characters': (id) => ({ format: 1, askId: id, by: 'panel', answers: { ...valid, [COLOUR.question]: { text: 'x'.repeat(501) } } }),
    'text holding a credential': (id) => ({ format: 1, askId: id, by: 'panel',
      answers: { ...valid, [COLOUR.question]: { text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } }),
  };
  for (const [shape, record] of Object.entries(wrong)) {
    const asked = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), (ask) => [
      () => fx.answer(ask.id, record(ask.id)),
      refusedIn(fx, ask),
      () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', answers: valid }),
    ]);
    assert.ok(existsSync(fx.file(asked.id, 'rejected.json')), `${shape} was set aside as rejected.json`);
    assert.deepEqual(asked.result, decided({ behavior: 'allow', updatedInput: { questions, answers: { [COLOUR.question]: 'Red', [LETTERS.question]: 'B' } } }),
      `after ${shape} only the valid answer is decided`);
  }
});

test('a permission prompt answer allows once with no permission update, or denies with the plan\'s message or the owner\'s words', async (t) => {
  const fx = menuFixture(t);
  const input = permissionRequest(fx.worktree, 'Bash', { command: 'npm test', description: 'Run the tests' });
  const answers = [
    [{ choice: 'Allow once' }, { behavior: 'allow' }],
    [{ choice: 'Deny' }, { behavior: 'deny', message: 'The owner denied this from the queue panel.' }],
    [{ text: 'Run only the focused test.' }, { behavior: 'deny', message: 'Run only the focused test.' }],
  ];
  for (const [given, decision] of answers) {
    const asked = await waitOn(fx, input, (ask) => [() => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'coordinator', ...given })]);
    assert.deepEqual(asked.result, decided(decision), JSON.stringify(given));
    assert.equal(fx.json(asked.id, 'ask.json').kind, 'permission');
  }
});

test('ANTI-REGRESSION: a permission prompt takes an allow from the panel only where the panel showed the whole call, and never with a lasting permission rule', async (t) => {
  const fx = menuFixture(t);
  const file = join(fx.worktree, 'notes.md');
  const long = `echo ${'a'.repeat(600)}`;
  // A credential-looking token, and the runs of four of its first eight characters after `ghp_` that no ask may record.
  const TOKEN = 'ghp_ghijklmnopqrstuvwxyzghijklmnopqrstuv';
  const RUNS = [0, 1, 2, 3, 4].map((at) => TOKEN.slice(4 + at, 8 + at));
  for (const run of RUNS) assert.match(run, /^[g-z]{4}$/, 'a piece is four letters a hexadecimal ID cannot hold');
  // A command whose 500-character cut ends just after the token's `ghp_` prefix, so the token runs past the cut.
  const straddling = `echo ${'a'.repeat(490)} ${TOKEN}`;
  // Each call, with what its ask records: the whole call only for an uncut Bash command or WebFetch url holding no credential,
  // whose one-line display is the call text exactly (no newline, tab or doubled space).
  /** @type {{ toolName: string, toolInput: object, recorded: { whole: boolean, input?: string } }[]} */
  const calls = [
    { toolName: 'Bash', toolInput: { command: 'npm test', description: 'Run the tests' }, recorded: { input: 'npm test', whole: true } },
    { toolName: 'WebFetch', toolInput: { url: 'https://example.com/docs', prompt: 'Summarise the page' },
      recorded: { input: 'https://example.com/docs', whole: true } },
    { toolName: 'Write', toolInput: { file_path: file, content: 'Text the panel never shows' }, recorded: { whole: false } },
    { toolName: 'Edit', toolInput: { file_path: file, old_string: 'never', new_string: 'always' }, recorded: { whole: false } },
    { toolName: 'Bash', toolInput: { command: long }, recorded: { whole: false } },
    { toolName: 'Bash', toolInput: { command: 'echo safe # checked\nrm -rf /tmp/job-output' },
      recorded: { input: 'echo safe # checked\nrm -rf /tmp/job-output', whole: false } },
    { toolName: 'Bash', toolInput: { command: 'echo\tsafe' }, recorded: { input: 'echo\tsafe', whole: false } },
    { toolName: 'Bash', toolInput: { command: 'echo  safe' }, recorded: { input: 'echo  safe', whole: false } },
    { toolName: 'Bash', toolInput: { command: `GH_TOKEN=${TOKEN} gh pr list` },
      recorded: { input: 'Not shown here: it looks like it holds a credential', whole: false } },
    { toolName: 'Bash', toolInput: { command: straddling },
      recorded: { input: 'Not shown here: it looks like it holds a credential', whole: false } },
  ];
  // The fixture's random temporary root as ask.json writes it, backslashes doubled on Windows, so no path can supply a piece.
  const root = JSON.stringify(dirname(fx.worktree)).slice(1, -1);
  for (const { toolName, toolInput, recorded } of calls) {
    const call = `${toolName} ${JSON.stringify(toolInput).slice(0, 80)}`;
    const give = (id, choice) => fx.answer(id, { format: 1, askId: id, by: 'panel', choice });
    const asked = await waitOn(fx, permissionRequest(fx.worktree, toolName, toolInput), (ask) => (recorded.whole
      ? [() => give(ask.id, 'Allow once')]
      : [() => give(ask.id, 'Allow once'), refusedIn(fx, ask), () => give(ask.id, 'Deny')]));
    const record = fx.json(asked.id, 'ask.json');
    assert.equal(record.whole, recorded.whole, `${call} records whole as ${recorded.whole}`);
    if ('input' in recorded) assert.equal(record.input, recorded.input, call);
    const text = readFileSync(fx.file(asked.id, 'ask.json'), 'utf8');
    const content = text.replaceAll(root, '');
    assert.doesNotMatch(text, /ghp_/, `${call} stores no credential`);
    for (const run of RUNS) assert.ok(!content.includes(run), `${call} records no part of its credential`);
    assert.deepEqual(asked.result, decided(recorded.whole ? { behavior: 'allow' } : { behavior: 'deny', message: 'The owner denied this from the queue panel.' }),
      `${call}: an allow is taken only on the whole call, and a deny always`);
    assert.ok(!('updatedPermissions' in asked.result.hookSpecificOutput.decision), `${call} adds no lasting permission rule`);
  }
});

test('a permission hook writes the delivered end signal when it decides, and none for an answer it refuses', async (t) => {
  const fx = menuFixture(t);
  const input = permissionRequest(fx.worktree, 'Bash', { command: 'npm test' });
  for (const given of [{ choice: 'Allow once' }, { choice: 'Deny' }, { text: 'Run only the focused test.' }]) {
    const asked = await waitOn(fx, input, (ask) => [
      () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', choice: 'Approve plan' }),
      refusedIn(fx, ask),
      () => {
        assert.ok(!existsSync(fx.file(ask.id, 'end.json')), 'a refused answer writes no end signal');
        fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', ...given });
      },
    ]);
    assert.equal(asked.result?.hookSpecificOutput?.hookEventName, 'PermissionRequest', JSON.stringify(given));
    assert.ok(existsSync(fx.file(asked.id, 'taken.json')), JSON.stringify(given));
    assert.ok(existsSync(fx.file(asked.id, 'end.json')), `${JSON.stringify(given)}: the decided hook writes its end signal before it prints`);
    assert.deepEqual(fx.json(asked.id, 'end.json'), { reason: 'delivered', via: 'panel' }, JSON.stringify(given));
  }
});

test('every ask records the job\'s main checkout, or why it could not be read', async (t) => {
  const fx = menuFixture(t);
  const asks = [
    [permissionRequest(fx.worktree, 'Bash', { command: 'npm test' }), { choice: 'Deny' }],
    [permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [COLOUR] }), { answers: { [COLOUR.question]: { choices: ['Red'] } } }],
    [permissionRequest(fx.worktree, 'ExitPlanMode', { plan: '# Plan\n\nShip it.' }), { choice: 'Keep planning' }],
  ];
  for (const [input, given] of asks) {
    const asked = await waitOn(fx, input, (ask) => [() => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', ...given })]);
    const record = fx.json(asked.id, 'ask.json');
    assert.equal(record.repository, fx.main, `the ${record.kind} ask records the main checkout`);
    assert.equal(record.repositoryUnread, undefined, record.kind);
  }

  fx.state.commonDir = new Error('fatal: not a git repository (or any of the parent directories): .git');
  const unread = await waitOn(fx, permissionRequest(fx.worktree, 'Bash', { command: 'npm test' }), (ask) => [
    () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', choice: 'Deny' }),
  ]);
  const record = fx.json(unread.id, 'ask.json');
  assert.equal(record.repository, undefined, 'a failed read records no repository');
  assert.match(record.repositoryUnread ?? '', /not a git repository/, 'a failed read records its cause');
});

test('a plan answer approves with the received input, or keeps planning with the plan\'s message or the owner\'s words', async (t) => {
  const fx = menuFixture(t);
  const toolInput = { plan: '# Plan\n\nShip the deliver question.', planFilePath: join(fx.worktree, 'plan.md') };
  const input = permissionRequest(fx.worktree, 'ExitPlanMode', toolInput);
  const answers = [
    [{ choice: 'Approve plan' }, { behavior: 'allow', updatedInput: toolInput }],
    [{ choice: 'Keep planning' }, { behavior: 'deny', message: 'The owner asked to keep planning.' }],
    [{ text: 'Split the second slice.' }, { behavior: 'deny', message: 'Split the second slice.' }],
  ];
  for (const [given, decision] of answers) {
    const asked = await waitOn(fx, input, (ask) => [() => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', ...given })]);
    assert.deepEqual(asked.result, decided(decision), JSON.stringify(given));
    assert.equal(fx.json(asked.id, 'ask.json').kind, 'plan');
  }
});

test('an old hook whose ask the tab answered leaves a newer ask and its answer untouched, and the newer hook delivers', async (t) => {
  const fx = menuFixture(t);
  let newer = { result: undefined, id: '' };
  let newerFiles = {};
  // While the old hook waits, the owner answers its menu in the job's tab and the job asks again, answered from the panel.
  const old = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [COLOUR] }), () => [
    async () => {
      newer = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [LETTERS] }), (ask) => [
        () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', answers: { [LETTERS.question]: { choices: ['B'] } } }),
      ]);
      newerFiles = fx.snapshot(newer.id);
    },
  ]);
  assert.deepEqual(newer.result, decided({ behavior: 'allow', updatedInput: { questions: [LETTERS], answers: { [LETTERS.question]: 'B' } } }));
  assert.equal(old.result, undefined, 'the superseded hook ends with no decision');
  assert.deepEqual(fx.snapshot(newer.id), newerFiles, 'the old hook renames and writes nothing in the newer ask');
  for (const name of ['taken.json', 'rejected.json']) assert.ok(!existsSync(fx.file(old.id, name)), `the old hook leaves no ${name}`);
});

test('PostToolUse ends a waiting ask the tab answered, and marks delivered only the answer the panel sent', async (t) => {
  const fx = menuFixture(t);
  const questions = [COLOUR];
  let after;
  const tab = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), () => [
    async () => { after = await ownerMenu(answered(fx.worktree, questions, { [COLOUR.question]: 'Red' }), fx.seams(null)); },
  ]);
  assert.equal(after, undefined);
  assert.deepEqual(fx.json(tab.id, 'end.json'), { reason: 'answered in the job\'s tab' });
  assert.equal(tab.result, undefined, 'the waiting hook exits with no output');

  const panel = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), (ask) => [
    () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', answers: { [COLOUR.question]: { choices: ['Blue'] } } }),
  ]);
  assert.equal(await ownerMenu(answered(fx.worktree, questions, { [COLOUR.question]: 'Blue' }), fx.seams(null)), undefined);
  assert.deepEqual(fx.json(panel.id, 'end.json'), { reason: 'delivered', via: 'panel' });
  assert.deepEqual(fx.json(tab.id, 'end.json'), { reason: 'answered in the job\'s tab' }, 'the earlier ask keeps its own end');
});

test('a deliver answer taken by a hook killed before it printed leaves no end signal', async (t) => {
  const fx = menuFixture(t);
  // The decision is returned but never printed, so Claude receives nothing and no PostToolUse follows. The queue's reading
  // of this folder as undelivered is the panel slice's own test.
  const asked = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [DELIVER] }), (ask) => [
    () => fx.answer(ask.id, { format: 1, askId: ask.id, by: 'panel', answers: { [DELIVER.question]: { choices: [APPROVE_LABEL] } } }),
  ]);
  assert.ok(asked.result, 'the hook took the answer');
  assert.ok(existsSync(fx.file(asked.id, 'taken.json')));
  assert.ok(!existsSync(fx.file(asked.id, 'end.json')), 'no end signal claims delivery');
});

// The hook run as Claude Code runs it, with `input` on stdin, in the environment `env` adds to this one's.
const runHook = (input, env) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
  env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined)) });

test('the hook wrapper hands PostToolUse to the library, which ends the waiting ask', { skip: withoutClaude }, async (t) => {
  const fx = menuFixture(t);
  const questions = [COLOUR];
  /** @type {ReturnType<typeof runHook> | undefined} */
  let wire;
  const waited = await waitOn(fx, permissionRequest(fx.worktree, 'AskUserQuestion', { questions }), () => [
    () => { wire = runHook(answered(fx.worktree, questions, { [COLOUR.question]: 'Red' }), fx.seams(null).env); },
  ]);
  assert.ok(wire, 'the wrapper ran while the ask waited');
  assert.equal(wire.status, 0, `${wire.stdout}${wire.stderr}`);
  assert.equal(wire.stdout, '');
  assert.deepEqual(fx.json(waited.id, 'end.json'), { reason: 'answered in the job\'s tab' });
  assert.equal(waited.result, undefined);
});

test('the hook wrapper outside a coordinated job prints nothing, stores nothing and exits 0', { skip: withoutClaude }, (t) => {
  const fx = menuFixture(t);
  const env = { ...fx.seams(null).env, FABRAIK_COORDINATED_JOB: undefined };
  const wire = runHook(permissionRequest(fx.worktree, 'AskUserQuestion', { questions: [COLOUR] }), env);
  assert.equal(wire.status, 0, wire.stderr);
  assert.equal(wire.stdout, '');
  assert.equal(wire.stderr, '');
  assert.ok(!existsSync(join(fx.home, 'data')), 'no ask is stored');
});
