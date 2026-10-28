import { describe, expect, it } from 'vitest'
import type { GateRun } from '../infrastructure/gate-api.ts'
import {
  insideFit,
  MARKET_STAGES,
  nextStage,
  runMedicion,
  stageLabel,
  stagesFor,
  stageTabs,
} from './market-stages.ts'

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

describe('stageTabs', () => {
  it('gives one tab per stage in order, each with its newest finished practice run or none', () => {
    const tabs = stageTabs([
      on(0, { id: 3 }),
      on(0, { id: 8 }),
      on(1, { id: 5, status: 'failed' }),
      on(2, { id: 6, same_version: false }),
      on(3, { id: 7, kind: 'exam' }),
      on(4, { id: 9 }),
      run({ id: 10, params: { from: '2025-02-01', to: '2025-02-10' } }),
    ])
    expect(tabs.map((tab) => tab.stage)).toEqual([...MARKET_STAGES])
    expect(tabs.map((tab) => tab.run?.id ?? null)).toEqual([
      8,
      null,
      null,
      null,
      9,
    ])
  })
})

describe('honest and paper measurement', () => {
  it('adds the stretches before 2025 only to the honest measurement', () => {
    expect(stagesFor('vigente')).toEqual([...MARKET_STAGES])
    expect(stagesFor('honesta').length).toBeGreaterThan(MARKET_STAGES.length)
    expect(stagesFor('honesta').slice(-MARKET_STAGES.length)).toEqual([
      ...MARKET_STAGES,
    ])
    expect(stagesFor('honesta')[0].from).toBe('2023-07-01')
  })
  it('marks as inside the fitting the paper-formula stretches that end before October 2025', () => {
    const [first, , third, fourth] = MARKET_STAGES
    expect(insideFit(first, 'vigente')).toBe(true)
    expect(insideFit(third, 'vigente')).toBe(true)
    expect(insideFit(fourth, 'vigente')).toBe(false)
    expect(stageLabel(first, 'vigente')).toBe(
      'ene–mar 2025 (dentro del ajuste)',
    )
    expect(stageLabel(first, 'honesta')).toBe('ene–mar 2025')
    for (const stage of stagesFor('honesta'))
      expect(insideFit(stage, 'honesta')).toBe(false)
  })
  it('reads a run without a stored measurement as made with the paper formulas', () => {
    expect(runMedicion(on(0))).toBe('vigente')
    expect(
      runMedicion(run({ params: { from: '2025-01-01', medicion: 'honesta' } })),
    ).toBe('honesta')
  })
})
