#!/usr/bin/env node
// Prints what a filtered test run should surface: argv is the captured-output file and the
// runner's exit status. Only invoked from the command rewrite in scripts/lib/test-output-filter.mjs,
// which owns the decision logic; this file is the wire. It never exits non-zero — the runner's
// status is carried by the rewrite itself, and a filter that failed must still show the raw output.
//
// Recurring cost: one node process + one temp file per intercepted test run (sub-second).
// Removal condition: remove when the agent harness filters runner output natively, or when the
// hook is retired from .claude/settings.json.
import { readFileSync } from 'node:fs';
import { filterRunnerOutput } from '../../scripts/lib/test-output-filter.mjs';

const [outputFile, exitStatus] = process.argv.slice(2);
let raw = '';
try {
  raw = readFileSync(outputFile, 'utf8');
} catch (err) {
  console.error(`test-output-filter: could not read captured test output at ${outputFile} (${err.message}) — the run's own exit status still stands.`);
  process.exit(0);
}
try {
  process.stdout.write(filterRunnerOutput(raw, exitStatus));
} catch {
  process.stdout.write(raw);
}
