# Qwen: medir su error y corregirlo

Pedido de Fran (2026-10-09): saber cuán errado está Qwen al predecir y cómo aprende de sus errores. La naturaleza de Qwen no cambia: responde directo, solo decide y aprende.

## Estado de partida

- Cada decisión de `trade_action` se guarda con sus probabilidades (logprobs de las letras) y `confidence = 1 - H/ln n`, y se puntúa +1/-1 a 30 min con costes. C31 juzga hold/close a 30 min.
- Métricas: acierto %, pb netos, "siempre hold", prueba pareada por día entre brazos.
- Único bucle de vuelta: `lessons` / `exit_lessons` en el prompt. No hay reentrenamiento.
- `config/decision-calibration.json` solo tiene `direction_1h@1: 1.0`; `trade_action` usa T=1 por defecto.

## Tareas

- [x] QC-01 [S] Informe de calibración de `trade_action` (solo lectura): Brier, log-loss, línea base de tasa base, fiabilidad por bandas de probabilidad, error con p >= 0,9, mitades vieja/nueva. `futures_llm_calibration.py`, dentro de `futures_llm_scores.report` (clave `calibration`) y del texto del CLI. Falta correrlo sobre las decisiones reales de la Mac.
- [ ] QC-02 [M] Ejecutar los 3 brazos (original, context, learning) con el modelo real, 7 días, `pnpm dev` parado, y compararlos con `futures_replay_compare` (¿ayuda `lessons`?).
- [x] QC-03 [M] (código listo; falta correrlo con decisiones reales: `python -m balancita_engine.futures_llm_calibrate --decisions-db … --verdicts-db … [--write]`; acepta T solo con 100+ decisiones por parte y mejora de log-loss en validación) Ajustar la temperatura T de `trade_action` por tiempo (ajustar con lo viejo, validar con lo nuevo) y guardarla en `config/decision-calibration.json`. Hoy no existe el código de ajuste.
- [ ] QC-04 [M] Quitar el sesgo de letras: promediar la pregunta con el orden de opciones permutado (el sesgo está confirmado, `analisis/letras-permutadas/probe_letter_bias.py`). Nueva versión de la pregunta.
- [ ] QC-05 [S] Brazo A/B: operar solo cuando la confianza calibrada supere un umbral (depende de QC-03 y QC-04).
- [ ] QC-06 [S] Mismo informe de calibración para `exit_decision` (C31).
- [ ] QC-07 [L] Reentrenar (LoRA sobre las decisiones etiquetadas). Solo si QC-01 a QC-05 muestran señal y hay cientos o miles de ejemplos. Riesgo de sobreajustar ruido.

## Registro

- 2026-10-09 (QC-01): informe de calibración añadido, sin cambiar la pregunta, el prompt ni la regla de decisión.
- 2026-10-09 (QC-03): `futures_llm_calibrate.py` ajusta T con el 70 % más viejo y valida con el 30 % nuevo, sin llamar al modelo (re-escala las probabilidades guardadas). Solo escribe `config/decision-calibration.json` con `--write` y si mejora a T=1. Process Q lee T al arrancar.
