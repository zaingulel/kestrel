<!-- The owner reads this, not the diff. Write it for someone who checks wording and screenshots. Write it with the vendored `pr` skill into this template; the resume skill owns which wins where the two differ, under "7. Push authorisation". -->

## Summary

<!-- A few plain sentences on the problem, the cause and the fix, beside the smallest picture that makes the change clear: a diagram, a tree or a diff sketch, chosen as the `pr` skill says. -->

Closes #

## Evidence

<!-- A before and an after. For a visual change they are representative screenshots per [Review and visual verification](../AGENTS.md#review-and-visual-verification), driven in the built artifact over local HTTP, and the accessibility audit's result follows them, as the resume skill specifies under "6. Verify and review"; say "no visual change" when true. For any other change the before is the output or the failing run and the after is the output or the passing run. -->

- **Before:**
  **After:**

<!-- Then paste the lines `node scripts/run-log.mjs` wrote for this branch, as the script wrote them: focused tests, the executed mutation (red then green), lint, and the convergence checks the testing strategy names. Each line carries the real exit code and the `head=` and `tree=` state it ran against. -->

| Claim | Construction mode | Focused test | Mutation | Result |
|---|---|---|---|---|
| | | | red → green | |

<!-- When a receipt above counts for a head other than the one it ran on, record it on these three lines as the resume skill's Receipt reuse rule says under "8. Deliver", once for each head such receipts ran on. When every receipt ran on the current head, write `none` after `Carried from:` and remove the other two lines, keeping `Changed paths:` with what was found whenever a path the testing strategy does not cover was investigated. -->
Carried from:
Changed paths:
Carried receipts:

## Merge Danger

<!-- The two answers the review tier was chosen from, each with one sentence of reason, and one sentence more where the gate or the guard rule set the tier. For a mixed change the two answers are those of the part that set the tier, each reason names that part, and one sentence more says what the other parts take, as the resume skill specifies under "6. Verify and review". -->
Undo:
Reach:

## Review

<!-- The review line comes first, in the format docs/AI-WORKFLOW.md specifies under "The review line", for example `Review: tier=sign-off rounds=7 raised=16 fixed=13 dismissed=2 deferred=1 greptile_rounds=2 greptile_raised=1 greptile_true=1` -->
Review: tier= rounds= raised= fixed= dismissed= deferred= greptile_rounds= greptile_raised= greptile_true=

<!-- The fresh reviewer's verdict and every finding with its disposition (fixed, dismissed with reason, or deferred as docs/AI-WORKFLOW.md defines it). Greptile threads are resolved on the pull request itself. -->

## Not done

<!-- Anything skipped, deferred, or uncertain. "Nothing" is a valid answer only when it is true. -->
