# Git hooks (committed, deterministic gates)

These hooks move the repository's most-repeated discipline rules off agent and human memory
and onto committed local gates, so a mistake is caught before it reaches a metered CI run.

| Hook | What it enforces | Bypass |
|---|---|---|
| `pre-commit` | One guard, scoped to what is staged: Claude Markdown and Codex TOML agent definitions must parse (blocks silently-dropped agents), and first-party charter bodies must match across runtimes apart from backticked `/name` versus `$name` skill invocations. Runtime metadata is validated separately. The guard reads staged definitions and the matching staged validator, including canonical `src/` seats; installed checks select runtimes from staged settings, while source checks require both runtimes. One advisory, never blocking: `scripts/doc-lint.mjs --staged` reports prose rot in staged documents and skills. Then the product gate: an executable `scripts/gates/pre-commit`, when present, runs on every commit, and its non-zero exit, or a gate file that is not executable, blocks the commit. | `git commit --no-verify` |
| `pre-merge-commit` | Runs `pre-commit` on a merge that would auto-commit. A merge that auto-commits never runs `pre-commit`, so a merge driver that keeps one side of a generated artifact could otherwise commit it stale; this hook gives the product gate that case. | `git merge --no-verify` |
| `pre-push` | Root dependencies must be installed: `npm install` for a first install without a lockfile, or `npm ci` with an existing lockfile. Missing executable ESLint in the root or its ancestors refuses before lint or tests. With ESLint available, `npm run lint` (skipped with a warning when npm is missing) and the `scripts/lib` node:test suite (invoked as `node --test` directly so a missing npm cannot bypass it; fails closed on a missing node). Opt into the repository's `npm test` with `RUN_TESTS=1 git push`. Before both, a push to `main` is judged by the product gate as the remote's `main` has it: the hook exports that commit's tree to a temporary directory, runs its `scripts/gates/pre-push-main <remote sha> <local sha>` there and removes the directory; a gate that is missing or not executable on the remote's `main`, a remote `main` the hook cannot read, or the gate's non-zero exit blocks the push, and pushes to other branches never consult it. Last, once all of that has passed, a push that uses Git LFS uploads its objects with `git lfs pre-push`. A push uses it when a `.gitattributes` file at the pushed tip, `.git/info/attributes` or the per-user attributes file sets `filter=lfs`, or a commit in the pushed range changed such a committed line. A per-user file setting `filter=lfs` makes every repository on that machine count as using Git LFS: `git lfs pre-push` then uploads no object where no pointer was pushed, though it still calls the endpoint's lock API and a failure there can refuse the push, and the push is refused where `git-lfs` is missing. Without `git-lfs` such a push is refused before lint or tests, including one that removes the tracking, and a failed upload refuses it, except that a committed `lfs.allowincompletepush = true` makes Git LFS report success with objects missing, which leaves only the host's own check. `git push --dry-run` runs the hook, so it uploads too. `git lfs pre-push` takes its endpoint from Git config and from a committed `.lfsconfig` (`lfs.url`, `lfs.pushurl`, `remote.<name>.lfsurl`), so a commit can send objects and credential requests to another server before any review; run a Git LFS version newer than 3.6.0, which fixed CVE-2024-53263, and know that only persistent Git config overrides a committed `.lfsconfig`, because the hook scrubs `git -c` values. A remote-tracking ref that no longer matches the destination, for example after the remote's URL changed, hides the commits it holds from both the hook's check and Git LFS's own upload, so their objects are not uploaded; `git lfs push --all <remote>` uploads them. A pointer file with no `filter=lfs` line in any attributes file the hook reads, and attributes held only in the system file or reached through `attr.tree` or `GIT_ATTR_SOURCE`, are not seen. A push that leaves a pointer without its object is expected to be refused by the host's own Git LFS check, which has not been tested here for a pointer with no `filter=lfs` line, so that case may reach the remote as a pointer with no object. | `git push --no-verify` |

A charter mismatch names both files and differing lines. Edit both canonical source charters together and regenerate
their installed copies before staging them; a consumer receives that repair through a release update, as the
[`shared-files` skill](../.agents/skills/shared-files/SKILL.md) says.

## Activation

Hooks live here (not in `.git/hooks/`) so they travel with the repository. They are wired via
`core.hooksPath`, set by the `prepare` npm script, which also registers any merge driver the
product declares in `.gitattributes`:

```bash
npm install        # runs `prepare`
```

To activate manually (or verify):

```bash
git config core.hooksPath .githooks
git config --get core.hooksPath        # → .githooks
```

CI does not rely on these hooks: it runs the same checks as explicit steps. The product's own
checks are the optional gates `scripts/gates/{stop,pre-commit}` and `scripts/gates/pre-push-main`.

## What the main gate may rely on

The gate is started from a copy of the remote main's tree, so a file it loads by relative path is the one on `main`.
`GIT_DIR` and `GIT_WORK_TREE` name the pushing repository, so git commands reach the pushed commits and the working
tree, and replacement references are switched off, so git shows the real objects. The gate must not change into the
repository root or load a file from it by absolute path, because that file is the pushed copy. The `resume` skill also
runs the gate from the repository root, so it must work both ways. Paths the tree marks `export-ignore`, and installed
packages, are not in the copy. The gate loads only files in the copy, by relative path, and Node built-ins, never a
package by bare specifier, which Node would look for in the directories above the copy.
