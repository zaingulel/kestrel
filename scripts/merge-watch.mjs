#!/usr/bin/env node
// merge-watch.mjs — waits on one pull request, reading GitHub only, until it merges or stops.
// Exit 0 only when merged; 1 when closed, a required check failed, the merge is blocked, the
// required set is unknown, a pull request state, check or workflow run reply is unreadable, or
// `gh` failed; 2 on a bad argument, before any `gh` call. The reason is always the last line of output.
// The watch uses the probe-free `runGh`, so a `gh` failure makes no further read.
// Run: node scripts/merge-watch.mjs <pull-request-number>

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runGh } from './lib/gh-exec.mjs';
import { watchMerge } from './lib/merge-watch.mjs';

const USAGE = 'usage: node scripts/merge-watch.mjs <pull-request-number>';

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) {
    output.error(USAGE);
    return 2;
  }
  const { exitCode, reason } = await watchMerge({
    pr: args[0],
    ghExec: dependencies.ghExec ?? runGh,
    sleep: dependencies.sleep ?? delay,
  });
  output.log(reason);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
