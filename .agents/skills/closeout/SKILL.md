---
name: closeout
description: "Reconcile a merged pull request for work in this repository: board, issues, branches, and worktrees. Runs as soon as the agent sees the merge land; the owner can also invoke it."
---

# closeout

Runs in the same session the moment the merge lands, under the push authorisation that covered the merge;
no further ask. Everything here is observable from git, GitHub, Docker's container records and the machine's
process list; nothing is inferred from chat.

1. **Confirm the merge.** `gh pr view <pr> --json state,mergedAt,mergeCommit` shows `MERGED`. If not, stop.
   Then check the body's review line against
   [the workflow manual's specification](../../../docs/AI-WORKFLOW.md#the-review-line): a missing line, or one
   that does not meet it, is a workflow failure named in the report, never filled in from memory. When the job
   took the direct route there is no pull request: confirm instead with `git fetch origin main` and
   `git merge-base --is-ancestor <pushed sha> origin/main`, check the review line in the pushed commit's
   message with `git log -1 --format=%B <pushed sha>`, never in chat, and confirm `git rev-parse <pushed
   sha>^{tree}` equals the tree of the head its message's convergence receipts were settled on: the `head=` of each
   receipt that ran on it, and the last head each `Carried from:` line names, never a head named before it. A receipt
   that reads an older `head=` qualifies only when a `Carried from:` line names that head first, as the one it ran
   on, and the `Changed paths:` and `Carried receipts:` lines are filled as the Receipt reuse rule in `resume`
   section 8 says; on this route that line names no rebased head between the two. A mismatch is a workflow failure
   named in the report.
2. **Issues.** `Closes #` in the body closed them at merge; confirm with `gh issue view <n> --json state`. An
   issue the pull request resolved but did not name is reported to the owner, never closed unasked: only the
   issues the approved body names are within this run's authorisation. After a sync job, close each covered card the
   body lists as the [`sync-job`](../sync-job/SKILL.md) skill says.
3. **Main.** A session inside the job worktree leaves it before anything else in this step: Update local main
   redirects git to the `main` checkout with `-C`, and a runtime that isolates a session in its worktree refuses
   that from inside. Then run [Update local main](#update-local-main). A session inside the job worktree is
   retained until its runtime can leave it; on Claude Code, `ExitWorktree` with `action: "keep"` returns the
   session to the folder the shell was in when `EnterWorktree` ran and removes nothing, so step 5 finishes in
   the same run. If that folder no longer exists, the session stays in the job worktree and cannot leave it in
   this run: a Bash `cd` out of it is reset back into the worktree. `keep` matches what the tool can do:
   `ExitWorktree` removes only a worktree this session's own `EnterWorktree` created, so for a worktree that
   `git worktree add` made and the session entered by path, it returns the session and leaves the directory in
   place, and step 5's `git worktree remove` stays the thing that deletes it. This does not require switching
   the root checkout. Stop closeout if no current verifier checkout is available.
4. **Board.** From the current verifier checkout selected by Update local main, run
   `node scripts/board-move.mjs --batch <issue>:Done ...` for every closed issue. Done is the board's only
   terminal column, so a card closed as superseded or not planned also moves there. Then run
   `node scripts/board.mjs --closeout` (strict: it fails on an unreadable card or a non-advisory drift row) and
   reconcile anything it reports.
5. **Branch and worktree.** Confirm the exact job worktree path and its ownership. Stop any local server the job
   left serving that worktree, such as a visual-verification server: stop it as the session's own background task
   when the session holds one, otherwise find listening processes with `lsof -nP -iTCP -sTCP:LISTEN`, confirm a
   candidate's working directory is the job worktree with `lsof -a -p <pid> -d cwd`, and stop only that one; leave
   alone a server whose working directory is not this job's worktree. Skip Docker cleanup only if the Docker CLI
   is not installed. Otherwise list all container IDs, including stopped ones, with `docker container ls -aq`;
   then print each container's whole record, one line of JSON per container, in one command with the IDs typed
   as literals:
   `docker inspect --type container --format '{{json .}}' <id> <id>`.
   Read `.Mounts` and the recorded bind declarations in `.HostConfig.Binds` and `.HostConfig.Mounts` from that
   record; a declaration may retain the host path when the displayed mount source is translated. Never select
   those fields in the template: Docker omits a `HostConfig` key a container never set, and the dotted form
   `.HostConfig.Mounts` then fails with `map has no entry for key`. Compare normalized absolute host paths by
   component: canonicalize the job worktree and each recorded host bind source's longest existing prefix, then
   append any missing suffix. Only a source equal to or below the job worktree matches. If a symlink or another
   filesystem namespace prevents comparison even after checking the declarations, retain the worktree and report
   the unresolved container ID. Stop each matching running container by ID, then remove each matching container
   by ID; never select by name or text prefix. Any Docker command or API failure, including an unreachable
   daemon, also retains the worktree. On either uncertainty or failure, stop before branch deletion and continue
   to step 6 and the final report. Keep images and volumes. In the final report, name any other container or
   image confirmed as job-created by recorded build output or Docker metadata, and leave its cleanup to the
   owner; do not infer ownership from a name.
   **Scratch files and folders.** Apply `AGENTS.md`'s Disposable job cleanup authority to job scratch,
   including local prompts, drafts and disposable verification reports once no longer needed, inside or outside
   the worktree and not just verifier-reported paths. Inspect each exact target and its contents against actual
   file-writing tool calls or commands read in this session's transcript or in transcripts of helpers it
   dispatched for this job. A helper's returned path list alone does not establish creation. Use native file
   inspection and git's tracked-file inventory to establish eligibility under that authority; a nonempty
   directory must be wholly verified disposable before recursive deletion. Canonicalize the target and its
   existing parents, checking links and filesystem namespace differences; unresolved links or comparisons
   retain the target. Outside scratch includes runtime-managed plan and review locations; location alone
   never establishes eligibility. Remove only exact verified artifacts, preserving enclosing or shared scratch
   directories unless their entire contents are verified disposable under the same authority. Check
   `git worktree list --porcelain` in this repository and retain any scratch target with a registered worktree
   equal to it or below it.
   Check inactive use for both inside and outside scratch with native process inspection such as `lsof` and
   `ps`, following the exact target and its contents, recorded job/helper processes and retained process groups,
   and processes identified by target references. Examine relevant working directories, open files and command
   arguments; do not require every system process's details. `lsof +D <directory>` exits 1 whenever it warns
   that it cannot read a filesystem, whether or not it lists an open file, so read its listing and never its
   exit status: a row naming the target or a path below it is use. A warning about a filesystem that does not
   hold the target is the denied access the next sentence covers; one about a filesystem that holds the target
   is an incomplete lookup. The warning comes back on every run, so the command is never run again to silence it
   or with its error output discarded: the first run's listing and warning are the evidence. Denied access to an
   unrelated protected process alone neither blocks cleanup nor requires elevation. An unreadable relevant
   process, unavailable meaningful target-use check or unresolved target relationship retains the affected
   targets; silence from an incomplete lookup of the target or a relevant process is never proof of inactivity.
   Stop only processes confirmed as this session's own, then verify they stopped and the target is unused;
   unconfirmed termination or uncertain ownership retains the target.
   For verifier-reported artifacts, also require that this session started the reporting run, that it has
   stopped, and that its output reports neither a retained process group nor unconfirmed termination. Either
   report retains the artifact even if other checks pass; verifier output never replaces independent path,
   ownership or inactive-use checks.
   For outside scratch, use the all-container inspection above, including stopped containers and recorded bind
   declarations. Compare canonical host bind sources by path component and retain the scratch target if any
   source is equal to, below or above it, or any other container metadata references the target or a path below
   it, including labels and working directories. Skip Docker inspection only when the CLI is not installed;
   daemon or inspection failures and unresolved translated paths retain the scratch target. Keep images and
   volumes, and leave other recorded job-created containers and images for the owner as above.
   Recheck the exact target and inactive use immediately before removal. After all applicable checks pass,
   remove eligible targets autonomously with native exact-target commands such as `rm -- <file>` or
   `rm -r -- <directory>`. A target whose creation evidence fails is a leftover and follows the Leftovers
   paragraph below. On any other uncertainty or failure, preserve the target and report it; do not force
   cleanup. Report each exact removed or retained path and the reason for retention directly in the session,
   without creating approval-only files. Continue independent cleanup when another target is retained.
   **Leftovers.** Apply the [Leftover rule](#leftover-rule) below to every file, folder, worktree or branch this
   run finds that is not this job's verified scratch, worktree or branch. Investigate each one before reporting
   it. For a file or folder, first confirm it sits where that rule says the workflow writes job artifacts; a
   runtime's memory, settings or configuration is left alone. Then read its contents, timestamps and owner, and
   find the card, pull request or branch it belongs to from the worktree it sits in or the branch its
   file name carries. A card its contents name is only a lead: the tie holds when that card, its pull request or
   its branch also accounts for the file, and otherwise the leftover is unsettled. Search open cards and pull
   requests for its file name with
   `gh api -X GET --paginate search/issues -f q='repo:<owner>/<repo> is:open "<file name>"' --jq '{incomplete_results, hits: [.items[] | {number, title}]}'`,
   which prints one line for each page of results; a hit that names it makes it live. No hit shows that nothing
   names it only when the command succeeded and every line reads `"incomplete_results":false`; a failed or
   incomplete search leaves the leftover unsettled. Run the inactive-use and container checks above. For a worktree, from the verifier
   checkout, read `git -C <path> status --porcelain --untracked-files=normal --ignored=matching` and its branch,
   and run the same inactive-use and container checks on its path. `git worktree remove` deletes ignored files
   without refusing, so investigate each `!!` entry as a file or folder leftover of its own, apart from a
   dependency or build directory a command regenerates, such as `node_modules`. The worktree is dead only when
   each of those entries is dead; an entry that is not a leftover, such as a hand-placed environment or settings
   file, makes the worktree unsettled. For a branch, check
   `git merge-base --is-ancestor <tip> origin/main` and read
   `gh pr list --head <branch> --state all --json number,state,headRefOid` for the pull request's state; when the
   ancestry check fails, check the tip against a merged pull request's head with
   `git merge-base --is-ancestor <tip> <headRefOid>`. For a worktree or branch also read the card with
   `gh issue view <issue> --json state,comments` for its state and latest `Claim:`. A failed or unavailable check
   is unavailable evidence, never proof that a leftover is dead. Delete a dead leftover with the exact-target
   commands and safeguards of this step: `rm -- <file>` or `rm -r -- <directory>` for a file or a wholly verified
   folder, `git worktree remove <path>` for a worktree, then `git worktree list --porcelain` to confirm, and
   ordinary `git branch -d <branch>` for a branch. Never force any of them; a refusal keeps the target and is
   reported with the evidence. Leave a live leftover. For an unsettled one, ask the owner about that exact path
   with the findings and a recommendation. Report every leftover in one line: the exact path or branch, whether it
   was deleted, left or raised, and the evidence.
   Leave the job worktree through the available runtime mechanism described in step 3; if the runtime cannot leave
   it or ownership is uncertain, retain it, report why, and stop before worktree removal and branch deletion;
   continue to step 6 and the final report. That report tells the owner that removing the worktree the session sits
   in ends the session's shell, so run `git worktree remove <path>` only after the session is finished. First read
   `git -C <path> status --porcelain --untracked-files=normal --ignored=matching` from the verifier checkout: an
   `!!` entry that is neither this job's verified scratch nor a dependency or build directory a command
   regenerates retains the worktree, and the report names it. From the verifier checkout, outside the target
   worktree, run `git worktree remove <path>` on that exact approved job path. If removal is refused, stop before
   branch deletion and report the refusal. Confirm `git worktree list --porcelain` no longer registers that
   path, then run ordinary `git branch -d job/<issue>`; report a refusal and never force deletion. The remote
   branch is deleted by the merge setting or `git push origin --delete <branch>`. Finish with `git worktree prune`.
6. **Rulings.** Anything the owner settled this session that should outlive it goes where it belongs: a comment
   on the issue, or the document or rule that owns the topic. Never as a new document.

Report what was confirmed, what was moved, and anything left for the owner.

## Update local main

After a merge, and during resume intake to recover a missed update, advance local `main` automatically when safe.
This standing authority covers only a fast-forward local update and removal of the verifier-only worktree it
creates; it does not authorise pushes or any other branch or worktree removal. A skipped update does not block
independent cleanup or work selection.

1. Use the caller's just-fetched recorded `origin/main` target when available; otherwise fetch with
   `git fetch --no-prune origin main` and record the fetched commit. Load this procedure, `AGENTS.md`, and `resume`
   from that commit under the Instruction reuse rule in the `resume` skill's "Before intake" before applying it.
   A failed fetch leaves freshness unavailable: preserve local state and stop before board operations.
2. Record `refs/heads/main`, inspect `git worktree list --porcelain` and runtime ownership, and require
   `git merge-base --is-ancestor <recorded-local-main> <recorded-origin-main>`. If local `main` is missing, ahead
   or divergent, retain it and report why. A clean checkout is eligible only when it is also idle, available, has
   no merge, rebase or other operation in progress, and no other task owns it. The coordinating resume or closeout
   session may establish that it is idle when no other owner exists.
3. When `main` is checked out, inspect tracked, untracked, and ignored files for incoming file or directory path
   collisions. Recheck ownership, branch and status immediately before
   `git -C <main-worktree> merge --ff-only --no-overwrite-ignore <recorded-origin-main>`. Preserve active,
   dirty, unavailable, uncertain, or collision-bearing checkouts; never switch, reset, stash or clean one to make
   it eligible.
4. When no worktree checks out `main` and no active task owns it, recheck the inventory and use
   `git update-ref refs/heads/main <recorded-origin-main> <recorded-local-main>`. The expected old commit protects
   against concurrent movement. This advances only an unoccupied branch ref; it does not refresh files in a root
   checkout on another branch, whose verifier checkout is selected in step 5.
5. Verify local `main` equals the recorded target and, when a checkout was updated, that it remains clean; that
   refreshed checkout is the verifier checkout. For every case without a refreshed `main` checkout — dirty, active,
   unavailable, uncertain, collision-bearing, ahead, divergent, missing, or an old topic root — select a verifier
   checkout at the recorded target: use a usable existing isolated checkout first, otherwise create a fresh
   verifier-only worktree without duplicating a job. If none is available, report board freshness unavailable and
   do not execute stale board operations. Verify the selected verifier's `HEAD` and cleanliness before using its
   code for board checks or decisions.
   During resume, a verifier-only worktree this run created is removed at the end of the same run, after board
   operations, with `git worktree remove <path>`. During closeout, that verifier is retained until closeout step 5's
   job cleanup has finished, then removed in the same run with `git worktree remove <path>`. A reused existing
   checkout is left alone. Report the old and new commits, or the precise preserved path, branch and reason. Leave
   conflicts or refusals untouched.

## Leftover rule

`AGENTS.md`'s Disposable job cleanup rule grants the authority to delete a leftover and sets its limits; step 5's
**Leftovers** paragraph holds the commands for each check named here.

A leftover is a file, folder, worktree or branch the workflow made that a session finds, in any session, job or
not, and that `AGENTS.md`'s Disposable job cleanup paragraph does not settle: another job's or session's artifact,
or one of its own job's that it cannot prove it created. What makes something a leftover is where it sits and what
made it, never what its text mentions: a job worktree, a job or slice branch, or a file or folder in a place the
workflow writes job artifacts, which are a job worktree, a worklog folder and a session's scratch folder. A
runtime's memory, settings or configuration is never a leftover, wherever it sits and whichever card it names. The
session investigates each leftover to a conclusion before it reports it, and tells the owner the outcome in every
case. It reads the content, timestamps and owner and checks whether anything uses it; for a worktree or branch it
also reads the card's state and latest `Claim:`, the pull request's state, and whether any work is unmerged. Work
is unmerged when a commit is neither an ancestor of `origin/main` nor contained in the head of a merged pull
request, or when a change is uncommitted or untracked.

- Dead: the work it belongs to is merged or closed, nothing is unmerged, nothing uses it, and no open card or open
  pull request names it. The session deletes it without further approval and reports the exact path and the
  evidence in one line.
- Live: an open card with a recent claim, unmerged work, or in use. The session leaves it and reports what it is.
- Unsettled: the investigation cannot show it dead or live, cannot show the workflow made it, or cannot tie it to a
  card, pull request or branch. The session leaves it and asks the owner about that exact path, giving its findings
  and a recommendation.

"Not in use right now" alone is never proof that a leftover is dead, and neither is a name pattern, memory or
summary. An owner file or a tracked deliverable is never a leftover.
