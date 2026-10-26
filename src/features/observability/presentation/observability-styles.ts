const DETAILS =
  'text-hint leading-normal text-ink-2 health-summary:cursor-pointer health-summary:text-info health-summary:focus-visible:outline-2 health-summary:focus-visible:outline-info health-summary:focus-visible:outline-offset-2'
const CARD_LABEL =
  'mt-0 mr-0 ml-0 flex items-center justify-between gap-2 text-observer-label leading-normal font-semibold tracking-observer uppercase analyzer-value:text-note analyzer-value:leading-normal analyzer-value:text-ink'
const RESET_LIST = 'm-0 list-none p-0'

export const OBS = {
  health:
    'health-beacon inline-flex min-h-7 cursor-pointer items-center gap-2 rounded-sm border border-solid px-3 py-0 text-hint! leading-normal! font-medium! whitespace-nowrap text-ink',
  dot: 'size-1.5 bg-health-tone',
  flow: 'border-l border-l-solid border-l-line-strong pl-2 text-ink-2 flow-warn:text-warn flow-bad:text-short',
  mode: 'border-l border-l-solid border-l-line-strong pl-2 font-mono text-badge leading-normal font-semibold tracking-market text-warn',
  flowPanel:
    'mb-2 grid gap-1 rounded-sm border border-solid border-line bg-surface-2 px-4 py-2 text-hint leading-flow text-ink-2 run-copy:m-0 modal-ul:pl-4 flow-content:mt-2 health-summary:cursor-pointer health-summary:text-ink',
  flowTitle: 'font-semibold text-ink',
  flowScope: 'font-normal text-ink-2',
  backdrop:
    'fixed inset-0 z-50 flex items-center justify-center bg-health-overlay p-6 terminal-stack:pt-14 terminal-stack:pr-2 terminal-stack:pb-2 terminal-stack:pl-2',
  inspector:
    'flex max-h-inspector w-modal-wide flex-col rounded-lg border border-solid border-line-strong bg-surface-1 text-ink shadow-popover',
  inspectorHead:
    'flex flex-none items-center justify-between gap-3 border-b border-b-solid border-b-line px-4 py-3 modal-h2:m-0 modal-h2:text-value modal-h2:leading-normal modal-h2:font-semibold',
  meta: 'mt-1 mr-0 mb-0 ml-0 text-note leading-normal text-ink-2',
  overall: 'mt-0 mr-0 mb-3 ml-0 text-note leading-normal text-ink-2',
  inspectorBody:
    'min-h-0 flex-auto overflow-y-auto overscroll-contain px-4 py-3',
  inspectorFoot:
    'flex flex-none items-center justify-between gap-3 border-t border-t-solid border-t-line px-4 py-3 text-hint leading-normal text-ink-2',
  close:
    'min-h-8 cursor-pointer rounded-sm border-none border-current bg-long px-4 py-0 text-hint! leading-normal! font-semibold! text-on-long',
  group:
    'mt-3 mr-0 mb-2 ml-0 text-badge leading-normal font-bold tracking-eyebrow text-ink-2 uppercase',
  rows: `${RESET_LIST} grid gap-2`,
  row: 'rounded-lg border border-solid border-line bg-surface-2 px-4 py-3 health-warning:border-health-warning health-error:border-health-error health-ok:grid health-ok:grid-cols-health-row health-ok:items-center health-ok:gap-x-3 health-ok:gap-y-0 health-ok:px-3 health-ok:py-1.5 health-ok:health-row-summary:m-0 health-ok:health-row-summary:truncate health-ok:health-row-summary:text-hint health-ok:health-row-details:col-span-full health-ok:health-row-details:m-0 health-ok:health-row-details:text-label health-ok:health-row-details:leading-normal health-ok:health-row-details-summary:text-ink-2 health-ok:health-row-title:text-hint health-ok:health-row-title:whitespace-nowrap health-warning:border-l-3 health-warning:bg-health-warning health-error:border-l-3 health-error:bg-health-error health-warning:health-row-summary:text-ink health-warning:health-row-summary:text-note health-error:health-row-summary:text-ink health-error:health-row-summary:text-note',
  rowHead: 'flex items-center gap-3',
  rowTitle:
    'm-0 text-note leading-normal font-semibold tracking-health text-ink uppercase',
  rowSummary:
    'mt-1 mr-0 mb-0 ml-0 text-health-summary leading-normal text-ink-2',
  details: `${DETAILS} mt-2`,
  checks: `${RESET_LIST} mt-2 grid gap-2 health-item:grid health-item:gap-0.5 health-item:rounded-sm health-item:border health-item:border-solid health-item:border-line health-item:bg-surface-1 health-item:px-3 health-item:py-2`,
  checkLabel: 'font-medium text-ink',
  checkRule: 'text-ink-2',
  evidence:
    'mt-2 mr-0 mb-0 ml-0 grid gap-1 modal-dt:font-medium modal-dt:text-ink modal-dd:m-0',
  limitations: 'mt-2 modal-ul:m-0 modal-ul:pl-4.5',
  limitationsTitle: 'mt-0 mr-0 mb-1 ml-0 font-medium text-ink',
  observer:
    'observer-height flex min-h-140 flex-col chart-desktop:sticky chart-desktop:top-2 chart-desktop:min-h-120 chart-desktop:self-start',
  observerHead:
    'flex flex-none items-center justify-between gap-2 border-b border-b-solid border-b-line px-3 py-2 modal-h2:m-0 modal-h2:text-observer-heading modal-h2:leading-normal',
  now: 'flex-none border-b border-b-solid border-b-line-strong bg-surface-2 px-3 py-2 observer-long:text-long observer-short:text-short',
  nowLabel: `${CARD_LABEL} mb-0.5 text-warn`,
  observerBody:
    'grid min-h-0 flex-auto content-start gap-1.5 overflow-y-auto overscroll-contain p-2',
  segment:
    'inline-flex run-button:min-h-7 run-button:cursor-pointer run-button:border run-button:border-solid run-button:border-line-strong run-button:bg-surface-2 run-button:px-3 run-button:py-0 run-button:text-hint! run-button:leading-normal! run-button:text-ink-2 run-button:first:rounded-l-sm run-button:last:rounded-r-sm run-button:aria-pressed:bg-observer-selected run-button:aria-pressed:text-long',
  card: 'rounded-lg border border-solid border-line bg-surface-2 p-2',
  cardLabel: `${CARD_LABEL} mb-1.5 text-ink-2`,
  big: 'm-0 flex flex-wrap items-center gap-2 text-body leading-normal font-semibold',
  note: 'mt-1 mr-0 mb-0 ml-0 text-hint leading-normal text-ink-2',
  unavailable: 'tracking-normal text-ink-2 normal-case',
  experiments: `${RESET_LIST} grid gap-1 health-item:flex health-item:items-baseline health-item:justify-between health-item:gap-2 health-item:rounded-sm health-item:border health-item:border-solid health-item:border-line health-item:bg-surface-1 health-item:px-2 health-item:py-0.75 health-item:text-hint health-item:leading-normal analyzer-value-label:text-right analyzer-value-label:text-ink-2 panel-small:block panel-small:text-label panel-small:leading-normal panel-small:text-ink-2`,
  panelDetails: `${DETAILS} m-0 modal-ul:m-0 modal-ul:pl-4.5`,
  inlineDetails: `${DETAILS} mt-1 mr-0 mb-0 ml-0 text-health-detail leading-normal health-summary:text-ink-2`,
  pill: 'ml-0 inline-flex basis-full items-center gap-1.5',
  pillLabel:
    'text-observer-label leading-normal font-medium whitespace-nowrap text-ink-2',
  summary: 'mt-0.5 mr-0 mb-0 ml-0 text-health-summary leading-normal text-ink',
  nowKind: 'text-health-detail leading-normal text-ink-2',
  nowSource: 'block text-label leading-normal text-ink-2',
}
