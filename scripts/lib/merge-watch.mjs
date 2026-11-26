// merge-watch.mjs — watches one pull request until it merges or can no longer merge unattended, or waits for one to open on a branch.
//
// Waits on GitHub events, not a timer: it starts one `gh webhook forward` (the `cli/gh-webhook` extension, which needs admin access to the repository) that creates one forwarding webhook on the watched repository, and ends it, with only the hook ID it recorded, when the watch ends. Every other `gh` call reads repository identity, pull request state or timeline, branch protection, rulesets, checks, workflow runs or their jobs.
// `gh pr checks --required` lists a check only once GitHub has created its run, so the full
// required set is read first, from the base branch's classic protection and every page of its
// rules; a required name the checks have not listed yet counts as `unreported`. So does a failed
// required check while a newer run of the same workflow on the same head commit has not finished,
// because that run will report the check again. The first `gh`
// failure stops the watch with no retry and no further read, and so does a successful reply it cannot read: a
// required-check list that is not a list of names, a pull request state or merge state it does not know,
// a required check without a known bucket, a timeline that is not pages of events or has a ready event without a time,
// or a workflow run, run list or job without the fields the watch compares or with a status GitHub does not document.
// A relevant event wakes one pass; between events the watch reads nothing. A pass that finds the merge state unknown after an
// event, or blocked with every required check passed while an auto-merge is queued, opens four settle times, 5, 15, 35 and 74 seconds after it; a settle read more than a second late is skipped, so
// none starts past 75 seconds, and an event read in between spends none of them. The earliest of the two stall stops is the one local deadline: no workflow run created since the
// pull request was last marked ready has been unfinished on the head commit while a required check has not reported, for 10 minutes, or a job of such an
// unfinished run queued with no runner for 15 minutes. A pull request that was never a draft counts every run. Both
// clocks run on the watch's own clock from its first observation of the stall, so GitHub's clock and this machine's
// never meet; the caller's runtime otherwise waits on the process itself.
// The draft wait binds its branch and repository provenance to origin, reading every 30 seconds, with the same gh-failure and unreadable-reply stops.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { ghArgvPrefix } from './gh-exec.mjs';
import { parseRequiredReports, readRequiredSet, requiredCheckArgs } from './merge-evidence.mjs';
import { isCanonicalLeadFolder, readManagedRecord } from './pre-approved-run.mjs';

export const WATCH_INTERVAL_MS = 30_000;

// The pull request states and GitHub's MergeStateStatus values.
const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const MERGE_STATES = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);

// gh's own wording when no check at all has reported on the branch yet.
const NOTHING_REPORTED = 'checks reported on the';

// The text gh printed, on one line so it can stand as the watch's last line of output.
function failureText(err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
  return text.replace(/\s*\n\s*/g, ' ');
}

// A check's link names its Actions run; a check from outside Actions has no such link.
const ACTIONS_RUN_LINK = /\/actions\/runs\/(\d+)(?:\/|$)/;

// The workflow run statuses GitHub reports before a run completes.
const UNFINISHED_RUN_STATUSES = new Set(['requested', 'queued', 'pending', 'waiting', 'in_progress']);

// Every workflow run status and job status GitHub documents; any other string is an unreadable reply.
const RUN_STATUSES = new Set([
  ...UNFINISHED_RUN_STATUSES,
  'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out',
]);
const JOB_STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);

// True when a newer run of the failed check's own workflow on the same head commit has not finished,
// so the check will be reported again. `run_number` rises with each new run of one workflow.
function supersededByNewerRun(link, ghExec) {
  const runId = ACTIONS_RUN_LINK.exec(link)?.[1];
  if (runId === undefined) return false;
  const { workflow_id, run_number, head_sha } = JSON.parse(ghExec(['api', `repos/{owner}/{repo}/actions/runs/${runId}`]));
  if (!Number.isInteger(workflow_id) || !Number.isInteger(run_number) || !/^[0-9a-f]{40}$/.test(head_sha)) {
    throw new Error(`unreadable workflow run ${runId}: ${JSON.stringify({ workflow_id, run_number, head_sha })}`);
  }
  const { workflow_runs } = JSON.parse(
    ghExec(['api', `repos/{owner}/{repo}/actions/workflows/${workflow_id}/runs?head_sha=${head_sha}`]),
  );
  if (
    !Array.isArray(workflow_runs)
    || !workflow_runs.every((run) => Number.isInteger(run?.run_number) && typeof run.status === 'string')
  ) {
    throw new Error(`unreadable workflow runs: ${JSON.stringify(workflow_runs ?? null)}`);
  }
  return workflow_runs.some((run) => run.run_number > run_number && UNFINISHED_RUN_STATUSES.has(run.status));
}

// One bucket per reported required check, plus `unreported` for each required name not listed yet. A
// failed check superseded by a newer unfinished run of its workflow counts as `unreported` too.
function readRequiredBuckets(pr, required, ghExec) {
  let output;
  try {
    output = ghExec(requiredCheckArgs(pr));
  } catch (err) {
    if (!failureText(err).includes(NOTHING_REPORTED)) throw err;
    return required.size === 0 ? [] : ['unreported'];
  }
  const { checks, unreported } = parseRequiredReports(output, required);
  const buckets = checks.map((check) => (
    check.bucket === 'fail' && supersededByNewerRun(check.link, ghExec) ? 'unreported' : check.bucket
  ));
  return [...unreported.map(() => 'unreported'), ...buckets];
}

// A run or job time as milliseconds; NaN unless GitHub sent a parseable string.
const timeOf = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);

const NO_RUN_LIMIT_MS = 10 * 60_000;
const QUEUED_JOB_LIMIT_MS = 15 * 60_000;

// The items under `key` of every page of a `--paginate --slurp` reply.
function flattenPages(pages, key, what) {
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page?.[key]))) {
    throw new Error(`unreadable ${what}: ${JSON.stringify(pages)}`);
  }
  return pages.flatMap((page) => page[key]);
}

// The latest time the pull request was marked ready for review, as milliseconds, or null when it never was a draft.
function readReadyTime(pr, ghExec) {
  const pages = JSON.parse(ghExec(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`]));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`unreadable pull request timeline: ${JSON.stringify(pages)}`);
  }
  const ready = pages.flat().filter((event) => event?.event === 'ready_for_review');
  if (ready.some((event) => Number.isNaN(timeOf(event.created_at)))) {
    throw new Error(`unreadable pull request timeline: ${JSON.stringify(pages)}`);
  }
  return ready.length === 0 ? null : Math.max(...ready.map((event) => timeOf(event.created_at)));
}

function readRuns(head, ghExec) {
  const pages = JSON.parse(ghExec(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100`]));
  const runs = flattenPages(pages, 'workflow_runs', `workflow runs on ${head}`);
  for (const run of runs) {
    if (!Number.isInteger(run?.id) || !RUN_STATUSES.has(run.status) || Number.isNaN(timeOf(run.created_at))) {
      throw new Error(`unreadable workflow run on ${head}: ${JSON.stringify(run)}`);
    }
  }
  return runs;
}

function readJobs(runId, ghExec) {
  const pages = JSON.parse(ghExec(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`]));
  const jobs = flattenPages(pages, 'jobs', `jobs of workflow run ${runId}`);
  for (const job of jobs) {
    if (
      !Number.isInteger(job?.id) || typeof job.name !== 'string' || !JOB_STATUSES.has(job.status)
      || !Array.isArray(job.labels) || !job.labels.every((label) => typeof label === 'string')
      || !(job.runner_name === null || typeof job.runner_name === 'string')
    ) {
      throw new Error(`unreadable job of workflow run ${runId}: ${JSON.stringify(job)}`);
    }
  }
  return jobs;
}

// The two stall clocks of one watch. `check` runs on a pass of an open, non-draft pull request that is about to
// wait, with that pass's required-check buckets, and returns the reason to stop, or undefined while neither limit has
// run out. Only runs created since the pull request was last marked ready count, which the timeline gives once per
// head commit. The no-run clock runs only while a required check is unreported and no counted run on the head commit
// is unfinished. A new head commit starts both clocks over, and so does `clear`, which a draft pass and a settling pass call.
// `nextDeadline` is the clock time at which the earlier limit runs out, or undefined while neither clock runs.
function createStallWatch(pr, ghExec, now) {
  let head;
  let readyAt;
  let noRunSince;
  let queuedSince;
  const start = (nextHead) => {
    head = nextHead;
    readyAt = undefined;
    noRunSince = undefined;
    queuedSince = new Map();
  };
  start(undefined);
  return {
    clear: () => start(undefined),
    check(currentHead, buckets) {
      const time = now();
      if (currentHead !== head) start(currentHead);
      if (readyAt === undefined) readyAt = readReadyTime(pr, ghExec);
      const unfinished = readRuns(head, ghExec)
        .filter((run) => readyAt === null || timeOf(run.created_at) >= readyAt)
        .filter((run) => UNFINISHED_RUN_STATUSES.has(run.status));
      if (buckets.includes('unreported') && unfinished.length === 0) {
        noRunSince ??= time;
        if (time - noRunSince >= NO_RUN_LIMIT_MS) {
          return `no test run has started for ${head} within 10 minutes: mark the pull request as a draft, mark it ready again, then merge it again, since returning to draft cancels any queued merge`;
        }
      } else {
        noRunSince = undefined;
      }
      const waiting = unfinished
        .flatMap((run) => readJobs(run.id, ghExec))
        .filter((job) => job.status === 'queued' && (job.runner_name === null || job.runner_name === ''));
      queuedSince = new Map(waiting.map((job) => [job.id, queuedSince.get(job.id) ?? time]));
      const stalled = waiting.find((job) => time - queuedSince.get(job.id) >= QUEUED_JOB_LIMIT_MS);
      if (stalled) {
        const labels = stalled.labels.filter((label) => label.trim() !== '');
        const needs = labels.length === 0 ? 'waits for a runner, but GitHub reported no runner labels' : `waits for a runner labelled ${labels.join(', ')}`;
        return `a test job has waited 15 minutes for a machine: ${stalled.name} ${needs}`;
      }
      return undefined;
    },
    nextDeadline() {
      const limits = [...queuedSince.values()].map((since) => since + QUEUED_JOB_LIMIT_MS);
      if (noRunSince !== undefined) limits.push(noRunSince + NO_RUN_LIMIT_MS);
      return limits.length === 0 ? undefined : Math.min(...limits);
    },
  };
}

// Settle times: after an event's read finds the merge state UNKNOWN, or any read finds it BLOCKED with every required
// check passed and an auto-merge queued, reads this long after that read, while GitHub works out whether the pull
// request can merge or its queued auto-merge lands. A settle read that would start more than SETTLE_LATE_MS after
// its time is skipped, so every settle read starts within 75 seconds of the anchor read.
export const SETTLE_AFTER_MS = [5_000, 15_000, 35_000, 74_000];
const SETTLE_LATE_MS = 1_000;

// Resolves to { exitCode, reason }: 0 only when the pull request merged, 1 for every other stop. Given
// `coordinated.head`, the armed head of a held Claude delivery, whose job runs its own pinned merge, it instead ends 0
// once the pull request is open at that head with every required check passed or skipped, and 1 once it is no longer
// open at that head; it never ends 0 on a merge. After its first pass
// the watch reads only when `nextWake` reports a relevant event or the deadline it was given: the earlier stall limit,
// or the next settle time. A read finding BLOCKED with every required check passed and an auto-merge queued, or an
// event's read finding the merge state UNKNOWN, opens a settle sequence, anchored at that read; an event during it reads
// as usual and spends no settle time. A deadline wake spends every settle time that has passed with at most one read,
// made only when it is not late; once all four are spent with the merge state still settling the watch stops with the
// reason for that state. Any read finding another known merge state closes the sequence.
export async function watchMerge({ pr, ghExec, now, nextWake, coordinated = /** @type {CoordinatedWatch | undefined} */ (undefined) }) {
  const held = coordinated?.head;
  try {
    const { baseRefName } = JSON.parse(ghExec(['pr', 'view', pr, '--json', 'baseRefName']));
    const { classic, ruled } = readRequiredSet(baseRefName, ghExec);
    if (ruled.some((entry) => typeof entry !== 'string')) {
      return {
        exitCode: 1,
        reason: `a ruleset requires checks it does not name, so the full required set is unknown: ${JSON.stringify(ruled)}`,
      };
    }
    const required = new Set([...classic, ...ruled]);
    const stall = createStallWatch(pr, ghExec, now);
    let woken = 'start';
    /** @type {{ anchor: number, spent: number } | undefined} */
    let settle;
    for (;;) {
      const readAt = now();
      const { state, mergeStateStatus, headRefOid, autoMergeRequest } = JSON.parse(
        ghExec(['pr', 'view', pr, '--json', 'state,mergeStateStatus,headRefOid,autoMergeRequest']),
      );
      if (
        !PR_STATES.has(state) || !MERGE_STATES.has(mergeStateStatus) || !/^[0-9a-f]{40}$/.test(headRefOid)
        || !(autoMergeRequest === null || (typeof autoMergeRequest === 'object' && !Array.isArray(autoMergeRequest)))
      ) {
        return {
          exitCode: 1,
          reason: `unreadable pull request state: ${JSON.stringify({ state, mergeStateStatus, headRefOid, autoMergeRequest })}`,
        };
      }
      if (held !== undefined && (state !== 'OPEN' || headRefOid !== held)) {
        return { exitCode: 1, reason: `the pull request is no longer open at its armed head ${held}: ${state} at ${headRefOid}` };
      }
      if (state === 'MERGED') return { exitCode: 0, reason: 'merged' };
      if (state === 'CLOSED') return { exitCode: 1, reason: 'closed without merging' };
      const buckets = readRequiredBuckets(pr, required, ghExec);
      const view = `${state} ${mergeStateStatus}`;
      if (buckets.includes('fail')) return { exitCode: 1, reason: `a required check failed: ${buckets.join(' ')}` };
      if (mergeStateStatus === 'DIRTY' || mergeStateStatus === 'BEHIND') {
        return { exitCode: 1, reason: `merge blocked: ${view}` };
      }
      if (held !== undefined && buckets.every((bucket) => bucket === 'pass' || bucket === 'skipping')) {
        return { exitCode: 0, reason: `required checks passed on ${held}` };
      }
      const blockedFinished = mergeStateStatus === 'BLOCKED' && !buckets.some((bucket) => bucket === 'pending' || bucket === 'unreported');
      const blockedStop = { exitCode: 1, reason: `merge blocked with every required check finished: ${view} ${buckets.join(' ')}`.trimEnd() };
      const settling = blockedFinished && autoMergeRequest !== null && buckets.every((bucket) => bucket === 'pass' || bucket === 'skipping');
      if (blockedFinished && !settling) return blockedStop;
      if (mergeStateStatus === 'DRAFT' || settling) {
        stall.clear();
      } else {
        const stalled = stall.check(headRefOid, buckets);
        if (stalled !== undefined) return { exitCode: 1, reason: stalled };
      }
      const settleOut = settling ? blockedStop : {
        exitCode: 1,
        reason: `GitHub had not worked out whether the pull request can merge 75 seconds after settling began: ${view}; run the watch again`,
      };
      if (!settling && mergeStateStatus !== 'UNKNOWN') {
        settle = undefined;
      } else if (settle === undefined && (settling || woken === 'event')) {
        settle = { anchor: readAt, spent: 0 };
      }
      if (settle?.spent === SETTLE_AFTER_MS.length) return settleOut;
      // Waits for a wake that reads: a deadline wake whose settle read would be late spends its settle times unread.
      for (;;) {
        const deadlines = [stall.nextDeadline(), settle && settle.anchor + SETTLE_AFTER_MS[settle.spent]]
          .filter((deadline) => deadline !== undefined);
        const next = await nextWake({
          deadline: deadlines.length === 0 ? undefined : Math.min(...deadlines),
          context: { pr, base: baseRefName, head: headRefOid },
        });
        if (next.wake === 'ended') return { exitCode: 1, reason: next.reason };
        woken = next.wake;
        if (woken !== 'deadline' || settle === undefined) break;
        const time = now();
        const spentBefore = settle.spent;
        while (settle.spent < SETTLE_AFTER_MS.length && settle.anchor + SETTLE_AFTER_MS[settle.spent] <= time) settle.spent += 1;
        if (settle.spent === spentBefore || time <= settle.anchor + SETTLE_AFTER_MS[settle.spent - 1] + SETTLE_LATE_MS) break;
        if (settle.spent === SETTLE_AFTER_MS.length) return settleOut;
      }
    }
  } catch (err) {
    return { exitCode: 1, reason: failureText(err) };
  }
}

// Resolves to { exitCode, reason }: 0 with the number once exactly one origin-owned pull request is open on `head`,
// 1 for every other stop. An empty list keeps the wait going.
export async function watchDraft({ head, gitExec, ghExec, sleep }) {
  let operation = 'read origin remote';
  try {
    const origin = gitExec(['remote', 'get-url', 'origin']).trim();
    if (!origin || /[\r\n]/.test(origin)) {
      return { exitCode: 1, reason: 'unreadable origin remote URL' };
    }
    operation = 'read origin repository';
    const repositoryReply = ghExec(['repo', 'view', '--json', 'id', '--', origin]);
    let repository;
    try {
      repository = JSON.parse(repositoryReply);
    } catch {
      return { exitCode: 1, reason: 'unreadable origin repository: GitHub CLI returned invalid JSON' };
    }
    if (!repository || Array.isArray(repository) || typeof repository.id !== 'string' || !repository.id || /\s/.test(repository.id)) {
      return { exitCode: 1, reason: `unreadable origin repository: ${JSON.stringify(repository)}` };
    }
    for (;;) {
      operation = 'list origin pull requests';
      const listReply = ghExec(['pr', 'list', '--repo', origin, '--head', head, '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository']);
      let open;
      try {
        open = JSON.parse(listReply);
      } catch {
        return { exitCode: 1, reason: 'unreadable pull request list: GitHub CLI returned invalid JSON' };
      }
      if (!Array.isArray(open) || !open.every((pr) => Number.isInteger(pr?.number) && pr.number > 0)) {
        return { exitCode: 1, reason: `unreadable pull request list: ${JSON.stringify(open)}` };
      }
      if (!open.every((pr) => pr.state === 'OPEN' && pr.headRefName === head
        && pr.headRepository?.id === repository.id && pr.isCrossRepository === false)) {
        return { exitCode: 1, reason: `foreign or unverified pull request on ${head}: ${JSON.stringify(open)}` };
      }
      if (open.length === 1) return { exitCode: 0, reason: String(open[0].number) };
      if (open.length > 1) {
        return { exitCode: 1, reason: `more than one open pull request on ${head}: ${open.map((pr) => pr.number).join(' ')}` };
      }
      operation = 'wait for an origin pull request';
      await sleep(WATCH_INTERVAL_MS);
    }
  } catch {
    return { exitCode: 1, reason: `could not ${operation}; check Git and GitHub CLI installation, repository access and configuration` };
  }
}

// The event route: a `gh webhook forward` forwarder (cli/gh-webhook) whose stdout lines wake the watch. GitHub lists
// the forward's hook exactly as long as the extension process runs, so cleanup is ending that process tree, and a
// DELETE is only the backstop, always of the hook id this machine recorded while its own forwarder ran. The record
// names this watch, its gh launcher and the extension by pid and creation time, so a later start can end a crashed
// watch's orphan by identity, never by a bare pid. Payload lines are wake signals only: never printed or stored.

const FORWARD_EVENTS = 'pull_request,push,check_run,status,workflow_job';
const FORWARD_NOTICE = 'Forwarding Webhook events from GitHub';
const FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const HOOK_TIME = /^[0-9][0-9TZ:.+-]*$/;
const NOTICE_LIMIT_MS = 30_000;
const NOTICE_POLL_MS = 250;
const RELIST_MS = 1_000;
const ACTIVE_RELISTS = 5;
const CLEANUP_RELISTS = 5;
const RECOVERY_RELISTS = 10;
const KILL_AFTER_MS = 5_000;
const END_POLL_MS = 100;
const TABLE_MAX_BYTES = 64 * 1024 * 1024;
const LINE_MAX_BYTES = 32 * 1024 * 1024;
const INSTALL_EXTENSION = 'install it with `gh extension install cli/gh-webhook`, then run the watch again';
const GH_MISSING = 'the GitHub CLI `gh` is not installed or not on PATH; install it, then run the watch again';

// `lstart` is fixed-width to the second on procps and BSD `ps`; the C locale and UTC keep it the same in every reader.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s?(.*)$/;
// A fixed command with no interpolated input.
const WINDOWS_PROCESS_TABLE = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';

const messageOf = (err) => String(err instanceof Error ? err.message : err).replace(/\s*\n\s*/g, ' ').trim();
const identityOf = ({ pid, started }) => ({ pid, started });
const isIdentity = (value) => Number.isInteger(value?.pid) && value.pid > 0 && typeof value.started === 'string' && value.started !== '';

function readPosixTable() {
  const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], {
    encoding: 'utf8',
    maxBuffer: TABLE_MAX_BYTES,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const match = PS_ROW.exec(line);
    // The row itself is never quoted: another process's arguments may hold a secret.
    if (!match) throw new Error('unreadable process table: a ps row did not parse');
    return { pid: Number(match[1]), ppid: Number(match[2]), started: match[3].replace(/\s+/g, ' '), args: match[4] };
  });
}

function readWindowsTable() {
  const parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE], {
    encoding: 'utf8',
    maxBuffer: TABLE_MAX_BYTES,
    windowsHide: true,
  }));
  const rows = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const created = item?.CreationDate;
    // A process with no creation date, such as the idle process, can match no recorded identity.
    if (created === null) continue;
    const started = typeof created === 'object' ? created?.value : created;
    if (!Number.isInteger(item?.ProcessId) || !Number.isInteger(item.ParentProcessId) || typeof started !== 'string'
      || !(item.CommandLine === null || typeof item.CommandLine === 'string')) {
      throw new Error('unreadable process table: a Win32_Process row did not parse');
    }
    rows.push({ pid: item.ProcessId, ppid: item.ParentProcessId, started, args: item.CommandLine ?? '' });
  }
  return rows;
}

// True when a table row's arguments are those of the role: a merge watch, the gh `webhook forward` launcher or the
// extension's `forward`, both on this repository.
function argsFit(role, args, full) {
  const words = args.split(/\s+/);
  if (role === 'watch') return words.some((word) => word.includes('merge-watch'));
  const forRepo = words.some((word, index) => word === '--repo' && words[index + 1] === full);
  if (role === 'launcher') return forRepo && words.some((word, index) => word === 'webhook' && words[index + 1] === 'forward');
  return forRepo && words.includes('forward') && args.includes('gh-webhook');
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

// Starts gh as one process tree: on Linux and macOS gh leads a new process group its extension joins, stopped by
// signalling the group, TERM then KILL after 5 s; on Windows `taskkill /T` ends gh and its child while gh has not
// exited. Resolves once the
// process has started; `onExit` runs when every process holding its output has ended.
export function spawnTree(args, { onStdout, onStderr, onExit }, platform, env = process.env) {
  const [command, ...prefix] = ghArgvPrefix();
  const child = spawn(command, [...prefix, ...args], { detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).on('line', onStdout);
  createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stderr) }).on('line', onStderr);
  let ended = false;
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      ended = true;
      onExit(code ?? signal);
      resolve(undefined);
    });
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      const pid = /** @type {number} */ (child.pid);
      const stop = async () => {
        if (ended) return;
        if (platform === 'win32') {
          // Once gh has exited, Windows may give its pid to another process, so taskkill runs only while gh runs.
          if (child.exitCode !== null || child.signalCode !== null) return;
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          await closed;
          return;
        }
        signalPid(-pid, 'SIGTERM');
        const kill = setTimeout(() => signalPid(-pid, 'SIGKILL'), KILL_AFTER_MS);
        await closed;
        clearTimeout(kill);
      };
      resolve({ pid, stop });
    });
  });
}

// Ends one process a crashed watch left, given its matched table row: TERM then KILL after 5 s, or `taskkill /T` on
// Windows. Its identity is re-read from the table immediately before each signal and the taskkill; a process that no
// longer matches is left alone.
async function endMatching(target, platform, readTable, sleep) {
  const matches = () => readTable().some((row) => row.pid === target.pid && row.started === target.started && row.args === target.args);
  if (!matches()) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  signalPid(target.pid, 'SIGTERM');
  for (let waited = 0; waited < KILL_AFTER_MS; waited += END_POLL_MS) {
    await sleep(END_POLL_MS);
    if (!isRunning(target.pid)) return;
  }
  if (matches()) signalPid(target.pid, 'SIGKILL');
}

export function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME;
  return join(base && isAbsolute(base) ? base : join(homedir(), '.local', 'state'), 'fabraik-merge-watch');
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A forward's line carries no event name, so the event is inferred from the payload's shape, after GitHub's webhook
// payload reference, in this order: a ping; a check run, relevant once completed on the head; a workflow job on the
// head; this pull request; a push to the base branch; a commit status on the head. Any other shape is irrelevant.
export function isRelevantEvent(payload, { pr, base, head }) {
  if (!isObject(payload)) return false;
  if ('zen' in payload && 'hook_id' in payload) return false;
  if (isObject(payload.check_run)) return payload.action === 'completed' && payload.check_run.head_sha === head;
  if (isObject(payload.workflow_job)) return payload.workflow_job.head_sha === head;
  if (isObject(payload.pull_request) && 'number' in payload) return payload.number === Number(pr);
  if ('ref' in payload && 'before' in payload && 'after' in payload) return payload.ref === `refs/heads/${base}`;
  if ('sha' in payload && 'state' in payload && 'context' in payload) return payload.sha === head;
  return false;
}

const watchRecordPath = (stateDir, repo) => join(stateDir, `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json`);

function readWatchRecord(recordPath, full, coordinated) {
  let record;
  try {
    record = coordinated ? readManagedRecord(recordPath) : JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    if (coordinated && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
  }
  if (!isObject(record) || !isIdentity(record.watch)
    || ![record.launcher, record.forwarder].every((entry) => entry === null || isIdentity(entry))
    || !(record.hookId === null || (Number.isInteger(record.hookId) && record.hookId > 0))) {
    throw new Error(`unreadable merge watch record ${recordPath}; once no merge watch for ${full} runs, delete it and run the watch again`);
  }
  return record;
}

const runningAs = (role, identity, rows, full) =>
  rows.find((row) => row.pid === identity.pid && row.started === identity.started && argsFit(role, row.args, full));

// Undefined proves absence. False identifies a retained record whose original watcher has already ended.
export function coordinatedWatchIsLive(stateDir, repo, readTable = readPosixTable) {
  const record = readWatchRecord(watchRecordPath(stateDir, repo), repo, true);
  return record === undefined ? undefined : Boolean(runningAs('watch', record.watch, readTable(), repo));
}

/** @typedef {{ repo: string, beforeForward: () => Promise<void>, head?: string }} CoordinatedWatch */

// The watched repository, its hook helpers and its watch record in a private state directory, with `recover`, which
// clears a retained record. Reads the repository's name unless `coordinated` names it.
function watchRecovery({
  ghExec, stateDir = defaultStateDir(), sleep = delay, platform = process.platform,
  readProcessTable: readTable = () => (platform === 'win32' ? readWindowsTable() : readPosixTable()),
  endProcess: end = (target) => endMatching(target, platform, readTable, sleep),
  coordinated = /** @type {CoordinatedWatch | undefined} */ (undefined),
}) {
  const gh = (args) => {
    try {
      return ghExec(args);
    } catch (err) {
      throw new Error(/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' ? GH_MISSING : failureText(err));
    }
  };
  const parse = (text, what) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`unreadable ${what}`);
    }
  };
  const table = () => {
    try {
      return readTable();
    } catch (err) {
      throw new Error(`could not read the process table: ${messageOf(err)}`);
    }
  };

  const full = coordinated?.repo ?? parse(gh(['api', 'repos/{owner}/{repo}']), 'repository')?.full_name;
  if (typeof full !== 'string' || !FULL_NAME.test(full)) throw new Error(`unreadable repository name: ${JSON.stringify(full ?? null)}`);
  const hooksPath = `repos/${full}/hooks`;

  const listHooks = () => {
    const pages = parse(gh(['api', '--paginate', '--slurp', `${hooksPath}?per_page=100`]), `hook list for ${full}`);
    // The reply is never quoted: another hook's configuration is not this watch's to print.
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`unreadable hook list for ${full}`);
    const hooks = pages.flat();
    if (!hooks.every((hook) => Number.isInteger(hook?.id) && hook.id > 0 && typeof hook.name === 'string'
      && typeof hook.active === 'boolean' && typeof hook.created_at === 'string' && HOOK_TIME.test(hook.created_at))) {
      throw new Error(`unreadable hook list for ${full}`);
    }
    return hooks;
  };
  const forwardingHooks = () => listHooks().filter((hook) => hook.name === 'cli');
  const unprovedHook = ({ id, created_at }) => `a forwarding webhook ${id} (created ${created_at}) is on ${full} and no merge watch on this machine can prove it its own; it goes when the forward holding it ends: end that forward (here, a leftover \`gh-webhook forward\` process), or if none runs anywhere delete it with \`gh api -X DELETE ${hooksPath}/${id}\`, then run the watch again`;
  // Lists, re-lists while the recorded hook stays, then deletes it, only while it is listed as a forwarding hook;
  // GitHub's 404 means it is already gone. A recorded id listed as another kind of hook is never deleted.
  const removeHook = async (id, relists, cause) => {
    let hook;
    try {
      const listed = () => listHooks().find((entry) => entry.id === id);
      hook = listed();
      for (let count = 0; hook?.name === 'cli' && count < relists; count += 1) {
        await sleep(RELIST_MS);
        hook = listed();
      }
      if (hook?.name === 'cli') {
        try {
          gh(['api', '-X', 'DELETE', `${hooksPath}/${id}`]);
        } catch (err) {
          if (!messageOf(err).includes('HTTP 404')) throw err;
        }
      }
    } catch (err) {
      throw new Error(`${cause}; the forwarding webhook ${id} on ${full} was not removed: ${messageOf(err)}; delete it with \`gh api -X DELETE ${hooksPath}/${id}\``);
    }
    if (hook !== undefined && hook.name !== 'cli') {
      throw new Error(`${cause}; the merge watch record ${recordPath} does not name a forwarding webhook: hook ${id} on ${full} is another kind of hook and was left in place; the record, not the hook, is safe to remove: once no merge watch for ${full} runs, delete it and run the watch again`);
    }
  };

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (coordinated && !isCanonicalLeadFolder(stateDir)) throw new Error('the merge watch state directory is not owned and private');
  const recordPath = watchRecordPath(stateDir, full);
  const removeRecord = () => rmSync(recordPath, { force: true });
  // An existing record: a live watch stops this start; a dead one's processes are ended by identity, each matched on
  // its own fresh table read since ending one can free the other's pid, and its hook deleted by its recorded id. A
  // failed delete, or a recorded id that is not a forwarding hook, keeps that record for the next start.
  const recover = async () => {
    const record = readWatchRecord(recordPath, full, false);
    if (runningAs('watch', record.watch, table(), full)) {
      throw new Error(`another merge watch is running for ${full} (process ${record.watch.pid}); wait for it to end`);
    }
    for (const role of ['forwarder', 'launcher']) {
      const row = record[role] && runningAs(role, record[role], table(), full);
      if (row) await end(row);
    }
    if (record.hookId === null) {
      const [hook] = forwardingHooks();
      if (hook) throw new Error(unprovedHook(hook));
    } else {
      await removeHook(record.hookId, RECOVERY_RELISTS, `a merge watch for ${full} ended without removing its forwarding webhook`);
    }
    removeRecord();
  };
  return { full, table, listHooks, forwardingHooks, unprovedHook, removeHook, recordPath, removeRecord, recover };
}

// Clears a retained watch record as a watch's start does, opening no route: resolves to whether there was one.
export async function clearRetainedWatch(options) {
  const { recordPath, recover } = watchRecovery(options);
  if (!lstatSync(recordPath, { throwIfNoEntry: false })) return false;
  await recover();
  return true;
}

// Opens the route, resolving to { nextWake, close } once this forward's hook is active, or rejects with a one-line
// reason after stopping and cleaning up whatever it started. No pull request is read here. Its options are those of
// `watchRecovery` and `now` and `spawnForwarder`.
export async function openEventRoute(options) {
  const {
    sleep = delay, now = Date.now, platform = process.platform,
    spawnForwarder: startForwarder = (args, events) => spawnTree(args, events, platform),
    coordinated = /** @type {CoordinatedWatch | undefined} */ (undefined),
  } = options;
  const { full, table, listHooks, forwardingHooks, unprovedHook, removeHook, recordPath, removeRecord, recover } = watchRecovery(options);
  const ownRow = table().find((row) => row.pid === process.pid);
  if (!ownRow) throw new Error(`this merge watch (process ${process.pid}) is not in the process table`);
  const watch = identityOf(ownRow);
  for (;;) {
    try {
      writeFileSync(recordPath, JSON.stringify({ watch, launcher: null, forwarder: null, hookId: null }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      if (coordinated) throw new Error(`Delivery stopped: an existing merge watch for ${full} still needs cleanup. Check its owning job before retrying.`);
    }
    await recover();
  }

  if (coordinated) {
    const claim = lstatSync(recordPath);
    try {
      await coordinated.beforeForward();
    } catch (error) {
      const record = readWatchRecord(recordPath, full, true);
      const entry = lstatSync(recordPath, { throwIfNoEntry: false });
      if (entry?.dev === claim.dev && entry.ino === claim.ino
        && record?.watch.pid === watch.pid && record.watch.started === watch.started
        && record.launcher === null && record.forwarder === null && record.hookId === null) removeRecord();
      throw error;
    }
  }

  /** @type {{ pid: number, started: string } | null} */
  let launcher = null;
  /** @type {{ pid: number, started: string } | null} */
  let forwarder = null;
  /** @type {number | null} */
  let hookId = null;
  const save = () => {
    const temporary = `${recordPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ watch, launcher, forwarder, hookId }), { mode: 0o600 });
    renameSync(temporary, recordPath);
  };

  let opened = false;
  let pending = false;
  let noticed = false;
  let exited = false;
  let exitCode;
  let stderrLines = [];
  // Payload lines since the last wake; null stands for a line too long to parse, which wakes the watch.
  /** @type {(string | null)[]} */
  const queue = [];
  let waiter;
  const wake = () => {
    const resolve = waiter;
    waiter = undefined;
    resolve?.();
  };
  const events = {
    onStdout: (line) => {
      if (!opened) pending = true;
      else queue.push(Buffer.byteLength(line) > LINE_MAX_BYTES ? null : line);
      wake();
    },
    onStderr: (line) => {
      // A notice after the route opened is a reattach, after which events sent while it was down are lost.
      if (line.includes(FORWARD_NOTICE)) {
        if (opened) pending = true;
        noticed = true;
      }
      if (line.trim() !== '') stderrLines.push(line.trim());
      wake();
    },
    onExit: (code) => {
      exited = true;
      exitCode = code;
      wake();
    },
  };
  const forwarderText = () => stderrLines.join(' ') || `gh exited with ${exitCode}`;
  const startFailure = () => {
    const text = stderrLines.join(' ');
    if (text.includes('unknown command "webhook"')) return `the GitHub CLI webhook extension is not installed; ${INSTALL_EXTENSION}`;
    if (text.includes('you do not have access to this feature')) {
      return `GitHub refused to forward webhooks on ${full}: you do not have access to this feature; it needs admin access to the repository and a token with the admin:repo_hook scope (\`gh auth refresh -s admin:repo_hook\`), then run the watch again`;
    }
    return `the GitHub event route could not start: ${forwarderText()}`;
  };

  let handle;
  // A startup failure ends the forwarder. Retain a coordinated claim if cleanup cannot rule out an unproved hook.
  const fail = async (cause) => {
    if (handle) await handle.stop();
    let reason = cause;
    let unproved = false;
    if (hookId !== null) {
      await removeHook(hookId, CLEANUP_RELISTS, cause);
    } else if (handle) {
      try {
        const [hook] = forwardingHooks();
        if (hook) {
          reason = unprovedHook(hook);
          unproved = true;
        }
      } catch (err) {
        unproved = true;
        reason = `${cause}; could not list the forwarding webhooks on ${full}: ${messageOf(err)}`;
      }
    }
    if (!coordinated || !unproved) removeRecord();
    throw new Error(reason);
  };

  try {
    const [existing] = forwardingHooks();
    if (existing) throw new Error(unprovedHook(existing));
    handle = await startForwarder(['webhook', 'forward', '--repo', full, '--events', FORWARD_EVENTS], events);
    const launcherRow = table().find((row) => row.pid === handle.pid);
    if (launcherRow) {
      launcher = identityOf(launcherRow);
      save();
    }
    const waitedFrom = now();
    while (!noticed) {
      if (exited) throw new Error(startFailure());
      if (now() - waitedFrom >= NOTICE_LIMIT_MS) throw new Error('the GitHub event route did not connect within 30 seconds; run the watch again');
      await sleep(NOTICE_POLL_MS);
    }
    const forwarderRow = table().find((row) => row.ppid === handle.pid && argsFit('forwarder', row.args, full));
    if (!forwarderRow) throw new Error(`the GitHub event route connected, but no gh-webhook forward for ${full} runs under gh process ${handle.pid}`);
    forwarder = identityOf(forwarderRow);
    save();
    // No forwarding hook was listed before the spawn and only one forward runs per repository, so the one listed
    // while this forwarder runs is its own; a forwarder gone by the end of the list proves no listed hook its own.
    const hooks = forwardingHooks();
    if (hooks.length !== 1) throw new Error(`the GitHub event route connected, but ${full} lists ${hooks.length} forwarding webhooks instead of its own one`);
    if (!runningAs('forwarder', forwarder, table(), full)) throw new Error(unprovedHook(hooks[0]));
    hookId = hooks[0].id;
    save();
    let active = hooks[0].active;
    for (let count = 0; !active && count < ACTIVE_RELISTS; count += 1) {
      await sleep(RELIST_MS);
      if (exited) throw new Error(`the GitHub event route stopped: ${forwarderText()}; run the watch again`);
      active = listHooks().find((hook) => hook.id === hookId)?.active === true;
    }
    if (!active) throw new Error(`the forwarding webhook ${hookId} on ${full} did not become active within 5 seconds; run the watch again`);
  } catch (err) {
    return fail(messageOf(err));
  }
  opened = true;
  stderrLines = [];

  const wakes = (line, context) => {
    if (line === null) return true;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return true;
    }
    return isRelevantEvent(payload, context);
  };
  // Resolves on a relevant event, a reattach or a line it cannot read; on `deadline`, an absolute time on `now`, once
  // it has passed; or with the forwarder's text once the forwarder has ended.
  const nextWake = async ({ deadline, context }) => {
    for (;;) {
      if (pending || queue.some((line) => wakes(line, context))) {
        pending = false;
        queue.length = 0;
        return { wake: 'event' };
      }
      queue.length = 0;
      if (exited) return { wake: 'ended', reason: `the GitHub event route stopped: ${forwarderText()}; run the watch again` };
      if (deadline !== undefined && now() >= deadline) return { wake: 'deadline' };
      let timer;
      await new Promise((resolve) => {
        waiter = resolve;
        if (deadline !== undefined) timer = setTimeout(wake, deadline - now());
      });
      clearTimeout(timer);
    }
  };
  let closing;
  const close = () => {
    closing ??= (async () => {
      await handle.stop();
      await removeHook(hookId, CLEANUP_RELISTS, 'the merge watch stopped its GitHub event route');
      removeRecord();
    })();
    return closing;
  };
  return { nextWake, close };
}
