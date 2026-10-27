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
import { decisionView } from './terminal-decision-view.ts'
import { analysisAction } from './terminal-labels.ts'
import { QWEN_STRATEGY_ID } from './useQwenDecisions.ts'

export default function TerminalMarketChart({
  market,
  mode,
  analyses,
  selectedId,
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
                candleSeconds,
              })
            )
              return []
            const action = analysisAction(analysis)
            // The candle that covers the verdict's bucket, never an earlier one.
            const renderTime = candleForDecision(candleSeconds, analysis).time
            if (renderTime === null) return []
            const direction =
              action === 'LONG'
                ? 'long'
                : action === 'SHORT'
                  ? 'short'
                  : undefined
            // Version 9 (formulas decide, Qwen opines): few words, and a mark
            // for each thing worth seeing. Quiet holds paint nothing.
            if (typeof analysis.formula_action === 'string') {
              const view = decisionView(analysis)
              const out: ApprovedTerminalMarker[] = []
              if (view.kind === 'exit')
                out.push({
                  id,
                  time: renderTime,
                  type: 'exit',
                  label: 'Sale',
                  detail: 'Sale: el maestro se dio vuelta en contra',
                })
              else if (
                view.kind === 'enter-long' ||
                view.kind === 'enter-short'
              )
                out.push({
                  id,
                  time: renderTime,
                  type: 'proposal',
                  direction: view.kind === 'enter-long' ? 'long' : 'short',
                  label: view.label,
                  detail: `${view.label}: maestro fuerte y portero a favor`,
                })
              else if (view.kind === 'blocked')
                out.push({
                  id,
                  time: renderTime,
                  type: 'discard',
                  label: 'Portero ✕',
                  detail:
                    'El maestro vio señal, pero el portero frenó la entrada',
                })
              else if (view.kind === 'wait')
                out.push({
                  id,
                  time: renderTime,
                  type: 'wait',
                  label: 'W',
                  detail: 'Espera',
                })
              if (view.opinion?.state === 'differs')
                out.push({
                  id: `${id}#q`,
                  memberIds: [id],
                  time: renderTime,
                  type: 'discard',
                  label: 'Qwen ≠',
                  detail: `Qwen opina ${view.opinion.label}, distinto de la fórmula`,
                })
              return out
            }
            // Qwen closing its own position: a close mark, not a wait.
            if (action === 'CLOSE') {
              const closing: ApprovedTerminalMarker = {
                id,
                time: renderTime,
                type: 'exit',
                label: 'C',
                detail: 'Qwen cierra la posición',
                strategyId: QWEN_STRATEGY_ID,
              }
              return [closing]
            }
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
                // LONG/SHORT are proposals, WAIT is a wait; they are never
                // drawn as the operations executed (see `fill`).
                type: direction ? 'proposal' : 'wait',
                ...(direction ? { direction } : {}),
                label: direction ? `${code ? `${code} ` : ''}${action}` : 'W',
                detail: direction
                  ? `${code ? `${code} ` : ''}${action} propuesta`
                  : typeof analysis.qwen_why === 'string' && analysis.qwen_why
                    ? analysis.qwen_why
                    : 'WAIT',
                ...(direction && typeof strategyId === 'string'
                  ? { strategyId }
                  : {}),
              },
            ]
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analyses, bucketsKey],
  )

  if (
    market.schema_version !== 'futures-terminal-market.v1' ||
    candles.length === 0
  )
    return <p>El snapshot no contiene velas verificables.</p>
  return (
    <>
      {market.candles instanceof Array && market.candles.length > 0 && (
        <p role="status" className="clip-hidden whitespace-nowrap">
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
        proposalLegend
        historicalLabel={historicalLabel}
      />
    </>
  )
}
