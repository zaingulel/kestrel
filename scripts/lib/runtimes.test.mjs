// runtimes.test.mjs — which runtime each shared path belongs to, and how the settings file names the runtimes present.
// The path table, the pinned five and the pinned six are written out by hand; the live-manifest tests read the manifest from disk.
// Run: node --test scripts/lib/runtimes.test.mjs   (or `npm run test:scripts`)
// Price tag: sixteen temporary folders, and two reads of the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installs, isGreptilePath, leftOutCause, needNotResolveCause, presentRuntimes, readRuntimes, readSettingsHeader, RUNTIMES, runtimeOf, SEATS, SETTINGS_PATH, sweepOmits, sweepOn, treeSettings } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RECOVERY = 'if a newer copy of the shared workflow admits this, undo the edit, apply the release update that installs that copy, then make the edit again';

const header = (extra) => readSettingsHeader(JSON.stringify({ version: 1, ...extra }), 'settings.json');
// Both runtimes, the add-on on and the sweep off: a tree with these settings leaves out the sweep's files and no other.
const SWEEP_ALONE_OFF = header({ greptile: true, docSweep: false });

// A scratch tree holding the settings file `text`, or none where it is undefined.
function tree(t, text) {
  const root = mkdtempSync(join(tmpdir(), 'runtimes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (text !== undefined) {
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, SETTINGS_PATH), text);
  }
  return root;
}

test('the runtimes and their seat folders are fixed', () => {
  assert.deepEqual(RUNTIMES, ['claude', 'codex']);
  assert.deepEqual(SEATS, {
    claude: { directory: '.claude/agents', extension: '.md' },
    codex: { directory: '.codex/agents', extension: '.toml' },
  });
  assert.ok([RUNTIMES, SEATS, SEATS.claude, SEATS.codex].every(Object.isFrozen), 'a constant that can be edited is not one');
  assert.equal(SETTINGS_PATH, '.agents/factory-settings.json');
});

test('a path belongs to the runtime whose folder or file it is, and to every install otherwise', () => {
  const table = [
    ['.claude/agents/builder.md', 'claude'],
    ['.claude/hooks/block-unsafe-git.mjs', 'claude'],
    ['.claude/settings.json', 'claude'],
    ['.claude/skills/resume/SKILL.md', 'claude'],
    ['CLAUDE.md', 'claude'],
    ['scripts/lib/test-output-filter.mjs', 'claude'],
    ['scripts/lib/test-output-filter.test.mjs', 'claude'],
    ['.codex/agents/builder.toml', 'codex'],
    ['.codex/hooks.json', 'codex'],
    ['.codex/hooks/verify-green.mjs', 'codex'],
    ['scripts/lib/codex-hook-adapters.mjs', 'codex'],
    ['scripts/lib/codex-hook-adapters.test.mjs', 'codex'],
    ['scripts/lib/codex-hooks-windows.test.mjs', 'codex'],
    ['AGENTS.md', null],
    ['.agents/skills/resume/SKILL.md', null],
    ['.agents/templates/builder-handoff.md', null],
    ['.agents/upstream/example/LICENSE', null],
    ['.githooks/pre-commit', null],
    ['.github/workflows/sweep-scope.yml', null],
    ['.greptile/config.json', null],
    ['docs/README.md', null],
    ['scripts/factory-sync.mjs', null],
    ['scripts/lib/handoff-check.mjs', null],
    ['scripts/lib/factory-sync.mjs', null],
    // The comparison is exact: a look-alike is not the runtime's.
    ['.claude', null],
    ['.claudex/agents/builder.md', null],
    ['docs/CLAUDE.md', null],
    ['CLAUDE.md.bak', null],
    ['.codexx/hooks.json', null],
    ['scripts/lib/test-output-filter.mjs.bak', null],
    ['scripts/lib/codex-hook-adapters.mjs2', null],
  ];
  for (const [path, runtime] of table) assert.equal(runtimeOf(path), runtime, path);
});

test('a path installs when it belongs to no runtime or to a runtime that is present', () => {
  const claudePath = '.claude/settings.json';
  const codexPath = '.codex/hooks.json';
  assert.equal(installs(['claude'], claudePath), true);
  assert.equal(installs(['claude'], codexPath), false);
  assert.equal(installs(['codex'], codexPath), true);
  assert.equal(installs(['codex'], claudePath), false);
  assert.equal(installs(['claude', 'codex'], claudePath), true);
  assert.equal(installs(['claude', 'codex'], codexPath), true);
  for (const present of [['claude'], ['codex'], ['claude', 'codex']]) assert.equal(installs(present, 'AGENTS.md'), true);
});

test('runtimes: no key means both, a list is kept in runtime order, and anything else is refused by name', () => {
  assert.deepEqual(readRuntimes(undefined, 'settings.json'), ['claude', 'codex']);
  assert.deepEqual(readRuntimes(['codex', 'claude'], 'settings.json'), ['claude', 'codex']);
  assert.deepEqual(readRuntimes(['codex'], 'settings.json'), ['codex']);
  const refusal = (found) => `settings.json: runtimes: must be a non-empty array naming claude, codex or both, each once; found ${found}`;
  for (const [value, found] of [['claude', '"claude"'], [[], '[]'], [['gemini'], '["gemini"]'], [['claude', 'claude'], '["claude","claude"]'], [null, 'null'], [{}, '{}']]) {
    assert.throws(() => readRuntimes(value, 'settings.json'), { message: refusal(found) });
  }
});

test('the settings file names the runtimes present: no file means both, and an unreadable one is refused by name', (t) => {
  assert.deepEqual(presentRuntimes(tree(t, undefined)), ['claude', 'codex']);
  assert.deepEqual(presentRuntimes(tree(t, '{"version":1,"runtimes":["codex"],"seats":{}}')), ['codex']);
  const refused = [
    ['{', 'is not valid JSON'],
    ['null', 'file: must hold one JSON object; found null'],
    ['[]', 'file: must hold one JSON object; found []'],
    ['{"runtimes":["claude"]}', `version: is unsupported by this copy of the shared workflow (only 1); found undefined; ${RECOVERY}`],
    ['{"version":2,"runtimes":["claude"],"seats":{}}', `version: is unsupported by this copy of the shared workflow (only 1); found 2; ${RECOVERY}`],
    ['{"version":1,"runtimes":["claude"],"seats":{},"extra":1}', `file: holds a key besides version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview; found "extra"; ${RECOVERY}`],
  ];
  for (const [text, message] of refused) {
    assert.throws(() => presentRuntimes(tree(t, text)), { message: `.agents/factory-settings.json: ${message}` }, text);
  }
});

test('planApproval: true or false is admitted, no key is valid, and any other value or top-level key is still refused by name', () => {
  for (const extra of [{}, { planApproval: true }, { planApproval: false }]) {
    assert.deepEqual(header(extra).runtimes, ['claude', 'codex'], JSON.stringify(extra));
  }
  assert.deepEqual(header({ planApproval: true, runtimes: ['codex'] }).runtimes, ['codex']);
  for (const [value, found] of [['true', '"true"'], [1, '1'], [0, '0'], [null, 'null'], [[], '[]'], [{}, '{}']]) {
    assert.throws(() => header({ planApproval: value }), { message: `settings.json: planApproval: must be true or false; found ${found}` });
  }
  for (const key of ['PlanApproval', 'plan_approval', 'planApprovals']) {
    assert.throws(() => header({ [key]: true }), { message: `settings.json: file: holds a key besides version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview; found "${key}"; ${RECOVERY}` });
  }
});

test('greptile: true or false is admitted, no key is valid, and any other value or top-level key is still refused by name', () => {
  for (const extra of [{}, { greptile: true }, { greptile: false }]) {
    assert.deepEqual(header(extra).runtimes, ['claude', 'codex'], JSON.stringify(extra));
  }
  assert.deepEqual(header({ greptile: true, runtimes: ['codex'] }).runtimes, ['codex']);
  for (const [value, found] of [['true', '"true"'], [1, '1'], [0, '0'], [null, 'null'], [[], '[]'], [{}, '{}']]) {
    assert.throws(() => header({ greptile: value }), { message: `settings.json: greptile: must be true or false; found ${found}` });
  }
  for (const key of ['Greptile', 'greptile_review', 'greptiles']) {
    assert.throws(() => header({ [key]: true }), { message: `settings.json: file: holds a key besides version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview; found "${key}"; ${RECOVERY}` });
  }
});

test('docSweep: true or false is admitted, no key means on, and any other value or top-level key is still refused by name', () => {
  assert.equal(header({}).docSweep, true);
  assert.equal(header({ docSweep: true }).docSweep, true);
  assert.equal(header({ docSweep: false }).docSweep, false);
  assert.deepEqual(header({ docSweep: false, runtimes: ['codex'] }).runtimes, ['codex']);
  for (const [value, found] of [['false', '"false"'], [1, '1'], [0, '0'], [null, 'null'], [[], '[]'], [{}, '{}']]) {
    assert.throws(() => header({ docSweep: value }), { message: `settings.json: docSweep: must be true or false; found ${found}` });
  }
  for (const key of ['DocSweep', 'doc_sweep', 'docsweep', 'sweep']) {
    assert.throws(() => header({ [key]: true }), { message: `settings.json: file: holds a key besides version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview; found "${key}"; ${RECOVERY}` });
  }
});

test('ANTI-REGRESSION: crossFamilyReview is admitted only as true where both runtimes run, and any other value, a file naming one runtime and a near spelling are still refused by name', () => {
  const keyList = 'version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview';
  assert.equal(header({}).crossFamilyReview, false);
  assert.equal(header({ crossFamilyReview: true }).crossFamilyReview, true);
  assert.equal(header({ crossFamilyReview: true, runtimes: ['claude', 'codex'] }).crossFamilyReview, true);
  for (const [value, found] of [[false, 'false'], ['true', '"true"'], [1, '1'], [null, 'null'], [[], '[]'], [{}, '{}']]) {
    assert.throws(() => header({ crossFamilyReview: value }), { message: `settings.json: crossFamilyReview: must be true, or left out to record no authorization; found ${found}` });
  }
  for (const runtimes of [['codex'], ['claude']]) {
    assert.throws(() => header({ crossFamilyReview: true, runtimes }), { message: 'settings.json: crossFamilyReview: is refused where runtimes names one runtime; found true' });
  }
  for (const key of ['CrossFamilyReview', 'cross_family_review', 'crossFamilyReviews']) {
    assert.throws(() => header({ [key]: true }), { message: `settings.json: file: holds a key besides ${keyList}; found "${key}"; ${RECOVERY}` });
  }
});

test('a path belongs to the Greptile add-on only under its skill folders and its configuration folder, and the add-on is on only where the settings file holds true', (t) => {
  const table = [
    ['.agents/skills/greptile/SKILL.md', true],
    ['.agents/skills/greptile/references/billing.md', true],
    ['.claude/skills/greptile/SKILL.md', true],
    ['.greptile/config.json', true],
    ['.greptile/rules.md', true],
    // The comparison is exact: a look-alike is not the add-on's.
    ['.greptile', false],
    ['.greptilex/config.json', false],
    ['.Greptile/config.json', false],
    ['docs/.greptile/config.json', false],
    ['.agents/skills/greptile', false],
    ['.agents/skills/greptile-extra/SKILL.md', false],
    ['.agents/skills/Greptile/SKILL.md', false],
    ['.codex/skills/greptile/SKILL.md', false],
    ['.agents/skills/resume/SKILL.md', false],
    ['.claude/skills/resume/SKILL.md', false],
    ['AGENTS.md', false],
  ];
  for (const [path, addOn] of table) assert.equal(isGreptilePath(path), addOn, path);

  assert.equal(header({ greptile: true }).greptile, true);
  assert.equal(header({ greptile: false }).greptile, false);
  assert.equal(header({}).greptile, false);

  assert.equal(treeSettings(tree(t, undefined)).greptile, false, 'no settings file');
  assert.equal(treeSettings(tree(t, '{"version":1,"seats":{}}')).greptile, false, 'no key');
  assert.equal(treeSettings(tree(t, '{"version":1,"seats":{},"greptile":false}')).greptile, false);
  assert.equal(treeSettings(tree(t, '{"version":1,"seats":{},"greptile":true}')).greptile, true);
});

test('a path belongs to the documentation sweep only where it is one of the six pinned, the sweep is on unless the settings file holds false, and a tree leaves out the sweep files and manuals only where it is off', (t) => {
  const sweepFiles = [
    '.github/workflows/sweep-scope.yml',
    'scripts/lib/sweep-scope-corpus.mjs',
    'scripts/lib/sweep-scope-evaluate.mjs',
    'scripts/lib/sweep-scope.mjs',
    'scripts/lib/sweep-scope.test.mjs',
    'scripts/sweep-scope-check.mjs',
  ];
  const manuals = ['docs/DOC-SWEEP.md', 'docs/SWEEP-TRIAGE.md'];
  // The comparison is exact: a look-alike is not the sweep's, and no near miss is a path this repository tracks.
  const nearMisses = [
    'scripts/lib/sweep-scope-extra.mjs',
    'scripts/sweep-scope.mjs',
    '.github/workflows/sweep-scope.yaml',
    'scripts/lib/sweep-scope.mjs.bak',
  ];
  for (const path of sweepFiles) assert.equal(leftOutCause(SWEEP_ALONE_OFF, path) !== null, true, path);
  for (const path of [...nearMisses, ...manuals, 'AGENTS.md']) assert.equal(leftOutCause(SWEEP_ALONE_OFF, path) !== null, false, path);
  assert.equal(sweepOn(tree(t, undefined)), true, 'no settings file');
  assert.equal(sweepOn(tree(t, '{"version":1,"seats":{}}')), true, 'no key');
  assert.equal(sweepOn(tree(t, '{"version":1,"seats":{},"docSweep":true}')), true);
  assert.equal(sweepOn(tree(t, '{"version":1,"seats":{},"docSweep":false}')), false);

  for (const path of [...sweepFiles, ...manuals]) {
    assert.equal(sweepOmits(true, path), false, `on: ${path}`);
    assert.equal(sweepOmits(false, path), true, `off: ${path}`);
  }
  for (const path of [...nearMisses, 'AGENTS.md']) {
    assert.equal(sweepOmits(true, path), false, `on: ${path}`);
    assert.equal(sweepOmits(false, path), false, `off: ${path}`);
  }
});

test('ANTI-REGRESSION: a path a tree must hold nothing at and a path a reference need not resolve to are two answers, and neither stands in for the other', () => {
  const noCodex = 'the settings file names no codex runtime';
  const noClaude = 'the settings file names no claude runtime';
  const addOnOff = 'the settings file does not turn the Greptile add-on on';
  const sweepOff = 'the settings file turns the documentation sweep off';
  const everythingOn = { greptile: true, docSweep: true };
  // [settings, path, why the tree must hold nothing there, why a reference to it need not resolve]
  const table = [
    [{ greptile: false }, '.greptile/config.json', addOnOff, null],
    [{}, '.agents/skills/greptile/SKILL.md', addOnOff, null],
    [{ docSweep: false }, 'docs/DOC-SWEEP.md', null, sweepOff],
    [{ docSweep: false }, 'docs/SWEEP-TRIAGE.md', null, sweepOff],
    [{ docSweep: false }, 'scripts/sweep-scope-check.mjs', sweepOff, sweepOff],
    [{ runtimes: ['claude'] }, '.codex/hooks.json', noCodex, noCodex],
    [{ runtimes: ['codex'] }, 'CLAUDE.md', noClaude, noClaude],
    [{}, 'AGENTS.md', null, null],
    [{ runtimes: ['codex'], docSweep: false }, 'docs/README.md', null, null],
    [everythingOn, '.greptile/config.json', null, null],
    [everythingOn, 'docs/DOC-SWEEP.md', null, null],
    [everythingOn, 'scripts/sweep-scope-check.mjs', null, null],
    [everythingOn, '.codex/hooks.json', null, null],
    [everythingOn, 'CLAUDE.md', null, null],
    // The runtime comes first: an add-on file of a runtime that is not named is left out for the runtime.
    [{ runtimes: ['codex'] }, '.claude/skills/greptile/SKILL.md', noClaude, noClaude],
  ];
  for (const [extra, path, leftOut, needNotResolve] of table) {
    const settings = header(extra);
    const row = `${JSON.stringify(extra)} ${path}`;
    assert.equal(leftOutCause(settings, path), leftOut, `must hold nothing: ${row}`);
    assert.equal(needNotResolveCause(settings, path), needNotResolve, `need not resolve: ${row}`);
  }
});

// The manifest is read from disk and the five scripts are written out here, so neither is judged through runtimeOf.
test("every shared path under a runtime's folder belongs to that runtime, and the scripts tied to a runtime are exactly the pinned five", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.agents/factory-manifest.json'), 'utf8'));
  const entries = manifest.entries;
  const pinned = [
    'scripts/lib/codex-hook-adapters.mjs',
    'scripts/lib/codex-hook-adapters.test.mjs',
    'scripts/lib/codex-hooks-windows.test.mjs',
    'scripts/lib/test-output-filter.mjs',
    'scripts/lib/test-output-filter.test.mjs',
  ];

  for (const { path } of entries) {
    if (path.startsWith('.claude/') || path === 'CLAUDE.md') assert.equal(runtimeOf(path), 'claude', path);
    if (path.startsWith('.codex/')) assert.equal(runtimeOf(path), 'codex', path);
  }
  const scriptsTied = entries.map((entry) => entry.path).filter((path) => path.startsWith('scripts/') && runtimeOf(path) !== null);
  assert.deepEqual(scriptsTied.sort(), pinned);
  assert.deepEqual(
    entries.filter((entry) => 'region' in entry).map((entry) => [entry.path, runtimeOf(entry.path)]),
    [['AGENTS.md', null]],
    'a region entry holds text for every install',
  );
});

// The manifest is read from disk and the six paths are written out here, so neither comes from the module under test.
test('the shared paths of the documentation sweep are exactly the pinned six', () => {
  const entries = JSON.parse(readFileSync(join(ROOT, '.agents/factory-manifest.json'), 'utf8')).entries;
  const pinned = [
    '.github/workflows/sweep-scope.yml',
    'scripts/lib/sweep-scope-corpus.mjs',
    'scripts/lib/sweep-scope-evaluate.mjs',
    'scripts/lib/sweep-scope.mjs',
    'scripts/lib/sweep-scope.test.mjs',
    'scripts/sweep-scope-check.mjs',
  ];
  assert.deepEqual(entries.map((entry) => entry.path).filter((path) => path.includes('sweep-scope')).sort(), pinned);
  for (const { path } of entries) assert.equal(leftOutCause(SWEEP_ALONE_OFF, path) !== null, pinned.includes(path), path);
  for (const path of pinned) {
    assert.equal(runtimeOf(path), null, path);
    assert.equal(isGreptilePath(path), false, path);
  }
});
