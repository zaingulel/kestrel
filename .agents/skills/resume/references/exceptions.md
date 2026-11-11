# Exceptions

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Before intake: the git guard is not running

Tell the owner so
before anything else, in plain words: this session's git guard is off, the turn-end check may be off with it, and
the fix for this runtime. On Codex the owner has Codex trust the project, removes any `hooks = false` or
`codex_hooks = false` under `[features]` in the Codex `config.toml`, then runs `/hooks` in the Codex command line
at the repository root and trusts the repository's hooks; on Windows add the Codex shell-command limit
`docs/AI-WORKFLOW-runtimes.md` names, which trust does not lift. On Claude Code, which has no hook trust step, the owner
starts the session at the repository root or a job worktree root with `disableAllHooks` turned on in no settings
file or start option; `/hooks` there lists the hooks that session has configured. When the result itself reports
that a hook failed to start, name that failure and its remedy in place of the fix above, such as restoring Node
to the command path. Run the command again when the owner reports the fix done.

## 3. Start the job: the card is not free

The claim command's exit 3 is **Not free** and its exit 2 is **Could not confirm**, both before any write. The facts
below come from its output: `before:` lines give the card read and the board read, `intake:` lines give the column,
assignees and latest claim the intake showed, and the last `outcome:` line gives the reason. A hand free check under
[claim-reads.md](claim-reads.md) reaches the same two cases, with its own reads in place of those lines. "Those" below
are the Free criteria there.

  - **Not free**, when complete reads fail any of those. Start nothing and write nothing to the card: no
    worktree, no branch, no board move, no assignee, no comment. Tell the owner in plain language which card it
    is and that it is no longer free; the state, the matching project and column, the assignees and the newest
    claim the reads show, beside the board, column, assignees and claim the intake document showed; and who holds it and
    since when: the machine and runtime named by a claim the document did not show, the account that posted it
    and the time GitHub recorded, and any account in `assignees` that the document did not list, assigned since
    intake at a time the reads do not give. When no such claim and no such account names a holder, say that the
    card does not show who holds it or since when, and fill neither in. Say that this session started nothing
    and wrote nothing, and that the owner can pick another row.
  - **Could not confirm**, when either read failed or is incomplete. The card is never treated as free. Start
    nothing and write nothing to the card. Tell the owner that the session could not confirm the card is free;
    what failed or what the output lacked, with the error printed; that nothing was started or written; and
    that the session reads again on the owner's say, or the owner can pick another row.

## 3. Start the job: another claim or an unconfirmed claim

The claim command's exit 4 is **Another claim is first** and its exit 5 is **Could not confirm** after the writing
began. Its `wrote:` lines give what it wrote to the card, with the session's own claim and its address once posted;
its `before:` lines are the read before the claim and its `after:` lines the card read after it. The command is never
run again, because a second run posts a second claim. After exit 5, the read again that **Could not confirm** allows is
the card read of [claim-reads.md](claim-reads.md) by hand, judged against the `before:` lines as that file's check after
the claim does.

  - **Another claim is first:** withdraw and build nothing. Rewrite the session's own claim by its number, the
    digits that end its address, so that it no longer reads as a claim:
    `gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<comment-id>" -f body="Withdrawn: <machine>, <runtime>, <time>: an earlier claim holds this card."`,
    with the three values the claim carried. Leave the card in `In progress`, which is now the holder's column.
    Run `gh issue edit <issue> --remove-assignee @me` only when the account on the session's own `claim` line
    is not in `assignees` in the read before the claim and is not the account on the holder's `claim` line: one
    owner's machines share the assignee, and removing it would take it from the holder. Where no read shows
    both `claim` lines, leave the assignee and report it. Remove the worktree and branch this session created
    for the job as [closeout step 5](../../closeout/SKILL.md) says for a job's worktree and branch, under closeout's
    [Disposable job cleanup](../../closeout/SKILL.md#disposable-job-cleanup) authority; a worktree the runtime manages is left to the runtime. A
    withdrawal step that fails is reported with its error and what it left behind, never forced. Tell the owner
    in plain language that another session claimed the card first; the holder's machine, runtime and account
    with the time GitHub recorded, beside this session's own; what this session changed on the card and what it
    put back; what it removed locally; that nothing was built; and that the owner can pick another row.
  - **Could not confirm**, when the read failed or is incomplete. The card is never treated as held. Build
    nothing and change nothing more: the claim, the assignee and the column stay as they are. Tell the owner
    that the session could not confirm the card is free of an earlier claim; what failed or what the output
    lacked, with the error printed; and what the session has already written to the card. Read again on the
    owner's say, without posting a second claim, and withdraw as above when a complete read shows another
    claim first.

## 4. Plan: capped seats

- **Capped architect.** An `architect` reply that does not end with the line `plan delivered in full` is capped. The
  session never resumes or messages that architect, even where the runtime offers to. It reads the plan file, or the
  plan in the reply where the reply says the file could not be written; every point the architect settled is held there
  and any other point is still open. It then either dispatches one fresh `architect` narrowed to the open points, with
  that plan on its `Discovery:` line, or finishes the plan inline from it; when that fresh dispatch is capped too, the
  session finishes the plan inline. A split proposal in that plan goes to the owner as the "4. Plan" bullet beginning "A plan names its scope" says, never
  narrowed or finished inline. A capped architect is never by itself a reason to dispatch `oracle`.

- **Capped oracle or security reviewer.** A reply from either seat that does not end with its finish line,
  `brief delivered in full` for the oracle and `security review delivered in full` for the security reviewer, is
  capped; a charter's return for a missing finding or result file is not. The session never resumes or messages
  that seat, even where the runtime offers to. It reads the result file, or the result in the reply where the reply
  says the file could not be written; every point the seat settled is held there and any other point is still open.
  It then either dispatches one fresh seat of the same name narrowed to the open points, with that result file in
  the dispatch, or finishes the result inline from it; when that fresh dispatch is capped too, the session finishes
  inline. A security review the session finished inline is declared in the pull request body's Review section.

## Parking

`handoff` when the work is genuinely unfinished: commit what exists and prepare the draft pull-request body
locally. A bare `handoff` or `park` request does not authorize remote publication. Follow the handoff skill's
explicit publication-authorization gate before pushing the branch or creating or updating a draft pull request.
After authorized publication, keep **Not done** current and return the card to `Ready`; a card whose newest claim
names `Claude Code cloud` instead stays in its column under that claim, as step 4 of "Cloud build" says. The next
session finds it in step 1.
