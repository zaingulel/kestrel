# Setting up Herdr on Windows

On Windows, `herdr-setup` adds the repository to the queue panel, opens the project's coordinator, and writes one
per-user Run value so the coordinator comes back at each logon.

## Before setup

1. Install Herdr with its official PowerShell installer: `irm https://releases.herdr.dev/app/install.ps1 | iex`.
   Run it from a terminal outside any agent session.
2. Install Claude Code and the GitHub CLI, and sign in to both as the user who will work on the repository. Setup reads
   the login from `gh api user`, so it stops where `gh` is not signed in.
3. Open Herdr from the Start menu and leave it open, so a core runs. Setup refuses where none answers.
4. Run `herdr-setup` and `herdr-check` from step 4 of SKILL.md, at the repository's root checkout.

## What setup writes

Setup writes the Run value `Fabraik coordinator <folder> <hash>` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. `<folder>` is the repository folder's name and `<hash>` the first 8
hex characters of the SHA-256 of the repository path, so each repository has its own value. The value runs `node` with
the distribution's `fabraik.mjs herdr-login --target <repository> --login <login>`.

## At logon

Each logon opens a console window that shows the opener's lines. The opener opens Herdr where no window answers, waits
up to 120 seconds for it, starts the coordinator in its tab and closes the window. On a failure the window stays open
with the cause until Enter.

The value names the distribution it was written from, which therefore stays in place. After an update, run setup again
from the new distribution; until then `herdr-check` prints `restart: not done` and names the value's old distribution.

## What the check reports

`herdr-check` on Windows prints `core`, `panel`, `coordinator`, `notifications` and `restart`. Notifications run on
Linux only, so that line reads `off (notifications run on Linux only)`, and off is not a failure.

## Removal

Delete the value for the repository, where `<name>` is the value's full name:

```bat
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "<name>" /f
```

## Running and delivering jobs

Jobs work on Windows the same as on Linux. Windows has no user IDs, file modes or execute bit, so the lane skips those
checks there and, like the cap lock, keeps its folders inside the user profile and refuses one outside it. Resuming a
recorded job session reads its workflow version from the job's label, as for a shell Herdr restored on Linux; it is not
yet proven on Windows.

## What is proven

The proof covers an administrator account delivering one Claude Code job to merge; a standard account running the
coordinator is unproven. Codex as the coordinator runtime on Windows
is built but unproven.
