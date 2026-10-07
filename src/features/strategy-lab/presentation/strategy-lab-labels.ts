import type { StrategyState } from '../infrastructure/strategy-api.ts'

export type Dot = StrategyState | 'preview' | 'reference' | 'qwen'

export const STATE_LABELS: Record<Dot, string> = {
  active: 'Activa en paper',
  shadow: 'En sombra',
  draft: 'Borrador',
  retired: 'Retirada',
  preview: 'Cambios sin guardar',
  reference: 'Referencia',
  qwen: 'Decisiones de Qwen',
}

export const EXIT_LABELS: Record<string, string> = {
  stop: 'stop',
  target: 'objetivo',
  strategy_exit: 'regla de salida',
  time_stop: 'tiempo',
}
