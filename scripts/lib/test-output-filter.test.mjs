// test-output-filter.test.mjs — the PreToolUse(Bash) test-output filter, end to end.
//
// The load-bearing case is the ANTI-REGRESSION one: a filter that condenses output must never
// let a RED run read as green, and must never touch the runner's exit status. So the red and
// green cases drive the FULL rewritten shell command through a POSIX shell, not the pure function alone.
//
// Recurring cost: ~1 s per suite run (three spawned sh/node runs over tiny fixtures).
// Removal condition: remove with the hook — see the price tag in .claude/hooks/filter-test-output.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { posixShell } from './posix-shell.mjs';
import { rewriteTestCommand, filterRunnerOutput } from './test-output-filter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The located POSIX shell: `sh` off Windows, Git for Windows' sh.exe on it, null when there is none.
// The rewritten command is plain POSIX, and a bare `bash` on Windows can resolve to WSL instead.
const SHELL = posixShell();

// Runs a rewritten command exactly as a Bash tool call would, and returns what reaches the agent.
function runRewritten(command) {
  const rewritten = rewriteTestCommand(command);
  assert.ok(rewritten, `expected ${command} to be rewritten`);
  // NODE_TEST_CONTEXT is inherited from THIS test process; leaving it set makes the nested
  // `node --test` skip its files with a recursion warning, so the case would prove nothing.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.ok(SHELL, 'a POSIX shell is required: install Git for Windows');
  const run = spawnSync(SHELL, ['-c', rewritten], { cwd: ROOT, encoding: 'utf8', env });
  return { status: run.status, surfaced: `${run.stdout}${run.stderr}` };
}

// A fixture path goes into a POSIX shell command, so it is single-quoted: a space (as in a Windows
// user folder like C:\Users\Jane Doe) stays one argument, and a Windows backslash stays literal.
const shQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// The temp folder name carries a space on purpose, so every platform exercises the quoting above.
function fixture(name, source) {
  const file = join(mkdtempSync(join(tmpdir(), 'workflow filter-')), name);
  writeFileSync(file, source);
  return file;
}

test('test output filtering condenses green runs, keeps red runs loud, and never touches exit status', async (t) => {
  await t.test('a red run surfaces the failing test name and error, and exits non-zero', () => {
    const file = fixture('red.test.mjs',
      "import { test } from 'node:test';\ntest('sentinel case that must stay visible', () => { throw new Error('boom-sentinel'); });\n");
    const { status, surfaced } = runRewritten(`node --test ${shQuote(file)}`);
    assert.notEqual(status, 0, `expected a non-zero exit, got ${status}`);
    assert.match(surfaced, /sentinel case that must stay visible/);
    assert.match(surfaced, /boom-sentinel/);
  });

  await t.test('a green run surfaces only the condensed summary, and exits 0', () => {
    const file = fixture('green.test.mjs',
      "import { test } from 'node:test';\ntest('per-test line that should be dropped', () => {});\n");
    const { status, surfaced } = runRewritten(`node --test ${shQuote(file)}`);
    assert.equal(status, 0, `expected a clean exit, got ${status}: ${surfaced}`);
    assert.match(surfaced, /\[test-output-filter\] green run condensed to summary; rerun without the hook for full output/);
    // The nested runner's reporter is environment-dependent (spec locally, TAP on CI), so the counts
    // are asserted in either condensed form; the unit subtests below pin each shape exactly.
    assert.match(surfaced, /^(?:ℹ|#) pass 1[ \t]*$/m);
    assert.match(surfaced, /^(?:ℹ|#) fail 0[ \t]*$/m);
    assert.doesNotMatch(surfaced, /✔ /);
    assert.doesNotMatch(surfaced, /^ok 1 - /m);
    assert.doesNotMatch(surfaced, /per-test line that should be dropped/);
  });

  await t.test('compound and non-runner commands are left alone', () => {
    for (const command of [
      'node --test a.test.mjs | tee out.txt',
      'node --test a.test.mjs > out.txt',
      'cd /repo && node --test a.test.mjs && echo done',
      'node --test $(ls)',
      'node --test `ls`',
      'cd /a && cd /b && node --test a.test.mjs',
      'git status',
      'echo "npm test"',
    ]) {
      assert.equal(rewriteTestCommand(command), null, `expected no rewrite for: ${command}`);
    }
  });

  await t.test('a line-separated command is never rewritten', () => {
    // A newline separates commands as surely as `;` does, and wrapping one would capture only the
    // last line's exit status — a red run reading green.
    for (const command of [
      'node --test failing.test.mjs\ntrue',
      'node --test failing.test.mjs\r\ntrue',
      'cd /repo &&\nnpm test',
      'cd\n/repo && npm test',
      'cd /repo\n&& npm test',
      'cd /repo &&\r\nnpm test',
    ]) {
      assert.equal(rewriteTestCommand(command), null, `expected no rewrite for: ${JSON.stringify(command)}`);
    }
  });

  await t.test('the repo\'s real runner shapes are rewritten and end by exiting the runner\'s status', () => {
    for (const command of [
      'node --test scripts/lib/board.test.mjs',
      'cd "/repo lane/741" && node --test --test-name-pattern="^x$" scripts/lib/board.test.mjs',
      'npx playwright test tests/kpis.spec.ts',
      'npm test',
      'npm run test:scripts',
      'npm run run-log -- focused scripts -- node --test scripts/lib/board.test.mjs',
      'npm run run-log -- browser evidence -- npx playwright test tests/kpis.spec.ts',
    ]) {
      const rewritten = rewriteTestCommand(command);
      assert.ok(rewritten, `expected a rewrite for: ${command}`);
      assert.ok(rewritten.endsWith('exit $__fg_status'), `rewrite must end by exiting the runner's status: ${rewritten}`);
    }
    assert.ok(rewriteTestCommand('cd "/repo lane/741" && npm test').startsWith('cd "/repo lane/741" && '));
  });

  await t.test('the workflow direct run-log command wraps only known runners without granting permission', () => {
    const direct = 'node scripts/run-log.mjs focused scripts -- node --test scripts/lib/board.test.mjs';
    const rewritten = rewriteTestCommand(direct);
    assert.ok(rewritten);
    assert.match(rewritten, /node scripts\/run-log\.mjs focused scripts -- node --test scripts\/lib\/board\.test\.mjs/);
    assert.ok(rewritten.endsWith('exit $__fg_status'));

    const hook = resolve(ROOT, '.claude/hooks/filter-test-output.mjs');
    const run = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_input: { command: direct, timeout: 600000 } }),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal('permissionDecision' in payload.hookSpecificOutput, false);
    assert.equal('permissionDecisionReason' in payload.hookSpecificOutput, false);
    assert.deepEqual(payload.hookSpecificOutput.updatedInput, {
      command: rewritten,
      timeout: 600000,
    });

    for (const command of [
      'node scripts/run-log.mjs suspicious\rlabel -- node --test scripts/lib/board.test.mjs',
      'node scripts/run-log.mjs suspicious\nlabel -- node --test scripts/lib/board.test.mjs',
      'node scripts/run-log.mjs `printf label` -- node --test scripts/lib/board.test.mjs',
      'node scripts/run-log.mjs $(printf label) -- node --test scripts/lib/board.test.mjs',
      'node scripts/run-log.mjs git state -- git status',
      'node scripts/run-log.mjs misleading -- echo node --test scripts/lib/board.test.mjs',
    ]) {
      assert.equal(rewriteTestCommand(command), null, `expected no rewrite for: ${JSON.stringify(command)}`);
    }
  });

  await t.test('a wrapped run-log runner is condensed as one command, while other run-log commands stay untouched', () => {
    const file = fixture('logged-green.test.mjs',
      "import { test } from 'node:test';\ntest('logged detail that should be dropped', () => {});\n");
    const fixtureDir = dirname(file);
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      scripts: { 'run-log': `node "${resolve(ROOT, 'scripts/run-log.mjs')}"` },
    }));
    const logged = `npm run run-log -- output filter green -- node --test ${shQuote(file)}`;
    const wrapped = `cd "${fixtureDir}" && ${logged}`;
    const rewritten = rewriteTestCommand(wrapped);
    assert.ok(rewritten?.includes(`${logged} >"$__fg_out" 2>&1`));
    const { status, surfaced } = runRewritten(wrapped);
    assert.equal(status, 0, surfaced);
    assert.match(surfaced, /green run condensed to summary/);
    assert.doesNotMatch(surfaced, /logged detail that should be dropped/);

    for (const command of [
      'npm run run-log -- git status -- git status',
      'npm run run-log -- missing child separator',
      'npm run run-log -- compound -- node --test a.test.mjs && echo done',
      'npm run run-log -- misleading -- echo node --test scripts/lib/board.test.mjs',
    ]) {
      assert.equal(rewriteTestCommand(command), null, `expected no rewrite for: ${command}`);
    }
  });

  await t.test('a TAP-format green run condenses to its TAP summary', () => {
    // CI and agent shells commonly get node's TAP reporter rather than the spec reporter, so this
    // drives the literal CI shape instead of the real runner (whose reporter is environment-dependent).
    const output = [
      'TAP version 13',
      '# Subtest: per-test line that should be dropped',
      'ok 1 - per-test line that should be dropped',
      '  ---',
      '  duration_ms: 0.512345',
      '  type: \'test\'',
      '  ...',
      '1..1',
      '# tests 1',
      '# suites 0',
      '# pass 1',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
      '# duration_ms 42.123456',
      '',
    ].join('\n');
    assert.equal(filterRunnerOutput(output, 0), [
      '[test-output-filter] green run condensed to summary; rerun without the hook for full output',
      '# tests 1',
      '# suites 0',
      '# pass 1',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
      '# duration_ms 42.123456',
      '',
    ].join('\n'));
  });

  await t.test('a spec-format green run condenses to its spec summary', () => {
    const output = [
      '✔ per-test line that should be dropped (0.512345ms)',
      'ℹ tests 1',
      'ℹ suites 0',
      'ℹ pass 1',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 42.123456',
      '',
    ].join('\n');
    assert.equal(filterRunnerOutput(output, 0), [
      '[test-output-filter] green run condensed to summary; rerun without the hook for full output',
      'ℹ tests 1',
      'ℹ suites 0',
      'ℹ pass 1',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 42.123456',
      '',
    ].join('\n'));
  });

  await t.test('a green run with no recognizable summary is surfaced unchanged', () => {
    const output = 'ran something\nno counts here\n';
    assert.equal(filterRunnerOutput(output, 0), output);
  });

  await t.test('the hook rewrites a runner command over stdin and stays silent otherwise', () => {
    const hook = resolve(ROOT, '.claude/hooks/filter-test-output.mjs');
    const command = 'node --test scripts/lib/board.test.mjs';
    const rewrite = spawnSync('node', [hook], {
      input: JSON.stringify({
        tool_input: {
          command,
          timeout: 600000,
          run_in_background: false,
          description: 'focused script tests',
          future_field: { nested: 1 },
        },
      }),
      encoding: 'utf8',
    });
    assert.equal(rewrite.status, 0);
    const payload = JSON.parse(rewrite.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal('permissionDecision' in payload.hookSpecificOutput, false);
    assert.equal('permissionDecisionReason' in payload.hookSpecificOutput, false);
    assert.deepEqual(payload.hookSpecificOutput.updatedInput, {
      command: rewriteTestCommand(command),
      timeout: 600000,
      run_in_background: false,
      description: 'focused script tests',
      future_field: { nested: 1 },
    });

    const untouched = spawnSync('node', [hook], {
      input: JSON.stringify({ tool_input: { command: 'git status' } }), encoding: 'utf8',
    });
    assert.equal(untouched.status, 0);
    assert.equal(untouched.stdout, '');
  });

  await t.test('the hook leaves suspicious quoted cd prefixes untouched for normal permission evaluation', () => {
    const hook = resolve(ROOT, '.claude/hooks/filter-test-output.mjs');
    for (const command of [
      'cd "$(printf /tmp)" && npm test',
      'cd "`printf /tmp`" && npm test',
      'cd "/tmp\nrepo" && npm test',
      'cd /tmp &&\nnpm test',
      'cd\n/tmp && npm test',
      'cd /tmp\n&& npm test',
      'cd /tmp &&\r\nnpm test',
    ]) {
      const run = spawnSync('node', [hook], {
        input: JSON.stringify({ tool_input: { command } }),
        encoding: 'utf8',
      });
      assert.equal(run.status, 0);
      assert.equal(run.stdout, '', `expected no rewrite for: ${JSON.stringify(command)}`);
    }
  });
});

// PreToolUse `updatedInput` REPLACES the whole tool input rather than merging into it, so an
// updatedInput carrying only `command` silently drops a long run's `timeout` back to the default.
test('the rewrite hook preserves every other Bash tool input field', () => {
  const hook = resolve(ROOT, '.claude/hooks/filter-test-output.mjs');
  const command = 'node --test scripts/lib/board.test.mjs';

  const known = spawnSync('node', [hook], {
    input: JSON.stringify({
      tool_input: { command, timeout: 600000, run_in_background: false, description: 'x' },
    }),
    encoding: 'utf8',
  });
  assert.equal(known.status, 0);
  const updated = JSON.parse(known.stdout).hookSpecificOutput.updatedInput;
  assert.deepEqual(Object.keys(updated).sort(), ['command', 'description', 'run_in_background', 'timeout']);
  assert.equal(updated.command, rewriteTestCommand(command));
  assert.equal(updated.timeout, 600000);
  assert.equal(updated.run_in_background, false);
  assert.equal(updated.description, 'x');

  const unknown = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_input: { command, sandbox: true, future_field: { nested: 1 } } }),
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 0);
  const carried = JSON.parse(unknown.stdout).hookSpecificOutput.updatedInput;
  assert.equal(carried.sandbox, true);
  assert.deepEqual(carried.future_field, { nested: 1 });
});
