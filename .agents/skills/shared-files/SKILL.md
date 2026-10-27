---
name: shared-files
description: The reference for how shared workflow files are kept, recorded and overridden: fingerprints, canonical recording, seat overrides, the runtimes, the external review add-on and the documentation sweep a repository's settings choose, and what a repository needs before it runs the workflow.
---

# shared-files

`AGENTS.md` owns what is shared, where it is authored and how it reaches another repository, under "Shared workflow
adoption"; this skill owns how shared files are fingerprinted, pinned and kept, and what a repository needs before it
runs the workflow.

**How shared files are kept.** The manifest's `canonical` repository authors each shared file under `src/` and keeps an
installed copy at its root with its fingerprint in the same commit; a test in its suite refuses a difference.
[Canonical recording](#canonical-recording) below owns how that fingerprint is recorded. Each adopter holds a copy
pinned at the named release it installed or last updated to, and a release update records that release in the
adopter's manifest. A shared file edited without its manifest hash following fails the contract test. Shared files
are real files, never symlinks, since a symlink reaches a Windows checkout as plain text: a skill lives in
`.agents/skills/` and is copied whole to `.claude/skills/`, and each hook directory carries its own `.gitattributes` so hooks keep LF endings wherever
line endings are converted; the contract test fails on a symlink, a copy that differs from its source, or a missing
rule. A git hook's run permission is its committed file mode.

## Canonical recording

Where the canonical repository's local profile names an automatic recording gate, stage the authored sources and
all corresponding installed copies, including both skill paths, together. The coordinating session then commits
the green slice before fingerprint-dependent convergence checks. The gate reads the active commit index, validates
source/copy bytes and modes for whole files and shared-region contents for region entries, and records their
fingerprints in the manifest in that same index and in the working tree. It stages only the manifest; copying and staging sources and installed
files remain the session's work. An unchanged manifest is left byte for byte as it is. This gate is a canonical-local
seam, not a shared file supplied to adopters; another canonical repository follows its own local profile.

Ordinary commits, `git commit -a`, path-only commits and a caller-selected `GIT_INDEX_FILE` use the index Git will
commit. An alternate index leaves the other index untouched. After a path-only or caller-selected-index commit,
inspect the retained manifest staging in the normal index before continuing: Git may retain different manifest
staging there. A later normal commit revalidates and recomputes its own fingerprints.

A refusal names its cause. Repair mismatched source/copy staging, missing membership, hidden index flags or existing
integrity failures before retrying; preserve unstaged manifest edits and stage or restore that manifest deliberately.
The destination must be a single-link regular manifest under unlinked directories. A write failure reports which
effects completed, so inspect the active index and working manifest and preserve user edits before staging or
restoring and retrying; a refusal after a write is not a rollback promise.

After history replay (rebase or cherry-pick) or resolving a manifest conflict, verify the intended source/copy
bytes and modes and fingerprint integrity; if recording did not run and fingerprints are stale, use the explicit
`--write` recovery below and stage the resulting manifest with the intended copies before continuing or committing.

`node scripts/factory-sync.mjs --write` remains explicit canonical recovery after the cause has been diagnosed and
repaired, and the recording route for a canonical repository whose local profile supplies no automatic gate. It
reads working files, so verify the intended source/copy bytes and modes first, then stage the resulting manifest
with them. Its canonical-origin check remains in force. In an adopter, restore local shared drift and apply the release
that carries the change with a release update; use `--render` for named seat settings as below. Neither route blesses
a local shared edit by refreshing canonical fingerprints.

## Repository settings and requirements

**How a repository overrides a seat.** Each seat file's setting lines, as the canonical repository ships them, are
the defaults: a model, an effort and a turn limit in a Claude seat file, and a model and an effort in a Codex seat
file, which carries no turn limit. An adopter that wants another value names the seat and the value in its seat
settings file, a committed file of its own that the manifest never lists and no tool writes; the head of
`scripts/lib/seat-settings.mjs` gives its path, its schema and what it refuses. `node scripts/factory-sync.mjs --render`
applies the file to the seat files and records each replaced default in the manifest, and every release update applies
it again to the release's bytes, so a setting the adopter does not name follows the canonical's next retune and a named
one stays.
The settings file, the seat files and the manifest are committed together; the contract test refuses a seat that
differs from the shared file anywhere but in a named value. An override changes a value the seat already carries. It
may raise or lower any seat's effort, put a cheaper model on a seat or lower a turn limit. It may never put the
costliest Claude or Codex model on a seat other than the ones `AGENTS.md` names for it under "Runtime notes", raise the
turn limit of the `oracle` or `security-reviewer` seat above 90, or leave a seat's model to the session with `inherit`;
a release update and `--render` refuse such a settings file before they write anything. Both judge only the values the
settings file names: a release update judges them with the validator of the Fabraik distribution that invokes it, and
`--render` with the copy of the workflow the repository has installed, so a value only a newer copy admits can be named
after the release update that installs it. Where a skill, a guide page or a seat's own description names a
seat's model or effort, it names the canonical default.

**How a repository names its runtimes.** The same settings file may carry `runtimes`, a list naming `claude`, `codex` or
both; without it the repository runs both. Everything shared under `.claude/`, and `CLAUDE.md`, belongs to Claude Code;
everything under `.codex/` to Codex; `scripts/lib/runtimes.mjs` names the few scripts tied to each; every other shared
file belongs to every install. An install and a release update write only the named runtimes' files and keep every
entry in the manifest. The contract test requires each path of a runtime the file leaves out to hold
nothing and refuses anything found there, and the agent check reads only the named runtimes' seats, comparing the
first-party charter bodies only where both run, with backticked `/name` versus `$name` skill invocations the only
allowed body differences and runtime metadata validated separately. The commit guard reads staged installed seats and their
matching staged validator using staged runtime settings; canonical `src/` seat checks use the matching staged source
validator and always require both runtimes. Repair a charter mismatch by editing both canonical source charters
together and regenerating their installed copies before staging; a consumer receives that repair through a release
update. The runtimes are chosen at install and changed later by a release update, to the installed release or a newer one,
run with the changed value left uncommitted: it writes the files of a runtime the value adds and removes those of one it
drops, under the same proof as any other write or removal.

**How a repository turns the external review add-on on or off.** The same settings file may carry `greptile`, `true` or
`false`; without it, as with `false`, the add-on is off. The add-on is an outside review of a `sign-off` tier change,
which the `resume` skill requests under "6. Verify and review". Its own files are the `greptile` skill, that skill's
`.claude/skills/` copy and the reviewer's configuration; `scripts/lib/runtimes.mjs` names their paths. An install and
a release update write them only where the add-on is on and keep every entry in the manifest, and the contract test
requires each of their paths to hold nothing where it is off and refuses anything found there. The add-on is chosen at
install, after the owner connects the repository to the review service in that service's own dashboard, which no
install does; it is changed later the same way as the runtimes: the update writes or removes the add-on's files to match, and the
owner connects or disconnects the repository in the service's dashboard, which no update does.

**How a repository turns the documentation sweep off.** The same settings file may carry `docSweep`, `true` or
`false`; without it, as with `true`, the sweep is on. Turning it off leaves out the sweep's shared files: the six of
the `sweep-scope` check, which are its workflow, its command and that command's modules and test, and the
documentation standard, `docs/DOCUMENTATION-STANDARD.md`; `scripts/lib/runtimes.mjs` names their paths. An
install and a release update write them unless the sweep is off and keep every entry in the manifest, and where it is
off the contract test requires each of their paths to hold nothing, refuses anything found there, and no longer
requires `docs/DOC-SWEEP.md` and `docs/SWEEP-TRIAGE.md`. A repository that turns the sweep off runs neither the sweep
nor its triage, because nothing there holds a routine's branch to the scope table, and no instruction treats either
routine as active there, whatever its Conventions table says: each instruction that reads that table's documentation
routines row also reads this key. The repository still keeps that row truthful, as its own record of what is
scheduled. The sweep is chosen at install, by the `docSweep` answer of
`fabraik init`, off unless answered `true`, and changed later the same way as the runtimes; the update writes or removes
the sweep's shared files to match, while the two manuals and the format pages are the repository's own files, which no
update writes or removes.

**What a repository needs.** The supported profiles are Claude Code alone, Codex alone, or both with cross-family
review. It needs a private repository whose default branch is `main`, the two branch rulesets with the administrator
bypass of the required check that the direct documentation route depends on, the required `test` check, the board,
dependencies installed at the repository root for the hooks, and each runtime having trusted the repository's
hooks, since a hook file a runtime has not trusted does not run. For a first install without a lockfile,
run `npm install` and commit that lockfile; use `npm ci` with an existing lockfile. The pre-push hook refuses a missing
installed ESLint before lint or tests and names both recovery paths. A repository that runs one runtime removes its own files of the other runtime and leaves the
other runtime's hook folder out of the `lint` script in its `package.json`; no release update carries those
project-owned changes. The shared `docLintVerdict` in `scripts/lib/doc-lint-verdict.mjs`, delivered with the shared
files, accepts a path reference, link or `CLAUDE.md` citation for whose target `needNotResolveCause` in
`scripts/lib/runtimes.mjs` gives a cause, and reads `CLAUDE.md` only where `leftOutCause` there gives none for it. The same resolution rule covers the sweep's shared files
and its two manuals where the documentation sweep is off. Older project-owned `scripts/doc-lint.mjs` commands that
compose the scans themselves must observe those same runtime and sweep rules; calling the shared verdict avoids
reimplementing them. Its `scripts/lib/doc-lint.test.mjs` command fixture must copy all modules the command imports,
including `scripts/lib/runtimes.mjs` and, when the command calls the shared verdict, `scripts/lib/doc-lint-verdict.mjs`.
The shared documents still name both runtimes, and the shared tests use the verdict's resolution rules.
