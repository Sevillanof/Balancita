#!/bin/bash
# La noche de «Que Qwen aprenda junto al maestro»: entrena la OPINIÓN de Qwen en la Mac, mide, corta sola y deja un informe.
# NO toca Qwen en vivo: usa su propia carpeta de adaptadores, no cambia .env.local ni LLAMA_LORA ni pnpm dev.
#
#   caffeinate -i ops/qwen-lora/aprende-noche.sh            (desde una copia del repo con la rama del cambio, p. ej. un worktree)
#
# Pasos (todo queda en $DATA/aprende-noche/<fecha-hora>/ y en su log.txt):
#   0. Prueba de humo: 10 pasos, una medición de 6 ejemplos y la conversión a GGUF. Si algo falla, CORTA antes de gastar la noche.
#   1. Qwen sin entrenar: validación y práctica (la referencia).
#   2. Entrena de a 500 pasos (hasta TOTAL); después de cada tramo mide en la VALIDACIÓN del entrenamiento (nunca en la práctica) el
#      NETO por mirada de seguir su respuesta (entrar del lado que dice; cerrar o no), además del acierto y la costumbre. El criterio de
#      Fran es quedar POSITIVO en neto tras costos, no acertar: corta cuando dos tramos seguidos no mejoran ese neto (0,5 pb); guarda
#      cada checkpoint (paso-N/) y recuerda el mejor entre los que no son una costumbre (ninguna opción más del 70 % de las respuestas).
#   3. El mejor, UNA vez en la práctica (opinión contra fórmula sola, por mes, espejo), y su GGUF ($DATA/qwen-aprende.gguf, sin cargar).
#   4. informe.md: PASA / NO pasa con reglas fijas (futures_qwen_aprende.verdict).
# Variables: TOTAL (4000 pasos), CHUNK (500), VALID_N (150 ejemplos), PRACTICA_N (300 miradas sin posición y 300 con posición), BALANCITA_DATA.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
VENV=$DATA/venv
MODEL=$DATA/${QWEN_LORA_MODEL:-Qwen3-4B-4bit}
A=$DATA/aprende
TOTAL=${TOTAL:-4000}; CHUNK=${CHUNK:-500}; VALID_N=${VALID_N:-150}; PRACTICA_N=${PRACTICA_N:-300}
STAMP=$(date +%Y%m%d-%H%M)
OUT=$DATA/aprende-noche/$STAMP
AD=$OUT/adapters
mkdir -p "$OUT" "$AD"
exec > >(tee -a "$OUT/log.txt") 2>&1
PY="$VENV/bin/python"
export PYTHONPATH="$ROOT/python"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { say "CORTO: $*"; exit 1; }

# ---- 0. comprobaciones y prueba de humo
[ -f "$MODEL/config.json" ] || fail "falta el modelo en $MODEL (ops/qwen-lora/train.sh download)"
[ -x "$PY" ] || fail "falta el venv en $VENV (ops/qwen-lora/train.sh setup)"
for f in train valid practica; do [ -s "$A/$f.jsonl" ] || fail "falta $A/$f.jsonl (el dataset se arma en la nube y se copia aquí)"; done
free_gb=$(df -g "$DATA" | awk 'NR==2{print $4}'); [ "${free_gb:-0}" -ge 8 ] || fail "menos de 8 GB libres en $DATA"
LOCK=$DATA/aprende-noche.lock
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then fail "ya hay una noche corriendo (pid $(cat "$LOCK"))"; fi
echo $$ > "$LOCK"; trap 'rm -f "$LOCK"' EXIT
say "inicio. Pasos máximos $TOTAL de a $CHUNK; mide $VALID_N ejemplos de validación por tramo. Salida: $OUT"

say "0. prueba de humo (10 pasos, 6 ejemplos, conversión a GGUF)"
"$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$A" --adapter-path "$OUT/humo" \
  --iters 10 --steps-per-report 5 --steps-per-eval 1000 --save-every 1000 --val-batches 2 || fail "el entrenamiento de humo falló"
[ -f "$OUT/humo/adapters.safetensors" ] || fail "el entrenamiento de humo no dejó adapters.safetensors"
"$PY" "$ROOT/ops/qwen-lora/aprende_eval.py" --mode valid --model "$MODEL" --data "$A" --adapter "$OUT/humo" --max 6 --out "$OUT/humo/valid.json" \
  || fail "la medición de humo falló"
"$PY" -m balancita_engine.futures_qwen_lora_adapter "$OUT/humo" "$OUT/humo/humo.gguf" || fail "la conversión a GGUF falló"
[ -s "$OUT/humo/humo.gguf" ] || fail "la conversión no dejó el GGUF"
rm -rf "$OUT/humo"
say "prueba de humo OK"

# ---- 1. Qwen sin entrenar
say "1. Qwen sin entrenar"
"$PY" "$ROOT/ops/qwen-lora/aprende_eval.py" --mode valid --model "$MODEL" --data "$A" --max "$VALID_N" --out "$OUT/base-valid.json" | tail -n 1
"$PY" "$ROOT/ops/qwen-lora/aprende_eval.py" --mode practica --model "$MODEL" --data "$A" --max "$PRACTICA_N" --out "$OUT/base-practica.json" | tail -n 1

# ---- 2. entrenar de a tramos
done_steps=0; stale=0; prev=-1000000; best_step=0; best_score=-1000000
: > "$OUT/historia.jsonl"
while [ "$done_steps" -lt "$TOTAL" ]; do
  resume=()
  [ -f "$AD/adapters.safetensors" ] && resume=(--resume-adapter-file "$AD/adapters.safetensors")
  say "2. entrenando $CHUNK pasos (van $done_steps de $TOTAL)"
  "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$A" --adapter-path "$AD" \
    "${resume[@]}" --iters "$CHUNK" --save-every "$CHUNK" --steps-per-eval "$CHUNK" || fail "el entrenamiento falló en el paso $done_steps"
  done_steps=$((done_steps + CHUNK))
  mkdir -p "$AD/paso-$done_steps"
  cp "$AD/adapters.safetensors" "$AD/adapter_config.json" "$AD/paso-$done_steps/"
  "$PY" "$ROOT/ops/qwen-lora/aprende_eval.py" --mode valid --model "$MODEL" --data "$A" --adapter "$AD/paso-$done_steps" \
    --max "$VALID_N" --out "$AD/paso-$done_steps/valid.json" | tail -n 1
  read -r bal habit <<< "$("$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['neto_por_mirada_bp'] or 0, d['costumbre_parte'] or 1)" "$AD/paso-$done_steps/valid.json")"
  "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); d['paso']=int(sys.argv[2]); print(json.dumps(d, ensure_ascii=False))" "$AD/paso-$done_steps/valid.json" "$done_steps" >> "$OUT/historia.jsonl"
  # el mejor: más acierto balanceado entre los que no son una costumbre
  if [ "$("$PY" -c "import sys; b,h,s=map(float,sys.argv[1:]); print(int(h<=0.7 and b>s))" "$bal" "$habit" "$best_score")" = 1 ]; then best_score=$bal; best_step=$done_steps; fi
  if [ "$("$PY" -c "import sys; print(int(float(sys.argv[1])>float(sys.argv[2])+0.5))" "$bal" "$prev")" = 1 ]; then stale=0; else stale=$((stale + 1)); fi
  prev=$bal
  say "paso $done_steps: neto por mirada $bal pb, parte de la opción más repetida $habit, sin mejora $stale, mejor hasta ahora: paso $best_step ($best_score)"
  if [ "$stale" -ge 2 ]; then say "dos tramos seguidos sin mejorar el neto: corto el entrenamiento en $done_steps pasos"; break; fi
done

# ---- 3. el mejor, una vez en la práctica
if [ "$best_step" -eq 0 ]; then
  say "ningún checkpoint pasó (todos son una costumbre o no superaron el azar): se mide igual el último para dejar constancia"
  best_step=$done_steps
fi
echo "{\"paso\": $best_step}" > "$OUT/best.json"
say "3. el mejor es el paso $best_step: práctica ($PRACTICA_N miradas de cada tipo)"
"$PY" "$ROOT/ops/qwen-lora/aprende_eval.py" --mode practica --model "$MODEL" --data "$A" --adapter "$AD/paso-$best_step" --max "$PRACTICA_N" \
  --out "$OUT/best-practica.json" | tail -n 1
"$PY" -m balancita_engine.futures_qwen_lora_adapter "$AD/paso-$best_step" "$DATA/qwen-aprende.gguf" \
  && say "GGUF del mejor: $DATA/qwen-aprende.gguf (NO está cargado en ningún lado)" || say "la conversión a GGUF falló (el adaptador de mlx sigue en $AD/paso-$best_step)"

# ---- 4. informe
"$PY" -m balancita_engine.futures_qwen_aprende informe --dir "$OUT" --out "$OUT/informe.md" > /dev/null
say "fin. Informe: $OUT/informe.md"
