/**
 * SYNTHETIC verdict fixtures for B3 (tests, documented examples, the real
 * gateway integration test and the screenshots): none of these rows came from
 * the engine or the market. The payload has the shape `evaluate_verdict`
 * writes in `futures_verdicts.py` (`futures-verdict.v1`), with invented
 * numbers. Every consumer must label what it shows «DATOS DE EJEMPLO».
 */
import { DatabaseSync } from 'node:sqlite'
import { MINUTE } from './observability-health-fixtures.ts'

export const C25 = 'c25-pullback-perp-v1'
export const C26 = 'c26-reversion-perp-v1'
export const C27 = 'c27-breakout-perp-v1'
export const C28 = 'c28-adapter-perp-v1'

type Condition = {
  code: string
  value: unknown
  operator: string
  threshold: unknown
  passed: boolean
}

function condition(
  code: string,
  value: unknown,
  operator: string,
  threshold: unknown,
  passed: boolean,
): Condition {
  return { code, value, operator, threshold, passed }
}

function proposal(
  strategyId: string,
  action: string,
  reason: string,
  conditions: Condition[],
  extra: Record<string, unknown> = {},
) {
  return {
    strategy_id: strategyId,
    strategy_version: strategyId,
    action,
    reason_code: reason,
    conditions,
    feature_age_ms: 3000,
    supported_direction: ['LONG', 'SHORT'],
    invalidation: null,
    proposed_stop: null,
    proposed_target: null,
    horizon_minutes: 30,
    estimated_round_trip_cost_bps: null,
    status: 'ready',
    delegated_strategy_id: null,
    signal_key: null,
    ...extra,
  }
}

function features(close: string) {
  return {
    schema_version: 'c27-features.v2',
    ready: true,
    reason_codes: [],
    candidate_close: close,
    ema9: '99.8',
    ema21: '99.4',
    sma50: '98.9',
    rsi14: '52.3',
    atr14: '0.42',
    bollinger_mid20: '99.6',
    bollinger_lower20: '98.7',
    bollinger_upper20: '100.5',
    donchian_high20: '100.9',
    donchian_low20: '98.2',
    donchian_mid20: '99.55',
    candidate_volume: '410',
    prior_volume_mean20: '380',
    smoothing: 'wilder',
  }
}

export interface SyntheticVerdict {
  readonly product: string
  readonly bucket: number
  readonly regime?: string
  readonly action: string
  readonly reason: string
  /** Directional verdicts: the strategy whose proposal the selector chose. */
  readonly strategy?: string
  /** Extra weight in the payload, in characters (to size reads). */
  readonly padChars?: number
}

/** The verdict payload of the engine's shape, synthetic values. */
export function syntheticPayload(v: SyntheticVerdict): Record<string, unknown> {
  const directional = v.action === 'LONG' || v.action === 'SHORT'
  const chosen = v.strategy ?? C25
  const proposals = [
    proposal(
      C25,
      directional && chosen === C25 ? v.action : 'WAIT',
      directional && chosen === C25 ? v.reason : 'entry_conditions_not_met',
      [
        condition('trend_ema9_above_ema21', '99.8', '>', '99.4', true),
        condition('trend_close_above_sma50', '100.1', '>', '98.9', true),
        condition(
          'current_close_crosses_above_ema9',
          '100.1',
          '>',
          '99.8',
          directional && chosen === C25,
        ),
      ],
      directional && chosen === C25
        ? {
            invalidation: 'close_below_ema21',
            proposed_stop: '99.47',
            proposed_target: '100.94',
            estimated_round_trip_cost_bps: '12.5',
            signal_key: `${C25}:${v.action}:${v.bucket}`,
          }
        : {},
    ),
    proposal(C26, 'WAIT', 'entry_conditions_not_met', [
      condition('previous_close_below_lower_band', '99.9', '<', '98.7', false),
    ]),
    proposal(C27, 'WAIT', 'entry_conditions_not_met', [
      condition('close_breaks_prior_high', '100.1', '>', '100.9', false),
      condition('volume_above_1_25_prior_mean', '410', '>', '475', false),
    ]),
    proposal(
      C28,
      'WAIT',
      'entry_conditions_not_met',
      [condition('close_breaks_prior_high', '100.1', '>', '100.9', false)],
      { delegated_strategy_id: C27 },
    ),
  ]
  const selected = directional
    ? proposals[0]
    : { action: v.action, reason_code: v.reason }
  return {
    schema_version: 'futures-verdict.v1',
    config_hash: 'synthetic-config',
    product_id: v.product,
    interval_ms: MINUTE,
    bucket_start_ms: v.bucket,
    close_at_ms: v.bucket + MINUTE,
    decision_known_at_ms: v.bucket + MINUTE + 3000,
    knowledge_lag_ms: 3000,
    previous_regime: v.regime ?? 'range',
    regime: v.regime ?? 'range',
    action: v.action,
    reason_code: v.reason,
    selected,
    proposals,
    features: {
      '1m': features('100.1'),
      '1m_previous': features('99.9'),
      '5m': features('100.0'),
    },
    inputs: {
      '1m': { count: 120, first_bucket_start_ms: v.bucket - 119 * MINUTE },
      '5m': { count: 60, first_bucket_start_ms: v.bucket - 295 * MINUTE },
    },
    verdict_hash: `synthetic-${v.product}-${v.bucket}`,
    ...(v.padChars ? { pad: 'x'.repeat(v.padChars) } : {}),
  }
}

/**
 * Writes `rows` with the real DDL of `paper_futures_verdicts`. The synthetic
 * payload goes in the column unless `rawPayload` says what to store verbatim
 * (to test a payload that does not parse).
 */
export function seedSyntheticVerdicts(
  path: string,
  rows: readonly SyntheticVerdict[],
  rawPayload?: (v: SyntheticVerdict) => string | undefined,
): void {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
  db.exec(`CREATE TABLE IF NOT EXISTS paper_futures_verdicts(
    product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
    decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL,
    action TEXT NOT NULL, reason_code TEXT NOT NULL,
    verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
    written_at INTEGER NOT NULL,
    PRIMARY KEY(product_id, bucket_start)) STRICT`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  db.exec('BEGIN')
  for (const v of rows)
    insert.run(
      v.product,
      v.bucket,
      MINUTE,
      v.bucket + MINUTE + 3000,
      v.regime ?? 'range',
      v.action,
      v.reason,
      `synthetic-${v.product}-${v.bucket}`,
      rawPayload?.(v) ?? JSON.stringify(syntheticPayload(v)),
      v.bucket + MINUTE + 4000,
    )
  db.exec('COMMIT')
  db.close()
}

export interface SyntheticModelRow {
  readonly product: string
  readonly bucket: number
  readonly questionId?: string
  readonly chosen: string
  readonly confidence: number
  /** Stored verbatim; default: the hash the synthetic verdict has. */
  readonly verdictHash?: string
}

/** SYNTHETIC rows of the model decisions DB with the real DDL (futures_llm_decisions.py). */
export function seedSyntheticModelDecisions(
  path: string,
  rows: readonly SyntheticModelRow[],
): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE IF NOT EXISTS paper_futures_llm_decisions(
    product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL,
    question_id TEXT NOT NULL, question_version INTEGER NOT NULL,
    verdict_hash TEXT NOT NULL, question_type TEXT NOT NULL,
    model_ref TEXT NOT NULL, model_info_json TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, prompt_version INTEGER NOT NULL,
    probability_source TEXT NOT NULL, state_text TEXT NOT NULL,
    top_logprobs_json TEXT NOT NULL, probabilities_json TEXT NOT NULL,
    temperature REAL NOT NULL, chosen TEXT NOT NULL, value REAL,
    confidence REAL NOT NULL, latency_ms INTEGER NOT NULL, timings_json TEXT NOT NULL,
    written_at INTEGER NOT NULL,
    PRIMARY KEY(product_id, bucket_start, question_id, question_version)) STRICT`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
  db.exec('BEGIN')
  for (const r of rows)
    insert.run(
      r.product,
      r.bucket,
      r.questionId ?? 'q-entry-direction',
      1,
      r.verdictHash ?? `synthetic-${r.product}-${r.bucket}`,
      'direction',
      'synthetic-model',
      '{}',
      'synthetic-prompt',
      1,
      'logprobs',
      'x'.repeat(2000),
      '[]',
      JSON.stringify({ LONG: r.confidence, SHORT: 1 - r.confidence }),
      0,
      r.chosen,
      null,
      r.confidence,
      900,
      '{}',
      r.bucket + MINUTE + 9000,
    )
  db.exec('COMMIT')
  db.close()
}
