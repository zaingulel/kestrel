# Herdr job

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md). It holds what a coordinated Herdr job does; the
[Herdr coordinator reference](herdr-lead.md) holds the coordinator it reports to.

## Delivery in the job

Reserve delivery once the review is settled and before the final rebase, as [Deliver](deliver.md#delivery) says. Jobs sharing a GitHub repository deliver
one at a time. The reservation and merge watch run inside the job's one Herdr terminal. The job's Agents row shows
a green **Open** or purple **Merged** pull request icon with its state in words and a link to that pull request.
**Merged** requires GitHub confirmation for the exact pull request and head. After the job tab closes, find the
kept merge report in the Fabraik Queue Inbox.

### Recover stopped delivery

The job row shows the waiting or stopped reason. Follow the case it names.

- **GitHub still has the prior pull request queued.** Keep the same reservation task and continue the local
  readiness wait at the next check-in. The task resumes delivery automatically after it confirms settlement.
  When the earlier job needs a runner, follow that repository's runner instructions to unblock the same request.
- **A previous merge watch still needs cleanup.** If the earlier watch is live, let it finish its own cleanup.
  If the reason persists after it ends, run `node scripts/merge-watch.mjs <number>` from the original job in the
  same verified repository and watch-state context. If it names a hook it cannot prove it owns, the owner confirms
  the old forwarder is stopped and that the named hook has been removed through an authorized GitHub operation
  before rerunning the command. After verified cleanup, retry the waiting job's original reservation and
  readiness steps.
- **GitHub or the watch state cannot verify the recorded target.** Keep delivery stopped until the original job
  verifies its exact repository, pull request, head and watch-state context. The original job can use its guarded
  return-to-draft route to settle its own request and confirm it is no longer queued. After verification,
  retry the waiting job's reservation and readiness steps. Before publishing again, the original job needs
  fresh readiness and current delivery checks.

A Claude Code job holds a workflow version and runs from its snapshot, as [Guard and capability
activation](../../shared-files/SKILL.md#guard-and-capability-activation) says. Its recovery differs in order and spelling:

1. Resume the job through the coordinator. Resume keeps the recorded workflow version, repairs that version's
   snapshot and prints each path it wrote. A shared contract that has moved on since is named in the job's resume
   notice, and delivery stays stopped until the cleanup in step 3 ends.
2. While the pull request is still open, the job withdraws it with `gh pr ready <number> --undo`.
3. It runs `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" <number>` until no watcher record is retained.
   That one-argument run only clears a retained watcher record and opens no new watch, whether or not a contract has
   moved. Its guard admits the merge watch only in that spelling, and with a moved contract only this one-argument
   cleanup.
4. Only then are the job's records removed and a new job started.

Only when the job's commit cannot be read, take the owner route instead:

1. Confirm the exact repository and the job's original watch-state directory, which the stopped-delivery message
   prints as the directory the record was read from. Where it cannot be established, hold and report.
2. On GitHub, convert the pull request to draft, turn off auto-merge and remove the named forwarding hook.
3. Wait for the old watch to end.
4. From the root checkout, with `XDG_STATE_HOME` set so that directory is the state directory, run
   `node scripts/merge-watch.mjs <number>`.
5. Confirm the original record file is absent before removing the predecessor.

A pinned job checks itself: an accidentally replaced frozen copy is caught only at the next start or resume, where
it is repaired. Callers without a pinned job keep the bullets above.

### After the merge

Once `closeout` has finished, send `hc send <parent> "Card <N> merged."` to the coordinator. Read `<parent>`
from `hc get $HC_TERMINAL_ID --json`. A merged job stays live at its prompt, so that message frees its running
place. If Herdr refuses the send because the coordinator is blocked, end the turn with `Card <N> merged.`
as the last line of the reply. Forcing the send would type into the owner's question.

## The merge route

A Herdr job's card came from `Ready`, so on either runtime the job merges with no owner question unless the card
carries the `show-me-first` marker. Only a failed or missing required check, a missing screenshot and that marker hold
it. No review tier, `waitForOwner` level or other wait reason of [merge-on-evidence.md](merge-on-evidence.md) does,
and a repair after a first head starts no question. `node scripts/board.mjs --waits <card> --herdr` prints that
verdict.

1. **Review, then reserve.** Rebase onto fetched `main` before dispatching the review. Reserve as
   [Deliver](deliver.md#delivery) says only once the review is settled with every finding closed, the write-up is saved
   naming its head and `node scripts/board.mjs --waits <card> --herdr` prints `merges <card>`; any other line, or a
   failed command, is settled without the reservation. The final rebase keeps the review where it leaves the head
   unchanged, or where it moves the head and both of these hold. First, with the head the review covered as
   `<receipt-head>`, which is the head a `Review carried from:` line names where one already stands, the comparisons of
   the Receipt reuse rule's rebase case in [Deliver](deliver.md#delivery) hold on either route: every `git range-diff`
   row is `=`, neither range holds a merge commit, and the two path lists share no path but a generated file that case
   leaves out. Second, the external review add-on setting, read again on the `main` that rebase used as section 6 says,
   requires no attempt the job has not settled for the new head as the add-on's own skill says. A review kept across a
   moved head settles its convergence checks under that rule and is saved again with its screenshots in the new head's
   review folder, the covered head's folder kept, its `Reviewed commit:` line naming the new head and, beside it under
   `## Evidence`, the line `Review carried from: <head the review covered>`. Where the final rebase leaves the head
   unchanged, the review folder and any `Review carried from:` line stay as they are. Any other final rebase is a
   setback: the job releases as [Deliver](deliver.md#delivery) says under **Release while waiting**, at a conflict stop
   before settling the conflict, and then, without the reservation, settles the rebase and its convergence checks,
   reviews the rebased head and reserves again under this step. Where the add-on needs an attempt on a head that the job
   has not settled, after this setback or a repair after any other, the job gets it first, before it reserves: a job
   that has not armed since it last held pushes the head, which changes nothing where GitHub already shows it, updates
   its draft's body and screenshots as **Final rebase** in [Deliver](deliver.md#delivery) says and takes step 2 there,
   all outside the reservation; a Claude Code job that armed since it last held takes the **Push-only turn** there
   instead.
2. **Name the head.** The saved write-up and the published body each carry exactly one line, `Reviewed commit: <full
   lowercase commit ID>`, under `## Evidence`, naming the head. The guard refuses a ready or merge where either copy
   lacks the line, repeats it or names another commit.
3. **Mark ready.** Holding the reservation step 1 took, run `gh pr ready <number>`.
4. **Wait for the checks.** A Claude Code job arms the pull request and starts its held watch as [Deliver step
   4](deliver.md#delivery) says; the watch exits 0 with `required checks passed on <head>` once every required check has
   passed or skipped on that head, and 1 on a failed check, a moved head or a closed pull request. A Codex job reads the
   checks as [Deliver a pull request](#deliver-a-pull-request) says.
5. **Merge the pinned head.** Run `gh pr merge --squash --delete-branch --match-head-commit <head> <number>` with the
   literal full head and the pull request number, and no `--auto`. The guard reads the marker and the checks at
   submission, and GitHub refuses any other head.
6. **Confirm.** Run `node "$FABRAIK_WORKFLOW_ROOT/scripts/merge-watch.mjs" --delivery-pr <number> <head>` (Codex, the
   same command without the pinned path), which reports **Merged** only on GitHub's merged state, then release the
   reservation and run `closeout`.

A failed check, a missing screenshot or any other repair releases the reservation as [Deliver](deliver.md#delivery) says under **Release while waiting**, is fixed in the job and goes back through steps 1 to 6 on the repaired head with no question. A job never clears
the marker itself; where the card carries it, the job moves the card to `Awaiting push`, releases the reservation the
same way where it holds it and asks once through its
question menu for the answer `I removed the marker`, as [A Herdr job](owner-answer.md#a-herdr-job) gives. That answer carries through every later repair.

## Codex Herdr jobs

Follow this route when the coordinator starts or resumes a Codex Herdr job. Run exactly
`node scripts/coordinator.mjs bind-job` from the canonical integration root as the first workflow command. If it
fails, stop before claiming the card or preparing its worktree. If it succeeds, follow `resume` for the named card.
After preparation, use the registered physical Git worktree for that card and run delivery checks from its root.

On restart, the coordinator resumes the recorded Codex thread. Bind again before claims or worktree changes. A job
that was waiting on the marker first runs `node scripts/board.mjs --waits <card> --herdr`, as the resume prompt says.

Use the native `request_user_input` menu for ordinary owner questions.

### Wait for the marker

Prepare the route under [Deliver](deliver.md) without the reservation. For a pull request, finish the rebase, the draft
and its settled review first. For direct
delivery, finish eligibility and convergence checks and keep the unsquashed head. Judge the card with `node
scripts/board.mjs --waits <card> --herdr`. On `merges <card>`, proceed on current evidence. Where the line names
`show-me-first`, move the card to `Awaiting push`, release the reservation where it holds it, as
[Deliver](deliver.md#delivery) says under **Release while waiting**, call `request_user_input` with one question whose first option is
`I removed the marker`, and wait. The answer only wakes the job, which judges the card again as
[A Herdr job](owner-answer.md#a-herdr-job) says. Free text, cancellation or a refusal leaves the job waiting, and a
provider error holds.

### Deliver a pull request

1. Holding the reservation, past the final rebase of step 1 of [the merge route](#the-merge-route), start with the
   checked open draft and confirm there is no queue entry or auto-merge request. Take the
   repository's `before ready` step, if it names one. Judge the card again as [Wait for the marker](#wait-for-the-marker)
   says.

   Run `gh pr ready <number>`. Start the repository's local runners where required. From then until the merge, whenever
   the job knows a required runner only the owner can start is offline, at runner start, while checks report or on any
   watch result, a timeout included, it releases as [Deliver](deliver.md#delivery) says under **Release while waiting**
   before asking him to start it.
2. Required checks begin reporting after Ready. Read them with `gh pr checks <number> --required --json name,bucket,link`.
   If the reports for this head have yet to arrive, repeat that read every 30 seconds for up to ten minutes from
   Ready. Hold if they never arrive or GitHub returns a concrete error.
3. Once the checks begin reporting, run `timeout 15m gh pr checks <number> --required --watch --fail-fast`.
   On a failed result, release the same way before the repair; hold on any other pending, unknown or timed-out result. Require the complete required set to be settled
   successfully before merging.
4. Revalidate the head, base, `Reviewed commit:` line, published review, saved decision, the verdict and absence of
   queue and auto-merge. Run the standalone `gh pr merge --squash --delete-branch --match-head-commit <head> <number>` with
   the literal full head and pull request number. GitHub checks the pinned head at merge. The guard checks the
   remaining evidence immediately before submission.
5. Read the exact pull request again as [Deliver step 4](deliver.md#delivery) says, including after an error during
   branch cleanup. If GitHub confirms the merge, release the reservation, follow the repository's runner stop
   rule and run `closeout`. If the result is uncertain, report the observed state and hold. Follow the runner stop
   rule before parking.

If evidence changes after Ready, run `gh pr ready <number> --undo` and confirm the pull request is a draft with
no pending queue, release the reservation, repair the head, settle its review and take the route again from the
reservation before the final rebase.

### Deliver directly to main

Holding the reservation, past the final rebase of step 1 of [the merge route](#the-merge-route), use the [direct-route
preflight and squash recipe](deliver.md#delivery) with the checked pre-squash head, tree and fetched base that rebase
left. Once the card is clear of the marker, squash it. With replacement refs disabled
for the Git reads, check that the squash has the same tree and one parent equal to the fetched base. Check that
the base is an ancestor of the pre-squash head and that the unambiguous `ORIG_HEAD` names that head. Keep
`ORIG_HEAD` and fetched main pinned between the squash and push so the guard can check the approved version.

Run the standalone `git push --no-follow-tags origin <squash>^{object}:refs/heads/main` with the full lowercase
hexadecimal squash ID (40 characters, or 64 in a SHA-256 repository). The `^{object}` suffix selects the object even
if a ref has the same name, and `--no-follow-tags` prevents configured tag following from adding refs to the push.
The pre-push hook checks those objects using the gate on remote main. Release the reservation when the push
tool finishes. On success, run `closeout`.

If the preflight refuses before the squash, nothing is restored and the reservation is released. If the push fails after
the squash, the reservation was released when the push tool finished; use the same recipe to verify and restore the
checked pre-squash version. Either way, then prepare the pull request route and its review before reserving again.

## Claude Code Herdr jobs

A Claude Code session whose first message is the job prompt, which names `resume`, card N and Herdr, is a coordinated
job. It is a plain, kept session, run-marked and bound to card N, and follows `resume` for that card with these changes.

- **Its card.** Card N is its pick: it claims a new card as "3. Start the job" says, and carries on an unfinished one
  from its branch and worklog. Where the card's newest claim predates `printenv PRE_APPROVED_RUN_SESSION`, it claims
  again first, because the guard needs a claim made during the run. Resumed after a restart with no branch for card N,
  it claims card N again before any other step, as "3. Start the job" says from a fresh intake: where that intake does
  not show the card in `Ready` with no assignee it claims nothing, and otherwise it handles each `board-claim` exit as
  that step and [exceptions.md](exceptions.md) say, withdrawing its own claim after exit 4 and never running the command
  again after exit 4 or 5. It carries on only after exit 0, and otherwise stops and asks the owner through its question
  menu.
- **Asking the owner.** Every point where `resume` would park the card or stop for the owner is an
  AskUserQuestion with context that stands alone, shown after the decision card where one applies. A job never asks as
  plain text at the end of a turn, never parks to a `Needs owner:` comment and stays open until the card is merged or
  the owner ends it. Asking takes no running place, and a job holding the delivery reservation releases it first as [Deliver](deliver.md#delivery) says under **Release while waiting**.
- **The owner's answer.** Only the marker holds the job, and the owner removes it, himself or through the coordinator
  on his word. The job's question menu carries the answer `I removed the marker`, which wakes it as
  [A Herdr job](owner-answer.md#a-herdr-job) says. A job resumed after a restart in `Awaiting push` runs
  `node scripts/board.mjs --waits <card> --herdr` first and asks again only where the line still names `show-me-first`.
- **Waiting.** A job waits on a terminal that already runs with `hc wait <terminal>`. For elapsed time alone it starts one
  timer, `hc run --bg --no-notify --name <folder>-job-<N>-wait -- sleep <seconds>`, its `<folder>` cut as in its own
  Herdr name but leaving room for `-wait` within Herdr's 32-character limit, and waits with `hc wait` on that name.
  Before waiting it states in its own session what it waits for and until when. A return for a message or a timeout
  check-in is not the end: it handles the message and waits again. The time has come only when `hc get` shows the timer
  exited 0; any other end means the timer was stopped, which the job reports in its own session before it decides what
  to wait for next. Either way it then removes the timer with `hc rm`, and a wait it gives up ends with `hc kill` and
  `hc rm`. It never polls GitHub while it waits.
