import { amount } from '../../../shared/finance/format.ts'
import { count, horizonText } from './strategy-format.ts'
import type {
  Inventory,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

/** Market line of a strategy, shared by the inventory and the comparison. */
export function marketText(row: InventoryStrategy) {
  const parts: string[] = []
  if (row.market.products)
    parts.push(
      row.kind === 'carry'
        ? `${row.market.products} perpetuos PF_ + contado`
        : `${row.market.products} perpetuos PF_`,
    )
  if (row.market.exit_by === 'qwen') parts.push('Qwen decide la salida')
  else if (row.market.horizon_minutes != null)
    parts.push(`horizonte ${horizonText(row.market.horizon_minutes)}`)
  return parts.length > 0 ? parts.join(' · ') : 'No disponible'
}

/** What the statistical validation says, in the words of the registry data. */
export function validationDetail(row: InventoryStrategy, inventory: Inventory) {
  const backtest = row.research.backtest
  if (backtest) {
    const t =
      backtest.t_stat == null ? 'No disponible' : amount(backtest.t_stat)
    const tests = backtest.selection_trials
    return {
      line: `t = ${t} · prob. deflactada ${
        backtest.deflated_probability == null
          ? 'No disponible'
          : amount(backtest.deflated_probability)
      } · tramos positivos ${backtest.folds_positive ?? '—'}/${backtest.folds_judged ?? '—'}`,
      extra:
        tests == null
          ? null
          : tests > 1
            ? `Elegida entre ${count(tests)} configuraciones`
            : 'Elegida entre 1 configuración',
    }
  }
  if (row.kind === 'carry')
    return { line: row.research.text ?? 'Estado no verificado', extra: null }
  if (row.kind === 'qwen_exit')
    return {
      line: `Qwen decide la salida; se juzga con ${count(inventory.forward_min_trades)} operaciones forward.`,
      extra: null,
    }
  if (row.kind === 'model')
    return { line: 'Resultados en archivo local; sin endpoint.', extra: null }
  if (row.no_backtest)
    return {
      line: 'Sin backtest por diseño: solo cuentan las operaciones posteriores al inicio.',
      extra: null,
    }
  return { line: 'Sin medición comparable para este spec.', extra: null }
}
