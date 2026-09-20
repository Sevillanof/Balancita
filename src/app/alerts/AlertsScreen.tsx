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
    <section className="alerts" aria-label="Alertas">
      <div className="alerts__header">
        <h2 className="alerts__title">Alertas</h2>
        {status !== 'loading' && status !== 'error' && (
          <button
            type="button"
            className="alerts__add"
            onClick={() => setCreating(true)}
          >
            Agregar alerta
          </button>
        )}
      </div>

      {status === 'error' && (
        <div role="alert" className="alerts__error">
          {loadError === 'corrupt'
            ? 'No se pudieron leer los datos guardados de las alertas.'
            : 'No se pudieron cargar las alertas.'}
          <div className="alerts__error-actions">
            {loadError === 'corrupt' && (
              <button
                type="button"
                className="alerts__retry"
                onClick={() => void alerts.reset()}
              >
                Restablecer alertas
              </button>
            )}
            <button
              type="button"
              className="alerts__retry"
              onClick={alerts.retry}
            >
              Reintentar
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

      <div className="table-scroll">
        <table
          className="data-table alerts__table"
          aria-busy={status === 'loading'}
        >
          <caption className="alerts__caption">
            Alertas de precio evaluadas con la fuente simulada en vivo
          </caption>
          <thead>
            <tr>
              <th scope="col">Alerta</th>
              <th scope="col">Dirección</th>
              <th scope="col" className="alerts__num">
                Umbral
              </th>
              <th scope="col">Estado</th>
              <th scope="col">Creada</th>
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {status === 'loading' && (
              <tr>
                <td colSpan={6} role="status" className="alerts__placeholder">
                  Cargando alertas…
                </td>
              </tr>
            )}
            {status === 'empty' && (
              <tr>
                <td colSpan={6} role="status" className="alerts__placeholder">
                  Todavía no hay alertas.
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
      </div>
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
      <td>{alert.direction === 'above' ? 'Por encima' : 'Por debajo'}</td>
      <td className="alerts__num">
        {formatPrice(alert.thresholdPrice, instrument.currency)}
      </td>
      <td>
        <span className="alerts__badge" data-status={alert.status}>
          {formatAlertStatus(alert.status)}
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
            Reconocer alerta de {instrument.symbol}
          </button>
        )}
        <button
          type="button"
          className="alerts__action alerts__action--danger"
          onClick={onDelete}
        >
          Eliminar alerta de {instrument.symbol}
        </button>
      </td>
    </tr>
  )
}

function formatAlertStatus(
  status: UseAlertsResult['alerts'][number]['status'],
): string {
  switch (status) {
    case 'active':
      return 'Activa'
    case 'triggered':
      return 'Activada'
    case 'acknowledged':
      return 'Reconocida'
  }
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
      className="alerts__form form-grid"
      aria-label="Agregar alerta"
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div className="alerts__field">
        <label htmlFor="alert-instrument">Instrumento</label>
        <select
          id="alert-instrument"
          value={instrumentId}
          onChange={(event) => setInstrumentId(event.target.value)}
          required
        >
          <option value="" disabled>
            Seleccionar un instrumento
          </option>
          {instruments.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.symbol} — {instrument.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="alerts__field">
        <label htmlFor="alert-direction">Dirección</label>
        <select
          id="alert-direction"
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as AlertDirection)
          }
        >
          <option value="above">Por encima</option>
          <option value="below">Por debajo</option>
        </select>
      </div>

      <div className="alerts__field">
        <label htmlFor="alert-threshold">Precio umbral</label>
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
            El umbral debe ser mayor que cero.
          </p>
        )}
      </div>

      {operationError && (
        <p role="alert" className="alerts__field-error">
          No se pudo completar la operación de alertas.
        </p>
      )}

      <div className="alerts__form-actions">
        <button type="submit" className="alerts__save">
          Guardar alerta
        </button>
        <button type="button" className="alerts__cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  )
}
