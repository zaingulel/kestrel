# Strict construction and clerical corrections

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

- **Strict construction has two handoffs.** For each `strict-tdd` claim, first dispatch a test-only handoff:
  its approved plan and file list allow evidence changes only, with independently grounded expectations and the
  failing observation to log: meaningful red, or the absence failure the plan declared under the local testing
  strategy's no-baseline alternative. When it returns, commit every change the stage made as one stage commit
  whose message names the claim and says it ends at expected red; the chronology audit under "6. Verify and
  review" reads that commit. Inspect the actual diff and run-log receipt before dispatching any
  implementation. Confirm the failure meets the local testing strategy's behavioural-red qualifications and
  comes from the claimed defect or missing safeguard, rather than the oracle, or is exactly the absence failure
  the plan declared. Confirm no implementation was slipped into the test-only stage. A red run that selected
  more or fewer tests than the frozen identities is rerun with the exact selection. A failure that does not
  qualify stops, before any implementation, for classification by the seat that wrote the plan: a genuinely
  absent baseline takes the strategy's no-baseline alternative as "4. Plan" says, so it never becomes a
  chronology gap. Before implementation dispatch, record the claim, accepted red receipt and coordinator
  validation verdict in the existing branch worklog, explicitly confirming that the inspected diff contains
  evidence-only changes. Carry that record into the implementation handoff with the validated test contract
  fixed: test identities, assertions, expected values and their source. Validate once per coherent claim or
  newly distinct safeguard, not per assertion. A newly discovered safeguard stops for classification before
  editing. An incorrect oracle stops for coordinator revalidation and an explicit revised contract before work
  resumes; a builder never quietly edits the frozen assertions to obtain green. The testing strategy owns
  qualifying evidence and alternative admissions; these stages change no mode or owner gate.
- **Review repairs.** A true review finding that a `strict-tdd` claim's safeguard is wrong or incomplete, or that
  a distinct behaviour of the claim has no test, is repaired through the same two handoffs: the test-only
  handoff writes the missing test and logs its red against the reviewed tree before any fix, and the
  implementation handoff follows validation. A strict repair never writes its test and fix in one handoff. A
  repair's new test that passes on the reviewed tree logs no red: the behaviour it covers was built before its
  test, which the chronology audit treats as code before red.
- **Clerical corrections.** After planning and required plan review are complete, the coordinator may authorize and
  record a clerical correction. This route is unavailable while owner approval of the completed plan is pending,
  whether from the optional gate or an owner instruction; it introduces no approval requirement when none applies
  and changes no work-pick meaning.

  Source evidence must prove equivalence to the already frozen intended invocation: effective executable,
  arguments, environment and full file/title identities. If that intention was not fixed, return to the seat
  that wrote the plan. Admit only literal spelling, path or shell-quoting repair within unchanged anchored
  exact-selection structure and frozen-set cardinality. Changes to anchors, alternation, regular-expression
  escaping semantics, globs, flags, configuration, environment prefixes or test population do not qualify.
  Quoting repairs must produce the effective arguments/environment already intended. Preserve outcome, scope,
  file list, observer, assertions, expected
  values, oracle, evidence order/timing, construction mode, reviews and owner decisions. Authorization wording
  and ambiguous meaning are excluded.

  Record old/new text, reason and identity proof in the existing worklog and revised handoff; provide that
  record to final review and summarize in the pull request. Builders perform file edits and cannot self-authorize.
  Uncertain equivalence returns to the seat that wrote the plan; incorrect oracles use existing coordinator
  revalidation and revised-contract steps. Existing required plan review and fresh final-tree review remain.
  Owner-requested preapproval revisions follow Plan
  approval.

  Invalid, misselected or collection-failure receipts supply no meaningful red. Strict construction requires
  the red the plan names, with the correct frozen identities and coordinator validation, before implementation.
  Correcting plan text does not invalidate an actually correct receipt; existing receipt policy applies.
  Implementation already completed without valid red goes to the chronology audit in Verify and review, which
  alone decides whether the gap is a slip; later checks cannot manufacture earlier evidence.
