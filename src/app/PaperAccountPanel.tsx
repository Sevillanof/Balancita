import { money, quantity } from './terminal-labels.ts'

export default function PaperAccountPanel({
  account,
  netValue,
  position,
  localDemo,
  showAnalysisTime,
}: {
  account: Record<string, unknown>
  netValue: unknown
  position: Record<string, unknown>
  localDemo: boolean
  showAnalysisTime: boolean
}) {
  return (
    <section className="connected-terminal__panel" aria-label="Cuenta paper">
      <h2>Cuenta paper</h2>
      <div>
        <dl>
          <dt>Saldo USD</dt>
          <dd>{money(account.cash_usd)}</dd>
          <dt>Patrimonio USD</dt>
          <dd
            title={String(account.equity_usd ?? '')}
            data-value={String(account.equity_usd ?? '')}
          >
            {money(account.equity_usd, localDemo ? 5 : 2)}
          </dd>
          {showAnalysisTime && (
            <>
              <dt>PnL bruto realizado USD</dt>
              <dd
                title={String(account.realized_gross_usd ?? '')}
                data-value={String(account.realized_gross_usd ?? '')}
              >
                {money(account.realized_gross_usd, 5)}
              </dd>
            </>
          )}
          <dt>Fees USD</dt>
          <dd
            title={String(account.fees_usd ?? '')}
            data-value={String(account.fees_usd ?? '')}
          >
            {money(account.fees_usd, localDemo ? 5 : 2)}
          </dd>
          <dt>Funding pagado (USD)</dt>
          <dd>
            {account.funding_complete === true
              ? money(account.funding_paid_usd ?? account.funding_paid)
              : 'Incompleto · neto no disponible'}
          </dd>
          <dt>PnL neto</dt>
          <dd
            {...(localDemo && netValue != null
              ? {
                  title: String(netValue),
                  'data-value': String(netValue),
                }
              : {})}
          >
            {netValue == null
              ? account.funding_complete === true
                ? 'No disponible durante posición abierta'
                : 'Incompleto'
              : money(netValue, localDemo ? 5 : 2)}
          </dd>
          <dt>Posición</dt>
          <dd>
            {position.side
              ? `${String(position.side)} · ${quantity(position.quantity_btc)}`
              : localDemo
                ? `${quantity(position.quantity_btc ?? '0')} · Sin exposición`
                : 'Sin posición abierta'}
          </dd>
        </dl>
      </div>
    </section>
  )
}
