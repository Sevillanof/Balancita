#!/bin/zsh
# Entrenar a Qwen con LoRA en la Mac, paso por paso (hilo «Entrenar a Qwen con LoRA»; ver docs/qwen-lora.md).
# Todo queda en $BALANCITA_DATA/qwen-lora (por defecto ~/balancita-data.noindex/qwen-lora). No toca pnpm dev ni Qwen en vivo.
#
#   ops/qwen-lora/train.sh setup      crea el entorno (venv) e instala mlx-lm, gguf y safetensors (~0,5 GB)
#   ops/qwen-lora/train.sh download   baja Qwen3-4B en versión MLX de 4 bits (QLoRA, ~2,5 GB): pide confirmación
#   ops/qwen-lora/train.sh speed      50 pasos de prueba: mide tokens/s y memoria para estimar la noche
#   ops/qwen-lora/train.sh train [N]  el entrenamiento (reanudable: si hay adaptador guardado, sigue desde ahí); N pasos en vez
#                                     de los del yaml, p. ej. `train 7600` para hacer la mitad una noche y la otra mitad la siguiente
#   ops/qwen-lora/train.sh convert    adaptador mlx -> qwen-lora.gguf (el que carga llama-server con LLAMA_LORA)
#   ops/qwen-lora/train.sh eval [PASOS]        mide checkpoints (coma: base,500,1000; por defecto todos los guardados) sobre 25 pares
#                                             real/espejo de valid.jsonl: acuerdo con el maestro, si el espejo da vuelta, pérdida (~3 min c/u)
#   ops/qwen-lora/train.sh train-measured N [TRAMO]  entrena de a tramos (500 pasos) y mide después de cada uno; CORTA solo cuando
#                                             dos mediciones seguidas no mejoran ni la pérdida (2 %), ni el «espejo da vuelta», ni el acuerdo
set -euo pipefail
ROOT=${0:A:h:h:h}
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
VENV=$DATA/venv
MODEL=$DATA/${QWEN_LORA_MODEL:-Qwen3-4B-4bit}
HF_MODEL=${QWEN_LORA_HF:-mlx-community/Qwen3-4B-4bit}
DATASET=${QWEN_LORA_DATASET:-$DATA/dataset}
ADAPTERS=$DATA/adapters
mkdir -p "$DATA"

need_model() {
  [ -f "$MODEL/config.json" ] || { echo "falta el modelo en $MODEL (no hay config.json): corré ops/qwen-lora/train.sh download"; exit 1; }
}

case "${1:-help}" in
  setup)
    [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q -U pip
    "$VENV/bin/pip" install -q "mlx-lm>=0.30" gguf safetensors "huggingface_hub[cli]"
    "$VENV/bin/python" -c "import mlx.core as mx, mlx_lm; print('mlx', mx.__version__, 'en', mx.default_device())"
    ;;
  download)
    echo "Va a bajar $HF_MODEL (el mismo Qwen3-4B, cuantizado a 4 bits para MLX, ~2,5 GB) a $MODEL."
    echo "QLoRA: los pesos quedan congelados en 4 bits y solo se entrena el adaptador. (QWEN_LORA_HF=Qwen/Qwen3-4B para los pesos completos, ~8 GB.)"
    read -q "ok?¿Seguir? (y/n) " || { echo; exit 1; }
    echo
    # por Python (snapshot_download viene siempre con huggingface_hub; el comando `hf` / `huggingface-cli` no siempre se instala)
    "$VENV/bin/python" -c "from huggingface_hub import snapshot_download; import sys; print(snapshot_download(sys.argv[1], local_dir=sys.argv[2]))" "$HF_MODEL" "$MODEL"
    du -sh "$MODEL"
    [ -f "$MODEL/config.json" ] || { echo "la descarga no dejó config.json en $MODEL: revisá el error de arriba"; exit 1; }
    ;;
  speed)
    need_model
    [ -f "$DATASET/train.jsonl" ] || { echo "falta $DATASET/train.jsonl (el dataset se arma en la nube y se copia aquí)"; exit 1; }
    "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$DATASET" \
      --adapter-path "$DATA/adapters-prueba" --iters 50 --steps-per-report 10 --steps-per-eval 1000 --save-every 1000
    echo "Con los tokens/s de arriba: la pasada completa son ~8 millones de tokens (8.000.000 / tokens_s / 3600 = horas)."
    ;;
  train)
    need_model
    [ -f "$DATASET/train.jsonl" ] || { echo "falta $DATASET/train.jsonl"; exit 1; }
    resume=()
    [ -f "$ADAPTERS/adapters.safetensors" ] && resume=(--resume-adapter-file "$ADAPTERS/adapters.safetensors") && echo "retoma desde $ADAPTERS/adapters.safetensors"
    iters=()
    [ -n "${2:-}" ] && iters=(--iters "$2") && echo "$2 pasos (el yaml trae la pasada completa)"
    "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$DATASET" --adapter-path "$ADAPTERS" "${resume[@]}" "${iters[@]}"
    ;;
  eval)
    need_model
    steps=${2:-}
    if [ -z "$steps" ]; then
      steps=$(ls "$ADAPTERS" 2>/dev/null | sed -n 's/^0*\([0-9][0-9]*\)_adapters\.safetensors$/\1/p' | sort -n | paste -sd, -)
      [ -n "$steps" ] || { echo "no hay checkpoints en $ADAPTERS"; exit 1; }
    fi
    "$VENV/bin/python" "$ROOT/ops/qwen-lora/ckpt_eval.py" --model "$MODEL" --data "$DATASET" --adapters "$ADAPTERS" \
      --out "$DATA/ckpt-eval" --pairs "${PAIRS:-25}" --steps "$steps" | tee -a "$DATA/ckpt-eval.log"
    ;;
  train-measured)
    need_model
    [ -f "$DATASET/train.jsonl" ] || { echo "falta $DATASET/train.jsonl"; exit 1; }
    total=${2:?pasos totales, p. ej. 3000}; chunk=${3:-500}; log=$DATA/train-measured.log
    done_steps=0; prev_loss=; prev_flip=; prev_agree=; stale=0
    [ -f "$ADAPTERS/adapters.safetensors" ] && echo "retoma desde $ADAPTERS/adapters.safetensors (los pasos se cuentan desde aquí)"
    while [ "$done_steps" -lt "$total" ]; do
      resume=()
      [ -f "$ADAPTERS/adapters.safetensors" ] && resume=(--resume-adapter-file "$ADAPTERS/adapters.safetensors")
      "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$DATASET" --adapter-path "$ADAPTERS" \
        "${resume[@]}" --iters "$chunk" --save-every "$chunk" --steps-per-eval "$chunk" 2>&1 | tee -a "$log"
      done_steps=$((done_steps + chunk))
      cp "$ADAPTERS/adapters.safetensors" "$ADAPTERS/paso-$done_steps.safetensors"
      line=$("$VENV/bin/python" "$ROOT/ops/qwen-lora/ckpt_eval.py" --model "$MODEL" --data "$DATASET" --adapters "$ADAPTERS" \
        --out "$DATA/ckpt-eval" --pairs "${PAIRS:-25}" --file "$ADAPTERS/paso-$done_steps.safetensors" | tail -n 1)
      echo "$line" | tee -a "$log"
      read -r loss flip agree <<< "$(printf '%s' "$line" | "$VENV/bin/python" -c 'import json,sys; d=json.load(sys.stdin); print(d["perdida_respuesta"], d["espejo_da_vuelta"] or 0, d["acuerdo_maestro"] or 0)')"
      if [ -n "$prev_loss" ]; then
        better=$("$VENV/bin/python" -c "import sys; l,pl,f,pf,a,pa=map(float,sys.argv[1:]); print(int(l < pl*0.98 or f > pf or a > pa))" "$loss" "$prev_loss" "$flip" "$prev_flip" "$agree" "$prev_agree")
        if [ "$better" = 1 ]; then stale=0; else stale=$((stale + 1)); fi
      fi
      prev_loss=$loss; prev_flip=$flip; prev_agree=$agree
      echo "[train-measured] $done_steps pasos: pérdida $loss, espejo da vuelta $flip, acuerdo con el maestro $agree, sin mejora $stale" | tee -a "$log"
      if [ "$stale" -ge 2 ]; then echo "[train-measured] dos mediciones seguidas sin mejora: corto en $done_steps pasos" | tee -a "$log"; break; fi
    done
    ;;
  convert)
    [ -f "$ADAPTERS/adapters.safetensors" ] || { echo "falta $ADAPTERS/adapters.safetensors: entrená primero"; exit 1; }
    PYTHONPATH="$ROOT/python" "$VENV/bin/python" -m balancita_engine.futures_qwen_lora_adapter "$ADAPTERS" "$DATA/qwen-lora.gguf"
    echo "Ahora: LLAMA_LORA=$DATA/qwen-lora.gguf en .env.local y reiniciar pnpm dev; después ops/qwen-lora/check_adapter.py"
    ;;
  *)
    sed -n '2,15p' "$0"
    ;;
esac
