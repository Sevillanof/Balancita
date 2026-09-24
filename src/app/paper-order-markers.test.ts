import { describe, expect, it } from 'vitest'
import { paperOrderMarkers } from './paper-order-markers.ts'

describe('paperOrderMarkers', () => {
  it('maps fills and gate rejections to candle seconds and excludes unloaded times', () => {
    const markers = paperOrderMarkers(
      [
        {
          id: 1,
          action: 'BUY',
          gatePassed: true,
          executionTimestamp: 120,
          signalTimestamp: 60,
          amountEur: 30,
        },
        {
          id: 2,
          action: 'SELL',
          gatePassed: true,
          executionTimestamp: 180,
          signalTimestamp: 120,
          amountEur: 30,
        },
        {
          id: 3,
          action: 'BUY',
          gatePassed: false,
          executionTimestamp: null,
          signalTimestamp: 240,
          amountEur: 30,
        },
        {
          id: 4,
          action: 'SELL',
          gatePassed: true,
          executionTimestamp: 999,
          signalTimestamp: 900,
          amountEur: 30,
        },
      ],
      new Set([120, 180, 180]),
    )
    expect(markers).toMatchObject([
      {
        time: 120,
        position: 'belowBar',
        color: '#26a69a',
        shape: 'arrowUp',
        text: 'BUY 30€',
      },
      {
        time: 180,
        position: 'aboveBar',
        color: '#ef5350',
        shape: 'arrowDown',
        text: 'SELL',
      },
      {
        time: 180,
        position: 'aboveBar',
        color: '#787b86',
        shape: 'circle',
        text: 'Gate < 0.60%',
      },
    ])
  })

  it('sorts mixed rejected and executed markers by numeric candle time', () => {
    const markers = paperOrderMarkers(
      [
        {
          id: 1,
          action: 'BUY',
          gatePassed: true,
          executionTimestamp: 121,
          signalTimestamp: 120,
          amountEur: 30,
        },
        {
          id: 2,
          action: 'BUY',
          gatePassed: false,
          executionTimestamp: null,
          signalTimestamp: 180,
          amountEur: 30,
        },
        {
          id: 3,
          action: 'SELL',
          gatePassed: true,
          executionTimestamp: 60,
          signalTimestamp: 120,
          amountEur: 30,
        },
      ],
      new Set([60, 120, 121]),
    )

    expect(markers.map(({ time }) => time)).toEqual([60, 120, 121])
  })
})
