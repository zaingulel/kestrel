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
// The state field `head=<H> tree=<T>` is sampled before and after the command: H is the commit, or
// `<before>-><after>` when it moved; T is `clean` only when both samples were clean against a known
// commit, `dirty` when either had changes (untracked files included), and `unknown` otherwise, so an
// unreadable state never reads as clean.
// Nothing else reads the log, and the script keeps nothing between runs.
// Child start/completion are UTC; elapsedMs uses a monotonic clock and excludes Git snapshots.
// RUN_LOG_RERUN_REASON is explicit caller context, never inferred from the log.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 1 || separator === args.length - 1) {
  console.error('usage: node scripts/run-log.mjs <label words> -- <command> [args...]');
  process.exit(2);
}
const label = args.slice(0, separator).join(' ');
const command = args.slice(separator + 1);
const rerunReason = process.env.RUN_LOG_RERUN_REASON ?? null;
if (rerunReason !== null && !rerunReason.trim()) {
  console.error('run-log: RUN_LOG_RERUN_REASON must be nonblank when supplied');
  process.exit(2);
}

// Output of a git command, or null when git is missing or the command fails.
function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? null : result.stdout;
}

function snapshot() {
  const head = git(['rev-parse', '--verify', 'HEAD'])?.trim();
  return {
    head: /^[0-9a-f]{40}$/.test(head) ? head : null,
    status: git(['status', '--porcelain', '--untracked-files=normal']),
  };
}

function renderState(before, after) {
  let head = 'unknown';
  if (before.head && after.head) head = before.head === after.head ? before.head : `${before.head}->${after.head}`;
  let tree = 'unknown';
  if (head !== 'unknown' && before.status !== null && after.status !== null) {
    tree = before.status || after.status ? 'dirty' : 'clean';
  }
  return `head=${head} tree=${tree}`;
}

// The argv actually spawned: on Windows bare npm/npx run npm's CLI as the first npm.cmd/npx.cmd on PATH does,
// preferring the one under the global prefix the last line of its npm-prefix.js names, else the one beside it;
// anything else, or no CLI in either place, is spawned unchanged.
function spawnArgv(argv) {
  const tool = argv[0].toLowerCase();
  if (process.platform !== 'win32' || (tool !== 'npm' && tool !== 'npx')) return argv;
  const cliPath = (base) => join(base, 'node_modules', 'npm', 'bin', `${tool}-cli.js`);
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!dir || !existsSync(join(dir, `${tool}.cmd`))) continue;
    const prefixJs = join(dir, 'node_modules', 'npm', 'bin', 'npm-prefix.js');
    if (existsSync(prefixJs)) {
      const prefix = spawnSync(process.execPath, [prefixJs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

const branch = git(['branch', '--show-current'])?.trim() || 'detached';
const root = git(['rev-parse', '--show-toplevel'])?.trim() || process.cwd();
const dir = join(root, '.claude', 'worklog');
const logFile = join(dir, `${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.md`);

const [file, ...fileArgs] = spawnArgv(command);
const before = snapshot();
const started = new Date().toISOString();
const startedTick = process.hrtime.bigint();
const result = spawnSync(file, fileArgs, { stdio: 'inherit', shell: false });
const elapsedMs = Number(process.hrtime.bigint() - startedTick) / 1e6;
const completed = new Date().toISOString();
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
const state = renderState(before, snapshot());
const recordedCommand = escapeReceiptField(command);
const recordedReason = escapeReceiptField(rerunReason);
const line = `- ${started} | ${label} | \`${recordedCommand}\` | ${outcome} | completed=${completed} | elapsedMs=${elapsedMs} | rerunReason=\`${recordedReason}\` | ${state}`;
try {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logFile, `${line}\n`);
  console.log(line);
} catch (error) {
  console.error(`run-log: could not write receipt (${error?.code ?? error?.message ?? error})`);
  if (exitCode === 0) exitCode = 1;
}
if (signal) process.kill(process.pid, signal);
process.exit(exitCode);
