import { useEffect, useMemo, useRef, useState } from 'react'
import { createDemoTradingProvider, openUnrealizedPnl } from './provider.ts'
import type { DemoSnapshot } from './types.ts'
import TerminalChart from './TerminalChart.tsx'
import ApprovedTerminalLayout from '../../trading-view/presentation/ApprovedTerminalLayout.tsx'
import ApprovedMarketRow from '../../trading-view/presentation/ApprovedMarketRow.tsx'
import ApprovedChartToolbar from '../../trading-view/presentation/ApprovedChartToolbar.tsx'
import ApprovedPortfolioTables from '../../trading-view/presentation/ApprovedPortfolioTables.tsx'
import ApprovedChartLegend from '../../trading-view/presentation/ApprovedChartLegend.tsx'
import {
  resampleCandles,
  TERMINAL_INTERVALS,
  type TerminalInterval,
} from './terminal-model.ts'

const money = (value: number) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
const time = (value: number) =>
  new Date(value * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })

export default function TerminalView() {
  const provider = useMemo(() => createDemoTradingProvider(), [])
  const [snapshot, setSnapshot] = useState<DemoSnapshot>(() =>
    provider.getSnapshot(),
  )
  const [paused, setPaused] = useState(true)
  const [selectedId, setSelectedId] = useState('decision-08')
  const [interval, setInterval] = useState<TerminalInterval>('5m')
  const [filters, setFilters] = useState({
    entry: true,
    exit: true,
    discard: true,
  })
  const [bucketChoices, setBucketChoices] = useState<readonly string[]>([])
  const eventRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => provider.subscribe(setSnapshot), [provider])
  const latest = snapshot.candles.at(-1)!
  const chartCandles = useMemo(
    () => resampleCandles(snapshot.candles, TERMINAL_INTERVALS[interval]),
    [snapshot.candles, interval],
  )
  const visibleDecisions = snapshot.decisions.filter(
    (decision) => filters[decision.kind],
  )
  const realized = snapshot.trades.reduce(
    (total, trade) => total + trade.realizedPnlEur,
    0,
  )
  const unrealized = snapshot.positions.reduce(
    (total, position) => total + openUnrealizedPnl(position, latest.close),
    0,
  )
  const selected = visibleDecisions.find(
    (decision) => decision.id === selectedId,
  )

  useEffect(() => {
    if (!selectedId) return
    eventRefs.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId])

  const chooseBucket = (time: number, markerId?: string) => {
    if (markerId && visibleDecisions.some((event) => event.id === markerId)) {
      setSelectedId(markerId)
      return
    }
    const intervalSeconds = TERMINAL_INTERVALS[interval]
    const choices = visibleDecisions.filter(
      (event) =>
        Math.floor(event.time / intervalSeconds) * intervalSeconds === time,
    )
    if (choices.length === 1) setSelectedId(choices[0]!.id)
    else if (choices.length > 1)
      setBucketChoices(choices.map((event) => event.id))
  }

  const toggleFilter = (kind: keyof typeof filters, checked: boolean) => {
    setFilters((current) => ({ ...current, [kind]: checked }))
    if (
      !checked &&
      snapshot.decisions.find((decision) => decision.id === selectedId)
        ?.kind === kind
    ) {
      setSelectedId(
        snapshot.decisions
          .filter(
            (decision) => decision.kind !== kind && filters[decision.kind],
          )
          .at(-1)?.id ?? '',
      )
    }
  }

  const toggleClock = () => {
    if (paused) provider.resume()
    else provider.pause()
    setPaused(!paused)
  }
  const reset = () => {
    setSnapshot(provider.reset())
    setPaused(true)
    provider.pause()
  }

  return (
    <section className="demo-terminal" aria-label="Terminal demo de BTC/EUR">
      <ApprovedMarketRow
        identity={
          <div>
            <p className="demo-shell__eyebrow">
              MERCADO · BTC/EUR · DATOS ILUSTRATIVOS
            </p>
            <h2>
              Bitcoin <span>/ Euro</span>
            </h2>
          </div>
        }
        quote={
          <div className="demo-terminal__quote">
            <strong>€{money(latest.close)}</strong>
            <span>Última vela · {time(latest.time)} UTC</span>
          </div>
        }
        context={
          <div className="demo-terminal__clock">
            <span
              aria-label={
                paused ? 'Simulación pausada' : 'Simulación en marcha'
              }
            >
              ● {paused ? 'Pausada' : 'Simulación activa'}
            </span>
            <button type="button" onClick={toggleClock}>
              {paused ? 'Reanudar simulación' : 'Pausar simulación'}
            </button>
            <button type="button" onClick={reset}>
              Reiniciar
            </button>
          </div>
        }
      />
      <ApprovedTerminalLayout
        chart={
          <section
            className="demo-terminal__panel"
            aria-label="Gráfico de mercado"
          >
            <ApprovedChartToolbar
              instrument="BTC/EUR"
              description="Velas japonesas / Volumen"
              controls={
                <div
                  className="demo-terminal__intervals"
                  role="group"
                  aria-label="Intervalo del gráfico"
                >
                  {(Object.keys(TERMINAL_INTERVALS) as TerminalInterval[]).map(
                    (value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={interval === value}
                        onClick={() => setInterval(value)}
                      >
                        {value}
                      </button>
                    ),
                  )}
                </div>
              }
            />
            <TerminalChart
              candles={chartCandles}
              decisions={visibleDecisions}
              positions={snapshot.positions}
              trades={snapshot.trades}
              selectedId={selectedId}
              interval={interval}
              onBucketSelect={chooseBucket}
            />
            <ApprovedChartLegend>
              {(['entry', 'exit', 'discard'] as const).map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={filters[kind]}
                    onChange={(event) =>
                      toggleFilter(kind, event.target.checked)
                    }
                  />
                  {kind === 'entry'
                    ? 'Entradas'
                    : kind === 'exit'
                      ? 'Salidas'
                      : 'Descartes'}
                </label>
              ))}
              <span>↑ Larga · ↓ Corta</span>
              <span>El símbolo y la etiqueta indican dirección/estado</span>
              <small>Desplazamiento y zoom disponibles en el gráfico</small>
            </ApprovedChartLegend>
          </section>
        }
        decisions={
          <aside
            className="demo-terminal__panel demo-terminal__events"
            aria-label="Decisiones del motor"
          >
            <div className="demo-terminal__panel-title">
              <div>
                <p className="demo-shell__eyebrow">TRAZABILIDAD SIMULADA</p>
                <h3>Decisiones del motor</h3>
              </div>
              <span>{visibleDecisions.length} eventos visibles</span>
            </div>
            <div className="demo-terminal__event-list">
              {[...visibleDecisions].reverse().map((decision) => (
                <button
                  type="button"
                  key={decision.id}
                  ref={(node) => {
                    if (node) eventRefs.current.set(decision.id, node)
                    else eventRefs.current.delete(decision.id)
                  }}
                  className={`demo-terminal__event ${selectedId === decision.id ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(decision.id)}
                  aria-pressed={selectedId === decision.id}
                >
                  <span
                    className={`demo-terminal__event-kind is-${decision.kind}`}
                  >
                    {decision.kind === 'entry'
                      ? `Entrada ${decision.direction === 'long' ? 'larga' : 'corta'}`
                      : decision.kind === 'exit'
                        ? 'Salida'
                        : 'Descartada'}
                  </span>
                  <time>{time(decision.time)} UTC</time>
                  <span>{decision.reason}</span>
                  <strong>€{money(decision.price)}</strong>
                  <small>
                    {decision.executionId
                      ? `Ejecución ilustrativa ${decision.executionId}`
                      : 'Decisión sin ejecución'}
                  </small>
                </button>
              ))}
            </div>
            <p className="demo-terminal__disclaimer">
              Decisiones y ejecuciones son eventos distintos. Todos los datos de
              esta vista son ejemplos simulados.
            </p>
          </aside>
        }
      />
      {bucketChoices.length > 0 && (
        <div
          className="demo-terminal__chooser"
          role="dialog"
          aria-label="Decisiones en esta vela"
        >
          <strong>Varias decisiones en esta vela</strong>
          {bucketChoices.map((id) => {
            const event = visibleDecisions.find((item) => item.id === id)!
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setSelectedId(id)
                  setBucketChoices([])
                }}
              >
                {time(event.time)} UTC ·{' '}
                {event.kind === 'entry'
                  ? `Entrada ${event.direction === 'long' ? 'larga' : 'corta'}`
                  : event.kind === 'exit'
                    ? 'Salida'
                    : 'Descartada'}{' '}
                · {event.reason}
              </button>
            )
          })}
          <button type="button" onClick={() => setBucketChoices([])}>
            Cerrar
          </button>
        </div>
      )}
      {selected && (
        <p className="demo-terminal__selection">
          <strong>Evento seleccionado</strong>
          <span>
            {time(selected.time)} UTC · €{money(selected.price)} ·{' '}
            {selected.reason}
          </span>
        </p>
      )}
      <ApprovedPortfolioTables
        label="CARTERA ILUSTRATIVA"
        title="Posiciones y operaciones"
        ariaLabel="Posiciones y operaciones ilustrativas"
        summary={
          <div>
            <span>
              Realizado{' '}
              <strong className={realized >= 0 ? 'is-positive' : 'is-negative'}>
                €{money(realized)}
              </strong>
            </span>
            <span>
              No realizado{' '}
              <strong
                className={unrealized >= 0 ? 'is-positive' : 'is-negative'}
              >
                €{money(unrealized)}
              </strong>
            </span>
          </div>
        }
        open={{
          title: 'Posiciones abiertas',
          columns: [
            'Dirección / tamaño',
            'Entrada',
            'Actual',
            'Stop / objetivo',
            'Neto estimado',
          ],
          rows: snapshot.positions.map((position) => ({
            id: position.id,
            cells: [
              <>
                {position.direction === 'long' ? 'Larga' : 'Corta'}
                <small>{position.sizeBtc} BTC</small>
              </>,
              <>€{money(position.entryEur)}</>,
              <>€{money(latest.close)}</>,
              <>
                €{money(position.stopEur)} / €{money(position.targetEur)}
              </>,
              <>€{money(openUnrealizedPnl(position, latest.close))}</>,
            ],
          })),
        }}
        closed={{
          title: 'Operaciones cerradas',
          columns: [
            'Dirección / tamaño',
            'Entrada',
            'Salida',
            'Comisiones',
            'Realizado neto',
          ],
          rows: snapshot.trades.map((trade) => ({
            id: trade.id,
            cells: [
              <>
                {trade.direction === 'long' ? 'Larga' : 'Corta'}
                <small>{trade.sizeBtc} BTC</small>
              </>,
              <>€{money(trade.entryEur)}</>,
              <>€{money(trade.exitEur)}</>,
              <>€{money(trade.entryFeeEur + trade.exitFeeEur)}</>,
              <>€{money(trade.realizedPnlEur)}</>,
            ],
          })),
        }}
        footnote={
          <>
            Cálculo demostrativo en EUR: variación de precio × cantidad BTC,
            menos comisiones estimadas del 0,04 % por lado. No representa spot,
            futuros ni resultados del motor de Balancita.
          </>
        }
      />
    </section>
  )
}
