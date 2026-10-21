// factory-sync.test.mjs — tests for the factory manifest reader, its drift verification, the render of an adopter's
// seat settings and the CLI.
// Run: node --test scripts/lib/factory-sync.test.mjs   (or `npm run test:scripts`)
//
// Price tag: every tree is a real temporary directory, and the CLI tests spawn git and node a handful of times. No
// network. Retire this file with scripts/lib/factory-sync.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fileSystem, {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifestPath, computeEntries, readManifest, recordIndexModes, renderSettings, verifyManifest } from './factory-sync.mjs';
import { presentRuntimes } from './runtimes.mjs';

// Whether this machine lets an unprivileged process create a file symlink. Only Windows without Developer Mode or
// administrator rights refuses, with EPERM; any other failure, and any failure elsewhere, is thrown.
function fileSymlinksAvailable() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-sync-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync('target', join(dir, 'link'), 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE_SYMLINKS = fileSymlinksAvailable();
const NEEDS_FILE_SYMLINK = { skip: !FILE_SYMLINKS && 'creating a file symlink on Windows needs Developer Mode or administrator rights' };

// Computed by `printf 'hello\n' | shasum -a 256`, never by the code under test.
const HELLO_SHA256 = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
// Computed by `printf 'x\ny\n' | shasum -a 256`: the region text excludes both marker lines.
const REGION_SHA256 = '09834d488008f5f1ef589a2d7cedc52425bee9dd23b2212e4c1d673c5cbb54e4';
const START = '<!-- factory-shared:start -->';
const END = '<!-- factory-shared:end -->';

// seatDefaults left out writes a manifest with no such record.
function writeManifest(root, entries, seatDefaults) {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'factory-manifest.json'),
    JSON.stringify({ canonical: 'example-owner/example-repo', adopters: ['example-owner/adopter'], seatDefaults, entries }),
  );
}

// A tree holding one file, with a manifest that records it correctly.
function matchingTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.txt'), 'hello\n');
  writeManifest(root, [{ path: 'docs/a.txt', sha256: HELLO_SHA256 }]);
  return root;
}

for (const path of ['../x', 'a/../b', '/abs', '', './x', '.git/hooks/pre-commit', 'a/.GIT/x']) {
  test(`the manifest path ${JSON.stringify(path)} is rejected by name`, () => {
    assert.throws(() => checkManifestPath(path), /invalid manifest path/);
  });
}

test('a manifest path holding a backslash is rejected by name, whether or not it climbs', () => {
  for (const path of ['..\\file', 'docs\\a.txt']) {
    assert.throws(() => checkManifestPath(path), /invalid manifest path/, JSON.stringify(path));
  }
});

test('a plain relative manifest path is accepted', () => {
  assert.equal(checkManifestPath('.agents/skills/tdd/SKILL.md'), '.agents/skills/tdd/SKILL.md');
});

test('a tree matching its manifest verifies clean', (t) => {
  assert.deepEqual(verifyManifest(matchingTree(t)), []);
});

test('one changed byte in a file entry is reported', (t) => {
  const root = matchingTree(t);
  writeFileSync(join(root, 'docs', 'a.txt'), 'hellO\n');
  const [mismatch, ...rest] = verifyManifest(root);
  assert.deepEqual(rest, []);
  assert.equal(mismatch.path, 'docs/a.txt');
  assert.equal(mismatch.expected, HELLO_SHA256);
  assert.match(mismatch.actual, /^[0-9a-f]{64}$/);
  assert.notEqual(mismatch.actual, HELLO_SHA256);
});

test('a file replaced by a symlink is reported, even when the link resolves to identical bytes', NEEDS_FILE_SYMLINK, (t) => {
  const root = matchingTree(t);
  writeFileSync(join(root, 'b.txt'), 'hello\n');
  rmSync(join(root, 'docs', 'a.txt'));
  symlinkSync('../b.txt', join(root, 'docs', 'a.txt'));
  const [mismatch, ...rest] = verifyManifest(root);
  assert.deepEqual(rest, []);
  assert.equal(mismatch.path, 'docs/a.txt');
  assert.match(mismatch.actual, /not a regular file/);
});

test('a file entry whose executable bit differs from its record is reported', { skip: process.platform === 'win32' && 'the executable bit does not exist on Windows; the index-backed path is proven by "a checkout that does not honour file modes takes the executable bit from the index, not the disk"' }, (t) => {
  const root = matchingTree(t);
  put(root, 'run.sh', 'hello\n', 0o755);
  writeManifest(root, [
    { path: 'docs/a.txt', sha256: HELLO_SHA256 },
    { path: 'run.sh', sha256: HELLO_SHA256, executable: true },
  ]);
  assert.deepEqual(verifyManifest(root), []);
  chmodSync(join(root, 'run.sh'), 0o644);
  chmodSync(join(root, 'docs', 'a.txt'), 0o755);
  assert.deepEqual(verifyManifest(root), [
    { path: 'docs/a.txt', expected: 'not executable', actual: 'executable' },
    { path: 'run.sh', expected: 'executable', actual: 'not executable' },
  ]);
});

test('recording a file entry marks it executable only when the file is', { skip: process.platform === 'win32' && 'the executable bit does not exist on Windows; the index-backed path is proven by "a checkout that does not honour file modes takes the executable bit from the index, not the disk"' }, (t) => {
  const root = matchingTree(t);
  put(root, 'run.sh', 'hello\n', 0o755);
  const entries = [
    { path: 'docs/a.txt', sha256: ZERO_SHA256, executable: true },
    { path: 'run.sh', sha256: ZERO_SHA256 },
  ];
  assert.deepEqual(computeEntries(root, { entries }), [
    { path: 'docs/a.txt', sha256: HELLO_SHA256 },
    { path: 'run.sh', sha256: HELLO_SHA256, executable: true },
  ]);
});

// The disk modes are the opposite of the index modes, so only a read of the index passes on every platform.
test('a checkout that does not honour file modes takes the executable bit from the index, not the disk', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-sync-modes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  repository(root, CANONICAL_URL);
  put(root, 'docs/a.txt', 'hello\n', 0o755);
  put(root, 'run.sh', 'hello\n', 0o644);
  commitAll(root);
  git(root, 'config', 'core.fileMode', 'false');
  git(root, 'update-index', '--chmod=-x', 'docs/a.txt');
  git(root, 'update-index', '--chmod=+x', 'run.sh');
  commitAll(root);

  const entries = [
    { path: 'docs/a.txt', sha256: HELLO_SHA256 },
    { path: 'run.sh', sha256: HELLO_SHA256, executable: true },
  ];
  assert.deepEqual(verifyManifest(root, { entries }), []);
  assert.deepEqual(
    computeEntries(root, {
      entries: [
        { path: 'docs/a.txt', sha256: ZERO_SHA256, executable: true },
        { path: 'run.sh', sha256: ZERO_SHA256 },
      ],
    }),
    entries,
  );
});

// A non-boolean value makes `git config --type=bool core.fileMode` exit 128, not the 1 an unset key gives.
test('a failed core.fileMode lookup is refused, naming the lookup, never read as a checkout that honours file modes', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-sync-modes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  repository(root, CANONICAL_URL);
  put(root, 'run.sh', 'hello\n');
  commitAll(root);
  git(root, 'config', 'core.fileMode', 'notabool');

  assert.throws(() => verifyManifest(root, { entries: [{ path: 'run.sh', sha256: HELLO_SHA256 }] }), /core\.fileMode/);
});

// The index says executable and the disk does not, so only a read of the disk reports drift;
// the global and system configuration are shut out so the lookup sees only the repository's unset value.
test('an unset core.fileMode reads the executable bit from the disk', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-sync-modes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  repository(root, CANONICAL_URL);
  put(root, 'run.sh', 'hello\n', 0o755);
  commitAll(root);
  git(root, 'update-index', '--chmod=+x', 'run.sh');
  commitAll(root);
  chmodSync(join(root, 'run.sh'), 0o644);
  git(root, 'config', '--unset', 'core.fileMode');
  assert.equal(indexMode(root, 'run.sh'), '100755');
  const emptyGitConfig = join(base, 'empty-gitconfig');
  writeFileSync(emptyGitConfig, '');

  const drift = withEnv({ GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1' }, () =>
    verifyManifest(root, { entries: [{ path: 'run.sh', sha256: HELLO_SHA256, executable: true }] }),
  );
  assert.deepEqual(drift, [{ path: 'run.sh', expected: 'executable', actual: 'not executable' }]);
});

test('a missing path is reported as missing', (t) => {
  const root = matchingTree(t);
  rmSync(join(root, 'docs'), { recursive: true });
  assert.deepEqual(verifyManifest(root), [{ path: 'docs/a.txt', expected: HELLO_SHA256, actual: 'missing' }]);
});

test('a missing, unparsable or malformed manifest fails loudly by name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readManifest(root), /cannot read \.agents\/factory-manifest\.json/);
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, '.agents', 'factory-manifest.json'), '{');
  assert.throws(() => readManifest(root), /factory-manifest\.json is not valid JSON/);
  for (const entry of [
    { path: 'a', sha256: 'not-a-hash' },
    { path: 'a', symlink: 'b' },
    { path: 'a', sha256: HELLO_SHA256, symlink: 'b' },
    { path: 'a', region: 'other', sha256: HELLO_SHA256 },
    { path: '../a', sha256: HELLO_SHA256 },
    { path: 'a', sha256: HELLO_SHA256, executable: false },
    { path: 'a', sha256: HELLO_SHA256, executable: 'true' },
    { path: 'a', region: 'factory-shared', sha256: HELLO_SHA256, executable: true },
    { path: 'a', symlink: 'b', executable: true },
  ]) {
    writeManifest(root, [entry]);
    assert.throws(() => readManifest(root), /malformed manifest entry|invalid manifest path/, JSON.stringify(entry));
  }
});

test('a manifest that lists one path twice is refused, naming the path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, [
    { path: 'docs/a.txt', sha256: HELLO_SHA256 },
    { path: 'b.txt', sha256: HELLO_SHA256 },
    { path: 'docs/a.txt', sha256: ZERO_SHA256 },
  ]);
  assert.throws(() => readManifest(root), /\.agents\/factory-manifest\.json lists docs\/a\.txt more than once/);
});

// Refuses, with message, a manifest holding one file entry at each of the paths.
function assertPathsRefused(t, paths, message) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeManifest(root, paths.map((path) => ({ path, sha256: HELLO_SHA256 })));
  assert.throws(() => readManifest(root), { message });
}

for (const [name, first, second] of [
  ['Case.txt and case.txt', 'Case.txt', 'case.txt'],
  ['one accented name in NFC and in NFD', 'docs/café.txt', 'docs/café.txt'],
]) {
  test(`a manifest that lists ${name} is refused as two paths naming one file, naming both`, (t) => {
    assertPathsRefused(
      t,
      ['other.txt', first, second],
      `.agents/factory-manifest.json lists ${first} and ${second}, which name the same file on a case-insensitive or Unicode-normalising disk`,
    );
  });
}

for (const [name, paths, ancestor, descendant] of [
  ['a and a/b', ['a', 'a/b'], 'a', 'a/b'],
  ['d/x before D', ['d/x', 'D'], 'D', 'd/x'],
]) {
  test(`a manifest that lists ${name} is refused as one path lying under another, naming both`, (t) => {
    assertPathsRefused(t, paths, `.agents/factory-manifest.json lists ${ancestor} and ${descendant}, and ${descendant} lies under ${ancestor}`);
  });
}

test('ANTI-REGRESSION: a manifest that lists the seat settings path in any letter case or a path under it is refused by name', (t) => {
  for (const path of [
    '.agents/factory-settings.json',
    '.agents/Factory-Settings.json',
    '.AGENTS/factory-settings.json',
    '.agents/factory-settings.json/x',
  ]) {
    assertPathsRefused(
      t,
      [path],
      `.agents/factory-manifest.json lists ${path}, which names the seat settings file .agents/factory-settings.json or lies under it; that file is the repository's own and no manifest may list it`,
    );
  }
});

function regionTree(t, manual) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'AGENTS.md'), manual);
  writeManifest(root, [{ path: 'AGENTS.md', region: 'factory-shared', sha256: REGION_SHA256 }]);
  return root;
}

test('a region edit is reported while an edit outside the region is not', (t) => {
  const outside = regionTree(t, `# Product manual\n${START}\nx\ny\n${END}\n## Product rules\n`);
  assert.deepEqual(verifyManifest(outside), []);
  writeFileSync(join(outside, 'AGENTS.md'), `# Other manual\n${START}\nx\ny\n${END}\n## Other rules\n`);
  assert.deepEqual(verifyManifest(outside), []);

  writeFileSync(join(outside, 'AGENTS.md'), `# Other manual\n${START}\nx\nY\n${END}\n## Other rules\n`);
  const [mismatch, ...rest] = verifyManifest(outside);
  assert.deepEqual(rest, []);
  assert.equal(mismatch.path, 'AGENTS.md');
  assert.equal(mismatch.expected, REGION_SHA256);
  assert.notEqual(mismatch.actual, REGION_SHA256);
});

for (const [name, manual] of [
  ['no start marker', `x\ny\n${END}\n`],
  ['no end marker', `${START}\nx\ny\n`],
  ['a duplicated start marker', `${START}\n${START}\nx\ny\n${END}\n`],
  ['a duplicated end marker', `${START}\nx\ny\n${END}\n${END}\n`],
  ['reversed markers', `${END}\nx\ny\n${START}\n`],
]) {
  test(`a region with ${name} throws the named malformed region markers error`, (t) => {
    assert.throws(() => verifyManifest(regionTree(t, manual)), /AGENTS\.md: malformed region markers/);
  });
}

const CLAUDE_SEAT = '.claude/agents/builder.md';
const CODEX_SEAT = '.codex/agents/reviewer.toml';
const SETTINGS = '.agents/factory-settings.json';
// Each seat's shared bytes and the same bytes with the settings below in place, written by hand; the last line of
// the Claude charter repeats a setting line outside the settings block. Each hash was computed by `shasum -a 256`
// over a file holding the literal, never by the code under test.
const CLAUDE_SHARED = '---\nname: builder\nmodel: sonnet\neffort: medium\nmaxTurns: 60\n---\nBuild the slice.\nmodel: sonnet\n';
const CLAUDE_SHARED_SHA256 = 'e0fe01d14f1ff60b229d6cf7dbb49621a8b0410c100ce0f83acefd9de80582f3';
const CLAUDE_OVERRIDDEN = '---\nname: builder\nmodel: opus\neffort: medium\nmaxTurns: 120\n---\nBuild the slice.\nmodel: sonnet\n';
const CLAUDE_OVERRIDDEN_SHA256 = '636b1f54c6a5ed129705e425ff9bf4f5ac549dc5befdc3c52f5a6c6a6e348b98';
const CODEX_SHARED = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = """\nReview the change.\n"""\n';
const CODEX_SHARED_SHA256 = '45f015d74b0968dd65bea04ae4d487bc2ede027d9a1872d5787948b81ebb34fa';
const CODEX_OVERRIDDEN = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\nReview the change.\n"""\n';
const CODEX_OVERRIDDEN_SHA256 = '7c1a90822bdaa4b7ac6c5cb576611f0c06a38543f7d37697193a6843d9edf4fd';
const SEAT_ENTRIES = [
  { path: CLAUDE_SEAT, sha256: CLAUDE_SHARED_SHA256 },
  { path: CODEX_SEAT, sha256: CODEX_SHARED_SHA256 },
];
const SEAT_SETTINGS = { claude: { builder: { model: 'opus', maxTurns: 120 } }, codex: { reviewer: { model_reasoning_effort: 'high' } } };
const SEAT_DEFAULTS = { claude: { builder: { model: 'sonnet', maxTurns: 60 } }, codex: { reviewer: { model_reasoning_effort: 'medium' } } };

// A tree whose two seats hold the overridden bytes, with a settings file naming seats and a manifest recording
// seatDefaults; null leaves the settings file, or the record, out.
function seatTree(t, { seats = SEAT_SETTINGS, seatDefaults = SEAT_DEFAULTS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, CLAUDE_SEAT, CLAUDE_OVERRIDDEN);
  put(root, CODEX_SEAT, CODEX_OVERRIDDEN);
  writeManifest(root, SEAT_ENTRIES, seatDefaults ?? undefined);
  if (seats !== null) put(root, SETTINGS, JSON.stringify({ version: 1, seats }));
  return root;
}

test('an overridden seat verifies while it differs from the shared bytes only in the values the settings file names', (t) => {
  assert.deepEqual(verifyManifest(seatTree(t)), []);
});

// Each hash is `shasum -a 256` over a file holding CLAUDE_SHARED with that one change: the bytes the recorded
// defaults restore.
test('ANTI-REGRESSION: one changed byte outside the named setting values of an overridden seat is reported', (t) => {
  for (const [name, from, to, actual] of [
    ['a charter byte', 'Build the slice.', 'Build the slicE.', 'dcba2f02ea52ad97e1acf884141c603eed749d21b34da62700e7e57d6e9ce543'],
    ['a setting the settings file does not name', 'effort: medium', 'effort: high', 'ab3084dcc0b2c2622dbc71351440c5f66e6b16c95c1662cf7a5889a3161f5cc4'],
  ]) {
    const root = seatTree(t);
    put(root, CLAUDE_SEAT, CLAUDE_OVERRIDDEN.replace(from, to));
    assert.deepEqual(verifyManifest(root), [{ path: CLAUDE_SEAT, expected: CLAUDE_SHARED_SHA256, actual }], name);
  }

  const root = seatTree(t);
  put(root, CLAUDE_SEAT, CLAUDE_OVERRIDDEN.replace('maxTurns: 120\n', ''));
  const [mismatch, ...rest] = verifyManifest(root);
  assert.deepEqual(rest, []);
  assert.equal(mismatch.path, CLAUDE_SEAT);
  assert.equal(mismatch.expected, CLAUDE_SHARED_SHA256);
  assert.match(mismatch.actual, /^\.claude\/agents\/builder\.md: setting maxTurns is not carried exactly once/);
});

const NOT_RENDERED = 'seat settings not rendered; run node scripts/factory-sync.mjs --render';

test('an override the manifest does not record and a recorded default the settings file does not name are each reported', (t) => {
  const bothNotRendered = [
    { path: CLAUDE_SEAT, expected: CLAUDE_SHARED_SHA256, actual: NOT_RENDERED },
    { path: CODEX_SEAT, expected: CODEX_SHARED_SHA256, actual: NOT_RENDERED },
  ];
  assert.deepEqual(verifyManifest(seatTree(t, { seatDefaults: null })), bothNotRendered, 'an override with no recorded default');
  assert.deepEqual(verifyManifest(seatTree(t, { seats: null })), bothNotRendered, 'a recorded default with no override');
  const oneOfTwo = { claude: { builder: { model: 'sonnet' } }, codex: SEAT_DEFAULTS.codex };
  assert.deepEqual(verifyManifest(seatTree(t, { seatDefaults: oneOfTwo })), [bothNotRendered[0]], 'one of two overrides recorded');
});

test('an overridden seat whose setting line holds another value than the settings file names is reported', (t) => {
  const root = seatTree(t);
  put(root, CLAUDE_SEAT, CLAUDE_SHARED.replace('model: sonnet\neffort', 'model: haiku\neffort').replace('maxTurns: 60', 'maxTurns: 120'));
  put(root, CODEX_SEAT, CODEX_SHARED);
  assert.deepEqual(verifyManifest(root), [
    { path: CLAUDE_SEAT, expected: CLAUDE_SHARED_SHA256, actual: NOT_RENDERED },
    { path: CODEX_SEAT, expected: CODEX_SHARED_SHA256, actual: NOT_RENDERED },
  ]);
});

test('a malformed settings file or seat defaults record fails verification by name', (t) => {
  const notJson = seatTree(t);
  put(notJson, SETTINGS, '{');
  assert.throws(() => verifyManifest(notJson), /^Error: \.agents\/factory-settings\.json: is not valid JSON/);

  const unlistedSeat = seatTree(t, { seats: { claude: { planner: { model: 'opus' } } }, seatDefaults: null });
  assert.throws(
    () => verifyManifest(unlistedSeat),
    /^Error: \.agents\/factory-settings\.json names the seat \.claude\/agents\/planner\.md, which is not a file entry of the manifest/,
  );

  const unlistedDefault = seatTree(t, { seatDefaults: { claude: { planner: { model: 'sonnet' } } } });
  assert.throws(
    () => verifyManifest(unlistedDefault),
    /^Error: \.agents\/factory-manifest\.json seatDefaults names the seat \.claude\/agents\/planner\.md, which is not a file entry of the manifest/,
  );

  const unsafeDefault = seatTree(t, { seatDefaults: { claude: { builder: { model: 'son net' } } } });
  assert.throws(
    () => verifyManifest(unsafeDefault),
    /^Error: \.agents\/factory-manifest\.json seatDefaults: seats\.claude\.builder\.model: must be a string matching .*; found "son net"/,
  );
});

// The file the link reaches is not JSON, so reading it would throw the JSON refusal instead.
test('a settings file that is a symlink is refused and never read', NEEDS_FILE_SYMLINK, (t) => {
  const root = seatTree(t, { seats: null });
  put(root, 'elsewhere.json', '{');
  link(root, SETTINGS, '../elsewhere.json');
  assert.throws(() => verifyManifest(root), /^Error: \.agents\/factory-settings\.json is not a regular file \(a symlink\)/);
  assert.throws(() => presentRuntimes(root), /^Error: \.agents\/factory-settings\.json is not a regular file \(a symlink\)/);
});

// The directory the link reaches holds a valid manifest and a settings file that is not JSON, so reading that
// file would throw the JSON refusal instead.
test('a settings file reached through a symlinked parent is refused and never read', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'tree');
  writeManifest(join(base, 'outside'), [{ path: 'docs/a.txt', sha256: HELLO_SHA256 }]);
  put(base, 'outside/.agents/factory-settings.json', '{');
  put(root, 'docs/a.txt', 'hello\n');
  link(root, '.agents', '../outside/.agents');
  assert.throws(() => verifyManifest(root), /^Error: \.agents\/factory-settings\.json: its parent .*\.agents is a symlink/);
  assert.throws(() => presentRuntimes(root), /^Error: \.agents\/factory-settings\.json: its parent .*\.agents is a symlink/);
});

test('ANTI-REGRESSION: a seat setting changed without the settings file naming it is reported', (t) => {
  assert.deepEqual(verifyManifest(seatTree(t, { seats: null, seatDefaults: null })), [
    { path: CLAUDE_SEAT, expected: CLAUDE_SHARED_SHA256, actual: CLAUDE_OVERRIDDEN_SHA256 },
    { path: CODEX_SEAT, expected: CODEX_SHARED_SHA256, actual: CODEX_OVERRIDDEN_SHA256 },
  ]);
});

const absentFor = (runtime) => `absent (the settings file names no ${runtime} runtime)`;

// A tree holding docs/a.txt and a manifest that lists it after `entries`, none of which the tree holds; `settings` is
// written as its settings file, and left out writes none.
function featureTree(t, entries, settings) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'docs/a.txt', 'hello\n');
  writeManifest(root, [...entries, { path: 'docs/a.txt', sha256: HELLO_SHA256 }]);
  if (settings !== undefined) put(root, SETTINGS, JSON.stringify(settings));
  return root;
}

test('ANTI-REGRESSION: a tree that names one runtime verifies without the other\'s files, refuses anything at their paths, and still refuses a missing or changed file of its own', (t) => {
  const tree = () => featureTree(t, SEAT_ENTRIES);
  const claude = { name: 'claude', path: CLAUDE_SEAT, shared: CLAUDE_SHARED, sharedSha256: CLAUDE_SHARED_SHA256, other: CLAUDE_OVERRIDDEN, otherSha256: CLAUDE_OVERRIDDEN_SHA256 };
  const codex = { name: 'codex', path: CODEX_SEAT, shared: CODEX_SHARED, sharedSha256: CODEX_SHARED_SHA256, other: CODEX_OVERRIDDEN, otherSha256: CODEX_OVERRIDDEN_SHA256 };

  for (const [named, leftOut] of [
    [claude, codex],
    [codex, claude],
  ]) {
    const root = tree();
    put(root, named.path, named.shared);
    put(root, SETTINGS, JSON.stringify({ version: 1, runtimes: [named.name], seats: {} }));
    assert.deepEqual(verifyManifest(root), [], `${named.name} alone, none of the other runtime's files`);

    const expected = absentFor(leftOut.name);
    put(root, leftOut.path, leftOut.shared);
    assert.deepEqual(verifyManifest(root), [{ path: leftOut.path, expected, actual: leftOut.sharedSha256 }], 'the recorded bytes at a left-out path');
    put(root, leftOut.path, leftOut.other);
    assert.deepEqual(verifyManifest(root), [{ path: leftOut.path, expected, actual: leftOut.otherSha256 }], 'other bytes at a left-out path');
    rmSync(join(root, leftOut.path));
    mkdirSync(join(root, leftOut.path));
    assert.deepEqual(verifyManifest(root), [{ path: leftOut.path, expected, actual: 'not a regular file (a directory)' }], 'a directory at a left-out path');
    rmSync(join(root, leftOut.path), { recursive: true });

    put(root, named.path, named.other);
    assert.deepEqual(verifyManifest(root), [{ path: named.path, expected: named.sharedSha256, actual: named.otherSha256 }], 'a changed file of the named runtime');
    rmSync(join(root, named.path));
    assert.deepEqual(verifyManifest(root), [{ path: named.path, expected: named.sharedSha256, actual: 'missing' }], 'a missing file of the named runtime');
    put(root, named.path, named.shared);
    rmSync(join(root, 'docs/a.txt'));
    assert.deepEqual(verifyManifest(root), [{ path: 'docs/a.txt', expected: HELLO_SHA256, actual: 'missing' }], 'a missing file of every install');
  }

  const invalid = tree();
  put(invalid, SETTINGS, JSON.stringify({ version: 1, runtimes: [], seats: {} }));
  assert.throws(
    () => verifyManifest(invalid),
    /^Error: \.agents\/factory-settings\.json: runtimes: must be a non-empty array naming claude, codex or both, each once; found \[\]$/,
  );
});

// The Greptile add-on's three paths, written out by hand, and the bytes these tests put there. Each hash was computed
// by `printf '<bytes>' | shasum -a 256`, never by the code under test.
const GREPTILE_SKILL = '.agents/skills/greptile/SKILL.md';
const GREPTILE_SKILL_COPY = '.claude/skills/greptile/SKILL.md';
const GREPTILE_CONFIG = '.greptile/config.json';
const SKILL_TEXT = 'greptile skill\n';
const SKILL_SHA256 = '21672778c2efb166916a1ce3bbfd9a4558bcf0439d66e49a695fda389fcab5be';
const CONFIG_TEXT = '{"skipReview":"AUTOMATIC"}\n';
const CONFIG_SHA256 = '511e51cd4d2427e9c0821b17aa31e9bb8ba90bd5607bbe211b935e7e545083ec';
const OTHER_TEXT = 'other\n';
const OTHER_SHA256 = '7e4fa2eb8c7ac089739d5defc4489fad68a100d92082ca35c6b40a4524821f87';
const GREPTILE_FILES = [
  [GREPTILE_SKILL, SKILL_TEXT, SKILL_SHA256],
  [GREPTILE_SKILL_COPY, SKILL_TEXT, SKILL_SHA256],
  [GREPTILE_CONFIG, CONFIG_TEXT, CONFIG_SHA256],
];
const ADD_ON_OFF = 'absent (the settings file does not turn the Greptile add-on on)';
const GREPTILE_ON = { version: 1, seats: {}, greptile: true };
const GREPTILE_OFF = { version: 1, seats: {}, greptile: false };

test('ANTI-REGRESSION: a tree that does not turn the Greptile add-on on verifies without its files and refuses anything at their paths, and a tree that turns it on still refuses a missing or changed add-on file', (t) => {
  const tree = (settings) => featureTree(t, GREPTILE_FILES.map(([path, , sha256]) => ({ path, sha256 })), settings);

  for (const [name, settings] of [
    ['no settings file', undefined],
    ['greptile false', GREPTILE_OFF],
    ['no greptile key', { version: 1, seats: {} }],
  ]) {
    const root = tree(settings);
    assert.deepEqual(verifyManifest(root), [], `${name}: none of the add-on's files`);
    for (const [path, text, sha256] of GREPTILE_FILES) {
      put(root, path, text);
      assert.deepEqual(verifyManifest(root), [{ path, expected: ADD_ON_OFF, actual: sha256 }], `${name}: the recorded bytes at ${path}`);
      put(root, path, OTHER_TEXT);
      assert.deepEqual(verifyManifest(root), [{ path, expected: ADD_ON_OFF, actual: OTHER_SHA256 }], `${name}: other bytes at ${path}`);
      rmSync(join(root, path));
    }
    rmSync(join(root, 'docs/a.txt'));
    assert.deepEqual(verifyManifest(root), [{ path: 'docs/a.txt', expected: HELLO_SHA256, actual: 'missing' }], `${name}: a missing file of every install`);
  }

  const on = tree(GREPTILE_ON);
  for (const [path, text] of GREPTILE_FILES) put(on, path, text);
  assert.deepEqual(verifyManifest(on), [], 'the add-on on, every file present');
  for (const [path, text, sha256] of GREPTILE_FILES) {
    rmSync(join(on, path));
    assert.deepEqual(verifyManifest(on), [{ path, expected: sha256, actual: 'missing' }], `the add-on on: ${path} missing`);
    put(on, path, OTHER_TEXT);
    assert.deepEqual(verifyManifest(on), [{ path, expected: sha256, actual: OTHER_SHA256 }], `the add-on on: ${path} changed`);
    put(on, path, text);
  }

  for (const greptile of [true, false]) {
    const codexOnly = tree({ version: 1, runtimes: ['codex'], seats: {}, greptile });
    if (greptile) for (const [path, text] of GREPTILE_FILES) put(codexOnly, path, text);
    else put(codexOnly, GREPTILE_SKILL_COPY, SKILL_TEXT);
    assert.deepEqual(
      verifyManifest(codexOnly),
      [{ path: GREPTILE_SKILL_COPY, expected: absentFor('claude'), actual: SKILL_SHA256 }],
      `codex alone, greptile ${greptile}: the runtime is the cause at the Claude copy`,
    );
  }
});

// The documentation sweep's six shared paths, written out by hand; each fixture file holds hello, so no hash is
// computed by the code under test.
const SWEEP_PATHS = [
  '.github/workflows/sweep-scope.yml',
  'scripts/lib/sweep-scope-corpus.mjs',
  'scripts/lib/sweep-scope-evaluate.mjs',
  'scripts/lib/sweep-scope.mjs',
  'scripts/lib/sweep-scope.test.mjs',
  'scripts/sweep-scope-check.mjs',
];
const SWEEP_OFF_CAUSE = 'absent (the settings file turns the documentation sweep off)';
const SWEEP_ON = { version: 1, seats: {}, docSweep: true };
const SWEEP_OFF = { version: 1, seats: {}, docSweep: false };

test('ANTI-REGRESSION: a tree that turns the documentation sweep off verifies without its files and refuses anything at their paths, and a tree that does not turn it off still refuses a missing or changed sweep file', (t) => {
  const tree = (settings) => featureTree(t, SWEEP_PATHS.map((path) => ({ path, sha256: HELLO_SHA256 })), settings);

  const off = tree(SWEEP_OFF);
  assert.deepEqual(verifyManifest(off), [], 'the sweep off: none of its files');
  for (const path of SWEEP_PATHS) {
    put(off, path, 'hello\n');
    assert.deepEqual(verifyManifest(off), [{ path, expected: SWEEP_OFF_CAUSE, actual: HELLO_SHA256 }], `the recorded bytes at ${path}`);
    put(off, path, OTHER_TEXT);
    assert.deepEqual(verifyManifest(off), [{ path, expected: SWEEP_OFF_CAUSE, actual: OTHER_SHA256 }], `other bytes at ${path}`);
    rmSync(join(off, path));
  }
  rmSync(join(off, 'docs/a.txt'));
  assert.deepEqual(verifyManifest(off), [{ path: 'docs/a.txt', expected: HELLO_SHA256, actual: 'missing' }], 'a missing file of every install');

  for (const [name, settings] of [
    ['no settings file', undefined],
    ['no docSweep key', { version: 1, seats: {} }],
    ['docSweep true', SWEEP_ON],
  ]) {
    const held = tree(settings);
    for (const path of SWEEP_PATHS) put(held, path, 'hello\n');
    assert.deepEqual(verifyManifest(held), [], `${name}: every sweep file present`);
    for (const path of SWEEP_PATHS) {
      rmSync(join(held, path));
      assert.deepEqual(verifyManifest(held), [{ path, expected: HELLO_SHA256, actual: 'missing' }], `${name}: ${path} missing`);
      put(held, path, OTHER_TEXT);
      assert.deepEqual(verifyManifest(held), [{ path, expected: HELLO_SHA256, actual: OTHER_SHA256 }], `${name}: ${path} changed`);
      put(held, path, 'hello\n');
    }
  }

  const codexOnly = tree({ version: 1, runtimes: ['codex'], seats: {}, docSweep: false });
  put(codexOnly, SWEEP_PATHS[0], 'hello\n');
  assert.deepEqual(
    verifyManifest(codexOnly),
    [{ path: SWEEP_PATHS[0], expected: SWEEP_OFF_CAUSE, actual: HELLO_SHA256 }],
    'codex alone, the sweep off: the sweep is the cause at a sweep file',
  );
});

test('verifyManifest judges a tree by the settings it is handed, and by its own settings file when handed none', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const everyInstall = 'docs/a.txt';
  const codexPath = '.codex/rules/example.rules';
  const sweepPath = SWEEP_PATHS[0];
  const manifest = {
    entries: [everyInstall, codexPath, sweepPath].map((path) => ({ path, sha256: HELLO_SHA256 })),
  };
  const handed = JSON.stringify({ version: 1, runtimes: ['claude'], seats: {}, docSweep: false });

  assert.throws(
    () => verifyManifest(root, manifest, { runtimes: ['claude'], greptile: false, docSweep: false, overrides: new Map() }),
    /is not valid JSON/,
    'settings reach the check only as settings-file text: an object a caller built is refused',
  );
  assert.deepEqual(
    verifyManifest(root, manifest, handed),
    [{ path: everyInstall, expected: HELLO_SHA256, actual: 'missing' }],
    'handed settings that leave out the codex and sweep entries: only the every-install entry is missing',
  );
  assert.deepEqual(
    verifyManifest(root, manifest).map(({ path, actual }) => [path, actual]),
    [everyInstall, codexPath, sweepPath].map((path) => [path, 'missing']),
    'handed none, the tree has no settings file and installs all three',
  );

  put(root, codexPath, 'hello\n');
  const [absent, ...rest] = verifyManifest(root, manifest, handed).filter(({ path }) => path === codexPath);
  assert.deepEqual(rest, []);
  assert.deepEqual(absent, { path: codexPath, expected: absentFor('codex'), actual: HELLO_SHA256 });
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'factory-sync.mjs');
const ZERO_SHA256 = '0'.repeat(64);

// A git repository whose manifest records stale values for a region and a file.
function staleRepository(t, origin) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  if (origin) spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  writeFileSync(join(root, 'AGENTS.md'), `# Product manual\n${START}\nx\ny\n${END}\n`);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.txt'), 'hello\n');
  writeManifest(root, [
    { path: 'AGENTS.md', region: 'factory-shared', sha256: ZERO_SHA256 },
    { path: 'docs/a.txt', sha256: ZERO_SHA256 },
  ]);
  return root;
}

const runCli = (root, ...args) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const manifestBytes = (root) => readFileSync(join(root, '.agents', 'factory-manifest.json'), 'utf8');

test('without --write the CLI prints its usage and exits non-zero', (t) => {
  const run = runCli(staleRepository(t, 'https://github.com/example-owner/example-repo.git'));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /usage: node scripts\/factory-sync\.mjs --write/);
});

test('--write refuses a repository whose origin is not the canonical, and one with no origin', (t) => {
  for (const origin of ['https://github.com/example-owner/adopter.git', undefined]) {
    const root = staleRepository(t, origin);
    const before = manifestBytes(root);
    const run = runCli(root, '--write');
    assert.notEqual(run.status, 0, `origin ${origin}`);
    assert.match(run.stderr, /refusing to --write: .* is not github\.com\/example-owner\/example-repo/);
    assert.equal(manifestBytes(root), before, 'a refused --write must leave the manifest untouched');
  }
});

test('--write in the canonical repository records every entry deterministically', (t) => {
  const root = staleRepository(t, 'https://github.com/example-owner/example-repo.git');
  const expected = `${JSON.stringify(
    {
      canonical: 'example-owner/example-repo',
      entries: [
        { path: 'AGENTS.md', region: 'factory-shared', sha256: REGION_SHA256 },
        { path: 'docs/a.txt', sha256: HELLO_SHA256 },
      ],
    },
    null,
    2,
  )}\n`;
  const first = runCli(root, '--write');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(manifestBytes(root), expected);

  spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:example-owner/example-repo'], { cwd: root });
  const second = runCli(root, '--write');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(manifestBytes(root), expected, 'a second --write over unchanged files must yield identical bytes');
});

const CANONICAL = 'example-owner/example-repo';
const CANONICAL_URL = `https://github.com/${CANONICAL}`;
const ADOPTER_URL = 'https://github.com/example-owner/adopter';
const MANIFEST = '.agents/factory-manifest.json';
const GIT_ISOLATION = ['-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function git(root, ...args) {
  const run = spawnSync('git', ['-C', root, ...GIT_ISOLATION, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function commitAll(root) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'fixture');
}

// The git mode root's index records for path.
const indexMode = (root, path) => git(root, 'ls-files', '-s', '--', path).split(' ')[0];

function put(root, path, content, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  chmodSync(join(root, path), mode);
}

// On Windows a link to a directory is a junction, which needs no privilege and holds an absolute target.
function link(root, path, text) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  const destination = resolve(dirname(full), text);
  if (process.platform === 'win32' && statSync(destination, { throwIfNoEntry: false })?.isDirectory()) symlinkSync(destination, full, 'junction');
  else symlinkSync(text, full);
}

function repository(root, origin) {
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', origin);
}

// Runs fn with the given environment variables set, restoring the previous environment afterwards.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Every path under root except .git (git status may refresh the index), with its kind, mode and bytes.
function snapshot(root) {
  const tree = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = relative(root, full);
      if (path === '.git') continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) tree[path] = `symlink ${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        tree[path] = 'directory';
        walk(full);
      } else tree[path] = `${(stat.mode & 0o777).toString(8)} ${readFileSync(full, 'base64')}`;
    }
  };
  walk(root);
  return tree;
}

// Seat files as a canonical ships them; with a known model and effort each passes the agent check. The bytes a
// render is expected to leave are written out by hand in each test, never built by these.
const ORACLE_MD = '.claude/agents/oracle.md';
const BUILDER_MD = '.claude/agents/builder.md';
const REVIEWER_TOML = '.codex/agents/reviewer.toml';
const claudeSeat = (name, model, effort, maxTurns) =>
  `---\nname: ${name}\ndescription: "Fixture ${name}"\nmodel: ${model}\neffort: ${effort}\nmaxTurns: ${maxTurns}\n---\nDo the work.\n`;
const codexSeat = (name, model, effort) =>
  `name = "${name}"\ndescription = "Fixture ${name}"\nmodel = "${model}"\nmodel_reasoning_effort = "${effort}"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo the work.\n"""\n`;

// The sentence a refused value ends with, word for word as the head of seat-settings.mjs gives it.
const NAMED_AFTER_UPDATE = /; a value only a newer copy of the shared workflow admits can be named after the release update that installs it$/;

// An adopter repository holding the two seats with the given bytes, a manifest that lists them with seatDefaults,
// when given, and a settings file naming seats; null leaves the settings file out.
function renderTree(t, { claude = CLAUDE_SHARED, codex = CODEX_SHARED, seats = SEAT_SETTINGS, seatDefaults, origin = ADOPTER_URL } = {}) {
  const root = staleRepository(t, origin);
  put(root, CLAUDE_SEAT, claude);
  put(root, CODEX_SEAT, codex);
  writeManifest(root, SEAT_ENTRIES, seatDefaults);
  if (seats !== null) put(root, SETTINGS, JSON.stringify({ version: 1, seats }));
  return root;
}

// The manifest text a render leaves in a renderTree: seatDefaults left out leaves no such record.
const renderedManifest = (seatDefaults) =>
  `${JSON.stringify({ canonical: CANONICAL, adopters: ['example-owner/adopter'], seatDefaults, entries: SEAT_ENTRIES }, null, 2)}\n`;

test('render applies the settings file to the named seats, records the replaced defaults, and changes nothing on a second run', (t) => {
  const root = renderTree(t);

  assert.deepEqual(renderSettings(root), { seats: [CLAUDE_SEAT, CODEX_SEAT], manifest: true });

  assert.equal(readFileSync(join(root, CLAUDE_SEAT), 'utf8'), CLAUDE_OVERRIDDEN);
  assert.equal(readFileSync(join(root, CODEX_SEAT), 'utf8'), CODEX_OVERRIDDEN);
  assert.equal(manifestBytes(root), renderedManifest(SEAT_DEFAULTS));
  assert.deepEqual(verifyManifest(root), []);

  const rendered = snapshot(root);
  assert.deepEqual(renderSettings(root), { seats: [], manifest: false });
  assert.deepEqual(snapshot(root), rendered, 'a second render must write nothing');
});

test('render with an override removed restores the seat to the shared bytes and drops its recorded default', (t) => {
  const root = renderTree(t, { claude: CLAUDE_OVERRIDDEN, codex: CODEX_OVERRIDDEN, seats: { codex: SEAT_SETTINGS.codex }, seatDefaults: SEAT_DEFAULTS });

  assert.deepEqual(renderSettings(root), { seats: [CLAUDE_SEAT], manifest: true });
  assert.equal(readFileSync(join(root, CLAUDE_SEAT), 'utf8'), CLAUDE_SHARED);
  assert.equal(readFileSync(join(root, CODEX_SEAT), 'utf8'), CODEX_OVERRIDDEN);
  assert.equal(manifestBytes(root), renderedManifest({ codex: SEAT_DEFAULTS.codex }));
  assert.deepEqual(verifyManifest(root), []);

  rmSync(join(root, SETTINGS));
  assert.deepEqual(renderSettings(root), { seats: [CODEX_SEAT], manifest: true });
  assert.equal(readFileSync(join(root, CODEX_SEAT), 'utf8'), CODEX_SHARED);
  assert.equal(manifestBytes(root), renderedManifest(), 'a tree with no override left must record no seatDefaults');
  assert.deepEqual(verifyManifest(root), []);
});

test('render skips the recorded default of a seat whose runtime the settings file leaves out, and drops it', (t) => {
  const root = renderTree(t, { claude: CLAUDE_OVERRIDDEN, codex: CODEX_OVERRIDDEN, seats: null, seatDefaults: SEAT_DEFAULTS });
  put(root, SETTINGS, JSON.stringify({ version: 1, runtimes: ['claude'], seats: { claude: SEAT_SETTINGS.claude } }));

  assert.deepEqual(renderSettings(root), { seats: [], manifest: true });

  assert.equal(readFileSync(join(root, CODEX_SEAT), 'utf8'), CODEX_OVERRIDDEN, 'a seat of a left-out runtime must not be written');
  assert.equal(manifestBytes(root), renderedManifest({ claude: SEAT_DEFAULTS.claude }));
  assert.deepEqual(verifyManifest(root), [{ path: CODEX_SEAT, expected: absentFor('codex'), actual: CODEX_OVERRIDDEN_SHA256 }]);
  rmSync(join(root, CODEX_SEAT));
  assert.deepEqual(verifyManifest(root), []);
  assert.deepEqual(renderSettings(root), { seats: [], manifest: false });
});

test('render reports whether it rewrote the manifest', (t) => {
  const equalToDefault = renderTree(t, { seats: { claude: { builder: { model: 'sonnet' } } } });
  assert.deepEqual(renderSettings(equalToDefault), { seats: [], manifest: true }, 'a value equal to the default changes only the manifest');
  assert.deepEqual(renderSettings(equalToDefault), { seats: [], manifest: false });

  const changed = renderTree(t, { seats: { claude: SEAT_SETTINGS.claude } });
  assert.deepEqual(renderSettings(changed), { seats: [CLAUDE_SEAT], manifest: true });
  assert.deepEqual(renderSettings(changed), { seats: [], manifest: false });
});

// The key is written as JSON text: an object literal naming __proto__ would set a prototype, not an own key.
test('--render keeps a top-level manifest key named __proto__', (t) => {
  const root = renderTree(t);
  const path = join(root, MANIFEST);
  writeFileSync(path, readFileSync(path, 'utf8').replace('{', '{"__proto__":{"sentinel":"preserve-me"},'));

  assert.deepEqual(renderSettings(root), { seats: [CLAUDE_SEAT, CODEX_SEAT], manifest: true });

  const rendered = JSON.parse(manifestBytes(root));
  assert.ok(Object.hasOwn(rendered, '__proto__'), 'the render dropped the __proto__ key');
  assert.deepEqual(rendered['__proto__'], { sentinel: 'preserve-me' });
  assert.deepEqual(rendered.seatDefaults, SEAT_DEFAULTS);
});

// A render of root that must throw cause and leave root, and outside when given, as they were.
function assertRenderRefused(root, cause, outside = root) {
  const before = [snapshot(root), snapshot(outside)];
  assert.throws(() => renderSettings(root), cause);
  assert.deepEqual([snapshot(root), snapshot(outside)], before, 'a refused render must write nothing');
}

// The Claude seat sorts first and could be rendered, so a render that wrote as it went would have rewritten it.
test('render refuses a seat whose bytes outside its setting lines are not the shared file and writes nothing', (t) => {
  const cause = /^Error: \.codex\/agents\/reviewer\.toml: its bytes outside its setting lines are not the shared file/;
  const edited = (seat) => seat.replace('Review the change.', 'Review the changE.');
  assertRenderRefused(renderTree(t, { codex: edited(CODEX_SHARED) }), cause);
  assertRenderRefused(renderTree(t, { codex: edited(CODEX_OVERRIDDEN), seatDefaults: { codex: SEAT_DEFAULTS.codex } }), cause);
});

test('render refuses the canonical repository and invalid settings and writes nothing', (t) => {
  const root = staleRepository(t, ADOPTER_URL);
  const seats = {
    [ORACLE_MD]: claudeSeat('oracle', 'fable', 'high', 90),
    [BUILDER_MD]: claudeSeat('builder', 'sonnet', 'medium', 60),
    '.claude/agents/explorer.md': '---\nname: explorer\ndescription: "Fixture explorer"\nmodel: haiku\n---\nDo the work.\n',
    [REVIEWER_TOML]: codexSeat('reviewer', 'gpt-6-luna', 'medium'),
  };
  for (const [path, text] of Object.entries(seats)) put(root, path, text);
  writeManifest(root, computeEntries(root, { entries: Object.keys(seats).map((path) => ({ path, sha256: ZERO_SHA256 })) }));

  put(root, SETTINGS, '{');
  assertRenderRefused(root, /^Error: \.agents\/factory-settings\.json: is not valid JSON/);

  for (const [name, named, ...causes] of [
    [
      'a seat the manifest does not share',
      { claude: { planner: { model: 'opus' } } },
      /^Error: \.agents\/factory-settings\.json names the seat \.claude\/agents\/planner\.md, which is not a file entry of the manifest$/,
    ],
    [
      'an unknown model',
      { codex: { reviewer: { model: 'example-newer-model' } } },
      /\.codex\/agents\/reviewer\.toml.*unknown model `example-newer-model`/,
      NAMED_AFTER_UPDATE,
    ],
    [
      'a setting the seat does not carry',
      { claude: { explorer: { effort: 'high' } } },
      /^Error: \.claude\/agents\/explorer\.md: setting effort is not carried exactly once/,
    ],
    [
      'the costliest Claude model on the builder',
      { claude: { builder: { model: 'fable' } } },
      /\.claude\/agents\/builder\.md.*the costliest Claude model may sit only on the oracle seat/,
      NAMED_AFTER_UPDATE,
    ],
    [
      'a turn limit of 120 on the oracle',
      { claude: { oracle: { maxTurns: 120 } } },
      /\.claude\/agents\/oracle\.md.*the turn limit of this seat must be one line maxTurns: N with N a whole number from 1 to 90/,
      NAMED_AFTER_UPDATE,
    ],
    ['inherit', { claude: { builder: { model: 'inherit' } } }, /seats\.claude\.builder\.model: inherit leaves the seat model to the session/],
  ]) {
    put(root, SETTINGS, JSON.stringify({ version: 1, seats: named }));
    for (const cause of causes) {
      assertRenderRefused(root, (error) => {
        assert.match(String(error), cause, name);
        return true;
      });
    }
  }

  // Settings an adopter could render, so the canonical origin is the only cause left.
  put(root, SETTINGS, JSON.stringify({ version: 1, seats: { claude: { builder: { effort: 'high' } } } }));
  git(root, 'remote', 'set-url', 'origin', CANONICAL_URL);
  assertRenderRefused(
    root,
    /^Error: the origin https:\/\/github\.com\/example-owner\/example-repo is the canonical github\.com\/example-owner\/example-repo, whose seat lines are the defaults/,
  );
});

test('--render prints each seat it rewrote and exits 0', (t) => {
  const root = renderTree(t);
  const run = runCli(root, '--render');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split('\n'), [
    'factory-sync: applied the seat settings to 2 seats',
    '  .claude/agents/builder.md',
    '  .codex/agents/reviewer.toml',
    '',
  ]);
  assert.equal(readFileSync(join(root, CLAUDE_SEAT), 'utf8'), CLAUDE_OVERRIDDEN, 'a printed seat must hold the named values');
  assert.equal(readFileSync(join(root, CODEX_SEAT), 'utf8'), CODEX_OVERRIDDEN, 'a printed seat must hold the named values');
});

test('--render that changes only the manifest says so, and says already applied only when it writes nothing', (t) => {
  const root = renderTree(t, { seats: { claude: { builder: { model: 'sonnet' } } } });
  const run = runCli(root, '--render');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'factory-sync: applied the seat settings; no seat file changed, and the manifest now records the defaults\n');
  assert.equal(readFileSync(join(root, CLAUDE_SEAT), 'utf8'), CLAUDE_SHARED, 'a value equal to the default must leave the seat as it was');
  assert.equal(manifestBytes(root), renderedManifest({ claude: { builder: { model: 'sonnet' } } }));

  const rendered = snapshot(root);
  const again = runCli(root, '--render');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'factory-sync: the seat settings are already applied\n');
  assert.deepEqual(snapshot(root), rendered, 'the second --render must write nothing');
});

test('--render exits 1 naming the cause when the settings file is invalid and leaves the tree unchanged', (t) => {
  const root = renderTree(t);
  put(root, SETTINGS, '{');
  const before = snapshot(root);
  const run = runCli(root, '--render');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^factory-sync: \.agents\/factory-settings\.json: is not valid JSON\n$/);
  assert.deepEqual(snapshot(root), before, 'a refused --render must write nothing');
});

test('render applies settings and keeps the manifest release record and key order', (t) => {
  const root = renderTree(t);
  const release = { tag: 'v0.2.0', id: 1, assetId: 2, digest: `sha256:${ZERO_SHA256}` };
  writeFileSync(join(root, MANIFEST), JSON.stringify({ canonical: CANONICAL, release, entries: SEAT_ENTRIES }));

  assert.deepEqual(renderSettings(root), { seats: [CLAUDE_SEAT, CODEX_SEAT], manifest: true });

  assert.equal(readFileSync(join(root, CLAUDE_SEAT), 'utf8'), CLAUDE_OVERRIDDEN);
  assert.equal(
    manifestBytes(root),
    `${JSON.stringify({ canonical: CANONICAL, release, seatDefaults: SEAT_DEFAULTS, entries: SEAT_ENTRIES }, null, 2)}\n`,
  );
  assert.deepEqual(verifyManifest(root), []);
});

// A tree holding the Claude seat at its shared bytes beside an outside directory holding a valid manifest that
// lists that seat, as { tree, outside }. The caller links the tree to the outside manifest and adds a settings file
// overriding the seat, so a render that missed its check would write.
function treeBesideOutside(t) {
  const base = mkdtempSync(join(tmpdir(), 'factory-sync-render-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [tree, outside] = ['tree', 'outside'].map((name) => join(base, name));
  put(tree, CLAUDE_SEAT, CLAUDE_SHARED);
  writeManifest(outside, [SEAT_ENTRIES[0]]);
  return { tree, outside };
}

const CLAUDE_OVERRIDE = JSON.stringify({ version: 1, seats: { claude: SEAT_SETTINGS.claude } });

test('ANTI-REGRESSION: render refuses a manifest and settings file reached through a symlinked parent and writes nothing inside or outside the tree', (t) => {
  const { tree, outside } = treeBesideOutside(t);
  put(outside, SETTINGS, CLAUDE_OVERRIDE);
  link(tree, '.agents', '../outside/.agents');
  assertRenderRefused(tree, /^Error: \.agents\/factory-manifest\.json: its parent .*\.agents is a symlink/, outside);
});

// The manifest and a settings file overriding the seat sit inside the tree, so a render that missed the seat check
// would rewrite the seat in the outside directory the tree's agents directory points at.
test('ANTI-REGRESSION: render refuses a seat file reached through a symlinked directory and writes nothing inside or outside the tree', (t) => {
  const { tree, outside } = treeBesideOutside(t);
  rmSync(join(tree, '.claude'), { recursive: true });
  put(outside, CLAUDE_SEAT, CLAUDE_SHARED);
  writeManifest(tree, [SEAT_ENTRIES[0]]);
  put(tree, SETTINGS, CLAUDE_OVERRIDE);
  link(tree, '.claude/agents', '../../outside/.claude/agents');
  assertRenderRefused(tree, /^Error: \.claude\/agents\/builder\.md: its parent .*agents is a symlink/, outside);
});

test('render refuses a manifest that is a symlink and writes nothing', NEEDS_FILE_SYMLINK, (t) => {
  const { tree, outside } = treeBesideOutside(t);
  put(tree, SETTINGS, CLAUDE_OVERRIDE);
  link(tree, MANIFEST, '../../outside/.agents/factory-manifest.json');
  assertRenderRefused(tree, /^Error: \.agents\/factory-manifest\.json is not a regular file \(a symlink\)$/, outside);
});

test('recordIndexModes preserves filtered bytes and refuses unsafe input before staging', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-index-filter-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repository');
  const outside = join(base, 'outside');
  repository(root, ADOPTER_URL);
  put(outside, 'secret.txt', 'outside\n');
  const outsideBefore = snapshot(outside);
  const entries = [
    { path: 'data/run.sh', executable: true },
    { path: 'data/literal,[é];.txt' },
  ];
  for (const { path } of entries) put(root, path, 'working\r\n');
  put(root, '.gitattributes', 'data/** filter=index-clean text eol=lf\n');
  put(root, '.git/index-clean.cjs', "if (process.argv[2] === 'fail') process.exit(1);\nprocess.stdout.write(require('node:fs').readFileSync(0, 'utf8').replace('working', 'staged'));\n");
  git(root, 'config', 'core.fileMode', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'filter.index-clean.clean', 'node .git/index-clean.cjs');
  git(root, 'config', 'filter.index-clean.required', 'true');
  const diskBefore = snapshot(root);

  recordIndexModes(root, entries);

  assert.deepEqual(snapshot(root), diskBefore, 'staging converted blobs must not rewrite working files');
  assert.deepEqual(snapshot(outside), outsideBefore);
  for (const [i, { path }] of entries.entries()) {
    assert.equal(readFileSync(join(root, path), 'utf8'), 'working\r\n');
    const indexed = spawnSync('git', ['-C', root, ...GIT_ISOLATION, 'show', `:${path}`], { encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    assert.equal(indexed.stdout, 'staged\n', 'clean filter and text attributes must both affect the indexed bytes');
    assert.equal(indexMode(root, path), i === 0 ? '100755' : '100644');
  }
  const indexBefore = readFileSync(join(root, '.git', 'index'));
  const nativeSpawn = childProcess.spawnSync;
  const calls = [];
  let malformed = false;
  const wrapped = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push(args);
    if (malformed && args.includes('hash-object')) return { status: 0, stdout: 'not-an-object-id\n', stderr: '' };
    return nativeSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    const refused = (input) => {
      const before = snapshot(root);
      calls.length = 0;
      assert.throws(() => recordIndexModes(root, input), /cannot record/);
      assert.equal(calls.some((args) => args.includes('update-index')), false, 'refused input must never reach index mutation');
      assert.deepEqual(readFileSync(join(root, '.git', 'index')), indexBefore, 'refusal must preserve the actual index bytes');
      assert.deepEqual(snapshot(root), before);
      assert.deepEqual(snapshot(outside), outsideBefore);
    };
    git(root, 'config', 'filter.index-clean.clean', 'node .git/index-clean.cjs fail');
    refused(entries);
    assert.ok(calls.some((args) => args.includes('hash-object')), 'required filter failure must reach native Git');
    git(root, 'config', 'filter.index-clean.clean', 'node .git/index-clean.cjs');

    mkdirSync(join(root, 'data', 'unsafe'));
    refused([entries[0], { path: 'data/unsafe' }]);
    assert.equal(calls.some((args) => args.includes('hash-object')), false, 'every leaf must be checked before hashing');
    rmSync(join(root, 'data', 'unsafe'), { recursive: true });
    if (FILE_SYMLINKS) {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'data', 'unsafe'), 'file');
      refused([entries[0], { path: 'data/unsafe' }]);
      assert.equal(calls.some((args) => args.includes('hash-object')), false, 'a symlink leaf must not be followed for hashing');
      rmSync(join(root, 'data', 'unsafe'));
    } else {
      t.diagnostic('file-symlink refusal branch unavailable: Windows requires Developer Mode or administrator rights');
    }
    malformed = true;
    refused(entries);
    assert.equal(calls.filter((args) => args.includes('hash-object')).length, 1, 'one malformed successful hash reply must be refused');
  } finally {
    wrapped.mock.restore();
    syncBuiltinESMExports();
  }
});

test('recordIndexModes bounds Git arguments and preserves conflicting index entries', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'factory-index-conflict-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repository');
  repository(root, ADOPTER_URL);
  git(root, 'config', 'core.fileMode', 'false');
  put(root, 'parent/child.txt', 'indexed child\n');
  git(root, 'add', '--', 'parent/child.txt');
  rmSync(join(root, 'parent'), { recursive: true });
  put(root, 'parent', 'regular parent\n');
  const indexBefore = readFileSync(join(root, '.git', 'index'));
  const diskBefore = snapshot(root);

  assert.throws(() => recordIndexModes(root, [{ path: 'parent', executable: true }]), /cannot record parent as executable/);

  assert.deepEqual(readFileSync(join(root, '.git', 'index')), indexBefore, 'native parent/child conflict must preserve the actual index bytes');
  assert.equal(git(root, 'show', ':parent/child.txt'), 'indexed child');
  assert.deepEqual(snapshot(root), diskBefore);

  const syntheticRoot = join(tmpdir(), 'factory index bounded synthetic');
  const entries = Array.from({ length: 100 }, (_, i) => ({
    path: `${Array.from({ length: 5 }, (_, n) => `section ${n} ${'x'.repeat(120)}`).join('/')}/file ${i} ${'é'.repeat(160)}.txt`,
    executable: i < 50,
  }));
  const leaves = new Set(entries.map(({ path }) => join(syntheticRoot, path)));
  const calls = [];
  const nativeLstat = fileSystem.lstatSync;
  const nativeSpawn = childProcess.spawnSync;
  const statMock = t.mock.method(fileSystem, 'lstatSync', (full, ...args) => {
    if (leaves.has(full)) return { isFile: () => true };
    if (typeof full === 'string' && full.startsWith(syntheticRoot)) {
      return { isDirectory: () => true, isSymbolicLink: () => false };
    }
    return nativeLstat(full, ...args);
  });
  const spawnMock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command !== 'git') return nativeSpawn(command, args, options);
    if (args.includes('--local-env-vars')) return { status: 0, stdout: 'GIT_DIR\nGIT_WORK_TREE\nGIT_INDEX_FILE\n', stderr: '' };
    assert.equal(args[1], syntheticRoot);
    assert.notEqual(options.windowsVerbatimArguments, true);
    assert.equal(options.argv0, undefined);
    calls.push([command, ...args]);
    if (args.includes('config')) return { status: 0, stdout: 'false\n', stderr: '' };
    if (args.includes('hash-object')) {
      const paths = args.slice(args.indexOf('--') + 1);
      return { status: 0, stdout: paths.map(() => 'a'.repeat(40)).join('\n') + '\n', stderr: '' };
    }
    assert.ok(args.includes('update-index'), 'only index-recording commands are expected');
    return { status: 0, stdout: '', stderr: '' };
  });
  // Actual libuv Windows quoting, rather than the writer's conservative upper bound:
  // https://github.com/libuv/libuv/blob/v1.x/src/win/process.c#L422-L487
  const quoted = (argument) => {
    if (argument === '') return '""';
    if (!/[ \t"]/.test(argument)) return argument;
    const escaped = argument.replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}\\"`);
    return `"${escaped.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
  };
  const commandLength = (argv) => argv.map(quoted).join(' ').length + 1;
  syncBuiltinESMExports();
  try {
    recordIndexModes(syntheticRoot, entries);
    const hashes = calls.filter((argv) => argv.includes('hash-object'));
    const indexes = calls.filter((argv) => argv.includes('update-index'));
    assert.ok(hashes.length > 1 && indexes.length > 1, 'long paths must require multiple native batches');
    for (const argv of calls) assert.ok(commandLength(argv) <= 30000, 'actual quoted whole command must fit the fixed UTF-16 budget');
    const hashedPaths = hashes.flatMap((argv) => argv.slice(argv.indexOf('--') + 1));
    assert.deepEqual(hashedPaths.sort(), entries.map(({ path }) => path).sort(), 'each handwritten path must be hashed exactly once');
    const indexedPaths = [];
    const expectedModes = new Map(entries.map(({ path, executable }) => [path, executable ? '100755' : '100644']));
    for (const argv of indexes) {
      const units = argv.slice(argv.indexOf('update-index') + 2);
      assert.equal(units.length % 2, 0, 'cacheinfo option and record must stay together');
      for (let i = 0; i < units.length; i += 2) {
        assert.equal(units[i], '--cacheinfo');
        const match = units[i + 1].match(/^(100644|100755),([a-f0-9]{40}),(.+)$/);
        assert.ok(match, 'native comma-delimited cacheinfo record required');
        assert.equal(match[1], expectedModes.get(match[3]));
        assert.equal(match[2], 'a'.repeat(40));
        indexedPaths.push(match[3]);
      }
    }
    assert.deepEqual(indexedPaths.sort(), entries.map(({ path }) => path).sort(), 'each handwritten path must be indexed exactly once');
    const firstIndex = calls.findIndex((argv) => argv.includes('update-index'));
    assert.equal(calls.slice(firstIndex).some((argv) => argv.includes('hash-object')), false, 'all hashing must precede any index mutation');
    t.diagnostic(`Synthetic hash batches=${hashes.length}, index batches=${indexes.length}, maximum quoted UTF-16 units=${Math.max(...calls.map(commandLength))}`);

    const overlong = 'x'.repeat(31000);
    leaves.add(join(syntheticRoot, overlong));
    assert.ok(commandLength(['git', '-C', syntheticRoot, 'hash-object', '-w', '--', overlong]) > 30000);
    calls.length = 0;
    assert.throws(() => recordIndexModes(syntheticRoot, [{ path: overlong }]), /cannot record/);
    assert.equal(calls.some((argv) => argv.includes('hash-object') || argv.includes('update-index')), false, 'an indivisible overlong command must refuse before hashing or staging');
  } finally {
    statMock.mock.restore();
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }

});

test('--from, --check or an unknown flag prints the usage for --write and --render and exits 2', (t) => {
  const root = staleRepository(t, CANONICAL_URL);
  for (const args of [['--from', root], ['--check'], ['--into', root], ['--bogus']]) {
    const run = runCli(root, ...args);
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(run.stderr.trim(), 'usage: node scripts/factory-sync.mjs --write | --render', args.join(' '));
  }
});
