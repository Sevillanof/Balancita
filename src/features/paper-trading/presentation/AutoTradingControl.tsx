import './trade.css'

/**
 * Presentation-only auto-trading control for Phase 1. It renders a single
 * disabled button with no handler: it never places, modifies or authorizes
 * orders.
 */
export default function AutoTradingControl() {
  return (
    <button
      type="button"
      className="button button--secondary"
      disabled
      aria-disabled="true"
    >
      Auto Trade
    </button>
  )
}
