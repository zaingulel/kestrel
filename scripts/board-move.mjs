#!/usr/bin/env node
// board-move.mjs — move a GitHub Projects card (or a batch of cards) to a Status column,
// or park cards in (and release them from) the parked lane board-config.mjs names.
//
//   node scripts/board-move.mjs <issue#> <Status>
//   node scripts/board-move.mjs 272 Done
//   node scripts/board-move.mjs 274 "In review"
//   node scripts/board-move.mjs --batch 453:Done 454:"In review"
//   node scripts/board-move.mjs --lane 12:"To Sebastiano" 13:none
//
// Closing an issue does NOT move its board card (the Project Status field is a
// separate operation), so #272 sat closed in Backlog after a /handoff closed it
// and stopped there. This codifies the move so the ritual can `gh issue close`
// AND move the card in one step, instead of a hand-rolled item-edit with
// manually-fetched node-ids. Fail-loud (self-improvement-loop rule): an unknown
// issue/status or any gh error exits non-zero — never a silent no-op; `ghExec`
// (scripts/lib/gh-exec.mjs) upgrades a quota-exhaustion failure to name the true
// cause + reset time instead of `gh`'s misleading rate-limit message.
//
// #461: the original 3-read resolve (project view + field-list + item-list --limit
// 200) cost a measured 308 GraphQL points PER move — a 20-move handoff exceeded the
// whole 5,000/hr budget. `moveCards` now issues two lean GraphQL queries (1 point
// each, measured) and resolves the shared Status-field id ONCE per invocation, so a
// batch move costs ~3 points per card instead of 308.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { moveCards, moveLanes, parseBatchArgs } from './lib/board-move.mjs';
import { PARKED_LANE } from './lib/board-config.mjs';
import { ghExec } from './lib/gh-exec.mjs';

// Move a single card. Thin wrapper over `moveCards` — exported because CLAUDE.md
// references it as the in-process entry point for a future ritual script.
export function moveCard(issueNumber, statusName) {
  moveCards([{ issueNumber, statusName }], ghExec);
}

function usageError() {
  console.error(
    'usage: node scripts/board-move.mjs <issue#> <Status>   e.g. board-move.mjs 272 Done\n' +
    '       node scripts/board-move.mjs --batch <issue#>:<Status> [...]   e.g. board-move.mjs --batch 453:Done 454:"In review"\n' +
    '       node scripts/board-move.mjs --lane <issue#>:<option|none> [...]   e.g. board-move.mjs --lane 12:none',
  );
  process.exit(2);
}

// The written / already-there report for one completed pair. A lane line names the
// field, since the option alone does not say which field moved.
function reportLine({ issueNumber, statusName, skipped, cleared }, laneField) {
  if (!laneField) {
    return skipped ? `board-move: #${issueNumber} already at ${statusName} — no-op` : `board-move: #${issueNumber} → ${statusName}`;
  }
  if (cleared) {
    return skipped ? `board-move: #${issueNumber} ${laneField} already clear — no-op` : `board-move: #${issueNumber} → ${laneField} cleared`;
  }
  return skipped
    ? `board-move: #${issueNumber} already at ${laneField}: ${statusName} — no-op`
    : `board-move: #${issueNumber} → ${laneField}: ${statusName}`;
}

function main() {
  const argv = process.argv.slice(2);
  const lane = argv[0] === '--lane';
  let pairs;
  if (argv[0] === '--batch' || lane) {
    if (argv.length < 2) return usageError();
    try {
      pairs = parseBatchArgs(argv.slice(1), lane ? PARKED_LANE?.field ?? 'Lane' : 'Status');
    } catch (err) {
      console.error(`board-move: ${err.message}`);
      process.exit(1);
      return;
    }
  } else {
    const [numRaw, ...statusParts] = argv;
    const issueNumber = Number(numRaw);
    const statusName = statusParts.join(' ').trim();
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !statusName) return usageError();
    pairs = [{ issueNumber, statusName }];
  }
  let completed;
  try {
    completed = lane ? moveLanes(pairs, ghExec) : moveCards(pairs, ghExec);
  } catch (err) {
    console.error(`board-move: ${err.message}`);
    process.exit(1);
    return;
  }
  for (const pair of completed) console.log(reportLine(pair, lane && PARKED_LANE.field));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
