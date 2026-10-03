import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateC27Exit,
  evaluateC27ExitWithMacroContext,
  evaluateMicroTarget,
  initialMicroState,
  macroContextWhenReady,
  type MicroStrategyDiagnostic,
  type MicroStrategyFeatures,
} from './micro-strategy.ts'

type ParityCase =
  | { readonly kind: 'initial-state' }
  | {
      readonly kind: 'target'
      readonly strategy:
        | 'trend-pullback'
        | 'bollinger-reversion'
        | 'donchian-breakout'
        | 'regime-adapter'
      readonly features: MicroStrategyFeatures
      readonly prior: {
        readonly exposure: 'flat' | 'long'
        readonly regime: 'trend' | 'range' | null
      }
      readonly macroContext?: {
        readonly atrPercentile50: number | null
        readonly donchianHigh20: number | null
        readonly donchianMid20: number | null
      } | null
    }
  | {
      readonly kind: 'c27-exit'
      readonly entryPrice: number
      readonly close: number
      readonly donchianMid: number | null
      readonly barsHeld: number
    }
  | {
      readonly kind: 'c27-exit-macro'
      readonly entryPrice: number
      readonly close: number
      readonly macroContext: {
        readonly atrPercentile50: number | null
        readonly donchianHigh20: number | null
        readonly donchianMid20: number | null
      } | null
      readonly barsHeld: number
    }
  | {
      readonly kind: 'macro-context'
      readonly features: MicroStrategyFeatures | null
    }

const readyFeatures: MicroStrategyFeatures = {
  ema9: 102,
  ema21: 100,
  sma50: 99,
  rsi14: 25,
  close: 94,
  bollingerLower: 95,
  bollingerMid: 100,
  bollingerWidth: 2,
  atr14: 1,
  priorAtrSma20: 1,
  donchianHigh20: 93,
  donchianMid20: 96,
  volume: 130,
  priorVolumeSma20: 100,
  atrPercentile50: 70,
  ready: true,
}

const notReadyFeatures: MicroStrategyFeatures = {
  ...readyFeatures,
  ready: false,
}

const noDataFeatures: MicroStrategyFeatures = {
  ...readyFeatures,
  ema9: null,
  ema21: null,
  sma50: null,
  rsi14: null,
  bollingerLower: null,
  bollingerMid: null,
  bollingerWidth: null,
  donchianHigh20: null,
  donchianMid20: null,
  priorVolumeSma20: null,
  atrPercentile50: null,
}

const cases: readonly ParityCase[] = [
  {
    kind: 'target',
    strategy: 'trend-pullback',
    features: notReadyFeatures,
    prior: { exposure: 'long', regime: 'trend' },
  },
  {
    kind: 'target',
    strategy: 'trend-pullback',
    features: noDataFeatures,
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'trend-pullback',
    features: { ...readyFeatures, close: 101, rsi14: 40 },
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'trend-pullback',
    features: { ...readyFeatures, close: 99, rsi14: 50 },
    prior: { exposure: 'long', regime: 'trend' },
  },
  {
    kind: 'target',
    strategy: 'bollinger-reversion',
    features: { ...readyFeatures, close: 94, rsi14: 25, bollingerWidth: 2 },
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'bollinger-reversion',
    features: { ...readyFeatures, close: 100, rsi14: 56 },
    prior: { exposure: 'long', regime: 'range' },
  },
  {
    kind: 'target',
    strategy: 'bollinger-reversion',
    features: noDataFeatures,
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'donchian-breakout',
    features: { ...readyFeatures, close: 94, donchianHigh20: 93, volume: 130 },
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'donchian-breakout',
    features: { ...readyFeatures, close: 95, donchianMid20: 96 },
    prior: { exposure: 'long', regime: null },
  },
  {
    kind: 'target',
    strategy: 'donchian-breakout',
    features: noDataFeatures,
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'regime-adapter',
    features: readyFeatures,
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'target',
    strategy: 'regime-adapter',
    features: { ...readyFeatures, atrPercentile50: 50 },
    prior: { exposure: 'flat', regime: 'trend' },
  },
  {
    kind: 'target',
    strategy: 'regime-adapter',
    features: { ...readyFeatures, atrPercentile50: 30 },
    prior: { exposure: 'flat', regime: 'trend' },
  },
  {
    kind: 'target',
    strategy: 'regime-adapter',
    features: { ...readyFeatures, atrPercentile50: null },
    prior: { exposure: 'flat', regime: null },
  },
  {
    kind: 'c27-exit',
    entryPrice: 100,
    close: 102,
    donchianMid: 90,
    barsHeld: 1,
  },
  {
    kind: 'c27-exit',
    entryPrice: 100,
    close: 99,
    donchianMid: null,
    barsHeld: 1,
  },
  {
    kind: 'c27-exit',
    entryPrice: 100,
    close: 100.4,
    donchianMid: 90,
    barsHeld: 8,
  },
  {
    kind: 'c27-exit',
    entryPrice: 100,
    close: 100.6,
    donchianMid: 90,
    barsHeld: 1,
  },
  { kind: 'macro-context', features: null },
  { kind: 'macro-context', features: readyFeatures },
  {
    kind: 'c27-exit-macro',
    entryPrice: 100,
    close: 99.5,
    macroContext: {
      atrPercentile50: null,
      donchianHigh20: null,
      donchianMid20: 100,
    },
    barsHeld: 1,
  },
  {
    kind: 'c27-exit-macro',
    entryPrice: 100,
    close: 99.5,
    macroContext: null,
    barsHeld: 1,
  },
  { kind: 'initial-state' },
]

function runTypeScriptOracle(input: ParityCase): unknown {
  if (input.kind === 'initial-state') return initialMicroState()
  if (input.kind === 'macro-context')
    return macroContextWhenReady(input.features)

  let diagnostic: MicroStrategyDiagnostic | undefined
  if (input.kind === 'c27-exit') {
    const reason = evaluateC27Exit(input, (value) => {
      diagnostic = value
    })
    return { reason, diagnostic }
  }
  if (input.kind === 'c27-exit-macro') {
    const reason = evaluateC27ExitWithMacroContext(input, (value) => {
      diagnostic = value
    })
    return { reason, diagnostic }
  }

  const result = evaluateMicroTarget(
    input.strategy,
    input.features,
    input.prior,
    input.macroContext,
    (value) => {
      diagnostic = value
    },
  )
  return { ...result, diagnostic }
}

describe('historical Python strategy compatibility', () => {
  it('matches the unchanged TypeScript oracle for shared input cases', () => {
    const oracleResults = cases.map(runTypeScriptOracle)
    const python = spawnSync(
      'python3',
      [
        '-c',
        'import json, sys; from balancita_engine.legacy_micro_strategy import evaluate_payload; print(json.dumps([evaluate_payload(item) for item in json.load(sys.stdin)]))',
      ],
      {
        cwd: resolve(process.cwd(), '..'),
        env: {
          ...process.env,
          PYTHONPATH: resolve(process.cwd(), '../python'),
        },
        encoding: 'utf8',
        input: JSON.stringify(cases),
      },
    )

    expect(python.status, python.stderr).toBe(0)
    const compatibilityResults: unknown = JSON.parse(python.stdout)
    expect(compatibilityResults).toEqual(oracleResults)
    expect(cases).toHaveLength(23)
  })
})
