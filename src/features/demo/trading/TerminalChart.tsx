import ApprovedTerminalChart, {
  type ApprovedTerminalLevel,
  type ApprovedTerminalMarker,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import type {
  DemoCandle,
  DemoDecision,
  DemoPosition,
  DemoTrade,
} from './types.ts'
import type { TerminalInterval } from './terminal-model.ts'

type Props = {
  candles: readonly DemoCandle[]
  decisions: readonly DemoDecision[]
  positions: readonly DemoPosition[]
  trades: readonly DemoTrade[]
  selectedId: string
  interval: TerminalInterval
  onBucketSelect: (time: number, markerId?: string) => void
}

const intervalSeconds: Record<TerminalInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
}

export default function TerminalChart({
  candles,
  decisions,
  positions,
  trades,
  selectedId,
  interval,
  onBucketSelect,
}: Props) {
  const markers: ApprovedTerminalMarker[] = decisions.map((decision) => ({
    id: decision.id,
    time: decision.time,
    type: decision.kind,
    direction: decision.direction,
    label:
      decision.kind === 'discard'
        ? 'DESC'
        : decision.kind === 'exit'
          ? 'SAL'
          : decision.direction === 'short'
            ? 'CORTO'
            : 'LARGO',
    positionId: decision.positionId,
  }))
  const levels: ApprovedTerminalLevel[] = [
    ...positions.map((item) => ({
      positionId: item.id,
      stop: item.stopEur,
      target: item.targetEur,
    })),
    ...trades.map((item) => ({
      positionId: item.positionId,
      stop: item.stopEur,
      target: item.targetEur,
    })),
  ]

  return (
    <ApprovedTerminalChart
      candles={candles}
      markers={markers}
      selectedId={selectedId}
      intervalSeconds={intervalSeconds[interval]}
      levels={levels}
      onSelect={(time) => onBucketSelect(time)}
      ariaLabel="Gráfico ilustrativo de velas BTC/EUR con volumen; cada decisión está descrita y es seleccionable en la lista accesible"
    />
  )
}
