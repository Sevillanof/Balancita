import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import { timeLogicalIndex } from '../../trading-view/domain/terminal-trade-model.ts'
import { coordinateOfLogical } from '../../trading-view/presentation/TerminalTradePrimitive.ts'
import {
  proyectar,
  type MarcaOperacion,
  type OperacionProyectada,
  type Vela,
} from '../domain/estrategias-velas.ts'

export type MarcoOperaciones = {
  ancho: number
  alto: number
  items: readonly OperacionProyectada[]
}

export const MARCO_VACIO: MarcoOperaciones = { ancho: 0, alto: 0, items: [] }

/**
 * Places the trades of both configurations on the candles. It draws nothing itself: on every change of the view it projects
 * the trades (entry instant and price → pixels, like the Terminal's trade primitive) and hands the frame to React, which
 * paints the SVG over the chart.
 */
export class VelasOperacionesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private redraw: (() => void) | null = null
  private marcas: readonly MarcaOperacion[] = []
  private velas: readonly Vela[] = []
  private tiempos: readonly number[] = []
  private segundos = 3600
  private firma = ''
  private readonly publicar: (marco: MarcoOperaciones) => void

  constructor(publicar: (marco: MarcoOperaciones) => void) {
    this.publicar = publicar
  }

  attached({
    chart,
    series,
    requestUpdate,
  }: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = chart
    this.series = series
    this.redraw = requestUpdate
    requestUpdate()
  }

  detached(): void {
    this.chart = null
    this.series = null
    this.redraw = null
    this.firma = ''
  }

  paneViews() {
    return []
  }

  setData(
    marcas: readonly MarcaOperacion[],
    velas: readonly Vela[],
    segundos: number,
  ): void {
    this.marcas = marcas
    this.velas = velas
    this.tiempos = velas.map((vela) => vela.t / 1000)
    this.segundos = segundos
    this.firma = ''
    this.redraw?.()
  }

  updateAllViews(): void {
    const chart = this.chart
    const series = this.series
    if (!chart || !series) return
    const { width, height } = chart.paneSize(0)
    const escala = chart.timeScale()
    const items = proyectar(this.marcas, this.velas, this.segundos * 1000, {
      ancho: width,
      alto: height,
      tiempo: (ms) => {
        const logico = timeLogicalIndex(this.tiempos, ms, this.segundos)
        return logico === null ? null : coordinateOfLogical(escala, logico)
      },
      precio: (precio) => series.priceToCoordinate(precio),
    })
    const firma = `${width}x${height}|${items
      .map(
        (i) =>
          `${i.par.id},${i.x.toFixed(1)},${i.y.toFixed(1)},${i.tramos
            .map((t) => `${t.quien}${t.x2.toFixed(1)}`)
            .join(',')}`,
      )
      .join(';')}`
    if (firma === this.firma) return
    this.firma = firma
    this.publicar({ ancho: width, alto: height, items })
  }
}
