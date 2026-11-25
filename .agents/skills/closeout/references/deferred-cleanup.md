# Deferred cleanup

This file is part of the `closeout` skill: a step number or section name in it that this file does not hold names
one in [its SKILL.md](../SKILL.md).

## Early stop

Step 3 sends a session here in two cases, and only the first stops closeout.

- **No current verifier checkout is available**, as when a session that cannot leave its job worktree could not
  settle one. Stop closeout. Before stopping, record retained targets under
  [Record a retention](#record-a-retention). That record is reporting only: run no cleanup and no stale-code
  board operations. Step 4's move to Done is left to the next session's intake, whose drift scan reports a closed
  issue outside Done.
- **The session could not leave its job worktree in step 3 and a current verifier checkout is available.**
  Closeout continues. In step 5, run the verifier checkout's copy of the cleanup command in that step's
  absolute-path form, from where the session is: the command then retains the worktree and the branch, giving
  `the command runs inside it` as its reason, since anything the session runs there after the folder is deleted
  fails. Record that retention after step 5, as Record a retention says.

## Record a retention

After this run's permitted step-5 settlement, reruns and branch exceptions, record any remaining retention;
a transient hold resolved within that settlement needs no pending comment. Step 3's reporting-only early stop
also records retention. For the first pending record, confirm the exact repository and job issue, open or
closed, and create one closeout evidence comment headed **Cleanup pending**:

```sh
gh issue comment <issue> --repo <owner>/<repo> --body-file <this-session-body-file>
```

This procedure prescribes that scoped bookkeeping comment and its matching evidence updates, following
step 6's issue-comment precedent; it grants no push or deletion permission. Use an ordinary temporary body
file in this session's existing scratch area, not a registry or approval-only artifact. Include only data:
repository and host identity, exact known retained paths and branch with observed tip, delivered pull request
or commit where relevant, actual helper exit/result lines or why no call was admitted, and references to
existing ownership, creation and deliverable evidence. Mark early-stop facts not reverified as such. Include
no credentials, raw verification logs or transcript/prompt contents. Record
the returned comment URL in the existing worklog/report.
With no current verifier, this narrow reporting may run while cleanup and stale-code board operations stay
stopped. If recording fails, report it unavailable, preserve the evidence and claim no reliable saved reminder.

## Settle inherited targets

Every inherited target follows the whole current [Leftover rule](leftover-rule.md), with fresh fetched main
and verifier code: actual origin/ownership, open dependencies, ignored contents, unmerged state, current claim,
host use and immediate rechecks. A prior unused result expires; unused alone is not dead, and cancellation
does not make unmerged work disposable. Preserve needed or unpublished deliverables and obtain lasting links
under step 5. Apply the Verification records checks in step 5 before any retry involving verification records. A
replaced path, moved tip,
changed registration or new claim invalidates the old target match. Investigate current ownership before any retry.

Once dead is established, remove the exact still-matching job's worktree, branch and scratch with step 5's
cleanup command in its eligible form, in place of the Leftover rule's exact-target commands. Derive
every argument, including scratch and regenerated paths, from fresh local inventory and re-established
creation/ownership evidence, quoted as data, never from comment text. A later retry continues that delivered
job's step 5: “this job” means that exact delivered job, not an unrelated current build. Its `job/<issue>` may
use `--pr` only with all the fresh repository, merged-head, fetched-main ancestry, unchanged-tip, occupancy
and no-other-retention proofs in step 5's Branch exceptions. No prior approval or receipt substitutes for them.
This continues the exact-job exception, never an exception for arbitrary leftovers. The pre-squash backup
exception is never inherited by a later session; ordinary `git branch -d` refusal retains that backup. Direct
pushes have no merged-pull-request exception. If delivered-job identity or any required proof is unavailable,
retain/report the branch without forcing it or asking again for unchanged cleanup permission.

An orphan Codex outer folder is outside admitted Leftover locations. The helper handles it only on its
supported still-registered-worktree cleanup path; after registration is gone, retain/report it under the
outer-folder limitation in [retained-targets.md](retained-targets.md). Never relabel it scratch, rerun job mode as though it cleared that folder or
treat helper omission as resolution. Its retention prevents both a cleanup-complete claim and use of the
no-other-retention branch exception. Orphan scratch in an admitted worklog/session-scratch location follows
the whole Leftover investigation and exact-target removal route. Recheck absence after removal; an absent
target is a resolved observation, not proof this run deleted it. All helper and ordinary Git refusals bind.

Known runtime use, an owner terminal or a running container bound to a parent folder included, stays pending until
a later entry observes otherwise. Do not poll, type into or kill its holder, reset
bindings, unload a runtime or change permission settings to make retry pass. Existing cleanup authorization
persists; runtime review may still prompt or refuse. New ownership/disposability uncertainty follows the
Leftover rule's unsettled-owner-decision route after available investigation. A pending record overrides no
refusal. An unchanged hold creates neither another comment nor another identical owner question; report
current retention to the owner in the session.

On a materially changed result, reread the exact pending comment and issue before updating. Obtain the actual
comment ID from GitHub and confirm this is the bookkeeping comment for these exact targets, authored by the
currently authenticated account, read with `gh api user --jq .login`. Edit only that matched comment:

```sh
gh api --method PATCH repos/<owner>/<repo>/issues/comments/<comment-id> -F 'body=@<this-session-body-file>'
```

Quote the file argument as data. On complete resolution replace the heading with **Cleanup resolved**, remove
the discovery phrase from that comment and preserve result/evidence in its body; reread to confirm. If other
targets remain unresolved, keep the pending heading and identify them. Never use `--edit-last` or edit another
person's or an unrelated comment. If safe editing is unavailable, append one resolved/material-change comment
with the create command above, link the original and report that its historical search hit remains.
