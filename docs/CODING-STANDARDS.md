# Kestrel coding standards

This document owns one question: how first-party code is written when it is written. These standards apply
prospectively, to code being written or next touched, and never authorise a repository-wide rename,
decomposition, typing, documentation, or comment campaign. They supplement, and never reopen, the
installed-copy, guard, test, review, and publication contracts.

- **Canonical names.** Use the domain glossary and existing local naming families; prefer a precise domain role
  over generic names such as Manager, Engine, Handler, Helper, or Utils.
- **Cohesion over size.** A function or module owns one coherent responsibility at its level. Extract only when it
  centralizes policy, creates a meaningful test seam, separates calculation from effects, or reduces what callers
  must know; size is a review signal, not an acceptance limit.
- **No dead code.** Keep the code free of dead paths, redundant guards, scaffolding, and needless duplication.
- **Explicit important boundaries.** An important boundary makes its accepted inputs, outputs, unavailable and
  no-op states, failures, and side effects explicit in the smallest reliable form; validate untrusted input and
  test the observable contract. This mandates no type system, docblock, wrapper, or documentation for every
  private helper.
- **Code explains what; comments preserve why.** Names, structure, test titles, and assertions carry ordinary
  behaviour; comments keep only the shortest load-bearing reason for a non-obvious invariant, unit, sentinel,
  intentional exception, side effect, external quirk, test-validity trap, or trade-off. Never preserve
  chronology, restate adjacent code, or impose comment quotas or arbitrary line limits.
- **Static checks cover every first-party runtime.** `eslint.config.mjs` owns the Node lint surface (scripts and
  modules in the hook directories); unused first-party variables are blocking unless they follow a documented
  intentional-discard convention. Keep correctness-oriented ESLint and Python Ruff F checks; the
  [testing strategy](TESTING-STRATEGY.md#6-local-suites) owns local and hosted invocation. A lint that is wrong
  for the code is allowed at its site with a one-line reason, never restructured around.
- **Byte-significant line endings.** The hook directories' own `.gitattributes` files and their invariant tests own
  the deterministic LF (line feed) policy for hook files; Kestrel has no exceptions.
- **Agent-facing commands are stable interfaces.** A command is deterministic and non-interactive, validates
  required values and rejects unknown or malformed arguments before external work, distinguishes success, no-op,
  valid zero, incomplete, and failure through authoritative exit status, and keeps default output bounded;
  mutations are restartable or idempotent where their semantics allow.
- **Test economics.** Reuse expensive fixtures through cloning where isolation and semantic equivalence are
  proven; construction-asserting and origin-sensitive tests keep fresh fixtures. Prefer injected execution seams
  for doubling external commands; where a real subprocess is the thing under test, keep the smallest
  representative positive-and-negative wire set per contract, and fakes avoid paying a full runtime boot per
  call. Pure logic gets direct unit tests, while a subprocess wrapper keeps at least one positive and one
  negative wire proof so a wrapper that never calls the logic cannot pass. A test file expected to dominate the
  suite's critical path is split by concern at birth, an advisory budget and never a wall-clock gate. New
  harness tests and machinery declare their recurring cost; how machinery enters and leaves is the machinery rule
  in the `resume` skill under "4. Plan".

## Python

Use type hints at important interfaces where they remove ambiguity. Hints do not validate runtime input:
validate worker JSON (JavaScript Object Notation), process output and audio metadata at their consuming boundary.

Give each asynchronous task, child process and temporary home an explicit owner, completion observer and cleanup
path, including failed startup. Retain task references until completion is observed. After cleanup, propagate
cancellation; shielding needs a reason tied to work that must finish and an owner that observes its completion.
Bound external operations, output and cleanup with appropriate deadlines and size limits while allowing intentional
supervised long-lived waits. For subprocesses, account separately for pipe drainage or closure, termination,
escalation to killing, and reaping; a timeout alone does not clean up the child, and unbounded buffering defeats
output limits. Remove owned temporary homes after their children exit.

Keep protocol standard output separate from diagnostic standard error. Preserve the isolated voice, recognition
and Hermes dependency environments described in [README.md](../README.md). Private application programming
interface access needs a short rationale and targeted compatibility checks on dependency or Python upgrades,
including wire checks for the existing `StreamReader._transport` use. Keep the existing test frameworks; the
[testing strategy](TESTING-STRATEGY.md) owns verification recipes and evidence selection.

## Node

Use ECMAScript modules and APIs compatible with the Node version range in `package.json`; check compatibility
before adopting newer APIs. Await asynchronous work through completion, including failure and cleanup, so the
command's exit status reflects its result. Execute external commands with an executable and argument array,
preserving literal argument boundaries. Distinguish malformed output, valid empty results, unavailable dependencies
and command failure at external boundaries; none silently becomes another's successful result. Keep the existing
`node:test` framework and strict assertions; verification follows the [testing strategy](TESTING-STRATEGY.md).

## Bash

Keep `run-voice.sh` minimal: quoted paths and expansions, environment setup and `exec` into the owned process.
When it changes, run `bash -n run-voice.sh` through the testing strategy's logged invocation without launching audio.
