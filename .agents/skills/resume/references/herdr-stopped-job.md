# Herdr stopped job

The [Herdr coordinator](herdr-lead.md#coordinator) reads this file whole at its
start and at every wake, and its two items belong to the "Coordinator" section's list.

- **Unfinished jobs.** `node scripts/coordinator.mjs unfinished --login <login>` prints one `#<N> <verdict>: <detail>`
  line per job the project left unfinished, the verdict being the first that holds: `running` (a live terminal running a
  program, not labelled stopped), `held` (the card is closed, a proposal, carries a `Needs owner:` comment or sits in a
  column other than In progress, In review or Ready), `stopped` (a live terminal labelled `fabraik.stopped=<kind>` whose
  card is not held), `elsewhere` (a draft only, claimed elsewhere or unclaimed), else `continue`. It exits 1 with
  `Unfinished jobs unknown: <cause>` when any read fails, and the coordinator treats that as unknown, never as no
  jobs. It runs `unfinished` at its start and at every wake, before the start round from `cards`.
- **A stopped job.** A `continue` or `stopped` verdict, or a `running` one whose `hc get` status is `error` or `done`
  (Herdr also wakes the coordinator on `error`), is eligibility for inspection, never a start; a `running` job whose
  status is `working` or `blocked` is left alone. Before any send or start, read `hc get <address> --json` for
  its state, foreground, `status.state` and `status.msg`, then `hc read <address> --lines 40` and the job's
  worklog under its worktree's `.claude/worklog/job_<N>*`
  for the slice in hand. A job with no terminal is read from its worklog only and sorted as no session. A failed `hc`
  read is unknown: nothing is killed, removed, labelled or started on it. It sorts by what the status message, screen
  and worklog show, and writes the kind on a live terminal with `hc label <address> fabraik.stopped=<kind>`, so the
  job frees its running place:

  | Shows | Kind | Does |
  |---|---|---|
  | `Continuing automatically at`, `Continuing shortly` | none | Claude Code waits itself; nothing |
  | A usage limit not continuing: `Press enter to continue`, `Automatic continue stopped`, a usage-limit menu, a resumed session at a limit | `limit` | Alarm to the reset the screen names (now if past), then continue |
  | `quota exhausted ... resets HH:MM` from the tracker tools | `tracker` | Alarm to that time, then continue |
  | Overload, 5xx, timeout, connection | `overload` | Claude Code already retried. Alarm 5, then 10, 20, 40 minutes on each further stop of that kind in a row, then every 40 minutes for as long as it lasts; continue after each. On reaching 40 it tells the owner once that it is still waiting |
  | `Not logged in`, `Invalid API key`, `401`, `OAuth token`, `Credit balance`, `spend limit`, `organization has been disabled`, `Prompt is too long`, `Request too large`, `Context limit reached`, a missing model | `report` | One plain message to the owner naming the job, the text and what he can do; never retried, never asked as a question |
  | A way forward beyond the card | `question` | Routed to the job as **A job that needs the owner** says |
  | A turn ended `done` with the worklog showing slice work still to do, and no failure text | none | Continue once; if it stops `done` again at the same point, unknown |
  | A `continue` verdict whose live job terminal holds only its kept shell, by the test `start` uses in [herdr-stale-claim.md](herdr-stale-claim.md), or a job with no terminal, with the worklog showing work still to do | none | Run `start <N> --login <login>` for the eligible card. With a retained terminal record it recovers the job's session as below; with none, it opens a fresh session. |
  | Anything else or unreadable | unknown | Report what it shows; change nothing |

  Continue with `start <N> --login <login>`. For a `stopped` verdict with a free running place, it clears the label
  and sends `Carry on with card #<N>.` into that terminal. A failed send exits 1 and the job counts again.
  `start` refuses a held stopped job. For a `continue` verdict with a retained record whose runtime exited, `start`
  recovers the recorded session even if the coordinator changed.

  - **Claude Code.** `start` prints `Card <N>'s job session <name> is resuming session <id> in tab job <N>, not yet
    confirmed: hc get <address> --json shows it.` Confirm that `hc get` shows a live `claude` foreground.
  - **Codex.** `start` requires the retained terminal's original verified binding and resumes its exact thread using
    `codex resume <thread>` with the job's launch options. Missing or invalid binding refuses recovery before
    launching. After it verifies a live `codex` foreground and the replacement's own binding to that same thread,
    it removes the predecessor record and prints `Card <N>'s Codex job resumed its bound thread <thread> at <address>.`
    If replacement verification fails, it reports the cause and keeps the previous record.

  Keep one alarm for the earliest pending wait. Its exit note wakes the coordinator to continue. Inside the card,
  act and report what stopped and what was done in one plain message to the owner.
