@AGENTS.md

## Claude Code

- Skills, first-party and vendored upstream alike, are invoked as `/<name>`.
- When the owner asks for a screenshot, display it inline in chat; a subagent cannot.
- In a job worktree each shell call is one plain command, run from the worktree with no `git -C`, `--git-dir` or
  leading `cd`; anything longer goes in a scratch script inside the worktree, run on its own. Claude Code's worktree
  check reads the letters `git` anywhere in a command, `github` and file paths included, as a git command it must
  verify.
