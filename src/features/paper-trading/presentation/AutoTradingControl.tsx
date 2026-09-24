import './trade.css'

export default function AutoTradingControl({
  enabled,
  available,
  ready,
  onChange,
}: {
  enabled: boolean
  available: boolean
  ready: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <label className="button button--secondary">
      <input
        type="checkbox"
        role="switch"
        aria-label="Trading automático simulado"
        checked={enabled}
        disabled={!available}
        onChange={(event) => {
          if (available) onChange(event.currentTarget.checked)
        }}
      />
      Trading automático simulado
      {!available && (
        <span>
          {' '}
          · {ready ? 'Esperando Kraken en vivo' : 'Indicadores en preparación'}
        </span>
      )}
    </label>
  )
}
