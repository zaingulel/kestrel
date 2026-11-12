---
description: This page is the reference for Azure Boards cards, which keep each card as a work item in one Azure DevOps project. It gives the setup, the credentials, the card commands and what each card step becomes.
---

# Azure Boards cards

Azure Boards cards are work items in one existing Azure DevOps project. Use this page to set up the project and to run
each card step where cards are Azure work items.

```sh title="Terminal"
node scripts/azure-card.mjs text {{AB_ID}}
```

The command prints the card's full title, native description, parent, `["blockedBy",[AB-IDs...]]` including closed
blockers, and complete native comments with their formats.

| Entry | What it covers |
|---|---|
| [Setup](#setup) | The steps that connect an Azure DevOps project |
| [Configuration](#configuration) | The `AZURE_CONFIG` keys init writes, and their limits |
| [Credentials](#credentials) | The private credential file, its token and who reads it |
| [Permissions by operation](#permissions-by-operation) | The access each operation needs |
| [Identity and complete reads](#identity-and-complete-reads) | How a card is named, and what a complete read is |
| [Card commands](#card-commands) | Each `azure-card.mjs` command and what it does |
| [Claims and withdrawal](#claims-and-withdrawal) | How a session claims a card and withdraws a claim |
| [Moving, filing and recovery](#moving-filing-and-recovery) | What the move and create commands do, and how to recover |
| [Workflow substitutions](#workflow-substitutions) | The Azure form of each GitHub card step |
| [Review snapshots](#review-snapshots) | How a review captures an Azure card |

## Setup

Choose `azure` at install; code, pull requests, reviews, checks and merges stay in the configured GitHub repository.
This manual owns Azure setup, native identity and the substitutions for card steps in skills and charters. Their owner
gates and runtime permission gates continue to apply.

The interfaces are [azure-config.mjs](../scripts/lib/azure-config.mjs),
[azure-api.mjs](../scripts/lib/azure-api.mjs), [board-azure.mjs](../scripts/lib/board-azure.mjs) and
[azure-card.mjs](../scripts/lib/azure-card.mjs). These contracts and synthetic workflows do not establish live Azure
acceptance. Token acquisition, native process permissions, server normalization of descriptions and actual writes
require separately authorized live evidence. Native operating-system compatibility requires receipts from that
platform; a simulated platform or synthetic provider response does not supply them.

1. Choose an existing organization and project. Obtain the project's universally unique identifier (UUID), enabled
   work-item types and their native states through an authenticated read-only client or the project administrator.
   Init creates no organization, project, process, type, state, field or relation type.
2. Map each kind and all six columns as [Configuration](#configuration) specifies. Ask the administrator to resolve
   incompatible process rules or required fields. Keep the project's actual names, including case.
3. Give init only those nonsecret mappings. Set up the private credential file under [Credentials](#credentials).
   Init validates the configuration without contacting Azure or asking for a token.
4. Run `node scripts/board.mjs --intake {{FOLDER}}`. Resolve native metadata, visibility or mapping refusals before
   work-pick. A successful read does not establish permission to create, assign, comment or move.

### Configuration

Init writes `TRACKER = "azure"` and `AZURE_CONFIG` in customer-owned `scripts/lib/board-config.mjs`. An answers file
puts the same object in `board.azure`, beside `tracker: "azure"`, `owner`, `ownerType` and `repository`. The last
three values identify GitHub code delivery. This illustrative mapping is complete, but its native names must exist
in the chosen project's process:

```js title="scripts/lib/board-config.mjs"
export const AZURE_CONFIG = {
  organization: 'example-org',
  project: '11111111-1111-4111-8111-111111111111',
  workItemTypes: { epic: 'Epic', feature: 'User Story', task: 'Task', bug: 'Bug', docs: 'Task' },
  states: {
    Epic: {
      Backlog: 'New', Ready: 'Ready', 'In progress': 'Active',
      'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed',
    },
    'User Story': {
      Backlog: 'New', Ready: 'Ready', 'In progress': 'Active',
      'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed',
    },
    Task: {
      Backlog: 'New', Ready: 'Ready', 'In progress': 'Active',
      'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed',
    },
    Bug: {
      Backlog: 'New', Ready: 'Ready', 'In progress': 'Active',
      'Awaiting push': 'Awaiting Push', 'In review': 'In Review', Done: 'Closed',
    },
  },
};
```

Every shown key is required; validation refuses extra keys at every level.

| Key | Value | Required | Limits |
|---|---|---|---|
| `organization` | The Azure DevOps organization | Yes | A 1-49 character slug of ASCII letters, digits and hyphens with alphanumeric ends, without a web-address prefix. It retains its supplied case |
| `project` | The project UUID | Yes | A hexadecimal UUID in 8-4-4-4-12 form. Validation canonicalizes it to lowercase |
| `workItemTypes` | One native type name for each kind | Yes | Exactly `epic`, `feature`, `task`, `bug` and `docs`; types may repeat |
| `states` | For each mapped type, the native state name of each column | Yes | Exactly one entry per distinct mapped type, and each entry maps all six columns to six distinct native state names |

Type and state names are nonblank strings of at most 255 UTF-16 code units, without ASCII or C1 control characters.

Runtime reads validate the exact project, enabled native types, state metadata and relation types. Done must map to a
state in the native Completed category; other columns cannot map to Completed or Removed. Unknown types or states
are mapping drift, never guessed completion. Every card carries exactly one configured `KIND_LABELS` value in
`System.Tags` and its configured native type; writes preserve unrelated tags. Missing or multiple kind tags are drift
and fail publication verification.

The GitHub project number, routing field and parked lane are null, and routing options are empty. Azure has no
Workstream or parked lane in this adapter. Documentation sweep, cloud card builds and direct-main documentation
delivery are unavailable; use the local pull request workflow. Answers omit `directDocs` or set it to `false`, and
omit `docSweep` or set it to `false`. Repeated init accepts only the exact generated Azure configuration; it does not
migrate hand-edited mappings. The `move-cards` command supports its existing Markdown-source migration only, not an
Azure migration.

## Credentials

Prefer a Microsoft Entra user access token. Obtain it outside Fabraik through the
[Azure CLI issuance procedure](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops),
using Azure DevOps resource `499b84ac-1321-427f-aa17-267ca6975798`. Keep token output in a private local provisioning
workflow. Fabraik neither signs in nor refreshes or caches tokens. Renew an expired token externally and replace the
private file before a deliberate retry. Entra uses the signed-in user's existing access.

For accounts that cannot use Entra, use a personal access token (PAT) restricted to the exact configured organization.
Its scopes are Work Items read/write (`vso.work_write`) and User Profile read (`vso.profile`). Code, Build, Graph and
administration scopes are unnecessary. Native project permissions and visibility still apply. The
[work-item update reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1)
and [profile reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/profile/profiles/get?view=azure-devops-rest-7.1)
define these scopes.

Use a private editor to save exactly these three nonblank, control-free string fields as JavaScript Object Notation
(JSON) in `~/.config/fabraik/azure.json`, replacing placeholders privately:

```json title="~/.config/fabraik/azure.json"
{"organization":"example-org","authentication":"entra","token":"{{ACCESS_TOKEN}}"}
```

`authentication` is exactly `entra` or `pat`; `organization` must exactly equal `AZURE_CONFIG.organization`.
`token` must have no leading or trailing whitespace. On Windows the location is
`%USERPROFILE%\.config\fabraik\azure.json`, under the actual home directory. The file must be
outside the repository, a regular file of at most 16 kibibytes, never a symbolic link or hard-linked file. On Linux
and macOS run `chmod 600 ~/.config/fabraik/azure.json`; the reader refuses group or other permission bits. On Windows,
restrict the file and user profile through access control lists by hand. The reader does not validate Windows access
control lists, and Unix mode bits cannot prove Windows privacy.

Only the isolated request helper reads the credential file. A session diagnoses its sanitized messages and never
reads, prints or copies that file. Credentials belong in neither answers nor board configuration, prompts, command
arguments, environment overrides, URLs, repository files, commits, pull requests or logs. If exposed, revoke or replace
the credential through its issuer and save the replacement privately.

The helper sends Entra Bearer or PAT Basic authentication only to constructed HTTPS destinations under
`dev.azure.com/{{ORGANIZATION}}` and to the single profile-me GET at
`https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1&details=true`. The helper refuses
redirects and arbitrary URLs. Relationship URLs supply checked identifiers, never a destination to fetch verbatim.
Requests travel through standard input, without shell evaluation or automatic retries. A sandbox must allow those two
hosts.

### Permissions by operation

| Operation | Required access and boundary |
|---|---|
| Project, type, state, relation and work-item reads | Access to the configured project and visibility of each relevant item; hidden items cannot be proved absent |
| Profile-me | User Profile read for the authenticated Azure DevOps profile UUID and principal |
| Create, edit, move, parent or block | Work Items read/write and native project/process permission; required fields and relation rules must be satisfiable |
| Assign or unassign | Native assignment permission and identity resolution; only the authenticated viewer may be assigned or unassigned |
| Add or edit comments | Native comment permission and visibility; edits are limited to the viewer's own comments |

## Identity and complete reads

Public card identifiers are `AB-1` through `AB-2147483647`, without leading zeros or `#`. Bare native numbers stay
inside the adapter. A card such as `AB-299` uses branch `job/AB-299`. The adapter compares assignees and comment
authors by native Azure DevOps identity UUID, never display name, email matching or an Entra object ID. Profile-me
establishes the viewer. Assignment submits the profile's exact nonblank email principal. Native validation must resolve
it to the same profile UUID before the actual write, and direct read-back must confirm that UUID.

Use `node scripts/board.mjs` for the pick view, `--json` for normalized data and `--closeout` for the strict scan. Use
`--intake {{FOLDER}}` for the intake summary and each card's full text in that folder. The normalized board exposes only
`openBlockers`; when verifying the exact blocker set, use the complete `blockedBy` row from `text`, including closed
blockers. An empty project is valid only after a complete successful read. Never report failed, permission-limited or
incomplete evidence as no cards, no claims or zero children.

Discovery uses a flat Work Item Query Language (WIQL) query for the exact project with no truncating top limit. Batch
reads use the same `asOf`, at most 200 identifiers each, and require the exact requested identity set. A native query
limit fails explicitly; it does not become a partial board. Direct card reads are fresh and validate identifier,
revision, project, native type/state, title, identity and relevant relationships.

A child points to its parent through `Hierarchy-Reverse`; a parent points to children through `Hierarchy-Forward`.
`Dependency-Reverse` points from a blocked item to its blocker; `Dependency-Forward` is not a blocker. Relevant
foreign-project targets, malformed or missing targets, duplicate identities and incomplete responses refuse evidence.
Complete child summaries and publication verification use the same completion rule: the configured Done state.

Comments retain their full native text, format, author, timestamps and identifiers. Reads follow every continuation
token and include explicit deleted-comment tombstones. Deleted comments cannot hold an active claim. Repeated cursors,
non-progress, inconsistent counts, ambiguous identifiers and failed later pages refuse completeness. Native HTML may
wrap `Claim:`; intake therefore requires complete native-comment review instead of claiming there is no claim.
Read HTML, Markdown and unknown legacy formats in full. No HTML parser strips tags or hidden link targets.

## Card commands

Invoke `node scripts/azure-card.mjs` with the arguments in this table. Usage errors exit 2 before provider work;
confirmed success or no-op exits 0. Runtime refusals are nonzero. The transport classifies throttling as exit 3 and
other provider failures as exit 1; callers may wrap a refusal in their own nonzero outcome. Inspect errors and required
read-backs before treating an operation as complete.

| Arguments after the script | Operation |
|---|---|
| `view {{AB_ID}}` | Complete state, assignee, viewer and native-comment evidence for the claim protocol |
| `view {{AB_ID}} --board` | Exact Azure board identity and mapped column for the free-card comparison |
| `text {{AB_ID}}` | Full title, native description, parent, `["blockedBy",[AB-IDs...]]` including closed blockers, and complete native comments with their formats |
| `children {{AB_ID}}` | `["children",[AB-IDs...]]`, `["total",n]` and `["completed",n]`; completion counts use the configured Done state |
| `assign {{AB_ID}}` / `unassign {{AB_ID}}` | Assign the viewer or remove the viewer's assignment; refuse another holder |
| `comment {{AB_ID}} --body-file {{FILE}}` | Post Markdown source and confirm the native comment |
| `edit-comment {{AB_ID}} {{COMMENT_ID}} --body-file {{FILE}}` | Edit only the viewer's native comment and confirm its text/version |
| `create --title {{TEXT}} --body-file {{FILE}} --status Backlog\|Ready --kind {{KIND}} [--parent {{AB_ID}}] [--blocked-by {{AB_ID}},...]` | Create a typed, tagged item with optional native parent/block relationships |
| `edit {{AB_ID}} [--title {{TEXT}}] [--body-file {{FILE}}]` | Edit at least one supplied field, with exact read-back |
| `parent {{AB_ID}} --to {{AB_ID}}` | Add a same-project native parent; refuse a different existing parent or self-reference |
| `block {{AB_ID}} --by {{AB_ID}}` | Add a same-project blocker; refuse self-reference |

Create accepts exactly `Backlog` or `Ready` for `--status`; move an existing card explicitly for later columns.
A complete `children` result has a total equal to its identifier count. Every child is Done only when `completed`
equals `total`; the command does not print individual child states.

The command checks identifiers, body files, and unknown or duplicate flags before provider calls. The five kinds are the
keys of `KIND_LABELS`. There are no arbitrary-field, impersonation, deletion or administrative commands. The command
stores body-file source, including Markdown punctuation, in an escaped literal `<pre>` description. It escapes `&`, `<`
and `>`, and retains the entire source. Reads label the native representation. Exact confirmation can fail if Azure
normalizes it; that is an unconfirmed write, not success. Comments use the native Markdown format and retain complete
native representations on read.

## Claims and withdrawal

Apply [resume's free-card and race rules](../.agents/skills/resume/references/claim-reads.md) with Azure evidence:

1. Read `view {{AB_ID}}`, `view {{AB_ID}} --board` and `text {{AB_ID}}` completely. Compare exact
   organization/project and mapped column with intake, and compare assignees and claim authors by native UUID. Inspect
   every complete native comment for an active `Claim:` despite HTML wrappers. Missing or incomplete evidence cannot
   establish free.
2. Move to In progress, assign the viewer and post `Claim: {{MACHINE}}, {{RUNTIME}}, {{TIME}}` through a body file,
   using resume's literal machine, runtime and time reads. Retain the returned native comment identifier and address.
3. Immediately reread complete card and native-comment evidence before any edit or dependency installation. Confirm
   the exact new claim and viewer assignment. Among new claims since the pre-claim read, the first in the native
   server's returned ascending sequence holds the card under resume's race rule. The adapter applies no local tie sort.
4. If another claim wins, edit only this session's comment by its native identifier to `Withdrawn: ...`, preserving
   resume's reason. Only when resume's existing withdrawal condition permits it, unassign. Keep another holder's
   assignment and the holder's In progress column. Follow resume for local cleanup and reporting.

Move, assignment and commenting are separate writes, not an atomic lock. When a later step fails, report each confirmed step.
If rereading cannot establish ownership, stop without a second claim or further changes. The adapter checks
comment ownership immediately before editing and confirms it after, but native comments supply no atomic
compare-and-swap promise. Never derive comment authorship from an email or display name.

## Moving, filing and recovery

`node scripts/board-move.mjs {{AB_ID}} "{{COLUMN}}"` explicitly moves to a mapped column. An already-confirmed target
is a no-op. `--batch {{AB_ID}}:{{COLUMN}} ...` stops at the first failure and names completed moves. `board-move`
refuses lane arguments; `board-add.mjs` directs filing to `azure-card.mjs create`.

Create and update use native `validateOnly=true` before the real request. Native process rules govern required fields
and relation cycles, without rule bypass or notification suppression. Updates begin with `test /rev` for the freshly
read revision. A conflict stops without retry. Read-back must confirm the same item/project, an advanced revision
and every intended field or relationship. A repeated relationship is a no-op only after complete direct evidence.

| Refusal or uncertainty | Recovery |
|---|---|
| Missing/private-file failure or organization mismatch | Correct the private file without revealing its contents |
| 401 / 403 | Renew the token externally or resolve project/operation permission; successful reads do not prove writes |
| Type/state drift or unsatisfied native rules | Have the administrator reconcile the process or mappings; init does no native repair |
| Missing items, comments, related targets or query-limit failure | Restore complete evidence before claiming, publication verification, parent closeout or cleanup |
| 429 throttling | Honor the reported Retry-After before a deliberate later attempt; no automatic retry was sent |
| Revision conflict | Reread and reassess the intended change before a deliberate new operation |
| Timeout, ambiguous response or failed exact read-back | Inspect the native item/comment first; outcome is unknown or unconfirmed, never safe to repeat blindly |
| Known created AB-ID with later failure | Keep that identifier, inspect the item and finish remaining work without another create |
| Unknown create outcome | Inspect the configured project for the intended title/item before any deliberate retry; no idempotency guarantee is implied |

## Workflow substitutions

Wherever a skill names a GitHub card step, use this table. The authoritative skills retain every approval, review,
publication and cleanup gate.

| Step | Azure action |
|---|---|
| Intake and card context | `board.mjs --intake {{FOLDER}}`, then `azure-card.mjs text {{AB_ID}}`; review complete native comments |
| Claim command (`resume`, "3. Start the job") | `node scripts/board-claim.mjs` serves only the GitHub Projects tracker and refuses an Azure install with exit 1. This tracker claims by hand as [the claim reads](../.agents/skills/resume/references/claim-reads.md) say, with the rows of this table |
| Free-card, assignment, claim or withdrawal | The complete reads and native-UUID protocol in [Claims and withdrawal](#claims-and-withdrawal) |
| Awaiting push | `board-move.mjs {{AB_ID}} "Awaiting push"` before requesting push authorization |
| Verdict and Stage 2 evidence (`resume`, "7. Push authorisation") | Post with `azure-card.mjs comment {{AB_ID}} --body-file {{FILE}}`. Read with `node scripts/board.mjs --all`, then `azure-card.mjs text {{AB_ID}}` for each card it lists, one call per card, reviewing complete native comments. Compare authorship with the viewer evidence of `azure-card.mjs view {{AB_ID}}`. A comment whose native text wraps `Verdict:` counts as not matching the form. An approved push is a card in Done on that listing. A failed read leaves the first two measures not measurable, naming the card. The share of suggested cards accepted reads with `node scripts/board.mjs --all --json` and the same `text` calls, applying the same title test and finding the line contained in the description, and gives those counts as the cards it could read, with the share itself `not measurable: a card a board read leaves out is not counted`; a failed read leaves no counts, naming the card |
| Closing line and branch | `job/{{AB_ID}}` and both standalone body lines that follow this table; always the pull request route |
| Draft opened | Keep the card's current explicit column; draft creation does not move it to In review |
| Pull request marked ready | When the pull request is marked ready, explicitly run `board-move.mjs {{AB_ID}} "In review"` |
| Handoff | `board-move.mjs {{AB_ID}} Ready` after handoff's existing publication steps |
| File or fold approved work | `azure-card.mjs create` or `edit`; preserve metadata and native relationships on a fold |
| Suggested card (`resume`, "2. Work-pick") | File with `azure-card.mjs create --title 'Proposed: {{TITLE}}' --body-file {{FILE}} --status Backlog --kind {{KIND}}`. A yes is `azure-card.mjs edit {{AB_ID}} --title '{{TITLE_WITHOUT_PREFIX}}'`. A no is `board-move.mjs {{AB_ID}} Done`, keeping the title |
| Parent or blocker | `azure-card.mjs parent` or `block`; reread `parent` and the complete `blockedBy` row through `text`, including closed blockers |
| Verify filing | `node scripts/verify-issue-publish.mjs {{AB_ID}} [{{CHILD_AB_ID}} ...]`; exact kind/type/status, parent and supplied complete direct-child set |
| Completion or review comment | `azure-card.mjs comment {{AB_ID}} --body-file {{FILE}}`; edit only the viewer's own comment |
| Backlog or another explicit column | `board-move.mjs {{AB_ID}} "{{COLUMN}}"` |
| Merge closeout | Confirm the authorized pull request merged, explicitly move its Azure card to Done, then run `board.mjs --closeout` |
| Parent closeout | `azure-card.mjs children {{AB_ID}}` must return complete child identities with `completed` equal to `total` before explicitly moving the parent to Done |
| Deferred cleanup | No Azure pending-record mechanism; report retained targets under closeout's existing non-GitHub scope |
| Leftover card state and claim | Complete `view` and `text` reads, including native claim comments |
| Leftover open-card text search | Unavailable; no Azure card-text search command exists. Unavailable evidence cannot authorize deletion |
| Cloud card builds and documentation sweep | Unavailable; use the local workflow |

The pull request body for illustrative card `AB-299` includes these two standalone lines, using the exact configured
organization, project UUID and native item number:

```text title="Pull request body"
Closes AB-299
Azure Boards: https://dev.azure.com/example-org/11111111-1111-4111-8111-111111111111/_workitems/edit/299
```

Delivery recognition requires both head and base in the configured GitHub repository, base `main`, exact head
`job/AB-299` and both exact standalone lines. Open pull requests, including drafts, and merged pull requests qualify;
forks, other bases, closed-unmerged pulls and incidental mentions do not. `Closes AB-299` does not close an Azure item
through GitHub. Never substitute `Closes #299` or assume Azure automation moved it.

Merge-before-Done and complete-children-before-parent-Done remain agent instructions; `board-move.mjs` does not supply
a standalone merge or parent-closeout guard. A publication check without supplied child identifiers does not assert
zero children. When the change resolved an item that the approved body does not name, report it instead of closing it
unasked. An incomplete child read stops the parent transition.

### Review snapshots

Before an architect, reviewer or cross-review captures an Azure card, read this manual. Then run
`node scripts/azure-card.mjs text {{AB_ID}}` in place of every `gh issue view` card capture. Preserve the review
route's existing output file and redirection, including appended prompts and plan-review fallback snapshots. Include
the entire native description and every native comment with format and author identity; unavailable content is a stop,
never an empty snapshot. The read-only snapshot grants no write authority or permission to expose credentials.

## Where to go next

- [Setup](#setup) connects an Azure DevOps project before the first card.
- [The resume skill](../.agents/skills/resume/SKILL.md) picks a card and starts its job.
- [The board](AI-WORKFLOW-board.md) explains what each column means and how the board tools read and move cards.
- [The issue tracker page](ISSUE-TRACKER.md) names the repository's tracker and how an issue joins the board.
