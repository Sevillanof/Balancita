import { beforeEach, describe, expect, it } from 'vitest'
import { MONEY_ZERO, moneyFromString } from '../domain/money'
import { PortfolioCorruptError, type Holding } from '../domain/portfolio'
import { LocalStoragePortfolioRepository } from './local-storage-portfolio-repository'

const STORAGE_KEY = 'balancita:portfolio'

const BTC: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: moneyFromString('0.5'),
  averageCost: moneyFromString('50000'),
}

const TTWO: Holding = {
  instrumentId: 'TTWO',
  quantity: moneyFromString('10'),
  averageCost: moneyFromString('140'),
}

function repository(): LocalStoragePortfolioRepository {
  return new LocalStoragePortfolioRepository()
}

beforeEach(() => {
  localStorage.clear()
})

describe('LocalStoragePortfolioRepository', () => {
  it('returns an empty list when nothing was stored', async () => {
    await expect(repository().list()).resolves.toEqual([])
  })

  it('persists an added holding and reads it back', async () => {
    await repository().add(BTC)
    await expect(repository().list()).resolves.toEqual([BTC])
  })

  it('adds several holdings and lists them all', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.add(TTWO)
    await expect(repo.list()).resolves.toEqual([BTC, TTWO])
  })

  it('replaces the holding for the same instrument on add', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.add({
      instrumentId: 'BTC-EUR',
      quantity: moneyFromString('1'),
      averageCost: moneyFromString('55000'),
    })
    await expect(repo.list()).resolves.toEqual([
      {
        instrumentId: 'BTC-EUR',
        quantity: moneyFromString('1'),
        averageCost: moneyFromString('55000'),
      },
    ])
  })

  it('removes a holding and keeps the others', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.add(TTWO)
    await repo.remove('BTC-EUR')
    await expect(repo.list()).resolves.toEqual([TTWO])
  })

  it('removing an unknown instrument is a no-op', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.remove('SPCX')
    await expect(repo.list()).resolves.toEqual([BTC])
  })

  it('clears every holding', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.add(TTWO)
    await repo.clear()
    await expect(repo.list()).resolves.toEqual([])
  })

  it('stores only the schema version and decimal-string holdings', async () => {
    const repo = repository()
    await repo.add(BTC)
    await repo.add(TTWO)
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as {
      version: unknown
      holdings: unknown
      quotes?: unknown
      totals?: unknown
    }
    expect(parsed).toEqual({
      version: 2,
      holdings: [
        { instrumentId: 'BTC-EUR', quantity: '0.5', averageCost: '50000' },
        { instrumentId: 'TTWO', quantity: '10', averageCost: '140' },
      ],
    })
    expect(parsed.quotes).toBeUndefined()
    expect(parsed.totals).toBeUndefined()
  })

  describe('corrupt stored data', () => {
    it('rejects when the stored value is not valid JSON', async () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json')
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when the stored value is not an object', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['BTC-EUR']))
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when the schema version is unsupported', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 3, holdings: [] }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when the schema version is missing', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ holdings: [] }))
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when holdings is missing', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2 }))
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when holdings is not a list', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 2, holdings: {} }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects a v2 holding without a valid instrumentId', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 2,
          holdings: [
            { instrumentId: '', quantity: '0.5', averageCost: '50000' },
          ],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects a v2 holding with a non-positive quantity string', async () => {
      const seeds = ['0', '-4', 'abc', '1.000000001']
      for (const quantity of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 2,
            holdings: [
              { instrumentId: 'BTC-EUR', quantity, averageCost: '50000' },
            ],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          PortfolioCorruptError,
        )
      }
    })

    it('rejects a v2 holding with a non-positive average cost string', async () => {
      const seeds = ['0', '-50000', 'abc']
      for (const averageCost of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 2,
            holdings: [
              { instrumentId: 'BTC-EUR', quantity: '0.5', averageCost },
            ],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          PortfolioCorruptError,
        )
      }
    })

    it('rejects a write when the holding itself is invalid', async () => {
      await expect(
        repository().add({ ...BTC, quantity: MONEY_ZERO }),
      ).rejects.toBeInstanceOf(PortfolioCorruptError)
    })
  })

  describe('migration from schema v1 (number holdings)', () => {
    it('migrates a v1 payload to decimal holdings and rewrites storage as v2', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          holdings: [
            { instrumentId: 'BTC-EUR', quantity: 0.5, averageCost: 50_000 },
          ],
        }),
      )

      await expect(repository().list()).resolves.toEqual([BTC])

      const stored = JSON.parse(
        localStorage.getItem(STORAGE_KEY) as string,
      ) as { version: unknown; holdings: unknown }
      expect(stored).toEqual({
        version: 2,
        holdings: [
          { instrumentId: 'BTC-EUR', quantity: '0.5', averageCost: '50000' },
        ],
      })
    })

    it('migrates an empty v1 payload to an empty v2 portfolio', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, holdings: [] }),
      )

      await expect(repository().list()).resolves.toEqual([])
      const stored = JSON.parse(
        localStorage.getItem(STORAGE_KEY) as string,
      ) as { version: unknown }
      expect(stored.version).toBe(2)
    })

    it('rejects a v1 payload with an invalid holding', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          holdings: [{ instrumentId: 'BTC-EUR', quantity: 0, averageCost: 1 }],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })
  })
})
