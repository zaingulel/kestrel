# Advance approval

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 2. Work-pick

**Advance approval.** Gate four in `AGENTS.md` lets the owner approve a card once, ahead of the work, through merge,
only where fetched `main` settings explicitly hold `"preApprovedRun": true`. An absent file or key, or `false`, leaves
ordinary cards requiring the owner's pick and push yes; an unavailable setting grants no approval. It works only where
cards are GitHub issues. Where `scripts/lib/board-config.mjs` exports a `TRACKER` other than
GitHub, the check below prints this line and exits 2, the git guard refuses every pre-approved publish with that
reason, and the session posts no record and starts no pre-approved run:

```text
advance approval needs GitHub issues; this repository's tracker is <TRACKER>
```


- **The check** is `node scripts/board.mjs --approval check <card>...`, which checks the fetched-main setting once
  before any origin or GitHub read. Known disabled prints `not approved <card>: <why>` for each card; an unavailable
  setting prints `unavailable <card>: <error>`. Neither reads GitHub or supplies `post:` text. With explicit true it
  reads each card from the origin repository and prints one line per card: `approved <card> <created> <url>` for a
  valid record; `not approved <card>: <why>`, which for an open card that is no suggested card ends with the text to
  post, `post: Approved: card=<n> edited=<v>`, except under either run mark, which leaves that text out; or
  `unavailable <card>: <error>`, which is never read as approved. It exits 0 for a completed judgement for every card,
  including known disabled without a GitHub read, 1 for a rejected argument, and 2 when the setting, a card or the
  tracker is unavailable.
- **The record** is a comment whose whole body is `Approved: card=<n> edited=<the card's lastEditedAt, or none>`,
  with no other text. It is valid while the card is open and its title does not begin `Proposed: `, its `edited=`
  value is the card's current `lastEditedAt`, so an edit of the card's body voids it, the comment has never been
  edited, the account `gh` is signed in as posted it, and it was posted after the card last closed, so a merge or a
  reopen voids it. In a run it counts only when posted before the run started. The oldest valid record wins. A card
  with more than 100 comments reads as unavailable.
- **Posting one.** Only the owner posts a record, outside any agent session: from their own terminal, the GitHub website
  or the GitHub mobile app; the git guard refuses every agent session a shell command holding `Approved:` wherever its
  hook sees the command, as Forgery below bounds. The owner asks in their own message, which may name the cards in any
  form: numbers, a range, "these three". Ask one question only where the list, or whether merging is included, is
  unclear. Run the check over every card named; only explicit fetched-main true can supply record text to post. A card
  it prints `approved` needs nothing; a card whose line carries no `post:` text is dropped, and the owner is told the
  reason the line gives. For each other card give the owner that text exactly, with `gh issue comment <card> --body
  "<text>"` to run in their own terminal, or the text to post on the card on GitHub; once the owner says it is posted,
  run the check again: the card is approved only once that read prints `approved` for it.
- **Withdrawing.** The owner deletes the comment or edits it, for example to begin `Revoked:`. Either voids it for
  every later publish, a run in progress included, because the guard reads the record at each publish. A merge the run
  has already queued with `--auto` is GitHub's to finish, and a withdrawal does not cancel it: the owner turns it off
  with `gh pr merge --disable-auto <number>`.
- **Forgery.** The owner and every session post as one GitHub account, so the author rule stops only another account. No
  agent session posts or quotes a record: the git guard refuses, in every session, any shell command holding `Approved:`
  that its hook sees, and a record posted after a run started is not valid in that run. The guard reads only the command
  text its hook is given, so a record it cannot see would count, and is a finding: one in a file an editing tool wrote
  and sent with `--body-file`, one the shell assembles from pieces, one sent as input to a command already running, one
  a GitHub tool outside the shell posts, or any command run through Claude Code's PowerShell tool, which the hook does
  not watch on any platform, or by Codex on Windows, whose shell commands fire no hook there as
  `docs/AI-WORKFLOW-runtimes.md` says. The run start is this machine's clock, so a wrong clock moves that line.
- **At work-pick.** Where cards are GitHub issues, run the check once over the cards of the startable rows before the
  table is shown. Only explicit fetched-main true lets a card it prints `approved` start without a pick, the oldest
  record first, then the lower card number: say which card the session took and that its record approves it, link the
  record, and go on at "3. Start the job". Known disabled leaves every card requiring the owner's pick. An `unavailable`
  line is reported with the table, and that card is offered as a row without advance approval.

## 7. Push authorisation: advance approval at push

**Advance approval at push.** Run the check again at push, even if the card was approved at work-pick. Only explicit
fetched-main `"preApprovedRun": true` and a valid record, as **Advance approval** under "2. Work-pick" says, make the
record gate two's yes to the card this section writes, unless a stop holds. Known disabled requires the owner's push
yes; unavailable is never approval. With that approval its Summary ends with the line
`Approved in advance: <record url>`, the address the check prints, in place of any `Picked:` line. Once the card is
complete, judge the stops from the saved `body.md`; each needs a fresh yes:

1. the plan's surface line names the Surfaces table's `owner-directed` or `sign-off` row, or section 6 chose the
   `sign-off` tier;
2. block 3 is not `Nothing`;
3. the review line shows a finding that was not fixed, or the Review section declares how a review ran;
4. `Failed:` names a failure;
5. block 2 shows a screenshot;
6. `Untested:` names a check that the required `test` check does not run once the pull request is ready;
7. `node scripts/board.mjs --approval check <card>` no longer prints `approved` for the card;
8. a material limit the card did not carry;
9. in a pre-approved run, `scripts/gates/pre-push-main` admits the change whole, so the direct route would carry it.

With no stop, the review folder is saved as Saved write-up says and the identity it gives is written to `shown-hash` once the card is complete,
though nobody is asked, and section 8's checks of that folder apply as for a yes. The body's `Decision card` block
carries the card on GitHub, and on the direct route the commit message carries it. A session the owner drives shows
the card in chat, says it is going ahead on the record and links it, then runs section 8. A pre-approved run's card session does as step 6 of the pre-approved run in [pre-approved-run.md](pre-approved-run.md) says.

Where a stop holds, the yes is asked for as for any card. A session the owner drives asks it as this section says. During section 8, a repair
that makes a stop hold first runs `gh pr ready <pr> --undo`, which the git guard admits for the session's own job
pull request even once its record is withdrawn, then stops as above.
