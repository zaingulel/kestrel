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

For each primary-only dispatch here, use `cross-review` section 1's frozen inputs, pending list and validation,
with one fresh native context and the primary seat's configured settings. No paired barrier applies to these routes.

When the other family's primary `reviewer` seat cannot be reached because its provider is out of usage,
unauthenticated or failing, use the [Codex primary fallback](#codex-primary-fallback) where eligible. For other
primary-provider outages, run the same `reviewer` charter on this family's own seat. Record in the pull request body
which family reviewed, which was unavailable, how that was established, and that the cross-family gate was unmet.
This route runs one primary pass and no supplemental pass. An undeclared substitution is a skip.

In a repository whose settings file names one runtime there is no other family: the same `reviewer` charter runs on
this family's own seat, in a fresh context, and the pull request body records which family reviewed, that the
repository runs that runtime alone, and that the cross-family gate therefore does not apply. That recording is the
whole of the route: a single-family review the body does not declare is a skip. It runs one primary pass and no
supplemental pass.

When cross-family authorization is declined, run one configured primary `reviewer` on this family's own seat and no
supplemental pass. Record that cross-family review was not authorized and the cross-family gate therefore not met.

On the normal authorized dual-runtime route, if only the supplemental pass is unavailable through login, rate limit
or service interruption, retain the completed primary evidence and declare the missing supplemental pass. Add no
same-family supplemental substitute. Directly after the review line, outside the collapsed findings block, write the declaration as plain body text without code fences:
```text
Supplemental review not completed: <seat>; <reason>; the supplemental cross-family review was not met.
```
Name the seat and evidenced cause. This declaration applies only where the supplemental pass is normally required, never to
the single-runtime, cloud, declined-authorization or primary-unavailability fallback routes.

For result validation, use `cross-review` section 1. The [merging-on-evidence judgement](merge-on-evidence.md)
still holds these declared limitations.

Where the add-on is on, a `sign-off` tier diff whose other family is unavailable and whose external review attempt
settles as `UNAVAILABLE` by either of the routes section 8 step 2 points to proceeds on the substituted pass plus that
record, both declared in the pull request body, because there is no further reviewer to wait for.

In a repository that runs one runtime the `sign-off` tier's first pass is the single-family review above, declared the
same way, then the external review where the add-on is on; where that review settles as `UNAVAILABLE` it proceeds on
that pass plus that record, both declared.

### Codex primary fallback

On the already-authorized dual-runtime route for a `code` tier change, use this fallback only when the actual
Claude Code primary attempt reports a usage limit, a login failure or a service interruption. Run one fresh,
independent native Codex `reviewer` pass on the frozen final tree and validate the completed verdict under
`cross-review` section 1. That primary is the only pass on this route. Record the verdict and each finding's
disposition in Review findings. Settle the review with zero deferred findings. A skipped or declined review, a capped pass, a bad invocation, unresolved findings
or unavailability of only the supplemental seat follows its existing route.

In the saved write-up's `## Review`, put one visible, unindented declaration after the settled review line and
before the first `<details>`. Use plain text outside HTML comments and code fences. This is the only declaration
in that slot. Publish the same line verbatim in the pull request body. For a usage limit, the line reads:

```text
Primary review fallback: completed=codex unavailable=claude-code cause=quota evidence=Claude Code reported its usage limit on dispatch.
```

Use `quota`, `login` or `service` for the observed cause. After `evidence=`, write a redacted, nonblank observation
from the actual attempt in one line, free of control characters, format characters and Unicode line separators.
Keep the review line in the template's base or add-on form as applicable. In the add-on form all three external
review counts are zero. The classifier validates the shape of this account-controlled declaration and the reviewer
verifies the underlying evidence and verdict. The [check contract](merge-on-evidence.md#7-push-authorisation-merging-on-evidence)
governs when this declaration clears the review hold.
