import { VBT } from './vectorbt-styles.ts'
import { useEffect, useMemo, useState } from 'react'
import {
  isIntegerText,
  listVariables,
  type Variable,
} from '../domain/vectorbt-variation.ts'
import {
  MAX_VALUES,
  listValues,
  rangeValues,
  type ValueResult,
} from '../domain/vectorbt-values.ts'
import type { StrategySpec } from '../domain/strategy-spec.ts'
import type { VbtRequest } from '../infrastructure/vectorbt-api.ts'
import ModalFrame from './ModalFrame.tsx'
import {
  MODAL_ACTIONS,
  MODAL_BUTTON,
  MODAL_HINT,
  MODAL_NOTICE,
  MODAL_FIELD,
} from './modal-styles.ts'

type Props = {
  strategyName: string
  /** Intentos que la estrategia ya lleva en el registro de la familia; `null` si no se pudo leer. */
  attempts: number | null
  loadSpec: () => Promise<StrategySpec>
  /** Resolves when the exploration started; rejects with the server's Spanish message. */
  onLaunch: (request: VbtRequest) => Promise<void>
  onClose: () => void
}

type Mode = 'diagnostic' | 'variants'
type Source = 'range' | 'list'

/**
 * «Explorar con VectorBT»: the strategy as it is (diagnóstico) or changing ONE
 * thing between values you choose (variantes). Everything it gives back is a
 * hypothesis over practice data; the exam is never touched.
 */
export default function VectorbtModal({
  strategyName,
  attempts,
  loadSpec,
  onLaunch,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('diagnostic')
  const [variables, setVariables] = useState<Variable[] | null>(null)
  const [specError, setSpecError] = useState<string | null>(null)
  const [vary, setVary] = useState('')
  const [source, setSource] = useState<Source>('range')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [step, setStep] = useState('')
  const [list, setList] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The list of things to vary comes from the strategy's spec; it is only read when «Variantes» is chosen.
  useEffect(() => {
    if (mode !== 'variants' || variables !== null || specError !== null) return
    let alive = true
    loadSpec().then(
      (spec) => {
        if (!alive) return
        const found = listVariables(spec)
        setVariables(found)
        setVary(found[0]?.vary ?? '')
      },
      (failure: unknown) => {
        if (alive)
          setSpecError(
            failure instanceof Error ? failure.message : String(failure),
          )
      },
    )
    return () => {
      alive = false
    }
  }, [mode, variables, specError, loadSpec])

  const chosen = variables?.find((item) => item.vary === vary) ?? null
  const result: ValueResult | null = useMemo(() => {
    if (mode !== 'variants' || !chosen) return null
    const base =
      source === 'range' ? rangeValues(min, max, step) : listValues(list)
    if (base.error === null && chosen.integerOnly) {
      const bad = base.values.find((value) => !isIntegerText(value))
      if (bad !== undefined)
        return {
          values: [],
          count: base.count,
          error: `Esta condición solo admite números enteros (sin coma): ${bad.replace('.', ',')} no sirve.`,
        }
    }
    return base
  }, [mode, chosen, source, min, max, step, list])

  const typed =
    source === 'range' ? min + max + step !== '' : list.trim() !== ''
  const ready =
    mode === 'diagnostic' ||
    (chosen !== null && result !== null && result.error === null)

  const launch = async () => {
    setBusy(true)
    setError(null)
    try {
      await onLaunch(
        mode === 'diagnostic'
          ? { mode: 'diagnostic' }
          : { mode: 'variants', vary, values: result?.values ?? [] },
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <ModalFrame label="Explorar con VectorBT" onClose={onClose} wide>
      <h2>Explorar «{strategyName}» con VectorBT</h2>
      <p className={MODAL_HINT}>
        Una prueba rápida con un simulador aparte, para ver qué funciona y qué
        falla antes de gastar una prueba completa. Usa datos hasta el
        19-abr-2026: el examen queda intacto. Lo que sale son hipótesis, no un
        veredicto.
      </p>

      <fieldset className={VBT.choice}>
        <legend>¿Qué querés hacer?</legend>
        <label>
          <input
            type="radio"
            name="vbt-mode"
            checked={mode === 'diagnostic'}
            onChange={() => setMode('diagnostic')}
          />
          <span>
            <b>Diagnóstico</b>
            <small>La estrategia tal cual está, sin cambiar nada.</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="vbt-mode"
            checked={mode === 'variants'}
            onChange={() => setMode('variants')}
          />
          <span>
            <b>Variantes</b>
            <small>
              Cambiar una sola cosa entre varios valores y ver cuál rinde mejor.
            </small>
          </span>
        </label>
      </fieldset>

      {mode === 'variants' && (
        <div className={VBT.variants}>
          {specError && (
            <p role="alert" className={MODAL_NOTICE} data-tone="warn">
              No se pudo leer la estrategia: {specError}
            </p>
          )}
          {!specError && variables === null && (
            <p className={MODAL_HINT}>Leyendo la estrategia…</p>
          )}
          {variables !== null && variables.length === 0 && (
            <p className={MODAL_NOTICE} data-tone="warn">
              Esta estrategia no tiene números que se puedan variar.
            </p>
          )}
          {variables !== null && variables.length > 0 && (
            <>
              <label className={MODAL_FIELD}>
                ¿Qué querés cambiar?
                <select
                  value={vary}
                  onChange={(event) => setVary(event.target.value)}
                >
                  {variables.map((item) => (
                    <option key={item.vary} value={item.vary}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {chosen && (
                <p className={MODAL_HINT} data-testid="vbt-current">
                  {chosen.hint} Ahora vale{' '}
                  <b>{chosen.base.replace('.', ',')}</b>.
                </p>
              )}

              <fieldset className={VBT.choiceRow}>
                <legend>¿Entre qué valores?</legend>
                <label>
                  <input
                    type="radio"
                    name="vbt-source"
                    checked={source === 'range'}
                    onChange={() => setSource('range')}
                  />
                  <span>Un rango: mínimo, máximo y paso</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="vbt-source"
                    checked={source === 'list'}
                    onChange={() => setSource('list')}
                  />
                  <span>Una lista a mano</span>
                </label>
              </fieldset>

              {source === 'range' ? (
                <div className={VBT.range}>
                  <label className={MODAL_FIELD}>
                    Mínimo
                    <input
                      inputMode="decimal"
                      value={min}
                      onChange={(event) => setMin(event.target.value)}
                    />
                  </label>
                  <label className={MODAL_FIELD}>
                    Máximo
                    <input
                      inputMode="decimal"
                      value={max}
                      onChange={(event) => setMax(event.target.value)}
                    />
                  </label>
                  <label className={MODAL_FIELD}>
                    Paso
                    <input
                      inputMode="decimal"
                      value={step}
                      onChange={(event) => setStep(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <label className={MODAL_FIELD}>
                  Valores, separados por punto y coma
                  <input
                    value={list}
                    placeholder="1; 1,5; 2; 2,5"
                    onChange={(event) => setList(event.target.value)}
                  />
                </label>
              )}

              {typed && result && result.error && (
                <p role="alert" className={MODAL_NOTICE} data-tone="warn">
                  {result.error}
                </p>
              )}
              {result && result.error === null && (
                <p className={VBT.count} data-testid="vbt-count">
                  Saldrían <b>{result.count}</b>{' '}
                  {result.count === 1 ? 'variante' : 'variantes'} (máximo{' '}
                  {MAX_VALUES}):{' '}
                  {result.values.map((v) => v.replace('.', ',')).join(' · ')}
                </p>
              )}
              <p className={MODAL_HINT}>
                Una sola condición por vez: todo lo demás queda igual.{' '}
                {attempts !== null
                  ? `Llevás ${attempts} ${attempts === 1 ? 'intento' : 'intentos'} con esta estrategia y cada variante nueva suma uno: probar muchas hace más fácil que alguna salga bien por casualidad.`
                  : 'No se pudo leer cuántos intentos lleva la estrategia; cada variante nueva suma uno.'}
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className={MODAL_NOTICE} data-tone="warn">
          {error}
        </p>
      )}
      <div className={MODAL_ACTIONS}>
        <button type="button" className={MODAL_BUTTON} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className={MODAL_BUTTON}
          data-primary="true"
          disabled={!ready || busy}
          onClick={() => void launch()}
        >
          {busy ? 'Empezando…' : 'Explorar'}
        </button>
      </div>
    </ModalFrame>
  )
}
