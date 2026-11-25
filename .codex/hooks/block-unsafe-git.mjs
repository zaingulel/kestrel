#!/usr/bin/env node
// @ts-nocheck
// PreToolUse(Bash) guard — stop Codex bypassing the local gates.
// Governs Codex's Bash tool calls ONLY (a manual commit in your own terminal is not a
// tool call), so your escape hatch survives. It is not a security boundary: the head of
// scripts/lib/unsafe-git.mjs says what does and does not limit a push. blockReason() judges the
// command using its checkout and the session's run restrictions. The run can be marked by the
// launcher or bound to a native app session. A failed native lookup cannot drop those restrictions.
// PRE_APPROVED_RUN_CARD, which a lead sets on a continue session, binds that session to the one card it names.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { blockReason } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";
import { CODEX_HERDR_BIND, bindCodexHerdrJob, codexCommandForGuard, codexCwdForGuard, readCodexAppRun, readCodexHerdrDeliveryBinding, readCodexHerdrTerminal } from "../../scripts/lib/codex-hook-adapters.mjs";

const operatingRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function refuse(reason, terminalHint = false) {
  const hint = terminalHint ? " Guards Codex's tool calls only; run it in your own terminal if you truly need it." : "";
  console.error(`Blocked: ${reason}.${hint}`);
  process.exit(2);
}

function refusePreApproved(why) {
  refuse(`a pre-approved run session ${why}`);
}

// Only a pre-approved session needs the tracker, so only it loads the board configuration.
async function preApprovedOptions(start, appJob, boundCard, codexHerdr) {
  if (start === undefined) return null;
  try {
    const { TRACKER } = await import("../../scripts/lib/board-config.mjs");
    return { start, tracker: TRACKER ?? "github", appJob, boundCard, codexHerdr };
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
  const herdr = readCodexHerdrTerminal({ operatingRoot });
  const connection = herdr ?? readCodexAppRun({ sessionCwd, payload, operatingRoot });
  let runUnavailable = connection?.runUnavailable;
  const appJob = connection?.kind === "pre-approved" ? { card: connection.card, worktree: connection.worktree } : undefined;
  const preApprovedStart = connection === null ? process.env.PRE_APPROVED_RUN_SESSION : appJob && connection.runStart;
  const boundCard = connection === null ? process.env.PRE_APPROVED_RUN_CARD : undefined;

  if (payload === undefined) {
    if (runUnavailable) refuse(runUnavailable);
    if (preApprovedStart !== undefined) refusePreApproved("is refused a call whose hook payload is unparseable");
    // An ordinary session stays available when the hook payload format changes, with an advisory.
    console.error("block-unsafe-git: unparseable hook payload — rules NOT applied to this call.");
    process.exit(0);
  }

  const cmd = codexCommandForGuard(payload?.tool_input);
  if (cmd === "" && connection !== null) {
    refuse(runUnavailable ?? "a native app run session is refused a call whose hook payload holds no string command");
  }
  const binding = herdr && (cmd === CODEX_HERDR_BIND || payload?.tool_input?.command === CODEX_HERDR_BIND);
  // Binding checks the actual integration root and never opens a cwd supplied by the submitted command.
  const { checkout, unresolved } = binding ? {} : checkoutContext(codexCwdForGuard(payload) || sessionCwd);
  if (unresolved) {
    const message = connection === null ? unresolved : "git cannot resolve the command working directory";
    console.error(`block-unsafe-git: ${message} — the integration-checkout rule is NOT applied to this call.`);
  }
  if (cmd === "" && preApprovedStart !== undefined) refusePreApproved("is refused a call whose hook payload holds no string command");
  let codexHerdr;
  if (herdr?.terminal && !binding) {
    try {
      codexHerdr = await readCodexHerdrDeliveryBinding({ herdr, payload, operatingRoot });
      runUnavailable = undefined;
    } catch (error) {
      runUnavailable = error.message;
    }
  }
  const reason = blockReason(cmd, checkout, {
    preApproved: await preApprovedOptions(codexHerdr?.runStart ?? preApprovedStart, appJob, boundCard, codexHerdr),
    appRun: Boolean(connection?.kind || codexHerdr),
    runUnavailable,
    herdrTerminal: Boolean(herdr?.terminal),
  });
  if (reason) refuse(reason, connection === null);
  if (binding) {
    const bindReason = await bindCodexHerdrJob({ herdr, payload, operatingRoot, sessionCwd });
    if (bindReason) refuse(bindReason);
  }
  process.exit(0);
});
