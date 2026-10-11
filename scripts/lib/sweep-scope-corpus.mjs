// sweep-scope-corpus.mjs — the rows scripts/lib/sweep-scope.test.mjs judges the sweep-scope guard by, and
// the throwaway repository its end-to-end tests judge them in.
//
// Rows and fixtures only, no assertions: the expectations are the contract, written before the
// implementation and shared byte for byte with every adopter. A row that turns out to be wrong is
// corrected in every adopter as its own decision, never edited to make an implementation pass.
// `evil.icu` and `example.icu` hosts are deliberate: `icu` is not on the extractor's top-level domain
// list, so only the rule under test can catch them.
//
// A rule of the design that carries several lines becomes one row per line (H2a, H2b), because each
// line is judged alone; the letters are the design's own row names.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateSweepScope } from './sweep-scope-evaluate.mjs';
import { treeGrepArgs, treeGrepCandidates } from './sweep-scope.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../sweep-scope-check.mjs');
let parent;
let template;
after(() => {
  if (parent) rmSync(parent, { recursive: true, force: true });
});

// Added lines `hiddenDestinationShapes` must refuse, each with the one rule that must name it.
export const HIDDEN_ROWS = [
  { id: 'H1', after: '[x](//evil.icu/in)', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H2a', after: '[x](&#47;&#47;evil.icu/in)', expect: 'REFERENCE_IN_DESTINATION' },
  { id: 'H2b', after: '<a href="&#x2f;&#x2f;evil.icu">', expect: 'REFERENCE_IN_DESTINATION' },
  { id: 'H3a', after: '[x](&sol;&sol;evil.icu/in)', expect: 'REFERENCE_IN_DESTINATION' },
  { id: 'H3b', after: '[x](https://www.example.app&Tab;.evil.icu)', expect: 'REFERENCE_IN_DESTINATION' },
  { id: 'H4a', after: '[x](', expect: 'NEXT_LINE_DESTINATION' },
  { id: 'H4b', after: '[c]:', expect: 'NEXT_LINE_DESTINATION' },
  { id: 'H5a', after: '[x](\\/\\/evil.icu/in)', expect: 'BACKSLASH' },
  { id: 'H5b', after: '<a href="\\\\evil.icu">', expect: 'BACKSLASH' },
  { id: 'H8', after: '<a href="https://www.example.app', expect: 'OPEN_ATTRIBUTE' },
  { id: 'H9', after: '//evil.icu"', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H12a', after: '<img srcset="//evil.icu/x 1x">', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H12b', after: "<q cite='//evil.icu'>", expect: 'PROTOCOL_RELATIVE' },
  { id: 'H12c', after: '<a href=//evil.icu>', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H13a', after: '[c]://evil.icu', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H13b', after: '[c]: //evil.icu', expect: 'PROTOCOL_RELATIVE' },
  { id: 'H13c', after: '[x](<//evil.icu>)', expect: 'PROTOCOL_RELATIVE' },
  // A list-valued attribute is judged candidate by candidate, so the second candidate cannot hide
  // behind the relative first one: read whole, the value starts with `docs/` and names no host.
  { id: 'H14', after: '<img src="docs/a.png" srcset="docs/a.png 1x,//evil.icu/t.png 2x">', expect: 'PROTOCOL_RELATIVE' },
  // A reference glued to an autolink literal is a destination position too: GitHub decodes it before it
  // autolinks, so it extends the host without changing the token the extractor reads.
  { id: 'H15a', after: 'Write to smoketest@example.com&#46;evil.icu today.', expect: 'REFERENCE_IN_DESTINATION' },
  { id: 'H15b', after: 'See example.com&#46;evil.icu for more.', expect: 'REFERENCE_IN_DESTINATION' },
  // GitHub reads a form feed inside a tag as whitespace, `<p><a href="http:evil.icu/x">x</a></p>` from
  // `gh api /markdown -f mode=gfm`, where the parser reads text; every control but tab is refused alike.
  { id: 'H16a', after: '<a\fhref="http:evil.icu/x">x</a>', expect: 'CONTROL_CHARACTER' },
  { id: 'H16b', after: '<a\vhref="http:evil.icu/x">x</a>', expect: 'CONTROL_CHARACTER' },
  { id: 'H16c', after: 'a\rb', expect: 'CONTROL_CHARACTER' },
  { id: 'H16d', after: 'a\u001b[31mb', expect: 'CONTROL_CHARACTER' },
  { id: 'H16e', after: 'a\u0085b', expect: 'CONTROL_CHARACTER' },
];

// Added lines `hiddenDestinationShapes` must leave alone: legal CommonMark the routine may write, and
// prose that only looks like a destination. Each is a false refusal the narrowing to P1-P4 retires.
export const PASS_ROWS = [
  { id: 'N1', after: 'A &mdash; B &copy; C', expect: 'pass' },
  { id: 'N2', after: '[t](<some path/with spaces.md>)', expect: 'pass' },
  { id: 'N3', after: '[t]( /path )', expect: 'pass' },
  { id: 'N4a', after: '    // comment', expect: 'pass' },
  { id: 'N4b', after: 'a path//file', expect: 'pass' },
  { id: 'N4c', after: 'see https://app.example.app now', expect: 'pass' },
  { id: 'N5', after: '<a href="https://www.example.app">', expect: 'pass' },
  { id: 'N6', after: '[x](evil.icu/in)', expect: 'pass' },
  { id: 'N7', after: '<a href="https://app.example.app/?a=1&amp;b=2">', expect: 'pass' },
  { id: 'N8', after: 'See [the note](docs/NOTE.md) &mdash; later.', expect: 'pass' },
  { id: 'N9', after: '"C:\\Users\\zain\\file.txt" is a Windows path &mdash; fine.', expect: 'pass' },
  { id: 'N10', after: '<p>it&#39;s</p>', expect: 'pass' },
  { id: 'N11a', after: '[x](http:evil.icu/x)', expect: 'pass' },
  { id: 'N11b', after: '[x](javascript:alert(1))', expect: 'pass' },
  // A prose entity later in the line is not glued to an earlier host: the P5 rule anchors at the
  // literal's end and must not keep searching the rest of the line for something to refuse over.
  { id: 'N12', after: 'Visit app.example.app &mdash; it is free.', expect: 'pass' },
  // Tab is the one control character a document legitimately carries on a line.
  { id: 'N13', after: '\tindented with a tab', expect: 'pass' },
];

// Added lines and the exact tokens `addedNetworkTokens` must yield from them. The extractor does not
// fold case (T1 keeps the line's own bytes, so the tree grep and the failure message both read as
// written); the comparison against the tree is what lower-cases. An e-mail literal's own span leaves
// the line before the bare-host pattern runs, so `mailto:` and userinfo URIs yield one token (T7).
export const TOKEN_ROWS = [
  { id: 'T1', after: 'HTTPS://EVIL.ICU/x', expect: ['HTTPS://EVIL.ICU/x'] },
  { id: 'T2', after: 'https://support.example.co', expect: ['https://support.example.co'] },
  { id: 'T4', after: 'www.example.app', expect: ['www.example.app'] },
  { id: 'T5a', after: 'smoketest@example.com', expect: ['smoketest@example.com'] },
  { id: 'T5b', after: 'other@evil.icu', expect: ['other@evil.icu'] },
  { id: 'T6', after: '<someone@evil.icu>', expect: ['someone@evil.icu'] },
  { id: 'T7a', after: 'mailto:x@evil.icu', expect: ['mailto:x@evil.icu'] },
  { id: 'T7b', after: 'https://github.com@evil.icu', expect: ['https://github.com@evil.icu'] },
  { id: 'T8a', after: 'a@sub_domain.evil.icu', expect: ['a@sub_domain.evil.icu'] },
  { id: 'T8b', after: 'xmpp:a@sub_domain.evil.icu', expect: ['a@sub_domain.evil.icu'] },
  { id: 'T8c', after: '[c]:https://evil.icu', expect: ['https://evil.icu'] },
  { id: 'T9', after: 'Pinned playwright@1.56.0 and lodash@4.17.15.', expect: [] },
];

// Destinations judged against the base tree of the throwaway repository the end-to-end tests build:
// `docs/HOSTED.md` carries `https://www.example.app`, `smoketest@example.com` and
// `https://app.example.app/?c=3&d=4`; `docs/ALLOWED.md` carries `https://support.example.com/help`,
// `https://app.example.app` and `<a href="https://app.example.app/?a=1&amp;b=2">`; `docs/LEGACY.md`
// carries, inside one fence, the verbatim lines `[c]://evil.icu`, `[x](&#47;&#47;evil.icu/in)` and
// `a@sub_domain.evil.icu`. A fixed-string grep hits several of the unknown rows verbatim, which is the
// whole point: a hit vouches for nothing until the extractor produces the destination from the matched
// line as a whole token.
export const TREE_ROWS = [
  { id: 'K1', text: '//evil.icu', expect: 'unknown' },
  { id: 'K2', text: 'a@sub_domain.evil.icu', expect: 'known' },
  { id: 'K3a', text: '//evil.icu/in', expect: 'unknown' },
  { id: 'K3b', text: '&#47;&#47;evil.icu/in', expect: 'unknown' },
  { id: 'K4', text: 'https://app.example.app/?a=1&b=2', expect: 'known' },
  { id: 'K5', text: 'https://www.example.app', expect: 'known' },
  { id: 'K6', text: 'www.example.app', expect: 'known' },
  { id: 'K7', text: 'example.app', expect: 'known' },
  { id: 'K8', text: 'smoketest@example.com', expect: 'known' },
  { id: 'K9', text: 'HTTPS://WWW.EXAMPLE.APP', expect: 'known' },
  { id: 'K10', text: 'https://support.example.co', expect: 'unknown' },
  { id: 'K11', text: 'https://app', expect: 'unknown' },
  { id: 'K12', text: 'other@evil.icu', expect: 'unknown' },
  { id: 'K13', text: 'evil.example.app', expect: 'unknown' },
  { id: 'K14', text: 'https://app.example.app@evil.icu', expect: 'unknown' },
  { id: 'K15', text: 'https://app.example.app/?c=3&amp;d=4', expect: 'known' },
];

// Whole documents the semantic half judges: `renderedDestinations(after)` minus
// `renderedDestinations(before)`, keyed by `text`, must equal `expect`. Each `before` is the `after`
// without its link line, so the difference is what the edit newly renders. `text` is the visible
// spelling, because that is what a fixed-string search of the tree can find; `href` is where a browser
// would go. `\t` is a literal tab: R5 needs one to continue a list item, R14 one to hide a host from
// the URL parser, which strips it before resolving. R7 and R8 add no link line at all — they only
// remove the fence or the comment that was keeping one inert, the edit no line-based rule can see.
export const RENDERED_ROWS = [
  {
    id: 'R1',
    before: '- outer\n  - middle\n',
    after: '- outer\n  - middle\n    - inner [x](https://nested.example.icu/u)\n',
    expect: [{ text: 'https://nested.example.icu/u', href: 'https://nested.example.icu/u' }],
  },
  {
    id: 'R2',
    before: '1. outer\n   1. middle\n',
    after: '1. outer\n   1. middle\n      1. inner [x](https://ordered.example.icu/o)\n',
    expect: [{ text: 'https://ordered.example.icu/o', href: 'https://ordered.example.icu/o' }],
  },
  {
    id: 'R3',
    before: '- item\n',
    after: '- item\n- > [x](https://quoted.example.icu/q)\n',
    expect: [{ text: 'https://quoted.example.icu/q', href: 'https://quoted.example.icu/q' }],
  },
  {
    id: 'R4',
    before: 'See [the collector][c].\n\n',
    after: 'See [the collector][c].\n\n> - [c]: https://defined.example.icu/d\n',
    expect: [{ text: 'https://defined.example.icu/d', href: 'https://defined.example.icu/d' }],
  },
  {
    id: 'R5',
    before: '- item\n\n',
    after: '- item\n\n\tcontinued [x](https://tabbed.example.icu/t)\n',
    expect: [{ text: 'https://tabbed.example.icu/t', href: 'https://tabbed.example.icu/t' }],
  },
  // A definition 198 lines from its reference, separated by a blank line so it is its own block and
  // the record comes from a `definition` node, not from the bare URL rendering as an autolink literal.
  {
    id: 'R6',
    before: `Intro.\nRead [the note][n].\n${'filler\n'.repeat(198)}`,
    after: `Intro.\nRead [the note][n].\n${'filler\n'.repeat(198)}\n[n]: https://far.example.icu/n\n`,
    expect: [{ text: 'https://far.example.icu/n', href: 'https://far.example.icu/n' }],
  },
  {
    id: 'R7',
    before: '```\n[x](https://fenced.example.icu/f)\n```\n',
    after: '[x](https://fenced.example.icu/f)\n',
    expect: [{ text: 'https://fenced.example.icu/f', href: 'https://fenced.example.icu/f' }],
  },
  {
    id: 'R8',
    before: '<!--\n<img src="https://hidden.example.icu/h">\n-->\n',
    after: '<img src="https://hidden.example.icu/h">\n',
    expect: [{ text: 'https://hidden.example.icu/h', href: 'https://hidden.example.icu/h' }],
  },
  // An autolink literal shows no scheme, so its visible spelling and its destination differ.
  {
    id: 'R9',
    before: '',
    after: 'Visit www.example.app today.\n',
    expect: [{ text: 'www.example.app', href: 'http://www.example.app/' }],
  },
  {
    id: 'R10a',
    before: '',
    after: 'Write to smoketest@example.com.\n',
    expect: [{ text: 'smoketest@example.com', href: 'mailto:smoketest@example.com' }],
  },
  {
    id: 'R10b',
    before: '',
    after: 'Ask a@sub_domain.evil.icu.\n',
    expect: [{ text: 'a@sub_domain.evil.icu', href: 'mailto:a@sub_domain.evil.icu' }],
  },
  {
    id: 'R11',
    before: '',
    after: '<a href="https://app.example.app/?a=1&amp;b=2">x</a>\n',
    expect: [{ text: 'https://app.example.app/?a=1&b=2', href: 'https://app.example.app/?a=1&b=2' }],
  },
  {
    id: 'R12',
    before: '',
    after: '[t](<https://www.example.app/a b>)\n',
    expect: [{ text: 'https://www.example.app/a b', href: 'https://www.example.app/a%20b' }],
  },
  {
    id: 'R13',
    before: '',
    after: '[a](evil.icu/in) [b](/x) [c](#f) [d](<some path/with spaces.md>) [e](https:/evil.icu/x)\n',
    expect: [],
  },
  {
    id: 'R14',
    before: '',
    after: '[x](<https://www.example.app\t.evil.icu>)\n',
    expect: [{
      text: 'https://www.example.app\t.evil.icu',
      href: 'https://www.example.app.evil.icu/',
      problem: 'control character',
    }],
  },
  {
    id: 'R15',
    before: '',
    after: '[x](http:evil.icu/x)\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R16',
    before: '',
    after: '[x](javascript:alert(1)) [y](data:text/html,x) <xmpp:a@evil.icu>\n',
    expect: [
      { text: 'javascript:alert(1)', href: 'javascript:alert(1)' },
      { text: 'data:text/html,x', href: 'data:text/html,x' },
      { text: 'xmpp:a@evil.icu', href: 'xmpp:a@evil.icu' },
    ],
  },
  {
    id: 'R17',
    before: '',
    after: '[x](\\/\\/evil.icu/in)\n',
    expect: [{ text: '//evil.icu/in', href: 'https://evil.icu/in' }],
  },
  {
    id: 'R18',
    before: '[click][c]\n\n',
    after: '[click][c]\n\n[c]://evil.icu\n',
    expect: [{ text: '//evil.icu', href: 'https://evil.icu/' }],
  },
  {
    id: 'R19',
    before: '',
    after: 'Pinned playwright@1.56.0 and lodash@4.17.15.\n',
    expect: [],
  },
  // A list-valued attribute holds one destination per candidate. Read whole, each of these resolves
  // relative and drops as same-origin, so only the candidate the renderer would fetch is a record.
  {
    id: 'R20a',
    before: '',
    after: '<img src="docs/a.png" srcset="docs/a.png 1x,//evil.icu/t.png 2x">\n',
    expect: [{ text: '//evil.icu/t.png', href: 'https://evil.icu/t.png' }],
  },
  {
    id: 'R20b',
    before: '',
    after: '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/a.png 1x,//evil.icu/t.png 2x"><img src="docs/a.png"></picture>\n',
    expect: [{ text: '//evil.icu/t.png', href: 'https://evil.icu/t.png' }],
  },
  {
    id: 'R21',
    before: '',
    after: '<a ping="/a https://evil.icu/p">x</a>\n',
    expect: [{ text: 'https://evil.icu/p', href: 'https://evil.icu/p' }],
  },
  // A value whose first candidate is absolute must yield that candidate and nothing else: reading the
  // value whole invents a URL no renderer fetches, out of the candidate plus the descriptor and the
  // candidates after it.
  {
    id: 'R20c',
    before: '',
    after: '<img src="docs/a.png" srcset="https://cdn.example.com/a.png 2x">\n',
    expect: [{ text: 'https://cdn.example.com/a.png', href: 'https://cdn.example.com/a.png' }],
  },
  {
    id: 'R20d',
    before: '',
    after: '<img src="docs/a.png" srcset="https://cdn.example.com/a.png 1x, docs/b.png 2x">\n',
    expect: [{ text: 'https://cdn.example.com/a.png', href: 'https://cdn.example.com/a.png' }],
  },
  {
    id: 'R21a',
    before: '',
    after: '<a ping="https://cdn.example.com/p /b">x</a>\n',
    expect: [{ text: 'https://cdn.example.com/p', href: 'https://cdn.example.com/p' }],
  },
  // A comma inside a URL and a character HTML does not call whitespace both keep the candidate whole:
  // cutting either one reports a prefix the tree may vouch for while the browser fetches the rest.
  {
    id: 'R20e',
    before: '',
    after: '<img src="docs/a.png" srcset="https://cdn.example.com/a,b.png">\n',
    expect: [{ text: 'https://cdn.example.com/a,b.png', href: 'https://cdn.example.com/a,b.png' }],
  },
  {
    id: 'R20f',
    before: '',
    after: '<img src="docs/a.png" srcset="https://app.example.app,@evil.icu/x 1x">\n',
    expect: [{ text: 'https://app.example.app,@evil.icu/x', href: 'https://app.example.app,@evil.icu/x' }],
  },
  {
    id: 'R20g',
    before: '',
    after: '<img src="docs/a.png" srcset="https://cdn.example.com/a.png,">\n',
    expect: [{ text: 'https://cdn.example.com/a.png', href: 'https://cdn.example.com/a.png' }],
  },
  {
    id: 'R21b',
    before: '',
    after: '<a ping="https://cdn.example.com/a\vb">x</a>\n',
    expect: [{
      text: 'https://cdn.example.com/a\vb',
      href: 'https://cdn.example.com/a%0Bb',
      problem: 'control character',
    }],
  },
  // A C1 control is a control character too, though the parser keeps it inside a destination.
  {
    id: 'R21c',
    before: '',
    after: '[x](https://cdn.example.com/a\u0085b)\n',
    expect: [{
      text: 'https://cdn.example.com/a\u0085b',
      href: 'https://cdn.example.com/a%C2%85b',
      problem: 'control character',
    }],
  },
  // A comma inside a descriptor's parentheses does not end the candidate, so the candidate after it is
  // still collected and a vouched-for first candidate cannot stand in for it.
  {
    id: 'R20h',
    before: '',
    after: '<img src="docs/a.png" srcset="http://app.example.app 1x(foo,bar),http:app.example.app.evil.icu/x">\n',
    expect: [
      { text: 'http://app.example.app', href: 'http://app.example.app/' },
      { text: 'http:app.example.app.evil.icu/x', href: 'http://app.example.app.evil.icu/x' },
    ],
  },
  // A definition renders nothing on its own, so the reference that wakes a dormant one is the edit
  // that newly renders its destination (R22b). CommonMark keeps the first definition of a repeated
  // identifier and leaves the rest inert (R22c); an image reference resolves like a link one (R22d).
  {
    id: 'R22a',
    before: '',
    after: '[c]: https://lone.example.icu/d\n',
    expect: [],
  },
  {
    id: 'R22b',
    before: '[c]: https://lone.example.icu/d\n',
    after: '[c]: https://lone.example.icu/d\n\nsee [x][c]\n',
    expect: [{ text: 'https://lone.example.icu/d', href: 'https://lone.example.icu/d' }],
  },
  {
    id: 'R22c',
    before: '',
    after: '[c]: https://first.example.icu/a\n[c]: https://second.example.icu/b\n\nsee [x][c]\n',
    expect: [{ text: 'https://first.example.icu/a', href: 'https://first.example.icu/a' }],
  },
  {
    id: 'R22d',
    before: '',
    after: '![n]\n\n[n]: https://img.example.icu/i\n',
    expect: [{ text: 'https://img.example.icu/i', href: 'https://img.example.icu/i' }],
  },
  // The autolink extension re-finds these spellings inside text it has already decoded and emits a link
  // node with no source position, so the visible spelling cannot be read back and the node is judged by
  // its resolved url. GitHub links only the first of the two.
  {
    id: 'R23a',
    before: '',
    after: 'Write to x&#64;evil.icu today.\n',
    expect: [{ text: 'mailto:x@evil.icu', href: 'mailto:x@evil.icu' }],
  },
  {
    id: 'R23b',
    before: '',
    after: 'See www&#46;evil.icu today.\n',
    expect: [{ text: 'http://www.evil.icu', href: 'http://www.evil.icu/' }],
  },
  // GitHub's disallowed-raw-HTML filter (GFM 6.11, cmark-gfm extensions/tagfilter.c) escapes the
  // leading `<` of nine tags, so an anchor a parser would read as raw text inside one is live on GitHub.
  // `gh api /markdown -f mode=gfm` renders R24a as
  // `&lt;textarea&gt;<a href="http:evil.icu/x">x</a>&lt;/textarea&gt;`, and R24b, R24c, R24d and R24f
  // the same with their own tag spelled as written. R24e, the block form, renders
  // `&lt;title&gt;\n<a href="http:evil.icu/x">x</a>\n&lt;/title&gt;`; R24g, a filtered tag inside a
  // block, renders `<div>&lt;xmp&gt;<a href="http:evil.icu/x">x</a>&lt;/xmp&gt;</div>`.
  {
    id: 'R24a',
    before: '',
    after: '<textarea><a href="http:evil.icu/x">x</a></textarea>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24b',
    before: '',
    after: '<script><a href="http:evil.icu/x">x</a></script>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24c',
    before: '',
    after: '<style><a href="http:evil.icu/x">x</a></style>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24d',
    before: '',
    after: '<title><a href="http:evil.icu/x">x</a></title>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24e',
    before: '',
    after: '<title>\n<a href="http:evil.icu/x">x</a>\n</title>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24f',
    before: '',
    after: '<TeXtArEa><a href="http:evil.icu/x">x</a></TeXtArEa>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  {
    id: 'R24g',
    before: '',
    after: '<div><xmp><a href="http:evil.icu/x">x</a></xmp></div>\n',
    expect: [{ text: 'http:evil.icu/x', href: 'http://evil.icu/x' }],
  },
  // A browser closes a comment at `--!>` and the parser does not, so what follows it is live on GitHub
  // and invisible here: R25a renders ` <a href="http:evil.icu/x">x</a>`. R25b renders
  // `<p><a href="x--!&gt;y">z</a></p>`, an inert relative link GitHub keeps; refusing it too is a
  // deliberate fail-closed over-report, because the sweep never writes the sequence.
  {
    id: 'R25a',
    before: '',
    after: '<!-- c --!> <a href="http:evil.icu/x">x</a>\n',
    expect: [{ text: '--!>', href: null, problem: 'incorrectly closed comment' }],
  },
  {
    id: 'R25b',
    before: '',
    after: '<a href="x--!>y">z</a>\n',
    expect: [{ text: '--!>', href: null, problem: 'incorrectly closed comment' }],
  },
  // The parser misreads `tmp`, `xitle` and `xextarea` as raw-text elements, and reads a CDATA section
  // to `]]>` where a browser ends it at the first `>`; GitHub renders each anchor live. R26a renders
  // `<div><a href="http:evil.icu/x">x</a></div>`, as do R26b and R26c; R26d renders
  // ` <a href="http:evil.icu/x">x</a> ]]&gt;`. R26e, a slash-suffixed wrapper the nine-tag filter does
  // not match, renders `<div>&lt;a href="http:evil.icu/x"&gt;x&lt;/a&gt;&lt;/textarea&gt;&lt;/div&gt;</div>`:
  // inert on GitHub, so its refusal pins the fail-closed direction of the rule.
  {
    id: 'R26a',
    before: '',
    after: '<div><tmp><a href="http:evil.icu/x">x</a></tmp></div>\n',
    expect: [{ text: '<tmp>', href: null, problem: 'raw text hides markup a browser renders' }],
  },
  {
    id: 'R26b',
    before: '',
    after: '<div><xitle><a href="http:evil.icu/x">x</a></xitle></div>\n',
    expect: [{ text: '<xitle>', href: null, problem: 'raw text hides markup a browser renders' }],
  },
  {
    id: 'R26c',
    before: '',
    after: '<div><xextarea><a href="http:evil.icu/x">x</a></xextarea></div>\n',
    expect: [{ text: '<xextarea>', href: null, problem: 'raw text hides markup a browser renders' }],
  },
  {
    id: 'R26d',
    before: '',
    after: '<![CDATA[ > <a href="http:evil.icu/x">x</a> ]]>\n',
    expect: [{ text: '<![CDATA[', href: null, problem: 'CDATA section a browser ends at the first >' }],
  },
  {
    id: 'R26e',
    before: '',
    after: '<div><textarea/x><a href="http:evil.icu/x">x</a></textarea></div>\n',
    expect: [{ text: '<textarea>', href: null, problem: 'raw text hides markup a browser renders' }],
  },
  // Tag-shaped text outside any element is named by the fragment itself. GitHub renders R26f as ` `,
  // nothing live, so its refusal pins the fail-closed direction too.
  {
    id: 'R26f',
    before: '',
    after: '<!-- c --> </>\n',
    expect: [{ text: '</>', href: null, problem: 'raw text hides markup a browser renders' }],
  },
];

// Whole-page edits `markupDifference` judges: `pass` when the edit changes only free text, `refused`
// when a browser loading the page raw would see any other change. The page carries each context text
// can sit in: a document title, a style sheet, a paragraph, SVG with its own title, a textarea and a
// script.
const PAGE = [
  '<title>T</title>',
  '<style>b{color:red}</style>',
  '<p class="x">Hello <code>resume</code></p>',
  '<svg viewBox="0 0 1 1"><title>tip</title><text x="1">explorer</text></svg>',
  '<textarea>note</textarea>',
  '<script>show(\'a\');</script>',
  '',
].join('\n');
const edited = (from, to) => PAGE.replace(from, to);

export const MARKUP_ROWS = [
  { id: 'M1', before: PAGE, after: edited('Hello', 'Hi'), expect: 'pass' },
  { id: 'M2', before: PAGE, after: edited('explorer', 'scout'), expect: 'pass' },
  { id: 'M3', before: PAGE, after: edited('<title>T', '<title>Title'), expect: 'pass' },
  // An entity is text in a browser, so `&lt;b&gt;` renders the characters and opens nothing.
  { id: 'M4', before: PAGE, after: edited('Hello', 'Hello &lt;b&gt;'), expect: 'pass' },
  { id: 'M5', before: PAGE, after: edited('<code>resume', '<code>closeout'), expect: 'pass' },
  // A textarea's and an SVG title's content without markup is free text.
  { id: 'M23', before: PAGE, after: edited('note', 'memo'), expect: 'pass' },
  { id: 'M24', before: PAGE, after: edited('<title>tip', '<title>hint'), expect: 'pass' },
  { id: 'M6', before: PAGE, after: edited('Hello', 'Hello <a href="https://evil.icu/x">x</a>'), expect: 'refused' },
  { id: 'M7', before: PAGE, after: edited('<text x="1">', '<image href="https://evil.icu/i.png"/><text x="1">'), expect: 'refused' },
  // Script and style content is code, never free text.
  { id: 'M8', before: PAGE, after: edited('show(\'a\')', 'show(\'b\')'), expect: 'refused' },
  { id: 'M9', before: PAGE, after: `${PAGE}<script src="https://evil.icu/s.js"></script>\n`, expect: 'refused' },
  { id: 'M10', before: PAGE, after: edited('color:red', 'color:blue'), expect: 'refused' },
  { id: 'M11', before: PAGE, after: edited('<p class="x">', '<p class="x" style="background:url(https://evil.icu)">'), expect: 'refused' },
  { id: 'M12', before: PAGE, after: edited('<p class="x">', '<p class="x" onclick="x()">'), expect: 'refused' },
  { id: 'M13', before: PAGE, after: `<link rel="stylesheet" href="https://evil.icu/c.css">\n${PAGE}`, expect: 'refused' },
  { id: 'M14', before: PAGE, after: `${PAGE}<img src="https://evil.icu/t.png">\n`, expect: 'refused' },
  // A browser closes the comment at `--!>`, so the script tag after it is live.
  { id: 'M15', before: PAGE, after: edited('Hello', 'Hello <!-- x --!><script>'), expect: 'refused' },
  // A tag in text is markup even when it is inert.
  { id: 'M16', before: PAGE, after: edited('Hello', 'Hello <b>there</b>'), expect: 'refused' },
  { id: 'M17', before: PAGE, after: edited('class="x"', 'class="y"'), expect: 'refused' },
  { id: 'M18', before: PAGE, after: edited('<code>resume</code>', 'resume'), expect: 'refused' },
  // A head document that is not a page at all.
  { id: 'M19', before: PAGE, after: '', expect: 'refused' },
  // A browser ends the title's raw text at `</title/`, where the parser does not, so the script is live.
  {
    id: 'M20',
    before: PAGE,
    after: edited('<title>T</title>', '<title>T</title/><script>x()</script><title>T</title>'),
    expect: 'refused',
  },
  // A browser parses an SVG title's content as markup.
  { id: 'M21', before: PAGE, after: edited('<title>tip', '<title><img src="https://evil.icu/t.png">'), expect: 'refused' },
  { id: 'M22', before: PAGE, after: edited('<textarea>note', '<textarea><a href="https://evil.icu">x</a>'), expect: 'refused' },
  // Text moved across a tag is still only text changing: every byte of markup stays where it was.
  {
    id: 'M25',
    before: PAGE,
    after: edited('<p class="x">Hello <code>resume</code></p>', '<p class="x"><code>Hello resume</code></p>'),
    expect: 'pass',
  },
  // The parser drops a close tag for an element that is not open; the bytes are still markup.
  { id: 'M26', before: PAGE, after: edited('Hello', 'Hello </b> there'), expect: 'refused' },
  // A browser ignores `/>` on a script and reads everything up to `</script>` as its code, so the text
  // inside the `<b>` is code, not prose.
  {
    id: 'M27',
    before: '<p><script/><b>T</b></script></p>\n',
    after: '<p><script/><b>alert(1)</b></script></p>\n',
    expect: 'refused',
  },
  // `<!--` puts a browser's script data in the escaped state and the `<script>` after it in the
  // double-escaped state, so the first `</script>` does not end the script and `T` is code.
  {
    id: 'M28',
    before: '<script><!--<script></script>-->T</script>\n',
    after: '<script><!--<script></script>-->alert(1)</script>\n',
    expect: 'refused',
  },
  // Deleting a text outright, or writing one into an empty element, changes only text.
  { id: 'M29', before: PAGE, after: edited('<code>resume</code>', '<code></code>'), expect: 'pass' },
  { id: 'M30', before: edited('<code>resume</code>', '<code></code>'), after: PAGE, expect: 'pass' },
  // A `<` that opens no tag is text in a browser; the parser splits the text there, and both halves are free.
  {
    id: 'M31',
    before: edited('Hello', 'Hello < 3 world'),
    after: edited('Hello', 'Hello < 3 planet'),
    expect: 'pass',
  },
  // A browser keeps a `<script/>` or `<style/>` open until its own end tag, so another element's end
  // tag does not close it and the text after that is still code.
  {
    id: 'M32',
    before: '<p><script/>x</p>T</script>\n',
    after: '<p><script/>x</p>alert(1)</script>\n',
    expect: 'refused',
  },
  {
    id: 'M33',
    before: '<p><style/>x</p>T</style>\n',
    after: '<p><style/>x</p>b{background:url(https://evil.icu)}</style>\n',
    expect: 'refused',
  },
  // With no end tag at all, the rest of the page is code: `x</p>/;alert(1)//` is a comparison with a
  // regular expression, then a call.
  { id: 'M34', before: '<p><script/>x</p>T\n', after: '<p><script/>x</p>/;alert(1)//\n', expect: 'refused' },
  // In SVG a browser honours `/>`, so this script is empty and `T` is text. The refusal is a deliberate
  // over-refusal: any script or style the parser closes by implication ends free text for the rest of
  // the page, which fails safe.
  { id: 'M35', before: '<svg><script/></svg><p>T</p>\n', after: '<svg><script/></svg><p>U</p>\n', expect: 'refused' },
  // Whatever an end tag carries before its `>` is tag bytes to a browser: an unterminated quoted value
  // there swallows the markup after it, and added whitespace is still a change to the tag.
  { id: 'M36', before: '<p>a</p >b<b>c</b>\n', after: '<p>a</p =">b<b>c</b>\n', expect: 'refused' },
  { id: 'M37', before: '<p>a</p >b\n', after: '<p>a</p  >bb\n', expect: 'refused' },
];

// The base tree the K rows and the end-to-end tests are judged against. `docs/LEGACY.md` stands for
// what a sweep landed under the weaker rules: destination shapes the guard now refuses, inert inside a
// fence, which a fixed-string grep still finds.
export const ALLOWED = [
  'The app lives at https://app.example.app and nowhere else.',
  'Tracker help: https://support.example.com/help',
  '<a href="https://app.example.app/?a=1&amp;b=2">tracked</a>',
  '',
].join('\n');
const HOSTED = 'The hosted build is https://www.example.app and smoke failures go to smoketest@example.com. ' +
  'A tracked link looks like https://app.example.app/?c=3&d=4.\n';
export const LEGACY = ['Historic plants, fenced so nothing renders:', '', '```', '[c]://evil.icu',
  '[x](&#47;&#47;evil.icu/in)', 'a@sub_domain.evil.icu', '```', '', 'The label above is [click][c].', ''].join('\n');

// A throwaway repository whose base commit carries a two-row scope table and one allowed document.
// `documents` replaces a base document by fiat and `mayEdit` names the paths the table admits, so a
// row can start from the tree it needs without a second helper.
export function repo({ documents = {}, mayEdit = ['docs/ALLOWED.md'] } = {}) {
  if (!template) {
    parent = mkdtempSync(join(tmpdir(), 'sweep-scope-'));
    template = join(parent, 'template');
    mkdirSync(template);
    const templateGit = (...args) => execFileSync('git', args,
      { cwd: template, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    templateGit('init', '-q', '-b', 'main');
    templateGit('config', 'user.email', 'test@example.com');
    templateGit('config', 'user.name', 'test');
    templateGit('config', 'commit.gpgsign', 'false');
  }
  const dir = mkdtempSync(join(parent, 'repo-'));
  cpSync(template, dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const column = mayEdit.map((path) => `\`${path}\``).join(', ');
  write('docs/DOC-SWEEP.md', `# manual\n\n| May edit | Never edit |\n|---|---|\n| ${column} | \`docs/DOC-SWEEP.md\`, \`src/\` |\n`);
  const tree = {
    'docs/ALLOWED.md': ALLOWED,
    'docs/LEGACY.md': LEGACY,
    'docs/HOSTED.md': HOSTED,
    'src/code.js': 'export const x = 1;\n',
    ...documents,
  };
  for (const [rel, text] of Object.entries(tree)) write(rel, text);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commit = (label) => {
    git('add', '-A');
    git('commit', '-q', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const check = (head, at = base) => evaluateSweepScope(at, head, dir);
  const checkCli = (head, at = base) => spawnSync('node', [SCRIPT, at, head], { cwd: dir, encoding: 'utf8' });
  // The check script's own grep stage, called through the same builder, so the tree rows are judged on
  // the lines the real base returns: every spelling of the destination, case-insensitively, with git's
  // `<rev>:<path>` prefix cut at the NUL `--null` writes after it.
  const grep = (text) => {
    const lines = [];
    for (const candidate of treeGrepCandidates(text)) {
      const found = spawnSync('git', treeGrepArgs(candidate, base), { cwd: dir, encoding: 'utf8' });
      for (const match of found.stdout.split('\n').filter(Boolean)) lines.push(match.slice(match.indexOf('\0') + 1));
    }
    return lines;
  };
  return { git, write, commit, check, checkCli, grep, base, dir };
}

// One end-to-end run: `path` is the only may-edit entry, it starts as `before` in the base commit, and
// the head commit replaces it with `after`.
export function judge(path, before, after) {
  const r = repo({ documents: { [path]: before }, mayEdit: [path] });
  r.write(path, after);
  return r.check(r.commit('sweep edit'));
}
