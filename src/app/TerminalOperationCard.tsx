import type { QwenTrade, QwenTradesSource } from './useQwenTrades.ts'
import { Fragment, useState } from 'react'
import ModalFrame from '../features/strategy-lab/presentation/ModalFrame.tsx'
import { exitPlanText, exitReasonText, signedUsd } from './qwen-trades-text.ts'
import { amount, usd, utcDateTime } from '../shared/finance/format.ts'
import { tradeTone } from '../features/trading-view/domain/terminal-trade-model.ts'
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
      <dt>Recepción / ejecución UTC</dt>
      <dd>
        {utcDateTime(phase.receivedMs)} / {utcDateTime(phase.executedMs)}
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

export default function TerminalOperationCard({
  trade,
  source,
  nowMs,
  onFocus,
  compact = false,
  notice,
}: {
  trade: QwenTrade | null
  source: QwenTradesSource
  nowMs: number
  onFocus: () => void
  compact?: boolean
  notice?: string | null
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
  if (compact)
    return (
      <>
        <section
          className={`${TERMINAL_FRAME} grid h-full min-h-0 grid-rows-card gap-1 p-2 from-700:p-3 terminal-condensed:gap-0.5 terminal-condensed:px-2 terminal-condensed:py-1`}
          aria-label="Operación seleccionada"
          data-testid="terminal-operation-card"
        >
          <div className="flex items-center justify-between gap-2 text-label">
            <strong
              className={trade.side === 'LONG' ? 'text-long' : 'text-short'}
            >
              {trade.side === 'LONG' ? '▲' : '▼'} {trade.side} · #
              {trade.tradeNo}
            </strong>
            <span
              className={`text-badge ${notice ? 'text-warn' : 'text-ink-2'}`}
              title={notice ?? undefined}
            >
              {notice ? '⚠ ' : ''}
              {!confirmed
                ? 'Sin confirmar'
                : trade.open
                  ? 'En curso'
                  : 'Cerrada'}{' '}
              · {duration}
            </span>
          </div>
          <div className="grid min-h-0 content-center gap-1">
            <div className="grid grid-cols-main-auto items-center gap-2">
              <div>
                <strong
                  className={`block whitespace-nowrap text-run-title leading-tight terminal-condensed:text-value terminal-condensed:leading-none ${resultClass}`}
                  data-testid="operation-net"
                >
                  {trade.netUsd === null ? '—' : signedUsd(trade.netUsd)}
                </strong>
                <small className="block text-badge leading-tight text-ink-2 until-699:sr-only terminal-condensed:sr-only">
                  {!confirmed
                    ? 'Último dato, sin confirmar.'
                    : trade.open
                      ? 'Neto a la marca registrada'
                      : 'Neto registrado al cierre'}
                </small>
              </div>
              <div className="text-right">
                <small className="block text-badge leading-3 text-ink-2 terminal-condensed:sr-only">
                  Entrada fija
                </small>
                <strong
                  className="block text-label leading-4"
                  data-testid="operation-entry"
                >
                  {usd(trade.entryPrice)}
                </strong>
              </div>
            </div>
            <div className="flex justify-between gap-2 text-badge leading-4 text-ink-2 terminal-condensed:sr-only">
              <span>
                Inicio UTC{' '}
                <b>{new Date(trade.entryMs).toISOString().slice(11, 16)}</b>
              </span>
              <span>
                {trade.open ? 'Marca UTC' : 'Cierre UTC'}{' '}
                <b>
                  {recordedMs == null
                    ? '—'
                    : new Date(recordedMs).toISOString().slice(11, 16)}
                </b>
              </span>
            </div>
            {!trade.fundingComplete && (
              <span className="text-badge leading-3 text-warn terminal-condensed:sr-only">
                Funding incompleto · provisional
              </span>
            )}
          </div>
          <div className="flex justify-between gap-2 text-label">
            <button
              type="button"
              onClick={onFocus}
              className="cursor-pointer border-0 bg-transparent p-0 text-label text-chart-info"
            >
              Centrar operación
            </button>
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className={`cursor-pointer border-0 bg-transparent p-0 text-label ${!trade.fundingComplete ? 'text-warn' : 'text-ink-2'}`}
            >
              Datos y costes{!trade.fundingComplete ? ' *' : ''} ↗
            </button>
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
                {usd(trade.entryPrice)} · {utcDateTime(trade.entryMs)}
              </dd>
              <dt>{trade.open ? 'Marca registrada' : 'Cierre registrado'}</dt>
              <dd>
                {usd(trade.open ? trade.markPrice : trade.exitPrice)} ·{' '}
                {recordedMs == null ? 'No registrado' : utcDateTime(recordedMs)}
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
      <p className={TERMINAL_CARD_LABEL}>Operación #{trade.tradeNo} · paper</p>
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
          <dt>◷ Inicio UTC</dt>
          <dd title={utcDateTime(trade.entryMs)}>
            {new Date(trade.entryMs).toISOString().slice(11, 16)}
          </dd>
        </div>
        <div>
          <dt>{trade.open ? '◉ Marca UTC' : '× Cierre UTC'}</dt>
          <dd title={recordedMs == null ? undefined : utcDateTime(recordedMs)}>
            {recordedMs == null
              ? '—'
              : new Date(recordedMs).toISOString().slice(11, 16)}
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
