# strategy-lifecycle

## Objective

The user decides what runs in the real paper and what exists. Everything starts as a draft, any strategy can be tested at any time, activating asks for confirmation (and warns about a version that did not pass the test), a newly activated strategy is measured at once, and a delete removes everything about the strategy.

## Decisions (user, 2026-10-19)

1. **Everything starts in draft.** Shipped strategies (`config/strategies`) and registry-created ones. Only Kronos and Qwen act in the real paper without being "activated": they are not registry strategies (Kronos: `kronos_lab`; Qwen: process `q` for decisions and C31 `qwenexit`, which is off) and nothing here touches them. D (the old paper engine) no longer runs; the forward (`futures_forward`) is the only consumer of the registry's `active` state.
2. **Testing anytime.** `GateApi` accepts any strategy that exists in the registry whatever its state (draft, shadow, retired) and, since this change, Qwen (`c31-qwen-exit-perp-v1`) and Kronos (`kronos-small-1h-h4-v1`) too.
3. **Activation is only the user's**, from the front: a confirmation dialog; if this exact version (same spec hash) has no PASA practice run and no PASA exam, it says «Esta versión no pasó la prueba. ¿Activarla igual en el paper real?». The backend is otherwise unchanged (`paper_now` / import `activate` skip the promotion gates).
4. **Prompt first cycle** and health (below).
5. **Delete from the front**, builtins included, with a dialog and a clean purge (below). Qwen and Kronos cannot be deleted: 400 «Qwen y Kronos solo se pueden quitar desde el código», no button.

## All to draft (registry)

- `StrategyRegistry.seed` records shipped specs as **draft** (reason `builtin`).
- `StrategyRegistry.migrate_all_to_draft()` runs at S startup, once: for every non-deleted strategy it appends a `draft` event, reason «todas a borrador por decisión del usuario», to each version whose latest state is active, shadow or retired. Event-sourced (no row is rewritten); the marker `strategy_registry_meta('all_draft_v1')` makes it idempotent, so what the user activates afterwards survives restarts. Deleted (`closed`) strategies are not revived.
- `futures_forward.effective_registration`: only strategies the registry has **active** are measured. `config/forward-strategies.json` entries (C30) no longer switch anything on; they only supply `start_ms`, and the effective start is `max(start_ms, activation)` so a draft period is never measured. The health `expectedPairs` follows the same rule.
- Replays (`ReplayJobs`) now replay every non-deleted strategy (`replayable_specs`): a replay is history, not paper.

## Activation wake-up (forward)

`ForwardLoop` (`futures_forward.py`): a full cycle every `--loop-seconds` (3600) and, every `--registry-poll-seconds` (60), a cheap look at the registry (`forward_candidates`, read-only). A new `(id, version, active_since)` in the active set runs a cycle immediately for it. Still the single writer of `forward.sqlite`; no new process.

Health (`observability-health.ts`): an expected pair without a row while the forward process is alive is `warning` / `awaiting_first_cycle` («pendiente: esperando el primer ciclo»), not an error, until one loop plus the candle wait (60 + 5 min) passed since activation; after that, or with the process down, it is `error`. `docs/observabilidad-salud-api.md` updated.

## Clean delete

Single-writer design: S writes a small request file per delete in `<strategies db folder>/purge/` (`<id>.request.json`); each process that owns rows consumes the request in its next loop, deletes its own rows and writes its own acknowledgement (`<id>.<consumer>.ack.json`). S reports progress (`GET /api-strategies/purges/<id>`, «borrando…» / «listo») and removes request and acknowledgements once everyone answered. Code: `strategy_purge.py` (protocol, flags), `futures_strategy_lifecycle.py` (S side).

`POST /api-strategies/strategies/<id>/delete {confirm}` (name or id typed back; Qwen/Kronos refused; refused while a gate run of it is alive or while a running C31 uses it as an entry) and `GET .../delete-preview` (name, versions, state, time active in paper = sum of active periods, created date, forward trades and net, gate runs, exam taken and verdict).

| Owner                                                 | What is deleted                                                                                                               | How                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| S, registry DB                                        | versions, events, backtests (hard delete; the append-only triggers are lifted for that one transaction and restored)          | `StrategyRegistry.hard_delete`                                                                  |
| S, repo config                                        | `config/strategies/<id>.json` (builtins), the entry in `forward-strategies.json`, the id in `strategy-freeze.json`            | `Lifecycle._purge_config`; only when S was started with those paths                             |
| S, replay run DBs                                     | `replay_summary/trade/decision` rows                                                                                          | `ReplayJobs.purge_strategy`                                                                     |
| S, offline Qwen practice files (`data/qwen-practice`) | `signals`, `decisions`, `decision_errors` rows                                                                                | `Lifecycle._purge_practice`                                                                     |
| gate (single writer of `gate.sqlite`)                 | runs, attempts, exam locks, reports, cancel flags, launch logs naming the id                                                  | `python -m balancita_engine.strategy_gate purge --strategy <id>`, launched by S like `evaluate` |
| forward (single writer of `forward.sqlite`)           | `forward_status/open/diverged/recovered/blocked/unclassified/era/first_seen` rows and the entry in `forward-reliability.json` | request file, `futures_forward.consume_purges` at the head of each poll                         |

Not applicable: C's verdicts, the forecast scores and Qwen's decisions DB only reference the hard-coded C25-C28 (already closed, not deletable from the front) and no strategy a user can delete, so they have no consumer. `config/strategy-reliability.json` (hash-pinned table of past backtests) is not edited.

Deleting a builtin's JSON means the registry does not re-seed it (S seeds only from the files); a fresh checkout restores the file from git. Do not delete files in the repo from tests: `Lifecycle` touches config only when handed explicit paths.

### The one exception (to confirm with the user)

`gate.sqlite` keeps an anonymous exam tombstone: `exam_tombstones(spec_hash, exam_date, verdict)`, no id, name or params, so a deleted-and-recreated identical version cannot retake the exam (`check_exam_allowed` refuses it with the usual message). Recreating with other content is a new hash and is allowed. Single flag: `strategy_purge.KEEP_EXAM_TOMBSTONE`. Also anonymous and always on (`strategy_purge.KEEP_ATTEMPT_COUNTER`): `attempt_counts(family_hash, n)` keyed by `sha256(family name)`, so deleting and re-creating a family does not reset the deflated-Sharpe trial count (`strategy_gate.attempts_of` adds it to the live attempts).

### Paper trades are deleted too (ADR 0001, amendment 2026-10-19)

The user asked explicitly ("El ADR esta mal. Que no conserve nada"), so `docs/adr/0001-...md` got a new dated amendment (nothing rewritten) superseding "Switching a strategy off or deleting it stops new trades and keeps its trades." and the append-only rules only for a user-initiated delete. `strategy_purge.PURGE_PAPER_LEDGER = True`:

- Forward trades and funding reconciliation: the forward process lifts the append-only triggers for that one transaction and restores them.
- D's account DB (hash-chained, `futures_paper_account_purge.py`, run as a child by S; D is retired so it is the only writer): events of the strategy's books (`body.book = "<id>:<product>"`) are removed, the rest renumbered and the chain recomputed from the first affected event; snapshots drop the deleted books and re-point `head_seq`/`head_hash`; the stored config loses the id in `books`. The new chain is verified in memory before the transaction commits. Books are independent (own cash), so the other strategies' balances and payloads are unchanged; no trace of the id stays. D cannot resume with the code's config afterwards (it is retired). Tests: chain verifies, payloads identical, `AccountStore` reopens, guards restored, idempotent.
- S passes `--account-db`; `Lifecycle` only runs the tool when the DB mentions the strategy.

## Gate for Qwen and Kronos

They are not rule specs (`propose_spec`/`Book` cannot replay a local model), so `strategy_gate_models.py` judges what they did: the trades saved in `kronos.sqlite` / `qwen-exit.sqlite` (read-only), through the same `trade_source` hook, folds, costs and rules. S passes `--kronos-dir` / `--qwen-exit-dir`. Limit, printed in each report: they have no history before they started, so the practice (which ends at the cut) has no trades and the verdict is NO PASA/INCONCLUSO by lack of trades; the exam judges the recorded ones. Re-running the models over old candles needs the model weights / llama-server and hours of compute and is not done. Qwen here is C31 (exits); the Q decisions process has no trades of its own.

## Front (only inside /estrategias)

`LifecycleDialogs.tsx`: `ActivationDialog` (from the Versiones tab and from «Agregar estrategia» with «Activar en el paper real» — now unchecked by default), `DeleteDialog` (details, «Se borrará todo lo relacionado con esta estrategia. No se puede deshacer.», type the name), `PurgeNotice`. `VersionsTab` hides «Borrar» for Qwen and Kronos.

## Tests

`python/tests/test_strategy_lifecycle.py` (migration, effective registration, ForwardLoop wake-up, hard delete, purge across gate/forward/config, tombstone, ledger flag, HTTP, models in the gate), `test_futures_strategy_registry.py` / `test_futures_strategy_inventory.py` (drafts), `observability-health.test.ts` (expected pairs, pending vs error), `LifecycleDialogs.test.tsx`, `StrategyLab.test.tsx`, `lifecycle-text.test.ts`.

## Next step

User decisions pending: keep or drop the exam tombstone; amend the ADR (or not) to allow deleting paper trades; whether Qwen/Kronos should get a real historical re-run in the gate.
