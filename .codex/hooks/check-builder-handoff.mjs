#!/usr/bin/env node
// PreToolUse(collaborationspawn_agent) guard - enforces shared prompt-side contracts for delegated
// builders and architect/planning handoffs. Logic lives in scripts/lib/handoff-check.mjs;
// tests live in scripts/lib/handoff-check.test.mjs
// (mirrors the block-unsafe-git.mjs idiom: fail-open on parse trouble, exit 2 to block).
import { checkHandoff } from "../../scripts/lib/handoff-check.mjs";
import { codexHandoffForGuard, isOpaqueDispatchMessage } from "../../scripts/lib/codex-hook-adapters.mjs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw)?.tool_input; } catch { process.exit(0); }
  const handoff = codexHandoffForGuard(input);
  // Two independent reasons a live Codex dispatch cannot be validated: it carries no agent type to
  // branch on, and its body is encrypted. Either way, say so rather than exiting 0 as if the
  // contract had been enforced. The opaque-body test is what keeps a readable agent type over an
  // encrypted body from reaching checkHandoff and blocking every dispatch for required lines it
  // can never read; both operands take this same branch, so their order carries no meaning.
  if (isOpaqueDispatchMessage(handoff.prompt)
    || typeof handoff.subagent_type !== "string" || handoff.subagent_type === "") {
    console.error("Allowing dispatch: the handoff contract could not be validated from what this dispatch carries.");
    process.exit(0);
  }
  const res = checkHandoff(handoff);
  if (!res.ok) {
    console.error(`Blocked: ${res.reason}.`);
    process.exit(2);
  }
  process.exit(0);
});
