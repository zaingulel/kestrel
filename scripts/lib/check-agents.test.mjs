// check-agents.test.mjs — the silent-drop classes the agent-definition guard catches.
// Each blocking case goes green if its rule is removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgentSource, checkCodexAgentSource, checkAgentsDir, checkBuilderParity, checkCharterParity, checkSeatPolicy } from './check-agents.mjs';
import { presentRuntimes, SEATS } from './runtimes.mjs';

const PRESENT = presentRuntimes('.');
const without = (runtime) => !PRESENT.includes(runtime) && `the settings file names no ${runtime} runtime`;

const GOOD_MD = `---
name: reviewer
description: "Adversarial pre-merge review: correctness, honesty, dead code."
model: opus
effort: xhigh
maxTurns: 90
tools: Read, Glob, Grep, Bash
---
You review the diff.
`;

const GOOD_TOML = `name = "reviewer"
description = "Adversarial pre-merge review"
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"
developer_instructions = """
You review the diff.
"""
`;

test('a well-formed Claude agent is clean', () => {
  assert.deepEqual(checkAgentSource('reviewer.md', GOOD_MD), []);
});

test('a missing or unclosed frontmatter fence is a named problem', () => {
  assert.match(checkAgentSource('reviewer.md', GOOD_MD.replace(/^---\n/, ''))[0], /no frontmatter fence/);
  assert.match(checkAgentSource('reviewer.md', GOOD_MD.replace(/\n---\nYou/, '\nYou'))[0], /never closes/);
});

test('an unquoted colon inside a plain scalar is the reviewer-vanished bug class', () => {
  const bad = GOOD_MD.replace('description: "Adversarial pre-merge review: correctness, honesty, dead code."', 'description: Adversarial review: correctness');
  assert.match(checkAgentSource('reviewer.md', bad).join('\n'), /unquoted colon/);
});

test('a block scalar may contain colons freely, and a plain key after it is still parsed', () => {
  const block = GOOD_MD.replace('description: "Adversarial pre-merge review: correctness, honesty, dead code."\n', 'description: |\n  Read: the diff first.\n  Then: never review against the description.\ncolor: purple\n');
  assert.deepEqual(checkAgentSource('reviewer.md', block), []);
  // The same colon lines outside a block scalar are the silent-drop class.
  const plain = GOOD_MD.replace('description: "Adversarial pre-merge review: correctness, honesty, dead code."', 'description: Read: the diff first.');
  assert.match(checkAgentSource('reviewer.md', plain).join('\n'), /unquoted colon inside `description:`/);
});

test('an initialPrompt frontmatter key is a named problem: it never reaches a subagent', () => {
  const bad = GOOD_MD.replace('model: opus\n', 'model: opus\ninitialPrompt: "Read the diff first."\n');
  assert.match(checkAgentSource('reviewer.md', bad).join('\n'), /initialPrompt.*never to a subagent/);
});

test('missing required keys, a mismatched name, and unknown model or effort are named', () => {
  assert.match(checkAgentSource('reviewer.md', GOOD_MD.replace('description: "Adversarial pre-merge review: correctness, honesty, dead code."\n', '')).join('\n'), /missing required frontmatter key `description:`/);
  assert.match(checkAgentSource('critic.md', GOOD_MD).join('\n'), /name `reviewer` != filename `critic`/);
  assert.match(checkAgentSource('reviewer.md', GOOD_MD.replace('model: opus', 'model: gpt-9')).join('\n'), /unknown model `gpt-9`/);
  assert.match(checkAgentSource('reviewer.md', GOOD_MD.replace('effort: xhigh', 'effort: extreme')).join('\n'), /unknown effort `extreme`/);
});

test('a well-formed Codex agent is clean', () => {
  assert.deepEqual(checkCodexAgentSource('reviewer.toml', GOOD_TOML), []);
});

test('Codex format failures are named: unclosed block, missing field, bad name, sandbox, unrecognized line', () => {
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace(/\n"""\n$/, '\n')).join('\n'), /never closes/);
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace('model = "gpt-6.1-sol"\n', '')).join('\n'), /missing required TOML field `model`/);
  assert.match(checkCodexAgentSource('critic.toml', GOOD_TOML).join('\n'), /name `reviewer` != filename `critic`/);
  assert.match(checkCodexAgentSource('reviewer.toml', `color = "red"\n${GOOD_TOML}`).join('\n'), /unrecognized preamble line/);
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace('model_reasoning_effort = "xhigh"', 'model_reasoning_effort = "extreme"')).join('\n'), /unknown model_reasoning_effort/);
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace('sandbox_mode = "read-only"', 'sandbox_mode = "danger-full-access"')).join('\n'), /unknown sandbox_mode/);
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace('sandbox_mode = "read-only"\n', '')).join('\n'), /missing required TOML field `sandbox_mode`/);
  assert.match(checkCodexAgentSource('reviewer.toml', GOOD_TOML.replace('model = "gpt-6.1-sol"', 'model = "gpt-9"')).join('\n'), /unknown model `gpt-9`/);
});

test('checkAgentsDir picks the checker by extension and refuses an unchecked directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-agents-'));
  try {
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    const empty = join(root, 'empty');
    mkdirSync(claude); mkdirSync(codex); mkdirSync(empty);
    writeFileSync(join(claude, 'reviewer.md'), GOOD_MD);
    writeFileSync(join(claude, 'broken.md'), 'no fence here');
    writeFileSync(join(codex, 'reviewer.toml'), GOOD_TOML);
    assert.match(checkAgentsDir(claude).join('\n'), /broken\.md: no frontmatter fence/);
    assert.deepEqual(checkAgentsDir(codex), []);
    assert.match(checkAgentsDir(empty)[0], /contains no \.md or \.toml agent definitions/);
    assert.match(checkAgentsDir(join(root, 'missing'))[0], /cannot be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the live registries in this repository are clean', () => {
  for (const runtime of PRESENT) assert.deepEqual(checkAgentsDir(SEATS[runtime].directory), []);
});

test('live runtime seats pin read-only non-writers, writable builders, and Claude plan mode only for planners', () => {
  const readOnly = ['architect', 'explorer', 'plan-reviewer', 'oracle', 'reviewer', 'security-reviewer'];
  const builders = ['builder-lite', 'builder', 'builder-max'];
  if (PRESENT.includes('codex')) {
    for (const seat of readOnly) {
      const codex = readFileSync(join('.codex/agents', `${seat}.toml`), 'utf8');
      assert.match(codex, /^sandbox_mode = "read-only"$/m, `${seat} must be read-only in Codex`);
    }
    for (const seat of builders) {
      const codex = readFileSync(join('.codex/agents', `${seat}.toml`), 'utf8');
      assert.match(codex, /^sandbox_mode = "workspace-write"$/m, `${seat} must be writable in Codex`);
    }
  }

  if (PRESENT.includes('claude')) {
    const claudeSeats = [...readOnly, ...builders];
    const planMode = new Set(['architect', 'explorer', 'plan-reviewer', 'oracle']);
    for (const seat of claudeSeats) {
      const claude = readFileSync(join('.claude/agents', `${seat}.md`), 'utf8');
      const hasPlan = /^permissionMode: plan$/m.test(claude);
      assert.equal(hasPlan, planMode.has(seat), `${seat} Claude permissionMode`);
    }
  }
});

// The seat names are written out here from AGENTS.md, never imported, so a change to the module's lists cannot
// move this expectation. The spellings are the ones the agent check has always had to refuse.
// Mutation: match only the plain spelling, or skip the check for one runtime, and this goes red.
test('ANTI-REGRESSION: the costliest model on a seat outside its named seats is reported in every spelling', () => {
  for (const line of ['model:  fable', 'model: fable ', "model: 'fable'", 'model: "fable"', 'model: fable ', 'model: fable\f']) {
    const problems = checkSeatPolicy('builder.md', `---\nname: builder\n${line}\n---\nBody.\n`);
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /^builder\.md: the costliest Claude model may sit only on the oracle and security-reviewer seats; found /, line);
  }
  for (const line of ["model = 'gpt-6-astra'", 'model="gpt-6-astra"', 'model =  "gpt-6-astra" ', 'model\v="gpt-6-astra"', 'model = "gpt-6-astra"　']) {
    const problems = checkSeatPolicy('builder.toml', `name = "builder"\n${line}\nsandbox_mode = "workspace-write"\n`);
    assert.equal(problems.length, 1, line);
    assert.match(problems[0], /^builder\.toml: the costliest Codex model may sit only on the architect, oracle and security-reviewer seats; found /, line);
  }
  assert.deepEqual(checkSeatPolicy('builder.md', '---\nname: builder\nmodel: fables\n---\n'), []);
  assert.deepEqual(checkSeatPolicy('builder.toml', 'model = "gpt-6-astra-mini"\n'), []);
});

// Mutation: require the costliest model on its named seats, and this goes red.
test('a seat the costliest model may sit on may hold it or a cheaper known model', () => {
  for (const seat of ['oracle', 'security-reviewer']) {
    for (const model of ['fable', 'opus', 'sonnet']) {
      assert.deepEqual(checkSeatPolicy(`${seat}.md`, `---\nname: ${seat}\nmodel: ${model}\nmaxTurns: 90\n---\nBody.\n`), [], `${seat} ${model}`);
    }
  }
  for (const seat of ['architect', 'oracle', 'security-reviewer']) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
      assert.deepEqual(checkSeatPolicy(`${seat}.toml`, `name = "${seat}"\nmodel = "${model}"\n`), [], `${seat} ${model}`);
    }
  }
});

// Mutation: drop the comparison with 90, check only `oracle`, or take the first of two lines, and this goes red.
test('ANTI-REGRESSION: oracle and security-reviewer are refused a turn limit above 90 or one that is missing or malformed', () => {
  const seatWith = (seat, limitLines) => `---\nname: ${seat}\nmodel: opus\n${limitLines}---\nBody.\n`;
  const refused = ['maxTurns: 91\n', 'maxTurns: 150\n', `maxTurns: ${'9'.repeat(400)}\n`, 'maxTurns: 0\n', 'maxTurns: 090\n', '',
    'maxTurns: "90"\n', 'maxTurns:  90\n', 'maxTurns: 90 # cap\n', 'maxTurns: 60\nmaxTurns: 120\n'];
  for (const seat of ['oracle', 'security-reviewer']) {
    for (const limitLines of refused) {
      const problems = checkSeatPolicy(`${seat}.md`, seatWith(seat, limitLines));
      assert.equal(problems.length, 1, `${seat} ${JSON.stringify(limitLines)}`);
      assert.match(problems[0], new RegExp(`^${seat}\\.md: the turn limit of this seat must be one line maxTurns: N with N a whole number from 1 to 90; found `));
    }
    for (const limit of [90, 40, 1]) {
      assert.deepEqual(checkSeatPolicy(`${seat}.md`, seatWith(seat, `maxTurns: ${limit}\n`)), [], `${seat} ${limit}`);
    }
  }
  assert.deepEqual(checkSeatPolicy('builder.md', seatWith('builder', 'maxTurns: 150\n')), []);
  assert.deepEqual(checkSeatPolicy('oracle.toml', 'name = "oracle"\nmodel = "gpt-6-astra"\n'), []);
});

// Holds a repository's own seat files to the bound whatever they were overridden to.
// Mutation: put `model: fable` in the live builder.md and this goes red.
test('ANTI-REGRESSION: no seat in this repository breaks the seat policy', () => {
  const read = [];
  const problems = [];
  for (const { directory: dir, extension } of PRESENT.map((runtime) => SEATS[runtime])) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(extension))) {
      read.push(file);
      problems.push(...checkSeatPolicy(file, readFileSync(join(dir, file), 'utf8')));
    }
  }
  const mustRead = { claude: ['oracle.md', 'security-reviewer.md'], codex: ['oracle.toml', 'security-reviewer.toml', 'architect.toml'] };
  for (const file of PRESENT.flatMap((runtime) => mustRead[runtime])) {
    assert.ok(read.includes(file), `${file} was not read — an empty directory would prove nothing`);
  }
  assert.deepEqual(problems, []);
});

// The three builder seats share one body from `Workflow:` down. Mutation: drop the parity call from
// checkAgentsDir (or the function's comparison) and a diverged seat passes the gate silently.
test('the builder seats must share one charter from Workflow: down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-parity-'));
  const seat = (name, tail) => `---\nname: ${name}\ndescription: x\n---\nintro for ${name}\n\nWorkflow:\n1. shared\n${tail}`;
  writeFileSync(join(dir, 'builder.md'), seat('builder', ''));
  writeFileSync(join(dir, 'builder-max.md'), seat('builder-max', ''));
  writeFileSync(join(dir, 'builder-lite.md'), seat('builder-lite', ''));
  assert.deepEqual(checkBuilderParity(dir), []);
  assert.deepEqual(checkAgentsDir(dir), []);
  writeFileSync(join(dir, 'builder-lite.md'), seat('builder-lite', '2. only here\n'));
  assert.match(checkBuilderParity(dir).join('\n'), /builder-lite\.md: shared builder charter .* differs from builder\.md/);
  assert.equal(checkAgentsDir(dir).length, 1, 'the directory gate carries the parity problem');
  writeFileSync(join(dir, 'builder-lite.md'), '---\nname: builder-lite\ndescription: x\n---\nno workflow marker\n');
  assert.match(checkBuilderParity(dir).join('\n'), /no .Workflow:. line/);
});

test('the real builder seats share one charter', { skip: without('claude') }, () => {
  assert.deepEqual(checkBuilderParity('.claude/agents'), []);
});

// Keep the expected seat names independent of the production selector.
const CHARTER_SEATS = ['architect', 'builder', 'builder-lite', 'builder-max', 'explorer', 'oracle', 'plan-reviewer', 'reviewer', 'security-reviewer'];

test('ANTI-REGRESSION: every first-party seat rejects a one-sided charter edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'charter-parity-'));
  try {
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    mkdirSync(claude); mkdirSync(codex);
    for (const seat of CHARTER_SEATS) {
      writeFileSync(join(claude, `${seat}.md`), GOOD_MD.replaceAll('reviewer', seat));
      writeFileSync(join(codex, `${seat}.toml`), GOOD_TOML.replaceAll('reviewer', seat));
    }
    assert.deepEqual(checkCharterParity(claude, codex), []);
    writeFileSync(join(claude, 'mine.md'), GOOD_MD.replaceAll('reviewer', 'mine'));
    assert.deepEqual(checkCharterParity(claude, codex), [], 'a consumer-owned custom seat needs no counterpart');
    for (const seat of CHARTER_SEATS) {
      for (const [dir, extension, fixture] of [[claude, '.md', GOOD_MD], [codex, '.toml', GOOD_TOML]]) {
        const file = join(dir, `${seat}${extension}`);
        const matching = fixture.replaceAll('reviewer', seat);
        writeFileSync(file, matching.replace('You review the diff.', 'You rewrite the diff.'));
        const [problem, ...rest] = checkCharterParity(claude, codex);
        assert.deepEqual(rest, [], `${seat}${extension}`);
        assert.ok(problem.includes(`${seat}.md line 9 differs from ${join(codex, `${seat}.toml`)} line 7`), problem);
        assert.ok(problem.includes(`edit the ${seat} charters together`), problem);
        assert.match(problem, /charter bodies may differ only in backticked.*skill invocation marks; runtime metadata is validated separately/);
        assert.match(problem, /"You review the diff\."/);
        assert.match(problem, /"You rewrite the diff\."/);
        writeFileSync(file, matching);
        assert.deepEqual(checkCharterParity(claude, codex), []);
      }
    }
    rmSync(join(claude, 'reviewer.md'));
    rmSync(join(codex, 'reviewer.toml'));
    const [missingReviewer, ...rest] = checkCharterParity(claude, codex);
    assert.deepEqual(rest, []);
    assert.match(missingReviewer, /reviewer\.md: reviewer charter is missing or unreadable.*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seat charters permit only settings and marked skill invocations to differ', () => {
  const root = mkdtempSync(join(tmpdir(), 'charter-marks-'));
  try {
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    mkdirSync(claude); mkdirSync(codex);
    writeFileSync(join(claude, 'reviewer.md'), GOOD_MD);
    writeFileSync(join(codex, 'reviewer.toml'), GOOD_TOML);
    const claudeFile = join(claude, 'explorer.md');
    const codexFile = join(codex, 'explorer.toml');
    const md = GOOD_MD.replaceAll('reviewer', 'explorer').replace('You review the diff.', 'Run `/tdd`.');
    const toml = GOOD_TOML.replaceAll('reviewer', 'explorer').replace('You review the diff.', 'Run `$tdd`.');
    writeFileSync(claudeFile, md);
    writeFileSync(codexFile, toml);
    assert.deepEqual(checkCharterParity(claude, codex), []);
    writeFileSync(codexFile, toml.replace('gpt-6.1-sol', 'gpt-6-luna').replace('xhigh', 'low'));
    assert.deepEqual(checkCharterParity(claude, codex), []);
    for (const body of ['Run `$diagnosing-bugs`.', 'Run `tdd`.', 'Run $tdd.', 'Run `/tdd`. ']) {
      writeFileSync(codexFile, toml.replace('Run `$tdd`.', body));
      assert.equal(checkCharterParity(claude, codex).length, 1, body);
    }
    writeFileSync(claudeFile, md.replace('Run `/tdd`.', 'Run `tdd`.'));
    writeFileSync(codexFile, toml);
    assert.equal(checkCharterParity(claude, codex).length, 1, 'bare versus marked invocation');
    writeFileSync(claudeFile, md);
    writeFileSync(codexFile, toml.replace(/\n"""\n$/, '\n'));
    assert.match(checkCharterParity(claude, codex)[0], /explorer\.toml: no closed .* block/);
    writeFileSync(codexFile, toml);
    writeFileSync(claudeFile, md.replace(/\n---\nRun/, '\nRun'));
    assert.match(checkCharterParity(claude, codex)[0], /explorer\.md: no closed frontmatter fence/);
    writeFileSync(claudeFile, md);
    rmSync(codexFile);
    assert.match(checkCharterParity(claude, codex)[0], /explorer\.toml: explorer charter is missing or unreadable.*ENOENT/);
    writeFileSync(codexFile, toml);
    rmSync(claudeFile);
    assert.match(checkCharterParity(claude, codex)[0], /explorer\.md: explorer charter is missing or unreadable.*ENOENT/);
    assert.match(checkCharterParity(join(root, 'missing'), codex)[0], /cannot be read.*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real seat charters match across runtimes', { skip: without('claude') || without('codex') }, () => {
  const manifest = JSON.parse(readFileSync('.agents/factory-manifest.json', 'utf8'));
  for (const [dir, extension] of [['.claude/agents', '.md'], ['.codex/agents', '.toml']]) {
    const names = readdirSync(dir).filter((file) => file.endsWith(extension)).map((file) => file.slice(0, -extension.length));
    for (const seat of CHARTER_SEATS) assert.ok(names.includes(seat), `${dir} is missing first-party seat ${seat}`);
    const manifestNames = manifest.entries
      .filter(({ path }) => path.startsWith(`${dir}/`) && path.endsWith(extension))
      .map(({ path }) => path.slice(dir.length + 1, -extension.length))
      .sort();
    assert.deepEqual(manifestNames, [...CHARTER_SEATS].sort(), `${dir} manifest entries must match the first-party seat oracle`);
  }
  assert.deepEqual(checkCharterParity('.claude/agents', '.codex/agents'), []);
});

// Price tag: recurring cost is two spawned CLI runs over a tiny fixture; retire it if the CLI stops being
// the pre-commit hook's entry point.
// Mutation: drop the CLI's default-run parity call and the diverged run exits 0.
test('the default CLI run refuses diverged non-reviewer charters', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'check-agents.mjs');
  const root = mkdtempSync(join(tmpdir(), 'reviewer-cli-'));
  try {
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'reviewer.md'), GOOD_MD.replace('You review the diff.', 'You review the diff.\nRun `/check-figures`.'));
    const codex = (line) => GOOD_TOML.replace('You review the diff.', `${line}\nRun \`$check-figures\`.`);
    writeFileSync(join(root, '.codex', 'agents', 'reviewer.toml'), codex('You review the diff.'));
    writeFileSync(join(root, '.claude', 'agents', 'explorer.md'), GOOD_MD.replaceAll('reviewer', 'explorer'));
    writeFileSync(join(root, '.codex', 'agents', 'explorer.toml'), GOOD_TOML.replaceAll('reviewer', 'explorer'));
    assert.equal(spawnSync('node', [cli], { cwd: root, encoding: 'utf8' }).status, 0);
    writeFileSync(join(root, '.codex', 'agents', 'explorer.toml'), GOOD_TOML.replaceAll('reviewer', 'explorer').replace('You review the diff.', 'You rewrite the diff.'));
    const diverged = spawnSync('node', [cli], { cwd: root, encoding: 'utf8' });
    assert.equal(diverged.status, 1);
    assert.match(diverged.stderr, /edit the explorer charters together/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Price tag: recurring cost is five spawned CLI runs over a one-seat fixture; retire it with the test above.
// Mutation: choose the folders by which exist on disk and the run with no settings file exits 0.
test('the default CLI run checks only the runtimes the settings file names, and both when it names none', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'check-agents.mjs');
  const root = mkdtempSync(join(tmpdir(), 'runtimes-cli-'));
  const run = () => spawnSync('node', [cli], { cwd: root, encoding: 'utf8' });
  const settings = join(root, '.agents', 'factory-settings.json');
  const name = (runtimes) => writeFileSync(settings, JSON.stringify({ version: 1, runtimes, seats: {} }));
  try {
    mkdirSync(join(root, '.agents'));
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'reviewer.md'), GOOD_MD);
    name(['claude']);
    const claudeOnly = run();
    assert.equal(claudeOnly.status, 0, claudeOnly.stderr);

    writeFileSync(settings, '{"runtimes":["claude"]}');
    const unversioned = run();
    assert.equal(unversioned.status, 1);
    assert.match(unversioned.stderr, /\.agents\/factory-settings\.json: version: is unsupported/);

    rmSync(settings);
    const unnamed = run();
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /\.codex\/agents: cannot be read/);

    rmSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codex', 'agents', 'reviewer.toml'), GOOD_TOML);
    name(['codex']);
    const codexOnly = run();
    assert.equal(codexOnly.status, 0, codexOnly.stderr);

    name([]);
    const empty = run();
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /\.agents\/factory-settings\.json: runtimes: must be a non-empty array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
