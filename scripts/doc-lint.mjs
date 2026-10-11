#!/usr/bin/env node
// doc-lint.mjs — deterministic prose-vigilance gate for the repo's docs + skill prose.
//
// Converts by-hand vigilance habits into a deterministic check: a dangling
// backtick-quoted repo path (a doc citing a file that moved or was deleted,
// CLAUDE.md's directory map going stale), a dead relative Markdown link (the
// same rot with no backticks to catch it), a phantom AGENTS.md or CLAUDE.md section
// citation (prose that reads authoritative and points nowhere), a skill instructing the model to fire a DISABLED
// (user-invoked-only) sibling skill (the user-invoked rule in writing-for-agents'
// SKILL-MECHANICS.md: only the human typing its name can invoke such a skill,
// and no other skill can), and a stray date-stamp in an
// always-loaded doc (doc-authoring-leanness: strip date-stamps, keep boundary
// rationale). Skill *registration* is deliberately not validated: provider skill
// copies are vendored files, re-copied when a newer version is wanted.
//
//   node scripts/doc-lint.mjs            # lints the WORKING TREE (fs content)
//   node scripts/doc-lint.mjs --staged   # lints the INDEX (`git show :<path>`
//                                        # content) — what the pre-commit hook runs as an
//                                        # ADVISORY, so a partially-staged edit is reported
//                                        # from the exact bytes about to be committed
//
// Both modes exit 1 on any prose-rot finding / illegal invocation, 0 + silent when
// clean; date-stamps are ADVISORY only. --staged derives both the scan and
// existence sets from `git ls-files` (the INDEX), so it validates the exact
// bytes the hook will commit. Normal mode scans only indexed paths still in
// the working tree, and resolves against those plus present nonignored files:
// this lets an unstaged new file resolve locally, while a deleted path is a
// dangling ref rather than an ENOENT crash. The staged hook remains the CI
// guard against untracked/leftover files (the PR #405 failure mode).
//
// Runtimes: a missing target is accepted only when it belongs to a runtime the seat settings file leaves out, and
// CLAUDE.md is neither read nor cited without Claude Code (scripts/lib/runtimes.mjs owns which path belongs to which).
// --staged reads the settings file from the working tree, which is sound because the hook's run of this lint is an
// advisory and the agent check judges the staged settings file.
//
// Fail-loud (self-improvement-loop rule): dangling refs, dead Markdown links,
// phantom citations, and illegal invocations are ERRORS
// (exit 1); date-stamps are printed with a ⚠ prefix and never affect
// the exit code. An unexpected internal error (a read failure, a malformed
// file) also exits non-zero — never swallowed as "clean".

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
} from './lib/doc-lint.mjs';
import { checkMarkdownLinks } from './lib/doc-lint-links.mjs';
import {
  extractManualHeadings,
  extractHeadingCitations,
  checkHeadingCitations,
} from './lib/doc-lint-citations.mjs';
import { installs, presentRuntimes } from './lib/runtimes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGED = process.argv.includes('--staged');

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd: ROOT,
    // Staged source is read through `git show`; keep that exact-index contract
    // usable for ordinary large first-party text files rather than inheriting
    // execFileSync's 1 MiB default buffer.
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Content to lint: the working tree in normal mode (so an uncommitted edit is
// linted before it's even staged), the INDEX in --staged mode (the exact
// bytes the hook is about to commit — correct under partial staging, same
// principle as the hook's concat-identity gate).
function readContent(rel) {
  return STAGED ? git(['show', `:${rel}`]) : fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function existsInWorkingTree(rel) {
  try {
    fs.lstatSync(path.join(ROOT, rel));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

const indexedFiles = git(['ls-files']).split('\n').filter(Boolean);
const workingTreeTrackedFiles = indexedFiles.filter(existsInWorkingTree);
const workingTreeFiles = [...new Set([
  ...workingTreeTrackedFiles,
  ...git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).filter(existsInWorkingTree),
])];
const scanFiles = STAGED ? indexedFiles : workingTreeTrackedFiles;
const trackedSet = buildTrackedSet(STAGED ? indexedFiles : workingTreeFiles);
const vendoredNames = vendoredSkillNames(indexedFiles);
const dateStampFiles = scanFiles.filter((rel) => classifyDocLintPath(rel, vendoredNames).dateStamps);
const pathRefScanFiles = scanFiles.filter((rel) => classifyDocLintPath(rel, vendoredNames).pathRefs);
const commandFiles = scanFiles.filter((rel) => classifyDocLintPath(rel, vendoredNames).illegalInvocations);
const skillMetaFiles = scanFiles.filter((rel) => classifyDocLintPath(rel, vendoredNames).skillMeta);

function main() {
  // The runtimes the settings file names; read first so a refused file is reported as a failed scan.
  const present = presentRuntimes(ROOT);
  // A missing target is accepted only when it belongs to a runtime the settings file leaves out.
  const exists = (p) => pathExists(trackedSet, p) || !installs(present, p);

  // Repo-wide only: a scan set that classified nothing across the full tree
  // means the gate would "pass" over no content at all — fail loud rather than
  // report a vacuous clean run. --staged legitimately scans only what is
  // staged, so a commit that stages no prose empties sets by design.
  if (!STAGED) {
    const emptySets = [
      ['path-ref', pathRefScanFiles],
      ['date-stamp', dateStampFiles],
      ['illegal-invocation', commandFiles],
    ].filter(([, files]) => files.length === 0).map(([name]) => name);
    if (emptySets.length > 0) {
      throw new Error(`empty scan set(s): ${emptySets.join(', ')} — no files classified`);
    }
  }

  const errors = [];
  const advisories = [];

  // Derived at most once per run, and only once a citation is actually found:
  // the pre-commit fixture repos arm this CLI in scratch trees that have no
  // CLAUDE.md/AGENTS.md, so an eager read would crash every clean run. When a
  // citation IS found AGENTS.md, and CLAUDE.md where Claude Code runs, must be readable — the throw is the fail-loud
  // path, never a silent "no headings" pass.
  let headingsByManual;
  const manualHeadings = () => {
    if (headingsByManual) return headingsByManual;
    const agentsHeadings = extractManualHeadings(readContent('AGENTS.md'));
    headingsByManual = { 'AGENTS.md': agentsHeadings };
    // CLAUDE.md is read only where Claude Code runs. It imports AGENTS.md (`@AGENTS.md`), so a CLAUDE.md citation may
    // name a heading of either.
    if (installs(present, 'CLAUDE.md')) {
      const claudeManual = readContent('CLAUDE.md');
      headingsByManual['CLAUDE.md'] = new Set([
        ...extractManualHeadings(claudeManual),
        ...(/^@AGENTS\.md\s*$/m.test(claudeManual) ? agentsHeadings : []),
      ]);
    }
    return headingsByManual;
  };

  // --- Dangling path refs, dead links, citations — the full scan set ---------
  for (const rel of pathRefScanFiles) {
    const text = readContent(rel);
    const refs = extractPathRefs(text);
    const dangling = checkPathRefs(refs, exists);
    for (const d of dangling) {
      errors.push(`${rel}:${d.line} — dangling path ref: \`${d.path}\` does not exist`);
    }

    for (const d of checkMarkdownLinks(rel, text, exists)) {
      const reason = d.resolved === null ? 'escapes the repo root' : 'does not exist';
      errors.push(`${rel}:${d.line} — dead Markdown link: \`${d.target}\` ${reason}`);
    }

    const citations = extractHeadingCitations(text).filter((c) => installs(present, c.manual));
    if (citations.length > 0) {
      for (const v of checkHeadingCitations(citations, manualHeadings())) {
        errors.push(`${rel}:${v.line} — phantom ${v.manual} citation: \`${v.heading}\` is not a heading`);
      }
    }

  }

  // --- Illegal invocations — skill bodies under .agents/skills/; the disabled set also reads
  // the vendored upstream skills' frontmatter, whose bodies are never linted ---
  const skillFiles = commandFiles.map((rel) => ({ path: rel, text: readContent(rel) }));
  const meta = parseSkillMeta(skillMetaFiles.map((rel) => ({ path: rel, text: readContent(rel) })));
  const disabledNames = [...meta.entries()].filter(([, v]) => v.disabled).map(([name]) => name);
  const illegal = findIllegalInvocations(skillFiles, disabledNames);
  for (const v of illegal) {
    errors.push(`${v.path}:${v.line} — ${v.message}`);
  }

  // --- Date-stamps — ADVISORY, always-loaded + Codex surfaces ------------------
  for (const rel of dateStampFiles) {
    const text = readContent(rel);
    for (const d of findDateStamps(text)) {
      advisories.push(`${rel}:${d.line} — date-stamp \`${d.match}\` (doc-authoring-leanness: strip date-stamps)`);
    }
  }

  for (const a of advisories) console.log(`⚠ ${a}`);
  for (const e of errors) console.error(e);

  if (errors.length > 0) {
    console.error(`doc-lint: ${errors.length} error(s).`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`doc-lint: failed to scan — ${err.message}`);
    process.exitCode = 1;
  }
}
