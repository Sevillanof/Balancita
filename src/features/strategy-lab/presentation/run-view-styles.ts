export const RUN = {
  card: 'grid min-w-0 gap-3 rounded-lg border border-solid border-line bg-surface-1 p-4',
  head: 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2',
  title:
    'm-0 block text-run-title leading-normal font-semibold text-ink panel-small:text-note panel-small:leading-normal panel-small:font-normal panel-small:text-ink-2',
  hint: 'm-0 text-note leading-normal text-ink-2',
  probe:
    'cursor-pointer! rounded-sm border border-solid border-long! bg-long! px-3.5! py-1.5! text-note! font-semibold text-on-long!',
  probeMenu:
    'absolute top-full right-0 z-10 mt-1 hidden w-72 gap-1 rounded-lg border border-solid border-line-strong bg-surface-2 p-1 data-open:grid *:text-left!',
  stageLabel: 'm-0 text-body text-ink',
  warn: 'm-0 rounded-sm border border-solid border-warn px-2.5 py-2 text-note leading-normal text-ink',
  stages: 'm-0 grid list-none grid-cols-5 gap-2 p-0',
  stage:
    'grid gap-1.5 text-center stage-reached:bg-info stage-current:font-semibold stage-current:text-ink',
  stageBar: 'h-1.5 rounded-badge bg-surface-2',
  stageName: 'text-note leading-normal text-ink-2',
  kpis: 'grid grid-cols-4 gap-3 run-stack:grid-cols-2',
  kpi: 'grid gap-1 rounded-lg border border-solid border-line bg-canvas px-3.5 py-3',
  kpiLabel: 'text-note leading-normal text-ink-2',
  kpiValue:
    'text-run-value leading-kpi text-ink tabular-nums data-bad:text-short',
  chartCard: 'grid min-w-0 gap-2.5 rounded-lg bg-canvas px-3.5 py-3',
  tabsWrap: 'grid gap-1.5',
  tabs: 'flex flex-wrap gap-1.5',
  tab: 'cursor-pointer rounded-sm border border-solid border-line-strong bg-surface-1 px-2.5 py-1.25 text-note! leading-normal! text-ink aria-pressed:border-ink-2 aria-pressed:bg-surface-2 aria-pressed:font-semibold! disabled:cursor-not-allowed disabled:text-ink-2 disabled:opacity-55! panel-small:text-hint panel-small:leading-normal',
  chartHead:
    'flex flex-wrap items-center justify-between gap-2 run-heading:m-0 run-heading:text-section run-heading:leading-normal run-heading:font-medium run-heading:text-ink',
  scope:
    'm-0 grid list-none items-center gap-1 rounded-lg border border-solid border-line px-2.5 py-2 text-note leading-normal text-ink-2 run-warning:text-ink',
  chart: 'min-w-0 run-chart:strategy-chart-height',
  empty: 'm-0 px-3 py-8 text-center text-body text-ink-2',
  legend:
    'm-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-note leading-normal text-ink-2 run-symbol:inline-block run-symbol:min-w-legend run-symbol:text-center',
  long: 'text-long',
  short: 'text-short',
  legendNote: 'ml-auto',
  facts:
    'm-0 grid grid-cols-run-facts gap-x-4 gap-y-1.5 text-note leading-normal modal-dt:text-ink-2 modal-dd:m-0 modal-dd:text-ink modal-dd:tabular-nums run-bad:text-short run-good:text-long',
  tableWrap: 'max-h-65 overflow-auto run-report-table:max-h-85',
  table:
    'w-full border-collapse text-note! leading-browser run-caption:pb-1.5 run-caption:text-left run-caption:text-ink-2 run-cell:border-t run-cell:border-t-solid run-cell:border-t-line run-cell:px-2! run-cell:py-1! run-cell:text-left run-cell:leading-browser run-cell:whitespace-nowrap run-cell:text-ink run-th:font-medium run-th:text-ink-2 run-table-button:cursor-pointer run-table-button:border-none! run-table-button:border-current! run-table-button:bg-transparent! run-table-button:p-0! run-table-button:text-note! run-table-button:leading-browser! run-table-button:text-info!',
  num: 'text-right! tabular-nums',
  side: 'grid justify-items-end gap-2 text-right',
  actions:
    'flex flex-wrap justify-end gap-1.5 run-button:cursor-pointer run-button:rounded-sm run-button:border run-button:border-solid run-button:border-line run-button:bg-transparent run-button:px-3 run-button:py-1 run-button:text-hint! run-button:leading-normal! run-button:text-ink run-button:disabled:cursor-default! run-button:disabled:opacity-50!',
  chartTags: 'text-hint leading-normal text-ink-2',
  series:
    'grid gap-2 rounded-sm border border-solid border-line bg-canvas px-3 py-2.5 text-note leading-normal run-label:flex run-label:items-center run-label:gap-2 field-input:w-16 field-input:rounded-panel! field-input:border! field-input:border-solid! field-input:border-line! field-input:bg-surface-1! field-input:px-1.5! field-input:py-1! field-input:text-ink!',
  seriesActions: 'flex gap-2',
  progress: 'grid gap-1.5',
  progressSteps: 'm-0 flex list-none gap-1 p-0',
  progressStep:
    'h-2 grow shrink basis-0 overflow-hidden rounded-sm bg-surface-2',
  progressTrack: 'h-2 overflow-hidden rounded-sm bg-surface-2',
  progressFill:
    'block h-full rounded-sm bg-info transition-progress duration-600 motion-reduce:transition-none',
  progressText:
    'm-0 flex items-center gap-3 text-note leading-normal text-ink-2 run-button:cursor-pointer run-button:rounded-sm run-button:border run-button:border-solid run-button:border-line-strong run-button:bg-transparent run-button:px-2.5 run-button:py-0.5 run-button:text-hint! run-button:leading-normal! run-button:text-ink',
  quick:
    'grid gap-1.5 rounded-lg border border-solid border-line-quick px-3 py-2.5 run-copy:m-0',
}
