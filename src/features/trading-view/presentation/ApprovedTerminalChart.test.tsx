import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ApprovedTerminalChart from './ApprovedTerminalChart.tsx'

const chartMocks = vi.hoisted(() => {
  const candles = {
    setData: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
  }
  const volume = {
    setData: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  }
  const timeScale = {
    fitContent: vi.fn(),
    getVisibleLogicalRange: vi.fn(() => ({ from: 7, to: 74 })),
    setVisibleLogicalRange: vi.fn(),
    scrollToRealTime: vi.fn(),
  }
  const markerApi = { setMarkers: vi.fn() }
  const chart = {
    addSeries: vi.fn((series: string, options?: unknown) => {
      void options
      return series === 'candles' ? candles : volume
    }),
    timeScale: vi.fn(() => timeScale),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    remove: vi.fn(),
  }
  return {
    candles,
    volume,
    timeScale,
    markerApi,
    chart,
    createChart: vi.fn((container: HTMLElement, options: unknown) => {
      void container
      void options
      return chart
    }),
    createSeriesMarkers: vi.fn(() => markerApi),
  }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: 'candles',
  HistogramSeries: 'volume',
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
}))

const candles = Array.from({ length: 100 }, (_, index) => ({
  time: 1_800_000_000 + index * 60,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: index + 1,
}))

describe('approved connected terminal chart', () => {
  beforeEach(() => vi.clearAllMocks())

  it('restores the exported chart appearance and a compact initial view', () => {
    render(
      <ApprovedTerminalChart
        candles={candles}
        markers={[]}
        selectedId=""
        intervalSeconds={60}
        initialViewport="approved-terminal"
        onSelect={vi.fn()}
      />,
    )

    expect(chartMocks.createChart).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        layout: expect.objectContaining({
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 11,
          attributionLogo: true,
        }),
        localization: expect.objectContaining({ locale: 'es-ES' }),
        grid: expect.objectContaining({
          vertLines: expect.objectContaining({ style: 2 }),
          horzLines: expect.objectContaining({ style: 2 }),
        }),
        crosshair: expect.objectContaining({
          vertLine: expect.any(Object),
          horzLine: expect.any(Object),
        }),
        timeScale: expect.objectContaining({ rightOffset: 8, barSpacing: 8 }),
      }),
    )
    expect(chartMocks.createChart.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        layout: expect.objectContaining({
          background: {
            type: 'solid',
            color:
              getComputedStyle(document.documentElement)
                .getPropertyValue('--card')
                .trim() || '#171c20',
          },
        }),
      }),
    )
    expect(chartMocks.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: 33,
      to: 106,
    })
    const seriesOptions = chartMocks.chart.addSeries.mock.calls[0]?.[1] as {
      priceFormat: { formatter: (price: number) => string }
    }
    expect(seriesOptions.priceFormat.formatter(76_600)).toBe('76.600,00 €')
  })

  it('sorts newest-first decisions chronologically, keeps the selected newest marker, and preserves viewport on candle refresh', () => {
    const onSelect = vi.fn()
    const newest = candles.at(-1)!
    const decisions = [
      {
        id: 'latest',
        time: newest.time + 10,
        type: 'decision' as const,
        label: 'PEND',
        decisionStatus: 'pending' as const,
      },
      {
        id: 'earlier',
        time: candles[2]!.time + 10,
        type: 'decision' as const,
        label: 'ESPERA',
        decisionStatus: 'hold' as const,
      },
      {
        id: 'outside',
        time: newest.time + 120,
        type: 'decision' as const,
        label: 'NO',
        decisionStatus: 'abstained' as const,
      },
    ]
    const props = {
      candles,
      markers: decisions,
      selectedId: 'latest',
      intervalSeconds: 60,
      initialViewport: 'approved-terminal' as const,
      onSelect,
    }
    const view = render(<ApprovedTerminalChart {...props} />)

    expect(chartMocks.markerApi.setMarkers).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'earlier', time: candles[2]!.time }),
      expect.objectContaining({
        id: 'latest',
        time: newest.time,
        text: 'PEND ◀',
      }),
    ])
    expect(
      chartMocks.timeScale.setVisibleLogicalRange,
    ).toHaveBeenLastCalledWith({ from: 69, to: 129 })

    view.rerender(
      <ApprovedTerminalChart
        {...props}
        candles={candles.map((candle, index) =>
          index === 99 ? { ...candle, close: 102 } : candle,
        )}
      />,
    )
    expect(chartMocks.candles.setData).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ time: newest.time, close: 102 }),
      ]),
    )
    expect(
      chartMocks.timeScale.setVisibleLogicalRange,
    ).toHaveBeenLastCalledWith({ from: 7, to: 74 })

    const click = chartMocks.chart.subscribeClick.mock
      .calls[0]?.[0] as (event: { hoveredObjectId: string }) => void
    click({ hoveredObjectId: 'latest' })
    expect(onSelect).toHaveBeenCalledWith(newest.time, 'latest')
  })

  it('retains the newest 200 eligible markers after sorting', () => {
    const markers = Array.from({ length: 220 }, (_, index) => ({
      id: `decision-${index}`,
      time: candles[0]!.time + index / 220,
      type: 'decision' as const,
      label: 'ESPERA',
      decisionStatus: 'hold' as const,
    })).reverse()
    render(
      <ApprovedTerminalChart
        candles={candles}
        markers={markers}
        selectedId="decision-219"
        intervalSeconds={60}
        initialViewport="approved-terminal"
        onSelect={vi.fn()}
      />,
    )
    const rendered = chartMocks.markerApi.setMarkers.mock
      .lastCall?.[0] as Array<{ id: string; time: number }>
    expect(rendered).toHaveLength(200)
    expect(rendered[0]?.id).toBe('decision-20')
    expect(rendered.at(-1)?.id).toBe('decision-219')
    expect(rendered.map((marker) => marker.time)).toEqual(
      [...rendered.map((marker) => marker.time)].sort(
        (left, right) => left - right,
      ),
    )
  })
})
