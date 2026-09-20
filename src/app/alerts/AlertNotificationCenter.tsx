import type { AlertId } from '../../domain/alerts'
import { formatPrice } from '../format'
import type { TriggeredAlert } from './useAlerts'

type AlertNotificationCenterProps = {
  triggered: readonly TriggeredAlert[]
  onAcknowledge: (id: AlertId) => void
}

/**
 * In-app notification surface for triggered alerts. Rendered at the app level
 * so a trigger is visible from any tab, without OS permissions, email, SMS or
 * push. Renders nothing when no alert is currently triggered.
 */
export default function AlertNotificationCenter({
  triggered,
  onAcknowledge,
}: AlertNotificationCenterProps) {
  if (triggered.length === 0) return null

  return (
    <section className="alerts__notifications" aria-label="Alert notifications">
      {triggered.map(({ alert, instrument }) => {
        const message = `${instrument.symbol} ${alert.direction} ${formatPrice(
          alert.thresholdPrice,
          instrument.currency,
        )}`
        return (
          <div
            key={alert.id}
            role="alert"
            aria-label={message}
            className="alerts__notification"
          >
            <span className="alerts__notification-message">{message}</span>
            <button
              type="button"
              className="alerts__notification-action"
              onClick={() => onAcknowledge(alert.id)}
            >
              Acknowledge {instrument.symbol}
            </button>
          </div>
        )
      })}
    </section>
  )
}
