import { useEffect, useState } from 'react'
import type {
  DeletePreview,
  PurgeStatus,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import { describeFailure } from './describe-failure.ts'
import ModalFrame from './ModalFrame.tsx'
import {
  MODAL_ACTIONS,
  MODAL_BUTTON,
  MODAL_HINT,
  MODAL_NOTICE,
} from './modal-styles.ts'

type Props = {
  api: StrategyApi
  id: string
  name: string
  onClose: () => void
  onDeleted: (status: PurgeStatus) => void
}

/** «¿Está seguro?»: Cancelar o Aceptar. A strategy that is operating cannot be deleted. */
export default function DeleteStrategyDialog({
  api,
  id,
  name,
  onClose,
  onDeleted,
}: Props) {
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.deletePreview(id).then(
      (loaded) => alive && setPreview(loaded),
      (failure: unknown) => alive && setError(describeFailure(failure)),
    )
    return () => {
      alive = false
    }
  }, [api, id])

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      onDeleted(await api.deleteStrategy(id, id))
    } catch (failure) {
      setError(describeFailure(failure))
      setBusy(false)
    }
  }

  const operating = preview?.operating === true
  const blocked = preview?.blocked === true
  return (
    <ModalFrame label={`Eliminar ${name}`} onClose={onClose}>
      {operating ? (
        <p>
          «{name}» está operando en el paper. Primero apagala y después podés
          borrarla.
        </p>
      ) : blocked ? (
        <p>
          «{name}» no se puede borrar ahora: Qwen la está usando como entrada.
        </p>
      ) : (
        <p>¿Está seguro que quiere eliminar «{name}»?</p>
      )}
      {preview && !operating && !blocked && (
        <p className={MODAL_HINT}>
          Se borra todo lo suyo: versiones, pruebas y resultados. El examen que
          ya rindió queda anotado para que no se pueda repetir.
        </p>
      )}
      {error && (
        <p role="alert" className={MODAL_NOTICE} data-tone="warn">
          {error}
        </p>
      )}
      <div className={MODAL_ACTIONS}>
        <button type="button" className={MODAL_BUTTON} onClick={onClose}>
          {operating || blocked ? 'Cerrar' : 'Cancelar'}
        </button>
        {!operating && !blocked && (
          <button
            type="button"
            className={MODAL_BUTTON}
            data-danger="true"
            disabled={busy || !preview}
            onClick={() => void accept()}
          >
            Aceptar
          </button>
        )}
      </div>
    </ModalFrame>
  )
}
