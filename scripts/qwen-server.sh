#!/usr/bin/env bash
# Starts the local Qwen llama-server in "light mode": background priority and fewer threads,
# so the Mac stays usable while the quick test, the exam or live Qwen run.
# Same model, same context (-c 8192) and same 2 slots (-np 2) as before: answers do not change.
# Usage: scripts/qwen-server.sh            (light, default)
#        QWEN_THREADS=12 scripts/qwen-server.sh   (more threads, faster, heavier on the Mac)
set -euo pipefail

MODEL="${QWEN_MODEL:-$(ls "$HOME"/.cache/huggingface/hub/models--Qwen--Qwen3-4B-GGUF/snapshots/*/Qwen3-4B-Q8_0.gguf | head -n 1)}"
THREADS="${QWEN_THREADS:-6}"
PORT="${QWEN_PORT:-8088}"

# taskpolicy -b: background QoS (CPU, disk and GPU yield to foreground apps).
exec taskpolicy -b llama-server -m "$MODEL" --offline --host 127.0.0.1 --port "$PORT" \
  -c 8192 -np 2 -t "$THREADS" --no-mmproj --no-webui
