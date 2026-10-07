import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SimulationsReportFile } from './simulations-types.ts'
import { useSimulationsReport } from './useSimulationsReport.ts'

function reportFile(): SimulationsReportFile {
  return {
    version: 'simulations-report-file.v1',
    generatedAt: 1_000,
    instrumentId: 'BTC-EUR',
    importVersion: 'kraken-observations.v1',
    datasetHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    selectionPct: 0.7,
    reports: [],
  }
}

describe('useSimulationsReport', () => {
  it('loads the latest persisted report', async () => {
    const payload = reportFile()
    const seen: string[] = []
    const fetchFn: (input: string) => Promise<Response> = (input) => {
      seen.push(input)
      return Promise.resolve(Response.json(payload, { status: 200 }))
    }
    const spy = vi.fn(fetchFn)
    const { result } = renderHook(() => useSimulationsReport({ fetchFn: spy }))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.file).toEqual(payload)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(seen[0]).toContain('/api/intelligence/simulations')
  })

  it('maps a missing report to the empty state without throwing', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }))
    const { result } = renderHook(() => useSimulationsReport({ fetchFn }))
    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.file).toBeNull()
  })

  it('degrades a transport failure to error with retry support', async () => {
    let calls = 0
    const fetchFn: (input: string) => Promise<Response> = () => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('network down'))
      return Promise.resolve(Response.json(reportFile(), { status: 200 }))
    }
    const { result } = renderHook(() => useSimulationsReport({ fetchFn }))
    await waitFor(() => expect(result.current.status).toBe('error'))
    await act(async () => {
      await result.current.retry()
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('posts one refresh, disables duplicates and reloads the persisted report', async () => {
    let finish!: (response: Response) => void
    let reads = 0
    let posts = 0
    const fetchFn = vi.fn(
      (_: string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'POST') {
          posts++
          return new Promise((resolve) => {
            finish = resolve
          })
        }
        reads++
        return Promise.resolve(Response.json(reportFile()))
      },
    )
    const { result } = renderHook(() => useSimulationsReport({ fetchFn }))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.refresh()
      void result.current.refresh()
    })
    expect(posts).toBe(1)
    expect(result.current.refreshing).toBe(true)
    await act(async () => {
      finish(Response.json({ status: 'updated' }))
      await refresh
    })
    await waitFor(() => expect(reads).toBe(4))
    expect(result.current.refreshing).toBe(false)
  })

  it('loads bounded history, fetches a selected report, and reloads history after refresh', async () => {
    const latest = reportFile()
    const prior = { ...latest, generatedAt: 500 }
    const history = [
      {
        id: 'a'.repeat(64),
        generatedAt: 1_000,
        datasetHash: latest.datasetHash,
        manifestHash: latest.manifestHash,
      },
      {
        id: 'b'.repeat(64),
        generatedAt: 500,
        datasetHash: prior.datasetHash,
        manifestHash: prior.manifestHash,
        sample: { stage: 'smoke', seed: 9 },
      },
    ]
    let selected = false
    let indexLoads = 0
    const fetchFn = vi.fn(async (input: string) => {
      if (input.endsWith('/refresh'))
        return Response.json({ status: 'updated' })
      if (input.includes('/history?')) {
        indexLoads += 1
        return Response.json({ reports: history })
      }
      if (input.includes('/history/')) {
        selected = true
        return Response.json(prior)
      }
      return Response.json(latest)
    })
    const { result } = renderHook(() => useSimulationsReport({ fetchFn }))
    await waitFor(() => expect(result.current.history).toHaveLength(2))
    await act(async () => result.current.selectHistory(history[1]!.id))
    await waitFor(() => expect(result.current.file?.generatedAt).toBe(500))
    expect(selected).toBe(true)
    await act(async () => result.current.refresh())
    await waitFor(() => expect(indexLoads).toBeGreaterThan(1))
    await waitFor(() => expect(result.current.file?.generatedAt).toBe(1_000))
  })

  it('returns to the latest report when history selection is cleared', async () => {
    const latest = { ...reportFile(), generatedAt: 2_000 }
    const archived = { ...reportFile(), generatedAt: 1_000 }
    const archiveId = 'c'.repeat(64)
    const requested: string[] = []
    const fetchFn = vi.fn(async (input: string) => {
      requested.push(input)
      if (input.includes('/history/')) return Response.json(archived)
      if (input.endsWith('/history?limit=50')) {
        return Response.json({
          reports: [
            {
              id: archiveId,
              generatedAt: archived.generatedAt,
              datasetHash: archived.datasetHash,
              manifestHash: archived.manifestHash,
            },
          ],
        })
      }
      return Response.json(latest)
    })
    const { result } = renderHook(() => useSimulationsReport({ fetchFn }))
    await waitFor(() => expect(result.current.file?.generatedAt).toBe(2_000))
    await act(async () => result.current.selectHistory(archiveId))
    await waitFor(() => expect(result.current.file?.generatedAt).toBe(1_000))
    await act(async () => result.current.selectHistory(''))
    await waitFor(() => expect(result.current.selectedHistoryId).toBeNull())
    await waitFor(() => expect(result.current.file?.generatedAt).toBe(2_000))
    expect(requested).toContain(
      'http://127.0.0.1:8787/api/intelligence/simulations',
    )
  })
})
