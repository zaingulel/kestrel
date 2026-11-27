---
name: herdr-setup
description: Set up this machine to run the repository's Fabraik work in Herdr. Use when the `herdr` setting is turned on, or when asked to set up or check Herdr for the repository.
---

# herdr-setup

Herdr is a terminal app, and this add-on runs the repository's work in it. A repository whose settings file holds
`"herdr": true` carries this skill, and each machine that works on the repository follows its steps once. With the
setting off or absent, the repository carries no file of the add-on and its work runs without Herdr.

## 1. Install Herdr

Install Herdr and its core as Herdr's own documentation says at https://herdr.dev/core/. The step is done when
`hc --version` prints Herdr's version. Where `hc --version` already prints a version, Herdr is installed: skip the
installer. On Windows, install Herdr with its official PowerShell installer and follow
[references/windows.md](references/windows.md). Run the installer only from a terminal outside any agent session, since on an existing install it can restart
the core from the caller's environment.

## 2. Start the core with a clean environment

The core keeps the environment of whoever starts it, so a core started from an agent session carries that session's
settings into every agent it runs. On Windows, follow [references/windows.md](references/windows.md) first: Herdr's Start menu
entry opens the core and no unit applies. On Linux, start the core from a login unit, and never from an agent session. On Linux and
macOS, any `hc` command that needs a core, `hc server status` included, starts one from the caller's environment when
none is live, and which core it reaches depends on that environment, so in every step of this skill check for a live
core only with `pgrep -a herdr-core`, which starts nothing. On Windows, follow [references/windows.md](references/windows.md) instead of `pgrep`.

On a Linux machine with systemd and a graphical desktop login, first run `pgrep -a herdr-core`. A machine reached only
over SSH never starts `graphical-session.target`, so this unit does not start its core there, and this skill gives no
step for such a machine. Where `pgrep -a herdr-core` prints nothing, save this user unit as
`~/.config/systemd/user/<unit>.service`, with the full path to `hc` in `ExecStart`:

```ini
[Unit]
Description=Herdr core
After=graphical-session-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=<path to hc> server start

[Install]
WantedBy=graphical-session.target
```

Enable it with `systemctl --user enable <unit>`, so the unit is the first thing to start the core at the next login.
After that login, first run `systemctl --user status <unit>` and `pgrep -a herdr-core`; the step is done when the unit
shows it ran and `pgrep` shows a core. Where the unit did not run, as on a desktop that never starts
`graphical-session.target`, this unit does not suit the machine: run no `hc` command that needs a core and follow
Herdr's documentation for starting the core at login. With the current core, `hc server start` exits once the core has
started and the core runs in a transient unit of its own, outside the starting unit's control group, so stopping the
starting unit does not stop the core.

The clean environment holds only where this unit started the core. A core can outlive a logout, and the unit stays
active after its first run, so a fresh login alone does not prove a fresh core. Where `pgrep -a herdr-core` shows a core
already live, this skill gives no assurance about that core's environment: follow Herdr's documentation for that
case, and leave `hc server restart` out of it, since whether a restart takes a new environment is not established.

On any other system, follow Herdr's documentation for starting the core at login with a clean environment.

## 3. Install the queue panel

The queue panel is the Inbox, opened from its button beside Files. It lists who needs the owner and what is running,
read from Herdr, and opens Decisions, Floor and Board over the window for the repositories it reads. Install it once per
machine, naming every repository on the machine that the panel reads:

```sh
node <fabraik distribution>/scripts/fabraik.mjs herdr <tag> --repository <dir> [--repository <dir>]...
```

`<tag>` is the release the repository's manifest records. The command writes the panel to
`<Herdr home>/mods/fabraik-queue/` and its record to `<Herdr home>/fabraik-queue/machine.json`, the Herdr home being
`HERDR_APP_HOME` where that is set and `~/.config/herdr-app` otherwise. Beside it, the command derives from that Herdr
home's own modules an Inbox tab bar at `<Herdr home>/mods/fabraik-tabs/`, a spaces list at
`<Herdr home>/mods/fabraik-spaces/` and job delivery status on the Agents rows at
`<Herdr home>/mods/fabraik-agents/`. It writes `<Herdr home>/layouts/fabraik.json` and switches the open window to
the `fabraik` layout, with an Inbox button after Files. Where no window answers, it prints the
`herdr-app do layout.switch --name fabraik` command to run with Herdr open. The step is done when the command prints
`herdr: installed the queue panel from release <tag>`. Any other outcome names what stopped it and what to do next.

The spaces list is derived from Herdr's own. A repository shows its logo there by keeping one square
`herdr-logo.svg` or `herdr-logo.png` in its `.agents` folder, at most 1 MiB, with its own background so it reads on
light and dark themes. A repository without one keeps Herdr's letter tile. After adding or changing a logo, adding a
repository or upgrading Herdr, run the command again.

A later release replaces the panel: run the command again with its tag. `--repository` replaces the list of
repositories the panel reads, and leaving it out keeps the list the record holds. After each Herdr upgrade, run
`herdr-app check <Herdr home>/mods/fabraik-queue`.

## 4. Set up this machine for the repository

Run these at the repository's root checkout, never a job worktree, with the add-on on in fetched `main` settings, on the
Linux or Windows machine that runs Herdr, and with a live core from step 2 (on Windows, the one Herdr's Start menu entry opens):

```sh
node <fabraik distribution>/scripts/fabraik.mjs herdr-setup [--target <dir>]
node <fabraik distribution>/scripts/fabraik.mjs herdr-check [--target <dir>]
```

An agent may run both. `herdr-setup` reads everything first and refuses, changing nothing, where a read fails. It then
adds the repository to the queue panel's list, keeping the repositories already listed, and opens the project's
coordinator through `scripts/coordinator.mjs open`. On Linux it writes, enables and starts no service. On Windows it then
writes one per-user Run value, so the coordinator comes back at each logon, as [references/windows.md](references/windows.md)
says. On both it undoes its panel change when the coordinator does not open. Its exit codes are 0 set up, 1 refused or rolled back, 2 usage, 3 already set
up with nothing changed, and 4 incomplete, where a step failed or could not be read and the line names it.

`herdr-check` changes nothing and prints one line per step, `core`, `panel`, `coordinator` and `notifications`, and on Windows also `restart`, each
`done`, `not done (<cause>); <fix>` or `unavailable (<cause>); <fix>`. Notifications read `on` or `off`, and off is
not a failure. Its exit codes are 0 every step done, 1 a step not done, 2 usage and 4 a step unavailable.

### Coordinator

A project's coordinator runs cards in separate `job N` tabs. At the root checkout, with the Herdr add-on on in fetched
`main` settings, run `node scripts/coordinator.mjs open --login <login>`. The
[Coordinator reference](../resume/references/herdr-lead.md#coordinator) owns its cap, opens and recovery.
Claude Code jobs start and deliver through the coordinated delivery lane on Linux and Windows the same way, and Codex
jobs on Linux only; the coordinators' shared cap on running jobs is held under a
lock that works on Linux, macOS and Windows, where it relies on the Windows user profile's default permissions and so
refuses a state folder outside the profile.

In Herdr, open Fabraik Queue's **Decisions** view. The project's tile shows its saved default. Under **Choose for
this session**, pick an installed runtime once. Close an open Coordinator before choosing again. To change the
default, set `coordinator.runtime` in `.agents/factory-settings.json` on `main` to `claude` or `codex` from the
project's installed runtimes. The login opener uses the saved default without a prompt.

On Windows, [references/windows.md](references/windows.md) says how the coordinator comes back at each logon, in place of the unit below. To bring the coordinator back at each login, save a per-project user unit as
`~/.config/systemd/user/<project>-coordinator.service`, with full paths to `herdr-app` and `node`:

```ini
[Unit]
Description=Fabraik coordinator for <project>
After=herdr-core.service
Wants=herdr-core.service
PartOf=graphical-session.target

[Service]
Type=exec
ExecStart=/bin/sh -c 'if [ ! -f "$$1" ] || [ ! -x "$$1" ]; then printf "Cannot execute Herdr app: %%s\\n" "$$1" >&2; exit 1; fi; until "$$1" ls >/dev/null 2>&1; do sleep 2; done; exec "$$@"' wait-for-herdr "<path to herdr-app>" do tab.new --space "<space id>" --name "Coordinator start" --folder "<root checkout>" --argv '["<path to node>","scripts/coordinator.mjs","open","--login","<login>"]' --focus false

[Install]
WantedBy=graphical-session.target
```

`After=` and `Wants=` name the unit of step 2. `<space id>` is the `id` that `herdr-app ls` gives for the root
checkout's folder. The unit waits until `herdr-app ls` succeeds before opening the tab. `Type=exec` reports startup
once the shell has been executed; it does not mean the tab or coordinator has started. The service stops with the
graphical session, so the wait ends at logout.

For a new installation, enable the unit with `systemctl --user enable <project>-coordinator.service`. To migrate an
existing per-project unit, add the `PartOf` line under `[Unit]` and replace its `Type` and `ExecStart` with the lines
above, retaining its project-specific values, then run `systemctl --user daemon-reload`. After graphical login, check
that the Coordinator tab appears. If it does not, inspect the user journal with
`journalctl --user -u <project>-coordinator.service`. An invalid Herdr app path is reported there.

The opener runs in a `Coordinator start` tab, so a failed start stays in the window with its message, Herdr keeping a
shell in the tab. `tab.new` returns at once, so systemd has nothing to retry after it opens the tab. The coordinator
closes that tab at its start, and the opener refuses where a coordinator already runs.

#### Trust Codex hooks

Before starting Codex jobs, the owner opens standalone Codex from the registered project's integration root with
the same session flags as the coordinator.

```sh
codex --no-daemon --enable default_mode_request_user_input
```

In Codex, open `/hooks`. Review and trust the project's enabled Bash guard from `.codex/hooks.json`, which uses the
installed `.codex/hooks/block-unsafe-git.mjs` at the integration root. The native trust decision persists for unchanged
definitions. Review again if Codex reports a changed registration. The coordinator verifies the exact trusted
definitions before launching a job and reports a cause if preflight refuses. Use a versioned Codex installation
whose `bin/codex` is the native executable checked at startup. `mise where codex@<version>` must return that
installation’s directory. An unversioned path holds startup.

## 5. Optional: configure notifications

On a running, logged-in Linux host, a separate native timer sends bounded Claude completion notifications without an
open Herdr window. It promises no wake or pre-login execution. The phone's Claude account must have native
completion notifications enabled. Other Claude sessions' notifications remain independent of this scheduler's cap
and projection.

The scheduler reads every repository in `{{HERDR_HOME}}/fabraik-queue/machine.json` for the configured GitHub login
and this machine's claims, including coordinator jobs. Unresolved owner questions and unanswered held reviews count
toward owner waits. Missing ownership evidence reports unavailable.

A configurable daily morning includes saved work counts and owner waits. At other times, positive owner waits may
send at any hour. Timer and manual ticks share a fixed rolling 3,600-second attempt cap, including morning sends.
Failed or uncertain attempts consume that slot and any reserved morning. A 07:45 attempt can defer an 08:00 morning
until an 08:45 tick.

Eligibility detection takes up to 15 minutes, plus provider delay, while the host runs logged in. Uncapped ticks run
up to four full collectors per registered repository each hour, including at night. Each collector adds one matching
GitHub read per candidate question or complete merge. Capped ticks return before collection or native account work.

### Prepare configuration

Complete these prerequisites before initialization or activation:

- Use the stable integration checkout after merge for `{{REPOSITORY_ROOT}}`, never a disposable job or the
  release-installed `mods/fabraik-queue` copy. Its installed queue command must support `notify` and the morning
  schema. Every registered repository's collector must supply compatible notifications metadata. Any missing or
  incompatible source refuses the whole tick. Keep the registered set intact. Release publication and adopter updates
  follow their own procedures.
- Verify an absolute Node executable and trusted login `PATH` resolving the intended `claude`, `gh` and collector
  dependencies. Use one machine-wide `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for all ticks. These default to
  `~/.config` and `~/.local/state`. State lives under `fabraik-lead/notifications/`.
- Choose an existing, canonical, owned Claude configuration directory and an empty, durable, owned neutral directory
  outside every repository. Use absolute paths without symlink components. From a trusted login terminal outside an
  agent session, establish any native Claude directory trust and authentication through the ordinary supported flow.
  Keep the neutral directory empty. The declared profile routes the sender; it does not prove authentication.

Save exactly this schema at `${XDG_CONFIG_HOME:-~/.config}/fabraik/notifications.json`, owned by the login user with
mode `0600`:

```json
{
  "format": 1,
  "login": "{{LOGIN}}",
  "claudeConfigDir": "{{CLAUDE_CONFIG_DIR}}",
  "trustedDirectory": "{{TRUSTED_DIRECTORY}}",
  "morning": { "time": "{{HH_MM}}", "timeZone": "{{IANA_TIME_ZONE}}" }
}
```

Replace placeholders with verified values and apply JSON string escaping. For example, `08:00` with `Europe/London`
schedules the local morning. `time` accepts 24-hour `HH:mm`; `timeZone` names a valid IANA timezone. Extra keys are
refused. Credentials stay in private native stores, never configuration, units, arguments or API-key environment
imports.

From that trusted login terminal, with the same config/state bases, initialize once:

```sh
"{{NODE}}" "{{REPOSITORY_ROOT}}/.agents/herdr/fabraik-queue/queue.mjs" notify --initialize --home "{{HERDR_HOME}}"
```

Success prints `notification: initialized`. Initialization refuses an existing journal; recurring ticks never
initialize or repair it. The owned `notifications/` directory uses `0700`; `journal.json` and `journal.lock` use
`0600`, one link and no symlinks. Checked native `/usr/bin/flock`, atomic replacement and file/directory sync
serialize all readers and writers. Missing, damaged, oversized or unsafe established state fails closed. Journal
reads are limited to 1 MiB and saved events to 72 hours; overflow refuses rather than dropping retained records.

### Prepare native units

Choose one exact service/timer basename `{{NOTIFY_UNIT}}` using letters, digits, underscore, dot or hyphen, starting with a letter or digit, at most 255 bytes, with no instantiated `@` unit. Save
`~/.config/systemd/user/{{NOTIFY_UNIT}}.service`:

```ini
[Unit]
Description=Fabraik notifications
PartOf=graphical-session.target
After=graphical-session-pre.target

[Service]
Type=oneshot
WorkingDirectory={{TRUSTED_DIRECTORY}}
Environment="HOME={{HOME}}" "USER={{USER}}" "LOGNAME={{USER}}" "PATH={{TRUSTED_LOGIN_PATH}}" "LANG={{LANG}}"
Environment="XDG_CONFIG_HOME={{XDG_CONFIG_HOME}}" "XDG_STATE_HOME={{XDG_STATE_HOME}}" "GH_CONFIG_DIR={{GH_CONFIG_DIR}}"
Environment="XDG_RUNTIME_DIR={{NATIVE_RUNTIME_DIR}}" "DBUS_SESSION_BUS_ADDRESS={{SESSION_BUS_ADDRESS}}"
ExecStart="{{NODE}}" "{{REPOSITORY_ROOT}}/.agents/herdr/fabraik-queue/queue.mjs" notify --home "{{HERDR_HOME}}"
StandardOutput=journal
StandardError=journal
TimeoutStartSec=7min
TimeoutStopSec=15s
KillMode=control-group
```

Save `~/.config/systemd/user/{{NOTIFY_UNIT}}.timer`:

```ini
[Unit]
Description=Fabraik notification schedule
PartOf=graphical-session.target

[Timer]
OnCalendar=*:0/15
Persistent=true
Unit={{NOTIFY_UNIT}}.service

[Install]
WantedBy=graphical-session.target
```

Use systemd argument/value escaping and double literal percent signs in supplied values. Run Node directly, without
a shell, `env`, `hc`, `EnvironmentFile` or PID-file wrapper. Supply only verified nonsecret trusted-login values;
omit optional absent fields rather than importing an agent's or manager's environment. Add `LC_ALL` and `TMPDIR`
only when present in that login. Sender children inherit only `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, `LC_ALL`,
`TMPDIR`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` when present, plus the declared `CLAUDE_CONFIG_DIR`.
Ordinary native hooks and authentication remain active.

The seven-minute oneshot limit covers collection, retained cleanup, a sender turn and checked state writes. Native
command, polling and sender bounds remain separate.

The sender launches a background Remote Control turn in the neutral directory with tools, slash commands and
external Model Context Protocol servers disabled. It projects only integer counts into a fixed sentence. It polls
native identity/status for at most 120 seconds, bounds each native call to 30 seconds and the sender to 180 seconds.
Cleanup stops only the uniquely identified owned background session. Uncertain cleanup retains pending identity and
blocks another launch.

### Activate and verify

From a trusted login terminal outside an agent session, reload and enable the exact timer for the next graphical
login:

```sh
systemctl --user daemon-reload
systemctl --user enable {{NOTIFY_UNIT}}.timer
```

For activation during that login, start only that timer from the same trusted terminal:

```sh
systemctl --user start {{NOTIFY_UNIT}}.timer
```

An agent session never starts or restarts these units or uses `enable --now`. No linger change is part of setup.
After a unit or configuration change, reload and restart the exact timer from the trusted terminal.

Inspect bounded native status and journal output:

```sh
systemctl --user status {{NOTIFY_UNIT}}.timer {{NOTIFY_UNIT}}.service --no-pager --lines=20
journalctl --user -u {{NOTIFY_UNIT}}.service --no-pager -n 50
```

A waiting timer confirms scheduling, not a phone receipt. A successful oneshot may show inactive after completion.
Tick output contains one fixed status: `off`, `capped`, `empty`, `completed` or `cleanup-completed`, prefixed
`notification:`. Initialization prints `initialized`; unavailable ticks print `queue: notification unavailable:
<code>` and exit 1. Bad arguments exit 2 before effects; successful work/no-ops exit 0. `completed` confirms native
turn completion and owned cleanup, never delivery. Logs omit native prose and raw source errors; the system journal
has no blanket secret-redaction guarantee.

The morning sentence is `Saved work records cover N items. Waiting: Q questions and M reviews. Check Herdr for full
status.` Other sends omit its first sentence. Counts expose no project names, titles, reasons, screenshots or
transcripts. Saved counts cover distinct repository/card pairs from the previous scheduled morning, clipped to
recording start, until the due morning. The reader accepts compatible saved events from older releases. Zero measures
the absence of saved records in that window. Setup or
morning/repository-set changes reset recording coverage while retaining attempt and pending reservations. The first
eligible morning follows initialization; earlier mornings are not backfilled. A restart considers only the most
recent due morning, never a backlog. Repeated local times use the earlier occurrence; nonexistent times advance to
the first valid local minute.

Finish verification only after an integrated scheduler notification arrives with the Herdr window closed; record the
observed route and window state. Until observed, mark that receipt Untested and morning arrival untested separately.
A separate diagnostic notification cannot establish either result.

### Stop and recover

To prevent scheduled attempts, stop and disable only the exact timer; stop its service to end an active tick:

```sh
systemctl --user stop {{NOTIFY_UNIT}}.timer {{NOTIFY_UNIT}}.service
systemctl --user disable {{NOTIFY_UNIT}}.timer
```

Inspect the fixed failure code and correct its configuration, source compatibility, clock or native
prerequisite before trusted-terminal reactivation. An eligible tick retries checked owned cleanup before
another launch. If pending has no native ID, a successful validated native session list with no
reserved-name entry permits clearing only pending, without stopping a session. Missing known IDs,
malformed lists and conflicting identities remain unavailable. A still-capped tick performs no cleanup
calls. Preserve `journal.json`, `journal.lock` and attempt/morning reservations throughout recovery. Never
delete/recreate established state or rerun initialization to clear a failure or cap. If safe state
restoration cannot preserve reservations, leave the timer stopped and report unavailable. Missing
configuration means off; removing it is no substitute for stopping the timer and preserving its state.

## 6. Optional: schedule the weekly local retro

To set up, check or stop the weekly local retro, which files one queue item a week from this machine's own Claude
Code and Codex chats, read [references/local-retro.md](references/local-retro.md) whole first.


## Turning the add-on off

When the repository's `herdr` setting is turned off, the update removes this skill. The update also removes the
repository's queue reader, and the queue panel on each machine then lists the repository as having no queue reader. To
stop listing it, rerun `node <fabraik distribution>/scripts/fabraik.mjs herdr <tag> --repository <dir>...` on each
machine with the tag `<Herdr home>/fabraik-queue/machine.json` records, naming every other repository the panel lists;
this keeps the panel, its cleared digest and the other repositories. Where it is the only repository listed, remove the
panel instead. Removing the panel is a separate machine step that removes it for every repository: run
`herdr-app do layout.switch --name main`, then delete `<Herdr home>/mods/fabraik-queue/`,
`<Herdr home>/mods/fabraik-tabs/`, `<Herdr home>/mods/fabraik-spaces/`, `<Herdr home>/mods/fabraik-agents/`,
`<Herdr home>/layouts/fabraik.json` and `<Herdr home>/fabraik-queue/`. The core bootstrap and coordinator login
units stay their owner's to keep or remove. A live core can keep running past logout. Enabled units stay enabled until
disabled. On Windows, remove the logon Run value with
`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "<name>" /f`.
