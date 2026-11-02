<!-- The owner answers a decision card lifted from this body word for word, and can open the whole body, so write each sentence to be lifted: plain and standing alone. Open with what changes for the owner. Leave out anything true of every job, such as the usual gates having run or what a yes normally starts. The collapsed sections keep the complete evidence behind the visible sections, exactly as written; keep the blank line after each `<summary>` line, because GitHub shows the Markdown inside a collapsed section only after one. Write it with the vendored `pr` skill into this template; the resume skill owns which wins where the two differ, and the card's blocks, under "7. Push authorisation". -->

## Summary

<!-- Open with a few plain sentences saying what changes for the owner, naming anything the job carried along beyond its card; they are the card's first block. Then the problem, the cause and the fix, only where the opening has not already said them. Add a picture, a diagram, a tree or a diff sketch chosen as the `pr` skill says, only where it shows something the sentences cannot; the screenshots a visual change needs go under Evidence either way. When a product manager run picked the card, the Summary ends with one line beginning `Picked:` that gives the run's reason, as the resume skill says under "2. Work-pick". -->

Closes #

## Not done

<!-- The material limitations and unresolved risks a yes accepts: anything skipped, deferred, or uncertain. One bullet each, opening on one sentence that stands alone and says what a yes accepts, because the card copies it. A reason follows only where the item is the owner's call or changes what the owner would do. The owner's own calls come first. "Nothing" is a valid answer only when it is true. When a product manager run built the card, this section opens with, only where they apply, a `**Taste calls I made**` list and a `**Needs your ears**` list saying what to listen for, as the resume skill says under "2. Work-pick". -->

## Merge Danger

<!-- The two answers the review tier was chosen from, each with one sentence of reason, and one sentence more where the gate or the guard rule set the tier. For a mixed change the two answers are those of the part that set the tier, each reason names that part, and one sentence more says what the other parts take, as the resume skill specifies under "6. Verify and review". -->
Undo:
Reach:

## Evidence

<!-- A before and an after. For a visual change they are representative screenshots per [Review and visual verification](../AGENTS.md#review-and-visual-verification), driven in the built artifact over local HTTP, and the accessibility audit's result follows them, as the resume skill specifies under "6. Verify and review"; say "no visual change" when true. For any other change the before is the output or the failing run and the after is the output or the passing run. Then the three plain lines the card copies, written as the outcome-reporting paragraph of AGENTS.md says: group related passes, naming the review and its tier, and leave the log's path to chat, because this body is published; state each failure's cause or say it is unknown; name each check not run, why, and what follows. Where a line has nothing to say, it reads none. -->

- **Before:**
  **After:**

Passed:
Failed:
Untested:

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

<details>

<summary>Decision card</summary>

<!-- Blocks 1 to 5 of the card, word for word as chat shows them, as the resume skill says under "7. Push authorisation". It never copies or quotes the review line, a Reviewed commit line, the closing line or the carried-receipt lines, because what reads those takes a second copy for an error. -->

</details>
