#!/usr/bin/env node
// Jira card rows print only after the complete operation; errors never leave success rows on stdout.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as boardConfig from './lib/board-config.mjs';
import { trackerOf } from './lib/tracker.mjs';
import { jiraExec } from './lib/jira-api.mjs';
import { USAGE, parseCardArgs, runCardCommand } from './lib/jira-card.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  let command;
  try { command = parseCardArgs(args); }
  catch (error) { output.error(`jira-card: ${error.message}\n${USAGE}`); return 2; }
  try {
    if (trackerOf(boardConfig) !== 'jira') throw new Error('board-config.mjs must select the Jira tracker for jira-card');
    const rows = runCardCommand(command, dependencies.jiraExec ?? jiraExec);
    for (const row of rows) output.log(JSON.stringify(row));
    return 0;
  } catch (error) {
    output.error(`jira-card: ${error.message}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
