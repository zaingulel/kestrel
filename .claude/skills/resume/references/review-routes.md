# Review routes

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## Plan review

When authorization is declined, or the other family's provider is evidenced out of usage, unauthenticated or failing,
run this family's own `plan-reviewer` natively by `cross-review` section 4. The pull request body records
“&lt;seat&gt; reviewed the plan; &lt;reason&gt;; the cross-family plan review was therefore not met”, with the refusal or
unavailable provider and its evidence as the reason. That record is the whole exception: an undeclared substitution
is a skip. A review that failed or was capped for any other reason is diagnosed and run again, never substituted or
claimed clean.

In a repository whose settings file names one runtime, run its own `plan-reviewer` natively and record
“&lt;seat&gt; reviewed the plan; &lt;reason&gt;; the cross-family plan review does not apply”, naming the single runtime as the
reason. An undeclared single-family review is a skip.

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
