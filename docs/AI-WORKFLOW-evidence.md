# The evidence bar

A change is accepted on evidence a script recorded, not on an agent's account of it. This page explains the chain from a
claim to a merged commit: what each claim must show, how its proof is recorded, and which checks run before a merge.
This page is part of [the workflow guide](AI-WORKFLOW.md). Related: [The life of one change](AI-WORKFLOW-job.md) for
when each piece of evidence is produced, and [Enforced or instructed](AI-WORKFLOW-enforcement.md) for the hooks that
hold the checks.

## Mental model

| Link in the chain | What it is | Who holds it |
|---|---|---|
| Claim | One observable behaviour or invariant a slice proves | The plan |
| Construction mode | How much proof the claim needs, and in what order | [`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) |
| Mutation | The change broken on purpose, to show the test notices, where the strategy requires one | The orchestrator, at convergence |
| Receipt | The exit code a script wrote to the run log | [`scripts/run-log.mjs`](../scripts/run-log.mjs) |
| Hosted check | The suites run on the merge result before a merge | Continuous integration and the branch rules |

## How it works

[`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) owns this. Every coherent claim in a change gets one construction
mode, which settles whether a failing test must come first, whether new evidence must land with the change, or whether
the existing regression net is enough; that document defines the modes and when each applies.

Where the strategy requires it, a claim is also proven by breaking it on purpose: the change is undone, the focused test
must go red, and the change is restored. A test that stays green when the feature breaks is not evidence.
[`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) owns the mutation rule: which claims need one and how many, how each
run is recorded, and what stands in for it where no test can observe the claim.

### The run log

Every executed check runs through [`scripts/run-log.mjs`](../scripts/run-log.mjs), which appends the check's real
outcome to a per-branch log so the pull request body quotes what a script wrote, not what an agent remembers; the head
of that file lists what each line records. A rerun may carry a reason. An absent reason records `null`, never a claim of
a first run; a supplied blank reason is a usage error before child launch. The logger records the exact supplied reason
as escaped JSON without inferring retries from history. The [resume skill](../.agents/skills/resume/SKILL.md) owns check
wrapping and rerun mechanics.

### Receipts after a later commit

A receipt names the commit it ran on, so a commit added afterwards leaves every earlier receipt pointing at an older
head. The checks do not all run again for that. The session lists the paths the later commit changed, the repository's
testing strategy says which checks those paths can affect, those run again, and every other check keeps its passed
receipt. A check that depends on something no path shows runs again too unless the strategy accounts for it, and so
does one whose earlier run is known to be invalidated. The pull request body lists each receipt kept as carried, with
the commit it ran on and the paths that changed, so a carried result is never read as a run on the final commit.
[The `resume` skill](../.agents/skills/resume/SKILL.md) owns the rule under "8. Deliver", and
[`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) owns which checks a changed path reruns.

### Hosted checks

CI runs the suites `docs/TESTING-STRATEGY.md` names. CI runs from the merge result, not the branch head, so it tests
what would land, and it runs on the final commit whatever receipts were carried. After a rebase onto a moved `main`, a
passed local receipt can in one bounded case stand for a check the hosted run also covers; that case is part of the
same rule in [the `resume` skill](../.agents/skills/resume/SKILL.md) under "8. Deliver", and the pull request body
says when it was used.

A second check, `sweep-scope` in `.github/workflows/sweep-scope.yml`, required where the documentation routines are
active, exists because the documentation sweep and its day-after triage land their own pull requests and no one reads
them first. It runs from `main` rather than from the pull request it judges, and holds those branches to the scope table
both routines answer to; [the head of `scripts/sweep-scope-check.mjs`](../scripts/sweep-scope-check.mjs) and
[`docs/DOC-SWEEP.md`](DOC-SWEEP.md) own what it refuses and its limits.

## Where the rules live

- [`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md): the construction modes, the mutation rule and the claims that take
  another route, the evidence routes, which suites run where and which checks a changed path reruns.
- [`docs/CODING-STANDARDS.md`](CODING-STANDARDS.md): what a test or a tool may cost.
- [`AGENTS.md`](../AGENTS.md) under "Coding standards and the executed test bar": which document owns which part of the
  bar.
- [The `resume` skill](../.agents/skills/resume/SKILL.md) under "5. Build" and "8. Deliver": how a check is wrapped,
  when a rerun needs a reason, and when a receipt is reused or carried to a later head.
- [The head of `scripts/run-log.mjs`](../scripts/run-log.mjs): what each line of the run log records.
- [The head of `scripts/sweep-scope-check.mjs`](../scripts/sweep-scope-check.mjs) and
  [`docs/DOC-SWEEP.md`](DOC-SWEEP.md): what the `sweep-scope` check refuses.

## Failure modes

- **A test passes whatever the code does.** The executed mutation exposes it: the change is broken on purpose and the
  focused test must go red.
- **A focused command matches no test.** Zero matches is a failed verification, never a pass.
- **A check could not run.** It is reported as unavailable evidence, never converted to a pass or a zero.
- **A carried result reads as a fresh one.** The pull request body lists every carried receipt with the commit it ran
  on, so no reader takes it for a run on the final commit.

## Key files

- `docs/TESTING-STRATEGY.md`: the evidence authority.
- `docs/CODING-STANDARDS.md`: the cost standard for tests and tools.
- `scripts/run-log.mjs`: the logger every check runs through.
- `.github/workflows/sweep-scope.yml` and `scripts/sweep-scope-check.mjs`: the documentation routines' scope check.
