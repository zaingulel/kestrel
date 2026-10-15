// doc-lint.test.mjs — mutation-proof unit tests for the doc-prose lint gate.
// Run: node --test scripts/lib/doc-lint.test.mjs   (or `npm run test:scripts`)
//
// Guards three prose-vigilance rules that used to live as by-hand habits: a
// dangling backtick-quoted repo path (CLAUDE.md's directory map going stale),
// a skill instructing the model to fire a DISABLED (user-invoked-only)
// sibling skill (the user-invoked rule in writing-for-agents' SKILL-MECHANICS.md:
// only the human typing its name can invoke such a skill, and no other skill
// can), and a stray date-stamp in an always-loaded doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractPathRefs,
  checkPathRefs,
  parseSkillMeta,
  findIllegalInvocations,
  findDateStamps,
  buildTrackedSet,
  pathExists,
  blankFencedBlocks,
  KNOWN_UNTRACKED,
  classifyDocLintPath,
  vendoredSkillNames,
} from './doc-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('extractPathRefs: a known-root backtick token is extracted with its line number', () => {
  const md = 'See `docs/FIXTURES.md` for the fixture catalogue.';
  assert.deepEqual(extractPathRefs(md), [{ path: 'docs/FIXTURES.md', line: 1 }]);
});

test('extractPathRefs + checkPathRefs: a dangling ref (path that does not exist) IS caught', () => {
  const md = 'Read `docs/NOPE-does-not-exist.md` first.';
  const refs = extractPathRefs(md);
  const violations = checkPathRefs(refs, (p) => p === 'docs/FIXTURES.md'); // only this one "exists"
  assert.deepEqual(violations, [{ path: 'docs/NOPE-does-not-exist.md', line: 1 }]);
});

test('checkPathRefs: KEY mutation guard — a ref that DOES exist is never flagged', () => {
  const md = 'Read `docs/FIXTURES.md` first.';
  const refs = extractPathRefs(md);
  const violations = checkPathRefs(refs, (p) => p === 'docs/FIXTURES.md');
  assert.deepEqual(violations, []);
});

test('extractPathRefs: a line containing "(git history)" is skipped entirely', () => {
  const md = 'the deleted `REVIEW-csv-import.md` (git history) — read before re-running.';
  assert.deepEqual(extractPathRefs(md), []);
});

test('extractPathRefs: glob/placeholder tokens are legal prose, not refs', () => {
  const md = [
    'Everything else lives under `docs/**`.',
    'Ordered stage pieces: `src/script/NN-*.js`.',
  ].join('\n');
  assert.deepEqual(extractPathRefs(md), []);
});

test('extractPathRefs: a trailing " §N" section suffix is stripped before checking', () => {
  const md = 'See `docs/ADMIN.md §9` for the Workers detail.';
  assert.deepEqual(extractPathRefs(md), [{ path: 'docs/ADMIN.md', line: 1 }]);
});

test('extractPathRefs: a trailing ":NNN" line suffix is stripped before checking', () => {
  const md = 'The bug is at `scripts/lib/board.mjs:42`.';
  assert.deepEqual(extractPathRefs(md), [{ path: 'scripts/lib/board.mjs', line: 1 }]);
});

test('extractPathRefs: a bare root-level allowlisted file matches by exact name', () => {
  const md = 'Root allowlist includes `CLAUDE.md` and `package.json`.';
  assert.deepEqual(extractPathRefs(md), [
    { path: 'CLAUDE.md', line: 1 },
    { path: 'package.json', line: 1 },
  ]);
});

test('extractPathRefs + checkPathRefs: dangling Codex-root references are extracted and rejected', () => {
  const refs = extractPathRefs([
    'Read `AGENTS.md` first.',
    'Then use `.agents/skills/missing/SKILL.md`.',
    'The handoff lives at `.codex/agents/missing.toml`.',
  ].join('\n'));
  const violations = checkPathRefs(refs, () => false);
  assert.deepEqual(violations, [
    { path: 'AGENTS.md', line: 1 },
    { path: '.agents/skills/missing/SKILL.md', line: 2 },
    { path: '.codex/agents/missing.toml', line: 3 },
  ]);
});

test('classifyDocLintPath: Codex prose surfaces join path/date scans; a skill body also joins the invocation scan', () => {
  assert.deepEqual(classifyDocLintPath('AGENTS.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: false,
    skillMeta: false,
  });
  assert.deepEqual(classifyDocLintPath('.agents/REPOSITORY.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: false,
    skillMeta: false,
  });
  assert.deepEqual(classifyDocLintPath('.agents/skills/tdd/SKILL.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: true,
    skillMeta: true,
  });
  assert.deepEqual(classifyDocLintPath('.codex/agents/builder.toml'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: false,
    skillMeta: false,
  });
  assert.equal(classifyDocLintPath('.agents/skills/example/SKILL.md').illegalInvocations, true);
});

test('classifyDocLintPath: Claude prose surfaces join the path and date scans only', () => {
  assert.deepEqual(classifyDocLintPath('CLAUDE.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: false,
    skillMeta: false,
  });
  for (const rel of ['.claude/rules/stats-and-metrics.md', '.claude/agents/reviewer.md']) {
    assert.deepEqual(classifyDocLintPath(rel), {
      pathRefs: true,
      dateStamps: true,
      illegalInvocations: false,
      skillMeta: false,
    });
  }
  // The retired commands directory and the .claude/skills copies classify as nothing: each copy's
  // source under .agents/skills/ is the one that is linted.
  for (const rel of ['.claude/commands/example.md', '.claude/skills/resume/SKILL.md', '.claude/skills/resume']) {
    assert.deepEqual(classifyDocLintPath(rel), {
      pathRefs: false,
      dateStamps: false,
      illegalInvocations: false,
      skillMeta: false,
    });
  }
});

test('classifyDocLintPath: a skill body joins every scan; its reference modules skip the invocation scan', () => {
  assert.deepEqual(classifyDocLintPath('.agents/skills/resume/SKILL.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: true,
    skillMeta: true,
  });
  assert.deepEqual(classifyDocLintPath('.agents/skills/resume/references/work-execution.md'), {
    pathRefs: true,
    dateStamps: true,
    illegalInvocations: false,
    skillMeta: false,
  });
  assert.deepEqual(classifyDocLintPath('.agents/skills/resume/notes.md'), {
    pathRefs: false,
    dateStamps: false,
    illegalInvocations: false,
    skillMeta: false,
  });
  assert.equal(classifyDocLintPath('.agents/skills/resume/references/future.txt').dateStamps, false);
});

test('classifyDocLintPath: a vendored upstream skill body feeds only the disabled-skill metadata, never a scan', () => {
  assert.deepEqual(classifyDocLintPath('.agents/upstream/mattpocock-skills/to-spec/SKILL.md'), {
    pathRefs: false,
    dateStamps: false,
    illegalInvocations: false,
    skillMeta: true,
  });
  // Only the skill body itself: its sibling modules and the licence classify as nothing.
  for (const rel of [
    '.agents/upstream/mattpocock-skills/codebase-design/DEEPENING.md',
    '.agents/upstream/mattpocock-skills/LICENSE',
    '.agents/upstream/mattpocock-skills/codebase-design/agents/openai.yaml',
  ]) {
    assert.deepEqual(classifyDocLintPath(rel), {
      pathRefs: false,
      dateStamps: false,
      illegalInvocations: false,
      skillMeta: false,
    });
  }
});

test('classifyDocLintPath: a vendored skill\'s copy under .agents/skills/ is classified like its upstream source', () => {
  const vendored = new Set(['grilling']);
  assert.deepEqual(classifyDocLintPath('.agents/skills/grilling/SKILL.md', vendored), {
    pathRefs: false,
    dateStamps: false,
    illegalInvocations: false,
    skillMeta: true,
  });
  // A first-party skill, and a vendored name with no set passed, keep the first-party classification.
  const firstParty = { pathRefs: true, dateStamps: true, illegalInvocations: true, skillMeta: true };
  assert.deepEqual(classifyDocLintPath('.agents/skills/resume/SKILL.md', vendored), firstParty);
  assert.deepEqual(classifyDocLintPath('.agents/skills/grilling/SKILL.md'), firstParty);
});

test('vendoredSkillNames: derives the Set of <name> from every upstream SKILL.md path, ignoring siblings and non-vendored skills', () => {
  const names = vendoredSkillNames([
    '.agents/upstream/src/grilling/SKILL.md',
    '.agents/upstream/src/grilling/other.md',
    '.agents/skills/resume/SKILL.md',
  ]);
  assert.deepEqual(names, new Set(['grilling']));
});

test('extractPathRefs: a backtick token with no known root is not a path ref', () => {
  const md = 'Use exactly: module, `interface`, `implementation`, depth.';
  assert.deepEqual(extractPathRefs(md), []);
});

// --- Tracked-set resolution (the PR #405 fix: existence is git-tracked-only, --
// --- never a filesystem check, so local and a fresh CI checkout agree) --------

test('buildTrackedSet: a tracked file resolves, and so does every directory prefix it implies', () => {
  const set = buildTrackedSet(['docs/archive/x.md', 'CLAUDE.md']);
  assert.ok(set.has('docs/archive/x.md'));
  assert.ok(set.has('docs/'));
  assert.ok(set.has('docs/archive/'));
  assert.ok(set.has('CLAUDE.md'));
  assert.ok(!set.has('docs/archive')); // no trailing slash — pathExists handles that variant, not the raw set
});

test('pathExists: a tracked file or tracked directory prefix (with or without trailing slash) resolves', () => {
  const set = buildTrackedSet(['docs/archive/x.md']);
  assert.equal(pathExists(set, 'docs/archive/x.md'), true);
  assert.equal(pathExists(set, 'docs/archive/'), true);
  assert.equal(pathExists(set, 'docs/archive'), true); // no trailing slash still resolves
});

test('pathExists: adopter-only canonical references are exact exceptions', () => {
  const empty = buildTrackedSet([]);
  assert.equal(pathExists(empty, 'src/'), true, 'src/');
  for (const ref of ['src', 'src/missing.mjs', 'srcX/', 'scripts/gates/pre-push-main', 'scripts/gates/pre-push-mainX', 'scripts/gates/pre-push-main/missing']) {
    assert.equal(pathExists(empty, ref), false, ref);
  }
  const tracked = buildTrackedSet(['docs/FIXTURES.md', 'scripts/gates/pre-push-main']);
  assert.equal(pathExists(tracked, 'scripts/gates/pre-push-main'), true);
  assert.equal(pathExists(tracked, 'docs/FIXTURES.md'), true);
  assert.equal(pathExists(tracked, 'docs/missing.md'), false);
});

test('pathExists: KEY mutation guard — an untracked, non-allowlisted path does NOT resolve', () => {
  const set = buildTrackedSet(['docs/FIXTURES.md']);
  assert.equal(pathExists(set, 'docs/NOPE-does-not-exist.md'), false);
});

test('pathExists: every KNOWN_UNTRACKED entry resolves even with an EMPTY tracked set', () => {
  const set = buildTrackedSet([]);
  for (const known of KNOWN_UNTRACKED) {
    assert.equal(pathExists(set, known), true, `${known} must resolve`);
  }
});

test('pathExists: a path NESTED under a KNOWN_UNTRACKED directory resolves', () => {
  const set = buildTrackedSet([]);
  assert.equal(pathExists(set, '.claude/worktrees/job-1/AGENTS.md'), true);
  assert.equal(pathExists(set, 'node_modules/eslint/package.json'), true);
});

test('pathExists: KEY mutation guard — a similarly-NAMED but different path is not swallowed by prefix matching', () => {
  const set = buildTrackedSet([]);
  // Must be slash-bounded: ".claude/worktreesX" is not inside ".claude/worktrees/".
  assert.equal(pathExists(set, '.claude/worktreesX/x.md'), false);
});

test('pathExists + checkPathRefs: fabricate a dangling ref through the REAL resolver (not a fake existsFn) — still red-capable', () => {
  const set = buildTrackedSet(['docs/FIXTURES.md']);
  const refs = extractPathRefs('Read `docs/TOTALLY-MADE-UP.md` first, see `docs/FIXTURES.md` too.');
  const violations = checkPathRefs(refs, (p) => pathExists(set, p));
  assert.deepEqual(violations, [{ path: 'docs/TOTALLY-MADE-UP.md', line: 1 }]);
});

// --- blankFencedBlocks ---------------------------------------------------------

test('blankFencedBlocks: blanks a backtick-fenced block, preserving line count and content outside it', () => {
  const md = ['before', '```', 'inside line 1', 'inside line 2', '```', 'after'].join('\n');
  const blanked = blankFencedBlocks(md).split('\n');
  assert.deepEqual(blanked, ['before', '', '', '', '', 'after']);
});

test('blankFencedBlocks: a tilde fence is blanked too', () => {
  const md = ['before', '~~~', 'inside', '~~~', 'after'].join('\n');
  assert.deepEqual(blankFencedBlocks(md).split('\n'), ['before', '', '', '', 'after']);
});

test('blankFencedBlocks: KEY mutation guard — a fence closes only on a marker at least as long as the opener', () => {
  const md = ['````', '```', 'still inside (3 backticks did not close a 4-backtick fence)', '````', 'after'].join('\n');
  const blanked = blankFencedBlocks(md).split('\n');
  assert.deepEqual(blanked, ['', '', '', '', 'after']);
});

test('blankFencedBlocks: KEY mutation guard — a tilde line does not close a backtick fence', () => {
  const md = ['```', '~~~', 'still inside', '```', 'after'].join('\n');
  assert.deepEqual(blankFencedBlocks(md).split('\n'), ['', '', '', '', 'after']);
});

test('blankFencedBlocks: KEY mutation guard — a marker+content line does not close a fence (closing is marker-only)', () => {
  const md = ['```', '```js example — content, not a close', 'still inside', '```', 'after'].join('\n');
  assert.deepEqual(blankFencedBlocks(md).split('\n'), ['', '', '', '', 'after']);
});

// --- parseSkillMeta ----------------------------------------------------------

const fm = (name, disabled) =>
  `---\nname: ${name}\ndescription: test skill.\n${disabled ? 'disable-model-invocation: true\n' : ''}---\n\nbody text.\n`;

test('parseSkillMeta: reads name + disabled flag from frontmatter', () => {
  const meta = parseSkillMeta([
    { path: 'a.md', text: fm('grill-me', true) },
    { path: 'b.md', text: fm('resume', true) },
    { path: 'c.md', text: fm('tdd', false) },
  ]);
  assert.deepEqual(meta.get('grill-me'), { disabled: true });
  assert.deepEqual(meta.get('resume'), { disabled: true });
  assert.deepEqual(meta.get('tdd'), { disabled: false });
});

// --- findIllegalInvocations ---------------------------------------------------

test('findIllegalInvocations: an imperative ref to a disabled skill IS flagged', () => {
  const files = [
    { path: 'a.md', text: fm('grill-me', true) },
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nRun `/grill-me` now to capture the design.\n',
    },
  ];
  const violations = findIllegalInvocations(files, ['grill-me']);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'b.md');
  assert.equal(violations[0].line, 6); // frontmatter (4 lines) + the blank line after it, onto the real body line
  assert.match(violations[0].message, /\/grill-me/);
});

test('findIllegalInvocations: a deferral-phrased ref is NOT flagged', () => {
  const files = [
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nRecommend the owner run `/grill-me` next.\n',
    },
  ];
  assert.deepEqual(findIllegalInvocations(files, ['grill-me']), []);
});

test('findIllegalInvocations: KEY mutation guard — a non-imperative mention is NOT flagged', () => {
  const files = [
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nDistinct from `/grill-me`, this skill does something else.\n',
    },
  ];
  assert.deepEqual(findIllegalInvocations(files, ['grill-me']), []);
});

test('findIllegalInvocations: a skill referencing ITS OWN name is never flagged', () => {
  const files = [
    {
      path: 'grill-me.md',
      text: '---\nname: grill-me\ndescription: ok.\n---\n\nRun `/grill-me` on the topic.\n',
    },
  ];
  assert.deepEqual(findIllegalInvocations(files, ['grill-me']), []);
});

test('findIllegalInvocations: a path-embedded slash never false-matches as an invocation', () => {
  const files = [
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nRun `.claude/commands/example.md` through the linter.\n',
    },
  ];
  assert.deepEqual(findIllegalInvocations(files, ['resume']), []);
});

test('findIllegalInvocations: CodeRabbit MUST-FLAG counter-example — "user" alone no longer suppresses an imperative', () => {
  const files = [
    { path: 'a.md', text: fm('grill-me', true) },
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nRun `/grill-me` to update user documentation.\n',
    },
  ];
  const violations = findIllegalInvocations(files, ['grill-me']);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'b.md');
});

test('findIllegalInvocations: fence-aware — an imperative INSIDE a fenced example is not flagged', () => {
  const files = [
    { path: 'a.md', text: fm('grill-me', true) },
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\nDo NOT write this:\n```\nRun `/grill-me` now.\n```\n',
    },
  ];
  assert.deepEqual(findIllegalInvocations(files, ['grill-me']), []);
});

test('findIllegalInvocations: KEY mutation guard — fence-blanking never blanks an UNFENCED imperative', () => {
  const files = [
    { path: 'a.md', text: fm('grill-me', true) },
    {
      path: 'b.md',
      text: '---\nname: b\ndescription: ok.\n---\n\n```\ndocumented example, no ref here\n```\n\nRun `/grill-me` now.\n',
    },
  ];
  const violations = findIllegalInvocations(files, ['grill-me']);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'b.md');
});

// --- findDateStamps ------------------------------------------------------------

test('findDateStamps: matches an ISO date-stamp, ignores near-miss formats', () => {
  const text = [
    'Shipped 2026-07-16 (owner sign-off).', // matches
    'Version 20260716 has no dashes.', // no match
    'Partial 2026-07 is not a full date.', // no match
    'Two on one line: 2026-01-01 and 2026-12-31.', // both match
  ].join('\n');
  const stamps = findDateStamps(text);
  assert.deepEqual(
    stamps.map((s) => s.match),
    ['2026-07-16', '2026-01-01', '2026-12-31'],
  );
  assert.deepEqual(
    stamps.map((s) => s.line),
    [1, 4, 4],
  );
});

// The CLI refuses a vacuous run, so a fixture that expects to reach the scan
// must classify at least one file into every scan set.
const SCAN_SET_SEEDS = {
  'CLAUDE.md': 'The seeded operating manual.\n',
  '.agents/skills/seed/SKILL.md': 'The seeded skill.\n',
};

function makeDocLintFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-lint-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['scripts/doc-lint.mjs', 'scripts/lib/doc-lint.mjs', 'scripts/lib/doc-lint-links.mjs', 'scripts/lib/doc-lint-citations.mjs', 'scripts/lib/runtimes.mjs']) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function runDocLintFixture(root, args = []) {
  return spawnSync(process.execPath, ['scripts/doc-lint.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

test('working-tree CLI excludes unstaged tracked deletions from scans and path resolution', () => {
  const root = makeDocLintFixture({
    ...SCAN_SET_SEEDS,
    'docs/keep.md': 'The retired document was `docs/deleted.md`.',
    'docs/deleted.md': 'This deleted document mentions `docs/missing-only-in-deleted.md`.',
  });

  try {
    fs.rmSync(path.join(root, 'docs', 'deleted.md'));
    const result = runDocLintFixture(root);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.match(result.stderr, /docs\/keep\.md:1 .+ `docs\/deleted\.md` does not exist/);
    assert.doesNotMatch(result.stderr, /missing-only-in-deleted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('working-tree CLI fails loudly when an existing tracked document cannot be read', {
  skip: process.getuid?.() === 0
    || (process.platform === 'win32' && 'chmod cannot make a file unreadable on Windows: Node changes only the read-only attribute'),
}, () => {
  const root = makeDocLintFixture({
    ...SCAN_SET_SEEDS,
    'docs/blocked.md': 'A documented path: `docs/blocked.md`.',
  });
  const blocked = path.join(root, 'docs', 'blocked.md');

  try {
    fs.chmodSync(blocked, 0o000);
    const result = runDocLintFixture(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /doc-lint: failed to scan .+(?:EACCES|EPERM)/);
  } finally {
    fs.chmodSync(blocked, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the doc-lint CLI fails loud when a scan set is empty', () => {
  const nothingClassified = makeDocLintFixture({ 'docs/notes.txt': 'Not a scanned surface.\n' });
  try {
    const result = runDocLintFixture(nothingClassified);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty scan set\(s\): path-ref, date-stamp, illegal-invocation/);

    // The guard is scoped to the repo-wide pass: --staged scans only what is
    // staged, so a commit that stages no prose legitimately empties every set.
    const staged = runDocLintFixture(nothingClassified, ['--staged']);

    assert.equal(staged.status, 0);
    assert.doesNotMatch(staged.stderr, /empty scan set/);
  } finally {
    fs.rmSync(nothingClassified, { recursive: true, force: true });
  }

  // Each set is guarded on its own: a clean docs-only tree fills the path-ref
  // set while the Claude-only sets stay empty, and that still fails loud.
  const docsOnly = makeDocLintFixture({ 'docs/keep.md': 'A documented path: `docs/keep.md`.\n' });
  try {
    const result = runDocLintFixture(docsOnly);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty scan set/);
    assert.match(result.stderr, /date-stamp/);
    assert.match(result.stderr, /illegal-invocation/);
    assert.doesNotMatch(result.stderr, /path-ref/);
  } finally {
    fs.rmSync(docsOnly, { recursive: true, force: true });
  }
});

test('the doc-lint CLI accepts a missing target only when it belongs to a runtime the settings file leaves out, and never reads CLAUDE.md without Claude Code', () => {
  const root = makeDocLintFixture({
    '.agents/factory-settings.json': '{"version":1,"runtimes":["codex"],"seats":{}}\n',
    'AGENTS.md': '# Rules\n\n## Coding standards\n\nSee `CLAUDE.md` and `.claude/skills/` and [settings](.claude/settings.json).\n',
    '.agents/skills/cite/SKILL.md': 'Read AGENTS.md "Coding standards" and CLAUDE.md "Coding standards".\n',
    'docs/codex.md': 'See [hooks](../.codex/hooks.json).\n',
  });
  try {
    // A missing target of the runtime the settings file names is refused; every Claude Code target, the missing
    // CLAUDE.md and the citation of it are not.
    const named = runDocLintFixture(root);

    assert.equal(named.status, 1);
    assert.match(named.stderr, /docs\/codex\.md:1 .+ `\.\.\/\.codex\/hooks\.json` does not exist/);
    assert.doesNotMatch(named.stderr, /CLAUDE\.md|\.claude\//);

    fs.rmSync(path.join(root, 'docs', 'codex.md'));
    const clean = runDocLintFixture(root);

    assert.equal(clean.status, 0, clean.stderr);

    // With no settings file both runtimes are present: the same targets are refused and CLAUDE.md is read.
    fs.rmSync(path.join(root, '.agents', 'factory-settings.json'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n');
    const both = runDocLintFixture(root);

    assert.equal(both.status, 1);
    assert.match(both.stderr, /AGENTS\.md:5 .+ `\.claude\/skills\/` does not exist/);
    assert.match(both.stderr, /AGENTS\.md:5 .+ `\.claude\/settings\.json` does not exist/);
    assert.doesNotMatch(both.stderr, /phantom/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The five vendored upstream skills whose frontmatter sets `disable-model-invocation: true`.
const VENDORED_DISABLED = ['to-spec', 'wayfinder', 'grill-me', 'grill-with-docs', 'improve-codebase-architecture'];

test('vendored upstream skills: the real tree feeds their frontmatter to the disabled set and never scans their bodies', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const metaFiles = tracked.filter((rel) => classifyDocLintPath(rel).skillMeta)
    .map((rel) => ({ path: rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
  const disabled = [...parseSkillMeta(metaFiles).entries()].filter(([, v]) => v.disabled).map(([name]) => name);
  for (const name of VENDORED_DISABLED) assert.ok(disabled.includes(name), `${name} missing from the disabled set`);
  assert.deepEqual(tracked.filter((rel) => rel.startsWith('.agents/upstream/') && classifyDocLintPath(rel).illegalInvocations), []);
  const vendored = vendoredSkillNames(tracked);
  const scannedCopies = tracked.filter((rel) => {
    const name = rel.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
    const { pathRefs, dateStamps, illegalInvocations } = classifyDocLintPath(rel, vendored);
    return vendored.has(name) && (pathRefs || dateStamps || illegalInvocations);
  });
  assert.deepEqual(scannedCopies, []);
});

test('vendored upstream skills: the doc-lint CLI flags a first-party skill that fires a vendored disabled skill', () => {
  const vendored = Object.fromEntries(VENDORED_DISABLED.concat('grilling').map((name) => {
    const rel = `.agents/upstream/mattpocock-skills/${name}/SKILL.md`;
    return [rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')];
  }));
  const body = VENDORED_DISABLED.concat('grilling').map((name) => `Run \`/${name}\` now.`).join('\n');
  const root = makeDocLintFixture({
    ...SCAN_SET_SEEDS,
    ...vendored,
    '.agents/skills/caller/SKILL.md': `---\nname: caller\ndescription: fires siblings.\n---\n\n${body}\n`,
  });
  try {
    const result = runDocLintFixture(root);

    assert.equal(result.status, 1);
    for (const name of VENDORED_DISABLED) {
      assert.match(result.stderr, new RegExp(`caller/SKILL\\.md:\\d+ .+disabled skill /${name}\\n`));
    }
    // `grilling` stays model-invocable, and a vendored body is never itself scanned.
    assert.doesNotMatch(result.stderr, /disabled skill \/grilling\b/);
    assert.doesNotMatch(result.stderr, /\.agents\/upstream\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
