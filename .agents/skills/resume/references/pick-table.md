# The pick table

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 2. Work-pick: the table

Present this table, even for one candidate:

| # | Card | Outcome for the user | Why now, and the risk | Gates it triggers | Route and why | Startable now? |
|---|---|---|---|---|---|---|

Each candidate takes one of two forms, and none is left out. A full row of the table goes to every `Ready` candidate
and to every `Backlog` candidate the session recommends: the card its closing line names and any alternative it would
put beside that one. Every other candidate gets one compact line under the table, in this form only:
`#<number> <name>: yes` or `#<number> <name>: no, <reason>`, the name eight words or fewer. Candidates sharing a name
and an answer may share a line, their numbers joined by commas. A card held for the owner gets neither form and is
never shown as startable.

`Card` is the issue number and its title as written, whatever its length. Write every other cell as a phrase,
not a sentence, aiming for twelve words or fewer and never dropping a fact the decision needs:
`Outcome for the user` adds what the title does not say, and `Startable now?` is yes, or no with the reason.

Gates are read off AGENTS.md, Owner gates and Review: owner direction, sign-off, architect plan, screenshot, security
review, the external review where the repository has turned that add-on on, and any further gate the Surfaces table in
`AGENTS.md` names, and each owner action the card names, with its limit, because the pick approves it. Route names the
build seat (`builder-max`, `builder`, or `builder-lite`), whether the architect runs, and the reason from residual
judgment, uncertainty, failure consequence, and verification strength. Close with one line recommending a full-row card
by its number and, where compact lines are shown, saying that any card's full row is given on asking by its number, then
stop; no acceptance-criteria list is presented. Asked for a candidate's full row by its number, write that row from the
intake document and stop again: the ask is no pick.
