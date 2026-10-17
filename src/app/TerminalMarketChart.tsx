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
import { candleForDecision, markerGap } from './terminal-markers.ts'
import { analysisAction } from './terminal-labels.ts'

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
  fills = [],
  quantityUnit,
  historicalLabel,
}: {
  market: Record<string, unknown>
  mode: TerminalBootstrap['mode']
  analyses: unknown[]
  selectedId: string
  /** Live gateway: proposals and WAIT get their own markers (not entries). */
  entriesOnly?: boolean
  onSelect: (analysisId: string) => void
  apiBase: string
  product?: string
  ticker: TerminalTickerStats | null
  position: Record<string, unknown>
  positions?: unknown[]
  orders: unknown[]
  /** Durable gateway fills: one EJEC. marker each. */
  fills?: unknown[]
  quantityUnit?: string
  historicalLabel?: string
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
  const candleSeconds = useMemo(
    () => candles.map((candle) => candle.time).sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketsKey],
  )
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
            if (
              markerGap(analysis, {
                firstCandleMs: candles[0]!.time * 1000,
                entriesOnly,
                candleSeconds,
              })
            )
              return []
            const action = analysisAction(analysis)
            // The candle that covers the verdict's bucket, never an earlier one.
            const renderTime = candleForDecision(
              candleSeconds,
              analysis,
              !entriesOnly,
            ).time
            if (renderTime === null) return []
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
                // Live gateway: LONG/SHORT are proposals, WAIT is a wait; they
                // are never drawn as the operations executed (see `fill`).
                type: direction
                  ? entriesOnly
                    ? 'proposal'
                    : 'entry'
                  : entriesOnly
                    ? 'wait'
                    : 'discard',
                ...(direction ? { direction } : {}),
                label: direction
                  ? `${code ? `${code} ` : ''}${action}`
                  : entriesOnly
                    ? 'W'
                    : 'WAIT',
                detail: direction
                  ? `${code ? `${code} ` : ''}${action}${entriesOnly ? ' propuesta' : ''}`
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
    market.schema_version !== 'futures-terminal-market.v1' ||
    candles.length === 0
  )
    return <p>El snapshot no contiene velas verificables.</p>
  return (
    <>
      {market.candles instanceof Array && market.candles.length > 0 && (
        <p role="status" className="visually-hidden">
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
        fills={fills}
        quantityUnit={quantityUnit}
        proposalLegend={entriesOnly}
        historicalLabel={historicalLabel}
      />
    </>
  )
}
