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
| No unsafe git or GitHub command | `.claude/hooks/block-unsafe-git.mjs` before every shell command (Codex twin under `.codex/hooks/`) | The command forms listed at [the head of `scripts/lib/unsafe-git.mjs`](../scripts/lib/unsafe-git.mjs), which also says what the guard does not model |
| A builder receives a bounded handoff | `.claude/hooks/check-builder-handoff.mjs` before every agent spawn | A handoff missing a required field, with an unfilled slot, or telling the builder to prove its own mutation |
| Green before a turn ends | `.claude/hooks/verify-green.sh` at turn end, in the checkout the session is working in (Codex twin under `.codex/hooks/`) | Finishing with a lint error; a check it could not run, because no project root resolved or a tool is absent, is stated as unverified rather than passed silently |
| The product's own checks pass | The product gates `scripts/gates/{stop,pre-commit}`: `stop` run by both Stop hooks on every turn end, and `pre-commit` run by `.githooks/pre-commit` on every commit | A turn end or commit whose product gate, when present, exits non-zero or is not executable; an absent gate changes nothing |
| Runner output stays readable | `.claude/hooks/filter-test-output.mjs` | Condenses a green run, passes a red run through in full |
| The artifact matches its source | The product gates `scripts/gates/{stop,pre-commit}`, where the repository supplies them (run on a merge that auto-commits through `.githooks/pre-merge-commit`), and CI | A turn end, commit or merge whose generated artifact, as the Conventions table names it, is not the byte-identical build of its source; a repository that supplies none enforces its generated artifacts by the checks its Conventions table names |
| The installed copy matches its source | In the canonical repository, a test in its script suite, run by `.githooks/pre-push` and CI | A push or merge where a shared file's source and the manifest disagree |
| Agent definitions parse and the reviewer charter matches | `.githooks/pre-commit` | A staged seat file the runtime would drop silently, a Claude seat file carrying an `initialPrompt` key, which never reaches a subagent, and Claude and Codex reviewer charters that differ beyond the skill-invocation sigil, compared only where the repository runs both |
| Lint and the script suite pass | `.githooks/pre-push`, which on a push to `main` first runs the product gate `scripts/gates/pre-push-main` as it stands on the remote's `main`, from a copy of that commit's tree, before lint and the script suite | A push with a red script suite, and a push to `main` when the gate on the remote's `main` is missing, not executable or exits non-zero, or when the remote's `main` cannot be read |
| Shared workflow files match the manifest | `scripts/lib/workflow-contract.test.mjs`, run by `.githooks/pre-push` and CI | A push or merge where any file `.agents/factory-manifest.json` lists differs from its recorded hash, other than in a seat setting value the repository's own seat settings file names; the failure names the fix routes, `--write` in the canonical repository, a sync in an adopter and `--render` for a seat setting |
| Only green code merges | Two branch rulesets on `main`, one requiring the checks the repository's branch rules name, `test` everywhere and `sweep-scope` as well where the documentation routines are active, and auto-merge; the required-check ruleset lets the administrator role bypass it, which the direct documentation route depends on | A merge before every required check is green; on a draft the `test` gate reports under a different name so it can never satisfy the rule |
| Metered suites run on purpose | `.codex/rules/playwright.rules`, where the repository supplies that rule file | A browser run on Codex without a prompt |

## How it works

Everything else, including which reviewer runs, when to stop and replan, and what the pull request body must say, is a
sentence in `AGENTS.md` or a skill. The bar for executable machinery is named in [`AGENTS.md`](../AGENTS.md) under
"Publication and machinery" and stated in full as the machinery rule in the `resume` skill under "4. Plan", the one
home for how machinery enters, grows and leaves.

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
  machinery must clear, and how machinery leaves.
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
  evidence, never forced ([`AGENTS.md`](../AGENTS.md) under "Owner gates"); every new guard names its
  non-destructive recovery route in the change that adds it.

## Key files

- `.claude/hooks/` and `.codex/hooks/`: the runtime hooks.
- `.githooks/`: the commit, merge and push hooks.
- `scripts/gates/{stop,pre-commit}` and `scripts/gates/pre-push-main`: the repository's own optional gates.
- `scripts/lib/unsafe-git.mjs`: the git guard's rules.
- `scripts/lib/workflow-contract.test.mjs` and `.agents/factory-manifest.json`: the shared-file contract and the
  list it checks.
