---
name: to-issues
description: Turn work into properly-formed board issues — either decompose a plan/spec/Epic into tracer-bullet vertical slices, or capture a single bug, feature idea, or suggestion as one well-formed issue.
---

# To Issues

Two shapes, one publish pipeline: **decompose** a plan/spec/Epic into ordered, bounded, shippable vertical slices
(tracer bullets), or **capture** a single bug, feature idea, or suggestion as one issue (slicing collapses to one;
routing, body shape, publish, and verify are identical).

Claude may invoke this skill, but Step 4 (owner approval) is a HARD gate on every ordinary model-invoked
proposal: create NOTHING on the board until the owner approves. Exceptions, none owned or gated by
`/to-issues`: a follow-up card, in `Backlog`, for work an approved job surfaces and genuinely cannot finish,
filed under the "Owner gates" rule in `AGENTS.md`; an issue the day-after sweep triage filed under its own manual
(`docs/SWEEP-TRIAGE.md`), which the `resume` intake cards in `Backlog`; and any further exception
`docs/ISSUE-TRACKER.md` records. An exception skips the step 4 approval gate, not the links rule: an
issue created with gh still records blockers and parents as built-in links (step 6), never as body text. The sweep
triage, which has no gh, carries its manual's `Blocked by:` line instead.

## Process

### 1. Gather context

Work from the plan/spec/Epic in the conversation. If the owner passes an issue number, fetch it first:

```bash
gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[] | "--- comment by \(.author.login) (\(.authorAssociation)) ---", .body)'
```

Never `--comments` alone: it replaces the body with a comments-only view and prints nothing, at exit 0, on an
issue with none.

### 2. Explore the codebase (optional)

Read enough of the code and documents the Architecture seams sections of `AGENTS.md` and `.agents/REPOSITORY.md` name to ground the breakdown in real seams.
Use `GLOSSARY.md` vocabulary and respect the applicable scoped rules. If a slice needs groundwork first, that
prefactor is its own slice, ordered first.

### 3. Draft vertical slices

Single bug/idea → one issue in the Step-7 shape, route it (Step 5), then Step 4. Otherwise break the plan into
tracer-bullet issues: each a thin vertical slice cutting through ALL layers end-to-end (input, rule, presentation,
test), never a horizontal layer slice. Each slice is demoable or verifiable on its own and sized to a bounded
`builder` handoff; an open-ended "build the whole feature" splits further. Slices that own disjoint paths are
worth cutting as separate issues precisely because separate issues are the unit of lane parallelism: co-selected
disjoint-path issues can build as concurrent lanes.

Size signals, judged once by the owner at Step 4, apply to a single captured idea as much as to a breakdown: the
outcome fits one sentence a reviewer could demonstrate, and more than five distinct outcome or invariant
statements, checkbox or bullet, is a signal to make the work an epic parent with native child slices. An
epic parent holds no acceptance criteria of its own; any whole-journey or end-to-end check becomes its last
child, blocked by the others, so the parent closes when its children do. No later seat stops, replans, splits
or refuses work on these signals or on a line count; after work-pick the only split is the plan-time finding in
the `resume` skill's Plan section.

### 4. Quiz the owner

Present the breakdown as a numbered list showing per slice: **Title**, **Blocked by**, **Required
capabilities**, plus its one-sentence outcome and its count of outcome or invariant statements, flagging any count
above five. An instruction to file an issue approves the idea, not a proposal the owner has not seen, so a single
captured idea is presented here too. Ask: granularity right? dependencies correct? merge or split anything? Iterate
until the owner approves; create nothing until they do.

### 5. Route each slice

- **Required capabilities:** the planning, review, or specialist capability the slice needs. Never name a builder
  seat: the plan chooses one per slice under the build-seat rule in `.claude/agents/architect.md`.
- Plan-first surfaces are the `plan-first` row of the Surfaces table in `AGENTS.md`. A slice touching one is
  marked plan-first in the body regardless of how mechanical it looks.

### 6. Publish to the board, in dependency order

Publish blockers first: a blocker must exist before a later issue can link to it. If you CREATED a new parent
Epic, it is a board item too — run a-b for it and link every child as a native sub-issue (step c). Every item gets
a Workstream.

**a. Create:**

```bash
gh issue create \
  --title "..." \
  --label "<kind label>[,<other labels that fit>]" \
  --blocked-by <N>[,<N>...] \
  --body "..."
```

Every issue carries exactly one kind label, the one `KIND_LABELS` in `scripts/lib/board-config.mjs` records for the
issue's kind, chosen by what the issue is: epic for a parent whose work is its native child issues; bug for
behaviour that contradicts what the code, a test or a document says it does; feature for a new or changed
capability for the people using the product; docs for a change to documents or prose alone; task for any other
bounded work, such as tooling, a refactor, research or a recorded decision. When two fit, the first in that order
wins. Step 8's verifier fails an issue with none or more than one. The other labels are those the repository's
`docs/ISSUE-TRACKER.md` names.

`--blocked-by` takes each owner-approved blocker and needs gh 2.94 or later; omit it when the slice has none. A
blocker and a parent live only in GitHub's built-in links, never in the body. The link is a second call after
creation, so step 8 reads it back. A blocker added after creation uses `gh issue edit <N> --add-blocked-by <M>`.
Because gh creates the issue before it adds the links, a failed create carrying `--blocked-by` may already have
made the issue without printing its number: find it by exact title before retrying,
`gh issue list --state all --author @me --limit 20 --json number,title --jq '.[] | select(.title == "<title>") | .number'`,
and add the missing link with `gh issue edit <N> --add-blocked-by <M>` instead of creating again.

**b. Board, with Status and Workstream, in one idempotent step (once per issue):**

```bash
node scripts/board-add.mjs <ISSUE_N> <Status> <Workstream>
```

Use `board-move.mjs` only to move an existing card, never to create one.

**A card for another repository** is filed from a checkout of that repository, never from this one:
`board-add.mjs` and the step 8 verifier act on the board of the checkout they run in. Run steps a, b and 8 there,
with labels from that repository's own set and the Workstream by its convention, so the card arrives with its
labels, column and Workstream together. With no checkout of that repository, create the issue with
`gh issue create --repo <owner>/<repo>` and that repository's labels, then tell the owner the card still needs its
Workstream, set by running step b in that repository; never report it as filed complete.

**c. Link each child to its parent Epic as a native sub-issue** (a markdown checklist is NOT a sub-issue):

Look up the two node IDs first, one command each, `<PARENT_ID>` from the Epic and `<CHILD_ID>` from the child:

```bash
gh issue view <EPIC_N> --json id --jq .id
```

```bash
gh issue view <CHILD_N> --json id --jq .id
```

Then link them in one command, with both IDs typed as literals:

```bash
gh api graphql \
  -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p subIssueId:$c}){subIssue{number}}}' \
  -f p=<PARENT_ID> -f c=<CHILD_ID>
```

New backlog items go to **Backlog** until the owner promotes them.

Choose the Workstream by the convention in [`docs/ISSUE-TRACKER.md`](../../../docs/ISSUE-TRACKER.md#workstream-convention).

### 7. Issue body shape

Keep file paths and code snippets OUT of the body; point to the relevant doc, since the builder rereads the real
code at handoff time.

<issue-template>
## Problem

What's missing or broken, in one or two sentences.

## What to build

The end-to-end behaviour of this slice; name the seam it runs through without pinning a file path. A slice
admitting workflow machinery through the friction route, new or added to existing machinery, names the friction
here and what doing less was tried first: fewer checks, deleted work, or a native feature (the machinery rule
in the `resume` skill under "4. Plan", which also names the cards that list the machinery they keep).

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Required capabilities

The planning, review, or specialist capabilities required, provider-neutral; never a builder seat.

## Documentation impact

Choose exactly one honest outcome:

- `No documentation change: <reason>.`
- `Update <authoritative doc>: <what changes>.`

Plus any further section [`docs/ISSUE-TRACKER.md`](../../../docs/ISSUE-TRACKER.md#issue-body-sections) requires.
</issue-template>

Do NOT close or edit the parent Epic issue.

### 8. Verify the publish (fail loud, do not skip)

Run the shared verifier once with the Epic followed by every child (a standalone issue takes one number):

```bash
node scripts/verify-issue-publish.mjs <EPIC_N> <CHILD_N...>
```

Report its four results: board presence, Statuses and Workstreams, the one kind label, native child count. On
failure, read WHICH failure: `absent from the board` means the publication genuinely failed — fix before reporting
ready; `needs exactly one kind label` means correct that issue's labels with `gh issue edit <N> --add-label` or
`--remove-label`, then re-run; `is archived on the board` means unarchive that card, never add a second;
`is on the board but not in this board read` and `is not on this board read` mean the read lagged — re-run the
verifier, never add again; `could not confirm whether` means fix the named cause. A silent skip here is the exact
failure this skill already made once.

Then read every published issue's blockers back from GitHub and report them against the owner-approved list; a
missing or extra link is a failure to fix before reporting ready:

```bash
gh api "repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by" --jq '.[].number'
```

## Example

Decomposing an Epic into cards: first slice the prefactor the others need, then one slice per vertical capability,
never "the API client" / "the UI" as separate issues.
