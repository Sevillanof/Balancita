import type {
  PaperDecisionCondition,
  PaperDecisionEvent,
} from '../infrastructure/connected-trading-provider.ts'

type PaperDecisionPanelProps = {
  decisions: readonly PaperDecisionEvent[]
  selectedId: string | null
  onSelect: (decision: PaperDecisionEvent) => void
}

export default function PaperDecisionPanel({
  decisions,
  selectedId,
  onSelect,
}: PaperDecisionPanelProps) {
  return (
    <section
      className="connected-terminal__panel"
      aria-label="Decisiones paper"
    >
      <h2>Decisiones del motor</h2>
      <p>
        Evidencia prospectiva del motor. Motivo y condiciones: solo si el
        evaluador los proporciona.
      </p>
      {decisions.length === 0 ? (
        <p role="status">No hay decisiones registradas.</p>
      ) : (
        <div className="connected-terminal__table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hora del evento (UTC)</th>
                <th>Recepción (UTC)</th>
                <th>Estrategia</th>
                <th>Dirección</th>
                <th>Resultado</th>
                <th>Motivo</th>
                <th>Condiciones</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision) => (
                <tr
                  key={decision.id}
                  data-selected={selectedId === decision.id}
                >
                  <td>
                    <button
                      type="button"
                      aria-pressed={selectedId === decision.id}
                      onClick={() => onSelect(decision)}
                    >
                      {new Date(decision.eventTime).toLocaleString('es-ES', {
                        timeZone: 'UTC',
                      })}
                    </button>
                  </td>
                  <td>
                    {new Date(decision.receivedAt).toLocaleString('es-ES', {
                      timeZone: 'UTC',
                    })}
                  </td>
                  <td>{decision.strategyId}</td>
                  <td>{decision.direction === 'long' ? 'Larga' : 'Plana'}</td>
                  <td>{outcomeLabel(decision.outcome)}</td>
                  <td>
                    {decision.reasonCode === null
                      ? (decision.reason ?? 'No disponible')
                      : reasonLabel(decision.reasonCode)}
                  </td>
                  <td>
                    {decision.conditions.length > 0
                      ? decision.conditions.map(conditionLabel).join(' · ')
                      : 'No disponible'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function outcomeLabel(outcome: PaperDecisionEvent['outcome']): string {
  switch (outcome) {
    case 'abstained':
      return 'Abstención de estrategia'
    case 'gate-rejected':
      return 'Rechazada por gate'
    case 'pending':
      return 'Pendiente, sin ejecución'
    case 'hold':
      return 'Sin cambio de exposición'
  }
}

function reasonLabel(code: string): string {
  const labels: Record<string, string> = {
    entry_conditions_met: 'Condiciones de entrada cumplidas',
    entry_conditions_not_met: 'Condiciones de entrada no cumplidas',
    exit_conditions_met: 'Condiciones de salida cumplidas',
    exit_conditions_not_met: 'Condiciones de salida no cumplidas',
    features_not_ready: 'Indicadores insuficientes para evaluar',
    regime_unavailable: 'Régimen no disponible',
    entry_gate_accepted: 'Gate de entrada aceptado',
    entry_gate_rejected: 'Gate de entrada rechazado',
    entry_gate_features_not_ready: 'Gate sin indicadores suficientes',
    c27_take_profit: 'Salida C27: objetivo alcanzado',
    c27_stop_loss: 'Salida C27: condición de stop',
    c27_time_stop: 'Salida C27: límite temporal',
    c27_hold: 'C27 mantiene la posición',
  }
  return labels[code] ?? `Código de decisión: ${code}`
}

function conditionLabel(condition: PaperDecisionCondition): string {
  const labels: Record<string, string> = {
    features_ready: 'Indicadores listos',
    atr_percentile_available: 'Percentil ATR disponible',
    atr_percentile_above_trend_threshold:
      'Percentil ATR para régimen tendencial',
    atr_percentile_below_range_threshold: 'Percentil ATR para régimen lateral',
    entry_ema9_above_ema21: 'EMA 9 sobre EMA 21',
    entry_close_above_sma50: 'Cierre sobre SMA 50',
    entry_rsi_below_45: 'RSI 14 menor que 45',
    entry_close_below_bollinger_lower: 'Cierre bajo banda inferior Bollinger',
    entry_rsi_below_30: 'RSI 14 menor que 30',
    entry_bollinger_width_ratio_at_least_0_01:
      'Ancho Bollinger sobre el umbral',
    entry_donchian_high_available: 'Máximo Donchian disponible',
    entry_close_above_donchian_high: 'Cierre sobre máximo Donchian',
    entry_volume_above_1_25_prior_average:
      'Volumen sobre 1,25× promedio previo',
    exit_close_below_ema21: 'Cierre bajo EMA 21',
    exit_rsi_above_68: 'RSI 14 sobre 68',
    exit_close_at_or_above_bollinger_mid: 'Cierre en o sobre media Bollinger',
    exit_rsi_above_55: 'RSI 14 sobre 55',
    exit_close_below_donchian_mid: 'Cierre bajo media Donchian',
    c27_close_at_take_profit: 'Cierre frente al umbral de objetivo C27',
    c27_close_at_stop_loss: 'Cierre frente al umbral de stop C27',
    c27_donchian_mid_available: 'Media Donchian disponible',
    c27_close_below_donchian_mid: 'Cierre bajo media Donchian',
    c27_bars_held_reached_time_stop: 'Barras mantenidas frente al límite',
    c27_close_below_time_stop_threshold: 'Cierre frente al umbral temporal C27',
    entry_gate_features_ready: 'Indicadores del gate disponibles',
    entry_gate_distance: 'Distancia del gate',
  }
  const value = formatConditionValue(condition.value)
  const threshold = formatConditionValue(condition.threshold)
  const operator =
    condition.operator === 'is'
      ? 'es'
      : condition.operator === '>='
        ? '≥'
        : condition.operator === '<='
          ? '≤'
          : condition.operator
  const result = condition.passed ? 'Cumplida' : 'No cumplida'
  return `${labels[condition.code] ?? `Código ${condition.code}`}: ${value} ${operator} ${threshold} (${result})`
}

function formatConditionValue(value: number | boolean | null): string {
  if (value === null) return 'No disponible'
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 6 }).format(
    value,
  )
}
