#!/usr/bin/env node
// merge-watch.mjs — waits on GitHub events (one short-lived forwarding webhook, one stall deadline) for one pull request to merge or stop, or, with `--draft`, for an
// origin-owned pull request to open on one job branch.
// With a pull request number: exit 0 only when merged; 1 when closed, a required check failed, the merge is blocked,
// the required set is unknown, a pull request state, check, workflow run or job reply is unreadable, no workflow run
// on the head commit has been unfinished for 10 minutes while a required check has not reported, a test job has
// waited 15 minutes for a runner, or `gh` failed.
// With `--draft job/<issue>`: exit 0 once exactly one origin-owned pull request is open on that branch, printing its
// number; 1 for foreign or unreadable provenance, multiple pull requests, or a failed read.
// Herdr delivery also supports --hold-delivery, --delivery-ready, --delivery-pr and --held-delivery; a held delivery's
// watch exits 0 once the pull request is open at its armed head with every required check passed or skipped.
// Exit 75 means readiness is pending, and 3 means the Herdr add-on is off.
// A coordinated Claude job's run from its workflow version, FABRAIK_WORKFLOW_ROOT, exits 1 before any dispatch unless that
// version verifies, drift included except for the one-argument cleanup `<pull-request-number>`. That cleanup only clears a
// retained watch record and opens no watch, drifted or not: exit 0 once it cleared one, 1 when none was found.
// Exit 2 on a bad argument, before any external read. The reason is always the last line of output.
// The watch uses the probe-free `runGh`, so a `gh` failure makes no further read.
// Run: node scripts/merge-watch.mjs <pull-request-number>
//      node scripts/merge-watch.mjs --draft job/<issue>

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { treeSettings } from './lib/runtimes.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { runGh } from './lib/gh-exec.mjs';
import { clearRetainedWatch, openEventRoute, spawnTree, watchDraft, watchMerge } from './lib/merge-watch.mjs';
import { LINEAR_IDENTIFIER } from './lib/tracker.mjs';
import { verifyJobPin, watchDriftAllowed } from './lib/workflow-pin.mjs';

const USAGE = 'usage: node scripts/merge-watch.mjs <pull-request-number> | --draft job/<issue>';

const positiveInteger = (value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

function deliveryForm(args) {
  const [command, target, head, arm] = args;
  if (command === '--hold-delivery' && args.length === 1) return { mode: /** @type {const} */ ('hold') };
  if (command === '--delivery-ready' && args.length === 2 && positiveInteger(target) && Number(target) <= 590) {
    return { mode: /** @type {const} */ ('ready'), seconds: Number(target) };
  }
  if (command === '--delivery-pr' && positiveInteger(target) && /^[a-f0-9]{40}$/.test(head)
    && (args.length === 3 || (args.length === 4 && arm === '--arm'))) {
    return { mode: /** @type {const} */ ('pr'), pr: Number(target), head, arm: arm === '--arm' };
  }
  if (positiveInteger(command) && args.length === 2 && target === '--held-delivery') {
    return { mode: /** @type {const} */ ('watch'), pr: Number(command) };
  }
  return undefined;
}

// job/<N> on GitHub and markdown, job/<ID> on Linear: both accepted, since this script reads no configuration.
const isJobBranch = (head) => head.startsWith('job/') && (/^[1-9]\d*$/.test(head.slice(4)) || LINEAR_IDENTIFIER.test(head.slice(4)));

// Opens the event route, watches the pull request on it and closes it on every way out, `untilSignal` included, whose
// promise resolves with a signal name or a delivery stop message. Prints the gh call count on the error stream, then the reason.
async function watchPullRequest(pr, { output, ghExec, now, openRoute, untilSignal,
  stateDir = /** @type {string | undefined} */ (undefined),
  coordinated = /** @type {import('./lib/merge-watch.mjs').CoordinatedWatch | undefined} */ (undefined),
}) {
  const ghEnv = coordinated && { ...process.env, GH_HOST: 'github.com', GH_REPO: `github.com/${coordinated.repo}` };
  const counts = { start: 0, events: 0, deadlines: 0, stop: 0 };
  /** @type {keyof typeof counts} */
  let phase = 'start';
  const countedGh = (ghArgs) => {
    counts[phase] += 1;
    return ghEnv ? ghExec(ghArgs, ghEnv) : ghExec(ghArgs);
  };
  // The `gh webhook forward` invocation is spawned rather than run through `ghExec`, and counts the same.
  const countedForwarder = (forwardArgs, events) => {
    counts[phase] += 1;
    return spawnTree(forwardArgs, events, process.platform, ghEnv);
  };
  let signal;
  const stopped = untilSignal().then((reason) => {
    signal = reason;
    return { exitCode: 1, reason: coordinated ? reason : `stopped by ${reason}` };
  });
  let result;
  let route;
  try {
    route = await (openRoute ?? (() => openEventRoute({ ghExec: countedGh, spawnForwarder: countedForwarder, coordinated, stateDir })))();
  } catch (err) {
    result = { exitCode: 1, reason: err instanceof Error ? err.message : String(err) };
  }
  if (route) {
    const nextWake = async (wait) => {
      const next = await route.nextWake(wait);
      if (phase !== 'stop' && next.wake !== 'ended') phase = next.wake === 'event' ? 'events' : 'deadlines';
      return next;
    };
    try {
      result = signal !== undefined ? await stopped : await Promise.race([stopped, watchMerge({ pr, ghExec: countedGh, now, nextWake, coordinated })]);
    } finally {
      phase = 'stop';
      try {
        await route.close();
      } catch (err) {
        result = { exitCode: 1, reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  const total = counts.start + counts.events + counts.deadlines + counts.stop;
  output.error(`merge watch made ${total} gh calls: ${counts.start} to start, ${counts.events} after events, ${counts.deadlines} at deadlines, ${counts.stop} to stop`);
  output.log(result.reason);
  return result.exitCode;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const ghExec = dependencies.ghExec ?? runGh;
  if (args.length === 1 && /^[1-9]\d*$/.test(args[0])) {
    return watchPullRequest(args[0], {
      output,
      ghExec,
      now: dependencies.now ?? Date.now,
      openRoute: dependencies.openRoute,
      untilSignal: dependencies.untilSignal ?? (() => new Promise(() => {})),
    });
  }
  if (args.length === 2 && args[0] === '--draft' && isJobBranch(args[1])) {
    const { exitCode, reason } = await watchDraft({
      head: args[1],
      gitExec: dependencies.gitExec ?? ((gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: 'pipe' })),
      ghExec,
      sleep: dependencies.sleep ?? delay,
    });
    output.log(reason);
    return exitCode;
  }
  const delivery = deliveryForm(args);
  if (delivery) {
    try {
      // The job's settings may add a key this pinned copy does not know; the pull request's own required check judges it.
      if (!treeSettings(dependencies.cwd ?? process.cwd(), { admitUnknownKeys: true }).herdr) {
        output.log('Herdr delivery is unavailable: the Herdr add-on is off.');
        return 3;
      }
      const optional = new URL('./lib/coordinator.mjs', import.meta.url);
      const coordinator = await import('./lib/coordinator.mjs').catch((error) => {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && error.url === optional.href) {
          throw new Error('Herdr delivery is unavailable: install the Herdr add-on files, then retry.');
        }
        throw error;
      });
      return await coordinator.runDelivery(delivery, { ...dependencies, output, ghExec, watch: dependencies.watch ?? watchPullRequest });
    } catch (error) {
      output.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  output.error(USAGE);
  return 2;
}

// SIGINT, SIGTERM and SIGHUP stop a pull request watch or delivery hold through its cleanup; the draft wait keeps their default.
const untilSignal = () => new Promise((resolveSignal) => {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => resolveSignal(name));
});

const messageOf = (error) => error instanceof Error ? error.message : String(error);

// A pinned run's standing: `{ refusal }` with the cause its workflow version fails to verify for, or `{ cleanupOnly }`, true
// for the one-argument cleanup, which verifies with drift allowed; an unpinned run gets `{}`.
function pinStanding(args) {
  if (process.env.FABRAIK_COORDINATED_JOB !== '1' || !process.env.FABRAIK_WORKFLOW_ROOT) return {};
  const cleanupOnly = watchDriftAllowed(args);
  try {
    verifyJobPin({ env: process.env, cwd: process.cwd(), drift: !cleanupOnly });
  } catch (error) {
    return { refusal: messageOf(error) };
  }
  return { cleanupOnly };
}

// Clears the retained watch record a coordinated job's one-argument run is for, opening no new watch.
async function clearPinnedWatch() {
  try {
    if (!await clearRetainedWatch({ ghExec: runGh })) {
      console.log('a coordinated job\'s one-argument run only clears a retained watch record, and none was found');
      return 1;
    }
  } catch (error) {
    console.log(messageOf(error));
    return 1;
  }
  console.log('the retained watch record was cleared; a coordinated job\'s one-argument run opens no new watch');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const { refusal, cleanupOnly } = pinStanding(args);
  if (refusal !== undefined) {
    console.log(`merge watch refused: ${refusal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = cleanupOnly ? await clearPinnedWatch() : await main(args, { untilSignal });
  }
}
