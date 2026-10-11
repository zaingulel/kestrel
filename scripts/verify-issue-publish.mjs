#!/usr/bin/env node
// verify-issue-publish.mjs — fail-loud publication check for an issue, optionally with expected children.
// One argument does not assert the issue HAS no children: the verifier queries the real
// native child count and reports it, so a forgotten child list stays visible.
// Run: node scripts/verify-issue-publish.mjs <issue#> [child#...]

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fetchBoard } from './lib/board.mjs';
import { ghExec } from './lib/gh-exec.mjs';
import { verifyIssuePublication } from './lib/issue-publish.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const boardReader = dependencies.fetchBoard ?? fetchBoard;
  const executor = dependencies.ghExec ?? ghExec;

  try {
    for (const line of verifyIssuePublication(args, { fetchBoard: boardReader, ghExec: executor })) {
      output.log(line);
    }
    return 0;
  } catch (err) {
    output.error(`issue-publish: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
