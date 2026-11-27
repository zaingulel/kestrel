// The delivery lane every open Claude job of a repository shares. This file's blob fingerprints that contract, so a
// change to any path below is a lane change: the expected paths are written out here, never derived from the module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelivery } from './coordinator.mjs';
import { coordinatedWatchIsLive } from './merge-watch.mjs';

const REPOSITORY_ID = 'R_kgDO/fabraik-947';
const REPOSITORY = 'example/one';
const ORIGIN = 'https://github.com/example/one.git';
const LANE_KEY = '683c0e8bf0d96e4a52ac6df91d99f17cc0e0cc5a233dc106aad1d1685513f8b0';
const WATCH_RECORD = 'f2d370c2dba7ae00.json';
const RECEIPT_REFUSED = 'Delivery stopped: the previous delivery receipt does not match the verified repository and merge-watch state context.';

// One live Claude job of the fixed repository, with the real lane, lock and record code beneath runDelivery.
function laneJob(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-lane-')));
  t.after(() => rmSync(scratch, { force: true, recursive: true }));
  const accountHome = join(scratch, 'account');
  const lockRoot = join(scratch, 'lanes');
  const root = join(scratch, 'one');
  const worktree = join(root, 'jobs', '7');
  const watchStateDir = join(accountHome, 'xdg', 'fabraik-merge-watch');
  for (const folder of [worktree, watchStateDir]) mkdirSync(folder, { mode: 0o700, recursive: true });
  const terminal = {
    address: 't7', state: 'live', cwd: root, created_ms: 1795090122648, parent: 't1', pid: process.pid,
    foreground: { name: 'claude', cwd: worktree }, status: { state: 'idle' },
    labels: { 'fabraik.role': 'job', 'fabraik.card': '7', 'fabraik.runstart': '2026-11-19T12:00:00Z',
      'fabraik.session': '3f2b8c1e-5d4a-4b7c-9e1f-2a6d8b0c4e7f' },
  };
  const head = 'a'.repeat(40);
  const git = new Map([
    ['rev-parse --show-toplevel', `${worktree}\n`],
    ['worktree list --porcelain -z',
      `worktree ${root}\0HEAD ${head}\0branch refs/heads/main\0\0worktree ${worktree}\0HEAD ${head}\0branch refs/heads/job/7\0\0`],
    ['remote get-url --push --all origin', `${ORIGIN}\n`],
    ['remote get-url origin', `${ORIGIN}\n`],
  ]);
  const hold = () => {
    const held = Promise.withResolvers();
    const stop = Promise.withResolvers();
    const output = [];
    const result = runDelivery({ mode: 'hold' }, {
      cwd: worktree, accountHome, lockRoot, watchStateDir, pid: process.pid, env: { HC_TERMINAL_ID: terminal.address },
      hc: async (args) => {
        if (args[0] === 'label') {
          const [name, value] = args[2].split(/=(.*)/s);
          if (value) terminal.labels[name] = value;
          else delete terminal.labels[name];
        }
        return { code: 0, stdout: args[0] === 'get' ? JSON.stringify(terminal) : '', stderr: '' };
      },
      gitExec: (args) => {
        assert.ok(git.has(args.join(' ')), `unexpected git call: ${args.join(' ')}`);
        return git.get(args.join(' '));
      },
      ghExec: (args) => {
        assert.deepEqual(args, ['repo', 'view', '--json', 'id,nameWithOwner,defaultBranchRef', '--', ORIGIN]);
        return JSON.stringify({ id: REPOSITORY_ID, nameWithOwner: REPOSITORY, defaultBranchRef: { name: 'main' } });
      },
      readProcessTable: () => [],
      now: () => 0,
      // The holder first sleeps once its reservation is published, and wakes only when released.
      sleep: (_ms, _value, { signal }) => new Promise((_resolve, reject) => {
        held.resolve(undefined);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      output: { log: (line) => output.push(line), error: (line) => output.push(line) },
      untilSignal: () => stop.promise,
    });
    return { held: held.promise, result, output, release: () => stop.resolve('SIGTERM') };
  };
  return { accountHome, lockRoot, watchStateDir, hold };
}

test('the delivery lane derives its lock, reservation, receipt and watch-record paths from the repository identity', async (t) => {
  if (process.platform !== 'linux') return t.skip('requires Linux /proc process identity');
  const job = laneJob(t);
  const lane = join(job.lockRoot, LANE_KEY);
  const lock = join(lane, 'delivery.lock');
  const ready = join(lane, 'ready.json');
  const receipt = join(job.accountHome, '.local', 'state', 'fabraik-merge-watch', `delivery-${LANE_KEY}.json`);
  const watchRecord = join(job.watchStateDir, WATCH_RECORD);

  const holder = job.hold();
  await Promise.race([holder.held, holder.result]);
  assert.deepEqual(readdirSync(job.lockRoot), [LANE_KEY], holder.output.join('\n'));
  assert.deepEqual(readdirSync(lane).sort(), ['delivery.lock', `ready-${lstatSync(ready, { bigint: true }).dev}-${lstatSync(ready, { bigint: true }).ino}.lock`, 'ready.json']);
  assert.equal(JSON.parse(readFileSync(ready, 'utf8')).repositoryId, REPOSITORY_ID);
  holder.release();
  assert.equal(await holder.result, 0, holder.output.join('\n'));
  assert.equal(existsSync(ready), false, 'a released holder withdraws its reservation');
  assert.equal(existsSync(lock), true);

  mkdirSync(join(receipt, '..'), { mode: 0o700, recursive: true });
  writeFileSync(receipt, '{}', { mode: 0o600 });
  const refused = job.hold();
  assert.equal(await refused.result, 1);
  assert.equal(refused.output.at(-1), RECEIPT_REFUSED, 'the holder reads the receipt at the lane receipt path');

  assert.equal(coordinatedWatchIsLive(job.watchStateDir, REPOSITORY, () => []), undefined);
  writeFileSync(watchRecord, JSON.stringify({ watch: { pid: 4100, started: 'Thu Nov 19 12:00:00 2026' }, launcher: null, forwarder: null, hookId: null }),
    { mode: 0o600 });
  assert.equal(coordinatedWatchIsLive(job.watchStateDir, REPOSITORY, () => []), false, 'delivery reads the watch record at its repository path');
});
