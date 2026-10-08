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
  strategyCode,
  strategyMarkerColor,
  positionLines,
  chartPositions,
  timeframeCandles,
} from '../domain/terminal-chart-model.ts'
import './terminal-chart-panel.css'

type Overlay = 'ema9' | 'ema21' | 'bollinger' | 'donchian' | 'vwap'
type Pane = 'flow' | 'oi' | 'liquidations' | 'positioning' | 'rsi'

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
  { id: 'rsi', label: 'RSI 14', live: false },
]

type Settings = { intervalMs: number; overlays: Overlay[]; panes: Pane[] }
const STORAGE_KEY = 'balancita.terminal-chart.v1'
const DEFAULTS: Settings = {
  intervalMs: 60_000,
  overlays: ['ema9', 'ema21'],
  panes: ['flow', 'oi'],
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
  return panes
}

function depthWithin(depth: ChartDepth | null, band: string) {
  if (!depth) return null
  const bid = depth.bid[band]
  const ask = depth.ask[band]
  return bid == null || ask == null ? null : { bid, ask }
}

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
  instrument?: string
}) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [now, setNow] = useState(() => Date.now())
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
  const stats = ticker ?? remote?.ticker ?? null
  const mark = stats?.mark ?? null
  const [hiddenStrategies, setHiddenStrategies] = useState<string[]>([])
  const lines = useMemo(() => {
    const open = chartPositions(positions, position)
    const out = open
      .filter(
        (item) =>
          typeof item.strategy_id !== 'string' ||
          !hiddenStrategies.includes(item.strategy_id),
      )
      .flatMap((item, index) => {
        const strategyId =
          typeof item.strategy_id === 'string' ? item.strategy_id : undefined
        // Several books: each strategy draws its own lines in its own colour.
        const own =
          open.length > 1 ? strategyMarkerColor(strategyId) : undefined
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
  }, [positions, position, mark, colors, hiddenStrategies])
  const everyMarker = useMemo(
    () => [...markers, ...exitMarkers(orders)],
    [markers, orders],
  )
  const strategyIds = useMemo(
    () =>
      [
        ...new Set(
          everyMarker.flatMap((marker) =>
            marker.strategyId ? [marker.strategyId] : [],
          ),
        ),
      ].sort(),
    [everyMarker],
  )
  const allMarkers = useMemo(
    () =>
      everyMarker.filter(
        (marker) =>
          !marker.strategyId || !hiddenStrategies.includes(marker.strategyId),
      ),
    [everyMarker, hiddenStrategies],
  )
  const latestFlow = remote?.flow.at(-1)
  const depth = depthWithin(remote?.depth ?? null, 'liquidity01')
  const toggle = <T extends string>(list: readonly T[], id: T): T[] =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
  const change = stats?.change_24h_pct ?? null

  return (
    <div className="terminal-chart">
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
          <dt>Interés abierto</dt>
          <dd>
            {amount(stats?.open_interest, 1)} {productBase(product)}
            {stats?.open_interest != null && stats.mark != null
              ? ` · ${compactUsd(stats.open_interest * stats.mark)}`
              : ''}
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
          <dt>Mark / índice</dt>
          <dd>
            {usd(stats?.mark)} / {usd(stats?.index)}
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
      {!live && (
        <p className="terminal-chart__note">
          Flujo de órdenes, interés abierto, liquidaciones y long/short solo
          están disponibles con el mercado real de Kraken.
        </p>
      )}

      {strategyIds.length > 0 && (
        <div
          className="terminal-chart__strategies"
          role="group"
          aria-label="Filtrar marcadores por estrategia"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          {strategyIds.map((id) => {
            const hidden = hiddenStrategies.includes(id)
            return (
              <button
                key={id}
                type="button"
                aria-pressed={!hidden}
                onClick={() => setHiddenStrategies((list) => toggle(list, id))}
                style={{
                  borderColor: strategyMarkerColor(id),
                  opacity: hidden ? 0.45 : 1,
                }}
              >
                {strategyCode(id) ?? id}
              </button>
            )
          })}
        </div>
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
          selectedId={selectedId}
          intervalSeconds={intervalSeconds}
          currency="USD"
          instrument={instrument}
          initialViewport="approved-terminal"
          overlays={overlays}
          panes={panes}
          priceLines={lines}
          onSelect={(time, markerId) => {
            if (markerId) {
              if (!markerId.startsWith('exit:')) onSelect(markerId)
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
            if (next) onSelect(next.id)
          }}
        />
      )}
      <p className="terminal-chart__legend">
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
      </p>
    </div>
  )
}
