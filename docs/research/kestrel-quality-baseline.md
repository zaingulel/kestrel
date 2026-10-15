# Kestrel quality baseline: advisory research

Keep the existing test frameworks, correctness checks and approved Omarchy visual direction. Sharpen language-specific boundaries and evidence recipes; consider narrowly reducing repeated verification. This report compares independent consultations and the coordinator's synthesis. It changes no operating rule, review gate or product behaviour. Proposals require separately approved work; the linked authorities remain authoritative.

## Evidence and consultation scope

The source baseline is `20c853e760b89aac42876106a425c505ddca34e9`. Repository citations below use relative paths and baseline line references. The consultations were native Astra (`gpt-6-astra`, high) and the installed Claude architect seat, Opus with configured xhigh effort. The Claude result's `modelUsage` confirms `claude-opus-5-5`, alongside auxiliary Haiku usage. These identify actual consultations, not proof that model agreement establishes correctness.

The synthesis uses repository discovery, both independent memos and coordinator-checked original primary sources. Python guidance targets voice/continuous-integration 3.12, while preserving separate ASR and Hermes environments; the ASR interpreter version was not verified here. [Continuous integration](../../.github/workflows/tests.yml), lines 63–83, uses Python 3.12 and Node 22, while [package.json](../../package.json), lines 1–17, supports Node from 20.19. [Test dependencies](../../requirements-test.txt), lines 1–4, pin Ruff 0.15.0. Newer documentation features still need compatibility checks before adoption.

The consultations and source investigation ran no product suites, performance benchmarks, live audio or desktop trials, or model installations. Ignored sample scripts and assets were not inspected. Source design and configured checks are not live verification. Checks used to validate the report are reported separately from these research findings.

## Testing: retain the observers, clarify the proof

Keep `unittest`, `IsolatedAsyncioTestCase`, `node:test`, independently grounded expected results and fresh review. [The testing strategy](../TESTING-STRATEGY.md), lines 10–41 and 119–152, already distinguishes evidence classes and construction modes. For coding agents, assurance comes from requirements or known-good fixtures independent of the implementation, meaningful observers, counterexamples or mutations, and independent review. More model votes can repeat the same assumption. Anthropic's guidance supports checking outcomes and grader quality; it establishes no measured benefit for a particular Kestrel gate. [Agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

A concise evidence table could replace much of the detailed fixture narrative while retaining its claims and limitations:

| Evidence | Useful observer | Limit |
|---|---|---|
| Deterministic unit and adapter | Inputs, outputs, refusal states, events and cleanup under controlled doubles | Cannot establish actual device or model quality |
| Native process and pipeline | Real child lifecycle, protocol, committed context and output through the production pipeline | Controlled provider and speech fixtures still omit live recognition, playback and Ally quality |
| Owner and live | Actual microphone, audible playback, live Ally responses and perceived interruption/latency | Environment-specific observation, not a substitute for deterministic regressions |

[Whole-conversation evidence](../TESTING-STRATEGY.md), lines 65–117, drives the real pipeline and installed Hermes with a scripted provider and finite speech double. It observes spoken output and committed context, not merely synthesis activity. [Native Hermes tests](../../tests/test_hermes.py), lines 143–185, distinguish locally required installed-engine evidence from hosted skips. Keep that distinction. Hosted CPU checks and mocked adapters cannot prove hardware/model accuracy.

Proposed recipe additions should show Python qualified methods alongside Node anchored titles. Python's standard runner accepts qualified names; Node supports name-pattern filtering. [Python command line](https://docs.python.org/3.12/library/unittest.html#command-line-interface), [Node test runner](https://nodejs.org/download/release/latest-jod/docs/api/test.html). For example, the following are illustrative focused commands, not research executions:

```sh
node scripts/run-log.mjs quality mute-wire -- env PYTHONPATH=tests .runtime/voice-venv/bin/python -m unittest test_bot.LocalMuteTests.test_local_command_wire_success_and_failure -v
node scripts/run-log.mjs quality hermes-ready -- env PYTHONPATH=tests .runtime/voice-venv/bin/python -m unittest test_hermes.NativeHermesTests.test_production_worker_entrypoint_becomes_ready_without_a_turn -v
node scripts/run-log.mjs quality flags -- node --test --test-name-pattern='^an absent flag returns the default and a present valid value is returned as a number$' scripts/lib/cli-flags.test.mjs
```

Prefer events and terminal states, with watchdog deadlines against hangs, rather than elapsed-time assertions. Register cleanup before startup can fail, as [the conversation fixture](../../tests/test_bot.py), lines 1129–1232, does. `IsolatedAsyncioTestCase` offers asynchronous cleanup and cancels remaining tasks at teardown; that teardown alone does not prove production cleanup occurred. [Python asynchronous testing](https://docs.python.org/3.12/library/unittest.html#unittest.IsolatedAsyncioTestCase). Constrain doubles where signatures are stable, rather than converting all patches to autospec: signature constraints help detect drift, while permissive API creation can hide nonexistent interfaces. [Mock autospeccing](https://docs.python.org/3.12/library/unittest.mock.html#autospeccing).

### The explicit disagreement

Opus retains today's mutation rule per distinct material behaviour. Astra proposes accepting a relevant, independently grounded pre-fix red followed by unchanged-test green for ordinary changes, without recreating an equivalent defect. Astra retains explicit adversarial mutation for changed protected invariants and one wrong-behaviour check for ordinary new features lacking red evidence. The coordinator recommends this narrowly defined simplification as a proposal. It is not current permission: [today's strategy](../TESTING-STRATEGY.md), lines 23–41 and 128–152, still governs.

Astra also proposes grouped invocations of explicitly named focused tests. Opus did not explicitly endorse grouping. The coordinator recommends retaining per-test identification, rejecting zero matches, preserving each result and the logged command's authoritative failing exit, and using individual runs for diagnosis. Any grouped-run permission would require an explicit policy change; current single-test requirements remain active. Runtime savings are unmeasured.

Shared handoff and skill changes must originate in canonical Fabraik, with owner direction and sync, rather than unilateral local relaxation. [Shared authorship contract](../../AGENTS.md), lines 188–200.

## Coding standards: short prospective additions

[Current standards](../CODING-STANDARDS.md), lines 3–42, already cover cohesion, important boundaries, no dead code and test economics. Add short prospective sections, not a repository-wide migration.

**Python.** Use hints at important interfaces where they remove ambiguity, while validating worker JSON, process output and audio metadata at runtime. Annotations do not enforce types at runtime. [Python typing](https://docs.python.org/3.12/library/typing.html). Preserve surrounding conventions rather than style-only churn. [PEP 8 consistency](https://peps.python.org/pep-0008/#a-foolish-consistency-is-the-hobgoblin-of-little-minds).

Name ownership, completion observation and cleanup for tasks, children and temporary state. Cancellation normally propagates after cleanup; justified shielding and retained task references remain appropriate. Do not mandate blanket `TaskGroup` conversion. [Python tasks and cancellation](https://docs.python.org/3.12/library/asyncio-task.html#task-cancellation). Bound external operations and cleanup with deadlines without prohibiting intentional supervised long-lived awaits. Subprocess timeout handling, pipe drainage, termination and reaping are separate responsibilities; unconditional buffering can undermine output bounds. [Python subprocess guidance](https://docs.python.org/3.12/library/asyncio-subprocess.html).

Keep protocol standard output separate from diagnostic standard error, preserve isolated dependency environments and bound external output. [Worker protocol](../../hermes_worker.py), lines 32–115, and [local command handling](../../bot.py), lines 68–139, provide existing examples; [operation dependencies](../../README.md), lines 8–17, explain environment separation. Private `StreamReader._transport` access in [bot.py](../../bot.py), line 82, and [speech.py](../../speech.py), lines 332–333, should retain its rationale and trigger targeted compatibility wire checks on Python upgrades, not speculative rewriting.

**Node.** Retain ECMAScript modules, strict assertions and correctness-oriented ESLint. Clarify supported versions, asynchronous completion, argument-array execution and distinct malformed, empty, unavailable and failed external results. [Existing wrapper tests](../../scripts/lib/gh-exec.test.mjs), lines 49–92 and 128–167, combine injected execution with representative wire evidence. Source shared workflow edits canonically; do not turn local guidance into duplicate shared rules.

**Bash.** Keep [startup](../../run-voice.sh), lines 1–9, minimal: quoted paths, environment setup and `exec`. Add targeted `bash -n run-voice.sh` when it changes, without launching audio. Quoting preserves literal argument boundaries. [GNU Bash quoting](https://www.gnu.org/software/bash/manual/html_node/Quoting.html). No new harness, blanket typing/formatting/framework migration, coverage target or line quota is recommended.

Keep Ruff's F selection and pin. Hosted/local parity already belongs to [issue 50](https://github.com/zaingulel/kestrel/issues/50); do not create another issue. Individual ASYNC rules are optional trial or deferred proposals, not whole-category adoption. Validate pinned-version availability, noise and actual defects first. Ruff recommends narrow selection and warns that broad selection changes on upgrades. [Ruff rule selection](https://docs.astral.sh/ruff/linter/#rule-selection). Environment choice belongs to a later bounded plan; installing into the preserved voice environment is not the only route. No runtime asset changes are authorised here.

## Visual design: preserve the direction, resolve native details

Keep the Omarchy theme roles, three-mark indicator and Quickshell panel in [the design system](../DESIGN-SYSTEM.md), lines 22–110. These are approved source patterns; no tracked QML implementation was found. They are not live-verified components.

A design system can own styles, tokens, reusable components, state presentation, motion, keyboard/focus behaviour and native accessibility. GOV.UK's styles/components/patterns organisation supports that scope without prescribing its visual identity. [GOV.UK Design System](https://design-system.service.gov.uk/). Spoken conversation and permission semantics stay in existing product, specification and operation authorities; no new document is needed.

The first approved interface plan should settle:

- **Reduced motion:** select the preference source and absent-signal fallback. The desktop portal standard includes reduced motion, but this laptop's backend support remains unverified. [Portal Settings](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Settings.html). Do not infer local support from the standard.
- **Contrast:** measure actual theme/background composition, including opacity, rather than assume inherited colours pass. W3C references distinguish text and non-text contrast. [Text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
- **Targets and scaling:** decide logical Qt scale and target measurement; the web minimum uses CSS pixels with exceptions and does not itself establish native compliance. Include long content and enlarged text. [W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- **Keyboard/accessibility:** establish accessible roles, names and actions, initial focus, navigation, closing and focus restoration. Qt exposes native accessibility metadata and explicit focus behaviour. [Qt accessibility](https://doc.qt.io/qt-6.5/accessible-qtquick.html), [Qt focus](https://doc.qt.io/qt-6/qtquick-input-focus.html).
- **Status meaning:** missing status must not imply microphone release. Any new unavailable-state semantics require an owner decision, not a silently added feature. Existing release wording is in [the design system](../DESIGN-SYSTEM.md), lines 78–108.

The shared frontend skill's named-hex guidance and local theme-role ownership must be reconciled through owner direction during visual planning. Preserve the documented look; do not edit vendored guidance or invent colours. Quickshell lifecycle APIs are relevant prior art, but version and reload behaviour need local validation. [Quickshell Process](https://quickshell.org/docs/v0.3.2/types/Quickshell.Io/Process/). Browser scanners and screenshot quotas cannot prove native accessibility.

## Concrete gaps and current review boundaries

Opus identified two useful local gaps. [Architecture seams and wide reach](../../AGENTS.md), lines 226–244, omit `hermes_worker.py` despite its implemented boundary and [native tests](../../tests/test_hermes.py), lines 171–185. Recommend aligning the local contract in a later approved change.

No tracked test under `tests/` was found naming or launching actual `asr_worker.py`; recognition adapter tests mock spawning. The production spawn is in [speech.py](../../speech.py), lines 373–409; [adapter doubles](../../tests/test_speech.py), lines 30–89, control the worker response. This search cannot rule out dynamic paths, and ignored sample scripts were not inspected. Inspect and record existing recognition evidence before planning the smallest distinct process proof. A protocol fixture proves different things from expensive real GPU/model accuracy. Do not mandate a GPU boot for every job or add tests, harnesses or assets in this research change.

Review routing remains unchanged. [The resume authority](../../.agents/skills/resume/SKILL.md), lines 431–502, defines documentation self-review only through an installed executable admitting gate. [The profile](../../.agents/REPOSITORY.md), line 11, records none, so documentation alone does not grant that tier. Code-tier work receives other-family review or the defined, declared fallback; a single-runtime repository uses its declared fresh-context route. Sign-off receives that review then Greptile. It applies when a single part is both hard to undo and wide in reach, and the protected-surface/guard override forces it regardless of size or ordinary answers. Opus's abbreviated summary omitted that override. Security review applies only when a security surface widens. Tests and reviews complement each other; no source establishes empirical Greptile benefit or cost here, and no extra reviewer is proposed.

## Proposed implementation choices and document shape

| Disposition | Recommendation | Qualitative cost and benefit |
|---|---|---|
| Keep | Frameworks, F/ESLint correctness, independent oracles, native boundaries, theme direction | Existing maintenance; preserves useful discrimination |
| Sharpen | Language recipes, ownership, constrained mocks, native accessibility, contract listing | Small documentation and targeted verification cost; clearer boundaries |
| Simplify, proposal only | Relevant ordinary red/green proof; identified grouped focused results; shorter fixture narrative | Potentially fewer repeated runs and drift; savings unmeasured |
| Defer | ASYNC expansion, new harnesses, broad migrations, interface implementation | Avoids unvalidated noise and machinery; revisit only for concrete need |

Suggested concise outlines for later approved revisions:

| Document | Proposed outline |
|---|---|
| Testing strategy | Claim/evidence table; construction and discrimination rules; Python/Node recipes; concise native/live limits; convergence/receipt rules |
| Coding standards | Existing shared principles; short Python, Node and Bash boundaries; existing static checks; test economics |
| Design system | Approved direction/tokens; components and state presentation; motion; keyboard/accessibility/scaling; native verification limits |

Implementation decisions remain proposal-only: whether to adopt verification simplifications through canonical workflow changes; what recognition evidence already exists and what distinct proof is missing; and how the first interface plan handles reduced-motion availability, theme accessibility and truthful status semantics. None is resolved by publishing this research report.
