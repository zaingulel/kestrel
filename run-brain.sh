#!/usr/bin/env bash
set -euo pipefail

if (( $# )); then
  printf '%s\n' 'usage: run-brain.sh' >&2
  exit 2
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PRISM="$ROOT/.runtime/tools/bonsai-prism-b10787-73bfe6c"
CUDA="$ROOT/.runtime/tools/cudart-b11815-cuda-12.8/cudart-llama-b11815-bin-ubuntu-cuda-12.8-x64"
KEY="$ROOT/.runtime/brain-api-key"

brain_key_is_safe() {
  local mode size line
  [[ ! -L $KEY && -f $KEY ]] &&
    mode="$(stat -c %a -- "$KEY" 2>/dev/null)" && (( (8#$mode & 8#077) == 0 )) &&
    size="$(stat -c %s -- "$KEY" 2>/dev/null)" && (( size == 65 )) &&
    { IFS= read -r line < "$KEY"; } 2>/dev/null &&
    [[ $line =~ ^[0123456789abcdef]{64}$ ]]
}

if ! brain_key_is_safe; then
  printf '%s\n' 'The brain key .runtime/brain-api-key is missing or unsafe. Create it as README.md describes under Brain key, then restart Kestrel.' >&2
  exit 1
fi

cd -- "$PRISM"
exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 \
  LD_LIBRARY_PATH="$PRISM/cuda-12.8/llama-prism-b10787-73bfe6c:$CUDA" \
  "$PRISM/cuda-12.8/llama-prism-b10787-73bfe6c/llama-server" \
  -m "$ROOT/.runtime/models/bonsai-2-27b/Ternary-Bonsai-2-27B-PQ2_0.gguf" \
  --alias bonsai-2-27b --host 127.0.0.1 --port 8080 \
  --api-key-file "$KEY" \
  --gpu-layers all -fa on -c 64000 -np 1 -b 256 -ub 128 --fit off \
  --kv-offload --cache-type-k f16 --cache-type-v f16 \
  --no-context-shift --no-webui --no-slots --no-agent --no-ui-mcp-proxy \
  --cors-origins http://127.0.0.1:8080 --jinja --reasoning auto --reasoning-format deepseek \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --temp 0.4 --top-p 0.8 --top-k 20 --min-p 0 \
  --presence-penalty 1.5 --repeat-penalty 1 --repeat-last-n 64 -lv 3
