import { STRATEGY_SCHEMA, type StrategySpec } from '../domain/strategy-spec.ts'

/**
 * C25-C28 transcribed by hand from python/balancita_engine/futures_strategies.py
 * into the spec vocabulary, so the Laboratorio can show and vary them before
 * PS-08a rewrites them as specs with a parity test. Until then the engine's
 * Python code is the source of truth and these are an approximation.
 */
const common = {
  schema: STRATEGY_SCHEMA,
  version: 1,
  products: ['PF_XBTUSD'],
  horizon_minutes: 0,
} satisfies Partial<StrategySpec>

export const C25: StrategySpec = {
  ...common,
  id: 'c25-pullback-perp-v1',
  name: 'retroceso',
  description:
    'Entra cuando el precio vuelve a la EMA 21 dentro de una tendencia de 5 minutos y retoma la EMA 9.',
  regime: [],
  params: {
    rsi_min: '45',
    rsi_max: '65',
    rsi_short_min: '35',
    rsi_short_max: '55',
  },
  entry: {
    LONG: {
      all: [
        { left: '5m.ema9', op: '>', right: '5m.ema21' },
        { left: 'prev.candidate_low', op: '<=', right: 'prev.ema21' },
        { left: 'prev.candidate_close', op: '<=', right: 'prev.ema9' },
        { left: '1m.candidate_close', op: '>', right: '1m.ema9' },
        { left: '1m.rsi14', op: '>=', right: '$rsi_min' },
        { left: '1m.rsi14', op: '<=', right: '$rsi_max' },
      ],
    },
    SHORT: {
      all: [
        { left: '5m.ema9', op: '<', right: '5m.ema21' },
        { left: 'prev.candidate_high', op: '>=', right: 'prev.ema21' },
        { left: 'prev.candidate_close', op: '>=', right: 'prev.ema9' },
        { left: '1m.candidate_close', op: '<', right: '1m.ema9' },
        { left: '1m.rsi14', op: '>=', right: '$rsi_short_min' },
        { left: '1m.rsi14', op: '<=', right: '$rsi_short_max' },
      ],
    },
  },
  exit: {
    LONG: { left: '1m.candidate_close', op: '<', right: '1m.ema21' },
    SHORT: { left: '1m.candidate_close', op: '>', right: '1m.ema21' },
  },
  risk: { stop_atr: '1.5', target_atr: '3' },
}

export const C26: StrategySpec = {
  ...common,
  id: 'c26-reversion-perp-v1',
  name: 'reversión',
  description:
    'En rango, entra cuando el RSI vuelve a cruzar 30 o 70 y busca la media de Bollinger.',
  regime: ['range'],
  params: { rsi_low: '30', rsi_high: '70' },
  entry: {
    LONG: {
      all: [
        { left: 'prev.rsi14', op: '<', right: '$rsi_low' },
        { left: '1m.rsi14', op: '>=', right: '$rsi_low' },
      ],
    },
    SHORT: {
      all: [
        { left: 'prev.rsi14', op: '>', right: '$rsi_high' },
        { left: '1m.rsi14', op: '<=', right: '$rsi_high' },
      ],
    },
  },
  exit: {
    LONG: { left: '1m.candidate_close', op: '>=', right: '1m.bollinger_mid20' },
    SHORT: {
      left: '1m.candidate_close',
      op: '<=',
      right: '1m.bollinger_mid20',
    },
  },
  risk: { stop_atr: '1.5', target_atr: '3' },
}

export const C27: StrategySpec = {
  ...common,
  id: 'c27-breakout-perp-v1',
  name: 'ruptura',
  description:
    'Entra cuando el cierre rompe el canal Donchian de 20 velas con volumen 1,25 veces sobre la media.',
  regime: [],
  params: { volume_mult: '1.25' },
  entry: {
    LONG: {
      all: [
        { left: '1m.candidate_close', op: '>', right: '1m.donchian_high20' },
        {
          left: '1m.volume',
          op: '>',
          right: '1m.prior_volume_mean20',
          scale: '$volume_mult',
        },
      ],
    },
    SHORT: {
      all: [
        { left: '1m.candidate_close', op: '<', right: '1m.donchian_low20' },
        {
          left: '1m.volume',
          op: '>',
          right: '1m.prior_volume_mean20',
          scale: '$volume_mult',
        },
      ],
    },
  },
  exit: {
    LONG: { left: '1m.candidate_close', op: '<', right: '1m.donchian_mid20' },
    SHORT: { left: '1m.candidate_close', op: '>', right: '1m.donchian_mid20' },
  },
  risk: { stop_atr: '1.5', target_atr: '3' },
}

export const C28: StrategySpec = {
  ...common,
  id: 'c28-adapter-perp-v1',
  name: 'adaptador',
  description:
    'Usa C25 cuando el mercado está en tendencia y C26 cuando está en rango.',
  regime: [],
  params: {},
  entry: { LONG: null, SHORT: null },
  exit: { LONG: null, SHORT: null },
  risk: { stop_atr: '1.5', target_atr: '3' },
  delegate: { trend: C25.id, range: C26.id },
}

export const BASE_STRATEGIES: readonly StrategySpec[] = [C25, C26, C27, C28]

/** Starting point for "Nueva estrategia": the doc's X19 band + RSI idea. */
export function newStrategyTemplate(id: string): StrategySpec {
  return {
    ...common,
    id,
    name: 'banda + RSI',
    description: 'Rebote en la banda inferior de Bollinger con RSI bajo.',
    regime: ['range'],
    params: { rsi_entry: '30', rsi_exit: '70' },
    entry: {
      LONG: {
        all: [
          {
            left: '1m.candidate_close',
            op: '<',
            right: '1m.bollinger_lower20',
          },
          { left: '1m.rsi14', op: '<', right: '$rsi_entry' },
        ],
      },
      SHORT: null,
    },
    exit: {
      LONG: { left: '1m.rsi14', op: '>', right: '$rsi_exit' },
      SHORT: null,
    },
    risk: { stop_atr: '1.5', target_atr: '3' },
    horizon_minutes: 30,
  }
}
