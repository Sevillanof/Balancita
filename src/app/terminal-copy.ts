export function reasonLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    return 'Motivo no registrado'
  const known: Record<string, string> = {
    qwen_buy: 'Qwen propone abrir una posición larga',
    qwen_sell: 'Qwen propone abrir una posición corta',
    qwen_hold: 'Qwen decide esperar',
    c27_long_breakout: 'Ruptura alcista C27',
    c27_short_breakout: 'Ruptura bajista C27',
    position_owned: 'La posición sigue bajo gestión de su estrategia',
    owner_exit_condition_not_met: 'La condición de salida no se ha activado',
    entry_conditions_not_met: 'No se cumplen las condiciones de entrada',
    no_c27_breakout: 'Ninguna estrategia propuso una entrada; el motor espera.',
    no_directional_proposal:
      'No hay una propuesta direccional disponible; el motor espera.',
    insufficient_history: 'Histórico insuficiente para evaluar estrategias.',
    open: 'Abierta',
    filled: 'Ejecutada',
    rejected: 'Rechazada',
    expired: 'Caducada',
    unknown_funding:
      'Financiación sin semántica verificada; entradas bloqueadas.',
  }
  return known[value] ?? value.replaceAll('_', ' ')
}
