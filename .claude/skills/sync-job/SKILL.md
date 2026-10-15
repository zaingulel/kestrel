---
name: sync-job
description: Run a sync job, which copies the shared workflow files from the canonical repository into this repository. Use only when the job's card is a sync card.
---

# sync-job

`AGENTS.md` owns what is shared, where it is authored and when a sync card is opened, under "Shared workflow adoption";
this skill owns how a sync job runs, which cards it covers and how they close, how shared files are fingerprinted,
pinned and kept, and what a repository needs before it runs the workflow.

A sync card runs `node scripts/factory-sync.mjs --from <canonical checkout>` from the adopter's job worktree against a
clean canonical checkout at its fetched `main`. That run copies everything on the canonical `main`, so one sync job
resolves every open sync card in the adopter whose change it carried. The same run removes each file the adopter's
committed manifest listed and the canonical no longer shares, when the adopter's copy is committed and byte for byte
the one last synced, and prints it; anything else at such a path stops the run before it writes, naming the path. A
card is covered when `git merge-base --is-ancestor` shows its canonical merge commit is an ancestor of the canonical
commit the run copied from, and its acceptance criteria hold in the adopter; the job's pull request body lists each
covered card with that evidence. After the merge, the job's own card closes as completed and closeout closes each
covered card as not planned, with a comment naming the card that did the sync and quoting its evidence. A card whose
change merged after the run, or whose evidence the job cannot show, stays open.

Installed, retired and left-out shared paths, including the manifest, carrying `skip-worktree` or
`assume-unchanged` refuse before any write: either index mark hides changes from `git status`, so the sync cannot
prove the path clean. Clear both marks with `git update-index --no-skip-worktree -- <path>` and
`git update-index --no-assume-unchanged -- <path>`, then commit or restore whatever `git status` reveals there before
syncing again.

**How shared files are kept.** The manifest's `canonical` repository authors each shared file under `src/` and keeps an
installed copy at its root in the same commit, fingerprinted with `node scripts/factory-sync.mjs --write`; a test in its
suite refuses a difference. Each adopter holds a copy pinned at the commit its manifest records as `syncedFrom`. Only
the canonical repository's manifest holds `adopters`, the list of them: a sync writes an adopter's manifest without that
list and removes one an earlier sync left there, so an adopter's manifest names the canonical repository and no other
adopter, and `--check` does not compare the list. A shared file edited without its manifest hash following fails the
contract test; `--write` refreshes the hashes, and only in the canonical repository. Shared files are real files, never
symlinks, since a symlink reaches a Windows checkout as plain text: a skill lives in `.agents/skills/` and is copied
whole to `.claude/skills/`, and each hook directory carries its own `.gitattributes` so hooks keep LF endings wherever
line endings are converted; the contract test fails on a symlink, a copy that differs from its source, or a missing
rule. A git hook's run permission is its committed file mode.

**When a run leaves `adopters` behind.** The adopter's own copy of the tool runs the sync, before the run replaces it,
so a copy that writes `adopters` leaves the canonical's list in the adopter's manifest, where it can name adopters that
manifest never held. A sync job publishes no commit that holds the list. Where a run leaves it, record
`git rev-parse HEAD` as `<before-sync>`, then commit the run's result locally, since a sync refuses a target with
uncommitted changes at shared paths; run the sync again in the same job, which the copy just installed runs and which
removes the list, and commit that result too; then squash the two commits with `git reset --soft <before-sync>` and
`git commit`. Nothing is pushed, a handoff's push included, while a commit the job added, any commit after
`<before-sync>`, holds `adopters` in the manifest, and a job that cannot remove the list stops there and goes back to
the owner.

**How a repository overrides a seat.** Each seat file's setting lines, as the canonical repository ships them, are
the defaults: a model, an effort and a turn limit in a Claude seat file, and a model and an effort in a Codex seat
file, which carries no turn limit. An adopter that wants another value names the seat and the value in its seat
settings file, a committed file of its own that the manifest never lists and no tool writes; the head of
`scripts/lib/seat-settings.mjs` gives its path, its schema and what it refuses. `node scripts/factory-sync.mjs --render`
applies the file to the seat files and records each replaced default in the manifest, and every sync applies it again
to the fetched bytes, so a setting the adopter does not name follows the canonical's next retune and a named one stays.
The settings file, the seat files and the manifest are committed together; the contract test refuses a seat that
differs from the shared file anywhere but in a named value. An override changes a value the seat already carries. It
may raise or lower any seat's effort, put a cheaper model on a seat or lower a turn limit. It may never put the
costliest Claude or Codex model on a seat other than the ones `AGENTS.md` names for it under "Runtime notes", raise the
turn limit of the `oracle` or `security-reviewer` seat above 90, or leave a seat's model to the session with `inherit`;
the sync and `--render` refuse such a settings file before they write anything. Both judge only the values the settings
file names, with the copy of the workflow the repository has installed, so a value only a newer copy admits can be
named after the sync that installs it. Where a skill, a guide page or a seat's own description names a seat's model or
effort, it names the canonical default.

**How a repository names its runtimes.** The same settings file may carry `runtimes`, a list naming `claude`, `codex` or
both; without it the repository runs both. Everything shared under `.claude/`, and `CLAUDE.md`, belongs to Claude Code;
everything under `.codex/` to Codex; `scripts/lib/runtimes.mjs` names the few scripts tied to each; every other shared
file belongs to every install. A sync writes only the named runtimes' files and keeps every entry in the manifest, so
`--check` still compares like with like. The contract test requires each path of a runtime the file leaves out to hold
nothing and refuses anything found there, and the agent check reads only the named runtimes' seats, comparing the
first-party charter bodies only where both run, with backticked `/name` versus `$name` skill invocations the only
allowed body differences and runtime metadata validated separately. The commit guard reads staged installed seats and their
matching staged validator using staged runtime settings; canonical `src/` seat checks use the matching staged source
validator and always require both runtimes. Repair a charter mismatch by editing both canonical source charters
together and regenerating their installed copies before staging; a consumer receives that repair through a sync.
To stop running a runtime, remove its seat overrides and run `--render`, name the remaining runtime, commit, then sync: the sync removes each of the other runtime's files that holds exactly the bytes it
recorded and refuses, by name, one that holds anything else. To start running one, name it, commit and sync.

**How a repository turns the external review add-on on or off.** The same settings file may carry `greptile`, `true` or
`false`; without it, as with `false`, the add-on is off. The add-on is an outside review of a `sign-off` tier change,
which the `resume` skill requests under "6. Verify and review". Its own files are the `greptile` skill, that skill's
`.claude/skills/` copy and the reviewer's configuration; `scripts/lib/runtimes.mjs` names their paths. A sync writes
them only where the add-on is on and keeps every entry in the manifest, and the contract test requires each of their
paths to hold nothing where it is off and refuses anything found there. To turn the add-on on, the owner first connects
the repository to the review service in that service's own dashboard, which no sync does; then set `"greptile": true`,
commit and sync. To turn it off, set `false` or remove the key, commit, then sync: the sync removes each of the
add-on's files that holds exactly the bytes it recorded and refuses, by name, one that holds anything else. That job is
still delivered under the value `main` held, so where its tier is `sign-off` it owes the external review although its
own worktree no longer holds the add-on's skill; the `resume` skill says, under "6. Verify and review", how it reads
that skill from the fetched `main`. The reviewer's configuration is what keeps the service to the reviews a session
requests, and it leaves the branch with the other two files, so the owner also disables the repository in the
service's dashboard: once that job's external review has settled where its tier requires one, never before, because a
request the service does not answer leaves the draft unsettled, and at once where its tier requires none. A copy of
the tool older than this rule refuses the key, so the sync that installs this rule runs before the key is added; that
sync writes the add-on's files whatever the setting, and the contract test then reports them as expected absent until
the repository either turns the add-on on, or commits the run's result, runs the sync again, which the copy just
installed runs and which removes them, and squashes the two commits as "When a run leaves `adopters` behind" does.

**How a repository turns the documentation sweep off.** The same settings file may carry `docSweep`, `true` or
`false`; without it, as with `true`, the sweep is on. Turning it off leaves out the six files of the `sweep-scope`
check: its workflow, its command and that command's modules and test; `scripts/lib/runtimes.mjs` names their paths. A
sync removes none of a repository's own tests that read those files, so before it commits that sync the repository
deletes each such test or has it judge nothing where the sweep is off. A sync writes them unless the sweep is off and
keeps every entry in the manifest, and where it is off the contract test requires each of their paths to hold nothing,
refuses anything found there, and no longer requires `docs/DOC-SWEEP.md` and `docs/SWEEP-TRIAGE.md`. A repository that
turns the sweep off runs neither the sweep nor its triage, because nothing there holds a routine's branch to the scope
table, and no instruction treats either routine as active there, whatever its Conventions table says: each instruction
that reads that table's documentation routines row also reads this key. The repository still keeps that row truthful, as
its own record of what is scheduled. To turn the sweep off, in this order: stop both routines; remove `sweep-scope` from
the checks the branch ruleset requires, a ruleset change the `resume` skill holds to the owner's sign-off and a
read-back under "6. Verify and review", because a required check whose workflow has left `main` never reports and every
later pull request then waits on it; then set `"docSweep": false`, commit and sync: the sync removes each of the six
files that holds exactly the bytes it recorded and refuses, by name, one that holds anything else. A copy of the tool
older than this rule refuses the key, so the sync that installs this rule runs before the key is added; that sync writes
the six files as every earlier one did, and the repository then sets the key, commits, runs the sync again, which the
copy just installed runs and which removes them, and squashes these commits as "When a run leaves `adopters` behind"
does. To turn the sweep on again, restore the two manuals, remove the key or set `true`, commit and sync, then require
`sweep-scope` again before either routine runs.

**What a repository needs.** The supported profiles are Claude Code alone, Codex alone, or both with cross-family
review. It needs a private repository whose default branch is `main`, the two branch rulesets with the administrator
bypass of the required check that the direct documentation route depends on, the required `test` check, the board,
`npm ci` for the hooks, and each runtime having trusted the repository's hooks, since a hook file a runtime has not
trusted does not run. A repository that runs one runtime removes its own files of the other runtime and leaves the
other runtime's hook folder out of the `lint` script in its `package.json`; no sync carries those project-owned changes.
The shared `docLintVerdict` in `scripts/lib/doc-lint-verdict.mjs`, delivered by sync, accepts a path reference, link or
`CLAUDE.md` citation for whose target `needNotResolveCause` in `scripts/lib/runtimes.mjs` gives a cause, and reads
`CLAUDE.md` only where `leftOutCause` there gives none for it. The same resolution rule covers the sweep's six files
and its two manuals where the documentation sweep is off. Older project-owned `scripts/doc-lint.mjs` commands that
compose the scans themselves must observe those same runtime and sweep rules; calling the shared verdict avoids
reimplementing them. Its `scripts/lib/doc-lint.test.mjs` command fixture must copy all modules the command imports,
including `scripts/lib/runtimes.mjs` and, when the command calls the shared verdict, `scripts/lib/doc-lint-verdict.mjs`.
The shared documents still name both runtimes, and the shared tests use the verdict's resolution rules.
