import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SimulationsReportFile } from './simulations-types'
import { useSimulationsReport } from './useSimulationsReport'

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
    expect(spy).toHaveBeenCalledTimes(1)
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
})
