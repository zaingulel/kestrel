// @ts-nocheck
// unsafe-git.test.mjs — mutation-proof unit tests for the PreToolUse(Bash) guard rules.
// Run: node --test scripts/lib/   (or `npm run test:scripts`)
//
// Every blocked fixture asserts the exact rule reason, or for the run session rules the opening words
// the launcher's witness reads and the text the reason must name, never a bare truthy, so a rule that
// fires for the wrong reason reddens a test instead of hiding behind another rule's verdict.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerAnswerLine, requireMergeOnEvidence } from './merge-evidence.mjs';
import { posixShell } from './posix-shell.mjs';
import { presentRuntimes } from './runtimes.mjs';
import { blockReason, cleanupPermission } from './unsafe-git.mjs';
import { repairWorkflowSnapshot, verifyJobPin, workflowStore } from './workflow-pin.mjs';

const REASON_CREATE = "gh pr create without --draft skips the draft stage: open it as a draft (--draft/-d) so it is settled before CI runs";
const REASON_MERGE = 'gh pr merge: only the delivery form `gh pr merge --auto --squash --delete-branch <number>`, alone in its command segment, is allowed; --auto lets GitHub merge once the required test check is green, and because the allow list runs that prefix unprompted anything else in the segment (--admin, a reordered or missing flag, a quoted, substituted or variable word, a wrapper) is refused';
const REASON_READY = 'gh pr ready: only `gh pr ready <number>` and `gh pr ready <number> --undo`, alone in their command segment, are allowed; the allow list runs that prefix unprompted, so anything else in the segment (a quoted, substituted or variable word, a redirection, a wrapper) is refused';
const REASON_COMMIT_NO_VERIFY = 'git commit --no-verify skips the pre-commit gates';
const REASON_PUSH_NO_VERIFY = 'git push --no-verify skips the lint pre-push gate';
const REASON_HOOKS_PATH = 'a core.hooksPath override skips the pre-commit and pre-push gates';
const REASON_HOOKS_PATH_CONFIG = 'git config core.hooksPath: only the arming step `git config core.hooksPath .githooks` and a read that ends at the key are allowed; another value or an unset skips the pre-commit and pre-push gates, and git can store a word after the key as the value even when it looks like an option, so put options before the key';
const REASON_PUSH_FORCE = 'git push --force is unsafe (use --force-with-lease for a rebase)';
const REASON_FILTER_BRANCH = 'git filter-branch rewrites history';
const REASON_WORKTREE_RESET = 'git worktree add -B resets the branch to the start point when it already exists, dropping the commits only it held: create a new branch with -b instead';
const REASON_WORKTREE_ADD_FORCE = "git worktree add --force overrides git's refusal to check out a branch another worktree holds or to reuse the path of a missing or locked worktree: free the branch or the path first (git worktree list, git worktree prune), or choose a new one";
const REASON_WORKTREE_ESCAPE = 'git worktree add: a path under .claude/worktrees/ that holds `..` can climb back out of that folder: write it as .claude/worktrees/<name> with no `..`';
const REASON_WORKTREE_UNREAD = 'git worktree add under .claude/worktrees/: a word that is not plain (letters, digits and `_ . / : @ + , -`), such as a quoted, escaped, variable or substituted word, can hide `..`, -B or --force from this guard: write every word plainly';
const REASON_WORKTREE_REMOVE_FORCE = "git worktree remove --force deletes the worktree's uncommitted and untracked changes, and given twice a locked worktree: commit what it holds or discard it on purpose, unlock it if it is locked, then remove it without --force";

// ── gh pr create --draft ────────────────────────────────────────────────────

test('gh pr create without --draft is blocked', () => {
  assert.equal(blockReason('gh pr create --title x --body y'), REASON_CREATE);
  // the executable name is matched case-insensitively (a capitalised `GH` runs gh here)
  assert.equal(blockReason('GH pr create --title x --body y'), REASON_CREATE);
});

test('gh pr create --draft is allowed', () => {
  assert.equal(blockReason('gh pr create --draft --title x'), '');
});

test('gh pr create -d is allowed (short flag)', () => {
  assert.equal(blockReason('gh pr create -d --title x'), '');
});

test('echo "gh pr create" (a quoted mention, not a real invocation) is allowed', () => {
  assert.equal(blockReason('echo "gh pr create"'), '');
});

// A `--draft` merely QUOTED inside --title/--body satisfied the flag check with no real flag, so the
// PR slipped through un-drafted and burned CI. Quoted spans are blanked before the rules look, so a
// quoted flag is never a real one.
test('a --draft quoted inside --title is NOT a real flag — still blocked', () => {
  assert.equal(blockReason('gh pr create --title "block it without --draft " --body x'), REASON_CREATE);
});

test('a --draft quoted inside --body is NOT a real flag — still blocked', () => {
  assert.equal(blockReason('gh pr create --body "see --draft docs" --title x'), REASON_CREATE);
});

// A newline inside an earlier quoted --body used to strand a real trailing --draft in a later split
// segment. Agents build multiline bodies constantly, so this fired often and taught the wrong lesson.
test('a real --draft after a MULTILINE quoted --body is allowed', () => {
  assert.equal(blockReason('gh pr create --title x --body "line1\nline2" --draft'), '');
});

// ── gh pr ready ──────────────────────────────────────────────────────────────

// `--undo` sends a PR BACK to draft: the cost-saving direction, and the only remedy when a PR is
// already ready and a post-ready fix would otherwise burn another metered run.
test('gh pr ready --undo (re-draft, the cost-saving direction) is allowed', () => {
  assert.equal(blockReason('gh pr ready --undo 406'), '');
});

// -R/--repo is inherited by `gh pr`, so it is valid before `pr` or before the subcommand. The
// create and merge rules must tolerate it in both positions, or a `gh -R owner/repo pr create`
// slips past ungated (the fail-open this pins).
test('gh pr create and gh pr merge tolerate -R/--repo in both positions', () => {
  assert.equal(blockReason('gh -R owner/repo pr create --title x'), REASON_CREATE);
  assert.equal(blockReason('gh pr -R owner/repo create --title x'), REASON_CREATE);
  assert.equal(blockReason('gh -Rowner/repo pr create --title x'), REASON_CREATE);
  assert.equal(blockReason('gh --repo owner/repo pr merge 406'), REASON_MERGE);
  assert.equal(blockReason('gh pr --repo owner/repo merge 406'), REASON_MERGE);
  assert.equal(blockReason('gh --repo=owner/repo pr merge 406'), REASON_MERGE);
  // the option must not swallow the draft escape, and on a merge it is refused whatever follows
  assert.equal(blockReason('gh -R owner/repo pr create --draft --title x'), '');
  assert.equal(blockReason('gh --repo owner/repo pr merge --auto 406'), REASON_MERGE);
});

// ── gh pr merge ─────────────────────────────────────────────────────────────

test('gh pr merge outside the delivery form is blocked, bare, path-qualified, assignment-led, or chained', () => {
  const blocked = [
    'gh pr merge 493 --squash',
    'Gh pr merge 493 --squash',
    'gh pr merge 406',
    'GH_TOKEN=x gh pr merge 493',
    'gh --repo someone/example-repository pr merge 493',
    'gh pr -R someone/example-repository merge 493',
    'gh pr view 493 && gh pr merge 493',
    '/Users/someone/.local/bin/gh pr merge 493 --squash',
    './bin/gh pr merge 493 --squash',
  ];
  for (const command of blocked) assert.equal(blockReason(command), REASON_MERGE, command);

  assert.equal(blockReason('echo "gh pr merge 493"'), '');
  assert.equal(blockReason('git commit -m "use gh pr merge only through the wrapper"'), '');
  assert.equal(blockReason('gh pr view 493'), '');
  assert.equal(blockReason('gh pr checks 493'), '');
  // The one allowed form is the delivery form: GitHub merges only when the required check is green.
  assert.equal(blockReason('gh pr merge --auto --squash --delete-branch 493'), '');
  assert.equal(blockReason('gh pr merge --auto --squash 493'), REASON_MERGE);
  assert.equal(blockReason('gh pr merge 493 --auto --squash --delete-branch'), REASON_MERGE);
  assert.equal(blockReason('gh --repo someone/example-repository pr merge --auto 493'), REASON_MERGE);
});

// Mutation: make the guard refuse any of these board writes and this goes red.
test('ANTI-REGRESSION: the git guard admits the board writes an agent takes unasked inside the project', () => {
  for (const command of [
    'node scripts/board-move.mjs 12 Ready',
    'node scripts/board-move.mjs --top 12 Ready',
    "gh issue create --title 'Proposed: a follow-up' --body-file card.md",
    'node scripts/board-add.mjs 12 Backlog Workflow',
    'gh issue edit 12 --remove-assignee octocat',
    'gh issue comment 12 --body-file note.md',
  ]) {
    assert.equal(blockReason(command), '', command);
  }
});

// The allow list runs the `gh pr ready` and delivery `gh pr merge` prefixes unprompted, so these two
// rules are the bound on what those prefixes admit: a segment they cannot fully read is refused.
test('ANTI-REGRESSION: only the exact delivery merge and ready forms pass; every other gh pr merge or gh pr ready form is refused', () => {
  for (const command of [
    'gh pr merge --auto --squash --delete-branch 493',
    'gh pr ready 493',
    'gh pr ready 493 --undo',
    'gh pr ready --undo 406',
    'gh pr ready 493 && gh pr merge --auto --squash --delete-branch 493',
    'echo "gh pr merge --admin 493"',
    // Pinned residual: the allow rule does not match a shell wrapper, so this still prompts.
    "sh -c 'gh pr merge --admin 493'",
    // Data stays data: a heredoc body, a quoted span with no substitution or with one that invokes
    // neither, a single-quoted span, and a house-form body carried by a heredoc inside "$(…)".
    'cat <<EOF\ngh pr merge --admin 1\nEOF',
    'git commit -m "say $(date): use gh pr view"',
    "echo 'run $(gh pr merge --admin 1) never'",
    // Only the substituted text runs: a mention elsewhere in the same span is literal.
    'git commit -m "ran $(date); then use gh pr merge --auto to deliver"',
    'gh pr create --draft --body "regenerated with $(date); then gh pr merge --auto --squash --delete-branch 5"',
    'git commit -m "$(printf x); see gh pr ready --undo"',
    'git commit -m "`date` then gh pr merge x `date`"',
    "git commit -m \"$(cat <<'EOF'\nuse `gh pr merge --auto --squash --delete-branch 5` to deliver\nEOF\n)\"",
    "gh pr create --draft --body \"$(cat <<'EOF'\nuse `gh pr merge --auto --squash --delete-branch 5` to deliver\nEOF\n)\"",
    // A backslash-escaped `$(` or backtick inside double quotes is text and substitutes nothing.
    String.raw`gh pr create --draft --body "Document \$(gh pr merge --admin 493) here"`,
    'git commit -m "use \\`gh pr ready 493\\` to deliver"',
    // A comment or arithmetic before a delivery form hides nothing and refuses nothing.
    'echo hi # a comment\ngh pr ready 493',
    'echo $((1 << 3))\ngh pr merge --auto --squash --delete-branch 493',
    'echo "$#"',
    // A backslash-newline joins the lines, so the character before it decides, and a comment line
    // ending in a backslash continues nothing.
    "echo foo \\\n# do not run gh pr merge --admin 493",
    "echo hi # note\\\n# second gh pr merge --admin 1",
  ]) assert.equal(blockReason(command), '', command);

  for (const command of [
    'gh pr merge --auto --squash --delete-branch 493 --admin',
    'gh pr merge --auto --squash --delete-branch --admin 493',
    'gh pr merge 493 --auto --squash --delete-branch',
    'gh pr merge --auto --squash 493',
    'gh pr merge --auto --merge --delete-branch 493',
    'gh pr merge --auto --squash --delete-branch',
    'gh pr merge --auto --squash --delete-branch 493 494',
    'gh pr merge --auto --squash --delete-branch "493"',
    'gh pr merge --auto --squash --delete-branch $PR',
    'gh pr merge --auto --squash --delete-branch $(cat n)',
    'gh pr merge --auto --squash --delete-branch 493 "--admin"',
    'gh pr merge --auto --squash --delete-branch 493 >/dev/null',
    'gh pr merge --auto --squash --delete-branch 493 # note',
    'gh -R o/r pr merge --auto --squash --delete-branch 493',
    'GH_TOKEN=x gh pr merge --auto --squash --delete-branch 493',
    'timeout 30 gh pr merge --auto --squash --delete-branch 493 --admin',
    'nohup gh pr merge --admin 493',
    'xargs gh pr merge --admin',
    'echo $(gh pr merge --admin 493)',
    'Gh pr merge --auto --squash --delete-branch 493',
    '/usr/local/bin/gh pr merge --auto --squash --delete-branch 493',
    // A lone `&` separates commands with or without a following space.
    'pwd &gh pr merge --auto --squash --delete-branch 493 -R o/r',
    'echo &gh pr merge --auto --squash --delete-branch 1 --admin',
    // A `<<word` or a quote character in a comment or in arithmetic opens no pairing.
    'echo hi # <<pwd\ngh pr merge --auto --squash --delete-branch 1 --admin\npwd',
    'echo $((1 << pwd))\ngh pr merge --auto --squash --delete-branch 1 --admin\npwd',
    "echo hi # don't\ngh pr merge --admin 1\necho 'x'",
    // An even backslash run leaves the blank unescaped, so the `#` is a comment; an odd run escapes
    // the blank, so the `#` continues the word and the rest of the line stays live.
    String.raw`echo a\\ # don't` + "\ngh pr merge --admin 1\necho 'x'",
    String.raw`echo foo\ #; gh pr merge --admin 493`,
    // A command substitution runs inside double quotes.
    'gh pr ready 493 && echo "$(gh pr merge --admin 493)"',
    'echo "`gh pr merge --admin 493`"',
    'echo "$( cd x && gh pr merge --admin 493)"',
    'echo "$(echo $(date) && gh pr merge --admin 493)"',
    'echo "$( (cd x) ; gh pr merge --admin 493)"',
    // An even backslash run escapes nothing, and a live backtick pair runs to its unescaped closer.
    String.raw`echo "\\$(gh pr merge --admin 493)"`,
    'echo "`echo \\`date\\`; gh pr merge --admin 493`"',
    // Quote removal makes a quoted command word the word itself, and a segment that held one is never
    // the delivery form.
    'gh pr "merge" --auto --squash --delete-branch 493 --admin',
    'gh pr "merge" --auto --squash --delete-branch 493',
    "gh 'pr' merge 493",
    '"gh" pr merge 493',
  ]) assert.equal(blockReason(command), REASON_MERGE, command);

  for (const command of [
    'gh pr ready',
    'gh pr ready 493 "$(gh pr merge --admin 493)"',
    'gh pr ready $(cat n)',
    'gh pr ready 493 >/dev/null',
    'gh -R o/r pr ready 493',
    'timeout 30 gh pr ready 493',
    'gh pr ready 493 494',
    'pwd |&gh pr ready 493 -R o/r',
    'node scripts/board.mjs &gh pr ready 493 --repo o/r',
    'node scripts/board.mjs # <<pwd\ngh pr ready 1 -R o/r\npwd',
    'gh pr "ready" 493 -R o/r',
    'gh pr "ready" 493',
    'echo "$(gh pr ready 493 -R o/r)"',
    'echo "see `gh pr ready 493 -R o/r` now"',
  ]) assert.equal(blockReason(command), REASON_READY, command);
});

// ── git commit / push --no-verify ───────────────────────────────────────────

test('git commit --no-verify is blocked', () => {
  assert.equal(blockReason('git commit --no-verify'), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason('Git commit --no-verify'), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason('git commit -m x --no-verify'), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason('git -C . commit --no-verify -m x'), REASON_COMMIT_NO_VERIFY);
});

test('git commit -m mentioning --no-verify in quoted data is allowed', () => {
  assert.equal(blockReason('git commit -m "mentions --no-verify"'), '');
  assert.equal(blockReason("git commit -m 'never use --no-verify here'"), '');
});

test('git push --no-verify is blocked across direct reordered assignment-led and path-qualified forms', () => {
  const blocked = [
    'git push --no-verify origin HEAD',
    'git push origin HEAD --no-verify',
    'git --no-pager push origin HEAD --no-verify',
    'FOO=1 git push --no-verify origin HEAD',
    '/usr/local/bin/git push --no-verify origin HEAD',
    'git -C . push --no-verify origin HEAD',
    'git --git-dir .git push origin HEAD --no-verify',
  ];
  for (const command of blocked) assert.equal(blockReason(command), REASON_PUSH_NO_VERIFY, command);
});

// A plain `env` prefix runs the git command after it, so every git rule judges that command. An
// unset name is whatever word follows `-u`, and a flag inside an assignment's value is a value, so
// neither is read as a flag of the git command.
test('ANTI-REGRESSION: git behind an env prefix meets the flag, hooks-path and history rules, and an env prefix on an ordinary command passes', () => {
  for (const [reason, commands] of [
    [REASON_PUSH_NO_VERIFY, [
      'env FOO=1 git push --no-verify origin HEAD',
      'env git push --no-verify',
      'env FOO=1 BAR=2 git push origin HEAD --no-verify',
      'npm test && env FOO=1 git push --no-verify',
    ]],
    [REASON_COMMIT_NO_VERIFY, [
      'env FOO=1 git commit --no-verify -m x',
      'env -i -u FOO BAR=1 git commit -m x --no-verify',
    ]],
    [REASON_PUSH_FORCE, [
      'env FOO=1 git push --force origin HEAD',
      'env -i git push -f origin main',
      'env - git push --force',
      'env --ignore-environment git push --force',
      'env -u FOO git push --force',
      'env -uFOO git push --force',
      'env --unset=FOO git push --force',
      'env --unset FOO git push --force',
      'env -- git push --force',
      '/usr/bin/env FOO=1 git push --force',
      'ENV FOO=1 git push --force',
      'FOO=1 env BAR=2 git push --force',
      'env FOO=1 /usr/bin/git push --force',
      'env FOO="a b" git push --force',
    ]],
    [REASON_HOOKS_PATH, [
      'env FOO=1 git -c core.hooksPath=/dev/null push',
      'env FOO=1 git --config-env=core.hooksPath=H push',
    ]],
    [REASON_HOOKS_PATH_CONFIG, [
      'env FOO=1 git config core.hooksPath /dev/null',
      'env FOO=1 git config --unset core.hooksPath',
    ]],
    [REASON_FILTER_BRANCH, [
      'env FOO=1 git filter-branch --tree-filter x',
    ]],
  ]) for (const command of commands) assert.equal(blockReason(command), reason, command);
  for (const command of [
    'env FOO=1 git push origin HEAD',
    'env git status',
    'env FOO=1 git push --force-with-lease origin HEAD',
    'env -i git push --force-with-lease',
    'env FOO=1 git commit -m "mentions --no-verify"',
    'env FOO=1 git config core.hooksPath .githooks',
    'env FOO=1 git config --get core.hooksPath',
    'env FOO=1 npm test',
    'env | grep git',
    'env FOO=1 echo git push --force',
    'echo "env FOO=1 git push --force"',
    // Unsets a variable named git and runs `push`, which is no git command.
    'env -u git push --force',
    // An unset name that looks like a flag is a name, and the command is a plain push or commit.
    'env -u --force git push origin HEAD',
    'env -u --no-verify git commit -m x',
    'env --unset=--force git push origin HEAD',
    'env --unset --no-verify git push origin HEAD',
    // A flag inside an assignment's value is a value.
    'env A=--force git push origin HEAD',
  ]) assert.equal(blockReason(command), '', command);
});

// ── hooks-path override ─────────────────────────────────────────────────────

// Pointing git at other hooks skips the gates exactly as --no-verify does, and git takes the
// setting from an option or from the environment, on any subcommand. The value is not judged.
test('ANTI-REGRESSION: a hooks-path override is refused by option and by environment, and the arming step and ordinary commands pass', () => {
  for (const command of [
    'git -c core.hooksPath=/dev/null push origin HEAD',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c core.hooksPath=/dev/null merge --no-ff feature',
    'Git -c CORE.HOOKSPATH=/dev/null push',
    'git -c core.hooksPath= push',
    'git -c core.hooksPath=.githooks push',
    'git --config-env=core.hooksPath=H push origin HEAD',
    'git --config-env core.hooksPath=H push origin HEAD',
    'git -C . -c user.name=x -c core.hooksPath=/dev/null push',
    '/usr/bin/git -c core.hooksPath=/dev/null push',
    'git status && git -c core.hooksPath=/dev/null push',
    'git -c "core.hooksPath=/dev/null" push',
    "git -c 'core.hooksPath=/dev/null' commit -m x",
    'git -c core.hooksPath="/dev/null" push',
    'git --config-env="core.hooksPath=H" push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push',
    'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=CORE.HOOKSPATH GIT_CONFIG_VALUE_1=/x git push',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git push',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="core.hooksPath" GIT_CONFIG_VALUE_0=/dev/null git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null npm run deliver',
    '(export GIT_CONFIG_KEY_0=core.hooksPath)',
    '(GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/x git push)',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/dev/null "GIT_CONFIG_KEY_0=core.hooksPath"; git push origin HEAD',
    'env "GIT_CONFIG_KEY_0=core.hooksPath" GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/x git push',
    "/usr/bin/ENV 'GIT_CONFIG_KEY_0=CORE.HOOKSPATH' GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/x git push",
    'declare -x "GIT_CONFIG_KEY_0=core.hooksPath"',
    'GIT_CONFIG_PARAMETERS="\'core.hooksPath\'=\'/dev/null\'" git commit -m a',
    'export GIT_CONFIG_PARAMETERS="\'core.hooksPath=/dev/null\'"; git push',
    'GIT_CONFIG_PARAMETERS="\'user.name=x\' \'CORE.HOOKSPATH=/dev/null\'" git push',
    'export "GIT_CONFIG_PARAMETERS=\'core.hooksPath=/dev/null\'"; git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath>/dev/null GIT_CONFIG_VALUE_0=/dev/null git push origin HEAD',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath</dev/null GIT_CONFIG_VALUE_0=/dev/null git push origin HEAD',
    'git_config_count=1 git_config_key_0=core.hooksPath git_config_value_0=/dev/null git push origin HEAD',
    'git_config_parameters="\'core.hooksPath=/dev/null\'" git push origin HEAD',
    'export "Git_Config_Key_0=core.hooksPath" GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/x; git push',
    String.raw`GIT_CONFIG_PARAMETERS=\'core.hooksPath\'=\'/dev/null\' git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS=\'core.hooksPath=/dev/null\' git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS=\'user.name=x\'\ \'core.hooksPath=/dev/null\' git push origin HEAD`,
  ]) assert.equal(blockReason(command), REASON_HOOKS_PATH, command);
  for (const command of [
    'git push origin HEAD',
    'git commit -m x',
    'git config core.hooksPath .githooks',
    'git config --get core.hooksPath',
    'git -c user.name=x -c user.email=y commit -m z',
    'git -c core.quotePath=false diff',
    'git -c core.hooksPathology=x status',
    'git -C core.hooksPath=/tmp status',
    'git grep -c core.hooksPath= scripts',
    'git commit -m "explain why git -c core.hooksPath=/dev/null push is refused"',
    'git commit -m "core.hooksPath=/dev/null is refused"',
    'echo "GIT_CONFIG_KEY_0=core.hooksPath"',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=false git push origin HEAD',
    'GIT_CONFIG_GLOBAL=/dev/null git push origin HEAD',
    'MY_GIT_CONFIG_KEY_0=core.hooksPath npm test',
    'grep -rn "GIT_CONFIG_KEY_0=core.hooksPath" scripts',
    'env | grep "GIT_CONFIG_KEY_0=core.hooksPath"',
    'GIT_CONFIG_PARAMETERS= git status',
    'GIT_CONFIG_PARAMETERS="\'color.ui=false\'" git push origin HEAD',
    'echo "GIT_CONFIG_PARAMETERS=\'core.hooksPath=/dev/null\'"',
    'MY_GIT_CONFIG_PARAMETERS="\'core.hooksPath=/dev/null\'" npm test',
    'GIT_CONFIG_PARAMETERS="\'alias.hooks=config --get core.hooksPath\'" git push origin HEAD',
    'GIT_CONFIG_PARAMETERS="\'core.hooksPathology=x\'" git push origin HEAD',
    'export "GIT_CONFIG_PARAMETERS=\'core.hooksPathology=x\'"; git push origin HEAD',
    'GIT_CONFIG_PARAMETERS="\'user.name\'=\'core.hooksPath\'" git push origin HEAD',
    'export "GIT_CONFIG_PARAMETERS=\'user.name\'=\'core.hooksPath\'"; git push origin HEAD',
    String.raw`GIT_CONFIG_PARAMETERS=\'user.name\'=\'core.hooksPath\' git push origin HEAD`,
  ]) assert.equal(blockReason(command), '', command);
});

// The shell joins the quoted pieces of one word before git sees it, so a payload cut into pieces
// is the payload it joins to. Each refused value joins to a payload the test above pins as refused.
test('ANTI-REGRESSION: a hooks-path payload split across quoted pieces is refused, and a split payload that only mentions the key passes', () => {
  for (const command of [
    String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'core.hooksPath"=/dev/null"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/"null"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'user.name=x' "\''core.hooksPath=/dev/null'\' git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'core."'hooksPath=/dev/null'"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'user.name=x'"" 'core.hooksPath=/dev/null'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'"CORE.HOOKSPATH=/dev/null"'" git commit -m a`,
    String.raw`git_config_parameters="'"core.hooksPath=/dev/null"'" git push origin HEAD`,
    String.raw`env GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" git push origin HEAD`,
    String.raw`export GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'"; git push`,
    String.raw`(GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" git push)`,
    String.raw`FOO=1 GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" git push`,
    String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPath"'" git push`,
    String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPath"'='/dev/null'" git push`,
    String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'"`,
    // A partly quoted key inside the payload.
    String.raw`GIT_CONFIG_PARAMETERS=\'core.hooks"Path=/dev/null"\' git push`,
    // A quoted `gh` or `pr` piece inside the value is a piece of the payload, not a command word.
    String.raw`GIT_CONFIG_PARAMETERS="'user.name=""gh""' 'core.hooksPath=/dev/null'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'user.name="'pr'"' 'core.hooksPath=/dev/null'" git push origin HEAD`,
  ]) assert.equal(blockReason(command), REASON_HOOKS_PATH, command);
  for (const [reason, command] of [
    // The name counts only where the environment rule counts it.
    [REASON_PUSH_FORCE, String.raw`echo MY_GIT_CONFIG_PARAMETERS="'core.hooksPath=x'"\;git push --force`],
    [REASON_MERGE, String.raw`MY_GIT_CONFIG_PARAMETERS="'core.hooksPath=$(gh pr merge 5)'" true`],
    // The flag rule is checked first, so the reason does not move.
    [REASON_PUSH_NO_VERIFY, String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" git push --no-verify`],
    // A quoted command word inside the value is still unquoted and read.
    [REASON_MERGE, 'GIT_CONFIG_PARAMETERS="$("gh" pr merge 5)" git push'],
    // The single-span read stays: the name follows a quoted piece here, where the joined read does not count it.
    [REASON_HOOKS_PATH, String.raw`'pr'GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/null'" git push origin HEAD`],
  ]) assert.equal(blockReason(command), reason, command);
  for (const command of [
    // The key is only a value.
    String.raw`GIT_CONFIG_PARAMETERS="'"user.name=core.hooksPath"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'user.name'=""'core.hooksPath'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'"color.ui=false"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'"core.hooksPathology=x"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'alias.h=config --get "core.hooksPath"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'alias.h=config --get "'core.hooksPath'"'" git push origin HEAD`,
    String.raw`GIT_CONFIG_PARAMETERS="'user.name=a b'"" 'color.ui=false'" git log`,
    String.raw`GIT_CONFIG_PARAMETERS="'"user.name=x"'" git push origin HEAD`,
    // A quoted `gh` piece and no hooks-path entry.
    String.raw`GIT_CONFIG_PARAMETERS="'user.name=""gh""'" git push origin HEAD`,
    // Another variable.
    String.raw`MY_GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" npm test`,
    // The name is a value.
    String.raw`x=GIT_CONFIG_PARAMETERS="'"core.hooksPath=/dev/null"'" npm test`,
    // The name sits inside a quoted span.
    String.raw`echo "GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/null'`,
    'GIT_CONFIG_PARAMETERS= git push',
    'GIT_CONFIG_PARAMETERS="" git push',
  ]) assert.equal(blockReason(command), '', command);
});

// A stored change disarms the hooks for every later command, in every worktree. The older syntax
// stores the word after the key as the value even when it looks like an option, so the last
// refused row is a write.
test('ANTI-REGRESSION: a stored hooks-path repoint or unset is refused, and the arming step and a read that ends at the key pass', () => {
  for (const command of [
    'git config core.hooksPath /dev/null',
    'git config core.hooksPath /dev/null && git push',
    'git config --local core.hooksPath /tmp/hooks',
    'git config set core.hooksPath /dev/null',
    'git config --unset core.hooksPath',
    'git config unset core.hooksPath',
    'git config --unset-all core.hooksPath',
    'git config --global core.hooksPath /dev/null',
    'git config "core.hooksPath" /dev/null',
    'git config core.hooksPath "/dev/null"',
    'git -C . config core.hookspath /dev/null',
    'Git config CORE.HOOKSPATH /dev/null',
    'git config core.hooksPath --get',
    'git config --unset core.hooksPath>/dev/null',
    'git config core.hooksPath>/dev/null /dev/null',
    'git config core.hooksPath /dev/null>/dev/null 2>&1',
    'git config --unset-a core.hooksPath',
    'git config --unset-al core.hooksPath',
    'git config core.hooksPath /dev/null # reset',
    String.raw`git config core.hooksPath >/tmp/guard\ #log /dev/null`,
    String.raw`git config core.hooksPath /tmp/my\ #hooks`,
  ]) assert.equal(blockReason(command), REASON_HOOKS_PATH_CONFIG, command);
  for (const command of [
    'git config core.hooksPath .githooks',
    'git config --local core.hooksPath .githooks',
    'git config set core.hooksPath .githooks',
    'git config --get core.hooksPath',
    'git config get core.hooksPath',
    'git config core.hooksPath',
    'git config --get core.hooksPath 2>/dev/null',
    'git config core.hooksPath .githooks > /dev/null 2>&1',
    'git config --show-origin --show-scope --get-all core.hooksPath',
    'git config user.name x',
    'git config --list',
    'git config --get core.hooksPath        # → .githooks',
    'git config --get core.hooksPath>/dev/null',
    'git config core.hooksPath .githooks>/dev/null 2>&1',
    String.raw`git config --get core.hooksPath >/tmp/guard\ log`,
    String.raw`git config --get core.hooksPath >/tmp/guard\ #log`,
  ]) assert.equal(blockReason(command), '', command);
});

// Git takes the first word that is neither an option nor an option's value as the key, so the
// hooks path named after another key is data. A command the guard cannot read in full as written
// is judged by the stored rule above, never exempted.
test('ANTI-REGRESSION: a config command whose own key is another setting passes, and one that writes or unsets the hooks path or cannot be read stays refused', () => {
  for (const command of [
    'git config --unset user.name core.hooksPath',
    'git config --unset-all user.name core.hooksPath',
    'git config --local --unset user.name core.hooksPath',
    'git config --global --unset-all user.name core.hooksPath',
    'git config --system --unset user.name core.hooksPath',
    'git config --replace-all user.name core.hooksPath old',
    'git config user.name core.hooksPath old',
    'git config --add user.name core.hooksPath extra',
    'git config unset --value core.hooksPath user.name',
    'git config unset user.name core.hooksPath',
    'git config set --all user.name core.hooksPath extra',
    'git config --default core.hooksPath --get user.name',
    'git config --file other.cfg --unset user.name core.hooksPath',
    'git config -f other.cfg --unset user.name core.hooksPath',
    'git config --file=other.cfg --unset user.name core.hooksPath',
    'git config --type path --unset user.name core.hooksPath',
    'git config --fixed-value --unset user.name core.hooksPath',
    'git config --unset user.name core.hooksPath 2>/dev/null',
    'git config --unset user.name core.hooksPath # tidy',
    'git -C . config --unset user.name core.hooksPath',
    'git config --unset user.name "core.hooksPath"',
    'git config --file core.hooksPath user.name x',
    'env FOO=1 git config --unset user.name core.hooksPath',
    'git config --unset user.name core.hooksPath\n',
  ]) assert.equal(blockReason(command), '', command);
  // The command's own key is the hooks path.
  for (const command of [
    'git config --file .git/config core.hooksPath /dev/null',
    'git config -f .git/config core.hooksPath /dev/null',
    'git config --file=.git/config core.hooksPath /dev/null',
    'git config --type path core.hooksPath /dev/null',
    'git config --type=path core.hooksPath /dev/null',
    'git config --fixed-value core.hooksPath x .githooks',
    'git config set --value .githooks core.hooksPath /dev/null',
    'git config --local --replace-all core.hooksPath /dev/null',
    'git config --add core.hooksPath /dev/null',
    'git config --default x --get core.hooksPath y',
    'git config --get core.hooksPath pattern',
    'git config --unset core.hooksPath user.name',
    'git config unset --all core.hooksPath',
    'git config --unset --file other.cfg core.hooksPath',
    'git config set core.hooksPath user.name',
    // `--type` takes `user.name` as its value.
    'git config --type user.name core.hooksPath x',
  ]) assert.equal(blockReason(command), REASON_HOOKS_PATH_CONFIG, command);
  // The reader cannot read the command.
  for (const command of [
    // An abbreviated or unlisted option, and a first word that is no subcommand.
    'git config --fil x.y core.hooksPath /dev/null',
    'git config --unset-a user.name core.hooksPath',
    'git config add core.hooksPath /dev/null',
    'git config --comment note user.name core.hooksPath x',
    'git config --local set core.hooksPath /dev/null',
    'git config rename-section core.hooksPath x',
    // A key with a character outside the key's set.
    'git config --unset branch.job/75.merge core.hooksPath',
    'git config --type --unset user.name core.hooksPath',
    // A variable, a quoted word, a backslash and a glob.
    'git config --unset "$K" core.hooksPath',
    'git config --unset $K core.hooksPath',
    'git config --replace-all "$K" core.hooksPath x',
    'git config -f $F a.b core.hooksPath /dev/null',
    'git config set --value $V g.t core.hooksPath x',
    "git config --unset 'user.name' core.hooksPath",
    'git config --file "my cfg" --unset user.name core.hooksPath',
    String.raw`git config --unset user.na\me core.hooksPath`,
    'git config --unset user.* core.hooksPath',
    // A dash word or a quoted word after the key.
    'git config --unset user.name core.hooksPath --fixed-value',
    'git config --replace-all user.name core.hooksPath "old value"',
    'git config --unset user.name -- core.hooksPath',
    'git config --unset -- user.name core.hooksPath',
    'git config --fixed-value=x user.name core.hooksPath y',
    // A lone `&` is no segment break, and the second command disarms the hooks.
    'git config user.name x & git config core.hooksPath /dev/null',
    'git config --unset user.name & git config core.hooksPath /dev/null',
    'git config --unset user.name core.hooksPath & git config core.hooksPath /dev/null',
    'git config --unset user.name >out&git config core.hooksPath /dev/null',
    // A process substitution runs the disarm.
    'git config --unset user.name >(git config core.hooksPath /dev/null >x)',
    // A combined redirection or a here-string in front of the key, and a descriptor copy.
    'git config >& a.b core.hooksPath /dev/null',
    'git config --unset user.name core.hooksPath 2>&1',
    // The shell joins `gh` and `x.y` into one option value, so the key is the hooks path.
    'git config set --value="gh"x.y core.hooksPath /dev/null',
    'git config <<< a.b core.hooksPath /dev/null',
    // Harmless: a command holding a quoted `gh`, `pr`, `merge` or `ready` word is not read.
    'git config --unset user.name core.hooksPath && git commit -m "merge"',
    // A vertical tab is no blank to the shell.
    'git config --unset user.name\vcore.hooksPath x',
    'git config --unset user.name core.hooksPath\v',
    'git config --unset user.name core.hooksPath\f',
    'git config --unset user.name core.hooksPath\r',
    'git config --unset user.name core.hooksPath\u00a0',
    '\u00a0git config --unset user.name core.hooksPath',
    String.raw`git config --unset user.na\ me core.hooksPath`,
  ]) assert.equal(blockReason(command), REASON_HOOKS_PATH_CONFIG, command);
});

// ── git push --force ────────────────────────────────────────────────────────

test('git push --force and -f are blocked', () => {
  assert.equal(blockReason('git push --force'), REASON_PUSH_FORCE);
  assert.equal(blockReason('GIT push --force'), REASON_PUSH_FORCE);
  assert.equal(blockReason('git push -f origin main'), REASON_PUSH_FORCE);
  assert.equal(blockReason('git --git-dir .git push --force'), REASON_PUSH_FORCE);
  assert.equal(blockReason('git commit -m "x" && git push --force'), REASON_PUSH_FORCE);
  assert.equal(blockReason(String.raw`echo foo\ #; git push --force`), REASON_PUSH_FORCE);
  assert.equal(blockReason("echo foo\\\n#; git push --force"), REASON_PUSH_FORCE);
});

test('git push --force-with-lease is allowed', () => {
  assert.equal(blockReason('git push --force-with-lease'), '');
  assert.equal(blockReason('git push --force-with-lease origin HEAD'), '');
  assert.equal(blockReason('git --git-dir .git push --force-with-lease origin HEAD'), '');
});

test('a quoted span that only mentions a flag is still data', () => {
  assert.equal(blockReason('git commit -m "--force is not for us"'), '');
  assert.equal(blockReason('echo git push --no-verify'), '');
  assert.equal(blockReason('grep -n "git push --no-verify" docs/GUIDE.md'), '');
  assert.equal(blockReason('git commit -m "docs: explain why git push --no-verify is blocked"'), '');
  assert.equal(blockReason('echo "git -C . push --no-verify origin HEAD"'), '');
  assert.equal(blockReason('git commit -m "document git -C . push --no-verify"'), '');
});

// The quote blanker pairs quotes in one left-to-right pass together with the cd/-C path placeholder,
// so a stray apostrophe inside a double-quoted message cannot pair with a later single quote and
// swallow live argv (a separate scan once re-opened the --no-verify and --force rules this way).
test('a stray apostrophe in a message cannot hide a gated flag', () => {
  assert.equal(blockReason(`git commit -m "x -C 'a" --no-verify -m '  x'`), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason(`git commit -m "x cd 'a" --no-verify -m ' x'`), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason(`git push -m "x -C 'a" --force ' x'`), REASON_PUSH_FORCE);
});

// A backslash outside single quotes makes the next quote a character: it opens and closes nothing in
// the scan, in the command-word unquote or in the blanker, so the commands around it stay live.
test('ANTI-REGRESSION: a backslash-escaped quote opens and closes no span, so it cannot hide a gated command', () => {
  for (const [command, reason] of [
    // The four the escaped-blank comment rule let through.
    ["echo foo\\ #\\\"\ngit push --force\necho \\\"", REASON_PUSH_FORCE],
    ["echo foo\\ #\\\"\ngh pr merge --admin 493\necho \\\"", REASON_MERGE],
    ["echo foo\\ #\\'\ngh pr ready 493 -R o/r\necho \\'", REASON_READY],
    ["echo foo\\ #\\\"\ngit commit -m x --no-verify\necho \\\"", REASON_COMMIT_NO_VERIFY],
    // An escaped quote before a real pair, and one inside a double-quoted span, pair with nothing.
    ["echo \\\" ; gh pr merge --admin 1 ; echo \"x\"", REASON_MERGE],
    ["echo \"a \\\" b\"; gh pr merge --admin 1; echo \"c \\\" d\"", REASON_MERGE],
    // The scan's quote state ignores it too, so the comment after it is still a comment.
    ["echo \\\" # don't\ngh pr merge --admin 1\necho 'x'", REASON_MERGE],
    ["echo \\' # \"\ngh pr merge --admin 1\necho \"x\"", REASON_MERGE],
    // Inside single quotes the backslash is a character and the quote closes the span.
    ["echo 'a\\' # don't\ngh pr merge --admin 1\necho 'x'", REASON_MERGE],
    // The command-word unquote does not pair an escaped quote with a real one.
    ["echo \"a \\\"gh\"; gh pr ready 1 -R o/r; echo \"b\"", REASON_READY],
    // A message that quotes with escaped quotes is one span, and what it mentions is data.
    ["git commit -m \"say \\\" gh pr merge --admin 1 \\\" here\"", ''],
  ]) assert.equal(blockReason(command), reason, command);
});

// The scan copies a backslash outside single quotes together with the character it escapes and
// reads the pair as nothing, so an escaped `<`, `)` or newline cannot open a heredoc, close
// arithmetic or end the operator line, and a live line cannot be dropped as a body.
test('ANTI-REGRESSION: a backslash-escaped operator character opens no heredoc and closes no arithmetic, so it cannot hide a gated command', () => {
  for (const [command, reason] of [
    // An escaped `<` leaves `<EOF`, an input redirection, and the next line runs.
    ["echo \\\" \\<<EOF\ngh pr merge --admin 493\nEOF", REASON_MERGE],
    ["echo \\<<EOF\ngit push --force\nEOF", REASON_PUSH_FORCE],
    ["echo \\<<pwd\ngh pr ready 1 -R o/r\npwd", REASON_READY],
    ["echo \\<<EOF\ngit commit -m x --no-verify\nEOF", REASON_COMMIT_NO_VERIFY],
    // An escaped `)` closes no arithmetic, so the `<<` after it is still a shift.
    ["echo $(( (1\\)) << 2 ))\ngh pr merge --admin 1\n2", REASON_MERGE],
    // An escaped newline continues the operator line: what follows is argv, and the body starts
    // after the next unescaped newline.
    ["cat <<EOF \\\n; gh pr ready 1 -R o/r\nx\nEOF", REASON_READY],
    ["cat <<EOF \\\nEOF\ngh pr merge --admin 1\nEOF", ''],
    // An escaped backslash escapes nothing: the operator after it is real and its body is data.
    ["echo \\\\<<EOF\ngh pr merge --admin 493\nEOF", ''],
  ]) assert.equal(blockReason(command), reason, command);
});

// ── git filter-branch ───────────────────────────────────────────────────────

test('git filter-branch is blocked', () => {
  assert.equal(blockReason('git filter-branch --tree-filter x'), REASON_FILTER_BRANCH);
  assert.equal(blockReason('Git filter-branch --tree-filter x'), REASON_FILTER_BRANCH);
  assert.equal(blockReason('git -C . filter-branch --tree-filter x'), REASON_FILTER_BRANCH);
});

// ── git worktree add and remove ──────────────────────────────────────────────

// Git bundles short options, takes a value glued to -b or -B, and takes a unique prefix of a long
// option, so each spelling below resets or forces; the invocation is found wherever it sits.
test('ANTI-REGRESSION: a worktree add that resets a branch or forces is refused in every spelling and wherever the invocation sits', () => {
  for (const [command, reason] of [
    ['git worktree add .claude/worktrees/job-1 -B job/1 abc123', REASON_WORKTREE_RESET],
    ['git worktree add -B job/1 .claude/worktrees/job-1 abc123', REASON_WORKTREE_RESET],
    ['git worktree add ../jobs/1 -B job/1 abc123', REASON_WORKTREE_RESET],
    ['git worktree add -Bjob/1 .claude/worktrees/job-1', REASON_WORKTREE_RESET],
    ['git worktree add -qB job/1 .claude/worktrees/job-1', REASON_WORKTREE_RESET],
    ['git -C /repo worktree add .claude/worktrees/job-1 -B main', REASON_WORKTREE_RESET],
    ['env FOO=1 git worktree add .claude/worktrees/job-1 -B main', REASON_WORKTREE_RESET],
    ['FOO=1 git worktree add ../x -B main', REASON_WORKTREE_RESET],
    ['Git worktree add ../x -B main', REASON_WORKTREE_RESET],
    ['/usr/bin/git worktree add ../x -B main', REASON_WORKTREE_RESET],
    ['time git worktree add .claude/worktrees/job-1 -B main', REASON_WORKTREE_RESET],
    ['true & git worktree add .claude/worktrees/job-1 -B main', REASON_WORKTREE_RESET],
    ['npm test && git worktree add ../x -B main', REASON_WORKTREE_RESET],
    ['echo "$(git worktree add .claude/worktrees/job-1 -B main)"', REASON_WORKTREE_RESET],
    ['git worktree remove ../old & git worktree add ../new -B saved HEAD', REASON_WORKTREE_RESET],
    ['echo "$(git worktree remove ../old; git worktree add ../new -B saved HEAD)"', REASON_WORKTREE_RESET],
    ['git worktree add --force .claude/worktrees/job-1 main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add .claude/worktrees/job-1 main -f', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add -f ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add --fo ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add --f ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add -qf ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add -df ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add --force --force ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add -ff ../x main', REASON_WORKTREE_ADD_FORCE],
    // The shell ends a word at an operator character, so an option glued to one still reaches git.
    ['git worktree add ../x main --force>/dev/null', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add .claude/worktrees/job-1 main --force>/dev/null', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add ../x main --force& wait', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add ../x main --force<input', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add ../x main --fo>/dev/null', REASON_WORKTREE_ADD_FORCE],
    ['echo "$(git worktree add ../x main --force; echo done)"', REASON_WORKTREE_ADD_FORCE],
    ['echo "$(git worktree add ../x main --force| cat)"', REASON_WORKTREE_ADD_FORCE],
    ['echo $(git worktree add ../x main --force)', REASON_WORKTREE_ADD_FORCE],
    ['echo `git worktree add ../x main --force`', REASON_WORKTREE_ADD_FORCE],
    ['echo "$(git worktree add ../x main --force\necho done)"', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add ../x main -f>/dev/null', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add ../x -B main>/dev/null', REASON_WORKTREE_RESET],
    ['git worktree add ../x -Bmain>/dev/null', REASON_WORKTREE_RESET],
    // A redirection is no word wherever it is glued, so it hides neither the subcommand nor an option.
    ['git worktree add>/dev/null .claude/worktrees/job-1 -B saved HEAD', REASON_WORKTREE_RESET],
    ['git worktree>/dev/null add ../x -B saved HEAD', REASON_WORKTREE_RESET],
    ['git>/dev/null worktree add -f ../x main', REASON_WORKTREE_ADD_FORCE],
    ['git worktree add 2>/dev/null ../x main --force', REASON_WORKTREE_ADD_FORCE],
    // A later invocation in a substitution is still judged: the first add has no reason of its own, so the second add's reset decides.
    ['echo "$(git worktree add ../x -b job/1 HEAD; git worktree add ../y -B saved HEAD)"', REASON_WORKTREE_RESET],
    // A `>` glued to a path ending in `git` is a word, not the invocation's own, so the `-B` it carries is seen.
    ['git worktree add ${x:-../git> -B saved } HEAD', REASON_WORKTREE_RESET],
    // A redirection before the subcommand hides nothing, whatever its target.
    ['log=/dev/null; git worktree>$log add .claude/worktrees/job-1 -B saved HEAD', REASON_WORKTREE_RESET],
    ['git>$log worktree add ../x -B saved HEAD', REASON_WORKTREE_RESET],
    ['git worktree > >(cat) add ../x -B saved HEAD', REASON_WORKTREE_RESET],
    // A separator inside a quoted span of the substituted text cuts nothing, since the text is judged whole.
    ['echo "$(git worktree add .claude/worktrees/job-1 >\'/tmp/log;name\' -B saved HEAD)"', REASON_WORKTREE_RESET],
    ['echo "$(git worktree add ../x >\'/tmp/log;name\' -B saved HEAD)"', REASON_WORKTREE_RESET],
    // A comment and its apostrophe in the substituted text are read as words, so the live line between two comments is still judged.
    ['echo "$(true # don\'t skip\ngit worktree add .claude/worktrees/job-1 -B saved HEAD\n# owner\'s note\n)"', REASON_WORKTREE_RESET],
    // Bash runs the add after `${x:- #};` and after a non-breaking space before `#;`, so neither hides -B.
    ['echo "$(printf %s ${review_note:- #}; git worktree add .claude/worktrees/job-1 -B saved HEAD)"', REASON_WORKTREE_RESET],
    ['echo "$(true \u00a0#; git worktree add .claude/worktrees/job-1 -B saved HEAD)"', REASON_WORKTREE_RESET],
    // A backslash ends no comment and is no redirection target, so the next line's add is still judged.
    ['echo "$(true # >\\\ngit worktree add .claude/worktrees/job-1 -B saved HEAD\n)"', REASON_WORKTREE_RESET],
    // A value glued to -b is a branch name, so its letters are not options.
    ['git worktree add -bfix/1 ../x main', ''],
    ['git worktree add -bBranch ../x main', ''],
    ['git worktree add --detach ../x main', ''],
    ['git worktree add -d ../x main', ''],
  ]) assert.equal(blockReason(command), reason, command);
});

// A `..` step anywhere after the folder can climb out of it, and while a word holds the folder a
// quoted, escaped, variable, glob or brace word could hide `..`, -B or --force, so each is refused.
test('ANTI-REGRESSION: a worktree add path under the job worktrees folder that climbs back out, or holds a word the guard cannot read, is refused', () => {
  for (const [command, reason] of [
    ['git worktree add .claude/worktrees/../x -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add ./.claude/worktrees/.. -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add .claude/worktrees/job-1/.. -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add .claude/worktrees/../ -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add .claude/worktrees/a/../../b -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add /repo/.claude/worktrees/../outside -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add .claude/worktrees/a/../b -b job/1', REASON_WORKTREE_ESCAPE],
    ['git worktree add .claude/worktrees/x"/../y" -b job/1', REASON_WORKTREE_UNREAD],
    ["git worktree add .claude/worktrees/job-1 '-B' main", REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/job-1 \\-B main', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/$NAME -b job/1', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/{a,..}/x -b job/1', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/.? -b job/1', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/job-1 -b job/1 \\\n-B main', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/job-1 -b job/1 HEAD & echo hi', REASON_WORKTREE_UNREAD],
    ['git worktree add .claude/worktrees/job-232 main > /tmp/worktree.log\\\n --force', REASON_WORKTREE_UNREAD],
    // An escaped `#` is no comment, so its word is read.
    ['git worktree add .claude/worktrees/job-1 -b job/1 HEAD \\# x', REASON_WORKTREE_UNREAD],
    // A double-quoted substitution is judged whole, so a separator or a comment in it is read as a word.
    ['echo "$(git worktree add .claude/worktrees/job-1 -b job/1 HEAD; pwd)"', REASON_WORKTREE_UNREAD],
    ['echo "$(git worktree add .claude/worktrees/job-1 -b job/1 HEAD # create job\n)"', REASON_WORKTREE_UNREAD],
    // A `>` inside a quoted span of substituted text takes no target, so the climbing path is still read.
    ['echo "$(git worktree add \'>/.claude/worktrees/../x\' -b job/1 HEAD)"', REASON_WORKTREE_ESCAPE],
    // A redirection target ends only at a blank or an operator, so one running into a `}` is read as a
    // word and its `..` is seen.
    ['git worktree add ${x:-a >.claude/worktrees/../w}', REASON_WORKTREE_ESCAPE],
    // A `>` glued to a path ending in `git` is a word, not the invocation's own, so the `..` it carries is seen.
    ['git worktree add ${x:--btopic/git> .claude/worktrees/../x } HEAD', REASON_WORKTREE_ESCAPE],
    // A redirection is not a word.
    ['git worktree add .claude/worktrees/job-1 -b job/1 abc123 2>&1', ''],
    ['git worktree add .claude/worktrees/job-1 -b job/1 abc123 > /dev/null', ''],
  ]) assert.equal(blockReason(command), reason, command);
});

test('ANTI-REGRESSION: a forced worktree remove is refused, and a plain remove passes', () => {
  for (const [command, reason] of [
    ['git worktree remove --force .claude/worktrees/job-1', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove .claude/worktrees/job-1 -f', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove -ff ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove --fo ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git -C /repo worktree remove --force x', REASON_WORKTREE_REMOVE_FORCE],
    ['env FOO=1 git worktree remove -f x', REASON_WORKTREE_REMOVE_FORCE],
    // The shell ends a word at an operator character, so an option glued to one still reaches git.
    ['git worktree remove .claude/worktrees/job-1 --force>/dev/null', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove .claude/worktrees/job-1 --force& wait', REASON_WORKTREE_REMOVE_FORCE],
    ['echo "$(git worktree remove .claude/worktrees/job-1 --force; echo done)"', REASON_WORKTREE_REMOVE_FORCE],
    ['echo "$(git worktree remove ../x --force| cat)"', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove ../x --force<input', REASON_WORKTREE_REMOVE_FORCE],
    ['echo $(git worktree remove ../x --force)', REASON_WORKTREE_REMOVE_FORCE],
    ['echo `git worktree remove ../x --force`', REASON_WORKTREE_REMOVE_FORCE],
    ['echo "$(git worktree remove ../x --force\necho done)"', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove ../x -f>/dev/null', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove ../x --fo>/dev/null', REASON_WORKTREE_REMOVE_FORCE],
    // A redirection is no word wherever it is glued, whatever its target.
    ['git worktree remove>/dev/null --force .claude/worktrees/job-1', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree>/dev/null remove --force ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove>"$log" -f ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove> >(cat) --force ../x', REASON_WORKTREE_REMOVE_FORCE],
    // An escaped `>` is part of the path, not a redirection, so `--force` is still read.
    [String.raw`git worktree remove ../old\> --force`, REASON_WORKTREE_REMOVE_FORCE],
    // A `>` glued to a word other than the invocation's own is read as a word, so a `--force` a `${...}`
    // default carries is still seen.
    ['git worktree remove ../x ${x:-a> --force }', REASON_WORKTREE_REMOVE_FORCE],
    // A `>` glued to a path ending in `git` is a word, not the invocation's own, so the `--force` it carries is seen.
    ['git worktree remove ${x:-../git> --force }', REASON_WORKTREE_REMOVE_FORCE],
    // A redirection before the subcommand hides nothing, whatever its target.
    ['git worktree>$log remove --force ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git -c a=b >/dev/null worktree remove --force ../x', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree 2> >(cat >&2) remove --force ../x', REASON_WORKTREE_REMOVE_FORCE],
    // A command inside a process substitution the invocation's redirection passes over is still judged.
    ['git worktree > >(git worktree remove ../dirty --force) add .claude/worktrees/job-1 -b job/1 HEAD', REASON_WORKTREE_REMOVE_FORCE],
    // A `#` is a comment only as a word of its own: after an escaped blank, or inside a quoted span of
    // the substituted text, it is filename data.
    [String.raw`git worktree remove .claude/worktrees/job-1\ # --force`, REASON_WORKTREE_REMOVE_FORCE],
    ['echo "$(git worktree remove \'../jobs/ # 1\' --force)"', REASON_WORKTREE_REMOVE_FORCE],
    // A comment inside a substitution is read as words, so the live line between two comments is still judged.
    ['echo "$(true # don\'t skip\ngit worktree remove ../x --force\n# owner\'s note\n)"', REASON_WORKTREE_REMOVE_FORCE],
    ['git worktree remove .claude/worktrees/job-1', ''],
    ['git worktree remove ../repo.job-1170', ''],
  ]) assert.equal(blockReason(command), reason, command);
});

// The forms the resume skill, the sweep and triage manuals and a verifier run; the Codex sibling
// path and a slice path may sit outside the folder.
test('ANTI-REGRESSION: every workflow worktree add form passes, the Codex sibling path and slice paths outside the job worktrees folder included', () => {
  for (const command of [
    'git worktree add .claude/worktrees/job-232 -b job/232 13ecf6a3b1c2d4e5f60718293a4b5c6d7e8f9012',
    'git worktree add ../jobs/232 -b job/232 13ecf6a3b1c2d4e5f60718293a4b5c6d7e8f9012',
    'git worktree add -b slice/232-guard ../slice-232-guard job/232',
    'git worktree add -b slice/232-guard .claude/worktrees/slice-232-guard job/232',
    'git worktree add -b slice/232-guard ../../../.claude/worktrees/slice-232-guard job/232',
    'git worktree add -b slice/232-guard /Users/someone/repo/.claude/worktrees/slice-232-guard job/232',
    'git worktree add -b slice/232-guard "/Users/someone/Claude Code/repo/.claude/worktrees/slice-232-guard" job/232',
    'git worktree add .claude/worktrees/docs-sweep -b docs-sweep/2026-10-12',
    'git worktree add .claude/worktrees/docs-triage -b docs-triage/2026-10-13',
    'git worktree add --detach .claude/worktrees/verify-232 origin/main',
    'git worktree add .claude/worktrees/verify-232 13ecf6a3b1c2d4e5f60718293a4b5c6d7e8f9012',
    'git worktree add ../repo.job-1171 -b job/1171',
    'git worktree list',
    'git worktree prune',
    'echo "git worktree add -B main x"',
    'time git worktree add .claude/worktrees/job-232 -b job/232 abc123',
    'echo "$(git worktree add ../x -b job/1)"',
    // A trailing comment, a quoted redirection target and a redirection glued onto the subcommand are no words of the add.
    'git worktree add .claude/worktrees/job-1 -b job/1 HEAD # create job',
    'git worktree add .claude/worktrees/job-1 -b job/1 HEAD >"$log" 2>&1',
    'git worktree add .claude/worktrees/job-1 -b job/1 HEAD >\'/tmp/a b\' 2>&1',
    'git worktree add>/dev/null .claude/worktrees/job-1 -b job/1 HEAD',
  ]) assert.equal(blockReason(command), '', command);
});

// ── plain and allowed forms ─────────────────────────────────────────────────

test('ordinary git and gh commands pass', () => {
  for (const command of [
    'git status',
    'git -C . status',
    'git -C . push origin HEAD',
    'git push origin HEAD',
    'git -c color.ui=false push origin HEAD',
    'GIT_AUTHOR_NAME=Someone git push origin HEAD',
    'gh pr list',
    'gh pr view 493 --json state',
  ]) assert.equal(blockReason(command), '', command);
});

// A leading variable assignment is part of how a plain command is written, so the rules anchor past
// it; without that, `GH_HOST=x gh pr create` matched no `^gh` rule and slipped through.
test('an assignment prefix does not smuggle a gated invocation past its rule', () => {
  assert.equal(blockReason('GH_HOST=github.com gh pr create --title x'), REASON_CREATE);
  assert.equal(blockReason('GH_TOKEN=abc gh pr merge 406'), REASON_MERGE);
  assert.equal(blockReason('GH_HOST=github.com gh pr create --draft --title x'), '');
});

// A path-qualified executable is what a PATH lookup resolves to, so every rule anchors on it.
test('a path-qualified git or gh anchors every rule', () => {
  assert.equal(blockReason('/usr/local/bin/gh pr merge 406'), REASON_MERGE);
  assert.equal(blockReason('/opt/homebrew/bin/gh pr create --title x'), REASON_CREATE);
  assert.equal(blockReason('/usr/bin/git push --force'), REASON_PUSH_FORCE);
  assert.equal(blockReason('/usr/local/bin/git filter-branch --tree-filter x'), REASON_FILTER_BRANCH);
  assert.equal(blockReason('/usr/local/bin/gh pr create --draft --title x'), '');
  assert.equal(blockReason('/usr/local/bin/gh pr merge --auto 406'), REASON_MERGE);
  assert.equal(blockReason('echo "/usr/bin/env gh pr merge 1"'), '');
});

// The guard reads only plainly written commands: a gh api call whose jq filter carries an escaped
// quote is ordinary work and passes. This is a command the guard once refused, its names made neutral, and
// refusing it retired the escaped-quote layer; the fixture uses String.raw because a cooked '\"' contains no
// backslash and asserts nothing.
test('ANTI-REGRESSION: the gh api command the escaped-quote layer once refused passes', () => {
  const command = String.raw`cd "/Users/someone/Developer/Claude Code/example-repository/.claude/worktrees/1198" && git branch -m worktree-1198 job/1198 && git log --oneline -1 && (ls node_modules >/dev/null 2>&1 && echo "node_modules present" || echo "need npm ci") && echo "--- board add" && PROJECT_ID=$(gh api graphql -f query='{ user(login:"someone") { projectsV2(first:10) { nodes { id title number } } } }' --jq '.data.user.projectsV2.nodes[] | select(.title | test("Example")) | .id') && echo "project $PROJECT_ID" && ISSUE_ID=$(gh api graphql -f query='{ repository(owner:"someone", name:"example-repository") { issue(number:1198) { id } } }' --jq '.data.repository.issue.id') && gh api graphql -f query="mutation { addProjectV2ItemById(input:{projectId:\"$PROJECT_ID\", contentId:\"$ISSUE_ID\"}) { item { id } } }" --jq '.data.addProjectV2ItemById.item.id' && node scripts/board-move.mjs 1198 Building`;
  assert.equal(blockReason(command), '');
  assert.equal(blockReason(String.raw`gh api graphql -f query='{ viewer { login } }' --jq '.data.viewer.login | "\"" + . + "\""'`), '');
  assert.equal(blockReason(String.raw`git commit -m "quote a \"word\" in the message"`), '');
});

// ── executable names are matched case-insensitively ─────────────────────────
// This Mac's volume is case-insensitive, so `Git` and `GH` run the real binary. Only the name is
// widened: subcommands and flags stay exact (`git COMMIT` and `gh PR` are not commands, `-F` is not
// `-f`). `cd` stays lowercase on purpose: a capitalised `CD` runs /usr/bin/cd in a child process
// and moves nothing, so treating it as a relocation would be the fail-open direction.

test('a capitalised git or gh name is refused exactly as the lowercase form', () => {
  const twins = [
    ['git commit --no-verify', 'GIT commit --no-verify'],
    ['git push --no-verify', 'Git push --no-verify'],
    ['git push --force', 'gIt push --force'],
    ['git push -f', 'Git push -f'],
    ['git filter-branch --tree-filter x', 'GIT filter-branch --tree-filter x'],
    ['gh pr create --title x', 'GH pr create --title x'],
    ['gh pr merge 493', 'Gh pr merge 493'],
    ['/usr/bin/git push --force', '/usr/bin/Git push --force'],
  ];
  for (const [lower, upper] of twins) {
    const reason = blockReason(lower);
    assert.ok(reason, lower);
    assert.equal(blockReason(upper), reason, upper);
  }
  // the escape flags are matched exactly as before: a capitalised name does not loosen them
  assert.equal(blockReason('Git push --force-with-lease'), '');
  assert.equal(blockReason('GH pr create --draft --title x'), '');
  assert.equal(blockReason('GH pr merge --auto 493'), REASON_MERGE);
  // the root-checkout rule anchors on the same name; `CD` is not a relocation, so the walk stays put
  const inRoot = { cwd: '/root', isRootCheckout: (dir) => dir === '/root', platform: process.platform };
  assert.equal(blockReason('Git checkout -b job/1188', inRoot), blockReason('git checkout -b job/1188', inRoot));
  assert.ok(blockReason('CD /job && git commit -m wip', inRoot));
  assert.equal(blockReason('cd /job && git commit -m wip', inRoot), '');
});

test('a quoted or prose mention of Git or GH is still data', () => {
  for (const command of [
    'echo "Git push --force"',
    'git commit -m "Git push --force was refused"',
    "grep -rn 'GH pr merge' docs",
    'echo GIT',
  ]) assert.equal(blockReason(command), '', command);
});

// ── heredoc bodies are DATA ──────────────────────────────────────────────────
// Found live: the force-push rule blocked the commit message that documented it. A commit body
// describing `git push --force`, or quoting `--draft`, is prose, not an invocation. A guard that
// fires on writing about itself is friction, not safety.

test('a heredoc commit body mentioning a force push is allowed', () => {
  assert.equal(blockReason("git commit -F - <<'EOF'\nfix: git push --force was allowed\nEOF"), '');
  assert.equal(blockReason("cat <<'EOF'\ngit push --no-verify skips local gates\nEOF"), '');
});

test('a heredoc PR body mentioning --draft does not satisfy the create rule', () => {
  assert.equal(blockReason("gh pr create --title x --body \"$(cat <<'EOF'\nwe now require --draft on every PR\nEOF\n)\""), REASON_CREATE);
});

test('a real invocation AFTER a heredoc is still blocked', () => {
  assert.equal(blockReason("git commit -F - <<'EOF'\nsome message\nEOF\ngit push --force"), REASON_PUSH_FORCE);
});

// deheredoc removes only a real heredoc body: a body starts after the NEXT unquoted newline (POSIX
// XCU 2.7.4), so words after `<<WORD` on the operator line are argv, and a `<<WORD` mention inside
// quoted prose opens no pairing with a later bare `WORD` line.
test('deheredoc removes only a real heredoc body', () => {
  // Same-line argv after the operator survives to the rules.
  const sameLineArgv = [
    ['git commit <<EOF -m x --no-verify\nbody\nEOF', REASON_COMMIT_NO_VERIFY],
    ['git push <<EOF --force\nbody\nEOF', REASON_PUSH_FORCE],
    ['gh pr create <<EOF --title x\nbody mentions --draft\nEOF', REASON_CREATE],
    ["git commit <<'EOF' -m x --no-verify\nbody\nEOF", REASON_COMMIT_NO_VERIFY],
    ['git commit <<-EOF -m x --no-verify\n\tbody\n\tEOF', REASON_COMMIT_NO_VERIFY],
  ];
  for (const [command, reason] of sameLineArgv) assert.equal(blockReason(command), reason, command);

  // A `<<WORD` inside quoted prose opens no pairing, so the live command between the mention and a
  // later bare terminator line reaches the rules.
  const quotedProse = [
    ['echo "docs mention <<EOF"\ngit push --force\nEOF', REASON_PUSH_FORCE],
    ["echo 'docs <<EOF'\ngit push --force\nEOF", REASON_PUSH_FORCE],
    ['echo "line1\n<<EOF"\ngit push --force\nEOF', REASON_PUSH_FORCE],
    // `<<<` is a here-STRING, not a here-document, and opens no pairing either.
    ['cat <<<"EOF"\ngit push --force\nEOF', REASON_PUSH_FORCE],
  ];
  for (const [command, reason] of quotedProse) assert.equal(blockReason(command), reason, command);

  // The body starts at the next UNQUOTED newline. A newline INSIDE a quoted argument on the operator
  // line is argv text, not the end of the operator line, so the flags after it survive to the rules
  // (real bash keeps the --no-verify live here).
  const quotedNewlineArgv = [
    ['git commit <<EOF -m "first\nsecond" --no-verify\nbody\nEOF', REASON_COMMIT_NO_VERIFY],
    ["git commit <<EOF -m 'first\nsecond' --no-verify\nbody\nEOF", REASON_COMMIT_NO_VERIFY],
  ];
  for (const [command, reason] of quotedNewlineArgv) assert.equal(blockReason(command), reason, command);

  // A `<<` inside shell arithmetic is a shift and opens no pairing, so a later bare `3` line strips
  // nothing and the push stays live.
  assert.equal(blockReason('echo $((1 << 3))\ngit push --force\n3'), REASON_PUSH_FORCE);
  assert.equal(blockReason('echo $((1 << 3))\ngit push --force'), REASON_PUSH_FORCE);

  // Operator-line argv is live: a real `--draft` after the operator satisfies the create rule, and a
  // heredoc operator inside a `gh pr ready` segment is a redirection the ready rule refuses.
  assert.equal(blockReason('gh pr create --title x <<EOF --draft\nbody\nEOF'), '');
  assert.equal(blockReason('gh pr ready 1 <<EOF --undo\nbody\nEOF'), REASON_READY);
  // Two heredocs on one line: A's body then B's, both inert, even when body B is a bare gated command.
  assert.equal(blockReason('cat <<A <<B\nprose\nA\ngit push --force\nB'), '');

  // A delimiter with an empty quoted suffix is read by its word characters and paired, so its body,
  // apostrophe included, is dropped and cannot open a span that hides the live command after it.
  assert.equal(blockReason('cat <<EOF""\n\'\nEOF\ngh pr ready 1 -R o/r\necho "\'"'), REASON_READY);

  // Legitimate-heredoc preservation: every shape below is ALLOW and must stay ALLOW.
  const preserved = [
    // unquoted <<EOF prose body
    'cat <<EOF\ngit push --no-verify skips local gates\nEOF',
    // tab-indented <<-EOF
    'git commit -F - <<-EOF\n\tprose --no-verify\n\tEOF',
    // PR body via command substitution
    `gh pr create --draft --title x --body "$(cat <<'EOF'\nwe now require --draft\nEOF\n)"`,
    // heredoc redirected to a file
    "cat > /tmp/x <<'EOF'\ngit push --force\nEOF",
    // operator line with a quoted argument after it
    "git commit -F - <<'EOF' -m 'x'\nprose git push --force\nEOF",
    // apostrophe inside a quoted span before the operator cannot poison quote state
    'echo "it\'s fine" && cat <<EOF\ngit push --force\nEOF',
    // prose mention AND a real heredoc in one command
    'echo "mentions <<EOF" ; git commit -F - <<\'EOF\'\nprose about git push --force\nEOF',
    // two heredocs on one line, both prose
    'cat <<A <<B\nprose git push --force\nA\nprose git push --force\nB',
    // body whose text merely resembles the terminator
    "git commit -F - <<'EOF'\nEOF is the word\nEOF",
    // CRLF line endings still terminate the body (the \\r? tolerance)
    "git commit -F - <<'EOF'\r\nprose git push --force\r\nEOF\r\n",
    // unterminated heredoc strips nothing and stays fail-open on the allowed side
    'cat <<EOF\ngit status',
    // a quoted newline in the message plus a real heredoc: the message is data, the body inert
    "git commit -m \"line1\nline2\" -F - <<'EOF'\nprose about --no-verify\nEOF",
    // a body quoting an escaped quote and a force push is prose
    String.raw`git commit -F - <<'EOF'
prose quoting a \" escape and a git push --force mention
EOF`,
  ];
  for (const command of preserved) assert.equal(blockReason(command), '', command);
});

// ── integration checkout ─────────────────────────────────────────────────────
// The root checkout stays on main; branch work there is refused when the hook says the command
// runs in it. The resolver is injected: git's own answer is exercised in checkout-context.test.mjs.
// Mutation: delete rootCheckoutReason from the segment walk and every refusal below returns ''.
// The walk resolves each hop with node:path, which on Windows yields a drive-letter, backslashed
// path, so the fixture paths are built the same way to match on every platform.

const ROOT = resolve('/Users/someone/Claude Code/repo');
const WORKTREES = join(ROOT, '.claude', 'worktrees');
const JOB = join(WORKTREES, '1170');
const isRootCheckout = (dir) => dir === ROOT || (dir.startsWith(`${ROOT}${sep}`) && !dir.startsWith(`${WORKTREES}${sep}`));
const inRoot = { cwd: ROOT, isRootCheckout, platform: process.platform };
const inJob = { cwd: JOB, isRootCheckout, platform: process.platform };
const rootReason = (subcommand) => `git ${subcommand} in the integration checkout: the root stays on main and nothing is branched, switched, or committed there — open a job checkout with git worktree add and run it from there`;

test('ANTI-REGRESSION: branch work in the root checkout is refused; the same call in a worktree passes', () => {
  const branchWork = {
    'git commit -m "wip"': 'commit',
    'Git commit -m "wip"': 'commit',
    'git checkout -b job/1170': 'checkout',
    'git checkout feature': 'checkout',
    'git checkout -- docs/GUIDE.md': 'checkout',
    'git switch -c job/1170': 'switch',
    'git switch feature': 'switch',
    'git branch job/1170': 'branch',
    'git branch -m old new': 'branch',
    'GIT_AUTHOR_NAME=x git commit -m "wip"': 'commit',
    '/usr/bin/git commit -m "wip"': 'commit',
    'npm test && git commit -m "green"': 'commit',
    'git -C src commit -m "wip"': 'commit',
    'cd src && git commit -m "wip"': 'commit',
    'git switch --detach main': 'switch',
    'git checkout -B main origin/main': 'checkout',
    'git checkout main -- docs/GUIDE.md': 'checkout',
    'git merge job/1170': 'merge',
    'git cherry-pick abc123': 'cherry-pick',
    'git revert HEAD': 'revert',
    'git rebase job/1170': 'rebase',
    'git am patch.mbox': 'am',
  };
  for (const [command, subcommand] of Object.entries(branchWork)) {
    assert.equal(blockReason(command, inRoot), rootReason(subcommand), command);
    assert.equal(blockReason(command, inJob), '', command);
  }
  // The rule sits in front of the others, not in place of them.
  assert.equal(blockReason('git commit --no-verify', inJob), REASON_COMMIT_NO_VERIFY);
});

test('ANTI-REGRESSION: branch work behind an env prefix is refused in the root checkout, and env in front of cd moves nothing', () => {
  const branchWork = {
    'env FOO=1 git commit -m "wip"': 'commit',
    'env git checkout -b job/1170': 'checkout',
    'env -i git switch -c job/1170': 'switch',
    'env FOO=1 git -C src commit -m "wip"': 'commit',
    '/usr/bin/env git rebase job/1170': 'rebase',
  };
  for (const [command, subcommand] of Object.entries(branchWork)) {
    assert.equal(blockReason(command, inRoot), rootReason(subcommand), command);
    assert.equal(blockReason(command, inJob), '', command);
  }
  for (const command of [
    'env FOO=1 git switch main',
    'env git pull --ff-only',
    'env FOO=1 git status',
    `cd "${JOB}" && env FOO=1 git commit -m "wip"`,
    `env FOO=1 git -C "${JOB}" commit -m "wip"`,
  ]) {
    assert.equal(blockReason(command, inRoot), '', command);
  }
  // `env cd` is not read as a move, so the commit is judged where the command started.
  assert.equal(blockReason(`env cd "${JOB}" && git commit -m "wip"`, inRoot), rootReason('commit'));
});

test('pulling main forward, deleting branches, worktree upkeep, and reads pass in the root checkout', () => {
  for (const command of [
    'git pull',
    'git pull --ff-only',
    'git pull --ff-only origin main',
    'git fetch origin',
    'git merge --ff-only origin/main',
    'git switch main',
    'git checkout main',
    'git switch -q main',
    'git checkout -q main',
    'git switch main 2>/dev/null',
    'git checkout main 2>&1',
    'git switch main > /dev/null 2>&1',
    'git switch main &> /dev/null',
    'git switch --no-guess main',
    'git checkout --ignore-other-worktrees main',
    'git switch main && git pull --ff-only',
    'git branch --merged main',
    'git branch --no-merged main',
    'git branch --contains abc123',
    'git branch --list "job/*"',
    'git merge --abort',
    'git rebase --abort',
    'git cherry-pick --quit',
    'git merge-base HEAD main',
    'git merge-base --is-ancestor job/1170 main',
    'git reset --hard origin/main',
    'git branch -d job/1170',
    'git branch -D job/1170',
    'git branch --delete job/1170',
    'git branch',
    'git branch -a',
    'git branch --show-current',
    'git worktree add ../repo.job-1171 -b job/1171',
    'git worktree remove ../repo.job-1170',
    'git worktree prune',
    'git worktree list',
    'git status',
    'git log --oneline -5',
    'git diff',
    'git rev-parse HEAD',
    'echo "git commit -m wip"',
    'grep -rn "git checkout -b" docs',
  ]) {
    assert.equal(blockReason(command, inRoot), '', command);
  }
});

test('the walk follows cd and git -C, quoted paths with spaces included', () => {
  // From the root into a worktree: allowed.
  assert.equal(blockReason(`cd "${JOB}" && git commit -m "wip"`, inRoot), '');
  assert.equal(blockReason('cd .claude/worktrees/1170 && npm test && git commit -m "wip"', inRoot), '');
  assert.equal(blockReason(`git -C "${JOB}" commit -m "wip"`, inRoot), '');
  // A parenthesised cd never relocates (named fail-closed residual): nothing would restore the
  // directory when the subshell closes, so the whole command is judged where it started.
  assert.equal(blockReason(`(cd '${JOB}' && git switch -c x)`, inRoot), rootReason('switch'));
  assert.equal(blockReason(`(cd '${JOB}' && npm test) && git commit -m "wip"`, inRoot), rootReason('commit'));
  // From a worktree back into the root: refused.
  assert.equal(blockReason(`cd "${ROOT}" && git commit -m "wip"`, inJob), rootReason('commit'));
  assert.equal(blockReason('cd ../../.. && git checkout -b x', inJob), rootReason('checkout'));
  assert.equal(blockReason(`git -C "${ROOT}" switch -c x`, inJob), rootReason('switch'));
  assert.equal(blockReason('git -C .. -C ../.. branch x', inJob), rootReason('branch'));
  // A later cd moves again, and an unresolvable hop does not hide a later absolute one.
  assert.equal(blockReason(`cd "${ROOT}" && cd .claude/worktrees/1170 && git commit -m "wip"`, inJob), '');
  assert.equal(blockReason(`cd "$X" && cd "${ROOT}" && git commit -m "wip"`, inJob), rootReason('commit'));
  // A cd inside a heredoc BODY is inert data: the relocation test reads the deheredoc text, so a
  // worktree commit whose message body mentions `cd /tmp` is not judged as if it were in the root.
  assert.equal(blockReason("cat <<'EOF' > notes.txt\ncd /tmp\nEOF\ngit commit -m wip", inJob), '');
});

test('ANTI-REGRESSION: a cd that could have failed keeps the old directory as a candidate', () => {
  // `;`, a newline, and `||` run on after a failed cd, so the root stays in the set and refuses.
  assert.equal(blockReason('cd .claude/worktrees/gone; git commit -m "wip"', inRoot), rootReason('commit'));
  assert.equal(blockReason('cd .claude/worktrees/gone\ngit commit -m "wip"', inRoot), rootReason('commit'));
  assert.equal(blockReason(`cd "${JOB}"; git commit -m "wip"`, inRoot), rootReason('commit'));
  assert.equal(blockReason(`cd "${JOB}" || exit 1; git commit -m "wip"`, inRoot), rootReason('commit'));
  // A pipeline cd moves nothing.
  assert.equal(blockReason(`cd "${JOB}" | cat && git commit -m "wip"`, inRoot), rootReason('commit'));
  // An unknown candidate beside a known root one does not hide it.
  assert.equal(blockReason('cd "$X"; git commit -m "wip"', inRoot), rootReason('commit'));
  // From a worktree the same shapes stay allowed: no candidate is the root.
  assert.equal(blockReason('cd .claude/worktrees/gone; git commit -m "wip"', inJob), '');
  assert.equal(blockReason(`cd "${JOB}" || exit 1; git commit -m "wip"`, inJob), '');
  // `&&` replaces the set, so a cd into a worktree from the root still passes.
  assert.equal(blockReason(`cd "${JOB}" && git commit -m "wip"`, inRoot), '');
});

test('without a checkout context, or at a directory the guard cannot resolve, the rule is not judged', () => {
  assert.equal(blockReason('git commit -m "wip"'), '');
  assert.equal(blockReason('git checkout -b x', undefined), '');
  for (const command of [
    'cd "$JOB" && git commit -m "wip"',
    'cd ~/repo && git commit -m "wip"',
    'cd && git commit -m "wip"',
    'cd - && git commit -m "wip"',
    'git --git-dir=/elsewhere/.git commit -m "wip"',
    'git --work-tree /elsewhere commit -m "wip"',
  ]) {
    assert.equal(blockReason(command, inRoot), '', command);
  }
});

test('the path placeholder carries a real quoted path, spaces and all', () => {
  assert.equal(blockReason(`cd "${ROOT}" && git commit -m "wip"`, inJob), rootReason('commit'));
  assert.equal(blockReason(`git -C "${ROOT}" commit -m "wip"`, inJob), rootReason('commit'));
});

// ── Git Bash paths on Windows ────────────────────────────────────────────────
// Claude Code runs a Bash-tool command on Windows through Git for Windows' bash, whose mount table
// puts each drive at /<letter> and its own install folder at /. The expected paths are written out
// by hand, never derived with node:path. Mutation: drop the drive-path reading and `/c/…` resolves
// to C:\c\…, so the cd into the root from a worktree is allowed.

const WIN_ROOT = 'C:\\Users\\someone\\Claude Code\\repo';
const WIN_JOB = 'C:\\Users\\someone\\Claude Code\\repo\\.claude\\worktrees\\1170';
const winCheckout = (root, cwd) => ({
  cwd,
  platform: 'win32',
  isRootCheckout: (dir) => dir === root || (dir.startsWith(`${root}\\`) && !dir.startsWith(`${root}\\.claude\\worktrees\\`)),
});

test('ANTI-REGRESSION: on Windows a Git Bash drive path after cd or -C is read as its drive', () => {
  const winJob = winCheckout(WIN_ROOT, WIN_JOB);
  assert.equal(blockReason('cd "/c/Users/someone/Claude Code/repo" && git commit -m "wip"', winJob), rootReason('commit'));
  assert.equal(blockReason('git -C "/c/Users/someone/Claude Code/repo" switch -c x', winJob), rootReason('switch'));
  assert.equal(blockReason('cd "/C/Users/someone/Claude Code/repo" && git commit -m "wip"', winJob), rootReason('commit'));
  const winRoot = winCheckout(WIN_ROOT, WIN_ROOT);
  assert.equal(blockReason('cd "/c/Users/someone/Claude Code/repo/.claude/worktrees/1170" && git commit -m "wip"', winRoot), '');
});

test('on Windows a rooted path other than a drive is an unresolved target', () => {
  const root = 'C:\\srv\\repo';
  assert.equal(blockReason('cd /srv/repo && git commit -m "wip"', winCheckout(root, 'C:\\srv\\repo\\.claude\\worktrees\\1170')), '');
  assert.equal(blockReason('cd /srv/repo; git commit -m "wip"', winCheckout(root, root)), rootReason('commit'));
});

test('on macOS and Linux a /c/ folder is judged as the real folder it names', () => {
  const posixCheckout = (root, cwd) => ({
    cwd,
    platform: 'linux',
    isRootCheckout: (dir) => dir === root || (dir.startsWith(`${root}/`) && !dir.startsWith(`${root}/.claude/worktrees/`)),
  });
  const root = '/c/Users/someone/repo';
  assert.equal(blockReason('cd /c/Users/someone/repo && git commit -m "wip"', posixCheckout(root, `${root}/.claude/worktrees/1170`)), rootReason('commit'));
  assert.equal(blockReason('cd /c/Users/someone/repo/.claude/worktrees/1170 && git commit -m "wip"', posixCheckout(root, root)), '');
  assert.equal(blockReason('cd /srv/repo && git commit -m "wip"', posixCheckout('/srv/repo', '/srv/repo/.claude/worktrees/1170')), rootReason('commit'));
});


test('cleanup permission grants only the plain trusted-root command', () => {
  const plain = [
    'node scripts/closeout-cleanup.mjs',
    'node scripts/closeout-cleanup.mjs 321 --scratch /tmp/321 --regenerated node_modules',
    '\t node\tscripts/closeout-cleanup.mjs --pr https://github.com/o/r/pull/321 \t',
    'node scripts/closeout-cleanup.mjs --check C:/jobs/test --flag=value_1,@+%=-',
    'node scripts/closeout-cleanup.mjs --unknown',
    'node scripts/closeout-cleanup.mjs --scratch',
  ];
  for (const command of plain) {
    assert.equal(cleanupPermission(command, true), 'allow', command);
    for (const untrusted of [false, undefined, null, 1, 'true', {}]) {
      assert.equal(cleanupPermission(command, untrusted), 'deny', command);
    }
  }
  const directUnsupported = [
    'node scripts/closeout-cleanup.mjs "quoted path"',
    "node scripts/closeout-cleanup.mjs 'quoted path'",
    'node scripts/closeout-cleanup.mjs /tmp/کوردی',
    'node scripts/closeout-cleanup.mjs $TARGET',
    'node scripts/closeout-cleanup.mjs $(echo target)',
    'node scripts/closeout-cleanup.mjs `echo target`',
    'node scripts/closeout-cleanup.mjs a\\ b',
    'node scripts/closeout-cleanup.mjs *',
    'node scripts/closeout-cleanup.mjs > output',
    'node scripts/closeout-cleanup.mjs 321; echo done',
    'node scripts/closeout-cleanup.mjs 321 && echo done',
    'node scripts/closeout-cleanup.mjs 321 | cat',
    'node scripts/closeout-cleanup.mjs 321\necho done',
    'node scripts/closeout-cleanup.mjs 321\n',
    'node scripts/closeout-cleanup.mjs 321\r\n',
    'node scripts/closeout-cleanup.mjs 321 # comment',
  ];
  for (const command of directUnsupported) {
    assert.equal(cleanupPermission(command, true), undefined, command);
    assert.equal(cleanupPermission(command, false), 'deny', command);
  }
  for (const command of [
    undefined, null, 321, {}, [],
    'node /root/scripts/closeout-cleanup.mjs 321',
    'node ./scripts/closeout-cleanup.mjs 321',
    'NODE scripts/closeout-cleanup.mjs 321',
    '/usr/bin/node scripts/closeout-cleanup.mjs 321',
    'node "scripts/closeout-cleanup.mjs" 321',
    'FLAG=1 node scripts/closeout-cleanup.mjs 321',
    'env node scripts/closeout-cleanup.mjs 321',
    'sh -c "node scripts/closeout-cleanup.mjs 321"',
    '(node scripts/closeout-cleanup.mjs 321)',
    'echo $(node scripts/closeout-cleanup.mjs 321)',
    'cd /root && node scripts/closeout-cleanup.mjs 321',
    'node scripts/closeout-cleanup.mjs-other 321',
    'node scripts/closeout-cleanup.mjs; echo done',
    '\nnode scripts/closeout-cleanup.mjs 321',
  ]) {
    assert.equal(cleanupPermission(command, true), undefined, String(command));
    assert.equal(cleanupPermission(command, false), undefined, String(command));
  }
});

// ── retired product manager run session ──────────────────────────────────────

// Oracle: card 770 retires the product manager run, so the option that named its session restricts nothing.
// Mutation: restore the run session refusal in blockReason. Recurring cost: pure calls, no subprocess.
test('ANTI-REGRESSION: the retired product manager option refuses no publish, and every other rule still judges the command', () => {
  const publishing = [
    'git push origin job/1',
    'gh pr create --draft --title x',
    'gh pr ready 406',
    'gh pr merge --auto --squash --delete-branch 406',
  ];
  for (const options of [undefined, { runSession: true }]) {
    for (const command of publishing) assert.equal(blockReason(command, undefined, options), '', command);
    assert.equal(blockReason('git push --force origin job/1', undefined, options), REASON_PUSH_FORCE);
    assert.equal(blockReason('gh pr create --title x', undefined, options), REASON_CREATE);
  }
});

// ── desktop app session whose run mark cannot be read ───────────────────────
// The Claude hook passes `runMarkUnreadable`, the cause, only in the desktop app, where a sidebar card session's mark
// is a line of its saved conversation. The expected texts are the plan's refusal prefixes followed by the cause.
// Recurring cost: pure calls, no subprocess. Remove if the sidebar run route is retired.

test('ANTI-REGRESSION: a desktop app session whose run mark cannot be read publishes nothing, and every other rule still judges it', () => {
  const cause = 'its transcript could not be read (ENOENT)';
  const UNREADABLE = { runMarkUnreadable: cause };
  const PUBLISHES_NOTHING = `a desktop app session whose run mark cannot be read publishes nothing: ${cause}`;
  assert.equal(blockReason('git push origin job/1', inJob, UNREADABLE), PUBLISHES_NOTHING);
  assert.equal(blockReason('gh pr merge 3', inJob, UNREADABLE), PUBLISHES_NOTHING);
  assert.equal(blockReason('git status', inJob, UNREADABLE), '');
  assert.equal(blockReason('git commit --no-verify -m x', inJob, UNREADABLE), REASON_COMMIT_NO_VERIFY);
  assert.equal(blockReason('git push origin job/1', inJob), '');
});

// ── gh pr new is gh pr create ───────────────────────────────────────────────
// gh lists `new` as an alias of `create`, so every rule that judges a create judges the alias alike.

test('gh pr new is judged as gh pr create', () => {
  assert.equal(blockReason('gh pr new --title x --body y'), REASON_CREATE);
  assert.equal(blockReason('GH pr new --title x --body y'), REASON_CREATE);
  assert.equal(blockReason('gh pr new --draft --title x'), '');
  assert.equal(blockReason('gh pr new -d --title x'), '');
  assert.equal(blockReason('gh pr new --title "block it without --draft " --body x'), REASON_CREATE);
  assert.equal(blockReason('gh pr new --body "see --draft docs" --title x'), REASON_CREATE);
  assert.equal(blockReason('gh pr new --title x --body "line1\nline2" --draft'), '');
  assert.equal(blockReason('gh -R owner/repo pr new --title x'), REASON_CREATE);
  assert.equal(blockReason('gh pr -R owner/repo new --title x'), REASON_CREATE);
  assert.equal(blockReason('gh -Rowner/repo pr new --title x'), REASON_CREATE);
  assert.equal(blockReason('GH_HOST=github.com gh pr new --title x'), REASON_CREATE);
  assert.equal(blockReason('GH_HOST=github.com gh pr new --draft --title x'), '');
  assert.equal(blockReason('/opt/homebrew/bin/gh pr new --title x'), REASON_CREATE);
  assert.equal(blockReason('/usr/local/bin/gh pr new --draft --title x'), '');
  assert.equal(blockReason('GH pr new --draft --title x'), '');
  assert.equal(blockReason("gh pr new --title x --body \"$(cat <<'EOF'\nwe now require --draft on every PR\nEOF\n)\""), REASON_CREATE);
  assert.equal(blockReason('gh pr new <<EOF --title x\nbody mentions --draft\nEOF'), REASON_CREATE);
  assert.equal(blockReason('gh pr new --title x <<EOF --draft\nbody\nEOF'), '');
  assert.equal(blockReason('echo "gh pr new"'), '');
});

// ── pre-approved run session ─────────────────────────────────────────────────
// The publish check reads git and GitHub through two injected runners, each taking the argument list
// and returning stdout or throwing, as merge-watch's gitExec and ghExec do. The fakes answer only the
// reads the check makes, for a job/7 worktree whose origin is acme/widgets and whose GraphQL card reply
// carries GitHub's own field names, its labels complete and none unless a case gives its own, and record every
// call so a case can say which reads a refusal must come before. The session directory holds the saved write-up of HEAD, clear unless a case gives its
// own, the pull request's head is HEAD and its published body is the clear write-up, and job/7 has no
// open pull request when a push lists them. The expected lines are written by hand from the plan's
// delivery forms, card checks and wait reasons. Origin-lookup credential custody also uses an isolated
// builtin execution mock; the Windows executable cases retain their real missing-executable failures.

const PRE_APPROVED = 'a pre-approved run session ';
const UNAVAILABLE = `${PRE_APPROVED}could not read card 7: `;
const RUN_START = '2026-11-04T12:00:00Z';
const ORIGIN_URL = 'https://github.com/acme/widgets.git';
const ORIGIN_ID = 'R_kgDOwidgets';
const PUSH = 'git push -u origin job/7';
const CREATE = 'gh pr create --draft --title t --body-file b';
const CREATE_ONLY = `${PRE_APPROVED}opens a pull request only as \`gh pr create --draft --title <title> --body-file <path>\`, the title a letter or digit then letters, digits and . _ : / -, single-quoted with no ' or newline, or double-quoted with no ", $, backtick, backslash, ! or newline`;
const READY = 'gh pr ready 12';
const MERGE = 'gh pr merge --auto --squash --delete-branch 12';
const DELIVERY = [PUSH, CREATE, READY, MERGE];
const PR_VIEW = 'gh pr view 12 --json state,headRefName,baseRefName,headRepository,isCrossRepository,headRefOid';
const PR_LIST = 'gh pr list --head job/7 --state open --json number,isDraft,autoMergeRequest';
// The listing also names isCrossRepository after these fields, so the stand-in answers any call that starts with them.
const isPrList = (call) => call.startsWith(PR_LIST);
const isGh = (call) => call.startsWith('gh ');
const isGraphql = (call) => call.startsWith('gh api graphql');
const PINNED_PR_SELECTION = 'repository(owner:$owner,name:$name) { id pullRequest(number:$number) { number state headRefName baseRefName headRepository { id } isCrossRepository headRefOid isDraft autoMergeRequest { enabledAt } isInMergeQueue isMergeQueueEnabled } }';
const REQUIRED_BRANCH_READ = 'gh api repos/{owner}/{repo}/branches/main';
const REQUIRED_RULES_READ = 'gh api --paginate --slurp repos/{owner}/{repo}/rules/branches/main';
const REQUIRED_CHECKS_READ = 'gh pr checks 12 --required --json name,bucket,link';
const CHECKED_SQUASH_READ = 'git --no-replace-objects rev-list --parents -n 1 HEAD';

// The saved write-up of HEAD, in the pull request template's grammar: clear (body B of the plan), and one edit of it
// per wait reason. A screenshot's expected hash is git's own `hash-object --no-filters` output for its fixed contents.
// The clear write-up repeats merge-evidence.test.mjs's, since importing a test file would run its tests here too, and
// adds the Reviewed commit line a Herdr publication reads.
const WAIT_KEYS = ['check', 'screenshot', 'beyond-card', 'sign-off', 'hard-to-undo'];
const HEAD_COMMIT = '5ca1ab1e'.repeat(5);
const REVIEW_FOLDER = `.claude/worklog/job_7-review-${HEAD_COMMIT}`;
// An earlier head of job/7, the version an owner answer can name.
const ANSWERED_COMMIT = 'a11ce5ed'.repeat(5);
// The commit deliver.md's squash makes on fetched main from HEAD_COMMIT, the version its decision card shows.
const SQUASH_COMMIT = '50fa5e1f'.repeat(5);
const REVIEW_LINE = 'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0';
const UNDO_EASY = 'Undo: easy, a later commit reverts it.';
const UNDO_HARD = 'Undo: hard, a published tag cannot be withdrawn.';
const CLEAR = [
  '## Not done', '', 'Nothing', '',
  '## Merge Danger', '', UNDO_EASY, 'Reach: narrow, one file.', '',
  '## Evidence', '', 'no visual change', '', 'Passed: focused tests and lint.', 'Failed: none', 'Untested: none',
  `Reviewed commit: ${HEAD_COMMIT}`, '',
  '## Review', '', REVIEW_LINE, '',
].join('\n');
const edit = (body, from, to) => {
  assert.ok(body.includes(from), `the write-up holds ${from}`);
  return body.replace(from, to);
};
const ON_SCREEN = edit(CLEAR, 'no visual change\n\n', '');
const SHOT_1 = 'Screenshot 1 of the logo in the header.\n';
const SHOT_1_HASH = '92e211a8620359c126ec6fa690ac2e18323cecc8';
// Git's blob hash of `text`, as `hash-object --no-filters` prints it: the sha1 of `blob <byte length>\0<bytes>`.
// blobHash(SHOT_1) equals SHOT_1_HASH, Git's own output, which pins the formula.
const blobHash = (text) => {
  const bytes = Buffer.from(text);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const image = (alt, at) => `![${alt}](https://github.com/user-attachments/assets/${at})`;
// The published body of work on screen whose one screenshot is attached, so no screenshot reason holds.
const ATTACHED_BODY = edit(ON_SCREEN, '## Evidence\n\n', `## Evidence\n\n${image(`screenshot-1 ${SHOT_1_HASH}`, 'a1')}\n`);
// A card's labels as the card read answers them, on one page.
const labelsOf = (...names) => ({ pageInfo: { hasNextPage: false }, nodes: names.map((name) => ({ name })) });

// A session directory holding `files` in the review folder of HEAD and, given `answered`, those files in the review
// folder of ANSWERED_COMMIT; `cleanup` registers its removal.
function sessionDirectory(files, cleanup, answered) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pre-approved-session-')));
  cleanup(() => rmSync(cwd, { recursive: true, force: true }));
  const folders = [[REVIEW_FOLDER, files], ...(answered === undefined ? [] : [[`.claude/worklog/job_7-review-${ANSWERED_COMMIT}`, answered]])];
  for (const [folder, held] of folders) {
    mkdirSync(join(cwd, folder), { recursive: true });
    for (const [name, text] of Object.entries(held)) writeFileSync(join(cwd, folder, name), text);
  }
  return cwd;
}
const CLEAR_SESSION = sessionDirectory({ 'body.md': CLEAR }, after);
// merge-evidence.mjs loads in place beside this file, so the checkout holding the running code is read through
// this directory, never the session checkout.
const CODE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
// A card comment as the card read answers it, never edited, so with no editor. The fixture's card holds the acting
// account's own claim, made during the run.
const cardComment = (login, createdAt, body) => ({ author: { login }, editor: null, createdAt, lastEditedAt: null, url: 'https://github.com/acme/widgets/issues/7#issuecomment-1', body });
const claimBy = (login, createdAt) => cardComment(login, createdAt, `Claim: fixture-machine, claude, ${createdAt}`);
const OWN_CLAIM = claimBy('owner', '2026-11-04T12:05:00Z');

function preApprovedRun({
  start = RUN_START,
  tracker = 'github',
  boundCard,
  env = {},
  branch = 'job/7',
  pushUrls = `${ORIGIN_URL}\n`,
  originPush = { status: 1, message: 'Command failed: git config --get-all remote.origin.push' },
  mergeBase = { status: 1, message: 'Command failed: git config --get branch.job/7.gh-merge-base' },
  unscopedId = ORIGIN_ID,
  repository = {},
  pullRequest = {},
  pinnedPull,
  pinnedNumber = 12,
  gitTop,
  objectFormat = 'sha1',
  requiredChecks = [{ name: 'test', bucket: 'pass', link: 'https://github.com/acme/widgets/actions/runs/1' }],
  localHead = HEAD_COMMIT,
  pinnedReads,
  issue = {},
  comments = [OWN_CLAIM],
  viewer = 'owner',
  repositoryId = ORIGIN_ID,
  graphqlError,
  settingOid = 'a'.repeat(40),
  settingMode = '100644\n',
  settingText = '{"version":1,"waitForOwner":"when-needed"}',
  settingError,
  ancestry,
  sessionAncestry,
  answeredAncestor,
  squash,
  cwd = CLEAR_SESSION,
  pullBody = CLEAR,
  openPulls = [],
  platform = 'linux',
} = {}) {
  const calls = [];
  // Given `squash`, its commit defaults to SQUASH_COMMIT, and it sets parents, tree and ORIG_HEAD: ORIG_HEAD is HEAD_COMMIT (null for
  // none) and no ref is named ORIG_HEAD, the one parent is fetched main, both trees are equal and the first parent is an
  // ancestor of ORIG_HEAD, and the checkout is armed and clean: core.hooksPath is .githooks (null for unset), HEAD's
  // .githooks is fetched main's, .githooks has no change and the session user may execute its pre-push, unless it says
  // otherwise; those two describe the .githooks at the worktree top, `top`, which is `cwd` unless it says otherwise.
  // Below the top, `cwd`'s own .githooks is clean and executable, and a status pathspec reads as Git reads it: `.githooks`
  // from `cwd`, the absolute `<top>/.githooks` as the top's, and `:/.githooks` as the top's unless GIT_LITERAL_PATHSPECS
  // in `env`, the environment the guard runs git with, makes it a literal name no file has. Each object read carries
  // --no-replace-objects, so an object read without it is an unexpected read.
  // Fetched main's .githooks tree is `mainHooks`, [mode, type, oid, name] entries; the top's folder on disk is
  // `topHooks`, the { name, file, executable } entries a recursive walk that follows no symbolic link gives, `file` false
  // for an entry that is neither a regular file nor a folder and `executable` by default whether fetched main's mode for
  // that name is 100755; and `edited` names the top's files whose bytes differ from fetched main's, by default those
  // githooksStatus reports modified, so a same-size edit the index reports clean sets it alone. As Git does, an ls-tree
  // without --full-tree from a `cwd` below the top lists only that folder's part of the tree, which holds nothing here.
  const squashed = squash === undefined ? undefined : {
    commit: SQUASH_COMMIT, origHead: HEAD_COMMIT, origHeadRefs: '', parents: [settingOid], trees: ['d'.repeat(40), 'd'.repeat(40)], ancestor: true,
    hooksPath: '.githooks', githooks: ['c'.repeat(40), 'c'.repeat(40)], githooksStatus: '', indexTag: 'H', fsmonitor: false, prePushExecutable: true, top: cwd,
    mainHooks: [['100755', 'blob', '5'.repeat(40), 'pre-push']], topHooks: [{ name: 'pre-push', file: true }], ...squash,
  };
  if (squashed !== undefined && squashed.edited === undefined) {
    squashed.edited = [...squashed.githooksStatus.matchAll(/^ M \.githooks\/(.+)$/gm)].map(([, name]) => name);
  }
  // The executable probe: whether the session user may execute a file, asked only of a pre-push by its absolute path.
  const executable = (path) => {
    calls.push(`executable ${path}`);
    if (squashed !== undefined && path === join(squashed.top, '.githooks', 'pre-push')) return squashed.prePushExecutable;
    if (squashed !== undefined && path === join(cwd, '.githooks', 'pre-push')) return true;
    throw new Error(`unexpected read: executable ${path}`);
  };
  // The hooks folder walk, asked of a .githooks folder by its absolute path; `cwd`'s own below the top is fetched main's.
  const mainExecutable = (name) => squashed.mainHooks.some(([mode, , , listed]) => listed === name && mode === '100755');
  const listHooks = (folder) => {
    calls.push(`listHooks ${folder}`);
    if (squashed !== undefined && folder === join(squashed.top, '.githooks')) return squashed.topHooks.map((entry) => ({ executable: mainExecutable(entry.name), ...entry }));
    if (squashed !== undefined && folder === join(cwd, '.githooks')) return squashed.mainHooks.map(([, , , name]) => ({ name, file: true, executable: mainExecutable(name) }));
    throw new Error(`unexpected read: listHooks ${folder}`);
  };
  const git = (args) => {
    const call = `git ${args.join(' ')}`;
    // Legacy setting-read assertions that filter `git rev-parse` see only the fetched-main pin.
    if (call === 'git rev-parse HEAD') {
      pinnedReads?.push(call);
      return `${localHead}\n`;
    }
    calls.push(call);
    if (pinnedReads && call === 'git rev-parse --show-toplevel') return `${gitTop ?? squashed?.top ?? cwd}\n`;
    if (pinnedReads && call === 'git rev-parse --show-object-format') return `${objectFormat}\n`;
    // Git hashes the raw bytes of each top hook file under --no-filters, in the order given: fetched main's oid unless
    // `edited` names it.
    if (squashed !== undefined && call.startsWith('git hash-object --no-filters -- ')) {
      const folder = `${join(squashed.top, '.githooks')}${sep}`;
      const paths = args.slice(3);
      if (paths.every((path) => path.startsWith(folder))) {
        return paths.map((path) => {
          const name = path.slice(folder.length).split(sep).join('/');
          const entry = squashed.mainHooks.find(([, , , listed]) => listed === name);
          if (entry === undefined) throw new Error(`unexpected read: ${call}`);
          return `${squashed.edited.includes(name) ? '6'.repeat(40) : entry[2]}\n`;
        }).join('');
      }
    }
    if (args[0] === 'hash-object' && args.includes('--no-filters')) {
      return args.slice(1).filter((arg) => arg !== '--no-filters' && arg !== '--').map((path) => `${blobHash(readFileSync(resolve(cwd, path)))}\n`).join('');
    }
    // Git exits 0 with no output where ANSWERED_COMMIT is an ancestor of HEAD, and 1 where it is not.
    if (answeredAncestor !== undefined && call === `git merge-base --is-ancestor ${ANSWERED_COMMIT} ${HEAD_COMMIT}`) {
      if (answeredAncestor) return '';
      throw Object.assign(new Error(`Command failed: ${call}`), { status: 1 });
    }
    if (squashed !== undefined) {
      if (call === 'git --no-replace-objects for-each-ref --format=%(refname) refs/ORIG_HEAD refs/tags/ORIG_HEAD refs/heads/ORIG_HEAD refs/remotes/ORIG_HEAD refs/remotes/ORIG_HEAD/HEAD') return squashed.origHeadRefs;
      if (call === 'git --no-replace-objects rev-parse --verify --quiet ORIG_HEAD^{commit}') {
        if (squashed.origHead === null) throw Object.assign(new Error(`Command failed: ${call}`), { status: 1 });
        return `${squashed.origHead}\n`;
      }
      if (call === CHECKED_SQUASH_READ) return `${[squashed.commit, ...squashed.parents].join(' ')}\n`;
      if (call === 'git --no-replace-objects rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return `${settingOid}\n`;
      if (call === `git --no-replace-objects rev-parse HEAD^{tree} ${squashed.origHead}^{tree}`) return `${squashed.trees.join('\n')}\n`;
      if (call === `git --no-replace-objects merge-base --is-ancestor ${squashed.parents[0]} ${squashed.origHead}`) {
        if (squashed.ancestor) return '';
        throw Object.assign(new Error(`Command failed: ${call}`), { status: 1 });
      }
      // Git ends the value with one NUL under --null, and exits 1 with no output where the key is unset.
      if (call === 'git config --null --get core.hooksPath') {
        if (squashed.hooksPath === null) throw Object.assign(new Error(`Command failed: ${call}`), { status: 1 });
        return `${squashed.hooksPath}\0`;
      }
      if (call === 'git --no-replace-objects rev-parse HEAD:.githooks refs/remotes/origin/main:.githooks') return `${squashed.githooks.join('\n')}\n`;
      if (call === 'git rev-parse --show-toplevel') return `${squashed.top}\n`;
      // Git ends each entry `<mode> <type> <oid>\t<name>` with a NUL under -z.
      if (`git ${args.filter((arg) => arg !== '--full-tree').join(' ')}` === 'git --no-replace-objects ls-tree -r -z refs/remotes/origin/main:.githooks') {
        if (!args.includes('--full-tree') && cwd !== squashed.top) return '';
        return squashed.mainHooks.map(([mode, type, oid, name]) => `${mode} ${type} ${oid}\t${name}\0`).join('');
      }
      // As Git does: an assume-unchanged or skip-worktree entry, and a core.fsmonitor that reports no change, hide an edit
      // from status, and `-c core.fsmonitor=false` makes the status read ask the file system itself; `ls-files -v` tags
      // an entry `h` for assume-unchanged, `S` for skip-worktree and `H` otherwise.
      const status = call.replace('git -c core.fsmonitor=false status', 'git status');
      const hidden = squashed.indexTag !== 'H' || (squashed.fsmonitor && status === call);
      const statusOf = (text) => (hidden ? '' : text);
      if (status === 'git status --porcelain --untracked-files=all -- .githooks') return cwd === squashed.top ? statusOf(squashed.githooksStatus) : '';
      if (status === 'git status --porcelain --untracked-files=all -- :/.githooks') return env.GIT_LITERAL_PATHSPECS === '1' ? '' : statusOf(squashed.githooksStatus);
      if (status === `git status --porcelain --untracked-files=all -- ${join(squashed.top, '.githooks')}`) return statusOf(squashed.githooksStatus);
      if (call === `git ls-files -v -- ${join(squashed.top, '.githooks')}`) return `${squashed.indexTag} .githooks/pre-push\n`;
    }
    if (call === 'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}') {
      if (settingError === 'ref') throw new Error('synthetic-setting-secret https://synthetic.invalid/private');
      return `${settingOid}\n`;
    }
    if (call === `git ls-tree --full-tree --format=%(objectmode) ${settingOid} -- .agents/factory-settings.json`) {
      if (settingError === 'tree') throw new Error('synthetic-setting-secret https://synthetic.invalid/private');
      return settingMode;
    }
    if (call === `git show ${settingOid}:.agents/factory-settings.json`) {
      if (settingError === 'blob') throw new Error('synthetic-setting-secret https://synthetic.invalid/private');
      return settingText;
    }
    if (call === 'git symbolic-ref --quiet --short HEAD') return `${branch}\n`;
    if (call === 'git remote get-url --push --all origin') return pushUrls;
    if (call === 'git remote get-url origin') return `${ORIGIN_URL}\n`;
    // Git prints each value it holds, and exits 1 with no output where the key is unset.
    if (call === 'git config --get-all remote.origin.push') {
      if (typeof originPush === 'string') return originPush;
      throw Object.assign(new Error(originPush.message), { status: originPush.status });
    }
    if (call === `git config --get branch.${branch}.gh-merge-base`) {
      if (typeof mergeBase === 'string') return mergeBase;
      throw Object.assign(new Error(mergeBase.message), { status: mergeBase.status });
    }
    // The answer of the code checkout and that of the session checkout, so a read in the wrong checkout gets the wrong one.
    if (ancestry !== undefined && call === `git -C ${CODE_DIRECTORY} rev-list --left-right --count HEAD...${settingOid}`) return ancestry;
    if (sessionAncestry !== undefined && call === `git rev-list --left-right --count HEAD...${settingOid}`) return sessionAncestry;
    throw new Error(`unexpected read: ${call}`);
  };
  const exec = (args) => {
    const call = `gh ${args.join(' ')}`;
    calls.push(call);
    if (call === `gh repo view --json id,nameWithOwner,defaultBranchRef -- ${ORIGIN_URL}`) return JSON.stringify({ id: ORIGIN_ID, nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' }, ...repository });
    if (call === 'gh repo view --json id') return JSON.stringify({ id: unscopedId });
    if (call === PR_VIEW) {
      return JSON.stringify({ state: 'OPEN', headRefName: 'job/7', baseRefName: 'main', headRepository: { id: ORIGIN_ID, name: 'widgets' }, isCrossRepository: false, headRefOid: HEAD_COMMIT, ...pullRequest });
    }
    if (call === `gh pr view ${pinnedNumber} --json body`) {
      if (pullBody instanceof Error) throw pullBody;
      return JSON.stringify({ body: pullBody });
    }
    if (isPrList(call)) {
      if (openPulls instanceof Error) throw openPulls;
      return JSON.stringify(openPulls);
    }
    if (pinnedPull !== undefined) {
      if (call === REQUIRED_BRANCH_READ) return JSON.stringify({ protection: { required_status_checks: { contexts: ['test'] } } });
      if (call === REQUIRED_RULES_READ) return JSON.stringify([[]]);
      if (call === `gh pr checks ${pinnedNumber} --required --json name,bucket,link`) return JSON.stringify(requiredChecks);
    }
    if (isGraphql(call)) {
      if (pinnedReads) {
        const query = args[3]?.replace(/\s/g, '') ?? '';
        const variables = (number) => args.length === 10
          && args.slice(0, 3).join(' ') === 'api graphql -f'
          && args.slice(4).join(' ') === `-f owner=acme -f name=widgets -F number=${number}`;
        const selection = PINNED_PR_SELECTION.replace(/\s/g, '');
        if (pinnedPull !== undefined && variables(pinnedNumber) && query.replace(/^query=query[^{]*\{/, '').replace('baseRefOid', '') === `${selection}}`) {
          if (pinnedPull instanceof Error) throw pinnedPull;
          return JSON.stringify({ data: { repository: { id: repository.id ?? ORIGIN_ID, pullRequest: pinnedPull } } });
        }
        if (!variables(7) || !query.includes('issue(number:$number){')) throw new Error(`unexpected read: ${call}`);
      }
      if (graphqlError) throw new Error(graphqlError);
      return JSON.stringify({
        data: {
          viewer: { login: viewer },
          repository: {
            id: repositoryId,
            issue: {
              state: 'OPEN',
              title: 'Show the logo',
              lastEditedAt: null,
              labels: labelsOf(),
              ...issue,
              comments: { pageInfo: { hasNextPage: false }, nodes: comments },
            },
          },
        },
      });
    }
    throw new Error(`unexpected read: ${call}`);
  };
  return { calls, cwd, preApproved: { start, tracker, boundCard, env, exec, git, executable, listHooks, platform } };
}

const judged = (command, fixture, options = {}) => {
  const run = preApprovedRun(fixture);
  return { reason: blockReason(command, { ...inJob, cwd: run.cwd }, { preApproved: run.preApproved, ...options }), calls: run.calls };
};

test('ANTI-REGRESSION: a pre-approved run session publishes the delivery forms of its own card with no approval record while fetched main sets waitForOwner to when-needed', () => {
  // The card holds no approval record, only the run's own claim, and the saved write-up of HEAD holds no wait reason.
  for (const command of DELIVERY) {
    assert.equal(judged(command).reason, '', command);
    // The card read stays: a card it cannot read, a closed card or a proposal publishes nothing.
    const unread = judged(command, { graphqlError: 'HTTP 502: Bad Gateway' }).reason;
    assert.ok(unread.startsWith(PRE_APPROVED) && unread.endsWith('HTTP 502: Bad Gateway'), `${command}: ${JSON.stringify(unread)}`);
    const ineligible = {
      'a closed card': [{ issue: { state: 'CLOSED' } }, 'the card is closed'],
      'a proposed card': [{ issue: { title: 'Proposed: Show the logo' } }, 'the card is still a proposal'],
    };
    for (const [label, [fixture, why]] of Object.entries(ineligible)) {
      const { reason } = judged(command, fixture);
      assert.ok(reason.startsWith(PRE_APPROVED) && reason.endsWith(why), `${command}, ${label}: ${JSON.stringify(reason)}`);
    }
    for (const start of ['', '2026-11-04 12:00:00']) {
      const { reason, calls } = judged(command, { start });
      assert.ok(reason.startsWith(PRE_APPROVED), `${command}, mark ${JSON.stringify(start)}: ${JSON.stringify(reason)}`);
      assert.deepEqual(calls, [], `${command}, mark ${JSON.stringify(start)}`);
    }
    const onMain = judged(command, { branch: 'main' });
    assert.ok(onMain.reason.startsWith(PRE_APPROVED), `${command}, on main: ${JSON.stringify(onMain.reason)}`);
    assert.deepEqual(onMain.calls.filter(isGh), [], `${command}, on main`);
  }
  for (const command of [READY, MERGE]) {
    const { reason, calls } = judged(command, { pullRequest: { headRefName: 'job/8' } });
    assert.ok(reason.startsWith(PRE_APPROVED), `${command}, head job/8: ${JSON.stringify(reason)}`);
    assert.deepEqual(calls.filter(isGraphql), [], `${command}, head job/8`);
  }
  const moved = judged('cd ../8 && git push -u origin job/8');
  assert.ok(moved.reason.startsWith(PRE_APPROVED), JSON.stringify(moved.reason));
  assert.deepEqual(moved.calls, []);
  const otherBranch = judged('git push -u origin job/9');
  assert.ok(otherBranch.reason.startsWith(PRE_APPROVED), JSON.stringify(otherBranch.reason));
  assert.deepEqual(otherBranch.calls.filter(isGh), []);
});

// A reason is named when its key stands on its own, so `check` inside `checked` or `checkout` names nothing.
const namesReason = (reason, key) => new RegExp(`(?<![\\w-])${key}(?![\\w-])`).test(reason);

test('ANTI-REGRESSION: a pre-approved run session marks ready or merges nothing while a wait reason holds for its head, and the refusal names each reason', (t) => {
  const cleanup = (remove) => t.after(remove);
  const allFive = [
    ['Failed: none', 'Failed: lint, cause unknown'],
    ['no visual change\n\n', ''],
    ['Nothing', '- The Windows suite was skipped.'],
    ['tier=code', 'tier=sign-off'],
    [UNDO_EASY, UNDO_HARD],
  ].reduce((body, [from, to]) => edit(body, from, to), CLEAR);
  const holding = [
    ['a failed check', { 'body.md': edit(CLEAR, 'Failed: none', 'Failed: lint, cause unknown') }, ['check']],
    ['work on screen with no screenshot', { 'body.md': ON_SCREEN }, ['screenshot']],
    ['a screenshot not attached to the pull request', { 'body.md': ON_SCREEN, 'screenshot-1.png': SHOT_1 }, ['screenshot']],
    ['a Not done item', { 'body.md': edit(CLEAR, 'Nothing', '- The Windows suite was skipped.') }, ['beyond-card']],
    ['a sign-off review tier', { 'body.md': edit(CLEAR, 'tier=code', 'tier=sign-off') }, ['sign-off']],
    ['an Undo answer of hard', { 'body.md': edit(CLEAR, UNDO_EASY, UNDO_HARD) }, ['hard-to-undo']],
    ['all five', { 'body.md': allFive }, WAIT_KEYS],
  ];
  for (const [label, files, held] of holding) {
    const cwd = sessionDirectory(files, cleanup);
    for (const command of [READY, MERGE]) {
      const { reason } = judged(command, { cwd });
      assert.ok(reason.startsWith(PRE_APPROVED), `${label}, ${command}: ${JSON.stringify(reason)}`);
      assert.deepEqual(WAIT_KEYS.filter((key) => namesReason(reason, key)), held, `${label}, ${command}: ${JSON.stringify(reason)}`);
    }
  }
  const attached = sessionDirectory({ 'body.md': ON_SCREEN, 'screenshot-1.png': SHOT_1 }, cleanup);
  for (const command of [READY, MERGE]) {
    assert.equal(judged(command).reason, '', command);
    assert.equal(judged(command, { cwd: attached, pullBody: ATTACHED_BODY }).reason, '', command);
  }
});

test('ANTI-REGRESSION: a pre-approved run session marks ready or merges nothing while its published pull request body holds a wait reason', (t) => {
  // The saved write-up of HEAD is clear in each case unless a case gives its own; the published body is what differs.
  const published = [
    ['a failed check', edit(CLEAR, 'Failed: none', 'Failed: lint, cause unknown'), ['check']],
    ['an untested item', edit(CLEAR, 'Untested: none', 'Untested: Windows runner'), ['check']],
    ['work on screen with no screenshot', ON_SCREEN, ['screenshot']],
    ['a Not done item', edit(CLEAR, 'Nothing', '- The Windows suite was skipped.'), ['beyond-card']],
    ['a sign-off review tier', edit(CLEAR, 'tier=code', 'tier=sign-off'), ['sign-off']],
    ['an Undo answer of hard', edit(CLEAR, UNDO_EASY, UNDO_HARD), ['hard-to-undo']],
  ];
  const localHard = sessionDirectory({ 'body.md': edit(CLEAR, UNDO_EASY, UNDO_HARD) }, (remove) => t.after(remove));
  for (const command of [READY, MERGE]) {
    for (const [label, pullBody, held] of published) {
      const { reason, calls } = judged(command, { pullBody });
      assert.ok(reason.startsWith(PRE_APPROVED), `${label}, ${command}: ${JSON.stringify(reason)}`);
      assert.deepEqual(WAIT_KEYS.filter((key) => namesReason(reason, key)), held, `${label}, ${command}: ${JSON.stringify(reason)}`);
      assert.equal(calls.filter((call) => call === 'gh pr view 12 --json body').length, 1, `${label}, ${command}: the body is read once`);
    }
    // The held reasons are the union of the two, in WAIT_REASONS order.
    const both = judged(command, { cwd: localHard, pullBody: published[0][1] }).reason;
    assert.ok(both.startsWith(PRE_APPROVED) && both.endsWith(': check, hard-to-undo'), `${command}, both: ${JSON.stringify(both)}`);
    // A published body the judge cannot read, or cannot fetch, refuses and names the cause.
    const unreadable = judged(command, { pullBody: edit(CLEAR, 'Failed: none\n', '') }).reason;
    assert.equal(unreadable, `${PRE_APPROVED}publishes nothing: the published body of pull request #12 has no Failed: line`, command);
    const unfetched = judged(command, { pullBody: new Error('HTTP 502: Bad Gateway') }).reason;
    assert.equal(unfetched, `${PRE_APPROVED}publishes nothing: could not read the published body of pull request #12: HTTP 502: Bad Gateway`, command);
  }
});

test('ANTI-REGRESSION: a pre-approved run session pushes nothing while its pull request is ready or has a merge queued', () => {
  // GitHub keeps a queued auto-merge after a push by someone with write access, so the pushed commit would merge unjudged.
  const QUEUED = { enabledAt: '2026-11-04T13:00:00Z', mergeMethod: 'SQUASH' };
  const REFUSED = `${PRE_APPROVED}pushes nothing while pull request #12 is ready or has a merge queued, since GitHub would merge the pushed commit unjudged: take it back to draft with \`gh pr ready 12 --undo\` first, and where its merge stays queued the owner turns it off with \`gh pr merge --disable-auto 12\``;
  for (const command of [PUSH, 'git push --force-with-lease origin job/7']) {
    for (const pull of [{ isDraft: false, autoMergeRequest: null }, { isDraft: false, autoMergeRequest: QUEUED }, { isDraft: true, autoMergeRequest: QUEUED }]) {
      assert.equal(judged(command, { openPulls: [{ number: 12, isCrossRepository: false, ...pull }] }).reason, REFUSED, `${command}, ${JSON.stringify(pull)}`);
    }
    // The first push, before any pull request exists, and a push to a draft with nothing queued are admitted.
    for (const openPulls of [[], [{ number: 12, isDraft: true, autoMergeRequest: null, isCrossRepository: false }]]) {
      const { reason, calls } = judged(command, { openPulls });
      assert.equal(reason, '', `${command}, ${JSON.stringify(openPulls)}`);
      assert.ok(calls.some(isPrList), `${command}: ${JSON.stringify(calls)}`);
    }
    // A pull request from a fork with the same head name cannot be updated by this push, so it never refuses it.
    const own = { number: 12, isDraft: true, autoMergeRequest: null, isCrossRepository: false };
    const fork = { number: 31, isDraft: false, autoMergeRequest: null, isCrossRepository: true };
    for (const openPulls of [[fork], [fork, own], [{ ...fork, autoMergeRequest: QUEUED }, own]]) {
      const { reason, calls } = judged(command, { openPulls });
      assert.equal(reason, '', `${command}, ${JSON.stringify(openPulls)}`);
      assert.ok(calls.some((call) => isPrList(call) && call.includes('isCrossRepository')), `${command}: ${JSON.stringify(calls)}`);
    }
    // This repository's own ready pull request still refuses, whichever order it is listed in beside a fork's draft.
    const forkDraft = { ...fork, number: 31, isDraft: true };
    for (const openPulls of [[{ ...own, isDraft: false }, forkDraft], [forkDraft, { ...own, isDraft: false }]]) {
      assert.equal(judged(command, { openPulls }).reason, REFUSED, `${command}, ${JSON.stringify(openPulls)}`);
    }
    // A list it cannot read refuses, as other read failures do.
    const unread = {
      'a failed read': new Error('HTTP 502: Bad Gateway'),
      'a pull request with no draft state': [{ number: 12 }],
      'a reply that is no list': { number: 12 },
      'a pull request with no cross-repository state': [{ number: 12, isDraft: true, autoMergeRequest: null }],
    };
    for (const [label, openPulls] of Object.entries(unread)) {
      const { reason } = judged(command, { openPulls });
      assert.ok(reason.startsWith(`${PRE_APPROVED}publishes nothing: `), `${command}, ${label}: ${JSON.stringify(reason)}`);
    }
    // gh lists 30 by default, and --head matches a branch name in any repository, so forks could push the run's own queued
    // pull request out of the reply: the listing asks for 100 and a reply of 100 may be cut short, so it is unreadable.
    const drafts = (count) => Array.from({ length: count }, (_, index) => ({ number: 100 + index, isDraft: true, autoMergeRequest: null, isCrossRepository: true }));
    assert.ok(judged(command, { openPulls: [] }).calls.some((call) => isPrList(call) && call.includes(' --limit 100')), `${command}: the listing names --limit 100`);
    const cutShort = judged(command, { openPulls: drafts(100) }).reason;
    assert.ok(cutShort.startsWith(`${PRE_APPROVED}publishes nothing: `), `${command}, 100 pull requests: ${JSON.stringify(cutShort)}`);
    assert.equal(judged(command, { openPulls: drafts(99) }).reason, '', `${command}, 99 pull requests`);
  }
});

test('ANTI-REGRESSION: a pre-approved run session publishes only a card whose newest claim its GitHub account made during the run', () => {
  // The owner's answer "Yes, only its own": a session that strays onto another card's branch, or a card claimed before
  // the run started, publishes nothing and waits for the owner's yes. The acting account is owner; the run started at RUN_START.
  const ONLY_OWN = `${PRE_APPROVED}publishes only a card its GitHub account claimed during this run, and`;
  const WAITS = "so the card waits for the owner's yes";
  const refused = {
    'no claim': [[cardComment('owner', '2026-11-04T12:01:00Z', 'Building this now.')], `${ONLY_OWN} card 7 has no Claim comment, ${WAITS}`],
    'the newest claim by another account': [[claimBy('bob', '2026-11-04T12:05:00Z')], `${ONLY_OWN} the newest claim on card 7 was made by bob, not owner, ${WAITS}`],
    'the newest claim made before the run start': [[claimBy('owner', '2026-11-04T11:59:59Z')], `${ONLY_OWN} the newest claim on card 7 was made at 2026-11-04T11:59:59Z, not at or after this run's start at ${RUN_START}, ${WAITS}`],
    'an own claim followed by a newer claim by another account': [[claimBy('owner', '2026-11-04T12:05:00Z'), claimBy('bob', '2026-11-04T12:10:00Z')], `${ONLY_OWN} the newest claim on card 7 was made by bob, not owner, ${WAITS}`],
  };
  for (const command of [PUSH, READY]) {
    for (const [label, [comments, reason]] of Object.entries(refused)) {
      assert.equal(judged(command, { comments }).reason, reason, `${command}, ${label}`);
    }
    assert.equal(judged(command, { comments: [claimBy('owner', RUN_START)] }).reason, '', `${command}, an own claim at the run start exactly`);
  }
});

test("ANTI-REGRESSION: a lead's continue, bound to its card under an earlier run's start, publishes only that card", () => {
  // A continue runs under the start of the run that claimed its card, 2026-11-01, and the fixture's claim is at 11-04.
  // The binding is the card the continue's phase names; every read in the fixture names card 7, the card of job/7.
  const start = '2026-11-01T09:00:00Z';
  const BOUND = `${PRE_APPROVED}publishes only its bound card`;
  for (const command of DELIVERY) {
    assert.equal(judged(command, { start }).reason, '', `${command}, no binding`);
    assert.equal(judged(command, { start, boundCard: '7' }).reason, '', `${command}, bound to card 7`);
    // A binding that is any other card, or no card number as the guard reads one, refuses before any gh call.
    for (const boundCard of ['8', '', '07', 'job/7']) {
      const { reason, calls } = judged(command, { start, boundCard });
      assert.equal(reason, BOUND, `${command}, bound to ${JSON.stringify(boundCard)}`);
      assert.deepEqual(calls.filter(isGh), [], `${command}, bound to ${JSON.stringify(boundCard)}`);
    }
  }
});

test('a pre-approved run session refuses a ready, merge, create or assignment-led form outside its delivery form before any read', () => {
  const MERGE_FORM = 'merges only with `gh pr merge --auto --squash --delete-branch <number>`';
  const ASSIGNMENT_FORM = 'publishes only a plain command, with no assignment before it';
  const outside = {
    'gh pr merge 8 --admin': `${PRE_APPROVED}${MERGE_FORM}`,
    'gh pr merge --auto --squash 8': `${PRE_APPROVED}${MERGE_FORM}`,
    'gh pr ready 8 --admin': `${PRE_APPROVED}marks ready only with \`gh pr ready <number>\`, with or without --undo`,
    'gh pr create -R x/y --draft --title t --body-file b': CREATE_ONLY,
    'gh pr create --repo x/y --draft --title t --body-file b': CREATE_ONLY,
    'gh pr create --head other --draft --title t --body-file b': CREATE_ONLY,
    'gh pr create -B release --draft --title t --body-file b': CREATE_ONLY,
    'gh pr create --base release --draft --title t --body-file b': CREATE_ONLY,
    'gh pr create --draft --base=release --title t --body-file b': CREATE_ONLY,
    'FOO=1 gh pr create --draft --title t --body-file b': `${PRE_APPROVED}${ASSIGNMENT_FORM}`,
    'FOO=1 gh pr ready 8': `${PRE_APPROVED}${ASSIGNMENT_FORM}`,
    'FOO=1 git push -u origin job/7': `${PRE_APPROVED}${ASSIGNMENT_FORM}`,
  };
  for (const [command, reason] of Object.entries(outside)) {
    const judgement = judged(command);
    assert.equal(judgement.reason, reason, command);
    assert.deepEqual(judgement.calls, [], command);
  }
});

test('ANTI-REGRESSION: a merge or ready captured by a leading assignment is refused in every session, before any read', () => {
  const forms = [
    ['out=$(gh pr merge --auto --squash --delete-branch 12)', REASON_MERGE],
    ['out=`gh pr ready 12`', REASON_READY],
    ['x=$(gh pr merge --admin 12)', REASON_MERGE],
    ['FOO=1 x=$(gh pr merge --admin 12)', REASON_MERGE],
  ];
  for (const [command, refusal] of forms) {
    assert.equal(blockReason(command, inJob), refusal, command);
    const { reason, calls } = judged(command);
    assert.equal(reason, `${PRE_APPROVED}publishes only a plain command, with no assignment before it`, command);
    assert.deepEqual(calls, [], command);
  }
});

test('ANTI-REGRESSION: a pre-approved run session opens a pull request only into the default branch, refusing a configured gh merge base or bundled short flags', () => {
  const MERGE_BASE = `${PRE_APPROVED}opens a pull request only into the default branch, and branch.job/7.gh-merge-base is set: release`;
  assert.equal(judged(CREATE, { mergeBase: 'release\n' }).reason, MERGE_BASE);
  assert.equal(judged(CREATE).reason, '');
  assert.equal(judged(CREATE, { mergeBase: { status: 128, message: 'fatal: bad config line 3' } }).reason, `${PRE_APPROVED}publishes nothing: fatal: bad config line 3`);
  for (const command of [
    'gh pr create --draft -dB release --title t --body-file b',
    'gh pr create -dR other/repo --title t --body-file b',
    'gh pr create --draft -dBrelease --title t --body-file b',
    'gh pr create -fdB release --title t --body-file b',
    'gh pr create --draft -dH other:job/7 --title t --body-file b',
  ]) {
    const bundled = judged(command);
    assert.equal(bundled.reason, CREATE_ONLY, command);
    assert.deepEqual(bundled.calls, [], command);
  }
});

test('ANTI-REGRESSION: a pre-approved run session opens a pull request with no command or process substitution or heredoc in it, before any read', () => {
  const substituted = [
    'gh pr create --draft --title "$(gh repo set-default other/repo)" --body-file b',
    'gh pr create --draft --title "`gh repo set-default other/repo`" --body-file b',
    'gh pr create --draft --title t --body-file <(git switch job/9)',
    'gh pr create --draft --title t --body-file >(cat)',
    'gh pr create --draft --title t --body-file - <<EOF\n$(git switch job/9)\nEOF',
    'gh pr create --draft --title t --body-file - <<EOF\nplain body\nEOF',
    'gh pr create --draft --title t --body-file - <<EOF -R other/repo\nplain body\nEOF',
    'gh pr create --draft --title t --body-file - <<<"$(git switch job/9)"',
  ];
  for (const command of substituted) {
    const { reason, calls } = judged(command);
    assert.equal(reason, CREATE_ONLY, JSON.stringify(command));
    assert.deepEqual(calls, [], JSON.stringify(command));
  }
  // A single-quoted title is literal text, so it is part of the one allowed form.
  const literal = judged("gh pr create --draft --title '$(literal)' --body-file b");
  assert.equal(literal.reason, '');
  assert.ok(literal.calls.some(isGraphql), JSON.stringify(literal.calls));
  assert.equal(judged(CREATE).reason, '');
});

test('ANTI-REGRESSION: a pre-approved run session opens a pull request only in its one exact form, before any read', () => {
  const refused = [
    'gh pr create --draft "-B" release --title t --body-file b',
    "gh pr create --draft '-R' other/repo --title t --body-file b",
    'gh pr create --draft "--head=fork:job/7" --title t --body-file b',
    "gh pr create --draft ''-B release --title t --body-file b",
    'gh pr create --draft \\-B release --title t --body-file b',
    'gh pr create --draft {-B,release} --title t --body-file b',
    "gh pr create --draft $'-B' release --title t --body-file b",
    'gh pr create --draft "-dB" release --title t --body-file b',
    'gh pr create --draft -d"B" release --title t --body-file b',
    'gh pr create --draft --title "${ git switch job/9; printf t; }" --body-file b',
    'gh pr create --draft --title "${| gh repo set-default other/repo; }" --body-file b',
    'gh pr create --draft --title t --body-file =(gh repo set-default other/repo)',
    'gh pr new --draft -B release -R other/repo --title t --body-file b',
    'gh pr create --title t --body-file b --draft',
    'gh pr create -d --title t --body-file b',
    'gh pr create --draft --title t --body-file -',
    'gh pr create --draft --title t --body-file b -B release',
    'gh pr create --draft --title t --body-file b -R other/repo',
    'gh pr create --draft --title a#b --body-file b',
    'gh pr create --draft --title a#-#-Rother/repo --body-file b',
  ];
  for (const command of refused) {
    const { reason, calls } = judged(command);
    assert.equal(reason, CREATE_ONLY, JSON.stringify(command));
    assert.deepEqual(calls, [], JSON.stringify(command));
  }
  const admitted = [
    CREATE,
    "gh pr create --draft --title 'A plain title' --body-file b",
    'gh pr create --draft --title "The owner\'s card (#461): approve once" --body-file .claude/worklog/body.md',
  ];
  for (const command of admitted) {
    const { reason, calls } = judged(command);
    assert.equal(reason, '', JSON.stringify(command));
    assert.ok(calls.some(isGraphql), `${JSON.stringify(command)}: ${JSON.stringify(calls)}`);
  }
});

test('ANTI-REGRESSION: a pre-approved run session publishes only as a command on its own, so nothing before or after a delivery form can change where it goes, before any read', () => {
  const ALONE = `${PRE_APPROVED}publishes only as a command on its own, with nothing before or after it`;
  const chained = [
    `git remote set-url origin https://github.com/mirror/widgets.git && ${PUSH}`,
    `git config remote.origin.push refs/heads/job/7:refs/heads/main && ${PUSH}`,
    `git switch job/9 && ${PUSH}`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main; ${PUSH}`,
    `pushd /tmp/elsewhere && ${PUSH}`,
    `builtin cd /tmp/elsewhere && ${PUSH}`,
    `export GIT_COMMON_DIR=/tmp/elsewhere/.git && ${PUSH}`,
    `export GH_CONFIG_DIR=/tmp/elsewhere && ${CREATE}`,
    `export GH_TOKEN=other && ${MERGE}`,
    `false || ${READY}`,
    `git status\n${PUSH}`,
    `${PUSH} | cat`,
    `${PUSH} && echo pushed`,
    `${PUSH};`,
  ];
  for (const command of chained) {
    const { reason, calls } = judged(command);
    assert.equal(reason, ALONE, JSON.stringify(command));
    assert.deepEqual(calls, [], JSON.stringify(command));
  }
});

test('ANTI-REGRESSION: a pre-approved run session no coordinator started never pushes to main, even with a valid record, and pushes its own branch with --force-with-lease', () => {
  const toMain = judged('git push origin HEAD:main');
  assert.equal(toMain.reason, `${PRE_APPROVED}pushes only its own branch, as git push -u origin job/7 or git push --force-with-lease origin job/7`);
  assert.deepEqual(toMain.calls.filter(isGh), []);
  assert.equal(judged('git push --force-with-lease origin job/7').reason, '');
});

test('ANTI-REGRESSION: a pre-approved run session pushes nothing while remote.origin.push is set or unreadable, and pushes while it is unset', () => {
  const READ = 'git config --get-all remote.origin.push';
  const set = judged(PUSH, { originPush: 'refs/heads/job/7:refs/heads/main\n' });
  assert.equal(set.reason, `${PRE_APPROVED}pushes nothing while remote.origin.push is set, since it can send the push to another branch: refs/heads/job/7:refs/heads/main`);
  assert.deepEqual(set.calls.filter(isGraphql), []);
  const unreadable = judged(PUSH, { originPush: { status: 128, message: 'fatal: bad config line 3' } });
  assert.equal(unreadable.reason, `${PRE_APPROVED}publishes nothing: fatal: bad config line 3`);
  const unset = judged(PUSH);
  assert.equal(unset.reason, '');
  assert.ok(unset.calls.includes(READ), JSON.stringify(unset.calls));
});

test('a pre-approved run session refuses a command naming GH_REPO, GH_HOST, GIT_DIR or GIT_WORK_TREE, in any letter case, before any read', () => {
  const naming = {
    GH_REPO: `GH_REPO=x/y ${CREATE}`,
    GH_HOST: `GH_HOST=github.example.com ${MERGE}`,
    GIT_DIR: `GIT_DIR=/tmp/elsewhere/.git ${PUSH}`,
    GIT_WORK_TREE: `GIT_WORK_TREE=/tmp/elsewhere ${PUSH}`,
    git_dir: `git_dir=/tmp/elsewhere/.git ${PUSH}`,
  };
  for (const [name, command] of Object.entries(naming)) {
    const { reason, calls } = judged(command);
    assert.equal(reason, `${PRE_APPROVED}publishes nothing from a command naming ${name}, which can point git or gh away from origin`, command);
    assert.deepEqual(calls, [], command);
  }
});

test('a pre-approved run session refuses a command holding -C, --git-dir or --work-tree, before any read', () => {
  const HOLDS = `${PRE_APPROVED}publishes nothing from a command holding -C, --git-dir or --work-tree, which can move it out of its own working directory`;
  const holding = {
    'gh pr create --draft --title -C': CREATE_ONLY,
    'gh pr create --draft --title --git-dir': CREATE_ONLY,
    'gh pr create --draft --title --work-tree': CREATE_ONLY,
    'git -C . push -u origin job/7': HOLDS,
  };
  for (const [command, expected] of Object.entries(holding)) {
    const { reason, calls } = judged(command);
    assert.equal(reason, expected, command);
    assert.deepEqual(calls, [], command);
  }
});

test('ANTI-REGRESSION: a pre-approved run session publishes only to the origin repository and only where the tracker is GitHub issues', () => {
  for (const command of DELIVERY) {
    for (const [name, value] of [['GH_REPO', 'x/y'], ['GH_HOST', 'github.example.com']]) {
      const { reason, calls } = judged(command, { env: { [name]: value } });
      assert.ok(reason.startsWith(PRE_APPROVED) && reason.includes(name), `${command}, ${name}: ${JSON.stringify(reason)}`);
      assert.deepEqual(calls, [], `${command}, ${name}`);
    }
    const unsafeUrl = 'https://user:secret-token@github.com/o/r.git';
    const queryUrl = `${unsafeUrl}?token=query-secret`;
    const pushDestinations = [
      `${ORIGIN_URL}\nhttps://github.com/mirror/widgets.git\n`,
      'https://github.com/mirror/widgets.git\n',
      `${unsafeUrl}\n`,
      `${queryUrl}\n`,
      `${ORIGIN_URL}\n${unsafeUrl}\n`,
      `${ORIGIN_URL}\n${queryUrl}\n`,
    ];
    for (const pushUrls of pushDestinations) {
      const { reason, calls } = judged(command, { pushUrls });
      for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl, queryUrl]) {
        assert.ok(!reason.includes(secret), `${command}: remote credentials leaked in ${JSON.stringify(reason)}`);
      }
      assert.ok(reason.startsWith(PRE_APPROVED) && reason.includes('origin does not have exactly one push destination matching the repository it fetches from'), `${command}, ${JSON.stringify(pushUrls)}: ${JSON.stringify(reason)}`);
      assert.deepEqual(calls.filter(isGh), [], `${command}, ${JSON.stringify(pushUrls)}`);
    }
    assert.ok(
      judged(command, { pushUrls: pushDestinations[1] }).reason.includes('origin does not have exactly one push destination matching the repository it fetches from'),
      command,
    );
    const unscoped = judged(command, { unscopedId: 'R_kgDOother' });
    assert.ok(unscoped.reason.startsWith(PRE_APPROVED), `${command}, unscoped id: ${JSON.stringify(unscoped.reason)}`);
    assert.deepEqual(unscoped.calls.filter(isGraphql), [], `${command}, unscoped id`);
    const graphqlRepository = judged(command, { repositoryId: 'R_kgDOother' }).reason;
    assert.ok(graphqlRepository.startsWith(UNAVAILABLE), `${command}, GraphQL repository: ${JSON.stringify(graphqlRepository)}`);
    const jira = judged(command, { tracker: 'jira' });
    assert.ok(
      jira.reason.startsWith(PRE_APPROVED) && jira.reason.includes("a run needs GitHub issues; this repository's tracker is jira"),
      `${command}, jira: ${JSON.stringify(jira.reason)}`,
    );
    assert.deepEqual(jira.calls, [], `${command}, jira`);
  }
  const inline = judged(`GH_REPO=x/y ${CREATE}`);
  assert.ok(inline.reason.startsWith(PRE_APPROVED) && inline.reason.includes('GH_REPO'), JSON.stringify(inline.reason));
  assert.deepEqual(inline.calls, []);
  for (const command of [READY, MERGE]) {
    for (const pullRequest of [{ headRepository: { id: 'R_kgDOfork', name: 'widgets' } }, { isCrossRepository: true }]) {
      const { reason, calls } = judged(command, { pullRequest });
      assert.ok(reason.startsWith(PRE_APPROVED), `${command}, ${JSON.stringify(pullRequest)}: ${JSON.stringify(reason)}`);
      assert.deepEqual(calls.filter(isGraphql), [], `${command}, ${JSON.stringify(pullRequest)}`);
    }
  }
});

test('ANTI-REGRESSION: advance approval origin lookup errors keep remote credentials out of diagnostics', (t) => {
  const here = { cwd: process.cwd(), isRootCheckout: () => false, platform: process.platform };
  const BIN = 'C:\\fabraik-absent\\bin';
  const unsafeUrl = 'https://user:secret-token@github.com/o/r.git?token=query-secret';
  const expected = [
    [`${BIN}\\git.exe`, ['symbolic-ref', '--quiet', '--short', 'HEAD']],
    [`${BIN}\\git.exe`, ['remote', 'get-url', '--push', '--all', 'origin']],
    [`${BIN}\\git.exe`, ['remote', 'get-url', 'origin']],
    [`${BIN}\\gh.exe`, ['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', unsafeUrl]],
  ];
  const sentinel = 'FH_PRIVATE_PROVIDER_METADATA_577';
  const credential = 'https://fixture-user:fixture-password@fixture.invalid/private-577';
  const malformedMetadata = JSON.stringify({ id: '', nameWithOwner: 'acme/widgets',
    defaultBranchRef: { name: 'main' }, private: sentinel, privateUrl: credential });
  const calls = [];
  let responseMode = 'lookup-error';
  const originalExecFileSync = childProcess.execFileSync;
  const wrapped = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    calls.push([file, args]);
    const index = expected.findIndex(([command, argv]) => file === command && JSON.stringify(args) === JSON.stringify(argv));
    if (index === 0) return 'job/7\n';
    if (index === 1 || index === 2) return `${unsafeUrl}\n`;
    if (index === 3) {
      if (responseMode === 'invalid-metadata') return malformedMetadata;
      if (responseMode === 'invalid-json') return `{invalid JSON: ${unsafeUrl}`;
      throw Object.assign(new Error(`GitHub lookup failed for ${unsafeUrl}`), { stderr: `cannot access ${unsafeUrl}\n`, status: 1 });
    }
    return originalExecFileSync(file, args, options);
  });
  try {
    syncBuiltinESMExports();
    for (const mode of ['lookup-error', 'invalid-json', 'invalid-metadata']) {
      responseMode = mode;
      calls.length = 0;
      const reason = blockReason(PUSH, here, { preApproved: {
        start: RUN_START,
        tracker: 'github',
        env: { PATH: BIN },
        platform: 'win32',
        exists: (candidate) => candidate === `${BIN}\\git.exe` || candidate === `${BIN}\\gh.exe`,
      } });
      assert.deepEqual(calls, expected, 'the matching origin must reach only the origin-bound GitHub lookup');
      for (const secret of ['user:', 'secret-token', 'query-secret', unsafeUrl]) {
        assert.ok(!reason.includes(secret), `remote credentials leaked in ${JSON.stringify(reason)}`);
      }
      if (responseMode === 'invalid-metadata') {
        assert.equal(reason, `${PRE_APPROVED}publishes nothing: unreadable origin repository: GitHub CLI returned invalid repository metadata`);
        for (const secret of [malformedMetadata, sentinel, credential, 'fixture-user', 'fixture-password']) {
          assert.ok(!reason.includes(secret), `private provider metadata leaked in ${JSON.stringify(reason)}`);
        }
      } else if (responseMode === 'invalid-json') {
        assert.equal(reason, `${PRE_APPROVED}publishes nothing: unreadable origin repository: GitHub CLI returned invalid JSON`);
      } else {
        assert.equal(reason, `${PRE_APPROVED}publishes nothing: unreadable origin repository: the GitHub CLI lookup failed; check that gh is installed on PATH and can access the repository`);
      }
    }
  } finally {
    wrapped.mock.restore();
    syncBuiltinESMExports();
  }
});

test("ANTI-REGRESSION: a pre-approved run session marks ready or merges only a pull request into origin's default branch", () => {
  const INTO_MAIN = `${PRE_APPROVED}acts only on its own job pull request into the default branch: #12 targets other, not main`;
  for (const command of [READY, MERGE, `${READY} --undo`]) {
    const { reason, calls } = judged(command, { pullRequest: { baseRefName: 'other' } });
    assert.equal(reason, INTO_MAIN, command);
    assert.deepEqual(calls.filter(isGraphql), [], command);
  }
  for (const command of [READY, MERGE]) {
    assert.equal(judged(command, { pullRequest: { baseRefName: 'main' } }).reason, '', command);
    assert.equal(judged(command, { repository: { defaultBranchRef: { name: 'release' } }, pullRequest: { baseRefName: 'release' } }).reason, '', command);
  }
  for (const repository of [{ defaultBranchRef: undefined }, { defaultBranchRef: null }, { defaultBranchRef: { name: '' } }, { defaultBranchRef: { name: 'ma in' } }]) {
    for (const command of DELIVERY) {
      const { reason, calls } = judged(command, { repository });
      assert.ok(reason.startsWith(`${PRE_APPROVED}publishes nothing: unreadable origin repository`), `${command}, ${JSON.stringify(repository)}: ${JSON.stringify(reason)}`);
      assert.deepEqual(calls.filter(isGraphql), [], `${command}, ${JSON.stringify(repository)}`);
    }
  }
});

test('ANTI-REGRESSION: on Windows the advance approval reads run git.exe and gh.exe only from absolute PATH entries', (t) => {
  // No runner is injected for the executable under test, so the default one is built from the lookup.
  // A spawn names the file it was given in its own error, which is how a reason shows the path used.
  const here = { cwd: process.cwd(), isRootCheckout: () => false, platform: process.platform };
  const BIN = 'C:\\fabraik-absent\\bin';
  const onWindows = (PATH, exists, runners = {}) => ({ start: RUN_START, tracker: 'github', env: { PATH }, platform: 'win32', exists, ...runners });
  const { git } = preApprovedRun().preApproved;
  const relativeGit = blockReason(PUSH, here, { preApproved: onWindows('tools\\bin', () => true) });
  assert.ok(relativeGit.startsWith(PRE_APPROVED) && relativeGit.includes('git.exe') && !relativeGit.includes('tools\\bin'), JSON.stringify(relativeGit));
  const relativeCalls = [];
  const relativeLookup = t.mock.method(childProcess, 'execFileSync', (file, args) => {
    relativeCalls.push([file, args]);
    throw new Error('relative executable must not run');
  });
  try {
    syncBuiltinESMExports();
    const relativeGh = blockReason(CREATE, here, { preApproved: onWindows('tools\\bin', () => true, { git }) });
    assert.deepEqual(relativeCalls, [], 'a relative gh.exe lookup must never execute a child');
    assert.equal(relativeGh, `${PRE_APPROVED}publishes nothing: found no gh.exe in an absolute PATH entry`);
    assert.ok(relativeGh.startsWith(PRE_APPROVED) && !relativeGh.includes('tools\\bin'), JSON.stringify(relativeGh));
  } finally {
    relativeLookup.mock.restore();
    syncBuiltinESMExports();
  }
  const exists = (candidate) => candidate === `${BIN}\\git.exe` || candidate === `${BIN}\\gh.exe`;
  const absoluteGit = blockReason(PUSH, here, { preApproved: onWindows(`tools\\bin;${BIN}`, exists) });
  assert.ok(absoluteGit.startsWith(PRE_APPROVED) && absoluteGit.includes(`${BIN}\\git.exe`), JSON.stringify(absoluteGit));
  const originLookup = ['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', ORIGIN_URL];
  const absoluteCalls = [];
  const originalExecFileSync = childProcess.execFileSync;
  const absoluteLookup = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    absoluteCalls.push([file, args]);
    if (file === `${BIN}\\gh.exe` && JSON.stringify(args) === JSON.stringify(originLookup)) {
      return JSON.stringify({ id: ORIGIN_ID, nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
    }
    return originalExecFileSync(file, args, options);
  });
  try {
    syncBuiltinESMExports();
    const absoluteGh = blockReason(CREATE, here, { preApproved: onWindows(`tools\\bin;${BIN}`, exists, { git }) });
    assert.deepEqual(absoluteCalls, [
      [`${BIN}\\gh.exe`, originLookup],
      [`${BIN}\\gh.exe`, ['repo', 'view', '--json', 'id']],
    ]);
    assert.ok(absoluteGh.startsWith(PRE_APPROVED) && absoluteGh.includes(`${BIN}\\gh.exe`), JSON.stringify(absoluteGh));
  } finally {
    absoluteLookup.mock.restore();
    syncBuiltinESMExports();
  }
  // The branch read needs only git, so with gh.exe absent a push off main is refused for the branch, not for gh.exe.
  const { git: gitOnMain } = preApprovedRun({ branch: 'main' }).preApproved;
  const gitOnly = (candidate) => candidate === `${BIN}\\git.exe`;
  const offBranch = blockReason(PUSH, here, { preApproved: onWindows(BIN, gitOnly, { git: gitOnMain }) });
  assert.ok(
    offBranch.startsWith(PRE_APPROVED) && offBranch.includes('publishes only from a job branch, and HEAD is "main"') && !offBranch.includes('gh.exe'),
    JSON.stringify(offBranch),
  );
});

test('ANTI-REGRESSION: a pre-approved run session may take its own pull request back to draft while a wait reason holds', (t) => {
  const held = { cwd: sessionDirectory({ 'body.md': edit(CLEAR, UNDO_EASY, UNDO_HARD) }, (remove) => t.after(remove)) };
  const ready = judged(READY, held).reason;
  assert.ok(ready.startsWith(PRE_APPROVED) && namesReason(ready, 'hard-to-undo'), JSON.stringify(ready));
  for (const command of ['gh pr ready 12 --undo', 'gh pr ready --undo 12']) {
    const { reason, calls } = judged(command, held);
    assert.equal(reason, '', command);
    assert.ok(calls.includes(PR_VIEW), `${command}: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls.filter(isGraphql), [], command);
  }
});

// The expected outcomes come from card #757's first acceptance criterion and the guard change the owner signed off:
// the owner's show-me-first label holds a card at every level, on-screen also holds work on screen, a card whose
// labels cannot all be read publishes nothing, and taking its own pull request back to draft stays open.
test('ANTI-REGRESSION: a run session marks ready and merges nothing while its card carries show-me-first or, at on-screen, its work is on screen', (t) => {
  const onScreenLevel = '{"version":1,"waitForOwner":"on-screen"}';
  const marked = { issue: { labels: labelsOf('enhancement', 'show-me-first') } };
  const screenWork = {
    settingText: onScreenLevel,
    cwd: sessionDirectory({ 'body.md': ON_SCREEN, 'screenshot-1.png': SHOT_1 }, (remove) => t.after(remove)),
    pullBody: ATTACHED_BODY,
  };
  // The saved write-up says no visual change while the published body shows the work on screen with its screenshot
  // attached: both must say no visual change before on-screen admits it.
  const publishedScreenWork = {
    settingText: onScreenLevel,
    cwd: sessionDirectory({ 'body.md': CLEAR, 'screenshot-1.png': SHOT_1 }, (remove) => t.after(remove)),
    pullBody: ATTACHED_BODY,
  };
  // Admitted, held naming the reasons the refusal lists, or any other refusal whole.
  const verdict = (reason) => {
    if (reason === '') return 'admitted';
    const held = /wait reason holds for HEAD: (.+)$/.exec(reason)?.[1];
    return held === undefined ? reason : `held: ${held}`;
  };
  const rows = [
    ...[READY, MERGE].flatMap((command) => [
      [`when-needed, a card carrying show-me-first: ${command}`, command, marked, 'held: show-me-first'],
      [`when-needed, a card carrying another label only: ${command}`, command, { issue: { labels: labelsOf('enhancement') } }, 'admitted'],
      [`on-screen, an unmarked card with work on screen: ${command}`, command, screenWork, 'held: on-screen'],
      [`when-needed, a card carrying Show-Me-First: ${command}`, command, { issue: { labels: labelsOf('enhancement', 'Show-Me-First') } }, 'held: show-me-first'],
      [`on-screen, a write-up saying no visual change and a published body with work on screen: ${command}`, command, publishedScreenWork, 'held: on-screen'],
    ]),
    ...DELIVERY.map((command) => [`on-screen, an unmarked card with no visual change: ${command}`, command, { settingText: onScreenLevel }, 'admitted']),
    ...['gh pr ready 12 --undo', 'gh pr ready --undo 12'].map((command) => [`a card carrying show-me-first: ${command}`, command, marked, 'admitted']),
  ];
  const outcomes = (pick) => Object.fromEntries(rows.map((row) => [row[0], pick(row)]));
  assert.deepEqual(outcomes(([, command, fixture]) => verdict(judged(command, fixture).reason)), outcomes((row) => row[3]));
  const unreadable = {
    'labels absent': { labels: undefined },
    'labels not an array': { labels: { pageInfo: { hasNextPage: false }, nodes: 'show-me-first' } },
    'a label name that is not text': { labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 7 }] } },
    'a second page of labels': { labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: 'enhancement' }] } },
  };
  for (const [label, issue] of Object.entries(unreadable)) {
    for (const command of [READY, MERGE]) {
      const { reason } = judged(command, { issue });
      assert.ok(reason.startsWith(PRE_APPROVED) && reason.includes('publishes nothing: '), `${label}, ${command}: ${JSON.stringify(reason)}`);
    }
  }
});

// ── owner answers ───────────────────────────────────────────────────────────
// The expected outcomes come from card #758's records and fix path, which the owner signed off: a held card's ready or
// merge is admitted on the newest owner answer by the acting account for the saved card at the pull request head, or
// on an answer to an earlier head that a fix line by that account built on, within the fix path's bounds. Every
// identity is blobHash's, and every refusal is the held refusal, followed, where an answer holds, after `, and ` by why
// it does not admit the head.

const SIGN_OFF = edit(CLEAR, 'tier=code', 'tier=sign-off');
// The identity of a saved card: the blob hash of its body.md, then of each screenshot in numeric order, comma-joined.
const identityOf = (...texts) => texts.map(blobHash).join(',');
const ownerAnswer = (head, identity, words) => `Owner answer: job/7 at ${head} ${identity}: ${words}`;
const fixBuilt = (from, words) => `Fix built: job/7 at ${HEAD_COMMIT} from ${from}: ${words}`;
// The held refusal of `command` naming `reasons`, then, where the fix path gives one, its reason `tail`.
const heldRefusal = (command, reasons, tail) => `${PRE_APPROVED}${command === READY ? 'marks ready' : 'merges'} nothing while a wait reason holds for HEAD: ${reasons.join(', ')}${tail === undefined ? '' : `, and ${tail}`}`;
// Each row, as [label, fixture, held reasons or undefined where it is admitted, the fix path's reason], judged for
// READY and MERGE, against its expected reason.
const ownerAnswerOutcomes = (rows) => {
  const outcomes = (pick) => Object.fromEntries([READY, MERGE].flatMap((command) => rows.map((row) => [`${row[0]}: ${command}`, pick(command, row)])));
  return {
    actual: outcomes((command, [, fixture]) => judged(command, fixture).reason),
    expected: outcomes((command, [, , reasons, tail]) => (reasons === undefined ? '' : heldRefusal(command, reasons, tail))),
  };
};

test('ANTI-REGRESSION: a pre-approved run session marks ready or merges a held card only where the card records an owner answer by its own account for the version at the pull request head', (t) => {
  assert.equal(blobHash(SHOT_1), SHOT_1_HASH, "blobHash gives Git's own blob hash");
  const cleanup = (remove) => t.after(remove);
  const held = { cwd: sessionDirectory({ 'body.md': SIGN_OFF }, cleanup), pullBody: SIGN_OFF };
  const atHead = ownerAnswer(HEAD_COMMIT, identityOf(SIGN_OFF), 'yes');
  const answered = (login, body) => [OWN_CLAIM, cardComment(login, '2026-11-04T12:30:00Z', body)];
  const marked = { issue: { labels: labelsOf('show-me-first') } };
  // A matching record, then a newer comment by owner whose first line begins as a record for job/7 and does not parse.
  const superseded = (body) => ({ ...held, comments: [...answered('owner', atHead), cardComment('owner', '2026-11-04T12:40:00Z', body)] });
  const editedByBob = (comment) => ({ ...comment, editor: { login: 'bob' }, lastEditedAt: '2026-11-04T12:50:00Z' });
  const { actual, expected } = ownerAnswerOutcomes([
    ['no record', held, ['sign-off']],
    ['a record by owner at HEAD with its identity', { ...held, comments: answered('owner', atHead) }],
    ['a record by another account', { ...held, comments: answered('bob', atHead) }, ['sign-off']],
    ['a record by a deleted account', { ...held, comments: [OWN_CLAIM, { ...cardComment('owner', '2026-11-04T12:30:00Z', atHead), author: null }] }, ['sign-off']],
    ['a record for job/8', { ...held, comments: answered('owner', atHead.replace('job/7', 'job/8')) }, ['sign-off']],
    ['a record with blank words', { ...held, comments: answered('owner', ownerAnswer(HEAD_COMMIT, identityOf(SIGN_OFF), '  ')) }, ['sign-off']],
    ['a record quoted after other text on its first line', { ...held, comments: answered('owner', `The owner wrote ${atHead}`) }, ['sign-off']],
    [
      'a record with one identity hash changed',
      { ...held, comments: answered('owner', ownerAnswer(HEAD_COMMIT, identityOf(CLEAR), 'yes')) },
      ['sign-off'],
      `the newest owner answer on card 7 does not name the saved card at ${HEAD_COMMIT}`,
    ],
    [
      'a matching record, then a newer one naming ANSWERED_COMMIT and no fix line',
      {
        cwd: sessionDirectory({ 'body.md': SIGN_OFF }, cleanup, { 'body.md': SIGN_OFF }),
        pullBody: SIGN_OFF,
        comments: [
          OWN_CLAIM,
          cardComment('owner', '2026-11-04T12:30:00Z', atHead),
          cardComment('owner', '2026-11-04T12:40:00Z', ownerAnswer(ANSWERED_COMMIT, identityOf(SIGN_OFF), 'shorten the title and merge it')),
        ],
      },
      ['sign-off'],
      `the newest owner answer on card 7 names ${ANSWERED_COMMIT}, and no fix built from it by owner names ${HEAD_COMMIT}`,
    ],
    [
      'a matching record, then a newer one by owner with its words on the second line',
      superseded(`Owner answer: job/7 at ${HEAD_COMMIT} ${identityOf(SIGN_OFF)}:\nhold it`),
      ['sign-off'],
    ],
    ['a matching record, then a newer one by owner naming a truncated head', superseded(ownerAnswer(HEAD_COMMIT.slice(0, 12), identityOf(SIGN_OFF), 'hold it')), ['sign-off']],
    [
      'a matching record that another account last edited',
      { ...held, comments: [OWN_CLAIM, editedByBob(cardComment('owner', '2026-11-04T12:30:00Z', atHead))] },
      ['sign-off'],
    ],
    [
      'a matching record that owner last edited',
      { ...held, comments: [OWN_CLAIM, { ...cardComment('owner', '2026-11-04T12:30:00Z', atHead), editor: { login: 'owner' }, lastEditedAt: '2026-11-04T12:50:00Z' }] },
    ],
    [
      'a matching record that an account GitHub no longer names last edited',
      { ...held, comments: [OWN_CLAIM, { ...cardComment('owner', '2026-11-04T12:30:00Z', atHead), lastEditedAt: '2026-11-04T12:50:00Z' }] },
      ['sign-off'],
    ],
    [
      'a matching record, and an earlier comment by owner that another account last edited',
      { ...held, comments: [OWN_CLAIM, editedByBob(cardComment('owner', '2026-11-04T12:20:00Z', 'Verdict: the review found nothing.')), cardComment('owner', '2026-11-04T12:30:00Z', atHead)] },
      ['sign-off'],
    ],
    ['a show-me-first card with the record', { ...held, ...marked, comments: answered('owner', atHead) }],
    ['a show-me-first card without the record', { ...held, ...marked }, ['sign-off', 'show-me-first']],
    [
      'on-screen, the work on screen with its screenshot attached, with the record',
      {
        settingText: '{"version":1,"waitForOwner":"on-screen"}',
        cwd: sessionDirectory({ 'body.md': ON_SCREEN, 'screenshot-1.png': SHOT_1 }, cleanup),
        pullBody: ATTACHED_BODY,
        comments: answered('owner', ownerAnswer(HEAD_COMMIT, identityOf(ON_SCREEN, SHOT_1), 'yes')),
      },
    ],
  ]);
  // A matching record never admits a reason held at HEAD that the saved card it names does not hold, which only the
  // published body adds. Each row, as [label, fixture, held reasons], is refused naming those reasons; what follows
  // them is the guard's own wording, so only the reasons are compared.
  const shownOnScreen = edit(ON_SCREEN, 'tier=code', 'tier=sign-off');
  const unseen = [
    [
      'a matching record and a published body adding hard-to-undo',
      { ...held, pullBody: edit(SIGN_OFF, UNDO_EASY, UNDO_HARD), comments: answered('owner', atHead) },
      ['sign-off', 'hard-to-undo'],
    ],
    [
      'a matching record and a saved screenshot the published body does not attach',
      {
        cwd: sessionDirectory({ 'body.md': shownOnScreen, 'screenshot-1.png': SHOT_1 }, cleanup),
        pullBody: shownOnScreen,
        comments: answered('owner', ownerAnswer(HEAD_COMMIT, identityOf(shownOnScreen, SHOT_1), 'yes')),
      },
      ['screenshot', 'sign-off'],
    ],
  ];
  const heldNaming = (reasons) => `held: ${reasons.join(', ')}`;
  const unseenOutcomes = (pick) => Object.fromEntries([READY, MERGE].flatMap((command) => unseen.map((row) => [`${row[0]}: ${command}`, pick(command, row)])));
  assert.deepEqual(
    { ...actual, ...unseenOutcomes((command, [, fixture, reasons]) => {
      const { reason } = judged(command, fixture);
      return reason.startsWith(heldRefusal(command, reasons)) ? heldNaming(reasons) : reason;
    }) },
    { ...expected, ...unseenOutcomes((command, [, , reasons]) => heldNaming(reasons)) },
  );
});

test('ANTI-REGRESSION: an owner answer asking for a fix admits the fixed head only from a fix built on the answered head by the same account holding no new wait reason', (t) => {
  assert.equal(blobHash(SHOT_1), SHOT_1_HASH, "blobHash gives Git's own blob hash");
  const cleanup = (remove) => t.after(remove);
  const failed = edit(SIGN_OFF, 'Failed: none', 'Failed: lint, cause unknown');
  const answerTo = (body) => cardComment('owner', '2026-11-04T12:30:00Z', ownerAnswer(ANSWERED_COMMIT, identityOf(body), 'shorten the title and merge it'));
  const fixBy = (login, createdAt, from = ANSWERED_COMMIT) => cardComment(login, createdAt, fixBuilt(from, 'shortened the title'));
  const FIX = fixBy('owner', '2026-11-04T12:45:00Z');
  // The H1-to-H2 example: the owner answered at ANSWERED_COMMIT, whose saved write-up is `answered` (null for no
  // folder there), a fix line names HEAD_COMMIT, whose saved write-up is `at`, and the ancestor read is true.
  const fixed = ({ at = SIGN_OFF, answered = SIGN_OFF, comments = [OWN_CLAIM, answerTo(answered ?? SIGN_OFF), FIX], ...rest } = {}) => ({
    cwd: sessionDirectory({ 'body.md': at }, cleanup, answered === null ? undefined : { 'body.md': answered }),
    pullBody: at,
    comments,
    answeredAncestor: true,
    ...rest,
  });
  const NO_FIX = `the newest owner answer on card 7 names ${ANSWERED_COMMIT}, and no fix built from it by owner names ${HEAD_COMMIT}`;
  const { actual, expected } = ownerAnswerOutcomes([
    ['as described', fixed()],
    ['no fix line', fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF)] }), ['sign-off'], NO_FIX],
    ['a fix line by another account', fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF), fixBy('bob', '2026-11-04T12:45:00Z')] }), ['sign-off'], NO_FIX],
    ['a fix line older than the answer', fixed({ comments: [OWN_CLAIM, fixBy('owner', '2026-11-04T12:20:00Z'), answerTo(SIGN_OFF)] }), ['sign-off'], NO_FIX],
    ['a fix line from another head', fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF), fixBy('owner', '2026-11-04T12:45:00Z', 'feedface'.repeat(5))] }), ['sign-off'], NO_FIX],
    [
      'a fix line from ANSWERED_COMMIT naming another head',
      fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF), cardComment('owner', '2026-11-04T12:45:00Z', edit(fixBuilt(ANSWERED_COMMIT, 'shortened the title'), HEAD_COMMIT, 'feedface'.repeat(5)))] }),
      ['sign-off'],
      NO_FIX,
    ],
    [
      'a fix line for job/8 by owner, another card',
      fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF), cardComment('owner', '2026-11-04T12:45:00Z', edit(fixBuilt(ANSWERED_COMMIT, 'shortened the title'), 'job/7', 'job/8'))] }),
      ['sign-off'],
      NO_FIX,
    ],
    [
      'a fix line after other text on its first line',
      fixed({ comments: [OWN_CLAIM, answerTo(SIGN_OFF), cardComment('owner', '2026-11-04T12:45:00Z', `Example: ${fixBuilt(ANSWERED_COMMIT, 'shortened the title')}`)] }),
      ['sign-off'],
      NO_FIX,
    ],
    ['an answered head that is not an ancestor', fixed({ answeredAncestor: false }), ['sign-off'], `${ANSWERED_COMMIT}, which the newest owner answer on card 7 names, is not an ancestor of ${HEAD_COMMIT}`],
    ['HEAD_COMMIT also holding hard-to-undo', fixed({ at: edit(SIGN_OFF, UNDO_EASY, UNDO_HARD) }), ['sign-off', 'hard-to-undo'], `the fix at ${HEAD_COMMIT} holds a wait reason that did not hold at ${ANSWERED_COMMIT}`],
    ['both heads holding check', fixed({ at: failed, answered: failed }), ['check', 'sign-off'], `the fix at ${HEAD_COMMIT} has failed, untested or unsettled evidence`],
    ['no folder at ANSWERED_COMMIT', fixed({ answered: null }), ['sign-off'], `the newest owner answer on card 7 does not name the saved card at ${ANSWERED_COMMIT}`],
    [
      'as described, the card now carrying show-me-first, added after the answer',
      fixed({ issue: { labels: labelsOf('show-me-first') } }),
      ['sign-off', 'show-me-first'],
      `card 7 asks to see every version first, so the fix at ${HEAD_COMMIT} needs an owner answer of its own`,
    ],
  ]);
  assert.deepEqual(actual, expected);
});

// ── a coordinated job's direct push ─────────────────────────────────────────
// The expected outcomes come from card #935's acceptance criteria, deliver.md's squash (`git reset --soft <origin-main>`,
// then `git commit`, which leaves the shown version in ORIG_HEAD) and the fifth and tenth entries of the approved guard
// loosenings: a job a coordinator started pushes main as `git push origin HEAD:main` only where HEAD is
// one commit on fetched main whose tree is the shown version's and whose parent is an ancestor of it, read with
// replacement refs disabled and with no ref named ORIG_HEAD; core.hooksPath is .githooks and HEAD's .githooks is
// fetched main's and unchanged, so the pre-push gate on the remote's main judges it; the saved write-up at that version
// holds no wait reason; and every other push check holds. A session no coordinator started never pushes main.

test('ANTI-REGRESSION: a coordinated job pushes main only as the squash of the version it shows, and no other run session pushes main', (t) => {
  const cleanup = (remove) => t.after(remove);
  const DIRECT = 'git push origin HEAD:main';
  const OWN_BRANCH = `${PRE_APPROVED}pushes only its own branch, as git push -u origin job/7 or git push --force-with-lease origin job/7`;
  // A write-up whose only hold is the card's show-me-first label.
  const DOCUMENT = edit(CLEAR, 'tier=code', 'tier=document');
  const held = { cwd: sessionDirectory({ 'body.md': DOCUMENT }, cleanup), squash: {}, issue: { labels: labelsOf('show-me-first') } };
  const reasonFor = (command, fixture, coordinated) => {
    const run = preApprovedRun(fixture);
    return blockReason(command, { ...inJob, cwd: run.cwd }, { preApproved: { ...run.preApproved, coordinated } });
  };
  // Admitted, or refused by kind and, given `cause`, naming it; any other reason whole, so a read the stand-in does not
  // answer never passes as a refusal.
  const verdict = (reason, cause) => {
    if (reason === '') return 'admitted';
    if (reason.includes('unexpected read')) return reason;
    const kinds = [
      ['own branch', reason === OWN_BRANCH],
      ['own branch or main', reason.startsWith(OWN_BRANCH) && reason.endsWith('or main as `git push origin HEAD:main`')],
      ['not the squash', reason.startsWith(`${PRE_APPROVED}pushes main only as the one commit deliver.md squashes from the version it showed: `)],
      ['not under the gate', reason.startsWith(`${PRE_APPROVED}pushes main only where the pre-push hook on the remote's main judges it: `)],
      ['held', reason.startsWith(`${PRE_APPROVED}pushes nothing to main while a wait reason holds for ${HEAD_COMMIT}: show-me-first`)],
      ['publishes nothing', reason.startsWith(`${PRE_APPROVED}publishes nothing: `)],
      ['pull request ready', reason.startsWith(`${PRE_APPROVED}pushes nothing while pull request #12 is ready or has a merge queued`)],
    ];
    const kind = kinds.find(([, matches]) => matches)?.[0];
    if (kind === undefined || cause === undefined) return kind ?? reason;
    return cause.test(reason) ? `${kind} naming ${cause.source}` : reason;
  };
  const squash = (fields) => ({ squash: fields });
  // The session's shell in `src` below the worktree top, with a clear write-up readable from there too.
  const fromSource = (fields) => {
    const top = sessionDirectory({ 'body.md': CLEAR }, cleanup);
    mkdirSync(join(top, 'src', REVIEW_FOLDER), { recursive: true });
    writeFileSync(join(top, 'src', REVIEW_FOLDER, 'body.md'), CLEAR);
    return { cwd: join(top, 'src'), squash: { top, ...fields } };
  };
  // [label, command, fixture, coordinated, expected verdict, cause]
  const rows = [
    ['1 a clear write-up at the shown version, well-formed squash', DIRECT, squash({}), true, 'admitted'],
    ['2 the same, from a session no coordinator started', DIRECT, squash({}), false, 'own branch'],
    ['3 a held write-up', DIRECT, held, true, 'held'],
    ['6 trees that differ', DIRECT, squash({ trees: ['d'.repeat(40), 'e'.repeat(40)] }), true, 'not the squash'],
    ['7 HEAD with two parents', DIRECT, squash({ parents: ['a'.repeat(40), ANSWERED_COMMIT] }), true, 'not the squash'],
    ['8 a parent that is an ancestor of the shown version but not fetched main', DIRECT, squash({ parents: ['b'.repeat(40)] }), true, 'not the squash'],
    ['9 fetched main as parent, not an ancestor of the shown version', DIRECT, squash({ ancestor: false }), true, 'not the squash'],
    ['10 no ORIG_HEAD', DIRECT, squash({ origHead: null }), true, 'not the squash', /ORIG_HEAD/],
    ['11 no write-up at the shown version', DIRECT, { cwd: sessionDirectory({}, cleanup), squash: {} }, true, 'publishes nothing', /holds no readable saved write-up/],
    ['12 an open ready pull request from job/7', DIRECT, { squash: {}, openPulls: [{ number: 12, isDraft: false, autoMergeRequest: null, isCrossRepository: false }] }, true, 'pull request ready'],
    ['13 main by name', 'git push origin main', {}, true, 'own branch or main'],
    ['13 main forced', 'git push --force origin HEAD:main', {}, true, 'own branch or main'],
    ['14 its own branch', PUSH, {}, true, 'admitted'],
    ['15 core.hooksPath unset', DIRECT, squash({ hooksPath: null }), true, 'not under the gate', /core\.hooksPath is not \.githooks/],
    ['16 core.hooksPath another folder', DIRECT, squash({ hooksPath: '.git/hooks' }), true, 'not under the gate', /core\.hooksPath is not \.githooks/],
    ['17 HEAD\'s .githooks differing from fetched main\'s', DIRECT, squash({ githooks: ['c'.repeat(40), 'f'.repeat(40)] }), true, 'not under the gate', /HEAD's \.githooks is not fetched main's/],
    ['18 .githooks with an uncommitted change', DIRECT, squash({ githooksStatus: ' M .githooks/pre-push\n' }), true, 'not under the gate', /\.githooks has uncommitted changes/],
    ['19 a ref named ORIG_HEAD', DIRECT, squash({ origHeadRefs: 'refs/heads/ORIG_HEAD\n' }), true, 'not the squash', /a ref named ORIG_HEAD exists, so ORIG_HEAD is ambiguous/],
    ['20 core.hooksPath .githooks with a trailing space', DIRECT, squash({ hooksPath: '.githooks ' }), true, 'not under the gate', /core\.hooksPath is not \.githooks/],
    ['21 a pre-push the session user cannot execute', DIRECT, squash({ prePushExecutable: false }), true, 'not under the gate', /\.githooks\/pre-push is not executable/],
    ['22 a pre-push the session user cannot execute, on win32', DIRECT, { squash: { prePushExecutable: false }, platform: 'win32' }, true, 'admitted'],
    ['23 only a descendant of a ref named ORIG_HEAD', DIRECT, squash({ origHeadRefs: 'refs/heads/ORIG_HEAD/notes\n' }), true, 'admitted'],
    ['24 core.hooksPath .githooks with a trailing carriage return', DIRECT, squash({ hooksPath: '.githooks\r' }), true, 'not under the gate', /core\.hooksPath is not \.githooks/],
    ['25 only refs/remotes/ORIG_HEAD/HEAD', DIRECT, squash({ origHeadRefs: 'refs/remotes/ORIG_HEAD/HEAD\n' }), true, 'not the squash', /a ref named ORIG_HEAD exists, so ORIG_HEAD is ambiguous/],
    ['Q1 from src, the top\'s .githooks with an uncommitted change', DIRECT, fromSource({ githooksStatus: ' M .githooks/pre-push\n' }), true, 'not under the gate', /\.githooks has uncommitted changes/],
    ['Q2 from src, a top pre-push the session user cannot execute', DIRECT, fromSource({ prePushExecutable: false }), true, 'not under the gate', /\.githooks\/pre-push is not executable/],
    ['S1 literal pathspecs, the top\'s .githooks with an uncommitted change', DIRECT, { env: { GIT_LITERAL_PATHSPECS: '1' }, ...squash({ githooksStatus: ' M .githooks/pre-push\n' }) }, true, 'not under the gate', /\.githooks has uncommitted changes/],
    ['T1 the top\'s edited pre-push marked assume-unchanged', DIRECT, squash({ githooksStatus: ' M .githooks/pre-push\n', indexTag: 'h' }), true, 'not under the gate', /\.githooks/],
    ['T2 the top\'s edited pre-push marked skip-worktree', DIRECT, squash({ githooksStatus: ' M .githooks/pre-push\n', indexTag: 'S' }), true, 'not under the gate', /\.githooks/],
    ['T3 the top\'s edited pre-push with a core.fsmonitor that reports no change', DIRECT, squash({ githooksStatus: ' M .githooks/pre-push\n', fsmonitor: true }), true, 'not under the gate', /\.githooks/],
    ['U1 a same-size edit to the top\'s pre-push the index reports clean', DIRECT, squash({ edited: ['pre-push'] }), true, 'not under the gate', /\.githooks has uncommitted changes/],
    ['U2 a symbolic link in the top\'s .githooks', DIRECT, squash({ topHooks: [{ name: 'pre-push', file: false }] }), true, 'not under the gate', /\.githooks has uncommitted changes/],
    ['U3 fetched main\'s .githooks holding a commit entry', DIRECT, squash({ mainHooks: [['100755', 'blob', '5'.repeat(40), 'pre-push'], ['160000', 'commit', '7'.repeat(40), 'vendor']] }), true, 'not under the gate', /\.githooks is not fetched main's/],
    [
      'V1 the top\'s pre-commit, matching fetched main\'s bytes, without the execute bit fetched main\'s mode 100755 records',
      DIRECT,
      squash({
        mainHooks: [['100755', 'blob', '5'.repeat(40), 'pre-push'], ['100755', 'blob', '9'.repeat(40), 'pre-commit']],
        topHooks: [{ name: 'pre-push', file: true }, { name: 'pre-commit', file: true, executable: false }],
      }),
      true,
      'not under the gate',
      /\.githooks has uncommitted changes/,
    ],
  ];
  const outcomes = (pick) => Object.fromEntries(rows.map((row) => [row[0], pick(row)]));
  assert.deepEqual(
    outcomes(([, command, fixture, coordinated, , cause]) => verdict(reasonFor(command, fixture, coordinated), cause)),
    outcomes(([, , , , expected, cause]) => (cause === undefined ? expected : `${expected} naming ${cause.source}`)),
  );
});

// The test owns this verified context. Only the Git and provider reads cross a simulated boundary.
function pinnedDelivery(command, fixture, { verified = true, coordinated = false, appRun = false } = {}) {
  const pinnedReads = [];
  const run = preApprovedRun({ ...fixture, boundCard: '7', pinnedReads });
  const worktree = realpathSync(run.cwd);
  const context = verified ? {
    codexHerdr: {
      root: realpathSync(dirname(dirname(CODE_DIRECTORY))),
      repositoryId: ORIGIN_ID,
      worktree,
      card: 7,
      runStart: RUN_START,
      threadId: '11111111-1111-4111-8111-111111111111',
    },
  } : coordinated ? { coordinated: true } : {};
  const unexpected = [];
  const observed = (read) => (arg) => {
    try {
      return read(arg);
    } catch (error) {
      if (error.message.startsWith('unexpected read: ')) unexpected.push(error.message);
      throw error;
    }
  };
  const reason = blockReason(command, { ...inJob, cwd: run.cwd }, {
    appRun,
    preApproved: {
      ...run.preApproved, ...context, git: observed(run.preApproved.git), exec: observed(run.preApproved.exec),
      executable: observed(run.preApproved.executable), listHooks: observed(run.preApproved.listHooks),
    },
  });
  assert.deepEqual(unexpected, [], command);
  return { reason, calls: [...run.calls, ...pinnedReads] };
}

function heldPinnedVersions(t, body) {
  const identity = identityOf(body);
  const cwd = sessionDirectory({ 'body.md': body }, (remove) => t.after(remove));
  const withNote = sessionDirectory({ 'body.md': body }, (remove) => t.after(remove));
  writeFileSync(join(withNote, '.claude/worklog/job_7-owner-answer.md'), `${ownerAnswerLine(7, HEAD_COMMIT, identity, 'yes')}\n`);
  const issue = { labels: labelsOf('show-me-first') };
  return [
    { label: 'the verified binding alone', fixture: { cwd, issue } },
    {
      label: 'an owner answer on the card',
      fixture: {
        cwd, issue,
        comments: [OWN_CLAIM, cardComment('owner', '2026-11-04T12:30:00Z', ownerAnswer(HEAD_COMMIT, identity, 'yes'))],
      },
    },
    { label: 'the legacy local owner note', fixture: { cwd: withNote, issue } },
  ];
}

const PINNED_MERGE = `gh pr merge --squash --delete-branch --match-head-commit ${HEAD_COMMIT} 12`;
const PINNED_PULL = {
  number: 12, state: 'OPEN', headRefName: 'job/7', baseRefName: 'main', baseRefOid: 'b'.repeat(40),
  headRepository: { id: ORIGIN_ID }, isCrossRepository: false, headRefOid: HEAD_COMMIT, isDraft: false, autoMergeRequest: null,
  isInMergeQueue: false, isMergeQueueEnabled: false,
};
const pinnedPullRead = (call) => isGraphql(call) && /\bpullRequest\s*\(/.test(call) && call.endsWith('-F number=12');

// The pinned merge cases for one Herdr mark, `options` as pinnedDelivery takes them: every malformed, stale, queued,
// auto-merging, unchecked, marked, unreadable or unattached merge refuses with its cause, and the pinned merge of the
// checked current head is admitted. Returns the admitted merge's reads.
function pinnedMergeCases(t, options) {
  const commandFor = (head, number) => `gh pr merge --squash --delete-branch --match-head-commit ${head} ${number}`;
  const merge = PINNED_MERGE;
  const pull = PINNED_PULL;
  const providerRead = pinnedPullRead;
  const ownPull = /(?:pull request|#12).*(?:own|number|open|job\/7|origin|draft|default branch)|only.*(?:pull request|#12)/i;
  const pinLapse = /(?=.*\b(?:head|commit)\b)(?=.*(?:match|changed|differ|moved))/i;
  const queueLapse = /(?:merge queue|queued|queue state)/i;
  const syntaxLapse = /(?:merges? only|merge.*delivery form|plain command|command on its own)/i;
  const holdLapse = /wait reason holds.*\bshow-me-first\b/;
  const checksLapse = /(?:required checks?|required status checks?)/i;

  const refusals = [];
  const refuse = (label, command, fixture, cause, reads = []) => {
    const verdict = pinnedDelivery(command, { pinnedPull: pull, ...fixture }, options);
    refusals.push({ label, verdict, cause, reads });
  };
  for (const [label, command] of [
    ['legacy unpinned auto-merge', MERGE],
    ['leading-zero pull request number', commandFor(HEAD_COMMIT, '012')],
    ['pull request number zero', commandFor(HEAD_COMMIT, '0')],
    ['quoted pull request number', commandFor(HEAD_COMMIT, '"12"')],
    ['abbreviated expected head', commandFor(HEAD_COMMIT.slice(0, 12), '12')],
    ['uppercase expected head', commandFor(HEAD_COMMIT.toUpperCase(), '12')],
    ['symbolic expected head', commandFor('HEAD', '12')],
    ['added admin flag', `${merge} --admin`],
    ['reordered flags', `gh pr merge --delete-branch --squash --match-head-commit ${HEAD_COMMIT} 12`],
    ['wrapped merge', `command ${merge}`],
    ['an extra command', `${merge} && pwd`],
  ]) refuse(label, command, {}, syntaxLapse);

  for (const [label, fields] of [
    ['wrong provider pull request number', { number: 13 }],
    ['another job branch', { headRefName: 'job/8' }],
    ['another base branch', { baseRefName: 'develop' }],
    ['another head repository', { headRepository: { id: 'R_kgDOanother' } }],
    ['a cross-repository pull request', { isCrossRepository: true }],
    ['a closed pull request', { state: 'CLOSED' }],
    ['a draft pull request', { isDraft: true }],
  ]) refuse(label, merge, { pinnedPull: { ...pull, ...fields } }, ownPull, [providerRead]);
  refuse('different literal expected head', commandFor(ANSWERED_COMMIT, '12'), {}, pinLapse);
  refuse('local head has moved', merge, { localHead: ANSWERED_COMMIT }, pinLapse, [(call) => call === 'git rev-parse HEAD']);
  refuse('remote pull request head has moved', merge, { pinnedPull: { ...pull, headRefOid: ANSWERED_COMMIT } }, pinLapse, [providerRead]);

  for (const field of ['isInMergeQueue', 'isMergeQueueEnabled']) {
    for (const value of [true, undefined, 'false']) {
      refuse(`queue field ${field} is ${value}`, merge, { pinnedPull: { ...pull, [field]: value } }, queueLapse, [providerRead]);
    }
  }
  refuse('an active auto-merge', merge, { pinnedPull: { ...pull, autoMergeRequest: { enabledAt: RUN_START } } }, /auto[- ]?merge/i, [providerRead]);
  refuse('missing auto-merge state', merge, { pinnedPull: { ...pull, autoMergeRequest: undefined } }, /auto[- ]?merge|queue/i, [providerRead]);
  refuse('unreadable queue record', merge, { pinnedPull: new Error('merge queue state is unreadable') }, queueLapse, [providerRead]);

  const checkRead = [(call) => call === REQUIRED_CHECKS_READ];
  for (const bucket of ['fail', 'pending', 'unknown']) {
    refuse(`the required test check is ${bucket}`, merge, {
      requiredChecks: [{ name: 'test', bucket, link: '' }],
    }, checksLapse, checkRead);
  }
  refuse('no required checks have reported', merge, { requiredChecks: [] }, checksLapse, checkRead);
  refuse('an unrelated passing check does not supply the named check', merge, {
    requiredChecks: [{ name: 'other', bucket: 'pass', link: '' }],
  }, checksLapse, checkRead);
  for (const { label, fixture } of heldPinnedVersions(t, CLEAR)) refuse(label, merge, fixture, holdLapse, [providerRead]);
  // The saved review and the published body are hostile input: an unreadable copy refuses, and a published body that
  // drops a saved screenshot's attachment holds under screenshot.
  const session = (files) => sessionDirectory(files, (remove) => t.after(remove));
  refuse('unreadable published review', merge, { pullBody: new Error('fixture provider read failed') }, /published body.*provider read failed/i);
  refuse('malformed saved review bytes', merge, { cwd: session({ 'body.md': Buffer.from([0xff]) }) }, /saved.*(?:UTF-8|readable|invalid)|body\.md/i);
  refuse('a published body missing a saved screenshot', merge, {
    cwd: session({ 'body.md': ON_SCREEN, 'screenshot-1.png': SHOT_1 }), pullBody: ON_SCREEN,
  }, /wait reason holds.*\bscreenshot\b/);

  const { reason, calls } = pinnedDelivery(merge, { pinnedPull: pull }, options);
  assert.equal(reason, '', 'a Herdr job may merge the exact checked head without a hold');
  assert.deepEqual(calls.filter(providerRead).length, 1);
  assert.ok(!calls.includes(PR_VIEW), 'the exact route reads queue state with the head');
  assert.ok(calls.some((call) => isGraphql(call) && call.endsWith('-F number=7')), 'the job card is an independent read');
  for (const read of [
    'git rev-parse HEAD', 'gh pr view 12 --json body', REQUIRED_BRANCH_READ, REQUIRED_RULES_READ, REQUIRED_CHECKS_READ,
  ]) assert.ok(calls.includes(read), read);
  for (const { label, verdict, cause, reads } of refusals) {
    assert.match(verdict.reason, cause, label);
    for (const read of reads) assert.ok(verdict.calls.some(read), `${label}: ${JSON.stringify(verdict.calls)}`);
  }
  return calls;
}

test('929 pins a Codex Herdr pull request merge to the checked head', (t) => {
  const appRun = { verified: false, appRun: true };
  const admitted = pinnedDelivery(MERGE, {}, appRun);
  assert.equal(admitted.reason, '', 'legacy auto-merge');
  assert.ok(admitted.calls.includes(PR_VIEW), 'legacy auto-merge reads its pull request');
  const denied = pinnedDelivery(PINNED_MERGE, { pinnedPull: PINNED_PULL }, appRun);
  assert.match(denied.reason, /(?:merges only|verified Codex Herdr).*--auto|(?:only|requires).*Codex Herdr/i, 'pinned merge outside verified Herdr');
  assert.ok(!denied.calls.some(pinnedPullRead));
  assert.match(blockReason(PINNED_MERGE, inJob), /^gh pr merge:.*(?:--auto|Codex Herdr)/i, 'ordinary unbounded merge');

  assert.ok(pinnedMergeCases(t, {}).includes('git rev-parse --show-toplevel'), 'the verified route reads its bound worktree');
});

// new behaviour: a coordinated Claude Code Herdr job merges as a Codex Herdr job does, only through the pinned merge of
// the current head once its required checks pass, the guard reading the show-me-first marker at submission; the
// legacy `--auto` merge, a stale pin, a merge queue, an existing auto-merge, failed checks and a marker refuse.
test('967 a Claude Code Herdr job merges only the pinned checked head', (t) => {
  pinnedMergeCases(t, { verified: false, coordinated: true });
});

// new behaviour: a Herdr job, under either mark, publishes only the head its review named. The saved write-up and the
// published body each carry one `Reviewed commit:` line under Evidence equal to the checked HEAD; a stale commit refuses
// naming both commits, and a missing or doubled line refuses as naming no single reviewed commit.
test('967 a Herdr publication needs the head its review named', (t) => {
  // The job's commit before a same-patch rebase moved it to HEAD_COMMIT, and the commit HEAD_COMMIT adds an empty
  // commit to.
  const beforeRebase = 'b4ea5e00'.repeat(5);
  const beforeEmpty = 'e3e3e3e3'.repeat(5);
  const reviewed = `Reviewed commit: ${HEAD_COMMIT}\n`;
  const variants = [
    ['naming the commit before a same-patch rebase', edit(CLEAR, reviewed, `Reviewed commit: ${beforeRebase}\n`), `covered ${beforeRebase}`],
    ['naming the commit HEAD adds an empty commit to', edit(CLEAR, reviewed, `Reviewed commit: ${beforeEmpty}\n`), `covered ${beforeEmpty}`],
    ['without the line', edit(CLEAR, reviewed, ''), 'no single'],
    ['with the line doubled', edit(CLEAR, reviewed, reviewed + reviewed), 'no single'],
    ['malformed, an abbreviated commit', edit(CLEAR, reviewed, `Reviewed commit: ${HEAD_COMMIT.slice(0, 12)}\n`), 'no single'],
    ['malformed, an upper-case commit', edit(CLEAR, reviewed, `Reviewed commit: ${HEAD_COMMIT.toUpperCase()}\n`), 'no single'],
    ['with the line only under Review', edit(edit(CLEAR, reviewed, ''), `${REVIEW_LINE}\n`, `${REVIEW_LINE}\n${reviewed}`), 'no single'],
  ];
  const verdict = (reason) => {
    if (reason === '') return 'admitted';
    const covered = /the review covered ([0-9a-f]{40}), not ([0-9a-f]{40})/.exec(reason);
    if (covered && covered[2] === HEAD_COMMIT) return `covered ${covered[1]}`;
    return /names no single Reviewed commit/.test(reason) ? 'no single' : reason;
  };
  const actual = {};
  const expected = {};
  for (const [mark, options] of [['Codex Herdr', {}], ['Claude Code coordinated', { verified: false, coordinated: true }]]) {
    const judge = (saved, published) => verdict(pinnedDelivery(PINNED_MERGE, {
      pinnedPull: PINNED_PULL, cwd: sessionDirectory({ 'body.md': saved }, (remove) => t.after(remove)), pullBody: published,
    }, options).reason);
    actual[`${mark}: both bodies naming HEAD`] = judge(CLEAR, CLEAR);
    expected[`${mark}: both bodies naming HEAD`] = 'admitted';
    for (const [label, body, outcome] of variants) {
      actual[`${mark}: the saved write-up ${label}`] = judge(body, CLEAR);
      expected[`${mark}: the saved write-up ${label}`] = outcome;
      actual[`${mark}: the published body ${label}`] = judge(CLEAR, body);
      expected[`${mark}: the published body ${label}`] = outcome;
    }
  }
  assert.deepEqual(actual, expected);
});

// new behaviour: a Herdr job's direct push to main, under either mark and in that mark's own direct form, publishes only
// the head its review named: the saved write-up of the version the squash was made from carries one `Reviewed commit:`
// line equal to that version, a line naming another commit refuses naming both, and a missing or doubled line refuses
// as naming no single reviewed commit.
test('967 a Herdr direct push to main needs the head its review named', (t) => {
  const reviewed = `Reviewed commit: ${HEAD_COMMIT}\n`;
  const document = edit(CLEAR, 'tier=code', 'tier=document');
  const variants = [
    ['naming the version the squash was made from', document, 'admitted'],
    ['naming another commit', edit(document, reviewed, `Reviewed commit: ${ANSWERED_COMMIT}\n`), `covered ${ANSWERED_COMMIT}`],
    ['without the line', edit(document, reviewed, ''), 'no single'],
    ['with the line doubled', edit(document, reviewed, reviewed + reviewed), 'no single'],
  ];
  const verdict = (reason) => {
    if (reason === '') return 'admitted';
    const covered = /the review covered ([0-9a-f]{40}), not ([0-9a-f]{40})/.exec(reason);
    if (reason.startsWith(PRE_APPROVED) && covered && covered[2] === HEAD_COMMIT) return `covered ${covered[1]}`;
    return reason.startsWith(PRE_APPROVED) && /names no single Reviewed commit/.test(reason) ? 'no single' : reason;
  };
  const marks = [
    ['Claude Code coordinated', 'git push origin HEAD:main', { verified: false, coordinated: true }],
    ['Codex Herdr', `git push --no-follow-tags origin ${SQUASH_COMMIT}^{object}:refs/heads/main`, {}],
  ];
  const actual = {};
  const expected = {};
  for (const [mark, command, options] of marks) {
    for (const [label, body, outcome] of variants) {
      const cwd = sessionDirectory({ 'body.md': body }, (remove) => t.after(remove));
      actual[`${mark}: the saved write-up ${label}`] = verdict(pinnedDelivery(command, { cwd, squash: {}, localHead: SQUASH_COMMIT }, options).reason);
      expected[`${mark}: the saved write-up ${label}`] = outcome;
    }
  }
  assert.deepEqual(actual, expected);
});

// existing behaviour: a Herdr job's unmarked card still waits on a failed check and on a missing screenshot.
test('967 a Herdr job still holds a failed check or a missing screenshot', (t) => {
  const pull = {
    number: 12, state: 'OPEN', headRefName: 'job/7', baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    headRepository: { id: ORIGIN_ID }, isCrossRepository: false, headRefOid: HEAD_COMMIT, isDraft: false, autoMergeRequest: null,
    isInMergeQueue: false, isMergeQueueEnabled: false,
  };
  const pinnedMerge = `gh pr merge --squash --delete-branch --match-head-commit ${HEAD_COMMIT} 12`;
  const marks = [
    ['a coordinated Claude Code job', { verified: false, coordinated: true }, [[READY, { pinnedPull: { ...pull, isDraft: true } }], [pinnedMerge, { pinnedPull: pull }]]],
    ['a Codex Herdr job', {}, [[READY, { pinnedPull: { ...pull, isDraft: true } }], [pinnedMerge, { pinnedPull: pull }]]],
  ];
  const holding = [
    ['a failed check', { 'body.md': edit(CLEAR, 'Failed: none', 'Failed: lint, cause unknown') }, ['check']],
    ['work on screen with no screenshot', { 'body.md': ON_SCREEN }, ['screenshot']],
  ];
  for (const [mark, options, commands] of marks) {
    for (const [label, files, held] of holding) {
      const cwd = sessionDirectory(files, (remove) => t.after(remove));
      for (const [command, fixture] of commands) {
        const { reason } = pinnedDelivery(command, { cwd, ...fixture }, options);
        assert.ok(reason.startsWith(PRE_APPROVED), `${mark}, ${label}, ${command}: ${JSON.stringify(reason)}`);
        assert.deepEqual(WAIT_KEYS.filter((key) => namesReason(reason, key)), held, `${mark}, ${label}, ${command}: ${JSON.stringify(reason)}`);
      }
    }
  }
});

// new behaviour: in a Herdr job only the card's show-me-first marker holds finished work for the owner, so neither a
// sign-off tier, a hard Undo answer, a Not done item nor the wait level always holds an unmarked card; a session
// without the Herdr mark keeps today's policy, under which always publishes nothing.
test("967 a Herdr job's unmarked card waits on no review tier or level", (t) => {
  const always = '{"version":1,"waitForOwner":"always"}';
  const draft = {
    number: 12, state: 'OPEN', headRefName: 'job/7', baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    headRepository: { id: ORIGIN_ID }, isCrossRepository: false, headRefOid: HEAD_COMMIT, isDraft: true, autoMergeRequest: null,
    isInMergeQueue: false, isMergeQueueEnabled: false,
  };
  const marks = [
    ['a coordinated Claude Code job', { verified: false, coordinated: true }, { pinnedPull: draft }],
    ['a Codex Herdr job', {}, { pinnedPull: draft }],
  ];
  const writeUps = [
    ['a sign-off review tier', edit(CLEAR, 'tier=code', 'tier=sign-off')],
    ['an Undo answer of hard', edit(CLEAR, UNDO_EASY, UNDO_HARD)],
    ['a Not done item', edit(CLEAR, 'Nothing', '- The Windows suite was skipped.')],
  ];
  for (const [label, body] of writeUps) {
    const fixture = { cwd: sessionDirectory({ 'body.md': body }, (remove) => t.after(remove)), pullBody: body, settingText: always };
    for (const [mark, options, pinned] of marks) {
      assert.equal(pinnedDelivery(READY, { ...fixture, ...pinned }, options).reason, '', `${mark}, ${label}`);
    }
    assert.equal(
      pinnedDelivery(READY, fixture, { verified: false }).reason,
      `${PRE_APPROVED}publishes nothing: pre-approved run disabled on fetched main; waitForOwner must be on-screen or when-needed in .agents/factory-settings.json on main`,
      `a session without the Herdr mark, ${label}`,
    );
  }
});

// new behaviour: only the owner removes the show-me-first marker, so a Herdr job's plainly written command that would
// clear it from its card, delete or rename the label, or switch it off through the owner queue or the Queue panel is
// refused with one message, whether gh is given -R or --repo or runs behind a plain env prefix and whether a gh api body
// is a field or an --input file, while adding the marker, removing or editing another label, recolouring or
// redescribing the marker, an issue write that leaves labels alone, reading labels and moving the card stay open, and a
// session without the Herdr mark is not refused this way. LA_1 is the marker label's node id.
test('967 a Herdr job never clears the show-me-first marker', (t) => {
  const NEVER = 'a Herdr job never clears the show-me-first marker: the owner removes it';
  const cwd = sessionDirectory({ 'body.md': CLEAR }, (remove) => t.after(remove));
  writeFileSync(join(cwd, 'remove.graphql'), 'mutation { removeLabelsFromLabelable(input: { labelableId: "I_7", labelIds: ["LA_1"] }) { clientMutationId } }\n');
  mkdirSync(join(cwd, 'folder.graphql'));
  // `gh api --input` bodies: GraphQL requests and issue writes.
  const bodies = {
    'remove.json': { query: 'mutation { removeLabelsFromLabelable(input: { labelableId: "I_7", labelIds: ["LA_1"] }) { clientMutationId } }' },
    'delete.json': { query: 'mutation { deleteLabel(input: { id: "LA_1" }) { clientMutationId } }' },
    'rename.json': { query: 'mutation { updateLabel(input: { id: "LA_1", name: "shown" }) { label { name } } }' },
    'labels.json': { labels: ['bug'] },
    'title.json': { title: 'A clearer title' },
  };
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(cwd, name), `${JSON.stringify(body)}\n`);
  const marks = [
    ['a coordinated Claude Code job', { verified: false, coordinated: true }],
    ['a Codex Herdr job', {}],
  ];
  const ISSUE = 'repos/acme/widgets/issues/7';
  const QUEUE = 'node .agents/herdr/fabraik-queue/queue.mjs show-first acme/widgets#7';
  const refused = [
    'gh issue edit 7 --remove-label show-me-first',
    'gh issue edit 7 --remove-label area:skills,show-me-first',
    'gh issue edit 7 --remove-label "area:skills, show-me-first"',
    'gh issue edit 7 --remove-label Show-Me-First',
    'gh label delete show-me-first --yes',
    'gh label edit show-me-first --name shown',
    `gh api -X PUT ${ISSUE}/labels -f labels[]=bug`,
    `gh api --method PATCH ${ISSUE}/labels -f labels[]=bug`,
    `gh api -X DELETE ${ISSUE}/labels`,
    `gh api -X PUT ${ISSUE}/labels/show-me-first`,
    `gh api -X PATCH ${ISSUE}/labels/show-me-first`,
    `gh api --method DELETE ${ISSUE}/labels/show-me-first`,
    `gh api -X PATCH ${ISSUE} -f labels[]=bug`,
    `gh api -X POST ${ISSUE} -f labels[]=bug`,
    `gh api -X PATCH ${ISSUE} --input issue.json`,
    `gh api --method POST ${ISSUE} --input issue.json`,
    `gh api graphql -f query='mutation { removeLabelsFromLabelable(input: { labelableId: "I_7", labelIds: ["LA_1"] }) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { clearLabelsFromLabelable(input: { labelableId: "I_7" }) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { updateIssue(input: { id: "I_7", labelIds: [] }) { clientMutationId } }'`,
    'gh api graphql -F query=@remove.graphql',
    'gh api graphql -F query=@missing.graphql',
    'gh api graphql -F query=@folder.graphql',
    'gh -R acme/widgets issue edit 7 --remove-label show-me-first',
    'gh --repo acme/widgets issue edit 7 --remove-label show-me-first',
    'gh issue -R acme/widgets edit 7 --remove-label show-me-first',
    'env gh issue edit 7 --remove-label show-me-first',
    'env GH_REPO=acme/widgets gh issue edit 7 --remove-label show-me-first',
    'gh api graphql --input remove.json',
    'gh api graphql --input delete.json',
    'gh api graphql --input rename.json',
    `gh api graphql -f query='mutation { deleteLabel(input: { id: "LA_1" }) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { updateLabel(input: { id: "LA_1", name: "shown" }) { label { name } } }'`,
    'gh api -X DELETE repos/acme/widgets/labels/show-me-first',
    'gh api -X PATCH repos/acme/widgets/labels/show-me-first -f new_name=shown',
    `gh api -X PATCH ${ISSUE} --input labels.json`,
    'node scripts/owner-queue.mjs show-first --card=7 --state=off',
    'node scripts/owner-queue.mjs show-first --card 7 --state off',
    `${QUEUE} off --home queue-home`,
  ];
  const allowed = [
    'gh issue edit 7 --add-label show-me-first',
    'gh issue edit 7 --remove-label area:skills',
    'gh issue edit 7 --remove-label bug',
    'gh -R acme/widgets issue edit 7 --remove-label bug',
    'env gh issue edit 7 --add-label show-me-first',
    `gh api -X DELETE ${ISSUE}/labels/bug`,
    `gh api --method DELETE ${ISSUE}/labels/bug`,
    'gh label edit show-me-first --color ff0000',
    'gh label edit show-me-first --description "The owner sees it first"',
    `gh api -X PATCH ${ISSUE} --input title.json`,
    `gh api ${ISSUE}/labels`,
    `gh api graphql -f query='mutation { addLabelsToLabelable(input: { labelableId: "I_7", labelIds: ["LA_1"] }) { clientMutationId } }'`,
    `${QUEUE} on --home queue-home`,
    'node scripts/board-move.mjs 7 "In review"',
  ];
  const outcomes = (pick) => Object.fromEntries(marks.flatMap(([mark, options]) => [...refused, ...allowed].map((command) => [`${mark}: ${command}`, pick(command, options)])));
  assert.deepEqual(
    outcomes((command, options) => pinnedDelivery(command, { cwd }, options).reason),
    outcomes((command) => (refused.includes(command) ? NEVER : '')),
  );
  assert.equal(pinnedDelivery('gh issue edit 7 --remove-label show-me-first', { cwd }, { verified: false }).reason, '', 'a session without the Herdr mark');
});

// new behaviour: a Herdr job reads no note, receipt or menu answer as approval: only its own card's show-me-first
// marker holds its finished work. A marked card refuses, naming the marker alone, at ready, at the pinned merge and at a
// coordinated job's direct push, whatever local owner-answer note, owner answer comment or fix record it holds, a note
// the guard once refused as unreadable included; once the owner removes the marker the next repaired head is admitted.
// A session no coordinator started never reads the note and still reads an owner answer comment.
test('967 a Herdr job reads no note, receipt or menu answer as approval', (t) => {
  const cleanup = (remove) => t.after(remove);
  const DIRECT = 'git push origin HEAD:main';
  const identity = identityOf(CLEAR);
  const marked = { issue: { labels: labelsOf('show-me-first') } };
  const noteAt = (card, head, words = 'yes', named = identity) => `${ownerAnswerLine(card, head, named, words)}\n`;
  const answerAt = (head) => cardComment('owner', '2026-11-04T12:30:00Z', ownerAnswer(head, identity, 'yes'));
  const FIX = cardComment('owner', '2026-11-04T12:45:00Z', fixBuilt(ANSWERED_COMMIT, 'shortened the title'));
  // A session whose saved write-up is CLEAR at HEAD and at ANSWERED_COMMIT, holding `note` as its local owner-answer
  // note where one is given.
  const session = (note, rest = {}) => {
    const cwd = sessionDirectory({ 'body.md': CLEAR }, cleanup, { 'body.md': CLEAR });
    if (note !== undefined) writeFileSync(join(cwd, '.claude/worklog/job_7-owner-answer.md'), note);
    return { cwd, ...rest };
  };
  // [label, fixture, admitted]: a marked card is refused whatever it records; an unmarked one is admitted.
  const versions = [
    ['a marked card with a note naming HEAD and its saved identity', session(noteAt(7, HEAD_COMMIT), marked), false],
    ['a marked card with an owner answer comment naming HEAD', session(undefined, { ...marked, comments: [OWN_CLAIM, answerAt(HEAD_COMMIT)] }), false],
    [
      'a marked card with a note naming HEAD, an answer comment naming ANSWERED_COMMIT and a fix record from it naming HEAD',
      session(noteAt(7, HEAD_COMMIT), { ...marked, comments: [OWN_CLAIM, answerAt(ANSWERED_COMMIT), FIX] }),
      false,
    ],
    ['a marked card with a note naming ANSWERED_COMMIT and a fix record from it naming HEAD', session(noteAt(7, ANSWERED_COMMIT), { ...marked, comments: [OWN_CLAIM, FIX] }), false],
    ['a marked card with a note naming card 8', session(noteAt(8, HEAD_COMMIT), marked), false],
    ['a marked card with a note naming another identity', session(noteAt(7, HEAD_COMMIT, 'yes', identityOf(SIGN_OFF)), marked), false],
    ['a marked card with a note over 4 KiB', session(noteAt(7, HEAD_COMMIT, `yes ${'x'.repeat(4096)}`), marked), false],
    ['a marked card with a binary note', session(Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x80]), marked), false],
    ['a marked card with a note with blank words', session(noteAt(7, HEAD_COMMIT, '  '), marked), false],
    [
      'the marker removed, the next repaired head after a note and an answer comment naming ANSWERED_COMMIT and a fix record from it',
      session(noteAt(7, ANSWERED_COMMIT), { comments: [OWN_CLAIM, answerAt(ANSWERED_COMMIT), FIX] }),
      true,
    ],
  ];
  const draft = { pinnedPull: { ...PINNED_PULL, isDraft: true } };
  const ready = { pinnedPull: PINNED_PULL };
  const marks = [
    ['a coordinated Claude Code job', { verified: false, coordinated: true }, [[READY, draft], [PINNED_MERGE, ready], [DIRECT, { squash: {} }]]],
    ['a Codex Herdr job', {}, [[READY, draft], [PINNED_MERGE, ready]]],
  ];
  // The refusal naming only the marker, with nothing after it.
  const markerHold = (command) => (command === DIRECT
    ? `${PRE_APPROVED}pushes nothing to main while a wait reason holds for ${HEAD_COMMIT}: show-me-first`
    : heldRefusal(command, ['show-me-first']));
  const outcomes = (pick) => Object.fromEntries(marks.flatMap(([mark, options, commands]) => commands.flatMap(([command, pinned]) => versions.map(
    ([label, fixture, admitted]) => [`${mark}, ${label}: ${command}`, pick(command, { ...fixture, ...pinned }, options, admitted)],
  ))));
  assert.deepEqual(
    outcomes((command, fixture, options) => pinnedDelivery(command, fixture, options).reason),
    outcomes((command, fixture, options, admitted) => (admitted ? '' : markerHold(command))),
  );
  // A session no coordinator started reads card comments as before and never the note: the note alone is the held
  // refusal with nothing after it, and an owner answer comment admits.
  const atHead = ownerAnswerLine(7, HEAD_COMMIT, identityOf(SIGN_OFF), 'yes');
  const signedOff = (note, rest = {}) => {
    const cwd = sessionDirectory({ 'body.md': SIGN_OFF }, cleanup);
    if (note !== undefined) writeFileSync(join(cwd, '.claude/worklog/job_7-owner-answer.md'), note);
    return { cwd, pullBody: SIGN_OFF, ...rest };
  };
  const uncoordinated = [
    ['the note alone', signedOff(`${atHead}\n`)],
    ['a comment alone', signedOff(undefined, { comments: [OWN_CLAIM, cardComment('owner', '2026-11-04T12:30:00Z', atHead)] })],
  ];
  const uncoordinatedOutcomes = (pick) => Object.fromEntries([READY, MERGE].flatMap((command) => uncoordinated.map(([label, fixture]) => [`${label}: ${command}`, pick(command, label, fixture)])));
  assert.deepEqual(
    uncoordinatedOutcomes((command, label, fixture) => judged(command, fixture).reason),
    uncoordinatedOutcomes((command, label) => (label === 'the note alone' ? heldRefusal(command, ['sign-off']) : '')),
  );
});

test('929 pins a Codex Herdr direct push to the checked squash', (t) => {
  const pushFor = (source, destination = 'refs/heads/main') => `git push --no-follow-tags origin ${source}^{object}:${destination}`;
  const direct = pushFor(SQUASH_COMMIT);
  const bare = `git push origin ${SQUASH_COMMIT}:refs/heads/main`;
  const legacy = 'git push origin HEAD:main';
  const document = edit(CLEAR, 'tier=code', 'tier=document');
  const cwd = sessionDirectory({ 'body.md': document }, (remove) => t.after(remove));
  const proof = { cwd, squash: {}, localHead: SQUASH_COMMIT };
  const branchLapse = /(?:pushes only its own branch|(?:push|direct).*(?:literal|refspec|form)|plain command|command on its own)/i;
  const sourceLapse = /(?:checked[- ]out squash|squash (?:commit|object|head)|source object|literal source)/i;
  const gateLapse = /^a pre-approved run session pushes main only where the pre-push hook on the remote's main judges it: /;
  const holdLapse = /wait reason holds.*\bshow-me-first\b/;
  const squashRead = (call) => call === CHECKED_SQUASH_READ;

  assert.equal(pinnedDelivery(legacy, proof, { verified: false, coordinated: true }).reason, '', 'coordinated Claude direct route');
  assert.match(pinnedDelivery(direct, proof, { verified: false, appRun: true }).reason, branchLapse, 'bounded Desktop cannot push directly');
  assert.match(pinnedDelivery(direct, proof, { verified: false, coordinated: true }).reason, branchLapse, 'coordinated Claude retains its legacy form');
  for (const appRun of [false, true]) {
    assert.equal(blockReason(legacy, inJob, { appRun }), '', 'unbounded direct push remains under the remote-main gate');
    assert.equal(blockReason(bare, inJob, { appRun }), '', 'unbounded literal refspec remains under the remote-main gate');
  }
  assert.equal(pinnedDelivery(PUSH, proof).reason, '', 'the ordinary job-branch push');

  const refusals = [];
  const refuse = (label, command, fixture, cause, reads = []) => {
    const verdict = pinnedDelivery(command, { ...proof, ...fixture });
    refusals.push({ label, verdict, cause, reads });
  };
  refuse('a different full source object', pushFor(ANSWERED_COMMIT), {}, sourceLapse, [squashRead]);
  refuse('the local checkout has moved to another full object', direct, {
    localHead: ANSWERED_COMMIT, squash: { commit: ANSWERED_COMMIT },
  }, sourceLapse, [squashRead]);
  for (const [label, command] of [
    ['legacy unpinned source and destination', legacy],
    ['former bare direct route', bare],
    ['bare source with tag following disabled', direct.replace('^{object}', '')],
    ['omission leaves tag following to Git configuration', direct.replace('--no-follow-tags ', '')],
    ['an override re-enables tag following', direct.replace(' origin ', ' --follow-tags origin ')],
    ['alternate revision suffix', direct.replace('^{object}', '^{commit}')],
    ['abbreviated source', pushFor(SQUASH_COMMIT.slice(0, 12))],
    ['symbolic source', pushFor('HEAD')],
    ['branch ref as source', pushFor('refs/heads/job/7')],
    ['noncanonical destination', pushFor(SQUASH_COMMIT, 'main')],
    ['shell redirection', `${direct} >/dev/null`],
    ['an extra shell command', `${direct} && pwd`],
  ]) refuse(label, command, {}, branchLapse);
  refuse('unarmed gate', direct, { squash: { hooksPath: null } }, gateLapse, [(call) => call === 'git config --null --get core.hooksPath']);
  refuse('changed pre-push hook bytes', direct, { squash: { edited: ['pre-push'] } }, gateLapse, [(call) => call.startsWith('git hash-object --no-filters -- ')]);
  refuse('an unresolved ready pull request', direct, {
    openPulls: [{ number: 12, isDraft: false, autoMergeRequest: null, isCrossRepository: false }],
  }, /pull request #12 is ready or has a merge queued/, [isPrList]);
  for (const { label, fixture } of heldPinnedVersions(t, document)) refuse(label, direct, fixture, holdLapse, [squashRead]);

  const { reason, calls } = pinnedDelivery(direct, proof);
  assert.equal(reason, '', 'verified Codex Herdr may push the exact checked squash without a hold');
  for (const read of [
    'git rev-parse --show-toplevel', CHECKED_SQUASH_READ,
    'git --no-replace-objects rev-parse --verify --quiet ORIG_HEAD^{commit}',
    `git --no-replace-objects rev-parse HEAD^{tree} ${HEAD_COMMIT}^{tree}`,
    'git --no-replace-objects rev-parse HEAD:.githooks refs/remotes/origin/main:.githooks',
    `executable ${join(cwd, '.githooks', 'pre-push')}`,
  ]) assert.ok(calls.includes(read), read);
  assert.ok(calls.some(isPrList), 'the direct route checks for an unresolved pull request');
  for (const { label, verdict, cause, reads } of refusals) {
    assert.match(verdict.reason, cause, label);
    for (const read of reads) assert.ok(verdict.calls.some(read), `${label}: ${JSON.stringify(verdict.calls)}`);
  }

  const sha256Squash = '5f842a7104c9b3de6a20f58b1c4d796e0a21c5b87d9e3f4069a17c2f8d5b0e36';
  const sha256Head = 'b'.repeat(64);
  const sha256Tree = 'd'.repeat(64);
  const sha256HooksTree = 'c'.repeat(64);
  writeSavedBody(cwd, edit(document, `Reviewed commit: ${HEAD_COMMIT}\n`, `Reviewed commit: ${sha256Head}\n`), sha256Head);
  assert.equal(
    pinnedDelivery(pushFor(sha256Squash), {
      cwd,
      objectFormat: 'sha256',
      settingOid: 'a'.repeat(64),
      localHead: sha256Squash,
      squash: {
        commit: sha256Squash,
        origHead: sha256Head,
        trees: [sha256Tree, sha256Tree],
        githooks: [sha256HooksTree, sha256HooksTree],
        mainHooks: [['100755', 'blob', '5'.repeat(64), 'pre-push']],
      },
    }).reason,
    '',
    'verified Codex Herdr may push the full SHA-256 ID of the checked squash',
  );
});

const savedBodyPath = (cwd, head = HEAD_COMMIT) => join(cwd, REVIEW_FOLDER.replace(HEAD_COMMIT, head), 'body.md');
function writeSavedBody(cwd, body, head) {
  const file = savedBodyPath(cwd, head);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// Git runs a hook only where the session user may execute it, so the guard's own probe, not the stand-in, judges a real
// pre-push in a temporary checkout: 0o611 gives group and other an execute bit but not the owner, the session user, so
// only an access probe withholds it. Root may execute the 0o611 file, since Linux grants root execute access where any
// execute bit is set, and Windows runs a hook without a bit.
const probeSkip = process.platform === 'win32'
  ? 'Windows has no execute permission for Git to check'
  : process.getuid?.() === 0 && 'root may execute the 0o611 pre-push, since group and other hold the execute bit and Linux grants root execute access where any execute bit is set';
test('the direct push\'s pre-push probe asks for execute access as the session user', { skip: probeSkip }, (t) => {
  const judgedWith = (mode) => {
    const cwd = sessionDirectory({ 'body.md': CLEAR }, (remove) => t.after(remove));
    mkdirSync(join(cwd, '.githooks'));
    writeFileSync(join(cwd, '.githooks/pre-push'), '#!/bin/sh\n');
    chmodSync(join(cwd, '.githooks/pre-push'), mode);
    const { executable, ...preApproved } = preApprovedRun({ cwd, squash: {} }).preApproved;
    return blockReason('git push origin HEAD:main', { ...inJob, cwd }, { preApproved: { ...preApproved, coordinated: true } });
  };
  assert.deepEqual(
    { executable: judgedWith(0o755), withheld: judgedWith(0o611) },
    { executable: '', withheld: `${PRE_APPROVED}pushes main only where the pre-push hook on the remote's main judges it: .githooks/pre-push is not executable` },
  );
});

// The guard's own folder walk, not the stand-in, lists a real top .githooks: nested regular files match fetched main's
// tree by their slash-separated names and modes, and neither a pre-push that is a symbolic link to an executable file
// nor a .githooks that is a symbolic link to a matching folder is followed. Windows makes a symbolic link only for an
// account allowed to create one, so a linked case is left out only where Windows refuses the link.
test('the direct push\'s hooks folder walk lists nested regular files and refuses a linked pre-push', async (t) => {
  const judgedWith = (build) => {
    const cwd = sessionDirectory({ 'body.md': CLEAR }, (remove) => t.after(remove));
    build(cwd);
    const mainHooks = [['100755', 'blob', '5'.repeat(40), 'pre-push'], ['100644', 'blob', '8'.repeat(40), 'sub/x']];
    const { listHooks, ...preApproved } = preApprovedRun({ cwd, squash: { mainHooks } }).preApproved;
    return blockReason('git push origin HEAD:main', { ...inJob, cwd }, { preApproved: { ...preApproved, platform: process.platform, coordinated: true } });
  };
  // Each file's disk bits match the mode fetched main's tree records for it.
  const writeAt = (path, text, mode) => {
    writeFileSync(path, text);
    chmodSync(path, mode);
  };
  // A hooks folder holding sub/x, and a pre-push unless `prePush` is false.
  const hooksAt = (folder, prePush = true) => {
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeAt(join(folder, 'sub', 'x'), 'x\n', 0o654);
    if (prePush) writeAt(join(folder, 'pre-push'), '#!/bin/sh\n', 0o755);
  };
  const linked = (st, target, path, type) => {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      st.skip('this Windows account may not create symbolic links (EPERM)');
      return false;
    }
  };
  const UNCOMMITTED = `${PRE_APPROVED}pushes main only where the pre-push hook on the remote's main judges it: .githooks has uncommitted changes`;
  await t.test('regular files', () => {
    assert.equal(judgedWith((cwd) => hooksAt(join(cwd, '.githooks'))), '');
  });
  await t.test('a linked pre-push', (st) => {
    let made = false;
    const reason = judgedWith((cwd) => {
      hooksAt(join(cwd, '.githooks'), false);
      writeAt(join(cwd, 'linked-pre-push'), '#!/bin/sh\n', 0o755);
      made = linked(st, join(cwd, 'linked-pre-push'), join(cwd, '.githooks', 'pre-push'), 'file');
    });
    if (made) assert.equal(reason, UNCOMMITTED);
  });
  await t.test('a linked .githooks', (st) => {
    let made = false;
    const reason = judgedWith((cwd) => {
      hooksAt(join(cwd, 'linked-hooks'));
      made = linked(st, join(cwd, 'linked-hooks'), join(cwd, '.githooks'), 'dir');
    });
    if (made) assert.equal(reason, UNCOMMITTED);
  });
});

// ── the former approval record and chat approval ────────────────────────────
// No rule names them any more, so each command meets only the rules it would meet without them. The record prefix
// and the hook's file name are built in pieces so no shell command written while editing this file holds them.

const RECORD_PREFIX = 'Appr' + 'oved:';
const HOOK_FILE = '.claude/hooks/approve-ahead' + '.mjs';

test('the guard judges a command holding the former record prefix, or naming the former chat approval files, like any other command', () => {
  const line = `${RECORD_PREFIX} card=7 edited=none`;
  const ordinary = [
    `gh issue comment 7 --body "${line}"`,
    `gh issue comment 7 --body-file - <<'EOF'\n${line} merge=screenshot\nEOF`,
    `echo '${line}' > record.md`,
    `grep -rn "${RECORD_PREFIX}" .claude/worklog`,
    `node ${HOOK_FILE} < x`,
    `node -e "import('./scripts/lib/chat-approval.mjs')"`,
    'node --test scripts/lib/chat-approval.test.mjs',
  ];
  const sessions = {
    'an unmarked session': (command) => ({ reason: blockReason(command, inJob), calls: [] }),
    'a pre-approved run session': (command) => judged(command),
    'a session whose run mark cannot be read': (command) => ({ reason: blockReason(command, inJob, { runMarkUnreadable: 'its transcript could not be read (ENOENT)' }), calls: [] }),
  };
  for (const command of ordinary) {
    for (const [session, judge] of Object.entries(sessions)) {
      const { reason, calls } = judge(command);
      assert.equal(reason, '', `${session}: ${JSON.stringify(command)}`);
      assert.deepEqual(calls, [], `${session}: ${JSON.stringify(command)}`);
    }
  }
  // A command the guard gates meets its own rule, whatever record text it carries.
  assert.equal(blockReason(`gh pr create --title t --body "${line}"`, inJob), REASON_CREATE);
  assert.equal(blockReason(`git commit --no-verify -m "${line}"`, inJob), REASON_COMMIT_NO_VERIFY);
  assert.equal(judged(`gh pr create --draft --title t --body "${line}"`).reason, CREATE_ONLY);
});

// The launcher repeats this matrix to protect its separate wire.
test('ANTI-REGRESSION: fetched-main waitForOwner gates publication', async (t) => {
  const disabled = 'pre-approved run disabled on fetched main; waitForOwner must be on-screen or when-needed in .agents/factory-settings.json on main';
  const unavailable = 'pre-approved run setting unavailable on fetched main; fetch origin and verify .agents/factory-settings.json on main';
  const behind = `pre-approved run setting unreadable by the checkout at ${dirname(dirname(CODE_DIRECTORY))}, which is older than fetched main; bring that checkout up to date with fetched main, then retry`;
  const enabled = '{"version":1,"waitForOwner":"when-needed"}';
  const off = '{"version":1,"waitForOwner":"always"}';
  const newerKey = '{"version":1,"waitForOwner":"when-needed","synthetic-setting-secret":true}';
  const cases = [
    { name: '40-digit OID true', fixture: {} },
    { name: '64-digit OID true', fixture: { settingOid: 'c'.repeat(64) } },
    { name: 'executable regular mode', fixture: { settingMode: '100755\n' } },
    { name: 'absent key means always', fixture: { settingText: '{"version":1}' }, error: disabled },
    { name: 'absent file means always', fixture: { settingMode: '' }, error: disabled },
    { name: 'always', fixture: { settingText: off }, error: disabled },
    { name: 'retired preApprovedRun true', fixture: { settingText: '{"version":1,"preApprovedRun":true}' }, error: unavailable },
    { name: 'retired preApprovedRun false', fixture: { settingText: '{"version":1,"preApprovedRun":false}' }, error: unavailable },
    { name: 'unreadable ref', fixture: { settingError: 'ref' }, error: unavailable },
    { name: 'unreadable tree', fixture: { settingError: 'tree' }, error: unavailable },
    { name: 'unreadable blob', fixture: { settingError: 'blob' }, error: unavailable },
    { name: 'invalid OID', fixture: { settingOid: 'synthetic-setting-secret' }, error: unavailable },
    { name: 'symlink', fixture: { settingMode: '120000\n' }, error: unavailable },
    { name: 'directory', fixture: { settingMode: '040000\n' }, error: unavailable },
    { name: 'malformed JSON', fixture: { settingText: '{synthetic-setting-secret' }, error: unavailable },
    { name: 'nonobject JSON', fixture: { settingText: '["synthetic-setting-secret"]' }, error: unavailable },
    { name: 'null JSON', fixture: { settingText: 'null' }, error: unavailable },
    { name: 'wrong value', fixture: { settingText: '{"version":1,"waitForOwner":"synthetic-setting-secret"}' }, error: unavailable },
    { name: 'near key', fixture: { settingText: '{"version":1,"waitForOwners":"always"}' }, error: unavailable },
    { name: 'invalid schema', fixture: { settingText: '{"version":2,"waitForOwner":"when-needed"}' }, error: unavailable },
    // The guard runs the code of the root checkout from a job worktree whose branch is ahead of fetched main.
    { name: 'newer key, code checkout behind, session checkout ahead', fixture: { settingText: newerKey, ancestry: '0\t3\n', sessionAncestry: '1\t0\n' }, error: behind },
    { name: 'newer key, code checkout current, session checkout behind', fixture: { settingText: newerKey, ancestry: '0\t0\n', sessionAncestry: '0\t3\n' }, error: unavailable },
  ];
  for (const command of DELIVERY) {
    for (const scenario of cases) await t.test(`${command}: ${scenario.name}`, () => {
      const { reason, calls } = judged(command, scenario.fixture);
      assert.equal(reason, scenario.error ? `${PRE_APPROVED}publishes nothing: ${scenario.error}` : '');
      assert.doesNotMatch(reason, /synthetic-setting-secret|synthetic\.invalid/);
      if (scenario.error) assert.deepEqual(calls.filter(isGraphql), [], 'setting refusal precedes the approval read');
      else {
        const oid = scenario.fixture.settingOid ?? 'a'.repeat(40);
        assert.deepEqual(calls.filter((call) => /^git (?:rev-parse|ls-tree|show) /.test(call)), [
          'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}',
          `git ls-tree --full-tree --format=%(objectmode) ${oid} -- .agents/factory-settings.json`,
          `git show ${oid}:.agents/factory-settings.json`,
        ]);
        assert.ok(calls.some(isGraphql), 'enabled publication still checks the approval');
      }
    });
  }
  // Run from a pinned workflow version, the running code is the recorded commit, so that commit, never the
  // integration checkout's HEAD, is what is older than fetched main. Real commits: fetched main adds a newer key one
  // commit past the other of the two.
  for (const [name, pinBehind] of [['pinned commit behind, integration checkout current', true], ['pinned commit current, integration checkout behind', false]]) {
    await t.test(`${PUSH}: newer key read from a pinned workflow version, ${name}`, { skip: withoutClaude }, async (st) => {
      const pin = pinnedWorkflow(st);
      gitIn(pin.repo, ['switch', '-q', '-c', 'next']);
      mkdirSync(join(pin.repo, '.agents'), { recursive: true });
      writeFileSync(join(pin.repo, '.agents/factory-settings.json'), newerKey);
      gitIn(pin.repo, ['add', '.agents/factory-settings.json']);
      gitIn(pin.repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'newer key']);
      const fetched = gitIn(pin.repo, ['rev-parse', 'HEAD']);
      gitIn(pin.repo, ['update-ref', 'refs/remotes/origin/main', fetched]);
      gitIn(pin.repo, ['switch', '-q', 'main']);
      let root = pin.root;
      if (pinBehind) gitIn(pin.repo, ['merge', '-q', '--ff-only', 'next']);
      else {
        const log = st.mock.method(console, 'log', () => {});
        repairWorkflowSnapshot({ cwd: pin.repo, commit: fetched });
        log.mock.restore();
        root = join(workflowStore(pin.repo), fetched);
      }
      const { blockReason: pinnedBlockReason } = await import(pathToFileURL(join(root, 'scripts/lib/unsafe-git.mjs')).href);
      const run = preApprovedRun({ cwd: pin.repo });
      // The settings and ancestry reads meet the real repository; every other read keeps its fixture answer.
      const realGit = (args) => {
        const read = childProcess.spawnSync('git', args, { cwd: pin.worktree, encoding: 'utf8' });
        if (read.status !== 0) throw new Error(`git ${args.join(' ')}: ${read.stderr}`);
        return read.stdout;
      };
      const real = (args) => ['-C', 'rev-list', 'merge-base', 'ls-tree', 'show', 'cat-file'].includes(args[0])
        || args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}';
      const git = (args) => (real(args) ? realGit(args) : run.preApproved.git(args));
      const verify = ({ drift }) => verifyJobPin({ env: { FABRAIK_WORKFLOW_ROOT: root }, cwd: pin.repo, drift });
      const reason = pinnedBlockReason(PUSH, { ...inJob, cwd: run.cwd }, { preApproved: { ...run.preApproved, git, coordinated: true, verifyJobPin: verify } });
      const verdict = reason.includes(unavailable) ? 'fetch advice'
        : reason.includes(root) && reason.includes('older than fetched main') ? 'names the older pin' : reason;
      assert.equal(verdict, pinBehind ? 'names the older pin' : 'fetch advice');
    });
  }
  for (const [name, text, jobText, error] of [
    ['job when-needed main always', off, enabled, disabled], ['job always main when-needed', enabled, off, undefined],
  ]) await t.test(name, () => {
    const run = preApprovedRun({ settingText: text });
    const git = (args) => args.join(' ') === 'show HEAD:.agents/factory-settings.json' ? jobText : run.preApproved.git(args);
    const reason = blockReason(PUSH, inJob, { preApproved: { ...run.preApproved, git } });
    assert.equal(reason, error ? `${PRE_APPROVED}publishes nothing: ${error}` : '');
    assert.ok(!run.calls.includes('git show HEAD:.agents/factory-settings.json'));
  });
  await t.test('one pinned object per check and next check observes fetched revocation', () => {
    const old = 'a'.repeat(40);
    const next = 'b'.repeat(40);
    let current = old;
    const reads = [];
    const run = preApprovedRun();
    const git = (args) => {
      if (args[0] === 'rev-parse') {
        reads.push(args);
        const pinned = current;
        current = next;
        return pinned + '\n';
      }
      if (args[0] === 'ls-tree') { reads.push(args); return '100644\n'; }
      if (args[0] === 'show') { reads.push(args); return args[1] === `${old}:.agents/factory-settings.json` ? enabled : off; }
      return run.preApproved.git(args);
    };
    const judge = () => blockReason(PUSH, inJob, { preApproved: { ...run.preApproved, git } });
    assert.equal(judge(), '');
    assert.deepEqual(reads, [
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      ['ls-tree', '--full-tree', '--format=%(objectmode)', old, '--', '.agents/factory-settings.json'],
      ['show', `${old}:.agents/factory-settings.json`],
    ]);
    reads.length = 0;
    assert.equal(judge(), `${PRE_APPROVED}publishes nothing: ${disabled}`);
    assert.deepEqual(reads, [
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      ['ls-tree', '--full-tree', '--format=%(objectmode)', next, '--', '.agents/factory-settings.json'],
      ['show', `${next}:.agents/factory-settings.json`],
    ]);
  });
  for (const command of ['gh pr ready 12 --undo', 'gh pr ready --undo 12']) {
    for (const fixture of [{ settingText: off }, { settingMode: '' }, { settingError: 'ref' }]) {
      await t.test(`${command}: disabled or unavailable setting still permits owned withdrawal ${JSON.stringify(fixture)}`, () => {
        const { reason, calls } = judged(command, { ...fixture, comments: [] });
        assert.equal(reason, '');
        assert.ok(calls.includes(PR_VIEW));
        assert.deepEqual(calls.filter((call) => /^(?:git (?:rev-parse|ls-tree|show)|gh api graphql)/.test(call)), []);
      });
    }
  }
  await t.test('the unmarked path retains its verdict without setting reads', () => {
    for (const command of DELIVERY) assert.equal(blockReason(command, inJob), '');
  });
});

test('the pre-approved setting check can require the Herdr add-on', () => {
  const check = (settingText, options = {}) => () => requireMergeOnEvidence({ git: preApprovedRun({ settingText }).preApproved.git, ...options });
  assert.throws(check('{"version":1,"waitForOwner":"when-needed"}', { herdr: true }), { message: /\bherdr\b/ }, 'absent herdr key');
  assert.throws(check('{"version":1,"waitForOwner":"when-needed","herdr":false}', { herdr: true }), { message: /\bherdr\b/ }, 'herdr false');
  assert.doesNotThrow(check('{"version":1,"waitForOwner":"when-needed","herdr":true}', { herdr: true }), 'herdr true');
  assert.doesNotThrow(check('{"version":1,"waitForOwner":"when-needed"}'), 'no herdr option');
});

// ── a coordinated Claude job's workflow version ──────────────────────────────
// The expected outcomes come from the plan's frozen rule: in a session the Claude guard entry sees marked
// FABRAIK_COORDINATED_JOB=1, every publish form and every merge-watch form needs `verifyJobPin` to pass before any
// publish check reads, with `drift` false for its own `gh pr ready <n> --undo`, false for the exact one-argument
// merge-watch cleanup and true for everything else; a missing FABRAIK_WORKFLOW_ROOT refuses with the recovery message;
// and merge-watch runs only as `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs"`. At blockReason the guard
// entry's verifier arrives as `preApproved.verifyJobPin`, here S1's own function over a real repository and its real
// snapshot. Sessions without the mark, and Codex Herdr jobs, keep today's outcomes.

const INSTALLED_ROOT = resolve(CODE_DIRECTORY, '../..');
const withoutClaude = !presentRuntimes(INSTALLED_ROOT).includes('claude') && 'the settings file names no claude runtime';
const NO_PIN = 'this job has no recorded workflow version; resume it through the coordinator';
const PINNED_WATCH = '$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs';
const watch = (args) => `node "${PINNED_WATCH}" ${args}`;
const CLEANUP = watch('12');
const HOLD = watch('--hold-delivery');
const UNDO = 'gh pr ready 12 --undo';
const GUARD_MARKS = ['FABRAIK_WORKFLOW_ROOT', 'FABRAIK_COORDINATED_JOB', 'PRE_APPROVED_RUN_SESSION', 'PRE_APPROVED_RUN_CARD', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR'];

const gitIn = (cwd, args) => {
  const run = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8' });
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

// A repository whose one commit holds this checkout's installed Claude guard, the library it loads, the merge watch
// and the three shared contracts, with a job worktree, the review folder of a clear HEAD and that commit's verified
// snapshot at its canonical store path, `root`.
function pinnedWorkflow(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pinned-workflow-')));
  t.after(() => {
    unlock(repo);
    rmSync(repo, { recursive: true, force: true });
  });
  const library = readdirSync(join(INSTALLED_ROOT, 'scripts/lib')).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
  for (const path of ['.claude/settings.json', '.claude/hooks/block-unsafe-git.mjs', 'scripts/merge-watch.mjs', ...library.map((name) => `scripts/lib/${name}`)]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(INSTALLED_ROOT, path), join(repo, path));
  }
  writeFileSync(join(repo, 'scripts/lib/delivery-lane-contract.test.mjs'), '// The fixture delivery-lane contract.\n');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'workflow']);
  const commit = gitIn(repo, ['rev-parse', 'HEAD']);
  const worktree = join(repo, '.claude/worktrees/job');
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'job/7', worktree]);
  mkdirSync(join(repo, REVIEW_FOLDER), { recursive: true });
  writeFileSync(join(repo, REVIEW_FOLDER, 'body.md'), CLEAR);
  const log = t.mock.method(console, 'log', () => {});
  repairWorkflowSnapshot({ cwd: repo, commit });
  log.mock.restore();
  return { repo, worktree, commit, root: join(workflowStore(repo), commit) };
}

// The judgment of a coordinated Claude session whose guard entry verifies `env`'s pin in `pin.repo`. Its ready and
// merge read pull request 12 on the exact publication path, a draft before ready and ready before the pinned merge.
const coordinatedJudged = (pin, command, { env = { FABRAIK_WORKFLOW_ROOT: pin.root }, fixture = {} } = {}) => {
  const pinnedPull = command === READY ? { ...PINNED_PULL, isDraft: true } : PINNED_PULL;
  const run = preApprovedRun({ cwd: pin.repo, pinnedReads: [], pinnedPull, ...fixture });
  const verify = ({ drift }) => verifyJobPin({ env, cwd: pin.repo, drift });
  const reason = blockReason(command, { ...inJob, cwd: run.cwd }, { preApproved: { ...run.preApproved, coordinated: true, verifyJobPin: verify } });
  return { reason, calls: run.calls };
};

// The Claude PreToolUse Bash guard definition, as Claude Code runs it.
const guardDefinition = () => JSON.parse(readFileSync(join(INSTALLED_ROOT, '.claude/settings.json'), 'utf8'))
  .hooks.PreToolUse.find((entry) => entry.matcher === 'Bash').hooks.map((hook) => hook.command)
  .find((command) => command.includes('/.claude/hooks/block-unsafe-git.mjs'));

// The PreToolUse input Claude Code gives a Bash call in `cwd`.
const toolInput = (command, cwd) => JSON.stringify({
  session_id: 'pinned-session', transcript_path: join(cwd, 'no-transcript.jsonl'), cwd, permission_mode: 'default',
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'a pinned delivery call' },
});

// The environment Claude Code runs the job's hooks in: the integration root as the project, plus `marks`.
const guardEnvironment = (pin, marks) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !GUARD_MARKS.includes(key))),
  CLAUDE_PROJECT_DIR: pin.repo,
  ...marks,
});
const COORDINATED_MARKS = { PRE_APPROVED_RUN_SESSION: RUN_START, PRE_APPROVED_RUN_CARD: '7', FABRAIK_COORDINATED_JOB: '1' };

// Whether the Claude guard definition lets `command` go ahead in the job worktree under `marks`.
const guardVerdict = (pin, command, marks) => {
  const shell = posixShell();
  assert.ok(shell, 'a POSIX shell is required: install Git for Windows');
  const run = childProcess.spawnSync(shell, ['-c', guardDefinition()], {
    cwd: pin.worktree, encoding: 'utf8', input: toolInput(command, pin.worktree), env: guardEnvironment(pin, marks),
  });
  if (run.status === 0 && !run.stdout.includes('"permissionDecision":"deny"')) return 'admitted';
  return run.stderr.includes(NO_PIN) ? 'refused: no recorded version' : `exit ${run.status}: ${run.stderr}${run.stdout}`;
};

// Damages the snapshot's merge watch, which the guard itself never loads.
const damageWatch = (pin, text) => {
  unlock(join(pin.root, 'scripts'));
  writeFileSync(join(pin.root, 'scripts/merge-watch.mjs'), text);
};

test("ANTI-REGRESSION: coordinated publication needs the job's verified workflow version", { skip: withoutClaude }, (t) => {
  const pin = pinnedWorkflow(t);
  const damaged = join(pin.root, 'scripts/merge-watch.mjs');
  const drifted = 'scripts/lib/workflow-pin.mjs';
  // Admitted, admitted after the publish check read, refused with no publish read naming `cause`, or the whole reason.
  const verdict = ({ reason, calls }, cause) => {
    if (reason === '') return calls.length > 0 ? 'admitted after the publish check' : 'admitted';
    if (calls.length > 0) return `refused after the publish check: ${reason}`;
    return cause !== undefined && reason.includes(cause) ? `refused naming ${cause}` : reason;
  };
  const outcomes = {};
  const expected = {};
  const row = (label, actual, want) => {
    outcomes[label] = actual;
    expected[label] = want;
  };

  // A coordinated job merges only through the pinned merge, so its delivery forms end with that merge.
  const coordinatedDelivery = [PUSH, CREATE, READY, PINNED_MERGE];
  for (const command of coordinatedDelivery) row(`verified: ${command}`, verdict(coordinatedJudged(pin, command)), 'admitted after the publish check');
  const closed = coordinatedJudged(pin, PUSH, { fixture: { issue: { state: 'CLOSED' } } });
  row('verified: a closed card meets the existing checks', closed.reason.startsWith(PRE_APPROVED) && closed.reason.endsWith('the card is closed') && closed.calls.length > 0, true);
  row(`verified: ${UNDO}`, verdict(coordinatedJudged(pin, UNDO)), 'admitted after the publish check');
  for (const command of [CLEANUP, HOLD]) row(`verified: ${command}`, verdict(coordinatedJudged(pin, command)), 'admitted');

  // The integration checkout's copy of a shared contract moves on from the pinned commit.
  const contract = readFileSync(join(pin.repo, drifted));
  writeFileSync(join(pin.repo, drifted), Buffer.concat([contract, Buffer.from('// moved on\n')]));
  row(`drift: ${UNDO}`, verdict(coordinatedJudged(pin, UNDO)), 'admitted after the publish check');
  row(`drift: ${CLEANUP}`, verdict(coordinatedJudged(pin, CLEANUP)), 'admitted');
  for (const command of [...coordinatedDelivery, HOLD]) row(`drift: ${command}`, verdict(coordinatedJudged(pin, command), drifted), `refused naming ${drifted}`);
  writeFileSync(join(pin.repo, drifted), contract);

  for (const command of [...coordinatedDelivery, UNDO, CLEANUP, HOLD]) {
    row(`no recorded version: ${command}`, verdict(coordinatedJudged(pin, command, { env: {} }), NO_PIN), `refused naming ${NO_PIN}`);
  }
  // Only a pre-pin job meets the recovery message, through the launch root's guard.
  row(`guard, marked with no recorded version: ${CLEANUP}`, guardVerdict(pin, CLEANUP, COORDINATED_MARKS), 'refused: no recorded version');

  damageWatch(pin, '// not the pinned merge watch\n');
  for (const command of [PUSH, UNDO, CLEANUP]) row(`damaged: ${command}`, verdict(coordinatedJudged(pin, command), damaged), `refused naming ${damaged}`);

  // Without the mark, a session keeps today's outcomes whatever pin its environment names.
  const named = { FABRAIK_WORKFLOW_ROOT: pin.root };
  for (const command of [...DELIVERY, UNDO, CLEANUP, HOLD]) {
    const run = preApprovedRun({ cwd: pin.repo, env: named });
    row(`unmarked run session: ${command}`, blockReason(command, { ...inJob, cwd: run.cwd }, { preApproved: run.preApproved }), '');
  }
  for (const [label, marks] of [['ordinary session', named], ['unmarked run session', { ...named, PRE_APPROVED_RUN_SESSION: RUN_START, PRE_APPROVED_RUN_CARD: '7' }]]) {
    for (const command of [CLEANUP, HOLD]) row(`guard, ${label} naming a damaged pin: ${command}`, guardVerdict(pin, command, marks), 'admitted');
  }
  for (const command of [PUSH, CLEANUP, HOLD]) row(`Codex Herdr naming a damaged pin: ${command}`, pinnedDelivery(command, { env: named }).reason, '');

  assert.deepEqual(outcomes, expected);
});

test("pinned delivery code runs only from the job's workflow version", { skip: withoutClaude }, (t) => {
  const pin = pinnedWorkflow(t);
  const elsewhere = [`${pin.repo}/scripts/merge-watch.mjs`, `${pin.worktree}/scripts/merge-watch.mjs`];
  const outcomes = {};
  const expected = {};
  for (const args of ['12', '--hold-delivery']) {
    for (const path of ['scripts/merge-watch.mjs', ...elsewhere]) {
      const command = `node ${path} ${args}`;
      const { reason } = coordinatedJudged(pin, command);
      outcomes[`coordinated: ${command}`] = reason !== '' && reason.includes(PINNED_WATCH) ? `refused naming ${PINNED_WATCH}` : reason;
      expected[`coordinated: ${command}`] = `refused naming ${PINNED_WATCH}`;
      for (const [label, judge] of [
        ['unmarked run session', () => blockReason(command, inJob, { preApproved: preApprovedRun({ cwd: pin.repo }).preApproved })],
        ['ordinary session', () => blockReason(command, inJob)],
      ]) {
        outcomes[`${label}: ${command}`] = judge();
        expected[`${label}: ${command}`] = '';
      }
    }
    outcomes[`coordinated: ${watch(args)}`] = coordinatedJudged(pin, watch(args)).reason;
    expected[`coordinated: ${watch(args)}`] = '';
  }
  // A text search that names the merge watch executes only the search.
  const search = "rg -n 'node scripts/merge-watch.mjs' .agents/skills";
  outcomes[`coordinated: ${search}`] = coordinatedJudged(pin, search).reason;
  expected[`coordinated: ${search}`] = '';
  // A syntax check reads the script without running it.
  for (const syntaxCheck of ['node --check scripts/merge-watch.mjs', 'node -c scripts/merge-watch.mjs', 'node.exe --check scripts/merge-watch.mjs']) {
    outcomes[`coordinated: ${syntaxCheck}`] = coordinatedJudged(pin, syntaxCheck).reason;
    expected[`coordinated: ${syntaxCheck}`] = '';
  }
  // An apostrophe in a comment, a heredoc body or a $'...' string quotes nothing, and a quoted command word still runs.
  for (const command of [
    "# Start the PR's watch\nnode scripts/merge-watch.mjs 12\n# wait until it's done",
    "echo dont && node scripts/merge-watch.mjs 12 # it's",
    "cat <<EOF\ndon't\nEOF\nnode scripts/merge-watch.mjs 12\necho 'a b'",
    "echo $'a\\' b' ; node scripts/merge-watch.mjs 12 ; echo 'c'",
    "echo 'a #b'\nnode scripts/merge-watch.mjs 12\necho 'c d'",
    '"node" scripts/merge-watch.mjs 12',
    'cat <<EOF\n$(node scripts/merge-watch.mjs 12)\nEOF',
    'cat <<EOF\n`node scripts/merge-watch.mjs 12`\nEOF',
    // A live heredoc with no terminator line runs to the end of the input, its substitution included.
    "cat <<EOF\nit's\n$(node scripts/merge-watch.mjs 12)\nthat's",
    // A preload option beside a syntax check loads code before the check, so the command is no syntax check.
    'node -c --import ./scripts/merge-watch.mjs scripts/merge-watch.mjs 12',
    'node --require=./scripts/merge-watch.mjs -c scripts/merge-watch.mjs 12',
    'node --check --import ./scripts/merge-watch.mjs scripts/merge-watch.mjs 12 --held-delivery',
    'node -c --import=./scripts/merge-watch.mjs scripts/merge-watch.mjs 12',
    // NODE_OPTIONS preloads run under a syntax check too.
    'NODE_OPTIONS=--import=./scripts/merge-watch.mjs node --check scripts/merge-watch.mjs 12 --held-delivery',
    'NODE_OPTIONS="--import ./scripts/merge-watch.mjs" node --check scripts/merge-watch.mjs 12 --held-delivery',
    'export NODE_OPTIONS=--import=./scripts/merge-watch.mjs; node --check scripts/merge-watch.mjs 12 --held-delivery',
    'env NODE_OPTIONS=--require=./scripts/merge-watch.mjs node -c scripts/merge-watch.mjs 12',
    // The shell can assemble that name or source a file that exports it, so only the bare check is exempt.
    'v=NODE; export ${v}_OPTIONS=--import=./scripts/merge-watch.mjs; node --check scripts/merge-watch.mjs 12 --held-delivery',
    '. ./pre.sh; node --check scripts/merge-watch.mjs 12',
    // Brace and glob expansion can turn a syntax check's one word into a preload option.
    'node --check {--import=./scripts/merge-watch.mjs,scripts/merge-watch.mjs,12,--held-delivery}',
    'node.exe -c {--require=./scripts/merge-watch.mjs,scripts/merge-watch.mjs,12}',
    'node --check [-]*merge-watch.mjs',
  ]) {
    const { reason } = coordinatedJudged(pin, command);
    outcomes[`coordinated: ${command}`] = reason !== '' && reason.includes(PINNED_WATCH) ? `refused naming ${PINNED_WATCH}` : reason;
    expected[`coordinated: ${command}`] = `refused naming ${PINNED_WATCH}`;
  }
  // An apostrophe that opens a quote holds the rest of the line, its `#` included, as one argument of echo.
  const quotedTail = "echo don't && node scripts/merge-watch.mjs 12 # it's";
  outcomes[`coordinated: ${quotedTail}`] = coordinatedJudged(pin, quotedTail).reason;
  expected[`coordinated: ${quotedTail}`] = '';
  // A quoted heredoc delimiter makes the body literal, so its substitution runs nothing.
  const literalBody = "cat <<'EOF'\n$(node scripts/merge-watch.mjs 12)\nEOF";
  outcomes[`coordinated: ${literalBody}`] = coordinatedJudged(pin, literalBody).reason;
  expected[`coordinated: ${literalBody}`] = '';
  assert.deepEqual(outcomes, expected);
});

test('ANTI-REGRESSION: pinned delivery code is verified before it runs', { skip: withoutClaude }, (t) => {
  const pin = pinnedWorkflow(t);
  damageWatch(pin, "process.stderr.write('MARKER\\n');\n");
  const shell = posixShell();
  assert.ok(shell, 'a POSIX shell is required: install Git for Windows');
  // Claude's dispatch: the command runs only when the guard exits 0 with no deny decision on its standard output.
  const dispatch = [
    'out=$(printf \'%s\' "$TOOL_INPUT" | eval "$GUARD"); s=$?',
    'printf \'%s\' "$out"',
    '[ "$s" -eq 0 ] || exit "$s"',
    'case $out in *\'"permissionDecision":"deny"\'*) exit 2 ;; esac',
    'eval "$TOOL_COMMAND"',
  ].join('\n');
  const run = childProcess.spawnSync(shell, ['-c', dispatch], {
    cwd: pin.worktree,
    encoding: 'utf8',
    env: {
      ...guardEnvironment(pin, { ...COORDINATED_MARKS, FABRAIK_WORKFLOW_ROOT: pin.root }),
      GUARD: guardDefinition(), TOOL_COMMAND: HOLD, TOOL_INPUT: toolInput(HOLD, pin.worktree),
    },
  });
  assert.deepEqual(
    { status: run.status, namesTheWatch: run.stderr.includes(join(pin.root, 'scripts/merge-watch.mjs')), ran: run.stderr.includes('MARKER') },
    { status: 2, namesTheWatch: true, ran: false },
    run.stderr,
  );
});
