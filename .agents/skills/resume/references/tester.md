# Tester

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 5. Build: the tester

- A job changes code unless every file it changes is documentation. Once a slice that adds or changes tests is
  committed, dispatch the `tester` seat naming the job worktree, the job branch, the slice's commit, each behaviour the
  slice added or changed, and the exact focused test command and test count its handoff named.
- The tester's copy is the one thing a job writes outside its .claude/worklog/ folder: a system temporary folder keeps
  the copy's own processes away from the job's files, branch and worklog. Write the tester's report, its receipt lines
  included, into the job's worklog. Where the report does not confirm the folder was deleted, delete it under closeout's
  Disposable job cleanup.
- A behaviour the tester reports `green` goes back to a builder as a true review finding does, unless the session
  refutes it by running the break itself, before any review dispatch: a `strict-tdd` claim through the review-repair
  route of [strict-construction.md](strict-construction.md). The tester then runs once more on the repaired behaviours;
  a behaviour still `green` is settled as "6. Verify and review" settles a finding after two repair cycles whose true
  findings do not mostly land on additions the card does not name. A behaviour reported `untested` or `failing before
  any break`, or missing from the report, is settled by the session before review and never counts as `red`. A tester
  that cannot be dispatched, or returns no report, leaves every behaviour missing from the report. No tester run counts
  as a review round.
- The tester replaces none of the evidence `docs/TESTING-STRATEGY.md` requires: the session still executes and logs
  every required mutation before review.
