// ci-gate.test.mjs — the shape of the required `test` check in .github/workflows/tests.yml.
//
// GitHub reports a SKIPPED required job as success, so the gate job must never skip: on a draft
// it runs under the control name `ci-control-no-test` (no check named `test` is emitted), and on
// a ready pull request `always()` keeps a cancelled or failed lane from turning into a skip. This
// is a deterministic guard over the committed bytes (docs/TESTING-STRATEGY.md section 2): each
// assertion goes red if the corresponding line is removed or a draft condition is re-added to the
// gate job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/tests.yml'), 'utf8');

// The text of one top-level job block: from `  <name>:` to the next two-space-indented key.
function job(name) {
  const m = WORKFLOW.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|(?![\\s\\S]))`, 'm'));
  assert.ok(m, `job ${name} must exist`);
  return m[1];
}

test('the workflow runs on pull requests only, without label-driven admission events', () => {
  assert.match(WORKFLOW, /^on:\n  pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]\n/m);
  assert.doesNotMatch(WORKFLOW, /labeled/);
});

test('every suite lane is gated on the pull request not being a draft', () => {
  for (const name of ['reach', 'quality']) {
    assert.match(job(name), /^    if: github\.event\.pull_request\.draft == false$/m, `${name} must skip on drafts`);
  }
  for (const name of ['hooks_windows']) {
    assert.match(job(name), /^    needs: reach$/m, `${name} must depend on reach`);
  }
});

test('the gate job never skips and hides the required check name on drafts', () => {
  const gate = job('test');
  assert.match(gate, /^    name: \$\{\{ github\.event\.pull_request\.draft == false && 'test' \|\| 'ci-control-no-test' \}\}$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^    needs: \[reach, quality, hooks_windows\]$/m);
  // The confirmation step itself runs only on a ready pull request; a draft only echoes.
  assert.match(gate, /- name: Confirm every CI lane passed\n        if: github\.event\.pull_request\.draft == false/);
  assert.match(gate, /- name: Record a draft event without exposing the required check\n        if: github\.event\.pull_request\.draft == true/);
});

test('the workflow stays least-privilege: read-only token, no job override, no persisted credentials', () => {
  assert.match(WORKFLOW, /^permissions:\n  contents: read$/m);
  const jobPermissions = WORKFLOW.match(/^    permissions:/gm) ?? [];
  assert.deepEqual(jobPermissions, [], 'no job may widen the workflow-level token');
  assert.doesNotMatch(WORKFLOW, /secrets\./);
  const checkouts = (WORKFLOW.match(/uses: actions\/checkout@/g) ?? []).length;
  const unpersisted = (WORKFLOW.match(/persist-credentials: false/g) ?? []).length;
  assert.equal(checkouts, 3, `expected the three lane checkouts, saw ${checkouts}`);
  assert.equal(unpersisted, checkouts, 'every checkout must drop the token from the tree');
});

test('the unconditional quality lane runs the factory and speech quality checks', () => {
  const quality = job('quality');
  assert.match(quality, /^      - run: npm run lint$/m);
  assert.match(quality, /^      - run: npm run test:scripts$/m);
  assert.match(quality, /^      - run: npm run lint:docs$/m);
  assert.match(quality, /^      - run: \.runtime\/voice-venv\/bin\/python -m ruff check --select F bot\.py speech\.py asr_worker\.py hermes_worker\.py app_resolver\.py tests$/m);
  assert.match(quality, /^      - run: npm run test:speech\n        env:\n          HF_HUB_OFFLINE: '1'\n          TRANSFORMERS_OFFLINE: '1'$/m);
});

test('the reach classifier reads unquoted paths, so a non-ASCII file name cannot dodge a lane', () => {
  assert.match(job('reach'), /git -c core\.quotePath=false diff --name-only/);
});

test('the Windows hook job runs on Windows and the gate requires it on a ready pull request', () => {
  const hooks = job('hooks_windows');
  assert.match(hooks, /^    runs-on: windows-latest$/m);
  const gate = job('test');
  assert.match(gate, /^          HOOKS_WINDOWS: \$\{\{ needs\.hooks_windows\.result \}\}$/m);
  assert.match(hooks, /^    needs: reach\n    if: needs\.reach\.outputs\.hooks == 'true'$/m);
  assert.match(gate, /^          HOOKS_REACH: \$\{\{ needs\.reach\.outputs\.hooks \}\}$/m);
});

// The confirmation step is the required check's verdict, so it is executed with each lane state
// rather than pattern-matched: a source pattern stays green when a refusal is neutralised.
function confirmLanes(REACH, QUALITY, HOOKS_REACH, HOOKS_WINDOWS) {
  const run = job('test').match(/- name: Confirm every CI lane passed\n[\s\S]*?run: \|\n((?: {10}.*\n?)+)/);
  assert.ok(run, 'the confirmation step must have a run block');
  const script = run[1].replace(/^ {10}/gm, '');
  return spawnSync('bash', ['-c', script], {
    env: { ...process.env, REACH, QUALITY, HOOKS_REACH, HOOKS_WINDOWS },
    encoding: 'utf8',
  }).status;
}

test('the gate requires the conditional lanes to match what reach decided', () => {
  for (const lanes of [
    ['success', 'success', 'true', 'success'],
    ['success', 'success', 'false', 'skipped'],
  ]) {
    assert.equal(confirmLanes(...lanes), 0, `the gate must admit ${lanes.join(', ')}`);
  }
  for (const lanes of [
    ['success', 'success', 'true', 'failure'],
    ['success', 'success', 'true', 'skipped'],
    ['success', 'success', 'false', 'success'],
    ['failure', 'success', 'false', 'skipped'],
    ['success', 'failure', 'false', 'skipped'],
    ['success', 'success', 'true', 'cancelled'],
  ]) {
    assert.notEqual(confirmLanes(...lanes), 0, `the gate must refuse ${lanes.join(', ')}`);
  }
});

// The classify step decides whether the metered lane runs at all, so it is executed here rather
// than pattern-matched. `printf ... | grep -q` under `set -o pipefail` lets grep exit on its first
// match while printf is still writing; a changed-file list past the pipe buffer then fails the
// pipeline and the lane is skipped on a green exit. The large list below reproduces that.
function classify(changedPaths) {
  const reach = job('reach');
  const run = reach.match(/id: classify\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n\S|\n {0,6}- name:|$)/);
  assert.ok(run, 'the classify step must have a run block');
  const script = run[1]
    .replace(/^ {10}/gm, '')
    .replace(/^changed=\$\(git .*\)$/m, 'changed=$(cat "$CHANGED_LIST")');
  assert.notEqual(script.indexOf('CHANGED_LIST'), -1, 'the git diff line must be substituted');
  const dir = mkdtempSync(join(tmpdir(), 'ci-gate-'));
  const list = join(dir, 'changed');
  const output = join(dir, 'output');
  writeFileSync(list, changedPaths.join('\n'));
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, CHANGED_LIST: list, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `classify must exit 0: ${result.stderr}`);
  return readFileSync(output, 'utf8');
}

test('the reach classifier still selects the Windows hook lane when the change set is larger than a pipe buffer', () => {
  const docs = Array.from({ length: 4000 }, (_, i) => `docs/sweep/section-${i}-with-a-long-enough-name.md`);
  assert.match(classify(['.githooks/pre-push', ...docs]), /^hooks=true$/m);
});

test('the reach classifier reaches the Windows hook lane through every hook-surface pattern', () => {
  for (const path of [
    '.codex/hooks/verify-green.mjs',
    '.codex/hooks.json',
    '.claude/hooks/block-unsafe-git.mjs',
    '.claude/settings.json',
    '.claude/templates/builder-handoff.md',
    '.agents/templates/planner-handoff.md',
    '.githooks/pre-push',
    'scripts/lib/posix-shell.mjs',
    'scripts/gates/stop',
    'scripts/run-log.mjs',
    '.gitattributes',
    '.github/workflows/tests.yml',
  ]) {
    assert.match(classify([path]), /^hooks=true$/m, `${path} must reach the Windows hook lane`);
  }
});

test('the reach classifier skips the Windows hook lane for a change outside the hook surface', () => {
  assert.match(classify(['docs/README.md', '.agents/skills/resume/SKILL.md']), /^hooks=false$/m);
});

function windowsTestFiles() {
  const step = job('hooks_windows').match(/- name: Run the hook tests\n\s+run: >-\n\s+node --test\n((?: {10}\S+\n?)+)/);
  assert.ok(step, 'the Windows step must run a folded node --test list');
  const files = step[1].split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(files.length > 0, 'the Windows step must list at least one test file');
  return files;
}

test('every test file the Windows hook step runs is itself inside the hooks pattern', () => {
  for (const file of windowsTestFiles()) {
    assert.match(classify([file]), /^hooks=true$/m, `${file} must reach the Windows hook lane`);
  }
});

test('the Windows hook step runs the run-log test, whose npm and npx start exists only on Windows', () => {
  assert.ok(windowsTestFiles().includes('scripts/lib/run-log.test.mjs'), 'the Windows step must run scripts/lib/run-log.test.mjs');
});
