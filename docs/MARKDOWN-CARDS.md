# Markdown cards

Markdown cards are for one person working alone. A team should choose the GitHub Project board: two people, or two
machines, working on one markdown install are not coordinated until push, and the second claim is refused only
then. Everything below follows from that. A repository chooses markdown at install, and the choice is the line
`export const TRACKER = "markdown";` in `scripts/lib/board-config.mjs`; a configuration without it is a GitHub board.

This manual owns the card format, the states a card is shown in and what each card step becomes where cards are
files. Every skill and charter that runs a card step points here. The exact behaviour of each command is in
[`scripts/lib/board-markdown.mjs`](../scripts/lib/board-markdown.mjs), whose head owns its reads and refusals. Pull
requests, checks and merges still run on GitHub, so a markdown install records its GitHub owner, owner type and
repository name in `board-config.mjs`, with `BOARD_PROJECT_NUMBER = null` because there is no project.

## The card file

One file per card at `.agents/cards/<N>.md`.

- `<N>` is a positive integer with no leading zero and no larger than 9007199254740991, and the file name is the card
  number. In board output and in the `job/<N>` branch name, `#<N>` names card `<N>`, never a GitHub issue.
- Anything else in that folder is refused by name: another file, a folder or a link. An absent folder is an empty board.
- Nothing is read or written through a link at `.agents` or at its `cards` folder, whichever script runs.

The file is read strictly:

```
# <title>

Status: Backlog | Ready | Done
Kind: <epic, feature, task, bug or docs>
Workstream: <Go-to-market, Product or Platform>   (only when the board has a routing field; then required)
Parent: <N>                                       (optional)
Blocked by: <N>, <N>                              (optional)

<body>

## Comments

### <free heading, such as the host and date>
<text>
```

- `Kind` is a key of `KIND_LABELS`, and the routing line is named by `ROUTING_FIELD` with a value of
  `ROUTING_OPTIONS`; both come from `board-config.mjs`, so the lines above are the starter's.
- Line endings may be LF or CRLF. Line 1 is `# ` and a non-empty title, and line 2 is blank.
- The field block runs to the first blank line. Each key appears at most once and an unknown key is refused. `Status`,
  `Kind` and the routing line are required.
- `Parent` and `Blocked by` name existing cards, never the card itself. `Blocked by` holds distinct numbers separated
  by a comma and a space.
- A single optional `## Comments` heading ends the body, and each `### ` line inside it starts a comment.
- Any refusal names the file and the line and stops the whole read, so a broken card never reads as a quiet board.

## Stored, published and shown states

The file stores only a status that is pickable or terminal: `Backlog`, `Ready` or `Done` (the board's
`PICKABLE_STATUSES` and `TERMINAL_STATUSES`). `In progress`, `Awaiting push` and `In review` are never written;
they are shown, derived from the repository.

- **The checkout copy** is the card file in the checkout the script sits in. `board-move` writes it and compares it for
  a no-op.
- **The published status** is the card's `Status` on `refs/remotes/origin/main`. Only a merge publishes an edit.
  A card absent there, filed on a branch not yet merged, takes its checkout copy's status unless that is `Done`: a
  card is first published as Backlog or Ready, so a checkout-only `Done` fails the read with
  `.agents/cards/<N>.md says Done but is not on origin/main; a card is first published as Backlog or Ready through a
  merged change`.
- A missing `refs/remotes/origin/main` fails the read and names the fetch to run, and a published copy that does not
  parse fails it, naming `origin/main:.agents/cards/<N>.md` and the line.

The board shows each card in a column derived from its published status and its job branch. The first rule that holds
wins, and rules 1 to 3 apply only to a card whose published status is Backlog or Ready.

| # | Fact | Column |
|---|---|---|
| 1 | An open pull request of this repository has head `job/<N>` | In review |
| 2 | Local `job/<N>` exists and its tip's copy of the card says `Done` | Awaiting push |
| 3 | Local `job/<N>` exists, or origin lists it | In progress |
| 4 | Otherwise | The published status |

- A card is CLOSED if and only if its published status is `Done`. A `Done` written on `job/<N>` is a pending closing
  edit: the card stays open and in flight until its pull request merges, as a GitHub issue stays open until its
  `Closes` line merges.
- The pull-request read is `gh pr list --repo <owner>/<repository> --head job/<N> --state open`, bound to the
  repository `board-config.mjs` names, for each card whose branch origin lists. Only an entry whose head is `job/<N>`
  and which is not from a fork counts.
- A card shows its kind as its one label, no assignee, each blocker's own state, and its children from the `Parent`
  lines. A closing pull request is only ever a counted open one, never inferred from a branch.
- A pushed branch with no draft reads Awaiting push in every worktree of a clone whose local `job/<N>` branch tip's
  copy of the card says `Done`, and In progress otherwise, including in a clone that lacks that local branch (such as
  another machine's); it has no closing pull request. Intake lists it under claims, and the stalled-claim advisory
  reports it where it reads In progress, as for a GitHub card between push and draft, because Awaiting push is a
  waiting column that advisory exempts.
- The read uses the card files of the checkout the script sits in, never the current directory. If origin's branches,
  `origin/main`'s copies or a pull-request list cannot be read, or a reply is malformed, the whole read fails with exit
  2 under `--intake` and exit 1 in every other mode; it never reads as "nothing in flight".

## The claim

The local branch `job/<N>` is the claim, and once pushed, origin's branch carries it to every other checkout. There is
no assignee and no `Claim:` comment. Git refuses a second local branch of the same name.

- Two machines are not coordinated until push. Another machine's unpushed claim is invisible here, and the push that
  loses is refused as non-fast-forward.
- The intake document prints `claim: branch job/<N> (local)`, `(origin)` or `(local and origin)` for a card, or
  `claim: none`.
- A card is released from an unfinished claim only as [Releasing a claim](#releasing-a-claim) says.

## Moving cards

`node scripts/board-move.mjs <N> <Status>` exits 0 when done, 1 on a refusal and 2 on a usage error.

| Target | What it does |
|---|---|
| Backlog, Ready, Done | Rewrites only the `Status:` line of this checkout's copy. Already there: the `already at <Status>` no-op line. Refused in the integration checkout unless it is a no-op. `Done` is also refused for a card absent from `origin/main`: `#<N> is not on origin/main; publish the card as Backlog or Ready through a merged change before closing it` |
| In progress | A claim check that writes nothing. It holds only when HEAD is `job/<N>`, the card's published status is Backlog or Ready, and origin either lacks `job/<N>` or its tip is an ancestor of HEAD. An origin tip not in this branch means the card is not free; a tip this clone lacks means the check could not confirm, and names `git fetch origin` |
| Awaiting push | A check: HEAD is `job/<N>` and this checkout's copy says `Done`. Otherwise it names the missing closing edit |
| In review | A check: origin's `job/<N>` tip equals HEAD and an open pull request of this repository has head `job/<N>`. Otherwise it names the missing push or draft |
| `--lane` | Refused: the markdown tracker has no parked lane |
| Anything else | Refused, listing the allowed statuses; `--batch` stops at the first failure and names the moves done |

`node scripts/board-add.mjs` files nothing on markdown: it exits 1 with a line pointing here.

## What each card step becomes

Where a skill or charter names a `gh` card step, the markdown tracker does this instead. A step not listed is the same.

| Step | Markdown |
|---|---|
| Read a card (`resume` intake and start, `to-issues`, the `architect` and `reviewer` charters) | Read `.agents/cards/<N>.md` in the job worktree, and the pick view and card sections from `node scripts/board.mjs --intake`. `cross-review` puts the file's text into the review prompt where it puts `gh issue view` output, and copies the file where it writes the plan review's card file |
| Is the card free (`resume`, "3. Start the job") | After the post-selection fetch, `node scripts/board.mjs --intake` is the one read. The card is free when it is in Backlog or Ready and its section reads `claim: none`. A card in another column or with a claim is not free, and a failed or incomplete read is could not confirm; both are handled as `resume` handles them |
| Claim: assignee, `Claim:` comment, re-read | None of them. Create the worktree and `job/<N>` branch from the recorded `origin/main`, then run `node scripts/board-move.mjs <N> "In progress"` in the worktree. A refusal means another branch holds the card: start nothing, remove the worktree and branch this session created, and tell the owner |
| Awaiting push (`resume`, "7. Push authorisation") | The closing edit comes first: before the fresh review, run `node scripts/board-move.mjs <N> Done` in the job worktree and commit the card file. Then `board-move <N> "Awaiting push"` checks it |
| The `Closes #<issue>` line | `Card: .agents/cards/<N>.md`. A closing word never precedes a `#<N>`, because `#<N>` names a GitHub item. A markdown job always takes the pull request route of "8. Deliver", because the card file is outside the documentation locations the direct route admits |
| Draft opened, In review | `board-move <N> "In review"` after the draft opens and the branch is pushed; it is a check, not a move |
| `handoff`, step 5 | Nothing to move: the card stays a claim by its branch, and its draft reads In review |
| `closeout`, step 2 (issue state) | After `git fetch origin main`, `git show origin/main:.agents/cards/<N>.md` shows `Status: Done`. A card the pull request resolved but did not name is reported, never closed unasked |
| `closeout`, step 4 (Done and scan) | After Update local main, `board-move --batch <N>:Done` finds the card already Done and prints the no-op line, and `node scripts/board.mjs --closeout` scans clean. A card closed other than by its job's pull request is set to Done on a `cards/<slug>` worktree and delivered as its own change |
| `closeout`, Leftover rule, open-card search | List the unmerged branches with `git branch -a --no-merged origin/main --format='%(refname)'`, then run `git grep -n -F -e "<file name>" origin/main <each listed ref> -- .agents/cards`, with `gh api` search kept for pull requests. A hit in a card on `origin/main` whose `Status` is not `Done`, or a hit in a card on any listed branch, keeps the file live, and the output names the ref it came from; exit 1 with no output is a complete miss, and any other failure is unavailable evidence |
| `closeout`, Leftover rule, card state and latest claim | The state is the `Status:` line of `origin/main`'s copy. The claim is the branch itself: `job/<N>` locally or on origin. Unmerged work stays live, as the rule says |
| Release an unfinished claim | Only as [Releasing a claim](#releasing-a-claim) says |
| `gh issue create` and `board-add` | Write the card file as [Filing a card](#filing-a-card) says; `board-add` refuses |
| Blocked-by and sub-issue links | The `Blocked by:` and `Parent:` lines |
| Label edits | The `Kind:` line, one value |
| Comments | A `### ` entry under `## Comments` in the card file. It is published by a merged change like any edit |
| Return a card to Backlog or Ready outside a job | `board-move <N> Backlog` or `Ready` in a worktree on `cards/<slug>`, delivered as its own change |
| Cloud build | None: a markdown install starts no cloud build |
| Documentation sweep | None: init asks no sweep question on markdown and refuses `docSweep: true` |

## Filing a card

Filing is writing the file, then checking it.

1. A new number is one more than the highest `<N>` among the card files on the branch the file is written on;
   the first card is 1.
2. Write `.agents/cards/<N>.md` in the format above, with `Status: Backlog` or `Status: Ready`, one `Kind:`, the
   routing line when the board has one, and `Parent:` and `Blocked by:` lines for its links.
3. Run `node scripts/verify-issue-publish.mjs <N> [child#...]`. It reads the card files and prints that the card files,
   the statuses and routing values, and exactly one kind are verified, and for one number whether the card is
   standalone or has children, or for an epic with its children that the child set is exact. A number with no file
   exits 1 with `#<N> has no card file .agents/cards/<N>.md in this checkout`.

Filing inside a job rides on the job branch. Filing outside a job uses a worktree on `cards/<slug>` and is delivered as
its own pull request. Two branches that file the same number collide at rebase as an add/add conflict, which is loud.
A card is on the board for others only once the change that adds it has merged.

## Closing a card

1. Before the fresh review, run `node scripts/board-move.mjs <N> Done` in the job worktree and commit the card file.
   The card reads Awaiting push there until the draft opens, then In review, and Done once the merge publishes the edit.
2. Write the pull request body's `Card: .agents/cards/<N>.md` line in place of `Closes #<N>`.
3. After the merge and a fetch, the card reads Done and CLOSED. Closeout's `board-move <N> Done` in the root checkout
   finds the copy already Done, and `board.mjs --closeout` scans clean, because rules 1 to 3 never apply to a published
   `Done`.

The integration checkout is never written to: `board-move` refuses a change there, whether the script is run plainly
or with inherited repository variables pointing elsewhere.

## Releasing a claim

Returning an unfinished card to its published column (Ready for a card picked from Ready) means removing its job
branch, locally and on origin. It happens only on the owner's decision naming the exact branch. It is never part of
automatic cleanup: the Leftover rule treats unmerged work as live, and its live-work test and the worktree and branch
safeguards stay as they are. A session never frees a card on its own judgment, since another machine may still be
building it.

## Moving to a GitHub board

A person whose team grows moves the cards onto a GitHub Project board with one command, run from the Fabraik
distribution the repository was installed from, in a linked `cards/<slug>` worktree cut from fresh `origin/main`:

```
node <distribution>/scripts/fabraik.mjs move-cards --answers <file> --target <worktree>
```

- Each card becomes an issue on the board. It carries the card's title and body, its status as the board column, its
  kind as the kind label, its routing value as the `Workstream` field, its `Parent` as a sub-issue link and its
  `Blocked by` as native blockers. A `Done` card is closed; any other card is open. The comments are not copied as
  GitHub comments: they go into the issue body under `## Comments`.
- GitHub numbers the new issues, so the command prints one line per card, `card <N> is #<M> (<Status>)`, for the move's
  pull request description. A `#<N>` written in free text stays as written.
- The command writes no card file. It replaces only the board settings file, and only last, so the card files stay
  until the move's own pull request removes them; until then they are inert, because the board scripts read cards only
  under the markdown tracker.
- It is refused, with nothing written, while any `job/<N>` branch exists, locally or on origin, or any open pull
  request changes a card. Land or release the claims first.

`<distribution>/docs/INSTALL.md` owns the answers file, every refusal, the exit codes and the steps after the move.

## Limits

- One person. Two machines on one install see each other's claim only after a push and a fetch, and a stale
  `origin/main` shows a merged card still in flight until the next fetch.
- GitHub is still required for pull requests, checks and merges; a repository with no remote is out of scope.
- A read needs origin and `gh` reachable. Offline it fails loudly with exit 2 under `--intake` and 1 otherwise, and
  never reads as a free board.
- Card edits outside a job travel as their own pull request. The direct route never admits a card file.
- No documentation sweep and no cloud build, since both act on GitHub issues. A markdown install that later sets
  `docSweep` to true by hand gets a sweep that files GitHub issues: the settings check does not read the tracker.
- The move is one-way: the reverse, from a GitHub board to markdown cards, is not covered.
