import type {
  Candle,
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'

export type Clock = () => number | Date

type InstrumentConfig = {
  instrument: Instrument
  basePrice: number
  dailyVolatility: number
  quoteStepVolatility: number
  volumeBase: number
  volumeRange: number
}

const HISTORY_BARS = 30
const BAR_MS = 24 * 60 * 60 * 1000
const HISTORY_END_MS = Date.UTC(2024, 0, 1)
const DEFAULT_INTERVAL_MS = 1_000

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function toTick(value: number): number {
  return Math.round(value * 100) / 100
}

const MOCK_CATALOG: readonly InstrumentConfig[] = [
  {
    instrument: {
      id: 'BTC-EUR',
      symbol: 'BTC-EUR',
      displayName: 'Bitcoin / Euro',
      assetClass: 'crypto',
      currency: 'EUR',
      exchange: 'Coinbase',
      providerSymbols: { mock: 'BTC-EUR' },
    },
    basePrice: 60_000,
    dailyVolatility: 0.03,
    quoteStepVolatility: 0.004,
    volumeBase: 1_000,
    volumeRange: 99_000,
  },
  {
    instrument: {
      id: 'TTWO',
      symbol: 'TTWO',
      displayName: 'Take-Two Interactive',
      assetClass: 'equity',
      currency: 'USD',
      exchange: 'NASDAQ',
      providerSymbols: { mock: 'TTWO' },
    },
    basePrice: 150,
    dailyVolatility: 0.02,
    quoteStepVolatility: 0.003,
    volumeBase: 100,
    volumeRange: 9_900,
  },
  {
    instrument: {
      id: 'SPCX',
      symbol: 'SPCX',
      // SPCX identity pending verification; USD is a mock placeholder only.
      // No exchange or asset class is assumed from the ticker.
      displayName: 'SPCX',
      assetClass: 'unknown',
      currency: 'USD',
      providerSymbols: { mock: 'SPCX' },
    },
    basePrice: 10,
    dailyVolatility: 0.05,
    quoteStepVolatility: 0.006,
    volumeBase: 500,
    volumeRange: 49_500,
  },
]

type QuoteState = {
  lastPrice: number
  rng: () => number
  stepVolatility: number
}

export class DeterministicMockMarketDataProvider implements MarketDataProvider {
  private readonly seed: number
  private readonly clock: Clock
  private readonly intervalMs: number
  private readonly configs = new Map<InstrumentId, InstrumentConfig>()

  constructor(
    seed: number,
    clock: Clock = () => new Date(),
    intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {
    this.seed = seed
    this.clock = clock
    this.intervalMs = intervalMs
    for (const config of MOCK_CATALOG) {
      this.configs.set(config.instrument.id, config)
    }
  }

  async getInstruments(): Promise<Instrument[]> {
    return MOCK_CATALOG.map((config) => ({ ...config.instrument }))
  }

  async getHistory(instrumentId: InstrumentId): Promise<Candle[]> {
    const config = this.configs.get(instrumentId)
    if (!config) {
      throw new Error(`Unknown instrument: ${instrumentId}`)
    }

    const rng = this.rngFor(instrumentId)
    const candles: Candle[] = []
    let previousClose = config.basePrice

    for (let i = 0; i < HISTORY_BARS; i++) {
      const time = new Date(
        HISTORY_END_MS - (HISTORY_BARS - 1 - i) * BAR_MS,
      ).toISOString()
      const open = previousClose
      const close = toTick(open * (1 + (rng() - 0.5) * config.dailyVolatility))
      const high = Math.max(
        toTick(Math.max(open, close) * (1 + 0.001 + rng() * 0.3)),
        open,
        close,
      )
      const low = Math.min(
        toTick(Math.min(open, close) * (1 - 0.001 - rng() * 0.3)),
        open,
        close,
      )
      const volume = Math.round(config.volumeBase + rng() * config.volumeRange)

      candles.push({ time, open, high, low, close, volume })
      previousClose = close
    }

    return candles
  }

  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
  ): () => void {
    const missing = instrumentIds.filter((id) => !this.configs.has(id))
    if (missing.length > 0) {
      throw new Error(`Unknown instrument: ${missing.join(', ')}`)
    }

    const states = new Map<InstrumentId, QuoteState>()
    for (const id of instrumentIds) {
      const config = this.configs.get(id)!
      states.set(id, {
        lastPrice: this.lastClose(id, config),
        rng: this.rngFor(id),
        stepVolatility: config.quoteStepVolatility,
      })
    }

    const emit = () => {
      const timestamp = new Date(this.clock()).toISOString()
      for (const id of instrumentIds) {
        const state = states.get(id)!
        const price = toTick(
          state.lastPrice * (1 + (state.rng() - 0.5) * state.stepVolatility),
        )
        const change = toTick(price - state.lastPrice)
        const changePercent = toTick((change / state.lastPrice) * 100)

        onQuote({
          instrumentId: id,
          price,
          change,
          changePercent,
          timestamp,
          status: 'mock',
        })
        state.lastPrice = price
      }
    }

    const interval = setInterval(emit, this.intervalMs)
    return () => clearInterval(interval)
  }

  private rngFor(instrumentId: InstrumentId): () => number {
    return mulberry32((this.seed >>> 0) ^ hashString(instrumentId))
  }

  private lastClose(
    instrumentId: InstrumentId,
    config: InstrumentConfig,
  ): number {
    const rng = this.rngFor(instrumentId)
    let close = config.basePrice
    for (let i = 0; i < HISTORY_BARS; i++) {
      close = toTick(close * (1 + (rng() - 0.5) * config.dailyVolatility))
    }
    return close
  }
}