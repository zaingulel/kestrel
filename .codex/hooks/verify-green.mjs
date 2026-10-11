#!/usr/bin/env node
// Stop hook launcher — runs verify-green.sh beside it through a POSIX shell.
// Codex on native Windows runs hook commands in PowerShell, which cannot run a `.sh` file, so the
// hook command is this Node file instead. It adds no gate logic: stdio is inherited and the shell's
// exit status is the hook's, so every Stop-gate outcome is the script's own. When no shell can be
// started it blocks (exit 2) with the remedy rather than letting the gate pass unchecked.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { posixShell } from "../../scripts/lib/posix-shell.mjs";

const script = fileURLToPath(new URL("./verify-green.sh", import.meta.url));
const shell = posixShell();
const result = shell && spawnSync(shell, [script], { stdio: "inherit" });

if (!result || result.error) {
  console.error("Stop gate: no POSIX shell found; install Git for Windows");
  process.exit(2);
}
// A signal-killed shell has no exit status; passing it as 0 would skip the gate in silence.
if (result.status === null) {
  console.error(`Stop gate: verify-green.sh was killed by ${result.signal} before it finished`);
  process.exit(2);
}
process.exit(result.status);
