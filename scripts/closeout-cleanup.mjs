#!/usr/bin/env node
// closeout-cleanup.mjs — after a job's merge, removes the job's containers, named scratch, worktree and branch, each
// only when every check passes; with --check, reads whether anything uses a path and removes nothing. Run the
// verifier checkout's copy, never the job worktree's:
//   node scripts/closeout-cleanup.mjs <issue> [--pr <canonical HTTPS GitHub PR URL>] [--scratch <absolute path>]... [--regenerated <worktree-relative path>]...
//   node scripts/closeout-cleanup.mjs --check <absolute path> [--check <absolute path>]...
// The worktree is the one git registers for job/<issue>. `--regenerated` names an ignored directory in it that a
// command regenerates, such as node_modules. Prints one line per target removed, retained with its reason, or
// absent, then a summary line; --check prints one line per path, unused, in use, unverifiable or absent. Exit 0 when
// it removed something and retained nothing (--check: every path unused or absent); 3 when there was nothing to do;
// 4 when it retained something (--check: any path in use or unverifiable); 1 when git is unavailable or the worktree
// list or the branch could not be read, having done nothing; 2 on a bad argument, before any external call.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPaths, cleanupJob, parseCleanupArgs, runCommand } from './lib/closeout-cleanup.mjs';
import { gitEnvironment } from './lib/factory-sync.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';

const USAGE =
  'usage: node scripts/closeout-cleanup.mjs <issue> [--pr <canonical HTTPS GitHub PR URL>] [--scratch <absolute path>]... [--regenerated <worktree-relative path>]...';
const CHECK_USAGE = 'usage: node scripts/closeout-cleanup.mjs --check <absolute path> [--check <absolute path>]...';

function resolveGit() {
  const command = gitExecutable();
  if (!command) return null;
  try {
    return { command, env: gitEnvironment() };
  } catch {
    return null;
  }
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  const request = parseCleanupArgs(args);
  if (request.error) {
    output.error(`closeout-cleanup: ${request.error}`);
    output.error(args.includes('--check') ? CHECK_USAGE : USAGE);
    return 2;
  }
  const run = dependencies.run ?? runCommand;
  const platform = dependencies.platform ?? process.platform;
  const pid = dependencies.pid ?? process.pid;
  let result;
  if (request.check) {
    result = checkPaths(request.check, { run, platform, pid });
  } else {
    const git = dependencies.git ?? resolveGit();
    if (!git) {
      output.error('closeout-cleanup: git is not available');
      return 1;
    }
    result = cleanupJob(request, {
      run,
      platform,
      cwd: dependencies.cwd ?? process.cwd(),
      home: dependencies.home ?? homedir(),
      pid,
      scriptPath: dependencies.scriptPath ?? fileURLToPath(import.meta.url),
      git,
    });
  }
  for (const line of result.lines) {
    if (result.exitCode === 1) output.error(line);
    else output.log(line);
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
