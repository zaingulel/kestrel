# Retained targets

This file is part of the `closeout` skill: a step number or section name in it that this file does not hold names
one in [its SKILL.md](../SKILL.md). The command is step 5's cleanup command.

Stop a server the command reports serving the worktree only
on positive evidence that it is this session's own: as the session's own background task when it holds one,
otherwise by the process ID the command names once that process's parent chain reaches this session. Any other
server is a process hold.
Stop a process it reports using a scratch
target only when it is confirmed as this session's own, and verify it stopped; otherwise the target stays and
is reported.

**Process holds.** A process using a target is waited out: the target stays for a later session, and this run
neither waits nor polls.
On Linux and macOS an idle shell is not such a process: bash, zsh, fish, sh, dash or ksh, a login form such as `-zsh`
included, started with no arguments but `-i`, `-l` or `--login`, whose only use of the target lsof lists is its
working directory at or below it, that has no child process and leads the foreground process group of a terminal ps
can name, which ps shows as its process ID, process group and terminal foreground process group being one number. The
command prints a line naming each idle shell it passed over, as the reason on the `unused` line in `--check`, and
goes on. The shell stays at its prompt in a removed folder, harmless once the job has merged. A shell with a child
process, another file open there, the target in its arguments, a script or command to run, or no terminal, or one ps
cannot name, stays a hold, as does a subshell or job left in the background, a process in a foreground job it does
not lead, and every other process. The command cannot tell a shell at its prompt from another process that meets all
of this, so it also passes over a shell running only builtins in the foreground, such as a typed `read` or a loop of
builtins, and a program started in the foreground that names itself a shell. Windows is unchanged: it refuses to
delete a folder a shell sits in, and the command retains every target there.
Unless it is confirmed as this session's own, never
type into, stop or kill it, and never ask the owner to `cd` away or close anything. One terminal tab is confirmed
as this session's own: where the runtime lists this session's terminal tabs and closes the ones it opened, as the
desktop app's `list_terminal_tabs` and `stop_terminal_tab` do, a tab that started in the target or a folder inside
it, that `list_terminal_tabs` reports with nothing running, and that this session opened. Close it with
`stop_terminal_tab` and `close: true`, then run the command again; a hold that remains is still waited out.
These tab steps apply only to a holder the command still reports after passing over idle shells. Idleness is read
from the runtime, never assumed: such a tab whose running state is unknown or that runs anything, such as a dev
server, a long command or an editor, stays a hold, and so does one the tool will not close, since it never closes
one the owner opened or typed in. Report each hold in one line that says whether the holder is idle at its prompt
or running something, or that this is unknown, record it under Deferred cleanup and ask the owner nothing: the
target is safe while it waits and no decision is pending. A use check that could not finish is treated the same.
Call the holder the owner's terminal only on evidence: a runtime tool that lists terminal tabs shows an
owner-opened tab with that process, or `ps -o pid=,ppid=,tty=,args= -p <pid>` shows an interactive shell on a
terminal whose parent chain does not reach this session, and the line then gives its idleness as unknown unless
such a tool reports it. Otherwise the line names the process ID and command and says its owner is unknown; a
process the session cannot identify is no owner question either. A later session removes the target once the hold
has gone.

A standalone ignored symbolic link, including a named regenerated root such as `node_modules`,
permits removal only when its direct destination and resolved target lie outside this worktree and every
other linked worktree; the main checkout is allowed. A symbolic-link parent, missing or unresolved target,
inside-pointing link or unresolvable linked checkout retains the worktree. The command repeats each link's
type, parent and destination eligibility checks after the index and final Docker check, resolves the recorded
protected checkout paths again, and compares device, inode, link text and resolved target. A changed observation
retains the worktree. These bounded observations do not lock concurrent filesystem changes or worktree
registration. Only the worktree path goes to ordinary `git worktree remove`; no mutation follows or changes a
link target. Other ignored real entries remain held, apart from verified regenerated directories and a real
directory holding no file, which is no hold: it goes only with the worktree, the command reads it again after
the final checks, and a change retains the worktree. On Linux a directory with a mount at or beneath it, read
from the mount table, stays held, and a table that cannot be read retains the worktree; macOS has no such read.

After removing a worktree whose parent folder sits directly inside Codex's worktree root, it also removes that outer folder when the folder holds only Codex's empty `.codex-worktree-name` file, passes the same in-use and Docker checks, and, read again after them, is still the folder it read before removing the worktree with the same empty file alone in it: that file, then the empty folder, nothing else inside it and nothing above it. Codex's worktree root is the `git-worktree-root` value in the `[desktop]` table of `$CODEX_HOME/config.toml`, trimmed as Codex trims it, or `$CODEX_HOME/worktrees` when nothing is at that path or the file names no root or a blank one; `~/.codex` stands in for an unset or empty `CODEX_HOME`. Only that user file is read, never Codex's other configuration layers, so a root set elsewhere is not seen and that job's outer folder stays. A settings file it cannot read or parse, a `[desktop]` that is not a table, a value that is not a string, not a normalized absolute path or cannot be resolved, a `CODEX_HOME`, or the home folder standing in for an empty one, that is not a normalized absolute path, or a parser it cannot load names no root, so a marked outer folder is retained with that reason wherever it sits, the default root included. It judges the outer folder before the branch. Anything else in the folder, a marker that is not an empty file, a use or a failed check, or a folder or marker it cannot read or that changed retains the outer folder with its reason; a later run no longer sees it, so it stays and the final report names it. The last read and the removal are not one atomic step: a swap in that moment can cost at most the file then named `.codex-worktree-name` at that path, whatever it holds and wherever a link there leads, and one empty folder.
