import { beforeEach, describe, expect, it } from 'vitest'
import { AlertCorruptError, type Alert } from '../domain/alerts.ts'
import { LocalStorageAlertRepository } from './local-storage-alert-repository.ts'

const STORAGE_KEY = 'balancita:alerts'

const BTC_ABOVE: Alert = {
  id: 'a1',
  instrumentId: 'BTC-EUR',
  direction: 'above',
  thresholdPrice: 60_000,
  status: 'active',
  createdAt: '2026-09-20T12:00:00.000Z',
}

const TTWO_BELOW: Alert = {
  id: 'a2',
  instrumentId: 'TTWO',
  direction: 'below',
  thresholdPrice: 140,
  status: 'active',
  createdAt: '2026-09-20T12:00:01.000Z',
}

function repository(): LocalStorageAlertRepository {
  return new LocalStorageAlertRepository()
}

beforeEach(() => {
  localStorage.clear()
})

describe('LocalStorageAlertRepository', () => {
  it('returns an empty list when nothing was stored', async () => {
    await expect(repository().list()).resolves.toEqual([])
  })

  it('persists an added alert and reads it back', async () => {
    await repository().add(BTC_ABOVE)
    await expect(repository().list()).resolves.toEqual([BTC_ABOVE])
  })

  it('adds several alerts and lists them all', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.add(TTWO_BELOW)
    await expect(repo.list()).resolves.toEqual([BTC_ABOVE, TTWO_BELOW])
  })

  it('replaces the alert with the same id on add', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.add({
      ...BTC_ABOVE,
      thresholdPrice: 65_000,
      status: 'triggered',
    })
    await expect(repo.list()).resolves.toEqual([
      { ...BTC_ABOVE, thresholdPrice: 65_000, status: 'triggered' },
    ])
  })

  it('removes an alert and keeps the others', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.add(TTWO_BELOW)
    await repo.remove('a1')
    await expect(repo.list()).resolves.toEqual([TTWO_BELOW])
  })

  it('removing an unknown id is a no-op', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.remove('missing')
    await expect(repo.list()).resolves.toEqual([BTC_ABOVE])
  })

  it('clears every alert', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.add(TTWO_BELOW)
    await repo.clear()
    await expect(repo.list()).resolves.toEqual([])
  })

  it('stores only the schema version and the alerts, without prices or zones', async () => {
    const repo = repository()
    await repo.add(BTC_ABOVE)
    await repo.add(TTWO_BELOW)
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as {
      version: unknown
      alerts: unknown
      zones?: unknown
      prices?: unknown
      crossings?: unknown
    }
    expect(parsed).toEqual({
      version: 1,
      alerts: [BTC_ABOVE, TTWO_BELOW],
    })
    expect(parsed.zones).toBeUndefined()
    expect(parsed.prices).toBeUndefined()
    expect(parsed.crossings).toBeUndefined()
  })

  describe('corrupt stored data', () => {
    it('rejects when the stored value is not valid JSON', async () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json')
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when the stored value is not an object', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(['a1']))
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when the schema version is unsupported', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 2, alerts: [BTC_ABOVE] }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when alerts is missing', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }))
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when alerts is not a list', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, alerts: BTC_ABOVE }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when an alert lacks a valid id', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, alerts: [{ ...BTC_ABOVE, id: '' }] }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when an alert lacks a valid instrumentId', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          alerts: [{ ...BTC_ABOVE, instrumentId: '' }],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when an alert has an unknown direction', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          alerts: [{ ...BTC_ABOVE, direction: 'up' }],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when an alert has a non-positive or non-finite threshold', async () => {
      const seeds = [0, -60_000, NaN, Infinity]
      for (const thresholdPrice of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            alerts: [{ ...BTC_ABOVE, thresholdPrice }],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          AlertCorruptError,
        )
      }
    })

    it('rejects when an alert has an unknown status', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          alerts: [{ ...BTC_ABOVE, status: 'fired' }],
        }),
      )
      await expect(repository().list()).rejects.toBeInstanceOf(
        AlertCorruptError,
      )
    })

    it('rejects when an alert has an invalid createdAt', async () => {
      const seeds = ['', 'not-a-date']
      for (const createdAt of seeds) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            alerts: [{ ...BTC_ABOVE, createdAt }],
          }),
        )
        await expect(repository().list()).rejects.toBeInstanceOf(
          AlertCorruptError,
        )
      }
    })

    it('rejects a write when the alert itself is invalid', async () => {
      await expect(
        repository().add({ ...BTC_ABOVE, thresholdPrice: 0 }),
      ).rejects.toBeInstanceOf(AlertCorruptError)
    })
  })
})
