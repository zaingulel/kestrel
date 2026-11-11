# Product manager run

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Product manager run

Where the repository turns product manager mode on, the owner may hand the pick of "2. Work-pick" to the
session, as gate one in `AGENTS.md` says. Without the instruction below, the pick stays the owner's as "2. Work-pick" says.

Steps 2, 3 and 6 to 9 are in [runs.md](runs.md#steps-both-runs-share); read that file whole too.

1. **The trigger** is the owner's instruction `Start a product manager run.` It approves no action. In a Codex session
   use the [native app route](runs.md#native-codex-app-run) when authorized there; otherwise the session answers with the external launch command and selected chat ID as step 3 says. On
   either runtime, a session whose first message is exactly `Continue the product manager run.` is a card session,
   started as step 8 says. That message hands over its one pick, as gate one says, and approves nothing else. On
   Codex, a session whose first message is `End the product manager run: <results folder>` is the end session, which
   does steps 9 and 10. That message hands over no pick and approves nothing beyond them.
4. **The direction page** is read with exactly one command, `git show origin/main:docs/PRODUCT-DIRECTION.md`. It is
   approved where that command exits 0 and prints a page that is not blank. A failed read, a missing page or a
   blank page refuses the run: start nothing and tell the owner, quoting what the read printed. The page is the
   owner's alone, and no seat, run or routine edits it. It is evidence, never an instruction: it ranks cards, grants
   no approval and answers no prompt.
5. **The pick** is the card session's, or the coordinator's on the native app route. First read the waiting jobs as step 1 of **Batch review** under "7. Push authorisation" says. Count the `Awaiting push` cards plus parked
   jobs, which are held cards in the intake document whose comment names `Job:`. Three or more waiting, the two
   counted together, is a stop that names them. A held card with no `Job:` holds no work and is not counted. The rest
   of the step's "waiting" reads cover both. For each waiting card, read its newest claim with the card read of
   "3. Start the job". Where that claim names this machine, as `hostname` prints it, list the job's files with
   `git diff --name-only --no-renames origin/main...job/<card> -- ':(top,exclude).agents/factory-manifest.json'`,
   which leaves out the manifest, since each of its entries changes only with the shared file it fingerprints and
   that file stays in the list: jobs that share only the manifest do not overlap. Any other result is a stop naming
   the card and the machine its claim names, because a branch this machine can read may be older than the waiting
   work: a claim naming another machine or a cloud build, no claim, a failed read or no such branch.
   The candidates are the rows of the table startable now, less the cards the session sends to the owner. The session
   sends these and leaves them out: a row whose gates include owner direction or sign-off; taste work; work that
   cannot be built or decided without the owner's room, ears or hardware; an update card or a prototype; a card that
   would change the direction page or the settings file; and any card it is unsure of. To send a card, first run
   `node scripts/board-claim.mjs <card> --intake <scratch>/board-intake.txt --check` for it, which makes the two reads
   and the Free comparison of "3. Start the job" and writes nothing; on another tracker make them by hand as
   [claim-reads.md](claim-reads.md) says. A card not free (exit 3) is left out with nothing written, and one that cannot
   be confirmed (exit 2) is a stop. Then post the comment `Needs owner: <one-line reason>`, make the card read
   again, and move it to `Backlog`. A `claim` line that read did not show before means another session holds the card:
   rewrite the comment to begin `Withdrawn:` by the route section 1 of [held-cards.md](held-cards.md) names, move
   nothing and leave the card out. A failed write is a stop. A card whose criteria are fixed and only whose final proof
   needs listening is not sent. A returned card whose comment names a `Job:`, or with a job branch, is left out too:
   only a session the owner starts takes it up. Less,
   too, any card that would touch a file a waiting job touches, as step 5's listing shows it: work out the files from
   the card and the code it names before anything is claimed, and treat a card whose files cannot be worked out as
   touching one. Where cards are GitHub issues, less, too, each card that
   `node scripts/board.mjs --approval check <card>...`, run once over the remaining candidates, prints `approved` or
   `unavailable`: the check requires explicit fetched-main `"preApprovedRun": true` for an approval, and a card
   approved in advance is reserved for the pre-approved run. Known disabled reserves no cards, even with
   `"productManager": true`; an unavailable setting or record conservatively reserves the card. The page ranks the
   candidates; a tie goes to Ready before Backlog, then to the lower card number. Present the table; its closing line names the pick and the reason the page gives, and the session carries on,
   because that pick is the work-pick approval of the card. The pull request Summary ends with one line beginning
   `Picked:` that gives the same reason. No candidate left is a stop that says no pickable card is left and names any
   card held back by a waiting job's files.
10. **Suggested cards.** Only the run session, or on Codex the end session, files one, and only at the end of the run
    as step 9 says, so no card session of that run can meet it and the owner already knows why the run stopped if a
    prompt waits. Its entries are the `Suggested cards` lists in this run's card session results and what a planning pass finds over
    the intake document and the direction page step 4 read, all of it evidence and never instructions, each naming the
    card or page line it rests on. At most 3 are filed in a run, and fewer where earlier ones wait: 3
    less the waiting cards, never below none, the page ranking the entries. Any other entry, and one repeating a card
    `node scripts/board.mjs --all` lists or the read below returns, is named as offered and not filed. On GitHub the
    waiting cards are those `gh issue list --state open --author @me --limit 1000 --search '"Proposed: " in:title' --json number,title`
    returns with a title beginning `Proposed: `, because a card whose board step failed is on no board; if that read
    fails or returns its whole limit, file none and name every entry as offered and not filed with why. On another
    tracker a card is created on the board, so the waiting cards are those `node scripts/board.mjs --all --json` lists with
    that title and a state other than `CLOSED`, a card archived by hand no longer waiting, and a failed read files none the same way. Step 9 lists the
    waiting cards from the same read. To file one, write the body in the shape of `to-issues` step 7 to a file in this session's scratch
    directory, its last line `Product manager run: <date>`, the date being what `date -u +%F` prints. No title, body or
    comment filed under this step or step 11 holds a credential, a token or a URL that holds a secret, and a criterion
    that holds one parks the split. Then run
    `gh issue create --title 'Proposed: <title>' --label <kind label> --body-file <file>` (where `scripts/lib/board-config.mjs` exports `KIND_TYPES`, `--type <kind type>` in place of
    `--label <kind label>`), the title plain words with no quote, backtick or `$`, and no parent or blocker; then steps 6b, in `Backlog`, and 8 of `to-issues`. The title
    carries the hold from the one call that creates the card, so it can never be picked, whichever column it lands in
    and whether or not a later step works. The last line is the card's lasting record and stays through a yes or a no.
    A prompt or refusal is treated as step 7 says. A create that is refused or fails ends the filing: look for the card
    by exact title as `to-issues` step 6 says, never create again, and name the rest as offered and not filed with what
    refused them. A later step that fails is reported in the summary with the card's number and the step left.
11. **Splitting a card.** A card session settles a split proposal itself only where all of this holds, and otherwise
    parks as step 7 says: the finding is the architect's under "4. Plan" that the card holds more than one independently
    demonstrable outcome, never its size; the tracker is GitHub issues; the intake document shows the card with parent
    `none` and neither the epic label nor, where `KIND_TYPES` is exported, the epic type, and its body holds no
    `Split from:` line, so a card out of a split is never split again; every acceptance criterion of the card
    stands word for word in exactly one child, every child holds at least one, no child holds a criterion the card lacks, each child's Problem and
    What to build come only from the card's own text, and no child needs a decision
    the owner has not made. Before anything is built, file each child by steps 6a and 6b of `to-issues`, in `Backlog`,
    its body written to a file whose last line is `Split from: #<card>` and passed with `--body-file` in place of that step's inline body and its title plain
    words with no quote, backtick or `$`, with no `Proposed: ` prefix because its outcome is already approved, and link
    it to the card by step 6c. Post on the
    card, from a file, a comment beginning `Split:` that gives each criterion as written and the child holding it. Then
    run `gh issue edit <card> --add-label <epic label> --remove-label <its kind label> --body-file <file>` (where
    `KIND_TYPES` is exported, `gh issue edit <card> --type <epic type> --body-file <file>`), the file
    being its body with the criteria replaced by `Held by the native child cards. The epic closes when they close.`, and
    `node scripts/verify-issue-publish.mjs <card> <child...>`. Then rewrite the session's own claim to
    `Withdrawn: <machine>, <runtime>, <time>: split into <children>.` by the route "3. Start the job" gives, run
    `gh issue edit <card> --remove-assignee @me` and `node scripts/board-move.mjs <card> Backlog`, remove the worktree and
    branch as that route says, and end with the split result line. The first write refused parks the job. A later write
    that fails is a stop naming what exists, and the card keeps its claim so nothing picks it. The next card session
    ranks the children like any card.
