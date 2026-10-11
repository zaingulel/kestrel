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
   is never the sole oracle for its own implementation; independence comes from the expected-value source, an
   executed mutation where applicable, and the fresh reviewer.
5. **Prove discrimination, not activity.** Valid evidence accepts the intended behaviour, rejects a plausible
   wrong behaviour, and still accepts an equivalent correct implementation. Execute one plausible mutation per
   distinct material behaviour at convergence; a list of inputs the code handles the same way is one behaviour, so
   it earns one mutation, not one per input. Executing it means deliberately breaking the implementation,
   observing the focused evidence fail, restoring it, and observing green. Preservation uses existing
   evidence for an unchanged protected contract and invents no new test or mutation ceremony.
6. **Bound the feedback.** Focused evidence during construction; the applicable integrated evidence once at
   convergence; a further broad rerun needs a named reason: changed evidence, an invalidated environment, or
   an investigated flake. A commit added after convergence is changed evidence only for the checks section 6 reruns
   for it, by its table or by the recorded investigation of a path the table does not cover; an invalidated
   environment stays a reason of its own. The mechanics live in the `resume` skill.
7. **Stop or escalate.** When retries stop producing new information, stop. An automated-judge
   failure fails loudly and is diagnosed first as a possible test-oracle defect (wording, timing,
   stale fixture) before it is treated as an implementation defect; an unavailable observation is unavailable
   evidence, never a pass. Each new or strengthened test gets its own focused run, logged through
   `node scripts/run-log.mjs` before the fresh review starts, whose name pattern is that test's whole title
   anchored at both ends, `^<full title>$`, one test per run. A title fragment or a run that selects several
   tests is no evidence, and zero matches is a failed verification. Invoke fail-loud scripts directly: their own
   exit status is authoritative, never a filtered pipeline's status.

## 2. Evidence routes

Prefer interaction tests at the real interface.

| Concern | Cheapest valid observer | What it does not prove |
|---|---|---|
| Pure calculation or policy | A direct `node --test` unit test on the extracted function | Nothing about whether any caller is wired to it |
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
| `evidence-required` | This is the default for new or changed observable behaviour or policy when no higher subject floor applies, and its construction order is flexible while new or strengthened evidence and one plausible mutation remain required at convergence. |
| `preservation` | Admit only when there is no new or changed observable behaviour and the protected contract remains unchanged, including every relevant test assertion and policy outcome. Use declared existing regression, identity, lint, link, generation, or structural evidence; create no new test or mutation ceremony. |

A text-only claim, a documentation or agent-instruction change, has no executable observer for its meaning. One
that changes what a reader or agent must do is `evidence-required`: `npm run lint:docs` is its mechanical check,
and the fresh review of the final tree is the named alternative to the executed mutation. One that only rewords or
moves text is `preservation`, and `npm run lint:docs` staying green is its protected contract.

For every claim, the plan or pull request body records the observer, independent oracle, plausible mutation,
and focused evidence; for `preservation`, the plausible mutation is `not-applicable` and the unchanged protected
contract is named. Every executed check, including the mutation's red run and the restored green run, is run
through `node scripts/run-log.mjs` so the exit code is written by a script, and the pull request body quotes
those lines. An asserted-but-unexecuted mutation is a review finding.

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

Focused evidence runs during construction. At convergence, run `npm run lint`, `npm run test:scripts` and `npm run test:speech`; documentation changes also run `npm run lint:docs`. `npm test` runs both the factory Node tests and the existing Python speech tests. The speech command requires the ignored local voice environment described in [README.md](../README.md). An unavailable environment is unavailable evidence, never a pass.

In a job worktree with no `.runtime`, run `ln -s /home/zain/Projects/zaingulel/kestrel/.runtime .runtime`. This link points to the preserved real models, environments and voice assets; it is not disposable test storage. Do not delete the linked assets, follow the link during cleanup, or rebuild the assets for tests.

Continuous integration creates its own CPU (central processing unit) test environment from the pins in `requirements-test.txt`; it needs no GPU (graphics processing unit) model weights.

The hosted [tests workflow](../.github/workflows/tests.yml) provides the required `test` check on ready pull requests. Its quality lane runs Node lint, script tests, document lint, Python Ruff F checks and the existing speech tests with CPU (central processing unit) dependencies and model downloads disabled. It does not prove live microphone behaviour or model accuracy. The Windows hook lane runs when the reach classifier finds paths that can affect hooks; `test` requires that lane to pass when selected and permits its skip only when no hook reach is found. Draft pull requests expose the control job without a `test` check.

These are configured hosted checks, not evidence that they have executed. Local results do not establish hosted or Windows results; read the actual hosted run before reporting those green.

A commit added on top of one whose checks passed reruns a convergence check where this table names it for the commit, or where the investigation of a path the table does not cover finds it affected; the `resume` skill's Receipt reuse rule under "8. Deliver" owns how a receipt is carried. For that rule, the hosted `test` check runs all four checks in the table.

| Convergence check | What reruns it |
|---|---|
| `npm run lint` | A path under `scripts/`, `.claude/hooks/` or `.codex/hooks/`; `eslint.config.mjs`; or `package.json`, `package-lock.json` or `.npmrc` |
| `npm run test:scripts` | Any path, and any new head even when no path changed: the suite reads the tracked tree as a whole and queries git about the repository itself |
| `npm run lint:docs`, in a job that changes documentation | Any path: it resolves every cited path and link against the whole tracked tree |
| `npm run test:speech` | `bot.py`, `speech.py`, `asr_worker.py`, a path under `tests/`, `requirements-test.txt` or `package.json` |

The other inputs show in no path: the installed Node packages, which an unchanged `package-lock.json` shows unchanged, and the local voice environment in `.runtime/`, which no job rebuilds. Installing packages again or changing that environment after a receipt was written runs the affected check again.

Inside a Claude Code job worktree, a focused run names its test file through a quoted pattern when the file's path contains the letters `git`: `node scripts/run-log.mjs <label> -- node --test --test-name-pattern="^<full title>$" "scripts/lib/unsafe-g*.test.mjs"`, where `node --test` expands the pattern itself and the title is written with its regular-expression characters escaped. Claude Code's worktree check can read those letters in the plain path and refuse the command as git it cannot verify; the `resume` skill owns that rule under "3. Start the job". If that form is refused too, append `2>&1 | tail -10` to the same command: the receipt `run-log` writes still carries the command's own exit code.

On Windows, continuous integration runs only the tests the `hooks_windows` job in the tests workflow lists. The rest of the script suite and the speech tests have not been run on Windows in this repository; that coverage is unverified.

## 7. What this authority does not do

It sets no coverage target or test quota and imposes no universal red-green-refactor sequence or wall-clock gate.
