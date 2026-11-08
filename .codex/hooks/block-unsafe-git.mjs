#!/usr/bin/env node
// PreToolUse(Bash) guard — stop Codex bypassing the local gates.
// Governs Codex's Bash tool calls ONLY (a manual commit in your own terminal is not a
// tool call), so your escape hatch survives. It is not a security boundary: the head of
// scripts/lib/unsafe-git.mjs says what does and does not limit a push. blockReason() judges the
// command using its checkout and the session's run restrictions. The run can be marked by the
// launcher or bound to a native app session. A failed native lookup cannot drop those restrictions.
import { fileURLToPath } from "node:url";
import { blockReason } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";
import { CODEX_APP_RUN_UNAVAILABLE, codexCommandForGuard, codexCwdForGuard, readCodexAppRun } from "../../scripts/lib/codex-hook-adapters.mjs";

const operatingRoot = fileURLToPath(new URL("../..", import.meta.url));

function refuse(reason, terminalHint = false) {
  const hint = terminalHint ? " Guards Codex's tool calls only; run it in your own terminal if you truly need it." : "";
  console.error(`Blocked: ${reason}.${hint}`);
  process.exit(2);
}

function refusePreApproved(why) {
  refuse(`a pre-approved run session ${why}`);
}

// Only a pre-approved session needs the tracker, so only it loads the board configuration.
async function preApprovedOptions(start, appJob) {
  if (start === undefined) return null;
  try {
    const { TRACKER } = await import("../../scripts/lib/board-config.mjs");
    return { start, tracker: TRACKER ?? "github", appJob };
  } catch {
    return refusePreApproved("publishes nothing: the board configuration could not be loaded to name this repository's tracker");
  }
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Classify from the session anchor even when the command payload cannot be parsed.
  }
  let sessionCwd;
  try {
    sessionCwd = process.cwd();
  } catch {
    // A removed session directory leaves an unavailable anchor.
  }
  const connection = readCodexAppRun({ sessionCwd, payload, operatingRoot });
  const runUnavailable = connection?.runUnavailable;
  const appJob = connection?.kind === "pre-approved" ? { card: connection.card, worktree: connection.worktree } : undefined;
  const preApprovedStart = connection === null ? process.env.PRE_APPROVED_RUN_SESSION : appJob && connection.runStart;

  if (payload === undefined) {
    if (runUnavailable) refuse(runUnavailable);
    if (preApprovedStart !== undefined) refusePreApproved("is refused a call whose hook payload is unparseable");
    // An ordinary session stays available when the hook payload format changes, with an advisory.
    console.error("block-unsafe-git: unparseable hook payload — rules NOT applied to this call.");
    process.exit(0);
  }

  const cmd = codexCommandForGuard(payload?.tool_input);
  if (cmd === "" && connection !== null) {
    refuse(connection.kind
      ? "a native app run session is refused a call whose hook payload holds no string command"
      : CODEX_APP_RUN_UNAVAILABLE);
  }
  const { checkout, unresolved } = checkoutContext(codexCwdForGuard(payload) || sessionCwd);
  if (unresolved) {
    const message = connection === null ? unresolved : "git cannot resolve the command working directory";
    console.error(`block-unsafe-git: ${message} — the integration-checkout rule is NOT applied to this call.`);
  }
  if (cmd === "" && preApprovedStart !== undefined) refusePreApproved("is refused a call whose hook payload holds no string command");
  const reason = blockReason(cmd, checkout, {
    runSession: connection === null ? process.env.PRODUCT_MANAGER_RUN_SESSION === "1" : connection.kind === "product-manager",
    preApproved: await preApprovedOptions(preApprovedStart, appJob),
    appRun: Boolean(connection?.kind),
    runUnavailable,
  });
  if (reason) refuse(reason, connection === null);
  process.exit(0);
});
