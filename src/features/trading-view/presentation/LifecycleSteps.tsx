import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  madridTime,
  type LifecycleStep,
  type LifecycleView,
  type StepIcon,
  type StepCheck,
  type StepTone,
  type TradeJudgment,
  type TradeMark,
} from '../../../app/terminal-lifecycle.ts'

const TONE_RING: Record<StepTone, string> = {
  ok: 'border-long text-long',
  no: 'border-short text-short',
  warn: 'border-warn text-warn',
  info: 'border-info text-info',
  na: 'border-line-strong text-ink-2',
}

const TONE_FILL: Record<StepTone, string> = {
  ok: 'bg-long',
  no: 'bg-short',
  warn: 'bg-warn',
  info: 'bg-info',
  na: 'bg-line-strong',
}

const TONE_TEXT: Record<StepTone, string> = {
  ok: 'text-long',
  no: 'text-short',
  warn: 'text-warn',
  info: 'text-info',
  na: 'text-ink-2',
}

const TONE_WORD: Record<StepTone, string> = {
  ok: 'pasa',
  no: 'frena',
  warn: 'atención',
  info: 'en curso',
  na: 'no aplica',
}

const PATHS: Record<StepIcon, ReactNode> = {
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  master: (
    <>
      <path d="M3 17l5-6 4 3 8-9" />
      <path d="M15 5h5v5" />
    </>
  ),
  gate: (
    <>
      <path d="M4 21V8l8-5 8 5v13" />
      <path d="M9 21v-7h6v7" />
    </>
  ),
  news: (
    <>
      <path d="M4 5h13v14H6a2 2 0 0 1-2-2z" />
      <path d="M17 9h3v8a2 2 0 0 1-2 2" />
      <path d="M8 9h5M8 13h5" />
    </>
  ),
  enter: (
    <>
      <path d="M5 12h12M12 6l6 6-6 6" />
      <path d="M20 4v16" />
    </>
  ),
  flip: (
    <>
      <path d="M7 4v13M3 13l4 4 4-4" />
      <path d="M17 20V7m-4 4l4-4 4 4" />
    </>
  ),
  clock12: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  clock24: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5h5" />
    </>
  ),
  cap: <path d="M5 3h14M5 21h14M7 3c0 6 10 6 10 18M17 3c0 12-10 12-10 18" />,
  maker: (
    <>
      <path d="M4 7h16M4 12h10M4 17h6" />
      <path d="M17 14l3 3-3 3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3v18M7 21h10M5 7h14" />
      <path d="M5 7l-3 7a3 3 0 0 0 6 0z" />
      <path d="M19 7l-3 7a3 3 0 0 0 6 0z" />
    </>
  ),
}

function Icon({ name }: { name: StepIcon }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

const AUDITOR_LABEL: Record<Exclude<StepCheck['source'], '30min'>, string> = {
  auditor_12h: 'Auditor a 12 h (provisorio)',
  auditor_24h: 'Auditor a 24 h (provisorio)',
  auditor_36h: 'Auditor a 36 h (definitivo)',
}

function checkText(check: StepCheck): string {
  const when = madridTime(check.atMs)
  if (check.source !== '30min') {
    const said = check.text ?? 'sin detalle'
    const outcome =
      check.state === 'right'
        ? 'acertó'
        : check.state === 'wrong'
          ? 'falló'
          : 'regla fija, no se juzga'
    return `${when} · ${AUDITOR_LABEL[check.source]}: ${said} · ${outcome}`
  }
  if (check.state === 'none')
    return `${when} · este paso no opinó sobre el precio`
  if (check.state === 'pending') return `${when} · todavía no pasaron 30 min`
  const move =
    check.moveBp === null
      ? ''
      : `${check.moveBp >= 0 ? '+' : '−'}${Math.abs(check.moveBp).toFixed(0)} pb`
  return `${when} · A 30 min: ${move} · ${check.state === 'right' ? 'acertó' : 'falló'} (hasta que el auditor resuelva a las 12 h)`
}

const CHECK_FILL: Record<StepCheck['state'], string> = {
  right: 'bg-long',
  wrong: 'bg-short',
  pending: 'bg-line-strong',
  none: 'bg-line',
}

const MARK_FILL: Record<TradeMark['state'], string> = {
  right: 'bg-long',
  wrong: 'bg-short',
  pending: 'bg-line-strong',
  none: 'bg-line',
}

/** A provisional verdict (12 or 24 h) is a hollow bar in the colour of its verdict. */
const MARK_OUTLINE: Record<TradeMark['state'], string> = {
  right: 'border-long',
  wrong: 'border-short',
  pending: 'border-line-strong',
  none: 'border-line',
}

const MARK_WORD: Record<TradeMark['state'], string> = {
  right: 'acertó',
  wrong: 'falló',
  pending: 'todavía no',
  none: 'sin juicio',
}

/** «−12,9»: a signed amount with a comma and a real minus sign. */
function signed(value: number, digits: number): string {
  const body = Math.abs(value).toFixed(digits).replace('.', ',')
  return value < 0 ? `−${body}` : `+${body}`
}

function markPhrase(label: string, mark: TradeMark): string {
  const said =
    mark.state === 'right' || mark.state === 'wrong'
      ? ` (${mark.text}${mark.provisional ? ', provisorio' : ''})`
      : ''
  return `${label} ${MARK_WORD[mark.state]}${said}`
}

function judgmentText(j: TradeJudgment): string {
  const side = j.side === 'LONG' ? 'largo' : 'corto'
  const net =
    j.netUsd === null
      ? 'neto sin dato'
      : j.open
        ? `abierta, ahora ${signed(j.netUsd, 1)} USD`
        : `neto ${signed(j.netUsd, 1)} USD`
  return `#${j.tradeNo} ${side} · ${markPhrase('entrada', j.entrada)} · ${markPhrase('salida', j.salida)} · ${net} · clic: ir a la operación`
}

/** One bar of a ficha; the provisional verdict (12 or 24 h) is drawn hollow. */
function MarkBar({ mark }: { mark: TradeMark }) {
  return (
    <i
      data-state={mark.state}
      data-provisional={mark.provisional ? 'true' : undefined}
      className={`block h-1.5 w-full rounded-sm ${mark.provisional ? `border border-solid bg-transparent ${MARK_OUTLINE[mark.state]}` : MARK_FILL[mark.state]}`}
    />
  )
}

/**
 * One operation as a small card: the entry verdict on top, the exit verdict
 * below and the net between them. A click goes to that operation.
 */
function Ficha({
  judgment,
  onJumpTrade,
}: {
  judgment: TradeJudgment
  onJumpTrade: ((id: string, entryMs: number) => void) | undefined
}) {
  const text = judgmentText(judgment)
  const net = judgment.open ? null : judgment.netUsd
  return (
    <button
      type="button"
      title={text}
      aria-label={text}
      onClick={() => onJumpTrade?.(judgment.id, judgment.entryMs)}
      className="grid w-7 cursor-pointer justify-items-center gap-0.5 border-0 bg-transparent p-0"
    >
      <span className="flex h-7.5 w-5.5 flex-col justify-between rounded-sm border border-solid border-line bg-surface-2 p-0.5">
        <MarkBar mark={judgment.entrada} />
        <span
          className={`text-center text-label leading-none tabular-nums ${net === null || Math.round(net) === 0 ? 'text-ink-2' : net > 0 ? 'text-long' : 'text-short'}`}
        >
          {net === null ? '·' : Math.round(net) === 0 ? '0' : signed(net, 0)}
        </span>
        <MarkBar mark={judgment.salida} />
      </span>
      <span className="text-label text-ink-2">#{judgment.tradeNo}</span>
    </button>
  )
}

function Detail({
  step,
  evaluatedMs,
  onJump,
  onJumpTrade,
}: {
  step: LifecycleStep
  evaluatedMs: number
  onJump: ((ms: number) => void) | undefined
  onJumpTrade: ((id: string, entryMs: number) => void) | undefined
}) {
  const judgments = step.judgments ?? []
  const flat = step.flatJudgments ?? []
  return (
    <div
      role="dialog"
      aria-label={`${step.label}: última evaluación`}
      className="absolute top-popover right-0 z-20 grid w-72 gap-2 rounded-lg border border-solid border-line-strong bg-surface-1 p-3 text-hint shadow-popover"
    >
      <div className="flex items-center gap-2">
        <span className={TONE_TEXT[step.tone]}>
          <Icon name={step.icon} />
        </span>
        <strong className="text-body font-semibold text-ink">
          {step.label}
        </strong>
        <span
          className={`ml-auto rounded-full border border-solid px-2 text-badge ${TONE_RING[step.tone]}`}
        >
          {step.word ?? TONE_WORD[step.tone]}
        </span>
      </div>
      <p className="m-0 text-ink">{step.headline}</p>
      {step.meter && (
        <div className="grid gap-1">
          <div
            className="relative h-1.5 rounded-sm bg-line"
            role="meter"
            aria-label={step.meter.caption}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(step.meter.value * 100)}
          >
            <div
              className={`h-1.5 rounded-sm ${TONE_FILL[step.tone]}`}
              style={{ width: `${Math.round(step.meter.value * 100)}%` }}
            />
            {step.meter.mark !== null && (
              <div
                className="absolute -top-0.5 h-2.5 w-0.5 bg-ink-2"
                style={{ left: `${Math.round(step.meter.mark * 100)}%` }}
              />
            )}
          </div>
          <span className="text-label text-ink-2">{step.meter.caption}</span>
        </div>
      )}
      <dl className="m-0 grid gap-1">
        {step.rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-3">
            <dt className="text-ink-2">{row.label}</dt>
            <dd className="m-0 text-right text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
      {step.history.length > 1 && (
        <div className="grid gap-1">
          <span className="text-label text-ink-2">
            Últimas {step.history.length} miradas
          </span>
          <div className="flex gap-0.5" role="img" aria-label="Historial">
            {step.history.map((tone, index) => (
              <i
                key={index}
                className={`h-2 w-2 rounded-sm ${TONE_FILL[tone]}`}
              />
            ))}
          </div>
        </div>
      )}
      {step.checks && step.checks.length > 1 && (
        <div className="grid gap-1">
          <span className="text-label text-ink-2">Decisión óptima</span>
          <div className="flex gap-0.5">
            {step.checks.map((check) => (
              <button
                key={check.atMs}
                type="button"
                title={checkText(check)}
                aria-label={`Ir a la mirada: ${checkText(check)}`}
                onClick={() => onJump?.(check.atMs)}
                className="grid h-4 w-4 cursor-pointer place-items-center border-0 bg-transparent p-0"
              >
                <i
                  className={`h-2.5 w-2.5 rounded-full ${CHECK_FILL[check.state]}`}
                />
              </button>
            ))}
          </div>
          <span className="text-label text-ink-2">
            Verde acertó, rojo falló, gris todavía no se sabe. A los 30 min mide
            el precio; a las 12, 24 y 36 h el auditor pone el veredicto real
            (qué habría pasado con la operación completa).
          </span>
        </div>
      )}
      {step.judgments && judgments.length > 0 && (
        <div className="grid gap-1">
          <span className="text-label text-ink-2">Operaciones juzgadas</span>
          <div className="flex gap-1" role="group" aria-label="Operaciones">
            {judgments.map((judgment) => (
              <Ficha
                key={judgment.id}
                judgment={judgment}
                onJumpTrade={onJumpTrade}
              />
            ))}
          </div>
        </div>
      )}
      {step.judgments && flat.length > 0 && (
        <div className="grid gap-1">
          <span className="text-label text-ink-2">Miradas sin operación</span>
          <div className="flex gap-0.5">
            {flat.map((check) => (
              <button
                key={check.atMs}
                type="button"
                title={checkText(check)}
                aria-label={`Ir a la mirada: ${checkText(check)}`}
                onClick={() => onJump?.(check.atMs)}
                className="grid h-4 w-4 cursor-pointer place-items-center border-0 bg-transparent p-0"
              >
                <i
                  className={`h-2.5 w-2.5 rounded-full ${CHECK_FILL[check.state]}`}
                />
              </button>
            ))}
          </div>
        </div>
      )}
      {step.judgments && (judgments.length > 0 || flat.length > 0) && (
        <span className="text-label text-ink-2">
          Arriba la entrada, abajo la salida: verde acertó, rojo falló, gris
          todavía no. Clic en una ficha lleva a esa operación. Barra hueca:
          veredicto provisorio (12 o 24 h).
        </span>
      )}
      <p className="m-0 border-0 border-t border-solid border-line pt-2 text-label text-ink-2">
        {step.rule}
      </p>
      <span className="text-label text-ink-2">
        Mirada de las {madridTime(evaluatedMs)} (hora de Madrid)
      </span>
    </div>
  )
}

/**
 * The steps of the cycle as a strip of round icons joined by a line: the entry
 * steps while nothing is open, the exit rules while an operation is. A click
 * opens the last evaluation of that step.
 */
export default function LifecycleSteps({
  view,
  onJump,
  onJumpTrade,
}: {
  view: LifecycleView
  onJump?: (ms: number) => void
  onJumpTrade?: (id: string, entryMs: number) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openId === null) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenId(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openId])
  // A phase change (an operation opens or closes) drops the old popover.
  const [phase, setPhase] = useState(view.phase)
  if (phase !== view.phase) {
    setPhase(view.phase)
    setOpenId(null)
  }
  const open = view.steps.find((step) => step.id === openId) ?? null
  return (
    <div
      ref={root}
      className="relative ml-auto flex flex-none items-center gap-2"
      role="group"
      aria-label={
        view.phase === 'entry'
          ? 'Pasos para entrar a una operación'
          : 'Pasos para salir de la operación'
      }
    >
      <span className="text-badge tracking-eyebrow text-ink-2 uppercase">
        {view.phase === 'entry' ? 'Entrar' : 'Salir'}
      </span>
      <div className="flex items-center">
        {view.steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            {index > 0 && <span className="h-0.5 w-3 bg-line-strong" />}
            <button
              type="button"
              title={step.label}
              aria-label={`${step.label}: ${step.headline}`}
              aria-expanded={openId === step.id}
              onClick={() => setOpenId(openId === step.id ? null : step.id)}
              className={`grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 border-solid bg-surface-2 p-0 ${TONE_RING[step.tone]} ${openId === step.id ? 'ring-2 ring-line-focus' : ''}`}
            >
              <Icon name={step.icon} />
            </button>
          </div>
        ))}
      </div>
      {open && (
        <Detail
          step={open}
          evaluatedMs={view.evaluatedMs}
          onJump={onJump}
          onJumpTrade={onJumpTrade}
        />
      )}
    </div>
  )
}
