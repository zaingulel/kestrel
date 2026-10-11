#!/usr/bin/env node
// PreToolUse(Agent) guard - enforces shared prompt-side contracts for delegated
// builders and architect/planning handoffs. Logic + tests live in scripts/lib/handoff-check.mjs
// (mirrors the block-unsafe-git.mjs idiom: fail-open on parse trouble, exit 2 to block).
import { checkHandoff } from "../../scripts/lib/handoff-check.mjs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw)?.tool_input; } catch { process.exit(0); }
  const res = checkHandoff(input);
  if (!res.ok) {
    console.error(`Blocked: ${res.reason}.`);
    process.exit(2);
  }
  process.exit(0);
});
