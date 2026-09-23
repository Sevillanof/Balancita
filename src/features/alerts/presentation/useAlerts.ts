import { useCallback, useEffect, useRef, useState } from 'react'
import {
  nextZoneAfterAcknowledge,
  evaluateAlert,
} from '../domain/alert-evaluator'
import type { Alert, AlertId, AlertRepository } from '../domain/alerts.ts'
import { AlertCorruptError } from '../domain/alerts.ts'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../market-data/domain/market-data.ts'
import type { PriceSide } from '../domain/alert-evaluator'

export type AlertListStatus = 'loading' | 'ready' | 'empty' | 'error'
export type AlertLoadError = 'corrupt' | 'general'

export type NewAlertInput = {
  instrumentId: InstrumentId
  direction: 'above' | 'below'
  thresholdPrice: number
}

export type TriggeredAlert = {
  alert: Alert
  instrument: Instrument
}

export type UseAlertsResult = {
  status: AlertListStatus
  alerts: readonly Alert[]
  instruments: ReadonlyMap<InstrumentId, Instrument>
  loadError: AlertLoadError | null
  operationError: string | null
  retry: () => void
  reset: () => void
  create: (input: NewAlertInput) => Promise<boolean>
  remove: (id: AlertId) => Promise<boolean>
  acknowledge: (id: AlertId) => Promise<boolean>
  triggered: readonly TriggeredAlert[]
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isArmed(alert: Alert): boolean {
  return alert.status === 'active' || alert.status === 'acknowledged'
}

function armedInstrumentIds(
  alerts: readonly Alert[],
  catalog: ReadonlyMap<InstrumentId, Instrument>,
): InstrumentId[] {
  const ids = new Set<InstrumentId>()
  for (const alert of alerts) {
    if (isArmed(alert) && catalog.has(alert.instrumentId)) {
      ids.add(alert.instrumentId)
    }
  }
  return [...ids]
}

function pruneQuotes(
  quotes: ReadonlyMap<InstrumentId, Quote>,
  subscribed: ReadonlySet<InstrumentId>,
): ReadonlyMap<InstrumentId, Quote> {
  const next = new Map<InstrumentId, Quote>()
  for (const [id, quote] of quotes) {
    if (subscribed.has(id)) next.set(id, quote)
  }
  return next
}

function createAlertId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Application-layer alert source. Configuration is the single source of truth
 * from the repository; evaluation zones and crossings are ephemeral runtime
 * state (keyed by alert id in a ref) and are never persisted. Quotes are only
 * subscribed for instruments whose alerts are armed, so a triggered alert stops
 * evaluating until it is acknowledged.
 */
export function useAlerts(
  provider: MarketDataProvider,
  repository: AlertRepository,
): UseAlertsResult {
  const [reloadKey, setReloadKey] = useState(0)
  const [status, setStatus] = useState<AlertListStatus>('loading')
  const [alerts, setAlerts] = useState<readonly Alert[]>([])
  const [quotes, setQuotes] = useState<ReadonlyMap<InstrumentId, Quote>>(
    new Map(),
  )
  const [instruments, setInstruments] = useState<
    ReadonlyMap<InstrumentId, Instrument>
  >(new Map())
  const [loadError, setLoadError] = useState<AlertLoadError | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)

  const zones = useRef(new Map<AlertId, PriceSide | null>())
  const fired = useRef(new Set<AlertId>())

  const reload = useCallback(() => {
    setStatus('loading')
    setAlerts([])
    setQuotes(new Map())
    setInstruments(new Map())
    setLoadError(null)
    setOperationError(null)
    zones.current.clear()
    fired.current.clear()
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    let active = true

    Promise.all([repository.list(), provider.getInstruments()]).then(
      ([storedAlerts, catalog]) => {
        if (!active) return
        const byId = new Map(
          catalog.map((instrument) => [instrument.id, instrument]),
        )
        setInstruments(byId)
        setLoadError(null)
        if (storedAlerts.length === 0) {
          setAlerts([])
          setQuotes(new Map())
          setStatus('empty')
        } else {
          setAlerts(storedAlerts)
          setStatus('ready')
        }
      },
      (cause) => {
        if (!active) return
        setAlerts([])
        setQuotes(new Map())
        setInstruments(new Map())
        setLoadError(cause instanceof AlertCorruptError ? 'corrupt' : 'general')
        setStatus('error')
      },
    )

    return () => {
      active = false
    }
  }, [provider, repository, reloadKey])

  const syncFromRepository = useCallback(async (): Promise<void> => {
    try {
      const storedAlerts = await repository.list()
      setAlerts(storedAlerts)
      setQuotes((previous) =>
        pruneQuotes(
          previous,
          new Set(armedInstrumentIds(storedAlerts, instruments)),
        ),
      )
      setStatus(storedAlerts.length === 0 ? 'empty' : 'ready')
      setLoadError(null)
      setOperationError(null)
    } catch (cause) {
      setLoadError(cause instanceof AlertCorruptError ? 'corrupt' : 'general')
      setStatus('error')
    }
  }, [repository, instruments])

  useEffect(() => {
    if (status !== 'ready') return

    const subscribed = armedInstrumentIds(alerts, instruments)
    if (subscribed.length === 0) return

    let release: (() => void) | undefined
    try {
      release = provider.subscribe(subscribed, (quote: Quote) => {
        if (!subscribed.includes(quote.instrumentId)) return

        const newlyTriggered: Alert[] = []
        for (const alert of alerts) {
          if (alert.instrumentId !== quote.instrumentId) continue
          if (!isArmed(alert)) continue
          if (fired.current.has(alert.id)) continue

          const previous = zones.current.get(alert.id) ?? null
          const evaluation = evaluateAlert(alert, previous, quote.price)
          zones.current.set(alert.id, evaluation.zone)

          if (evaluation.event !== 'trigger') continue
          fired.current.add(alert.id)
          newlyTriggered.push({ ...alert, status: 'triggered' })
        }

        for (const triggered of newlyTriggered) {
          void repository.add(triggered).then(
            () => syncFromRepository(),
            (cause) => {
              setOperationError(messageOf(cause))
            },
          )
        }
      })
    } catch {
      return
    }

    return () => {
      release?.()
      setQuotes((previous) =>
        pruneQuotes(previous, new Set(armedInstrumentIds(alerts, instruments))),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, status, alerts, instruments])

  const create = useCallback(
    async (input: NewAlertInput): Promise<boolean> => {
      const alert: Alert = {
        id: createAlertId(),
        instrumentId: input.instrumentId,
        direction: input.direction,
        thresholdPrice: input.thresholdPrice,
        status: 'active',
        createdAt: new Date().toISOString(),
      }
      try {
        await repository.add(alert)
      } catch (cause) {
        setOperationError(messageOf(cause))
        return false
      }
      await syncFromRepository()
      return true
    },
    [repository, syncFromRepository],
  )

  const remove = useCallback(
    async (id: AlertId): Promise<boolean> => {
      try {
        await repository.remove(id)
      } catch (cause) {
        setOperationError(messageOf(cause))
        return false
      }
      zones.current.delete(id)
      fired.current.delete(id)
      await syncFromRepository()
      return true
    },
    [repository, syncFromRepository],
  )

  const acknowledge = useCallback(
    async (id: AlertId): Promise<boolean> => {
      const current = alerts.find((alert) => alert.id === id)
      if (!current || current.status !== 'triggered') return false
      const price = quotes.get(current.instrumentId)?.price ?? null
      zones.current.set(id, nextZoneAfterAcknowledge(current, price))
      fired.current.delete(id)
      const next = { ...current, status: 'acknowledged' as const }
      try {
        await repository.add(next)
      } catch (cause) {
        setOperationError(messageOf(cause))
        return false
      }
      await syncFromRepository()
      return true
    },
    [alerts, quotes, repository, syncFromRepository],
  )

  const reset = useCallback(async () => {
    try {
      await repository.clear()
    } catch (cause) {
      setOperationError(messageOf(cause))
      return
    }
    zones.current.clear()
    fired.current.clear()
    await syncFromRepository()
  }, [repository, syncFromRepository])

  const triggered = alerts
    .filter((alert) => alert.status === 'triggered')
    .map((alert) => ({
      alert,
      instrument: instruments.get(alert.instrumentId),
    }))
    .filter((entry): entry is TriggeredAlert => entry.instrument !== undefined)

  return {
    status,
    alerts,
    instruments,
    loadError,
    operationError,
    retry: reload,
    reset,
    create,
    remove,
    acknowledge,
    triggered,
  }
}
