---
name: tdd
description: The test-first method for building a feature or fixing a bug at our bar: red-green in vertical slices, deterministic where possible, mutation-proven, non-tautological, tested at the real interface. The builder reads this before writing tests; invoke "/tdd" to apply it directly.
---

This is the METHOD; the acceptance BAR lives in `docs/TESTING-STRATEGY.md`, which owns WHICH evidence a claim
needs. In PLANNING it is a design lens: pick the seam, name the failing test and where its expected value comes
from independently, and treat hard-to-test as a design smell. In BUILDING it is the loop below. In REVIEW it is an
adversarial audit: attack each new test against the anti-patterns and confirm it is mutation-proven.

## The loop (red then green, one slice at a time)

Applies in full when strict test-first sequencing is selected under the testing-strategy authority; a builder
outside that selection chooses its construction order but owes the same final evidence — a named red observation or
an executed mutation proof with expected values from an independent oracle.

- **Red before green.** Write ONE failing test, then only enough code to pass it.
- **Vertical slices.** One seam, one test, one minimal implementation, repeat; never all the tests up front. The
  first slice is a tracer bullet: one path end-to-end, then build outward.
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
- **Mutation-proven.** Break the thing on purpose, confirm RED, restore.

## Anti-patterns (the three ways a test lies)

- **Implementation-coupled:** asserts internals or a side channel; tell: breaks on a refactor with behaviour
  unchanged.
- **Tautological:** the expected value is recomputed the way the code computes it. Expected values come from an
  INDEPENDENT source: a hand-computed literal, a worked example, the spec.
- **Horizontal slicing:** all tests first, then all code.

## Mocking

Mock only at real system boundaries (external APIs, the clock, randomness); never your own code or internal
collaborators.

## Acceptance

Clear the bar AGENTS.md's "Coding standards and the executed test bar" points to; `npm test` and `npm run lint` green. Then hand to
review and Simplify.
