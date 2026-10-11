# Git hooks (committed, deterministic gates)

These hooks move the repository's most-repeated discipline rules off agent and human memory
and onto committed local gates, so a mistake is caught before it reaches a metered CI run.

| Hook | What it enforces | Bypass |
|---|---|---|
| `pre-commit` | One guard, scoped to what is staged: Claude Markdown and Codex TOML agent definitions must parse (blocks silently-dropped agents). One advisory, never blocking: `scripts/doc-lint.mjs --staged` reports prose rot in staged documents and skills. Then the product gate: an executable `scripts/gates/pre-commit`, when present, runs on every commit, and its non-zero exit, or a gate file that is not executable, blocks the commit. | `git commit --no-verify` |
| `pre-merge-commit` | Runs `pre-commit` on a merge that would auto-commit. A merge that auto-commits never runs `pre-commit`, so a merge driver that keeps one side of a generated artifact could otherwise commit it stale; this hook gives the product gate that case. | `git merge --no-verify` |
| `pre-push` | `npm run lint` (skipped with a warning when eslint is missing) and the `scripts/lib` node:test suite (invoked as `node --test` directly so a missing npm cannot bypass it; fails closed on a missing node). Opt into the repository's `npm test` with `RUN_TESTS=1 git push`. Before both, a push to `main` is judged by the product gate as the remote's `main` has it: the hook exports that commit's tree to a temporary directory, runs its `scripts/gates/pre-push-main <remote sha> <local sha>` there and removes the directory; a gate that is missing or not executable on the remote's `main`, a remote `main` the hook cannot read, or the gate's non-zero exit blocks the push, and pushes to other branches never consult it. | `git push --no-verify` |

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
