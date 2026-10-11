---
name: handoff
description: Park genuinely unfinished work in this repository so the next session can pick it up from git.
disable-model-invocation: true
---

# handoff

Owner-invoked to park unfinished work. Completed work uses `closeout`.

1. **Commit what exists** on the job branch with a message that says it is work in progress. Regenerate any
   artifact the `generated artifacts` row of the Conventions table in `.agents/REPOSITORY.md` names and commit it with its
   source; the Stop and pre-commit hooks enforce it.
2. **Prepare the draft pull-request body.** Write it with the vendored `pr` skill, filling
   `.github/pull_request_template.md`, as the `resume` skill says under "7. Push authorisation"; its Which
   template wins rule applies here too. Write the **Not done** section for a reader with no memory of this
   session: what is finished, what is not, the next concrete step, and any decision the owner still owes.
3. **Get publication authorization.** Show the prepared body to the owner and name the proposed push and draft
   pull-request creation or update. A bare `handoff` or `park` request authorizes only local preparation and the
   commit. Do not push the branch or create or update a draft pull request until the owner explicitly authorizes
   those outward actions. An invocation that explicitly names both push and draft pull-request publication
   satisfies this gate.
4. **Push the branch** and open or update the draft pull request (`gh pr create --draft`) with the prepared body.
5. **Board.** `node scripts/board-move.mjs <issue> Ready`, so the card is startable by the next session.
6. **Leave the worktree in place.** The next session finds the branch in `resume` step 1.

Report the branch, the pull request number, and the one-line next step.
