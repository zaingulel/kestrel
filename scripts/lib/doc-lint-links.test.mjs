// doc-lint-links.test.mjs — mutation-proof unit tests for the dead relative
// Markdown link scan.
// Run: node --test scripts/lib/doc-lint-links.test.mjs   (or `npm run test:scripts`)
//
// Price tag: recurring cost is one extra regex pass over the
// prose files doc-lint already reads, plus this unit file inside
// `npm run test:scripts`. Removal condition: retire it with doc-lint itself,
// alongside scripts/lib/doc-lint.test.mjs.
//
// Guards the rot a backtick path-ref scan cannot see: `[text](../other.md)`
// carries no backticks, so a moved or deleted target stays silently linked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractMarkdownLinks,
  resolveLinkTarget,
  checkMarkdownLinks,
} from './doc-lint-links.mjs';
import { buildTrackedSet, pathExists, classifyDocLintPath, vendoredSkillNames } from './doc-lint.mjs';
import { installs, presentRuntimes } from './runtimes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT = presentRuntimes(ROOT);

test('checkMarkdownLinks: a dead relative Markdown link is reported with its file line and target', () => {
  const md = [
    'The resume workflow is documented here.',
    'See [work execution](references/work-execution.md) for the detail.',
  ].join('\n');
  const dead = checkMarkdownLinks('.claude/skills/resume/SKILL.md', md, () => false);
  assert.deepEqual(dead, [{
    target: 'references/work-execution.md',
    resolved: '.claude/skills/resume/references/work-execution.md',
    line: 2,
  }]);
});

test('extractMarkdownLinks: anchor-only and external targets are never extracted', () => {
  const md = [
    'Jump to [the delivery map](#delivery-map).',
    'Read the [CommonMark spec](https://spec.commonmark.org/).',
    'Insecure [mirror](http://example.com/x.md).',
    'Mail [the owner](mailto:owner@example.com).',
    'But [this one](docs/DESIGN.md) is a real ref.',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinks(md), [{ target: 'docs/DESIGN.md', line: 5 }]);
});

test('extractMarkdownLinks: a trailing #anchor fragment and a trailing :NNN suffix are stripped', () => {
  const md = [
    'See [the delivery map](docs/AI-WORKFLOW-REFERENCE.md#delivery-map).',
    'The bug is at [board.mjs](scripts/lib/board.mjs:42).',
    'An image: ![diagram](docs/img/flow.png#fragment)',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinks(md), [
    { target: 'docs/AI-WORKFLOW-REFERENCE.md', line: 1 },
    { target: 'scripts/lib/board.mjs', line: 2 },
    { target: 'docs/img/flow.png', line: 3 },
  ]);
});

test('extractMarkdownLinks: a reference-definition target is extracted and a dead one is reported', () => {
  const md = [
    'The [workflow][workflow] reference is defined below.',
    'See [architecture](docs/GONE.md) and [guide](GUIDE.md:42).',
    '',
    '[workflow]: references/missing.md',
    '[phone]: tel:+441234567890',
    '[archive]: ftp://example.com/old.md',
    '[bug]: docs/X.md:42',
  ].join('\n');

  // GUIDE.md:42 is the KEY guard on the dot-free scheme charset: allowing a
  // dot in the scheme would make `GUIDE.md:` read as a URI scheme and the
  // target silently vanish from the scan.
  assert.deepEqual(extractMarkdownLinks(md), [
    { target: 'docs/GONE.md', line: 2 },
    { target: 'GUIDE.md', line: 2 },
    { target: 'references/missing.md', line: 4 },
    { target: 'docs/X.md', line: 7 },
  ]);

  const dead = checkMarkdownLinks('CLAUDE.md', md, (p) => p === 'docs/X.md' || p === 'GUIDE.md');
  assert.deepEqual(dead, [
    { target: 'docs/GONE.md', resolved: 'docs/GONE.md', line: 2 },
    { target: 'references/missing.md', resolved: 'references/missing.md', line: 4 },
  ]);
});

test('extractMarkdownLinks: an angle-bracket destination is unwrapped before stripping', () => {
  const md = [
    'See [guide](<docs/guide.md>) for the detail.',
    'And [anchored](<docs/guide.md#top>).',
    '',
    '[ref]: <references/missing.md>',
  ].join('\n');

  assert.deepEqual(extractMarkdownLinks(md), [
    { target: 'docs/guide.md', line: 1 },
    { target: 'docs/guide.md', line: 2 },
    { target: 'references/missing.md', line: 4 },
  ]);

  assert.deepEqual(
    checkMarkdownLinks('CLAUDE.md', md, (p) => p === 'docs/guide.md'),
    [{ target: 'references/missing.md', resolved: 'references/missing.md', line: 4 }],
  );
});

test('extractMarkdownLinks: a protocol-relative target is never extracted', () => {
  const md = [
    'A [mirror](//cdn.example.com/guide.md) is not a repo path.',
    '[cdn]: //cdn.example.com/other.md',
    'But [this one](docs/DESIGN.md) is a real ref.',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinks(md), [{ target: 'docs/DESIGN.md', line: 3 }]);
});

test('extractMarkdownLinks: a target that is only a stripped fragment is skipped', () => {
  assert.deepEqual(extractMarkdownLinks('Empty after stripping: [x](#).'), []);
});

test('resolveLinkTarget: a ../ target resolves against the containing file directory, not the repo root', () => {
  assert.equal(
    resolveLinkTarget('.claude/skills/resume/SKILL.md', '../../../docs/DESIGN.md'),
    'docs/DESIGN.md',
  );
  assert.equal(resolveLinkTarget('CLAUDE.md', 'docs/DESIGN.md'), 'docs/DESIGN.md');
  assert.equal(resolveLinkTarget('docs/TOUR-A.md', './DESIGN.md'), 'docs/DESIGN.md');
});

test('checkMarkdownLinks: KEY mutation guard — a link whose resolved target exists is never flagged', () => {
  const md = 'See [architecture](../DESIGN.md) and [self](TOUR.md).';
  const dead = checkMarkdownLinks(
    'docs/archive/NOTE.md',
    md,
    (p) => p === 'docs/DESIGN.md' || p === 'docs/archive/TOUR.md',
  );
  assert.deepEqual(dead, []);
});

test('checkMarkdownLinks: a target that escapes the repo root is dead', () => {
  const md = 'See [outside](../../elsewhere/notes.md).';
  const dead = checkMarkdownLinks('docs/DESIGN.md', md, () => true);
  assert.deepEqual(dead, [{ target: '../../elsewhere/notes.md', resolved: null, line: 1 }]);
});

test('repo-pass: the real repo classified prose files have zero dead Markdown links', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const trackedSet = buildTrackedSet(tracked);
  const vendored = vendoredSkillNames(tracked);
  const scanFiles = tracked.filter((rel) => classifyDocLintPath(rel, vendored).pathRefs);

  // Vacuity guard: a classifier that stopped matching would make the scan
  // below pass over nothing. Named mandatory shared surfaces only — a numeric
  // floor would drift with ordinary repo growth; the product's own documents
  // are named in a product-owned test.
  for (const rel of ['CLAUDE.md', 'AGENTS.md'].filter((surface) => installs(PRESENT, surface))) {
    assert.ok(scanFiles.includes(rel), `Markdown-link scan set must include ${rel}`);
  }

  const errors = [];
  for (const rel of scanFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const dead = checkMarkdownLinks(rel, text, (p) => pathExists(trackedSet, p) || !installs(PRESENT, p));
    for (const d of dead) errors.push(`${rel}:${d.line} — dead link: ${d.target}`);
  }

  assert.deepEqual(errors, []);
});

// --- CLI wire proof ---------------------------------------------------------
//
// The unit tests above prove the pure module; this proves the CLI actually
// calls it. Scratch repo rather than the real tree: the real tree is clean by
// construction, so only a seeded dead link can fail a wired CLI.

// The CLI refuses a vacuous run, so the fixture must classify at least one
// file into every scan set.
const CLI_FIXTURE_SEEDS = {
  'CLAUDE.md': '# Seed\n\nThe seeded operating manual.\n',
  'AGENTS.md': '# Seed\n\nThe seeded agent manual.\n',
  '.agents/skills/seed/SKILL.md': 'The seeded skill.\n',
};

function makeCliFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-lint-cli-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['scripts/doc-lint.mjs', 'scripts/lib/doc-lint.mjs', 'scripts/lib/doc-lint-links.mjs', 'scripts/lib/doc-lint-citations.mjs', 'scripts/lib/runtimes.mjs']) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  }
  writeFixtureFiles(root, { ...CLI_FIXTURE_SEEDS, ...files });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function writeFixtureFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function runCliFixture(root) {
  return spawnSync(process.execPath, ['scripts/doc-lint.mjs'], { cwd: root, encoding: 'utf8' });
}

test('doc-lint CLI: a dead relative Markdown link fails the scan naming file and target', () => {
  const root = makeCliFixture({ 'docs/A.md': 'See [the sibling](B.md) for the detail.\n' });
  try {
    const dead = runCliFixture(root);

    assert.equal(dead.status, 1, dead.stderr);
    assert.match(dead.stderr, /docs\/A\.md:1/);
    assert.match(dead.stderr, /B\.md/);

    writeFixtureFiles(root, { 'docs/B.md': 'The sibling document.\n' });
    execFileSync('git', ['add', 'docs/B.md'], { cwd: root });
    const live = runCliFixture(root);

    assert.equal(live.status, 0, live.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
