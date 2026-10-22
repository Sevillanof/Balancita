import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ENTRY_SIZES,
  LEVERAGES,
  simulate,
  type SimResult,
} from '../domain/leverage-sim.ts'
import type {
  AnalyzerApi,
  AnalyzerCell,
  AnalyzerResponse,
} from '../infrastructure/analyzer-api.ts'
import ModalFrame from './ModalFrame.tsx'
import './AnalyzerModal.css'

type Props = {
  api: AnalyzerApi
  onClose: () => void
}

type View = 'gross' | 'net'

const SHORT: Record<string, string> = {
  PF_XBTUSD: 'BTC',
  PF_ETHUSD: 'ETH',
  PF_SOLUSD: 'SOL',
}
const productName = (product: string) =>
  SHORT[product] ?? product.replace(/^PF_/, '').replace(/USD$/, '')

const NUMBER = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const WHOLE = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })
const PERCENT = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })

/** USD con signo explícito; sin decimales cuando ya es grande. */
function usd(value: number, signed = true): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  const text =
    Math.abs(rounded) >= 100
      ? WHOLE.format(Math.abs(rounded))
      : NUMBER.format(Math.abs(rounded))
  if (rounded === 0) return `${text} USD`
  const sign = rounded < 0 ? '−' : signed ? '+' : ''
  return `${sign}${text} USD`
}

const rowKey = (cell: AnalyzerCell) =>
  `${cell.kind}|${cell.product}|${cell.window}|${cell.direction}`

function rowLabel(cell: AnalyzerCell): string {
  const kind =
    cell.kind === 'leader' ? 'BTC avisa' : `movimiento ${cell.window} min`
  const way = cell.direction === 'follow' ? 'seguir' : 'revertir'
  return `${productName(cell.product)} · ${kind} · ${way}`
}

const cellName = (cell: AnalyzerCell) =>
  `${rowLabel(cell)} · ${cell.horizon} min`

type Loaded =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'done'; response: AnalyzerResponse }

/**
 * «Analizador de señales»: las combinaciones del estudio sobre datos de
 * práctica, simuladas con el apalancamiento y la entrada que elijas. Solo
 * lee: no manda ninguna orden. Son hipótesis, no una aprobación.
 */
export default function AnalyzerModal({ api, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [leverage, setLeverage] = useState<number>(1)
  const [margin, setMargin] = useState<number>(100)
  const [view, setView] = useState<View>('gross')
  const [picked, setPicked] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    let alive = true
    api.events().then(
      (response) => {
        if (alive) setLoaded({ kind: 'done', response })
      },
      (failure: unknown) => {
        if (alive)
          setLoaded({
            kind: 'error',
            text: failure instanceof Error ? failure.message : String(failure),
          })
      },
    )
    return () => {
      alive = false
    }
  }, [api, attempt])

  const data =
    loaded.kind === 'done' && loaded.response.available
      ? loaded.response.data
      : null

  const sims = useMemo(() => {
    const map = new Map<string, SimResult>()
    if (data)
      for (const cell of data.cells)
        map.set(cell.id, simulate(cell, leverage, margin, data))
    return map
  }, [data, leverage, margin])

  const layout = useMemo(() => {
    if (!data) return null
    const horizons = [...new Set(data.cells.map((cell) => cell.horizon))].sort(
      (a, b) => a - b,
    )
    const rows = new Map<string, { label: string; cells: AnalyzerCell[] }>()
    for (const cell of data.cells) {
      const key = rowKey(cell)
      const row = rows.get(key) ?? { label: rowLabel(cell), cells: [] }
      row.cells.push(cell)
      rows.set(key, row)
    }
    return { horizons, rows: [...rows.entries()] }
  }, [data])

  const value = (id: string) => {
    const sim = sims.get(id)
    if (!sim || sim.n === 0) return null
    return view === 'gross' ? sim.grossUsd : sim.netUsd
  }
  const maxAbs = useMemo(() => {
    let max = 0
    for (const sim of sims.values()) {
      if (sim.n === 0) continue
      max = Math.max(
        max,
        Math.abs(view === 'gross' ? sim.grossUsd : sim.netUsd),
      )
    }
    return max
  }, [sims, view])

  const summary = useMemo(() => {
    if (!data) return null
    let gross = 0
    let net = 0
    let best: AnalyzerCell | null = null
    let worst: AnalyzerCell | null = null
    for (const cell of data.cells) {
      const sim = sims.get(cell.id)
      if (!sim || sim.n === 0) continue
      if (sim.grossUsd > 0) gross += 1
      if (sim.netUsd > 0) net += 1
      if (!best || sim.netUsd > (sims.get(best.id)?.netUsd ?? 0)) best = cell
      if (!worst || sim.netUsd < (sims.get(worst.id)?.netUsd ?? 0)) worst = cell
    }
    return { total: data.cells.length, gross, net, best, worst }
  }, [data, sims])

  const firstWithTrades = data?.cells.find(
    (cell) => (sims.get(cell.id)?.n ?? 0) > 0,
  )
  const selected =
    data?.cells.find((cell) => cell.id === picked) ??
    firstWithTrades ??
    data?.cells[0] ??
    null
  const detail = selected ? (sims.get(selected.id) ?? null) : null

  const copyCommand = (command: string) => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <ModalFrame label="Analizador de señales" onClose={onClose} xwide>
      <div className="analyzer__head">
        <h2>Analizador de señales</h2>
        <button
          ref={closeRef}
          type="button"
          className="smodal__button"
          onClick={onClose}
        >
          Cerrar
        </button>
      </div>

      {loaded.kind === 'loading' && (
        <p role="status" className="smodal__hint">
          Cargando el estudio…
        </p>
      )}
      {loaded.kind === 'error' && (
        <div>
          <p role="alert" className="smodal__notice" data-tone="warn">
            No se pudo leer el estudio: {loaded.text}
          </p>
          <div className="smodal__actions">
            <button
              type="button"
              className="smodal__button"
              onClick={() => {
                setLoaded({ kind: 'loading' })
                setAttempt((value) => value + 1)
              }}
            >
              Reintentar
            </button>
          </div>
        </div>
      )}
      {loaded.kind === 'done' && !loaded.response.available && (
        <div className="analyzer__off" data-testid="analyzer-off">
          <p className="smodal__notice" data-tone="warn">
            {loaded.response.reason}
          </p>
          <p className="smodal__hint">Para generarlo, corré este comando:</p>
          <pre aria-label="Comando">{loaded.response.command}</pre>
          <div className="smodal__actions">
            <button
              type="button"
              className="smodal__button"
              onClick={() =>
                loaded.response.available
                  ? undefined
                  : copyCommand(loaded.response.command)
              }
            >
              {copied ? 'Copiado' : 'Copiar comando'}
            </button>
          </div>
        </div>
      )}

      {data && layout && summary && (
        <>
          <p className="smodal__hint">
            Son hipótesis con datos de práctica del {data.window.from} al{' '}
            {data.window.to}, no una aprobación. Nada de esto manda órdenes.
          </p>

          <div className="analyzer__controls">
            <div role="group" aria-label="Apalancamiento">
              <span className="analyzer__label">Apalancamiento</span>
              <div className="analyzer__chips">
                {LEVERAGES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={leverage === item}
                    onClick={() => setLeverage(item)}
                  >
                    {item}×
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-label="Entrada por operación (USD)">
              <span className="analyzer__label">
                Entrada por operación (USD)
              </span>
              <div className="analyzer__chips">
                {ENTRY_SIZES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={margin === item}
                    onClick={() => setMargin(item)}
                  >
                    {WHOLE.format(item)}
                  </button>
                ))}
              </div>
            </div>
            <label className="analyzer__view">
              <span className="analyzer__label">Ver</span>
              <select
                value={view}
                onChange={(event) => setView(event.target.value as View)}
              >
                <option value="gross">Antes de costes</option>
                <option value="net">Después de costes</option>
              </select>
            </label>
          </div>

          <p className="analyzer__summary" data-testid="analyzer-summary">
            Con {leverage}× y {WHOLE.format(margin)} USD:{' '}
            <b>
              {summary.gross} de {summary.total}
            </b>{' '}
            combinaciones tienen bruto positivo (antes de costes) y{' '}
            <b>{summary.net}</b> siguen positivas después de costes.
            {summary.best && summary.worst && (
              <>
                {' '}
                La mejor después de costes es <b>{cellName(summary.best)}</b> (
                {usd(sims.get(summary.best.id)?.netUsd ?? 0)}); la peor,{' '}
                <b>{cellName(summary.worst)}</b> (
                {usd(sims.get(summary.worst.id)?.netUsd ?? 0)}).
              </>
            )}
          </p>

          <div className="analyzer__body">
            <div className="analyzer__gridwrap">
              <table
                className="analyzer__grid"
                aria-label={
                  view === 'gross'
                    ? 'Combinaciones, resultado antes de costes en USD'
                    : 'Combinaciones, resultado después de costes en USD'
                }
              >
                <thead>
                  <tr>
                    <th scope="col">Combinación</th>
                    {layout.horizons.map((horizon) => (
                      <th scope="col" key={horizon}>
                        {horizon} min
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {layout.rows.map(([key, row]) => (
                    <tr key={key}>
                      <th scope="row">{row.label}</th>
                      {layout.horizons.map((horizon) => {
                        const cell = row.cells.find(
                          (item) => item.horizon === horizon,
                        )
                        if (!cell)
                          return (
                            <td key={horizon} className="analyzer__none">
                              <span aria-hidden="true">·</span>
                            </td>
                          )
                        const sim = sims.get(cell.id)
                        const shown = value(cell.id)
                        const other =
                          view === 'gross' ? sim?.netUsd : sim?.grossUsd
                        const tone =
                          shown === null
                            ? 'none'
                            : shown > 0
                              ? 'gain'
                              : shown < 0
                                ? 'loss'
                                : 'none'
                        const strength =
                          shown !== null && maxAbs > 0
                            ? Math.min(1, Math.abs(shown) / maxAbs)
                            : 0
                        return (
                          <td key={horizon}>
                            <button
                              type="button"
                              className="analyzer__cell"
                              data-tone={tone}
                              style={
                                {
                                  '--k': 0.12 + 0.55 * strength,
                                } as React.CSSProperties
                              }
                              aria-pressed={selected?.id === cell.id}
                              aria-label={`${cellName(cell)}: ${
                                shown === null
                                  ? 'sin operaciones'
                                  : `${view === 'gross' ? 'antes de costes' : 'después de costes'} ${usd(shown)}, ${
                                      view === 'gross'
                                        ? 'después de costes'
                                        : 'antes de costes'
                                    } ${usd(other ?? 0)}${
                                      sim && sim.liquidations > 0
                                        ? `, ${sim.liquidations} liquidadas`
                                        : ''
                                    }`
                              }`}
                              onClick={() => setPicked(cell.id)}
                            >
                              {shown === null ? (
                                <span className="analyzer__cell-main">
                                  sin datos
                                </span>
                              ) : (
                                <>
                                  <span className="analyzer__cell-main">
                                    {usd(shown)}
                                  </span>
                                  <span className="analyzer__cell-sub">
                                    {view === 'gross' ? 'neto' : 'bruto'}{' '}
                                    {usd(other ?? 0)}
                                  </span>
                                </>
                              )}
                              {sim && sim.liquidations > 0 && (
                                <span
                                  className="analyzer__flag"
                                  aria-hidden="true"
                                >
                                  ⚠ {sim.liquidations}
                                </span>
                              )}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="analyzer__legend">
                Verde: ganancia. Rojo: pérdida. Gris: sin operaciones. ⚠ n:
                operaciones liquidadas.
              </p>
            </div>

            {selected && detail && (
              <section
                className="analyzer__detail"
                aria-label="Detalle de la combinación"
              >
                <h3>{rowLabel(selected)}</h3>
                <p className="smodal__hint">Mantener {selected.horizon} min</p>
                <div className="analyzer__bigs">
                  <div>
                    <span>Antes de costes</span>
                    <strong
                      data-testid="detail-gross"
                      data-tone={tone(detail.grossUsd, detail.n)}
                    >
                      {usd(detail.grossUsd)}
                    </strong>
                  </div>
                  <div>
                    <span>Después de costes (neto)</span>
                    <strong
                      data-testid="detail-net"
                      data-tone={tone(detail.netUsd, detail.n)}
                    >
                      {usd(detail.netUsd)}
                    </strong>
                  </div>
                </div>
                <dl>
                  <dt>Costes</dt>
                  <dd>{usd(-detail.costUsd)}</dd>
                  <dt>Funding</dt>
                  <dd>{usd(-detail.fundingUsd)}</dd>
                  <dt>Operaciones</dt>
                  <dd>{detail.n}</dd>
                  <dt>Acierto de dirección</dt>
                  <dd data-testid="detail-direction">
                    {PERCENT.format(detail.directionRate)} %{' '}
                    <small>(antes de costes)</small>
                  </dd>
                  <dt>Aciertos después de costes</dt>
                  <dd>{PERCENT.format(detail.hitRate)} %</dd>
                  <dt>Liquidadas</dt>
                  <dd data-testid="detail-liquidated">{detail.liquidations}</dd>
                  <dt>Caída máxima</dt>
                  <dd>
                    {usd(-detail.maxDrawdownUsd)} (
                    {PERCENT.format(detail.maxDrawdownPct)} % de la entrada)
                  </dd>
                  <dt>Peor operación</dt>
                  <dd>{usd(detail.worstUsd)}</dd>
                </dl>
                {detail.liquidations > 0 && (
                  <p
                    role="alert"
                    className="smodal__notice"
                    data-tone="warn"
                    data-testid="detail-alert"
                  >
                    Con {leverage}× se liquidarían {detail.liquidations}{' '}
                    {detail.liquidations === 1 ? 'operación' : 'operaciones'}:
                    en cada una se pierde toda la entrada.
                  </p>
                )}
                <EquityCurve equity={detail.equity} />
              </section>
            )}
          </div>

          <div className="analyzer__notes">
            {data.funding_complete === false && (
              <p className="smodal__notice" data-tone="warn">
                El funding está incompleto en parte del período: el resultado
                puede estar algo errado.
              </p>
            )}
            <p className="smodal__hint">
              Los costes están medidos para operaciones de unos 1.000 USD; con
              posiciones mucho más grandes el costo real sería peor. La
              liquidación es una aproximación (se pierde todo el margen cuando
              la pérdida llega a la mitad).
            </p>
          </div>
        </>
      )}
    </ModalFrame>
  )
}

function tone(value: number, n: number) {
  return n === 0 || value === 0 ? 'none' : value > 0 ? 'gain' : 'loss'
}

/** Curva de resultado acumulado, dibujada a mano (sin librerías). */
function EquityCurve({ equity }: { equity: number[] }) {
  const width = 320
  const height = 120
  const pad = 6
  const step = Math.max(1, Math.ceil(equity.length / 160))
  const points = equity.filter(
    (_, index) => index % step === 0 || index === equity.length - 1,
  )
  const low = Math.min(0, ...points)
  const high = Math.max(0, ...points)
  const span = high - low || 1
  const y = (v: number) => pad + ((high - v) / span) * (height - 2 * pad)
  const x = (i: number) =>
    pad +
    (points.length > 1 ? (i / (points.length - 1)) * (width - 2 * pad) : 0)
  const last = equity[equity.length - 1] ?? 0
  return (
    <figure className="analyzer__curve">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Resultado acumulado: de 0 a ${usd(last)} en ${equity.length - 1} operaciones`}
      >
        <line
          x1={pad}
          x2={width - pad}
          y1={y(0)}
          y2={y(0)}
          className="analyzer__zero"
        />
        {points.length > 1 && (
          <polyline
            fill="none"
            className="analyzer__line"
            data-tone={last >= 0 ? 'gain' : 'loss'}
            points={points.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
          />
        )}
      </svg>
      <figcaption>Resultado acumulado después de costes (USD)</figcaption>
    </figure>
  )
}
