// workflow-pin.mjs: chooses the workflow version a job runs and writes that commit's tree. A fresh start takes local
// main only when fetched origin/main already holds it, so a job never runs workflow code that has not landed.
// Every git call ignores replace objects, which would otherwise let a local ref rewrite what a commit names. Nothing
// here fetches; the caller fetches first.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gitEnvironment } from './factory-sync.mjs';

/** @type {NodeJS.ProcessEnv | undefined} */
let gitEnv;
// Read on first use, so loading this module runs no git.
const env = () => (gitEnv ??= { ...gitEnvironment(), GIT_NO_REPLACE_OBJECTS: '1' });
// A workflow tree is far smaller; the bound stops a runaway read before it exhausts memory.
const MAX_OUTPUT = 64 * 1024 * 1024;
const SYMLINK_MODE = '120000';
const FILE_MODES = new Map([['100644', 0o644], ['100755', 0o755]]);
const SETTINGS = '.claude/settings.json';
const STORE = 'fabraik-workflow';
// A full object ID in either object format, sha1 or sha256.
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The paths every open Claude job shares with the root checkout; of the settings file only its `hooks` value.
const SHARED_CONTRACTS = [SETTINGS, 'scripts/lib/workflow-pin.mjs', 'scripts/lib/delivery-lane-contract.test.mjs'];

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: env() });

/**
 * Runs git with raw byte output, so no blob is decoded as text.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Buffer} [input]
 * @param {number} [maxBuffer]
 * @returns {Buffer}
 */
const gitBytes = (cwd, args, input, maxBuffer = MAX_OUTPUT) => {
  const run = spawnSync('git', args, { cwd, encoding: 'buffer', env: env(), input, maxBuffer });
  if (run.status !== 0) throw new Error(`${cwd}: git ${args[0]} failed (${run.error?.message ?? run.stderr.toString('utf8').trim()})`);
  return run.stdout;
};

/**
 * @param {string} cwd
 * @param {string} ref
 * @returns {string}
 */
const resolve = (cwd, ref) => {
  const run = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (run.status !== 0) throw new Error(`${cwd}: cannot resolve ${ref} (${run.error?.message ?? run.stderr.trim()})`);
  return run.stdout.trim();
};

/**
 * Whether `commit` is an ancestor of fetched origin/main, the reviewed main; throws when git cannot compare them, as for
 * a commit it cannot read.
 * @param {{ cwd: string, commit: string }} options
 * @returns {boolean}
 */
export function onReviewedMain({ cwd, commit }) {
  const origin = resolve(cwd, 'refs/remotes/origin/main');
  const ancestry = git(cwd, ['merge-base', '--is-ancestor', '--end-of-options', commit, origin]);
  if (ancestry.status === 0 || ancestry.status === 1) return ancestry.status === 0;
  throw new Error(`${cwd}: cannot compare ${commit} with origin/main ${origin} (${ancestry.error?.message ?? ancestry.stderr.trim()})`);
}

/**
 * Returns local main's commit when it is an ancestor of fetched origin/main, and throws otherwise.
 * @param {{ cwd: string }} options
 * @returns {string}
 */
export function selectWorkflowVersion({ cwd }) {
  const main = resolve(cwd, 'refs/heads/main');
  if (!onReviewedMain({ cwd, commit: main })) throw new Error(`${cwd}: local main ${main} is not on origin/main`);
  return main;
}

/**
 * Returns whether `bytes` are valid UTF-8, so decoding them to a string loses nothing.
 * @param {Buffer} bytes
 * @returns {boolean}
 */
const isUtf8 = (bytes) => Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);

/**
 * Lists every entry of a commit's tree as `git ls-tree --full-tree -r -z` prints it, with paths from the root whatever
 * folder the call runs in. Throws before anything is written when a path is not valid UTF-8, since the snapshot could
 * not write its bytes exactly.
 * @param {string} cwd
 * @param {string} commit
 * @returns {{ mode: string, object: string, path: string }[]}
 */
const listTree = (cwd, commit) => gitBytes(cwd, ['ls-tree', '--full-tree', '-r', '-z', '--end-of-options', `${commit}^{commit}`])
  .toString('latin1').split('\0').filter(Boolean).map((raw) => {
    const bytes = Buffer.from(raw, 'latin1');
    const line = bytes.toString('utf8');
    if (!isUtf8(bytes)) throw new Error(`${cwd}: path ${line.slice(line.indexOf('\t') + 1)} in ${commit} is not valid UTF-8`);
    const tab = line.indexOf('\t');
    const [mode, , object] = line.slice(0, tab).split(' ');
    return { mode, object, path: line.slice(tab + 1) };
  });

/**
 * Reads every named blob's literal bytes with `git cat-file --batch`, in batches whose output stays within
 * `maxOutput`; a blob larger than that gets a read of its own.
 * @param {string} cwd
 * @param {string[]} objects
 * @param {number} [maxOutput]
 * @returns {Map<string, Buffer>}
 */
export const readBlobs = (cwd, objects, maxOutput = MAX_OUTPUT) => {
  const unique = [...new Set(objects)];
  const request = Buffer.from(unique.map((object) => `${object}\n`).join(''));
  const heads = gitBytes(cwd, ['cat-file', '--batch-check'], request).toString('utf8').split('\n').slice(0, unique.length);
  // Each record is its header line, the content and one closing newline.
  const lengths = heads.map((head) => head.length + Number(head.split(' ')[2]) + 2);
  const blobs = new Map();
  for (let first = 0; first < unique.length;) {
    let last = first + 1;
    let total = lengths[first];
    while (last < unique.length && total + lengths[last] <= maxOutput) total += lengths[last++];
    const batch = unique.slice(first, last);
    const output = gitBytes(cwd, ['cat-file', '--batch'], Buffer.from(batch.map((object) => `${object}\n`).join('')), Math.max(total, maxOutput));
    let at = 0;
    for (const object of batch) {
      const end = output.indexOf(0x0a, at);
      const header = output.subarray(at, end).toString('utf8');
      const [id, type, size] = header.split(' ');
      if (id !== object || type !== 'blob') throw new Error(`${cwd}: object ${object} is not a readable blob (${header})`);
      blobs.set(object, output.subarray(end + 1, end + 1 + Number(size)));
      at = end + 2 + Number(size);
    }
    first = last;
  }
  return blobs;
};

/**
 * Writes the commit's tree into the existing empty directory `into`: regular files with their literal bytes and
 * mode, symbolic links with the blob as their target. Throws before writing when an entry has any other mode, such
 * as a gitlink.
 * @param {{ cwd: string, commit: string, into: string }} options
 */
export function workflowSnapshot({ cwd, commit, into }) {
  const tree = listTree(cwd, commit);
  for (const { mode, path } of tree) {
    if (mode !== SYMLINK_MODE && !FILE_MODES.has(mode)) throw new Error(`${join(into, path)}: cannot snapshot mode ${mode} from ${commit}`);
  }
  const blobs = readBlobs(cwd, tree.map((entry) => entry.object));
  for (const { mode, object, path } of tree) {
    const target = join(into, path);
    const bytes = /** @type {Buffer} */ (blobs.get(object));
    const fileMode = FILE_MODES.get(mode);
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (fileMode === undefined) {
        symlinkSync(bytes, target);
      } else {
        writeFileSync(target, bytes, { flag: 'wx', mode: fileMode });
        // The creation mode passes through the umask; set it exactly.
        chmodSync(target, fileMode);
      }
    } catch (error) {
      throw new Error(`${target}: cannot write ${object} (${/** @type {Error} */ (error).message})`);
    }
  }
}

/**
 * Lists every non-directory entry under `dir` as a `/`-separated relative path, never following a symbolic link.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
const listSnapshot = (dir, prefix = '') => readdirSync(join(dir, prefix), { withFileTypes: true, encoding: 'buffer' }).flatMap((entry) => {
  const name = entry.name.toString('utf8');
  if (!isUtf8(entry.name)) throw new Error(`${dir}: entry ${name} is not valid UTF-8`);
  const path = prefix === '' ? name : `${prefix}/${name}`;
  return entry.isDirectory() ? listSnapshot(dir, path) : [path];
});

/**
 * Returns the git mode a snapshot entry's lstat implies, or undefined for a kind a tree cannot hold. Windows keeps no
 * execute bit, so there a regular file stands for whichever file mode the tree names, `expected`.
 * @param {import('node:fs').Stats} stat
 * @param {string} expected
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined}
 */
const snapshotMode = (stat, expected, platform) => {
  if (stat.isSymbolicLink()) return SYMLINK_MODE;
  if (!stat.isFile()) return undefined;
  if (platform === 'win32' && FILE_MODES.has(expected)) return expected;
  return (stat.mode & 0o100) === 0 ? '100644' : '100755';
};

/**
 * Hashes bytes as a git blob ID in the repository's object format, `sha1` or `sha256`.
 * @param {string} format
 * @param {Buffer} bytes
 * @returns {string}
 */
const blobId = (format, bytes) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Throws when `dir` holds a path the commit's tree lacks or lacks one it holds, or when a path's mode or content
 * differs from the tree's.
 * @param {{ cwd: string, commit: string, dir: string, platform?: NodeJS.Platform }} options
 */
export function verifyWorkflowSnapshot({ cwd, commit, dir, platform = process.platform }) {
  const tree = listTree(cwd, commit);
  const expected = new Set(tree.map((entry) => entry.path));
  const actual = new Set(listSnapshot(dir));
  for (const path of actual) {
    if (!expected.has(path)) throw new Error(`${join(dir, path)}: not in the tree of ${commit}`);
  }
  for (const path of expected) {
    if (!actual.has(path)) throw new Error(`${join(dir, path)}: missing from the snapshot of ${commit}`);
  }
  const format = gitBytes(cwd, ['rev-parse', '--show-object-format']).toString('utf8').trim();
  for (const { mode, object, path } of tree) {
    const target = join(dir, path);
    const found = snapshotMode(lstatSync(target), mode, platform);
    if (found !== mode) throw new Error(`${target}: mode ${found ?? 'of an unsupported kind'} differs from ${mode} in ${commit}`);
    const bytes = mode === SYMLINK_MODE ? readlinkSync(target, { encoding: 'buffer' }) : readFileSync(target);
    const id = blobId(format, bytes);
    if (id !== object) throw new Error(`${target}: content ${id} differs from ${object} in ${commit}`);
  }
}

/**
 * Turns the write bits of `path` and, for a directory, of everything under it on or off. Symbolic links are left as
 * they are, since their own mode means nothing.
 * @param {string} path
 * @param {boolean} on
 */
const setWritable = (path, on) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  // A directory regains its write bit before its entries change and loses it only after.
  if (on) chmodSync(path, (stat.mode & 0o7777) | 0o200);
  if (stat.isDirectory()) for (const name of readdirSync(path)) setWritable(join(path, name), on);
  if (!on) chmodSync(path, stat.mode & 0o7555);
};

/**
 * @param {string} path
 * @returns {boolean}
 */
const occupied = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * @param {string} cwd
 * @returns {string}
 */
const commonDir = (cwd) => gitBytes(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString('utf8').trim();

/**
 * The snapshot store of the repository at `cwd`, `<common-dir>/fabraik-workflow`, which holds each commit's copy.
 * @param {string} cwd
 * @returns {string}
 */
export const workflowStore = (cwd) => join(commonDir(cwd), STORE);

/**
 * Restores `<common-dir>/fabraik-workflow/<commit>` to a verified, read-only copy of the commit's tree. The fresh copy
 * is written and verified in a staging directory inside the store before anything at the canonical path moves; a copy
 * already there is kept at the lowest unused `<commit>.damaged-<n>`. Prints the kept path, then the canonical path.
 * Throws an Error naming the canonical path and the cause when the commit cannot be copied, verified or installed,
 * removing the staging directory and leaving every other store entry as it was.
 * @param {{ cwd: string, commit: string }} options
 */
export function repairWorkflowSnapshot({ cwd, commit }) {
  const store = workflowStore(cwd);
  const canonical = join(store, commit);
  /** @type {string | undefined} */
  let staging;
  try {
    mkdirSync(store, { recursive: true });
    staging = mkdtempSync(join(store, `${commit}.staging-`));
    workflowSnapshot({ cwd, commit, into: staging });
    verifyWorkflowSnapshot({ cwd, commit, dir: staging });
    setWritable(staging, false);
    /** @type {string | undefined} */
    let kept;
    if (occupied(canonical)) {
      let n = 1;
      while (occupied(`${canonical}.damaged-${n}`)) n += 1;
      kept = `${canonical}.damaged-${n}`;
      renameSync(canonical, kept);
    }
    renameSync(staging, canonical);
    if (kept !== undefined) console.log(kept);
    console.log(canonical);
  } catch (error) {
    if (staging !== undefined && occupied(staging)) {
      setWritable(staging, true);
      rmSync(staging, { recursive: true, force: true });
    }
    throw new Error(`${canonical}: cannot repair the workflow snapshot of ${commit} (${/** @type {Error} */ (error).message})`);
  }
}

/**
 * Parses settings bytes and returns their `hooks` value, throwing an Error naming `where` when they are not JSON.
 * @param {string} where
 * @param {Buffer} bytes
 * @returns {unknown}
 */
const settingsHooks = (where, bytes) => {
  try {
    return JSON.parse(bytes.toString('utf8')).hooks;
  } catch (error) {
    throw new Error(`${where}: cannot parse (${/** @type {Error} */ (error).message})`);
  }
};

/** CRLF and LF count as the same because a checkout writes LF as CRLF where `core.autocrlf` or an `eol` attribute asks; every other byte must match, compared in place so a copy of any size needs no second buffer. */
const sameLines = (/** @type {Buffer} */ a, /** @type {Buffer} */ b) => {
  let i = 0;
  let j = 0;
  for (;;) {
    if (a[i] === 0x0d && a[i + 1] === 0x0a) i++;
    if (b[j] === 0x0d && b[j + 1] === 0x0a) j++;
    if (i === a.length || j === b.length) return i === a.length && j === b.length;
    if (a[i] !== b[j]) return false;
    i++;
    j++;
  }
};

/**
 * Returns the shared contracts, as repository-relative paths, whose copy under `root` differs from the commit's or
 * cannot be read from either. The settings file is compared by its parsed `hooks` value, every other path by bytes, CRLF and LF counting as the same.
 * Throws an Error naming the settings copy that is not JSON.
 * @param {{ cwd: string, commit: string, root: string }} options
 * @returns {string[]}
 */
export function workflowDrift({ cwd, commit, root }) {
  return SHARED_CONTRACTS.filter((path) => {
    /** @type {Buffer} */
    let pinned;
    /** @type {Buffer} */
    let current;
    try {
      pinned = gitBytes(cwd, ['cat-file', 'blob', `${commit}:${path}`]);
      current = readFileSync(join(root, path));
    } catch {
      return true;
    }
    if (path !== SETTINGS) return !sameLines(pinned, current);
    return !isDeepStrictEqual(settingsHooks(`${commit}:${path}`, pinned), settingsHooks(join(root, path), current));
  });
}

/**
 * True only for the exact watcher cleanup `merge-watch.mjs <n>`: one argument, a pull request number.
 * @param {string[]} args
 * @returns {boolean}
 */
export const watchDriftAllowed = (args) => args.length === 1 && /^[1-9][0-9]*$/.test(args[0]);

/**
 * Returns the checkout a module runs from, `code`, and the checkout it acts on, `operating`. Code inside the store
 * `<common-dir>/fabraik-workflow/<commit>` operates on the checkout that owns the common directory; any other code
 * operates on its own checkout. Path arithmetic only.
 * @param {string} moduleUrl a module's `import.meta.url`, two directories below its checkout
 * @returns {{ code: string, operating: string }}
 */
export function workflowRoots(moduleUrl) {
  const code = dirname(dirname(dirname(fileURLToPath(moduleUrl))));
  const store = dirname(code);
  const pinned = basename(store) === STORE && COMMIT_ID.test(basename(code));
  return { code, operating: pinned ? dirname(dirname(store)) : code };
}

/**
 * Checks the job's pinned workflow root, `env.FABRAIK_WORKFLOW_ROOT`: it must be the canonical store path of the
 * commit it names and hold that commit's tree intact. With `drift`, it also refuses when a shared contract in the
 * checkout owning the common directory differs from the pinned commit's. Throws an Error naming the root and the
 * cause, or the recovery message when no root is recorded.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, drift: boolean }} options
 * @returns {{ commit: string, root: string }}
 */
export function verifyJobPin({ env, cwd, drift }) {
  const root = env.FABRAIK_WORKFLOW_ROOT;
  if (root === undefined || root === '') throw new Error('this job has no recorded workflow version; resume it through the coordinator');
  const common = commonDir(cwd);
  const commit = basename(root);
  const canonical = join(common, STORE, commit);
  /** @type {boolean} */
  let same;
  try {
    same = COMMIT_ID.test(commit) && realpathSync(root) === realpathSync(canonical);
  } catch (error) {
    throw new Error(`${root}: cannot resolve the workflow root or ${canonical} (${/** @type {Error} */ (error).message})`);
  }
  if (!same) throw new Error(`${root}: not the canonical workflow root ${canonical}`);
  verifyWorkflowSnapshot({ cwd, commit, dir: root });
  if (drift) {
    const drifted = workflowDrift({ cwd, commit, root: dirname(common) });
    if (drifted.length > 0) throw new Error(`${root}: the integration checkout's ${drifted.join(', ')} differ from ${commit}`);
  }
  return { commit, root };
}
