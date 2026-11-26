// Codex hook adapters: provider payload shapes and Herdr job binding for the unsafe-git guard, and builder handoff records.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { ContainedReadError, containedEntry, readAppRunConnection, readContainedEntry } from './checkout-context.mjs';
import { ghExecutable, gitExecutable } from './posix-shell.mjs';
import { LOCAL_HERDR_TERMINAL } from './runtimes.mjs';
import { CODEX_HERDR_UNAVAILABLE } from './unsafe-git.mjs';

/** @type {(options: { sessionCwd, payload, env?, operatingRoot }) => ReturnType<typeof readAppRunConnection>} */
export function readCodexAppRun({ sessionCwd, payload, env, operatingRoot }) {
  return readAppRunConnection({ sessionCwd, sessionId: payload?.session_id, reportedCwd: payload?.cwd, env, operatingRoot });
}

export const CODEX_HERDR_BIND = 'node scripts/coordinator.mjs bind-job';
const ROOT_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function hostRead(command, args, cwd, env, timeout = 5000) {
  return spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function nativeTerminal(address, root, env) {
  const reply = hostRead('hc', ['get', address, '--json'], root, env);
  if (reply.error || reply.status !== 0) throw new Error('hc get failed');
  const terminal = JSON.parse(reply.stdout);
  if (terminal?.address !== address || terminal.state !== 'live') throw new Error('unverified terminal');
  return terminal;
}

// The guard reads the private launcher prefix from Herdr, independently of the hook's inherited marks.
function nativeCodexLaunch(argv) {
  if (!Array.isArray(argv)) return undefined;
  const [launcher, run, cardMark, coordinated, program, daemon, enable, mode] = argv;
  const runStart = typeof run === 'string' ? /^PRE_APPROVED_RUN_SESSION=(.+)$/.exec(run)?.[1] : undefined;
  const card = typeof cardMark === 'string' ? Number(/^PRE_APPROVED_RUN_CARD=([1-9]\d*)$/.exec(cardMark)?.[1]) : NaN;
  if (launcher === '/usr/bin/env' && runStart && UTC_SECOND.test(runStart) && Number.isSafeInteger(card)
      && coordinated === 'FABRAIK_COORDINATED_JOB=1'
      && (program === 'codex' || (typeof program === 'string' && isAbsolute(program) && basename(program) === 'codex'))
      && daemon === '--no-daemon' && enable === '--enable' && mode === 'default_mode_request_user_input') return { card, runStart, program };
  return undefined;
}

function checkedNativeBindingCard({ address, parent, created_ms: created, cwd }, root, env) {
  if (cwd !== root || typeof parent !== 'string' || !LOCAL_HERDR_TERMINAL.test(parent) || !Number.isSafeInteger(created)) {
    return undefined;
  }
  try {
    // The standalone guard loads the optional Coordinator only when it needs to check a binding.
    const { readCodexBinding } = createRequire(import.meta.url)('./coordinator.mjs');
    const binding = readCodexBinding({ root, address, env });
    if (binding.parentAddress === parent && binding.terminalCreatedMs === created) return binding.card;
  } catch {
    // Without current native launch or binding evidence this lookup cannot distinguish a job.
  }
  return undefined;
}

// The guard's synchronous roster read correlates a suspected child without running the Coordinator's bind checks.
function matchesNativeJobRoster({ address, parent, labels, cwd }, card, root, env) {
  if (cwd !== root || realpathSync.native(root) !== root
      || typeof parent !== 'string' || !LOCAL_HERDR_TERMINAL.test(parent) || parent === address) return false;
  const reply = hostRead('herdr-app', ['ls'], root, env);
  if (reply.error || reply.status !== 0) return false;
  let spaces;
  try {
    spaces = JSON.parse(reply.stdout)?.spaces;
  } catch {
    return false;
  }
  if (!Array.isArray(spaces)) return false;
  const projects = spaces.filter((space) => space?.folder === root && space.machine === null);
  if (projects.length !== 1) return false;
  const [{ id, tabs }] = projects;
  if (typeof id !== 'string' || !id || (labels['herdr.space'] !== undefined && labels['herdr.space'] !== id)
      || !Array.isArray(tabs)) return false;
  const matchesSlot = (name, terminalAddress, expectedId) => {
    const slots = tabs.filter((tab) => tab?.name === name);
    return slots.length === 1 && typeof slots[0].id === 'string' && slots[0].id
      && (expectedId === undefined || slots[0].id === expectedId)
      && Array.isArray(slots[0].terminals)
      && slots[0].terminals.filter((entry) => entry?.terminal === terminalAddress).length === 1;
  };
  return matchesSlot('Coordinator', parent, undefined) && matchesSlot(`job ${card}`, address, labels['herdr.tab']);
}

// The default Herdr core has a terminal address without a session name. Tool input cannot supply either.
export function readCodexHerdrTerminal({ env = process.env, operatingRoot }) {
  const { HC_SESSION: session, HC_TERMINAL_ID: address } = env;
  if (session === undefined && address === undefined) return null;
  const unverified = { runUnavailable: `${CODEX_HERDR_UNAVAILABLE}: the native terminal identity could not be verified` };
  if ((session !== undefined && !session.trim()) || !address || !LOCAL_HERDR_TERMINAL.test(address)) return unverified;

  try {
    const terminal = nativeTerminal(address, operatingRoot, env);
    const { labels, foreground } = terminal;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return unverified;
    if (!Object.keys(labels).some((name) => name.startsWith('fabraik.'))) {
      const card = nativeCodexLaunch(terminal.argv)?.card ?? checkedNativeBindingCard(terminal, operatingRoot, env);
      if (card === undefined) return null;
      // Lost labels cannot let a suspected child publish without the owner's verified choice.
      const matchesRoster = matchesNativeJobRoster(terminal, card, operatingRoot, env);
      return { runUnavailable: matchesRoster ? CODEX_HERDR_UNAVAILABLE
        : `${CODEX_HERDR_UNAVAILABLE}: the native project or job roster could not be verified` };
    }
    if (labels['fabraik.role'] !== 'job') return unverified;
    const runtime = labels['fabraik.runtime'];
    if (foreground?.name === 'claude' && (runtime === undefined || runtime === 'claude')) return null;
    if (runtime !== 'codex' || (foreground != null && foreground.name !== 'codex') ||
        terminal.cwd !== operatingRoot || realpathSync.native(operatingRoot) !== operatingRoot) {
      return unverified;
    }
    return { terminal, runUnavailable: CODEX_HERDR_UNAVAILABLE };
  } catch {
    return unverified;
  }
}

function nativeBindIdentity(terminal, root) {
  const { address, parent, created_ms: created, pid, labels } = terminal;
  const card = Number(labels?.['fabraik.card']);
  const runStart = labels?.['fabraik.runstart'];
  const instant = typeof runStart === 'string' && UTC_SECOND.test(runStart) ? Date.parse(runStart) : NaN;
  const space = labels?.['fabraik.space'];
  const tab = labels?.['herdr.tab'];
  if (terminal.cwd !== root || labels?.['fabraik.role'] !== 'job' || labels['fabraik.runtime'] !== 'codex'
      || typeof parent !== 'string' || !LOCAL_HERDR_TERMINAL.test(parent) || parent === address
      || !Number.isSafeInteger(created) || created < 1 || !Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(card) || card < 1 || labels['fabraik.card'] !== String(card)
      || !Number.isFinite(instant) || new Date(instant).toISOString() !== runStart.replace('Z', '.000Z')
      || typeof space !== 'string' || !space || labels['herdr.space'] !== space
      || typeof tab !== 'string' || !tab) throw new Error('unverified Herdr job identity');
  return { address, parent, created, pid, card, runStart, space, tab };
}

function nativeBindRollout(payload, root, sessionCwd, env) {
  const input = payload?.tool_input;
  if (payload?.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'Bash' ||
      input?.command !== CODEX_HERDR_BIND || Object.hasOwn(input, 'cmd') ||
      sessionCwd !== root || payload.cwd !== root || codexCwdForGuard(payload) !== root ||
      (Object.hasOwn(input, 'workdir') && input.workdir !== root)) {
    throw new Error('unverified Bash hook payload');
  }
  return nativeRollout(payload, env);
}

function nativeRollout(payload, env) {
  const thread = payload?.session_id;
  const rollout = payload?.transcript_path;
  if (typeof payload?.tool_use_id !== 'string' || !payload.tool_use_id.trim() ||
      Object.hasOwn(payload, 'agent_id') || Object.hasOwn(payload, 'agent_type') ||
      typeof thread !== 'string' || !ROOT_THREAD.test(thread) || typeof rollout !== 'string' || !isAbsolute(rollout)) {
    throw new Error('unverified native root callback');
  }
  const home = env.CODEX_HOME ?? join(homedir(), '.codex');
  const sessions = join(home, 'sessions');
  const path = new RegExp(`^([0-9]{4})/([0-9]{2})/([0-9]{2})/rollout-\\1-\\2-\\3T[0-9]{2}-[0-9]{2}-[0-9]{2}-${thread}\\.jsonl$`);
  if (!isAbsolute(home) || realpathSync.native(home) !== home || realpathSync.native(sessions) !== sessions
      || !rollout.startsWith(`${sessions}${sep}`) || !path.test(rollout.slice(sessions.length + 1))
      || realpathSync.native(rollout) !== rollout) throw new Error('unverified provider rollout path');
  return { thread, rollout };
}

function codexProcess(proc, pid, root, program) {
  const stat = readFileSync(join(proc, 'stat'), 'utf8');
  const [state, , group, , tty, activeGroup, ...fields] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const start = fields[13]; // Linux proc stat field 22, after the six fields above and pid/comm.
  const binary = readlinkSync(join(proc, 'exe'));
  if (!stat.startsWith(`${pid} (codex) `) || !/^[RSD]$/.test(state) || !/^[1-9]\d*$/.test(start)
      || group !== String(pid) || group !== activeGroup || !/^-?[1-9]\d*$/.test(tty)
      || statSync(proc).uid !== process.getuid?.() || readlinkSync(join(proc, 'cwd')) !== root
      || basename(binary) !== 'codex' || realpathSync.native(binary) !== binary || !statSync(binary).isFile()
      || (program !== 'codex' && (!isAbsolute(program) || realpathSync.native(program) !== binary))) {
    throw new Error('unverified Codex foreground process');
  }
  return { start, tty, binary };
}

function openRollout(proc, rollout) {
  const named = lstatSync(rollout);
  if (!named.isFile() || named.nlink !== 1 || named.uid !== process.getuid?.()) throw new Error('unverified provider rollout');
  const fds = join(proc, 'fd');
  for (const fd of readdirSync(fds)) {
    const path = join(fds, fd);
    try {
      if (readlinkSync(path) !== rollout) continue;
      const opened = statSync(path);
      if (opened.dev === named.dev && opened.ino === named.ino && opened.nlink === 1) return { dev: named.dev, ino: named.ino };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('the exact Codex foreground has no open provider rollout');
}

function proveCodexForeground(terminal, pid, root, rollout, launchProgram = 'codex') {
  const foreground = terminal.foreground;
  const program = foreground?.argv?.[0];
  if (foreground?.name !== 'codex' || foreground.pid !== pid || foreground.cwd !== root
      || !Array.isArray(foreground.argv) || typeof program !== 'string') throw new Error('unverified Herdr foreground');
  const proc = `/proc/${pid}`;
  const identity = codexProcess(proc, pid, root, program);
  const opened = openRollout(proc, rollout);
  return () => {
    if ((launchProgram !== 'codex' && realpathSync.native(launchProgram) !== identity.binary)
        || !isDeepStrictEqual(openRollout(proc, rollout), opened)
        || !isDeepStrictEqual(codexProcess(proc, pid, root, program), identity)) {
      throw new Error('the Codex foreground or rollout generation changed');
    }
  };
}

function hostRepositoryReads(root, env) {
  const read = (executable, args, readEnv, timeout) => {
    if (!executable) throw new Error('host executable unavailable');
    const reply = hostRead(executable, args, root, readEnv, timeout);
    if (reply.error || reply.status !== 0) throw new Error('host read failed');
    return reply.stdout;
  };
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const gitPath = gitExecutable({ env: gitEnv });
  const git = (args) => read(gitPath, args, gitEnv, 5000);
  // Use the repository-environment query from gitEnvironment with the same deadline as the other hook reads.
  for (const name of git(['rev-parse', '--local-env-vars']).trim().split('\n')) delete gitEnv[name];
  return { git, exec: (args) => read(ghExecutable({ env }), args, env, 10_000) };
}

const gitPaths = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'];

function integrationGitDir(root, git) {
  const paths = git(gitPaths).trimEnd().split('\n');
  const gitDir = join(root, '.git');
  if (!isDeepStrictEqual(paths, [root, gitDir, gitDir]) || realpathSync.native(gitDir) !== gitDir) {
    throw new Error('unverified Git integration root');
  }
  return gitDir;
}

function nativeDeliveryEvent(payload) {
  const { hook_event_name: event, tool_name: tool } = payload ?? {};
  return event === 'PreToolUse' && tool === 'Bash';
}

export function checkedDeliveryCwd(payload, { root, worktree }) {
  if (!nativeDeliveryEvent(payload)) return false;
  const { cwd } = payload;

  // Keep the binding from authorizing a Bash command in a different checkout.
  const workdir = codexCwdForGuard(payload);
  const inWorktree = (path) => typeof path === 'string' && (path === worktree || path.startsWith(`${worktree}${sep}`));
  if ((cwd !== root && !inWorktree(cwd)) || !inWorktree(workdir)) return false;

  const physicalDirectory = (path) => realpathSync.native(path) === path && lstatSync(path).isDirectory();
  try {
    return physicalDirectory(workdir) && (cwd === workdir || physicalDirectory(cwd));
  } catch {
    return false;
  }
}

// Publication reads the checked acknowledgment. Its original parent remains the child's parent
// after the Coordinator exits, so the reader looks up no new Coordinator.
export async function readCodexHerdrDeliveryBinding({ herdr, payload, operatingRoot: root, env = process.env }) {
  let check = 'the live Codex Herdr job identity or binding is missing';
  try {
    const terminal = herdr?.terminal;
    if (process.platform !== 'linux' || !terminal) throw new Error(check);
    const job = nativeBindIdentity(terminal, root);
    const launch = nativeCodexLaunch(terminal.argv);
    if (launch?.card !== job.card || launch.runStart !== job.runStart) throw new Error('unverified native launch');

    check = 'the native root callback or its open provider rollout could not be verified';
    if (!nativeDeliveryEvent(payload)) throw new Error('unexpected native event');
    const { thread, rollout } = nativeRollout(payload, env);
    const verifyForeground = proveCodexForeground(terminal, job.pid, root, rollout, launch.program);
    verifyForeground();

    check = 'the checked binding does not match the live native job, launch or root thread';
    const { readCodexBinding } = await import('./coordinator.mjs');
    const readBinding = () => readCodexBinding({ root, address: job.address, env });
    const binding = readBinding();
    if (binding.card !== job.card || binding.runStart !== job.runStart || binding.terminalCreatedMs !== job.created
        || binding.parentAddress !== job.parent || binding.threadId !== thread) throw new Error('binding identity mismatch');

    check = 'the canonical Git integration root or registered job worktree could not be verified';
    const { managedPath, readWorktreeInventory } = await import('./pre-approved-run.mjs');
    const { git } = hostRepositoryReads(root, env);
    const gitDir = integrationGitDir(root, git);
    const matches = readWorktreeInventory(git).filter(({ branch }) => branch === `job/${job.card}`);
    if (matches.length !== 1) throw new Error('job worktree inventory is ambiguous');
    const [{ path: worktree }] = matches;
    if (worktree === root || !managedPath(worktree) || realpathSync.native(worktree) !== worktree) throw new Error('noncanonical worktree');
    const [top, admin, common, ...extra] = git(['-C', worktree, ...gitPaths]).trimEnd().split('\n');
    if (extra.length || top !== worktree || common !== gitDir || admin === common || !isAbsolute(admin)
        || realpathSync.native(admin) !== admin) throw new Error('unverified linked worktree');

    check = 'the Bash working directory could not be verified';
    if (!checkedDeliveryCwd(payload, { root, worktree })) throw new Error('unverified Bash working directory');

    check = 'the native foreground, rollout or checked binding changed during verification';
    verifyForeground();
    if (!isDeepStrictEqual(readBinding(), binding)) throw new Error('binding changed');
    // The shared publication check compares the bound origin ID against the worktree's live origin.
    return { ...binding, worktree };
  } catch {
    throw new Error(`${CODEX_HERDR_UNAVAILABLE}: ${check}`);
  }
}

function createBindingFolder(folder, isCanonicalLeadFolder) {
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
  }
  if (!isCanonicalLeadFolder(folder)) throw new Error('unverified private binding folder');
}

function prepareBindingFolders(lead, delivery, isCanonicalLeadFolder) {
  const state = dirname(lead);
  const base = lstatSync(state);
  if (!base.isDirectory() || base.uid !== process.getuid?.() || (base.mode & 0o022) !== 0
      || realpathSync.native(state) !== state) throw new Error('unverified state root');
  createBindingFolder(lead, isCanonicalLeadFolder);
  createBindingFolder(delivery, isCanonicalLeadFolder);
}

// The receipt lock serializes compare-and-replace for this private state, independent of the project cap.
function writeCodexBinding(path, record, { readBinding, isCanonicalLeadFolder, verifyForeground }) {
  const delivery = dirname(path);
  const lead = dirname(delivery);
  if (!isCanonicalLeadFolder(lead) || !isCanonicalLeadFolder(delivery)) throw new Error('unverified binding folders');
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry) {
    const existing = readBinding();
    if (existing.terminalCreatedMs === record.terminalCreatedMs) {
      if (!isDeepStrictEqual(existing, record)) throw new Error('conflicting same-generation binding');
      verifyForeground();
      return;
    }
  }
  const temporary = join(delivery, `.${basename(path)}.${randomBytes(8).toString('hex')}`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let written;
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      written = fstatSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    verifyForeground();
    const now = lstatSync(path, { throwIfNoEntry: false });
    const next = lstatSync(temporary);
    if (!isCanonicalLeadFolder(lead) || !isCanonicalLeadFolder(delivery)
        || now?.dev !== entry?.dev || now?.ino !== entry?.ino
        || next.dev !== written.dev || next.ino !== written.ino || !next.isFile() || next.nlink !== 1
        || next.uid !== process.getuid?.() || (next.mode & 0o7777) !== 0o600) throw new Error('binding file identity changed');
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

// This callback records identity only. A confirmed bind does not change the guard's publication outcome.
export async function bindCodexHerdrJob({ herdr, payload, operatingRoot: root, sessionCwd, env = process.env }) {
  let check = 'the root Bash callback and provider-named transcript could not be verified';
  try {
    if (process.platform !== 'linux' || !herdr.terminal) return `${CODEX_HERDR_UNAVAILABLE}: native Codex terminal identity is required`;
    const { thread, rollout } = nativeBindRollout(payload, root, sessionCwd, env);
    check = 'the addressed live Herdr job and launch identity could not be verified';
    let terminal = herdr.terminal;
    const job = nativeBindIdentity(terminal, root);
    for (let retry = 0; terminal.foreground == null && retry < 3; retry += 1) {
      await delay(150);
      terminal = nativeTerminal(job.address, root, env);
      if (!isDeepStrictEqual(nativeBindIdentity(terminal, root), job)) throw new Error('Herdr job generation changed');
    }
    check = 'the live Codex foreground and its open root rollout could not be verified';
    const verifyForeground = proveCodexForeground(terminal, job.pid, root, rollout);
    verifyForeground();

    check = 'the native project space, job tab and Coordinator parent could not be verified';
    const { coordinatorTerminals, codexBindingPath, readCodexBinding } = await import('./coordinator.mjs');
    const herdrRead = (program) => async (args) => {
      const result = hostRead(program, args, root, env);
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: '' };
    };
    const { space, terminals } = await coordinatorTerminals({ root, herdrApp: herdrRead('herdr-app'), hc: herdrRead('hc') });
    const running = terminals.filter(({ running }) => running);
    const [parent] = running;
    const runtime = parent?.foregroundName;
    const tabs = space?.tabs.filter(({ name }) => name === `job ${job.card}`);
    if (space?.id !== job.space || running.length !== 1 || parent.address !== job.parent
        || (runtime !== 'codex' && runtime !== 'claude') || tabs?.length !== 1 || tabs[0].id !== job.tab
        || !Array.isArray(tabs[0].terminals) || tabs[0].terminals.filter(({ terminal }) => terminal === job.address).length !== 1) {
      throw new Error('unverified project or Coordinator identity');
    }

    check = 'the Git integration root or installed Coordinator runtime could not be verified';
    const { readCoordinator } = await import('./merge-evidence.mjs');
    const { git, exec } = hostRepositoryReads(root, env);
    integrationGitDir(root, git);
    if (!readCoordinator({ git, herdr: true, includeInstalled: true }).installed.includes(runtime)) {
      throw new Error('unverified integration root or Coordinator runtime');
    }

    check = 'the canonical origin repository could not be verified';
    const { checkedOriginRepository, isCanonicalLeadFolder } = await import('./pre-approved-run.mjs');
    verifyForeground();
    const { repository } = checkedOriginRepository({ git, exec,
      changedMessage: 'origin changed during Codex binding' });
    if (!/^[A-Za-z0-9_+/=-]+$/.test(repository.id)) throw new Error('unverified repository ID');

    check = 'the private acknowledgment could not be recorded without replacing conflicting state';
    const { capLock } = await import('./cap-lock.mjs');
    verifyForeground();
    const path = codexBindingPath(root, job.address, env);
    const delivery = dirname(path);
    prepareBindingFolders(dirname(delivery), delivery, isCanonicalLeadFolder);
    const record = {
      version: 1, root, repositoryId: repository.id, card: job.card, runStart: job.runStart,
      terminalAddress: job.address, terminalCreatedMs: job.created, parentAddress: job.parent, threadId: thread,
    };
    await capLock(delivery, async () => writeCodexBinding(path, record, {
      readBinding: () => readCodexBinding({ root, address: job.address, env }), isCanonicalLeadFolder, verifyForeground,
    }));
    return '';
  } catch {
    return `${CODEX_HERDR_UNAVAILABLE}: ${check}`;
  }
}

export function codexCommandForGuard(toolInput) {
  if (typeof toolInput?.cmd === 'string') return toolInput.cmd;
  if (typeof toolInput?.command === 'string') return toolInput.command;
  return '';
}

// The explicit command working directory when the tool input names one, else the callback's reported cwd.
export function codexCwdForGuard(payload) {
  if (typeof payload?.tool_input?.workdir === 'string') return payload.tool_input.workdir;
  if (typeof payload?.cwd === 'string') return payload.cwd;
  return '';
}

const UNBOUND = 'no builder handoff is bound to this builder thread: stop and report that the coordinator must dispatch it through .agents/templates/builder-handoff.md';
const UNBOUND_NOTICE = 'No builder handoff is bound to this builder thread, so every tool call will be refused: stop and report that the coordinator must dispatch it through .agents/templates/builder-handoff.md.\n';
const BOUND = 'Your builder handoff, checked against .agents/templates/builder-handoff.md and bound to this builder thread:\n\n';
const BAD_TASK = "a Codex builder dispatch needs a task_name of letters, digits, '-' and '_' only";
const BAD_IDS = "the builder handoff guard needs a session_id and agent_id of letters, digits, '-' and '_' only";
const NO_SOURCE = (task) => `a Codex builder dispatch needs its filled handoff saved as .claude/worklog/handoffs/${task}.md in the job worktree, as .agents/templates/builder-handoff.md says`;
const AMBIGUOUS = (task, paths) => `the builder handoff .claude/worklog/handoffs/${task}.md is saved in more than one worktree: ${paths}`;
const PENDING = (path) => `an earlier builder dispatch in this session has not started its builder: remove ${path} if that dispatch failed`;

const HANDOFF_DIRS = ['.claude', 'worklog', 'handoffs'];
const RECORD_ID = /^[A-Za-z0-9_-]+$/;
const SPAWN_TOOLS = new Set(['collaborationspawn_agent', 'spawn_agent']);
const ALLOW = Object.freeze({ status: 0, stdout: '', stderr: '' });
const NOTE = Object.freeze({ status: 0, stdout: UNBOUND_NOTICE, stderr: '' });
const refusal = (reason) => ({ status: 2, stdout: '', stderr: `Blocked: ${reason}.\n` });
const isRecordId = (value) => typeof value === 'string' && RECORD_ID.test(value);

// A record or worktree listing the handoff guard could not use: enforce and gate refuse with it, bind prints NOTE.
class HandoffRecordError extends Error {
  constructor(step, cause) {
    super(`the builder handoff guard could not ${step}: ${cause}`);
  }
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// The Codex builder handoff guard, run for every PreToolUse and SubagentStart: what the hook prints and its status.
// The worktree listing runs with `env` and the `git` executable, both injectable so tests can double them.
export async function codexHandoffHook(raw, { env = process.env, git = gitExecutable({ env }) } = {}) {
  // Loaded here, not at the top, so the unsafe-git guard that imports this module never loads the handoff checker.
  const { BUILDER_SEATS, callerIdentityProblem, checkHandoff, recordedRedProblem } = await import('./handoff-check.mjs');
  const p = parsePayload(raw);
  const readable = p !== null && typeof p === 'object' && !Array.isArray(p);
  // An unreadable payload cannot name its caller, so it is refused as an unreadable identity.
  const identityProblem = callerIdentityProblem(readable
    ? { callerType: p.agent_type, hasCallerId: Object.hasOwn(p, 'agent_id') }
    : { hasCallerId: true });
  if (identityProblem) return refusal(identityProblem);
  const builderThread = BUILDER_SEATS.includes(p.agent_type);
  const listing = { env, git };
  if (p.hook_event_name === 'SubagentStart') return builderThread ? bindBuilderThread(p, listing) : ALLOW;
  if (builderThread) return enforceBuilderThread(p, listing, checkHandoff);
  if (SPAWN_TOOLS.has(p.tool_name) && BUILDER_SEATS.includes(p.tool_input?.agent_type)) return gateBuilderDispatch(p, listing, checkHandoff, recordedRedProblem);
  return ALLOW;
}

async function listWorktrees(cwd, { env, git }) {
  if (typeof cwd !== 'string') throw new HandoffRecordError('list the worktrees', 'the hook payload carries no string cwd');
  // Null on Windows when no absolute PATH entry holds git.exe; a bare name would search the worktree first.
  if (git === null) throw new HandoffRecordError('list the worktrees', 'no git.exe in an absolute PATH entry');
  // Loaded only on a builder path, so every other tool call skips the cleanup module and its imports.
  const { parseWorktreeList } = await import('./closeout-cleanup.mjs');
  const listed = spawnSync(git, ['worktree', 'list', '--porcelain', '-z'], { cwd, env, encoding: 'utf8' });
  if (listed.error) throw new HandoffRecordError('list the worktrees', /** @type {NodeJS.ErrnoException} */ (listed.error).code);
  if (listed.status !== 0) throw new HandoffRecordError('list the worktrees', `git exited ${listed.status ?? listed.signal}`);
  const worktrees = parseWorktreeList(listed.stdout);
  if (worktrees === null) throw new HandoffRecordError('list the worktrees', 'git printed an unreadable worktree list');
  return worktrees;
}

// Each worktree's copy of one record, as { path, text, worktree } with the worktree's listing, in worktree-list order.
function findRecords(worktrees, names) {
  try {
    return worktrees
      .map((worktree) => ({ worktree, record: containedEntry(worktree.path, [...HANDOFF_DIRS, ...names]) }))
      .filter(({ record }) => record.entry !== null)
      .map(({ worktree, record }) => ({ path: record.path, text: readContainedEntry(record), worktree }));
  } catch (error) {
    if (error instanceof ContainedReadError) throw new HandoffRecordError(error.step, error.cause);
    throw error;
  }
}

// Writes a new record; false when one is already there.
function createRecord(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw new HandoffRecordError(`write ${path}`, /** @type {NodeJS.ErrnoException} */ (error).code);
  }
  try {
    writeFileSync(path, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return false;
    throw new HandoffRecordError(`write ${path}`, /** @type {NodeJS.ErrnoException} */ (error).code);
  }
}

// A builder thread acts only on the one bound record that passes the shared check.
async function enforceBuilderThread(p, listing, checkHandoff) {
  if (!isRecordId(p.session_id) || !isRecordId(p.agent_id)) return refusal(BAD_IDS);
  try {
    const bound = findRecords(await listWorktrees(p.cwd, listing), [p.session_id, `${p.agent_id}.md`]);
    if (bound.length !== 1) return refusal(UNBOUND);
    const result = checkHandoff({ subagent_type: p.agent_type, prompt: bound[0].text });
    return result.ok ? ALLOW : refusal(result.reason);
  } catch (error) {
    if (error instanceof HandoffRecordError) return refusal(error.message);
    throw error;
  }
}

// A starting builder takes this session's one pending record as its own and is shown it; SubagentStart cannot block.
async function bindBuilderThread(p, listing) {
  if (!isRecordId(p.session_id) || !isRecordId(p.agent_id)) return NOTE;
  try {
    const pending = findRecords(await listWorktrees(p.cwd, listing), [p.session_id, 'pending.md']);
    if (pending.length !== 1) return NOTE;
    const [{ path, text }] = pending;
    try {
      renameSync(path, join(dirname(path), `${p.agent_id}.md`));
    } catch {
      return NOTE;
    }
    return { status: 0, stdout: BOUND + text, stderr: '' };
  } catch (error) {
    if (error instanceof HandoffRecordError) return NOTE;
    throw error;
  }
}

// A builder dispatch passes only with one saved handoff that passes the shared check and whose strict red is recorded
// in the run log of the worktree holding it, and that handoff becomes pending.
async function gateBuilderDispatch(p, listing, checkHandoff, recordedRedProblem) {
  const task = p.tool_input.task_name;
  if (!isRecordId(task)) return refusal(BAD_TASK);
  if (!isRecordId(p.session_id)) return refusal(BAD_IDS);
  try {
    const worktrees = await listWorktrees(p.cwd, listing);
    const sources = findRecords(worktrees, [`${task}.md`]);
    if (sources.length === 0) return refusal(NO_SOURCE(task));
    if (sources.length > 1) return refusal(AMBIGUOUS(task, sources.map(({ path }) => path).join(', ')));
    // This lookup also checked the folders the pending record below is written under.
    const waiting = findRecords(worktrees, [p.session_id, 'pending.md']);
    if (waiting.length > 0) return refusal(PENDING(waiting[0].path));
    const [source] = sources;
    const result = checkHandoff({ subagent_type: p.tool_input.agent_type, prompt: source.text });
    if (!result.ok) return refusal(result.reason);
    // A listed worktree's branch is a full ref; a detached one lists none.
    const branch = source.worktree.branch?.replace(/^refs\/heads\//, '');
    const problem = recordedRedProblem(source.text, { worktree: source.worktree.path, branch });
    if (problem) return refusal(problem);
    const pending = join(dirname(source.path), p.session_id, 'pending.md');
    if (!createRecord(pending, source.text)) return refusal(PENDING(pending));
    try {
      unlinkSync(source.path);
    } catch (error) {
      try {
        unlinkSync(pending);
      } catch (cleanup) {
        throw new HandoffRecordError(`remove ${pending}`, /** @type {NodeJS.ErrnoException} */ (cleanup).code);
      }
      throw new HandoffRecordError(`remove ${source.path}`, /** @type {NodeJS.ErrnoException} */ (error).code);
    }
    return ALLOW;
  } catch (error) {
    if (error instanceof HandoffRecordError) return refusal(error.message);
    throw error;
  }
}
