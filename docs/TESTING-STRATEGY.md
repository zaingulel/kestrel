# Kestrel testing strategy

This document owns two questions: which evidence a claim needs, and the executed bar that evidence must
clear. The `resume` skill owns the mechanics (when each check runs and how its result is recorded),
[CODING-STANDARDS.md](CODING-STANDARDS.md) owns how the code itself is written, and
[AI-WORKFLOW.md](AI-WORKFLOW.md) owns the teaching narrative. On a conflict, the mechanics authorities win
on mechanics and this document wins on evidence selection and the executed bar. This document is the one
authority for the executed test bar and the fail-loud invocation rule.

## 1. The decision path

1. **Name the claim.** A test protects one observable behaviour or invariant; "production code was added" is
   not a claim. Test count and coverage percentage are not correctness targets, because every test is
   recurring cost.
2. **Choose the cheapest valid observer.** Take the route in section 2 that can actually observe the named
   claim, not the most impressive one available.
3. **Add a real-boundary proof only for distinct boundary risk.** The risk being retired is that the wiring is
   dishonest, not that a quota is unmet.
4. **Keep the oracle independent.** Expected values come from requirements, canon, a hand-worked example, or
   a known-good fixture, never a copy of the production calculation. The implementing agent's own new test
   is never the sole oracle for its own implementation; independence comes from the expected-value source, the
   discrimination proof selected below, and the fresh reviewer. Agreement between models is not an independent
   oracle.
5. **Prove discrimination, not activity.** Valid evidence accepts the intended behaviour, rejects a plausible
   wrong behaviour, and still accepts an equivalent correct implementation. Select the discrimination proof under
   section 4: qualifying ordinary pre-fix red/unchanged-test green, an executed mutation, or a declared alternative.
   A list of inputs the code handles the same way is one behaviour, not one proof per input. Preservation uses
   existing evidence for an unchanged protected contract and invents no new test or mutation ceremony.
6. **Bound the feedback.** Focused evidence during construction; the applicable integrated evidence once at
   convergence; a further broad rerun needs a named reason: changed evidence, an invalidated environment, or
   an investigated flake. A commit added after convergence is changed evidence only for the checks section 6 reruns
   for it, by its table or by the recorded investigation of a path the table does not cover; an invalidated
   environment stays a reason of its own. The mechanics live in the `resume` skill.
7. **Stop or escalate.** When retries stop producing new information, stop. An automated-judge
   failure fails loudly and is diagnosed first as a possible test-oracle defect (wording, timing,
   stale fixture) before it is treated as an implementation defect; an unavailable observation is unavailable
   evidence, never a pass. Before fresh review, log each new or strengthened test's focused evidence through
   `node scripts/run-log.mjs`. Use the runner's native exact selection for one or several explicitly named tests
   that support one coherent claim; grouping is optional. Record the intended full test identities, including
   their files, in the handoff before the run. Report each intended test's actual result and the executed count
   against that list. For name patterns, anchor each whole title at both ends, `^<full title>$`, escaping
   regular-expression characters and combining exact alternatives where needed. Inspect actual execution and each
   result against the intended selection: zero, missing, skipped, or unintended tests make the evidence incomplete
   and fail verification. Keep individual diagnostic runs where needed. Grouped evidence does not change the
   one-failing-test-at-a-time learning cycle in `strict-tdd`. Invoke fail-loud scripts directly: their own exit
   status is authoritative, never a filtered pipeline's status.

## 2. Evidence routes

Prefer interaction tests at the real interface. Assert events and terminal states, with watchdog deadlines
against hangs rather than elapsed-time assertions. Register cleanup before startup can fail; test-framework
teardown alone does not prove production cleanup. Constrain mocks to real interfaces where signatures are
stable so interface drift cannot silently pass.

| Concern | Cheapest valid observer | What it does not prove |
|---|---|---|
| Pure calculation or policy | A direct unit test on the function in the existing language framework | Nothing about whether any caller is wired to it |
| Command or subprocess wrapper | A unit test on the extracted logic plus the smallest representative positive and negative wire proof, per the Test economics standard in [CODING-STANDARDS.md](CODING-STANDARDS.md) | Nothing about a caller's real environment, credentials, or platform |
| Repository or storage boundary | A real temporary repository or fixture whose isolation is demonstrated by a contaminating scenario rather than asserted | Nothing about product behaviour built on top of the stored state |
| Structural, generated-artifact, documentation, privacy, or forbidden-pattern invariant | A deterministic mechanical guard over the committed bytes | Nothing about whether the guarded behaviour is correct |
| Honesty (output) | An explicit unavailable or refused state, asserted by a test on the command's exit status and message | Nothing about the accuracy of the data the command accepted |

A security, privacy, or honesty invariant needs a named anti-regression test in the same change.

A test that reads a file as text follows three rules. Behaviour is tested by running the command or hook, never
by reading source. A rule about the source itself reads it through a real parser where one is installed, never through a
hand-written pattern. A test over a document or an agent instruction pins mechanical facts only: a hash,
identical copies, an exact set, an exact command or setting, a path that exists, or a value another file must
match. It never pins wording or step order, which prove that a sentence exists and not that anyone follows it.
The one exception is a privacy or security disclosure sentence: its exact wording is the promise made to the
user, so its named anti-regression test keeps pinning it.

### Whole-conversation evidence

Drive the real `run_conversation` session in [bot.py](../bot.py), retaining its pipeline worker, context
aggregators, cancellation and speech adapters rather than substituting a fake conversation engine.
[WholeConversationTests.open_session](../tests/test_bot.py) owns a real Hermes service and registers cleanup
before startup. Dedicated pending-preparation cases observe concurrent preparation, private provider
requests/history, pending mute and cleanup. Already-ready turn/history fixtures await engine readiness and
have empty caller history, a ready worker or sticky startup failure, and no pending reader. They do not
establish production startup timing or pending preparation; completed preparation messages never enter
caller history.

[WholeConversationTests.test_conversation_preserves_context_and_interrupts_reply](../tests/test_bot.py)
drives native user-turn frames through the installed Hermes worker against a controlled streaming provider.
It observes speech at the transport output and committed assistant context, not merely synthesis activity.
Captured requests establish ordered history, exclude the interrupted unheard tail, and show empty history
for a new service lifetime. The fixture refuses a direct provider bypass, controls interruption and observes
native work finish before the next request. Recognition is unloaded without audio input; voice generation
uses a finite double through the real adapter.

Related session cases cover engine absence or death, provider refusal, incomplete replies, corrupt worker
output and startup/turn timeouts, including interrupted-reply drainage. They assert spoken failures without
automatic session restart or user-turn retry. Timeout cases also assert worker exit and owned-home removal.
[NativeHermesTests](../tests/test_hermes.py) separately exercises the installed worker's JSON-lines boundary:
unsolicited tool refusal, isolated configuration/environment, no reusable conversation state and attempted
network destinations limited to the controlled provider. Its
`test_production_worker_entrypoint_becomes_ready_without_a_turn` observes the actual worker script become
ready and exit cleanly with closed standard input, without a conversation or inference.

Local provider-error diagnostics belong in the owned ignored home, as checked by
`NativeHermesTests.test_provider_failure_is_explicit_and_diagnostics_stay_in_owned_home`.
`WholeConversationTests.test_brain_refusal_speaks_failure_without_retry` observes production cleanup remove
that home after worker exit. Neither proves cleanup after a hard-killed parent or power loss.

Installed-engine evidence is required locally; its absence blocks delivery. Hosted continuous integration
skips native cases when the interpreter is absent: those skips do not prove installed-engine behaviour,
and local native results do not prove hosted execution. Tracked recognition adapter tests use doubles and
do not establish actual recognition-worker execution. Controlled providers and speech doubles do not prove
live recognition accuracy, physical playback, live Bonsai answers or graphical-login startup or spoken latency.

### Native indicator evidence

The native Qt Test cases load the production `desktop/Service.qml` with its real host-injected shell naturally unassigned. They call its actual bounded ingress and trigger its named expiry Timer signals, without starting native children or replacing the shell. The production Loader starts `NativeInputs.qml` only after host injection. The fixed status-byte and observed Hyprland object contracts supply the policy oracle; the [design system](DESIGN-SYSTEM.md#the-three-marks) supplies literal geometry and motion values for the actual `Marks.qml` objects.

```sh
node scripts/run-log.mjs indicator native -- env QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input tests/qml Service::test_status_input_death_and_silence Service::test_motion_requires_successful_fresh_true Indicator::test_all_state_shapes Indicator::test_reduced_motion_still_shapes
node scripts/run-log.mjs indicator qml -- /usr/lib/qt6/bin/qmllint desktop/Service.qml desktop/Marks.qml
```

Require all four selected functions to execute without skips; report Qt initialization and cleanup separately from the four slice cases. These checks do not prove native Process bridging, host injection, palette refresh, accessible-tree exposure, rendered contrast, physical audio or microphone release. Drive those boundaries on the installed Omarchy host and record native observations separately, including watcher termination and reaping on reload or removal. A missing native observation is unavailable evidence.

Native integration and visual receipts are invalidated by changes to desktop QML or the manifest, Qt tests, or the installed Qt, Quickshell or Omarchy environment. Policy and geometry receipts rerun for their corresponding production or test changes. Runtime privacy and release claims also retain the Python lifecycle and reader evidence; native rendering alone cannot establish them.

## 3. Evidence classes stay distinct

Functional green never substitutes for structural, lint, generated-artifact, documentation, accessibility,
privacy, security, or honesty evidence. These are separate classes of claim with separate observers. Each
change applies the classes its claims actually touch, and no more.

## 4. Construction modes

Each coherent verifiable claim receives exactly one mode. A single claim is first-class when no useful split
exists; do not manufacture another claim to satisfy a quota. Subject matter sets the minimum mode; change shape
cannot lower that floor. File and test counts are advisory signals, not quotas. If acceptance is unresolved or
there is no meaningful observer, stop and resolve the uncertainty or name an explicit alternative.

| Mode | Admission and obligation |
|---|---|
| `strict-tdd` | Use for a reproducible defect with a meaningful observer and independent oracle, or when a subject-matter rule requires it, including the trust perimeter and applicable security, privacy, or honesty invariants. A slice with an admitted claim logs an independent red run through `node scripts/run-log.mjs`, in the environment where the defect shows, before its first implementation edit, and the same evidence returns green after the change. A slice that reaches review without that logged red run has no admissible evidence for the claim. |
| `evidence-required` | This is the default for new or changed observable behaviour or policy when no higher subject floor applies, and its construction order is flexible while new or strengthened evidence and the discrimination proof selected below remain required at convergence. |
| `preservation` | Admit only when there is no new or changed observable behaviour and the protected contract remains unchanged, including every relevant test assertion and policy outcome. Use declared existing regression, identity, lint, link, generation, or structural evidence; create no new test or mutation ceremony. |

A text-only claim, a documentation or agent-instruction change, has no executable observer for its meaning. One
that changes what a reader or agent must do is `evidence-required`: `npm run lint:docs` is its mechanical check,
and the fresh review of the final tree is the named alternative to the executed mutation. One that only rewords or
moves text is `preservation`, and `npm run lint:docs` staying green is its protected contract.

### Discrimination proof

At convergence, the orchestrator validates the selected proof. For ordinary behaviour, an independently grounded
counterexample executed and logged before implementation may discharge an equivalent mutation only when it failed
because of the claimed defect and the identical test, oracle, and materially equivalent environment pass after the
fix. Record the ordinary behaviour, the plausible mutation, and why that prior failure rejects the same wrong
behaviour. Unrelated red, launch or environment failure, an oracle failure, edited assertions, and unavailable
execution do not qualify.

Without qualifying pre-fix red, ordinary new or changed behaviour requires an executed wrong-behaviour check:
deliberately introduce one plausible mutation per distinct material behaviour, observe the focused evidence fail,
restore the implementation, and observe green. Every changed protected invariant, including trust, security,
privacy, and honesty, retains one explicit adversarial convergence mutation; qualifying ordinary red never replaces
it. Any stricter local subject floor still applies. The text-only alternative above and preservation retain their
own evidence routes. Builders never perform mutation/revert cycles; the orchestrator performs required mutations.

For every claim, the plan or pull request body records the observer, independent oracle, plausible mutation,
selected discrimination route, and focused evidence; for `preservation`, the plausible mutation is `not-applicable`
and the unchanged protected contract is named. Every executed check, including qualifying pre-fix red and green or
a required mutation's red and restored green, runs through `node scripts/run-log.mjs` so the exit code is written
by a script, and the pull request body quotes those lines. A required but unexecuted mutation is a review finding.

The architect proposes the mode per claim; the orchestrator validates the proposal and applies the subject floor.
The builder follows the handed-off mode and cannot reinterpret or downgrade it. The reviewer independently derives
the claims and classifications from the issue and final diff before reading the recorded selection; a mismatch or
downgrade is a finding the orchestrator resolves with a new selection, fresh evidence, and a fresh review.

## 5. Economics

An expensive test or piece of machinery declares the distinct risk it covers and its recurring cost under the Test
economics standard in [CODING-STANDARDS.md](CODING-STANDARDS.md), cited rather than copied; how machinery enters and
leaves, including when a job deletes it, is the machinery rule in the `resume` skill under "4. Plan" and is
not restated here.
Performance budgets stay advisory and labelled with the environment they were measured on.

## 6. Local suites

Focused evidence during construction follows the selection rule in [section 1, point 7](#1-the-decision-path).

```sh
node scripts/run-log.mjs quality mute-wire -- env PYTHONPATH=tests .runtime/voice-venv/bin/python -m unittest test_bot.LocalMuteTests.test_local_command_wire_success_and_failure -v
node scripts/run-log.mjs quality flags -- node --test --test-name-pattern='^an absent flag returns the default and a present valid value is returned as a number$' scripts/lib/cli-flags.test.mjs
```

At convergence, run `npm run lint`, `npm run test:scripts`, `npm run test:speech` and the Ruff command below;
documentation changes also run `npm run lint:docs`. `npm test` runs both the factory Node tests and the existing Python speech tests. The speech command requires the ignored local voice environment described in [README.md](../README.md). An unavailable environment is unavailable evidence, never a pass.

In a job worktree with no `.runtime`, run `ln -s /home/zain/Projects/zaingulel/kestrel/.runtime .runtime`. This link points to the preserved real models, environments and voice assets; those target assets are not disposable test storage. Closeout removes the verified disposable job-local `.runtime` symlink under [its existing cleanup rules](../.agents/skills/closeout/SKILL.md#closeout). Do not delete the linked assets, follow the link during cleanup, or rebuild the assets for tests.

Ruff requires `uvx` (provided by uv). From the repository root, run:

```sh
node scripts/run-log.mjs quality ruff -- uvx --isolated --no-config --constraints requirements-test.txt ruff check --select F bot.py speech.py asr_worker.py hermes_worker.py app_resolver.py tests
```

This uses the existing requirements pin and the hosted check's rules and source selection. `--isolated`
avoids installed tools; `--no-config` ignores uv configuration, not Ruff configuration. Constraints do not
install the unrelated model dependencies. uv uses its tool cache and may download Ruff on a cold cache;
it does not install into the preserved model environments. Missing `uvx`, unavailable downloads or an
unavailable tool are unavailable evidence; a failing check remains failure, never a pass. This adds one
cached source scan per applicable convergence, with no recurring synthetic-fixture suite or timing claim.

Continuous integration creates its own CPU (central processing unit) test environment from the pins in `requirements-test.txt`; it needs no GPU (graphics processing unit) model weights.

The hosted [tests workflow](../.github/workflows/tests.yml) provides the required `test` check on ready pull requests. Its quality lane runs Node lint, script tests, document lint, Python Ruff F checks and the existing speech tests with CPU (central processing unit) dependencies and model downloads disabled. It does not prove live microphone behaviour or model accuracy. The Windows hook lane runs when the reach classifier finds paths that can affect hooks; `test` requires that lane to pass when selected and permits its skip only when no hook reach is found. Draft pull requests expose the control job without a `test` check.

These are configured hosted checks, not evidence that they have executed. Local results do not establish hosted or Windows results; read the actual hosted run before reporting those green.

A commit added on top of one whose checks passed reruns a convergence check where this table names it for the commit, or where the investigation of a path the table does not cover finds it affected; the `resume` skill's Receipt reuse rule under "8. Deliver" owns how a receipt is carried. For that rule, the hosted `test` check includes equivalent evidence for the checks in the table.

| Convergence check | What reruns it |
|---|---|
| `npm run lint` | A path under `scripts/`, `.claude/hooks/` or `.codex/hooks/`; `eslint.config.mjs`; or `package.json`, `package-lock.json` or `.npmrc` |
| `npm run test:scripts` | Any path, and any new head even when no path changed: the suite reads the tracked tree as a whole and queries git about the repository itself |
| `npm run lint:docs`, in a job that changes documentation | Any path: it resolves every cited path and link against the whole tracked tree |
| `npm run test:speech` | `bot.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py`, `app_resolver.py`, a path under `tests/`, `requirements-test.txt` or `package.json` |
| Ruff command above | `bot.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py`, `app_resolver.py`, a path under `tests/`, `requirements-test.txt`, or a change to the command or effective Ruff configuration |

Command and configuration inputs always rerun the affected check, regardless of filename extension: this includes package commands, ESLint configuration and package or lockfile changes. An unchanged `package-lock.json` together with a preserved installed-package and tool environment establishes unchanged Node inputs; a preserved `.runtime/` establishes unchanged voice inputs. Reinstalling packages, upgrading tools or changing either environment after a receipt was written reruns the affected check.

### Direct documentation route

The local `scripts/gates/pre-push-main` gate and `scripts/lib/docs-route.mjs` classifier admit only a nonempty fast-forward whose every path changed by every added commit qualifies. The pushed tree must match the checked-out tree, with no uncommitted tracked changes. The executable gate must already be on remote `main`; adding or rewriting the checkout's copy cannot enable the route. Gate or classifier changes take the pull request route. [Owner push authorisation](../AGENTS.md#owner-gates) still applies, and the pre-push hook runs its own checks on every push.

| Qualifying location | Qualifying types |
|---|---|
| `docs/README.md` | The document index itself |
| Files beneath `docs/research/` | `md`, `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, with case-insensitive extensions |

Locations are case-sensitive. Hidden, empty, `.` or `..` path components, backslashes, control characters and Git-quoted names refuse rather than being decoded or normalized. At every depth, the following basenames refuse case-insensitively: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `CODING-STANDARDS.md`, `TESTING-STRATEGY.md`, `DESIGN-SYSTEM.md`, `ISSUE-TRACKER.md`, `DOC-SWEEP.md`, `SWEEP-TRIAGE.md`, `WEEKLY-RETRO.md`, `AI-WORKFLOW.md` and `AI-WORKFLOW-*.md`. Membership in `.agents/factory-manifest.json` vetoes an otherwise qualifying path; a missing, unreadable or malformed manifest refuses.

All other locations and file types refuse. This includes the operation manual `README.md`, root instructions and `GLOSSARY.md`, `.agents/REPOSITORY.md`, all architecture decisions under docs/adr/, root workflow manuals, workflow directories, hooks, permission and seat files, scripts, tests, package and configuration files, and product files including `bot.py`, `speech.py`, `asr_worker.py`, `hermes_worker.py` and `run-voice.sh`.

For a qualifying documentation-only commit added on top, `npm run lint` and `npm run test:speech` may carry a passing clean same-command receipt under the [Receipt reuse rule](../.agents/skills/resume/SKILL.md#8-deliver): ancestry and unchanged tracked and non-file inputs must be established. The direct route uses the head where the receipt actually ran. `npm run test:scripts` reruns for every new head because it reads tracked files and Git state; `npm run lint:docs` reruns because it resolves links and paths against the whole tree. A direct-route rebase onto moved `main` cannot borrow the hosted-check reuse case. The input invalidations above still apply.

Inside a Claude Code job worktree, a focused run names its test file through a quoted pattern when the file's path contains the letters `git`: `node scripts/run-log.mjs <label> -- node --test --test-name-pattern="^<full title>$" "scripts/lib/unsafe-g*.test.mjs"`, where `node --test` expands the pattern itself and the title is written with its regular-expression characters escaped. Claude Code's worktree check can read those letters in the plain path and refuse the command as git it cannot verify; the `resume` skill owns that rule under "3. Start the job". If that form is refused too, append `2>&1 | tail -10` to the same command: the receipt `run-log` writes still carries the command's own exit code.

On Windows, continuous integration runs only the tests the `hooks_windows` job in the tests workflow lists. The rest of the script suite and the speech tests have not been run on Windows in this repository; that coverage is unverified.

## 7. What this authority does not do

It sets no coverage target or test quota and imposes no universal red-green-refactor sequence or wall-clock gate.
