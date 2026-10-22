#!/usr/bin/env node
// merge-watch.mjs — waits on GitHub, reading only, for one pull request to merge or stop, or, with `--draft`, for an
// origin-owned pull request to open on one job branch.
// With a pull request number: exit 0 only when merged; 1 when closed, a required check failed, the merge is blocked,
// the required set is unknown, a pull request state, check or workflow run reply is unreadable, or `gh` failed.
// With `--draft job/<issue>`: exit 0 once exactly one origin-owned pull request is open on that branch, printing its
// number; 1 for foreign or unreadable provenance, multiple pull requests, or a failed read.
// Exit 2 on a bad argument, before any external read. The reason is always the last line of output.
// The watch uses the probe-free `runGh`, so a `gh` failure makes no further read.
// Run: node scripts/merge-watch.mjs <pull-request-number>
//      node scripts/merge-watch.mjs --draft job/<issue-number>

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runGh } from './lib/gh-exec.mjs';
import { watchDraft, watchMerge } from './lib/merge-watch.mjs';

const USAGE = 'usage: node scripts/merge-watch.mjs <pull-request-number> | --draft job/<issue-number>';

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const seams = { ghExec: dependencies.ghExec ?? runGh, sleep: dependencies.sleep ?? delay };
  let watched;
  if (args.length === 1 && /^[1-9]\d*$/.test(args[0])) {
    watched = watchMerge({ pr: args[0], ...seams });
  } else if (args.length === 2 && args[0] === '--draft' && /^job\/[1-9]\d*$/.test(args[1])) {
    watched = watchDraft({
      head: args[1],
      gitExec: dependencies.gitExec ?? ((gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: 'pipe' })),
      ...seams,
    });
  } else {
    output.error(USAGE);
    return 2;
  }
  const { exitCode, reason } = await watched;
  output.log(reason);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
