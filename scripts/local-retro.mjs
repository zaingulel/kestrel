#!/usr/bin/env node
// local-retro.mjs — files the weekly local retro: one issue in this repository holding what the model, on the owner's
// own account, proposes from the last whole week of the owner's Claude Code and Codex chats in the projects this
// machine registers, and where it thinks the owner was wrong. Run from the repository root.
//
//   node scripts/local-retro.mjs --home <Herdr home> [--workstream <name>]
//
// `--home` is the Herdr home whose machine record registers the projects. `--workstream` is the routing value the
// issue's card gets, required exactly where the board has a routing field. The chat goes to `claude` alone, on its
// standard input, run in an empty folder with no tools; the write-up goes to the one issue. A week whose issue stands
// is not written again, and no chat is read for it. scripts/lib/local-retro.mjs holds the reading and the checks.
//
// Exit 0 with the issue's address on stdout, prefixed `already filed: ` where it stood before this run. 1: it could
// not (the reason is one line on stderr). 2: any other argument shape, refused before any read with the usage line.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghExec } from './lib/gh-exec.mjs';
import { diskFiles, main } from './lib/local-retro.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';

const MODEL_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Runs the model in a folder made for the call and removed after it, so it starts in no project. A failure is
// reported by its exit alone, since what the model printed is made of chat.
function runModel(args, input) {
  const folder = mkdtempSync(join(tmpdir(), 'local-retro-'));
  try {
    return execFileSync('claude', args, { cwd: folder, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: MODEL_TIMEOUT_MS, maxBuffer: MODEL_MAX_OUTPUT_BYTES });
  } catch (error) {
    const { status, code } = /** @type {NodeJS.ErrnoException & { status: number | null }} */ (error);
    throw new Error(`claude ${status === null || status === undefined ? `did not finish (${code})` : `exited ${status}`}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function run(program, args, { cwd = undefined, input = undefined } = {}) {
  if (program === 'gh') return ghExec(args);
  if (program === 'claude') return runModel(args, input);
  const git = gitExecutable();
  if (git === null) throw new Error('found no git.exe in an absolute PATH entry');
  return execFileSync(git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    run,
    now: Date.now,
    env: process.env,
    userHome: homedir(),
    files: diskFiles,
    loadConfig: (folder) => import(pathToFileURL(join(folder, 'scripts', 'lib', 'board-config.mjs')).href),
    output: console,
  });
}
