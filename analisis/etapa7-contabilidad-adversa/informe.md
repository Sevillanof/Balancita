# Etapa 7: contabilidad y riesgo ante condiciones adversas (informe generado)

Datos 100 % sintéticos. Generado por `python -m balancita_engine.portfolio_stage7`; no lleva fecha ni nada dependiente del entorno y una prueba exige que coincida con una ejecución nueva. Parámetros de riesgo aprobados sin tocar (`PortfolioPolicy()`). Nada de esto toca el forward, C29-C32, Kronos, Qwen, `capture`, bases activas ni el holdout. Las horas se muestran como `d<días desde 2023-11-15 00:00 UTC> hh:mm:ss`.

## Resumen

15 escenarios, 115 comprobaciones contables independientes, **0 violaciones**.

| Escenario | Capital definitivo | Drawdown | Suspensión | Operaciones | Ajustes | Violaciones | ledger_hash | accounting_digest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s01_gap_long | 985.0060 | 14.9940 | - | 1 | 0 | 0 | 48b3d4962ae8 | 8d61abb0ff92 |
| s02_gap_short | 985.0059 | 14.9941 | - | 1 | 0 | 0 | 77a04e314975 | 1658fa4421e3 |
| s03_stop_sin_gap | 990.0001 | 9.9999 | - | 1 | 0 | 0 | 913356181eb5 | a1bab1b84635 |
| s04_minuto_de_entrada | 989.0339 | 10.9661 | - | 1 | 0 | 0 | 7f862f9775cd | b826c41ee69a |
| s05_cotizaciones_insuficientes | 989.0488 | 10.9512 | - | 1 | 0 | 0 | 48cbee14aa0a | c1091b44340d |
| s06_perdida_superior_a_la_planificada | 985.0060 | 14.9940 | - | 1 | 0 | 0 | 32db6a13bbdc | ed06fa0db9ba |
| s07_suspension_por_perdida_diaria | 969.0607 | 30.9393 | - | 2 | 0 | 0 | e4808734c9b1 | b808b33ea740 |
| s08_suspension_por_drawdown | 935.0119 | 64.9881 | drawdown | 4 | 0 | 0 | 8cd05c68c38c | a5a653d8ca45 |
| s09_funding_tardio | 990.9160 | 10.4905 | - | 2 | 3 | 0 | ae7d210e95e9 | 02ae22772e37 |
| s10_funding_recibido_dos_veces | 991.4066 | 9.9999 | - | 2 | 1 | 0 | 6a9baf73e572 | 157a2e43779c |
| s11_funding_contradictorio | 990.0001 | 9.9999 | - | 2 | 0 | 0 | e7b85b240c27 | feecb05043ca |
| s12_reinicio_y_conciliacion | 990.9160 | 10.4905 | - | 2 | 2 | 0 | 2246a183e03a | c4fc027f8b87 |
| s13_eventos_duplicados_y_desordenados | 989.0339 | 10.9661 | - | 1 | 0 | 0 | f43ae5f74da3 | 9e3b1d988e5e |
| s14_ganancia_con_ejecucion_incierta | 1000.0000 | 0.0000 | - | 1 | 0 | 0 | b2f15cebbc61 | a3f8df1b67bd |
| s15_disputa_de_funding_con_posicion_abierta | 1000.0000 | 0.0000 | - | 1 | 0 | 0 | 896f78e30a63 | 3f2290230f51 |

## Pérdida planificada frente a realizada (stops)

`excedente = realizada - planificada = efecto precio + efecto comisiones + funding` (identidad comprobada por el validador `loss_vs_plan_decomposition`). **Base** dice cómo se justifica el precio de salida: `quote_backed` (cotización observada), `estimated_from_candles` (solo OHLC: estimado), `modelled_at_stop_level` (el stop se ejecuta en su nivel más el coste del modelo; así salía siempre antes).

| Escenario | Operación | Base | Planificada USD | Realizada USD | Excedente | Efecto precio | Efecto comisiones | Funding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s01_gap_long | XBT LONG | estimated_from_candles | 10.00 | 14.99 | 4.99 | 5.00 | 0.00 | 0.00 |
| s02_gap_short | XBT SHORT | estimated_from_candles | 10.00 | 14.99 | 4.99 | 4.99 | 0.00 | 0.00 |
| s03_stop_sin_gap | XBT LONG | modelled_at_stop_level | 10.00 | 10.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| s04_minuto_de_entrada | XBT LONG | quote_backed | 10.00 | 10.97 | 0.97 | 0.97 | 0.00 | 0.00 |
| s05_cotizaciones_insuficientes | XBT LONG | estimated_from_candles | 10.00 | 10.95 | 0.95 | 0.95 | 0.00 | 0.00 |
| s06_perdida_superior_a_la_planificada | XBT LONG | estimated_from_candles | 10.00 | 14.99 | 4.99 | 5.00 | 0.00 | 0.00 |
| s07_suspension_por_perdida_diaria | XBT LONG | estimated_from_candles | 10.00 | 20.94 | 10.94 | 10.94 | -0.01 | 0.00 |
| s07_suspension_por_perdida_diaria | ETH LONG | modelled_at_stop_level | 10.00 | 10.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| s08_suspension_por_drawdown | XBT LONG | estimated_from_candles | 10.00 | 16.66 | 6.66 | 6.66 | 0.00 | 0.00 |
| s08_suspension_por_drawdown | XBT LONG | estimated_from_candles | 9.83 | 16.38 | 6.55 | 6.55 | 0.00 | 0.00 |
| s08_suspension_por_drawdown | XBT LONG | estimated_from_candles | 9.67 | 16.11 | 6.44 | 6.44 | 0.00 | 0.00 |
| s08_suspension_por_drawdown | XBT LONG | estimated_from_candles | 9.51 | 15.84 | 6.33 | 6.33 | 0.00 | 0.00 |
| s09_funding_tardio | ETH LONG | modelled_at_stop_level | 10.00 | 10.49 | 0.49 | 0.00 | 0.00 | 0.49 |
| s10_funding_recibido_dos_veces | ETH LONG | modelled_at_stop_level | 10.00 | 10.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| s11_funding_contradictorio | ETH LONG | modelled_at_stop_level | 10.00 | 10.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| s12_reinicio_y_conciliacion | ETH LONG | modelled_at_stop_level | 10.00 | 10.49 | 0.49 | 0.00 | 0.00 | 0.49 |
| s13_eventos_duplicados_y_desordenados | XBT LONG | quote_backed | 10.00 | 10.97 | 0.97 | 0.97 | 0.00 | 0.00 |

## Gaps: el mismo mercado con cada política de stop

| Escenario | Política | Precio de salida | Pérdida neta USD | Evidencia |
| --- | --- | --- | --- | --- |
| s01_gap_long | level | 97998.24 | 10.00 | stop_level (sin registro: comportamiento anterior) |
| s01_gap_long | gap_open | 96948.25 | 14.99 | ohlc_open_gap |
| s01_gap_long | gap_worst | 96798.26 | 15.71 | ohlc_worst_bound |
| s02_gap_short | level | 102001.84 | 10.00 | stop_level (sin registro: comportamiento anterior) |
| s02_gap_short | gap_open | 103051.85 | 14.99 | ohlc_open_gap |
| s02_gap_short | gap_worst | 103201.86 | 15.71 | ohlc_worst_bound |
| s03_stop_sin_gap | level | 97998.24 | 10.00 | stop_level (sin registro: comportamiento anterior) |
| s03_stop_sin_gap | gap_open | 97998.24 | 10.00 | ohlc_stop_level |
| s03_stop_sin_gap | gap_worst | 97898.24 | 10.48 | ohlc_worst_bound |

`level` es el comportamiento de todos los resultados anteriores y sigue siendo el predeterminado: cierra en el nivel del stop aunque el mercado ya no lo ofreciera. `gap_open` usa la apertura de la vela si abrió más allá del stop. `gap_worst` usa el extremo de la vela (cota pesimista). Ninguna es un precio demostrado; solo una cotización lo es.

## Minuto de entrada

Entrada LONG 12:00:10, la cotización de 12:00:25 atraviesa el stop; la vela del minuto cerraría a las 12:01:00.

|  | Con vigilancia por cotizaciones | Sin vigilancia (etapa 6) |
| --- | --- | --- |
| Cierre | d0 12:00:25 | d0 12:02:00 |
| Segundos desde la entrada | 15 | 110 |
| Precio de salida | 97795.11 | 97498.24 |
| Evidencia | cotización | ohlc_open_gap |
| Pérdida neta USD | 10.97 | 12.38 |

Cuando las cotizaciones no alcanzan:

| Caso | Política | Cobertura de la ventana | Cierre | Evidencia | Pérdida USD | Marcas |
| --- | --- | --- | --- | --- | --- | --- |
| sin_cotizaciones_flag | flag | unwatched | d0 12:02:00 97898.24 | ohlc_open_gap | 10.48 | entry_minute_unresolved |
| sin_cotizaciones_stop | stop | unwatched | d0 12:01:00 97998.24 | assumed_stop_entry_minute | 10.00 | entry_minute_unresolved |
| una_cotizacion_flag | flag | partially_watched | d0 12:02:00 97898.24 | ohlc_open_gap | 10.48 | entry_minute_unresolved |
| cobertura_completa_sin_ruptura | flag | watched | abierta | - | - | - |
| vela_sin_apertura | flag | unwatched | d0 12:02:00 97798.24 | ohlc_worst_bound_open_unavailable | 10.95 | - |

## Pérdida mayor que la planificada y suspensiones

- Planificada 10.00 USD, realizada 14.99 USD (excedente 4.99). Capital 1000 -> 985.006; presupuesto de riesgo siguiente 10.00 -> 9.85006; drawdown 14.994.
- La operación siguiente se dimensiona con el capital nuevo: presupuesto 9.850 USD, pérdida planificada 5.006 USD (límite aplicado: daily_loss_budget).
- Pérdida diaria: una operación planifica 10.00 USD y pierde 20.94 USD (límite diario 20). Suspensión diaria: True. Nueva entrada: suspended_daily_loss. La otra posición se cierra por su stop durante la suspensión (10.00 USD). Al día UTC siguiente: opened.
- Drawdown: día 1: pérdida 16.66 USD, drawdown 16.66; día 2: pérdida 16.38 USD, drawdown 33.04; día 3: pérdida 16.11 USD, drawdown 49.15; día 4: pérdida 15.84 USD, drawdown 64.99. Día 5: suspended_drawdown (límite de drawdown 60; ninguna pérdida diaria llegó a 20).

## Funding tardío: conciliación e idempotencia

| Etapa | Capital definitivo | Ganancia provisional | Presupuesto de riesgo | Drawdown | Ajustes |
| --- | --- | --- | --- | --- | --- |
| cerradas_con_funding_incompleto | 990.0001 | 3.3259 | 9.900 | 9.9999 | 0 |
| btc_cobertura_parcial | 990.0001 | 2.3741 | 9.900 | 9.9999 | 1 |
| btc_y_eth_completos | 990.9160 | 0.0000 | 9.909 | 10.4905 | 3 |

| Ajuste | Operación | Transición | Cobertura | Δ P&L | Δ capital | Capital |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | fed07c8f | provisional_more_covered | 120/181 min | -0.9518 | 0.0000 | 990.0001 -> 990.0001 |
| 2 | a7dad7f0 | provisional_to_definitive | 31/31 min | -0.4906 | -0.4906 | 990.0001 -> 989.5095 |
| 3 | fed07c8f | provisional_to_definitive | 181/181 min | -0.9676 | 1.4065 | 989.5095 -> 990.9160 |

- Repetir la conciliación: 0 ajustes nuevos. Repetir la entrega del mismo funding: {'btc': {'accepted': 0, 'duplicate': 5, 'conflict': 0, 'rejected': 0}, 'eth': {'accepted': 0, 'duplicate': 3, 'conflict': 0, 'rejected': 0}}. `accounting_digest` igual tras repetir: True; el registro de entrada sí anota la repetición: True.
- Una decisión tomada con el capital provisional antes de conciliar (`155e286e`) no se revisa; el ajuste la lista en `decisions_not_revised`.
- Funding recibido dos veces: primera entrega {'accepted': 3, 'duplicate': 0, 'conflict': 0, 'rejected': 0}, segunda {'accepted': 0, 'duplicate': 3, 'conflict': 0, 'rejected': 0}, duplicado dentro de un mismo lote {'accepted': 0, 'duplicate': 6, 'conflict': 0, 'rejected': 0}; funding aplicado 2.871143 USD = una sola vez (2.871143 USD).
- Contradictorio: dos versiones de la misma hora {'accepted': 0, 'duplicate': 0, 'conflict': 2, 'rejected': 0} y una corrección de una hora ya aceptada {'accepted': 0, 'duplicate': 0, 'conflict': 1, 'rejected': 0}: ajustes 0 / 0 / 0; capital 990.0001 -> 990.0001; operaciones marcadas ['funding_conflict'].
- Reinicio (checkpoint con pickle, como `portfolio_offline`): antes de conciliar igual a la ejecución sin caída: True; después de conciliar y repetir: True; ajustes al repetir tras el reinicio: 0.

## Eventos duplicados y fuera de orden

El mismo mercado entregado limpio y sucio (cotizaciones repetidas, antiguas, previas a la entrada, cruzadas, vela del minuto de entrada dos veces, cotización de un minuto ya cubierto por la vela): mismo libro True, misma contabilidad True, un solo cierre True. Ignorados: covered_by_candle, duplicate_entry_minute_candle_ignored, duplicate_or_out_of_order_quote, entry_minute_unresolved, invalid_quote, stop_closed_on_quote.

## Incertidumbre de ejecución y capital utilizable

Un LONG entra a mitad de minuto sin cotizaciones que cubran la ventana y el rango de ese minuto toca el stop; después llega el objetivo. El resultado simulado es **13.7904 USD** y no se altera. La regla anterior habría sumado **13.7904 USD** al capital definitivo; ahora aporta **0 USD** (capital 1000 USD, 13.7904 USD retenidos). Es una dimensión distinta de la del funding: funding completo = True, ejecución sin resolver = True. Avisos de la auditoría: economically_unresolved_execution.

## Disputa de funding con la posición abierta

Un período aceptado y otro contradictorio (cuarentena, nunca aplicado) llegan con la posición abierta; al cerrar, la operación conserva la marca ['funding_conflict'] y los períodos en disputa [[1700035200000, 1700038800000, '0.01']]. Estado del funding: partial (1.90352 USD usados, solo el aceptado).

## Qué está demostrado y qué sigue siendo hipótesis

**Demostrado (datos sintéticos, pruebas deterministas, mismos hashes en cada ejecución):**

- Un stop atravesado por un gap se contabiliza con un precio no mejor que el planificado, con la pérdida completa, en LONG y SHORT, y deja nivel del stop, precio de referencia, precio ejecutable, deslizamiento y evidencia.
- La pérdida mayor que la planificada reduce el capital, el presupuesto de las siguientes operaciones y alimenta el drawdown, sin recortarse; las suspensiones frenan entradas y no cierres ni conciliaciones.
- La vigilancia por cotizaciones cierra una vez, solo con cotizaciones posteriores a la entrada, sin doble proceso con las velas, y declara incertidumbre cuando no hay datos.
- La conciliación de funding es idempotente, distingue parcial de completo, no aplica dos veces el mismo funding, deja historial encadenado y no revisa decisiones pasadas; los datos contradictorios no se aplican.
- Los validadores independientes detectan errores contables introducidos a propósito (ver las pruebas).

**Sigue siendo hipótesis o límite:**

- Que `gap_open` o `gap_worst` representen lo que habría pasado en Kraken: son estimaciones desde velas. Solo una cotización real demuestra un precio ejecutable, y ninguna está medida aquí.
- Que 10 s de hueco máximo, la política `flag`/`stop` o el coste del modelo en un gap sean razonables: hipótesis iniciales, no medidas ni aprobadas.
- Que el stop se ejecute en la primera cotización que lo cruza sin latencia propia ni profundidad de libro.
- Nada de esto está conectado al forward ni valida rentabilidad alguna.

