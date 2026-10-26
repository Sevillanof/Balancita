import { utcDateTime } from '../shared/finance/format.ts'
import { useQwenTrades, type QwenTrade } from './useQwenTrades.ts'
import { qwenTradesNotice, signedUsd } from './qwen-trades-text.ts'
import { TERMINAL_PANEL } from '../shared/design-system/terminal-styles.ts'

const CLOSED_BY: Record<string, string> = {
  qwen: 'la cerró Qwen',
  stop: 'saltó el stop automático',
  tiempo: 'cierre obligatorio por tiempo (4 h)',
  fin_de_bloque: 'fin del periodo de prueba',
}

function hold(minutes: number | null): string {
  if (minutes === null) return ''
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    : `${minutes} min`
}

const side = (trade: QwenTrade) =>
  trade.side === 'LONG'
    ? 'larga (apostó a que sube)'
    : 'corta (apostó a que baja)'

/** Qwen operador's paper trades: the open one with its result now, the closed ones with their net. */
export default function QwenTradesPanel({
  product,
  enabled,
}: {
  product: string | undefined
  enabled: boolean
}) {
  const { trades, source } = useQwenTrades(product, enabled)
  if (!enabled) return null
  const open = trades.filter((trade) => trade.open)
  const closed = trades.filter((trade) => !trade.open)
  const total = closed.reduce((sum, trade) => sum + (trade.netUsd ?? 0), 0)
  const notice = qwenTradesNotice(source, trades.length)
  return (
    <section
      className={`${TERMINAL_PANEL} mt-4`}
      aria-label="Operaciones de Qwen"
    >
      <h2>Operaciones de Qwen</h2>
      <p>
        <small>
          Simuladas en papel, con los costos reales de Kraken y el funding
          publicado. No hay órdenes reales.
        </small>
      </p>
      {notice ? (
        <p role="status">{notice}</p>
      ) : (
        <>
          {open.map((trade) => (
            <p key={trade.tradeNo} data-testid="qwen-open-trade">
              <strong>Abierta ahora:</strong> posición {side(trade)} desde{' '}
              {utcDateTime(trade.entryMs)}
              {trade.entryPrice !== null
                ? `, entrada ${trade.entryPrice.toFixed(2)}`
                : ''}
              . Si la cerrara ahora, ya con costos: {signedUsd(trade.netUsd)}.
            </p>
          ))}
          {open.length === 0 && <p>Sin posición abierta ahora.</p>}
          {closed.length > 0 && (
            <>
              <h3>Cerradas ({signedUsd(total)} en total)</h3>
              <ul className="m-0 pl-trade-list">
                {closed.map((trade) => (
                  <li key={trade.tradeNo} data-testid="qwen-closed-trade">
                    <strong>{trade.side === 'LONG' ? 'LARGO' : 'CORTO'}</strong>{' '}
                    {trade.exitMs !== null ? utcDateTime(trade.exitMs) : ''} ·
                    neto {signedUsd(trade.netUsd)} ·{' '}
                    {CLOSED_BY[trade.closedBy ?? ''] ?? 'cerrada'}
                    {trade.holdMin !== null ? ` · ${hold(trade.holdMin)}` : ''}
                    {trade.fundingComplete
                      ? ''
                      : ' · funding todavía incompleto'}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
