#!/usr/bin/env node
// board-add.mjs — put an issue on the board with its Status AND routing field set in one step.
// Run: node scripts/board-add.mjs <issue#> <Status> <ROUTING_FIELD value>
//      node scripts/board-add.mjs --help
// A board configured with no routing field takes <issue#> <Status> only. A markdown-tracked board
// (TRACKER = 'markdown' in board-config.mjs), Linear, Jira or Azure board files no card this
// way and refuses.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ghExec } from './lib/gh-exec.mjs';
import { addIssueToBoard } from './lib/board-add.mjs';
import { ROUTING_FIELD } from './lib/board-config.mjs';
import { CARDS_DIR, configuredTracker } from './lib/board-markdown.mjs';

const FORM = ROUTING_FIELD ? `<issue#> <Status> <${ROUTING_FIELD}>` : '<issue#> <Status>';

export const BOARD_ADD_USAGE =
  `usage: node scripts/board-add.mjs ${FORM}\n` +
  '       node scripts/board-add.mjs --help   prints the modes, with no board read';

// What `--help` prints: the usage, then each argument form.
export const BOARD_ADD_HELP = [
  BOARD_ADD_USAGE,
  '',
  `  ${FORM}   put the issue on the board with its Status${ROUTING_FIELD ? ` and ${ROUTING_FIELD}` : ''} set`,
  `  ${'--help'.padEnd(FORM.length)}   this text, with no board read`,
  '',
  'It files cards on a GitHub board only; the markdown, Linear, Jira and Azure trackers refuse it.',
].join('\n');

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const executor = dependencies.ghExec ?? ghExec;

  // --help reads no board and prints a fixed text, so any companion argument would promise more.
  if (args.includes('--help')) {
    if (args.length > 1) {
      output.error(`board-add: ${BOARD_ADD_USAGE}`);
      return 1;
    }
    output.log(BOARD_ADD_HELP);
    return 0;
  }

  try {
    // A markdown card is a file, so no argument shape files one.
    if (configuredTracker() === 'markdown') {
      throw new Error(`the markdown tracker files a card by writing ${CARDS_DIR}/<N>.md; see docs/MARKDOWN-CARDS.md`);
    }
    if (configuredTracker() === 'linear') {
      throw new Error('the linear tracker files a card with node scripts/linear-card.mjs create; see docs/LINEAR-CARDS.md');
    }
    if (configuredTracker() === 'jira') {
      throw new Error('the Jira tracker files a card with node scripts/jira-card.mjs create');
    }
    if (configuredTracker() === 'azure') {
      throw new Error('the Azure tracker files a card with node scripts/azure-card.mjs create');
    }
    if (args.length !== (ROUTING_FIELD ? 3 : 2)) throw new Error(BOARD_ADD_USAGE);
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
