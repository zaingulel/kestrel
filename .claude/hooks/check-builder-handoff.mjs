#!/usr/bin/env node
// PreToolUse(Agent) guard: fails closed on unreadable envelopes and forwards runtime caller identity
// separately from the child request. Shared handoff logic and tests live in scripts/lib/handoff-check.mjs;
// exit 2 blocks the request.
import { checkHandoff } from "../../scripts/lib/handoff-check.mjs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let envelope;
  try { envelope = JSON.parse(raw); } catch { envelope = null; }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    console.error("Blocked: agent handoff requires a readable calling-seat identity.");
    process.exit(2);
  }
  const res = checkHandoff(envelope.tool_input, {
    callerType: envelope.agent_type,
    hasCallerId: Object.hasOwn(envelope, "agent_id"),
  });
  if (!res.ok) {
    console.error(`Blocked: ${res.reason}.`);
    process.exit(2);
  }
  process.exit(0);
});
