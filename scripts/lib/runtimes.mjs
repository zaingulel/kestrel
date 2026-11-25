// runtimes.mjs — which runtimes a repository runs, which shared path belongs to which, the one read of the seat
// settings file, and the two answers that file gives about a shared path.
//
// A leaf: it imports only node:fs and node:path, because seat-settings.mjs imports the agent check and the agent check
// must be able to import this module. For the same reason it is the only place the settings file is read from disk, so
// the agent check and the manifest check refuse the same linked file or linked parent before any read, and the only
// home of the file's top-level rules (readSettingsHeader), so no reader takes its runtimes from a file whose top level
// this module refuses.
//
// The two answers are separate questions, and neither stands in for the other:
// leftOutCause: why a tree with these settings must hold nothing at a path, or null where the tree installs it. The
// path's runtime is not named or, failing that, it is the Greptile add-on's and the add-on is off or, failing that, it
// is the Herdr add-on's and that add-on is off or, failing that, it is one of the documentation sweep's six files or
// the documentation standard and the sweep is off.
// needNotResolveCause: why a reference to a path need not resolve in a tree with these settings, or null where it
// must. The path's runtime is not named or, failing that, it is one of the sweep's six files, the documentation
// standard or the two manuals and the sweep is off or, failing that, it is the direction page, whatever the settings.
// Never either add-on.
// Both take the settings readSettingsHeader returns, which reach it only as settings-file text; a tree with no file is
// judged as the text NO_SETTINGS_FILE, so what an absent key means is written once (treeSettings).
//
// RUNTIMES: the two runtimes a repository may run. The settings file's `runtimes` key names the ones present; with
// no key, or no file, both are.
// runtimeOf: a shared path belongs to Claude Code (everything under .claude/, CLAUDE.md, and the files of the scripts
// only its hooks run), to Codex (everything under .codex/, and the files of the scripts only its hooks run), or to
// every install (null). A shared file of every install never imports one of those seven script files.
// isGreptilePath: the Greptile add-on's files are everything under .agents/skills/greptile/, .claude/skills/greptile/
// and .greptile/. A tree installs them only where its settings file holds `"greptile": true`.
// isHerdrPath: the Herdr add-on's files are everything under .agents/herdr/, .agents/skills/herdr-setup/ and
// .claude/skills/herdr-setup/, and the queue reader, coordinator, cap and legacy process library, and weekly local retro
// paths named in HERDR_PATHS. A shared file of every install never statically imports one of them. Load one only after
// the tree's Herdr setting enables it. A tree installs them only where its settings file holds `"herdr": true`.
// The settings file's `docSweep` key turns the documentation sweep's files off with `false`; with no key it is on. The
// sweep's shared files are the six the sweep-scope check owns (SWEEP_PATHS) and the documentation standard
// (SWEEP_STANDARD). A tree whose sweep is off leaves them out; a reference to one of them, or to one of the two manuals
// the sweep runs by, need not resolve there (sweepOmits).
// The settings file's `docsSite` key is one of DOCS_SITE_LEVELS; with no key it is off. The docs site's files are
// everything under docs-site/ and its publishing workflow (DOCS_SITE_WORKFLOW). A tree installs the folder only where
// its docs site is local or online, and the workflow only where it is online.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_PATH = '.agents/factory-settings.json';

export const RUNTIMES = Object.freeze(['claude', 'codex']);

export const SEATS = Object.freeze({
  claude: Object.freeze({ directory: '.claude/agents', extension: '.md' }),
  codex: Object.freeze({ directory: '.codex/agents', extension: '.toml' }),
});

const CLAUDE_PATHS = new Set([
  'CLAUDE.md',
  'scripts/lib/test-output-filter.mjs',
  'scripts/lib/test-output-filter.test.mjs',
]);
const CODEX_PATHS = new Set(['scripts/lib/codex-hook-adapters.mjs', 'scripts/lib/codex-hook-adapters.test.mjs', 'scripts/lib/codex-hooks-windows.test.mjs']);

/** The runtime a shared path belongs to, or null where it belongs to every install. Exact string comparison. */
export function runtimeOf(path) {
  if (path.startsWith('.claude/') || CLAUDE_PATHS.has(path)) return 'claude';
  if (path.startsWith('.codex/') || CODEX_PATHS.has(path)) return 'codex';
  return null;
}

/** Whether a shared path is installed where `runtimes` are the ones present. */
export function installs(runtimes, path) {
  const runtime = runtimeOf(path);
  return runtime === null || runtimes.includes(runtime);
}

const GREPTILE_FOLDERS = ['.agents/skills/greptile/', '.claude/skills/greptile/', '.greptile/'];

/** Whether a shared path is one of the Greptile add-on's files. Exact string comparison. */
export const isGreptilePath = (path) => GREPTILE_FOLDERS.some((folder) => path.startsWith(folder));

// Herdr Core emits local terminal IDs in the id_shaped wire format.
export const LOCAL_HERDR_TERMINAL = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;

const HERDR_PATHS = [
  '.agents/herdr/',
  '.agents/skills/herdr-setup/',
  '.claude/skills/herdr-setup/',
  'scripts/owner-queue.mjs',
  'scripts/lib/owner-queue.mjs',
  'scripts/lib/owner-queue.test.mjs',
  'scripts/lib/herdr-queue.test.mjs',
  'scripts/coordinator.mjs',
  'scripts/lib/coordinator.mjs',
  'scripts/lib/coordinator.test.mjs',
  'scripts/lib/delivery-lane-contract.test.mjs',
  'scripts/lib/cap-lock.mjs',
  'scripts/local-retro.mjs',
  'scripts/lib/local-retro.mjs',
  'scripts/lib/local-retro.test.mjs',
  // Updates use these retired paths to interpret omission rules for older manifests.
  'scripts/lead.mjs',
  'scripts/lib/lead.test.mjs',
  'scripts/lib/lead.mjs',
];

/** Whether a shared path is one of the Herdr add-on's files: an entry ending in / owns everything under it, any other entry only itself. Exact string comparison. */
export const isHerdrPath = (path) => HERDR_PATHS.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

const SWEEP_PATHS = new Set([
  '.github/workflows/sweep-scope.yml',
  'scripts/lib/sweep-scope-corpus.mjs',
  'scripts/lib/sweep-scope-evaluate.mjs',
  'scripts/lib/sweep-scope.mjs',
  'scripts/lib/sweep-scope.test.mjs',
  'scripts/sweep-scope-check.mjs',
]);
const SWEEP_MANUALS = ['docs/DOC-SWEEP.md', 'docs/SWEEP-TRIAGE.md'];
const SWEEP_STANDARD = 'docs/DOCUMENTATION-STANDARD.md';
const SWEEP_SHARED = new Set([...SWEEP_PATHS, SWEEP_STANDARD]);

/** Whether a tree whose sweep is `docSweep` leaves the path out: the sweep's six files, the documentation standard and its two manuals, only where it is off. Exact string comparison. */
export const sweepOmits = (docSweep, path) => !docSweep && (SWEEP_SHARED.has(path) || SWEEP_MANUALS.includes(path));

const DOCS_SITE_WORKFLOW = '.github/workflows/docs-site-deploy.yml';
const isDocsSitePath = (path) => path.startsWith('docs-site/') || path === DOCS_SITE_WORKFLOW;

const runtimeCause = (path) => `the settings file names no ${runtimeOf(path)} runtime`;
const SWEEP_OFF_CAUSE = 'the settings file turns the documentation sweep off';

/**
 * Why a tree with these settings must hold nothing at the path, or null where it installs the path. No `docsSite` means off.
 * @param {{ runtimes: readonly string[], greptile: boolean, herdr: boolean, docSweep: boolean, docsSite?: string }} settings
 */
export function leftOutCause({ runtimes, greptile, herdr, docSweep, docsSite }, path) {
  if (!installs(runtimes, path)) return runtimeCause(path);
  if (!greptile && isGreptilePath(path)) return 'the settings file does not turn the Greptile add-on on';
  if (!herdr && isHerdrPath(path)) return 'the settings file does not turn the Herdr add-on on';
  if (!docSweep && SWEEP_SHARED.has(path)) return SWEEP_OFF_CAUSE;
  if (docsSite !== 'local' && docsSite !== 'online' && isDocsSitePath(path)) return 'the settings file does not turn the docs site on';
  return docsSite !== 'online' && path === DOCS_SITE_WORKFLOW ? 'the settings file does not turn the docs site online' : null;
}

/** Why a reference to the path need not resolve in a tree with these settings, or null where it must. */
export function needNotResolveCause({ runtimes, docSweep }, path) {
  if (!installs(runtimes, path)) return runtimeCause(path);
  return sweepOmits(docSweep, path) ? SWEEP_OFF_CAUSE : null;
}

const RECOVERY = 'if a newer copy of the shared workflow admits this, undo the edit, apply the release update that installs that copy, then make the edit again';

export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A settings refusal naming the file, the place in it and the offending value; `recovery` appends the newer-copy sentence. */
export function refusal(label, place, cause, found, recovery = false) {
  return new Error(`${label}: ${place}: ${cause}; found ${JSON.stringify(found)}${recovery ? `; ${RECOVERY}` : ''}`);
}

/** The runtimes a settings file's `runtimes` value names, in RUNTIMES order; every runtime when there is no value. */
export function readRuntimes(value, label) {
  if (value === undefined) return RUNTIMES;
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || !value.every((name) => RUNTIMES.includes(name))) {
    throw new Error(`${label}: runtimes: must be a non-empty array naming claude, codex or both, each once; found ${JSON.stringify(value)}`);
  }
  return RUNTIMES.filter((runtime) => value.includes(runtime));
}

export function kindOf(stat) {
  if (stat.isSymbolicLink()) return 'a symlink';
  if (stat.isDirectory()) return 'a directory';
  return stat.isFile() ? 'a regular file' : 'a special file';
}

// Refuses a path with a symlink among its existing parent directories in the target, whatever the symlink points
// to: a write below it would land away from the manifest path, possibly outside the target. Refuses a path whose
// existing parent is a file, as a former shared symlink is on a checkout that writes symlinks as plain files.
export function checkContained(root, path) {
  const parts = path.split('/');
  let dir = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = join(dir, parts[i]);
    const prefix = parts.slice(0, i + 1).join('/');
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${path}: its parent ${dir} is a symlink, so a write there would not land at the manifest path and could land outside the target ${root}; if it is a former shared symlink, remove it first: git rm ${prefix}, commit, then retry`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${path}: its parent ${dir} is a file, not a directory, so the entry cannot be written there; if it is a former shared symlink checked out as a file, remove it first: git rm ${prefix}, commit, then retry`);
    }
  }
}

// The top-level keys of the settings file, in the order its reader names them.
export const SETTINGS_KEYS = Object.freeze(['version', 'runtimes', 'seats', 'planApproval', 'greptile', 'herdr', 'docSweep', 'docsSite', 'crossFamilyReview', 'waitForOwner', 'coordinator']);

// The levels of `waitForOwner`, strictest first: at always every finished card waits for the owner's yes; at on-screen
// a Ready card merges on its evidence unless a wait reason holds or its work is on screen; at when-needed it merges on
// its evidence unless a wait reason holds.
export const WAIT_LEVELS = Object.freeze(['always', 'on-screen', 'when-needed']);

// The levels of `docsSite`: off leaves the docs site out, local installs its folder, online also its publishing workflow.
export const DOCS_SITE_LEVELS = Object.freeze(['off', 'local', 'online']);

// The efforts a Claude session accepts, lowest first: the values of a seat's `effort` and of the coordinator's.
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// What a settings file with no `coordinator` key means: the coordinator uses Claude Opus at medium effort.
const DEFAULT_COORDINATOR = Object.freeze({ runtime: 'claude', model: 'opus', effort: 'medium' });

// What a settings file with no `waitForOwner` key, or no settings file, means: nothing merges on its evidence until
// the owner writes on-screen or when-needed.
const DEFAULT_WAIT_LEVEL = 'always';

// What a settings file with no docSweep key means, and what an install records where an answers file for a GitHub board leaves it out.
export const DOC_SWEEP_DEFAULT = true;

// What a tree with no settings file is judged as.
const NO_SETTINGS_FILE = '{"version":1,"seats":{}}';

/** The settings file's parsed object, the runtimes it names, whether it turns the Greptile add-on on, whether it turns the Herdr add-on on and whether it leaves the documentation sweep on, its docs site level and whether it records the owner's authorization of cross-family review and the runtime, model and effort of the coordinator, once its top-level shape holds: one JSON object, version 1, no key besides version, runtimes, seats, planApproval, greptile, herdr, docSweep, docsSite, crossFamilyReview, waitForOwner and coordinator, a valid `runtimes` value, a `planApproval`, a `greptile`, a `herdr` and a `docSweep` that are each true or false when present, a `docsSite` that is one of DOCS_SITE_LEVELS when present, a `waitForOwner` that is one of WAIT_LEVELS when present, a `coordinator` that is an object of only an optional `runtime` (one of RUNTIMES), `model` (a seat model name) and `effort` (one of EFFORT_LEVELS) when present, no `preApprovedRun` or `productManager`, which are retired, and a `crossFamilyReview` that is true when present and only where both runtimes are named. An undefined `text`, which is what readSettingsFile gives for a tree with no file, is judged as NO_SETTINGS_FILE. Throws a refusal naming `label`. With `admitUnknownKeys`, a top-level key it does not know passes unread while every other refusal stands. */
export function readSettingsHeader(text, label, { admitUnknownKeys = false } = {}) {
  let settings;
  try {
    settings = JSON.parse(text === undefined ? NO_SETTINGS_FILE : text);
  } catch {
    throw new Error(`${label}: is not valid JSON`);
  }
  if (!isRecord(settings)) throw refusal(label, 'file', 'must hold one JSON object', settings);
  if (settings.version !== 1) throw refusal(label, 'version', 'is unsupported by this copy of the shared workflow (only 1)', settings.version, true);
  for (const key of Object.keys(settings)) {
    if (key === 'preApprovedRun') throw new Error(`${label}: preApprovedRun is retired: remove it; waitForOwner sets when finished work waits for you`);
    if (key === 'productManager') throw new Error(`${label}: productManager is retired with the product manager run: remove it; a pre-approved run builds from Ready`);
    if (!admitUnknownKeys && !SETTINGS_KEYS.includes(key)) throw refusal(label, 'file', 'holds a key besides version, runtimes, seats, planApproval, greptile, herdr, docSweep, docsSite, crossFamilyReview, waitForOwner and coordinator', key, true);
  }
  if (settings.planApproval !== undefined && typeof settings.planApproval !== 'boolean') throw refusal(label, 'planApproval', 'must be true or false', settings.planApproval);
  if (settings.greptile !== undefined && typeof settings.greptile !== 'boolean') throw refusal(label, 'greptile', 'must be true or false', settings.greptile);
  if (settings.herdr !== undefined && typeof settings.herdr !== 'boolean') throw refusal(label, 'herdr', 'must be true or false', settings.herdr);
  if (settings.docSweep !== undefined && typeof settings.docSweep !== 'boolean') throw refusal(label, 'docSweep', 'must be true or false', settings.docSweep);
  if (settings.docsSite !== undefined && !DOCS_SITE_LEVELS.includes(settings.docsSite)) throw refusal(label, 'docsSite', 'must be off, local or online', settings.docsSite);
  if (settings.waitForOwner !== undefined && !WAIT_LEVELS.includes(settings.waitForOwner)) throw refusal(label, 'waitForOwner', `must be ${WAIT_LEVELS.join(' or ')}`, settings.waitForOwner);
  if (settings.crossFamilyReview !== undefined && settings.crossFamilyReview !== true) throw refusal(label, 'crossFamilyReview', 'must be true, or left out to record no authorization', settings.crossFamilyReview);
  const coordinator = readCoordinatorSetting(settings.coordinator, label);
  const runtimes = readRuntimes(settings.runtimes, label);
  if (settings.crossFamilyReview === true && runtimes.length < RUNTIMES.length) throw refusal(label, 'crossFamilyReview', 'is refused where runtimes names one runtime', settings.crossFamilyReview);
  return { settings, runtimes, greptile: settings.greptile === true, herdr: settings.herdr === true, docSweep: settings.docSweep ?? DOC_SWEEP_DEFAULT, docsSite: settings.docsSite ?? 'off', crossFamilyReview: settings.crossFamilyReview === true, waitForOwner: settings.waitForOwner ?? DEFAULT_WAIT_LEVEL, coordinator };
}

// The coordinator's runtime, model and effort, each defaulting where the object leaves it out; refuses any other shape.
function readCoordinatorSetting(value, label) {
  if (value === undefined) return DEFAULT_COORDINATOR;
  if (!isRecord(value)) throw refusal(label, 'coordinator', 'must be an object with optional runtime, model and effort', value);
  for (const key of Object.keys(value)) {
    if (key !== 'runtime' && key !== 'model' && key !== 'effort') throw refusal(label, 'coordinator', 'holds a key besides runtime, model and effort', key);
  }
  const { runtime = DEFAULT_COORDINATOR.runtime, model = DEFAULT_COORDINATOR.model, effort = DEFAULT_COORDINATOR.effort } = value;
  if (!RUNTIMES.includes(runtime)) throw refusal(label, 'coordinator.runtime', `must be ${RUNTIMES.join(' or ')}`, runtime);
  if (typeof model !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(model)) throw refusal(label, 'coordinator.model', 'must be a model name of letters, digits, dots, underscores and hyphens, starting with a letter or digit', model);
  if (!EFFORT_LEVELS.includes(effort)) throw refusal(label, 'coordinator.effort', `must be ${EFFORT_LEVELS.join(', ')}`, effort);
  return { runtime, model, effort };
}

/** The text of the settings file of the tree at `root`, or undefined when the tree has none. Refuses one under a symlinked directory or one that is not a regular file, before any read. */
export function readSettingsFile(root) {
  checkContained(root, SETTINGS_PATH);
  const full = join(root, SETTINGS_PATH);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`${SETTINGS_PATH} is not a regular file (${kindOf(stat)})`);
  return readFileSync(full, 'utf8');
}

/** The settings of the tree at `root`, as readSettingsHeader returns them: those of its settings file, or of NO_SETTINGS_FILE where it has none. The seats are validated by parseSettings (seat-settings.mjs), which the manifest check runs. `options` pass through to readSettingsHeader. */
export const treeSettings = (root, options) => readSettingsHeader(readSettingsFile(root), SETTINGS_PATH, options);

/** The runtimes the tree at `root` runs: those its settings file names, or both. */
export const presentRuntimes = (root) => treeSettings(root).runtimes;

/** Whether the tree at `root` leaves the documentation sweep on: on unless its settings file holds `"docSweep": false`. */
export const sweepOn = (root) => treeSettings(root).docSweep;
