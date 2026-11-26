# Herdr stale claim

The [Herdr coordinator](herdr-lead.md#coordinator) reads this file whole when
**A stale claim** in its "Coordinator" section sends it here for card N.

The coordinator repairs card N's claim without asking only when all of these hold, read in this order:

- its jobs read shows a job terminal `<address>` labelled `fabraik.card=<N>` whose `parent` is its own
  `HC_TERMINAL_ID`;
- `hc ls --label fabraik.role=job --label fabraik.space=<space> --label fabraik.card=<N> --all --json`, `<space>`
  being that terminal's `fabraik.space` label, shows no other terminal, so no replacement for it runs or is starting;
- `unfinished` lists no job for card N;
- `gh issue view <N> --json state,assignees,comments` and the board show card N open, with no assignee other than
  `<login>` and no comment beginning `Needs owner:`, and in `In progress`;
- `find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -mindepth 2 -maxdepth 2 -name '<session>.jsonl'` prints exactly
  one path, and `find <path> -maxdepth 0 -type f` prints it too, so it is a regular file and not a link, `<session>`
  being that terminal's `fabraik.session` label as `start` reads it; of the card's comments beginning `Claim:`, the
  latest has a `createdAt` at or after that terminal's `fabraik.runstart` label; and, `<url>` being that comment's
  `url`,
  `jq -rs --arg n '<N>' --arg u '<url>' '([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")]) as $calls | ([.[] | select(.type == "user") | .message.content[]? | select(.type == "tool_result")]) as $results | [$calls[] | select(.name == "Bash" and ((.input.command // "") | test("^node scripts/board-claim\\.mjs " + $n + " --intake [A-Za-z0-9_./-]+ --runtime \"Claude Code\"(; echo \"exit \\$\\?\")?$"))) | .id | strings | select(length > 0) | . as $i | select(([$calls[] | select(.id == $i)] | length) == 1) | [$results[] | select(.tool_use_id == $i)] | select(length == 1) | .[0] | select(.is_error != true and ([.content] | flatten | map(if type == "string" then . else (.text // "") end) | join("\n") | split("\n") | map(select(startswith("outcome: "))) | (last // "") | test("^outcome: Free: the session.s own claim, comment [0-9]+ at ") and endswith(" at " + $u + ", is the first new claim, so it holds the card")))] | length' <path>`
  prints `1`: only a successful result of that job's own claim command for card N, under an identifier no other call or
  result shares, whose last `outcome:` line confirms that address, matches, so the claim is that job's;
- that terminal listing shows the terminal not `live`, or `hc get <address> --json` shows it holding only its kept
  shell: an integer `pid`, an integer `foreground.pid` the same as `pid`, an `argv` whose first item is a string other
  than `/usr/bin/env`, and a `status` that is null or has a string `state`, the test `start` uses to tell a kept shell
  from a running program. A record that lacks any of these counts as running.

A comment begins `Needs owner:` or `Claim:` when its text does after any leading whitespace, tabs and blank lines
included, as `board-claim` reads it.

Where all hold, it repairs the claim without asking. Where any fails, it asks the owner about that card once through its
question menu, in plain words, without offering to clear it and without changing it; on no, or with no answer, it
changes nothing.

To repair, it repeats the `gh issue view` read and the board read, then the terminal reads above, straight before its
first write. Where any fails, or shows the terminal running, the card out of `In progress` or anything else other than
the first read showed, another assignee, a different latest `Claim:` comment or a comment beginning `Needs owner:`
included, it changes nothing and tells the owner which read failed or what changed. Otherwise it removes `<login>`,
where the read shows it, with `gh issue edit <N> --remove-assignee <login>`, and moves the card to `Ready` with
`node scripts/board-move.mjs <N> Ready`. A step that fails stops it there. Whatever those commands printed, it then
reads the card back with `gh issue view <N> --json state,assignees` and the board, since a write whose reply was lost
may still have been made, and tells the owner what it did and what the read-back shows, naming each step that failed and
each write the read-back could not confirm. It leaves terminal `<address>` and its record as they are, so `start`
resumes that job's recorded session, which claims again as [herdr-job.md](herdr-job.md) says; removing the record stays
the owner's, as **A refused start** in [herdr-lead.md](herdr-lead.md) says. It runs `start` only where the read-back
shows the card in `Ready` with no assignee.
