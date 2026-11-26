# Card session steps

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

These are a run's steps 6 and 7 and the probes of its step 3. A pre-approved phase session takes them where
[pre-approved-phase.md](pre-approved-phase.md) and the files its table names name them, as those files say. The run's
steps 3, 8 and 9 are in [runs.md](runs.md).

Before posting or rewriting a `Needs owner:` or `Returned:` comment, or writing a `Run result:` question, read
[held-cards.md](held-cards.md) whole: its section 1 holds the rules for that free text.

3. **The launch probes.** Each Codex run session, a card session and an end session alike, makes its hook check first
   and runs `git commit --no-verify --dry-run` and the push probe item 3 of
   [pre-approved-phase.md](pre-approved-phase.md) names, each as one plain command on its own; the push command names a
   path that does not exist, so with the guard absent git fails before any push hook or upload runs. The launcher ends
   the run when a session's runtime log lacks either refusal.
6. **The job.** "3. Start the job" onward runs unchanged and takes the card to `Awaiting push`. On Codex the worktree is
   made with that section's `git worktree add` form, or the managed native route of
   [runs.md](runs.md#native-codex-app-run), so the branch carries the job's name. A card its checks find not free, or
   cannot confirm, stops the run, which never moves on to the next card. A plan that finds the card needs owner
   direction or sign-off, or would change the settings file, parks the job as step 7 says. On either runtime, once the
   job is committed and the card is at `Awaiting push`, the session saves its review folder as section 7 says under
   Saved write-up. A job at `Awaiting push` is waiting, not stopped: its session's final message is the decision card
   as section 7 says, followed by the `Run result` line, and the run goes on. Push authorisation stays the owner's yes,
   given after per-card presentation or in a batch review as section 7 says, and reaches the job by the route
   [owner-answer.md](owner-answer.md) names for it. The owner's reopening of the card session, which makes the checks
   "Parking" gives a reopened session, is only the fallback. A small taste call is a choice inside the approved outcome
   that no acceptance criterion settles; the job makes it and lists it under `**Taste calls I made**` in Not done. A
   call that changes the outcome or product meaning is a decision. A card whose proof needs listening is built, with
   what to listen for under `**Needs your ears**` and that proof named as untested. A card whose outcome is an answer,
   not a change, ends in a written finding: a new document under `docs/`, indexed in `docs/README.md`, delivered like
   any card, with follow-up work as title-and-line entries under `Suggested cards`. In any card the job files no new
   card, a follow-up the "Owner gates" rule in `AGENTS.md` would file included. It lists at most 3 new cards it met, a
   finding's entries among them, each a title and one line, under `Suggested cards` in its final message, after any
   decision card and before its `Run result:` line.
7. **Stops and parks.** A question this skill would put to the owner mid-job parks the job and the run goes on: a
   decision, plan approval, the owner ask of "4. Plan", a split proposal, the cross-family question. To park: commit what exists as step 1 of
   `handoff` says; write where the job stands in its worklog; post a comment whose first line is
   `Needs owner: <the question, in plain language, standing alone> Job: job/<card> on <machine>.`, the machine being
   what `hostname` prints; move the card to `Backlog`; leave the worktree and branch. Nothing is pushed and no draft
   opens. A park step that fails is a stop that says what it left behind. Every other point where this skill tells the
   owner something and then waits or starts nothing is a stop: Not free, Could not confirm, and the stop step 6
   names. A runtime's prompt, approval or refusal waits for the owner's own answer and is never worked around, for
   example by reshaping a command or changing the environment so it no longer asks; a block the session cannot pass is
   a stop. Before claiming or changing a selected card, the card session writes its identifier as data to the path in `RUN_CARD_FILE`; a failed write stops. Its last line is exactly `Run result: built <card>`,
   `Run result: parked <card>: <the question>` or `Run result: stop <card or none>: <why, and what the owner does next>`,
   then it ends.
