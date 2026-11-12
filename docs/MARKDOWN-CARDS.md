---
description: This page is the reference for Markdown cards, which keep each card as a file in the repository. It gives the card format, the states a card shows and what each card step becomes.
---

# Markdown cards

Markdown cards keep each card as a file in the repository, for one person working alone. Use this page to write a card
file and to run each card step where cards are files.

```sh title="Terminal"
node scripts/board.mjs
```

The command prints the pickable cards, then the board scan. A read that fails exits 1 and never reads as a free board.

| Entry | What it covers |
|---|---|
| [Configuration](#configuration) | The settings that choose this tracker, and who should choose it |
| [The card file](#the-card-file) | The file's name, its form and the read's rules |
| [Stored, published and shown states](#stored-published-and-shown-states) | Where a card's status comes from and which column the board shows |
| [Card commands](#card-commands) | The claim and the commands that move, file and close a card |
| [The claim](#the-claim) | How the job branch claims a card |
| [Moving cards](#moving-cards) | What the move command does for each target |
| [Filing a card](#filing-a-card) | The steps that add a card |
| [Closing a card](#closing-a-card) | The steps that close a card through its pull request |
| [Releasing a claim](#releasing-a-claim) | When an unfinished claim may end |
| [What each card step becomes](#what-each-card-step-becomes) | The Markdown form of each GitHub card step |
| [Moving to a GitHub board](#moving-to-a-github-board) | The one-way move onto a GitHub Project board |
| [Limits](#limits) | What this tracker does not do |

## Configuration

A team should choose the GitHub Project board instead. Nothing coordinates two people, or two machines, working on one
markdown install until push, and the second claim fails only then. Every rule on this page follows from that.

A repository chooses markdown at install. These values in `scripts/lib/board-config.mjs` record the choice:

| Value | Setting |
|---|---|
| Tracker | The line `export const TRACKER = "markdown";`. A configuration without it is a GitHub board |
| GitHub owner, owner type and repository name | Recorded, because pull requests, checks and merges still run on GitHub |
| Project number | `BOARD_PROJECT_NUMBER = null`, because there is no project |

This manual owns the card format, the states the board shows a card in and what each card step becomes where cards are
files. Every skill and charter that runs a card step points here. The head of
[`scripts/lib/board-markdown.mjs`](../scripts/lib/board-markdown.mjs) owns each command's exact reads and refusals.

## The card file

Each card is one file, `.agents/cards/{{NUMBER}}.md`. The read is strict, and the file takes this form:

```text title=".agents/cards/{{NUMBER}}.md"
# {{TITLE}}

Status: Backlog | Ready | Done
Kind: {{KIND}}
Workstream: {{WORKSTREAM}}           (only when the board has a routing field; then required)
Parent: {{NUMBER}}                   (optional)
Blocked by: {{NUMBER}}, {{NUMBER}}   (optional)

{{BODY}}

## Comments

### {{HEADING}}
{{TEXT}}
```

| Part | Required | Value and limits |
|---|---|---|
| File name | Yes | `{{NUMBER}}` is the card number: a positive integer with no leading zero and no larger than 9007199254740991 |
| Title | Yes | Line 1 is `# ` and a non-empty title, and line 2 is blank |
| `Status` | Yes | Backlog, Ready or Done |
| `Kind` | Yes | One key of `KIND_LABELS`. The starter's keys are epic, feature, task, bug and docs |
| Routing line | Yes, where the board has a routing field | The line `ROUTING_FIELD` names, holding one value of `ROUTING_OPTIONS`. The starter's line is `Workstream`, with Go-to-market, Product or Platform |
| `Parent` | No | An existing card, never the card itself |
| `Blocked by` | No | Existing cards, never the card itself, as distinct numbers separated by a comma and a space |
| Comments | No | A single `## Comments` heading ends the body. Each `### ` line inside it starts a comment, and its heading is free, such as the host and date |

- `KIND_LABELS`, `ROUTING_FIELD` and `ROUTING_OPTIONS` come from `board-config.mjs`, so the table gives the starter's
  values.
- In board output and in the `job/{{NUMBER}}` branch name, `#{{NUMBER}}` names card `{{NUMBER}}`, never a GitHub issue.
- Line endings may be LF or CRLF.
- The field block runs to the first blank line. Each key appears at most once, and the read refuses an unknown key.
  `Status`, `Kind` and the routing line are required.
- The read refuses anything else in that folder by name: another file, a folder or a link. An absent folder is an empty
  board.
- No script reads or writes through a link at `.agents` or at its `cards` folder.
- Any refusal names the file and the line and stops the whole read, so a broken card never reads as a quiet board.

### Stored, published and shown states

The file stores only a status that is pickable or terminal: `Backlog`, `Ready` or `Done` (the board's
`PICKABLE_STATUSES` and `TERMINAL_STATUSES`). The file never stores `In progress`, `Awaiting push` or `In review`: the
board derives them from the repository and shows them.

- **The checkout copy** is the card file in the checkout the script sits in. `board-move` writes it and compares it for
  a no-op.
- **The published status** is the card's `Status` on `refs/remotes/origin/main`. Only a merge publishes an edit.
  A card absent there, filed on a branch not yet merged, takes its checkout copy's status unless that is `Done`. A
  card's first published status is Backlog or Ready, so a checkout-only `Done` fails the read. Its message reads
  `.agents/cards/<N>.md says Done but is not on origin/main; a card is first published as Backlog or Ready through a
  merged change`.
- A missing `refs/remotes/origin/main` fails the read and names the fetch to run. A published copy that does not parse
  also fails it, naming `origin/main:.agents/cards/<N>.md` and the line.

The board shows each card in a column derived from its published status and its job branch. The first rule that holds
wins, and rules 1 to 3 apply only to a card whose published status is Backlog or Ready.

| # | Fact | Column |
|---|---|---|
| 1 | An open pull request of this repository has head `job/{{NUMBER}}` | In review |
| 2 | Local `job/{{NUMBER}}` exists and its tip's copy of the card says `Done` | Awaiting push |
| 3 | Local `job/{{NUMBER}}` exists, or origin lists it | In progress |
| 4 | Otherwise | The published status |

- A card is CLOSED if and only if its published status is `Done`. A `Done` written on `job/{{NUMBER}}` is a pending
  closing edit. The card stays open and in flight until its pull request merges, as a GitHub issue stays open until
  its `Closes` line merges.
- For each card whose branch origin lists, the pull-request read is
  `gh pr list --repo {{OWNER}}/{{REPOSITORY}} --head job/{{NUMBER}} --state open`. It reads only the repository
  `board-config.mjs` names. Only an entry whose head is `job/{{NUMBER}}` and which is not from a fork counts.
- A card shows its kind as its one label, no assignee, each blocker's own state, and its children from the `Parent`
  lines. Only a counted open pull request is a closing pull request; the board never infers one from a branch.
- A pushed branch with no draft has no closing pull request. It reads Awaiting push in every worktree of a clone whose
  local `job/{{NUMBER}}` branch tip's copy of the card says `Done`. Otherwise it reads In progress, including in a
  clone that lacks that local branch, such as another machine's.
- Intake lists such a branch under claims. Where it reads In progress, the stalled-claim advisory reports it, as for a
  GitHub card between push and draft. Awaiting push is a waiting column, which that advisory exempts.
- The read uses the card files of the checkout the script sits in, never the current directory.
- If the read cannot read origin's branches, `origin/main`'s copies or a pull-request list, or a reply is malformed,
  the whole read fails. It exits 2 under `--intake` and 1 in every other mode, and never reads as "nothing in flight".

## Card commands

These entries cover the claim and the commands that move, file and close a card.

### The claim

The local branch `job/{{NUMBER}}` is the claim. After a push, origin's branch carries the claim to every other
checkout. There is no assignee and no `Claim:` comment. Git refuses a second local branch of the same name.

- Nothing coordinates two machines until push. Another machine's unpushed claim is invisible here, and origin refuses
  the push that loses as non-fast-forward.
- The intake summary prints `claim: branch job/<N> (local)`, `(origin)` or `(local and origin)` for a card, or
  `claim: none`.
- Release a card from an unfinished claim only as [Releasing a claim](#releasing-a-claim) says.

### Moving cards

`node scripts/board-move.mjs {{NUMBER}} {{STATUS}}` exits 0 when done, 1 on a refusal and 2 on a usage error.

| Target | What it does |
|---|---|
| Backlog, Ready, Done | Rewrites only the `Status:` line of this checkout's copy. Already there: the `already at <Status>` no-op line. It refuses in the integration checkout unless it is a no-op. It also refuses `Done` for a card absent from `origin/main`: `#<N> is not on origin/main; publish the card as Backlog or Ready through a merged change before closing it` |
| In progress | A claim check that writes nothing. It holds only when HEAD is `job/{{NUMBER}}`, the card's published status is Backlog or Ready, and origin either lacks `job/{{NUMBER}}` or its tip is an ancestor of HEAD. An origin tip not in this branch means the card is not free; a tip this clone lacks means the check could not confirm, and names `git fetch origin` |
| Awaiting push | A check: HEAD is `job/{{NUMBER}}` and this checkout's copy says `Done`. Otherwise it names the missing closing edit |
| In review | A check: origin's `job/{{NUMBER}}` tip equals HEAD and an open pull request of this repository has head `job/{{NUMBER}}`. Otherwise it names the missing push or draft |
| `--lane` | Refused: the markdown tracker has no parked lane |
| Anything else | Refused, listing the allowed statuses; `--batch` stops at the first failure and names the moves done |

`node scripts/board-add.mjs` files nothing on markdown: it exits 1 with a line pointing here.

### Filing a card

Filing is writing the file, then checking it.

1. Number the card one more than the highest `{{NUMBER}}` among the card files on the branch that holds it. The
   first card is 1.
2. Write `.agents/cards/{{NUMBER}}.md` in [the card file](#the-card-file) form, with `Status: Backlog` or
   `Status: Ready` and one `Kind:`. Add `Parent:` and `Blocked by:` lines for its links. Where the board has a routing
   field, add the routing line.
3. Run `node scripts/verify-issue-publish.mjs {{NUMBER}} [{{CHILD_NUMBER}}...]`. It reads the card files and prints
   that the card files, the statuses and routing values, and exactly one kind are verified. For one number it also
   prints whether the card is standalone or has children. For an epic with its children it prints that the child set
   is exact. A number with no file exits 1 with `#<N> has no card file .agents/cards/<N>.md in this checkout`.

Inside a job, file the card on the job branch. Outside a job, file it in a worktree on `cards/{{SLUG}}` and deliver it
as its own pull request. Two branches that file the same number collide at rebase as an add/add conflict, which is
loud. Others see the card on the board only once the change that adds it has merged.

### Closing a card

1. Before the fresh review, run `node scripts/board-move.mjs {{NUMBER}} Done` in the job worktree and commit the card
   file. The card reads Awaiting push there until the draft opens, then In review, and Done once the merge publishes
   the edit.
2. Write the pull request body's `Card: .agents/cards/{{NUMBER}}.md` line in place of `Closes #{{NUMBER}}`.
3. After the merge and a fetch, the card reads Done and CLOSED. Closeout's `board-move {{NUMBER}} Done` in the root
   checkout finds the copy already Done. `board.mjs --closeout` also scans clean, because rules 1 to 3 never apply to
   a published `Done`.

No step writes to the integration checkout: `board-move` refuses a change there, whether it runs plainly or with
inherited repository variables pointing elsewhere.

## Releasing a claim

Returning an unfinished card to its published column (Ready for a card picked from Ready) means removing its job
branch, locally and on origin. It happens only on the owner's decision naming the exact branch. It is never part of
automatic cleanup. The Leftover rule treats unmerged work as live, and its live-work test and the worktree and branch
safeguards stay as they are. A session never frees a card on its own judgment, since another machine may still be
building it.

## What each card step becomes

Where a skill or charter names a `gh` card step, the markdown tracker does this instead. A step the table does not list
stays the same.

| Step | Markdown |
|---|---|
| Read a card (`resume` intake and start, `to-issues`, the `architect` and `reviewer` charters) | Read `.agents/cards/{{NUMBER}}.md` in the job worktree, and the pick view and card summary from `node scripts/board.mjs --intake {{FOLDER}}`, with the card's full text in the file its summary names. `cross-review` puts the file's text into the review prompt where it puts `gh issue view` output, and copies the file where it writes the plan review's card file |
| Claim command (`resume`, "3. Start the job") | `node scripts/board-claim.mjs` serves only the GitHub Projects tracker and refuses a markdown install with exit 1. This tracker claims by hand as [the claim reads](../.agents/skills/resume/references/claim-reads.md) say, with the rows of this table |
| Is the card free (`resume`, "3. Start the job") | After the post-selection fetch, `node scripts/board.mjs --intake {{FOLDER}}` is the one read. The card is free when it is in Backlog or Ready and its summary reads `claim: none`. A card in another column or with a claim is not free, and a failed or incomplete read is could not confirm; `resume` handles both |
| Claim: assignee, `Claim:` comment, re-read | None of them. Create the worktree and `job/{{NUMBER}}` branch from the recorded `origin/main`, then run `node scripts/board-move.mjs {{NUMBER}} "In progress"` in the worktree. A refusal means another branch holds the card: start nothing, remove the worktree and branch this session created, and tell the owner |
| Awaiting push (`resume`, "7. Push authorisation") | The closing edit comes first: before the fresh review, run `node scripts/board-move.mjs {{NUMBER}} Done` in the job worktree and commit the card file. Then `board-move {{NUMBER}} "Awaiting push"` checks it |
| Verdict and Stage 2 evidence (`resume`, "7. Push authorisation") | A `### Verdict: ...` entry in the card file, committed on `job/{{NUMBER}}` in its worktree, on a carried yes by the carried session once the check "Saved write-up" gives has passed, and on any other carried answer by the carried session once the carry has started. On a yes, before "8. Deliver", where it is a commit added on top under Receipt reuse. A later batch review accepts a review folder whose head differs from `HEAD` only by such commits, proved by `git diff --name-only {{FOLDER_HEAD}} HEAD` printing that card file alone and `git diff {{FOLDER_HEAD}} HEAD -- {{CARD_FILE}}` adding only `### Verdict:` entries and blank lines and removing nothing. A Markdown claim names no machine, so a batch review's condition on the newest claim reads instead that the intake document prints `claim: branch job/<N> (local)`: a waiting job is unpushed, and a branch also on `origin` may be newer than this copy. On a no, with the `### Needs owner:` entry, after `board-move {{NUMBER}}` to the card's published status takes back the closing edit, so the branch reads In progress. Read a held card from the branch copy as the Needs owner row says. The read lists unmerged refs with `git branch -a --no-merged origin/main --format='%(refname)'`, and reads each card's entries from one copy, its unmerged branch where one is listed and otherwise `origin/main`, in file order, which decides which is newer; a failed read is unavailable evidence. An approved push is a card whose file reads Done on `origin/main`. Entries name no author, so the read checks none. The share of suggested cards accepted reads `not measurable: declined suggestions leave no record in a Markdown tracker` |
| The `Closes #{{ISSUE}}` line | `Card: .agents/cards/{{NUMBER}}.md`. A closing word never precedes a `#{{NUMBER}}`, because `#{{NUMBER}}` names a GitHub item. A markdown job always takes the pull request route of "8. Deliver", because the card file is outside the documentation locations the direct route admits |
| Draft opened, In review | When the draft opens and the branch is pushed, run `board-move {{NUMBER}} "In review"`; it is a check, not a move |
| `handoff`, step 5 | Nothing to move: the card stays a claim by its branch, and its draft reads In review |
| `closeout`, step 2 (issue state) | After `git fetch origin main`, `git show origin/main:.agents/cards/{{NUMBER}}.md` shows `Status: Done`. When the pull request resolved a card that it did not name, report that card; never close it unasked |
| `closeout`, step 4 (Done and scan) | After Update local main, `board-move --batch {{NUMBER}}:Done` finds the card already Done and prints the no-op line, and `node scripts/board.mjs --closeout` scans clean. Set a card closed other than by its job's pull request to Done on a `cards/{{SLUG}}` worktree, and deliver that as its own change |
| `closeout`, Leftover rule, open-card search | List the unmerged branches with `git branch -a --no-merged origin/main --format='%(refname)'`, then run `git grep -n -F -e "{{FILE_NAME}}" origin/main {{LISTED_REFS}} -- .agents/cards`, with `gh api` search kept for pull requests. A hit in a card on `origin/main` whose `Status` is not `Done`, or a hit in a card on any listed branch, keeps the file live, and the output names the ref it came from; exit 1 with no output is a complete miss, and any other failure is unavailable evidence |
| `closeout`, Leftover rule, card state and most recent claim | The state is the `Status:` line of `origin/main`'s copy. The claim is the branch itself: `job/{{NUMBER}}` locally or on origin. Unmerged work stays live, as the rule says |
| Release an unfinished claim | Only as [Releasing a claim](#releasing-a-claim) says |
| `gh issue create` and `board-add` | Write the card file as [Filing a card](#filing-a-card) says; `board-add` refuses |
| Suggested card (`resume`, "2. Work-pick") | No run files one: a card publishes only by a merged change and a run pushes nothing, so the summary names each as offered and not filed. The owner's own message files it under [Filing a card](#filing-a-card), with no prefix and with the `Product manager run:` line. Declined suggestions leave no record, so the share accepted is unavailable here |
| Blocked-by and sub-issue links | The `Blocked by:` and `Parent:` lines |
| Label edits | The `Kind:` line, one value |
| Comments | A `### ` entry under `## Comments` in the card file. A merged change publishes it, like any edit |
| Return a card to Backlog or Ready outside a job | `board-move {{NUMBER}} Backlog` or `Ready` in a worktree on `cards/{{SLUG}}`, delivered as its own change |
| Needs owner (`resume`, "2. Work-pick") | A comment cannot publish without a merge, so the hold lives on local `job/{{NUMBER}}`. A job commits the `### Needs owner: ...` entry on its branch and moves nothing. An unstarted card gets a branch from the recorded `origin/main` with only that entry, and the session removes its worktree afterwards. The branch is the claim that keeps the card out of picks, and the card reads `In progress`, so expect the stalled-claim advisory for it. The intake document does not carry a branch's comment, so wherever `resume` names, counts or summarizes held cards, read each local `job/{{NUMBER}}` branch's copy with `git show job/{{NUMBER}}:.agents/cards/{{NUMBER}}.md` first. In the run's waiting check, a parked job's machine is the one its branch copy's `Job:` names, since Markdown claims name none; a missing `Job:` or another machine is a stop. A parked job's entry is on this machine's own branch, so the account and comment-number reads of `resume` do not apply: the parked-job checks read its `Job:` alone, and the session edits the entry there. The owner returns an unstarted card by deleting that branch |
| Cloud build | None: a markdown install starts no cloud build |
| Documentation sweep | None: init asks no sweep question on markdown and refuses `docSweep: true` |

## Moving to a GitHub board

When a team grows, one command moves the cards onto a GitHub Project board. Run it from the Fabraik distribution the
repository was installed from, in a linked `cards/{{SLUG}}` worktree cut from fresh `origin/main`:

```sh title="Terminal"
node {{DISTRIBUTION}}/scripts/fabraik.mjs move-cards --answers {{ANSWERS_FILE}} --target {{WORKTREE}}
```

- Each card becomes an issue on the board. The issue carries the card's title, body, status as the board column and
  kind as the kind label. It also carries the routing value as the `Workstream` field, `Parent` as a sub-issue link and
  `Blocked by` as native blockers.
- The move closes a `Done` card and leaves any other card open. It puts the comments into the issue body under
  `## Comments`, not into GitHub comments.
- GitHub numbers the new issues, so the command prints one line per card, `card <N> is #<M> (<Status>)`, for the move's
  pull request description. A `#{{NUMBER}}` written in free text stays as written.
- The command writes no card file. It replaces only the board settings file, and only last. The card files stay until
  the move's own pull request removes them. Until then they are inert, because the board scripts read cards only under
  the markdown tracker.
- The command refuses, writing nothing, while any `job/{{NUMBER}}` branch exists, locally or on origin. It also refuses
  while any open pull request changes a card. Land or release the claims first.

`{{DISTRIBUTION}}/docs/INSTALL.md` owns the answers file, every refusal, the exit codes and the steps after the move.

## Limits

- One person. Two machines on one install see each other's claim only after a push and a fetch. A stale `origin/main`
  shows a merged card still in flight until the next fetch.
- Pull requests, checks and merges still need GitHub; a repository with no remote is out of scope.
- A read needs origin and `gh` reachable. Offline it fails loudly with exit 2 under `--intake` and 1 otherwise, and
  never reads as a free board.
- Card edits outside a job travel as their own pull request. The direct route never admits a card file.
- No documentation sweep and no cloud build, since both act on GitHub issues. A markdown install that later sets
  `docSweep` to true by hand gets a sweep that files GitHub issues. The settings check does not read the tracker.
- The move is one-way: no command covers the reverse, from a GitHub board to markdown cards.

## Where to go next

- [Moving to a GitHub board](#moving-to-a-github-board) moves the cards onto a GitHub Project board once a team grows.
- [The resume skill](../.agents/skills/resume/SKILL.md) picks a card and starts its job.
- [The life of one change](AI-WORKFLOW-job.md) shows when a job moves its card.
- [Other trackers](AI-WORKFLOW-board.md#other-trackers) compares Markdown cards with the other trackers.
