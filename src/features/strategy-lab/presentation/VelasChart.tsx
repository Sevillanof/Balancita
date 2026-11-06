import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  buscarOperacion,
  contenidoTooltip,
  marcas as marcasVisibles,
  segundosDe,
  type IntervaloVelas,
  type OperacionProyectada,
  type ParOperacion,
  type Vela,
  type Visibilidad,
} from '../domain/estrategias-velas.ts'
import { TEXTO_TONO } from './estrategias-styles.ts'
import {
  MARCO_VACIO,
  VelasOperacionesPrimitive,
  type MarcoOperaciones,
} from './VelasOperacionesPrimitive.ts'

type Props = {
  velas: readonly Vela[]
  intervalo: IntervaloVelas
  pares: readonly ParOperacion[]
  visibles: Visibilidad
  /** The view reached the oldest candle held: ask for older ones. */
  onReachStart: () => void
  ariaLabel: string
}

function color(nombre: string, respaldo: string): string {
  if (typeof document === 'undefined') return respaldo
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(nombre)
      .trim() || respaldo
  )
}

const ANCHO_TOOLTIP = 224
const ALTO_TOOLTIP = 96

type Mira = { par: ParOperacion; x: number; y: number }

/**
 * ETH candles like the Terminal's (lightweight-charts) with the trades of the official Terminal (blue) and of the variant (amber)
 * painted over them: ▲/▼ at the entry, a horizontal line to the exit, ● at each exit, ✕ where the variant cut the trade, a dashed line with a hollow ○ for a trade the end of the tested window closed.
 */
export default function VelasChart({
  velas,
  intervalo,
  pares,
  visibles,
  onReachStart,
  ariaLabel,
}: Props) {
  const nodo = useRef<HTMLDivElement>(null)
  const grafico = useRef<IChartApi | null>(null)
  const serie = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const primitiva = useRef<VelasOperacionesPrimitive | null>(null)
  const dibujadas = useRef<{
    primera: number
    intervalo: IntervaloVelas
  } | null>(null)
  const alLlegar = useRef(onReachStart)
  const itemsRef = useRef<readonly OperacionProyectada[]>([])
  const visiblesRef = useRef(visibles)
  const [marco, setMarco] = useState<MarcoOperaciones>(MARCO_VACIO)
  const [mira, setMira] = useState<Mira | null>(null)

  useEffect(() => {
    alLlegar.current = onReachStart
  }, [onReachStart])

  useEffect(() => {
    visiblesRef.current = visibles
  }, [visibles])

  useEffect(() => {
    const contenedor = nodo.current
    if (!contenedor) return
    const colores = {
      fondo: color('--color-chart-surface', '#171c20'),
      texto: color('--color-chart-text', '#8b969a'),
      rejilla: color('--color-chart-line', '#252d31'),
      sube: color('--color-chart-up', '#55c7a2'),
      baja: color('--color-chart-down', '#ee7777'),
      info: color('--color-chart-info', '#79a9bd'),
    }
    const chart = createChart(contenedor, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colores.fondo },
        textColor: colores.texto,
        fontFamily: 'IBM Plex Mono, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      localization: { locale: 'es-ES' },
      grid: {
        vertLines: { color: colores.rejilla, style: 2 },
        horzLines: { color: colores.rejilla, style: 2 },
      },
      crosshair: {
        vertLine: {
          color: colores.info,
          labelBackgroundColor: colores.rejilla,
        },
        horzLine: {
          color: colores.info,
          labelBackgroundColor: colores.rejilla,
        },
      },
      rightPriceScale: { borderColor: colores.rejilla },
      timeScale: {
        borderColor: colores.rejilla,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        minBarSpacing: 0.1,
      },
      handleScroll: true,
      handleScale: true,
    })
    const velasSerie = chart.addSeries(CandlestickSeries, {
      upColor: colores.sube,
      downColor: colores.baja,
      borderVisible: false,
      wickUpColor: colores.sube,
      wickDownColor: colores.baja,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    const operaciones = new VelasOperacionesPrimitive((siguiente) => {
      itemsRef.current = siguiente.items
      setMarco(siguiente)
    })
    velasSerie.attachPrimitive(operaciones)
    const revisar = (rango: { from: number } | null) => {
      if (rango && rango.from < 20) alLlegar.current()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(revisar)
    const moverPuntero = (param: { point?: { x: number; y: number } }) => {
      const punto = param.point
      const item = punto
        ? buscarOperacion(itemsRef.current, punto.x, punto.y)
        : null
      setMira(item && punto ? { par: item.par, x: punto.x, y: punto.y } : null)
    }
    chart.subscribeCrosshairMove(moverPuntero)
    grafico.current = chart
    serie.current = velasSerie
    primitiva.current = operaciones
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(revisar)
      chart.unsubscribeCrosshairMove(moverPuntero)
      chart.remove()
      grafico.current = null
      serie.current = null
      primitiva.current = null
      dibujadas.current = null
      itemsRef.current = []
    }
  }, [])

  useEffect(() => {
    const chart = grafico.current
    const velasSerie = serie.current
    if (!chart || !velasSerie) return
    const escala = chart.timeScale()
    const anterior = dibujadas.current
    const rango =
      anterior && anterior.intervalo === intervalo
        ? escala.getVisibleLogicalRange()
        : null
    velasSerie.setData(
      velas.map((vela) => ({
        time: (vela.t / 1000) as UTCTimestamp,
        open: vela.o,
        high: vela.h,
        low: vela.l,
        close: vela.c,
      })),
    )
    const primera = velas[0]?.t ?? null
    if (primera === null) {
      dibujadas.current = null
    } else if (anterior && anterior.intervalo === intervalo && rango) {
      // Older candles went in on the left: the same candles stay under the cursor.
      if (primera < anterior.primera) {
        const desplazo = velas.filter(
          (vela) => vela.t < anterior.primera,
        ).length
        escala.setVisibleLogicalRange({
          from: rango.from + desplazo,
          to: rango.to + desplazo,
        })
      }
      dibujadas.current = { primera, intervalo }
    } else {
      escala.fitContent()
      dibujadas.current = { primera, intervalo }
    }
  }, [velas, intervalo])

  const marcas = useMemo(
    () => marcasVisibles(pares, visibles),
    [pares, visibles],
  )

  useEffect(() => {
    primitiva.current?.setData(marcas, velas, segundosDe(intervalo))
  }, [marcas, velas, intervalo])

  const tooltip = mira ? contenidoTooltip(mira.par, visibles) : null
  return (
    <div className="relative min-h-56 min-w-0 flex-1">
      <div
        ref={nodo}
        role="img"
        aria-label={ariaLabel}
        className="absolute inset-0"
      />
      <svg
        aria-hidden="true"
        width={marco.ancho}
        height={marco.alto}
        className="pointer-events-none absolute top-0 left-0 z-5"
      >
        {marco.items.map((item) => (
          <g
            key={item.par.id}
            data-testid="operacion-en-velas"
            data-lado={item.lado}
            data-entrada-ms={item.par.entradaMs}
          >
            {item.tramos.map((tramo) => {
              const tono =
                tramo.quien === 'oficial'
                  ? 'var(--color-info)'
                  : 'var(--color-warn)'
              return (
                <g key={tramo.quien} data-quien={tramo.quien}>
                  <line
                    x1={item.x}
                    x2={tramo.x2}
                    y1={tramo.y}
                    y2={tramo.y}
                    stroke={tono}
                    strokeWidth={2}
                    strokeOpacity={0.85}
                    strokeDasharray={tramo.finVentana ? '5 4' : undefined}
                  />
                  {tramo.finVentana ? (
                    <circle
                      data-testid="cierre-fin-ventana"
                      cx={tramo.x2}
                      cy={tramo.y}
                      r={4}
                      fill="none"
                      stroke={tono}
                      strokeWidth={2}
                    />
                  ) : tramo.cortada ? (
                    <path
                      data-testid="corte-variante"
                      d={`M${tramo.x2 - 4} ${tramo.y - 4} l8 8 M${tramo.x2 + 4} ${tramo.y - 4} l-8 8`}
                      stroke={tono}
                      strokeWidth={2}
                      fill="none"
                    />
                  ) : (
                    <circle
                      data-testid="cierre"
                      cx={tramo.x2}
                      cy={tramo.y}
                      r={4}
                      fill={tono}
                      stroke="var(--color-canvas)"
                      strokeWidth={1.5}
                    />
                  )}
                </g>
              )
            })}
            <path
              data-testid="entrada"
              d={`M${item.x} ${item.y + (item.lado === 'LONG' ? 10 : -10)}${
                item.lado === 'LONG' ? ' l-6 9 h12 z' : ' l-6 -9 h12 z'
              }`}
              fill="var(--color-ink)"
            />
          </g>
        ))}
      </svg>
      {mira && tooltip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 grid min-w-48 gap-0.5 rounded-control border border-solid border-line-strong bg-surface-2 px-2.5 py-2 text-hint shadow-menu"
          style={{
            left: Math.max(
              0,
              Math.min(
                mira.x + 14,
                (marco.ancho || ANCHO_TOOLTIP * 2) - ANCHO_TOOLTIP,
              ),
            ),
            top: Math.max(0, mira.y - ALTO_TOOLTIP),
          }}
        >
          <b className="font-semibold text-ink">{tooltip.titulo}</b>
          {tooltip.filas.map((fila) => (
            <div
              key={fila.quien}
              className="flex justify-between gap-3 font-mono"
            >
              <span
                className={fila.quien === 'oficial' ? 'text-info' : 'text-warn'}
              >
                {fila.etiqueta}
              </span>
              <span className={TEXTO_TONO[fila.tono]}>{fila.neto}</span>
            </div>
          ))}
          {tooltip.aviso && (
            <span className="mt-1 text-warn">{tooltip.aviso}</span>
          )}
          {tooltip.avisosFin?.map((aviso) => (
            <span key={aviso} className="mt-1 text-ink-2">
              {aviso}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
