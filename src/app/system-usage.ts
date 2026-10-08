import { record } from '../shared/wire/decode.ts'

export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const decimal = (value: number, digits = 0) =>
  value.toLocaleString('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

export interface UsageSummary {
  readonly cpu: string
  readonly data: string
  readonly qwen: string
  readonly kronos: string
  readonly title: string
}

/** Chip texts from `/api/system`; "—" where a figure is not available. */
export function summarizeUsage(body: unknown): UsageSummary {
  const usage = record(body)
  const qwen = record(usage.qwen)
  const decisions = record(qwen.decisions)
  const kronos = record(usage.kronos)
  const cpu = number(usage.cpu_pct)
  const data = number(usage.data_mb)
  const lastHour = number(decisions.last_hour)
  const exitDecisions = number(qwen.exit_decisions)
  const trades = number(kronos.trades)
  const rss = number(usage.rss_mb)
  const latency = number(decisions.avg_latency_ms)
  const qwenLabel =
    qwen.running === false
      ? 'apagado'
      : lastHour === null
        ? '—'
        : `${decimal(lastHour)}/h`
  const kronosLabel =
    kronos.running === false && trades === null
      ? 'apagado'
      : trades === null
        ? kronos.running === true
          ? 'activo'
          : '—'
        : `${decimal(trades)} op.`
  return {
    cpu: cpu === null ? '—' : `${decimal(cpu)} %`,
    data: data === null ? '—' : `${decimal(data, data < 100 ? 1 : 0)} MB`,
    qwen: qwenLabel,
    kronos: kronosLabel,
    title: [
      `CPU: ${cpu === null ? 'no disponible' : `${decimal(cpu)} % de un núcleo (suma de los procesos de pnpm dev y Kronos; ${number(usage.cores) ?? '?'} núcleos)`}`,
      `Memoria: ${rss === null ? 'no disponible' : `${decimal(rss)} MB`}`,
      `Datos guardados: ${data === null ? 'no disponible' : `${decimal(data, 1)} MB en server/data/dev-live`}`,
      `Qwen: ${lastHour === null ? 'sin datos' : `${decimal(lastHour)} decisiones en la última hora, ${decimal(number(decisions.total) ?? 0)} en total`}${latency === null ? '' : `, ${decimal(latency)} ms de media`}${exitDecisions === null ? '' : `; C31 ha decidido ${decimal(exitDecisions)} salidas`}`,
      `Kronos: ${trades === null ? (kronos.running === true ? 'en marcha, sin operaciones aún' : 'sin datos') : `${decimal(trades)} operaciones forward`}${number(kronos.decisions) === null ? '' : `, ${decimal(number(kronos.decisions) ?? 0)} decisiones`}`,
    ].join('\n'),
  }
}
