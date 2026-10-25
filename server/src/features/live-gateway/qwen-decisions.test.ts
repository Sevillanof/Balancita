import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createQwenDecisions, qwenDecisionsOff } from './qwen-decisions.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
})

const MIN15 = 900_000

function seed(
  decisions: Array<[string, number, string, number]>,
  trades: Array<Record<string, unknown>> = [],
  skipped: Array<[string, number, string]> = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-live-'))
  dirs.push(dir)
  const path = join(dir, 'live.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE decisions(
    product TEXT, bucket_ms INTEGER, t_ms INTEGER, decided_at_ms INTEGER, action TEXT,
    confidence REAL, latency_ms INTEGER, prompt_version TEXT, reason TEXT);
    CREATE TABLE skipped(product TEXT, bucket_ms INTEGER, t_ms INTEGER, reason TEXT, detail TEXT);
    CREATE TABLE trades(product TEXT, trade_no INTEGER, status TEXT, side TEXT, entry_ms INTEGER,
    exit_ms INTEGER, entry_px TEXT, exit_px TEXT, qty TEXT, notional_usd TEXT, leverage TEXT, margin_usd TEXT,
    gross_usd TEXT, fees_usd TEXT, funding_usd TEXT, funding_status TEXT, net_usd TEXT, net_now_usd TEXT,
    closed_by TEXT, exit_reason TEXT, hold_min INTEGER, mark_px REAL, mark_ms INTEGER)`)
  const insert = db.prepare(
    "INSERT INTO decisions VALUES(?,?,?,?,?,?,120,'4','sin_ventaja')",
  )
  for (const [product, bucket, action, confidence] of decisions)
    insert.run(
      product,
      bucket,
      bucket + MIN15,
      bucket + MIN15 + 5_000,
      action,
      confidence,
    )
  for (const [product, bucket, reason] of skipped)
    db.prepare('INSERT INTO skipped VALUES(?,?,?,?,?)').run(
      product,
      bucket,
      bucket + MIN15,
      reason,
      'el modelo local no respondió',
    )
  for (const t of trades) {
    const cols = Object.keys(t)
    db.prepare(
      `INSERT INTO trades(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
    ).run(...(Object.values(t) as never[]))
  }
  db.close()
  return path
}

describe('createQwenDecisions: why it waited', () => {
  it('delivers probabilities, override and mirror when the base has them, null when not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-live-'))
    dirs.push(dir)
    const path = join(dir, 'live.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE decisions(
      product TEXT, bucket_ms INTEGER, t_ms INTEGER, decided_at_ms INTEGER, kind TEXT, action TEXT,
      model_action TEXT, p_action REAL, confidence REAL, probs_json TEXT, override TEXT, reason TEXT,
      mirror_action TEXT, mirror_p REAL, latency_ms INTEGER, threshold REAL, prompt_version TEXT);
      CREATE TABLE skipped(product TEXT, bucket_ms INTEGER, t_ms INTEGER, reason TEXT, detail TEXT)`)
    db.prepare(
      `INSERT INTO decisions VALUES('PF_XBTUSD',?,?,?,'flat','ESPERAR','LARGO',0.46,0.2,?,'bajo_umbral',NULL,'CORTO',0.4,100,0.5,'4')`,
    ).run(0, MIN15, MIN15 + 1, '{"LARGO":0.46,"CORTO":0.2,"ESPERAR":0.34}')
    db.prepare(
      `INSERT INTO decisions VALUES('PF_XBTUSD',?,?,?,'flat','ESPERAR',NULL,NULL,0.2,'no json',NULL,NULL,NULL,NULL,100,NULL,'4')`,
    ).run(MIN15, 2 * MIN15, 2 * MIN15 + 1)
    db.close()
    const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error('expected ok')
    const [late, early] = result.decisions
    expect(early).toMatchObject({
      override: 'bajo_umbral',
      model_action: 'LARGO',
      p_action: 0.46,
      threshold: 0.5,
      mirror_action: 'CORTO',
      mirror_p: 0.4,
      probabilities: { LARGO: 0.46, CORTO: 0.2, ESPERAR: 0.34 },
    })
    expect(late).toMatchObject({ override: null, probabilities: null })
  })

  it('delivers the opportunity window fields and reads them as null on a base without them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-live-'))
    dirs.push(dir)
    const path = join(dir, 'live.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE decisions(
      product TEXT, bucket_ms INTEGER, t_ms INTEGER, decided_at_ms INTEGER, action TEXT,
      confidence REAL, latency_ms INTEGER, prompt_version TEXT, reason TEXT, override TEXT,
      lean REAL, lean_m REAL, lean_num REAL, score REAL, best_score REAL, look_n INTEGER, mirror_ok INTEGER);
      CREATE TABLE skipped(product TEXT, bucket_ms INTEGER, t_ms INTEGER, reason TEXT, detail TEXT)`)
    db.prepare(
      `INSERT INTO decisions VALUES('PF_XBTUSD',0,?,?,'ESPERAR',0.5,10,'4',NULL,'ventana_mirando',0.3,-0.1,0.2,0.2,0.4,3,1)`,
    ).run(MIN15, MIN15 + 1)
    db.close()
    const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.decisions[0]).toMatchObject({
      override: 'ventana_mirando',
      lean: 0.3,
      lean_m: -0.1,
      lean_num: 0.2,
      score: 0.2,
      best_score: 0.4,
      look_n: 3,
      mirror_ok: 1,
    })
    const old = seed([['PF_XBTUSD', MIN15, 'ESPERAR', 0.5]])
    const older = createQwenDecisions({ liveDbPath: old }).report('PF_XBTUSD')
    if (older.status !== 'ok') throw new Error('expected ok')
    expect(older.decisions[0]).toMatchObject({ score: null, look_n: null })
  })

  it('still reads an older base without those columns', () => {
    const path = seed([['PF_XBTUSD', MIN15, 'ESPERAR', 0.5]])
    const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.decisions[0]).toMatchObject({
      override: null,
      probabilities: null,
      kind: null,
    })
  })
})

describe('createQwenDecisions: decisions', () => {
  it('maps the operator actions, newest first, and ignores other products', () => {
    const path = seed([
      ['PF_XBTUSD', MIN15 * 1, 'LARGO', 0.7],
      ['PF_XBTUSD', MIN15 * 2, 'ESPERAR', 0.5],
      ['PF_XBTUSD', MIN15 * 3, 'MANTENER', 0.5],
      ['PF_XBTUSD', MIN15 * 4, 'CERRAR', 0.9],
      ['PF_XBTUSD', MIN15 * 5, 'CORTO', 0.8],
      ['PF_XBTUSD', MIN15 * 6, 'INVENTADA', 0.8],
      ['PF_ETHUSD', MIN15 * 7, 'LARGO', 0.9],
    ])
    const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(
      result.decisions.map((d) => [d.bucket_start_ms / MIN15, d.action]),
    ).toEqual([
      [5, 'SHORT'],
      [4, 'CLOSE'],
      [3, 'WAIT'],
      [2, 'WAIT'],
      [1, 'LONG'],
    ])
    const first = result.decisions[0]!
    expect(first.decision_time_ms).toBe(first.bucket_start_ms + MIN15)
    expect(first.chosen).toBe('CORTO')
    expect(first.reason).toBe('sin_ventaja')
  })

  it('lists the wakes that were not decided, with the reason', () => {
    const path = seed([], [], [['PF_XBTUSD', MIN15, 'modelo_caido']])
    const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
    expect(result).toEqual({
      status: 'ok',
      decisions: [],
      skipped: [
        {
          product: 'PF_XBTUSD',
          bucket_start_ms: MIN15,
          decision_time_ms: 2 * MIN15,
          reason: 'modelo_caido',
          detail: 'el modelo local no respondió',
        },
      ],
    })
  })

  it('rejects a bad product or limit and reports an unreadable source as off', () => {
    const reader = createQwenDecisions({ liveDbPath: undefined })
    expect(reader.report('xbt')).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
    expect(reader.report('PF_XBTUSD', 0)).toEqual({
      status: 'error',
      reason: 'invalid_limit',
    })
    expect(reader.trades('xbt')).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
    expect(reader.report('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'source_not_configured',
    })
    expect(reader.trades('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'source_not_configured',
    })
    const missing = createQwenDecisions({
      liveDbPath: '/nonexistent/live.sqlite',
    })
    expect(missing.report('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'file_not_found',
    })
    expect(qwenDecisionsOff('x').report('PF_XBTUSD').status).toBe('off')
    expect(qwenDecisionsOff('x').trades('PF_XBTUSD').status).toBe('off')
  })
})

describe('createQwenDecisions: trades', () => {
  const base = {
    product: 'PF_XBTUSD',
    side: 'LONG',
    notional_usd: '100',
    leverage: '1',
    margin_usd: '100',
    qty: '0.001',
  }
  it('gives the open trade first with its result now, then the closed ones (newest first) with their net', () => {
    const path = seed(
      [],
      [
        {
          ...base,
          trade_no: 1,
          status: 'closed',
          entry_ms: 1_000,
          exit_ms: 9_000,
          entry_px: '100',
          exit_px: '101',
          gross_usd: '1.0',
          fees_usd: '0.1',
          funding_usd: '0.01',
          funding_status: 'complete',
          net_usd: '0.89',
          closed_by: 'qwen',
          exit_reason: 'sin_ventaja',
          hold_min: 120,
        },
        {
          ...base,
          trade_no: 2,
          status: 'open',
          side: 'SHORT',
          entry_ms: 5_000,
          entry_px: '100',
          net_now_usd: '-0.2',
          mark_px: 100.4,
          mark_ms: 6_000,
        },
        {
          ...base,
          trade_no: 3,
          status: 'closed',
          entry_ms: 3_000,
          exit_ms: 4_000,
          entry_px: '100',
          exit_px: '99',
          net_usd: '-1.2',
          closed_by: 'stop',
          funding_status: 'partial',
        },
      ],
    )
    const result = createQwenDecisions({ liveDbPath: path }).trades('PF_XBTUSD')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.trades.map((t) => [t.trade_no, t.status, t.net_usd])).toEqual(
      [
        [2, 'open', '-0.2'],
        [3, 'closed', '-1.2'],
        [1, 'closed', '0.89'],
      ],
    )
    const open = result.trades[0]!
    expect(open.side).toBe('SHORT')
    expect(open.mark_price).toBe(100.4)
    expect(open.exit_ms).toBeNull()
    expect(result.trades[2]!.closed_by).toBe('qwen')
    expect(result.trades[2]!.mark_price).toBeNull()
  })

  it('says off when the base has no trades table yet', () => {
    const path = seed([])
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE trades')
    db.close()
    const result = createQwenDecisions({ liveDbPath: path }).trades('PF_XBTUSD')
    expect(result.status).toBe('off')
  })
})
