#!/usr/bin/env node
// sweep-scope-check.mjs — the required check that owns the documentation sweep's scope.
//
//   node scripts/sweep-scope-check.mjs <base-commit> <head-commit>
//
// Fails (exit 1) when the branch's own changes, merge-base to head, do anything but modify files in
// the may-edit column of the scope table in docs/DOC-SWEEP.md. Two halves then judge what it modifies.
// The context-free half reads the added lines alone: it refuses a URI, e-mail or host name the base
// tree does not already carry as a whole token, and the destination shapes that hide where they point
// wherever they sit, so text planted inert cannot wait for a later edit to wake it. The semantic half
// renders the whole before and after documents and compares them: a destination the head newly renders
// is reported when the tree already vouches for it and refused when nothing does, and a destination
// whose spelling no reader can resolve is refused whether it is new or not. An HTML page, which a
// browser loads raw, is held to its markup instead: only its free text may change. The table and the
// tree are read at the BASE commit (the tip of `main`, not the merge base) so a diff cannot widen its
// own scope and a host `main` gained since the branch point still counts as known. Runs from `main`'s
// own copy in .github/workflows/sweep-scope.yml, and by the sweep itself before it pushes; the rules
// it enforces are the ones in docs/DOC-SWEEP.md that no reader checks any more. Exit 2 is a usage
// error; a git failure exits with git's own message, never as a clean result.

import { evaluateSweepScope } from './lib/sweep-scope-evaluate.mjs';

const [base, head, ...extra] = process.argv.slice(2);
if (!base || !head || extra.length > 0) {
  console.error('usage: node scripts/sweep-scope-check.mjs <base-commit> <head-commit>');
  process.exit(2);
}

const result = evaluateSweepScope(base, head, process.cwd());
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status;
