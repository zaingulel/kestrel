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
- **Chronology audit.** Before dispatching the review, and again before the re-review that follows a `strict-tdd`
  review repair, audit each `strict-tdd` claim's worklog, stage commit and diff for the red and the coordinator
  validation "5. Build" requires. A record whose red receipt selected exactly the frozen identities and whose
  validation verdict was recorded before implementation dispatch is complete. Any other gap is settled by its kind:

  | Chronology gap | What the record shows | Who settles it |
  |---|---|---|
  | Paperwork slip | The four conditions below hold, but the validation verdict was recorded after implementation dispatch or not at all | The coordinating session |
  | Selection slip | The four conditions below hold, but the red run selected tests beyond the frozen identities | The coordinating session |
  | Test-order gap settled on proof | Code before red: implementation for the claim existed before its frozen tests logged their red, or the record cannot show which came first, and a valid executed mutation proves those tests | The coordinating session |
  | Test-order gap with no possible break | Code before red where no mutation of that code can be made | The owner |

  The four conditions: the test-only stage held evidence changes only, shown by a validation verdict recorded before
  implementation dispatch or by the stage commit's diff; its red receipt was logged in that stage, and no earlier
  receipt shows a frozen identity passing with the same frozen assertions under the same validated contract, since a
  pass before the stage strengthened those assertions, or under a contract since revised, shows nothing about order; the
  stage report shows the red its handoff named: each frozen identity run and failing for the claimed reason, or the run
  stopped by exactly the absence failure the plan declared; and the frozen identities and assertions are unchanged
  since, except through a recorded revised contract. A gap that is both slips is settled as both. Each of these is code
  before red: implementation built in the same handoff as its test, or before it; red obtained by removing, reverting or
  stashing implementation; a red run that left out a frozen identity, other than by stopping at the absence failure the
  plan declared, or failed for a reason neither qualifying nor declared; and a review repair whose new test passed on
  the reviewed tree when the behaviour it covers is absent at the job base. An `existing behaviour` test is never
  a chronology gap and never an owner question: a review repair's new test that passes on the reviewed tree is one
  when its behaviour is present at the job base, and it takes the `evidence-required` route with its executed
  mutation.

  To settle a slip, record in the worklog, marked as made at this audit, the evidence each condition rests on: the
  stage commit where its diff shows the stage held evidence changes only, or the validation verdict recorded before
  implementation dispatch and the red receipt it accepted where that is the proof; the quoted red receipt line; and
  the check of the frozen contract. For a paperwork slip that record is also its validation verdict. Name the slip
  with that evidence on the claim's row of the pull request body's Test receipts. A selection slip's red discharges no
  discrimination proof: the claim takes the executed mutation `docs/TESTING-STRATEGY.md` names. A test-order gap settles
  on proof: cite that mutation where its receipts still hold for the frozen tests and their code, or have it run as that
  strategy says. A late test without that proof goes back for it, and one a mutation leaves green goes to a builder
  under a revised test contract; neither reaches the owner. Name the gap with its receipts on the claim's Test receipts
  row as a test-order gap settled on proof. No mutation can be made only when no change to the code in the job worktree
  makes the focused test fail by its own assertion and pass once restored: the code lies outside the worktree, or every
  break stops the test running. Only that gap goes to the owner before review, to decide only whether to accept the
  claim without its red run; its discrimination proof stays under the strategy's alternative or stop rule, and the
  protected-invariant mutation still applies. Follow `AGENTS.md`'s Owner gates and Compact instructions: record the gap
  and accepted scope, quoting the exact question and owner approval verbatim. Reuse that acceptance only within the
  session that obtained it and its exact scope, following those gates after compaction; do not repeatedly ask about the
  same accepted gap there. A fresh session cannot infer approval from an earlier session, worklog or memory. A new claim
  or gap outside that acceptance needs its own decision.
- Before dispatching the review, file every card the acceptance criteria require, in this repository or another, as
  the `to-tickets` skill says. A card that can only be filed after the merge, such as one that must cite the merge
  commit, is named under **Not done** in the pull request body as closeout's to file.
- The selected tier's required reviews cover the final tree, at the tier two questions choose. Both are asked of every
  change: can it be undone, and how far does the damage reach if it is wrong. Each repository says what the two questions mean for it in
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
    reach make a `sign-off` change only where a single part is both. The required reviews still cover the whole
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
    included. On the normal authorized dual-runtime route, the other family's configured `reviewer` and
    `reviewer-supplemental` independently review the same frozen code and requirements through `cross-review`.
    An instruction that misreads a gate has cost more than most code. When authorization is declined, the other
    family's primary seat cannot be reached, only the supplemental pass is unavailable, or the repository's settings
    file names one runtime, read [references/review-routes.md](review-routes.md) whole before continuing.
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
    to undo and wide in reach: the same required cross-family reviews, their unavailability routes included, then, in a repository
    that has turned the external review add-on on, the external review on the draft in section 8. In a repository with
    the add-on off those reviews are the whole of this tier: nothing further is requested or waited for, and the six-field
    review line is the record of it. Where the other family is unavailable or the repository runs one runtime, read
    [references/review-routes.md](review-routes.md) whole before this tier's first pass runs on this family's
    seat.
    In a cloud build, read "Reviews in a cloud build" in [references/cloud-build.md](cloud-build.md) before
    this tier's first pass runs.
- **The external review add-on (optional).** An additional independent review of a `sign-off` tier change by an outside
  review service, requested on the draft pull request. It is off unless the repository's settings file holds
  `"greptile": true`. Read the setting on the fetched `main`, never from the files of the job, so a job cannot switch
  its own review off: the two commands Plan approval gives under "4. Plan" print the file. Read it again after the
  rebase in section 8, step 1, and after any later rebase there, each time on the `main` that rebase used, and deliver
  under the latest reading: a setting turned on in `main` since an earlier reading then counts. The add-on is off where
  the repository has no settings file, or where the file is one JSON object that holds no `greptile` key or holds
  `false`. It is on where the file holds `"greptile": true`. A command that fails, a file that is not one JSON object,
  any other value, or a key spelt nearly like it leaves the setting unknown, which is never off: open no pull request
  for a `sign-off` tier change and tell the owner what the commands printed. Where the add-on is on, the `greptile`
  skill owns every other rule of the review: the pool it is metered from, the allowance read before a request, how
  each thread is settled, whether a review still stands after a rebase, and when an attempt counts as unavailable.
  The `shared-files` skill says how a repository turns the add-on on or off, and a job that changes the setting
  reads that rule whole before it opens its draft.
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
- `security-reviewer` only when a change widens a surface in the Surfaces table's `security review` row; in a release
  update only an adopter part counts, as **Release update in an adopting repository** below says. Every
  `security-reviewer` dispatch names its result file, `.claude/worklog/<branch>-security-review.md`. For missing
  locations, its Claude charter permits only bounded `explorer` discovery, completed before its own trust judgment.
- Under `## Merge Danger`, the pull request body records both answers and why: a line beginning `Undo:` that reads
  `easy` or `hard` with one sentence of reason, a line beginning `Reach:` that reads `narrow` or `wide` with one
  sentence of reason, and one sentence more where the gate's exit or the guard rule set the tier. For a mixed change
  the two lines give the answers of the part that set the tier, each reason names that part, and one sentence more
  says what the other parts take; where two parts take the same heaviest tier, either is the part named. An external
  review not requested, on tier grounds or because the add-on is off, is neither `UNAVAILABLE` nor a clean review.
- For paired dispatches, wait for the `cross-review` barrier before settling findings. Deduplicate and prove or refute
  the findings. Fix each true finding by the cheapest valid fix it names. A true finding whose every fix costs more than it is worth goes to the owner as a plain-language decision, and the owner may set it aside as deferred; a finding is dismissed,
  with a reason, only when it is false. Then one repair pass, by the same reviewer with its context intact or by the
  session. That pass is given the last reviewed commit, the repair's head commit and the behaviours the repair can
  affect, and judges the repair against those, never the whole job afresh. No further pass when a repair adds no
  factual claim;
  no third full review follows the paired initial passes. Record the review in the pull request body's review line, in the format the Review section of
  [the pull request template](../../../../.github/pull_request_template.md) specifies.
- When two repair-and-re-review cycles still produce true findings, new or repeated, judge them. Where most of those
  two cycles' true findings land on code, tests or a refusal the job added that the card's acceptance criteria do
  not name, and the smallest design without it still meets every acceptance criterion and keeps every required test and
  constraint, stop repairing, since more rounds build what the card never asked for: bring the owner that design,
  what it gives up and a recommendation. The job builds the owner's pick, and findings it removes are settled by
  removal. Otherwise, and for every finding that remains, if each is bounded and verifiable, run one more round
  that fixes all of them; bring the owner the choice, with a recommendation, only when a finding needs an unsettled
  design, owner judgment or evidence that cannot be bounded. After that round this bullet alone settles findings:
  fix each further true finding by the same repair and scoped re-check without asking, and bring the owner the
  choice only for one that would change the card's outcome, product meaning or a trade-off it rests on, such as one
  whose every fix costs more than it is worth. Findings are never ignored.
- **Release update in an adopting repository.** A release update's own writes are the shared files and the manifest
  it writes from the verified release, for `AGENTS.md` its shared region alone, with the seat values the seat
  settings file names, the shared files it removes because the verified release no longer lists them, and the two
  compaction settings of its bounded Codex configuration merge. Every other changed line is an adopter part,
  reviewed as a part of a mixed change above: a change to the settings file or the seat settings file and the seat
  values that change renders, a customer-owned file edit, any other difference in `.codex/config.toml`, an edit the
  update merged into included, and any hand step. A setting that turns a runtime or add-on on or off is an adopter
  part judged as the adopter's choice, while the files it brings or removes are released shared files like the
  rest. A plain release update has no adopter part. This rule holds only for an update to the installed release or
  a newer one; any other move is reviewed as an ordinary change. The two questions and the guard rule choose the
  tier as for any change, and the review judges the update's integrity and each adopter part. A change inside the
  released shared files carries the canonical repository's evidence, given when it merged there: no plan or review
  derives a claim from it or asks for its red run, mutation or other proof, and no step asks the owner how to prove
  it. The pull request body gives the update's receipt, exit 0; a receipt of `check` at the final head, with the
  drift line of that run quoted beside it, whose drift category is healthy and whose recorded release is the one
  the card names, whatever its other categories report; the receipts of the repository's own checks; each adopter
  part; and a link to the canonical repository's notes of each release applied, which link the pull request of each
  change. A true finding inside a released shared file is fixed only in the canonical repository the manifest
  names: it is filed there as `to-tickets` step 6 says and named under **Not done**, and whether it holds the update
  is settled as for any true finding above.

## 7. Push authorisation (owner gate two)

Write the pull request body with the vendored `pr` skill: read `.agents/skills/pr/SKILL.md`, fill
`.github/pull_request_template.md` as the body under the Which template wins rule below, and save it as the Saved
write-up rule says. Then judge it as [merge-on-evidence.md](merge-on-evidence.md) says, read whole first: work that
merges on its evidence goes to section 8 unasked, and work that waits moves to `Awaiting push`, with
`node scripts/board-move.mjs <issue> "Awaiting push"`, and its decision card goes to the owner as the Chat presentation
rule says. On the direct route section 8 describes, the filled body
becomes the squash commit's message, since there is no pull request
to hold it. The job's own `Closes #<issue>` line is the only closing word in a pull request body or a
direct-route commit message: GitHub closes, as completed, any issue whose link follows close, fix or resolve in any
tense, another repository's `owner/repo#N` included. Every other mention, such as the
canonical repository's card for a deferred finding, which `to-tickets` step 6 says how to file, keeps those words
from directly before its link. The owner's yes, or any instruction to push, approves the card and covers every step of section 8: the
push, the draft pull request, the comments that request the external review where the add-on is on, repairs on the same
branch, rebasing onto `main`, marking ready, and the auto-merge. Nothing in section 8 stops to ask again, except for a
material limit the card did not carry, as the Chat presentation rule says; a public comment there is delivery, not a
new action. A coordinated Herdr job asks no such yes: it merges unless its card carries `show-me-first`, as
[the merge route](herdr-job.md#the-merge-route) says. Push only after it, or where the work merges on its evidence.

**Chat presentation.** The owner answers a decision card, never the whole body. Apply the outcome-reporting rule in
`AGENTS.md`. The card's sentences are copied from the filled body, never reworded: where one does not stand alone, the
body's sentence is rewritten and saved, then copied. Length follows risk: only block 3 grows, there is no word limit,
and no real limit is dropped to keep a card short. The body's `Decision card` block holds blocks 1 to 5, and chat shows
that block as saved, with any screenshot inline, then blocks 6 and 7.

1. **What changes for you:** the Summary's opening sentences.
2. **Screenshot:** each screenshot the Evidence shows, or the line `no visual change`. In the saved block it reads
   `screenshots under Evidence` or `no visual change`.
3. **What a yes accepts:** any `**Taste calls I made**` and `**Needs your ears**` lists whole, then the opening sentence
   of every other Not done item in the body's order, then how the review ran where Review carries a declaration.
   Copy ordinary declarations whole. For the [Codex primary fallback](review-routes.md#codex-primary-fallback), write
   a standalone sentence in Review findings identifying who completed the review and why Claude Code was unavailable.
   Copy that sentence verbatim into this block. Keep the structured fallback line only in its declaration slot.
   Where Not done says `Nothing` and Review carries no declaration, write `Nothing`.
4. **Risk:** the `Undo:` and `Reach:` lines whole, with any sentence that follows them.
5. **Checks:** the Evidence's `Passed:`, `Failed:` and `Untested:` lines whole. `Untested:` names only the checks that
   will not have run when the pull request merges, as the `check` contract in
   [merge-on-evidence.md](merge-on-evidence.md) says.
6. **Full write-up:** the saved `body.md`'s path, or the pull request's address only where that pull request's body
   already is the saved write-up, that the owner can ask to see it here, and the log's path or link.
7. **The question,** which asks for a yes, the change the owner wants, or a no, and says the answer goes to the session
   that delivers it. It says what a yes does: it approves this card, whatever wait reason held it, and, in plain words, the
   delivery section 8 then runs. A change merges without being shown again only where the fix path of
   [owner-answer.md](owner-answer.md) admits it.

The card never copies or quotes the review line, a `Reviewed commit:` line, the `Closes #<issue>` line or the carried-receipt
lines: what reads them takes a second copy in the body for an error. An owner who asks sees the saved `body.md` in chat,
whole, collapsed sections included, before any push; asking is no answer. Keep the GitHub body in the repository
template's format.

A material limit missing from the card has not been accepted. Whoever finds one tells the owner at once what the card
left out. Before the merge the session takes nothing further in section 8 until the owner answers, with
`gh pr ready <pr> --undo` where the pull request is already ready; after the merge the owner decides what follows.

**Saved write-up.** Before the judgement and any question, every job saves its review folder, `.claude/worklog/job_<card>-review-<head>/`,
`<head>` being what `git rev-parse HEAD` prints: the filled body as `body.md` and each screenshot its Evidence shows as
`screenshot-<n>`, keeping its extension. A save that fails is a stop. The card is shown from that saved body, and on a
yes that body is the approved body. A yes holds only for what it was shown from, whose identity is what `git hash-object
--no-filters -- <folder>/body.md <folder>/<each screenshot, in numeric order>` prints in the job's worktree, one line
per file. On showing the card the session prints `<head>` and that identity in the owner's chat and writes the identity
to `shown-hash` in that folder. Before section 8 begins `git rev-parse HEAD` must print `<head>`, `git status
--porcelain --untracked-files=normal` must print nothing and the same command must print the identity shown: the session
that showed the card compares it with `shown-hash`, a coordinator that showed a job whose named session still runs
compares it with the identity it printed, and a coordinator acting on a queue panel answer compares it with the identity that
answer names; neither of the last two reads `shown-hash`, which a card shown again at the same head rewrites. Otherwise
the yes does not count: save again and show the card again.

**Owner answer.** How the owner's answer reaches the session that delivers a waiting card, the fix path and who acts
on it, is in [references/owner-answer.md](owner-answer.md), read whole before a session acts on an answer.

**Which template wins.** The `pr` skill carries a template of its own and never reads the repository's. Wherever
the two differ, `.github/pull_request_template.md` wins: it decides which sections and lines the body has, their
order, their labels, which of them sit in a collapsed section, when the Summary carries a picture and the writing rules
its comments give, and the skill decides the rest of how the Summary, Evidence and Merge Danger sections are written.
The body therefore keeps the lines the skill lacks: the review line, the receipts as `node scripts/run-log.mjs` wrote
them, **Not done** and the `Closes #<issue>` line. It records the two answers of section 6 once, as the `Undo:` and
`Reach:` lines under `## Merge Danger`, answered by section 6's definitions, and never again under the skill's own
labels, Door and Blast Radius. A pull request a scheduled routine opens is written with the skill under this same rule,
with the `## Pull request body` section of that routine's manual standing where the template stands.

**Per-card attention.** Its rules are in [references/runs.md](runs.md), read as **Run triggers** under "Before intake" says.
