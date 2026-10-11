// unsafe-git.test.mjs — mutation-proof unit tests for the PreToolUse(Bash) guard rules.
// Run: node --test scripts/lib/   (or `npm run test:scripts`)
//
// Every blocked fixture asserts the exact rule reason, never a bare truthy, so a rule that fires for
// the wrong reason reddens a test instead of hiding behind another rule's verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { blockReason } from './unsafe-git.mjs';

const REASON_CREATE = "gh pr create without --draft skips the draft review: open it as a draft (--draft/-d) so Greptile reviews it before CI runs";
const REASON_MERGE = 'gh pr merge: only the delivery form `gh pr merge --auto --squash --delete-branch <number>`, alone in its command segment, is allowed; --auto lets GitHub merge once the required test check is green, and because the allow list runs that prefix unprompted anything else in the segment (--admin, a reordered or missing flag, a quoted, substituted or variable word, a wrapper) is refused';
const REASON_READY = 'gh pr ready: only `gh pr ready <number>` and `gh pr ready <number> --undo`, alone in their command segment, are allowed; the allow list runs that prefix unprompted, so anything else in the segment (a quoted, substituted or variable word, a redirection, a wrapper) is refused';
const REASON_COMMIT_NO_VERIFY = 'git commit --no-verify skips the pre-commit gates';
const REASON_PUSH_NO_VERIFY = 'git push --no-verify skips the lint pre-push gate';
const REASON_HOOKS_PATH = 'a core.hooksPath override skips the pre-commit and pre-push gates';
const REASON_HOOKS_PATH_CONFIG = 'git config core.hooksPath: only the arming step `git config core.hooksPath .githooks` and a read that ends at the key are allowed; another value or an unset skips the pre-commit and pre-push gates, and git can store a word after the key as the value even when it looks like an option, so put options before the key';
const REASON_PUSH_FORCE = 'git push --force is unsafe (use --force-with-lease for a rebase)';
const REASON_FILTER_BRANCH = 'git filter-branch rewrites history';

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
    '/Users/zain/.local/bin/gh pr merge 493 --squash',
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

const ROOT = resolve('/Users/z/Claude Code/repo');
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

const WIN_ROOT = 'C:\\Users\\z\\Claude Code\\repo';
const WIN_JOB = 'C:\\Users\\z\\Claude Code\\repo\\.claude\\worktrees\\1170';
const winCheckout = (root, cwd) => ({
  cwd,
  platform: 'win32',
  isRootCheckout: (dir) => dir === root || (dir.startsWith(`${root}\\`) && !dir.startsWith(`${root}\\.claude\\worktrees\\`)),
});

test('ANTI-REGRESSION: on Windows a Git Bash drive path after cd or -C is read as its drive', () => {
  const winJob = winCheckout(WIN_ROOT, WIN_JOB);
  assert.equal(blockReason('cd "/c/Users/z/Claude Code/repo" && git commit -m "wip"', winJob), rootReason('commit'));
  assert.equal(blockReason('git -C "/c/Users/z/Claude Code/repo" switch -c x', winJob), rootReason('switch'));
  assert.equal(blockReason('cd "/C/Users/z/Claude Code/repo" && git commit -m "wip"', winJob), rootReason('commit'));
  const winRoot = winCheckout(WIN_ROOT, WIN_ROOT);
  assert.equal(blockReason('cd "/c/Users/z/Claude Code/repo/.claude/worktrees/1170" && git commit -m "wip"', winRoot), '');
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
  const root = '/c/Users/z/repo';
  assert.equal(blockReason('cd /c/Users/z/repo && git commit -m "wip"', posixCheckout(root, `${root}/.claude/worktrees/1170`)), rootReason('commit'));
  assert.equal(blockReason('cd /c/Users/z/repo/.claude/worktrees/1170 && git commit -m "wip"', posixCheckout(root, root)), '');
  assert.equal(blockReason('cd /srv/repo && git commit -m "wip"', posixCheckout('/srv/repo', '/srv/repo/.claude/worktrees/1170')), rootReason('commit'));
});
