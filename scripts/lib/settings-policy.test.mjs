// settings-policy.test.mjs — the agent-shell permission policy in .claude/settings.json.
//
// The allow list is a security policy: every entry runs without a prompt. It must stay the
// three read-mostly board scripts, the read-only merge watch and the delivery commands, `gh pr ready`,
// `gh pr merge --auto --squash --delete-branch` and a Herdr job's pinned
// `gh pr merge --squash --delete-branch --match-head-commit`, whose prefixes the merge and ready
// rules in scripts/lib/unsafe-git.mjs bound to the exact delivery forms, never a bare `gh pr merge`
// prefix, plus the bounded job-start form that the worktree-add guard bounds. The hook set must stay exactly the guards
// and the owner-menu hook this repository documents, each run from the job's workflow pin when
// FABRAIK_WORKFLOW_ROOT is set. A widening lands red here instead of green (security review on #1122).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixShell } from './posix-shell.mjs';
import { presentRuntimes } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT = presentRuntimes(ROOT);
const without = (runtime) => !PRESENT.includes(runtime) && `the settings file names no ${runtime} runtime`;
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

test('only the approved workflow commands and bounded job-start form are auto-approved, and nothing is denied by omission', { skip: without('claude') }, () => {
  const settings = readJson('.claude/settings.json');
  assert.deepEqual(settings.permissions.allow, [
    'Bash(node scripts/board.mjs *)',
    'Bash(node scripts/board-move.mjs *)',
    'Bash(node scripts/board-add.mjs *)',
    'Bash(node scripts/merge-watch.mjs *)',
    'Bash(gh pr ready *)',
    'Bash(gh pr merge --auto --squash --delete-branch *)',
    'Bash(gh pr merge --squash --delete-branch --match-head-commit *)',
    'Bash(git worktree add .claude/worktrees/*)',
  ]);
  assert.equal(settings.permissions.deny, undefined);
});

test('the hook set is exactly the documented guards', { skip: without('claude') }, () => {
  const settings = readJson('.claude/settings.json');
  const commands = (event, matcher) => (settings.hooks[event] ?? [])
    .filter((h) => (matcher === undefined ? h.matcher === undefined : h.matcher === matcher))
    .flatMap((h) => h.hooks.map((hook) => hook.command));
  // A blocking hook whose pinned file cannot run exits 2, so a pinned job never falls open.
  assert.deepEqual(commands('PreToolUse', 'Bash'), [
    'node "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/block-unsafe-git.mjs" || { s=$?; [ -z "$FABRAIK_WORKFLOW_ROOT" ] || exit 2; exit $s; }',
    'node "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/filter-test-output.mjs" || { s=$?; [ -z "$FABRAIK_WORKFLOW_ROOT" ] || exit 2; exit $s; }',
  ]);
  assert.deepEqual(commands('PreToolUse', 'Agent'), [
    'node "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/check-builder-handoff.mjs" || { s=$?; [ -z "$FABRAIK_WORKFLOW_ROOT" ] || exit 2; exit $s; }',
  ]);
  assert.deepEqual(commands('Stop'), ['sh "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/verify-green.sh"']);
  // The menu hook waits for the owner's answer, so its timeout outlasts Claude Code's 600-second default.
  assert.deepEqual(settings.hooks.PermissionRequest, [{
    hooks: [{ type: 'command', command: 'node "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/owner-menu.mjs" || { s=$?; [ -z "$FABRAIK_WORKFLOW_ROOT" ] || exit 2; exit $s; }', timeout: 86400 }],
  }]);
  assert.deepEqual(commands('PostToolUse', 'AskUserQuestion|ExitPlanMode'), ['node "${FABRAIK_WORKFLOW_ROOT:-$CLAUDE_PROJECT_DIR}/.claude/hooks/owner-menu.mjs"']);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'Stop']);
});

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

// Writes one stub per hook file under <dir>/.claude/hooks, each in its hook's own language, printing
// `marker` (when given) and exiting `status`.
function writeHookStubs(dir, files, { marker = '', status }) {
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
  for (const file of files) {
    const body = file.endsWith('.sh')
      ? `${marker ? `echo ${marker}\n` : ''}exit ${status}\n`
      : `${marker ? `console.log('${marker}');\n` : ''}process.exit(${status});\n`;
    writeFileSync(join(dir, '.claude', 'hooks', file), body);
  }
}

test("ANTI-REGRESSION: a pinned job's hooks ignore an updated main", { skip: without('claude') }, () => {
  const shell = posixShell();
  assert.ok(shell, 'a POSIX shell is required: install Git for Windows');
  const settings = readJson('.claude/settings.json');
  // PreToolUse and PermissionRequest decide whether a call goes ahead, so they are the blocking hooks.
  const definitions = Object.entries(settings.hooks).flatMap(([event, entries]) => entries
    .flatMap((entry) => entry.hooks)
    .map((hook) => {
      const file = /\/\.claude\/hooks\/([\w.-]+)"/.exec(hook.command)?.[1];
      assert.ok(file, `no hook file in ${hook.command}`);
      return { command: hook.command, file, blocking: ['PreToolUse', 'PermissionRequest'].includes(event) };
    }));
  const files = [...new Set(definitions.map((d) => d.file))];
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'pinned-hooks-'));
  try {
    // The root checkout's main has moved on: its guard prints v2 and blocks. The job's pin is a plain
    // copied directory, not a checkout, whose stubs pass.
    const root = join(scratch, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'README'), 'base\n');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base']);
    const worktree = join(root, '.claude', 'worktrees', 'job');
    git(root, ['worktree', 'add', '-q', worktree, '-b', 'job']);
    writeHookStubs(root, files, { marker: 'v2', status: 2 });
    const pin = join(scratch, 'pin');
    writeHookStubs(pin, files, { status: 0 });

    const run = (command, pinned) => {
      // The runner's own pin, if any, must not leak into the unset cases.
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FABRAIK_WORKFLOW_ROOT'));
      const env = { ...inherited, CLAUDE_PROJECT_DIR: root, ...(pinned ? { FABRAIK_WORKFLOW_ROOT: pin } : {}) };
      return spawnSync(shell, ['-c', command], { cwd: worktree, encoding: 'utf8', input: '{}', env });
    };

    for (const { command } of definitions) {
      const pinned = run(command, true);
      assert.equal(pinned.status, 0, `pinned: ${command}\n${pinned.stderr}`);
      assert.doesNotMatch(pinned.stdout, /v2/, `pinned: ${command} ran the root checkout's file`);
      const unset = run(command, false);
      assert.equal(unset.status, 2, `unset: ${command}\n${unset.stderr}`);
      assert.match(unset.stdout, /v2/, `unset: ${command} did not run the root checkout's file`);
    }

    const blocking = definitions.filter((d) => d.blocking);
    assert.deepEqual(blocking.map((d) => d.file), ['block-unsafe-git.mjs', 'filter-test-output.mjs', 'check-builder-handoff.mjs', 'owner-menu.mjs']);
    for (const file of files) rmSync(join(pin, '.claude', 'hooks', file));
    for (const { command } of blocking) {
      const r = run(command, true);
      assert.equal(r.status, 2, `pin stub absent: ${command}\n${r.stderr}`);
    }
    for (const file of files) rmSync(join(root, '.claude', 'hooks', file));
    for (const { command } of blocking) {
      const r = run(command, false);
      assert.equal(r.status, 1, `unset, root guard absent: ${command}\n${r.stderr}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the Codex hook set is exact and cannot be widened or deleted silently', { skip: without('codex') }, () => {
  const HANDOFF_HOOK = {
    type: 'command',
    command: 'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/check-builder-handoff.mjs"',
    commandWindows: '$r = Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir); if (-not $r) { $r = \'.\' }; $h = "$r/.codex/hooks/check-builder-handoff.mjs"; $LASTEXITCODE = 1; node $h; exit $LASTEXITCODE',
  };
  assert.deepEqual(readJson('.codex/hooks.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: 'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/block-unsafe-git.mjs"',
            commandWindows: '$r = Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir); if (-not $r) { $r = \'.\' }; $h = "$r/.codex/hooks/block-unsafe-git.mjs"; $LASTEXITCODE = 1; node $h; exit $LASTEXITCODE',
          }],
        },
        { hooks: [HANDOFF_HOOK] },
      ],
      SubagentStart: [{ hooks: [{ ...HANDOFF_HOOK, additionalContextLimit: 0 }] }],
      Stop: [{
        hooks: [{
          type: 'command',
          command: 'sh "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/verify-green.sh"',
          commandWindows: '$r = Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir); if (-not $r) { $r = \'.\' }; $h = "$r/.codex/hooks/verify-green.mjs"; $LASTEXITCODE = 1; node $h; exit $LASTEXITCODE',
        }],
      }],
    },
  });
});
