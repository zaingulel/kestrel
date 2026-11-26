# Merging on evidence

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 7. Push authorisation: merging on evidence

A job started from a `Ready` card holds gate two's yes when its evidence does, as `AGENTS.md` says under "Owner
gates": it delivers through section 8 with no question, unless the level below holds every card or a wait reason holds.
A Herdr job, on either runtime, ignores the level and every wait reason but three, as **A Herdr job** below says.

A direct local GitHub start has the same eligibility only when this session retains the actual owner's explicit
named or table pick in the local claimant's chat and the exact exit-0 winning claim address for that repository and
card. A launcher prompt, board comment, claim or summary alone is not the owner's pick. Before the first automatic push
judgement and before each automatic ready judgement for that job, repeat the complete card and board reads in
[claim-reads.md](claim-reads.md), passing the bound repository explicitly as `--repo` to the issue read and typing its
owner and repository as literal values for `-F owner` and `-F repo` in the GraphQL board read. Use the same bound
repository for both reads. Match the configured project in the board read. Corroborate the original winning claim: the card is `OPEN`,
the matching board placement is `In progress` before first push or this job's own `In review` before ready, the current
assignees include the winning claim's author, and the exact claim address still appears as a current `Claim:`. A
withdrawn or superseded claim cannot qualify; another currently plausible claim makes ownership ambiguous until
resolved, never assumed to have won. Check existing holds through the existing rules.

If ownership is lost or cannot be corroborated, stop delivery and surface the reason without board writes that imply
ownership, including `Awaiting push`; leave an open draft in draft before ready. If ownership is corroborated but the
human-pick witness is unavailable, use the existing explicit push-authorisation route. Every wait reason and recorded
approval still applies.

**The level.** `waitForOwner` in `.agents/factory-settings.json` on the fetched `main` sets when finished work waits
for the owner. `when-needed` lets work merge on its evidence; `on-screen` does the same except for work on screen,
which waits for the owner's yes; `always` holds every card for the owner's yes, and is what an absent file or key
means. Any other value, and a settings file still holding the retired run setting it replaced, is refused by name, and
a level that cannot be read is never `when-needed` or `on-screen`.

**The wait reasons.** Seven reasons hold finished work for the owner. Five are judged from the saved write-up at `HEAD`
with its HTML comments and fenced code blocks taken out; the other two come from the level and from the card.
`WAIT_REASONS` in `scripts/lib/merge-evidence.mjs` holds them, in the order they are reported:

| Reason | Holds when |
|---|---|
| `check` | the saved write-up shows a `Failed:` line other than `none`, an `Untested:` line other than `none`, no single valid and settled review line, or a review declaration that fails the check contract. When judging an open pull request, the published body can also hold `check`. A required check that fails or never reports also blocks the merge on GitHub |
| `screenshot` | the saved write-up shows neither "no visual change" nor a `screenshot-<n>` file in the review folder; at a run session's ready and merge, also a screenshot whose image the pull request body does not carry, as [visual.md](visual.md) says under **Attaching screenshots** |
| `beyond-card` | the saved write-up shows a `## Not done` section other than exactly `Nothing`, which block 3, "What a yes accepts", shows |
| `sign-off` | the saved write-up shows a review line whose tier is `sign-off` |
| `hard-to-undo` | the saved write-up shows an `Undo:` line reading `hard` |
| `on-screen` | the level is `on-screen` and the saved write-up does not say "no visual change", so work with a screen change waits even where its screenshot is saved |
| `show-me-first` | the card carries the marker, at every level and however clear the write-up |

**The marker.** The owner holds a card for a look before it merges by marking it `show-me-first`: the label of that
name on GitHub, Linear and Jira, a tag of that name on Azure, and on a markdown board the card-file line `Show me
first: yes`, where any other value is refused. A card that carries it never merges on its evidence, and a card whose
marker cannot be read is not judged clear.

**A Herdr job.** A coordinated Herdr job on either runtime merges a card taken from `Ready` with no owner question,
including after a repair. Only `check` (a failed or missing required check), `screenshot` and `show-me-first` hold it:
`waitForOwner`, the review tier (`sign-off` included), `hard-to-undo`, `beyond-card` and `on-screen` hold nothing.
`node scripts/board.mjs --waits <card> --herdr` prints that verdict, and the guard reads the same three at the job's
ready and at its pinned merge. The marker waits for one yes, which is the owner removing the label, himself or
through the Herdr coordinator on his own message, and that yes carries through every later repair; no note, comment,
menu answer or fix record is an approval, as [A Herdr job](owner-answer.md#a-herdr-job) says. The route is
[the merge route](herdr-job.md#the-merge-route). The
merge report and the queue say where only a merge's route decides: a Herdr job merges past `sign-off`, `hard-to-undo`,
`beyond-card`, `on-screen` and the every-card level, and every other route waits for them.

**The `check` contract.** A valid review line is one line in the base or the add-on form the Review section of
[the pull request template](../../../../.github/pull_request_template.md) defines, with `rounds` at least 1 and counts
with no leading zeros. It is settled when `raised` equals `fixed` plus `dismissed` plus `deferred` and `deferred` is 0,
so a true finding left unfixed waits; the add-on's counts must also nest as the template says, or the work waits.
A declaration of how the review ran holds `check` except for a valid
[Codex primary fallback](review-routes.md#codex-primary-fallback). Before publication, the saved declaration suffices
for the review part of `check`. When judging an open pull request, a fallback in either copy requires the same valid
declaration in both the saved write-up and published body. A missing or different declaration holds `check`.
`Untested:` names only the checks that will not have run when the pull request
merges: a check the repository's testing strategy records the required `test` check as running is left out, and any
other check not run is named there and holds the work. A write-up missing its `Failed:` line, its `Untested:` line, an
`Undo:` line reading `easy` or `hard`, or its `## Not done` section, or one giving `## Review` or `## Not done` twice,
is unreadable, never clear.

**The judgement.** `node scripts/board.mjs --waits <card>` (with `--herdr`, the verdict for a Herdr job), run in the job's worktree, takes a card number or a tracker
identifier such as `AB-12`. It reads the level and the saved write-up of the card at `HEAD`, then the board for the
card's marker, and no pull request. It prints `merges <card>` where nothing holds, or `waits <card>: ` followed by the
held reasons in that order and, at `always`, the line `every card waits for you: waitForOwner is always`, joined by a
semicolon and a space. It exits 0 for a judgement, 1 with its usage for a rejected argument, and 2 for a level,
write-up or board it cannot read, or a card the board does not hold, naming it on stderr as `unreadable <card>:
<cause>`. It is the judgement the git guard makes of a pre-approved run session's `gh pr ready` and `gh pr merge`, which
the guard also makes of the pull request's published body, refusing while either holds a reason, while the pull
request's head is not `HEAD` or while its body lacks a screenshot's image. The guard reads the marker from the card's
labels at each of them and refuses when it cannot read all of them; at `on-screen` it refuses work on screen when
either the write-up or the published body does not say "no visual change". A held reason stops the session only
until the card records the owner's answer for the version at the pull request head, or a fix built from an answered
head that the fix path admits, as **Owner answer** in [owner-answer.md](owner-answer.md) gives; the guard reads
the newest such record by the account the session publishes as. Where that record is not whole, or another account last
edited a comment by that account, no answer holds, and an answer for the head itself admits no reason the saved card at
that head lacks. The guard also refuses a pre-approved run session's push while its pull request is ready or has a merge
queued, and publishes a run's card only when the card's newest claim was made during that run by the GitHub account the
session publishes as.

**At push.** Once the review folder is saved at `HEAD` as Saved write-up says, run the judgement.

- `merges <card>`: nobody is asked. The identity Saved write-up gives is written to `shown-hash` all the same, and
  section 8's checks of that folder apply as for a yes. The body's `Decision card` block carries the card on GitHub,
  and on the direct route the commit message carries it. Section 8 runs. Before each `gh pr ready <pr>` the folder is
  saved again where `HEAD` has moved and the judgement runs again, and a `waits` line there is handled as the next
  item says, after `gh pr ready <pr> --undo` where the pull request is ready. After the merge, the session shows the
  owner blocks 1 and 2 of the decision card, each screenshot inline, with the pull request's address, then runs
  `closeout`.
- `waits <card>: <reasons>`: for a Herdr job, a `check` or `screenshot` hold is repaired in the job and judged again,
  as [the merge route](herdr-job.md#the-merge-route) says. Any other hold takes these steps: move the card to
  `Awaiting push`, post the comment `Waiting for you: <reasons>` on the card with the reasons printed, and show that
  line in chat directly before the decision card, then ask the question.
- Exit 2: a write-up the judge cannot read is repaired to the template, saved again and judged again; a level it cannot
  read stops with what the command printed. Nothing is delivered on an unread judgement.

**Rebuilt work.** Work rebuilt on an owner's change request merges without being shown again where the fix path of
**Owner answer** in [owner-answer.md](owner-answer.md) admits it, so its write-up lists no new reason to wait.
Where the path does not admit it, or the owner asked to see it, the write-up lists that request, in the owner's words,
as its first Not done item, so it waits under `beyond-card` and the owner sees it again.

**Holding work back.** The owner prevents automatic pickup by leaving a card out of `Ready`. After an explicit
direct start, the owner holds delivery by marking it
`show-me-first`, and holds every card by setting `waitForOwner` to `always` on `main`. The marker is read at push, before each
`gh pr ready <pr>` and by the guard at a run's ready and merge; a marker set after the merge is queued with `--auto` is
not read, so the owner stops that merge with the Disable auto-merge button on the pull request page. A held card with
no visual change shows `no visual change` in place of a screenshot, as its decision card already does.

**What the guard checks.** For a run session the evidence is a write-up the session declares itself: the guard checks
that it holds no wait reason, or that the card records the owner's answer for it, and only the fresh review and the
published body show that the write-up is true. The record proves an answer exists for the version, not that its words
are a yes.
