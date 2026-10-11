---
name: greptile
description: Run the Greptile review of an open draft pull request, from reading the shared allowance and requesting the review to settling each finding or recording the attempt as unavailable. Use only when the resume skill's deliver step sends a sign-off tier change here.
---

# greptile

The `resume` skill owns when this review runs: its section 6 names the one tier that requests it, and its section 8
places it between opening the draft pull request and marking it ready, and says when a rebase or a continuous
integration repair returns here. This skill owns how an attempt is made and settled, whether a recorded attempt still
stands after a rebase, and the pool it is metered from. It runs as step 2 of that section 8, on the open draft.

## Read the allowance

Read the current allowance in the signed-in built-in browser at https://app.greptile.com/flowgauge/-/settings/billing.
The page states the allowance for the plan in force as an amount used out of a limit, in whatever unit that plan meters:
`2 of 50 free credits this period` on the free plan, a `$N of $M` usage limit on a paid one. Record that figure in the
page's own words, the plan the page names, the period it names, the observation source and time in the pull request
body. The allowance is exhausted only when the figure read from the page shows the amount used has reached its limit. A
login or join redirect from any other address means the address is wrong, not that the owner is signed out or the
allowance is exhausted; a command-line fetch is never signed in. If the signed-in built-in browser is unavailable, this
exact page cannot be read, or it shows no allowance figure, ask the owner for the figure and its period; never infer
sign-out or exhaustion from a failed read. Greptile is metered from one pool shared by every adopter. Confirmed
exhaustion is the `UNAVAILABLE` evidence below and skips the request.

## Request the review

Then read the open draft's `headRefOid` and request the final review once for that commit:
`gh pr comment <pr> --body "@greptileai review this draft"`. Record the request URL, time and exact head.
`.greptile/config.json` disables automatic reviews; labels are metadata.

## Read the result

`COMPLETE` requires Greptile's completed review for that exact head, its summary, and disposition of every finding. Read
its check status, the summary's last-reviewed commit, pull-request reviews and inline threads: a summary can precede
findings. Greptile's summary is a `greptile-apps[bot]` comment whose footer names the exact requested head as
`Last reviewed commit`, and the `Greptile Review` check turning green is a second signal; its heading is an image, so a
watcher keys on that footer, never on heading text.

## Settle the findings

Fix true findings, complete focused tests and the applicable scoped local repair review before pushing, reply with the
fix commit, resolve the thread, take a true finding whose every fix costs more than it is worth to the owner as `resume`
section 6 says, and dismiss false findings with evidence. Update the review line's Greptile fields after each Greptile
review; a pull request Greptile never reviewed, because its tier requests no Greptile review or every attempt was
`UNAVAILABLE`, records `greptile_rounds=0`. For the new head, request
`@greptileai review this draft again: <what changed> in <commit>`. A re-review can edit the existing summary and raise
its `Reviews (N)` footer; check the reviewed commit, not just the count or a new comment.

## An unavailable attempt

`UNAVAILABLE` requires, reported in the pull-request body, either the allowance observation above showing exhaustion,
with the head it would have covered, or the explicit request URL, head, observation time and provider-failure evidence.
This best-effort exception permits CI after all mandatory local evidence and finding dispositions pass. A filtered skip,
missing response, or queued/running review is unresolved: retain draft and report it for owner direction rather than
declaring unavailability.

## After a rebase

Repeat this skill only when the change requires Greptile and
`git range-diff <old-base>..<reviewed-head> <new-base>..<new-head>` shows any `!`, `<` or `>` row, where the bases are
the `main` commits the reviewed head and the new head sit on. A `!` from context drift alone still counts; it costs one
review attempt and never skips one. When every job commit lines up as `=`, the recorded `COMPLETE` attempt stands and
only CI reruns.

## The shared pool

Greptile is metered from one pool shared by the canonical repository and every adopter: one
organisation, one developer seat, the credits its plan includes per billing period plus any overage a paid plan allows.
There is no per-repository split; the tiers ration the pool, every adopter spends from it, and once it is exhausted
every adopter records `UNAVAILABLE` until the period resets. So the shape of the rule is one shared policy, and a change
to it lands in every adopter: the two questions in `resume` section 6 choose the tier and line count never lowers it, a
skip is neither `UNAVAILABLE` nor a clean review, the allowance is read before a request, reviews are requested by hand,
and the sequence is draft → Greptile → ready → CI. Each repository sends only the changes its own Surfaces table puts at
the `sign-off` tier. CI enforces draft versus ready, not the earlier review; the session verifies that evidence before
marking ready. Provider references:
[manual-only configuration](https://www.greptile.com/docs/code-review/greptile-json-reference) and
[draft requests](https://www.greptile.com/docs/code-review/tips-recipes).
