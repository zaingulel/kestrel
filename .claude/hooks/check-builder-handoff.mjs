#!/usr/bin/env node
// PreToolUse(Agent) guard: fails closed on unreadable envelopes and forwards runtime caller identity
// separately from the child request. Shared handoff logic and tests live in scripts/lib/handoff-check.mjs;
// exit 2 blocks the request. A strict implementation handoff is also checked against the run log of the job
// worktree the envelope's cwd is in, its top level and branch read from git, never from the handoff.
import { spawnSync } from "node:child_process";
import { BUILDER_SEATS, checkHandoff, needsRecordedRed, recordedRedProblem } from "../../scripts/lib/handoff-check.mjs";
import { gitExecutable } from "../../scripts/lib/posix-shell.mjs";

/** @type {(reason: string) => never} */
const block = (reason) => {
  console.error(`Blocked: ${reason}.`);
  process.exit(2);
};

// The verified job worktree of `cwd` as { worktree, branch }, branch empty on a detached head, or a reason string.
function verifiedWorktree(cwd) {
  const unreadable = (cause) => `the builder handoff guard could not read the job worktree of ${cwd}: ${cause}`;
  if (typeof cwd !== "string" || cwd === "") return "the builder handoff guard could not read the job worktree: the hook envelope carries no cwd";
  // By path on Windows, whose bare-name search reaches the working directory first.
  const git = gitExecutable();
  if (!git) return unreadable("no git.exe in an absolute PATH entry");
  const read = (args) => spawnSync(git, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const top = read(["rev-parse", "--show-toplevel"]);
  const branch = read(["branch", "--show-current"]);
  for (const run of [top, branch]) {
    if (run.error) return unreadable(/** @type {NodeJS.ErrnoException} */ (run.error).code ?? run.error.message);
    if (run.status !== 0) return unreadable(`git exited ${run.status ?? run.signal}`);
  }
  const worktree = top.stdout.trim();
  return worktree ? { worktree, branch: branch.stdout.trim() } : unreadable("git printed no top level");
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let envelope;
  try { envelope = JSON.parse(raw); } catch { envelope = null; }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    block("agent handoff requires a readable calling-seat identity");
  }
  const res = checkHandoff(envelope.tool_input, {
    callerType: envelope.agent_type,
    hasCallerId: Object.hasOwn(envelope, "agent_id"),
  });
  if (!res.ok) block(/** @type {string} */ (res.reason));
  const prompt = envelope.tool_input?.prompt;
  if (BUILDER_SEATS.includes(envelope.tool_input?.subagent_type) && needsRecordedRed(prompt)) {
    const verified = verifiedWorktree(envelope.cwd);
    if (typeof verified === "string") block(verified);
    const problem = recordedRedProblem(prompt, verified);
    if (problem) block(problem);
  }
  process.exit(0);
});
