# Pre-approved phase sessions

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

Every session a pre-approved run starts with a fixed phase prompt reads this file and [card-session.md](card-session.md)
whole, with the files its first line names here, and reads any other run reference, whole, only once it reaches a rule
these files say that reference holds.

| First line | Also reads |
|---|---|
| Select and claim one eligible pre-approved job. Do not plan, build, or deliver. | [pre-approved-select.md](pre-approved-select.md) |
| Prepare this exact pre-approved job. Do not build or deliver. | [pre-approved-prepare.md](pre-approved-prepare.md) |
| Build and verify this exact prepared job. Do not publish or deliver. | no other file |
| Deliver this exact built job. Do not select or build another job. | [pre-approved-deliver.md](pre-approved-deliver.md) |
| Continue this exact pre-approved sidebar job. | [pre-approved-sidebar.md](pre-approved-sidebar.md), [pre-approved-deliver.md](pre-approved-deliver.md) |

Items keep the pre-approved run's numbers in [pre-approved-run.md](pre-approved-run.md). A bare step number in these
files names one of the run's shared steps: steps 6 and 7 and step 3's probes are in card-session.md, and steps 3, 8 and 9
in [runs.md](runs.md).

2. **The setting** is `waitForOwner`, read from fetched `main` as
   [merge-on-evidence.md](merge-on-evidence.md) says under **The level**: the run is on only where it reads
   `on-screen` or `when-needed` and where cards are GitHub issues. Check it before starting a pre-approved
   card session. The guard checks it again at each marked publication. `always`, which an absent file or key also means, disables the run and leaves every card waiting for the
   owner's yes; a settings file still
   holding the retired run setting, an unreadable fetched-main object, a nonregular settings entry or invalid
   settings makes the setting unavailable. On refusal stop: confirm the owner's level on `main` if it is
   `always`, or fetch origin and verify `.agents/factory-settings.json` on `main` if unavailable, then retry. Taking its own job pull request back to draft with `ready --undo` remains available either way.
3. **The launch probes** are step 3's. Each Codex session's push probe is
   `git push --dry-run ./.pre-approved-run-no-remote HEAD`. The native app coordinator ends the run unless the
   observed tool results show both `Command blocked by PreToolUse hook: Blocked: git commit` and
   `Command blocked by PreToolUse hook: Blocked: a pre-approved run session`. Each Claude Code card session makes the
   hook check under "Before intake", then runs `git push --dry-run ./.pre-approved-run-no-remote HEAD` as one plain
   command on its own, and stops unless the guard refuses it with a reason beginning `a pre-approved run session`.
5. **Shared phase rules.** A build never waits on another job's files: the hold of "2. Work-pick" for a card whose files overlap a running
   job's applies only where a person or the coordinator picks the cards. The candidates are the `Ready` cards of "2.
   Work-pick" startable now, in either form, that are open and not titled `Proposed: `; no separate check runs. A
   `Backlog` card is never a candidate. The candidates stand in the order the intake document gives `Ready`, which its `Ready order:` line states, or by card number where that line calls any `Ready` card's place unknown. They are read afresh for each selection, so a reorder while a card builds changes only which card comes after it. Keep
   the plan and review evidence at their normal job-local paths. For a known card, `<jobBase>` is the absolute
   `<results-folder>/job-<card>` and `<phase-log-base>` is `<jobBase>-prepare`, `<jobBase>-build` or
   `<jobBase>-deliver`.

   **Shared prepared evidence.** The descriptor `<jobBase>.prepared.json` has exactly `runStart`, `card`, `claimUrl`,
   `priorClaimUrls`, `branch`, `worktree`, `base`, `planPath`, `planHash`, `plannedFiles`, `prerequisites` and
   `exclusiveResources`. The card is a positive safe integer in the origin repository;
   prerequisites name repository and issue number; resources are stable non-secret labels, explicitly empty only when
   none are needed. The required plan review covers the final plan and descriptor. The accepted record
   `<jobBase>.reviewed.json` has exactly `runStart`, `card`, `claimUrl`, `descriptorPath`, `descriptorHash`, `planPath`,
   `planHash`, `reviewEvidencePath`, `reviewEvidenceHash` and `verdict` set to `accepted`. The descriptor path is the
   paired `<jobBase>.prepared.json`, and `reviewRecordPath` names its paired `<jobBase>.reviewed.json`; retain the review
   evidence and hash the actual descriptor, plan and evidence bytes. Preparation alone grants no build authority.

   **Fixed phases.** The rules below in this item apply to the native Codex app route.

   A selected job continues by its stored identity, never by repicking or reclaiming. Follow "4. Plan" and "6. Verify
   and review" for the required independent reviews. The preparation job launches the plan reviewer and settles its
   findings and required follow-up. The build job launches the final reviewer and settles its findings and required
   follow-up before returning `built`. Each job keeps its working plan, diff and detailed findings in its own session
   and returns a compact phase result and settled verdict with exact references to saved evidence.

   Build and delivery use exactly `phase`, `runStart`, `card`, `claimUrl`, `priorClaimUrls`, `branch`, `worktree`, `base`,
   `descriptorPath`, `descriptorHash`, `planHash` and `reviewRecordPath`, with phase `build` or `deliver`. Reject extra
   fields, including a supplied timestamp or timeout. Keep root working directory and guard probes before entering the
   verified worktree. Continue only the expected phase of the same job while its exact claim, assignment, card,
   worktree, review and prerequisites remain valid. Accept only the matching phase and card result: `prepared` for
   preparation, `built` for build, and `merged` or `built` for owner-waiting delivery; parked and stop remain stops or
   parks. A mismatched result never advances authority.

   Re-read the exact authoritative initial claim before each phase; missing, invalid, withdrawn or replaced claims
   refuse, and its original `createdAt` must stay unchanged. Claim age sets no expiry and a new claim never substitutes
   for the selected identity. A native tool timeout, refusal or incomplete result stops advancement. A native tool
   timeout or interruption retains the job's identity and resource reservation even when a targeted stop appears
   successful, because detached tools may still run. Resolve remaining activity before restarting or releasing it;
   never assume a native tool timeout delivered SIGINT or SIGTERM. Account other active jobs safely; unavailable
   cancellation safety facts hold new admissions and deliveries.
6. **The job** is step 6's. Suggested cards are listed in the final message as step 6 says and never filed. Overlap
   with `main` or with another job never holds a build or a delivery, and each job settles it when it merges. A
   question mid-job parks the job as step 7 says.
