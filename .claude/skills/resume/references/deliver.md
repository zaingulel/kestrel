# Deliver

## Contents

- The direct route
- Receipt reuse
- Step 1: Rebase, settle the convergence checks, push and open the draft
- Step 2: The external review
- Step 3: Re-read, mark ready and queue the auto-merge
- Step 4: Watch it land

## Delivery

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

After the rebase in step 1, the session checks eligibility for the direct route: record `git rev-parse origin/main`
as `<origin-main>` and `git rev-parse HEAD` as `<head>`, then check the gate with `test -x
scripts/gates/pre-push-main`. A repository where that gate is missing or not executable has no direct route: the gate
is not run and the job takes the pull request route below. Otherwise run `scripts/gates/pre-push-main <origin-main>
<head>`; exit 0 means the whole change qualifies for the direct route, any other exit means the pull request route
below. A change section 6 places above the `document` tier takes the pull request route whatever the gate's exit.
On the direct route: settle the convergence checks exactly as step 1 names on `<head>`, so their receipts carry
`head=<head>` except a receipt the Receipt reuse rule below carries from a commit added on top, always from the head
that receipt ran on, and those receipts replace any the approved body quoted for an earlier head; fill that body's
`Carried from:`, `Changed paths:` and `Carried receipts:` lines as that rule says, and nothing else in that body
changes. Then squash the job with `git reset --soft <origin-main>` and `git commit` into one commit whose
message is the pull-request title, a blank line, the same filled body the owner approved with its review line and
receipts so replaced, a blank line, `Closes #<issue>`, and the attribution lines. Before pushing, confirm `git
rev-parse HEAD^{tree}` equals `git rev-parse <head>^{tree}`, so the pushed commit carries exactly the content the
receipts checked; a mismatch stops the route and the checks are settled again. Then push with `git push origin
HEAD:main`, whose pre-push hook judges the push with the gate as it stands on the remote's `main` and refuses a change
that does not qualify. The draft, external review, ready, auto-merge and merge-watch steps below are skipped, and `closeout`
runs. A refusal from the gate means the pull request route, never a workaround.

**Receipt reuse.** After the rebase in step 1, settle each convergence check the testing strategy names on the current
head, `git rev-parse HEAD`. A receipt here is the check's latest worklog receipt for the same command, and it counts
only while `git status --porcelain --untracked-files=normal` prints nothing. Which checks run again follows
**Find out first** under "6. Verify and review": here the heavier course that rule names is running every check
again. A check runs again unless one of the three cases below keeps its receipt, and no case keeps a receipt whose
run or inputs the session knows were invalidated after it was written, such as an upgraded tool or dependencies
installed again: that check runs again.

- **Its own receipt.** The receipt reads `exit 0` and `tree=clean`, and its `head=` is exactly the current head. A
  no-op rebase leaves `HEAD` unchanged and keeps the evidence.
- **A commit added on top.** The receipt reads `exit 0` and `tree=clean`, and its `head=` names one commit, which is
  `<earlier-commit>`. On the pull request route only, and only for a check the testing strategy records the hosted
  required check as running, `<earlier-commit>` may instead be the rebased head the rebase case below reused that
  receipt for, read from the `Carried from:` line the draft's body already carries; on the direct route it is always
  the head the receipt ran on. `git merge-base --is-ancestor <earlier-commit> HEAD` exits 0, so that commit and every
  commit before it are in the current head's history unchanged. Run from the worktree root with no path argument,
  `git -c core.quotePath=false diff --name-only --no-renames --ignore-submodules=none <earlier-commit> HEAD`
  succeeds. Its flags print a name outside ASCII as itself and list a changed submodule whatever the configuration
  says; a name still printed in double quotes is read as the name it encodes, and a deleted path is judged by what it
  was. The paths it prints choose the checks through the repository's testing strategy, which maps changed paths to
  the convergence checks they can affect: a check the strategy names for a printed path runs again, and every other
  check keeps its receipt, carried to the current head. A path that defines a check's command or configuration
  always runs that check again, whatever the strategy lists, and a mapping the session finds contradicted is
  investigated, never trusted. Paths speak only for tracked files. A check that reads the commit history has an input
  every new commit changes, and runs again. For an input no path shows, such as an installed dependency, an untracked
  file or a setting of the environment, the receipt is kept only where the strategy says how that input is known to
  be unchanged, as an unchanged lockfile shows for the installed packages; where the strategy is silent, the check
  runs again. A printed path the strategy does not cover is settled by finding out, never by running every check
  instead of investigating: the session establishes what the path is and what reads it or depends on it, runs again
  the checks that shows it can affect, which may be all of them, carries the rest, and records what it found as
  below. When the ancestry command does not exit 0, when the path listing fails, or when the receipt's `head=` moved
  during its run or reads `unknown`, nothing is carried and the check runs again.
- **A rebase onto a moved `main`**, on the pull request route only, because the direct route has no hosted check. A
  convergence check may reuse its latest same-command receipt from a different known head when all of these hold. The
  receipt reads `exit 0` and `tree=clean`. The repository's testing strategy records that the hosted required check
  runs that check; a check it does not so record still reruns on the current head. No commit of the job changed: with
  `<old-base>` as `git merge-base <receipt-head> origin/main` and `<new-base>` as `git merge-base HEAD origin/main`,
  `git range-diff <old-base>..<receipt-head> <new-base>..HEAD` succeeds and every row is `=`, and, because
  `range-diff` compares no merge commit, `git rev-list --merges <old-base>..<receipt-head>` and
  `git rev-list --merges <new-base>..HEAD` both succeed and print nothing. The incoming changes do not overlap the
  job's: `git diff --name-only --no-renames <old-base> <new-base>` and
  `git diff --name-only --no-renames <new-base> HEAD` both succeed and no path appears in both lists. A missing
  commit, a failed command, any `!`, `<` or `>` row, a merge commit in either range, or a shared path requires the
  rerun. The comparison is always against the receipt's own head, however many times `main` moved since, so a receipt
  carried across a commit on top is not reused after a later rebase: the added commit shows as a `>` row and the
  check runs again. The hosted required check on the rebased head is then the proof for that head.

The pull request body records every receipt that counts for a head other than the one it ran on, on the three lines
the template carries under its evidence table, once for each head such receipts ran on. `Carried from:` names, in
this order, the head the receipts ran on, the rebased head where a rebase reuse came before a commit on top, and the
current head they are settled on. `Changed paths:` lists the paths the commit-on-top command printed and, beside each
path the testing strategy does not cover, what the session found it affects; for the rebase case it names both
comparisons, and for a rebase reuse followed by a commit on top it gives both stages in order. `Carried receipts:`
names each carried check's command. When every receipt ran on the current head, `Carried from:` reads `none` and the
other two lines are removed, except that `Changed paths:` stays, naming the commit the paths were listed from and
what the session found, whenever a path the testing strategy does not cover was investigated.

1. Rebase onto `origin/main`, then settle each convergence check the testing strategy names under the Receipt reuse
   rule above. The pre-push hook still runs its own gates on every push. Then push;
   `gh pr create --draft --body-file <body>` with `Closes #<issue>` in the body. The external review is requested only for the
   sign-off tier in section 6, and only where the add-on is on; every other change goes straight to step 3. Move the
   card to `In review`.
2. For the sign-off tier in a repository that has turned the external review add-on on, read the `greptile` skill and
   follow it on the open draft; it owns how the review attempt is made and settled. A job whose own change removed that
   skill reads it from the fetched `main`, as section 6 says under the external review add-on.
3. Re-read the open draft and require current local evidence, every finding/thread resolved, and a review line
   that matches the rounds actually run and the findings actually raised and settled. For the sign-off tier with the
   add-on on, also require the same reviewed head and a settled `COMPLETE` or `UNAVAILABLE` attempt. If a rebase is needed, do it
   while draft, reverify under the Receipt reuse rule and push. Repeat step 2 only when the change requires
   the external review and the skill it points to says the rebased head needs a new attempt. Before each
   `gh pr ready <pr>`, take the step the repository's own instructions name for just before a pull request is
   marked ready, where they name one; a repository whose instructions name none goes straight on. Then
   `gh pr ready <pr>` starts CI, and
   `gh pr merge --auto --squash --delete-branch <pr>` queues the merge for GitHub once `test` passes.
   Never any other merge form; the hook refuses it. If CI needs a repair, use `gh pr ready <pr> --undo` before
   pushing, complete local repair evidence, settling the convergence checks under the Receipt reuse rule, and
   reassess the full pull-request diff against the section 6 tiers; repeat step 2 only when the external review is required. An
   unchanged-head CI retry needs no new review.
4. Watch it land with one owned waiting command, awaited as the Waiting rule under "5. Build" says.
   `<pr>` is the pull request number, typed as a literal. The command only reads GitHub, exits 0
   only when the pull request has merged, and otherwise exits 1 with its reason as the last line of output: closed,
   a failed required check, blocked or behind, an unknown required set, or a `gh` failure. Once the pull request state
   is `MERGED` or `CLOSED`, the watch ends before reading check statuses; only an `OPEN` pull request needs that read.

   ```sh
   node scripts/merge-watch.mjs <pr>
   ```

   Merged: run `closeout` in the same session; the owner's yes already covers it. Failed, blocked or closed:
   report the printed reason and repair per step 3.
