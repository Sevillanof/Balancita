import './trade.css'

/**
 * Presentation-only auto-trading control for Phase 1. It is deliberately
 * disabled and has no handler: it never places, modifies or authorizes orders.
 */
export default function AutoTradingControl() {
  return (
    <section className="auto-trading" aria-label="Control automático">
      <div className="auto-trading__row">
        <span className="auto-trading__label">Control automático</span>
        <button
          type="button"
          className="auto-trading__toggle"
          disabled
          aria-disabled="true"
        >
          Auto: desactivado
        </button>
      </div>
      <p className="auto-trading__note">
        Sólo presentación. No ejecuta ninguna acción en esta fase.
      </p>
    </section>
  )
}
