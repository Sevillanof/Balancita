import { describe, expect, it } from 'vitest'
import {
  FUNDING_WS_ALIVE_MARK_INTERVAL_MS,
  FUNDING_WS_COVERAGE_MAX_SILENCE_MS,
  fundingObservationFromTicker,
} from './funding-ws.ts'
import { FuturesMarketStore } from './futures-market-store.ts'
import { KrakenFuturesMarketCollector } from './futures-market.ts'
import { parseHistoricalFundingResponse } from './historical-funding.ts'

const HOUR = 3_600_000
const T0 = Math.floor(1_790_000_000_000 / HOUR) * HOUR
const END = T0 + HOUR // close of the period that starts at T0

type Fields = Record<string, number | undefined>

// Hand-written Kraken ticker frame; numbers keep their literal text.
const frame = (now: number, fields: Fields = {}) =>
  JSON.stringify({
    feed: 'ticker',
    product_id: 'PF_XBTUSD',
    time: now,
    seq: 1,
    bid: 100,
    ask: 101,
    last: 100,
    markPrice: 100,
    index: 100,
    suspended: false,
    ...fields,
  })

const rate = (
  funding_rate: number,
  next = END,
  extra: Fields = {},
): Fields => ({
  funding_rate,
  relative_funding_rate: funding_rate / 100_000,
  next_funding_rate_time: next,
  ...extra,
})

function harness() {
  let now = T0 + 10_000
  type Sock = {
    onopen: (() => void) | null
    onmessage: ((event: { data: unknown }) => void) | null
    onerror: (() => void) | null
    onclose: (() => void) | null
    send: (message: string) => void
    close: () => void
  }
  let socket!: Sock
  const store = new FuturesMarketStore(':memory:')
  const failures: string[] = []
  const collector = new KrakenFuturesMarketCollector({
    clock: () => now,
    random: () => 0.5,
    bookFeed: false,
    makeSocket: () =>
      (socket = {
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: () => {},
        close: () => {},
      }),
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
    persist: (event) => store.append(event),
    persistGap: (gap) => store.appendGap(gap),
    persistFundingObservation: (o) => store.appendFundingWsObservation(o),
    persistFundingMark: (m) => store.appendFundingWsMark(m),
    onResilience: (e) => failures.push(e.reason),
  })
  collector.start()
  socket.onopen!()
  return {
    store,
    collector,
    failures,
    at: (ms: number) => (now = ms),
    advance: (ms: number) => (now += ms),
    send: (fields: Fields) =>
      socket.onmessage!({ data: frame(now, { seq: now, ...fields }) }),
    close: () => socket.onclose!(),
    reopen: () => {
      collector.reconnect('test_reconnect')
      collector.stop()
      collector.start()
      socket.onopen!()
    },
  }
}

const observations = (store: FuturesMarketStore) =>
  (
    store as unknown as {
      db: {
        prepare: (sql: string) => { all: () => Record<string, unknown>[] }
      }
    }
  ).db
    .prepare(
      'SELECT * FROM paper_futures_funding_ws_observations ORDER BY rowid',
    )
    .all()

describe('funding WS ticker parsing', () => {
  const ctx = {
    productId: 'PF_XBTUSD',
    receivedAt: 5,
    connectedAt: 1,
    firstAfterConnect: true,
  }

  it('stores omitted fields as an explicit zero and keeps predictions apart', () => {
    const o = fundingObservationFromTicker(
      {
        time: '7',
        funding_rate: '0.5',
        funding_rate_prediction: '9',
        relative_funding_rate_prediction: '1e-5',
        next_funding_rate_time: '3600000',
      },
      ctx,
    )
    expect(o).toMatchObject({
      fundingRate: '0.5',
      relativeFundingRate: '0',
      fundingRatePrediction: '9',
      relativeFundingRatePrediction: '1e-5',
      nextFundingRateTime: 3_600_000,
      eventTime: 7,
    })
    const none = fundingObservationFromTicker({ time: '7' }, ctx)
    expect(none.fundingRate).toBe('0')
    expect(none.nextFundingRateTime).toBe(0)
  })

  it('rejects non-decimal and non-integer time fields', () => {
    expect(() =>
      fundingObservationFromTicker({ time: '7', funding_rate: 'abc' }, ctx),
    ).toThrow(/funding_rate/)
    expect(() =>
      fundingObservationFromTicker(
        { time: '7', next_funding_rate_time: '1.5' },
        ctx,
      ),
    ).toThrow(/next_funding_rate_time/)
    expect(() => fundingObservationFromTicker({ time: '-1' }, ctx)).toThrow(
      /time/,
    )
    expect(() =>
      fundingObservationFromTicker({ time: '1', funding_rate: {} }, ctx),
    ).toThrow(/funding_rate/)
  })
})

describe('funding WS capture', () => {
  it('writes the first ticker, then only changes, and again after a reconnect', () => {
    const h = harness()
    h.send(rate(0.5))
    h.advance(1_000)
    h.send(rate(0.5)) // identical: not written
    h.advance(1_000)
    h.send(rate(0.5, END, { funding_rate_prediction: 2 })) // prediction moved
    h.advance(1_000)
    h.send(rate(0.5, END, { funding_rate_prediction: 2 })) // identical again
    h.advance(1_000)
    h.send(rate(0.6, END, { funding_rate_prediction: 2 }))
    h.reopen()
    h.advance(1_000)
    h.send(rate(0.6, END, { funding_rate_prediction: 2 })) // same values, new connection
    const rows = observations(h.store)
    expect(
      rows.map((r) => [r.funding_rate, r.funding_rate_prediction]),
    ).toEqual([
      ['0.5', '0'],
      ['0.5', '2'],
      ['0.6', '2'],
      ['0.6', '2'],
    ])
    expect(rows.map((r) => r.first_after_connect)).toEqual([1, 0, 0, 1])
    expect(h.failures).not.toContain('funding_ws_capture_failed')
  })

  it('a change of the relative rate alone is a change', () => {
    const h = harness()
    h.send(rate(0.5))
    h.advance(1_000)
    h.send({ ...rate(0.5), relative_funding_rate: 0.123 })
    expect(observations(h.store)).toHaveLength(2)
  })

  it('a next_funding_rate_time change alone is a change', () => {
    const h = harness()
    h.send(rate(0.5, END))
    h.advance(1_000)
    h.send(rate(0.5, END + HOUR))
    expect(observations(h.store)).toHaveLength(2)
  })

  it('writes alive marks at most every interval and a closed mark on close', () => {
    const h = harness()
    const marks = () =>
      (
        h.store as unknown as {
          db: { prepare: (s: string) => { all: () => unknown[] } }
        }
      ).db
        .prepare('SELECT kind,at FROM paper_futures_funding_ws_marks')
        .all()
    h.send(rate(0.5))
    h.advance(FUNDING_WS_ALIVE_MARK_INTERVAL_MS - 1)
    h.send(rate(0.5))
    expect(marks()).toHaveLength(1)
    h.advance(1)
    h.send(rate(0.5))
    expect(marks()).toHaveLength(2)
    h.advance(5)
    h.close()
    expect(marks().map((m) => (m as { kind: string }).kind)).toEqual([
      'alive',
      'alive',
      'closed',
    ])
  })

  it('a funding storage failure is reported and never stops the market capture', () => {
    const h = harness()
    ;(h.store as unknown as { db: { exec: (s: string) => void } }).db.exec(
      'DROP TABLE paper_futures_funding_ws_observations',
    )
    h.send(rate(0.5))
    expect(h.failures).toEqual(['funding_ws_capture_failed'])
    expect(h.collector.status).toBe('live')
    expect(h.store.eventCount()).toBe(1)
  })

  it('ignores tickers that do not come from an open connection', () => {
    const h = harness()
    h.collector.stop()
    h.send(rate(0.5))
    expect(observations(h.store)).toHaveLength(0)
  })

  it('observations and marks are append-only', () => {
    const h = harness()
    h.send(rate(0.5))
    const db = (h.store as unknown as { db: { exec: (s: string) => void } }).db
    for (const table of ['observations', 'marks']) {
      expect(() =>
        db.exec(`UPDATE paper_futures_funding_ws_${table} SET product_id='x'`),
      ).toThrow(/immutable/)
      expect(() =>
        db.exec(`DELETE FROM paper_futures_funding_ws_${table}`),
      ).toThrow(/immutable/)
    }
  })
})

describe('causal WS rate of a period', () => {
  const lastSecond = END - 1_000

  it('is the last funding_rate received before the close, with coverage up to it', () => {
    const h = harness()
    h.at(T0 + 10_000)
    h.send(rate(0.4))
    h.at(T0 + HOUR / 2)
    h.send(rate(0.5))
    h.at(lastSecond)
    h.send(rate(0.7))
    h.at(END + 2_000) // after the close: a new period, must not leak back
    h.send(rate(9, END + HOUR))
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'ok',
      fundingRate: '0.7',
      relativeFundingRate: '0.000007',
      observedAt: lastSecond,
      connectedAt: T0 + 10_000,
    })
  })

  it('a frame received exactly at the close does not count (strictly before)', () => {
    const h = harness()
    h.at(END - 10_000)
    h.send(rate(0.7))
    h.at(END)
    h.send(rate(0.8))
    const result = h.store.fundingWsRate('PF_XBTUSD', END)
    expect(result).toMatchObject({ status: 'ok', fundingRate: '0.7' })
  })

  it('a close that happens exactly at the period end does not undo the coverage', () => {
    const h = harness()
    h.at(END - 5_000)
    h.send(rate(0.7))
    h.at(END)
    h.close()
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toMatchObject({
      status: 'ok',
      fundingRate: '0.7',
    })
  })

  it('never returns a prediction as the rate, not even when the rate is zero', () => {
    const h = harness()
    h.at(END - 5_000)
    h.send({
      next_funding_rate_time: END,
      funding_rate_prediction: 3,
      relative_funding_rate_prediction: 0.00003,
    })
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toMatchObject({
      status: 'ok',
      fundingRate: '0',
      relativeFundingRate: '0',
    })
  })

  it('has no rate when the socket was closed at the close', () => {
    const h = harness()
    h.at(END - 20_000)
    h.send(rate(0.7))
    h.at(END - 10_000)
    h.close()
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'no_coverage',
    })
  })

  it('has no rate when the last proof of life is too old, and has it at the limit', () => {
    const h = harness()
    h.at(END - FUNDING_WS_COVERAGE_MAX_SILENCE_MS)
    h.send(rate(0.7))
    expect(h.store.fundingWsRate('PF_XBTUSD', END).status).toBe('ok')
    const late = harness()
    late.at(END - FUNDING_WS_COVERAGE_MAX_SILENCE_MS - 1)
    late.send(rate(0.7))
    expect(late.store.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'no_coverage',
    })
  })

  it('reports no observation, a period mismatch and a connection mismatch', () => {
    const empty = new FuturesMarketStore(':memory:')
    expect(empty.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'no_coverage',
    })
    // The next period already announced before the close: not this period.
    const h = harness()
    h.at(END - 5_000)
    h.send(rate(0.7, END + HOUR))
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'period_mismatch',
    })
    // An alive mark of a connection that wrote no observation of its own.
    const m = new FuturesMarketStore(':memory:')
    m.appendFundingWsObservation({
      productId: 'PF_XBTUSD',
      receivedAt: END - 50_000,
      eventTime: END - 50_000,
      connectedAt: 1,
      firstAfterConnect: true,
      fundingRate: '1',
      relativeFundingRate: '0',
      fundingRatePrediction: '0',
      relativeFundingRatePrediction: '0',
      nextFundingRateTime: END,
    })
    m.appendFundingWsMark({
      productId: 'PF_XBTUSD',
      at: END - 5_000,
      connectedAt: 2,
      kind: 'alive',
    })
    expect(m.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'connection_mismatch',
    })
    const none = new FuturesMarketStore(':memory:')
    none.appendFundingWsMark({
      productId: 'PF_XBTUSD',
      at: END - 5_000,
      connectedAt: 2,
      kind: 'alive',
    })
    expect(none.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'no_observation',
    })
  })

  it('rejects a close that is not an hour boundary and other products have no rate', () => {
    const h = harness()
    expect(() => h.store.fundingWsRate('PF_XBTUSD', END + 1)).toThrow(
      /hour boundary/,
    )
    h.at(END - 5_000)
    h.send(rate(0.7))
    expect(h.store.fundingWsRate('PF_ETHUSD', END).status).toBe('unavailable')
  })

  it('reports no_table on a read-only database that predates the tables', () => {
    const h = harness()
    ;(h.store as unknown as { db: { exec: (s: string) => void } }).db.exec(
      'DROP TABLE paper_futures_funding_ws_marks',
    )
    expect(h.store.fundingWsRate('PF_XBTUSD', END)).toEqual({
      status: 'unavailable',
      reason: 'no_table',
    })
  })
})

describe('WS rate against REST sightings', () => {
  const sight = (
    store: FuturesMarketStore,
    k: number,
    text: string,
    lateMs = 0,
  ) => {
    const receivedAt = T0 + (k + 1) * HOUR + 30_000 + lateMs
    store.recordFundingPoll({
      productId: 'PF_XBTUSD',
      purpose: 'hourly',
      scheduledAt: receivedAt - 5,
      startedAt: receivedAt - 3,
      finishedAt: receivedAt,
      outcome: 'ok',
      response: parseHistoricalFundingResponse(
        JSON.stringify({
          result: 'success',
          serverTime: new Date(receivedAt).toISOString(),
          rates: [
            {
              timestamp: new Date(T0 + k * HOUR).toISOString(),
              fundingRate: Number(text),
              relativeFundingRate: 0.00001,
            },
          ],
        }),
        receivedAt,
      ),
    })
  }

  it('counts matches, mismatches and one-sided periods without resolving any', () => {
    const h = harness()
    // Period 0: same rate on both sides. Period 1: WS differs. Period 2: REST
    // only (socket closed at that close). Period 3: WS only.
    h.at(T0 + HOUR - 5_000)
    h.send(rate(0.5, T0 + HOUR))
    h.at(T0 + 2 * HOUR - 5_000)
    h.send(rate(0.6, T0 + 2 * HOUR))
    h.at(T0 + 2 * HOUR + 60_000)
    h.close()
    h.reopen()
    h.at(T0 + 4 * HOUR - 5_000)
    h.send(rate(0.8, T0 + 4 * HOUR))
    sight(h.store, 0, '0.5')
    sight(h.store, 1, '0.61')
    sight(h.store, 2, '0.7')
    const cmp = h.store.compareFundingWsWithSightings(
      'PF_XBTUSD',
      T0 + 9 * HOUR,
    )
    expect(cmp).toEqual({
      compared: 2,
      matched: 1,
      mismatched: 1,
      onlyWs: 1,
      onlyRest: 1,
      mismatches: [{ startMs: T0 + HOUR, ws: '0.6', rest: '0.61' }],
    })
  })

  it('skips announced period ends that are not hour boundaries instead of failing', () => {
    const h = harness()
    h.at(T0 + 60_000)
    h.send(rate(0.5, T0 + HOUR + 1))
    expect(
      h.store.compareFundingWsWithSightings('PF_XBTUSD', T0 + 9 * HOUR),
    ).toMatchObject({ compared: 0, onlyWs: 0 })
  })

  it('uses the latest sighting of a period and ignores periods after the cutoff', () => {
    const h = harness()
    h.at(T0 + HOUR - 5_000)
    h.send(rate(0.5, T0 + HOUR))
    sight(h.store, 0, '0.4')
    sight(h.store, 0, '0.5', 60_000)
    expect(
      h.store.compareFundingWsWithSightings('PF_XBTUSD', T0 + 9 * HOUR),
    ).toMatchObject({ compared: 1, matched: 1, mismatched: 0 })
    // At the close there is no sighting yet: the WS rate is already known.
    expect(
      h.store.compareFundingWsWithSightings('PF_XBTUSD', T0 + HOUR),
    ).toMatchObject({ compared: 0, onlyWs: 1, onlyRest: 0 })
  })
})
