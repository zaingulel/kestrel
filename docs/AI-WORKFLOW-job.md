---
description: This page follows one approved card to one commit on main, stage by stage. It shows who acts, what each stage leaves behind and what a machine holds there.
---

# The life of one change

## Summary

A job takes one approved card to one commit on `main`. This page follows that path stage by stage: who acts, what
each stage leaves behind and what a machine holds there. Use it to understand a job before you run one, or to see
where a stopped job stands. The exact steps are in the [`resume`](../.agents/skills/resume/SKILL.md) and
[`closeout`](../.agents/skills/closeout/SKILL.md) skills, and this page owns none of them.

A finished job leaves four things: the approved outcome in git history, a receipt for each check, a recorded review
and a matching board. Together they form a trail from the card's acceptance criteria to the job branch, its
receipts and the publication record. That record is the pull request, or the commit message on the direct route. A
later session reads the trail to tell intended, unfinished and shipped work apart, without the conversation behind it.

## Mental model

Every job passes through the same stages in the same order. The session that talks to the owner coordinates each one,
and [The seats](AI-WORKFLOW-seats.md) shows which agent it hands each piece of work to.

| Stage | Who acts | What it leaves | What a machine holds |
|---|---|---|---|
| Start | The owner picks the card; the session confirms it is free and claims it | A worktree on its own branch, a claim comment and the card in In progress | The git guard refuses branching and committing in the root checkout |
| Plan | The architect or the session, with a plan review where the card needs one | A plan naming each slice's files and claim | The handoff hook refuses an incomplete architect handoff on Claude Code |
| Build | A builder seat, one slice at a time, or the session for a wording-only change | A commit for every green slice and a receipt for every check | The handoff hook refuses an incomplete builder handoff, and the green check refuses a turn that ends on a lint error |
| Review | The reviewers required by the selected tier, and the security reviewer when the trust perimeter widens | Settled findings and a review line | Nothing: review rests on instruction |
| Push authorisation | The session's judgement of the saved write-up, then the owner where a wait reason holds | Work that merges on its evidence, or the card in Awaiting push with its wait reasons and one yes to the decision card and its screenshot | In a run session the git guard refuses a ready or merge the judgement holds; elsewhere the judgement and the yes rest on instruction |
| Delivery | The session, then the platform | A draft pull request, checks on the merge result and a squash merge; or a push straight to `main` | The git guard refuses a pull request that is not a draft, an unsafe force push and every merge form but auto-merge and, for a Herdr job, the pinned squash merge |
| Closeout | The session | The issue closed, the card in Done and the job's worktree and branch removed where checks pass | The cleanup command keeps every target its checks or git hold back |

Responsibility moves between the owner, the job, git and GitHub as the job runs.

```mermaid
flowchart LR
    accTitle: Where each responsibility sits during one job
    accDescr: The owner approves the work and its publication, the job keeps its changes and evidence on its branch, and GitHub and the local hooks carry an approved push and report back.
    O[Owner] -->|work-pick and push authorisation| J[Job]
    J -->|changed files and evidence| B[Branch and worklog]
    B -->|approved push through the local hooks| G[GitHub]
    G -->|publication state| J
    G -->|pull request route only| CI[Continuous integration]
    CI -->|required check results| G
    J -.->|where the tier requires it| X[External reviewer]
    X -.->|review or declared unavailable| J
```

The preceding diagram shows where each responsibility sits during one job. The owner approves the work and its
publication. The job keeps its changed files on its branch and its evidence in its worklog. An approved push crosses
into GitHub through the local hooks. On the pull request route, GitHub runs continuous integration and records the
required check results. GitHub reports the publication state back to the job. The dotted pair is the external review,
which runs only where the tier requires it and the repository turns that add-on on. It returns a review or a declared
unavailable result. Neither arrow style means a machine enforces the step.

## How it works

```mermaid
flowchart TD
    accTitle: One card from the owner pick to closeout
    accDescr: A card moves from the owner's pick through a worktree, plan, build, review and push authorisation to a merged change or a direct push, and then closeout.
    C[Startable card] --> WP[Work-pick: the owner picks the card or queues it in Ready]
    WP --> WT[Worktree on its own branch, card to In progress]
    WT --> PL[Plan, with a plan review where the card needs one]
    PL --> BD[Build in bounded slices, every check logged]
    PL -.->|plan approval on| AP[The owner approves the completed plan]
    AP -.-> BD
    BD --> VR[Verify, then the tier's required reviews of the final tree]
    VR --> PA[Push authorisation: merges on its evidence, or waits in Awaiting push for the owner's yes]
    PA -->|pull request route| DR[Draft pull request, card to In review]
    PA -->|direct route: the gate admits the whole change| FF[Push straight to main]
    DR --> RD[Marked ready: checks run on the merge result]
    DR -.->|sign-off tier, add-on on| ER[External review settled]
    ER -.-> RD
    RD -->|required checks green| MG[Squash merge, branch deleted]
    MG --> CO[Closeout: issue closed, card to Done, cleanup checked]
    FF --> CO
```

The preceding diagram follows one card from the owner's pick to closeout. After bounded building, the job verifies the result and completes its tier's required reviews. Solid arrows show the usual path. The dotted
pair after planning applies only where the repository turns plan approval on. The dotted pair after the draft applies
only to a `sign-off` change where the external review add-on is on. The direct route skips the pull request and joins
the usual path at closeout.

### Starting a job

Intake reads the board, the open pull requests and the local state together, then reconciles them. Its exit status
separates a failed board read, drift between the stores and a card whose details it could not read. Intake never
offers such a card as startable, and a failed read stops selection rather than reading as an empty board.

The owner picks by putting cards in Ready, and a session takes the top startable card there unasked. On GitHub Projects
that is the top of the column; on other trackers it is the lowest card number. Where Ready holds none, or the owner
asks, the session shows a table of every candidate. The session claims a startable GitHub card picked from it, or named by the owner, directly against the intake. Other trackers follow their own pick procedure. The owner's pick approves the
card's outcome and acceptance criteria as written. Fresh checks still confirm that the card is free before
anything starts. Each card then gets its own git worktree on its own branch, and the root checkout stays on `main`. Two
cards in two terminals never share a working file.

A job branch stays local until the push, so another machine cannot see it. The session therefore posts a claim comment
on the issue, which every machine can read. On the GitHub Projects tracker one command, `node scripts/board-claim.mjs`,
checks that the card is still free and posts the claim. [The `resume` skill](../.agents/skills/resume/SKILL.md#3-start-the-job)
owns where that command runs and where the worktree lives on each runtime, under "3. Start the job". On another tracker
the session claims by hand as [the claim reads](../.agents/skills/resume/references/claim-reads.md) say.

### Planning

Every change has a plan. A card on a `plan-first` surface gets an architect's plan and one read-only plan review before
any build. Another card with design choices still open gets an architect's plan. Every other card gets the session's
short plan in the pull request body.

A plan names the files each slice changes and the claim each slice proves, never a line estimate. Size is the owner's
judgment before work-pick, so no seat splits or replans a job for its size afterwards. A card that holds more than one
independently demonstrable outcome goes back to the owner as a split proposal. Each claim also gets a fixed observer,
an expected result grounded outside the code and a construction mode, as [The evidence bar](AI-WORKFLOW-evidence.md)
explains.

Where the repository turns plan approval on, the session presents the completed plan after any plan review. The agents
build nothing until the owner says yes. The session makes any change the owner asks for and presents the plan again.
No guard holds this gate.
[The `resume` skill](../.agents/skills/resume/SKILL.md#4-plan) owns planning and the gate's steps, under "4. Plan".

### Building

Builder seats build one slice at a time from a filled handoff. The session edits only a wording-only change, which
[`AGENTS.md`](../AGENTS.md#runtime-notes) defines under "Runtime notes". Two slices with disjoint files may run at once. The second runs in its own worktree cut from the job branch and merged back into it. A runtime's
own subagent worktree branches from `main` rather than the job branch, so no builder runs in one.

Every check runs through a logger, `scripts/run-log.mjs`, which writes its real exit code to the job's worklog. The pull
request body then quotes what a script wrote, not what an agent remembers. The worklog stays on the machine that ran
the job and does not travel with git.

The session commits every green slice on the job branch, so a crash costs at most the slice in progress. A builder
regenerates any artifact the `generated artifacts` row of the Conventions table in
[`.agents/REPOSITORY.md`](../.agents/REPOSITORY.md) names, and the session commits it with its source. Nobody merges
such an artifact by hand, and the hooks keep it from landing stale.
[The `resume` skill](../.agents/skills/resume/SKILL.md#5-build) owns the build steps under "5. Build".

### Verifying and reviewing

Before review, the session drives visual work and shows a current screenshot in chat. Any further check the Surfaces
table names for a touched surface runs here too.

Then the selected tier's required reviews read the final tree. Two questions choose the tier: can the change be undone,
and how far does the damage reach if it is wrong? The answers choose the `document`, `code` or `sign-off` tier that
[the review line](AI-WORKFLOW.md#the-review-line) records. A builder repairs a true finding, the session verifies it
again, and a pass scoped to the repair reviews it. The session dismisses a false finding with a reason.
[The `resume` skill](../.agents/skills/resume/SKILL.md#6-verify-and-review) owns the tiers, the reviewer routes and the
repair rounds, under "6. Verify and review". [The cross-review route](../.agents/skills/cross-review/SKILL.md) explains the independent paired passes.

### An example journey

Suppose a card asks a board tool to refuse a malformed argument before it does any external work. Valid arguments must
still behave as before. This example is hypothetical: it names no real card, executed test or achieved result.

The plan's claim is that the tool refuses invalid input before any external call and still accepts valid input. The
checks would observe the refusal message and exit status, that no external call happened, and a valid case. Passing
checks that never observe the external call would leave that part of acceptance unproved.

Suppose the reviewer finds that the refusal appears only after the external call. The message looks right, but the
change breaks acceptance. The repair moves the refusal before the call, strengthens the observation and verifies all
three behaviours again. The decision card then cites the checks that ran, not the ones the plan proposed.

### Push authorisation and delivery

At push authorisation the session judges the saved write-up and the card's marker. A direct local GitHub pick also
needs the owner's explicit pick and the still-held successful claim as [the eligibility procedure](../.agents/skills/resume/references/merge-on-evidence.md) says.
Where no wait reason holds and the
settings set `waitForOwner` to `on-screen` or `when-needed`, the work merges on its evidence. The owner then sees the decision card and its screenshots after the merge. Otherwise the card moves to Awaiting push with the reasons that held it. The owner then reads a decision card taken from the pull request body. A job a Herdr coordinator started, on either runtime, ignores `waitForOwner` and most wait reasons. Only a failed or missing required check, a missing screenshot and the `show-me-first` marker hold it. So an unmarked card merges with no question, repairs included. The owner's yes covers the whole delivery sequence, repairs and
rebases within its scope included. [`AGENTS.md`](../AGENTS.md#owner-gates) owns what that yes approves, under "Owner
gates", and [the merge-on-evidence reference](../.agents/skills/resume/references/merge-on-evidence.md) owns the wait
reasons.

The owner's answer to a waiting card reaches the session that acts only as a record. On most routes the record is a card comment. An `Owner answer:` comment names the version the owner saw, and a `Fix built:` comment names a fix built from it. The session in whose chat the owner answered, or the queue panel, writes the answer. The session that built a fix writes the fix line. A job a Herdr coordinator started reads no record as approval. The owner removes the `show-me-first` marker, himself or by telling the coordinator. The answer `I removed the marker` in its question menu only wakes the job. A fix
merges without a second look only where it adds no new reason to wait and the card is not marked `show-me-first`.
[The owner answer reference](../.agents/skills/resume/references/owner-answer.md) owns the records and who acts on
each.

On the pull request route, the session rebases onto `main`, pushes the branch and opens a draft. A `sign-off` change
settles the external review on the draft where that add-on is on. Marking the draft ready starts continuous integration
on the merge result. The session queues the merge as the platform's squashed auto-merge, which completes only once the required checks
pass. A Herdr job instead waits for the required checks on its head, then merges exactly that head with a pinned squash merge. That head is the one the write-up's `Reviewed commit:` line names.

A queued merge is not a merge. After queuing it, the session waits on one command, `scripts/merge-watch.mjs`. The command
waits on GitHub events through a short-lived forwarding webhook on the repository and one local stall deadline, with no
timed reads. It exits 0 only when the pull request has merged, and otherwise ends with its reason. A failed read is
neither a merge nor a failure of the code.

The direct route sends a qualifying change straight to `main`, with no pull request or hosted checks. Only
documentation and a setting-only seat change can qualify, and the repository's gate decides whether the whole change
does. A documentation file beside code never makes the code eligible. The gate judges every pushed commit, so a change
made and later undone within the push still counts.

The local hook runs the gate as it stands on the remote's `main`, so an edited gate cannot admit itself.
[The hooks manual](../.githooks/README.md#what-the-main-gate-may-rely-on) owns that boundary. The direct route still
needs local verification, the review and the owner's yes. Its commit message carries the approved body and the
receipts.

The direct route spares a qualifying change the pull request and hosted checks, while the local checks, review and
owner's yes still hold. [`AGENTS.md`](../AGENTS.md#publication-and-machinery) owns
both routes, under "Publication and machinery", and
[the delivery reference](../.agents/skills/resume/references/deliver.md) owns the sequence. Where the documentation
sweep runs, its own landing rule in `docs/DOC-SWEEP.md` and `docs/SWEEP-TRIAGE.md` lets it merge its own pull requests.

A merge on `main` in the canonical repository does not change any adopting repository. Each adopter keeps its copy
until it applies a release update, as [`AGENTS.md`](../AGENTS.md#shared-workflow-adoption) says under "Shared workflow
adoption".

### Closeout

Closeout starts from proof, not from a queued merge. On the pull request route that proof is the merged state and its
review record. On the direct route it is the fetched history and the pushed tree matching the receipts.

The same session then confirms the issue closed, moves the card to Done and advances local `main` only by a provably
safe fast-forward. It leaves a dirty, active or uncertain checkout untouched. One command,
`scripts/closeout-cleanup.mjs`, stops processes still running from the job's run folders and removes the job's containers, run folders, named scratch, worktree and branch where its checks pass.
It keeps every other target and reports why.

The session judges what is its own scratch, and stops a server only once it shows the server is its own. It reports a
hold that cleanup can wait out, such as an open terminal, in one line and leaves it for a later session. The session
asks the owner only about a file with no provable owner, unmerged work or a permission only the owner can grant.
Rulings the owner made during the job go to the issue or the document that owns the topic.

The session investigates a leftover from another job, or one it cannot prove it made, to a conclusion and reports the
outcome. [The `closeout` skill](../.agents/skills/closeout/SKILL.md) owns the steps, its
[Deferred cleanup](../.agents/skills/closeout/SKILL.md#deferred-cleanup) and its
[Leftover rule](../.agents/skills/closeout/SKILL.md#leftover-rule). The skill's
[Disposable job cleanup](../.agents/skills/closeout/SKILL.md#disposable-job-cleanup) section owns the authority to delete.

### Parking a job

Only the owner starts the `handoff` skill, which parks a job left unfinished at the end of a session. A bare
request to park authorizes local preparation only: committing what exists and drafting the pull request body.
Publishing the branch or a draft needs the separate authorization that skill names. The next session finds the job
through git and the handoff, and checks which receipts still hold on the current head.
[The `resume` skill](../.agents/skills/resume/SKILL.md) owns the route under "Parking".

### Runs without a pick

A pre-approved run takes cards without a pick for each one. It is on only where the settings file on the fetched
`main` sets `waitForOwner` to `on-screen` or `when-needed`. No guard holds the mode, except the git guard inside a run's own sessions. The run takes only cards in Ready, from the top of the column down. On GitHub Projects the top is the owner's board order. On other trackers, or where GitHub's listing leaves a Ready card out, the run goes by lowest card number and says so. A run starts nothing from Backlog, even when Ready holds no card it may build. A reorder while a card builds changes only which card comes next.

The run builds the cards in Ready and merges each on its evidence, with no yes at push.
This matters because a card's place in Ready approves automatic pickup. The owner holds a card back from pickup by leaving it out of Ready. After an explicit direct start, the owner holds delivery by marking the card `show-me-first`. Setting `waitForOwner` to `always` holds every card, and at `on-screen`, work on screen waits too. A job a wait reason holds waits in Awaiting push for the owner's yes. Wait reasons include a failure, an untested check, work beyond the card, a sign-off review and a change that is hard to undo. A Herdr job waits only on a failed or missing required check, a missing screenshot or the `show-me-first` marker. A run session merges it only
once the card records the owner's answer for that version. Work on screen merges with its screenshots attached to its
pull request.
[The merge-on-evidence reference](../.agents/skills/resume/references/merge-on-evidence.md) owns the level and the
wait reasons.

[The run reference](../.agents/skills/resume/references/runs.md) owns the run: the
[pre-approved run](../.agents/skills/resume/references/pre-approved-run.md) and the
[native Codex app route](../.agents/skills/resume/references/runs.md#native-codex-app-run).
[Two runtimes, one contract](AI-WORKFLOW-runtimes.md) explains what changes in native run chats, for phone
notifications and in a cloud build.

A session the pre-approved run starts with a fixed phase prompt reads two shared files: the
[card session steps](../.agents/skills/resume/references/card-session.md) and the
[phase rules](../.agents/skills/resume/references/pre-approved-phase.md). The table in the phase rules names any further
file for that prompt. A card session a run opens in the Claude desktop app's sidebar reads the
[sidebar rules](../.agents/skills/resume/references/pre-approved-sidebar.md) too. The run's coordinator reads every run
reference.

### Runs a Herdr coordinator starts

Herdr is a terminal app, and the Herdr add-on runs a repository's work in it. The add-on is off unless the settings
file holds `"herdr": true`. Where it is on, the Herdr coordinator takes startable Ready cards in board order with no
pick. The owner opens the coordinator from the repository root or from the queue panel, as
[the Herdr coordinator reference](../.agents/skills/resume/references/herdr-lead.md#coordinator) says. It runs in the
`Coordinator` tab, and each job it starts gets its own visible tab. The queue panel shows in Herdr what the owner's
agents wait on.

The coordinator keeps no board watcher or polling timer. With no startable card and no job running, it ends its turn.
The owner's message wakes it, as do its jobs' notes and the line `A card moved to Ready.`. The `board-move` and
`board-add` commands type that line after a move to Ready, but only into a coordinator ready to read it. A coordinator
that is not, such as one asking the owner, reads the board at its next wake. A move made on GitHub's own board page
types nothing, and the coordinator sees it at its next wake. Its alarm and its loss watch wake it too when they end.

Its jobs hold only for a failed or missing required check, a missing screenshot or the `show-me-first` marker. They
ignore `waitForOwner` and every other wait reason. The owner removing the marker, himself or by telling the
coordinator, is his only yes, and it clears only the marker's hold. A job delivers by a pull request merged at the exact reviewed
head with a pinned squash merge. For a change the repository's gate admits whole, it instead pushes a squash with the
same tree onto the fetched base.

The recorded reason is the card's place in Ready. [`AGENTS.md`](../AGENTS.md#owner-gates) says under "Owner gates"
that this place approves every action the card's outcome and acceptance criteria need. So a job merges with no owner
question unless its card carries the marker, as [the Herdr job reference](../.agents/skills/resume/references/herdr-job.md#the-merge-route)
says. No source records why the coordinator keeps no polling timer.

## Where the rules live

- [The `resume` skill](../.agents/skills/resume/SKILL.md): every step from intake to the queued merge, the review tiers
  and parking.
- [The pick table](../.agents/skills/resume/references/pick-table.md): the candidate table, its two forms and its
  closing line.
- [The delivery reference](../.agents/skills/resume/references/deliver.md): both delivery routes, receipt reuse and the
  merge watch.
- [The run reference](../.agents/skills/resume/references/runs.md): the pre-approved run.
- [The card session steps](../.agents/skills/resume/references/card-session.md) and
  [the phase rules](../.agents/skills/resume/references/pre-approved-phase.md): the rules a run's card and phase
  sessions read, and which further file each fixed phase prompt reads.
- [The Herdr coordinator reference](../.agents/skills/resume/references/herdr-lead.md) and [the Herdr job reference](../.agents/skills/resume/references/herdr-job.md): the coordinator's opens, wakes and recovery, and how its jobs deliver.
- [The `closeout` skill](../.agents/skills/closeout/SKILL.md): every step after the merge, deferred cleanup, the
  cleanup authority and the Leftover rule.
- [`AGENTS.md`](../AGENTS.md#owner-gates) under "Owner gates": what each owner decision approves.
- [`AGENTS.md`](../AGENTS.md#review-and-visual-verification) under "Review and visual verification": the selected tier's
  required reviews and the visual check.
- [`AGENTS.md`](../AGENTS.md#publication-and-machinery) under "Publication and machinery": the pull request route and
  the direct route.
- The Surfaces table in [`AGENTS.md`](../AGENTS.md) and the Conventions table in
  [`.agents/REPOSITORY.md`](../.agents/REPOSITORY.md): the repository's own gates, review answers, generated artifacts
  and visual verification.
- The head of `scripts/lib/unsafe-git.mjs`: the exact command forms the git guard refuses.

## Failure modes

When progress stops, a refusal and its remedy are different things. A script may stop an operation, but an instruction
says what the session investigates or does next. [Enforcement and instruction](AI-WORKFLOW-enforcement.md) separates
the two.

| Situation | What shows it | What happens next |
|---|---|---|
| Intake cannot be read | The board command's exit status names a failed or incomplete read | Selection stops and the session reports the read; a failed read is never an empty board |
| The session cannot confirm the card is free | Start checks are incomplete or disagree with intake | Nothing starts; an earlier pick never proves the card is still free |
| The session stops mid-build | The job branch holds a commit for every green slice | The stop loses at most the slice in progress; the next session resumes from the branch |
| The session stops while a plan awaits approval | The agents have built nothing; the branch, claim and plan stay on that machine | A later session there presents the plan and asks again; an earlier approval does not carry over |
| A check passes but misses part of the claim | The receipt is green, yet the check never observes that part | That part of acceptance stays unproved; a receipt cannot show that the session chose the right command |
| A review finding is true | The reviewer names a real defect or gap | A builder repairs it and the session verifies it, or the session takes it to the owner where judgment remains |
| Two repair rounds still raise true findings | The repair review still raises findings | The session runs one more round or brings the owner a decision |
| A reviewer is unreachable | A usage, sign-in or provider failure | The substitution route runs and the pull request body declares it; unavailable is never a clean review |
| `main` moves during delivery | The job's base and the remote history differ | The session rebases while draft, and receipt reuse decides which checks run again |
| A required check fails, or the pull request is blocked or closed | The merge watch ends with its reason | The session reports it and returns the pull request to draft before pushing a repair |
| The merge watch cannot read GitHub | The watch ends on a failed read | The watch confirms nothing either way, and a failed read is not a merge. An unconfirmed merge returns the session to [delivery](../.agents/skills/resume/references/deliver.md), and closeout does not start |
| Cleanup ownership is uncertain | Ownership, live use or unmerged work stays unsettled | Cleanup keeps the target, and the session investigates and reports it; uncertainty never authorizes deletion |
| An In progress card has no branch or pull request | Intake shows the card with its newest claim | It returns to Ready only on the owner's say |

Closeout does not lose the cleanup it kept after delivery. Where the board is GitHub issues, an issue comment records
each kept target for a later resume or closeout to reconsider. A Markdown card board relies on its ordinary publication
and the Leftover rule instead, with no added guarantee. Each later attempt needs fresh ownership and safety evidence.

The local hooks guard publication only when they run. Whoever holds GitHub's administrator bypass can still put a
commit on `main`, as [the `shared-files` skill](../.agents/skills/shared-files/SKILL.md#administrator-bypass) says. So no rule promises that every refused
publication is impossible.

Isolation has a cost too. Each job keeps its own state apart, but the session must track its claims, branches and
cleanup and retire them safely. No workflow document measures what isolation gains in speed or output. Equally, the
example journey on this page is not achieved work: only real receipts, settled reviews and an observed merge show a job
succeeded.

## Key files

- `.agents/skills/resume/SKILL.md` and `.agents/skills/closeout/SKILL.md`: the steps.
- `.agents/skills/resume/references/deliver.md` and `.agents/skills/resume/references/runs.md`: delivery and runs.
- `.agents/skills/resume/references/card-session.md` and `.agents/skills/resume/references/pre-approved-phase.md`: the
  rules a run's sessions read, the second naming any further file for each phase prompt.
- `.github/pull_request_template.md`: the pull request body the decision card comes from.
- `scripts/run-log.mjs`: the logger every check runs through.
- `scripts/merge-watch.mjs`: the one waiting command after the session queues the merge.
- `scripts/closeout-cleanup.mjs`: the one cleanup command after the merge.
- `scripts/gates/pre-push-main`: the repository's own gate for the direct route, where it supplies one.
- The external review add-on's skill and reviewer configuration, where
  [the add-on](AI-WORKFLOW.md#the-external-review-add-on) is on.

## Where to go next

- [The seats](AI-WORKFLOW-seats.md) shows who acts at each stage, and how work passes between them.
- [The evidence bar](AI-WORKFLOW-evidence.md) explains what a check proves and what a receipt shows.
- [The board](AI-WORKFLOW-board.md) explains the columns a card moves through.
