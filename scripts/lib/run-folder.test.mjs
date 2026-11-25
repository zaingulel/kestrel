// Tests for the run folder run-log gives each command: its name, the processes still carrying it and how they stop.
// The process scan reads a fixture /proc, so it runs on every platform; the stop sequence runs against injected
// kill, scan and sleep seams with no real process. Recurring cost: pure calls and a few fixture files, no subprocess.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processesUsing, runFolderPrefix, stopProcesses } from './run-folder.mjs';

test('the run folder prefix names the repository by the first 12 hex of its path hash', () => {
  // printf %s /work/example-repo | sha256sum gives 4902e36dbfea24dad819cce570cca07433ea4f8c56ffae13780c5fb7e1dfe6e2.
  assert.equal(runFolderPrefix('/work/example-repo'), 'fabraik-run-4902e36dbfea-');
});

test('processes carrying the run folder are found by their TMPDIR', async (t) => {
  const procRoot = mkdtempSync(join(tmpdir(), 'run-folder-proc-'));
  t.after(() => rmSync(procRoot, { recursive: true, force: true }));
  const folder = '/scratch/fabraik-run-4902e36dbfea-abc123';
  const environ = (pid, ...pairs) => {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'environ'), pairs.map((pair) => `${pair}\0`).join(''));
  };
  environ('100', 'PATH=/usr/bin', `TMPDIR=${folder}`);
  environ('101', `TMPDIR=${folder}/nested/deeper`, 'HOME=/home/example');
  environ('102', 'TMPDIR=/scratch/fabraik-run-4902e36dbfea-other');
  // A sibling whose name only starts with the folder's name is another folder.
  environ('103', `TMPDIR=${folder}-sibling`);
  // The folder appears only inside another variable's value.
  environ('104', `NOTE=TMPDIR=${folder}`);
  // Malformed: entries without `=` and a TMPDIR with no value.
  environ('105', 'garbage', 'TMPDIR', 'TMPDIR=');
  // Unreadable: environ is a directory, so reading it fails.
  mkdirSync(join(procRoot, '106', 'environ'), { recursive: true });
  // Vanished: the pid folder is left but environ is gone.
  mkdirSync(join(procRoot, '107'));

  await t.test('on Linux only the folder and the folders below it match', () => {
    const pids = processesUsing(folder, { platform: 'linux', procRoot });
    assert.deepEqual([...pids].sort((a, b) => a - b), [100, 101]);
  });

  await t.test('off Linux the scan is unchecked', () => {
    assert.equal(processesUsing(folder, { platform: 'darwin', procRoot }), 'unchecked');
    assert.equal(processesUsing(folder, { platform: 'win32', procRoot }), 'unchecked');
  });
});

// A fake process table: `alive` is the set of pids still carrying the folder, and each pid's `dies` names the signal
// that ends it, or nothing when it outlives every signal; a pid in `replaces` starts its replacements as it ends, and a
// pid in `appears` starts carrying the folder on the first scan after that many milliseconds of waiting, and a pid in
// `lingers` ends by its signal only after the next sleep, and the scan calls numbered in `unchecked`, counting from 1, answer
// 'unchecked'. Each signal records the milliseconds waited before it.
function fakeProcesses(dies, replaces = {}, appears = {}, lingers = [], unchecked = []) {
  const later = [...Object.values(replaces).flat(), ...Object.keys(appears).map(Number)];
  const alive = new Set(Object.keys(dies).map(Number).filter((pid) => !later.includes(pid)));
  const pending = new Map(Object.entries(appears).map(([pid, ms]) => [Number(pid), ms]));
  const signals = [];
  const sleeps = [];
  const dying = [];
  let scans = 0;
  const end = (pid) => {
    alive.delete(pid);
    for (const replacement of replaces[pid] ?? []) alive.add(replacement);
  };
  return {
    signals,
    sleeps,
    seams: {
      kill: (pid, signal) => {
        signals.push([pid, signal, sleeps.reduce((sum, ms) => sum + ms, 0)]);
        if (dies[pid] !== signal) return;
        if (lingers.includes(pid)) dying.push(pid);
        else end(pid);
      },
      processesUsing: () => {
        scans += 1;
        if (unchecked.includes(scans)) return 'unchecked';
        const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
        for (const [pid, ms] of pending) {
          if (waited < ms) continue;
          pending.delete(pid);
          alive.add(pid);
        }
        return [...alive];
      },
      sleep: (ms) => {
        sleeps.push(ms);
        dying.splice(0).forEach(end);
      },
    },
  };
}

describe('stopping the processes carrying a run folder', () => {
  test('SIGTERM ends a process that heeds it with no SIGKILL and no full wait', async () => {
    const fake = fakeProcesses({ 201: 'SIGTERM' });
    assert.deepEqual(await stopProcesses([201], fake.seams), { stopped: [201], survivors: [] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[201, 'SIGTERM']]);
    assert.ok(fake.sleeps.reduce((sum, ms) => sum + ms, 0) < 5000, 'a process gone at once must not cost the whole poll window');
  });

  test('a process ignoring SIGTERM gets SIGKILL only after the five second poll window', async () => {
    const fake = fakeProcesses({ 202: 'SIGTERM', 203: 'SIGKILL' });
    assert.deepEqual(await stopProcesses([202, 203], fake.seams), { stopped: [202, 203], survivors: [] });
    const terms = fake.signals.filter(([, signal]) => signal === 'SIGTERM').map(([pid]) => pid).sort();
    assert.deepEqual(terms, [202, 203]);
    const kills = fake.signals.filter(([, signal]) => signal === 'SIGKILL');
    assert.deepEqual(kills.map(([pid]) => pid), [203], 'only the process still carrying the folder is killed');
    assert.ok(kills[0][2] >= 5000, `SIGKILL came after ${kills[0][2]} ms of polling, before the five second window ended`);
  });

  test('a process outliving SIGKILL is returned as a survivor', async () => {
    const fake = fakeProcesses({ 204: undefined });
    assert.deepEqual(await stopProcesses([204], fake.seams), { stopped: [], survivors: [204] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[204, 'SIGTERM'], [204, 'SIGKILL']]);
    const waited = fake.sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited <= 10000, `a survivor sent no new signal must cost no wait beyond the two poll windows, waited ${waited} ms`);
  });

  test('a pid that no longer carries the folder is never signalled', async () => {
    // 205 is listed by the caller but gone from the scan by the time the stop starts: its pid may now be another process.
    const fake = fakeProcesses({ 206: 'SIGTERM' });
    // 205 was never signalled, so it is not counted as stopped.
    assert.deepEqual(await stopProcesses([205, 206], fake.seams), { stopped: [206], survivors: [] });
    assert.deepEqual(fake.signals.map(([pid]) => pid), [206]);
  });

  test('a replacement carrier appearing after SIGTERM is signalled and returned while it stays', async () => {
    // 301 starts 302 as SIGTERM ends it, and 302 outlives every signal.
    const fake = fakeProcesses({ 301: 'SIGTERM', 302: undefined }, { 301: [302] });
    assert.deepEqual(await stopProcesses([301], fake.seams), { stopped: [301], survivors: [302] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[301, 'SIGTERM'], [302, 'SIGTERM'], [302, 'SIGKILL']]);
  });

  test('every carrier signalled and gone counts as stopped, a replacement included', async () => {
    // 301 starts 302 as SIGTERM ends it, and SIGKILL ends 302.
    const fake = fakeProcesses({ 301: 'SIGTERM', 302: 'SIGKILL' }, { 301: [302] });
    assert.deepEqual(await stopProcesses([301], fake.seams), { stopped: [301, 302], survivors: [] });
  });

  test('a carrier first found on the final poll of the SIGKILL window is sent SIGKILL', async () => {
    // 401 outlives every signal; 402 starts carrying the folder at the final poll, ten seconds into the two windows.
    const fake = fakeProcesses({ 401: undefined, 402: 'SIGKILL' }, {}, { 402: 10000 });
    assert.deepEqual(await stopProcesses([401], fake.seams), { stopped: [402], survivors: [401] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[401, 'SIGTERM'], [401, 'SIGKILL'], [402, 'SIGKILL']]);
  });

  test('a carrier sent SIGKILL at the end of the window that exits a moment later is not a survivor', async () => {
    // 401 outlives every signal; 402 starts carrying the folder at the final poll of the SIGKILL window and SIGKILL ends
    // it, but only after the next sleep, as a real process takes a moment to exit.
    const fake = fakeProcesses({ 401: undefined, 402: 'SIGKILL' }, {}, { 402: 10000 }, [402]);
    assert.deepEqual(await stopProcesses([401], fake.seams), { stopped: [402], survivors: [401] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[401, 'SIGTERM'], [401, 'SIGKILL'], [402, 'SIGKILL']]);
  });

  test('a carrier appearing while a SIGKILL is confirmed is sent SIGKILL', async () => {
    // 401 outlives every signal; 402 starts carrying the folder at the final poll of the SIGKILL window, and SIGKILL ends
    // it only after the next sleep, starting 403 as it ends; SIGKILL ends 403 at once.
    const fake = fakeProcesses({ 401: undefined, 402: 'SIGKILL', 403: 'SIGKILL' }, { 402: [403] }, { 402: 10000 }, [402]);
    assert.deepEqual(await stopProcesses([401], fake.seams), { stopped: [402, 403], survivors: [401] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[401, 'SIGTERM'], [401, 'SIGKILL'], [402, 'SIGKILL'], [403, 'SIGKILL']]);
  });

  test('the confirmation wait ends one window after it starts however many carriers keep appearing', async () => {
    // 401 outlives every signal; 402 appears on the final poll of the SIGKILL window, ten seconds in, dies on SIGKILL after
    // the next sleep and is replaced by 403, and so on down a chain of 300 carriers. The two rounds cost 10000 ms and the
    // confirmation one window, 5000 ms, so a chain that stretches the wait past 15000 ms is not capped.
    const dies = { 401: undefined };
    const replaces = {};
    const chain = Array.from({ length: 300 }, (_, index) => 402 + index);
    for (const pid of chain) dies[pid] = 'SIGKILL';
    for (const [index, pid] of chain.slice(0, -1).entries()) replaces[pid] = [chain[index + 1]];
    const fake = fakeProcesses(dies, replaces, { 402: 10000 }, chain);
    const { survivors } = await stopProcesses([401], fake.seams);
    const waited = fake.sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited <= 15000, `the confirmation wait lasted until ${waited} ms, past the two rounds and one window`);
    assert.ok(survivors.includes(401));
  });

  test('a carrier first found on the final poll of the SIGTERM window is sent SIGTERM', async () => {
    // 501 ignores SIGTERM and carries the folder through the whole SIGTERM window; 502 starts carrying it at the final poll,
    // 5000 ms in, and SIGTERM ends it. The round sends 502 SIGTERM, never SIGKILL, and 501 falls to SIGKILL afterwards.
    const fake = fakeProcesses({ 501: 'SIGKILL', 502: 'SIGTERM' }, {}, { 502: 5000 });
    assert.deepEqual(await stopProcesses([501], fake.seams), { stopped: [501, 502], survivors: [] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[501, 'SIGTERM'], [502, 'SIGTERM'], [501, 'SIGKILL']]);
  });

  test('the confirmation cap reports the carriers left after its final SIGKILL', async () => {
    // 401 ignores SIGTERM; each carrier from 401 to 475 ends a sleep after its SIGKILL and starts the next, and 476 ends
    // at once by SIGKILL. The SIGTERM window ends at 5000 ms. In the SIGKILL window a new carrier is signalled two sleeps
    // after it starts, since the round signals the list it scanned before the last sleep, so 25 carriers follow 401 by
    // 10000 ms; the confirmation window signals each carrier a sleep after it starts, so 50 more follow by 15000 ms, the
    // cap. 476 starts at 15000 ms, is sent SIGKILL by the final pass and, as it ends on it, starts 477, which no signal
    // sent after its birth reaches. The final rescan finds 477, so it is the one survivor and the logger must not remove
    // the folder it carries.
    const dies = {};
    const replaces = {};
    const chain = Array.from({ length: 76 }, (_, index) => 401 + index);
    for (const pid of chain) dies[pid] = 'SIGKILL';
    for (const [index, pid] of chain.slice(0, -1).entries()) replaces[pid] = [chain[index + 1]];
    replaces[476] = [477];
    const fake = fakeProcesses(dies, replaces, {}, chain.slice(0, -1));
    assert.deepEqual(await stopProcesses([401], fake.seams), { stopped: chain, survivors: [477] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[401, 'SIGTERM'], ...chain.map((pid) => [pid, 'SIGKILL'])]);
  });

  test('a carrier whose ownership recheck cannot read the process table is signalled on a later poll', async () => {
    // 401 outlives every signal; 402 starts carrying the folder at 10000 ms, the last poll of the SIGKILL window. Scans: 53
    // end the SIGTERM window (the recheck before 401's SIGTERM, 51 polls and the final rescan); the SIGKILL window numbers
    // on from 54, its recheck 54 (401's SIGKILL, at 5000 ms), its first rescan 55 and one rescan for each of 50 more polls,
    // so 105 is the rescan of the last poll and 106 the final rescan after it. Scan 105 answers unchecked, so 402 is not yet
    // listed and the round signals nothing; scan 106 lists 402, so the round ends with 402 listed and never rechecked. 401's
    // SIGKILL is already 5000 ms old, so only 402 can keep the confirmation going. Its first recheck, scan 107, answers
    // unchecked and leaves 402 unsent; the confirmation polls again, scan 108 lists 402, scan 109 is the recheck and
    // 402 is signalled and ends on SIGKILL.
    const fake = fakeProcesses({ 401: undefined, 402: 'SIGKILL' }, {}, { 402: 10000 }, [], [105, 107]);
    assert.deepEqual(await stopProcesses([401], fake.seams), { stopped: [402], survivors: [401] });
    assert.deepEqual(fake.signals.map(([pid, signal]) => [pid, signal]), [[401, 'SIGTERM'], [401, 'SIGKILL'], [402, 'SIGKILL']]);
  });
});
