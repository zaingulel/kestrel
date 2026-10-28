<!-- The owner reads this, not the diff. Write it for someone who checks wording and screenshots. Everything outside a collapsed section is what the owner decides on: what changed, what is left undone, how hard a mistake would be to undo and how far it would reach, and how the change was shown to work. The collapsed sections keep the complete evidence behind that, exactly as written; keep the blank line after each `<summary>` line, because GitHub shows the Markdown inside a collapsed section only after one. Write it with the vendored `pr` skill into this template; the resume skill owns which wins where the two differ, under "7. Push authorisation". -->

## Summary

<!-- The outcome in a few plain sentences: the problem, the cause and the fix. Add a picture, a diagram, a tree or a diff sketch chosen as the `pr` skill says, only where it shows something the sentences cannot; the screenshots a visual change needs go under Evidence either way. When a product manager run picked the card, the Summary ends with one line beginning `Picked:` that gives the run's reason, as the resume skill says under "2. Work-pick". -->

Closes #

## Not done

<!-- The material limitations and unresolved risks a yes accepts: anything skipped, deferred, or uncertain. "Nothing" is a valid answer only when it is true. -->

## Merge Danger

<!-- The two answers the review tier was chosen from, each with one sentence of reason, and one sentence more where the gate or the guard rule set the tier. For a mixed change the two answers are those of the part that set the tier, each reason names that part, and one sentence more says what the other parts take, as the resume skill specifies under "6. Verify and review". -->
Undo:
Reach:

## Evidence

<!-- A before and an after. For a visual change they are representative screenshots per [Review and visual verification](../AGENTS.md#review-and-visual-verification), driven in the built artifact over local HTTP, and the accessibility audit's result follows them, as the resume skill specifies under "6. Verify and review"; say "no visual change" when true. For any other change the before is the output or the failing run and the after is the output or the passing run. -->

- **Before:**
  **After:**

<details>

<summary>Test receipts</summary>

<!-- Then paste the lines `node scripts/run-log.mjs` wrote for this branch, as the script wrote them: focused tests, the discrimination proof selected by docs/TESTING-STRATEGY.md, lint, and the convergence checks the testing strategy names. Each line carries the real exit code and the `head=` and `tree=` state it ran against. Name the selected route in the table: qualifying ordinary pre-fix red/unchanged-test green, required mutation red/restored green, or the strategy's declared alternative. -->

| Claim | Construction mode | Focused test | Discrimination proof | Result |
|---|---|---|---|---|
| | | | | |

<!-- When a receipt above counts for a head other than the one it ran on, record it on these three lines as the resume skill's Receipt reuse rule says under "8. Deliver", once for each head such receipts ran on. When every receipt ran on the current head, write `none` after `Carried from:` and remove the other two lines, keeping `Changed paths:` with what was found whenever a path the testing strategy does not cover was investigated. -->
Carried from:
Changed paths:
Carried receipts:

</details>

## Review

<!-- The review line comes first, in the format docs/AI-WORKFLOW.md specifies under "The review line", for example `Review: tier=sign-off rounds=7 raised=16 fixed=13 dismissed=2 deferred=1`. Where the repository has turned the external review add-on on, the add-on's three fields follow `deferred`, as that section says. Any declaration the resume skill requires of how a review ran, such as a pass on the writer's own family or an external review recorded as unavailable, follows the line here, outside the collapsed section. -->
Review: tier= rounds= raised= fixed= dismissed= deferred=

<details>

<summary>Review findings</summary>

<!-- The fresh reviewer's verdict and every finding with its disposition (fixed, dismissed with reason, or deferred as docs/AI-WORKFLOW.md defines it), then the usage and plan-review lines the cross-review skill specifies. Where the external review add-on is on, its threads are resolved on the pull request itself. -->

</details>
