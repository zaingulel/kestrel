#!/usr/bin/env node
// PreToolUse(Bash) cost filter — rewrite a test-runner call so a GREEN run reaches agent context
// as a summary while a RED run passes through in full. The rule logic is pure and unit-tested —
// see rewriteTestCommand() in scripts/lib/test-output-filter.mjs; this file is just the
// stdin/stdout shell, mirroring block-unsafe-git.mjs.
//
// Recurring cost: one node process + one temp file per intercepted test run (sub-second).
// Removal condition: remove when the agent harness filters runner output natively, or when the
// hook is retired from .claude/settings.json.
import { rewriteTestCommand } from '../../scripts/lib/test-output-filter.mjs';

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let toolInput = null;
  // Unparseable stdin = the harness payload shape changed. Say so and leave the command alone;
  // an unfiltered run only costs context.
  try {
    toolInput = JSON.parse(raw)?.tool_input;
  } catch {
    console.error("filter-test-output: unparseable hook payload — command NOT filtered.");
    process.exit(0);
  }
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) process.exit(0);
  const rewritten = rewriteTestCommand(toolInput.command ?? "");
  if (!rewritten) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // updatedInput REPLACES the whole tool input, so every other field must be carried over
      // or a long run silently loses its timeout, run_in_background, and description.
      updatedInput: { ...toolInput, command: rewritten },
    },
  }));
});
