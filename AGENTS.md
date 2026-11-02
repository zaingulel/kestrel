# Kestrel

Repository contract: the factory region carries the shared workflow; the sections below define Kestrel's local product boundary, constraints and seams. The local repository profile lives in [.agents/REPOSITORY.md](.agents/REPOSITORY.md).

<!-- factory-shared:start -->

The always-loaded contract for every agent runtime: skills own the steps, hooks own what must never happen, git owns all
state. This file holds in full only the rules every session needs; every other rule has one home, which the index under
"Sources of truth" names. A rule a test or hook enforces is named here, not restated.

## Runtime notes

A repository runs Claude Code, Codex or both. Its settings file names which under `runtimes`, and a repository that
names none runs both. Only the named runtimes' seats, hooks, skill copies and contract file are installed, so a
sentence here, in a skill or in a charter about a runtime the repository does not run applies to nothing in it.

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

Before applying any bundled PostgreSQL example, read [docs/POSTGRES-EXAMPLES.md](docs/POSTGRES-EXAMPLES.md) whole and apply its caveats.

The session that talks to the owner coordinates: it plans the cards that need no architect, hands every edit to a
builder seat, settles reviews, and delivers; it never builds. Residual judgment that would make a handoff
unreliable is resolved in the plan or the slice is split smaller. In every session, job or not, discovery wider
than a couple of files goes to the `explorer` seat, so its conclusion reaches the main thread and its file dumps do
not. The costliest Claude model, Fable, is reached only through the `oracle` seat, and the
costliest Codex model, Astra, only through the
`architect`, `oracle` and `security-reviewer` seats; the session and the builders run below that tier, each
builder at the model its seat file sets. Every subagent is one of the named seats above, dispatched by its seat
name; a generic, default or unnamed role is never dispatched.

A session waiting on a helper or a command uses its runtime's native awaited operation as the `resume` Waiting rule
under "5. Build" says and never substitutes manual sleep-and-status-check loops.

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
must decide, the options. The owner reads decision cards and screenshots, not diffs; write for that reader. `resume`
starts or continues a session, `handoff` parks unfinished work, `closeout` follows a merge.
Present Markdown deliverables in chat, using verified GitHub permalinks once published; open a local Markdown file
for presentation only when the owner explicitly asks. The closeout skill owns lasting links before worktree cleanup.
In owner-facing progress, approval and completion messages, summarize evidence concisely as Passed, Failed and
Untested: group related passes, state failure causes or say when unknown, report the latest valid outcome of repeated
runs while retaining unresolved or unexplained earlier failures, and name relevant unrun checks and any skipped step
with their reasons and consequences. Say when there are no failures. Include the log path or link; keep full receipts,
timestamps, hashes and repeated runs in the log and existing published evidence. Show requested raw evidence, or a short diagnostic excerpt when needed to explain
a failure. Name guesses, never invent numbers, and call work done only once verified; a value that cannot be computed
fails loudly with its cause, never as a blank or zero that reads as real.

Every rule this file does not hold in full has one home:

| Topic | Home |
|---|---|
| What is true of this repository alone: its product, where its own facts live, its grounding authorities and its Conventions table | `.agents/REPOSITORY.md` |
| Reusing instruction text already read | The [`resume`](.agents/skills/resume/SKILL.md) skill, "Before intake" |
| Which builder seat a slice goes to; the machinery admissions, the friction route and how machinery leaves; what a plan carries for a change to how the interface looks, and who decides where the `frontend-design` skill and the design system disagree; and the steps of plan approval where a repository has turned it on: how the setting is read, how the plan is presented and revised, and what a resumed session does | [`resume`](.agents/skills/resume/SKILL.md), "4. Plan" |
| Each runtime's form for waiting on a helper or a long command | [`resume`](.agents/skills/resume/SKILL.md), "5. Build" |
| The decision card and saved write-up; how a run's waiting jobs are reviewed in a batch, how each verdict is recorded and how the stage 2 measures are read | [`resume`](.agents/skills/resume/SKILL.md), "7. Push authorisation" |
| The two questions that choose a review tier, the three tiers, the guard rule, what a setting-only seat change is, the cross-family route, the authorization it runs on, its single-family form in a repository that runs one runtime, its same-family form in a cloud build, and its substitution when the other family's seat cannot be reached, when `security-reviewer` runs, when the external review add-on runs and how its setting is read, how visual work is driven and how many views it needs, and the accessibility audit of visual work with the minimum target size it holds | [`resume`](.agents/skills/resume/SKILL.md), "6. Verify and review" |
| Every other rule of the external review, in a repository that has turned that add-on on: the pool it is metered from, the allowance lookup, how each thread is settled before the draft is marked ready, whether a review still stands after a rebase, and the provider-unavailability exception | The add-on's own skill, which [`resume`](.agents/skills/resume/SKILL.md) names under "6. Verify and review" |
| How shared files are fingerprinted, pinned and kept as real files; how a repository overrides a seat's settings and what an override may not do; how a repository names the runtimes it runs and which files each runtime owns; how a repository turns the external review add-on on or off; how a repository turns the documentation sweep off and what that leaves out; and what a repository needs before it runs the workflow | The [`shared-files`](.agents/skills/shared-files/SKILL.md) skill |
| The tracker and triage vocabulary the vendored skills expect to have been provided | [docs/ISSUE-TRACKER.md](docs/ISSUE-TRACKER.md) |
| What to ask the owner and what agents decide when `to-spec` or an interview for it shapes a specification: read before asking anything | [`to-issues`](.agents/skills/to-issues/SKILL.md), "Specification entry" |
| How many skills are vendored, from which upstream repositories and at which commits | [docs/AI-WORKFLOW-runtimes.md](docs/AI-WORKFLOW-runtimes.md) |
| The documentation sweep and its day-after triage, when the Conventions table marks them active and the settings file does not hold `"docSweep": false` | [docs/DOC-SWEEP.md](docs/DOC-SWEEP.md) and [docs/SWEEP-TRIAGE.md](docs/SWEEP-TRIAGE.md) |
| Writing or reviewing new human-facing documentation, unless the settings file holds `"docSweep": false` | [docs/DOCUMENTATION-STANDARD.md](docs/DOCUMENTATION-STANDARD.md) |
| The weekly retro, in a repository whose `docs/ISSUE-TRACKER.md` records it | [docs/WEEKLY-RETRO.md](docs/WEEKLY-RETRO.md) |

## Owner gates

1. **Work-pick** is the owner's pick of one row of the `resume` candidate table, which approves that card's
   outcome and acceptance criteria as written and starts the job, unless the `resume` skill's checks under
   "3. Start the job" do not confirm the card is free; no criteria list is shown and no second yes is asked.
   With `"productManager": true` on `main`, the owner may hand this pick to a product manager run, as `resume` says
   under "2. Work-pick": one instruction hands over each pick until the run stops, on Codex the owner running
   `node scripts/product-manager-run.mjs`, and the start message of a session that run starts carries that hand-off, the
   one earlier-session message that does, and no other approval. No run picks a card needing owner
   direction or sign-off, or a suggested card the owner has not answered. Owner-directed
   surfaces are the Surfaces table's `owner-directed` row and need owner direction plus canon or domain
   validation; sign-off surfaces are its `sign-off` row and need explicit sign-off and a named anti-regression
   test.
2. **Push authorisation** is one yes to the decision card and its screenshot, and any owner instruction to push is
   that yes. It approves the card and covers the whole deliver sequence in the `resume` skill, push to auto-squash
   merge, with no fresh yes inside it. A material limit missing from the card has not been accepted. `closeout`
   follows the merge unasked.
3. **Plan approval** is optional and off unless the repository's settings file holds `"planApproval": true`; no file,
   no key or `false` sends a plan to build with no owner step. Where it is on, it is one yes to the completed plan as
   presented, given before anything is built, and any owner instruction to build that plan is that yes; silence and
   elapsed time never are. A change the owner asks for is made and the plan presented again before that yes. The plan is
   presented after any plan review the card requires, which stays the agents' own review and no part of this gate, and
   both gates above keep their meaning. The `resume` skill owns the steps under "4. Plan".

**Routine board updates.** For an owner-approved job, the coordinating session has the owner's standing
authorisation for the board status and routing updates, job assignment and claim bookkeeping prescribed by this
workflow, including moving the card to `Awaiting push` before requesting push authorisation. The workflow's
eligibility, ownership and evidence checks and all owner gates still apply. This authorises board bookkeeping only,
with no permission to publish code. In a product manager run it also covers the `Needs owner` comment and move to
`Backlog` that `resume` prescribes, and filing the suggested cards and split children it prescribes. It also covers
the `Verdict:` comment `resume` prescribes when the owner answers a run's job, and the `Needs owner` comment and move
to `Backlog` a no prescribes. A session the owner starts or reopens may rewrite that comment to `Returned:`, only on
the owner's own message; a run never does.

A material change to the approved outcome, product meaning, or a trade-off goes back to the owner as a
plain-language decision before it is built; a parser, state machine, or framework the outcome did not name is
such a change. Anything short of that which the job surfaces and can sensibly finish in the same job, in the
same files under the same tests, rides along and is named in the pull request body; a follow-up card is filed,
without asking, only for work that genuinely cannot; in a product manager run it is a suggested card, as `resume` says.

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
and is reported with the evidence, except for the two verified branch exceptions in
[closeout step 5](.agents/skills/closeout/SKILL.md): this job's exact merged-pull-request head and its
session-created pre-squash backup. That procedure owns their proof and limits; every other refusal remains binding.
This grants no general deletion or publication authority; other destructive actions keep exact-target approval.

An approval covers only the question it answered. After a context compaction, reread the owner's latest messages
before acting on one; an approval whose question is no longer in view is asked again. A memory, summary or earlier
session never grants approval, except the start message gate one names.

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
and leaves an identical one as it is, or by an update to a named release of the canonical repository through its
verified manifest; the `shared-files` skill says how shared files are fingerprinted, pinned at a release and kept as real
files. An adopter's copy of a shared file differs from the canonical bytes in one way only: the value of a seat's model,
effort or turn-limit line that the adopter's own committed seat settings file names; the `shared-files` skill says how a
repository overrides a seat and what an override may not do. An adopter carries no file of a runtime its settings file
does not name, of the external review add-on unless that file turns it on, or of the documentation sweep's shared files
where that file turns it off, and a file at one of those paths is refused like a changed byte. A shared change reaches
adopters when the owner publishes a release and each adopter applies it on an update card. An urgent fix is authored
in the canonical repository, released, and applied on the owner's decision.

Whoever can use the administrator bypass of the required check on `main` can put any commit on `main` when the local
hook is skipped: the holders of that role and every write deploy key, which GitHub admits by the same bypass, so the
repository keeps the role to the owner and carries no write deploy key.

A Claude Code session started in the root checkout keeps that checkout's git guard after it enters a job worktree, while
it reads the permission allow list from the worktree, so a change that widens the allow list is its own card, started
only once the guard change that bounds it is on `main` in the root checkout of the canonical repository and, through a
release update, of every adopter. An intentional adopter exception needs owner agreement and lives outside the shared files.

<!-- factory-shared:end -->

## Product

Kestrel is a local conversation prototype. Nemotron speech recognition and the default Phonon 31M English q8 voice generation run on the laptop's CPU (central processing unit), with VoxCPM2 available explicitly on its RTX 5080; the Bonsai 2 27B brain runs locally through the pinned Prism server with F16 key and value caches and a 64,000-token context. Ordinary thinking is off; a request beginning with **Think more deeply about** enables it for one answer. The service starts inactive; **Hey Kestrel** starts a fresh conversation after local preparation, and **Super + Shift + K** starts or ends one while warm models and echo removal retain microphone use. The [standing security guarantees](#surfaces) list what the brain can invoke and what it asks first. Exact local commands keep working without the brain. Kestrel has no browser research or reusable conversation archive. [README.md](README.md#automatic-local-notes) owns notes, fresh snapshots and operator controls; its [trace rules](README.md#local-conversation-traces) own separate retained diagnostics.

Product discovery and drilling with the owner must precede any further product implementation. Factory adoption preserves the prototype and stops before product work. A change that keeps every documented behaviour and only reshapes code is not product implementation; it follows the normal plan and surface rules.

## Hard constraints

- Preserve microphone and model assets in ignored `.runtime/`.
- Never commit recordings, credentials or model weights.
- Keep the approved voice service behaviour unchanged during factory adoption.
- Modify shared bytes only in the canonical repository and receive them here through named Fabraik release installs or updates.

## Architecture seams

- `bot.py` owns conversation orchestration.
- `app_resolver.py` owns native installed-app lookup.
- `tool_catalogue.py` owns the shared desktop tool facts, argument admission, schemas, instructions and brain result contract.
- `tool_actions.py` owns how Kestrel's tools run: each tool's run step, the open-app lookup step and the shared safe local-command runner; the engine process never loads it.
- `reply_progress.py` owns reply progress: how far each reply's speech has reached audio output and how the reply ended.
- `admission.py` owns admission: which input enters the conversation and which request may still speak.
- `speech.py` owns speech adapters.
- `wakeword.py` owns the isolated local wake detector, pinned asset admission and bounded worker protocol.
- `asr_worker.py` is the speech recognition process boundary.
- `hermes_worker.py` is the conversation-engine process boundary.
- `run-voice.sh` owns voice startup.
- `run-brain.sh` owns the pinned local brain invocation; `check-brain-ready.sh` owns its bounded HTTP readiness check.
- `systemd/kestrel-brain.service` and `systemd/kestrel-voice.service` own graphical-login startup and session lifetime.
- `README.md` is the operation manual.
- [.agents/REPOSITORY.md](.agents/REPOSITORY.md) owns the local repository profile.

## Surfaces

| Surface | Kestrel |
|---|---|
| plan-first | Product implementation after owner discovery and drilling; conversation orchestration, speech adapters, the recognition process boundary and service startup; the workflow trust perimeter and shared workflow contract. |
| owner-directed | Product direction and changes to the approved voice service behaviour; workflow owner gates and review tiers. |
| sign-off | Changes to microphone access, audio or transcript handling, the localhost brain service boundary, or the workflow trust perimeter. |
| security review | The [privacy and runtime boundary](README.md#privacy-and-runtime-boundary): microphone and transcript handling, credentials, local runtime assets, local brain service exposure; runtime hooks, permission settings, workflow triggers and token permissions, and shared workflow integrity. |
| hard to undo | Recordings, transcripts or credentials exposed through commits, logs or publication; loss or replacement of local microphone and model assets; repository hosting settings and rulesets. |
| wide reach | This local contract and `.agents/REPOSITORY.md`; workflow instructions, gates and settings; `bot.py`, `tool_actions.py`, `reply_progress.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py`, `run-voice.sh` and the operation manual. |

Standing security guarantees:

1. Microphone recognition and voice generation stay on the laptop; the Bonsai brain, conversation transcripts and system context stay on the laptop. The enabled voice service starts inactive at graphical login and can use the microphone during startup and inactivity through echo removal. Prepared inactivity also uses temporary verified capture for the isolated local wake detector; waiting audio never enters ordinary recognition, transcripts, brain requests, notes or local actions. Typed requests suppress waiting capture through matching output completion. Waiting capture is reaped before activation; uncertain cleanup refuses activation. [README.md](README.md#wake-phrase-assets) owns private wake provisioning and optional-failure advice, with the shortcut retained after safe cleanup. Ordinary microphone recognition and spoken caller transcripts require active voice; explicit accepted typed requests can use the shared conversation, local exact commands and spoken replies while voice stays inactive. Starting voice creates a fresh conversation, including after typed-only use; dismissal revokes new work while already-accepted work drains.
2. Bonsai listens on loopback at `127.0.0.1:8080` and answers nothing but its `/health` readiness check without Kestrel's private brain key; processes running as this account can read the key, while other accounts and web pages cannot use the brain. Kestrel sends the key to whatever process holds that address, so recreate the key after any other program has held it. Kestrel's desktop tools are local mute, unmute and exact volume setting of the selected audio output, media pause and next track, numbered workspace focus, saving a native screenshot, and launching a uniquely matched visible installed app by name, plus, only through the brain, deleting one saved note after asking you. Launched apps keep their normal permissions and behaviour, including any network access or side effects. Kestrel does not read, copy or send screenshot content. The brain can invoke native local memory, including automatic note changes and removal without per-write approval, and exactly nine desktop tools through shared validation, permission checks and observed results: mute, unmute, set_volume, pause_media, next_track, focus_workspace, open_app, take_screenshot and delete_note. The brain chooses these calls itself from any accepted spoken or typed turn, without per-call approval for the eight free tools. delete_note asks first: Kestrel reads the exact note aloud and runs it only on a clear yes, spoken while voice is active or typed, and any other answer or none refuses; a tool in a forbidden class is refused and never asked. Any same-account process can submit typed text, so it can both request and approve a note deletion with nobody at the laptop, which today covers only Kestrel's own notes. A screenshot result reaches the brain only as confirmed, attempted and reason, never as a path or content. It cannot invoke other desktop tools. [README.md](README.md#stop-or-cancel) owns interruption and stop accounting. Kestrel has no reusable conversation archive and cannot delete desktop files, send messages, publish or run arbitrary commands through Kestrel. Outside text is a tool result or feature input without Kestrel's own source mark; Kestrel's instructions, the note snapshot and memory tool results are not outside text. Once it enters a conversation, the brain keeps only mute, unmute, set_volume, pause_media, next_track and focus_workspace; note changes, open_app, take_screenshot and every other tool are refused for the rest of that conversation with a spoken reason. Exact local commands still work, and a fresh conversation restores every tool.
3. Runtime model weights, reference audio, logs, private automatic notes and local conversation traces remain ignored and are never published. Notes persist across fresh conversations and restarts in the bounded private store; already-accepted writes can finish during dismissal. Traces never become later conversation memory or note inputs. Transcript text, model reasoning, memory and desktop tool payloads may appear in local diagnostics; [README.md](README.md#automatic-local-notes) owns notes and operator controls, and its [trace rules](README.md#local-conversation-traces) own diagnostic retention, deletion and limits.
4. Shared workflow bytes retain canonical integrity through named release installs and updates; the repository administrator bypass remains owner-only and no write deploy key is allowed.
