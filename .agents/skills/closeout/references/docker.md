# Docker

This file is part of the `closeout` skill: a step number or section name in it that this file does not hold names
one in [its SKILL.md](../SKILL.md). The command is step 5's cleanup command.

On Linux, bind paths require proof that the selected dockerd shares the caller's filesystem view.
Supported listener ownership is dockerd alone or dockerd sharing the listener with PID-1 systemd. Every
owner's socket descriptor and executable must verify, and its mount namespace and root must match the
unprivileged caller's observations. Remote endpoints, proxy executables, other ownership and differing
namespaces or roots, including isolated rootless daemons, retain the targets.
On macOS the selected endpoint must be exactly `~/.docker/run/docker.sock`, a socket the calling user owns in real
directories that user owns, and `docker version` must name the server Docker Desktop. Docker Desktop runs containers
in a virtual machine, so this identifies the endpoint and compares no namespaces: a process of the same user that
replaced that socket with a forward to another Docker Desktop would pass. Every other endpoint, `/var/run/docker.sock`
included, retains the targets.
A bind source is compared as its host path, with Docker Desktop's `/host_mnt` prefix removed, links followed, letter
case read from the disk and a folder's `/System/Volumes/Data` spelling read as its ordinary path; a mount field
holding the worktree's exact path under any other prefix retains it, and that catch reads no other spelling. A daemon
that does not answer retains every target, because a stopped container's binds cannot be read without it.
A bind source includes each mounted volume's bind device: the command reads the volume's options with
`docker volume inspect`, and a `local` driver volume whose `o` list holds `bind` or `rbind` counts as binding its
`device`, under these same rules, the mount-field catch included. Another driver's bind options, a volume whose name
or options cannot be read, or a device that is not a normalized absolute path retains every target with that reason,
and `--check` gives the same finding. A volume driver's own option naming a host path is not read.
The session then reads `ps -axo comm=`: a list with no `com.docker.backend` records Docker Desktop as stopped, and
anything else records nothing, since `docker desktop status` cannot tell stopped from broken. It runs
`docker desktop start`, records `docker ps -q` with each listed container's restart policy from
`docker inspect --format '{{.HostConfig.RestartPolicy.Name}}'`, and runs the command again. Only where it
recorded Docker Desktop as stopped, every recorded policy is `always` or `unless-stopped`, which Docker starts
by itself, and `docker ps -q` lists no container outside its record does it stop Docker Desktop with
`docker desktop stop`, so such a container runs only for that rerun; otherwise it leaves Docker Desktop
running and says so. If it will not start, the target stays pending under Sandboxed observation.
Docker Desktop's virtual machine keeps a folder open after a container that ran on it is removed, so the worktree is
retained with `com.apple.Virtualization` named as using it until Docker Desktop restarts. The process cannot be told
apart from another tool's virtual machine, so the command never excuses it. Only under those same three conditions,
which show nothing but Docker Desktop's own start has anything running, does the session run
`docker desktop restart`, record the list and its policies again, run the command again and stop Docker Desktop
as above; this is the one exception to Process holds in [retained-targets.md](retained-targets.md). Any other hold, or one that survives the restart, stays pending
under Deferred cleanup, and the report says a Docker Desktop restart releases it if the holder is Docker Desktop's.
A valid ownerless initial listener triggers noninteractive observation using existing matching passwordless
sudo permissions. Each metadata command ignores cached credentials without invalidating or updating the
owner's cache. Installing or broadening those permissions requires explicit owner approval outside cleanup.
Attempts and denials remain subject to the host's sudo auditing policy.
The command uses `/usr/bin/sudo -kn -u root -g root --` followed by `/usr/bin/ss -H -xlnpe` and the selected
socket filter: `src <socket>`, or `( src <endpoint> or src <socket> )` when its alias differs. For each owner,
it uses the same sudo prefix followed by `/usr/bin/stat -L -c '%d:%i:%Hd:%Ld:%F' --` and exactly
`/proc/<pid>/fd/<fd>`, `/proc/<pid>/ns/mnt`, `/proc/<pid>/root` and `/proc/<pid>/exe`.
When the command's own process carries the Linux `no_new_privs` flag, which stops sudo from gaining root, it
starts each of those two sudo commands, and nothing else, through the calling user's service manager with
`/usr/bin/systemd-run --user`, whose units do not inherit the flag. A retention reason naming `no_new_privs`
means the observation needed that route and the route did not complete it.
[The installed proof implementation](../../../../scripts/lib/closeout-cleanup.mjs) owns the exact argument
construction. Caller observations stay unprivileged. The command neither prompts nor installs tools or
privilege; unavailable passwordless observation retains the targets.
Rechecks keep the initial successful observation mode, and a failed or changed proof retains all remaining
targets even if later observations recover. The retention reason identifies the failed observation or
comparison. An incomplete command or unsupported observation does not establish permission denial;
retain the target and report that evidence limit.

**Sandboxed observation.** Any retained reason beginning `docker failed:` takes this route, sandboxed or not. A sandbox caller can have a different filesystem view from the host Docker service; a namespace mismatch alone does not establish permission denial or its cause. Before reporting observation exhausted, when the runtime offers native host execution, submit the selected current verifier's non-destructive `--check <path>` there as the same user through ordinary runtime review. Compare its result with the sandbox result for the same exact target. If the host check succeeds, complete the existing ownership, disposability and immediate safety checks, then run eligible cleanup in that same context with the unchanged verifier. An `unused` result alone grants no deletion authority. An unavailable or denied host route leaves the target retained with that evidence limit; a target-protecting refusal remains binding. This route grants no permission change or safeguard exception. A successful host check asks the owner nothing. Only when the route is unavailable, denied or also fails may the report carry one question, and only where a decision that is the owner's could settle it, such as the passwordless permission above; otherwise the target stays pending, and an unchanged hold is not asked about again.

A running container bound to a parent folder of the worktree is never stopped: it retains the worktree, any named scratch inside it
and the branch, including when it is also bound inside, and is waited out as a process hold under Process holds in [retained-targets.md](retained-targets.md). A stopped
one bound there holds nothing.
