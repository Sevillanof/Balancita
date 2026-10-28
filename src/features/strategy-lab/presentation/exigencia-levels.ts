import type {
  AnalistaModo,
  ExigenciaLevels,
} from '../infrastructure/quick-api.ts'

/** The level paper operates with: the sliders start here, and it is marked on them. */
export const EXIGENCIA_PAPER = 5
export const EXIGENCIA_PAPER_LEVELS: ExigenciaLevels = {
  maestro: EXIGENCIA_PAPER,
  portero: EXIGENCIA_PAPER,
  analista: 'apagado',
}

/** The three positions of the movement analyst: what each does to the size of an entry (mirrors `MODES` in futures_qwen_analista.py). */
export const ANALISTA_OPCIONES: Array<{
  modo: AnalistaModo
  label: string
  detail: string
}> = [
  {
    modo: 'apagado',
    label: 'Apagado',
    detail: 'todas las operaciones con el mismo tamaño (como paper)',
  },
  {
    modo: 'suave',
    label: '1,25 / 0,75',
    detail: 'tamaño ×1,25 con movimiento y ×0,75 en calma',
  },
  {
    modo: 'fuerte',
    label: '1,5 / 0,5',
    detail: 'tamaño ×1,5 con movimiento y ×0,5 en calma',
  },
]
