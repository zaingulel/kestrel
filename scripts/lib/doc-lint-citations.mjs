// doc-lint-citations.mjs — pure detection logic for AGENTS.md and CLAUDE.md section
// citations.
//
// Commands and skills route rules by quoting an AGENTS.md or CLAUDE.md section by name
// (`per CLAUDE.md's "Coding standards and the executed test bar"`). A renamed or invented
// heading turns that into a phantom citation: prose that reads authoritative
// and points nowhere. This converts that by-hand vigilance into a
// deterministic check. I/O lives in the caller; this file is pure so it is
// unit-testable without touching the filesystem.

// Every markdown ATX heading name, at any level. CommonMark allows up to 3
// leading spaces (4 makes it an indented code block) and an optional closing
// hash sequence; neither belongs to the name a citation quotes.
export function extractManualHeadings(markdownText) {
  const headings = new Set();
  for (const line of markdownText.split('\n')) {
    const m = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/);
    if (!m) continue;
    const name = (m[1] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (name) headings.add(name);
  }
  return headings;
}

// Matched on the WHOLE text, never per line: a quoted heading legitimately
// wraps across a line break in reflowed prose (`CLAUDE.md's "Autonomy and\n
// owner gates"`), and the negated-quote class crosses newlines by
// construction. A leading `per ` needs no handling — the file name is the
// anchor. Quoted citations inside fenced code blocks ARE scanned, same
// rationale as the sibling path-ref scan: a fenced citation is load-bearing
// prose and its rot is exactly what this catches. The file name may be
// written as inline code (`` `CLAUDE.md`'s "Architecture seams" ``) and the
// possessive is optional (`CLAUDE.md "Reference map"`); both shapes are in
// live use, so neither may be silently skipped.
const CITATION_RE = /`?(CLAUDE|AGENTS)\.md`?(?:['’]s)?\s+["“]([^"”]{1,120}?)["”]/g;

export function extractHeadingCitations(markdownText) {
  const citations = [];
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(markdownText))) {
    citations.push({
      manual: `${m[1]}.md`,
      heading: normalizeHeading(m[2]),
      line: markdownText.slice(0, m.index).split('\n').length,
    });
  }
  return citations;
}

// A citation is written into a sentence, so it carries the sentence's own
// wrapping and terminal punctuation inside the quotes; the heading it cites
// carries neither.
function normalizeHeading(raw) {
  return raw.replace(/\s+/g, ' ').trim().replace(/[.,;:]$/, '').trim();
}

// citations, {CLAUDE.md, AGENTS.md} → Set<heading> (Map or plain object) →
// the citations whose own file has no such heading.
export function checkHeadingCitations(citations, headingsByManual) {
  const headingsFor = (manual) => (headingsByManual instanceof Map
    ? headingsByManual.get(manual)
    : headingsByManual[manual]);
  return citations.filter((c) => !headingsFor(c.manual)?.has(c.heading));
}
