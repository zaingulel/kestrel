---
name: resume
description: Resume work in this repository from durable state. Use when the owner starts or continues a work session, returns to unfinished work, asks what to work on next, or asks to see what is waiting.
effort: medium
---

# Resume

Git is the state. A branch is a job; a draft pull request is its handoff; the board says what is planned.

Where `scripts/lib/board-config.mjs` exports `TRACKER = "markdown"`, cards are files, and `docs/MARKDOWN-CARDS.md` says
what each card step here becomes. Where it exports `TRACKER = "linear"`, cards are issues in a Linear team, and
`docs/LINEAR-CARDS.md` says what each card step here becomes. Where it exports `TRACKER = "jira"`, read
`docs/JIRA-CARDS.md` before any card action and apply its Jira substitutions throughout this skill. Where it exports
`TRACKER = "azure"`, read `docs/AZURE-CARDS.md` before any card action and apply its Azure substitutions
throughout this skill, including complete native-comment review before claiming.

## Before intake

**Run triggers.** A session reads [references/runs.md](references/runs.md) whole, and the part for its run's kind, [references/product-manager-run.md](references/product-manager-run.md) or [references/pre-approved-run.md](references/pre-approved-run.md), which the message or the session's start message names, as **Reference files** says, before it acts on any of these messages, and, where the message is its first, once the target is recorded and before the intake reads: the owner's instruction `Start a product manager run.` or `Start a pre-approved run.`; a first message that is exactly `Continue the product manager run.`, or begins `End the product manager run: ` or `End the pre-approved run: `; a message beginning `Fabraik run update: `; a message beginning `Your coordinator carries the answer the owner gave for your card, word for word.`, the owner's answer carried to this card session; or a first message that is one of these fixed phase prompts, each followed by a newline and its JSON context:

- Continue this exact pre-approved Codex job.
- Select and claim one eligible pre-approved job. Do not plan, build, or deliver.
- Prepare this exact pre-approved job. Do not build or deliver.
- Build and verify this exact prepared job. Do not publish or deliver.
- Deliver this exact built job. Do not select or build another job.
- Continue this exact answered pre-approved job.

A session whose first message asks it to build a card in the cloud reads
[references/cloud-build.md](references/cloud-build.md) whole before any other action, this check included, as "Cloud
build" below says.

A Codex session reads [references/codex.md](references/codex.md) whole before any other action, this check included: it holds this skill's Codex-only forms under the headings of the steps they belong to.

Check that this runtime is running the repository's hooks: one it has not loaded or trusted does nothing,
and no notice from the runtime can be relied on to reach the owner. Run `git commit --no-verify --dry-run` as one
command on its own; it commits nothing. Issue it in the same turn as the fetch and the local inventory below;
every write, the local `main` update included, waits for its result. If its refusal cancels those calls, issue
them again. The git guard is running only when the result is the guard's own refusal, carrying the words
`Blocked: git commit`; then say nothing about hooks and continue. Any other result,
whether git's output, a permission prompt or a refusal in other words, means it is not running. Read [references/exceptions.md](references/exceptions.md) whole before anything else. A refusal shows the git guard
alone, because Codex trusts each hook separately: never report the handoff check or the turn-end check as
verified.

A Claude Code session whose `printenv CLAUDE_CODE_REMOTE` prints `true` is a cloud session: once this check is done it
continues at "Cloud build" below, not with the fetch, intake or work-pick.

Fetch `origin/main` with `git fetch --no-prune origin main` and record the fetched commit as the target; in the
same turn read the local inventory with `git status`, `git branch --show-current` and
`git worktree list --porcelain`. If fetching fails, report freshness unavailable and do not select work from
stale board evidence. Load `AGENTS.md`, this skill, and
[Update local main](../closeout/references/update-local-main.md) from the target under the Instruction reuse rule
below, then apply that fetched procedure to the actual `main` checkout. Its step 5 owns the verifier checkout:
which checkout it is, the proof that it is clean at the target, the report when `main` is kept as it is, and the
removal of a verifier-only worktree this run created. With no verifier checkout, report board freshness
unavailable rather than presenting stale local code as current evidence.

**Complete reads.** Apply this to required instructions and intake evidence. Capture large responses and
responses of unknown size in this session's scratch directory, retaining exit status and stderr. Read all
required content in bounded, nonoverlapping sections through its known end. Budget both each result and the
combined output returned by a tool call: issue independent sections together only when both fit, using
further batches otherwise. Keep track of sections completely received in active context. Recover missing or
truncated sections from the same capture or exact fetched revision, retaining complete sections instead of
rereading them or refetching unchanged evidence. If neither is available for a truncated response, capture a
fresh read of only that response. Replace its earlier evidence and apply the owning procedure's conflict and
refresh rules. Until coverage is complete, unread content is unavailable evidence; scratch is never a cache.

Reuse complete evidence already read in this session while it remains in active context and its provenance
and validity satisfy the owning procedure. Obtain missing fields, including source-author evidence absent
from board comments. Instruction reuse below and every explicitly required refresh or recheck still apply.

**Instruction reuse.** Record the target and the required instruction paths. Reuse previously read text only
when its full content remains in active context and its exact read Git revision is known: one command,
`git rev-parse <read-revision>:<path> <target>:<path>` with a pair for every such path, must succeed, and a path
is reused only when its pair of blob IDs is identical. Otherwise read the required content from the target with
`git show <target>:<path>`. Missing objects, failed commands, or failed or truncated content reads are
unavailable evidence, never permission to reuse. Autoloaded text without verified read provenance, summaries and
dirty disk content establish no identity. Retain provenance only in this session, with no cache or tracked
state; apply the rule whenever the target changes, including the post-selection fetch. Instruction identity does
not waive verifier target, cleanliness or ownership checks.

**Reference files.** Loading this skill loads this file. Each file in its `references/` folder becomes a required
instruction path when a pointer here to it fires: read it whole with
`git show <target>:.agents/skills/resume/references/<name>.md` before the action the pointer names, or reuse an earlier
read only where the rule above proves it identical. A pointer that fires before a target is recorded, as a cloud
session's first pointer does, reads the file with `git show HEAD:<path>` and records `HEAD` as its read revision, so the
rule above settles it once the target is recorded.

## 1. Find where things stand

Once the verifier checkout is settled, issue the intake reads from it together, as parallel or background calls: the
board intake, `gh pr list --author @me --state open --json number,title,headRefName,isDraft,url`, and the sweep list
when it applies. Collect every exit status and stderr, and finish the reads before reconciliation writes. The board
intake is one command, its card files written to a folder in this session's own scratch directory and its stdout
redirected to a literal path there:

```sh
node scripts/board.mjs --intake <scratch>/intake > <scratch>/board-intake.txt
```

- The document is a summary: the pick listing and, for every pickable card and every claimed card with no closing pull
  request, its column, Workstream, parent, open blockers, assignees, latest `Claim:`, whether it is a suggested card,
  its `Needs owner:` comments, its What to build section and the path and line count of the file holding its full body
  and comments; stderr holds the drift scan, the details outcome and the document's line count. Read the document whole
  under Complete reads above, using that line count. Read a card's file only once that card is picked, whole, using the
  line count its `card text:` line gives; never read every card's file.
- Exit 0 is a complete read with no drift; 2 is a failed board read, so board freshness is unavailable and no
  work is selected; 3 is drift, reconciliation to do before work-pick; 4 is an incomplete read; 5 is 3 and 4
  together. A card that stderr or the document marks `UNAVAILABLE` is reported at work-pick and never presented
  as startable.
- When every read has returned, recheck the verifier checkout with `git rev-parse HEAD` and
  `git status --porcelain`, in the same turn as the document's final batch of sections. Unless they show the
  target and no change, checkout-derived evidence is invalid and step 5 of Update local main is applied again
  before another verifier command. GitHub reads are observations at their recorded times, not an atomic
  snapshot: conflicting facts or reconciliation writes require refreshing only the affected evidence before
  decisions.
- During intake, from the root checkout, inspect another job's worktree with `git -C <path>`, never by `cd`. On
  Claude Code, `EnterWorktree` records the shell's current folder as the one `ExitWorktree` later returns to, and
  a sibling job's closeout may remove that folder, leaving this session unable to leave its own worktree.
- A branch with an open draft pull request is unfinished work. Use the summaries to identify relevant unfinished
  jobs, then read only their bodies: the "Not done" section says where to pick up. For each draft, read its card's
  newest claim with the card read of "3. Start the job", since the intake omits it once a closing pull request exists;
  a draft whose newest claim names `Claude Code cloud` is taken up only as step 5 of "Cloud build" says.
- Planned work comes from the document. Prefer `Ready` work matching the owner's latest objective;
  `Backlog` remains eligible. `Ready` means startable in the next session with no missing owner decision,
  external dependency, or scheduled date; a card waiting on any of those goes to `Backlog` with its trigger
  named in a comment. A card in `In progress` with no branch or pull request behind it may be another machine's or
  session's job, since a job branch stays local until push: never return it to `Ready` on the session's own
  judgment and never offer it as a candidate row. Show it to the owner at work-pick with the claim the document
  gives for it, whether a comment, none or `UNAVAILABLE`, and return it to `Ready` only on the owner's say. A card
  whose newest claim names `Claude Code cloud` is held for a cloud build: work-pick offers its delivery first, as step 4
  of "Cloud build" says, and before any return to `Ready` it is released as "Releasing a cloud claim" in that section
  says.
- A card is held for the owner while any of its comments begins `Needs owner:`, and a card whose title begins `Proposed: ` is a suggested card held for the owner; neither is ever a candidate row. Where the intake shows either, read [references/held-cards.md](references/held-cards.md) whole before the table is shown, and before answering, returning or taking up such a card. A card whose `Returned:`
  comment names a `Job:` is not startable here with that machine as the reason, and is taken up only on that machine
  as the parked-job paragraph at the end of this skill says. Where a picked card's file shows a `Returned:` comment, read [references/held-cards.md](references/held-cards.md) whole before any further step.
- If the Conventions table in `.agents/REPOSITORY.md` marks the documentation routines active and the repository's
  settings file, `.agents/factory-settings.json`, does not hold `"docSweep": false`, intake sweep-triage tasks and
  findings source reports as `docs/SWEEP-TRIAGE.md` describes. Where that file is absent, holds no such key or holds
  `true`, the table alone decides. Where it applies, read [references/sweep-intake.md](references/sweep-intake.md) whole
  before issuing the intake reads.

After the current verifier and all intake reads are settled, reconsider pending cleanup under
[closeout's Deferred cleanup](../closeout/SKILL.md#deferred-cleanup) before work-pick. Reuse the fetched inventory
and investigate discovered targets under that procedure without changing work selection or claims.

## 2. Work-pick (owner gate one)

Keep every worthwhile Ready or Backlog recommendation, with no arbitrary shortlist. The intake document is the evidence
for every row; after selection the picked card's file, read whole as section 1 says, serves planning unless changed
evidence invalidates it; never issue one `gh issue view` per card.

A card held for a cloud build, which step 1 finds by a newest claim naming `Claude Code cloud`, comes first: its one
line stands above the table, as step 4 of "Cloud build" says, and the closing recommendation names it ahead of any row.

State the session's own model in one line, then always present this table, even for one candidate:

| # | Card | Outcome for the user | Why now, and the risk | Gates it triggers | Route and why | Startable now? |
|---|---|---|---|---|---|---|

`Card` is the issue number and its title as written, whatever its length. Write every other cell as a phrase,
not a sentence, aiming for twelve words or fewer and never dropping a fact the decision needs:
`Outcome for the user` adds what the title does not say, and `Startable now?` is yes, or no with the reason.

An open epic parent is never a candidate row; its next unblocked child is, and a child with an open blocker
is not offered. Gates are read off AGENTS.md, Owner gates and Review: owner direction, sign-off, architect plan,
screenshot, security review, the external review where the repository has turned that add-on on, and any further gate
the Surfaces table in `AGENTS.md` names. Route names the build seat (`builder-max`, `builder`, or `builder-lite`),
whether the architect runs, and the reason from residual judgment, uncertainty, failure consequence, and verification
strength. Close with one line recommending a row number, then stop; no acceptance-criteria list is presented. The
owner's pick of any row is the work-pick approval of that card's
outcome and acceptance criteria as written, and it starts the job with no further confirmation unless the checks
in "3. Start the job" do not confirm the card is free; planning proceeds autonomously after it. One issue per
branch. Two issues may run in parallel only when their files are disjoint.

**Advance approval.** Read [references/advance-approval.md](references/advance-approval.md) whole before the table is shown, and before answering any owner question about posting, checking or withdrawing an `Approved:` record.

**Product manager run.** Its rules are in [references/product-manager-run.md](references/product-manager-run.md), read as **Run triggers** under "Before intake" says.

**Pre-approved run.** Its rules are in [references/pre-approved-run.md](references/pre-approved-run.md), read as **Run triggers** under "Before intake" says.

## 3. Start the job

- After selection, fetch `origin/main` again with `git fetch --no-prune origin main` and record the new target;
  load its required instructions under the Instruction reuse rule in "Before intake" before proceeding.
- Then, from the root checkout and before a worktree or branch is created, confirm the picked card is still free and
  claim it. On the GitHub Projects tracker one command does both, `<issue>` typed as a literal:

  ```sh
  node scripts/board-claim.mjs <issue> --intake <scratch>/board-intake.txt --runtime "<Claude Code|Codex|Claude Code cloud>"
  ```

  The intake is the capture "1. Find where things stand" wrote; a session that has itself changed the card since intake
  first refreshes it, as that step requires after a reconciliation write. The runtime is `Claude Code cloud` for a card
  started for a cloud build as "Cloud build" says. Record the address on the `wrote:` line of the claim, because that
  address is how the session knows its own claim.
  - **Exit 0**, Free and the session's own claim is first: it holds the card. Continue.
  - **Exit 2, 3, 4 or 5**, Could not confirm before any write, Not free, another claim first, or Could not confirm
    after the writing began: read [references/exceptions.md](references/exceptions.md) whole before any further step.
    After exit 4 or 5 the command is never run again, because a second run posts a second claim.
  - **Exit 1**, the call refused with nothing read. On another tracker, which the refusal names, read
    [references/claim-reads.md](references/claim-reads.md) whole and claim by hand there instead: its free check comes
    here, before the worktree, and its claim after the HEAD check below. Otherwise correct the call and run it again.
- The card read and the board read that other steps name are in [references/claim-reads.md](references/claim-reads.md):
  read it whole before any step that names either.
- On Claude Code, the coordinating session is started at the root checkout, never with the desktop app's worktree
  option: auto-archive removes that worktree at merge, before closeout can leave it. Any desktop app session the
  workflow itself starts, a job session a coordinator starts or a probe or helper session, likewise has the repository
  root as its folder and enters its job worktree itself, because the app asks the owner to
  trust each new folder a session starts in and that trust does not carry down from the root.
  Confirm with `pwd` that the shell is in the root checkout, because `EnterWorktree` records the shell's current folder as the one
  `ExitWorktree` returns to; immediately after, run
  `git worktree add .claude/worktrees/job-<issue> -b job/<issue> <recorded-origin-main>` and enter it with
  `EnterWorktree`. `.claude/worktrees/` is the one location a session may enter without the owner approving the move:
  Claude Code asks whenever a session takes its working directory to a path outside the repository's
  `.claude/worktrees/`. `EnterWorktree` isolates the session, so the runtime refuses a command it cannot verify
  stays inside this worktree; the one-plain-command line in `CLAUDE.md` gives the form that passes. Where the check
  refuses a command only because a file path in it holds the letters `git`, the file is never renamed or left out
  of a run, and the command is rerun in the form the repository's `docs/TESTING-STRATEGY.md` names for a focused
  run in a job worktree.
- On Codex, [references/codex.md](references/codex.md) gives where the job worktree lives and how each command reaches it.
- Before edits in any newly created runtime worktree, require `git rev-parse HEAD` to equal that newly recorded
  commit. Preserve and report a mismatch before edits.
- After entering the verified job worktree or the worktree created for a parallel slice, read its project files and
  run its commands there, including read-only checks and packaging. Give file tools that worktree path when their
  default folder differs.
  Use the fetched commit or its selected verifier where a step requires current `main`. Follow the named runtime
  setup, guard and closeout steps in their own checkout contexts.
- Every file a job writes outside its commits, scratch, plan, handoff, result and review files alike, goes in the job
  worktree's ignored .claude/worklog/ folder, never outside it. Retain artifacts needed for unfinished work or
  handoff. Apply routine scratch cleanup through [closeout step 5](../closeout/SKILL.md) under closeout's
  [Disposable job cleanup](../closeout/SKILL.md#disposable-job-cleanup) authority.
- Builders work inside the job worktree, one at a time. Two slices with disjoint files may run at once: from the
  job worktree, give the second its own branch and worktree with
  `git worktree add -b slice/<issue>-<name> <path> job/<issue>`, since git refuses to check the job branch out in a
  second worktree. Once that slice is green and committed there, run `git merge --no-edit slice/<issue>-<name>` in
  the job worktree, then `git worktree remove <path>` and `git branch -d slice/<issue>-<name>`. A runtime's own
  subagent worktree branches from `main`, not the job branch, so it is not used for builders.
- Run `npm ci` in the fresh job worktree, then confirm `git config --get core.hooksPath` prints `.githooks`; when it
  does not, run `git config core.hooksPath .githooks` and report it.

## 4. Plan

- Plan-first surfaces are the Surfaces table's `plan-first` row. They get an `architect` plan and one read-only
  plan review before any build. Any other card with design choices still open after work-pick gets an
  `architect` plan. Everything else gets a short plan in the pull request body.
- The plan review is dispatched only after reading [references/review-and-push.md](references/review-and-push.md) whole.
- Every plan follows `docs/CODING-STANDARDS.md`, the session's own short plan for a card without an architect
  included. Clerical corrections follow **Clerical corrections** under "5. Build".
- Where the project has a user interface, a plan with a user-facing change, the session's own short plan included, reads
  `docs/DESIGN-SYSTEM.md` first: it owns the tokens and component patterns the plan builds to.
- **Visual direction.** A plan for a change to how the interface looks, the architect's or the session's own short plan,
  is written only after reading [references/visual.md](references/visual.md) whole.
- Every plan, the architect's and the session's own short plan alike, first considers doing less or a native feature,
  then weighs a mechanism's recurring run time and upkeep against the failure it prevents, states that cost for any
  new or extended test or tooling, and names existing machinery the change makes unnecessary. The build-seat choice
  keeps its own rule: cost and latency break only equal-reliability ties. Use `builder` for bounded substantive
  implementation, `builder-max` from the outset when uncertainty or failure consequence warrants deeper reasoning, and
  `builder-lite` only for mechanical edits with strong verification and no remaining judgment.
- An `architect` dispatch carries completed findings or, on Claude Code, a bounded unresolved lookup that its
  charter permits it to send only to `explorer`; the architect waits for completed findings before planning.
  Each explorer writes completed findings with
  `file:line` references and explicit unresolved gaps to its own distinct named findings file, such as
  `.claude/worklog/<branch>-discovery-<name>.md`. The handoff's `Discovery:` line carries every findings file path
  or, for the Claude lookup branch, the bounded question and its named findings-file destination. The session's
  own findings use the same references and gaps. An unbounded list of places to search is insufficient. On an
  unplanned return, the coordinating session completes the missing discovery under this rule or names the missing
  plan file, then redispatches the architect; that return is not a capped architect.
- Every `architect` dispatch is a filled copy of `.agents/templates/planner-handoff.md` whose `Deliverable:` line
  names the plan file, `.claude/worklog/<branch>-plan.md`.
- **Capped seats.** An `architect`, `oracle` or `security-reviewer` reply that does not end with its finish line, `plan delivered in full`, `brief delivered in full` or `security review delivered in full`, is capped: read [references/exceptions.md](references/exceptions.md) whole before acting on it.
- Every `oracle` dispatch names its result file, `.claude/worklog/<branch>-oracle-<name>.md`, and carries an
  `explorer`'s completed findings, with each findings-file path as above. On Claude Code it may instead carry a
  bounded unresolved lookup and named findings-file destination: the oracle sends only that lookup to `explorer`
  and waits for completed findings before reasoning. Every `security-reviewer` dispatch names its result file,
  `.claude/worklog/<branch>-security-review.md`. For missing locations, its Claude charter permits only bounded
  `explorer` discovery, completed before its own trust judgment.
- A plan names its scope: the files each slice changes and the claim each slice proves, never a line estimate.
  Size is the owner's judgment before work-pick, through the `to-issues` size signals; after work-pick no seat
  splits, stops or replans work for its estimated or actual size. An architect's finding that the card holds more
  than one independently demonstrable outcome goes to the owner as a split proposal before any build, and the
  session never narrows such a plan inline or merges slices to fit. A product manager run settles a proposal only as its step 11 in [references/product-manager-run.md](references/product-manager-run.md) says. A card that came out of a split is never split
  again on a session's own judgment; only the owner starts another split. A parser, state machine, or general
  framework the outcome did not name is a scope change and goes back to the owner before it is built.
- Before implementation, every coherent claim has a fixed observer, independently grounded expectations and a
  construction mode selected under the local `docs/TESTING-STRATEGY.md`. Resolve any absent runnable baseline or
  unavailable observation through that authority's named alternative or stop; a model choice changes no admission.
  Carry the acceptance examples, selected evidence and construction stage in the existing builder handoff fields.
  Every plan, including the session's short plan, statically verifies its prescribed recipe by reading the test
  source, runner selection options and fixture prerequisites, without executing tests. The architect retains its
  existing live-path and fixture-affordance checklist. Carry verified commands and their source revision,
  fixture/configuration and runtime context in existing handoff fields. Changed tests, fixtures, configuration or
  runtime invalidate affected facts; label unknowns explicitly. The testing strategy owns exact selection and
  actual-result validation at the first required execution. Static validity is not execution evidence; Receipt
  reuse alone governs passing receipts.
- **Machinery rule.** Read [references/machinery.md](references/machinery.md) whole before a plan that adds to, changes or removes the workflow's scripts, tools, hooks or tests, or rewrites a testing strategy, a coding standard or the workflow text of `AGENTS.md`, and before a workflow-health assessment the owner asks for.
- **Plan approval (optional owner gate).** `AGENTS.md` owns what this gate is and what turns it on, under "Owner
  gates"; these are its steps, taken once the plan is complete and every finding of any plan review is settled.
  - **Read the setting on the fetched `main`,** never from the files of the job, so a job cannot switch its own
    gate off. `git ls-tree --full-tree --name-only origin/main -- .agents/factory-settings.json` prints the path
    where the repository has a settings file, whatever folder it is run from, and
    `git show origin/main:.agents/factory-settings.json` then prints that file. The gate is off where the first
    command exits 0 and prints nothing, or where the file is one JSON object that holds no `planApproval` key or
    holds `false`: go on to "5. Build" with no owner step. It is on where the file holds `"planApproval": true`. A
    command that fails, a file that is not one JSON object, any other value, or a key spelt nearly like it leaves
    the gate unknown, which is never off: build nothing and tell the owner what the commands printed.
  - **Its other steps,** where the gate is on, are in [references/plan-approval.md](references/plan-approval.md): read
    it whole before presenting the plan, and in a resumed session before anything further is built.

## 5. Build

- Every edit goes to `builder-lite`, `builder`, or `builder-max` through `.agents/templates/builder-handoff.md`; the
  session never builds (AGENTS.md, Runtime notes). Builders never run the full suite, never commit.
- Where the repository has turned plan approval on, no builder is dispatched before the owner's yes to the plan in
  this session; "4. Plan" owns the steps under **Plan approval**.
- **Strict construction and clerical corrections.** Read
  [references/strict-construction.md](references/strict-construction.md) whole before the first handoff of any
  `strict-tdd` claim or of a review repair to one, and before authorizing any clerical correction.
- Commit on the job branch after every green slice. Uncommitted files survive a crash but not a stray checkout,
  and the next session reads the branch, not the worktree, to see what was already green. A local commit needs
  no authorisation; only the push does. Commit green work before any stop, handoff, replan or split proposal as
  well, so nothing green waits uncommitted in the worktree.
- Wrap every executed check in `node scripts/run-log.mjs <label words> -- <command>` (plain unquoted label,
  then a bare `--`) so the exit code is recorded by a script, not asserted: focused tests, the discrimination
  evidence `docs/TESTING-STRATEGY.md` selects, lint,
  and the convergence checks `docs/TESTING-STRATEGY.md` names. The log lives at `.claude/worklog/<branch>.md`.
  On every agent-initiated rerun, supply a nonblank diagnosed reason through `RUN_LOG_RERUN_REASON`; for example,
  `RUN_LOG_RERUN_REASON='Changed the failing assertion' node scripts/run-log.mjs focused -- npm run lint`.
- When two repair-and-re-review cycles still produce true findings, new or repeated, judge them. If each is bounded
  and verifiable, run one more round that fixes all of them. Bring the owner the choice, with a recommendation, only
  when a finding needs an unsettled design, owner judgment or evidence that cannot be bounded, or when that round
  still does not converge. Findings are never ignored.
- Regenerate any artifact the Conventions table's `generated artifacts` row names and commit it with its source;
  the Stop and pre-commit hooks enforce it.
- **Waiting.** Use the native awaited operation bounded by higher-priority instructions, tool limits and the next
  communication/observation deadline, with headroom for the update. Interruptibility alone waives no deadline. Use a
  long interruptible helper wait only where active requirements permit it. Retain one owned command/cell and resume
  its identifier; inspect output and terminal status before awaiting again. Never substitute manual sleep/status-check
  loops or repeated short checks of unchanged state for native awaits; bounded native awaits at communication/observation
  deadlines remain the procedure. Internal process polling inside one awaited cell is not repeated model polling. An
  all-results barrier must not hide failure, completion or owner/helper interruption. Where no shorter active deadline
  applies, use the longest supported interruptible interval. Where behavior is unknown, use a documented supported
  bounded wait. Every session the coordinator starts, or takes over from the owner, is launched or taken over as a
  native awaited operation or as a named session whose completion wakes the coordinator, which carries the owner's
  questions and answers to and from it by message, the receiver acting on one only when the sender shown is the session
  that started it (no hook sees a message, so this rests on the receiver); a push yes reaches a job only by the carry
  that **Carried answers** in [references/runs.md](references/runs.md) gives, never by message, an owner gate's yes
  still counting only where `AGENTS.md` says; a terminal tab is only for the owner to watch.
  - On Codex, use the forms in [references/codex.md](references/codex.md).
  - On Claude Code, use `Bash` with `run_in_background: true` and its completion notification, while meeting active
    communication obligations.

## 6. Verify and review

Read [references/review-and-push.md](references/review-and-push.md) whole before the first review dispatch of the job, the plan review of "4. Plan" included. It holds this section and "7. Push authorisation".

## 7. Push authorisation (owner gate two)

Read [references/review-and-push.md](references/review-and-push.md) whole, as "6. Verify and review" says, before this section's first step.

**Batch review.** Its steps are in [references/batch-review.md](references/batch-review.md), and the Saved write-up and presentation rules its steps use are in [references/review-and-push.md](references/review-and-push.md): read both whole before applying any step of it, whether the owner's message asks to see what is waiting or a run's step names it.

## 8. Deliver

**Read [references/deliver.md](references/deliver.md) whole before any step of this section,** and wherever this skill
reaches into it from elsewhere: before the direct-route eligibility check, a cloud draft's included; before settling any
convergence check under its **Receipt reuse** rule; and before any push.

## Cloud build

A cloud session reads [references/cloud-build.md](references/cloud-build.md) whole before any other action, the check of
"Before intake" included, and holds to it: that text is the only bound on what a cloud session does on GitHub. A local
session reads it whole before it starts a card for a cloud build, before it presents, takes up or delivers a card or
draft whose newest claim names `Claude Code cloud`, and before it moves such a card to `Ready` or `Backlog`.

## Parking

Read [references/exceptions.md](references/exceptions.md) whole before parking a job, and [references/held-cards.md](references/held-cards.md) whole before taking up a parked one.
