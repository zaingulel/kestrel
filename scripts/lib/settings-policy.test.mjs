// settings-policy.test.mjs — the agent-shell permission policy in .claude/settings.json.
//
// The allow list is a security policy: every entry runs without a prompt. It must stay the
// three read-mostly board scripts, the read-only merge watch, and the two delivery commands,
// `gh pr ready` and `gh pr merge --auto --squash --delete-branch`, whose prefixes the merge and
// ready rules in scripts/lib/unsafe-git.mjs bound to the exact delivery forms, and the hook set
// must stay exactly the guards this repository documents. A widening lands red here instead of green
// (security review on #1122).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presentRuntimes } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT = presentRuntimes(ROOT);
const without = (runtime) => !PRESENT.includes(runtime) && `the settings file names no ${runtime} runtime`;
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

test('only the board scripts, the merge watch and the two delivery commands are auto-approved, and nothing is denied by omission', { skip: without('claude') }, () => {
  const settings = readJson('.claude/settings.json');
  assert.deepEqual(settings.permissions.allow, [
    'Bash(node scripts/board.mjs *)',
    'Bash(node scripts/board-move.mjs *)',
    'Bash(node scripts/board-add.mjs *)',
    'Bash(node scripts/merge-watch.mjs *)',
    'Bash(gh pr ready *)',
    'Bash(gh pr merge --auto --squash --delete-branch *)',
  ]);
  assert.equal(settings.permissions.deny, undefined);
});

test('the hook set is exactly the documented guards', { skip: without('claude') }, () => {
  const settings = readJson('.claude/settings.json');
  const commands = (event, matcher) => (settings.hooks[event] ?? [])
    .filter((h) => (matcher === undefined ? h.matcher === undefined : h.matcher === matcher))
    .flatMap((h) => h.hooks.map((hook) => hook.command));
  assert.deepEqual(commands('PreToolUse', 'Bash'), [
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/block-unsafe-git.mjs"',
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/filter-test-output.mjs"',
  ]);
  assert.deepEqual(commands('PreToolUse', 'Agent'), [
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/check-builder-handoff.mjs"',
  ]);
  assert.deepEqual(commands('Stop'), ['sh "$CLAUDE_PROJECT_DIR/.claude/hooks/verify-green.sh"']);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreToolUse', 'Stop']);
});

test('the Codex hook set is exact and cannot be widened or deleted silently', { skip: without('codex') }, () => {
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
        {
          matcher: 'collaborationspawn_agent',
          hooks: [{
            type: 'command',
            command: 'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.codex/hooks/check-builder-handoff.mjs"',
            commandWindows: '$r = Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir); if (-not $r) { $r = \'.\' }; $h = "$r/.codex/hooks/check-builder-handoff.mjs"; $LASTEXITCODE = 1; node $h; exit $LASTEXITCODE',
          }],
        },
      ],
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
