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
//      orchestrator's convergence step; a builder capped mid-cycle ships mutated source).
// Every failed check is reported together in one rejection, so a session fixes the handoff in one re-send.
// Architect handoffs: a filled copy of .agents/templates/planner-handoff.md.
// Any other agent type passes through untouched.

const SELF_MUTATION_RE =
  /(?:verify|prove|re-?prove|check)\s+(?:the\s+|your\s+(?:own\s+)?)?mutation[- ]sensitivity|re-?prove\s+your\s+own\s+test/i;
const UNFILLED_TEMPLATE_SLOT_RE = /{{[A-Z][A-Z0-9_]*}}/g;
const CONSTRUCTION_MODES = new Set(["strict-tdd", "evidence-required", "preservation"]);
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

function requirementValue(prompt, requirement) {
  const prefix = `${requirement}:`;
  const lines = prompt.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  const value = lines[0].slice(prefix.length).trim();
  return value || null;
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

export function checkHandoff(toolInput) {
  const prompt = typeof toolInput?.prompt === "string" ? toolInput.prompt : "";
  const type = toolInput?.subagent_type;

  if (type === "builder" || type === "builder-max" || type === "builder-lite") {
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
