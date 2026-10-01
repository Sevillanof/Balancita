import { useRef, useState, type FormEvent } from 'react'
import { isRun, type Run } from './replay-run-contract.ts'

export default function ReplayRunForm({
  getSelectionRevision,
  onRunCreated,
}: {
  getSelectionRevision: () => number
  onRunCreated: (run: Run, selectionRevision: number) => void
}) {
  const submitRequest = useRef(0)
  const [owner, setOwner] = useState<'typescript-native' | 'python-ledger'>(
    'typescript-native',
  )
  const [strategy, setStrategy] = useState('micro-trend-pullback')
  const [startUtc, setStartUtc] = useState('')
  const [endUtc, setEndUtc] = useState('')
  const [initialCash, setInitialCash] = useState('30')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    const current = ++submitRequest.current
    const selectionRevision = getSelectionRevision()
    const utcEpoch = (value: string) => {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) return null
      const timestamp = Date.parse(value)
      return Number.isSafeInteger(timestamp) &&
        new Date(timestamp).toISOString().replace('.000Z', 'Z') === value
        ? timestamp
        : null
    }
    const start = utcEpoch(startUtc)
    const end = utcEpoch(endUtc)
    const cash = Number(initialCash)
    if (
      ![
        'micro-trend-pullback',
        'micro-bollinger-reversion',
        'micro-donchian-breakout',
        'micro-regime-adapter',
      ].includes(strategy) ||
      start === null ||
      end === null ||
      end < start ||
      !Number.isFinite(cash) ||
      cash <= 0
    ) {
      setError(
        'Ingresá una ventana UTC ISO 8601 válida y ordenada, y un capital inicial positivo.',
      )
      return
    }
    const body = {
      strategy_id: strategy,
      start_time: start,
      end_time: end,
      ticket_eur: cash,
    }
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(
        owner === 'typescript-native'
          ? '/api/replay/fast-run'
          : '/api/replay/python-ledger-run',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error(
          'No se pudo verificar la respuesta del servidor. Revisá el historial antes de volver a enviar esta solicitud.',
        )
      }
      if (current !== submitRequest.current) return
      if (
        !response.ok ||
        !isRun(payload) ||
        payload.strategyId !== strategy ||
        (owner === 'typescript-native'
          ? payload.ledgerOwner === 'python-ledger'
          : payload.ledgerOwner !== 'python-ledger')
      ) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof payload.error === 'object' &&
          payload.error !== null &&
          'message' in payload.error &&
          typeof payload.error.message === 'string'
            ? payload.error.message
            : 'No se pudo verificar el resultado del replay.'
        throw new Error(
          `${message} Revisá el historial antes de volver a enviar esta solicitud.`,
        )
      }
      onRunCreated(payload, selectionRevision)
    } catch (cause) {
      if (current === submitRequest.current) {
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : 'No se pudo verificar el resultado del replay.'
        setError(
          message.includes('Revisá el historial')
            ? message
            : `${message} Revisá el historial antes de volver a enviarlo.`,
        )
      }
    } finally {
      if (current === submitRequest.current) setSubmitting(false)
    }
  }

  return (
    <section
      className="demo-history__panel demo-history__form historical-connected-form"
      aria-label="Nueva prueba histórica"
    >
      <h2>Nueva prueba histórica</h2>
      <p>
        Usa velas BTC-EUR de 1 minuto ya almacenadas; el motor agrupa
        internamente en velas de 15 minutos. Los horarios deben incluir Z (UTC).
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Motor
          <select
            value={owner}
            onChange={(event) => setOwner(event.target.value as typeof owner)}
          >
            <option value="typescript-native">TypeScript nativo</option>
            <option value="python-ledger">
              Ledger Python híbrido · señales TypeScript
            </option>
          </select>
        </label>
        <label>
          Estrategia
          <select
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
          >
            <option value="micro-trend-pullback">Tendencia: retroceso</option>
            <option value="micro-bollinger-reversion">
              Reversión: Bollinger
            </option>
            <option value="micro-donchian-breakout">Ruptura: Donchian</option>
            <option value="micro-regime-adapter">Adaptador de régimen</option>
          </select>
        </label>
        <label>
          Inicio UTC (ISO 8601)
          <input
            required
            value={startUtc}
            onChange={(event) => setStartUtc(event.target.value)}
            placeholder="2025-01-01T00:00:00Z"
          />
        </label>
        <label>
          Fin UTC (ISO 8601)
          <input
            required
            value={endUtc}
            onChange={(event) => setEndUtc(event.target.value)}
            placeholder="2025-01-02T00:00:00Z"
          />
        </label>
        <label>
          Capital inicial (EUR)
          <input
            required
            type="number"
            min="0.01"
            step="any"
            value={initialCash}
            onChange={(event) => setInitialCash(event.target.value)}
          />
        </label>
        <p>
          Capital inicial del ledger seleccionado (
          {owner === 'typescript-native'
            ? 'cash-all-in.v1'
            : 'python-long-flat-ledger.v1'}
          ). Comisión y deslizamiento se informan solo cuando constan en el
          resultado almacenado.
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting
            ? 'Ejecutando…'
            : `Ejecutar replay ${owner === 'typescript-native' ? 'TypeScript' : 'Python ledger'}`}
        </button>
      </form>
    </section>
  )
}
