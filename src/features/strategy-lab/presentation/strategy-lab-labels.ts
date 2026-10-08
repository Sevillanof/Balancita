import type { QwenScores } from '../infrastructure/qwen-scores.ts'
import type { StrategyState } from '../infrastructure/strategy-api.ts'

/** Models scored in Qwen's format (`docs/qwen-scores-api.md`). */
export type ModelKey = 'qwen' | 'kronos'

export type Dot = StrategyState | 'preview' | 'reference' | ModelKey

export const STATE_LABELS: Record<Dot, string> = {
  active: 'Activa en paper',
  shadow: 'En sombra',
  draft: 'Borrador',
  retired: 'Retirada',
  preview: 'Cambios sin guardar',
  reference: 'Referencia',
  qwen: 'Decisiones de Qwen',
  kronos: 'Decisiones de Kronos',
}

/** Texts of the Qwen panels for each model shown in that format. */
export type ModelTexts = {
  name: string
  chip: string
  description: string
  context: (horizonMin: number) => string
  emptyText: (scores: QwenScores | null) => string
  noTrades: string
}

export const MODEL_TEXTS: Record<ModelKey, ModelTexts> = {
  qwen: {
    name: 'Qwen',
    chip: 'Decide sobre las estrategias',
    description:
      'Qwen elige comprar, mantener o vender mirando lo que proponen las estrategias. Cada acierto suma +1 y cada fallo −1.',
    context: (horizonMin) =>
      `Cada decisión se juzga a ${horizonMin} min con comisiones · mismo book y costos que el backtest · todas las decisiones guardadas`,
    emptyText: (scores) => {
      if (!scores) return 'Cargando el puntaje de Qwen…'
      if (scores.status === 'off')
        return scores.reason === 'decisions_or_verdicts_db_missing'
          ? 'Qwen todavía no guardó decisiones: el puntaje aparece con la primera.'
          : 'El puntaje de Qwen no está disponible: el gateway en vivo no respondió.'
      if (scores.status === 'error')
        return `No se pudo calcular el puntaje de Qwen${scores.reason ? ` (${scores.reason})` : ''}.`
      return 'Qwen todavía no tiene decisiones para PF_XBTUSD.'
    },
    noTrades: 'Qwen todavía no abrió ninguna posición.',
  },
  kronos: {
    name: 'Kronos',
    chip: 'Predice con velas de 1 h',
    description:
      'Kronos-small predice las próximas 4 h a partir de velas de 1 h y solo opera cuando el movimiento esperado supera el doble del costo. Cada operación ganadora suma +1 y cada perdedora −1.',
    context: () => 'Se mide hacia delante · 4 h por operación',
    emptyText: (scores) => {
      if (!scores) return 'Cargando el puntaje de Kronos…'
      if (scores.status === 'off')
        return scores.reason === 'kronos_db_missing'
          ? 'Kronos todavía no guardó decisiones: el puntaje aparece con la primera.'
          : 'El puntaje de Kronos no está disponible: el gateway en vivo no respondió.'
      if (scores.status === 'error')
        return `No se pudo calcular el puntaje de Kronos${scores.reason ? ` (${scores.reason})` : ''}.`
      return 'Kronos todavía no tiene decisiones para este producto.'
    },
    noTrades: 'Kronos todavía no cerró ninguna operación.',
  },
}

export const EXIT_LABELS: Record<string, string> = {
  stop: 'stop',
  target: 'objetivo',
  strategy_exit: 'regla de salida',
  time_stop: 'tiempo',
}
