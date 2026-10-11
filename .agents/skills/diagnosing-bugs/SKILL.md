---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions in this repository. Use when the owner says "diagnose"/"debug this", or reports something broken, throwing, slow, or silently showing wrong numbers or blank output.
---

# Diagnosing Bugs

A discipline for hard bugs; skip phases only when explicitly justified. Frame the bug first: `GLOSSARY.md`,
the architecture documents `docs/README.md` indexes, and the applicable scoped rules.

## Redact

**Redact every secret before output leaves the terminal.** A secret is a token, API key, password, an
authentication header (e.g. `Authorization`), or a cookie (e.g. `Cookie` / `Set-Cookie`); these show up around
any live provider connection. This applies to output shown to the owner, pasted evidence, network
captures and HAR files, issue comments, and pull request bodies; replace each secret with `<REDACTED>`. A
network capture or HAR file carries auth headers and cookies, so quote only the redacted lines that carry the
signal, and never attach or commit a raw capture. Keep credentials in environment variables, and have the loop's
own script or test read the variable itself (e.g. `process.env.TOKEN`); never type the literal value into a
command, and never expand it into a command's arguments (`"$TOKEN"` on a command line), where a process listing
exposes it. This keeps the secret out of pasted invocations and shell history.

## Phase 1: Build a feedback loop

**This is the skill.** A **tight** pass/fail signal that goes red on _this_ bug finds the cause; without one,
staring at code will not. Spend disproportionate effort here. Be aggressive; refuse to give up.

Ways to construct one, roughly in order:

1. **Failing test** at the evidence route `docs/TESTING-STRATEGY.md` names for this claim, interaction-based for
   a UI bug.
2. **Fixture swap** per the `fixtures` row of the Conventions table in `.agents/REPOSITORY.md`: real fixtures for real
   behaviour, synthetic ones only for unit-shape tests. Never validate real behaviour against a synthetic fixture.
3. **Console/network capture in the headless run** (`page.on('console')` / `page.on('pageerror')`); redact
   captured headers and cookies before quoting.
4. **Throwaway harness**: a minimal script calling the function that owns the rule directly with hand-built
   input, isolated from the DOM.
5. **Property / fuzz loop** for "sometimes wrong output": many random or boundary inputs.
6. **Bisection harness** for a regression between two commits (`git bisect run`).
7. **Differential loop**: the same input through pre- and post-change build, diff the output.
8. **HITL scratchpad script** (last resort, human must click): a small bash script in the scratchpad with
   `step "<instruction>"` / `capture VAR "<question>"` helpers; redact the KEY=VALUE lines before showing or
   recording them; `capture` never asks the owner to type a secret, a credential comes from an environment
   variable instead.

**Tighten the loop:** faster (run one spec), sharper (assert the specific symptom), more deterministic (pin
dates, seed randomness, committed fixture, no wall clock or network). Credentials come from environment
variables, read by the loop itself, never inline in or expanded into a command. For non-deterministic bugs,
raise the reproduction rate until debuggable.
If you genuinely cannot build a loop: stop, list what you tried, and ask the owner for the reproducing input, a
redacted recording, or permission to instrument; do not hypothesise without a loop.

**Completion criterion:** one named command, already run at least once (paste invocation and redacted output),
that is red-capable (drives the actual bug path and asserts the owner's exact symptom), deterministic (or pinned
high reproduction rate), fast (seconds), and agent-runnable. No red-capable command, no Phase 2.

## Phase 2: Reproduce + minimise

Run the loop red. Confirm it produces the failure mode the owner described (wrong bug = wrong fix), reproducibly,
with the exact symptom captured. Then shrink to the smallest scenario that still goes red — cut input rows, filter
state, UI steps, config one at a time, re-running after each cut; prefer trimming toward an existing fixture
shape. Done when every remaining element is load-bearing. Do not proceed until reproduced and minimised.

## Phase 3: Hypothesise

Generate 3-5 ranked hypotheses before testing any. **Third-party symptom? Search it first**: if the loop surfaced
a VENDOR system's own error string, `WebSearch`/`WebFetch` that exact string against official docs and community
before hypothesising a code fix — a stalled third-party bug is often a documented limitation with no code fix.
(The vendor's real string often appears only after Phase 4 instrumentation exposes it beneath our internal code.)
Official sources first; unresolved threads are leads; check dates — a documented limitation may since be fixed.

Each hypothesis must be falsifiable: "If <X> is the cause, then <changing Y> makes the bug disappear / <changing
Z> makes it worse." No prediction → discard or sharpen. Show the ranked list to the owner before testing (they
re-rank instantly; don't block if away). If any hypothesis touches a surface in the `plan-first`
row of the Surfaces table in `AGENTS.md`, flag now: that fix is plan-first, with any further gate the Surfaces
table names.

## Phase 4: Instrument

Each probe maps to a specific prediction; change one variable at a time. Prefer a direct call to the suspect
function outside the DOM; else targeted `console.log` at the boundaries that distinguish hypotheses;
never "log everything and grep". Tag every debug log with a unique prefix (`[DEBUG-a4f2]`) so cleanup is one grep.
For performance regressions: measure with `performance.now()` or the profiler, then bisect — measure first, fix
second; record redacted evidence on the active board issue.

## Phase 5: Fix + regression test

Write the regression test before the fix, per `/tdd`, but only at a **correct seam**: one exercising the real bug
pattern at the real interface (at the evidence route `docs/TESTING-STRATEGY.md` names for this claim,
interaction-based for a UI bug). A security/privacy/honesty-invariant fix needs a banner comment naming the
defect, in the same change.

With a correct seam: turn the minimised repro into a failing test, watch it fail, fix, watch it pass, re-run the
Phase 1 loop against the original scenario, regenerate any artifact the Conventions table's `generated artifacts`
row names together with its source, then `npm run lint` and `npm test` green. **If no correct seam exists, that
is the finding**: note it, don't force a shallow test; recommend `/improve-codebase-architecture` to the owner
(user-invoked — surface it, don't fire it).

## Phase 6: Cleanup + post-mortem

Before declaring done: original repro no longer reproduces; regression test passes (or the seam absence is
documented and handed to `/improve-codebase-architecture`); all `[DEBUG-...]` instrumentation removed (grep the
prefix); throwaway harnesses deleted from the scratchpad; `npm test` + `npm run lint` green ("Tests: N pass"); the
correct hypothesis stated in the commit or report. Then ask what would have prevented the bug; if the answer is
architectural, recommend `/improve-codebase-architecture` after the fix is in.
