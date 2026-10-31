export const TERMINAL_FRAME =
  'min-w-0 overflow-hidden rounded-panel border border-solid border-line bg-surface-1'

export const TERMINAL_CARD_LABEL =
  'mt-0 mb-3.5 text-badge tracking-eyebrow text-ink-2 uppercase'

export const TERMINAL_PANEL =
  'min-w-0 overflow-x-clip rounded-panel border border-solid border-line bg-surface-1 p-4 panel-small:text-control panel-small:text-ink-2 panel-h2:m-0 panel-h2:mb-panel-heading panel-h2:text-title panel-h2:leading-normal panel-h3:mt-4 panel-h3:mr-0 panel-h3:mb-2 panel-h3:ml-0 panel-h3:text-panel-subtitle panel-h3:leading-normal panel-dl:grid panel-dl:grid-cols-account panel-dl:gap-account panel-dl:tabular-nums panel-dd:m-0 panel-dd:font-account-mono'

export const TERMINAL_BUTTON =
  'my-1 mr-2 ml-0 min-h-10 cursor-pointer rounded-sm border border-solid border-line bg-surface-1 px-panel-heading py-account font-sans! text-body! leading-normal! text-ink enabled:hover:border-warn disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2! focus-visible:outline-warn! focus-visible:outline-offset-2!'

export const DECISION_TONES: Record<string, string> = {
  LONG: 'text-long',
  SHORT: 'text-short',
  CLOSE: 'font-semibold',
  WAIT: 'font-medium text-ink-2',
}
