import { useEffect, useRef, useState } from 'react'
import { ActivationDialog } from './LifecycleDialogs.tsx'
import { parseSpecText } from '../domain/strategy-spec.ts'
import type {
  StrategyApi,
  StrategyEntry,
} from '../infrastructure/strategy-api.ts'

interface Props {
  api: StrategyApi | null
  onClose: () => void
  onCreated: (entry: StrategyEntry) => void
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Pasting a `balancita-strategy.v1` JSON adds it to the registry as a new draft. */
export function NewStrategyModal({ api, onClose, onCreated }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Nothing runs in the real paper unless the user decides so: unchecked by default, and confirmed on submit.
  const [activate, setActivate] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    area.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (confirmed = false) => {
    if (activate && !confirmed) {
      const { spec: parsed, error: problem } = parseSpecText(text)
      if (!parsed) return setError(problem ?? 'JSON inválido.')
      return setConfirming(true)
    }
    setConfirming(false)
    const { spec, error: parseError } = parseSpecText(text)
    if (!spec) return setError(parseError ?? 'JSON inválido.')
    if (!api) return setError('El registro de estrategias no está conectado.')
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.importSpec(spec, activate))
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

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
        aria-labelledby="new-strategy-title"
      >
        <h2 id="new-strategy-title">Nueva estrategia</h2>
        <label htmlFor="new-strategy-json" className="strategy-lab__context">
          Pegá el JSON de la estrategia (balancita-strategy.v1). Se agrega al
          registro.
        </label>
        <textarea
          id="new-strategy-json"
          ref={area}
          className="strategy-lab__json"
          value={text}
          rows={14}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
        />
        <label className="strategy-lab__context">
          <input
            type="checkbox"
            checked={activate}
            onChange={(event) => setActivate(event.target.checked)}
          />{' '}
          Activar en el paper real al agregarla (100 USD por operación, sin
          dinero real; te pedimos confirmar)
        </label>
        {error && (
          <p
            role="alert"
            className="strategy-lab__notice strategy-lab__notice--warn"
          >
            {error}
          </p>
        )}
        <div className="strategy-lab__row-actions">
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--primary"
            onClick={() => void submit()}
            disabled={busy || text.trim() === ''}
          >
            Agregar estrategia
          </button>
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--ghost"
            onClick={onClose}
          >
            Cancelar
          </button>
        </div>
      </div>
      {confirming && (
        <ActivationDialog
          name="la estrategia nueva"
          passed={false}
          busy={busy}
          onConfirm={() => void submit(true)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
