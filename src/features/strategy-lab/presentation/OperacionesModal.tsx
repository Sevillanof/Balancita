import { useState } from 'react'
import {
  firmado,
  instanteCorto,
  motivoTexto,
} from '../domain/estrategias-format.ts'
import { MOTIVO_FIN_VENTANA } from '../domain/estrategias-velas.ts'
import type { Informe } from '../infrastructure/estrategias-api.ts'
import { BOTON, EYEBROW } from './estrategias-styles.ts'
import ModalFrame from './ModalFrame.tsx'

type Quien = 'variante' | 'oficial'

/** Every closed trade of the backtest, of the variant or of the official Terminal. */
export default function OperacionesModal({
  informe,
  onClose,
}: {
  informe: Informe
  onClose: () => void
}) {
  const [quien, setQuien] = useState<Quien>('variante')
  const operaciones = [...informe[quien].operaciones].sort(
    (a, b) => a.entrada_ms - b.entrada_ms,
  )
  const cerradas = operaciones.filter(
    (operacion) => operacion.motivo === MOTIVO_FIN_VENTANA,
  ).length
  return (
    <ModalFrame label="Operaciones del backtest" onClose={onClose} wide>
      <div className="flex items-center justify-between gap-3">
        <h2>Operaciones del backtest</h2>
        <div className="flex gap-2" role="group" aria-label="Qué configuración">
          {(['variante', 'oficial'] as const).map((opcion) => (
            <button
              key={opcion}
              type="button"
              aria-pressed={quien === opcion}
              className={`${BOTON} ${quien === opcion ? 'border-info!' : ''}`}
              onClick={() => setQuien(opcion)}
            >
              {opcion === 'variante' ? 'Variante' : 'Oficial'}
            </button>
          ))}
        </div>
      </div>
      <p className={EYEBROW}>
        {operaciones.length - cerradas} operaciones · horas en UTC · neto en US$
        después de costos
        {cerradas > 0 &&
          ` · ${cerradas} ${cerradas === 1 ? 'cerrada' : 'cerradas'} al final de la ventana (fuera de las métricas)`}
      </p>
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse text-note">
          <thead>
            <tr>
              {['Entrada', 'Salida', 'Lado', 'Neto', 'Motivo'].map((titulo) => (
                <th
                  key={titulo}
                  scope="col"
                  className={`sticky top-0 bg-surface-1 px-3 py-2 text-label font-medium tracking-section text-ink-2 uppercase ${titulo === 'Neto' ? 'text-right' : 'text-left'}`}
                >
                  {titulo}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {operaciones.map((operacion) => (
              <tr key={`${operacion.entrada_ms}-${operacion.salida_ms}`}>
                <td className="px-3 py-1.5 font-mono">
                  {instanteCorto(operacion.entrada_ms)}
                </td>
                <td className="px-3 py-1.5 font-mono">
                  {instanteCorto(operacion.salida_ms)}
                </td>
                <td className="px-3 py-1.5">
                  {operacion.lado === 'LONG' ? 'Largo' : 'Corto'}
                </td>
                <td
                  className={`px-3 py-1.5 text-right font-mono ${operacion.neto_usd < 0 ? 'text-short' : 'text-long'}`}
                >
                  {firmado(operacion.neto_usd)}
                </td>
                <td className="px-3 py-1.5 text-ink-2">
                  {motivoTexto(operacion.motivo)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <button type="button" className={BOTON} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </ModalFrame>
  )
}
