import { beforeEach, describe, expect, it } from 'vitest'
import type { Instrument, Quote } from '../../market-data/domain/market-data.ts'
import {
  moneyFromString,
  moneyToNumber,
} from '../../../shared/finance/money.ts'
import type {
  Holding,
  PortfolioRepository,
} from '../../portfolio/domain/portfolio.ts'
import {
  BUY,
  IdempotencyConflictError,
  MissingOrUnknownPreviewError,
  PreviewOutdatedError,
  SELL,
  type OrderIntent,
} from '../domain/orders.ts'
import {
  BTC_EUR,
  TTWO,
} from '../../../shared/testing/fake-market-data-provider'
import {
  LocalPaperTradingProvider,
  type PaperTradingMarketSource,
} from './local-paper-trading-provider.ts'

class MemoryPortfolioRepository implements PortfolioRepository {
  private readonly holdings: Holding[] = []

  constructor(seed: readonly Holding[] = []) {
    this.holdings.push(...seed)
  }

  async list(): Promise<readonly Holding[]> {
    return [...this.holdings]
  }

  async add(holding: Holding): Promise<void> {
    const index = this.holdings.findIndex(
      (h) => h.instrumentId === holding.instrumentId,
    )
    if (index === -1) {
      this.holdings.push(holding)
    } else {
      this.holdings[index] = holding
    }
  }

  async remove(instrumentId: string): Promise<void> {
    const index = this.holdings.findIndex(
      (h) => h.instrumentId === instrumentId,
    )
    if (index !== -1) this.holdings.splice(index, 1)
  }

  async clear(): Promise<void> {
    this.holdings.length = 0
  }
}

class StubMarketSource implements PaperTradingMarketSource {
  readonly instruments = new Map<string, Instrument>()
  readonly prices = new Map<string, number>()

  constructor() {
    this.instruments.set(BTC_EUR.id, BTC_EUR)
    this.instruments.set(TTWO.id, TTWO)
    this.prices.set(BTC_EUR.id, 60_000)
    this.prices.set(TTWO.id, 140)
  }

  setPrice(instrumentId: string, price: number): void {
    this.prices.set(instrumentId, price)
  }

  async getInstrument(instrumentId: string): Promise<Instrument | null> {
    return this.instruments.get(instrumentId) ?? null
  }

  async getPrice(instrumentId: string): Promise<Quote | null> {
    const price = this.prices.get(instrumentId)
    if (price === undefined) return null
    return {
      instrumentId,
      price,
      change: 0,
      changePercent: 0,
      timestamp: new Date().toISOString(),
      status: 'mock',
    }
  }
}

const aBuy = (quantity: string, key: string): OrderIntent => ({
  instrumentId: 'BTC-EUR',
  side: BUY,
  quantity: moneyFromString(quantity),
  idempotencyKey: key,
})

const aSell = (quantity: string, key: string): OrderIntent => ({
  instrumentId: 'BTC-EUR',
  side: SELL,
  quantity: moneyFromString(quantity),
  idempotencyKey: key,
})

function freshProvider(
  market: StubMarketSource,
  portfolio: MemoryPortfolioRepository,
) {
  return new LocalPaperTradingProvider(market, portfolio, {
    initialCash: { EUR: 100_000, USD: 100_000 },
  })
}

describe('LocalPaperTradingProvider', () => {
  let market: StubMarketSource
  let portfolio: MemoryPortfolioRepository

  beforeEach(() => {
    window.localStorage.clear()
    market = new StubMarketSource()
    portfolio = new MemoryPortfolioRepository()
  })

  it('previews a buy at the current market price with zero costs', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'k1'))
    expect(preview.reference).toBe('P1')
    expect(preview.instrumentId).toBe('BTC-EUR')
    expect(preview.side).toBe(BUY)
    expect(preview.marketPrice).toEqual(moneyFromString('60000'))
    expect(preview.slippageApplied).toEqual(moneyFromString('0'))
    expect(preview.subtotal).toEqual(moneyFromString('30000'))
    expect(preview.estimatedTotal).toEqual(moneyFromString('30000'))
    expect(preview.currency).toBe('EUR')
  })

  it('increments preview references across calls', async () => {
    const provider = freshProvider(market, portfolio)
    const first = await provider.preview(aBuy('0.1', 'k1'))
    const second = await provider.preview(aBuy('0.1', 'k2'))
    expect(first.reference).toBe('P1')
    expect(second.reference).toBe('P2')
  })

  it('executes a buy, updates the position and deducts cash', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    const receipt = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })

    expect(receipt.id).toBe('R1')
    expect(receipt.status).toBe('executed')
    expect(receipt.executedPrice).toEqual(moneyFromString('60000'))
    expect(receipt.total).toEqual(moneyFromString('30000'))

    const [holding] = await portfolio.list()
    expect(holding).toEqual({
      instrumentId: 'BTC-EUR',
      quantity: moneyFromString('0.5'),
      averageCost: moneyFromString('60000'),
    })

    const account = await provider.account()
    expect(account.cash['EUR']).toEqual(moneyFromString('70000'))
  })

  it('rejects a buy that exceeds available cash', async () => {
    const provider = new LocalPaperTradingProvider(market, portfolio, {
      initialCash: { EUR: 0, USD: 0 },
    })
    const preview = await provider.preview(aBuy('2', 'poor-buy'))
    const receipt = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'poor-buy',
    })

    expect(receipt.status).toBe('rejected')
    expect(receipt.reason).toBe('insufficient-cash')
    expect(await portfolio.list()).toEqual([])
    const account = await provider.account()
    expect(account.cash['EUR']).toEqual(moneyFromString('0'))
  })

  it('executes a sell, credits cash and keeps the average cost', async () => {
    const provider = freshProvider(market, portfolio)
    const buy = await provider.preview(aBuy('0.5', 'buy-1'))
    await provider.submit({
      previewReference: buy.reference,
      idempotencyKey: 'buy-1',
    })

    market.setPrice('BTC-EUR', 64_000)
    const sell = await provider.preview(aSell('0.2', 'sell-1'))
    const receipt = await provider.submit({
      previewReference: sell.reference,
      idempotencyKey: 'sell-1',
    })

    expect(receipt.status).toBe('executed')
    expect(receipt.total).toEqual(moneyFromString('12800'))

    const [holding] = await portfolio.list()
    expect(holding.quantity).toEqual(moneyFromString('0.3'))
    expect(holding.averageCost).toEqual(moneyFromString('60000'))

    const account = await provider.account()
    expect(account.cash['EUR']).toEqual(moneyFromString('82800'))
  })

  it('rejects a sell that exceeds the held quantity', async () => {
    const provider = freshProvider(market, portfolio)
    const buy = await provider.preview(aBuy('0.5', 'buy-1'))
    await provider.submit({
      previewReference: buy.reference,
      idempotencyKey: 'buy-1',
    })

    const sell = await provider.preview(aSell('1', 'sell-1'))
    const receipt = await provider.submit({
      previewReference: sell.reference,
      idempotencyKey: 'sell-1',
    })

    expect(receipt.status).toBe('rejected')
    expect(receipt.reason).toBe('insufficient-position')
    const [holding] = await portfolio.list()
    expect(holding.quantity).toEqual(moneyFromString('0.5'))
  })

  it('charges slippage and commission on both preview and fill', async () => {
    const provider = new LocalPaperTradingProvider(market, portfolio, {
      slippage: 0.001,
      commission: 0.5,
      initialCash: { EUR: 100_000, USD: 100_000 },
    })
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    expect(preview.slippedPrice).toEqual(moneyFromString('60060'))
    expect(preview.estimatedTotal).toEqual(moneyFromString('30030.5'))

    const receipt = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })
    expect(receipt.slippedPrice).toEqual(moneyFromString('60060'))
    expect(receipt.commission).toEqual(moneyFromString('0.5'))
    expect(receipt.total).toEqual(moneyFromString('30030.5'))
    const account = await provider.account()
    expect(account.cash['EUR']).toEqual(moneyFromString('69969.5'))
  })

  it('uses an interchangeable percentage fee policy in the preview', async () => {
    const provider = new LocalPaperTradingProvider(market, portfolio, {
      feePolicy: {
        id: 'test-fee',
        label: 'Prueba: 0,1% con mínimo de 2 EUR',
        percentage: moneyFromString('0.001'),
        minimum: moneyFromString('2'),
        currency: 'EUR',
      },
      initialCash: { EUR: 100_000, USD: 100_000 },
    })

    const preview = await provider.preview(aBuy('0.5', 'fee-policy-buy'))
    expect(preview.commission).toEqual(moneyFromString('30'))
    expect(preview.feePolicy?.id).toBe('test-fee')
    expect(preview.estimatedTotal).toEqual(moneyFromString('30030'))
  })

  it('is idempotent for the same key and preview reference', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    const first = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })
    const second = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })

    expect(second).toEqual(first)
    expect(second.id).toBe('R1')

    const account = await provider.account()
    expect(account.history).toHaveLength(1)
    expect(account.cash['EUR']).toEqual(moneyFromString('70000'))
  })

  it('replays a rejected receipt idempotently', async () => {
    const provider = new LocalPaperTradingProvider(market, portfolio, {
      initialCash: { EUR: 0, USD: 0 },
    })
    const preview = await provider.preview(aBuy('2', 'poor-buy'))
    const first = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'poor-buy',
    })
    const second = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'poor-buy',
    })

    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(second).toEqual(first)
  })

  it('conflicts when the same key confirms a different preview', async () => {
    const provider = freshProvider(market, portfolio)
    const one = await provider.preview(aBuy('0.5', 'k'))
    await provider.submit({
      previewReference: one.reference,
      idempotencyKey: 'k',
    })

    const two = await provider.preview(aBuy('0.1', 'k'))
    await expect(
      provider.submit({ previewReference: two.reference, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('rejects confirmation for an unknown or consumed preview', async () => {
    const provider = freshProvider(market, portfolio)
    await expect(
      provider.submit({ previewReference: 'P99', idempotencyKey: 'x' }),
    ).rejects.toBeInstanceOf(MissingOrUnknownPreviewError)
  })

  it('fails the confirmation when the market drifted beyond tolerance', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))

    market.setPrice('BTC-EUR', 60_400)

    await expect(
      provider.submit({
        previewReference: preview.reference,
        idempotencyKey: 'buy-1',
      }),
    ).rejects.toBeInstanceOf(PreviewOutdatedError)

    await expect(
      provider.submit({
        previewReference: preview.reference,
        idempotencyKey: 'buy-1',
      }),
    ).rejects.toBeInstanceOf(MissingOrUnknownPreviewError)
  })

  it('accepts a confirmation within tolerance', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    market.setPrice('BTC-EUR', 60_250)
    const receipt = await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })
    expect(receipt.status).toBe('executed')
  })

  it('removes the holding entirely when a sell closes the position', async () => {
    const provider = freshProvider(market, portfolio)
    const buy = await provider.preview(aBuy('0.5', 'buy-1'))
    await provider.submit({
      previewReference: buy.reference,
      idempotencyKey: 'buy-1',
    })
    const sell = await provider.preview(aSell('0.5', 'sell-1'))
    const receipt = await provider.submit({
      previewReference: sell.reference,
      idempotencyKey: 'sell-1',
    })
    expect(receipt.status).toBe('executed')
    expect(await portfolio.list()).toEqual([])
  })

  it('persists receipts across provider instances', async () => {
    const first = freshProvider(market, portfolio)
    const preview = await first.preview(aBuy('0.5', 'buy-1'))
    await first.submit({
      previewReference: preview.reference,
      idempotencyKey: 'buy-1',
    })

    const second = freshProvider(market, portfolio)
    const account = await second.account()
    expect(account.history).toHaveLength(1)
    expect(account.history[0].status).toBe('executed')
    expect(moneyToNumber(account.cash['EUR'])).toBeCloseTo(70_000, 6)
  })

  it('recovers to a fresh account when stored simulator data is corrupt', async () => {
    window.localStorage.setItem('balancita:simulator', '{"not":"valid"}')
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    expect(preview).toBeDefined()
    const account = await provider.account()
    expect(moneyToNumber(account.cash['EUR'])).toBeCloseTo(100_000, 6)
  })

  it('rejects confirmation of a preview that already failed', async () => {
    const provider = freshProvider(market, portfolio)
    const preview = await provider.preview(aBuy('0.5', 'buy-1'))
    market.setPrice('BTC-EUR', 60_400)
    await provider
      .submit({ previewReference: preview.reference, idempotencyKey: 'buy-1' })
      .catch(() => undefined)
    await expect(
      provider.submit({
        previewReference: preview.reference,
        idempotencyKey: 'buy-1',
      }),
    ).rejects.toBeInstanceOf(MissingOrUnknownPreviewError)
  })
})
