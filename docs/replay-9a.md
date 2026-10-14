# Etapa 9A: replay histórico aislado con ejecución modelada

Prueba de integración y reproducibilidad del motor existente contra velas y funding públicos de Kraken. **No es evidencia de rentabilidad independiente**: las velas ya se usaron en investigación previa y toda ejecución es `MODELLED_EXECUTION` (no existe bid/ask histórico).

## Qué hay

| Módulo                | Qué hace                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replay_data.py`      | Puerta de datos: `mode=ro`, `PRAGMA query_only=ON`, rango fijo `2025-10-13 <= t < 2026-08-02` (el periodo reservado no se lee), consultas acotadas, verificación de series     |
| `replay_execution.py` | `ModelledExecutor`: llena órdenes con un precio de vela fechado en el instante del fill; nunca crea `QuoteWatch` ni cotizaciones                                               |
| `replay_specs.py`     | C29, C30 y C32 desde sus archivos `config/strategies/*.json`, con el intérprete declarativo existente (`propose_spec`), sin reimplementar ni aproximar; hashes de spec fijados |
| `replay_compare.py`   | Comparación entre escenarios: señales, órdenes, trades y trayectoria, por separado                                                                                             |
| `replay_driver.py`    | Genera los eventos (velas, funding, ciclos, precios modelados), corre el `PaperRunner` en `execution_mode="modelled"` y escribe `results.json` una sola vez                    |
| `paper_runner.py`     | Solo agrega `execution_mode` (por defecto `quotes`, idéntico a 8A-8C), el evento `modelled_price` y el rechazo de `quote` en modo modelado                                     |

No hay segundo motor: decisión, tamaño, costes, funding y contabilidad son `Portfolio`, `Book` y `futures_costs`, sin cambios.

## Estrategias congeladas (A1)

La corrida usa C29, C30 y C32 tal como están congeladas (`strategy_set=frozen`, por defecto). `SpecSignalStrategy` entrega el cuadro del ciclo a `propose_spec` (el mismo intérprete del forward) y traduce la propuesta al contrato de señales del runner. Un spec editado, con otro hash que el fijado en `FROZEN_SPEC_HASHES`, no carga. Los `mx-*` quedan solo como fixtures (`strategy_set=mx`).

Paridad demostrada (tests): para las mismas velas cerradas y el mismo instante de evaluación, acción, dirección, precio de referencia, indicadores (ATR, logret, logvol, `fundpct`), stop, objetivo (a menos de un tick), horizonte, códigos de razón, condiciones e identidad de estrategia coinciden con `futures_simulator.frames` + `propose_spec`.

Paridad **no** reclamada, por diseño: el forward evalúa cada vela de 1 min con un libro independiente de 100 USD por estrategia; el replay decide en el último minuto de cada barra de 5 min y comparte una cartera (un trade bloquea al siguiente, el capital es común). Las señales son comparables, los trades no. La cartera compartida es un experimento aislado; el régimen del forward sigue siendo 100 USD fijos por trade (ADR 0001) y este replay no lo reemplaza.

**Alcance de la paridad:** es paridad del camino de código (mismo intérprete e indicadores sobre las mismas velas), no contraste con resultados reales del forward: el forward empezó en octubre, dentro del periodo reservado, y no puede compararse en la ventana autorizada. Los trades del replay (una posición por producto, cartera compartida) no son comparables con los libros de 100 USD del forward.

## Funding: aislamiento y causalidad (A2, A3)

La respuesta guardada de Kraken contiene un año de horas, incluidas las reservadas. `relative_funding` ya no usa funciones JSON de SQLite: lee la respuesta como flujo en trozos de 4 KiB, interpreta solo hasta el primer periodo con inicio `>=` 2026-08-02 y se detiene ahí. Ningún dato reservado llega al experimento: a lo sumo el primer periodo reservado se parsea para detectar el límite y se descarta, y nada posterior se lee (canario: una respuesta con basura tras el tope se lee igual). Se usa siempre `relativeFundingRate`, nunca se convierte la tasa absoluta. Respuestas: la más vieja y las dos más nuevas, igual que el forward. Límite residual declarado: a lo sumo un bloque (4 KiB) y un período más allá del tope se decodifican y parsean para detectar el límite, y se descartan; SQLite carga el valor almacenado en memoria (con Python >= 3.11 se usa `blobopen` y se lee incrementalmente); el manifest registra el lector, los bytes leídos y el instante donde se detuvo.

- Una hora llega a `inicio + 1 h + 10 min`; una hora ausente es desconocida, nunca 0.
- Decisión de Fran (14-oct): se reproduce exactamente el cálculo vigente de C32 (`FundingContext.percentile()`, sin modificar ni reimplementar) y se expone su incertidumbre. El carry-forward no queda aprobado como política definitiva.
- Auditoría por evaluación (`funding_audit.jsonl`, con hash en `results.json`): hora de decisión, última hora usada y su antigüedad, horas faltantes, registros usados, duración real de la ventana, si hubo carry-forward (y su causa: `data_gap`; una hora aún en espera de publicación se marca aparte, no es carry-forward), percentil del forward y si la señal dependió de evidencia incompleta.
- Lectura estricta independiente, solo diagnóstico (`replay_funding_audit.py`): exige la última hora elegible presente y 720 horas naturales consecutivas, sin tratar horas desconocidas como cero ni arrastrar tasas; si falta evidencia devuelve `unknown`, nunca una señal alternativa. No altera decisiones, trades, P&L ni contabilidad. `funding_diagnostics.audit` informa evaluaciones, carry-forward, ventanas incompletas, señales originales que desaparecen, señales adicionales o distintas y porcentaje de divergencia. No es evidencia de rentabilidad.
- Paridad de fuentes: un test compara, sobre una base sintética con revisiones distintas, los periodos que lee el forward (`load_periods`) con los del replay (misma selección: la respuesta más vieja y las dos más nuevas, primera vista gana).

## Política de ventana (A6)

`window_policy`: `cut_decisions_24h_before_end` (por defecto; las decisiones paran 24 h antes del fin de los datos y lo que quede abierto se informa, no se cierra) o `decide_until_data_end` (se decide hasta el fin de los datos; las posiciones abiertas salen como `open_at_window_end`, nunca se cierran con precios posteriores). La política queda en el manifest y en `results.json`.

## Comparación de escenarios (A5)

`python -m balancita_engine.replay_compare SALIDA.json DIR1 DIR2 ...` separa: señales idénticas, decisiones comparables, órdenes divergentes, trades que existen solo en algunos escenarios, diferencias de ejecución de oportunidades comparables y trayectoria global (la diferencia de P&L se parte en trades comparables, solo del escenario y solo de la base). No se atribuye todo el cambio al slippage ni se supone un orden entre escenarios. `S0` es contrafactual; `S2` es estrés no causal.

## Evidencia (A7)

Las velas OHLC no son cotizaciones: ninguna operación se clasifica como observada. Cada trade lleva `evidence_class`: `estimated_by_ohlc` (stop, objetivo o cierre inferidos de velas) o `uncertain_entry_minute_stop` (stop asumido dentro del minuto de entrada: el extremo puede haber ocurrido antes del fill).

## Reglas temporales (por regla, no por `known_at` del backfill)

- La vela 1 m `b` llega en `b + 60 s + 2 s`; el ciclo de la barra 5 m que cierra en `c` llega en `c + 2 s`, después de la vela.
- El funding de la hora `[s, s+1h)` llega en `s + 1 h + 10 min`. Una hora ausente es desconocida, no 0.
- Escenarios de ejecución (sensibilidad, no observaciones): `S0` contrafactual, apertura de la vela donde cierra la decisión (un precio anterior a la entrega de la decisión); `S1` (base) apertura de la vela siguiente; `S2` extremo adverso de la vela de entrada (estrés, no causal); `S3` = `S1` más un impacto adicional del producto.
- La vela del minuto de entrada la resuelve el ejecutor: si su rango toca el stop, cierra en el stop con evidencia `assumed_stop_entry_minute` (estimada); un objetivo tocado se ignora.

## Uso

```
PYTHONPATH=python python3 -m balancita_engine.replay_driver \
  --candles-db <market.sqlite> --funding-db <market.sqlite> --products PF_XBTUSD \
  --decision-start 2026-03-01 --decision-end 2026-03-08 --scenario S1 --out <directorio-nuevo>
```

`--strategy-set frozen|mx` y `--window-policy` completan las opciones. Solo lectura sobre las bases; escribe únicamente en `--out`. Se niega a arrancar si hay huecos de velas 1 m en la ventana de decisión (salvo `--allow-gaps`, que queda declarado en el manifest), revisiones conflictivas, OHLC inválido o una ventana fuera de rango.

## Limitaciones

Stop con evidencia OHLC (estimada); parámetros de ejecución, riesgo y sizing son hipótesis no aprobadas; "funding conocido al inicio de la hora" es una hipótesis no probada (por eso el retraso de 10 min); `S2` usa información posterior al fill.
