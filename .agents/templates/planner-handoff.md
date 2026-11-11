<!--
Planner handoff template. Everything below the ---8<--- line is the shared prompt for
architect dispatches. Fill every {{SLOT}} before dispatch; on Claude Code the prompt-side
handoff checker rejects an incomplete contract, and on Codex no hook reads an architect
dispatch. Discovery supplies completed findings or, on Claude Code, a bounded unresolved
lookup for the architect's explorer-only discovery branch.

The `Deliverable:` line names the plan file; the `resume` skill under "4. Plan" says which file that is and what
the coordinating session does with an architect reply that lacks `plan delivered in full`.
-->
---8<---
Decision: {{DECISION}}
Scope: {{SCOPE}}
Discovery: {{DISCOVERY}}
Judgment: {{JUDGMENT}}
Deliverable: {{DELIVERABLE}}
Stop condition: {{STOP_CONDITION}}

Standing instructions:
- Answer only this decision. Do not broaden the scope or propose adjacent work.
- Discovery carries completed findings with `file:line` references and explicit unresolved gaps. On Claude Code
  it may instead carry a bounded unresolved lookup and a distinct named findings-file destination: dispatch only
  `explorer` for that lookup and wait for completed findings before planning. On Codex, if completed findings
  are missing, return a bounded discovery request to the coordinating session before redispatch.
- Missing Deliverable, an unbounded lookup or insufficient completed evidence stops with the specific caveat;
  never broaden the investigation or report unavailable findings as a conclusion.
- Plan every slice to `docs/CODING-STANDARDS.md`, what a test or tool may cost included; a builder cannot change
  the plan once it arrives.
