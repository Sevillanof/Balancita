import { useEffect, useState, type ReactNode } from 'react'
import {
  productBase,
  productPair,
} from '../features/trading-view/domain/product-label.ts'
import { utcDateTime } from '../shared/finance/format.ts'
import ApprovedTerminalLayout from '../features/trading-view/presentation/ApprovedTerminalLayout.tsx'
import { AppShell } from '../shared/mission-control/index.ts'
import MarketStrip from './MarketStrip.tsx'
import TerminalNotices from './TerminalNotices.tsx'
import { TERMINAL_FRAME } from '../shared/design-system/terminal-styles.ts'
import { appNavigation } from './app-navigation.ts'
import type { TerminalTickerStats } from '../features/trading-view/infrastructure/terminal-chart-client.ts'
import type { TerminalBootstrap } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { useTerminalStream } from './useTerminalStream.ts'
import { projectTerminalQuote } from './terminal-market.ts'
import AppStatusChips from './AppStatusChips.tsx'
import AccountBalance from './AccountBalance.tsx'
import TerminalDecisions from './TerminalDecisions.tsx'
import { decisionView } from './terminal-decision-view.ts'
import type { DecisionRow } from './terminal-decisions.ts'
import SelectedDecision from './SelectedDecision.tsx'
import { markerGap, markerGapNote } from './terminal-markers.ts'
import TerminalMarketChart from './TerminalMarketChart.tsx'
import { approvedChartData, isApprovedAnalysis } from './terminal-approved.ts'
import {
  qwenHealthNotice,
  qwenNotice,
  useQwenDecisions,
} from './useQwenDecisions.ts'
import TerminalOperationCard from './TerminalOperationCard.tsx'
import { useQwenTrades } from './useQwenTrades.ts'
import { tradeIdentity } from '../features/trading-view/domain/terminal-trade-model.ts'
import TerminalNewsPanel from './TerminalNewsPanel.tsx'
import { formatShortDateTime } from './terminal-date.ts'
import { useTerminalNews } from './useTerminalNews.ts'
import {
  analysesNotice,
  analysisAction,
  analysisReason,
  marketStatusLabel,
  shortTime,
  strategyLabel,
  utcTime,
} from './terminal-labels.ts'
import { record } from '../shared/wire/decode.ts'
import { lifecycleView, minutePrices } from './terminal-lifecycle.ts'
import { useHealth } from '../features/observability/presentation/useHealth.ts'
import { latestDecision } from '../features/observability/presentation/latest-decision.ts'
import ObserverPanel from '../features/observability/presentation/ObserverPanel.tsx'

/** Closed 1 m candles the engine needs before it can decide. */
const WARMUP_CANDLES = 50

export default function FuturesTerminal({
  bootstrap,
  apiBase = '/api',
  sourceSwitch,
  product,
}: {
  bootstrap: TerminalBootstrap
  apiBase?: string
  /** Data-source control owned by the entry; rendered inside the header. */
  sourceSwitch?: ReactNode
  /** Pinned product shown; the entry pins ETH by default. */
  product?: string
}) {
  const {
    state,
    connected,
    serverClock,
    connectedAtMs,
    error,
    activeRunId,
    selectedAnalysisId,
    setSelectedAnalysisId,
  } = useTerminalStream({ bootstrap, apiBase, product })
  // null: the health feed has not answered (yet) or is unreachable.
  const [processHealth, setProcessHealth] = useState<Record<
    string,
    unknown
  > | null>(null)
  const liveGateway = bootstrap.mode === 'paper_live'
  const health = useHealth(liveGateway)
  const {
    items: newsItems,
    loaded: newsLoaded,
    source: newsSource,
    briefing: newsBriefing,
  } = useTerminalNews(apiBase, liveGateway)

  const position = record(state?.position)
  const positions = Array.isArray(state?.positions)
    ? state.positions
    : undefined
  const market = record(state?.terminal_market)
  const marketState = record(state?.market)
  const quoteBase = productBase(product ?? bootstrap.products?.[0])
  const quote = projectTerminalQuote({
    mode: bootstrap.mode,
    market: record(state?.market ?? bootstrap.market),
    terminalMarket: market,
    position,
    base: quoteBase,
  })
  const displayedPrice = quote.price
  // The default view (no product pinned) is the first product: Qwen loads without touching the selector.
  const qwenProduct = product ?? bootstrap.products?.[0]
  const tradeRead = useQwenTrades(qwenProduct, liveGateway)
  const [pickedTrade, setPickedTrade] = useState<{
    product: string | undefined
    id: string
  } | null>(null)
  const [tradeFocus, setTradeFocus] = useState<{
    id: string
    revision: number
  } | null>(null)
  const ownTrades = tradeRead.trades.filter(
    (trade) => trade.product === qwenProduct,
  )
  const selectedTrade =
    (pickedTrade !== null && pickedTrade.product === qwenProduct
      ? ownTrades.find((trade) => tradeIdentity(trade) === pickedTrade.id)
      : null) ??
    ownTrades.find((trade) => trade.open) ??
    ownTrades[0] ??
    null
  const selectedTradeId = selectedTrade ? tradeIdentity(selectedTrade) : ''
  const focusTrade = (id: string) => {
    if (!ownTrades.some((trade) => tradeIdentity(trade) === id)) return
    setPickedTrade({ product: qwenProduct, id })
    setTradeFocus((previous) => ({
      id,
      revision: (previous?.revision ?? 0) + 1,
    }))
  }
  const { rows: qwen, source: qwenSource } = useQwenDecisions(
    qwenProduct,
    bootstrap.mode === 'paper_live',
  )
  const analyses = [
    ...(Array.isArray(state?.analyses)
      ? state.analyses.filter(isApprovedAnalysis)
      : []),
    ...qwen,
  ].sort(
    (a, b) =>
      Number(record(a).decision_time_ms) - Number(record(b).decision_time_ms),
  )
  const orders = Array.isArray(state?.orders) ? state.orders : []
  const fills = Array.isArray(state?.fills) ? state.fills : []
  const selectedAnalysis =
    analyses
      .map(record)
      .find((analysis) => analysis.analysis_id === selectedAnalysisId) ??
    (analyses.length > 0 ? record(analyses.at(-1)) : null)
  const selectedId = String(selectedAnalysis?.analysis_id ?? '')
  // An id that is not one of this product's analyses never becomes the
  // selection (a stale or foreign marker/row id would blank the detail).
  const selectAnalysis = (markerId: string) => {
    // The «Qwen no coincide» mark sits beside its decision's mark: same decision.
    const id = markerId.replace(/#q$/, '')
    if (analyses.some((analysis) => record(analysis).analysis_id === id))
      setSelectedAnalysisId(id)
  }
  const selectedDecisionTime = selectedAnalysis?.decision_time_ms
  const [displayClock, setDisplayClock] = useState(() => Date.now())
  // The live gateway serves public candles/price while the decision engine is
  // not running: show that state explicitly and render no engine-owned data.
  const engineOff =
    bootstrap.mode === 'paper_live' &&
    (record(state?.engine).status ?? bootstrap.engine?.status) === 'off'
  // The live gateway shows paper execution read-only: it has no command channel.
  const gatewayEngine =
    bootstrap.mode === 'paper_live' &&
    (record(state?.engine).commands ?? bootstrap.engine?.commands) ===
      'unavailable'
  const gatewayEngineStatus =
    record(state?.engine).status ?? bootstrap.engine?.status
  const gatewayEngineReason =
    record(state?.engine).reason ?? bootstrap.engine?.reason
  const change24h = (
    (marketState.ticker_stats ?? record(bootstrap.market).ticker_stats) as {
      change_24h_pct?: unknown
    } | null
  )?.change_24h_pct
  const feedStatus =
    marketState.market_status ?? record(bootstrap.market).status
  const feedTone =
    feedStatus === 'live' ? 'ok' : feedStatus === 'degraded' ? 'warn' : 'bad'
  const feedReason = marketState.reason ?? record(bootstrap.market).reason
  const lastReceivedAt =
    marketState.last_received_at ?? record(bootstrap.market).last_received_at
  const fundingKnown =
    (marketState.funding ?? record(bootstrap.market).funding) ===
    'known_current_interval'
  const warmupCandles = Array.isArray(market.candles)
    ? market.candles.length
    : 0
  const decisionRows: DecisionRow[] = analyses
    .slice(-100)
    .reverse()
    .map((item, index) => {
      const analysis = record(item)
      const selector = record(analysis.selector)
      const view =
        typeof analysis.formula_action === 'string' ||
        analysis.qwen_skipped === true
          ? decisionView(analysis)
          : null
      const ts = Number(analysis.decision_time_ms)
      const dt = Number.isFinite(ts) && ts > 0 ? formatShortDateTime(ts) : null
      return {
        id: String(analysis.analysis_id ?? index),
        action: analysisAction(analysis),
        strategy: strategyLabel(
          selector.strategy_id ?? analysis.selected_strategy_id,
        ).split(' · ')[0]!,
        reason: analysisReason(analysis),
        time: shortTime(analysis.decision_time_ms),
        ...(dt ? { dateTime: dt.display, searchText: dt.search } : {}),
        ...(typeof analysis.qwen_probabilities === 'string' &&
        analysis.qwen_probabilities
          ? { detail: analysis.qwen_probabilities }
          : {}),
        ...(view ? { view } : {}),
        // Quiet waits and holds fold into one «×N» line; the rest stay apart.
        ...((
          view
            ? view.relevant
            : typeof analysis.qwen_why === 'string' && analysis.qwen_why
        )
          ? { explained: true }
          : {}),
      }
    })
  // Where the selected decision stands on the chart and in the list: what it
  // lacks is said, never filled in.
  const firstCandle = (Array.isArray(market.candles) ? market.candles : [])
    .map(record)
    .find((candle) => Number.isSafeInteger(candle.time_ms))?.time_ms
  const selectedNotes: string[] = []
  if (selectedAnalysis && gatewayEngine) {
    const gap = markerGap(selectedAnalysis, {
      firstCandleMs:
        typeof firstCandle === 'number'
          ? Math.floor(firstCandle / 1000) * 1000
          : null,
      candleSeconds: (Array.isArray(market.candles) ? market.candles : [])
        .map((candle) => record(candle).time_ms)
        .filter((ms): ms is number => Number.isSafeInteger(ms))
        .map((ms) => Math.floor(ms / 1000))
        .sort((a, b) => a - b),
    })
    if (gap) selectedNotes.push(markerGapNote(gap))
    if (!decisionRows.some((row) => row.id === selectedId))
      selectedNotes.push(
        'Esta decisión no aparece en la lista: solo se muestran las últimas 100.',
      )
  }

  useEffect(() => {
    if (bootstrap.mode !== 'paper_live') return
    // Ticks even without a quote: AHORA must notice by itself that the gateway
    // clock or B1 went stale.
    const timer = setInterval(() => setDisplayClock(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [bootstrap.mode])

  // A (re)connection evaluates AHORA from scratch: B1 is read again.
  const reloadHealth = health.reload
  useEffect(() => {
    if (connectedAtMs !== null) reloadHealth()
  }, [connectedAtMs, reloadHealth])

  // Per-process health from the dev supervisor (live gateway only).
  useEffect(() => {
    if (bootstrap.mode !== 'paper_live') return
    let cancelled = false
    const load = () =>
      fetch(`${apiBase}/health`)
        .then((response) => response.json() as Promise<unknown>)
        .then((body) => {
          if (!cancelled) setProcessHealth(record(record(body).processes))
        })
        .catch(() => {
          if (!cancelled) setProcessHealth(null)
        })
    void load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [bootstrap.mode, apiBase])
  const flowInputs = {
    connected,
    processes: bootstrap.mode === 'paper_live' ? processHealth : {},
    quoteAgeMs:
      quote.receivedAt === null
        ? null
        : Math.max(0, displayClock - quote.receivedAt),
  }
  const downProcesses = Object.entries(processHealth ?? {}).filter(
    ([, value]) => record(value).status !== 'running',
  )

  const eventTimes =
    bootstrap.mode === 'paper_live'
      ? `${
          quote.eventTime === null
            ? 'Hora del evento no disponible'
            : `Evento ${utcDateTime(quote.eventTime)}`
        } · ${
          quote.receivedAt === null
            ? 'Recepción no disponible'
            : `recibido ${utcDateTime(quote.receivedAt)} · hace ${Math.floor(Math.max(0, displayClock - quote.receivedAt) / 1_000)} s`
        }`
      : null
  const statusItems: Array<{ key: string; tone?: string; text: string }> =
    !state || bootstrap.mode !== 'paper_live'
      ? []
      : [
          {
            key: 'feed',
            tone: feedTone,
            text: `Feed: ${marketStatusLabel(feedStatus)}`,
          },
          {
            key: 'funding',
            tone: fundingKnown ? 'ok' : 'warn',
            text: `Funding: ${fundingKnown ? 'conocido' : 'desconocido'}`,
          },
          ...(gatewayEngine && !engineOff
            ? [
                {
                  key: 'engine',
                  // Retired book D: history, never a current health signal.
                  tone: 'nodata' as string,
                  // History only: never «en marcha» or «ejecución activa».
                  text:
                    gatewayEngineStatus === 'unavailable'
                      ? 'Libro D (histórico): no disponible'
                      : 'Libro D (histórico, solo lectura)',
                },
              ]
            : []),
          ...downProcesses.map(([name, value]) => ({
            key: `process-${name}`,
            tone: 'bad',
            text: `Proceso ${name}: ${record(value).status === 'restarting' ? 'reiniciando' : 'caído'}`,
          })),
          ...(!engineOff && warmupCandles < WARMUP_CANDLES
            ? [
                {
                  key: 'warmup',
                  tone: 'warn',
                  text: `Calentando ${warmupCandles}/${WARMUP_CANDLES}`,
                },
              ]
            : []),
        ]
  // Only what needs attention stays on the page; the rest is in the diagnosis.
  const alerts = statusItems.filter(
    (item) => item.tone === 'warn' || item.tone === 'bad',
  )
  const diagnosis = (
    <details>
      <summary>Detalle técnico</summary>
      {eventTimes && <p>{eventTimes}</p>}
      <p>{connected ? 'Eventos WebSocket recibidos' : 'Esperando WebSocket'}</p>
      {bootstrap.mode === 'paper_live' && (
        <p>
          Mercado:{' '}
          {marketStatusLabel(
            marketState.market_status ?? record(bootstrap.market).status,
          )}
        </p>
      )}
      <p>Run: {activeRunId ?? 'cargando'}</p>
      {statusItems.length > 0 && <TerminalNotices items={statusItems} />}
      {state && bootstrap.mode === 'paper_live' && (
        <>
          <p>
            Última recepción:{' '}
            {Number.isSafeInteger(lastReceivedAt)
              ? utcDateTime(Number(lastReceivedAt))
              : 'Aún no hay datos recibidos'}
          </p>
          {typeof feedReason === 'string' && (
            <p>Motivo del estado: {feedReason}</p>
          )}
          <p>
            Integridad del libro:{' '}
            {String(
              record(
                marketState.book_quality ??
                  record(bootstrap.market).book_quality,
              ).book_sequence_integrity ??
                record(bootstrap.market).book_quality ??
                'No verificada',
            )}
          </p>
          <p>
            Financiación:{' '}
            {fundingKnown
              ? 'cobertura del período actual disponible.'
              : 'desconocida; entradas bloqueadas y PnL neto incompleto.'}
          </p>
        </>
      )}
      {!engineOff && (
        <p>
          Las cifras de cuenta y decisiones provienen del snapshot/eventos
          durables.
        </p>
      )}
    </details>
  )

  const modeLabel = 'PAPER · KRAKEN'
  const marketStrip = (
    <MarketStrip
      product={product}
      mode={bootstrap.mode}
      displayedPrice={displayedPrice}
      change24h={change24h}
      eventTimes={eventTimes}
      quoteLabel={quote.label}
      quoteReceivedAt={quote.receivedAt}
      displayClock={displayClock}
      alerts={alerts}
      compact={liveGateway}
    />
  )

  return (
    <AppShell
      brandHref="/"
      brandLabel="Balancita, volver a la aplicación"
      navigation={appNavigation('terminal')}
      viewport={liveGateway}
      center={<AccountBalance compact={liveGateway} />}
      market={liveGateway ? marketStrip : undefined}
      status={
        <>
          {sourceSwitch}
          <AppStatusChips
            compact={liveGateway}
            apiBase={apiBase}
            override={flowInputs}
            showUsage={bootstrap.mode === 'paper_live'}
            modeLabel={modeLabel}
            diagnosis={diagnosis}
            b1={bootstrap.mode === 'paper_live' ? health : undefined}
          />
        </>
      }
    >
      {!liveGateway && marketStrip}
      {error && (
        <p role="alert">
          {error} No se sustituyen datos desconectados por mocks.
        </p>
      )}
      {!state && <p role="status">Conectando al runtime de futuros…</p>}
      {state && (
        <>
          <ApprovedTerminalLayout
            tradeLayout={liveGateway}
            chart={
              <section
                className={`${TERMINAL_FRAME} ${liveGateway ? 'h-full min-h-0 pt-2' : 'observer-height'} flex flex-col`}
                aria-label={`Gráfico ${productPair(product)}`}
              >
                <TerminalMarketChart
                  market={market}
                  mode={bootstrap.mode}
                  analyses={bootstrap.mode === 'paper_live' ? analyses : []}
                  selectedId={bootstrap.mode === 'paper_live' ? selectedId : ''}
                  onSelect={selectAnalysis}
                  trades={liveGateway ? ownTrades : undefined}
                  viewport={liveGateway}
                  lifecycle={
                    liveGateway
                      ? lifecycleView({
                          analyses,
                          openTrade:
                            ownTrades.find((trade) => trade.open) ?? null,
                          nowMs: displayClock,
                          prices: minutePrices(market.candles),
                          trades: ownTrades,
                        })
                      : null
                  }
                  tradesConfirmed={tradeRead.source.state === 'ok'}
                  selectedTradeId={selectedTradeId}
                  tradeFocus={tradeFocus}
                  onSelectTrade={focusTrade}
                  apiBase={apiBase}
                  product={product}
                  ticker={
                    (marketState.ticker_stats ??
                      record(bootstrap.market).ticker_stats ??
                      null) as TerminalTickerStats | null
                  }
                  {...approvedChartData({
                    orders,
                    fills,
                    positions: positions ?? [],
                    position,
                  })}
                  positions={
                    positions
                      ? approvedChartData({
                          orders: [],
                          fills: [],
                          positions,
                          position,
                        }).positions
                      : undefined
                  }
                  quantityUnit={
                    typeof state?.quantity_unit === 'string'
                      ? state.quantity_unit
                      : undefined
                  }
                  historicalLabel={
                    gatewayEngine ? 'Histórico · Gateway D' : undefined
                  }
                />
              </section>
            }
            decisions={
              bootstrap.mode === 'paper_live' ? (
                <ObserverPanel
                  visualOperations
                  viewport={liveGateway}
                  product={product ?? bootstrap.products?.[0] ?? null}
                  health={health}
                  latest={
                    gatewayEngine && !engineOff
                      ? latestDecision(analyses)
                      : null
                  }
                  connected={connected}
                  connectedAtMs={connectedAtMs}
                  clock={serverClock}
                  localNowMs={displayClock}
                  glance={
                    liveGateway ? (
                      <TerminalOperationCard
                        compact
                        trade={selectedTrade}
                        source={tradeRead.source}
                        nowMs={displayClock}
                        onFocus={() => focusTrade(selectedTradeId)}
                        notice={qwenHealthNotice(qwenSource, displayClock)}
                      />
                    ) : undefined
                  }
                  news={
                    liveGateway ? (
                      <TerminalNewsPanel
                        viewport
                        briefing={newsBriefing}
                        items={newsItems}
                        loaded={newsLoaded}
                        nowMs={displayClock}
                        source={newsSource}
                        relevantOnly
                      />
                    ) : undefined
                  }
                >
                  <TerminalDecisions
                    embedded={liveGateway}
                    rows={decisionRows}
                    selectedId={selectedId}
                    onSelect={selectAnalysis}
                    notice={
                      engineOff && !analyses.length
                        ? 'Motor de decisiones apagado. Solo se muestran velas y precio públicos de Kraken Futures; no hay análisis, cuenta ni operaciones simuladas.'
                        : !analyses.length && gatewayEngine
                          ? (analysesNotice(
                              gatewayEngineStatus,
                              gatewayEngineReason,
                            ) ?? qwenNotice(qwenSource, analyses.length))
                          : qwenNotice(qwenSource, analyses.length)
                    }
                    selected={
                      selectedAnalysis &&
                      (!selectedAnalysis.formula_action ||
                        selectedNotes.length > 0) ? (
                        <SelectedDecision
                          analysis={selectedAnalysis}
                          id={selectedId}
                          time={utcTime(selectedDecisionTime)}
                          reason={analysisReason(selectedAnalysis)}
                          notes={selectedNotes}
                        />
                      ) : null
                    }
                  ></TerminalDecisions>
                </ObserverPanel>
              ) : (
                <TerminalDecisions
                  embedded={liveGateway}
                  rows={decisionRows}
                  selectedId={selectedId}
                  onSelect={selectAnalysis}
                  notice={
                    engineOff
                      ? 'Motor de decisiones apagado. Solo se muestran velas y precio públicos de Kraken Futures; no hay análisis, cuenta ni operaciones simuladas.'
                      : !analyses.length && gatewayEngine
                        ? analysesNotice(
                            gatewayEngineStatus,
                            gatewayEngineReason,
                          )
                        : null
                  }
                  selected={
                    selectedAnalysis && !engineOff ? (
                      <SelectedDecision
                        analysis={selectedAnalysis}
                        id={selectedId}
                        time={utcTime(selectedDecisionTime)}
                        reason={analysisReason(selectedAnalysis)}
                        notes={selectedNotes}
                      />
                    ) : null
                  }
                ></TerminalDecisions>
              )
            }
          />
        </>
      )}
    </AppShell>
  )
}
