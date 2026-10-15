# Kestrel

Repository contract: the factory region carries the shared workflow; the sections below define Kestrel's local product boundary, constraints and seams. The local repository profile lives in [.agents/REPOSITORY.md](.agents/REPOSITORY.md).

<!-- factory-shared:start -->

The always-loaded contract for every agent runtime: skills own the steps, hooks own what must never happen, git owns all
state. This file holds in full only the rules every session needs; every other rule has one home, which the index under
"Sources of truth" names. A rule a test or hook enforces is named here, not restated.

## Runtime notes

A repository runs Claude Code, Codex or both. Its settings file names which under `runtimes`, as the `sync-job` skill
says, and a repository that names none runs both. Only the named runtimes' seats, hooks, skill copies and contract file
are installed, so a sentence here, in a skill or in a charter about a runtime the repository does not run applies to
nothing in it.

Claude Code reads this file through `CLAUDE.md`, which adds its own notes; Codex reads it directly and prompts before a
browser run where the repository supplies `.codex/rules/playwright.rules`. Skills are shared in `.agents/skills/`, and
`.claude/skills/` holds a byte-identical copy of each; the agent seats in `.claude/agents/` and `.codex/agents/` carry
the same charters. The skills vendored from upstream repositories, each repository's kept with its licence in its
own folder under `.agents/upstream/`, are verbatim copies: they are never edited in place, an update replaces the
vendored source and every copy of it whole, and Codex invokes any skill as `$<name>`. The root checkout is the
integration checkout: it stays on `main`, and nothing is edited, branched, or committed there; the git guard refuses the
branching and committing half. Resume fetches before intake and loads the fetched `AGENTS.md` and the `resume` and
`closeout` instructions from the fetched commit: text read earlier is reused only where the Instruction reuse rule in
the `resume` skill, under "Before intake", proves it identical, and anything unproven is read again. It then advances
local `main` as [Update local main](.agents/skills/closeout/SKILL.md#update-local-main) in the `closeout` skill says.
Each job gets one worktree and all of the job's work happens inside it, never a worktree inside another job worktree;
the `resume` skill says where it lives and how the session enters it on each runtime.

When using the bundled PostgreSQL examples, apply these caveats. In `security-rls-performance`, the policy's calling role
needs `EXECUTE` on `private.is_team_member(bigint)` after the revocations: grant it only to intended policy callers,
such as `authenticated` when that is the policy's intended role. Keep the non-exposed schema, identity check and
restricted search path; retain revocations for `PUBLIC` and roles that do not need the helper, including unrelated
anonymous or service roles. [`SECURITY DEFINER`](https://www.postgresql.org/docs/16/sql-createfunction.html) changes
execution privileges, not permission to call. In `schema-constraints`, scope both the check-constraint and foreign-key
existence queries by `conname` and `conrelid`: schema-qualify the target table in `ALTER TABLE` and resolve that same
name through `regclass`. [Constraint names alone are not unique](https://www.postgresql.org/docs/17/catalog-pg-constraint.html).

In `conn-prepared-statements`, `DEALLOCATE` does not keep separately executed statements on one server connection.
Use session pooling or a direct connection for the SQL `PREPARE`/`EXECUTE`/`DEALLOCATE` sequence; do not treat it as a
transaction-pooling fix. [PgBouncer does not support this SQL sequence in transaction pooling](https://www.pgbouncer.org/features.html).
In `lock-deadlock-prevention`, retain ordered `SELECT ... ORDER BY id FOR UPDATE` inside the transaction before the
single `UPDATE`; one statement does not atomically acquire every row lock. All competing transactions must follow the
[same lock order](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-DEADLOCKS).

The session that talks to the owner coordinates: it plans the cards that need no architect, hands every edit to a
builder seat, settles reviews, and delivers; it never builds. Residual judgment that would make a handoff
unreliable is resolved in the plan or the slice is split smaller. In every session, job or not, discovery wider
than a couple of files goes to the `explorer` seat, so its conclusion reaches the main thread and its file dumps do
not. The costliest Claude model, Fable, is reached only through the `oracle` and `security-reviewer` seats, and the
costliest Codex model, Astra, only through the
`architect`, `oracle` and `security-reviewer` seats; the session and the builders run below that tier, each
builder at the model its seat file sets. Every subagent is one of the named seats above, dispatched by its seat
name; a generic, default or unnamed role is never dispatched.

A session waiting on a helper, or on a command that runs for minutes, uses its runtime's one long wait and never sleeps
and checks in a loop; the `resume` skill gives each runtime's exact form under "5. Build".

## Codex model routing

For this project, `.codex/agents/*.toml` owns model and reasoning settings and supersedes machine-wide model routing
defaults. Read the selected role's settings and pass them explicitly when dispatching. `explorer` locates code;
interpretation belongs to the planning or review roles. The `oracle` is the escalation seat and defaults to its
configured effort; override to `max` only for a specifically justified escalation, stating the unresolved reasoning
problem in the dispatch. Every other seat, on either runtime, is dispatched at its configured model and effort, never
overridden. Keep task-specific routing choices out of the tracker.

## Sources of truth

Planned work: the board card and its acceptance criteria (`node scripts/board.mjs`). Shipped work: `git log` and passing
checks, never a prose status claim. In-flight work: a branch and its draft pull request. Durable constraints: this file,
the scoped rules, and the standards and record documents indexed in [docs/README.md](docs/README.md). History: git, so
an operating document is a current manual: no dates, backstory, stale counts or superseded status, and rationale only
where it changes what the reader does. Explanation: [docs/AI-WORKFLOW.md](docs/AI-WORKFLOW.md) is the front page of the workflow pages, whose routing table
links one page per topic; every topic page carries a summary, a mental model, how it works, where the rules live,
failure modes and key files, and none of them owns a rule.

Start every owner-facing decision in plain language before any workflow vocabulary: what happened, what the owner
must decide, the options. The owner reads pull request descriptions and screenshots, not diffs; write for that
reader. `resume` starts or continues a session, `handoff` parks unfinished work, `closeout` follows a merge.
Report outcomes as they are: show the failing output, name any step skipped and anything guessed, never invent a
number, and call work done only once it is verified; a value that cannot be computed fails loudly with its cause,
never as a blank or zero that reads as real.

Every rule this file does not hold in full has one home:

| Topic | Home |
|---|---|
| What is true of this repository alone: its product, where its own facts live, its grounding authorities and its Conventions table | `.agents/REPOSITORY.md` |
| Reusing instruction text already read | The [`resume`](.agents/skills/resume/SKILL.md) skill, "Before intake" |
| Which builder seat a slice goes to; the machinery admissions, the friction route and how machinery leaves; what a plan carries for a change to how the interface looks, and who decides where the `frontend-design` skill and the design system disagree; and the steps of plan approval where a repository has turned it on: how the setting is read, how the plan is presented and revised, and what a resumed session does | [`resume`](.agents/skills/resume/SKILL.md), "4. Plan" |
| Each runtime's exact form for waiting on a helper or a long command | [`resume`](.agents/skills/resume/SKILL.md), "5. Build" |
| The two questions that choose a review tier, the three tiers, the guard rule, what a setting-only seat change is, the cross-family route, the authorization it runs on, its single-family form in a repository that runs one runtime, and its substitution when the other family's seat cannot be reached, when `security-reviewer` runs, when the external review add-on runs and how its setting is read, how visual work is driven and how many views it needs, and the accessibility audit of visual work with the minimum target size it holds | [`resume`](.agents/skills/resume/SKILL.md), "6. Verify and review" |
| Every other rule of the external review, in a repository that has turned that add-on on: the pool it is metered from, the allowance lookup, how each thread is settled before the draft is marked ready, whether a review still stands after a rebase, and the provider-unavailability exception | The add-on's own skill, which [`resume`](.agents/skills/resume/SKILL.md) names under "6. Verify and review" |
| How shared files are fingerprinted, pinned and kept as real files; how a repository overrides a seat's settings and what an override may not do; how a repository names the runtimes it runs and which files each runtime owns; how a repository turns the external review add-on on or off; how a repository turns the documentation sweep off and what that leaves out; what a repository needs before it runs the workflow; and how a sync job runs: the command, what one run copies and removes, when a card is covered and how covered cards close | The [`sync-job`](.agents/skills/sync-job/SKILL.md) skill |
| The tracker and triage vocabulary the vendored skills expect to have been provided | [docs/ISSUE-TRACKER.md](docs/ISSUE-TRACKER.md) |
| How many skills are vendored, from which upstream repositories and at which commits | [docs/AI-WORKFLOW-runtimes.md](docs/AI-WORKFLOW-runtimes.md) |
| The documentation sweep and its day-after triage, when the Conventions table marks them active and the settings file does not hold `"docSweep": false` | [docs/DOC-SWEEP.md](docs/DOC-SWEEP.md) and [docs/SWEEP-TRIAGE.md](docs/SWEEP-TRIAGE.md) |
| The weekly retro, in a repository whose `docs/ISSUE-TRACKER.md` records it | [docs/WEEKLY-RETRO.md](docs/WEEKLY-RETRO.md) |

## Owner gates

1. **Work-pick** is the owner's pick of one row of the `resume` candidate table, which approves that card's
   outcome and acceptance criteria as written and starts the job, unless the `resume` skill's checks under
   "3. Start the job" do not confirm the card is free; no criteria list is shown and no second yes is asked.
   Owner-directed surfaces are the Surfaces table's `owner-directed` row and need owner direction plus
   canon or domain validation; sign-off surfaces are its `sign-off` row and need explicit sign-off and a named
   anti-regression test.
2. **Push authorisation** is one yes to the filled pull request body and its screenshot, and any owner
   instruction to push is that yes. It covers the whole deliver sequence in the `resume` skill, push to
   auto-squash merge, with no fresh yes inside it. `closeout` follows the merge unasked.
3. **Plan approval** is optional and off unless the repository's settings file holds `"planApproval": true`; a
   repository with no settings file, no such key or `false` goes from plan to build with no owner step. Where it
   is on, it is one yes to the completed plan as presented, given before anything is built, and any owner
   instruction to build that plan is that yes; silence and elapsed time never are. A change the owner asks for
   is made and the plan presented again before that yes. The plan is presented after any plan review the card
   requires, which stays the agents' own review and no part of this gate, and both gates above keep their
   meaning. The `resume` skill owns the steps under "4. Plan".

A material change to the approved outcome, product meaning, or a trade-off goes back to the owner as a
plain-language decision before it is built; a parser, state machine, or framework the outcome did not name is
such a change. Anything short of that which the job surfaces and can sensibly finish in the same job, in the
same files under the same tests, rides along and is named in the pull request body; a follow-up card is filed,
without asking, only for work that genuinely cannot.

**Disposable job cleanup.** The session must remove verified disposable, inactive files and folders it created
for its own approved job, inside or outside the job worktree, without further approval and whether or not a
verifier reported them. This project rule overrides the general machine rule requiring deletion approval only
for this exception and the leftovers it covers below. Session creation evidence must establish the exact path and
ownership; a name pattern, memory, summary or previous session alone does not establish either. Disposable
excludes owner files, tracked deliverables, and evidence or plans still needed for unfinished work or handoff;
another job's artifacts are leftovers. Verify inactive use and follow
[closeout's cleanup steps](.agents/skills/closeout/SKILL.md); existing worktree, branch, server and container
safeguards remain.

The same rule covers leftovers. Any session, in a job or not, that finds a file, folder, worktree or branch the
workflow made and the paragraph above does not settle reads
[Leftover rule](.agents/skills/closeout/SKILL.md#leftover-rule) in the `closeout` skill before it reports, deletes
or leaves it: that section owns what a leftover is, how each is investigated and what each outcome allows. Only a
leftover that investigation shows dead is deleted without further approval. A safeguard's refusal keeps the target
and is reported with the evidence, never forced. This grants no general deletion or publication authority; other
destructive actions keep exact-target approval.

An approval covers only the question it answered. After a context compaction, reread the owner's latest messages
before acting on one; an approval whose question is no longer in view is asked again. A memory, summary or earlier
session never grants approval.

## Compact instructions

Keep the approved plan's location, the card's acceptance criteria, the worklog path, the current slice and its
state, the evidence still owed, and each owner approval quoted word for word with the question it answered. Drop
discovery output: file listings, search results and file contents, which can be read again.

## Coding standards and the executed test bar

[docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md) owns how first-party code is written, and every seat that
plans, designs, builds or reviews code reads it before it starts; only the `explorer`, which locates code and judges
nothing, is exempt. [docs/TESTING-STRATEGY.md](docs/TESTING-STRATEGY.md) owns the evidence every claim needs, run
through `node scripts/run-log.mjs` so the pull request body quotes exit codes a script wrote.
Where the project has a user interface, [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) owns how it is built: which
values are tokens and where they live, the tolerated literals, and the component patterns new work reuses.

## Review and visual verification

One fresh review of the final tree before the pull request opens, at the tier two questions choose: can the change be
undone, and how far does the damage reach if it is wrong. The `resume` skill owns the rule under
"6. Verify and review", and the Surfaces table's `hard to undo` and `wide reach` rows hold this repository's answers.

Visual work is complete only after the changed interaction has been driven and a current screenshot displayed inline in
chat; push authorisation waits for that image.

## Publication and machinery

Push only with owner authorisation, through a draft pull request. A change the repository's
`scripts/gates/pre-push-main` admits whole is instead pushed, on the same authorisation, as a fast-forward of `main`
from the job worktree (`git push origin HEAD:main`), its commit carrying `Closes #<issue>`; no pull request opens and no
workflow runs. The gate alone decides what qualifies: documentation by its path and, where the gate judges changed
lines, a setting-only seat change. The push is judged by the gate as it stands on the remote's `main`, never by the
pushed checkout's copy, so a commit cannot admit itself by changing the gate or a file it loads. A repository without
that gate on `main` has no direct route.

New executable machinery in the workflow itself, including test scripts, harnesses, runners, and test-only tools
(product code and ordinary tests added to existing suites are exempt), needs one of the admissions the `resume` skill
lists under "4. Plan" as the machinery rule, and an addition to existing machinery meets the same bar. Prefer a native
feature over custom code, a hook over a script, and a sentence over a hook. Rewriting, shrinking or deleting existing
code, tests or tooling is always allowed when it is the right change for speed or quality, planned and reviewed like any
other change, with the owner gates and exact-target approval for destructive actions unchanged; no standard, strategy,
skill or charter may forbid it. Dead code that predates a change is flagged, and removed only with evidence, stated in
the plan or the pull request body, that it is unused and its removal safe; a removal that evidence cannot settle goes
to the owner as a decision.

## Shared workflow adoption

The files `.agents/factory-manifest.json` lists are shared workflow bytes, and `AGENTS.md` shares only the text between
its `factory-shared` markers. Each shared file is authored only in the manifest's `canonical` repository, under `src/`,
and reaches any other repository only through the manifest: by an install, which writes a shared file only where none is
and leaves an identical one as it is, by a sync afterwards, or by an update to a named release through its verified manifest;
the `sync-job` skill says how a sync fingerprints files, pins them at a commit and keeps them as real files. An adopter's copy of a shared file differs from the canonical
bytes in one way only: the value of a seat's model, effort or turn-limit line that the adopter's own committed seat
settings file names; the `sync-job` skill says how a repository overrides a seat and what an override may not do. An
adopter that runs one runtime carries no file of the other, and a file found at one of the other's shared paths is
refused like a changed byte. An adopter whose settings file does not turn the external review add-on on carries none of
that add-on's files, on the same terms. An adopter whose settings file turns the documentation sweep off carries none of
the `sweep-scope` check's files, on the same terms. An ordinary shared change opens no sync card: `resume` reports at
intake, as information, whether this repository lags the canonical copy. An urgent fix is authored in the canonical
repository first and pulled by a sync card on the owner's decision. A job whose card is a sync card reads the
[`sync-job`](.agents/skills/sync-job/SKILL.md) skill before it runs the sync.

Whoever can use the administrator bypass of the required check on `main` can put any commit on `main` when the local
hook is skipped: the holders of that role and every write deploy key, which GitHub admits by the same bypass, so the
repository keeps the role to the owner and carries no write deploy key.

A Claude Code session started in the root checkout keeps that checkout's git guard after it enters a job worktree, while
it reads the permission allow list from the worktree, so a change that widens the allow list is its own card, started
only once the guard change that bounds it is on `main` in the root checkout of the canonical repository and, through a
sync, of every adopter. An intentional adopter exception needs owner agreement and lives outside the shared files.

<!-- factory-shared:end -->

## Product

Kestrel is a local conversation prototype. Nemotron speech recognition and VoxCPM2 voice generation run on the RTX 5080 laptop; the Saluki brain runs through LM Studio on the Ally. Kestrel's only desktop tool is local mute of the selected audio output. The brain cannot invoke tools. Kestrel has no browser research or persistent conversation memory.

Product discovery and drilling with the owner must precede any further product implementation. Factory adoption preserves the prototype and stops before product work.

## Hard constraints

- Preserve microphone and model assets in ignored `.runtime/`.
- Never commit recordings, credentials or model weights.
- Keep the approved voice service behaviour unchanged during factory adoption.
- Modify shared bytes only in the canonical repository and carry them here through the canonical sync.

## Architecture seams

- `bot.py` owns conversation orchestration.
- `speech.py` owns speech adapters.
- `asr_worker.py` is the speech recognition process boundary.
- `hermes_worker.py` is the conversation-engine process boundary.
- `run-voice.sh` owns startup.
- `README.md` is the operation manual.
- [.agents/REPOSITORY.md](.agents/REPOSITORY.md) owns the local repository profile.

## Surfaces

| Surface | Kestrel |
|---|---|
| plan-first | Product implementation after owner discovery and drilling; conversation orchestration, speech adapters, the recognition process boundary and service startup; the workflow trust perimeter and sync contract. |
| owner-directed | Product direction and changes to the approved voice service behaviour; workflow owner gates and review tiers. |
| sign-off | Changes to microphone access, audio or transcript handling, the localhost service boundary, the Ally connection, or the workflow trust perimeter. |
| security review | The [privacy and runtime boundary](README.md#privacy-and-runtime-boundary): microphone and transcript handling, credentials, local runtime assets, service exposure and the Ally connection; runtime hooks, permission settings, workflow triggers and token permissions, and sync integrity. |
| hard to undo | Recordings, transcripts or credentials exposed through commits, logs or publication; loss or replacement of local microphone and model assets; repository hosting settings and rulesets. |
| wide reach | This local contract and `.agents/REPOSITORY.md`; workflow instructions, gates and settings; `bot.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py`, `run-voice.sh` and the operation manual. |

Standing security guarantees:

1. Microphone recognition and voice generation stay on the laptop; conversation transcripts and system context go to LM Studio on the Ally over the local network.
2. Kestrel opens no listening network service. Kestrel's only desktop tool is local mute of the selected audio output. The brain cannot invoke tools. Kestrel has no persistent conversation memory and cannot delete, send messages, publish or run arbitrary commands by voice.
3. Runtime model weights, reference audio and logs remain ignored and are never published. Transcript text may appear in local debug logs.
4. Shared workflow bytes retain canonical integrity through sync; the repository administrator bypass remains owner-only and no write deploy key is allowed.
