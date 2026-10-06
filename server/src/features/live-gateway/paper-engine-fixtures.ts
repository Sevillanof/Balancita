import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** Test fixtures: D's account DB and C's verdicts DB, with the real DDL shapes. */

export const NOW = 1_791_000_000_000
const ACCOUNT_DDL = `
CREATE TABLE paper_execution_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE paper_execution_events(seq INTEGER PRIMARY KEY, time_ms INTEGER NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, record_hash TEXT NOT NULL) STRICT;
CREATE TABLE paper_execution_snapshots(seq INTEGER PRIMARY KEY, time_ms INTEGER NOT NULL, state_json TEXT NOT NULL,
  cursors_json TEXT NOT NULL, head_hash TEXT NOT NULL) STRICT;`
const VERDICT_DDL = `
CREATE TABLE paper_futures_verdicts(product_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
  decision_known_at INTEGER NOT NULL, regime TEXT NOT NULL, action TEXT NOT NULL, reason_code TEXT NOT NULL,
  verdict_hash TEXT NOT NULL, payload_json TEXT NOT NULL, written_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, bucket_start)) STRICT;`

export const LONG_POSITION = {
  side: 'long',
  quantity_btc: '0.0099',
  entry_price_usd_per_btc: '100011',
  opened_at_ms: NOW + 150,
  stop: '99900',
  target: '100500',
  strategy_id: 'c25-pullback-perp-v1',
}
export const OPEN_ACCOUNT = {
  cash_usd: '9999.50494555',
  realized_gross_usd: '0',
  fees_usd: '0.49505445',
  funding_paid_usd: '0',
  funding_complete: true,
  net_usd: '-0.49505445',
  position: LONG_POSITION,
}

export class AccountDb {
  readonly path: string
  private readonly db: DatabaseSync
  private seq = 0
  private snapshots = 0
  constructor(dir: string, closers: Array<() => void>) {
    this.path = join(dir, 'account.sqlite')
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(ACCOUNT_DDL)
    this.db
      .prepare('INSERT INTO paper_execution_meta VALUES(?,?)')
      .run('config_json', JSON.stringify({ initial_cash_usd: '10000' }))
    closers.push(() => this.db.close())
  }
  add(kind: string, time: number, body: Record<string, unknown>): number {
    this.seq += 1
    this.db
      .prepare('INSERT INTO paper_execution_events VALUES(?,?,?,?,?,?)')
      .run(
        this.seq,
        time,
        kind,
        JSON.stringify({ kind, time_ms: time, body }),
        'p',
        'r',
      )
    return this.seq
  }
  snapshot(time: number): void {
    this.snapshots += 1
    this.db
      .prepare('INSERT INTO paper_execution_snapshots VALUES(?,?,?,?,?)')
      .run(this.snapshots, time, '{}', '{}', 'h')
  }
  /** order_created, order_filled and position_opened for one long entry. */
  enter(orderId = 'o1', time = NOW): void {
    this.add('verdict_considered', time, {
      outcome: 'entered',
      signal_key: `k-${orderId}`,
    })
    this.add('order_created', time, {
      order_id: orderId,
      type: 'entry',
      side: 'buy',
      order_type: 'market_ioc',
      eligible_at_ms: time + 100,
      expires_at_ms: time + 5100,
      signal_key: `k-${orderId}`,
      strategy_id: 'c25-pullback-perp-v1',
      stop: '99900',
      target: '100500',
    })
    this.add('order_filled', time + 150, {
      order_id: orderId,
      side: 'buy',
      quantity: '0.0099',
      price: '100011',
      liquidity: 'taker',
      fee: '0.49505445',
      account: OPEN_ACCOUNT,
    })
    this.add('position_opened', time + 150, {
      order_id: orderId,
      account: OPEN_ACCOUNT,
    })
  }
}

export class VerdictsDb {
  readonly path: string
  private readonly db: DatabaseSync
  constructor(dir: string, closers: Array<() => void>) {
    this.path = join(dir, 'verdicts.sqlite')
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(VERDICT_DDL)
    closers.push(() => this.db.close())
  }
  add(
    bucket: number,
    action = 'LONG',
    extra: Record<string, unknown> = {},
    productId = 'PF_XBTUSD',
  ) {
    const payload = {
      action,
      bucket_start_ms: bucket,
      close_at_ms: bucket + 60_000,
      decision_known_at_ms: bucket + 63_000,
      knowledge_lag_ms: 3_000,
      regime: 'trend',
      reason_code: action === 'WAIT' ? 'no_proposal' : 'c25_long',
      verdict_hash: `hash-${bucket}`,
      selected: {
        action,
        strategy_id: action === 'WAIT' ? null : 'c25-pullback-perp-v1',
        reason_code: action === 'WAIT' ? 'no_proposal' : 'c25_long',
      },
      proposals: [
        {
          strategy_id: 'c25-pullback-perp-v1',
          action,
          reason_code: 'c25_long',
          conditions: [
            {
              code: 'trend_ema9_above_ema21',
              passed: true,
              value: '86266.3509276900510770527361697780145',
              threshold: '86197.6694294640317902152707532871925',
              operator: '>',
            },
          ],
        },
      ],
      features: { '1m': { huge: 'x'.repeat(2000) } },
      ...extra,
    }
    this.db
      .prepare('INSERT INTO paper_futures_verdicts VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        productId,
        bucket,
        60_000,
        payload.decision_known_at_ms,
        'trend',
        action,
        payload.reason_code,
        payload.verdict_hash,
        JSON.stringify(payload),
        bucket + 63_500,
      )
  }
}
