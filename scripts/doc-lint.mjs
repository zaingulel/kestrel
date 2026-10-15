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
// Runtime and sweep resolution: a missing target is accepted when it belongs to an omitted runtime or sweep.
// CLAUDE.md is neither read nor cited without Claude Code; scripts/lib/runtimes.mjs owns these resolution rules.
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
import { docLintVerdict } from './lib/doc-lint-verdict.mjs';
import { treeSettings } from './lib/runtimes.mjs';

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

function main() {
  // Settings come from the working tree in both modes, before scanning.
  const settings = treeSettings(ROOT);
  const indexedFiles = git(['ls-files']).split('\n').filter(Boolean);
  const workingTreeTrackedFiles = indexedFiles.filter(existsInWorkingTree);
  const workingTreeFiles = [...new Set([
    ...workingTreeTrackedFiles,
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).filter(existsInWorkingTree),
  ])];
  const { errors, advisories } = docLintVerdict({
    files: STAGED ? indexedFiles : workingTreeTrackedFiles,
    read: readContent,
    settings,
    resolutionFiles: STAGED ? indexedFiles : workingTreeFiles,
    vendoredFiles: indexedFiles,
    allowEmpty: STAGED,
  });

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
