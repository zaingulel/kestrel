// advance-approval.mjs — reads and judges an advance approval: a card comment whose whole body is
// `Approved: card=<n> edited=<the card's lastEditedAt, or none>`, which lets a pre-approved run deliver
// that card without a fresh yes only with explicit fetched-main preApprovedRun true. The board command's
// approval mode prints approvalReport's lines; the guard's publishCheck admits a pre-approved run session's
// push, create, ready or merge only for its own card in its own origin repository. GitHub issues only.
//
// Every read goes through one of two runners, each taking an argument list and returning stdout or
// throwing an error that carries the exit `status`: `git`, and `exec` for gh. The default runners
// spawn the executables gitExecutable and ghExecutable locate, with a 15 s timeout per read. A publish
// check makes at most ten reads, including three for the fetched-main setting, plus one to verify a native
// app job's worktree. Imports are Node built-ins, posix-shell.mjs and the leaf settings validator
// runtimes.mjs; loading them performs no settings read.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { ghExecutable, gitExecutable } from './posix-shell.mjs';
import { readSettingsHeader } from './runtimes.mjs';

export const RECORD_LINE = /^Approved: card=(\d+) edited=(\S+)$/;

export const recordLine = (card, edited) => `Approved: card=${card} edited=${edited}`;

const REFUSAL = 'a pre-approved run session ';
const RUN_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// One GraphQL reply carries up to 100 comment bodies; Node's 1 MiB default would refuse a valid read.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Comments come oldest first, and the read stops at 100 so a longer card is unavailable, never read in part.
const APPROVAL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      state
      title
      lastEditedAt
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { createdAt } } }
      comments(first: 100) { pageInfo { hasNextPage } nodes { author { login } createdAt lastEditedAt url body } }
    }
  }
}`;

// Pin one local fetched-main object so a ref moving between reads cannot mix settings versions.
export function requirePreApprovedRun({ git }) {
  let enabled = false;
  try {
    const oid = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('invalid fetched-main object');
    const mode = git(['ls-tree', '--full-tree', '--format=%(objectmode)', oid, '--', '.agents/factory-settings.json']).trim();
    if (mode) {
      if (mode !== '100644' && mode !== '100755') throw new Error('nonregular settings entry');
      const text = git(['show', `${oid}:.agents/factory-settings.json`]);
      enabled = readSettingsHeader(text, '.agents/factory-settings.json').settings.preApprovedRun === true;
    }
  } catch {
    // Child errors and validator refusals can contain credentials or untrusted settings values.
    throw new Error('pre-approved run setting unavailable on fetched main; fetch origin and verify .agents/factory-settings.json on main');
  }
  if (!enabled) throw Object.assign(new Error('pre-approved run disabled on fetched main; preApprovedRun must be true in .agents/factory-settings.json on main'), { code: 'PRE_APPROVED_RUN_DISABLED' });
}

const trackerLine = (tracker) => `advance approval needs GitHub issues; this repository's tracker is ${tracker}`;

// The runner throws on its first call, naming the missing executable, when the lookup found none.
function defaultRunner(file, name, { cwd, env }) {
  return (args) => {
    if (!file) throw new Error(`found no ${name} in an absolute PATH entry`);
    try {
      return execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: MAX_OUTPUT_BYTES });
    } catch (error) {
      throw Object.assign(new Error(error.stderr?.trim() || error.message), { status: error.status });
    }
  };
}

const isText = (value) => typeof value === 'string';
const isTime = (value) => value === null || isText(value);

// the one push destination, which must be the fetch URL, and the repository it names.
function originRepository({ git, exec }) {
  const pushUrls = git(['remote', 'get-url', '--push', '--all', 'origin']).split(/\r?\n/).filter(Boolean);
  const fetchUrl = git(['remote', 'get-url', 'origin']).trim();
  if (pushUrls.length !== 1 || pushUrls[0] !== fetchUrl) {
    throw new Error('origin does not have exactly one push destination matching the repository it fetches from');
  }
  let reply;
  try {
    reply = exec(['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', pushUrls[0]]);
  } catch (error) {
    const cause = error?.message;
    if (cause === 'found no gh.exe in an absolute PATH entry') {
      // Reconstruct the validated fixed reason because the child Error object remains untrusted.
      throw new Error(cause);
    }
    throw new Error('unreadable origin repository: the GitHub CLI lookup failed; check that gh is installed on PATH and can access the repository');
  }
  let repository;
  try {
    repository = JSON.parse(reply);
  } catch {
    throw new Error('unreadable origin repository: GitHub CLI returned invalid JSON');
  }
  const defaultBranch = repository?.defaultBranchRef?.name;
  if (!isText(repository?.id) || !/^\S+$/.test(repository.id) || !/^[^/\s]+\/[^/\s]+$/.test(repository?.nameWithOwner)
    || !isText(defaultBranch) || !/^\S+$/.test(defaultBranch)) {
    throw new Error(`unreadable origin repository: ${JSON.stringify(repository)}`);
  }
  return { id: repository.id, nameWithOwner: repository.nameWithOwner, defaultBranch };
}

// Returns { login, issue } for one card of `repository`, or throws when the reply is for another
// repository, is malformed, or has more comments than one read holds.
export function readApproval(card, { exec, repository }) {
  const [owner, name] = repository.nameWithOwner.split('/');
  const reply = JSON.parse(exec(['api', 'graphql', '-f', `query=${APPROVAL_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${card}`]));
  const answered = reply?.data?.repository;
  if (answered?.id !== repository.id) {
    throw new Error(`the approval read answered for repository ${JSON.stringify(answered?.id)}, not origin's ${repository.nameWithOwner}`);
  }
  const login = reply.data.viewer?.login;
  const issue = answered.issue;
  const wellFormed = isText(login) && isText(issue?.state) && isText(issue.title) && isTime(issue.lastEditedAt)
    && Array.isArray(issue.timelineItems?.nodes) && issue.timelineItems.nodes.every((event) => isText(event?.createdAt))
    && typeof issue.comments?.pageInfo?.hasNextPage === 'boolean' && Array.isArray(issue.comments.nodes)
    && issue.comments.nodes.every((comment) => isText(comment?.body) && isText(comment.createdAt) && isTime(comment.lastEditedAt) && isText(comment.url));
  if (!wellFormed) throw new Error(`unreadable approval read for card ${card} in ${repository.nameWithOwner}`);
  if (issue.comments.pageInfo.hasNextPage) throw new Error(`card ${card} has more than 100 comments, so its records cannot all be read`);
  return { login, issue };
}

// One report line for a card. The oldest valid record wins; `before`, a run's start, voids every
// record created at or after it, so nothing a run writes approves during that run. A line judged
// for a run (`run`) leaves out the record text, so no run is handed a record to post.
export function judgeApproval(card, { login, issue }, { before, run = false } = {}) {
  if (issue.state !== 'OPEN') return `not approved ${card}: the card is closed`;
  if (issue.title.startsWith('Proposed: ')) return `not approved ${card}: the card is still a proposal`;
  const record = recordLine(card, issue.lastEditedAt ?? 'none');
  const lastClose = Math.max(-Infinity, ...issue.timelineItems.nodes.map((event) => Date.parse(event.createdAt)));
  const records = issue.comments.nodes.filter((comment) => RECORD_LINE.test(comment.body.trimEnd()));
  const valid = records.find((comment) => {
    const created = Date.parse(comment.createdAt);
    return comment.body.trimEnd() === record && comment.lastEditedAt === null && comment.author?.login === login
      && created > lastClose && (before === undefined || created < Date.parse(before));
  });
  if (valid) return `approved ${card} ${valid.createdAt} ${valid.url}`;
  return `not approved ${card}: ${records.length ? 'no valid record' : 'no record'}${run ? '' : `; post: ${record}`}`;
}

// Exit 0 for completed approval judgements, including known-disabled settings without a GitHub read;
// 2 when the setting, tracker or a card is unavailable. Check the setting once before any origin/GitHub read.
export function approvalReport(cards, { exec, git, before, run, tracker, repository } = {}) {
  if (tracker !== 'github') return { lines: [trackerLine(tracker)], exitCode: 2 };
  let runners;
  let origin = repository;
  try {
    runners = {
      exec: exec ?? defaultRunner(ghExecutable(), 'gh.exe', {}),
      git: git ?? defaultRunner(gitExecutable(), 'git.exe', {}),
    };
    try {
      requirePreApprovedRun({ git: runners.git });
    } catch (error) {
      const disabled = error.code === 'PRE_APPROVED_RUN_DISABLED';
      return {
        lines: cards.map((card) => `${disabled ? 'not approved' : 'unavailable'} ${card}: ${error.message}`),
        exitCode: disabled ? 0 : 2,
        settingRefusal: error.message,
      };
    }
    origin ??= originRepository(runners);
  } catch (error) {
    return { lines: cards.map((card) => `unavailable ${card}: ${error.message}`), exitCode: 2 };
  }
  const lines = cards.map((card) => {
    try {
      return judgeApproval(card, readApproval(card, { exec: runners.exec, repository: origin }), { before, run });
    } catch (error) {
      return `unavailable ${card}: ${error.message}`;
    }
  });
  return { lines, exitCode: lines.some((line) => line.startsWith('unavailable ')) ? 2 : 0 };
}

// The guard's judgement of one publish segment in a pre-approved run session, after its own
// refusals: '' admits it, so the guard's other rules still judge it, and any other string refuses.
// `kind` is push, create, ready or merge, and a ready or merge segment is already its delivery form.
export function publishCheck(kind, segment, { start, tracker, appJob, env = process.env, exec, git, platform = process.platform, exists = existsSync, cwd }) {
  const refuse = (why) => `${REFUSAL}${why}`;
  if (tracker !== 'github') return refuse(`publishes nothing: ${trackerLine(tracker)}`);
  const named = ['GH_REPO', 'GH_HOST'].find((name) => env[name] !== undefined);
  if (named) return refuse(`publishes nothing with ${named} set: gh would act on what it names, not on origin`);
  if (!RUN_START.test(start) || Number.isNaN(Date.parse(start))) {
    return refuse(`publishes nothing: its mark ${JSON.stringify(start)} is not a run start written YYYY-MM-DDTHH:MM:SSZ`);
  }
  try {
    const lookup = { platform, env, exists };
    const runners = {
      git: git ?? defaultRunner(gitExecutable(lookup), 'git.exe', { cwd, env }),
      exec: exec ?? defaultRunner(ghExecutable(lookup), 'gh.exe', { cwd, env }),
    };
    const head = runners.git(appJob ? ['symbolic-ref', '--quiet', 'HEAD'] : ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    if (appJob && head !== `refs/heads/job/${appJob.card}`) return refuse('publishes only its bound card');
    const card = appJob ? String(appJob.card) : /^job\/([1-9]\d*)$/.exec(head)?.[1];
    if (!card) return refuse(`publishes only from a job branch, and HEAD is ${JSON.stringify(head)}`);
    const pushes = [`git push -u origin job/${card}`, `git push --force-with-lease origin job/${card}`];
    if (kind === 'push' && !pushes.includes(segment)) return refuse(`pushes only its own branch, as ${pushes.join(' or ')}`);
    if (appJob) {
      try {
        const topLevel = runners.git(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
        if (realpathSync.native(topLevel) !== appJob.worktree) return refuse('publishes only from its bound worktree');
      } catch {
        return refuse('could not verify its bound worktree');
      }
    }
    const origin = originRepository(runners);
    const acting = JSON.parse(runners.exec(['repo', 'view', '--json', 'id']));
    if (acting?.id !== origin.id) return refuse(`publishes only where gh acts on origin, ${origin.nameWithOwner}, and here it acts on ${JSON.stringify(acting?.id)}`);
    // Read 6 (7 for a native app job) is the push refspecs, the merge base for a create or the pull request
    // for a ready or merge. Git exits 1 with no output where the key is unset; any other failure refuses.
    if (kind === 'push') {
      let refspecs = '';
      try {
        refspecs = runners.git(['config', '--get-all', 'remote.origin.push']).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      if (refspecs) return refuse(`pushes nothing while remote.origin.push is set, since it can send the push to another branch: ${refspecs.split(/\r?\n/).join(', ')}`);
    }
    if (kind === 'create') {
      let mergeBase;
      try {
        mergeBase = runners.git(['config', '--get', `branch.job/${card}.gh-merge-base`]).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      if (mergeBase !== undefined) return refuse(`opens a pull request only into the default branch, and branch.job/${card}.gh-merge-base is set: ${mergeBase}`);
    }
    if (kind === 'ready' || kind === 'merge') {
      const number = /\d+/.exec(segment)[0];
      const pr = JSON.parse(runners.exec(['pr', 'view', number, '--json', 'state,headRefName,baseRefName,headRepository,isCrossRepository']));
      if (pr?.state !== 'OPEN' || pr.headRefName !== `job/${card}` || pr.headRepository?.id !== origin.id || pr.isCrossRepository !== false) {
        return refuse(`acts only on its own job pull request: #${number} is not open from job/${card} in ${origin.nameWithOwner}`);
      }
      if (pr.baseRefName !== origin.defaultBranch) {
        return refuse(`acts only on its own job pull request into the default branch: #${number} targets ${pr.baseRefName}, not ${origin.defaultBranch}`);
      }
      // Taking its own pull request back to draft needs no record, so a revoked record can still stop it.
      if (/(?:^|\s)--undo(?:\s|$)/.test(segment)) return '';
    }
    const report = approvalReport([card], { exec: runners.exec, git: runners.git, before: start, run: true, tracker, repository: origin });
    if (report.settingRefusal) return refuse(`publishes nothing: ${report.settingRefusal}`);
    if (report.exitCode === 0 && report.lines[0].startsWith('approved ')) return '';
    return refuse(`found no valid advance approval (check exit ${report.exitCode}): ${report.lines.join('; ')}`);
  } catch (error) {
    return refuse(`publishes nothing: ${error.message}`);
  }
}
