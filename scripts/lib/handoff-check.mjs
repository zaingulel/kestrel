// Shared prompt-side agent-spawn contracts behind the thin Claude and Codex hooks.
//
// Builder handoffs (`builder-lite`, `builder`, and `builder-max` share one charter): the prompt must be a filled
// copy of .agents/templates/builder-handoff.md; handoff-check.test.mjs fills the real template
// and pins that it passes. The guard checks the lines that make a handoff bounded and
// verifiable, not the prose around them:
//   1. exactly one non-empty line for each required field;
//   2. a construction mode from docs/TESTING-STRATEGY.md;
//   3. a real focused verification command, never a placeholder;
//   4. no unfilled `{{SLOT}}` anywhere;
//   5. no instruction to self-verify mutation-sensitivity by revert (that cycle is the
//      orchestrator's convergence step; a builder capped mid-cycle ships mutated source);
//   6. under strict-tdd, exactly one `Stage:` line of test-only or implementation; at implementation, one or
//      more `Frozen test: <file> :: <full title>` lines and `Red receipt:` lines, each a valid failing run-log
//      receipt (parseReceipt in scripts/run-log.mjs), and every frozen file (the exact path, a matching `*`/`?`
//      glob argument, or a pytest node identity's file part; a leading ./ ignored) and title (raw or regex-escaped,
//      a whole alternative of the selection, or the pytest node identity <file>::<title>) named by one receipt's
//      decoded argument vector, outside the operands of --test-skip-pattern and --deselect.
// Every failed check is reported together in one rejection, so a session fixes the handoff in one re-send.
// recordedRedProblem is the dispatch-time half both runtimes' hooks run after checkHandoff passes: a strict
// implementation handoff's `Working directory` must be the runtime-verified job worktree, and each `Red receipt:`
// a whole line of that worktree's run log, read without following a link (containedEntry in checkout-context.mjs).
// Architect handoffs: a filled copy of .agents/templates/planner-handoff.md.
// Protected Claude callers may request only explorer, before prompt checks; unreadable caller identity is refused.
// Legacy and nonprotected callers retain the prompt contract above; other requested types pass through.

import { realpathSync } from "node:fs";
import { parseReceipt, worklogFileName } from "../run-log.mjs";
import { ContainedReadError, containedEntry, readContainedEntry } from "./checkout-context.mjs";

const SELF_MUTATION_RE =
  /(?:verify|prove|re-?prove|check)\s+(?:the\s+|your\s+(?:own\s+)?)?mutation[- ]sensitivity|re-?prove\s+your\s+own\s+test/i;
const UNFILLED_TEMPLATE_SLOT_RE = /{{[A-Z][A-Z0-9_]*}}/g;
const CONSTRUCTION_MODES = new Set(["strict-tdd", "evidence-required", "preservation"]);
const STAGES = new Set(["test-only", "implementation"]);
const FROZEN_SEPARATOR = " :: ";
const MODE_RULE = `exactly one of ${[...CONSTRUCTION_MODES].join(", ")}, alone on its line (the reasoning belongs in the plan; a slice that needs two modes is two handoffs)`;

export const BUILDER_REQUIREMENTS = [
  "Slice",
  "Claim",
  "Construction mode",
  "Focused verification command",
  "Stop condition",
  "Working directory",
];
export const ARCHITECT_REQUIREMENTS = ["Decision", "Scope", "Discovery", "Judgment", "Deliverable", "Stop condition"];
export const BUILDER_SEATS = Object.freeze(["builder", "builder-max", "builder-lite"]);

function requirementValue(prompt, requirement) {
  const values = requirementValues(prompt, requirement);
  return values.length === 1 && values[0] ? values[0] : null;
}

// Every value of a field that may repeat, in prompt order.
function requirementValues(prompt, requirement) {
  const prefix = `${requirement}:`;
  return prompt.split(/\r?\n/).filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
}

// True for the one handoff whose red the dispatch hooks confirm against the run log.
export function needsRecordedRed(prompt) {
  return requirementValue(prompt, "Construction mode") === "strict-tdd" && requirementValue(prompt, "Stage") === "implementation";
}

const escapedTitle = (title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// True when `text` occurs in `arg` as a whole alternative of a test-name selection.
function namesWholeAlternative(arg, text) {
  for (let at = arg.indexOf(text); at !== -1; at = arg.indexOf(text, at + 1)) {
    const before = at === 0 ? "" : arg[at - 1];
    const after = arg[at + text.length] ?? "";
    if ((before === "" || "=^(|".includes(before)) && (after === "" || "$)|".includes(after))) return true;
  }
  return false;
}

const withoutDot = (path) => (path.startsWith("./") ? path.slice(2) : path);

// True when the `*`/`?` glob `pattern` matches the whole of `segment`. Resuming only the most recent `*` keeps the
// walk linear in pattern times segment length, so no receipt argument can stall the hook.
function segmentMatches(pattern, segment) {
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < segment.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === segment[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = s;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      s = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

// True when `pattern` matches `path` segment by segment, so neither `*` nor `?` crosses `/`.
function globMatches(pattern, path) {
  const patterns = pattern.split("/");
  const segments = path.split("/");
  return patterns.length === segments.length && patterns.every((part, index) => segmentMatches(part, segments[index]));
}

// True when `arg` names exactly `file`: the same path, a matching glob, or a pytest node identity's file part.
function namesFile(arg, file) {
  const path = withoutDot(arg);
  const target = withoutDot(file);
  return path === target || globMatches(path, target) || path.split("::", 1)[0] === target;
}

// True when `arg` names `title` of `file`: as a whole alternative of a selection, raw or escaped, or as the pytest
// node identity <file>::<title>.
function namesTitle(arg, file, title) {
  return namesWholeAlternative(arg, title) || namesWholeAlternative(arg, escapedTitle(title))
    || withoutDot(arg) === `${withoutDot(file)}::${title}`;
}

const EXCLUSION_FLAGS = ["--test-skip-pattern", "--deselect"];

// The arguments of `command` that may name a test: every one but the operands of an exclusion flag, in its
// --flag=value or --flag value form.
function positiveArguments(command) {
  return command.filter((arg, index) => !EXCLUSION_FLAGS.some((flag) => arg.startsWith(`${flag}=`))
    && !(index > 0 && EXCLUSION_FLAGS.includes(command[index - 1])));
}

// The Stage, Frozen test and Red receipt problems of a strict-tdd handoff.
function strictStageProblems(prompt) {
  const stage = requirementValue(prompt, "Stage");
  if (stage === null || !STAGES.has(stage)) {
    return ["requires exactly one 'Stage:' line holding test-only or implementation under strict-tdd"];
  }
  if (stage !== "implementation") return [];
  const problems = [];
  const frozen = requirementValues(prompt, "Frozen test").map((value) => {
    const at = value.indexOf(FROZEN_SEPARATOR);
    return { value, file: at === -1 ? "" : value.slice(0, at).trim(), title: at === -1 ? "" : value.slice(at + FROZEN_SEPARATOR.length).trim() };
  });
  if (frozen.length === 0) problems.push("requires one or more 'Frozen test: <file> :: <full title>' lines at Stage: implementation");
  for (const { value, file, title } of frozen) {
    if (!file || !title) problems.push(`'Frozen test:' line '${value}' must read <file> :: <full title>`);
  }
  const receipts = requirementValues(prompt, "Red receipt");
  if (receipts.length === 0) {
    problems.push("requires one or more 'Red receipt:' lines at Stage: implementation, each a failing run-log receipt line copied whole");
  }
  const failing = [];
  receipts.forEach((value, index) => {
    const receipt = parseReceipt(value);
    const exit = receipt && /^exit (-?\d+)$/.exec(receipt.outcome);
    if (exit && Number(exit[1]) !== 0) failing.push(receipt.command);
    else problems.push(`'Red receipt:' line ${index + 1} is not a valid run-log receipt of a failing run (exit N, N nonzero)`);
  });
  for (const { file, title } of frozen.filter((identity) => identity.file && identity.title)) {
    const named = failing.map(positiveArguments).some((args) => args.some((arg) => namesFile(arg, file))
      && args.some((arg) => namesTitle(arg, file, title)));
    if (!named) problems.push(`no failing 'Red receipt:' names the frozen test '${file}${FROZEN_SEPARATOR}${title}'`);
  }
  return problems;
}

const samePath = (a, b) => {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
};

// Why a strict implementation handoff's red is not recorded in the verified worktree's run log, or null. Every other
// handoff returns null. `worktree` and `branch` come from the runtime, never from the handoff; an empty branch is a
// detached head, whose run log is the one the writer names for it (worklogLocation in scripts/run-log.mjs).
/** @type {(prompt: string, verified: { worktree: string, branch?: string }) => string | null} */
export function recordedRedProblem(prompt, { worktree, branch }) {
  if (!needsRecordedRed(prompt)) return null;
  const directory = requirementValue(prompt, "Working directory");
  if (directory === null || !samePath(directory, worktree)) {
    return `the strict-tdd implementation handoff's 'Working directory:' is not the verified job worktree ${worktree}`;
  }
  let log;
  let text;
  try {
    log = containedEntry(worktree, [".claude", "worklog", worklogFileName(branch || "detached")]);
    if (log.entry === null) return `the strict-tdd implementation handoff's run log ${log.path} does not exist`;
    text = readContainedEntry(log);
  } catch (error) {
    if (error instanceof ContainedReadError) return `the strict-tdd implementation handoff's run log ${error.message}`;
    throw error;
  }
  const lines = new Set(text.split("\n"));
  const unlogged = requirementValues(prompt, "Red receipt").findIndex((receipt) => !lines.has(receipt));
  return unlogged === -1 ? null : `'Red receipt:' line ${unlogged + 1} is not a whole line of the run log ${log.path}`;
}

// The whole-prompt slot check reports a `{{SLOT}}`; the placeholder shapes left for this
// check are an ellipsis and an angle-bracketed description.
function isPlaceholder(value) {
  const trimmed = value.trim();
  return trimmed === "..." || /^<[^>]+>$/.test(trimmed);
}

function missingLineProblems(prompt, requirements, suffixByRequirement = {}) {
  return requirements
    .filter((requirement) => requirementValue(prompt, requirement) === null)
    .map((requirement) => {
      const base = `requires exactly one non-empty '${requirement}:' line, with its value on the same line`;
      return requirement in suffixByRequirement ? `${base}, holding ${suffixByRequirement[requirement]}` : base;
    });
}

function unfilledSlotProblems(prompt) {
  const slots = [...new Set(prompt.match(UNFILLED_TEMPLATE_SLOT_RE))];
  if (slots.length === 0) return [];
  return [`contains unfilled template ${slots.length === 1 ? "slot" : "slots"} ${slots.map((slot) => `'${slot}'`).join(", ")}`];
}

function rejection(kind, problems, template) {
  return problems.length === 0
    ? { ok: true }
    : { ok: false, reason: `${kind} handoff ${problems.join("; ")}: fill ${template} instead of hand-writing the handoff` };
}

// The calling-seat identity rule both runtimes' handoff hooks share: why the identity is unreadable, or null.
/** @type {(caller: { callerType?: unknown, hasCallerId?: unknown }) => string | null} */
export function callerIdentityProblem({ callerType, hasCallerId }) {
  const callerAbsent = callerType === undefined || callerType === "";
  if ((callerAbsent && hasCallerId)
    || (!callerAbsent && (typeof callerType !== "string" || callerType !== callerType.trim()))) {
    return "agent handoff requires a readable calling-seat identity";
  }
  return null;
}

export function checkHandoff(toolInput, callerContext = {}) {
  const identityProblem = callerIdentityProblem(callerContext);
  if (identityProblem) return { ok: false, reason: identityProblem };
  const callerType = callerContext.callerType;
  const type = toolInput?.subagent_type;
  if (["architect", "oracle", "security-reviewer"].includes(callerType) && type !== "explorer") {
    return { ok: false, reason: `${callerType} may start only explorer helpers` };
  }
  const prompt = typeof toolInput?.prompt === "string" ? toolInput.prompt : "";

  if (BUILDER_SEATS.includes(type)) {
    const problems = [];
    if (SELF_MUTATION_RE.test(prompt)) {
      problems.push("instructs self-mutation-testing (the revert cycle is the orchestrator's convergence step)");
    }
    problems.push(
      ...unfilledSlotProblems(prompt),
      ...missingLineProblems(prompt, BUILDER_REQUIREMENTS, { "Construction mode": MODE_RULE }),
    );
    const mode = requirementValue(prompt, "Construction mode");
    if (mode !== null && !CONSTRUCTION_MODES.has(mode)) {
      problems.push(`construction mode must be ${MODE_RULE}, received '${mode}'`);
    }
    if (mode === "strict-tdd") problems.push(...strictStageProblems(prompt));
    const command = requirementValue(prompt, "Focused verification command");
    if (command !== null && isPlaceholder(command)) {
      problems.push("focused verification command is a placeholder: name the exact command the builder runs");
    }
    return rejection("builder", problems, ".agents/templates/builder-handoff.md");
  }

  if (type === "architect") {
    const problems = [...missingLineProblems(prompt, ARCHITECT_REQUIREMENTS), ...unfilledSlotProblems(prompt)];
    return rejection("architect", problems, ".agents/templates/planner-handoff.md");
  }
  return { ok: true };
}
