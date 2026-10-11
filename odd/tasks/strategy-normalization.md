# Normalizar las estrategias (NS-01..NS-06)

Pedido de Fran (2026-10-11): todas las estrategias funcionan igual, tienen los mismos parámetros y se modifican de la misma forma. Restricción: no se toca el comportamiento de C25-C31 ni Kronos hasta 100 operaciones (ADR 0001); cada paso se demuestra con tests de igualdad y los libros en paper siguen intactos.

## Inventario (estado en main @ 9c98383)

| | Dónde se define | Parámetros | Entrada / salida | Edición | Dónde se ve |
|---|---|---|---|---|---|
| C25-C28 | **dos veces**: `futures_strategies.propose()` (constantes en código) y `config/strategies/*.json` (spec) | en el spec: `params`, `risk`, `horizon_minutes`; en `propose`: fijos | live D y verdictos usan `propose`; Lab, replay, forward y backtest usan el spec. Time stop de D global (30 min) | por spec en el registro (modificar / nueva); `propose` no se edita | Lab, Terminal, D |
| C29, C30 | solo spec | `params`, `indicators`, `risk.vol`, horizonte 24 h / 12 h | solo simulador `Book` (no están en D); C30 se mide con `futures_forward.py` desde `config/forward-strategies.json` (manual) | registro | Lab, replay, forward |
| Creadas en /estrategias | spec en SQLite del registro (versiones, estados) | los del spec | solo backtest/replay; "active" no las hace operar en vivo | registro (modificar, nueva, variantes) | Lab |
| C31 | `futures_qwen_exit.py` + `config/qwen-exit.json` | `entry_specs`, `notional_usd`; sin stop/objetivo/tiempo | entra por consenso de specs, Qwen decide hold/close (`QwenExitBook`) | editar JSON y reiniciar | resumen JSON, Lab |
| Qwen (entrada) | `futures_llm_decisions`, `DecisionBook` en replay | stop 1,5 ATR, ratio 2, 30 min fijos en el libro | decide buy/hold/sell | prompts y config | Lab, replay |
| Kronos | constantes en `python/kronos_lab/lab.py` | `HORIZON=4h`, `K=2.0`, `NOTIONAL=100`, sin stop/objetivo | liquidación propia (`settle`) | editar el código | Lab (formato Qwen) |

Divergencias a cerrar: (1) C25-C28 duplicadas; (2) tres caminos de ejecución (D por tickers, `Book` por velas, Kronos propio); (3) tamaño, costes y productos no son campos de ningún spec; (4) los modelos no tienen forma de spec; (5) "active" no significa "opera"; (6) el inicio forward de C30 se registra a mano.

## Molde común

Un plan explícito por estrategia (`futures_strategy_plan.py`): señal (`rules` | `regime_adapter` | `model`), entrada, salida (stop en ATR o sigmas, objetivo como múltiplo del stop, tiempo, regla propia por lado), tamaño, productos y costes. Los valores por defecto se resuelven al leer; **nunca se escriben en el JSON**, porque `spec_hash` ata la fiabilidad y las operaciones forward de C29/C30.

## Pasos

- **NS-01 (hecho)**: `strategy_plan()` de solo lectura para specs, C31 y Kronos; tests: hashes de C25-C30 congelados, entrada no mutada, time stop = 30 min de D, mismos campos para todas.
- NS-02: ver el plan en /estrategias igual para todas (endpoint del registro + panel).
- NS-03: guarda "congelada hasta 100 operaciones" en el registro para C25-C31 y Kronos (solo "crear nueva").
- NS-04: descriptores de modelo `balancita-model.v1` en `config/models/` (Qwen, Kronos) con test de igualdad contra las constantes; sin reiniciar procesos.
- NS-05: `propose` -> `propose_spec` en verdictos y D, solo si un replay real da el mismo `verdict_hash` y las mismas operaciones (incluidas salidas con niveles congelados, C27 sin nivel y `cost_config`).
- NS-06: estado explícito `forward` con `start_ms` inmutable; migrar C30 copiando su entrada exacta y retirar el JSON manual al pasar el test. Coordinar con el hilo de recuperación de huecos (toca `futures_forward.py`).
