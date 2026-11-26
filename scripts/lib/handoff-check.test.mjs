// handoff-check.test.mjs — the prompt-side builder and architect handoff contract.
// Every blocking rule has a case that turns red if the rule is removed. The required-field
// lists are spelled out here, not imported, so dropping a field from the guard turns the test
// for that field red instead of deleting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkHandoff, BUILDER_REQUIREMENTS, ARCHITECT_REQUIREMENTS } from "./handoff-check.mjs";
import * as handoff from "./handoff-check.mjs";
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
    assert.match(/** @type {string} */ (checkHandoff({ subagent_type: "builder", prompt: missing }).reason), new RegExp(`'${field}:'`));
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
  assert.match(/** @type {string} */ (result.reason), /{{STOP_CONDITION}}/);
});

test("the construction mode must be one of the three testing-strategy modes", () => {
  const prompt = withLine(GOOD_BUILDER, "Construction mode", "Construction mode: vibes");
  const result = checkHandoff({ subagent_type: "builder", prompt });
  assert.equal(result.ok, false);
  assert.match(/** @type {string} */ (result.reason), /strict-tdd, evidence-required, preservation/);
  for (const mode of ["strict-tdd", "evidence-required", "preservation"]) {
    const prompt = withLine(GOOD_BUILDER, "Construction mode", `Construction mode: ${mode}`);
    const staged = mode === "strict-tdd" ? `${prompt}\nStage: test-only` : prompt;
    assert.equal(checkHandoff({ subagent_type: "builder", prompt: staged }).ok, true);
  }
});

// A run-log receipt line exactly as scripts/run-log.mjs writes it for a failing command.
const receiptLine = (argv) => `- 2026-11-22T10:00:00.000Z | red | \`${JSON.stringify(argv)}\` | exit 1 | completed=2026-11-22T10:00:01.000Z | elapsedMs=12 | rerunReason=\`null\` | scope=root | head=abc1234 tree=clean diff=none`;

// A temporary repository on branch job/1 whose run log holds one receipt line.
function runLogRepo(t, receipt) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "handoff-check-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["symbolic-ref", "HEAD", "refs/heads/job/1"]]) {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  mkdirSync(join(root, ".claude", "worklog"), { recursive: true });
  writeFileSync(join(root, ".claude", "worklog", "job_1.md"), `${receipt}\n`);
  return root;
}

function strictImplementation(workingDirectory, frozen, receipt) {
  return [
    withLine(withLine(GOOD_BUILDER, "Construction mode", "Construction mode: strict-tdd"), "Working directory", `Working directory: ${workingDirectory}`),
    "Stage: implementation",
    `Frozen test: ${frozen}`,
    `Red receipt: ${receipt}`,
  ].join("\n");
}

test("a strict-tdd implementation handoff whose failing receipt names its frozen test passes the prompt check", () => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "a strict-tdd implementation handoff whose failing receipt names its frozen test passes the prompt check";
  const receipt = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const prompt = strictImplementation("/job/worktree", `${frozenFile} :: ${frozenTitle}`, receipt);
  assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt }), { ok: true });
  for (const { label, frozen, argv } of [
    { label: "a pytest node identity", frozen: "tests/test_handoff.py :: test_refuses_missing_red", argv: ["pytest", "tests/test_handoff.py::test_refuses_missing_red"] },
    { label: "a leading ./ on the file", frozen: `${frozenFile} :: ${frozenTitle}`, argv: ["node", "--test", `--test-name-pattern=^${frozenTitle}$`, `./${frozenFile}`] },
  ]) {
    const named = strictImplementation("/job/worktree", frozen, receiptLine(argv));
    assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt: named }), { ok: true }, label);
  }
});

// The run-log check of the runtime-verified worktree, looked up by name so this file still loads without it.
/** @type {(prompt: string, verified: { worktree: string, branch: string }) => string | null} */
function recordedRedProblem(prompt, verified) {
  const exported = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (handoff)).recordedRedProblem;
  if (typeof exported !== "function") assert.fail("handoff-check.mjs exports no recordedRedProblem");
  return exported(prompt, verified);
}

// Why dispatch refuses a builder handoff whose verified worktree is the runLogRepo one, or null when it passes.
function dispatchProblem(prompt, worktree) {
  const checked = checkHandoff({ subagent_type: "builder", prompt });
  return checked.ok ? recordedRedProblem(prompt, { worktree, branch: "job/1" }) : checked.reason;
}

const runLogPath = (root) => join(root, ".claude", "worklog", "job_1.md");

test("a strict-tdd builder handoff without a test-only or implementation Stage line is refused", () => {
  const strict = withLine(GOOD_BUILDER, "Construction mode", "Construction mode: strict-tdd");
  for (const prompt of [strict, `${strict}\nStage: done`]) {
    const result = checkHandoff({ subagent_type: "builder", prompt });
    assert.equal(result.ok, false, prompt);
    assert.match(/** @type {string} */ (result.reason), /Stage:/);
    assert.match(/** @type {string} */ (result.reason), /test-only/);
    assert.match(/** @type {string} */ (result.reason), /implementation/);
  }
});

test("ANTI-REGRESSION: a strict-tdd implementation handoff without a recorded failing receipt is refused", (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "ANTI-REGRESSION: a strict-tdd implementation handoff without a recorded failing receipt is refused";
  const frozen = `${frozenFile} :: ${frozenTitle}`;
  const red = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const lint = receiptLine(["npm", "run", "lint"]);
  const passed = red.replace(" | exit 1 | ", " | exit 0 | ");
  const root = runLogRepo(t, `${lint}\n${passed}`);

  const noReceipt = strictImplementation(root, frozen, red).split("\n").filter((line) => !line.startsWith("Red receipt:")).join("\n");
  const missing = checkHandoff({ subagent_type: "builder", prompt: noReceipt });
  assert.equal(missing.ok, false, "no Red receipt: line");
  assert.match(/** @type {string} */ (missing.reason), /Red receipt:/);

  const unnamed = checkHandoff({ subagent_type: "builder", prompt: strictImplementation(root, frozen, lint) });
  assert.equal(unnamed.ok, false, "a failed lint receipt names no frozen identity");
  assert.match(/** @type {string} */ (unnamed.reason), /Red receipt/);
  assert.ok(/** @type {string} */ (unnamed.reason).includes(frozenTitle), /** @type {string} */ (unnamed.reason));

  const green = checkHandoff({ subagent_type: "builder", prompt: strictImplementation(root, frozen, passed) });
  assert.equal(green.ok, false, "an exit 0 receipt is no recorded failure");
  assert.match(/** @type {string} */ (green.reason), /Red receipt/);

  const unlogged = dispatchProblem(strictImplementation(root, frozen, red), root);
  assert.equal(typeof unlogged, "string", "a failing receipt absent from the run log");
  assert.ok(/** @type {string} */ (unlogged).includes(runLogPath(root)), /** @type {string} */ (unlogged));

  const anchored = `--test-name-pattern=^${frozenTitle}$`;
  const shortTitle = frozenTitle.split(" ").slice(0, -2).join(" ");
  const siblingTitle = "a sibling title that is not frozen";
  const tailTitle = frozenTitle.split(" ").slice(2).join(" ");
  const bound = [
    { label: "a frozen title only in a skip pattern", line: frozen, argv: ["node", "--test", `--test-name-pattern=^${siblingTitle}$`, `--test-skip-pattern=^${frozenTitle}$`, frozenFile], named: frozenTitle },
    { label: "a frozen pytest test only deselected", line: "tests/test_a.py :: test_frozen", argv: ["pytest", "tests/test_a.py::test_other", "--deselect", "tests/test_a.py::test_frozen"], named: "tests/test_a.py :: test_frozen" },
    { label: "a different file ending in the frozen path", line: frozen, argv: ["node", "--test", anchored, "vendor/scripts/lib/handoff-check.test.mjs"], named: frozenFile },
    { label: "a glob whose * would have to cross /", line: frozen, argv: ["node", "--test", anchored, "scripts/*.test.mjs"], named: frozenFile },
    { label: "a frozen title that is the tail of the selected one", line: `${frozenFile} :: ${tailTitle}`, argv: ["node", "--test", anchored, frozenFile], named: tailTitle },
    { label: "a truncated frozen title", line: `${frozenFile} :: ${shortTitle}`, argv: ["node", "--test", anchored, frozenFile], named: shortTitle },
    { label: "a truncated title beside a whole alternative", line: `${frozenFile} :: ${shortTitle}`, argv: ["node", "--test", `--test-name-pattern=^(${frozenTitle}|${siblingTitle})$`, frozenFile], named: shortTitle },
    { label: "a glob that does not match the frozen file", line: frozen, argv: ["node", "--test", anchored, "scripts/lib/other*.test.mjs"], named: frozenFile },
  ];
  for (const { label, line, argv, named } of bound) {
    const result = checkHandoff({ subagent_type: "builder", prompt: strictImplementation(root, line, receiptLine(argv)) });
    assert.equal(result.ok, false, label);
    assert.ok(/** @type {string} */ (result.reason).includes(named), `${label}: ${result.reason}`);
  }
});

test("a strict-tdd implementation handoff naming its frozen file by the job-worktree glob passes", (t) => {
  const frozenFile = "scripts/lib/unsafe-git.test.mjs";
  for (const [title, pattern, glob] of [
    ["a plain frozen title", "a plain frozen title", "scripts/lib/unsafe-g*.test.mjs"],
    ["a frozen title (with parens) and a dot.", "a frozen title \\(with parens\\) and a dot\\.", "scripts/lib/unsafe-g*.test.mjs"],
    ["a plain frozen title", "a plain frozen title", "./scripts/lib/unsafe-g*.test.mjs"],
  ]) {
    const receipt = receiptLine(["node", "--test", `--test-name-pattern=^${pattern}$`, glob]);
    const root = runLogRepo(t, receipt);
    const prompt = strictImplementation(root, `${frozenFile} :: ${title}`, receipt);
    assert.deepEqual(checkHandoff({ subagent_type: "builder", prompt }), { ok: true }, `${title} by ${glob}`);
    assert.equal(recordedRedProblem(prompt, { worktree: root, branch: "job/1" }), null, `${title} by ${glob}`);
  }
});

// The child timeout only stops a hang: a backtracking glob matcher needs far longer, a linear one microseconds.
test("a pathological receipt glob resolves and the strict handoff is still refused", () => {
  const glob = `${"*a".repeat(24)}*b`;
  const receipt = receiptLine(["node", "--test", "--test-name-pattern=^a frozen title$", glob]);
  const prompt = `${strictImplementation("/job/worktree", `${"a".repeat(58)} :: a frozen title`, receipt)}\nThen verify mutation-sensitivity yourself by reverting.`;
  const checker = pathToFileURL(join(ROOT, "scripts", "lib", "handoff-check.mjs")).href;
  const script = `import { checkHandoff } from ${JSON.stringify(checker)};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
process.stdout.write(JSON.stringify(checkHandoff({ subagent_type: "builder", prompt })));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: prompt, encoding: "utf8", timeout: 20000 });
  assert.equal(run.signal, null, "the pathological receipt glob did not resolve");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.match(result.reason, /self-mutation-testing/);
});

test("a strict-tdd implementation handoff from a detached head is checked against the detached run log", (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "a strict-tdd implementation handoff from a detached head is checked against the detached run log";
  const red = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const root = runLogRepo(t, red);
  const detachedLog = join(root, ".claude", "worklog", "detached.md");
  writeFileSync(detachedLog, `${red}\n`);
  const prompt = strictImplementation(root, `${frozenFile} :: ${frozenTitle}`, red);
  assert.equal(recordedRedProblem(prompt, { worktree: root, branch: "" }), null);
  rmSync(detachedLog);
  const problem = recordedRedProblem(prompt, { worktree: root, branch: "" });
  assert.equal(typeof problem, "string", "a detached head whose run log holds no receipt");
  assert.ok(/** @type {string} */ (problem).includes(detachedLog), /** @type {string} */ (problem));
});

test("an unreadable or corrupt run log refuses a strict-tdd implementation handoff", (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "an unreadable or corrupt run log refuses a strict-tdd implementation handoff";
  const frozen = `${frozenFile} :: ${frozenTitle}`;
  const argv = ["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile];
  const red = receiptLine(argv);
  const namesLog = (root, label) => {
    const problem = dispatchProblem(strictImplementation(root, frozen, red), root);
    assert.equal(typeof problem, "string", label);
    assert.ok(/** @type {string} */ (problem).includes(runLogPath(root)), `${label}: ${problem}`);
  };

  const absent = runLogRepo(t, red);
  rmSync(runLogPath(absent));
  namesLog(absent, "a missing run log");

  const folder = runLogRepo(t, red);
  rmSync(runLogPath(folder));
  mkdirSync(runLogPath(folder));
  namesLog(folder, "a directory in the run log's place");

  const corrupt = red.replace(JSON.stringify(argv), JSON.stringify(argv).slice(0, -1));
  const corruptRoot = runLogRepo(t, corrupt);
  const corruptProblem = dispatchProblem(strictImplementation(corruptRoot, frozen, corrupt), corruptRoot);
  assert.equal(typeof corruptProblem, "string", "a verbatim receipt holding invalid argument JSON");
  assert.match(/** @type {string} */ (corruptProblem), /Red receipt/);

  const linked = runLogRepo(t, red);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "handoff-check-outside-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "job_1.md"), `${red}\n`);
  rmSync(join(linked, ".claude", "worklog"), { recursive: true });
  symlinkSync(outside, join(linked, ".claude", "worklog"), "junction");
  namesLog(linked, "a run log reached through a linked .claude/worklog folder");

  const linkedFile = runLogRepo(t, red);
  const outsideFile = join(outside, "receipt.md");
  writeFileSync(outsideFile, `${red}\n`);
  rmSync(runLogPath(linkedFile));
  try {
    symlinkSync(outsideFile, runLogPath(linkedFile), "file");
    const problem = dispatchProblem(strictImplementation(linkedFile, frozen, red), linkedFile);
    assert.equal(typeof problem, "string", "a run log that is a link to an outside file");
    assert.ok(/** @type {string} */ (problem).includes(runLogPath(linkedFile)), `a run log that is a link to an outside file: ${problem}`);
    assert.match(/** @type {string} */ (problem), /not a regular file/);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPERM") throw error;
    t.diagnostic("symlinkSync needs the link privilege here (EPERM); the Linux and macOS lanes carry the linked-file proof");
  }

  const verified = runLogRepo(t, red);
  const elsewhere = runLogRepo(t, red);
  const moved = dispatchProblem(strictImplementation(elsewhere, frozen, red), verified);
  assert.equal(typeof moved, "string", "a Working directory other than the verified worktree");
  assert.match(/** @type {string} */ (moved), /Working directory/);
});

test("a placeholder focused verification command blocks", () => {
  for (const placeholder of ["...", "<command>"]) {
    const prompt = withLine(GOOD_BUILDER, "Focused verification command", `Focused verification command: ${placeholder}`);
    const result = checkHandoff({ subagent_type: "builder", prompt });
    assert.equal(result.ok, false, placeholder);
    assert.match(/** @type {string} */ (result.reason), /placeholder/);
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
    assert.match(/** @type {string} */ (result.reason), /self-mutation-testing/);
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
    assert.match(/** @type {string} */ (checkHandoff({ subagent_type: "architect", prompt: missing }).reason), new RegExp(`'${field}:'`));
  }
  const unfilled = withLine(GOOD_ARCHITECT, "Scope", "Scope: {{SCOPE}}");
  assert.match(/** @type {string} */ (checkHandoff({ subagent_type: "architect", prompt: unfilled }).reason), /{{SCOPE}}/);
});

test("a handoff with several defects is rejected once, naming every one", () => {
  const withoutSlice = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Slice:")).join("\n");
  const twoDefects = withLine(withoutSlice, "Construction mode", "Construction mode: vibes");
  const result = checkHandoff({ subagent_type: "builder", prompt: twoDefects });
  assert.equal(result.ok, false);
  assert.match(/** @type {string} */ (result.reason), /'Slice:'/);
  assert.match(/** @type {string} */ (result.reason), /'vibes'/);
  assert.equal(/** @type {string} */ (result.reason).split(".agents/templates/builder-handoff.md").length - 1, 1);

  const twoSlots = withLine(withLine(GOOD_BUILDER, "Stop condition", "Stop condition: {{STOP_CONDITION}}"), "Claim", "Claim: {{CLAIM}}");
  const slots = checkHandoff({ subagent_type: "builder", prompt: twoSlots });
  assert.equal(slots.ok, false);
  assert.match(/** @type {string} */ (slots.reason), /{{STOP_CONDITION}}/);
  assert.match(/** @type {string} */ (slots.reason), /{{CLAIM}}/);

  const architect = GOOD_ARCHITECT.split("\n").filter((line) => !line.startsWith("Decision:") && !line.startsWith("Scope:")).join("\n");
  const architectResult = checkHandoff({ subagent_type: "architect", prompt: architect });
  assert.equal(architectResult.ok, false);
  assert.match(/** @type {string} */ (architectResult.reason), /'Decision:'/);
  assert.match(/** @type {string} */ (architectResult.reason), /'Scope:'/);
});

test("the construction-mode and missing-line rejections say how the line is written", () => {
  const vibes = checkHandoff({ subagent_type: "builder", prompt: withLine(GOOD_BUILDER, "Construction mode", "Construction mode: vibes") });
  assert.match(/** @type {string} */ (vibes.reason), /alone on its line/);
  assert.match(/** @type {string} */ (vibes.reason), /two handoffs/);
  const missingSlice = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Slice:")).join("\n");
  assert.match(/** @type {string} */ (checkHandoff({ subagent_type: "builder", prompt: missingSlice }).reason), /on the same line/);
  const missingMode = GOOD_BUILDER.split("\n").filter((line) => !line.startsWith("Construction mode:")).join("\n");
  const missingModeResult = checkHandoff({ subagent_type: "builder", prompt: missingMode });
  assert.match(/** @type {string} */ (missingModeResult.reason), /alone on its line/);
  assert.match(/** @type {string} */ (missingModeResult.reason), /two handoffs/);
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

  const unreadable = /** @type {{ callerType?: unknown, hasCallerId: boolean }[]} */ ([
    { hasCallerId: true },
    { callerType: undefined, hasCallerId: true },
    { callerType: "", hasCallerId: true },
  ]);
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

test("Claude handoff wire refuses a strict-tdd implementation without a recorded red", { skip: withoutClaude }, (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "Claude handoff wire refuses a strict-tdd implementation without a recorded red";
  const red = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const root = runLogRepo(t, receiptLine(["npm", "run", "lint"]));
  const prompt = strictImplementation(root, `${frozenFile} :: ${frozenTitle}`, red);
  const run = runHook(JSON.stringify({ cwd: root, tool_input: { subagent_type: "builder", prompt } }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^Blocked: /);
  assert.ok(run.stderr.includes(runLogPath(root)), run.stderr);
});

// existing behaviour: the hook reads the run log of the worktree the runtime verifies (the envelope cwd).
test("Claude handoff wire admits a strict-tdd implementation whose red is in the verified worktree's run log", { skip: withoutClaude }, (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "Claude handoff wire admits a strict-tdd implementation whose red is in the verified worktree's run log";
  const red = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const root = runLogRepo(t, red);
  const prompt = strictImplementation(root, `${frozenFile} :: ${frozenTitle}`, red);
  const run = runHook(JSON.stringify({ cwd: root, tool_input: { subagent_type: "builder", prompt } }));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
});

// existing behaviour: the handoff's Working directory is only compared with the verified worktree; trusting it would read B's log and admit.
test("Claude handoff wire refuses a strict-tdd implementation whose Working directory is not the cwd's worktree", { skip: withoutClaude }, (t) => {
  const frozenFile = "scripts/lib/handoff-check.test.mjs";
  const frozenTitle = "Claude handoff wire refuses a strict-tdd implementation whose Working directory is not the cwd's worktree";
  const red = receiptLine(["node", "--test", `--test-name-pattern=${frozenTitle}`, frozenFile]);
  const verified = runLogRepo(t, receiptLine(["npm", "run", "lint"]));
  const named = runLogRepo(t, red);
  const prompt = strictImplementation(named, `${frozenFile} :: ${frozenTitle}`, red);
  const run = runHook(JSON.stringify({ cwd: verified, tool_input: { subagent_type: "builder", prompt } }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^Blocked: /);
  assert.ok(run.stderr.includes("'Working directory:' is not the verified job worktree"), run.stderr);
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: verified, encoding: "utf8" });
  assert.equal(toplevel.status, 0, toplevel.stderr);
  assert.ok(run.stderr.includes(toplevel.stdout.trim()), run.stderr);
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
