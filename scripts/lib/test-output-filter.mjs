// test-output-filter.mjs — the pure logic behind .claude/hooks/filter-test-output.mjs
// (a PreToolUse(Bash) hook). A green test run tells the agent one thing — everything passed —
// but pays hundreds of per-test lines of context for it; a red run is worth every byte. So the
// hook rewrites a test-runner command to capture its output, then surfaces the SUMMARY on green
// and the WHOLE output on red. The runner's exit status is always the authoritative one.
//
// Both halves fail open: an un-rewritten command or an unrecognised summary just keeps today's
// cost, which is never a correctness problem. A dropped failure would be, so red is never touched.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute, so the rewrite still resolves after its optional `cd` prefix moves the working directory.
const RUNNER_WRAPPER = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks', 'test-output-filter-run.mjs',
);

const SUMMARY_NOTICE = '[test-output-filter] green run condensed to summary; rerun without the hook for full output';

// The rewrite wraps the command in its own redirects, so it is only safe on a SIMPLE invocation:
// any operator of the caller's own could bind differently once wrapped.
const COMPOUND = /[\r\n|;&<>`]|\$\(/;
const SUSPICIOUS_CD_PREFIX = /[\r\n`]|\$\(/;

// The runners worth intercepting — the shapes this repo actually runs.
const RUNNERS = [
  /^node\s+--test(\s|$)/,
  /^npx\s+playwright\s+test(\s|$)/,
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+test:\S+(\s|$)/,
];
const RUN_LOGS = [
  /^npm\s+run\s+run-log\s+--\s+(.+?)\s+--\s+(.+)$/,
  /^node\s+scripts\/run-log\.mjs\s+(.+?)\s+--\s+(.+)$/,
];

// One optional `cd <path> && ` prefix is preserved verbatim; the path may be quoted or bare.
const CD_PREFIX = /^cd\s+("[^"]*"|'[^']*'|[^\s'"|;&<>$`()]+)\s+&&\s+/;

const NODE_SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
// Node picks its reporter by environment: a terminal gets the spec reporter's `ℹ` counts, while
// agent shells and CI commonly get the TAP reporter's `# ` counts for the same summary.
const TAP_SUMMARY = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
const PLAYWRIGHT_SUMMARY = /^\s*\d+\s+(passed|failed|skipped|flaky|did not run)\b/;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Returns the rewritten command, or null when the command must run untouched.
export function rewriteTestCommand(command) {
  const raw = (command ?? '').trim();
  const cd = raw.match(CD_PREFIX);
  if (cd && SUSPICIOUS_CD_PREFIX.test(cd[0])) return null;
  const runner = cd ? raw.slice(cd[0].length) : raw;
  if (COMPOUND.test(runner)) return null;
  const logged = RUN_LOGS.map((pattern) => runner.match(pattern)).find(Boolean);
  const executable = logged ? logged[2] : runner;
  if (!RUNNERS.some((pattern) => pattern.test(executable))) return null;
  // `exit $__fg_status` is unconditional and last, so nothing the filter does — including
  // crashing — can mask what the runner decided.
  return `${cd ? cd[0] : ''}__fg_out=$(mktemp); ${runner} >"$__fg_out" 2>&1; __fg_status=$?; `
    + `node ${shellQuote(RUNNER_WRAPPER)} "$__fg_out" "$__fg_status"; rm -f "$__fg_out"; exit $__fg_status`;
}

// Returns the text to surface for a run that exited with `exitStatus`.
export function filterRunnerOutput(outputText, exitStatus) {
  const text = outputText ?? '';
  if (Number(exitStatus) !== 0) return text;
  const lines = text.split('\n');
  const spec = lines.filter((line) => NODE_SUMMARY.test(line) || PLAYWRIGHT_SUMMARY.test(line));
  const summary = spec.length > 0 ? spec : lines.filter((line) => TAP_SUMMARY.test(line));
  // No recognised summary means an unknown reporter, not a run that produced nothing — surfacing
  // a bare notice there would read as "nothing ran".
  if (summary.length === 0) return text;
  return `${[SUMMARY_NOTICE, ...summary].join('\n')}\n`;
}
