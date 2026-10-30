import type {
  AnalistaModo,
  Cuenta,
  Entrada,
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

/** What decides the entries of a test (mirrors `ENTRADAS` in futures_qwen_rebote.py); the formula is what paper operates. */
export const ENTRADAS: Array<{ modo: Entrada; label: string; detail: string }> =
  [
    {
      modo: 'formula',
      label: 'Maestro + portero',
      detail:
        'La fórmula que opera en paper: entra cuando el maestro es fuerte y el portero está de acuerdo.',
    },
    {
      modo: 'formula_eth',
      label: 'Maestro + portero + datos de ETH',
      detail:
        'Suma los datos de ETH guardados en la Mac (qué hacen los grandes vs. cuentas chicas, comparación contra BTC, prima del perpetuo y funding) y descuenta el funding real en cada operación.',
    },
    {
      modo: 'rebote',
      label: 'Rebote de ETH',
      detail:
        'ETH cae 5 % en 1 h → largo, sale a las 24 h. No usa el maestro, el portero ni el analista de movimiento. La regla se eligió mirando este mismo período: el medidor sale rojo.',
    },
    {
      modo: 'rebote_btc',
      label: 'Rebote con filtro de BTC',
      detail:
        'Igual, pero solo si ETH cayó 2 puntos más que BTC en esa hora, y sale a las 4 h.',
    },
  ]

/** How big each trade is when the result is added up: the same trades, only the USD change. */
export const CUENTAS: Array<{ modo: Cuenta; label: string; detail: string }> = [
  {
    modo: 'fija',
    label: '100 USD fijos',
    detail: 'El tamaño de paper: 100 USD en cada operación.',
  },
  {
    modo: 'entera',
    label: 'Toda la cuenta',
    detail:
      'La primera operación usa 1.000 USD; cada siguiente, 1.000 más lo ganado o perdido hasta ahí. Sin apalancamiento.',
  },
]
