// merge-watch.mjs — watches one pull request until it merges or can no longer merge unattended, or waits for one to open on a branch.
//
// Read-only: every `gh` call reads repository identity, pull request state or timeline, branch protection, rulesets, checks, workflow runs or their jobs.
// `gh pr checks --required` lists a check only once GitHub has created its run, so the full
// required set is read first, from the base branch's classic protection and every page of its
// rules; a required name the checks have not listed yet counts as `unreported`. So does a failed
// required check while a newer run of the same workflow on the same head commit has not finished,
// because that run will report the check again. The first `gh`
// failure stops the watch with no retry and no further read, and so does a successful reply it cannot read: a
// required-check list that is not a list of names, a pull request state or merge state it does not know,
// a required check without a known bucket, a timeline that is not pages of events or has a ready event without a time,
// or a workflow run, run list or job without the fields the watch compares or with a status GitHub does not document.
// The only time limits are two stall stops: no workflow run created since the pull request was last marked ready has
// been unfinished on the head commit while a required check has not reported, for 10 minutes, and a job of such an
// unfinished run queued with no runner for 15 minutes. A pull request that was never a draft counts every run. Both
// clocks run on the watch's own clock from its first observation of the stall, so GitHub's clock and this machine's
// never meet; the caller's runtime otherwise waits on the process itself.
// The draft wait binds its branch and repository provenance to origin, at the same interval, with the same gh-failure and unreadable-reply stops.

export const WATCH_INTERVAL_MS = 30_000;

// Rule types that make GitHub require checks the rule does not name.
const UNNAMED_RULE_TYPES = new Set(['workflows', 'code_scanning']);

// The pull request states, GitHub's MergeStateStatus values and the check buckets gh reports.
const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const MERGE_STATES = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);

// gh's own wording when no check at all has reported on the branch yet.
const NOTHING_REPORTED = 'checks reported on the';

// The text gh printed, on one line so it can stand as the watch's last line of output.
function failureText(err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
  return text.replace(/\s*\n\s*/g, ' ');
}

function readRequiredSet(pr, ghExec) {
  const { baseRefName } = JSON.parse(ghExec(['pr', 'view', pr, '--json', 'baseRefName']));
  const branch = JSON.parse(ghExec(['api', `repos/{owner}/{repo}/branches/${baseRefName}`]));
  const classicChecks = branch.protection?.required_status_checks;
  const classic = classicChecks == null ? [] : classicChecks.contexts;
  if (!Array.isArray(classic) || !classic.every((name) => typeof name === 'string' && name !== '')) {
    throw new Error(`unreadable required set: classic required_status_checks ${JSON.stringify(classicChecks)}`);
  }
  const pages = JSON.parse(ghExec(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/rules/branches/${baseRefName}`]));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error(`unreadable required set: rules ${JSON.stringify(pages)}`);
  }
  const ruled = [];
  for (const rule of pages.flat()) {
    if (rule.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks) || !checks.every((check) => typeof check?.context === 'string' && check.context !== '')) {
        throw new Error(`unreadable required set: rule ${JSON.stringify(rule)}`);
      }
      ruled.push(...checks.map((check) => check.context));
    } else if (UNNAMED_RULE_TYPES.has(rule.type)) {
      ruled.push({ unnamed: rule.type });
    }
  }
  return { classic, ruled };
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
  let checks;
  try {
    checks = JSON.parse(ghExec(['pr', 'checks', pr, '--required', '--json', 'name,bucket,link']));
  } catch (err) {
    if (!failureText(err).includes(NOTHING_REPORTED)) throw err;
    return required.size === 0 ? [] : ['unreported'];
  }
  if (!Array.isArray(checks)) throw new Error(`unreadable required checks: ${JSON.stringify(checks)}`);
  for (const check of checks) {
    if (!BUCKETS.has(check.bucket)) {
      throw new Error(`unreadable bucket on required check ${JSON.stringify(check.name)}: ${JSON.stringify(check.bucket ?? null)}`);
    }
  }
  const reported = new Set(checks.map((check) => check.name));
  const unreported = [...required].filter((name) => !reported.has(name)).map(() => 'unreported');
  const buckets = checks.map((check) => (
    check.bucket === 'fail' && supersededByNewerRun(check.link, ghExec) ? 'unreported' : check.bucket
  ));
  return [...unreported, ...buckets];
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
// sleep, with that pass's required-check buckets, and returns the reason to stop, or undefined while neither limit has
// run out. Only runs created since the pull request was last marked ready count, which the timeline gives once per
// head commit. The no-run clock runs only while a required check is unreported and no counted run on the head commit
// is unfinished. A new head commit starts both clocks over, and so does `clear`, which a draft pass calls.
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
          return `no test run has started for ${head} within 10 minutes: mark the pull request as a draft, mark it ready again, then queue the auto-merge again, since returning to draft cancels the queued merge`;
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
  };
}

// Resolves to { exitCode, reason }: 0 only when the pull request merged, 1 for every other stop.
export async function watchMerge({ pr, ghExec, sleep, now }) {
  try {
    const { classic, ruled } = readRequiredSet(pr, ghExec);
    if (ruled.some((entry) => typeof entry !== 'string')) {
      return {
        exitCode: 1,
        reason: `a ruleset requires checks it does not name, so the full required set is unknown: ${JSON.stringify(ruled)}`,
      };
    }
    const required = new Set([...classic, ...ruled]);
    const stall = createStallWatch(pr, ghExec, now);
    for (;;) {
      const { state, mergeStateStatus, headRefOid } = JSON.parse(ghExec(['pr', 'view', pr, '--json', 'state,mergeStateStatus,headRefOid']));
      if (!PR_STATES.has(state) || !MERGE_STATES.has(mergeStateStatus) || !/^[0-9a-f]{40}$/.test(headRefOid)) {
        return { exitCode: 1, reason: `unreadable pull request state: ${JSON.stringify({ state, mergeStateStatus, headRefOid })}` };
      }
      if (state === 'MERGED') return { exitCode: 0, reason: 'merged' };
      if (state === 'CLOSED') return { exitCode: 1, reason: 'closed without merging' };
      const buckets = readRequiredBuckets(pr, required, ghExec);
      const view = `${state} ${mergeStateStatus}`;
      if (buckets.includes('fail')) return { exitCode: 1, reason: `a required check failed: ${buckets.join(' ')}` };
      if (mergeStateStatus === 'DIRTY' || mergeStateStatus === 'BEHIND') {
        return { exitCode: 1, reason: `merge blocked: ${view}` };
      }
      if (mergeStateStatus === 'BLOCKED' && !buckets.some((bucket) => bucket === 'pending' || bucket === 'unreported')) {
        return { exitCode: 1, reason: `merge blocked with every required check finished: ${view} ${buckets.join(' ')}`.trimEnd() };
      }
      if (mergeStateStatus === 'DRAFT') {
        stall.clear();
      } else {
        const stalled = stall.check(headRefOid, buckets);
        if (stalled !== undefined) return { exitCode: 1, reason: stalled };
      }
      await sleep(WATCH_INTERVAL_MS);
    }
  } catch (err) {
    return { exitCode: 1, reason: failureText(err) };
  }
}

// Resolves to { exitCode, reason }: 0 with the number once exactly one origin-owned pull request is open on `head`,
// 1 for every other stop. An empty list keeps the wait going.
export async function watchDraft({ head, gitExec, ghExec, sleep }) {
  try {
    const origin = gitExec(['remote', 'get-url', 'origin']).trim();
    if (!origin || /[\r\n]/.test(origin)) {
      return { exitCode: 1, reason: 'unreadable origin remote URL' };
    }
    const repository = JSON.parse(ghExec(['repo', 'view', '--json', 'id', '--', origin]));
    if (!repository || Array.isArray(repository) || typeof repository.id !== 'string' || !repository.id || /\s/.test(repository.id)) {
      return { exitCode: 1, reason: `unreadable origin repository: ${JSON.stringify(repository)}` };
    }
    for (;;) {
      const open = JSON.parse(ghExec(['pr', 'list', '--repo', origin, '--head', head, '--state', 'open', '--json', 'number,state,headRefName,headRepository,isCrossRepository']));
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
      await sleep(WATCH_INTERVAL_MS);
    }
  } catch (err) {
    return { exitCode: 1, reason: failureText(err) };
  }
}
