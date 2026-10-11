// sweep-scope.test.mjs — the CI lane that owns the documentation sweep's scope.
//
// The sweep lands its own pull request, so no one reads it before it merges; these tests are the
// evidence that the two rules docs/DOC-SWEEP.md used to leave to the owner's eyes now fail the
// required check mechanically. The pure functions are tested on the real manual and on synthetic
// tables; the script is run end-to-end against a throwaway Git repository so a stubbed check, a
// head-tree manual read, or a swallowed Git error each goes red here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addedNetworkTokens, hiddenDestinationShapes, markupDifference, outOfScope, parseMayEdit, renderedDestinations,
  tokenMatches, treeGrepArgs, treeGrepCandidates,
} from './sweep-scope.mjs';
import {
  ALLOWED, HIDDEN_ROWS, LEGACY, MARKUP_ROWS, PASS_ROWS, RENDERED_ROWS, TOKEN_ROWS, TREE_ROWS, judge, repo,
} from './sweep-scope-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MANUAL = readFileSync(join(ROOT, 'docs/DOC-SWEEP.md'), 'utf8');
const SCRIPT = join(ROOT, 'scripts/sweep-scope-check.mjs');

function checkCliParity(r, head) {
  const cwd = process.cwd();
  const result = r.checkCli(head);
  assert.deepEqual(r.check(head), { status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(process.cwd(), cwd);
  return result;
}

// A corpus row is one added line, judged in the smallest diff that can carry it.
function addedDiff(line) {
  return [
    'diff --git a/docs/X.md b/docs/X.md',
    '--- a/docs/X.md',
    '+++ b/docs/X.md',
    '@@ -1,1 +1,2 @@',
    ' unchanged',
    `+${line}`,
  ].join('\n');
}

test('parseMayEdit takes only the left column and fails loud on a missing or empty table', () => {
  const table = [
    '| May edit | Never edit |',
    '|---|---|',
    '| **planned.md**, **important**, `a.md`, `b/c.md` | `d.md` |',
    '| | `e.md`, `f/` |',
    '',
    '| Area | Owning document |',
    '|---|---|',
    '| x | `z.md` |',
  ].join('\n');
  assert.deepEqual(parseMayEdit(table), ['a.md', 'b/c.md']);
  assert.throws(() => parseMayEdit('# no table here'), /scope table/);
  assert.throws(() => parseMayEdit('| May edit | Never edit |\n|---|---|\n| | `d.md` |\n'), /empty/);
});

test('outOfScope is an exact-path match, so a shared prefix never admits a never-edit path', () => {
  const mayEdit = ['site/README.md', 'docs/DESIGN.md'];
  assert.deepEqual(outOfScope(['site/README.md', 'docs/DESIGN.md'], mayEdit), []);
  assert.deepEqual(
    outOfScope(['site/relay.js', 'docs/DESIGN.md.bak', 'docs/DOC-SWEEP.md'], mayEdit),
    ['site/relay.js', 'docs/DESIGN.md.bak', 'docs/DOC-SWEEP.md'],
  );
});

test('addedNetworkTokens sees URIs and bare host names on added lines only', async (t) => {
  const diff = [
    'diff --git a/docs/X.md b/docs/X.md',
    '--- a/docs/X.md',
    '+++ b/docs/X.md https://in-a-header.example.com is not content',
    '@@ -1,3 +1,4 @@',
    ' unchanged https://kept.example.com/path',
    '-removed https://gone.example.org',
    '+added https://new.example.com/a?b=1 and mailto:someone@example.io twice: https://new.example.com/a?b=1',
    '+a bare host example.app and registry.npmjs.org, but not package.json, page.html, or board.mjs',
    '+a label such as type:bug or Status:Done is not a link',
    '+italics hide nothing: _collector.example.net_ and _https://evil.example.org/x_ are seen',
    '+++ b/an added line forged to look like a header is content, so https://plus.example.com counts',
    '+a rarer domain is seen only inside a full URI: https://drop.example.zw/in but not drop.example.zw',
    '+a widened domain counts bare: tracker.example.eu; wildcards too: *.wild.example.org and .dot.example.net',
    '+bold markers are prose: **https://bold.example.com** and *https://star.example.com*',
    '+GitHub autolinks www.auto.example.com without a scheme',
  ].join('\n');
  assert.deepEqual(addedNetworkTokens(diff), [
    'https://new.example.com/a?b=1',
    'mailto:someone@example.io',
    'example.app',
    'registry.npmjs.org',
    'https://evil.example.org/x',
    'collector.example.net',
    'https://plus.example.com',
    'https://drop.example.zw/in',
    'tracker.example.eu',
    'wild.example.org',
    'dot.example.net',
    'https://bold.example.com',
    'https://star.example.com',
    'www.auto.example.com',
  ]);
  // An e-mail literal renders as a `mailto:` destination, so it is a token the tree must vouch for;
  // a version pin is not one, and a token that carries its own e-mail is reported once.
  for (const row of TOKEN_ROWS) {
    await t.test(row.id, () => assert.deepEqual(addedNetworkTokens(addedDiff(row.after)), row.expect));
  }
});

test('hiddenDestinationShapes names the rule that refuses each hidden destination shape', async (t) => {
  for (const row of HIDDEN_ROWS) {
    await t.test(row.id, () => {
      const shapes = hiddenDestinationShapes(addedDiff(row.after));
      assert.ok(shapes.length > 0, `${row.after} was not refused`);
      assert.deepEqual([...new Set(shapes.map((shape) => shape.rule))], [row.expect]);
      for (const shape of shapes) {
        assert.deepEqual(Object.keys(shape), ['line', 'rule', 'fragment']);
        assert.equal(shape.line, row.after);
        assert.ok(shape.fragment.length > 0, 'a refusal names the fragment it refuses');
      }
    });
  }
});

test('hiddenDestinationShapes leaves prose and legal destinations alone', async (t) => {
  for (const row of PASS_ROWS) {
    await t.test(row.id, () => assert.deepEqual(hiddenDestinationShapes(addedDiff(row.after)), []));
  }
});

// The other half of the guard, and the one the added lines alone cannot answer: what the whole
// document renders. Each row is a complete before and a complete after, and the claim is their
// difference keyed by the visible spelling, so a fence or comment the edit removes counts as newly
// rendered even though the link line itself never changed.
test('renderedDestinations reports what the after document renders and the before document did not', async (t) => {
  for (const row of RENDERED_ROWS) {
    await t.test(row.id, () => {
      const rendered = new Set(renderedDestinations(row.before).map((record) => record.text));
      const added = renderedDestinations(row.after).filter((record) => !rendered.has(record.text));
      assert.deepEqual(added, row.expect);
    });
  }
});

test('markupDifference passes an edit to free text and refuses any other change to a page (MARKUP_ROWS)', async (t) => {
  for (const row of MARKUP_ROWS) {
    await t.test(row.id, () => {
      const difference = markupDifference(row.before, row.after);
      assert.equal(difference === null, row.expect === 'pass', JSON.stringify(difference));
      if (difference !== null) assert.deepEqual(Object.keys(difference), ['index', 'before', 'after']);
    });
  }
});

// A false refusal costs the sweep its weekly run, so the prose the routine may already rewrite is
// held to the same bar as the corpus: every live may-edit document, read as if wholly added. A Markdown
// document is also rendered, since a refusal the rendered half makes fails the run however old it is.
test('no live may-edit document trips a rule', () => {
  const refusals = [];
  for (const path of parseMayEdit(MANUAL)) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    if (path.endsWith('.md')) {
      for (const record of renderedDestinations(text).filter(({ problem }) => problem)) {
        refusals.push(`${path}: ${record.text} (${record.problem})`);
      }
    }
    const lines = text.split('\n');
    const diff = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,1 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n');
    for (const shape of hiddenDestinationShapes(diff)) refusals.push(`${path}: ${shape.rule} ${shape.fragment}`);
  }
  assert.deepEqual(refusals, []);
});

// The invariant the design rests on: a fixed-string hit vouches for nothing on its own, so each row is
// judged on the lines the base actually returns for it. K1, K3a and K3b are destinations a past sweep
// left inert in `docs/LEGACY.md`; the tree carries their text and still vouches for none of them.
test('tokenMatches vouches for a destination only as a whole token of the base tree', async (t) => {
  const r = repo();
  for (const row of TREE_ROWS) {
    await t.test(`${row.id} ${row.text}`, () => {
      assert.equal(tokenMatches(row.text, r.grep(row.text)), row.expect === 'known');
    });
  }
});

// The trust anchor, asked of the live repository rather than a throwaway one. This file and its corpus
// spell out destinations that must NOT be trusted, as whole extractor tokens, and so do the negative
// fixtures of the Rust crate and the browser specs; were the tree searched with them in it, the guard
// would vouch for every hostile example they own and a sweep could write one into a document unrefused.
test('the live tree vouches for no destination only the guard\'s own sources or test code carry', () => {
  const knownAtHead = (text) => {
    const lines = [];
    for (const candidate of treeGrepCandidates(text)) {
      const found = spawnSync('git', treeGrepArgs(candidate, 'HEAD'), { cwd: ROOT, encoding: 'utf8' });
      for (const match of found.stdout.split('\n').filter(Boolean)) lines.push(match.slice(match.indexOf('\0') + 1));
    }
    return tokenMatches(text, lines);
  };
  for (const text of ['https://github.com@evil.icu', 'https://evil.icu/in', 'https://support.example.co',
    'other@evil.icu', 'https://nested.example.icu/u', 'https://github.com.evil.example/login/device',
    'github.com.evil.example', 'https://evil.com', 'evil.com', 'http://localhost.evil.com', 'localhost.evil.com',
    'team.example.net.evil.com', 'https://evil.example']) {
    assert.equal(knownAtHead(text), false, `the tree at HEAD vouches for ${text}`);
  }
  // A destination the repository legitimately carries and this file and the other excluded test code name
  // throughout, so the rows above cannot pass on a search that returns nothing for everything, and excluding
  // the guard's own sources and test code cannot also exclude a destination the tree legitimately carries.
  assert.equal(knownAtHead('github.com'), true, 'the tree at HEAD vouches for nothing at all');
});

test('repo clones isolate committed, indexed and untracked contamination', () => {
  const a = repo();
  a.git('checkout', '-q', '-b', 'contaminated');
  a.git('config', 'user.email', 'contaminated@example.net');
  a.git('config', 'user.name', 'contaminated');
  a.write('docs/HOSTED.md', 'See https://isolated.example.net/in.\n');
  a.commit('committed contamination');
  a.write('docs/ALLOWED.md', 'staged contamination\n');
  a.git('add', 'docs/ALLOWED.md');
  a.write('docs/UNTRACKED.md', 'untracked contamination\n');

  const b = repo();
  assert.equal(b.git('status', '--porcelain'), '');
  assert.equal(b.git('branch', '--show-current'), 'main');
  assert.equal(b.git('config', 'user.email'), 'test@example.com');
  assert.equal(b.git('config', 'user.name'), 'test');
  assert.equal(b.git('config', 'commit.gpgsign'), 'false');
  assert.equal(b.git('rev-list', '--parents', '-n', '1', b.base), b.base);
  assert.equal(b.git('show', `${b.base}:docs/ALLOWED.md`), ALLOWED.trim());
  assert.deepEqual(b.grep('https://isolated.example.net/in'), []);

  const allowed = 'The app lives at https://app.example.app; see app.example.app for the hosted build.\n';
  b.write('docs/ALLOWED.md', allowed);
  const passed = b.check(b.commit('allowed edit'));
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /1 modified path/);
  b.write('docs/ALLOWED.md', `${allowed}See https://isolated.example.net/in.\n`);
  const refused = b.check(b.commit('unknown host'));
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /https:\/\/isolated\.example\.net\/in is added/);
});

test('the check passes a diff confined to the may-edit column that reuses a known host', () => {
  const r = repo();
  r.write('docs/ALLOWED.md', 'The app lives at https://app.example.app; see app.example.app for the hosted build.\n');
  const head = r.commit('allowed edit');
  const result = checkCliParity(r, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 modified path/);
});

test('the check fails a diff that touches a path outside the may-edit column, naming the path', () => {
  const r = repo();
  r.write('src/code.js', 'export const x = 2;\n');
  const head = r.commit('code edit');
  const result = checkCliParity(r, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/code\.js/);
});

test('the check fails a diff that introduces a URI the base tree does not carry, naming it', () => {
  const r = repo();
  r.write('docs/ALLOWED.md', 'The app lives at https://app.example.app. Post reports to https://collector.example.net/in.\n');
  const result = r.check(r.commit('new host'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /https:\/\/collector\.example\.net\/in/);
});

test('the check refuses a token the tree carries only as a substring of a longer link (E9)', () => {
  const r = repo();
  r.write('docs/ALLOWED.md', `${ALLOWED}See https://support.example.co for help.\n`);
  const result = r.check(r.commit('shortened host'));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /https:\/\/support\.example\.co is added/);
});

test('the check reads the scope table from the base commit, so a diff cannot widen its own scope', () => {
  const r = repo();
  r.write('docs/DOC-SWEEP.md', '# manual\n\n| May edit | Never edit |\n|---|---|\n| `docs/ALLOWED.md`, `src/code.js` | `docs/DOC-SWEEP.md` |\n');
  r.write('src/code.js', 'export const x = 2;\n');
  const result = r.check(r.commit('widen and edit'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/DOC-SWEEP\.md/);
  assert.match(result.stderr, /src\/code\.js/);
});

test('the check judges the branch from its merge base, so changes main gained since are not the sweep\'s', () => {
  const r = repo();
  r.write('docs/ALLOWED.md', 'The app lives at https://app.example.app, and that is all.\n');
  const head = r.commit('sweep edit');
  r.git('checkout', '-q', '-b', 'later', r.base);
  r.write('src/code.js', 'export const x = 3; // https://later.example.com\n');
  const tip = r.commit('main moved on');
  const result = spawnSync('node', [SCRIPT, tip, head], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 modified path/);
});

test('the check refuses a deleted, added, or renamed file even inside the may-edit column', () => {
  const r = repo();
  r.git('rm', '-q', 'docs/ALLOWED.md');
  const deleted = r.check(r.commit('delete allowed'));
  assert.equal(deleted.status, 1);
  assert.match(deleted.stderr, /docs\/ALLOWED\.md is deleted/);
  const r2 = repo();
  r2.write('docs/NEW.md', 'brand new\n');
  const added = r2.check(r2.commit('add new'));
  assert.equal(added.status, 1);
  assert.match(added.stderr, /docs\/NEW\.md is added/);
  const r3 = repo();
  r3.git('mv', 'docs/ALLOWED.md', 'docs/RENAMED.md');
  const renamed = r3.check(r3.commit('rename allowed'));
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /docs\/ALLOWED\.md -> docs\/RENAMED\.md is renamed/);
});

test('the check refuses rendered-link markup outright, naming the fragment', () => {
  const r = repo();
  r.write('docs/ALLOWED.md', 'The app lives at https://app.example.app; see [the collector](https:&#47;&#47;collector&#46;example&#46;com).\n');
  const result = r.check(r.commit('encoded link'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFERENCE_IN_DESTINATION/);
});

test('the check rejects missing or unresolvable commits instead of reporting a clean diff', () => {
  const r = repo();
  const noArgs = spawnSync('node', [SCRIPT], { cwd: dirname(SCRIPT), encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  const head = '0000000000000000000000000000000000000000';
  const bad = checkCliParity(r, head);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /0000000/);
});

test('the evaluator fails loudly on a malformed base manual', () => {
  const r = repo({ documents: { 'docs/DOC-SWEEP.md': '# manual without a scope table\n' } });
  r.write('docs/ALLOWED.md', 'The app lives at https://app.example.app, and that is all.\n');
  const head = r.commit('allowed edit');
  assert.throws(() => r.check(head), {
    message: 'docs/DOC-SWEEP.md has no scope table headed `| May edit | Never edit |`',
  });
});

// The end-to-end rows, written from the attacker's side rather than the implementation's: a week of
// the routine's life per row, run against the throwaway repository above.
//
// The documents a row starts from when the standard tree will not do. `FENCED` renders nothing but the
// tracker help link, so a fence removed from around the app link is genuinely newly rendered; `AMPERSAND`
// carries the tracked link in its bare-`&` spelling; `CONTROL` carries a destination with a tab in it,
// which renders as a host the line never spells.
const FENCED = ['Tracker help: https://support.example.com/help', '', '```',
  '[x](https://app.example.app)', '```', ''].join('\n');
const AMPERSAND = ['The app lives at https://app.example.app and nowhere else.',
  'A tracked link: https://app.example.app/?a=1&b=2', ''].join('\n');
const CONTROL = ['Tracker help: https://support.example.com/help', '', '```',
  '[x](<https://www.example.app\t.evil.icu>)', '```', ''].join('\n');

// Removing the fence lines and nothing else leaves a deletion-only diff: the context-free half sees no
// added line at all, so only the semantic half can speak.
const unfenced = (document) => document.split('\n').filter((line) => line !== '```').join('\n');

// Week one of the plant-then-reactivate attack. Inert text is still added text, so every spelling of
// the plant is refused the week it is written and the week that would wake it never comes.
const PLANTS = [
  { id: 'E1a', line: '[x](//evil.icu/in)', named: /docs\/ALLOWED\.md: PROTOCOL_RELATIVE refuses \/\/evil\.icu\/in/ },
  { id: 'E1b', line: 'https://evil.icu/in', named: /https:\/\/evil\.icu\/in is added by this diff/ },
  { id: 'E1c', line: '![p](&#47;&#47;evil.icu/in)', named: /docs\/ALLOWED\.md: REFERENCE_IN_DESTINATION refuses &#47;/ },
  { id: 'E1d', line: '[c]://evil.icu', named: /docs\/ALLOWED\.md: PROTOCOL_RELATIVE refuses \/\/evil\.icu/ },
  { id: 'E1e', line: 'other@evil.icu', named: /other@evil\.icu is added by this diff and is not a whole token anywhere in the tree/ },
];
test('the check refuses a destination planted inside a fence, the week it is planted (E1)', async (t) => {
  for (const row of PLANTS) {
    await t.test(row.id, () => {
      const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n\`\`\`\n${row.line}\n\`\`\`\n`);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, row.named);
    });
  }
});

test('the check reports, and does not refuse, a reactivated destination the tree already carries (E2)', () => {
  const result = judge('docs/ALLOWED.md', FENCED, unfenced(FENCED));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 newly rendered destination\(s\), all already in the tree/);
});

test('the check reports an autolink literal the tree vouches for as newly rendered (E3)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\nVisit www.example.app today.\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 newly rendered destination\(s\)/);
});

// The observable difference the parser makes: one line, two containers, two verdicts.
test('the check counts a link in a paragraph as newly rendered and the same line in a fence as inert (E5)', () => {
  const link = '[x](https://app.example.app)';
  const live = judge('docs/ALLOWED.md', FENCED, `${FENCED}\n${link}\n`);
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, /1 newly rendered destination\(s\)/);
  const inert = judge('docs/ALLOWED.md', FENCED, FENCED.replace('```\n', `\`\`\`\n${link}\n`));
  assert.equal(inert.status, 0, inert.stderr);
  assert.match(inert.stdout, /0 newly rendered destination\(s\)/);
});

test('the check passes the legal prose and same-origin destinations the routine may write (E6)', () => {
  const prose = 'A &mdash; B, see [t](<some path/with spaces.md>) and [u]( /x ).\n' +
    '"C:\\Users\\zain\\file.txt" is a Windows path &mdash; fine.\n';
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n${prose}`);
  assert.equal(result.status, 0, result.stderr);
});

// The invariant on the way out. The tree carries all three plants verbatim, so a fixed-string hit
// vouches for each of them; only the e-mail is a token the extractor produces, and only it is let
// through. Nothing is added, so the context-free half cannot see this diff at all.
test('the check refuses a deletion-only diff that wakes plants the tree cannot vouch for (E7)', () => {
  const result = judge('docs/LEGACY.md', LEGACY, unfenced(LEGACY));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/LEGACY\.md: the newly rendered destination \/\/evil\.icu \(/);
  assert.match(result.stderr, /docs\/LEGACY\.md: the newly rendered destination \/\/evil\.icu\/in \(/);
  assert.doesNotMatch(result.stderr, /a@sub_domain\.evil\.icu/);
});

test('the check reports a woken e-mail literal the extractor already tokenises in the tree (E7)', () => {
  const freed = ['Historic plants, fenced so nothing renders:', '', '```', '[c]://evil.icu',
    '[x](&#47;&#47;evil.icu/in)', '```', '', 'a@sub_domain.evil.icu', '', 'The label above is [click][c].', ''].join('\n');
  const result = judge('docs/LEGACY.md', LEGACY, freed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 newly rendered destination\(s\)/);
});

// `&amp;` and a bare `&` are one destination, so the three ways the tree and the diff can spell the
// same tracked link all agree.
test('the check reads an entity-escaped ampersand and a bare one as the same destination (E8)', () => {
  const html = '<a href="https://app.example.app/?a=1&amp;b=2">x</a>';
  const a = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n${html}\n`);
  assert.equal(a.status, 0, a.stderr);
  const b = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n[q](https://app.example.app/?a=1&b=2)\n`);
  assert.equal(b.status, 0, b.stderr);
  const c = judge('docs/ALLOWED.md', AMPERSAND, `${AMPERSAND}\n${html}\n`);
  assert.equal(c.status, 0, c.stderr);
});

// The shape rules the narrowing dropped. Neither spelling is an extractor token, so nothing can vouch
// for them and the semantic half refuses each on its own.
test('the check refuses a lax or non-token scheme as an unknown rendered destination (E10)', () => {
  for (const line of ['[x](http:evil.icu/x)', '[x](javascript:alert(1))']) {
    const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n${line}\n`);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /the newly rendered destination/);
    assert.match(result.stderr, /evil\.icu|javascript:alert/);
  }
});

// A definition the base carries live but unreferenced renders nothing, so the reference that wakes it
// is the edit that publishes the link. The added line carries no network token and sits in no
// destination position, so the context-free half has nothing to refuse and only the semantic half can
// speak. The tree carries the destination's text, in the base document itself, but the extractor does
// not tokenise `//evil.icu`, so nothing vouches for it.
test('the check refuses a reference that wakes a dormant definition the tree cannot vouch for (E11)', () => {
  const result = judge('docs/ALLOWED.md', '[c]: //evil.icu\n', '[c]: //evil.icu\n\nsee [click][c].\n');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/ALLOWED\.md: the newly rendered destination \/\/evil\.icu \(/);
});

test('the check refuses a control character in a destination whatever the diff shows (E10)', () => {
  const result = judge('docs/ALLOWED.md', CONTROL, unfenced(CONTROL));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the rendered destination .* is refused \(control character\)/);
  // The refusal line quotes the destination escaped, never with the control character raw.
  const unprintable = CONTROL.replace('\t.evil.icu', '/a\u0001b');
  const escaped = judge('docs/ALLOWED.md', unprintable, unfenced(unprintable));
  assert.equal(escaped.status, 1, escaped.stdout);
  assert.match(escaped.stderr, /the rendered destination .* is refused \(control character\)/);
  assert.ok(!escaped.stderr.includes('\u0001'), 'the log carries no raw U+0001');
});

// Where the parser and GitHub disagree on raw HTML. GitHub escapes a filtered tag and renders the
// anchor inside it; a browser closes a comment at `--!>`; the parser reads `tmp` as raw text a browser
// renders as markup. The lax scheme keeps the token half silent, so only the rendered half speaks.
test('the check reports an anchor inside a tag GitHub filters under the destination GitHub reaches (E13)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n<textarea><a href="http:evil.icu/x">x</a></textarea>\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the newly rendered destination http:evil\.icu\/x \(http:\/\/evil\.icu\/x\)/);
});

test('the check refuses an incorrectly closed comment in raw HTML (E14)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n<!-- c --!> <a href="http:evil.icu/x">x</a>\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the rendered destination --!> is refused \(incorrectly closed comment\)/);
});

test('the check refuses raw text the parser swallows that hides markup (E14b)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n<div><tmp><a href="http:evil.icu/x">x</a></tmp></div>\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the rendered destination <tmp> is refused \(raw text hides markup/);
});

// The guard's own sources list destinations that must not be trusted, so they are excluded from the
// search that decides what the repository vouches for, in whatever folder they sit. Pinned through the
// real check script, whose `knownInTree` calls the shared argument builder. The root plants pin that
// `**/` matches the root; the `copy/` plants pin a second copy of the sources kept in another folder.
// The last run plants the same content at an ordinary path, so the others cannot pass on a search that
// finds nothing anywhere.
test('the tree does not vouch for a destination only a guard source carries (E12)', async (t) => {
  const PLANT = 'export const ROWS = [{ id: \'X\', line: \'[x](https://evil.icu/in)\' }];\n';
  const EDIT = 'See [docs](https://evil.icu/in).\n';
  for (const path of ['scripts/lib/sweep-scope-corpus.mjs', 'scripts/sweep-scope-check.mjs',
    'copy/scripts/lib/sweep-scope-corpus.mjs', 'copy/scripts/sweep-scope-check.mjs']) {
    await t.test(path, () => {
      const guarded = repo({ documents: { 'docs/ALLOWED.md': '', [path]: PLANT }, mayEdit: ['docs/ALLOWED.md'] });
      guarded.write('docs/ALLOWED.md', EDIT);
      const refused = guarded.check(guarded.commit('edit vouched only by a guard source'));
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, /https:\/\/evil\.icu\/in/);
    });
  }

  const ordinary = repo({
    documents: { 'docs/ALLOWED.md': '', 'docs/NOTES.md': PLANT },
    mayEdit: ['docs/ALLOWED.md'],
  });
  ordinary.write('docs/ALLOWED.md', EDIT);
  const passed = ordinary.check(ordinary.commit('edit vouched by an ordinary path'));
  assert.equal(passed.status, 0, passed.stderr);
});

// Test code names hosts precisely so they can be refused, so it vouches for nothing either. The
// root-level plant pins that `**/` matches the root; the nested plant pins that the glob crosses
// directories. E12's `docs/NOTES.md` run is the pass that keeps these from passing on an empty search.
test('the tree does not vouch for a destination only test code carries (E12b)', async (t) => {
  const PLANT = 'export const ROWS = [{ id: \'X\', line: \'[x](https://evil.icu/in)\' }];\n';
  const EDIT = 'See [docs](https://evil.icu/in).\n';
  for (const path of ['src-tauri/src/x.rs', 'tests/x.spec.ts', 'scripts/lib/x.test.mjs', 'x.test.mjs']) {
    await t.test(path, () => {
      const r = repo({ documents: { 'docs/ALLOWED.md': '', [path]: PLANT }, mayEdit: ['docs/ALLOWED.md'] });
      r.write('docs/ALLOWED.md', EDIT);
      const refused = r.check(r.commit('edit vouched only by test code'));
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, /https:\/\/evil\.icu\/in/);
    });
  }
});

test('the check fails closed on a may-edit entry that is neither Markdown nor HTML (E16)', () => {
  const result = judge('docs/NOTES.txt', 'notes\n', 'notes, revised\n');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/NOTES\.txt is in the may-edit column but is not Markdown, so the rendered half cannot judge it/);
});

// A form feed makes the anchor live on GitHub and plain text to the parser, so only the control
// character rule can see it; the refusal line escapes it rather than writing it raw to the log.
test('the check refuses a control character on an added line (E18)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n<a\fhref="http:evil.icu/x">x</a>\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/ALLOWED\.md: CONTROL_CHARACTER refuses U\+000C on the added line: /);
  assert.ok(!result.stderr.includes('\f'), 'the log carries no raw form feed');
});

// An unterminated attribute and a token both carry the escape sequence into their refusal lines, so
// each line escapes what it quotes and no terminal control sequence reaches the log.
test('the check writes no raw control character in any refusal line (E18b)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\n<a href="https://evil.icu/\x1b[31m\na\u0085b\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/ALLOWED\.md: OPEN_ATTRIBUTE refuses /);
  assert.ok(!result.stderr.includes('\x1b'), 'the log carries no raw escape character');
  // JSON quoting leaves a C1 control raw, so the quoted added line needs the output step too.
  assert.ok(!result.stderr.includes('\u0085'), 'the log carries no raw U+0085');
});

// A file name is pull-request bytes too, and git prints bytes at or above 0x80 as they are.
test('the check writes no raw control character from an added file\'s name (E18c)', () => {
  const r = repo();
  r.write('docs/a\u0085b.md', 'x\n');
  const result = r.check(r.commit('add a file'));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!result.stderr.includes('\u0085'), 'the log carries no raw U+0085');
});

// A name git reads as pathspec magic fails the diff git runs on it, so the git failure line quotes it.
test('the check writes no raw control character in a git failure line (E18d)', {
  skip: process.platform === 'win32' && 'NTFS refuses ":" in a file name, so the pathspec-magic name cannot exist on disk',
}, () => {
  const name = ':(x\u0085';
  const r = repo({ documents: { [name]: 'a\n' } });
  r.write(name, 'b\n');
  const result = r.check(r.commit('modify a crafted name'));
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(!result.stderr.includes('\u0085'), 'the log carries no raw U+0085');
});

// A NUL makes git guess the document is binary and print no lines at all, so both halves that read added
// lines would see nothing, the new destination beside the NUL included.
test('the check reads added lines as text even when a NUL makes git guess binary (E19)', () => {
  const result = judge('docs/ALLOWED.md', ALLOWED, `${ALLOWED}\nsee https://evil-nul.icu/x \u0000 here\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /docs\/ALLOWED\.md: CONTROL_CHARACTER refuses U\+0000 on the added line: /);
  assert.match(result.stderr, /https:\/\/evil-nul\.icu\/x is added by this diff and is not a whole token anywhere in the tree/);
});
