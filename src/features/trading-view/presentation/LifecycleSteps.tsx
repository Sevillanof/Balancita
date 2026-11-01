import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  madridTime,
  type LifecycleStep,
  type LifecycleView,
  type StepIcon,
  type StepTone,
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

function Detail({
  step,
  evaluatedMs,
}: {
  step: LifecycleStep
  evaluatedMs: number
}) {
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
export default function LifecycleSteps({ view }: { view: LifecycleView }) {
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
      {open && <Detail step={open} evaluatedMs={view.evaluatedMs} />}
    </div>
  )
}
