// board-markdown.mjs — the markdown tracker's card reader and mover: one card per file under
// .agents/cards, shown on the same board the GitHub tracker feeds.
//
// A card file stores only Backlog, Ready or Done. The column a card is shown in is derived from what
// the repository holds: its status on origin/main (the published status), its job/<N> branches
// (the claim), the status in the tip of its local branch, and the open pull requests of this
// repository from that branch. Every read is whole or fails with its cause: a corrupt card, an
// unreadable origin, an origin/main copy, a pull-request list or a linked cards folder stops the
// read, so a hostile or broken input never reads as a quiet board. docs/MARKDOWN-CARDS.md owns the
// card format and what each card step becomes. A move rewrites only a card's Status line, and only in
// a job worktree: the integration checkout is never written to.
//
// Git is reached through an injected runner `run(args, input) -> stdout`, which throws an Error
// carrying git's complaint, and `gh` through the executor the caller hands in, so the whole file
// is unit-testable. The default runner pins the working folder to this checkout's root and drops
// every repository-scoped variable from the environment.

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as boardConfig from './board-config.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { gitExecutable } from './posix-shell.mjs';
import { checkContained, kindOf } from './runtimes.mjs';
import { trackerOf } from './tracker.mjs';

export const CARDS_DIR = '.agents/cards';

// The checkout this module sits in: two folders above scripts/lib, never the current directory.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const configuredTracker = () => trackerOf(boardConfig);

const [DONE] = boardConfig.TERMINAL_STATUSES;
const isPickable = (status) => boardConfig.PICKABLE_STATUSES.includes(status);

const vocabulary = () => ({
  kinds: Object.keys(boardConfig.KIND_LABELS),
  routingField: boardConfig.ROUTING_FIELD,
  routingOptions: boardConfig.ROUTING_OPTIONS,
  statuses: [...boardConfig.PICKABLE_STATUSES, ...boardConfig.TERMINAL_STATUSES],
});

const CARD_NUMBER = /^[1-9]\d*$/;
const BLOCKER_LIST = /^[1-9]\d*(, [1-9]\d*)*$/;
// Number() rounds past 2^53, so two long digit strings would name one card and a path rebuilt from the
// number would name another file: a card number is a safe integer or it is refused.
const isSafeNumber = (digits) => Number.isSafeInteger(Number(digits));
const COMMENTS_HEADING = '## Comments';
const COMMENT_PREFIX = '### ';

// One card file's text → the card, strictly: the first problem stops the read, naming the file and
// the line. `vocabulary` carries the statuses a card may store, the kinds and the routing field
// with its options, so the parser holds under any adopter's configuration.
export function parseCard(fileName, text, { kinds, routingField, routingOptions, statuses }) {
  const fail = (line, message) => {
    throw new Error(`${fileName}:${line}: ${message}`);
  };
  const number = Number(/(\d+)\.md$/.exec(fileName)?.[1]);
  const lines = text.split(/\r\n|\n/);

  if (!lines[0].startsWith('# ') || lines[0].slice(2).trim() === '') fail(1, 'expected "# <title>"');
  if (lines[1] !== '') fail(2, 'expected a blank line after the title');

  const allowed = ['Status', 'Kind', ...(routingField ? [routingField] : []), 'Parent', 'Blocked by'];
  const fields = new Map();
  const fieldLines = {};
  let end = 2;
  for (; end < lines.length && lines[end] !== ''; end += 1) {
    const match = /^([^:]+): (.*)$/.exec(lines[end]);
    if (!match) fail(end + 1, 'expected "<Field>: <value>"');
    const [, key, value] = match;
    if (!allowed.includes(key)) fail(end + 1, `unknown field "${key}"`);
    if (fields.has(key)) fail(end + 1, `duplicate field "${key}"`);
    fields.set(key, value);
    fieldLines[key] = end + 1;
  }
  for (const key of ['Status', 'Kind', ...(routingField ? [routingField] : [])]) {
    if (!fields.has(key)) fail(end + 1, `missing required field "${key}"`);
  }
  const oneOf = (key, options) => {
    if (!options.includes(fields.get(key))) fail(fieldLines[key], `${key} must be one of ${options.join(', ')}; found "${fields.get(key)}"`);
    return fields.get(key);
  };
  const status = oneOf('Status', statuses);
  const kind = oneOf('Kind', kinds);
  const routing = routingField ? oneOf(routingField, routingOptions) : null;

  let parent = null;
  if (fields.has('Parent')) {
    if (!CARD_NUMBER.test(fields.get('Parent')) || !isSafeNumber(fields.get('Parent'))) fail(fieldLines.Parent, `Parent must be a card number; found "${fields.get('Parent')}"`);
    parent = Number(fields.get('Parent'));
    if (parent === number) fail(fieldLines.Parent, 'Parent must not name the card itself');
  }
  let blockedBy = [];
  if (fields.has('Blocked by')) {
    if (!BLOCKER_LIST.test(fields.get('Blocked by')) || !fields.get('Blocked by').split(', ').every(isSafeNumber)) {
      fail(fieldLines['Blocked by'], `Blocked by must be card numbers separated by ", "; found "${fields.get('Blocked by')}"`);
    }
    blockedBy = fields.get('Blocked by').split(', ').map(Number);
    const repeated = blockedBy.find((blocker, index) => blockedBy.indexOf(blocker) !== index);
    if (repeated !== undefined) fail(fieldLines['Blocked by'], `Blocked by names card ${repeated} twice`);
    if (blockedBy.includes(number)) fail(fieldLines['Blocked by'], 'Blocked by must not name the card itself');
  }

  const headingAt = lines.indexOf(COMMENTS_HEADING, end);
  const bodyEnd = headingAt === -1 ? lines.length : headingAt;
  const comments = [];
  for (let at = headingAt + 1; headingAt !== -1 && at < lines.length; at += 1) {
    const line = lines[at];
    if (line === COMMENTS_HEADING) fail(at + 1, 'a second "## Comments" heading');
    if (line.startsWith(COMMENT_PREFIX)) {
      if (line.slice(COMMENT_PREFIX.length).trim() === '') fail(at + 1, 'a comment heading needs text after "### "');
      comments.push({ heading: line.slice(COMMENT_PREFIX.length).trim(), lines: [] });
    } else if (comments.length > 0) {
      comments.at(-1).lines.push(line);
    } else if (line !== '') {
      fail(at + 1, 'text under "## Comments" before the first "### " comment heading');
    }
  }

  return {
    number,
    title: lines[0].slice(2).trim(),
    status,
    kind,
    routing,
    parent,
    blockedBy,
    body: lines.slice(end, bodyEnd).join('\n').trim(),
    comments: comments.map(({ heading, lines: commentLines }) => ({ heading, text: commentLines.join('\n').trim() })),
    fieldLines: Object.fromEntries(['Parent', 'Blocked by'].filter((key) => fields.has(key)).map((key) => [key, fieldLines[key]])),
  };
}

// The one containment check every listing, read and write of the cards folder calls: nothing is
// read or written through a link at .agents or .agents/cards. An absent folder passes.
export function containCards(root, path) {
  checkContained(root, path);
}

const CARD_FILE = /^([1-9]\d*)\.md$/;

// The checkout's cards by number, with every Parent and Blocked by reference checked.
export function readCards(root = ROOT) {
  containCards(root, `${CARDS_DIR}/`);
  let names;
  try {
    names = readdirSync(join(root, CARDS_DIR));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const files = names.map((name) => {
    const stat = lstatSync(join(root, CARDS_DIR, name));
    const digits = CARD_FILE.exec(name)?.[1];
    if (digits === undefined || !isSafeNumber(digits) || !stat.isFile()) {
      const found = !stat.isFile() ? kindOf(stat) : digits === undefined ? 'a file with another name' : 'a card number beyond the safe integers';
      throw new Error(`${CARDS_DIR}/${name}: only regular files named <N>.md, N a positive safe integer with no leading zero, belong in ${CARDS_DIR}; found ${found}`);
    }
    return { name, number: Number(digits) };
  }).sort((a, b) => a.number - b.number);

  const cards = new Map();
  for (const { name, number } of files) {
    containCards(root, `${CARDS_DIR}/${name}`);
    cards.set(number, parseCard(`${CARDS_DIR}/${name}`, readFileSync(join(root, CARDS_DIR, name), 'utf8'), vocabulary()));
  }
  for (const card of cards.values()) {
    for (const [key, numbers] of [['Parent', card.parent === null ? [] : [card.parent]], ['Blocked by', card.blockedBy]]) {
      const missing = numbers.find((number) => !cards.has(number));
      if (missing !== undefined) {
        throw new Error(`${CARDS_DIR}/${card.number}.md:${card.fieldLines[key]}: ${key} names card ${missing}, which has no file in ${CARDS_DIR}`);
      }
    }
  }
  return cards;
}

// The columns a card is derived into, and what derives them. These are fixed by the card format,
// not by the configuration's vocabulary.
const IN_PROGRESS = 'In progress';
const AWAITING_PUSH = 'Awaiting push';
const IN_REVIEW = 'In review';

// The column a card is shown in. The first rule that holds wins, and rules 1 to 3 apply only to a
// card whose published status is pickable: 1 an open pull request of this repository from its job
// branch; 2 a local job branch whose tip's copy of the card says Done; 3 a local job branch, or one
// origin lists; 4 the published status.
export function deriveColumn(published, { local, localTipDone, remote, openPullRequests }) {
  if (!isPickable(published)) return published;
  if (openPullRequests.length > 0) return IN_REVIEW;
  if (local && localTipDone) return AWAITING_PUSH;
  if (local || remote) return IN_PROGRESS;
  return published;
}

// The git runner a read uses unless one is injected.
export function gitRunner(root = ROOT) {
  const git = gitExecutable();
  if (!git) throw new Error('git was not found on PATH');
  return (args, input) => {
    try {
      return execFileSync(git, args, {
        cwd: root,
        encoding: 'utf8',
        env: gitEnvironment(),
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(String(error.stderr ?? '').trim() || error.message);
    }
  };
}

// The text of each named object, in order, from one `cat-file --batch` call; null where it is absent.
// The answer is framed by byte length, so a size that does not frame its content fails the read.
function readObjects(run, specs) {
  if (specs.length === 0) return [];
  const answer = Buffer.from(run(['cat-file', '--batch'], `${specs.join('\n')}\n`), 'utf8');
  let at = 0;
  return specs.map((spec) => {
    const headerEnd = answer.indexOf(0x0a, at);
    if (headerEnd === -1) throw new Error(`cat-file --batch ended before it answered ${spec}`);
    const header = answer.toString('utf8', at, headerEnd);
    at = headerEnd + 1;
    if (header === `${spec} missing`) return null;
    const size = /^[0-9a-f]{40,64} blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) throw new Error(`cat-file --batch answered ${spec} with "${header}", not a blob`);
    const end = at + Number(size);
    if (answer[end] !== 0x0a) throw new Error(`cat-file --batch answered ${spec} with a size that does not frame its content`);
    const content = answer.toString('utf8', at, end);
    at = end + 1;
    return content;
  });
}

const MAIN_REF = 'refs/remotes/origin/main';

// Each card's published status: its status on origin/main, read for every card in one call. A card
// absent from origin/main is not published yet and takes its checkout copy's status, unless that
// says Done: a card is first published as Backlog or Ready, so a checkout-only Done fails the read.
export function publishedStatuses(run, cards) {
  try {
    run(['rev-parse', '--verify', '--quiet', MAIN_REF]);
  } catch (error) {
    throw new Error(`${MAIN_REF} is missing; run: git fetch origin main${error.message ? ` (${error.message})` : ''}`);
  }
  const numbers = [...cards.keys()];
  const copies = readObjects(run, numbers.map((number) => `${MAIN_REF}:${CARDS_DIR}/${number}.md`));
  return new Map(numbers.map((number, index) => {
    const card = cards.get(number);
    if (copies[index] !== null) {
      return [number, { status: parseCard(`origin/main:${CARDS_DIR}/${number}.md`, copies[index], vocabulary()).status, onMain: true }];
    }
    if (card.status === DONE) {
      throw new Error(
        `${CARDS_DIR}/${number}.md says ${DONE} but is not on origin/main; a card is first published as ${boardConfig.PICKABLE_STATUSES.join(' or ')} through a merged change`,
      );
    }
    return [number, { status: card.status, onMain: false }];
  }));
}

const pullRepository = () => `${boardConfig.BOARD_OWNER}/${boardConfig.BOARD_REPOSITORY}`;

const jobNumber = (branch) => {
  const match = /^job\/([1-9]\d*)$/.exec(branch);
  return match && isSafeNumber(match[1]) ? Number(match[1]) : null;
};

// The job/<N> branches that claim cards: `local` maps each number to the status in its branch tip's
// copy of the card (null when the tip holds no copy), `remote` maps each number origin lists to its
// tip. Other branches are not claims.
export function jobRefs(run) {
  const localOut = run(['for-each-ref', '--format=%(refname)', 'refs/heads/job/']);
  let remoteOut;
  try {
    remoteOut = run(['ls-remote', '--heads', 'origin']);
  } catch (error) {
    throw new Error(`cannot read origin's branches (git ls-remote --heads origin): ${error.message}`);
  }
  const remote = new Map();
  for (const line of remoteOut.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(line);
    if (!match) throw new Error(`git ls-remote --heads origin returned a line that is not "<object id><tab>refs/heads/<name>": ${JSON.stringify(line)}`);
    const number = jobNumber(match[2]);
    if (number !== null) remote.set(number, match[1]);
  }
  const numbers = localOut.split('\n').filter(Boolean)
    .map((ref) => jobNumber(ref.replace(/^refs\/heads\//, '')))
    .filter((number) => number !== null);
  const tips = readObjects(run, numbers.map((number) => `refs/heads/job/${number}:${CARDS_DIR}/${number}.md`));
  const local = new Map(numbers.map((number, index) => [
    number,
    tips[index] === null ? null : parseCard(`job/${number}:${CARDS_DIR}/${number}.md`, tips[index], vocabulary()).status,
  ]));
  return { local, remote };
}

// The open pull requests of `nameWithOwner` from each job/<N> branch. `--repo` binds the call to the
// configured repository whatever the working folder or GH_REPO says, and `--head` takes a bare branch
// name that a fork can share, so only an entry from that branch of this repository counts.
export function openPullRequests(numbers, ghExec, nameWithOwner) {
  return new Map(numbers.map((number) => {
    const branch = `job/${number}`;
    let reply;
    try {
      reply = ghExec(['pr', 'list', '--repo', nameWithOwner, '--head', branch, '--state', 'open', '--json', 'number,headRefName,isCrossRepository']);
    } catch (error) {
      throw new Error(`cannot read the pull requests of ${branch}: ${error.message}`);
    }
    const malformed = (reason) => new Error(`the pull-request list for ${branch} is malformed: ${reason}`);
    let entries;
    try {
      entries = JSON.parse(reply);
    } catch (error) {
      throw malformed(error.message);
    }
    if (!Array.isArray(entries)) throw malformed('not a JSON array');
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry?.number) || entry.number < 1 || typeof entry.headRefName !== 'string' || typeof entry.isCrossRepository !== 'boolean') {
        throw malformed(`an entry without a positive integer number, a string headRefName and a boolean isCrossRepository: ${JSON.stringify(entry)}`);
      }
    }
    return [number, entries.filter((entry) => entry.headRefName === branch && !entry.isCrossRepository).map(({ number: pull }) => ({ number: pull }))];
  }));
}

// The cards as raw board items in the shape parseNode gives the GitHub read, so every board rule
// and renderer judges them unchanged. A card is CLOSED if and only if its published status is Done;
// a closing pull request is only ever a counted open one, never inferred from a branch.
export function markdownBoardItems(cards, published, refs, pulls) {
  const stateOf = (number) => (published.get(number).status === DONE ? 'CLOSED' : 'OPEN');
  return [...cards.values()].map((card) => {
    const { number } = card;
    const status = published.get(number).status;
    const local = refs.local.has(number);
    const remote = refs.remote.has(number);
    const openPulls = pulls.get(number) ?? [];
    const children = [...cards.values()].filter((child) => child.parent === number);
    return {
      id: `${CARDS_DIR}/${number}.md`,
      status: deriveColumn(status, { local, localTipDone: refs.local.get(number) === DONE, remote, openPullRequests: openPulls }),
      title: card.title,
      routing: card.routing,
      labels: [boardConfig.KIND_LABELS[card.kind]],
      assignees: [],
      blockers: card.blockedBy.map((blocker) => ({ number: blocker, state: stateOf(blocker) })),
      closingPullRequests: isPickable(status) ? openPulls.map((pull) => ({ number: pull.number })) : [],
      ...(local || remote ? { jobBranch: { local, remote } } : {}),
      content: {
        number,
        state: stateOf(number),
        subIssuesSummary: { total: children.length, completed: children.filter((child) => stateOf(child.number) === 'CLOSED').length },
      },
    };
  });
}

const claimOf = (number, refs) => {
  const local = refs.local.has(number);
  const remote = refs.remote.has(number);
  if (!local && !remote) return 'none';
  return `branch job/${number} (${local && remote ? 'local and origin' : local ? 'local' : 'origin'})`;
};

// The card details the intake document prints, in the shape fetchCardDetails gives for GitHub cards,
// plus `claim`: the branch that claims the card.
export function markdownCardDetails(cards, numbers, refs) {
  return new Map(numbers.map((number) => {
    const card = cards.get(number);
    const comments = card.comments.map(({ heading, text }) => (text === '' ? heading : `${heading}\n${text}`));
    return [number, {
      number,
      body: card.body,
      parent: card.parent,
      comments,
      commentCount: comments.length,
      commentsUnavailable: null,
      claim: claimOf(number, refs),
    }];
  }));
}

// The whole markdown board: the cards, the claims and the raw items. Only a card published Backlog or
// Ready whose branch origin lists is asked for its pull requests, since no other card's column or
// closing pull requests depend on one.
export function readMarkdownBoard(ghExec, root = ROOT, run = gitRunner(root)) {
  const cards = readCards(root);
  const published = publishedStatuses(run, cards);
  const refs = jobRefs(run);
  const watched = [...cards.keys()].filter((number) => refs.remote.has(number) && isPickable(published.get(number).status));
  const pulls = openPullRequests(watched, ghExec, pullRepository());
  return { cards, refs, items: markdownBoardItems(cards, published, refs, pulls) };
}

// The branch HEAD is on, or null when it is detached.
function headBranch(run) {
  try {
    return run(['symbolic-ref', '--short', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function requireJobBranch(run, number) {
  const branch = `job/${number}`;
  const head = headBranch(run);
  if (head !== branch) {
    throw new Error(`HEAD is ${head === null ? 'detached' : `on ${head}`}, not on ${branch}; run this in the job worktree of #${number}`);
  }
  return branch;
}

// The integration checkout is the one whose repository directory is the common one; a linked worktree's is its own.
export function isIntegrationCheckout(run) {
  const [gitDir, commonDir] = run(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n');
  return gitDir === commonDir;
}

// The claim check: holds only on the job branch of a card published as pickable whose origin branch, if
// any, is part of this one. It writes nothing.
function checkClaim(run, number, published) {
  const branch = requireJobBranch(run, number);
  const { status } = published.get(number);
  if (!isPickable(status)) throw new Error(`#${number} is ${status} on origin/main, so it is not free to claim`);
  const tip = jobRefs(run).remote.get(number);
  if (tip === undefined) return;
  try {
    run(['cat-file', '-e', `${tip}^{commit}`]);
  } catch (error) {
    throw new Error(`cannot confirm the claim: origin's ${branch} (${tip}) is not in this clone; run: git fetch origin (${error.message})`);
  }
  try {
    run(['merge-base', '--is-ancestor', tip, 'HEAD']);
  } catch {
    throw new Error(`#${number} is not free: origin's ${branch} (${tip}) is not in this branch`);
  }
}

function checkAwaitingPush(run, card) {
  requireJobBranch(run, card.number);
  if (card.status !== DONE) {
    throw new Error(`#${card.number} has no closing edit: this checkout's ${CARDS_DIR}/${card.number}.md says ${card.status}; run: node scripts/board-move.mjs ${card.number} ${DONE}, then commit the card file`);
  }
}

function checkInReview(run, number, ghExec) {
  const branch = requireJobBranch(run, number);
  const tip = jobRefs(run).remote.get(number);
  if (tip === undefined) throw new Error(`origin has no ${branch}; push it before In review`);
  const head = run(['rev-parse', 'HEAD']).trim();
  if (tip !== head) throw new Error(`origin's ${branch} (${tip}) is not this checkout's HEAD (${head}); push the unpushed commits before In review`);
  if (openPullRequests([number], ghExec, pullRepository()).get(number).length === 0) {
    throw new Error(`no open pull request from ${branch} in ${pullRepository()}; open the draft before In review`);
  }
}

// The text with its Status field line rewritten, line endings kept. The line is found as parseCard finds it,
// in the field block from line 3 to the first blank line, so a title that holds "Status:" is never touched.
// The card was parsed from this text, so the block holds the line.
function withStatus(text, statusName) {
  const parts = text.split(/(\r\n|\n)/);
  let at = 4;
  while (!parts[at].startsWith('Status: ')) at += 2;
  parts[at] = `Status: ${statusName}`;
  return parts.join('');
}

// Rewrites only the Status line of this checkout's copy; true when it already said so. Already there is a
// no-op even in the integration checkout, which is otherwise refused, and closing a card that origin/main
// lacks is refused.
function writeStatus(run, card, statusName, published) {
  const { number } = card;
  if (card.status === statusName) return true;
  if (isIntegrationCheckout(run)) {
    throw new Error(`this is the integration checkout, which nothing is written to; make the change in the job worktree of #${number}`);
  }
  if (statusName === DONE && !published.get(number).onMain) {
    throw new Error(`#${number} is not on origin/main; publish the card as ${boardConfig.PICKABLE_STATUSES.join(' or ')} through a merged change before closing it`);
  }
  const path = `${CARDS_DIR}/${number}.md`;
  containCards(ROOT, path);
  const file = join(ROOT, path);
  writeFileSync(file, withStatus(readFileSync(file, 'utf8'), statusName));
  card.status = statusName;
  return false;
}

// Moves each `{ issueNumber, statusName }` pair on the markdown board in order, stopping at the first
// failure and naming the moves already done. Backlog, Ready and Done rewrite the card file; In progress,
// Awaiting push and In review write nothing and only check that the repository shows the state. Returns
// the completed pairs as moveCards does, with `checked` set on a check.
export function moveMarkdownCards(pairs, run, ghExec) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('moveMarkdownCards requires at least one pair');
  const cards = readCards(ROOT);
  const published = publishedStatuses(run, cards);
  const writable = [...boardConfig.PICKABLE_STATUSES, ...boardConfig.TERMINAL_STATUSES];
  const allowed = [...writable, IN_PROGRESS, AWAITING_PUSH, IN_REVIEW];
  const completed = [];
  for (const { issueNumber, statusName } of pairs) {
    try {
      const card = cards.get(issueNumber);
      if (!card) throw new Error(`#${issueNumber} has no card file ${CARDS_DIR}/${issueNumber}.md in this checkout`);
      const target = allowed.find((option) => option.toLowerCase() === statusName.trim().toLowerCase());
      if (!target) throw new Error(`unknown Status "${statusName}" — valid options: ${allowed.join(', ')}`);
      if (writable.includes(target)) {
        completed.push({ issueNumber, statusName: target, skipped: writeStatus(run, card, target, published), cleared: false });
      } else {
        if (target === IN_PROGRESS) checkClaim(run, issueNumber, published);
        else if (target === AWAITING_PUSH) checkAwaitingPush(run, card);
        else checkInReview(run, issueNumber, ghExec);
        completed.push({ issueNumber, statusName: target, skipped: false, cleared: false, checked: true });
      }
    } catch (error) {
      const done = completed.map((pair) => `#${pair.issueNumber} → ${pair.statusName}`).join(', ') || 'none';
      throw new Error(`failed to move #${issueNumber} → "${statusName}" (already completed: ${done}) — ${error.message}`, { cause: error });
    }
  }
  return completed;
}
