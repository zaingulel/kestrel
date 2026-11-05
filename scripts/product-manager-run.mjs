#!/usr/bin/env node
// product-manager-run.mjs — runs a product manager run, or with --pre-approved a pre-approved run, on Codex from a
// terminal outside any session: one fresh card session after another, then one end session whose final message is
// printed once.
// Exit 0 when the run ended and the end session's message was printed; 1 when the repository root could not be worked
// out or the end session's message was not delivered; 2 on a bad argument, before any session starts.
// Each session's logs and last message stay in a temporary results folder named in the end session's prompt.
// A product manager run marks each session PRODUCT_MANAGER_RUN_SESSION=1; a pre-approved run takes one start time and
// marks every session PRE_APPROVED_RUN_SESSION=<that time>, with no product manager mark.
// Run: node scripts/product-manager-run.mjs [--pre-approved]

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitEnvironment } from './lib/factory-sync.mjs';
import { runRun } from './lib/product-manager-run.mjs';

const USAGE = 'usage: node scripts/product-manager-run.mjs [--pre-approved]';

// The root the way .codex/hooks.json works it out: the parent of the absolute common directory.
function repositoryRoot() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: gitEnvironment(), stdio: 'pipe' });
  return dirname(common.trim());
}

// Starts one session without a shell, stdin ignored, its output streams kept in `<logs>.jsonl` and `<logs>.stderr.log`,
// and its environment carrying the run session mark, so the Codex guard refuses publishing in it.
function sessionStarter(command, mark) {
  return ({ argv, root, logs }) => {
    const out = openSync(`${logs}.jsonl`, 'w');
    const err = openSync(`${logs}.stderr.log`, 'w');
    return new Promise((done) => {
      const child = spawn(command[0], [...command.slice(1), ...argv], { cwd: root, stdio: ['ignore', out, err], env: { ...process.env, ...mark } });
      child.once('error', (error) => done({ exitCode: null, spawnError: `could not start ${command[0]} (${error.code})` }));
      child.once('close', (code, signal) => done({ exitCode: code ?? signal }));
    }).finally(() => {
      closeSync(out);
      closeSync(err);
    });
  };
}

// Only the tests replace the command or the starter.
export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console;
  if (args.length > 1 || (args.length === 1 && args[0] !== '--pre-approved')) {
    output.error(USAGE);
    return 2;
  }
  const kind = args.length === 1 ? 'pre-approved' : 'product-manager';
  let root;
  try {
    root = repositoryRoot();
  } catch (error) {
    output.error(`cannot work out the repository root (${error.message})`);
    return 1;
  }
  const folder = mkdtempSync(join(tmpdir(), 'product-manager-run-'));
  const start = (dependencies.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const mark = kind === 'pre-approved' ? { PRE_APPROVED_RUN_SESSION: start } : { PRODUCT_MANAGER_RUN_SESSION: '1' };
  const startSession = dependencies.startSession ?? sessionStarter(dependencies.command ?? ['codex'], mark);
  return runRun({ startSession, root, folder, output, kind });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
