# Direct route

This file is part of the `closeout` skill: a step number or section name in it that this file does not hold names
one in [its SKILL.md](../SKILL.md).

When the job took the direct route there is no pull request, and the pushed commit's message stands wherever the
steps speak of the pull request body: it carries the approved body, then `Closes #<issue>`. Read it with
`git log -1 --format=%B <pushed sha>`, never from chat.

- **Step 1.** Confirm the merge instead with `git fetch origin main` and
  `git merge-base --is-ancestor <pushed sha> origin/main`. Check the message's review line against the pull
  request template's specification in the form step 1 names, the same one a body's line meets: a missing line,
  or one that does not meet it, is a workflow failure named in the report.
- **Step 2.** The issues the message's `Closes #` lines name were closed when the push landed, and only those
  are within this run's authorisation.

A `Pushed checks:` line stands in only for the receipts of the convergence checks the repository's
`docs/TESTING-STRATEGY.md` leaves to the pre-push hook on this route, never for a focused receipt or any other check.
The landed push is their evidence, because the hook refuses a push whose checks fail. A line naming any other command,
or a required receipt neither quoted nor so named, is a workflow failure named in the report. The tree check below
reads the receipts the message still quotes; where none remain, step 1's ancestry check confirms the pushed commit.

Then confirm `git rev-parse <pushed sha>^{tree}` equals the tree of the head its message's convergence receipts
were settled on: the `head=` of each receipt that ran on it, and the last head each `Carried from:` line names, never a head named before it. A receipt
that reads an older `head=` qualifies only when a `Carried from:` line names that head first, as the one it ran
on, and the `Changed paths:` and `Carried receipts:` lines are filled as **Receipt reuse** in
[`resume`'s deliver reference](../../resume/references/deliver.md) says; on this route that line names no rebased
head between the two. A mismatch is a workflow failure named in the report.
