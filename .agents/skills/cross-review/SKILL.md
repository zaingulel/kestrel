---
name: cross-review
description: "The required fresh code reviews: independent primary and supplemental opposite-family passes on the normal authorized dual-runtime route, with declared single-primary exceptions; and the other-family plan review of a plan-first card before any build."
---

# cross-review

The `resume` skill's review step for the code and sign-off tiers. A writer's own family shares its blind spots,
so the primary `reviewer` and `reviewer-supplemental` run independently on the other family on the normal authorized
dual-runtime route. The supplemental seat reuses the primary charter body with its own configured settings. Use the
runtime-specific job-directory invocation in `resume` section 3; keep review commands read-only and follow Claude Code's isolated-worktree command restrictions.

Section 4 carries the other review this skill reaches: the plan review the `resume` skill's Plan step names, run
on the other family's `plan-reviewer` seat before any build, with declared exceptions.

Where `scripts/lib/board-config.mjs` exports `TRACKER = "markdown"`, cards are files, and `docs/MARKDOWN-CARDS.md` says
what each card step here becomes. Where it exports `TRACKER = "linear"`, cards are issues in a Linear team, and
`docs/LINEAR-CARDS.md` says what each card step here becomes. Where it exports `TRACKER = "jira"`, read
`docs/JIRA-CARDS.md` before any card action and apply its Jira substitutions throughout this skill. Where it exports
`TRACKER = "azure"`, read `docs/AZURE-CARDS.md` before any card action and apply its Azure substitutions
throughout this skill, including complete native-comment review before claiming.

For Jira or Azure card captures in every route below, use the selected guide's "Review snapshots" substitution, retaining the
route's existing output file and redirection.

## 1. Dispatch the required seats as configured

Dispatch the other family only where the `resume` skill, under "6. Verify and review", finds cross-family review
authorized or the owner has said yes for this job. On the normal authorized dual-runtime code/sign-off route, dispatch
the other family's `reviewer` and `reviewer-supplemental`, each in a fresh context. Read each seat file and pass its
settings unchanged; `AGENTS.md`'s model routing rule forbids raising or lowering them. The supplemental seat reads
only the primary charter body; its own metadata remains authoritative.

For a single-runtime repository, a cloud build, declined authorization or primary-provider unavailability, follow
`resume`'s [review routes](../resume/references/review-routes.md) or
[cloud route](../resume/references/cloud-build.md). Those routes run one primary and no supplemental pass. Keep the
document tier, plan review in section 4, `security-reviewer` and external review on their existing routes.

### Freeze the inputs

Before dispatch, freeze the clean committed tree and requirements once for both seats. Use the runtime-specific
job-directory invocation in `resume` section 3. `<out>` is a distinct attempt folder under the job's ignored
`.claude/worklog/<branch>-cross-review/`. Give each seat its own private `<out>/primary/` or `<out>/supplemental/`
output folder; create both before preparing prompts. Never reuse a previous attempt's output files.

Read `<branch>` with `git branch --show-current`, `<base>` with `git merge-base origin/main HEAD`, and `<head>` with
`git rev-parse HEAD`. Use those full commit values in both dispatches, never moving branch names. Both seats inspect
`git diff <base>...<head>` and files at `<head>`. Capture the card and comments once as `<out>/card.md`:

```sh
gh issue view <issue> --json title,body,comments \
  --jq '"# \(.title)\n\n\(.body)\n\n## Comments\n\n" + (.comments | map(.body) | join("\n\n---\n\n"))' > <out>/card.md
```

That file is the frozen requirements snapshot. Include the same approved plan material in both prompts where the
review needs it. `<pending>` names every check and review still running or already scheduled for this branch, the
full suite, a convergence check, `security-reviewer` or the external review among them, or reads `none`. Freeze that
list once too. Every dispatch carries the frozen refs, requirements and pending list, a native own-family primary
dispatch included, so each reviewer reports only on what is already settled.

### Claude wrote the diff: Codex seats

For each `<seat>` (`reviewer`, then `reviewer-supplemental`), use its private `<seat-out>` folder. Codex's native
`exec review --base` accepts no custom instructions, so use plain `codex exec` with a prompt file. The read-only
sandbox has no network; supply the frozen snapshot instead of live issue reads. The charter returns its review as
the final message; assign no OUTPUT FILE since the sandbox cannot write one. Each step is one command; type each
value read as a literal in later steps.

1. Read this seat's `model` and `model_reasoning_effort`, `<model>` and `<effort>`, at run time:

   ```sh
   grep -E '^(model|model_reasoning_effort) = ' .codex/agents/<seat>.toml
   ```

2. Start its prompt with its own charter, including the supplemental pointer when that is the seat:

   ```sh
   sed -n '/^developer_instructions = """/,/^"""/p' .codex/agents/<seat>.toml | sed '1d;$d' > <seat-out>/prompt.md
   ```

3. Append the frozen request, with `<peer-out>` naming the other seat's private folder:

   ```sh
   printf '\nReview frozen base <base> and head <head> for issue #<issue>. The frozen card/comments snapshot follows. Still running or already scheduled, so in hand and outside your findings: <pending>. Inspect only this frozen code and requirements. Do not read peer output folders or peer findings, including <peer-out>. The sandbox has no network and cannot write an output file; use this snapshot instead of gh and return the JSON object as your final message followed by the charter completion line.\n\n' >> <seat-out>/prompt.md
   ```

4. Append the same requirements snapshot:

   ```sh
   cat <out>/card.md >> <seat-out>/prompt.md
   ```

5. Prepare this invocation for each seat, with the settings read from that seat's file:

   ```sh
   codex exec -m <model> -c model_reasoning_effort=<effort> \
     -s read-only --skip-git-repo-check --ephemeral --json -o <seat-out>/review.md -C . - \
     < <seat-out>/prompt.md > <seat-out>/events.jsonl
   ```

### Codex wrote the diff: Claude seats

For each `<seat>` (`reviewer`, then `reviewer-supplemental`), read `.claude/agents/<seat>.md`; the CLI loads its
model, effort, tools, turn limit and charter whole. Use separate private `<seat-out>` folders and the same frozen
values and snapshot in each request. Prepare both invocations:

```sh
claude -p --agent <seat> --permission-mode plan --output-format json \
  "Review frozen base <base> and head <head> for issue #<issue>. Use the frozen card/comments snapshot at <out>/card.md instead of live issue reads. Still running or already scheduled, so in hand and outside your findings: <pending>. Inspect only this frozen code and requirements. Do not read peer output folders or peer findings, including <peer-out>. Take no output path and return the JSON review object as your final message followed by the charter completion line." > <seat-out>/result.json
```

Read-only is not instruction isolation: each reviewer reads the checkout's `AGENTS.md`, rules and skills as its
charter directs. Its prompt explicitly forbids peer outputs and findings, and supplies no earlier pass's conclusions.

### Dispatch barrier and validation

Start both prepared passes before reading either result, using `resume`'s Waiting rule for the native awaited
operations. Keep their outputs private. Until both attempts return, copy neither pass's findings into the shared
worklog, show neither to the other reviewer and make no repairs or changes to the frozen inputs. Observe command
completion and errors while waiting without reading findings. A failed attempt still returns to this barrier;
its failure never permits reading the other result early.

After both attempts return, validate each separately: successful exit, a valid JSON review object under the primary
charter's output contract, and the literal `review delivered in full` closing line in its final message. For Codex,
read `<seat-out>/review.md` and the completion event in `<seat-out>/events.jsonl`; for Claude, read the final message
inside `<seat-out>/result.json`. A zero-findings verdict is accepted only after this validation. A nonzero exit, malformed
object or missing completion marker fails validation. Diagnose and rerun malformed or capped
attempts against the same frozen inputs, with no peer findings supplied. For provider unavailability, follow `resume`'s [review routes](../resume/references/review-routes.md).

**A review too large to finish.** A seat that returns incomplete because the change is too large to read whole, in
its own words or by stopping at its turn or output limit while still reading, has given no review: discard that
attempt and count it neither as a clean review nor as a round. Rerun that seat in parts against the same frozen
inputs, with no peer findings supplied. List the changed paths with
`git diff --no-renames --ignore-submodules=none --name-only <base>...<head>`, so a moved file lists its old and new
path and a changed submodule is listed, and group them into parts that together cover every listed path, keeping
files whose changes depend on each other in one part. Run each part as its own fresh attempt of that seat, with its
own private output folder and the same prompt plus this sentence: "Your part replaces the whole diff: judge every
changed line of these paths and hunk ranges, reading any file at <base> or <head>, other changed files included,
where needed to judge how these changes affect it: <part>." Where a part still returns incomplete, split only that
part again, down to hunk ranges within one file, each named by its path and the hunk headers of the frozen diff it
holds. Validate each part as above. The parts of one seat stand together as that seat's one pass only once every
part has validated and together they cover every listed path and, for a file split into hunk ranges, every hunk of
that file. Record each part, with the paths and any hunk ranges it covered, under that seat's verdict in the pull
request body's collapsed Review findings block.

## 2. Settle the findings

After the barrier and validation, record each completed seat's verdict and findings, deduplicate overlapping findings, and
prove or refute each candidate. Fix each true finding by its cheapest valid fix, take a true finding whose every fix
costs more than it is worth to the owner, who may set it aside as deferred, and dismiss a finding with a reason only
when it is false. A finding whose remedy rewrites the writer's design is a scope question for the owner, not a fix.
Use `resume`'s repair pass, with no third full review.
No further pass runs when a repair adds no factual claim. The pull request template owns review counts; `resume`'s [review routes](../resume/references/review-routes.md) own declarations.

## 3. Quote the price

Write one line in the pull request body's Review section for each pass the Usage view cannot show: a Codex
command-line pass, whose `--ephemeral` run writes no session log. The line holds the raw fields of the
`turn.completed` event's `usage` in `events.jsonl`, side by side and never summed, so cached input is not counted
twice. Name the actual reviewing seat in each line; for example,
`Usage, pass 1, Codex reviewer: input_tokens=N cached_input_tokens=N output_tokens=N reasoning_output_tokens=N`.
The raw output stays in that pass's private `<seat-out>` folder (or `<out>` for a plan review). A Claude pass and a
natively dispatched seat each leave a session file the Usage view reads, so the body carries no usage for them. A run that fails is reported as failed, never as zero cost.

## 4. Review a plan before the build

Dispatch the other family only where the `resume` skill, under "6. Verify and review", finds cross-family review
authorized or the owner has said yes for this job.

The `resume` skill's Plan step sends a plan-first card's fixed plan to the other family's `plan-reviewer`
seat: a Claude-written plan goes to Codex and a Codex-written plan goes to Claude. Read each seat's settings
from its file and dispatch it as configured. The Plan step owns exceptions and their records.

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

4. Append the card with the capture command under section 1, **Freeze the inputs**, redirecting it to
   `<out>/prompt.md` with `>>` instead of to `<out>/card.md` with `>`.

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
non-zero, or whose last message lacks a valid JSON review object or that closing line, produced no review and is never
read as a clean one. It
is unavailability only when its error output or `<out>/plan-events.jsonl` shows a cause the Plan step names; any
other failed or capped run is diagnosed and run again.

**From a Codex session**: the Claude `plan-reviewer` seat, `.claude/agents/plan-reviewer.md`, which the CLI
loads whole, model, effort, tools and charter. It has no shell, so the card is written to a file first:

```sh
gh issue view <issue> --json title,body,comments \
  --jq '"# \(.title)\n\n\(.body)\n\n## Comments\n\n" + (.comments | map(.body) | join("\n\n---\n\n"))' > <out>/card.md
```

```sh
claude -p --agent plan-reviewer --permission-mode plan --output-format json \
  "Review the fixed plan at <plan> for issue #<issue>, whose issue snapshot is the file <out>/card.md. Take no output path and return the JSON object as your final message, followed by the closing line your charter names." > <out>/plan-result.json
```

For the Claude command, require a successful exit and a valid result containing the JSON review object and the
charter's closing line in its final message. A failed, malformed or capped result is no clean review: apply the same
unavailability and rerun rule above.

**Own-family native review**: where the Plan step directs this route, dispatch this family's configured
`plan-reviewer` natively with the complete card and plan. A Claude session assigns an output path; a Codex session
asks for the JSON object as the final message because its read-only sandbox cannot write the findings file. Validate
the review and the charter's closing line before accepting it.

Quote the review in the pull request body's Review section, below the review line: the seat that reviewed the
plan, the number of findings at each severity, and, for a Codex command-line run, its usage line as section 3
says, read from `<out>/plan-events.jsonl`. A plan review is no round of the review line, which counts passes over
the tree.
