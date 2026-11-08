// handoff-check.test.mjs — the prompt-side builder and architect handoff contract.
// Every blocking rule has a case that turns red if the rule is removed. The required-field
// lists are spelled out here, not imported, so dropping a field from the guard turns the test
// for that field red instead of deleting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHandoff, BUILDER_REQUIREMENTS, ARCHITECT_REQUIREMENTS } from "./handoff-check.mjs";
import { presentRuntimes } from "./runtimes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRESENT = presentRuntimes(ROOT);
const withoutClaude = !PRESENT.includes("claude") && "the settings file names no claude runtime";
const EXPECTED_BUILDER_FIELDS = ["Slice", "Claim", "Construction mode", "Focused verification command", "Stop condition", "Working directory"];
const EXPECTED_ARCHITECT_FIELDS = ["Decision", "Scope", "Discovery", "Judgment", "Deliverable", "Stop condition"];

const GOOD_BUILDER = [
  "Slice: Cycle-time card shows the unavailable state",
  "Claim: with under 30 percent commitment coverage the card renders the unavailable copy",
  "Construction mode: evidence-required",
  "Plan:",
  "- edit the card renderer and its Playwright spec",
  "Files to edit:",
  "- src/widgets/status-card.js",
  "Evidence that lands with this slice:",
  "- tests/cycle-time-card.spec.ts: 'cycle time card explains unavailable data'",
  "Focused verification command: npm test -- --grep \"cycle time card explains unavailable data$\"",
  "Stop condition: the spec passes and lint is clean",
  "Working directory: /tmp/jobs/123",
  "",
  "Standing contract: report what you verified; end with the literal line final on-disk state = fixed",
].join("\n");

const GOOD_ARCHITECT = [
  "Decision: where the unavailable-state copy lives",
  "Scope: the cycle-time card only",
  "Discovery: example/card-renderer.js:234 renders the unavailable-state shell; unresolved gaps: none",
  "Judgment: copy placement, not metric meaning",
  "Deliverable: a file-level plan with one claim",
  "Stop condition: plan delivered in full",
].join("\n");

function withLine(prompt, field, replacement) {
  return prompt.split("\n").map((line) => (line.startsWith(`${field}:`) ? replacement : line)).join("\n");
}

// Fill every {{SLOT}} below the ---8<--- line of a template with a sample value.
function filledTemplate(relativePath, values) {
  const source = readFileSync(resolve(ROOT, relativePath), "utf8");
  const body = source.slice(source.lastIndexOf("---8<---") + "---8<---".length);
  return body.replace(/{{([A-Z][A-Z0-9_]*)}}/g, (_match, slot) => {
    if (!(slot in values)) throw new Error(`no sample value for template slot ${slot}`);
    return values[slot];
  });
}

test("the guard's required-field lists are the documented ones", () => {
  assert.deepEqual(BUILDER_REQUIREMENTS, EXPECTED_BUILDER_FIELDS);
  assert.deepEqual(ARCHITECT_REQUIREMENTS, EXPECTED_ARCHITECT_FIELDS);
});

test("a filled builder handoff passes for all three builder seats", () => {
  assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt: GOOD_BUILDER }), { ok: true });
  assert.deepEqual(checkHandoff({ subagent_type: "builder-max", prompt: GOOD_BUILDER }), { ok: true });
  assert.deepEqual(checkHandoff({ subagent_type: "builder-lite", prompt: GOOD_BUILDER }), { ok: true });
});

// Mutation: drop `builder-lite` from the guarded set and this handoff passes through as an unknown type.
test("builder-lite is guarded exactly like builder: a missing required line blocks", () => {
  const missing = withLine(GOOD_BUILDER, "Stop condition", "");
  assert.equal(checkHandoff({ subagent_type: "builder", prompt: missing }).ok, false);
  assert.equal(checkHandoff({ subagent_type: "builder-lite", prompt: missing }).ok, false);
});

test("the real builder template, filled, passes the guard and carries every required line", () => {
  const prompt = filledTemplate(".agents/templates/builder-handoff.md", {
    SLICE_TITLE: "Cycle-time card unavailable state",
    CLAIM: "the card renders the unavailable copy under 30 percent coverage",
    CONSTRUCTION_MODE: "evidence-required",
    WORKTREE_ROOT: "/tmp/jobs/123",
    PLAN: "Edit the renderer; add the spec.",
    FILES: "- src/widgets/status-card.js",
    TEST: "- tests/cycle-time-card.spec.ts",
    OBSERVER: "the rendered card text",
    INDEPENDENT_ORACLE: "the acceptance criterion's exact copy",
    FOCUSED_TEST_COMMAND: "npm test -- --grep \"cycle time card explains unavailable data$\"",
    STOP_CONDITION: "spec green, lint clean",
  });
  assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt }), { ok: true });
  for (const field of EXPECTED_BUILDER_FIELDS) {
    assert.equal(prompt.split("\n").filter((line) => line.startsWith(`${field}:`)).length, 1, `template must carry one '${field}:' line`);
  }
});

test("the real architect template, filled, passes the guard", () => {
  const prompt = filledTemplate(".agents/templates/planner-handoff.md", {
    DECISION: "where the copy lives",
    SCOPE: "the card only",
    DISCOVERY: "example/card-renderer.js:234 renders the unavailable-state shell; unresolved gaps: none",
    JUDGMENT: "placement",
    DELIVERABLE: "a plan",
    STOP_CONDITION: "plan delivered in full",
  });
  assert.deepEqual(checkHandoff({ subagent_type: "architect", prompt }), { ok: true });
});

test("every required builder line blocks when missing, duplicated, or empty", () => {
  for (const field of EXPECTED_BUILDER_FIELDS) {
    const missing = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith(`${field}:`)).join("\n");
    assert.match(checkHandoff({ subagent_type: "builder", prompt: missing }).reason, new RegExp(`'${field}:'`));
    const empty = withLine(GOOD_BUILDER, field, `${field}:   `);
    assert.equal(checkHandoff({ subagent_type: "builder", prompt: empty }).ok, false, `${field} empty`);
    const duplicated = `${GOOD_BUILDER}\n${field}: again`;
    assert.equal(checkHandoff({ subagent_type: "builder", prompt: duplicated }).ok, false, `${field} duplicated`);
  }
});

test("an unfilled template slot blocks and names the slot", () => {
  const prompt = withLine(GOOD_BUILDER, "Stop condition", "Stop condition: {{STOP_CONDITION}}");
  const result = checkHandoff({ subagent_type: "builder", prompt });
  assert.equal(result.ok, false);
  assert.match(result.reason, /{{STOP_CONDITION}}/);
});

test("the construction mode must be one of the three testing-strategy modes", () => {
  const prompt = withLine(GOOD_BUILDER, "Construction mode", "Construction mode: vibes");
  const result = checkHandoff({ subagent_type: "builder", prompt });
  assert.equal(result.ok, false);
  assert.match(result.reason, /strict-tdd, evidence-required, preservation/);
  for (const mode of ["strict-tdd", "evidence-required", "preservation"]) {
    assert.equal(checkHandoff({ subagent_type: "builder", prompt: withLine(GOOD_BUILDER, "Construction mode", `Construction mode: ${mode}`) }).ok, true);
  }
});

test("a placeholder focused verification command blocks", () => {
  for (const placeholder of ["...", "<command>"]) {
    const prompt = withLine(GOOD_BUILDER, "Focused verification command", `Focused verification command: ${placeholder}`);
    const result = checkHandoff({ subagent_type: "builder", prompt });
    assert.equal(result.ok, false, placeholder);
    assert.match(result.reason, /placeholder/);
  }
});

test("an instruction to self-verify mutation-sensitivity blocks, even negated", () => {
  for (const phrase of [
    "Then verify mutation-sensitivity yourself by reverting.",
    "You do NOT need to prove the mutation-sensitivity.",
    "Re-prove your own test before reporting.",
  ]) {
    const result = checkHandoff({ subagent_type: "builder", prompt: `${GOOD_BUILDER}\n${phrase}` });
    assert.equal(result.ok, false, phrase);
    assert.match(result.reason, /self-mutation-testing/);
  }
});

test("the benign 'mutation-proven test' phrasing is allowed", () => {
  const prompt = `${GOOD_BUILDER}\nLand a mutation-proven test with the change.`;
  assert.equal(checkHandoff({ subagent_type: "builder", prompt }).ok, true);
});

test("a filled architect handoff passes and each missing line blocks", () => {
  assert.deepEqual(checkHandoff({ subagent_type: "architect", prompt: GOOD_ARCHITECT }), { ok: true });
  for (const field of EXPECTED_ARCHITECT_FIELDS) {
    const missing = GOOD_ARCHITECT.split("\n").filter((line) => !line.startsWith(`${field}:`)).join("\n");
    assert.match(checkHandoff({ subagent_type: "architect", prompt: missing }).reason, new RegExp(`'${field}:'`));
  }
  const unfilled = withLine(GOOD_ARCHITECT, "Scope", "Scope: {{SCOPE}}");
  assert.match(checkHandoff({ subagent_type: "architect", prompt: unfilled }).reason, /{{SCOPE}}/);
});

test("a handoff with several defects is rejected once, naming every one", () => {
  const withoutSlice = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Slice:")).join("\n");
  const twoDefects = withLine(withoutSlice, "Construction mode", "Construction mode: vibes");
  const result = checkHandoff({ subagent_type: "builder", prompt: twoDefects });
  assert.equal(result.ok, false);
  assert.match(result.reason, /'Slice:'/);
  assert.match(result.reason, /'vibes'/);
  assert.equal(result.reason.split(".agents/templates/builder-handoff.md").length - 1, 1);

  const twoSlots = withLine(withLine(GOOD_BUILDER, "Stop condition", "Stop condition: {{STOP_CONDITION}}"), "Claim", "Claim: {{CLAIM}}");
  const slots = checkHandoff({ subagent_type: "builder", prompt: twoSlots });
  assert.equal(slots.ok, false);
  assert.match(slots.reason, /{{STOP_CONDITION}}/);
  assert.match(slots.reason, /{{CLAIM}}/);

  const architect = GOOD_ARCHITECT.split("\n").filter((line) => !line.startsWith("Decision:") && !line.startsWith("Scope:")).join("\n");
  const architectResult = checkHandoff({ subagent_type: "architect", prompt: architect });
  assert.equal(architectResult.ok, false);
  assert.match(architectResult.reason, /'Decision:'/);
  assert.match(architectResult.reason, /'Scope:'/);
});

test("the construction-mode and missing-line rejections say how the line is written", () => {
  const vibes = checkHandoff({ subagent_type: "builder", prompt: withLine(GOOD_BUILDER, "Construction mode", "Construction mode: vibes") });
  assert.match(vibes.reason, /alone on its line/);
  assert.match(vibes.reason, /two handoffs/);
  const missingSlice = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Slice:")).join("\n");
  assert.match(checkHandoff({ subagent_type: "builder", prompt: missingSlice }).reason, /on the same line/);
  const missingMode = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Construction mode:")).join("\n");
  const missingModeResult = checkHandoff({ subagent_type: "builder", prompt: missingMode });
  assert.match(missingModeResult.reason, /alone on its line/);
  assert.match(missingModeResult.reason, /two handoffs/);
});

test("other agent types and malformed input pass through", () => {
  assert.deepEqual(checkHandoff({ subagent_type: "reviewer", prompt: "review the diff" }), { ok: true });
  assert.deepEqual(checkHandoff({ subagent_type: "explorer" }), { ok: true });
  assert.deepEqual(checkHandoff(null), { ok: true });
  assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt: 42 }).ok, false);
});


test("ANTI-REGRESSION: protected Claude seats may delegate only to explorer", () => {
  const children = [
    ["explorer", { subagent_type: "explorer" }, true],
    ["builder", { subagent_type: "builder", prompt: GOOD_BUILDER }, false],
    ["builder-lite", { subagent_type: "builder-lite", prompt: GOOD_BUILDER }, false],
    ["builder-max", { subagent_type: "builder-max", prompt: GOOD_BUILDER }, false],
    ["architect", { subagent_type: "architect", prompt: GOOD_ARCHITECT }, false],
    ["oracle", { subagent_type: "oracle" }, false],
    ["security-reviewer", { subagent_type: "security-reviewer" }, false],
    ["reviewer", { subagent_type: "reviewer" }, false],
    ["missing", {}, false],
    ["null input", null, false],
    ["empty", { subagent_type: "" }, false],
    ["null", { subagent_type: null }, false],
    ["number", { subagent_type: 42 }, false],
    ["boolean", { subagent_type: false }, false],
    ["object", { subagent_type: {} }, false],
    ["array", { subagent_type: ["explorer"] }, false],
    ["capitalized", { subagent_type: "Explore" }, false],
    ["leading whitespace", { subagent_type: " explorer" }, false],
    ["trailing whitespace", { subagent_type: "explorer " }, false],
    ["whitespace only", { subagent_type: " " }, false],
    ["invalid builder prompt", { subagent_type: "builder", prompt: "not a handoff" }, false],
  ];
  for (const [callerType, reason] of [
    ["architect", "architect may start only explorer helpers"],
    ["oracle", "oracle may start only explorer helpers"],
    ["security-reviewer", "security-reviewer may start only explorer helpers"],
  ]) {
    for (const hasCallerId of [true, false]) {
      for (const [label, toolInput, allowed] of children) {
        assert.deepEqual(checkHandoff(toolInput, { callerType, hasCallerId }), allowed ? { ok: true } : { ok: false, reason }, `${callerType}, ID ${hasCallerId}, ${label}`);
      }
    }
  }

  const unreadable = [
    { hasCallerId: true },
    { callerType: undefined, hasCallerId: true },
    { callerType: "", hasCallerId: true },
  ];
  for (const callerType of [null, 42, false, {}, [], ["architect"], " ", "\t", "\n", " architect", "architect ", " architect "]) {
    for (const hasCallerId of [true, false]) unreadable.push({ callerType, hasCallerId });
  }
  for (const callerContext of unreadable) {
    for (const toolInput of [{ subagent_type: "builder", prompt: GOOD_BUILDER }, { subagent_type: "explorer" }]) {
      assert.deepEqual(checkHandoff(toolInput, callerContext), { ok: false, reason: "agent handoff requires a readable calling-seat identity" }, JSON.stringify(callerContext));
    }
  }

  const ordinary = [undefined, {}, { callerType: undefined, hasCallerId: false }, { callerType: "", hasCallerId: false }];
  for (const callerType of ["reviewer", "builder", "Explore", "plugin:reviewer", "Architect"]) {
    for (const hasCallerId of [true, false]) ordinary.push({ callerType, hasCallerId });
  }
  for (const callerContext of ordinary) {
    assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt: GOOD_BUILDER }, callerContext), { ok: true });
    assert.deepEqual(checkHandoff({ subagent_type: "architect", prompt: GOOD_ARCHITECT }, callerContext), { ok: true });
    assert.deepEqual(checkHandoff({ subagent_type: "reviewer" }, callerContext), { ok: true });
    assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt: withLine(GOOD_BUILDER, "Stop condition", "") }, callerContext), {
      ok: false,
      reason: "builder handoff requires exactly one non-empty 'Stop condition:' line, with its value on the same line: fill .agents/templates/builder-handoff.md instead of hand-writing the handoff",
    });
  }
});

function runHook(input) {
  return spawnSync(process.execPath, [resolve(ROOT, ".claude/hooks/check-builder-handoff.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    input,
  });
}

test("Claude handoff wire allows a protected explorer", { skip: withoutClaude }, () => {
  const run = runHook(JSON.stringify({ agent_type: "architect", agent_id: "synthetic-caller", tool_input: { subagent_type: "explorer" } }));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
});

test("Claude handoff wire refuses a protected builder despite a spoofed inner caller", { skip: withoutClaude }, () => {
  const run = runHook(JSON.stringify({ agent_type: "architect", agent_id: "synthetic-caller", tool_input: { agent_type: "reviewer", subagent_type: "builder", prompt: GOOD_BUILDER } }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "Blocked: architect may start only explorer helpers.\n");
});

test("Claude handoff wire allows an ordinary valid builder", { skip: withoutClaude }, () => {
  const run = runHook(JSON.stringify({ tool_input: { subagent_type: "builder", prompt: GOOD_BUILDER } }));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
});

test("Claude handoff wire retains ordinary builder validation", { skip: withoutClaude }, () => {
  const run = runHook(JSON.stringify({ tool_input: { subagent_type: "builder", prompt: withLine(GOOD_BUILDER, "Stop condition", "") } }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "Blocked: builder handoff requires exactly one non-empty 'Stop condition:' line, with its value on the same line: fill .agents/templates/builder-handoff.md instead of hand-writing the handoff.\n");
});

test("Claude handoff wire refuses unreadable JSON", { skip: withoutClaude }, () => {
  const run = runHook("{not JSON");
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "Blocked: agent handoff requires a readable calling-seat identity.\n");
});


test("Claude handoff wire refuses an identified caller with unreadable type", { skip: withoutClaude }, () => {
  const run = runHook(JSON.stringify({ agent_id: "synthetic-caller", tool_input: { subagent_type: "explorer" } }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "Blocked: agent handoff requires a readable calling-seat identity.\n");
});
