# Qwen scores API

Read-only. Served by the live gateway (`pnpm dev`: through Vite as `/api-live/qwen/scores`; the gateway itself answers `/api/qwen/scores`). The report is computed by `python -m balancita_engine.futures_llm_scores` over Q's decisions DB and C's verdicts DB and cached for 15 s.

`GET /api-live/qwen/scores?product=PF_XBTUSD` (`product` optional: every configured product when absent; anything but `PF_[A-Z0-9]+` is a 400).

```jsonc
{
  "status": "ok",                 // "off" (no decisions DB yet, no Python) or "error", each with "reason"
  "generated_at": 1791000000000,  // ms
  "products": [
    {
      "product_id": "PF_XBTUSD",
      "question_id": "trade_action",
      "question_version": 1,
      "horizon_min": 30,
      "decisions": {              // every decision, +1 hit / -1 miss counted separately
        "decisions": 120, "scored": 95, "pending": 25,
        "hits": 41, "misses": 54, "points": -13,
        "hit_rate": 0.4316,       // null when nothing is scored
        "mean_net_bp": -2.1, "total_net_bp": -199.5
      },
      "by_option": {              // same shape as "decisions", per answer
      "baseline": { "always_hold_rate": 0.4, "scored": 120 },  // +1 rate of answering hold every time, the floor to beat
        "buy": { ... }, "hold": { ... }, "sell": { ... }
      },
      "trading": {                // same book and costs as the strategy backtest
        "trades": 12, "wins": 5, "hit_rate": 0.4167,
        "mean_net_bp": -4.3, "pnl_usd": -3.21, "return_pct": -0.0321,
        "sharpe_per_trade": -0.2, "avg_win_usd": 1.1, "avg_loss_usd": -1.24,
        "max_drawdown": { "pct": -0.05, "at_ms": 1791000000000 }
      },
      "book": { "initial_cash_usd": "10000", "taker_rate": "0.0005", ... },
      "skipped": { "count": 3, "first": [{ "bucket_ms": 0, "side": "LONG", "reason": "target_does_not_clear_cost_buffer" }] },
      "rows": [                   // newest 200 decisions, oldest first
        {
          "bucket_start": 1791000000000, "chosen": "buy", "confidence": 0.42,
          "probabilities": { "buy": 0.55, "hold": 0.3, "sell": 0.15 },
          "status": "scored",     // "pending" until the horizon closes
          "point": 1,             // 1, -1 or null while pending
          "gross_bp": 18.2, "net_bp": 8.2
        }
      ],
      "trades": [                 // newest 200 trades, oldest first
        {
          "side": "LONG", "entry_bucket_ms": 0, "entry_time_ms": 0, "entry_price": "90000",
          "stop_price": "89970", "target_price": "90060", "exit_bucket_ms": 0, "exit_time_ms": 0,
          "exit_price": "90060", "exit_reason": "target", // stop, target, opposite_decision, time_stop
          "quantity": "0.011", "net_bp": 5.67, "pnl_usd": 0.56, "equity_usd": 10000.56
        }
      ],
      "open_position": {          // null when flat; valued net of costs at the last close
        "side": "LONG", "entry_time_ms": 0, "entry_price": "90000", "mark_price": "90020",
        "net_bp": 1.9, "pnl_usd": 0.02
      }
    }
  ]
}
```

Definitions: `python/balancita_engine/futures_llm_scores.py` (module docstring).
