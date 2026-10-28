# Plan approval

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

- **Present the plan, then stop.** Save the plan, the architect's or the session's own short plan, beside the
  work log as `.claude/worklog/<branch>-plan.md`. Tell the owner in plain language what will be built slice by
  slice, what each slice proves and what is left out; where a plan review ran, which seat reviewed the plan and
  how each finding was settled; and where the full plan is. Then ask whether to build it and end the turn. The
  card stays in `In progress`.
- **A pause before the yes is local.** Nothing tracked has changed and the saved plan is not tracked, so
  `handoff` has nothing to commit or publish, and no commit is made only to park a plan. The job branch, the
  claim on the card and the saved plan stay on this machine as they are.
- **Until the yes, nothing is built:** no builder is dispatched and no tracked file is changed for the card.
  Discovery, planning and the plan review need no approval. A question from the owner is answered and the plan
  is asked about again; an answer to another question, a card comment, the work log and a commit on the job
  branch are never that yes.
- **A change the owner asks for** is made by the seat that wrote the plan, and the changed plan is presented
  again in the same form, naming what changed, before the session waits again. On a card whose plan needed a
  plan review, the changed plan is reviewed again first.
- **A resumed session** reads the setting again. Where anything is left to build it starts with no approval,
  because an earlier session's yes does not carry over: it presents the plan as it stands and what is already
  built, planning again where the plan file is not on this machine, and waits.
- **After the yes** the build runs as "5. Build" says. A later change to the plan goes back to the owner only
  where `AGENTS.md` sends a material change back; clerical corrections follow **Clerical corrections** there.
