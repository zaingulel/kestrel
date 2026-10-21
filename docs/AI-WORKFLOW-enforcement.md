# Enforced or instructed

This page explains what a machine holds and what is only instructed: each guard, why it exists, what it cannot prove,
and the bar a new one must clear. This page is part of [the workflow guide](AI-WORKFLOW.md). Related:
[Two runtimes, one contract](AI-WORKFLOW-runtimes.md) for how the hooks run on each runtime, and
[The evidence bar](AI-WORKFLOW-evidence.md) for the checks a change must pass.

## Mental model

Most of the workflow is a sentence an agent follows. A short list is enforced by a machine, chosen because a
sentence had failed to prevent it or because the bad state would be silent or hard to reverse.

| Protection | Mechanism | What it refuses or forces |
|---|---|---|
| No unsafe git or GitHub command | `.claude/hooks/block-unsafe-git.mjs` before every shell command (Codex twin under `.codex/hooks/`) | The command forms listed at [the head of `scripts/lib/unsafe-git.mjs`](../scripts/lib/unsafe-git.mjs), which also says what the guard does not model; among them a `git worktree add` that resets a branch with `-B`, forces with `--force`, or names a path under `.claude/worktrees/` that climbs back out with `..`, and a forced `git worktree remove` |
| Cleanup approval belongs to the trusted root | The Claude root hook `.claude/hooks/block-unsafe-git.mjs`, through native `PreToolUse` permission control | A recognized direct relative cleanup call from an untrusted checkout is refused before loading its helper; only the plain trusted-root command receives cleanup-specific automatic approval, as [closeout step 5](../.agents/skills/closeout/SKILL.md) defines |
| A builder receives a bounded handoff | `.claude/hooks/check-builder-handoff.mjs` before every agent spawn | A handoff missing a required field, with an unfilled slot, or telling the builder to prove its own mutation |
| Green before a turn ends | `.claude/hooks/verify-green.sh` at turn end, in the checkout the session is working in (Codex twin under `.codex/hooks/`) | Finishing with a lint error; a check it could not run, because no project root resolved or a tool is absent, is stated as unverified rather than passed silently |
| The product's own checks pass | The product gates `scripts/gates/{stop,pre-commit}`: `stop` run by both Stop hooks on every turn end, and `pre-commit` run by `.githooks/pre-commit` on every commit | A turn end or commit whose product gate, when present, exits non-zero or is not executable; an absent gate changes nothing |
| Runner output stays readable | `.claude/hooks/filter-test-output.mjs` | Condenses a green run, passes a red run through in full |
| The artifact matches its source | The product gates `scripts/gates/{stop,pre-commit}`, where the repository supplies them (run on a merge that auto-commits through `.githooks/pre-merge-commit`), and CI | A turn end, commit or merge whose generated artifact, as the Conventions table names it, is not the byte-identical build of its source; a repository that supplies none enforces its generated artifacts by the checks its Conventions table names |
| The installed copy matches its source | In the canonical repository, a test in its script suite, run by `.githooks/pre-push` and CI | A push or merge where a shared file's source and the manifest disagree |
| Agent definitions parse and first-party charter bodies match | `.githooks/pre-commit` | A staged seat file the runtime would drop silently, a Claude seat file carrying an `initialPrompt` key, which never reaches a subagent, and Claude and Codex first-party charter bodies that differ beyond backticked `/name` versus `$name` skill invocations; runtime metadata is validated separately; reads staged blobs and matching staged validators for installed seats and canonical `src/` seats, with installed runtimes selected by staged settings and both required for source seats |
| Lint and the script suite pass | `.githooks/pre-push`, which on a push to `main` first runs the product gate `scripts/gates/pre-push-main` as it stands on the remote's `main`, from a copy of that commit's tree, before lint and the script suite | A push with a red script suite, and a push to `main` when the gate on the remote's `main` is missing, not executable or exits non-zero, or when the remote's `main` cannot be read |
| Shared workflow files match the manifest | `scripts/lib/workflow-contract.test.mjs`, run by `.githooks/pre-push` and CI | A push or merge where any file `.agents/factory-manifest.json` lists differs from its recorded hash, other than in a seat setting value the repository's own seat settings file names; the failure points to [canonical recording and recovery](../.agents/skills/shared-files/SKILL.md#canonical-recording), a release update in an adopter and `--render` for a seat setting |
| Only green code merges | Two branch rulesets on `main`, one requiring the checks the repository's branch rules name, `test` everywhere and `sweep-scope` as well where the documentation routines are active and the settings file does not turn the documentation sweep off, and auto-merge; the required-check ruleset lets the administrator role bypass it, which the direct documentation route depends on | A merge before every required check is green; on a draft the `test` gate reports under a different name so it can never satisfy the rule |
| Metered suites run on purpose | `.codex/rules/playwright.rules`, where the repository supplies that rule file | A browser run on Codex without a prompt |

## How it works

Cleanup has no static shell allowance. The installed Claude hook derives its root from its own file location,
then requires the submitted working directory and the hook process's actual directory to resolve to that same
main working tree. It also verifies that the helper resolves to the expected root path. An unrelated main
checkout or a matching helper in a linked job does not establish this identity. Every existing guard refusal
still takes precedence. After validation, the hook emits native `hookSpecificOutput.permissionDecision: "allow"`
for the narrow command grammar in [closeout step 5](../.agents/skills/closeout/SKILL.md); a recognized direct call
without trusted context exits 2. Quoted arguments, redirection or compounds do not escape that direct-call denial.
Forms outside that denial and automatic grammar receive ordinary runtime review, including an absolute path to a
current detached verifier's helper. Such a runtime approval is separate from the cleanup-specific hook grant.
[Claude's hook decision reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) describes the
native protocol; the helper's provenance, occupancy and Docker checks still decide whether targets can be removed.

This protection assumes intact trusted-root files and a trusted host and interpreter configuration.
[Closeout step 5](../.agents/skills/closeout/SKILL.md) owns cleanup activation checks before relying on it. Matching helper bytes do not pin the interpreter. The hook does not protect
against a hostile interpreter or changes to the trusted root itself.

Everything else, including which reviewer runs, when to stop and replan, and what the pull request body must say, is a
sentence in `AGENTS.md` or a skill. The bar for executable machinery is named in [`AGENTS.md`](../AGENTS.md) under
"Publication and machinery" and stated in full as the machinery rule in the `resume` skill under "4. Plan", the one
home for how machinery enters, grows and leaves.

A canonical repository may supply a local commit gate that records staged shared-file fingerprints automatically;
that gate does not travel to adopters. [Canonical recording](../.agents/skills/shared-files/SKILL.md#canonical-recording)
owns the staging and commit order, alternate-index caveat and refusal recovery. The repository's local profile names
whether it supplies that gate. Fingerprint checks still judge the recorded result.

A charter mismatch reports the seat, both paths and differing lines. Repair both canonical source charters together
and regenerate their installed copies before staging them; consumers receive the repair through a release update, as the
[`shared-files` skill](../.agents/skills/shared-files/SKILL.md) says.

### Keeping it small

The factory once carried its own ledger of workflow state, and maintaining that ledger consumed more effort
than the product it was built to deliver. The rule that came out of that: when a real failure exposes a
weakness, preserve the lesson at the cheapest layer that would have caught it. A sentence in `AGENTS.md` or a skill
first; evidence when behaviour can demonstrate the failure; a deterministic guard only when the failure recurs
despite the sentence, or immediately when the bad state is silent, misleading, security-sensitive, or hard to
reverse. Every new guard names its non-destructive recovery route in the same change. New controls replace
stale guidance rather than adding a second authority.

## Where the rules live

- [The `resume` skill](../.agents/skills/resume/SKILL.md) under "4. Plan", as the machinery rule: the bar new
  machinery must clear, how machinery leaves, and the tooling-growth comparison run only on the owner's request.
- The Surfaces table in [`AGENTS.md`](../AGENTS.md): the repository's own highest-consequence surfaces.
- [The head of `scripts/lib/unsafe-git.mjs`](../scripts/lib/unsafe-git.mjs): every command form the git guard
  refuses, and what it does not model.
- [`.claude/settings.json`](../.claude/settings.json) and [`.codex/hooks.json`](../.codex/hooks.json): which hook
  runs on which event.
- [`.githooks/README.md`](../.githooks/README.md): what the commit, merge and push hooks enforce, and how they run
  the repository's own optional gates.

## Failure modes

- **A runtime has not loaded or trusted the hooks.** Committed and registered hook configuration proves this repository
  contract; it does not prove that an already-running runtime loaded or trusted that configuration. When the active
  runtime cannot be observed, the delivery report still names that limit.
  [Closeout step 5](../.agents/skills/closeout/SKILL.md) owns cleanup activation and configuration recovery and
  selects the current verifier's eligible helper invocation, preserving targets until every safeguard passes.
- **A command is wrapped or disguised.** The git guard reads an agent's plainly written command and, apart from a
  plain `env` prefix in front of git, does not look inside a wrapper, so it catches accidents and is not a security
  boundary. The branch rules on the server bind only an identity that cannot bypass them; for the role that can, a
  push to `main` is judged by the pre-push hook, which is local.
  [The head of `scripts/lib/unsafe-git.mjs`](../scripts/lib/unsafe-git.mjs) says exactly what it does not model.
- **The push hook is skipped or changed.** Git runs the pre-push hook from the checkout that pushes. The hook judges a
  push to `main` with the gate as it stands on the remote's `main`, so a commit cannot admit itself by rewriting the
  gate or a file it loads. A push made with the hook skipped, from a clone where the hooks were never armed, or from a
  checkout whose copy of the hook was changed, or from a machine where the git configuration or attribute files git
  reads for that push, at any level, were changed is not judged at all. The permission prompt on a push is an approval
  checkpoint, not a second boundary: the git guard reads the command an agent submits, not what a program that command
  starts does afterwards, so nothing in the repository establishes that every way of publishing meets that prompt.
  A push that runs unprompted would need a boundary on the server first.
- **A guard refuses something legitimate.** A safeguard's refusal keeps its target and is reported with the
  evidence. The two verified branch exceptions in [closeout step 5](../.agents/skills/closeout/SKILL.md)
  cover the exact merged job head and a session-created pre-squash backup; that skill owns their proof and limits.
  They are session instructions, not executable provenance enforcement or promptless runtime permission. Every
  other refusal remains binding ([`AGENTS.md`](../AGENTS.md) under "Owner gates"); every new guard names its
  non-destructive recovery route in the change that adds it.

## Key files

- `.claude/hooks/` and `.codex/hooks/`: the runtime hooks.
- `.githooks/`: the commit, merge and push hooks.
- `scripts/gates/{stop,pre-commit}` and `scripts/gates/pre-push-main`: the repository's own optional gates.
- `scripts/lib/unsafe-git.mjs`: the git guard's rules.
- `scripts/lib/workflow-contract.test.mjs` and `.agents/factory-manifest.json`: the shared-file contract and the
  list it checks.
