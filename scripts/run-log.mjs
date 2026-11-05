// run-log.mjs — run a command and append what happened to the branch's work log.
//
//   node scripts/run-log.mjs <label words> -- <command> [args...]
//
// The label is plain unquoted words; the first bare `--` ends it.
//
// The log lives at .claude/worklog/<branch>.md (gitignored, machine-local). Each line records
// the time, the label, the exact argument vector, the exit code the command actually returned, and
// the git state it ran against, so the evidence section of a pull request can quote lines a script
// wrote rather than lines a model asserted. A command that could not be started at all is
// logged as `spawn failed (<code>)` and exits 127, so it can never read as a red run.
// On Windows a `.cmd` shim cannot start without a shell, so bare `npm`/`npx` are started through the
// running Node and the npm CLI the first `npm.cmd`/`npx.cmd` on PATH would pick, the one under npm's
// global prefix when it exists, else the one beside the shim; the receipt still records the command as written.
// No other shim is resolved: a package binary such as `eslint` is run as `npx <binary>`, and a bare one is a
// spawn failure there.
// The state field `head=<H> tree=<T> diff=<D>` is sampled before and after the command: H is the commit, or
// `<before>-><after>` when it moved; T is `clean` only when both samples were clean against a known
// commit, `dirty` when either had changes (untracked files included), and `unknown` otherwise, so an
// unreadable state never reads as clean. D fingerprints the uncommitted changes, staged or not, and
// untracked files by content (gitignored files excluded): `none` for a clean tree, `unknown` when T is
// `unknown` or git could not be read, else 16 hex characters, `<before>-><after>` when they differ. D is the tree
// id of a throwaway copy of the index with everything added, so the real index and working tree stay untouched.
// It fingerprints raw bytes: no line-ending or filter conversion applies.
// Nothing else reads the log, and the script keeps nothing between runs.
// Child start/completion are UTC; elapsedMs uses a monotonic clock and excludes Git snapshots.
// RUN_LOG_RERUN_REASON is explicit caller context, never inferred from the log.
// Importing the module runs nothing: `main` returns `{ exitCode, signal }`, and only the command line exits or
// re-raises the signal, so a caller in the same process is never killed. A signal Node ignores, such as SIGPIPE,
// survives the re-raise, so the command line then exits with 128 plus the signal number instead.

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Output of a git command, or null when git is missing or the command fails.
function git(run, gitArgs) {
  const result = run('git', gitArgs, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : result.stdout;
}

// 16 hex characters fingerprinting the working tree's content: the tree id git writes for a throwaway copy of the
// index after `git add -A`. The real index and working tree are never touched, but loose blobs and trees reach the
// object store. Git itself decides names, modes and ignore rules, and staging cannot change the result.
// Raw bytes are hashed: the add runs with autocrlf off and the empty tree as attribute source, so no line-ending
// normalization applies. The empty tree id is read from git because it depends on the repository's hash algorithm.
// The empty tree switches off the repository's own .gitattributes only; a user-wide attributes file and
// .git/info/attributes still apply their conversions.
// Null when git cannot be read, and with git older than 2.41, which rejects --attr-source.
function fingerprint(run, env) {
  const indexPath = git(run, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim();
  if (!indexPath) return null;
  const emptyTree = run('git', ['hash-object', '-t', 'tree', '--stdin'], { encoding: 'utf8', input: '' });
  if (emptyTree.error || emptyTree.status !== 0) return null;
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'run-log-index-'));
    const copy = join(scratch, 'index');
    if (existsSync(indexPath)) copyFileSync(indexPath, copy);
    const options = { encoding: 'utf8', env: { ...env, GIT_INDEX_FILE: copy } };
    if (run('git', ['-c', 'core.autocrlf=false', `--attr-source=${emptyTree.stdout.trim()}`, 'add', '-A'], options).status !== 0) return null;
    const tree = run('git', ['write-tree'], options);
    return tree.error || tree.status !== 0 ? null : tree.stdout.trim().slice(0, 16);
  } catch {
    return null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function snapshot(run, env) {
  const head = git(run, ['rev-parse', '--verify', 'HEAD'])?.trim();
  const status = git(run, ['status', '--porcelain', '--untracked-files=normal']);
  return {
    head: /^[0-9a-f]{40}$/.test(head) ? head : null,
    status,
    diff: status === '' ? 'none' : status === null ? null : fingerprint(run, env),
  };
}

function renderState(before, after) {
  let head = 'unknown';
  if (before.head && after.head) head = before.head === after.head ? before.head : `${before.head}->${after.head}`;
  let tree = 'unknown';
  let diff = 'unknown';
  if (head !== 'unknown' && before.status !== null && after.status !== null) {
    tree = before.status || after.status ? 'dirty' : 'clean';
    if (before.diff !== null && after.diff !== null) diff = before.diff === after.diff ? before.diff : `${before.diff}->${after.diff}`;
  }
  return `head=${head} tree=${tree} diff=${diff}`;
}

// The argv actually spawned: on Windows bare npm/npx run npm's CLI as the first npm.cmd/npx.cmd on PATH does,
// preferring the one under the global prefix the last line of its npm-prefix.js names, else the one beside it;
// anything else, or no CLI in either place, is spawned unchanged.
function spawnArgv(argv, { run, env, platform }) {
  const tool = argv[0].toLowerCase();
  if (platform !== 'win32' || (tool !== 'npm' && tool !== 'npx')) return argv;
  const cliPath = (base) => join(base, 'node_modules', 'npm', 'bin', `${tool}-cli.js`);
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!dir || !existsSync(join(dir, `${tool}.cmd`))) continue;
    const prefixJs = join(dir, 'node_modules', 'npm', 'bin', 'npm-prefix.js');
    if (existsSync(prefixJs)) {
      const prefix = run(process.execPath, [prefixJs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = prefix.error ? undefined : prefix.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
      if (line && existsSync(cliPath(line))) return [process.execPath, cliPath(line), ...argv.slice(1)];
    }
    return existsSync(cliPath(dir)) ? [process.execPath, cliPath(dir), ...argv.slice(1)] : argv;
  }
  return argv;
}

function escapeReceiptField(value) {
  return JSON.stringify(value).replace(/[`|<>&\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// `env` defaults to process.env itself, never a copy: a copy loses Windows' case-insensitive Path.
export function main(args = process.argv.slice(2), dependencies = {}) {
  const {
    spawnSync: spawn = spawnSync,
    env = process.env,
    cwd = process.cwd(),
    platform = process.platform,
    now = () => new Date(),
    hrtime = () => process.hrtime.bigint(),
    output = console,
  } = dependencies;
  const run = (file, fileArgs, options) => spawn(file, fileArgs, { cwd, env, ...options });

  const separator = args.indexOf('--');
  if (separator < 1 || separator === args.length - 1) {
    output.error('usage: node scripts/run-log.mjs <label words> -- <command> [args...]');
    return { exitCode: 2 };
  }
  const label = args.slice(0, separator).join(' ');
  const command = args.slice(separator + 1);
  const rerunReason = env.RUN_LOG_RERUN_REASON ?? null;
  if (rerunReason !== null && !rerunReason.trim()) {
    output.error('run-log: RUN_LOG_RERUN_REASON must be nonblank when supplied');
    return { exitCode: 2 };
  }

  const branch = git(run, ['branch', '--show-current'])?.trim() || 'detached';
  const root = git(run, ['rev-parse', '--show-toplevel'])?.trim() || cwd;
  const dir = join(root, '.claude', 'worklog');
  const logFile = join(dir, `${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.md`);

  const [file, ...fileArgs] = spawnArgv(command, { run, env, platform });
  const before = snapshot(run, env);
  const started = now().toISOString();
  const startedTick = hrtime();
  const result = run(file, fileArgs, { stdio: 'inherit', shell: false });
  const elapsedMs = Number(hrtime() - startedTick) / 1e6;
  const completed = now().toISOString();
  let outcome;
  let exitCode;
  let signal;
  if (result.error) {
    outcome = `spawn failed (${result.error.code ?? result.error.message})`;
    exitCode = 127;
  } else if (result.status === null) {
    outcome = `killed by ${result.signal}`;
    signal = result.signal;
  } else {
    outcome = `exit ${result.status}`;
    exitCode = result.status;
  }
  const state = renderState(before, snapshot(run, env));
  const recordedCommand = escapeReceiptField(command);
  const recordedReason = escapeReceiptField(rerunReason);
  const line = `- ${started} | ${label} | \`${recordedCommand}\` | ${outcome} | completed=${completed} | elapsedMs=${elapsedMs} | rerunReason=\`${recordedReason}\` | ${state}`;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(logFile, `${line}\n`);
    output.log(line);
  } catch (error) {
    output.error(`run-log: could not write receipt (${error?.code ?? error?.message ?? error})`);
    if (exitCode === 0) exitCode = 1;
  }
  return { exitCode, signal };
}

// Both sides through realpath: Node loads a symlinked entry by its real path, and a mismatch would exit 0 with no receipt. An entry that is not a file, such as standard input, is never this module.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { exitCode, signal } = main();
  if (signal) {
    process.kill(process.pid, signal);
    process.exit(128 + constants.signals[signal]);
  }
  process.exit(exitCode);
}
