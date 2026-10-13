import { analysisReason, money, quantity, utcTime } from './terminal-labels.ts'

export default function SelectedAnalysis({
  selectedId,
  selectedDecisionTime,
  selectedAnalysis,
  selectedOrder,
  selectedFills,
}: {
  selectedId: string
  selectedDecisionTime: unknown
  selectedAnalysis: Record<string, unknown>
  selectedOrder: Record<string, unknown> | undefined
  selectedFills: Array<Record<string, unknown>>
}) {
  return (
    <section aria-label="Análisis seleccionado">
      <h3>Análisis seleccionado</h3>
      <dl>
        <dt>ID de análisis</dt>
        <dd>{selectedId || 'ID no disponible'}</dd>
        <dt>Hora</dt>
        <dd>{utcTime(selectedDecisionTime)}</dd>
        <dt>Motivo</dt>
        <dd>{analysisReason(selectedAnalysis, true)}</dd>
      </dl>
      {selectedOrder ? (
        <div>
          <h4>Efecto durable</h4>
          <dl>
            <dt>ID de orden</dt>
            <dd>{String(selectedOrder.order_id)}</dd>
            <dt>Tipo / dirección</dt>
            <dd>
              {String(
                selectedOrder.order_type ??
                  selectedOrder.type ??
                  'Tipo no disponible',
              )}{' '}
              · {String(selectedOrder.side ?? 'Dirección no disponible')}
            </dd>
            <dt>Estado</dt>
            <dd>
              {String(
                selectedOrder.state ??
                  selectedOrder.status ??
                  'Estado no disponible',
              )}
            </dd>
            <dt>Cantidad</dt>
            <dd>
              {quantity(selectedOrder.quantity_btc ?? selectedOrder.quantity)}
            </dd>
            <dt>Motivo de la orden</dt>
            <dd>
              {String(
                selectedOrder.reason_code ??
                  selectedOrder.reason ??
                  'No disponible',
              )}
            </dd>
          </dl>
          <h4>Ejecuciones de la orden</h4>
          {selectedFills.length > 0 ? (
            <ul>
              {selectedFills.map((fill, index) => (
                <li key={String(fill.fill_id ?? index)}>
                  {String(fill.fill_id ?? 'Ejecución')} ·{' '}
                  {quantity(fill.quantity_btc)} @{' '}
                  {money(fill.price_usd_per_btc)} ·{' '}
                  {utcTime(fill.event_time_ms)}
                </li>
              ))}
            </ul>
          ) : (
            <p>Sin ejecuciones registradas para esta orden.</p>
          )}
        </div>
      ) : (
        <p>Sin efecto</p>
      )}
    </section>
  )
}
