// precommit.test.mjs — mutation-proof tests for .githooks/pre-commit and its pre-merge-commit delegate.
//
// These tests run the REAL hooks (read fresh off disk) in scratch git repos:
//   1. a red scripts/lib test is NOT a pre-commit concern (pre-push owns the suite)
//   2. a staged agent definition that would be silently dropped   → hook BLOCKS
//   3. a staged validator variant, the real one in the working tree → the STAGED one RUNS
//   4. a staged divergent charter, working-tree validator deleted  → hook BLOCKS
//   5. a staged validator deletion alongside an agent change       → hook BLOCKS
//   6. a malformed staged seat hidden by a staged export-ignore    → hook BLOCKS
//   7. a malformed staged seat a local smudge filter would repair   → hook BLOCKS
//   8. pre-merge-commit with a clean staged agent pair passes, with a divergent pair → hook BLOCKS
//   9. a product gate at scripts/gates/pre-commit: passing, absent, failing, unavailable, and
//      non-executable, each with only an unrelated staged change → the gate alone decides
//  10. a commit staging only the repository profile or a vendored upstream skill → the doc-lint advisory RUNS, never blocks
//  11. a staged removal of one runtime's seat folder passes only with a STAGED settings file naming the other runtime
// The product's own gate is tested with the product.
//
// Run: node --test scripts/lib/   (or `npm run test:scripts`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixShell } from './posix-shell.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks/pre-commit');
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
// The located POSIX shell: `sh` off Windows, Git for Windows' sh.exe on it, null when there is none.
const SHELL = posixShell();
const NO_SHELL = 'a POSIX shell is required: install Git for Windows';

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

// Scratch repo with a committed baseline: a copy of the REAL pre-commit hook.
function initBaseRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.githooks'), { recursive: true });
  writeFileSync(join(repo, '.githooks', 'pre-commit'), readFileSync(HOOK, 'utf8'));
  chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755);
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base']);
  return repo;
}

function runHook(repo) {
  assert.ok(SHELL, NO_SHELL);
  const r = spawnSync(SHELL, [join(repo, '.githooks', 'pre-commit')], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withScratchRoot(fn) {
  // realpathSync(tmpdir()) first: on macOS os.tmpdir() is a symlink, and a node CLI invoked
  // from the unresolved form reads its own import.meta.url through the resolved form, so a
  // self-check comparing the two silently never matches.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'precommit-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Copies the REAL agent-definition validator, and the module it imports, into the fixture repo.
function armAgentDefinitions(repo) {
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  for (const file of ['check-agents.mjs', 'runtimes.mjs']) {
    writeFileSync(join(repo, 'scripts', 'lib', file), readFileSync(join(LIB_DIR, file), 'utf8'));
  }
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(repo, '.codex', 'agents'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Fixture reviewer"\nmodel: opus\n---\nReview.\n');
  writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Fixture reviewer"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview.\n"""\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'arm agents']);
}

test('pre-commit: a staged scripts change with a red scripts-lib test is not blocked', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts', 'lib', 'red.test.mjs'),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => assert.equal(1, 2));\n'
    );
    git(repo, ['add', 'scripts/lib/red.test.mjs']);
    const r = runHook(repo);
    assert.equal(r.status, 0, 'pre-commit must not run the scripts/lib suite; pre-push is its sole local gate');
  });
});

// A stub stands in for the real lint: the claim is the hook's trigger, and the real lint is tested in its own suite.
test('pre-commit: a commit staging only the repository profile or a vendored upstream skill runs the doc-lint advisory and is not blocked', () => {
  for (const path of ['.agents/REPOSITORY.md', '.agents/upstream/source/skill/SKILL.md']) {
    withScratchRoot((root) => {
      const repo = initBaseRepo(root);
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      writeFileSync(join(repo, 'scripts', 'doc-lint.mjs'), 'console.error("STUB-DOC-LINT-RAN");\nprocess.exit(1);\n');
      git(repo, ['add', '-A']);
      git(repo, ['-c', 'user.email=test@test.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'arm doc-lint stub']);
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), '# Staged document\n');
      git(repo, ['add', path]);
      const r = runHook(repo);
      assert.match(r.stderr, /STUB-DOC-LINT-RAN/, `staging only ${path} must run the doc-lint advisory`);
      assert.equal(r.status, 0, `a failing doc-lint advisory must not block a commit staging only ${path}`);
    });
  }
});

test('pre-commit: a staged agent definition that would be silently dropped blocks with a named cause', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review: correctness first\n---\nReview.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    const claude = runHook(repo);
    // Mutation guard: drop the agent guard from the hook → exit 0 (only the agent definition is staged).
    assert.notEqual(claude.status, 0, 'a malformed Claude agent must block the commit');
    assert.match(claude.stderr, /reviewer\.md: unquoted colon/);

    git(repo, ['checkout', '--', '.claude/agents/reviewer.md']);
    git(repo, ['reset', '-q']);
    writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Fixture"\nmodel = "gpt-fixture"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\nnever closed\n');
    git(repo, ['add', '.codex/agents/reviewer.toml']);
    const codex = runHook(repo);
    assert.notEqual(codex.status, 0, 'an unclosed Codex agent must block the commit');
    assert.match(codex.stderr, /reviewer\.toml: developer_instructions triple-quote never closes/);
  });
});

test('pre-commit: a clean staged agent definition passes', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Fixture reviewer, updated"\nmodel: opus\n---\nReview.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    const r = runHook(repo);
    assert.equal(r.status, 0, `a clean agent edit must pass: ${r.stderr}`);
  });
});

// Price tag: recurring cost of the five STAGED agent-guard tests below is five scratch repos and
// seven hook runs. Removal condition: retire them when the agent guard leaves pre-commit.
// Mutation guard: revert the guard to the working-tree validator run → case 1 exits 0 and case 2 exits 1.
test('pre-commit: the agent guard validates the STAGED charters, not the working tree', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    const claudeHarder = '---\nname: reviewer\ndescription: "Fixture reviewer"\nmodel: opus\n---\nReview harder.\n';
    const codex = (body) => `name = "reviewer"\ndescription = "Fixture reviewer"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\n${body}\n"""\n`;

    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), claudeHarder);
    git(repo, ['add', '.claude/agents/reviewer.md']);
    writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), codex('Review harder.'));
    const divergentStaged = runHook(repo);
    assert.notEqual(divergentStaged.status, 0, 'a staged divergent reviewer pair must block despite an unstaged fix');
    assert.match(divergentStaged.stderr, /edit the reviewer charters together/);

    git(repo, ['add', '.codex/agents/reviewer.toml']);
    writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), codex('Review.'));
    const matchingStaged = runHook(repo);
    assert.equal(matchingStaged.status, 0, `a staged matching pair must pass despite an unstaged divergent edit: ${matchingStaged.stderr}`);
  });
});

test('pre-commit: the agent guard runs the STAGED validator, not the working-tree copy', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);

    // Stage a marker-printing validator via plumbing; the real one stays in the working tree.
    const markerBlob = git(repo, ['hash-object', '-w', '--stdin'], "console.error('staged validator ran');\nprocess.exit(1);\n").stdout.trim();
    git(repo, ['update-index', '--cacheinfo', `100644,${markerBlob},scripts/lib/check-agents.mjs`]);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Fixture reviewer, updated"\nmodel: opus\n---\nReview.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    const staged = runHook(repo);
    // Mutation guard: run the working-tree validator → the clean edit passes → exit 0.
    assert.notEqual(staged.status, 0, 'the staged validator variant must be the one that runs');
    assert.match(staged.stderr, /staged validator ran/);

    git(repo, ['reset', '-q']);
    git(repo, ['checkout', '--', '.']);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Fixture reviewer"\nmodel: opus\n---\nReview harder.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    rmSync(join(repo, 'scripts', 'lib', 'check-agents.mjs'));
    const deleted = runHook(repo);
    // Mutation guard: restore the `-f` working-tree guard → validation is skipped → exit 0.
    assert.notEqual(deleted.status, 0, 'deleting the working-tree validator must not skip the staged one');
    assert.match(deleted.stderr, /edit the reviewer charters together/);
  });
});

test('pre-commit: a staged deletion of the validator blocks the agent guard', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Fixture reviewer, updated"\nmodel: opus\n---\nReview.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    git(repo, ['rm', '-q', 'scripts/lib/check-agents.mjs']);
    const r = runHook(repo);
    // Mutation guard: drop the HEAD-present branch → the guard is skipped → exit 0.
    assert.notEqual(r.status, 0, 'a staged validator deletion must not skip the agent guard');
    assert.match(r.stderr, /staged for deletion/);
  });
});

test('pre-commit: failed temporary allocation cannot target the live checkout', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Updated fixture"\nmodel: opus\n---\nReview.\n');
    writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Updated fixture"\nmodel = "gpt-fixture"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview.\n"""\n');
    git(repo, ['add', '.claude/agents/reviewer.md', '.codex/agents/reviewer.toml']);

    const sentinel = join(repo, 'live-checkout-sentinel');
    writeFileSync(sentinel, 'preserve the live checkout\n');
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeMktemp = join(fakeBin, 'mktemp');
    writeFileSync(fakeMktemp, '#!/bin/sh\nprintf "%s\\n" "$PRECOMMIT_LIVE_CHECKOUT"\nexit 1\n');
    chmodSync(fakeMktemp, 0o755);

    // Git for Windows' sh.exe puts its own tool directories ahead of the PATH it is given, where the real
    // mktemp outranks the fake, so the fake is prepended inside the shell that then runs the hook.
    assert.ok(SHELL, NO_SHELL);
    const result = spawnSync(
      SHELL,
      ['-c', 'PATH="$(cd "$1" && pwd):$PATH"; exec sh "$2"', 'sh', fakeBin, join(repo, '.githooks', 'pre-commit')],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, PRECOMMIT_LIVE_CHECKOUT: repo } },
    );

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(repo), true, 'the live checkout must remain intact');
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve the live checkout\n');
  });
});

test('pre-commit: a staged export-ignore cannot hide a malformed seat from the agent guard', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'explorer.md'), '---\nname: explorer\ndescription: Explore: locate code first\n---\nExplore.\n');
    writeFileSync(join(repo, '.gitattributes'), '.claude/agents/explorer.md export-ignore\n');
    git(repo, ['add', '.claude/agents/explorer.md', '.gitattributes']);
    const r = runHook(repo);
    // Mutation guard: snapshot with git archive again → the seat is dropped → exit 0.
    assert.notEqual(r.status, 0, 'a staged export-ignore must not hide a malformed seat from the agent guard');
    assert.match(r.stderr, /explorer\.md: unquoted colon/);
  });
});

test('pre-commit: a smudge filter cannot repair a malformed staged seat for the agent guard', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    git(repo, ['config', 'filter.repair.smudge', "sed 's/: locate code first//'"]);
    writeFileSync(join(repo, '.claude', 'agents', 'explorer.md'), '---\nname: explorer\ndescription: Explore: locate code first\n---\nExplore.\n');
    writeFileSync(join(repo, '.gitattributes'), '.claude/agents/explorer.md filter=repair\n');
    git(repo, ['add', '.claude/agents/explorer.md', '.gitattributes']);
    assert.match(git(repo, ['cat-file', 'blob', ':.claude/agents/explorer.md']).stdout, /description: Explore: locate code first/);
    const r = runHook(repo);
    // Mutation guard: copy with checkout-index again → the filter repairs the copy → exit 0.
    assert.notEqual(r.status, 0, 'a smudge filter must not repair a malformed staged seat for the agent guard');
    assert.match(r.stderr, /explorer\.md: unquoted colon/);
  });
});

// Price tag: recurring cost is one scratch repo and five hook runs. Removal condition: retire it when the agent
// guard leaves pre-commit.
// Mutation guard: copy the working-tree settings file into the snapshot → the second run exits 0.
test("ANTI-REGRESSION: pre-commit: a repository commits without the other runtime's seat folder only when its staged settings file names one runtime", () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    const settings = join(repo, '.agents', 'factory-settings.json');
    mkdirSync(dirname(settings));
    writeFileSync(settings, '{ "version": 1, "runtimes": ["claude"], "seats": {} }\n');
    git(repo, ['add', '.agents/factory-settings.json']);
    git(repo, ['rm', '-q', '.codex/agents/reviewer.toml']);
    const named = runHook(repo);
    assert.equal(named.status, 0, `a staged settings file naming Claude must admit the removal of the Codex seat: ${named.stderr}`);

    writeFileSync(settings, '{ "runtimes": ["claude"] }\n');
    git(repo, ['add', '.agents/factory-settings.json']);
    const unversioned = runHook(repo);
    assert.notEqual(unversioned.status, 0, 'a staged settings file the sync refuses must not admit the removal');
    assert.match(unversioned.stderr, /\.agents\/factory-settings\.json: version: is unsupported/);

    git(repo, ['rm', '-q', '--cached', '.agents/factory-settings.json']);
    assert.ok(existsSync(settings), 'the settings file must stay in the working tree for this run to prove anything');
    const unstaged = runHook(repo);
    assert.notEqual(unstaged.status, 0, 'a settings file that is only in the working tree must not admit the removal');
    assert.match(unstaged.stderr, /\.codex\/agents: cannot be read/);

    rmSync(settings);
    const absent = runHook(repo);
    assert.notEqual(absent.status, 0, 'with no settings file both seat folders are required');
    assert.match(absent.stderr, /\.codex\/agents: cannot be read/);

    writeFileSync(settings, '{ "version": 1, "runtimes": ["claude"], "seats": {} }\n');
    git(repo, ['add', '.agents/factory-settings.json']);
    git(repo, ['rm', '-q', 'scripts/lib/runtimes.mjs']);
    const unreadable = runHook(repo);
    assert.notEqual(unreadable.status, 0, 'a staged removal of the module that reads the settings file must not skip the guard');
    assert.match(unreadable.stderr, /runtimes\.mjs/);
  });
});

// Copies the REAL pre-merge-commit hook beside the fixture's pre-commit and runs it. Price tag: the two
// tests below cost two scratch repos and two hook runs; retire them when pre-merge-commit stops delegating.
function runPreMergeCommit(repo) {
  const hook = join(repo, '.githooks', 'pre-merge-commit');
  writeFileSync(hook, readFileSync(resolve(dirname(HOOK), 'pre-merge-commit'), 'utf8'));
  chmodSync(hook, 0o755);
  assert.ok(SHELL, NO_SHELL);
  const r = spawnSync(SHELL, [hook], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('pre-merge-commit: delegates to pre-commit and accepts a clean staged agent pair', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Updated fixture"\nmodel: opus\n---\nReview.\n');
    writeFileSync(join(repo, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Updated fixture"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview.\n"""\n');
    git(repo, ['add', '.claude/agents/reviewer.md', '.codex/agents/reviewer.toml']);
    const r = runPreMergeCommit(repo);
    assert.equal(r.status, 0, r.stderr);
  });
});

test('pre-merge-commit: delegates to pre-commit and refuses a divergent staged agent pair', () => {
  withScratchRoot((root) => {
    const repo = initBaseRepo(root);
    armAgentDefinitions(repo);
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: "Updated fixture"\nmodel: opus\n---\nReview harder.\n');
    git(repo, ['add', '.claude/agents/reviewer.md']);
    const r = runPreMergeCommit(repo);
    // Mutation guard: a pre-merge-commit that no longer runs pre-commit exits 0.
    assert.notEqual(r.status, 0, 'a merge commit must run the agent guard through pre-commit');
    assert.match(r.stderr, /edit the reviewer charters together/);
  });
});

// Synthetic product gates at scripts/gates/pre-commit, with only an unrelated staged change so the
// other checks stay silent and the gate alone decides the outcome. The passing gate writes a marker
// relative to its working directory, so the marker landing at the root also proves where it ran.
const GATE_PASSING = '#!/bin/sh\n: > gate-ran\n';
const GATE_UNAVAILABLE = '#!/bin/sh\necho "gate-unavailable-sentinel: could not verify" >&2\nexit 0\n';
const GATE_FAILING = '#!/bin/sh\necho "gate-stdout-sentinel"\necho "gate-stderr-sentinel" >&2\nexit 2\n';

function initGateRepo(root, body, mode = 0o755) {
  const repo = initBaseRepo(root);
  writeFileSync(join(repo, 'notes.txt'), 'unrelated\n');
  git(repo, ['add', 'notes.txt']);
  const gate = join(repo, 'scripts', 'gates', 'pre-commit');
  if (body !== undefined) {
    mkdirSync(dirname(gate), { recursive: true });
    writeFileSync(gate, body);
    chmodSync(gate, mode);
  }
  return { repo, gate };
}

test('product gate: a passing pre-commit gate runs from the repository root and the hook continues', () => {
  withScratchRoot((root) => {
    const { repo } = initGateRepo(root, GATE_PASSING);
    const r = runHook(repo);
    assert.equal(r.status, 0, r.stderr);
    // The gate is the hook's last step, so "continues" is the passing exit itself: there is no
    // later check left to observe running after it.
    assert.ok(existsSync(join(repo, 'gate-ran')), 'the gate must run with the repository root as working directory');
  });
});

test('product gate: an absent pre-commit gate leaves the hook silent and passing', () => {
  withScratchRoot((root) => {
    const { repo } = initGateRepo(root);
    const r = runHook(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  });
});

test('product gate: a failing pre-commit gate blocks with its own output and then a reason naming the gate and code', () => {
  withScratchRoot((root) => {
    const { repo } = initGateRepo(root, GATE_FAILING);
    const r = runHook(repo);
    // Mutation guard: a hook that ignores the gate's exit status exits 0 with only notes.txt staged.
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
    const reason = r.stderr.search(/scripts\/gates\/pre-commit exited 2/);
    assert.ok(reason > 0, r.stderr);
    assert.ok(r.stderr.indexOf('gate-stdout-sentinel') >= 0 && r.stderr.indexOf('gate-stdout-sentinel') < reason, r.stderr);
    assert.ok(r.stderr.indexOf('gate-stderr-sentinel') >= 0 && r.stderr.indexOf('gate-stderr-sentinel') < reason, r.stderr);
  });
});

test('product gate: an unavailable pre-commit gate passes with only its own stated reason', () => {
  withScratchRoot((root) => {
    const { repo } = initGateRepo(root, GATE_UNAVAILABLE);
    const r = runHook(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, 'gate-unavailable-sentinel: could not verify\n');
  });
});

test('product gate: a non-executable pre-commit gate blocks and names the chmod fix', { skip: process.platform === 'win32' && 'the executable bit does not exist on Windows' }, () => {
  withScratchRoot((root) => {
    const { repo, gate } = initGateRepo(root, GATE_PASSING, 0o644);
    const r = runHook(repo);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`chmod +x ${gate}`), r.stderr);
  });
});
