# Pre-squash backup

This file is part of the `closeout` skill: a step number or section name in it that this file does not hold names
one in [its SKILL.md](../SKILL.md).

**Pre-squash backup.** Apply only after cleanup has no outstanding retention. Inspect actual successful
branch-creation and squash tool calls from this session or the transcript of a helper it dispatched for
this job. They must establish the exact branch, its recorded creation tip, this job's disposable backup
purpose and that it is no longer needed. A name, summary, previous session or branch existence does not
establish creation. Require its current exact local tip to equal the recorded creation tip. Confirm it is
neither `main` nor another job's branch, and no worktree checks it out. Try
`git branch -d -- <exact-backup>` first; only its not-fully-merged refusal permits
`git branch -D -- <exact-backup>`, after immediately rereading the unchanged tip and worktree occupancy.
Missing creation evidence, a moved tip, occupancy or any other refusal keeps the backup and is reported.
