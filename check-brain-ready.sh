#!/usr/bin/env bash
set -euo pipefail

if (( $# )); then
  printf '%s\n' 'usage: check-brain-ready.sh' >&2
  exit 2
fi

SOCKET="$XDG_RUNTIME_DIR/kestrel-brain/brain.sock"

if status="$(curl -q --noproxy '*' --fail --silent --show-error \
  --retry 120 --retry-all-errors --retry-delay 1 --retry-max-time 120 \
  --max-time 5 --max-filesize 4096 --output /dev/null --write-out '%{http_code}' \
  --unix-socket "$SOCKET" http://127.0.0.1:8080/health)" && [[ "$status" == 200 ]]; then
  if [[ ! -v MAINPID ]]; then
    exit 0
  fi
  # Flags 00010000 mark a listening socket; the file alone cannot show which process accepts on it.
  if [[ "$MAINPID" =~ ^[1-9][0-9]*$ ]] && \
    inode="$(SOCKET="$SOCKET" awk '$4 == "00010000" && $8 == ENVIRON["SOCKET"] {print $7}' \
      "/proc/$MAINPID/net/unix" 2>/dev/null)"; then
    for descriptor in "/proc/$MAINPID"/fd/*; do
      if [[ "$(readlink -- "$descriptor" 2>/dev/null)" == "socket:[$inode]" ]]; then
        exit 0
      fi
    done
  fi
  printf '%s\n' 'Bonsai listener ownership could not be verified. Check kestrel-brain.service and its socket file, then restart Kestrel.' >&2
  exit 1
fi
printf '%s\n' 'Bonsai did not become ready. Check kestrel-brain.service and restart Kestrel.' >&2
exit 1
