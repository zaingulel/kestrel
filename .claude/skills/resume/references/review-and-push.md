# Review and push

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 4. Plan: the plan review

- The plan review runs the configured `plan-reviewer` of the other family: Claude-written plans go to Codex,
  Codex-written plans to Claude, through `cross-review` section 4. That pass waits on the cross-family authorization
  section 6 reads. When authorization is declined, the other family cannot be reached, a review fails or is capped, or
  the repository's settings file names one runtime, read [references/review-routes.md](review-routes.md)
  whole before the plan review runs again or another seat reviews the plan. In a cloud build, read "Reviews in a cloud
  build" in [references/cloud-build.md](cloud-build.md) before the plan review runs.

## 6. Verify and review

- **Visual work.** Read [references/visual.md](visual.md) whole before driving any visual work.
- Run every check the Surfaces table's rows name for a surface the diff touches.
- Before dispatching any review pass, rerun each convergence check whose latest worklog receipt does not hold
  for the clean committed head sent to review under the **Receipt reuse** rule in
  [references/deliver.md](deliver.md).
- Before dispatching the review, audit each `strict-tdd` claim's worklog and diff for the meaningful pre-implementation
  failure and coordinator validation required by "5. Build". A genuine chronology miss goes to the owner before
  review as the existing decision on accepting that claim without its required red run. Follow `AGENTS.md`'s
  Owner gates and Compact instructions: record the gap and accepted scope, quoting the exact question and
  owner approval verbatim. Reuse that acceptance only within the session that obtained it and its exact scope, following those
  gates after compaction; do not repeatedly ask about the same accepted gap there. A fresh session cannot infer
  approval from an earlier session, worklog or memory. Later checks against the base or convergence mutations
  prove current behaviour only: they never repair chronology or waive the decision automatically. A new claim
  or gap outside that acceptance needs its own decision.
- Before dispatching the review, file every card the acceptance criteria require, in this repository or another, as
  the `to-issues` skill says. A card that can only be filed after the merge, such as one that must cite the merge
  commit, is named under **Not done** in the pull request body as closeout's to file.
- One fresh review of the final tree, at the tier two questions choose. Both are asked of every change: can it be
  undone, and how far does the damage reach if it is wrong. Each repository says what the two questions mean for it in
  the `hard to undo` and `wide reach` rows of its Surfaces table.
  - **Hard to undo** is judged looking forward: once the change is published or adopted, could it be put right by a
    known correction under the repository's own control? A change that could not is hard to undo, and the
    `hard to undo` row names what could not, which in one repository or another is a release, a GitHub setting or
    ruleset, a data migration, a leaked secret, or anything an adopter would have to repair itself. That git can
    revert the commit never makes a change easy to undo. That an adopter has already copied it never makes one hard
    to undo, because at review time none has.
  - **Wide reach** is a shared file, which is a file the manifest lists, or a file that directs every later session in
    the repository, which the `wide reach` row names.
  - **Find out first.** Not knowing what a change affects is settled by finding out, and is never itself a reason for
    a heavier tier. The session works out what the change affects and acts in proportion to that, so the heavier
    course is a conclusion from what it found and never a default for not having looked. For the two questions it
    reads the diff, establishes what each changed file is and what depends on it, and answers from the two
    definitions above, which decide where a row is silent.
  - **A mixed change** is one whose parts answer the two questions differently; a part is the changed files that
    answer both alike. The session lists the parts from the diff, answers both questions for each part on its own,
    and states which part sets the tier and why, in the pull request body's `Undo:` and `Reach:` lines: the change
    takes the tier of the part that takes the heaviest, and a part the guard rule below names takes `sign-off` as
    that rule says. Answers are never added across parts: one part that is hard to undo and another that is wide in
    reach make a `sign-off` change only where a single part is both. The one fresh review still covers the whole
    final tree, at that tier, because a reviewer shown one part cannot see what the parts do to each other and
    the external review, where the add-on is on, reads a whole pull request. The `document` tier keeps its anchor, the
    gate's exit on the whole change, and line count never lowers a tier.
- The two answers choose one of three tiers, each recorded in the review line under its name.
  - **`document`: the session reviews its own work.** The lightest tier is anchored, never judged: it is exactly the
    change the repository's gate for the direct route admits whole. On the committed final tree, record
    `git merge-base origin/main HEAD` as `<base>` and `git rev-parse HEAD` as `<head>`, check the gate with
    `test -x scripts/gates/pre-push-main`, then run `scripts/gates/pre-push-main <base> <head>`. Exit 0 is this tier.
    Any other exit is not, and neither is a gate that is missing or not executable, so a repository without the gate
    has no such tier. The guard rule below wins over the gate's exit: a change that touches the gate, its classifier
    or anything else the guard rule names is never this tier. A refusal from the gate at deliver withdraws this tier:
    the change returns to this section at the `code` tier before the pull request opens. Where the gate judges
    changed lines it admits a **setting-only seat change**, the one change to a shared file that stays at this tier. A
    seat change is setting-only when each changed seat file differs only in model, effort or turn-limit lines of its
    settings block (`model`, `effort` or `maxTurns` in a Claude seat's frontmatter, changed, added or removed; `model`
    or `model_reasoning_effort` above a Codex seat's `developer_instructions`, changed in value only), and the manifest
    differs only in the hash recorded for each such file.
  - **`code`: cross-family review.** Every other change below the `sign-off` tier: one easy to undo but wide in reach,
    one hard to undo but narrow in reach, and one easy to undo and narrow in reach that the gate does not admit, so a
    small test in a file only one repository has is reviewed here. `AGENTS.md`, `CLAUDE.md`, `.agents/REPOSITORY.md`,
    the rules, skills and every other seat-file change (instructions, tools, permissions, or any other line) are
    included. The `reviewer` charter is run by the model family that did not write the diff, through `cross-review`;
    an instruction that misreads a gate has cost more than most code. When the other family's seat cannot be reached, or
    the repository's settings file names one runtime, read [references/review-routes.md](review-routes.md)
    whole before the review runs on this family's seat.
    In a cloud build, read "Reviews in a cloud build" in [references/cloud-build.md](cloud-build.md) before
    any review runs.
    **Cross-family authorization.** A pass sent to the other family, the plan review of "4. Plan" included, gives that
    family's provider the code it reads, the diff, the plan and the card with its comments, so it runs only on the
    owner's authorization. Read it on the fetched `main` with the two commands "4. Plan" uses for plan approval: it is
    recorded only where the file is one JSON object holding `"crossFamilyReview": true`. No settings file, no such
    key, or a `runtimes` list naming both without it records none; a command that fails, a file that is not one JSON
    object or any other value leaves it unknown, which is never recorded, and the owner is told what the commands
    printed. Where it is recorded the pass runs with no owner question. Where it is not, nothing goes to the other
    family until the owner answers one plain-language question saying what the pass would share and that adding
    `"crossFamilyReview": true` to the settings file records the authorization for later jobs. A yes covers this job's
    cross-family passes; a no runs the same charter on this family's own seat, and the pull request body records that
    cross-family review was not authorized and the cross-family gate therefore not met. The authorization is no push
    authorisation or other approval and answers no permission prompt of either runtime or the operating system.
  - **`sign-off`: cross-family review, then the external review where the add-on is on.** A change that is both hard
    to undo and wide in reach: the same cross-family pass, its unavailability route included, then, in a repository
    that has turned the external review add-on on, the external review on the draft in section 8. In a repository with
    the add-on off that pass is the whole of this tier: nothing further is requested or waited for, and the six-field
    review line is the record of it. Where the other family is unavailable or the repository runs one runtime, read
    [references/review-routes.md](review-routes.md) whole before this tier's first pass runs on this family's
    seat.
    In a cloud build, read "Reviews in a cloud build" in [references/cloud-build.md](cloud-build.md) before
    this tier's first pass runs.
- **The external review add-on (optional).** A second, independent review of a `sign-off` tier change by an outside
  review service, requested on the draft pull request. It is off unless the repository's settings file holds
  `"greptile": true`. Read the setting on the fetched `main`, never from the files of the job, so a job cannot switch
  its own review off: the two commands Plan approval gives under "4. Plan" print the file. Read it again after the
  rebase in section 8, step 1, and after any later rebase there, each time on the `main` that rebase used, and deliver
  under the latest reading: a setting turned on in `main` since an earlier reading then counts. The add-on is off where
  the repository has no settings file, or where the file is one JSON object that holds no `greptile` key or holds
  `false`. It is on where the file holds `"greptile": true`. A command that fails, a file that is not one JSON object,
  any other value, or a key spelt nearly like it leaves the setting unknown, which is never off: open no pull request
  for a `sign-off` tier change and tell the owner what the commands printed. A job that changes the setting is delivered
  under the value the fetched `main` held. A job that turns the add-on off therefore still owes the external review
  where its tier is `sign-off`, though its own change has removed the add-on's files from its worktree: it reads the
  add-on's skill from the fetched `main` with `git show origin/main:.agents/skills/<name>/SKILL.md`, `<name>` being that
  skill's name, `greptile`, and follows what that prints wherever section 8 says to read the skill. A read that fails is
  told to the owner with the draft kept open; it is never `UNAVAILABLE`. Where the add-on is on, the `greptile` skill
  owns every other rule of the review: the pool it is metered from, the allowance read before a request, how each thread
  is settled, whether a review still stands after a rebase, and when an attempt counts as unavailable. The `shared-files`
  skill says how a repository turns the add-on on or off.
- A guard keeps the heaviest tier in both directions. The rule covers a guard, which is a hook, a permission rule or a
  ruleset that refuses an action, a gate a guard runs, and its classifier, with every surface in the Surfaces table's
  `sign-off` row: a change to any of them is `sign-off` tier whether it loosens or tightens and whatever the two
  answers or the gate's exit give, so a one-line change there is `sign-off` tier. The manifest is in this rule by
  what an entry names: adding or removing the entry of a guard, a gate, a classifier or a hook configuration is a
  change to that guard, while a hash line re-recorded for a file the same change edits takes that file's tier;
  [shared-files](../../shared-files/SKILL.md#canonical-recording) owns recording. A guard that has no file, a ruleset or other
  GitHub setting, is changed only with its read-back: before the change the owner signs off the planned state; after it, the commit that records the
  applied state in the repository's record carries the setting read through `gh api`, bypass list included, and that
  commit is the diff the `sign-off` tier reviews, whatever the gate says of its paths.
- `security-reviewer` only when a change widens a surface in the Surfaces table's `security review` row; its
  dispatch and a capped security reviewer follow "4. Plan".
- Under `## Merge Danger`, the pull request body records both answers and why: a line beginning `Undo:` that reads
  `easy` or `hard` with one sentence of reason, a line beginning `Reach:` that reads `narrow` or `wide` with one
  sentence of reason, and one sentence more where the gate's exit or the guard rule set the tier. For a mixed change
  the two lines give the answers of the part that set the tier, each reason names that part, and one sentence more
  says what the other parts take; where two parts take the same heaviest tier, either is the part named. An external
  review not requested, on tier grounds or because the add-on is off, is neither `UNAVAILABLE` nor a clean review.
- Fix each true finding by the cheapest valid fix it names. A true finding whose every fix costs more than it is worth
  goes to the owner as a plain-language decision, and the owner may set it aside as deferred; a finding is dismissed,
  with a reason, only when it is false. Then one pass scoped to the repaired hunks and what they can break, by the
  same reviewer with its context intact or by the session. No further pass when a repair adds no factual claim. Record
  the review in the pull request body's review line, in the format the Review section of
  [the pull request template](../../../../.github/pull_request_template.md) specifies.

## 7. Push authorisation (owner gate two)

Move the card to `Awaiting push`: `node scripts/board-move.mjs <issue> "Awaiting push"`. Write the pull request
body with the vendored `pr` skill: read `.agents/skills/pr/SKILL.md`, fill `.github/pull_request_template.md` as
the body under the Which template wins rule below, save it as the Saved write-up rule says, and present the decision
card to the owner as the Chat presentation rule says. On the direct route section 8 describes, the filled body
becomes the squash commit's message, since there is no pull request
to hold it. The job's own `Closes #<issue>` line is the only closing word in a pull request body or a
direct-route commit message: GitHub closes, as completed, any issue whose link follows close, fix or resolve in any
tense, another repository's `owner/repo#N` included. Every other mention, such as the
canonical repository's card for a deferred finding, which `to-issues` step 6 says how to file, keeps those words
from directly before its link. The owner's yes, or any instruction to push, approves the card and covers every step of section 8: the
push, the draft pull request, the comments that request the external review where the add-on is on, repairs on the same
branch, rebasing onto `main`, marking ready, and the auto-merge. Nothing in section 8 stops to ask again, except for a
material limit the card did not carry, as the Chat presentation rule says; a public comment there is delivery, not a
new action. Push only after it, or on a card's advance approval as **Advance approval at push** says.

**Chat presentation.** The owner answers a decision card, never the whole body. Apply the outcome-reporting rule in
`AGENTS.md`. The card's sentences are copied from the filled body, never reworded: where one does not stand alone, the
body's sentence is rewritten and saved, then copied. Length follows risk: only block 3 grows, there is no word limit,
and no real limit is dropped to keep a card short. The body's `Decision card` block holds blocks 1 to 5, and chat shows
that block as saved, with any screenshot inline, then blocks 6 and 7.

1. **What changes for you:** the Summary's opening sentences, then its `Picked:` or `Approved in advance:` line where
   it has one.
2. **Screenshot:** each screenshot the Evidence shows, or the line `no visual change`. In the saved block it reads
   `screenshots under Evidence` or `no visual change`.
3. **What a yes accepts:** any `**Taste calls I made**` and `**Needs your ears**` lists whole, then the opening sentence
   of every other Not done item in the body's order, then each declaration the Review section carries of how a review
   ran; or `Nothing` where Not done says so and nothing was declared.
4. **Risk:** the `Undo:` and `Reach:` lines whole, with any sentence that follows them.
5. **Checks:** the Evidence's `Passed:`, `Failed:` and `Untested:` lines whole.
6. **Full write-up:** the saved `body.md`'s path, or the pull request's address only where that pull request's body
   already is the saved write-up, that the owner can ask to see it here, and the log's path or link.
7. **The question,** with what a yes does: it approves this card and, in plain words, the delivery section 8 then runs.
   On a job a product manager run picked, the Verdict paragraph's second question follows.

The card never copies or quotes the review line, a `Reviewed commit:` line, the `Closes #<issue>` line or the carried-receipt
lines: what reads them takes a second copy in the body for an error. An owner who asks sees the saved `body.md` in chat,
whole, collapsed sections included, before any push; asking is no answer. Keep the GitHub body in the repository
template's format.

A material limit missing from the card has not been accepted. Whoever finds one tells the owner at once what the card
left out. Before the merge the session takes nothing further in section 8 until the owner answers, with
`gh pr ready <pr> --undo` where the pull request is already ready; after the merge the owner decides what follows.

**Saved write-up.** Before the question, every job saves its review folder, `.claude/worklog/job_<card>-review-<head>/`,
`<head>` being what `git rev-parse HEAD` prints: the filled body as `body.md` and each screenshot its Evidence shows as
`screenshot-<n>`, keeping its extension. A save that fails is a stop. The card is shown from that saved body, and on a
yes that body is the approved body. A yes holds only for what it was shown from, whose identity is what
`git hash-object --no-filters -- <folder>/body.md <folder>/<each screenshot, in numeric order>` prints in the job's
worktree, one line per file. On showing the card the session prints `<head>` and that identity in the owner's chat and
writes the identity to `shown-hash` in that folder. Before section 8 begins `git rev-parse HEAD` must print `<head>`,
`git status --porcelain --untracked-files=normal` must print nothing and the same command must print the identity
shown: the session that showed the card compares it with `shown-hash`, and a job session holding a carried yes
compares it with the `shown` it was carried, never with `shown-hash`, which a card shown again at the same head
rewrites. Otherwise the yes does not count: save again and show the card again. A cloud
session saves no folder and asks nothing; its draft's body is the write-up, and the local session that takes the draft
up saves the folder at the head it kept before it shows the card.

**Which template wins.** The `pr` skill carries a template of its own and never reads the repository's. Wherever
the two differ, `.github/pull_request_template.md` wins: it decides which sections and lines the body has, their
order, their labels, which of them sit in a collapsed section, when the Summary carries a picture and the writing rules
its comments give, and the skill decides the rest of how the Summary, Evidence and Merge Danger sections are written.
The body therefore keeps the lines the skill lacks: the review line, the receipts as `node scripts/run-log.mjs` wrote
them, **Not done** and the `Closes #<issue>` line. It records the two answers of section 6 once, as the `Undo:` and
`Reach:` lines under `## Merge Danger`, answered by section 6's definitions, and never again under the skill's own
labels, Door and Blast Radius. A pull request a scheduled routine opens is written with the skill under this same rule,
with the `## Pull request body` section of that routine's manual standing where the template stands.

**Advance approval at push.** Read [advance-approval.md](advance-approval.md) whole before the decision card is shown.

**Verdict.** A job a product manager run picked, its Summary ending in a `Picked:` line, gets one verdict each time the
owner answers its push question, by any route: a batch review, an answer carried to its session or its reopened
session. A job approved in advance,
its Summary ending in an `Approved in advance:` line, gets none. The approval
question also asks whether the owner would have sent this job's board card back rather than have it built. That second answer never
holds the first: any owner instruction to push is the yes, answered or not. After the reply and before anything else for
that job, post one comment with `gh issue comment <issue> --body "<line>"`, whose values are fixed and carry no free
text: `Verdict: <yes or no> changes=<yes or no> sent-back=<yes, no or unanswered> at=<time>`, the time being what
`date -u +%Y-%m-%dT%H:%MZ` prints. `changes=yes` means the job needed a change before it could go: on a no whose reason
asks for a change, on a yes where an earlier verdict on the card holds `changes=yes`, or where the owner's reply says
so. A no whose reason does not settle it gets one question, and `changes=no` needs the owner's word there. A yes with
none of those is `changes=no`. `sent-back` is the owner's own word and is never inferred; a reply that leaves it out is
`unanswered`. Say in one line what was recorded, and where the owner corrects it, rewrite that comment by the
route section 1 of [held-cards.md](held-cards.md) names. A `Verdict:` comment is a record and never an approval: a later
session asks again.

**Stage 2 evidence.** Its rules are in [references/runs.md](runs.md), read as **Run triggers** under "Before intake" says.

**Per-card attention.** Its rules are in [references/runs.md](runs.md), read as **Run triggers** under "Before intake" says.
