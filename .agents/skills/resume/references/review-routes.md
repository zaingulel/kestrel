# Review routes

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Plan review

When the Codex seat cannot be reached, its provider out of usage, unauthenticated or failing, the plan does not wait:
the Claude `plan-reviewer` seat, Opus at high effort, reviews instead by the fallback route of `cross-review` section 4,
and the pull request body records which seat reviewed the plan, that Codex was unavailable and how that was established,
and that the Sol extra-high plan review was therefore not met. As for the review of the final tree below, that recording
is the whole of the exception: a substitution the body does not declare is a skip. A plan review that failed or was
capped for any other reason is run again, never substituted.

In a repository that runs Claude Code alone the Claude `plan-reviewer` seat reviews by the fallback dispatch of
`cross-review` section 4, and the pull request body records which seat reviewed the plan and that the repository runs
Claude Code alone, so the Sol extra-high plan review does not apply; in a repository that runs Codex alone its own Codex
seat reviews, as a Codex session dispatches it.

## The review of the final tree

When the other family's seat cannot be reached, its provider out of usage, unauthenticated or failing, the branch does
not wait: run the same `reviewer` charter on this family's own seat, and record in the pull request body which family
reviewed, which was unavailable and how that was established, and that the cross-family gate was therefore not met. That
recording is the whole of the exception: a substitution the body does not declare is a skip, and a skip is neither
unavailability nor a clean review.

In a repository whose settings file names one runtime there is no other family: the same `reviewer` charter runs on
this family's own seat, in a fresh context, and the pull request body records which family reviewed, that the
repository runs that runtime alone, and that the cross-family gate therefore does not apply. That recording is the
whole of the route: a single-family review the body does not declare is a skip.

Where the add-on is on, a `sign-off` tier diff whose other family is unavailable and whose external review attempt
settles as `UNAVAILABLE` by either of the routes section 8 step 2 points to proceeds on the substituted pass plus that
record, both declared in the pull request body, because there is no further reviewer to wait for.

In a repository that runs one runtime the `sign-off` tier's first pass is the single-family review above, declared the
same way, then the external review where the add-on is on; where that review settles as `UNAVAILABLE` it proceeds on
that pass plus that record, both declared.
