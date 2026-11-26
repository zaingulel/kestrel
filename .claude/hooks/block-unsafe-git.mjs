#!/usr/bin/env node
// PreToolUse(Bash) guard: apply Git refusals, then grant cleanup-specific permission only
// from this installed root. The classifier documents the accident-catcher's wider limits.
// The run's mark reaches the publishing rule here: PRE_APPROVED_RUN_SESSION=<run start> admits only the delivery forms of its own card,
// claimed by its GitHub account since the run start, while fetched-main waitForOwner is on-screen or when-needed,
// for a push while no own pull request from its branch is ready or queued and, for a ready or merge,
// while no wait reason holds for HEAD or the published body and its card does not carry show-me-first,
// unless the card's recorded owner answer admits that head. Under PRE_APPROVED_RUN_SESSION an unreadable
// call is refused, not passed. PRE_APPROVED_RUN_CARD, which a lead sets on a continue session, binds that session to
// the one card it names. FABRAIK_COORDINATED_JOB=1, which a Herdr coordinator sets on the job it starts, makes the
// guard take the Herdr exact path, where no comment or note ever admits a held head, and makes every publish and
// merge watch first verify the job's workflow version, FABRAIK_WORKFLOW_ROOT, whole.
// A session the desktop app started in its sidebar has no such environment, so with no mark in the
// environment the first is read as a whole line of the first message of the transcript the payload
// names. In the desktop app a first message that cannot be read refuses every publish.
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { blockReason, cleanupPermission } from "../../scripts/lib/unsafe-git.mjs";
import { checkoutContext } from "../../scripts/lib/checkout-context.mjs";
import { fileRunMarks } from "../../scripts/lib/run-marks.mjs";
import { verifyJobPin, workflowRoots } from "../../scripts/lib/workflow-pin.mjs";

const installedRoot = workflowRoots(import.meta.url).operating;

const environmentMarks = {
  preApprovedStart: process.env.PRE_APPROVED_RUN_SESSION,
  boundCard: process.env.PRE_APPROVED_RUN_CARD,
  coordinated: process.env.FABRAIK_COORDINATED_JOB === "1",
};
const environmentMarked = environmentMarks.preApprovedStart !== undefined;
const inDesktopApp = process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";

/** @returns {never} */
function refusePublishing(session, why) {
  console.error(`Blocked: ${session} ${why}.`);
  process.exit(2);
}

// This session's marks: the environment's where it holds one, else its first message's. Outside the desktop
// app no session is started with a mark in its first message, so one that cannot be read there is unmarked.
function sessionMarks(payload) {
  if (environmentMarked) return environmentMarks;
  const path = payload?.transcript_path;
  const marks = typeof path === "string" && path.length > 0 ? fileRunMarks(path) : { unreadable: "the hook payload names no transcript" };
  return marks.unreadable && !inDesktopApp ? {} : marks;
}

// The session that may publish, or whose mark cannot be read, as its refusals name it.
function publishingSession(marks) {
  if (marks.preApprovedStart !== undefined) return "a pre-approved run session";
  return marks.unreadable ? "a desktop app session whose run mark cannot be read" : null;
}

// Only a pre-approved session needs the tracker, so only it loads the board configuration.
async function preApprovedOptions(start, boundCard, coordinated, verifyPin) {
  if (start === undefined) return null;
  try {
    const { TRACKER } = /** @type {{ TRACKER?: string }} */ (await import("../../scripts/lib/board-config.mjs"));
    return { start, tracker: TRACKER ?? "github", boundCard, coordinated, verifyJobPin: verifyPin };
  } catch {
    return refusePublishing("a pre-approved run session", "publishes nothing: the board configuration could not be loaded to name this repository's tracker");
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
    const session = publishingSession(sessionMarks(null));
    if (session) refusePublishing(session, "is refused a call whose hook payload is unparseable");
    console.error("block-unsafe-git: unparseable hook payload; rules NOT applied to this call.");
    process.exit(0);
  }
  const marks = sessionMarks(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.tool_input?.command !== "string") {
    const session = publishingSession(marks);
    if (session) refusePublishing(session, "is refused a call whose hook payload holds no string command");
    console.error("block-unsafe-git: no string command in hook payload; rules NOT applied to this call.");
    process.exit(0);
  }
  const cmd = payload.tool_input.command;
  const hasCwd = typeof payload.cwd === "string" && payload.cwd.length > 0;
  if (!hasCwd) console.error("block-unsafe-git: no string cwd; cleanup permission unavailable.");
  // The process directory preserves the existing Git-check fallback, never cleanup approval.
  const sessionCwd = hasCwd ? payload.cwd : process.cwd();
  const { checkout, unresolved } = checkoutContext(sessionCwd);
  if (unresolved) {
    console.error(`block-unsafe-git: ${unresolved.slice(0, 400)}; the integration-checkout rule is NOT applied to this call.`);
  }
  const reason = blockReason(cmd, checkout, {
    preApproved: await preApprovedOptions(marks.preApprovedStart, marks.boundCard, marks.coordinated === true,
      environmentMarks.coordinated ? ({ drift }) => verifyJobPin({ env: process.env, cwd: sessionCwd, drift }) : undefined),
    runMarkUnreadable: marks.unreadable ?? "",
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
