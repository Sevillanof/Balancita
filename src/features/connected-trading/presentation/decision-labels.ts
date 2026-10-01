export function paperDecisionReasonLabel(code: string): string {
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
