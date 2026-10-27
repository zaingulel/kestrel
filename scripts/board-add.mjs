#!/usr/bin/env node
// board-add.mjs — put an issue on the board with its Status AND routing field set in one step.
// Run: node scripts/board-add.mjs <issue#> <Status> <ROUTING_FIELD value>
// A board configured with no routing field takes <issue#> <Status> only. A markdown-tracked board
// (TRACKER = 'markdown' in board-config.mjs) or Linear-tracked board (TRACKER = 'linear') files no card this
// way and refuses.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ghExec } from './lib/gh-exec.mjs';
import { addIssueToBoard } from './lib/board-add.mjs';
import { ROUTING_FIELD } from './lib/board-config.mjs';
import { CARDS_DIR, configuredTracker } from './lib/board-markdown.mjs';

const USAGE = ROUTING_FIELD
  ? `usage: node scripts/board-add.mjs <issue#> <Status> <${ROUTING_FIELD}>`
  : 'usage: node scripts/board-add.mjs <issue#> <Status>';

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const executor = dependencies.ghExec ?? ghExec;

  try {
    // A markdown card is a file, so no argument shape files one.
    if (configuredTracker() === 'markdown') {
      throw new Error(`the markdown tracker files a card by writing ${CARDS_DIR}/<N>.md; see docs/MARKDOWN-CARDS.md`);
    }
    if (configuredTracker() === 'linear') {
      throw new Error('the linear tracker files a card with node scripts/linear-card.mjs create; see docs/LINEAR-CARDS.md');
    }
    if (args.length !== (ROUTING_FIELD ? 3 : 2)) throw new Error(USAGE);
    const [numRaw, statusName, workstreamName] = args;
    const result = addIssueToBoard(
      { issueNumber: Number(numRaw), statusName, workstreamName },
      executor,
    );
    output.log(`board-add: #${result.issueNumber} on the board (item ${result.itemId})`);
    output.log(ROUTING_FIELD
      ? `board-add: Status = ${result.statusName}, ${ROUTING_FIELD} = ${result.workstreamName}`
      : `board-add: Status = ${result.statusName}`);
    return 0;
  } catch (err) {
    output.error(`board-add: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
