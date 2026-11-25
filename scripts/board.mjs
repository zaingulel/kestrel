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
//   node scripts/board.mjs --intake <folder>   # the intake summary on stdout, each card's text in <folder>, the outcome on stderr
//   node scripts/board.mjs --waits <card>  # what holds the card's merge for the owner, from its saved write-up at HEAD and its marker on the board
//   node scripts/board.mjs --waits <card> --herdr  # the same for a Herdr job, where only check, screenshot and the marker hold
//   node scripts/board.mjs --help          # these modes on stdout, exit 0, no board read
//
// Fail-loud: a provider error or malformed data exits non-zero. On GitHub a zero-item
// read also exits non-zero — a broken board read never prints an empty "nothing to pick"
// and returns success. A board read request GitHub answers with a 502, 503 or 504 is retried; one that still fails
// prints the plain cause, then the failed command on a `board: details:` line. Board-scan modes use scanOutcome's exit code, except --intake, so an
// ordinary read exits 1 on drift too: the session-start bookend exists to surface exactly
// that, and only --closeout spares the advisory rows (one merge's proof gate is not a
// sibling lane's business).
//
// --intake reads the board once, then the details of each pickable card and each claimed
// card with no closing pull request (body, parent, latest claim, every comment). On GitHub
// every read is a read-only GraphQL query, and those that do not need one another's reply
// are started together: first the item listing with the open issue walk, as every
// board read here opens, then one query per batch of 20 cards' details. The reads that
// need a reply follow one at a time: a card the listing left out, a batch too large to
// read in one, a card's older comments (a markdown install reads its cards, origin/main and
// its job branches instead; Linear, Jira and Azure use native reads). It creates <folder> and writes each read card's full text to
// <folder>/<id>.txt, and writes nothing else. Stdout is the summary alone, one section per
// card naming its file, and ends with a line counting itself. The scan, the details outcome and the line count go to stderr.
// Exit 0: whole and clean. 1: a rejected argument, or a folder that cannot be created. 2: the
// board read failed or returned no items. 3: drift. 4: a card's details, or the board,
// were not fully read, or a card's text could not be written. 5: both 3 and 4. A card whose
// details were not read is marked UNAVAILABLE in the summary, never shown empty.
//
// --waits takes a card number or identifier, reads fetched main's waitForOwner level and the card's saved write-up at
// HEAD with readWaitLevel and heldReasons (scripts/lib/merge-evidence.mjs), then reads the board for whether the card
// carries the show-me-first marker (markerOf): the judgement the guard makes at a ready or merge, though it does not
// look at the pull request's attached screenshots. Stdout is `merges <card>` where nothing holds, else `waits <card>: `
// and the held reasons in WAIT_REASONS order, then at the level always the line EVERY_CARD_WAITS, joined by `; `.
// With --herdr it judges in withHolds' Herdr mode, as the guard does for a Herdr job: only check, screenshot and the
// marker hold, and the level adds nothing.
// Exit 0: a completed judgement. 1: a rejected argument. 2: the level, the write-up or the board is unreadable, or the
// board does not hold the card, named on stderr as `unreadable <card>: <cause>`.
//
// #461: reads the board via the lean GraphQL page query (scripts/lib/board.mjs), not
// `gh project item-list` (a measured 203 GraphQL points per read). #1155: the whole
// walk runs inside one `gh api graphql --paginate --slurp` process, and every rule in
// scripts/lib/board-rules.mjs is answered off those pages and the cards the open and recently updated issue
// walks recover beside them (#504), each recovery named on stderr.
//
// A thin shell: every decision (what to select, what to print, what to exit with) lives
// in the pure parseBoardArgs/parkedLine/intakeSummary (scripts/lib/board.mjs) and
// scanBoard/scanOutcome/intakeCards/intakeOutcome (scripts/lib/board-rules.mjs), so this
// file holds no judgment of its own and the whole contract is unit-testable.

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { defaultRunner, heldReasons, readWaitLevel } from './lib/merge-evidence.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';
import { failureReport, ghExec, ghStart, retryBudget, settledRead } from './lib/gh-exec.mjs';
import { linearExec } from './lib/linear-api.mjs';
import { jiraExec } from './lib/jira-api.mjs';
import { azureExec } from './lib/azure-api.mjs';
import * as boardConfig from './lib/board-config.mjs';
import { BOARD_OWNER, BOARD_PROJECT_NUMBER, BOARD_REPOSITORY, PICKABLE_STATUSES } from './lib/board-config.mjs';
import { CARDS_DIR, configuredTracker } from './lib/board-markdown.mjs';
import {
  BOARD_HELP,
  INTAKE_EXIT,
  boardOpeningRequests,
  cardDetailRequests,
  formatGrouped,
  intakeCardFiles,
  intakeListing,
  intakeSummary,
  markerOf,
  normalizeItem,
  parseBoardArgs,
  parkedLine,
  pickable,
} from './lib/board.mjs';
import { linearTeamKey } from './lib/board-linear.mjs';
import { isFailedEmptyRead, readBoard, readDetails } from './lib/board-read.mjs';
import { intakeCards, intakeOutcome, scanBoard, scanOutcome } from './lib/board-rules.mjs';

const boardName = (tracker) => {
  if (tracker === 'markdown') return `markdown ${CARDS_DIR}`;
  if (tracker === 'linear') return `linear team ${linearTeamKey()}`;
  if (tracker === 'jira') return `jira project ${/** @type {typeof boardConfig & { JIRA_CONFIG: { project: string, site: string } }} */ (boardConfig).JIRA_CONFIG.project} at ${/** @type {typeof boardConfig & { JIRA_CONFIG: { project: string, site: string } }} */ (boardConfig).JIRA_CONFIG.site}`;
  if (tracker === 'azure') return `azure project ${/** @type {typeof boardConfig & { AZURE_CONFIG: { project: string, organization: string } }} */ (boardConfig).AZURE_CONFIG.project} at ${/** @type {typeof boardConfig & { AZURE_CONFIG: { project: string, organization: string } }} */ (boardConfig).AZURE_CONFIG.organization}`;
  return `${BOARD_OWNER}/${BOARD_REPOSITORY} project ${BOARD_PROJECT_NUMBER}`;
};

const headerLine = (label, selected, items, tracker) =>
  `Board ${boardName(tracker)} — ${label}: ${selected.length} of ${items.length} item(s)`;

// Each read card's full text goes to its file in the directory; a card whose file name is unsafe
// or whose write fails turns UNAVAILABLE, so the summary and the exit code both say so.
function writeCardFiles(cardFiles, details, directory, writeFile) {
  const files = new Map();
  for (const { number, name, lines } of cardFiles) {
    if (name === null) {
      details.set(number, { number, unavailable: `card id ${number} is not a safe file name` });
      continue;
    }
    try {
      writeFile(join(directory, name), `${lines.join('\n')}\n`);
      files.set(number, { name, lines });
    } catch (err) {
      details.set(number, { number, unavailable: `could not write the card text: ${/** @type {Error} */ (err).message}` });
    }
  }
  return files;
}

// GitHub reads that do not need one another's reply, started together and awaited together. `start`
// resolves each to a function that returns its reply or throws its failure, so every read has
// settled before any outcome is read. No synchronous GitHub call may run while one is in flight:
// a blocked event loop neither drains a started read's reply nor ends it at its timeout.
const startTogether = (start, requests) => Promise.all(requests.map((request) => start(request)));

// The board's raw items, and a markdown install's cards and claims, on `tracker`: on GitHub the item listing and the
// open issue walk are started together first, as every board read here opens.
async function readItems(tracker, { executor, linear, jira, azure, start, onOmission, pause, now }) {
  const budget = retryBudget(now);
  let opening;
  if (tracker === 'github') {
    const requests = boardOpeningRequests();
    const [listing, openIssues] = await startTogether(start, [requests.listing, requests.openIssues]);
    opening = { listing, openIssues };
  }
  return readBoard(tracker, { executor, linear, jira, azure, onOmission, opening, pause, budget });
}

// The judgement the guard makes of a card's saved write-up at HEAD in the working directory and of its marker on the
// board, as one line. A level, write-up or board that cannot be read, or a card the board does not hold, is an error,
// never a clear answer. The write-up and the setting are read first, so a card with none reads no board.
async function waitsLine(card, herdr, tracker, boardReads) {
  const git = defaultRunner(gitExecutable(), 'git.exe', {});
  const level = readWaitLevel({ git });
  const judge = (marked) => heldReasons(card, process.cwd(), { git }, undefined, { level, marked, herdr });
  const unmarked = judge(false);
  const { items } = await readItems(tracker, boardReads);
  const reasons = markerOf(card, items.map(normalizeItem)) ? judge(true) : unmarked;
  return reasons.length === 0 ? `merges ${card}` : `waits ${card}: ${reasons.join('; ')}`;
}

// The board line and the card summaries on stdout, the full card texts in the directory; the
// scan and the details outcome on stderr, so a caller that captures stdout holds the summary alone.
async function printIntake(items, args, { executor, start, linear, jira, azure, output, tracker, markdown, writeFile }) {
  const { candidates, claims, numberless, unplaced } = intakeCards(items);
  const numbers = [...candidates, ...claims].map((card) => card.number);
  const started = tracker === 'github' ? await startTogether(start, cardDetailRequests(numbers)) : [];
  const details = readDetails(tracker, { executor, linear, jira, azure, markdown, started }, numbers);
  const picks = pickable(items);
  const listing = intakeListing(headerLine(PICKABLE_STATUSES.join('/'), picks, items, tracker), picks);
  const files = writeCardFiles(intakeCardFiles({ candidates, claims, details }), details, args.intake, writeFile);
  const document = intakeSummary({ listing, candidates, claims, numberless, details, directory: args.intake, files, readyOrder: tracker === 'github' ? { unplaced } : null });
  const { lines, exitCode } = intakeOutcome({ ...scanBoard(items), details });
  output.log(document.join('\n'));
  const parkedNote = parkedLine(items, args);
  if (parkedNote) output.error(parkedNote);
  for (const line of lines) output.error(line);
  output.error(`board intake: ${document.length} line(s) on stdout.`);
  return exitCode;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  // The plain cause is the headline; the raw failure follows for whoever needs it.
  const reportFailure = (err, lead) => {
    const { headline, details } = failureReport(/** @type {Error} */ (err));
    output.error(`${lead}${headline}`);
    if (details !== null) output.error(`board: details: ${details}`);
  };
  const executor = dependencies.ghExec ?? ghExec;
  // A caller that injects only an executor has its started reads go through it too, so none reaches live GitHub.
  const start = dependencies.ghStart ?? (dependencies.ghExec ? (request) => settledRead(() => executor(request)) : ghStart);
  const linear = dependencies.linearExec ?? linearExec;
  const jira = dependencies.jiraExec ?? jiraExec;
  const azure = dependencies.azureExec ?? azureExec;

  let parsed;
  try {
    parsed = parseBoardArgs(args);
  } catch (err) {
    // The same one-line idiom as the read failure below, so the operator reads the
    // message and not an unhandled-rejection stack trace above it.
    output.error(`board: ${/** @type {Error} */ (err).message}`);
    return 1;
  }

  if (parsed.help) {
    output.log(BOARD_HELP);
    return 0;
  }

  if (typeof parsed.intake === 'string') {
    try {
      (dependencies.makeDirectory ?? ((directory) => mkdirSync(directory, { recursive: true })))(parsed.intake);
    } catch (err) {
      output.error(`board: could not create ${parsed.intake}: ${/** @type {Error} */ (err).message}`);
      return 1;
    }
  }

  const boardReads = { executor, linear, jira, azure, start, pause: dependencies.pause, now: dependencies.now, onOmission: (advisory) => output.error(`board: ${advisory}`) };
  if (parsed.waits) {
    try {
      output.log(await waitsLine(parsed.waits, parsed.herdr, configuredTracker(), boardReads));
      return 0;
    } catch (err) {
      reportFailure(err, `unreadable ${parsed.waits}: `);
      return INTAKE_EXIT.readFailed;
    }
  }
  // 2 under --intake, which tells a failed read from a rejected argument (1); every other mode keeps 1.
  const readFailed = parsed.intake ? INTAKE_EXIT.readFailed : 1;
  let tracker;
  try {
    tracker = configuredTracker();
  } catch (err) {
    output.error(`board: ${/** @type {Error} */ (err).message}`);
    return readFailed;
  }
  // A markdown install's cards and claims, read alongside its items; null on GitHub.
  /** @type {Awaited<ReturnType<typeof readItems>>['markdown']} */
  let markdown = null;
  let items;
  try {
    ({ items, markdown } = await readItems(tracker, boardReads));
  } catch (err) {
    const source = { markdown: 'markdown cards', linear: `Linear team ${linearTeamKey()}`, jira: 'Jira project', azure: 'Azure project', github: 'GitHub Projects board' }[tracker];
    reportFailure(err, `board: failed to read the ${source} — `);
    return readFailed;
  }
  // Empty markdown, Linear, Jira and Azure boards are valid; on GitHub zero items means a failed read.
  if (isFailedEmptyRead(tracker, items)) {
    output.error('board: gh returned 0 items — auth/network/project problem, not an empty backlog.');
    return readFailed;
  }

  if (parsed.intake) {
    const writeFile = dependencies.writeFile ?? writeFileSync;
    return printIntake(items, parsed, { executor, start, linear, jira, azure, output, tracker, markdown, writeFile });
  }

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
  process.exitCode = await main();
}
