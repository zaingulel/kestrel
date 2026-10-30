#!/usr/bin/env node
// verify-issue-publish.mjs — fail-loud publication check for an issue, optionally with expected children.
// One argument does not assert the issue HAS no children: the verifier queries the real
// native child count and reports it, so a forgotten child list stays visible.
// On a markdown-tracked board (TRACKER = 'markdown' in board-config.mjs) the cards are read from their files,
// and on Linear, Jira or Azure boards from native cards named by their identifiers.
// Run: node scripts/verify-issue-publish.mjs <issue#> [child#...]

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fetchBoard } from './lib/board.mjs';
import { ghExec } from './lib/gh-exec.mjs';
import { configuredTracker, readCards } from './lib/board-markdown.mjs';
import { verifyAzurePublication, verifyIssuePublication, verifyJiraPublication, verifyLinearPublication, verifyMarkdownPublication } from './lib/issue-publish.mjs';
import { linearExec } from './lib/linear-api.mjs';
import { jiraExec } from './lib/jira-api.mjs';
import { azureExec } from './lib/azure-api.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const boardReader = dependencies.fetchBoard ?? fetchBoard;
  const executor = dependencies.ghExec ?? ghExec;
  const linearExecutor = dependencies.linearExec ?? linearExec;
  const jiraExecutor = dependencies.jiraExec ?? jiraExec;
  const azureExecutor = dependencies.azureExec ?? azureExec;

  try {
    const tracker = configuredTracker();
    const lines = tracker === 'markdown'
      ? verifyMarkdownPublication(args, readCards())
      : tracker === 'linear'
        ? verifyLinearPublication(args, linearExecutor)
        : tracker === 'jira'
          ? verifyJiraPublication(args, jiraExecutor)
          : tracker === 'azure'
            ? verifyAzurePublication(args, azureExecutor)
            : verifyIssuePublication(args, { fetchBoard: boardReader, ghExec: executor });
    for (const line of lines) output.log(line);
    return 0;
  } catch (err) {
    output.error(`issue-publish: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
