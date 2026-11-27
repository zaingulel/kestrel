# Deliver

## Contents

- The direct route
- Receipt reuse
- Step 1: Rebase, settle the convergence checks, push and open the draft
- Step 2: The external review
- Step 3: Re-read, mark ready and merge
- Step 4: Watch it land

## Delivery

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

A coordinated Herdr job prepares and reviews without the reservation: on the pull request route it takes steps 1 and 2,
and step 3 up to its **Open** state, and on the direct route the eligibility and convergence checks below, before it
reserves. It starts the reservation in step 4 only once its review is settled, every finding is closed and nothing waits
on the owner, so that the reservation covers only the final rebase, the required checks and the merge, as [the merge
route](herdr-job.md#the-merge-route) says. Wait for readiness before that final rebase. For a Codex Herdr job, use the shared preparation, direct-route eligibility and squash checks, and draft
review steps here. A Herdr job on either runtime follows [the merge route](herdr-job.md#the-merge-route), and a Codex
Herdr job uses [Codex Herdr delivery](herdr-job.md#codex-herdr-jobs) for the marker wait, the final push or merge
commands, required checks and confirmation.

After the rebase in step 1, the session checks eligibility for the direct route: record `git rev-parse origin/main` as
`<origin-main>` and `git rev-parse HEAD` as `<head>`, then check the gate with `test -x scripts/gates/pre-push-main`. A
repository where that gate is missing or not executable has no direct route: the gate is not run and the job takes the
pull request route below. Otherwise run `scripts/gates/pre-push-main <origin-main> <head>`; exit 0 means the whole
change qualifies for the direct route, any other exit means the pull request route below. A change section 6 places
above the `document` tier takes the pull request route whatever the gate's exit, and so do a run session other than a
job a Herdr coordinator started, whose mark refuses a push to `main`, and a coordinator delivering a job whose named
session still runs, whose yes covers only that job's branch and pull request. On the direct route: settle on `<head>`
the convergence checks step 1 names that the repository's `docs/TESTING-STRATEGY.md` does not leave to the pre-push
hook, so their receipts carry `head=<head>` except a receipt the Receipt reuse rule below carries from a commit added on
top, always from the head that receipt ran on, and those receipts replace any the approved body quoted for an earlier
head; fill that body's `Carried from:`, `Changed paths:` and `Carried receipts:` lines as that rule says, and nothing
else in that body changes but that the strategy's `Pushed checks:` line replaces the receipts of the checks it leaves
to the hook. Then squash the job with `git
reset --soft <origin-main>` and `git commit` into one commit whose message is the pull-request title, a blank line, the
same approved body with its review line and receipts so replaced, a blank line, `Closes #<issue>`, and the attribution
lines. Before pushing, confirm `git rev-parse HEAD^{tree}` equals `git rev-parse <head>^{tree}`, so the pushed commit
carries exactly the content the receipts checked; a mismatch stops the route and the checks are settled again. A
Codex Herdr job uses its [checked squash push](herdr-job.md#deliver-directly-to-main). Other sessions push with
`git push origin HEAD:main`. In both cases the pre-push hook uses the gate on remote `main` and refuses an
ineligible change. Keep a coordinated job's reservation while its standalone push command runs, then release it
when the tool finishes. A direct push has no pull request status. Skip the draft, external review, ready, auto-merge
and merge-watch steps and run `closeout` on success. A refusal from the gate or the direct push guard means the pull
request route. After a refused push, which released a coordinated job's holder when the push tool finished, the session
confirms that `git rev-parse HEAD^{tree}` still prints what
`git rev-parse <head>^{tree}` prints and returns its branch to the version it showed with `git reset --soft <head>`, so
the pull request publishes the head the saved write-up and any owner answer name; where the two differ it stops, and the
work is saved and shown again as a new version. A coordinated job whose preflight refused before any squash restores
nothing and releases its holder. Either way it then prepares that route's draft, settles the review that route needs and
reserves again as **Reserve for the final rebase** says. For a Claude Code job that a Herdr coordinator started, the guard
admits `git push origin HEAD:main` only where HEAD is one commit whose parent is the fetched `origin/main`, an ancestor
of `<head>`, and whose tree is `<head>`'s, `<head>` being what `ORIG_HEAD` names after the squash's `git reset --soft`,
so nothing that moves `ORIG_HEAD` or fetches `main` again runs between the squash and the push; only where
`core.hooksPath` is `.githooks`, HEAD's `.githooks` is fetched `main`'s and the working tree's `.githooks` has no
uncommitted change and the session user may execute its `pre-push`, so the pre-push hook that judges the push is the
remote `main`'s, and no ref named `ORIG_HEAD` exists; and only where the card carries no `show-me-first` marker and
the saved write-up at `<head>` holds no `check` or `screenshot` reason, the only holds a Herdr job has.

**Receipt reuse.** After the rebase in step 1, settle each convergence check the testing strategy names, less those it
leaves to the pre-push hook on the direct route, on the current head, `git rev-parse HEAD`. A receipt here is the
check's latest worklog receipt for the same command, and it counts only while
`git status --porcelain --untracked-files=normal` prints nothing. Which checks run again follows **Find out first** under "6. Verify and review": here the heavier course that rule names is running every check
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
  `git diff --name-only --no-renames <new-base> HEAD` both succeed and no path appears in both lists, apart from a
  generated file left out as the next sentences say. A shared path is left out only when the repository's testing
  strategy, as it stands on `<new-base>` so that a job cannot name a file for itself, lists it with the command that
  rebuilds it in a table under a heading `Generated files`, and running that command through `node scripts/run-log.mjs`
  on the clean current head exits 0 and `git status --porcelain --untracked-files=normal` then still prints nothing. A
  rebuild that fails or produces any difference requires the rerun, and a difference means the job's copy was stale, so
  the rebuilt file is committed with the job before the rerun. The file's sources stay in the comparison, so a real
  overlap in what it is built from still requires the rerun. A repository whose strategy names no generated file leaves
  nothing out. A missing commit, a failed command, any `!`, `<` or `>` row, a merge commit in either range, or a shared
  path not left out requires the rerun. The comparison is always against the receipt's own head, however many times
  `main` moved since, so a receipt carried across a commit on top is not reused after a later rebase: the added commit
  shows as a `>` row and the check runs again. The hosted required check on the rebased head is then the proof for
  that head.

The pull request body records every receipt that counts for a head other than the one it ran on, on the three lines
the template carries under its evidence table, once for each head such receipts ran on. `Carried from:` names, in
this order, the head the receipts ran on, the rebased head where a rebase reuse came before a commit on top, and the
current head they are settled on. `Changed paths:` lists the paths the commit-on-top command printed and, beside each
path the testing strategy does not cover, what the session found it affects; for the rebase case it names both
comparisons and each generated file left out of the overlap check with its rebuild command, and for a rebase reuse
followed by a commit on top it gives both stages in order. `Carried receipts:` names each carried check's command.
When every receipt ran on the current head, `Carried from:` reads `none` and the other two lines are removed, except
that `Changed paths:` stays, naming the commit the paths were listed from and what the session found,
whenever a path the testing strategy does not cover was investigated.

1. Rebase onto `origin/main`. A rebase replays commits without the commit gate, so in the canonical repository each
   stop on a conflict in `.agents/factory-manifest.json` is settled at that stop: keep every entry and field either
   side adds or changes, taking either side's `sha256` where both changed the same one, and never work out a
   fingerprint by hand. Once that stop's other conflicts are resolved, re-record every fingerprint there as
   [Canonical recording](../../shared-files/SKILL.md#canonical-recording) says after a history replay, with
   `node scripts/factory-sync.mjs --write`, and stage the manifest before `git rebase --continue`, so the replayed
   commit carries it. Once the rebase finishes, run that command again: a manifest it changes means a replayed commit
   carries a stale fingerprint, a failure that is repaired by doing the rebase again from the job's head before
   it, settled as above, and never by committing the manifest alone, which the commit gate refuses while a file the
   commit leaves unchanged disagrees with the fingerprint at HEAD. Every later rebase below is settled the same way.
   Where the rebase stopped on a conflict in any file other than `.agents/factory-manifest.json`, the resolved files are
   reviewed again at the change's tier before the push.
   Then settle each convergence check the
   testing strategy names under the Receipt reuse rule above. Use ordinary `git push`; the pre-push hook remains
   active. For a push containing no main ref, it reuses qualified successful `scope=root` receipts for the current
   clean head only when every nondeleted pushed ref names that head, and runs each check without applicable evidence.
   Legacy unscoped, nested or unknown-scope evidence cannot qualify. Main-containing pushes, mixed pushes included,
   retain their local checks outside the setting-only case defined in the repository's `docs/TESTING-STRATEGY.md`.
   `RUN_TESTS=1` adds `npm test` in either case. Rerun an affected check after known tool or dependency invalidation;
   the receipt reader does not observe those changes. Use neither `--no-verify` nor a hook-path override: runtime
   guards refuse them. A writable worklog cannot authenticate execution; a session able to write it can forge receipts.
   Then push; `gh pr create --draft --title '<title>' --body-file <body>` with
   `Closes #<issue>` in the body. The external review is requested only for the sign-off tier in section 6, and only
   where the add-on is on; every other change goes straight to step 3. Move the card to `In review`.
2. For the sign-off tier in a repository that has turned the external review add-on on, read the `greptile` skill and
   follow it on the open draft; it owns how the review attempt is made and settled. A job whose own change removed that
   skill reads it from the fetched `main`, as section 6 says under the external review add-on.
3. Re-read the open draft and require current local evidence, every finding/thread resolved, and a review line that
   matches the rounds actually run and the findings actually raised and settled. For the sign-off tier with the add-on
   on, also require the same reviewed head and a settled `COMPLETE` or `UNAVAILABLE` attempt. If a rebase is needed, do
   it while draft, reverify under the Receipt reuse rule and push. Repeat step 2 only when the change requires the
   external review and the skill it points to says the rebased head needs a new attempt. A coordinated Herdr job pushes
   here only as **Release while waiting** in step 4 allows, then reserves, takes the final rebase and publishes the
   draft's **Open** state as step 4 says before Ready. For a Codex Herdr job,
   continue with its [checked pull request route](herdr-job.md#deliver-a-pull-request) from `before ready` through
   confirmation. For other jobs, before each `gh pr ready <pr>`, take the step the `before ready` row of the Conventions
   table in `.agents/REPOSITORY.md` names. A row that is absent, reads "None" or still holds its "Starter:" prompt names
   no step. Work going on its evidence is judged again first, as [merge-on-evidence.md](merge-on-evidence.md) says
   under **At push**. Then `gh pr ready <pr>` starts continuous integration (CI). For a Claude Code Herdr job,
   arm the checked pull request and hold its watch to passed checks as step 4 says, then run the pinned merge `gh pr
   merge --squash --delete-branch --match-head-commit <head> <pr>` of [the merge route](herdr-job.md#the-merge-route).
   Every other job runs the standalone `gh pr merge --auto --squash --delete-branch <pr>`, a merge form so GitHub waits
   for the required `test` check.
   If CI needs a repair, use `gh pr ready <pr> --undo` before pushing; a coordinated job instead releases its
   reservation as **Release while waiting** in step 4 says, which orders its return to draft. Complete local repair evidence, settling the
   convergence checks under the Receipt reuse rule, and
   reassess the full pull-request diff against the section 6 tiers; repeat step 2 only when the external review is
   required. An unchanged-head CI retry needs no new review.
4. Watch it land. In an ordinary session, await the one owned watch command under the Waiting rule in "5. Build".
   In a coordinated Herdr job, use the runtime's tasks in the job terminal. Run each delivery command from the
   registered job worktree.

   **Reserve for the final rebase.** Only once the job's review is settled, every finding is closed and nothing waits on
   the owner, since a held reservation keeps every other ready job from delivering, run `node scripts/merge-watch.mjs --hold-delivery`; a Claude Code job runs it as
   `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" --hold-delivery`, and every later merge-watch command here
   takes the same pinned spelling, whole and with plain arguments, because its guard admits no other. Start it in
   Claude Code with a background Bash task and keep its task ID. In Codex, start it with unified execution,
   `tty: true` and `yield_time_ms: 1000`, then keep the yielded holder session ID. A job that learns while its holder is
   still queued that it is no longer ready, a new finding, the marker or an owner question, ends that holder as
   **Release the reservation** says.

   Each delivery form reads the job's own `.agents/factory-settings.json` only for `herdr`, so a pull request may
   introduce a setting the pinned copy does not know: that read passes over a top-level key its copy does not know
   and still refuses every other fault the settings check finds at the top level of the file, and the pull request's
   own required check judges the new key. A key already on fetched `main` that the pinned copy does not know still
   stops publication: withdraw the job and start a fresh one from current `main`.

   Run `node scripts/merge-watch.mjs --delivery-ready <seconds>` (pinned for Claude Code) as a local readiness wait for that same holder.
   Use 590 seconds unless the next active communication or observation deadline requires a shorter whole-second
   budget. This leaves up to ten seconds to deliver the result within Claude Code's 600-second Bash limit.
   In Claude Code, await it in foreground Bash. In Codex, resume a yielded readiness call with `write_stdin` on
   that readiness session, bounded by the active deadline. Continue on exit 0. On exit 75, report the waiting
   reason at the check-in and wait again on the same holder. On exit 1, follow
   [stopped delivery](herdr-job.md#recover-stopped-delivery) before proceeding.

   **Final rebase.** On exit 0, and before fetching, run `node scripts/board.mjs --waits <card> --herdr` again and
   confirm the review still has no open finding; any other line, a failed command or a new finding releases at once as
   **Release while waiting** says. Then fetch `main` and rebase onto it as step 1 says; this is the one path for a first
   attempt and for every retry, and step 1 of [the merge route](herdr-job.md#the-merge-route) says when the review
   stands. Where it stands, a pull request job publishes in this turn: it pushes with `git push --force-with-lease
   origin job/<issue>`, which changes nothing where GitHub already shows its head; brings into the saved write-up the
   external review records the `greptile` skill keeps in the published body, its allowance, requests and outcomes each
   with the head it named, and makes the one `Review:` line total every local and external round and disposition so far,
   then replaces the draft's body with it through `gh pr edit <pr> --body-file <body>`; attaches each screenshot again
   from the review folder of its head as [the visual reference](visual.md) says under **Attaching screenshots**; and
   verifies the pull request as below. On the direct route, the eligibility check, `<origin-main>`, `<head>`, the
   receipts and the squash above take the base and head this rebase leaves. If the push, the body update, an attachment
   or the verification fails, the job releases as **Release while waiting** says and takes the **Final rebase** again on
   its next turn, starting from what GitHub shows.

   **Push-only turn.** A Claude Code job that armed since it last held, and whose external review add-on needs an
   attempt on its head that it has not settled, takes this turn instead of the final rebase once its local review is
   settled, every known finding is closed, except an external finding the `greptile` skill closes only once its fix is
   pushed, which this turn publishes and which counts as closed for its reservation and recheck, and nothing waits on
   the owner. It reserves and takes readiness and the recheck as **Final rebase** says, does not rebase, pushes its
   local head with `git push --force-with-lease origin job/<issue>` unless GitHub already shows it, replaces the draft's
   body and attaches its screenshots again as **Final rebase** says, and ends its holder as **Release the reservation**
   says without arming, the pull request still a draft. It then requests the attempt as the `greptile` skill says and,
   once the attempt settles, reserves again for the final rebase. If the push, the body update or an attachment fails,
   it still ends its holder without arming: where the push succeeded, it finishes the draft update and requests the
   attempt outside the turn; where the push failed, it settles the cause and gets the attempt as step 1 of [the merge
   route](herdr-job.md#the-merge-route) says for a job that has not armed since it last held.

   **Verify the pull request.** Use literal values for the pull request number `<pr>` and full checked Git object ID
   `<head>`. While holding the reservation, use `node scripts/merge-watch.mjs --delivery-pr <pr> <head>` (pinned for Claude Code) to verify
   the draft and show **Open**. A Herdr job uses this command again after its pinned merge, including after a branch
   cleanup error. Use the observed GitHub state to decide whether to close out. Codex uses its checked pull
   request route through confirmation.

   **Watch a Claude Code Herdr merge.** After Ready, run
   `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" --delivery-pr <pr> <head> --arm`, which writes the receipt and
   refuses a pull request that already has an auto-merge queued. Then start
   `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" <pr> --held-delivery` as its own background Bash task. Keep its task ID and await
   its native completion notification. Ordinary idle keeps the reservation while the task is live; an owner question or a repair does not, as **Release while waiting** below says. The watch exits 0
   with `required checks passed on <head>` once every required check has passed or skipped on that head, and 1 on a
   failed check, a moved head or a closed pull request. After it exits 0, run the pinned merge, then
   `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" --delivery-pr <pr> <head>`, which shows **Merged** only on
   GitHub's merged state.

   **Release the reservation.** After delivery settles, or before handing off or stopping, end the runtime's
   holder. In Claude Code, to stop an active watch, use `TaskStop` on its task ID and await its final cleanup
   before ending the holder separately with `TaskStop`. In Codex, send Ctrl+C with `write_stdin` to the holder's
   terminal session. If the job stops while GitHub still has its merge queued, the next delivery follows
   [stopped delivery](herdr-job.md#recover-stopped-delivery).

   **Release while waiting.** A coordinated job holding the reservation releases it before it asks the owner anything
   and, on a new finding or a failed required check, before it starts the repair, so the next queued job delivers
   meanwhile. Before it releases, where it has an open pull request, GitHub must show it as a draft with no auto-merge
   request, on the head it armed where it armed one since it last held, because the next job's reservation stops on a
   ready pull request or a moved head; a job with no pull request ends its holder directly. It runs `gh pr ready <pr>
   --undo` first where the pull request is ready, and where GitHub shows another head while the pull request is still
   ready, it first arms that head with `--delivery-pr <pr> <head GitHub shows> --arm`, pinned for Claude Code, which
   replaces its own receipt. Where the pull request is already a draft on another head, it keeps the reservation through
   the wait or repair and arms the new head itself, since no other job can settle a receipt that names another head.
   From arming until it next holds the reservation, a Claude Code job neither pushes its branch nor replaces its draft's
   body: it repairs and is reviewed on local commits and publishes in its next **Final rebase** or **Push-only turn**. Otherwise it releases
   as **Release the reservation** says and waits until the holder has ended. Once the answer arrives, or the repair is
   done and its review settled with every finding closed, it reserves again as **Reserve for the final rebase** says and
   takes the **Final rebase** with its open draft rather than opening another. A stop for a job waiting for a machine it
   can start itself keeps the reservation and the pull request ready, as **Merge watch results** says.

   **Merge watch results.** Use the literal pull request number for `<pr>`. The watch waits on GitHub events
   through one short-lived forwarding webhook it puts on the repository with `gh webhook forward` and removes when it ends, and it reads
   GitHub only when a relevant event arrives or its one stall deadline passes; after an event read finds the merge
   state unknown, or any read finds it blocked with every required check passed while an auto-merge is queued, it
   makes up to four settle reads within 75 seconds. It needs the `cli/gh-webhook` extension and admin access to the
   repository; without either it stops with a plain message and never falls back to timed reads. It exits 0 only
   when the pull request has merged, or, held for a Claude Code Herdr job, when its required checks passed on the head, and otherwise exits 1 with its reason as the last line of output:
   closed, a failed required check, blocked or behind, an unknown required set, no test run started for the head
   commit within 10 minutes while a required check has not reported, a test job queued with no runner for 15 minutes,
   no event route, a forwarding webhook left on the repository that no watch can prove its own (the reason names it
   and the command that deletes it), another watch running for the repository, or a `gh` failure. Once the pull
   request state is `MERGED` or `CLOSED`, the watch ends before reading check statuses; only an `OPEN` pull request
   needs that read. The ordinary command is:

   ```sh
   node scripts/merge-watch.mjs <pr>
   ```

   On confirmed merge, run `closeout` in the same session. The owner's yes already covers it. A coordinated
   job sends its [merge note](herdr-job.md#after-the-merge) afterward. On failure, blockage or closure, report the
   printed reason and repair per step 3. A coordinated job uses its owner menu when a stop needs the owner.

   Follow the action for the stall reason.

   - **No test run created.** A coordinated job, whatever retry the watch prints, goes straight to **Release while
     waiting** and then **Reserve for the final rebase**, its review standing where the head has not moved. Any other
     job returns the pull request to draft with `gh pr ready <pr> --undo` to cancel the queued merge, follows step 3
     again from its `before ready` step, then uses this step's watch command for the same runtime; step 3 covers an
     unchanged-head CI retry.
   - **A job waiting for a machine.** The stop names the job and its runner labels. Start that runner where the
     repository says how, then run the watch again once the runner is up, never marking the pull request draft for this
     stop. Where only the owner can start it, a coordinated job first releases as **Release while waiting** says, which
     returns the pull request to draft, and then tells the owner which machine is offline and what it waits for; any
     other job tells the owner and keeps the pull request ready.
