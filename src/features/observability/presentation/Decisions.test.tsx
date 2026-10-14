/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import candlesFixture from '../../../../docs/mission-control/b6/ejemplo-con-huecos.json'
import list from '../../../../docs/mission-control/b3/ejemplo-listado.json'
import discards from '../../../../docs/mission-control/b3/ejemplo-listado-descartes.json'
import noData from '../../../../docs/mission-control/b3/ejemplo-listado-sin-datos.json'
import traceDiscard from '../../../../docs/mission-control/b3/ejemplo-traza-descarte.json'
import traceMissing from '../../../../docs/mission-control/b3/ejemplo-traza-no-encontrada.json'
import traceProposal from '../../../../docs/mission-control/b3/ejemplo-traza-propuesta.json'
import {
  decodeDecisions,
  decodeTrace,
} from '../infrastructure/decisions-api.ts'
import { UnexpectedReport } from '../infrastructure/observability-api.ts'
import DecisionsPage from './DecisionsPage.tsx'

// The context chart has its own tests (needs a canvas); here it is a stub.
vi.mock('./ContextCandlesChart.tsx', () => ({
  default: () => <div data-testid="context-chart" />,
}))

/**
 * The fixtures are the documented examples the backend tests generate from
 * its own code (synthetic data): these tests break if screen and contract drift.
 */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('B3 decoders (strict)', () => {
  it('reads the documented list and keeps the strategy null for discards', () => {
    const report = decodeDecisions(list)
    expect(report.product).toBe('PF_XBTUSD')
    expect(report.decisions.state).toBe('ok')
    if (report.decisions.state !== 'ok') return
    expect(report.decisions.items).toHaveLength(5)
    expect(
      report.decisions.items.every((i) => i.selectedStrategyId === null),
    ).toBe(true)
    expect(report.decisions.rangeTotal).toBe(120)
  })

  it('reads an unavailable list with its cause and no figures', () => {
    const report = decodeDecisions(noData)
    expect(report.decisions.state).toBe('unavailable')
    if (report.decisions.state === 'unavailable')
      expect(report.decisions.detail).toBe('file_not_found')
  })

  it('rejects a body of another schema or with a wrong field type', () => {
    expect(() => decodeDecisions({})).toThrow(UnexpectedReport)
    const bad: any = clone(list)
    bad.decisions.items[0].bucket_start_ms = '1790'
    expect(() => decodeDecisions(bad)).toThrow(/item\.bucket_start_ms/)
    const noSchema: any = clone(list)
    noSchema.schema = 'observability-decisions.v2'
    expect(() => decodeDecisions(noSchema)).toThrow(UnexpectedReport)
    expect(() => decodeTrace({ ...traceProposal, state: 'weird' })).toThrow(
      UnexpectedReport,
    )
  })

  it('decodes the proposal trace with its proposals and selected strategy', () => {
    const trace = decodeTrace(traceProposal)
    expect(trace.state).toBe('ok')
    if (trace.state !== 'ok') return
    expect(trace.payload?.selected?.strategyId).toBe('c25-pullback-perp-v1')
    expect(trace.payload?.selected?.proposal?.proposedStop).toBe('99.47')
    expect(trace.payload?.proposals).toHaveLength(4)
    expect(trace.payload?.features.map((f) => f.key)).toEqual([
      '1m',
      '1m_previous',
      '5m',
    ])
  })

  it('decodes the model rows by key and flags a hash that does not match', () => {
    const trace = decodeTrace(traceProposal)
    if (trace.state !== 'ok') throw new Error('expected ok')
    expect(trace.modelDecisions.state).toBe('ok')
    if (trace.modelDecisions.state !== 'ok') return
    expect(trace.modelDecisions.items[0]).toMatchObject({
      chosen: 'LONG',
      confidence: 0.62,
      matchesVerdict: true,
      probabilities: [
        ['LONG', 0.62],
        ['SHORT', expect.closeTo(0.38, 5)],
      ],
    })
    const other: any = clone(traceProposal)
    delete other.model_decisions.items[0].question_id
    expect(() => decodeTrace(other)).toThrow(/question_id/)
    const bad: any = clone(traceProposal)
    bad.model_decisions.state = 'maybe'
    expect(() => decodeTrace(bad)).toThrow(/model_decisions\.state/)
  })

  it('a discard trace has a selector result and no strategy', () => {
    const trace = decodeTrace(traceDiscard)
    if (trace.state !== 'ok') throw new Error('expected ok')
    expect(trace.payload?.selected).toMatchObject({
      action: 'WAIT',
      strategyId: null,
      proposal: null,
    })
  })

  it('a payload without proposals decodes as null, not as an empty list', () => {
    const bare: any = clone(traceDiscard)
    delete bare.payload.proposals
    const trace = decodeTrace(bare)
    if (trace.state !== 'ok') throw new Error('expected ok')
    expect(trace.payload?.proposals).toBeNull()
    const wrong: any = clone(traceDiscard)
    wrong.payload.proposals = 'nope'
    expect(() => decodeTrace(wrong)).toThrow(/proposals/)
  })

  it('keeps payload_state and drops an unusable payload', () => {
    const broken: any = clone(traceDiscard)
    broken.payload_state = 'unparseable'
    broken.payload = null
    const trace = decodeTrace(broken)
    if (trace.state !== 'ok') throw new Error('expected ok')
    expect(trace.payloadState).toBe('unparseable')
    expect(trace.payload).toBeNull()
  })

  it('reads «not found» without inventing a decision', () => {
    const trace = decodeTrace(traceMissing)
    expect(trace.state).toBe('not_found')
    expect('decision' in trace).toBe(false)
  })
})

function serve(handlers: {
  list?: (url: URL) => Response
  trace?: (url: URL) => Response
}) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(input)
      const url = new URL(input, 'http://localhost')
      if (/\/observability\/decisions\/[^/]+\/\d+$/.test(url.pathname))
        return handlers.trace?.(url) ?? json(traceProposal)
      if (url.pathname.endsWith('/observability/candles'))
        return json(candlesFixture)
      if (url.pathname.endsWith('/observability/decisions'))
        return handlers.list?.(url) ?? json(list)
      throw new Error(`unexpected ${input}`)
    }),
  )
  return calls
}

const PRODUCTS = ['PF_XBTUSD', 'PF_ETHUSD']

function page(bucket: number | null = null) {
  return render(
    <DecisionsPage
      products={PRODUCTS}
      initialProduct="PF_XBTUSD"
      initialBucket={bucket}
    />,
  )
}

describe('DecisionsPage', () => {
  it('lists the verdicts and opens the newest one as a trace', async () => {
    const calls = serve({})
    page()
    const rows = await screen.findByTestId('decision-list')
    expect(within(rows).getAllByRole('row')).toHaveLength(6) // header + 5
    await screen.findByTestId('stage-6')
    // The newest bucket of the list is the one traced.
    const newest = (list as any).decisions.items[0].bucket_start_ms
    expect(calls.some((c) => c.endsWith(`/PF_XBTUSD/${newest}`))).toBe(true)
    expect(screen.getByTestId('list-count')).toHaveTextContent(
      'Mostrando 5 de 120 veredictos',
    )
  })

  it('shows the proposals by strategy only because the payload has them', async () => {
    serve({})
    page()
    const proposals = await screen.findByTestId('proposals')
    expect(within(proposals).getAllByRole('listitem').length).toBeGreaterThan(3)
    expect(proposals).toHaveTextContent('c25-pullback-perp-v1')
    expect(proposals).toHaveTextContent('c28-adapter-perp-v1 → c27')
    expect(screen.getByTestId('features')).toHaveTextContent('atr14')
    // Stage 4 reads the selected proposal's own stop, target and cost.
    expect(screen.getByTestId('stage-4')).toHaveTextContent('99.47')
    expect(screen.getByTestId('stage-4')).toHaveTextContent('12.5 bps')
    // A proposal is never presented as an execution.
    expect(screen.getByTestId('card-action')).toHaveTextContent(
      'LONG (propuesta)',
    )
    expect(screen.getByTestId('card-action')).toHaveTextContent(
      'No es una orden ejecutada',
    )
    expect(screen.getByTestId('stage-6')).toHaveTextContent('No disponible')
    expect(screen.getByTestId('stage-post')).toHaveTextContent('NO DISPONIBLE')
  })

  it('shows the model row of the minute only as a correlation', async () => {
    serve({})
    page()
    const rows = await screen.findByTestId('model-rows')
    expect(rows).toHaveTextContent('q-entry-direction')
    expect(rows).toHaveTextContent('confianza 0.62')
    expect(rows).toHaveTextContent('no indica que haya intervenido')
  })

  it('says the model has no row for this minute instead of inventing one', async () => {
    serve({ trace: () => json(traceDiscard) })
    page()
    const rows = await screen.findByTestId('model-rows')
    expect(rows).toHaveTextContent('No disponible')
    expect(rows).toHaveTextContent('no tiene fila para este minuto')
  })

  it('does not attribute a discard reason to a strategy', async () => {
    serve({ trace: () => json(traceDiscard) })
    page()
    const origin = await screen.findByTestId('reason-origin')
    expect(origin).toHaveTextContent('el payload no lo atribuye a ninguna')
    expect(screen.getByTestId('card-reason')).toHaveTextContent(
      'no lo atribuye a ninguna estrategia',
    )
    // The list names no strategy for a discard.
    const rows = within(screen.getByTestId('decision-list')).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('—')
    expect(rows[1]).toHaveTextContent('No corresponde')
  })

  it('says «No disponible» for missing proposals instead of inventing them', async () => {
    const bare: any = clone(traceDiscard)
    delete bare.payload.proposals
    serve({ trace: () => json(bare) })
    page()
    const stage = await screen.findByTestId('stage-2')
    await waitFor(() =>
      expect(stage).toHaveTextContent('no trae propuestas por estrategia'),
    )
    expect(stage).toHaveTextContent('NO DISPONIBLE')
    expect(stage).toHaveTextContent('no se atribuye a una estrategia')
  })

  it('shows the cause when the source is missing', async () => {
    serve({ list: () => json(noData) })
    page()
    expect(
      await screen.findByText(/futures-verdicts.sqlite|sin configurar/),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/file_not_found/).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('decision-list')).toBeNull()
  })

  it('reports a failed read as an error, never as an empty list', async () => {
    serve({ list: () => json({}, 503) })
    page()
    expect(
      await screen.findByText('No se pudo leer el registro de veredictos'),
    ).toBeInTheDocument()
    expect(screen.getByText('HTTP 503')).toBeInTheDocument()
  })

  it('reports a bucket without verdict as such', async () => {
    serve({ trace: () => json(traceMissing) })
    page(1_790_000_040_000)
    expect(await screen.findByText('Sin veredicto')).toBeInTheDocument()
  })

  it('filters by action and by a clicked reason, asking the gateway', async () => {
    const calls = serve({
      list: (url) =>
        json(url.searchParams.get('reason_code') ? discards : list),
    })
    page()
    await screen.findByTestId('decision-list')
    await userEvent.click(screen.getByRole('button', { name: /^LONG/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.includes('action=LONG'))).toBe(true),
    )
    await userEvent.click(screen.getByRole('button', { name: /^Todos/ }))
    const reason = (
      await within(await screen.findByTestId('decision-list')).findAllByTitle(
        'Filtrar por este motivo',
      )
    )[0]
    await userEvent.click(reason)
    await waitFor(() =>
      expect(calls.some((c) => c.includes('reason_code='))).toBe(true),
    )
    expect(await screen.findByTestId('reason-filter')).toBeInTheDocument()
  })

  it('loads the next page with the cursor and the same range', async () => {
    const withCursor: any = clone(list)
    withCursor.decisions.next_cursor = '1789999000000'
    const calls = serve({
      list: (url) =>
        url.searchParams.get('cursor') ? json(discards) : json(withCursor),
    })
    page()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cargar más antiguos' }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('list-count')).toHaveTextContent(
        'Mostrando 8 de 120',
      ),
    )
    const paged = calls.find((c) => c.includes('cursor=1789999000000'))!
    expect(paged).toContain(`from=${withCursor.from_ms}`)
    expect(paged).toContain(`to=${withCursor.to_ms}`)
  })

  it('selecting a row traces that bucket', async () => {
    const calls = serve({})
    page()
    const rows = await screen.findByTestId('decision-list')
    const second = (list as any).decisions.items[1].bucket_start_ms
    await userEvent.click(
      within(rows).getAllByRole('button', { pressed: false })[0],
    )
    await waitFor(() =>
      expect(calls.some((c) => c.endsWith(`/PF_XBTUSD/${second}`))).toBe(true),
    )
  })
})
