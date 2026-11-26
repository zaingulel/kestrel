// codex-hook-adapters.test.mjs — the Codex payload adapters both Codex hooks depend on, and the builder
// handoff guard.
//
// Representative cases run the hook itself, since the hook's exit status, stdout and stderr are what Codex reads;
// other handoff guard cases call codexHandoffHook in process against real scratch repositories.
// Recurring cost: 11 hook runs, each a Node start; 33 in-process guard calls, at most 32 on one platform; at most 29
// `git worktree list` runs and one Node start standing in for git; at most 13 scratch repositories with one empty
// commit each, two of them with a second worktree; one directory fixture for the delivery cwd check;
// one copy of the node binary on Windows only; Codex installs only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedDeliveryCwd, codexCommandForGuard, codexCwdForGuard, codexHandoffHook } from './codex-hook-adapters.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { worklogFileName } from '../run-log.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = resolve(ROOT, '.codex/hooks/check-builder-handoff.mjs');

const SESSION = 'session-558';
const AGENT = 'agent-558';
// Stands in for the encrypted dispatch message, so a passing case proves the message is never read.
const OPAQUE = 'gAAAAA' + 'A'.repeat(100);

const UNBOUND = 'no builder handoff is bound to this builder thread: stop and report that the coordinator must dispatch it through .agents/templates/builder-handoff.md';
const UNBOUND_NOTICE = 'No builder handoff is bound to this builder thread, so every tool call will be refused: stop and report that the coordinator must dispatch it through .agents/templates/builder-handoff.md.\n';
const BOUND = 'Your builder handoff, checked against .agents/templates/builder-handoff.md and bound to this builder thread:\n\n';
const NO_SOURCE = (task) => `a Codex builder dispatch needs its filled handoff saved as .claude/worklog/handoffs/${task}.md in the job worktree, as .agents/templates/builder-handoff.md says`;
const BAD_TASK = "a Codex builder dispatch needs a task_name of letters, digits, '-' and '_' only";
const BAD_IDS = "the builder handoff guard needs a session_id and agent_id of letters, digits, '-' and '_' only";
const AMBIGUOUS = (task, paths) => `the builder handoff .claude/worklog/handoffs/${task}.md is saved in more than one worktree: ${paths}`;
const PENDING = (path) => `an earlier builder dispatch in this session has not started its builder: remove ${path} if that dispatch failed`;
const IDENTITY = 'agent handoff requires a readable calling-seat identity';
const STOP_REASON = "builder handoff requires exactly one non-empty 'Stop condition:' line, with its value on the same line: fill .agents/templates/builder-handoff.md instead of hand-writing the handoff";

// A minimal passing handoff; handoff-check.test.mjs owns the checker's own cases.
const HANDOFF = [
  'Slice: Codex handoff fixture',
  'Claim: a builder thread acts on this handoff',
  'Construction mode: evidence-required',
  'Working directory: /tmp/job-558',
  'Focused verification command: node --test scripts/lib/example.test.mjs',
  'Stop condition: the focused test passes',
].join('\n') + '\n';
const HANDOFF_NO_STOP = HANDOFF.replace('Stop condition: the focused test passes\n', '');

const R = (reason) => ({ status: 2, stdout: '', stderr: `Blocked: ${reason}.\n` });
const OK = { status: 0, stdout: '', stderr: '' };
const NOTE = { status: 0, stdout: UNBOUND_NOTICE, stderr: '' };
const BOUND_RESULT = { status: 0, stdout: BOUND + HANDOFF, stderr: '' };

const FIXTURE_ENV = {
  ...gitEnvironment(),
  GIT_AUTHOR_NAME: 'Codex Handoff Test',
  GIT_COMMITTER_NAME: 'Codex Handoff Test',
  GIT_AUTHOR_EMAIL: 'codex-handoff-test@workflow.invalid',
  GIT_COMMITTER_EMAIL: 'codex-handoff-test@workflow.invalid',
};

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: FIXTURE_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-handoff-')));
  git(root, ['init', '-q', 'repo']);
  const repo = join(root, 'repo');
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base']);
  return { root, repo };
}

// Git's own spelling of a worktree path, as `git worktree list` prints it.
const top = (dir) => git(dir, ['rev-parse', '--show-toplevel']).trim();
const rec = (worktree, ...parts) => join(worktree, '.claude', 'worklog', 'handoffs', ...parts);
const save = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const runHook = (repo, input) => {
  const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: FIXTURE_ENV,
  });
  return { status, stdout, stderr };
};

// The guard's logic in process, with the fixture's git environment.
const direct = (input, options = {}) => codexHandoffHook(typeof input === 'string' ? input : JSON.stringify(input), { env: FIXTURE_ENV, ...options });

const spawnCall = (repo, task, extra = {}) => ({
  session_id: SESSION,
  cwd: repo,
  hook_event_name: 'PreToolUse',
  tool_name: 'collaborationspawn_agent',
  tool_input: { agent_type: 'builder', task_name: task, message: OPAQUE },
  ...extra,
});
const start = (repo, seat = 'builder', extra = {}) => ({
  session_id: SESSION,
  cwd: repo,
  hook_event_name: 'SubagentStart',
  agent_type: seat,
  agent_id: AGENT,
  ...extra,
});
const call = (repo, seat = 'builder', tool = 'Bash', extra = {}) => ({
  ...start(repo, seat),
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: { cmd: 'touch probe.txt' },
  ...extra,
});

// A run-log receipt line exactly as scripts/run-log.mjs writes it for a failing command.
const receiptLine = (argv) => `- 2026-11-22T10:00:00.000Z | red | \`${JSON.stringify(argv)}\` | exit 1 | completed=2026-11-22T10:00:01.000Z | elapsedMs=12 | rerunReason=\`null\` | scope=root | head=abc1234 tree=clean diff=none`;

// One repository for the five tests that write no record.
let shared;
before(() => {
  shared = makeRepo();
});
after(() => {
  rmSync(shared.root, { recursive: true, force: true });
});

// Every other test builds its own repository, removed when the test ends.
function freshRepo(t) {
  const made = makeRepo();
  t.after(() => rmSync(made.root, { recursive: true, force: true }));
  return made;
}

test('codexCommandForGuard prefers cmd, falls back to command, else empty', () => {
  assert.equal(codexCommandForGuard({ cmd: 'git push --force' }), 'git push --force');
  assert.equal(codexCommandForGuard({ command: 'git status' }), 'git status');
  assert.equal(codexCommandForGuard({ cmd: 'a', command: 'b' }), 'a');
  assert.equal(codexCommandForGuard({}), '');
  assert.equal(codexCommandForGuard(null), '');
});

test('codexCwdForGuard prefers the command workdir, falls back to the session cwd, else empty', () => {
  assert.equal(codexCwdForGuard({ cwd: '/repo', tool_input: { workdir: '/repo/.claude/worktrees/1' } }), '/repo/.claude/worktrees/1');
  assert.equal(codexCwdForGuard({ cwd: '/repo', tool_input: { cmd: 'git status' } }), '/repo');
  assert.equal(codexCwdForGuard({}), '');
  assert.equal(codexCwdForGuard(null), '');
});

test('929 recognizes only the checked Bash delivery working directory', (t) => {
  assert.equal(typeof checkedDeliveryCwd, 'function', 'the installed adapter exposes the native delivery cwd check');

  const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'native-delivery-cwd-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'root');
  const worktree = join(fixture, 'job');
  const nested = join(worktree, 'nested');
  const sibling = join(fixture, 'job-other');
  const foreign = join(fixture, 'foreign');
  for (const path of [root, nested, sibling, foreign]) mkdirSync(path, { recursive: true });

  const binding = { root, worktree };
  const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
  for (const cwd of [worktree, nested]) {
    assert.equal(checkedDeliveryCwd({ ...bash, cwd }, binding), true, 'Bash can report the job directory without workdir');
    assert.equal(checkedDeliveryCwd({ ...bash, cwd: root, tool_input: { workdir: cwd } }, binding), true,
      'Bash can report the launch root with an explicit job workdir');
  }

  assert.equal(checkedDeliveryCwd({ ...bash, cwd: root }, binding), false, 'Bash cannot run delivery from the launch root');
  assert.equal(checkedDeliveryCwd({ ...bash, tool_input: { workdir: worktree } }, binding), false, 'Bash must report cwd');
  for (const cwd of [sibling, foreign, join(worktree, 'missing'), `${nested}${sep}..`]) {
    assert.equal(checkedDeliveryCwd({ ...bash, cwd, tool_input: { workdir: worktree } }, binding), false, cwd);
  }
  for (const cwd of [root, worktree]) {
    assert.equal(checkedDeliveryCwd({ ...bash, cwd, tool_input: { workdir: foreign } }, binding), false,
      'an explicit foreign Bash workdir overrides an otherwise allowed cwd');
  }
  if (process.platform === 'linux') {
    const alias = join(worktree, 'alias');
    symlinkSync(nested, alias);
    assert.equal(checkedDeliveryCwd({ ...bash, cwd: alias }, binding), false, 'a symlink is not a canonical Bash directory');
  }
});

test('a Codex builder thread with no bound handoff is refused every tool call', async () => {
  const { repo } = shared;
  assert.deepEqual(runHook(repo, call(repo, 'builder', 'Bash')), R(UNBOUND));
  assert.deepEqual(await direct(call(repo, 'builder-lite', 'apply_patch')), R(UNBOUND));
  assert.deepEqual(await direct(call(repo, 'builder-max', 'mcp__node_repl__js')), R(UNBOUND));
  assert.equal(existsSync(rec(top(repo))), false);
});

test('a saved passing handoff is gated at dispatch, bound and injected at start, and admits only its own builder thread', async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  save(rec(worktree, 'slice_one.md'), HANDOFF);
  assert.deepEqual(runHook(repo, spawnCall(repo, 'slice_one')), OK);
  assert.equal(existsSync(rec(worktree, 'slice_one.md')), false);
  assert.equal(readFileSync(rec(worktree, SESSION, 'pending.md'), 'utf8'), HANDOFF);
  assert.deepEqual(runHook(repo, start(repo)), BOUND_RESULT);
  assert.equal(existsSync(rec(worktree, SESSION, 'pending.md')), false);
  assert.equal(readFileSync(rec(worktree, SESSION, `${AGENT}.md`), 'utf8'), HANDOFF);
  assert.deepEqual(runHook(repo, call(repo, 'builder', 'apply_patch')), OK);
  assert.deepEqual(await direct(call(repo, 'builder', 'Bash', { agent_id: 'agent-other' })), R(UNBOUND));
  writeFileSync(rec(worktree, SESSION, `${AGENT}.md`), HANDOFF_NO_STOP);
  assert.deepEqual(await direct(call(repo)), R(STOP_REASON));
});

test('a bound Codex builder thread with a strict implementation handoff keeps working after its run log is removed', async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  const title = 'a bound Codex builder thread with a strict implementation handoff keeps working after its run log is removed';
  const log = join(worktree, '.claude', 'worklog', worklogFileName(git(repo, ['branch', '--show-current']).trim()));
  const red = receiptLine(['node', '--test', `--test-name-pattern=${title}`, 'scripts/lib/codex-hook-adapters.test.mjs']);
  const strict = HANDOFF.replace('Construction mode: evidence-required', 'Construction mode: strict-tdd')
    .replace('Working directory: /tmp/job-558', `Working directory: ${worktree}`)
    + `Stage: implementation\nFrozen test: scripts/lib/codex-hook-adapters.test.mjs :: ${title}\nRed receipt: ${red}\n`;
  save(log, `${red}\n`);
  save(rec(worktree, 'slice_one.md'), strict);
  assert.deepEqual(runHook(repo, spawnCall(repo, 'slice_one')), OK);
  assert.deepEqual(runHook(repo, start(repo)), { status: 0, stdout: BOUND + strict, stderr: '' });
  rmSync(log);
  assert.deepEqual(runHook(repo, call(repo, 'builder', 'apply_patch')), OK);
  assert.deepEqual(await direct(call(repo, 'builder', 'Bash')), OK);
});

test('other seats and the coordinating session pass every call untouched', async () => {
  const { repo } = shared;
  const coordinator = { session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } };
  assert.deepEqual(runHook(repo, coordinator), OK);
  assert.deepEqual(await direct(call(repo, 'explorer')), OK);
  assert.deepEqual(await direct(start(repo, 'architect')), OK);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one', { tool_input: { agent_type: 'reviewer', message: OPAQUE } })), OK);
  assert.equal(existsSync(rec(top(repo))), false);
});

test('a builder dispatch whose saved handoff fails the shared check is refused and keeps the handoff', async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  save(rec(worktree, 'slice_one.md'), HANDOFF_NO_STOP);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one')), R(STOP_REASON));
  assert.equal(readFileSync(rec(worktree, 'slice_one.md'), 'utf8'), HANDOFF_NO_STOP);
  assert.equal(existsSync(rec(worktree, SESSION, 'pending.md')), false);
});

test('a Codex strict-tdd implementation dispatch without a recorded red is refused and keeps the handoff', (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  const title = 'a Codex strict-tdd implementation dispatch without a recorded red is refused and keeps the handoff';
  const log = join(worktree, '.claude', 'worklog', worklogFileName(git(repo, ['branch', '--show-current']).trim()));
  const strict = HANDOFF.replace('Construction mode: evidence-required', 'Construction mode: strict-tdd')
    .replace('Working directory: /tmp/job-558', `Working directory: ${worktree}`)
    + `Stage: implementation\nFrozen test: scripts/lib/codex-hook-adapters.test.mjs :: ${title}\nRed receipt: ${receiptLine(['node', '--test', `--test-name-pattern=${title}`, 'scripts/lib/codex-hook-adapters.test.mjs'])}\n`;
  save(log, `${receiptLine(['npm', 'run', 'lint'])}\n`);
  save(rec(worktree, 'slice_one.md'), strict);
  const run = runHook(repo, spawnCall(repo, 'slice_one'));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^Blocked: /);
  assert.ok(run.stderr.includes(log), run.stderr);
  assert.equal(readFileSync(rec(worktree, 'slice_one.md'), 'utf8'), strict);
  assert.equal(existsSync(rec(worktree, SESSION, 'pending.md')), false);
});

// existing behaviour: the Working directory is only compared with the worktree holding the handoff; trusting it would read B's log and admit.
test('a Codex strict-tdd dispatch refuses a Working directory other than the worktree holding the handoff', (t) => {
  const { repo } = freshRepo(t);
  const named = freshRepo(t).repo;
  const worktree = top(repo);
  const title = 'a Codex strict-tdd dispatch refuses a Working directory other than the worktree holding the handoff';
  const red = receiptLine(['node', '--test', `--test-name-pattern=${title}`, 'scripts/lib/codex-hook-adapters.test.mjs']);
  const logIn = (dir) => join(top(dir), '.claude', 'worklog', worklogFileName(git(dir, ['branch', '--show-current']).trim()));
  const strict = HANDOFF.replace('Construction mode: evidence-required', 'Construction mode: strict-tdd')
    .replace('Working directory: /tmp/job-558', `Working directory: ${top(named)}`)
    + `Stage: implementation\nFrozen test: scripts/lib/codex-hook-adapters.test.mjs :: ${title}\nRed receipt: ${red}\n`;
  save(logIn(repo), `${receiptLine(['npm', 'run', 'lint'])}\n`);
  save(logIn(named), `${red}\n`);
  save(rec(worktree, 'slice_one.md'), strict);
  const run = runHook(repo, spawnCall(repo, 'slice_one'));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^Blocked: /);
  assert.ok(run.stderr.includes("'Working directory:' is not the verified job worktree"), run.stderr);
  assert.ok(run.stderr.includes(worktree), run.stderr);
  assert.equal(readFileSync(rec(worktree, 'slice_one.md'), 'utf8'), strict);
  assert.equal(existsSync(rec(worktree, SESSION, 'pending.md')), false);
});

test('a handoff record saved in two worktrees is refused as ambiguous', async (t) => {
  const { root, repo } = freshRepo(t);
  git(repo, ['worktree', 'add', '-q', '-b', 'job/second', join(root, 'second')]);
  const worktree = top(repo);
  const secondTop = top(join(root, 'second'));
  save(rec(worktree, 'slice_one.md'), HANDOFF);
  save(rec(secondTop, 'slice_one.md'), HANDOFF);
  assert.deepEqual(
    await direct(spawnCall(repo, 'slice_one')),
    R(AMBIGUOUS('slice_one', `${rec(worktree, 'slice_one.md')}, ${rec(secondTop, 'slice_one.md')}`)),
  );
  assert.equal(readFileSync(rec(worktree, 'slice_one.md'), 'utf8'), HANDOFF);
  assert.equal(readFileSync(rec(secondTop, 'slice_one.md'), 'utf8'), HANDOFF);
  save(rec(worktree, SESSION, `${AGENT}.md`), HANDOFF);
  save(rec(secondTop, SESSION, `${AGENT}.md`), HANDOFF);
  assert.deepEqual(await direct(call(repo)), R(UNBOUND));
});

test('a second builder dispatch before the first builder starts is refused as pending', async (t) => {
  const { root, repo } = freshRepo(t);
  git(repo, ['worktree', 'add', '-q', '-b', 'job/second', join(root, 'second')]);
  const worktree = top(repo);
  const secondTop = top(join(root, 'second'));
  save(rec(worktree, 'slice_one.md'), HANDOFF);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one')), OK);
  save(rec(secondTop, 'slice_two.md'), HANDOFF);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_two')), R(PENDING(rec(worktree, SESSION, 'pending.md'))));
  assert.equal(readFileSync(rec(secondTop, 'slice_two.md'), 'utf8'), HANDOFF);
  assert.equal(existsSync(rec(secondTop, SESSION, 'pending.md')), false);
});

test('a builder dispatch with no saved handoff or an unusable name is refused', async () => {
  const { repo } = shared;
  assert.deepEqual(runHook(repo, spawnCall(repo, 'missing_task', { tool_name: 'spawn_agent' })), R(NO_SOURCE('missing_task')));
  assert.deepEqual(await direct(spawnCall(repo, '../escape')), R(BAD_TASK));
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one', { session_id: '../session' })), R(BAD_IDS));
});

test('unreadable payloads and unusable thread ids are refused', async () => {
  const { repo } = shared;
  assert.deepEqual(await direct('{not JSON'), R(IDENTITY));
  assert.deepEqual(await direct({ agent_id: 'agent-558', cwd: repo, tool_name: 'Bash', tool_input: { cmd: 'ls' } }), R(IDENTITY));
  // A non-string id is refused before it reaches a path.
  assert.deepEqual(await direct(call(repo, 'builder', 'Bash', { session_id: 42 })), R(BAD_IDS));
});

test('unreadable handoff records and a failed worktree listing refuse rather than pass', async (t) => {
  const { root, repo } = freshRepo(t);
  const worktree = top(repo);
  const sourcePath = rec(worktree, 'slice_one.md');
  const boundPath = rec(worktree, SESSION, `${AGENT}.md`);
  for (const path of [sourcePath, boundPath, rec(worktree, SESSION, 'pending.md')]) mkdirSync(path, { recursive: true });
  const notRegular = (path) => R(`the builder handoff guard could not use ${path}: it is a directory, not a regular file`);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one')), notRegular(sourcePath));
  assert.deepEqual(await direct(call(repo)), notRegular(boundPath));
  assert.deepEqual(await direct(start(repo, 'builder', { agent_id: 'agent-559' })), NOTE);
  assert.equal(existsSync(rec(worktree, SESSION, 'agent-559.md')), false);
  assert.deepEqual(
    await direct(call(repo), { env: { ...FIXTURE_ENV, GIT_DIR: join(root, 'missing') } }),
    R('the builder handoff guard could not list the worktrees: git exited 128'),
  );
  assert.deepEqual(
    await direct(spawnCall(repo, 'slice_two', { cwd: 42 })),
    R('the builder handoff guard could not list the worktrees: the hook payload carries no string cwd'),
  );
});

test('a dispatch whose saved handoff cannot be removed is refused and leaves no pending record', {
  skip: process.platform === 'win32'
    ? 'a directory permission cannot refuse an unlink on Windows'
    : /** @type {() => number} */ (process.getuid)() === 0 && 'root ignores directory permissions',
}, async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  const sourcePath = rec(worktree, 'slice_one.md');
  save(sourcePath, HANDOFF);
  mkdirSync(rec(worktree, SESSION));
  chmodSync(rec(worktree), 0o555);
  try {
    assert.deepEqual(
      await direct(spawnCall(repo, 'slice_one')),
      R(`the builder handoff guard could not remove ${sourcePath}: EACCES`),
    );
  } finally {
    chmodSync(rec(worktree), 0o755);
  }
  assert.equal(existsSync(rec(worktree, SESSION, 'pending.md')), false);
  assert.equal(readFileSync(sourcePath, 'utf8'), HANDOFF);
});

test('a pending handoff binds only a usable builder thread of the session that dispatched it', async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  save(rec(worktree, 'slice_one.md'), HANDOFF);
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one')), OK);
  const pending = rec(worktree, SESSION, 'pending.md');
  assert.deepEqual(await direct(start(repo, 'builder', { session_id: 'session-other' })), NOTE);
  assert.equal(existsSync(pending), true);
  assert.deepEqual(await direct(start(repo, 'builder', { agent_id: '../agent-558' })), NOTE);
  assert.equal(existsSync(pending), true);
  assert.equal(existsSync(rec(worktree, 'agent-558.md')), false);
  assert.deepEqual(await direct(start(repo, 'explorer')), OK);
  assert.equal(existsSync(pending), true);
  assert.deepEqual(await direct(start(repo, 'builder-max')), BOUND_RESULT);
});

test('a builder path lists the worktrees only through the looked-up executable and refuses without one', async () => {
  const { repo } = shared;
  // Node standing in for git rejects `worktree list` as an unknown script, with exit status 1.
  assert.deepEqual(
    await direct(spawnCall(repo, 'slice_one'), { git: process.execPath }),
    R('the builder handoff guard could not list the worktrees: git exited 1'),
  );
  assert.deepEqual(
    await direct(spawnCall(repo, 'slice_one'), { git: null }),
    R('the builder handoff guard could not list the worktrees: no git.exe in an absolute PATH entry'),
  );
});

// Windows' default executable search tries the spawn's working directory before PATH, so a bare `git` run in a
// worktree holding a git.exe would run it. The planted git.exe is a copy of node, which would fail `worktree list`.
// Recurring cost: one copy of the node binary and one git start, on Windows only.
// Removal condition: remove when the guard no longer spawns git.
test('win32 the handoff guard ignores a planted executable in the job worktree', {
  skip: process.platform !== 'win32' && 'the working-directory executable search exists only on Windows',
}, async (t) => {
  const { repo } = freshRepo(t);
  const worktree = top(repo);
  save(rec(worktree, 'slice_one.md'), HANDOFF);
  copyFileSync(process.execPath, join(repo, 'git.exe'));
  assert.deepEqual(await direct(spawnCall(repo, 'slice_one')), OK);
  assert.equal(readFileSync(rec(worktree, SESSION, 'pending.md'), 'utf8'), HANDOFF);
});

test('a handoff folder linked out of the worktree is refused and nothing outside it is touched', async (t) => {
  const { root, repo } = freshRepo(t);
  const worktree = top(repo);
  save(join(root, 'outside', 'slice_one.md'), HANDOFF);
  mkdirSync(join(worktree, '.claude', 'worklog'), { recursive: true });
  // A junction on Windows needs no privilege; the type is ignored elsewhere.
  symlinkSync(join(root, 'outside'), rec(worktree), 'junction');
  assert.deepEqual(
    await direct(spawnCall(repo, 'slice_one')),
    R(`the builder handoff guard could not use ${rec(worktree, 'slice_one.md')}: ${rec(worktree)} is a symlink, not a directory`),
  );
  assert.equal(readFileSync(join(root, 'outside', 'slice_one.md'), 'utf8'), HANDOFF);
  assert.equal(existsSync(join(root, 'outside', SESSION)), false);
});
