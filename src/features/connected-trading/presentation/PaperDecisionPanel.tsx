import type {
  PaperDecisionCondition,
  PaperDecisionEvent,
} from '../infrastructure/connected-trading-provider.ts'
import { paperDecisionReasonLabel } from './decision-labels.ts'

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
    <aside
      className="demo-terminal__panel demo-terminal__events"
      aria-label="Decisiones del motor"
    >
      <div className="demo-terminal__panel-title">
        <div>
          <p className="demo-shell__eyebrow">EVIDENCIA DEL BACKEND · PAPER</p>
          <h3>Decisiones del motor</h3>
        </div>
        <span>{decisions.length} eventos</span>
      </div>
      {decisions.length === 0 ? (
        <p role="status" className="demo-terminal__empty">
          No hay decisiones registradas.
        </p>
      ) : (
        <div className="demo-terminal__event-list">
          {[...decisions].reverse().map((decision) => (
            <button
              type="button"
              key={decision.id}
              className={`demo-terminal__event ${selectedId === decision.id ? 'is-selected' : ''}`}
              data-selected={selectedId === decision.id}
              aria-pressed={selectedId === decision.id}
              onClick={() => onSelect(decision)}
            >
              <span className="demo-terminal__event-kind">
                {outcomeLabel(decision.outcome)}
              </span>
              <time>
                {new Date(decision.eventTime).toLocaleString('es-ES', {
                  timeZone: 'UTC',
                })}{' '}
                UTC
              </time>
              <span>
                {decision.reasonCode === null
                  ? (decision.reason ?? 'No disponible')
                  : paperDecisionReasonLabel(decision.reasonCode)}
              </span>
              <strong>
                {decision.strategyId} ·{' '}
                {decision.direction === 'long' ? 'Larga' : 'Plana'} · Precio: No
                disponible
              </strong>
              <small>
                <span>
                  Versión: {decision.strategyVersion || 'No disponible'}
                </span>
                <span>Sesión: {decision.sessionId ?? 'No disponible'}</span>
                <span>
                  Recepción UTC:{' '}
                  {new Date(decision.receivedAt).toLocaleString('es-ES', {
                    timeZone: 'UTC',
                  })}
                </span>
                <span>
                  Condiciones:{' '}
                  {decision.conditions.length > 0 ? (
                    decision.conditions.map(conditionLabel).join(' · ')
                  ) : (
                    <span>No disponible</span>
                  )}
                </span>
              </small>
            </button>
          ))}
        </div>
      )}
      <p className="demo-terminal__disclaimer">
        Datos de decisión y recepción proporcionados por el backend; no implican
        una ejecución.
      </p>
    </aside>
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
