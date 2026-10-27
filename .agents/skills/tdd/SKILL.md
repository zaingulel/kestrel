---
name: tdd
description: The test-first method for building a feature or fixing a bug at our bar: red-green in vertical slices, deterministic where possible, with discrimination evidence selected by the testing strategy, non-tautological, tested at the real interface. The builder reads this before writing tests; invoke "/tdd" to apply it directly.
---

This is the METHOD; the acceptance BAR lives in `docs/TESTING-STRATEGY.md`, which owns WHICH evidence a claim
needs. In PLANNING it is a design lens: pick the seam, name the failing test and where its expected value comes
from independently, and treat hard-to-test as a design smell. In BUILDING it is the loop below. In REVIEW it is an
adversarial audit: attack each new test against the anti-patterns and check the discrimination proof the authority
selects.

## The loop (red then green, one slice at a time)

Applies in full when strict test-first sequencing is selected under the testing-strategy authority; a builder
outside that selection follows its handed-off construction mode and owes the final discrimination evidence
`docs/TESTING-STRATEGY.md` selects, with expected values from an independent oracle. Permission to group focused
evidence does not change the strict test-first learning cycle below.

- **Meaningful red before green.** For one coherent claim, write the smallest focused set of cases needed to
  expose it, with independently fixed expectations, and run it through `node scripts/run-log.mjs`. The local
  testing strategy owns qualifying behavioural red, including its production-import distinction, and absent-baseline
  alternatives. Follow `resume`'s staged dispatch under "5. Build": the test-only handoff ends at meaningful
  expected red, and implementation starts only after coordinator validation with the test contract fixed.
  An incorrect oracle returns for revalidation and an explicit revised contract.
- **Green.** In the implementation stage, write only enough code to pass the validated case set.
- **Vertical slices.** One coherent claim's focused case set, then its minimal implementation, repeat. A claim
  may contain related material behaviours or cases; additional assertions or related cases alone do not create
  another checkpoint. Independently distinct safeguards or claims start their own cycle. Preserve the validated
  test contract and expectations. The first slice is a tracer bullet: one path end-to-end, then build outward.
- **Refactor only after green**, as the separate Simplify step.

## What a good test is

- **Tests behaviour through the real public interface**: at the evidence route `docs/TESTING-STRATEGY.md` names
  for this claim (the driven UI, or the function that owns the rule), never a private detail; it survives an
  internal rename.
- **Deterministic wherever possible.** Seed randomness (keep draw-order parity), pin dates and fixtures, no
  wall-clock or network. Validate REAL behaviour against the real fixtures the `fixtures` row of the
  Conventions table in `.agents/REPOSITORY.md` names, never a synthetic one.
- **Asserts the actual promise, not a structural proxy.** For visual promises — order, placement, visibility —
  assert the RENDERED result (computed style, bounding box, `toBeVisible`), never DOM order or an attribute.
- **Rejects plausible wrong behaviour.** Meet `docs/TESTING-STRATEGY.md`'s selected proof; the orchestrator validates qualifying
  ordinary red-green evidence and performs required convergence mutations.

## Anti-patterns (the three ways a test lies)

- **Implementation-coupled:** asserts internals or a side channel; tell: breaks on a refactor with behaviour
  unchanged.
- **Tautological:** the expected value is recomputed the way the code computes it. Expected values come from an
  INDEPENDENT source: a hand-computed literal, a worked example, the spec.
- **Horizontal slicing:** batching tests for unrelated claims or independently distinct safeguards before
  implementing any of them, instead of completing one coherent claim's red-then-green cycle.

## Mocking

Mock only at real system boundaries (external APIs, the clock, randomness); never your own code or internal
collaborators.

## Acceptance

Report the handed-off stage honestly: expected red is the completed test-only stage, not completed implementation.
Completed implementation clears the focused checks and lint the handoff requires; the orchestrator owns broader
convergence and the local testing strategy's discrimination proof. Then hand to review and Simplify.
