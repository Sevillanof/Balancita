import { DataState } from '../../../shared/mission-control'
import { useReport } from '../../observability/infrastructure/useReport.ts'
import {
  fetchSessionBlocks,
  type SessionBlocksReading,
} from '../infrastructure/session-blocks-api.ts'
import SessionStatusPanel from './SessionStatusPanel.tsx'
import SessionValidityPanel from './SessionValidityPanel.tsx'

const INVALID: Record<string, string> = {
  other_run: 'El archivo es de otra corrida de la sesión',
  not_json: 'El archivo no es un JSON válido',
  schema_unknown: 'El archivo tiene un formato desconocido',
  not_derived: 'El archivo no se declara derivado y sin autoridad',
  block_missing: 'Al archivo le falta un bloque',
  block_shape: 'Un bloque del archivo no tiene la forma esperada',
  unreadable: 'No se pudo leer el archivo',
}

/** What the screen shows for one reading; pure, so the states are testable. */
export function SessionBlocksReadingView({
  reading,
  lastRead = false,
}: {
  reading: SessionBlocksReading
  /** The latest read failed: this is the previous answer, so its age is the one «a la última lectura». */
  lastRead?: boolean
}) {
  if (reading.state === 'absent')
    return (
      <DataState
        kind="nodata"
        detail="No hay archivo de bloques de la sesión: no hay sesión publicada."
      />
    )
  if (reading.state === 'invalid')
    return (
      <DataState
        kind="unavailable"
        title="Archivo no utilizable"
        detail={INVALID[reading.reason] ?? reading.reason}
      />
    )
  const { document } = reading
  const age = reading.evaluatedMs - reading.publishedAtMs
  return (
    <>
      <p role="note">
        Archivo derivado, sin autoridad sobre la sesión. La edad es la de la
        publicación, no la del dato.
      </p>
      <p data-testid="document-age">
        {age >= 0
          ? `Documento publicado hace ${Math.round(age / 1000)} s${lastRead ? ' a la última lectura' : ''}`
          : 'Edad del documento no medible'}
      </p>
      <SessionStatusPanel status={document.status} />
      <SessionValidityPanel block={document.positions} />
    </>
  )
}

/** Reads the gateway route and shows the session; read-only, no controls. */
export default function SessionBlocksView() {
  const report = useReport(fetchSessionBlocks)
  if (report.data === null)
    return report.error ? (
      <DataState kind="error" detail={report.error} />
    ) : (
      <DataState kind="loading" />
    )
  return (
    <>
      {report.error && (
        <DataState
          kind="error"
          title="Lectura fallida"
          detail={`Se muestra la última lectura recibida. ${report.error}`}
        />
      )}
      <SessionBlocksReadingView
        reading={report.data}
        lastRead={report.error !== null}
      />
    </>
  )
}
