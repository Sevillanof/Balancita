import type { QwenTrade, QwenTradesSource } from './useQwenTrades.ts'
import { Fragment, useState, type ReactNode } from 'react'
import ModalFrame from '../features/strategy-lab/presentation/ModalFrame.tsx'
import { exitPlanText, exitReasonText, signedUsd } from './qwen-trades-text.ts'
import {
  amount,
  madridDateTimeSeconds,
  madridDayTime,
  madridTime,
  usd,
} from '../shared/finance/format.ts'
import { tradeTone } from '../features/trading-view/domain/terminal-trade-model.ts'
import { Icon } from '../features/trading-view/presentation/LifecycleSteps.tsx'
import Tip from '../features/trading-view/presentation/Tip.tsx'
import type { MasterReading } from './terminal-lifecycle.ts'
import {
  holdView,
  rangeView,
  ruleViews,
  usdSigned,
  type RangeView,
  type RuleState,
  type RuleView,
} from './terminal-operation-view.ts'
import {
  TERMINAL_CARD_LABEL,
  TERMINAL_FRAME,
} from '../shared/design-system/terminal-styles.ts'

/** The wait between the decision and the fill: milliseconds for a market order, minutes for an order that waited. */
const delayText = (ms: number): string =>
  ms < 60_000 ? `${ms} ms` : `${Math.round(ms / 60_000)} min`

/** `flat`: inside the grid of the details dialog the rows are loose `dt`/`dd`; in the compact list each row is a `div`. */
function ExecutionDetails({
  trade,
  nowMs,
  flat = false,
}: {
  trade: QwenTrade
  nowMs: number
  flat?: boolean
}) {
  const execution = trade.execution
  if (!execution) return null
  const exitText = exitPlanText(trade, nowMs)
  const phase =
    (trade.open ? execution.mark : execution.exit) ?? execution.entry
  const Rows = flat ? Fragment : 'div'
  return (
    <Rows>
      <dt>Modelo de ejecución</dt>
      <dd>Libro público · simulación paper</dd>
      <dt>Recibo de entrada</dt>
      <dd title={execution.entry.receiptId}>
        {execution.entry.receiptId.slice(0, 12)}
      </dd>
      <dt>Costes congelados</dt>
      <dd title={phase.costModelHash}>
        {phase.feeKind === 'maker' ? 'Maker' : 'Taker'}{' '}
        {amount(phase.feeRate * 100)} % · {phase.costModelHash.slice(0, 12)}
      </dd>
      <dt>Recepción / ejecución (Madrid)</dt>
      <dd>
        {madridDateTimeSeconds(phase.receivedMs)} /{' '}
        {madridDateTimeSeconds(phase.executedMs)}
      </dd>
      <dt>Demora desde la señal</dt>
      <dd>{delayText(phase.executedMs - phase.signalMs)}</dd>
      {exitText && (
        <>
          <dt>Salida</dt>
          <dd>{exitText}</dd>
        </>
      )}
      {execution.error && (
        <dd role="status" className="text-warn">
          No hay precio ejecutable vigente ({execution.error}); se conserva el
          último recibo válido.
        </dd>
      )}
    </Rows>
  )
}

/** Where this operation stands among the open ones that share the account (1/3, 2/3, 3/3). */
export interface PositionPlace {
  /** 1-based position of the shown operation among the open ones; 0 when it is closed. */
  index: number
  open: number
  max: number
  /** Balance held by the open positions, USD; null when unknown. */
  usedUsd: number | null
  /** Show the next open position. */
  onNext?: () => void
}

function placeText(place: PositionPlace): string {
  return `Posición ${place.index}/${place.max}`
}

/** The RING: circumference of its track (radius 18). */
const RING_C = 2 * Math.PI * 18

const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`

/** Hours open against the cap; the amber tick is the 24 h «agotado» check. */
function HoursRing({ trade, nowMs }: { trade: QwenTrade; nowMs: number }) {
  const hold = holdView(trade, nowMs)
  const detail = `${trade.open ? 'Abierta' : 'Entró'} el ${madridDayTime(trade.entryMs, nowMs)} (hora de Madrid) · ${hold.text}.${hold.exhaustMark === null ? '' : ' La marca ámbar es el control de las 24 h («agotado»).'}`
  return (
    <Tip
      focusable
      align="start"
      label={`Horas abiertas: ${hold.text}`}
      content={detail}
      className="relative size-12 flex-none"
    >
      <svg
        viewBox="0 0 48 48"
        className="size-12 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="18"
          fill="none"
          strokeWidth="5"
          className="stroke-line"
        />
        {hold.fraction > 0 && (
          <circle
            cx="24"
            cy="24"
            r="18"
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(RING_C * hold.fraction).toFixed(2)} ${RING_C.toFixed(2)}`}
            className={hold.fraction >= 1 ? 'stroke-warn' : 'stroke-info'}
          />
        )}
        {hold.exhaustMark !== null && (
          <circle
            cx="24"
            cy="24"
            r="18"
            fill="none"
            strokeWidth="5"
            strokeDasharray={`2 ${(RING_C - 2).toFixed(2)}`}
            strokeDashoffset={(-(RING_C * hold.exhaustMark - 1)).toFixed(2)}
            className="stroke-warn"
            data-testid="ring-24h"
          />
        )}
      </svg>
      <span
        className="absolute inset-0 grid place-items-center text-label font-semibold tabular-nums text-ink"
        data-testid="operation-ring"
      >
        {hold.label}
      </span>
    </Tip>
  )
}

/** Worst and best net reached since entry; a hidden bar (sin dato) keeps its tooltip. */
function RangeBar({ range }: { range: RangeView | null }) {
  const label = 'Rango desde la entrada'
  if (range === null)
    return (
      <div data-testid="operation-range">
        <Tip
          focusable
          label={label}
          content={`${label}: sin dato (todavía no hay recorrido medido para esta operación).`}
          className="w-full py-2"
        >
          <span className="block h-0 w-full border-0 border-t border-dashed border-line" />
        </Tip>
      </div>
    )
  const nowTone =
    range.nowUsd === null || range.nowUsd === 0
      ? 'bg-ink-2'
      : range.nowUsd > 0
        ? 'bg-long'
        : 'bg-short'
  return (
    <div data-testid="operation-range">
      <Tip
        focusable
        label={label}
        content={range.tip}
        className="w-full flex-col"
      >
        <span className="relative block h-2 w-full rounded-sm bg-surface-2">
          <i
            className="absolute inset-y-0 left-0 rounded-l-sm bg-short/25"
            style={{ width: pct(range.zero) }}
          />
          <i
            className="absolute inset-y-0 right-0 rounded-r-sm bg-long/25"
            style={{ width: pct(1 - range.zero) }}
          />
          <i
            className="absolute -top-0.5 h-3 w-px bg-ink-2"
            style={{ left: pct(range.zero) }}
            data-testid="range-zero"
          />
          {range.now !== null && (
            <i
              className={`absolute -top-1 h-4 w-1.5 -translate-x-1/2 rounded-badge ${nowTone}`}
              style={{ left: pct(range.now) }}
              data-testid="range-now"
            />
          )}
        </span>
        <span className="relative mt-1 block h-3.5 w-full text-label tabular-nums text-ink-2">
          <span className="absolute left-0">{signedShort(range.worstUsd)}</span>
          {range.zero > 0.12 && range.zero < 0.88 && (
            <span
              className="absolute -translate-x-1/2"
              style={{ left: pct(range.zero) }}
            >
              0
            </span>
          )}
          <span className="absolute right-0">{signedShort(range.bestUsd)}</span>
        </span>
      </Tip>
    </div>
  )
}

/** `−4,20` / `+5,02`: the label under an end of the range bar. */
function signedShort(value: number): string {
  return usdSigned(value).replace(' US$', '')
}

const RULE_ICON = {
  master: 'flip',
  exhaust: 'clock24',
  cap: 'cap',
} as const

const RULE_WORD: Record<RuleState, string> = {
  favor: 'a favor',
  contra: 'en contra',
  neutral: 'sin inclinación',
  sin_dato: 'sin dato',
  espera: 'esperando',
  activo: 'activo',
  no_aplica: 'no aplica',
  llego: 'alcanzado',
}

/** Ring colour and bar fill of each state. */
const RULE_TONE: Record<RuleState, { ring: string; fill: string }> = {
  favor: { ring: 'border-long text-long', fill: 'bg-long' },
  contra: { ring: 'border-short text-short', fill: 'bg-short' },
  neutral: { ring: 'border-line-strong text-ink-2', fill: 'bg-ink-2' },
  sin_dato: {
    ring: 'border-line-strong text-ink-2 opacity-50',
    fill: 'bg-ink-2',
  },
  espera: { ring: 'border-info text-info', fill: 'bg-info' },
  activo: { ring: 'border-warn text-warn', fill: 'bg-warn' },
  no_aplica: {
    ring: 'border-line-strong text-ink-2 opacity-50',
    fill: 'bg-ink-2',
  },
  llego: { ring: 'border-warn text-warn', fill: 'bg-warn' },
}

/** An exit rule as an icon with a thin progress bar; the detail is only in the tooltip. */
function RuleIcon({ rule }: { rule: RuleView }) {
  // Waiting for the 24 h check is amber, waiting for the cap is blue.
  const tone =
    rule.id === 'exhaust' && rule.state === 'espera'
      ? { ring: 'border-warn text-warn', fill: 'bg-warn' }
      : RULE_TONE[rule.state]
  return (
    <Tip
      focusable
      label={`${rule.label}: ${RULE_WORD[rule.state]}`}
      content={rule.tip}
      className="flex-col items-center gap-0.5"
    >
      <span
        data-testid={`operation-rule-${rule.id}`}
        data-state={rule.state}
        className={`grid size-6 place-items-center rounded-full border-2 border-solid bg-surface-2 ${tone.ring}`}
      >
        <Icon name={RULE_ICON[rule.id]} />
      </span>
      <span className="block h-1 w-6 overflow-hidden rounded-sm bg-line">
        {rule.progress !== null && (
          <i
            className={`block h-full ${tone.fill}`}
            style={{ width: pct(rule.progress) }}
          />
        )}
      </span>
    </Tip>
  )
}

/** Lugares: one dot per place of the shared account, filled when a position holds it. */
function PlaceDots({
  place,
  side,
}: {
  place: PositionPlace
  side: 'LONG' | 'SHORT'
}) {
  const summary = `Abiertas ${place.open} de ${place.max}${place.usedUsd === null ? '' : ` · saldo usado ${amount(place.usedUsd)} USD`}`
  const next = place.open > 1 && place.onNext ? place.onNext : null
  const body = (
    <>
      <span className="inline-flex gap-1" aria-hidden="true">
        {Array.from({ length: place.max }, (_, index) => {
          const filled = index < place.open
          const mine = filled && index + 1 === place.index
          return (
            <i
              key={index}
              data-filled={filled}
              className={`size-2 rounded-full ${mine ? (side === 'LONG' ? 'bg-long' : 'bg-short') : filled ? 'bg-ink-2' : 'bg-line-strong'}`}
            />
          )
        })}
      </span>
      <span className="sr-only">
        {next ? 'Ver otra posición. ' : ''}
        {summary}
      </span>
    </>
  )
  return (
    <Tip
      content={`${placeText(place)} · ${summary}${next ? ' · clic: ver otra' : ''}`}
      align="start"
    >
      {next ? (
        <button
          type="button"
          onClick={next}
          data-testid="operation-places"
          className="flex cursor-pointer items-center border-0 bg-transparent p-1"
        >
          {body}
        </button>
      ) : (
        <span data-testid="operation-places" className="flex items-center p-1">
          {body}
        </span>
      )}
    </Tip>
  )
}

/** A small icon button with its name in a tooltip. */
function IconButton({
  label,
  tip,
  tone = 'text-ink-2',
  onClick,
  children,
}: {
  label: string
  tip: string
  tone?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tip content={tip} align="end">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`grid size-5 terminal-condensed:size-4 cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 hover:text-ink focus-visible:outline-2 focus-visible:outline-info ${tone}`}
      >
        {children}
      </button>
    </Tip>
  )
}

const glyph = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

/** Percent of the size, with a comma and a sign: `+0,98 %`. */
function signedPercent(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${amount(Math.abs(value))} %`
}

export default function TerminalOperationCard({
  trade,
  place,
  source,
  nowMs,
  onFocus,
  compact = false,
  notice,
  master = null,
}: {
  trade: QwenTrade | null
  /** Only with several places: which of the open positions this is and the balance in use. */
  place?: PositionPlace | null
  source: QwenTradesSource
  nowMs: number
  onFocus: () => void
  compact?: boolean
  notice?: string | null
  /** The maestro as the latest look read it, for the first exit rule; null when there is no look. */
  master?: MasterReading | null
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  if (trade === null)
    return (
      <section
        className={`${TERMINAL_FRAME} ${compact ? 'h-full p-2' : 'p-5'}`}
        aria-label="Operación seleccionada"
      >
        <p
          className={
            compact ? 'm-0 mb-1 text-label text-ink-2' : TERMINAL_CARD_LABEL
          }
        >
          Operación de Terminal
        </p>
        <p
          role="status"
          className={compact ? 'm-0 text-label text-ink-2' : 'text-ink-2'}
        >
          {source.state === 'loading'
            ? 'Cargando operación…'
            : source.state === 'ok'
              ? 'Sin operaciones registradas.'
              : 'No se puede confirmar la operación.'}
        </p>
      </section>
    )
  const confirmed = source.state === 'ok' && !trade.execution?.error
  const tone = tradeTone(trade, confirmed)
  const end = trade.open ? nowMs : trade.exitMs
  const minutes =
    end === null || end < trade.entryMs
      ? null
      : Math.floor((end - trade.entryMs) / 60_000)
  const duration =
    minutes === null
      ? 'No registrada'
      : minutes >= 60
        ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
        : `${minutes} min`
  const resultClass =
    tone === 'gain'
      ? 'text-long'
      : tone === 'loss'
        ? 'text-short'
        : tone === 'provisional'
          ? 'text-warn'
          : 'text-ink-2'
  const recordedMs = trade.open ? trade.markMs : trade.exitMs
  const currentPrice = trade.open ? trade.markPrice : trade.exitPrice
  const percent =
    trade.netUsd !== null && trade.notionalUsd
      ? (trade.netUsd / trade.notionalUsd) * 100
      : null
  const range = rangeView(trade)
  const rules = ruleViews(trade, nowMs, master)
  if (compact)
    return (
      <>
        <section
          className={`${TERMINAL_FRAME} grid h-full min-h-0 content-between gap-1 px-2 py-1.5 from-700:px-3 from-700:py-2 terminal-condensed:gap-0.5 terminal-condensed:px-2 terminal-condensed:py-1`}
          aria-label="Operación seleccionada"
          data-testid="terminal-operation-card"
        >
          <div className="flex items-center justify-between gap-2 text-label">
            <span className="flex min-w-0 items-center gap-1.5">
              <strong
                className={`rounded-badge px-1.5 text-badge leading-4 ${trade.side === 'LONG' ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}
              >
                {trade.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}
              </strong>
              <b className="text-ink">#{trade.tradeNo}</b>
              {trade.entryReason === 'rebote' && (
                <Tip content="La abrió el experto de rebotes: sale a las 4 h, sin la regla del maestro.">
                  <span className="text-badge text-chart-info">rebote</span>
                </Tip>
              )}
              {place && place.open > 0 && (
                <PlaceDots place={place} side={trade.side} />
              )}
            </span>
            <span className="flex flex-none items-center gap-1">
              <IconButton
                label="Centrar operación"
                tip="Centrar operación en el gráfico"
                tone="text-chart-info"
                onClick={onFocus}
              >
                <svg {...glyph}>
                  <circle cx="12" cy="12" r="7" />
                  <circle cx="12" cy="12" r="1.5" />
                  <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                </svg>
              </IconButton>
              <IconButton
                label={`Datos y costes${!trade.fundingComplete ? ' *' : ''}`}
                tip={`Datos y costes${!trade.fundingComplete ? ' (funding incompleto: provisional)' : ''}`}
                tone={!trade.fundingComplete ? 'text-warn' : 'text-ink-2'}
                onClick={() => setDetailsOpen(true)}
              >
                <svg {...glyph}>
                  <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
                  <path d="M9 8h6M9 12h6" />
                </svg>
              </IconButton>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="terminal-condensed:hidden">
              <HoursRing trade={trade} nowMs={nowMs} />
            </span>
            <div className="min-w-0 flex-1">
              <Tip
                align="start"
                content={
                  trade.open
                    ? `Neto si se cerrara ahora, con costes${trade.notionalUsd === null ? '' : `, sobre ${amount(trade.notionalUsd)} US$ de tamaño`}.`
                    : 'Neto registrado al cierre, con costes.'
                }
              >
                <strong
                  className={`block whitespace-nowrap text-run-title leading-tight terminal-condensed:text-value terminal-condensed:leading-none ${resultClass}`}
                  data-testid="operation-net"
                >
                  {trade.netUsd === null ? '—' : signedUsd(trade.netUsd)}
                </strong>
              </Tip>
              <small
                className={`block truncate text-badge leading-tight terminal-condensed:leading-3 ${!confirmed || !trade.fundingComplete || notice ? 'text-warn' : 'text-ink-2'}`}
                data-testid="operation-percent"
              >
                {notice ? (
                  <Tip content={notice}>
                    <span>⚠ </span>
                  </Tip>
                ) : null}
                {!confirmed
                  ? 'Último dato, sin confirmar.'
                  : `${trade.open ? '' : 'Cerrada · '}${percent === null ? '—' : signedPercent(percent)}${trade.fundingComplete ? '' : ' · provisional'}`}
              </small>
            </div>
            <Tip
              align="end"
              content={`Entrada fija ${usd(trade.entryPrice)} (${madridDateTimeSeconds(trade.entryMs)}, hora de Madrid)${currentPrice === null ? '' : `; ${trade.open ? 'marca' : 'cierre'} ${usd(currentPrice)}${recordedMs == null ? '' : ` a las ${madridTime(recordedMs)}`}`}.`}
            >
              <span className="grid flex-none justify-items-end text-label leading-4 tabular-nums terminal-condensed:leading-3">
                <b className="text-ink-2" data-testid="operation-entry">
                  {amount(trade.entryPrice)}
                </b>
                <b className="text-ink" data-testid="operation-now-price">
                  → {currentPrice === null ? '—' : amount(currentPrice)}
                </b>
              </span>
            </Tip>
          </div>
          <div className="grid gap-1 until-699:hidden terminal-condensed:hidden">
            <RangeBar range={range} />
            {rules.length > 0 && (
              <div
                className="flex justify-center gap-6"
                role="group"
                aria-label="Reglas de salida"
              >
                {rules.map((rule) => (
                  <RuleIcon key={rule.id} rule={rule} />
                ))}
              </div>
            )}
          </div>
        </section>
        {detailsOpen && (
          <ModalFrame
            label={`Datos de la operación ${trade.tradeNo}`}
            onClose={() => setDetailsOpen(false)}
          >
            <h2>
              Operación #{trade.tradeNo} · {trade.side}
            </h2>
            {!confirmed && (
              <p className="text-warn">Último dato, sin confirmar.</p>
            )}
            {notice && (
              <p className="text-warn" role="status">
                {notice}
              </p>
            )}
            <dl>
              <dt>Entrada registrada</dt>
              <dd>
                {usd(trade.entryPrice)} · {madridDateTimeSeconds(trade.entryMs)}
              </dd>
              <dt>{trade.open ? 'Marca registrada' : 'Cierre registrado'}</dt>
              <dd>
                {usd(trade.open ? trade.markPrice : trade.exitPrice)} ·{' '}
                {recordedMs == null
                  ? 'No registrado'
                  : madridDateTimeSeconds(recordedMs)}
              </dd>
              <dt>Duración</dt>
              <dd>{duration}</dd>
              <dt>Comisiones</dt>
              <dd>{usd(trade.feesUsd)}</dd>
              <dt>Funding</dt>
              <dd>
                {usd(trade.fundingUsd)} ·{' '}
                {trade.fundingComplete ? 'completo' : 'incompleto, provisional'}
              </dd>
              <dt>Tamaño / margen</dt>
              <dd>
                {amount(trade.notionalUsd)} / {amount(trade.marginUsd)} USD
              </dd>
              <dt>Apalancamiento</dt>
              <dd>{amount(trade.leverage)}×</dd>
              {trade.entryReason === 'rebote' && (
                <>
                  <dt>Quién la abrió</dt>
                  <dd>
                    Experto rebotes · sale a las{' '}
                    {madridTime(
                      trade.entryMs + (trade.maxHoldMs ?? 4 * 3_600_000),
                    )}{' '}
                    (Madrid)
                  </dd>
                </>
              )}
              {exitReasonText(trade) && (
                <>
                  <dt>Por qué cerró</dt>
                  <dd data-testid="operation-exit-reason">
                    {exitReasonText(trade)}
                  </dd>
                </>
              )}
              <ExecutionDetails trade={trade} nowMs={nowMs} flat />
            </dl>
            <button type="button" onClick={() => setDetailsOpen(false)}>
              Cerrar
            </button>
          </ModalFrame>
        )}
      </>
    )
  return (
    <section
      className={`${TERMINAL_FRAME} p-5`}
      aria-label="Operación seleccionada"
      data-testid="terminal-operation-card"
    >
      <p className={TERMINAL_CARD_LABEL}>
        Operación #{trade.tradeNo} · paper
        {place && place.index > 0 ? ` · ${placeText(place)}` : ''}
        {trade.entryReason === 'rebote' ? ' · experto rebotes' : ''}
      </p>
      <div className="flex items-center justify-between gap-2">
        <strong
          className={`text-value font-bold ${trade.side === 'LONG' ? 'text-long' : 'text-short'}`}
        >
          {trade.side === 'LONG' ? '▲' : '▼'} {trade.side}
        </strong>
        <span className="rounded-full border border-solid border-line px-2 py-1 text-badge text-ink-2">
          {!confirmed ? 'Sin confirmar' : trade.open ? 'En curso' : 'Cerrada'}
        </span>
      </div>
      <p
        className={`mt-5 mb-1.25 text-run-value leading-tight font-bold tracking-brand ${resultClass}`}
        data-testid="operation-net"
      >
        {trade.netUsd === null ? '—' : signedUsd(trade.netUsd)}
      </p>
      <p className="mt-0 mb-2.5 text-label leading-relaxed text-ink-2">
        {!confirmed
          ? 'Último dato, sin confirmar.'
          : trade.open
            ? 'Neto registrado para cerrar a la última marca, tras costes.'
            : 'Neto registrado al cierre, tras costes.'}
      </p>
      {!trade.fundingComplete && (
        <p className="mt-0 mb-2.5 text-label leading-relaxed text-warn">
          Funding incompleto · resultado provisional.
        </p>
      )}
      <dl className="my-4 grid gap-2.5 border-t border-t-solid border-t-line pt-3.5 child-div:flex child-div:items-center child-div:justify-between child-div:gap-2.5 descendant-dt:text-label descendant-dt:text-ink-2 descendant-dd:m-0 descendant-dd:text-right descendant-dd:text-label">
        <div>
          <dt>● Entrada fija</dt>
          <dd data-testid="operation-entry">{usd(trade.entryPrice)}</dd>
        </div>
        <div>
          <dt>◷ Inicio (Madrid)</dt>
          <dd title={madridDateTimeSeconds(trade.entryMs)}>
            {madridTime(trade.entryMs)}
          </dd>
        </div>
        <div>
          <dt>{trade.open ? '◉ Marca (Madrid)' : '× Cierre (Madrid)'}</dt>
          <dd
            title={
              recordedMs == null ? undefined : madridDateTimeSeconds(recordedMs)
            }
          >
            {recordedMs == null ? '—' : madridTime(recordedMs)}
          </dd>
        </div>
        <div>
          <dt>Duración</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>Comisiones</dt>
          <dd>{usd(trade.feesUsd)}</dd>
        </div>
        <div>
          <dt>Funding</dt>
          <dd>{usd(trade.fundingUsd)}</dd>
        </div>
        <div>
          <dt>Tamaño / margen</dt>
          <dd>
            {amount(trade.notionalUsd)} / {amount(trade.marginUsd)} USD
          </dd>
        </div>
        {place && place.open > 0 && (
          <div>
            <dt>Abiertas</dt>
            <dd data-testid="operation-places">
              {place.open} de {place.max}
              {place.usedUsd === null
                ? ''
                : ` · saldo usado ${amount(place.usedUsd)} USD`}
            </dd>
          </div>
        )}
        {exitReasonText(trade) && (
          <div>
            <dt>Por qué cerró</dt>
            <dd data-testid="operation-exit-reason">{exitReasonText(trade)}</dd>
          </div>
        )}
        <ExecutionDetails trade={trade} nowMs={nowMs} />
      </dl>
      <div
        className="my-4.5 flex items-center gap-2 text-chart-info child-span:grid child-span:size-6.5 child-span:place-items-center child-span:rounded-full child-span:border child-span:border-solid child-span:border-line child-i:flex-1 child-i:border-t child-i:border-t-solid child-i:border-t-chart-info"
        aria-hidden="true"
      >
        <span>▶</span>
        <i />
        <span>{trade.open ? '◷' : '✓'}</span>
        <i />
        <span className={trade.open ? 'text-ink-2' : resultClass}>×</span>
      </div>
      <button
        className="w-full cursor-pointer rounded-lg border border-solid border-line bg-surface-2 p-2 text-label text-chart-info hover:border-chart-info focus-visible:outline-2 focus-visible:outline-info"
        type="button"
        onClick={onFocus}
      >
        Centrar operación
      </button>
    </section>
  )
}
