# tope-por-lugar

Con el analista «fuerte» (×1,5) cada posición pedía 49,5 % del saldo y el tercer lugar quedaba con un resto de ~10 US$. El tamaño de cada posición tiene un tope por lugar.

## Specs

- **S1** — Tamaño de cada posición = saldo × `posiciones.fraccion` × multiplicador del analista, **con tope en `posiciones.fraccion` × saldo** (un lugar). Con la config activa (33 %): fuerte = 33 %, normal = 33 %, flojo = 16,5 %. Así siempre entran los 3 lugares.
- **S2** — Aplica igual en la Terminal en vivo y en el backtest de Estrategias (mismo código); nada más del dimensionamiento cambia (rebotes, máximo de posiciones, saldo libre).
- **S3** — Las operaciones ya abiertas no se tocan; rige para las entradas nuevas.

## Tasks

| ID  | Specs | Ruta                                                               | Estado    | Commit |
| --- | ----- | ------------------------------------------------------------------ | --------- | ------ |
| T1  | S1-S3 | worker: trader (dimensionamiento) + tests + docs                   | pendiente | —      |
| T2  | S1-S3 | verificación independiente (riesgo alto: cambia el trader en vivo) | pendiente | —      |

## Log

- **L1** (usuario, 2026-11-06): «1. El calculo tiene que tener en cuenta el 1,5»
- **L2** (usuario, elección): «Tope por lugar: máximo 33 % aunque sea ×1,5» (Fuerte: min(49,5 %, 33 %) = 33 %; Normal: 33 %; Flojo: 16,5 %).
- **L3** (evidencia): vivo trade 3 = 998,675 × 0,33 × 1,5 = 494,34 US$; trades 5 y 11 ≈ 10 US$ (tercer lugar con el resto). Ver `odd/tasks/estrategias-laboratorio-auditoria.md`.
- **L4** (evidencia): backtest feb–abr antes/después: oficial 97,70 → 87,81 US$, nocional 9–617 → 167–403 US$, operaciones < 50 US$ 22 → 0; variante 30 h 53,63 → 59,19 US$. El `config_hash` no cambia (sin subir STATE_VERSION): antes y después solo se distinguen por fecha.
- **L5** (verificación): el verificador independiente dio «unavailable» tres veces; revisión del orquestador: el cambio es una sola condición en `Trader._open`; `analista.sized` (×1,5) solo se usa en el examen/walkforward offline (`futures_qwen_trader_exam.py:164`, `futures_walkforward.py:397`), no en la Terminal ni en el replay de Estrategias.
