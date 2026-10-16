import {
  extractPathRefs,
  checkPathRefs,
  parseSkillMeta,
  findIllegalInvocations,
  findDateStamps,
  buildTrackedSet,
  pathExists,
  classifyDocLintPath,
  vendoredSkillNames,
} from './doc-lint.mjs';
import { checkMarkdownLinks } from './doc-lint-links.mjs';
import {
  extractManualHeadings,
  extractHeadingCitations,
  checkHeadingCitations,
} from './doc-lint-citations.mjs';
import { leftOutCause, needNotResolveCause } from './runtimes.mjs';

export function docLintVerdict({ files, read, settings, resolutionFiles = files, vendoredFiles = files, allowEmpty = false }) {
  const trackedSet = buildTrackedSet(resolutionFiles);
  const vendoredNames = vendoredSkillNames(vendoredFiles);
  const dateStampFiles = files.filter((rel) => classifyDocLintPath(rel, vendoredNames).dateStamps);
  const pathRefScanFiles = files.filter((rel) => classifyDocLintPath(rel, vendoredNames).pathRefs);
  const commandFiles = files.filter((rel) => classifyDocLintPath(rel, vendoredNames).illegalInvocations);
  const skillMetaFiles = files.filter((rel) => classifyDocLintPath(rel, vendoredNames).skillMeta);

  // A missing target is accepted only when it belongs to a runtime the settings file leaves out,
  // or to the sweep when it leaves the sweep out.
  const exists = (p) => pathExists(trackedSet, p) || needNotResolveCause(settings, p) !== null;

  // Refuse a repo-wide scan that would pass over no content.
  if (!allowEmpty) {
    const emptySets = [
      ['path-ref', pathRefScanFiles],
      ['date-stamp', dateStampFiles],
      ['illegal-invocation', commandFiles],
    ].filter(([, scanSet]) => scanSet.length === 0).map(([name]) => name);
    if (emptySets.length > 0) {
      throw new Error(`empty scan set(s): ${emptySets.join(', ')} — no files classified`);
    }
  }

  const errors = [];
  const advisories = [];

  // Read manuals only when cited; a missing cited manual must throw.
  let headingsByManual;
  const manualHeadings = () => {
    if (headingsByManual) return headingsByManual;
    const agentsHeadings = extractManualHeadings(read('AGENTS.md'));
    headingsByManual = { 'AGENTS.md': agentsHeadings };
    // CLAUDE.md is read only where Claude Code runs. It imports AGENTS.md (`@AGENTS.md`), so a CLAUDE.md citation may
    // name a heading of either.
    if (leftOutCause(settings, 'CLAUDE.md') === null) {
      const claudeManual = read('CLAUDE.md');
      headingsByManual['CLAUDE.md'] = new Set([
        ...extractManualHeadings(claudeManual),
        ...(/^@AGENTS\.md\s*$/m.test(claudeManual) ? agentsHeadings : []),
      ]);
    }
    return headingsByManual;
  };

  // --- Dangling path refs, dead links, citations — the full scan set ---------
  for (const rel of pathRefScanFiles) {
    const text = read(rel);
    const refs = extractPathRefs(text, rel);
    const dangling = checkPathRefs(refs, exists);
    for (const d of dangling) {
      errors.push(`${rel}:${d.line} — dangling path ref: \`${d.path}\` does not exist`);
    }

    for (const d of checkMarkdownLinks(rel, text, exists)) {
      const reason = d.resolved === null ? 'escapes the repo root' : 'does not exist';
      errors.push(`${rel}:${d.line} — dead Markdown link: \`${d.target}\` ${reason}`);
    }

    const citations = extractHeadingCitations(text).filter((c) => needNotResolveCause(settings, c.manual) === null);
    if (citations.length > 0) {
      for (const v of checkHeadingCitations(citations, manualHeadings())) {
        errors.push(`${rel}:${v.line} — phantom ${v.manual} citation: \`${v.heading}\` is not a heading`);
      }
    }

  }

  // --- Illegal invocations — skill bodies under .agents/skills/; the disabled set also reads
  // the vendored upstream skills' frontmatter, whose bodies are never linted ---
  const skillFiles = commandFiles.map((rel) => ({ path: rel, text: read(rel) }));
  const meta = parseSkillMeta(skillMetaFiles.map((rel) => ({ path: rel, text: read(rel) })));
  const disabledNames = [...meta.entries()].filter(([, v]) => v.disabled).map(([name]) => name);
  const illegal = findIllegalInvocations(skillFiles, disabledNames);
  for (const v of illegal) {
    errors.push(`${v.path}:${v.line} — ${v.message}`);
  }

  // --- Date-stamps — ADVISORY, always-loaded + Codex surfaces ------------------
  for (const rel of dateStampFiles) {
    const text = read(rel);
    for (const d of findDateStamps(text)) {
      advisories.push(`${rel}:${d.line} — date-stamp \`${d.match}\` (doc-authoring-leanness: strip date-stamps)`);
    }
  }

  return { errors, advisories };
}
