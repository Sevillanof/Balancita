import { VBT } from './vectorbt-styles.ts'
import { RUN } from './run-view-styles.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ApprovedTerminalChart from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import { amount } from '../../../shared/finance/format.ts'
import { signedAmount } from '../domain/strategy-format.ts'
import {
  MARKET_STAGES,
  nextStage,
  stageTabs,
  untriedStages,
  type MarketStage,
} from '../domain/market-stages.ts'
import { runScopeLines } from '../domain/run-scope.ts'
import { STAGES, deriveStage } from '../domain/run-stage.ts'
import {
  fullViewText,
  isDiscardId,
  isGroupId,
  madridTime,
  priceLinesOf,
  markerIds,
  tradeOfMarker,
  toChartCandles,
  resolutionFor,
  resolutionSeconds,
  resolutionText,
  dayLabel,
  toDiscardMarkers,
  toMarkers,
  toOverviewMarkers,
  windowAround,
} from '../domain/run-chart-model.ts'
import {
  gateApi,
  type GateApi,
  type GateOverview,
  type GateRun,
} from '../infrastructure/gate-api.ts'
import {
  RunVisualError,
  runVisualApi,
  type RunCandles,
  type RunDecisions,
  type RunTrade,
  type RunVisualApi,
  type RunVisualSummary,
} from '../infrastructure/run-visual-api.ts'
import {
  vectorbtApi,
  type VbtExploration,
  type VbtVariant,
  type VectorbtApi,
} from '../infrastructure/vectorbt-api.ts'
import type { StrategyApi } from '../infrastructure/strategy-api.ts'
import {
  quickApi,
  type QuickApi,
  type QuickFicha,
  type QuickOperation,
  type QuickOperationStats,
  type QuickState,
  type QuickVariant,
} from '../infrastructure/quick-api.ts'
import { installCommands } from '../domain/vectorbt-format.ts'
import RunProgress from './RunProgress.tsx'
import VectorbtModal from './VectorbtModal.tsx'
import AnalyzerModal from './AnalyzerModal.tsx'
import {
  analyzerApi,
  type AnalyzerApi,
} from '../infrastructure/analyzer-api.ts'
import VectorbtProgress from './VectorbtProgress.tsx'
import VectorbtReportPanel from './VectorbtReportPanel.tsx'
import VectorbtVariantLink from './VectorbtVariantLink.tsx'
import { useVectorbt } from './use-vectorbt.ts'

const STAGE_LABEL = [
  'En hipótesis',
  'En optimización',
  'En validación',
  'En examen',
  'Pasó el examen',
]
const DEFAULT_PRODUCT = 'PF_XBTUSD'
const TRADES_PAGE = 500

/** «C27 Ruptura Donchian» → «C27 · Ruptura Donchian». */
const titleOf = (name: string) => name.replace(/^(C\d+)\s+/, '$1 · ')

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const runName = (run: Pick<GateRun, 'id' | 'kind'>) =>
  `${run.kind === 'exam' ? 'Examen' : 'Práctica'} #${run.id}`

const bp = (value: number | null | undefined) => {
  const text = signedAmount(value ?? null, 1)
  return text === null ? '—' : `${text} pb`
}

const dayText = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

/** « · 01/01/2025–31/03/2025» of a run (its own dates, else the range it stored), or nothing. */
function rangeText(run: GateRun, summary?: RunVisualSummary): string {
  const { from, to } = run.params ?? {}
  if (from && to) return ` · ${dayText(from)}–${dayText(to)}`
  if (summary && summary.run_id === run.id)
    return ` · ${madridTime(summary.range_start_ms).slice(0, 10)}–${madridTime(summary.range_end_ms - 1).slice(0, 10)}`
  return ''
}

type Loaded = {
  summary: RunVisualSummary
  product: string
  /** Every trade of the product loaded so far (the pages keep arriving after the chart is up). */
  trades: RunTrade[]
  total: number
  tradesDone: boolean
  tradesError: string | null
  /** `full` = the whole stretch the test covered; `zoom` = 1-minute window around the chosen trade. */
  view: 'full' | 'zoom'
  candles: RunCandles | null
  candlesError: string | null
  /** The full view's candles, kept so that «Ver todo el tramo» does not read them again. */
  full: { candles: RunCandles | null; error: string | null }
}

type Props = {
  strategyId: string
  strategyName: string
  version: number | string
  gate?: GateApi
  visual?: RunVisualApi
  /** Qwen's quick test (a sample of the photos): only Qwen en vivo has it. */
  quick?: QuickApi
  /** «Explorar con VectorBT» (rutas `/strategies/:id/vectorbt`). */
  vectorbt?: VectorbtApi
  /** «Analizador de señales» (`/analyzer/events`): solo lectura. */
  analyzer?: AnalyzerApi
  /** Reads the strategy's spec (what can be varied) and, for a variant, where it came from. */
  registry?: Pick<StrategyApi, 'detail'>
  /** `rules` or not: VectorBT only explores strategies of rules. Unknown (absent) is treated as rules. */
  kind?: string
  /** A variant was created and its test started: the page selects it and shows the note. */
  onVariantStarted?: (id: string, note: string) => void
  /** «Modificar» / «Crear»: lead to the laboratory's editor; absent = disabled. */
  onModify?: () => void
  onCreate?: () => void
}

/**
 * Top of the strategy screen: the phase of the strategy, the four figures of
 * its latest finished test and the REAL Kraken candles of that test with the
 * trades it stored. Nothing is drawn that the test did not save.
 */
export default function StrategyRunView({
  strategyId,
  strategyName,
  version,
  gate = gateApi,
  visual = runVisualApi,
  quick = quickApi,
  vectorbt = vectorbtApi,
  analyzer = analyzerApi,
  registry,
  kind,
  onVariantStarted,
  onModify,
  onCreate,
}: Props) {
  const [overview, setOverview] = useState<GateOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'empty'
        reason: 'no-runs' | 'no-trades-saved' | 'run-not-saved'
      }
    | { kind: 'error'; text: string; code: string }
    | { kind: 'ready'; data: Loaded }
  >({ kind: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The stage («from» date) the person chose by hand; `null` = follow the newest finished run. */
  const [picked, setPicked] = useState<string | null>(null)
  /** A discard marker the person clicked (its reason is then painted next to it). */
  const [focusId, setFocusId] = useState<string | null>(null)
  /** The run whose chart is on screen, so that picking the tab already shown reloads nothing. */
  const shownRun = useRef<number | null>(null)
  const [decisions, setDecisions] = useState<{
    key: string
    value: RunDecisions | null
    error: string | null
  } | null>(null)
  const token = useRef(0)
  /** Zoom / «Ver todo el tramo» requests: the latest one wins; the trades keep loading underneath. */
  const viewToken = useRef(0)
  const invalidate = useCallback(() => {
    token.current += 1
  }, [])

  const [reload, setReload] = useState(0)
  const [testing, setTesting] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [howMany, setHowMany] = useState(1)
  const [series, setSeries] = useState<{
    done: number
    total: number
    label: string
  } | null>(null)
  const stopSeries = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [testError, setTestError] = useState<string | null>(null)
  const busy = overview?.running != null
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setReload((value) => value + 1), 3_000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    let alive = true
    gate
      .overview(strategyId)
      .then((data) => {
        if (alive) {
          setOverview(data)
          setOverviewError(null)
        }
      })
      .catch((error) => {
        if (alive) setOverviewError(message(error))
      })
    return () => {
      alive = false
    }
  }, [gate, strategyId, reload])

  const finished = useMemo(
    () =>
      (overview?.runs ?? [])
        .filter((run) => run.status === 'done')
        .sort((a, b) => b.id - a.id),
    [overview],
  )
  const stage = deriveStage(overview)

  /** Changes the loaded data only if the same load is still the current one (no stale write). */
  const patch = useCallback(
    (mine: number, change: (data: Loaded) => Loaded) => {
      if (token.current !== mine) return
      setState((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', data: change(current.data) }
          : current,
      )
    },
    [],
  )

  /**
   * One product of a run: the chart opens on the WHOLE stretch the test covered (candles of a resolution that
   * keeps them about 2.700), and then all its trades keep arriving page by page without blocking the screen.
   */
  const loadProduct = useCallback(
    async (mine: number, summary: RunVisualSummary, product: string) => {
      const range = {
        from: summary.range_start_ms,
        to: summary.range_end_ms,
        resolution: resolutionFor(
          summary.range_end_ms - summary.range_start_ms,
        ),
      }
      const [first, fullCandles] = await Promise.all([
        visual.trades(summary.run_id, product, { limit: TRADES_PAGE }),
        visual.candles(summary.run_id, product, range).then(
          (candles) => ({ candles, error: null }),
          (error: unknown) => ({ candles: null, error: message(error) }),
        ),
      ])
      if (token.current !== mine) return
      let cursor = first.next_cursor
      setSelectedId(null)
      setState({
        kind: 'ready',
        data: {
          summary,
          product,
          trades: first.trades,
          total: first.total,
          tradesDone: cursor === null,
          tradesError: null,
          view: 'full',
          candles: fullCandles.candles,
          candlesError: fullCandles.error,
          full: fullCandles,
        },
      })
      let loadedTrades = first.trades
      while (cursor !== null) {
        try {
          const page = await visual.trades(summary.run_id, product, {
            limit: TRADES_PAGE,
            cursor,
          })
          loadedTrades = [...loadedTrades, ...page.trades]
          cursor = page.next_cursor
          const all = loadedTrades
          const done = cursor === null
          patch(mine, (data) => ({ ...data, trades: all, tradesDone: done }))
        } catch (error) {
          patch(mine, (data) => ({
            ...data,
            tradesDone: true,
            tradesError: message(error),
          }))
          return
        }
      }
    },
    [visual, patch],
  )

  const openRun = useCallback(
    async (mine: number, runId: number) => {
      const summary = await visual.summary(runId)
      if (token.current !== mine) return
      const product = summary.products.includes(DEFAULT_PRODUCT)
        ? DEFAULT_PRODUCT
        : (summary.products[0] ?? DEFAULT_PRODUCT)
      await loadProduct(mine, summary, product)
    },
    [visual, loadProduct],
  )

  // One tab per market stage, each one a run. By default the chart follows the newest finished run;
  // a stage picked by hand stays. With no stage tried, the newest finished runs are shown as one tab.
  const stageList = overview?.stages?.practice ?? MARKET_STAGES
  const tabs = useMemo(
    () => stageTabs(overview?.runs ?? [], stageList),
    [overview, stageList],
  )
  const triedTabs = useMemo(
    () => tabs.filter((tab) => tab.run !== null),
    [tabs],
  )
  const pickedTab = useMemo(
    () =>
      picked !== null
        ? (triedTabs.find((tab) => tab.stage.from === picked) ?? null)
        : null,
    [picked, triedTabs],
  )
  const candidateIds = useMemo(() => {
    if (pickedTab?.run) return [pickedTab.run.id]
    if (triedTabs.length > 0)
      return triedTabs.map((tab) => tab.run!.id).sort((a, b) => b - a)
    return finished.map((run) => run.id)
  }, [pickedTab, triedTabs, finished])
  const manual = pickedTab !== null
  // It only reloads when the candidates change: the 3 s / 10 s refresh of a running test must not
  // redraw (blink) the chart.
  const loaded = overview !== null
  const candidateKey = candidateIds.join(',')
  useEffect(() => {
    if (!loaded) return
    const candidates =
      candidateKey === '' ? [] : candidateKey.split(',').map(Number)
    if (candidates.length > 0 && candidates[0] === shownRun.current) return
    const mine = ++token.current
    void (async () => {
      shownRun.current = null
      if (candidates.length === 0) {
        setState({ kind: 'empty', reason: 'no-runs' })
        return
      }
      setState({ kind: 'loading' })
      for (const runId of candidates) {
        try {
          await openRun(mine, runId)
          if (token.current === mine) shownRun.current = runId
          return
        } catch (error) {
          if (token.current !== mine) return
          const code = error instanceof RunVisualError ? error.code : 'error'
          if (code === 'artifact_not_ready') continue
          setState({ kind: 'error', text: message(error), code })
          return
        }
      }
      if (token.current === mine)
        setState({
          kind: 'empty',
          reason: manual ? 'run-not-saved' : 'no-trades-saved',
        })
    })()
    return invalidate
  }, [loaded, candidateKey, manual, openRun, invalidate])

  const data = state.kind === 'ready' ? state.data : null

  const select = async (trade: RunTrade) => {
    if (!data) return
    setSelectedId(trade.trade_id)
    const load = token.current
    const mine = ++viewToken.current
    const change = (view: Partial<Loaded>) => {
      if (token.current !== load || viewToken.current !== mine) return
      patch(load, (current) => ({ ...current, view: 'zoom', ...view }))
    }
    try {
      const candles = await visual.candles(
        data.summary.run_id,
        data.product,
        windowAround(trade),
      )
      change({ candles, candlesError: null })
    } catch (error) {
      change({ candles: null, candlesError: message(error) })
    }
  }

  /** «Ver todo el tramo»: back to the whole stretch, with the candles already read. */
  const showAll = () => {
    ++viewToken.current
    setSelectedId(null)
    setFocusId(null)
    patch(token.current, (current) => ({
      ...current,
      view: 'full',
      candles: current.full.candles,
      candlesError: current.full.error,
    }))
  }

  const selected =
    data?.trades.find((trade) => trade.trade_id === selectedId) ?? null

  const candlesData = data?.candles ?? null
  const chartCandles = useMemo(
    () => (candlesData ? toChartCandles(candlesData.candles) : []),
    [candlesData],
  )

  // Decisions (every proposal and what became of it) of the visible window. Only runs that saved their
  // trace have them; the others say so and nothing is invented.
  const decisionRun = data?.summary.run_id ?? null
  const decisionProduct = data?.product ?? null
  const windowFrom = data?.candles?.from_ms ?? null
  const windowTo = data?.candles?.to_ms ?? null
  const hasTrace = data?.summary.decision_evidence === 'captured'
  const fullView = data?.view === 'full'
  const decisionKey =
    decisionRun !== null && windowFrom !== null
      ? `${decisionRun}:${decisionProduct}:${windowFrom}:${windowTo}:${fullView ? 'discards' : 'all'}`
      : null
  useEffect(() => {
    if (
      !hasTrace ||
      decisionKey === null ||
      decisionRun === null ||
      decisionProduct === null
    )
      return
    let alive = true
    void (async () => {
      try {
        const value = await visual.decisions(decisionRun, decisionProduct, {
          from: windowFrom ?? undefined,
          to: windowTo ?? undefined,
          // The whole stretch asks only for the real discards; the ignored ones come as a count.
          ...(fullView ? { only: 'discards' as const } : {}),
        })
        if (alive) setDecisions({ key: decisionKey, value, error: null })
      } catch (error) {
        if (alive)
          setDecisions({ key: decisionKey, value: null, error: message(error) })
      }
    })()
    return () => {
      alive = false
    }
  }, [
    visual,
    hasTrace,
    decisionKey,
    decisionRun,
    decisionProduct,
    windowFrom,
    windowTo,
    fullView,
  ])
  const decided =
    hasTrace && decisions !== null && decisions.key === decisionKey
      ? decisions
      : null
  const traced = decided?.value?.captured ? decided.value : null

  const markers = useMemo(() => {
    if (!data?.candles) return []
    const { from_ms: from, to_ms: to } = data.candles
    if (data.view === 'full')
      return toOverviewMarkers(data.trades, traced?.signals ?? [], { from, to })
    return [
      ...toMarkers(
        data.trades.filter(
          (trade) => trade.entry_time_ms < to && trade.exit_time_ms >= from,
        ),
      ),
      ...(traced ? toDiscardMarkers(traced.signals, { from, to }) : []),
    ]
  }, [data, traced])
  const focused =
    focusId !== null &&
    markers.some(
      (marker) =>
        marker.id === focusId || (marker.memberIds?.includes(focusId) ?? false),
    )
      ? focusId
      : null

  const summary = data?.summary.summary ?? null
  const lastRun = data
    ? finished.find((run) => run.id === data.summary.run_id)
    : null
  // No stage tried but there are finished runs: the one on screen keeps its own tab, with its range.
  const fallbackRun =
    triedTabs.length === 0 ? (lastRun ?? finished[0] ?? null) : null
  const fallbackLabel = fallbackRun
    ? `Prueba #${fallbackRun.id}${rangeText(fallbackRun, data?.summary)}`
    : ''
  const scopeRun = lastRun ?? finished[0] ?? null
  const running = overview?.running ?? null
  const activeRun = running
    ? (overview?.runs.find((run) => run.id === running.id) ?? null)
    : null
  const totalTests = series?.total ?? 1
  const doneTests = series?.done ?? 0
  const livePercent = Math.min(Math.max(activeRun?.progress ?? 0, 0), 100)
  const overallPercent = Math.round(
    ((doneTests + livePercent / 100) / totalTests) * 100,
  )
  const progressLabel = series
    ? `Prueba ${series.done + 1} de ${series.total} · ${series.label}`
    : 'Prueba en curso'
  // Qwen and Kronos repeat every stage, the exam included, as often as wanted: the gate only reads what
  // they recorded in real time, so a repetition never hands them a result.
  const repeatable = kind === 'qwen_live' || kind === 'model'
  const untried = repeatable
    ? [...stageList]
    : untriedStages(overview?.runs ?? [], stageList)
  const count = Math.min(Math.max(howMany, 1), Math.max(untried.length, 1))
  const plan = untried.slice(0, count)
  const testNote = repeatable
    ? 'Repetir las etapas del mercado cuantas veces quieras'
    : untried.length > 0
      ? 'Probar la estrategia en etapas distintas del mercado'
      : 'Ya la probaste en todas las etapas del mercado'

  /** Runs the stages one after the other; each waits for the previous test to end. */
  const runSeries = async (stages: MarketStage[]) => {
    stopSeries.current = false
    setPanelOpen(false)
    setTesting(true)
    setTestError(null)
    try {
      for (const [index, stage] of stages.entries()) {
        if (stopSeries.current || !mounted.current) break
        setSeries({ done: index, total: stages.length, label: stage.label })
        const started = await gate.start(strategyId, {
          from: stage.from,
          to: stage.to,
        })
        let latest = await gate.overview(strategyId)
        while (latest.running != null) {
          setOverview(latest)
          await new Promise((resolve) => setTimeout(resolve, 4000))
          if (!mounted.current) return
          latest = await gate.overview(strategyId)
        }
        setOverview(latest)
        const mine = latest.runs.find((run) => run.id === started.run_id)
        if (mine && mine.status !== 'done') {
          setTestError(
            mine.error ??
              `La prueba de ${stage.label} no terminó (${mine.status}). Se frena la serie.`,
          )
          break
        }
      }
    } catch (error) {
      if (mounted.current) setTestError(message(error))
    } finally {
      if (mounted.current) {
        setSeries(null)
        setTesting(false)
        setReload((value) => value + 1)
      }
    }
  }
  const examStage = overview?.stages?.exam ?? null
  // --- Prueba rápida (Qwen en vivo): una muestra de fotos, orientativa ---
  const hasQuick = kind === 'qwen_live'
  const [quickState, setQuickState] = useState<QuickState | null>(null)
  const [quickError, setQuickError] = useState<string | null>(null)
  const quickRunning = quickState?.state === 'running'
  const quickVariants = quickState?.variants ?? []
  const [quickVariant, setQuickVariant] = useState('actual')
  useEffect(() => {
    if (!hasQuick) return
    let cancelled = false
    const look = () =>
      quick
        .status(strategyId)
        .then((next) => {
          if (!cancelled) setQuickState({ ...next, fetched_ms: Date.now() })
        })
        .catch(() => undefined)
    void look()
    const timer = quickRunning ? setInterval(() => void look(), 5000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [hasQuick, quick, strategyId, quickRunning])
  const startQuick = async () => {
    setQuickError(null)
    try {
      await quick.start(strategyId, quickVariant)
      setQuickState({
        ...(await quick.status(strategyId)),
        fetched_ms: Date.now(),
      })
    } catch (error) {
      // already running (a second click, or another window): show its progress instead of an error
      const current = await quick.status(strategyId).catch(() => null)
      if (current?.state === 'running')
        setQuickState({ ...current, fetched_ms: Date.now() })
      else setQuickError(message(error))
    }
  }
  /** The final exam (everything since the cut): only Qwen and Kronos can repeat it. */
  const runExam = async () => {
    setPanelOpen(false)
    setTesting(true)
    setTestError(null)
    try {
      const started = await gate.start(
        strategyId,
        examStage
          ? {
              exam: true,
              from: examStage.from,
              ...(examStage.to ? { to: examStage.to } : {}),
            }
          : { exam: true },
      )
      let latest = await gate.overview(strategyId)
      while (latest.running != null) {
        setOverview(latest)
        await new Promise((resolve) => setTimeout(resolve, 4000))
        if (!mounted.current) return
        latest = await gate.overview(strategyId)
      }
      setOverview(latest)
      const mine = latest.runs.find((run) => run.id === started.run_id)
      if (mine && mine.status !== 'done')
        setTestError(mine.error ?? `El examen no terminó (${mine.status}).`)
    } catch (error) {
      if (mounted.current) setTestError(message(error))
    } finally {
      if (mounted.current) {
        setTesting(false)
        setReload((value) => value + 1)
      }
    }
  }
  // Retired strategies of the old engine are not in the gate's registry.
  const unknownToGate = overviewError?.startsWith('No existe') ?? false

  // --- Explorar con VectorBT ---
  // VectorBT only explores rules: Qwen and Kronos never ask for it.
  const exploresRules = kind === undefined || kind === 'rules'
  const vbt = useVectorbt(strategyId, vectorbt, exploresRules)
  const vbtState = vbt.state
  const vbtRunning = vbtState?.running ?? null
  const [vbtModal, setVbtModal] = useState(false)
  const [analyzerOpen, setAnalyzerOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [vbtProblem, setVbtProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const loadSpec = useCallback(async () => {
    if (!registry) throw new Error('Esta pantalla no puede leer la estrategia.')
    return (await registry.detail(strategyId)).spec
  }, [registry, strategyId])
  const reports = (vbtState?.explorations ?? []).filter(
    (item) => item.report !== null,
  )
  const shown = reports.find((item) => item.id === pickedId) ?? reports[0]
  const lastFailed = (vbtState?.explorations ?? [])[0]
  const vbtWhy: string | null = (() => {
    if (kind !== undefined && kind !== 'rules')
      return 'VectorBT solo explora estrategias de reglas.'
    if (vbt.error) return `No se pudo consultar VectorBT: ${vbt.error}`
    if (!vbtState) return 'Consultando si VectorBT está disponible…'
    if (!vbtState.available) return 'VectorBT no está instalado en este equipo.'
    if (vbtRunning) return null
    if (vbtState.busy_with)
      return `Hay otra exploración de VectorBT en curso (${vbtState.busy_with.strategy_id}). Esperá a que termine.`
    if (running || series)
      return 'Hay una prueba en curso: comparte el procesador con VectorBT. Esperá a que termine.'
    return null
  })()
  const vbtDisabled = vbtWhy !== null || vbtRunning !== null
  const commands = installCommands(vbtState?.reason ?? '')

  const launchExploration = async (
    request: Parameters<VectorbtApi['launch']>[1],
  ) => {
    await vectorbt.launch(strategyId, request)
    setVbtModal(false)
    setVbtProblem(null)
    setPickedId(null)
    vbt.refresh()
  }
  const cancelExploration = async () => {
    if (!vbtRunning) return
    setCancelling(true)
    try {
      await vectorbt.cancel(strategyId, vbtRunning.id)
    } catch (error) {
      setVbtProblem(message(error))
    } finally {
      setCancelling(false)
      vbt.refresh()
    }
  }
  /** Creates the draft variant, then runs the usual Testear on it and hands the screen over to it. */
  const confirmVariant = async (
    exploration: VbtExploration,
    row: VbtVariant,
  ) => {
    setConfirming(row.value)
    setVbtProblem(null)
    try {
      const made = await vectorbt.confirm(strategyId, exploration.id, row.value)
      const stage = nextStage([])
      let note = `Se creó «${made.title}» como borrador y se está probando.`
      if (made.already)
        note = `«${made.title}» ya estaba creada como borrador; se la vuelve a probar.`
      try {
        await gate.start(
          made.strategy_id,
          stage ? { from: stage.from, to: stage.to } : {},
        )
      } catch (error) {
        note = `Se creó «${made.title}» como borrador, pero no se pudo empezar la prueba: ${message(error)} Probala con Testear.`
      }
      if (mounted.current) {
        vbt.refresh()
        onVariantStarted?.(made.strategy_id, note)
      }
    } catch (error) {
      if (mounted.current) setVbtProblem(message(error))
    } finally {
      if (mounted.current) setConfirming(null)
    }
  }
  const copyCommands = () => {
    void navigator.clipboard
      ?.writeText(commands.join('\n'))
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <section
      className={RUN.card}
      aria-label={`Última prueba de ${strategyName}`}
      data-testid="run-view"
    >
      <header className={RUN.head}>
        <div>
          <p className={RUN.title}>
            {titleOf(strategyName)} <small>v{version}</small>
          </p>
          <p className={RUN.hint}>
            {lastRun
              ? `Prueba mostrada · ${runName(lastRun)}`
              : 'Sin prueba terminada con operaciones guardadas'}
            {running && ' · hay una prueba en curso'}
          </p>
        </div>
        <div className={RUN.side}>
          <p className={RUN.stageLabel} title={stage.reason}>
            {STAGE_LABEL[stage.index]}
          </p>
          <div className={RUN.actions} role="group" aria-label="Acciones">
            <button type="button" onClick={onModify} disabled={!onModify}>
              Modificar
            </button>
            <button type="button" onClick={onCreate} disabled={!onCreate}>
              Crear
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen((open) => !open)}
              disabled={
                testing ||
                running != null ||
                vbtRunning != null ||
                untried.length === 0
              }
              title={
                vbtRunning
                  ? 'Hay una exploración de VectorBT en curso: esperá a que termine.'
                  : testNote
              }
              aria-expanded={panelOpen}
            >
              {running || series ? 'Prueba en curso…' : 'Testear'}
            </button>
            {repeatable && (
              <button
                type="button"
                onClick={() => void runExam()}
                disabled={testing || running != null}
                title="Examen final: sus operaciones reales desde la fecha de corte. Se puede repetir."
              >
                Examen
              </button>
            )}
            {hasQuick && quickVariants.length > 1 && (
              <select
                aria-label="Variante de la prueba rápida"
                value={quickVariant}
                onChange={(event) => setQuickVariant(event.target.value)}
                disabled={quickRunning}
                title="Qué se prueba: las preguntas actuales, otras preguntas u otro modelo. Cada variante es una versión aparte."
              >
                {quickVariants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variantLabel(variant)}
                  </option>
                ))}
              </select>
            )}
            {hasQuick && (
              <button
                type="button"
                onClick={() => void startQuick()}
                disabled={quickRunning}
                title="Pregunta a Qwen solo sobre unas 150 fotos del pasado (unos 7 minutos) para filtrar un cambio de prompt o modelo. Es orientativa: no es el Examen."
              >
                {quickRunning ? 'Prueba rápida en curso…' : 'Prueba rápida'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setVbtModal(true)}
              disabled={vbtDisabled}
              title={vbtWhy ?? 'Probar la estrategia rápido con VectorBT'}
            >
              {vbtRunning ? 'Exploración en curso…' : 'Explorar con VectorBT'}
            </button>
            <button type="button" onClick={() => setAnalyzerOpen(true)}>
              Analizador de señales
            </button>
          </div>
        </div>
      </header>
      {hasQuick &&
        (quickState?.state !== 'none' ||
          quickError ||
          quickVariants.some((variant) => variant.summary)) && (
          <div className={RUN.quick} role="group" aria-label="Prueba rápida">
            {quickError && <p role="alert">{quickError}</p>}
            {quickState?.state === 'running' && (
              <QuickProgress state={quickState} />
            )}
            {quickState?.state === 'failed' && (
              <p role="alert">
                Prueba rápida sin resultado: {quickState.error}
              </p>
            )}
            {quickState?.state === 'done' && <QuickResult state={quickState} />}
            <QuickComparison variants={quickVariants} />
          </div>
        )}
      {panelOpen && (
        <div className={RUN.series} role="group" aria-label="Pruebas seguidas">
          <label>
            ¿Cuántas pruebas seguidas?
            <input
              type="number"
              min={1}
              max={untried.length}
              value={count}
              onChange={(event) => setHowMany(Number(event.target.value) || 1)}
            />
          </label>
          <p className={RUN.hint}>
            Cada una en una etapa distinta del mercado, una después de otra:{' '}
            {plan.map((stage) => stage.label).join(' → ')}.{' '}
            {repeatable
              ? 'Se pueden repetir cuantas veces quieras.'
              : `Quedan ${untried.length} etapas sin probar.`}
          </p>
          <div className={RUN.seriesActions}>
            <button type="button" onClick={() => void runSeries(plan)}>
              Empezar
            </button>
            <button type="button" onClick={() => setPanelOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {testError && (
        <p role="alert" className={RUN.warn}>
          {testError}
        </p>
      )}
      {vbtWhy && vbtState && (
        <p className={RUN.hint} data-testid="vbt-why">
          {vbtWhy}
        </p>
      )}
      {vbtState && !vbtState.available && vbtState.reason && (
        <details className={VBT.install} data-testid="vbt-install">
          <summary>Cómo instalar VectorBT</summary>
          <p className={RUN.hint}>{vbtState.reason}</p>
          <pre aria-label="Comandos de instalación">{commands.join('\n')}</pre>
          <button type="button" onClick={copyCommands}>
            {copied ? 'Copiado' : 'Copiar comandos'}
          </button>
        </details>
      )}
      {vbtProblem && !shown && (
        <p role="alert" className={RUN.warn}>
          {vbtProblem}
        </p>
      )}

      <ol className={RUN.stages} aria-label="Etapa de la estrategia">
        {STAGES.map((name, index) => (
          <li
            key={name}
            className={RUN.stage}
            data-reached={index <= stage.index}
            aria-current={index === stage.index ? 'step' : undefined}
          >
            <span className={RUN.stageBar} aria-hidden="true" />
            <span className={RUN.stageName}>{name}</span>
          </li>
        ))}
      </ol>
      {(series || busy) && (
        <RunProgress
          label="Progreso de las pruebas"
          segments={{ done: doneTests, total: totalTests, live: livePercent }}
          percent={overallPercent}
          valueText={`${progressLabel} · ${overallPercent} %`}
        >
          <p className={RUN.progressText}>
            <span>
              {progressLabel} · {overallPercent} %
              {activeRun?.phase ? ` · ${activeRun.phase}` : ''}
            </span>
            {series && series.total > 1 && (
              <button
                type="button"
                onClick={() => {
                  stopSeries.current = true
                }}
              >
                Parar después de esta
              </button>
            )}
          </p>
        </RunProgress>
      )}
      {vbtRunning && (
        <VectorbtProgress
          exploration={vbtRunning}
          cancelling={cancelling}
          onCancel={() => void cancelExploration()}
        />
      )}
      {!vbtRunning &&
        lastFailed &&
        (lastFailed.status === 'failed' ||
          lastFailed.status === 'cancelled') && (
          <p className={RUN.hint} data-testid="vbt-last-failed">
            {lastFailed.status === 'cancelled'
              ? 'La última exploración con VectorBT se canceló.'
              : `La última exploración con VectorBT no terminó: ${lastFailed.detail}`}
          </p>
        )}
      <VectorbtVariantLink
        key={strategyId}
        api={vectorbt}
        registry={exploresRules ? registry : undefined}
        strategyId={strategyId}
        hasPractice={finished.length > 0}
      />
      {overviewError && !unknownToGate && (
        <p role="alert" className={RUN.warn}>
          No se pudieron leer las pruebas: {overviewError}
        </p>
      )}

      <div className={RUN.kpis} data-testid="run-kpis">
        <Kpi
          label="Operaciones cerradas"
          value={summary ? amount(summary.trades, 0) : '—'}
          note={
            summary
              ? `${summary.trades >= summary.min_trades ? '✓' : '✗'} Mínimo: ${summary.min_trades}`
              : ''
          }
          tone={summary && summary.trades < summary.min_trades ? 'bad' : null}
        />
        <Kpi
          label="Neto por operación"
          value={summary ? bp(summary.mean_bp) : '—'}
          note={
            summary
              ? `Después de costes${summary.funding_share != null && summary.funding_share < 0.95 ? ' · funding incompleto' : ''}`
              : ''
          }
          tone={summary && (summary.mean_bp ?? 0) < 0 ? 'bad' : null}
        />
        <Kpi
          label="Períodos positivos"
          value={summary ? `${summary.positive_folds} / ${summary.folds}` : '—'}
          note={
            summary
              ? `Mínimo: ${Math.ceil(summary.min_positive_fold_share * summary.folds - 1e-9)} de ${summary.folds}`
              : ''
          }
          tone={null}
        />
        <Kpi
          label="Frente al azar"
          value={
            summary && summary.percentile != null
              ? `${amount(summary.percentile, 0)} %`
              : '—'
          }
          note={summary ? `Mínimo: percentil ${summary.min_percentile}` : ''}
          tone={null}
        />
      </div>
      {scopeRun && (
        <ul className={RUN.scope} data-testid="run-evaluation-scope">
          {runScopeLines(scopeRun).map((line) => (
            <li key={line.key} data-tone={line.tone ?? undefined}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <VectorbtReportPanel
          key={shown.id}
          api={vectorbt}
          exploration={shown}
          choices={reports}
          onChoose={setPickedId}
          attempts={vbtState?.attempts_in_family ?? null}
          onConfirm={confirmVariant}
          confirming={confirming}
          problem={vbtProblem}
        />
      )}
      <div className={RUN.chartCard}>
        {overview && !unknownToGate && (
          <div className={RUN.tabsWrap}>
            <div className={RUN.tabs} role="group" aria-label="Tramos probados">
              {fallbackRun && (
                <button type="button" className={RUN.tab} aria-pressed={true}>
                  {fallbackLabel}
                </button>
              )}
              {tabs.map((tab) => {
                const shownNow =
                  tab.run !== null &&
                  (pickedTab !== null
                    ? pickedTab.stage.from === tab.stage.from
                    : data?.summary.run_id === tab.run.id)
                return (
                  <button
                    key={tab.stage.from}
                    type="button"
                    className={RUN.tab}
                    aria-pressed={shownNow}
                    disabled={tab.run === null}
                    data-untested={tab.run === null ? 'true' : undefined}
                    onClick={() => {
                      setPicked(tab.stage.from)
                      setFocusId(null)
                    }}
                  >
                    {tab.stage.label}
                    {tab.run === null && <small> · sin probar</small>}
                  </button>
                )
              })}
            </div>
            <p className={RUN.hint} data-testid="stage-count">
              {triedTabs.length} de {stageList.length} tramos probados
            </p>
          </div>
        )}
        <div className={RUN.chartHead}>
          <h4>
            {data
              ? `${data.product} · Velas de la prueba`
              : 'Velas de la prueba'}
          </h4>
          <span className={RUN.chartTags}>LONG / SHORT / Salidas</span>
        </div>
        {data?.candles && (
          <div className={RUN.scope}>
            <p className={RUN.hint} data-testid="run-scope">
              {data.view === 'full'
                ? fullViewText(
                    data.candles.resolution,
                    data.summary.range_start_ms,
                    data.summary.range_end_ms,
                  )
                : `Velas de ${resolutionText(data.candles.resolution)} · zoom a la operación${selected ? ` del ${dayLabel(selected.entry_time_ms)}` : ''}`}
            </p>
            {data.view === 'zoom' && (
              <button type="button" className={RUN.tab} onClick={showAll}>
                Ver todo el tramo
              </button>
            )}
          </div>
        )}
        {data?.view === 'full' && markers.some((m) => isGroupId(m.id)) && (
          <p className={RUN.hint} data-testid="run-groups-hint">
            Las marcas con «+N» agrupan varias operaciones: al hacer clic en una
            se abre la primera de su grupo.
          </p>
        )}

        {unknownToGate && (
          <p className={RUN.empty} data-testid="run-empty">
            Esta estrategia no tiene pruebas guardadas.
          </p>
        )}
        {state.kind === 'loading' && overviewError === null && (
          <p className={RUN.empty}>Cargando la última prueba…</p>
        )}
        {state.kind === 'empty' && (
          <p className={RUN.empty} data-testid="run-empty">
            {state.reason === 'no-runs'
              ? 'Todavía no hay pruebas terminadas de esta estrategia.'
              : state.reason === 'run-not-saved'
                ? 'Esa prueba no guardó sus operaciones: no hay gráfico de ella.'
                : 'Las pruebas anteriores no guardaron sus operaciones: no hay gráfico de ellas.'}
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className={RUN.empty}>
            {state.code === 'exam_not_unlocked'
              ? 'El examen todavía no terminó: sus velas y operaciones se muestran recién después.'
              : state.text}
          </p>
        )}

        {data && (
          <>
            {data.candlesError ? (
              <p className={RUN.empty} data-testid="run-no-candles">
                Sin datos de velas para esta ventana: {data.candlesError}
              </p>
            ) : (
              <div className={RUN.chart}>
                <ApprovedTerminalChart
                  key={`${data.summary.run_id}:${data.product}:${data.view}`}
                  candles={chartCandles}
                  markers={markers}
                  selectedId={
                    focused ?? (selected ? markerIds(selected).entry : '')
                  }
                  intervalSeconds={resolutionSeconds(
                    data.candles?.resolution ?? '1m',
                  )}
                  currency="USD"
                  instrument={data.product}
                  priceLines={priceLinesOf(selected)}
                  showVolume
                  onSelect={(_time, markerId) => {
                    if (isDiscardId(markerId)) {
                      setFocusId(markerId ?? null)
                      return
                    }
                    setFocusId(null)
                    // A group of entries or exits opens its first operation.
                    const group = isGroupId(markerId)
                      ? markers.find((marker) => marker.id === markerId)
                      : undefined
                    const id = tradeOfMarker(
                      group ? group.memberIds?.[0] : markerId,
                    )
                    const trade = data.trades.find((t) => t.trade_id === id)
                    if (trade) void select(trade)
                  }}
                  ariaLabel={`Velas de ${data.product} de la prueba con sus entradas y salidas`}
                />
              </div>
            )}
            {data.candles && data.candles.missing_minutes > 0 && (
              <p className={RUN.hint} data-testid="run-gaps">
                Faltan {data.candles.missing_minutes} velas de 1 minuto que
                Kraken no publicó en esta ventana; no se rellenaron.
              </p>
            )}
            {!data.tradesDone && (
              <p className={RUN.hint} data-testid="run-trades-loading">
                Cargando las operaciones del tramo: {data.trades.length} de{' '}
                {data.total}…
              </p>
            )}
            {data.tradesError && (
              <p className={RUN.hint} data-testid="run-trades-error">
                No se pudieron cargar todas las operaciones (se ven{' '}
                {data.trades.length} de {data.total}): {data.tradesError}
              </p>
            )}
            {fullView && traced && (traced.ignored_position_open ?? 0) > 0 && (
              <p className={RUN.hint} data-testid="run-ignored">
                {traced.ignored_position_open === 1
                  ? '1 señal ignorada porque ya había una posición abierta'
                  : `${amount(traced.ignored_position_open ?? 0, 0)} señales ignoradas porque ya había una posición abierta`}{' '}
                (no se dibujan).
              </p>
            )}
            {decided?.error && (
              <p className={RUN.hint} data-testid="run-decisions-error">
                No se pudo leer el detalle de decisiones: {decided.error}
              </p>
            )}
            {(!hasTrace || decided?.value?.captured === false) && (
              <p className={RUN.hint} data-testid="run-no-decisions">
                Esta prueba se guardó sin el detalle de decisiones; las entradas
                y salidas sí se ven.
              </p>
            )}
            {traced?.truncated && (
              <p className={RUN.hint} data-testid="run-decisions-cut">
                Hay más descartes en esta ventana de los que se muestran (los
                primeros {traced.signals.length}).
              </p>
            )}
            {data.total === 0 && (
              <p className={RUN.hint} data-testid="run-no-trades">
                La estrategia no abrió posiciones en este producto durante la
                prueba.
              </p>
            )}
            <ul className={RUN.legend} aria-label="Leyenda">
              <li>
                <b className={RUN.long}>L</b> Entrada LONG
              </li>
              <li>
                <b className={RUN.short}>S</b> Entrada SHORT
              </li>
              <li>
                <b>×</b> Salida (motivo en el detalle)
              </li>
              <li>
                <b>◦</b> Descarte
              </li>
              <li className={RUN.legendNote}>
                {data.summary.label} · eje del gráfico en UTC, tablas en hora de
                Madrid
              </li>
            </ul>
          </>
        )}
      </div>
      {vbtModal && vbtState && (
        <VectorbtModal
          strategyName={titleOf(strategyName)}
          attempts={vbtState.attempts_in_family}
          loadSpec={loadSpec}
          onLaunch={launchExploration}
          onClose={() => setVbtModal(false)}
        />
      )}
      {analyzerOpen && (
        <AnalyzerModal api={analyzer} onClose={() => setAnalyzerOpen(false)} />
      )}
    </section>
  )
}

function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string
  value: string
  note: string
  tone: 'bad' | null
}) {
  return (
    <div className={RUN.kpi}>
      <span className={RUN.kpiLabel}>{label}</span>
      <strong className={RUN.kpiValue} data-tone={tone ?? undefined}>
        {value}
      </strong>
      <span className={RUN.kpiLabel}>{note}</span>
    </div>
  )
}

const SIGNAL_TEXT = (ok: boolean | null) =>
  ok === null ? 'sin dato' : ok ? 'apunta bien' : 'no apunta bien'

/** «12 min» / «45 s» left, from the rate since Qwen began to be asked; `null` while there is nothing to measure. */
function quickRemaining(state: QuickState): string | null {
  const { answered = 0, total = 0, asking_ms: from, updated_ms: at } = state
  if (!from || !at || answered < 3 || total <= answered) return null
  const seconds = (((at - from) / answered) * (total - answered)) / 1000
  return seconds >= 90
    ? `${Math.round(seconds / 60)} min`
    : `${Math.round(seconds)} s`
}

function QuickProgress({ state }: { state: QuickState }) {
  const answered = state.answered ?? 0
  const total = state.total ?? state.snapshots
  const asking = state.phase === 'preguntando'
  const percent = asking && total > 0 ? (answered / total) * 100 : 0
  const left = quickRemaining(state)
  const silent =
    state.updated_ms && state.fetched_ms
      ? state.fetched_ms - state.updated_ms
      : 0
  const text = asking
    ? `Prueba rápida · ${answered} de ${total} fotos · ${Math.round(percent)} %${left ? ` · faltan unos ${left}` : ''}`
    : 'Prueba rápida · preparando las fotos del pasado…'
  return (
    <RunProgress
      label="Progreso de la prueba rápida"
      valueText={text}
      percent={percent}
    >
      <p className={RUN.progressText}>
        <span>{text}</span>
      </p>
      {silent > 120_000 && (
        <p className={RUN.hint} role="alert">
          Sin avances hace {Math.round(silent / 60_000)} min: puede estar
          trabada.
        </p>
      )}
    </RunProgress>
  )
}

const variantLabel = (variant: QuickVariant) =>
  variant.approx_gb
    ? `${variant.label} · ~${variant.approx_gb} GB`
    : variant.label

/** The finished variants side by side: the same photos, so the numbers compare. */
function QuickComparison({ variants }: { variants: QuickVariant[] }) {
  const done = variants.filter((variant) => variant.summary)
  if (done.length < 2) return null
  return (
    <table aria-label="Comparación de variantes">
      <thead>
        <tr>
          <th scope="col">Variante</th>
          <th scope="col">Neto por operación</th>
          <th scope="col">Contra el azar</th>
          <th scope="col">Correlación</th>
        </tr>
      </thead>
      <tbody>
        {done.map((variant) => (
          <tr key={variant.id}>
            <th scope="row">{variant.label}</th>
            <td>{bp(variant.summary?.extremes_net_bp)}</td>
            <td>
              {variant.summary?.vs_random_pct == null
                ? 'sin dato'
                : `${amount(variant.summary.vs_random_pct, 0)} %`}
            </td>
            <td>
              {variant.summary?.spearman == null
                ? 'sin dato'
                : amount(variant.summary.spearman, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function QuickResult({ state }: { state: QuickState }) {
  const summary = state.summary
  if (!summary)
    return <p>Prueba rápida terminada, pero no alcanzó para una lectura.</p>
  return (
    <div>
      <p>
        <strong>Prueba rápida (orientativa)</strong> · {summary.photos} fotos ·
        a {summary.horizon_min / 60} horas
      </p>
      <ul>
        <li>
          Los extremos de la inclinación ganan {bp(summary.extremes_net_bp)} por
          operación después de costos: {SIGNAL_TEXT(summary.signals.extremes)}.
        </li>
        <li>
          Contra entradas al azar:{' '}
          {summary.vs_random_pct == null
            ? 'sin dato'
            : `${amount(summary.vs_random_pct, 0)} %`}{' '}
          ({SIGNAL_TEXT(summary.signals.random)}).
        </li>
        <li>
          La inclinación acompaña al movimiento (correlación{' '}
          {summary.spearman == null ? 'sin dato' : amount(summary.spearman, 2)}
          ): {SIGNAL_TEXT(summary.signals.spearman)}.
        </li>
      </ul>
      {summary.operacion && <QuickOperationTable op={summary.operacion} />}
      {summary.ficha && <QuickFichaTables ficha={summary.ficha} />}
      <p className={RUN.hint}>{summary.note}</p>
    </div>
  )
}

const hoursText = (value: number | null | undefined) =>
  value == null ? 'sin dato' : `${amount(value, 1)} h`

/** Version 8: each entry Qwen would make, closed by the fixed exit rule, against the formulas alone on the same photos. */
function QuickOperationTable({ op }: { op: QuickOperation }) {
  const q = op.qwen
  const rows: [string, QuickOperationStats][] = [
    ['Qwen (entradas que haría en vivo)', q],
    ['Qwen (todo lo que dijo LARGO o CORTO)', op.qwen_todas],
    ['La fórmula sola: maestro fuerte con portero a favor', op.formula],
    ['Maestro fuerte, sin portero', op.maestro_fuerte],
    ['Siempre largo en las fotos donde Qwen entró', op.siempre_largo],
    ['Siempre corto en las fotos donde Qwen entró', op.siempre_corto],
  ]
  return (
    <div data-testid="quick-operation">
      <p>
        <strong>Como opera la versión 8</strong> · cada entrada se cierra{' '}
        {op.salida}. Neto después de costos.
      </p>
      {q.n === 0 ? (
        <p>
          Qwen no entró en ninguna de las {op.fotos} fotos (esperar {op.espera},
          bloqueadas por el espejo {op.espejo_bloqueo}).
        </p>
      ) : (
        <ul>
          <li>
            Qwen entró en {q.n} de {op.fotos} fotos: {bp(q.neto_bp)} por
            operación (rango del 95 % {bp(q.ic[0])} a {bp(q.ic[1])}),{' '}
            {percentText(q.ganadoras)} ganadoras, {bp(q.total_bp)} en total:{' '}
            {SIGNAL_TEXT(op.signals.gana)}.
          </li>
          <li>
            Salidas: {q.por_vuelta} porque el maestro se dio vuelta,{' '}
            {q.por_tiempo} por tiempo; {hoursText(q.horas)} abiertas en
            promedio.
          </li>
          <li>
            Del lado del maestro en el {percentText(q.con_maestro)} de sus
            entradas, con el portero a favor en el {percentText(q.con_portero)}.
            Contra entradas al azar:{' '}
            {q.vs_azar_pct == null
              ? 'sin dato'
              : `${amount(q.vs_azar_pct, 0)} %`}{' '}
            ({SIGNAL_TEXT(op.signals.azar)}).
          </li>
        </ul>
      )}
      <div className={RUN.tableWrap}>
        <table className={RUN.table} aria-label="Por operación">
          <thead>
            <tr>
              <th scope="col">Qué</th>
              <th scope="col">Operaciones</th>
              <th scope="col">Neto por operación</th>
              <th scope="col">Ganadoras</th>
              <th scope="col">Por vuelta / por tiempo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, stats]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{stats.n}</td>
                <td>{bp(stats.neto_bp)}</td>
                <td>{percentText(stats.ganadoras)}</td>
                <td>
                  {stats.por_vuelta} / {stats.por_tiempo}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const percentText = (value: number | null | undefined) =>
  value == null ? 'sin dato' : `${amount(value * 100, 0)} %`

const rhoText = (value: number | null | undefined) =>
  value == null ? 'sin dato' : (signedAmount(value, 2) ?? 'sin dato')

/** What the sheet variants add: which lines Qwen reads, and how its sum compares with the rule without Qwen. */
function QuickFichaTables({ ficha }: { ficha: QuickFicha }) {
  return (
    <div>
      <p>
        <strong>Lectura por renglón</strong> · {ficha.reads} de{' '}
        {ficha.readings.length} renglones leídos, sobre {ficha.photos} fotos con
        espejo
      </p>
      <div className={RUN.tableWrap}>
        <table className={RUN.table} aria-label="Lectura por renglón">
          <thead>
            <tr>
              <th scope="col">Renglón</th>
              <th scope="col">Se mide contra</th>
              <th scope="col">Vota</th>
              <th scope="col">Da vuelta en el espejo</th>
              <th scope="col">Hábito</th>
              <th scope="col">Correlación</th>
              <th scope="col">Veredicto</th>
            </tr>
          </thead>
          <tbody>
            {ficha.readings.map((line) => (
              <tr key={line.id}>
                <th scope="row">
                  {line.id} {line.label}
                </th>
                <td>{line.number}</td>
                <td>
                  {line.id === 'F4' && line.verdict === 'sin dato'
                    ? 'sin fotos fuera del área'
                    : `${percentText(line.vote_share)} (${line.vote_n ?? 0} fotos)`}
                </td>
                <td>
                  {percentText(line.flip_share)} ({line.flip_n} fotos)
                </td>
                <td>{rhoText(line.habit)}</td>
                <td>
                  {rhoText(line.corr)} ({line.corr_n} fotos)
                </td>
                <td>{line.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={RUN.hint}>
        Votar y leer son cosas distintas. «Vota»: parte de las fotos donde el
        gradiente real es de al menos 0,25 (F4 cuenta solo las fotos con el
        precio fuera del área). «Da vuelta»: entre las que votó, parte donde el
        signo cambia en el espejo. «Hábito»: promedio de real y espejo, lo que
        diría igual con los números del revés. Veredicto, en este orden: «no
        vota» si vota en menos de 20 % de las fotos o en menos de 5; «lee» si da
        vuelta el signo en 80 % o más y la correlación llega a 0,5 (en valor
        absoluto: negativa quiere decir que lo contradice); «sesgado» si la
        correlación llega a 0,5 pero da vuelta menos de 80 % (lee el tamaño, el
        hábito manda el signo); «no lee» si la correlación es menor a 0,2 o da
        vuelta menos de 60 %; si no, «a medias».
      </p>
      <p>
        <strong>Contra la regla sin Qwen</strong> · en las mismas fotos
      </p>
      <div className={RUN.tableWrap}>
        <table className={RUN.table} aria-label="Contra la regla sin Qwen">
          <thead>
            <tr>
              <th scope="col">Plazo</th>
              <th scope="col">Suma de Qwen</th>
              <th scope="col">Regla sin Qwen</th>
              <th scope="col">Siempre largo</th>
              <th scope="col">Siempre corto</th>
            </tr>
          </thead>
          <tbody>
            {ficha.comparison.map((row) => (
              <tr key={row.horizon_min}>
                <th scope="row">{row.horizon_min / 60} h</th>
                <td>{rhoText(row.qwen_spearman)}</td>
                <td>{rhoText(row.rule_spearman)}</td>
                <td>{bp(row.always_long_net_bp)}</td>
                <td>{bp(row.always_short_net_bp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={RUN.hint}>
        Correlación (Spearman) de cada suma con el movimiento del precio; la
        regla usa F1, F2, F3, F4 y F6 con signo de reversión y pesos iguales.
        Siempre largo y siempre corto: neto por operación después de costos.
      </p>
    </div>
  )
}
