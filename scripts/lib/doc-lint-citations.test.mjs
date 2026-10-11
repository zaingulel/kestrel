// doc-lint-citations.test.mjs — mutation-proof unit tests for the
// AGENTS.md and CLAUDE.md section-citation scan.
// Run: node --test scripts/lib/doc-lint-citations.test.mjs   (or `npm run test:scripts`)
//
// Price tag: each doc-lint run adds one content read and a bounded heading-citation
// scan per classified prose file. The script suite adds the pure checks and two CLI
// runs in one temporary repository. No network. Retire this file with doc-lint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractManualHeadings,
  extractHeadingCitations,
  checkHeadingCitations,
} from './doc-lint-citations.mjs';
import { classifyDocLintPath } from './doc-lint.mjs';
import { installs, presentRuntimes } from './runtimes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT = presentRuntimes(ROOT);
// Hand-written heading sets, never derived from extractManualHeadings, so a
// broken parser cannot agree with itself.
const fakeManuals = {
  'CLAUDE.md': new Set(['Executed test and quality bar', 'Autonomy and owner gates', 'Publication']),
  'AGENTS.md': new Set(['Executed test and quality bar', 'Publication']),
};

test('extractManualHeadings: every ATX heading level contributes its trimmed name', () => {
  const headings = extractManualHeadings([
    '# Product operating manual',
    '',
    'Prose that is not a heading.',
    '## Executed test and quality bar  ',
    '###### Deep heading',
    '#NotAHeading',
    '    ## Indented, not an ATX heading',
  ].join('\n'));

  assert.deepEqual([...headings], [
    'Product operating manual',
    'Executed test and quality bar',
    'Deep heading',
  ]);
});

// CommonMark allows an ATX heading up to 3 leading spaces and an optional
// closing hash sequence, neither of which belongs to the heading name. A
// retained ` ##` suffix would make a valid citation read as phantom.
test('extractManualHeadings: indented and closing-sequence ATX headings are parsed to their clean names', () => {
  const headings = extractManualHeadings([
    ' ## Indented',
    '   ### Three spaces still a heading',
    '## Release process ##',
    '## Closing sequence with trailing space ###   ',
    '###',
  ].join('\n'));

  assert.deepEqual([...headings], [
    'Indented',
    'Three spaces still a heading',
    'Release process',
    'Closing sequence with trailing space',
  ]);

  // The point of the suffix strip: a citation of the un-suffixed name validates.
  assert.deepEqual(
    checkHeadingCitations(
      [{ manual: 'CLAUDE.md', heading: 'Release process', line: 1 }],
      { 'CLAUDE.md': headings },
    ),
    [],
  );
});

test('checkHeadingCitations: a quoted citation of a non-existent AGENTS.md or CLAUDE.md heading is reported with file line and phrase', () => {
  const text = [
    'Intro line.',
    'Raise it to the owner — per CLAUDE.md\'s "Code-quality bar".',
  ].join('\n');

  const violations = checkHeadingCitations(extractHeadingCitations(text), fakeManuals);

  assert.deepEqual(violations, [{ manual: 'CLAUDE.md', heading: 'Code-quality bar', line: 2 }]);
});

test('checkHeadingCitations: a citation of a real AGENTS.md or CLAUDE.md heading is never flagged', () => {
  const text = 'The bar lives in CLAUDE.md\'s "Executed test and quality bar" and binds every change.';

  assert.deepEqual(checkHeadingCitations(extractHeadingCitations(text), fakeManuals), []);
});

test('extractHeadingCitations: a quoted heading wrapped across a line break is matched and normalized', () => {
  const text = [
    '- **Autonomy label**: per CLAUDE.md\'s "Autonomy and',
    '  owner gates".',
  ].join('\n');

  assert.deepEqual(extractHeadingCitations(text), [
    { manual: 'CLAUDE.md', heading: 'Autonomy and owner gates', line: 1 },
  ]);
  assert.deepEqual(checkHeadingCitations(extractHeadingCitations(text), fakeManuals), []);
});

test('extractHeadingCitations: a trailing period inside the quotes is stripped before comparison', () => {
  const text = 'Raise it to the owner — per AGENTS.md\'s "Executed test and quality bar."';

  assert.deepEqual(extractHeadingCitations(text), [
    { manual: 'AGENTS.md', heading: 'Executed test and quality bar', line: 1 },
  ]);
  assert.deepEqual(checkHeadingCitations(extractHeadingCitations(text), fakeManuals), []);
});

test('checkHeadingCitations: each file validates against its own heading set, never the sibling file\'s', () => {
  const text = [
    'See CLAUDE.md\'s "Autonomy and owner gates".',
    'See AGENTS.md\'s "Autonomy and owner gates".',
  ].join('\n');

  // The fixture gives that heading to CLAUDE.md only: the AGENTS.md citation
  // must fail even though the exact phrase exists in the other file's set.
  assert.deepEqual(checkHeadingCitations(extractHeadingCitations(text), fakeManuals), [
    { manual: 'AGENTS.md', heading: 'Autonomy and owner gates', line: 2 },
  ]);
});

test('extractHeadingCitations: backticked-file-name and possessive-free citation shapes are extracted', () => {
  // The three shapes the real repo writes: backticked file name with the
  // possessive, no possessive at all, and both at once.
  const text = [
    'The NARRATIVE companion to `CLAUDE.md`\'s "Autonomy and owner gates".',
    'Do the index update (AGENTS.md "Publication") here.',
    'And `AGENTS.md` "Autonomy and owner gates" for the sibling.',
  ].join('\n');

  assert.deepEqual(extractHeadingCitations(text), [
    { manual: 'CLAUDE.md', heading: 'Autonomy and owner gates', line: 1 },
    { manual: 'AGENTS.md', heading: 'Publication', line: 2 },
    { manual: 'AGENTS.md', heading: 'Autonomy and owner gates', line: 3 },
  ]);
  // The fixture gives "Autonomy and owner gates" to CLAUDE.md only, so the
  // widened shapes still validate against their own file.
  assert.deepEqual(checkHeadingCitations(extractHeadingCitations(text), fakeManuals), [
    { manual: 'AGENTS.md', heading: 'Autonomy and owner gates', line: 3 },
  ]);
});

// --- Repo-pass: the standing guard --------------------------------------------
// Scans the real doc-lint path-ref surface against the real AGENTS.md and CLAUDE.md headings.

test('repo-pass: the real repo has zero phantom AGENTS.md or CLAUDE.md citations', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const scanFiles = tracked.filter((rel) => classifyDocLintPath(rel).pathRefs);

  // CLAUDE.md is `@AGENTS.md` plus Claude-only notes, so a CLAUDE.md citation resolves against both. It is read only
  // where Claude Code runs.
  const agentsHeadings = extractManualHeadings(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'));
  const headingsByManual = { 'AGENTS.md': agentsHeadings };
  if (installs(PRESENT, 'CLAUDE.md')) {
    const claudeText = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.match(claudeText, /^@AGENTS\.md\s*$/m, 'CLAUDE.md must import AGENTS.md');
    headingsByManual['CLAUDE.md'] = new Set([...extractManualHeadings(claudeText), ...agentsHeadings]);
  }
  for (const manual of Object.keys(headingsByManual)) {
    assert.ok(
      headingsByManual[manual].has('Coding standards and the executed test bar'),
      `${manual}: the heading parse must find a known real heading`,
    );
  }

  const errors = [];
  let citationsSeen = 0;
  const citingFilesSeen = new Set();
  for (const rel of scanFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const citations = extractHeadingCitations(text).filter((c) => installs(PRESENT, c.manual));
    citationsSeen += citations.length;
    if (citations.length) citingFilesSeen.add(rel);
    for (const v of checkHeadingCitations(citations, headingsByManual)) {
      errors.push(`${rel}:${v.line} — phantom ${v.manual} citation: "${v.heading}"`);
    }
  }

  // Vacuity guard: a scan that matched nothing would pass silently. A named
  // known-citing shared surface only — a numeric floor would drift with repo
  // growth; the product's own citing documents are named in a product-owned test.
  for (const rel of ['.agents/skills/tdd/SKILL.md']) {
    assert.ok(citingFilesSeen.has(rel), `the citation scan must have seen citations in ${rel}`);
  }
  assert.ok(citationsSeen > 0, 'the citation scan must have found citations');

  assert.deepEqual(errors, []);
});

// --- CLI wire proof ---------------------------------------------------------
//
// The unit tests above prove the pure module; this proves the CLI actually
// calls it, including the lazy AGENTS.md and CLAUDE.md read that resolves the cited heading set.

// The CLI refuses a vacuous run, so the fixture must classify at least one
// file into every scan set.
const CLI_FIXTURE_SEEDS = {
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

test('doc lint ignores arbitrary identifiers but fails a phantom AGENTS.md or CLAUDE.md heading citation', () => {
  const root = makeCliFixture({
    'CLAUDE.md': '# Seed\n\n## Coding standards\n\nThe seeded operating manual.\n',
    'docs/C.md': 'An arbitrary [M999] marker has no registry meaning.\n',
  });
  try {
    const arbitraryIdentifier = runCliFixture(root);

    assert.equal(arbitraryIdentifier.status, 0, arbitraryIdentifier.stderr);

    writeFixtureFiles(root, { 'docs/C.md': 'Route this per CLAUDE.md\'s "Nope" before building.\n' });
    execFileSync('git', ['add', 'docs/C.md'], { cwd: root });
    const phantom = runCliFixture(root);

    assert.equal(phantom.status, 1, phantom.stderr);
    assert.match(phantom.stderr, /docs\/C\.md:1/);
    assert.match(phantom.stderr, /Nope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
