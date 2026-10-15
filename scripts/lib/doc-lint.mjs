// doc-lint.mjs — pure detection logic for the doc-prose lint gate.
//
// Detects three prose-vigilance violations: a dangling
// backtick-quoted repo path in prose, a skill instructing the model to fire a
// DISABLED (user-invoked-only) sibling skill, and a stray date-stamp in an
// always-loaded doc. I/O lives in the CLI wrapper (scripts/doc-lint.mjs); this
// file is pure so it is unit-testable without touching the filesystem.

// Known repo roots + exact root-level files a backtick token can legally start
// with (CLAUDE.md's directory map + root allowlist).
const KNOWN_ROOTS = [
  'docs/', 'src/', 'scripts/', '.claude/', '.githooks/', '.github/',
  '.agents/', '.codex/',
];
const KNOWN_ROOT_FILES = new Set([
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'eslint.config.mjs', '.gitignore',
  'GLOSSARY.md', 'bot.py', 'speech.py', 'asr_worker.py', 'run-voice.sh', 'requirements-test.txt',
]);

// Deliberate escape hatch: the repo's convention for citing a deleted doc.
const GIT_HISTORY_MARKER = '(git history)';

// Paths a doc can legitimately cite that git will NEVER track — deliberately
// gitignored or build-generated, one comment each. Existence resolution is
// git-tracked-set-only (see buildTrackedSet/pathExists below); a filesystem
// existence check made local runs green and a fresh CI checkout red (the
// PR #405 bug this fixes), so exceptions must be explicit.
export const KNOWN_UNTRACKED = [
  '.claude/launch.json', // local preview config, ignored by the exact .claude/launch.json entry
  '.claude/worktrees/', // builder worktree lanes, ignored by the exact .claude/worktrees/ entry
  'node_modules/', // deps
];

// Seams the shared region of `AGENTS.md` names that an install does not write: a reference to one is accepted
// where the repository holds none. Exact, never by prefix, so a dangling `src/missing.mjs` is still reported.
export const OPTIONAL_SEAMS = [
  'src/', 'scripts/gates/', 'scripts/gates/stop', 'scripts/gates/pre-commit', 'scripts/gates/pre-push-main',
  '.codex/rules/playwright.rules',
];

// ref resolves against KNOWN_UNTRACKED if it IS an entry (with or without its
// trailing slash) or is nested under one.
function isKnownUntracked(ref) {
  return KNOWN_UNTRACKED.some((known) => {
    const knownDir = known.endsWith('/') ? known : `${known}/`;
    return ref === known || ref === knownDir.slice(0, -1) || ref.startsWith(knownDir);
  });
}

// git ls-files output (tracked FILE paths, forward-slash, no leading `./`) →
// a Set of those files PLUS every directory prefix implied by them (`docs/`,
// `docs/archive/`, …) — git only tracks files, never empty directories, so a
// doc that cites a directory needs the prefix derived, not looked up. Pure:
// the CLI hands this the real `git ls-files` list; tests hand it a fixed one.
export function buildTrackedSet(trackedFilePaths) {
  const set = new Set();
  for (const file of trackedFilePaths) {
    set.add(file);
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      set.add(`${parts.slice(0, i).join('/')}/`);
    }
  }
  return set;
}

// The ONE existence resolver: a ref exists if it's a tracked file, a tracked
// directory prefix (with or without its own trailing slash), a path that
// resolves under KNOWN_UNTRACKED, or exactly an OPTIONAL_SEAMS entry. No
// filesystem check anywhere in this path: local and a fresh CI checkout
// resolve identically by construction.
export function pathExists(trackedSet, ref) {
  if (trackedSet.has(ref) || trackedSet.has(`${ref}/`)) return true;
  const bare = ref.replace(/\/$/, '');
  return isKnownUntracked(ref) || OPTIONAL_SEAMS.some((seam) => seam.replace(/\/$/, '') === bare);
}

// Extract every backtick-quoted token from markdown text that looks like a
// concrete repo-path reference (not a glob/placeholder pattern like `docs/**`
// or `src/script/NN-*.js`, which are legal prose, not refs).
export function extractPathRefs(markdownText) {
  const refs = [];
  const lines = markdownText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(GIT_HISTORY_MARKER)) continue;
    const tokens = line.match(/`([^`]+)`/g) || [];
    for (const raw of tokens) {
      let token = raw.slice(1, -1);
      token = token.replace(/\s§[^`]*$/, ''); // strip a trailing " §…" section suffix
      token = token.replace(/:\d+$/, ''); // strip a trailing :NNN line suffix
      if (/[*<>{}|$]/.test(token)) continue; // glob/placeholder marker
      if (/\s/.test(token)) continue; // not a single clean path token
      if (!token) continue;
      const isRoot = KNOWN_ROOTS.some((r) => token.startsWith(r));
      const isRootFile = KNOWN_ROOT_FILES.has(token);
      if (!isRoot && !isRootFile) continue;
      refs.push({ path: token, line: i + 1 });
    }
  }
  return refs;
}

// refs → the subset that don't exist, per the caller's existsFn (kept
// injectable so the pure module never touches fs itself).
export function checkPathRefs(refs, existsFn) {
  return refs.filter((r) => !existsFn(r.path)).map((r) => ({ path: r.path, line: r.line }));
}

// tracked paths → the Set of `<name>` for every vendored upstream skill (the ONE derivation
// shared by the CLI and both real-tree tests).
export function vendoredSkillNames(paths) {
  return new Set(paths
    .map((rel) => rel.match(/^\.agents\/upstream\/[^/]+\/([^/]+)\/SKILL\.md$/)?.[1])
    .filter(Boolean));
}

// The ONE scan-set resolver shared by the CLI and repo-pass test. Skills live once under
// .agents/skills/; `.claude/skills/<name>` is a byte-identical copy of `.agents/skills/<name>` (the
// contract test enforces it), so its bodies are classified as nothing and linted once, through the twin.
// A vendored upstream skill's body at `.agents/upstream/<source>/<name>/SKILL.md`, and its copy at
// `.agents/skills/<name>/SKILL.md` whenever `<name>` is in `vendoredSkillNames`, feed only `skillMeta`
// for the disabled-skill set; those bodies are never linted.
export function classifyDocLintPath(rel, vendoredSkillNames = new Set()) {
  const vendoredCopy = rel.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/);
  if (vendoredCopy && vendoredSkillNames.has(vendoredCopy[1])) {
    return { pathRefs: false, dateStamps: false, illegalInvocations: false, skillMeta: true };
  }
  const claudeProseSurface = rel === 'CLAUDE.md' || /^\.claude\/(rules|agents)\/.*\.md$/.test(rel);
  const skillBody = /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(rel);
  const skillSurface = skillBody
    || /^\.agents\/skills\/[^/]+\/references\/[^/]+\.md$/.test(rel);
  const codexSurface = rel === 'AGENTS.md' || rel === '.agents/REPOSITORY.md' || /^\.codex\/agents\/[^/]+\.toml$/.test(rel);
  const dateStamps = claudeProseSurface || skillSurface || codexSurface;
  return {
    pathRefs: dateStamps || rel === 'README.md' || (rel.startsWith('docs/') && rel.endsWith('.md')),
    dateStamps,
    illegalInvocations: skillBody,
    skillMeta: skillBody || /^\.agents\/upstream\/[^/]+\/[^/]+\/SKILL\.md$/.test(rel),
  };
}

// [{path, text}] → Map<name, {disabled}> parsed from each file's YAML-ish
// frontmatter (between the leading `---` fences). A file with no frontmatter,
// or no `name:`, is skipped (nothing to key it by).
export function parseSkillMeta(files) {
  const meta = new Map();
  for (const file of files) {
    const fm = frontmatter(file.text);
    if (!fm) continue;
    const nameMatch = fm.match(/^name:\s*(\S+)/m);
    if (!nameMatch) continue;
    const disabled = /^disable-model-invocation:\s*true\s*$/m.test(fm);
    meta.set(nameMatch[1], { disabled });
  }
  return meta;
}

// The leading `---\n...\n---` frontmatter block, or null if the file doesn't
// open with one.
function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

// Text with its leading frontmatter block stripped (the body a skill actually
// runs on — never scan a skill's own frontmatter for invocations) plus the
// number of real-file lines that prefix ate, so a caller can translate a body
// line number back to the file's own.
function stripFrontmatter(text) {
  const match = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) return { body: text, lineOffset: 0 };
  return { body: text.slice(match[0].length), lineOffset: match[0].split('\n').length - 1 };
}

// A line reads as deferring to a human, or negating the action, rather than
// instructing the model to act on its own. Tightened (CodeRabbit finding on
// PR #405): bare `owner`/`user`/`human` swallowed genuine imperatives that
// merely mentioned one of those words in passing (e.g. "to update user
// documentation" is not a deferral) — every marker below is an explicit
// deferral/negation CONSTRUCTION, never a bare noun.
const DEFERRAL_MARKERS = [
  'the owner', 'the user', 'a human', 'owner-invoked', 'user-invoked',
  'invoked by', 'by hand', 'suggest', 'propose', 'ask ', 'never',
  "don't", 'do not', 'reached by', 'not "run', "not 'run",
];

function isDeferral(line) {
  const lower = line.toLowerCase();
  return DEFERRAL_MARKERS.some((m) => lower.includes(m));
}

// The goal is catching a "run `/x`" IMPERATIVE, not every mention — most
// cross-references to a disabled skill are descriptive ("`/resume`'s Step 2
// triage is the closest thing", "the `/resume` + board machinery") and would
// false-positive under a bare default-illegal-unless-deferred rule. A line is
// only a CANDIDATE when it carries an actual invocation verb next to the ref.
const IMPERATIVE_RE = /\b(run|invoke|fire|launch|trigger)\b/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Blank the CONTENT of fenced code blocks (``` or ~~~, variable-length
// markers) before the ILLEGAL-INVOCATION scan, so an EXAMPLE inside a fence
// (documenting what NOT to write) never false-flags. A fence closes only on
// a marker of the SAME character at least as long as the one that opened it
// (CommonMark's rule) — a 4-backtick fence isn't closed by 3 backticks.
// Every fence/interior line is replaced with an empty line (never removed),
// so line numbers seen by the caller stay accurate. Deliberately NOT used by
// the path-ref scan — a fenced command (`node scripts/...`) is load-bearing
// prose and its rot is exactly what that scan exists to catch.
export function blankFencedBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null; // { char: '`'|'~', len: N }
  for (const line of lines) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      // A CLOSING fence is marker-only (CommonMark): a content line that merely
      // starts with backticks (e.g. "```js example") does not close the block.
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      const marker = close && close[1];
      if (marker && marker[0] === fence.char && marker.length >= fence.len) fence = null;
      out.push('');
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// [{path, text}], Set/array<disabled skill name> → violations. Scans each
// skill's BODY (frontmatter stripped) for a `/name` reference to a disabled
// skill other than the file's own name. `(?<![\w/.-])` keeps a path-embedded
// slash (e.g. `.agents/skills/resume/SKILL.md`) from matching — the character
// immediately before a real invocation slash is whitespace/backtick/start-of-
// line, never another path segment.
export function findIllegalInvocations(skillFiles, disabledNames) {
  const disabled = new Set(disabledNames);
  const violations = [];
  for (const file of skillFiles) {
    const fm = frontmatter(file.text);
    const selfNameMatch = fm && fm.match(/^name:\s*(\S+)/m);
    const selfName = selfNameMatch ? selfNameMatch[1] : null;
    const { body, lineOffset } = stripFrontmatter(file.text);
    const lines = blankFencedBlocks(body).split('\n');
    for (const name of disabled) {
      if (name === selfName) continue;
      const re = new RegExp(`(?<![\\w/.-])/${escapeRegExp(name)}\\b`);
      lines.forEach((line, idx) => {
        if (!re.test(line)) return;
        if (!IMPERATIVE_RE.test(line)) return;
        if (isDeferral(line)) return;
        violations.push({
          path: file.path,
          line: lineOffset + idx + 1,
          message: `imperative reference to disabled skill /${name}`,
        });
      });
    }
  }
  return violations;
}

// Date-stamps read as vigilance debt: strip date-stamps, keep boundary
// rationale. Advisory only, never blocks.
export function findDateStamps(text) {
  const matches = [];
  const lines = text.split('\n');
  const re = /\b20\d{2}-\d{2}-\d{2}\b/g;
  lines.forEach((line, idx) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      matches.push({ match: m[0], line: idx + 1 });
    }
  });
  return matches;
}
