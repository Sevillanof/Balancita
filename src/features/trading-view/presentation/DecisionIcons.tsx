import { useState } from 'react'
import type { LookDecision } from '../../../app/terminal-lifecycle.ts'
import { Icon } from './LifecycleSteps.tsx'
import { TONE_RING, TONE_TEXT } from './step-tones.ts'

/**
 * The decisions of one look as the icons of the step strip, each ringed in its
 * tone. Passing the pointer over (or focusing) an icon says in words what that
 * step decided. `onHold` tells the chart's hover card that the pointer is on it.
 */
export default function DecisionIcons({
  steps,
  onHold,
}: {
  steps: readonly LookDecision[]
  onHold?: (held: boolean) => void
}) {
  const [shown, setShown] = useState<string | null>(null)
  const active = steps.find((step) => step.id === shown) ?? null
  return (
    <div
      className="pointer-events-auto relative flex flex-col items-center"
      data-testid="decision-icons"
      onPointerEnter={() => onHold?.(true)}
      onPointerLeave={() => {
        setShown(null)
        onHold?.(false)
      }}
    >
      <div className="flex gap-1">
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            className={`grid size-6 cursor-default place-items-center rounded-full border border-solid bg-surface-1 p-0 ${TONE_RING[step.tone]} focus-visible:outline-2 focus-visible:outline-info`}
            aria-label={`${step.label}: ${step.headline}`}
            data-decision={step.id}
            data-tone={step.tone}
            onPointerEnter={() => setShown(step.id)}
            onFocus={() => setShown(step.id)}
            onBlur={() => setShown(null)}
          >
            <Icon name={step.icon} />
          </button>
        ))}
      </div>
      {active && (
        <div
          role="status"
          data-testid="decision-tip"
          className="absolute top-full z-5 mt-1.5 w-max max-w-56 rounded-lg border border-solid border-line bg-surface-1 px-2.5 py-1.5 text-label"
        >
          <strong className={TONE_TEXT[active.tone]}>{active.label}</strong>
          <span className="block text-ink-2">{active.headline}</span>
        </div>
      )}
    </div>
  )
}
