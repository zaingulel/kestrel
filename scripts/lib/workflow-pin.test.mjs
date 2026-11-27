// @ts-nocheck
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { gitEnvironment } from './factory-sync.mjs';
import * as pin from './workflow-pin.mjs';

const env = { ...gitEnvironment(), GIT_NO_REPLACE_OBJECTS: '1' };
const OFF_LINUX = process.platform === 'linux' ? undefined : `the suite builds its fixtures with POSIX execute bits and symbolic links, so it runs on Linux only, not ${process.platform}`;

const run = (cwd, args, options) => {
  const done = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.safecrlf=false', ...args], { cwd, env, ...options });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
};
const git = (cwd, ...args) => run(cwd, args, { encoding: 'utf8' }).trim();
// A blob's literal bytes as a Buffer, never decoded.
const blob = (cwd, id) => run(cwd, ['cat-file', 'blob', id], {});

// Stages one index entry with exactly these bytes and mode, so no filter, checkout or file system shapes the object.
const stage = (cwd, path, mode, content) => {
  const id = run(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { encoding: 'utf8', input: content }).trim();
  git(cwd, 'update-index', '--add', '--cacheinfo', `${mode},${id},${path}`);
};

// The oracle is git's own ancestry relation, never the module under test.
const onOriginMain = (cwd) => spawnSync('git', ['merge-base', '--is-ancestor', 'main', 'origin/main'], { cwd, env }).status === 0;

const commit = (cwd, name) => {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', name);
};

// A bare origin and a clone whose main is pushed and fetched; the real path so a message naming it matches.
const repository = (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-pin-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  git(base, 'init', '--bare', '-b', 'main', origin);
  git(base, 'init', '-b', 'main', clone);
  git(clone, 'remote', 'add', 'origin', origin);
  commit(clone, 'first');
  git(clone, 'push', 'origin', 'main');
  git(clone, 'fetch', 'origin');
  return clone;
};

// A commit holding bytes a text read or a checkout would change, and a replace object standing in for it with other
// content.
const literalCommit = (cwd) => {
  stage(cwd, 'binary.bin', '100644', Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0xc3, 0x28, 0x00, 0x80]));
  stage(cwd, '.gitattributes', '100644', 'crlf.txt eol=crlf\n');
  stage(cwd, 'crlf.txt', '100644', 'one\ntwo\n');
  stage(cwd, 'run.sh', '100755', '#!/bin/sh\necho run\n');
  stage(cwd, 'link', '120000', 'run.sh');
  git(cwd, 'commit', '-m', 'literal');
  const literal = git(cwd, 'rev-parse', 'HEAD');
  stage(cwd, 'binary.bin', '100644', 'REPLACEMENT\n');
  stage(cwd, 'replaced.txt', '100644', 'REPLACEMENT\n');
  const replacement = git(cwd, 'commit-tree', git(cwd, 'write-tree'), '-p', literal, '-m', 'replacement');
  git(cwd, 'replace', literal, replacement);
  return literal;
};

// The literal tree as git's own object store lists it, ignoring replace objects.
const literalTree = (cwd, id) => git(cwd, 'ls-tree', '-r', '-z', id).split('\0').filter(Boolean).map((line) => {
  const [meta, path] = line.split('\t');
  const [mode, , object] = meta.split(' ');
  return { mode, object, path };
});

const writtenPaths = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => !entry.isDirectory())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort();

test('workflow pin: selects only an ancestor of origin/main', (t) => {
  const cwd = repository(t);
  assert.equal(onOriginMain(cwd), true);
  assert.equal(pin.selectWorkflowVersion({ cwd }), git(cwd, 'rev-parse', 'refs/heads/main'));
  assert.match(pin.selectWorkflowVersion({ cwd }), /^[0-9a-f]{40}$/);

  commit(cwd, 'second');
  git(cwd, 'push', 'origin', 'main');
  git(cwd, 'fetch', 'origin');
  git(cwd, 'reset', '--hard', 'HEAD~1');
  const behind = git(cwd, 'rev-parse', 'refs/heads/main');
  assert.notEqual(behind, git(cwd, 'rev-parse', 'refs/remotes/origin/main'));
  assert.equal(onOriginMain(cwd), true);
  assert.equal(pin.selectWorkflowVersion({ cwd }), behind);

  commit(cwd, 'local');
  assert.equal(onOriginMain(cwd), false);
  assert.throws(() => pin.selectWorkflowVersion({ cwd }), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(cwd), error.message);
    assert.match(error.message, /not on origin\/main/);
    return true;
  });
});

test('workflow pin: writes literal bytes and objects', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const replaced = spawnSync('git', ['ls-tree', '-r', '--name-only', commitId], { cwd, encoding: 'utf8', env: gitEnvironment() });
  assert.match(replaced.stdout, /replaced\.txt/, 'the replace object stands in for the commit when replace objects are honoured');
  const tree = literalTree(cwd, commitId);
  assert.deepEqual(tree.map((entry) => entry.mode).sort(), ['100644', '100644', '100644', '100644', '100755', '120000']);

  const into = join(dirname(cwd), 'snapshot');
  mkdirSync(into);
  pin.workflowSnapshot({ cwd, commit: commitId, into });

  assert.deepEqual(writtenPaths(into), tree.map((entry) => entry.path).sort());
  for (const { mode, object, path } of tree) {
    const written = join(into, path);
    const expected = blob(cwd, object);
    if (mode === '120000') {
      assert.ok(lstatSync(written).isSymbolicLink(), `${path} is a symbolic link`);
      assert.deepEqual(readlinkSync(written, { encoding: 'buffer' }), expected, path);
      continue;
    }
    assert.ok(lstatSync(written).isFile(), `${path} is a regular file`);
    const bytes = readFileSync(written);
    assert.deepEqual(bytes, expected, path);
    assert.equal(bytes.includes('REPLACEMENT'), false, path);
    if (mode === '100755') assert.notEqual(lstatSync(written).mode & 0o100, 0, `${path} keeps its execute bit`);
  }
  assert.deepEqual(readFileSync(join(into, 'crlf.txt')), Buffer.from('one\ntwo\n'));
});

// A fresh, intact snapshot of the commit in its own directory beside the clone.
let copies = 0;
const intact = (cwd, commitId) => {
  const dir = join(dirname(cwd), `snapshot-${++copies}`);
  mkdirSync(dir);
  pin.workflowSnapshot({ cwd, commit: commitId, into: dir });
  pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir });
  return dir;
};
const refuses = (cwd, commitId, dir, path) => assert.throws(() => pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir }), (error) => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.includes(path), error.message);
  return true;
});
// The ID git gives these bytes as a blob, with no filter applied.
const blobId = (cwd, bytes) => run(cwd, ['hash-object', '--no-filters', '--stdin'], { encoding: 'utf8', input: bytes }).trim();

test('workflow pin: refuses a changed path set', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const paths = literalTree(cwd, commitId).map((entry) => entry.path);

  const extended = intact(cwd, commitId);
  assert.equal(paths.includes('extra.txt'), false);
  writeFileSync(join(extended, 'extra.txt'), 'extra\n');
  refuses(cwd, commitId, extended, 'extra.txt');

  const reduced = intact(cwd, commitId);
  assert.ok(paths.includes('crlf.txt'));
  rmSync(join(reduced, 'crlf.txt'));
  refuses(cwd, commitId, reduced, 'crlf.txt');
});

test('workflow pin: refuses a changed mode', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const modes = new Map(literalTree(cwd, commitId).map((entry) => [entry.path, entry.mode]));

  const cleared = intact(cwd, commitId);
  assert.equal(modes.get('run.sh'), '100755');
  chmodSync(join(cleared, 'run.sh'), 0o644);
  assert.equal(lstatSync(join(cleared, 'run.sh')).mode & 0o111, 0);
  refuses(cwd, commitId, cleared, 'run.sh');

  const set = intact(cwd, commitId);
  assert.equal(modes.get('binary.bin'), '100644');
  chmodSync(join(set, 'binary.bin'), 0o755);
  assert.notEqual(lstatSync(join(set, 'binary.bin')).mode & 0o100, 0);
  refuses(cwd, commitId, set, 'binary.bin');
});

test('workflow pin: refuses changed content', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const tree = new Map(literalTree(cwd, commitId).map((entry) => [entry.path, entry]));

  const edited = intact(cwd, commitId);
  const file = join(edited, 'crlf.txt');
  assert.equal(tree.get('crlf.txt').mode, '100644');
  const before = lstatSync(file);
  const bytes = readFileSync(file);
  bytes[0] ^= 0x01;
  writeFileSync(file, bytes);
  const after = lstatSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mode, before.mode);
  assert.notEqual(blobId(cwd, readFileSync(file)), tree.get('crlf.txt').object);
  refuses(cwd, commitId, edited, 'crlf.txt');

  const repointed = intact(cwd, commitId);
  const link = join(repointed, 'link');
  assert.equal(tree.get('link').mode, '120000');
  rmSync(link);
  symlinkSync('crlf.txt', link);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.notEqual(blobId(cwd, readlinkSync(link, { encoding: 'buffer' })), tree.get('link').object);
  refuses(cwd, commitId, repointed, 'link');
});

test('ANTI-REGRESSION: on Windows the workflow snapshot accepts a regular file for an executable entry and still refuses changed bytes or another kind', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const verify = (dir) => pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir, platform: 'win32' });
  const refusesOnWindows = (dir, message) => assert.throws(() => verify(dir), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    return true;
  });
  assert.equal(literalTree(cwd, commitId).find((entry) => entry.path === 'run.sh').mode, '100755');

  const plain = intact(cwd, commitId);
  chmodSync(join(plain, 'run.sh'), 0o644);
  assert.equal(lstatSync(join(plain, 'run.sh')).mode & 0o111, 0);
  verify(plain);

  const edited = intact(cwd, commitId);
  chmodSync(join(edited, 'run.sh'), 0o644);
  const bytes = readFileSync(join(edited, 'run.sh'));
  bytes[0] ^= 0x01;
  writeFileSync(join(edited, 'run.sh'), bytes);
  refusesOnWindows(edited, /run\.sh: content \w+ differs from \w+ in /);

  const linked = intact(cwd, commitId);
  rmSync(join(linked, 'run.sh'));
  symlinkSync('crlf.txt', join(linked, 'run.sh'));
  assert.ok(lstatSync(join(linked, 'run.sh')).isSymbolicLink());
  refusesOnWindows(linked, /run\.sh: mode 120000 differs from 100755/);

  const regular = intact(cwd, commitId);
  rmSync(join(regular, 'link'));
  writeFileSync(join(regular, 'link'), 'run.sh');
  assert.ok(lstatSync(join(regular, 'link')).isFile());
  refusesOnWindows(regular, /link: mode 100644 differs from 120000/);
});

// Every regular file's bytes under a snapshot directory, keyed by its relative path.
const fileBytes = (dir) => new Map(writtenPaths(dir).filter((path) => lstatSync(join(dir, path)).isFile()).map((path) => [path, readFileSync(join(dir, path))]));
// Flips one byte of a snapshot file, first adding only the owner's write bit should the store have made it read-only.
const damage = (file, at) => {
  chmodSync(file, lstatSync(file).mode | 0o200);
  const bytes = readFileSync(file);
  bytes[at] ^= 0x01;
  writeFileSync(file, bytes);
};
// Restores the owner's access to every directory, so the fixture's removal can empty a read-only store.
const writable = (dir) => {
  if (!existsSync(dir)) return;
  chmodSync(dir, lstatSync(dir).mode | 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(join(dir, entry.name));
};

test('workflow pin: repairs a snapshot of the same commit', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const other = git(cwd, 'rev-parse', 'HEAD~1');
  assert.notEqual(other, commitId);
  const store = join(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'fabraik-workflow');
  const canonical = join(store, commitId);
  const damaged = (n) => join(store, `${commitId}.damaged-${n}`);
  const original = blob(cwd, literalTree(cwd, commitId).find((entry) => entry.path === 'crlf.txt').object);
  // Only canonical copies and kept damaged copies remain once a repair returns; a staging directory left behind fails.
  const holds = (...names) => assert.deepEqual(readdirSync(store).sort(), names.sort());
  try {
    assert.equal(existsSync(canonical), false);
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir: canonical });
    holds(commitId);

    const first = lstatSync(canonical).ino;
    damage(join(canonical, 'crlf.txt'), 0);
    const firstDamage = readFileSync(join(canonical, 'crlf.txt'));
    assert.notDeepEqual(firstDamage, original);
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    assert.equal(lstatSync(damaged(1)).ino, first, 'the damaged copy is moved, not rewritten');
    assert.deepEqual(readFileSync(join(damaged(1), 'crlf.txt')), firstDamage);
    pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir: canonical });
    assert.deepEqual(readFileSync(join(canonical, 'crlf.txt')), original);
    holds(commitId, `${commitId}.damaged-1`);

    const kept = fileBytes(damaged(1));
    const second = lstatSync(canonical).ino;
    damage(join(canonical, 'crlf.txt'), 1);
    const secondDamage = readFileSync(join(canonical, 'crlf.txt'));
    assert.notDeepEqual(secondDamage, firstDamage);
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    assert.equal(lstatSync(damaged(2)).ino, second, 'the second damaged copy takes the next unused name');
    assert.deepEqual(readFileSync(join(damaged(2), 'crlf.txt')), secondDamage);
    assert.equal(lstatSync(damaged(1)).ino, first);
    assert.deepEqual(fileBytes(damaged(1)), kept);
    pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir: canonical });
    holds(commitId, `${commitId}.damaged-1`, `${commitId}.damaged-2`);

    pin.repairWorkflowSnapshot({ cwd, commit: other });
    pin.verifyWorkflowSnapshot({ cwd, commit: other, dir: join(store, other) });
    holds(commitId, `${commitId}.damaged-1`, `${commitId}.damaged-2`, other);

    const missing = 'a'.repeat(40);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${missing}^{commit}`], { cwd, env }).status, 0, 'the id is absent from the object store');
    const otherCopy = lstatSync(join(store, other)).ino;
    const otherBytes = fileBytes(join(store, other));
    assert.throws(() => pin.repairWorkflowSnapshot({ cwd, commit: missing }), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(join(store, missing)), error.message);
      assert.ok(error.message.length > join(store, missing).length, `the message names a cause: ${error.message}`);
      return true;
    });
    holds(commitId, `${commitId}.damaged-1`, `${commitId}.damaged-2`, other);
    assert.equal(lstatSync(join(store, other)).ino, otherCopy);
    assert.deepEqual(fileBytes(join(store, other)), otherBytes);
    pin.verifyWorkflowSnapshot({ cwd, commit: other, dir: join(store, other) });
  } finally {
    writable(store);
  }
});

// Replaces a loose blob's stored object with another's, so git still lists the old ID but reads the other bytes.
const substitute = (cwd, id, other) => {
  const objects = join(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'objects');
  const stored = (object) => join(objects, object.slice(0, 2), object.slice(2));
  chmodSync(stored(id), 0o644);
  writeFileSync(stored(id), readFileSync(stored(other)));
};

test('workflow pin: keeps the canonical copy when the staged copy fails verification', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = literalCommit(cwd);
  const tree = new Map(literalTree(cwd, commitId).map((entry) => [entry.path, entry]));
  const store = join(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'fabraik-workflow');
  const canonical = join(store, commitId);
  try {
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    const copy = lstatSync(canonical).ino;
    const bytes = fileBytes(canonical);

    const crlf = tree.get('crlf.txt').object;
    substitute(cwd, crlf, tree.get('run.sh').object);
    assert.notEqual(blobId(cwd, blob(cwd, crlf)), crlf, 'git now reads bytes that do not hash to the listed ID');
    assert.throws(() => pin.repairWorkflowSnapshot({ cwd, commit: commitId }), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(canonical), error.message);
      assert.ok(error.message.includes('crlf.txt'), error.message);
      return true;
    });
    assert.deepEqual(readdirSync(store), [commitId], 'no staging directory or damaged copy remains');
    assert.equal(lstatSync(canonical).ino, copy, 'the canonical copy is not moved');
    assert.deepEqual(fileBytes(canonical), bytes);
    pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir: canonical });
  } finally {
    writable(store);
  }
});

test('workflow pin: refuses a path it cannot write byte-exactly', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const name = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff]), Buffer.from('.txt')]);
  const id = run(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { encoding: 'utf8', input: 'bad\n' }).trim();
  run(cwd, ['update-index', '--add', '-z', '--index-info'], { input: Buffer.concat([Buffer.from(`100644 ${id}\t`), name, Buffer.from([0])]) });
  git(cwd, 'commit', '-m', 'bad name');
  const commitId = git(cwd, 'rev-parse', 'HEAD');
  assert.ok(run(cwd, ['ls-tree', '-r', '-z', '--name-only', commitId], {}).includes(name), 'the tree holds the raw byte');
  const lossy = name.toString('utf8');
  assert.notDeepEqual(Buffer.from(lossy), name, 'a UTF-8 decode cannot keep the name');
  const namesProblem = (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('bad-'), error.message);
    assert.match(error.message, /UTF-8/i);
    return true;
  };

  const into = join(dirname(cwd), 'snapshot');
  mkdirSync(into);
  assert.throws(() => pin.workflowSnapshot({ cwd, commit: commitId, into }), namesProblem);
  assert.deepEqual(readdirSync(into), [], 'nothing is written under a lossy name');

  // The lossy translation of the tree: every other path intact, the bad name decoded with its replacement character.
  const translated = join(dirname(cwd), 'translated');
  mkdirSync(translated);
  writeFileSync(join(translated, 'first'), blob(cwd, `${commitId}:first`));
  writeFileSync(join(translated, lossy), blob(cwd, id));
  assert.throws(() => pin.verifyWorkflowSnapshot({ cwd, commit: commitId, dir: translated }), namesProblem);
});

test('workflow pin: refuses an extra entry whose name only decodes like a tracked one', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const tracked = Buffer.from('bad-�.txt');
  const twin = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff]), Buffer.from('.txt')]);
  assert.equal(twin.toString('utf8'), tracked.toString('utf8'), 'both names decode to the same string');
  assert.notDeepEqual(twin, tracked);
  const id = run(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { encoding: 'utf8', input: 'bad\n' }).trim();
  run(cwd, ['update-index', '--add', '-z', '--index-info'], { input: Buffer.concat([Buffer.from(`100644 ${id}\t`), tracked, Buffer.from([0])]) });
  git(cwd, 'commit', '-m', 'replacement-character name');
  const commitId = git(cwd, 'rev-parse', 'HEAD');

  const dir = intact(cwd, commitId);
  writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), twin]), 'extra\n');
  assert.ok(readdirSync(dir, { encoding: 'buffer' }).some((entry) => entry.equals(twin)), 'the invalid-byte twin sits on disk');
  refuses(cwd, commitId, dir, 'bad-');
});

// The blob read is bounded by `readBlobs(cwd, objects, maxOutput)`; a tree's blobs together exceed one read's bound.
test('workflow pin: reads more blob bytes than one read holds', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const bound = 4096;
  for (const [i, fill] of ['a', 'b', 'c'].entries()) stage(cwd, `large-${i}.bin`, '100644', Buffer.alloc(3000, fill));
  git(cwd, 'commit', '-m', 'large');
  const commitId = git(cwd, 'rev-parse', 'HEAD');
  const objects = literalTree(cwd, commitId).map((entry) => entry.object);
  const expected = new Map(objects.map((object) => [object, blob(cwd, object)]));
  for (const bytes of expected.values()) assert.ok(bytes.length < bound);
  assert.ok([...expected.values()].reduce((sum, bytes) => sum + bytes.length, 0) > bound);

  assert.deepEqual(pin.readBlobs(cwd, objects, bound), expected);
  intact(cwd, commitId);
});

const SETTINGS = '.claude/settings.json';
const PIN_MODULE = 'scripts/lib/workflow-pin.mjs';
const LANE_TEST = 'scripts/lib/delivery-lane-contract.test.mjs';

const CONTRACT_FILES = {
  [SETTINGS]: `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop' }] }] } }, null, 2)}\n`,
  [PIN_MODULE]: 'export const pin = 1;\nexport const second = 2;\n',
  [LANE_TEST]: 'export const lane = 1;\n',
};
// Commits the three shared contracts at the root and returns the commit.
const contracts = (root) => {
  for (const [path, content] of Object.entries(CONTRACT_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'add', ...Object.keys(CONTRACT_FILES));
  git(root, 'commit', '-m', 'contracts');
  return git(root, 'rev-parse', 'HEAD');
};

test('workflow pin: names drift', (t) => {
  const root = repository(t);
  const commitId = contracts(root);
  const drift = () => pin.workflowDrift({ cwd: root, commit: commitId, root });
  // The committed bytes as git reads them, so a clean root never depends on the module under test.
  const committed = (path) => blob(root, `${commitId}:${path}`);
  const restore = () => {
    for (const path of Object.keys(CONTRACT_FILES)) writeFileSync(join(root, path), committed(path));
  };
  const settings = () => JSON.parse(committed(SETTINGS).toString('utf8'));

  assert.deepEqual(drift(), []);

  const otherKey = settings();
  otherKey.permissions.allow.push('Bash(pwd)');
  writeFileSync(join(root, SETTINGS), JSON.stringify(otherKey));
  assert.notDeepEqual(readFileSync(join(root, SETTINGS)), committed(SETTINGS));
  assert.deepEqual(drift(), [], 'another key and the formatting are not the hooks contract');
  restore();

  const hooks = settings();
  hooks.hooks.Stop[0].hooks[0].command = 'changed';
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(hooks, null, 2)}\n`);
  assert.deepEqual(drift(), [SETTINGS]);
  restore();

  for (const path of [PIN_MODULE, LANE_TEST]) {
    writeFileSync(join(root, path), Buffer.concat([committed(path), Buffer.from('// changed\n')]));
    assert.deepEqual(drift(), [path]);
    restore();
  }

  rmSync(join(root, LANE_TEST));
  assert.deepEqual(drift(), [LANE_TEST], 'a contract the root cannot read is drift');
  restore();
  assert.deepEqual(drift(), []);

  writeFileSync(join(root, SETTINGS), '{ "hooks": ');
  assert.throws(drift, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(join(root, SETTINGS)), error.message);
    return true;
  });
});

test("ANTI-REGRESSION: drift ignores CRLF line endings from Git's checkout and still names every content change", (t) => {
  const root = repository(t);
  git(root, 'config', 'core.autocrlf', 'true');
  // The repository's own settings and attributes override a developer's global file, so core.autocrlf alone decides the checkout.
  const attributes = join(root, git(root, 'rev-parse', '--git-path', 'info/attributes'));
  mkdirSync(dirname(attributes), { recursive: true });
  writeFileSync(attributes, '* !text !eol !crlf !working-tree-encoding !filter\n');
  const commitId = contracts(root);
  const drift = (commit = commitId) => pin.workflowDrift({ cwd: root, commit, root });

  for (const path of Object.keys(CONTRACT_FILES)) rmSync(join(root, path));
  git(root, 'checkout', 'HEAD', '--', ...Object.keys(CONTRACT_FILES));
  assert.equal(readFileSync(join(root, PIN_MODULE), 'latin1').split('\r\n').length - 1, 2, `${PIN_MODULE} is checked out with two CRLF pairs`);
  assert.ok(readFileSync(join(root, LANE_TEST)).includes('\r\n'), `${LANE_TEST} is checked out with CRLF`);
  for (const path of [PIN_MODULE, LANE_TEST]) {
    assert.ok(!blob(root, `${commitId}:${path}`).includes('\r'), `${path} holds no CR in its blob`);
  }
  assert.deepEqual(drift(), [], 'a CRLF checkout of the same content is no drift');

  writeFileSync(join(root, LANE_TEST), Buffer.concat([readFileSync(join(root, LANE_TEST)), Buffer.from([0])]));
  assert.deepEqual(drift(), [LANE_TEST], 'an appended zero byte is drift');
  git(root, 'checkout', 'HEAD', '--', LANE_TEST);

  const laneTest = readFileSync(join(root, LANE_TEST));
  writeFileSync(join(root, LANE_TEST), laneTest.subarray(0, -2));
  assert.deepEqual(drift(), [LANE_TEST], 'a removed final line ending is drift');
  git(root, 'checkout', 'HEAD', '--', LANE_TEST);

  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\rexport const second = 2;\r\n');
  assert.deepEqual(drift(), [PIN_MODULE], 'a lone carriage return is drift');

  writeFileSync(join(root, PIN_MODULE), 'export const \rpin = 1;\r\nexport const second = 2;\r\n');
  assert.deepEqual(drift(), [PIN_MODULE], 'a carriage return inside a line is drift');

  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\r\r\nexport const second = 2;\r\n');
  assert.deepEqual(drift(), [PIN_MODULE], 'an extra carriage return before CRLF is drift');

  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\r\nexport const second = 2;\r\n\r');
  assert.deepEqual(drift(), [PIN_MODULE], 'a trailing lone carriage return is drift');

  git(root, 'config', 'core.autocrlf', 'false');
  // The leading CRLF line is shared by every builder call, so the blob and each copy carry a CR at the same place.
  const mixedEndingContract = (firstEnding, lastEnding, byte) => Buffer.concat([Buffer.from(`export const zero = 0;\r\nexport const pin = 1;${firstEnding}export const second = 2; // `), Buffer.from([byte]), Buffer.from(lastEnding)]);
  stage(root, PIN_MODULE, '100644', mixedEndingContract('\r\n', '\n', 0xff));
  git(root, 'commit', '-m', 'crlf contract');
  const crlfCommit = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), mixedEndingContract('\n', '\r\n', 0xff));
  assert.deepEqual(drift(crlfCommit), [], 'a copy with its CRLF on a different line from the blob is no drift');
  writeFileSync(join(root, PIN_MODULE), mixedEndingContract('\n', '\r\n', 0xfe));
  assert.deepEqual(drift(crlfCommit), [PIN_MODULE], 'a changed non-UTF-8 byte is drift');

  stage(root, PIN_MODULE, '100644', Buffer.from('export const pin = 1;\r\nexport const second = 2'));
  git(root, 'commit', '-m', 'no final newline');
  const noFinalNewline = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\nexport const second = 2');
  assert.deepEqual(drift(noFinalNewline), [], 'an LF copy with no final newline is no drift');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\nexport const second = 3');
  assert.deepEqual(drift(noFinalNewline), [PIN_MODULE], 'a changed last byte is drift');

  stage(root, PIN_MODULE, '100644', Buffer.from('export const \rpin = 1;\nexport const second = 2;\n'));
  git(root, 'commit', '-m', 'lone CR in the pinned blob');
  const loneCarriageReturn = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\nexport const second = 2;\n');
  assert.deepEqual(drift(loneCarriageReturn), [PIN_MODULE], 'a lone carriage return in the pinned blob is drift');

  stage(root, PIN_MODULE, '100644', Buffer.from('export const pin = 1;\nexport const second = 2;\r'));
  git(root, 'commit', '-m', 'final lone CR in the pinned blob');
  const finalLoneCarriageReturn = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\nexport const second = 2;');
  assert.deepEqual(drift(finalLoneCarriageReturn), [PIN_MODULE], 'a final lone carriage return in the pinned blob is drift');

  stage(root, PIN_MODULE, '100644', Buffer.from('export const pin = 1;\rexport const second = 2;\n'));
  git(root, 'commit', '-m', 'lone CR line ending in the pinned blob');
  const loneCarriageReturnLineEnding = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\nexport const second = 2;\n');
  assert.deepEqual(drift(loneCarriageReturnLineEnding), [PIN_MODULE], 'a lone carriage return line ending in the pinned blob is drift');

  stage(root, PIN_MODULE, '100644', Buffer.from('export const pin = 1;\r\r\nexport const second = 2;\n'));
  git(root, 'commit', '-m', 'extra CR before CRLF in the pinned blob');
  const extraCarriageReturn = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, PIN_MODULE), 'export const pin = 1;\r\nexport const second = 2;\n');
  assert.deepEqual(drift(extraCarriageReturn), [PIN_MODULE], 'an extra carriage return before CRLF in the pinned blob is drift');
});

test('workflow pin: allows drift only for the exact one-argument watcher cleanup', () => {
  assert.equal(pin.watchDriftAllowed(['962']), true);
  for (const args of [['--hold-delivery'], ['--delivery-ready'], ['--delivery-pr'], ['962', '--held-delivery'], ['962', 'extra'], []]) {
    assert.equal(pin.watchDriftAllowed(args), false, JSON.stringify(args));
  }
});

test('workflow pin: separates code and operating roots', () => {
  const root = join(tmpdir(), 'workflow-roots', 'repository');
  const commitId = '0123456789abcdef0123456789abcdef01234567';
  const code = join(root, '.git', 'fabraik-workflow', commitId);
  assert.deepEqual(pin.workflowRoots(pathToFileURL(join(code, 'scripts', 'lib', 'x.mjs')).href), { code, operating: root });
  assert.deepEqual(pin.workflowRoots(pathToFileURL(join(root, '.claude', 'hooks', 'x.mjs')).href), { code: root, operating: root });
});

const NO_PIN = 'this job has no recorded workflow version; resume it through the coordinator';
const refusesPin = (options, ...parts) => assert.throws(() => pin.verifyJobPin(options), (error) => {
  assert.ok(error instanceof Error);
  for (const part of parts) assert.ok(error.message.includes(part), error.message);
  return true;
});

test('workflow pin: refuses a non-canonical or missing pin', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = contracts(cwd);
  // The canonical path from the fixture's own common directory, never the module under test.
  const store = join(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'fabraik-workflow');
  const canonical = join(store, commitId);
  const pinned = { env: { FABRAIK_WORKFLOW_ROOT: canonical }, cwd };
  try {
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    pin.verifyJobPin({ ...pinned, drift: false });
    pin.verifyJobPin({ ...pinned, drift: true });
    refusesPin({ env: {}, cwd, drift: false }, NO_PIN);
    refusesPin({ env: { FABRAIK_WORKFLOW_ROOT: join(store, '1123456789abcdef0123456789abcdef01234567') }, cwd, drift: false }, 'cannot resolve the workflow root');

    const copy = intact(cwd, commitId);
    assert.equal(copy.startsWith(store), false);
    refusesPin({ env: { FABRAIK_WORKFLOW_ROOT: copy }, cwd, drift: false }, copy);

    damage(join(canonical, PIN_MODULE), 0);
    refusesPin({ ...pinned, drift: false });

    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    pin.verifyJobPin({ ...pinned, drift: true });
    writeFileSync(join(cwd, PIN_MODULE), Buffer.concat([blob(cwd, `${commitId}:${PIN_MODULE}`), Buffer.from('// changed\n')]));
    refusesPin({ ...pinned, drift: true }, PIN_MODULE);
    pin.verifyJobPin({ ...pinned, drift: false });
  } finally {
    writable(store);
  }
});

test('workflow pin: verifies from a subfolder of the checkout', { skip: OFF_LINUX }, (t) => {
  const cwd = repository(t);
  const commitId = contracts(cwd);
  const sub = join(cwd, 'scripts', 'lib');
  assert.ok(lstatSync(sub).isDirectory());
  const store = join(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'fabraik-workflow');
  const canonical = join(store, commitId);
  try {
    const copy = intact(cwd, commitId);
    pin.verifyWorkflowSnapshot({ cwd: sub, commit: commitId, dir: copy });
    pin.repairWorkflowSnapshot({ cwd, commit: commitId });
    pin.verifyJobPin({ env: { FABRAIK_WORKFLOW_ROOT: canonical }, cwd: sub, drift: false });

    damage(join(copy, PIN_MODULE), 0);
    refuses(sub, commitId, copy, PIN_MODULE);
    damage(join(canonical, PIN_MODULE), 0);
    refusesPin({ env: { FABRAIK_WORKFLOW_ROOT: canonical }, cwd: sub, drift: false });
  } finally {
    writable(store);
  }
});
