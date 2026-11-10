import type {
  LifecycleStep,
  LifecycleView,
} from '../../../app/terminal-lifecycle.ts'

/**
 * The steps that decide whether an open operation closes: the maestro turning,
 * the 24 h exhaustion check, the 36 h cap, and the auditor that judges them.
 * The news expert, the rebound expert, the resting order and the emergency stay
 * out of the exit row (their detail lives in the operation's own dialog).
 */
const EXIT_ROW = new Set(['flip', 'exhaust24', 'cap', 'auditor'])

/** The steps the row shows for a phase: every entry step, only the deciding exit ones. */
export function rowSteps(view: LifecycleView): readonly LifecycleStep[] {
  return view.phase === 'exit'
    ? view.steps.filter((step) => EXIT_ROW.has(step.id))
    : view.steps
}
