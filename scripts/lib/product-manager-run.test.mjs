// product-manager-run.test.mjs: the loop of the Codex product manager run: which results continue it, that sessions run
// one at a time, and that one end session's message is printed once.
//
// Loop scenarios run `main` with an injected session starter that writes each message file as the real session would.
// The wire proofs run the default starter against a stand-in written to a temporary folder, started through Node.
//
// Recurring cost: the loop cases start no process but one `git rev-parse` each; the wire proofs start Node for each
// session and for that same `git rev-parse`, with no network and no Codex.
// Removal condition: retire with scripts/product-manager-run.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitEnvironment } from './factory-sync.mjs';
import { CARD_PROMPT, END_PROMPT_PREFIX, GUARD_WITNESS, sessionArgv } from './product-manager-run.mjs';
import { main } from '../product-manager-run.mjs';

const USAGE = 'usage: node scripts/product-manager-run.mjs';
const END_MESSAGE = 'End of run summary.';
const END_REPLY = { message: END_MESSAGE };
// The runtime's own refusal line, as the guard probe showed it on the session's stderr (spelled out here, not imported).
const GUARD_REFUSAL = 'Command blocked by PreToolUse hook: Blocked: git commit';
const STDERR_FIRST_WITNESS = `warning: an unrelated line\n${GUARD_REFUSAL}: the owner commits\n`;
const firstWitnessOnly = (reply) => ({ ...reply, stderr: STDERR_FIRST_WITNESS });
// The runtime's refusal of the run session's publish check, spelled out here for the same reason.
const PUBLISH_REFUSAL = 'Command blocked by PreToolUse hook: Blocked: a product manager run session';
const STDERR_SHOWN = `${STDERR_FIRST_WITNESS}${PUBLISH_REFUSAL} does not publish\n`;
const shown = (reply) => ({ ...reply, stderr: STDERR_SHOWN });

// A starter that replies from the script, one reply per session: { message, stderr, events, exitCode, spawnError }. A
// reply without a message, stderr or events writes no such file. `maxOpen` is the most sessions ever open at once.
function scriptedSessions(replies) {
  const calls = [];
  let open = 0;
  let maxOpen = 0;
  const startSession = async ({ argv, logs }) => {
    const reply = replies[calls.length];
    if (!reply) throw new Error(`session ${calls.length + 1} was not expected`);
    const outputFile = argv[argv.indexOf('--output-last-message') + 1];
    calls.push({ prompt: argv.at(-1), outputFile });
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((later) => setImmediate(later));
    if (reply.message !== undefined) writeFileSync(outputFile, reply.message);
    if (reply.stderr !== undefined) writeFileSync(`${logs}.stderr.log`, reply.stderr);
    if (reply.events !== undefined) writeFileSync(`${logs}.jsonl`, reply.events);
    open -= 1;
    return { exitCode: reply.exitCode ?? 0, spawnError: reply.spawnError };
  };
  return { startSession, calls, get maxOpen() { return maxOpen; } };
}

// Runs `main` and returns what it printed (`printed` is both streams together) and the text of run-end.txt, removing
// the results folder the sessions wrote into.
async function runWith(replies, args = []) {
  const sessions = scriptedSessions(replies);
  const logged = [];
  const errors = [];
  const output = { log: (text) => logged.push(text), error: (text) => errors.push(text) };
  const code = await main(args, { startSession: sessions.startSession, output });
  const folder = sessions.calls.length > 0 ? dirname(sessions.calls[0].outputFile) : undefined;
  const runEnd = folder && existsSync(join(folder, 'run-end.txt')) ? readFileSync(join(folder, 'run-end.txt'), 'utf8') : undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
  return { code, logged, errors, printed: [...logged, ...errors], runEnd, folder, sessions };
}

test('a built, a parked and a split result each start the next card session, one at a time', async () => {
  const { code, logged, sessions, folder } = await runWith([
    shown({ message: 'Decision card.\nRun result: built 7\n' }),
    shown({ message: 'Run result: parked 8: which way?' }),
    shown({ message: 'Run result: split 9 into 10, 11' }),
    shown({ message: 'Run result: stop none: nothing is free' }),
    shown(END_REPLY),
  ]);
  assert.deepEqual(sessions.calls.map((call) => call.prompt), [CARD_PROMPT, CARD_PROMPT, CARD_PROMPT, CARD_PROMPT, END_PROMPT_PREFIX + folder]);
  assert.equal(sessions.maxOpen, 1);
  assert.equal(code, 0);
  assert.equal(logged.filter((text) => text === END_MESSAGE).length, 1);
});

test('a stop result ends the run and starts one end session named with the results folder', async () => {
  const { code, logged, runEnd, folder, sessions } = await runWith([
    shown({ message: 'Run result: stop none: the mode is off' }),
    shown(END_REPLY),
  ]);
  assert.equal(sessions.calls.length, 2);
  assert.equal(sessions.calls[1].prompt, END_PROMPT_PREFIX + folder);
  assert.equal(basename(dirname(folder)), basename(tmpdir()));
  assert.match(basename(folder), /^product-manager-run-/);
  assert.equal(runEnd, 'Card session 1 stopped: Run result: stop none: the mode is off\n');
  assert.equal(code, 0);
  assert.deepEqual(logged, [END_MESSAGE]);
});

test('a nonzero exit ends the run even with a built line', async () => {
  const { code, runEnd, sessions } = await runWith([
    shown({ message: 'Run result: built 7', exitCode: 1 }),
    shown(END_REPLY),
  ]);
  assert.equal(sessions.calls.length, 2);
  assert.equal(runEnd, 'Card session 1 exited with 1\n');
  assert.equal(code, 0);
});

test('a result line that is not the last line, a blank message or a missing message file ends the run', async () => {
  const cases = {
    'a result line followed by another line': { message: 'Run result: built 7\nAll done.' },
    'a built line followed by more text': { message: 'Run result: built 7 and then some' },
    'a parked line with no question': { message: 'Run result: parked 8:' },
    'a blank message': { message: '  \n' },
    'a missing message file': {},
  };
  for (const [label, reply] of Object.entries(cases)) {
    const { runEnd, sessions } = await runWith([shown(reply), shown(END_REPLY)]);
    assert.equal(sessions.calls.length, 2, label);
    assert.equal(runEnd, 'Card session 1 ended without a Run result line\n', label);
  }
});

test('a spawn failure ends the run naming the cause', async () => {
  const { runEnd, sessions } = await runWith([
    { exitCode: null, spawnError: 'could not start codex (ENOENT)' },
    shown(END_REPLY),
  ]);
  assert.equal(sessions.calls.length, 2);
  assert.equal(runEnd, 'Card session 1 could not start codex (ENOENT)\n');
});

test('an argument is refused with exit 2 before any session starts', async () => {
  const { code, errors, logged, sessions } = await runWith([], ['--now']);
  assert.equal(code, 2);
  assert.deepEqual(errors, [USAGE]);
  assert.deepEqual(logged, []);
  assert.equal(sessions.calls.length, 0);
});

test("GUARD_WITNESS is the runtime's own refusal line", () => {
  assert.equal(GUARD_WITNESS, 'Command blocked by PreToolUse hook: Blocked: git commit');
});

test('ANTI-REGRESSION: a built session whose runtime log shows no guard refusal ends the run and starts no further session', async () => {
  const cases = {
    'a runtime log of other lines': { stderr: 'warning: an unrelated line\n' },
    'an empty runtime log': { stderr: '' },
    'a missing runtime log': {},
  };
  for (const [label, log] of Object.entries(cases)) {
    const { code, printed, sessions } = await runWith([
      { message: 'Run result: built 7', ...log },
      shown({ message: 'Run result: stop none: nothing is free' }),
      shown(END_REPLY),
    ]);
    assert.equal(sessions.calls.length, 1, label);
    assert.equal(code, 1, label);
    assert.equal(printed.length, 1, label);
    assert.match(printed[0], /guard/i, label);
    assert.match(printed[0], /Before intake/, label);
  }
});

test("a witness only in the session's last message or event file does not count", async () => {
  const { code, sessions } = await runWith([
    {
      message: `${GUARD_REFUSAL}\n${PUBLISH_REFUSAL}\nRun result: built 7`,
      events: `{"type":"item.completed","text":"${GUARD_REFUSAL}"}\n{"type":"item.completed","text":"${PUBLISH_REFUSAL}"}\n`,
      stderr: 'warning: an unrelated line\n',
    },
    shown({ message: 'Run result: stop none: nothing is free' }),
    shown(END_REPLY),
  ]);
  assert.equal(sessions.calls.length, 1);
  assert.equal(code, 1);

  const control = await runWith([
    shown({ message: 'Run result: built 7' }),
    shown({ message: 'Run result: stop none: nothing is free' }),
    shown(END_REPLY),
  ]);
  assert.equal(control.sessions.calls.length, 3);
  assert.equal(control.code, 0);
});

test('an end session that fails, shows no guard refusal or leaves a blank message prints one message with the reason and the results folder, and exits 1', async () => {
  const stop = shown({ message: 'Run result: stop none: the mode is off' });
  const cases = {
    'an end session that exits 1': shown({ message: END_MESSAGE, exitCode: 1 }),
    'an end session that fails to start': { exitCode: null, spawnError: 'could not start codex (ENOENT)' },
    'an end session with no guard refusal': { message: END_MESSAGE, stderr: 'warning: an unrelated line\n' },
    'an end session with a blank message': shown({ message: '  \n' }),
    'an end session with no message file': shown({}),
  };
  for (const [label, end] of Object.entries(cases)) {
    const { code, printed, folder } = await runWith([stop, end]);
    assert.equal(printed.length, 1, label);
    assert.equal(code, 1, label);
    assert.ok(printed[0].includes(folder), label);
    assert.ok(printed[0].includes('the mode is off'), label);
  }
});

test('the stop reason appears exactly once in everything printed across a three-card run', async () => {
  const occurrences = (printed, text) => printed.join('\n').split(text).length - 1;

  const stopped = await runWith([
    shown({ message: 'Run result: built 7' }),
    shown({ message: 'Run result: parked 8: which way?' }),
    shown({ message: 'Run result: stop none: the mode is off' }),
    shown({ message: 'The run stopped: the mode is off.' }),
  ]);
  assert.equal(occurrences(stopped.printed, 'the mode is off'), 1);

  const unguarded = await runWith([
    shown({ message: 'Run result: built 7' }),
    shown({ message: 'Run result: parked 8: which way?' }),
    { message: 'Run result: built 9', stderr: 'warning: an unrelated line\n' },
    shown({ message: 'Run result: stop none: the mode is off' }),
    shown(END_REPLY),
  ]);
  assert.equal(unguarded.sessions.calls.length, 3);
  assert.equal(occurrences(unguarded.printed, 'Before intake'), 1);
  assert.equal(occurrences(unguarded.printed, 'Card session 3'), 1);
});

test("each card session's progress line says the guard refusal was shown", async () => {
  const { logged } = await runWith([
    shown({ message: 'Run result: built 7' }),
    shown({ message: 'Run result: parked 8: which way?' }),
    shown({ message: 'Run result: split 9 into 10, 11' }),
    shown({ message: 'Run result: stop none: nothing is free' }),
    shown(END_REPLY),
  ]);
  const progress = logged.filter((text) => /^Card session \d+ finished/.test(text));
  assert.equal(progress.length, 3);
  for (const line of progress) assert.match(line, /guard refusal was shown/);
});

// Stand-in for `codex`: its first argument picks the mode, the rest is the session's argv. Card 1 writes a built line
// (and exits 1 in the `exit1` mode), card 2 a stop line, and the end session writes its own prompt as its message.
const STAND_IN = `
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const [mode, ...argv] = process.argv.slice(2);
const prompt = argv.at(-1);
const file = argv[argv.indexOf('--output-last-message') + 1];
console.log('cwd ' + process.cwd());
console.error('stderr of ' + basename(file));
console.error(${JSON.stringify(GUARD_REFUSAL)});
console.error(${JSON.stringify(PUBLISH_REFUSAL)});
if (prompt.startsWith(${JSON.stringify(END_PROMPT_PREFIX)})) writeFileSync(file, prompt);
else if (basename(file) === 'card-1.txt') {
  writeFileSync(file, 'Run result: built 1');
  if (mode === 'exit1') process.exitCode = 1;
} else writeFileSync(file, 'Run result: stop none: done');
`;

async function runStandIn(mode, source = STAND_IN) {
  const home = mkdtempSync(join(tmpdir(), 'product-manager-run-test-'));
  try {
    const script = join(home, 'stand-in.mjs');
    writeFileSync(script, source);
    const logged = [];
    const code = await main([], { command: [process.execPath, script, mode], output: { log: (text) => logged.push(text), error: assert.fail } });
    const folder = logged.at(-1).slice(END_PROMPT_PREFIX.length);
    const files = readdirSync(folder).sort();
    const cardLog = readFileSync(join(folder, 'card-1.jsonl'), 'utf8');
    const endLog = readFileSync(join(folder, 'end.jsonl'), 'utf8');
    const cardErrors = readFileSync(join(folder, 'card-1.stderr.log'), 'utf8');
    rmSync(folder, { recursive: true, force: true });
    return { code, logged, files, cardLog, endLog, cardErrors };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('the real child wire: a stand-in session that writes its message continues, and one that exits 1 ends the run', async () => {
  const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: gitEnvironment() }).trim());
  const sessionFiles = (name) => [`${name}.jsonl`, `${name}.stderr.log`, `${name}.txt`];

  const continued = await runStandIn('continue');
  assert.equal(continued.code, 0);
  assert.deepEqual(continued.files, [...sessionFiles('card-1'), ...sessionFiles('card-2'), ...sessionFiles('end'), 'run-end.txt']);
  assert.deepEqual(continued.logged.slice(0, 1), ['Card session 1 finished: built; the guard refusal was shown']);
  assert.equal(continued.logged.length, 2);
  assert.equal(realpathSync.native(continued.cardLog.trim().slice('cwd '.length)), realpathSync.native(root));
  assert.equal(continued.cardErrors, `stderr of card-1.txt\n${GUARD_REFUSAL}\n${PUBLISH_REFUSAL}\n`);

  const stopped = await runStandIn('exit1');
  assert.equal(stopped.code, 0);
  assert.deepEqual(stopped.files, [...sessionFiles('card-1'), ...sessionFiles('end'), 'run-end.txt']);
});

test('ANTI-REGRESSION: each session starts with the workspace-write sandbox, on-request approvals and Auto-review, and no flag that skips them', () => {
  assert.deepEqual(sessionArgv('<file>', '<prompt>'), [
    'exec',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy=on-request',
    '-c', 'approvals_reviewer=auto_review',
    '--json',
    '--output-last-message', '<file>',
    '<prompt>',
  ]);
});

// Stand-in for `codex` that shows both refusals and logs, as JSON, the run session mark and the argv it was started with.
const MARK_STAND_IN = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(3);
const prompt = argv.at(-1);
console.log(JSON.stringify({ mark: process.env.PRODUCT_MANAGER_RUN_SESSION ?? 'no mark', argv }));
console.error(${JSON.stringify(STDERR_SHOWN)});
writeFileSync(argv[argv.indexOf('--output-last-message') + 1], prompt.startsWith(${JSON.stringify(END_PROMPT_PREFIX)}) ? prompt : 'Run result: stop none: done');
`;

test('a session with no publish refusal witness ends the run', async () => {
  const stop = shown({ message: 'Run result: stop none: the mode is off' });
  const card = await runWith([firstWitnessOnly({ message: 'Run result: built 7' }), stop, shown(END_REPLY)]);
  const end = await runWith([stop, firstWitnessOnly({ message: END_MESSAGE })]);
  const control = await runWith([shown({ message: 'Run result: built 7' }), stop, shown(END_REPLY)]);
  const marks = await runStandIn('continue', MARK_STAND_IN);
  const outcome = ({ sessions, code, printed }) => ({ sessions: sessions.calls.length, code, printed: printed.length });
  const folder = marks.logged.at(-1).slice(END_PROMPT_PREFIX.length);
  const cardRun = JSON.parse(marks.cardLog);
  const endRun = JSON.parse(marks.endLog);

  // One comparison, so a failure shows every safeguard that is missing.
  assert.deepEqual(
    {
      card: outcome(card),
      end: outcome(end),
      control: outcome(control),
      cardMark: cardRun.mark,
      endMark: endRun.mark,
      cardArgv: cardRun.argv,
      endArgv: endRun.argv,
    },
    {
      card: { sessions: 1, code: 1, printed: 1 },
      end: { sessions: 2, code: 1, printed: 1 },
      control: { sessions: 3, code: 0, printed: 2 },
      cardMark: '1',
      endMark: '1',
      cardArgv: sessionArgv(join(folder, 'card-1.txt'), CARD_PROMPT),
      endArgv: sessionArgv(join(folder, 'end.txt'), END_PROMPT_PREFIX + folder),
    },
  );
  assert.match(card.printed[0], /publish/i);
  assert.match(card.printed[0], /Before intake/);
  assert.ok(end.printed[0].includes(end.folder));
  assert.ok(end.printed[0].includes('the mode is off'));
});

test('a session with the publish refusal but no guard refusal ends the run', async () => {
  const stop = shown({ message: 'Run result: stop none: the mode is off' });
  const publishOnly = (reply) => ({ ...reply, stderr: `${PUBLISH_REFUSAL}\n` });
  const card = await runWith([publishOnly({ message: 'Run result: built 7' }), stop, shown(END_REPLY)]);
  const end = await runWith([stop, publishOnly({ message: END_MESSAGE })]);

  assert.equal(card.sessions.calls.length, 1);
  assert.equal(card.code, 1);
  assert.equal(card.printed.length, 1);
  assert.match(card.printed[0], /guard refusal/);
  assert.equal(end.sessions.calls.length, 2);
  assert.equal(end.code, 1);
  assert.equal(end.printed.length, 1);
  assert.match(end.printed[0], /guard refusal/);
});

// Recurring cost: one read of the resume skill.
test('the resume skill names the launcher command and the prompts the launcher sends', () => {
  const resume = readFileSync(new URL('../../.agents/skills/resume/SKILL.md', import.meta.url), 'utf8');
  for (const text of ['node scripts/product-manager-run.mjs', CARD_PROMPT, END_PROMPT_PREFIX,'git push --dry-run ./.product-manager-run-no-remote HEAD']) {
    assert.ok(resume.includes(text), `the resume skill does not hold ${text}`);
  }
});
