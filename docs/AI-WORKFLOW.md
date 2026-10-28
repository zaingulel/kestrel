# The software factory

This repository is built by AI agents under a workflow the owner steers from two decisions: what to build, and
whether a finished change may ship. A repository may turn on a third: whether the completed plan may be built.
Everything else between those decisions is done by agents, checked by tests and reviews the agents cannot skip, and
recorded where the owner can read it without reading code.

The workflow is pro-code: what it builds is ordinary source code in a git repository, with its own architecture,
tests, version history and review, which developers with repository access can read, run and extend. It serves
owners who are developers and owners who are not. Every decision reaches the owner in plain language, so steering the
work never depends on reading a diff, and a developer owner can read every diff as well. Plain language changes who
can steer the work, not how it is engineered: the same plans, standards, tests and reviews apply whoever the owner is.

These pages explain that workflow to someone who has never opened the repository: what the pieces are, how a change
moves through them, what is enforced by a machine and what is only instructed by a sentence, and which parts transfer to
another product. This page is the front page: it maps the whole, states the rules that hold everywhere, and routes each
question to the page that answers it. [`AGENTS.md`](../AGENTS.md) is the index every agent loads: the rules every
session needs in full and a pointer to the home of every other rule; the skills under
[`.agents/skills/`](../.agents/skills/) own the exact commands. The pages explain; they never restate a rule, a setting
or a command another document owns, and where a page and its owner disagree, the owner is right.

## The map

The owner reads pull request descriptions and screenshots, not diffs. The workflow therefore puts two
decisions in front of the owner, and a third only where the repository has turned plan approval on, and phrases each in plain language.

```mermaid
flowchart TB
    subgraph Owner["The owner"]
        O1["Bring an idea"]
        O2["Agree the breakdown into cards"]
        O3["Work-pick: pick one card"]
        O6["Plan approval: one yes to the completed plan, only where the repository turns it on"]
        O4["Decide, only if the outcome or a trade-off changed"]
        O5["Push authorisation: one yes to the pull request body and its screenshot"]
    end
    subgraph Agents["The agents"]
        A1["Interview, write the spec, propose cards"]
        A2["Report which cards are startable"]
        A3["Plan"]
        A4["Build in bounded slices"]
        A5["Verify and review"]
        A6["Write the pull request body"]
        A7["Deliver: draft pull request, checks, auto-merge"]
        A8["Close out: card to Done, worktree removed"]
    end
    O1 --> A1
    A1 --> O2
    O2 --> A2
    A2 --> O3
    O3 --> A3
    A3 --> A4
    A4 --> A5
    A5 --> A6
    A6 --> O5
    O5 --> A7
    A7 --> A8
    A4 -.-> O4
    O4 -.-> A4
    A3 -.-> O6
    O6 -.-> A4
```

The diagram shows the owner's side beside the agents' side of one piece of work, from an idea to a merged change. Solid
arrows are the usual path. One dotted pair is taken only where the repository has turned plan approval on, the other
only when the approved outcome or a trade-off changes during the build.

In words: the owner brings an idea. The agents interview the owner, write the spec and propose cards, and the owner
agrees the breakdown into cards. The agents report which cards are startable and the owner picks one: that pick is
work-pick, the first of the two decisions. The agents then plan, build in bounded slices, verify and review, and write
the pull request body. The owner reads that body, with a screenshot where the change is visual, and says yes: that is
push authorisation, the second decision. The agents deliver and close out without asking again. In between, a question goes
back to the owner in two cases only: where the repository has turned plan approval on, the agents present the completed
plan and build nothing until the owner says yes; and where the approved outcome or a trade-off changes during the build. A change the
repository's own gate admits whole goes straight to `main` on the same yes, with no pull request.

The two decisions are named work-pick and push authorisation, and the optional third plan approval. Where the repository
turns product manager mode on, the owner may hand work-pick to a product manager run, which
[The life of one change](AI-WORKFLOW-job.md) describes. [`AGENTS.md`](../AGENTS.md) owns what each approves, what turns the third on, what goes back to the owner in between, and the approval a destructive action still needs, under "Owner gates". Underneath
this path every job runs in its own worktree, every check logs its exit code, and a short list of machine guards holds
what a sentence could not; [The life of one change](AI-WORKFLOW-job.md) follows it stage by stage.

## Why it is shaped this way

An AI agent's characteristic failure is a plausible mistake, not a visible one: a result that is
self-consistent and wrong, a test that passes whatever the code does, a pull request description that
overstates what was verified. The workflow is built around three answers to that.

- **Slice by blast radius.** Work is cut by how many behaviours, sources of truth, and consumers a change can
  affect, not by file size. Each slice makes one verifiable claim, fits one build context, and declares the
  files it owns. A one-line change to a shared resolver is riskier than a long isolated document. Card size is settled
  before work-pick; [the `resume` skill](../.agents/skills/resume/SKILL.md) owns that rule, and the one split it allows
  afterwards, under "4. Plan".
- **Route capability by the judgment that remains.** After planning, ask what design choices are still open,
  how much is unknown, how bad a plausible defect would be, and how strongly tests can catch a weak
  implementation. A bounded builder takes work with no remaining judgment; remaining judgment is resolved in
  the plan or the slice is split, never absorbed by the session editing directly. Cost breaks ties only between
  equally reliable routes. The costliest models are kept to the few seats [`AGENTS.md`](../AGENTS.md) names under
  "Runtime notes", and the seats that locate code or make mechanical edits run on cheaper models, as
  [The seats](AI-WORKFLOW-seats.md) shows, so expensive capability is spent where judgment remains. That economy is
  intended, not measured: the workflow's documents record no measurement of the cost it saves or of equal quality at
  lower cost.
- **Treat evidence honestly.** A green check proves only what that check covers. A review with no comments is
  not a completed review. Missing evidence is reported as unavailable, never converted to a pass or a zero.

### From requirements to maintenance

The workflow covers the life of the code, not only one change, and each stage leaves a record the next one reads:
the spec, the cards and their acceptance criteria, the plan, the commits and the recorded evidence.

- **Requirements.** When an idea needs requirements discovery, the owner can invoke
  [the `grill-me` skill](../.agents/skills/grill-me/SKILL.md). It asks, round by round, every question that can be
  answered so far, each with a recommended answer, until the owner confirms a shared understanding. The agent looks
  facts up itself and leaves every product decision to the owner.
  [The `to-spec` skill](../.agents/skills/to-spec/SKILL.md) then writes the spec from that conversation without a
  second interview. Throughout, the owner is asked about outcomes: what the product should do, what should happen
  when something fails and which trade-offs are acceptable, each through a concrete example with a recommended
  answer. The agents decide where the tests sit and what the design must change, and record both in the spec, so the
  owner judges outcomes, never code. The spec is as long as its agreed scope needs, with no target number of user
  stories: it is complete when it covers every agreed outcome, what should happen when something fails and every
  real edge case, so a small request makes a short spec, a large one keeps every story it needs, and nothing agreed
  is left out. [The `to-issues` skill](../.agents/skills/to-issues/SKILL.md) holds these rules under
  "Specification entry", and cuts the spec into thin vertical slices, each demonstrable on its own and sized to one
  bounded build; the owner approves the breakdown before any card is filed.
  A single bug or idea can instead be captured as one card through the same `to-issues` approval.
  [docs/ISSUE-TRACKER.md](ISSUE-TRACKER.md) says where the spec and its cards are kept.
- **Delivery.** The owner picks a card at work-pick. The agents plan it, with an architect and an independent plan
  review where [the `resume` skill](../.agents/skills/resume/SKILL.md) calls for them under "4. Plan", build it in
  bounded slices, verify it, review the final tree, repair what the review finds, and deliver it on the owner's push
  authorisation; [The life of one change](AI-WORKFLOW-job.md) follows it stage by stage.
- **Maintenance.** Each new feature is planned and reviewed against the same standing documents as the last, as the
  next section explains. When the owner chooses,
  [the `improve-codebase-architecture` skill](../.agents/skills/improve-codebase-architecture/SKILL.md) looks for
  structure that makes the code hard to test or to navigate, weighting the areas recent commits keep returning to
  unless the owner names one. It presents each candidate with the problem, the proposed change, its benefits and how
  strongly it is recommended, names a top recommendation and asks which to explore, so the owner chooses among
  explained options without having to design the architecture. Nothing schedules it and no delivery stage requires
  it; [the `diagnosing-bugs` skill](../.agents/skills/diagnosing-bugs/SKILL.md) recommends it to the owner when a
  bug has no good place for a test or its cause is architectural.

### How focused work stays coherent

Each working context is kept to one task, so that it holds what that task needs rather than the whole job. The
mechanisms below hold the narrow pieces together, and each has a cost.

- **Durable records carry continuity.** A seat has a narrow charter, a builder receives one slice, and discovery
  wider than a couple of files goes to the `explorer` seat so that its conclusion, not its file listings, reaches the
  session; [`AGENTS.md`](../AGENTS.md) sets this out under "Runtime notes". What a later context needs is kept
  outside any one context: the card and its acceptance criteria, the spec, the plan, the code and its history in
  git, and the recorded evidence. Narrow contexts are not lossless. A handoff carries only what its writer put in
  it: the handoff hook checks that each labelled line is present and filled, not that it is right, and a builder
  that meets a decision the plan left open stops and asks, as [The seats](AI-WORKFLOW-seats.md) describes. A
  context compaction can drop detail, which is why [`AGENTS.md`](../AGENTS.md) names under "Compact instructions"
  what a summary keeps and, under "Owner gates", asks again for an approval whose question is no longer in view.
  Whether a slice fits one context is a judgment the plan makes, not a measured length limit, and the cost of narrow
  contexts is more handoffs, each a place where information can be lost.
- **Persistent standards carry consistency.** [The coding standards](CODING-STANDARDS.md),
  [the testing strategy](TESTING-STRATEGY.md) and, where the project has a user interface,
  [the design system](DESIGN-SYSTEM.md) are standing documents that plans, builds and reviews are held to, so
  naming, structure, evidence and interface patterns carry from one feature to the next without depending on any
  session remembering earlier work. [`AGENTS.md`](../AGENTS.md) says under "Coding standards and the executed test
  bar" which seats read them; they enter at planning because a builder cannot change a plan once it arrives. They
  cost upkeep, and they help only as far as plans and reviews apply them.
- **Independent review challenges what a writer cannot see.** The writer of a plan or a change is poorly placed to
  find its plausible mistakes, and a writer's own model family shares its blind spots. A plan-first card's plan gets
  a read-only review before any build, and at the `code` and `sign-off` tiers the final tree is reviewed by the
  model family that did not write it. That reviewer derives the claims from the card and the final diff before it
  reads the evidence the plan selected, as [the testing strategy](TESTING-STRATEGY.md) says under "4. Construction
  modes", so a detail a handoff lost, or an assumption the writer and the plan shared, can still surface. Where a
  repository has turned [the external review add-on](#the-external-review-add-on) on, a `sign-off` change also
  follows that add-on's review route. The `greptile` skill, reached through
  [the review instructions](../.agents/skills/resume/SKILL.md#6-verify-and-review), defines how to settle a completed
  review or record an `UNAVAILABLE` outcome. Verified allowance exhaustion can skip the request; a recorded provider
  failure can leave an attempted review unavailable. Review lowers the chance that such a mistake ships; it does
  not remove it. A reviewer can miss a defect. When the other family is unavailable, when the owner declines to
  authorize sending it the code, diff, plan and card, or when the repository runs one runtime, the same review charter
  runs on the writer's own family and the pull request body declares it, as
  [the `resume` skill](../.agents/skills/resume/SKILL.md) says under "6. Verify and review". Every review pass costs
  model usage and time.

These are design intent, recorded with their reasons and costs. They do not guarantee correct or secure code,
lossless context or lower cost, and the workflow's documents record no measurement of context retention, model
cost or review yield against another way of working; [The evidence bar](AI-WORKFLOW-evidence.md) explains what a
passing check can and cannot show.

## The rules that hold everywhere

Eight things hold in every repository that carries the workflow, and they are what transfers to another product:

1. One contract file every runtime the repository runs reads, with skills for the steps and hooks for what must never
   happen.
2. Two human gates, phrased for a reader of prose: what to build, and whether the finished change may ship; and a third each repository may turn on: whether the completed plan may be built.
3. One worktree per issue, and one draft pull request for every change that does not qualify for the direct route to
   `main`; a job's pull request is merged only by the platform's own auto-merge.
4. Seats with narrow charters, bounded handoffs through a template, and judgment settled in the plan rather than
   absorbed by the session.
5. One construction mode per claim, an executed mutation where [the testing strategy](TESTING-STRATEGY.md) requires one,
   and exit codes recorded by a script.
6. A fresh review of the final tree, its depth chosen by two questions asked of every change, whether it can be
   undone and how far the damage reaches if it is wrong; on the pull request route, an external review requested on
   the draft for the sign-off tier, where the repository has turned that add-on on, then CI on ready.
7. A board, git, and documentation as three distinct stores, reconciled rather than assumed consistent.
8. Evidence limits as visible as evidence successes.

Product-specific protections are the surfaces the Surfaces table names; each product that adopts the workflow
fills that table with its own highest-consequence invariants and with its own answers to those two questions.

The workflow itself travels as the files `.agents/factory-manifest.json` lists. A repository carries every one of them
except those its settings file leaves out: the files of a runtime it does not name, the external review add-on unless it
turns that on, and the sweep's shared files, the `sweep-scope` check and the documentation standard, where it turns the documentation sweep off. [`AGENTS.md`](../AGENTS.md) owns
where they are authored and how they reach another repository, under "Shared workflow adoption";
[the `shared-files` skill](../.agents/skills/shared-files/SKILL.md) owns how they are fingerprinted, pinned and kept, how
a repository overrides a seat's settings, how its settings file leaves files out and what a repository needs before it
runs the workflow; and [the head of `scripts/factory-sync.mjs`](../scripts/factory-sync.mjs) owns its commands and exit
codes.

Where the answer to a question lives, the board, git or a document, is set out in [`AGENTS.md`](../AGENTS.md) under
"Sources of truth".
A chat claim never overrides these. A claim that work shipped is checked against the commit and the checks;
a claim that work is next is checked against the board.

## Where to read what

| If you want to know | Read |
|---|---|
| What the owner decides, and when | [The map](#the-map) above, then [`AGENTS.md`](../AGENTS.md) under "Owner gates" |
| Whom the workflow serves, and why its parts work together from requirements to maintenance | The opening of this page, then [Why it is shaped this way](#why-it-is-shaped-this-way) above |
| How Claude Code and Codex share one workflow, what the factory carries, what setup chooses and what stays personal, and what changes on Windows | [Two runtimes, one contract](AI-WORKFLOW-runtimes.md) |
| Who does what, and how work is handed from one agent to another | [The seats](AI-WORKFLOW-seats.md) |
| How a card becomes a merged commit | [The life of one change](AI-WORKFLOW-job.md) |
| How planned work is tracked, and how the board toolkit serves another board | [The board](AI-WORKFLOW-board.md) |
| What stops an agent from skipping a check, and what is only a sentence | [Enforced or instructed](AI-WORKFLOW-enforcement.md) |
| What counts as proof that a change works | [The evidence bar](AI-WORKFLOW-evidence.md) |
| What a pull request description holds, and what its review line means | [The review line](#the-review-line) below |
| How the workflow reaches another repository | [`AGENTS.md`](../AGENTS.md) under "Shared workflow adoption", then the [`shared-files`](../.agents/skills/shared-files/SKILL.md) skill |
| What is true of one repository alone: its product, own facts, grounding authorities and conventions | [`.agents/REPOSITORY.md`](../.agents/REPOSITORY.md) |
| What happens to a file, worktree or branch another job left behind | [Leftover rule](../.agents/skills/closeout/SKILL.md#leftover-rule) in the `closeout` skill; [`AGENTS.md`](../AGENTS.md) under "Owner gates" for the authority to delete one |
| The exact steps of a job | The [`resume`](../.agents/skills/resume/SKILL.md) and [`closeout`](../.agents/skills/closeout/SKILL.md) skills, and, in a repository that has turned [the external review add-on](#the-external-review-add-on) on, that add-on's own skill |
| Where every other document is | [`docs/README.md`](../docs/README.md) |

## The review line

Every pull request the `resume` skill delivers carries exactly one review line, so the review run before the pull
request opened is readable on GitHub. This section is the specification: any tool that writes or parses the line,
in this repository or another, follows it, and a tool that disagrees with it is the defect. Where they run, the
documentation sweep and its day-after triage run no review before their pull requests open and carry no line.

```
Review: tier=sign-off rounds=7 raised=16 fixed=13 dismissed=2 deferred=1
```

| Field | Value |
|---|---|
| `tier` | `document`, `code` or `sign-off`: the review tier the `resume` skill chose from the two questions: the session's own review, the cross-family review, or the cross-family review, followed by the external review where the repository has turned that add-on on. A change whose parts answer the two questions differently carries the tier of its heaviest part, and the one review covers the whole change at that tier. A pass run on the writing family's seat because the other family was unavailable keeps its tier; the pull request body declares the substitution. A pass run on the repository's one family, because its settings file names one runtime, keeps its tier the same way; the body declares that too. A pass run on this family's own seat because the owner did not authorize cross-family review keeps its tier the same way; the body declares that too |
| `rounds` | Reviewer passes over the tree, at least 1: the fresh review, each pass scoped to a repair, each `security-reviewer` pass, and each external review of a commit count one each; a pass counts once it records its verdict, zero findings included |
| `raised` | Findings reported across every round, the external review's included, a finding reported more than once counted once; in a self-review, the findings the session records in the Review section. A candidate the reviewer discarded itself is not one |
| `fixed` | Raised findings repaired in this pull request |
| `dismissed` | Raised findings judged false and dismissed with a reason |
| `deferred` | True findings not fixed here, each carried to a follow-up card or set aside by the owner because every fix costs more than it is worth, as the Review section names |

The line is exactly the six fields in this order, beginning at the start of a line with `Review: ` and ending after
the `deferred` value; trailing whitespace and a carriage return are ignored. Fields are separated by single spaces,
each written as the lowercase name, `=`, and a value with no spaces. Counts are whole numbers with no leading zeros.
Every finding is settled before merge, so `raised` equals `fixed` plus `dismissed` plus `deferred`. A repository that
has turned the external review add-on on writes three more fields after `deferred`, as [the external review
add-on](#the-external-review-add-on) says below, and no other repository writes them. Lines inside fenced code blocks
or HTML comments are not review lines, and a body carrying more than one valid line is invalid.

The line sits in the Review section of a body with five sections, which the session writes with the vendored `pr`
skill. The body leads with what the owner decides on, and two collapsed sections keep the complete supporting
evidence in the same body. Summary states the outcome in a few plain sentences, with a picture, a diagram, a tree
or a diff sketch, only where it shows something the sentences cannot. Not done names anything skipped, deferred or
uncertain. Merge Danger carries the two answers the tier was chosen from, each with its reason; for a change whose
parts answer the two questions differently they are the answers of the part that set the tier, named in each
reason, with one sentence on what the other parts take. Evidence shows a before and an after, the screenshots of
a visual change among them, then, collapsed, the receipts a script wrote and any record of a carried receipt.
Review carries the line and any declaration of how a review ran, then, collapsed, the fresh reviewer's verdict,
every finding with its disposition, and one usage line for each reviewer pass the Usage view cannot show, as the
`cross-review` skill specifies; raw usage blocks stay out of the body. The skill carries a template of its own,
and where it differs from `.github/pull_request_template.md` the repository's template wins;
[the `resume` skill](../.agents/skills/resume/SKILL.md) owns that rule under "7. Push authorisation".

### The external review add-on

The external review is an optional add-on, off unless the repository's settings file holds `"greptile": true`. It is a
second, independent review of a `sign-off` tier change by Greptile, an outside review service, requested on the draft
pull request after the cross-family review. A repository with the add-on off carries none of the add-on's files,
requests no external review and waits for none: its `sign-off` tier is the cross-family review alone, and its review
line is the six fields above.

The add-on is chosen at install, after the owner connects the repository to Greptile in Greptile's own dashboard,
which no install does; a release update run with the changed setting uncommitted writes or removes the add-on's files
later, and the owner connects or disconnects the repository in that dashboard by hand, as
[the `shared-files` skill](../.agents/skills/shared-files/SKILL.md) says. Where it is on, the
install writes the add-on's files: the `greptile` skill, which owns how a review is requested and settled, and the
reviewer's configuration, which keeps Greptile to the reviews a session requests. [The `resume` skill](../.agents/skills/resume/SKILL.md) owns when the review runs and how a
session reads the setting, under "6. Verify and review".

A repository with the add-on on writes its review line with three more fields, in this order after `deferred`:

```
Review: tier=sign-off rounds=7 raised=16 fixed=13 dismissed=2 deferred=1 greptile_rounds=2 greptile_raised=1 greptile_true=1
```

| Field | Value |
|---|---|
| `greptile_rounds` | External reviews of a commit, a share of `rounds` and already counted in it |
| `greptile_raised` | Findings the external review reported, a share of `raised` and already counted in it |
| `greptile_true` | External review findings fixed or deferred rather than dismissed as false, a share of `greptile_raised` |

The line is then exactly those nine fields, ending after the `greptile_true` value, on every pull request of that
repository, whatever its tier. `greptile_rounds` never exceeds `rounds`, `greptile_raised` never exceeds `raised`,
`greptile_true` never exceeds `greptile_raised`, `greptile_true` never exceeds `fixed` plus `deferred`, and
`greptile_raised` minus `greptile_true` never exceeds `dismissed`: the external review's true findings are among the
fixed or deferred ones and its false findings among the dismissed ones. A pull request the external review never read,
because its tier requests none or every attempt was `UNAVAILABLE`, carries `greptile_rounds=0` and therefore
`greptile_raised=0`; that reads as the external review did not look, never as a clean external review.
