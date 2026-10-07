# Strategy registry API (PS-08)

The strategy registry S (`python/balancita_engine/futures_strategy_registry.py`) is the backend of the Laboratorio screen. In dev it runs as the `strategies` child on `127.0.0.1:8790`, and Vite proxies `/api-strategies` to it. It is the only writer of `futures-strategies.sqlite` and opens C's verdicts DB read-only.

Strategies are `balancita-strategy.v1` specs (`python/balancita_engine/futures_spec_strategy.py`; C25-C28 ship in `config/strategies/`). Errors are `{"error": code, "detail": text}` with an HTTP status.

## Reads

| Route | Returns |
|---|---|
| `GET /api-strategies/schema` | Editor catalog: operands (`1m.rsi14`, `1m_previous.ema21`, `5m.ema9`, ...), comparators, node kinds, states, periods, gate thresholds. |
| `GET /api-strategies/strategies` | Latest version of every strategy: `id`, `version`, `name`, `description`, `state`, `active_version`, `spec_hash`, `parent`, `origin`. |
| `GET /api-strategies/ranking?product=PF_XBTUSD&days=7\|30\|90` | Ranking rows (the list above plus `return_pct`, `pnl_usd`, `hit_rate`, `trades`, `wins`, `few_trades`, `deflated_sharpe_probability`), sorted by return, and `buy_and_hold_pct`. With no verdicts yet: `verdicts_available: false` and null metrics. |
| `GET /api-strategies/strategies/:id?version=n` | One version with its `spec`, every `versions` entry and the lifecycle `events`. |
| `GET /api-strategies/strategies/:id/export?version=n` | The spec JSON, for download. |

## Actions

| Route | Body | Does |
|---|---|---|
| `POST /api-strategies/validate` | `{spec}` | `{valid, error?, spec_hash?}` without saving. |
| `POST /api-strategies/evaluate` | `{id, version?}` or `{spec}`, `product` | The proposal on the newest verdict; each condition's `passed` is the green or red dot. |
| `POST /api-strategies/backtest` | `{id, version?}` or `{spec}`, `product`, `days` | Full result: `all`, `in_sample`, `out_of_sample` (`trades`, `wins`, `hit_rate`, `mean_net_bp`, `pnl_usd`, `return_pct`, `avg_win_usd`, `avg_loss_usd`), `max_drawdown {pct, at_ms}`, `buy_and_hold_pct`, `vs_buy_and_hold_pts`, `deflated_sharpe_probability`, `trials`, and `trades[]` (`side`, `entry_time_ms`, `entry_price`, `exit_time_ms`, `exit_price`, `exit_reason`, `net_bp`, `pnl_usd`) for the chart. |
| `POST /api-strategies/strategies` | `{spec, mode: "modify" \| "new", new_name?, new_id?}` | "Modificar": version n+1 of the same id. "Crear estrategia nueva": a new C29+ id; the original stays. Saved as draft. |
| `POST /api-strategies/strategies/:id/variants` | `{version?, param, values: ["35","40","45"]}` | One draft strategy per value ("35; 40; 45" = 3 variants). |
| `POST /api-strategies/import` | `{spec}` | Imported as a new draft (a taken id gets a fresh one). |
| `POST /api-strategies/strategies/:id/state` | `{version, state: draft \| shadow \| active \| retired}` | Lifecycle. Shadow needs a backtest; active needs shadow, 30+ out-of-sample trades, positive mean net bp and deflated Sharpe probability of at least 0.95. A refusal is 409 `gate_failed` with `gates[]`. |

The backtest replays the spec over stored verdicts (same official candles as the Terminal) as one independent paper book per strategy: D's sizing and cost-buffer rule, taker fees, no slippage or funding. The first 70% of the period is in sample, the rest out of sample. Every distinct spec backtested counts as one trial.
