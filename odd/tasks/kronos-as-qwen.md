# Kronos shown like Qwen on /estrategias

## Objective

Show the Kronos paper strategy (`kronos-small-1h-h4-v1`, `python/kronos_lab`) on the Estrategias page exactly in the
Qwen format (ranking row, focus head, side panel with latest decisions, chart markers), reusing the Qwen components.
No new panels or components.

## Why

Kronos runs forward since 2026-10-08 but only appears as a usage chip; its trades, hit rate and return are invisible
in the UI (requested by Fran, 2026-10-08).

## Scope

- Server: read-only reader of `kronos.sqlite` (forward rows only) mapped to the existing `QwenScores`/`QwenProduct`
  shape; route `GET /api/kronos/scores?product=` with the same off/ok/error states; path from `KRONOS_DB_PATH`
  (default: directory of `KRONOS_SUMMARY_PATH` + `kronos.sqlite`).
- Front: loader for `/api-live/kronos/scores`; Qwen panels take the model's texts as props; a "Kronos" ranking row,
  focus and chart markers like Qwen.
- Docs: Kronos section in `docs/qwen-scores-api.md`.

## Constraints

- Never write to `kronos.sqlite`; backtest rows are excluded (forward only).
- No new panels/components; no changes to Qwen behaviour or to `python/kronos_lab`.
- Generated artifacts in English; existing UI copy is Spanish, so new UI strings follow it.

## Tasks

- [x] KQ-01 Server reader + route + config default + vitest (route: delegated writer; trigger: 2+ non-trivial files) — commit 868e17a
- [x] KQ-02 Front: loader, panel props, ranking row/focus/markers, labels/CSS + vitest (route: delegated writer) — commit 35171ac
- [x] KQ-03 Docs section in docs/qwen-scores-api.md (route: delegated writer, with KQ-01/02) — docs commit (this file's commit)

## Acceptance criteria

- `/api/kronos/scores?product=PF_XBTUSD` returns the QwenProduct shape from forward rows; `off` when the DB is missing.
- Estrategias shows a "Kronos" row ranked by return like Qwen; selecting it shows the Qwen head/side with Kronos texts,
  its closed trades and open position, and its markers on the chart.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:server` pass (or pre-existing failures are documented).

## Progress

- 2026-10-08: branch `claude/kronos-as-qwen` from origin/main 8437843; mapping done.

- 2026-10-08: KQ-01..03 done by one delegated writer.
  - KQ-01: RED observed (`kronos-scores.test.ts` failed, module missing), then GREEN. Smoke run of the reader against
    the live `kronos.sqlite` (read-only) returned `ok` with PF_XBTUSD forward stats. The DB path default lives in
    `gateway-main.ts` (`KRONOS_DB_PATH`, else next to `KRONOS_SUMMARY_PATH`); `scripts/dev-provider-env.mjs` was left
    unchanged because it already sets `KRONOS_SUMMARY_PATH`.
  - KQ-02: RED observed (3 new Kronos tests failed), then GREEN. Model texts live in `strategy-lab-labels.ts`
    (`MODEL_TEXTS`); `QwenFocusHead`/`QwenSide` take `model` (default `qwen`). `QwenOpenPosition.entry_price` widened to
    `string | null` (rendered `—`). `renderLab` test helper now injects `loadKronos` (default: a Kronos fixture) so the
    existing Qwen "sin decisiones" assertion stays unique.
  - Verification: `pnpm --dir server exec vitest run src/features/live-gateway/kronos-scores.test.ts
src/features/live-gateway/gateway.test.ts` 20 passed; `pnpm exec vitest run src/features/strategy-lab` 22 passed;
    `pnpm typecheck` ok; `pnpm lint` ok; `pnpm test:server` 25 files / 202 tests passed; `pnpm test` 18 files / 104
    tests passed; prettier clean on touched files.
  - Native review: not run by the writer (parent owns RDD assess/review).

## Next step

Parent: RDD assessment of the work-unit commits, then push/PR as the user decides.
