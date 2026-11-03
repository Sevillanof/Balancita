import { useState, type ReactNode } from 'react'
import { productBase } from '../features/trading-view/domain/product-label.ts'
import { PhoneChartContext } from '../features/trading-view/presentation/phone-chart-context.ts'
import { Icon } from '../features/trading-view/presentation/LifecycleSteps.tsx'
import {
  TONE_RING,
  TONE_TEXT,
} from '../features/trading-view/presentation/step-tones.ts'
import { tradeIdentity } from '../features/trading-view/domain/terminal-trade-model.ts'
import { amount, usd } from '../shared/finance/format.ts'
import { formatBalance } from './account-balance.ts'
import { DecisionChips } from './DecisionGlyphs.tsx'
import { qwenTradesNotice, signedUsd } from './qwen-trades-text.ts'
import { money } from './terminal-labels.ts'
import type { DecisionRow } from './terminal-decisions.ts'
import type { LifecycleView } from './terminal-lifecycle.ts'
import type {
  NewsDirection,
  TerminalNewsBriefing,
  TerminalNewsItem,
} from './useTerminalNews.ts'
import type { QwenTrade, QwenTradesSource } from './useQwenTrades.ts'
import { useQwenAccount } from './useQwenAccount.ts'

type Tab = 'ops' | 'news' | 'decisions' | 'status'

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
                  {signedUsd(trade.netUsd)}
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
          Total {signedUsd(total)}
        </b>
        {usedUsd !== null && (
          <span className="text-ink-2"> · usado {amount(usedUsd)} $</span>
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
  return (
    <div data-testid="mobile-news">
      <div className="mb-1.5 rounded-xl bg-surface-2 px-3 py-2 text-label leading-snug">
        <b>🤖 Resumen Qwen</b>
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
    </div>
  )
}

function DecisionsTab({
  lifecycle,
  rows,
}: {
  lifecycle: LifecycleView | null
  rows: readonly DecisionRow[]
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const steps = lifecycle?.steps ?? []
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
                  <Icon name={item.icon} />
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
        {rows.slice(0, 4).map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-2 border-0 border-b border-solid border-line py-2 text-label last:border-0"
          >
            <span className="text-ink-2 tabular-nums">{row.time}</span>
            {row.view ? (
              <DecisionChips view={row.view} />
            ) : (
              <span className="text-ink-2">{row.reason}</span>
            )}
            <b>{row.action}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusTab({
  items,
  diagnosis,
}: {
  items: ReadonlyArray<{ key: string; tone?: string; text: string }>
  diagnosis: ReactNode
}) {
  return (
    <div data-testid="mobile-status">
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-center justify-between border-0 border-b border-solid border-line py-2 text-label last:border-0"
          >
            <span>{item.text}</span>
            <b className={NOTICE_DOT[item.tone ?? ''] ?? 'text-ink-2'}>
              {item.tone === 'ok' ? '●' : item.tone === 'bad' ? '✕' : '▲'}
            </b>
          </li>
        ))}
      </ul>
      <div className="pt-1.5 text-label text-ink-2">{diagnosis}</div>
    </div>
  )
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
  banner?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('ops')
  const [newsOpen, setNewsOpen] = useState(false)
  const account = useQwenAccount()
  const alerts = statusItems.filter(
    (item) => item.tone === 'warn' || item.tone === 'bad',
  )
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
      {newsBriefing?.text && (
        <button
          type="button"
          aria-expanded={newsOpen}
          onClick={() => setNewsOpen((value) => !value)}
          data-testid="mobile-news-line"
          className="mx-3 mb-2 flex cursor-pointer items-start gap-2 rounded-xl border-0 bg-surface-2 px-3 py-2 text-left text-label text-ink"
        >
          <span aria-hidden="true">📰</span>
          <span
            className={`flex-1 leading-snug ${newsOpen ? '' : 'line-clamp-2'}`}
          >
            {newsBriefing.text}
          </span>
          <span className="text-ink-2" aria-hidden="true">
            {newsOpen ? '⌃' : '⌄'}
          </span>
        </button>
      )}
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
          <DecisionsTab lifecycle={lifecycle} rows={decisionRows} />
        )}
        {tab === 'status' && (
          <StatusTab items={statusItems} diagnosis={diagnosis} />
        )}
      </section>
    </main>
  )
}
