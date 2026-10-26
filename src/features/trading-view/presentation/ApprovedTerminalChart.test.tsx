import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ApprovedTerminalChart from './ApprovedTerminalChart.tsx'

const chartMocks = vi.hoisted(() => {
  const priceScaleApply = vi.fn()
  const candles = {
    priceScale: vi.fn(() => ({ applyOptions: priceScaleApply })),
    setData: vi.fn(),
    update: vi.fn(),
    priceToCoordinate: vi.fn(() => 100),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(),
    removePriceLine: vi.fn(),
  }
  const volume = {
    setData: vi.fn(),
    update: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  }
  const timeScale = {
    fitContent: vi.fn(),
    getVisibleLogicalRange: vi.fn(() => ({ from: 7, to: 74 })),
    setVisibleLogicalRange: vi.fn(),
    scrollToRealTime: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
    timeToCoordinate: vi.fn(
      (time: number) => ((time - 1_800_000_000) / 60) * 13,
    ),
    options: vi.fn(() => ({ barSpacing: 13 })),
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
    priceScaleApply,
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
                .getPropertyValue('--color-chart-surface')
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

  it('reads chart colors from the semantic theme instead of retired aliases or fallbacks', () => {
    const style = document.documentElement.style
    const colors = {
      '--color-chart-surface': '#111222',
      '--color-chart-line': '#333444',
      '--color-chart-up': '#555666',
    }
    const previous = Object.keys(colors).map((name) => [
      name,
      style.getPropertyValue(name),
      style.getPropertyPriority(name),
    ])
    try {
      for (const [name, value] of Object.entries(colors))
        style.setProperty(name, value)
      render(
        <ApprovedTerminalChart
          candles={candles}
          markers={[]}
          selectedId=""
          intervalSeconds={60}
          onSelect={vi.fn()}
        />,
      )
      expect(chartMocks.createChart).toHaveBeenCalledWith(
        expect.any(HTMLDivElement),
        expect.objectContaining({
          layout: expect.objectContaining({
            background: { type: 'solid', color: '#111222' },
          }),
          grid: expect.objectContaining({
            vertLines: expect.objectContaining({ color: '#333444' }),
          }),
        }),
      )
      expect(chartMocks.chart.addSeries).toHaveBeenCalledWith(
        'candles',
        expect.objectContaining({ upColor: '#555666' }),
      )
    } finally {
      for (const [name, value, priority] of previous)
        style.setProperty(name, value, priority)
    }
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
    const logicalRangeWrites =
      chartMocks.timeScale.setVisibleLogicalRange.mock.calls.length

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
    expect(chartMocks.candles.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: newest.time, close: 102 }),
    )
    expect(chartMocks.candles.setData).toHaveBeenCalledTimes(1)
    expect(chartMocks.timeScale.setVisibleLogicalRange).toHaveBeenCalledTimes(
      logicalRangeWrites,
    )

    const click = chartMocks.chart.subscribeClick.mock
      .calls[0]?.[0] as (event: { hoveredObjectId: string }) => void
    click({ hoveredObjectId: 'latest' })
    expect(onSelect).toHaveBeenCalledWith(newest.time, 'latest')
  })

  it('opens the marker under the pointer, never the label of the one beside it', () => {
    const onSelect = vi.fn()
    // A decision one candle before an EJEC. fill (13 px apart, as painted).
    const markers = [
      {
        id: 'PF_XBTUSD-1',
        time: candles[40]!.time,
        type: 'decision' as const,
        label: 'W×4',
        decisionStatus: 'abstained' as const,
      },
      {
        id: 'fill:3',
        time: candles[41]!.time,
        type: 'fill' as const,
        label: 'EJEC.',
        direction: 'long' as const,
      },
    ]
    render(
      <ApprovedTerminalChart
        candles={candles}
        markers={markers}
        selectedId=""
        intervalSeconds={60}
        initialViewport="approved-terminal"
        onSelect={onSelect}
      />,
    )
    const click = chartMocks.chart.subscribeClick.mock.calls[0]?.[0] as (
      event: Record<string, unknown>,
    ) => void
    const at = (index: number) => ({ x: index * 13, y: 112 })
    // The library says the DECISION (its label covers the fill); the fill's
    // own column decides.
    click({ point: at(41), hoveredObjectId: 'PF_XBTUSD-1' })
    expect(onSelect).toHaveBeenLastCalledWith(candles[41]!.time, 'fill:3')
    click({ point: at(40), hoveredObjectId: 'fill:3' })
    expect(onSelect).toHaveBeenLastCalledWith(candles[40]!.time, 'PF_XBTUSD-1')
    // The bare background, far below the glyphs, selects neither of them.
    onSelect.mockClear()
    click({ point: { x: 41 * 13, y: 500 }, hoveredObjectId: 'PF_XBTUSD-1' })
    click({ point: { x: 300 * 13, y: 112 }, time: candles[41]!.time })
    expect(onSelect).not.toHaveBeenCalled()
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

  it('formats the selected quote currency and incrementally updates the forming candle', () => {
    const props = {
      candles,
      markers: [],
      selectedId: '',
      intervalSeconds: 60,
      currency: 'USD' as const,
      initialViewport: 'approved-terminal' as const,
      onSelect: vi.fn(),
    }
    const view = render(<ApprovedTerminalChart {...props} />)
    const seriesOptions = chartMocks.chart.addSeries.mock.calls[0]?.[1] as {
      priceFormat: { formatter: (price: number) => string }
    }
    expect(seriesOptions.priceFormat.formatter(100_000)).toContain('$')
    const callsAfterBootstrap = chartMocks.candles.setData.mock.calls.length
    const newest = candles.at(-1)!
    view.rerender(
      <ApprovedTerminalChart
        {...props}
        candles={candles.map((candle, index) =>
          index === candles.length - 1
            ? { ...candle, close: 100_010, high: 100_020 }
            : candle,
        )}
      />,
    )
    expect(chartMocks.candles.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: newest.time, close: 100_010 }),
    )
    expect(chartMocks.volume.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: newest.time, value: newest.volume }),
    )
    expect(chartMocks.candles.setData).toHaveBeenCalledTimes(
      callsAfterBootstrap,
    )
  })

  it('never widens the price scale for a dense same-bucket marker stack', () => {
    const marker = (id: string) => ({
      id,
      time: candles[50]!.time,
      type: 'decision' as const,
      label: 'WAIT',
      decisionStatus: 'hold' as const,
    })
    render(
      <ApprovedTerminalChart
        candles={candles}
        markers={['a', 'b', 'c', 'd', 'e'].map(marker)}
        selectedId=""
        intervalSeconds={60}
        initialViewport="approved-terminal"
        onSelect={vi.fn()}
      />,
    )
    for (const call of chartMocks.priceScaleApply.mock.calls) {
      expect(call[0]).not.toEqual(
        expect.objectContaining({
          scaleMargins: expect.objectContaining({ top: expect.any(Number) }),
        }),
      )
    }
    const painted = chartMocks.markerApi.setMarkers.mock.calls.at(-1)?.[0] as {
      text: string
    }[]
    expect(painted).toHaveLength(5)
  })
})
