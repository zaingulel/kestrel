# Azure Boards cards

Azure Boards cards are work items in one existing Azure DevOps project. Choose `azure` at install; code, pull
requests, reviews, checks and merges stay in the configured GitHub repository. This manual owns Azure setup, native
identity and the substitutions for card steps in skills and charters. Their owner gates and runtime permission gates
continue to apply.

The interfaces are [azure-config.mjs](../scripts/lib/azure-config.mjs),
[azure-api.mjs](../scripts/lib/azure-api.mjs), [board-azure.mjs](../scripts/lib/board-azure.mjs) and
[azure-card.mjs](../scripts/lib/azure-card.mjs). These contracts and synthetic workflows do not establish live Azure
acceptance. Token acquisition, native process permissions, server normalization of descriptions and actual writes
require separately authorized live evidence. Native operating-system compatibility requires receipts from that
platform; a simulated platform or synthetic provider response does not supply them.

## Setup

1. Choose an existing organization and project. Obtain the project's universally unique identifier (UUID), enabled
   work-item types and their native states through an authenticated read-only client or the project administrator.
   Init creates no organization, project, process, type, state, field or relation type.
2. Map each kind and all six columns as [Configuration](#configuration) specifies. Ask the administrator to resolve
   incompatible process rules or required fields. Keep the project's actual names, including case.
3. Give init only those nonsecret mappings. Set up the private credential file under [Credentials](#credentials).
   Init validates the configuration without contacting Azure or asking for a token.
4. Run `node scripts/board.mjs --intake`. Resolve native metadata, visibility or mapping refusals before work-pick.
   A successful read does not establish permission to create, assign, comment or move.

### Configuration

Init writes `TRACKER = "azure"` and `AZURE_CONFIG` in customer-owned `scripts/lib/board-config.mjs`. An answers file
puts the same object in `board.azure`, beside `tracker: "azure"`, `owner`, `ownerType` and `repository`. The last
three values identify GitHub code delivery. This illustrative mapping is complete, but its native names must exist
in the chosen project's process:

```js
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

Every shown key is required; extra keys are refused at every level. Organization is a 1-49 character slug of ASCII
letters, digits and hyphens with alphanumeric ends, without a web-address prefix. Project is a hexadecimal UUID in
8-4-4-4-12 form. Organization retains its supplied case; the project UUID is canonicalized to lowercase. Type and state names are nonblank strings of at most 255 UTF-16
code units, without ASCII or C1 control characters. `workItemTypes` has exactly `epic`, `feature`, `task`, `bug` and
`docs`; types may repeat. `states` has exactly one entry per distinct mapped type, and each entry maps all six
columns to six distinct native state names.

Runtime reads validate the exact project, enabled native types, state metadata and relation types. Done must map to a
state in the native Completed category; other columns cannot map to Completed or Removed. Unknown types or states
are mapping drift, never guessed completion. Every card carries exactly one configured `KIND_LABELS` value in
`System.Tags` and its configured native type; unrelated tags are preserved. Missing or multiple kind tags are drift
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

For accounts that cannot use Entra, use a personal access token (PAT) restricted to the exact configured organization
with Work Items read/write (`vso.work_write`) and User Profile read (`vso.profile`). Code, Build, Graph and
administration scopes are unnecessary. Native project permissions and visibility still apply. The
[work-item update reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1)
and [profile reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/profile/profiles/get?view=azure-devops-rest-7.1)
define these scopes.

Use a private editor to save exactly these three nonblank, control-free string fields as JavaScript Object Notation
(JSON) in `~/.config/fabraik/azure.json`, replacing placeholders privately:

```json
{"organization":"example-org","authentication":"entra","token":"<privately provisioned access token>"}
```

`authentication` is exactly `entra` or `pat`; `organization` must exactly equal `AZURE_CONFIG.organization`.
`token` must have no leading or trailing whitespace. On Windows the location is
`%USERPROFILE%\.config\fabraik\azure.json`, under the actual home directory. The file must be
outside the repository, a regular file of at most 16 kibibytes, never a symbolic link or hard-linked file. On Linux
and macOS run `chmod 600 ~/.config/fabraik/azure.json`; group or other permission bits are refused. On Windows restrict
the file and user profile through access control lists yourself: the reader does not validate Windows access control
lists, and Unix mode bits cannot prove Windows privacy.

Only the isolated request helper reads the credential file. A session diagnoses its sanitized messages and never
reads, prints or copies that file. Credentials belong in neither answers nor board configuration, prompts, command
arguments, environment overrides, URLs, repository files, commits, pull requests or logs. If exposed, revoke or replace
the credential through its issuer and save the replacement privately.

The helper sends Entra Bearer or PAT Basic authentication only to constructed HTTPS destinations under
`dev.azure.com/<configured organization>` and to the single profile-me GET at
`https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1&details=true`. Redirects and arbitrary
URLs are refused. Relationship URLs supply checked identifiers, never a destination to fetch verbatim. Requests
travel through standard input, without shell evaluation or automatic retries. A sandbox must allow those two hosts.

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
inside the adapter. A card such as `AB-299` uses branch `job/AB-299`. Assignees and comment authors are compared by
native Azure DevOps identity UUID, never display name, email matching or an Entra object ID. Profile-me establishes
the viewer. Assignment submits the profile's exact nonblank email principal; native validation must resolve it to the
same profile UUID before the actual write, and direct read-back must confirm that UUID.

Use `node scripts/board.mjs` for the pick view, `--json` for normalized data, `--intake` for complete intake and
`--closeout` for the strict scan. The normalized board exposes only `openBlockers`; use the complete `blockedBy`
row from `text` when verifying the exact blocker set, including closed blockers. An empty project is valid only
after a complete successful read. Failed,
permission-limited or incomplete evidence must never be reported as no cards, no claims or zero children.

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

Invoke `node scripts/azure-card.mjs` with the following arguments. Usage errors exit 2 before provider work; confirmed
success or no-op exits 0. Runtime refusals are nonzero. The transport classifies throttling as exit 3 and other
provider failures as exit 1; callers may wrap a refusal in their own nonzero outcome. Inspect errors and required
read-backs before treating an operation as complete.

| Arguments after the script | Operation |
|---|---|
| `view <AB-ID>` | Complete state, assignee, viewer and native-comment evidence for the claim protocol |
| `view <AB-ID> --board` | Exact Azure board identity and mapped column for the free-card comparison |
| `text <AB-ID>` | Full title, native description, parent, `["blockedBy",[AB-IDs...]]` including closed blockers, and complete native comments with their formats |
| `children <AB-ID>` | `["children",[AB-IDs...]]`, `["total",n]` and `["completed",n]`; completion counts use the configured Done state |
| `assign <AB-ID>` / `unassign <AB-ID>` | Assign the viewer or remove the viewer's assignment; refuse another holder |
| `comment <AB-ID> --body-file <file>` | Post Markdown source and confirm the native comment |
| `edit-comment <AB-ID> <comment-id> --body-file <file>` | Edit only the viewer's native comment and confirm its text/version |
| `create --title <text> --body-file <file> --status <column> --kind <kind> [--parent <AB-ID>] [--blocked-by <AB-ID>,...]` | Create a typed, tagged item with optional native parent/block relationships |
| `edit <AB-ID> [--title <text>] [--body-file <file>]` | Edit at least one supplied field, with exact read-back |
| `parent <AB-ID> --to <AB-ID>` | Add a same-project native parent; refuse a different existing parent or self-reference |
| `block <AB-ID> --by <AB-ID>` | Add a same-project blocker; refuse self-reference |

Create accepts exactly `Backlog` or `Ready` for `--status`; move an existing card explicitly for later columns.
A complete `children` result has a total equal to its identifier count. Every child is Done only when `completed`
equals `total`; individual child states are not printed.

Identifiers, body files, unknown or duplicate flags are checked before provider calls. The five kinds are the keys
of `KIND_LABELS`. There are no arbitrary-field, impersonation, deletion or administrative commands. Body-file source,
including Markdown punctuation, is stored in an escaped literal `<pre>` description: `&`, `<` and `>` are escaped,
and the entire source is retained. Reads label the native representation. Exact confirmation can fail if Azure
normalizes it; that is an unconfirmed write, not success. Comments use the native Markdown format and retain complete
native representations on read.

## Claims and withdrawal

Apply [resume's free-card and race rules](../.agents/skills/resume/SKILL.md#3-start-the-job) with Azure evidence:

1. Read `view <AB-ID>`, `view <AB-ID> --board` and `text <AB-ID>` completely. Compare exact organization/project and
   mapped column with intake, and compare assignees and claim authors by native UUID. Inspect every complete native
   comment for an active `Claim:` despite HTML wrappers. Missing or incomplete evidence cannot establish free.
2. Move to In progress, assign the viewer and post `Claim: <machine>, <runtime>, <time>` through a body file, using
   resume's literal machine, runtime and time reads. Retain the returned native comment identifier and address.
3. Immediately reread complete card and native-comment evidence before any edit or dependency installation. Confirm
   the exact new claim and viewer assignment. Among new claims since the pre-claim read, the first in the native server's
   returned ascending sequence holds the card under resume's race rule. The adapter applies no local tie sort.
4. If another claim wins, edit only this session's comment by its native identifier to `Withdrawn: ...`, preserving
   resume's reason. Unassign only when resume's existing withdrawal condition permits it; keep another holder's
   assignment and the holder's In progress column. Follow resume for local cleanup and reporting.

Move, assignment and commenting are separate writes, not an atomic lock. Report each confirmed step when a later one
fails. If rereading cannot establish ownership, stop without a second claim or further changes. Comment ownership is
checked immediately before editing and confirmed after, but native comments supply no atomic compare-and-swap
promise. Never derive comment authorship from an email or display name.

## Moving, filing and recovery

`node scripts/board-move.mjs <AB-ID> "<column>"` explicitly moves to a mapped column. An already-confirmed target
is a no-op. `--batch <AB-ID>:<column> ...` stops at the first failure and names completed moves. Lane arguments are
refused; `board-add.mjs` directs filing to `azure-card.mjs create`.

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

Use this table wherever a skill names a GitHub card step. The authoritative skills retain every approval, review,
publication and cleanup gate.

| Step | Azure action |
|---|---|
| Intake and card context | `board.mjs --intake`, then `azure-card.mjs text <AB-ID>`; review complete native comments |
| Free-card, assignment, claim or withdrawal | The complete reads and native-UUID protocol in [Claims and withdrawal](#claims-and-withdrawal) |
| Awaiting push | `board-move.mjs <AB-ID> "Awaiting push"` before requesting push authorization |
| Closing line and branch | `job/<AB-ID>` and both standalone body lines below; always the pull request route |
| Draft opened | Keep the card's current explicit column; draft creation does not move it to In review |
| Pull request marked ready | Explicitly run `board-move.mjs <AB-ID> "In review"` after marking ready |
| Handoff | `board-move.mjs <AB-ID> Ready` after handoff's existing publication steps |
| File or fold approved work | `azure-card.mjs create` or `edit`; preserve metadata and native relationships on a fold |
| Parent or blocker | `azure-card.mjs parent` or `block`; reread `parent` and the complete `blockedBy` row through `text`, including closed blockers |
| Verify filing | `node scripts/verify-issue-publish.mjs <AB-ID> [<child AB-ID> ...]`; exact kind/type/status, parent and supplied complete direct-child set |
| Completion or review comment | `azure-card.mjs comment <AB-ID> --body-file <file>`; edit only the viewer's own comment |
| Backlog or another explicit column | `board-move.mjs <AB-ID> "<column>"` |
| Merge closeout | Confirm the authorized pull request merged, explicitly move its Azure card to Done, then run `board.mjs --closeout` |
| Parent closeout | `azure-card.mjs children <AB-ID>` must return complete child identities with `completed` equal to `total` before explicitly moving the parent to Done |
| Deferred cleanup | No Azure pending-record mechanism; report retained targets under closeout's existing non-GitHub scope |
| Leftover card state and claim | Complete `view` and `text` reads, including native claim comments |
| Leftover open-card text search | Unavailable; no Azure card-text search command exists. Unavailable evidence cannot authorize deletion |
| Cloud card builds and documentation sweep | Unavailable; use the local workflow |

The pull request body for illustrative card `AB-299` includes these two standalone lines, using the exact configured
organization, project UUID and native item number:

```text
Closes AB-299
Azure Boards: https://dev.azure.com/example-org/11111111-1111-4111-8111-111111111111/_workitems/edit/299
```

Delivery recognition requires both head and base in the configured GitHub repository, base `main`, exact head
`job/AB-299` and both exact standalone lines. Open pull requests, including drafts, and merged pull requests qualify;
forks, other bases, closed-unmerged pulls and incidental mentions do not. `Closes AB-299` does not close an Azure item
through GitHub. Never substitute `Closes #299` or assume Azure automation moved it.

Merge-before-Done and complete-children-before-parent-Done remain agent instructions; `board-move.mjs` does not supply
a standalone merge or parent-closeout guard. A publication check without supplied child identifiers does not assert
zero children. Report an item resolved by the change but absent from the approved body instead of closing it unasked.
An incomplete child read stops the parent transition.

### Review snapshots

Before an architect, reviewer or cross-review captures an Azure card, read this manual and run
`node scripts/azure-card.mjs text <AB-ID>` in place of every `gh issue view` card capture. Preserve the review route's
existing output file and redirection, including appended prompts and plan-review fallback snapshots. Include the
entire native description and every native comment with format and author identity; unavailable content is a stop,
never an empty snapshot. The read-only snapshot grants no write authority or permission to expose credentials.
