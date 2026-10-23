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

function seed(rows: Array<[string, number, string, string, number]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-decisions-'))
  dirs.push(dir)
  const path = join(dir, 'decisions.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE paper_futures_llm_decisions(
    product_id TEXT, bucket_start INTEGER, question_id TEXT, question_version INTEGER,
    chosen TEXT, confidence REAL, latency_ms INTEGER, written_at INTEGER)`)
  const insert = db.prepare(
    'INSERT INTO paper_futures_llm_decisions VALUES(?,?,?,4,?,?,120,?)',
  )
  for (const [product, bucket, question, chosen, confidence] of rows)
    insert.run(product, bucket, question, chosen, confidence, bucket + 5_000)
  db.close()
  return path
}

describe('createQwenDecisions', () => {
  it('maps trade_action choices to LONG, SHORT and WAIT, newest first', () => {
    const path = seed([
      ['PF_XBTUSD', 60_000, 'trade_action', 'buy', 0.7],
      ['PF_XBTUSD', 120_000, 'trade_action', 'hold', 0.5],
      ['PF_XBTUSD', 180_000, 'trade_action', 'sell', 0.9],
      ['PF_XBTUSD', 240_000, 'direction_1h', 'up', 0.9],
      ['PF_ETHUSD', 300_000, 'trade_action', 'buy', 0.9],
    ])
    const result = createQwenDecisions({ decisionsDbPath: path }).report(
      'PF_XBTUSD',
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.decisions.map((d) => [d.bucket_start_ms, d.action])).toEqual([
      [180_000, 'SHORT'],
      [120_000, 'WAIT'],
      [60_000, 'LONG'],
    ])
  })

  it('rejects a bad product or limit and reports an unreadable source as off', () => {
    const reader = createQwenDecisions({ decisionsDbPath: undefined })
    expect(reader.report('xbt')).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
    expect(reader.report('PF_XBTUSD', 0)).toEqual({
      status: 'error',
      reason: 'invalid_limit',
    })
    expect(reader.report('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'source_not_configured',
    })
    expect(qwenDecisionsOff('x').report('PF_XBTUSD').status).toBe('off')
  })
})
