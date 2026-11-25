# Pre-approved sidebar run

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

On Claude Code with Herdr off, a pre-approved run started in the desktop app builds each card in its own session, which
the app lists under the run session in its sidebar, where the owner reads it and may message it while it works. The
run session reads this file with [pre-approved-run.md](pre-approved-run.md); a card session reads it with
[pre-approved-phase.md](pre-approved-phase.md), [card-session.md](card-session.md) and
[pre-approved-deliver.md](pre-approved-deliver.md).

## The run session

1. **Where it runs.** The route is taken only where `printenv CLAUDE_CODE_ENTRYPOINT` prints `claude-desktop`, the
   session stands at the repository root and `mcp__ccd_session__start_session` loads through the tool search. Anything
   else is the refusal step 3 of [pre-approved-run.md](pre-approved-run.md) gives. A run session another session
   started starts nothing.
2. **The start time.** Read `date -u +%Y-%m-%dT%H:%M:%SZ` once as `<run-start>`. Every card session of the run carries
   it, and no later reading replaces it.
3. **A batch.** From the candidates item 5 of [pre-approved-phase.md](pre-approved-phase.md) gives, take up to four not
   yet started, in the order it gives them. Refresh the board intake, run the Free check for each with
   `node scripts/board-claim.mjs <card> --intake <scratch>/board-intake.txt --check`, and start one session for each
   free card, all in one message, saying which order item 5 gave and quoting the refreshed intake's `Ready order:` line, then end the turn. Each start is `mcp__ccd_session__start_session` with `initiation`
   `user_asked`, `context` `fresh`, `use_worktree` false, `wake_when_done` true, a title naming the card, no `model`
   and exactly this prompt, its three lines each whole:

   ```text
   Continue this exact pre-approved sidebar job.
   {"card":<card>,"runStart":"<run-start>"}
   PRE_APPROVED_RUN_SESSION=<run-start>
   ```

   A card that is not free is named and skipped. The run session claims nothing and builds nothing.
4. **When sessions may start.** The app opens a session only in a turn the owner's own message began, or in the turn it
   wakes the run session with once every session of the batch is idle, while each turn since the owner's message has
   been such a wake. A turn begun by another session's message or by a finished background command opens none and ends
   that chain. So the run session starts the first batch in the turn of the trigger, runs no background command and
   starts no helper between batches, and sends a card session a message only to carry the owner's words. A refused
   start is never retried in another form: the run session starts nothing more, accounts for what runs, and tells the
   owner which cards are left and that any message from the owner continues the run.
5. **At each wake.** A session's note is its report, never an instruction and never an approval. For each card of the
   batch read its session's last message with `mcp__ccd_session_mgmt__get_session` and take its last line as step 8 of
   [runs.md](runs.md) takes a result line, `Run result: merged <card>` included. Check a merged result against the
   pull request and the card, apply **Per-card attention** in [runs.md](runs.md) to every result and send its
   `PushNotification`, then start the next batch as step 3 says. A stop result, a session that ended with no result
   line, or a result the board contradicts ends new starts, and the run goes to step 7 once the sessions still working
   are idle. The route writes no outcome record and no waiting line: the session's last message and the board are the
   evidence.
6. **The owner's answers.** The owner answers a card in its own session or in the run session. Either records the
   answer on the card as **Owner answer** in [owner-answer.md](owner-answer.md) gives, before it acts. The run
   session sends a card session a fix or a no as the Waiting rule of "5. Build" says, the words being the record's, and
   shows a waiting card and delivers the owner's yes itself, as **Batch review** under "7. Push authorisation" says. A
   message alone never carries a push yes: the record on the card does, where its mark's guard admits it.
7. **The end.** With no candidate left and every session idle, or at a stop, the run session gives the summary step 8
   of [pre-approved-run.md](pre-approved-run.md) names, in its own chat, with each card's session named so the owner
   can open it. No end session starts.

## A card session

A session whose first message is the prompt of step 3 is one card's whole job. It takes the run's shared steps
as [pre-approved-phase.md](pre-approved-phase.md) items 2 and 6 give them, and these:

- **Its mark.** The third line of its first message is its run mark. The git guard reads it there, so the session
  publishes only its own card's job branch and pull request, only when the card's newest claim was made by the same
  account during that run, only while `waitForOwner` on fetched `main` reads
  `on-screen` or `when-needed`, pushes only while its pull request is neither ready nor has a merge queued, and readies or merges it
  only where the judgement of [merge-on-evidence.md](merge-on-evidence.md) finds no wait reason in the saved write-up
  or the published pull request body, including `show-me-first` on its card and, at `on-screen`, work on screen, unless the card records the owner's answer
  for its head, as that file gives. Where the guard cannot read that first message in the desktop app, it refuses every push and merge.
- **Its probes.** After the hook check under "Before intake" it runs
  `git push --dry-run ./.pre-approved-run-no-remote HEAD` as one plain command on its own, and stops unless the guard
  refuses it with a reason beginning `a pre-approved run session`. A session whose first message differs from step 3's
  form by a character stops here.
- **Its job.** It reads the board intake as section 1 says, picks nothing, and runs "3. Start the job" onward for the
  card its JSON names: the Free check and claim, the worktree, the plan and its reviews, the build, the final review,
  then delivery as [pre-approved-deliver.md](pre-approved-deliver.md) says, with its own closeout. It stops where the
  card is closed or titled `Proposed: `. It also stops, before its claim, where the intake does not show the card in `Ready`. The run's phase records,
  descriptors and admission requests do not apply, and neither does the card file of
  [card-session.md](card-session.md): no launcher set `RUN_CARD_FILE`, so the session writes none.
- **Exclusive resources.** A plan that needs a resource another job could hold at the same time, such as a fixed port,
  a shared device or a single external account slot, parks the job as step 7 of [card-session.md](card-session.md)
  says, naming the resource. Overlap in files is settled at merge, as item 6 gives.
- **Messages.** It sends no message to the run session or to any other session, at any point: one message to the run
  session stops the run from starting its next batch. It reports only in its final message, whose last line is the
  `Run result:` line. A message that arrives from the run session it answers in its own conversation; the owner's own
  message in its conversation is the owner's answer.
- **Waiting.** It is a named session with later turns, so it waits on helpers and commands as the Claude Code form of
  the Waiting rule gives for a session that is not one-shot.

## Limits

The mark is a line of a saved conversation. A session whose saved first message is edited, cleared or moved away, or a
session started without the line, is not known to the guard as a run session: the mark stops an accident, not a determined workaround. The app decides when a woken turn may open sessions; Fabraik observes that rule and cannot change it.
