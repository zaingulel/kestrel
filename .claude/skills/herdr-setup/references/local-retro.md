# The weekly local retro

Once a week this machine reads its owner's own chats with Claude Code and Codex and files one item in the queue: what
the model proposes, and where it thinks the owner was wrong, each with the owner's words as evidence. Nothing in it is
a rule or an instruction. A proposal becomes a card only when the owner picks it in the queue panel.

## What it reads

`node scripts/local-retro.mjs --home <Herdr home>` reads the last whole week, Monday to Monday in UTC, of:

- the turns the owner typed to Claude Code, under `projects/` in `CLAUDE_CONFIG_DIR` or `~/.claude`, with the agent's
  text just before each turn;
- the turns the owner typed to Codex, under `sessions/` in `CODEX_HOME` or `~/.codex`.

Only chats in the projects `<Herdr home>/fabraik-queue/machine.json` registers are read. A helper's file, text a
runtime wrote for the owner and a chat in any other folder are left unread. The job also imports each registered
project's `scripts/lib/board-config.mjs` to learn what a card there may carry.

## What it sends, and where

| What | Where it goes |
|---|---|
| The week's chat | To `claude` alone, on its standard input, on the owner's own account. The model runs in an empty folder with no tools, no slash commands, no Model Context Protocol server and no saved session. |
| The write-up | To one issue in this repository, titled `Proposed: Weekly retro for the week of <date>` and placed in Backlog. |
| Anything else | Nowhere. No other repository, no notification and no log receives chat or write-up; a failed model call reports its exit alone. |

The issue is as private as the repository that holds it: everyone who can read the repository can read the issue.

In the write-up, a sentence of the model's or a quoted line of chat names no account, references no card, links
nowhere and draws no image and no HTML. A credential in it is redacted only where it has a shape the job knows
(a GitHub or Anthropic key, a bearer token, a secret-named value) or is an unbroken run of twenty or more letters and
digits; a credential of any other shape that was typed into a chat can reach the issue, so rotate one that does. A
week whose issue already stands is reported as `already filed: <address>` and no chat is read for it.

## The queue item

The panel shows the issue as a **Weekly retro**. Its open card draws the write-up, then each card draft exactly as it
would be filed. A draft is offered only where it quotes no chat (it shares no run of eight words with the week's chat),
holds no web address, link, account name, card number, file path, known credential or long token, and names a registered project that keeps
its cards as GitHub issues.

| Control | What it does |
|---|---|
| Make proposal `<k>` a card | Files that one draft as an issue in the project the draft names, in Backlog where that is this repository, and comments on the retro which card it became. It has no Undo. |
| Close retro | Closes the retro, with Undo. Unpicked proposals are filed nowhere. |

A phone notification never counts or names a retro.

## Prepare native units

Use the stable integration checkout for `{{REPOSITORY_ROOT}}`, never a disposable job checkout. Verify an absolute
Node executable and a trusted login `PATH` that resolves the intended `claude`, `gh` and `git`. `{{WORKSTREAM}}` is the
routing value the retro's own card gets; leave `--workstream` and its value out where the board has no routing field.

Choose one exact service and timer basename `{{RETRO_UNIT}}`. Save `~/.config/systemd/user/{{RETRO_UNIT}}.service`:

```ini
[Unit]
Description=Fabraik weekly local retro

[Service]
Type=oneshot
WorkingDirectory={{REPOSITORY_ROOT}}
Environment="HOME={{HOME}}" "USER={{USER}}" "LOGNAME={{USER}}" "PATH={{TRUSTED_LOGIN_PATH}}" "LANG={{LANG}}"
Environment="GH_CONFIG_DIR={{GH_CONFIG_DIR}}"
ExecStart="{{NODE}}" "{{REPOSITORY_ROOT}}/scripts/local-retro.mjs" --home "{{HERDR_HOME}}" --workstream "{{WORKSTREAM}}"
StandardOutput=journal
StandardError=journal
TimeoutStartSec=3h
KillMode=control-group
```

Save `~/.config/systemd/user/{{RETRO_UNIT}}.timer`:

```ini
[Unit]
Description=Fabraik weekly local retro schedule

[Timer]
OnCalendar=Mon *-*-* 09:00
Persistent=true
Unit={{RETRO_UNIT}}.service

[Install]
WantedBy=timers.target
```

Use systemd argument and value escaping and double literal percent signs in supplied values. Run Node directly, without
a shell, `env` or `EnvironmentFile`. Supply only verified nonsecret trusted-login values; add `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` only where that login sets them. Credentials stay in the native stores of `claude` and `gh`, never in a
unit. `Persistent=true` runs a missed Monday at the next login, and the job then finds nothing to do once the week's issue
stands. Each run reads only the last whole week, so after a longer absence the earlier missed weeks get no item.

## Activate and verify

From a trusted login terminal outside an agent session:

```sh
systemctl --user daemon-reload
systemctl --user enable {{RETRO_UNIT}}.timer
systemctl --user start {{RETRO_UNIT}}.timer
```

An agent session never enables, starts or restarts these units. To check a run:

```sh
systemctl --user status {{RETRO_UNIT}}.timer {{RETRO_UNIT}}.service --no-pager --lines=20
journalctl --user -u {{RETRO_UNIT}}.service --no-pager -n 50
```

A run prints the issue's address and exits 0, prefixed `already filed: ` where the week's issue stood. Exit 1 prints
one line saying why it could not; exit 2 is a wrong argument shape, refused before any read.

## Stop

```sh
systemctl --user stop {{RETRO_UNIT}}.timer {{RETRO_UNIT}}.service
systemctl --user disable {{RETRO_UNIT}}.timer
```

Issues already filed stay in the repository until closed there or with "Close retro".
