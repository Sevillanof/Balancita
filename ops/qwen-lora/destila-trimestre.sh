#!/bin/bash
# Destilación noche a noche: UNA noche por trimestre, en orden (2023Q2, 2023Q3, ...). La noche de T entrena con los trimestres
# anteriores a T (cada fila con la fórmula que regía en SU trimestre), parte del adaptador de la noche anterior y mide en T, que no vio.
# No usa la práctica ni el holdout. NO toca Qwen en vivo, .env.local, pnpm dev ni el paper; el GGUF queda aparte, sin cargar.
#
#   ops/qwen-lora/destila-trimestre.sh plan              # qué noches hay hechas y cuál toca
#   caffeinate -i ops/qwen-lora/destila-trimestre.sh     # la noche que toca (o: ... 2024Q1 para una en particular)
#
# Dura ~1 h–1 h 15 (humo + 500 pasos + medición + GGUF) y CALIENTA la Mac: hay que dejarla enchufada y sin otra carga pesada.
# Variables: BALANCITA_DATA, CACHE (velas; por defecto el caché del repo), TOTAL (500), CHUNK (250), MAX_MIN (150).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
WORK=$DATA/destila-trimestre
PY=$DATA/venv/bin/python
export PYTHONPATH=$ROOT/python
CACHE=${CACHE:-$ROOT/data/qwen-trader/cache}

plan() { "$PY" -m balancita_engine.futures_qwen_destila plan-noches; }
done_q() { [ -s "$WORK/$1/adapter/adapters.safetensors" ]; }

if [ "${1:-}" = "plan" ]; then
  for q in $(plan); do done_q "$q" && echo "hecha   $q" || echo "falta   $q"; done
  exit 0
fi

Q=${1:-}
if [ -z "$Q" ]; then
  for q in $(plan); do done_q "$q" || { Q=$q; break; }; done
  [ -n "$Q" ] || { echo "no falta ninguna noche"; exit 0; }
fi
PREV=""
for q in $(plan); do
  [ "$q" = "$Q" ] && break
  done_q "$q" || { echo "falta la noche de $q: las noches van en orden"; exit 1; }
  PREV=$q
done
[ -z "$PREV" ] || export DESTILA_PARTIR_DE=$WORK/$PREV/adapter
echo "noche de $Q (parte de: ${PREV:-cero})"

mkdir -p "$WORK/$Q"
"$PY" -m balancita_engine.futures_qwen_destila armar-trimestre --trimestre "$Q" --cache-dir "$CACHE" \
  --out "$WORK/$Q/dataset" --rows-dir "$WORK/filas"
export DESTILA_DATASET=$WORK/$Q/dataset DESTILA_TRIMESTRE=$Q TOTAL=${TOTAL:-500} CHUNK=${CHUNK:-250}
"$PY" "$ROOT/ops/qwen-lora/destila_noche.py"

NIGHT=$(ls -d "$DATA"/destila-noche/*/ | sort | tail -1)
BEST=$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['paso'])" "$NIGHT/best.json")
mkdir -p "$WORK/$Q/adapter"
cp "$NIGHT/adapters/paso-$BEST/adapters.safetensors" "$NIGHT/adapters/paso-$BEST/adapter_config.json" "$WORK/$Q/adapter/"
cp "$NIGHT/informe.md" "$WORK/$Q/informe.md"
echo "listo: $WORK/$Q/informe.md (adaptador del paso $BEST guardado para la noche siguiente)"
