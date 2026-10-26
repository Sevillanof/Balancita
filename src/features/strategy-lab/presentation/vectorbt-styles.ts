const BUTTONS =
  'run-button:cursor-pointer run-button:rounded-sm run-button:border run-button:border-solid run-button:border-line-strong run-button:bg-transparent run-button:px-2.5 run-button:py-0.75 run-button:text-hint! run-button:leading-normal! run-button:text-ink'
const HEAD =
  'flex flex-wrap items-center gap-2 vbt-heading:m-0 vbt-heading:mr-auto vbt-heading:text-section vbt-heading:leading-normal vbt-heading:font-medium vbt-heading:text-ink'
const CARD =
  'grid min-w-0 gap-2.5 rounded-lg border border-solid border-line px-3.5 py-3'
const SUBHEAD =
  'vbt-subhead:mt-0 vbt-subhead:mr-0 vbt-subhead:mb-1 vbt-subhead:ml-0 vbt-subhead:text-hint vbt-subhead:leading-normal vbt-subhead:font-semibold vbt-subhead:tracking-market vbt-subhead:text-ink-2 vbt-subhead:uppercase'
const LIST = 'm-0 grid gap-1.5 pl-4.5 text-note leading-normal'
const CHOICE =
  'm-0 grid gap-2 border-none border-current p-0 text-note leading-normal vbt-legend:mb-1.5 vbt-legend:p-0 vbt-legend:text-note vbt-legend:leading-normal vbt-legend:text-ink-2 run-label:flex run-label:cursor-pointer run-label:items-start run-label:gap-2 run-label:rounded-panel run-label:border run-label:border-solid run-label:border-line run-label:px-2.5 run-label:py-2 vbt-choice-copy:grid vbt-choice-copy:gap-0.5 panel-small:text-hint panel-small:leading-normal panel-small:text-ink-2'

export const VBT = {
  install: `rounded-sm border border-solid border-line bg-canvas px-2.5 py-2 text-note leading-normal vbt-summary:cursor-pointer vbt-summary:text-ink-2 modal-pre:my-2 modal-pre:overflow-auto modal-pre:rounded-panel modal-pre:border modal-pre:border-solid modal-pre:border-line modal-pre:bg-surface-1 modal-pre:p-2.5 modal-pre:font-brand-mono modal-pre:text-hint modal-pre:leading-normal modal-pre:text-ink modal-pre:whitespace-pre-wrap ${BUTTONS}`,
  report: `group/vbt-report ${CARD} bg-canvas ${SUBHEAD}`,
  compare: `${CARD} bg-surface-1`,
  reportHead: `${HEAD} ${BUTTONS} run-button:disabled:cursor-default! run-button:disabled:opacity-50! field-select:max-w-full field-select:rounded-sm! field-select:border! field-select:border-solid! field-select:border-line-strong! field-select:bg-surface-1! field-select:px-2! field-select:py-0.75! field-select:text-hint! field-select:leading-normal! field-select:text-ink!`,
  compareHead: `${HEAD} ${BUTTONS}`,
  body: 'grid min-w-0 gap-3',
  twin: 'grid grid-cols-2 gap-x-5 gap-y-3 run-stack:grid-cols-1 run-stack:grid-flow-row',
  list: `${LIST} text-ink`,
  notes: `${LIST} text-ink-2`,
  ranking: `grid min-w-0 gap-2 ${SUBHEAD}`,
  rankingAction:
    'flex flex-wrap items-center gap-1.5 run-button:rounded-sm run-button:disabled:cursor-default! run-button:disabled:opacity-50!',
  made: 'text-hint leading-normal text-ink-2',
  choice: CHOICE,
  choiceRow: `${CHOICE} auto-cols-fr grid-flow-col run-stack:grid-cols-1 run-stack:grid-flow-row`,
  variants:
    'grid gap-2.5 field-select:w-full field-select:rounded-panel! field-select:border! field-select:border-solid! field-select:border-line! field-select:bg-canvas! field-select:px-2.5! field-select:py-2! field-select:text-ink!',
  range:
    'grid grid-cols-3 gap-2.5 run-stack:grid-cols-1 run-stack:grid-flow-row',
  count:
    'm-0 rounded-panel border border-solid border-line px-2.5 py-2 text-note leading-normal text-ink',
}
