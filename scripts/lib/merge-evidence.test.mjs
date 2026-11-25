// merge-evidence.test.mjs — the five wait reasons, the on-screen and show-me-first holds, and the review folder's held reasons
// (scripts/lib/merge-evidence.mjs).
// Run: node --test scripts/lib/merge-evidence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVERY_CARD_WAITS, WAIT_REASONS, waitReasons, heldReasons, readCoordinator, readWaitLevel } from './merge-evidence.mjs';

// ── the five wait reasons ─────────────────────────────────────────────────────
// `waitReasons(body, screenshots)` is called with write-ups written by hand from the pull request template's grammar,
// one edit of a clear write-up each, and returns the held reasons in WAIT_REASONS order. `heldReasons` reads the saved
// write-up and screenshot files of the review folder at HEAD from a temporary directory, with a git fake that answers
// HEAD and hashes the files on disk as `git hash-object --no-filters` does, and a gh fake that answers the pull
// request body; the expected hash is git's own output for the fixed contents.

const REASONS = ['check', 'screenshot', 'beyond-card', 'sign-off', 'hard-to-undo'];
const REVIEW = 'Review: tier=code rounds=1 raised=0 fixed=0 dismissed=0 deferred=0';
const UNDO_EASY = 'Undo: easy, a later commit reverts it.';
const CLEAR = [
  '## Not done',
  '',
  'Nothing',
  '',
  '## Merge Danger',
  '',
  UNDO_EASY,
  'Reach: narrow, one file.',
  '',
  '## Evidence',
  '',
  'no visual change',
  '',
  'Passed: focused tests and lint.',
  'Failed: none',
  'Untested: none',
  '',
  '## Review',
  '',
  REVIEW,
  '',
].join('\n');

// The write-up with `from` replaced by `to`; a `from` the write-up does not hold is a mistake in the test.
const edit = (body, from, to) => {
  assert.ok(body.includes(from), `the write-up holds ${from}`);
  return body.replace(from, to);
};
const ON_SCREEN = edit(CLEAR, 'no visual change\n\n', '');
const SHOT_NAME = 'screenshot-1.png';
const UNDO_HARD = 'Undo: hard, a published tag cannot be withdrawn.';
const ONE_FIXED = 'Review: tier=code rounds=1 raised=1 fixed=1 dismissed=0 deferred=0';
const ONE_DISMISSED = 'Review: tier=code rounds=1 raised=1 fixed=0 dismissed=1 deferred=0';

// A temporary review folder of card 7 at HEAD `head`, and the git fake that answers HEAD and hashes its files.
function reviewFolder(t) {
  const head = '5ca1ab1e'.repeat(5);
  const cwd = mkdtempSync(join(tmpdir(), 'wait-reasons-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const folder = join(cwd, `.claude/worklog/job_7-review-${head}`);
  mkdirSync(folder, { recursive: true });
  const git = (args) => {
    if (args.join(' ') === 'rev-parse HEAD') return `${head}\n`;
    assert.equal(args[0], 'hash-object');
    return args.slice(1).filter((arg) => arg !== '--no-filters' && arg !== '--').map((path) => {
      const bytes = readFileSync(resolve(cwd, path));
      return `${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}\n`;
    }).join('');
  };
  return { head, cwd, folder, git };
}

test('a write-up holding none of the five holds nothing, and held reasons come in WAIT_REASONS order', () => {
  assert.deepEqual(WAIT_REASONS, [...REASONS, 'on-screen', 'show-me-first']);
  assert.deepEqual(waitReasons(CLEAR, []), []);
  assert.deepEqual(waitReasons(ON_SCREEN, [SHOT_NAME]), []);

  let all = edit(ON_SCREEN, 'Failed: none', 'Failed: lint, cause unknown');
  all = edit(all, 'Nothing', '- The Windows suite was skipped.');
  all = edit(all, 'tier=code', 'tier=sign-off');
  all = edit(all, UNDO_EASY, UNDO_HARD);
  assert.deepEqual(waitReasons(all, []), REASONS);
});

test('ANTI-REGRESSION: a failed check, an untested check, a missing, duplicated, incomplete or unsettled review line, or a declared review route holds finished work under check', () => {
  const cases = [
    ['a failed check', edit(CLEAR, 'Failed: none', 'Failed: lint, cause unknown')],
    ['an untested check', edit(CLEAR, 'Untested: none', 'Untested: npm run lint:docs, not rerun on this head')],
    ['no review line', edit(CLEAR, `${REVIEW}\n`, '')],
    ['a review line only inside a fenced block', edit(CLEAR, REVIEW, `\`\`\`text\n${REVIEW}\n\`\`\``)],
    ['a review line only inside an HTML comment', edit(CLEAR, REVIEW, `<!-- ${REVIEW} -->`)],
    ['no review round', edit(CLEAR, 'rounds=1', 'rounds=0')],
    ['a raised finding no field settles', edit(CLEAR, 'raised=0 fixed=0', 'raised=1 fixed=0')],
    ['a deferred finding', edit(CLEAR, 'raised=0 fixed=0 dismissed=0 deferred=0', 'raised=1 fixed=0 dismissed=0 deferred=1')],
    ['two valid review lines', edit(CLEAR, REVIEW, `${REVIEW}\n${REVIEW}`)],
    ['a declared review route', edit(CLEAR, REVIEW, `${REVIEW}\n\nThe code pass ran on the writing family.`)],
    ['external rounds above the rounds', edit(CLEAR, REVIEW, `${REVIEW} greptile_rounds=2 greptile_raised=0 greptile_true=0`)],
    ['external raised above the raised', edit(CLEAR, REVIEW, `${REVIEW} greptile_rounds=1 greptile_raised=1 greptile_true=1`)],
    ['external true above the external raised', edit(CLEAR, REVIEW, `${ONE_FIXED} greptile_rounds=1 greptile_raised=0 greptile_true=1`)],
    ['external true above fixed plus deferred', edit(CLEAR, REVIEW, `${ONE_DISMISSED} greptile_rounds=1 greptile_raised=1 greptile_true=1`)],
    ['external false findings above dismissed', edit(CLEAR, REVIEW, `${ONE_FIXED} greptile_rounds=1 greptile_raised=1 greptile_true=0`)],
    ['external findings with no external round', edit(CLEAR, REVIEW, `${ONE_FIXED} greptile_rounds=0 greptile_raised=1 greptile_true=1`)],
  ];
  for (const [name, body] of cases) assert.deepEqual(waitReasons(body, []), ['check'], name);

  const addOn = edit(CLEAR, REVIEW, `${REVIEW} greptile_rounds=0 greptile_raised=0 greptile_true=0`);
  assert.deepEqual(waitReasons(addOn, []), [], 'a settled add-on form holds nothing');
  const nested = edit(CLEAR, REVIEW, 'Review: tier=code rounds=3 raised=2 fixed=1 dismissed=1 deferred=0 greptile_rounds=1 greptile_raised=2 greptile_true=1');
  assert.deepEqual(waitReasons(nested, []), [], 'an add-on form whose counts nest holds nothing');

  const fencedExample = edit(CLEAR, REVIEW, `\`\`\`text\n${REVIEW}\n\`\`\`\n\n${REVIEW}`);
  assert.deepEqual(waitReasons(fencedExample, []), [], 'a review line quoted in a fenced block before the real one is not counted');
  const commentedExample = edit(CLEAR, REVIEW, `<!--\n${REVIEW}\n-->\n\n${REVIEW}`);
  assert.deepEqual(waitReasons(commentedExample, []), [], 'a review line inside a multi-line HTML comment before the real one is not counted');
});

test('ANTI-REGRESSION: evidenced Codex fallback clears only the routine review hold', (t) => {
  const { head, cwd, folder, git } = reviewFolder(t);
  const held = (saved, published, marked = false) => {
    writeFileSync(join(folder, 'body.md'), saved);
    return heldReasons(7, cwd, {
      git,
      exec: (args) => {
        assert.equal(args.join(' '), 'pr view 12 --json body');
        return JSON.stringify({ body: published });
      },
    }, published === undefined ? undefined : { number: 12, headRefOid: head }, { level: 'when-needed', marked });
  };

  const evidence = 'Claude Code reported its usage limit on dispatch.';
  const declaration = `Primary review fallback: completed=codex unavailable=claude-code cause=quota evidence=${evidence}`;
  const fallback = edit(CLEAR, REVIEW, `${REVIEW}\n\n${declaration}`);
  assert.deepEqual(held(fallback, undefined), [], 'eligible saved-only fallback');

  const explanation = 'A fresh independent Codex reviewer completed the review after Claude Code reported its usage limit.';
  const findings = `<details>\n\n<summary>Review findings</summary>\n\n${explanation}\n\n</details>`;
  const decision = [
    '<details>',
    '',
    '<summary>Decision card</summary>',
    '',
    '**What changes for you:** Finished changes can proceed on a completed review.',
    '**Screenshot:** no visual change',
    `**What a yes accepts:** ${explanation}`,
    '**Risk:**',
    UNDO_EASY,
    'Reach: narrow, one file.',
    '**Checks:**',
    'Passed: focused tests and lint.',
    'Failed: none',
    'Untested: none',
    '',
    '</details>',
  ].join('\n');
  const receipts = `<details>\n\n<summary>Test receipts</summary>\n\nCarried from: none\n\n</details>`;
  const withReceipts = edit(fallback, '## Review', `${receipts}\n\n## Review`);
  const writeUp = `${withReceipts}\n${findings}\n\n${decision}\n`;
  assert.deepEqual(held(writeUp, writeUp), [], 'matching fallback with review findings and decision card');
  assert.deepEqual(held(CLEAR, CLEAR), [], 'two ordinary clear bodies');
  assert.deepEqual(held(fallback, CLEAR), ['check'], 'fallback only in the saved body');
  assert.deepEqual(held(CLEAR, fallback), ['check'], 'fallback only in the published body');
  const different = edit(fallback, evidence, 'Claude Code reported its usage limit when the reviewer started.');
  assert.deepEqual(held(fallback, different), ['check'], 'two valid declarations with different evidence');

  const zeroAddOn = edit(fallback, REVIEW, `${REVIEW} greptile_rounds=0 greptile_raised=0 greptile_true=0`);
  assert.deepEqual(held(zeroAddOn, undefined), [], 'fallback with zero add-on counts');
  const settledAddOn = edit(fallback, REVIEW, `${ONE_FIXED} greptile_rounds=1 greptile_raised=1 greptile_true=1`);
  assert.deepEqual(held(settledAddOn, undefined), ['check'], 'fallback with nonzero settled add-on counts');

  const literalOpener = edit(writeUp, '## Review', 'The example uses `<details>` in prose.\n\n## Review');
  assert.deepEqual(held(literalOpener, literalOpener), [], 'a code span with a literal details opener');
  const multilineSpan = edit(writeUp, '\n\n</details>\n\n## Review', '</details>\n\nThe example uses ``<details>\nand contains a single ` in the span.``\n\n## Review');
  assert.deepEqual(held(multilineSpan, multilineSpan), [], 'a multiline code span after a real inline closing tag');
  const escapedOpener = edit(writeUp, '## Review', 'The example uses \\<details> in prose.\n\n## Review');
  assert.deepEqual(held(escapedOpener, escapedOpener), [], 'an escaped details opener');

  const malformed = [
    ['the collapsed summary and declaration', edit(CLEAR, REVIEW, edit(findings, explanation, `${REVIEW}\n\n${declaration}\n\n<details>\n\n</details>`))],
    ['variation-selector-only evidence', edit(fallback, evidence, '\uFE0F')],
    ['the summary and declaration below closed findings', edit(CLEAR, REVIEW, `${findings}\n\n${REVIEW}\n\n${declaration}`)],
    ['unclosed test receipts', edit(writeUp, '\n\n</details>\n\n## Review', '\n\n## Review')],
    ['unclosed test receipts with a literal closer', edit(writeUp, '\n\n</details>\n\n## Review', '\n\nThe example uses `</details>` in prose.\n\n## Review'), writeUp],
    ['unclosed compact test receipts', edit(writeUp, receipts, '<details><summary>Test receipts</summary>\n\nCarried from: none'), writeUp],
    ['a details opener after a heading', edit(writeUp, '## Review', 'The example uses `\n### Receipts\nTest receipts <details>`\n\n## Review'), writeUp],
    ['a details opener after a thematic break', edit(writeUp, '## Review', 'The example uses `\n***\nTest receipts <details>`\n\n## Review'), writeUp],
    ['absent summary', edit(fallback, `${REVIEW}\n`, '')],
    ['a deferred finding', edit(fallback, 'raised=0 fixed=0 dismissed=0 deferred=0', 'raised=1 fixed=0 dismissed=0 deferred=1')],
    ['blank evidence', edit(fallback, evidence, '   ')],
    ['control-only evidence', edit(fallback, evidence, '\u0007')],
    ['unrecognized cause', edit(fallback, 'cause=quota', 'cause=skipped')],
    ['duplicate marker', edit(fallback, declaration, `${declaration}\n${declaration}`)],
    ['marker before the summary', edit(CLEAR, REVIEW, `${declaration}\n\n${REVIEW}`)],
    ['marker inside the findings', `${CLEAR}\n${edit(findings, explanation, declaration)}\n`],
    ['an extra declaration', edit(fallback, declaration, `${declaration}\nThe primary review ran on the writing family.`)],
    ['a supplemental exception', edit(fallback, declaration, 'Supplemental review not completed: Claude Code reviewer-supplemental; usage limit; the supplemental cross-family review was not met.')],
    ['a same-family exception', edit(fallback, declaration, 'The code pass ran on the writing family.')],
  ];
  for (const [name, body, saved = CLEAR] of malformed) {
    assert.deepEqual(held(body, undefined), ['check'], `saved body with ${name}`);
    assert.deepEqual(held(saved, body), ['check'], `published body with ${name}`);
  }

  assert.deepEqual(held(edit(fallback, 'Failed: none', 'Failed: lint, cause unknown'), undefined), ['check'], 'a failed check');
  assert.deepEqual(held(edit(fallback, 'Untested: none', 'Untested: the installed suite'), undefined), ['check'], 'an untested check');
  assert.deepEqual(held(edit(fallback, UNDO_EASY, UNDO_HARD), undefined), ['hard-to-undo'], 'a change that is hard to undo');
  assert.deepEqual(held(edit(fallback, 'tier=code', 'tier=document'), undefined), ['check'], 'a document tier');
  assert.deepEqual(held(edit(fallback, 'tier=code', 'tier=sign-off'), undefined), ['check', 'sign-off'], 'a sign-off tier');
  assert.deepEqual(held(fallback, undefined, true), ['show-me-first'], 'a card marked show-me-first');
});

test('ANTI-REGRESSION: work on screen with no current screenshot, or one not attached to its pull request, holds under screenshot', (t) => {
  assert.deepEqual(waitReasons(ON_SCREEN, []), ['screenshot']);
  assert.deepEqual(waitReasons(ON_SCREEN, [SHOT_NAME]), []);

  const shotHash = '92e211a8620359c126ec6fa690ac2e18323cecc8';
  const { head, cwd, folder, git } = reviewFolder(t);
  writeFileSync(join(folder, 'body.md'), ON_SCREEN);
  const pullWith = (body) => heldReasons(7, cwd, {
    git,
    exec: (args) => {
      assert.equal(args.join(' '), 'pr view 12 --json body');
      return JSON.stringify({ body });
    },
  }, { number: 12, headRefOid: head }, { level: 'when-needed', marked: false });

  assert.deepEqual(heldReasons(7, cwd, { git }, undefined, { level: 'when-needed', marked: false }), ['screenshot'], 'no screenshot in the review folder');
  writeFileSync(join(folder, SHOT_NAME), 'Screenshot 1 of the logo in the header.\n');
  assert.deepEqual(heldReasons(7, cwd, { git }, undefined, { level: 'when-needed', marked: false }), [], 'a screenshot in the review folder');
  assert.deepEqual(pullWith(ON_SCREEN), ['screenshot'], 'the screenshot is not in the pull request body');
  const image = `![screenshot-1 ${shotHash}](https://github.com/user-attachments/assets/a1)`;
  assert.deepEqual(pullWith(edit(ON_SCREEN, '## Evidence\n\n', `## Evidence\n\n${image}\n`)), [], 'the screenshot is attached under its hash');

  writeFileSync(join(folder, 'body.md'), CLEAR);
  assert.deepEqual(pullWith(ON_SCREEN), ['screenshot'], 'the published body declares work on screen though the saved one says no visual change, and no image is attached');
  assert.deepEqual(pullWith(edit(ON_SCREEN, '## Evidence\n\n', `## Evidence\n\n${image}\n`)), [], 'the published body declares work on screen and the image is attached under its hash');
});

test('ANTI-REGRESSION: a card carrying show-me-first waits at every level, and at on-screen work on screen waits', (t) => {
  const { cwd, folder, git } = reviewFolder(t);
  const held = (level, marked) => heldReasons(7, cwd, { git }, undefined, { level, marked });

  writeFileSync(join(folder, 'body.md'), CLEAR);
  assert.deepEqual(held('always', true), ['show-me-first', EVERY_CARD_WAITS], 'marked, at always');
  assert.deepEqual(held('on-screen', true), ['show-me-first'], 'marked, at on-screen');
  assert.deepEqual(held('when-needed', true), ['show-me-first'], 'marked, at when-needed');
  assert.deepEqual(held('when-needed', false), [], 'unmarked, at when-needed');
  assert.deepEqual(held('on-screen', false), [], 'unmarked work with no visual change, at on-screen');

  writeFileSync(join(folder, 'body.md'), ON_SCREEN);
  writeFileSync(join(folder, SHOT_NAME), 'Screenshot 1 of the logo in the header.\n');
  assert.deepEqual(held('on-screen', false), ['on-screen'], 'unmarked work on screen, at on-screen');
  assert.deepEqual(held('when-needed', false), [], 'unmarked work on screen, at when-needed');
});

test('ANTI-REGRESSION: a Not done section other than Nothing holds under beyond-card', () => {
  assert.deepEqual(waitReasons(edit(CLEAR, 'Nothing', '- The Windows suite was skipped.'), []), ['beyond-card']);
});

test('ANTI-REGRESSION: a sign-off review tier holds under sign-off', () => {
  assert.deepEqual(waitReasons(edit(CLEAR, 'tier=code', 'tier=sign-off'), []), ['sign-off']);
});

test('ANTI-REGRESSION: an Undo answer of hard holds under hard-to-undo', () => {
  assert.deepEqual(waitReasons(edit(CLEAR, UNDO_EASY, UNDO_HARD), []), ['hard-to-undo']);
});

test('ANTI-REGRESSION: a write-up missing its Failed line, Untested line, Undo line or Not done section, giving its Review, Not done or Evidence section twice or under a heading in any other form, or holding an unclosed HTML comment, is unreadable, never clear', () => {
  const cases = [
    ['a second Not done section', `${CLEAR}\n## Not done\n\n- The owner must run the Windows suite.\n`, /more than one Not done/],
    ['a second Review section', `${CLEAR}\n## Review\n\nReview: tier=code rounds=1 raised=1 fixed=0 dismissed=0 deferred=1\n`, /more than one Review/],
    ['an unclosed HTML comment before the Failed line', edit(CLEAR, '## Evidence', '<!--\n## Evidence'), /unclosed HTML comment/],
    ['no Failed line', edit(CLEAR, 'Failed: none\n', ''), /Failed/],
    ['no Untested line', edit(CLEAR, 'Untested: none\n', ''), /Untested/],
    ['no Undo line', edit(CLEAR, `${UNDO_EASY}\n`, ''), /Undo/],
    ['an Undo line that is neither easy nor hard', edit(CLEAR, 'Undo: easy', 'Undo: maybe'), /Undo/],
    ['no Not done section', edit(CLEAR, '## Not done\n\nNothing\n\n', ''), /Not done/],
    ['a Not done heading with a closing sequence', `${CLEAR}\n## Not done ##\n\n- The owner must run the Windows suite.\n`, /Not done heading/],
    ['an indented Not done heading', `${CLEAR}\n   ## Not done\n\n- The owner must run the Windows suite.\n`, /Not done heading/],
    ['a Not done heading with a tab after its hashes', `${CLEAR}\n##\tNot done\n\n- The owner must run the Windows suite.\n`, /Not done heading/],
    ['a Not done heading at another level', `${CLEAR}\n### Not done\n\n- The owner must run the Windows suite.\n`, /Not done heading/],
    ['a setext Not done heading', `${CLEAR}\nNot done\n--------\n\n- The owner must run the Windows suite.\n`, /Not done heading/],
    ['a Review heading with a closing sequence', `${CLEAR}\n## Review ##\n\nReview: tier=code rounds=1 raised=1 fixed=0 dismissed=0 deferred=1\n`, /Review heading/],
    ['a setext Review heading', `${CLEAR}\nReview\n======\n\nReview: tier=code rounds=1 raised=1 fixed=0 dismissed=0 deferred=1\n`, /Review heading/],
    ['a second Evidence section', `${CLEAR}\n## Evidence\n\nThe dialog now shows the card.\n`, /more than one Evidence/],
    ['an Evidence heading with a closing sequence', `${CLEAR}\n## Evidence ##\n\nThe dialog now shows the card.\n`, /Evidence heading/],
    ['an unclosed HTML comment in inline code', edit(CLEAR, 'no visual change', 'no visual change; the template quotes `<!--` here'), /unclosed HTML comment/],
    ['an unclosed HTML comment in a fenced block', edit(CLEAR, '## Review', '```\n<!--\n```\n\n## Review'), /unclosed HTML comment/],
  ];
  for (const [name, body, missing] of cases) assert.throws(() => waitReasons(body, []), missing, name);
  assert.deepEqual(waitReasons(edit(CLEAR, '## Review', 'Not done\n\n---\n\n## Review'), []), waitReasons(CLEAR, []), 'a thematic break after a blank line is no heading');
  assert.deepEqual(waitReasons(edit(CLEAR, '## Evidence', '<!-- template note -->\n## Evidence'), []), waitReasons(CLEAR, []), 'a closed HTML comment stays readable');
});

// A git whose fetched main holds `text` as its settings file, or none where it is undefined.
function fetchedMainGit(text) {
  const oid = 'a'.repeat(40);
  return (args) => {
    const command = args.join(' ');
    if (command === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return `${oid}\n`;
    if (command === `ls-tree --full-tree --format=%(objectmode) ${oid} -- .agents/factory-settings.json`) return text === undefined ? '' : '100644\n';
    if (command === `show ${oid}:.agents/factory-settings.json`) return text;
    throw new Error(`unexpected git read: ${command}`);
  };
}

test('coordinator model and effort are read from fetched main', () => {
  const settings = (extra) => JSON.stringify({ version: 1, seats: {}, ...extra });
  assert.deepEqual(readCoordinator({ git: fetchedMainGit(undefined) }), { runtime: 'claude', model: 'opus', effort: 'medium' });
  assert.deepEqual(readCoordinator({ git: fetchedMainGit(settings({})) }), { runtime: 'claude', model: 'opus', effort: 'medium' });
  assert.deepEqual(readCoordinator({ git: fetchedMainGit(settings({ coordinator: { model: 'sonnet', effort: 'high' } })) }), { runtime: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(readCoordinator({ git: fetchedMainGit(settings({ coordinator: { effort: 'max' } })) }), { runtime: 'claude', model: 'opus', effort: 'max' });
  assert.equal(readWaitLevel({ git: fetchedMainGit(settings({ waitForOwner: 'on-screen', coordinator: { effort: 'low' } })) }), 'on-screen');
  assert.throws(() => readCoordinator({ git: fetchedMainGit(settings({ coordinator: { effort: 'huge' } })) }), /pre-approved run setting unavailable on fetched main/);
});
