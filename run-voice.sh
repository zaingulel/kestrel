#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export HF_HOME="$PWD/.runtime/cache/huggingface"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export MPLCONFIGDIR="$PWD/.runtime/cache/matplotlib"
export NUMBA_CACHE_DIR="$PWD/.runtime/cache/numba"
export TORCH_HOME="$PWD/.runtime/cache/torch"
exec .runtime/voice-venv/bin/python bot.py --host 127.0.0.1 --port 7860 -t webrtc
