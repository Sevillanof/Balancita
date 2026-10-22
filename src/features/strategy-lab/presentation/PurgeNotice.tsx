import type { PurgeStatus } from '../infrastructure/strategy-api.ts'

const CONSUMER_TEXT: Record<string, string> = {
  forward: 'medición en paper',
}

/** "Borrando…" while another process still deletes its own rows, "listo" afterwards. */
export default function PurgeNotice({
  name,
  status,
}: {
  name: string
  status: PurgeStatus
}) {
  const pending = Object.entries(status.consumers)
    .filter(([, value]) => value === 'pending')
    .map(([key]) => CONSUMER_TEXT[key] ?? key)
  return (
    <p role="status" className="strategies__notice">
      {status.state === 'done'
        ? `Listo: ${name} se borró por completo.`
        : `Borrando ${name}…${pending.length ? ` Falta: ${pending.join(', ')}.` : ''}`}
    </p>
  )
}
