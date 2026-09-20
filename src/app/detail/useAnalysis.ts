import { useCallback, useEffect, useRef, useState } from 'react'
import type { Candle, Instrument, Quote } from '../../domain/market-data'
import type { AnalysisProvider, AnalysisResult } from '../../domain/analysis'
import { analysisInputFrom } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'

export type AnalysisStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Which provider produced the current result, or null when none. */
export type AnalysisSource = 'preferred' | 'fallback' | null

export type UseAnalysisResult = {
  status: AnalysisStatus
  result: AnalysisResult | null
  error: string | null
  source: AnalysisSource
  warning: string | null
  analyze: () => Promise<void>
}

type UseAnalysisParams = {
  analysis: AnalysisProvider
  /** Local engine used when the primary remote provider fails. */
  fallback?: AnalysisProvider
  portfolioRepository: PortfolioRepository
  instrument: Instrument
  quote: Quote | undefined
  candles: readonly Candle[]
}

/**
 * Manual, human-driven analysis for one instrument. Nothing runs on mount and
 * nothing reacts to arriving quotes or candles: `analyze()`, wired to a button,
 * is the only entry point.
 *
 * When a `fallback` provider is given, a primary failure is transparently
 * retried against it; the `source` field tells the UI which one answered and
 * `warning` explains why the fallback kicked in. Portfolio context is read
 * fresh from the repository at request time.
 */
export function useAnalysis({
  analysis,
  fallback,
  portfolioRepository,
  instrument,
  quote,
  candles,
}: UseAnalysisParams): UseAnalysisResult {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<AnalysisSource>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const requestIdRef = useRef(0)
  const instrumentIdRef = useRef(instrument.id)
  useEffect(() => {
    instrumentIdRef.current = instrument.id
  }, [instrument.id])

  const analyze = useCallback(async (): Promise<void> => {
    if (quote === undefined) return
    const requestId = ++requestIdRef.current
    const targetInstrumentId = instrument.id
    setStatus('loading')
    setError(null)
    setResult(null)
    setSource(null)
    setWarning(null)
    try {
      const holdings = await portfolioRepository.list()
      if (
        requestIdRef.current !== requestId ||
        instrumentIdRef.current !== targetInstrumentId
      ) {
        return
      }
      const input = analysisInputFrom({ instrument, quote, candles, holdings })
      const analysisResult = await analysis.analyze(input)
      if (
        requestIdRef.current !== requestId ||
        instrumentIdRef.current !== targetInstrumentId
      ) {
        return
      }
      setResult(analysisResult)
      setSource('preferred')
      setStatus('ready')
    } catch (cause) {
      if (fallback === undefined) {
        if (
          requestIdRef.current !== requestId ||
          instrumentIdRef.current !== targetInstrumentId
        ) {
          return
        }
        setError(errorMessage(cause))
        setStatus('error')
        return
      }
      try {
        const input = analysisInputFrom({
          instrument,
          quote,
          candles,
          holdings: await portfolioRepository.list(),
        })
        const fallbackResult = await fallback.analyze(input)
        if (
          requestIdRef.current !== requestId ||
          instrumentIdRef.current !== targetInstrumentId
        ) {
          return
        }
        setResult(fallbackResult)
        setSource('fallback')
        setWarning(
          'El análisis preferido no está disponible; se muestra la evaluación local.',
        )
        setStatus('ready')
      } catch (fallbackCause) {
        if (
          requestIdRef.current !== requestId ||
          instrumentIdRef.current !== targetInstrumentId
        ) {
          return
        }
        setError(errorMessage(fallbackCause))
        setStatus('error')
      }
    }
  }, [analysis, fallback, portfolioRepository, instrument, quote, candles])

  return { status, result, error, source, warning, analyze }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? 'No se pudo completar el análisis. Intente nuevamente.'
    : 'Ocurrió un problema inesperado durante el análisis.'
}
