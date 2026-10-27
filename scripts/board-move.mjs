#!/usr/bin/env node
// board-move.mjs — move a GitHub Projects card (or a batch of cards) to a Status column,
// or park cards in (and release them from) the parked lane board-config.mjs names. Where
// board-config.mjs sets TRACKER = 'markdown', the card is a file: Backlog, Ready and Done rewrite
// its Status line and the other columns are checks (lib/board-markdown.mjs). Where it sets
// TRACKER = 'linear', the card moves to the Linear state its column maps to (lib/board-linear.mjs).
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
import { moveLinearCards } from './lib/board-linear.mjs';
import { configuredTracker, gitRunner, moveMarkdownCards } from './lib/board-markdown.mjs';
import { ghExec } from './lib/gh-exec.mjs';
import { linearExec } from './lib/linear-api.mjs';
import { LINEAR_IDENTIFIER, cardRef } from './lib/tracker.mjs';

function usageError(output) {
  output.error(
    'usage: node scripts/board-move.mjs <issue#> <Status>   e.g. board-move.mjs 272 Done\n' +
    '       node scripts/board-move.mjs --batch <issue#>:<Status> [...]   e.g. board-move.mjs --batch 453:Done 454:"In review"\n' +
    '       node scripts/board-move.mjs --lane <issue#>:<option|none> [...]   e.g. board-move.mjs --lane 12:none\n' +
    '       on a Linear board <issue#> is the issue ID   e.g. board-move.mjs ENG-12 Ready',
  );
  return 2;
}

// The written / already-there report for one completed pair. A lane line names the
// field, since the option alone does not say which field moved.
function reportLine({ issueNumber, statusName, skipped, cleared, checked, movedBy }, laneField) {
  if (checked) return `board-move: ${cardRef(issueNumber)} at ${statusName} — ${movedBy ? `moved by ${movedBy}` : `branch job/${issueNumber}`}`;
  if (!laneField) {
    return skipped ? `board-move: ${cardRef(issueNumber)} already at ${statusName} — no-op` : `board-move: ${cardRef(issueNumber)} → ${statusName}`;
  }
  if (cleared) {
    return skipped ? `board-move: ${cardRef(issueNumber)} ${laneField} already clear — no-op` : `board-move: ${cardRef(issueNumber)} → ${laneField} cleared`;
  }
  return skipped
    ? `board-move: ${cardRef(issueNumber)} already at ${laneField}: ${statusName} — no-op`
    : `board-move: ${cardRef(issueNumber)} → ${laneField}: ${statusName}`;
}

// Moves on the configured tracker. The markdown and Linear trackers have no lane, so a lane given by hand is
// refused (on markdown with PARKED_LANE = null, moveLanes refuses first).
function moveAll(pairs, lane, executor, tracker, linearExecutor) {
  const markdown = tracker === 'markdown';
  if (lane) {
    if (tracker === 'linear') throw new Error('the linear tracker has no parked lane');
    if (markdown && PARKED_LANE) throw new Error('the markdown tracker has no parked lane');
    return moveLanes(pairs, executor);
  }
  if (tracker === 'linear') return moveLinearCards(pairs, linearExecutor);
  return markdown ? moveMarkdownCards(pairs, gitRunner(), executor) : moveCards(pairs, executor);
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const executor = dependencies.ghExec ?? ghExec;
  const linearExecutor = dependencies.linearExec ?? linearExec;
  const lane = args[0] === '--lane';
  let tracker;
  try {
    tracker = configuredTracker();
  } catch (err) {
    output.error(`board-move: ${err.message}`);
    return 1;
  }
  let pairs;
  if (args[0] === '--batch' || lane) {
    if (args.length < 2) return usageError(output);
    try {
      pairs = parseBatchArgs(args.slice(1), lane ? PARKED_LANE?.field ?? 'Lane' : 'Status', tracker);
    } catch (err) {
      output.error(`board-move: ${err.message}`);
      return 1;
    }
  } else {
    const [issueRaw, ...statusParts] = args;
    const linear = tracker === 'linear';
    const issueNumber = linear ? issueRaw : Number(issueRaw);
    const statusName = statusParts.join(' ').trim();
    const validIssue = linear ? LINEAR_IDENTIFIER.test(issueRaw) : Number.isInteger(issueNumber) && issueNumber > 0;
    if (!validIssue || !statusName) return usageError(output);
    pairs = [{ issueNumber, statusName }];
  }
  let completed;
  try {
    completed = moveAll(pairs, lane, executor, tracker, linearExecutor);
  } catch (err) {
    output.error(`board-move: ${err.message}`);
    return 1;
  }
  for (const pair of completed) output.log(reportLine(pair, lane && PARKED_LANE.field));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
