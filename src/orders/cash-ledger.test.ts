import { beforeEach, describe, expect, it } from 'vitest'
import { moneyFromString } from '../domain/money'
import type { Instrument, Quote } from '../domain/market-data'
import type { Holding, PortfolioRepository } from '../domain/portfolio'
import { BUY } from '../domain/orders'
import { BTC_EUR } from '../test/fake-market-data-provider'
import {
  CashMovementIdempotencyConflictError,
  InsufficientVirtualCashError,
  LocalPaperTradingProvider,
  type PaperTradingMarketSource,
} from './local-paper-trading-provider'

class MemoryPortfolio implements PortfolioRepository {
  private holdings: Holding[] = []

  async list(): Promise<readonly Holding[]> {
    return [...this.holdings]
  }

  async add(holding: Holding): Promise<void> {
    const index = this.holdings.findIndex(
      (current) => current.instrumentId === holding.instrumentId,
    )
    if (index === -1) this.holdings.push(holding)
    else this.holdings[index] = holding
  }

  async remove(instrumentId: string): Promise<void> {
    this.holdings = this.holdings.filter(
      (holding) => holding.instrumentId !== instrumentId,
    )
  }

  async clear(): Promise<void> {
    this.holdings = []
  }
}

class Market implements PaperTradingMarketSource {
  async getInstrument(instrumentId: string): Promise<Instrument | null> {
    return instrumentId === BTC_EUR.id ? BTC_EUR : null
  }

  async getPrice(instrumentId: string): Promise<Quote | null> {
    return instrumentId === BTC_EUR.id
      ? {
          instrumentId,
          price: 60_000,
          change: 0,
          changePercent: 0,
          timestamp: '2026-09-20T12:00:00.000Z',
          status: 'mock',
        }
      : null
  }
}

describe('virtual cash ledger', () => {
  beforeEach(() => window.localStorage.clear())

  it('appends deposits and withdrawals with deterministic balances', async () => {
    const provider = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
      {
        now: () => 1_700_000_000_000,
      },
    )

    const deposit = await provider.deposit('EUR', moneyFromString('250'), {
      note: 'Aporte de prueba',
      idempotencyKey: 'deposit-1',
    })
    const withdrawal = await provider.withdraw('EUR', moneyFromString('40'), {
      note: 'Retiro de prueba',
      idempotencyKey: 'withdrawal-1',
    })

    expect(deposit.balance).toEqual(moneyFromString('10250'))
    expect(withdrawal.balance).toEqual(moneyFromString('10210'))
    expect((await provider.account()).movements).toHaveLength(2)
  })

  it('persists movements and rejects insufficient cash', async () => {
    const first = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
    )
    await first.deposit('EUR', moneyFromString('10'))

    const second = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
    )
    await expect(
      second.withdraw('EUR', moneyFromString('20000')),
    ).rejects.toBeInstanceOf(InsufficientVirtualCashError)
    expect((await second.account()).movements).toHaveLength(1)
  })

  it('is idempotent and detects a conflicting movement payload', async () => {
    const provider = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
    )
    const first = await provider.deposit('EUR', moneyFromString('10'), {
      idempotencyKey: 'same',
    })
    const replay = await provider.deposit('EUR', moneyFromString('10'), {
      idempotencyKey: 'same',
    })

    expect(replay).toEqual(first)
    await expect(
      provider.deposit('EUR', moneyFromString('11'), {
        idempotencyKey: 'same',
      }),
    ).rejects.toBeInstanceOf(CashMovementIdempotencyConflictError)
    expect((await provider.account()).movements).toHaveLength(1)
  })

  it('keeps ledger movements isolated from order receipts', async () => {
    const provider = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
    )
    await provider.deposit('EUR', moneyFromString('100000'))
    const preview = await provider.preview({
      instrumentId: 'BTC-EUR',
      side: BUY,
      quantity: moneyFromString('0.1'),
      idempotencyKey: 'order-1',
    })
    await provider.submit({
      previewReference: preview.reference,
      idempotencyKey: 'order-1',
    })

    const account = await provider.account()
    expect(account.movements).toHaveLength(1)
    expect(account.history).toHaveLength(1)
  })

  it('resets a corrupt or unsupported versioned ledger payload safely', async () => {
    window.localStorage.setItem(
      'balancita:simulator',
      JSON.stringify({
        version: 2,
        cash: { EUR: '10000' },
        nextPreviewNumber: 1,
        nextReceiptNumber: 1,
        nextMovementNumber: 2,
        usedKeys: {},
        consumedPreviews: [],
        history: [],
        movements: [{ id: 'M1', type: 'deposit', amount: 'broken' }],
        movementKeys: {},
      }),
    )
    const provider = new LocalPaperTradingProvider(
      new Market(),
      new MemoryPortfolio(),
    )
    expect((await provider.account()).movements).toHaveLength(0)
    expect((await provider.account()).cash.EUR).toEqual(
      moneyFromString('10000'),
    )

    window.localStorage.setItem(
      'balancita:simulator',
      JSON.stringify({ version: 99 }),
    )
    expect((await provider.account()).movements).toHaveLength(0)
  })
})
