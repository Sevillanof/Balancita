# Validación integral offline de la cartera compartida de 1.000 USD

Solo datos sintéticos. Sin forward, Kronos, Qwen, `capture`, colectores, bases activas ni holdout. Sin órdenes reales ni credenciales. Parámetros de riesgo aprobados, sin cambios (`PortfolioPolicy` por defecto, hash `8c22a0c0143c697c`); modelo de costes `af5187f6c6a1…`.

## Resumen

| Escenario | Eventos | Abiertas | Rechazadas | Cierres verificados | Cierres provisionales | Capital definitivo | Violaciones/comprobaciones | Diario íntegro |
|---|---|---|---|---|---|---|---|---|
| s1_posiciones_simultaneas | 658 | 4 | 3 | 4 | 0 | 1013.9263 | 0/16 | sí |
| s2_perdidas_consecutivas | 805 | 4 | 1 | 4 | 0 | 980.0009 | 0/14 | sí |
| s3_duplicados_y_orden | 372 | 2 | 5 | 2 | 0 | 1003.1766 | 0/12 | sí |
| s4_funding_incompleto | 724 | 4 | 0 | 1 | 3 | 1000.3985 | 0/13 | sí |
| s5_integral_reinicio_replay_log | 2116 | 9 | 6 | 8 | 1 | 996.0993 | 0/34 | sí |
| s5_integral_reinicio_live_gap | 2116 | 8 | 6 | 7 | 1 | 1006.0243 | 0/31 | sí |

**0 violaciones de invariantes en 120 comprobaciones.** Cada comprobación recalcula el límite o la identidad contable desde las operaciones y posiciones crudas, no desde el código de límites de `portfolio.py`.

## Qué significa «verificado» y «provisional»

- **Verificado**: operación cerrada con funding completo para todo el tiempo mantenido y producto con costes medidos. Su P&L neto entra en el capital definitivo, y la identidad `bruto − comisiones − funding = P&L` se recalcula aparte. «Verificado» quiere decir que la aritmética del simulador cuadra con la tabla de funding **sintética** de cada escenario; no dice nada sobre el mercado real.
- **Provisional**: funding parcial o ausente. El P&L parcial se informa aparte. Una **ganancia provisional no suma capital ni presupuesto de riesgo**; una **pérdida provisional sí resta** (criterio conservador del prototipo). Su valor definitivo sigue desconocido.
- **No realizado**: posiciones abiertas al final. Siempre provisional.

El funding no se infiere: una operación sin cobertura queda con `funding_usd = null` y `net_usd = null`. No existe hoy un mecanismo para reclasificarla cuando el funding llegue (ver capacidades).

## Capacidades de recuperación: qué existe y qué falta

| Capacidad | Estado | Dónde / qué falta |
|---|---|---|
| Idempotencia de intenciones y señales (`intent_id`, `signal_id`, lotes) | existe | `portfolio.py`; vive solo en memoria: se pierde al reiniciar si no se restaura estado |
| Orden temporal (decisión retroactiva, vela no más nueva, datos del futuro) | existe | `portfolio.py`; también en memoria |
| Idempotencia de **eventos** (misma vela o señal entregada dos veces, vela conflictiva o tardía) | nuevo, solo en el ejecutor offline | `portfolio_offline.py`; no existe en el forward para la cartera |
| **1. Recuperación desde checkpoint persistido** (digest, huella de configuración, digest canónico del estado) | nuevo, **demostrado entre dos procesos Python** | `portfolio_offline` + `portfolio_two_process`. Mismo patrón que `multi_experiment` (pickle + digest + fingerprint). `Portfolio` no tiene guardado propio ni hay persistencia en el forward |
| **2. Recuperación del diario desde disco** (JSONL, fsync por entrada, cadena de hashes) | nuevo, **demostrado entre dos procesos Python** | Ausente, vacío, alterado, con basura, con la cola cortada, reordenado, truncado o de otro escenario: rechazado (ver matriz). Falta decidir dónde vive y quién lo escribe en producción |
| Escritura atómica del checkpoint (temporal + fsync + rename) | nuevo, probado con archivo temporal | Sin probar corrupción parcial más allá del digest |
| **3. Reproducción de señales desde una fuente durable** | **pendiente para el forward** | Las velas sí se guardan (`capture`); las **señales** no tienen registro durable para la cartera. En la prueba de dos procesos las entradas se reconstruyen desde la definición del escenario: es un sustituto, no una fuente real |
| Recuperar señales generadas mientras el proceso estaba caído | **falta** (consecuencia del punto 3) | Se pierden (escenario `live_gap`, también entre dos procesos); el sistema ni siquiera puede detectar que faltan |
| Recuperar velas perdidas durante la caída | existe en el forward (`futures_forward`: relleno de huecos, etiqueta `recovered`) | No está conectado a la cartera; aquí se simula con velas reentregadas en orden |
| Checkpoint/restauración de libros del experimento multiestrategia (100 USD fijos) | existe | `multi_experiment` + `multi_store`; no cubre `Portfolio` |
| Reconciliar funding de una operación ya cerrada cuando llega tarde | existe para el forward (`futures_funding_reconcile`) | **Falta** para la cartera: una operación `net_complete=false` queda así y no se reclasifica ni reabre el capital definitivo |
| Primer precio ejecutable posterior a la señal | **falta** | El módulo abre al precio de la intención (cierre de la vela de la señal) más impacto; conectarlo al forward lo exige |
| Huecos de precio sobre el stop | **falta** en el simulador | `Book` sale siempre al precio del stop; un hueco no empeora la pérdida modelada |
| Verificación independiente de límites y de la contabilidad | nuevo | `portfolio_offline._check_*` recalcula desde operaciones y posiciones crudas |

**Un reinicio solo cuenta como recuperación si se restaura un estado persistido.** Volver a ejecutar el escenario desde el principio no lo es. `OfflineExecutor.restore` y `Journal.load` fallan, sin alternativa silenciosa, con `no_checkpoint`, `corrupt_checkpoint`, `configuration_changed`, `journal_missing`, `journal_corrupt`, `journal_incompatible`, `journal_mismatch`, `journal_chain_broken` o `state_mismatch`.

### Prueba entre dos procesos Python independientes

El primer proceso escribe checkpoint y diario en disco y termina por completo. El segundo, un intérprete nuevo, recupera ambos desde disco, restaura, se pone al día y completa el escenario; no comparte memoria con el primero. Se compara con una ejecución ininterrumpida.

| Modo | Libro igual | Estado igual | Velas igual | Posiciones iguales | Capital igual | Diario igual a 1 proceso | Diario en disco verifica |
|---|---|---|---|---|---|---|---|
| replay_log | sí | sí | sí | sí | sí | sí | sí |
| live_gap | NO | NO | sí | sí | NO | sí | sí |

`replay_log` es equivalente porque las entradas se vuelven a entregar completas. `live_gap` **debe seguir difiriendo**: las señales emitidas durante la caída no existen para el proceso nuevo, y que difiera es lo que demuestra que perderlas cambia el resultado. Al final de estos escenarios no queda ninguna posición abierta, así que «posiciones iguales» es trivial al cierre; que el checkpoint se tomó con una posición abierta y la restauración la reproduce exactamente lo comprueba `test_the_checkpoint_was_taken_with_a_position_open`.

**Rechazos: ningún archivo ausente, corrupto o ajeno se recupera en silencio.** Cada caso es un proceso nuevo sobre archivos saboteados; ninguno escribió resultado.

| Caso | Qué se estropeó | Motivo del rechazo | Rechazado sin resultado |
|---|---|---|---|
| diario_ausente | el archivo del diario no existe | journal_missing | sí |
| diario_vacio | el archivo existe pero está vacío | journal_missing | sí |
| diario_con_entrada_alterada | una entrada editada (la cadena de hashes ya no cierra) | journal_corrupt | sí |
| diario_con_linea_basura | una línea que no es JSON | journal_corrupt | sí |
| diario_con_cola_cortada | la última línea cortada a la mitad (escritura interrumpida) | journal_corrupt | sí |
| diario_reordenado | dos entradas intercambiadas | journal_corrupt | sí |
| diario_truncado_valido | prefijo válido de la cadena, más corto que la posición del checkpoint | journal_mismatch | sí |
| diario_de_otro_escenario | diario válido pero escrito para otro escenario | journal_incompatible | sí |
| checkpoint_ausente | no hay checkpoint | no_checkpoint | sí |
| checkpoint_alterado | un byte del checkpoint cambiado | corrupt_checkpoint | sí |

## s1_posiciones_simultaneas

Cinco productos, tres estrategias, LONG y SHORT a la vez; los límites recortan o rechazan lo que sobra.

| Qué | Valor |
|---|---|
| Hash del escenario | `50e3b6b81099adb01d3bb495dce62271aa1c117d027c0548e4d150567c095cec` |
| Hash de las velas aplicadas | `4402109835fa2bfe49c12fc433eb61c193400cd548b64432eb18996bd3bef8f3` |
| Hash del libro (decisiones + operaciones) | `4d544daf3d6a69f002b87d8da584d84b6393289e6300078062374a0bb4877209` |
| Digest del estado final | `266740fcd0ec0c38ffe74141aca2ec4f51eddf4b242c75d60e7b62d0bad9bcef` |
| Hash del diario (29 entradas, cadena íntegra: sí) | `36724f84cf71eec6a07f102b5eebd39e3c3d349894c4e3cb51349d23d85d12cc` |

**Contabilidad verificada**: 4 operaciones, P&L neto +13.93 USD (comisiones 1.500710 USD, funding -0.00735 USD).

**Provisional**: 0 operaciones con funding completo, P&L parcial +0.00 USD; ganancias excluidas del capital 0 USD; pérdidas incluidas 0 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 1013.9263 USD · **equity** (con ganancias provisionales) 1013.9263 USD · rechazos por motivo: contradictory_signals ×2, insufficient_margin ×1.

### Registro cronológico (selección; completo en `journals/s1_posiciones_simultaneas.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 14 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 2.0113 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 15 | m+006 | ABRE | PF_ETHUSD SHORT | nocional 474.17 · pérdida plan. 9.9998 de presupuesto 10.00 · límites: ninguno | capital 1000 |
| 16 | m+006 | ABRE | PF_SOLUSD LONG | nocional 25.83 · pérdida plan. 1.0627 de presupuesto 10.00 · límites: gross_limit, margin | capital 1000 |
| 17 | m+006 | RECHAZA | PF_ADAUSD SHORT | contradictory_signals |  |
| 18 | m+006 | RECHAZA | PF_ADAUSD LONG | contradictory_signals |  |
| 19 | m+006 | RECHAZA | PF_XRPUSD SHORT | insufficient_margin |  |
| 20 | m+022 | CIERRA | PF_SOLUSD LONG | stop · P&L -1.06 (bruto -1.04, comisiones 0.0253, funding 0.000138) · verified / funding complete | capital 1000 → 998.9371 |
| 21 | m+032 | CIERRA | PF_XBTUSD LONG | target · P&L +1.74 (bruto +2.25, comisiones 0.5011, funding 0.004333) · verified / funding complete | capital 998.9371 → 1000.6788 |
| 22 | m+038 | CIERRA | PF_ETHUSD SHORT | target · P&L +13.76 (bruto +14.22, comisiones 0.4670, funding -0.005058) · verified / funding complete | capital 1000.6788 → 1014.4343 |
| 26 | m+071 | intent_not_built |  | no valid protective levels from price/ATR |  |
| 27 | m+071 | ABRE | PF_XBTUSD SHORT | nocional 507.21 · pérdida plan. 2.5352 de presupuesto 10.144 · límites: product_limit | capital 1014.4343 |
| 28 | m+111 | CIERRA | PF_XBTUSD SHORT | time_stop · P&L -0.51 (bruto -0.01, comisiones 0.5072, funding -0.006763) · verified / funding complete | capital 1014.4343 → 1013.9263 |

## s2_perdidas_consecutivas

Cuatro stops seguidos: el capital baja, el presupuesto de 1 % baja con él y la pérdida diaria suspende nuevas entradas.

| Qué | Valor |
|---|---|
| Hash del escenario | `a2f241b4d273342feed3cc0460e51916c2e9435a389768ddee76d1cce4195495` |
| Hash de las velas aplicadas | `9f4f137d4020daecab78fdb36b10791e4b22dc83eea30300e9c33a7deb9bee00` |
| Hash del libro (decisiones + operaciones) | `681bfc013771ac8def9aee11cf745db7e09b54c83905bcfb9b701795bb86e67a` |
| Digest del estado final | `f73b0f824ff389ba853f9130ca6c927a6b60e8b047dd74f1948a92add6d47a0f` |
| Hash del diario (21 entradas, cadena íntegra: sí) | `9053dcca6f8c4cccf788d3ec9f1625d0d255696673a8cc088e883d37fb689f3d` |

**Contabilidad verificada**: 4 operaciones, P&L neto -20.00 USD (comisiones 1.460990 USD, funding 0.002914 USD).

**Provisional**: 0 operaciones con funding completo, P&L parcial +0.00 USD; ganancias excluidas del capital 0 USD; pérdidas incluidas 0 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 980.0009 USD · **equity** (con ganancias provisionales) 980.0009 USD · rechazos por motivo: daily_loss_budget ×1.

### Registro cronológico (selección; completo en `journals/s2_perdidas_consecutivas.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 4 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 4.5103 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 5 | m+015 | CIERRA | PF_XBTUSD LONG | stop · P&L -4.51 (bruto -4.01, comisiones 0.4979, funding 0.0015) · verified / funding complete | capital 1000 → 995.4882 |
| 8 | m+036 | ABRE | PF_ETHUSD LONG | nocional 416.22 · pérdida plan. 9.9547 de presupuesto 9.9548 · límites: ninguno | capital 995.4882 |
| 9 | m+053 | CIERRA | PF_ETHUSD LONG | stop · P&L -9.96 (bruto -9.54, comisiones 0.4114, funding 0.002359) · verified / funding complete | capital 995.4882 → 985.5311 |
| 14 | m+066 | ABRE | PF_XBTUSD SHORT | nocional 492.76 · pérdida plan. 3.5225 de presupuesto 9.8553 · límites: product_limit | capital 985.5311 |
| 15 | m+066 | ABRE | PF_SOLUSD LONG | nocional 58.25 · pérdida plan. 2.0085 de presupuesto 9.8553 · límites: daily_loss_budget | capital 985.5311 |
| 16 | m+074 | CIERRA | PF_XBTUSD SHORT | stop · P&L -3.52 (bruto -3.03, comisiones 0.4942, funding -0.001314) · verified / funding complete | capital 985.5311 → 982.0098 |
| 17 | m+085 | CIERRA | PF_SOLUSD LONG | stop · P&L -2.01 (bruto -1.95, comisiones 0.0572, funding 0.000369) · verified / funding complete | capital 982.0098 → 980.0009 |
| 20 | m+101 | RECHAZA | PF_XRPUSD LONG | daily_loss_budget |  |

## s3_duplicados_y_orden

Eventos repetidos, versiones contradictorias de una señal, señal vencida y falsificada, vela duplicada, conflictiva, tardía y faltante.

| Qué | Valor |
|---|---|
| Hash del escenario | `b58a7744622061c2d94ad3423c83efa6d8c54f6723a715ee0ec20341cc7dd4bf` |
| Hash de las velas aplicadas | `d626bcc92c062e0c73a932ea34c1e0ee52bac9770babe57a08e8ef3be328aab1` |
| Hash del libro (decisiones + operaciones) | `5ef6ee718d069f9097b23c9196dcc4bd6b9d5bcdb1684796b13a9d9bdb3ac103` |
| Digest del estado final | `fd37902bd01779598a978eb8301c2b05318564618379d6f618e368ade4a23438` |
| Hash del diario (32 entradas, cadena íntegra: sí) | `8228313c27c526cd62a7647712cb01d7d4f509fc9a8f24b5cd4a9819cb241faa` |

**Contabilidad verificada**: 2 operaciones, P&L neto +3.18 USD (comisiones 0.930111 USD, funding 0.016394 USD).

**Provisional**: 0 operaciones con funding completo, P&L parcial +0.00 USD; ganancias excluidas del capital 0 USD; pérdidas incluidas 0 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 1003.1766 USD · **equity** (con ganancias provisionales) 1003.1766 USD · rechazos por motivo: duplicate_intent ×1, duplicate_signal ×1, inconsistent_signal ×2, position_already_open ×1, retroactive_intent ×3, stale_data ×1.

### Registro cronológico (selección; completo en `journals/s3_duplicados_y_orden.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 4 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 2.5093 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 5 | m+006 | duplicate_events_ignored |  | 1 eventos ya vistos |  |
| 8 | m+007 | RECHAZA | PF_XBTUSD LONG | retroactive_intent, duplicate_intent |  |
| 15 | m+009 | RECHAZA | PF_ETHUSD LONG | inconsistent_signal |  |
| 16 | m+009 | RECHAZA | PF_ETHUSD LONG | inconsistent_signal |  |
| 17 | m+009 | RECHAZA | PF_XBTUSD LONG | retroactive_intent, duplicate_signal |  |
| 20 | m+013 | signal_invalid |  | firma no coincide con el contenido |  |
| 21 | m+013 | ABRE | PF_SOLUSD LONG | nocional 428.05 · pérdida plan. 9.9999 de presupuesto 10.00 · límites: ninguno | capital 1000 |
| 22 | m+021 | duplicate_candle_ignored | PF_XBTUSD | misma vela repetida |  |
| 23 | m+021 | duplicate_events_ignored |  | 1 eventos ya vistos |  |
| 24 | m+022 | conflicting_candle_rejected | PF_XBTUSD | misma vela con otro contenido: gana la primera |  |
| 25 | m+032 | candle_gap | PF_XBTUSD | faltan 1 minutos |  |
| 28 | m+036 | RECHAZA | PF_SOLUSD LONG | retroactive_intent, stale_data, position_already_open |  |
| 29 | m+050 | late_candle_refused | PF_XBTUSD | vela anterior a la última procesada |  |
| 30 | m+053 | CIERRA | PF_XBTUSD LONG | target · P&L +2.49 (bruto +2.99, comisiones 0.5014, funding 0.007833) · verified / funding complete | capital 1000 → 1002.4853 |
| 31 | m+073 | CIERRA | PF_SOLUSD LONG | time_stop · P&L +0.69 (bruto +1.13, comisiones 0.4286, funding 0.008561) · verified / funding complete | capital 1002.4853 → 1003.1766 |

## s4_funding_incompleto

Funding completo, parcial y ausente en tres operaciones: lo verificado se separa de lo provisional.

| Qué | Valor |
|---|---|
| Hash del escenario | `3e1874d3bc3e1ad5b645e9976386113a6d1ce3d9ac15e084631026c49610662a` |
| Hash de las velas aplicadas | `f5cfd24792dbe26fa6aae73d93b04b8e07049710fe5e5f0a93253437825b82ce` |
| Hash del libro (decisiones + operaciones) | `44b94b6e45877568b3626c595460c98ef466e5fd9a3ea4002a31aa675c34b9e3` |
| Digest del estado final | `f063a530858245328f79b00d5191c0d43a9e683d7fc734f020fc927e231b03b1` |
| Hash del diario (18 entradas, cadena íntegra: sí) | `7a87119b71eed82666c4d5bf55b233b902b7c71ecc0d051b6b7518aab2546dea` |

**Contabilidad verificada**: 1 operaciones, P&L neto +3.24 USD (comisiones 0.501874 USD, funding 0.003 USD).

**Provisional**: 3 operaciones con funding partial/unknown, P&L parcial +25.06 USD; ganancias excluidas del capital 27.9037 USD; pérdidas incluidas -2.8438 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 1000.3985 USD · **equity** (con ganancias provisionales) 1028.3022 USD · rechazos por motivo: ninguno.

### Registro cronológico (selección; completo en `journals/s4_funding_incompleto.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 8 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 3.0108 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 9 | m+006 | ABRE | PF_ETHUSD SHORT | nocional 417.52 · pérdida plan. 9.9999 de presupuesto 10.00 · límites: ninguno | capital 1000 |
| 10 | m+006 | ABRE | PF_SOLUSD LONG | nocional 82.48 · pérdida plan. 2.8438 de presupuesto 10.00 · límites: gross_limit, margin | capital 1000 |
| 11 | m+024 | CIERRA | PF_XBTUSD LONG | target · P&L +3.24 (bruto +3.75, comisiones 0.5018, funding 0.003) · verified / funding complete | capital 1000 → 1003.2423 |
| 12 | m+028 | CIERRA | PF_ETHUSD SHORT | target · P&L +13.90 (bruto +14.31, comisiones 0.4103, funding -0.001948) · provisional / funding partial | capital 1003.2423 → 1003.2423 |
| 13 | m+029 | CIERRA | PF_SOLUSD LONG | stop · P&L -2.84 (bruto -2.76, comisiones 0.0810, funding sin dato) · provisional / funding unknown | capital 1003.2423 → 1000.3985 |
| 16 | m+036 | ABRE | PF_XRPUSD LONG | nocional 313.01 · pérdida plan. 10.003 de presupuesto 10.003 · límites: ninguno | capital 1000.3985 |
| 17 | m+067 | CIERRA | PF_XRPUSD LONG | target · P&L +14.00 (bruto +14.32, comisiones 0.3201, funding sin dato) · provisional / funding unknown | capital 1000.3985 → 1000.3985 |

## s5_integral_reinicio_replay_log

Varias posiciones a la vez, pérdidas seguidas, funding incompleto, señales y eventos duplicados, señal vencida y un reinicio desde un checkpoint persistido (replay_log).

| Qué | Valor |
|---|---|
| Hash del escenario | `74984ca8430ac0a4dfcfa9bb9834daf83a476e16ea48cf25c2f9009a6a02ffba` |
| Hash de las velas aplicadas | `718b0cc7d3701eef31632d0c6923909e7ee138c5c9fc6bfd2a73610d2f6686d6` |
| Hash del libro (decisiones + operaciones) | `587cfc4e03dfb40726dda72d4ecca304e4de20c5bf2610f30e522fd4ecc17858` |
| Digest del estado final | `a6e745893dc5fd94f7eb3869d25df93412d937c060978e160b1fd3c5dd0bac3a` |
| Hash del diario (73 entradas, cadena íntegra: sí) | `6d96b7c2854fbb89ed9bd70b6682c5e2fa785a89cfb1fa41b24ce5abda628b68` |

**Contabilidad verificada**: 8 operaciones, P&L neto +4.72 USD (comisiones 3.170305 USD, funding 0.001423 USD).

**Provisional**: 1 operaciones con funding partial, P&L parcial -8.62 USD; ganancias excluidas del capital 0 USD; pérdidas incluidas -8.6231 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 996.0993 USD · **equity** (con ganancias provisionales) 996.0993 USD · rechazos por motivo: contradictory_signals ×2, duplicate_intent ×1, duplicate_signal ×1, insufficient_margin ×1, retroactive_intent ×3, stale_data ×1.

### Reinicio simulado (modo `replay_log`)

- Proceso terminado en m+163 con el último checkpoint persistido (de m+135); un proceso nuevo, construido solo desde ese checkpoint y el diario, reinicia en m+172.
- Lo ocurrido entre el checkpoint y la caída queda en el diario (época anterior) pero **sus efectos se descartan**.
- Equivalente a la ejecución sin interrupción: libro **sí**, estado **sí** (referencia: libro `587cfc4e03df…`, capital 996.0993 USD, 9 cierres).
- Esta equivalencia **supone** un registro durable de eventos que hoy no existe para las señales (ver capacidades). Las entregas repetidas se descartan por `event_id`.

### Registro cronológico (selección; completo en `journals/s5_integral_reinicio_replay_log.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 14 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 2.0109 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 15 | m+006 | ABRE | PF_ETHUSD SHORT | nocional 474.29 · pérdida plan. 9.9998 de presupuesto 10.00 · límites: ninguno | capital 1000 |
| 16 | m+006 | ABRE | PF_SOLUSD LONG | nocional 25.71 · pérdida plan. 1.0577 de presupuesto 10.00 · límites: gross_limit, margin | capital 1000 |
| 17 | m+006 | RECHAZA | PF_ADAUSD LONG | contradictory_signals |  |
| 18 | m+006 | RECHAZA | PF_ADAUSD SHORT | contradictory_signals |  |
| 19 | m+006 | RECHAZA | PF_XRPUSD SHORT | insufficient_margin |  |
| 20 | m+006 | duplicate_events_ignored |  | 1 eventos ya vistos |  |
| 23 | m+008 | RECHAZA | PF_XBTUSD LONG | retroactive_intent, duplicate_intent |  |
| 26 | m+010 | RECHAZA | PF_SOLUSD LONG | retroactive_intent, duplicate_signal |  |
| 27 | m+021 | CIERRA | PF_XBTUSD LONG | target · P&L +1.74 (bruto +2.25, comisiones 0.5011, funding 0.0025) · verified / funding complete | capital 1000 → 1001.743 |
| 28 | m+022 | CIERRA | PF_SOLUSD LONG | stop · P&L -1.06 (bruto -1.03, comisiones 0.0251, funding 0.000137) · verified / funding complete | capital 1001.743 → 1000.6851 |
| 29 | m+029 | CIERRA | PF_ETHUSD SHORT | target · P&L +13.75 (bruto +14.22, comisiones 0.4671, funding -0.003636) · verified / funding complete | capital 1000.6851 → 1014.4389 |
| 30 | m+045 | checkpoint_saved |  | digest de estado f92d7479dc… |  |
| 33 | m+076 | ABRE | PF_XBTUSD LONG | nocional 507.21 · pérdida plan. 3.5250 de presupuesto 10.144 · límites: product_limit | capital 1014.4389 |
| 34 | m+087 | CIERRA | PF_XBTUSD LONG | stop · P&L -3.53 (bruto -3.02, comisiones 0.5057, funding 0.00186) · verified / funding complete | capital 1014.4389 → 1010.9120 |
| 35 | m+090 | checkpoint_saved |  | digest de estado b9e75fe746… |  |
| 38 | m+096 | ABRE | PF_XRPUSD LONG | nocional 300.20 · pérdida plan. 10.109 de presupuesto 10.109 · límites: ninguno | capital 1010.9120 |
| 41 | m+106 | RECHAZA | PF_ADAUSD LONG | retroactive_intent, stale_data |  |
| 42 | m+135 | checkpoint_saved |  | digest de estado 13d052c445… |  |
| 45 | m+151 | ABRE | PF_ETHUSD SHORT | nocional 394.20 · pérdida plan. 9.8906 de presupuesto 10.109 · límites: daily_loss_budget | capital 1010.9120 |
| 46 | m+163 | simulation_note |  | process killed here; memory is lost, journal and checkpoint file survive |  |
| 47 | m+172 (época 1) | restart |  | restaurado desde checkpoint m+135; 5 entradas posteriores descartadas |  |
| 48 | m+128 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 49 | m+129 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 50 | m+130 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 51 | m+131 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 52 | m+132 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 53 | m+133 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 54 | m+134 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 55 | m+135 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 58 | m+151 | ABRE ↺ | PF_ETHUSD SHORT | nocional 394.20 · pérdida plan. 9.8906 de presupuesto 10.109 · límites: daily_loss_budget | capital 1010.9120 |
| 59 | m+170 | CIERRA ↺ | PF_ETHUSD SHORT | stop · P&L -9.89 (bruto -9.49, comisiones 0.3989, funding -0.002497) · verified / funding complete | capital 1010.9120 → 1001.0238 |
| 60 | m+186 | CIERRA | PF_XRPUSD LONG | time_stop · P&L -8.62 (bruto -8.33, comisiones 0.2960, funding 0.0004) · provisional / funding partial | capital 1001.0238 → 992.4007 |
| 63 | m+201 | ABRE | PF_XBTUSD SHORT | nocional 496.20 · pérdida plan. 2.9683 de presupuesto 9.9240 · límites: product_limit | capital 992.4007 |
| 66 | m+261 | ABRE | PF_SOLUSD LONG | nocional 279.36 · pérdida plan. 9.9237 de presupuesto 9.9240 · límites: ninguno | capital 992.4007 |
| 67 | m+299 | CIERRA | PF_XBTUSD SHORT | target · P&L +3.21 (bruto +3.69, comisiones 0.4943, funding -0.016209) · verified / funding complete | capital 992.4007 → 995.6081 |
| 70 | m+301 | ABRE | PF_XBTUSD LONG | nocional 497.80 · pérdida plan. 2.9947 de presupuesto 9.9560 · límites: product_limit | capital 995.6081 |
| 71 | m+361 | CIERRA | PF_SOLUSD LONG | time_stop · P&L +1.14 (bruto +1.43, comisiones 0.2800, funding 0.009312) · verified / funding complete | capital 995.6081 → 996.7517 |
| 72 | m+361 | CIERRA | PF_XBTUSD LONG | time_stop · P&L -0.65 (bruto -0.14, comisiones 0.4977, funding 0.009956) · verified / funding complete | capital 996.7517 → 996.0993 |

## s5_integral_reinicio_live_gap

Varias posiciones a la vez, pérdidas seguidas, funding incompleto, señales y eventos duplicados, señal vencida y un reinicio desde un checkpoint persistido (live_gap).

| Qué | Valor |
|---|---|
| Hash del escenario | `156f2a3c32da7c192d4f052e13d5056417def59bdd6a9d8580003050da528f94` |
| Hash de las velas aplicadas | `718b0cc7d3701eef31632d0c6923909e7ee138c5c9fc6bfd2a73610d2f6686d6` |
| Hash del libro (decisiones + operaciones) | `ed03a2ab569d07e9b6dbac07b44acd9ae51da886aaccf37efd7832b566f3d6e0` |
| Digest del estado final | `1adecf6c84088780fdd0770c07c4397879d5a6bf5c698dc638c1b3e05c4a455f` |
| Hash del diario (70 entradas, cadena íntegra: sí) | `0355e20853453459a21f45e3206dfa240acc18fe8fa6b20e9db10a3dac44164d` |

**Contabilidad verificada**: 7 operaciones, P&L neto +14.65 USD (comisiones 2.784038 USD, funding 0.003950 USD).

**Provisional**: 1 operaciones con funding partial, P&L parcial -8.62 USD; ganancias excluidas del capital 0 USD; pérdidas incluidas -8.6231 USD; posiciones abiertas 0 (no realizado 0 USD).

**Capital definitivo** 1006.0243 USD · **equity** (con ganancias provisionales) 1006.0243 USD · rechazos por motivo: contradictory_signals ×2, duplicate_intent ×1, duplicate_signal ×1, insufficient_margin ×1, retroactive_intent ×3, stale_data ×1.

### Reinicio simulado (modo `live_gap`)

- Proceso terminado en m+163 con el último checkpoint persistido (de m+135); un proceso nuevo, construido solo desde ese checkpoint y el diario, reinicia en m+172.
- Lo ocurrido entre el checkpoint y la caída queda en el diario (época anterior) pero **sus efectos se descartan**.
- Equivalente a la ejecución sin interrupción: libro **NO**, estado **NO** (referencia: libro `587cfc4e03df…`, capital 996.0993 USD, 9 cierres).
- Las señales emitidas tras el checkpoint y antes de volver (`signal:ce19b6cf8bdc61042dd49e4f:1`) **no se recuperan** y el sistema no puede saber que faltan. Por eso el resultado difiere de la ejecución sin caída: **esta divergencia es el hallazgo**, no un error de la prueba.

### Registro cronológico (selección; completo en `journals/s5_integral_reinicio_live_gap.jsonl`)

| # | Cuándo | Qué | Producto | Detalle | Capital |
|---|---|---|---|---|---|
| 14 | m+006 | ABRE | PF_XBTUSD LONG | nocional 500.00 · pérdida plan. 2.0109 de presupuesto 10.00 · límites: product_limit | capital 1000 |
| 15 | m+006 | ABRE | PF_ETHUSD SHORT | nocional 474.29 · pérdida plan. 9.9998 de presupuesto 10.00 · límites: ninguno | capital 1000 |
| 16 | m+006 | ABRE | PF_SOLUSD LONG | nocional 25.71 · pérdida plan. 1.0577 de presupuesto 10.00 · límites: gross_limit, margin | capital 1000 |
| 17 | m+006 | RECHAZA | PF_ADAUSD LONG | contradictory_signals |  |
| 18 | m+006 | RECHAZA | PF_ADAUSD SHORT | contradictory_signals |  |
| 19 | m+006 | RECHAZA | PF_XRPUSD SHORT | insufficient_margin |  |
| 20 | m+006 | duplicate_events_ignored |  | 1 eventos ya vistos |  |
| 23 | m+008 | RECHAZA | PF_XBTUSD LONG | retroactive_intent, duplicate_intent |  |
| 26 | m+010 | RECHAZA | PF_SOLUSD LONG | retroactive_intent, duplicate_signal |  |
| 27 | m+021 | CIERRA | PF_XBTUSD LONG | target · P&L +1.74 (bruto +2.25, comisiones 0.5011, funding 0.0025) · verified / funding complete | capital 1000 → 1001.743 |
| 28 | m+022 | CIERRA | PF_SOLUSD LONG | stop · P&L -1.06 (bruto -1.03, comisiones 0.0251, funding 0.000137) · verified / funding complete | capital 1001.743 → 1000.6851 |
| 29 | m+029 | CIERRA | PF_ETHUSD SHORT | target · P&L +13.75 (bruto +14.22, comisiones 0.4671, funding -0.003636) · verified / funding complete | capital 1000.6851 → 1014.4389 |
| 30 | m+045 | checkpoint_saved |  | digest de estado f92d7479dc… |  |
| 33 | m+076 | ABRE | PF_XBTUSD LONG | nocional 507.21 · pérdida plan. 3.5250 de presupuesto 10.144 · límites: product_limit | capital 1014.4389 |
| 34 | m+087 | CIERRA | PF_XBTUSD LONG | stop · P&L -3.53 (bruto -3.02, comisiones 0.5057, funding 0.00186) · verified / funding complete | capital 1014.4389 → 1010.9120 |
| 35 | m+090 | checkpoint_saved |  | digest de estado b9e75fe746… |  |
| 38 | m+096 | ABRE | PF_XRPUSD LONG | nocional 300.20 · pérdida plan. 10.109 de presupuesto 10.109 · límites: ninguno | capital 1010.9120 |
| 41 | m+106 | RECHAZA | PF_ADAUSD LONG | retroactive_intent, stale_data |  |
| 42 | m+135 | checkpoint_saved |  | digest de estado 13d052c445… |  |
| 45 | m+151 | ABRE | PF_ETHUSD SHORT | nocional 394.20 · pérdida plan. 9.8906 de presupuesto 10.109 · límites: daily_loss_budget | capital 1010.9120 |
| 46 | m+163 | simulation_note |  | process killed here; memory is lost, journal and checkpoint file survive |  |
| 47 | m+172 (época 1) | restart |  | restaurado desde checkpoint m+135; 5 entradas posteriores descartadas |  |
| 48 | m+128 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 49 | m+129 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 50 | m+130 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 51 | m+131 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 52 | m+132 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 53 | m+133 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 54 | m+134 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 55 | m+135 (época 1) | duplicate_events_ignored ↺ |  | 5 eventos ya vistos |  |
| 56 | m+172 (época 1) | simulation_note ↺ |  | signals never delivered to the restarted process |  |
| 57 | m+186 | CIERRA | PF_XRPUSD LONG | time_stop · P&L -8.62 (bruto -8.33, comisiones 0.2960, funding 0.0004) · provisional / funding partial | capital 1010.9120 → 1002.2889 |
| 60 | m+201 | ABRE | PF_XBTUSD SHORT | nocional 501.14 · pérdida plan. 2.9979 de presupuesto 10.022 · límites: product_limit | capital 1002.2889 |
| 63 | m+261 | ABRE | PF_SOLUSD LONG | nocional 282.15 · pérdida plan. 10.022 de presupuesto 10.022 · límites: ninguno | capital 1002.2889 |
| 64 | m+299 | CIERRA | PF_XBTUSD SHORT | target · P&L +3.24 (bruto +3.72, comisiones 0.4992, funding -0.016371) · verified / funding complete | capital 1002.2889 → 1005.5282 |
| 67 | m+301 | ABRE | PF_XBTUSD LONG | nocional 502.76 · pérdida plan. 3.0245 de presupuesto 10.055 · límites: product_limit | capital 1005.5282 |
| 68 | m+361 | CIERRA | PF_SOLUSD LONG | time_stop · P&L +1.16 (bruto +1.45, comisiones 0.2828, funding 0.009405) · verified / funding complete | capital 1005.5282 → 1006.6832 |
| 69 | m+361 | CIERRA | PF_XBTUSD LONG | time_stop · P&L -0.66 (bruto -0.15, comisiones 0.5026, funding 0.010055) · verified / funding complete | capital 1006.6832 → 1006.0243 |

## Determinismo

Cada escenario se ejecuta dos veces dentro del generador y el diario, el libro y el estado deben coincidir bit a bit; las pruebas lo repiten en procesos separados con distintos `PYTHONHASHSEED`. Sin reloj, sin red, sin `random` (el ruido de precios sale de SHA-256).

## Limitaciones que este informe no oculta

1. **Precio de entrada**: el módulo abre al precio de la intención (cierre de la vela de la señal) más el impacto del modelo de costes. Conectarlo al forward exigirá el primer precio ejecutable posterior a la señal; **no está resuelto**.
2. **Stops sin huecos**: el simulador sale siempre al precio del stop; la pérdida de un stop coincide con la planificada (comprobado) porque el modelo no incluye huecos ni deslizamiento extra (`slippage_buffer_bps` = 0).
3. **Velas y funding sintéticos**: demuestran que la mecánica cuadra, no que haya ventaja.
4. **Un solo reinicio por escenario.** El checkpoint es un `pickle` de nuestro propio archivo (misma práctica que `multi_experiment`). Un diario con la cola cortada se **rechaza** entero; no se intenta reparar ni descartar la última línea (decisión pendiente si se llevara a producción). No se probó un corte en mitad de la escritura del checkpoint más allá de que el renombrado es atómico.
5. **La fuente de entradas de la prueba entre procesos es un sustituto**: ambos procesos reconstruyen velas y señales desde la definición del escenario. Eso prueba la recuperación del estado y del diario, no que exista una fuente durable de señales (punto 3, pendiente para el forward).
6. **Pérdida diaria**: con la regla de admisión actual (límite diario menos pérdidas del día menos riesgo abierto) la suma pérdida realizada + riesgo planificado no supera 20 USD; `suspended_daily_loss` solo aparece si una pérdida real supera la planificada (funding, huecos). Está cubierta por `test_portfolio.py`.

