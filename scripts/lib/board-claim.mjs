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

import { readFileSync } from 'node:fs';
import { hostname as machineHostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { foldCardTextLine, isClaim } from './board.mjs';
import * as boardConfig from './board-config.mjs';
import { moveCards } from './board-move.mjs';
import { ghExec } from './gh-exec.mjs';
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
    created = JSON.parse(reply);
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
    return refuse(err.message);
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
    return refuse(err.message);
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
