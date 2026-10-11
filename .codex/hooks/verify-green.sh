#!/bin/sh
# Stop hook — turn-end "green before done" gate: the product gate, then lint.
# Blocks the turn from finishing on a failed product check or a lint error, so "lint before done" is
# enforced at 100% instead of by memory. Tests stay at pre-push and CI — this hook lints only, to
# keep the per-turn cost in seconds.
# First, an executable scripts/gates/stop (the product gate) runs on every Stop, its output on stderr;
# it owns its own trigger. Lint then runs only when src/ has pending changes, so conversation-only
# and docs-only turns are untouched by it. A change outside `src/` gets no Stop-time lint; pre-push
# and CI lint it.
#
# One convention for a deliberate pass, shared with the Claude twin:
#   exit 0, silent        — nothing to verify (recursion re-entry, no pending src/ change);
#                           an absent product gate changes nothing, and a passing one adds only its own output
#   exit 0, stated reason — could not verify (no Git work tree, a root git cannot inspect, a
#                           required tool absent, or lint unable to evaluate): the applicable
#                           observation did not complete, and stderr says so; a product gate that
#                           could not verify states its own reason and exits 0
#   exit 2, stated reason — verified and failed, including a product gate that exited non-zero or is
#                           not executable, or a resolved root that cannot be entered
input=$(cat)

# Avoid the Stop-hook infinite loop: if we already forced one continuation, let it stop.
case "$input" in *'"stop_hook_active"'*true*) exit 0 ;; esac

# Codex runs Stop hooks from the event process working directory, so resolve the repository that
# directory belongs to and work from there. Relative to a subdirectory `-- src` matched nothing,
# and the gate passed on exactly the change it exists to check.
if ! root=$(git rev-parse --show-toplevel 2>/dev/null) || [ -z "$root" ]; then
  echo "Stop gate: no Git work tree resolved here." >&2
  exit 0
fi
# A resolved root we cannot enter fails CLOSED: inside a repository there is something to guard.
cd "$root" || { echo "Stop gate: cannot enter repository root $root." >&2; exit 2; }
# The product gate owns its own trigger, so it runs on every Stop that reaches here. A lost file
# mode must not silently switch the product checks off, so a non-executable gate blocks.
gate="$root/scripts/gates/stop"
if [ -e "$gate" ]; then
  [ -x "$gate" ] || { echo "Stop gate: $gate is not executable, so the product gate cannot run. Fix: chmod +x $gate" >&2; exit 2; }
  "$gate" >&2
  gate_status=$?
  if [ "$gate_status" -ne 0 ]; then
    echo "Stop gate: product gate scripts/gates/stop exited $gate_status. Fix before finishing." >&2
    exit 2
  fi
fi

# `git status … 2>/dev/null` alone cannot distinguish a clean tree from git FAILING (dubious
# ownership, a broken index). The root is already a proven work tree here, so this is defence in
# depth, kept identical to the Claude twin so a failure never reads as the silent verified pass.
if ! pending=$(git status --porcelain -- src 2>/dev/null); then
  echo "Stop gate: git could not inspect the resolved repository root, so the lint observation is unavailable." >&2
  exit 0
fi
[ -n "$pending" ] || exit 0
# The lint preconditions below run node, so without it the observation is unavailable, never a
# parse failure.
command -v node >/dev/null 2>&1 || { echo "Stop gate: node is not on PATH, so the lint observation is unavailable." >&2; exit 0; }
command -v npm >/dev/null 2>&1 || { echo "Stop gate: npm is not on PATH, so the lint observation is unavailable." >&2; exit 0; }
package_check=$(node -e '
  const fs = require("node:fs");
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lint = pkg?.scripts?.lint;
    process.exit(typeof lint === "string" && lint.trim() ? 0 : 3);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(2);
  }
' 2>&1)
package_status=$?
case "$package_status" in
  0) ;;
  3)
    echo "Stop gate: package.json has no declared lint script, so the lint observation is unavailable." >&2
    exit 0
    ;;
  *)
    printf 'Stop gate: package.json could not be read and parsed. Fix before finishing.\n%s\n' "$package_check" >&2
    exit 2
    ;;
esac
eslint_bin=""
eslint_dir=$root
while :; do
  if [ -x "$eslint_dir/node_modules/.bin/eslint" ]; then
    eslint_bin="$eslint_dir/node_modules/.bin/eslint"
    break
  fi
  eslint_parent=$(dirname "$eslint_dir")
  [ "$eslint_parent" = "$eslint_dir" ] && break
  eslint_dir=$eslint_parent
done
if [ -z "$eslint_bin" ]; then
  echo "Stop gate: the installed ESLint executable is unavailable, so the lint observation is unavailable." >&2
  exit 0
fi

out=$(npm run lint 2>&1)
lint_status=$?
[ "$lint_status" -eq 0 ] && exit 0
printf 'Stop gate: npm run lint exited %s. Fix before finishing.\n%s\n' "$lint_status" "$out" >&2
exit 2
