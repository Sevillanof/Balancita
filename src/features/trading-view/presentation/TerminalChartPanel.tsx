import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ModalFrame from '../../strategy-lab/presentation/ModalFrame.tsx'
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
  currentDayValueArea,
  donchian,
  ema,
  priorDayValueArea,
  volumeProfile,
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
import {
  tradeIdentity,
  tradeHistoryNotice,
  tradeTone,
  type TerminalChartTrade,
} from '../domain/terminal-trade-model.ts'
import { signedUsd } from '../../../app/qwen-trades-text.ts'
import type { LifecycleView } from '../../../app/terminal-lifecycle.ts'
import LifecycleSteps from './LifecycleSteps.tsx'

const SUMMARY_CLASSES =
  'inline-flex min-h-7.5 items-center rounded-lg border border-solid border-line px-chart-control py-0 text-ink-2 cursor-pointer chart-desktop:min-h-6.5 chart-desktop:whitespace-nowrap'
const TOGGLES_CLASSES =
  'm-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-0 border-none border-current p-0 text-control leading-normal chart-phone:flex-nowrap chart-phone:whitespace-nowrap'
const LEGEND_CLASSES =
  'float-left mr-1 text-stat-label leading-normal tracking-label text-ink-2 uppercase'
const LABEL_CLASSES =
  'inline-flex min-h-7.5 items-center gap-chart-label cursor-pointer'

function ChartStats({
  children,
  compact = false,
  dialog = false,
}: {
  children: ReactNode
  compact?: boolean
  dialog?: boolean
}) {
  return (
    <dl
      aria-label={compact ? 'Datos del mercado' : 'Más datos del mercado'}
      className={
        dialog
          ? 'm-0 grid grid-cols-1 gap-2 text-body from-600:grid-cols-2 child-div:min-w-0 child-div:whitespace-normal'
          : `m-0 grid grid-cols-chart-stats gap-x-4 gap-y-chart-row px-3 py-0 text-provenance leading-normal chart-phone:flex chart-phone:gap-chart-gap chart-phone:overflow-x-auto chart-phone:pb-1 chart-phone:snap-x chart-phone:snap-proximity chart-desktop:flex chart-desktop:gap-chart-gap ${
              compact
                ? 'chart-phone:flex-none chart-desktop:order-2 chart-desktop:min-w-0 chart-desktop:flex-auto chart-desktop:basis-full chart-desktop:shrink-0 chart-desktop:flex-nowrap chart-desktop:justify-start chart-desktop:gap-x-chart-strip chart-desktop:gap-y-0 chart-desktop:p-0 chart-desktop:text-stat-label'
                : 'group-open:absolute group-open:top-popover group-open:left-0 group-open:z-20 group-open:w-chart-popover group-open:rounded-lg group-open:border group-open:border-solid group-open:border-line group-open:bg-surface-1 group-open:p-chart-inset! group-open:shadow-popover chart-desktop:flex-wrap chart-desktop:pt-2'
            }`
      }
    >
      {children}
    </dl>
  )
}

function ChartMenu({
  label,
  compactLabel,
  viewport,
  inline = false,
  compactStats,
  children,
}: {
  label: string
  compactLabel: string
  viewport: boolean
  inline?: boolean
  compactStats?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!viewport && inline) return children
  if (!viewport)
    return (
      <>
        <details className="group relative text-provenance leading-normal chart-phone:flex-none">
          <summary className={SUMMARY_CLASSES}>{label}</summary>
          {children}
        </details>
        {compactStats}
      </>
    )
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={() => setOpen(true)}
        className={
          inline
            ? 'cursor-pointer border-0 bg-transparent px-2 py-0 text-left text-label text-ink-2'
            : 'min-h-6 cursor-pointer rounded-sm border border-solid border-line bg-transparent px-2 text-label text-ink-2'
        }
      >
        {compactLabel}
      </button>
      {open && (
        <ModalFrame label={label} wide onClose={() => setOpen(false)}>
          <header className="flex items-center justify-between gap-2">
            <h2>{label}</h2>
            <button type="button" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </header>
          {compactStats}
          {children}
        </ModalFrame>
      )}
    </>
  )
}

function ChartStat({
  label,
  children,
  compact = false,
  tone,
}: {
  label: string
  children: ReactNode
  compact?: boolean
  tone?: 'text-long' | 'text-short'
}) {
  return (
    <div
      className={`grid min-w-0 gap-chart-unit rounded-panel border border-solid border-line bg-surface-1 px-chart-inset py-chart-gap chart-phone:min-w-34 chart-phone:max-w-56 chart-phone:flex-none chart-phone:snap-start ${
        compact
          ? 'chart-desktop:flex chart-desktop:flex-initial chart-desktop:items-baseline chart-desktop:gap-chart-gap chart-desktop:border-0 chart-desktop:border-none chart-desktop:border-current chart-desktop:bg-transparent chart-desktop:p-0 chart-desktop:whitespace-nowrap'
          : 'chart-desktop:flex-1 chart-desktop:basis-44 chart-desktop:py-chart-label'
      }`}
    >
      <dt
        className={`text-stat-label leading-normal tracking-label text-ink-2 uppercase ${compact ? 'chart-desktop:text-stat-compact' : ''}`}
      >
        {label}
      </dt>
      <dd
        className={`m-0 font-brand-mono tabular-nums wrap-anywhere ${tone ?? ''}`}
      >
        {children}
      </dd>
    </div>
  )
}

type Overlay =
  | 'ema9'
  | 'ema21'
  | 'bollinger'
  | 'donchian'
  | 'vwap'
  | 'valueArea'
  | 'valueAreaToday'
  | 'volumeProfile'
type Pane = 'flow' | 'oi' | 'liquidations' | 'positioning' | 'premium' | 'rsi'

const OVERLAYS: ReadonlyArray<{ id: Overlay; label: string; color: string }> = [
  { id: 'ema9', label: 'EMA 9', color: '#e6b35a' },
  { id: 'ema21', label: 'EMA 21', color: '#8fb4ff' },
  { id: 'bollinger', label: 'Bollinger 20', color: '#b48ff0' },
  { id: 'donchian', label: 'Donchian 20', color: '#5fc4d3' },
  { id: 'vwap', label: 'VWAP diario', color: '#e98fc0' },
  { id: 'valueArea', label: 'Área de valor (día previo)', color: '#d9a066' },
  {
    id: 'valueAreaToday',
    label: 'Área de valor (día en curso, en vivo)',
    color: '#4fd1a1',
  },
  { id: 'volumeProfile', label: 'Perfil de volumen (24 h)', color: '#d9a066' },
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

const CAPTURED_PANE_PRODUCTS: readonly string[] = ['PF_XBTUSD', 'PF_ETHUSD']
const CAPTURED_ONLY_PANES: readonly Pane[] = [
  'flow',
  'oi',
  'liquidations',
  'positioning',
]
function uncapturedPane(id: Pane, product: string | undefined): boolean {
  return (
    CAPTURED_ONLY_PANES.includes(id) &&
    product !== undefined &&
    !CAPTURED_PANE_PRODUCTS.includes(product)
  )
}

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
  /** Deeper candles (15m) the value area is computed from. */
  areaSource: readonly ApprovedTerminalCandle[] = candles,
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
  if (enabled.includes('valueArea')) {
    const area = priorDayValueArea(areaSource, candles)
    out.push(
      { id: 'va-vah', color: color('valueArea'), points: area.vah },
      {
        id: 'va-poc',
        color: color('valueArea'),
        points: area.poc,
        dashed: true,
      },
      { id: 'va-val', color: color('valueArea'), points: area.val },
    )
  }
  if (enabled.includes('valueAreaToday')) {
    const area = currentDayValueArea(areaSource, candles)
    out.push(
      { id: 'vt-vah', color: color('valueAreaToday'), points: area.vah },
      {
        id: 'vt-poc',
        color: color('valueAreaToday'),
        points: area.poc,
        dashed: true,
      },
      { id: 'vt-val', color: color('valueAreaToday'), points: area.val },
    )
  }
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
  trades,
  tradesConfirmed = false,
  selectedTradeId = '',
  tradeFocus = null,
  onSelectTrade,
  viewport = false,
  lifecycle = null,
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
  trades?: readonly TerminalChartTrade[]
  tradesConfirmed?: boolean
  selectedTradeId?: string
  tradeFocus?: { id: string; revision: number } | null
  onSelectTrade?: (id: string) => void
  viewport?: boolean
  /** Steps of the entry (no open operation) or exit cycle, shown at the right of the bar. */
  lifecycle?: LifecycleView | null
}) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [now, setNow] = useState(() => Date.now())
  const [timeFocus, setTimeFocus] = useState<{
    ms: number
    revision: number
  } | null>(null)
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
    trades === undefined
      ? undefined
      : Math.min(
          5_000,
          Math.max(
            500,
            Math.ceil(
              ((candles.at(-1)?.time ?? 0) * 1000 -
                Math.min(...trades.map((trade) => trade.entryMs))) /
                settings.intervalMs,
            ) + 60,
          ),
        ),
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
      up: css('--color-chart-up', '#55c7a2'),
      down: css('--color-chart-down', '#ee7777'),
      amber: css('--color-chart-warn', '#d4aa62'),
      info: css('--color-chart-info', '#79a9bd'),
      muted: css('--color-chart-text', '#8b969a'),
    }),
    [],
  )
  // The value area (previous day) and the 24 h profile need up to two days of
  // candles, more than the 500 the 1m stream holds (about 8 h): they read
  // their own 15m / 5m series, kept current by the same live 1m stream, so
  // they follow the chart whatever timeframe is on screen.
  const wantsArea =
    settings.overlays.includes('valueArea') ||
    settings.overlays.includes('valueAreaToday')
  const wantsProfile = settings.overlays.includes('volumeProfile')
  const areaRemote = useTerminalChart(
    apiBase,
    900_000,
    live && wantsArea,
    undefined,
    product,
  )
  const profileRemote = useTerminalChart(
    apiBase,
    300_000,
    live && wantsProfile,
    undefined,
    product,
  )
  const areaSource = useMemo(
    () =>
      wantsArea
        ? timeframeCandles(candles, 900, areaRemote?.candles ?? null)
        : [],
    [candles, wantsArea, areaRemote],
  )
  const profileSource = useMemo(
    () =>
      wantsProfile
        ? timeframeCandles(candles, 300, profileRemote?.candles ?? null)
        : [],
    [candles, wantsProfile, profileRemote],
  )
  const overlays = useMemo(
    () => overlayLines(shown, settings.overlays, areaSource),
    [shown, settings.overlays, areaSource],
  )
  const profile = useMemo(() => {
    if (profileSource.length === 0) return null
    const from = profileSource[profileSource.length - 1]!.time - 86_400
    return volumeProfile(profileSource.filter((candle) => candle.time > from))
  }, [profileSource])
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
      // The capture of order flow, open interest, liquidations and long/short
      // is for ETH and BTC only: for another product it never arrives, so no «Cargando».
      if (remote !== null && uncapturedPane(id, product))
        return {
          id,
          text: `${label} solo se captura para ETH y BTC: no hay datos de ${productBase(product)}`,
        }
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
    const open = chartPositions(positions, position, product ?? 'PF_ETHUSD')
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
    <div
      className={
        viewport
          ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-1'
          : 'flex min-h-0 flex-1 flex-col gap-chart-gap chart-desktop:gap-chart-tight'
      }
    >
      <div
        className={
          viewport
            ? 'flex flex-none flex-wrap items-center gap-x-2 gap-y-1 px-2'
            : 'flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-0 chart-phone:flex-nowrap chart-phone:gap-x-3 chart-phone:overflow-x-auto chart-phone:pb-1 chart-desktop:gap-x-3 chart-desktop:gap-y-1 chart-desktop:px-2'
        }
      >
        {viewport ? (
          <select
            aria-label="Temporalidad"
            value={settings.intervalMs}
            onChange={(event) =>
              setSettings((value) => ({
                ...value,
                intervalMs: Number(event.target.value),
              }))
            }
            className="h-6 cursor-pointer rounded-sm border border-solid border-line bg-surface-1 px-1 py-0 text-label leading-4 text-ink"
          >
            {CHART_TIMEFRAMES.map((item) => (
              <option key={item.ms} value={item.ms}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <div
            className="inline-flex gap-0.5 rounded-lg border border-solid border-line p-0.75 chart-phone:flex-none chart-desktop:p-0.5"
            role="group"
            aria-label="Temporalidad"
          >
            {CHART_TIMEFRAMES.map((item) => (
              <button
                className="min-h-7.5 cursor-pointer rounded-brand border-0 border-none border-current bg-transparent px-chart-control py-0 text-control! leading-normal! text-ink-2 aria-pressed:bg-line aria-pressed:text-inherit chart-desktop:min-h-6.5 chart-desktop:whitespace-nowrap"
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
        )}
        <ChartMenu
          viewport={viewport}
          label="Indicadores y paneles"
          compactLabel="Indicadores"
        >
          <div
            className={
              viewport
                ? 'grid min-w-0 gap-3'
                : 'absolute top-popover left-0 z-20 grid min-w-88 gap-2 rounded-lg border border-solid border-line bg-surface-1 p-3 shadow-popover'
            }
          >
            <fieldset
              className={
                viewport
                  ? 'm-0 grid grid-cols-1 gap-1 border-0 p-0 from-600:grid-cols-2'
                  : TOGGLES_CLASSES
              }
            >
              <legend className={LEGEND_CLASSES}>Indicadores</legend>
              {OVERLAYS.map((item) => (
                <label className={LABEL_CLASSES} key={item.id}>
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
                    className="h-0.75 w-2.5 rounded-swatch"
                    style={{ background: item.color }}
                    aria-hidden="true"
                  />
                  {item.label}
                </label>
              ))}
            </fieldset>
            <fieldset
              className={
                viewport
                  ? 'm-0 grid grid-cols-1 gap-1 border-0 p-0 from-600:grid-cols-2'
                  : TOGGLES_CLASSES
              }
            >
              <legend className={LEGEND_CLASSES}>Paneles</legend>
              {PANES.map((item) => (
                <label className={LABEL_CLASSES} key={item.id}>
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
        </ChartMenu>
        <ChartMenu
          viewport={viewport}
          label={viewport ? 'Datos del mercado' : 'Más datos del mercado'}
          compactLabel="Mercado"
          compactStats={
            <ChartStats compact dialog={viewport}>
              <ChartStat
                label="Cambio 24 h"
                compact
                tone={
                  change == null
                    ? undefined
                    : change >= 0
                      ? 'text-long'
                      : 'text-short'
                }
              >
                {percent(change)}
              </ChartStat>
              <ChartStat label="Funding (por hora)" compact>
                {stats?.relative_funding_rate == null
                  ? '—'
                  : percent(stats.relative_funding_rate * 100, 4)}
                {' · próx. '}
                {stats?.relative_funding_rate_prediction == null
                  ? '—'
                  : percent(stats.relative_funding_rate_prediction * 100, 4)}
                {' en '}
                {countdown(stats?.next_funding_time_ms, now)}
              </ChartStat>
              <ChartStat label="Bid / ask" compact>
                {usd(stats?.bid, 0)} ({amount(stats?.bid_size, 3)}) /{' '}
                {usd(stats?.ask, 0)} ({amount(stats?.ask_size, 3)}) · spread{' '}
                {usd(stats?.spread)}
              </ChartStat>
              <ChartStat label="Interés abierto" compact>
                {amount(stats?.open_interest, 1)} {productBase(product)}
                {stats?.open_interest != null && stats.mark != null
                  ? ` · ${compactUsd(stats.open_interest * stats.mark)}`
                  : ''}
              </ChartStat>
            </ChartStats>
          }
        >
          <ChartStats dialog={viewport}>
            <ChartStat label="Máx / mín 24 h">
              {usd(stats?.high_24h, 0)} / {usd(stats?.low_24h, 0)}
            </ChartStat>
            <ChartStat label="Volumen 24 h">
              {amount(stats?.volume_24h_base, 1)} {productBase(product)} ·{' '}
              {compactUsd(stats?.volume_24h_quote)}
            </ChartStat>
            <ChartStat label="Mark / índice">
              {usd(stats?.mark)} / {usd(stats?.index)}
            </ChartStat>
            <ChartStat label="Profundidad ±0,1 %">
              {depth
                ? `${amount(depth.bid, 1)} / ${amount(depth.ask, 1)} ${productBase(product)}`
                : '—'}
            </ChartStat>
            <ChartStat label="Cuentas en largo">
              {latestFlow?.long_percent == null
                ? '—'
                : `${amount(latestFlow.long_percent, 1)} %`}
              {latestFlow?.top_long_percent == null
                ? ''
                : ` · top 20 %: ${amount(latestFlow.top_long_percent, 1)} %`}
            </ChartStat>
          </ChartStats>
        </ChartMenu>
        {viewport && lifecycle && (
          <LifecycleSteps
            view={lifecycle}
            onJump={(ms) =>
              setTimeFocus((value) => ({
                ms,
                revision: (value?.revision ?? 0) + 1,
              }))
            }
          />
        )}
      </div>
      {!live && (
        <p className="m-0 px-3 py-0 text-hint text-ink-2">
          Flujo de órdenes, interés abierto, liquidaciones y long/short solo
          están disponibles con el mercado real de Kraken.
        </p>
      )}

      {waiting ? (
        <p
          className={
            viewport
              ? 'm-0 grid min-h-0 flex-1 place-items-center text-label text-ink-2'
              : 'm-0 grid h-terminal-chart place-items-center text-ink-2 chart-height'
          }
          role="status"
        >
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
          profile={profile}
          panes={panes}
          priceLines={lines}
          trades={trades}
          viewport={viewport}
          tradesConfirmed={tradesConfirmed}
          selectedTradeId={selectedTradeId}
          tradeFocus={tradeFocus}
          timeFocus={timeFocus}
          onSelectTrade={onSelectTrade}
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
      {trades
        ?.filter((trade) => tradeIdentity(trade) === selectedTradeId)
        .map((trade) => {
          const firstMs = (shown[0]?.time ?? 0) * 1000
          const notice = firstMs > 0 ? tradeHistoryNotice(trade, firstMs) : null
          return notice ? (
            <p
              key={tradeIdentity(trade)}
              className={
                viewport
                  ? 'm-0 line-clamp-1 px-2 text-label text-warn'
                  : 'm-0 px-3 text-label text-warn'
              }
              role="status"
              title={notice}
            >
              {notice}
            </p>
          ) : null
        })}
      {trades !== undefined && trades.length > 0 && (
        <div
          className={
            viewport
              ? 'flex flex-none gap-1.5 overflow-x-auto border-t border-t-solid border-t-line px-2 py-0.5'
              : 'flex gap-2.5 overflow-x-auto border-t border-t-solid border-t-line p-3'
          }
          aria-label="Operaciones registradas"
        >
          {trades.map((trade) => {
            const id = tradeIdentity(trade)
            const tone = tradeTone(trade, tradesConfirmed)
            return (
              <button
                key={id}
                type="button"
                className={`flex-none cursor-pointer rounded-lg border border-solid ${viewport ? 'px-2 py-1 text-label' : 'px-3 py-2.5 text-label'} ${selectedTradeId === id ? 'border-chart-info bg-surface-1' : 'border-line bg-surface-2'} focus-visible:outline-2 focus-visible:outline-info`}
                aria-pressed={selectedTradeId === id}
                onClick={() => onSelectTrade?.(id)}
              >
                <span
                  className={trade.side === 'LONG' ? 'text-long' : 'text-short'}
                >
                  {trade.side === 'LONG' ? '▲' : '▼'} {trade.side}
                </span>
                <small className="mx-2 text-ink-2">
                  #{trade.tradeNo} · {trade.open ? 'En curso' : 'Cerrada'}
                </small>
                <strong
                  className={
                    tone === 'gain'
                      ? 'text-long'
                      : tone === 'loss'
                        ? 'text-short'
                        : tone === 'provisional'
                          ? 'text-warn'
                          : 'text-ink-2'
                  }
                >
                  {!tradesConfirmed
                    ? 'Sin confirmar'
                    : trade.netUsd === null
                      ? '—'
                      : `${signedUsd(trade.netUsd)}${tone === 'provisional' ? ' *' : ''}`}
                </strong>
              </button>
            )
          })}
        </div>
      )}
      {viewport && pendingPanes.length > 0 ? (
        <p
          className="m-0 line-clamp-1 px-2 text-label text-ink-2"
          title={pendingPanes.map((pane) => pane.text).join(' · ')}
          role="status"
        >
          {pendingPanes.map((pane) => pane.text).join(' · ')}
        </p>
      ) : (
        pendingPanes.map((pane) => (
          <p
            key={pane.id}
            className="m-0 grid h-27.5 place-items-center border-t border-t-solid border-t-line text-ink-2"
            role="status"
          >
            {pane.text}
          </p>
        ))
      )}
      {fillRows && (
        <section
          className="mx-3 my-0 rounded-lg border border-solid border-line-overlay px-3 py-2 text-hint"
          aria-label="Ejecución seleccionada"
          data-testid="fill-detail"
        >
          <header className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-note leading-normal">
              Ejecución seleccionada (EJEC.)
            </h3>
            <button type="button" onClick={() => setPickedFill(null)}>
              Cerrar
            </button>
          </header>
          <dl className="my-2 grid grid-cols-fill-facts gap-x-4 gap-y-1">
            {fillRows.map((row) => (
              <div className="min-w-0" key={row.key} data-field={row.key}>
                <dt>{row.label}</dt>
                <dd className="m-0 tabular-nums wrap-anywhere">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="m-0">
            Evento independiente: no está vinculado a ninguna decisión ni
            veredicto.
          </p>
        </section>
      )}
      <ChartMenu
        viewport={viewport}
        inline
        label="Leyenda del gráfico"
        compactLabel="▲ LONG / ▼ SHORT · ━ Entrada · ● Neto · × Cierre · ⓘ"
      >
        <p
          className="m-0 flex flex-wrap gap-x-4 gap-y-1 px-3 py-0 text-hint text-ink-2"
          aria-label="Leyenda del gráfico"
        >
          {trades !== undefined && trades.length > 0 ? (
            <>
              <span>
                <b className="text-long">▲ LONG</b> /{' '}
                <b className="text-short">▼ SHORT</b> · operación registrada
              </span>
              <span>
                <b className="text-chart-info">━</b> entrada fija hasta el
                cierre
              </span>
              <span>
                <b className="text-chart-info">×</b> cierre · ● neto a la marca
                registrada
              </span>
              <span>
                <b className="text-warn">*</b> funding incompleto · neto
                provisional
              </span>
              <span title="Las marcas pequeñas son señales del motor, no operaciones. El sombreado es el recorrido observado del precio, no un cálculo de PnL por vela.">
                Marcas pequeñas: señales · sombreado: precio
              </span>
            </>
          ) : proposalLegend ? (
            <>
              <span data-testid="legend-proposal">
                <b className="text-long">▲</b>
                <b className="text-short">▼</b> propuesta LONG/SHORT (no es una
                operación)
              </span>
              <span data-testid="legend-wait">
                <b style={{ color: colors.muted }}>◌</b> W = WAIT (W×n:
                agrupados)
              </span>
              <span data-testid="legend-fill">
                <b className="text-long">■</b> EJEC. ejecución paper (EJ L/S, un
                marcador por fill; el detalle sale al seleccionarlo)
              </span>
              <span data-testid="legend-exit">
                <b style={{ color: colors.info }}>●</b> salida (stop, objetivo,
                tiempo)
              </span>
              <span data-testid="legend-qwen">
                <b style={{ color: colors.amber }}>■</b> Portero ✕ = el portero
                frenó la entrada · Qwen ≠ = Qwen opina distinto
              </span>
            </>
          ) : (
            <>
              <span>
                <b className="text-long">▲</b> entrada larga
              </span>
              <span>
                <b className="text-short">▼</b> entrada corta
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
      </ChartMenu>
    </div>
  )
}
