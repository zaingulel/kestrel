# Pre-approved delivery

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

Read with [pre-approved-phase.md](pre-approved-phase.md) and [card-session.md](card-session.md).

At section 7 the job is judged as [merge-on-evidence.md](merge-on-evidence.md) says: where no wait reason holds, the
worker delivers through section 8 and closeout (the delivery phase alone does so on legacy routes). Before each delivery
compare job-owned changes against the job's own scope and its resource claims against its peers' grants. Resolve
`origin/main` as a trusted commit and use its three-dot diff to HEAD together with working tree, index and untracked
paths. The original selected base remains the immutable ancestry anchor for both main and HEAD; never rewrite the
accepted descriptor or remove ancestry checks. An expanded scope holds the delivery and names the conflict for revised
plan and evidence. The job fetches `main`, rebases onto `origin/main` and settles the manifest as deliver.md step 1 says
rather than hand-merging it, reruns every check the **Receipt reuse** rule in deliver.md does not carry to the rebased
head, then merges as section 8 says. A clash the job settles itself is a rebase that stops only on
`.agents/factory-manifest.json`, with every check then passing on the rebased head and no edit to the job's files. Any
other rebase conflict, or a check that fails on the rebased head and would need an edit, is a clash it cannot settle
safely, and the job then: where the rebase stopped on that conflict and is still in progress, runs `git rebase --abort`,
leaving the branch at its head before the rebase, or, where the rebase completed and a check then failed, keeps the
rebased head as it is, and its worklog names that head, the head before the rebase and the failing check; where a pull
request for the job is already open and ready, returns it to draft with `gh pr ready <pr> --undo`, and where none is
open, or it is already a draft, does nothing here; pushes nothing rebased; parks as step 7 says, with a question naming
the clashing files or the failing check; and returns `Run result: parked <card>: <question>`. Only that job parks: every
other job and the run carry on. It publishes only as the guard admits: `git push -u origin job/<card>`, `git push
--force-with-lease origin job/<card>` and section 8's `gh pr ready` and `gh pr merge` forms, each as a command on its
own from its job worktree. The guard refuses its push while its pull request is ready or has a merge queued, judges the
published pull request body as well as the saved write-up at ready and merge, and publishes a run's card only when the
card's newest claim was made during that run by the GitHub account the session publishes as. It opens its draft only as
`gh pr create --draft --title <title> --body-file <path>`, the title a letter or digit followed by letters, digits and
`._:/-`, single-quoted with no `'` or newline, or double-quoted with no `"`, `$`, backtick, backslash, `!` or newline,
also as a command on its own from its job worktree. A card whose change the direct route would carry, which
`scripts/gates/pre-push-main` admits whole, takes the pull request route above, as deliver.md says for a run session.

A pre-approved run's card session runs section 8 and closeout unasked; its final message is the decision card, the pull
request's address, a merged line naming that pull request and, for work on screen, saying its screenshots are attached
to it, and `Run result: merged <card>`, and lists anything closeout would ask the owner. Where a wait reason holds, the
card goes to `Awaiting push` with its `Waiting for you:` comment, as merge-on-evidence.md says under **At push**, and
the card session's final message is that line and the decision card followed by `Run result: built <card>`; the batch
review gives the yes. The native Codex app run writes the card's waiting line,
`Waiting version: job/<card> <head> <identity> run <mark>`, naming the saved write-up's head and content identity
and the run's mark. If the line cannot be written, the phase fails. For a Claude Code sidebar job, follow
[pre-approved-sidebar.md](pre-approved-sidebar.md) for the owner's answer and delivery.
