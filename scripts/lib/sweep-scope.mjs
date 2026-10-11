// sweep-scope.mjs — pure logic for the required check that owns the documentation sweep's scope.
//
// The sweep lands its own pull request, so nobody reads it before it merges. Two rules in
// docs/DOC-SWEEP.md therefore need a mechanical owner rather than the owner's eyes: the diff modifies
// only files in the may-edit column of the manual's scope table, and it introduces no link the
// repository did not already carry. The table is parsed from the manual so the allowlist has one
// home. The caller reads the manual from the BASE commit, never the head, so a diff cannot widen its
// own scope. I/O lives in scripts/lib/sweep-scope-evaluate.mjs; this file is pure.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { Parser } from 'htmlparser2';

// The scope table is the one whose header row is exactly `| May edit | Never edit |`; the may-edit
// paths are every backtick-quoted entry in its left column, in table order. A manual without that
// table, or with an empty left column, is an error: an empty allowlist would fail every diff and read
// as a broken sweep rather than a broken parse.
export function parseMayEdit(manualText) {
  const lines = manualText.split('\n');
  const header = lines.findIndex((line) => line.trim() === '| May edit | Never edit |');
  if (header < 0) throw new Error('docs/DOC-SWEEP.md has no scope table headed `| May edit | Never edit |`');
  const paths = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const left = lines[i].split('|')[1] ?? '';
    for (const m of left.matchAll(/`([^`]+)`/g)) paths.push(m[1]);
  }
  if (paths.length === 0) throw new Error('the scope table\'s may-edit column is empty');
  return paths;
}

// Exact path match only. Every may-edit entry is a file, and a prefix match would let
// `docs/ARCHITECTURE.md.bak` or a directory sibling through on a name it shares.
export function outOfScope(changedPaths, mayEdit) {
  const allowed = new Set(mayEdit);
  return changedPaths.filter((path) => !allowed.has(path));
}

// Both patterns start and end at anything that is not a name character. `\b` and `\w` treat `_` as
// a word character, so a token wrapped in markdown underscore-italics would otherwise never match.
const START = '(?<![A-Za-z0-9.-])';
const END = '(?![A-Za-z0-9-])';
// A scheme followed by `//`, `mailto:` (the one schemeless form this repository uses), and `www.`,
// which GitHub autolinks without a scheme. Anything looser (`type:bug`, `Status:Done`) would read a
// label as a link.
const URI = new RegExp(`${START}(?:[a-z][a-z0-9+.-]*:\\/\\/|mailto:|www\\.)[^\\s<>()"'\`\\]]+`, 'gi');
// A bare host is a dotted name ending in a common top-level domain. File names (`package.json`,
// `board.mjs`) end in extensions that are not on the list; a host on a rarer domain is caught only as
// part of a full URI, which docs/DOC-SWEEP.md says in as many words.
const TLDS = 'com|org|net|io|dev|app|ai|co|uk|eu|us|ca|au|de|fr|nl|ch|se|me|info|biz|xyz|top|site|online|' +
  'cloud|sh|pro|tech|link|click|cc|tv|gg|ly|to|in|jp|cn|ru|br|it|es|pl|no|fi|dk|ie|pt|cz|at|be';
// A host may be written as a wildcard or with a leading dot (`*.example.com`, `.example.com`); the
// marker is admitted so the lookbehind cannot hide it, then dropped from the reported token.
const HOST = new RegExp(`${START}(?:\\*\\.|\\.)?(?:[a-z0-9-]+\\.)+(?:${TLDS})${END}`, 'gi');
// An e-mail literal, which GitHub renders as a `mailto:` link on any domain, listed or not. The
// domain's last character must be a letter, so a version pin (`playwright@1.56.0`) is not a link:
// both GitHub implementations of the autolink extension reject a domain that ends any other way,
// and both allow `_` inside a label, which a host name may not carry.
const EMAIL = new RegExp(`${START}[A-Za-z0-9._+-]+@(?:[A-Za-z0-9_-]+\\.)+[A-Za-z0-9_-]*[A-Za-z]${END}`, 'g');

// The ADDED content lines of a unified diff. Header lines (`+++ b/path`) are recognised by position,
// between a `diff --git` line and its first `@@` hunk, because a content line can be made to start
// with `++ b/` and a pattern on the text alone would treat it as a header.
function addedLines(unifiedDiff) {
  const added = [];
  let inHeader = false;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) inHeader = true;
    else if (line.startsWith('@@')) inHeader = false;
    if (!inHeader && line.startsWith('+')) added.push(line.slice(1));
  }
  return added;
}

// Every URI, e-mail literal and bare host name on the given lines, in order of first appearance. Each
// pattern's own spans leave the line before the next pattern runs, so a `mailto:` or userinfo URI
// yields one token rather than that token and the address or host inside it.
function networkTokens(lines) {
  const tokens = [];
  for (const text of lines) {
    // Sentence punctuation and closing italics or bold markers belong to the prose, not the link.
    const uris = [...text.matchAll(URI)].map((m) => m[0].replace(/[.,;:_*]+$/, ''));
    tokens.push(...uris);
    let rest = text;
    for (const uri of uris) rest = rest.split(uri).join(' ');
    const emails = [...rest.matchAll(EMAIL)].map((m) => m[0]);
    tokens.push(...emails);
    for (const email of emails) rest = rest.split(email).join(' ');
    tokens.push(...[...rest.matchAll(HOST)].map((m) => m[0].replace(/^\*?\./, '')));
  }
  return [...new Set(tokens)];
}

// The tokens of a diff's added lines. Removed and context lines are ignored: a token that was already
// in the tree is not new, and the caller settles whether an added one already appears in the base tree.
export function addedNetworkTokens(unifiedDiff) {
  return networkTokens(addedLines(unifiedDiff));
}

// GitHub renders `&amp;` and a bare `&` in a destination the same way, so the two spellings are one
// destination on both sides of the comparison and in the search that finds the lines to compare.
const decodeAmpersands = (text) => text.split('&amp;').join('&');

// The spellings of `text` a fixed-string search of the tree must look for before anything can vouch
// for it. Case is not one of them: the search folds case itself, while the extractor never does,
// because its output is searched for literally.
export function treeGrepCandidates(text) {
  const decoded = decodeAmpersands(text);
  return [...new Set([text, decoded, decoded.split('&').join('&amp;')])];
}

// The whole `git grep` argument vector, after `git`, that searches one tree for one candidate
// spelling. One builder, so the check and its tests cannot search different trees. The guard's own
// sources are excluded: they are a list of destinations that must not be trusted, spelled out as whole
// extractor tokens, so they are not evidence that the repository points anywhere. They are excluded in
// whatever folder they sit, so a repository that keeps a second copy of them does not vouch through the
// copy. Test code is excluded for the same reason, because a negative fixture names hosts precisely so
// they can be refused; Rust keeps its tests inline, so the whole crate is excluded and a real host named
// only in Rust fails closed. `**/` matches the root directory as well as every subdirectory. Every
// pathspec spells its magic out, so `GIT_GLOB_PATHSPECS` and `GIT_NOGLOB_PATHSPECS` cannot change what
// is excluded, while `GIT_LITERAL_PATHSPECS` would make every pathspec literal, so the search would
// match nothing and the check would refuse: it fails closed. The search runs at the base commit, so a
// pull request cannot widen or narrow it. A pathspec that excludes nothing is not an error, so this is
// safe in any tree.
export function treeGrepArgs(candidate, ref) {
  return ['grep', '--ignore-case', '--fixed-strings', '--null', '-e', candidate, ref,
    '--', ':(exclude,glob)**/scripts/lib/sweep-scope*', ':(exclude,glob)**/scripts/sweep-scope-check.mjs',
    ':(exclude,glob)src-tauri/**', ':(exclude,glob)tests/**', ':(exclude,glob)**/*.test.*'];
}

// The host of an extractor token: the authority after any scheme, before any path, query or fragment,
// with userinfo and port removed. Userinfo is cut from the left, so `https://github.com@evil.icu` is a
// token of `evil.icu` and vouches for nothing under `github.com`.
function tokenHost(token) {
  const authority = token.replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/, '').split(/[/?#]/)[0];
  return authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
}

// Whether the base tree vouches for `text`, given the tree lines a fixed-string search for it
// returned. A hit alone is substring semantics, which would let `https://support.example.com/help`
// vouch for `https://support.example.co` and `https://app.example.app` for `https://app`. The tree
// vouches only when `text` is exactly a token the extractor produces from one of those lines, or, when
// `text` is a bare host by shape, a label-boundary suffix of such a token's host.
export function tokenMatches(text, treeLines) {
  const wanted = decodeAmpersands(text.toLowerCase());
  const tokens = networkTokens(treeLines).map((token) => decodeAmpersands(token.toLowerCase()));
  if (tokens.includes(wanted)) return true;
  // A scheme, a userinfo `@` or a path makes the text a whole destination, which nothing but an exact
  // token can vouch for; only a bare host reaches the suffix clause.
  if (/[:@/]/.test(wanted)) return false;
  return tokens.some((token) => {
    const host = tokenHost(token);
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}

// A destination is a span of one added line that GitHub resolves as a URL, and only five positions
// carry one, each decidable from the line alone: P1 the `](...)` of an inline link or image, P2 the
// `[label]:` of a reference definition, P3 the value of an attribute the sanitizer keeps (`href`,
// `src`, `srcset`, `cite`, `longdesc`) or of the five kept beside them fail-closed, P4 an autolink,
// and P5 an autolink literal in running text. Text outside those spans is prose: a named entity, a
// backslash or a `//`-leading word in a sentence hides no destination, so none of the rules below
// reads one; but a character reference glued to a literal is not prose, because GitHub decodes it
// before it autolinks and links a host longer than the literal.
const DESTINATION_VALUE = '(?:<([^>\\n]*)>|([^\\s)]*))';
const LINK_DESTINATION = new RegExp(`\\]\\(\\s*${DESTINATION_VALUE}`, 'g');
const DEFINITION_DESTINATION = new RegExp(`^ {0,3}\\[[^\\]\\n]+\\]:[ \\t]*${DESTINATION_VALUE}`);
// A quoted value the line never closes is its own shape: the URL parser joins it to the next line,
// so `href="https://www.example.app` plus `.evil.icu"` renders as a host the added line never
// spells. The unterminated alternative sits before the unquoted one, which would swallow the quote.
// The attributes GitHub's sanitizer keeps (`href`, `src`, `srcset`, `cite`, `longdesc`) and the five
// kept beside them fail-closed. One list: the shape rule below and the semantic half further down both
// read it, and an attribute on one list but not the other would be a hole in whichever lacks it.
const DESTINATION_ATTRIBUTES = [
  'href', 'srcset', 'src', 'cite', 'longdesc', 'poster', 'action', 'formaction', 'data', 'ping',
];
// Two of them hold a list of destinations rather than one: `srcset` a comma-separated list of
// candidates each with an optional descriptor, `ping` a space-separated list of URLs. Read whole, an
// external candidate after the first hides behind a leading relative one, which both halves resolve
// as a path on the repository's own origin.
const LIST_VALUED_ATTRIBUTES = ['srcset', 'ping'];
const ATTRIBUTE_DESTINATION = new RegExp(
  `\\b(${DESTINATION_ATTRIBUTES.join('|')})\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|(["'].*)|([^\\s>]*))`, 'gi');
// The autolink's destination is the whole URL it shows, scheme included: cut at the colon instead
// and every ordinary `<https://host>` in prose would read as protocol-relative.
const AUTOLINK_DESTINATION = /<([a-z][a-z0-9+.-]*:[^\s<>\n]*)>/gi;

// HTML's ASCII whitespace, the only characters that separate the tokens of either list. JavaScript's
// `\s` is wider, and a character it counts and HTML does not would cut one URL in two: the prefix is
// often a destination the tree already vouches for, and the remainder resolves relative and drops, so
// the destination a browser actually fetches would never be reported.
const HTML_ASCII_WHITESPACE = '\t\n\f\r ';
const HTML_SPACE_RUN = new RegExp(`[${HTML_ASCII_WHITESPACE}]+`);

// The URLs of a `srcset`, by the standard's own candidate collection: skip leading whitespace and
// commas, take the run of non-whitespace characters as the URL, and if it ends in commas strip them
// and start the next candidate right there; otherwise skip forward to the comma that ends this
// candidate's descriptor. So a comma ends a candidate only at the end of the URL token or after the
// descriptor, and one inside the URL run stays in the URL. Inside the descriptor a comma ends the
// candidate only outside parentheses, which `(` opens and `)` closes; the standard tracks that with a
// boolean, so a second `(` does not nest and a `)` always closes.
function srcsetUrls(value) {
  const isSpace = (character) => HTML_ASCII_WHITESPACE.includes(character);
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]) || value[i] === ',')) i += 1;
    if (i === value.length) break;
    const start = i;
    while (i < value.length && !isSpace(value[i])) i += 1;
    const url = value.slice(start, i);
    if (url.endsWith(',')) {
      urls.push(url.replace(/,+$/, ''));
      continue;
    }
    urls.push(url);
    let inParens = false;
    while (i < value.length && !(value[i] === ',' && !inParens)) {
      if (value[i] === '(') inParens = true;
      else if (value[i] === ')') inParens = false;
      i += 1;
    }
  }
  return urls;
}

// The destinations one list-valued value carries, read by that attribute's own grammar, in first
// appearance order. `srcset` is the candidate list collected above; `ping` is a list of URLs separated
// by runs of ASCII whitespace, so a comma inside one belongs to that URL. The whole value is never a
// candidate: with an absolute URL first, it parses as a URL whose path swallows the descriptor and the
// candidates after it, which is a destination no renderer ever fetches.
function destinationCandidates(attribute, value) {
  const candidates = attribute === 'srcset' ? srcsetUrls(value) : value.split(HTML_SPACE_RUN);
  return [...new Set(candidates.filter(Boolean))];
}

// Each destination carries the whole opening plus its value, so an opening with no value on the line
// can report itself.
function destinations(line) {
  const found = [];
  for (const m of line.matchAll(LINK_DESTINATION)) found.push({ text: m[0], value: m[1] ?? m[2], opening: true });
  const definition = DEFINITION_DESTINATION.exec(line);
  if (definition) found.push({ text: definition[0], value: definition[1] ?? definition[2], opening: true });
  for (const m of line.matchAll(ATTRIBUTE_DESTINATION)) {
    const attribute = m[1].toLowerCase();
    const unterminated = m[4] !== undefined;
    const value = unterminated ? m[4].slice(1) : (m[2] ?? m[3] ?? m[5]);
    // An unterminated attribute is refused whole, list-valued or not: the line never spells its end,
    // so it has no candidates to split into.
    if (unterminated || !LIST_VALUED_ATTRIBUTES.includes(attribute)) {
      found.push({ text: m[0], value, unterminated });
      continue;
    }
    // A refusal names the candidate, not the whole value, so the reader knows which fragment to find.
    for (const candidate of destinationCandidates(attribute, value)) found.push({ text: candidate, value: candidate });
  }
  for (const m of line.matchAll(AUTOLINK_DESTINATION)) found.push({ text: m[0], value: m[1] });
  return found;
}

// A numeric reference, or a named one outside the five an ordinary sentence uses, conceals a
// character of the destination it sits in: `&#47;` spells a slash and `&Tab;` a control.
const CONCEALING_REFERENCE = /&(?:#x?[0-9a-f]+|(?!(?:amp|lt|gt|quot|nbsp);)[a-z]+);/gi;
// The same pattern anchored at one offset, for the P5 rule below: what matters there is not that the
// line carries a reference but that one starts exactly where a literal ends.
const REFERENCE_AT = new RegExp(CONCEALING_REFERENCE.source, 'iy');
// `//` starting a word seats a host on whatever scheme the page was served over, wherever the word
// sits: `[x](//h)`, `href=//h`, `cite='//h'` and an orphan continuation line `//h"` all do it. A
// comment marker (`// note`) and a doubled path separator (`path//file`) are neither.
const PROTOCOL_RELATIVE_WORD = /(?:^|[\s(<="'])(\/\/(?=\S)[^\s)>"'\n]*)/g;
// GitHub's parser reads `\v` and `\f` as whitespace inside a tag where micromark reads text, so a line
// can render a link neither half sees. No document needs a C0 or C1 control but tab, or DEL, so all are refused.
// eslint-disable-next-line no-control-regex -- matching control characters is the rule's whole purpose
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Every destination shape on an added line that hides where it points: the rule that refuses it, the
// fragment refused, and the line it sits on. In order of first appearance; a rule and fragment
// repeated on one line is reported once.
export function hiddenDestinationShapes(unifiedDiff) {
  const shapes = [];
  const seen = new Set();
  const refuse = (line, rule, fragment) => {
    const key = [rule, fragment, line].join('\n');
    if (seen.has(key)) return;
    seen.add(key);
    shapes.push({ line, rule, fragment });
  };
  for (const line of addedLines(unifiedDiff)) {
    for (const [character] of line.matchAll(CONTROL_CHARACTER)) {
      refuse(line, 'CONTROL_CHARACTER', `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    }
    for (const m of line.matchAll(PROTOCOL_RELATIVE_WORD)) refuse(line, 'PROTOCOL_RELATIVE', m[1]);
    // P5. A reference glued to an e-mail literal or a bare host extends the host GitHub links to and
    // leaves the token the extractor reads, and the parser's own positioned node, ending where the
    // literal does, so neither half of the guard can see the extension. A full URI needs no rule: its
    // body admits `&`, `#` and `;`, so the reference is inside the one token the other half refuses.
    for (const m of [...line.matchAll(EMAIL), ...line.matchAll(HOST)]) {
      REFERENCE_AT.lastIndex = m.index + m[0].length;
      const reference = REFERENCE_AT.exec(line);
      if (reference) refuse(line, 'REFERENCE_IN_DESTINATION', reference[0]);
    }
    for (const { text, value, opening, unterminated } of destinations(line)) {
      if (unterminated) refuse(line, 'OPEN_ATTRIBUTE', text);
      if (value === '') {
        // Only a link or definition opening continues onto the next line, which this scan cannot see.
        if (opening) refuse(line, 'NEXT_LINE_DESTINATION', text);
        continue;
      }
      if (value.trimStart().startsWith('//')) refuse(line, 'PROTOCOL_RELATIVE', value);
      if (value.includes('\\')) refuse(line, 'BACKSLASH', value);
      for (const reference of value.matchAll(CONCEALING_REFERENCE)) {
        refuse(line, 'REFERENCE_IN_DESTINATION', reference[0]);
      }
    }
  }
  return shapes;
}

// The other half of the guard. The rules above read one added line at a time, which is the only way to
// see a destination a later edit will complete; they cannot see whether the line renders at all. A fence
// removed three lines earlier, a comment closed, a list indentation changed: each turns inert text into a
// live link without touching the link's own line, and each is a different container rule. So the whole
// before and after documents go through GitHub Flavored Markdown's own parser lineage instead, and the
// caller compares the two sets.

// Every destination resolves against this base. Its host is unregistrable, so a result on that origin is
// a destination that never leaves the repository's own pages: a relative path, a fragment, or a lax
// spelling of the base's own scheme. Anything else points outward, `javascript:` and `data:` included.
const RESOLUTION_BASE = 'https://sweep-scope.invalid/';
const RESOLUTION_ORIGIN = 'https://sweep-scope.invalid';

// A C0 or C1 control or DEL inside a destination is never legible: the URL parser drops tab, newline and
// carriage return before resolving, so `https://www.example.app<TAB>.evil.icu` reads as one host and
// renders as another. The shape rules refuse every control but tab on an added line; this refuses one
// in any destination the head newly renders, whichever line it came from.
const hasControlCharacter = (text) => [...text].some((character) =>
  character < ' ' || (character >= '\x7f' && character <= '\x9f'));

// An autolink literal is the one link whose node covers exactly its own visible text: `<xmpp:a@evil.icu>`
// carries angle brackets and `[x](...)` a label, so in both the text child starts after the node does.
// Its visible spelling is what the tree is searched for, and it is not the URL it resolves to.
// The autolink extension also re-finds a match inside text it has already decoded, and emits those nodes
// with no source position at all, so `x&#64;evil.icu` yields a link whose visible spelling cannot be read
// back. Such a node is judged by its resolved url instead. That is right for the e-mail form, the one
// GitHub links; the `www.` and lax-scheme forms render as plain text there, so reporting them is a
// deliberate over-report. Reporting only a position-less node whose url begins `mailto:` would encode one
// renderer's quirk about when it decodes character references, and over-reporting fails loud with the
// spelling named instead of failing silent.
function visibleAutolinkText(node) {
  if (node.children.length !== 1 || node.children[0].type !== 'text') return null;
  const child = node.children[0];
  if (!node.position || !child.position) return null;
  const covers = child.position.start.offset === node.position.start.offset
    && child.position.end.offset === node.position.end.offset;
  return covers ? child.value : null;
}

// GitHub's disallowed-raw-HTML filter (GFM 6.11, cmark-gfm `extensions/tagfilter.c`): `<`, an optional
// `/` and one of nine names, case-insensitively, followed by whitespace, `>` or `/>`, has its `<`
// escaped. The parser would read the content of those tags as raw text; GitHub renders it as markup, so
// raw HTML is filtered the same way before the parser reads it.
const DISALLOWED_RAW_HTML = /<(?=\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?:[\t\n\v\f\r >]|\/>))/gi;
const filterDisallowedRawHtml = (html) => html.replace(DISALLOWED_RAW_HTML, '&lt;');

// The HTML standard's tag open state: a browser turns `<` into markup only when `!`, `/`, `?` or an
// ASCII letter follows it. Text carrying that shape hides markup from whatever reads it as text.
const HIDDEN_MARKUP = /<[A-Za-z/!?]/;

// A browser closes a comment at `--!>` and the parser does not, and a CommonMark HTML block opened by
// `<!--` runs to the next line carrying `-->`, so everything after the spelling is invisible to the
// parser and live in a browser.
const INCORRECTLY_CLOSED_COMMENT = '--!>';

// A second pass over one raw HTML node, entities left undecoded so `&lt;a` in prose is not a hit. After
// the filter above, the parser's only raw-text entries are its own misreads (`tmp`, `xitle` and
// `xextarea` enter raw text under their own names) and slash-suffixed wrappers such as `<textarea/x>`,
// which escape the filter; a CDATA section reaches it as a comment read to `]]>`, where a browser ends
// it at the first `>`. Each is refused when it could hide markup, named by the innermost open element,
// or by the tag-shaped fragment itself outside any element, once per name per node. The rule
// deliberately over-refuses in the fail-closed direction: `</>`, a slash-suffixed wrapper GitHub renders
// inert, and a `<!--[CDATA[ ... -->` comment are refused too.
function hiddenRawText(html) {
  const found = [];
  const open = [];
  const labels = new Set();
  const parser = new Parser({
    onopentag(name) {
      open.push(name);
    },
    onclosetag() {
      open.pop();
    },
    ontext(text) {
      if (!HIDDEN_MARKUP.test(text)) return;
      const label = open.length > 0 ? `<${open.at(-1)}>` : text.match(/<[A-Za-z/!?][^\s<>]{0,30}>?/)[0];
      if (labels.has(label)) return;
      labels.add(label);
      found.push({ text: label, href: null, problem: 'raw text hides markup a browser renders' });
    },
    oncomment(data) {
      if (data.startsWith('[CDATA[')) {
        found.push({ text: '<![CDATA[', href: null, problem: 'CDATA section a browser ends at the first >' });
      }
    },
  }, { decodeEntities: false });
  parser.write(filterDisallowedRawHtml(html));
  parser.end();
  return found;
}

// The destination-carrying attributes of one raw HTML node, decoded, in document order. The parser owns
// the decoding, so `&amp;` arrives as `&` and matches the same link written as Markdown.
function htmlDestinations(html) {
  const found = [];
  const parser = new Parser({
    onopentag(_tag, attributes) {
      for (const [attribute, destination] of Object.entries(attributes)) {
        if (!DESTINATION_ATTRIBUTES.includes(attribute)) continue;
        if (LIST_VALUED_ATTRIBUTES.includes(attribute)) found.push(...destinationCandidates(attribute, destination));
        else found.push(destination);
      }
    },
  }, { decodeEntities: true });
  parser.write(filterDisallowedRawHtml(html));
  parser.end();
  return found;
}

// Every reference definition's url by identifier. A repeated identifier keeps the FIRST definition,
// which is the one CommonMark resolves against and leaves the rest inert. Collected in its own pass
// because a definition may sit after the reference it resolves, anywhere in the document: CommonMark
// scopes definitions to the whole document, blockquote and list containers included.
function definitionUrls(tree) {
  const urls = new Map();
  const visit = (node) => {
    if (node.type === 'definition' && !urls.has(node.identifier)) urls.set(node.identifier, node.url);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return urls;
}

// What one node points at, as pairs of visible spelling and resolvable destination. They are the same
// string everywhere but an autolink literal, whose visible text carries no scheme. A definition is not
// one of them: on its own it renders nothing, so counting it as rendered would leave its destination
// already in the before set and let the reference that wakes it slip through the difference. The
// reference is what renders, and both its halves are the definition's url. An undefined identifier
// renders as plain text and the parser emits no reference node for it, so a lookup that misses is a
// destination nothing points at and it emits nothing rather than a record of `undefined`.
function nodeDestinations(node, definitions) {
  if (node.type === 'html') return htmlDestinations(node.value).map((value) => [value, value]);
  if (node.type === 'linkReference' || node.type === 'imageReference') {
    const url = definitions.get(node.identifier);
    return url === undefined ? [] : [[url, url]];
  }
  if (node.type === 'image') return [[node.url, node.url]];
  if (node.type !== 'link') return [];
  return [[visibleAutolinkText(node) ?? node.url, node.url]];
}

// One record, or nothing when the destination stays inside the repository's own pages. A destination
// whose spelling hides where it points is reported whatever it resolves to: it is a refusal on its own,
// never a same-origin drop.
function externalDestination(text, destination) {
  let resolved;
  try {
    resolved = new URL(destination, RESOLUTION_BASE);
  } catch {
    // Nothing can vouch for a destination the URL parser will not read, so it is reported, not dropped.
    return { text, href: null, problem: 'unresolvable' };
  }
  if (hasControlCharacter(text)) return { text, href: resolved.href, problem: 'control character' };
  if (resolved.origin === RESOLUTION_ORIGIN) return null;
  return { text, href: resolved.href };
}

// Every external destination the document renders, in document order: `text` is the visible spelling,
// which is the key the base-tree search greps for and the reason nothing here is normalised, and `href`
// is where a browser would go. The caller keys the before and after sets by `text` and judges the
// difference.
export function renderedDestinations(markdownText) {
  const tree = fromMarkdown(markdownText, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = definitionUrls(tree);
  const records = [];
  const visit = (node) => {
    if (node.type === 'html') {
      if (node.value.includes(INCORRECTLY_CLOSED_COMMENT)) {
        records.push({ text: INCORRECTLY_CLOSED_COMMENT, href: null, problem: 'incorrectly closed comment' });
      }
      records.push(...hiddenRawText(node.value));
    }
    for (const [text, destination] of nodeDestinations(node, definitions)) {
      const record = externalDestination(text, destination);
      if (record) records.push(record);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return records;
}

// An HTML page in the may-edit column is judged by a third rule. A browser loads it raw, with no
// sanitizer between the file and the reader, so everything but free text is live and only free text
// may change. The page's skeleton is its own source with every free text chunk deleted; every other
// byte stays verbatim, so a tag, an attribute, a comment, a close tag the parser drops because nothing
// it names is open, and a self-closing rewrite all change it, while text edited, deleted, written into
// an empty element or moved across a tag does not. Inside `ontext`, `endIndex` is the chunk's last
// source offset, inclusive, and with entities left undecoded the chunk is the verbatim source, so its
// length locates its start. `startIndex` does not: after an end tag carrying anything before its `>`
// (`</p >`), it points at those bytes. Text the document ends on arrives in `ontext` too, before
// `onend`. In ordinary text a `<` always starts a new chunk, and raw text arrives whole, so every
// tag-open shape sits inside one chunk. A chunk is free unless a
// `script` or `style` is open anywhere above it (a browser ignores `/>` on either, so a `<script/>`
// makes everything after it code until `</script>`), or its bytes carry the tag-open shape, which is
// text only to the parser (a title's raw text ending at `</title/`, markup inside an SVG title), or it
// comes after a `<!--` inside a script, or after a `script` or `style` the parser closed by implication.
// Those two cases fail closed where the parser ends code before a browser does. From `<!--` a browser
// does not end the script at the first `</script>` after a nested `<script>`. A browser also keeps a
// `<script/>` or `<style/>` open until its own end tag, where the parser lets another element's end tag
// or the end of the page close it. The parser also closes an SVG `<script/>` by implication, which a
// browser leaves empty, so text after one is refused too: a deliberate over-refusal that fails safe.
// Entities stay undecoded, so `&lt;` is text and `<` is not.
function markupSkeleton(html) {
  const open = [];
  let codeMayContinue = false;
  let skeleton = '';
  let at = 0;
  const parser = new Parser({
    onopentag(name) {
      open.push(name);
    },
    onclosetag(name, isImplied) {
      open.pop();
      if (isImplied && (name === 'script' || name === 'style')) codeMayContinue = true;
    },
    ontext(text) {
      const inScript = open.includes('script');
      if (inScript && text.includes('<!--')) codeMayContinue = true;
      if (codeMayContinue || inScript || open.includes('style') || HIDDEN_MARKUP.test(text)) return;
      const end = parser.endIndex + 1;
      skeleton += html.slice(at, end - text.length);
      at = end;
    },
  }, { decodeEntities: false });
  parser.write(html);
  parser.end();
  return skeleton + html.slice(at);
}

// Null when the edit changed only free text, else the first offset at which the two skeletons differ
// and up to 60 characters of each from there. The offset counts skeleton characters, so it is a
// position in the page's markup with its free text deleted, not in the page itself.
export function markupDifference(beforeHtml, afterHtml) {
  const before = markupSkeleton(beforeHtml);
  const after = markupSkeleton(afterHtml);
  if (before === after) return null;
  let index = 0;
  while (before[index] === after[index]) index += 1;
  return { index, before: before.slice(index, index + 60), after: after.slice(index, index + 60) };
}
