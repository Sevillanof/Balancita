export const ANALYZER = {
  head: 'flex items-center justify-between gap-3',
  controls: 'flex flex-wrap items-end gap-x-6 gap-y-3.5',
  label: 'mb-1 block text-hint leading-normal text-ink-2',
  chips:
    'flex flex-wrap gap-1 run-button:min-w-11 run-button:cursor-pointer run-button:rounded-sm run-button:border run-button:border-solid run-button:border-line run-button:bg-transparent run-button:px-2.5 run-button:py-1.25 run-button:text-note! run-button:leading-normal! run-button:text-ink run-button:aria-pressed:border-long run-button:aria-pressed:bg-surface-2 run-button:aria-pressed:font-bold! run-button:aria-pressed:shadow-chip',
  view: 'field-select:rounded-sm! field-select:border! field-select:border-solid! field-select:border-line! field-select:bg-canvas! field-select:px-2! field-select:py-1.25! field-select:text-note! field-select:leading-normal! field-select:text-ink!',
  summary:
    'rounded-panel border border-solid border-line bg-canvas px-2.5 py-2 text-note leading-normal',
  body: 'grid grid-cols-analyzer items-start gap-4 analyzer-stack:grid-cols-1',
  gridwrap: 'min-w-0 overflow-x-auto',
  grid: 'w-full border-separate! border-spacing-0.75 text-hint! leading-normal run-th:px-1! run-th:py-0.5! run-th:text-center run-th:font-semibold run-th:text-ink-2 analyzer-row:min-w-37.5 analyzer-row:text-left analyzer-row:whitespace-nowrap analyzer-td:p-0!',
  none: 'text-center! text-ink-2',
  cell: 'relative grid w-full min-w-19.5 cursor-pointer gap-0.25 rounded-sm border border-solid border-transparent px-1 py-1.25 text-center text-hint! leading-normal! text-ink analyzer-cell-tone aria-pressed:border-ink',
  cellMain: 'text-hint leading-normal font-bold',
  cellSub: 'text-badge leading-normal text-ink-2',
  flag: 'absolute top-0.25 right-0.75 text-badge leading-normal font-bold text-warn',
  legend: 'text-label leading-normal text-ink-2',
  detail: 'grid gap-2.5 rounded-panel border border-solid border-line p-3',
  bigs: 'grid grid-cols-2 gap-2.5 analyzer-value-label:block analyzer-value-label:text-hint analyzer-value-label:leading-normal analyzer-value-label:text-ink-2 analyzer-value:text-run-title analyzer-value:leading-emphasis analyzer-gain:text-long analyzer-loss:text-short',
  curve:
    'm-0 analyzer-svg:block analyzer-svg:h-auto analyzer-svg:w-full analyzer-svg:rounded-sm analyzer-svg:border analyzer-svg:border-solid analyzer-svg:border-line analyzer-svg:bg-canvas analyzer-caption:mt-1 analyzer-caption:text-label analyzer-caption:leading-normal analyzer-caption:text-ink-2',
  zero: 'stroke-ink-2 stroke-1 stroke-dashes',
  line: 'stroke-2 stroke-round data-gain:stroke-long data-loss:stroke-short',
  notes: 'grid gap-2',
}
