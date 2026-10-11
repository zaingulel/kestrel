// doc-lint-links.mjs — pure detection logic for dead relative Markdown links.
//
// The sibling backtick path-ref scan (scripts/lib/doc-lint.mjs) only sees
// `docs/X.md`; a `[text](../docs/X.md)` link carries no backticks, so a moved
// or deleted target stays silently linked. Resolution is relative to the
// CONTAINING file, which is why this scan needs its own module rather than
// another rule inside extractPathRefs. Pure by design: node:path only, no fs —
// existence stays injectable exactly like checkPathRefs's existsFn.

import path from 'node:path';

// Targets that are not repo paths: any URI scheme (http, mailto, tel, ftp…) or
// a pure in-page anchor. The scheme charset deliberately excludes the dot RFC
// 3986 permits: no real scheme uses one, and allowing it would read
// `GUIDE.md:42` as a scheme and silently skip that path-with-line target.
const EXTERNAL_RE = /^[a-z][a-z0-9+-]*:/i;

// Inline links and image links: [text](target) / ![alt](target). The target
// runs to the first whitespace or paren, so a `(path "Title")` title suffix
// falls away with it.
// Boundary: the paren-free charset means a balanced-paren destination
// (`docs/a(b).md`) is out of contract — no repo path contains parens, and the
// angle-bracket form is the supported escape for an unusual path.
const LINK_RE = /!?\[[^\]]*\]\(\s*([^()\s]+)/g;

// Reference-style definition line: `[label]: target "Title"`. Only the
// definition carries a target; the `[text][label]` use site names a label.
const REF_DEF_RE = /^ {0,3}\[[^\]]+\]:\s+(\S+)/;

// Markdown text → [{target, line}] (1-indexed) for every inline or
// reference-definition link target that could name a repo path. Deliberately
// scans INSIDE fenced code blocks, same rationale as doc-lint.mjs's path-ref
// scan: a fenced reference to a repo file is load-bearing prose and its rot is
// exactly what this scan catches.
export function extractMarkdownLinks(markdownText) {
  const links = [];
  const lines = markdownText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raws = [];
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(lines[i]))) raws.push(m[1]);
    const def = REF_DEF_RE.exec(lines[i]);
    if (def) raws.push(def[1]);
    for (const raw of raws) {
      // `<docs/guide.md>` is CommonMark's angle-bracket destination form; the
      // brackets are delimiters, not part of the path.
      const unwrapped = raw.replace(/^<(.*)>$/, '$1');
      // `//cdn.example.com/x.md` is protocol-relative, so scheme-less but still
      // not a repo path.
      if (EXTERNAL_RE.test(unwrapped) || unwrapped.startsWith('//') || unwrapped.startsWith('#')) continue;
      let target = unwrapped.replace(/#.*$/, ''); // strip a trailing #anchor fragment
      target = target.replace(/:\d+$/, ''); // strip a trailing :NNN line suffix
      if (!target) continue;
      links.push({ target, line: i + 1 });
    }
  }
  return links;
}

// A link target resolved against its CONTAINING file's directory (both
// repo-relative, posix), or null when the resolution escapes the repo root —
// an escaping link can never name a repo file, so it is dead by construction.
export function resolveLinkTarget(containingRel, target) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(containingRel), target));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

// containingRel + its text → the dead subset as [{target, resolved, line}].
// existsFn stays injectable so this module never touches the filesystem.
export function checkMarkdownLinks(containingRel, markdownText, existsFn) {
  const dead = [];
  for (const { target, line } of extractMarkdownLinks(markdownText)) {
    const resolved = resolveLinkTarget(containingRel, target);
    if (resolved === null || !existsFn(resolved)) dead.push({ target, resolved, line });
  }
  return dead;
}
