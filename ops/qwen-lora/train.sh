#!/bin/zsh
# Entrenar a Qwen con LoRA en la Mac, paso por paso (hilo «Entrenar a Qwen con LoRA»; ver docs/qwen-lora.md).
# Todo queda en $BALANCITA_DATA/qwen-lora (por defecto ~/balancita-data.noindex/qwen-lora). No toca pnpm dev ni Qwen en vivo.
#
#   ops/qwen-lora/train.sh setup      crea el entorno (venv) e instala mlx-lm, gguf y safetensors (~0,5 GB)
#   ops/qwen-lora/train.sh download   baja Qwen3-4B en versión MLX de 4 bits (QLoRA, ~2,5 GB): pide confirmación
#   ops/qwen-lora/train.sh speed      50 pasos de prueba: mide tokens/s y memoria para estimar la noche
#   ops/qwen-lora/train.sh train      el entrenamiento completo (reanudable: si hay adaptador guardado, sigue desde ahí)
#   ops/qwen-lora/train.sh convert    adaptador mlx -> qwen-lora.gguf (el que carga llama-server con LLAMA_LORA)
set -euo pipefail
ROOT=${0:A:h:h:h}
DATA=${BALANCITA_DATA:-$HOME/balancita-data.noindex}/qwen-lora
VENV=$DATA/venv
MODEL=$DATA/${QWEN_LORA_MODEL:-Qwen3-4B-4bit}
HF_MODEL=${QWEN_LORA_HF:-mlx-community/Qwen3-4B-4bit}
DATASET=${QWEN_LORA_DATASET:-$DATA/dataset}
ADAPTERS=$DATA/adapters
mkdir -p "$DATA"

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
    "$VENV/bin/hf" download "$HF_MODEL" --local-dir "$MODEL" --include "*.json" "*.safetensors" "merges.txt" "vocab.json"
    du -sh "$MODEL"
    ;;
  speed)
    [ -f "$DATASET/train.jsonl" ] || { echo "falta $DATASET/train.jsonl (el dataset se arma en la nube y se copia aquí)"; exit 1; }
    "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$DATASET" \
      --adapter-path "$DATA/adapters-prueba" --iters 50 --steps-per-report 10 --steps-per-eval 1000 --save-every 1000
    echo "Con los tokens/s de arriba: el entrenamiento completo son ~16 millones de tokens (16.000.000 / tokens_s / 3600 = horas)."
    ;;
  train)
    [ -f "$DATASET/train.jsonl" ] || { echo "falta $DATASET/train.jsonl"; exit 1; }
    resume=()
    [ -f "$ADAPTERS/adapters.safetensors" ] && resume=(--resume-adapter-file "$ADAPTERS/adapters.safetensors") && echo "retoma desde $ADAPTERS/adapters.safetensors"
    "$VENV/bin/mlx_lm.lora" -c "$ROOT/ops/qwen-lora/lora.yaml" --model "$MODEL" --data "$DATASET" --adapter-path "$ADAPTERS" "${resume[@]}"
    ;;
  convert)
    [ -f "$ADAPTERS/adapters.safetensors" ] || { echo "falta $ADAPTERS/adapters.safetensors: entrená primero"; exit 1; }
    PYTHONPATH="$ROOT/python" "$VENV/bin/python" -m balancita_engine.futures_qwen_lora_adapter "$ADAPTERS" "$DATA/qwen-lora.gguf"
    echo "Ahora: LLAMA_LORA=$DATA/qwen-lora.gguf en .env.local y reiniciar pnpm dev; después ops/qwen-lora/check_adapter.py"
    ;;
  *)
    sed -n '2,10p' "$0"
    ;;
esac
