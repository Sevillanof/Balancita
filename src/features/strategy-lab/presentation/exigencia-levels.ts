import type {
  AnalistaModo,
  ExigenciaLevels,
  Medicion,
} from '../infrastructure/quick-api.ts'

/** The level paper operates with: the sliders start here, and it is marked on them. */
export const EXIGENCIA_PAPER = 5
export const EXIGENCIA_PAPER_LEVELS: ExigenciaLevels = {
  maestro: EXIGENCIA_PAPER,
  portero: EXIGENCIA_PAPER,
  analista: 'apagado',
  medicion: 'honesta',
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

/** The two ways of measuring a test (mirrors `MEDICIONES` in futures_walkforward.py); the honest one is the default. */
export const MEDICIONES: Array<{
  modo: Medicion
  label: string
  detail: string
}> = [
  {
    modo: 'honesta',
    label: 'Honesta',
    detail:
      'Cada trimestre el maestro y el portero se reajustan solo con lo anterior y operan el siguiente sin haberlo visto. Ninguna etapa queda dentro del ajuste.',
  },
  {
    modo: 'vigente',
    label: 'Fórmula en vigor',
    detail:
      'Las fórmulas que operan en paper, ajustadas hasta sep-2025: las etapas anteriores a oct-2025 salen marcadas «dentro del ajuste» y no prueban nada.',
  },
]
