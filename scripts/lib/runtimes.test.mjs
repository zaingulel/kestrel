// runtimes.test.mjs — which runtime each shared path belongs to, and how the settings file names the runtimes present.
// The path table and the pinned five are written out by hand; the live-manifest test reads the manifest from disk.
// Run: node --test scripts/lib/runtimes.test.mjs   (or `npm run test:scripts`)
// Price tag: eight temporary folders, and one read of the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installs, presentRuntimes, readRuntimes, readSettingsHeader, RUNTIMES, runtimeOf, SEATS, SETTINGS_PATH } from './runtimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RECOVERY = 'if a newer copy of the shared workflow admits this, undo the edit, run the sync that installs that copy, then make the edit again';

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
  const tree = (text) => {
    const root = mkdtempSync(join(tmpdir(), 'runtimes-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (text !== undefined) {
      mkdirSync(join(root, '.agents'));
      writeFileSync(join(root, SETTINGS_PATH), text);
    }
    return root;
  };
  assert.deepEqual(presentRuntimes(tree(undefined)), ['claude', 'codex']);
  assert.deepEqual(presentRuntimes(tree('{"version":1,"runtimes":["codex"],"seats":{}}')), ['codex']);
  const refused = [
    ['{', 'is not valid JSON'],
    ['null', 'file: must hold one JSON object; found null'],
    ['[]', 'file: must hold one JSON object; found []'],
    ['{"runtimes":["claude"]}', `version: is unsupported by this copy of the sync (only 1); found undefined; ${RECOVERY}`],
    ['{"version":2,"runtimes":["claude"],"seats":{}}', `version: is unsupported by this copy of the sync (only 1); found 2; ${RECOVERY}`],
    ['{"version":1,"runtimes":["claude"],"seats":{},"extra":1}', `file: holds a key besides version, runtimes, seats and planApproval; found "extra"; ${RECOVERY}`],
  ];
  for (const [text, message] of refused) {
    assert.throws(() => presentRuntimes(tree(text)), { message: `.agents/factory-settings.json: ${message}` }, text);
  }
});

test('planApproval: true or false is admitted, no key is valid, and any other value or top-level key is still refused by name', () => {
  const header = (extra) => readSettingsHeader(JSON.stringify({ version: 1, ...extra }), 'settings.json');
  for (const extra of [{}, { planApproval: true }, { planApproval: false }]) {
    assert.deepEqual(header(extra).runtimes, ['claude', 'codex'], JSON.stringify(extra));
  }
  assert.deepEqual(header({ planApproval: true, runtimes: ['codex'] }).runtimes, ['codex']);
  for (const [value, found] of [['true', '"true"'], [1, '1'], [0, '0'], [null, 'null'], [[], '[]'], [{}, '{}']]) {
    assert.throws(() => header({ planApproval: value }), { message: `settings.json: planApproval: must be true or false; found ${found}` });
  }
  for (const key of ['PlanApproval', 'plan_approval', 'planApprovals']) {
    assert.throws(() => header({ [key]: true }), { message: `settings.json: file: holds a key besides version, runtimes, seats and planApproval; found "${key}"; ${RECOVERY}` });
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
