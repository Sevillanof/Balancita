import { useEffect, useMemo, useState } from 'react'
import ApprovedTerminalChart, {
  type ApprovedTerminalMarker,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import {
  COMPARATOR_LABELS,
  COMPARATORS,
  FEATURE_REFS,
  cloneSpec,
  featureLabel,
  formatDecimal,
  isDecimal,
  isFeature,
  isParam,
  operandLabel,
  parseDecimalInput,
  parseParamValues,
  parseSpecText,
  patchCondition,
  resolveValue,
  rulesOf,
  rulesScopes,
  sideConditions,
  strategyNumber,
  type Comparator,
  type Operand,
  type Rules,
  type RulesScope,
  type Side,
  type StrategySpec,
} from '../domain/strategy-spec.ts'
import { exampleStrategyApi } from '../infrastructure/example-strategy-api.ts'
import {
  loadLabCandles,
  type LabCandles,
} from '../infrastructure/lab-candles.ts'
import {
  StrategyApiError,
  connectStrategyApi,
  type Backtest,
  type Gate,
  type PeriodDays,
  type Ranking,
  type StrategyApi,
  type StrategyDetail,
  type StrategyState,
} from '../infrastructure/strategy-api.ts'
import {
  loadQwenScores,
  type QwenScores,
} from '../infrastructure/qwen-scores.ts'
import { percent, price, signedPercent, signedUsd, utcTime } from './format.ts'
import { QwenFocusHead, QwenSide } from './QwenPanels.tsx'
import './StrategyLab.css'

type Props = {
  loadCandles?: () => Promise<LabCandles>
  connect?: (candles: LabCandles) => Promise<StrategyApi>
  loadQwen?: () => Promise<QwenScores>
}

type Tab = 'rules' | 'params' | 'risk' | 'json' | 'versions'
type SaveMode = 'modify' | 'new'
type ImportSource = 'json' | 'pine' | 'freqtrade'
type Dot = StrategyState | 'preview' | 'reference' | 'qwen'

type Row = {
  key: string
  id: string | null
  label: string
  state: Dot
  returnPct: number | null
  hitRate: number | null
  trades: number
  few: boolean
}

const PERIODS: readonly PeriodDays[] = [7, 30, 90]
const STATE_LABELS: Record<Dot, string> = {
  active: 'Activa en paper',
  shadow: 'En sombra',
  draft: 'Borrador',
  retired: 'Retirada',
  preview: 'Cambios sin guardar',
  reference: 'Referencia',
  qwen: 'Decisiones de Qwen',
}
const SOURCE_LABELS: Record<LabCandles['source'], string> = {
  live: 'velas reales de Terminal',
  mock: 'velas del fixture MOCK de Terminal',
  synthetic: 'velas sintéticas (Terminal no respondió)',
}
const EXIT_LABELS: Record<string, string> = {
  stop: 'stop',
  target: 'objetivo',
  strategy_exit: 'regla de salida',
  time_stop: 'tiempo',
}
const GATE_LABELS: Record<string, string> = {
  backtested: 'Tiene un backtest',
  was_in_shadow: 'Pasó por sombra',
  oos_trades: 'Trades fuera de muestra',
  oos_mean_net_bp_positive: 'Neto medio fuera de muestra positivo',
  deflated_sharpe: 'Sharpe deflactado ≥ 0,95',
}
const SCOPE_LABELS: Record<RulesScope, string> = {
  rules: 'Reglas',
  trend: 'En tendencia',
  range: 'En rango',
}

function defaultConnect(market: LabCandles): Promise<StrategyApi> {
  return connectStrategyApi(undefined, async () =>
    exampleStrategyApi(market.candles),
  )
}

function shortName(name: string, id: string) {
  const number = strategyNumber(id)
  return number === null || name.startsWith(`C${number}`)
    ? name
    : `C${number} · ${name}`
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function downloadJson(spec: StrategySpec) {
  const blob = new Blob([`${JSON.stringify(spec, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${spec.id}.v${spec.version}.json`
  link.click()
  URL.revokeObjectURL(url)
}

export default function StrategyLab({
  loadCandles = loadLabCandles,
  connect = defaultConnect,
  loadQwen = loadQwenScores,
}: Props) {
  const [market, setMarket] = useState<LabCandles | null>(null)
  const [api, setApi] = useState<StrategyApi | null>(null)
  const [days, setDays] = useState<PeriodDays>(30)
  const [reload, setReload] = useState(0)
  const [ranking, setRanking] = useState<Ranking | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<StrategyDetail | null>(null)
  const [draft, setDraft] = useState<StrategySpec | null>(null)
  const [saved, setSaved] = useState<Backtest | null>(null)
  const [preview, setPreview] = useState<{
    key: string
    result: Backtest
  } | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [dots, setDots] = useState<Map<string, boolean | null>>(new Map())
  const [tab, setTab] = useState<Tab>('rules')
  const [scope, setScope] = useState<RulesScope>('rules')
  const [side, setSide] = useState<Side>('LONG')
  const [saveMode, setSaveMode] = useState<SaveMode>('modify')
  const [newName, setNewName] = useState('')
  const [sweepParam, setSweepParam] = useState('')
  const [sweepText, setSweepText] = useState('')
  const [jsonText, setJsonText] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importSource, setImportSource] = useState<ImportSource>('json')
  const [importText, setImportText] = useState('')
  const [importNotes, setImportNotes] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gates, setGates] = useState<Gate[]>([])
  const [busy, setBusy] = useState(false)
  const [qwen, setQwen] = useState<QwenScores | null>(null)
  const [qwenFocus, setQwenFocus] = useState(false)

  useEffect(() => {
    let active = true
    void loadQwen().then((loaded) => active && setQwen(loaded))
    return () => {
      active = false
    }
  }, [loadQwen, reload])

  useEffect(() => {
    let active = true
    void loadCandles().then(async (loaded) => {
      if (!active) return
      setMarket(loaded)
      const connected = await connect(loaded)
      if (active) setApi(connected)
    })
    return () => {
      active = false
    }
  }, [loadCandles, connect])

  useEffect(() => {
    if (!api) return
    let active = true
    api.ranking(days).then(
      (loaded) => {
        if (!active) return
        setRanking(loaded)
        setSelectedId((current) => current ?? loaded.strategies[0]?.id ?? null)
      },
      (failure: unknown) => active && setError(errorText(failure)),
    )
    return () => {
      active = false
    }
  }, [api, days, reload])

  useEffect(() => {
    if (!api || !selectedId) return
    let active = true
    api.detail(selectedId).then(
      (loaded) => {
        if (!active) return
        setDetail(loaded)
        setDraft(cloneSpec(loaded.spec))
        setScope(rulesScopes(loaded.spec)[0] ?? 'rules')
        setSweepParam(Object.keys(loaded.spec.params)[0] ?? '')
        setJsonText(null)
        setShowPreview(false)
        setGates([])
      },
      (failure: unknown) => active && setError(errorText(failure)),
    )
    return () => {
      active = false
    }
  }, [api, selectedId, reload])

  useEffect(() => {
    if (!api || !detail || !ranking?.verdicts_available) return
    let active = true
    const ref = { id: detail.id, version: detail.version }
    api.backtest(ref, days).then(
      (result) => active && setSaved(result),
      (failure: unknown) => active && setError(errorText(failure)),
    )
    api.evaluate(ref).then(
      (evaluation) => {
        if (!active) return
        setDots(
          new Map(
            evaluation.proposal.conditions.map((condition) => [
              condition.code,
              condition.passed,
            ]),
          ),
        )
      },
      () => active && setDots(new Map()),
    )
    return () => {
      active = false
    }
  }, [api, detail, days, ranking?.verdicts_available])

  const candles = useMemo(() => market?.candles ?? [], [market])
  const draftKey = draft ? JSON.stringify(draft) : ''
  const dirty = detail !== null && draftKey !== JSON.stringify(detail.spec)
  const previewResult =
    preview && preview.key === `${days}:${draftKey}` ? preview.result : null
  const result = showPreview && previewResult ? previewResult : saved
  const scopes = draft ? rulesScopes(draft) : []
  const rules: Rules | undefined = draft ? rulesOf(draft, scope) : undefined
  const conditions = sideConditions(rules, side)
  const draftLabel = draft ? shortName(draft.name, draft.id) : '—'

  const qwenProduct = qwen?.products.find(
    (product) => product.product_id === 'PF_XBTUSD',
  )

  const rows: Row[] = useMemo(() => {
    if (!ranking) return []
    const list: Row[] = ranking.strategies.map((row) => ({
      key: row.id,
      id: row.id,
      label: `${shortName(row.name, row.id)}${row.version > 1 ? ` v${row.version}` : ''}`,
      state: row.state,
      returnPct: row.return_pct,
      hitRate: row.hit_rate,
      trades: row.trades,
      few: row.few_trades,
    }))
    if (previewResult && detail)
      list.push({
        key: 'preview',
        id: null,
        label: `${shortName(detail.name, detail.id)} · cambios sin guardar`,
        state: 'preview',
        returnPct: previewResult.all.return_pct,
        hitRate: previewResult.all.hit_rate,
        trades: previewResult.all.trades,
        few: previewResult.all.trades < ranking.min_trades,
      })
    list.push({
      key: 'qwen',
      id: null,
      label: 'Qwen',
      state: 'qwen',
      returnPct: qwenProduct ? qwenProduct.trading.return_pct : null,
      hitRate: qwenProduct ? qwenProduct.trading.hit_rate : null,
      trades: qwenProduct?.trading.trades ?? 0,
      few: (qwenProduct?.trading.trades ?? 0) < ranking.min_trades,
    })
    list.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity))
    if (ranking.buy_and_hold_pct !== null)
      list.push({
        key: 'reference',
        id: null,
        label: 'Comprar y mantener',
        state: 'reference',
        returnPct: ranking.buy_and_hold_pct,
        hitRate: null,
        trades: 0,
        few: false,
      })
    return list
  }, [ranking, previewResult, detail, qwenProduct])

  const bestReturn = Math.max(
    0.1,
    ...rows.map((row) => Math.abs(row.returnPct ?? 0)),
  )

  const first = candles[0]?.time ?? 0
  const last = candles.at(-1)?.time ?? 0
  const trades = qwenFocus
    ? (qwenProduct?.trades ?? [])
    : (result?.trades ?? [])
  const visible = trades.filter(
    (trade) =>
      trade.entry_time_ms / 1000 >= first && trade.entry_time_ms / 1000 <= last,
  )
  const markers: ApprovedTerminalMarker[] = visible.flatMap((trade, index) => [
    {
      id: `entry-${index}`,
      time: Math.floor(trade.entry_time_ms / 1000),
      type: 'entry' as const,
      direction: trade.side === 'LONG' ? ('long' as const) : ('short' as const),
      label: trade.side === 'LONG' ? 'L' : 'S',
    },
    {
      id: `exit-${index}`,
      time: Math.min(Math.floor(trade.exit_time_ms / 1000), last),
      type: 'exit' as const,
      label: signedPercent(trade.net_bp / 100, 2),
    },
  ])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setGates([])
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
      if (failure instanceof StrategyApiError) setGates(failure.gates)
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string) => {
    setSelectedId(id)
    setSaveMode('modify')
    setNotice(null)
    setError(null)
  }

  const refresh = (id: string, message: string) => {
    setSelectedId(id)
    setReload((value) => value + 1)
    setSaveMode('modify')
    setNotice(message)
  }

  const update = (next: StrategySpec) => {
    setDraft(next)
    setShowPreview(false)
  }

  const setParam = (param: string, text: string) => {
    const value = parseDecimalInput(text)
    if (!draft || value === null) return
    const next = cloneSpec(draft)
    next.params[param] = value
    update(next)
  }

  const setRisk = (key: 'stop_atr' | 'target_stop_ratio', text: string) => {
    if (!draft || !rules) return
    const current = rules.risk[key]
    if (isParam(current)) return setParam(current.slice(1), text)
    const value = parseDecimalInput(text)
    if (value === null) return
    const next = cloneSpec(draft)
    rulesOf(next, scope)!.risk[key] = value
    update(next)
  }

  const testDraft = () =>
    run(async () => {
      if (!api || !draft) return
      const tested = await api.backtest({ spec: draft }, days)
      setPreview({ key: `${days}:${JSON.stringify(draft)}`, result: tested })
      setShowPreview(true)
    })

  const save = () =>
    run(async () => {
      if (!api || !draft || !detail) return
      const entry = await api.save(
        draft,
        saveMode,
        saveMode === 'new' ? newName.trim() || undefined : undefined,
      )
      refresh(
        entry.id,
        saveMode === 'new'
          ? `Guardada como ${shortName(entry.name, entry.id)}. ${shortName(detail.name, detail.id)} quedó como estaba.`
          : `Guardada ${shortName(entry.name, entry.id)} v${entry.version} como borrador.`,
      )
    })

  const createVariants = () =>
    run(async () => {
      const values = parseParamValues(sweepText)
      if (!api || !detail || !values) return
      const created = await api.variants(
        detail.id,
        detail.version,
        sweepParam,
        values,
      )
      setSweepText('')
      setReload((value) => value + 1)
      setNotice(
        created.length === 0
          ? 'Ningún valor cambia el parámetro actual.'
          : `${created.length} variantes creadas como borrador y agregadas al ranking.`,
      )
    })

  const changeState = (state: StrategyState) =>
    run(async () => {
      if (!api || !detail) return
      await api.setState(detail.id, detail.version, state)
      refresh(
        detail.id,
        `${shortName(detail.name, detail.id)} pasó a ${STATE_LABELS[state].toLowerCase()}.`,
      )
    })

  const importSpec = () =>
    run(async () => {
      if (!api) return
      if (importSource !== 'json') {
        const translated = await api.translate(importText, importSource)
        if (!translated.spec)
          throw new Error(
            translated.error ?? 'El modelo no devolvió una estrategia.',
          )
        setImportText(JSON.stringify(translated.spec, null, 2))
        setImportNotes([
          ...(translated.untranslatable ?? []).map(
            (note) => `No traducido: ${note}`,
          ),
          ...(translated.error ? [translated.error] : []),
        ])
        setImportSource('json')
        setNotice('Revisá la traducción y luego importala como borrador.')
        return
      }
      const { spec, error: parseError } = parseSpecText(importText)
      if (!spec) throw new Error(parseError ?? 'JSON inválido')
      const entry = await api.importSpec(spec)
      setImporting(false)
      setImportText('')
      setImportNotes([])
      refresh(
        entry.id,
        `Importada ${shortName(entry.name, entry.id)} como borrador.`,
      )
    })

  const applyJson = () => {
    if (jsonText === null) return
    const { spec, error: parseError } = parseSpecText(jsonText)
    if (!spec) return setError(parseError)
    setError(null)
    setJsonText(null)
    update(spec)
  }

  const startNew = () => {
    setSaveMode('new')
    setNewName(draft ? `${draft.name} (copia)` : 'Nueva estrategia')
    setNotice(
      `Editá las reglas y guardá: se crea una estrategia nueva a partir de ${draftLabel}.`,
    )
  }

  const operandEditor = (
    operand: Operand,
    label: string,
    onChange: (next: Operand) => void,
  ) => {
    if (isFeature(operand))
      return (
        <select
          aria-label={label}
          value={operand}
          onChange={(event) =>
            onChange(
              event.target.value === '__number' ? '50' : event.target.value,
            )
          }
        >
          {(FEATURE_REFS.includes(operand)
            ? FEATURE_REFS
            : [operand, ...FEATURE_REFS]
          ).map((ref) => (
            <option key={ref} value={ref}>
              {featureLabel(ref)}
            </option>
          ))}
          <option value="__number">Número</option>
        </select>
      )
    if (isDecimal(operand))
      return (
        <input
          aria-label={label}
          className="strategy-lab__num-input"
          defaultValue={formatDecimal(operand)}
          key={`${label}-${operand}`}
          onBlur={(event) => {
            const value = parseDecimalInput(event.target.value)
            if (value !== null && value !== operand) onChange(value)
          }}
        />
      )
    if (isParam(operand) && draft)
      return (
        <label className="strategy-lab__param-chip">
          <span className="strategy-lab__num">{operand}</span>
          <input
            aria-label={label}
            className="strategy-lab__num-input"
            defaultValue={formatDecimal(draft.params[operand.slice(1)] ?? '')}
            key={`${label}-${draft.params[operand.slice(1)]}`}
            onBlur={(event) => setParam(operand.slice(1), event.target.value)}
          />
        </label>
      )
    return (
      <span className="strategy-lab__context strategy-lab__scale">
        {operandLabel(operand, draft?.params)}
      </span>
    )
  }

  const reference = ranking?.buy_and_hold_pct ?? null
  const all = result?.all
  const oos = result?.out_of_sample
  const example = api?.mode === 'example'
  const canSave = !busy && draft !== null && (saveMode === 'new' || dirty)

  return (
    <div className="strategy-lab">
      <div className="strategy-lab__toolbar">
        <h1>Laboratorio</h1>
        <p className="strategy-lab__context">
          {!market
            ? 'Cargando las velas de Terminal…'
            : !api
              ? 'Conectando con el registro de estrategias…'
              : example
                ? `Sin conexión con el registro de estrategias · datos de ejemplo sobre ${SOURCE_LABELS[market.source]}`
                : `Registro de estrategias · backtest sobre los veredictos de C (velas oficiales de Terminal) · PF_XBTUSD · ${days} d`}
        </p>
        <div className="strategy-lab__toolbar-actions">
          <div
            className="strategy-lab__seg"
            role="group"
            aria-label="Período de la prueba"
          >
            {PERIODS.map((value) => (
              <button
                type="button"
                aria-pressed={days === value}
                key={value}
                disabled={example}
                title={
                  example
                    ? 'Los periodos necesitan el registro de estrategias'
                    : undefined
                }
                onClick={() => setDays(value)}
              >
                {value} d
              </button>
            ))}
          </div>
          <button
            type="button"
            className="strategy-lab__button"
            onClick={() => setImporting((open) => !open)}
            aria-expanded={importing}
          >
            Importar
          </button>
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--primary"
            onClick={startNew}
            disabled={!draft}
          >
            Nueva estrategia
          </button>
        </div>
      </div>

      {example && (
        <p className="strategy-lab__notice strategy-lab__notice--warn">
          El registro de estrategias no respondió: ranking, trades y resultados
          son de ejemplo y no salen de un backtest. Con <code>pnpm dev</code> y
          el registro corriendo se ven los datos reales.
        </p>
      )}
      {ranking && !ranking.verdicts_available && (
        <p className="strategy-lab__notice strategy-lab__notice--warn">
          Todavía no hay veredictos guardados para backtestear
          {ranking.detail ? ` (${ranking.detail})` : ''}.
        </p>
      )}
      {notice && (
        <p role="status" className="strategy-lab__notice">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert" className="strategy-lab__errors">
          <p>{error}</p>
          {gates.length > 0 && (
            <ul>
              {gates.map((gate) => (
                <li
                  key={gate.code}
                  className={gate.passed ? 'is-up' : 'is-down'}
                >
                  {gate.passed ? '✓' : '✗'}{' '}
                  {GATE_LABELS[gate.code] ?? gate.code}
                  {gate.value !== null && gate.value !== undefined
                    ? ` · ${String(gate.value)} (pide ${String(gate.threshold)})`
                    : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {importing && (
        <section
          className="strategy-lab__import"
          aria-label="Importar estrategia"
        >
          <div className="strategy-lab__seg" role="group" aria-label="Formato">
            {(
              [
                ['json', 'JSON'],
                ['pine', 'Pine Script'],
                ['freqtrade', 'freqtrade'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={importSource === value}
                onClick={() => setImportSource(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label htmlFor="strategy-lab-import">
            {importSource === 'json'
              ? 'Pegá una estrategia en JSON (balancita-strategy.v1). Entra como borrador.'
              : 'Pegá el código: el modelo local lo traduce a una estrategia para revisar. El código nunca se ejecuta.'}
          </label>
          <textarea
            id="strategy-lab-import"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            rows={6}
            spellCheck={false}
          />
          {importNotes.length > 0 && (
            <ul className="strategy-lab__context">
              {importNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <div className="strategy-lab__row-actions">
            <button
              type="button"
              className="strategy-lab__button strategy-lab__button--primary"
              onClick={importSpec}
              disabled={busy || importText.trim() === ''}
            >
              {importSource === 'json' ? 'Importar como borrador' : 'Traducir'}
            </button>
            <button
              type="button"
              className="strategy-lab__button strategy-lab__button--ghost"
              onClick={() => setImporting(false)}
            >
              Cancelar
            </button>
          </div>
        </section>
      )}

      <div className="strategy-lab__grid">
        <section
          className="strategy-lab__panel strategy-lab__ranking"
          aria-labelledby="lab-ranking-title"
        >
          <div className="strategy-lab__panel-head">
            <h2 id="lab-ranking-title">Ranking por rentabilidad</h2>
            <span className="strategy-lab__eyebrow">acierto · trades</span>
          </div>
          {rows.length === 0 && (
            <p className="strategy-lab__empty">Cargando estrategias…</p>
          )}
          <ol className="strategy-lab__rank-list">
            {rows.map((row) => {
              const current =
                row.state === 'qwen'
                  ? qwenFocus
                  : !qwenFocus &&
                    (row.state === 'preview'
                      ? showPreview
                      : row.id !== null &&
                        row.id === selectedId &&
                        !showPreview)
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    className={`strategy-lab__rank strategy-lab__rank--${row.state}`}
                    aria-pressed={current}
                    disabled={row.state === 'reference'}
                    onClick={() => {
                      setQwenFocus(row.state === 'qwen')
                      if (row.state === 'preview') setShowPreview(true)
                      else if (row.id) {
                        setShowPreview(false)
                        if (row.id !== selectedId) select(row.id)
                      }
                    }}
                  >
                    <span
                      className={`strategy-lab__dot strategy-lab__dot--${row.state}`}
                      title={STATE_LABELS[row.state]}
                    />
                    <span className="strategy-lab__rank-name">{row.label}</span>
                    <span
                      className={`strategy-lab__num strategy-lab__rank-return ${(row.returnPct ?? 0) >= 0 ? 'is-up' : 'is-down'}`}
                    >
                      {row.returnPct === null
                        ? '—'
                        : signedPercent(row.returnPct, 2)}
                    </span>
                    <span className="strategy-lab__bar" aria-hidden="true">
                      <span
                        className={
                          (row.returnPct ?? 0) >= 0 ? 'is-up' : 'is-down'
                        }
                        style={{
                          width: `${Math.round((Math.abs(row.returnPct ?? 0) / bestReturn) * 100)}%`,
                        }}
                      />
                    </span>
                    <span
                      className={`strategy-lab__num strategy-lab__rank-hit${row.few ? ' is-few' : ''}`}
                    >
                      {row.state === 'reference'
                        ? 'referencia'
                        : row.state === 'qwen' && !qwenProduct
                          ? 'sin decisiones'
                          : row.hitRate === null
                            ? 'sin trades'
                            : `${percent(row.hitRate * 100)} · ${row.trades}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="strategy-lab__legend">
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--active" />
              activa
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--shadow" />
              sombra
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--draft" />
              borrador
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--preview" />
              sin guardar
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--qwen" />
              Qwen
            </span>
            <span>gris = menos de {ranking?.min_trades ?? 30} trades</span>
          </div>
          <a className="strategy-lab__legacy" href="/historicos">
            Pruebas históricas spot (BTC-EUR)
          </a>
        </section>

        <section
          className="strategy-lab__panel strategy-lab__focus"
          aria-label="Resultado de la estrategia elegida"
        >
          {qwenFocus ? (
            <QwenFocusHead scores={qwen} product={qwenProduct} />
          ) : (
            <>
              <div className="strategy-lab__panel-head">
                <h2>
                  {showPreview && previewResult
                    ? `${draftLabel} · cambios sin guardar`
                    : detail
                      ? `${shortName(detail.name, detail.id)}${detail.version > 1 ? ` v${detail.version}` : ''}`
                      : '—'}
                </h2>
                {detail && (
                  <span
                    className={`strategy-lab__chip strategy-lab__chip--${showPreview ? 'preview' : detail.state}`}
                  >
                    {STATE_LABELS[showPreview ? 'preview' : detail.state]}
                  </span>
                )}
                <span className="strategy-lab__context">
                  {example
                    ? 'Datos de ejemplo'
                    : `Book paper propio · costos y tamaño de D · 70 % dentro / 30 % fuera de muestra${result ? ` · ${result.trials} pruebas` : ''}`}
                </span>
              </div>
              {all && (
                <div className="strategy-lab__kpis">
                  <div className="strategy-lab__kpi strategy-lab__kpi--key">
                    <span className="strategy-lab__eyebrow">Rentabilidad</span>
                    <strong
                      className={`strategy-lab__num ${all.return_pct >= 0 ? 'is-up' : 'is-down'}`}
                    >
                      {signedPercent(all.return_pct, 2)}
                    </strong>
                    <span className="strategy-lab__num">
                      {signedUsd(all.pnl_usd)}
                    </span>
                  </div>
                  <div className="strategy-lab__kpi strategy-lab__kpi--key">
                    <span className="strategy-lab__eyebrow">Acierto</span>
                    <strong className="strategy-lab__num">
                      {all.hit_rate === null
                        ? '—'
                        : percent(all.hit_rate * 100)}
                    </strong>
                    <span className="strategy-lab__num">
                      {all.wins} de {all.trades} trades
                    </span>
                  </div>
                  <div className="strategy-lab__kpi">
                    <span className="strategy-lab__eyebrow">
                      Vs comprar y mantener
                    </span>
                    <strong className="strategy-lab__num">
                      {result.vs_buy_and_hold_pts === null
                        ? '—'
                        : signedPercent(result.vs_buy_and_hold_pts, 2).replace(
                            ' %',
                            ' pts',
                          )}
                    </strong>
                    <span className="strategy-lab__num">
                      {reference === null ? '' : signedPercent(reference, 2)}
                    </span>
                  </div>
                  <div className="strategy-lab__kpi">
                    <span className="strategy-lab__eyebrow">Caída máxima</span>
                    <strong className="strategy-lab__num is-down">
                      {result.max_drawdown.pct === null
                        ? '—'
                        : signedPercent(result.max_drawdown.pct, 2)}
                    </strong>
                  </div>
                  <div className="strategy-lab__kpi">
                    <span className="strategy-lab__eyebrow">
                      Fuera de muestra
                    </span>
                    <strong
                      className={`strategy-lab__num ${(oos?.return_pct ?? 0) >= 0 ? 'is-up' : 'is-down'}`}
                    >
                      {oos ? signedPercent(oos.return_pct, 2) : '—'}
                    </strong>
                    <span className="strategy-lab__num">
                      {oos?.hit_rate === null || oos === undefined
                        ? 'sin trades'
                        : `${percent(oos.hit_rate * 100)} de ${oos.trades}`}
                      {result.deflated_sharpe_probability === null
                        ? ''
                        : ` · Sharpe defl. ${percent(result.deflated_sharpe_probability * 100)}`}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="strategy-lab__chart">
            {candles.length > 0 ? (
              <ApprovedTerminalChart
                candles={candles}
                markers={markers}
                selectedId=""
                intervalSeconds={60}
                currency="USD"
                instrument="BTC/USD perpetuo"
                onSelect={() => {}}
                ariaLabel="Velas de Terminal con los trades de la estrategia elegida"
              />
            ) : (
              <p className="strategy-lab__empty">
                Cargando las velas de Terminal…
              </p>
            )}
          </div>
          <div className="strategy-lab__chart-legend">
            <span>
              <b className="is-up">▲</b> entrada larga
            </span>
            <span>
              <b className="is-down">▼</b> entrada corta
            </span>
            <span>
              <b className="is-info">●</b> salida con su resultado neto
            </span>
            {trades.length > visible.length && (
              <span>
                {visible.length} de {trades.length} trades caen en la ventana
                del gráfico
              </span>
            )}
          </div>
        </section>

        {qwenFocus ? (
          <QwenSide product={qwenProduct} />
        ) : (
          <aside
            className="strategy-lab__panel strategy-lab__editor"
            aria-label={`Editar ${draftLabel}`}
          >
            <div className="strategy-lab__panel-head">
              <h2>
                {draftLabel}
                {draft && draft.version > 1 ? ` v${draft.version}` : ''}
              </h2>
            </div>
            {draft?.description && (
              <p className="strategy-lab__description">{draft.description}</p>
            )}
            <div
              className="strategy-lab__tabs"
              role="tablist"
              aria-label="Partes de la estrategia"
            >
              {(
                [
                  ['rules', 'Reglas'],
                  ['params', 'Parámetros'],
                  ['risk', 'Riesgo'],
                  ['json', 'JSON'],
                  ['versions', 'Versiones'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'rules' && draft && (
              <div className="strategy-lab__tab-body">
                {scopes.length > 1 && (
                  <div
                    className="strategy-lab__seg"
                    role="group"
                    aria-label="Régimen"
                  >
                    {scopes.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={scope === value}
                        onClick={() => setScope(value)}
                      >
                        {SCOPE_LABELS[value]}
                      </button>
                    ))}
                  </div>
                )}
                <div className="strategy-lab__side-row">
                  <div
                    className="strategy-lab__seg"
                    role="group"
                    aria-label="Lado"
                  >
                    {(['LONG', 'SHORT'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={side === value}
                        onClick={() => setSide(value)}
                        disabled={!rules?.sides[value]}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <span className="strategy-lab__context">
                    Entra si se cumplen todas · punto = última vela
                  </span>
                </div>
                {conditions.length === 0 && (
                  <p className="strategy-lab__context">
                    Sin condiciones para este lado.
                  </p>
                )}
                <ul className="strategy-lab__rules">
                  {conditions.map(({ path, node }, index) => {
                    const state = dots.get(node.cmp)
                    const patch = (
                      change: Parameters<typeof patchCondition>[3],
                    ) => update(patchCondition(draft, scope, path, change))
                    return (
                      <li
                        key={`${path.check}-${path.steps.join('.')}`}
                        className="strategy-lab__rule"
                      >
                        <span
                          className={`strategy-lab__dot ${state === true ? 'strategy-lab__dot--active' : state === false ? 'strategy-lab__dot--fail' : ''}`}
                          title={
                            state === true
                              ? 'Se cumple en la última vela'
                              : state === false
                                ? 'No se cumple en la última vela'
                                : 'Sin datos todavía'
                          }
                        />
                        {operandEditor(
                          node.left,
                          `Condición ${index + 1}: indicador`,
                          (left) => patch({ left }),
                        )}
                        <select
                          aria-label={`Condición ${index + 1}: comparador`}
                          className="strategy-lab__op"
                          value={node.op}
                          onChange={(event) =>
                            patch({ op: event.target.value as Comparator })
                          }
                        >
                          {COMPARATORS.map((op) => (
                            <option key={op} value={op}>
                              {COMPARATOR_LABELS[op]}
                            </option>
                          ))}
                        </select>
                        {operandEditor(
                          node.right,
                          `Condición ${index + 1}: contra`,
                          (right) => patch({ right }),
                        )}
                      </li>
                    )
                  })}
                </ul>
                <small className="strategy-lab__context">
                  Para agregar o quitar condiciones editá la pestaña JSON.
                </small>
              </div>
            )}

            {tab === 'params' && draft && (
              <div className="strategy-lab__tab-body">
                <fieldset className="strategy-lab__params">
                  <legend className="strategy-lab__eyebrow">Parámetros</legend>
                  {Object.entries(draft.params).map(([param, value]) => (
                    <label key={param}>
                      <span className="strategy-lab__num">${param}</span>
                      <input
                        aria-label={`Parámetro ${param}`}
                        defaultValue={formatDecimal(value)}
                        key={`${param}-${value}`}
                        onBlur={(event) => setParam(param, event.target.value)}
                      />
                      <small>
                        {detail && detail.spec.params[param] !== value
                          ? `antes ${formatDecimal(detail.spec.params[param] ?? '—')}`
                          : ' '}
                      </small>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="strategy-lab__params strategy-lab__sweep">
                  <legend className="strategy-lab__eyebrow">
                    Probar varios valores
                  </legend>
                  <label>
                    <span>Parámetro</span>
                    <select
                      aria-label="Parámetro a barrer"
                      value={sweepParam}
                      onChange={(event) => setSweepParam(event.target.value)}
                    >
                      {Object.keys(draft.params).map((param) => (
                        <option key={param} value={param}>
                          ${param}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Valores</span>
                    <input
                      aria-label="Valores a probar"
                      placeholder="35; 40; 45"
                      value={sweepText}
                      aria-invalid={
                        sweepText !== '' && parseParamValues(sweepText) === null
                      }
                      onChange={(event) => setSweepText(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="strategy-lab__button"
                    disabled={
                      busy ||
                      !sweepParam ||
                      parseParamValues(sweepText) === null
                    }
                    onClick={createVariants}
                  >
                    Crear variantes
                  </button>
                  <small>
                    Cada valor crea una estrategia borrador a partir de la
                    versión guardada y entra al ranking.
                  </small>
                </fieldset>
              </div>
            )}

            {tab === 'risk' && draft && rules && (
              <div className="strategy-lab__tab-body strategy-lab__risk">
                <label>
                  Stop (× ATR 14)
                  <input
                    defaultValue={formatDecimal(
                      resolveValue(rules.risk.stop_atr, draft.params),
                    )}
                    key={`stop-${draftKey}`}
                    onBlur={(event) => setRisk('stop_atr', event.target.value)}
                  />
                </label>
                <label>
                  Objetivo (× distancia del stop)
                  <input
                    defaultValue={formatDecimal(
                      resolveValue(rules.risk.target_stop_ratio, draft.params),
                    )}
                    key={`target-${draftKey}`}
                    onBlur={(event) =>
                      setRisk('target_stop_ratio', event.target.value)
                    }
                  />
                </label>
                <label>
                  Cierre por tiempo (minutos, 1-1440)
                  <input
                    defaultValue={String(rules.horizon_minutes)}
                    key={`horizon-${draftKey}`}
                    onBlur={(event) => {
                      const minutes = Number(event.target.value)
                      if (
                        !Number.isSafeInteger(minutes) ||
                        minutes < 1 ||
                        minutes > 1440
                      )
                        return
                      const next = cloneSpec(draft)
                      rulesOf(next, scope)!.horizon_minutes = minutes
                      update(next)
                    }}
                  />
                </label>
              </div>
            )}

            {tab === 'json' && draft && (
              <div className="strategy-lab__tab-body">
                <textarea
                  aria-label="JSON de la estrategia"
                  className="strategy-lab__json"
                  value={jsonText ?? JSON.stringify(draft, null, 2)}
                  onChange={(event) => setJsonText(event.target.value)}
                  rows={16}
                  spellCheck={false}
                />
                <div className="strategy-lab__row-actions">
                  <button
                    type="button"
                    className="strategy-lab__button"
                    disabled={jsonText === null}
                    onClick={applyJson}
                  >
                    Aplicar JSON
                  </button>
                  <button
                    type="button"
                    className="strategy-lab__button strategy-lab__button--ghost"
                    onClick={() => downloadJson(draft)}
                  >
                    Exportar JSON
                  </button>
                </div>
              </div>
            )}

            {tab === 'versions' && detail && (
              <div className="strategy-lab__tab-body">
                <ul className="strategy-lab__versions">
                  {detail.versions.map((entry) => (
                    <li key={entry.version}>
                      <b>v{entry.version}</b> · {STATE_LABELS[entry.state]}
                      {entry.parent
                        ? ` · de ${entry.parent.id} v${entry.parent.version}`
                        : ''}
                    </li>
                  ))}
                </ul>
                <div className="strategy-lab__row-actions">
                  {detail.state === 'draft' && (
                    <button
                      type="button"
                      className="strategy-lab__button"
                      disabled={busy}
                      onClick={() => changeState('shadow')}
                    >
                      Pasar a sombra
                    </button>
                  )}
                  {detail.state === 'shadow' && (
                    <button
                      type="button"
                      className="strategy-lab__button strategy-lab__button--primary"
                      disabled={busy}
                      onClick={() => changeState('active')}
                    >
                      Activar
                    </button>
                  )}
                  {detail.state !== 'retired' && (
                    <button
                      type="button"
                      className="strategy-lab__button strategy-lab__button--ghost"
                      disabled={busy}
                      onClick={() => changeState('retired')}
                    >
                      Retirar
                    </button>
                  )}
                </div>
                <small className="strategy-lab__context">
                  Activar pide pasar por sombra, 30 trades fuera de muestra,
                  neto medio positivo y Sharpe deflactado ≥ 0,95.
                </small>
              </div>
            )}

            {dirty && (
              <button
                type="button"
                className="strategy-lab__button"
                disabled={busy}
                onClick={testDraft}
              >
                Probar cambios
              </button>
            )}
            <fieldset className="strategy-lab__save">
              <legend className="strategy-lab__eyebrow">Al guardar</legend>
              <label className="strategy-lab__check">
                <input
                  type="radio"
                  name="strategy-lab-save"
                  checked={saveMode === 'modify'}
                  onChange={() => setSaveMode('modify')}
                />
                Modificar {detail ? shortName(detail.name, detail.id) : ''}
              </label>
              <label className="strategy-lab__check">
                <input
                  type="radio"
                  name="strategy-lab-save"
                  checked={saveMode === 'new'}
                  onChange={() => {
                    setSaveMode('new')
                    if (!newName && draft) setNewName(`${draft.name} (copia)`)
                  }}
                />
                Crear estrategia nueva
              </label>
              {saveMode === 'new' && (
                <input
                  aria-label="Nombre de la estrategia nueva"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
              )}
            </fieldset>
            <button
              type="button"
              className="strategy-lab__button strategy-lab__button--primary strategy-lab__save-button"
              disabled={!canSave}
              onClick={save}
            >
              Guardar
            </button>
            <small className="strategy-lab__context">
              Se guarda como borrador; el motor sólo usa versiones activas.
            </small>
          </aside>
        )}
      </div>
      {trades.length > 0 && (
        <details className="strategy-lab__panel strategy-lab__trades">
          <summary>Trades ({trades.length})</summary>
          <div className="strategy-lab__table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entrada UTC</th>
                  <th>Lado</th>
                  <th className="is-num">Precio</th>
                  <th className="is-num">Salida</th>
                  <th>Motivo</th>
                  <th className="is-num">Neto</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade, index) => (
                  <tr key={index}>
                    <td className="strategy-lab__num">
                      {utcTime(trade.entry_time_ms / 1000)}
                    </td>
                    <td className={trade.side === 'LONG' ? 'is-up' : 'is-down'}>
                      {trade.side === 'LONG' ? 'Largo' : 'Corto'}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {price(Number(trade.entry_price))}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {price(Number(trade.exit_price))}
                    </td>
                    <td>
                      {EXIT_LABELS[trade.exit_reason] ?? trade.exit_reason}
                    </td>
                    <td
                      className={`strategy-lab__num is-num ${trade.pnl_usd > 0 ? 'is-up' : 'is-down'}`}
                    >
                      {signedUsd(trade.pnl_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
