// factory-sync.test.mjs — tests for the factory manifest reader, its drift verification, the sync into an
// adopter, the render of an adopter's seat settings, the lag check against the canonical main, and the CLI.
// Run: node --test scripts/lib/factory-sync.test.mjs   (or `npm run test:scripts`)
//
// Price tag: every tree is a real temporary directory; sync tests copy one privately built pair of small git
// repositories into independent directories, and the CLI tests spawn git and node a handful of times. No network:
// the sync tests inject the source's fetch of origin main, proven on its own against a local bare origin; the two --from wire tests
// run one with GIT_ALLOW_PROTOCOL=file, so its fetch fails, and one with GIT_SSH_COMMAND serving the source from its
// own repository, so its fetch succeeds; and the --check wire tests put a fake gh first on the PATH. Retire this file
// with scripts/lib/factory-sync.mjs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fileSystem, {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLag, checkManifestPath, computeEntries, fetchMain, readManifest, recordIndexModes, renderSettings, syncInto, verifyManifest } from './factory-sync.mjs';
import { gitExecutable } from './posix-shell.mjs';
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
// Computed by `printf 'hello\r\n' | shasum -a 256`: the same line as a checkout with CRLF line endings holds it.
const HELLO_CRLF_SHA256 = 'cd2eca3535741f27a8ae40c31b0c41d4057a7a7b912b33b9aed86485d1c84676';
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

test('a manifest with no adopters list is read and one whose adopters list is malformed is refused by name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.agents'));
  const manifest = join(root, '.agents', 'factory-manifest.json');
  const base = { canonical: 'example-owner/example-repo', entries: [] };
  writeFileSync(manifest, JSON.stringify(base));
  assert.equal(readManifest(root).adopters, undefined);
  writeFileSync(manifest, JSON.stringify({ ...base, adopters: [] }));
  assert.deepEqual(readManifest(root).adopters, []);
  for (const adopters of [null, 'example-owner/adopter', ['no-slash'], [42], {}]) {
    writeFileSync(manifest, JSON.stringify({ ...base, adopters }));
    assert.throws(
      () => readManifest(root),
      /malformed \.agents\/factory-manifest\.json: it must hold canonical "owner\/repo" and entries/,
      JSON.stringify(adopters),
    );
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
const GREPTILE_PATHS = [GREPTILE_SKILL, GREPTILE_SKILL_COPY, GREPTILE_CONFIG];
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
      adopters: ['example-owner/adopter'],
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

test('--write refuses a canonical manifest that holds no adopters list and leaves it untouched', (t) => {
  const root = staleRepository(t, 'https://github.com/example-owner/example-repo.git');
  writeFileSync(
    join(root, MANIFEST),
    JSON.stringify({ canonical: 'example-owner/example-repo', entries: [{ path: 'docs/a.txt', sha256: ZERO_SHA256 }] }),
  );
  const before = manifestBytes(root);
  const run = runCli(root, '--write');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^factory-sync: refusing to --write: \.agents\/factory-manifest\.json holds no adopters list/);
  assert.equal(manifestBytes(root), before, 'a refused --write must leave the manifest untouched');
});

const CANONICAL = 'example-owner/example-repo';
const CANONICAL_URL = `https://github.com/${CANONICAL}`;
const ADOPTER_URL = 'https://github.com/example-owner/adopter';
const MANIFEST = '.agents/factory-manifest.json';
const GIT_ISOLATION = ['-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
let syncFixtureSeed;

function git(root, ...args) {
  const seed = syncFixtureSeed !== undefined && (root === join(syncFixtureSeed, 'source') || root === join(syncFixtureSeed, 'target'));
  const run = spawnSync('git', ['-C', root, ...GIT_ISOLATION, ...(seed ? ['-c', 'maintenance.auto=false'] : []), ...args], { encoding: 'utf8' });
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

const SOURCE_ENTRIES = [
  { path: 'AGENTS.md', region: 'factory-shared', sha256: ZERO_SHA256 },
  { path: 'docs/a.txt', sha256: ZERO_SHA256 },
  { path: 'scripts/run.sh', sha256: ZERO_SHA256 },
];

// Records the source's manifest from disk over the given entries, then commits the whole source.
function recordSource(source, entries) {
  writeManifest(source, computeEntries(source, { entries }));
  commitAll(source);
}

// The private baseline: a canonical source on main with a region, a plain file and an executable file; an adopter
// target whose committed manifest names the canonical, whose shared file is a symlink to a file outside it, and whose
// script is not yet executable; and that outside directory.
function createSyncFixture(base) {
  const [source, target, outside] = ['source', 'target', 'outside'].map((name) => join(base, name));
  put(outside, 'secret.txt', 'outside\n');

  repository(source, CANONICAL_URL);
  put(source, 'AGENTS.md', `# Canonical manual\n${START}\nshared v2\n${END}\n## Canonical rules\n`);
  put(source, 'docs/a.txt', 'hello v2\n');
  put(source, 'scripts/run.sh', '#!/bin/sh\necho v2\n', 0o755);
  // The index carries the executable bit where the checkout ignores file modes, as on Windows.
  git(source, 'update-index', '--add', '--chmod=+x', 'scripts/run.sh');
  recordSource(source, SOURCE_ENTRIES);

  repository(target, ADOPTER_URL);
  put(target, 'AGENTS.md', `# Adopter manual\n${START}\nshared v1\n${END}\n## Adopter rules\n`);
  // Where file symlinks are refused the shared file starts as a regular file, so the "was a symlink" half of the
  // first sync test is exercised only where file symlinks exist.
  if (FILE_SYMLINKS) link(target, 'docs/a.txt', '../../outside/secret.txt');
  else put(target, 'docs/a.txt', 'outside\n');
  put(target, 'scripts/run.sh', '#!/bin/sh\necho v1\n');
  put(target, MANIFEST, JSON.stringify({ canonical: CANONICAL, entries: [] }));
  commitAll(target);
}

after(() => {
  if (syncFixtureSeed) rmSync(syncFixtureSeed, { recursive: true, force: true });
});

function syncFixture(t) {
  if (!syncFixtureSeed) {
    syncFixtureSeed = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-seed-')));
    createSyncFixture(syncFixtureSeed);
  }
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-into-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  cpSync(syncFixtureSeed, base, { recursive: true, verbatimSymlinks: true });
  const [source, target, outside] = ['source', 'target', 'outside'].map((name) => join(base, name));
  const fetchMain = (root) => git(root, 'rev-parse', 'refs/heads/main');
  return { source, target, outside, sync: (options) => syncInto({ source, target, fetchMain, ...options }) };
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

test('sync fixtures isolate copied worktrees, Git state and outside paths', (t) => {
  const traceDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-trace-')));
  t.after(() => rmSync(traceDirectory, { recursive: true, force: true }));
  const tracePath = join(traceDirectory, 'events.jsonl');
  const a = withEnv({
    GIT_TRACE2_EVENT: tracePath,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'maintenance.autoDetach',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_PARAMETERS: '',
  }, () => syncFixture(t));
  let nativeTrace;
  try {
    nativeTrace = readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch {
    assert.fail('native Git trace must contain valid JSON records');
  }
  for (const name of ['source', 'target']) {
    const root = join(syncFixtureSeed, name);
    assert.ok(nativeTrace.some(({ event, argv }) => event === 'start'
      && argv[argv.indexOf('-C') + 1] === root && argv.includes('commit')),
    'native Git trace must include both seed commits');
  }
  assert.ok(!nativeTrace.some(({ event, argv }) => event === 'child_start'
    && argv.includes('maintenance') && argv.includes('run')),
  'seed construction must not launch automatic maintenance');
  const b = syncFixture(t);
  const assertBaseline = (fixture) => {
    assert.equal(readFileSync(join(fixture.source, 'docs/a.txt'), 'utf8'), 'hello v2\n');
    assert.equal(readFileSync(join(fixture.source, 'scripts/run.sh'), 'utf8'), '#!/bin/sh\necho v2\n');
    assert.equal(readFileSync(join(fixture.target, 'scripts/run.sh'), 'utf8'), '#!/bin/sh\necho v1\n');
    assert.equal(readFileSync(join(fixture.outside, 'secret.txt'), 'utf8'), 'outside\n');
    assert.equal(readFileSync(join(fixture.target, 'docs/a.txt'), 'utf8'), 'outside\n');
    if (FILE_SYMLINKS) {
      assert.ok(lstatSync(join(fixture.target, 'docs/a.txt')).isSymbolicLink());
      assert.equal(readlinkSync(join(fixture.target, 'docs/a.txt')).replaceAll('\\', '/'), '../../outside/secret.txt');
    } else {
      assert.ok(lstatSync(join(fixture.target, 'docs/a.txt')).isFile());
    }
    assert.equal(indexMode(fixture.source, 'scripts/run.sh'), '100755');
    assert.equal(indexMode(fixture.target, 'scripts/run.sh'), '100644');
    assert.equal(git(fixture.source, 'remote', 'get-url', 'origin'), 'https://github.com/example-owner/example-repo');
    assert.equal(git(fixture.target, 'remote', 'get-url', 'origin'), 'https://github.com/example-owner/adopter');
    assert.equal(git(fixture.source, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
    assert.equal(git(fixture.target, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  };
  const gitBytes = (root) => {
    const head = git(root, 'rev-parse', 'HEAD');
    const object = `objects/${head.slice(0, 2)}/${head.slice(2)}`;
    return Object.fromEntries(['HEAD', 'config', 'index', 'refs/heads/main', object]
      .map((path) => [path, readFileSync(join(root, '.git', path))]));
  };
  assertBaseline(b);
  const treesBefore = [snapshot(b.source), snapshot(b.target), snapshot(b.outside)];
  const gitBefore = [gitBytes(b.source), gitBytes(b.target)];

  if (FILE_SYMLINKS) {
    assert.ok(lstatSync(join(a.target, 'docs/a.txt')).isSymbolicLink());
    writeFileSync(join(a.target, 'docs/a.txt'), 'A-only outside\n');
    assert.equal(readFileSync(join(a.outside, 'secret.txt'), 'utf8'), 'A-only outside\n');
    assert.equal(readFileSync(join(b.outside, 'secret.txt'), 'utf8'), 'outside\n');
  } else {
    assert.ok(lstatSync(join(a.target, 'docs/a.txt')).isFile());
    assert.equal(readFileSync(join(a.target, 'docs/a.txt'), 'utf8'), 'outside\n');
    writeFileSync(join(a.target, 'docs/a.txt'), 'A-only shared file\n');
    assert.equal(readFileSync(join(a.outside, 'secret.txt'), 'utf8'), 'outside\n');
  }
  writeFileSync(join(a.source, 'docs/a.txt'), 'contaminated source\n');
  writeFileSync(join(a.source, 'scripts/run.sh'), 'contaminated source script\n');
  writeFileSync(join(a.target, 'scripts/run.sh'), 'contaminated target script\n');
  writeFileSync(join(a.target, 'AGENTS.md'), 'contaminated target manual\n');
  writeFileSync(join(a.outside, 'secret.txt'), 'contaminated outside\n');
  for (const root of [a.source, a.target]) {
    const head = git(root, 'rev-parse', 'HEAD');
    const object = join(root, '.git', 'objects', head.slice(0, 2), head.slice(2));
    chmodSync(object, 0o644);
    writeFileSync(object, 'corrupt object\n');
    for (const path of ['HEAD', 'config', 'index', 'refs/heads/main']) {
      writeFileSync(join(root, '.git', path), 'corrupt metadata\n');
    }
  }

  assert.deepEqual([snapshot(b.source), snapshot(b.target), snapshot(b.outside)], treesBefore);
  assert.deepEqual([gitBytes(b.source), gitBytes(b.target)], gitBefore);
  const c = syncFixture(t);
  assertBaseline(c);
  assert.deepEqual([snapshot(c.source), snapshot(c.target), snapshot(c.outside)], treesBefore);
  assert.deepEqual([gitBytes(c.source), gitBytes(c.target)], gitBefore);
  for (const root of [b.source, b.target, c.source, c.target]) {
    assert.equal(git(root, 'status', '--porcelain'), '', 'an independent copied repository must remain clean');
  }
});

function assertRefused(fixture, cause, options) {
  const before = [snapshot(fixture.target), snapshot(fixture.outside)];
  assert.throws(() => fixture.sync(options), cause);
  assert.deepEqual([snapshot(fixture.target), snapshot(fixture.outside)], before, 'a refused sync must write nothing');
}

// Commits the whole target with a manifest that lists entries, as the sync that last shared them recorded them.
function listInTarget(fixture, entries) {
  put(fixture.target, MANIFEST, JSON.stringify({ canonical: CANONICAL, entries }));
  commitAll(fixture.target);
}

for (const mark of ['skip-worktree', 'assume-unchanged']) {
  test(`ANTI-REGRESSION: a sync refuses ${mark === 'assume-unchanged' ? 'an' : 'a'} ${mark} installed path before writing anything`, (t) => {
    const fixture = syncFixture(t);
    const path = 'scripts/run.sh';
    assert.ok(lstatSync(join(fixture.target, path)).isFile(), 'the marked installed path must be a committed regular file');
    git(fixture.target, 'update-index', `--${mark}`, '--', path);
    put(fixture.target, path, 'local edit\n');
    assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the mark must hide the local edit from git status');
    assertRefused(fixture, (error) => {
      assert.equal(error.message, `${path}: the target's index marks it skip-worktree or assume-unchanged, which hides it from git status, so the sync cannot prove it clean; clear both marks with git update-index --no-skip-worktree -- ${path} and git update-index --no-assume-unchanged -- ${path}, commit or restore whatever git status then shows there, then sync`);
      return true;
    });
  });
}

test('ANTI-REGRESSION: a sync refuses a marked manifest before writing anything', (t) => {
  const fixture = syncFixture(t);
  const saved = readFileSync(join(fixture.target, MANIFEST), 'utf8');
  for (const mark of ['skip-worktree', 'assume-unchanged']) {
    git(fixture.target, 'update-index', `--${mark}`, '--', MANIFEST);
    put(fixture.target, MANIFEST, `${saved}local edit\n`);
    assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the mark must hide the corrupt working-tree manifest from git status');
    assertRefused(fixture, (error) => {
      assert.equal(error.message, `${MANIFEST}: the target's index marks it skip-worktree or assume-unchanged, which hides it from git status, so the sync cannot prove it clean; clear both marks with git update-index --no-skip-worktree -- ${MANIFEST} and git update-index --no-assume-unchanged -- ${MANIFEST}, commit or restore whatever git status then shows there, then sync`);
      return true;
    });
    put(fixture.target, MANIFEST, saved);
    git(fixture.target, 'update-index', `--no-${mark}`, '--', MANIFEST);
  }
});

test('a sync writes every shared file and region into the adopter and records the source commit', (t) => {
  const fixture = syncFixture(t);
  const at = (path) => join(fixture.target, path);
  const outsideBefore = snapshot(fixture.outside);

  assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: [], omitted: 0 });

  assert.equal(readFileSync(at('AGENTS.md'), 'utf8'), `# Adopter manual\n${START}\nshared v2\n${END}\n## Adopter rules\n`);
  assert.ok(lstatSync(at('docs/a.txt')).isFile(), 'a shared file that was a symlink must become a regular file');
  assert.equal(readFileSync(at('docs/a.txt'), 'utf8'), 'hello v2\n');
  if (process.platform === 'win32') assert.equal(indexMode(fixture.target, 'docs/a.txt'), '100644');
  else assert.equal(lstatSync(at('docs/a.txt')).mode & 0o777, 0o644);
  assert.equal(readFileSync(at('scripts/run.sh'), 'utf8'), '#!/bin/sh\necho v2\n');
  if (process.platform === 'win32') assert.equal(indexMode(fixture.target, 'scripts/run.sh'), '100755', 'the executable bit must follow the source');
  else assert.equal(lstatSync(at('scripts/run.sh')).mode & 0o777, 0o755, 'the executable bit must follow the source');
  assert.deepEqual(snapshot(fixture.outside), outsideBefore, 'the file the old symlink pointed at must be untouched');

  const { canonical, entries } = JSON.parse(readFileSync(join(fixture.source, MANIFEST), 'utf8'));
  const syncedFrom = git(fixture.source, 'rev-parse', 'HEAD');
  assert.equal(readFileSync(at(MANIFEST), 'utf8'), `${JSON.stringify({ canonical, syncedFrom, entries }, null, 2)}\n`);
  assert.deepEqual(verifyManifest(fixture.target), []);
});

test('ANTI-REGRESSION: a sync writes no adopters list into the adopter manifest and removes one an earlier sync left there', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, MANIFEST, JSON.stringify({ canonical: CANONICAL, adopters: ['example-owner/adopter', 'example-owner/private-adopter'], entries: [] }));
  commitAll(fixture.target);

  fixture.sync();

  const { canonical, adopters, entries } = JSON.parse(readFileSync(join(fixture.source, MANIFEST), 'utf8'));
  assert.deepEqual(adopters, ['example-owner/adopter'], 'the canonical manifest must hold a list for the sync to leave behind');
  const syncedFrom = git(fixture.source, 'rev-parse', 'HEAD');
  const text = readFileSync(join(fixture.target, MANIFEST), 'utf8');
  assert.equal(text, `${JSON.stringify({ canonical, syncedFrom, entries }, null, 2)}\n`);
  assert.equal('adopters' in JSON.parse(text), false);
});

// A sync fixture whose source also shares the given seat files, keyed by path.
function seatSyncFixture(t, seats) {
  const fixture = syncFixture(t);
  for (const [path, text] of Object.entries(seats)) put(fixture.source, path, text);
  recordSource(fixture.source, [...SOURCE_ENTRIES, ...Object.keys(seats).map((path) => ({ path, sha256: ZERO_SHA256 }))]);
  return fixture;
}

// Seat files as a canonical ships them; with a known model and effort each passes the agent check. The bytes a
// sync is expected to leave are written out by hand in each test, never built by these.
const ORACLE_MD = '.claude/agents/oracle.md';
const BUILDER_MD = '.claude/agents/builder.md';
const REVIEWER_TOML = '.codex/agents/reviewer.toml';
const claudeSeat = (name, model, effort, maxTurns) =>
  `---\nname: ${name}\ndescription: "Fixture ${name}"\nmodel: ${model}\neffort: ${effort}\nmaxTurns: ${maxTurns}\n---\nDo the work.\n`;
const codexSeat = (name, model, effort) =>
  `name = "${name}"\ndescription = "Fixture ${name}"\nmodel = "${model}"\nmodel_reasoning_effort = "${effort}"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo the work.\n"""\n`;

// runtimes left out writes a settings file with no such key.
const putSettings = (fixture, seats, runtimes) => put(fixture.target, SETTINGS, JSON.stringify({ version: 1, runtimes, seats }));

test('a sync applies the seat settings of the adopter to the fetched bytes and records the replaced defaults', (t) => {
  const fixture = seatSyncFixture(t, {
    [ORACLE_MD]: claudeSeat('oracle', 'fable', 'high', 90),
    [REVIEWER_TOML]: codexSeat('reviewer', 'gpt-6-luna', 'medium'),
  });
  const at = (path) => join(fixture.target, path);
  putSettings(fixture, { claude: { oracle: { model: 'opus', maxTurns: 60 } }, codex: { reviewer: { model_reasoning_effort: 'high' } } });
  const settingsBefore = readFileSync(at(SETTINGS), 'utf8');

  assert.deepEqual(fixture.sync(), { files: 4, regions: 1, removed: [], omitted: 0 });

  assert.equal(
    readFileSync(at(ORACLE_MD), 'utf8'),
    '---\nname: oracle\ndescription: "Fixture oracle"\nmodel: opus\neffort: high\nmaxTurns: 60\n---\nDo the work.\n',
  );
  assert.equal(
    readFileSync(at(REVIEWER_TOML), 'utf8'),
    'name = "reviewer"\ndescription = "Fixture reviewer"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo the work.\n"""\n',
  );
  assert.equal(readFileSync(at(SETTINGS), 'utf8'), settingsBefore, 'a sync must never write the settings file');

  const { canonical, entries } = JSON.parse(readFileSync(join(fixture.source, MANIFEST), 'utf8'));
  const syncedFrom = git(fixture.source, 'rev-parse', 'HEAD');
  const seatDefaults = { claude: { oracle: { model: 'fable', maxTurns: 90 } }, codex: { reviewer: { model_reasoning_effort: 'medium' } } };
  assert.equal(readFileSync(at(MANIFEST), 'utf8'), `${JSON.stringify({ canonical, syncedFrom, seatDefaults, entries }, null, 2)}\n`);
  assert.deepEqual(verifyManifest(fixture.target), []);
});

test('a retune in the canonical reaches a setting the adopter does not override and leaves the one it does', (t) => {
  const fixture = seatSyncFixture(t, { [BUILDER_MD]: claudeSeat('builder', 'sonnet', 'medium', 60) });
  const builder = () => readFileSync(join(fixture.target, BUILDER_MD), 'utf8');
  const recorded = () => JSON.parse(readFileSync(join(fixture.target, MANIFEST), 'utf8')).seatDefaults;
  putSettings(fixture, { claude: { builder: { effort: 'high' } } });

  fixture.sync();
  assert.equal(builder(), '---\nname: builder\ndescription: "Fixture builder"\nmodel: sonnet\neffort: high\nmaxTurns: 60\n---\nDo the work.\n');
  assert.deepEqual(recorded(), { claude: { builder: { effort: 'medium' } } });
  commitAll(fixture.target);

  put(fixture.source, BUILDER_MD, claudeSeat('builder', 'opus', 'low', 60));
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: BUILDER_MD, sha256: ZERO_SHA256 }]);
  fixture.sync();
  assert.equal(builder(), '---\nname: builder\ndescription: "Fixture builder"\nmodel: opus\neffort: high\nmaxTurns: 60\n---\nDo the work.\n');
  assert.deepEqual(recorded(), { claude: { builder: { effort: 'low' } } }, 'the recorded default must follow the retune');
  assert.deepEqual(verifyManifest(fixture.target), []);
});

// The sentence a refused value ends with, word for word as the head of seat-settings.mjs gives it.
const NAMED_AFTER_SYNC = /; a value only a newer copy of the shared workflow admits can be named after the sync that installs it$/;

test('a sync refuses seat settings it cannot apply and writes nothing', (t) => {
  const fixture = seatSyncFixture(t, {
    [ORACLE_MD]: claudeSeat('oracle', 'fable', 'high', 90),
    [BUILDER_MD]: claudeSeat('builder', 'sonnet', 'medium', 60),
    '.claude/agents/explorer.md': '---\nname: explorer\ndescription: "Fixture explorer"\nmodel: haiku\n---\nDo the work.\n',
    '.codex/agents/builder.toml': codexSeat('builder', 'gpt-6-luna', 'medium'),
    [REVIEWER_TOML]: codexSeat('reviewer', 'gpt-6-luna', 'medium'),
  });

  put(fixture.target, SETTINGS, '{');
  assertRefused(fixture, /^Error: \.agents\/factory-settings\.json: is not valid JSON/);

  for (const [name, seats, ...causes] of [
    [
      'a seat the fetched manifest does not share',
      { claude: { planner: { model: 'opus' } } },
      /^Error: \.agents\/factory-settings\.json names the seat \.claude\/agents\/planner\.md, which is not a file entry of the manifest/,
      /remove that seat from \.agents\/factory-settings\.json, run node scripts\/factory-sync\.mjs --render, commit, then sync$/,
    ],
    ['an unsafe value', { claude: { builder: { model: 'op us' } } }, /seats\.claude\.builder\.model: must be a string matching .*; found "op us"/],
    [
      'a setting the seat does not carry',
      { claude: { explorer: { effort: 'high' } } },
      /^Error: \.claude\/agents\/explorer\.md: setting effort is not carried exactly once/,
    ],
    [
      'a model the running check does not know',
      { codex: { reviewer: { model: 'example-newer-model' } } },
      /\.codex\/agents\/reviewer\.toml.*unknown model `example-newer-model`/,
      NAMED_AFTER_SYNC,
    ],
    [
      'the costliest Claude model on the builder',
      { claude: { builder: { model: 'fable' } } },
      /\.claude\/agents\/builder\.md.*the costliest Claude model may sit only on the oracle and security-reviewer seats/,
      NAMED_AFTER_SYNC,
    ],
    [
      'the costliest Codex model on the builder',
      { codex: { builder: { model: 'gpt-6-astra' } } },
      /\.codex\/agents\/builder\.toml.*the costliest Codex model may sit only on the architect, oracle and security-reviewer seats/,
      NAMED_AFTER_SYNC,
    ],
    [
      'a turn limit of 120 on the oracle',
      { claude: { oracle: { maxTurns: 120 } } },
      /\.claude\/agents\/oracle\.md.*the turn limit of this seat must be one line maxTurns: N with N a whole number from 1 to 90/,
      NAMED_AFTER_SYNC,
    ],
    ['inherit', { claude: { builder: { model: 'inherit' } } }, /seats\.claude\.builder\.model: inherit leaves the seat model to the session/],
  ]) {
    putSettings(fixture, seats);
    assertRefused(fixture, (error) => {
      for (const cause of causes) {
        assert.match(String(error), cause, name);
      }
      return true;
    });
  }
});

// example-newer-model is on no known list, and the seat policy refuses fable on the builder: each is what the
// canonical ships here, not what the settings file names.
test('a sync run by a copy that does not know a default the canonical now ships applies the override and judges only the values the settings file names', (t) => {
  const fixture = seatSyncFixture(t, {
    [BUILDER_MD]: claudeSeat('builder', 'fable', 'medium', 60),
    [REVIEWER_TOML]: codexSeat('reviewer', 'example-newer-model', 'medium'),
  });
  const at = (path) => join(fixture.target, path);
  putSettings(fixture, { claude: { builder: { effort: 'high' } }, codex: { reviewer: { model_reasoning_effort: 'high' } } });

  assert.deepEqual(fixture.sync(), { files: 4, regions: 1, removed: [], omitted: 0 });

  assert.equal(
    readFileSync(at(BUILDER_MD), 'utf8'),
    '---\nname: builder\ndescription: "Fixture builder"\nmodel: fable\neffort: high\nmaxTurns: 60\n---\nDo the work.\n',
  );
  assert.equal(
    readFileSync(at(REVIEWER_TOML), 'utf8'),
    'name = "reviewer"\ndescription = "Fixture reviewer"\nmodel = "example-newer-model"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo the work.\n"""\n',
  );
  assert.deepEqual(JSON.parse(readFileSync(at(MANIFEST), 'utf8')).seatDefaults, {
    claude: { builder: { effort: 'medium' } },
    codex: { reviewer: { model_reasoning_effort: 'medium' } },
  });
});

// The two seats the canonical ships in the left-out runtime tests, and the bytes of each written out by hand.
const ORACLE_SHIPPED = '---\nname: oracle\ndescription: "Fixture oracle"\nmodel: fable\neffort: high\nmaxTurns: 90\n---\nDo the work.\n';
const REVIEWER_SHIPPED =
  'name = "reviewer"\ndescription = "Fixture reviewer"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo the work.\n"""\n';
const bothRuntimesFixture = (t) =>
  seatSyncFixture(t, { [ORACLE_MD]: claudeSeat('oracle', 'fable', 'high', 90), [REVIEWER_TOML]: codexSeat('reviewer', 'gpt-6-luna', 'medium') });

// The manifest text a sync must leave in the target: every entry of the source's, those at `paths` among them.
function recordedManifest(fixture, paths) {
  const { canonical, entries } = JSON.parse(readFileSync(join(fixture.source, MANIFEST), 'utf8'));
  assert.deepEqual(entries.map(({ path }) => path), ['AGENTS.md', 'docs/a.txt', 'scripts/run.sh', ...paths]);
  return `${JSON.stringify({ canonical, syncedFrom: git(fixture.source, 'rev-parse', 'HEAD'), entries }, null, 2)}\n`;
}

test('a sync into a target that names one runtime writes only that runtime\'s files, records every entry, and verifies clean', (t) => {
  for (const [runtime, written, shipped, leftOut] of [
    ['claude', ORACLE_MD, ORACLE_SHIPPED, REVIEWER_TOML],
    ['codex', REVIEWER_TOML, REVIEWER_SHIPPED, ORACLE_MD],
  ]) {
    const fixture = bothRuntimesFixture(t);
    const at = (path) => join(fixture.target, path);
    putSettings(fixture, {}, [runtime]);

    assert.deepEqual(fixture.sync(), { files: 3, regions: 1, removed: [], omitted: 1 }, runtime);

    assert.equal(readFileSync(at(written), 'utf8'), shipped, runtime);
    assert.equal(readFileSync(at('docs/a.txt'), 'utf8'), 'hello v2\n', runtime);
    assert.equal(existsSync(at(leftOut)), false, `${leftOut} belongs to a runtime the target does not name`);
    assert.equal(readFileSync(at(MANIFEST), 'utf8'), recordedManifest(fixture, [ORACLE_MD, REVIEWER_TOML]), runtime);
    assert.deepEqual(verifyManifest(fixture.target), [], runtime);
  }
});

// A sync fixture whose source also shares the Greptile add-on's three files.
const greptileFixture = (t) => seatSyncFixture(t, Object.fromEntries(GREPTILE_FILES.map(([path, text]) => [path, text])));

test('a sync into a target that does not turn the Greptile add-on on writes none of its files, records every entry, and verifies clean', (t) => {
  for (const [name, settings] of [
    ['no settings file', null],
    ['greptile false', GREPTILE_OFF],
  ]) {
    const fixture = greptileFixture(t);
    const at = (path) => join(fixture.target, path);
    if (settings !== null) put(fixture.target, SETTINGS, JSON.stringify(settings));

    assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: [], omitted: 3 }, name);

    assert.equal(readFileSync(at('docs/a.txt'), 'utf8'), 'hello v2\n', name);
    for (const path of GREPTILE_PATHS) assert.equal(existsSync(at(path)), false, `${name}: ${path} belongs to an add-on the target does not turn on`);
    assert.equal(readFileSync(at(MANIFEST), 'utf8'), recordedManifest(fixture, GREPTILE_PATHS), name);
    assert.deepEqual(verifyManifest(fixture.target), [], name);
  }

  const fixture = greptileFixture(t);
  const at = (path) => join(fixture.target, path);
  put(fixture.target, SETTINGS, JSON.stringify(GREPTILE_ON));

  assert.deepEqual(fixture.sync(), { files: 5, regions: 1, removed: [], omitted: 0 });

  for (const [path, text] of GREPTILE_FILES) assert.equal(readFileSync(at(path), 'utf8'), text, path);
  assert.equal(readFileSync(at(MANIFEST), 'utf8'), recordedManifest(fixture, GREPTILE_PATHS));
  assert.deepEqual(verifyManifest(fixture.target), []);
});

// A sync fixture whose source also shares the documentation sweep's six files.
const sweepFixture = (t) => seatSyncFixture(t, Object.fromEntries(SWEEP_PATHS.map((path) => [path, 'hello\n'])));

test('a sync into a target that turns the documentation sweep off writes none of its files, records every entry, and verifies clean', (t) => {
  const off = sweepFixture(t);
  const atOff = (path) => join(off.target, path);
  put(off.target, SETTINGS, JSON.stringify(SWEEP_OFF));

  assert.deepEqual(off.sync(), { files: 2, regions: 1, removed: [], omitted: 6 });

  assert.equal(readFileSync(atOff('docs/a.txt'), 'utf8'), 'hello v2\n');
  for (const path of SWEEP_PATHS) assert.equal(existsSync(atOff(path)), false, `${path} belongs to the sweep the target turns off`);
  assert.equal(readFileSync(atOff(MANIFEST), 'utf8'), recordedManifest(off, SWEEP_PATHS));
  assert.deepEqual(verifyManifest(off.target), []);

  const fixture = sweepFixture(t);
  const at = (path) => join(fixture.target, path);

  assert.deepEqual(fixture.sync(), { files: 8, regions: 1, removed: [], omitted: 0 }, 'no settings file');

  for (const path of SWEEP_PATHS) assert.equal(readFileSync(at(path), 'utf8'), 'hello\n', path);
  assert.equal(readFileSync(at(MANIFEST), 'utf8'), recordedManifest(fixture, SWEEP_PATHS));
  assert.deepEqual(verifyManifest(fixture.target), []);
});

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
      NAMED_AFTER_SYNC,
    ],
    [
      'a setting the seat does not carry',
      { claude: { explorer: { effort: 'high' } } },
      /^Error: \.claude\/agents\/explorer\.md: setting effort is not carried exactly once/,
    ],
    [
      'the costliest Claude model on the builder',
      { claude: { builder: { model: 'fable' } } },
      /\.claude\/agents\/builder\.md.*the costliest Claude model may sit only on the oracle and security-reviewer seats/,
      NAMED_AFTER_SYNC,
    ],
    [
      'a turn limit of 120 on the oracle',
      { claude: { oracle: { maxTurns: 120 } } },
      /\.claude\/agents\/oracle\.md.*the turn limit of this seat must be one line maxTurns: N with N a whole number from 1 to 90/,
      NAMED_AFTER_SYNC,
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

test('render after a sync that applied no settings applies them and keeps the recorded source commit', (t) => {
  const fixture = seatSyncFixture(t, { [BUILDER_MD]: claudeSeat('builder', 'sonnet', 'medium', 60) });
  fixture.sync();
  commitAll(fixture.target);
  putSettings(fixture, { claude: { builder: { effort: 'high' } } });
  assert.deepEqual(
    verifyManifest(fixture.target).map(({ path, actual }) => [path, actual]),
    [[BUILDER_MD, NOT_RENDERED]],
  );

  assert.deepEqual(renderSettings(fixture.target), { seats: [BUILDER_MD], manifest: true });

  assert.equal(
    readFileSync(join(fixture.target, BUILDER_MD), 'utf8'),
    '---\nname: builder\ndescription: "Fixture builder"\nmodel: sonnet\neffort: high\nmaxTurns: 60\n---\nDo the work.\n',
  );
  const { canonical, entries } = JSON.parse(readFileSync(join(fixture.source, MANIFEST), 'utf8'));
  const syncedFrom = git(fixture.source, 'rev-parse', 'HEAD');
  const seatDefaults = { claude: { builder: { effort: 'medium' } } };
  assert.equal(manifestBytes(fixture.target), `${JSON.stringify({ canonical, syncedFrom, seatDefaults, entries }, null, 2)}\n`);
  assert.deepEqual(verifyManifest(fixture.target), []);
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

test('a sync removes a file the target\'s previous manifest listed and the fetched one does not, reports it, and removes nothing else', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'retired.sh', 'hello\n', 0o755);
  put(fixture.target, 'own.sh', 'own\n', 0o755);
  listInTarget(fixture, [
    { path: 'retired.sh', sha256: HELLO_SHA256, executable: true },
    { path: 'gone.txt', sha256: HELLO_SHA256 },
  ]);
  const before = snapshot(fixture.target);

  assert.deepEqual(fixture.sync().removed, ['retired.sh']);

  const after = snapshot(fixture.target);
  assert.deepEqual(Object.keys(after), Object.keys(before).filter((path) => path !== 'retired.sh'));
  assert.equal(after['own.sh'], before['own.sh']);

  commitAll(fixture.target);
  assert.deepEqual(fixture.sync().removed, []);
  assert.deepEqual(snapshot(fixture.target), after);
});

// A line-ending attribute gives a path disk bytes that differ from HEAD's while git status is clean and the index
// carries no mark: the one state where only one of the two byte comparisons can refuse.
const CRLF_ON_DISK = 'retired.sh text eol=crlf\n';

test('a retired path whose bytes on disk are not the recorded ones, while HEAD holds the recorded ones, is refused by name, and nothing is removed', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, '.gitattributes', CRLF_ON_DISK);
  put(fixture.target, 'first.sh', 'hello\n');
  put(fixture.target, 'retired.sh', 'hello\r\n');
  listInTarget(fixture, [
    { path: 'first.sh', sha256: HELLO_SHA256 },
    { path: 'retired.sh', sha256: HELLO_SHA256 },
  ]);
  assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the line-ending difference must be invisible to git status');
  assert.equal(git(fixture.target, 'rev-parse', 'HEAD:retired.sh'), git(fixture.target, 'rev-parse', 'HEAD:first.sh'), 'HEAD must hold the recorded bytes');
  assertRefused(fixture, /retired\.sh: the manifest no longer shares it, .*but this is a file with other bytes/);
});

test('a retired path under a parent symlinked outside the target is refused, and the file outside is not removed', (t) => {
  const fixture = syncFixture(t);
  put(fixture.outside, 'hello.txt', 'hello\n');
  link(fixture.target, 'gone', '../outside');
  listInTarget(fixture, [{ path: 'gone/hello.txt', sha256: HELLO_SHA256 }]);
  assertRefused(fixture, /gone\/hello\.txt: its parent .*[\\/]gone is a symlink/);
});

test('a retired path with a change staged but not committed is refused as uncommitted', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'retired.sh', 'hello\n');
  listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_SHA256 }]);
  put(fixture.target, 'retired.sh', 'edited\n');
  git(fixture.target, 'add', 'retired.sh');
  put(fixture.target, 'retired.sh', 'hello\n');
  assertRefused(fixture, /the target has uncommitted changes at shared paths: .*retired\.sh/);
});

test('a target whose committed manifest lists a path that climbs out of the tree is refused, and nothing outside it is removed', (t) => {
  const fixture = syncFixture(t);
  put(fixture.outside, 'hello.txt', 'hello\n');
  listInTarget(fixture, [{ path: '../outside/hello.txt', sha256: HELLO_SHA256 }]);
  assertRefused(fixture, /invalid manifest path "\.\.\/outside\/hello\.txt"/);
});

test('a region the fetched manifest no longer shares is refused by name, and the adopter\'s file is left whole', (t) => {
  const fixture = syncFixture(t);
  recordSource(fixture.source, SOURCE_ENTRIES.filter((entry) => !('region' in entry)));
  put(fixture.target, 'AGENTS.md', `# Adopter manual\n${START}\nx\ny\n${END}\n## Adopter rules\n`);
  listInTarget(fixture, [{ path: 'AGENTS.md', region: 'factory-shared', sha256: REGION_SHA256 }]);
  assertRefused(fixture, /AGENTS\.md: the manifest no longer shares this file's factory-shared region/);
});

test('a retired path holding the recorded bytes in a file that is ignored and was never committed is refused, and the file stays', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, '.gitignore', 'retired.sh\n');
  listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_SHA256 }]);
  put(fixture.target, 'retired.sh', 'hello\n');
  assert.equal(git(fixture.target, 'status', '--porcelain', '--untracked-files=all'), '', 'the ignored file must be hidden from git status');
  assertRefused(fixture, /retired\.sh: the manifest no longer shares it, .*HEAD does not hold those bytes as a regular file/);
});

test('a retired path holding the recorded bytes while HEAD holds other bytes is refused, and the file stays', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, '.gitattributes', CRLF_ON_DISK);
  put(fixture.target, 'retired.sh', 'hello\r\n');
  listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_CRLF_SHA256 }]);
  assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the difference from HEAD must be invisible to git status');
  assertRefused(fixture, /retired\.sh: the manifest no longer shares it, .*HEAD does not hold those bytes as a regular file/);
});

for (const [mark, state, gone] of [
  ['skip-worktree', 'its file gone from the disk', true],
  ['assume-unchanged', 'its file intact', false],
]) {
  test(`a retired path whose index entry is marked ${mark}, ${state}, is refused by name, and nothing is written or removed`, (t) => {
    const fixture = syncFixture(t);
    put(fixture.target, 'retired.sh', 'hello\n');
    listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_SHA256 }]);
    git(fixture.target, 'update-index', `--${mark}`, 'retired.sh');
    if (gone) rmSync(join(fixture.target, 'retired.sh'));
    assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the mark must keep the path out of git status');
    assertRefused(fixture, /retired\.sh: the manifest no longer shares it, but the target's index marks it skip-worktree or assume-unchanged/);
  });
}

test('a retired path whose committed object cannot be read is refused by name, and the file stays', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'retired.sh', 'hello\n');
  listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_SHA256 }]);
  const object = git(fixture.target, 'rev-parse', 'HEAD:retired.sh');
  rmSync(join(fixture.target, '.git', 'objects', object.slice(0, 2), object.slice(2)));
  assertRefused(fixture, /^Error: retired\.sh: the manifest no longer shares it, but the sync cannot read the object /);
});

test('a retired path that differs only in letter case from a path the fetched manifest shares is refused by name, and nothing is removed', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'agents.md', 'hello\n');
  listInTarget(fixture, [{ path: 'agents.md', sha256: HELLO_SHA256 }]);
  assertRefused(fixture, /agents\.md: the manifest no longer shares it but now shares AGENTS\.md/);
});

// The canonical retunes the reviewer between the two syncs, so the bytes the target holds are the ones its own
// committed manifest recorded and not the ones the fetched manifest records.
test('a sync after a target stops naming a runtime removes that runtime\'s files that hold the recorded bytes, and nothing else', (t) => {
  const fixture = bothRuntimesFixture(t);
  assert.deepEqual(fixture.sync(), { files: 4, regions: 1, removed: [], omitted: 0 });
  put(fixture.target, '.codex/own.toml', 'own\n');
  putSettings(fixture, {}, ['claude']);
  commitAll(fixture.target);
  put(fixture.source, REVIEWER_TOML, codexSeat('reviewer', 'gpt-6-luna', 'high'));
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: ORACLE_MD, sha256: ZERO_SHA256 }, { path: REVIEWER_TOML, sha256: ZERO_SHA256 }]);
  const before = snapshot(fixture.target);
  // snapshot keys its paths with the platform's separator.
  const [removed, manifest] = [join(REVIEWER_TOML), join(MANIFEST)];

  assert.deepEqual(fixture.sync(), { files: 3, regions: 1, removed: [REVIEWER_TOML], omitted: 1 });

  const after = snapshot(fixture.target);
  assert.deepEqual(Object.keys(after), Object.keys(before).filter((path) => path !== removed));
  for (const path of Object.keys(after)) if (path !== manifest) assert.equal(after[path], before[path], path);
  assert.equal(JSON.parse(readFileSync(join(fixture.target, MANIFEST), 'utf8')).entries.length, 5, 'the record must keep every entry');
  assert.deepEqual(verifyManifest(fixture.target), []);

  commitAll(fixture.target);
  assert.deepEqual(fixture.sync(), { files: 3, regions: 1, removed: [], omitted: 1 });
  assert.deepEqual(snapshot(fixture.target), after);
});

// The canonical changes the reviewer's configuration between the two syncs, so the bytes the target holds are the ones
// its own committed manifest recorded and not the ones the fetched manifest records.
test('a sync after a target turns the Greptile add-on off removes its files that hold the recorded bytes, and nothing else', (t) => {
  const fixture = greptileFixture(t);
  put(fixture.target, SETTINGS, JSON.stringify(GREPTILE_ON));
  assert.deepEqual(fixture.sync(), { files: 5, regions: 1, removed: [], omitted: 0 });
  put(fixture.target, '.greptile/own.json', 'own\n');
  put(fixture.target, SETTINGS, JSON.stringify(GREPTILE_OFF));
  commitAll(fixture.target);
  put(fixture.source, GREPTILE_CONFIG, '{"skipReview":"NEVER"}\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, ...GREPTILE_PATHS.map((path) => ({ path, sha256: ZERO_SHA256 }))]);
  const before = snapshot(fixture.target);
  // snapshot keys its paths with the platform's separator.
  const removed = GREPTILE_PATHS.map((path) => join(path));
  const manifest = join(MANIFEST);

  assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: GREPTILE_PATHS, omitted: 3 });

  const after = snapshot(fixture.target);
  assert.deepEqual(Object.keys(after), Object.keys(before).filter((path) => !removed.includes(path)));
  for (const path of Object.keys(after)) if (path !== manifest) assert.equal(after[path], before[path], path);
  assert.equal(JSON.parse(readFileSync(join(fixture.target, MANIFEST), 'utf8')).entries.length, 6, 'the record must keep every entry');
  assert.deepEqual(verifyManifest(fixture.target), []);

  commitAll(fixture.target);
  assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: [], omitted: 3 });
  assert.deepEqual(snapshot(fixture.target), after);
});

test('a sync after a target turns the documentation sweep off removes its files that hold the recorded bytes, and nothing else', (t) => {
  const fixture = sweepFixture(t);
  assert.deepEqual(fixture.sync(), { files: 8, regions: 1, removed: [], omitted: 0 });
  put(fixture.target, 'scripts/lib/own.mjs', 'own\n');
  put(fixture.target, SETTINGS, JSON.stringify(SWEEP_OFF));
  commitAll(fixture.target);
  put(fixture.source, SWEEP_PATHS[3], 'hello v2\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, ...SWEEP_PATHS.map((path) => ({ path, sha256: ZERO_SHA256 }))]);
  const before = snapshot(fixture.target);
  // snapshot keys its paths with the platform's separator.
  const removed = SWEEP_PATHS.map((path) => join(path));
  const manifest = join(MANIFEST);

  assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: SWEEP_PATHS, omitted: 6 });

  const after = snapshot(fixture.target);
  assert.deepEqual(Object.keys(after), Object.keys(before).filter((path) => !removed.includes(path)));
  for (const path of Object.keys(after)) if (path !== manifest) assert.equal(after[path], before[path], path);
  assert.equal(JSON.parse(readFileSync(join(fixture.target, MANIFEST), 'utf8')).entries.length, 9, 'the record must keep every entry');
  assert.deepEqual(verifyManifest(fixture.target), []);

  commitAll(fixture.target);
  assert.deepEqual(fixture.sync(), { files: 2, regions: 1, removed: [], omitted: 6 });
  assert.deepEqual(snapshot(fixture.target), after);
});

test('a file of a left-out runtime that holds other bytes is refused by name, and nothing is written or removed', (t) => {
  for (const listed of [true, false]) {
    const fixture = bothRuntimesFixture(t);
    if (listed) fixture.sync();
    put(fixture.target, REVIEWER_TOML, codexSeat('reviewer', 'gpt-6-luna', 'high'));
    putSettings(fixture, {}, ['claude']);
    commitAll(fixture.target);
    assertRefused(fixture, (error) => {
      assert.match(
        String(error),
        /^Error: \.codex\/agents\/reviewer\.toml: the settings file names no codex runtime, and the sync removes only the exact bytes it last recorded there, but this is a file with other bytes; /,
        listed ? 'the previous manifest lists the path' : 'the previous manifest does not list the path',
      );
      return true;
    });
  }
});

test('a target whose committed manifest cannot be read is refused by name, never synced as a first sync', (t) => {
  const fixture = syncFixture(t);
  const object = git(fixture.target, 'rev-parse', `HEAD:${MANIFEST}`);
  rmSync(join(fixture.target, '.git', 'objects', object.slice(0, 2), object.slice(2)));
  assertRefused(fixture, /cannot read the target's \.agents\/factory-manifest\.json at HEAD/, { canonical: CANONICAL });
});

test('a target with no commit is refused by name, never synced as a first sync', (t) => {
  const fixture = syncFixture(t);
  // With no region to write, a sync that took the failed listing for a first sync would complete and write.
  recordSource(fixture.source, SOURCE_ENTRIES.filter((entry) => !('region' in entry)));
  rmSync(fixture.target, { recursive: true, force: true });
  repository(fixture.target, ADOPTER_URL);
  assertRefused(fixture, /cannot list \.agents\/factory-manifest\.json in the target's HEAD, .*a target with no commit needs one first/, { canonical: CANONICAL });
});

test('a manifest entry that climbs out of the tree is refused', (t) => {
  const fixture = syncFixture(t);
  writeManifest(fixture.source, [...computeEntries(fixture.source, { entries: SOURCE_ENTRIES }), { path: '../x', sha256: HELLO_SHA256 }]);
  commitAll(fixture.source);
  assertRefused(fixture, /invalid manifest path "\.\.\/x"/);
});

test('an entry whose parent in the target is a symlink to a directory outside it is refused', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, 'evil/x.txt', 'x\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: 'evil/x.txt', sha256: ZERO_SHA256 }]);
  link(fixture.target, 'evil', '../outside');
  commitAll(fixture.target);
  assertRefused(fixture, /evil\/x\.txt: .*outside the target/);
});

test('a file entry whose parent in the target is a symlink to a directory inside it is refused', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, 'alias/x.txt', 'x\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: 'alias/x.txt', sha256: ZERO_SHA256 }]);
  link(fixture.target, 'alias', 'docs');
  commitAll(fixture.target);
  assertRefused(fixture, /alias\/x\.txt: its parent .*[\\/]alias is a symlink/);
  assert.equal(lstatSync(join(fixture.target, 'docs', 'x.txt'), { throwIfNoEntry: false }), undefined, 'nothing may land at the symlink destination');
});

// An adopter that still commits a former shared symlink is told how to migrate off it.
test('a file entry under a symlinked directory in the target is refused, naming the git rm that clears it', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, '.claude/skills/x/SKILL.md', 'skill\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: '.claude/skills/x/SKILL.md', sha256: ZERO_SHA256 }]);
  put(fixture.target, '.agents/skills/x/SKILL.md', 'skill\n');
  link(fixture.target, '.claude/skills/x', '../../.agents/skills/x');
  commitAll(fixture.target);
  assertRefused(
    fixture,
    /\.claude\/skills\/x\/SKILL\.md: its parent .*[\\/]\.claude[\\/]skills[\\/]x is a symlink, .*remove it first: git rm \.claude\/skills\/x, commit, then sync$/,
  );
});

test('a file entry whose parent is a regular file in the target is refused, naming the git rm that clears it', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, '.claude/skills/x/SKILL.md', 'skill\n');
  recordSource(fixture.source, [...SOURCE_ENTRIES, { path: '.claude/skills/x/SKILL.md', sha256: ZERO_SHA256 }]);
  put(fixture.target, '.agents/skills/x/SKILL.md', 'skill\n');
  put(fixture.target, '.claude/skills/x', '../../.agents/skills/x');
  commitAll(fixture.target);
  assertRefused(
    fixture,
    /\.claude\/skills\/x\/SKILL\.md: its parent .*[\\/]\.claude[\\/]skills[\\/]x is a file, not a directory, .*remove it first: git rm \.claude\/skills\/x, commit, then sync$/,
  );
});

test('a non-empty directory where a file entry goes is refused', (t) => {
  const fixture = syncFixture(t);
  rmSync(join(fixture.target, 'scripts', 'run.sh'));
  put(fixture.target, 'scripts/run.sh/kept.txt', 'kept\n');
  commitAll(fixture.target);
  assertRefused(fixture, /scripts\/run\.sh: .*non-empty directory/);
});

test('a source whose HEAD is not its freshly fetched origin main is refused', (t) => {
  const fixture = syncFixture(t);
  git(fixture.source, 'checkout', '-q', '-b', 'job/branch');
  git(fixture.source, 'commit', '-q', '--allow-empty', '-m', 'job work');
  assertRefused(fixture, /not on its freshly fetched origin main/);
});

test('a failed fetch of the source origin main is refused', (t) => {
  const fixture = syncFixture(t);
  const fetchMain = () => {
    throw new Error('could not resolve host');
  };
  assertRefused(fixture, /cannot fetch the source's origin main \(could not resolve host\)/, { fetchMain });
});

for (const [name, dirty] of [
  ['a modified shared file', (source) => put(source, 'docs/a.txt', 'edited\n')],
  [
    'an untracked file at a manifest path',
    (source) => {
      put(source, 'docs/new.txt', 'new\n');
      writeManifest(source, computeEntries(source, { entries: [...SOURCE_ENTRIES, { path: 'docs/new.txt', sha256: ZERO_SHA256 }] }));
      git(source, 'add', MANIFEST);
      git(source, 'commit', '-q', '-m', 'record without the file');
    },
  ],
]) {
  test(`a source with ${name} is refused as uncommitted`, (t) => {
    const fixture = syncFixture(t);
    dirty(fixture.source);
    assertRefused(fixture, /the source has uncommitted changes at shared paths: .*docs\/(a|new)\.txt/);
  });
}

test('a source that fails its own manifest is refused, naming the mismatched path', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, 'docs/a.txt', 'drift\n');
  commitAll(fixture.source);
  assertRefused(fixture, /the source does not match its own manifest at docs\/a\.txt/);
});

test('a source whose origin is not the canonical is refused', (t) => {
  const fixture = syncFixture(t);
  git(fixture.source, 'remote', 'set-url', 'origin', 'https://github.com/example-owner/fork');
  assertRefused(fixture, /the source's origin https:\/\/github\.com\/example-owner\/fork is not github\.com\/example-owner\/example-repo/);
});

test('a source with no origin remote is refused', (t) => {
  const fixture = syncFixture(t);
  git(fixture.source, 'remote', 'remove', 'origin');
  assertRefused(fixture, /the source has no origin remote/);
});

test('a target whose origin is the canonical is refused', (t) => {
  const fixture = syncFixture(t);
  git(fixture.target, 'remote', 'set-url', 'origin', 'git@github.com:example-owner/example-repo.git');
  assertRefused(fixture, /never sync into the canonical/);
});

test('a --canonical that disagrees with the target\'s committed manifest is refused', (t) => {
  assertRefused(syncFixture(t), /--canonical example-owner\/other disagrees with/, { canonical: 'example-owner/other' });
});

test('a target with no committed manifest needs --canonical, and syncs with it', (t) => {
  const fixture = syncFixture(t);
  git(fixture.target, 'rm', '-q', MANIFEST);
  commitAll(fixture.target);
  assertRefused(fixture, /no canonical repository/);
  fixture.sync({ canonical: CANONICAL });
  assert.deepEqual(verifyManifest(fixture.target), []);
});

for (const [name, manual] of [
  ['missing markers', '# Adopter manual\n'],
  ['duplicated markers', `${START}\n${START}\nx\n${END}\n`],
  ['no file at all', null],
]) {
  test(`a target AGENTS.md with ${name} is refused as malformed region markers`, (t) => {
    const fixture = syncFixture(t);
    if (manual === null) rmSync(join(fixture.target, 'AGENTS.md'));
    else put(fixture.target, 'AGENTS.md', manual);
    commitAll(fixture.target);
    assertRefused(fixture, /target AGENTS\.md: malformed region markers/);
  });
}

test('a target AGENTS.md that is a symlink is refused, even to a file with well-formed markers', NEEDS_FILE_SYMLINK, (t) => {
  const fixture = syncFixture(t);
  put(fixture.outside, 'manual.md', `# Outside manual\n${START}\nshared v1\n${END}\n`);
  rmSync(join(fixture.target, 'AGENTS.md'));
  link(fixture.target, 'AGENTS.md', '../outside/manual.md');
  commitAll(fixture.target);
  assertRefused(fixture, /AGENTS\.md/);
});

test('a sync gives each file its committed mode, whatever the mode in the source working tree', (t) => {
  const fixture = syncFixture(t);
  git(fixture.source, 'config', 'core.fileMode', 'false');
  chmodSync(join(fixture.source, 'scripts', 'run.sh'), 0o644);
  chmodSync(join(fixture.source, 'docs', 'a.txt'), 0o755);
  assert.equal(git(fixture.source, 'status', '--porcelain'), '', 'the mode change must be invisible to git status');
  fixture.sync();
  if (process.platform === 'win32') {
    assert.equal(indexMode(fixture.target, 'scripts/run.sh'), '100755');
    assert.equal(indexMode(fixture.target, 'docs/a.txt'), '100644');
  } else {
    assert.equal(lstatSync(join(fixture.target, 'scripts', 'run.sh')).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(fixture.target, 'docs', 'a.txt')).mode & 0o777, 0o644);
  }
});

test('a target that does not honour file modes gets each file\'s committed mode in its index', (t) => {
  const fixture = syncFixture(t);
  const outsideBefore = snapshot(fixture.outside);
  const files = [
    { path: 'docs/a.txt', bytes: 'hello v2\n', mode: '100644' },
    { path: 'scripts/run.sh', bytes: '#!/bin/sh\necho v2\n', mode: '100755' },
  ];
  git(fixture.target, 'config', 'core.fileMode', 'false');
  git(fixture.target, 'config', 'core.symlinks', 'false');
  for (const { path } of files) {
    rmSync(join(fixture.target, path));
    put(fixture.target, path, '../../outside/secret.txt');
    const blob = git(fixture.target, 'hash-object', '-w', '--', path);
    git(fixture.target, 'update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
  }
  commitAll(fixture.target);
  for (const { path } of files) {
    assert.ok(lstatSync(join(fixture.target, path)).isFile());
    assert.equal(indexMode(fixture.target, path), '120000');
  }
  assert.equal(git(fixture.target, 'status', '--porcelain'), '', 'the committed link pointers must start clean');

  fixture.sync();

  for (const { path, bytes, mode } of files) {
    assert.ok(lstatSync(join(fixture.target, path)).isFile());
    assert.equal(readFileSync(join(fixture.target, path), 'utf8'), bytes);
    const indexed = spawnSync('git', ['-C', fixture.target, ...GIT_ISOLATION, 'show', `:${path}`], { encoding: 'utf8' });
    assert.equal(indexed.status, 0, indexed.stderr);
    assert.equal(indexed.stdout, bytes);
    assert.equal(indexMode(fixture.target, path), mode);
  }
  assert.deepEqual(snapshot(fixture.outside), outsideBefore);
  assert.equal(git(fixture.target, 'config', 'core.fileMode'), 'false');
  assert.equal(git(fixture.target, 'config', 'core.symlinks'), 'false');
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

test('a source commit whose file mode differs from its manifest is refused, naming the path', (t) => {
  const fixture = syncFixture(t);
  // The index carries the mode where the checkout ignores it; the chmod stops git add restoring it where it does not.
  chmodSync(join(fixture.source, 'scripts', 'run.sh'), 0o644);
  git(fixture.source, 'update-index', '--chmod=-x', 'scripts/run.sh');
  commitAll(fixture.source);
  assertRefused(fixture, /the source does not match its own manifest at scripts\/run\.sh in its commit/);
});

test('a source AGENTS.md with malformed markers is refused', (t) => {
  const fixture = syncFixture(t);
  put(fixture.source, 'AGENTS.md', `# Canonical manual\nshared v2\n${END}\n`);
  commitAll(fixture.source);
  assertRefused(fixture, /^Error: AGENTS\.md: malformed region markers/);
});

test('a target with uncommitted changes at a manifest path is refused', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'scripts/run.sh', 'local edit\n');
  assertRefused(fixture, /the target has uncommitted changes at shared paths: .*scripts\/run\.sh/);
});

// Commits the source's manifest with its canonical replaced.
function recanonicalise(source, canonical) {
  put(source, MANIFEST, JSON.stringify({ ...readManifest(source), canonical }));
  commitAll(source);
}

test('a source manifest that names another canonical is refused', (t) => {
  const fixture = syncFixture(t);
  recanonicalise(fixture.source, 'example-owner/other');
  assertRefused(fixture, /the source's manifest names the canonical example-owner\/other, not example-owner\/example-repo/);
});

test('a source manifest naming the canonical in another case syncs and records the target\'s canonical', (t) => {
  const fixture = syncFixture(t);
  recanonicalise(fixture.source, 'Example-Owner/Example-Repo');
  fixture.sync();
  assert.equal(readManifest(fixture.target).canonical, CANONICAL);
});

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

// The source's committed scripts/run.sh, as syncFixture writes it.
const COMMITTED_RUN = '#!/bin/sh\necho v2\n';

// Rewrites the source's shared script and re-records the manifest over it, in the working tree only.
function tamper(source) {
  put(source, 'scripts/run.sh', '#!/bin/sh\necho tampered\n', 0o755);
  writeManifest(source, computeEntries(source, { entries: SOURCE_ENTRIES }));
}

// Runs the sync under env: it either refuses, writing nothing, or writes the source's committed bytes.
function assertCommittedOrRefused(fixture, env) {
  const before = [snapshot(fixture.target), snapshot(fixture.outside)];
  let refused = false;
  try {
    withEnv(env, () => fixture.sync());
  } catch {
    refused = true;
  }
  if (refused) assert.deepEqual([snapshot(fixture.target), snapshot(fixture.outside)], before, 'a refused sync must write nothing');
  else assert.equal(readFileSync(join(fixture.target, 'scripts/run.sh'), 'utf8'), COMMITTED_RUN, 'the sync wrote bytes the source never committed');
}

test('a tampered shared file and manifest hidden from git status by skip-worktree are never synced; the committed bytes are', (t) => {
  const fixture = syncFixture(t);
  const committed = JSON.parse(git(fixture.source, 'show', `HEAD:${MANIFEST}`));
  tamper(fixture.source);
  git(fixture.source, 'update-index', '--skip-worktree', 'scripts/run.sh', MANIFEST);
  assert.equal(git(fixture.source, 'status', '--porcelain'), '', 'the tamper must be hidden from git status');

  fixture.sync();

  assert.equal(readFileSync(join(fixture.target, 'scripts/run.sh'), 'utf8'), COMMITTED_RUN);
  assert.deepEqual(readManifest(fixture.target).entries, committed.entries);
});

// The hostile value is relative, so each repository reads its own copy: an absolute one would give the target the
// source's index, which fails the target's status check and hides whether the source's tamper was synced.
test('an inherited GIT_INDEX_FILE that hides a tamper cannot change what is synced', (t) => {
  const fixture = syncFixture(t);
  const hostile = { GIT_INDEX_FILE: '.git/hostile-index' };
  for (const root of [fixture.source, fixture.target]) cpSync(join(root, '.git', 'index'), join(root, hostile.GIT_INDEX_FILE));
  withEnv(hostile, () => git(fixture.source, 'update-index', '--skip-worktree', 'scripts/run.sh', MANIFEST));
  tamper(fixture.source);
  assertCommittedOrRefused(fixture, hostile);
});

// The hostile value is relative, so the target's copy can be the target's own repository while the source's is a
// copy whose main commits a tamper; an absolute one would point both at one repository, which the origin checks
// refuse whatever the environment.
test('an inherited GIT_DIR cannot redirect the sync to another repository', (t) => {
  const fixture = syncFixture(t);
  const hostile = { GIT_DIR: 'hostile.git' };
  cpSync(join(fixture.source, '.git'), join(fixture.source, hostile.GIT_DIR), { recursive: true });
  link(fixture.target, hostile.GIT_DIR, '.git');
  withEnv(hostile, () => {
    tamper(fixture.source);
    git(fixture.source, 'add', '--', 'scripts/run.sh', MANIFEST);
    git(fixture.source, 'commit', '-q', '-m', 'hostile');
  });
  assertCommittedOrRefused(fixture, hostile);
});

test('fetchMain returns the origin main tip of a clone that is behind it', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-fetch-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [origin, work, clone] = ['origin.git', 'work', 'clone'].map((name) => join(base, name));
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  repository(work, origin);
  put(work, 'a.txt', 'one\n');
  commitAll(work);
  git(work, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', origin, clone);
  put(work, 'a.txt', 'two\n');
  commitAll(work);
  git(work, 'push', '-q', 'origin', 'main');
  const tip = git(origin, 'rev-parse', 'main');
  assert.notEqual(git(clone, 'rev-parse', 'HEAD'), tip, 'the clone must start behind its origin');
  assert.equal(fetchMain(clone), tip);
});

// GIT_ALLOW_PROTOCOL=file makes the fixture's https origin unreachable without touching the network.
const NO_NETWORK = { GIT_ALLOW_PROTOCOL: 'file' };

test('fetchMain throws for an unreachable origin, and a sync that uses it writes nothing', (t) => {
  const fixture = syncFixture(t);
  withEnv(NO_NETWORK, () => {
    assert.throws(() => fetchMain(fixture.source), /transport 'https' not allowed/);
    assertRefused(fixture, /cannot fetch the source's origin main \(.*transport 'https' not allowed/, { fetchMain });
  });
});

test('--from reaches the real fetch and, when it fails, exits 1 naming it and leaves the target unchanged', (t) => {
  const fixture = syncFixture(t);
  const before = snapshot(fixture.target);
  const run = spawnSync(process.execPath, [CLI, '--from', fixture.source], {
    cwd: fixture.target,
    encoding: 'utf8',
    env: { ...process.env, ...NO_NETWORK },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^factory-sync: cannot fetch the source's origin main \(.*transport 'https' not allowed/);
  assert.deepEqual(snapshot(fixture.target), before, 'a refused --from must write nothing');
});

// An insteadOf rewrite cannot stand in for the network, since the origin check reads `git remote get-url`, which
// expands it. The transport can: with the source's origin set to the canonical's ssh address, GIT_SSH_COMMAND makes
// git run a local command in place of ssh. git runs it in the source, so `git upload-pack .` serves the source's own
// repository: the real fetch runs and nothing leaves the machine.
const SERVED_BY_ITSELF = { GIT_SSH_VARIANT: 'simple', GIT_SSH_COMMAND: 'serve() { git upload-pack .; }; serve' };

test('--from prints what it wrote and each retired file it removed, and exits 0', (t) => {
  const fixture = syncFixture(t);
  put(fixture.target, 'retired.sh', 'hello\n');
  listInTarget(fixture, [{ path: 'retired.sh', sha256: HELLO_SHA256 }]);
  git(fixture.source, 'remote', 'set-url', 'origin', `git@github.com:${CANONICAL}.git`);
  const run = spawnSync(process.execPath, [CLI, '--from', fixture.source], {
    cwd: fixture.target,
    encoding: 'utf8',
    env: { ...process.env, ...SERVED_BY_ITSELF },
  });
  assert.equal(run.status, 0, run.stderr);
  const expectedSource = process.platform === 'win32' ? realpathSync.native(fixture.source) : fixture.source;
  const expectedTarget = process.platform === 'win32' ? realpathSync.native(fixture.target) : fixture.target;
  assert.deepEqual(run.stdout.split('\n'), [
    `factory-sync: wrote 2 files and 1 regions from ${expectedSource} into ${expectedTarget}`,
    'factory-sync: removed 1 retired files',
    '  retired.sh',
    '',
  ]);
  assert.equal(existsSync(join(fixture.target, 'retired.sh')), false, 'the printed file must be gone');
});

test('--from prints how many entries it left out', (t) => {
  const fixture = bothRuntimesFixture(t);
  putSettings(fixture, {}, ['claude']);
  git(fixture.source, 'remote', 'set-url', 'origin', `git@github.com:${CANONICAL}.git`);
  const run = spawnSync(process.execPath, [CLI, '--from', fixture.source], {
    cwd: fixture.target,
    encoding: 'utf8',
    env: { ...process.env, ...SERVED_BY_ITSELF },
  });
  assert.equal(run.status, 0, run.stderr);
  const expectedSource = process.platform === 'win32' ? realpathSync.native(fixture.source) : fixture.source;
  const expectedTarget = process.platform === 'win32' ? realpathSync.native(fixture.target) : fixture.target;
  assert.deepEqual(run.stdout.split('\n'), [
    `factory-sync: wrote 3 files and 1 regions from ${expectedSource} into ${expectedTarget}`,
    'factory-sync: left out 1 entries the settings file leaves out',
    'factory-sync: removed 0 retired files',
    '',
  ]);
});

test('--from with no value, or an unknown flag, prints the usage for both modes and exits 2', (t) => {
  const root = staleRepository(t, CANONICAL_URL);
  for (const args of [['--from'], ['--from', root, '--bogus', 'x'], ['--into', root]]) {
    const run = runCli(root, ...args);
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: .*--write .*--from <source> \[--into <target>\] \[--canonical <owner\/repo>\]/);
  }
});

test('--from the repository it runs in is refused as the same repository', (t) => {
  const root = staleRepository(t, ADOPTER_URL);
  const run = runCli(root, '--from', join(root, 'docs'));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^factory-sync: the source and target are the same repository/);
});

const LAG_MANIFEST = {
  canonical: CANONICAL,
  adopters: ['example-owner/adopter'],
  entries: [
    { path: 'a.txt', sha256: HELLO_SHA256 },
    { path: 'AGENTS.md', region: 'factory-shared', sha256: REGION_SHA256 },
  ],
};

// Checks a local manifest (an object, raw text, or null for none) against the canonical's manifest text.
function lag(t, local, fetchCanonicalManifest) {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-lag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (local !== null) put(root, MANIFEST, typeof local === 'string' ? local : JSON.stringify(local));
  return checkLag({ root, fetchCanonicalManifest });
}

const remote = (manifest) => () => JSON.stringify(manifest);
const withEntries = (entries) => ({ ...LAG_MANIFEST, entries });
const [A, REGION] = LAG_MANIFEST.entries;
// An adopter's own manifest: a sync writes no adopters list into it.
const ADOPTER_MANIFEST = { canonical: CANONICAL, syncedFrom: 'abc123', entries: LAG_MANIFEST.entries };

test('a local manifest matching the canonical main, apart from syncedFrom, is in sync', (t) => {
  const asked = [];
  const fetch = (canonical) => {
    asked.push(canonical);
    return JSON.stringify(LAG_MANIFEST);
  };
  assert.deepEqual(lag(t, { ...LAG_MANIFEST, syncedFrom: 'abc123' }, fetch), { state: 'in-sync', differences: [], cause: null });
  assert.deepEqual(asked, [CANONICAL]);
});

test('a local manifest with no adopters list or a different one is in sync with a canonical main that holds one', (t) => {
  const listed = { ...LAG_MANIFEST, adopters: ['example-owner/adopter', 'example-owner/other'] };
  assert.deepEqual(lag(t, ADOPTER_MANIFEST, remote(listed)), { state: 'in-sync', differences: [], cause: null });
  assert.deepEqual(lag(t, LAG_MANIFEST, remote(listed)), { state: 'in-sync', differences: [], cause: null });
});

for (const [name, canonicalMain, differences] of [
  ['a changed hash', withEntries([{ ...A, sha256: ZERO_SHA256 }, REGION]), ['a.txt: changed']],
  ['a changed executable bit', withEntries([{ ...A, executable: true }, REGION]), ['a.txt: changed']],
  ['an entry missing here', withEntries([A, REGION, { path: 'docs/new.md', sha256: HELLO_SHA256 }]), ['docs/new.md: missing here']],
  ['an entry no longer shared', withEntries([REGION]), ['a.txt: no longer shared']],
  [
    'a different canonical',
    { ...LAG_MANIFEST, canonical: 'example-owner/renamed' },
    ['canonical: example-owner/example-repo here, example-owner/renamed on main'],
  ],
  [
    'several differences, listed by path',
    withEntries([{ path: 'z.txt', sha256: HELLO_SHA256 }, { ...REGION, sha256: ZERO_SHA256 }]),
    ['AGENTS.md: changed', 'a.txt: no longer shared', 'z.txt: missing here'],
  ],
]) {
  test(`${name} is reported as drifted`, (t) => {
    assert.deepEqual(lag(t, ADOPTER_MANIFEST, remote(canonicalMain)), { state: 'drifted', differences, cause: null });
  });
}

for (const [name, local, fetch, cause] of [
  [
    'a failed fetch of the canonical manifest',
    LAG_MANIFEST,
    () => {
      throw new Error('gh is not installed');
    },
    /^cannot fetch example-owner\/example-repo main's \.agents\/factory-manifest\.json \(gh is not installed\)$/,
  ],
  ['a canonical manifest that is not JSON', LAG_MANIFEST, () => '<html>', /main's \.agents\/factory-manifest\.json is not valid JSON/],
  [
    'a canonical manifest with a malformed entry',
    LAG_MANIFEST,
    remote(withEntries([A, { path: '../x', sha256: HELLO_SHA256 }])),
    /invalid manifest path "\.\.\/x"/,
  ],
  [
    'a canonical manifest that lists one path twice',
    LAG_MANIFEST,
    remote(withEntries([A, REGION, A])),
    /^example-owner\/example-repo main's \.agents\/factory-manifest\.json lists a\.txt more than once$/,
  ],
  [
    'a canonical manifest that lists two paths naming one file',
    LAG_MANIFEST,
    remote(withEntries([A, REGION, { ...A, path: 'A.txt' }])),
    /^example-owner\/example-repo main's \.agents\/factory-manifest\.json lists a\.txt and A\.txt, which name the same file on a case-insensitive or Unicode-normalising disk$/,
  ],
  [
    'a canonical manifest that lists one path under another',
    LAG_MANIFEST,
    remote(withEntries([A, REGION, { path: 'A.txt/x', sha256: HELLO_SHA256 }])),
    /^example-owner\/example-repo main's \.agents\/factory-manifest\.json lists a\.txt and A\.txt\/x, and A\.txt\/x lies under a\.txt$/,
  ],
  ['no local manifest', null, remote(LAG_MANIFEST), /^no factory manifest here; run the first sync with --from$/],
  ['a malformed local manifest', '{', remote(LAG_MANIFEST), /^\.agents\/factory-manifest\.json is not valid JSON/],
]) {
  test(`${name} leaves the sync state unknown, never in sync`, (t) => {
    const result = lag(t, local, fetch);
    assert.equal(result.state, 'unknown');
    assert.deepEqual(result.differences, []);
    assert.match(result.cause, cause);
  });
}

test('--check with any other argument prints the usage for all four modes and exits 2', (t) => {
  const run = runCli(staleRepository(t, ADOPTER_URL), '--check', 'extra');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^usage: node scripts\/factory-sync\.mjs --write \| --check \| --render \| --from <source>/);
});

// The environment with PATH replaced. Windows names are case-insensitive, so any other spelling of PATH is dropped
// rather than left to compete with it.
function withPath(path) {
  const env = { ...process.env };
  if (process.platform === 'win32') for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
  return { ...env, PATH: path };
}

test('--check without gh on the PATH reports the sync state unknown and exits 2', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'adopter');
  repository(root, ADOPTER_URL);
  put(root, MANIFEST, JSON.stringify(LAG_MANIFEST));
  // A PATH holding git alone, so the check reaches the fetch and gh is the only thing missing. On Windows that is
  // git's own directory, since a file symlink to git.exe needs privilege.
  let bin;
  if (process.platform === 'win32') {
    bin = dirname(gitExecutable());
    assert.ok(!existsSync(join(bin, 'gh.exe')), `${bin} must not hold gh.exe`);
  } else {
    bin = join(base, 'bin');
    mkdirSync(bin);
    symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
  }
  const run = spawnSync(process.execPath, [CLI, '--check'], { cwd: root, encoding: 'utf8', env: withPath(bin) });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /^factory-sync: sync state unknown: cannot fetch example-owner\/example-repo main's .*\(gh is not installed\)$/m);
});

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The arguments of the one gh call --check makes for canonical's manifest on main.
const contentsCall = (canonical) => [
  'api',
  '--hostname',
  'github.com',
  `repos/${canonical}/contents/${MANIFEST}?ref=main`,
  '-H',
  'Accept: application/vnd.github.raw+json',
];

// Runs --check in root with a fake gh first on the PATH. The fake logs every call's arguments and answers only the
// contents call for canonical's manifest, printing manifestText; any other call exits 1. Returns the run and the
// logged calls. Windows runs no shebang script, so there gh.exe is a copy of node that a preload turns into the fake;
// node takes the first argument as its script, so the preload reads it back from process.argv[1].
function checkWithFakeGh(t, root, canonical, manifestText) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-gh-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const [calls, answer] = [join(bin, 'calls'), join(bin, 'answer')];
  writeFileSync(answer, manifestText);
  const imports = "const { appendFileSync, readFileSync } = require('node:fs');\n";
  const body = `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(contentsCall(canonical)))}) {
  process.stderr.write('unexpected gh call\\n');
  process.exit(1);
}
process.stdout.write(readFileSync(${JSON.stringify(answer)}, 'utf8'));
`;
  const env = withPath(`${bin}${delimiter}${process.env.PATH}`);
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(bin, 'gh.exe'));
    const preload = join(bin, 'fake-gh.cjs');
    writeFileSync(
      preload,
      `${imports}const { basename } = require('node:path');
if (basename(process.execPath).toLowerCase() === 'gh.exe') {
const args = [basename(process.argv[1]), ...process.argv.slice(2)];
${body}process.exit(0);
}
`,
    );
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`].filter(Boolean).join(' ');
  } else put(bin, 'gh', `#!/usr/bin/env node\n${imports}const args = process.argv.slice(2);\n${body}`, 0o755);
  const run = spawnSync(process.execPath, [CLI, '--check'], { cwd: root, encoding: 'utf8', env });
  const logged = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { run, calls: logged };
}

test('--check asks gh for the canonical manifest on github.com, never the configured default host', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sync-check-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'adopter');
  repository(root, ADOPTER_URL);
  put(root, MANIFEST, JSON.stringify(LAG_MANIFEST));
  const { run, calls } = checkWithFakeGh(t, root, CANONICAL, JSON.stringify(LAG_MANIFEST));
  assert.deepEqual(calls, [contentsCall(CANONICAL)]);
  assert.equal(run.status, 0, run.stderr);
});

test('--check exits 0 and prints in sync when the canonical main holds this repository\'s manifest', (t) => {
  const text = readFileSync(join(REPOSITORY_ROOT, MANIFEST), 'utf8');
  const { canonical } = JSON.parse(text);
  const { run } = checkWithFakeGh(t, REPOSITORY_ROOT, canonical, text);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^factory-sync: in sync with ${canonical} main$`, 'm'));
});

test('--check exits 1 and lists the changed path when one canonical entry differs', (t) => {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, MANIFEST), 'utf8'));
  const changed = manifest.entries.find((entry) => 'sha256' in entry);
  const entries = manifest.entries.map((entry) => (entry === changed ? { ...entry, sha256: ZERO_SHA256 } : entry));
  const { run } = checkWithFakeGh(t, REPOSITORY_ROOT, manifest.canonical, JSON.stringify({ ...manifest, entries }));
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^factory-sync: behind /m);
  assert.deepEqual(
    run.stderr.split('\n').filter((line) => line.startsWith('  ')),
    [`  ${changed.path}: changed`],
  );
  assert.match(run.stderr, /^factory-sync: lag is information .*--from <checkout of /m);
  assert.doesNotMatch(run.stderr, /open a sync card/);
});
