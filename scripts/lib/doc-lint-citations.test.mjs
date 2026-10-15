// doc-lint-citations.test.mjs — mutation-proof unit tests for the
// AGENTS.md and CLAUDE.md section-citation scan.
// Run: node --test scripts/lib/doc-lint-citations.test.mjs   (or `npm run test:scripts`)
//
// Price tag: each doc-lint run adds one content read and a bounded heading-citation
// scan per classified prose file. The script suite adds pure and direct verdict
// checks. No network. Retire this file with doc-lint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractManualHeadings,
  extractHeadingCitations,
  checkHeadingCitations,
} from './doc-lint-citations.mjs';
import { docLintVerdict } from './doc-lint-verdict.mjs';
import { readSettingsHeader } from './runtimes.mjs';
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

test('documentation verdict ignores arbitrary identifiers but reports a phantom manual heading', () => {
  const contents = {
    'AGENTS.md': '# Seed\n\nThe seeded agent manual.\n',
    '.agents/skills/seed/SKILL.md': 'The seeded skill.\n',
    'CLAUDE.md': '# Seed\n\n## Coding standards\n\nThe seeded operating manual.\n',
    'docs/C.md': 'An arbitrary [M999] marker has no registry meaning.\n',
  };
  const verdict = () => docLintVerdict({
    files: Object.keys(contents), read: (rel) => contents[rel], settings: readSettingsHeader(),
  });
  assert.deepEqual(verdict(), { errors: [], advisories: [] });
  contents['docs/C.md'] = 'Route this per CLAUDE.md\'s "Nope" before building.\n';
  assert.deepEqual(verdict(), { errors: ['docs/C.md:1 — phantom CLAUDE.md citation: `Nope` is not a heading'], advisories: [] });
});
