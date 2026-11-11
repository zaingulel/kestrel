#!/usr/bin/env node
// Codex builder handoff guard, registered for every PreToolUse and for SubagentStart. The logic and its records
// live in codexHandoffHook (scripts/lib/codex-hook-adapters.mjs); exit 2 refuses the tool call.
import { codexHandoffHook } from "../../scripts/lib/codex-hook-adapters.mjs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  const { status, stdout, stderr } = await codexHandoffHook(raw);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = status;
});
