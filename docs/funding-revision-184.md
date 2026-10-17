# Tasa de funding corregida por Kraken: ajuste auditable (Issue #184)

Decisiones: BAL-DECISION-184-02/03 y Fran en el chat (2026-10-17 08:20Z): «Usemos la forma practica y transparente con Kraken. Necesitamos que funcione, si Kraken corrige una tasa, se registra como ajuste y el sistema no se para.» Solo paper, solo datos ya capturados; no habilita sesiones, órdenes, lecturas nuevas ni cambia el ADR.

## Regla

La cartera usa la tasa de cada período **tal como llega**. Si Kraken publica después otra tasa para un período que ya está en uso (una **revisión**), pasa esto:

1. **La tasa vista en último lugar queda en uso.** El adaptador (`funding_adapter.FundingBook`) cuenta `revision_applied`, anota la evidencia (`revision_applied`, con la tasa anterior, la nueva y el hash de la respuesta anterior) y entrega al runner un evento `funding` con `revisions: [[inicio, fin, tasa_anterior, tasa_nueva]]`.
2. **El runner la registra, no la pisa.** `portfolio_funding.revise_funding` reemplaza la tasa en uso y escribe en el registro de funding (encadenado por hash) una entrada `period_revised` con la tasa anterior (`previous`) y la entrada que la había aceptado (`supersedes: {seq, hash}`). La observación original queda en el registro; no se borra nada.
3. **Cada operación cerrada que se solapaba con el período se recalcula desde los períodos en uso** (`reconcile_funding`, que corre en el paso siguiente del runner, como el funding tardío). Si su funding cambia, recibe **un** ajuste `funding_revision` (solo se agrega): estado antes y después, `revised_periods`, diferencia de P&L y de capital, capital/presupuesto de riesgo/drawdown alrededor y el hash de los períodos usados. La operación conserva su cierre original en `trade_details[...]["as_closed"]`.
4. **Una posición que sigue abierta** no necesita ajuste: todavía no pagó ese período; al cerrar se calcula con la tasa en uso.
5. **No se cuenta dos veces.** El funding de una operación se **recalcula** desde los períodos, nunca se acumula: repetir la revisión (`duplicate`), reconciliar otra vez, o repetir la entrega (el runner responde `duplicate` por `event_id`) no cambia nada. Una revisión que vuelve a la tasa original es otra revisión y otro ajuste.
6. **El sistema no se para.** La revisión de una tasa ya no cuenta como divergencia (BAL-DECISION-184-01 queda aclarada: se para por divergencia de **estado**, es decir, el libro del adaptador y la cartera no coinciden; se ajusta por revisión de tasa).

## Cómo se refleja en el funding y en el saldo simulado

- **Funding de la operación:** `funding_usd` pasa a ser la suma de los períodos en uso. Ejemplo con datos inventados (prueba de sesión): una hora entera dentro de la tenencia pasa de 0,0001 a 0,0009 por hora; sobre un nocional N, un LONG paga `N × (0,0009 − 0,0001)` más por esa hora (un SHORT lo recibe de menos). Con 100 USD por operación y una tasa relativa del orden de 1e-5 por hora, la diferencia típica es de milésimas de USD por hora de tenencia.
- **P&L y capital:** `pnl_usd = bruto − comisiones − funding`; la diferencia entra al capital como un evento `funding_reconciled` (mismo tipo que el funding tardío) con el mismo delta que el ajuste. Se mantienen las reglas existentes: una ganancia de una operación con funding incompleto no sube el capital definitivo y una pérdida siempre lo baja.
- **Decisiones ya tomadas** (posiciones abiertas, intenciones rechazadas) **no se revisan**; el ajuste las lista en `decisions_not_revised`.
- **Informe de sesión:** `funding_report()` agrega `revised_periods` (qué períodos fueron revisados); `pnl_verified` sigue dependiendo de funding incompleto, disputas y divergencia de estado, no de las revisiones.
- **Auditoría (`portfolio_audit`):** el ajuste `funding_revision` no exige cobertura nueva, sí que el estado encadene y que el recuento desde los períodos coincida. Entre la revisión y su reconciliación el audit avisa (`revision_reconciliation_pending`), no marca error.

## Qué sigue siendo una disputa (cuarentena)

Dos tasas distintas para un mismo período **dentro de la misma respuesta** no son una corrección sino una contradicción: ninguna se acepta, el período queda en cuarentena y se marcan las operaciones afectadas, como antes. Un período ya en cuarentena se mantiene así. Una revisión que no parte de la tasa en uso (`revision_base_mismatch`) o que se refiere a un período nunca aceptado no se aplica y deja el libro del adaptador y la cartera en desacuerdo, que sí detiene la sesión (divergencia de estado).

## Fuente simulada fuera del camino operativo

`paper_live_process`: `funding_mode` ya **no tiene valor por defecto**; es una clave obligatoria de la configuración (`synthetic` u `observed`). Una configuración sin ella se rechaza (`config_invalid`). Las fixtures siguen existiendo y se declaran `synthetic` de forma explícita; el modo `observed` lee las respuestas de la captura a través del adaptador. El modo sintético sigue informando `pnl_verified: false` (`synthetic_funding`).

## Límites declarados

- **Qué es «definitivo» sigue siendo la regla del adaptador** (`fin + settle_lag ≤ hora del servidor`, 10 min por hipótesis); este cambio no la mide ni la modifica. Lo que hace es que, si la tasa cambia después, el cambio queda registrado.
- **Si Kraken alterna entre dos valores** (por ejemplo por una réplica atrasada), cada cambio es una revisión y un ajuste: transparente, pero ruidoso. Ya queda visible en `revised_periods`.
- **La captura solo guarda una respuesta cuando trae un par (inicio, tasa) nuevo**; una revisión es un par nuevo, así que se guarda. Los avistamientos (PR #259) permitirán medir cuántas veces ocurre.
- Los datos reales de este cambio no se han leído: todas las pruebas usan datos inventados.

## Pruebas (datos inventados)

- `test_funding_revision_184.py`: revisión en cartera (tasa en uso, registro encadenado con `supersedes`, ajuste único con la diferencia exacta, historial completo, idempotencia, vuelta a la tasa original, base no coincidente, período desconocido o sin liquidar, producto sin solape, posición abierta, determinismo).
- `test_funding_adapter.py`: el libro del adaptador aplica la revisión, la cuarentena de contradicciones internas sigue, reinicio del libro, la cartera del runner queda igual a la del adaptador, reentrega sin efecto.
- `test_paper_observed_funding_184.py`: sesión completa con una tasa revisada con la operación abierta (sin ajuste, cierra con la tasa nueva) y ya cerrada (un ajuste con la diferencia exacta); sin cuarentena, sin parar, señales idénticas, evidencia conservada, auditoría sin violaciones.
- `test_paper_live_process_185.py`: `funding_mode` obligatorio.
