# Propuesta de enmienda al ADR 0001: dimensionamiento dinámico de posiciones

Estado: **PROPUESTA, no vigente.** Parámetros iniciales aprobados provisionalmente por Fran el 2026-10-13; el texto final se revisa antes de incorporarlo al ADR. No modifica `0001-isolated-paper-futures-accounting.md`, que es inmutable salvo pedido directo del usuario. Si Fran la aprueba, el texto de abajo se agrega al ADR como una enmienda más ("Amendment AAAA-MM-DD"). Mientras tanto no cambia el comportamiento de ningún experimento: C29-C32, Kronos y el experimento multi-estrategia siguen con 100 USD fijos.

## Texto propuesto

### Amendment (propuesta): shared paper portfolio with dynamic position sizing

Requested directly by the user (Fran) on 2026-10-13 as PR #120. Where it conflicts with the text above, including the "100 USD fixed per trade" of the earlier amendments and "one independent book per strategy", this amendment prevails **for `portfolio.py` only**. Everything remains paper only: no real orders, no private endpoints, no credentials.

**Supersedes (only inside the shared portfolio).** The fixed 100 USD notional and the independent book per strategy. A single paper account of 1 000 USD is shared by all strategies and every position is sized from a risk budget.

**Sizing rule.** `notional = risk_budget / planned_loss_fraction`, where `risk_budget` is 1 % of the definitive capital and `planned_loss_fraction` is the loss per USD of notional if the stop executes, priced by the per-product cost model (entry impact, stop execution, taker fees) with an optional slippage buffer. The notional is then only reduced by the limits below. Signal strength does not size a position. Stops come from the declared protection rules (ATR-based, `multi_risk`); they are never moved to make a position fit.

**Limits (initial hypotheses, not optimized, not selected with the reserved holdout):**
1. Planned loss above 30 % of the notional: the entry is rejected.
2. Gross exposure at most 100 % of definitive capital (leverage 1x); exposure per product at most 50 %; net exposure at most 100 %.
3. Sum of the planned losses of the open positions at most 2 % of definitive capital (equal to the daily loss limit).
4. Daily loss limit 20 USD and maximum drawdown 60 USD suspend new entries; minimum notional 10 USD; at most 8 open positions. The losses realized during the day, plus the planned loss of the open positions, are deducted from the daily limit before admitting new planned risk (15 USD lost leaves about 5 USD). Only verified results offset losses in these limits.
5. Positions are opened only from intents with valid, fresh data, once per intent id **and once per signal id** (a new intent carrying the same signal, with another price or ATR, is a duplicate; valid copies of one signal that disagree on direction, price, levels or horizon are all rejected as inconsistent, never resolved by hash order), and in time order.
6. The prototype opens at the reference price of the intent plus the modeled impact. Any connection to real data needs a separate decision on the first executable price after the signal; that is not covered by this amendment.
7. `slippage_buffer_bps` is configurable; its initial value of zero is an optimistic hypothesis, to be replaced by measured stop slippage (never chosen with the reserved holdout).

**Accounting.** The shared simulator `Book` and `futures_costs` stay the only accounting engine. Funding is never inferred: a trade without verified funding keeps its complete net P&L null; its gain is provisional and does not raise capital or the risk budget, its loss does reduce capital.

**The planned loss is a model figure, not a guarantee** of the maximum real loss (funding, gaps and slippage beyond the model can exceed it).

**Unchanged.** C25-C31 and Kronos are not modified until 100 forward trades; the strategy parameters stay frozen; the module is not connected to the forward, to `capture` or to any active database until the user asks for it and a further amendment or decision says so. 100 forward trades do not by themselves prove an edge.

## Qué cambia respecto del ADR vigente
| ADR vigente | Esta propuesta (solo `portfolio.py`) |
|---|---|
| 100 USD fijos por operación | Nocional dinámico por presupuesto de riesgo (1 % del capital), sin tope absoluto |
| Libros independientes por estrategia | Una cuenta de 1.000 USD compartida |
| Riesgo = nocional fijo y límites de `multi_risk` | Riesgo planificado por operación, regla del 30 %, riesgo agregado abierto del 2 %, pérdida diaria que descuenta del riesgo admisible |

## Qué NO cambia
Solo paper, solo endpoints públicos, hashing canónico, Decimal, replay determinista, sin mirar el futuro, reglas de evaluación y congelamiento de C25-C31 y Kronos.

## Antes de conectarlo al forward (no está pedido)
Definir el primer precio ejecutable posterior a la señal (hoy se usa el precio de la intención) y medir el deslizamiento real de los stops para fijar el buffer. Decidir cómo conviven los libros independientes de C29-C32 con la cartera (mediciones separadas, sin mezclar), si la cartera lee las mismas velas oficiales, y cuándo aprobar los parámetros. Esa decisión es de Fran y llevaría otra enmienda.
