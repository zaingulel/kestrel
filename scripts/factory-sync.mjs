#!/usr/bin/env node
// factory-sync.mjs — maintain the factory manifest, `.agents/factory-manifest.json`, which pins every shared
// workflow file an adopter carries byte for byte, apart from the seat setting values its own seat settings file
// names.
//
//   node scripts/factory-sync.mjs --write   # canonical repository only: re-record every entry from disk
//   node scripts/factory-sync.mjs --render  # adopter: apply the seat settings file to the seats
//
// --write refuses to run unless the repository's `origin` remote is github.com/<the manifest's canonical>,
// in https or ssh form, so an adopter can never bless its own local drift. It keeps `canonical` and the entry
// order, and writes 2-space-indented JSON with a trailing newline, so an unchanged tree rewrites identical bytes.
//
// --render brings the seats and the manifest to the state the seat settings file as it now stands calls for, under
// the renderSettings contract in scripts/lib/factory-sync.mjs: it reads no commit, needs no network, and refuses in
// the canonical repository. Every check runs before any write, so a refusal writes nothing. It prints each seat it
// rewrote; when no seat changed it prints that the manifest alone was rewritten, or that the seat settings are
// already applied when nothing was written. Exit 0 on success, 1 on a refusal with its cause, 2 on a usage error.
//
// Every git call runs without the inherited repository-scoped variables (GIT_DIR, GIT_INDEX_FILE and the rest).

import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeEntries,
  gitEnvironment,
  isGithubRepository,
  MANIFEST_PATH,
  readManifest,
  renderSettings,
} from './lib/factory-sync.mjs';

const USAGE = 'usage: node scripts/factory-sync.mjs --write | --render';

function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8', env: gitEnvironment() });
  return { ok: run.status === 0, out: run.stdout.trim() };
}

function topLevel(path) {
  const { ok, out } = git('-C', path, 'rev-parse', '--show-toplevel');
  if (!ok) throw new Error(`${path} is not inside a git repository`);
  return realpathSync(out);
}

function write() {
  const root = topLevel('.');
  const manifest = readManifest(root);
  const origin = git('-C', root, 'remote', 'get-url', 'origin');
  if (!origin.ok || !isGithubRepository(origin.out, manifest.canonical)) {
    throw new Error(
      `refusing to --write: origin ${origin.ok ? origin.out : '(none)'} is not github.com/${manifest.canonical}; record a change in the canonical repository only`,
    );
  }
  const { canonical } = manifest;
  const entries = computeEntries(root, manifest);
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ canonical, entries }, null, 2)}\n`);
  console.log(`factory-sync: recorded ${entries.length} entries in ${MANIFEST_PATH}`);
}

function render() {
  const { seats, manifest } = renderSettings(topLevel('.'));
  if (seats.length === 0) {
    console.log(
      manifest
        ? 'factory-sync: applied the seat settings; no seat file changed, and the manifest now records the defaults'
        : 'factory-sync: the seat settings are already applied',
    );
    return;
  }
  console.log(`factory-sync: applied the seat settings to ${seats.length} seats`);
  for (const path of seats) console.log(`  ${path}`);
}

const args = process.argv.slice(2);
if (!(args.length === 1 && ['--write', '--render'].includes(args[0]))) {
  console.error(USAGE);
  process.exit(2);
}
try {
  if (args[0] === '--render') render();
  else write();
} catch (error) {
  console.error(`factory-sync: ${error.message}`);
  process.exit(1);
}
