import { useEffect, useMemo, useState } from 'react'
import { productBase, productPair } from '../domain/product-label.ts'
import { amount, compactUsd, usd } from '../../../shared/finance/format.ts'
import ApprovedTerminalChart, {
  type ApprovedChartOverlay,
  type ApprovedChartPane,
  type ApprovedTerminalCandle,
  type ApprovedTerminalMarker,
} from './ApprovedTerminalChart.tsx'
import {
  bollinger,
  donchian,
  ema,
  rsi,
  vwap,
} from '../domain/chart-indicators.ts'
import {
  CHART_TIMEFRAMES,
  useTerminalChart,
  type ChartDepth,
  type ChartFlowPoint,
  type TerminalTickerStats,
} from '../infrastructure/terminal-chart-client.ts'
import {
  exitMarkers,
  fillDetailRows,
  fillMarkers,
  groupWaitMarkers,
  strategyCode,
  strategyMarkerColor,
  positionLines,
  chartPositions,
  timeframeCandles,
} from '../domain/terminal-chart-model.ts'
import './terminal-chart-panel.css'

type Overlay = 'ema9' | 'ema21' | 'bollinger' | 'donchian' | 'vwap'
type Pane = 'flow' | 'oi' | 'liquidations' | 'positioning' | 'premium' | 'rsi'

const OVERLAYS: ReadonlyArray<{ id: Overlay; label: string; color: string }> = [
  { id: 'ema9', label: 'EMA 9', color: '#e6b35a' },
  { id: 'ema21', label: 'EMA 21', color: '#8fb4ff' },
  { id: 'bollinger', label: 'Bollinger 20', color: '#b48ff0' },
  { id: 'donchian', label: 'Donchian 20', color: '#5fc4d3' },
  { id: 'vwap', label: 'VWAP diario', color: '#e98fc0' },
]
const PANES: ReadonlyArray<{ id: Pane; label: string; live: boolean }> = [
  { id: 'flow', label: 'Compra/venta', live: true },
  { id: 'oi', label: 'Interés abierto', live: true },
  { id: 'liquidations', label: 'Liquidaciones', live: true },
  { id: 'positioning', label: 'Long/short', live: true },
  { id: 'premium', label: 'Prima perpetuo-contado (pb)', live: true },
  { id: 'rsi', label: 'RSI 14', live: false },
]

/** How long a pane without data still reads «Cargando» (the collector may be downloading). */
const PANE_LOAD_MS = 90_000

type Settings = { intervalMs: number; overlays: Overlay[]; panes: Pane[] }
const STORAGE_KEY = 'balancita.terminal-chart.v1'
const DEFAULTS: Settings = {
  intervalMs: 60_000,
  overlays: ['ema21'],
  panes: ['flow'],
}

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<Settings> | null
    if (!raw) return DEFAULTS
    return {
      intervalMs: CHART_TIMEFRAMES.some((item) => item.ms === raw.intervalMs)
        ? Number(raw.intervalMs)
        : DEFAULTS.intervalMs,
      overlays: (raw.overlays ?? []).filter((id) =>
        OVERLAYS.some((item) => item.id === id),
      ),
      panes: (raw.panes ?? []).filter((id) =>
        PANES.some((item) => item.id === id),
      ),
    }
  } catch {
    return DEFAULTS
  }
}

const css = (name: string, fallback: string) =>
  typeof document === 'undefined'
    ? fallback
    : getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim() || fallback

const percent = (value: number | null | undefined, digits = 2) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${amount(value, digits)} %`

function countdown(target: number | null | undefined, now: number): string {
  if (target == null) return '—'
  const seconds = Math.max(0, Math.floor((target - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function overlayLines(
  candles: readonly ApprovedTerminalCandle[],
  enabled: readonly Overlay[],
): ApprovedChartOverlay[] {
  const color = (id: Overlay) => OVERLAYS.find((item) => item.id === id)!.color
  const out: ApprovedChartOverlay[] = []
  if (enabled.includes('ema9'))
    out.push({ id: 'ema9', color: color('ema9'), points: ema(candles, 9) })
  if (enabled.includes('ema21'))
    out.push({ id: 'ema21', color: color('ema21'), points: ema(candles, 21) })
  if (enabled.includes('bollinger')) {
    const bands = bollinger(candles, 20, 2)
    out.push(
      { id: 'bb-up', color: color('bollinger'), points: bands.upper },
      {
        id: 'bb-mid',
        color: color('bollinger'),
        points: bands.middle,
        dashed: true,
      },
      { id: 'bb-low', color: color('bollinger'), points: bands.lower },
    )
  }
  if (enabled.includes('donchian')) {
    const channel = donchian(candles, 20)
    out.push(
      { id: 'dc-up', color: color('donchian'), points: channel.upper },
      { id: 'dc-low', color: color('donchian'), points: channel.lower },
    )
  }
  if (enabled.includes('vwap'))
    out.push({ id: 'vwap', color: color('vwap'), points: vwap(candles) })
  return out
}

function flowPanes(
  enabled: readonly Pane[],
  flow: readonly ChartFlowPoint[],
  candles: readonly ApprovedTerminalCandle[],
  colors: { up: string; down: string; amber: string; info: string },
): ApprovedChartPane[] {
  const points = (pick: (point: ChartFlowPoint) => number | null) =>
    flow.flatMap((point) => {
      const value = pick(point)
      return value === null
        ? []
        : [{ time: Math.floor(point.time_ms / 1000), value }]
    })
  const panes: ApprovedChartPane[] = []
  for (const pane of PANES) {
    if (!enabled.includes(pane.id)) continue
    if (pane.id === 'flow')
      panes.push({
        id: 'flow',
        series: [
          {
            id: 'buy',
            kind: 'histogram',
            color: colors.up,
            points: points((point) => point.buy_volume),
            precision: 3,
          },
          {
            id: 'sell',
            kind: 'histogram',
            color: colors.down,
            points: points((point) =>
              point.sell_volume === null ? null : -point.sell_volume,
            ),
            precision: 3,
          },
        ],
      })
    else if (pane.id === 'oi')
      panes.push({
        id: 'oi',
        series: [
          {
            id: 'oi',
            kind: 'line',
            color: colors.info,
            points: points((point) => point.open_interest),
            precision: 1,
          },
        ],
      })
    else if (pane.id === 'liquidations')
      panes.push({
        id: 'liquidations',
        series: [
          {
            id: 'liq',
            kind: 'histogram',
            color: colors.amber,
            points: points((point) => point.liquidation_volume),
            precision: 3,
          },
        ],
      })
    else if (pane.id === 'positioning')
      panes.push({
        id: 'positioning',
        series: [
          {
            id: 'long',
            kind: 'line',
            color: colors.up,
            points: points((point) => point.long_percent),
            precision: 1,
          },
          {
            id: 'top-long',
            kind: 'line',
            color: colors.amber,
            points: points((point) => point.top_long_percent),
            precision: 1,
          },
        ],
      })
    else if (pane.id === 'premium')
      panes.push({
        id: 'premium',
        series: [
          {
            id: 'premium',
            kind: 'line',
            color: colors.info,
            points: points((point) => point.premium_bp),
            precision: 2,
          },
        ],
      })
    else if (pane.id === 'rsi')
      panes.push({
        id: 'rsi',
        series: [
          {
            id: 'rsi',
            kind: 'line',
            color: colors.info,
            points: rsi(candles, 14),
            precision: 1,
          },
        ],
      })
  }
  // A pane with no point at all is not drawn: an empty strip would read as
  // «zero», not as «no data» (the legend says which ones are missing).
  return panes.filter((pane) =>
    pane.series.some((series) => series.points.length > 0),
  )
}

function depthWithin(depth: ChartDepth | null, band: string) {
  if (!depth) return null
  const bid = depth.bid[band]
  const ask = depth.ask[band]
  return bid == null || ask == null ? null : { bid, ask }
}

/** WAIT verdicts closer than this share one marker (a verdict per minute). */
const WAIT_GROUP_SECONDS = 900
const NO_FILLS: readonly unknown[] = []

export default function TerminalChartPanel({
  candles,
  markers,
  selectedId,
  onSelect,
  apiBase,
  product,
  live,
  ticker,
  position,
  positions,
  orders,
  fills = NO_FILLS,
  quantityUnit,
  proposalLegend = false,
  historicalLabel,
  instrument = `${productPair(product)} perpetuo`,
}: {
  /** Live 1m candles from the terminal stream (seconds). */
  candles: readonly ApprovedTerminalCandle[]
  markers: readonly ApprovedTerminalMarker[]
  selectedId: string
  onSelect: (markerId: string) => void
  apiBase: string
  product?: string
  /** Real Kraken data behind the gateway: fetch analytics and timeframes. */
  live: boolean
  ticker: TerminalTickerStats | null
  position: Record<string, unknown>
  /** One open position per strategy book (gateway `positions`). */
  positions?: readonly unknown[]
  orders: readonly unknown[]
  /** Durable fills of the gateway: one EJEC. marker per fill. */
  fills?: readonly unknown[]
  /** Base unit of the fills' quantity (the gateway's `quantity_unit`). */
  quantityUnit?: string
  /** Live gateway: the legend names proposals, WAIT, EJEC. and exits. */
  proposalLegend?: boolean
  /** Positions and exits come from a retired book: every one carries this label. */
  historicalLabel?: string
  instrument?: string
}) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [now, setNow] = useState(() => Date.now())
  // When each live pane was asked for (per product and timeframe): a pane whose
  // data has not arrived shows «Cargando…» first and «Sin datos» after a while.
  const [askedAt, setAskedAt] = useState<Record<string, number>>({})
  // A picked EJEC. marker: independent of the decision selection (a fill is
  // not linked to any verdict). The decision picked from outside or another
  // product clears it.
  const [pickedFill, setPickedFill] = useState<string | null>(null)
  const [pickedFor, setPickedFor] = useState(`${product ?? ''}|${selectedId}`)
  const resetKey = `${product ?? ''}|${selectedId}`
  if (pickedFor !== resetKey) {
    setPickedFor(resetKey)
    setPickedFill(null)
  }
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Private mode or blocked storage: settings last for this view only.
    }
  }, [settings])
  useEffect(() => {
    // The funding countdown ticks only over real market data.
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [live])
  const remote = useTerminalChart(
    apiBase,
    settings.intervalMs,
    live,
    undefined,
    product,
  )
  const intervalSeconds = settings.intervalMs / 1000
  // Real data: wait for the server series instead of opening on the few
  // candles the 1m stream can fold (the view would stay on them).
  const waiting = live && intervalSeconds !== 60 && remote === null
  const timeframeLabel =
    CHART_TIMEFRAMES.find((item) => item.ms === settings.intervalMs)?.label ??
    ''
  const shown = useMemo(
    () => timeframeCandles(candles, intervalSeconds, remote?.candles ?? null),
    [candles, intervalSeconds, remote],
  )
  const colors = useMemo(
    () => ({
      up: css('--chart-up', '#55c7a2'),
      down: css('--chart-down', '#ee7777'),
      amber: css('--warning', '#d4aa62'),
      info: css('--info', '#79a9bd'),
      muted: css('--muted-foreground', '#8b969a'),
    }),
    [],
  )
  const overlays = useMemo(
    () => overlayLines(shown, settings.overlays),
    [shown, settings.overlays],
  )
  const panes = useMemo(
    () =>
      flowPanes(
        settings.panes.filter(
          (id) => live || !PANES.find((pane) => pane.id === id)!.live,
        ),
        remote?.flow ?? [],
        shown,
        colors,
      ),
    [settings.panes, remote, shown, colors, live],
  )
  const askKey = (id: Pane) => `${id}|${product ?? ''}|${settings.intervalMs}`
  const wantedLive = settings.panes.filter(
    (id) => live && PANES.find((pane) => pane.id === id)!.live,
  )
  if (wantedLive.some((id) => askedAt[askKey(id)] === undefined)) {
    const next = { ...askedAt }
    for (const id of wantedLive) next[askKey(id)] ??= Date.now()
    setAskedAt(next)
  }
  const pendingPanes = wantedLive
    .filter((id) => !panes.some((pane) => pane.id === id))
    .map((id) => {
      const label = PANES.find((pane) => pane.id === id)!.label
      const loading =
        remote === null || now - (askedAt[askKey(id)] ?? now) < PANE_LOAD_MS
      return {
        id,
        text: loading
          ? `Cargando ${label}…`
          : `Sin datos de ${label} por ahora`,
      }
    })
  const stats = ticker ?? remote?.ticker ?? null
  const mark = stats?.mark ?? null
  const lines = useMemo(() => {
    const open = chartPositions(positions, position, product ?? 'PF_XBTUSD')
    const out = open.flatMap((item, index) => {
      const strategyId =
        typeof item.strategy_id === 'string' ? item.strategy_id : undefined
      // Several books: each strategy draws its own lines in its own colour.
      const own = open.length > 1 ? strategyMarkerColor(strategyId) : undefined
      return positionLines(
        item,
        own
          ? { entry: own, stop: own, target: own }
          : { entry: colors.info, stop: colors.down, target: colors.up },
        open.length > 1
          ? {
              id: `${strategyId ?? 'book'}-${index}`,
              code: strategyCode(strategyId),
            }
          : undefined,
      ).map((line) =>
        historicalLabel
          ? { ...line, title: `${historicalLabel} · ${line.title}` }
          : line,
      )
    })
    if (mark != null)
      out.push({
        id: 'mark',
        price: mark,
        title: 'MARK',
        color: colors.muted,
        dashed: true,
      })
    return out
  }, [positions, position, product, mark, colors, historicalLabel])
  const everyMarker = useMemo(() => {
    const period = {
      // Only operations inside the candles on screen: none from another period.
      ...(shown.length > 0
        ? {
            from: shown[0]!.time,
            to: shown.at(-1)!.time + intervalSeconds,
          }
        : {}),
      ...(historicalLabel ? { prefix: historicalLabel } : {}),
    }
    return groupWaitMarkers(
      [
        ...markers,
        ...fillMarkers(fills, orders, {
          ...period,
          ...(quantityUnit ? { unit: quantityUnit } : {}),
        }),
        ...exitMarkers(orders, period),
      ],
      Math.max(intervalSeconds, WAIT_GROUP_SECONDS),
    )
  }, [
    markers,
    orders,
    fills,
    quantityUnit,
    shown,
    intervalSeconds,
    historicalLabel,
  ])
  const allMarkers = everyMarker
  // Only a fill marker that is still on this chart can be the picked one.
  const fillId =
    pickedFill !== null &&
    allMarkers.some(
      (marker) => marker.type === 'fill' && marker.id === pickedFill,
    )
      ? pickedFill
      : null
  const fillRows = useMemo(() => {
    if (fillId === null) return null
    const fill = fills.find((item) => {
      const data = item as { fill_id?: unknown }
      return data.fill_id === fillId
    })
    return fill === undefined
      ? null
      : fillDetailRows(fill, {
          ...(quantityUnit ? { unit: quantityUnit } : {}),
          ...(historicalLabel ? { source: historicalLabel } : {}),
        })
  }, [fillId, fills, quantityUnit, historicalLabel])
  const latestFlow = remote?.flow.at(-1)
  const depth = depthWithin(remote?.depth ?? null, 'liquidity01')
  const toggle = <T extends string>(list: readonly T[], id: T): T[] =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
  const change = stats?.change_24h_pct ?? null

  return (
    <div className="terminal-chart">
      <div className="terminal-chart__toolbar">
        <div
          className="terminal-chart__seg"
          role="group"
          aria-label="Temporalidad"
        >
          {CHART_TIMEFRAMES.map((item) => (
            <button
              key={item.ms}
              type="button"
              aria-pressed={settings.intervalMs === item.ms}
              onClick={() =>
                setSettings((value) => ({ ...value, intervalMs: item.ms }))
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <details className="terminal-chart__tools">
          <summary>Indicadores y paneles</summary>
          <div className="terminal-chart__tools-body">
            <fieldset className="terminal-chart__toggles">
              <legend>Indicadores</legend>
              {OVERLAYS.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={settings.overlays.includes(item.id)}
                    onChange={() =>
                      setSettings((value) => ({
                        ...value,
                        overlays: toggle(value.overlays, item.id),
                      }))
                    }
                  />
                  <span
                    className="terminal-chart__swatch"
                    style={{ background: item.color }}
                    aria-hidden="true"
                  />
                  {item.label}
                </label>
              ))}
            </fieldset>
            <fieldset className="terminal-chart__toggles">
              <legend>Paneles</legend>
              {PANES.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={settings.panes.includes(item.id)}
                    disabled={item.live && !live}
                    onChange={() =>
                      setSettings((value) => ({
                        ...value,
                        panes: toggle(value.panes, item.id),
                      }))
                    }
                  />
                  {item.label}
                </label>
              ))}
            </fieldset>
          </div>
        </details>
        <details className="terminal-chart__more">
          <summary>Más datos del mercado</summary>
          <dl
            className="terminal-chart__stats"
            aria-label="Más datos del mercado"
          >
            <div>
              <dt>Máx / mín 24 h</dt>
              <dd>
                {usd(stats?.high_24h, 0)} / {usd(stats?.low_24h, 0)}
              </dd>
            </div>
            <div>
              <dt>Volumen 24 h</dt>
              <dd>
                {amount(stats?.volume_24h_base, 1)} {productBase(product)} ·{' '}
                {compactUsd(stats?.volume_24h_quote)}
              </dd>
            </div>
            <div>
              <dt>Mark / índice</dt>
              <dd>
                {usd(stats?.mark)} / {usd(stats?.index)}
              </dd>
            </div>
            <div>
              <dt>Profundidad ±0,1 %</dt>
              <dd>
                {depth
                  ? `${amount(depth.bid, 1)} / ${amount(depth.ask, 1)} ${productBase(product)}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Cuentas en largo</dt>
              <dd>
                {latestFlow?.long_percent == null
                  ? '—'
                  : `${amount(latestFlow.long_percent, 1)} %`}
                {latestFlow?.top_long_percent == null
                  ? ''
                  : ` · top 20 %: ${amount(latestFlow.top_long_percent, 1)} %`}
              </dd>
            </div>
          </dl>
        </details>
        <dl className="terminal-chart__stats" aria-label="Datos del mercado">
          <div>
            <dt>Cambio 24 h</dt>
            <dd
              className={
                change == null
                  ? undefined
                  : change >= 0
                    ? 'terminal-chart__up'
                    : 'terminal-chart__down'
              }
            >
              {percent(change)}
            </dd>
          </div>
          <div>
            <dt>Funding (por hora)</dt>
            <dd>
              {stats?.relative_funding_rate == null
                ? '—'
                : percent(stats.relative_funding_rate * 100, 4)}
              {' · próx. '}
              {stats?.relative_funding_rate_prediction == null
                ? '—'
                : percent(stats.relative_funding_rate_prediction * 100, 4)}
              {' en '}
              {countdown(stats?.next_funding_time_ms, now)}
            </dd>
          </div>
          <div>
            <dt>Bid / ask</dt>
            <dd>
              {usd(stats?.bid, 0)} ({amount(stats?.bid_size, 3)}) /{' '}
              {usd(stats?.ask, 0)} ({amount(stats?.ask_size, 3)}) · spread{' '}
              {usd(stats?.spread)}
            </dd>
          </div>
          <div>
            <dt>Interés abierto</dt>
            <dd>
              {amount(stats?.open_interest, 1)} {productBase(product)}
              {stats?.open_interest != null && stats.mark != null
                ? ` · ${compactUsd(stats.open_interest * stats.mark)}`
                : ''}
            </dd>
          </div>
        </dl>
      </div>
      {!live && (
        <p className="terminal-chart__note">
          Flujo de órdenes, interés abierto, liquidaciones y long/short solo
          están disponibles con el mercado real de Kraken.
        </p>
      )}

      {waiting ? (
        <p className="terminal-chart__loading" role="status">
          Cargando velas de {timeframeLabel}…
        </p>
      ) : (
        <ApprovedTerminalChart
          // A new timeframe opens on its latest candles, not on an old selection.
          key={settings.intervalMs}
          focusOnMount={false}
          candles={shown}
          markers={allMarkers}
          selectedId={fillId ?? selectedId}
          intervalSeconds={intervalSeconds}
          currency="USD"
          instrument={instrument}
          initialViewport="approved-terminal"
          overlays={overlays}
          panes={panes}
          priceLines={lines}
          onSelect={(time, markerId) => {
            if (markerId) {
              // An executed operation (EJEC.) opens its own facts; it never
              // selects a decision. Picking it again closes them.
              if (
                allMarkers.some(
                  (marker) => marker.type === 'fill' && marker.id === markerId,
                )
              ) {
                setPickedFill((current) =>
                  current === markerId ? null : markerId,
                )
                return
              }
              // Only ids of this chart's decision markers reach the selection
              // (exit markers and foreign ids are ignored).
              if (markers.some((marker) => marker.id === markerId)) {
                setPickedFill(null)
                onSelect(markerId)
              }
              return
            }
            if (!Number.isFinite(time)) return
            const bucket = Math.floor(time / intervalSeconds) * intervalSeconds
            const bucketMarkers = markers.filter(
              (marker) =>
                Math.floor(marker.time / intervalSeconds) * intervalSeconds ===
                bucket,
            )
            if (bucketMarkers.length === 0) return
            const current = bucketMarkers.findIndex(
              (marker) => marker.id === selectedId,
            )
            const next = bucketMarkers[(current + 1) % bucketMarkers.length]
            if (next) {
              setPickedFill(null)
              onSelect(next.id)
            }
          }}
        />
      )}
      {pendingPanes.map((pane) => (
        <p
          key={pane.id}
          className="terminal-chart__pane-placeholder"
          role="status"
        >
          {pane.text}
        </p>
      ))}
      {fillRows && (
        <section
          className="terminal-chart__fill-detail"
          aria-label="Ejecución seleccionada"
          data-testid="fill-detail"
        >
          <header>
            <h3>Ejecución seleccionada (EJEC.)</h3>
            <button type="button" onClick={() => setPickedFill(null)}>
              Cerrar
            </button>
          </header>
          <dl>
            {fillRows.map((row) => (
              <div key={row.key} data-field={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          <p>
            Evento independiente: no está vinculado a ninguna decisión ni
            veredicto.
          </p>
        </section>
      )}
      <p className="terminal-chart__legend">
        {proposalLegend ? (
          <>
            <span data-testid="legend-proposal">
              <b className="terminal-chart__up">▲</b>
              <b className="terminal-chart__down">▼</b> propuesta LONG/SHORT (no
              es una operación)
            </span>
            <span data-testid="legend-wait">
              <b style={{ color: colors.muted }}>◌</b> W = WAIT (W×n: agrupados)
            </span>
            <span data-testid="legend-fill">
              <b className="terminal-chart__up">■</b> EJEC. ejecución paper (EJ
              L/S, un marcador por fill; el detalle sale al seleccionarlo)
            </span>
            <span data-testid="legend-exit">
              <b style={{ color: colors.info }}>●</b> salida (stop, objetivo,
              tiempo)
            </span>
          </>
        ) : (
          <>
            <span>
              <b className="terminal-chart__up">▲</b> entrada larga
            </span>
            <span>
              <b className="terminal-chart__down">▼</b> entrada corta
            </span>
            <span>
              <b style={{ color: colors.info }}>●</b> salida (stop, objetivo,
              tiempo)
            </span>
          </>
        )}
        {panes.some((pane) => pane.id === 'flow') && (
          <span>
            Compra/venta: volumen agresor comprador arriba, vendedor abajo
          </span>
        )}
        {panes.some((pane) => pane.id === 'positioning') && (
          <span>
            Long/short: % de cuentas en largo (verde) y top 20 % (ámbar)
          </span>
        )}
        {panes.some((pane) => pane.id === 'premium') && (
          <span>
            Prima: precio del perpetuo sobre el contado, en puntos básicos
          </span>
        )}
      </p>
    </div>
  )
}
