#!/usr/bin/env node
// factory-sync.mjs — maintain the factory manifest, `.agents/factory-manifest.json`, which pins every shared
// workflow file an adopter carries byte for byte, apart from the seat setting values its own seat settings file
// names, and copy those files from the canonical into an adopter.
//
//   node scripts/factory-sync.mjs --write   # canonical repository only: re-record every entry from disk
//   node scripts/factory-sync.mjs --check   # adopter: is this manifest the canonical's manifest on main?
//   node scripts/factory-sync.mjs --render  # adopter: apply the seat settings file to the seats, between syncs
//   node scripts/factory-sync.mjs --from <source> [--into <target>] [--canonical <owner/repo>]
//                                           # adopter: copy every entry from a canonical checkout
//
// --write refuses to run unless the repository's `origin` remote is github.com/<the manifest's canonical>,
// in https or ssh form, so an adopter can never bless its own local drift. It refuses a manifest that holds no
// `adopters`: the canonical's manifest is that list's one home. It keeps `canonical`, `adopters` and the entry
// order, and writes 2-space-indented JSON with a trailing newline, so an unchanged tree rewrites identical bytes.
//
// --from fetches the source's origin main, then syncs into --into (default: this repository) under the
// contract in scripts/lib/factory-sync.mjs: every check runs before any write, so a refusal writes nothing.
// It removes, and prints, each file the target's committed manifest listed and the fetched one no longer shares,
// when the target holds it committed with the exact bytes last recorded; anything else at such a path is a refusal.
// It writes no entry of a runtime the target's settings file does not name, nor of the external review add-on where
// that file does not turn it on, nor of the documentation sweep where that file turns it off, treats such an entry's
// path the same way, and prints how many entries it left out.
// --canonical is needed only for a target with no committed manifest. Source and target must be different
// repositories. Exit 0 on success, 1 on a refusal with its cause, 2 on a usage error.
//
// --render brings the seats and the manifest to the state a sync would leave for the seat settings file as it now
// stands, under the renderSettings contract in scripts/lib/factory-sync.mjs: it reads no commit, needs no network
// and no canonical checkout, and refuses in the canonical repository. Every check runs before any write, so a
// refusal writes nothing. It prints each seat it rewrote; when no seat changed it prints that the manifest alone was
// rewritten, or that the seat settings are already applied when nothing was written. Exit 0 on success, 1 on a
// refusal with its cause, 2 on a usage error.
//
// Every git call runs without the inherited repository-scoped variables (GIT_DIR, GIT_INDEX_FILE and the rest).
//
// --check fetches the canonical's manifest on main from github.com, whatever gh's configured default host, with
// `gh api` and compares it with this repository's manifest under the checkLag contract in
// scripts/lib/factory-sync.mjs. Exit 0 prints "in sync"; exit 1 prints "behind", each difference and the fix; exit 2
// prints "sync state unknown" and its cause, such as gh missing, unauthenticated or the manifest not found. A usage
// error also exits 2 but starts with "usage:".

import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLag,
  computeEntries,
  fetchMain,
  gitEnvironment,
  isGithubRepository,
  MANIFEST_PATH,
  readManifest,
  renderSettings,
  syncInto,
} from './lib/factory-sync.mjs';

const USAGE =
  'usage: node scripts/factory-sync.mjs --write | --check | --render | --from <source> [--into <target>] [--canonical <owner/repo>]';
const FLAGS = { '--from': 'from', '--into': 'into', '--canonical': 'canonical' };

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
  const { canonical, adopters } = manifest;
  if (adopters === undefined) {
    throw new Error(
      `refusing to --write: ${MANIFEST_PATH} holds no adopters list; the canonical repository's manifest is its one home, so restore it and record again`,
    );
  }
  const entries = computeEntries(root, manifest);
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ canonical, adopters, entries }, null, 2)}\n`);
  console.log(`factory-sync: recorded ${entries.length} entries in ${MANIFEST_PATH}`);
}

function sync({ from, into = '.', canonical }) {
  const [source, target] = [topLevel(from), topLevel(into)];
  if (source === target) throw new Error(`the source and target are the same repository (${source})`);
  const { files, regions, removed, omitted } = syncInto({ source, target, canonical, fetchMain });
  console.log(`factory-sync: wrote ${files} files and ${regions} regions from ${source} into ${target}`);
  if (omitted > 0) console.log(`factory-sync: left out ${omitted} entries the settings file leaves out`);
  console.log(`factory-sync: removed ${removed.length} retired files`);
  for (const path of removed) console.log(`  ${path}`);
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

function fetchCanonicalManifest(canonical) {
  const run = spawnSync(
    'gh',
    ['api', '--hostname', 'github.com', `repos/${canonical}/contents/${MANIFEST_PATH}?ref=main`, '-H', 'Accept: application/vnd.github.raw+json'],
    { encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
  );
  if (run.error?.code === 'ENOENT') throw new Error('gh is not installed');
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr.trim().split('\n')[0] || `gh api exited ${run.status ?? run.signal}`);
  return run.stdout;
}

// Prints the lag check's result and returns its exit code: 0 in sync, 1 drifted, 2 unknown.
function check() {
  let root;
  try {
    root = topLevel('.');
  } catch (error) {
    console.error(`factory-sync: sync state unknown: ${error.message}`);
    return 2;
  }
  const { state, differences, cause } = checkLag({ root, fetchCanonicalManifest });
  if (state === 'unknown') {
    console.error(`factory-sync: sync state unknown: ${cause}`);
    return 2;
  }
  // Both remaining states were reached through a valid local manifest.
  const { canonical } = readManifest(root);
  if (state === 'in-sync') {
    console.log(`factory-sync: in sync with ${canonical} main`);
    return 0;
  }
  console.error(`factory-sync: behind ${canonical} main:`);
  for (const difference of differences) console.error(`  ${difference}`);
  console.error(
    `factory-sync: lag is information and blocks nothing; to catch up on the owner's decision, a sync job runs \`node scripts/factory-sync.mjs --from <checkout of ${canonical} on current main>\``,
  );
  return 1;
}

// The --from options, or null when the arguments are not one well-formed --from invocation.
function parseFrom(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    const key = FLAGS[flag];
    if (!key || key in options || value === undefined || value.startsWith('--')) return null;
    options[key] = value;
  }
  return options.from ? options : null;
}

const args = process.argv.slice(2);
const fromOptions = parseFrom(args);
if (!fromOptions && !(args.length === 1 && ['--write', '--check', '--render'].includes(args[0]))) {
  console.error(USAGE);
  process.exit(2);
}
if (args[0] === '--check') process.exit(check());
try {
  if (fromOptions) sync(fromOptions);
  else if (args[0] === '--render') render();
  else write();
} catch (error) {
  console.error(`factory-sync: ${error.message}`);
  process.exit(1);
}
