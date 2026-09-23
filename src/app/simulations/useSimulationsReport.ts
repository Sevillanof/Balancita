import { useCallback, useEffect, useState } from 'react'
import type {
  SimulationsReportFile,
  SimulationsStatus,
} from './simulations-types'

export type UseSimulationsReportResult = {
  readonly status: SimulationsStatus
  readonly file: SimulationsReportFile | null
  readonly error: Error | null
  readonly retry: () => Promise<void>
}

type FetchFn = (input: string) => Promise<Response>

function defaultFetch(input: string): Promise<Response> {
  return globalThis.fetch(input)
}

function baseUrl(): string {
  const fromEnv =
    import.meta.env.VITE_INTELLIGENCE_SERVER_URL ??
    import.meta.env.VITE_GEMINI_SERVER_URL ??
    'http://127.0.0.1:8787'
  return String(fromEnv).replace(/\/$/, '')
}

function isReportFile(value: unknown): value is SimulationsReportFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as { reports?: unknown }
  return Array.isArray(file.reports)
}

type LoadResult =
  | { readonly kind: 'ready'; readonly file: SimulationsReportFile }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly error: Error }

/** Fetches the latest persisted simulations report; never triggers computation. */
export function useSimulationsReport(
  options: {
    readonly url?: string
    readonly fetchFn?: FetchFn
  } = {},
): UseSimulationsReportResult {
  const url = options.url ?? `${baseUrl()}/api/intelligence/simulations`
  const fetchFn = options.fetchFn ?? defaultFetch
  const [reloadKey, setReloadKey] = useState(0)
  const [result, setResult] = useState<LoadResult | null>(null)

  useEffect(() => {
    let active = true
    void loadReport(url, fetchFn).then((outcome) => {
      if (active) setResult(outcome)
    })
    return () => {
      active = false
    }
  }, [url, fetchFn, reloadKey])

  const retry = useCallback(async () => {
    setResult(null)
    setReloadKey((key) => key + 1)
  }, [])

  if (result === null)
    return { status: 'loading', file: null, error: null, retry }
  if (result.kind === 'ready')
    return { status: 'ready', file: result.file, error: null, retry }
  if (result.kind === 'empty')
    return { status: 'empty', file: null, error: null, retry }
  return { status: 'error', file: null, error: result.error, retry }
}

async function loadReport(url: string, fetchFn: FetchFn): Promise<LoadResult> {
  try {
    const response = await fetchFn(url)
    if (response.status === 404) return { kind: 'empty' }
    if (!response.ok) {
      return {
        kind: 'error',
        error: new Error(
          `Simulations request failed with status ${response.status}.`,
        ),
      }
    }
    const payload: unknown = await response.json()
    if (!isReportFile(payload)) {
      return {
        kind: 'error',
        error: new Error('Simulations report has an unexpected shape.'),
      }
    }
    return { kind: 'ready', file: payload }
  } catch (cause) {
    return {
      kind: 'error',
      error:
        cause instanceof Error ? cause : new Error('Simulations fetch failed.'),
    }
  }
}
