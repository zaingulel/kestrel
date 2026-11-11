# Update local main

This file is part of the `closeout` skill.

After a merge, and during resume intake to recover a missed update, advance local `main` automatically when safe.
This standing authority covers only a fast-forward local update and removal of the verifier-only worktree it
creates; it does not authorise pushes or any other branch or worktree removal. A skipped update does not block
independent cleanup or work selection.

1. Use the caller's just-fetched recorded `origin/main` target when available; otherwise fetch with
   `git fetch --no-prune origin main` and record the fetched commit. Load this procedure, `AGENTS.md`, and `resume`
   from that commit under the Instruction reuse rule in the `resume` skill's "Before intake" before applying it.
   A failed fetch leaves freshness unavailable: preserve local state and stop before board operations.
2. Record `refs/heads/main`, inspect `git worktree list --porcelain` and require
   `git merge-base --is-ancestor <recorded-local-main> <recorded-origin-main>`. If local `main` is missing, ahead
   or divergent, retain it and report why. A checkout must be clean, available, free of an operation in progress
   and free of another task's ownership. Reconcile active or resumable tasks and their exact worktree or assigned
   checkout from trusted runtime activity and the job/worktree inventory. Clean status, branch lists, folder
   references, absence of open files or descendants, and a removal-helper verdict do not establish that the
   checkout is free of task ownership or active use. Defer if a task owns or uses `main`, actual use cannot be
   resolved, or observations conflict.
3. When `main` is checked out, corroborate a passive folder reference with native working-directory, open-file
   and process-tree observations. A runtime-spawned noninteractive helper with verified identity and runtime
   ownership may keep `main` as its working directory when step 2 established that no task owns or uses `main`, and
   fresh native observations show only the folder reference, with no work by the helper or its descendants in that
   checkout. Do not infer helper eligibility from its process name alone. A per-helper runtime idle status is
   unnecessary in that case. Active file access, a running command in the checkout, or an unresolved descendant
   defers. For an app, require a directly observed passive view or trusted runtime activity evidence for its
   user-facing window or view; this applies to that view, not its noninteractive helpers. For an interactive shell,
   require a trusted runtime tab observation matched to the exact holder that explicitly reports nothing running,
   such as the desktop app's `list_terminal_tabs` when it can identify the tab. Native working-directory, terminal
   and process-tree observations can rule out idleness; establish shell idleness from the matching runtime tab.
   Defer when the runtime cannot observe an interactive shell, without typing into it. A verified passive reference
   can accompany an eligible update. Removal holds govern removal.

   Inspect tracked, untracked and ignored files for incoming file or directory collisions. Immediately recheck
   exact ownership, activity, branch, tip, operation state and status before
   `git -C <main-worktree> merge --ff-only --no-overwrite-ignore <recorded-origin-main>`. Leave active, dirty,
   unavailable, uncertain or collision-bearing checkouts intact. Never switch, reset, stash or clean one to make
   it eligible. Defer without asking the owner to quit an app, stop a session, or move a terminal. Leave unrelated
   sessions alone. Follow
   [the separate guard and capability activation procedure](../../shared-files/SKILL.md#guard-and-capability-activation) where it applies.
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
