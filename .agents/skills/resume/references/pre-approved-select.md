# Pre-approved selection

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

Read with [pre-approved-phase.md](pre-approved-phase.md) and [card-session.md](card-session.md).

Selection uses a separate session on Claude, or its bound native chat in the Codex app, with no
factory expiry and may select and claim one job only, without planning, building or delivery. A selected job immediately
retains its identity; until preparation establishes its scope, its unknown resources hold only a build that declares
exclusive resources. Among the candidates item 5 of [pre-approved-phase.md](pre-approved-phase.md) defines, in the order it gives them, the session picks the first. No card is sent to the owner and none is filed. A blocked candidate higher in `Ready` does not block an independent one below it. Exclude
other claimed jobs from selection.

When the selection's JSON context carries `card`, only that card is considered, and the session ends otherwise with
`Run result: stop none: card <N> is not eligible`.

The selection session performs the existing free, worktree and claim checks, states in one sentence that its pick is the first candidate in that order, saying which order item 5 gave and quoting the intake document's `Ready order:` line, and ends with `Run result: selected <card>` as its last line. It writes `<logs>.selected.json` with exactly
`runStart`, `card`, `claimUrl`, `priorClaimUrls`, `branch`, `worktree` and `base`.

Reconcile current jobs from status alone on open non-epic cards in `In progress`, `Awaiting push` or `In review`, and
from complete held-job comments, actual `job/<card>` worktrees and local reservations or reviewed references for cards
of any kind. Epic parents summarize child work; their explicit held `Job:` comments, actual worktrees and reviewed
references still bind regardless of kind. A historical claim or assignment alone on `Backlog` or `Ready` is not a
current job; keep the existing selection and ownership checks. A complete held-job comment is identified by first
trimming leading whitespace from the raw comment, then taking its first line by splitting at a carriage return or
newline and trimming the end of that line. The line starts `Needs owner:` and ends exactly
`Job: job/<same-card> on <machine>.`, where the machine has no whitespace. Later lines do not cancel it; `Returned:`
holds no job, and a question containing `Job:` without that suffix holds no job reservation. Read complete safety
evidence: an incomplete read is unavailable, not zero. Stop when no eligible candidate or active work remains.
