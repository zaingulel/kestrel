#!/usr/bin/env node
// PermissionRequest and PostToolUse(AskUserQuestion|ExitPlanMode) hook: hands a coordinated Herdr job's menu to the owner's
// queue panel and ends the ask a call answers; no answer is recorded as approval. The logic and its tests live in
// scripts/lib/owner-menu.mjs; this file gives it the real git, hc, clock and sleep and prints what it returns.
import { execFile, execFileSync } from "node:child_process";
import { gitEnvironment } from "../../scripts/lib/factory-sync.mjs";
import { ownerMenu } from "../../scripts/lib/owner-menu.mjs";

const hc = (args) => new Promise((resolve) => {
  execFile("hc", args, { encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: stderr || (error?.message ?? "") });
  });
});

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let input;
  try { input = JSON.parse(raw); } catch { input = null; }
  const git = (args) => execFileSync("git", args, { cwd: input.cwd, env: gitEnvironment(), encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  const output = await ownerMenu(input, {
    env: process.env, git, hc, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (output !== undefined) console.log(JSON.stringify(output));
  process.exit(0);
});
