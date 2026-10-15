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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractMarkdownLinks,
  resolveLinkTarget,
  checkMarkdownLinks,
} from './doc-lint-links.mjs';
import { docLintVerdict } from './doc-lint-verdict.mjs';
import { classifyDocLintPath, vendoredSkillNames } from './doc-lint.mjs';
import { leftOutCause, readSettingsHeader, treeSettings } from './runtimes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS = treeSettings(ROOT);

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

test('repo-pass: the delivered documentation verdict has zero findings across all four blocking scans', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const vendored = vendoredSkillNames(files);
  for (const manual of ['CLAUDE.md', 'AGENTS.md'].filter((rel) => leftOutCause(SETTINGS, rel) === null)) {
    assert.equal(classifyDocLintPath(manual, vendored).pathRefs, true, `${manual} must join the path scans`);
  }
  assert.equal(classifyDocLintPath('.agents/skills/tdd/SKILL.md', vendored).pathRefs, true,
    'the known citing skill must join the path scans');
  const verdict = docLintVerdict({
    files, settings: SETTINGS, read: (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  });
  assert.deepEqual(verdict.errors, []);
});

test('documentation verdict reports a dead relative Markdown link naming file and target', () => {
  const contents = {
    'CLAUDE.md': '# Seed\n\nThe seeded operating manual.\n',
    'AGENTS.md': '# Seed\n\nThe seeded agent manual.\n',
    '.agents/skills/seed/SKILL.md': 'The seeded skill.\n',
    'docs/A.md': 'See [the sibling](B.md) for the detail.\n',
  };
  const verdict = () => docLintVerdict({
    files: Object.keys(contents), read: (rel) => contents[rel], settings: readSettingsHeader(),
  });
  assert.deepEqual(verdict(), { errors: ['docs/A.md:1 — dead Markdown link: `B.md` does not exist'], advisories: [] });
  contents['docs/B.md'] = 'The sibling document.\n';
  assert.deepEqual(verdict(), { errors: [], advisories: [] });
});

test('documentation verdict preserves source-scoped path allowances', async (t) => {
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'doc-lint-scoped-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const modules = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['doc-lint-verdict.mjs', 'doc-lint-links.mjs', 'doc-lint-citations.mjs', 'runtimes.mjs']) {
    fs.copyFileSync(path.join(modules, name), path.join(fixture, name));
  }
  fs.copyFileSync(path.join(modules, 'doc-lint.mjs'), path.join(fixture, 'base-doc-lint.mjs'));
  fs.writeFileSync(path.join(fixture, 'doc-lint.mjs'), [
    "export * from './base-doc-lint.mjs';",
    "import { extractPathRefs as extract } from './base-doc-lint.mjs';",
    'export function extractPathRefs(text, sourcePath) {',
    "  return extract(text).filter(ref => sourcePath !== 'docs/allowed.md' || ref.path !== 'docs/external-repository');",
    '}',
  ].join('\n'));
  const { docLintVerdict: scopedVerdict } = await import(pathToFileURL(path.join(fixture, 'doc-lint-verdict.mjs')).href);
  const contents = {
    'docs/allowed.md': '`docs/external-repository`\n`docs/missing.md`',
    'docs/other.md': '`docs/external-repository`',
  };
  assert.deepEqual(scopedVerdict({
    files: Object.keys(contents),
    read: (rel) => contents[rel],
    settings: readSettingsHeader(),
    allowEmpty: true,
  }), {
    errors: [
      'docs/allowed.md:2 — dangling path ref: `docs/missing.md` does not exist',
      'docs/other.md:1 — dangling path ref: `docs/external-repository` does not exist',
    ],
    advisories: [],
  });
});
