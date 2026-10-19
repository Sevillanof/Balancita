import { agoText } from '../domain/forward-text.ts'
import type { ForwardHealth } from '../infrastructure/strategy-api.ts'

/** `PF_XBTUSD` -> `XBT`: the short name that fits a header chip. */
function shortName(product: string) {
  return product.replace(/^PF_/, '').replace(/USD$/, '')
}

/** What each code of the funding check means for the owner, in plain words; the engine's own sentence is the detail. */
const PLAIN_REASONS: Record<string, string> = {
  stale:
    'la última tasa horaria de funding no quedó guardada a tiempo (la captura estuvo parada o sin conexión)',
  no_history: 'todavía no hay tasas de funding guardadas',
  insufficient_history:
    'faltan días de historia: se necesitan 30 días de funding',
  window_gaps:
    'faltan horas de funding en los últimos 30 días (captura apagada o sin relleno)',
}

/**
 * Funding per product as compact chips for the header health area: green and a tick when the funding the
 * strategies need is usable, amber and a cross when it is not (the reason is in the tooltip). Read-only.
 * `undefined` while the strategies page has not loaded yet: nothing is drawn rather than a guess.
 */
export function FundingChips({
  funding,
  now,
}: {
  funding: ForwardHealth['funding'] | null | undefined
  now: number
}) {
  if (funding === undefined) return null
  const products = funding === null ? [] : Object.entries(funding)
  if (products.length === 0)
    return (
      <span
        className="demo-shell__badge demo-shell__badge--usage"
        data-testid="funding-chips"
        title="El resumen del forward no trae el estado del funding"
      >
        FUNDING sin datos
      </span>
    )
  return (
    <span
      className="demo-shell__funding"
      data-testid="funding-chips"
      role="group"
      aria-label="Funding por producto"
    >
      <span className="demo-shell__funding-label">FUNDING</span>
      {products.map(([product, state]) => {
        const checked = agoText(state.checked_ms, now)
        const plain = PLAIN_REASONS[state.code]
        const sentence = state.usable
          ? `${product}: funding usable`
          : `${product}: funding no usable: ${plain ?? state.reason}`
        const detail =
          !state.usable && plain && state.reason
            ? `. Detalle: ${state.reason}`
            : ''
        return (
          <span
            key={product}
            className="demo-shell__badge"
            data-tone={state.usable ? 'ok' : undefined}
            data-testid={`funding-chip-${product}`}
            title={`${sentence}${checked ? ` (comprobado ${checked})` : ''}${detail}`}
            aria-label={sentence}
          >
            {shortName(product)} {state.usable ? '✓' : '✕'}
          </span>
        )
      })}
    </span>
  )
}
