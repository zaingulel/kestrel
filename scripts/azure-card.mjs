#!/usr/bin/env node
// Azure card rows print only after complete native confirmation.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as boardConfig from './lib/board-config.mjs';
import { trackerOf } from './lib/tracker.mjs';
import { azureExec } from './lib/azure-api.mjs';
import { USAGE, parseCardArgs, runCardCommand } from './lib/azure-card.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  let command;
  try { command = parseCardArgs(args); }
  catch (error) { output.error(`azure-card: ${error.message}\n${USAGE}`); return 2; }
  try {
    if (trackerOf(boardConfig) !== 'azure') throw new Error('board-config.mjs must select the Azure tracker for azure-card');
    const rows = runCardCommand(command, dependencies.azureExec ?? azureExec);
    for (const row of rows) output.log(JSON.stringify(row));
    return 0;
  } catch (error) {
    output.error(`azure-card: ${error.message}`);
    return error.rateLimited ? 3 : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
