import { useEffect, useState, type ReactNode } from 'react'
import { productBase } from '../features/trading-view/domain/product-label.ts'
import { PhoneChartContext } from '../features/trading-view/presentation/phone-chart-context.ts'
import {
  TONE_RING,
  TONE_TEXT,
} from '../features/trading-view/presentation/step-tones.ts'
import { tradeIdentity } from '../features/trading-view/domain/terminal-trade-model.ts'
import { usd } from '../shared/finance/format.ts'
import { formatBalance } from './account-balance.ts'
import { qwenTradesNotice } from './qwen-trades-text.ts'
import { money } from './terminal-labels.ts'
import type { DecisionRow } from './terminal-decisions.ts'
import type { LifecycleStep, LifecycleView } from './terminal-lifecycle.ts'
import type {
  NewsDirection,
  TerminalNewsBriefing,
  TerminalNewsItem,
} from './useTerminalNews.ts'
import type { QwenTrade, QwenTradesSource } from './useQwenTrades.ts'
import { useQwenAccount } from './useQwenAccount.ts'
import type { QwenSource } from './useQwenDecisions.ts'
import { summarizeUsage } from './system-usage.ts'

type Tab = 'ops' | 'news' | 'decisions' | 'status'

// A phone may discard a backgrounded tab and reload it on return; the tab the
// person was on survives that in sessionStorage.
const TAB_KEY = 'balancita.mobile-tab.v1'
const TAB_IDS: readonly Tab[] = ['ops', 'news', 'decisions', 'status']
function readTab(): Tab {
  try {
    const saved = window.sessionStorage.getItem(TAB_KEY)
    return TAB_IDS.find((t) => t === saved) ?? 'ops'
  } catch {
    return 'ops'
  }
}
function saveTab(tab: Tab) {
  try {
    window.sessionStorage.setItem(TAB_KEY, tab)
  } catch {
    // storage blocked: the tab simply resets after a reload
  }
}

const TABS: ReadonlyArray<{ id: Tab; icon: string; label: string }> = [
  { id: 'ops', icon: '📈', label: 'Operaciones' },
  { id: 'news', icon: '📰', label: 'Noticias' },
  { id: 'decisions', icon: '🧭', label: 'Decisiones' },
  { id: 'status', icon: '🩺', label: 'Estado' },
]

const NOTICE_DOT: Record<string, string> = {
  ok: 'text-long',
  warn: 'text-warn',
  bad: 'text-short',
}

const MARK: Record<NewsDirection, { glyph: string; tone: string }> = {
  bullish: { glyph: '+', tone: 'text-long' },
  bearish: { glyph: '−', tone: 'text-short' },
  neutral: { glyph: '=', tone: 'text-ink-2' },
}

const signedDollars = (value: number | null): string =>
  value === null
    ? '—'
    : `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2).replace('.', ',')} $`

const tradeTone = (net: number | null): string =>
  net === null || net === 0
    ? 'text-ink-2'
    : net > 0
      ? 'text-long'
      : 'text-short'

function duration(trade: QwenTrade, nowMs: number): string {
  const end = trade.open ? nowMs : trade.exitMs
  if (end === null || end < trade.entryMs) return '—'
  const minutes = Math.floor((end - trade.entryMs) / 60_000)
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    : `${minutes} min`
}

function OperationsTab({
  trades,
  onSelect,
  onFocus,
  nowMs,
  source,
  usedUsd,
}: {
  trades: readonly QwenTrade[]
  onSelect: (id: string) => void
  onFocus: (id: string) => void
  nowMs: number
  source: QwenTradesSource
  usedUsd: number | null
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (trades.length === 0)
    return (
      <p role="status" className="m-0 py-3 text-label text-ink-2">
        {source.state === 'loading'
          ? 'Cargando operaciones…'
          : source.state === 'ok'
            ? 'Sin operaciones abiertas.'
            : (qwenTradesNotice(source, 0) ?? 'No se pueden confirmar.')}
      </p>
    )
  const total = trades.reduce((sum, trade) => sum + (trade.netUsd ?? 0), 0)
  return (
    <div data-testid="mobile-ops">
      <ul className="m-0 list-none p-0">
        {trades.map((trade, index) => {
          const id = tradeIdentity(trade)
          const open = expanded === id
          return (
            <li key={id} className="border-0 border-b border-solid border-line">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  onSelect(id)
                  setExpanded(open ? null : id)
                }}
                className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-1 py-2 text-left font-sans text-label text-ink"
              >
                <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-label">
                  {index + 1}
                </span>
                <b
                  className={trade.side === 'LONG' ? 'text-long' : 'text-short'}
                >
                  {trade.side === 'LONG' ? '▲' : '▼'}
                </b>
                <span className="flex-1 text-label text-ink-2">
                  {duration(trade, nowMs)}
                  {trade.entryReason === 'rebote' ? ' · rebote' : ''}
                </span>
                <b
                  className={`text-body tabular-nums ${tradeTone(trade.netUsd)}`}
                  data-testid="mobile-op-net"
                >
                  {signedDollars(trade.netUsd)}
                </b>
                <span className="text-ink-2" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
              </button>
              {open && (
                <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 px-1 pb-2 text-label">
                  <dt className="text-ink-2">Entrada</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {usd(trade.entryPrice)}
                  </dd>
                  <dt className="text-ink-2">Marca</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {usd(trade.markPrice)}
                  </dd>
                  <dt className="text-ink-2">Comisiones</dt>
                  <dd className="m-0 text-right tabular-nums">
                    {usd(trade.feesUsd)}
                  </dd>
                  <dt className="text-ink-2">Funding</dt>
                  <dd
                    className={`m-0 text-right tabular-nums ${trade.fundingComplete ? '' : 'text-warn'}`}
                  >
                    {usd(trade.fundingUsd)}
                    {trade.fundingComplete ? '' : ' *'}
                  </dd>
                  <dd className="col-span-2 m-0 pt-1">
                    <button
                      type="button"
                      onClick={() => onFocus(id)}
                      className="cursor-pointer border-0 bg-transparent p-0 text-label text-chart-info"
                    >
                      Centrar en el gráfico
                    </button>
                  </dd>
                </dl>
              )}
            </li>
          )
        })}
      </ul>
      <p className="m-0 pt-1.5 text-label tabular-nums">
        <b className={tradeTone(total)} data-testid="mobile-total">
          Total {signedDollars(total)}
        </b>
        {usedUsd !== null && (
          <span className="text-ink-2">
            {' '}
            · usado {Math.round(usedUsd).toLocaleString('es-ES')} $
          </span>
        )}
      </p>
    </div>
  )
}

function NewsTab({
  briefing,
  items,
  loaded,
}: {
  briefing: TerminalNewsBriefing | null
  items: readonly TerminalNewsItem[]
  loaded: boolean
}) {
  const relevant = items
    .filter((item) => item.relevance === 'high' || item.relevance === 'medium')
    .slice(0, 6)
  const score = relevant.reduce(
    (sum, item) =>
      sum +
      (item.direction === 'bullish'
        ? 1
        : item.direction === 'bearish'
          ? -1
          : 0),
    0,
  )
  const tone =
    score > 0
      ? { word: 'positivo', cls: 'text-long' }
      : score < 0
        ? { word: 'negativo', cls: 'text-short' }
        : { word: 'neutro', cls: 'text-ink-2' }
  return (
    <div data-testid="mobile-news">
      <div className="mb-1.5 rounded-xl bg-surface-2 px-3 py-2 text-label leading-snug">
        <b>
          🤖 Resumen Qwen · tono{' '}
          <span className={tone.cls} data-testid="mobile-news-tone">
            {tone.word}
          </span>
        </b>
        <span className="mt-0.5 block text-ink-2">
          {briefing?.text ??
            (briefing?.status === 'no_news'
              ? 'Sin noticias relevantes.'
              : loaded
                ? 'Resumen pendiente.'
                : 'Cargando…')}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {relevant.map((item) => {
          const mark = MARK[item.direction ?? 'neutral']
          const at = item.publishedAtMs ?? item.receivedAtMs
          return (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 border-0 border-b border-solid border-line py-2 text-label last:border-0"
            >
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 truncate text-ink no-underline"
              >
                {item.title}
              </a>
              <span className="text-ink-2 tabular-nums">
                {new Date(at).toISOString().slice(11, 16)}
              </span>
              <b className={mark.tone}>{mark.glyph}</b>
            </li>
          )
        })}
        {relevant.length === 0 && loaded && (
          <li className="py-2 text-label text-ink-2">
            Sin noticias relevantes ahora.
          </li>
        )}
      </ul>
      <p className="m-0 pt-1.5 text-label text-ink-2">
        ▸ Solo las relevantes · toca una para leerla
      </p>
    </div>
  )
}

const STEP_EMOJI: Record<string, string> = {
  look: '👁',
  master: '👑',
  gate: '🛡',
  news: '📰',
  enter: '🎯',
  entered: '🎯',
  flip: '👑',
  news12: '🛡',
  exhaust24: '⏱',
  cap: '🏁',
}

const BOX_TONE = {
  ok: { glyph: '✓', cls: 'bg-long/20 text-long' },
  no: { glyph: '✕', cls: 'bg-short/20 text-short' },
  na: { glyph: '…', cls: 'bg-warn/20 text-warn' },
} as const

const boxOf = (value: boolean | null | undefined) =>
  BOX_TONE[value === true ? 'ok' : value === false ? 'no' : 'na']

const ACTION_WORD: Record<string, string> = {
  'enter-long': 'Comprar',
  'enter-short': 'Vender',
  exit: 'Cerrar',
  hold: 'Mantener',
  wait: 'Esperar',
  blocked: 'Esperar',
  skipped: 'Sin decisión',
}

/** The five steps of the phone strip: with an open operation its entry plus the exit rules that matter. */
function phoneSteps(
  view: LifecycleView | null,
  trade: QwenTrade | null,
): readonly LifecycleStep[] {
  if (view === null) return []
  if (view.phase === 'entry') return view.steps.slice(0, 5)
  const by = (id: string) => view.steps.find((step) => step.id === id)
  const entered: LifecycleStep | null = trade
    ? {
        id: 'entered',
        icon: 'enter',
        label: 'Entrada',
        tone: 'ok',
        headline: `Entró ${usd(trade.entryPrice)}`,
        rows: [],
        meter: null,
        history: [],
        rule: '',
        checks: null,
      }
    : null
  return [entered, by('flip'), by('news12'), by('exhaust24'), by('cap')].filter(
    (step): step is LifecycleStep => step !== null && step !== undefined,
  )
}

function DecisionsTab({
  lifecycle,
  rows,
  trade,
}: {
  lifecycle: LifecycleView | null
  rows: readonly DecisionRow[]
  trade: QwenTrade | null
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const steps = phoneSteps(lifecycle, trade)
  const step = steps.find((item) => item.id === picked) ?? steps[0] ?? null
  return (
    <div data-testid="mobile-decisions">
      {steps.length > 0 && (
        <>
          <div
            className="my-1 flex items-center"
            data-testid="mobile-lifecycle"
          >
            {steps.map((item, index) => (
              <div
                key={item.id}
                className={`flex items-center ${index < steps.length - 1 ? 'flex-1' : ''}`}
              >
                <button
                  type="button"
                  aria-label={`${item.label}: ${item.headline}`}
                  aria-pressed={step?.id === item.id}
                  data-tone={item.tone}
                  onClick={() => setPicked(item.id)}
                  className={`grid size-9.5 shrink-0 cursor-pointer place-items-center rounded-full border-2 border-solid bg-surface-2 p-0 ${TONE_RING[item.tone]} ${step?.id === item.id ? 'ring-2 ring-line-focus' : ''}`}
                >
                  <span aria-hidden="true" className="text-body">
                    {STEP_EMOJI[item.id] ?? '•'}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <span className="h-0.5 flex-1 bg-line" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
          {step && (
            <div className="mb-1.5 rounded-xl bg-surface-2 px-3 py-2 text-label">
              <b className={TONE_TEXT[step.tone]}>{step.label}</b>
              <span className="block text-ink-2">{step.headline}</span>
            </div>
          )}
        </>
      )}
      <ul className="m-0 list-none p-0">
        {rows.slice(0, 4).map((row) => {
          const view = row.view
          const boxes = view
            ? [
                boxOf(view.master === null ? null : view.master !== 0),
                boxOf(view.gate),
                boxOf(view.news),
              ]
            : []
          return (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 border-0 border-b border-solid border-line py-2 text-label last:border-0"
            >
              <span className="text-ink-2 tabular-nums">{row.time}</span>
              <span className="flex gap-1.5">
                {boxes.map((box, index) => (
                  <span
                    key={index}
                    aria-hidden="true"
                    className={`grid size-6 place-items-center rounded-md text-label ${box.cls}`}
                  >
                    {box.glyph}
                  </span>
                ))}
              </span>
              <b
                className={
                  view?.kind === 'enter-long'
                    ? 'text-long'
                    : view?.kind === 'enter-short'
                      ? 'text-short'
                      : 'text-ink-2'
                }
              >
                {view ? ACTION_WORD[view.kind] : row.action}
              </b>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface StatusRow {
  key: string
  icon: string
  label: string
  value: string
  tone: 'ok' | 'warn' | 'bad'
}

const VALUE_TONE = {
  ok: 'text-long',
  warn: 'text-warn',
  bad: 'text-short',
} as const

function StatusTab({
  rows,
  extra,
  diagnosis,
}: {
  rows: readonly StatusRow[]
  extra: ReadonlyArray<{ key: string; tone?: string; text: string }>
  diagnosis: ReactNode
}) {
  return (
    <div data-testid="mobile-status">
      <ul className="m-0 list-none p-0">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center justify-between border-0 border-b border-solid border-line py-2 text-label last:border-0"
          >
            <span>
              <span aria-hidden="true">{row.icon}</span> {row.label}
            </span>
            <b className={VALUE_TONE[row.tone]}>{row.value}</b>
          </li>
        ))}
        {extra.map((item) => (
          <li
            key={item.key}
            className="flex items-center justify-between border-0 border-b border-solid border-line py-2 text-label last:border-0"
          >
            <span>{item.text}</span>
            <b className={NOTICE_DOT[item.tone ?? ''] ?? 'text-ink-2'}>▲</b>
          </li>
        ))}
      </ul>
      <div className="pt-1.5 text-label text-ink-2">{diagnosis}</div>
    </div>
  )
}

/** CPU and memory of the machine the gateway runs on, polled; null until it answers. */
function useServerLine(apiBase: string): string | null {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/system`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('HTTP')
        const usage = summarizeUsage(await response.json())
        setLine(`CPU ${usage.cpu} · Qwen ${usage.qwen}`)
      } catch {
        if (!controller.signal.aborted) setLine(null)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [apiBase])
  return line
}

export default function MobileTerminal({
  product,
  price,
  change24h,
  chart,
  trades,
  onSelectTrade,
  onFocusTrade,
  tradeSource,
  usedUsd,
  nowMs,
  lifecycle,
  newsBriefing,
  newsItems,
  newsLoaded,
  decisionRows,
  statusItems,
  diagnosis,
  apiBase,
  qwenSource,
  quoteAgeMs,
  banner,
}: {
  product: string | undefined
  price: unknown
  change24h: unknown
  chart: ReactNode
  trades: readonly QwenTrade[]
  onSelectTrade: (id: string) => void
  onFocusTrade: (id: string) => void
  tradeSource: QwenTradesSource
  usedUsd: number | null
  nowMs: number
  lifecycle: LifecycleView | null
  newsBriefing: TerminalNewsBriefing | null
  newsItems: readonly TerminalNewsItem[]
  newsLoaded: boolean
  decisionRows: readonly DecisionRow[]
  statusItems: ReadonlyArray<{ key: string; tone?: string; text: string }>
  diagnosis: ReactNode
  apiBase: string
  qwenSource: QwenSource
  quoteAgeMs: number | null
  banner?: ReactNode
}) {
  const serverLine = useServerLine(apiBase)
  const [tab, setTabState] = useState<Tab>(readTab)
  const setTab = (next: Tab) => {
    saveTab(next)
    setTabState(next)
  }
  const account = useQwenAccount()
  const alerts = statusItems.filter(
    (item) => item.tone === 'warn' || item.tone === 'bad',
  )
  const feed = statusItems.find((item) => item.key === 'feed')
  const funding = statusItems.find((item) => item.key === 'funding')
  const statusRows: StatusRow[] = [
    {
      key: 'kraken',
      icon: '🌐',
      label: 'Kraken en vivo',
      value: feed?.tone === 'ok' ? 'OK' : feed ? 'con problemas' : '—',
      tone: feed?.tone === 'ok' ? 'ok' : feed?.tone === 'bad' ? 'bad' : 'warn',
    },
    {
      key: 'qwen',
      icon: '🤖',
      label: 'Qwen',
      value:
        qwenSource.state === 'ok'
          ? 'OK'
          : qwenSource.state === 'loading'
            ? 'cargando'
            : qwenSource.state === 'off'
              ? 'apagado'
              : 'sin conexión',
      tone:
        qwenSource.state === 'ok'
          ? 'ok'
          : qwenSource.state === 'loading'
            ? 'warn'
            : 'bad',
    },
    {
      key: 'candles',
      icon: '🕯️',
      label: 'Velas',
      value:
        quoteAgeMs === null ? '—' : `hace ${Math.floor(quoteAgeMs / 1000)} s`,
      tone: quoteAgeMs === null ? 'warn' : quoteAgeMs > 120_000 ? 'bad' : 'ok',
    },
    {
      key: 'funding',
      icon: '💸',
      label: 'Funding',
      value: funding?.tone === 'ok' ? 'completo' : 'incompleto',
      tone: funding?.tone === 'ok' ? 'ok' : 'warn',
    },
    {
      key: 'server',
      icon: '🖥️',
      label: 'Servidor',
      value: serverLine ?? '—',
      tone: serverLine ? 'ok' : 'warn',
    },
  ]
  const open = trades.filter((trade) => trade.open)
  const shown = open.length > 0 ? open : trades.slice(0, 1)
  return (
    <main
      className="fixed inset-0 flex min-h-0 flex-col bg-canvas font-sans text-label text-ink"
      data-testid="mobile-terminal"
    >
      <header className="flex items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h1 className="m-0 flex items-baseline gap-2 text-body font-normal">
          <span className="text-label text-ink-2">
            {productBase(product ?? 'PF_ETHUSD')}
          </span>
          <b className="font-brand-mono text-brand-compact tabular-nums">
            {typeof price === 'number' || typeof price === 'string'
              ? money(price)
              : '—'}
          </b>
          {typeof change24h === 'number' && (
            <span
              className={`text-label tabular-nums ${change24h >= 0 ? 'text-long' : 'text-short'}`}
            >
              {change24h >= 0 ? '+' : '−'}
              {Math.abs(change24h).toLocaleString('es-ES', {
                maximumFractionDigits: 2,
              })}
              %
            </span>
          )}
        </h1>
        <span className="flex items-center gap-2">
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={() => setTab('status')}
              aria-label={`Ver ${alerts.length} aviso${alerts.length === 1 ? '' : 's'}`}
              className={`cursor-pointer border-0 bg-transparent p-0 text-label ${alerts.some((item) => item.tone === 'bad') ? 'text-short' : 'text-warn'}`}
            >
              ⚠ {alerts.length}
            </button>
          )}
          {account && (
            <span
              className="rounded-full bg-surface-2 px-2.5 py-1 text-label tabular-nums"
              data-testid="mobile-balance"
            >
              💰 {formatBalance(account.balanceUsd)}
            </span>
          )}
        </span>
      </header>
      {banner}
      <div
        className="min-h-0 flex-1 overflow-hidden bg-chart-surface"
        data-testid="mobile-chart"
      >
        <PhoneChartContext.Provider value>{chart}</PhoneChartContext.Provider>
      </div>
      <section
        style={{ height: '34dvh' }}
        className="shrink-0 overflow-y-auto border-0 border-t border-solid border-line bg-surface-1 px-3.5 pt-2 pb-5"
        aria-label="Panel de la Terminal"
      >
        <div role="tablist" className="mb-1.5 flex gap-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-label={item.label}
              onClick={() => setTab(item.id)}
              className={`min-h-10 flex-1 cursor-pointer rounded-xl border-0 text-body text-ink ${tab === item.id ? 'bg-line-strong' : 'bg-surface-2'}`}
            >
              {item.icon}
            </button>
          ))}
        </div>
        {tab === 'ops' && (
          <OperationsTab
            trades={shown}
            onSelect={onSelectTrade}
            onFocus={onFocusTrade}
            nowMs={nowMs}
            source={tradeSource}
            usedUsd={usedUsd}
          />
        )}
        {tab === 'news' && (
          <NewsTab
            briefing={newsBriefing}
            items={newsItems}
            loaded={newsLoaded}
          />
        )}
        {tab === 'decisions' && (
          <DecisionsTab
            lifecycle={lifecycle}
            rows={decisionRows}
            trade={shown[0] ?? null}
          />
        )}
        {tab === 'status' && (
          <StatusTab
            rows={statusRows}
            extra={statusItems.filter(
              (item) =>
                item.key !== 'feed' &&
                item.key !== 'funding' &&
                item.key !== 'engine' &&
                (item.tone === 'warn' || item.tone === 'bad'),
            )}
            diagnosis={diagnosis}
          />
        )}
      </section>
    </main>
  )
}
