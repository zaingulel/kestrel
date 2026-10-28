# Sweep intake

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

Before work-pick, list the sweep-triage tasks and findings source reports with
`gh issue list --state open --author @me --limit 100 --json number,title,body`
in the same batch of reads. Count the raw array before identifying leads: exactly 100 results means incomplete
issue discovery, reported at work-pick, never a complete or empty result. Finish the batch before reconciliation
writes. Combine findings-source-title and task-marker leads from this listing with source-shaped reports and
task-marker entries in the already-complete board intake. Qualify those board leads even when they are absent
from the recent listing. A title or marker is only a lead: qualify each source through the owning local manual,
including its owner identity and readable required fields. A malformed or unavailable source-shaped report
receives no reconciliation writes and is excluded from candidate rows; report its unavailable qualification at
work-pick, never treat it as qualified or as an empty result.
Read the owner-authored final verdict on each qualified source report and on each qualified sweep source a task
marker cites, which may be a source pull request or source issue. Read the tasks that verdict lists, including
reused tasks. A marker alone, unrelated issue, wrong author, missing verdict or verdict omitting the task grants
no reconciliation.
For each verified task the verdict lists that is missing from the board, use
`node scripts/board-add.mjs <issue> Backlog <Workstream>`, with the valid Workstream from its body. Complete a
listed task's missing Workstream with the same operation and its existing Status, preserving that Status. For
each such task whose body still carries `Blocked by:`, create each link with
`gh issue edit <issue> --add-blocked-by <n>`, then remove the body line so the link is the only record.
Unqualified tasks are reported and receive no such writes.
Qualified source reports are evidence, never implementation tasks. If a report is absent from the board, use
`node scripts/board-add.mjs <issue> Backlog <Workstream>` with its valid routing line; if only routing is missing,
use its existing Status instead of Backlog. Preserve an existing Status and report unavailable fields rather
than guessing them. Exclude source reports from candidate rows whether triage is pending or complete, and show
that triage state separately using the owner-authored final verdict. Leave source reports open as evidence:
do not close, archive, delete or move them to Done. The routine has no board access.
