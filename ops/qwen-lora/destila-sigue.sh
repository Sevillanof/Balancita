#!/bin/bash
# Segunda etapa de la noche: espera a que termine destila-noche.sh (que ya corre) y, si paró solo por pasos o tiempo, sigue entrenando
# hasta 7 h desde su inicio (MAX_MIN_TOTAL), midiendo cada 250 pasos y cortando si 3 mediciones seguidas no superan la mejor.
#   nohup ops/qwen-lora/destila-sigue.sh > ~/balancita-destila-sigue.log 2>&1 &
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
DESTILA_SIGUE=1 exec caffeinate -i "$DATA/venv/bin/python" "$ROOT/ops/qwen-lora/destila_noche.py"
