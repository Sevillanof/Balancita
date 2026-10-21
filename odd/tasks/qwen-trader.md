# qwen-trader

## Objective

"Qwen operador": the local Qwen decides by itself WHEN to enter and WHEN to exit, on BTC (`PF_XBTUSD`) and ETH (`PF_ETHUSD`) only for now. This task ships the engine, the historical practice, the report and the learning-data export. It changes no live process.

## Decisions from the owner (2026-10-19)

- Products: BTC and ETH only, for now.
- Unlimited trades: no maximum per day. The only brakes are the cooldown after a close and the costs themselves.
- Qwen learns by OFFLINE retraining cycles, not online (see "Learning data" below).
- Q (`trade_action`) and C31 (`futures_qwen_exit`) are to be switched off in the NEXT PR, together with the live wiring. This PR does not touch `dev.mjs`, does not stop Q or C31 and does not add a live process.
- Practice on history first, paper (live) afterwards.
- ADR 0001 (immutable) already covers this: 100 USD fixed per trade, long and short, one cost model per product, Qwen allowed to decide. Nothing here needs an amendment.

## Design

`python/balancita_engine/futures_qwen_trader.py`, config `config/qwen-trader.json` (versioned; every parameter, threshold grid, product list, wake rule and prompt text; hashed into the practice DB).

- One class, `Trader`, fed CLOSED 5m candles one at a time. It has no other input, so it cannot look ahead; the practice and the future live process run the same class (live == replay). The model is reached through a `decider` (`LlmDecider` over `futures_llm_decisions.ask_model`: llama-server on loopback, grammar over letters, `max_tokens` 1, logprobs, confidence). A replay answers from stored calls, so nothing is asked twice.
- **Wake rules** (deterministic; Qwen is asked only when one fires):
  - flat: every closed 1 h candle; strong move (|log return| over 15 or 30 min above 2 x its normal size; normal = 5m log-volatility of the last 288 bars scaled by sqrt of the window); a funding publication that is extreme (`|rate| >= 5e-5` per hour) or jumps (`|change| >= 3e-5`).
  - in position: every 15 min; the same strong move; an adverse move beyond 75 % of the stop distance; funding as above.
  - extra wakes (strong move, near stop) are at least 10 min apart. `WAKE_HOOKS` is the empty extension point for later strategy signals and news.
- **Actions**: flat LARGO / CORTO / ESPERAR; in a position MANTENER / CERRAR. One grammar-constrained letter, asked in two option orders (3 options: written order and a rotation in which every option changes letter; 2 options: swapped), probabilities averaged, confidence `1 - H/ln(n)` as in `llm_decisions`; ties go to ESPERAR / MANTENER. Only when the action is LARGO, CORTO or CERRAR a second 1-token call asks the reason (`movimiento_exagerado`, `tendencia`, `funding_extremo`, `sin_ventaja`, `proteger_ganancia`, `cortar_perdida`, `otro`).
- **Entry threshold**: an entry needs p(action) >= threshold. The practice enters at the lowest value of the predeclared grid `[0.5, 0.6, 0.7, 0.8]` and records p; the report picks the threshold on the calibration fold (largest total net bp among thresholds with >= 30 calibration trades; if none is positive, the strictest one) and records it (`practice_meta.threshold_selection`, and in the report). Approximation, stated in the report: the trades of the practice are filtered afterwards; an entry that the stricter threshold would have skipped would have left the slot free for another one.
- **Guardrails, not overridable**: hard stop at `1.5 x` the 24 h sigma measured at entry (clamped to 0.5 %..20 %; gaps fill at the candle open, never better than the stop), forced close after 24 h, 15 min cooldown after any close, 100 USD per trade, one position per product, no limit of trades per day. Every forced close is a `guardrail` event in the data.
- **State shown** (Spanish, no dates, no absolute prices, no product name, never its own performance): returns 1h / 4h / 24h / 7d, trend as return over normal noise, daily volatility 24 h and 7 d, last 15 min vs normal, distance to the 24 h and 7 d high and low, volume vs mean, funding (last rate and 30-day percentile when Kraken's public history covers it), the round-trip cost, the fixed rules and, in a position, side, open time, unrealized result after costs, distance to the stop and time to the limit. The cost sentence is in the question: "entrar y salir cuesta ~0,10 %; solo vale la pena operar si esperás un movimiento claramente mayor".
- Prompt `qwen-trader` v1. Any text change needs a new `prompt.version` (a test pins the text hash).
- Accounting: `futures_costs` fills, taker fees on both legs, Kraken's public funding of the holding time (`settle`, the same formula as `Book._settle`); a trade with no funding data is flagged (`funding_status`), not charged zero silently. Public hourly funding only exists from 2025-10-15, so older blocks are flagged.

## Historical practice

`python -m balancita_engine.futures_qwen_trader practice` (needs llama-server on loopback; `--llama-url` other than 127.0.0.1 / localhost / ::1 is refused).

- Random contiguous **blocks** of 3 days in `[2025-01-01, holdout_from)` (`holdout_from` 2026-04-19 from `config/strategy-gate.json`), seeded, stratified: the period is cut in 157 slots per product, grouped in 10 time bins; strata are (product, bin), shuffled and interleaved so that any prefix of the plan is balanced across time and products. Default plan: 60 blocks (30 BTC, 30 ETH; 180 days each). Every block starts flat after 8 days of warm-up candles (read, never traded) and runs end to end; a position still open at the end of a block is closed at the last price with costs and marked `fin_de_bloque`.
- Folds: blocks that start in the older 60 % of the period (before 2025-10-11) are calibration, the rest validation. The verdict uses validation only, with the threshold chosen on calibration.
- The holdout is never read: `History` raises `HoldoutError` for any request that reaches it, the plan ends before it, funding periods that end after it are dropped.
- Resumable (`data/qwen-trader/practice.sqlite`, single writer): every call is stored (state hash, prompt version and hash, served model from `GET /v1/models`, probabilities of both orders, latency); a block cut by `--max-minutes` is replayed next time from the stored calls (no repeated model call), and committed in one transaction when it ends. A DB made with another config / seed / period is refused.
- Progress: per block (blocks done / total, calls, ETA) and every 200 calls (rate and remaining budget).
- `prefetch` downloads Kraken's public 5m candles and funding into `data/qwen-trader/cache`; `practice --offline` uses the cache only.

Expected load (BTC / ETH 2025, synthetic Qwen, this container): flat about 24 hourly + 10-15 strong-move wakes a day, about 75 calls a day; in a position about 96 + 10-15 wakes, about 220 calls a day; measured blend about 130 calls a day, about 390 calls per 3-day block. At 0.5 s per call: a block is about 3-4 min, a 55-minute batch (about 6,600 calls) is about 15-17 blocks (about 45-50 days), the 60-block plan is about 3.3 h, four batches.

## Report

`report --out data/qwen-trader/informe.md`, Spanish Markdown in the gate's style (title, ✅/❌/⚠️ verdict, "En pocas palabras", "Qué revisamos", short tables, "Glosario", "Detalles técnicos"). Per product and total: trades, trades per day, hit rate, mean net %, total USD (100 USD fixed), profit factor, max drawdown, average holding, share closed by Qwen / stop / 24 h limit / end of block. Baselines on the same blocks: do not trade (0), random entries (same count, side, holding, inside the same block, 1000 draws, percentile), Kronos `n/d` (its historical forecasts need the time-series model run candle by candle; not cheap). Calibration (predicted vs best action over the next hour), order agreement, reasons with outcomes, calibration vs validation, days evaluated and coverage.

Predeclared verdict rules (validation fold, `config/qwen-trader.json` `rules`, thresholds reused from the gate): n >= 100 · mean net > 0 with the 95 % bootstrap CI lower bound > 0 · percentile >= 95 against random entries · positive in >= 60 % of the time groups (the stratification bins) · positive in >= half of the products · positive with costs x1.5. Fewer than 100 trades: NO PASA "(pocas operaciones)" if another rule fails, INCONCLUSO otherwise. The gate's deflated Sharpe is left out on purpose: there is a single configuration and a single attempt so far; when prompt versions multiply, add the attempts counter.

## Learning data

`export --out data/qwen-trader/dataset.jsonl`: one line per decision (schema `balancita-qwen-trader-dataset.v1`): the state text exactly as prompted, the wake reasons, probabilities per order and merged, the action the model chose and the action taken, `guardrail` (`override`: `bajo_umbral`, `sin_respuesta`, ...; `forced` for stop / time / end-of-block closes), the reason with its probabilities, the position, and the realized outcome:

- entries: the trade (net bp, who closed it, holding) plus the 60-minute long / short nets;
- ESPERAR: net bp of a long and of a short held 60 min, round-trip cost included;
- MANTENER / CERRAR: net bp now, net bp after 60 min (or the realized result if the trade ended first) and `hold_better_bp = after - now`.

Also `fold` and `source` (`practice` now, `live` when the live process writes the same rows).

How it feeds a future offline LoRA fine-tune (no training code in this PR): each cycle exports `practice` + `live` rows; the supervised target of a flat row is the best of {LARGO, CORTO, ESPERAR} by its 60-minute net (ESPERAR = 0) and of a position row MANTENER / CERRAR by `hold_better_bp`, optionally weighted by the size of the difference so that near-ties teach little; the prompt is `state_text` plus the question of that prompt version, so a new training set is tied to `prompt_version`. Train only on the `calibration` fold and on live rows older than the evaluation window; the `validation` fold and later live data stay out and judge the new adapter with the same report (and the holdout is touched only by the strategy-gate exam, once). The adapter is a new model reference, never an in-place update, and a new `config_hash` makes the practice DB start from scratch.

## Version 2 (owner decision, 2026-10-19): only Qwen exits

First real v1 practice (Qwen3-4B, 11 of 60 blocks, 28 trades): 26 of 28 trades closed by Qwen with reason `sin_ventaja`, 0 % win, mean -0.32 %, about 2 h holding; the 2 trades closed at the block end were the winners; the reason call was degenerate (always `tendencia` on entry, `sin_ventaja` on exit). "Qwen tiene que lograr decidir bien cuando salir, no que alguien salga por él": v2 removes the safety nets to test that.

- Files: `config/qwen-trader-v2.json` (version 2, `prompt.version` 2) and `data/qwen-trader/practice-v2.sqlite`. v1 (`config/qwen-trader.json`, `practice.sqlite`) is untouched and stays reproducible (its config hash is pinned in the tests). Same `practice` section (seed, period, block days, bins), so v2 plays the SAME seeded blocks as v1; the candle cache is shared.
- No stop and no 24 h limit (`guardrails.stop_sigma_24h` and `max_hold_min` are `null`). A position closes only by Qwen's CERRAR or, in the practice, at the block end (`closed_by = fin_de_bloque`, not a Qwen decision). Kept: 15 min cooldown after a close, fixed 100 USD, one position per product. The `cerca_del_stop` wake is gone; `movimiento_grande_en_posicion` wakes Qwen (at most once an hour between the 15 min boundaries) when the price is at least one daily volatility away from the entry, in either direction. It only asks; nothing is forced.
- Exit information (state text, facts only): result if closing now after all costs (% and USD), a note that the entry fee is already paid and in that result and that closing only adds the exit fee, time open, typical move over the next 1 h / 4 h from the current volatility (`sigma5 * sqrt(bars)`) and the move already made in the position's favour (gross). The position question says the same and that there is no stop or time limit.
- Reason call: asked in two option orders (`prompt.reason_orders = "both"`, 7 options rotated by 4, so no option keeps its letter), both stored, probabilities averaged. If it is still degenerate the report says so ("motivo degenerado", more than 90 % the same option); nothing more is done about it.
- CLI: `practice --version 2` is the default and prints which version runs; `--version 1` still works. `report` (default `--version all`) writes `informe.md` (v1) and `informe-v2.md` (v2, with a v1 vs v2 section over the blocks both finished, plus the counterfactual-exit section: with no stop the "guardrails only" case is "hold to the block end"). `export --version 2` adds `exit_labels` to every MANTENER / CERRAR line: `close_now_net_bp`, `hold_1h/4h/block_end_net_bp` (marked from the stored block candles, funding included when the cache is given by `--cache-dir`; a v1 stop / 24 h close that came first is used as it happened; `null` past the block end), `hold_better_*_bp` and `best_*` (`MANTENER` or `CERRAR`), so exits can be trained later from either choice.

Report-only additions (also for v1 databases, no model calls): counterfactual exits ("¿Qué habría pasado si no cerraba?": guardrails only / 4 h / 8 h / 24 h; the block-end rule never reads past the block, fixed horizons may cross it but never reach the holdout), entry quality (gross move at 4 h / 24 h against the round-trip cost), reason diversity and letter bias, and measured latency with the estimated remaining batches.

## Speed and prompt layout (v2 runtime options, v2.1)

Decisions must not change; only the time per call. Measured on the Mac before: about 1.08 s per call, about 506 calls per 3-day block.

- **Concurrent option orders** (`runtime.concurrent_orders`, default on in v2 / v2.1, off in v1; `practice --sequential` turns it off). The two orders of one question are sent at the same time (llama-server must run with `-np 2`). Only the HTTP calls run in threads; the answers are consumed, stored and merged in the fixed variant order by the calling thread, and the first failing order stops the question exactly like the sequential path, so the stored rows are the same. Test: sequential and concurrent practice runs store identical decisions, trades and calls. **Caveat**: llama.cpp batching two sequences can change logits in the last digits (and a cached prefix can too). Measure it on the Mac: `practice --version 2 --check-determinism 200` replays 200 stored decisions (both orders), one by one and at once, and prints the largest probability difference to the stored call, between the two ways, the average and how many decisions would change their final choice, plus how many re-computed prompt hashes differ from the stored ones (a wrong version or config). A difference of about 1e-3 or less that flips nothing is harmless; if choices flip, use `--sequential`.
- **Prompt caching**: `futures_llm_decisions.request_body` already sends `cache_prompt: true`; the option orders of one question share almost the whole prompt. The v2 text starts with the STATE, so nothing before the first changed number can be reused. **v2.1** (`config/qwen-trader-v2.1.json`, `prompt.version` 2.1, `state_last: true`; "solo orden/rendimiento") puts `QUESTION`, options and answer line first and the `STATE` last (same layout as prompt v4 of `llm_decisions`; the layout is implemented locally in `qt.build_prompt`, `futures_llm_decisions` is untouched). This changes the prompt TEXT (order, and «el estado de arriba» became «de abajo»), so it is a new version: v2 stays reproducible (config hash `1e7cfac1...` and prompt text pinned in the tests), v2.1 has its own database `practice-v2.1.sqlite`, the same seed and blocks, and the same state text (same `state_hash`). Did the decisions change? `compare-prompts --from-version 2 --version 2.1 --n 200` asks 200 stored v2 decisions again under the v2.1 text (same states, no trajectory divergence) and prints agreement, flips and probability differences; the v2.1 report also compares both runs on the decisions that had an identical state.
- **Entry reason skipped** (`runtime.skip_entry_reason`, on in v2 / v2.1; `practice --ask-entry-reason` brings it back): the entry reason was degenerate (95 % «tendencia»). The exit reason is still asked in both orders. Entries have `entry_reason = NULL` (the report shows «sin motivo»). Continuing a v2 database with the flag on mixes entries with and without reason, which is harmless for decisions.
- `runtime` is excluded from `config_hash`: turning these options on or off never invalidates an existing practice database.
- The end of every batch prints `rendimiento:` (new calls, calls per second, wall seconds per call, latency of one call, blocks per hour and, when the server reports it, the share of prompt tokens served from the cache).
- Expected effect: calls per wake drop from 3 (2 + reason) to 2 on entries; the two orders overlap, so the wall time per question is about one latency instead of two; with the fixed prefix cached only the state (a few hundred tokens) is processed. Expect roughly 2x from concurrency, 1.1-1.3x from fewer entry reasons and some extra from the cache; measure with the `rendimiento:` line.

## Report additions (no model calls, any practice database)

- **Long or short** (`¿Prefiere comprar o vender?`): per product and fold, long and short entries (count, share, mean result) next to the market's buy-and-hold return over the same blocks, with one plain sentence.
- **Exit decisions one by one** (`Decisiones de salida, una por una`): for every MANTENER and CERRAR the other choice over the next 1 h, 4 h and to the block end, with costs and funding, from the closes stored with the block (same function as the export labels, so nothing past the block end is read); % where the choice was better and the average gain over the alternative, by unrealized result in σ of 4 h (daily volatility / sqrt 6; buckets at -1σ, 0, +1σ) and by time open (<1 h, 1-4 h, 4-12 h, >12 h), and a plain conclusion on where it exits or holds well or badly.
- **Does confidence rank outcomes?** AUC with a 95 % block bootstrap interval, rank correlation and top-vs-bottom quintile for three signals (probability of the choice, logit margin between the top two options averaged over both orders, agreement of the two orders) against entries (net result) and exits (gain over the alternative at 1 h / 4 h, also split by action). Isotonic calibration fitted on the calibration fold only and shown against validation. If every AUC interval includes 0.5 the report says that confidence carries no information and must not be used as a filter.
- **Why it decides what it decides** (`modelo que lo imita`): a depth-3 tree and a standardized logistic regression (pure Python) fitted on the calibration fold from the numbers in the stored state text, judged on validation against always saying the most common action; rules and top features in plain Spanish. It describes Qwen's behaviour, not the market.

## Probes (`probe`)

`python -m balancita_engine.futures_qwen_trader probe --version 2 --sample 200 --max-minutes 55` re-asks a seeded sample of stored decisions (stratified by kind, product and chosen action, interleaved so any prefix is balanced) with the same prompt and ONE number of the state changed at a time. Resumable (own table `probe_calls` in the practice database, the practice's `calls` statistics are untouched), budgeted, loopback only, never reads candles or the holdout.

Perturbations (value set to the 10th and 90th percentile of that number among the stored decisions of the same product and kind, so values are realistic; a level that would print the same as now is skipped; everything else in the text is identical): `retorno_1h/4h/24h/7d` (the return and its «tendencia», recomputed from the 15 min normal band shown in the same text), `volatilidad` (24 h), `movimiento_15min`, `distancia_maximo_24h`, `distancia_minimo_24h`, `volumen_1h`, `funding` (rate), and in a position `resultado_actual` (% and USD) and `tiempo_abierto`. A «repetir sin cambiar nada» control gives the noise floor. The report section `¿Qué datos mira de verdad?` lists per number the share of decisions that flip and the probability shift. Cost: about 21-25 questions per decision x 2 orders; `--sample 200` is about 9,000-10,000 calls, about 1.1 s per pair of orders at the same time, so roughly 80-90 minutes (two 55-minute batches); `--sample 100` fits one batch.

## Constraints

- No network except the loopback llama-server and Kraken's public candle / funding endpoints through the existing cache (`futures_history`). No credentials, no orders.
- `futures-runtime.test.ts`, ADR 0001 and the strategy-lifecycle files (registry, forward, health, UI) are not touched.

## Tasks

- [x] Engine, config, wake rules, guardrails, both option orders, reason call.
- [x] Practice runner (blocks, folds, resumable, budget, progress), holdout guard, loopback only.
- [x] Report with predeclared verdict rules and baselines.
- [x] Export of learning data.
- [x] Tests: `PYTHONPATH=python:python/tests python3 -m unittest test_futures_qwen_trader` (fake llama provider).
- [x] v2 (no stop, no limit, richer exit state, two-order reason, v1 vs v2 report, exit labels).
- [x] Speed (concurrent orders, v2.1 layout, entry reason skipped, determinism check, compare-prompts), report additions, surrogate and probes.
- [ ] Mac: `prefetch`, `practice` in 55-minute batches until the 60 blocks are done, `report`; note the verdict and the measured seconds per call here.
- [ ] Next PR: live process (same `Trader`), switch off Q and C31, paper accounting, `source = live` rows.
