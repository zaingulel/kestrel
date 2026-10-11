---
name: cross-review
description: The fresh reviewer pass for a code diff, run by the model family that did not write it, the Codex reviewer seat from a Claude session and the Claude reviewer seat from a Codex session, dispatched as configured, or by that family's own seat where the repository runs one runtime; and the plan review of a plan-first card, run on the Codex plan-reviewer seat before any build.
---

# cross-review

The `resume` skill's review step for the code and sign-off tiers. A writer's own family shares its blind spots,
so the `reviewer` charter runs on the other family. Both seats carry the same charter; this skill chooses which
one and how to call it. Plain single commands from the job worktree, read-only, nothing wrapped.

Section 4 carries the other review this skill reaches: the plan review the `resume` skill's Plan step names, run
on the Codex `plan-reviewer` seat before any build.

## 1. Dispatch the other family's seat as configured

Read the seat file and pass its settings unchanged; `AGENTS.md`'s model routing rule forbids raising or lowering
them. The read-only sandbox has no network, so the prompt carries the card, body and comments, that the charter's spec lens needs,
and the charter's own `gh` and web calls fail harmlessly. `<out>` is a directory outside the worktree.

`<pending>` names every check and review still running or already scheduled for this branch, the full suite, a
convergence check, `security-reviewer` or Greptile among them, or reads `none`. Every reviewer dispatch carries it,
a native dispatch of this family's own seat included, so the reviewer treats those as in hand and reports findings
only on what is already settled.

**Claude wrote the diff**: the Codex `reviewer` seat, `.codex/agents/reviewer.toml`. Codex's native
`exec review --base` accepts no custom instructions, so the charter goes through plain `codex exec`, read from
a prompt file so quoting cannot bite. The charter returns its findings as its final message; give it no OUTPUT
FILE, and say so, since the sandbox cannot write one. Each step below is one command; the session types each
value it reads as a literal into the later steps.

1. Read the branch, `<branch>`:

   ```sh
   git branch --show-current
   ```

2. Read the seat's `model` and `model_reasoning_effort` from `.codex/agents/reviewer.toml`, `<model>` and
   `<effort>`, at run time; never copy them from anywhere else:

   ```sh
   grep -E '^(model|model_reasoning_effort) = ' .codex/agents/reviewer.toml
   ```

3. Start the prompt file with the charter:

   ```sh
   sed -n '/^developer_instructions = """/,/^"""/p' .codex/agents/reviewer.toml | sed '1d;$d' > <out>/prompt.md
   ```

4. Append the review request:

   ```sh
   printf '\nReview branch %s against main for issue #<issue>, whose card follows. Still running or already
   scheduled, so in hand and outside your findings: <pending>. The sandbox has no network, so use this copy
   instead of gh, and return the JSON object as your final message.\n\n' '<branch>' >> <out>/prompt.md
   ```

5. Append the card:

   ```sh
   gh issue view <issue> --json title,body,comments \
     --jq '"# \(.title)\n\n\(.body)\n\n## Comments\n\n" + (.comments | map(.body) | join("\n\n---\n\n"))' >> <out>/prompt.md
   ```

6. Run the reviewer:

   ```sh
   codex exec -m <model> -c model_reasoning_effort=<effort> \
     -s read-only --skip-git-repo-check --ephemeral --json -o <out>/review.json -C . - \
     < <out>/prompt.md > <out>/events.jsonl
   ```

**Codex wrote the diff**: the Claude `reviewer` seat, `.claude/agents/reviewer.md`, which the CLI loads whole,
model, effort, tools and charter. Read `<branch>` with `git branch --show-current` first, then:

```sh
claude -p --agent reviewer --permission-mode plan --output-format json \
  "Review branch <branch> against main for issue #<issue>. Still running or already scheduled, so in hand and outside your findings: <pending>." > <out>/result.json
```

Read-only is not instruction isolation: the reviewer reads the checkout's `AGENTS.md`, rules and skills as its charter
directs, and nothing else is handed to it.

**The repository runs one runtime**: there is no other family's seat. Dispatch this family's own `reviewer` seat
natively, as configured, in a fresh context, with `<pending>` and the card in the dispatch. The `resume` skill owns what
the pull request body records, under "6. Verify and review".

## 2. Settle the findings

The same loop as any reviewer pass: fix each true finding by its cheapest valid fix, take a true finding whose every
fix costs more than it is worth to the owner, who may set it aside as deferred, and dismiss a finding with a reason
only when it is false; then one pass scoped to the repaired hunks by the same route. A finding whose remedy is a
rewrite of the writer's design is a scope question for the owner, not a fix; a cross-family reviewer is prone to
proposing one.

## 3. Quote the price

Write one line in the pull request body's Review section for each pass the Usage view cannot show: a Codex
command-line pass, whose `--ephemeral` run writes no session log. The line holds the raw fields of the
`turn.completed` event's `usage` in `events.jsonl`, side by side and never summed, so cached input is not counted
twice; for example,
`Usage, pass 1, Codex reviewer: input_tokens=N cached_input_tokens=N output_tokens=N reasoning_output_tokens=N`.
The JSON itself stays in `<out>`. A Claude pass and a natively dispatched seat each leave a session file the Usage
view reads, so the body carries no usage for them. A run that fails is reported as failed, never as zero cost.

## 4. Review a plan before the build

The `resume` skill's Plan step sends a plan-first card's fixed plan to the Codex `plan-reviewer` seat,
`.codex/agents/plan-reviewer.toml`, on both runtimes, and owns what happens when that seat cannot be reached.
Its settings are read from the seat file and passed unchanged, as in section 1.

In a repository that runs Claude Code alone the plan review is the fallback's seat and dispatch below, with no
unavailability to establish; the `resume` skill's Plan step owns what the body records.

**From a Claude session**: plain `codex exec` again. The sandbox has no network, so the prompt carries the
charter, the card and the whole plan. The charter writes its findings to an assigned file, which the sandbox
cannot do, so the request assigns none and asks for the JSON object as the final message. `<plan>` is the plan
file's absolute path and `<out>` is as in section 1. Each step is one command.

1. Read the plan reviewer's `model` and `model_reasoning_effort`, `<model>` and `<effort>`, at run time:

   ```sh
   grep -E '^(model|model_reasoning_effort) = ' .codex/agents/plan-reviewer.toml
   ```

2. Start the prompt file with the charter:

   ```sh
   sed -n '/^developer_instructions = """/,/^"""/p' .codex/agents/plan-reviewer.toml | sed '1d;$d' > <out>/prompt.md
   ```

3. Append the review request:

   ```sh
   printf '\nReview the fixed plan for issue #<issue>. Its card, which is your issue snapshot, follows, and the
   plan follows the card under the heading PLAN UNDER REVIEW. The sandbox has no network and cannot write a file,
   so use these copies instead of gh, take no output path, and return the JSON object as your final message,
   followed by the closing line your charter names.\n\n' >> <out>/prompt.md
   ```

4. Append the card with the command of section 1, step 5, unchanged.

5. Append the plan heading:

   ```sh
   printf '\n\n# PLAN UNDER REVIEW\n\n' >> <out>/prompt.md
   ```

6. Append the plan:

   ```sh
   cat <plan> >> <out>/prompt.md
   ```

7. Run the plan reviewer:

   ```sh
   codex exec -m <model> -c model_reasoning_effort=<effort> \
     -s read-only --skip-git-repo-check --ephemeral --json -o <out>/plan-review.md -C . - \
     < <out>/prompt.md > <out>/plan-events.jsonl
   ```

`<out>/plan-review.md` holds the review: the JSON object, then the charter's closing line. A run that exits
non-zero, or whose last message lacks that closing line, produced no review and is never read as a clean one. It
is unavailability only when its error output or `<out>/plan-events.jsonl` shows a cause the Plan step names; any
other failed or capped run is diagnosed and run again.

**From a Codex session**: the seat is this family's own, so dispatch `plan-reviewer` as configured, with the plan
file's path and the card in the dispatch, asking for the JSON object as the final message because the seat's
read-only sandbox cannot write its findings file.

**The fallback**, once the Plan step's unavailability rule is met: the Claude `plan-reviewer` seat,
`.claude/agents/plan-reviewer.md`, as configured. A Claude session dispatches its own seat, with the plan file's
path, the card and an output path in the dispatch. A Codex session calls the seat by name, as section 1 calls the
Claude reviewer. It has no shell, so the card is written to a file first:

```sh
gh issue view <issue> --json title,body,comments \
  --jq '"# \(.title)\n\n\(.body)\n\n## Comments\n\n" + (.comments | map(.body) | join("\n\n---\n\n"))' > <out>/card.md
```

```sh
claude -p --agent plan-reviewer --permission-mode plan --output-format json \
  "Review the fixed plan at <plan> for issue #<issue>, whose issue snapshot is the file <out>/card.md. Take no output path and return the JSON object as your final message, followed by the closing line your charter names." > <out>/plan-result.json
```

Quote the review in the pull request body's Review section, below the review line: the seat that reviewed the
plan, the number of findings at each severity, and, for a Codex command-line run, its usage line as section 3
says, read from `<out>/plan-events.jsonl`. A plan review is no round of the review line, which counts passes over
the tree.
