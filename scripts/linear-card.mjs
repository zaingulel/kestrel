#!/usr/bin/env node
// linear-card.mjs — the card command of a Linear board (TRACKER = 'linear' in board-config.mjs): the card and
// board reads, the card text, filing, and the claim's assignee and comment writes (lib/linear-card.mjs).
//
//   node scripts/linear-card.mjs view ENG-12 [--board]
//   node scripts/linear-card.mjs create --title "Fix it" --body-file body.md --status Ready --kind task --blocked-by ENG-3
//
// Every stdout line is one JSON array, printed only once the command has read and written everything it needs.
// Exit 0 for done or a no-op (which prints ["no-op"]), 1 for a refusal or failure with its cause on stderr, and 2 for
// a usage error before any request.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { configuredTracker } from './lib/board-markdown.mjs';
import { linearExec } from './lib/linear-api.mjs';
import { USAGE, parseCardArgs, runCardCommand } from './lib/linear-card.mjs';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const exec = dependencies.linearExec ?? linearExec;
  let command;
  try {
    command = parseCardArgs(args);
  } catch (err) {
    output.error(`linear-card: ${err.message}\n${USAGE}`);
    return 2;
  }
  try {
    const tracker = configuredTracker();
    if (tracker !== 'linear') throw new Error(`board-config.mjs sets the ${tracker} tracker, and this command serves a Linear board`);
    const rows = runCardCommand(command, exec);
    for (const row of rows) output.log(JSON.stringify(row));
    return 0;
  } catch (err) {
    output.error(`linear-card: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
