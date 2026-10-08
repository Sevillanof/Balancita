import { useMemo } from 'react'
import type {
  ApprovedTerminalCandle,
  ApprovedTerminalMarker,
} from '../features/trading-view/presentation/ApprovedTerminalChart.tsx'
import TerminalChartPanel from '../features/trading-view/presentation/TerminalChartPanel.tsx'
import type { TerminalTickerStats } from '../features/trading-view/infrastructure/terminal-chart-client.ts'
import type { TerminalBootstrap } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { strategyCode } from '../features/trading-view/domain/terminal-chart-model.ts'
import { record } from '../shared/wire/decode.ts'
import { analysisAction } from './terminal-labels.ts'

/** Time of the last candle at or before `seconds` (the first one when none is). */
function candleTimeAtOrBefore(
  candles: readonly ApprovedTerminalCandle[],
  seconds: number,
): number {
  let low = 0
  let high = candles.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (candles[middle]!.time <= seconds) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return candles[found]!.time
}

export default function TerminalMarketChart({
  market,
  mode,
  analyses,
  selectedId,
  entriesOnly = false,
  onSelect,
  apiBase,
  product,
  ticker,
  position,
  positions,
  orders,
}: {
  market: Record<string, unknown>
  mode: TerminalBootstrap['mode']
  analyses: unknown[]
  selectedId: string
  /** Mark only LONG/SHORT verdicts: a WAIT every minute would bury the chart. */
  entriesOnly?: boolean
  onSelect: (analysisId: string) => void
  apiBase: string
  product?: string
  ticker: TerminalTickerStats | null
  position: Record<string, unknown>
  positions?: unknown[]
  orders: unknown[]
}) {
  const marketCandles = market.candles
  const candles = useMemo<ApprovedTerminalCandle[]>(
    () =>
      Array.isArray(marketCandles)
        ? marketCandles.flatMap((value) => {
            const candle = record(value)
            const values = ['open', 'high', 'low', 'close', 'volume_btc'].map(
              (key) => Number(candle[key]),
            )
            if (
              !Number.isSafeInteger(candle.time_ms) ||
              values.some((number) => !Number.isFinite(number))
            )
              return []
            return [
              {
                time: Math.floor(Number(candle.time_ms) / 1000),
                open: values[0]!,
                high: values[1]!,
                low: values[2]!,
                close: values[3]!,
                volume: values[4]!,
              },
            ]
          })
        : [],
    [marketCandles],
  )
  // Markers only depend on which candle buckets exist, not on the live price
  // of the forming one: a new array per tick would repaint every marker.
  const bucketsKey = `${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`
  const markers = useMemo<ApprovedTerminalMarker[]>(
    () =>
      candles.length === 0
        ? []
        : analyses.flatMap((value) => {
            const analysis = record(value)
            const id = analysis.analysis_id
            const time = analysis.decision_time_ms
            if (
              typeof id !== 'string' ||
              id.length === 0 ||
              !Number.isSafeInteger(time)
            )
              return []
            const action = analysisAction(analysis)
            if (entriesOnly && action !== 'LONG' && action !== 'SHORT')
              return []
            // Verdicts rebuilt from a backfill were not decisions taken at that time
            // (paper execution ignores them too: max_verdict_lag_ms).
            if (entriesOnly && Number(analysis.knowledge_lag_ms) > 15_000)
              return []
            // A verdict older than the chart has no candle: do not pile it on the first.
            if (entriesOnly && Number(time) < candles[0]!.time * 1000) return []
            const decisionSeconds = Math.floor(Number(time) / 1000)
            const renderTime = candleTimeAtOrBefore(candles, decisionSeconds)
            const direction =
              action === 'LONG'
                ? 'long'
                : action === 'SHORT'
                  ? 'short'
                  : undefined
            const selector = record(analysis.selector)
            const strategyId =
              selector.strategy_id ?? analysis.selected_strategy_id
            const code = strategyCode(
              typeof strategyId === 'string' ? strategyId : undefined,
            )
            return [
              {
                id,
                time: renderTime,
                type: direction ? 'entry' : 'discard',
                ...(direction ? { direction } : {}),
                label: direction
                  ? code
                    ? `${code} ${action}`
                    : action
                  : 'WAIT',
                ...(direction && typeof strategyId === 'string'
                  ? { strategyId }
                  : {}),
              },
            ]
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analyses, bucketsKey, entriesOnly],
  )

  if (
    !['mock-terminal-market.v1', 'futures-terminal-market.v1'].includes(
      String(market.schema_version),
    ) ||
    candles.length === 0
  )
    return <p>El snapshot no contiene velas verificables.</p>
  return (
    <>
      <p>
        {mode === 'paper_live'
          ? 'Velas públicas de Kraken Futures · operaciones simuladas.'
          : 'Velas cerradas del fixture determinista MOCK · actualización por WebSocket.'}
      </p>
      {market.candles instanceof Array && market.candles.length > 0 && (
        <p role="status">
          {record(market.candles.at(-1)).closed === true
            ? 'Última vela cerrada'
            : 'Vela en formación'}
        </p>
      )}
      <TerminalChartPanel
        candles={candles}
        markers={markers}
        selectedId={selectedId}
        onSelect={onSelect}
        apiBase={apiBase}
        product={product}
        live={mode === 'paper_live'}
        ticker={ticker}
        position={position}
        positions={positions}
        orders={orders}
      />
    </>
  )
}
