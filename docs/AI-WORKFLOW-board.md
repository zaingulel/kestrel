# The board

Planned work lives on one board, read and moved by a small toolkit of scripts so that a card's column and its issue
cannot drift apart unnoticed. This page explains the columns, the toolkit, the board's own automation and how the
toolkit serves another board. This page is part of [the workflow guide](AI-WORKFLOW.md). Related:
[The life of one change](AI-WORKFLOW-job.md) for when a card moves, and
[Enforced or instructed](AI-WORKFLOW-enforcement.md) for what is automated and what is instructed.

## Mental model

The six columns read as four stages, the shape any GitHub Project reader can copy onto their own board:

| Stage | Columns |
|---|---|
| To-Do | Backlog, Ready |
| Active | In progress, In review |
| Wait | Awaiting push |
| Done | Done |

## How it works

The board is a GitHub Project with six columns: Backlog, Ready, In progress, Awaiting push, In review, Done.
Ready means startable in the next session with no missing owner decision, external dependency, or scheduled
date. Awaiting push is the gap between local review passing and push authorisation, before any push has
happened: a card there has legitimately produced no pull request yet.

### Reading and moving cards

[`scripts/board.mjs`](../scripts/board.mjs) lists the board and, from the same read, reports a card whose column
disagrees with its issue; closeout runs it in its strict mode, and resume intake runs it in its intake mode, which
adds the full details of every pickable card and every claimed card with no closing pull request and marks whatever
it could not read as unavailable. [`scripts/board-move.mjs`](../scripts/board-move.mjs) moves a card and, on a board
with a parked lane, parks a card in that lane or releases it; on a board with no parked lane it refuses that request
before making any `gh` call. The head of each script owns its modes and argument forms.

`lookupIssueBoardItem` in [`scripts/lib/board-move.mjs`](../scripts/lib/board-move.mjs) supplies one guarded
issue-side read to `moveCards`, `addIssueToBoard` and the publication verifier's missing-card check. It reads up to
20 project items and checks completeness and readable item data before returning the issue id and the configured
project's item, or `item: null` for a complete nonmatching reply. A failed, malformed or truncated read cannot establish
absence. Move retains that cause rather than giving the add-card advice reserved for a complete absent reply; its
current-field read still lets it skip redundant writes and already-clear lanes.

Add uses the shared read's issue id but still sends the idempotent add mutation even when the read found a card. The
mutation's returned item id determines the target of the separate Status and configured routing-field writes. If a
field update fails, add rereads the fields and reports their observed values, or an unknown outcome when that reread
fails, with a safe whole-command retry. The publication verifier uses the shared item, its archive flag and its card
fields only when the board read lacks a requested card: a closed archived card is checked from that item like a
listed one, and the lagging, open-archived and confirmed-absence diagnoses stay distinct.

### The toolkit in another repository

The toolkit copies unchanged into another repository, exactly the files that `TOOLKIT_LIB` and `CLI_ENTRY_POINTS` name in
[`scripts/lib/board-toolkit-copy.mjs`](../scripts/lib/board-toolkit-copy.mjs). Only `scripts/lib/board-config.mjs` differs.
It holds the repository's own board values, and three of its settings let the copy serve a different kind of board: who
owns the project, a user or an organisation; which field routes a card, or none on a board that tracks Status alone; and
a lane that parks a card. A parked card keeps its column but is left out of the pick view, which lists it on its own
`Parked (<field>: <option>), not pickable:` line instead. A parked card in an in-flight column is not reported as a
claim with no closing pull request, since it waits on an answer from outside the session, while the blocked, unassigned
and epic checks still judge it. The board script's JSON output carries `parked` on every card, `false` on a board with
no parked lane. [`scripts/lib/board-config.mjs`](../scripts/lib/board-config.mjs) owns each setting's name, the values
it takes and what each value changes.

Every `gh` call the toolkit makes runs through one command prefix that the `BOARD_TOOLKIT_GH` environment variable can
replace. The gh-calling tests reach their stand-in through it (`scripts/lib/fake-gh.mjs` sets it), never through PATH,
because on Windows `execFile("gh")` runs only `gh.exe` and an extensionless stand-in on PATH would be skipped in favour
of live GitHub. [`scripts/lib/gh-exec.mjs`](../scripts/lib/gh-exec.mjs) owns the variable's format, its default and what
a malformed value does.

### Cards as files

A repository that works alone can keep its cards as Markdown files in the repository instead of on a GitHub Project: one
file per card at `.agents/cards/<N>.md`, chosen at install by the `TRACKER` line in
[`scripts/lib/board-config.mjs`](../scripts/lib/board-config.mjs). The same scripts read and move them, and the board
shows the same six columns, but only three are stored in a file: Backlog, Ready and Done. The other three are worked
out from the repository: an open pull request from the card's `job/<N>` branch is In review, a job branch holding the
closing edit is Awaiting push, and any other job branch, local or on origin, is In progress. The branch is the claim,
which is why this suits one person: two people or machines see each other's claim only after a push. A team chooses the
GitHub board. [`docs/MARKDOWN-CARDS.md`](MARKDOWN-CARDS.md) owns the file format, the derived columns and what each card
step becomes. A repository that outgrows markdown cards moves them onto a GitHub board with one installer command,
which [that page](MARKDOWN-CARDS.md#moving-to-a-github-board) describes.

### Cards in Linear

A team that plans in Linear can keep its cards as the issues of one Linear team instead, chosen at install by the
`TRACKER = "linear"` line and the `LINEAR_TEAM` key in [`scripts/lib/board-config.mjs`](../scripts/lib/board-config.mjs).
The same scripts read and move them and the board shows the same six columns, each mapped to a state of the Linear team.
A card is named by its Linear issue ID, such as `ENG-123`, which also names its `job/ENG-123` branch and the
`Closes ENG-123` line of its pull request. Linear's own pull request automation moves a card to In Review when the draft
is marked ready and to Done on merge, so the workflow writes only the earlier columns and checks the later two. The
board tools reach Linear with a personal key kept in a private file on the machine, and never in a repository, a log or
a cloud environment. [`docs/LINEAR-CARDS.md`](LINEAR-CARDS.md) owns the team and key setup and what each card step
becomes.

### Cards in Jira

A team that plans in Jira Cloud can keep cards in one existing project, chosen by `TRACKER = "jira"` and
`JIRA_CONFIG` in [board-config.mjs](../scripts/lib/board-config.mjs). The six columns map to native status IDs and
moves use explicit available transitions with direct read-back. Unlike Linear's automation, the agent explicitly moves
a Jira card after marking its pull request ready and after confirming merge. A card key such as `ENG-2` names both
`job/ENG-2` and the standalone `Closes ENG-2` pull request line; the pull request route always applies.

Account IDs identify assignees and claim authors. A private file supplies classic personal API-token authentication
only to the configured tenant. The adapter has no Workstream, parked lane, cloud card build or documentation sweep.
[Jira cards](JIRA-CARDS.md) owns setup, native permissions, complete evidence, failure recovery and every workflow
substitution, including the agent's complete-child proof before moving a parent to Done. These closeout instructions
are distinct from the status-write checks in the command.

### Cards in Azure Boards

A team that plans in Azure Boards can use one existing project, chosen by `TRACKER = "azure"` and `AZURE_CONFIG`
in [board-config.mjs](../scripts/lib/board-config.mjs). Each distinct configured native type maps all six columns to
native states. Init validates the nonsecret mapping without contacting Azure; runtime reads validate the project,
types, states and relationships. A public card such as `AB-299` names `job/AB-299`; its GitHub pull request binds
that identifier to the exact organization and project through two standalone body lines.

Native identity UUIDs identify assignees and claim authors. Full native comments retain their format, including HTML
that can wrap a claim, so an agent reads them completely before claiming. A private credential file supplies an
externally provisioned Entra token or organization-scoped personal access token. The agent explicitly moves In review
after marking the pull request ready and Done after confirming merge. Azure has no Workstream, parked lane, cloud
card build, direct-main documentation route or documentation sweep in this adapter.
[Azure Boards cards](AZURE-CARDS.md) owns setup, command forms, permissions, complete evidence, write recovery and
workflow substitutions, including complete direct-child evidence before moving a parent to Done. Synthetic workflows
prove composition; live Azure writes and native platform compatibility need their own executed evidence.

### The board's own automation

The project's Workflows page (the workflow icon in the project header, not the Settings sidebar) carries the
board's own automation, so no agent moves a card for these cases:

| Workflow | State | Setting | Why |
|---|---|---|---|
| Auto-add to project | On | `is:issue is:open` on this repository | A new issue is visible on the board before anyone triages it by hand |
| Item added to project | On | Status: Backlog | A card added by automation lands in Backlog, the same column `to-issues` and `resume` add to |
| Auto-add sub-issues to project | Off | | Cross-repository sub-issues would join this board, but the scripts cannot read them; this repository's epic slices already arrive through Auto-add to project |
| Item closed | On | Status: Done | The terminal move to Done happens without an agent or network access at merge time; `moveCards` reads it back and skips its own write when this already ran |
| Auto-archive items | On | `is:issue,pr is:closed updated:<@today-2w` | Keeps the active board small; a Done card is archived, never deleted, so history stays intact |
| Pull request linked to issue | Off | | Awaiting push and In review are `resume`'s calls, tied to push authorisation and the draft actually opening, not merely a link existing |
| Pull request merged | Off | | The issue's own close, through the pull request's `Closes #` line, already triggers Item closed |
| Item reopened | Off | | A reopen is the Returned quality signal the session records deliberately; an automatic reversion would fight the Awaiting-push/In-review sequencing |
| Code changes requested | Off | | Review state is tracked by the `resume` skill's own evidence bar (fresh review, the external review where required), not by the board |
| Code review approved | Off | | The same evidence bar as Code changes requested |
| Auto-close issue | Off | | Closing an issue follows the pull request's `Closes #` line, never inferred from a card's column |

### Proposals from the weekly retro

The weekly retro, in a repository that runs it, reaches the board the same way: it files proposal cards, the board's own
auto-add lands each in Backlog, and the next local session fills its routing value. It proposes and never edits, because
the fix for a recurring problem is a decision: the owner picks the card or closes it.
[`docs/WEEKLY-RETRO.md`](WEEKLY-RETRO.md) owns what the retro reads, how many proposals it may file and how each is
titled.

## Where the rules live

- [`docs/ISSUE-TRACKER.md`](ISSUE-TRACKER.md): the repository's tracker, how an issue joins the board, its routing
  convention and its labels.
- [`scripts/lib/board-config.mjs`](../scripts/lib/board-config.mjs): the repository's own board values, and the settings
  that let the scripts serve another board.
- [`docs/MARKDOWN-CARDS.md`](MARKDOWN-CARDS.md): the card format and the card steps where cards are files.
- [`docs/LINEAR-CARDS.md`](LINEAR-CARDS.md): the Linear team and key setup and the card steps where cards are Linear
  issues.
- [`docs/JIRA-CARDS.md`](JIRA-CARDS.md): Jira configuration, private credentials and card workflow substitutions.
- [`docs/AZURE-CARDS.md`](AZURE-CARDS.md): Azure project mappings, private credentials and native card workflow substitutions.
- The heads of [`scripts/board.mjs`](../scripts/board.mjs), [`scripts/board-add.mjs`](../scripts/board-add.mjs) and
  [`scripts/board-move.mjs`](../scripts/board-move.mjs): each script's modes and argument forms.
- [`scripts/lib/gh-exec.mjs`](../scripts/lib/gh-exec.mjs): the `BOARD_TOOLKIT_GH` contract.
- [The `resume` skill](../.agents/skills/resume/SKILL.md): when a session moves a card, and the candidate table the
  owner picks from.
- [The `closeout` skill](../.agents/skills/closeout/SKILL.md): the strict board check after a merge.
- [The `to-issues` skill](../.agents/skills/to-issues/SKILL.md): how new cards are proposed and filed.
- [`docs/WEEKLY-RETRO.md`](WEEKLY-RETRO.md): the weekly retro.

## Failure modes

- **A card's column disagrees with its issue.** For an issue's open-or-closed state, the scan reports a closed issue
  whose card is not in Done and an open issue whose card is in Done. An open issue whose closing pull request has merged
  is a reopen, not shipped work: it is judged by its open state and its column like any other open issue, never reported
  as shipped.
- **Automation adds a card with no routing value.** On a board with a routing field, a card that automation adds has no
  routing value; `scripts/board.mjs` reports it until the board-add script fills the field on the existing card, the
  value chosen by the convention in [`docs/ISSUE-TRACKER.md`](ISSUE-TRACKER.md).
- **Auto-add is off.** A board copied from another starts with Auto-add off; where it is off, every issue joins the
  board through the board-add script. [The head of `scripts/board-add.mjs`](../scripts/board-add.mjs) owns the
  invocation.

## Key files

- `scripts/board.mjs`, `scripts/board-add.mjs` and `scripts/board-move.mjs`: list the board, add a card, move a card.
- `scripts/verify-issue-publish.mjs`: checks a published issue.
- `scripts/lib/board-config.mjs`: the one file that differs between repositories.
- `scripts/lib/board-markdown.mjs`: the reader and mover for cards kept as files.
- `scripts/lib/board-jira.mjs`, `scripts/lib/jira-card.mjs` and `scripts/lib/jira-api.mjs`: native Jira reads, card operations and credential custody.
- `scripts/lib/board-azure.mjs`, `scripts/lib/azure-card.mjs` and `scripts/lib/azure-api.mjs`: native Azure reads, revision-checked operations and credential custody.
- `scripts/lib/board-toolkit-copy.mjs`: the test support that loads the board toolkit from a copy with a fixed
  configuration, so no shipped board test reads an install's own `board-config.mjs`.
- `scripts/lib/gh-exec.mjs`: the one route every `gh` call takes.
- `scripts/lib/fake-gh.mjs`: the stand-in the tests reach through `BOARD_TOOLKIT_GH`.
- `docs/ISSUE-TRACKER.md`: the tracker conventions.
