// Codex hook adapters: provider payload shapes for the unsafe-git guard, and the builder handoff guard's Codex records.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAppRunConnection } from './checkout-context.mjs';
export { CODEX_APP_RUN_UNAVAILABLE } from './checkout-context.mjs';
import { gitExecutable } from './posix-shell.mjs';
import { kindOf } from './runtimes.mjs';

export function readCodexAppRun({ sessionCwd, payload, env, operatingRoot }) {
  return readAppRunConnection({ sessionCwd, sessionId: payload?.session_id, reportedCwd: payload?.cwd, env, operatingRoot });
}

export function codexCommandForGuard(toolInput) {
  if (typeof toolInput?.cmd === 'string') return toolInput.cmd;
  if (typeof toolInput?.command === 'string') return toolInput.command;
  return '';
}

// The command's own working directory when the tool input names one, else the session's.
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
// Opens without following a final link or waiting on a special file, as checkout-context.mjs reads its records.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
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
  const { BUILDER_SEATS, callerIdentityProblem, checkHandoff } = await import('./handoff-check.mjs');
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
  if (SPAWN_TOOLS.has(p.tool_name) && BUILDER_SEATS.includes(p.tool_input?.agent_type)) return gateBuilderDispatch(p, listing, checkHandoff);
  return ALLOW;
}

async function listWorktrees(cwd, { env, git }) {
  if (typeof cwd !== 'string') throw new HandoffRecordError('list the worktrees', 'the hook payload carries no string cwd');
  // Null on Windows when no absolute PATH entry holds git.exe; a bare name would search the worktree first.
  if (git === null) throw new HandoffRecordError('list the worktrees', 'no git.exe in an absolute PATH entry');
  // Loaded only on a builder path, so every other tool call skips the cleanup module and its imports.
  const { parseWorktreeList } = await import('./closeout-cleanup.mjs');
  const listed = spawnSync(git, ['worktree', 'list', '--porcelain', '-z'], { cwd, env, encoding: 'utf8' });
  if (listed.error) throw new HandoffRecordError('list the worktrees', listed.error.code);
  if (listed.status !== 0) throw new HandoffRecordError('list the worktrees', `git exited ${listed.status ?? listed.signal}`);
  const worktrees = parseWorktreeList(listed.stdout);
  if (worktrees === null) throw new HandoffRecordError('list the worktrees', 'git printed an unreadable worktree list');
  return worktrees;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new HandoffRecordError(`read ${path}`, error.code);
  }
}

// One worktree's copy of a record as { path, entry }, entry null where it or a folder above it is absent. A
// folder below the worktree that is not a real directory, or a record that is not a regular file, refuses before
// anything reads or changes it, so nothing follows a link out of the worktree (as runtimes.mjs checkContained walks).
function recordEntry(worktree, names) {
  const path = join(worktree, ...HANDOFF_DIRS, ...names);
  let folder = worktree;
  for (const name of [...HANDOFF_DIRS, ...names.slice(0, -1)]) {
    folder = join(folder, name);
    const stat = lstatIfPresent(folder);
    if (stat === null) return { path, entry: null };
    if (!stat.isDirectory()) throw new HandoffRecordError(`use ${path}`, `${folder} is ${kindOf(stat)}, not a directory`);
  }
  const entry = lstatIfPresent(path);
  if (entry !== null && !entry.isFile()) throw new HandoffRecordError(`use ${path}`, `it is ${kindOf(entry)}, not a regular file`);
  return { path, entry };
}

// A checked record's text, read through a descriptor that must still be that entry (checkout-context.mjs readAppRunFile).
function readRecord({ path, entry }) {
  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    throw new HandoffRecordError(`read ${path}`, error.code);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new HandoffRecordError(`read ${path}`, 'it changed while it was read');
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof HandoffRecordError) throw error;
    throw new HandoffRecordError(`read ${path}`, error.code);
  } finally {
    closeSync(fd);
  }
}

// Each worktree's copy of one record, as { path, text }, in worktree-list order.
function findRecords(worktrees, names) {
  return worktrees
    .map(({ path }) => recordEntry(path, names))
    .filter(({ entry }) => entry !== null)
    .map((record) => ({ path: record.path, text: readRecord(record) }));
}

// Writes a new record; false when one is already there.
function createRecord(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw new HandoffRecordError(`write ${path}`, error.code);
  }
  try {
    writeFileSync(path, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw new HandoffRecordError(`write ${path}`, error.code);
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

// A builder dispatch passes only with one saved handoff that passes the shared check, which becomes pending.
async function gateBuilderDispatch(p, listing, checkHandoff) {
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
    const pending = join(dirname(source.path), p.session_id, 'pending.md');
    if (!createRecord(pending, source.text)) return refusal(PENDING(pending));
    try {
      unlinkSync(source.path);
    } catch (error) {
      try {
        unlinkSync(pending);
      } catch (cleanup) {
        throw new HandoffRecordError(`remove ${pending}`, cleanup.code);
      }
      throw new HandoffRecordError(`remove ${source.path}`, error.code);
    }
    return ALLOW;
  } catch (error) {
    if (error instanceof HandoffRecordError) return refusal(error.message);
    throw error;
  }
}
