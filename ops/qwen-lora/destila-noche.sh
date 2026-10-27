#!/bin/bash
# «Enseñar a Qwen a leer la ficha»: piloto + corrida completa de la destilación (ver destila_noche.py).
#
#   caffeinate -i ops/qwen-lora/destila-noche.sh        (desde una copia del repo con la rama del cambio, p. ej. un worktree)
#
# Dataset: $BALANCITA_DATA/qwen-lora/destila/ (train, valid, valid-info, practica, meta). Máx. 2 h 30. NO toca Qwen en vivo.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
exec "$DATA/venv/bin/python" "$ROOT/ops/qwen-lora/destila_noche.py"
