import { amount } from '../../../shared/finance/format.ts'
import type {
  VbtDiagnostic,
  VbtExploration,
  VbtVariant,
} from '../infrastructure/vectorbt-api.ts'
import { bpText, dayText, perDayText, shareText } from './vectorbt-format.ts'

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

const table = (header: string[], rows: string[][]) =>
  [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n')

const bullets = (items: string[], empty: string) =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty

function diagnosticMarkdown(diagnostic: VbtDiagnostic): string[] {
  const totals = diagnostic.totals
  const parts = [
    '## Totales',
    bullets(
      [
        `Operaciones: ${amount(totals.trades, 0)}`,
        `Entradas por día: ${perDayText(totals.entries_per_day)}`,
        `Antes de costos: ${bpText(totals.gross_bp_mean)}`,
        `Neto por operación: ${bpText(totals.net_bp_mean)}`,
        `Aciertos: ${shareText(totals.hit_rate)}`,
      ],
      '',
    ),
    '## Qué funciona',
    bullets(diagnostic.works, 'Nada que destacar por ahora.'),
    '## Qué falla',
    bullets(diagnostic.fails, 'No se vio nada que falle.'),
  ]
  if (diagnostic.by_product.length > 0)
    parts.push(
      '## Por producto',
      table(
        ['Producto', 'Operaciones', 'Antes de costos', 'Neto', 'Aciertos'],
        diagnostic.by_product.map((row) => [
          row.product,
          amount(row.trades, 0),
          bpText(row.gross_bp_mean),
          bpText(row.net_bp_mean),
          shareText(row.hit_rate),
        ]),
      ),
    )
  if (diagnostic.by_exit.length > 0)
    parts.push(
      '## Por tipo de salida',
      table(
        ['Salida', 'Operaciones', 'Del total', 'Antes de costos', 'Neto'],
        diagnostic.by_exit.map((row) => [
          row.label,
          amount(row.trades, 0),
          shareText(row.share),
          bpText(row.gross_bp_mean),
          bpText(row.net_bp_mean),
        ]),
      ),
    )
  if (diagnostic.notes.length > 0)
    parts.push('## Avisos sobre los datos', bullets(diagnostic.notes, ''))
  return parts
}

function variantRow(row: VbtVariant): string[] {
  const value = `${row.value.replace('.', ',')}${row.is_base ? ' (la actual)' : ''}`
  if (row.status === 'error')
    return [
      '—',
      value,
      `No se pudo probar: ${row.error ?? 'falló'}`,
      '',
      '',
      '',
    ]
  if (row.status === 'no_trades')
    return ['—', value, 'No operó nunca con este valor.', '', '', '']
  return [
    String(row.rank),
    value,
    perDayText(row.entries_per_day),
    bpText(row.net_bp_mean),
    amount(row.trades, 0),
    shareText(row.hit_rate),
  ]
}

/** The report of an exploration as Markdown, to paste elsewhere. */
export function explorationMarkdown(
  exploration: VbtExploration,
  attempts: number | null,
): string {
  const report = exploration.report
  if (!report) return ''
  const mode =
    exploration.mode === 'diagnostic'
      ? 'Diagnóstico'
      : `Variantes de ${report.vary?.label ?? exploration.vary ?? '—'}`
  const parts = [
    `# Reporte de VectorBT: ${report.strategy_name}`,
    `${mode} · datos de práctica del ${dayText(report.window.from)} a ${dayText(report.window.to)} · productos: ${report.products.join(', ')}. Es un diagnóstico rápido, no un veredicto.`,
  ]
  if (report.status === 'unsupported' || report.diagnostic === null) {
    parts.push(
      `VectorBT no puede reproducir esta estrategia: ${report.unsupported?.reason ?? exploration.detail}. Para probarla usá Testear, que corre en el simulador.`,
    )
  } else {
    parts.push(...diagnosticMarkdown(report.diagnostic))
    if (report.variants) {
      const tried = attempts ?? report.attempts_in_family
      parts.push(
        `## Ranking de variantes: ${report.vary?.label ?? exploration.vary ?? ''}`,
      )
      if (report.variants_headline) parts.push(report.variants_headline)
      parts.push(
        tried === null
          ? 'No se pudo leer cuántos intentos lleva esta estrategia.'
          : `Llevás ${tried} ${tried === 1 ? 'intento' : 'intentos'} con esta estrategia. Son hipótesis: cuanto más se prueba, más fácil es que alguna salga bien por casualidad.`,
        table(
          [
            '#',
            'Valor',
            'Entradas por día',
            'Neto por operación',
            'Operaciones',
            'Aciertos',
          ],
          report.variants.map(variantRow),
        ),
      )
    }
  }
  parts.push(
    `> ${report.warning}`,
    'pb = punto básico: 1 pb es el 0,01 % de lo operado. Neto es lo que queda después de comisiones, costo de ejecución y funding.',
  )
  return parts.join('\n\n') + '\n'
}
