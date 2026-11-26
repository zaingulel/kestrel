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
// The fixed `scope=root` field immediately before state means the command cwd and the successfully read Git
// top-level resolve to the same physical path; otherwise `scope=unknown` prevents receipt reuse.
// Hooks reuse applicable root-scoped local receipts; the script keeps no separate state between runs.
// Child start/completion are UTC; elapsedMs uses a monotonic clock and excludes Git snapshots.
// RUN_LOG_RERUN_REASON is explicit caller context, never inferred from the log.
// The command runs with TMPDIR, TMP and TEMP set to a run folder of its own (run-folder.mjs names it). Afterwards
// run-log stops (on Linux) every process still carrying that folder, removes it and records `temp=<state>` before
// scope: `empty`, `cleared-<E>` (E top-level entries removed), either followed by `-stopped-<P>` when P processes
// were stopped and by `-unchecked` where no process scan exists; `failed-<CODE>` when the folder or a process
// carrying it was kept; `unavailable-<CODE>` when no folder could be made and the command ran with the inherited
// environment. A command that exited 0 exits 1 instead when the state is failed or unavailable, or when
// RUN_LOG_TEMP=strict and it left anything (any state but `empty` and `empty-unchecked`); the leftovers are named and
// the receipt then reads `exit 1`. Strict mode also turns Node's compile cache off unless NODE_COMPILE_CACHE names
// its location, since the cache would otherwise land in the run folder.
// The command-line entry block's SIGINT and SIGHUP recorders, registered before preparation starts, keep the logger
// alive through an interrupt. An interrupt during preparation stops the run before the command: one that ends a Git
// call of preparation, whether it reached the whole process group, such as a terminal's Ctrl-C, or that Git call
// alone, ends preparation, and one reaching the logger alone is seen one event-loop turn after preparation. Either way
// the logger removes what it made, starts no command, writes no receipt and ends by that signal. One arriving after
// that turn and before the command starts, or while the command runs, lets the command run to its end; the logger
// clears the folder and writes the receipt, then ends by that signal. SIGTERM keeps its default.
// Importing the module runs nothing: `main` returns `{ exitCode, signal }`, and only the command line exits or
// re-raises the signal, so a caller in the same process is never killed. A signal Node ignores, such as SIGPIPE,
// survives the re-raise, so the command line then exits with 128 plus the signal number instead.

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processesUsing, runFolderPrefix, stopProcesses } from './lib/run-folder.mjs';

// Output of a git command, or null when git is missing or the command fails.
function git(run, gitArgs) {
  const result = run('git', gitArgs, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : result.stdout;
}

// 16 hex characters fingerprinting the working tree's content: the tree id git writes for a throwaway copy of the
// index after raw-policy adds. The real index and working tree are never touched, but loose blobs and trees reach the
// object store. Git itself decides names, modes and ignore rules, and staging cannot change the result.
// Raw bytes are hashed: the adds run with autocrlf off and the empty tree as attribute source, so no line-ending
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
    const rawAdd = ['-c', 'core.autocrlf=false', `--attr-source=${emptyTree.stdout.trim()}`, 'add'];
    // Rehash normalized cached blobs before add-all can reuse them.
    if (run('git', [...rawAdd, '--renormalize', ':/'], options).status !== 0) return null;
    if (run('git', [...rawAdd, '-A'], options).status !== 0) return null;
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

export const worklogFileName = (branch) => `${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.md`;

function worklogLocation(run, cwd) {
  const branch = git(run, ['branch', '--show-current'])?.trim() || 'detached';
  const root = git(run, ['rev-parse', '--show-toplevel'])?.trim();
  return { logFile: join(root || cwd, '.claude', 'worklog', worklogFileName(branch)), root };
}

// A receipt line's decoded fields, or null when it is not a whole valid receipt of this writer. The command is decoded
// from the writer's final fixed fields, so permitted label delimiters cannot supply it; the label is what lies before them.
export function parseReceipt(line) {
  const receipt = /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| (.*) \| `([^`]*)` \| (exit -?\d+|spawn failed \([^)]*\)|killed by [A-Z0-9]+) \| completed=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \| elapsedMs=([0-9]+(?:\.[0-9]+)?(?:e[+-]?\d+)?) \| rerunReason=`([^`]*)` \| (?:temp=[A-Za-z0-9_-]+ \| )?scope=root \| head=(\S+) tree=(\S+) diff=(\S+)$/.exec(line);
  if (!receipt) return null;
  try {
    const command = JSON.parse(receipt[2]);
    const reason = JSON.parse(receipt[6]);
    if (!Array.isArray(command) || !command.every((arg) => typeof arg === 'string') ||
        !(reason === null || typeof reason === 'string') || !Number.isFinite(Number(receipt[5]))) return null;
    return { label: receipt[1], command, outcome: receipt[3], completed: receipt[4], head: receipt[7], tree: receipt[8], diff: receipt[9] };
  } catch {
    return null;
  }
}

function receiptChecks(text, state, allowDirty, cwd) {
  if (!text.endsWith('\n')) return { lint: false, scripts: false };
  let lint = false;
  let scripts = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ') || !line.includes(' | ')) continue;
    const receipt = parseReceipt(line);
    if (!receipt) {
      lint = scripts = false;
      continue;
    }
    const argv = JSON.stringify(receipt.command);
    const isLint = argv === '["npm","run","lint"]';
    let isScripts = argv === '["node","--test","--test-concurrency=2","scripts/lib/*.test.mjs"]';
    if (argv === '["npm","run","test:scripts"]') {
      try {
        isScripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))?.scripts?.['test:scripts'] ===
          'node --test --test-concurrency=2 "scripts/lib/*.test.mjs"';
      } catch {
        isScripts = false;
      }
    }
    const applicable = receipt.outcome === 'exit 0' && receipt.head === state.head &&
      (state.status === '' ? receipt.tree === 'clean' && receipt.diff === 'none' :
        allowDirty && receipt.tree === 'dirty' && receipt.diff === state.diff);
    if (isLint) lint = applicable;
    if (isScripts) scripts = applicable;
  }
  return { lint, scripts };
}

export function reusableLocalChecks({ allowDirty = false, cwd = process.cwd(), env = process.env, spawnSync: spawn = spawnSync } = {}) {
  const run = (file, args, options) => spawn(file, args, { cwd, env, ...options });
  const before = snapshot(run, env);
  let checks = { lint: false, scripts: false };
  try {
    checks = receiptChecks(readFileSync(worklogLocation(run, cwd).logFile, 'utf8'), before, allowDirty, cwd);
  } catch {
    // Missing or unreadable evidence retains the hook's real verification fallback.
  }
  const after = snapshot(run, env);
  if (!before.head || before.head !== after.head || before.diff === null || before.diff !== after.diff) {
    return { head: null, lint: false, scripts: false };
  }
  return { head: before.head, ...checks };
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

// The command's environment: a copy of `env` whose temporary-folder variables, in any letter case, name `folder`.
// In strict mode without an explicit NODE_COMPILE_CACHE the compile cache is off, since a cache inside the run folder
// would fail the run; otherwise the command's own compile cache setting is left as it is.
function runFolderEnv(env, folder, strict) {
  const kept = Object.entries(env).filter(([key]) => !['TMPDIR', 'TMP', 'TEMP'].includes(key.toUpperCase()));
  const cacheOff = strict && !env.NODE_COMPILE_CACHE ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {};
  return { ...Object.fromEntries(kept), ...cacheOff, TMPDIR: folder, TMP: folder, TEMP: folder };
}

const LEFTOVERS_SHOWN = 20;

// Stops the processes still carrying `folder`, then removes it. Returns the receipt state and, when anything was
// left or kept, what to name.
function clearRunFolder(folder, platform) {
  const scan = () => processesUsing(folder, { platform });
  const carriers = scan();
  const unchecked = carriers === 'unchecked';
  const { stopped, survivors } = unchecked || !carriers.length ? { stopped: [], survivors: [] } : stopProcesses(carriers, { processesUsing: scan });
  let names = [];
  try {
    names = readdirSync(folder);
    if (survivors.length) return { state: 'failed-RUNNING', names, survivors };
    rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    return { state: `failed-${/** @type {NodeJS.ErrnoException} */ (error)?.code ?? 'UNKNOWN'}`, names, survivors };
  }
  const state = `${names.length ? `cleared-${names.length}` : 'empty'}${stopped.length ? `-stopped-${stopped.length}` : ''}${unchecked ? '-unchecked' : ''}`;
  return { state, names, survivors };
}

// Everything before the command starts: arguments, receipt location, the snapshot before, the run folder and the
// command's environment. Returns `{ finished }`, the result to end with, for a refused invocation or one whose Git
// call an interrupt ended (its run folder then removed), else the state `launch` needs. `env` defaults to process.env
// itself, never a copy: a copy loses Windows' case-insensitive Path. Only the command gets a copy, to point its
// temporary-folder variables at the run folder.
function prepare(args = process.argv.slice(2), dependencies = {}) {
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
  // Preparation's own calls record the first interrupt that ends a Git call. Once one is recorded, later calls spawn
  // nothing and return a failed call's result with empty output, so preparation reaches its interrupt check.
  let interrupt;
  const prepRun = (file, fileArgs, options) => {
    if (interrupt) return { status: null, signal: interrupt, stdout: '' };
    const result = run(file, fileArgs, options);
    if (file === 'git' && (result.signal === 'SIGINT' || result.signal === 'SIGHUP')) interrupt = result.signal;
    return result;
  };

  const separator = args.indexOf('--');
  if (separator < 1 || separator === args.length - 1 || args[separator + 1] === '') {
    output.error('usage: node scripts/run-log.mjs <label words> -- <command> [args...]');
    return { finished: { exitCode: 2 } };
  }
  const label = args.slice(0, separator).join(' ');
  // eslint-disable-next-line no-control-regex -- receipt labels must reject every control character.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(label)) {
    output.error('run-log: label must not contain control characters or line separators');
    return { finished: { exitCode: 2 } };
  }
  const command = args.slice(separator + 1);
  const rerunReason = env.RUN_LOG_RERUN_REASON ?? null;
  if (rerunReason !== null && !rerunReason.trim()) {
    output.error('run-log: RUN_LOG_RERUN_REASON must be nonblank when supplied');
    return { finished: { exitCode: 2 } };
  }
  const tempMode = env.RUN_LOG_TEMP;
  if (tempMode !== undefined && tempMode !== 'strict') {
    output.error('run-log: RUN_LOG_TEMP must be strict when supplied');
    return { finished: { exitCode: 2 } };
  }

  const { logFile, root } = worklogLocation(prepRun, cwd);
  let scope = 'unknown';
  try {
    if (root && realpathSync.native(cwd) === realpathSync.native(root)) scope = 'root';
  } catch {
    // An unreadable physical path cannot establish repository-root execution.
  }

  const [file, ...fileArgs] = spawnArgv(command, { run: prepRun, env, platform });
  const before = snapshot(prepRun, env);
  let identity = root || cwd;
  try {
    identity = realpathSync.native(identity);
  } catch {
    // An unresolvable path still names its run folders consistently by its own spelling.
  }
  let folder;
  let unavailable;
  try {
    folder = mkdtempSync(join(tmpdir(), runFolderPrefix(identity)));
  } catch (error) {
    unavailable = `unavailable-${/** @type {NodeJS.ErrnoException} */ (error)?.code ?? 'UNKNOWN'}`;
  }
  if (interrupt) {
    abandon({ folder });
    return { finished: { exitCode: 128 + constants.signals[interrupt], signal: interrupt } };
  }
  const commandEnv = folder ? runFolderEnv(env, folder, tempMode === 'strict') : env;
  return { run, env, platform, now, hrtime, output, label, command, rerunReason, tempMode, logFile, scope, file, fileArgs, before, folder, unavailable, commandEnv };
}

// Removes the run folder `prepare` made, if any; writes nothing.
function abandon({ folder }) {
  if (folder) rmSync(folder, { recursive: true, force: true });
}

// Runs the command, clears its run folder and appends the receipt; returns `{ exitCode, signal }`.
function launch(prepared) {
  const { run, env, platform, now, hrtime, output, label, command, rerunReason, tempMode, logFile, scope, file, fileArgs, before, folder, unavailable, commandEnv } = prepared;
  const started = now().toISOString();
  const startedTick = hrtime();
  const result = run(file, fileArgs, { stdio: 'inherit', shell: false, env: commandEnv });
  const elapsedMs = Number(hrtime() - startedTick) / 1e6;
  const completed = now().toISOString();
  const cleared = folder ? clearRunFolder(folder, platform) : { state: /** @type {string} */ (unavailable), names: [], survivors: [] };
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
  const kept = /^(failed|unavailable)-/.test(cleared.state);
  if (kept || (tempMode === 'strict' && cleared.state !== 'empty' && cleared.state !== 'empty-unchecked')) {
    const shown = cleared.names.slice(0, LEFTOVERS_SHOWN).join(', ');
    const more = cleared.names.length > LEFTOVERS_SHOWN ? ` and ${cleared.names.length - LEFTOVERS_SHOWN} more` : '';
    output.error(`run-log: temporary folder ${folder ?? '(none)'} ${cleared.state}${shown ? `; left: ${shown}${more}` : ''}${cleared.survivors.length ? `; still running: ${cleared.survivors.join(', ')}` : ''}`);
    // The receipt records the failure run-log returns, so a hook never reuses it as a pass.
    if (exitCode === 0) {
      exitCode = 1;
      outcome = 'exit 1';
    }
  }
  const state = renderState(before, snapshot(run, env));
  const recordedCommand = escapeReceiptField(command);
  const recordedReason = escapeReceiptField(rerunReason);
  const line = `- ${started} | ${label} | \`${recordedCommand}\` | ${outcome} | completed=${completed} | elapsedMs=${elapsedMs} | rerunReason=\`${recordedReason}\` | temp=${cleared.state} | scope=${scope} | ${state}`;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`);
    output.log(line);
  } catch (error) {
    output.error(`run-log: could not write receipt (${/** @type {NodeJS.ErrnoException} */ (error)?.code ?? /** @type {NodeJS.ErrnoException} */ (error)?.message ?? error})`);
    if (exitCode === 0) exitCode = 1;
  }
  return { exitCode, signal };
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const prepared = prepare(args, dependencies);
  return prepared.finished ?? launch(prepared);
}

// Both sides through realpath: Node loads a symlinked entry by its real path, and a mismatch would exit 0 with no receipt. An entry that is not a file, such as standard input, is never this module.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // Recorders stay registered from before preparation until after the receipt, so an interrupt never ends the logger
  // mid-preparation or before the receipt, and the fingerprint's scratch folder is always removed. An interrupt that
  // ends a Git call of preparation finishes the run there, with that signal. Preparation is synchronous, so one
  // event-loop turn after it delivers a signal that reached the logger meanwhile: the logger then abandons the run.
  // spawnSync cannot forward a signal sent to the logger alone, so one arriving after that turn lets the command run to
  // its end; the logger clears its folder, writes its receipt, then ends by that signal, which a further turn delivers.
  let received;
  const record = (name) => {
    received ??= name;
  };
  process.on('SIGINT', record);
  process.on('SIGHUP', record);
  const prepared = prepare();
  await new Promise((resolve) => setImmediate(resolve));
  let exitCode;
  let resultSignal;
  if (prepared.finished) ({ exitCode, signal: resultSignal } = prepared.finished);
  else if (received) abandon(prepared);
  else {
    ({ exitCode, signal: resultSignal } = launch(prepared));
    await new Promise((resolve) => setImmediate(resolve));
  }
  process.off('SIGINT', record);
  process.off('SIGHUP', record);
  const signal = resultSignal ?? received;
  if (signal) {
    process.kill(process.pid, signal);
    process.exit(128 + constants.signals[signal]);
  }
  process.exit(exitCode);
}
