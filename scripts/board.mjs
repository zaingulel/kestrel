#!/usr/bin/env node
// board.mjs — the one board command: it lists the board and judges it from
// the SAME single read, so a session never pays twice for one answer and the listing
// can never disagree with the drift verdict printed under it.
//
//   node scripts/board.mjs                 # pickable candidates, then the scan
//   node scripts/board.mjs --all           # every column
//   node scripts/board.mjs --status=Ready  # one column
//   node scripts/board.mjs --json          # the normalized selection on stdout, scan on stderr
//   node scripts/board.mjs --closeout      # the strict proof gate: the scan alone
//   node scripts/board.mjs --intake        # the intake document on stdout, the outcome on stderr
//
// Fail-loud (self-improvement-loop rule): a gh error, malformed JSON, or a zero-item
// read exits non-zero — a broken board read never prints an empty "nothing to pick"
// and returns success. The exit code of every mode but --intake is scanOutcome's, so an
// ordinary read exits 1 on drift too: the session-start bookend exists to surface exactly
// that, and only --closeout spares the advisory rows (one merge's proof gate is not a
// sibling lane's business).
//
// --intake reads the board once, then the details of each pickable card and each claimed
// card with no closing pull request (body, parent, latest claim, every comment) through
// two read-only GraphQL queries, and writes nothing and reads no checkout. Stdout is the
// document alone and ends with a line counting itself; the scan, the details outcome and
// the line count go to stderr. Exit 0: whole and clean. 1: a rejected argument. 2: the
// board read failed or returned no items. 3: drift. 4: a card's details, or the board,
// were not fully read. 5: both 3 and 4. A card whose details were not read is marked
// UNAVAILABLE in the document, never shown empty.
//
// #461: reads the board via the lean GraphQL page query (scripts/lib/board.mjs), not
// `gh project item-list` (a measured 203 GraphQL points per read). #1155: the whole
// walk runs inside one `gh api graphql --paginate --slurp` process, and every rule in
// scripts/lib/board-rules.mjs is answered off those pages.
//
// A thin shell: every decision (what to select, what to print, what to exit with) lives
// in the pure parseBoardArgs/parkedLine/intakeDocument (scripts/lib/board.mjs) and
// scanBoard/scanOutcome/intakeCards/intakeOutcome (scripts/lib/board-rules.mjs), so this
// file holds no judgment of its own and the whole contract is unit-testable.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ghExec } from './lib/gh-exec.mjs';
import { BOARD_OWNER, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY, PICKABLE_STATUSES } from './lib/board-config.mjs';
import {
  INTAKE_EXIT,
  fetchBoard,
  fetchCardDetails,
  formatGrouped,
  intakeDocument,
  normalizeItem,
  parseBoardArgs,
  parkedLine,
  pickable,
} from './lib/board.mjs';
import { intakeCards, intakeOutcome, scanBoard, scanOutcome } from './lib/board-rules.mjs';

const headerLine = (label, selected, items) =>
  `Board ${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER} — ${label}: ${selected.length} of ${items.length} item(s)`;

// The pick listing and the card details as one document on stdout; the scan and the
// details outcome on stderr, so a caller that captures stdout holds the document alone.
function printIntake(items, args) {
  const { candidates, claims, numberless } = intakeCards(items);
  const details = fetchCardDetails(ghExec, [...candidates, ...claims].map((card) => card.number));
  const picks = pickable(items);
  const listing = `${headerLine(PICKABLE_STATUSES.join('/'), picks, items)}\n\n${formatGrouped(picks)}`;
  const document = intakeDocument({ listing, candidates, claims, numberless, details });
  const { lines, exitCode } = intakeOutcome({ ...scanBoard(items), details });
  console.log(document.join('\n'));
  const parkedNote = parkedLine(items, args);
  if (parkedNote) console.error(parkedNote);
  for (const line of lines) console.error(line);
  console.error(`board intake: ${document.length} line(s) on stdout.`);
  process.exitCode = exitCode;
}

function main() {
  let args;
  try {
    args = parseBoardArgs(process.argv.slice(2));
  } catch (err) {
    // The same one-line idiom as the read failure below, so the operator reads the
    // message and not an unhandled-rejection stack trace above it.
    console.error(`board: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // 2 under --intake, which tells a failed read from a rejected argument (1); every other mode keeps 1.
  const readFailed = args.intake ? INTAKE_EXIT.readFailed : 1;
  let items;
  try {
    items = fetchBoard(ghExec);
  } catch (err) {
    console.error(`board: failed to read the GitHub Projects board — ${err.message}`);
    process.exitCode = readFailed;
    return;
  }
  if (items.length === 0) {
    console.error('board: gh returned 0 items — auth/network/project problem, not an empty backlog.');
    process.exitCode = readFailed;
    return;
  }

  if (args.intake) {
    printIntake(items, args);
    return;
  }

  // Under --json stdout is a document a caller parses, so the scan goes to stderr rather
  // than corrupting it; the verdict still reaches the operator and still sets the exit code.
  const report = args.json ? console.error : console.log;

  // --closeout certifies the board and nothing else, so it prints no listing at all.
  if (!args.closeout) {
    const selected = args.all
      ? items
      : args.status
        ? items.filter((i) => i.status === args.status)
        : pickable(items);
    const label = args.status || (args.all ? 'all columns' : PICKABLE_STATUSES.join('/'));
    if (args.json) {
      console.log(JSON.stringify(selected.map(normalizeItem), null, 2));
    } else {
      console.log(`${headerLine(label, selected, items)}\n`);
      console.log(formatGrouped(selected));
    }
    const parkedNote = parkedLine(items, args);
    if (parkedNote) report(parkedNote);
  }

  const { lines, exitCode } = scanOutcome({ ...scanBoard(items), closeout: args.closeout });
  for (const line of lines) report(line);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
