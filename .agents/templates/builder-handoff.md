<!--
Builder handoff template. Everything ABOVE the ---8<--- line is documentation; the prompt handed to the
`builder` (or `builder-max` / `builder-lite`) agent is everything BELOW it, every {{SLOT}} filled. The PreToolUse hook
(.claude/hooks/check-builder-handoff.mjs, .codex/hooks/check-builder-handoff.mjs) blocks a handoff that
drops the contract, whether or not this template was used.

Why each line is load-bearing:
- Builders are capped at their turn budget with NO warning, so each handoff carries one coherent,
  independently verifiable claim.
- The construction mode and its evidence are fixed before dispatch; a builder cannot select or downgrade them.
- Mutation-proofing by revert is the ORCHESTRATOR's convergence step; a builder capped mid-revert-cycle ships
  the mutated source.
- A builder's report is text to the orchestrator, so it can never display a screenshot to the owner.
- A result missing the literal sentinel line means the builder was CAPPED, not finished: `git diff` before
  touching the tree, and never resume a capped builder. The remaining work, including the capped builder's own
  checks and its report against every handoff item, goes to a fresh builder as a smaller slice; the session
  never finishes a capped slice or declares it done.
- A builder that hits consequential judgment mid-build STOPS AND ASKS instead of guessing.
- The stop condition never carries a line count: a builder stops for a file or step the plan did not name, never
  for size.
- The builder checks that every labelled line below is present and filled before it edits, because no hook sees
  a Codex handoff.

Each labelled value sits on its label's line. `Construction mode:` holds exactly one of `strict-tdd`,
`evidence-required` or `preservation` and nothing else: the reasoning belongs in the plan, and a slice that needs
two modes is two handoffs.

The focused verification command runs one named test by its full title: a command matching ZERO tests is a
failure to report loudly, never a pass.
-->
---8<---
Slice: {{SLICE_TITLE}}
Claim: {{CLAIM}}
Construction mode: {{CONSTRUCTION_MODE}}
Working directory: {{WORKTREE_ROOT}}

Approved plan for this slice (do not re-plan or re-scope):
{{PLAN}}

Files to edit for this claim:
{{FILES}}

Evidence that lands with this claim:
{{TEST}}

Observer: {{OBSERVER}}
Independent oracle: {{INDEPENDENT_ORACLE}}
Focused verification command: {{FOCUSED_TEST_COMMAND}}
Stop condition: {{STOP_CONDITION}}

Standing contract:
- Work only in the working directory above. Verify ONLY this claim with the focused verification command; NEVER
  run the full suite, that is the orchestrator's job after the claim converges.
- Run the focused evidence by its actual full title and report each count separately. A command matching ZERO
  tests is a failure to report loudly, never a pass.
- If the runtime refuses the focused command as git it cannot verify, rerun it in the form
  `docs/TESTING-STRATEGY.md` names for a job worktree; never rename the file or leave it out of the run.
- Follow the construction mode exactly; you cannot select, reinterpret, or downgrade it.
- Stop and ask instead of guessing: on ambiguity about scope or acceptance, a discovery the plan did not
  anticipate, or a conflict between this handoff and the observed code, stop with the specific question, the
  evidence, and your exact on-disk state, then end with the state line below. A mechanical choice the plan
  already bounds is yours to make.
- Mutation-proofing by revert is the orchestrator's convergence step, never yours.
- You cannot show the owner a screenshot; report what you verified and how.
- Do not commit or push.
- End your report with the literal line `final on-disk state = fixed` (or exactly what state you left).
