import { useEffect, useRef, useState } from 'react'
import { sameRules } from '../domain/spec-compare.ts'
import { parseSpecText, type StrategySpec } from '../domain/strategy-spec.ts'
import type { StrategyApi } from '../infrastructure/strategy-api.ts'
import ModalFrame from './ModalFrame.tsx'
import { describeFailure } from './describe-failure.ts'

type Props = {
  api: StrategyApi
  /** `null` creates a strategy; an id edits that one. */
  strategyId: string | null
  onClose: () => void
  /** Called with the id to select and a one-line result for the notice. */
  onSaved: (id: string, notice: string) => void
}

/**
 * Create or modify a strategy without leaving Estrategias: a title and the
 * strategy's JSON. Changing only the title is a rename; changing the JSON
 * saves a new version, so its tests start again from zero.
 */
export default function StrategyEditorModal({
  api,
  strategyId,
  onClose,
  onSaved,
}: Props) {
  const creating = strategyId === null
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [original, setOriginal] = useState<{
    spec: StrategySpec
    title: string
  } | null>(null)
  const [loading, setLoading] = useState(!creating)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (strategyId === null) return
    let alive = true
    api.detail(strategyId).then(
      (detail) => {
        if (!alive) return
        setOriginal({ spec: detail.spec, title: detail.name })
        setTitle(detail.name)
        setText(JSON.stringify(detail.spec, null, 2))
        setLoading(false)
      },
      (failure: unknown) => {
        if (!alive) return
        setError(describeFailure(failure))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [api, strategyId])

  useEffect(() => {
    if (!loading) first.current?.focus()
  }, [loading])

  const save = async () => {
    const { spec, error: problem } = parseSpecText(text)
    if (!spec) return setError(problem ?? 'El JSON no es válido.')
    const name = title.trim() || (creating ? spec.name?.trim() : '')
    if (!name) return setError('Poné un título para la estrategia.')
    setBusy(true)
    setError(null)
    try {
      if (strategyId === null) {
        const entry = await api.importSpec({ ...spec, name }, false)
        return onSaved(entry.id, `Se creó «${entry.name}» como borrador.`)
      }
      if (!original) return
      if (!sameRules(original.spec, spec)) {
        const entry = await api.save(
          { ...spec, id: strategyId, name },
          'modify',
        )
        return onSaved(
          entry.id,
          `Se guardó «${entry.name}» como versión ${entry.version}. Sus pruebas empiezan de cero.`,
        )
      }
      if (name !== original.title) {
        await api.rename(strategyId, name)
        return onSaved(strategyId, `Se cambió el título a «${name}».`)
      }
      onClose()
    } catch (failure) {
      setError(describeFailure(failure))
    } finally {
      setBusy(false)
    }
  }

  const label = creating ? 'Crear estrategia' : 'Modificar estrategia'
  return (
    <ModalFrame label={label} onClose={onClose} wide>
      <h2>{label}</h2>
      {loading ? (
        <p className="smodal__hint" role="status">
          Cargando la estrategia…
        </p>
      ) : (
        <>
          <p className="smodal__hint">
            {creating
              ? 'Poné un título y pegá el JSON de la estrategia que querés probar. Queda como borrador y se suma a la lista.'
              : 'Cambiar solo el título no toca nada más. Si cambiás el JSON se guarda como versión nueva y sus pruebas empiezan de cero.'}
          </p>
          <label className="smodal__field">
            Título
            <input
              ref={first}
              value={title}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => {
                setTitle(event.target.value)
                setError(null)
              }}
            />
          </label>
          <label className="smodal__field">
            JSON de la estrategia
            <textarea
              value={text}
              spellCheck={false}
              onChange={(event) => {
                setText(event.target.value)
                setError(null)
              }}
            />
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="smodal__notice" data-tone="warn">
          {error}
        </p>
      )}
      <div className="smodal__actions">
        <button type="button" className="smodal__button" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="smodal__button"
          data-primary="true"
          disabled={busy || loading || (creating && text.trim() === '')}
          onClick={() => void save()}
        >
          {creating ? 'Crear' : 'Guardar'}
        </button>
      </div>
    </ModalFrame>
  )
}
