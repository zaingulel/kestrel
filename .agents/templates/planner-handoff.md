<!--
Planner handoff template. Everything below the ---8<--- line is the shared prompt for
architect dispatches. Fill every {{SLOT}} before dispatch; the prompt-side handoff
checker rejects an incomplete contract. Discovery supplies completed findings so the
architect spends its turn on judgment rather than repeating code discovery.

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
- Treat Discovery as completed findings with `file:line` references and explicit unresolved gaps, never a list
  of places to search.
- If the evidence is insufficient, stop with the specific caveat instead of broadening the investigation.
- Plan every slice to `docs/CODING-STANDARDS.md`, what a test or tool may cost included; a builder cannot change
  the plan once it arrives.
