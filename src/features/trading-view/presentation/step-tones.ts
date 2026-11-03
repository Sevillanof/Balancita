import type { StepTone } from '../../../app/terminal-lifecycle.ts'

export const TONE_RING: Record<StepTone, string> = {
  ok: 'border-long text-long',
  no: 'border-short text-short',
  warn: 'border-warn text-warn',
  info: 'border-info text-info',
  na: 'border-line-strong text-ink-2',
}

export const TONE_TEXT: Record<StepTone, string> = {
  ok: 'text-long',
  no: 'text-short',
  warn: 'text-warn',
  info: 'text-info',
  na: 'text-ink-2',
}
