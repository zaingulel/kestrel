// Resume's fixed opening steps as one command: the fetch, the local inventory, the check that this is the
// main checkout on main, clean and at the fetched commit, then the board intake, the open pull request list
// and the deferred cleanup list together, a recheck of the checkout, and one document on stdout. It gathers
// evidence and acts on none of it. Anything else stops it with its own exit code and one stderr line naming
// the step, and a stop prints nothing on stdout, so no partial document exists that could read as complete;
// an incomplete cleanup list is no stop, and its own exit code says so. Apart from the fetch it only reads,
// locally and through gh, and it writes only inside the folder it is given.
import { execFile, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as boardConfig from './board-config.mjs';
import { INTAKE_EXIT } from './board.mjs';
import { ghStart } from './gh-exec.mjs';
import { gitExecutable } from './posix-shell.mjs';
import { trackerOf } from './tracker.mjs';

export const RESUME_START_EXIT = Object.freeze({
  ordinary: 0,
  refused: 1,
  drift: 3,
  cleanupIncomplete: 4,
  driftAndCleanupIncomplete: 5,
  fetch: 10,
  inventory: 11,
  linkedWorktree: 12,
  offMain: 13,
  notAtTarget: 14,
  changed: 15,
  intake: 16,
  pullRequests: 17,
  recheck: 18,
  save: 19,
});

const USAGE = 'usage: node scripts/resume-start.mjs <folder> > <folder>/resume-start.txt';

export const RESUME_START_HELP = `${USAGE}
       node scripts/resume-start.mjs --help

Runs resume's opening steps from the main checkout: the fetch, the local inventory, the board intake into
<folder>/intake, the open pull request list and the deferred cleanup list. It saves the intake summary as
<folder>/board-intake.txt and prints one document on stdout, with the document's line count on stderr.

Exit 0: the main checkout is on main, clean and at the fetched commit, and the intake and cleanup list are complete.
Exit 3: the same, and the intake reports drift.
Exit 4: as exit 0, except that the cleanup list is incomplete.
Exit 5: as exit 3, except that the cleanup list is incomplete.
Exit 1: the arguments were refused.
Any other exit is a stop, named on stderr, with nothing printed on stdout and no summary saved:
  10 the fetch                    15 the main checkout has changes
  11 a local inventory read       16 the board intake failed or is incomplete
  12 run in a linked worktree     17 the open pull request read
  13 not on main                  18 the checkout moved or changed during the reads
  14 not at the fetched commit    19 the intake summary could not be saved`;

const PULL_REQUEST_READ = ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url'];
const INTAKE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const RESOLVED_HEADING = /^(?:\*\*cleanup resolved\*\*|#{1,6} cleanup resolved)$/i;

function parseArgs(args) {
  if (args.length !== 1) return { refusal: `expected one folder, got ${args.length} argument(s)` };
  const [arg] = args;
  if (arg === '--help') return { help: true };
  if (arg === '' || arg.startsWith('-')) return { refusal: `expected a folder, got ${JSON.stringify(arg)}` };
  return { folder: arg };
}

function runGit(args) {
  // By path on Windows, whose bare-name search reaches the working directory first.
  const git = gitExecutable();
  if (!git) throw new Error('no git.exe in an absolute PATH entry');
  return execFileSync(git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// The board intake as a child process: board.mjs makes synchronous GitHub calls after its started reads,
// which must not run in this process while the pull request read is in flight. Never rejects; a child
// that did not run to an exit code has status null.
function runIntake(folder) {
  const board = fileURLToPath(new URL('../board.mjs', import.meta.url));
  return new Promise((resolve) => {
    execFile(process.execPath, [board, '--intake', folder], { encoding: 'utf8', maxBuffer: INTAKE_MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (!error) resolve({ status: 0, stdout, stderr });
      else if (typeof error.code === 'number') resolve({ status: error.code, stdout, stderr });
      else resolve({ status: null, stdout, stderr: `${stderr}${error.message}\n` });
    });
  });
}

const failureText = (error) => ((typeof error.stderr === 'string' && error.stderr.trim()) || error.message).replace(/\s*\n\s*/g, ' ');
const pathCount = (status) => status.trimEnd().split('\n').length;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const resolved = (comment) => RESOLVED_HEADING.test(comment.body.trimStart().split(/[\r\n]/)[0].trimEnd());
const isRecord = (comment) => !resolved(comment) && /cleanup\s+pending/i.test(comment.body);

function isSettled(comments) {
  const answers = comments.filter(resolved);
  return answers.length > 0 && comments.filter(isRecord).every((record) => (
    answers.some((answer) => answer.id > record.id && new RegExp(`issuecomment-${record.id}(?!\\d)`).test(answer.body))
  ));
}

function parseSearch(text) {
  const pages = JSON.parse(text);
  const valid = Array.isArray(pages) && pages.length > 0 && pages.every((page) => (
    isObject(page) && typeof page.incomplete_results === 'boolean' && Number.isSafeInteger(page.total_count) && page.total_count >= 0
    && Array.isArray(page.items) && page.items.every((item) => item !== null && typeof item === 'object' && isId(item.number))
  ));
  if (!valid) throw new Error('the search reply is not a list of search pages');
  return {
    incompleteResults: pages.some((page) => page.incomplete_results),
    total: pages[0].total_count,
    hits: [...new Set(pages.flatMap((page) => page.items.map((item) => item.number)))].sort((a, b) => a - b),
  };
}

function parseComments(text) {
  const pages = JSON.parse(text);
  const valid = Array.isArray(pages) && pages.every((page) => Array.isArray(page) && page.every((comment) => (
    comment !== null && typeof comment === 'object' && isId(comment.id) && typeof comment.body === 'string'
  )));
  if (!valid) throw new Error('the comments reply is not a list of comment pages');
  return pages.flat();
}

// The deferred cleanup list from closeout's Deferred cleanup section, which owns the rule: its discovery search,
// then every hit's comments. A hit is settled only when a comment is headed Cleanup resolved and every other
// comment carrying the phrase is linked by a later comment so headed; every other hit stays pending. Never
// rejects. It prints card numbers and counts only: comment text is untrusted, and a parse failure's message can
// quote it.
async function readDeferredCleanup(config, read) {
  try {
    const tracker = trackerOf(config);
    if (tracker !== trackerOf({})) {
      return { incomplete: false, lines: [`deferred cleanup: not applicable, the ${tracker} tracker keeps no Cleanup pending record`] };
    }
    const repository = `${config.BOARD_OWNER}/${config.BOARD_REPOSITORY}`;
    const query = `repo:${repository} is:issue in:comments "Cleanup pending"`;
    const search = parseSearch((await read(['api', '-X', 'GET', '--paginate', '--slurp', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=100']))());
    const comments = await Promise.all(search.hits.map(async (number) => {
      try {
        return parseComments((await read(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`]))());
      } catch {
        return null;
      }
    }));
    const unread = search.hits.filter((_, index) => comments[index] === null);
    const pending = search.hits.filter((_, index) => comments[index] !== null && !isSettled(comments[index]));
    const reasons = [
      search.incompleteResults && 'the search reported incomplete results',
      search.total > search.hits.length && `the search found ${search.total} card(s) but returned ${search.hits.length}`,
      unread.length > 0 && `${unread.length} card(s) could not be read`,
    ].filter(Boolean);
    const cards = (label, numbers) => (numbers.length > 0 ? [`deferred cleanup ${label}: ${numbers.map((number) => `#${number}`).join(' ')}`] : []);
    return {
      incomplete: reasons.length > 0,
      lines: [
        `deferred cleanup: ${reasons.length > 0 ? `incomplete (${reasons.join('; ')})` : 'complete'}, ${search.hits.length} card(s) found, ${pending.length} pending`,
        ...cards('pending', pending),
        ...cards('unread', unread),
      ],
    };
  } catch {
    return { incomplete: true, lines: ['deferred cleanup: incomplete (the search failed), no card read'] };
  }
}

function readInventory(git) {
  const target = git(['rev-parse', 'refs/remotes/origin/main']).trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['branch', '--show-current']).trim();
  const status = git(['status', '--porcelain']);
  const worktrees = git(['worktree', 'list', '--porcelain']);
  const gitDirs = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split(/\r?\n/);
  if (gitDirs.length !== 2) throw new Error('git printed no git directory and common directory pair');
  return { target, head, branch, status, worktrees, linked: gitDirs[0] !== gitDirs[1] };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const parsed = parseArgs(args);
  if (parsed.refusal) {
    output.error(`resume-start: ${parsed.refusal}`);
    output.error(USAGE);
    return RESUME_START_EXIT.refused;
  }
  if (parsed.help) {
    output.log(RESUME_START_HELP);
    return RESUME_START_EXIT.ordinary;
  }
  const git = dependencies.git ?? runGit;
  const config = dependencies.config ?? boardConfig;
  const cleanupRead = dependencies.cleanupRead ?? ghStart;
  const intakeRead = dependencies.intake ?? runIntake;
  const pullRequestRead = dependencies.pullRequests ?? (() => ghStart(PULL_REQUEST_READ));
  const writeFile = dependencies.writeFile ?? writeFileSync;
  const stop = (code, step, detail) => {
    output.error(`resume-start: stopped at ${step}: ${detail}`);
    return code;
  };

  try {
    git(['fetch', '--no-prune', 'origin', 'main']);
  } catch (error) {
    return stop(RESUME_START_EXIT.fetch, 'the fetch', failureText(error));
  }
  let inventory;
  try {
    inventory = readInventory(git);
  } catch (error) {
    return stop(RESUME_START_EXIT.inventory, 'the local inventory', failureText(error));
  }
  const { target, head, branch, status, worktrees } = inventory;
  if (inventory.linked) return stop(RESUME_START_EXIT.linkedWorktree, 'the main checkout', 'this is a linked worktree, not the main checkout');
  if (branch !== 'main') return stop(RESUME_START_EXIT.offMain, 'the main checkout', `it is on ${branch || 'no branch'}, not main`);
  if (head !== target) return stop(RESUME_START_EXIT.notAtTarget, 'the main checkout', `HEAD ${head} is not the fetched commit ${target}`);
  if (status.trim()) return stop(RESUME_START_EXIT.changed, 'the main checkout', `it has ${pathCount(status)} changed or untracked path(s)`);

  const cardFolder = join(parsed.folder, 'intake');
  const documentPath = join(parsed.folder, 'board-intake.txt');
  const [intake, pullRequests, cleanup] = await Promise.all([intakeRead(cardFolder), pullRequestRead(), readDeferredCleanup(config, cleanupRead)]);
  if (intake.status !== INTAKE_EXIT.complete && intake.status !== INTAKE_EXIT.drift) {
    if (intake.stderr.trim()) output.error(intake.stderr.trimEnd());
    return stop(RESUME_START_EXIT.intake, 'the board intake', intake.status === null ? 'it did not run to an exit code' : `exit ${intake.status}, so the read is not complete`);
  }
  let pullRequestList;
  try {
    pullRequestList = pullRequests();
    if (!Array.isArray(JSON.parse(pullRequestList))) throw new Error('gh returned no JSON list');
  } catch (error) {
    return stop(RESUME_START_EXIT.pullRequests, 'the open pull request read', failureText(error));
  }

  // The recheck comes before anything is saved or printed: evidence read from a checkout that moved or
  // changed during the reads is never handed over.
  let headNow;
  let branchNow;
  let statusNow;
  try {
    headNow = git(['rev-parse', 'HEAD']).trim();
    branchNow = git(['branch', '--show-current']).trim();
    statusNow = git(['status', '--porcelain']);
  } catch (error) {
    return stop(RESUME_START_EXIT.recheck, 'the closing recheck', failureText(error));
  }
  if (headNow !== target) return stop(RESUME_START_EXIT.recheck, 'the closing recheck', `HEAD moved to ${headNow} from the fetched commit ${target} during the reads`);
  if (branchNow !== 'main') return stop(RESUME_START_EXIT.recheck, 'the closing recheck', `the checkout left main for ${branchNow || 'no branch'} during the reads`);
  if (statusNow.trim()) return stop(RESUME_START_EXIT.recheck, 'the closing recheck', `${pathCount(statusNow)} path(s) changed during the reads`);

  try {
    writeFile(documentPath, intake.stdout);
  } catch (error) {
    return stop(RESUME_START_EXIT.save, 'saving the intake document', failureText(error));
  }

  const body = [
    `fetched commit: ${target}`,
    `branch: ${branch}`,
    `HEAD: ${head}`,
    'status: no change',
    'worktrees:',
    worktrees.trimEnd(),
    'main checkout: on main at the fetched commit, no change',
    `board intake: exit ${intake.status}, document ${documentPath}, card files ${cardFolder}`,
    intake.stderr.trimEnd(),
    'board intake summary:',
    intake.stdout.trimEnd(),
    'open pull requests:',
    pullRequestList.trimEnd(),
    ...cleanup.lines,
    `recheck before saving: on main at HEAD ${headNow}, no change`,
  ].filter((part) => part !== '').join('\n');
  const lineCount = body.split('\n').length + 1;
  output.log(`${body}\nresume-start: end of document, ${lineCount} line(s).`);
  output.error(`resume-start: ${lineCount} line(s) on stdout.`);
  if (intake.status === INTAKE_EXIT.drift) return cleanup.incomplete ? RESUME_START_EXIT.driftAndCleanupIncomplete : RESUME_START_EXIT.drift;
  return cleanup.incomplete ? RESUME_START_EXIT.cleanupIncomplete : RESUME_START_EXIT.ordinary;
}
