import type { DemoCandle, DemoSnapshot, DemoTrade } from './types.ts'

const END_TIME = Date.UTC(2026, 8, 30, 17, 45) / 1000
const FEE_RATE = 0.0004
const round = (value: number) => Math.round(value * 100) / 100

export type DemoTradingProvider = {
  getSnapshot(): DemoSnapshot
  subscribe(listener: (snapshot: DemoSnapshot) => void): () => void
  pause(): void
  resume(): void
  reset(): DemoSnapshot
}

export function createDemoSnapshot(): DemoSnapshot {
  const candles: DemoCandle[] = []
  let previous = 63240
  for (let i = 0; i < 120; i += 1) {
    const drift =
      Math.sin(i * 0.19) * 77 +
      Math.sin(i * 0.57) * 39 +
      (i > 37 && i < 70 ? 29 : 0) -
      (i > 75 && i < 95 ? 24 : 0) +
      (i > 99 ? 15 : 0)
    const close = round(previous + drift + (i >= 86 && i <= 92 ? 135 : 0))
    const wick = 35 + Math.abs(Math.sin(i * 1.91)) * 60
    candles.push({
      time: END_TIME - (119 - i) * 60,
      open: previous,
      high: round(Math.max(previous, close) + wick),
      low: round(Math.min(previous, close) - wick * 0.82),
      close,
      volume: Math.round(16 + Math.abs(Math.sin(i * 0.73)) * 35),
    })
    previous = close
  }
  const event = (
    id: string,
    index: number,
    kind: DemoSnapshot['decisions'][number]['kind'],
    reason: string,
    direction?: 'long' | 'short',
    positionId?: string,
  ) => ({
    id,
    time: candles[index]!.time,
    kind,
    ...(direction ? { direction } : {}),
    price: candles[index]!.close,
    reason,
    ...(positionId ? { positionId } : {}),
  })
  const decisions: DemoSnapshot['decisions'] = [
    event(
      'decision-01',
      27,
      'discard',
      'Ruptura descartada: el volumen no confirma el movimiento.',
    ),
    {
      ...event(
        'decision-02',
        43,
        'entry',
        'Entrada larga ilustrativa tras ruptura con volumen.',
        'long',
        'position-01',
      ),
      executionId: 'execution-01',
    },
    event(
      'decision-03',
      53,
      'discard',
      'Señal corta descartada: no se confirma tendencia bajista.',
      'short',
    ),
    {
      ...event(
        'decision-04',
        68,
        'exit',
        'Salida larga ilustrativa al alcanzar el objetivo.',
        'long',
        'position-01',
      ),
      executionId: 'execution-02',
    },
    {
      ...event(
        'decision-05',
        78,
        'entry',
        'Entrada corta ilustrativa tras pérdida de soporte.',
        'short',
        'position-02',
      ),
      executionId: 'execution-03',
    },
    {
      ...event(
        'decision-06',
        92,
        'exit',
        'Salida corta ilustrativa tras alcanzar el stop.',
        'short',
        'position-02',
      ),
      executionId: 'execution-04',
    },
    event(
      'decision-07',
      98,
      'discard',
      'Entrada descartada: relación riesgo/beneficio insuficiente.',
      'long',
    ),
    {
      ...event(
        'decision-08',
        105,
        'entry',
        'Entrada larga ilustrativa tras recuperar resistencia.',
        'long',
        'position-03',
      ),
      executionId: 'execution-05',
    },
  ]
  const makeTrade = (
    id: string,
    positionId: string,
    direction: 'long' | 'short',
    entryIndex: number,
    exitIndex: number,
    sizeBtc: number,
  ): DemoTrade => {
    const entryEur = candles[entryIndex]!.close
    const exitEur = candles[exitIndex]!.close
    const entryFeeEur = round(entryEur * sizeBtc * FEE_RATE)
    const exitFeeEur = round(exitEur * sizeBtc * FEE_RATE)
    const gross =
      (exitEur - entryEur) * sizeBtc * (direction === 'long' ? 1 : -1)
    return {
      id,
      positionId,
      direction,
      sizeBtc,
      entryEur,
      exitEur,
      entryFeeEur,
      exitFeeEur,
      realizedPnlEur: round(gross - entryFeeEur - exitFeeEur),
      entryTime: candles[entryIndex]!.time,
      exitTime: candles[exitIndex]!.time,
      stopEur: round(entryEur + (direction === 'long' ? -240 : 240)),
      targetEur: round(entryEur + (direction === 'long' ? 310 : -310)),
    }
  }
  const trades = [
    makeTrade('trade-01', 'position-01', 'long', 43, 68, 0.12),
    makeTrade('trade-02', 'position-02', 'short', 78, 92, 0.08),
  ] satisfies readonly DemoTrade[]
  const entryEur = candles[105]!.close
  const sizeBtc = 0.15
  return {
    candles,
    decisions,
    trades,
    positions: [
      {
        id: 'position-03',
        direction: 'long',
        sizeBtc,
        entryEur,
        entryTime: candles[105]!.time,
        entryFeeEur: round(entryEur * sizeBtc * FEE_RATE),
        stopEur: round(entryEur - 240),
        targetEur: round(entryEur + 310),
      },
    ],
    lastUpdate: candles.at(-1)!.time,
  }
}

export function openUnrealizedPnl(
  position: DemoSnapshot['positions'][number],
  markEur: number,
): number {
  const direction = position.direction === 'long' ? 1 : -1
  const exitFee = markEur * position.sizeBtc * FEE_RATE
  return round(
    (markEur - position.entryEur) * position.sizeBtc * direction -
      position.entryFeeEur -
      exitFee,
  )
}

export function createDemoTradingProvider(tickMs = 2500): DemoTradingProvider {
  let snapshot = createDemoSnapshot()
  let tick = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<(snapshot: DemoSnapshot) => void>()
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    if (timer !== undefined || listeners.size === 0) return
    timer = setInterval(() => {
      tick += 1
      const candles = [...snapshot.candles]
      const last = candles.at(-1)!
      const change = Math.sin(tick * 1.4) * 27 + Math.cos(tick * 0.42) * 13
      const close = round(last.close + change)
      const next =
        tick % 8 === 0
          ? {
              time: last.time + 60,
              open: last.close,
              high: round(Math.max(last.close, close) + 12),
              low: round(Math.min(last.close, close) - 12),
              close,
              volume: 6,
            }
          : {
              ...last,
              high: round(Math.max(last.high, close)),
              low: round(Math.min(last.low, close)),
              close,
              volume: last.volume + 2,
            }
      if (tick % 8 === 0) candles.push(next)
      else candles[candles.length - 1] = next
      const decisions = [...snapshot.decisions]
      let positions = [...snapshot.positions]
      const trades = [...snapshot.trades]
      if (tick % 24 === 8) {
        const id = `demo-position-${tick}`
        const direction = Math.floor(tick / 24) % 2 === 0 ? 'long' : 'short'
        const sizeBtc = 0.01
        const entryEur = next.close
        positions.push({
          id,
          direction,
          sizeBtc,
          entryEur,
          entryTime: next.time,
          entryFeeEur: round(entryEur * sizeBtc * FEE_RATE),
          stopEur: round(entryEur + (direction === 'long' ? -240 : 240)),
          targetEur: round(entryEur + (direction === 'long' ? 310 : -310)),
        })
        decisions.push({
          id: `demo-decision-${tick}`,
          time: next.time,
          kind: 'entry',
          direction,
          price: next.close,
          reason: `Entrada ${direction === 'long' ? 'larga' : 'corta'} ilustrativa del reloj de simulación.`,
          executionId: `demo-execution-${tick}`,
          positionId: id,
        })
      } else if (tick % 24 === 16) {
        const position = positions.find(
          ({ id }) => id === `demo-position-${tick - 8}`,
        )
        if (position) {
          const exitFeeEur = round(next.close * position.sizeBtc * FEE_RATE)
          const gross =
            (next.close - position.entryEur) *
            position.sizeBtc *
            (position.direction === 'long' ? 1 : -1)
          const tradeId = `demo-trade-${tick}`
          trades.push({
            id: tradeId,
            positionId: position.id,
            direction: position.direction,
            sizeBtc: position.sizeBtc,
            entryEur: position.entryEur,
            exitEur: next.close,
            entryFeeEur: position.entryFeeEur,
            exitFeeEur,
            realizedPnlEur: round(gross - position.entryFeeEur - exitFeeEur),
            entryTime: position.entryTime,
            exitTime: next.time,
            stopEur: position.stopEur,
            targetEur: position.targetEur,
          })
          positions = positions.filter(({ id }) => id !== position.id)
          decisions.push({
            id: `demo-decision-${tick}`,
            time: next.time,
            kind: 'exit',
            direction: position.direction,
            price: next.close,
            reason:
              'Cierre ilustrativo de la posición abierta en el escenario.',
            executionId: `demo-execution-${tick}`,
            positionId: position.id,
          })
        }
      } else if (tick % 24 === 0) {
        decisions.push({
          id: `demo-decision-${tick}`,
          time: next.time,
          kind: 'discard',
          price: next.close,
          reason:
            'Señal descartada en el escenario ilustrativo; no se crea una ejecución.',
        })
      }
      snapshot = {
        ...snapshot,
        candles,
        decisions,
        positions,
        trades,
        lastUpdate: next.time,
      }
      listeners.forEach((listener) => listener(snapshot))
    }, tickMs)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    pause: stop,
    resume: start,
    reset() {
      stop()
      tick = 0
      snapshot = createDemoSnapshot()
      listeners.forEach((listener) => listener(snapshot))
      return snapshot
    },
  }
}
