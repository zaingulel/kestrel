# Two runtimes, one contract

A repository runs Claude Code, Codex or both, and its settings file names which. Each runtime reads the same contract,
skills and seat charters through its own copy or format. This page explains what they share, where each keeps its own
files, which layer of a working setup is the factory's, the repository's choice or a person's own, what changes on
native Windows, and how a card is built in a cloud session. This page is part of [the workflow guide](AI-WORKFLOW.md).
Related: [Enforced or instructed](AI-WORKFLOW-enforcement.md) for what the hooks refuse, and
[The seats](AI-WORKFLOW-seats.md) for the agent seats each runtime defines.

## Mental model

| What | Claude Code | Codex |
|---|---|---|
| The contract | `CLAUDE.md`, which imports `AGENTS.md` and adds its own notes | `AGENTS.md`, read directly |
| Skills | `.claude/skills/`, a byte-identical copy of each | `.agents/skills/`, read directly |
| Agent seats | `.claude/agents/` | `.codex/agents/` |
| Safety hooks | Wired by `.claude/settings.json` | Wired by `.codex/hooks.json` |
| Hook commands on native Windows | Run through Git Bash | Each handler's `commandWindows`, run through PowerShell |

## How it works

With both runtimes the factory switches between them when one runs out of budget; with one, only that runtime's column
of the table above is installed. Both read the same file: `AGENTS.md` is the contract, `CLAUDE.md` imports it and adds
its own Claude-only notes. Skills are shared in `.agents/skills/`, which Codex reads directly, and `.claude/skills/`
holds a byte-identical copy of each for Claude Code; they are real copies rather than symlinks so they survive a Windows
checkout. Some of those skills are themselves copied whole from `.agents/upstream/`, which holds one folder for each
upstream repository, a verbatim vendored copy kept with its own licence, so a vendored skill is invoked by the same name
and reached by the same path as a first-party one. Seventeen skills are vendored: thirteen from mattpocock/skills at
commit 24fe0ef7737efae15c87225755e9f6f5965e4888, in `.agents/upstream/mattpocock-skills/`; `frontend-design` from
anthropics/claude-plugins-official at commit 44490cccaf6d9f82fdeec9416fbf7c9bd72575dc, where it sits under
`plugins/frontend-design/skills/frontend-design/`, in `.agents/upstream/anthropics-claude-plugins-official/`; and
`accessibility-review` from anthropics/knowledge-work-plugins at commit 2d6f7e22dd25593f0f748010430ef86f19659735, where
it sits under `design/skills/accessibility-review/` and takes its licence from that repository's root `LICENSE`, in
`.agents/upstream/anthropics-knowledge-work-plugins/`. Two more, `supabase` and
`supabase-postgres-best-practices`, come from the official `supabase/agent-skills` repository at commit
c9be0e931b7930f7d02126d04774d904c381e7d7, under its `skills/` directory. The complete skill trees and repository-root
MIT `LICENSE` are kept in `.agents/upstream/supabase-agent-skills/`. The accessibility skill links to a `CONNECTORS.md` two folders above itself,
which upstream keeps at `design/CONNECTORS.md` to explain the plugin's placeholders for connected tools; it is an
optional reference that is not carried, so the link resolves to nothing by intent: from each of the skill's three copies
it would point outside the vendored folder, at a different place each time, and the accessibility audit follows no
connector note. [`AGENTS.md`](../AGENTS.md) owns how each copy is refreshed, under "Runtime notes". The agent seats
under `.claude/agents/` and `.codex/agents/` are maintained counterparts, with shared charters kept aligned across the
two runtime formats. The safety hooks exist as twins: `.claude/settings.json` wires the Claude set, `.codex/hooks.json`
the Codex set.

### On native Windows

On native Windows both runtimes need Git for Windows. Claude Code runs its hook commands through Git Bash (the
Claude hooks are unchanged; `CLAUDE_CODE_GIT_BASH_PATH` points it at a non-default install), and the `.sh` hooks and
their tests run through its `sh.exe`, which `scripts/lib/posix-shell.mjs` locates. Codex uses each handler's
`commandWindows` on Windows and runs it through the session's PowerShell. Each form is written so that a blocking
hook's exit code survives PowerShell and a missing `node` cannot read as a pass;
[`.codex/hooks.json`](../.codex/hooks.json) holds the forms, and
[the head of `scripts/lib/codex-hooks-windows.test.mjs`](../scripts/lib/codex-hooks-windows.test.mjs) explains
how each does that. The Stop hook's Windows form runs `.codex/hooks/verify-green.mjs`, which runs the same
`verify-green.sh` through that shell and blocks when none is found. The `.sh` hooks need LF endings, which each hook
directory's own `.gitattributes` keeps.
[`scripts/lib/codex-hooks-windows.test.mjs`](../scripts/lib/codex-hooks-windows.test.mjs) runs each registered
form through every PowerShell it finds on PATH and skips where it finds none, so it proves the repository's
contract, not that a running Codex fired it, and it proves that contract on Windows only where the repository's
continuous integration runs the test on a Windows runner; [`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) says
which suites run where.

Codex trusts each handler by a fingerprint of its event, matcher, `timeout`, `async`, `statusMessage`,
`additionalContextLimit`, and the one command it runs on the current platform: `commandWindows` on Windows when set,
`command` otherwise. It records that trust under the handler's position in its event's list
([command choice](https://github.com/openai/codex/blob/dfdb40cd0b72dfba3293db5c7c441232e8ef1a60/codex-rs/hooks/src/engine/discovery.rs#L503-L566)
and [`hook_hash`](https://github.com/openai/codex/blob/dfdb40cd0b72dfba3293db5c7c441232e8ef1a60/codex-rs/hooks/src/engine/discovery.rs#L766-L792)
in openai/codex). So a changed `commandWindows` needs re-approval only on Windows; a changed `command` needs it
on macOS and Linux, and on Windows only for a handler without `commandWindows`; any other fingerprinted change,
or moving a handler or inserting one ahead of it, needs it on every platform. Re-approve by running `/hooks` in
Codex at the repository root on each affected platform.

### In a cloud session

A Claude Code cloud session runs on a machine the platform provides, from a fresh clone, and `CLAUDE_CODE_REMOTE` reads
`true` there. Its GitHub requests pass through the platform's GitHub proxy, which refuses every GraphQL request whatever
the credential and attaches no network secret to a GitHub request, so the board scripts cannot run there and no token
given to the environment changes that. The session runs in auto mode, never Accept edits, in an environment that holds
no environment variables, no network secrets and no credential in its setup script. It acts on GitHub as the owner,
through tools no hook observes, so the skill's list of permitted writes is the only bound on what it publishes. The board is kept in step from the owner's machine: a local session claims the
card, waits for its draft with `node scripts/merge-watch.mjs --draft job/<issue>` and delivers it in the same session,
and the cloud session plans, builds, reviews and opens the draft pull request under that claim. Every review runs in
the cloud on Claude seats and the pull request body declares it, so no Codex review follows at delivery. A fix made
after the review of the final tree gets a review scoped to it before the draft opens, and the body names the commit the
last review covered, which delivery checks against the branch before it goes on. A card whose local session parks or
ends before the draft opens keeps its claim, and the next session offers its delivery first. Only a card that takes the
pull request route is built this way: a change the direct route to `main` admits is built locally. Codex has no cloud
build.

| Step | Where it runs | The card's column after it |
|---|---|---|
| Pick, claim with the runtime `Claude Code cloud`, move, start message carrying the claim's address | A local session | In progress |
| Plan, build, review, and a review scoped to any fix made after the review of the final tree | The cloud session | In progress |
| Draft pull request whose body names the commit the last review covered | The cloud session | In progress |
| Wait for the draft, then the owner's confirmation that the cloud session has stopped | The local session that gave the start message, or the next session, whose work-pick offers the card first | In progress |
| Reviewed commit checked against the branch, convergence checks again, visual work, push authorisation | The same local session | Awaiting push |
| Push, ready, auto-merge | The same local session | In review |
| Merge | The board's own Item closed workflow | Done |

| Check | In the cloud session | At local delivery |
|---|---|---|
| Git guard | Runs, as observed: it refuses a commit in the clone as the integration checkout, so the job runs in a worktree | Runs |
| Builder handoff check | Runs, as observed: it refuses a malformed builder dispatch | Runs |
| Turn-end check | Runs in the worktree, as observed: it refuses to end a turn on a lint error while `src/` has a pending change. The platform adds its own turn-end hook asking for untracked work to be committed and pushed, which the session answers only with the job's own commits | Runs |
| Git hooks | Armed by `npm ci`; run on every commit and push | Run |
| Claude seats | Run from `.claude/agents/`; a review seat that cannot be dispatched there stops the build | Not run again |
| Codex seats and cross-family review | None: there is no Codex command line, and the reviews run on Claude seats, declared in the pull request body | Not run |
| Convergence checks | Run; the body quotes the receipts | Run again, since the receipts stay on the cloud machine |
| Visual verification | Not run | Run |
| Reviewed commit | Named in the body on a `Reviewed commit:` line, once a review has covered every commit | Read from the draft; delivery stops and the owner is told where it is missing or is not the branch's head |

## What the factory carries, what setup chooses and what stays yours

A working setup has three layers, and each has one owner. The table says which layer a thing belongs to; the rules for
each thing stay in the homes listed under "Where the rules live".

| Layer | What it holds | Who changes it |
|---|---|---|
| The factory | The files `.agents/factory-manifest.json` lists: the contract, skills, seat charters, hooks and checks | Nobody in an adopting repository: a release update replaces them, and each is checked against its fingerprint |
| What setup chooses | The settings file `.agents/factory-settings.json`, which names the runtimes and records each yes the repository gave, a `crossFamilyReview` yes included, and the documents an install or the `fabraik-setup` skill writes for the repository | The repository: setup writes them once, and a person edits them afterwards |
| What stays yours | Each person's own home instructions and settings for a runtime | The person: an install never reads, copies or changes them |

Cross-family review is where the layers meet. A review by the other model family sends that family's provider the code,
the diff, the plan and the card. The yes that allows it is recorded as `"crossFamilyReview": true` in the settings file,
so it is a setup choice that travels with the repository on `main`: a person who clones the repository onto another
machine, or opens a new session there, finds it without carrying any home setting across. Naming both runtimes alone
does not record it, and a session that finds none asks the owner before it sends anything to the other family, as the
`resume` skill describes under "6. Verify and review".

That yes is a standing authorization to share material with the other provider and nothing more. It does not answer a
prompt. Claude Code's shared allow list includes `Bash(git worktree add .claude/worktrees/*)`, so matching job starts
receive configuration approval without auto mode's classifier judgment. For plainly written commands, the
`block-unsafe-git` hook refuses branch resets, force flags, paths that escape the worktrees folder and forms it cannot
read. The hook reads command text; it does not inspect extra arguments supplied from input by a wrapper such as
`xargs`.

Closeout's cleanup-specific automatic approval comes from the active trusted root hook, with no static cleanup
allowance. Only the plain command forms in [closeout step 5](../.agents/skills/closeout/SKILL.md) qualify after root
validation; a recognized direct relative call from an untrusted checkout is refused before its helper loads.
Unsupported forms outside that denial, including an absolute verifier-helper path, receive ordinary runtime review.
[The enforcement guide](AI-WORKFLOW-enforcement.md#how-it-works) explains the hook's identity checks and assumptions.
Individual `git worktree remove`, `git branch -d` and `rm` commands keep their existing permissions. The session still
verifies job identity, target ownership and disposability, and follows delivery and merge approval steps. An issue
number or path does not establish ownership; the helper checks removal safety and reports any retention.

The job form, `node scripts/closeout-cleanup.mjs <issue>`, accepts optional `--pr` with a canonical
`https://github.com/<owner>/<repository>/pull/<number>` address. Ordinary branch deletion runs first. With that option,
the helper can delete the exact verified merged head after Git's not-fully-merged refusal, only when all applicable
cleanup checks completed and no other target is retained. The [closeout skill](../.agents/skills/closeout/SKILL.md)
owns the proof and rechecks. Remote branch removal belongs to the existing
`gh pr merge --auto --squash --delete-branch` delivery command; the helper removes only the local branch. The unusual
pre-squash backup exception remains a separate procedure in the skill.

Other commands, the Codex command line included, follow Claude Code's runtime mode and permissions, including a person's own settings.
Codex asks as its sandbox and approval policy decide, a network request included. The operating system may ask as well,
for example before a program reaches a protected folder. Each prompt is answered where it appears, and the yes recorded
in the settings file stands apart from push authorisation too.

## Where the rules live

- [`AGENTS.md`](../AGENTS.md) under "Runtime notes": which file each runtime reads, and how the vendored skills
  are refreshed.
- [`.claude/settings.json`](../.claude/settings.json) and [`.codex/hooks.json`](../.codex/hooks.json): Claude Code's
  shared allowances, which hook runs on which event, and the Windows form of each Codex hook command.
- [The `closeout` skill](../.agents/skills/closeout/SKILL.md): scratch provenance, the checked cleanup command and
  the exact branch exceptions.
- [The head of `scripts/lib/codex-hooks-windows.test.mjs`](../scripts/lib/codex-hooks-windows.test.mjs): how each
  Windows form keeps a block a block.
- [The `resume` skill](../.agents/skills/resume/SKILL.md) under "Before intake": how a session checks that its hooks
  are running, and what the owner does when they are not.
- [`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md): which suites run on which platform.
- [The `shared-files` skill](../.agents/skills/shared-files/SKILL.md): how a repository names its runtimes, and which files
  each owns.
- [The `resume` skill](../.agents/skills/resume/SKILL.md) under "6. Verify and review": how a session reads the
  recorded cross-family authorization, what it asks where none is recorded, and that the authorization answers no
  permission prompt.
- [The `resume` skill](../.agents/skills/resume/SKILL.md) under "Cloud build": how a card is built in a cloud session,
  which cards the route carries, what a local session does at each end, and how a cloud claim is released.

## Failure modes

- **Codex fires no shell-command hook on Windows.** Two upstream limits stand: Codex does not yet emit `PreToolUse`
  for shell commands on Windows (openai/codex#24453), and there its shell payload wraps the command in a
  `powershell.exe -Command` string the git guard does not read.
- **A hook cannot run.** A hook that cannot run, because `node` is missing or because a Codex that finds no shell
  launches hooks through `cmd.exe /C`, which cannot read these forms, is reported as a failed hook and the action
  proceeds, as a failed hook does on macOS: the failure is visible, not blocking.
- **A runtime has not trusted the hooks.** A hook file a runtime has not trusted does not run. A session checks
  for this when it starts and tells the owner; [the `resume` skill](../.agents/skills/resume/SKILL.md) owns the
  check and the remedy under "Before intake".
- **A file of a runtime the repository does not run is in the tree.** The contract test refuses it by path. Remove it;
  the runtimes are chosen at install, and a release update refuses a change to them.
- **A session asks about cross-family review though the owner already said yes.** The yes counts only as
  `"crossFamilyReview": true` in `.agents/factory-settings.json` on `main`. A yes given in an earlier job's conversation, a
  home setting or a settings file naming both runtimes without the key records nothing, so the session asks once per
  job until the key is added and merged.
- **A prompt appears although the owner authorized cross-family review.** The authorization answers no permission
  prompt. Claude Code's shared rules approve matching job starts under `.claude/worktrees/` and the checked cleanup
  helper; the command-text guard has the limits described above. Other commands follow its runtime mode and permissions,
  including a person's own settings. Codex and the operating system each ask on their own rules.
- **Cleanup retains a target despite its allowance.** Configuration approval does not establish ownership or remove a
  safety check. When the merged-head exception is needed, missing credentials or unavailable merge proof keep the
  branch; unsupported platforms, unverifiable process use or failed Docker filesystem proof retain affected targets.
  An untrusted checkout or inactive hooks still needs the
  runtime trust and hook checks above. A retained target or runtime refusal is reported with its reason; the allowance
  makes no promise that every platform or target can complete cleanup without intervention.
- **A board script fails in a cloud session.** The proxy refuses GraphQL; a cloud session never runs them, and a local
  session moves the card.
- **A cloud session cannot confirm its claim.** It builds nothing: the claim its start message names was released,
  withdrawn or followed by a later claim, the issue is closed, or the job branch already exists.
- **A card goes back to `Ready` during a cloud build.** A released claim stops no cloud session that is already
  building, so the session that moves the card first has the owner confirm the cloud session has stopped and is
  archived. Only then does it release the claim, which keeps any later start message from building.
- **A cloud build turns out to be a direct-route change.** It opens no draft and the owner is told, because the route
  carries only pull request changes; such a card is built locally.
- **A cloud machine is reclaimed.** Only pushed work survives; the cloud session pushes its branch before it waits on
  the owner.
- **The local session ends before the draft opens.** The card keeps its `Claude Code cloud` claim in its column, and the
  next session's work-pick offers its delivery first: waiting for the draft, or delivering it once it is open.
- **The wait for the draft stops without one.** It exits non-zero with its reason as the last line, whether more than
  one pull request is open on the branch, the reply cannot be read or `gh` failed; the session tells the owner and waits
  again on the owner's say.
- **A draft names no reviewed commit, or one that is not its branch's head.** Delivery stops and the owner is told. A
  draft a cloud session opened before the review of the final tree is finished on the local route, its reviews
  included; a branch that moved after its last review is not delivered as reviewed.

## Key files

- `AGENTS.md` and `CLAUDE.md`: the contract, and the Claude Code import of it.
- `.agents/skills/` and `.claude/skills/`: the skills and their copies.
- `.agents/upstream/`: the vendored skills, one folder for each upstream repository.
- `.claude/agents/` and `.codex/agents/`: the seat files.
- `.claude/settings.json` and `.codex/hooks.json`: the hook registrations.
- `.codex/hooks/verify-green.mjs` and `scripts/lib/posix-shell.mjs`: the Windows route to the shell hooks.
- `scripts/lib/codex-hooks-windows.test.mjs`: the proof of the Windows registrations.
- `scripts/lib/runtimes.mjs`: which shared path belongs to which runtime, and which paths a repository's settings leave out.
- `scripts/merge-watch.mjs`: with `--draft`, the local session's wait for a cloud build's draft.
