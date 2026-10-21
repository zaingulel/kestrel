# Omarchy reuse findings

Research answer for [issue 170](https://github.com/zaingulel/kestrel/issues/170). This is a research record from sources read on 21 October 2026 against the installed Omarchy 4.0.6-1; Omarchy, its marketplace plugins and provider terms may have changed since. It is not an operating manual or an enabled configuration.

## Summary

- **Weather: build, reusing only Omarchy's location setting.** Omarchy keeps no weather data another program can read: its bar commands and panel fetch on demand and hold results in memory. Kestrel would ask Open-Meteo directly with the coordinates in Omarchy's weather setting file, and refuse when none are set. This is a new internet use, so it needs the owner's decision and a new card. Omarchy's own weather panel may already send location data to both wttr.in and Open-Meteo while it runs.
- **Claude Code and Codex usage: reuse Omarchy's usage records; extend only for banked resets.** Omarchy already writes weekly figures and reset times for both apps to private JSON (JavaScript Object Notation) files. Kestrel reads them and sends nothing, provided it handles the traps listed below, which would otherwise produce stale or invented figures. Banked resets are not in the records; reading them needs Kestrel's own read-only Codex call, which is an owner decision. [#126](https://github.com/zaingulel/kestrel/issues/126) becomes reading the files, and [#123](https://github.com/zaingulel/kestrel/issues/123) narrows to session status and banked resets.
- **Reminders and timers: calcurse stands; build on it.** `omarchy reminder` takes whole minutes only, pauses while the laptop sleeps, keeps its timers in a folder that does not survive a reboot (inference), can only clear everything at once, only shows a notification and records nothing once a reminder fires. The marketplace reminder plugins were found by name and none fits better, but one, `omarchy-cronos-calendar`, was only partly examined. Kestrel reuses one Omarchy pattern: notification text is sent as data, never as command options. Whether a reminder's own words may appear in a notification at all is an owner sign-off question, because Omarchy stores notifications where any process under the account can read them.
- **Calendars: build as [#165](https://github.com/zaingulel/kestrel/issues/165) and [#166](https://github.com/zaingulel/kestrel/issues/166) plan, copying one plugin's safeguards.** Three marketplace plugins read iCalendar share links. The marketplace's own checks are not a security audit, and its install and update commands take the newest upstream code rather than the checked commit. Kestrel uses two calendar libraries from the Python Package Index (PyPI), installed into its isolated voice environment, and copies the safeguards from `itsmoorgrove/omarchy-protoncalendar`. If the owner also wants a bar calendar, the alternative is to install that plugin pinned to a reviewed commit and have Kestrel read its output file.
- **Other parts:** screenshots and media controls are already reused. Omarchy's Voxtype dictation overlaps [#168](https://github.com/zaingulel/kestrel/issues/168) and needs an owner decision. For [#169](https://github.com/zaingulel/kestrel/issues/169), Kestrel reads highlighted text from the primary selection, never from Omarchy's clipboard history file. Omarchy's text-from-screen capture is excluded, because Kestrel does not read screen content.

## Source identity and limits

Installed source root: `/usr/share/omarchy`, from the `omarchy` package 4.0.6-1. Paths below are relative to that root unless they start with `~`, sit inside a named plugin, or are Kestrel paths, which are relative to the repository root.

Plugin sources were read at the commits below. None was installed or run.

| Source | Commit read |
|---|---|
| Plugin marketplace registry | [omacom/omarchy-plugin-marketplace 0a01e14](https://github.com/omacom/omarchy-plugin-marketplace/tree/0a01e14f3094678a873b4d57211162f885d9c9d7) |
| Proton calendar plugin | [itsmoorgrove/omarchy-protoncalendar 515d66d](https://github.com/itsmoorgrove/omarchy-protoncalendar/tree/515d66def8a7f0b9146251d26dfca9b5feef6b06) |
| Calendar sync plugin | [tmn73/omarchy-calendar a190d1b](https://github.com/tmn73/omarchy-calendar/tree/a190d1bcc2e6eb1c0e6c9130e3872fcdd6a292c8) |
| Chronica calendar plugin | [promaaa/sync-calendar-omarchy 5f0251c](https://github.com/promaaa/sync-calendar-omarchy/tree/5f0251c97cd5104a172e606b0c51977915517300) |
| Reminder plugin | [GimpyHand/bralyx-reminders be10a66](https://github.com/GimpyHand/bralyx-reminders/tree/be10a666d6383dfdbfc111be92a8adbb5f549aac) |
| Reboot-safe reminder plugin | [angelherman0130-cell/omarchy-cronos-calendar 6606bf9](https://github.com/angelherman0130-cell/omarchy-cronos-calendar/tree/6606bf9018005e14cc9509e1c38b37fc7b889d94) |
| calcurse 4.8.2 manual | [lfos/calcurse doc/manual.txt at 68cab14](https://github.com/lfos/calcurse/blob/68cab1481452a5735c776cf0df9a8d4fab0af3fa/doc/manual.txt) |

What was and was not done:

- No credentials, sign-in tokens or calendar links were read.
- The usage records were inspected for field names, types and labels only; no usage figure is quoted.
- Nothing was installed. No reboot or suspend was tested, and calcurse was not trialled.
- The mode of Omarchy's notification folders and files was checked with `stat`; no notification content was read.
- The reminder plugins named under Reminders and timers as screened out were judged from their descriptions and READMEs on their default branches on the record date, not at a pinned commit.
- The only command run that contacts the internet was `omarchy weather location`, run once.
- Star and commit counts are GitHub's figures on the record date. They measure attention, not review.

## Weather

### What exists

| Part | Behaviour | Evidence |
|---|---|---|
| Bar text | Fetches temperature and wind from wttr.in on each call and prints display text such as "Place · Temp X · Wind Y", or "Weather unavailable" on failure. | `bin/omarchy-weather-status:13`, `:20-24` |
| Bar icon | Fetches wttr.in's full report (`format=j1`) on every call, with no cache, and prints a symbol. | `bin/omarchy-weather-icon:14` |
| Location setting | `~/.local/state/omarchy/settings/weather.json` holds `name`, `latitude` and `longitude`. `--set <name> [lat,lon]` writes it after a coordinate pattern check; `--clear` removes it. With no file, the location is wttr.in's guess from the laptop's IP (internet protocol) address. | `bin/omarchy-weather-location:15`, `:23-24`, `:28` |
| Panel | Reads the setting file and always fetches wttr.in. The four-day forecast always comes from Open-Meteo, using the coordinates that are set or else the nearest area wttr.in reports. Current conditions come from Open-Meteo only when coordinates are set. Refreshes every 15 minutes by default and keeps the report in memory only. | `shell/plugins/panels/weather/Panel.qml:78-104`, `:136`, `:144`, `:159`, `:167-188`, `:336`, `:347`, `:355-356`, `:470-472` |

The settings folder on this laptop is empty: there is no `weather.json` and no weather cache on disk. `omarchy weather location` printed a bare latitude figure (not repeated here, because this repository is public). Guess at the cause: wttr.in answered the location question with coordinates, and line 24 kept only the text before the first comma.

### How Kestrel would read it

Reusing Omarchy's weather would mean scraping the bar's display text, which this record rules out. Instead:

- Kestrel asks Open-Meteo itself, with the same request shape the panel uses (`Panel.qml:180-188`).
- It takes the coordinates from `weather.json`, so one setting serves both the bar and Kestrel.
- Any process under the owner's account can write that file, so Kestrel checks it before use: readable JSON, a short name, a latitude from -90 to 90 and a longitude from -180 to 180.
- If the file is missing or fails the check, Kestrel refuses out loud and names the fix (`omarchy weather location --set`). It never falls back to a guess from the internet address.
- If Open-Meteo's answer lacks the figures needed, Kestrel refuses rather than speaking a blank.

### What leaves the laptop

While Omarchy's weather panel runs, both wttr.in and Open-Meteo may already receive location data: wttr.in through the panel's own request (the stored coordinates, else the place name, else only the laptop's address; `Panel.qml:79-81`, `:336`), and Open-Meteo with the set coordinates or else the ones wttr.in reports. `~/.config/omarchy/shell.json` lists `omarchy.weather` among the bar items. Unverified: whether the panel loads when the shell starts or only when it is opened. Kestrel's own request would send the coordinates to Open-Meteo, along with the laptop's IP address, as any internet request does. Open-Meteo says its web server logs "may contain sensitive information such as geographical coordinates" and are deleted after 90 days. Its terms allow free non-commercial use under 10,000 calls a day, 5,000 an hour and 600 a minute; its data is licensed under Creative Commons Attribution 4.0 (CC-BY 4.0); it gives no availability guarantee. [Open-Meteo terms](https://open-meteo.com/en/terms).

wttr.in publishes no privacy statement, quota or guarantee, and calls its JSON report format easy to parse. [wttr.in README](https://github.com/chubin/wttr.in).

### What a plugin would be trusted with

Nothing. These parts are Omarchy's own, and Kestrel would use only the setting file.

### Recommendation

**Build**, reusing only the location setting, with Open-Meteo as the single source, chosen for its published terms, quota and log retention (above); wttr.in publishes none of these. The owner's recorded privacy boundary does not cover weather. Epic [#11](https://github.com/zaingulel/kestrel/issues/11) privacy promise 3 says "Web lookups send search terms and page requests to the internet" and "Nothing else leaves by itself", and that "A change to this boundary needs the owner's sign-off and a security review". [#160](https://github.com/zaingulel/kestrel/issues/160) says calendar "downloads are the only data that leaves the laptop". Weather is therefore a new internet use that still needs the owner's decision and a new card.

Open questions:

- How should the CC-BY 4.0 attribution be given for a spoken answer?

## Claude Code and Codex usage

### What exists

Omarchy's agents panel ships with Omarchy itself, not through the marketplace.

- **Where records go:** its collector writes one record per app to `~/.local/state/omarchy/agents/usage/`, through a temporary file and a rename, readable only by the owner's account (`bin/omarchy-agent-usage-update:12`, `:42-52`; observed as `-rw-------` for `claude.json` and `codex.json`).
- **When it runs:** on four triggers. The agents plugin runs the collector when it starts and then every 900 seconds by default (`shell/plugins/agents/Main.qml:117`, `:120-126`; `shell/plugins/agents/README.md:110`). Opening the agents panel runs it for the limits (`shell/plugins/agents/Panel.qml:308-312`). An agent whose record advises a retry gets one more run after 30 seconds (`Main.qml:91-96`). Asking for a refresh runs it too (`Main.qml:171-172`; `README.md:43-44`, `:100`). Disabled agents are skipped (`README.md:135-137`).
- **Format:** the agents README calls it "the record contract" but lists no fields (`README.md:41-51`); the contract is defined by the collectors' code (`bin/omarchy-agent-usage-claude`, `bin/omarchy-agent-usage-codex`). Each record carries `schemaVersion` 1, `updatedAt`, `ready`, `tierLabel`, `usageStatusText`, a `limits` list whose entries have `label`, `percent` and `resetsAt`, and today's session and prompt counts, token totals and recent days.
- **Observed labels:** Claude has "Session (5-hour)", "Weekly (7-day)" and a model-specific weekly limit; Codex has "Weekly (7-day)".
- **Codex label rule** (`bin/omarchy-agent-usage-codex:504-512`): a window of 10080 minutes is labelled "Weekly (7-day)"; a length divisible by 60 is labelled "<N>h window" (N in hours); any other length is labelled "<N>m window" (N in minutes); no length is labelled "Limit". Kestrel picks windows by label and never assumes a window is weekly.

The records have no session list, no running or waiting state and no banked-reset count.

How each app's figures are fetched:

- **Claude Code.** The collector reads Claude Code's sign-in file and sends its token to `https://api.anthropic.com/api/oauth/usage` (`bin/omarchy-agent-usage-claude:36`, `:580-593`, `:711-721`). No Anthropic documentation of that endpoint was found; only community notes describe it. [Anthropic's authentication rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) say OAuth (Open Authorization) sign-in is "designed to support ordinary use of Claude Code and other native Anthropic applications", and that "developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
- **Codex.** The collector starts `codex -s read-only -a on-request app-server` (`bin/omarchy-agent-usage-codex:531`), calls `account/read` and `account/rateLimits/read` over JSON-RPC (JSON remote procedure call) (`:544-548`) and keeps only the primary and secondary windows (`:555-558`). OpenAI documents both methods in [Codex app-server](https://learn.chatgpt.com/docs/app-server), along with `rateLimitResetCredits.availableCount`, "the available earned-reset count when the service provides it", and `account/rateLimitResetCredit/consume`, which spends a reset.

### Traps for another program reading the records

| Trap | Evidence | What Kestrel does |
|---|---|---|
| `percent` holds a fraction from 0 to 1, not a percentage. | Claude `:613-623`; Codex `:498-518` | Multiplies by 100 before speaking. |
| Claude decides the scale of `percent` by guessing: if any value in the payload is at or above 1, every value is read as a percentage; otherwise every value is read as a fraction. Values are capped at 1.0. | Claude `:613-623`, `:750` | Nothing: Kestrel cannot detect a wrong guess, because the record holds only the converted figure. This is a known Omarchy limitation. A payload whose percentage values are all below 1 would be read as fractions (inference from the code); whether the endpoint returns non-integer values below 1 is unverified. |
| Claude's `updatedAt` is when the file was written, not when the figures were fetched. | Claude `:885-896`, at `:889` | Takes the fetch time from `fetchedAtMs` in `~/.cache/omarchy/agent-usage/claude-limits.json` (`:800`, `:834`) and speaks it. |
| When Claude's fetch fails and older figures exist, the collector writes them with no status text. | Claude `:841-842` | Relies on the fetch time, never on the absence of a warning. |
| A blank reset time has two causes: a cached window whose reset time has passed is written as `percent` 0, or the provider's own reset time was null. | Claude `:783-791`; `normalize_reset_at` `:626-631`, used at `:706`, `:756` and `:760` | Says the reset time is unknown and treats a 0 with a blank reset time as unread, never as "0 percent"; never says a reset happened. |
| Status states can stand in for figures: "Waiting for auth" and "Sign-in expired" (both carry the last limits), "Claude limits unavailable", "Codex unavailable" and "Codex limits unavailable". | Claude `:809-816`, `:844-845`; Codex `:525`, `:539`, `:559-561` | Speaks the state plainly, with the reading time for any last-known figures. |
| A Codex record can have an empty `limits` list and no status text, when neither window carries a used figure. | Codex `:555-558` | Refuses it as unreadable, naming the file. |
| The format can change. | `schemaVersion` | Refuses any version other than 1 and names the cause. |

The fetch-time file is Omarchy's internal cache, not part of the record contract, so it can change without notice. Codex's `ready` is always true (`:594`), so it says nothing about the figures. Codex figures are fetched fresh on each run, so a Codex record that has limits carries its reading time in `updatedAt`.

### How Kestrel would read it

Kestrel reads the two record files, plus the Claude cache file for the fetch time. It writes nothing and never asks Omarchy to refresh. A missing, unreadable or malformed file is refused out loud with the file named. Every answer includes the time the figures were read, so an old figure is never presented as current.

### What leaves the laptop

Kestrel's reading sends nothing. Omarchy's collector, whenever any of its four triggers runs it, sends the Claude Code token to Anthropic and has Codex fetch figures from OpenAI under the owner's sign-in (inference from OpenAI's description of the method). Asking Omarchy to refresh (`omarchy-shell omarchy.agents refresh`, `README.md:100`) would make Kestrel the trigger for those requests, so Kestrel never does.

### What a plugin would be trusted with

No marketplace plugin is involved. Omarchy's own collector holds the Claude Code sign-in token and the Codex sign-in; Kestrel trusts it only for the figures it writes.

### Recommendation

**Reuse** the records for weekly figures and reset times, the core of [#126](https://github.com/zaingulel/kestrel/issues/126).

**Extend** for banked resets only if the owner accepts Kestrel starting its own Codex app-server and calling `account/rateLimits/read`, through a fixed list of permitted method names that never includes `consume`. Otherwise Kestrel says plainly that it cannot read banked resets. Kestrel builds no Claude token request of its own, because Anthropic restricts that.

Routes to exclude by name in [#123](https://github.com/zaingulel/kestrel/issues/123): `omarchy-agent` (launches a coding agent in a terminal), `omarchy-agent-prompt`, `omarchy-agent-crash` (diagnoses a crashed process with an agent), `omarchy-default-agent`, the panel refresh above and `account/rateLimitResetCredit/consume`.

Claude Code's documented [status line](https://code.claude.com/docs/en/statusline) is the alternative route for #123 to weigh. It receives `rate_limits.five_hour` and `rate_limits.seven_day` with the used percentage and reset time, but only for Pro and Max subscribers, only after the first response in a session, and each window is dropped once its reset time passes.

Open questions:

- Do Anthropic's terms permit Omarchy's use of the Claude Code token for the usage endpoint, and if not, does that matter for Kestrel reading the result?
- Does starting a read-only Codex process meet #126's requirement that Kestrel "never starts" anything?

## Reminders and timers

### What exists

| Behaviour of `omarchy reminder` | Evidence | Consequence |
|---|---|---|
| Accepts a whole number of minutes only; rejects zero and accepts no clock time. | `bin/omarchy-reminder:173` | "Remind me at 3" would need Kestrel to convert to minutes, and the result still drifts as below. |
| Each reminder is a temporary systemd user timer named `omarchy-reminder-<minutes>m-<time>`, set with `--on-active`. Listing reads the timers as JSON. | `:23-35`, `:73-118`, `:184`, `:197-198` | Another program can list them. |
| `--on-active` counts on a clock that "generally pauses" while the laptop is suspended. | `man systemd.timer`, systemd 262, lines 136-140 | A reminder fires late after the laptop sleeps. |
| Temporary user units and the reminder message files live in the per-login runtime folder. | `man systemd.unit`; `:185-186` | Reminders are lost at reboot (inference; untested). |
| Clearing stops every reminder timer and deletes every message. | `:120-133` | There is no way to cancel one item. |
| Delivery is a notification only, and the fired timer deletes its message. | `:197-198` | Nothing is spoken, and nothing records that a reminder fired, so a missed reminder cannot be reported. |

calcurse is not installed (`pacman -Q calcurse` reports not found). `pacman -Si calcurse` shows 4.8.2-1 in the Arch `extra` repository under the BSD (Berkeley Software Distribution) licence. Nothing in `/usr/share/omarchy` refers to calcurse.

The calcurse 4.8.2 manual says:

- Data is kept in `~/.local/share/calcurse`.
- `--daemon` runs `notification.command` when an appointment is within `notification.warning` seconds (300 by default, one setting for every item); the default command only rings the terminal bell. By default only appointments flagged as important are notified, and `notification.notifyall` changes that (`:1183-1188`).
- Background mode is off unless `daemon.enable` is set to yes (`:1190-1194`), and the daemon stops when the user interface starts again (`:830-835`).
- `-i` import is the only documented way to add items; there is no direct add command.
- The filter options, the only way to remove items from the command line, carry a data-loss warning.
- No locking is described, apart from `--status`, which reports whether calcurse is already running.

The marketplace reminder plugins were found by listing the registry's repository names that contain "remind" or "alarm" (nine listings at 0a01e14). `omarchy-cronos-calendar` does not match; it turned up in the calendar-name search. Two of the nine are in the table below with the calendar-named one; the other seven are screened out under it.

| Plugin | What it does | Fit |
|---|---|---|
| `GimpyHand/bralyx-reminders` | `bin/reminderctl` creates, cancels, snoozes, edits and lists the same kind of timers in the same runtime folder (`README.md:74`). MIT (Massachusetts Institute of Technology) licence, 1 star. | Another program can drive it, but it has the same sleep and reboot limits. |
| `angelherman0130-cell/omarchy-cronos-calendar` | Promises "reminders that still fire after a reboot" through a persistent `omarchy-clock-reminders.timer` and its own task file, `~/.local/state/omarchy/clock-tasks.json` (`README.md:3-5`). GitHub recognises no licence (the `LICENSE` file reads as MIT with a fork notice; inference), 1 star, 15 commits. | Meets the reboot requirement; the other three are not met or only partly (below). Its own task file, not calcurse. |
| `RishabhRD/recurring-reminders` | Repeating intervals only. MIT licence, 0 stars. | Does not cover one-off reminders. |

Screened out, from their descriptions and READMEs:

- `gladimdim/omarchy-today-reminders`: same-day reminders only, set from a bar dialog; they never roll into tomorrow and are deleted once they ring. MIT licence, 0 stars.
- `robertlindomar/omarchy-ptbr-reminders`: a Brazilian Portuguese translation of Omarchy's own reminders plugin, not a different reminder system. Its `LICENSE` file reads as MIT, but GitHub does not recognise it. 0 stars.
- `camilolunacom/omarchy-restreminder`: a 20-20-20 eye-break screen every 20 minutes, not owner-set reminders.
- `p-kania/omarchy-passwd-reminder`: tracks a password rotation cycle.
- `sifenfisaha/omarchy-salah-reminder`: prayer times in the bar.
- `korex-f/daily-islamic-reminder`: shows a daily Quran verse or Hadith.
- `taufderl/omarchy.taufderl.p2000-alarmeringen`: live Dutch emergency dispatch alerts.

`omarchy-cronos-calendar` at 6606bf9 against the four requirements, from its `README.md` and `ClockReminders.sh` (the registry checked an older commit, 22203ec):

- Spoken delivery: not met. A reminder is drawn as a card by the bar clock with an optional alert sound, and the plugin deliberately posts no notification.
- Surviving a reboot: met. A persistent systemd user timer runs the script on the hour (`ClockReminders.sh:104`, `:111`), so timing is probably hourly at best (inference; the due-time logic was not read).
- Cancelling one item: partly. A task can be deleted in the widget, which owns the task file; the script has only `install`, `run` and `secure-store` commands, so another program would have to edit the plugin's own JSON file.
- Reporting missed reminders: not found. The README says a missed reminder fires when the machine returns and keeps only the last batch in `clock-reminders.json`; no missed-reminder report appears in what was read.

It is a fork that replaces the stock bar clock, so installing it means trusting unsandboxed code in that spot. It was partly examined: `Panel.qml` (about 165 KB), `Tasks.js` and `TaskRow.qml` were not read, so a feature those files hold could change the judgment above.
### How Kestrel would read it, and what leaves the laptop

calcurse keeps its data in local files, so nothing leaves the laptop. No plugin is involved.

### Recommendation

**calcurse stands; build on it**, as [#161](https://github.com/zaingulel/kestrel/issues/161) to [#164](https://github.com/zaingulel/kestrel/issues/164) plan. `omarchy reminder` fails four settled requirements: spoken delivery, surviving a reboot or logout (inference; untested), cancelling one item, and reporting missed reminders. A Kestrel restart does not affect systemd user timers, so it is not what fails. No plugin examined fits better; `omarchy-cronos-calendar` is only partly examined.

Points for those cards:

- calcurse must be installed from `extra`, which is an owner action.
- calcurse's daemon notifies only flagged appointments by default (`notification.notifyall` changes that, manual `:1183-1188`), and Kestrel still times delivery itself from calcurse's data, for three reasons: the daemon stops when calcurse's interface starts (manual `:830-835`), `daemon.enable` defaults to no (`:1190-1194`), and there is one global warning lead time, `notification.warning` (`:1159-1164`). That also lets Kestrel find missed items at startup for [#162](https://github.com/zaingulel/kestrel/issues/162).
- calcurse keeps no "announced" state, so Kestrel keeps its own marker.
- Adding goes through `-i` import or a direct write to calcurse's data; editing and removing have only the filter options, with their data-loss warning. Whether a write is safe while calcurse's own interface is open is unresolved.
- Reminder text is the owner's own words, while Kestrel's notifications today carry only fixed status text (`docs/DESIGN-SYSTEM.md:20`). That matters because Omarchy's notification service writes each notification it shows to `~/.local/state/omarchy/notifications/`, and moves it to `history/` (newest 10 kept), as a JSON file (`shell/plugins/notifications/Service.qml:25-35`, `:96`). Its own comment says transient notifications, which Kestrel's are (`docs/DESIGN-SYSTEM.md:18`), still land in history once shown (`:136-147`; read from the comment, not tested). The files are mode 0644 (observed with `stat`) inside a home folder of mode 0700, so other accounts cannot reach them but any process under the owner's account can. The service also hands the summary and body to `bash -c` as process arguments (`:498-516`, `:565-585`). A reminder notification would therefore store the owner's words where any process under the account can read them, the same exposure this record uses to reject the clipboard history. `omarchy-cronos-calendar` states the same concern and posts no notification for that reason (its `README.md`; the author's claim, not checked).
- Whether a reminder notification may carry the owner's words is an owner sign-off question, not a routine design-system addition: either the notification carries fixed text only, or the owner's words are knowingly stored. If words are sent, Omarchy's sender passes notification text as D-Bus (Desktop Bus) data through `busctl`, because `notify-send` would read text such as `--hint=...` or `-rf` as options (`bin/omarchy-notification-send:184-203`). Kestrel's existing calls use `notify-send` (`bot.py:253`, `desktop/control.py:201`), so reminder text would go as D-Bus data or after `--`.

Open questions:

- Can Kestrel write safely while calcurse's interface is open?
- calcurse is untried here.

## Calendars

### What exists

None of Omarchy's own commands read for this record download calendar feeds; feed readers come from marketplace plugins.

**Marketplace trust.** The registry at commit 0a01e14 lists 5,806 sources, each with a `listingValidatedCommit`. New listings need "a fresh exact-commit scan and an explicit `approved-and-verified` maintainer decision" (`README.md:17`), yet the registry also says those checks "are not a security audit, certification, endorsement, or guarantee", and "Current Omarchy marketplace install and update commands clone mutable upstream HEAD and are not verification-bound" (`README.md:34-36`). On this laptop, `omarchy-plugin-add` clones the upstream default branch (`bin/omarchy-plugin-add:120`), and `omarchy-plugin-update` fetches the newest commit, shows the difference and fast-forwards to it (`bin/omarchy-plugin-update:43`, `:56-58`, `:67`). Two of the three calendar plugins below have moved past the commit the registry checked: `itsmoorgrove` from 2d6f903 to 515d66d, and `promaaa` from 0caf526 to 5f0251c; `tmn73`'s checked a190d1b is still its newest.

| Plugin | Link storage | Download safeguards | Failure reporting | Output | Fetch code lines and attention |
|---|---|---|---|---|---|
| `itsmoorgrove/omarchy-protoncalendar` | GNOME Keyring through `secret-tool`; written to `feeds.json` only when the keyring is unavailable (`bin/protoncal-sync:171-208`, `:277-289`). | Keeps the link off the process list (`:366-372`); refuses private and local addresses (`:347-363`); follows one redirect at a time and rechecks each (`:380-456`); 20-second timeout and 32 MiB (mebibyte) cap (`:31-32`); checks the download is a calendar file and falls back to its cache (`:459-478`); guards against hostile repeat rules (`:44-49`, `:118-160`). | Per calendar: ok, error, stale, event count and last update (`:649-658`). | `~/.cache/omarchy/protoncalendar/events.json`, with `generatedAt` and no link (`:664-690`). | 833 lines. MIT licence, 8 stars, 28 commits. |
| `tmn73/omarchy-calendar` | Plain file with mode 0600 (`config.py:12`; `sync/setup:143-146`). | Follows redirects with no size cap (`ics.py:161-165`); 30-second timeout (`ics.py:32`). | A failed calendar is skipped and the file written without it, so a reader cannot name it (`ics.py:305-339`). | `~/.local/state/omarchy/calendar-events.json` (`contract.py:1-12`). | 2,638 lines. MIT licence, 43 stars, 75 commits. |
| `promaaa/sync-calendar-omarchy` | The iCalendar link is not moved to the keyring; only passwords and tokens are (`fetch-events.py:287`; `README.md:184-189`). | An optional feature, off by default, translates event titles and places through `translate.googleapis.com` (`:239-246`). | Not examined. | The same path as `tmn73` (`fetch-events.py:37`). | 3,877 lines. MIT licence, 28 stars, 106 commits. |

The line counts cover each plugin's fetch script only. Each plugin's shell code (`Panel.qml`, `Model.js` and `Service.qml`) adds to what a reader must trust, and was not counted.

More about `itsmoorgrove`:

- Despite its name, it accepts any web iCalendar link.
- Its README warns that the share link is a secret: anyone holding it can read the calendar, whose contents "are no longer end-to-end encrypted" (`README.md:72-73`).
- Clicking an event opens `calendar.proton.me` (`bin/protoncal-open:33-35`, `:66`).
- Its copy command uses plain `wl-copy`, so copied event text enters Omarchy's clipboard history (`bin/protoncal-copy:8`).
- It needs `python-icalendar` and `python-recurring-ical-events` (`README.md:79`), both in Arch `extra` at 7.3.0-1 and 3.9.0-1 and neither installed. Those Arch packages are the plugin's own needs, not Kestrel's route.

GNOME Keyring 51.1 is running on this laptop. The other calendar plugins either use CalDAV (Calendar Distributed Authoring and Versioning), which Proton does not offer, or have no recognised licence or little attention.

### How Kestrel would read it

Kestrel downloads each link itself and parses the iCalendar (ICS) file with two libraries rather than parsing code of its own: the Python Package Index (PyPI) packages `icalendar` and `recurring-ical-events`, installed into Kestrel's isolated voice environment (`.runtime/voice-venv/pyvenv.cfg` sets `include-system-site-packages = false`; `docs/CODING-STANDARDS.md:56`), where the Arch packages would not be visible. It keeps the links where #165 and #166 say, in Kestrel's ignored local files, and copies the `itsmoorgrove` safeguards:

- keep the link off the process list;
- refuse private addresses;
- recheck every redirect;
- apply a timeout and a size cap;
- check that the download is a calendar file;
- fall back to a cached copy and report it as stale;
- guard against hostile repeat rules;
- keep a status for each calendar, so a failed calendar is named.

### What leaves the laptop

One download per calendar sends the secret link itself, the laptop's IP address and a program name to that calendar's own provider. Nothing else leaves. The Proton link carries the key that decrypts that calendar.

### What a plugin would be trusted with

Both secret links, permission to fetch them on its own schedule (every 900 seconds by default, `Service.qml:25`), and every later change an update pulls in. An installed plugin runs as unsandboxed code inside `omarchy-shell` (`bin/omarchy-plugin-add:106-108`; marketplace `README.md:31-32`), so it could reach everything the owner's account can reach, including Kestrel's ignored files (inference from "unsandboxed"; not tested).

### Recommendation

**Build** as [#165](https://github.com/zaingulel/kestrel/issues/165) and [#166](https://github.com/zaingulel/kestrel/issues/166) plan, with the libraries and safeguards above.

Alternative for the owner, if a bar calendar is also wanted: install `itsmoorgrove` pinned to a reviewed commit, review the difference shown before accepting each update, and have Kestrel read its `events.json` and per-calendar status instead of downloading the feeds itself. `omarchy plugin add` has no option to name a commit (its arguments are a URL, `--enable` and `--yes`), so pinning means a manual `git checkout <commit>` in `~/.config/omarchy/plugins/<id>` before enabling. A later `omarchy plugin update` with no id fast-forwards every git-managed plugin to upstream HEAD once the update is accepted (`bin/omarchy-plugin-update:43`, `:53-65`, `:67`), which would move the pin (inference; untested).

Not recommended:

- `tmn73`: a failed calendar disappears silently, the link sits in a plain file, redirects are followed unchecked and there is no size cap.
- `promaaa`: the link stays outside the keyring, it has a translation path, it has the most code, and it writes to the same output path as `tmn73`.

Open questions:

- How soon does Outlook.com publish changes to a shared feed? The answer sets its freshness warning. For Proton, [#166](https://github.com/zaingulel/kestrel/issues/166) records that changes can take up to eight hours to appear through the share link.
- Is the keyring safer than an ignored file against other processes under the same account? Guess: no, once the keyring is unlocked.

## Other reusable Omarchy parts

| Part | Evidence | Recommendation |
|---|---|---|
| Screenshot, audio output and media controls | Already used: `bot.py:64`, `:215`, `:355`, `:382` | No change. |
| Notifications | `bin/omarchy-notification-send:184-203` | Reuse the pattern of sending text as data, not options, for reminders (see Reminders and timers). |
| Clipboard history | `shell/plugins/clipboard/Clipboard.qml:21`, `:41` (300 items), `:286`, `:295`; skip rules in `capture.sh:15` | Never read it. The file has mode 0644 inside a home folder with mode 0700, so other accounts cannot reach it, but any process under the owner's account can. It records the ordinary clipboard only, not the primary selection. |
| Highlighted text for [#169](https://github.com/zaingulel/kestrel/issues/169) | `wl-paste --primary`, from wl-clipboard 2.3.0 | Read the primary selection, which Omarchy does not record. Copy reworded text with `wl-copy --sensitive`, which Omarchy's history capture is expected to skip (inference; untested). Hyprland's support for the primary selection is untested. |
| Typing | `wtype` 0.4-2 and `ydotool` 1.0.4-2 are installed; Omarchy's helper copies the text to the clipboard (`bin/omarchy-clipboard-paste-text:50`) even when it then types it (`:61-62`). | If [#168](https://github.com/zaingulel/kestrel/issues/168) stays, type with `wtype` directly, never through the clipboard. |
| Voxtype dictation | `voxtype-bin` 1.1.1-1 is installed and its user service is active. Hold F9, or press Super + Ctrl + X (`bin/omarchy-voxtype-install:10-25`). The owner's configuration uses a local Parakeet model and pastes through the clipboard, restoring the old clipboard after one second. | Owner decision. Voxtype already dictates locally into the focused window, which overlaps #168. It says "Your audio stays on your machine" ([voxtype.io](https://voxtype.io)); that it runs offline in this configuration is an inference, and that pasted text enters the clipboard history is a guess. It is also a second microphone user, against the epic #11 decision that one part owns the microphone. |
| Text from the screen, `omarchy capture text` | Screen capture and OCR (optical character recognition). | Excluded: Kestrel does not read screen content. |
| Lists | Omarchy has no list helper. Obsidian 1.14.4-2 is installed. | No change to [#167](https://github.com/zaingulel/kestrel/issues/167). |

## Proposed card changes

For the owner to decide.

| Card | Proposed change | Why |
|---|---|---|
| [#123](https://github.com/zaingulel/kestrel/issues/123) | Narrow to what the records lack: the session list, each app's running or waiting state, and banked resets. Name the excluded routes: `omarchy-agent`, `omarchy-agent-prompt`, `omarchy-agent-crash`, `omarchy-default-agent`, the agents panel refresh and `account/rateLimitResetCredit/consume`. Weigh the documented Claude Code status line against the undocumented usage endpoint. | Weekly figures and reset times are already on disk; the rest is not. |
| [#126](https://github.com/zaingulel/kestrel/issues/126) | Use Omarchy's records for weekly figures and reset times. Add criteria: refuse an unknown `schemaVersion`; convert fractions to percentages; speak the fetch time (for Claude, from `fetchedAtMs`); treat 0 with a blank reset time as unread and say the reset time is unknown, never that a reset happened; speak sign-in and unavailable states; refuse a Codex record with empty limits and no status text; never trigger a refresh; include a corrupt-file test. Owner decision on banked resets: Kestrel's own read-only Codex call, or a plain "cannot read". | The records hold the figures, but their traps would otherwise produce stale or invented figures. |
| [#160](https://github.com/zaingulel/kestrel/issues/160) | Record that calcurse needs installing, and that `omarchy reminder` was weighed and rejected, with the reasons. | Keeps the parent card's decision traceable. |
| [#161](https://github.com/zaingulel/kestrel/issues/161) | Kestrel times delivery from calcurse's data. Adding goes through `-i` import or a direct write, after settling whether writing is safe while calcurse is open. Owner sign-off first: a reminder notification carries fixed text only, or the owner's words knowingly stored in Omarchy's notification history. If words are sent, they go as D-Bus data or after `--`. | calcurse's daemon notifies only flagged items by default, stops when its interface starts, is off by default and has one global warning lead time. Omarchy stores notification text where any process under the account can read it. |
| [#162](https://github.com/zaingulel/kestrel/issues/162) | Kestrel keeps its own "announced" marker. | Neither calcurse nor `omarchy reminder` records that a reminder fired. |
| [#163](https://github.com/zaingulel/kestrel/issues/163) | Choose and test the route for editing; calcurse's only removal tools carry a data-loss warning. | calcurse has no direct cancel or move command. |
| [#164](https://github.com/zaingulel/kestrel/issues/164) | No change. | It reads calcurse locally; Omarchy has nothing to reuse here. |
| [#165](https://github.com/zaingulel/kestrel/issues/165) | Build with the PyPI packages `icalendar` and `recurring-ical-events`, installed into the voice environment, and the listed download safeguards. Owner alternative: read the `events.json` of an `itsmoorgrove` plugin pinned to a reviewed commit. | Packaged parsing and proven safeguards, with no unreviewed plugin holding the link. |
| [#166](https://github.com/zaingulel/kestrel/issues/166) | Same as #165. | Same reasons; the Proton link also carries its decryption key. |
| [#167](https://github.com/zaingulel/kestrel/issues/167) | No change. | Omarchy has no list helper. |
| [#168](https://github.com/zaingulel/kestrel/issues/168) | Owner decision: Voxtype already dictates locally into the focused window. Either close #168, or keep it for preview and cancel inside Kestrel, typing with `wtype` rather than the clipboard. | Avoids building a duplicate and adding a second microphone user. |
| [#169](https://github.com/zaingulel/kestrel/issues/169) | Read highlighted text from the primary selection only, never from the clipboard history file. Copy reworded text marked as sensitive. | Keeps highlighted and reworded text out of a 300-item history file any process under the owner's account can read. |
| [#124](https://github.com/zaingulel/kestrel/issues/124) | No change. | It already uses Omarchy's screenshot, and text capture is excluded. |
| New card | Spoken weather from Open-Meteo, using the coordinates in Omarchy's weather setting and refusing when none are set. | A new use of the internet, which the owner decides. |

## Acceptance coverage and verification

| Card criterion | Evidence in this record |
|---|---|
| Each area has a recommendation of reuse, extend or build, backed by cited primary sources, with every guess marked | The Summary and each section's Recommendation. Sources are installed file lines, plugin commits and provider pages; guesses and inferences are labelled where they appear and in each section's open questions. |
| Each recommended reuse states how Kestrel reads the data, what leaves the laptop and what a plugin would be trusted with | The subsections with those names in each area, including the usage reuse and the calendar plugin alternative. |
| The findings name the filed cards each recommendation changes and the change proposed | The Proposed card changes table. |

This is a text-only record: no executable behaviour changed and no test pass count is claimed. An independent source review stands in for an executed check.
