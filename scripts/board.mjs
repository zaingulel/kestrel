#!/usr/bin/env node
// board.mjs — the one board command: it lists the board (the GitHub Projects board, the
// cards under .agents/cards where scripts/lib/board-config.mjs sets TRACKER = 'markdown', or a
// Linear team, Jira project or Azure project where it selects that tracker) and judges it from
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
// Fail-loud: a provider error or malformed data exits non-zero. On GitHub a zero-item
// read also exits non-zero — a broken board read never prints an empty "nothing to pick"
// and returns success. The exit code of every mode but --intake is scanOutcome's, so an
// ordinary read exits 1 on drift too: the session-start bookend exists to surface exactly
// that, and only --closeout spares the advisory rows (one merge's proof gate is not a
// sibling lane's business).
//
// --intake reads the board once, then the details of each pickable card and each claimed
// card with no closing pull request (body, parent, latest claim, every comment) through
// two read-only GraphQL queries, and writes nothing and reads no checkout (a markdown install
// reads its cards, origin/main and its job branches instead; Linear, Jira and Azure use native reads). Stdout is the
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
import { linearExec } from './lib/linear-api.mjs';
import { jiraExec } from './lib/jira-api.mjs';
import { azureExec } from './lib/azure-api.mjs';
import * as boardConfig from './lib/board-config.mjs';
import { jiraCardDetails, readJiraBoard } from './lib/board-jira.mjs';
import { azureCardDetails, readAzureBoard } from './lib/board-azure.mjs';
import { BOARD_OWNER, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY, PICKABLE_STATUSES } from './lib/board-config.mjs';
import { CARDS_DIR, configuredTracker, markdownCardDetails, readMarkdownBoard } from './lib/board-markdown.mjs';
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
import { linearCardDetails, linearTeamKey, readLinearBoard } from './lib/board-linear.mjs';
import { intakeCards, intakeOutcome, scanBoard, scanOutcome } from './lib/board-rules.mjs';

const boardName = (tracker) => {
  if (tracker === 'markdown') return `markdown ${CARDS_DIR}`;
  if (tracker === 'linear') return `linear team ${linearTeamKey()}`;
  if (tracker === 'jira') return `jira project ${boardConfig.JIRA_CONFIG.project} at ${boardConfig.JIRA_CONFIG.site}`;
  if (tracker === 'azure') return `azure project ${boardConfig.AZURE_CONFIG.project} at ${boardConfig.AZURE_CONFIG.organization}`;
  return `${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER}`;
};

const headerLine = (label, selected, items, tracker) =>
  `Board ${boardName(tracker)} — ${label}: ${selected.length} of ${items.length} item(s)`;

// The pick listing and the card details as one document on stdout; the scan and the
// details outcome on stderr, so a caller that captures stdout holds the document alone.
function printIntake(items, args, { executor, linear, jira, azure, output, tracker, markdown }) {
  const { candidates, claims, numberless } = intakeCards(items);
  const numbers = [...candidates, ...claims].map((card) => card.number);
  const details = {
    markdown: () => markdownCardDetails(markdown.cards, numbers, markdown.refs),
    linear: () => linearCardDetails(linear, numbers),
    jira: () => jiraCardDetails(jira, numbers),
    azure: () => azureCardDetails(azure, numbers),
    github: () => fetchCardDetails(executor, numbers),
  }[tracker]();
  const picks = pickable(items);
  const listing = `${headerLine(PICKABLE_STATUSES.join('/'), picks, items, tracker)}\n\n${formatGrouped(picks)}`;
  const document = intakeDocument({ listing, candidates, claims, numberless, details });
  const { lines, exitCode } = intakeOutcome({ ...scanBoard(items), details });
  output.log(document.join('\n'));
  const parkedNote = parkedLine(items, args);
  if (parkedNote) output.error(parkedNote);
  for (const line of lines) output.error(line);
  output.error(`board intake: ${document.length} line(s) on stdout.`);
  return exitCode;
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const executor = dependencies.ghExec ?? ghExec;
  const linear = dependencies.linearExec ?? linearExec;
  const jira = dependencies.jiraExec ?? jiraExec;
  const azure = dependencies.azureExec ?? azureExec;

  let parsed;
  try {
    parsed = parseBoardArgs(args);
  } catch (err) {
    // The same one-line idiom as the read failure below, so the operator reads the
    // message and not an unhandled-rejection stack trace above it.
    output.error(`board: ${err.message}`);
    return 1;
  }

  // 2 under --intake, which tells a failed read from a rejected argument (1); every other mode keeps 1.
  const readFailed = parsed.intake ? INTAKE_EXIT.readFailed : 1;
  let tracker;
  try {
    tracker = configuredTracker();
  } catch (err) {
    output.error(`board: ${err.message}`);
    return readFailed;
  }
  // A markdown install's cards and claims, read alongside its items; null on GitHub.
  let markdown = null;
  let items;
  try {
    if (tracker === 'markdown') {
      markdown = readMarkdownBoard(executor);
      ({ items } = markdown);
    } else if (tracker === 'linear') {
      ({ items } = readLinearBoard(linear));
    } else if (tracker === 'jira') {
      ({ items } = readJiraBoard(jira, executor));
    } else if (tracker === 'azure') {
      ({ items } = readAzureBoard(azure, executor));
    } else {
      items = fetchBoard(executor);
    }
  } catch (err) {
    const source = { markdown: 'markdown cards', linear: `Linear team ${linearTeamKey()}`, jira: 'Jira project', azure: 'Azure project', github: 'GitHub Projects board' }[tracker];
    output.error(`board: failed to read the ${source} — ${err.message}`);
    return readFailed;
  }
  // Empty markdown, Linear, Jira and Azure boards are valid; on GitHub zero items means a failed read.
  if (items.length === 0 && tracker === 'github') {
    output.error('board: gh returned 0 items — auth/network/project problem, not an empty backlog.');
    return readFailed;
  }

  if (parsed.intake) return printIntake(items, parsed, { executor, linear, jira, azure, output, tracker, markdown });

  // Under --json stdout is a document a caller parses, so the scan goes to stderr rather
  // than corrupting it; the verdict still reaches the operator and still sets the exit code.
  const report = (line) => (parsed.json ? output.error(line) : output.log(line));

  // --closeout certifies the board and nothing else, so it prints no listing at all.
  if (!parsed.closeout) {
    const selected = parsed.all
      ? items
      : parsed.status
        ? items.filter((i) => i.status === parsed.status)
        : pickable(items);
    const label = parsed.status || (parsed.all ? 'all columns' : PICKABLE_STATUSES.join('/'));
    if (parsed.json) {
      output.log(JSON.stringify(selected.map(normalizeItem), null, 2));
    } else {
      output.log(`${headerLine(label, selected, items, tracker)}\n`);
      output.log(formatGrouped(selected));
    }
    const parkedNote = parkedLine(items, parsed);
    if (parkedNote) report(parkedNote);
  }

  const { lines, exitCode } = scanOutcome({ ...scanBoard(items), closeout: parsed.closeout });
  for (const line of lines) report(line);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
