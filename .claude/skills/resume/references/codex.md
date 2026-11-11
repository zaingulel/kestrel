# Codex

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 3. Start the job

- On Codex: for an authorized native run, follow [the native app route](runs.md#native-codex-app-run); otherwise a Codex-managed worktree per chat, or
  `git worktree add ../jobs/<issue> -b job/<issue> <recorded-origin-main>`. Outside the native run route, for each shell command in the job
  worktree, use `cd "<absolute-job-worktree>" && <command>` so the directory is visible to the git guard. Use this
  explicit prefix even when the tool also sets its working directory; the command runs only if the directory change
  succeeds.

## 4. Plan

On Codex, the coordinating session runs `explorer` first when discovery exceeds a couple of files; for a
couple of files it supplies its own completed findings.

Codex keeps completed-findings dispatch through the
coordinating session.

On Codex, the security reviewer returns the bounded request to the coordinating session for completed findings before redispatch.

## 5. Build

On Codex, save the
filled handoff as `.claude/worklog/handoffs/<task_name>.md` in the job worktree, then dispatch with that `task_name`
(letters, digits, `-` and `_` only, starting with the card number, such as `558_s2`, because the hook takes the
saved handoff from whichever of the repository's worktrees holds it) and the same text as the message. Dispatch
builders one at a time: the handoff hook refuses a builder dispatch while an earlier one in the session has not yet
started its builder, and its refusal names the record to remove if that dispatch failed.

## 5. Build: waiting

  - Where active instructions require updates within 60 seconds, `wait_agent` with `timeout_ms: 50000` leaves
    headroom after an update; the actual remaining deadline controls.
  - For a process, retain one `exec` cell. Where active instructions require updates within 60 seconds, its first line
    can be `// @exec: {"yield_time_ms": 50000}`. Inside, `tools.exec_command` initially waits at most 30000 milliseconds;
    resume `session_id` with `tools.write_stdin({ session_id, chars: "", yield_time_ms: … })`, bounded by the remaining
    cell/communication interval and tool limits. Inspect each result and finish on `exit_code`. Only after the cell
    yields as running, call `wait` on its cell ID, again within the remaining deadline.

## Parking

For a Linux background Codex whole-job return after a park or settled workflow stop, follow the held-comment and
identity checks and owner return in [held-cards.md](held-cards.md#parking-a-parked-job-comes-back).
Then delegate through `--continue-card` as [references/pre-approved-run.md](pre-approved-run.md) directs. This
replaces the ordinary worktree, claim and job continuation steps. The managed worker alone resumes and edits the job.
