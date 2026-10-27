# Entrenar a Qwen con LoRA

Hilo «Entrenar a Qwen con LoRA» (26-oct-2026). Un ajuste fino LoRA del MISMO Qwen3-4B que opera en vivo, con fotos del pasado,
para ver si aprende a anticipar la dirección a 4 h que la ficha de 8 factores (v6) hoy no anticipa. Nada de esto toca a Qwen en
vivo: el adaptador se aplica solo a los pedidos que lo piden.

## Qué aprende

Dos preguntas por foto, las dos con la misma ficha (STATE) que ve en vivo:

**La dirección.** La misma pregunta y el mismo STATE de la ficha (config `qwen-live.json`), y como respuesta la línea `F1:v … F8:v` que «debió»
dar: los renglones que votan (F1 F2 F3 F4 F6 F7) llevan el signo de lo que hizo el precio en las 4 h siguientes, con ±2 si el
movimiento fue grande (por encima de la mediana del producto) y ±1 si fue chico; F5 y F8 en 0. El espejo también se enseña (ficha
dada vuelta, línea dada vuelta). Así el examen, la prueba rápida y la ventana en vivo leen la respuesta sin cambiar nada: la
inclinación sale, como siempre, de las probabilidades de «+» y «−».

**La entrada** (Fran, 26-oct: «hagamos las 3 igual»). Con el lado ya decidido, ¿cómo entrar? Una línea `E:v` con cinco opciones:
`E:-2` orden límite esperando un retroceso grande (30 pb a favor, válida 2 h), `E:-1` orden límite con retroceso chico (10 pb, 1 h),
`E:0` ya a mercado, `E:+1` esperar la vela de 15 min y entrar solo si confirma, `E:+2` esperar 1 h. La etiqueta es la opción que
dejó el mejor neto a las 4 h con las velas que siguieron (orden límite: comisión maker 0,02 %, se llena si una vela la toca; el resto
taker 0,05 %; una orden que no se llenó o una confirmación que no llegó vale 0). El espejo lleva el lado opuesto y la misma opción.
Esta pregunta no existe en vivo ni en el examen: la contesta `ops/qwen-lora/entry_eval.py`. Las simulaciones sin modelo
(`analisis/qwen-lora/informe-entrada.md`, `informe-momento.md`) dieron que ninguna de las tres formas de entrar gana por sí sola;
el LoRA se entrena igual por decisión de Fran.

## Períodos

- Entrenamiento: fotos cada 15 min de BTC y ETH de 2022-04-01 a 2025-09-30 (velas públicas de Kraken). Muestra de 2.000 fotos por
  producto repartidas por mes (4.000 fotos, 16.000 ejemplos de ~1.000 tokens: dirección y entrada, real y espejo); los últimos 2
  meses van a `valid.jsonl`.
- Validación: el examen en la ventana práctica 2025-10-16 a 2026-04-18 (`--exam-from 2025-10-16`), misma vara de siempre.
- Holdout desde 2026-04-19: intacto (`History` no lee esas velas).

## Pasos

1. Nube (sin modelo): `python -m balancita_engine.futures_qwen_lora dataset --out data/qwen-lora` escribe `train.jsonl`,
   `valid.jsonl` y `meta.json`. Se copia a la Mac en `~/balancita-data.noindex/qwen-lora/dataset/`.
2. Mac: `ops/qwen-lora/train.sh setup` (venv con mlx-lm, gguf, safetensors, ~0,5 GB) y `train.sh download` (Fran eligió QLoRA:
   `mlx-community/Qwen3-4B-4bit`, el mismo Qwen3-4B cuantizado a 4 bits para MLX, ~2,5 GB; pide confirmación. Los pesos quedan
   congelados en 4 bits y solo se entrena el adaptador; `QWEN_LORA_HF=Qwen/Qwen3-4B` usaría los pesos completos, ~8 GB. El GGUF
   Q8 de llama-server no sirve para entrenar).
3. `train.sh speed`: 50 pasos para medir tokens/s y memoria. El entrenamiento completo son ~16 millones de tokens.
4. `train.sh train` de noche (reanudable: guarda el adaptador cada 500 pasos y retoma si se cortó). En la Mac de Fran un paso
   (un ejemplo de ~1.000 tokens) tarda ~3,3 s con Qwen en vivo abierto (medido 26-oct: sin grad checkpointing 3,3 s, con él 3,8 s;
   lote 4 no mejora los ejemplos por segundo): la pasada completa (15.200 pasos) son ~14 h, así que se parte en dos noches con
   `train.sh train 7600` (~7 h; la segunda noche el mismo comando retoma el adaptador guardado). Hiperparámetros en
   `ops/qwen-lora/lora.yaml`: rango 8 en las 7 proyecciones de las últimas 16 capas, lote 1, una pasada, solo la línea de
   respuesta entra en la pérdida (`mask_prompt`).
   Mejor `train.sh train-measured N` (ver «Medir mientras entrena»): entrena de a 500 pasos y mide después de cada tramo.
4b. `train.sh eval [PASOS]`: mide los checkpoints guardados (o los que se nombren: `base,500,1000`) sobre 25 pares real/espejo de
   `valid.jsonl`, sin llama-server (`ops/qwen-lora/ckpt_eval.py`, ~3 min por checkpoint). Imprime, por checkpoint, qué valor
   contesta en F1, el acierto de signo contra la etiqueta, en qué fracción de pares el espejo da vuelta el lado, en cuántos contesta
   idéntico al espejo y la pérdida media por token de la respuesta. Un adaptador que lee la ficha da vuelta el lado en casi todos
   los pares; uno que aprendió una costumbre contesta idéntico.
5. `train.sh convert`: el adaptador de mlx-lm pasa al GGUF que llama-server carga (`futures_qwen_lora_adapter.py`).
6. `.env.local`: `LLAMA_LORA=~/balancita-data.noindex/qwen-lora/qwen-lora.gguf` y reiniciar `pnpm dev`. llama-server arranca con
   `--lora-scaled <gguf>:0` (un solo argumento `ARCHIVO:ESCALA`; la forma vieja de dos argumentos tira llama-server con
   «lora-scaled format: FNAME:SCALE»): el adaptador queda cargado con escala 0. En la versión instalada de llama-server, todo pedido que no trae el
   campo `lora` corre con la escala de arranque de los adaptadores (con `--lora` a secas sería 1,0, y `--lora-init-without-apply`
   solo retrasa esa primera aplicación: el 27-oct GET /lora-adapters mostró scale 1.0 y Qwen en vivo contestó con el adaptador
   hasta que se quitó la línea). Con escala 0, Qwen en vivo no manda el campo `lora` y sigue contestando igual; solo `exam --lora 0`
   y `entry_eval.py --lora 0` piden `lora: [{id: 0, scale: 1}]` en sus pedidos. `ops/qwen-lora/check_adapter.py` lo comprueba
   (GET /lora-adapters debe mostrar scale 0 y la misma ficha debe cambiar con y sin el campo).
7. Examen con el adaptador. Prueba rápida:
   `python -m balancita_engine.futures_qwen_trader exam --version live --lora 0 --exam-from 2025-10-16 --quick 150`
   (con `--quick` el examen escribe SIEMPRE en su propia base `data/qwen-trader/exam-v3-rapida.sqlite` e ignora `--exam-db`;
   el informe es `exam-report --version live --lora 0 --exam-from 2025-10-16 --exam-db data/qwen-trader/exam-v3-rapida.sqlite`).
   Después el completo, en su propia base: igual sin `--quick`, con `--exam-db data/qwen-trader/exam-lora.sqlite --max-minutes 240`,
   y `exam-report` con los mismos `--lora`, `--exam-from` y `--exam-db`.
8. La entrada, con el adaptador y sin él:
   `python ops/qwen-lora/entry_eval.py --lora 0 -n 300` y `python ops/qwen-lora/entry_eval.py --no-lora -n 300`. Compara el neto a
   4 h de la opción que eligió Qwen con entrar a mercado y con la mejor opción (oráculo), y cuántas veces eligió la mejor.
9. Solo si PASA, Fran decide si Qwen en vivo usa el adaptador (eso sería otro cambio: hoy el proceso en vivo nunca lo pide; usar
   la entrada elegida en paper sería otro más: hoy el operador solo entra a mercado).

## Medir mientras entrena (lo que faltó la noche del 26 al 27 de octubre)

La primera mitad (7.600 pasos, etiqueta = signo del movimiento a 4 h en los seis renglones votantes, ±2 si el movimiento fue
grande) aprendió una costumbre: a los 500 pasos ya contestaba un valor fijo en todas las fichas (+2 en 43 de 50), el espejo salía
idéntico en el 88 % de los pares y la pérdida por token de la respuesta era 0,044; a los 7.600 pasos contestaba −1 en 50 de 50,
el espejo idéntico en el 100 % y la pérdida 0,0435. El acierto de signo fue 48-50 % en todos los checkpoints. Causa: con una
ficha que anticipa ~52 %, leer los números ahorra 0,12 % del error del signo; el formato se aprende en los primeros 500 pasos y
después no hay nada más que bajar (informes en analisis/qwen-lora/informe-causa-costumbre-27oct.md). Por eso:

- `train.sh train-measured N [TRAMO]` entrena de a tramos de 500 pasos (`--resume-adapter-file`, copia `paso-<N>.safetensors`),
  mide cada tramo con `ckpt_eval.py` y corta cuando dos mediciones seguidas no mejoran ni la pérdida (2 %) ni el «espejo da vuelta».
  Todo queda en `$DATA/train-measured.log`. Con la etiqueta de hoy habría cortado a los 1.500 pasos (1,5 h en vez de 7).
- Antes de poner un adaptador en llama-server: espejo da vuelta ≥ 90 % de los pares y acierto de signo por encima de la etiqueta
  que se le enseñó; si no, no lee la ficha y el examen no va a decir nada.

## Memoria y tiempo en la Mac (24 GB)

QLoRA: pesos de 4 bits ~2,5 GB + entrenamiento (activaciones y logits de ~1.000 tokens) ≈ 5-6 GB, además de los ~6 GB del
llama-server de `pnpm dev`. Con los pesos completos serían 11-12 GB. Cerrar Teams/Chrome/VS Code igual. La velocidad se mide con
`speed`; con la GPU compartida, Qwen en vivo puede saltearse alguna mirada (queda anotado en su base).

Riesgo conocido de QLoRA aquí: el adaptador aprende sobre los pesos de 4 bits y llama-server lo aplica sobre el GGUF Q8. La
diferencia es chica (el adaptador es un delta pequeño sobre pesos casi iguales) y se mide igual: `check_adapter.py` y la prueba
rápida dicen lo que el adaptador hace de verdad sobre el Q8.
