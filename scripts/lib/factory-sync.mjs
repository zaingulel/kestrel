// factory-sync.mjs — read and verify the factory manifest, `.agents/factory-manifest.json`: the shared
// workflow files every adopter carries byte for byte, apart from the seat setting values its own seat settings
// file names, each pinned in one of exactly two entry kinds.
//
//   { path, sha256[, executable: true] }         a regular file, hashed over its bytes; executable marks git mode
//                                                100755 and is absent for 100644
//   { path, region: 'factory-shared', sha256 }   the text strictly between the file's two region marker lines
//
// Every path is relative, POSIX and free of `.`, `..` and empty segments, and is checked before any read. A `.git`
// segment in any letter case is refused too: it would name a file inside a repository's own git directory, where
// the status check and the tree listings see nothing. A path holding a backslash is refused too: Windows reads it
// as a separator, so `..\x` would climb out of the tree.
// Disk state is read with lstat, so a symlink or directory where a file is expected is drift, never followed. The
// executable bit is read from the disk, except where the checkout does not honour file modes (core.fileMode false,
// as on Windows), whose disk cannot hold that bit: there it is read from git's index.
// No two paths name the same file on a case-insensitive or Unicode-normalising disk, and no path lies under another.
// Every malformed input throws with a named cause.
//
// No manifest lists the seat settings file, SETTINGS_PATH in runtimes.mjs, in any letter case or Unicode form,
// nor a path under it: that file is the repository's own. A manifest may hold `seatDefaults`, the shared value of
// each seat setting its repository overrides, in the nested form of the settings file's `seats` and naming only
// seat files the same manifest lists.
//
// Only the canonical's manifest holds `adopters`, the repositories that carry a copy. Every reader takes a manifest
// without it and holds one that is present to an array of "owner/repo" names; nothing is decided by the list.
//
// A tree's settings file may name the runtimes it runs, may turn the Greptile add-on on and may turn the documentation
// sweep off; leftOutCause in runtimes.mjs is the one answer to which entries those settings leave out of the tree, and
// the check, the sync and the render all ask it, each from the settings file's text. Every manifest keeps every entry,
// a sync writes only the entries the tree installs, and the path of a left-out entry must hold nothing.
//
// verifyManifest reports anything a left-out entry's path holds, whatever its bytes, and nothing where it holds
// nothing. It holds every other entry to its record, with one exception: a seat the tree's settings file or the
// manifest's seatDefaults names. Such a seat verifies only when the settings named for it are the settings
// seatDefaults records for it, putting the recorded defaults back gives the bytes the entry records, and the values
// put back replaced the named ones; so its file is the shared bytes with exactly the named values in place and
// nothing else. seatDefaults is a witness the entry's hash checks, never trusted input. The settings file is read
// only as a regular file under no symlinked directory, and it and seatDefaults throw when malformed or when they
// name a seat the manifest does not list. A tree with neither takes the strict path alone, and a missing or changed
// file of a named runtime, of the add-on where it is on, or of the sweep where it is not off, is refused like any other.
//
// syncInto copies the entries from a canonical source checkout into an adopter target. Everything it writes comes
// from the source's freshly fetched origin main commit, never from the source's working tree, index or disk
// manifest, and every git call ignores inherited repository-scoped variables such as GIT_DIR and GIT_INDEX_FILE.
// It validates everything before it writes or removes anything, so every refusal leaves the target untouched: the
// target's committed manifest, when HEAD's tree lists one, is read and validated like any other, and a HEAD that
// cannot be listed or a manifest that cannot be read is refused, never taken for a first sync; the canonical
// comes from the target's committed manifest or, only when there is none, the caller, and the fetched manifest
// names it too, in any letter case; the source's origin is that canonical and the target's is not; the source's
// HEAD is the fetched commit; source and target are clean at every shared path, so the source's uncommitted edits
// are refused loudly rather than silently left out, and the target's are never overwritten; the fetched commit
// matches its own manifest in kind, mode and content; no existing directory on an entry's path in the target is a
// symlink, even one pointing inside the target, so every write lands at its manifest path and never through a
// symlink; each region file, in the commit and as a regular file in the target, carries well-formed region
// markers; and the target's settings file, read from its working tree as verifyManifest reads it, names only seats
// the fetched manifest shares, only settings each of those seats carries, and no value that gives a seat a problem
// its fetched bytes do not have. The agent check and the seat policy that judge that are the ones of the copy
// running the sync, never the fetched commit's, and no file of the fetched commit is executed or imported, so a
// default this copy does not know stops nothing and a named value it does not know is refused. It then writes each
// file the target installs with the commit's bytes and mode, a seat the settings file names with the named values in place of the
// commit's, and each region between the target's own markers, and records the commit's entries under the target's
// canonical, plus `syncedFrom`, the fetched commit, and, when the settings file names any, `seatDefaults`, the
// commit's value of each setting it replaced. It never records the commit's `adopters`, so the target's manifest
// names the canonical and no other adopter, and a list an earlier sync left there is gone. It never writes or
// removes the settings file, and a `seatDefaults` in the fetched manifest is never applied or copied. On a target
// that does not honour file modes the sync stages the file entries it writes, because the index is the only place
// such a checkout can hold the executable bit.
//
// Any installed path or the manifest marked skip-worktree or assume-unchanged in the target's index is refused
// before any write: git status cannot prove it clean.
//
// A retired entry is one the target's committed manifest lists at a path the fetched manifest does not. The target
// must be clean at every retired path too, and before any write the sync removes each retired file it can prove: a
// regular file under no symlinked parent whose bytes, on disk and committed at the target's HEAD, are the ones that
// manifest recorded. A retired path the target's index marks skip-worktree or assume-unchanged is refused by name
// whatever it holds, even nothing: git status reports no change there, and a commit would not record the removal.
// Any other retired path holding nothing is left alone; anything else there, a retired region, or a retired path
// that a case-insensitive or Unicode-normalising disk reads as one the fetched manifest shares, is refused by name.
// It removes no directory and no other file.
//
// An entry the target leaves out, of a runtime its settings file does not name, of the Greptile add-on where that
// file does not turn it on or of the documentation sweep where that file turns it off, is never written, and the manifest the sync records still lists it. Its path is proven and cleared as a retired path is, against the record of the target's committed
// manifest where that lists the path and of the fetched manifest otherwise: a file committed with exactly those bytes
// is removed, a path holding nothing is skipped, and anything else is refused by name before any write, so a
// left-out seat that still holds overridden values is rendered back or removed first. The sync returns how many
// entries it left out.
//
// renderSettings applies the settings file of a tree to its seats between syncs, leaving the seats and the manifest
// as a sync would for the settings file as it stands. It reads no commit and needs no network. Every check runs
// before any write, so every refusal leaves the tree untouched: the manifest is a regular file under no symlinked
// directory, checked on its own before it is read; the tree's origin is not the manifest's canonical, whose seat
// lines are the defaults, while a tree with no origin proceeds; the settings file is read as verifyManifest reads
// it; and each seat the settings file or seatDefaults names is a regular file under no symlinked directory whose
// bytes, with its recorded defaults put back, are the bytes its entry records, so a seat changed outside its setting
// lines is refused by name and never overwritten, and whose named values give it no problem those shared bytes do
// not have. A recorded default of a seat whose runtime the settings file leaves out is skipped, its file neither
// read nor written, and dropped from the record. It then writes each seat whose bytes change, keeping its mode, and rewrites the manifest only when its
// bytes change: every top-level key it held in the order it held them, `syncedFrom` and any `adopters` an earlier
// sync left among them, which only a sync removes, with `seatDefaults` directly before `entries` and left out when
// no seat is overridden. It returns the seats it wrote and whether it rewrote the manifest, so a settings file whose
// values equal the shared defaults, which changes the manifest alone, is told from a run that wrote nothing. A second
// run writes nothing.
//
// checkLag compares this repository's manifest on disk with the canonical's manifest on main, never
// the working-tree files (local file drift is the workflow contract test's job). It ignores `syncedFrom` and
// `adopters` and compares `canonical` and each entry by path: only on main is "missing here", only here is "no
// longer shared", and a different kind, hash or executable bit is "changed", one line each, sorted by
// path. The state is 'in-sync' only when nothing differs, 'drifted' when something does, and 'unknown', with its
// cause, whenever the answer cannot be known: no or a malformed local manifest, a failed fetch, or a canonical
// manifest that fails the same validation as a local one. Unknown is never reported as in sync.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { checkContained, kindOf, leftOutCause, readSettingsFile, SETTINGS_PATH } from './runtimes.mjs';
import { overrideProblems, parseSettings, seatsByPath, seatsRecord, substituteSeatSettings } from './seat-settings.mjs';

export const MANIFEST_PATH = '.agents/factory-manifest.json';
export const REGION_START = '<!-- factory-shared:start -->';
export const REGION_END = '<!-- factory-shared:end -->';
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/;

// Whether a remote URL, in https or ssh form, is github.com/<repository>.
export function isGithubRepository(url, repository) {
  return url?.match(GITHUB_REMOTE)?.[1].toLowerCase() === repository.toLowerCase();
}

export function checkManifestPath(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some((segment) => ['', '.', '..', '.git'].includes(segment.toLowerCase()))) {
    throw new Error(
      `invalid manifest path ${JSON.stringify(path)}: it must be a relative POSIX path with no empty, ".", ".." or ".git" segment`,
    );
  }
  return path;
}

function checkEntry(entry) {
  const keys = entry && typeof entry === 'object' ? Object.keys(entry).sort().join(',') : '';
  const shaped =
    (keys === 'path,sha256' && SHA256.test(entry.sha256)) ||
    (keys === 'executable,path,sha256' && entry.executable === true && SHA256.test(entry.sha256)) ||
    (keys === 'path,region,sha256' && entry.region === 'factory-shared' && SHA256.test(entry.sha256));
  if (!shaped) {
    throw new Error(
      `malformed manifest entry ${JSON.stringify(entry)}: it must be { path, sha256[, executable: true] } or { path, region: "factory-shared", sha256 }`,
    );
  }
  checkManifestPath(entry.path);
}

export function readManifest(root) {
  let text;
  try {
    text = readFileSync(join(root, MANIFEST_PATH), 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${MANIFEST_PATH} (${error.code ?? error.message})`, { cause: error });
  }
  return parseManifest(text, MANIFEST_PATH);
}

// The path as a case-insensitive, Unicode-normalising disk compares it.
const folded = (path) => path.normalize('NFC').toLowerCase();

// Refuses a seat path among paths that is not a file entry among entries; what names the record that held it, and
// remedy, when given, ends the refusal.
function checkSeatsListed(paths, entries, what, remedy = '') {
  for (const path of paths) {
    if (!entries.some((entry) => entry.path === path && !('region' in entry))) {
      throw new Error(`${what} names the seat ${path}, which is not a file entry of the manifest${remedy}`);
    }
  }
}

// The manifest held in text, validated; label names where the text came from in every error.
export function parseManifest(text, label) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${error.message})`);
  }
  const { canonical, adopters, entries } = manifest ?? {};
  if (
    !REPOSITORY.test(canonical) ||
    !Array.isArray(entries) ||
    (adopters !== undefined && !(Array.isArray(adopters) && adopters.every((adopter) => REPOSITORY.test(adopter))))
  ) {
    throw new Error(
      `malformed ${label}: it must hold canonical "owner/repo" and entries [...], and adopters, where it holds any, as ["owner/repo", ...]`,
    );
  }
  entries.forEach(checkEntry);
  // Keyed by each path folded: files maps the key to its path, directories maps each folded ancestor directory to a
  // path beneath it.
  const files = new Map();
  const directories = new Map();
  for (const { path } of entries) {
    const key = folded(path);
    const other = files.get(key);
    if (other === path) throw new Error(`${label} lists ${path} more than once`);
    if (other !== undefined) {
      throw new Error(`${label} lists ${other} and ${path}, which name the same file on a case-insensitive or Unicode-normalising disk`);
    }
    files.set(key, path);
    for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) directories.set(key.slice(0, slash), path);
  }
  const reserved = folded(SETTINGS_PATH);
  const settingsPath = files.get(reserved) ?? directories.get(reserved);
  if (settingsPath !== undefined) {
    throw new Error(
      `${label} lists ${settingsPath}, which names the seat settings file ${SETTINGS_PATH} or lies under it; that file is the repository's own and no manifest may list it`,
    );
  }
  for (const [key, path] of files) {
    const under = directories.get(key);
    if (under !== undefined) throw new Error(`${label} lists ${path} and ${under}, and ${under} lies under ${path}`);
  }
  const seatDefaults = manifest.seatDefaults === undefined ? new Map() : seatsByPath(manifest.seatDefaults, `${label} seatDefaults`);
  checkSeatsListed(seatDefaults.keys(), entries, `${label} seatDefaults`);
  return { ...manifest, seatDefaults };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// The line indexes of the region's two marker lines, each of which must stand alone on exactly one line, start
// before end.
function regionBounds(lines, path) {
  const at = (marker) => lines.flatMap((line, index) => (line === marker ? [index] : []));
  const [starts, ends] = [at(REGION_START), at(REGION_END)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(
      `${path}: malformed region markers: "${REGION_START}" and "${REGION_END}" must each stand alone on exactly one line, start before end (found ${starts.length} start and ${ends.length} end)`,
    );
  }
  return [starts[0], ends[0]];
}

// The text strictly between the region's two marker lines.
export function regionText(text, path) {
  const lines = text.split('\n');
  const [start, end] = regionBounds(lines, path);
  return lines.slice(start + 1, end).map((line) => `${line}\n`).join('');
}

// The text with everything strictly between its marker lines replaced by region; the rest stays byte for byte.
export function replaceRegion(text, region, path) {
  const lines = text.split('\n');
  const [start, end] = regionBounds(lines, path);
  return `${lines.slice(0, start + 1).join('\n')}\n${region}${lines.slice(end).join('\n')}`;
}

// Whether root's checkout honours file modes; a tree outside any repository, or one with core.fileMode unset (git
// config exits 1), does. Any other failed lookup is refused, never read as a checkout that honours file modes.
export function honoursFileModes(root) {
  const run = spawnSync('git', ['-C', root, 'config', '--type=bool', 'core.fileMode'], { encoding: 'utf8', env: gitEnvironment() });
  if (run.status === 0) return run.stdout.trim() !== 'false';
  if (run.status === 1) return true;
  throw new Error(`cannot read core.fileMode in ${root} (${run.error?.code ?? run.stderr.trim().split('\n')[0]})`);
}

// null where the disk holds the executable bit; otherwise each indexed path's git mode, keyed by path, since a
// checkout that does not honour file modes, as on Windows, keeps that bit only in the index.
function indexModes(root) {
  if (honoursFileModes(root)) return null;
  const listing = git(root, 'ls-files', '-s', '-z');
  if (listing === null) throw new Error(`cannot read the index modes of ${root}, whose checkout does not honour file modes`);
  return new Map(
    listing
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(tab + 1), line.slice(0, line.indexOf(' '))];
      }),
  );
}

// The entry's state on disk: { value } holding the file or region hash, plus, for a file entry,
// whether the owner may execute it, which is what git records as mode 100755, read from modes, the index modes,
// where the checkout does not honour file modes (an unindexed path there is not executable); or { problem } naming
// why no value of the entry's kind exists at its path.
export function entryState(root, entry, modes = indexModes(root)) {
  const full = join(root, checkManifestPath(entry.path));
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { problem: 'missing' };
    throw error;
  }
  if (!stat.isFile()) return { problem: `not a regular file (${kindOf(stat)})` };
  const value = valueOf(entry, readFileSync(full));
  if ('region' in entry) return { value };
  return { value, executable: modes ? modes.get(entry.path) === '100755' : (stat.mode & 0o100) !== 0 };
}

const modeName = (executable) => (executable ? 'executable' : 'not executable');

// The value the entry records for a file's bytes: the region hash or the file hash.
function valueOf(entry, data) {
  return sha256('region' in entry ? regionText(data.toString('utf8'), entry.path) : data);
}

// The settings a settings file's text holds, as parseSettings returns them, `seats` being a Map from seat path to the
// values the file names; an undefined text is a tree with no settings file. Refuses text that fails the file's own
// validation or names a seat the manifest does not list as a file; remedy, when given, ends that last refusal.
export function settingsWithSeats(text, manifest, remedy) {
  const settings = parseSettings(text, SETTINGS_PATH);
  checkSeatsListed(settings.seats.keys(), manifest.entries, SETTINGS_PATH, remedy);
  return settings;
}

const NOT_RENDERED = 'seat settings not rendered; run node scripts/factory-sync.mjs --render';

// The value an overridden seat's file stands for, which is the entry's record only when the file is the shared
// bytes with exactly the named values in place: the hash of its bytes with the recorded defaults put back, why
// they cannot be put back, or NOT_RENDERED when the settings named and the defaults recorded are not the same
// settings, or the values the defaults replaced are not the named ones. named holds the settings file's values
// for the seat and recorded the manifest's defaults for it; a seat only one of them knows has none in the other.
function overriddenSeatValue(root, entry, named = {}, recorded = {}) {
  const names = (values) => Object.keys(values).sort().join(',');
  if (names(named) !== names(recorded)) return NOT_RENDERED;
  let restored;
  try {
    restored = substituteSeatSettings(entry.path, readFileSync(join(root, entry.path)), recorded);
  } catch (error) {
    return error.message;
  }
  const value = sha256(restored.data);
  const rendered = Object.entries(named).every(([name, namedValue]) => restored.replaced[name] === namedValue);
  return value !== entry.sha256 || rendered ? value : NOT_RENDERED;
}

// Every entry whose disk state differs from its record, as { path, expected, actual }; actual is the
// disk value or the problem that stands in for it, for an overridden seat what overriddenSeatValue gives, or, for
// a file whose bytes match, its executable state. An entry the settings file leaves out differs whenever its path
// holds anything. A manifest passed without seatDefaults records none. The tree is judged by settingsText, the text of
// a settings file or undefined for none: its own settings file unless the caller hands another.
export function verifyManifest(root, manifest = readManifest(root), settingsText = readSettingsFile(root)) {
  const settings = settingsWithSeats(settingsText, manifest);
  const modes = indexModes(root);
  const { seats: overrides } = settings;
  const defaults = manifest.seatDefaults ?? new Map();
  return manifest.entries.flatMap((entry) => {
    const { value, problem, executable } = entryState(root, entry, modes);
    const cause = leftOutCause(settings, entry.path);
    if (cause !== null) {
      return problem === 'missing' ? [] : [{ path: entry.path, expected: `absent (${cause})`, actual: value ?? problem }];
    }
    const overridden = value !== undefined && (overrides.has(entry.path) || defaults.has(entry.path));
    const actual = overridden ? overriddenSeatValue(root, entry, overrides.get(entry.path), defaults.get(entry.path)) : value ?? problem;
    if (actual !== entry.sha256) return [{ path: entry.path, expected: entry.sha256, actual }];
    if (executable === undefined || executable === (entry.executable === true)) return [];
    return [{ path: entry.path, expected: modeName(entry.executable), actual: modeName(executable) }];
  });
}

// The manifest's entries in the same order, each re-recorded from disk; an entry with no value of its kind
// on disk cannot be recorded and throws.
export function computeEntries(root, manifest = readManifest(root)) {
  const modes = indexModes(root);
  return manifest.entries.map((entry) => {
    const { value, problem, executable } = entryState(root, entry, modes);
    if (problem) throw new Error(`cannot record ${entry.path}: ${problem}`);
    if ('region' in entry) return { ...entry, sha256: value };
    return { path: entry.path, sha256: value, ...(executable ? { executable: true } : {}) };
  });
}

let localEnvVars;

// The environment for every git call: this process's, with credential prompts off and without every
// repository-scoped variable git itself lists (GIT_DIR, GIT_INDEX_FILE and the rest), which an inherited
// environment would otherwise use to point a call at another repository, index or object store.
export function gitEnvironment() {
  if (!localEnvVars) {
    const list = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
    if (list.status !== 0) throw new Error(`cannot list git's repository-scoped variables (${list.error?.code ?? list.stderr.trim()})`);
    localEnvVars = list.stdout.split('\n').filter(Boolean);
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of localEnvVars) delete env[name];
  return env;
}

function git(root, ...args) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnvironment() });
  return run.status === 0 ? run.stdout.trim() : null;
}

// The bytes of a blob in root's object store.
function blob(root, object) {
  const run = spawnSync('git', ['-C', root, 'cat-file', 'blob', object], { env: gitEnvironment() });
  if (run.status !== 0) throw new Error(`cannot read the object ${object} in ${root}`);
  return run.stdout;
}

// The manifest the commit holds, validated; whose names the repository in every error.
function committedManifest(root, commit, whose) {
  const label = `${whose} ${MANIFEST_PATH} at ${commit}`;
  const text = git(root, 'show', `${commit}:${MANIFEST_PATH}`);
  if (text === null) throw new Error(`cannot read ${label}`);
  return parseManifest(text, label);
}

// What the commit's tree holds at each of the paths, keyed by path, as { mode, object }; a path the commit lacks
// has no key. what names the listing in the error thrown when it fails.
function committedTree(root, commit, paths, what) {
  const listing = git(root, '--literal-pathspecs', 'ls-tree', '-z', commit, '--', ...paths);
  if (listing === null) throw new Error(`cannot list ${what}`);
  return new Map(
    listing
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, , object] = line.slice(0, tab).split(' ');
        return [line.slice(tab + 1), { mode, object }];
      }),
  );
}

// Each entry's content in the commit, keyed by path, as { data, mode }: the file bytes or the region text, and the
// git mode. Refuses, naming every such path, an entry whose committed kind or content differs from
// its record.
function committedContents(root, commit, manifest) {
  const tree = committedTree(root, commit, manifest.entries.map(({ path }) => path), `the shared paths in the source's commit ${commit}`);
  const contents = new Map();
  const mismatched = [];
  for (const entry of manifest.entries) {
    const { mode, object } = tree.get(entry.path) ?? {};
    const modes = 'region' in entry ? ['100644', '100755'] : [entry.executable ? '100755' : '100644'];
    const data = modes.includes(mode) ? blob(root, object) : null;
    if (data === null || valueOf(entry, data) !== entry.sha256) {
      mismatched.push(entry.path);
      continue;
    }
    contents.set(entry.path, { data: 'region' in entry ? regionText(data.toString('utf8'), entry.path) : data, mode });
  }
  if (mismatched.length > 0) {
    throw new Error(`the source does not match its own manifest at ${mismatched.join(', ')} in its commit ${commit}`);
  }
  return contents;
}

function uncommitted(root, paths) {
  const status = git(root, '--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--', ...paths);
  if (status === null) throw new Error(`cannot read the git status of ${root}`);
  return status;
}

// The paths among those given whose index entry is marked skip-worktree or assume-unchanged: git status reports no
// change at such a path, whatever the disk holds, and a commit does not record its removal. git tags a plain tracked
// entry `H`; every other tag counts as marked, so one this code does not know refuses. A directory among the paths
// lists the entries beneath it, which the caller's lookup by exact path never matches.
function hiddenFromStatus(root, paths) {
  const listing = git(root, '--literal-pathspecs', 'ls-files', '-v', '-z', '--', ...paths);
  if (listing === null) throw new Error(`cannot read the index flags of ${root}`);
  return new Set(
    listing
      .split('\0')
      .filter((line) => line && line[0] !== 'H')
      .map((line) => line.slice(2)),
  );
}

function hiddenPathError(path, cause) {
  const prefix = cause === undefined ? '' : `${cause}, but `;
  const removal = cause === undefined ? '' : ' and the next commit would not record its removal';
  return new Error(`${path}: ${prefix}the target's index marks it skip-worktree or assume-unchanged, which hides it from git status, so the sync cannot prove it clean${removal}; clear both marks with git update-index --no-skip-worktree -- ${path} and git update-index --no-assume-unchanged -- ${path}, commit or restore whatever git status then shows there, then sync`);
}

// The target's committed manifest, validated, or null when HEAD verifiably holds none: a listing of HEAD's tree
// settles which, so a manifest that cannot be read is refused, never taken for a first sync.
function previousManifest(target) {
  const what = `${MANIFEST_PATH} in the target's HEAD, which the sync reads to know what it last shared there; a target with no commit needs one first`;
  if (!committedTree(target, 'HEAD', [MANIFEST_PATH], what).has(MANIFEST_PATH)) return null;
  return committedManifest(target, 'HEAD', "the target's");
}

function resolveCanonical(previous, requested) {
  if (previous === null) {
    if (requested === undefined) {
      throw new Error(`no canonical repository: the target has no committed ${MANIFEST_PATH}, so name one with --canonical <owner/repo>`);
    }
    if (!REPOSITORY.test(requested)) throw new Error(`--canonical ${requested} is not "owner/repo"`);
    return requested;
  }
  const { canonical } = previous;
  if (requested !== undefined && requested.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(`--canonical ${requested} disagrees with ${canonical}, the canonical in the target's committed ${MANIFEST_PATH}`);
  }
  return canonical;
}

// Refuses a path of the tree at root that lies under a symlinked directory or holds anything but a regular file,
// before any read of it; returns its lstat.
function checkRegularFile(root, path) {
  checkContained(root, path);
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${path} is not a regular file (${stat ? kindOf(stat) : 'missing'})`);
  return stat;
}

function checkReplaceable(full, path) {
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory() && readdirSync(full).length > 0) throw new Error(`${path}: the target holds a non-empty directory here`);
}

// Clears whatever is at the path, so the new file never writes through an existing one.
function clear(full) {
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) rmdirSync(full);
  else unlinkSync(full);
}

// The paths, sorted, of the retired entries the sync may remove: each holds a regular file, under no symlinked
// parent, whose bytes on disk and at the target's HEAD are the entry's record. retired holds { entry, cause }, cause
// being why the target no longer holds the entry, which starts every refusal that turns on it; installed holds the
// entries the sync writes. An entry the index marks skip-worktree or assume-unchanged is refused whatever its path
// holds. Any other retired path that holds nothing is skipped, and anything else at one is refused by name. It
// removes nothing itself, so every entry is proven before any file goes. The disk and HEAD are both checked because
// the status check sees neither an ignored file nor a byte difference a line-ending conversion hides from it.
function provenRetired(root, retired, installed, hidden) {
  // With no path the listing would hold the whole tree.
  if (retired.length === 0) return [];
  const paths = retired.map(({ entry }) => entry.path);
  const tree = committedTree(root, 'HEAD', paths, "the retired paths in the target's HEAD");
  const twins = new Map(installed.map(({ path }) => [folded(path), path]));
  const proven = [];
  for (const { entry, cause } of retired) {
    const { path } = entry;
    if ('region' in entry) {
      throw new Error(`${path}: the manifest no longer shares this file's ${entry.region} region, and the sync never removes text from a file the adopter owns around it; retiring a region needs its own change to the sync`);
    }
    if (hidden.has(path)) {
      throw hiddenPathError(path, cause);
    }
    const { value, problem } = entryState(root, entry, null);
    if (problem === 'missing') continue;
    const twin = twins.get(folded(path));
    if (twin !== undefined) {
      throw new Error(`${path}: the manifest no longer shares it but now shares ${twin}, which names the same file on a case-insensitive or Unicode-normalising disk, so the sync cannot remove one without the other; remove ${path}, commit, then sync`);
    }
    checkContained(root, path);
    if (value !== entry.sha256) {
      throw new Error(`${path}: ${cause}, and the sync removes only the exact bytes it last recorded there, but this is ${problem ?? 'a file with other bytes'}; remove it or move it to a path of the adopter's own, commit, then sync`);
    }
    const { mode, object } = tree.get(path) ?? {};
    let committed = null;
    if (['100644', '100755'].includes(mode)) {
      try {
        committed = sha256(blob(root, object));
      } catch (error) {
        throw new Error(`${path}: ${cause}, but the sync ${error.message}, so it cannot prove the bytes the target's HEAD holds there; repair the repository's object store, then sync`);
      }
    }
    if (committed !== entry.sha256) {
      throw new Error(`${path}: ${cause}, and the sync removes only a file committed with the exact bytes it last recorded there, but the target's HEAD does not hold those bytes as a regular file at this path; commit the file or remove it, then sync`);
    }
    proven.push(path);
  }
  return proven.sort();
}

const UNSHARED_SEAT = `; the manifest the sync fetched does not share that seat, so remove that seat from ${SETTINGS_PATH}, run node scripts/factory-sync.mjs --render, commit, then sync`;
const NAMED_AFTER_SYNC = 'a value only a newer copy of the shared workflow admits can be named after the sync that installs it';

// A seat's shared bytes with the values its settings name in place, as { data, replaced }, replaced holding the
// values that were there. Refuses values that give the seat a problem its shared bytes do not have: this copy
// judges what the settings file names and nothing else, so a default it does not know stops nothing.
export function renderSeat(path, shared, values) {
  const rendered = substituteSeatSettings(path, shared, values);
  const problems = overrideProblems(path, shared, rendered.data);
  if (problems.length > 0) {
    throw new Error(`${SETTINGS_PATH}: the settings named for ${path} introduce: ${problems.join('; ')}; ${NAMED_AFTER_SYNC}`);
  }
  return rendered;
}

function writeRegular(full, data, mode) {
  clear(full);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  chmodSync(full, mode);
}

// Fetches the source's origin main and returns the fetched commit; throws with git's own cause when it cannot.
export function fetchMain(source) {
  const fetch = spawnSync('git', ['-C', source, 'fetch', '--quiet', 'origin', 'main'], { encoding: 'utf8', env: gitEnvironment() });
  if (fetch.status !== 0) throw new Error(fetch.stderr.trim() || 'git fetch origin main failed');
  const fetched = git(source, 'rev-parse', 'FETCH_HEAD');
  if (fetched === null) throw new Error('cannot read FETCH_HEAD after fetching origin main');
  return fetched;
}

// Count the complete argv conservatively for Windows quoting, keeping each path or cacheinfo pair together.
function indexGitBatches(root, args, units) {
  const cost = (argv) => argv.reduce((total, argument) => total + 2 * argument.length + 3, 0);
  const prefixCost = 1 + cost(['git', '-C', root, ...args]);
  const batches = [];
  let batch = [...args];
  let batchCost = prefixCost;
  for (const unit of units) {
    const unitCost = cost(unit);
    if (prefixCost + unitCost > 30000) throw new Error('a single index-recording Git argument unit exceeds 30000 UTF-16 units');
    if (batchCost + unitCost > 30000) {
      batches.push(batch);
      batch = [...args];
      batchCost = prefixCost;
    }
    batch.push(...unit);
    batchCost += unitCost;
  }
  if (batch.length > args.length) batches.push(batch);
  return batches;
}

// Records each file entry's executable bit in root's index, where the checkout does not honour file modes and so
// keeps that bit only there; returns at once where it does. Region entries are not recorded.
export function recordIndexModes(root, entries) {
  if (honoursFileModes(root)) return;
  const files = entries.filter((entry) => !('region' in entry));
  const refusal = (paths, executable, cause) => new Error(
    `cannot record ${paths.join(', ')} as ${modeName(executable)} in the index of ${root}, whose checkout does not honour file modes`,
    { cause },
  );
  for (const { path, executable } of files) {
    try {
      checkContained(root, path);
      if (!lstatSync(join(root, path)).isFile()) throw new Error(`${path} is not a regular file`);
    } catch (cause) {
      throw refusal([path], executable === true, cause);
    }
  }
  const groups = [];
  for (const executable of [true, false]) {
    const paths = files.filter((entry) => (entry.executable === true) === executable).map(({ path }) => path);
    const hashes = [];
    try {
      for (const batch of indexGitBatches(root, ['hash-object', '-w', '--'], paths.map((path) => [path]))) {
        const output = git(root, ...batch);
        const ids = output === null ? [] : output.split(/\r?\n/);
        if (ids.length !== batch.length - 3 || ids.some((id) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id))) {
          throw new Error('Git did not return one valid object ID per file');
        }
        hashes.push(...ids);
      }
      const mode = executable ? '100755' : '100644';
      const units = paths.map((path, i) => ['--cacheinfo', `${mode},${hashes[i]},${path}`]);
      groups.push({ executable, paths, batches: indexGitBatches(root, ['update-index', '--add'], units) });
    } catch (cause) {
      throw refusal(paths, executable, cause);
    }
  }
  // Hash every group and validate every batch before staging anything; native cacheinfo retains conflict refusal.
  for (const { executable, paths, batches } of groups) {
    for (const batch of batches) {
      if (git(root, ...batch) === null) throw refusal(paths, executable);
    }
  }
}

// Syncs the source's manifest entries into the target, per the contract at the top of this file. fetchMain, the
// function above or a stand-in, fetches the source's origin main and returns its commit; it throws when the fetch
// fails. Returns the counts written, the paths removed, sorted, and the number of entries the target's settings file
// leaves out, as { files, regions, removed, omitted }.
export function syncInto({ source, target, canonical: requested, fetchMain }) {
  const previous = previousManifest(target);
  const canonical = resolveCanonical(previous, requested);

  const sourceOrigin = git(source, 'remote', 'get-url', 'origin');
  if (sourceOrigin === null) throw new Error(`the source has no origin remote; it must be a clone of github.com/${canonical}`);
  if (!isGithubRepository(sourceOrigin, canonical)) {
    throw new Error(`the source's origin ${sourceOrigin} is not github.com/${canonical}`);
  }
  const targetOrigin = git(target, 'remote', 'get-url', 'origin');
  if (isGithubRepository(targetOrigin, canonical)) {
    throw new Error(`the target's origin ${targetOrigin} is the canonical github.com/${canonical}: never sync into the canonical`);
  }

  let fetched;
  try {
    fetched = fetchMain(source);
  } catch (error) {
    throw new Error(`cannot fetch the source's origin main (${error.message})`);
  }
  const head = git(source, 'rev-parse', 'HEAD');
  if (head !== fetched) {
    throw new Error(`the source is not on its freshly fetched origin main: HEAD is ${head ?? '(none)'}, origin main is ${fetched}`);
  }

  const manifest = committedManifest(source, fetched, "the source's");
  if (manifest.canonical.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(`the source's manifest names the canonical ${manifest.canonical}, not ${canonical}`);
  }
  const shared = [...manifest.entries.map((entry) => entry.path), MANIFEST_PATH];
  const retired = previous === null ? [] : previous.entries.filter(({ path }) => !manifest.entries.some((entry) => entry.path === path));
  const sourceChanges = uncommitted(source, shared);
  if (sourceChanges) throw new Error(`the source has uncommitted changes at shared paths: ${sourceChanges}`);
  const contents = committedContents(source, fetched, manifest);
  const paths = [...shared, ...retired.map(({ path }) => path)];
  const targetChanges = uncommitted(target, paths);
  if (targetChanges) throw new Error(`the target has uncommitted changes at shared paths: ${targetChanges}`);
  const hidden = hiddenFromStatus(target, paths);

  const root = realpathSync(target);
  const settings = settingsWithSeats(readSettingsFile(root), manifest, UNSHARED_SEAT);
  const { seats: overrides } = settings;
  const causes = manifest.entries.map((entry) => ({ entry, cause: leftOutCause(settings, entry.path) }));
  const installed = causes.filter(({ cause }) => cause === null).map(({ entry }) => entry);
  const leftOut = causes.filter(({ cause }) => cause !== null);
  for (const entry of installed) {
    checkContained(root, entry.path);
    if (!('region' in entry)) checkReplaceable(join(root, entry.path), entry.path);
  }
  checkContained(root, MANIFEST_PATH);
  checkReplaceable(join(root, MANIFEST_PATH), MANIFEST_PATH);
  const seats = new Map([...overrides].map(([path, values]) => [path, renderSeat(path, contents.get(path).data, values)]));
  const removed = provenRetired(
    root,
    [
      ...retired.map((entry) => ({ entry, cause: 'the manifest no longer shares it' })),
      ...leftOut.map(({ entry, cause }) => ({ entry: previous?.entries.find(({ path }) => path === entry.path) ?? entry, cause })),
    ],
    installed,
    hidden,
  );
  for (const path of [...installed.map(({ path }) => path), MANIFEST_PATH]) {
    if (hidden.has(path)) {
      throw hiddenPathError(path);
    }
  }
  const regions = new Map(
    installed
      .filter((entry) => 'region' in entry)
      .map(({ path }) => {
        const label = `target ${path}`;
        if (!lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`${label}: malformed region markers: the target has no regular file here`);
        }
        return [path, replaceRegion(readFileSync(join(root, path), 'utf8'), contents.get(path).data, label)];
      }),
  );

  for (const path of removed) unlinkSync(join(root, path));
  const written = { files: 0, regions: 0 };
  for (const entry of installed) {
    const full = join(root, entry.path);
    if ('region' in entry) {
      writeRegular(full, regions.get(entry.path), lstatSync(full).mode & 0o777);
      written.regions += 1;
    } else {
      const { data, mode } = contents.get(entry.path);
      writeRegular(full, seats.get(entry.path)?.data ?? data, mode === '100755' ? 0o755 : 0o644);
      written.files += 1;
    }
  }
  const seatDefaults = seatsRecord(new Map([...seats].map(([path, { replaced }]) => [path, replaced])));
  const record = {
    canonical,
    syncedFrom: fetched,
    ...(seats.size > 0 ? { seatDefaults } : {}),
    entries: manifest.entries,
  };
  writeRegular(join(root, MANIFEST_PATH), `${JSON.stringify(record, null, 2)}\n`, 0o644);
  recordIndexModes(root, installed);
  return { ...written, removed, omitted: leftOut.length };
}

// Applies the settings file of the tree at root to its seats, per the contract at the top of this file. Returns the
// seat paths whose bytes it changed, sorted, and whether it rewrote the manifest, as { seats, manifest }.
export function renderSettings(root) {
  const tree = realpathSync(root);
  checkRegularFile(tree, MANIFEST_PATH);
  const manifest = readManifest(tree);
  const origin = git(tree, 'remote', 'get-url', 'origin');
  if (isGithubRepository(origin, manifest.canonical)) {
    throw new Error(`the origin ${origin} is the canonical github.com/${manifest.canonical}, whose seat lines are the defaults: a retune there edits the seat file, and no settings file is rendered`);
  }
  const settings = settingsWithSeats(readSettingsFile(tree), manifest);
  const { seats: overrides } = settings;
  const recorded = manifest.seatDefaults;

  const defaults = new Map();
  const changed = new Map();
  for (const path of [...new Set([...overrides.keys(), ...recorded.keys()])].sort()) {
    if (leftOutCause(settings, path) !== null) continue;
    const mode = checkRegularFile(tree, path).mode & 0o777;
    const full = join(tree, path);
    const data = readFileSync(full);
    const restored = substituteSeatSettings(path, data, recorded.get(path) ?? {});
    if (sha256(restored.data) !== manifest.entries.find((entry) => entry.path === path).sha256) {
      throw new Error(`${path}: its bytes outside its setting lines are not the shared file the manifest records, so no settings can be rendered into it; put the seat file back as the last sync or render left it, then run node scripts/factory-sync.mjs --render`);
    }
    const rendered = renderSeat(path, restored.data, overrides.get(path) ?? {});
    if (overrides.has(path)) defaults.set(path, rendered.replaced);
    if (!rendered.data.equals(data)) changed.set(path, { full, data: rendered.data, mode });
  }
  const pairs = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'seatDefaults') continue;
    if (key === 'entries' && defaults.size > 0) pairs.push(['seatDefaults', seatsRecord(defaults)]);
    pairs.push([key, value]);
  }
  const text = `${JSON.stringify(Object.fromEntries(pairs), null, 2)}\n`;

  for (const { full, data, mode } of changed.values()) writeRegular(full, data, mode);
  const manifestChanged = text !== readFileSync(join(tree, MANIFEST_PATH), 'utf8');
  if (manifestChanged) writeRegular(join(tree, MANIFEST_PATH), text, 0o644);
  return { seats: [...changed.keys()], manifest: manifestChanged };
}

const sameEntry = (a, b) => a.sha256 === b.sha256 && a.region === b.region && a.executable === b.executable;

// Compares this repository's manifest with the canonical's manifest on main, per the --check contract at the top
// of this file. fetchCanonicalManifest(canonical) returns that manifest's raw text and throws when it cannot.
// Returns { state: 'in-sync' | 'drifted' | 'unknown', differences, cause }.
export function checkLag({ root, fetchCanonicalManifest }) {
  const unknown = (cause) => ({ state: 'unknown', differences: [], cause });
  let local;
  try {
    local = readManifest(root);
  } catch (error) {
    return unknown(error.cause?.code === 'ENOENT' ? 'no factory manifest here; run the first sync with --from' : error.message);
  }
  const label = `${local.canonical} main's ${MANIFEST_PATH}`;
  let text;
  try {
    text = fetchCanonicalManifest(local.canonical);
  } catch (error) {
    return unknown(`cannot fetch ${label} (${error.message})`);
  }
  let remote;
  try {
    remote = parseManifest(text, label);
  } catch (error) {
    return unknown(error.message);
  }

  const differences = [];
  if (local.canonical !== remote.canonical) differences.push(`canonical: ${local.canonical} here, ${remote.canonical} on main`);
  const [here, there] = [local, remote].map(({ entries }) => new Map(entries.map((entry) => [entry.path, entry])));
  for (const path of [...new Set([...here.keys(), ...there.keys()])].sort()) {
    if (!here.has(path)) differences.push(`${path}: missing here`);
    else if (!there.has(path)) differences.push(`${path}: no longer shared`);
    else if (!sameEntry(here.get(path), there.get(path))) differences.push(`${path}: changed`);
  }
  return { state: differences.length === 0 ? 'in-sync' : 'drifted', differences, cause: null };
}
