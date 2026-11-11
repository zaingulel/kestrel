#!/usr/bin/env node
// PreToolUse(Bash) guard: apply Git refusals, then grant cleanup-specific permission only
// from this installed root. The classifier documents the accident-catcher's wider limits.
// The launcher's marks reach the publishing rule here: PRODUCT_MANAGER_RUN_SESSION=1 refuses every
// publish, PRE_APPROVED_RUN_SESSION=<run start> admits only a delivery push the owner's advance
// approval covers, and CARRIED_PUSH_YES=<card> admits only the delivery forms of the card whose yes
// the coordinator carried. Under either of the last two an unreadable call is refused, not passed.
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockReason, cleanupPermission } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";

const installedRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const preApprovedStart = process.env.PRE_APPROVED_RUN_SESSION;
const carriedPushYes = process.env.CARRIED_PUSH_YES;
// The session that may publish, named in its refusals; blockReason refuses a session holding both marks.
const publishingSession = preApprovedStart !== undefined ? "a pre-approved run" : carriedPushYes !== undefined ? "a carried push yes" : null;

function refusePublishing(why) {
  console.error(`Blocked: ${publishingSession} session ${why}.`);
  process.exit(2);
}

// Only a pre-approved session needs the tracker, so only it loads the board configuration.
async function preApprovedOptions() {
  if (preApprovedStart === undefined) return null;
  try {
    const { TRACKER } = await import("../../scripts/lib/board-config.mjs");
    return { start: preApprovedStart, tracker: TRACKER ?? "github" };
  } catch {
    return refusePublishing("publishes nothing: the board configuration could not be loaded to name this repository's tracker");
  }
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let payload;
  // Uninspectable input keeps existing Git checks fail-open, with a diagnostic, but can
  // never confer cleanup permission. There is no static cleanup allowance to fall back to.
  // A session that may publish is refused instead.
  try {
    payload = JSON.parse(raw);
  } catch {
    if (publishingSession) refusePublishing("is refused a call whose hook payload is unparseable");
    console.error("block-unsafe-git: unparseable hook payload; rules NOT applied to this call.");
    process.exit(0);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.tool_input?.command !== "string") {
    if (publishingSession) refusePublishing("is refused a call whose hook payload holds no string command");
    console.error("block-unsafe-git: no string command in hook payload; rules NOT applied to this call.");
    process.exit(0);
  }
  const cmd = payload.tool_input.command;
  const hasCwd = typeof payload.cwd === "string" && payload.cwd.length > 0;
  if (!hasCwd) console.error("block-unsafe-git: no string cwd; cleanup permission unavailable.");
  // The process directory preserves the existing Git-check fallback, never cleanup approval.
  const { checkout, unresolved } = checkoutContext(hasCwd ? payload.cwd : process.cwd());
  if (unresolved) {
    console.error(`block-unsafe-git: ${unresolved.slice(0, 400)}; the integration-checkout rule is NOT applied to this call.`);
  }
  const reason = blockReason(cmd, checkout, {
    runSession: process.env.PRODUCT_MANAGER_RUN_SESSION === "1",
    preApproved: await preApprovedOptions(),
    carriedYes: carriedPushYes === undefined ? null : { carried: carriedPushYes },
  });
  if (reason) {
    console.error(`Blocked: ${reason}. Guards Claude's tool calls only; run it in your own terminal if you truly need it.`);
    process.exit(2);
  }
  if (cleanupPermission(cmd, false) === "deny") {
    let trusted = false;
    let cause = "payload cwd is missing or is not a string";
    try {
      if (hasCwd) {
        const root = realpathSync(installedRoot);
        const cwd = realpathSync(payload.cwd);
        const processCwd = realpathSync(process.cwd());
        const context = checkoutContext(root);
        const helper = join(root, "scripts/closeout-cleanup.mjs");
        if (cwd !== root || processCwd !== root) cause = "payload and process cwd must both be the installed root";
        else if (!context.checkout?.isRootCheckout(root)) cause = "Git cannot identify the installed root as a main working tree";
        else if (realpathSync(helper) !== helper || !statSync(helper).isFile()) cause = "cleanup helper is redirected or is not a file";
        else trusted = true;
      }
    } catch {
      cause = "installed root, cwd or cleanup helper could not be resolved";
    }
    const permission = cleanupPermission(cmd, trusted);
    if (permission === "deny") {
      console.error(`Blocked: cleanup requires the current trusted root ${installedRoot}: ${cause}. Run a current verified helper from that root, or, if the root is not current, invoke the current verified helper by absolute path under ordinary runtime review.`);
      process.exit(2);
    }
    if (permission === "allow") {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Cleanup runs the verified helper in the trusted root ${installedRoot}`,
        },
      }));
    }
  }
  process.exit(0);
});
