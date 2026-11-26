# Owner answer

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

How to record and act on the owner's answer to a waiting card under "7. Push authorisation".

An owner answer needs the record for its route. A Herdr job on either runtime reads no record as approval, as
[A Herdr job](#a-herdr-job) says. Every other route records the answer as the first line of a card comment or card
file entry.

## Card records

- `Owner answer: job/<card> at <head> <identity>: <the owner's words, on one line>`
- `Fix built: job/<card> at <new head> from <answered head>: <what changed, on one line>`

`<head>` and `<identity>` are what Saved write-up in [review-and-push.md](review-and-push.md) gives for the review
folder the owner was shown, the identity's hashes comma-separated as the `Waiting version:` line writes them; a head
is 40 or 64 lowercase hex. The words carry no
credential. A reader matches the prefix on the first line only, so a record quoted after other text counts for
nothing, and no answer of an account holds where its newest `Owner answer: job/<card> ` line is not a whole record or
another account last edited one of its comments. Whether the words are a yes, a fix or a no is the session's reading; no code classifies them.

The session in whose chat the owner answered writes the answer before it acts, on every board. The queue panel writes
it on a GitHub board. A continued session writes the owner's reply to its one clarifying question as an answer for the
version it asked about. The session that built a fix writes its fix line before it pushes. Each writes as the account it
publishes as, an answer only from the owner's own message and a fix line only for a fix it built. On GitHub a record
is a comment, `gh issue comment <card> --body-file <file>`; on Linear, Jira and Azure it is the card command's
`comment <card> --body-file <file>`; where cards are files it is an `### Owner answer: ...` or `### Fix built: ...`
entry committed on `job/<card>` and accepted on top of the shown head as that tracker's card guide gives.

- **Yes:** the version shown merges, where its published body adds no wait reason the saved card lacks.
- **Fix:** the session builds it, writes the fix line and merges the fixed head without showing it again, where the fix
  path below admits it. Where the owner asked to see it, or the path does not admit it, it is shown again under a new
  `Waiting version:` line.
- **No:** the park route: a `Needs owner:` comment with the reason, then `Backlog`.
- **Unclear:** ask one clarifying question in chat. Hold the merge until the reply, then record it for the same version.

The fix path admits a fixed head on the answer to an earlier head only where all of these hold, which the git guard
checks at a pre-approved run session's ready and merge, and a session the owner is talking to follows as a written rule:

1. The newest answer by the session's account names a review folder that is still saved with the identity the answer
   names. That folder stays until the merge, since this step reads it.
2. The card does not carry `show-me-first`.
3. A `Fix built:` line by that account, after that answer, names the fixed head and the answered head.
4. The answered head is an ancestor of the fixed head.
5. The fixed head holds no `check` reason and no wait reason the answered head did not hold.

## A Herdr job

A Herdr job reads no card comment, local file, menu answer or `Fix built:` line as approval, on either runtime and at
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

| Waiting job | Who acts on the record | Route |
|---|---|---|
| A Herdr job open in its tab, on either runtime | The job session, woken by the answer `I removed the marker` once the owner has removed the marker | [Herdr job](herdr-job.md#the-merge-route) |
| A pre-approved run card whose session is open in the sidebar | The run session, on the owner's next message | [pre-approved-sidebar.md](pre-approved-sidebar.md), item 6 |
| Any other waiting job | The coordinating session, when the owner next asks what is waiting; a named session still running is stopped first | [batch-review.md](batch-review.md), step 2 |

The owner removes a Herdr job's marker and answers its question in its tab, or tells the coordinator to do both. For
card records, the queue panel says which route applies before and after an answer. It wakes no session.
