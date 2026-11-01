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
  if [[ -n "$identity" && "$identity" != "$(readlink -- /proc/self/ns/net)" ]]; then
    exit 0
  fi
fi
printf '%s\n' "Kestrel's network fence did not apply. Check the service's systemd log, then restart Kestrel." >&2
exit 1
