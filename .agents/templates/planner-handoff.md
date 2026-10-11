<!--
Planner handoff template. Everything below the ---8<--- line is the shared prompt for
architect dispatches. Fill every {{SLOT}} before dispatch; the prompt-side handoff
checker rejects an incomplete contract. Discovery supplies completed findings so the
architect spends its turn on judgment rather than repeating code discovery.

After one bounded non-delivery, the orchestrator narrows once or finishes the plan inline, except that an
architect's finding that the card holds more than one independently demonstrable outcome goes to the owner as a
split proposal under the `resume` skill's Plan section and is never narrowed or finished inline.
Never escalate to oracle merely because the architect did not deliver.
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
