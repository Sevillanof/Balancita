import { useEffect, useState } from 'react'
import { usd, utcTime } from '../../../shared/finance/format.ts'
import {
  NOT_PASSED_WARNING,
  formatActiveTime,
} from '../domain/lifecycle-text.ts'
import type {
  DeletePreview,
  PurgeStatus,
} from '../infrastructure/strategy-api.ts'

function Backdrop({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="strategy-lab__modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="strategy-lab__modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  )
}

/** Activating is always the user's decision; a version that did not pass the gate is warned about, never blocked. */
export function ActivationDialog({
  name,
  passed,
  busy,
  onConfirm,
  onClose,
}: {
  name: string
  /** `null` while it is still being checked. */
  passed: boolean | null
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Backdrop label={`Activar ${name}`} onClose={onClose}>
      <h2>Activar {name}</h2>
      <p className="strategy-lab__context">
        Va a operar en el paper real, con 100 USD por operación y sin dinero
        real. Podés desactivarla cuando quieras.
      </p>
      {passed === false && (
        <p
          role="alert"
          className="strategy-lab__notice strategy-lab__notice--warn"
        >
          {NOT_PASSED_WARNING}
        </p>
      )}
      {passed === true && (
        <p className="strategy-lab__notice">Esta versión pasó la prueba.</p>
      )}
      <div className="strategy-lab__row-actions">
        <button
          type="button"
          className="strategy-lab__button strategy-lab__button--primary"
          disabled={busy || passed === null}
          onClick={onConfirm}
        >
          {passed === false ? 'Activar igual' : 'Activar'}
        </button>
        <button
          type="button"
          className="strategy-lab__button strategy-lab__button--ghost"
          onClick={onClose}
        >
          Cancelar
        </button>
      </div>
    </Backdrop>
  )
}

const STATE_TEXT: Record<string, string> = {
  draft: 'borrador',
  shadow: 'en observación',
  active: 'activa',
  retired: 'desactivada',
}

/** Everything that goes away with the strategy, then the typed name. */
export function DeleteDialog({
  preview,
  busy,
  onConfirm,
  onClose,
}: {
  preview: DeletePreview
  busy: boolean
  onConfirm: (typed: string) => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const versions = preview.versions.map((v) => `v${v.version}`).join(', ')
  const exam = preview.exam
  return (
    <Backdrop label={`Borrar ${preview.name}`} onClose={onClose}>
      <h2>Borrar {preview.name}</h2>
      <dl className="strategy-lab__plan">
        <dt>Id</dt>
        <dd>{preview.id}</dd>
        <dt>Versiones</dt>
        <dd>{versions}</dd>
        <dt>Estado</dt>
        <dd>{STATE_TEXT[preview.state] ?? preview.state}</dd>
        <dt>Tiempo activa en paper</dt>
        <dd>{formatActiveTime(preview.active_ms)}</dd>
        <dt>Creada</dt>
        <dd>{utcTime(preview.created_at / 1000)}</dd>
        <dt>Operaciones en paper</dt>
        <dd>
          {preview.forward_trades === 0
            ? 'ninguna'
            : `${preview.forward_trades} · resultado ${usd(preview.forward_net_usd)}`}
        </dd>
        <dt>Pruebas hechas</dt>
        <dd>{preview.gate_runs}</dd>
        <dt>Examen final</dt>
        <dd>
          {exam.taken
            ? `rendido el ${exam.date}: ${exam.verdict}`
            : 'no se rindió'}
        </dd>
      </dl>
      <p
        role="alert"
        className="strategy-lab__notice strategy-lab__notice--warn"
      >
        Se borrará todo lo relacionado con esta estrategia. No se puede
        deshacer.
      </p>
      {preview.ledger_kept && (
        <p className="strategy-lab__context">
          Excepción: sus operaciones de paper ya registradas se conservan,
          porque el registro contable de paper no se borra.
        </p>
      )}
      {preview.warnings.map((warning) => (
        <p key={warning} className="strategy-lab__context">
          {warning}
        </p>
      ))}
      {preview.blocked && (
        <p
          role="alert"
          className="strategy-lab__notice strategy-lab__notice--warn"
        >
          Qwen (C31) la está usando como entrada: no se puede borrar mientras
          esté encendido.
        </p>
      )}
      <label className="strategy-lab__context" htmlFor="delete-confirm">
        Para confirmar escribí el nombre de la estrategia
      </label>
      <input
        id="delete-confirm"
        aria-label="Escribí el nombre para confirmar"
        placeholder={preview.name}
        value={typed}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
      />
      <div className="strategy-lab__row-actions">
        <button
          type="button"
          className="strategy-lab__button strategy-lab__button--primary"
          disabled={
            busy ||
            preview.blocked ||
            (typed !== preview.name && typed !== preview.id)
          }
          onClick={() => onConfirm(typed)}
        >
          Borrar definitivamente
        </button>
        <button
          type="button"
          className="strategy-lab__button strategy-lab__button--ghost"
          onClick={onClose}
        >
          Cancelar
        </button>
      </div>
    </Backdrop>
  )
}

const CONSUMER_TEXT: Record<string, string> = {
  forward: 'medición en paper',
}

/** "Borrando…" while another process still deletes its own rows, "listo" afterwards. */
export function PurgeNotice({
  name,
  status,
}: {
  name: string
  status: PurgeStatus
}) {
  const pending = Object.entries(status.consumers)
    .filter(([, value]) => value === 'pending')
    .map(([key]) => CONSUMER_TEXT[key] ?? key)
  return (
    <p role="status" className="strategy-lab__notice">
      {status.state === 'done'
        ? `Listo: ${name} se borró por completo.`
        : `Borrando ${name}…${pending.length ? ` Falta: ${pending.join(', ')}.` : ''}`}
    </p>
  )
}
