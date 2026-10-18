#!/usr/bin/env bash
set -euo pipefail

if (( $# )); then
  printf '%s\n' 'usage: check-brain-ready.sh' >&2
  exit 2
fi

if status="$(curl -q --noproxy '*' --fail --silent --show-error \
  --retry 120 --retry-all-errors --retry-delay 1 --retry-max-time 120 \
  --max-time 5 --max-filesize 4096 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:8080/health)" && [[ "$status" == 200 ]]; then
  if [[ ! -v MAINPID ]]; then
    exit 0
  fi
  if [[ "$MAINPID" =~ ^[1-9][0-9]*$ ]] && \
    owner="$(timeout --signal=TERM --kill-after=1s 2s \
      lsof -nP -a -p "$MAINPID" -iTCP@127.0.0.1:8080 -sTCP:LISTEN -t)" && \
    [[ "$owner" == "$MAINPID" ]]; then
    exit 0
  fi
  printf '%s\n' 'Bonsai listener ownership could not be verified. Check kestrel-brain.service and port 8080, then restart Kestrel.' >&2
  exit 1
fi
printf '%s\n' 'Bonsai did not become ready. Check kestrel-brain.service and restart Kestrel.' >&2
exit 1
