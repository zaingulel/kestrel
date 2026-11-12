---
description: The committed Git hooks that check commits, merges and pushes before they leave your machine, how to turn them on and what the main-branch gate may rely on.
---

# Git hooks

These Git hooks are committed, deterministic local gates that check your commits, merges and pushes before continuous
integration (CI) sees them. They move the repository's most-repeated discipline rules off agent and human memory, so a
mistake is caught before it reaches a metered CI run. Turn them on as [Activation](#activation) shows.

| Hook | What it enforces | Bypass |
|---|---|---|
| [`pre-commit`](#pre-commit) | Agent definitions parse, charters match and the product gate passes | `git commit --no-verify` |
| [`pre-merge-commit`](#pre-merge-commit) | `pre-commit` runs on a merge that would auto-commit | `git merge --no-verify` |
| [`pre-push`](#pre-push) | Dependencies, lint, tests, the gate on `main` and large-file uploads | `git push --no-verify` |

## pre-commit

The `pre-commit` hook runs one guard and one advisory, then the product gate.

The guard checks only what is staged and enforces two rules:

- Claude Markdown and Codex TOML agent definitions must parse (blocks silently-dropped agents).
- First-party charter bodies must match across runtimes apart from backticked `/name` versus `$name` skill
  invocations.

Runtime metadata has its own separate validation. The guard reads staged definitions and the matching staged
validator, including canonical `src/` seats. Installed checks select runtimes from staged settings, while source checks
require both runtimes.

The advisory never blocks: `scripts/doc-lint.mjs --staged` reports prose rot in staged documents and skills.

The product gate comes last. When an executable `scripts/gates/pre-commit` is present, it runs on every commit. Its
non-zero exit blocks the commit, and so does a gate file that is not executable.

A charter mismatch names both files and differing lines. Edit both canonical source charters together, and regenerate
their installed copies before staging them. A consumer receives that repair through a release update, as the
[`shared-files` skill](../.agents/skills/shared-files/SKILL.md) says.

## pre-merge-commit

The `pre-merge-commit` hook runs `pre-commit` on a merge that would auto-commit. A merge that auto-commits never runs
`pre-commit`. A merge driver that keeps one side of a generated artifact could otherwise commit it stale. This hook
gives the product gate that case.

## pre-push

The `pre-push` hook checks dependencies, lint and tests, and runs the product gate on a push to `main`. Last, a push
that uses Git Large File Storage (LFS) uploads its objects.

### Dependencies, lint and tests

Install the root dependencies first:

- For a first install without a lockfile, run `npm install`.
- With an existing lockfile, run `npm ci`.

If no executable ESLint exists in the root or its ancestors, the hook refuses the push before lint or tests. With
ESLint available, the hook runs `npm run lint` and the `scripts/lib` node:test suite:

- When npm is missing, the hook skips `npm run lint` with a warning.
- The hook invokes the suite as `node --test` directly, so a missing npm cannot bypass it.
- The suite fails closed on a missing node.

To add the repository's `npm test`, opt in with `RUN_TESTS=1 git push`.

### Pushes to main

Before lint and the suite, the product gate judges a push to `main` as the remote's `main` has it. The hook takes
three steps:

1. It exports that commit's tree to a temporary directory.
2. It runs that tree's `scripts/gates/pre-push-main <remote sha> <local sha>` there.
3. It removes the directory.

Any of these blocks the push:

- a gate that is missing or not executable on the remote's `main`
- a remote `main` the hook cannot read
- the gate's non-zero exit

Pushes to other branches never consult the gate.

When every ref goes to `main` and that gate exits 0 printing exactly `setting-only`, the hook skips the ESLint check,
lint and the suite. The hook shows any other output, and that output changes nothing.

### Git LFS uploads

Last, once all of that has passed, a push that uses Git LFS uploads its objects with `git lfs pre-push`. A push uses
Git LFS when either of these holds:

- A `.gitattributes` file at the pushed tip, `.git/info/attributes` or the per-user attributes file sets `filter=lfs`.
- A commit in the pushed range changed such a committed line.

A per-user file setting `filter=lfs` makes every repository on that machine count as using Git LFS. In such a
repository:

- `git lfs pre-push` uploads no object where no pointer was pushed.
- It still calls the endpoint's lock API, and a failure there can refuse the push.
- The hook refuses the push where `git-lfs` is missing.

Without `git-lfs`, the hook refuses such a push before lint or tests, including one that removes the tracking. A
failed upload refuses the push too. The exception is a committed `lfs.allowincompletepush = true`, which makes Git
LFS report success with objects missing. That leaves only the host's own check. `git push --dry-run` runs the hook,
so it uploads too.

`git lfs pre-push` takes its endpoint from Git config and from a committed `.lfsconfig` (`lfs.url`, `lfs.pushurl`,
`remote.<name>.lfsurl`). A commit can therefore send objects and credential requests to another server before any
review. Run a Git LFS version newer than 3.6.0, which fixed CVE-2024-53263. Only persistent Git config overrides a
committed `.lfsconfig`, because the hook scrubs `git -c` values.

A remote-tracking ref can stop matching the destination, for example after the remote's URL changed. It then hides
the commits it holds from both the hook's check and Git LFS's own upload, so their objects are not uploaded. To upload
them, run `git lfs push --all {{REMOTE}}`, where `{{REMOTE}}` is the name of the remote you push to, such as `origin`.

These go unseen:

- a pointer file with no `filter=lfs` line in any attributes file the hook reads
- attributes held only in the system file or reached through `attr.tree` or `GIT_ATTR_SOURCE`

The host's own Git LFS check is expected to refuse a push that leaves a pointer without its object. No test here
covers that check for a pointer with no `filter=lfs` line. That case may therefore reach the remote as a pointer with
no object.

## Activation

Hooks live here (not in `.git/hooks/`) so they travel with the repository. The `prepare` npm script wires them in
through `core.hooksPath`. It also registers any merge driver the product declares in `.gitattributes`:

```bash title="Terminal"
npm install        # runs `prepare`
```

To activate manually (or verify):

```bash title="Terminal"
git config core.hooksPath .githooks
git config --get core.hooksPath        # → .githooks
```

CI does not rely on these hooks: it runs the same checks as explicit steps. The product's own checks are the optional
gates `scripts/gates/{stop,pre-commit}` and `scripts/gates/pre-push-main`.

## What the main gate may rely on

The hook starts the gate in a copy of the remote main's tree. A file the gate loads by relative path is therefore the
one on `main`. `GIT_DIR` and `GIT_WORK_TREE` name the pushing repository, so git commands reach the pushed commits and
the working tree. The hook switches replacement references off, so git shows the real objects.

The gate must not change into the repository root or load a file from it by absolute path, because that file is the
pushed copy. The `resume` skill also runs the gate from the repository root, so the gate must work both ways. Paths
the tree marks `export-ignore`, and installed packages, are not in the copy. The gate loads only files in the copy, by
relative path, and Node built-ins. It never loads a package by bare specifier, which Node would look for in the
copy's ancestor directories.

A gate prints `setting-only` on stdout only after it has itself checked the push as a setting-only seat change its
rules permit. It prints that word to ask the hook to skip lint and the script suite, and prints nothing else on
stdout.

## Where to go next

- [The `shared-files` skill](../.agents/skills/shared-files/SKILL.md) says how a charter repair reaches a consumer.
- [Publication and machinery](../AGENTS.md#publication-and-machinery) says when a push to `main` is admitted.
