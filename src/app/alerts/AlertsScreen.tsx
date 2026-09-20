import { useState } from 'react'
import type { Instrument, InstrumentId } from '../../domain/market-data'
import type { AlertDirection } from '../../domain/alerts'
import { formatLocalTime, formatPrice } from '../format'
import type { UseAlertsResult } from './useAlerts'
import './alerts.css'

type AlertsScreenProps = {
  alerts: UseAlertsResult
}

export default function AlertsScreen({ alerts }: AlertsScreenProps) {
  const [creating, setCreating] = useState(false)

  const handleCreate = async (input: {
    instrumentId: InstrumentId
    direction: AlertDirection
    thresholdPrice: number
  }): Promise<boolean> => {
    const created = await alerts.create(input)
    if (created) setCreating(false)
    return created
  }

  const handleAcknowledge = async (id: string) => {
    await alerts.acknowledge(id)
  }

  const handleDelete = async (id: string) => {
    await alerts.remove(id)
  }

  const catalog = [...alerts.instruments.values()]
  const { status, loadError } = alerts

  return (
    <section className="alerts" aria-label="Alerts">
      <div className="alerts__header">
        <h2 className="alerts__title">Alerts</h2>
        {status !== 'loading' && status !== 'error' && (
          <button
            type="button"
            className="alerts__add"
            onClick={() => setCreating(true)}
          >
            Add alert
          </button>
        )}
      </div>

      {status === 'error' && (
        <div role="alert" className="alerts__error">
          {loadError === 'corrupt'
            ? 'Stored alert data could not be read.'
            : 'Unable to load alerts.'}
          <div className="alerts__error-actions">
            {loadError === 'corrupt' && (
              <button
                type="button"
                className="alerts__retry"
                onClick={() => void alerts.reset()}
              >
                Reset alerts
              </button>
            )}
            <button
              type="button"
              className="alerts__retry"
              onClick={alerts.retry}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {creating && status !== 'error' && (
        <AlertForm
          instruments={catalog}
          onSubmit={handleCreate}
          operationError={alerts.operationError}
          onCancel={() => setCreating(false)}
        />
      )}

      <table className="alerts__table" aria-busy={status === 'loading'}>
        <caption className="alerts__caption">
          Price alerts evaluated against the live mock feed
        </caption>
        <thead>
          <tr>
            <th scope="col">Alert</th>
            <th scope="col">Direction</th>
            <th scope="col" className="alerts__num">
              Threshold
            </th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {status === 'loading' && (
            <tr>
              <td colSpan={6} role="status" className="alerts__placeholder">
                Loading alerts…
              </td>
            </tr>
          )}
          {status === 'empty' && (
            <tr>
              <td colSpan={6} role="status" className="alerts__placeholder">
                No alerts yet.
              </td>
            </tr>
          )}
          {status === 'ready' &&
            alerts.alerts.map((alert) => {
              const instrument = alerts.instruments.get(alert.instrumentId)
              if (!instrument) return null
              return (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  instrument={instrument}
                  onAcknowledge={() => void handleAcknowledge(alert.id)}
                  onDelete={() => void handleDelete(alert.id)}
                />
              )
            })}
        </tbody>
      </table>
    </section>
  )
}

function AlertRow({
  alert,
  instrument,
  onAcknowledge,
  onDelete,
}: {
  alert: UseAlertsResult['alerts'][number]
  instrument: Instrument
  onAcknowledge: () => void
  onDelete: () => void
}) {
  return (
    <tr>
      <th scope="row">
        <span className="alerts__symbol">{instrument.symbol}</span>
        <span className="alerts__name">{instrument.displayName}</span>
      </th>
      <td>{alert.direction}</td>
      <td className="alerts__num">
        {formatPrice(alert.thresholdPrice, instrument.currency)}
      </td>
      <td>
        <span className="alerts__badge" data-status={alert.status}>
          {alert.status}
        </span>
      </td>
      <td>{formatLocalTime(alert.createdAt)}</td>
      <td className="alerts__actions">
        {alert.status === 'triggered' && (
          <button
            type="button"
            className="alerts__action"
            onClick={onAcknowledge}
          >
            Acknowledge {instrument.symbol} alert
          </button>
        )}
        <button
          type="button"
          className="alerts__action alerts__action--danger"
          onClick={onDelete}
        >
          Delete {instrument.symbol} alert
        </button>
      </td>
    </tr>
  )
}

type AlertFormProps = {
  instruments: readonly Instrument[]
  onSubmit: (input: {
    instrumentId: InstrumentId
    direction: AlertDirection
    thresholdPrice: number
  }) => Promise<boolean>
  onCancel: () => void
  operationError: string | null
}

function AlertForm({
  instruments,
  onSubmit,
  onCancel,
  operationError,
}: AlertFormProps) {
  const [instrumentId, setInstrumentId] = useState<InstrumentId>('')
  const [direction, setDirection] = useState<AlertDirection>('above')
  const [threshold, setThreshold] = useState('')
  const [thresholdError, setThresholdError] = useState(false)

  const isThresholdValid = (value: string) => {
    const parsed = Number(value)
    return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const thresholdOk = isThresholdValid(threshold)
    setThresholdError(!thresholdOk)
    if (!thresholdOk) return
    if (!instrumentId) return

    await onSubmit({
      instrumentId,
      direction,
      thresholdPrice: Number(threshold),
    })
  }

  return (
    <form
      className="alerts__form"
      aria-label="Add alert"
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div className="alerts__field">
        <label htmlFor="alert-instrument">Instrument</label>
        <select
          id="alert-instrument"
          value={instrumentId}
          onChange={(event) => setInstrumentId(event.target.value)}
          required
        >
          <option value="" disabled>
            Select an instrument
          </option>
          {instruments.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.symbol} — {instrument.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="alerts__field">
        <label htmlFor="alert-direction">Direction</label>
        <select
          id="alert-direction"
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as AlertDirection)
          }
        >
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
      </div>

      <div className="alerts__field">
        <label htmlFor="alert-threshold">Threshold price</label>
        <input
          id="alert-threshold"
          type="number"
          min="0.01"
          step="any"
          value={threshold}
          onChange={(event) => setThreshold(event.target.value)}
          aria-invalid={thresholdError || undefined}
          aria-describedby={
            thresholdError ? 'alert-threshold-error' : undefined
          }
        />
        {thresholdError && (
          <p
            id="alert-threshold-error"
            role="alert"
            className="alerts__field-error"
          >
            Threshold must be greater than zero.
          </p>
        )}
      </div>

      {operationError && (
        <p role="alert" className="alerts__field-error">
          {operationError}
        </p>
      )}

      <div className="alerts__form-actions">
        <button type="submit" className="alerts__save">
          Save alert
        </button>
        <button type="button" className="alerts__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
