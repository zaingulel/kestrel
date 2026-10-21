#!/usr/bin/env node
// PreToolUse(Bash) guard: apply Git refusals, then grant cleanup-specific permission only
// from this installed root. The classifier documents the accident-catcher's wider limits.
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockReason, cleanupPermission } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";

const installedRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let payload;
  // Uninspectable input keeps existing Git checks fail-open, with a diagnostic, but can
  // never confer cleanup permission. There is no static cleanup allowance to fall back to.
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error("block-unsafe-git: unparseable hook payload; rules NOT applied to this call.");
    process.exit(0);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.tool_input?.command !== "string") {
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
  const reason = blockReason(cmd, checkout);
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
