import { describe, expect, it } from 'vitest'
import { qwenAnalyses, qwenNotice } from './useQwenDecisions.ts'
import { isApprovedAnalysis } from './terminal-approved.ts'

const row = (bucket: number, action: string, chosen: string) => ({
  product: 'PF_XBTUSD',
  bucket_start_ms: bucket,
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
    expect(out.map((a) => [a.bucket_start_ms, a.action])).toEqual([
      [60_000, 'WAIT'],
      [120_000, 'SHORT'],
    ])
    expect(out.every(isApprovedAnalysis)).toBe(true)
    expect(out[1]!.analysis_id).toBe('qwen:PF_XBTUSD:120000')
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
