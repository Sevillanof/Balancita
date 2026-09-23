import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SimulationsReportFile,
  SimulationsStatus,
} from './simulations-types.ts'

export type UseSimulationsReportResult = {
  readonly status: SimulationsStatus
  readonly file: SimulationsReportFile | null
  readonly error: Error | null
  readonly retry: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly refreshing: boolean
  readonly refreshError: string | null
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
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
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refreshInFlight = useRef(false)

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

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    setRefreshError(null)
    try {
      const response = await fetchFn(`${url}/refresh`, { method: 'POST' })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        const message =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'object' &&
          payload.error !== null &&
          'message' in payload.error &&
          typeof payload.error.message === 'string'
            ? payload.error.message
            : `No se pudo actualizar (${response.status}).`
        throw new Error(message)
      }
      setReloadKey((key) => key + 1)
    } catch (error) {
      setRefreshError(
        error instanceof Error ? error.message : 'No se pudo actualizar.',
      )
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [fetchFn, url])

  const refreshState = { refresh, refreshing, refreshError }

  if (result === null)
    return {
      status: 'loading',
      file: null,
      error: null,
      retry,
      ...refreshState,
    }
  if (result.kind === 'ready')
    return {
      status: 'ready',
      file: result.file,
      error: null,
      retry,
      ...refreshState,
    }
  if (result.kind === 'empty')
    return { status: 'empty', file: null, error: null, retry, ...refreshState }
  return {
    status: 'error',
    file: null,
    error: result.error,
    retry,
    ...refreshState,
  }
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
