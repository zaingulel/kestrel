#!/usr/bin/env node
// PreToolUse(Bash) guard — stop Codex bypassing the local gates.
// Governs Codex's Bash tool calls ONLY (a manual commit in your own terminal is not a
// tool call), so your escape hatch survives. It is not a security boundary: the head of
// scripts/lib/unsafe-git.mjs says what does and does not limit a push. The rule logic itself
// is pure and unit-tested — see blockReason() in scripts/lib/unsafe-git.mjs; this file is just
// the stdin/stderr/exit-code shell, plus the one fact only a shell can supply: whether the
// call's working directory is the root checkout (scripts/lib/checkout-context.mjs asks git),
// which the integration-checkout rule needs.
import { blockReason } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";
import { codexCommandForGuard, codexCwdForGuard } from "../../scripts/lib/codex-hook-adapters.mjs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let payload;
  // Unparseable stdin = the harness payload shape changed, NOT a command trying to sneak past:
  // there is no command to inspect. Failing CLOSED here would block every Bash call in the
  // session on a confusing error — a hard wedge, and this guard is an accident-catcher, not a
  // security boundary. So stay open, but SAY SO: the old
  // bare `exit(0)` disabled the gate in silence, which is the half of CodeRabbit's #408 finding
  // that is true regardless of which way the availability call goes.
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error("block-unsafe-git: unparseable hook payload — rules NOT applied to this call.");
    process.exit(0);
  }
  // The hook process runs in the session's working directory, so it is the fallback when the
  // payload names none. Same fail-open-and-say-so posture as above.
  const { checkout, unresolved } = checkoutContext(codexCwdForGuard(payload) || process.cwd());
  if (unresolved) {
    console.error(`block-unsafe-git: ${unresolved} — the integration-checkout rule is NOT applied to this call.`);
  }
  const reason = blockReason(codexCommandForGuard(payload?.tool_input), checkout);
  if (reason) {
    console.error(`Blocked: ${reason}. Guards Codex's tool calls only; run it in your own terminal if you truly need it.`);
    process.exit(2);
  }
  process.exit(0);
});
