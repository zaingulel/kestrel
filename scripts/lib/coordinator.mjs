// coordinator.mjs: the tools of a project's coordinator. `openCoordinator` opens the coordinator as a Coordinator tab in the
// project's Herdr space; `listCards` lists the startable Ready cards in build order; `listUnfinished` lists the unfinished jobs
// with the verdict their card and Herdr give; `startJob` starts one card's job as a
// kept session running the resume skill, in its own tab `job N`, as the verified coordinator's own hc child, or resumes the recorded
// session of a kept job terminal whose program has gone. The coordinator reads the
// tracker through these tools, so a read GitHub refuses for quota reaches it as a line naming the reset.
// scripts/coordinator.mjs is the command. Herdr and tracker calls are injected here.

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { BOARD_OWNER, BOARD_REPOSITORY } from './board-config.mjs';
import { moveCards } from './board-move.mjs';
import { fetchBoard, fetchCardDetails, isClaim, isContentUnresolved, newestClaim, normalizeItem, pickable, sortForDisplay } from './board.mjs';
import { parseWorktreeList } from './closeout-cleanup.mjs';
import { gitEnvironment } from './factory-sync.mjs';
import { ghExec } from './gh-exec.mjs';
import { checkLeadFile, lockLeadFile } from './cap-lock.mjs';
import { cardIneligibility, COMMIT_TEXT, originRepository, readCoordinator, readOrigin, showFirstAmong } from './merge-evidence.mjs';
import { coordinatedWatchIsLive, defaultStateDir, SETTLE_AFTER_MS } from './merge-watch.mjs';
import { isCanonicalLeadFolder, managedPath, readManagedRecord, readyOnBoard } from './pre-approved-run.mjs';
import { isRecord, LOCAL_HERDR_TERMINAL, readSettingsHeader } from './runtimes.mjs';
import { cardRef } from './tracker.mjs';
import { onReviewedMain, repairWorkflowSnapshot, selectWorkflowVersion, verifyJobPin, verifyWorkflowSnapshot, workflowDrift, workflowStore } from './workflow-pin.mjs';

// A Herdr command line, `hc` or `herdr-app`: resolves its exit code and output, and rejects only when it cannot run.
export const herdrCommand = (executable, timeout = 0) => (commandArgs) => new Promise((resolve, reject) => {
  execFile(executable, commandArgs, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

export const COORDINATOR_TAB = 'Coordinator';
const TURNED_OFF = 'HERDR_OFF';

const coordinatorPrompt = (login) => `Coordinate this project from its Herdr space: read .agents/skills/resume/references/herdr-lead.md whole and follow its "Coordinator" section.\n${JSON.stringify({ login })}`;

// A Herdr command line, `hc` or `herdr-app`, run with its arguments: its exit code and output.
/** @typedef {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} HerdrCommand */

// The spaces `herdr-app ls` lists, or throws when it fails or lists them in a shape this does not read.
export async function listSpaces(herdrApp) {
  const listing = await herdrApp(['ls']);
  if (listing.code !== 0) throw new Error(`herdr-app ls failed: ${listing.stderr.trim() || `exit ${listing.code}`}`);
  let spaces;
  try {
    spaces = JSON.parse(listing.stdout).spaces;
  } catch {
    throw new Error('herdr-app ls printed no readable space list');
  }
  const named = (value) => typeof value?.id === 'string' && typeof value.name === 'string';
  if (!Array.isArray(spaces) || !spaces.every((entry) => named(entry) && typeof entry.folder === 'string' && (entry.machine === null || typeof entry.machine === 'string')
    && Array.isArray(entry.tabs) && entry.tabs.every(named))) {
    throw new Error('herdr-app ls printed a space list this command does not read');
  }
  return spaces;
}

const manySpaces = (here, root) => `Herdr spaces ${here.map(({ id }) => id).join(', ')} all have folder ${root}; close all but one.`;
const localProjectSpaces = (spaces, root) => spaces.filter(({ folder, machine }) => folder === root && machine === null);

// The one local space whose folder is the project's root: `{ space }`, `{ space: undefined }` where there is none, or `{ code }`
// after printing why the project cannot be told from its space.
async function projectSpace({ root, herdrApp, print }) {
  let spaces;
  try {
    spaces = await listSpaces(herdrApp);
  } catch (error) {
    print(/** @type {Error} */ (error).message);
    return { code: 1 };
  }
  const here = localProjectSpaces(spaces, root);
  if (here.length > 1) {
    print(manySpaces(here, root));
    return { code: 1 };
  }
  return { space: here[0] };
}

async function closeStoppedCoordinatorTab(herdrApp, id) {
  const closed = await herdrApp(['do', 'tab.close', '--id', id]);
  if (closed.code !== 0) {
    throw new Error(`herdr-app could not close the stopped ${COORDINATOR_TAB} tab ${id}: ${closed.stderr.trim() || `exit ${closed.code}`}`);
  }
}

// A last-tab close would close the space. Confirm both tab identities before rechecking and closing the original.
async function verifySoleCoordinatorReplacement({ root, herdrApp, hc, spaceId, tabId, terminals, reply }) {
  let opened;
  try {
    opened = JSON.parse(reply);
  } catch {
    throw new Error('herdr-app tab.new returned no readable replacement identity');
  }
  if (opened?.space !== spaceId || typeof opened.tab !== 'string' || !opened.tab || opened.tab === tabId
    || typeof opened.terminal !== 'string' || !opened.terminal) {
    throw new Error('herdr-app tab.new returned no distinct replacement tab and terminal in the original space');
  }

  const spaces = await listSpaces(herdrApp);
  const here = localProjectSpaces(spaces, root);
  if (here.length > 1) throw new Error(manySpaces(here, root));
  const [space] = here;
  if (space?.id !== spaceId || spaces.filter(({ id }) => id === spaceId).length !== 1) {
    throw new Error(`herdr-app ls no longer uniquely identifies the project space ${spaceId}`);
  }
  const coordinatorTabs = space.tabs.filter(({ name }) => name === COORDINATOR_TAB);
  const old = coordinatorTabs.find(({ id }) => id === tabId);
  const replacement = coordinatorTabs.find(({ id }) => id === opened.tab);
  const allTabs = spaces.flatMap(({ tabs }) => tabs);
  if (coordinatorTabs.length !== 2 || !old || !replacement
    || [old, replacement].some(({ id }) => allTabs.filter((tab) => tab.id === id).length !== 1)) {
    throw new Error(`herdr-app ls does not uniquely show both ${COORDINATOR_TAB} tabs ${tabId} and ${opened.tab} in space ${spaceId}`);
  }
  const addresses = coordinatorTabAddresses(old);
  if (addresses.size !== terminals.length || terminals.some(({ address }) => !addresses.has(address))) {
    throw new Error(`herdr-app ls shows different terminals in the original ${COORDINATOR_TAB} tab ${tabId}`);
  }
  const replacementAddresses = coordinatorTabAddresses(replacement);
  if (replacementAddresses.size !== 1 || !replacementAddresses.has(opened.terminal)) {
    throw new Error(`herdr-app ls does not show ${opened.terminal} as the sole terminal in the replacement tab ${opened.tab}`);
  }
  const listedAddresses = allTabs.flatMap(({ terminals }) => Array.isArray(terminals) ? terminals.map((entry) => entry?.terminal) : []);
  if ([...addresses, opened.terminal].some((address) => listedAddresses.filter((listed) => listed === address).length !== 1)) {
    throw new Error('herdr-app ls shows ambiguous original or replacement terminal addresses');
  }
  for (const address of addresses) {
    if ((await readCoordinatorTerminal(hc, address)).running) {
      throw new Error(`the original ${COORDINATOR_TAB} terminal ${address} is now running`);
    }
  }
}

// Opens the coordinator in the project's space as a Coordinator tab, or in a new space named for the folder, using the installed
// runtime chosen for this open or the one saved on fetched main. The listing and the opening share `capLock`, so two opens
// cannot both create a tab. A Coordinator tab with a running or starting program is kept; one in which every terminal is positively
// stopped (finished, or a kept shell) is replaced. Exit 0 opened; 1 opening or cleanup failed; 3 the Herdr add-on is off on
// main; 5 a Coordinator tab with a running terminal is already open.
/** @param {{ root: string, login: string, runtimeOverride?: string, git: (args: string[]) => string, herdrApp: HerdrCommand, hc: HerdrCommand, capLock: <T>(work: () => Promise<T>) => Promise<T>, checkStandingLead?: () => void, print: (line: string) => void }} options */
export async function openCoordinator({ root, login, runtimeOverride, git, herdrApp, hc, capLock, checkStandingLead, print }) {
  try {
    git(['fetch', '--no-prune', 'origin', 'main']);
  } catch (error) {
    const { status } = /** @type {Error & { status?: number }} */ (error);
    print(`Coordinator not opened: git fetch --no-prune origin main failed${status === undefined ? '' : ` with exit ${status}`}.`);
    return 1;
  }
  let coordinator;
  try {
    coordinator = readCoordinator({ git, herdr: true, includeInstalled: true });
  } catch (error) {
    const { message, code } = /** @type {Error & { code?: string }} */ (error);
    print(`Coordinator not opened: ${message}`);
    return code === TURNED_OFF ? 3 : 1;
  }
  const runtime = runtimeOverride ?? coordinator.runtime;
  if (!coordinator.installed.includes(runtime)) {
    print(`Coordinator not opened: runtime ${runtime} is not installed in the project settings on fetched main.`);
    return 1;
  }
  try {
    return await capLock(async () => {
      checkStandingLead?.();
      let found;
      try {
        found = await coordinatorTerminals({ root, herdrApp, hc });
      } catch (error) {
        print(/** @type {Error} */ (error).message);
        return 1;
      }
      const { space, tab, terminals } = found;
      const soleTab = tab && space.tabs.length === 1;
      if (tab) {
        if (terminals.length === 0) {
          print(`Coordinator not opened: herdr-app ls lists the ${COORDINATOR_TAB} tab ${tab.id} with no terminal to prove stopped.`);
          return 1;
        }
        if (terminals.some(({ running }) => running)) {
          print(`The ${COORDINATOR_TAB} tab ${tab.id} is already open in space ${space.id}; use it.`);
          return 5;
        }
        if (!soleTab) await closeStoppedCoordinatorTab(herdrApp, tab.id);
      }
      const prompt = coordinatorPrompt(login);
      const argv = JSON.stringify(runtime === 'codex'
        ? [LAUNCH_PROGRAM, 'codex', '--no-daemon', '--enable', 'default_mode_request_user_input', '--', prompt]
        : [LAUNCH_PROGRAM, `ANTHROPIC_MODEL=${coordinator.model}`, `CLAUDE_CODE_EFFORT_LEVEL=${coordinator.effort}`, 'claude',
          '--permission-mode', 'auto', '--', prompt]);
      const opened = await herdrApp(space
        ? ['do', 'tab.new', '--space', space.id, '--name', COORDINATOR_TAB, '--folder', root, '--argv', argv]
        : ['do', 'space.new', '--name', basename(root), '--folder', root, '--tab', COORDINATOR_TAB, '--machine', '', '--argv', argv]);
      if (opened.code !== 0) {
        print(`Coordinator not opened: herdr-app could not open it: ${opened.stderr.trim() || `exit ${opened.code}`}`);
        return 1;
      }
      if (soleTab) {
        try {
          await verifySoleCoordinatorReplacement({ root, herdrApp, hc, spaceId: space.id, tabId: tab.id, terminals, reply: opened.stdout });
          await closeStoppedCoordinatorTab(herdrApp, tab.id);
        } catch (error) {
          print(`Herdr reported that the Coordinator opened. The original tab ${tab.id} was left for cleanup: ${/** @type {Error} */ (error).message}`);
          return 1;
        }
      }
      if (tab) print(`Replaced the ${COORDINATOR_TAB} tab ${tab.id}, in which nothing ran.`);
      print(`Coordinator opened in ${space ? `space ${space.id}` : `a new space named ${basename(root)}`}.`);
      return 0;
    });
  } catch (error) {
    print(`Coordinator not opened: ${/** @type {Error} */ (error).message}`);
    return 1;
  }
}

// What the tracker tools take: the raw `gh` the reads run and where the command prints.
/** @typedef {{ rawGh: (args: string[]) => string, print: (line: string) => void }} TrackerTools */

// The exit a command takes where GitHub refused one of its tracker reads for quota.
const HELD_EXIT = 6;

// `rawGh` through `ghExec`, as `{ gh, check, ended }`. A read GitHub refuses for quota records the reset GitHub named before it
// throws, so a refusal the card detail read swallows into an unavailable entry still leaves the record, and every later read of
// the command throws before it reaches GitHub; nothing is repeated. `gh` is marked `onePagePerRequest`, so the board reader asks
// one page per call and that check runs before each page. `check` throws where a read was refused; `ended(print)` prints the
// reset and returns exit 6, or returns undefined.
/** @param {(args: string[]) => string} rawGh */
function trackerGate(rawGh) {
  /** @type {number | undefined} */
  let until;
  const check = () => {
    if (until !== undefined) throw Object.assign(new Error('GitHub refused a tracker read for quota'), { code: 'TRACKER_HELD', until });
  };
  return {
    gh: Object.assign((args) => {
      check();
      try {
        return ghExec(args, rawGh);
      } catch (error) {
        const { code, resetAt } = /** @type {Error & { code?: string, resetAt?: number }} */ (error);
        if (code === 'GH_QUOTA') until = resetAt;
        throw error;
      }
    }, { onePagePerRequest: true }),
    check,
    ended(print) {
      if (until === undefined) return undefined;
      print(`GitHub refused a coordinator tracker read for quota; repeat it after ${new Date(until).toISOString()}.`);
      return HELD_EXIT;
    },
  };
}

// The startable Ready cards, `{ number, title }` in build order: the Ready cards the lead's own candidate rule takes on the
// board's facts, `readyOnBoard`, that are no proposal, in the board's own order; or undefined, printed why, when the read
// holds card content that did not resolve, so what is startable is unknown. One board read through the gated `gh`.
/** @param {(args: string[]) => string} gh @param {(line: string) => void} print */
function startableCards(gh, print) {
  const board = fetchBoard(gh);
  if (board.some(isContentUnresolved)) {
    print('The board read holds unresolved card content, so the startable Ready cards are unknown; ask again.');
    return undefined;
  }
  return sortForDisplay(pickable(board)).map(normalizeItem).filter((card) => readyOnBoard(card) && !cardIneligibility(card))
    .map(({ number, title }) => ({ number, title }));
}

// Prints the startable Ready cards in build order, one `#N title` line each. Exit 0; 1 when they are unknown; 6 when GitHub
// refused a read for quota.
/** @param {TrackerTools} tools */
export async function listCards({ print, ...tracker }) {
  const gate = trackerGate(tracker.rawGh);
  let cards;
  try {
    cards = startableCards(gate.gh, print);
  } catch (error) {
    const ended = gate.ended(print);
    if (ended === undefined) throw error;
    return ended;
  }
  const ended = gate.ended(print);
  if (ended !== undefined) return ended;
  if (!cards) return 1;
  if (cards.length === 0) print('There is no startable Ready card.');
  for (const { number, title } of cards) print(`${cardRef(number)} ${title}`);
  return 0;
}

// The terminals `hc ls` lists with the labels `labels` (`key=value` words), finished ones too where `all`, or throws, naming the
// cause, when it cannot list them.
async function jobTerminals(hc, labels, all = false) {
  const listing = await hc(['ls', ...labels.flatMap((label) => ['--label', label]), ...(all ? ['--all'] : []), '--json']);
  try {
    if (listing.code !== 0) throw new Error();
    const { terminals } = JSON.parse(listing.stdout);
    if (!Array.isArray(terminals)) throw new Error();
    return terminals;
  } catch {
    throw new Error(`hc ls could not list the job terminals: ${listing.stderr.trim() || `exit ${listing.code}`}`);
  }
}

// The `hc get --json` record of terminal `address` as `interpret` reads it, or throws, naming what it could not do (`reading`).
async function readRecord(hc, address, reading, interpret) {
  const read = await hc(['get', address, '--json']);
  try {
    if (read.code !== 0) throw new Error();
    return interpret(JSON.parse(read.stdout));
  } catch {
    throw new Error(`hc get ${address} could not ${reading}: ${read.stderr.trim() || (read.code === 0 ? 'unreadable reply' : `exit ${read.code}`)}`);
  }
}

// The program `startJob` launches a job through; Herdr's record keeps it as `argv[0]` until the program is lost.
const LAUNCH_PROGRAM = '/usr/bin/env';

// Whether the `hc ls` entry of terminal `address` is live, or throws, naming the address, where its state is no string.
function isLive(address, state) {
  if (typeof state !== 'string') throw new Error(`hc ls listed terminal ${address} with no readable state`);
  return state === 'live';
}

// What `hc get` reads of terminal `address`: whether it is `running` a program, its status and its labels. A live terminal
// is running when its foreground is a known runtime, is a different process from the terminal or uses the job launch form.
// A finished record is stopped. Throws when a field a live record needs cannot be read.
function interpretTerminal(record, live) {
  if (!live) return { running: false, status: undefined, labels: record.labels };
  const { pid, argv, foreground, status } = record;
  if (!Number.isInteger(pid) || !Number.isInteger(foreground.pid)) throw new Error();
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') throw new Error();
  if (status !== null && typeof status.state !== 'string') throw new Error();
  const runtime = foreground.name === 'claude' || foreground.name === 'codex';
  return { running: runtime || foreground.pid !== pid || argv[0] === LAUNCH_PROGRAM, status: status?.state, labels: record.labels };
}

// `interpretTerminal` over the `hc get --json` record of terminal `address`, or throws, naming the cause, when `hc get` cannot be read.
const readTerminal = (hc, address, live) => readRecord(hc, address, 'tell whether it is running and its status', (record) => interpretTerminal(record, live));

// A same-process foreground only proves a tab stopped if it is a recognized interactive shell with nothing to run.
const INTERACTIVE_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const interactiveShellName = (program) => basename(program).replace(/^-/, '');
function interpretCoordinatorTerminal(address, record) {
  if (record.state !== 'live' && record.state !== 'finished') throw new Error();
  const state = interpretTerminal(record, record.state === 'live');
  const foregroundName = record.foreground?.name;
  if (record.state === 'live') {
    if (record.pid <= 0 || record.foreground.pid <= 0 || typeof foregroundName !== 'string' || !foregroundName || !record.argv[0]
      || !record.argv.every((arg) => typeof arg === 'string')) {
      throw new Error();
    }
    const [program] = record.argv;
    if (foregroundName !== 'claude' && foregroundName !== 'codex' && program !== LAUNCH_PROGRAM) {
      if (!INTERACTIVE_SHELLS.has(interactiveShellName(program))) throw new Error();
      if (!state.running) {
        // Herdr keeps the launch arguments after its wrapper execs an interactive shell at the same PID.
        const argv = Object.hasOwn(record.foreground, 'argv') ? record.foreground.argv : record.argv;
        if (record.status !== null || !Array.isArray(argv) || !argv[0] || !argv.every((arg) => typeof arg === 'string')) throw new Error();
        const [current, ...options] = argv;
        const shell = interactiveShellName(current);
        if (!INTERACTIVE_SHELLS.has(shell) || shell !== foregroundName.replace(/^-/, '')
          || !options.every((option) => ['-i', '-l', '-li', '--login'].includes(option))) throw new Error();
      }
    }
  }
  return { address, state: record.state, foregroundName, ...state };
}

const readCoordinatorTerminal = (hc, address) => readRecord(hc, address, 'tell whether the Coordinator terminal is running', (record) => interpretCoordinatorTerminal(address, record));

function coordinatorTabAddresses(tab) {
  if (!Array.isArray(tab.terminals) || !tab.terminals.every((entry) => typeof entry?.terminal === 'string' && entry.terminal.length > 0)) {
    throw new Error(`herdr-app ls lists the ${COORDINATOR_TAB} tab ${tab.id} with terminals this command does not read`);
  }
  const addresses = new Set(tab.terminals.map(({ terminal }) => terminal));
  if (addresses.size !== tab.terminals.length) throw new Error(`herdr-app ls lists duplicate terminals in the ${COORDINATOR_TAB} tab ${tab.id}`);
  return addresses;
}

// The project space, its Coordinator tab (undefined where there is none) and the tab's terminals, each `{ address, state, running,
// foregroundName, status }` as `hc get` reads it, or throws, naming the cause, when the space holds more than one Coordinator tab,
// a tab or terminal identity is ambiguous, or a record cannot prove that the terminal is running or stopped.
export async function coordinatorTerminals({ root, herdrApp, hc }) {
  const spaces = await listSpaces(herdrApp);
  const here = localProjectSpaces(spaces, root);
  if (here.length > 1) throw new Error(manySpaces(here, root));
  const [space] = here;
  const tabs = space?.tabs.filter(({ name }) => name === COORDINATOR_TAB) ?? [];
  if (tabs.length > 1) {
    throw new Error(`herdr-app ls lists ${tabs.length} ${COORDINATOR_TAB} tabs (${tabs.map(({ id }) => id).join(', ')}) in space ${space.id}; close all but one`);
  }
  const [tab] = tabs;
  if (!tab) return { space, tab, terminals: [] };
  if (!tab.id || spaces.flatMap(({ tabs }) => tabs).filter(({ id }) => id === tab.id).length !== 1) {
    throw new Error(`herdr-app ls lists an ambiguous ${COORDINATOR_TAB} tab identity in space ${space.id}`);
  }
  const terminals = [];
  for (const address of coordinatorTabAddresses(tab)) {
    terminals.push(await readCoordinatorTerminal(hc, address));
  }
  return { space, tab, terminals };
}

// The line the board tools type into a coordinator when a card moves to Ready.
const WAKE_LINE = 'A card moved to Ready.';

// Types `WAKE_LINE` without force into a live Claude coordinator or, if no live Claude is present, a lone receptive Codex.
// Exit 0 sent; 4 no suitable target, with the reason printed; 1 a Herdr reply could not be read or the send failed.
export async function wakeCoordinator({ root, herdrApp, hc, print }) {
  let found;
  try {
    found = await coordinatorTerminals({ root, herdrApp, hc });
  } catch (error) {
    print(`The coordinator is not woken: ${/** @type {Error} */ (error).message}`);
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' ? 4 : 1;
  }
  const running = found.terminals.filter(({ state, running }) => state === 'live' && running);
  const claudes = running.filter(({ foregroundName }) => foregroundName === 'claude');
  const codex = claudes.length === 0 ? running.find(({ foregroundName }) => foregroundName === 'codex') : undefined;
  if (codex && running.length > 1) {
    print('The coordinator is not woken: more than one terminal is running in the Coordinator tab, so the target is ambiguous.');
    return 4;
  }

  let target = claudes.find(({ status }) => status !== 'blocked');
  if (codex && ['idle', 'done', 'working'].includes(codex.status)) target = codex;
  if (!target) {
    const blocked = claudes[0] ?? (codex?.status === 'blocked' ? codex : undefined);
    if (blocked) print(`The coordinator ${blocked.address} is asking the owner; it reads the board once the owner has answered.`);
    else if (codex?.status !== undefined) print(`The coordinator ${codex.address} is not woken: its status is ${JSON.stringify(codex.status)}.`);
    else if (running.length > 0) print('The coordinator is still starting; it reads the board at its start.');
    else print(`No coordinator is running Claude in ${found.tab ? `the ${COORDINATOR_TAB} tab ${found.tab.id}` : `a ${COORDINATOR_TAB} tab`}; open it with coordinator.mjs open.`);
    return 4;
  }
  const sent = await hc(['send', target.address, WAKE_LINE]);
  if (sent.code !== 0) {
    print(`The coordinator is not woken: hc send ${target.address} failed: ${sent.stderr.trim() || `exit ${sent.code}`}`);
    return 1;
  }
  print(`Woke the coordinator ${target.address}.`);
  return 0;
}

// Every job terminal record of card `card` in space `space`, finished ones included: its address, whether it is live, and what
// `readTerminal` reads of it.
async function jobRecords({ hc, space, card }) {
  const records = [];
  for (const { address, state } of await jobTerminals(hc, ['fabraik.role=job', `fabraik.space=${space}`, `fabraik.card=${card}`], true)) {
    const live = isLive(address, state);
    records.push(await readRecord(hc, address, 'tell whether it is running and its status', (native) => ({
      address, live, native, ...interpretTerminal(native, live),
    })));
  }
  return records;
}

// The diagnosis kind of a live job terminal the coordinator has stopped, from its `fabraik.stopped` label, or undefined where
// it has none or the job is `working` again.
const stoppedKind = ({ labels, status }) => (status === 'working' ? undefined : labels?.['fabraik.stopped'] || undefined);

// The cards of the job terminals, machine-wide, that take a running place: live, running a program, not `blocked` on the owner
// and not stopped (see stoppedKind). A job just started, with no status yet, takes one. A terminal with no card label in its `hc get` record is named by its address.
async function placesTaken(hc) {
  const taken = [];
  for (const { address, state } of await jobTerminals(hc, ['fabraik.role=job'])) {
    if (!isLive(address, state)) continue;
    const { running, status, labels } = await readTerminal(hc, address, true);
    if (running && status !== 'blocked' && !stoppedKind({ labels, status })) taken.push(labels?.['fabraik.card'] ?? address);
  }
  return taken;
}

const JOB_BRANCH_REF = /^refs\/heads\/job\/([1-9]\d*)$/;
const JOB_BRANCH = /^job\/([1-9]\d*)$/;
const FULL_COMMIT = new RegExp('^' + COMMIT_TEXT + '$');
const DRAFT_LIMIT = 100;
const DRAFT_READ = ['pr', 'list', '--state', 'open', '--draft', '--json', 'number,headRefName', '--limit', String(DRAFT_LIMIT)];
// The Status columns a job is underway in; a card in any other column is held there.
const UNDERWAY_STATUSES = ['Ready', 'In progress', 'In review', 'Awaiting push'];
// The column a Herdr job waits in only for the show-me-first marker; an unmarked card there waits on the owner.
const AWAITING_PUSH = 'Awaiting push';
// A second copy of owner-queue.mjs's, whose import graph this tool does not take on.
const CLOUD_RUNTIME = 'Claude Code cloud';
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

// What `work` returns, or a throw naming `what` could not be read and why.
function readOf(what, work) {
  try {
    return work();
  } catch (error) {
    throw new Error(`${what} could not be read: ${oneLine(/** @type {Error} */ (error).message)}`);
  }
}

// Registered job worktrees by card. A job branch names its card, wherever it is registered. A detached job must be in
// one of the two job layouts. Git paths and card identities must be unambiguous.
function registeredWorktrees(root, git) {
  const records = readOf('the worktrees', () => parseWorktreeList(git(['worktree', 'list', '--porcelain', '-z'])));
  if (!records) throw new Error('the worktrees could not be read: git worktree list printed an unreadable registry');
  const legacy = join(root, '.claude', 'worktrees');
  const siblings = join(dirname(root), 'jobs');
  const paths = new Set();
  /** @type {Map<number, string>} */
  const worktrees = new Map();
  for (const record of records) {
    const { path, HEAD, branch } = record;
    if (join(path) !== path || paths.has(path)) throw new Error(`the worktree path ${path} is malformed or registered more than once`);
    paths.add(path);
    if ('bare' in record) continue;
    const detached = 'detached' in record;
    if (!FULL_COMMIT.test(HEAD) || (detached ? record.detached !== '' || 'branch' in record : !branch?.startsWith('refs/heads/'))) {
      throw new Error(`the worktree record for ${path} has no valid HEAD and branch or detached state`);
    }
    const folder = basename(path);
    const layoutCard = dirname(path) === siblings ? /^([1-9]\d*)$/.exec(folder)?.[1]
      : dirname(path) === legacy ? /^job-([1-9]\d*)$/.exec(folder)?.[1] : undefined;
    const branchCard = JOB_BRANCH_REF.exec(branch ?? '')?.[1];
    if (branchCard && layoutCard && branchCard !== layoutCard) {
      throw new Error(`the worktree ${path} identifies different cards by path and branch ${branch}`);
    }
    const card = Number(detached ? layoutCard : branchCard);
    if (!card) continue;
    if (worktrees.has(card)) throw new Error(`more than one worktree is registered for card ${card}`);
    worktrees.set(card, path);
  }
  return worktrees;
}

// The cards with a local branch job/N, a registered job worktree or an open draft pull request from a branch job/N, in card
// order: card → `{ branch, worktree, draft }`, with the worktree's registered path and the pull request's number.
/** @param {{ worktrees: Map<number, string>, git: (args: string[]) => string, gh: (args: string[]) => string }} reads */
function jobSources({ worktrees, git, gh }) {
  /** @type {Map<number, { branch: boolean, worktree: string | undefined, draft: number | undefined }>} */
  const sources = new Map();
  const of = (card) => {
    let source = sources.get(card);
    if (!source) sources.set(card, (source = { branch: false, worktree: undefined, draft: undefined }));
    return source;
  };
  for (const ref of readOf('the job branches', () => git(['for-each-ref', '--format=%(refname)', 'refs/heads/job/'])).split(/\r?\n/)) {
    const card = JOB_BRANCH_REF.exec(ref)?.[1];
    if (card) of(Number(card)).branch = true;
  }
  for (const [card, path] of worktrees) of(card).worktree = path;
  const drafts = readOf('the open draft pull requests', () => JSON.parse(gh(DRAFT_READ)));
  if (!Array.isArray(drafts) || !drafts.every((pull) => Number.isInteger(pull?.number) && typeof pull.headRefName === 'string')) {
    throw new Error('the open draft pull requests could not be read: gh pr list printed no list of pull requests');
  }
  if (drafts.length >= DRAFT_LIMIT) throw new Error(`the open draft pull requests could not all be read: gh pr list reached its limit of ${DRAFT_LIMIT}`);
  for (const { number, headRefName } of drafts) {
    const card = JOB_BRANCH.exec(headRefName)?.[1];
    if (card && of(Number(card)).draft === undefined) of(Number(card)).draft = number;
  }
  return new Map([...sources].sort(([a], [b]) => a - b));
}

// The address of a live terminal running a program for each card of `worktrees` (card → its job worktree): one labelled as
// the card's job in space `space`, where there is one, or one whose folder is the card's job worktree or inside it. Each is
// judged by `readTerminal`, so a shell kept in place of a lost program is not running. A running holder wins over a
// stopped job. Throws when a listing or the record of a listed or matched terminal cannot be read.
/** @param {{ hc: HerdrCommand, space: string | undefined, worktrees: Map<number, string | undefined>, except?: string }} options */
async function runningTerminals({ hc, space, worktrees, except }) {
  /** @type {Map<number, { address: string, stopped: string | undefined }>} */
  const running = new Map();
  const read = new Map();
  const judge = async (address, card) => {
    if (address === except && except !== undefined) return;
    if (!read.has(address)) read.set(address, await readTerminal(hc, address, true));
    const { running: runs, status, labels } = read.get(address);
    const owner = card ?? Number(labels?.['fabraik.card']);
    if (!runs || !worktrees.has(owner)) return;
    const stopped = stoppedKind({ labels, status });
    const previous = running.get(owner);
    if (!previous || (previous.stopped && !stopped)) running.set(owner, { address, stopped });
  };
  if (space) {
    for (const { address, state } of await jobTerminals(hc, ['fabraik.role=job', `fabraik.space=${space}`])) {
      if (isLive(address, state)) await judge(address, undefined);
    }
  }
  for (const { address, state, cwd } of await jobTerminals(hc, [])) {
    if (!isLive(address, state)) continue;
    if (read.has(address) && cwd === undefined) continue;
    if (typeof cwd !== 'string') throw new Error(`hc ls listed terminal ${address} with no readable folder`);
    for (const [card, path] of worktrees) {
      if (path && (cwd === path || cwd.startsWith(path + sep))) await judge(address, card);
    }
  }
  return running;
}

// The verdict on each card of `sources` (see jobSources), in card order, as `{ card, verdict, detail }` and, on `stopped`, the
// terminal's `address`, the first that applies after the card is known and its comments were read: `running` where
// `running` (see runningTerminals) names a terminal that is not stopped; `held` where its board card in `cards`
// is closed or a proposal, its comments in `details` (fetchCardDetails) hold one whose first line starts `Needs owner:`, its
// column is not one of UNDERWAY_STATUSES, or it is in AWAITING_PUSH without the show-me-first marker; `stopped` where `running` names a terminal the coordinator has stopped, with its kind,
// and no hold applies; `elsewhere` where it has only a draft pull request and its newest claim names no claim, another
// machine than `hostname` or a cloud build; else `continue`, naming its sources. An open card is in `cards` only
// from the board read, so one absent from it throws, as does one whose comments could not be read, whose older comments
// were not read and the answer depends on them, or a card in AWAITING_PUSH with a label that is not text.
function unfinishedVerdicts({ root, sources, cards, details, running, hostname }) {
  return [...sources].map(([card, { branch, worktree, draft }]) => {
    const verdict = (kind, detail, address) => ({ card, verdict: kind, detail, ...(address && { address }) });
    const terminal = running.get(card);
    const board = cards.get(card);
    if (!board) throw new Error(`card ${cardRef(card)} is open but not on the board read`);
    const read = details.get(card);
    if (read.unavailable !== undefined) throw new Error(`card ${cardRef(card)}'s comments could not be read: ${read.unavailable}`);
    if (terminal && !terminal.stopped) return verdict('running', `terminal ${terminal.address}`);
    if (board.state !== 'OPEN') return verdict('held', 'its card is closed');
    if (cardIneligibility(board)) return verdict('held', 'its card is a proposal');
    if (read.comments.some((comment) => comment.trimStart().startsWith('Needs owner:'))) return verdict('held', 'its card has a Needs owner: comment');
    // A Needs owner: comment or the newest claim may be among the older comments.
    if (read.commentsUnavailable !== null) throw new Error(`card ${cardRef(card)}'s older comments were not read: ${read.commentsUnavailable}`);
    if (!UNDERWAY_STATUSES.includes(board.status)) return verdict('held', `its card is in ${board.status}`);
    if (board.status === AWAITING_PUSH && !showFirstAmong(card, board.labels)) return verdict('held', `its card is in ${AWAITING_PUSH} without show-me-first`);
    if (terminal) return verdict('stopped', `${terminal.stopped}, terminal ${terminal.address}`, terminal.address);
    if (!branch && !worktree) {
      const { machine, runtime } = newestClaim(read.comments);
      const pull = `draft pull request ${cardRef(draft)}`;
      if (machine === undefined) return verdict('elsewhere', `${pull}, no claim names this machine`);
      if (machine !== hostname || runtime === CLOUD_RUNTIME) return verdict('elsewhere', `${pull}, claimed by ${[machine, runtime].filter(Boolean).join(', ')}`);
    }
    const named = [branch && `branch job/${card}`, worktree && `worktree ${relative(root, worktree)}`, draft !== undefined && `draft pull request ${cardRef(draft)}`];
    return verdict('continue', named.filter(Boolean).join(', '));
  });
}

// The verdicts of unfinishedVerdicts on the unfinished jobs, or on card `only`'s alone where it is given, an empty list where
// there is none. It reads the repository's job branches and worktrees through `git`, the open draft pull requests, the board
// and the comments of each card found through the gated `gh`, and Herdr through `hc`. A card missing from the board read is
// read from its issue: a closed one enters `cards` as closed, an open one throws in unfinishedVerdicts, and one whose issue cannot
// be read throws here, naming the card and the cause; it throws, naming the cause, where any read fails.
/** @param {{ root: string, git: (args: string[]) => string, gate: ReturnType<typeof trackerGate>, hc: HerdrCommand, space: string | undefined, hostname: string, only?: number, worktrees?: Map<number, string>, except?: string }} reads */
async function unfinishedJobs({ root, git, gate, hc, space, hostname, only, worktrees = registeredWorktrees(root, git), except }) {
  const { gh } = gate;
  const sources = jobSources({ worktrees, git, gh });
  if (only !== undefined) for (const card of sources.keys()) if (card !== only) sources.delete(card);
  if (sources.size === 0) return [];
  const numbers = [...sources.keys()];
  const cards = new Map(readOf('the board', () => fetchBoard(gh)).map(normalizeItem).map((card) => [card.number, card]));
  for (const card of numbers) {
    if (cards.has(card)) continue;
    const { state } = readOf(`card ${cardRef(card)}'s issue`, () => JSON.parse(gh(['issue', 'view', String(card), '--repo', claimRepository, '--json', 'state'])));
    if (state === 'CLOSED') cards.set(card, { state });
  }
  const details = fetchCardDetails(gh, numbers);
  gate.check();
  const running = await runningTerminals({ hc, space, except, worktrees: new Map([...sources].map(([card, { worktree }]) => [card, worktree])) });
  return unfinishedVerdicts({ root, sources, cards, details, running, hostname });
}

const verdictLine = ({ card, verdict, detail }) => `${cardRef(card)} ${verdict}: ${detail}`;

// Prints one line per unfinished job in card order, `#N <verdict>: <detail>` (see unfinishedVerdicts), or that there is none.
// A job is unfinished where its card has a local branch job/N, a job worktree or an open draft pull request. Exit 0 complete;
// 1 where any read fails or answers what it does not read: it prints `Unfinished jobs unknown: <cause>` and no verdict, since
// a job that cannot be seen is not gone.
/** @param {TrackerTools & { root: string, herdrApp: HerdrCommand, hc: HerdrCommand, git: (args: string[]) => string, hostname: string }} options */
export async function listUnfinished({ root, herdrApp, hc, git, hostname, print, ...tracker }) {
  const gate = trackerGate(tracker.rawGh);
  let verdicts;
  try {
    const here = (await listSpaces(herdrApp)).filter(({ folder, machine }) => folder === root && machine === null);
    if (here.length > 1) throw new Error(manySpaces(here, root));
    verdicts = await unfinishedJobs({ root, git, gate, hc, space: here[0]?.id, hostname });
  } catch (error) {
    const ended = gate.ended(print);
    if (ended !== undefined) return ended;
    print(`Unfinished jobs unknown: ${oneLine(/** @type {Error} */ (error).message)}`);
    return 1;
  }
  const ended = gate.ended(print);
  if (ended !== undefined) return ended;
  if (verdicts.length === 0) print('There is no unfinished job.');
  for (const verdict of verdicts) print(verdictLine(verdict));
  return 0;
}

const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The RUN_START form merge-evidence.mjs reads; a second copy, because that module does not export it and is outside this tool.
const RUN_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const ROOT_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BIND_FIELDS = 'card,parentAddress,repositoryId,root,runStart,terminalAddress,terminalCreatedMs,threadId,version';

// Both the host writer and the reader locate the acknowledgment from the canonical root and native address.
export function codexBindingPath(root, address, env = process.env) {
  if (process.platform !== 'linux') throw new Error('Codex bind records require Linux');
  if (!managedPath(root) || realpathSync(root) !== root) throw new Error('Codex bind root is not canonical');
  if (typeof address !== 'string' || !LOCAL_HERDR_TERMINAL.test(address)) throw new Error('Codex bind terminal address is not local');

  const state = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  if (!managedPath(state)) throw new Error('Codex bind state path must be physical and absolute');
  const key = createHash('sha256').update(`${root}\0${address}`).digest('hex');
  return join(state, 'fabraik-lead', 'codex-delivery', `bind-${key}.json`);
}

// The host acknowledgment for this canonical root and address, or an error naming the unavailable check.
export function readCodexBinding({ root, address, env = process.env }) {
  const path = codexBindingPath(root, address, env);
  const delivery = dirname(path);
  const lead = dirname(delivery);
  let binding;
  try {
    for (const folder of [lead, delivery]) {
      if (!isCanonicalLeadFolder(folder)) throw new Error(`${basename(folder)} must be an owned, physical 0700 directory`);
    }
    // Name link refusals before the checked reader independently verifies the opened file's identity and permissions.
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('record is a symbolic link');
    if (entry.isFile() && entry.nlink !== 1) throw new Error('record is not a single-link file');
    binding = readManagedRecord(path);
  } catch (error) {
    const cause = /** @type {Error} */ (error).message;
    throw new Error(`Codex bind record could not be read: ${cause}`);
  }
  return validateCodexBinding(binding, root, address);
}

/** @typedef {{ version: 1, root: string, repositoryId: string, card: number, runStart: string, terminalAddress: string, terminalCreatedMs: number, parentAddress: string, threadId: string }} CodexBinding */

/** @returns {CodexBinding} */
function validateCodexBinding(binding, root, address) {
  if (!binding || typeof binding !== 'object' || Object.keys(binding).sort().join(',') !== BIND_FIELDS || binding.version !== 1) {
    throw new Error('Codex bind record has an invalid schema or version');
  }
  if (binding.root !== root) throw new Error('Codex bind record has a different root');
  if (binding.terminalAddress !== address) throw new Error('Codex bind record has a different terminal address');
  if (typeof binding.repositoryId !== 'string' || !/^[A-Za-z0-9_+/=-]+$/.test(binding.repositoryId)) {
    throw new Error('Codex bind record has an invalid repository ID');
  }
  if (!Number.isSafeInteger(binding.card) || binding.card < 1) throw new Error('Codex bind record has an invalid card');
  const run = typeof binding.runStart === 'string' && RUN_START.test(binding.runStart) ? Date.parse(binding.runStart) : NaN;
  if (!Number.isFinite(run) || new Date(run).toISOString() !== binding.runStart.replace('Z', '.000Z')) {
    throw new Error('Codex bind record has an invalid UTC run start');
  }
  if (!Number.isSafeInteger(binding.terminalCreatedMs) || binding.terminalCreatedMs < 1) {
    throw new Error('Codex bind record has an invalid terminal creation time');
  }
  if (typeof binding.parentAddress !== 'string' || !LOCAL_HERDR_TERMINAL.test(binding.parentAddress) || binding.parentAddress === address) {
    throw new Error('Codex bind record has an invalid parent address');
  }
  if (typeof binding.threadId !== 'string' || !ROOT_THREAD.test(binding.threadId)) throw new Error('Codex bind record has an invalid root thread');
  return binding;
}

// The shell's inherited values locate and correlate the host acknowledgment. Herdr supplies the current terminal identity.
/** @param {{ root: string, hc: HerdrCommand }} options */
export async function readLiveCodexBinding({ root, hc }) {
  const { HC_TERMINAL_ID: address, CODEX_THREAD_ID: thread } = process.env;
  if (!address || !LOCAL_HERDR_TERMINAL.test(address)) throw new Error('HC_TERMINAL_ID must name a local terminal');
  if (!thread || !ROOT_THREAD.test(thread)) throw new Error('CODEX_THREAD_ID must name a canonical root thread');
  const live = await readRecord(hc, address, 'read the live terminal for binding', (record) => record);
  if (live?.address !== address) throw new Error('Herdr reported a different terminal address');
  if (live.state !== 'live') throw new Error('the Herdr terminal is not live');
  if (live.cwd !== root) throw new Error('the live Herdr cwd does not match the canonical root');
  const labels = live.labels;
  if (labels?.['fabraik.role'] !== 'job') throw new Error('the live Herdr role is not job');
  if (labels['fabraik.runtime'] !== 'codex') throw new Error('the live Herdr runtime is not Codex');

  const binding = readCodexBinding({ root, address });
  if (live.created_ms !== binding.terminalCreatedMs) throw new Error('the live Herdr terminal creation time differs from the bind record');
  if (live.parent !== binding.parentAddress) throw new Error('the live Herdr parent differs from the bind record');
  if (labels['fabraik.card'] !== String(binding.card)) throw new Error('the live Herdr card differs from the bind record');
  if (labels['fabraik.runstart'] !== binding.runStart) throw new Error('the live Herdr run start differs from the bind record');
  if (thread !== binding.threadId) throw new Error('CODEX_THREAD_ID differs from the bind record thread');
  return binding;
}

// The labels a resumed session's replacement must carry with the same values as the records it replaces.
const RESUMED_LABELS = ['fabraik.card', 'fabraik.session', 'fabraik.runstart', 'fabraik.workflow'];
const CODEX_JOB_FLAGS = ['--no-daemon', '--enable', 'default_mode_request_user_input'];
const CODEX_LAUNCH_HELD = 'Codex child launch is held pending job binding and guard activation';
const WORKFLOW_ROOT_MARK = 'FABRAIK_WORKFLOW_ROOT=';
const ENVIRONMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The launch marks of a job; only a Claude job carries its pinned workflow root `workflowRoot`.
const jobLaunchMarks = (card, runStart, workflowRoot) => [LAUNCH_PROGRAM, `PRE_APPROVED_RUN_SESSION=${runStart}`,
  `PRE_APPROVED_RUN_CARD=${card}`, 'FABRAIK_COORDINATED_JOB=1', ...(workflowRoot === undefined ? [] : [`${WORKFLOW_ROOT_MARK}${workflowRoot}`])];

// Leaves the store's copy of `commit` verified, repairing it, which prints the paths it moves, where it fails the check.
function ensureWorkflowSnapshot(root, commit, dir) {
  try {
    verifyWorkflowSnapshot({ cwd: root, commit, dir });
  } catch {
    repairWorkflowSnapshot({ cwd: root, commit });
  }
}

// The workflow version one Claude job record claims: `{ commit, mark }` from the workflow root mark its retained launch argv
// carries, which its `fabraik.workflow` label must match; `{ commit }` from the label alone where Herdr kept no launch argv,
// as on a restored shell; null for a pre-pin record, which has neither; or `{ cause }`.
function recordWorkflow({ address, native, labels }) {
  const label = labels?.['fabraik.workflow'];
  const argv = Array.isArray(native?.argv) ? native.argv : [];
  const launched = argv[0] === LAUNCH_PROGRAM;
  const program = argv.findIndex((word, i) => i > 0 && !ENVIRONMENT_WORD.test(word));
  const environment = launched ? argv.slice(1, program === -1 ? argv.length : program) : [];
  const marks = environment.filter((word) => word.startsWith(WORKFLOW_ROOT_MARK)).map((word) => word.slice(WORKFLOW_ROOT_MARK.length));
  if (marks.length > 1) return { cause: `its record ${address} carries more than one workflow root mark` };
  const [mark] = marks;
  if (mark !== undefined) {
    const commit = basename(mark);
    if (!FULL_COMMIT.test(commit)) return { cause: `its record ${address} carries the workflow root mark ${mark}, which names no commit` };
    if (label !== commit) return { cause: `its record ${address} carries the workflow root mark ${mark} but the fabraik.workflow label ${label}` };
    return { commit, mark };
  }
  if (label === undefined) return null;
  if (launched) return { cause: `its record ${address} carries the fabraik.workflow label ${label} but no workflow root mark` };
  if (typeof label !== 'string' || !FULL_COMMIT.test(label)) return { cause: `its record ${address} carries the fabraik.workflow label ${label}, which is no commit` };
  return { commit: label };
}

/** @typedef {{ status: 'ready', executable: string, verifyExecutable: () => void }} CodexHookPreflight */

const isCodexExecutablePath = (path) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && basename(path) === 'codex';
const CODEX_RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// A versioned install keeps a normal update from replacing the executable that answered hooks/list.
/** @param {string} executable
 * @param {(release: string) => string} findRelease */
export function requireVersionedCodex(executable, findRelease) {
  const diagnosis = 'the native executable does not match a version-addressed mise Codex installation';
  if (!isCodexExecutablePath(executable)) throw new Error(diagnosis);
  const releaseDir = dirname(dirname(executable));
  const release = basename(releaseDir);
  if (!CODEX_RELEASE.test(release) || executable !== join(releaseDir, 'bin', 'codex')) throw new Error(diagnosis);
  try {
    if (lstatSync(executable).isFile() && realpathSync.native(executable) === executable) {
      accessSync(executable, constants.X_OK);
      if (findRelease(release) === releaseDir) return;
    }
  } catch (cause) {
    throw new Error(diagnosis, { cause });
  }
  throw new Error(diagnosis);
}

// A Codex record with a lost label must not fall through to the historic Claude session-label path.
function isCodexJobRecord({ native }) {
  const argv = Array.isArray(native.argv) ? native.argv : [];
  const executable = argv[0] === LAUNCH_PROGRAM ? argv.slice(1).find((arg) => typeof arg === 'string' && !arg.includes('=')) : argv[0];
  return native.labels?.['fabraik.runtime'] === 'codex' || native.agent === 'codex' || native.foreground?.name === 'codex'
    || (typeof executable === 'string' && basename(executable) === 'codex');
}

/** @param {{ root: string, card: number, space: string, address: string, prior?: CodexBinding, parent?: string, argv?: string[], replacement?: boolean }} options */
function boundCodexJob(native, receipt, options) {
  const { root, card, space, address, prior, parent, argv, replacement = false } = options;
  if (receipt == null) throw new Error(`the Codex binding at ${address} is unavailable`);
  const binding = validateCodexBinding(receipt, root, address);
  const labels = native?.labels;
  if (native?.address !== address || native.keep !== true || native.cwd !== root
    || native.created_ms !== binding.terminalCreatedMs || native.parent !== binding.parentAddress
    || (parent !== undefined && native.parent !== parent) || binding.card !== card
    || labels?.['fabraik.role'] !== 'job' || labels['fabraik.space'] !== space || labels['herdr.space'] !== space
    || labels['fabraik.runtime'] !== 'codex' || labels['fabraik.card'] !== String(card) || labels['fabraik.runstart'] !== binding.runStart) {
    throw new Error(`the Codex binding does not match the native job record at ${address}`);
  }
  if (prior && (binding.repositoryId !== prior.repositoryId || binding.runStart !== prior.runStart || binding.threadId !== prior.threadId)) {
    throw new Error(`the Codex binding at ${address} does not preserve the original repository, run and thread`);
  }
  if (!Array.isArray(native.argv) || !native.argv.every((arg) => typeof arg === 'string')) {
    throw new Error(`the Codex job at ${address} has unreadable native launch arguments`);
  }
  const marks = jobLaunchMarks(card, binding.runStart);
  const executable = native.argv[marks.length];
  const expected = argv ?? [...marks, isCodexExecutablePath(executable) ? executable : 'codex', ...CODEX_JOB_FLAGS];
  const hasLaunch = (!argv || native.argv.length === argv.length) && expected.every((arg, i) => native.argv[i] === arg);
  if (replacement) {
    const foreground = native.foreground;
    if (!hasLaunch || native.state !== 'live' || foreground?.name !== 'codex' || foreground.cwd !== root
      || !Number.isInteger(foreground.pid) || foreground.pid < 1) {
      throw new Error(`the replacement at ${address} lacks its expected native Codex launch and foreground`);
    }
  } else {
    // Herdr can restore an idle shell in the same kept terminal, replacing its original argv.
    const shell = native.argv.length === 1 && INTERACTIVE_SHELLS.has(basename(native.argv[0]));
    const idle = shell && native.state === 'live' && !interpretCoordinatorTerminal(address, native).running;
    if ((!idle && !(native.state === 'finished' && (hasLaunch || (!argv && shell)))) || (argv && !hasLaunch)) {
      throw new Error(`the Codex predecessor at ${address} is not a confirmed stopped record`);
    }
  }
  return binding;
}

const claimRepository = `${BOARD_OWNER}/${BOARD_REPOSITORY}`;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function readClaimState(gh, card) {
  const { state, assignees, comments } = readOf('the claim card', () => JSON.parse(gh([
    'issue', 'view', String(card), '--repo', claimRepository, '--json', 'state,assignees,comments',
  ])));
  if (typeof state !== 'string' || !Array.isArray(assignees) || !assignees.every((entry) => nonempty(entry?.login))
    || !Array.isArray(comments) || !comments.every((entry) => typeof entry?.body === 'string')) {
    throw new Error('the card state, assignees or comments are incomplete');
  }
  const rows = fetchBoard(gh);
  const cards = rows.filter(({ content }) => content?.number === card);
  if (cards.length !== 1 || !nonempty(cards[0].id) || rows.some(isContentUnresolved)) {
    throw new Error('the board does not show one unambiguous card');
  }
  const [item] = cards;
  const board = { ...normalizeItem(item), id: item.id };
  const logins = assignees.map(({ login }) => login).sort();
  const index = comments.findLastIndex(({ body }) => isClaim(body));
  return { state, board, logins, comments, claim: comments[index], position: index + 1 };
}

function claimStateEligible(read, status, login) {
  const { state, board, logins, comments } = read;
  return state === 'OPEN' && board.status === status && !cardIneligibility(board)
    && readyOnBoard({ ...board, status: 'Ready', assignees: [] })
    && isDeepStrictEqual([...board.assignees].sort(), logins) && logins.every((assignee) => assignee === login)
    && !comments.some(({ body }) => body.trimStart().startsWith('Needs owner:'));
}

function verifiedClaim(read, { card, runStart }, login) {
  if (!nonempty(login) || !claimStateEligible(read, 'In progress', login)) throw new Error('the card is not eligible for stale claim repair');
  const { claim, comments } = read;
  const prefix = `https://github.com/${claimRepository}/issues/${card}#issuecomment-`;
  const claimedAt = Date.parse(claim?.createdAt);
  if (!nonempty(claim?.id) || claim.author?.login !== login || !RUN_START.test(claim.createdAt)
    || !(claimedAt >= Date.parse(runStart)) || new Date(claimedAt).toISOString() !== claim.createdAt.replace('Z', '.000Z')
    || newestClaim([claim.body]).runtime !== 'Codex'
    || typeof claim.url !== 'string' || !claim.url.startsWith(prefix) || !/^[1-9]\d*$/.test(claim.url.slice(prefix.length))
    || comments.filter((comment) => comment.id === claim.id || comment.url === claim.url).length !== 1) {
    throw new Error('the card has no unique current claim by this Codex job account since its run start');
  }
}

function verifyClaimHistory(items, binding, { claim, position, comments }, login) {
  if (!Array.isArray(items) || !items.every((entry) => nonempty(entry?.item?.id) && nonempty(entry.item.type) && nonempty(entry.turnId))
    || new Set(items.map(({ item }) => item.id)).size !== items.length) throw new Error('Codex claim history contains malformed or duplicate items');
  const command = new RegExp(`^/usr/bin/bash -lc 'node scripts/board-claim\\.mjs ${binding.card} --intake [A-Za-z0-9_./-]+ --runtime (?:Codex|"Codex")'$`);
  const matches = items.filter(({ item, completedAtMs }) => item.type === 'commandExecution' && typeof item.command === 'string'
    && command.exec(item.command)?.[0] === item.command
    && !(Number.isSafeInteger(completedAtMs) && completedAtMs > 0 && completedAtMs < binding.terminalCreatedMs));
  const [entry] = matches;
  const completed = entry?.completedAtMs;
  if (matches.length !== 1 || entry.item.cwd !== binding.root || entry.item.status !== 'completed' || entry.item.exitCode !== 0
    || entry.outputDeferred || !Number.isSafeInteger(completed) || completed < binding.terminalCreatedMs
    || completed < Date.parse(binding.runStart) || completed < Date.parse(claim.createdAt)
    || (entry.startedAtMs != null && (!Number.isSafeInteger(entry.startedAtMs) || entry.startedAtMs > completed))
    || typeof entry.item.aggregatedOutput !== 'string') throw new Error('no unique completed native Codex claim command proves this run');

  const lines = entry.item.aggregatedOutput.trimEnd().split(/\r?\n/);
  const wrote = `wrote: ${JSON.stringify(['claim', claim.body, claim.url])}`;
  const after = `after: ${JSON.stringify(['claim', position, login, claim.createdAt, claim.url, claim.body.trimStart().split(/[\r\n]/, 1)[0]])}`;
  const outcome = `outcome: Free: the session's own claim, comment ${position} at ${claim.url}, is the first new claim, so it holds the card`;
  const count = Number(/^after: \["comments",([1-9]\d*)\]$/.exec(lines.at(-2) ?? '')?.[1]);
  const writes = lines.filter((line) => line.startsWith('wrote: ["claim",'));
  const afterClaims = lines.filter((line) => line.startsWith('after: ["claim",')
    && (line.startsWith(`after: ["claim",${position},`) || line.includes(JSON.stringify(claim.url))));
  if (lines.at(-1) !== outcome || lines.filter((line) => line.startsWith('outcome: ')).length !== 1
    || !Number.isSafeInteger(count) || count < position || count > comments.length
    || writes.length !== 1 || writes[0] !== wrote || afterClaims.length !== 1 || afterClaims[0] !== after
    || lines.indexOf(wrote) >= lines.indexOf(after)) throw new Error('the Codex claim receipt does not match the newest tracker claim');
}

function repairedClaimState(read, before) {
  return claimStateEligible(read, 'Ready', undefined) && read.board.id === before.board.id && isDeepStrictEqual(read.claim, before.claim);
}

function repairClaim(gh, card, login, before, print) {
  let step = 'remove the assignee';
  let writeFailure;
  try {
    if (before.logins.length) gh(['issue', 'edit', String(card), '--repo', claimRepository, '--remove-assignee', login]);
    step = 'move the card to Ready';
    moveCards([{ issueNumber: card, statusName: 'Ready' }], gh);
  } catch (error) {
    writeFailure = `could not confirm the attempt to ${step}: ${oneLine(/** @type {Error} */ (error).message)}`;
  }
  let readBack;
  try {
    readBack = readClaimState(gh, card);
  } catch (error) {
    throw new Error(`${writeFailure ? `${writeFailure}; ` : ''}stale claim repair read-back failed: ${oneLine(/** @type {Error} */ (error).message)}`);
  }
  if (writeFailure || !repairedClaimState(readBack, before)) {
    throw new Error(`${writeFailure ? `${writeFailure}; ` : ''}stale claim repair read-back shows ${readBack.state}, ${readBack.board.status}, assignees ${JSON.stringify(readBack.logins)}; eligibility for resume is unconfirmed`);
  }
  print(`Card ${card}'s stale Codex claim was repaired and verified Ready and unassigned.`);
  return readBack;
}

// The session card `card`'s job `records` hold, and whether it can be resumed: `{ session, runStart, workflow }`, its workflow
// `{ commit, mark? }` or undefined for a pre-pin job (see recordWorkflow), or `{ session, cause }` where the records disagree,
// a label is malformed, or `transcript(session)` finds no regular transcript file ('file'; 'link' or undefined refuse). The
// session is checked as a v4 UUID before it names any path.
function recordedSession(records, transcript) {
  const recorded = (label) => [...new Set(records.map(({ labels }) => labels?.[label]))];
  const sessions = recorded('fabraik.session');
  const runStarts = recorded('fabraik.runstart');
  const [session] = sessions;
  const [runStart] = runStarts;
  if (sessions.length > 1) {
    return { session, cause: `its records carry different sessions (${records.map(({ address, labels }) => `${address} ${labels?.['fabraik.session']}`).join(', ')})` };
  }
  if (typeof session !== 'string' || !V4_UUID.test(session)) return { session, cause: 'its fabraik.session label is no v4 UUID' };
  if (runStarts.length > 1) return { session, cause: `its records carry different run starts (${runStarts.join(', ')})` };
  if (typeof runStart !== 'string' || !RUN_START.test(runStart)) {
    return { session, cause: `its fabraik.runstart label ${runStart} is not a run start in the YYYY-MM-DDTHH:MM:SSZ form` };
  }
  let kind;
  try {
    kind = transcript(session);
  } catch (error) {
    return { session, cause: `its transcript ${session}.jsonl could not be looked for: ${/** @type {Error} */ (error).message}` };
  }
  if (kind === 'link') return { session, cause: `its transcript ${session}.jsonl is a symbolic link, not a file` };
  if (kind !== 'file') return { session, cause: `no Claude project folder holds its transcript ${session}.jsonl` };
  const claims = records.map(recordWorkflow);
  const refused = claims.find((claim) => claim?.cause);
  if (refused) return { session, cause: refused.cause };
  const versions = [...new Set(claims.map((claim) => claim?.commit))];
  if (versions.length > 1) {
    return { session, cause: `its records carry different workflow versions (${records.map(({ address }, i) => `${address} ${claims[i]?.commit ?? 'none'}`).join(', ')})` };
  }
  const workflow = claims.find((claim) => claim?.mark) ?? claims[0] ?? undefined;
  return { session, runStart, workflow };
}

// Ends and removes the replacement terminal `address`; undefined, or why it could not.
async function removeReplacement(hc, address) {
  for (const step of ['kill', 'rm']) {
    const done = await hc([step, address]);
    if (done.code !== 0) return `hc ${step} ${address} failed: ${done.stderr.trim() || `exit ${done.code}`}`;
  }
  return undefined;
}

// The prompts a job session starts with, and is resumed with after a restart.
export const jobPrompt = (card) => `Run the resume skill for card #${card} as a Herdr job.`;
const resumePrompt = (card) => `Your session was resumed after a restart. If you were waiting on the owner, first re-run node scripts/board.mjs --waits ${card} --herdr; if it still names show-me-first, ask again through your question menu with the answer I removed the marker. Otherwise carry on with card #${card}.`;
const bindFirst = 'First run exactly node scripts/coordinator.mjs bind-job from the integration root. Stop if it fails. ';

// The coordinator setting of fetched main, or a throw naming the specific fault: readCoordinator redacts the validator's refusal for the guard, and the coordinator's own output may name it (doc-lint and the fabraik check print the same refusals).
function coordinatorSetting(git) {
  try {
    return readCoordinator({ git, includeInstalled: true });
  } catch (error) {
    let text;
    try {
      text = git(['show', 'refs/remotes/origin/main:.agents/factory-settings.json']);
    } catch {
      throw error;
    }
    readSettingsHeader(text, '.agents/factory-settings.json on fetched main');
    throw error;
  }
}

// Starts card `card`'s job as a kept session running the resume skill, an hc child of terminal `parent`, the coordinator's,
// in tab `job <card>` of the project's space, opened when it is not. The session starts under the run mark `now()`, the
// binding to this one card and the coordinated-job mark FABRAIK_COORDINATED_JOB=1; its model and effort are fetched main's `coordinator` setting, read through `git`. It is not observed: it is reported as starting.
// Refused, exit 1, before any GitHub read where `parent` is missing, that setting cannot be read (the cause is printed) or a live terminal of the card is
// running a program for it. Before any tab, a card with a job branch, worktree or draft pull request (see listUnfinished) starts
// only on the verdict `continue` or `stopped`, `hostname` naming this machine, and is refused, naming its verdict, on any other or where a
// read fails; a card with none needs a startable Ready card or a verified same-parent Codex stale claim. Under `capLock` it
// counts running places, the live job terminals running that are not blocked on the owner, and refuses at `cap()` of them. It verifies the parent is the project's sole running Coordinator on an installed
// runtime, requires a preflight and binding reader for Codex, and rereads recorded jobs and registered worktree holders before any
// mutation. An unreadable reply, record, cap or lock refuses, naming its cause. Exit 0 started the session.
// On `stopped` it continues that live terminal under the same cap check: it removes the `fabraik.stopped` label, then sends
// `Carry on with card #N.` with no force; a failed label or send prints its cause and exits 1, the label not put back.
// After a restart, Claude resumes the recorded session and removes the old records after the replacement's labels match.
// Codex resumes the bound native thread, observes its replacement's own binding outside the cap lock, and reacquires it to
// recheck eligibility and both records before removing the predecessor. Failed Codex proof leaves both records available.
/** @param {TrackerTools & { root: string, card: number, login?: string, herdrApp: HerdrCommand, hc: HerdrCommand, parent: string | undefined, hostname: string, transcript: (session: string) => 'file' | 'link' | undefined, newSessionId: () => string, now: () => number, cap: () => number, capLock: <T>(work: () => Promise<T>) => Promise<T>, git: (args: string[]) => string, checkCodexHooks?: (options: { root: string }) => CodexHookPreflight | Promise<CodexHookPreflight>, readCodexBinding?: (options: { root: string, address: string, wait: boolean }) => CodexBinding | null | Promise<CodexBinding | null>, readCodexClaimHistory?: (options: { root: string, threadId: string }, preflight: CodexHookPreflight) => unknown | Promise<unknown> }} options */
export async function startJob({ root, card, login, herdrApp, hc, parent, hostname, transcript, newSessionId, now, cap, capLock, git, print,
  checkCodexHooks, readCodexBinding: observeCodexBinding, readCodexClaimHistory, ...tracker }) {
  if (!parent) {
    print(`Card ${card} not started: HC_TERMINAL_ID names no coordinator terminal.`);
    return 1;
  }
  let settings;
  try {
    settings = coordinatorSetting(git);
  } catch (error) {
    print(`Card ${card} not started: ${/** @type {Error} */ (error).message}`);
    return 1;
  }
  const { space, code } = await projectSpace({ root, herdrApp, print });
  if (code !== undefined) return code;
  if (!space) {
    print(`No Herdr space has folder ${root}; open the coordinator first.`);
    return 1;
  }
  // hc names are unique among live terminals and 1-32 of a-z 0-9 - _; the folder is cut to leave room for the card.
  const suffix = `-job-${card}`;
  const name = basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32 - suffix.length) + suffix;
  let earlierRecords;
  try {
    earlierRecords = await jobRecords({ hc, space: space.id, card });
  } catch (error) {
    print(`Card ${card} not started: ${/** @type {Error} */ (error).message}`);
    return 1;
  }
  const running = earlierRecords.find((record) => record.running && !stoppedKind(record));
  if (running) {
    print(`Card ${card} not started: terminal ${running.address} is still running a program for it; hc read ${running.address} shows it.`);
    return 1;
  }
  const gate = trackerGate(tracker.rawGh);
  let unfinished;
  let earlierWorktree;
  try {
    const worktrees = registeredWorktrees(root, git);
    earlierWorktree = worktrees.get(card);
    [unfinished] = await unfinishedJobs({ root, git, gate, hc, space: space.id, hostname, only: card, worktrees });
  } catch (error) {
    const ended = gate.ended(print);
    if (ended !== undefined) return ended;
    print(`Card ${card} not started: ${oneLine(/** @type {Error} */ (error).message)}`);
    return 1;
  }
  const prebranchCodex = !unfinished && earlierRecords.some(isCodexJobRecord);
  if (!unfinished && !prebranchCodex) {
    let cards;
    try {
      cards = startableCards(gate.gh, print);
    } catch (error) {
      const ended = gate.ended(print);
      if (ended === undefined) throw error;
      return ended;
    }
    const ended = gate.ended(print);
    if (ended !== undefined) return ended;
    if (!cards) return 1;
    if (!cards.some(({ number }) => number === card)) {
      print(`Card ${card} is not a startable Ready card.`);
      return 1;
    }
  } else if (unfinished && unfinished.verdict !== 'continue' && unfinished.verdict !== 'stopped') {
    print(`Card ${card} is not started: ${unfinished.verdict}: ${unfinished.detail}.`);
    return 1;
  }
  const stopped = unfinished?.verdict === 'stopped' ? unfinished : undefined;
  // The count and the launch share the cap lock, so two starts cannot both take the last place.
  try {
    const result = await capLock(async () => {
      const limit = cap();
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`the cap must be a whole number of at least 1, not ${JSON.stringify(limit)}`);
      const taken = await placesTaken(hc);
      if (taken.length >= limit) {
        print(`Card ${card} not started: ${taken.length} of ${limit} running places are taken (cards ${taken.join(', ')}); a job waiting on the owner takes none.`);
        return 1;
      }
      const { space: currentSpace, terminals } = await coordinatorTerminals({ root, herdrApp, hc });
      const running = terminals.filter((terminal) => terminal.running);
      const [coordinator] = running;
      const runtime = coordinator?.foregroundName;
      if (currentSpace?.id !== space.id || running.length !== 1 || (runtime !== 'claude' && runtime !== 'codex')
        || coordinator.address !== parent) {
        throw new Error(`HC_TERMINAL_ID ${parent} is not the sole running Claude or Codex Coordinator in space ${space.id}`);
      }
      if (!settings.installed.includes(runtime)) throw new Error(`the Coordinator runtime ${runtime} is not installed on fetched main`);
      if (runtime === 'codex' && (!checkCodexHooks || !observeCodexBinding)) throw new Error(CODEX_LAUNCH_HELD);

      const worktree = registeredWorktrees(root, git).get(card);
      const holders = await runningTerminals({ hc, space: space.id, worktrees: new Map([[card, worktree]]) });
      const holder = holders.get(card);
      const records = await jobRecords({ hc, space: space.id, card });
      const runningJob = records.find((record) => record.running && !stoppedKind(record));
      const activeAddress = holder && !holder.stopped ? holder.address : runningJob?.address;
      if (activeAddress) {
        print(`Card ${card} not started: terminal ${activeAddress} is still running a program for it.`);
        return 1;
      }
      if (worktree !== earlierWorktree) throw new Error('the registered worktree changed since the card was read');
      const old = records.map(({ address }) => address);
      if (earlierRecords.length !== old.length || earlierRecords.some(({ address }) => !old.includes(address))
        || holder?.address !== stopped?.address
        || (holder && stopped?.detail !== `${holder.stopped}, terminal ${holder.address}`)) {
        throw new Error('the job terminal records changed since the card was read');
      }
      if (stopped) {
        // The label goes first and is not put back: a failed send leaves the job counted again, the safe side.
        const cleared = await hc(['label', stopped.address, 'fabraik.stopped=']);
        const sent = cleared.code === 0 ? await hc(['send', stopped.address, `Carry on with card #${card}.`]) : cleared;
        if (sent.code !== 0) {
          print(`Card ${card} not continued: hc ${cleared.code === 0 ? 'send' : 'label'} ${stopped.address} failed: ${sent.stderr.trim() || `exit ${sent.code}`}${sent.code === 9 ? ' (blocked)' : ''}.`);
          return 1;
        }
        print(`Card ${card}'s stopped job ${stopped.address} was told to carry on.`);
        return 0;
      }
      const knownCodex = prebranchCodex || records.some(isCodexJobRecord);
      const jobRuntime = knownCodex ? 'codex' : records.length === 0 ? runtime : 'claude';
      if (!settings.installed.includes(jobRuntime)) throw new Error(`the job runtime ${jobRuntime} is not installed on fetched main`);
      const verifyPrebranchStart = async (step) => {
        const liveParent = await coordinatorTerminals({ root, herdrApp, hc });
        const live = liveParent.terminals.filter(({ running }) => running);
        if (liveParent.space?.id !== space.id || live.length !== 1 || !isDeepStrictEqual(live[0], coordinator)) {
          throw new Error(`the sole native Coordinator changed before ${step}`);
        }
        const other = await runningTerminals({ hc, space: space.id, worktrees: new Map([[card, undefined]]) });
        if (other.has(card)) throw new Error(`a competing job holder appeared before ${step}`);
        const worktrees = registeredWorktrees(root, git);
        if (jobSources({ worktrees, git, gh: gate.gh }).has(card)) throw new Error(`a job source appeared before ${step}`);
      };
      let codexPreflight;
      let predecessor;
      let prebranchReady;
      if (jobRuntime === 'codex') {
        if (!checkCodexHooks || !observeCodexBinding) throw new Error(CODEX_LAUNCH_HELD);
        const hooks = await checkCodexHooks({ root });
        if (hooks?.status !== 'ready' || !isCodexExecutablePath(hooks.executable) || typeof hooks.verifyExecutable !== 'function') throw new Error(CODEX_LAUNCH_HELD);
        codexPreflight = hooks;
        if (records.length > 0) {
          if (records.length !== 1 || (!prebranchCodex && unfinished?.verdict !== 'continue')) {
            throw new Error('Codex recovery requires an eligible job and one stopped predecessor');
          }
          const [{ address, native, live }] = records;
          if (prebranchCodex && live !== (native.state === 'live')) throw new Error('the stopped Codex job record has conflicting native states');
          const receipt = await observeCodexBinding({ root, address, wait: false });
          const proof = { root, card, space: space.id, address };
          const binding = boundCodexJob(native, receipt, proof);
          predecessor = { binding, argv: native.argv, live: native.state === 'live' };
          if (prebranchCodex) {
            const { gh } = gate;
            const before = readClaimState(gh, card);
            if (claimStateEligible(before, 'Ready', undefined)) {
              prebranchReady = before;
            } else {
              if (binding.parentAddress !== parent) throw new Error('the stopped Codex job belongs to a different Coordinator; the stale claim was kept');
              if (!readCodexClaimHistory) throw new Error('native Codex claim history is unavailable');
              verifiedClaim(before, binding, login);
              const items = await readCodexClaimHistory({ root, threadId: binding.threadId }, codexPreflight);
              verifyClaimHistory(items, binding, before, login);
              await verifyPrebranchStart('stale claim repair');
              const latest = await jobRecords({ hc, space: space.id, card });
              if (!isDeepStrictEqual(latest, records)) throw new Error('the job records changed before stale claim repair');
              const confirmed = await observeCodexBinding({ root, address, wait: false });
              if (!isDeepStrictEqual(confirmed, binding)) throw new Error('the Codex binding changed before stale claim repair');
              const current = readClaimState(gh, card);
              if (!isDeepStrictEqual(current, before)) throw new Error('the tracker card or claim changed before stale claim repair');
              prebranchReady = repairClaim(gh, card, login, before, print);
            }
          }
        }
      }
      const recorded = jobRuntime === 'claude' && records.length > 0 ? recordedSession(records, transcript) : undefined;
      if (recorded?.cause) {
        print(`Card ${card}'s session ${recorded.session} could not be resumed: ${recorded.cause}; nothing was started. hc rm ${old.join(' and hc rm ')} lets start begin card ${card} as a new session.`);
        return 1;
      }
      // A Claude job runs its workflow from the store's verified copy of one commit: a fresh start's local main, a resume's
      // recorded commit, or local main for a pre-pin job's resume.
      let pin;
      let driftNotice;
      if (jobRuntime === 'claude') {
        const store = workflowStore(root);
        if (recorded?.workflow) {
          const { commit, mark } = recorded.workflow;
          const dir = join(store, commit);
          if (mark !== undefined && mark !== dir) {
            print(`Card ${card}'s session ${recorded.session} could not be resumed: its workflow root mark ${mark} is not ${dir}; nothing was started. hc rm ${old.join(' and hc rm ')} lets start begin card ${card} as a new session.`);
            return 1;
          }
          // Like a fresh start's, the recorded version must be on the reviewed main before any of it is written or run.
          let reviewed;
          try {
            reviewed = onReviewedMain({ cwd: root, commit });
            if (reviewed) ensureWorkflowSnapshot(root, commit, dir);
          } catch (error) {
            print(`Card ${card}'s session ${recorded.session} could not be resumed: its workflow version ${commit} cannot be read (${/** @type {Error} */ (error).message}); nothing was started. `
              + 'Owner route: confirm this repository and the job\'s original watch-state directory; on GitHub convert its pull request to draft, turn off auto-merge '
              + 'and remove its forwarding hook; wait for the old watch to end; from the root checkout, with XDG_STATE_HOME set so that directory is the state directory, '
              + `run node scripts/merge-watch.mjs <n>; confirm the original record file is absent before hc rm ${old.join(' and hc rm ')}.`);
            return 1;
          }
          if (!reviewed) {
            print(`Card ${card}'s session ${recorded.session} could not be resumed: its workflow version ${commit} is not on the reviewed origin/main; nothing was started. hc rm ${old.join(' and hc rm ')} lets start begin card ${card} as a new session.`);
            return 1;
          }
          pin = { commit, dir };
        } else {
          const commit = selectWorkflowVersion({ cwd: root });
          pin = { commit, dir: join(store, commit) };
          ensureWorkflowSnapshot(root, commit, pin.dir);
        }
        if (recorded) {
          let drifted;
          try {
            drifted = workflowDrift({ cwd: root, commit: pin.commit, root }).join(', ');
          } catch (error) {
            drifted = `shared contracts (they could not be compared: ${/** @type {Error} */ (error).message})`;
          }
          if (drifted) {
            driftNotice = `Workflow drift: the integration checkout's ${drifted} differ from this job's workflow version ${pin.commit}, which it keeps, so its delivery stays stopped. `
              + 'Recover by withdrawing with gh pr ready <n> --undo while the pull request is still open, then running node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" <n> until no record is retained; '
              + 'only then are its records removed and a new job started.';
            print(`Card ${card}'s job is told: ${driftNotice}`);
          }
        }
      }
      const tabName = `job ${card}`;
      let tab = currentSpace.tabs.find(({ name: open }) => open === tabName);
      let helpPane;
      const failed = (reply) => reply.stderr.trim() || `exit ${reply.code}`;
      const listJobTab = async (tabId) => {
        const spaces = await listSpaces(herdrApp);
        const [here] = localProjectSpaces(spaces, root);
        const tabs = spaces.flatMap(({ tabs }) => tabs);
        const jobTab = here?.tabs.find(({ id, name }) => id === tabId && name === tabName);
        if (here?.id !== space.id || !jobTab || tabs.filter(({ id }) => id === tabId).length !== 1) {
          throw new Error(`herdr-app ls does not uniquely show ${tabName} as ${tabId} in space ${space.id}`);
        }
        return { jobTab, tabs };
      };
      if (!tab) {
        // Herdr opens a shell by default. The bundled Help mod occupies a pane without starting a terminal.
        const opened = await herdrApp(['do', 'tab.new', '--space', space.id, '--name', tabName, '--folder', root, '--focus', 'false', '--mod', 'help']);
        try {
          if (opened.code !== 0) throw new Error(failed(opened));
          const created = JSON.parse(opened.stdout);
          if (created?.space !== space.id || typeof created.tab !== 'string' || !created.tab
            || currentSpace.tabs.some(({ id }) => id === created.tab) || typeof created.pane !== 'string' || !created.pane) {
            throw new Error('herdr-app tab.new returned no distinct job tab and Help pane in the project space');
          }
          tab = (await listJobTab(created.tab)).jobTab;
          helpPane = created.pane;
        } catch (error) {
          print(`Card ${card} not started: tab ${tabName} could not be opened: ${/** @type {Error} */ (error).message}`);
          return 1;
        }
      }
      const runStart = predecessor?.binding.runStart ?? recorded?.runStart ?? new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const launch = async (runtimeLabels, argv) => {
        const launched = await hc(['run', '--bg', '--keep', '--parent', coordinator.address, '--outlive-parent', '--name', name, '--cwd', root,
          '--label', `herdr.space=${space.id}`, '--label', `herdr.tab=${tab.id}`, '--label', 'fabraik.role=job', '--label', `fabraik.space=${space.id}`,
          '--label', `fabraik.card=${card}`, ...runtimeLabels.flatMap((label) => ['--label', label]), '--label', `fabraik.runstart=${runStart}`, '--json', '--', ...argv]);
        if (launched.code !== 0 || !helpPane) return launched;
        try {
          const address = JSON.parse(launched.stdout)?.address;
          if (typeof address !== 'string' || !LOCAL_HERDR_TERMINAL.test(address) || address === parent) {
            throw new Error('hc run returned no distinct local job terminal');
          }
          // Close the Help pane only after the app has adopted the job in this tab.
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (attempt > 0) await delay(100);
            const { jobTab, tabs } = await listJobTab(tab.id);
            if (!Array.isArray(jobTab.terminals)) throw new Error(`herdr-app ls returned no terminal list for ${tabName}`);
            if (tabs.some(({ terminals }) => Array.isArray(terminals) && terminals.some((entry) => entry?.pane === helpPane))) {
              throw new Error(`herdr-app ls shows Help pane ${helpPane} as a terminal`);
            }
            if (jobTab.terminals.some((entry) => entry?.terminal === address && typeof entry.pane === 'string' && entry.pane)) {
              const closed = await herdrApp(['do', 'pane.close', JSON.stringify({ pane: helpPane })]);
              if (closed.code !== 0) throw new Error(`herdr-app pane.close failed: ${failed(closed)}`);
              return launched;
            }
          }
          throw new Error(`herdr-app ls did not show ${address} in ${tabName}`);
        } catch (error) {
          print(`Card ${card}'s Help pane ${helpPane} was kept: ${/** @type {Error} */ (error).message}.`);
          return launched;
        }
      };
      const marks = jobLaunchMarks(card, runStart, pin?.dir);
      if (codexPreflight) {
        const { executable, verifyExecutable } = codexPreflight;
        const thread = predecessor?.binding.threadId;
        const prompt = thread ? `Your session was resumed after a restart. Carry on with card #${card}.` : jobPrompt(card);
        const deliveryGuidance = 'For delivery follow the Codex Herdr job route in .agents/skills/resume/references/herdr-job.md. Merge only with the pinned merge once the required checks pass; only the show-me-first label waits for the owner.';
        const argv = [...marks, executable, ...CODEX_JOB_FLAGS, ...(thread ? ['resume', thread] : []),
          '--', `${bindFirst}${prompt} ${deliveryGuidance}`];
        if (predecessor?.live) {
          const address = predecessor.binding.terminalAddress;
          const native = await readRecord(hc, address, 'recheck the idle Codex predecessor', (record) => record);
          boundCodexJob(native, predecessor.binding, { root, card, space: space.id, address, argv: predecessor.argv });
          if (native.state === 'live') {
            const killed = await hc(['kill', address]);
            if (killed.code !== 0) throw new Error(`hc kill ${address} failed: ${failed(killed)}`);
          }
        }
        if (prebranchReady) {
          await verifyPrebranchStart('Codex recovery launch');
          if (!isDeepStrictEqual(readClaimState(gate.gh, card), prebranchReady)) {
            throw new Error('the Ready tracker card or claim changed before Codex recovery launch');
          }
        }
        verifyExecutable();
        const launched = await launch(['fabraik.runtime=codex'], argv);
        if (launched.code !== 0) throw new Error(`hc run failed: ${failed(launched)}`);
        if (predecessor) {
          let address;
          try {
            address = JSON.parse(launched.stdout)?.address;
          } catch {
            // Keep the predecessor when the exact replacement is unknown.
          }
          if (typeof address !== 'string' || !LOCAL_HERDR_TERMINAL.test(address) || address === predecessor.binding.terminalAddress || address === parent) {
            throw new Error('hc run did not return a distinct local replacement address; the previous Codex record was kept');
          }
          return { predecessor, address, argv, prebranchReady, codexPreflight };
        }
        print(`Card ${card}'s Codex job session ${name} is starting in tab ${tabName}: hc get ${name} --json shows it.`);
        return 0;
      }
      const session = recorded ? recorded.session : newSessionId();
      const workflow = /** @type {{ commit: string }} */ (pin).commit;
      const labels = { 'fabraik.card': String(card), 'fabraik.session': session, 'fabraik.runstart': runStart, 'fabraik.workflow': workflow };
      const { model, effort } = settings;
      const run = (claude) => launch([`fabraik.session=${session}`, `fabraik.workflow=${workflow}`], [...marks, `ANTHROPIC_MODEL=${model}`,
        `CLAUDE_CODE_EFFORT_LEVEL=${effort}`, 'claude', '--permission-mode', 'auto', ...claude]);
      if (!recorded) {
        const launched = await run(['--session-id', session, '--', jobPrompt(card)]);
        if (launched.code !== 0) {
          print(`Card ${card} not started: hc run failed: ${failed(launched)}`);
          return 1;
        }
        print(`Card ${card}'s job session ${name} is starting in tab ${tabName} with session ${session}, not yet confirmed: hc get ${name} --json shows it.`);
        return 0;
      }

      const unresumed = `Card ${card}'s session ${session} could not be resumed: `;
      const kept = `the old record ${old.join(', ')} is kept, so start ${card} tries again`;
      // hc kill is final for a kept terminal and keeps its record and labels, so the old record stays until the replacement is confirmed.
      for (const { address } of records.filter(({ live }) => live)) {
        const killed = await hc(['kill', address]);
        if (killed.code !== 0) {
          print(`${unresumed}hc kill ${address} failed: ${failed(killed)}; nothing was started, and ${kept}.`);
          return 1;
        }
      }
      const launched = await run(['--resume', session, '--', driftNotice ? `${resumePrompt(card)} ${driftNotice}` : resumePrompt(card)]);
      if (launched.code !== 0) {
        print(`${unresumed}hc run failed: ${failed(launched)}; ${kept}.`);
        return 1;
      }
      let replacement;
      try {
        replacement = JSON.parse(launched.stdout).address;
      } catch {
        // An unreadable reply leaves the replacement unknown, refused below.
      }
      if (typeof replacement !== 'string') {
        print(`${unresumed}hc run printed no address to confirm its replacement ${name} by; ${kept}, and hc ls --label fabraik.card=${card} --all --json shows what runs.`);
        return 1;
      }
      let mismatch;
      try {
        const carried = await readRecord(hc, replacement, 'show its labels', (record) => record.labels);
        mismatch = RESUMED_LABELS.filter((label) => carried?.[label] !== labels[label]).map((label) => `${label} ${carried?.[label]}, not ${labels[label]}`).join('; ');
      } catch (error) {
        mismatch = /** @type {Error} */ (error).message;
      }
      if (mismatch) {
        const removal = await removeReplacement(hc, replacement);
        print(`${unresumed}its replacement ${replacement} carries ${mismatch}; ${removal ? `the replacement was not removed (${removal})` : 'the replacement was removed'}, and ${kept}.`);
        return 1;
      }
      // The replacement carries the label, so a pre-pin job now records local main.
      if (!recorded.workflow) print(`Card ${card}'s job had no recorded workflow version; its replacement records local main ${workflow} as its workflow version.`);
      const unremoved = [];
      for (const address of old) {
        const removed = await hc(['rm', address]);
        if (removed.code !== 0) unremoved.push(`hc rm ${address} failed: ${failed(removed)}`);
      }
      print(`Card ${card}'s job session ${name} is resuming session ${session} in tab ${tabName}, not yet confirmed: hc get ${replacement} --json shows it.`);
      if (unremoved.length === 0) return 0;
      print(`Its old record is not all removed: ${unremoved.join('; ')}.`);
      return 1;
    });
    if (typeof result === 'number') return result;

    const { predecessor, address, argv, prebranchReady, codexPreflight } = result;
    const prior = predecessor.binding;
    const original = prior.terminalAddress;
    try {
      const observation = { root, address };
      const receipt = await observeCodexBinding?.({ ...observation, wait: true })
        ?? await observeCodexBinding?.({ ...observation, wait: false });
      const proof = { root, card, space: space.id, address, parent, prior, argv, replacement: true };
      const replacement = await readRecord(hc, address, 'read the Codex replacement', (record) => record);
      const binding = boundCodexJob(replacement, receipt, proof);
      await capLock(async () => {
        const worktrees = registeredWorktrees(root, git);
        if (!prebranchReady && worktrees.get(card) !== earlierWorktree) throw new Error('the registered worktree changed during Codex recovery');
        const [current] = await unfinishedJobs({ root, git, gate, hc, space: space.id, hostname, only: card, worktrees, except: address });
        if ((current && current.verdict !== 'continue') || (!prebranchReady && (!current || current.detail !== unfinished?.detail))) {
          throw new Error(`the eligible job sources or holders changed during Codex recovery${current ? ` (${current.detail})` : ''}`);
        }
        const verifyCleanupRecords = async () => {
          if (prebranchReady) {
            const holders = await runningTerminals({ hc, space: space.id, except: address, worktrees: new Map([[card, worktrees.get(card)]]) });
            if (holders.has(card)) throw new Error('a competing job holder appeared during Codex recovery');
          }
          const records = await jobRecords({ hc, space: space.id, card });
          const old = records.find((record) => record.address === original);
          const next = records.find((record) => record.address === address);
          if (records.length !== 2 || old?.native.state !== 'finished' || old.live || !next?.live || stoppedKind(next)) {
            throw new Error('the Codex predecessor and replacement are no longer the only stopped and running records');
          }
          boundCodexJob(old.native, prior, { root, card, space: space.id, address: original, argv: predecessor.argv });
          boundCodexJob(next.native, binding, proof);
        };
        // The replacement can finish claiming while Herdr reads are in flight.
        await verifyCleanupRecords();
        if (prebranchReady) {
          const claimState = readClaimState(gate.gh, card);
          if (isDeepStrictEqual(claimState, prebranchReady)) {
            if (current) throw new Error('a job source appeared without a verified replacement claim');
          } else {
            if (claimState.board.id !== prebranchReady.board.id || claimState.position <= prebranchReady.position || claimState.logins.length !== 1) {
              throw new Error('the Ready card changed without a new claim on the same board item');
            }
            verifiedClaim(claimState, binding, login);
            const { id, url } = claimState.claim;
            if (prebranchReady.comments.some((comment) => comment.id === id || comment.url === url)) {
              throw new Error('the replacement claim was already present before launch');
            }
            if (!readCodexClaimHistory) throw new Error('native Codex claim history is unavailable');
            const items = await readCodexClaimHistory({ root, threadId: binding.threadId }, codexPreflight);
            verifyClaimHistory(items, binding, claimState, login);
            await verifyCleanupRecords();
            if (!isDeepStrictEqual(readClaimState(gate.gh, card), claimState)) {
              throw new Error('the tracker card or claim changed before Codex predecessor cleanup');
            }
          }
        }
        const removed = await hc(['rm', original]);
        if (removed.code !== 0) throw new Error(`hc rm ${original} failed: ${removed.stderr.trim() || `exit ${removed.code}`}`);
      });
      print(`Card ${card}'s Codex job resumed its bound thread ${prior.threadId} at ${address}.`);
      return 0;
    } catch (error) {
      const ended = gate.ended(print);
      if (ended !== undefined) return ended;
      print(`Card ${card}'s Codex replacement ${address} could not be confirmed: ${/** @type {Error} */ (error).message}; the previous record ${original} was kept.`);
      return 1;
    }
  } catch (error) {
    print(`Card ${card} not started: ${/** @type {Error} */ (error).message}`);
    return gate.ended(print) ?? 1;
  }
}

const DELIVERY_PR_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,autoMergeRequest,mergedAt,mergeCommit';
const DELIVERY_PROBE_MS = 5_000;
const DELIVERY_CLEANUP_MS = 50_000;
const DELIVERY_CONTENTION = 'Waiting for another delivery in this repository';
const DELIVERY_PENDING = 'Waiting for delivery readiness.';
const DELIVERY_CLEANUP = 'Waiting for the previous merge watch to finish cleaning up.';
const DELIVERY_LABEL = 'fabraik.delivery';
const DELIVERY_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DELIVERY_HEAD = /^[a-f0-9]{40}$/;
const DELIVERY_DIGEST = /^[a-f0-9]{64}$/;
const positiveNumber = (value) => Number.isSafeInteger(value) && value > 0;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const entryAt = (path) => lstatSync(path, { throwIfNoEntry: false });
const beneath = (path, parent) => path === parent || path.startsWith(parent + sep);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join(',') === keys;
const deliveryUid = () => /** @type {() => number} */ (process.getuid)();
const deliveryError = (reason) => new Error(reason.startsWith('Delivery stopped:') ? reason : `Delivery stopped: ${reason}`);
const reasonOf = (error) => error instanceof Error ? error.message : String(error);

// Linux /proc start time distinguishes a reused PID; a zombie cannot own a delivery.
function deliveryProcessStart(pid) {
  const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = line.slice(line.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z' || fields[0] === 'X' || !/^\d+$/.test(fields[19])) throw deliveryError('the delivery process is no longer live.');
  return fields[19];
}

function sameDeliveryProcess({ pid, start }) {
  try {
    return deliveryProcessStart(pid) === start;
  } catch {
    return false;
  }
}

function deliveryOriginSlug(origin) {
  const scp = /^(?:[^/@:\s]+@)?github\.com:\/?([^/]+\/[^/]+)$/i.exec(origin);
  if (scp) return scp[1].replace(/\.git$/i, '');
  const parsed = new URL(origin);
  if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.port) throw deliveryError('the origin is not an explicit github.com repository.');
  return parsed.pathname.slice(1).replace(/\.git$/i, '');
}

// Capture the Herdr generation independently of whichever program currently has foreground focus.
// Herdr's seen and pinned labels are mutable display metadata.
function deliveryGeneration(terminal) {
  const { address, cwd, created_ms, parent, pid, labels } = terminal ?? {};
  const {
    [DELIVERY_LABEL]: delivery, 'herdr.seen': ignoredSeen, 'herdr.pinned': ignoredPinned, ...generationLabels
  } = labels ?? {};
  return { address, cwd, created_ms, parent, pid, labels: generationLabels, delivery };
}

function sameDeliveryRow(original, current) {
  return original.address === current.address && original.cwd === current.cwd && original.created_ms === current.created_ms
    && original.parent === current.parent && isDeepStrictEqual(original.labels, current.labels);
}

function labelState(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function checkedLaneDirectory(path, create) {
  if (!managedPath(path)) throw deliveryError('the delivery lane path must be physical and absolute.');
  if (!entryAt(path) && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    }
  }
  if (!entryAt(path)) return false;
  if (!isCanonicalLeadFolder(path)) throw deliveryError('the delivery lane directory must be owned and private.');
  return true;
}

function checkedStateDirectory(path, { accountHome, excluded }) {
  if (!managedPath(path) || excluded.some((folder) => beneath(path, folder))) {
    throw deliveryError('the merge-watch state path is within a writable job or temporary directory.');
  }
  if (entryAt(path)) {
    if (!isCanonicalLeadFolder(path)) throw deliveryError('the merge-watch state directory must be physical, owned and private.');
    return true;
  }
  if (!beneath(path, accountHome)) throw deliveryError('the missing merge-watch state directory has no verified account-state ancestor.');
  let existing = path;
  while (!entryAt(existing)) existing = dirname(existing);
  const ancestor = lstatSync(existing);
  if (!ancestor.isDirectory() || ancestor.uid !== deliveryUid() || (ancestor.mode & 0o022) !== 0 || realpathSync(existing) !== existing) {
    throw deliveryError('the merge-watch state ancestor must be physical and owned by this account.');
  }
  return false;
}

function optionalDeliveryRecord(path) {
  try {
    return readManagedRecord(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw deliveryError('a delivery record is unreadable or is not an owned private file.');
  }
}

function writeDeliveryRecord(path, value) {
  writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
}

function validDeliveryProcess(value) {
  return hasKeys(value, 'pid,start') && positiveNumber(value.pid) && typeof value.start === 'string' && /^\d+$/.test(value.start);
}

function validDeliveryReceipt(receipt, { id, repo, slug, watchDigest }) {
  return hasKeys(receipt, 'base,branch,card,head,holder,pr,repo,repositoryId,watchDigest')
    && receipt.repositoryId === id && typeof receipt.repo === 'string' && DELIVERY_REPO.test(receipt.repo)
    && (repo === undefined ? receipt.repo.toLowerCase() === slug.toLowerCase() : receipt.repo === repo) && positiveNumber(receipt.card) && positiveNumber(receipt.pr)
    && receipt.branch === `job/${receipt.card}` && typeof receipt.base === 'string' && /^\S+$/.test(receipt.base)
    && typeof receipt.head === 'string' && DELIVERY_HEAD.test(receipt.head) && validDeliveryProcess(receipt.holder)
    && typeof receipt.watchDigest === 'string' && DELIVERY_DIGEST.test(receipt.watchDigest) && receipt.watchDigest === watchDigest;
}

function exactDeliveryPull(gh, repo, { pr, head, branch, base }) {
  const reply = JSON.parse(gh(['pr', 'view', '--repo', `github.com/${repo}`, String(pr), '--json', DELIVERY_PR_FIELDS]));
  const request = reply?.autoMergeRequest;
  const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const mergeOid = reply?.mergeCommit?.oid;
  if (!reply || reply.number !== pr || reply.url !== `https://github.com/${repo}/pull/${pr}`
    || reply.headRefName !== branch || reply.headRefOid !== head || !DELIVERY_HEAD.test(head) || reply.baseRefName !== base
    || reply.isCrossRepository !== false || typeof reply.isDraft !== 'boolean' || !['OPEN', 'MERGED', 'CLOSED'].includes(reply.state)
    || !(request === null || (timestamp(request?.enabledAt) && typeof request?.enabledBy?.login === 'string'
      && /^[A-Za-z0-9-]+$/.test(request.enabledBy.login) && ['MERGE', 'SQUASH', 'REBASE'].includes(request.mergeMethod)))
    || (reply.state === 'MERGED' && (!timestamp(reply.mergedAt) || typeof mergeOid !== 'string' || !DELIVERY_HEAD.test(mergeOid)))) {
    throw deliveryError('GitHub could not confirm the exact pull request on its checked head.');
  }
  return reply;
}

async function deliveryPause(sleep, ms, signal) {
  signal.throwIfAborted();
  await sleep(ms, undefined, { signal });
  signal.throwIfAborted();
}

// The cleanup a retained watcher record of `receipt` still needs. A pinned Claude caller gets the repair-first order,
// with the owner route, for a commit that cannot be read, as a separate alternative naming the record's watch-state directory.
function retainedWatchCleanup(receipt, { pinned, watchStateDir }) {
  const target = `${receipt.repo}#${receipt.pr}`;
  const needed = `previous pull request ${target} still needs its merge-watch cleanup.`;
  if (!pinned) return `${needed} In the original job run \`node scripts/merge-watch.mjs ${receipt.pr}\` once its old watch has ended.`;
  return `${needed} Recover in this order: 1. resume its job, which repairs the snapshot of that job's workflow version; `
    + `2. while ${target} is still open, in that job run \`gh pr ready ${receipt.pr} --undo\`; `
    + `3. there run \`node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" ${receipt.pr}\` until no record is retained; `
    + '4. only then remove its records and start a new job. '
    + 'Only when that job\'s workflow version cannot be read, take the owner route instead: '
    + `1. confirm the repository ${receipt.repo} and the original watch-state directory ${watchStateDir}, which this record was read from; `
    + `2. on GitHub convert ${target} to draft, turn off its auto-merge and remove its forwarding hook; `
    + '3. wait for the old watch to end; '
    + `4. from the root checkout, with XDG_STATE_HOME=${dirname(watchStateDir)} so that directory is the state directory, run \`node scripts/merge-watch.mjs ${receipt.pr}\`; `
    + '5. confirm the original record file is absent before removing the predecessor.';
}

// A hosted pull request and a checked local watcher record are separate prerequisites for letting the next job publish.
async function settleDeliveryReceipt({ receipt, pull, watchStatus, label, assertLive, waitTo, now, pinned, watchStateDir }) {
  const target = `${receipt.repo}#${receipt.pr}`;
  const retained = retainedWatchCleanup(receipt, { pinned, watchStateDir });
  const unverified = () => deliveryError(`GitHub could not confirm the exact previous pull request ${target} on its recorded head. Check that pull request in its original job before retrying delivery.`);
  let awaitedCleanup = false;
  const cleanup = async () => {
    const status = () => {
      try {
        return watchStatus();
      } catch {
        throw deliveryError(retained);
      }
    };
    const live = status();
    if (live === undefined) return;
    if (!live || awaitedCleanup) throw deliveryError(retained);
    awaitedCleanup = true;
    await label('waiting', { repo: receipt.repo, pr: receipt.pr, reason: DELIVERY_CLEANUP });
    const deadline = now() + DELIVERY_CLEANUP_MS;
    do {
      await waitTo(Math.min(deadline, now() + DELIVERY_PROBE_MS));
      const remaining = status();
      if (remaining === undefined) return;
      if (!remaining) break;
    } while (now() < deadline);
    throw deliveryError(retained);
  };

  await cleanup();
  const anchor = now();
  for (let check = 0; ; check += 1) {
    await assertLive();
    let previous;
    try {
      previous = pull(receipt);
    } catch {
      throw unverified();
    }
    if (previous.state === 'MERGED' || previous.state === 'CLOSED' || (previous.isDraft && previous.autoMergeRequest === null)) break;
    if (previous.isDraft || previous.autoMergeRequest === null) {
      throw unverified();
    }
    if (check === 0) {
      await label('waiting', { repo: receipt.repo, pr: receipt.pr, reason: `Waiting for GitHub to settle previous pull request ${target}.` });
    }
    const window = SETTLE_AFTER_MS[SETTLE_AFTER_MS.length - 1];
    await waitTo(anchor + (SETTLE_AFTER_MS[check] ?? window * (check - SETTLE_AFTER_MS.length + 2)));
  }
  await cleanup();
}

const sameDeliveryInode = (first, second) => first && second && first.dev === second.dev && first.ino === second.ino;

async function holdDelivery(context) {
  const { lane, lockPath, readyPath, generation, processIdentity, signal, label, assertLive, watchStatus, pull, now, waitTo, pinned, watchStateDir } = context;
  lane(true);
  await assertLive();
  let lock = await lockLeadFile(lockPath, { wait: ['-n'], signal });
  if (lock === undefined) {
    await label('waiting', { reason: DELIVERY_CONTENTION });
    do {
      await assertLive();
      lock = await lockLeadFile(lockPath, { signal });
    } while (lock === undefined);
  }
  const temporary = `${readyPath}.${randomUUID()}`;
  let prepared;
  let ready;
  let readyLock;
  let published = false;
  try {
    await assertLive();
    if (optionalDeliveryRecord(readyPath) !== undefined) unlinkSync(readyPath);
    const prior = context.readReceipt();
    if (prior) {
      await settleDeliveryReceipt({ receipt: prior, pull, label, assertLive, watchStatus: () => watchStatus(prior.repo), now, waitTo, pinned, watchStateDir });
      await assertLive();
      if (!context.codex) {
        if (!isDeepStrictEqual(context.readReceipt(), prior)) throw deliveryError('the previous delivery receipt changed during settlement.');
        unlinkSync(context.receiptPath);
      }
    }
    checkLeadFile(lock, lockPath);
    await assertLive();
    const { delivery, ...terminal } = generation;
    ready = { terminal, worktree: context.worktree, process: processIdentity, origin: context.origin, repositoryId: context.id };
    writeDeliveryRecord(temporary, ready);
    prepared = entryAt(temporary);
    readyLock = await lockLeadFile(temporary, { wait: ['-n'], readOnly: true, signal });
    if (readyLock === undefined || !sameDeliveryInode(fstatSync(readyLock), prepared)) {
      throw deliveryError('the delivery reservation record could not be locked.');
    }
    await label('clear-waiting');
    await assertLive();
    renameSync(temporary, readyPath);
    published = true;
    for (;;) {
      checkLeadFile(readyLock, readyPath);
      await waitTo(now() + DELIVERY_PROBE_MS);
      checkLeadFile(lock, lockPath);
    }
  } catch (error) {
    const requestedRelease = signal.aborted
      && (error === signal.reason || (error instanceof Error && error.cause === signal.reason));
    if (!published || !requestedRelease) throw error;
    await context.liveRow();
    return 0;
  } finally {
    try {
      if (published && readyLock !== undefined) {
        const owned = fstatSync(readyLock);
        if (sameDeliveryInode(entryAt(readyPath), owned) && isDeepStrictEqual(optionalDeliveryRecord(readyPath), ready)
          && sameDeliveryInode(entryAt(readyPath), owned)) unlinkSync(readyPath);
      } else if (sameDeliveryInode(entryAt(temporary), prepared)) {
        unlinkSync(temporary);
      }
    } finally {
      try {
        if (readyLock !== undefined) closeSync(readyLock);
      } finally {
        closeSync(lock);
      }
    }
  }
}

// Claude has no binding locator. An unclassified lane is only a hint; a record for this job requires full proof.
async function localDeliveryLease({ lockRoot, worktree, generation, origin, assertLive, signal }, id) {
  if (!checkedLaneDirectory(lockRoot, false)) return undefined;
  const keys = id ? [sha256(id)] : readdirSync(lockRoot).filter((key) => DELIVERY_DIGEST.test(key));
  let match;
  for (const key of keys) {
    const folder = join(lockRoot, key);
    const readyPath = join(folder, 'ready.json');
    let original;
    let ready;
    try {
      if (!checkedLaneDirectory(folder, false)) continue;
      original = entryAt(readyPath);
      if (!original) continue;
      ready = optionalDeliveryRecord(readyPath);
    } catch (error) {
      if (id) throw error;
      continue;
    }
    if (ready === undefined) continue;
    if (!id && (ready?.worktree !== worktree || ready?.terminal?.address !== generation.address)) continue;
    if (!hasKeys(ready, 'origin,process,repositoryId,terminal,worktree') || !validDeliveryProcess(ready.process)
      || typeof ready.repositoryId !== 'string' || !/^\S{1,256}$/.test(ready.repositoryId) || sha256(ready.repositoryId) !== key
      || typeof ready.origin !== 'string' || !isRecord(ready.terminal) || !managedPath(ready.worktree)) {
      throw deliveryError('the local delivery readiness record is invalid.');
    }
    if (!sameDeliveryRow(generation, ready.terminal) || ready.terminal.pid !== generation.pid || ready.worktree !== worktree) continue;
    if (ready.origin !== origin) throw deliveryError('the local origin changed since the delivery reservation.');
    await assertLive();
    const released = 'the original delivery process has released its reservation.';
    for (const path of [join(folder, 'delivery.lock'), readyPath]) {
      const unlocked = await lockLeadFile(path, { wait: ['-n'], readOnly: true, shared: true, signal }).catch((error) => {
        throw deliveryError(`the delivery reservation lock could not be verified: ${error.message}`);
      });
      if (unlocked !== undefined) {
        closeSync(unlocked);
        throw deliveryError(released);
      }
    }
    if (!sameDeliveryInode(entryAt(readyPath), original) || !isDeepStrictEqual(optionalDeliveryRecord(readyPath), ready)
      || !sameDeliveryInode(entryAt(readyPath), original)) throw deliveryError(released);
    if (match) throw deliveryError('more than one reservation matches this delivery job.');
    match = ready;
  }
  return match;
}

async function deliveryReadiness(context, seconds, initialDelivery) {
  const deadline = context.now() + seconds * 1_000;
  let unchanged = true;
  for (;;) {
    const row = await context.assertLive();
    if (await context.readLease()) {
      context.output.log('Delivery ready.');
      return 0;
    }
    const state = labelState(row.delivery);
    const expired = context.now() >= deadline;
    unchanged &&= row.delivery === initialDelivery;
    if (state?.phase === 'stopped' && typeof state.reason === 'string' && (!unchanged || expired)) throw deliveryError(state.reason);
    if (expired) {
      context.output.log(state?.phase === 'waiting' && typeof state.reason === 'string' ? state.reason : DELIVERY_PENDING);
      return 75;
    }
    await context.waitTo(Math.min(deadline, context.now() + DELIVERY_PROBE_MS));
  }
}

async function observeDeliveryPull(context, { pr, head, arm = false }) {
  if (arm && context.codex) throw deliveryError('only the current Claude delivery holder can arm a delivery.');
  const holder = await context.requireLease();
  const target = { pr, head, branch: `job/${context.card}`, base: context.base };
  const reply = context.pull(target);
  if (arm) {
    const { id, repo, card, watchDigest } = context;
    const receipt = { repositoryId: id, repo, card, ...target, watchDigest, holder: holder.process };
    if (reply.state !== 'OPEN' || reply.isDraft) throw deliveryError('a delivery can only be armed on the exact ready pull request.');
    // The job merges its checked head itself, so an auto-merge request, whoever queued it, could merge past that check.
    if (reply.autoMergeRequest !== null) throw deliveryError('a delivery can only be armed on a pull request with no auto-merge request.');
    await context.requireLease(holder);
    if (!context.checkReceiptDirectory()) {
      mkdirSync(dirname(context.receiptPath), { recursive: true, mode: 0o700 });
      context.checkReceiptDirectory();
    }
    try {
      writeDeliveryRecord(context.receiptPath, receipt);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const prior = context.readReceipt();
      // The same holder rearming the same pull request on a repaired head replaces its own receipt.
      if (!isDeepStrictEqual(prior, receipt)) {
        if (!isDeepStrictEqual({ ...prior, head }, receipt)) throw deliveryError('another armed pull request still owns the delivery receipt.');
        const temporary = `${context.receiptPath}.${randomUUID()}`;
        writeDeliveryRecord(temporary, receipt);
        if (!isDeepStrictEqual(context.readReceipt(), prior)) {
          unlinkSync(temporary);
          throw deliveryError('the armed delivery receipt changed.');
        }
        renameSync(temporary, context.receiptPath);
      }
    }
    await context.requireLease(holder);
  }
  if (reply.state === 'CLOSED') throw deliveryError('GitHub confirmed that the pull request closed without merging.');
  await context.requireLease(holder);
  await context.label(reply.state === 'MERGED' ? 'merged' : 'open', { repo: context.repo, pr });
  return 0;
}

async function watchHeldDelivery(context, pr) {
  const holder = await context.requireLease();
  const receipt = context.readReceipt();
  if (context.codex || !receipt || receipt.pr !== pr || receipt.card !== context.card || !isDeepStrictEqual(receipt.holder, holder.process)) {
    throw deliveryError('the exact pull request is not armed by the current Claude delivery holder.');
  }
  const { repo } = receipt;
  const check = async () => {
    await context.requireLease(holder);
    if (!isDeepStrictEqual(context.readReceipt(), receipt)) throw deliveryError('the armed delivery receipt changed.');
  };
  // Loss of the holder follows the watch's ordinary stop path, which owns forwarder and hook cleanup.
  const monitor = async () => {
    try {
      for (;;) {
        await context.waitTo(context.now() + DELIVERY_PROBE_MS);
        await check();
      }
    } catch (error) {
      return reasonOf(error);
    }
  };
  const beforeForward = async () => {
    await check();
    const verified = context.verifyOrigin();
    if (verified.id !== holder.repositoryId || verified.nameWithOwner !== repo) {
      throw deliveryError('GitHub did not confirm the armed repository.');
    }
    await check();
  };
  let watchReason;
  const result = await context.watch(String(pr), {
    output: { error: (line) => context.output.error(line), log: (line) => { watchReason = line; } },
    ghExec: context.gh, now: context.now, untilSignal: monitor, stateDir: context.watchStateDir,
    coordinated: { repo, beforeForward, head: receipt.head },
  });
  if (result !== 0) throw deliveryError(watchReason ?? 'the merge watch did not complete.');
  await check();
  if (context.watchStatus(repo) !== undefined) throw deliveryError('the merge watch record still needs cleanup.');
  if (context.pull(receipt).state !== 'OPEN') throw deliveryError('GitHub has not confirmed that the exact pull request is still open on its armed head.');
  await context.requireLease(holder);
  await context.label('open', { repo, pr });
  context.output.log(watchReason ?? `required checks passed on ${receipt.head}`);
  return 0;
}

/** @typedef {{ mode: 'hold' } | { mode: 'watch', pr: number } | { mode: 'pr', pr: number, head: string, arm: boolean } | { mode: 'ready', seconds: number }} DeliveryForm */

// The shared launcher supplies its watcher callback. State overrides are in-process fixture seams only.
export async function runDelivery(/** @type {DeliveryForm} */ options, dependencies) {
  const {
    cwd = process.cwd(), gitExec: git = (args) => execFileSync('git', args, { cwd, env: gitEnvironment(), encoding: 'utf8', stdio: 'pipe', timeout: 15_000 }),
    hc = herdrCommand('hc', 5_000), env = process.env, ghExec: gh, output, watch,
    accountHome = userInfo().homedir, lockRoot = `/tmp/fabraik-delivery-${userInfo().uid}`, watchStateDir = defaultStateDir(),
    pid = process.pid, now = Date.now, sleep = delay, readProcessTable,
    readLiveCodexBinding: liveBinding = readLiveCodexBinding, readDeliveryLease = localDeliveryLease, untilSignal = () => new Promise(() => {}),
  } = dependencies;
  const controller = new AbortController();
  const { signal } = controller;
  let label;
  try {
    if (process.platform !== 'linux') throw deliveryError('coordinated delivery requires Linux.');
    const address = env.HC_TERMINAL_ID;
    if (!LOCAL_HERDR_TERMINAL.test(address ?? '')) throw deliveryError('HC_TERMINAL_ID must name the local Herdr job.');
    const terminal = () => readRecord(hc, address, 'verify the delivery job', (value) => value);
    const live = await terminal();
    const generation = deliveryGeneration(live);
    const labels = generation.labels;
    const codex = labels['fabraik.runtime'] === 'codex';
    const card = Number(labels['fabraik.card']);
    const runStart = labels['fabraik.runstart'];
    if (live?.state !== 'live' || generation.address !== address || !positiveNumber(generation.pid)
      || !positiveNumber(generation.created_ms) || labels['fabraik.role'] !== 'job'
      || !/^[1-9]\d*$/.test(labels['fabraik.card'] ?? '') || !positiveNumber(card)
      || !RUN_START.test(runStart ?? '') || !Number.isFinite(Date.parse(runStart))
      || (codex ? labels['fabraik.session'] !== undefined : labels['fabraik.runtime'] !== undefined || !V4_UUID.test(labels['fabraik.session'] ?? ''))) {
      throw deliveryError('Herdr could not verify the live job generation.');
    }
    const worktree = git(['rev-parse', '--show-toplevel']).trim();
    const inventory = parseWorktreeList(git(['worktree', 'list', '--porcelain', '-z']));
    const root = dependencies.root ?? inventory?.[0]?.path;
    if (!inventory || !managedPath(root) || realpathSync(root) !== root || root !== inventory[0].path
      || !managedPath(worktree) || worktree !== realpathSync(cwd)
      || inventory.filter((entry) => entry.path === worktree && entry.branch === `refs/heads/job/${card}`).length !== 1
      // Herdr keeps cwd as the launch folder; only the live Claude foreground shows the worktree the job entered.
      || (codex ? generation.cwd !== root
        : (generation.cwd !== root && generation.cwd !== worktree)
          || live.foreground?.name !== 'claude' || live.foreground.cwd !== worktree)) {
      throw deliveryError('the native job does not match its registered physical worktree.');
    }

    const pinned = !codex && env.FABRAIK_COORDINATED_JOB === '1';
    // A pinned caller's label keeps its whole reason, so the readiness check that reports it never cuts the recovery short.
    label = async (phase, details = {}, stopped = false) => {
      let terminalRow;
      try {
        terminalRow = await terminal();
      } catch (error) {
        if (stopped) return;
        throw error;
      }
      const current = deliveryGeneration(terminalRow);
      if (!sameDeliveryRow(generation, current) || (!stopped && (terminalRow?.state !== 'live' || current.pid !== generation.pid))) {
        if (stopped) return;
        throw deliveryError('the Herdr job generation changed.');
      }
      const currentPhase = labelState(current.delivery)?.phase;
      if (stopped && currentPhase === 'merged') return;
      if (phase === 'waiting' && currentPhase !== undefined && currentPhase !== 'waiting' && currentPhase !== 'stopped') return;
      if (phase === 'clear-waiting' && currentPhase !== 'waiting') return;
      const { reason, ...target } = details;
      const value = { phase, ...target, ...(reason && { reason: pinned ? oneLine(reason) : oneLine(reason).slice(0, 500) }) };
      const marked = await hc(['label', address, `${DELIVERY_LABEL}=${phase === 'clear-waiting' ? '' : JSON.stringify(value)}`]);
      if (marked.code !== 0) throw deliveryError('Herdr could not update the current delivery label.');
    };

    // A coordinated Claude job, the only kind Herdr pins to a workflow version, verifies that version, drift included,
    // at the head of its reserve and readiness routes, before any lane, lock or lease access.
    if (pinned && (options.mode === 'hold' || options.mode === 'ready')) verifyJobPin({ env, cwd: root, drift: true });

    const origin = readOrigin({ git });
    const slug = deliveryOriginSlug(origin);
    if (!DELIVERY_REPO.test(slug)) throw deliveryError('the origin is not an explicit github.com repository.');
    const binding = codex ? await liveBinding({ root, hc }) : undefined;
    if (binding && (binding.card !== card || binding.runStart !== runStart
      || binding.terminalAddress !== address || binding.terminalCreatedMs !== generation.created_ms
      || binding.parentAddress !== generation.parent || binding.threadId !== env.CODEX_THREAD_ID)) {
      throw deliveryError('the live Codex binding does not match the delivery job.');
    }
    const verifyOrigin = () => {
      const verified = originRepository({ git, exec: gh, origin });
      const { id, nameWithOwner: repo } = verified;
      if (!DELIVERY_REPO.test(repo) || repo.toLowerCase() !== slug.toLowerCase() || id.length > 256
        || (binding && binding.repositoryId !== id)) {
        throw deliveryError('GitHub could not verify the explicit origin repository.');
      }
      return verified;
    };

    const processIdentity = { pid, start: deliveryProcessStart(pid) };
    const liveRow = async () => {
      const current = await terminal();
      const row = deliveryGeneration(current);
      if (current?.state !== 'live' || !sameDeliveryRow(generation, row) || row.pid !== generation.pid || !sameDeliveryProcess(processIdentity)) {
        throw deliveryError('the original delivery process or Herdr job is no longer live.');
      }
      return row;
    };
    const assertLive = async () => {
      signal.throwIfAborted();
      const row = await liveRow();
      signal.throwIfAborted();
      return row;
    };
    const waitTo = async (deadline) => {
      while (now() < deadline) {
        await deliveryPause(sleep, Math.min(DELIVERY_PROBE_MS, deadline - now()), signal);
        await assertLive();
      }
    };
    if (options.mode !== 'pr') {
      void untilSignal().then((name) => controller.abort(deliveryError(`stopped by ${name}.`)));
    }
    const leaseContext = { lockRoot, worktree, generation, origin, assertLive, signal };
    if (options.mode === 'ready') {
      const readLease = () => readDeliveryLease(leaseContext, binding?.repositoryId);
      return await deliveryReadiness({ now, output, assertLive, waitTo, readLease }, options.seconds, generation.delivery);
    }

    if (options.mode === 'hold') {
      await assertLive();
      await label('waiting', { reason: DELIVERY_PENDING });
    }
    let id;
    let repo;
    let base;
    if (options.mode === 'watch') {
      if (codex) throw deliveryError('only the current Claude delivery holder can start an armed merge watch.');
      const local = await readDeliveryLease(leaseContext, undefined);
      if (!local) throw deliveryError('the current job has no matching live delivery reservation.');
      id = local.repositoryId;
    } else {
      const verified = verifyOrigin();
      ({ id, nameWithOwner: repo, defaultBranch: base } = verified);
    }

    if (!managedPath(accountHome) || realpathSync(accountHome) !== accountHome || lstatSync(accountHome).uid !== deliveryUid()) {
      throw deliveryError('the operating-system account home could not be verified.');
    }
    const excluded = [lockRoot, ...inventory.map(({ path }) => path)];
    if (dependencies.accountHome === undefined) excluded.push('/tmp', '/var/tmp', '/dev/shm');
    const state = { accountHome, excluded };
    const receiptFolder = join(accountHome, '.local', 'state', 'fabraik-merge-watch');
    const key = sha256(id);
    const laneFolder = join(lockRoot, key);
    const lane = (create) => checkedLaneDirectory(lockRoot, create) && checkedLaneDirectory(laneFolder, create);
    const lockPath = join(laneFolder, 'delivery.lock');
    const readyPath = join(laneFolder, 'ready.json');
    const receiptPath = join(receiptFolder, `delivery-${key}.json`);
    const watchDigest = sha256(watchStateDir);
    const checkReceiptDirectory = () => checkedStateDirectory(receiptFolder, state);
    const checkWatchDirectory = () => checkedStateDirectory(watchStateDir, state);
    checkWatchDirectory();
    const contextRecord = { id, repo, slug, watchDigest };
    const readReceipt = () => {
      if (!checkReceiptDirectory()) return undefined;
      const record = optionalDeliveryRecord(receiptPath);
      if (record !== undefined && !validDeliveryReceipt(record, contextRecord)) {
        throw deliveryError('the previous delivery receipt does not match the verified repository and merge-watch state context.');
      }
      return record;
    };
    const requireLease = async (expected) => {
      const ready = await readDeliveryLease(leaseContext, id);
      if (!ready || (expected && !isDeepStrictEqual(ready, expected))) throw deliveryError('the current job has no matching live delivery reservation.');
      return ready;
    };
    const watchStatus = (slug) => checkWatchDirectory() ? coordinatedWatchIsLive(watchStateDir, slug, readProcessTable) : undefined;
    const pull = (target) => exactDeliveryPull(gh, target.repo ?? repo, target);
    const context = { id, base, repo, card, codex, worktree, generation, origin, processIdentity, receiptPath, readyPath, lockPath, signal,
      lane, label, readReceipt, checkReceiptDirectory, watchDigest, watchStatus, assertLive, liveRow, waitTo, requireLease,
      output, pull, now, watch, gh, verifyOrigin, watchStateDir, pinned };
    if (options.mode === 'hold') return await holdDelivery(context);
    if (options.mode === 'pr') return await observeDeliveryPull(context, options);
    return await watchHeldDelivery(context, options.pr);
  } catch (error) {
    const reason = deliveryError(reasonOf(error)).message;
    if (label && options.mode !== 'ready') {
      try {
        await label('stopped', { reason }, true);
      } catch (markError) {
        output.error(reasonOf(markError));
      }
    }
    output.log(reason);
    return 1;
  } finally {
    controller.abort(deliveryError('the delivery command ended.'));
  }
}
