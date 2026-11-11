# Machinery rule

This file is part of the `resume` skill: a section number or quoted heading in it names a section of
[its SKILL.md](../SKILL.md).

## 4. Plan: machinery rule

- **Machinery rule.** New executable machinery in the workflow itself, including test scripts, harnesses, runners, and
  test-only tools (product code and ordinary tests added to existing suites are exempt), needs one of: a control failure
  a sentence in `AGENTS.md` or in a skill could not prevent twice, the same measurable friction across three independent
  jobs, a required new runtime or provider integration, or externally imposed security or platform drift. The friction
  route admits machinery only after the card's What to build names the friction and what doing less was tried first:
  fewer checks, deleted work, or a native feature. A store, cache, capture, retry, route, tracked input or repeated run
  added to existing machinery meets the same bar as new machinery. This rule is the one home for how machinery leaves: a
  job that removes a friction another way deletes the machinery that friction admitted, and a card that rewrites a
  testing strategy, a coding standard or the workflow text of `AGENTS.md` lists the machinery it keeps and settles keep,
  shrink or delete for each. Intake does not measure tooling growth. When the owner asks for a workflow-health
  assessment, report in one line, with no threshold, the size of the workflow tooling (scripts, tools and hooks, their
  tests counted apart) and its time-limit declarations, each a test or suite setting its own time limit on one line,
  at the fetched `origin/main` commit and at the newest `main` commit at least 30 days old,
  `git rev-list -1 --before=30.days.ago origin/main`. For each of the two commits `<rev>`, size prints tooling files,
  tooling lines, test files and test lines:
  `git grep -c -e '^' <rev> -- scripts tools .claude/hooks .codex/hooks .githooks | awk -F: '{ if ($(NF-1) ~ /\.test\./) { tf++; tl+=$NF } else { f++; l+=$NF } } END { print f+0, l+0, tf+0, tl+0 }'`
  and the declaration count is
  `git grep -c -E 'test\.setTimeout\(|test\.slow\(|[Ii]nfo(\(\))?\.(setTimeout|slow)\(|describe\.configure\(\{[^}]*timeout|^[[:space:]]*(test|it|describe)\([^;]*\{[[:space:]]*timeout:' <rev> -- tests scripts tools | awk -F: '{ s+=$NF } END { print s+0 }'`.
  A directory absent from a tree counts zero. When `rev-list` prints nothing or `git cat-file -e <rev>` fails, that
  commit's half is reported unavailable, never as zero.
