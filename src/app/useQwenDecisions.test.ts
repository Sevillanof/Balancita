import { describe, expect, it } from 'vitest'
import { qwenAnalyses, qwenNotice } from './useQwenDecisions.ts'
import { isApprovedAnalysis } from './terminal-approved.ts'

const FIFTEEN = 900_000
const row = (bucket: number, action: string, chosen: string) => ({
  product: 'PF_XBTUSD',
  bucket_start_ms: bucket,
  decision_time_ms: bucket + FIFTEEN,
  action,
  chosen,
  confidence: 0.6,
  written_at_ms: bucket + 5_000,
})

describe('qwenAnalyses', () => {
  it("shapes Qwen's decisions like analyses, oldest first, all shown", () => {
    const out = qwenAnalyses({
      status: 'ok',
      decisions: [row(120_000, 'SHORT', 'sell'), row(60_000, 'WAIT', 'hold')],
    })
    expect(out.map((a) => [a.analysis_id, a.action])).toEqual([
      ['qwen:PF_XBTUSD:60000', 'WAIT'],
      ['qwen:PF_XBTUSD:120000', 'SHORT'],
    ])
    expect(out.every(isApprovedAnalysis)).toBe(true)
    expect(out[1]!.analysis_id).toBe('qwen:PF_XBTUSD:120000')
  })

  it('marks a 15 minute decision where Qwen looked at the market, and keeps CLOSE', () => {
    const out = qwenAnalyses({
      status: 'ok',
      decisions: [row(FIFTEEN, 'CLOSE', 'CERRAR'), row(0, 'LONG', 'LARGO')],
    })
    // the marker candle is the end of the window; the id stays the window's
    expect(
      out.map((a) => [a.analysis_id, a.bucket_start_ms, a.action]),
    ).toEqual([
      ['qwen:PF_XBTUSD:0', FIFTEEN, 'LONG'],
      ['qwen:PF_XBTUSD:900000', 2 * FIFTEEN, 'CLOSE'],
    ])
    expect(out[0]!.decision_time_ms).toBe(FIFTEEN)
    expect(out.every(isApprovedAnalysis)).toBe(true)
  })

  it('gives nothing when the source is off or malformed', () => {
    expect(qwenAnalyses({ status: 'off', reason: 'file_not_found' })).toEqual(
      [],
    )
    expect(
      qwenAnalyses({ status: 'ok', decisions: [{ action: 'LONG' }] }),
    ).toEqual([])
    expect(qwenAnalyses(null)).toEqual([])
  })
})

describe('qwenNotice', () => {
  it('says why there is no decision, and nothing when there is one', () => {
    expect(qwenNotice({ state: 'ok' }, 3)).toBeNull()
    expect(qwenNotice({ state: 'loading' }, 0)).toBeNull()
    expect(qwenNotice({ state: 'off', reason: 'file_not_found' }, 0)).toMatch(
      /Qwen no está corriendo/,
    )
    expect(qwenNotice({ state: 'error' }, 0)).toMatch(/No se pudieron leer/)
    expect(qwenNotice({ state: 'ok' }, 0)).toMatch(/todavía no decidió/)
  })
})
