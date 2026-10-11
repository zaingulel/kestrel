// handoff-check.test.mjs — the prompt-side builder and architect handoff contract.
// Every blocking rule has a case that turns green if the rule is removed. The required-field
// lists are spelled out here, not imported, so dropping a field from the guard turns the test
// for that field red instead of deleting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHandoff, BUILDER_REQUIREMENTS, ARCHITECT_REQUIREMENTS } from "./handoff-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
