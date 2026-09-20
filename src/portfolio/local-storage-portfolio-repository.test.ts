import { beforeEach, describe, expect, it } from 'vitest'
import { PortfolioCorruptError, type Holding } from '../domain/portfolio'
import { LocalStoragePortfolioRepository } from './local-storage-portfolio-repository'

const STORAGE_KEY = 'balancita:portfolio'

const BTC: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: 0.5,
  averageCost: 50_000,
}

const TTWO: Holding = {
  instrumentId: 'TTWO',
  quantity: 10,
  averageCost: 140,
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
    await repo.add({ ...BTC, quantity: 1, averageCost: 55_000 })
    await expect(repo.list()).resolves.toEqual([
      { instrumentId: 'BTC-EUR', quantity: 1, averageCost: 55_000 },
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

  it('stores only the schema version and the holdings', async () => {
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
      version: 1,
      holdings: [BTC, TTWO],
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
        JSON.stringify({ version: 2, holdings: [BTC] }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when holdings is missing', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }))
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when holdings is not a list', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, holdings: BTC }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when a holding lacks a valid instrumentId', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          holdings: [{ ...BTC, instrumentId: '' }],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        PortfolioCorruptError,
      )
    })

    it('rejects when a holding has a non-positive quantity', async () => {
      const seeds = [0, -4, NaN]
      for (const quantity of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            holdings: [{ ...BTC, quantity }],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          PortfolioCorruptError,
        )
      }
    })

    it('rejects when a holding has a non-positive average cost', async () => {
      const seeds = [0, -50_000, NaN]
      for (const averageCost of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            holdings: [{ ...BTC, averageCost }],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          PortfolioCorruptError,
        )
      }
    })

    it('rejects a write when the holding itself is invalid', async () => {
      await expect(
        repository().add({ ...BTC, quantity: 0 }),
      ).rejects.toBeInstanceOf(PortfolioCorruptError)
    })
  })
})
