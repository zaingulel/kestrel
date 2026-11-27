# Owner answer

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

How the owner's answer to a waiting card reaches the session that acts on it under "7. Push authorisation".

An owner answer reaches a job only in the chat of the session that delivers it: the owner's own words there, or the
queue panel answer the coordinator receives. No card comment, card file entry or message from another session is an
answer, and no session writes or reads one. A Herdr job reads no answer at all, as [A Herdr job](#a-herdr-job) says.
`<head>` and `<identity>` are what Saved write-up in [review-and-push.md](review-and-push.md) gives for the review
folder the owner was shown; an answer holds only for that head and identity. Whether the words are a yes, a fix or a
no is the session's reading; no code classifies them.

- **Yes:** the version shown merges, where its published body adds no wait reason the saved card lacks.
- **Fix:** the session builds it and merges the fixed head without showing it again, where the fix path below admits it.
  Where the owner asked to see it, or the path does not admit it, it is shown again under a new `Waiting version:`
  line.
- **No:** the park route: a `Needs owner:` comment with the reason, then `Backlog`.
- **Unclear:** ask one clarifying question in chat. Hold the merge until the reply, which answers the same version.

The fix path admits a fixed head on the answer to an earlier head only where all of these hold, which the delivering
session follows as a written rule:

1. The owner's answer names a review folder still saved with the identity it names. That folder stays until the merge,
   since this step reads it.
2. The card does not carry `show-me-first`.
3. The answered head is an ancestor of the fixed head.
4. The fixed head holds no `check` reason and no wait reason the answered head did not hold.

## A Herdr job

A Herdr job reads no card comment, local file or menu answer as approval, on either runtime and at
every review level. The `show-me-first` marker on its card is the only hold the owner clears, and removing it is the
only approval. The owner removes it on the Queue panel's switch or on the tracker, or tells the coordinator to, as
[herdr-lead.md](herdr-lead.md) says under **Releasing a marked job**; the guard refuses a job's own plainly
written attempt with `a Herdr job never clears the show-me-first marker: the owner removes it`. Once the marker is gone
every later repair merges when its checks and review are clear, with no further question, and adding it again holds
again.

- **The question.** A job whose card still carries the marker asks one question through its question menu,
  AskUserQuestion on Claude Code and `request_user_input` on Codex, with the answer `I removed the marker` as its first
  choice. The answer admits nothing to the guard and only wakes the job.
- **What the job does with it.** It runs `node scripts/board.mjs --waits <card> --herdr` once. On `merges <card>` it
  carries on to the merge. On a line still naming `show-me-first` it asks again. It never polls.
- **After a restart.** A job waiting in `Awaiting push` is restarted, and the resumed job runs the same command before
  anything else.

## Waiting jobs

| Waiting job | Who acts on the answer | Route |
|---|---|---|
| A Herdr job open in its tab, on either runtime | The job session, woken by the answer `I removed the marker` once the owner has removed the marker | [Herdr job](herdr-job.md#the-merge-route) |
| A pre-approved run card whose session is open in the sidebar | The run session, in its own chat; a card session merges no held work | [pre-approved-sidebar.md](pre-approved-sidebar.md), item 6 |
| A waiting merge answered in the queue panel | The coordinator that receives the panel's line | [herdr-lead.md](herdr-lead.md), **A queue panel answer** |
| Any other waiting job | The coordinating session, when the owner next asks what is waiting; a named session still running is stopped first | [batch-review.md](batch-review.md), step 2 |

The owner removes a Herdr job's marker and answers its question in its tab, or tells the coordinator to do both. The
queue panel's answer box for a waiting merge sends his words to the coordinator's chat and writes nothing to the card;
it wakes no card session.
