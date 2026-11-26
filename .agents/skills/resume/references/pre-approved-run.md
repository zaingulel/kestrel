# Pre-approved run

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Pre-approved run

A run that builds the open `Ready` cards and merges each on its evidence, as
[merge-on-evidence.md](merge-on-evidence.md) says, with no pick and no push question. The run's shared steps apply, except as these say.

The shared steps it names are in [runs.md](runs.md#the-runs-shared-steps) and [card-session.md](card-session.md).

The rules its phase sessions read are in [pre-approved-phase.md](pre-approved-phase.md) and the files that file names;
read each whole too.

1. **The trigger** is the owner's instruction `Start a pre-approved run.` It approves no action: each card's place in
   `Ready` while `waitForOwner` reads `on-screen` or `when-needed` is its only approval. The native Codex app uses
   the fixed select, prepare, build and deliver phases. Claude Code uses the sidebar route in step 3. On Codex a
   session whose first message is `End the pre-approved run: <results folder>` is its end session.
2. **The setting**: item 2 of [pre-approved-phase.md](pre-approved-phase.md).
3. **The launch** on Claude Code is step 3's. On Codex, a pre-approved run started from a plain terminal refuses: start the run in the Codex app at the repository root so every card has a visible chat. Follow the [native app route](runs.md#native-codex-app-run).
   On Claude Code every card session of a run is one the owner can watch, and fetched `main` settings and the place
   the run was started choose the route:

   | Fetched `main` | The run is started | Route |
   |---|---|---|
   | `"herdr": true` | anywhere | Open the project's [Herdr coordinator](herdr-lead.md#coordinator) to work through Ready in job tabs. A Claude Code session given the trigger directs the owner there. |
   | `herdr` not true | in the desktop app, at the repository root | The sidebar: read [pre-approved-sidebar.md](pre-approved-sidebar.md) whole and follow its run session steps in place of steps 5, 7 and 8's records here |
   | `herdr` not true | anywhere else | None: the session starts nothing and tells the owner to start the run in the desktop app at the repository root, or to turn Herdr on |

   No Claude Code run session starts a card session through `scripts/pre-approved-run.mjs`. A sidebar card session carries no deny rules, because they would
   refuse delivery, so the mark the git guard reads is its only bar. Codex retains its non-regressing job state:
   missing files never reconstruct an earlier phase, and lost lifecycle history is unknown and held. Each card
   session's probes are item 3 of [pre-approved-phase.md](pre-approved-phase.md).
5. **Selection and capacity.** Reconcile current jobs and retain each job's identity, file and resource reservations.
   A build waits only on an exclusive resource another
   job holds, on a closing job and on the holds below, and overlap with `main` and with other jobs is settled when each
   job merges, as step 6 says. A current job with unknown scope, including one left by an earlier run, holds only a
   build that declares exclusive resources. A built job awaiting delivery or the owner keeps its reservation.
   On the native Codex app route, selection and preparation are serial, independent builds may run concurrently, and
   delivery has one serial lane. Runtime-managed temporary waiting may continue when the runtime resumes it.
   Apply the native app's failure and interruption rules before advancing.
   Selection follows [pre-approved-select.md](pre-approved-select.md); the candidates, the evidence
   paths, the shared prepared evidence and the other rules phase sessions share are item 5 of
   [pre-approved-phase.md](pre-approved-phase.md).

   Keep run results in a temporary directory outside the integration checkout and EVERY job worktree in the current
   inventory, on both runtimes. Before any evidence write or child dispatch, compare the resolved results directory
   against the complete inventory, including peer jobs. Resolve existing roots canonically; only `ENOENT` means an
   absent root contains no evidence. Permission and other errors are unavailable. This containment rule never exempts
   a missing job from full admission reconciliation.

   **Fixed phases.** The remaining selection, preparation and admission instructions in this step apply to the
   native Codex app route.

   The selection session follows [pre-approved-select.md](pre-approved-select.md) and preparation
   [pre-approved-prepare.md](pre-approved-prepare.md). Validate authoritative ownership before preparation.
   The fixed phase prompts, each followed by a newline
   and its JSON context, are the ones the **Run triggers** under "Before intake" name.

   The coordinator verifies the artifacts and accepted evidence, checks admission, then schedules the next
   phase or reports the hold.

   Before granting build or delivery, call `node scripts/pre-approved-run.mjs --check-admission <request-file>`
   with the reviewed descriptor and plan hashes and all complete current references. The absolute request file holds
   exactly `runStart`, `phase`, `candidate` and `reservations`; request phase is `build` or `deliver`, stating requested
   authority, never proving it.
   Candidate holds `descriptorPath`, `descriptorHash`, `planHash` and `reviewRecordPath`; each reservation holds those
   fields and `phase` as `prepare`, `build` or `deliver`, retaining its last phase while held. Paths are absolute and
   hashes are lowercase SHA-256 hex. Reconcile all current jobs, not only these references. The boundary refuses missing
   or unexpected fields and inconsistent identities, paths, hashes or review evidence. It returns one JSON object with
   `decision` and `reasons`: `allow` with empty reasons and exit 0, `wait` with reasons and exit 3, or `unavailable`
   with reasons and exit 1. It checks that the card is open and not a proposal, the exact original claim and assignment, worktree, branch and
   base, the reviewed hashes, native open blockers and reviewed prerequisites, and exclusive-resource independence
   against all current jobs, comparing no files between jobs. The exact claim must be the first current authenticated
   claim absent from `priorClaimUrls`, in GitHub order. An unfinished or unreadable prerequisite waits. Another current
   job without a complete accepted reviewed footprint causes a wait with the job and reason named, only for a candidate
   that declares exclusive resources; a branch diff alone cannot establish its exclusive resources. A preparation park
   without an accepted reference retains its reservation and unknown-scope wait for such a candidate; include only
   complete references in the request, never a malformed descriptor. Missing safety evidence, malformed or changed metadata is unavailable, never an
   assumption of independence. An allow admits only the requested phase; a wait leaves it waiting; unavailable stops
   new admission and delivery and names the missing evidence.
   An older waiting job without complete reviewed scope may hold new builds that declare exclusive resources: selection and preparation may continue, then the run may end normally with those prepared reservations retained and the blocker named.

   **Inactive preparation and precedence.** A build candidate must be verified inactive preparation: current
   ownership and accepted descriptor/review validate, its retained prepare start context and exact completed
   `prepared` outcome match, no later build/delivery start context or contradictory outcome exists, it has no held or
   Needs-owner signal, and its committed, unstaged, staged and untracked application delta is empty. Existing ignored
   evidence locations confer no new application-path exemption. A reservation missing prepare outcome/start evidence
   remains an ordinary binding reservation. A reservation whose retained lifecycle is build or deliver but whose
   expected start context is missing is unavailable, never inactive. Missing required candidate evidence is likewise
   unavailable. Present later contexts defeat inactivity;
   linked, unreadable, malformed or mismatched evidence is unavailable. A phase hint alone grants nothing.

   Delivery with matching retained build context and completed `built` outcome may pass verified inactive
   preparations, retaining every reference and job reservation. Builds still compare admitted, held and unknown
   jobs normally. Among conflicting inactive preparations, first determine one-level eligibility: current native and
   reviewed prerequisites are known satisfied, and binding admitted/held work does not block the preparation.
   Unknown current resources block admission; unreadable eligibility remains a named wait. Compare only
   eligible preparations by the authoritative original claim's `createdAt`, then lower card number. A known-blocked
   older preparation cannot veto its later prerequisite or work independent of its blocker. Add no recursive dependency
   solver; unresolved cycles remain waits. This priority changes no selection-record order or owner gate.

   **Retained start evidence.** Before each prepare/build/deliver child starts, validate its exact context and write
   `<phase-log-base>.context.json` exclusively; retain it after completion, native tool timeout, interruption or spawn failure. Preparation
   requires the selected context; build also requires the accepted descriptor/review and matching completed
   `prepared` outcome; delivery requires matching retained build context and completed `built` outcome. Build and
   delivery log directories must match the validated descriptor directory, with paired `job-<same-card>.prepared.json`
   and `job-<same-card>.reviewed.json`. A retained-context or output collision refuses without overwrite or dispatch;
   only `ENOENT` means absent evidence. A caller's staging input never establishes that execution started.

   The shared `retainPreparedContext(context, logBase, jobWorktrees)` writer owns path checks, serialization and
   retention for native Codex phases. It receives the complete inventory roots already read by
   `verifyPreparedContext`, never a JSON field or a subset. Launch validation remains pure; the writer performs no
   Git read or model dispatch. Before the first build it exclusively retains
   `job-<card>.plan.snapshot.md` and `job-<card>.review.snapshot.md` beside the phase records, with hashes equal to
   the accepted plan and review-evidence hashes. Existing regular, unlinked snapshots may be reused only with identical
   bytes. Revalidate before delivery; mismatch, missing snapshots, links or unreadable bytes are unavailable. Present
   originals must still match, and ordinary OPEN work requires the originals. These creator-owned records and retained
   lifecycle are execution evidence, not a promise of filesystem unforgeability or owner approval.

   **Settling closeout.** An ordinary OPEN delivery permits independent builds. A narrow denial-only wait applies
   while a retained delivery closes its card or removes its worktree before returning its result. Validate every
   supplied reference, descriptor/review schema, fixed name, hash, accepted binding and present phase record before
   hydrating live job files. The closing predicate requires the highest retained phase to be deliver; matching
   delivery/build start contexts and completed `built` outcome; no delivery outcome yet; accepted descriptor/review
   and same-hash snapshots; current exact claim order/author and sole assignment; and fresh progress showing the
   issue CLOSED, terminal board status or disappearance of that exact recorded job root. Missing plan alone is not
   closing, and CLOSED grants no new-work approval. Verify originals still present; only under this predicate may
   snapshots supply missing original plan/review bytes. Corruption, permissions or changed/missing ownership are
   unavailable, never settling waits.

   Keep the closing job's identity and resources reserved. All new selection, preparation, build and delivery
   authority waits through the child result, independent verification of delivery, the immutable outcome and attention accounting.
   After a delivery outcome exists, use normal settlement; remove the reservation only when accounting succeeds, then perform
   full fresh admission. Failed verification, outcome or attention retains the job and safety-stops the run.

   Use the same closing probe before admission hydrates artifacts, before selection inventory reads, before preparing
   a newly selected job and again in the same loop iteration after launching delivery. Validate other references and
   all nonclosing inventory before returning wait; an unknown or unreferenced closed job stays unavailable. Pure
   own-claim checks resolve only their own inventory entry, so an unrelated disappearing peer cannot corrupt them.
   An already-started selection may finish validation/accounting and keeps its selected state. Once closing clears,
   a non-notifying selected job gets exactly one serial preparation before ANY new selection; re-enter coordination
   afterward, continuing its stored identity without repicking or reclaiming.

   If a job-scoped operation on a known retained deliver reservation encounters exact disappearance or a closed-row
   race, permit one bounded fresh closing read. Attribute it only from the caller-supplied card and root, plan/review,
   owned-Git or closed-row operation that failed, never from exception or stderr text. Wait only after revalidating
   the retained facts and fresh closing predicate. An ancestry rejection, hash/schema/permission failure or unrelated
   operation never qualifies. Await the existing pending promise or native-task completion while delivery is pending;
   add no polling or general retry service.

6. **The job**: item 6 of [pre-approved-phase.md](pre-approved-phase.md) and
   [pre-approved-deliver.md](pre-approved-deliver.md).
7. **Results and attention.** The result must match its exact card and route as step 5 says. Each completion is accounted once. Before queuing its fixed reference, the coordinator writes
   `<folder>/<name>.outcome.json` once with exclusive creation: exactly `runStart`, `card`, `claimUrl`, `phase`,
   `disposition` and `reason`. Phase is `select`, `prepare`, `build`, `deliver` or `end`. Job disposition is the matching one of
   `selected`, `prepared`, `built`, `merged`, `awaiting-push`, `parked`, `stopped`, `failed` or `interrupted`.
   Readers also accept retained historical `timed-out` and `budget-exhausted` dispositions. Selection without validated identity has null card and claim URL; later job phases
   bind the stored identity and context. The end phase has null card and claim URL as step 8 says. The native app coordinator records the complete reason, including cancellation
   uncertainty. Keep model messages and logs separately. The coordinator reads and validates this
   exact record against the expected run, job, claim and phase before presenting attention. A missing, unreadable,
   colliding, malformed or mismatched record is unavailable: stop new admissions and delivery, retain affected state and
   report incomplete evidence. Never infer a disposition from model text or the shared `run-end.txt`. The outcome is
   evidence, not approval; existing claim, head, body hash and review checks still govern each transition.

   A validated prepare, build or deliver stop prevents all new selection, preparation, build and delivery. Account
   already-started work once, retain stopped and unfinished reservations, and include the original reason in the one
   normal end summary; a valid summary exits 0. A park remains per-job. Cancellation, missing guard witness, unsafe
   unavailability or outcome-evidence or notification failure is a global safety stop: start no end model and exit 1.
8. **The end** follows step 9's reporting: the run files no card, and the summary's **Suggested** list
   names every entry the card sessions offered as offered and not filed. Where the run went by card number because a `Ready` card's place was unknown, the summary says so in one line. **Built** also names each card the run
   merged, with its pull request. Keep the existing end prompt and `end` log basename, with no factory expiry,
   and print the summary once. Start no end model after card cancellation or another safety stop.

   Before printing a successful summary or notifying a failed end, write the exclusive `end.outcome.json` with the six
   fields of step 7, the same `runStart`, `phase: end`, null `card` and `claimUrl`, and disposition `summarized`,
   `failed` or `interrupted`; readers also accept retained historical `timed-out` records. `summarized` requires exit 0, both guard witnesses and nonblank `end.txt`;
   it means only that a validated summary is available. Failure, missing witness or blank summary is `failed`;
   interruption includes the cancellation uncertainty in the recorded reason. On success print the summary
   once without an extra notification. On failure or cancellation queue the results folder and the name `end` once and exit 1. If outcome
   storage fails, report it locally and attempt that same attention; the consumer reports unavailable evidence, without
   inventing or overwriting a record. End changes no claim and releases no reservation.
9. **Limits.** The setting check pins the current local fetched-main object without a network fetch; it does not
   prevent a session rewriting that local ref. A normal fetch makes a change of `waitForOwner` visible at the next launch or
   setting check, including ordinary work-pick and push and marked publication. Setting it to `always`, or marking a card `show-me-first`, does
   not cancel queued auto-merge; the owner turns that off separately.
   The guard judges only a publish command written plainly. A push or a draft wrapped as, for example,
   `env gh pr create`, `command git push`, `nohup git push`, `sh -c "..."`, a subshell or a brace group is not seen, nor
   is one after a background `&`, since the guard does not split a command there. Ready and merge are refused in more
   places, after a wrapper word, after a lone `&`, inside a substitution and after an assignment, but they too go unseen
   in shapes the guard cannot read, for example inside a wrapper's string such as `sh -c 'gh pr ready 12'`, in a heredoc
   fed to a shell or after a backslash-newline between their words; the comments of `scripts/lib/unsafe-git.mjs` name
   every such shape. A command word quoted, partly quoted or escaped may also hide any of the four: a push whose `git`
   or `push` is quoted or escaped, such as `"git" push` or `git "push"`, a draft whose `create` is quoted or whose `gh`
   is escaped, such as `gh pr "create"` or `\gh pr create`, and a ready or merge such as `\gh pr merge` or `gh pr
   "mer"ge`. Since a Claude Code card session carries no deny rules, no rule behind the guard refuses these
   forms there: at most auto mode's classifier judges them, and it guarantees nothing. It judges those four delivery
   forms alone: `gh pr edit --base`, `gh api` and every other GitHub write are not judged, and the git settings gh reads
   to choose a draft's head, `@{push}`,
   `branch.<branch>.pushRemote`, `remote.pushDefault`, `branch.<branch>.remote` and, under `push.default` upstream,
   `branch.<branch>.merge`, and, when the branch's push target is not at HEAD or there is none, any remote whose
   same-named branch is at HEAD, are not checked, though ready and merge refuse a pull request not from its own branch.
   Neither guard hook entry sets a timeout, and a Claude Code hook that times out does not block. The write-up the guard
   judges is one the run declares itself, as **What the guard checks** in [merge-on-evidence.md](merge-on-evidence.md)
   says.
