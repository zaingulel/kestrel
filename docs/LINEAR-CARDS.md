# Linear cards

Linear cards are for a team that already plans in Linear. The cards are the issues of one Linear team, read and written
through Linear's GraphQL API by the same scripts that serve a GitHub Project board. A repository chooses Linear at
install, and the choice is two lines in `scripts/lib/board-config.mjs`: `export const TRACKER = "linear";` and
`export const LINEAR_TEAM = "<KEY>";`, the team key that prefixes its issue IDs, such as `ENG`. A configuration without
`TRACKER` is a GitHub board.

This manual owns the setup of the Linear team and key, the identity of a card, the claim and what each card step
becomes where cards are Linear issues. Every skill and charter that runs a card step points here. The exact behaviour of
each command is in the heads of [`scripts/lib/linear-card.mjs`](../scripts/lib/linear-card.mjs),
[`scripts/lib/board-linear.mjs`](../scripts/lib/board-linear.mjs) and
[`scripts/lib/linear-api.mjs`](../scripts/lib/linear-api.mjs). Pull requests, checks and merges still run on GitHub, so
a Linear install records its GitHub owner, owner type and repository name in `board-config.mjs`, with
`BOARD_PROJECT_NUMBER = null`, `ROUTING_FIELD = null`, `ROUTING_OPTIONS = []` and `PARKED_LANE = null`, because a Linear
board has no project, no routing and no parked lane. `LINEAR_STATES` maps each board column to the name of a state of
the Linear team; the starter is:

| Column | Linear state | State type |
|---|---|---|
| Backlog | Backlog | backlog |
| Ready | Todo | unstarted |
| In progress | In Progress | started |
| Awaiting push | Awaiting Push | started |
| In review | In Review | started |
| Done | Done | completed |

A completed, canceled or duplicate state reads as the Done column and the card as closed. A state outside the mapping,
such as Triage, reads as no column and is reported as drift.

## The contract

Linear publishes the facts below; each row links its source. Every request is a GraphQL POST, and an identifier always
travels as a variable, never inside the query.

| Fact | What the tools rely on | Linear source |
|---|---|---|
| Endpoint | `https://api.linear.app/graphql` | [GraphQL](https://linear.app/developers/graphql) |
| Key header | A personal API key goes in `Authorization: <key>` as it is, with no `Bearer` prefix | [GraphQL](https://linear.app/developers/graphql) |
| Key permissions | Read and Write, limited to the board's team, never Admin. Linear documents no scope for `issueUpdate`, `issueRelationCreate` or `commentUpdate`, so Write is chosen by elimination | [API and webhooks](https://linear.app/docs/api-and-webhooks), [OAuth scopes](https://linear.app/developers/oauth-2-0-authentication) |
| Identifier | `Issue.identifier`, such as `ENG-123`, is `Team.key`, a hyphen and the team's issue number; an issue answers to its identifier or its id | [GraphQL schema](https://github.com/linear/linear/blob/618a737a4e6aa279b7853c650f79f209a5142bbc/packages/sdk/src/schema.graphql) |
| States | A team's states have a free-text name and one of seven types; a write sets `stateId`, so a name is first resolved through the team's states | [Workflow states](https://linear.app/docs/issue-property) |
| Blockers | An issue's `inverseRelations` of type `blocks`; a blocker is open until its state type is completed, canceled or duplicate | [GraphQL schema](https://github.com/linear/linear/blob/618a737a4e6aa279b7853c650f79f209a5142bbc/packages/sdk/src/schema.graphql) |
| Parents and children | `Issue.parent` and `Issue.children`; archived children are read with `includeArchived: true` and count toward an epic's total | [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) |
| Comments | `Issue.comments`, every page of 50; `Comment.user` is null for an integration | [GraphQL schema](https://github.com/linear/linear/blob/618a737a4e6aa279b7853c650f79f209a5142bbc/packages/sdk/src/schema.graphql) |
| Pull request links | `Issue.attachments`, whose url is the linked pull request and whose `metadata.linkKind` is `closes` for a closing link (a closing word such as `Closes`) and `contributes` for a mentioning one (such as `Refs`); the board counts only `closes` links as the card's closing pull requests | [Attachments](https://linear.app/developers/attachments), [GitHub integration](https://linear.app/docs/github) |
| Pagination | Relay cursors, 50 results by default; the tools follow every cursor and fail a read that cannot | [Pagination](https://linear.app/developers/pagination) |
| Errors | A reply can be HTTP 200 and carry an `errors` array, which fails the command whole | [GraphQL](https://linear.app/developers/graphql) |
| Rate limit | HTTP 429 or `RATELIMITED`, with `Retry-After` in seconds and reset times in epoch milliseconds; an API key shares 2,500 requests an hour across every tool the account runs | [Rate limiting](https://linear.app/developers/rate-limiting) |

## Team setup

Do these once for the Linear team, then run `node scripts/board.mjs`: it reads the team and lists every mismatch it
finds, each pointing back here.

1. **Add the started states.** In the team's workflow settings add two states of the started category, named as
   `LINEAR_STATES` names them: `Awaiting Push` and `In Review`. Each mapped name must match exactly one state of the type
   in the table above, so a second state of the same name, or a renamed one, is refused until `LINEAR_STATES` and the
   team agree.
2. **Leave Triage on or off.** It does not matter, because `create` always passes the state it files into. A card that
   lands in Triage some other way reads as no column.
3. **Create the kind labels.** Create one label for each value of `KIND_LABELS` in `board-config.mjs`, named exactly as
   the file names it (the starter's are `epic`, `enhancement`, `task`, `bug` and `documentation`). Each name must be held
   once, by the team or by the workspace: `create` refuses a kind whose label is missing or held twice.
4. **Set the pull request automation.** In the team's GitHub settings set the rules for pull requests into `main`:

   | Event | Setting |
   |---|---|
   | Pull request drafted | No action |
   | Pull request opened | In Review |
   | Pull request merged | Done |
   | Review requested and ready for merge | No action, or In Review |

   A draft does nothing, so a draft that parks unfinished work leaves its card where the session put it; Linear moves the
   card to In Review when the draft is marked ready for review. Write no rule as a regular expression target branch: the
   check cannot read one and fails. A rule for target branch `main` written literally wins over the default rule, and a
   default rule (no target branch) is read when there is none. "No action" is not a rule Linear stores: Linear refuses a
   default rule with no state, so a team with no draft rule shows "No action", and the check reads an absent rule as no action.
5. **Turn on "auto-close parent issues"** in the team's settings. Linear then closes an epic when its last child is done,
   and the workflow never writes Done itself. With the setting off, the board reports the epic whose children are all
   done.
6. **Install Linear's GitHub app on the repository only.** A GitHub organization owner, or for a single repository its
   administrator, installs it from Linear's GitHub settings and selects this repository, not all of them. Linear links a
   pull request from its branch name, title or description, never from a comment. One GitHub organization connects to only one
   Linear workspace. The workflow needs only pull request linking, which the GitHub app does without access to repository code, so leave code access off for this repository (on GitHub.com, the separate Linear Code app).
7. **Save the key** as [The key](#the-key) says.

## The key

The Linear key is the one secret this tracker adds. One personal key serves each machine account:

- **Where.** The file `~/.config/fabraik/linear-api-key`, which is `%USERPROFILE%\.config\fabraik\linear-api-key` on
  Windows. It holds the key and nothing else.
- **Make it.** In Linear, Settings, Account, Security & access, create a personal API key with Read and Write permission,
  limited to this team, and never Admin. Save it to the file, and on Linux and macOS run `chmod 600
  ~/.config/fabraik/linear-api-key`.
- **What the reader accepts.** A regular file, never a link, of at most 4096 bytes, whose trimmed content is printable
  ASCII with no inner whitespace. On Linux and macOS a mode that gives the group or anyone else access is refused,
  naming `chmod 600`. Windows keeps a user profile private by default, so the mode check is skipped there.
- **Who reads it.** Only a short-lived helper process that sends the request. The key never enters a command line or the
  environment of another process, and every text the helper prints has each occurrence of the key replaced by `[key]`.
- **Not an environment variable.** Every child process inherits one, and an environment dump exposes it.
- **Not in a cloud environment.** A Linear install starts no cloud build, and the key is never given to one.
- **Init never asks for it.** Setting up the install writes the configuration only; you save the key yourself.
- **If it leaks,** revoke it in Linear and create another.

The Linear key lives only in the private file `~/.config/fabraik/linear-api-key` on the machine that runs the session, and
the board tools send it only in the Authorization header of a request to api.linear.app: never put it in a repository, a
commit, a pull request, a log, a URL, an environment variable or a cloud environment. A session never reads, prints or copies the key file, and it diagnoses a key problem only from the helper's own messages, which name the file and never its content.

A sandbox that limits outbound hosts must admit `api.linear.app`, or every request fails as unreachable.

## Identity

A card is a Linear issue, named by its ID: the team key in capitals, a hyphen and the issue number, such as `ENG-123`.
No `#` precedes it in board output or in text you write. The key must match the `LINEAR_TEAM` of `board-config.mjs`;
an issue Linear moved to another team answers under a new ID, and every command refuses it.

| Where | On Linear |
|---|---|
| Branch | `job/ENG-123` |
| Worktree | `.claude/worktrees/job-ENG-123` |
| Pull request body | `Closes ENG-123`. Closing words are Linear's: close, fix, resolve, complete or implement, in any tense. GitHub ignores the reference, which has no `#`. A mention of another card uses a non-closing word, such as `Refs ENG-45` |
| Claim comment | A comment that starts `Claim:`, as on GitHub |
| Route | Always the pull request route. Linear reads a pull request's body and branch; it reads a squash commit's closing word only with commit linking and a hand-added webhook, so the direct route cannot close a Linear card |

## Moving cards

`node scripts/board-move.mjs <ID> <Status>` exits 0 when done, 1 on a refusal and 2 on a usage error. On a Linear board
`<issue#>` is the issue ID, as in `board-move.mjs ENG-12 Ready`.

| Target | What it does |
|---|---|
| Backlog, Ready, In progress, Awaiting push | Writes the card's state by the id of the state `LINEAR_STATES` names, and requires Linear's answer to carry that state. A card already there is not written: the `already at <Status> — no-op` line |
| In review, Done | A check, never a write. A card in that column prints `at <Status> — moved by Linear`. Otherwise the check reads again up to five more times, five seconds apart, and then fails, naming the state the card is in, the column, the rule that moves it (start, when the pull request is marked ready, or merge) and that nothing was written |
| `--lane` | Refused: a Linear board has no parked lane |
| `--batch <ID>:<Status> ...` | Stops at the first failure and names the moves already completed |
| Anything else | Refused, listing the allowed statuses |

`node scripts/board-add.mjs` files nothing on Linear: it exits 1 naming `linear-card.mjs create`.

`node scripts/board.mjs` lists the team's cards in the same pick view, `--intake` prints the intake document whose first
line is `Board linear team <KEY>`, and `--closeout` is the strict scan. A read that fails on any page fails whole, with
exit 2 under `--intake` and exit 1 otherwise, and never reads as an empty board. A card shows its kind label, the open
blockers (the closed ones are dropped), its parent and its children, and its pull requests: an attachment whose url is a
pull request of the GitHub repository `board-config.mjs` names counts as a closing pull request.

## The claim

`node scripts/linear-card.mjs` serves the card steps. Every output line is one JSON array, so card text, which is data,
can never forge another line. It exits 0 for done or a no-op (printing `["no-op"]`), 1 for a refusal or failure with its
cause on stderr, and 2 for a usage error before any request. Every ID is validated before any request, and every issue a
command names is first read in the configured team under its own ID; a write then goes to the id that read returned.

| Command | What it does |
|---|---|
| `view <ID>` | The card read: `["state","OPEN"]` or `["state","CLOSED"]`, `["assignees",[displayName,...]]`, one `["claim",position,author,createdAt,url,firstLine,commentId]` for each `Claim:` comment, oldest first, and `["comments",n]` last. It prints only after every page of comments is read, so a failed page leaves nothing that reads as complete |
| `view <ID> --board` | The board read: `["board","linear","<TEAM>","<Column>"]`, then `["boards",1]`. A card in an unmapped state prints a null column |
| `text <ID>` | `["title",t]`, `["body",b]`, `["parent",ID or null]`, `["blockedBy",[...]]` listing every blocker, open or closed, then one `["comment",position,author,createdAt,url,body]` for each comment |
| `assign <ID>` | Sets this account as the assignee of an unassigned card; a no-op when it already is; a refusal, naming the holder, when another account holds the card |
| `unassign <ID>` | Clears this account as the assignee; a no-op on an unassigned card; a refusal when another account holds it |
| `comment <ID> (--body <text> \| --body-file <file>)` | Posts a comment and prints `["comment",id,url]` |
| `edit-comment <comment id> (--body <text> \| --body-file <file>)` | Replaces the body of a comment, and only of a comment this account wrote on an issue of the configured team. The comment id is the last value of a `claim` line |

The comment author is the account's Linear display name, or `(integration)` for a comment no user wrote. The comments of a
card are ordered oldest first by creation time and then by comment id, and that order, which the `claim` lines follow,
decides which of two claims came first.

## What each card step becomes

Where a skill or charter names a `gh` card step, a Linear install does this instead. A step not listed is the same.

The card read, the board read, the identity comparison and the blocker read-back are fixed by this table:

| Step (skill) | On GitHub | On Linear |
|---|---|---|
| Card read (resume, "3. Start the job") | `gh issue view <issue> --json state,assignees,comments --jq ...` | `node scripts/linear-card.mjs view <ID>` prints `["state",S]`, `["assignees",[displayName,...]]`, one `["claim",position,author,createdAt,url,firstLine,commentId]` per `Claim:` comment, oldest first, and `["comments",n]` last. Complete under the unchanged rule: exit 0, `state` and `assignees` once each, `comments` last. The free check reads the first six values as on GitHub; the seventh, `commentId`, is what a withdrawal edits. |
| Board read (resume, same step) | `gh api graphql ... projectItems ...` | `node scripts/linear-card.mjs view <ID> --board` prints one `["board","linear","<TEAM>","<Column>"]`, then `["boards",1]`. Complete: exit 0, exactly one `board` line, none of its three values null, then `boards` 1. A card in an unmapped state prints a null column, so its read is incomplete, loudly. |
| Identity comparison (resume, same step) | The matching configured `board` line's owner and number against the intake document's first line, `Board <owner>/<repository> project <number>` | The intake document's first line is `Board linear team <KEY>`. The `board` line's second and third values must be `linear` and that `<KEY>`, and its column the one in the card's heading. Assignees compare as a set, written `@<displayName>` in the document. |
| Blocker read-back (to-issues) | `gh api "repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by" --jq '.[].number'` | `node scripts/linear-card.mjs text <ID>`; its `["blockedBy",[...]]` line lists every blocker, open or closed. A missing or extra link against the owner-approved list is a failure to fix before reporting ready, as on GitHub. |

Every other step:

| Step | On Linear |
|---|---|
| Read a card (`resume` intake, `to-issues` step 1, the `architect` and `reviewer` charters, `cross-review`) | `node scripts/linear-card.mjs text <ID>` for the card, and the pick view and card sections from `node scripts/board.mjs --intake`. `cross-review` puts the command's output where it puts `gh issue view` output |
| Claim: assignee, `Claim:` comment (resume, "3. Start the job") | `node scripts/board-move.mjs <ID> "In progress"`, then `node scripts/linear-card.mjs assign <ID>`, then `node scripts/linear-card.mjs comment <ID> --body "Claim: <machine>, <runtime>, <time>"`. The session records the address in the printed `["comment",id,url]`. The re-read is `view <ID>`, complete when it also shows a `claim` line whose address is the recorded one |
| Withdraw a claim | `node scripts/linear-card.mjs edit-comment <comment id> --body "Withdrawn: <machine>, <runtime>, <time>: an earlier claim holds this card."`, the id being the seventh value of the session's own `claim` line. The assignee is removed with `node scripts/linear-card.mjs unassign <ID>` only under the condition `resume` sets |
| Awaiting push (`resume`, "7. Push authorisation") | `node scripts/board-move.mjs <ID> "Awaiting push"`, a written move, as on GitHub |
| Verdict and Stage 2 evidence (`resume`, "7. Push authorisation") | Post with `node scripts/linear-card.mjs comment <ID> --body "<line>"`. The first two measures read `not measurable: Linear's reads give neither this account's own name nor archived issues, so a verdict's author and the full history cannot be established`; no read is made for them. The share of suggested cards accepted reads with `node scripts/board.mjs --all --json`, then `linear-card.mjs text <ID>` for each card it lists, applying the same title and body tests, and gives those counts as the cards it could read, with the share itself `not measurable: archived issues are left out of this read`; a failed read leaves no counts, naming the card |
| The `Closes #<issue>` line | `Closes <ID>`, such as `Closes ENG-123`. A Linear job always takes the pull request route |
| Draft opened, "Move the card to In review" (`resume`, "8. Deliver") | Nothing to move: Linear moves the card when the draft is marked ready for review |
| `handoff`, step 5 | `node scripts/board-move.mjs <ID> Ready`, a written move. The draft does nothing on Linear, so the parked card is not pulled to In Review |
| `closeout`, step 2 (issue state) | After the merge, `node scripts/linear-card.mjs view <ID>` prints `["state","CLOSED"]` once Linear's merge rule has run. A card the pull request resolved but did not name is reported, never closed unasked |
| `closeout`, step 4 (Done and scan) | `node scripts/board-move.mjs --batch <ID>:Done` checks the card, waiting for Linear's merge rule, and writes nothing. Then `node scripts/board.mjs --closeout` scans |
| `closeout`, Deferred cleanup | The pending record is a GitHub issue comment, which a Linear card has no counterpart for: retained targets are reported, as the section says for a tracker that is not GitHub issues |
| `closeout`, Leftover rule, card state and latest claim | `node scripts/linear-card.mjs view <ID>`: its `state` line and its latest `claim` line |
| `closeout`, Leftover rule, open-card search | No command searches Linear card text, so that evidence is unavailable, as a failed search is. A hit still cannot be ruled out, so the artifact stays unsettled unless other evidence settles it |
| `gh issue create` and `board-add` (`to-issues`, step 6a and 6b) | `node scripts/linear-card.mjs create`, as [Filing a card](#filing-a-card) says; `board-add` refuses. A Linear card has no Workstream |
| Suggested card (`resume`, "2. Work-pick") | File with `linear-card.mjs create --title 'Proposed: <title>' --body-file <file> --status Backlog --kind <kind>`. A yes is `linear-card.mjs edit <ID> --title '<the title without it>'`. A no keeps the title and the owner cancels the card in Linear, because `board-move` writes no Done |
| Link a child to its parent Epic (`to-issues`, step 6c) | `--parent <EPIC>` on `create`, or `node scripts/linear-card.mjs parent <ID> --to <EPIC>` afterwards. The Epic's children are its Linear sub-issues |
| Blocked-by (`to-issues`) | `--blocked-by <ID>,...` on `create`, or `node scripts/linear-card.mjs block <ID> --by <BLOCKER>` afterwards |
| Fold work into an existing card (`to-issues`) | `node scripts/linear-card.mjs edit <ID> [--title <title>] [--body-file <file>]` |
| Verify the publish (`to-issues`, step 8) | `node scripts/verify-issue-publish.mjs <EPIC_ID> <CHILD_ID...>`. A kind-label failure is corrected in Linear's label settings. The failures read as on GitHub, in Linear's words: `is not in this board read` is a lag to re-run, `is archived while still open` is a card to unarchive, and `belongs to team` names a card of another team |
| Comments | A Linear comment, posted with `comment` |
| Return a card to Backlog or Ready outside a job | `node scripts/board-move.mjs <ID> Backlog` or `Ready` |
| Epic done | Nothing to write: the team's auto-close setting closes it |
| Cloud build | None: a Linear install starts no cloud build |
| Documentation sweep | None: init asks no sweep question on Linear and refuses `docSweep: true` |

## Filing a card

`node scripts/linear-card.mjs create --title <title> --body-file <file> --status Backlog|Ready --kind <kind> [--parent
<ID>] [--blocked-by <ID>,...]` files one issue:

1. It refuses, printing the existing ID and writing nothing, when the team already holds an issue with the exact same
   title.
2. It resolves the kind to the one label `KIND_LABELS` names, files one issue in the chosen state with that label and the
   parent, then adds a `blocks` relation for each blocker, and prints `["created",ID]` first and a `["block",ID,BLOCKER]`
   for each relation.
3. A refused or unconfirmed `issueCreate` prints the failure unchanged and sends nothing further. Running `create` again
   is safe, because it first looks for an issue with the same exact title, and so finds one that was filed before a
   timeout.
4. Once the issue exists, a relation that fails stops the command, naming the created ID and the `block` commands that
   remain, and nothing more is sent.

`parent` and `block` are idempotent: an existing link prints `["no-op"]`. Then `verify-issue-publish.mjs` confirms
board presence, the Status, exactly one kind label and the exact child set by ID, archived children included. A closed
card Linear archived is read directly and passes as Done.

## Failure messages

Every failure names its cause. The transport sends one request, classifies the answer, and replaces the key by `[key]` in
every message.

| Failure | Message begins | What to do |
|---|---|---|
| No key file, or one that is a link, over 4096 bytes or empty | `No Linear API key file at <path>`, or names the path and the problem | Save the key as [The key](#the-key) says |
| Key file open to other accounts | `The Linear API key file <path> is open to other accounts: run chmod 600 <path>` | Run that command |
| Key refused (HTTP 401 or 403, or an authentication or forbidden error) | `Linear refused the API key in <path>` | Give the key Read and Write access to the team |
| Rate limit | `Linear's API rate limit stopped the request`, with Retry-After and the reset times | Wait for the reset. Every caller stops there: nothing further is sent, and an intake read marks the current and later cards unavailable |
| Errors in an HTTP 200 reply | `Linear answered HTTP 200 with errors: <type>: <message>` | The command failed whole and returned no partial data. Read the named cause |
| Usage limit | `Linear's usage limit stopped the request: <Linear's message>` | Linear's own message; it names no cap |
| Not JSON, no data, or unreachable | `Linear answered HTTP <status> with a body that is not JSON`, `with no data`, or `Linear could not be reached: <code>` | Check the network and that `api.linear.app` is admitted |
| No answer in 60 seconds | `Linear did not answer within 60 s` | Run it again |
| Team or states misconfigured, or a wrong automation rule | `Linear team <KEY>: <every mismatch>. See "Team setup" in docs/LINEAR-CARDS.md.` | Correct the team as [Team setup](#team-setup) says |
| A card of another team, or one answering under another ID | `<ID> belongs to team <X>, not the configured team <KEY>`, or `Linear answered the identifier <X> for <ID>` | Nothing was written; use the card's current ID |
| In review or Done not reached | `<ID> is in "<state>", not <Column>; Linear's <rule> rule moves it there, and nothing was written` | Check the pull request and the automation rules |
| A comment or card that is not this account's | `... was written by another account, and only its author edits it`, or `... is held by <name>, not by this account` | Nothing was written |

Linear's pricing gives the Free plan 250 issues, and Linear decides when a team has reached its limit. There it refuses the
new issue with the error `usage limit exceeded`, which `create` reports as the Usage limit row says, in Linear's words; the
message names no cap, so neither does `create`.

## Limits

- No cloud build and no documentation sweep, since both act on GitHub issues and the key never leaves the machine.
- One key file for each machine account.
- A regular-expression target-branch rule is refused, because the automation check cannot read it.
- The pull request route only.
- No routing: the pick view lists cards without a Workstream.
- Linear's side effects: cancelling an issue closes the pull requests linked to it, and linking a pull request assigns an
  unassigned issue to the account that linked it.
- The configuration must match what init wrote. After a hand edit of `LINEAR_STATES`, a re-run of init is refused; edit
  the team and the mapping together instead.
- The API key's hourly limit is shared by every tool its account runs.
- The move is one-way and manual: there is no command to move Linear cards to a GitHub board.
