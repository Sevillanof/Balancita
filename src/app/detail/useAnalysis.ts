import { useCallback, useRef, useState } from 'react'
import type { Candle, Instrument, Quote } from '../../domain/market-data'
import type { AnalysisProvider, AnalysisResult } from '../../domain/analysis'
import { analysisInputFrom } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'

export type AnalysisStatus = 'idle' | 'loading' | 'ready' | 'error'

export type UseAnalysisResult = {
  status: AnalysisStatus
  result: AnalysisResult | null
  error: string | null
  analyze: () => Promise<void>
}

type UseAnalysisParams = {
  analysis: AnalysisProvider
  portfolioRepository: PortfolioRepository
  instrument: Instrument
  quote: Quote | undefined
  candles: readonly Candle[]
}

/**
 * Manual, human-driven analysis for one instrument. Nothing runs on mount and
 * nothing reacts to arriving quotes or candles: `analyze()`, wired to a button,
 * is the only entry point. Portfolio context is read fresh from the repository
 * at request time so the assessment reflects the current position.
 */
export function useAnalysis({
  analysis,
  portfolioRepository,
  instrument,
  quote,
  candles,
}: UseAnalysisParams): UseAnalysisResult {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const requestIdRef = useRef(0)
  const instrumentIdRef = useRef(instrument.id)
  instrumentIdRef.current = instrument.id

  const analyze = useCallback(async (): Promise<void> => {
    if (quote === undefined) return
    const requestId = ++requestIdRef.current
    const targetInstrumentId = instrument.id
    setStatus('loading')
    setError(null)
    setResult(null)
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
      setStatus('ready')
    } catch (cause) {
      if (
        requestIdRef.current !== requestId ||
        instrumentIdRef.current !== targetInstrumentId
      ) {
        return
      }
      setError(errorMessage(cause))
      setStatus('error')
    }
  }, [analysis, portfolioRepository, instrument, quote, candles])

  return { status, result, error, analyze }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Something unexpected happened.'
}
