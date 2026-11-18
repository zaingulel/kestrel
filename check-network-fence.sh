#!/usr/bin/env bash
set -euo pipefail

if (( $# )); then
  printf '%s\n' 'usage: check-network-fence.sh' >&2
  exit 2
fi

# A sandboxed main process that systemd could not give a private network runs on the host network
# without a status field saying so; only the kernel's namespace identity shows it.
if [[ -v MAINPID && "$MAINPID" =~ ^[1-9][0-9]*$ ]]; then
  identity="$(readlink -- "/proc/$MAINPID/ns/net" 2>/dev/null || true)"
  root="/proc/$MAINPID/root"
  if [[ -n "$identity" && "$identity" != "$(readlink -- /proc/self/ns/net)" && -d "$root/run" ]]; then
    # The walk reads file types and permissions only and connects to nothing. The trailing slash makes find enter
    # the process's root; the pruned trees hold no system sockets or are the runtime folder the services may use.
    # A folder the account can enter but not list can hide a socket from the walk, so it stops the start too.
    # find exits 1 for the unreadable folders every healthy walk meets and for other errors that skip a folder or end the walk early, which the manual states; a higher status means find itself failed.
    status=0
    reachable="$(/usr/bin/find "$root/" \( -path "$root/proc" -o -path "$root/sys" -o -path "$root/usr" -o -path "$root/home" -o -path "$root/run/user" \) -prune -o \( -type s -writable -o -type d -executable ! -readable \) -print -quit 2>/dev/null)" || status=$?
    if (( status > 1 )); then
      printf '%s\n' "Kestrel could not check its fence: /usr/bin/find ended with status $status. Check that find runs, then restart Kestrel." >&2
      exit 1
    fi
    if [[ -d "$reachable" ]]; then
      printf "Kestrel's fence leaves a folder it cannot check: %q. A socket file inside it would go unseen. Add that path to InaccessiblePaths= in the service's drop-in, then restart Kestrel.\n" "${reachable#"$root"}" >&2
      exit 1
    fi
    if [[ -n "$reachable" ]]; then
      printf "Kestrel's fence leaves a socket file reachable: %q. Add that path to InaccessiblePaths= in the service's drop-in, then restart Kestrel.\n" "${reachable#"$root"}" >&2
      exit 1
    fi
    exit 0
  fi
fi
printf '%s\n' "Kestrel's network fence did not apply. Check the service's systemd log, then restart Kestrel." >&2
exit 1
