# Pre-approved run

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Pre-approved run

A run that builds and merges the cards the owner approved in advance, with no pick and no push
question. The product manager run's steps above apply, except as these say.

The product manager run's steps it names are in [runs.md](runs.md#steps-both-runs-share), except steps 5, 10 and 11, which it names only to say they do not apply.

1. **The trigger** is the owner's instruction `Start a pre-approved run.` It approves no action: each card's record
   is its only approval. Linux background Codex uses the whole-job route in step 5; Claude, the native app and non-Linux routes use the fixed phases below. On Codex one whose first message is
   `End the pre-approved run: <results folder>` is its end session.
2. **The setting** is read as step 2 reads `productManager`, its key being `preApprovedRun`: the run is on only where
   fetched `main` settings explicitly hold `"preApprovedRun": true`, and where cards are GitHub issues. That same
   condition governs records in ordinary sessions. The launcher enforces the opt-in before starting a top-level or
   inherited pre-approved card session; every approval check enforces it again, including work-pick and push checks
   in ordinary sessions and each marked publication. A missing file or key, or `false`, disables the run and leaves
   ordinary cards requiring the owner's pick and push yes; an unreadable fetched-main object,
   nonregular settings entry or invalid settings makes the setting unavailable. On refusal stop: confirm the owner's
   opt-in on `main` if disabled, or fetch origin and verify `.agents/factory-settings.json` on `main` if unavailable,
   then retry. Taking its own job pull request back to draft with `ready --undo` remains available either way.
3. **The launch** is step 3's or the authorized [native app route](runs.md#native-codex-app-run). On the terminal route the owner runs `node scripts/product-manager-run.mjs --coordinator <existing-chat-UUID> --pre-approved`, which
   takes one start time for the whole run and marks every session it starts with it, with no product manager mark.
   Each Codex session's push probe is `git push --dry-run ./.pre-approved-run-no-remote HEAD`, and the launcher ends
   the run unless the session's runtime log shows both `Command blocked by PreToolUse hook: Blocked: git commit` and
   `Command blocked by PreToolUse hook: Blocked: a pre-approved run session`. On Claude Code the run session reads
   `date -u +%Y-%m-%dT%H:%M:%SZ` once, at the start, types what it prints as `<run-start>` into every launch, and
   starts each card session as step 8 says with:
   `PRE_APPROVED_RUN_SESSION=<run-start> node scripts/product-manager-run.mjs --claude-card <absolute-logs-base>`.
   The bare wrapper performs selection only. For preparation, build and delivery use the same background settings and
   fixed flags with `PRE_APPROVED_RUN_SESSION=<run-start> node scripts/product-manager-run.mjs --claude-card <phase-log-base> --prepared-context <context-file>`.
   `<context-file>` is exactly `<phase-log-base>.request.json`. Exclusively create that staging input with the
   exact phase context below; an existing staging file is never
   overwritten. The wrapper expects this input to exist. It is separate from the executable-owned
   `<phase-log-base>.context.json`, retained before dispatch. Use step 5's fixed log names, never an arbitrary
   prompt, executable or timeout. Keep each native task ID and the highest phase actually dispatched; consume each
   completion once. Codex likewise retains its non-regressing job state. Missing files never reconstruct an earlier
   phase; lost lifecycle history is unknown and held.
   That launch carries no `--disallowedTools`, because those deny rules would refuse delivery, so the mark the git
   guard reads is its only bar. Each Claude Code card session makes the hook check under "Before intake", then runs
   `git push --dry-run ./.pre-approved-run-no-remote HEAD` as one plain command on its own, and stops unless the guard
   refuses it with a reason beginning `a pre-approved run session`.
4. **No direction page.** Step 4 does not apply: the records choose the cards.
5. **Selection and capacity.** The product manager run's stop for three or more waiting jobs does not apply here.
   Reconcile current jobs and retain each job's identity, file and resource reservations. A build never waits on
   another job's files, unlike the disjoint-files rule of "2. Work-pick": it waits only on an exclusive resource another
   job holds, on a closing job and on the holds below, and overlap with `main` and with other jobs is settled when each
   job merges, as step 6 says. A current job with unknown scope, including one left by an earlier run, holds only a
   build that declares exclusive resources. A built job awaiting delivery or the owner keeps its reservation.
   On Claude, the native app and non-Linux routes, selection and preparation are serial, independent builds may run concurrently, and delivery has one serial lane.
   On those terminal routes each build is an independent CLI session; Fabraik sets no numeric maximum, except that the
   [Herdr lead](#herdr-lead) holds every card session to its machine-wide cap. Runtime-managed temporary waiting may
   continue when the runtime resumes it. A terminal launch or runtime failure is reported and stops as the existing
   failure rules require; Fabraik does not automatically retry or guarantee recovery. Native helper concurrency limits
   apply within their own sessions, not to these independent processes.
   On those routes selection uses a separate session, or its bound native chat, with no factory expiry and may select and claim one job only, without planning, building or
   delivery. A selected job immediately retains its identity; until
   preparation establishes its scope, its unknown resources hold only a build that declares exclusive resources. The candidates are the
   rows of the table startable now that `node scripts/board.mjs --approval check <card>...`, run once over them,
   prints `approved` with a record time before the run start, which `printenv PRE_APPROVED_RUN_SESSION` prints on the marked CLI route and the binding records on the native route; a
   record posted later waits for the next run. They are taken oldest record first, then lower card number. No card
   is sent to the owner and none is filed. A blocked older candidate does not block an independent later one. Exclude
   other claimed jobs from selection. A selected job continues by its stored identity, never by repicking or reclaiming.

   Reconcile current jobs from status alone on open non-epic cards in `In progress`, `Awaiting push` or `In review`,
   and from complete held-job comments, actual `job/<card>` worktrees and local reservations or reviewed references for
   cards of any kind. Epic parents
   summarize child work; their explicit held `Job:` comments, actual worktrees and reviewed references still bind regardless
   of kind. A historical claim or assignment alone
   on `Backlog` or `Ready` is not a current job; keep the existing selection and ownership checks. A complete held-job
   comment is identified by first trimming leading whitespace from the raw comment, then taking its first line by splitting
   at a carriage return or newline and trimming the end of that line. The line starts `Needs owner:` and ends exactly
   `Job: job/<same-card> on <machine>.`, where the machine has no whitespace. Later lines do not cancel it; `Returned:`
   holds no job, and a question containing `Job:`
   without that suffix holds no job reservation. Read complete safety evidence: an incomplete read is unavailable, not zero.
   Stop when no eligible candidate or active work remains.

   Keep run results in a temporary directory outside the integration checkout and EVERY job worktree in the current
   inventory, on both runtimes. Before any evidence write or child dispatch, compare the resolved results directory
   against the complete inventory, including peer jobs. Resolve existing roots canonically; only `ENOENT` means an
   absent root contains no evidence. Permission and other errors are unavailable. This containment rule never exempts
   a missing job from full admission reconciliation. Keep the plan and review evidence at their normal job-local paths.
   For a known card, `<jobBase>` is the absolute `<results-folder>/job-<card>` and `<phase-log-base>` is
   `<jobBase>-prepare`, `<jobBase>-build` or `<jobBase>-deliver`.

   **Shared prepared evidence.** The descriptor `<jobBase>.prepared.json` has exactly `runStart`, `card`, `claimUrl`,
   `priorClaimUrls`, `branch`, `worktree`, `base`, `planPath`, `planHash`, `plannedFiles`, `prerequisites` and
   `exclusiveResources`. The card is a positive safe integer in the origin repository;
   prerequisites name repository and issue number; resources are stable non-secret labels, explicitly empty only when
   none are needed. The required plan review covers the final plan and descriptor. The accepted record
   `<jobBase>.reviewed.json` has exactly `runStart`, `card`, `claimUrl`, `descriptorPath`, `descriptorHash`, `planPath`,
   `planHash`, `reviewEvidencePath`, `reviewEvidenceHash` and `verdict` set to `accepted`. The descriptor path is the
   paired `<jobBase>.prepared.json`, and `reviewRecordPath` names its paired `<jobBase>.reviewed.json`; retain the review
   evidence and hash the actual descriptor, plan and evidence bytes. Preparation alone grants no build authority.

   **Linux background Codex whole jobs.** The launcher selects eligible cards in approval-record order, then card number,
   and starts one managed native unit per exact card. It excludes held, claimed, epic and blocked cards, registers each
   launch before spawn and reconsiders candidates after a worker settles. Independent jobs may run concurrently; there
   is no fixed job cap or deadline. Unavailable approval or scope holds the named card. The notification chat UUID
   grants no admission authority. A launch, proof, guard, record or notification failure stops new authority and accounts
   for active work.

   Each worker receives the fixed first line `Continue this exact pre-approved Codex job.`, followed by a newline and
   JSON containing exactly `card`, `runStart`, `base`, `results` and `mode`, where mode is `start` or `resume`.
   In `start` mode it rechecks Free and eligibility before making a new claim. In `resume` mode it continues the exact
   original authenticated claim and registered worktree, without a new claim or a Free selection check. It carries its
   plan, required plan and final reviews, fixes, build, delivery and closeout through ordinary Resume. Use the launcher-recorded intent for
   `priorClaimUrls` and `base`, and retain the original approval cutoff. The coordinator receives compact outcomes, not
   phase handoffs. The worker authors the descriptor in **Shared prepared evidence**, obtains its own plan review covering
   the plan and descriptor, settles its findings and writes the accepted record before requesting build admission.

   On resume, reuse original plan and review evidence only after rechecking its hashes, complete descriptor bytes,
   original job identity and continued applicability to the resumed scope. In the current attempt's results folder,
   recreate `job-<card>.prepared.json` and `job-<card>.reviewed.json`, bind the accepted record to that new descriptor
   path, and create the admission request from these current paths. Reuse the accepted verdict only for validated,
   unchanged content; changed or unverified evidence requires plan review before admission. Never reference a previous
   attempt's results directory in an admission request.

   Before application build edits, and again before delivery, from the exact job worktree call
   `node <operating-root>/scripts/product-manager-run.mjs --admit-job build|deliver <absolute-request-file>`.
   The request contains exactly `descriptorPath`, `descriptorHash`, `planHash` and `reviewRecordPath` from the accepted
   reviewed reference. The command authenticates the managed native worker and checks current approval, ownership,
   prerequisites, reviewed scope, actual changes and peers. A grant coordinates cooperative same-user workers; it is
   not hostile same-user isolation and no hook or publishing check trusts it. Use `local:<stable-label>` for exclusive
   effects bounded to this host and worker, including `local:tcp:127.0.0.1:<port>`; another exclusive resource needs
   independently established resource-native isolation or causes a named hold.

   Start admission with the asynchronous shell tool and retain its `session_id`; use native `write_stdin` waits under
   **Waiting** in section 5 until it returns. A tool yield is a handoff, not a deadline. A known live grant or delivery
   holder produces one named hold and waits for a change in the same command. Exit 0 allows, exit 3 names an unknown,
   legacy or external prerequisite, unavailable watch or lock contention and parks without a grant, exit 1 is unavailable,
   and exit 2 is invalid arguments. Do not loop on a hold. A lost command is unavailable and requests settlement.
   An open coordinator or suspended card without matching prior managed whole-job stop proof remains a named wait;
   an idle or clean worktree alone does not prove its writer stopped.

   Only the launcher finalizes after matching native start and stop proof and an empty exact process group. A park
   requests settlement and proves none: retain uncertainty and remote effects, the verified actual delta and any delivery
   slot until authoritative settlement. No automatic retry follows controller loss. Delivery compares committed, staged,
   unstaged and untracked changes with the job's own approved scope and its peers' resource grants; changes on `main`
   since the original base are settled at merge as step 6 says, preserving the generated-manifest exception and ordinary
   rebase, review, screenshot and guarded publishing rules.
   After merge verify the closed or terminal card and removal of its exact worktree before dropping its record. A job
   awaiting push uses its saved decision card and manual Resume delivery.

   Before reporting a workflow stop for a retained claimed worktree the worker still owns, park it as product-manager
   step 7 directs: commit what exists, update the worklog, post `Needs owner: <the reason, in plain language, standing
   alone> Job: job/<card> on <machine>.`, and move the card to `Backlog`. Keep the truthful `Run result: stop <card>:
   <reason>`; this remains a coordinator-wide stop. If a parking step fails, follow step 7's failure rule and report what
   remains incomplete. A stop before a claim does not park a card.

   For a parked return or an explicit owner return after a settled workflow stop, first apply **Parking** and its owner
   Returns and worklog checks, then run locally
   `node scripts/product-manager-run.mjs --coordinator <existing-chat-UUID> --pre-approved --continue-card <card>`.
   Resume the registered worktree with the original approval cutoff; refuse an active or uncertain attempt and obtain a
   new attempt and fresh grant before new edits. Do not replay phases. The launcher accepts only matching merged, built,
   parked or stop card results, verifies authoritative board and worktree state where applicable, and queues one validated
   immutable outcome with the existing six fields and `phase: job` for `job-<card>`, using per-card attention below.

   **Legacy phases.** The remaining selection, preparation and admission instructions in this step apply to Claude,
   the native app and non-Linux routes.

   The selection session performs the existing free, worktree and claim checks and ends with `Run result: selected <card>`.
   It writes `<logs>.selected.json` with exactly `runStart`, `card`, `claimUrl`, `priorClaimUrls`, `branch`, `worktree`
   and `base`. Validate authoritative ownership before preparation. The fixed phase prompts, each followed by a newline
   and its JSON context, are the ones the **Run triggers** under "Before intake" name.

   Follow "4. Plan" and "6. Verify and review" for the required independent reviews. The preparation job launches the
   plan reviewer and settles its findings and required follow-up. The build job launches the final reviewer and settles
   its findings and required follow-up before returning `built`. Each job keeps its working plan, diff and detailed
   findings in its own session and returns a compact phase result and settled verdict with exact references to saved
   evidence. The coordinator verifies the artifacts and accepted evidence, checks admission, then schedules the next
   phase or reports the hold.

   Preparation uses `phase: prepare` and the selection fields only. It plans this exact job without building or publishing,
   writes the final plan and descriptor, and returns `Run result: prepared <card>` only once the final plan, descriptor
   and accepted review evidence are available. On the terminal Codex route and in a Herdr lead session, marked by
   `FABRAIK_LEAD_SESSION=1`, the preparation session writes the accepted
   record before returning `prepared`; nothing trusts that variable for authority. On Claude background and native Codex app routes, the coordinator writes it after
   verifying the job's settled review evidence and before accepting `prepared`.

   Before granting build or delivery, call `node scripts/product-manager-run.mjs --check-admission <request-file>`
   with the reviewed descriptor and plan hashes and all complete current references. The absolute request file holds
   exactly `runStart`, `phase`, `candidate` and `reservations`; request phase is `build` or `deliver`, stating requested
   authority, never proving it.
   Candidate holds `descriptorPath`, `descriptorHash`, `planHash` and `reviewRecordPath`; each reservation holds those
   fields and `phase` as `prepare`, `build` or `deliver`, retaining its last phase while held. Paths are absolute and
   hashes are lowercase SHA-256 hex. Reconcile all current jobs, not only these references. The boundary refuses missing
   or unexpected fields and inconsistent identities, paths, hashes or review evidence. It returns one JSON object with
   `decision` and `reasons`: `allow` with empty reasons and exit 0, `wait` with reasons and exit 3, or `unavailable`
   with reasons and exit 1. It checks current approval, the exact original claim and assignment, worktree, branch and
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

   Build and delivery use exactly `phase`, `runStart`, `card`, `claimUrl`, `priorClaimUrls`, `branch`, `worktree`, `base`,
   `descriptorPath`, `descriptorHash`, `planHash` and `reviewRecordPath`, with phase `build` or `deliver`. Reject extra
   fields, including a supplied timestamp or timeout. Keep root working directory and guard probes before entering the
   verified worktree. Continue only the expected phase of the same job while its exact claim, assignment, approval,
   worktree, review and prerequisites remain valid. Accept only the matching phase and card result: `prepared` for
   preparation, `built` for build, and `merged` or `built` for owner-waiting delivery; parked and stop remain stops or
   parks. A mismatched result never advances authority.

   **Retained start evidence.** Before each prepare/build/deliver child starts, validate its exact context and write
   `<phase-log-base>.context.json` exclusively; retain it after completion, native tool timeout, interruption or spawn failure. Preparation
   requires the selected context; build also requires the accepted descriptor/review and matching completed
   `prepared` outcome; delivery requires matching retained build context and completed `built` outcome. Build and
   delivery log directories must match the validated descriptor directory, with paired `job-<same-card>.prepared.json`
   and `job-<same-card>.reviewed.json`. A retained-context or output collision refuses without overwrite or dispatch;
   only `ENOENT` means absent evidence. A caller's staging input never establishes that execution started.

   The shared `retainPreparedContext(context, logBase, jobWorktrees)` writer owns path checks, serialization and
   retention for both runtimes. It receives the complete inventory roots already read by launch verification through
   `verifyPreparedContext` or the scheduler's claim-context check, never a JSON field or a subset. Launch validation
   remains pure; the writer performs no Git read or model dispatch. Before the first build it exclusively retains
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
   authority waits through the child result, `verifyDelivery`, immutable outcome and attention accounting. After a
   delivery outcome exists, use normal settlement; remove the reservation only when accounting succeeds, then perform
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

   Re-read the exact authoritative initial claim before each phase; missing, invalid, withdrawn or replaced claims
   refuse, and its original `createdAt` must stay unchanged. Claim age sets no expiry and a new claim never substitutes
   for the selected identity. A native tool timeout, refusal or incomplete result stops advancement. A native tool
   timeout or interruption retains the job's identity and resource reservation even when a targeted stop appears
   successful, because detached tools may still run. Resolve remaining activity before restarting or releasing it;
   never assume a native tool timeout delivered SIGINT or SIGTERM. Account other active jobs safely; unavailable
   cancellation safety facts hold new admissions and deliveries.
6. **The job** is step 6's, except that a split proposal parks the job as step 7 says, and step 11 does not apply.
   Suggested cards are listed in the final message as step 6 says and never filed. At section 7 the job is judged
   by **Advance approval at push**: with no stop, the worker delivers through section 8 and closeout (the delivery phase alone does so on legacy routes).
   Before each delivery compare job-owned changes against the job's own scope and its resource claims against its peers'
   grants. Resolve `origin/main` as a trusted commit and use its three-dot diff to HEAD together with working tree, index
   and untracked paths. The original selected base remains the immutable ancestry anchor for both main and HEAD; never
   rewrite the accepted descriptor or remove ancestry checks. An expanded scope holds the delivery and names the conflict
   for revised plan and evidence. The product manager run's step 6 stop for a waiting job's file does not apply: overlap
   with `main` or with another job never holds a build or a delivery, and each job settles it when it merges. It fetches
   `main`, rebases onto `origin/main` and settles the manifest as deliver.md step 1 says rather than hand-merging it,
   reruns every check the **Receipt reuse** rule in deliver.md does not carry to the rebased head, then merges as
   section 8 says. A clash the job settles itself is a rebase that stops only on `.agents/factory-manifest.json`, with
   every check then passing on the rebased head and no edit to the job's files. Any other rebase conflict, or a check
   that fails on the rebased head and would need an edit, is a clash it cannot settle safely, and the job then: where
   the rebase stopped on that conflict and is still in progress, runs `git rebase --abort`, leaving the branch at its
   head before the rebase, or, where the rebase completed and a check then failed, keeps the rebased head as it is, and
   its worklog names that head, the head before the rebase and the failing check; where a pull request for the job is
   already open and ready, returns it to draft with `gh pr ready <pr> --undo`, and where none is open, or it is already
   a draft, does nothing here; pushes nothing rebased; parks as step 7 says, with a question naming the clashing files
   or the failing check; and returns `Run result: parked <card>: <question>`. Only that job parks: every other job and
   the run carry on.
   It publishes only as the guard admits: `git push -u origin job/<card>`,
   `git push --force-with-lease origin job/<card>` and section 8's `gh pr ready` and `gh pr merge` forms, each as a
   command on its own from its job worktree. It opens its draft only as
   `gh pr create --draft --title <title> --body-file <path>`, the title a letter or digit followed by letters, digits
   and `._:/-`, single-quoted with no `'` or newline, or double-quoted with no `"`, `$`, backtick, backslash, `!` or
   newline, also as a command on its own from its job worktree. A card whose change the direct route would carry, which
   `scripts/gates/pre-push-main` admits whole, is not delivered by the run: it is a stop under **Advance approval at
   push**, parked for the owner's push, because the direct route is bounded only by a hook the run could edit.

   A pre-approved run's card session runs section 8 and closeout unasked; its final message is the decision card, the pull request's address and
   `Run result: merged <card>`, and lists anything closeout would ask the owner. Where a stop holds, the card goes to `Awaiting push`, its body's first Not done item names the stop and is saved again, and the card session's final message is the decision card followed by `Run result: built <card>`; the batch review gives the fresh yes, carried to that session as **Carried answers** in step 8 of the product manager run says. At that stop the run also writes the card's waiting line, as **Advance approval at push** gives, and the phase fails instead of ending `awaiting-push` where the line cannot be written or a record still approves. For a card the Herdr lead holds, the fresh yes is the approval record the owner posts for the version the line names, which the lead delivers as the Herdr lead section's answered cards say. A question mid-job parks the job as step 7 of the product manager run says.
7. **Results and attention.** The result must match its exact card and route as step 5 says; no split result is
   accepted. Each completion is accounted once. Before queuing its fixed reference, the coordinator writes
   `<folder>/<name>.outcome.json` once with exclusive creation: exactly `runStart`, `card`, `claimUrl`, `phase`,
   `disposition` and `reason`. Phase is `job` for a Linux whole-job outcome, or `select`, `prepare`, `build`, `deliver`, `continue` or `end` on the existing routes; job disposition is the matching one of
   `selected`, `prepared`, `built`, `merged`, `awaiting-push`, `parked`, `stopped`, `failed` or `interrupted`.
   Readers also accept retained historical `timed-out` and `budget-exhausted` dispositions. Selection without validated identity has null card and claim URL; later job phases
   bind the stored identity and context. The end phase has null card and claim URL as step 8 says. The launcher owns the complete reason, including cancellation uncertainty;
   model text remains data. Keep model messages and logs separately. Both native coordinators read and validate this
   exact record against the expected run, job, claim and phase before presenting attention. A missing, unreadable,
   colliding, malformed or mismatched record is unavailable: stop new admissions and delivery, retain affected state and
   report incomplete evidence. Never infer a disposition from model text or the shared `run-end.txt`. The outcome is
   evidence, not approval; existing claim, head, body hash and review checks still govern each transition.

   A validated prepare, build or deliver stop prevents all new selection, preparation, build and delivery. Account
   already-started work once, retain stopped and unfinished reservations, and include the original reason in the one
   normal end summary; a valid summary exits 0. A park remains per-job, and a carried answer to a parked phase finishes
   the whole job as **Carried answers** in step 8 of the product manager run says. Cancellation, missing guard witness, unsafe
   unavailability or outcome-evidence or notification failure is a global safety stop: start no end model and exit 1.
8. **The end** follows step 9's reporting, except three jobs waiting is not an end reason, and step 10 does not apply: the run files no card, and the summary's **Suggested** list
   names every entry the card sessions offered as offered and not filed. **Built** also names each card the run
   merged, with its pull request. Keep the existing end prompt and `end` log basename, with no factory expiry,
   and print the summary once. Start no end model after card cancellation or another safety stop.

   Before printing a successful summary or notifying a failed end, write the exclusive `end.outcome.json` with the six
   fields of step 7, the same `runStart`, `phase: end`, null `card` and `claimUrl`, and disposition `summarized`,
   `failed` or `interrupted`; readers also accept retained historical `timed-out` records. `summarized` requires exit 0, both guard witnesses and nonblank `end.txt`;
   it means only that a validated summary is available. Failure, missing witness or blank summary is `failed`;
   interruption includes the cancellation uncertainty in the launcher-owned reason. On success print the summary
   once without an extra notification. On failure or cancellation queue the results folder and the name `end` once and exit 1. If outcome
   storage fails, report it locally and attempt that same attention; the consumer reports unavailable evidence, without
   inventing or overwriting a record. End changes no claim and releases no reservation.
9. **Limits.** The setting check pins the current local fetched-main object without a network fetch; it does not
   prevent a session rewriting that local ref. A normal fetch makes revocation visible at the next launch or
   approval check, including ordinary work-pick and push and marked publication. Turning the setting off does not
   cancel queued auto-merge; the owner turns that off separately.
   The guard judges only a publish command written plainly. A push or a draft wrapped as, for example,
   `env gh pr create`, `command git push`, `nohup git push`, `sh -c "..."`, a subshell or a brace group is not seen, nor
   is one after a background `&`, since the guard does not split a command there. Ready and merge are refused in more
   places, after a wrapper word, after a lone `&`, inside a substitution and after an assignment, but they too go unseen
   in shapes the guard cannot read, for example inside a wrapper's string such as `sh -c 'gh pr ready 12'`, in a heredoc
   fed to a shell or after a backslash-newline between their words; the comments of `scripts/lib/unsafe-git.mjs` name
   every such shape. A command word quoted, partly quoted or escaped may also hide any of the four: a push whose `git`
   or `push` is quoted or escaped, such as `"git" push` or `git "push"`, a draft whose `create` is quoted or whose `gh`
   is escaped, such as `gh pr "create"` or `\gh pr create`, and a ready or merge such as `\gh pr merge` or `gh pr
   "mer"ge`. Since the Claude Code card launch carries no `--disallowedTools`, no rule behind the guard refuses these
   forms there: at most auto mode's classifier judges them, and it guarantees nothing. It judges those four delivery
   forms alone: `gh pr edit --base`, `gh api` and every other GitHub write are not judged, and the git settings gh reads
   to choose a draft's head, `@{push}`,
   `branch.<branch>.pushRemote`, `remote.pushDefault`, `branch.<branch>.remote` and, under `push.default` upstream,
   `branch.<branch>.merge`, and, when the branch's push target is not at HEAD or there is none, any remote whose
   same-named branch is at HEAD, are not checked, though ready and merge refuse a pull request not from its own branch.
   Neither guard hook entry sets a timeout, and a Claude Code hook that times out does not block. The owner and the run
   post as one account, so the record rules stop an accident, not a determined workaround, as **Forgery** under
   **Advance approval** says. A withdrawal does not cancel an auto-merge a run has already queued.

### Herdr lead

Where fetched `main` settings hold `"herdr": true` as well as `"preApprovedRun": true`, a model-free program, the lead,
runs pre-approved runs one after another in a Herdr pane. It runs the fixed phases above with Claude sessions, adds no
phase rule and builds only the cards that hold an advance approval. It takes the place of the run session in step 3:
the lead mints each run's mark and starts every card session itself.

- **Start.** In a Herdr pane at the root checkout, run
  `node scripts/lead.mjs --login <login> [--model <name>] [--effort low|medium|high|xhigh|max] [--account <absolute directory>]`.
  The login is the GitHub account the owner's records are posted under. Model defaults to `opus`, effort to `medium`
  and account to the user's own Claude configuration. It runs on Linux only; Windows and the Mac follow on a later
  card. Without Linux, `/usr/bin/flock` or a reachable user service manager it exits 1 and names the missing piece.
- **Each pass.** The lead fetches `main` and requires both settings, before it reads anything from GitHub. It then
  reads the signed-in GitHub login and stops unless it equals `--login`, compared without regard to case. It reads the
  candidates under that login. With none it waits 300 seconds. Otherwise it mints a fresh mark for the pass, later
  than the previous one, and runs one pre-approved run under it. It checks both settings again before every session
  starts.
- **Running places and the cap.** A session runs only on a running place, taken before it starts. The cap is the
  `cap` of `${XDG_CONFIG_HOME:-~/.config}/fabraik/lead.json`: the file holds a JSON object whose `cap` is a whole number from 1 to 16, for example a cap of 2. It
  is 4 when the file is absent. Every lead on the machine shares it, and a file that holds anything else stops the lead
  and names the fault. A selection takes a place; a selected card keeps its place through its later sessions, and any
  other selection outcome frees it. The end session takes a place while it runs. With no place free and no phase work
  running, the pass ends and the lead tries again after 30 seconds.
- **The box.** Each session runs in its own systemd user unit, its box, named
  for its state folder, running place and phase. Nothing is restricted inside it: the session keeps the network, GitHub,
  SSH, Docker, `sudo`, screenshots, notifications and the keyring. The box exists so the lead can stop everything the
  session started and confirm the box empty. The session's command is sealed: it sees only the allowlisted variables
  of the lead's own environment (`HOME`, `USER`, `PATH`, the `XDG_*` folders, the session bus and SSH agent sockets,
  the display variables and `LC_*`), the run markers, the model, the effort, the account when one is set and
  `FABRAIK_LEAD_SESSION=1`. It carries no `ANTHROPIC_API_KEY`. The pane shows each session's reported model, effort
  and account.
- **A card that waits on the owner.** A card that ends `awaiting-push` or `parked` keeps its claim and its reservation
  and frees its place, so the lead moves on. A card that ends merged, failed, interrupted or stopped frees its place
  too. A place frees only once the stop proof for the card's last session is confirmed. With an unconfirmed stop the
  lead keeps the place, names the unit in the pane and in the failure item, and frees the place when that unit is no
  longer live. A restarted lead counts a box an earlier lead left running as held. At the stop the run writes the
  card's waiting line, its only write to the card itself.
- **An answered card.** Each pass, before it selects, the lead takes up a card it left waiting or parked that the
  owner has answered, with no new claim. The card must be open, hold no `Needs owner:` comment, be reserved by no live
  run of this lead and have its worktree here and clean at the head and identity its waiting line names. The lead
  starts a `continue` session for it, on a running place and in a results folder of its own, with the prompt
  `Continue this exact answered pre-approved job.`, a newline and the JSON of `card`, `runStart` and the answer.
  Continues take turns: the pass waits for the continue to end and then ends, so while it runs the lead starts no other
  continue and no run of its own, and the next pass starts at once. A continue whose stop is unconfirmed still runs
  until its unit is no longer live, which the lead checks every 30 seconds; one whose unconfirmed stop names no unit
  stops the lead. A continue relies on the admission its card passed in its own run, so it is not checked against
  another lead's work. The answer is one of three:
  - `yes`: the card is in `Awaiting push` and an approval record the owner posted after its waiting line is valid. The
    session delivers that version as section 8 says, checked against the head and identity the line names.
  - `changes`: the card is in `Backlog` and its newest `Returned:` comment is the owner's, for this machine and this
    exact job, and newer than the card's last edit. The session makes the changes the owner's words ask for, runs every
    check and review and ends at `Awaiting push`, so the card returns to the queue with a new waiting line for the
    owner's yes.
  - `fix-and-merge`: as `changes`, with a valid owner record posted after the card's `Changes asked:` line. The
    session makes the changes, runs every check and review and merges without coming back, and the lead tells the
    owner `Merged card <n> with your changes: <pull request title> <url>`. A failing check or review, or stop 10 under
    **Advance approval at push**, ends it at `Awaiting push` as `changes` does.

  A stale, replayed or other-account answer starts nothing. A returned card whose waiting or parked line still has an
  approving record, or whose worktree no longer matches its line, gets a failure item. A continue that fails, is
  interrupted or stops leaves a failure item, as a failed card does, and stops the lead.
- **A failed card.** The lead replaces `.claude/worklog/lead/<card>.json` in the root checkout with the card, the
  step (choosing it, planning, building or delivering), the cause and the absolute path of the session's stream log.
  The queue panel shows the item. A usage limit is an ordinary failure with no retry, and the card keeps its claim:
  the lead never comments, moves or closes a card. A card a pass ends with before its next step starts, such as a
  build that waits for a resource another card reserves, gets an item for that step and frees its place. Selecting the
  card again removes its item.
- **Stopping.** The lead exits 1 on a failure, a workflow stop or a stop signal, 2 on bad arguments and 3 when fetched
  `main` turns `preApprovedRun` or `herdr` off. Ctrl-C, SIGTERM and closing the pane stop the running session's box
  and record the session as interrupted; nothing new starts after the signal. With exit 3 the lead starts nothing
  more and keeps its evidence.
- **Evidence.** Each pass keeps its results folder, the session logs and the hook-event witness under
  `${XDG_STATE_HOME:-~/.local/state}/fabraik-lead/runs/`, beside `slots/` and `cap.lock`.
- **Known gap.** No guard covers a session that starts work through another launcher: it can call `systemd-run`, run
  `systemctl --user`, ask the service manager over D-Bus for a new unit, move itself in the control-group tree, start a
  container, use `sudo`, schedule work with `cron` or `at`, or have the desktop session launch a program. That work
  runs outside the box and the cap.
