// Requirement-derived paths and fabricated manifests keep the policy oracle independent.
// Two fresh remotes prove the real hook; direct gate scenarios clone one prepared seed.
// Measured on local Linux: the seven focused invocations total 3.04 s including runner startup.
// Remove this file with the direct documentation route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureShell } from './posix-shell.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHELL = fixtureShell();
const MANIFEST_PATH = '.agents/factory-manifest.json';
const MANIFEST = JSON.stringify({ entries: [{ path: 'docs/research/shared-guide.md' }] });
const SHAS = ['1'.repeat(40), '2'.repeat(40)];

function write(root, path, source = `${path}\n`) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

function executable(root, path, source) {
  write(root, path, source);
  chmodSync(join(root, path), 0o755);
}

function installGate(root) {
  for (const path of ['scripts/gates/pre-push-main', 'scripts/lib/docs-route.mjs']) {
    executable(root, path, readFileSync(join(ROOT, path)));
  }
  write(root, MANIFEST_PATH, MANIFEST);
}

function environment(root, bin) {
  const dropped = /^(GIT_.*|NODE_.*|RUN_TESTS|PATH)$/i;
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key))),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: root,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.dev',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.dev',
  };
}

function withFixture(fn) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kestrel-docs-route-'));
  try {
    const bin = join(root, 'bin');
    executable(bin, 'npm', '#!/bin/sh\nexit 0\n');
    const env = environment(root, bin);
    const git = (cwd, ...args) => {
      const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stdout}${run.stderr}`);
      return run.stdout.trim();
    };
    fn({ root, bin, env, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedRepository(fixture, repo) {
  const { root, git } = fixture;
  git(root, 'init', '-q', '-b', 'main', repo);
  installGate(repo);
  executable(repo, '.githooks/pre-push', readFileSync(join(ROOT, '.githooks/pre-push')));
  executable(repo, 'node_modules/.bin/eslint', '#!/bin/sh\nexit 0\n');
  write(repo, 'scripts/lib/pass.test.mjs', "import { test } from 'node:test';\ntest('passes', () => {});\n");
  write(repo, 'bot.py', 'original product\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  return git(repo, 'rev-parse', 'HEAD');
}

function repository(fixture, repo) {
  const { git, env } = fixture;
  return {
    repo,
    git: (...args) => git(repo, ...args),
    commit: (paths) => {
      paths.forEach((path) => write(repo, path));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'change');
      return git(repo, 'rev-parse', 'HEAD');
    },
    gate: (...args) => {
      assert.ok(SHELL, 'a POSIX shell is required');
      return spawnSync(SHELL, ['scripts/gates/pre-push-main', ...args], { cwd: repo, env, encoding: 'utf8' });
    },
  };
}

function withScratchRemote(fn) {
  withFixture((fixture) => {
    const { root, env, git } = fixture;
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    seedRepository(fixture, repo);
    git(repo, 'remote', 'add', 'origin', remote);
    // Create main before activating the hook: creation is never a direct push.
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    git(repo, 'config', 'core.hooksPath', '.githooks');
    fn({
      ...repository(fixture, repo),
      remoteMain: () => git(remote, 'rev-parse', 'refs/heads/main'),
      push: () => spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: repo, env, encoding: 'utf8' }),
    });
  });
}

test('Kestrel direct gate admits a documentation push', () => {
  withScratchRemote(({ commit, push, remoteMain }) => {
    const before = remoteMain();
    const head = commit(['docs/README.md', 'docs/research/note.md', 'docs/research/chart.PNG']);
    const run = push();
    assert.equal(run.status, 0, run.stderr);
    assert.notEqual(head, before);
    assert.equal(remoteMain(), head);
  });
});

const ALLOWED = [
  'docs/README.md', 'docs/research/note.md', 'docs/research/deep/Note.MD',
  'docs/research/shot.png', 'docs/research/shot.JPG', 'docs/research/shot.jpeg',
  'docs/research/steps.gif', 'docs/research/chart.svg', 'docs/research/photo.webp',
];
const REFUSED = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md', '.agents/REPOSITORY.md',
  'bot.py', 'speech.py', 'asr_worker.py', 'hermes_worker.py', 'run-voice.sh',
  'docs/CODING-STANDARDS.md', 'docs/TESTING-STRATEGY.md', 'docs/DESIGN-SYSTEM.md',
  'docs/ISSUE-TRACKER.md', 'docs/DOC-SWEEP.md', 'docs/SWEEP-TRIAGE.md',
  'docs/WEEKLY-RETRO.md', 'docs/AI-WORKFLOW.md', 'docs/AI-WORKFLOW-build.md',
  'docs/adr/0001-decision.md', 'docs/new.md', 'docs/design/photo.png',
  'docs/commercial/note.md', 'docs/discovery/note.md', 'docs/engineering/note.md',
  '.agents/factory-manifest.json', '.agents/skills/resume/SKILL.md',
  '.claude/hooks/block-unsafe-git.mjs', '.codex/hooks/block-unsafe-git.mjs',
  '.claude/settings.json', '.codex/hooks.json', '.codex/rules/playwright.rules',
  '.claude/agents/builder.md', '.codex/agents/builder.toml',
  '.githooks/pre-push', '.githooks/README.md', '.github/workflows/tests.yml',
  '.github/pull_request_template.md', 'scripts/gates/pre-push-main',
  'scripts/lib/docs-route.mjs', 'scripts/lib/docs-route.test.mjs', 'tests/test_local_commands.py',
  'package.json', 'package-lock.json', 'eslint.config.mjs', 'requirements-test.txt',
  'Docs/research/note.md', 'docs/Research/note.md', 'docsx/research/note.md',
  'docs/researchx/note.md', 'src/docs/research/note.md', 'docs/README.md.md',
  'docs/research/note.txt', 'docs/research/note.docx', 'docs/research/note.pdf',
  'docs/research/clip.mp4', 'docs/research/clip.mov', 'docs/research/clip.webm',
  'docs/research/photo.avif', 'docs/research/run.sh', 'docs/research/code.js',
  'docs/research/code.mjs', 'docs/research/data.json', 'docs/research/data.csv',
  'docs/research/page.html', 'docs/research/noextension', 'docs/research/guide.md.sh',
  '', 'docs/research/.hidden.md', 'docs/research/.hidden/note.md',
  'docs/research//note.md', 'docs/research/./note.md', 'docs/research/../note.md',
  'docs/research/back\\slash.md', 'docs/research/line\nbreak.md',
  'docs/research/tab\tname.md', 'docs/research/carriage\rreturn.md',
  'docs/research/delete\x7fname.md', 'docs/research/control\x85name.md',
  '"docs/research/line\\nbreak.md"',
  'docs/research/AGENTS.md', 'docs/research/deep/aGeNtS.MD',
  'docs/research/CLAUDE.md', 'docs/research/deep/SKILL.md',
  'docs/research/deep/CODING-STANDARDS.md', 'docs/research/deep/TESTING-STRATEGY.md',
  'docs/research/deep/DESIGN-SYSTEM.md', 'docs/research/deep/ISSUE-TRACKER.md',
  'docs/research/deep/DOC-SWEEP.md', 'docs/research/deep/SWEEP-TRIAGE.md',
  'docs/research/deep/WEEKLY-RETRO.md', 'docs/research/deep/AI-WORKFLOW.md',
  'docs/research/deep/ai-workflow-runtime.MD',
];

test('Kestrel documentation paths admit only the selected records and media', async () => {
  const { docsRouteRefusals } = await import('./docs-route.mjs');
  assert.deepEqual(docsRouteRefusals(ALLOWED, []), []);
  for (const path of REFUSED) {
    const refusals = docsRouteRefusals([path], []);
    assert.equal(refusals.length, 1, `${JSON.stringify(path)} must refuse without manifest help`);
    assert.equal(refusals[0].path, path);
    assert.ok(refusals[0].reason);
  }
  assert.deepEqual(docsRouteRefusals(['docs/research/note.md', 'bot.py', 'README.md'], []).map(({ path }) => path), ['bot.py', 'README.md']);
});


test('Kestrel documentation paths refuse manifest-listed records', async () => {
  const { docsRouteRefusals } = await import('./docs-route.mjs');
  const path = 'docs/research/shared-guide.md';
  assert.deepEqual(docsRouteRefusals([path], []), []);
  assert.deepEqual(docsRouteRefusals([path], [path]), [{ path, reason: 'a shared factory file' }]);
  assert.deepEqual(docsRouteRefusals(['docs/research/note.md', path, 'bot.py'], [path]).map(({ path }) => path), [path, 'bot.py']);
});

test('Kestrel pre-push blocks a change refused by remote main', () => {
  withScratchRemote(({ repo, git, commit, push, remoteMain }) => {
    const before = remoteMain();
    executable(repo, 'scripts/gates/pre-push-main', '#!/bin/sh\nexit 0\n');
    write(repo, 'scripts/lib/docs-route.mjs', 'process.exit(0);\n');
    commit(['docs/research/note.md', 'bot.py', 'docs/research/shared-guide.md']);
    const run = push();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /bot\.py: outside the documentation locations/);
    assert.match(run.stderr, /scripts\/gates\/pre-push-main/);
    assert.match(run.stderr, /docs\/research\/shared-guide\.md: a shared factory file/);
    assert.match(run.stderr, /the gate as it stands on the remote's main/);
    assert.match(run.stderr, /pull request route/);
    assert.doesNotMatch(run.stderr, /refused docs\/research\/note\.md/);
    assert.equal(remoteMain(), before);
    assert.notEqual(git('rev-parse', 'HEAD'), before);
  });
});

function withClones(fn) {
  withFixture((fixture) => {
    const seedRepo = join(fixture.root, 'seed');
    const seed = seedRepository(fixture, seedRepo);
    const clone = (name) => {
      const repo = join(fixture.root, name);
      fixture.git(fixture.root, 'clone', '-q', seedRepo, repo);
      return repository(fixture, repo);
    };
    fn({ seed, clone });
  });
}

function refused(run, reason) {
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, reason);
  assert.match(run.stderr, /pull request route/);
}

test('Kestrel direct gate judges every changed path in commit history', () => {
  withClones(({ seed, clone }) => {
    const restored = clone('restored');
    restored.commit(['bot.py']);
    restored.git('checkout', seed, '--', 'bot.py');
    const head = restored.commit(['docs/research/note.md']);
    assert.equal(restored.git('diff', '--name-only', seed, head), 'docs/research/note.md');
    refused(restored.gate(seed, head), /bot\.py/);

    const renamed = clone('renamed');
    mkdirSync(join(renamed.repo, 'docs/research'), { recursive: true });
    renamed.git('mv', 'bot.py', 'docs/research/moved.md');
    const moved = renamed.commit([]);
    assert.match(renamed.git('diff', '--name-status', '--find-renames', seed, moved), /^R100\s+bot\.py/);
    refused(renamed.gate(seed, moved), /bot\.py/);

    const merged = clone('merged');
    merged.git('config', 'log.diffMerges', 'combined');
    merged.git('config', 'log.showSignature', 'true');
    merged.git('checkout', '-q', '-b', 'side');
    merged.commit(['docs/research/note.md']);
    merged.git('checkout', '-q', 'main');
    const main = merged.commit(['bot.py']);
    merged.git('merge', '-q', '-s', 'ours', '--no-commit', '--no-ff', 'side');
    merged.git('read-tree', '--reset', '-u', 'side');
    merged.git('commit', '-q', '-m', 'discard first-parent code');
    assert.equal(merged.git('rev-parse', 'HEAD^'), main);
    assert.equal(merged.git('rev-parse', 'HEAD^{tree}'), merged.git('rev-parse', 'side^{tree}'));
    refused(merged.gate(main, merged.git('rev-parse', 'HEAD')), /bot\.py/);

    const reversed = clone('reversed');
    const docs = reversed.commit(['docs/research/side.md']);
    reversed.git('checkout', '-q', '-b', 'remote', seed);
    const remote = reversed.commit(['bot.py']);
    reversed.git('checkout', '-q', 'main');
    reversed.git('merge', '-q', '-s', 'ours', '--no-commit', '--no-ff', 'remote');
    const rollback = reversed.commit(['docs/research/merged.md']);
    assert.equal(reversed.git('rev-parse', `${rollback}^1`), docs);
    assert.equal(reversed.git('rev-parse', `${rollback}^2`), remote);
    assert.equal(reversed.git('merge-base', '--is-ancestor', remote, rollback), '');
    assert.equal(reversed.git('diff', '--name-only', seed, docs), 'docs/research/side.md');
    assert.equal(reversed.git('diff', '--name-only', docs, rollback), 'docs/research/merged.md');
    assert.deepEqual(reversed.git('diff', '--name-only', remote, rollback).split('\n'), [
      'bot.py', 'docs/research/merged.md', 'docs/research/side.md',
    ]);
    refused(reversed.gate(remote, rollback), /bot\.py/);

    const twin = clone('reversed-docs');
    const twinDocs = twin.commit(['docs/research/side.md']);
    twin.git('checkout', '-q', '-b', 'remote', seed);
    const twinRemote = twin.commit(['docs/research/remote.md']);
    twin.git('checkout', '-q', 'main');
    twin.git('merge', '-q', '-s', 'ours', '--no-commit', '--no-ff', 'remote');
    const twinMerge = twin.commit(['docs/research/merged.md']);
    assert.equal(twin.git('rev-parse', `${twinMerge}^1`), twinDocs);
    assert.equal(twin.git('rev-parse', `${twinMerge}^2`), twinRemote);
    const admittedTwin = twin.gate(twinRemote, twinMerge);
    assert.equal(admittedTwin.status, 0, admittedTwin.stderr);

    const empty = clone('empty-final-diff');
    empty.commit(['docs/research/temporary.md']);
    empty.git('rm', '-q', 'docs/research/temporary.md');
    const emptyHead = empty.commit([]);
    assert.equal(empty.git('diff', '--name-only', seed, emptyHead), '');
    const admittedEmpty = empty.gate(seed, emptyHead);
    assert.equal(admittedEmpty.status, 0, admittedEmpty.stderr);

    const submodule = clone('submodule');
    submodule.git('config', 'diff.ignoreSubmodules', 'all');
    submodule.git('config', 'log.showSignature', 'true');
    submodule.git('update-index', '--add', '--cacheinfo', `160000,${seed},vendor/module`);
    // Preserve the staged gitlink: add -A would remove its absent working directory.
    submodule.git('commit', '-q', '-m', 'add gitlink');
    const linked = submodule.git('rev-parse', 'HEAD');
    refused(submodule.gate(seed, linked), /vendor\/module/);
  });
});

test('Kestrel direct gate requires a clean matching fast-forward', () => {
  withClones(({ seed, clone }) => {
    const dirty = clone('dirty');
    dirty.git('config', 'log.showSignature', 'true');
    dirty.git('config', 'diff.ignoreSubmodules', 'all');
    const head = dirty.commit(['docs/research/note.md']);
    assert.equal(dirty.gate(seed, head).status, 0);
    write(dirty.repo, 'docs/research/note.md', 'unstaged\n');
    refused(dirty.gate(seed, head), /uncommitted changes/);
    dirty.git('add', 'docs/research/note.md');
    refused(dirty.gate(seed, head), /uncommitted changes/);

    // A contaminated clone cannot change its sibling's tracked bytes or admission.
    const sibling = clone('sibling');
    const clean = sibling.commit(['docs/research/note.md']);
    assert.equal(sibling.git('status', '--porcelain'), '');
    assert.equal(sibling.gate(seed, clean).status, 0);
    assert.equal(readFileSync(join(sibling.repo, 'docs/research/note.md'), 'utf8'), 'docs/research/note.md\n');

    sibling.git('reset', '-q', '--hard', seed);
    refused(sibling.gate(seed, clean), /not the checked-out content/);
    const divergent = sibling.commit(['docs/research/other.md']);
    refused(sibling.gate(clean, divergent), /not a fast-forward/);
    refused(sibling.gate(divergent, divergent), /no commit/);
    refused(sibling.gate('0'.repeat(40), divergent), /creating main/);
    refused(sibling.gate(seed, '0'.repeat(40)), /deleting main/);
  });
});

function withFakeGate(fn) {
  withFixture(({ root, bin, env }) => {
    installGate(root);
    const calls = join(root, 'git-calls');
    // One shell per command, never another Node boot. Partial listings deliberately fail after output.
    executable(bin, 'git', `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_CALLS"
case $1 in
  (merge-base) exit 0 ;;
  (rev-list) printf '%s\\n' '${'3'.repeat(40)}'; exit "\${FAKE_COMMITS_STATUS:-0}" ;;
  (-c)
    case $3 in
      (log) printf '%s\\n' "$FAKE_PATH"; exit "\${FAKE_PATHS_STATUS:-0}" ;;
      (diff) printf '%s\\n' "$FAKE_RANGE_PATH"; exit "\${FAKE_RANGE_STATUS:-0}" ;;
    esac
    ;;
  (rev-parse) printf '%s\\n' '${'4'.repeat(40)}'; exit 0 ;;
  (diff) [ "$2" = --quiet ] && [ "$3" = HEAD ] && exit 0 ;;
esac
exit 2
`);
    const fakeEnv = { ...env, FAKE_GIT_CALLS: calls, FAKE_PATH: 'docs/research/note.md', FAKE_RANGE_PATH: 'docs/research/note.md' };
    fn({
      root,
      calls,
      gateWithoutNode: () => spawnSync(SHELL, ['-c', 'PATH=$1; export PATH; shift; . scripts/gates/pre-push-main', 'gate', bin, ...SHAS], {
        cwd: root, env: fakeEnv, encoding: 'utf8',
      }),
      gate: (args = SHAS, extraEnv = {}) => spawnSync(SHELL, ['scripts/gates/pre-push-main', ...args], {
        cwd: root, env: { ...fakeEnv, ...extraEnv }, encoding: 'utf8',
      }),
      cli: (input, args = []) => spawnSync(process.execPath, ['scripts/lib/docs-route.mjs', ...args], {
        cwd: root, env: fakeEnv, input, encoding: 'utf8',
      }),
    });
  });
}

test('Kestrel direct gate refuses incomplete or corrupt inputs', () => {
  assert.ok(SHELL, 'a POSIX shell is required');
  withFakeGate(({ root, calls, gate, gateWithoutNode, cli }) => {
    for (const args of [[], [SHAS[0]], [...SHAS, SHAS[0]], ['bad', SHAS[1]], ['g'.repeat(40), SHAS[1]], ['1'.repeat(39), SHAS[1]], [SHAS[0], '2'.repeat(41)]]) {
      refused(gate(args), /expected exactly|40 hexadecimal/);
      assert.equal(existsSync(calls), false, 'invalid arguments must refuse before Git work');
    }
    assert.equal(gate().status, 0, 'fake supplies one complete qualifying commit and a clean matching tree');
    refused(gate(SHAS, { FAKE_COMMITS_STATUS: '1' }), /listing the pushed commits failed/);
    refused(gate(SHAS, { FAKE_PATHS_STATUS: '1' }), /listing the changed paths failed/);
    refused(gate(SHAS, { FAKE_RANGE_STATUS: '1' }), /listing the final changed paths failed/);
    refused(gate(SHAS, { FAKE_PATH: '' }), /no changed paths/);
    refused(cli('', ['unexpected']), /expected no arguments/);
    refused(cli(''), /no changed paths/);
    refused(cli('docs/research/note.md\nbot.py\n'), /bot\.py/);
    refused(gate(SHAS, { FAKE_PATH: 'docs/research/shared-guide.md' }), /a shared factory file/);

    const manifest = join(root, MANIFEST_PATH);
    for (const invalid of ['{', 'null', '{}', '{"entries":{}}', '{"entries":[{}]}', '{"entries":[null]}', '{"entries":[{"path":""}]}', '{"entries":[{"path":7}]}']) {
      write(root, MANIFEST_PATH, invalid);
      refused(gate(), /cannot read \.agents\/factory-manifest\.json/);
    }
    rmSync(manifest);
    refused(gate(), /cannot read \.agents\/factory-manifest\.json/);
    mkdirSync(manifest);
    refused(gate(), /cannot read \.agents\/factory-manifest\.json/);
    rmSync(manifest, { recursive: true });
    write(root, MANIFEST_PATH, MANIFEST);
    // An otherwise complete shell/Git environment with no Node interpreter available.
    refused(gateWithoutNode(), /node is not on PATH/);
  });
});
