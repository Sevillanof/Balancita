# Entrenar a Qwen con LoRA

Hilo «Entrenar a Qwen con LoRA» (26-oct-2026). Un ajuste fino LoRA del MISMO Qwen3-4B que opera en vivo, con fotos del pasado,
para que aprenda a decidir cuándo entrar y cuándo salir, cosa que la ficha de 8 factores (v6) hoy no logra (~50 % a 4 h). Nada de
esto toca a Qwen en vivo: el adaptador se aplica solo a los pedidos que lo piden.

## Estado (27-oct-2026, tarde): el LoRA queda en pausa; Qwen en vivo pasa a la versión 8 con la ficha corta

Fran (27-oct 13:38): «Me gusta, armémoslo así». En vez de entrenar al adaptador a copiar al maestro, el maestro y un **portero**
(dos fórmulas fijas en CPU) leen la ficha por Qwen y le dicen el resultado en una línea cada una (`futures_qwen_corta`,
`futures_qwen_portero`, `config/qwen-portero.json`); Qwen supervisa y decide entrar y salir. Detalles en `odd/tasks/qwen-trader.md`
(«Versión 8») y medición en `analisis/qwen-v8/informe.md` (archivos del proyecto). Consecuencias para este documento:

- `config/qwen-lora-maestro.json` se **reajustó** con las fotos de BTC y ETH de 2022-04-01 a 2025-09-30 (244.976 fotos, caché de
  velas de la nube; antes 2025-01 a 2025-09): acierto del signo a 12 h 53,3 % en el ajuste y 54,3 % en la práctica (57,7 % en las
  fuertes). Es el maestro de la versión 8; un dataset v3 nuevo saldría de él.
- La config en vivo ya no tiene `factors`, `state_ficha` ni `lora`: las herramientas de este documento (`futures_qwen_lora dataset`,
  `facts`, `exam --lora`) usan por defecto la **versión 7 congelada**, `config/qwen-live-v7.json` (`--config` para otra).
- El adaptador v2 (7.600 pasos) no se aplica en vivo: la ficha corta es otro texto. `LLAMA_LORA` puede quedar en `.env.local`;
  llama-server lo carga con escala 0 y nadie lo pide.

## Qué aprende

**El veredicto del maestro de operación** (dataset v3, Fran 27-oct: «quiero que Qwen aprenda cuándo entrar y cuándo salir, que
busque superar las comisiones»). El maestro es una fórmula fija guardada en el repo (`config/qwen-lora-maestro.json`, módulo
`futures_qwen_maestro`): una regresión logística SIN intercepto sobre los 15 números direccionales de la ficha (los que cambian de
signo en el espejo: retornos y z a 1 h / 4 h / 24 h / 7 d, impulso de 15 min, lugar en el rango de 24 h y 7 d, horas desde el
mínimo menos desde el máximo, área de valor, fuerza contra los otros activos), ajustada al signo del movimiento a 12 h. Por cada
foto da un veredicto: **+2 entrar largo fuerte, +1 largo flojo, 0 nada, −1 corto flojo, −2 corto fuerte** («fuerte» = el 20 % de
fotos más claras del período de ajuste, «flojo» = el 30 % siguiente, «nada» = la mitad restante). Qwen aprende a contestar ese
veredicto en los renglones que votan (F1 F2 F3 F4 F6 F7; F5 y F8 en 0), con la misma pregunta y el mismo STATE que ve en vivo. El
espejo también se enseña: la ficha dada vuelta con el veredicto exactamente opuesto.

Por qué un maestro y no el movimiento real: la etiqueta v2 (signo del movimiento a 4 h, ±2 si fue grande) era una moneda (52 %) y
el adaptador aprendió una costumbre a los 500 pasos (`analisis/qwen-lora/informe-causa-costumbre-27oct.md`). El veredicto del
maestro es una función exacta de lo que la ficha dice, así que sí se puede aprender, y se midió fuera de muestra qué vale operar
con él (`analisis/qwen-lora/informe-maestro-operacion-27oct.md`): entrar solo con veredicto fuerte, salir cuando el veredicto se
da vuelta al menos flojo o a las 48 h, sin stop, dio +29 pb netos por operación, 63 % ganadoras y 5 de 7 meses positivos en la
ventana práctica (270 operaciones; el intervalo roza el cero y al revés, aprendiendo en 2026 y midiendo en 2025, da 0: es una
promesa, no una prueba). Los stops pierden siempre, a 4 h no hay nada que aprender y los árboles no mejoran a la fórmula.

Ya no hay en el dataset etiqueta por plazo fijo, ±2 por tamaño del movimiento ni pregunta de entrada. La pregunta de la entrada
(`E:v`, cinco formas de entrar) sigue en el código para `ops/qwen-lora/entry_eval.py` (sus simulaciones sin modelo,
`informe-entrada.md` e `informe-momento.md`, dieron que ninguna forma de entrar gana por sí sola).

**El maestro.** `python -m balancita_engine.futures_qwen_lora facts --from A --to B --out hechos.jsonl` escribe una línea por foto
con todos los números de la ficha y los movimientos; `python -m balancita_engine.futures_qwen_maestro fit --facts hechos.jsonl
--plazo 720 --out config/qwen-lora-maestro.json` ajusta la fórmula (solo numpy; `medir` da acierto y reparto de veredictos en
otro período). El archivo guarda coeficientes, desvíos, umbrales, período y acierto del ajuste: es auditable y el dataset anota
su hash. El maestro del repo se ajustó en la nube con las fotos de 2024-12-31 a 2025-09-30 (lo que llega el caché de velas de la
nube); con las velas de la Mac (desde 2022-04) se puede volver a ajustar y medir año por año.

## Períodos

- Entrenamiento: fotos cada 15 min de BTC y ETH de 2022-04-01 a 2025-09-30 (velas públicas de Kraken). Muestra de 2.000 fotos por
  producto repartidas por mes (4.000 fotos, 8.000 ejemplos de ~1.000 tokens: real y espejo); los últimos 2 meses van a
  `valid.jsonl`.
- Validación: el examen en la ventana práctica 2025-10-16 a 2026-04-18 (`--exam-from 2025-10-16`), misma vara de siempre.
- Holdout desde 2026-04-19: intacto (`History` no lee esas velas).

## Pasos

1. Sin modelo (en la Mac, que tiene las velas desde 2022; ~10 min): `python -m balancita_engine.futures_qwen_lora dataset --out
~/balancita-data.noindex/qwen-lora/dataset` escribe `train.jsonl`, `valid.jsonl` y `meta.json`, etiquetados por el maestro del
   repo (`--maestro` para otro). `meta.json` trae el reparto de veredictos y el hash del maestro.
2. Mac: `ops/qwen-lora/train.sh setup` (venv con mlx-lm, gguf, safetensors, ~0,5 GB) y `train.sh download` (Fran eligió QLoRA:
   `mlx-community/Qwen3-4B-4bit`, el mismo Qwen3-4B cuantizado a 4 bits para MLX, ~2,5 GB; pide confirmación. Los pesos quedan
   congelados en 4 bits y solo se entrena el adaptador; `QWEN_LORA_HF=Qwen/Qwen3-4B` usaría los pesos completos, ~8 GB. El GGUF
   Q8 de llama-server no sirve para entrenar).
3. `train.sh speed`: 50 pasos para medir tokens/s y memoria. La pasada completa del dataset v3 son ~8 millones de tokens.
4. `train.sh train` (reanudable: guarda el adaptador cada 500 pasos y retoma si se cortó). En la Mac de Fran un paso (un ejemplo
   de ~1.000 tokens) tarda ~3,3 s con Qwen en vivo abierto (medido 26-oct: sin grad checkpointing 3,3 s, con él 3,8 s; lote 4 no
   mejora los ejemplos por segundo): la pasada completa (7.600 pasos) son ~7 h. Hiperparámetros en `ops/qwen-lora/lora.yaml`:
   rango 8 en las 7 proyecciones de las últimas 16 capas, lote 1, una pasada, solo la línea de respuesta entra en la pérdida
   (`mask_prompt`). La Mac se calienta con cada corrida (Fran, 27-oct): corridas cortas, de a una, avisando antes en el chat;
   la primera prueba del dataset v3 es `train-measured 1000` (~1 h).
   Mejor `train.sh train-measured N` (ver «Medir mientras entrena»): entrena de a 500 pasos y mide después de cada tramo.
   4b. `train.sh eval [PASOS]`: mide los checkpoints guardados (o los que se nombren: `base,500,1000`) sobre 25 pares real/espejo de
   `valid.jsonl`, sin llama-server (`ops/qwen-lora/ckpt_eval.py`, ~3 min por checkpoint). Imprime, por checkpoint, qué valor
   contesta en F1, el acuerdo con el maestro (`acuerdo_maestro`: la fracción de fichas donde contesta exactamente el veredicto;
   `acuerdo_signo`: al menos el lado), en qué fracción de los pares con lado el espejo da vuelta el lado, en cuántos contesta
   idéntico al espejo (un valor distinto de 0) y la pérdida media por token de la respuesta. Un adaptador que lee la ficha da vuelta
   el lado en casi todos los pares; uno que aprendió una costumbre contesta idéntico.
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

La primera mitad del dataset v2 (7.600 pasos, etiqueta = signo del movimiento a 4 h en los seis renglones votantes, ±2 si el
movimiento fue grande) aprendió una costumbre: a los 500 pasos ya contestaba un valor fijo en todas las fichas (+2 en 43 de 50), el espejo salía
idéntico en el 88 % de los pares y la pérdida por token de la respuesta era 0,044; a los 7.600 pasos contestaba −1 en 50 de 50,
el espejo idéntico en el 100 % y la pérdida 0,0435. El acierto de signo fue 48-50 % en todos los checkpoints. Causa: con una
ficha que anticipa ~52 %, leer los números ahorra 0,12 % del error del signo; el formato se aprende en los primeros 500 pasos y
después no hay nada más que bajar (informes en analisis/qwen-lora/informe-causa-costumbre-27oct.md). Por eso:

- `train.sh train-measured N [TRAMO]` entrena de a tramos de 500 pasos (`--resume-adapter-file`, copia `paso-<N>.safetensors`),
  mide cada tramo con `ckpt_eval.py` y corta cuando dos mediciones seguidas no mejoran ni la pérdida (2 %), ni el «espejo da
  vuelta», ni el acuerdo con el maestro. Todo queda en `$DATA/train-measured.log`. Con la etiqueta v2 habría cortado a los 1.500
  pasos (1,5 h en vez de 7).
- Gate antes de poner un adaptador en llama-server: espejo da vuelta ≥ 90 % de los pares con lado y acuerdo con el maestro ≥ 85 %;
  si no, no lee la ficha y el examen no va a decir nada.
- Regla en paper cuando un adaptador pase el gate (pendiente de código, no cambia a Qwen en vivo hasta entonces): entrar solo con
  veredicto fuerte (los seis votantes en ±2), salir cuando el veredicto se da vuelta al menos flojo o a las 48 h, sin stop; en vez
  del cierre a las 4 h de hoy.

## Memoria y tiempo en la Mac (24 GB)

QLoRA: pesos de 4 bits ~2,5 GB + entrenamiento (activaciones y logits de ~1.000 tokens) ≈ 5-6 GB, además de los ~6 GB del
llama-server de `pnpm dev`. Con los pesos completos serían 11-12 GB. Cerrar Teams/Chrome/VS Code igual. La velocidad se mide con
`speed`; con la GPU compartida, Qwen en vivo puede saltearse alguna mirada (queda anotado en su base).

Riesgo conocido de QLoRA aquí: el adaptador aprende sobre los pesos de 4 bits y llama-server lo aplica sobre el GGUF Q8. La
diferencia es chica (el adaptador es un delta pequeño sobre pesos casi iguales) y se mide igual: `check_adapter.py` y la prueba
rápida dicen lo que el adaptador hace de verdad sobre el Q8.
