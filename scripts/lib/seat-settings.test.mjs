// seat-settings.test.mjs — the substitution of a seat's setting values and the settings schema.
// Seat texts and refusal causes are written out by hand; only the last test reads the live seat files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { presentRuntimes } from './runtimes.mjs';
import { overrideProblems, parseSettings, seatsByPath, seatsRecord, substituteSeatSettings } from './seat-settings.mjs';

const PRESENT = presentRuntimes('.');

const CLAUDE_PATH = '.claude/agents/builder.md';
const CODEX_PATH = '.codex/agents/builder.toml';
const RECOVERY = 'if a newer copy of the shared workflow admits this, undo the edit, run the sync that installs that copy, then make the edit again';

// The body repeats setting-shaped lines on purpose: only the settings block may change.
const claudeSeat = (name, model, effort, maxTurns) => `---
name: ${name}
description: "A seat."
model: ${model}
effort: ${effort}
maxTurns: ${maxTurns}
tools: Read, Write
---
The charter body.
model: haiku
effort: low
maxTurns: 3
`;

const codexSeat = (name, model, effort) => `name = "${name}"
description = "A seat."
model = "${model}"
model_reasoning_effort = "${effort}"
sandbox_mode = "workspace-write"
developer_instructions = """
The charter body.
model = "gpt-6-luna"
model_reasoning_effort = "low"
"""
`;

const buffer = (text) => Buffer.from(text);

test('substitution changes only the named values inside the settings block', () => {
  const claude = substituteSeatSettings(CLAUDE_PATH, buffer(claudeSeat('builder', 'sonnet', 'high', 150)), { model: 'opus', maxTurns: 60 });
  assert.equal(claude.data.toString(), claudeSeat('builder', 'opus', 'high', 60));
  assert.deepEqual(claude.replaced, { model: 'sonnet', maxTurns: 150 });

  const codex = substituteSeatSettings(CODEX_PATH, buffer(codexSeat('builder', 'gpt-6.1-sol', 'medium')), { model_reasoning_effort: 'xhigh' });
  assert.equal(codex.data.toString(), codexSeat('builder', 'gpt-6.1-sol', 'xhigh'));
  assert.deepEqual(codex.replaced, { model_reasoning_effort: 'medium' });
});

test('substituting the replaced values back restores the original bytes', () => {
  const notUtf8 = Buffer.from([0xff, 0xc0, 0x0a]);
  for (const [path, text, values] of [
    [CLAUDE_PATH, claudeSeat('builder', 'sonnet', 'high', 150), { model: 'opus', effort: 'low', maxTurns: 60 }],
    [CODEX_PATH, codexSeat('builder', 'gpt-6.1-sol', 'medium'), { model: 'gpt-6-luna', model_reasoning_effort: 'xhigh' }],
  ]) {
    const original = Buffer.concat([buffer(text), notUtf8]);
    const changed = substituteSeatSettings(path, original, values);
    assert.ok(changed.data.subarray(-3).equals(notUtf8), `${path}: the bytes that are not UTF-8 changed`);
    assert.ok(!changed.data.equals(original));
    assert.ok(substituteSeatSettings(path, changed.data, changed.replaced).data.equals(original), `${path}: not restored byte for byte`);
  }
});

test('a setting the seat does not carry exactly once in the plain form is refused by name', () => {
  const claude = claudeSeat('builder', 'sonnet', 'high', 150);
  const codex = codexSeat('builder', 'gpt-6.1-sol', 'medium');
  const notPlain = (path, text, values, setting) => assert.throws(
    () => substituteSeatSettings(path, buffer(text), values),
    { message: `${path}: setting ${setting} is not carried exactly once in the plain form inside the settings block` },
  );
  notPlain(CLAUDE_PATH, claude.replace('effort: high\n', ''), { effort: 'low' }, 'effort');
  notPlain(CLAUDE_PATH, claude.replace('model: sonnet\n', ''), { model: 'opus' }, 'model');
  notPlain(CLAUDE_PATH, claude.replace('effort: high\n', 'effort: high\neffort: low\n'), { effort: 'max' }, 'effort');
  notPlain(CLAUDE_PATH, claude.replace('model: sonnet', 'model: "sonnet"'), { model: 'opus' }, 'model');
  notPlain(CLAUDE_PATH, claude.replace('model: sonnet', 'model: sonnet # pinned'), { model: 'opus' }, 'model');
  notPlain(CLAUDE_PATH, claude.replace('model: sonnet\n', 'model: sonnet\r\n'), { model: 'opus' }, 'model');
  notPlain(CLAUDE_PATH, claude.replace('maxTurns: 150', 'maxTurns: 090'), { maxTurns: 60 }, 'maxTurns');
  notPlain(CODEX_PATH, codex.replace('"gpt-6.1-sol"', "'gpt-6.1-sol'"), { model: 'gpt-6-luna' }, 'model');
  notPlain(CODEX_PATH, codex, { maxTurns: 60 }, 'maxTurns');

  assert.throws(() => substituteSeatSettings(CLAUDE_PATH, buffer('The charter body.\nmodel: haiku\n'), { model: 'opus' }),
    { message: `${CLAUDE_PATH}: no settings block found` });
  assert.throws(() => substituteSeatSettings(CLAUDE_PATH, buffer(claude.replace('tools: Read, Write\n---\n', 'tools: Read, Write\n')), { model: 'opus' }),
    { message: `${CLAUDE_PATH}: no settings block found` });
  assert.throws(() => substituteSeatSettings(CODEX_PATH, buffer('model = "gpt-6-luna"\n'), { model: 'gpt-6-sol' }),
    { message: `${CODEX_PATH}: no settings block found` });
  assert.throws(() => substituteSeatSettings('notes/example.txt', buffer(claude), { model: 'opus' }), { message: 'notes/example.txt: is not a seat path' });
});

test('a settings file that is malformed or holds an unknown name or an unsafe value is refused by name', () => {
  const label = 'settings.json';
  const withSeats = (seats) => JSON.stringify({ version: 1, seats });
  const withRuntimes = (runtimes, seats = {}) => JSON.stringify({ version: 1, runtimes, seats });
  const runtimesRule = 'runtimes: must be a non-empty array naming claude, codex or both, each once';
  const claudeSetting = (setting) => withSeats({ claude: { builder: setting } });
  const valueGrammar = 'must be a string matching ^[A-Za-z0-9][\\w.-]*$';
  const turnRule = 'must be a whole number from 1 to 9007199254740991';
  const unknownClaude = 'is not a setting of the claude runtime (known: model, effort, maxTurns)';
  const unknownCodex = 'is not a setting of the codex runtime (known: model, model_reasoning_effort)';
  const refused = [
    ['{"version": 1,', `${label}: is not valid JSON`],
    ['[]', `${label}: file: must hold one JSON object; found []`],
    ['{"seats":{}}', `${label}: version: is unsupported by this copy of the sync (only 1); found undefined; ${RECOVERY}`],
    ['{"version":2,"seats":{}}', `${label}: version: is unsupported by this copy of the sync (only 1); found 2; ${RECOVERY}`],
    ['{"version":1,"seats":{},"extra":true}', `${label}: file: holds a key besides version, runtimes, seats, planApproval, greptile, docSweep and crossFamilyReview; found "extra"; ${RECOVERY}`],
    [withRuntimes('claude'), `${label}: ${runtimesRule}; found "claude"`],
    [withRuntimes([]), `${label}: ${runtimesRule}; found []`],
    [withRuntimes(['gemini']), `${label}: ${runtimesRule}; found ["gemini"]`],
    [withRuntimes(['claude', 'claude']), `${label}: ${runtimesRule}; found ["claude","claude"]`],
    [withRuntimes(['claude'], { codex: { reviewer: { model: 'gpt-6-luna' } } }), `${label}: seats.codex: names a seat although runtimes leaves codex out; found "reviewer"`],
    [withRuntimes(['codex'], { claude: { explorer: {} } }), `${label}: seats.claude: names a seat although runtimes leaves claude out; found "explorer"`],
    [withSeats({ gemini: {} }), `${label}: seats: is not a known runtime (claude or codex); found "gemini"; ${RECOVERY}`],
    [claudeSetting({ verbosity: 'high' }), `${label}: seats.claude.builder: ${unknownClaude}; found "verbosity"; ${RECOVERY}`],
    [claudeSetting({ model_reasoning_effort: 'high' }), `${label}: seats.claude.builder: ${unknownClaude}; found "model_reasoning_effort"; ${RECOVERY}`],
    [withSeats({ codex: { builder: { maxTurns: 60 } } }), `${label}: seats.codex.builder: ${unknownCodex}; found "maxTurns"; ${RECOVERY}`],
    [withSeats({ claude: { '../builder': {} } }), `${label}: seats.claude: a seat name must match ^[\\w-]+$; found "../builder"`],
    [claudeSetting({ model: 'opus 4' }), `${label}: seats.claude.builder.model: ${valueGrammar}; found "opus 4"`],
    [claudeSetting({ model: 'a"b' }), `${label}: seats.claude.builder.model: ${valueGrammar}; found "a\\"b"`],
    [claudeSetting({ effort: 'high\nmax' }), `${label}: seats.claude.builder.effort: ${valueGrammar}; found "high\\nmax"`],
    [claudeSetting({ effort: '$HOME' }), `${label}: seats.claude.builder.effort: ${valueGrammar}; found "$HOME"`],
    [claudeSetting({ model: '-opus' }), `${label}: seats.claude.builder.model: ${valueGrammar}; found "-opus"`],
    [withSeats({ codex: { builder: { model_reasoning_effort: '' } } }), `${label}: seats.codex.builder.model_reasoning_effort: ${valueGrammar}; found ""`],
    [claudeSetting({ maxTurns: 0 }), `${label}: seats.claude.builder.maxTurns: ${turnRule}; found 0`],
    [claudeSetting({ maxTurns: 1.5 }), `${label}: seats.claude.builder.maxTurns: ${turnRule}; found 1.5`],
    [claudeSetting({ maxTurns: '60' }), `${label}: seats.claude.builder.maxTurns: ${turnRule}; found "60"`],
    ['{"version":1,"seats":{"claude":{"builder":{"maxTurns":9007199254740992}}}}', `${label}: seats.claude.builder.maxTurns: ${turnRule}; found 9007199254740992`],
    [claudeSetting({ model: 'inherit' }), `${label}: seats.claude.builder.model: inherit leaves the seat model to the session, so the seat policy could not be checked; found "inherit"`],
  ];
  for (const [text, message] of refused) assert.throws(() => parseSettings(text, label), { message });

  const parsed = parseSettings(withSeats({
    codex: { reviewer: { model_reasoning_effort: 'high' } },
    claude: { reviewer: { maxTurns: 90, model: 'opus' }, builder: { effort: 'high', model: 'opus' }, explorer: {} },
  }), label);
  assert.deepEqual(parsed.runtimes, ['claude', 'codex']);
  assert.deepEqual(parsed.seats, new Map([
    ['.claude/agents/builder.md', { model: 'opus', effort: 'high' }],
    ['.claude/agents/reviewer.md', { model: 'opus', maxTurns: 90 }],
    ['.codex/agents/reviewer.toml', { model_reasoning_effort: 'high' }],
  ]));
  assert.equal(
    JSON.stringify(seatsRecord(parsed.seats)),
    '{"claude":{"builder":{"model":"opus","effort":"high"},"reviewer":{"model":"opus","maxTurns":90}},"codex":{"reviewer":{"model_reasoning_effort":"high"}}}',
  );
  assert.deepEqual(seatsRecord(new Map()), {});
  assert.deepEqual(parseSettings(withSeats({}), label), { runtimes: ['claude', 'codex'], greptile: false, docSweep: true, seats: new Map() });
  assert.equal(parseSettings('{"version":1,"seats":{},"greptile":true}', label).greptile, true);
  assert.equal(parseSettings('{"version":1,"seats":{},"docSweep":false}', label).docSweep, false);

  const claudeOnly = { claude: { builder: { model: 'opus' } } };
  const codexOnly = { codex: { builder: { model: 'gpt-6-luna' } } };
  for (const [runtimes, seats, expected, paths] of [
    [['claude'], claudeOnly, ['claude'], [CLAUDE_PATH]],
    [['codex'], codexOnly, ['codex'], [CODEX_PATH]],
    [['claude', 'codex'], { ...claudeOnly, ...codexOnly }, ['claude', 'codex'], [CLAUDE_PATH, CODEX_PATH]],
    [['codex', 'claude'], { ...claudeOnly, ...codexOnly }, ['claude', 'codex'], [CLAUDE_PATH, CODEX_PATH]],
    [['claude'], { codex: {} }, ['claude'], []],
  ]) {
    const accepted = parseSettings(withRuntimes(runtimes, seats), label);
    assert.deepEqual(accepted.runtimes, expected, JSON.stringify(runtimes));
    assert.deepEqual([...accepted.seats.keys()], paths, JSON.stringify(runtimes));
  }

  assert.deepEqual(seatsByPath({ claude: { builder: { model: 'inherit' } } }, 'manifest'), new Map([['.claude/agents/builder.md', { model: 'inherit' }]]));
  assert.throws(() => seatsByPath({ gemini: {} }, 'manifest'), { message: 'manifest: seats: is not a known runtime (claude or codex); found "gemini"' });
});

test('an override that introduces a model or effort the agent check does not know is reported', () => {
  const claudeProblems = overrideProblems(
    CLAUDE_PATH,
    buffer(claudeSeat('builder', 'sonnet', 'high', 150)),
    buffer(claudeSeat('builder', 'example-newer-model', 'example-newer-effort', 150)),
  );
  assert.equal(claudeProblems.length, 2);
  assert.match(claudeProblems[0], /^builder\.md: unknown model `example-newer-model`/);
  assert.match(claudeProblems[1], /^builder\.md: unknown effort `example-newer-effort`/);

  const codexProblems = overrideProblems(
    CODEX_PATH,
    buffer(codexSeat('builder', 'gpt-6.1-sol', 'medium')),
    buffer(codexSeat('builder', 'example-newer-model', 'example-newer-effort')),
  );
  assert.equal(codexProblems.length, 2);
  assert.match(codexProblems[0], /^builder\.toml: unknown model `example-newer-model`/);
  assert.match(codexProblems[1], /^builder\.toml: unknown model_reasoning_effort `example-newer-effort`/);

  assert.deepEqual(overrideProblems(CLAUDE_PATH, buffer(claudeSeat('builder', 'sonnet', 'high', 150)), buffer(claudeSeat('builder', 'opus', 'max', 60))), []);
});

// Mutation: leave checkSeatPolicy out of overrideProblems and every case below that expects a problem goes green.
test('ANTI-REGRESSION: an override that breaks the seat policy is reported and one within it is not', () => {
  const oracle = claudeSeat('oracle', 'fable', 'xhigh', 90);

  const fableOffSeat = overrideProblems(CLAUDE_PATH, buffer(claudeSeat('builder', 'sonnet', 'high', 150)), buffer(claudeSeat('builder', 'fable', 'high', 150)));
  assert.equal(fableOffSeat.length, 1);
  assert.match(fableOffSeat[0], /^builder\.md: the costliest Claude model may sit only on the oracle and security-reviewer seats; found \["model: fable"\]/);

  const astraOffSeat = overrideProblems(CODEX_PATH, buffer(codexSeat('builder', 'gpt-6.1-sol', 'medium')), buffer(codexSeat('builder', 'gpt-6-astra', 'medium')));
  assert.equal(astraOffSeat.length, 1);
  assert.match(astraOffSeat[0], /^builder\.toml: the costliest Codex model may sit only on the architect, oracle and security-reviewer seats; found \["model = \\"gpt-6-astra\\""\]/);

  const overLimit = overrideProblems('.claude/agents/oracle.md', buffer(oracle), buffer(claudeSeat('oracle', 'fable', 'xhigh', 120)));
  assert.equal(overLimit.length, 1);
  assert.match(overLimit[0], /^oracle\.md: the turn limit of this seat must be one line maxTurns: N with N a whole number from 1 to 90; found \["maxTurns: 120"\]/);

  assert.deepEqual(overrideProblems('.claude/agents/oracle.md', buffer(oracle), buffer(claudeSeat('oracle', 'opus', 'xhigh', 90))), []);
  assert.deepEqual(overrideProblems('.claude/agents/oracle.md', buffer(oracle), buffer(claudeSeat('oracle', 'fable', 'xhigh', 60))), []);
  assert.deepEqual(overrideProblems('.codex/agents/architect.toml', buffer(codexSeat('architect', 'gpt-6-astra', 'high')), buffer(codexSeat('architect', 'gpt-6.1-sol', 'high'))), []);
});

test('a problem the shared bytes already have is not charged to the override', () => {
  const newerModel = codexSeat('reviewer', 'example-newer-model', 'xhigh');
  assert.deepEqual(overrideProblems('.codex/agents/reviewer.toml', buffer(newerModel), buffer(codexSeat('reviewer', 'example-newer-model', 'high'))), []);

  const fableOffSeat = claudeSeat('builder', 'fable', 'high', 150);
  assert.deepEqual(overrideProblems(CLAUDE_PATH, buffer(fableOffSeat), buffer(claudeSeat('builder', 'fable', 'low', 150))), []);

  const another = overrideProblems('.codex/agents/reviewer.toml', buffer(newerModel), buffer(codexSeat('reviewer', 'example-other-model', 'xhigh')));
  assert.equal(another.length, 1);
  assert.match(another[0], /^reviewer\.toml: unknown model `example-other-model`/);
});

test('every seat in this repository carries its settings in the form the substitution addresses', () => {
  const read = [];
  const runtimes = [
    // The expected line for a changed value is formatted here, not by the module.
    { runtime: 'claude', required: ['oracle.md', 'security-reviewer.md'],
      dir: '.claude/agents', extension: '.md', names: ['model', 'effort', 'maxTurns'], line: /^(model|effort|maxTurns):/,
      block: (lines) => [1, lines.indexOf('---', 1)], changed: { model: 'example-other-model', effort: 'example-other-effort', maxTurns: 7 },
      formatted: (name, value) => `${name}: ${value}` },
    { runtime: 'codex', required: ['oracle.toml', 'security-reviewer.toml', 'architect.toml'],
      dir: '.codex/agents', extension: '.toml', names: ['model', 'model_reasoning_effort'], line: /^(model|model_reasoning_effort) =/,
      block: (lines) => [0, lines.findIndex((line) => line.startsWith('developer_instructions'))],
      changed: { model: 'example-other-model', model_reasoning_effort: 'example-other-effort' },
      formatted: (name, value) => `${name} = "${value}"` },
  ];
  const installed = runtimes.filter(({ runtime }) => PRESENT.includes(runtime));
  for (const { dir, extension, names, line, block, changed, formatted } of installed) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(extension))) {
      read.push(file);
      const original = readFileSync(join(dir, file));
      const lines = original.toString('latin1').split('\n');
      const [start, end] = block(lines);
      const settingLines = [];
      for (let i = start; i < end; i++) if (line.test(lines[i])) settingLines.push(i);
      assert.equal(settingLines.length, names.length, `${dir}/${file}: expected one line for each of ${names.join(', ')} in its settings block`);
      if (extension === '.toml') {
        assert.ok(!lines.slice(start, end).some((text) => /^max_?turns/i.test(text)), `${dir}/${file}: a Codex seat has no turn-limit slot`);
      }

      const result = substituteSeatSettings(`${dir}/${file}`, original, changed);
      const after = result.data.toString('latin1').split('\n');
      assert.equal(after.length, lines.length);
      const differing = lines.map((_, i) => i).filter((i) => after[i] !== lines[i]);
      assert.deepEqual(differing, settingLines, `${dir}/${file}: the substitution changed lines besides its setting lines`);
      for (const name of names) assert.ok(after.includes(formatted(name, changed[name])), `${dir}/${file}: ${name} was not written as ${formatted(name, changed[name])}`);

      const restored = substituteSeatSettings(`${dir}/${file}`, result.data, result.replaced);
      assert.ok(restored.data.equals(original), `${dir}/${file}: not restored byte for byte`);
    }
  }
  for (const file of installed.flatMap(({ required }) => required)) {
    assert.ok(read.includes(file), `${file} was not read — an empty directory would prove nothing`);
  }
});
