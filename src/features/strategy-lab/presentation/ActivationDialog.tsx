import { NOT_PASSED_WARNING } from '../domain/lifecycle-text.ts'
import ModalFrame from './ModalFrame.tsx'
import {
  MODAL_ACTIONS,
  MODAL_BUTTON,
  MODAL_HINT,
  MODAL_NOTICE,
} from './modal-styles.ts'

/** Activating is always the user's decision; a version that did not pass the gate is warned about, never blocked. */
export default function ActivationDialog({
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
    <ModalFrame label={`Activar ${name}`} onClose={onClose}>
      <h2>Activar {name}</h2>
      <p className={MODAL_HINT}>
        Va a operar en el paper real, con 100 USD por operación y sin dinero
        real. Podés apagarla cuando quieras.
      </p>
      {passed === false && (
        <p role="alert" className={MODAL_NOTICE} data-tone="warn">
          {NOT_PASSED_WARNING}
        </p>
      )}
      {passed === true && (
        <p className={MODAL_NOTICE}>Esta versión pasó la prueba.</p>
      )}
      <div className={MODAL_ACTIONS}>
        <button type="button" className={MODAL_BUTTON} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className={MODAL_BUTTON}
          data-primary="true"
          disabled={busy || passed === null}
          onClick={onConfirm}
        >
          {passed === false ? 'Activar igual' : 'Activar'}
        </button>
      </div>
    </ModalFrame>
  )
}
