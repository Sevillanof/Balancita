import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SimulationsReportFile,
  SimulationsHistoryEntry,
  SimulationsStatus,
} from './simulations-types.ts'

export type UseSimulationsReportResult = {
  readonly status: SimulationsStatus
  readonly file: SimulationsReportFile | null
  readonly error: Error | null
  readonly retry: () => Promise<void>
  readonly refresh: (sample?: {
    readonly stage: 'smoke' | 'confirm'
    readonly seed: number
  }) => Promise<void>
  readonly refreshing: boolean
  readonly refreshError: string | null
  readonly history: readonly SimulationsHistoryEntry[]
  readonly historyStatus: 'loading' | 'ready' | 'empty' | 'error'
  readonly historyError: string | null
  readonly selectedHistoryId: string | null
  readonly selectHistory: (id: string) => Promise<void>
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
  const [history, setHistory] = useState<readonly SimulationsHistoryEntry[]>([])
  const [historyStatus, setHistoryStatus] = useState<
    'loading' | 'ready' | 'empty' | 'error'
  >('loading')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  )
  const refreshInFlight = useRef(false)

  useEffect(() => {
    let active = true
    const reportUrl =
      selectedHistoryId === null ? url : `${url}/history/${selectedHistoryId}`
    void loadReport(reportUrl, fetchFn).then((outcome) => {
      if (active) setResult(outcome)
    })
    return () => {
      active = false
    }
  }, [url, fetchFn, reloadKey, selectedHistoryId])

  useEffect(() => {
    let active = true
    void fetchFn(`${url}/history?limit=50`)
      .then(async (response) => {
        if (!response.ok) throw new Error('No se pudo cargar el historial.')
        const payload: unknown = await response.json()
        const entries =
          payload &&
          typeof payload === 'object' &&
          'reports' in payload &&
          Array.isArray(payload.reports)
            ? (payload.reports as SimulationsHistoryEntry[])
            : []
        if (active) {
          setHistory(entries)
          setHistoryStatus(entries.length === 0 ? 'empty' : 'ready')
          setHistoryError(null)
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setHistoryStatus('error')
          setHistoryError(
            error instanceof Error
              ? error.message
              : 'No se pudo cargar el historial.',
          )
        }
      })
    return () => {
      active = false
    }
  }, [url, fetchFn, reloadKey])

  const selectHistory = useCallback(async (id: string) => {
    if (id === '') {
      setSelectedHistoryId(null)
      setResult(null)
      return
    }
    if (!/^[0-9a-f]{64}$/.test(id)) return
    setSelectedHistoryId(id)
    setResult(null)
  }, [])

  const retry = useCallback(async () => {
    setResult(null)
    setReloadKey((key) => key + 1)
  }, [])

  const refresh = useCallback(
    async (sample?: {
      readonly stage: 'smoke' | 'confirm'
      readonly seed: number
    }) => {
      if (refreshInFlight.current) return
      refreshInFlight.current = true
      setRefreshing(true)
      setRefreshError(null)
      try {
        const response = await fetchFn(`${url}/refresh`, {
          method: 'POST',
          ...(sample === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(sample),
              }),
        })
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
        setSelectedHistoryId(null)
      } catch (error) {
        setRefreshError(
          error instanceof Error ? error.message : 'No se pudo actualizar.',
        )
      } finally {
        refreshInFlight.current = false
        setRefreshing(false)
      }
    },
    [fetchFn, url],
  )

  const refreshState = {
    refresh,
    refreshing,
    refreshError,
    history,
    historyStatus,
    historyError,
    selectedHistoryId,
    selectHistory,
  }

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
