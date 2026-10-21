import { describe, expect, it } from 'vitest'
import type { GateRun } from '../infrastructure/gate-api.ts'
import { MARKET_STAGES, nextStage } from './market-stages.ts'

const run = (over: Partial<GateRun>): GateRun => ({
  id: 1,
  strategy_id: 's',
  kind: 'practice',
  status: 'done',
  verdict: 'NO PASA',
  progress: 1,
  phase: null,
  detail: null,
  eta_s: null,
  started_at: 0,
  finished_at: 1,
  attempts: null,
  error: null,
  has_report: true,
  ...over,
})
const on = (index: number, over: Partial<GateRun> = {}) =>
  run({
    params: { from: MARKET_STAGES[index].from, to: MARKET_STAGES[index].to },
    ...over,
  })

describe('nextStage', () => {
  it('starts with the first stretch of the market', () => {
    expect(nextStage([])).toEqual(MARKET_STAGES[0])
  })
  it('skips the stretches already tested and goes to the next different one', () => {
    expect(nextStage([on(0), on(1)])).toEqual(MARKET_STAGES[2])
  })
  it('counts a running test but not a failed or cancelled one, nor another version', () => {
    expect(nextStage([on(0, { status: 'running' })])).toEqual(MARKET_STAGES[1])
    expect(nextStage([on(0, { status: 'failed' })])).toEqual(MARKET_STAGES[0])
    expect(nextStage([on(0, { status: 'cancelled' })])).toEqual(
      MARKET_STAGES[0],
    )
    expect(nextStage([on(0, { same_version: false })])).toEqual(
      MARKET_STAGES[0],
    )
  })
  it('ignores exams and runs of the whole window', () => {
    expect(nextStage([on(0, { kind: 'exam' })])).toEqual(MARKET_STAGES[0])
    expect(nextStage([run({ params: { from: '2025-01-01' } })])).toEqual(
      MARKET_STAGES[0],
    )
  })
  it('returns null when every stretch was tried', () => {
    expect(nextStage(MARKET_STAGES.map((_, i) => on(i)))).toBeNull()
  })
})
