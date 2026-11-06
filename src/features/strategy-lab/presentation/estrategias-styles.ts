export const EYEBROW =
  'm-0 text-label leading-normal font-medium tracking-section text-ink-2 uppercase'

export const BOTON =
  'inline-flex h-8 min-h-8 cursor-pointer items-center gap-1.5 rounded-control border border-solid border-line bg-surface-2 px-3 py-0 text-note leading-normal whitespace-nowrap text-ink hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50'

export const BOTON_PRIMARIO =
  'inline-flex h-8 min-h-8 cursor-pointer items-center gap-1.5 rounded-control border border-solid border-info bg-info px-3 py-0 text-note leading-normal font-semibold whitespace-nowrap text-canvas hover:bg-info disabled:cursor-not-allowed disabled:opacity-50'

export const CAMPO =
  'h-8 min-h-8 rounded-control border border-solid border-line-strong bg-surface-2 px-2 py-0 text-note text-ink'

export const AVISO =
  'm-0 rounded-control border border-solid border-warn px-3 py-2 text-note leading-normal text-ink'

export const PANEL = 'rounded-lg border border-solid border-line bg-surface-1'

export const TAG: Record<string, string> = {
  long: 'bg-long/15 text-long',
  short: 'bg-short/15 text-short',
  warn: 'bg-warn/15 text-warn',
  info: 'bg-info/15 text-info',
  neutral: 'bg-line text-ink-2',
}

export const TEXTO_TONO: Record<string, string> = {
  long: 'text-long',
  short: 'text-short',
  warn: 'text-warn',
  info: 'text-info',
  neutral: 'text-ink-2',
}
