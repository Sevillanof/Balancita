import {
  KIND_LABEL,
  masterGlyph,
  type DecisionKind,
  type DecisionView,
} from './terminal-decision-view.ts'

const BADGE: Record<DecisionKind, { glyph: string; tone: string }> = {
  'enter-long': { glyph: '▲', tone: 'bg-long/20 text-long' },
  'enter-short': { glyph: '▼', tone: 'bg-short/20 text-short' },
  exit: { glyph: '✕', tone: 'bg-info/20 text-info' },
  blocked: { glyph: '■', tone: 'bg-warn/20 text-warn' },
  hold: { glyph: '━', tone: 'bg-line text-ink-2' },
  wait: { glyph: '●', tone: 'bg-line text-ink-2' },
  skipped: { glyph: '?', tone: 'bg-line text-ink-2' },
}

const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-solid border-line px-2 py-0.5 text-label leading-normal whitespace-nowrap'

const sideTone = (side: 'long' | 'short' | 'flat' | null) =>
  side === 'long' ? 'text-long' : side === 'short' ? 'text-short' : 'text-ink-2'

const sideGlyph = (side: 'long' | 'short' | 'flat' | null) =>
  side === 'long' ? '▲' : side === 'short' ? '▼' : '●'

/** The big coloured badge and the two-word verdict. */
export function DecisionHead({ view }: { view: DecisionView }) {
  const badge = BADGE[view.kind]
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`inline-grid size-7 place-items-center rounded-md text-body font-bold ${badge.tone}`}
      >
        {badge.glyph}
      </span>
      <strong className="text-body" data-kind={view.kind}>
        {KIND_LABEL[view.kind]}
      </strong>
    </span>
  )
}

/** Master, keeper and Qwen's opinion as three small pills. */
export function DecisionChips({ view }: { view: DecisionView }) {
  const { opinion, gate, master } = view
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="chips">
      {master !== null && (
        <span
          className={`${CHIP} ${master > 0 ? 'text-long' : master < 0 ? 'text-short' : 'text-ink-2'}`}
          title="Maestro: hacia dónde va el precio en las próximas 12 h"
        >
          Maestro {masterGlyph(master)}
        </span>
      )}
      {gate !== null && (
        <span
          className={`${CHIP} ${gate ? 'text-long' : 'text-warn'}`}
          title="Portero: ¿conviene entrar ahora?"
        >
          Portero {gate ? '✓' : '✕'}
        </span>
      )}
      {opinion &&
        (opinion.state === 'none' ? (
          <span className={`${CHIP} text-ink-2`} title="Qwen no opinó">
            Qwen —
          </span>
        ) : (
          <span
            className={`${CHIP} ${opinion.state === 'agrees' ? sideTone(opinion.side) : 'border-warn text-warn'}`}
            title={
              opinion.state === 'agrees'
                ? 'Qwen coincide con la fórmula'
                : 'Qwen opina distinto que la fórmula'
            }
          >
            Qwen {sideGlyph(opinion.side)} {opinion.label}
            {opinion.p ? ` ${opinion.p}` : ''}{' '}
            {opinion.state === 'agrees' ? '✓' : '≠'}
          </span>
        ))}
    </span>
  )
}
