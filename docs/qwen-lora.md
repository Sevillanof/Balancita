# Entrenar a Qwen con LoRA

Hilo «Entrenar a Qwen con LoRA» (26-oct-2026). Un ajuste fino LoRA del MISMO Qwen3-4B que opera en vivo, con fotos del pasado,
para ver si aprende a anticipar la dirección a 4 h que la ficha de 8 factores (v6) hoy no anticipa. Nada de esto toca a Qwen en
vivo: el adaptador se aplica solo a los pedidos que lo piden.

## Qué aprende

La misma pregunta y el mismo STATE de la ficha (config `qwen-live.json`), y como respuesta la línea `F1:v … F8:v` que «debió»
dar: los renglones que votan (F1 F2 F3 F4 F6 F7) llevan el signo de lo que hizo el precio en las 4 h siguientes, con ±2 si el
movimiento fue grande (por encima de la mediana del producto) y ±1 si fue chico; F5 y F8 en 0. El espejo también se enseña (ficha
dada vuelta, línea dada vuelta). Así el examen, la prueba rápida y la ventana en vivo leen la respuesta sin cambiar nada: la
inclinación sale, como siempre, de las probabilidades de «+» y «−».

## Períodos

- Entrenamiento: fotos cada 15 min de BTC y ETH de 2022-04-01 a 2025-09-30 (velas públicas de Kraken). Muestra de 3.000 fotos por
  producto repartidas por mes (6.000 fotos, 12.000 ejemplos de ~1.000 tokens); los últimos 2 meses van a `valid.jsonl`.
- Validación: el examen en la ventana práctica 2025-10-16 a 2026-04-18 (`--exam-from 2025-10-16`), misma vara de siempre.
- Holdout desde 2026-04-19: intacto (`History` no lee esas velas).

## Pasos

1. Nube (sin modelo): `python -m balancita_engine.futures_qwen_lora dataset --out data/qwen-lora` escribe `train.jsonl`,
   `valid.jsonl` y `meta.json`. Se copia a la Mac en `~/balancita-data.noindex/qwen-lora/dataset/`.
2. Mac: `ops/qwen-lora/train.sh setup` (venv con mlx-lm, gguf, safetensors, ~0,5 GB) y `train.sh download` (Fran eligió QLoRA:
   `mlx-community/Qwen3-4B-4bit`, el mismo Qwen3-4B cuantizado a 4 bits para MLX, ~2,5 GB; pide confirmación. Los pesos quedan
   congelados en 4 bits y solo se entrena el adaptador; `QWEN_LORA_HF=Qwen/Qwen3-4B` usaría los pesos completos, ~8 GB. El GGUF
   Q8 de llama-server no sirve para entrenar).
3. `train.sh speed`: 50 pasos para medir tokens/s y memoria. El entrenamiento completo son ~12 millones de tokens.
4. `train.sh train` de noche (reanudable: guarda el adaptador cada 500 pasos y retoma si se cortó). Hiperparámetros en
   `ops/qwen-lora/lora.yaml`: rango 8 en las 7 proyecciones de las últimas 16 capas, lote 1, una pasada, solo la línea de
   respuesta entra en la pérdida (`mask_prompt`).
5. `train.sh convert`: el adaptador de mlx-lm pasa al GGUF que llama-server carga (`futures_qwen_lora_adapter.py`).
6. `.env.local`: `LLAMA_LORA=~/balancita-data.noindex/qwen-lora/qwen-lora.gguf` y reiniciar `pnpm dev`. llama-server arranca con
   `--lora … --lora-init-without-apply`: el adaptador queda cargado con escala 0. Qwen en vivo no manda el campo `lora`, así que
   sigue contestando igual. `ops/qwen-lora/check_adapter.py` lo comprueba (misma ficha con y sin adaptador).
7. Examen con el adaptador, en su propia base:
   `python -m balancita_engine.futures_qwen_trader exam --version live --lora 0 --exam-from 2025-10-16 --exam-db data/qwen-trader/exam-lora.sqlite --quick 150`
   y después el completo (`--max-minutes 240`, sin `--quick`). Informe: `exam-report` con los mismos `--lora` y `--exam-from`.
8. Solo si PASA, Fran decide si Qwen en vivo usa el adaptador (eso sería otro cambio: hoy el proceso en vivo nunca lo pide).

## Memoria y tiempo en la Mac (24 GB)

QLoRA: pesos de 4 bits ~2,5 GB + entrenamiento (activaciones y logits de ~1.000 tokens) ≈ 5-6 GB, además de los ~6 GB del
llama-server de `pnpm dev`. Con los pesos completos serían 11-12 GB. Cerrar Teams/Chrome/VS Code igual. La velocidad se mide con
`speed`; con la GPU compartida, Qwen en vivo puede saltearse alguna mirada (queda anotado en su base).

Riesgo conocido de QLoRA aquí: el adaptador aprende sobre los pesos de 4 bits y llama-server lo aplica sobre el GGUF Q8. La
diferencia es chica (el adaptador es un delta pequeño sobre pesos casi iguales) y se mide igual: `check_adapter.py` y la prueba
rápida dicen lo que el adaptador hace de verdad sobre el Q8.
