#!/usr/bin/env node
// @ts-nocheck
// owner-queue.mjs — prints what waits on the owner in this repository as one JSON document (format 1) on stdout, or,
// with `act`, writes one queue panel answer to a card, with `undo`, takes a put-aside, accepted or rejected card
// back, with `move`, moves a card on the board, with `show-first`, sets or removes a card's show-me-first marker, or,
// with `report`, prints the report of one merge commit as one JSON document. Run from the repository root.
//
//   node scripts/owner-queue.mjs
//   node scripts/owner-queue.mjs act --card=<n> --action=<park|answer|keep|drop|pick> --version=<v> [--reply=<text>] [--proposal=<k>]
//   node scripts/owner-queue.mjs undo --card=<n> --action=<park|keep|drop> --record=<json>
//   node scripts/owner-queue.mjs move --card=<n> --move=<ready|backlog|up|place> --version=<v> [--to=<k>]
//   node scripts/owner-queue.mjs show-first --card=<n> --state=<on|off>
//   node scripts/owner-queue.mjs report --sha=<40 or 64 lowercase hex>
//
// Without an argument, and with `report`, it writes nothing. `act` writes only the action's route, and only where the queue read again
// still holds card <n> at version <v> and the action answers its item, `pick` making proposal <k> of a weekly retro a card; after park, keep or drop its last stdout line is
// `owner-queue: undo record <json>`. `undo` takes that record and writes the action's inverse only where the card is
// still as the action left it. `move` writes the move only where the board read again still holds card <n> at the
// version <v> the board section drew and the move fits it. `show-first` writes the marker only where the board read again
// holds card <n> in a column it applies to and the marker is not in that state already. scripts/lib/owner-queue.mjs holds the reading and the
// routes. Each verb but `report` reads the GitHub account with `gh api user --jq .login`; a failed read, or output that
// is not one login, leaves the account unknown, which the document tolerates, `act` and `undo` refuse and `move` and
// `show-first` do not need.
//
// Exit 0 whenever it printed a document, wrote the answer, took it back, moved the card or set the marker. 1: it could not, or
// `act`, `undo`, `move` or `show-first` refused (the reason is one line on stderr). 2: any other argument shape, refused before any read with
// the usage line, `report`'s own for a `report` shape. The queue panel the Herdr add-on installs runs this command in
// each repository it lists.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { azureExec } from './lib/azure-api.mjs';
import { configuredTracker } from './lib/board-markdown.mjs';
import { ghExec, readGitHubLogin } from './lib/gh-exec.mjs';
import { jiraExec } from './lib/jira-api.mjs';
import { linearExec } from './lib/linear-api.mjs';
import { readCoordinator } from './lib/merge-evidence.mjs';
import { ACTIONS, MOVES, SHOW_FIRST_STATES, UNDOABLE, act, collect, markShowFirst, moveOnBoard, report, undo } from './lib/owner-queue.mjs';
import { gitExecutable } from './lib/posix-shell.mjs';

const USAGE = 'usage: node scripts/owner-queue.mjs [act --card=<n> --action=<park|answer|keep|drop|pick> --version=<v> [--reply=<text>] [--proposal=<k>] | undo --card=<n> --action=<park|keep|drop> --record=<json> | move --card=<n> --move=<ready|backlog|up|place> --version=<v> [--to=<k>] | show-first --card=<n> --state=<on|off>]';
const ACT_OPTIONS = { card: { type: 'string' }, action: { type: 'string' }, version: { type: 'string' }, reply: { type: 'string' }, proposal: { type: 'string' } };
const UNDO_OPTIONS = { card: { type: 'string' }, action: { type: 'string' }, record: { type: 'string' } };
// A refused `report` shape prints its own usage line, so USAGE keeps the form the panel's other verbs are refused with.
const REPORT_USAGE = 'usage: node scripts/owner-queue.mjs report --sha=<40 or 64 lowercase hex>';
const MOVE_OPTIONS = { card: { type: 'string' }, move: { type: 'string' }, version: { type: 'string' }, to: { type: 'string' } };
const SHOW_FIRST_OPTIONS = { card: { type: 'string' }, state: { type: 'string' } };
const REPORT_OPTIONS = { sha: { type: 'string' } };
const CARD = /^[1-9]\d*$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The values of `args` as `options` names them, or null where it holds any other option or an operand.
function strictValues(args, options) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch {
    return null;
  }
}

// The `act` request, or null for any other shape: a positive card number, a panel action and a version of 64 lowercase
// hex, an optional reply, and a proposal number for a pick and for no other action, with no other option or operand.
function readAct(args) {
  const values = strictValues(args, ACT_OPTIONS);
  if (values === null) return null;
  const { card, action, version, reply, proposal } = values;
  if (!CARD.test(card ?? '') || !ACTIONS.includes(action) || !DIGEST.test(version ?? '')) return null;
  if (action === 'pick' ? !CARD.test(proposal ?? '') : proposal !== undefined) return null;
  return { card: Number(card), action, version, reply, ...(proposal === undefined ? {} : { proposal: Number(proposal) }) };
}

// The `undo` request, or null for any other shape: a positive card number, an action Undo takes back and a non-empty
// record, with no other option or operand.
function readUndo(args) {
  const values = strictValues(args, UNDO_OPTIONS);
  if (values === null) return null;
  const { card, action, record } = values;
  if (!CARD.test(card ?? '') || !UNDOABLE.includes(action) || !record) return null;
  return { card: Number(card), action, record };
}

// The `move` request, or null for any other shape: a positive card number, a board move and a version of 64 lowercase
// hex, and a place number for a `place` move and for no other move, with no other option or operand.
function readMove(args) {
  const values = strictValues(args, MOVE_OPTIONS);
  if (values === null) return null;
  const { card, move, version, to } = values;
  if (!CARD.test(card ?? '') || !MOVES.includes(move) || !DIGEST.test(version ?? '')) return null;
  if (move === 'place' ? !CARD.test(to ?? '') : to !== undefined) return null;
  return { card: Number(card), move, version, ...(to === undefined ? {} : { to: Number(to) }) };
}

// The `show-first` request, or null for any other shape: a positive card number and a marker state, with no other option
// or operand.
function readShowFirst(args) {
  const values = strictValues(args, SHOW_FIRST_OPTIONS);
  if (values === null) return null;
  const { card, state } = values;
  if (!CARD.test(card ?? '') || !SHOW_FIRST_STATES.includes(state)) return null;
  return { card: Number(card), state };
}

// The `report` request, or null for any other shape: one merge commit of 40 or 64 lowercase hex, with no other option
// or operand.
function readReport(args) {
  const values = strictValues(args, REPORT_OPTIONS);
  return values !== null && COMMIT.test(values.sha ?? '') ? { sha: values.sha } : null;
}

// The exit code, or for `report` a promise of it, the one verb that downloads.
export function main(args = process.argv.slice(2), output = console) {
  const verb = args[0];
  let request = null;
  if (args.length === 0) request = {};
  else if (verb === 'act') request = readAct(args.slice(1));
  else if (verb === 'undo') request = readUndo(args.slice(1));
  else if (verb === 'move') request = readMove(args.slice(1));
  else if (verb === 'show-first') request = readShowFirst(args.slice(1));
  else if (verb === 'report') request = readReport(args.slice(1));
  if (request === null) {
    output.error(verb === 'report' ? REPORT_USAGE : USAGE);
    return 2;
  }
  const root = process.cwd();
  const refuse = (error) => {
    output.error(`owner-queue: ${error.message.replace(/\s*[\r\n]+\s*/g, ' ')}`);
    return 1;
  };
  try {
    const tracker = configuredTracker();
    const git = gitExecutable();
    if (git === null) throw new Error('found no git.exe in an absolute PATH entry');
    const run = (gitArgs) => execFileSync(git, gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (verb === 'report') {
      return report({ ...request, executor: ghExec, run, fetch, tracker }).then((document) => {
        output.log(JSON.stringify(document, null, 2));
        return 0;
      }, refuse);
    }
    const readers = {
      root,
      tracker,
      executor: ghExec,
      linear: linearExec,
      jira: jiraExec,
      azure: azureExec,
      run,
      readFile: (path) => readFileSync(path, 'utf8'),
      listFolder: readdirSync,
      fileTime: (path) => statSync(path).mtime.toISOString(),
      hostname: hostname(),
      login: tracker === 'github' ? readGitHubLogin() : null,
    };
    if (args.length === 0) {
      const document = collect(readers);
      if (tracker === 'github' && document.board !== null) {
        try {
          const { runtime, installed } = readCoordinator({ git: run, herdr: true, includeInstalled: true });
          document.board.coordinator = { runtime, installed };
        } catch (error) {
          document.board.coordinator = { unread: error.message };
        }
      }
      output.log(JSON.stringify(document, null, 2));
    } else if (verb === 'act') act({ ...readers, ...request, output });
    else if (verb === 'undo') undo({ ...readers, ...request, output });
    else if (verb === 'show-first') markShowFirst({ ...readers, ...request, output });
    else moveOnBoard({ ...readers, ...request, output });
    return 0;
  } catch (error) {
    return refuse(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
