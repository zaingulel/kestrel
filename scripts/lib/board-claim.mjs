// board-claim.mjs — the claim of a picked card on the GitHub Projects tracker.
//
// Exit codes: 0 free, 1 refused (bad argument, runtime, hostname or tracker), 2 could not confirm
// before any write, 3 not free, 4 another claim is first, 5 could not confirm after writing began.
// Every refusal happens before any `gh` call. The free check judges the card read and the board
// read against the intake document exactly as the resume skill's hand claim steps do, which
// `references/claim-reads.md` holds. Claim mode then claims a free card as those steps do: the
// move to In progress, the assignee and the `Claim:` comment, in that order, then the card read
// again. Of the claims that read shows and the read before did not, the first in GitHub's comment
// order holds the card.
//
// `main(args, deps)` takes its `gh` executor, tracker, hostname, clock and output from `deps`, so a
// test needs no process and no `gh`.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname as machineHostname } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { foldCardTextLine, isClaim, newestClaim } from './board.mjs';
import * as boardConfig from './board-config.mjs';
import { moveCards } from './board-move.mjs';
import { parseWorktreeList } from './closeout-cleanup.mjs';
import { ghExec } from './gh-exec.mjs';
import { LOCAL_HERDR_TERMINAL } from './runtimes.mjs';
import { trackerOf } from './tracker.mjs';

export const RUNTIMES = ['Claude Code', 'Codex', 'Claude Code cloud'];

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const ISSUE = /^[1-9]\d*$/;

export const BOARD_CLAIM_USAGE =
  'usage: node scripts/board-claim.mjs <issue#> --intake <file> --runtime "<Claude Code|Codex|Claude Code cloud>"\n' +
  '       node scripts/board-claim.mjs <issue#> --intake <file> --check\n' +
  '       node scripts/board-claim.mjs --help   prints the modes, with no board read';

export const BOARD_CLAIM_HELP = [
  BOARD_CLAIM_USAGE,
  '',
  '  --intake <file>   the board intake the card was picked from, judged against the live reads',
  '  --runtime <name>  claim the card for this runtime, when it is free',
  '  --check           judge whether the card is free and write nothing',
  '  exit codes: 0 free, 1 refused, 2 could not confirm, 3 not free, 4 another claim is first,',
  '              5 could not confirm after writing began',
].join('\n');

// A flag's value, which may not itself be a flag.
const valueAfter = (rest, i) => (i + 1 < rest.length && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined);

// Throws the refusal for any argument the usage does not name, and returns the call otherwise.
function parseArgs(args) {
  const [issue, ...rest] = args;
  if (!ISSUE.test(issue ?? '') || !Number.isSafeInteger(Number(issue))) throw new Error(`the first argument must be a card number\n${BOARD_CLAIM_USAGE}`);
  const call = { issue: Number(issue), check: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--check' && !call.check) {
      call.check = true;
    } else if ((flag === '--intake' || flag === '--runtime') && call[flag.slice(2)] === undefined && valueAfter(rest, i) !== undefined) {
      call[flag.slice(2)] = valueAfter(rest, i);
      i += 1;
    } else {
      throw new Error(`unrecognised or repeated argument "${flag}"\n${BOARD_CLAIM_USAGE}`);
    }
  }
  if (call.intake === undefined) throw new Error(`--intake <file> is required\n${BOARD_CLAIM_USAGE}`);
  if (call.check === (call.runtime !== undefined)) throw new Error(`give exactly one of --runtime and --check\n${BOARD_CLAIM_USAGE}`);
  return call;
}

// A read or an intake the check cannot judge; its message is the `Could not confirm` reason.
class Unconfirmed extends Error {}

// A failed gh call's reason on one line: its stderr where it printed one, else its message.
const failure = (err) => String(typeof err?.stderr === 'string' && err.stderr.trim() !== '' ? err.stderr : err?.message ?? err).trim().replace(/\s+/g, ' ');

function readJson(exec, args, what) {
  let out;
  try {
    out = exec(args);
  } catch (err) {
    throw new Unconfirmed(`the ${what} failed: ${failure(err)}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Unconfirmed(`the ${what} returned malformed JSON`);
  }
}

// A comment's first line as the hand card read cuts it: after leading whitespace, up to the first CR or LF.
const firstLine = (body) => body.trimStart().split(/[\r\n]/)[0];

// The card read, oldest comment first, and its lines in the hand read's form.
function readCard(exec, issue) {
  const repo = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  const reply = readJson(exec, ['issue', 'view', String(issue), '--repo', repo, '--json', 'state,assignees,comments'], 'card read');
  const { state, assignees, comments } = reply ?? {};
  if (typeof state !== 'string' || !Array.isArray(assignees) || !assignees.every((a) => typeof a?.login === 'string')
    || !Array.isArray(comments) || !comments.every((c) => typeof c?.body === 'string')) {
    throw new Unconfirmed('the card read is incomplete: it lacks the state, the assignees or the comments');
  }
  const card = { state, assignees: assignees.map((a) => a.login), comments };
  const lines = [
    ['state', state],
    ['assignees', card.assignees],
    ...comments.flatMap((c, i) => (isClaim(c.body) ? [['claim', i + 1, c.author?.login, c.createdAt, c.url, firstLine(c.body)]] : [])),
    ['comments', comments.length],
  ];
  return { card, lines };
}

const BOARD_QUERY = 'query($owner: String! $repo: String! $issue: Int!) { repository(owner: $owner name: $repo) { issue(number: $issue) { projectItems(first: 20) { totalCount nodes { project { number owner { ... on User { login } ... on Organization { login } } } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }';

// The board read's lines in the hand read's form: one `board` line per project the card is on, then `boards`.
function readBoard(exec, issue) {
  const reply = readJson(exec, [
    'api', 'graphql',
    '-f', `owner=${boardConfig.BOARD_OWNER}`, '-f', `repo=${boardConfig.BOARD_REPOSITORY}`, '-F', `issue=${issue}`,
    '-f', `query=${BOARD_QUERY}`,
  ], 'board read');
  const items = reply?.data?.repository?.issue?.projectItems;
  if (!Array.isArray(items?.nodes)) throw new Unconfirmed('the board read is incomplete: it has no project list');
  return [
    ...items.nodes.map((node) => ['board', node?.project?.owner?.login, node?.project?.number, node?.fieldValueByName?.name]),
    ['boards', items.totalCount],
  ];
}

const nonblank = (value) => typeof value === 'string' && value.trim() !== '';

// The card's column on the configured board, from a complete board read only.
function boardColumn(lines) {
  const boards = lines.slice(0, -1);
  const count = lines.at(-1)[1];
  if (!Number.isInteger(count) || count !== boards.length) throw new Unconfirmed(`the board read is incomplete: it counts ${JSON.stringify(count)} project(s) and lists ${boards.length}`);
  if (!boards.every(([, owner, number]) => nonblank(owner) && Number.isInteger(number) && number > 0)) {
    throw new Unconfirmed('the board read is incomplete: a project has no owner or number');
  }
  const matches = boards.filter(([, owner, number]) => owner === boardConfig.BOARD_OWNER && number === boardConfig.BOARD_PROJECT_NUMBER);
  if (matches.length !== 1) throw new Unconfirmed(`the board read is incomplete: ${matches.length} of its projects are the configured board`);
  const column = matches[0][3];
  if (!nonblank(column)) throw new Unconfirmed('the board read is incomplete: the card has no column on the configured board');
  return column;
}

// The intake document's facts about the card: its column, assignees and latest claim, from three
// anchored matches: the board line first, the end line last, and the card's summary section.
function readIntake(path, issue) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Unconfirmed(`the intake ${JSON.stringify(path)} could not be read: ${failure(err)}`);
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const board = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY} project ${boardConfig.BOARD_PROJECT_NUMBER}`;
  if (!lines[0]?.startsWith(`Board ${board} — `)) throw new Unconfirmed(`the intake's first line does not name the board ${board}`);
  if (lines.at(-1) !== `board intake: end of document, ${lines.length} line(s).`) {
    throw new Unconfirmed(`the intake does not end with the end line counting its ${lines.length} line(s)`);
  }
  const summaries = lines.findIndex((line) => line.startsWith('Card summaries: '));
  const heading = `=== #${issue} [`;
  const start = summaries < 0 ? -1 : lines.findIndex((line, i) => i > summaries && line.startsWith(heading));
  if (start < 0) throw new Unconfirmed(`the intake has no summary for #${issue}`);
  const end = lines.indexOf('', start);
  const section = lines.slice(start, end < 0 ? lines.length : end);

  const close = section[0].indexOf('] ', heading.length);
  const column = close < 0 ? '' : section[0].slice(heading.length, close);
  if (column.trim() === '') throw new Unconfirmed(`the intake's summary for #${issue} gives no column`);

  const assigneeLine = section.find((line) => line.startsWith('assignees: '))?.slice('assignees: '.length);
  const accounts = assigneeLine === 'none' ? [] : assigneeLine?.split(', ');
  if (accounts === undefined || !accounts.every((account) => /^@\S+$/.test(account))) {
    throw new Unconfirmed(`the intake's summary for #${issue} gives no readable assignees`);
  }

  const claimAt = section.findIndex((line) => line.startsWith('claim: '));
  const claimLine = section[claimAt] ?? '';
  const position = /^claim: comment ([1-9]\d*) of \d+$/.exec(claimLine)?.[1];
  let claim;
  if (/^claim: none in \d+ comment\(s\)$/.test(claimLine)) {
    claim = null;
  } else if (position !== undefined && section[claimAt + 1]?.startsWith('| ')) {
    const more = section.slice(claimAt + 2);
    const folded = more.findIndex((line) => !line.startsWith('|+ '));
    claim = { position: Number(position), lines: [section[claimAt + 1], ...more.slice(0, folded < 0 ? more.length : folded)] };
  } else {
    throw new Unconfirmed(`the intake's summary for #${issue} gives no latest claim: ${JSON.stringify(claimLine)}`);
  }
  return { column, assignees: accounts.map((account) => account.slice(1)), claim };
}

// Why complete reads show the card not free, or null when it is free.
function notFreeReason(card, column, intake) {
  if (card.state !== 'OPEN') return `the card is ${JSON.stringify(card.state)}`;
  if (column !== intake.column) return `the card is in ${JSON.stringify(column)}, not ${JSON.stringify(intake.column)} as at intake`;
  if (!isDeepStrictEqual([...card.assignees].sort(), [...intake.assignees].sort())) return 'the card\'s assignees differ from the intake\'s';
  // The intake's comment count is ignored: a comment that is not a claim does not change who holds the card.
  const newest = card.comments.findLastIndex((c) => isClaim(c.body));
  const claim = newest < 0 ? null : { position: newest + 1, lines: foldCardTextLine(firstLine(card.comments[newest].body)) };
  if (!isDeepStrictEqual(claim, intake.claim)) return 'the card\'s latest claim differs from the intake\'s';
  const held = card.comments.findIndex((c) => c.body.trimStart().startsWith('Needs owner:'));
  if (held >= 0) return `comment ${held + 1} begins "Needs owner:", which holds the card for the owner`;
  return null;
}

// The free check: the reads, each printed as `before:` lines, then the intake's facts as `intake:`
// lines, then the judgment with the card read's lines. Throws Unconfirmed for anything it cannot judge.
function freeCheck(call, exec, output) {
  const intake = readIntake(call.intake, call.issue);
  const { card, lines: cardLines } = readCard(exec, call.issue);
  const boardLines = readBoard(exec, call.issue);
  for (const line of [...cardLines, ...boardLines]) output.log(`before: ${JSON.stringify(line)}`);
  for (const line of [
    ['column', intake.column],
    ['assignees', intake.assignees],
    intake.claim === null ? ['claim', 'none'] : ['claim', intake.claim.position, ...intake.claim.lines],
  ]) output.log(`intake: ${JSON.stringify(line)}`);
  return { notFree: notFreeReason(card, boardColumn(boardLines), intake), before: cardLines };
}

const CLAIM_COLUMN = 'In progress';

// The time as `date -u +%Y-%m-%dT%H:%MZ` prints it: the minute is cut, never rounded.
const claimTime = (date) => `${date.toISOString().slice(0, 16)}Z`;

const claimsOf = (lines) => lines.filter(([kind]) => kind === 'claim');

// The claim of a free card: its three writes in order, each printed as a `wrote:` line once made,
// then the card read again, printed as `after:` lines and judged against the read before the claim.
// Returns the exit: 0 the session's own claim holds the card, 4 another claim is first, 5 a write
// failed, with no later write made, or the card read again cannot confirm the hold.
function claim(call, exec, { hostname, now }, before, output) {
  const repo = `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;
  const body = `Claim: ${hostname}, ${call.runtime}, ${claimTime(now())}`;
  const wrote = (line) => output.log(`wrote: ${JSON.stringify(line)}`);
  const unconfirmed = (reason) => {
    output.log(`outcome: Could not confirm: ${reason}`);
    return 5;
  };
  /** @type {[string, () => unknown][]} */
  const writes = [
    ['the move to In progress', () => {
      const [{ skipped }] = moveCards([{ issueNumber: call.issue, statusName: CLAIM_COLUMN }], exec);
      wrote(['column', CLAIM_COLUMN, ...(skipped ? ['already there'] : [])]);
    }],
    ['the assignee write', () => {
      exec(['issue', 'edit', String(call.issue), '--repo', repo, '--add-assignee', '@me']);
      wrote(['assignee', '@me']);
    }],
    ['the claim comment', () => exec(['api', '-X', 'POST', `repos/${repo}/issues/${call.issue}/comments`, '-f', `body=${body}`])],
  ];
  let reply;
  for (const [what, write] of writes) {
    try {
      reply = write();
    } catch (err) {
      return unconfirmed(`${what} failed, and no later write was made: ${failure(err)}`);
    }
  }

  // GitHub's "Create an issue comment" reply gives the new comment's id and address. Without them
  // the session cannot know its own claim, though the comment may well have been posted.
  let created;
  try {
    created = JSON.parse(/** @type {string} */ (reply));
  } catch {
    created = null;
  }
  const id = created?.id;
  const address = created?.html_url;
  if (!Number.isSafeInteger(id) || id <= 0 || !nonblank(address)) {
    wrote(['claim', body]);
    return unconfirmed('the claim comment was posted, but GitHub\'s reply gives no comment id and address to know it by');
  }
  wrote(['claim', body, address]);

  let after;
  try {
    after = readCard(exec, call.issue);
  } catch (err) {
    if (!(err instanceof Unconfirmed)) throw err;
    return unconfirmed(err.message);
  }
  for (const line of after.lines) output.log(`after: ${JSON.stringify(line)}`);
  const claims = claimsOf(after.lines);
  if (!claims.every(([, , , , url]) => nonblank(url))) return unconfirmed('the card read after the claim is incomplete: a claim has no address');
  // A claim the read before the claim showed is history; the order of the rest is GitHub's alone.
  const history = new Set(claimsOf(before).map(([, , , , url]) => url));
  const fresh = claims.filter(([, , , , url]) => !history.has(url));
  const own = fresh.findIndex(([, , , , url]) => url.endsWith(`#issuecomment-${id}`));
  if (own < 0) return unconfirmed(`the card read after the claim shows no claim at ${address}`);
  if (own > 0) {
    output.log(`outcome: Another claim is first: comment ${fresh[0][1]} at ${fresh[0][4]} precedes the session's own claim, comment ${fresh[own][1]}`);
    return 4;
  }
  output.log(`outcome: Free: the session's own claim, comment ${fresh[0][1]} at ${address}, is the first new claim, so it holds the card`);
  return 0;
}

export function main(args = process.argv.slice(2), deps = {}) {
  const output = deps.output ?? console;
  if (args.includes('--help')) {
    if (args.length > 1) {
      output.error(`board-claim: --help takes no other argument\n${BOARD_CLAIM_USAGE}`);
      return 1;
    }
    output.log(BOARD_CLAIM_HELP);
    return 0;
  }
  const refuse = (reason) => {
    output.error(`board-claim: ${reason}`);
    return 1;
  };
  let call;
  try {
    call = parseArgs(args);
  } catch (err) {
    return refuse(/** @type {Error} */ (err).message);
  }
  if (call.runtime !== undefined && !RUNTIMES.includes(call.runtime)) {
    return refuse(`--runtime must be exactly one of ${RUNTIMES.map((name) => `"${name}"`).join(', ')}`);
  }
  // The hostname only enters the claim comment, so a check never needs it.
  const hostname = deps.hostname ?? machineHostname();
  if (!call.check && !HOSTNAME.test(hostname)) {
    return refuse(`the hostname ${JSON.stringify(hostname)} cannot go into a claim comment`);
  }
  let tracker;
  try {
    tracker = deps.tracker ?? trackerOf(boardConfig);
  } catch (err) {
    return refuse(/** @type {Error} */ (err).message);
  }
  if (tracker !== 'github') {
    return refuse(`this command serves only the GitHub Projects tracker, not "${tracker}"; claim by hand as references/claim-reads.md of the resume skill says`);
  }
  const exec = deps.ghExec ?? ghExec;
  let notFree;
  let before;
  try {
    ({ notFree, before } = freeCheck(call, exec, output));
  } catch (err) {
    if (!(err instanceof Unconfirmed)) throw err;
    output.log(`outcome: Could not confirm: ${err.message}`);
    return 2;
  }
  if (notFree !== null) {
    output.log(`outcome: Not free: ${notFree}`);
    return 3;
  }
  if (call.check) {
    output.log('outcome: Free: the card is open, in its intake column, with its intake assignees and latest claim and no owner question');
    return 0;
  }
  return claim(call, exec, { hostname, now: deps.now ?? (() => new Date()) }, before, output);
}

// A Herdr command line, `hc` or `herdr-app`, run with its arguments: its exit code and output.
/** @typedef {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} HerdrCommand */

// A Herdr command line, `hc` or `herdr-app`: resolves its exit code and output, and rejects only when it cannot run.
export const herdrCommand = (executable, timeout = 0) => (commandArgs) => new Promise((resolve, reject) => {
  execFile(executable, commandArgs, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

// The terminals `hc ls` lists with the labels `labels` (`key=value` words), finished ones too where `all`, or throws, naming the
// cause, when it cannot list them.
export async function jobTerminals(hc, labels, all = false) {
  const listing = await hc(['ls', ...labels.flatMap((label) => ['--label', label]), ...(all ? ['--all'] : []), '--json']);
  try {
    if (listing.code !== 0) throw new Error();
    const { terminals } = JSON.parse(listing.stdout);
    if (!Array.isArray(terminals)) throw new Error();
    return terminals;
  } catch {
    throw new Error(`hc ls could not list the job terminals: ${listing.stderr.trim() || `exit ${listing.code}`}`);
  }
}

// The `hc get --json` record of terminal `address` as `interpret` reads it, or throws, naming what it could not do (`reading`).
export async function readRecord(hc, address, reading, interpret) {
  const read = await hc(['get', address, '--json']);
  try {
    if (read.code !== 0) throw new Error();
    return interpret(JSON.parse(read.stdout));
  } catch {
    throw new Error(`hc get ${address} could not ${reading}: ${read.stderr.trim() || (read.code === 0 ? 'unreadable reply' : `exit ${read.code}`)}`);
  }
}

// The program `startJob` launches a job through; Herdr's record keeps it as `argv[0]` until the program is lost.
export const LAUNCH_PROGRAM = '/usr/bin/env';

// Whether the `hc ls` entry of terminal `address` is live, or throws, naming the address, where its state is no string.
export function isLive(address, state) {
  if (typeof state !== 'string') throw new Error(`hc ls listed terminal ${address} with no readable state`);
  return state === 'live';
}

// What `hc get` reads of terminal `address`: whether it is `running` a program, its status and its labels. A live terminal
// is running when its foreground is a known runtime, is a different process from the terminal or uses the job launch form.
// A finished record is stopped. Throws when a field a live record needs cannot be read.
export function interpretTerminal(record, live) {
  if (!live) return { running: false, status: undefined, labels: record.labels };
  const { pid, argv, foreground, status } = record;
  if (!Number.isInteger(pid) || !Number.isInteger(foreground.pid)) throw new Error();
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') throw new Error();
  if (status !== null && typeof status.state !== 'string') throw new Error();
  const runtime = foreground.name === 'claude' || foreground.name === 'codex';
  return { running: runtime || foreground.pid !== pid || argv[0] === LAUNCH_PROGRAM, status: status?.state, labels: record.labels };
}

// `interpretTerminal` over the `hc get --json` record of terminal `address`, or throws, naming the cause, when `hc get` cannot be read.
export const readTerminal = (hc, address, live) => readRecord(hc, address, 'tell whether it is running and its status', (record) => interpretTerminal(record, live));

/** @typedef {import('./board-rules.mjs').Observation} Observation */
/** @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string }} GitRunner */
/** @typedef {{ readDir: (path: string) => string[], stat: (path: string) => { isFile(): boolean, mtime: Date }, readFile: (path: string, encoding: 'utf8') => string }} WorklogReads */

// Why the newest claim in `detail` cannot be checked on `hostname`, or its time where it can.
/** @returns {{ cause: string, claimedAt?: undefined } | { cause?: undefined, claimedAt: Date }} */
function claimCheck(detail, hostname) {
  if (detail.unavailable !== undefined) return { cause: `comments not read: ${detail.unavailable}` };
  // A markdown install claims a card by its job branch, which names no machine.
  if (detail.claim !== undefined) return { cause: 'no claim names a machine' };
  const { machine, runtime, time } = newestClaim(detail.comments);
  if (machine === undefined) {
    return { cause: detail.commentsUnavailable === null ? 'no claim names a machine' : `comments not read: ${detail.commentsUnavailable}` };
  }
  // newestClaim ends the first line at a line feed only, so a lone carriage return still ends it here.
  const written = time?.split('\r')[0];
  // The time must read back exactly as written, which refuses another form and a date such as 30 February.
  const claimedAt = new Date(written ?? NaN);
  if (Number.isNaN(claimedAt.getTime()) || claimTime(claimedAt) !== written) return { cause: 'claim time unreadable' };
  if (machine !== hostname || runtime === 'Claude Code cloud') return { cause: `claimed on ${machine}, ${runtime}; this machine cannot check it` };
  return { claimedAt };
}

// Whether a live Herdr job terminal of `card`, launched from the integration checkout `checkout`, is running its job. Its
// foreground counts only where its `hc get` record names the same terminal and is live by its own state; a live local job
// terminal with no launch folder, or a record of another terminal, leaves it unavailable.
/** @param {HerdrCommand} hc */
async function jobLiveness(hc, card, checkout) {
  try {
    for (const { address, state, cwd } of await jobTerminals(hc, ['fabraik.role=job', `fabraik.card=${card}`])) {
      if (!LOCAL_HERDR_TERMINAL.test(address) || (typeof cwd === 'string' && cwd !== checkout) || !isLive(address, state)) continue;
      if (typeof cwd !== 'string') throw new Error(`hc ls gave job terminal ${address} no launch folder`);
      const read = await readRecord(hc, address, 'tell whether it is running and its status',
        (record) => (record.address === address ? interpretTerminal(record, record.state === 'live') : null));
      if (read === null) throw new Error(`hc get ${address} returned another terminal`);
      if (read.running) return { running: address };
    }
    return { running: null };
  } catch (error) {
    const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
    return { unavailable: code === 'ENOENT' ? 'hc is not available' : message };
  }
}

const errorCode = (error) => /** @type {NodeJS.ErrnoException} */ (error).code ?? /** @type {Error} */ (error).message;

// The newest of `claimedAt` and the modified times of the regular files directly in the worklog folder of `worktree`, judged
// without following links, and the last step its worklog records; or why the folder cannot be read. An entry that vanishes
// between the listing and its stat is skipped.
/**
 * @param {Date} claimedAt
 * @param {WorklogReads} reads
 * @param {{ parseReceipt: (line: string) => any, worklogFileName: (branch: string) => string }} runLog
 */
function worklogActivity(card, worktree, claimedAt, reads, runLog) {
  const { readDir, stat, readFile } = reads;
  const { parseReceipt, worklogFileName } = runLog;
  if (worktree === undefined) return { activeAt: claimedAt, lastStep: 'no job worktree here' };
  const folder = join(worktree, '.claude', 'worklog');
  const receiptName = worklogFileName(`job/${card}`);
  let activeAt = claimedAt;
  let receipt;
  try {
    for (const name of readDir(folder)) {
      let file;
      try {
        file = stat(join(folder, name));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
        throw error;
      }
      if (name === receiptName) receipt = file;
      if (file.isFile() && file.mtime > activeAt) activeAt = file.mtime;
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return { cause: `worklog unreadable: ${errorCode(error)}` };
  }
  if (receipt === undefined) return { activeAt, lastStep: 'no step recorded' };
  if (!receipt.isFile()) return { activeAt, lastStep: 'worklog unreadable: not a regular file' };
  let text;
  try {
    text = readFile(join(folder, receiptName), 'utf8');
  } catch (error) {
    const absent = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
    return { activeAt, lastStep: absent ? 'no step recorded' : `worklog unreadable: ${errorCode(error)}` };
  }
  const step = text.split('\n').map(parseReceipt).findLast((parsed) => parsed !== null);
  return { activeAt, lastStep: step ? `${step.label}, ${step.outcome}, completed ${step.completed}` : 'no step recorded' };
}

// One observation per card of `claims`, from its newest claim in `details`: not checkable where the claim cannot be read or
// names another machine or a cloud build, which reads neither Herdr nor any file; else the liveness of its Herdr job
// terminal, its last activity and its last recorded step. `git worktree list` is read once, and only for a checkable claim.
/**
 * @param {{ claims: { number: number }[], details: Map<number, any>, hostname: string, now: Date, rungit: GitRunner, hc: HerdrCommand } & WorklogReads} options
 * @returns {Promise<Map<number, Observation>>}
 */
export async function observeClaims({ claims, details, hostname, now, rungit, hc, readDir, stat, readFile }) {
  // run-log.mjs has a top-level await, and the guard loads coordinator.mjs, which imports this module, with a synchronous require.
  const runLog = await import('../run-log.mjs');
  /** @type {Map<number, Observation>} */
  const observations = new Map();
  /** @type {import('./closeout-cleanup.mjs').WorktreeRecord[] | null | undefined} */
  let worktrees;
  for (const { number } of claims) {
    const { cause, claimedAt } = claimCheck(details.get(number), hostname);
    if (claimedAt === undefined) {
      observations.set(number, { checkable: false, cause });
      continue;
    }
    if (worktrees === undefined) {
      const listing = rungit(['worktree', 'list', '--porcelain', '-z']);
      worktrees = listing.status === 0 ? parseWorktreeList(listing.stdout) : null;
    }
    if (worktrees === null) {
      observations.set(number, { checkable: false, cause: 'git worktree list could not be read' });
      continue;
    }
    const branch = `job/${number}`;
    const onBranch = worktrees.filter((record) => record.branch === `refs/heads/${branch}`);
    if (onBranch.length > 1) {
      observations.set(number, { checkable: false, cause: `${branch} is checked out in more than one worktree` });
      continue;
    }
    const liveness = await jobLiveness(hc, number, worktrees[0].path);
    const activity = worklogActivity(number, onBranch[0]?.path, claimedAt, { readDir, stat, readFile }, runLog);
    if (activity.cause !== undefined) {
      observations.set(number, { checkable: false, cause: activity.cause });
      continue;
    }
    const { activeAt, lastStep } = activity;
    observations.set(number, { checkable: true, liveness, activeAt, quietMs: now.getTime() - activeAt.getTime(), lastStep });
  }
  return observations;
}
