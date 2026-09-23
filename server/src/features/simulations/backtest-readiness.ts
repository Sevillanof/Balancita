/** Evidence gate, not a promise of future profitability or an order authorization. */
export interface BacktestReadiness {
  readonly status: 'insufficient' | 'review'
  readonly windowDays: number
  readonly reasons: readonly string[]
}

export function assessBacktestReadiness(input: {
  readonly tradeCount: number
  readonly windowDays: number
  readonly profitFactor: number | null
  readonly maxDrawdownPct: number
  readonly commissionRate: number
  readonly regimeCoverage: 'bull_bear_sideways' | 'not_evaluated'
}): BacktestReadiness {
  const reasons: string[] = []
  if (input.tradeCount < 300)
    reasons.push(
      'Se requieren al menos 300 operaciones cerradas (objetivo: 500).',
    )
  if (input.windowDays < 365)
    reasons.push('Se requiere al menos un año de datos (preferible: dos).')
  if (input.regimeCoverage !== 'bull_bear_sideways')
    reasons.push('No se verificaron regímenes alcista, bajista y lateral.')
  if (input.commissionRate <= 0)
    reasons.push('Falta descontar la comisión del exchange.')
  if (input.profitFactor === null || input.profitFactor <= 1.3)
    reasons.push('Profit Factor no supera 1,3 en operaciones cerradas.')
  if (input.maxDrawdownPct >= 20)
    reasons.push('Drawdown máximo alcanza o supera 20%.')
  return {
    status: reasons.length === 0 ? 'review' : 'insufficient',
    windowDays: input.windowDays,
    reasons,
  }
}
