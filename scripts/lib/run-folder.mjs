// run-folder.mjs — the private temporary folder scripts/run-log.mjs gives each run: its name, the processes still
// carrying it, and how they stop.
//
// A run folder is named runFolderPrefix(canonical repository root) plus a random suffix, so every folder of one
// checkout shares a prefix that no other checkout's folders carry.
// A process carries a run folder when its TMPDIR is the folder or a folder below it. Only Linux shows another
// process's environment (under /proc), so the scan answers 'unchecked' elsewhere. /proc is hostile input: an entry
// that cannot be read, has vanished or is malformed is skipped.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const POLL_MS = 100;
const POLL_WINDOW_MS = 5000;

export const runFolderPrefix = (canonicalRoot) =>
  `fabraik-run-${createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12)}-`;

// The pids whose TMPDIR is `folder` or below it, or 'unchecked' off Linux or when the process table cannot be listed.
export function processesUsing(folder, { platform = process.platform, procRoot = '/proc' } = {}) {
  if (platform !== 'linux') return 'unchecked';
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return 'unchecked';
  }
  const pids = [];
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let environ;
    try {
      environ = readFileSync(join(procRoot, entry, 'environ'), 'utf8');
    } catch {
      continue;
    }
    // The first TMPDIR wins, as getenv reads it.
    const value = environ.split('\0').find((pair) => pair.startsWith('TMPDIR='))?.slice('TMPDIR='.length);
    if (value && (value === folder || value.startsWith(`${folder}/`))) pids.push(Number(entry));
  }
  return pids;
}

// Blocks the thread: run-log runs synchronously around a synchronous child.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Sends SIGTERM to each pid still carrying the folder and polls for up to five seconds, sending SIGTERM to any carrier
// that appears meanwhile, the final poll's included, then does the same with SIGKILL for those still carrying it.
// After the SIGKILL window the folder is rescanned every poll, since a killed process takes a moment to exit: each poll
// sends SIGKILL to any carrier never sent it, and polling continues only while some carrier is still unsent or was sent
// SIGKILL less than five seconds ago, so a carrier already a window past its SIGKILL adds no wait. The confirmation wait lasts at most one
// poll window from its start, however many carriers appear; when that cap ends it, the folder is rescanned once more
// after its final SIGKILL pass, with no further wait, and the last rescan decides the survivors.
// `processesUsing` is rescanned before every signal so a pid that has stopped carrying the folder, which may now be
// another process, is never signalled. Returns `survivors`, every pid carrying it at the end, replacements included,
// and `stopped`, every pid actually signalled that no longer carries it; a rescan that cannot read the process table
// keeps every remaining pid as a survivor.
/**
 * @param {number[]} pids
 * @param {{ kill?: (pid: number, signal: NodeJS.Signals) => void, processesUsing: () => number[] | 'unchecked', sleep?: (ms: number) => void }} seams
 * @returns {{ stopped: number[], survivors: number[] }}
 */
export function stopProcesses(pids, { kill = (pid, signal) => process.kill(pid, signal), processesUsing: scan, sleep = pause }) {
  const signalled = new Set();
  // The time spent sleeping so far, the clock each signal's send time is read from.
  let clock = 0;
  const wait = () => {
    sleep(POLL_MS);
    clock += POLL_MS;
  };
  // Sends `name` to each carrier not yet in `sent` that the scan still lists. A pid is recorded in `sent` with the time
  // it was settled: signalled, no longer a carrier, or ended before the signal. A recheck that cannot read the process
  // table settles nothing, so a later poll retries that pid.
  const signal = (carriers, name, sent) => {
    for (const pid of carriers.filter((candidate) => !sent.has(candidate))) {
      const found = scan();
      if (found === 'unchecked') continue;
      sent.set(pid, clock);
      if (!found.includes(pid)) continue;
      try {
        kill(pid, name);
        signalled.add(pid);
      } catch {
        // The process ended between the scan and the signal.
      }
    }
  };
  const rescan = (carriers) => {
    const found = scan();
    return found === 'unchecked' ? carriers : found;
  };
  const round = (carriers, name, sent) => {
    let remaining = carriers;
    for (let waited = 0; ; waited += POLL_MS) {
      signal(remaining, name, sent);
      remaining = rescan(remaining);
      if (!remaining.length) return remaining;
      if (waited >= POLL_WINDOW_MS) {
        signal(remaining, name, sent);
        return rescan(remaining);
      }
      wait();
    }
  };
  let survivors = round(pids, 'SIGTERM', new Map());
  if (survivors.length) {
    const killed = new Map();
    survivors = round(survivors, 'SIGKILL', killed);
    const confirmStart = clock;
    for (;;) {
      signal(survivors, 'SIGKILL', killed);
      if (clock - confirmStart >= POLL_WINDOW_MS) {
        survivors = rescan(survivors);
        break;
      }
      if (!survivors.some((pid) => !killed.has(pid) || clock - killed.get(pid) < POLL_WINDOW_MS)) break;
      wait();
      survivors = rescan(survivors);
    }
  }
  return { stopped: [...signalled].filter((pid) => !survivors.includes(pid)), survivors };
}
