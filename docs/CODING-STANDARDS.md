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
  modules in the hook directories); unused first-party
  variables are blocking unless they
  follow a documented intentional-discard convention. The hosted quality lane runs Python Ruff F checks over
  `bot.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py` and `tests/` for undefined names, unused imports and related Pyflakes errors. A lint that is wrong for the code is allowed at its site
  with a one-line reason, never restructured around.
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
