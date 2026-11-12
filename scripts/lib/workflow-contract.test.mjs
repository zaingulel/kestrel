import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gitEnvironment, MANIFEST_PATH, readManifest, regionText, verifyManifest } from './factory-sync.mjs';
import { leftOutCause, needNotResolveCause, readSettingsHeader, SEATS, SETTINGS_PATH, treeSettings } from './runtimes.mjs';
import { blockReason } from './unsafe-git.mjs';
import { MANUAL_LIMIT, productTailShapeProblem, profileShapeProblem } from './repository-shape.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS = treeSettings(ROOT);
const PRESENT = SETTINGS.runtimes;
const without = (runtime) => !PRESENT.includes(runtime) && `the settings file names no ${runtime} runtime`;
const RESUME = readFileSync(resolve(ROOT, '.agents/skills/resume/SKILL.md'), 'utf8');
const PRODUCT_MANAGER_RUN = readFileSync(resolve(ROOT, '.agents/skills/resume/references/product-manager-run.md'), 'utf8');
// The main file and every reference, for a rule that may sit in any of them. A test of text that stays in the main file reads RESUME.
const RESUME_REFERENCES = '.agents/skills/resume/references';
const RESUME_CORPUS = [RESUME, ...readdirSync(resolve(ROOT, RESUME_REFERENCES)).sort().map((name) => readFileSync(resolve(ROOT, RESUME_REFERENCES, name), 'utf8'))].join('\n');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The independent oracle is the root-only cleanup contract and native hook exit protocol.
// This subprocess test observes that protocol and accidental helper execution by the hook.
// It never dispatches submitted shell text; actual Claude dispatch needs separate live-runtime evidence.
// Recurring cost: one disposable main/linked Git fixture and bounded hook subprocesses.
// Remove if cleanup-specific hook approval is retired; real cleanup behavior has separate CLI evidence.
test('ANTI-REGRESSION: cleanup approval is bound to the trusted root hook', { skip: without('claude') }, (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-cleanup-permission-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'root');
  const job = join(fixture, 'job');
  const sentinel = join(fixture, 'sentinel');
  const env = {
    ...gitEnvironment(),
    PRODUCT_MANAGER_RUN_SESSION: undefined,
    PRE_APPROVED_RUN_SESSION: undefined,
    CARRIED_PUSH_YES: undefined,
    GIT_CONFIG_GLOBAL: join(fixture, 'no-global-config'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd, args) => {
    const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  for (const path of [
    '.claude/hooks/block-unsafe-git.mjs',
    'scripts/lib/unsafe-git.mjs',
    'scripts/lib/advance-approval.mjs',
    'scripts/lib/runtimes.mjs',
    'scripts/lib/checkout-context.mjs',
    'scripts/lib/posix-shell.mjs',
    'scripts/closeout-cleanup.mjs',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path));
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture baseline']);
  git(root, ['worktree', 'add', '-q', '-b', 'job/321', job]);
  // Maliciously altered job-local CLI: discard the copied executable body/imports, including
  // the imported self-check, and permit only deletion of this fixture's literal sentinel.
  writeFileSync(join(job, 'scripts/closeout-cleanup.mjs'),
    `import { unlinkSync } from 'node:fs';\nunlinkSync(${JSON.stringify(sentinel)});\n`);
  writeFileSync(sentinel, 'retained');
  const command = 'node scripts/closeout-cleanup.mjs 321';
  const hook = (cwd, payload, options = {}) => spawnSync(process.execPath, [join(root, '.claude/hooks/block-unsafe-git.mjs')], {
    cwd, env, input: JSON.stringify(payload), encoding: 'utf8', ...options,
  });
  const refused = hook(job, { cwd: job, tool_input: { command } });
  assert.equal(refused.status, 2, `the hook must refuse editable job cleanup: ${refused.stderr}`);
  assert.equal(readFileSync(sentinel, 'utf8'), 'retained', 'the hook must not execute the editable helper');
  assert.match(refused.stderr, /cleanup requires the current trusted root/);
  assert.match(refused.stderr, /if the root is not current, invoke the current verified helper by absolute path under ordinary runtime review/);
  assert.ok(refused.stderr.includes(root));
  const allowed = hook(root, { cwd: root, tool_input: { command } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stderr, '');
  assert.deepEqual(JSON.parse(allowed.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `Cleanup runs the verified helper in the trusted root ${root}`,
    },
  });

  const other = join(fixture, 'unrelated-main');
  mkdirSync(other);
  git(other, ['init', '-q', '-b', 'main']);
  for (const [cwd, payloadCwd] of [
    [other, other], [root, job], [job, root], [root, undefined], [root, 321],
    [root, join(fixture, 'missing-cwd')],
  ]) {
    const run = hook(cwd, { cwd: payloadCwd, tool_input: { command } });
    assert.equal(run.status, 2, `untrusted cwd ${JSON.stringify(payloadCwd)}: ${run.stderr}`);
    assert.equal(run.stdout, '', 'refusal must not include permission JSON');
  }
  for (const suffix of [' "quoted path"', ' > output', ' && echo done']) {
    assert.equal(hook(job, { cwd: job, tool_input: { command: command + suffix } }).status, 2,
      'direct untrusted calls are refused even with unsupported suffixes');
  }
  const unavailableGit = hook(root, { cwd: root, tool_input: { command } }, { env: { ...env, PATH: fixture } });
  assert.equal(unavailableGit.status, 2, unavailableGit.stderr);
  assert.match(unavailableGit.stderr, /Git cannot identify/);
  renameSync(join(root, '.git'), join(root, 'saved-git'));
  const unresolvedRoot = hook(root, { cwd: root, tool_input: { command } });
  renameSync(join(root, 'saved-git'), join(root, '.git'));
  assert.equal(unresolvedRoot.status, 2, unresolvedRoot.stderr);
  assert.match(unresolvedRoot.stderr, /Git cannot identify/);

  const helper = join(root, 'scripts/closeout-cleanup.mjs');
  const helperBytes = readFileSync(helper);
  rmSync(helper);
  const missingHelper = hook(root, { cwd: root, tool_input: { command } });
  assert.equal(missingHelper.status, 2, missingHelper.stderr);
  assert.match(missingHelper.stderr, /could not be resolved/);
  writeFileSync(helper, helperBytes);
  // Redirect the scripts directory so the helper remains a file; only identity can reject it.
  // A junction avoids requiring Windows file-symlink privileges.
  renameSync(join(root, 'scripts'), join(root, 'saved-scripts'));
  symlinkSync(join(job, 'scripts'), join(root, 'scripts'), 'junction');
  const redirectedHelper = hook(root, { cwd: root, tool_input: { command } });
  rmSync(join(root, 'scripts'));
  renameSync(join(root, 'saved-scripts'), join(root, 'scripts'));
  assert.equal(redirectedHelper.status, 2, redirectedHelper.stderr);
  assert.match(redirectedHelper.stderr, /redirected/);

  for (const payload of [null, [], {}, { tool_input: { command: 321 } },
    { cwd: root, tool_input: { command: {} } }]) {
    const run = hook(root, payload);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '', 'uninspectable payload must never grant permission');
    assert.match(run.stderr, /no string command/);
  }
  const malformed = hook(root, {}, { input: '{' });
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.stdout, '');
  assert.match(malformed.stderr, /unparseable hook payload/);
  for (const unsupported of [`env ${command}`, `${command} && echo done`]) {
    const run = hook(root, { cwd: root, tool_input: { command: unsupported } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '', 'unsupported syntax must receive no cleanup-specific permission');
  }
  const gitRefusal = hook(root, { cwd: root, tool_input: { command: `${command} && git commit --no-verify` } });
  assert.equal(gitRefusal.status, 2, gitRefusal.stderr);
  assert.match(gitRefusal.stderr, /git commit/);
  assert.equal(gitRefusal.stdout, '', 'existing Git refusals precede cleanup approval');
  const gitRead = hook(root, { cwd: root, tool_input: { command: 'git status' } });
  assert.equal(gitRead.status, 0, gitRead.stderr);
  assert.equal(gitRead.stdout, '');
  assert.equal(readFileSync(sentinel, 'utf8'), 'retained', 'hook subprocesses did not execute the editable helper');
});

// The independent oracle is the run marks or literal native connection records and the expected guard outcomes.
// Each case starts the real hook, installed in a throwaway repository with the modules it loads, and
// observes only its exit code, its stderr and the calls a stand-in gh recorded.
// Recurring cost: disposable Git fixtures and bounded hook starts, no network.
const GUARDS = {
  claude: { hook: '.claude/hooks/block-unsafe-git.mjs', modules: [], payload: (cwd, command) => ({ cwd, tool_input: { command } }) },
  codex: { hook: '.codex/hooks/block-unsafe-git.mjs', modules: ['scripts/lib/codex-hook-adapters.mjs'], payload: (cwd, command) => ({ cwd, tool_input: { cmd: command } }) },
};
const GUARD_MODULES = [
  'scripts/lib/unsafe-git.mjs',
  'scripts/lib/checkout-context.mjs',
  'scripts/lib/posix-shell.mjs',
  'scripts/lib/advance-approval.mjs',
  'scripts/lib/runtimes.mjs',
];
// An undefined value leaves a variable out of the hook's environment, whatever session runs the suite.
const MARKS_OFF = { GH_REPO: undefined, GH_HOST: undefined, PRODUCT_MANAGER_RUN_SESSION: undefined, PRE_APPROVED_RUN_SESSION: undefined, CARRIED_PUSH_YES: undefined, CLAUDE_CODE_ENTRYPOINT: undefined };
const RUN_START = '2026-11-04T12:00:00Z';
const withoutStandInGh = process.platform === 'win32' && 'a stand-in gh.exe cannot be a script';

function guardFixture(t, runtime, branch) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-guard-marks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const env = { ...gitEnvironment(), GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  mkdirSync(root);
  git('init', '-q', '-b', branch);
  const guard = GUARDS[runtime];
  for (const path of [guard.hook, ...guard.modules, ...GUARD_MODULES]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path));
  }
  // The hooks read only TRACKER, and these tests pin GitHub whatever tracker the install names.
  writeFileSync(join(root, 'scripts/lib/board-config.mjs'), "export const TRACKER = 'github';\n");
  const hookRaw = (input, marks, cwd = root) => spawnSync(process.execPath, [join(root, guard.hook)], {
    cwd, env: { ...env, ...MARKS_OFF, ...marks }, input, encoding: 'utf8',
  });
  const hook = (command, marks) => hookRaw(JSON.stringify(guard.payload(root, command)), marks);
  return { dir, git, hook, hookRaw };
}

// Answers the delivery reads for o/fixture, with or without a record by the viewer from before RUN_START.
// Appends each call's argument list to a log.
function standInGh(dir, { card = 7, approved = true } = {}) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'gh-calls.log');
  const repository = { id: 'R_1', nameWithOwner: 'o/fixture', defaultBranchRef: { name: 'main' } };
  const record = {
    author: { login: 'o' }, createdAt: '2020-01-01T00:00:00Z', lastEditedAt: null,
    url: `https://github.com/o/fixture/issues/${card}#issuecomment-1`, body: `Approved: card=${card} edited=none`,
  };
  const graphql = {
    data: {
      viewer: { login: 'o' },
      repository: {
        id: 'R_1',
        issue: {
          state: 'OPEN', title: 'Card', lastEditedAt: null,
          timelineItems: { nodes: [] }, comments: { pageInfo: { hasNextPage: false }, nodes: approved ? [record] : [] },
        },
      },
    },
  };
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify(args.includes('id,nameWithOwner,defaultBranchRef') ? ${JSON.stringify(repository)} : { id: ${JSON.stringify(repository.id)} }));
} else if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(${JSON.stringify(JSON.stringify(graphql))});
} else {
  console.error('stand-in gh: unexpected call ' + args.join(' '));
  process.exit(1);
}
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []) };
}

test('ANTI-REGRESSION: the Claude guard refuses git push in a pre-approved run session off a job branch, refuses it under the product manager mark, and passes it unmarked', { skip: without('claude') }, (t) => {
  const { hook } = guardFixture(t, 'claude', 'main');
  const command = 'git push origin job/1';

  const preApproved = hook(command, { PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(preApproved.status, 2, preApproved.stderr);
  assert.ok(preApproved.stderr.includes('a pre-approved run session publishes only from a job branch, and HEAD is "main"'), preApproved.stderr);

  const productManager = hook(command, { PRODUCT_MANAGER_RUN_SESSION: '1' });
  assert.equal(productManager.status, 2, productManager.stderr);
  assert.ok(productManager.stderr.includes('a product manager run session does not publish'), productManager.stderr);

  const unmarked = hook(command, {});
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.equal(unmarked.stderr, '');
});

// A `claude -p` card session a desktop app run session starts inherits the app's entrypoint, so every case here runs
// under it, and the test above runs the same marks with none, which MARKS_OFF clears. The marks reach the guard only
// through the environment: an unmarked session passes whatever its transcript holds, and whether or not it can be read.
// Recurring cost: one disposable Git fixture, one small transcript file and four hook starts, no network.
test('ANTI-REGRESSION: the Claude guard knows a run session by its environment marks alone, refusing them under the desktop app entrypoint and reading no transcript', { skip: without('claude') }, (t) => {
  const { dir, hookRaw } = guardFixture(t, 'claude', 'main');
  const cwd = join(dir, 'repo');
  const markLine = join(dir, 'mark-line.jsonl');
  writeFileSync(markLine, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Continue the product manager run.\nPRODUCT_MANAGER_RUN_SESSION=1' } })}\n`);
  const missing = join(dir, 'missing.jsonl');
  const REFUSALS = ['a product manager run session does not publish', 'a pre-approved run session publishes only from a job branch, and HEAD is "main"'];
  const push = (transcriptPath, marks) => {
    const run = hookRaw(JSON.stringify({ cwd, transcript_path: transcriptPath, tool_input: { command: 'git push origin job/1' } }), { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ...marks });
    return [run.status, REFUSALS.find((reason) => run.stderr.includes(reason)) ?? run.stderr];
  };

  assert.deepEqual({
    productManager: push(missing, { PRODUCT_MANAGER_RUN_SESSION: '1' }),
    preApproved: push(missing, { PRE_APPROVED_RUN_SESSION: RUN_START }),
    unmarkedWithMarkLine: push(markLine, {}),
    unmarkedUnreadable: push(missing, {}),
  }, {
    productManager: [2, REFUSALS[0]],
    preApproved: [2, REFUSALS[1]],
    unmarkedWithMarkLine: [0, ''],
    unmarkedUnreadable: [0, ''],
  });
});

function assertAdmitsMarkedDeliveryPush(t, runtime) {
  const { dir, git, hook } = guardFixture(t, runtime, 'job/7');
  git('remote', 'add', 'origin', 'https://github.com/o/fixture.git');
  mkdirSync(join(dir, 'repo/.agents'));
  writeFileSync(join(dir, 'repo/.agents/factory-settings.json'), '{"version":1,"preApprovedRun":true}');
  git('add', '.agents/factory-settings.json');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'enabled fetched settings');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const gh = standInGh(dir);

  const run = hook('git push -u origin job/7', { PATH: `${gh.bin}${delimiter}${process.env.PATH}`, PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(gh.calls().some(([api, graphql]) => api === 'api' && graphql === 'graphql'), 'the hook must read the advance approval through gh');
}

test('ANTI-REGRESSION: the Codex guard refuses publishing with a malformed pre-approved mark', { skip: without('codex') }, (t) => {
  const { hook } = guardFixture(t, 'codex', 'job/7');

  const malformed = hook('git push -u origin job/7', { PRE_APPROVED_RUN_SESSION: 'not-a-run-start' });
  assert.equal(malformed.status, 2, malformed.stderr);
  assert.ok(malformed.stderr.includes('a pre-approved run session publishes nothing: its mark "not-a-run-start" is not a run start'), malformed.stderr);
});

test('ANTI-REGRESSION: the Codex guard refuses git push with the run session mark and passes it without', { skip: without('codex') }, (t) => {
  const { dir, hookRaw } = guardFixture(t, 'codex', 'main');
  const input = JSON.stringify({ cwd: join(dir, 'repo'), tool_input: { command: 'git push origin job/1' } });
  const guard = (mark) => hookRaw(input, { PRODUCT_MANAGER_RUN_SESSION: mark });

  const marked = guard('1');
  assert.equal(marked.status, 2, marked.stderr);
  assert.ok(marked.stderr.includes('Blocked: a product manager run session'), marked.stderr);

  const unmarked = guard(undefined);
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.equal(unmarked.stderr, '');
});

test('ANTI-REGRESSION: the Codex guard refuses a call whose hook payload is unreadable under the pre-approved mark', { skip: without('codex') }, (t) => {
  const { hookRaw } = guardFixture(t, 'codex', 'main');

  const unreadable = hookRaw('this is not json', { PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.ok(unreadable.stderr.includes('a pre-approved run session'), unreadable.stderr);
});

test('ANTI-REGRESSION: both guards refuse an unparseable payload or one holding no string command under the pre-approved mark, and pass it unmarked (Claude)', { skip: without('claude') }, (t) => {
  const { dir, hookRaw } = guardFixture(t, 'claude', 'job/7');
  const noCommand = JSON.stringify({ cwd: join(dir, 'repo'), tool_input: {} });

  const unparseable = hookRaw('this is not json', { PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(unparseable.status, 2, unparseable.stderr);
  assert.ok(unparseable.stderr.includes('a pre-approved run session is refused a call whose hook payload is unparseable'), unparseable.stderr);
  const unparseableUnmarked = hookRaw('this is not json', {});
  assert.equal(unparseableUnmarked.status, 0, unparseableUnmarked.stderr);
  assert.match(unparseableUnmarked.stderr, /unparseable hook payload; rules NOT applied/);

  const refused = hookRaw(noCommand, { PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(refused.status, 2, refused.stderr);
  assert.ok(refused.stderr.includes('a pre-approved run session is refused a call whose hook payload holds no string command'), refused.stderr);
  const unmarked = hookRaw(noCommand, {});
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.match(unmarked.stderr, /no string command in hook payload; rules NOT applied/);
});

test('ANTI-REGRESSION: both guards refuse an unparseable payload or one holding no string command under the pre-approved mark, and pass it unmarked (Codex)', { skip: without('codex') }, (t) => {
  const { dir, hookRaw } = guardFixture(t, 'codex', 'job/7');
  const noCommand = JSON.stringify({ cwd: join(dir, 'repo'), tool_input: {} });

  const refused = hookRaw(noCommand, { PRE_APPROVED_RUN_SESSION: RUN_START });
  assert.equal(refused.status, 2, refused.stderr);
  assert.ok(refused.stderr.includes('a pre-approved run session is refused a call whose hook payload holds no string command'), refused.stderr);
  const unmarked = hookRaw(noCommand, {});
  assert.equal(unmarked.status, 0, unmarked.stderr);
  assert.equal(unmarked.stderr, '');
});

test('ANTI-REGRESSION: the real Claude hook admits a marked delivery push for its own card with a valid advance approval', { skip: without('claude') || withoutStandInGh }, (t) => {
  assertAdmitsMarkedDeliveryPush(t, 'claude');
});

test('ANTI-REGRESSION: the real Codex hook admits a marked delivery push for its own card with a valid advance approval', { skip: without('codex') || withoutStandInGh }, (t) => {
  assertAdmitsMarkedDeliveryPush(t, 'codex');
});

// A carried push yes needs no approval record, so the stand-in gh holds none and the push must not read one.
test('ANTI-REGRESSION: the Claude guard bounds a carried push yes session to its own card and refuses an unreadable payload under its mark', { skip: without('claude') || withoutStandInGh }, (t) => {
  const { dir, git, hook, hookRaw } = guardFixture(t, 'claude', 'job/7');
  git('remote', 'add', 'origin', 'https://github.com/o/fixture.git');
  const gh = standInGh(dir, { approved: false });
  const marked = (card) => ({ PATH: `${gh.bin}${delimiter}${process.env.PATH}`, CARRIED_PUSH_YES: card });

  const delivery = hook('git push -u origin job/7', marked('7'));
  assert.equal(delivery.status, 0, delivery.stderr);
  assert.equal(delivery.stderr, '');
  assert.ok(!gh.calls().some(([api, graphql]) => api === 'api' && graphql === 'graphql'), 'a carried push yes reads no advance approval');

  const toMain = hook('git push origin HEAD:main', marked('7'));
  assert.equal(toMain.status, 2, toMain.stderr);
  assert.ok(toMain.stderr.includes('a carried push yes session pushes only its own branch'), toMain.stderr);

  const otherCard = hook('git push -u origin job/7', marked('8'));
  assert.equal(otherCard.status, 2, otherCard.stderr);
  assert.ok(otherCard.stderr.includes('a carried push yes session publishes only its carried card'), otherCard.stderr);

  const noCommand = JSON.stringify({ cwd: join(dir, 'repo'), tool_input: {} });
  for (const input of ['this is not json', noCommand]) {
    const unreadable = hookRaw(input, marked('7'));
    assert.equal(unreadable.status, 2, `${input}: ${unreadable.stderr}`);
    assert.ok(unreadable.stderr.includes('a carried push yes session'), unreadable.stderr);
  }
});

function nativeRunFixture(dir, git, hookRaw, kind) {
  const worktree = join(dir, 'job-7');
  git('worktree', 'add', '-q', '-b', 'job/7', worktree);
  const privateGitDir = git('-C', worktree, 'rev-parse', '--path-format=absolute', '--git-dir');
  const designationDir = join(dir, 'repo', '.git', 'fabraik-app-run');
  mkdirSync(designationDir);
  const digest = createHash('sha256').update(realpathSync.native(worktree), 'utf8').digest('hex');
  const designationPath = join(designationDir, `${digest}.session`);
  const bindingPath = join(privateGitDir, 'fabraik-app-run.json');
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const record = { sessionId, kind, runStart: RUN_START, card: 7 };
  const setPair = ({ designation = `${sessionId}\n`, binding = JSON.stringify(record) } = {}) => {
    for (const [path, content] of [[designationPath, designation], [bindingPath, binding]]) {
      if (content === null) rmSync(path, { force: true });
      else writeFileSync(path, content);
    }
  };
  const payload = (cmd, workdir = worktree) => ({ session_id: sessionId, cwd: worktree, tool_input: { cmd, workdir } });
  const call = (input, marks) => hookRaw(input, marks, worktree);
  const run = (input, marks) => call(JSON.stringify(input), marks);
  return { worktree, designationPath, bindingPath, record, setPair, payload, call, run };
}

const NATIVE_UNAVAILABLE = /^Blocked: a native app run connection is unavailable/m;
const NATIVE_METADATA = /^Blocked: a native app run session must leave its binding metadata to the coordinator/m;

function assertNativeRefusal(run, reason) {
  assert.equal(run.status, 2, run.stderr || 'the hook did not refuse the command');
  assert.match(run.stderr, reason);
}

test('ANTI-REGRESSION: a native run keeps publication restrictions when its connection metadata is unavailable', { skip: without('codex') }, async (t) => {
  const { dir, git, hookRaw } = guardFixture(t, 'codex', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial commit');
  const { designationPath, bindingPath, record, setPair, payload, call, run } = nativeRunFixture(dir, git, hookRaw, 'product-manager');
  const push = payload('git push -u origin job/7');
  const status = payload('git status');
  const absent = { designation: null, binding: null };

  await t.test('matched product manager pair permits status and refuses a plain push', () => {
    setPair();
    const read = run(status);
    assert.equal(read.status, 0, read.stderr);
    assertNativeRefusal(run(push), /a product manager run session does not publish/);
  });
  await t.test('both records absent preserves ordinary publishing', () => {
    setPair(absent);
    const ordinary = run(push);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(ordinary.stderr, '');
  });

  const corrupt = 'NATIVE-CONNECTION-CORRUPT-SENTINEL';
  for (const [name, pair, input = push, reason = NATIVE_UNAVAILABLE] of [
    ['designation only', { binding: null }],
    ['binding only', { designation: null }],
    ['invalid binding JSON', { binding: corrupt }],
    ['wrong binding schema', { binding: JSON.stringify({ ...record, unexpected: true }) }],
    ['invalid binding timestamp', { binding: JSON.stringify({ ...record, runStart: '2026-13-04T12:00:00Z' }) }],
    ['wrong payload session ID', {}, { ...push, session_id: '123e4567-e89b-42d3-a456-426614174001' }],
    ['missing payload session ID', {}, { ...push, session_id: undefined }],
    ['missing command', {}, { ...push, tool_input: { workdir: push.tool_input.workdir } },
      /^Blocked: a native app run session is refused a call whose hook payload holds no string command/m],
    ['mismatched payload session cwd', {}, { ...push, cwd: join(dir, 'repo') }],
  ]) await t.test(name, () => {
    setPair(pair);
    const result = run(input);
    assert.ok(!result.stderr.includes(corrupt), 'the corrupt binding value reached stderr');
    assertNativeRefusal(result, reason);
  });
  await t.test('malformed payload', () => {
    setPair();
    assertNativeRefusal(call('this is not json'), NATIVE_UNAVAILABLE);
  });
  await t.test('matched pair with an inherited run mark', () => {
    setPair();
    assertNativeRefusal(run(push, { PRODUCT_MANAGER_RUN_SESSION: '1' }), NATIVE_UNAVAILABLE);
  });
  await t.test('binding only with Git unavailable', () => {
    setPair({ designation: null });
    const PATH = join(dir, 'empty-bin');
    mkdirSync(PATH);
    const marks = { PATH };
    const read = run(status, marks);
    assert.equal(read.status, 0, read.stderr);
    const results = [push, payload("gh issue comment 7 --body 'Approved: card=7 edited=none'")].map((input) => run(input, marks));
    for (const result of results) assertNativeRefusal(result, NATIVE_UNAVAILABLE);
  });
  await t.test('direct removal of the named connection metadata', () => {
    setPair();
    const removal = payload(`rm "${designationPath}" "${bindingPath}"`);
    const matched = run(removal);
    setPair({ designation: null });
    const bindingOnly = run(removal);
    setPair(absent);
    const ordinary = run(removal);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(ordinary.stderr, '');
    for (const result of [matched, bindingOnly]) assertNativeRefusal(result, NATIVE_METADATA);
  });
});

test('ANTI-REGRESSION: a native pre-approved job publishes only its bound worktree and card with live approval', { skip: without('codex') || withoutStandInGh }, async (t) => {
  const { dir, git, hookRaw } = guardFixture(t, 'codex', 'main');
  git('remote', 'add', 'origin', 'https://github.com/o/fixture.git');
  const settings = join(dir, 'repo', '.agents', 'factory-settings.json');
  mkdirSync(dirname(settings));
  writeFileSync(settings, '{"version":1,"preApprovedRun":true}');
  git('add', '.agents/factory-settings.json');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'enabled fetched settings');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const { worktree, setPair, payload, run } = nativeRunFixture(dir, git, hookRaw, 'pre-approved');
  const push = 'git push -u origin job/7';
  const gh = standInGh(dir);
  const withGh = ({ bin }) => ({ PATH: `${bin}${delimiter}${process.env.PATH}` });

  await t.test('bound job reads the live approval before admitting its push', () => {
    setPair();
    const result = run(payload(push), withGh(gh));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(gh.calls().some(([api, graphql, ...args]) => api === 'api' && graphql === 'graphql' && args.includes('number=7')),
      'the hook must read the bound card advance approval through gh');
  });
  await t.test('bound job without a live approval record', () => {
    setPair();
    const noRecordDir = join(dir, 'no-record');
    mkdirSync(noRecordDir);
    const noRecord = standInGh(noRecordDir, { approved: false });
    assertNativeRefusal(run(payload(push), withGh(noRecord)), /found no valid advance approval/);
  });
  await t.test('same branch and approval in another linked worktree', (t) => {
    setPair();
    const other = join(dir, 'other-worktree');
    git('worktree', 'add', '-q', '--detach', other, 'job/7');
    // Share the branch only for the contrast so the old branch check accepts both worktrees.
    t.after(() => git('-C', other, 'switch', '-q', '--detach', 'HEAD'));
    git('-C', other, 'symbolic-ref', 'HEAD', 'refs/heads/job/7');
    const before = gh.calls().length;
    const result = run(payload(push, other), withGh(gh));
    assert.equal(gh.calls().length, before, 'worktree refusal precedes GitHub reads');
    assertNativeRefusal(result, /\bbound worktree\b/);
  });
  await t.test('same worktree on another card branch with its own valid approval', (t) => {
    setPair();
    t.after(() => git('-C', worktree, 'switch', '-q', 'job/7'));
    git('-C', worktree, 'switch', '-q', '-c', 'job/8');
    const otherCardDir = join(dir, 'other-card');
    mkdirSync(otherCardDir);
    const otherCard = standInGh(otherCardDir, { card: 8 });
    const result = run(payload('git push -u origin job/8'), withGh(otherCard));
    assert.deepEqual(otherCard.calls(), [], 'card refusal precedes GitHub reads');
    assertNativeRefusal(result, /\bbound card\b/);
  });
});

// Pins the independently reviewed workflow, including its job-level branch condition.
// Recurring cost: one file read and hash; update only after configuration review.
test('ANTI-REGRESSION: the sweep scope workflow retains its reviewed job gate and execution configuration', {
  skip: !SETTINGS.docSweep && 'the settings file turns the documentation sweep off',
}, () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/sweep-scope.yml'));
  assert.equal(
    createHash('sha256').update(workflow).digest('hex'),
    '3e4e41a6be832f5c8e61c0ef6f1a2ccb2463222c423a28028cc08a3efd76d2f1',
    'the sweep workflow changed: independently review its configuration before updating this fixed oracle',
  );
});

// Independent oracle for the resume skill's parallel-slice route: Git runs its commands verbatim. Recurring cost: one
// disposable repository and about fifteen Git subprocesses. Remove if builders no longer run parallel slices.
test("the resume skill's parallel-slice commands run while the job branch is checked out", () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-parallel-slice-'));
  const repository = join(fixture, 'repository');
  const jobWorktree = join(fixture, 'job-1421');
  const sliceWorktree = join(fixture, 'slice-1421-parallel');
  const bullet = RESUME.slice(RESUME.indexOf('- Builders work inside the job worktree')).split(/\n- /)[0];
  const commands = [...bullet.matchAll(/`(git [^`]+)`/g)].map(([, command]) =>
    command.replaceAll('<issue>', '1421').replaceAll('<name>', 'parallel').replaceAll('<path>', sliceWorktree));
  for (const command of commands) assert.doesNotMatch(command, /<[^>]+>/, `unfilled placeholder in \`${command}\``);
  const argvs = commands.map((command) => command.split(/\s+/).slice(1));
  const [add, merge, remove, deleteBranch] = argvs;
  assert.deepEqual(
    argvs.map((argv) => argv.slice(0, argv[0] === 'merge' ? 1 : 2).join(' ')),
    ['worktree add', 'merge', 'worktree remove', 'branch -d'],
    'the parallel-slice route must cut, merge back, remove the worktree and delete the branch, in that order',
  );
  const env = {
    ...gitEnvironment(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // Force the editor on and make it fail, so the skill's merge command must be non-interactive.
    GIT_MERGE_AUTOEDIT: 'yes',
    GIT_EDITOR: 'false',
    GIT_AUTHOR_NAME: 'Workflow Contract Test',
    GIT_AUTHOR_EMAIL: 'contract-test@workflow.invalid',
    GIT_COMMITTER_NAME: 'Workflow Contract Test',
    GIT_COMMITTER_EMAIL: 'contract-test@workflow.invalid',
  };
  const git = (cwd, args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const ok = (run, what) => assert.equal(run.status, 0, `${what} failed: ${run.stderr}`);
  const commitFile = (cwd, name) => {
    writeFileSync(join(cwd, name), `${name}\n`);
    ok(git(cwd, ['add', name]), `git add ${name}`);
    ok(git(cwd, ['commit', '-q', '-m', name]), `git commit ${name}`);
    return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  };

  try {
    ok(git(fixture, ['init', '-q', repository]), 'git init');
    ok(git(repository, ['commit', '-q', '--allow-empty', '-m', 'fixture baseline']), 'baseline commit');
    ok(git(repository, ['worktree', 'add', '-q', '-b', 'job/1421', jobWorktree]), 'job worktree');

    const jobTip = git(jobWorktree, ['rev-parse', 'job/1421']).stdout.trim();
    ok(git(jobWorktree, add), `git ${add.join(' ')}`);
    assert.equal(git(sliceWorktree, ['rev-parse', 'HEAD']).stdout.trim(), jobTip, 'the slice must start at the job tip');

    const sliceCommit = commitFile(sliceWorktree, 'a.txt');
    commitFile(jobWorktree, 'b.txt');

    ok(git(jobWorktree, merge), `git ${merge.join(' ')}`);
    ok(git(jobWorktree, ['merge-base', '--is-ancestor', sliceCommit, 'job/1421']), 'slice commit on job/1421');

    ok(git(jobWorktree, remove), `git ${remove.join(' ')}`);
    ok(git(jobWorktree, deleteBranch), `git ${deleteBranch.join(' ')}`);
    assert.notEqual(
      git(jobWorktree, ['rev-parse', '--verify', '--quiet', 'refs/heads/slice/1421-parallel']).status,
      0,
      'the slice branch must be deleted',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Independent oracle for the instruction-order contract. Recurring cost: one disposable repository and eight Git
// subprocesses. Remove if closeout no longer relies on Git refusing deletion of a linked branch.
test('Git permits job branch deletion only after its linked worktree is removed', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-closeout-'));
  const repository = join(fixture, 'repository');
  const worktree = join(fixture, 'job-1350');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Workflow Contract Test',
    GIT_AUTHOR_EMAIL: 'contract-test@workflow.invalid',
    GIT_COMMITTER_NAME: 'Workflow Contract Test',
    GIT_COMMITTER_EMAIL: 'contract-test@workflow.invalid',
    // Hostile ambient signing config keeps the command-local `commit.gpgsign=false` override load-bearing.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gpg.format',
    GIT_CONFIG_VALUE_1: 'openpgp',
    GIT_CONFIG_KEY_2: 'user.signingKey',
    GIT_CONFIG_VALUE_2: 'workflow-contract-test-missing-key',
  };
  const git = (args) => spawnSync('git', args, { cwd: repository, env, encoding: 'utf8' });

  try {
    assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
    assert.equal(git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture baseline']).status, 0);
    assert.equal(git(['worktree', 'add', '-q', '-b', 'job/1350', worktree]).status, 0);

    const refused = git(['branch', '-d', 'job/1350']);
    assert.notEqual(refused.status, 0, 'Git must refuse to delete a branch checked out in a linked worktree');
    assert.match(`${refused.stdout}\n${refused.stderr}`, /checked out|worktree/i);

    const normalizedWorktree = process.platform === 'win32' ? realpathSync.native(worktree) : realpathSync(worktree);
    // Git for Windows prints worktree paths with forward slashes.
    const listedWorktree = process.platform === 'win32' ? normalizedWorktree.replaceAll('\\', '/') : normalizedWorktree;
    const worktreeEntry = new RegExp(`^worktree ${escapeRegExp(listedWorktree)}$`, 'm');
    const beforeRemoval = git(['worktree', 'list', '--porcelain']);
    assert.equal(beforeRemoval.status, 0);
    assert.match(beforeRemoval.stdout, worktreeEntry);

    assert.equal(git(['worktree', 'remove', worktree]).status, 0);
    const afterRemoval = git(['worktree', 'list', '--porcelain']);
    assert.equal(afterRemoval.status, 0);
    assert.doesNotMatch(afterRemoval.stdout, worktreeEntry);

    const deleted = git(['branch', '-d', 'job/1350']);
    assert.equal(deleted.status, 0, deleted.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// `git worktree remove` deletes ignored files without refusing, so each status read that precedes one must list
// them. Recurring cost: one file read.
test('every worktree status read in closeout also lists ignored files', () => {
  const closeout = readFileSync(resolve(ROOT, '.agents/skills/closeout/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  const statusReads = [...closeout.matchAll(/`([^`]*)`/g)].map(match => match[1]).filter(span => span.includes('status --porcelain'));

  assert.ok(statusReads.length >= 1, 'closeout must read worktree status for a leftover worktree');
  assert.deepEqual(
    statusReads,
    statusReads.map(() => 'git -C <path> status --porcelain --untracked-files=normal --ignored=matching'),
    'a worktree status read in closeout omits ignored files, which `git worktree remove` deletes without refusing',
  );
});

test('every seat that plans, designs, builds or reviews code names the coding standards', () => {
  // The explorer locates code and judges nothing, so it alone need not read the standards.
  const LOCATE_ONLY_SEATS = ['explorer'];
  const STANDARDS_PATH = /docs\/CODING-STANDARDS\.md(?![\w./-])/;
  const missing = [];
  for (const { directory: dir, extension } of PRESENT.map((runtime) => SEATS[runtime])) {
    const seats = readdirSync(resolve(ROOT, dir))
      .filter((name) => name.endsWith(extension))
      .map((name) => name.slice(0, -extension.length));
    assert.ok(seats.length > 0, `${dir} must hold at least one seat charter`);
    for (const exempt of LOCATE_ONLY_SEATS) {
      assert.ok(seats.includes(exempt), `the exempt seat ${exempt} must exist in ${dir}`);
    }
    for (const seat of seats.filter((name) => !LOCATE_ONLY_SEATS.includes(name))) {
      const path = `${dir}/${seat}${extension}`;
      if (!STANDARDS_PATH.test(readFileSync(resolve(ROOT, path), 'utf8'))) missing.push(path);
    }
  }
  assert.deepEqual(missing, [], `these seat charters must name docs/CODING-STANDARDS.md: ${missing.join(', ')}`);
});

// Recurring cost: one read of each seat file per skill. Remove a skill's entry when no seat reads it.
const SKILL_READING_SEATS = {
  'frontend-design': ['architect', 'builder', 'builder-lite', 'builder-max', 'reviewer'],
  'accessibility-review': ['builder', 'builder-lite', 'builder-max'],
};

for (const [skill, readingSeats] of Object.entries(SKILL_READING_SEATS)) {
  test(`exactly the seats that read the ${skill} skill name it, and the resume skill's visual reference names it`, () => {
    const SKILL_PATH = `.agents/skills/${skill}/SKILL.md`;
    const SKILL_TOKEN = `\`${SKILL_PATH}\``;
    for (const { directory: dir, extension } of PRESENT.map((runtime) => SEATS[runtime])) {
      const naming = readdirSync(resolve(ROOT, dir))
        .filter((name) => name.endsWith(extension) && readFileSync(resolve(ROOT, dir, name), 'utf8').includes(SKILL_TOKEN))
        .map((name) => name.slice(0, -extension.length))
        .sort();
      assert.deepEqual(naming, readingSeats, `${dir}: the seats whose charter names ${SKILL_PATH}`);
    }
    const visual = readFileSync(resolve(ROOT, '.agents/skills/resume/references/visual.md'), 'utf8');
    assert.ok(visual.includes(SKILL_TOKEN), `the resume skill's visual reference must name ${SKILL_PATH}`);
  });
}

test('the resume deliver step carries exactly the merge-watch command', () => {
  const rawStep = readFileSync(resolve(ROOT, '.agents/skills/resume/references/deliver.md'), 'utf8').match(/^4\. Watch it land[\s\S]*?(?=^## |(?![\s\S]))/m);
  assert.deepEqual(
    shellBlocks(rawStep[0]).map((block) => block.body),
    ['node scripts/merge-watch.mjs <pr>'],
    'step 4 must carry exactly one fenced block, the committed watch command',
  );
});

// Pins native command facts only; fresh semantic review assesses the takeover policy.
test('cloud takeover carries the origin provenance commands', () => {
  const cloud = readFileSync(resolve(ROOT, '.agents/skills/resume/references/cloud-build.md'), 'utf8');
  const commands = shellBlocks(cloud).map((block) => block.body);
  assert.ok(commands.includes('git remote get-url origin'));
  assert.ok(commands.includes('gh repo view --json id -- "<origin-url>"'));
  assert.deepEqual(commands.filter((command) => command.startsWith('gh pr view ')), [
    `gh pr view <pr> --json state,headRefName,headRepository,isCrossRepository,headRefOid,body --jq 'if .state == "OPEN" and .isCrossRepository == false and .headRepository.id == "<repository-id>" and .headRefName == "job/<issue>" then .headRefOid, (.body | splits("\\r?\\n") | select(startswith("Reviewed commit:"))) else error("unverified pull request provenance") end'`,
  ]);
});

// Splits markdown into the blocks a session copies into a shell and the prose around them. A block is a fence tagged
// `sh`, `bash` or `shell` or untagged, or an indented code block: a run of lines indented four spaces or a tab that
// follows a blank line. A fence tagged with any other language is skipped; prose keeps every other line, with each
// block's lines blanked so line numbers still match.
const SHELL_FENCE_TAGS = new Set(['sh', 'bash', 'shell', '']);
const INDENTED = /^(?: {4}|\t)/;

function splitMarkdown(markdown) {
  const blocks = [];
  const prose = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index].match(/^([ \t]*)```(\w*)[ \t]*$/);
    if (open) {
      const close = lines.findIndex((line, at) => at > index && /^[ \t]*```[ \t]*$/.test(line));
      assert.notEqual(close, -1, `the fence opened on line ${index + 1} must close`);
      if (SHELL_FENCE_TAGS.has(open[2])) {
        const body = lines.slice(index + 1, close).map((line) => (line.startsWith(open[1]) ? line.slice(open[1].length) : line));
        blocks.push({ line: index + 1, body: body.join('\n') });
      }
      prose.push(...Array(close - index + 1).fill(''));
      index = close;
    } else if (INDENTED.test(lines[index]) && (index === 0 || !lines[index - 1].trim())) {
      let end = index;
      while (end < lines.length && (INDENTED.test(lines[end]) || !lines[end].trim())) end += 1;
      while (!lines[end - 1].trim()) end -= 1;
      const body = lines.slice(index, end).map((line) => line.replace(INDENTED, ''));
      blocks.push({ line: index + 1, body: body.join('\n') });
      prose.push(...Array(end - index).fill(''));
      index = end - 1;
    } else {
      prose.push(lines[index]);
    }
  }
  return { blocks, prose: prose.join('\n') };
}

function shellBlocks(markdown) {
  return splitMarkdown(markdown).blocks;
}

// Every inline code span in the prose, its line breaks read as spaces; a span never crosses a blank line.
function inlineSpans(prose) {
  const spans = [];
  for (const match of prose.matchAll(/(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g)) {
    spans.push({ line: prose.slice(0, match.index).split('\n').length, body: match[2].replace(/\n/g, ' ') });
  }
  return spans;
}

// Everything a skill hands a session to run that isolation would refuse: each shell block's refused shapes, and each
// inline code span's too, since a session also runs a command quoted in prose, except brace expansion: spans also
// quote non-shell code such as the Codex `tools.write_stdin({ ... })` call, whose comma inside braces is not a command.
const SPAN_SHAPES = new Set(['command substitution', 'grouped block', 'control structure', 'more than one command']);

function skillShapeFindings(markdown) {
  const { blocks, prose } = splitMarkdown(markdown);
  const findings = [];
  for (const { line, body } of blocks) {
    const shapes = refusedShapes(body);
    if (shapes.length) findings.push({ where: `the block opened on line ${line}`, body, shapes });
  }
  for (const { line, body } of inlineSpans(prose)) {
    const shapes = refusedShapes(body).filter((shape) => SPAN_SHAPES.has(shape));
    if (shapes.length) findings.push({ where: `the inline span on line ${line}`, body, shapes });
  }
  return findings;
}

// The shapes Claude Code's worktree isolation refuses in one block, or [] when the block is one plain command.
// Continuation lines are joined, then quoted text is dropped: single quotes expand nothing, so a `$(` or `\(`
// inside a jq or GraphQL string is text; double quotes still expand `$(` and backticks, so those are caught first.
// Isolation reads a comma anywhere inside a `{...}` span as brace expansion, through quotes and nested brackets alike.
function refusedShapes(block) {
  const text = block.replace(/\\\n/g, ' ');
  const shapes = new Set();
  let residue = '';
  let quote = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote === "'") {
      if (char === "'") quote = '';
    } else if (quote === '"') {
      if (char === '\\') at += 1;
      else if (char === '"') quote = '';
      else if (char === '`' || (char === '$' && text[at + 1] === '(')) shapes.add('command substitution');
    } else if (char === "'" || char === '"') {
      quote = char;
      residue += 'Q';
    } else if (char === '\\') {
      at += 1;
      residue += 'E';
    } else {
      residue += char;
    }
  }
  if (/`|\$\(/.test(residue)) shapes.add('command substitution');
  if (/(?:^|[|;&])\s*[{(]/m.test(residue)) shapes.add('grouped block');
  if (/(?:^|[|;&])\s*(?:while|for|until|if|case)\b/m.test(residue)) shapes.add('control structure');
  if (/;|&&|\|\|/.test(residue) || residue.split('\n').filter((line) => line.trim()).length > 1) {
    shapes.add('more than one command');
  }
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(depth - 1, 0);
    else if (char === ',' && depth > 0) shapes.add('brace expansion');
  }
  return [...shapes];
}

// Recurring cost: one read of each resume reference.
test('the resume skill with its references, and the cross-review and to-issues skills, give only command shapes an isolated worktree session accepts', () => {
  const refuse = (path, markdown) => {
    for (const { where, body, shapes } of skillShapeFindings(markdown)) {
      // This Codex invocation is outside Claude Code's single-command restriction.
      if (path === '.agents/skills/resume/references/codex.md' && body === 'cd "<absolute-job-worktree>" && <command>') continue;
      assert.fail(`${path}, ${where}, must be one plain command, but has ${shapes.join(', ')}:\n${body}`);
    }
  };
  for (const name of ['resume', 'cross-review', 'to-issues']) {
    const path = `.agents/skills/${name}/SKILL.md`;
    const markdown = readFileSync(resolve(ROOT, path), 'utf8');
    assert.ok(shellBlocks(markdown).length > 0, `${path} must carry fenced shell blocks to inspect`);
    refuse(path, markdown);
  }
  const references = '.agents/skills/resume/references';
  for (const name of readdirSync(resolve(ROOT, references))) {
    const path = `${references}/${name}`;
    refuse(path, readFileSync(resolve(ROOT, path), 'utf8'));
  }
});

test('ANTI-REGRESSION: the resume skill reads the plan approval setting with a command whose answer does not depend on the current folder', () => {
  const reads = RESUME.match(/git ls-tree[^`\n]*/g) ?? [];
  assert.deepEqual(reads, ['git ls-tree --full-tree --name-only origin/main -- .agents/factory-settings.json']);
});

test('ANTI-REGRESSION: the resume skill reads the direction page only from the fetched main', () => {
  assert.deepEqual(RESUME_CORPUS.match(/git show\s+[^\s`]*PRODUCT-DIRECTION\.md[^\s`]*/g), [
    'git show origin/main:docs/PRODUCT-DIRECTION.md',
  ]);
});

test('ANTI-REGRESSION: the resume skill reads the settings file only from the fetched main', () => {
  const reads = RESUME_CORPUS.match(/git show\s+[^\s`]*factory-settings\.json[^\s`]*/g) ?? [];
  assert.ok(reads.length > 0, 'the resume skill reads the settings file with git show');
  for (const read of reads) assert.equal(read, 'git show origin/main:.agents/factory-settings.json');
});

// The product manager run judges a waiting job's overlap by this one listing. The manifest is left out because each entry changes only with the shared file it fingerprints, which the
// listing keeps. Recurring cost: one scan of text this file already reads.
test('the product manager run lists the files of a waiting job with one command that leaves out only the manifest', () => {
  const listings = inlineSpans(splitMarkdown(RESUME_CORPUS).prose)
    .map((span) => span.body.replace(/\s+/g, ' '))
    .filter((body) => body.includes('origin/main...job/'));
  assert.deepEqual(listings, [`git diff --name-only --no-renames origin/main...job/<card> -- ':(top,exclude)${MANIFEST_PATH}'`]);
});

// A leading environment assignment is captured, so a wrapper launch that loses its run mark fails here.
// Actual Claude deny arguments are protected by the executable launcher wire test.
// Recurring cost: one match over text this file already reads; update only after reviewing a launch change.
test('ANTI-REGRESSION: each run starts its Claude card sessions only with its pinned launches: a product manager run marked and refusing push and merge, a pre-approved run marked with its run start, each also carrying an owner answer', () => {
  assert.deepEqual(RESUME_CORPUS.replace(/\\\n\s*/g, ' ').match(/(?:\b[A-Z_]+=\S+ )?\b(?:claude\b[^`\n]*\s(?:-p|--print)\b|node scripts\/product-manager-run\.mjs --claude-card\b)[^`\n]*|\bcodex exec\b[^`\n]*/g), [
    'PRE_APPROVED_RUN_SESSION=<run-start> node scripts/product-manager-run.mjs --claude-card <absolute-logs-base>',
    'PRE_APPROVED_RUN_SESSION=<run-start> node scripts/product-manager-run.mjs --claude-card <phase-log-base> --prepared-context <context-file>',
    'PRODUCT_MANAGER_RUN_SESSION=1 node scripts/product-manager-run.mjs --claude-card <absolute-logs-base>',
    'PRODUCT_MANAGER_RUN_SESSION=1 node scripts/product-manager-run.mjs --claude-card <absolute-logs-base> --carry <absolute-logs-base>.answer.json',
    'PRE_APPROVED_RUN_SESSION=<run-start> node scripts/product-manager-run.mjs --claude-card <absolute-logs-base> --carry <absolute-logs-base>.answer.json',
  ]);
});

// Recurring cost: one read of the run reference.
test('ANTI-REGRESSION: a suggested card carries its hold in the one call that creates it', () => {
  const step = PRODUCT_MANAGER_RUN.slice(PRODUCT_MANAGER_RUN.indexOf('10. **Suggested cards.**'), PRODUCT_MANAGER_RUN.indexOf('11. **Splitting a card.**'));
  const creates = step.match(/gh issue create[^`]*/g) ?? [];
  assert.equal(creates.length, 1, 'step 10 must give exactly one create command');
  assert.ok(creates[0].startsWith("gh issue create --title 'Proposed: "), `the create command must set the hold: ${creates[0]}`);
});

// Every strict-tdd chronology gap but the two record slips reaches the owner. Pins the table's exact kinds and
// deciders in any row order, never a definition's wording, which fresh review judges. Recurring cost: one scan of
// text this file already reads.
test('ANTI-REGRESSION: the strict chronology audit settles only the two record slips itself and sends code before red to the owner', () => {
  const lines = RESUME_CORPUS.split('\n').map((line) => line.trim());
  const headers = lines.flatMap((line, at) => (line.startsWith('| Chronology gap |') ? [at] : []));
  assert.equal(headers.length, 1, 'the resume skill must hold exactly one chronology gap table');
  const rows = [];
  for (let at = headers[0] + 2; at < lines.length && lines[at].startsWith('|'); at += 1) {
    const cells = lines[at].split('|').slice(1, -1).map((cell) => cell.trim());
    rows.push(`${cells[0]} | ${cells.at(-1)}`);
  }
  assert.deepEqual(rows.sort(), [
    'Code before red | The owner',
    'Paperwork slip | The coordinating session',
    'Selection slip | The coordinating session',
  ]);
});

test('the refused-shape check catches each refused shape and passes quoted jq text', () => {
  const cases = [
    ['echo "$(git branch --show-current)"', ['command substitution']],
    ['echo `date`', ['command substitution']],
    ['{ echo a; } > out', ['grouped block', 'more than one command']],
    ['( cd x )', ['grouped block']],
    ['while :; do sleep 1; done', ['control structure', 'more than one command']],
    ['cat a | if true', ['control structure']],
    ['a && b', ['more than one command']],
    ['a\nb', ['more than one command']],
    ["gh api \\\n  --jq '\"\\(.x) $(y)\"' > out", []],
    [
      "gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){subIssue{number}}}' -f p=X -f c=Y",
      ['brace expansion'],
    ],
    ['gh api graphql -f query=\'query{repository(owner:"a",name:"b"){id}}\'', ['brace expansion']],
    [
      "gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p subIssueId:$c}){subIssue{number}}}' -f p=X -f c=Y",
      [],
    ],
    ['gh api repos/{owner}/{repo}/issues/1', []],
  ];
  for (const [block, shapes] of cases) assert.deepEqual(refusedShapes(block), shapes, block);

  const markdown = [
    'Read the branch with `git branch --show-current`, then',
    'run `cd x && make` or `echo $(date)`, but `jq ".a; .b"` is text.',
    'Nor may a span run `(cd x)` or `while true`.',
    '',
    '    git fetch; git status',
    '',
    '```sh',
    'node scripts/board.mjs',
    '```',
  ].join('\n');
  assert.deepEqual(skillShapeFindings(markdown), [
    { where: 'the block opened on line 5', body: 'git fetch; git status', shapes: ['more than one command'] },
    { where: 'the inline span on line 2', body: 'cd x && make', shapes: ['more than one command'] },
    { where: 'the inline span on line 2', body: 'echo $(date)', shapes: ['command substitution'] },
    { where: 'the inline span on line 3', body: '(cd x)', shapes: ['grouped block'] },
    { where: 'the inline span on line 3', body: 'while true', shapes: ['control structure'] },
  ]);
});

// True where the value stands alone, so an adopter's effort `low` is not found inside "below" or "follows", nor a
// model name inside a longer one, and a value that ends a sentence is found.
const copiesValue = (text, value) => new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(value)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`).test(text);

test('the copied-value check matches a whole value and never a fragment of a longer word', () => {
  assert.equal(copiesValue('The reviewer runs below the author and follows the card.', 'low'), false);
  assert.equal(copiesValue('Effort is low', 'low'), true);
  assert.equal(copiesValue('Effort is `low`', 'low'), true);
  assert.equal(copiesValue('model_reasoning_effort=low', 'low'), true);
  assert.equal(copiesValue('Use example-newer-model-mini here.', 'example-newer-model'), false);
  assert.equal(copiesValue('Use example-older-example-newer-model here.', 'example-newer-model'), false);
  assert.equal(copiesValue('Use example-newer-model here.', 'example-newer-model'), true);
  assert.equal(copiesValue('Effort is low.', 'low'), true);
  assert.equal(copiesValue('Use example-newer-model.', 'example-newer-model'), true);
  assert.equal(copiesValue('Use example-newer-model. Then stop.', 'example-newer-model'), true);
  assert.equal(copiesValue('Use example-newer-model.2 here.', 'example-newer-model'), false);
  assert.equal(copiesValue('Use example-newer-modelo here.', 'example-newer-model'), false);
});

test("the cross-review skill does not copy the reviewer seat's model or effort values", { skip: without('codex') }, () => {
  const skill = readFileSync(resolve(ROOT, '.agents/skills/cross-review/SKILL.md'), 'utf8');
  const seat = readFileSync(resolve(ROOT, '.codex/agents/reviewer.toml'), 'utf8');
  for (const key of ['model', 'model_reasoning_effort']) {
    const value = seat.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1];
    assert.ok(value, `.codex/agents/reviewer.toml must set ${key}`);
    assert.ok(!copiesValue(skill, value), `cross-review must not copy the reviewer's ${key} value ${value}`);
  }
});

test('AGENTS.md carries one shared workflow region followed by the product headings and the Surfaces table', () => {
  const manual = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');
  const start = '<!-- factory-shared:start -->';
  const end = '<!-- factory-shared:end -->';
  assert.equal(manual.split(start).length - 1, 1, 'AGENTS.md must carry exactly one shared-region start marker');
  assert.equal(manual.split(end).length - 1, 1, 'AGENTS.md must carry exactly one shared-region end marker');
  const startAt = manual.indexOf(start);
  const endAt = manual.indexOf(end);
  assert.ok(startAt < endAt, 'the shared-region start marker must precede its end marker');

  const product = manual.slice(endAt);
  const shapeFault = productTailShapeProblem(product);
  assert.equal(shapeFault, undefined, shapeFault);

  const surfaces = product.slice(product.search(/^## Surfaces$/m)).split('\n');
  assert.ok(
    surfaces.find((line) => /^\d+\. /.test(line))?.startsWith('1. '),
    'the standing security guarantees must start with a numbered item 1.',
  );
  const securityRow = surfaces.find((line) => line.startsWith('|') && line.split('|')[1].trim() === 'security review');
  const targets = [...securityRow.split('|')[2].matchAll(/\]\(([^)#\s]+)[^)]*\)/g)].map((match) => match[1]);
  assert.ok(targets.length > 0, 'the security review row must link the privacy documents');
  for (const target of targets) {
    assert.ok(existsSync(resolve(ROOT, target)), `the security review row links ${target}, which does not exist`);
  }

  assert.ok(Buffer.byteLength(manual) < MANUAL_LIMIT, `AGENTS.md must stay under the ${MANUAL_LIMIT} byte Codex read cap`);
});

test('the profile file carries its four headings and the Conventions table', () => {
  const profile = readFileSync(resolve(ROOT, '.agents/REPOSITORY.md'), 'utf8');
  const shapeFault = profileShapeProblem(profile);
  assert.equal(shapeFault, undefined, shapeFault);
});

const FIXED_PRODUCT_DOCUMENTS = [
  'GLOSSARY.md',
  'docs/README.md',
  'docs/CODING-STANDARDS.md',
  'docs/TESTING-STRATEGY.md',
  'docs/DESIGN-SYSTEM.md',
  'docs/ISSUE-TRACKER.md',
  'docs/DOC-SWEEP.md',
  'docs/SWEEP-TRIAGE.md',
  '.agents/REPOSITORY.md',
];
const requiredDocuments = (settings) => FIXED_PRODUCT_DOCUMENTS.filter((path) => needNotResolveCause(settings, path) === null);

test('the fixed product documents exist', () => {
  const missing = requiredDocuments(SETTINGS).filter((path) => !existsSync(resolve(ROOT, path)));
  assert.deepEqual(missing, [], `the shared workflow points at these fixed product documents, which are missing: ${missing.join(', ')}`);
});

test('ANTI-REGRESSION: a tree that turns the documentation sweep off need not hold the two sweep manuals, and must still hold every other fixed product document', () => {
  const settings = readSettingsHeader('{"version":1,"seats":{},"docSweep":false}', SETTINGS_PATH);
  assert.deepEqual(requiredDocuments(settings), [
    'GLOSSARY.md',
    'docs/README.md',
    'docs/CODING-STANDARDS.md',
    'docs/TESTING-STRATEGY.md',
    'docs/DESIGN-SYSTEM.md',
    'docs/ISSUE-TRACKER.md',
    '.agents/REPOSITORY.md',
  ]);
});

// Runs the real prepare script in a fresh repository holding a copy of package.json. The environment drops git's
// repository-scoped variables, so an inherited GIT_DIR cannot aim the script at this repository, keeps npm's log
// inside the temporary repository and skips npm's update check, so nothing outside that repository changes.
test('npm install activates the git hooks through the prepare script', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-prepare-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...gitEnvironment(), npm_config_logs_dir: join(root, '.npm-logs'), npm_config_update_notifier: 'false' };
  const run = (command, ...args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
  assert.equal(run('git', 'init', '-q').status, 0);
  cpSync(resolve(ROOT, 'package.json'), join(root, 'package.json'));
  // On Windows npm is npm.cmd, which only a shell can start; the arguments are constants.
  const prepare = spawnSync('npm', ['run', 'prepare'], { cwd: root, encoding: 'utf8', env, shell: process.platform === 'win32' });
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.equal(
    run('git', 'config', '--get', 'core.hooksPath').stdout.trim(),
    '.githooks',
    'package.json scripts.prepare does not set core.hooksPath to .githooks, so `npm install` would not activate the git hooks',
  );
});

// Machinery admission: the friction route. The placement sentence did not hold the main resume skill's size through
// three growth periods, so a measured limit replaces it. Recurring cost: none beyond the existing RESUME read.
test('the main resume skill stays within 40,000 bytes', () => {
  const bytes = Buffer.byteLength(RESUME, 'utf8');
  assert.ok(bytes <= 40000, `.agents/skills/resume/SKILL.md is ${bytes} bytes, over the 40,000-byte limit. Keep intake through build in it; text for a later step, an exception, a held card, advance approval, batch review, a run or one runtime only belongs in a reference under .agents/skills/resume/references/, read through a pointer sentence where its step or case is reached.`);
});

// The resume skill reads one result as "the hooks are running": a guard hook refusing this command in these words.
// Every installed real hook runs, because the words are theirs, and the rule is judged in both kinds of checkout,
// because the suite runs in only one. Recurring cost: one Node start per installed runtime.
test('ANTI-REGRESSION: every installed git guard hook refuses the hook check the resume skill names, in the words it reads', () => {
  const HOOK_CHECK = 'git commit --no-verify --dry-run';
  const REFUSAL = 'Blocked: git commit';
  for (const literal of [HOOK_CHECK, REFUSAL]) {
    assert.ok(RESUME.includes(`\`${literal}\``), `the resume skill must name \`${literal}\` on one line`);
  }
  const input = JSON.stringify({ cwd: ROOT, tool_input: { command: HOOK_CHECK } });
  for (const hook of PRESENT.map((runtime) => `.${runtime}/hooks/block-unsafe-git.mjs`)) {
    const run = spawnSync(process.execPath, [resolve(ROOT, hook)], { input, encoding: 'utf8', env: { ...gitEnvironment(), PRODUCT_MANAGER_RUN_SESSION: undefined, PRE_APPROVED_RUN_SESSION: undefined, CARRIED_PUSH_YES: undefined } });
    assert.equal(run.status, 2, `${hook} must refuse the hook check before git runs: ${run.stderr}`);
    assert.ok(run.stderr.includes(REFUSAL), `${hook} must refuse in the words the skill reads: ${run.stderr}`);
  }
  for (const cwd of ['/root', '/job']) {
    const checkout = { cwd, isRootCheckout: (dir) => dir === '/root', platform: process.platform };
    assert.match(blockReason(HOOK_CHECK, checkout), /^git commit /, `the guard must refuse the hook check in ${cwd}`);
  }
});

test('the review line has two specified forms, and the template and skills point at them', () => {
  // Hand-written from the owner-approved forms, never extracted from a repo file, so
  // a drift in the template's examples cannot silently redefine what the test accepts.
  const BASE_LINE =
    /^Review: tier=(document|code|sign-off) rounds=([1-9]\d*) raised=(0|[1-9]\d*) fixed=(0|[1-9]\d*) dismissed=(0|[1-9]\d*) deferred=(0|[1-9]\d*)\s*$/;
  const ADD_ON_LINE =
    /^Review: tier=(document|code|sign-off) rounds=([1-9]\d*) raised=(0|[1-9]\d*) fixed=(0|[1-9]\d*) dismissed=(0|[1-9]\d*) deferred=(0|[1-9]\d*) greptile_rounds=(0|[1-9]\d*) greptile_raised=(0|[1-9]\d*) greptile_true=(0|[1-9]\d*)\s*$/;
  const assertValidLine = (line, where) => {
    const m = BASE_LINE.exec(line ?? '') ?? ADD_ON_LINE.exec(line ?? '');
    assert.ok(m, `${where}: example review line ${JSON.stringify(line)} no longer matches either approved form`);
    const [rounds, raised, fixed, dismissed, deferred, gRounds, gRaised, gTrue] = m.slice(2).map(Number);
    assert.equal(
      raised,
      fixed + dismissed + deferred,
      `${where}: example review line has raised not equal to fixed plus dismissed plus deferred`,
    );
    if (m.length === 7) return;
    assert.ok(gRounds <= rounds, `${where}: example review line has greptile_rounds greater than rounds`);
    assert.ok(gRaised <= raised, `${where}: example review line has greptile_raised greater than raised`);
    assert.ok(gTrue <= gRaised, `${where}: example review line has greptile_true greater than greptile_raised`);
    assert.ok(
      gTrue <= fixed + deferred,
      `${where}: example review line has greptile_true greater than fixed plus deferred`,
    );
    assert.ok(
      gRaised - gTrue <= dismissed,
      `${where}: example review line has more false Greptile findings than dismissed`,
    );
    assert.ok(
      gRounds > 0 || gRaised === 0,
      `${where}: example review line has Greptile findings but greptile_rounds=0`,
    );
  };

  const PREFIX = 'Review: tier=sign-off rounds=7 raised=16 fixed=13 dismissed=2 deferred=1';
  assertValidLine(PREFIX, 'base-form fixture');
  assertValidLine(`${PREFIX} greptile_rounds=0 greptile_raised=0 greptile_true=0`, 'no-Greptile add-on fixture');
  assert.throws(
    () => assertValidLine('Review: tier=sign-off rounds=7 raised=17 fixed=13 dismissed=2 deferred=1', 'fixture'),
    /raised not equal to fixed plus dismissed plus deferred/,
    'a base-form line whose raised does not add up was accepted',
  );
  for (const between of [`${PREFIX} greptile_rounds=2`, `${PREFIX} greptile_rounds=2 greptile_raised=1`]) {
    assert.ok(!BASE_LINE.test(between) && !ADD_ON_LINE.test(between), `${between} matches a specified form`);
    assert.throws(() => assertValidLine(between, 'fixture'), /matches either approved form/, `${between} was accepted`);
  }
  for (const [broken, message] of [
    [`${PREFIX} greptile_rounds=8 greptile_raised=1 greptile_true=1`, /greptile_rounds greater than rounds/],
    [`${PREFIX} greptile_rounds=2 greptile_raised=17 greptile_true=1`, /greptile_raised greater than raised/],
    [`${PREFIX} greptile_rounds=2 greptile_raised=1 greptile_true=2`, /greptile_true greater than greptile_raised/],
    [`${PREFIX} greptile_rounds=0 greptile_raised=1 greptile_true=0`, /Greptile findings but greptile_rounds=0/],
    [
      'Review: tier=sign-off rounds=2 raised=1 fixed=0 dismissed=1 deferred=0 greptile_rounds=1 greptile_raised=1 greptile_true=1',
      /greptile_true greater than fixed plus deferred/,
    ],
    [
      'Review: tier=sign-off rounds=2 raised=1 fixed=1 dismissed=0 deferred=0 greptile_rounds=1 greptile_raised=1 greptile_true=0',
      /more false Greptile findings than dismissed/,
    ],
  ]) {
    assert.throws(() => assertValidLine(broken, 'fixture'), message, `${broken} was accepted`);
  }

  const template = readFileSync(resolve(ROOT, '.github/pull_request_template.md'), 'utf8');
  const lines = template.split('\n');
  const heading = lines.indexOf('## Review');
  assert.ok(heading >= 0, '.github/pull_request_template.md lost its "## Review" section');
  const next = lines.findIndex((l, i) => i > heading && l.startsWith('<details>'));
  const section = lines.slice(heading, next === -1 ? undefined : next);
  const fences = section.flatMap((l, i) => (l.startsWith('```') ? [i] : []));
  assert.equal(
    fences.length,
    4,
    'the Review section of .github/pull_request_template.md must hold exactly two fenced examples, the base form then the add-on form',
  );
  const [base, addOn] = [section[fences[0] + 1], section[fences[2] + 1]];
  assertValidLine(base, '.github/pull_request_template.md base example');
  assert.ok(BASE_LINE.test(base), 'the first fenced example in .github/pull_request_template.md is not the base form');
  assertValidLine(addOn, '.github/pull_request_template.md add-on example');
  assert.ok(ADD_ON_LINE.test(addOn), 'the second fenced example in .github/pull_request_template.md is not the add-on form');

  const example = /for example `([^`]*)`/.exec(template)?.[1];
  assertValidLine(example, '.github/pull_request_template.md');
  assert.ok(BASE_LINE.test(example), 'the pull request template example is not the base form');
  assert.deepEqual(
    template
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((l) => BASE_LINE.test(l) || ADD_ON_LINE.test(l)),
    [],
    'the pull request template has a line outside an HTML comment that a parser would read as a real review line',
  );

  for (const [skill, text] of [['.agents/skills/resume', RESUME_CORPUS], ['.agents/skills/closeout/SKILL.md', readFileSync(resolve(ROOT, '.agents/skills/closeout/SKILL.md'), 'utf8')]]) {
    assert.ok(
      text.includes('.github/pull_request_template.md'),
      `${skill} no longer links to .github/pull_request_template.md`,
    );
  }
});

// The carried-receipt record: the Receipt reuse rule in the resume skill's deliver reference must name each slot the
// pull request template carries, which the template's skeleton test below pins there, and the two commands that settle
// a commit added on top. Hand-written from the approved record, never extracted from either file. Recurring cost: one
// read and scan of the deliver reference.
const CARRIED_SLOTS = ['Carried from:', 'Changed paths:', 'Carried receipts:'];

test("the Receipt reuse rule in the resume skill's deliver reference names each carried-receipt slot and both commands", () => {
  const COMMANDS = [
    'git merge-base --is-ancestor <earlier-commit> HEAD',
    'git -c core.quotePath=false diff --name-only --no-renames --ignore-submodules=none <earlier-commit> HEAD',
  ];
  const spans = new Set(inlineSpans(splitMarkdown(readFileSync(resolve(ROOT, '.agents/skills/resume/references/deliver.md'), 'utf8')).prose).map((span) => span.body.replace(/\s+/g, ' ')));
  for (const literal of [...CARRIED_SLOTS, ...COMMANDS]) {
    assert.ok(spans.has(literal), `the resume skill's Receipt reuse rule must name \`${literal}\` as one code span`);
  }
});

// After a waiting card merges, a card built beside it is rebased; the rebase runs no commit gate, so its fingerprints
// are re-recorded by the canonical recovery. Recurring cost: one scan of the deliver reference.
test('the deliver step re-records every fingerprint with the canonical recovery after a rebase', () => {
  const spans = new Set(inlineSpans(splitMarkdown(readFileSync(resolve(ROOT, '.agents/skills/resume/references/deliver.md'), 'utf8')).prose).map((span) => span.body.replace(/\s+/g, ' ')));
  for (const literal of [MANIFEST_PATH, 'node scripts/factory-sync.mjs --write']) {
    assert.ok(spans.has(literal), `the deliver reference must name \`${literal}\` as one code span`);
  }
});

// The owner decides on what a collapsed section leaves in view, so each slot is pinned to its section and to its
// side of a collapse. Recurring cost: one read of a small file.
test('the pull request template carries each section and slot once, in order, with the receipts, review findings and decision card collapsed', () => {
  const RECEIPT_TABLE = '| Claim | Construction mode | Focused test | Discrimination proof | Result |';
  const BEFORE = '- **Before:**';
  const AFTER = '  **After:**';
  const REVIEW_SLOT = 'Review: tier= rounds= raised= fixed= dismissed= deferred=';
  const SLOTS = ['Closes #', 'Undo:', 'Reach:', BEFORE, AFTER, 'Passed:', 'Failed:', 'Untested:', RECEIPT_TABLE, ...CARRIED_SLOTS, REVIEW_SLOT, '<details>', '</details>'];
  const lines = readFileSync(resolve(ROOT, '.github/pull_request_template.md'), 'utf8')
    .split('\n')
    .map((line) => line.trimEnd());
  assert.deepEqual(
    lines.filter((line) => line.startsWith('## ') || line.startsWith('<summary>') || SLOTS.includes(line)),
    [
      '## Summary', 'Closes #',
      '## Not done',
      '## Merge Danger', 'Undo:', 'Reach:',
      '## Evidence', BEFORE, AFTER, 'Passed:', 'Failed:', 'Untested:', '<details>', '<summary>Test receipts</summary>', RECEIPT_TABLE, ...CARRIED_SLOTS, '</details>',
      '## Review', REVIEW_SLOT, '<details>', '<summary>Review findings</summary>', '</details>',
      '<details>', '<summary>Decision card</summary>', '</details>',
    ],
    'the pull request template must carry exactly these sections, slots and collapsed sections, in this order',
  );
  // GitHub renders the Markdown inside a collapsed section only after a blank line follows its summary.
  for (const [at, line] of lines.entries()) {
    if (line.startsWith('<summary>')) assert.equal(lines[at + 1], '', `the template's ${line} line must be followed by a blank line`);
  }
  // The retro finds a job's card by this exact line, so a rename would silently empty its card check.
  assert.ok(
    readFileSync(resolve(ROOT, 'docs/WEEKLY-RETRO.md'), 'utf8').includes('<summary>Decision card</summary>'),
    'the weekly retro must find the card by the line the template carries',
  );
});

test('every manifest entry matches the file on disk', () => {
  const { canonical } = readManifest(ROOT);
  const mismatches = verifyManifest(ROOT);
  assert.equal(
    mismatches.length,
    0,
    [
      'These shared workflow files differ from .agents/factory-manifest.json:',
      ...mismatches.map(({ path, expected, actual }) => `  ${path}: recorded ${expected}, found ${actual}`),
      `In an adopter repository, undo the local edit, make the change in the canonical repository (${canonical}), then apply the release that carries it with a release update.`,
      'In the canonical repository, follow .agents/skills/shared-files/SKILL.md#canonical-recording for source/copy staging, automatic commit recording where the local profile supplies it, and explicit recovery with `node scripts/factory-sync.mjs --write`.',
      'For a seat setting, run `node scripts/factory-sync.mjs --render` and commit the seat files with the manifest.',
    ].join('\n'),
  );
});

// Each tracked path under the given directories with its git index mode.
function indexEntries(...directories) {
  const listed = spawnSync('git', ['ls-files', '-s', '--', ...directories], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    return { mode: meta.split(' ')[0], path };
  });
}

// A symlink does not survive a Windows checkout without developer mode, so every installed skill is a real copy
// that must stay byte-identical to the file it copies.
test('skill copies are byte-identical to their sources and no skill is a symlink', () => {
  const entries = indexEntries('.agents/skills', '.claude/skills', '.agents/upstream');
  const problems = entries
    .filter(({ mode, path }) => mode === '120000' && /^\.(?:agents|claude)\/skills\//.test(path))
    .map(({ path }) => `${path} is a symlink`);
  const under = (prefix) =>
    new Set(entries.filter(({ mode, path }) => mode !== '120000' && path.startsWith(prefix)).map(({ path }) => path.slice(prefix.length)));
  const compare = (copies, copyRoot, sources, sourceRoot) => {
    for (const rest of copies) {
      if (!sources.has(rest)) problems.push(`${copyRoot}${rest} has no ${sourceRoot}${rest}`);
      else if (!readFileSync(resolve(ROOT, copyRoot + rest)).equals(readFileSync(resolve(ROOT, sourceRoot + rest)))) {
        problems.push(`${copyRoot}${rest} differs from ${sourceRoot}${rest}`);
      }
    }
  };
  const agents = under('.agents/skills/');
  const claude = under('.claude/skills/');
  if (PRESENT.includes('claude')) {
    compare(claude, '.claude/skills/', agents, '.agents/skills/');
    compare([...agents].filter((rest) => !claude.has(rest)), '.agents/skills/', claude, '.claude/skills/');
  }

  const skillNames = new Set(entries.filter(({ path }) => path.startsWith('.agents/skills/')).map(({ path }) => path.split('/')[2]));
  for (const { path } of entries) {
    const match = /^(\.agents\/upstream\/[^/]+\/)([^/]+)\/SKILL\.md$/.exec(path);
    if (!match || !skillNames.has(match[2])) continue;
    const [, sourceRoot, name] = match;
    const upstream = new Set([...under(sourceRoot)].filter((rest) => rest.startsWith(`${name}/`)));
    const installed = new Set([...agents].filter((rest) => rest.startsWith(`${name}/`)));
    compare(upstream, sourceRoot, installed, '.agents/skills/');
    compare([...installed].filter((rest) => !upstream.has(rest)), '.agents/skills/', upstream, sourceRoot);
  }
  assert.deepEqual(problems, [], 'every skill is a tracked real copy, byte-identical to its source');
});

// Each skill is copied from the upstream repository at the commit docs/AI-WORKFLOW-runtimes.md records. Each hash is
// the upstream file's at that commit, so an edit in place goes red even after the manifest is re-recorded, and so does
// a copy or a licence the manifest stops listing. `files` sit in all three roots; `repositoryLicence` is the upstream
// repository's own licence, kept once beside the skill where the skill's folder carries none. A refresh replaces a
// skill's hashes with the new commit's. Recurring cost: one manifest read per skill. Remove a skill's entry when it
// is no longer vendored.
const UPSTREAM_PINS = {
  'frontend-design': {
    roots: [
      '.agents/skills/frontend-design/',
      '.agents/upstream/anthropics-claude-plugins-official/frontend-design/',
      '.claude/skills/frontend-design/',
    ],
    files: {
      'LICENSE.txt': '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
      'SKILL.md': 'd91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3',
    },
    repositoryLicence: {},
  },
  'accessibility-review': {
    roots: [
      '.agents/skills/accessibility-review/',
      '.agents/upstream/anthropics-knowledge-work-plugins/accessibility-review/',
      '.claude/skills/accessibility-review/',
    ],
    files: { 'SKILL.md': 'ef42982af0d51238dda2ab16d08626712891bdd41864876c32d1e7b13fb3124f' },
    repositoryLicence: {
      '.agents/upstream/anthropics-knowledge-work-plugins/LICENSE':
        'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    },
  },
  pr: {
    roots: ['.agents/skills/pr/', '.agents/upstream/mattpocock-skills/pr/', '.claude/skills/pr/'],
    files: {
      'CREDITS.md': 'a7a087127665d7298a72280ef6e19c41ad8404523712a788c8dc3ab414bc2497',
      'SKILL.md': 'ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd',
      'agents/openai.yaml': '2295b586624db4ef546f3fd4695492f039d941a46d8a1593a702ce3ca511b8ad',
    },
    repositoryLicence: {
      '.agents/upstream/mattpocock-skills/LICENSE':
        '0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5',
    },
  },
};

for (const [skill, { roots, files, repositoryLicence }] of Object.entries(UPSTREAM_PINS)) {
  test(`the ${skill} skill ships unedited, with its licence, to both runtimes`, () => {
    const expected = [
      ...roots.flatMap((root) => Object.entries(files).map(([file, sha256]) => ({ path: root + file, sha256 }))),
      ...Object.entries(repositoryLicence).map(([path, sha256]) => ({ path, sha256 })),
    ];
    const byPath = (a, b) => (a.path < b.path ? -1 : 1);
    assert.deepEqual(
      readManifest(ROOT).entries
        .filter(({ path }) => path.includes(`/${skill}/`) || Object.hasOwn(repositoryLicence, path))
        .sort(byPath),
      expected.sort(byPath),
      'the manifest must list exactly the upstream skill in all three places and its licence, at the upstream hashes',
    );
  });
}

// gitattributes(5): an `eol=lf` rule overrides core.autocrlf, so a hook keeps its LF shebang line on Windows.
const HOOK_DIRECTORIES = ['.githooks', ...PRESENT.map((runtime) => `.${runtime}/hooks`)];
const LF_RULE = '* text eol=lf\n';

test('hook scripts carry the LF rule and the git hooks their run permission', () => {
  const manifest = new Map(readManifest(ROOT).entries.map((entry) => [entry.path, entry]));
  const problems = [];
  for (const directory of HOOK_DIRECTORIES) {
    const tracked = indexEntries(directory);
    const attributes = `${directory}/.gitattributes`;
    if (!tracked.some(({ path }) => path === attributes)) problems.push(`${attributes} is not tracked`);
    else if (readFileSync(resolve(ROOT, attributes), 'utf8') !== LF_RULE) problems.push(`${attributes} is not exactly ${JSON.stringify(LF_RULE)}`);
    if (!manifest.has(attributes)) problems.push(`${attributes} is not a manifest entry`);

    const eol = spawnSync('git', ['ls-files', '--eol', '--', directory], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(eol.status, 0, eol.stderr);
    for (const line of eol.stdout.split('\n').filter(Boolean)) {
      const [meta, path] = line.split('\t');
      if (manifest.has(path) && !meta.startsWith('i/lf ')) problems.push(`${path} is not LF in the index (${meta.trim()})`);
    }
  }
  for (const { mode, path } of indexEntries('.githooks')) {
    if (path === '.githooks/README.md' || path === '.githooks/.gitattributes') continue;
    if (mode !== '100755') problems.push(`${path} has index mode ${mode}, not 100755`);
    if (manifest.get(path)?.executable !== true) problems.push(`${path} manifest entry lacks executable: true`);
  }
  assert.deepEqual(problems, [], 'every hook directory checks out LF and every git hook runs');
});

// A vendored upstream skill or an installed copy of one.
const VENDORED_SKILLS = new Set(
  indexEntries('.agents/upstream').flatMap(({ path }) => /^\.agents\/upstream\/[^/]+\/([^/]+)\/SKILL\.md$/.exec(path)?.slice(1) ?? []),
);
const vendoredCopy = (path) =>
  path.startsWith('.agents/upstream/') || VENDORED_SKILLS.has(/^\.(?:agents|claude)\/skills\/([^/]+)\//.exec(path)?.[1]);
// The entries the path scan reads: those a tree with these settings installs. Vendored skills and their copies are
// replaced whole and never edited in place, so the scan skips them.
const scannedEntries = (settings, entries) => entries.filter(({ path }) => !vendoredCopy(path) && leftOutCause(settings, path) === null);

// Paths outside the manifest that shared code or prose names in every adopter, each with the reason it may.
const ADOPTER_PATHS = {
  [MANIFEST_PATH]: 'the manifest itself, which lists every shared file but not its own path',
  [SETTINGS_PATH]: 'the repository\'s own settings file, which no manifest lists and the shared settings readers name',
  'package.json': 'the npm scripts every adopter defines and the shared hooks and tests run',
  'src/': 'the product source root every adopter keeps',
  'scripts/lib/board-config.mjs': 'the product board configuration the shared board scripts load',
  'scripts/doc-lint.mjs': 'the doc lint command every adopter runs',
  'scripts/lib/doc-lint.mjs': 'the doc lint core the shared citation and link scans run beside',
  'scripts/lib/doc-lint.test.mjs': 'the doc lint core\'s own test, which every adopter carries with the doc lint',
  '.codex/rules/playwright.rules':
    'the Codex rule that prompts before a browser run, which a repository with a web interface that runs Codex supplies',
  'scripts/gates/': 'optional product hook point, checked for presence',
  'scripts/gates/stop': 'optional product hook point, checked for presence',
  'scripts/gates/pre-commit': 'optional product hook point, checked for presence',
  'scripts/gates/pre-push-main': 'optional product hook point, checked for presence',
  'docs/PRODUCT-DIRECTION.md': 'the owner\'s direction page, which a repository that turns product manager mode on keeps',
  '.agents/cards/': 'the markdown cards folder, which a repository whose board uses markdown cards keeps',
};
const PATH_TOKEN = /[A-Za-z0-9_.@/*<>{}|$-]+/g;
const PLACEHOLDER = /[*<>{}|$]/;
const FILE_EXTENSION = /\.(?:md|mjs|js|ts|json|jsonc|ya?ml|toml|sh|html|css|txt|csv)$/;
// A `join(` or `resolve(` call's run of string literals after its leading identifier arguments: one path in pieces.
const JOINED_LITERALS =
  /\b(?:join|resolve)\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)*((?:'[^'\n]*'|"[^"\n]*")(?:\s*,\s*(?:'[^'\n]*'|"[^"\n]*"))*)/g;
const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"/g;
const RELATIVE_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;

// Each path with every ancestor directory, a directory written with a trailing slash.
const withAncestors = (paths) =>
  new Set(paths.flatMap((path) => {
    const parts = path.split('/');
    return [path, ...parts.slice(1).map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)];
  }));

// A shared file reaches every adopter byte for byte, except the seat setting values an adopter's seat settings file
// names, so a path it names must exist there too. A token that is no path of this repository is a fixture or a
// placeholder; one that is, and is neither shared nor a declared adopter path, exists only here.
test('no shared file names a path only this repository has', () => {
  const listed = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const tracked = withAncestors(listed.stdout.split('\n').filter(Boolean));
  const { entries } = readManifest(ROOT);
  const allowed = withAncestors([
    ...entries.map(({ path }) => path),
    ...FIXED_PRODUCT_DOCUMENTS,
    'AGENTS.md',
    ...Object.keys(ADOPTER_PATHS),
  ]);

  const hits = [];
  for (const entry of scannedEntries(SETTINGS, entries)) {
    const { path } = entry;
    let text = readFileSync(resolve(ROOT, path), 'utf8');
    if ('region' in entry) text = regionText(text, path);
    const joined = [...text.matchAll(JOINED_LITERALS)].map(([, run]) =>
      [...run.matchAll(STRING_LITERAL)].map(([, single, double]) => single ?? double).join('/'));
    const named = new Set();
    for (const raw of [...(text.match(PATH_TOKEN) ?? []), ...joined]) {
      if (PLACEHOLDER.test(raw)) continue;
      // Trailing dots are sentence punctuation, except in a token that ends at a parent-directory segment.
      const token = /(?:^|\/)\.\.$/.test(raw) ? raw : raw.replace(/\.+$/, '');
      if (!token.includes('/') && !FILE_EXTENSION.test(token)) continue;
      // A relative token is read both from the repository root and from the shared file's own directory; one that
      // escapes the root, or names the root itself, names nothing here.
      const fromFile = RELATIVE_SEGMENT.test(token) ? posix.normalize(posix.join(posix.dirname(path), token)) : null;
      for (const candidate of [posix.normalize(token), fromFile]) {
        if (candidate === null || candidate === '.' || candidate === '..' || candidate.startsWith('../')) continue;
        const found = tracked.has(candidate) ? candidate : tracked.has(`${candidate}/`) ? `${candidate}/` : null;
        if (found && !allowed.has(found)) named.add(found);
      }
    }
    for (const token of named) hits.push(`${path}: ${token}`);
  }
  assert.deepEqual(
    hits,
    [],
    'shared files name paths only this repository has; move each such check into a product-owned test the manifest does not list, or name the path neutrally (a placeholder, a glob, or a path no adopter has)',
  );
});

test('ANTI-REGRESSION: the path scan reads no file of the Greptile add-on in a tree that does not turn it on, and still reads every other entry', () => {
  const settings = readSettingsHeader('{"version":1,"seats":{},"greptile":false}', SETTINGS_PATH);
  assert.deepEqual(
    scannedEntries(settings, [{ path: '.greptile/config.json' }, { path: 'docs/README.md' }]).map(({ path }) => path),
    ['docs/README.md'],
  );
});


// Native observer of the actual guard adapter, with a positive approval control before the setting is revoked.
// Recurring cost: one tiny repository per present runtime and four hook starts, stand-in gh only.
test('ANTI-REGRESSION: both native guards enforce fetched-main pre-approved settings', { skip: withoutStandInGh }, async (t) => {
  for (const runtime of PRESENT) await t.test(runtime, (t) => {
    const { dir, git, hook } = guardFixture(t, runtime, 'job/7');
    const settings = join(dir, 'repo/.agents/factory-settings.json');
    mkdirSync(dirname(settings));
    writeFileSync(settings, '{"version":1,"preApprovedRun":true}');
    git('add', '.agents/factory-settings.json');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'enabled settings');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('remote', 'add', 'origin', 'https://github.com/o/fixture.git');
    const gh = standInGh(dir);
    const marks = { PATH: `${gh.bin}${delimiter}${process.env.PATH}`, PRE_APPROVED_RUN_SESSION: RUN_START };
    // Working settings oppose the pinned fetched-main object in both directions.
    writeFileSync(settings, '{"version":1,"preApprovedRun":false}');
    const allowed = hook('git push -u origin job/7', marks);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stderr, '');
    assert.ok(gh.calls().some(([api, graphql]) => api === 'api' && graphql === 'graphql'));
    git('add', '.agents/factory-settings.json');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'revoked fetched settings');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(settings, '{"version":1,"preApprovedRun":true}');
    const before = gh.calls().filter(([api, graphql]) => api === 'api' && graphql === 'graphql').length;
    const refused = hook('git push -u origin job/7', marks);
    t.diagnostic(`revoked fetched setting: exit=${refused.status}; stderr=${JSON.stringify(refused.stderr)}`);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, '');
    assert.ok(refused.stderr.includes('a pre-approved run session publishes nothing: pre-approved run disabled on fetched main; preApprovedRun must be true in .agents/factory-settings.json on main'), refused.stderr);
    assert.equal(gh.calls().filter(([api, graphql]) => api === 'api' && graphql === 'graphql').length, before,
      'setting refusal precedes any new approval read');
    const unmarked = hook('git push -u origin job/7', { PATH: marks.PATH });
    assert.equal(unmarked.status, 0, unmarked.stderr);
    assert.equal(unmarked.stderr, '');
    const pm = hook('git push -u origin job/7', { PATH: marks.PATH, PRODUCT_MANAGER_RUN_SESSION: '1' });
    assert.equal(pm.status, 2, pm.stderr);
    assert.ok(pm.stderr.includes('a product manager run session does not publish'));
  });
});
