import { useEffect, useMemo, useState } from 'react'
import ApprovedTerminalChart, {
  type ApprovedTerminalMarker,
} from '../../trading-view/presentation/ApprovedTerminalChart.tsx'
import {
  buyAndHold,
  lastCandleStates,
  runBacktest,
  type LabResult,
} from '../domain/backtest.ts'
import {
  COMPARATOR_LABELS,
  COMPARATORS,
  FEATURE_LABELS,
  FEATURES,
  cloneSpec,
  formatDecimal,
  isCondition,
  operandLabel,
  parseDecimalInput,
  shortName,
  sideConditions,
  strategyNumber,
  validateSpec,
  type Comparator,
  type Condition,
  type Regime,
  type Side,
  type StrategySpec,
} from '../domain/strategy-spec.ts'
import { expandVariants, parseParamValues } from '../domain/variants.ts'
import {
  BASE_STRATEGIES,
  newStrategyTemplate,
} from '../infrastructure/base-strategies.ts'
import {
  loadLabCandles,
  type LabCandles,
} from '../infrastructure/lab-candles.ts'
import {
  appendVersion,
  latestById,
  readVersions,
  type StoredVersion,
} from '../infrastructure/local-strategy-store.ts'
import { percent, price, signedPercent, signedUsd, utcTime } from './format.ts'
import './StrategyLab.css'

type Props = {
  loadCandles?: () => Promise<LabCandles>
  now?: () => number
}

type Tab = 'rules' | 'risk' | 'json' | 'versions'
type SaveMode = 'modify' | 'new'
type State = 'active' | 'draft' | 'preview' | 'reference'

type Row = {
  key: string
  label: string
  state: State
  spec: StrategySpec | null
  result: LabResult
}

const BASE_IDS = new Set(BASE_STRATEGIES.map((spec) => spec.id))
/** Below this many trades the hit rate is shown as not yet reliable. */
const MIN_RELIABLE_TRADES = 30
const STATE_LABELS: Record<State, string> = {
  active: 'Activa en paper',
  draft: 'Sólo en el Laboratorio',
  preview: 'Prueba sin guardar',
  reference: 'Referencia',
}
const SOURCE_LABELS: Record<LabCandles['source'], string> = {
  live: 'Velas reales de Terminal · Kraken Futures',
  mock: 'Velas del fixture MOCK de Terminal',
  synthetic: 'Velas sintéticas · Terminal no respondió',
}

function specKey(spec: StrategySpec) {
  return `${spec.id}@${spec.version}`
}

function paramInputs(spec: StrategySpec): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec.params).map(([key, value]) => [
      key,
      formatDecimal(value),
    ]),
  )
}

function slug(value: string) {
  const text = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return text || 'estrategia'
}

function nextStrategyNumber(specs: Iterable<StrategySpec>) {
  let highest = 28
  for (const spec of specs)
    highest = Math.max(highest, strategyNumber(spec.id) ?? 0)
  return highest + 1
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
  now = Date.now,
}: Props) {
  const [market, setMarket] = useState<LabCandles | null>(null)
  const [versions, setVersions] = useState<StoredVersion[]>(() =>
    readVersions(),
  )
  const catalog = useMemo(() => {
    const specs = new Map<string, StrategySpec>()
    for (const spec of BASE_STRATEGIES) specs.set(spec.id, spec)
    for (const [id, spec] of latestById(versions)) specs.set(id, spec)
    return specs
  }, [versions])

  const [editingId, setEditingId] = useState(BASE_STRATEGIES[0]!.id)
  const original = catalog.get(editingId) ?? BASE_STRATEGIES[0]!
  const [draft, setDraft] = useState<StrategySpec>(() => cloneSpec(original))
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    paramInputs(original),
  )
  const [selectedKey, setSelectedKey] = useState(specKey(original))
  const [tab, setTab] = useState<Tab>('rules')
  const [side, setSide] = useState<Side>('LONG')
  const [saveMode, setSaveMode] = useState<SaveMode>('modify')
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadCandles().then((loaded) => {
      if (active) setMarket(loaded)
    })
    return () => {
      active = false
    }
  }, [loadCandles])

  const startEditing = (spec: StrategySpec) => {
    setEditingId(spec.id)
    setDraft(cloneSpec(spec))
    setInputs(paramInputs(spec))
    setSelectedKey(specKey(spec))
    setSide(spec.entry.LONG || !spec.entry.SHORT ? 'LONG' : 'SHORT')
    setSaveMode('modify')
  }

  // Parameters typed as "35; 40; 45" sweep one parameter into variants.
  const parsedInputs = useMemo(
    () =>
      Object.entries(inputs).map(([param, text]) => ({
        param,
        values: parseParamValues(text),
      })),
    [inputs],
  )
  const invalidParam = parsedInputs.some((entry) => entry.values === null)
  const sweep = parsedInputs.find((entry) => (entry.values?.length ?? 0) > 1)
  const effective = useMemo(() => {
    const next = cloneSpec(draft)
    for (const { param, values } of parsedInputs)
      if (values?.length === 1) next.params[param] = values[0]!
    return next
  }, [draft, parsedInputs])
  const dirty = JSON.stringify(effective) !== JSON.stringify(original)
  const candles = useMemo(() => market?.candles ?? [], [market])

  const rows: Row[] = useMemo(() => {
    if (candles.length === 0) return []
    const list: Row[] = []
    const run = (spec: StrategySpec) =>
      runBacktest(spec, candles, { resolve: (id) => catalog.get(id) })
    for (const spec of catalog.values()) {
      const base = BASE_IDS.has(spec.id) && spec.version === 1
      list.push({
        key: specKey(spec),
        label: `${shortName(spec)}${spec.version > 1 ? ` v${spec.version}` : ''}`,
        state: base ? 'active' : 'draft',
        spec,
        result: run(spec),
      })
    }
    if (!invalidParam && sweep?.values)
      for (const variant of expandVariants(
        effective,
        sweep.param,
        sweep.values,
      ))
        list.push({
          key: `preview:${variant.label}`,
          label: `${shortName(effective)} · ${variant.label}`,
          state: 'preview',
          spec: variant.spec,
          result: run(variant.spec),
        })
    else if (!invalidParam && dirty)
      list.push({
        key: 'preview:draft',
        label: `${shortName(effective)} · cambios sin guardar`,
        state: 'preview',
        spec: effective,
        result: run(effective),
      })
    list.push({
      key: 'reference:buy-and-hold',
      label: 'Comprar y mantener',
      state: 'reference',
      spec: null,
      result: buyAndHold(candles),
    })
    return list.sort((a, b) => b.result.returnPct - a.result.returnPct)
  }, [candles, catalog, effective, dirty, invalidParam, sweep])

  const selected =
    rows.find((row) => row.key === selectedKey) ??
    rows.find((row) => row.key === specKey(original)) ??
    rows[0]
  const reference = rows.find((row) => row.state === 'reference')
  const bestReturn = Math.max(
    0.1,
    ...rows.map((row) => Math.abs(row.result.returnPct)),
  )

  const markers: ApprovedTerminalMarker[] = (
    selected?.result.trades ?? []
  ).flatMap((trade, index) => [
    {
      id: `entry-${index}`,
      time: trade.entryTime,
      type: 'entry' as const,
      direction: trade.side === 'LONG' ? ('long' as const) : ('short' as const),
      label: trade.side === 'LONG' ? 'L' : 'S',
    },
    {
      id: `exit-${index}`,
      time: trade.exitTime,
      type: 'exit' as const,
      label: signedPercent(trade.netReturn * 100, 2),
    },
  ])

  const conditions = sideConditions(draft.entry[side])
  const nested =
    draft.entry[side] !== null &&
    !isCondition(draft.entry[side]!) &&
    conditions.length !==
      ('all' in draft.entry[side]! ? draft.entry[side].all.length : 0)
  const states = lastCandleStates(conditions, candles, effective.params)

  const updateConditions = (next: Condition[]) =>
    setDraft((current) => {
      const spec = cloneSpec(current)
      spec.entry[side] = next.length === 0 ? null : { all: next }
      return spec
    })
  const updateCondition = (index: number, patch: Partial<Condition>) =>
    updateConditions(
      conditions.map((condition, position) =>
        position === index ? { ...condition, ...patch } : condition,
      ),
    )

  const operandOptions = [
    ...FEATURES.map((feature) => ({
      value: feature,
      label: FEATURE_LABELS[feature]!,
    })),
    ...Object.keys(effective.params).map((param) => ({
      value: `$${param}`,
      label: `$${param}`,
    })),
  ]

  const editingVersions = versions.filter(
    (entry) => entry.spec.id === editingId,
  )
  const variantSelected = selected?.key.startsWith('preview:') ?? false
  const saveTarget =
    sweep && variantSelected && selected?.spec
      ? selected.spec
      : sweep
        ? null
        : effective
  const canSave =
    !invalidParam &&
    saveTarget !== null &&
    (saveMode === 'new' ||
      JSON.stringify(saveTarget) !== JSON.stringify(original))

  const save = () => {
    if (!saveTarget) return
    const spec = cloneSpec(saveTarget)
    if (saveMode === 'new') {
      const number = nextStrategyNumber(catalog.values())
      spec.id = `c${number}-${slug(spec.name)}`
      spec.version = 1
      delete spec.delegate
    } else {
      const known = versions
        .filter((entry) => entry.spec.id === spec.id)
        .map((entry) => entry.spec.version)
      spec.version = Math.max(original.version, ...known) + 1
    }
    const next = appendVersion(spec, now())
    setVersions(next)
    startEditing(spec)
    setNotice(
      saveMode === 'new'
        ? `Guardada como ${shortName(spec)}. ${shortName(original)} quedó como estaba.`
        : `Guardada ${shortName(spec)} v${spec.version}.`,
    )
  }

  const createStrategy = () => {
    const number = nextStrategyNumber(catalog.values())
    const spec = newStrategyTemplate(`c${number}-banda-rsi`)
    setVersions(appendVersion(spec, now()))
    startEditing(spec)
    setNotice(`Creada ${shortName(spec)} como borrador.`)
  }

  const importSpec = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      setImportErrors(['No es un JSON válido.'])
      return
    }
    const { spec, errors } = validateSpec(parsed)
    if (!spec) {
      setImportErrors(errors)
      return
    }
    const imported = cloneSpec(spec)
    if (catalog.has(imported.id)) {
      const number = nextStrategyNumber(catalog.values())
      imported.id = imported.id.replace(/^c\d+-/, `c${number}-`)
    }
    imported.version = 1
    setVersions(appendVersion(imported, now()))
    startEditing(imported)
    setImporting(false)
    setImportText('')
    setImportErrors([])
    setNotice(`Importada ${shortName(imported)} como borrador.`)
  }

  const setRegime = (regime: Regime, on: boolean) =>
    setDraft((current) => {
      const spec = cloneSpec(current)
      spec.regime = on
        ? [...new Set([...spec.regime, regime])]
        : spec.regime.filter((value) => value !== regime)
      return spec
    })

  const setRisk = (key: 'stop_atr' | 'target_atr', text: string) => {
    const value = parseDecimalInput(text)
    if (value === null) return
    setDraft((current) => ({
      ...cloneSpec(current),
      risk: { ...current.risk, [key]: value },
    }))
  }

  const result = selected?.result

  return (
    <div className="strategy-lab">
      <div className="strategy-lab__toolbar">
        <h1>Laboratorio</h1>
        <p className="strategy-lab__context">
          {market
            ? `${SOURCE_LABELS[market.source]} · PF_XBTUSD 1 m · ${candles.length} velas${
                candles.length > 0
                  ? ` · ${utcTime(candles[0]!.time)} → ${utcTime(candles.at(-1)!.time)} UTC`
                  : ''
              }`
            : 'Cargando las velas de Terminal…'}
        </p>
        <div className="strategy-lab__toolbar-actions">
          <div
            className="strategy-lab__seg"
            role="group"
            aria-label="Período de la prueba"
          >
            <button type="button" aria-pressed="true">
              Ventana de Terminal
            </button>
            {['7 d', '30 d', '90 d'].map((label) => (
              <button
                type="button"
                aria-pressed="false"
                disabled
                key={label}
                title="Falta el historial de velas de futuros (ver lista de faltantes)"
              >
                {label}
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
            onClick={createStrategy}
          >
            Nueva estrategia
          </button>
        </div>
      </div>

      {notice && (
        <p role="status" className="strategy-lab__notice">
          {notice}
        </p>
      )}

      {importing && (
        <section
          className="strategy-lab__import"
          aria-label="Importar estrategia"
        >
          <label htmlFor="strategy-lab-import">
            Pegá una estrategia en JSON (balancita-strategy.v1). Entra como
            borrador y nunca se ejecuta código.
          </label>
          <textarea
            id="strategy-lab-import"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            rows={6}
            spellCheck={false}
          />
          {importErrors.length > 0 && (
            <ul className="strategy-lab__errors" role="alert">
              {importErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <div className="strategy-lab__row-actions">
            <button
              type="button"
              className="strategy-lab__button strategy-lab__button--primary"
              onClick={importSpec}
            >
              Importar como borrador
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
            <p className="strategy-lab__empty">
              Esperando velas para probar las estrategias.
            </p>
          )}
          <ol className="strategy-lab__rank-list">
            {rows.map((row) => {
              const few = row.result.trades.length < MIN_RELIABLE_TRADES
              const current = row.key === selected?.key
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    className={`strategy-lab__rank strategy-lab__rank--${row.state}`}
                    aria-pressed={current}
                    disabled={row.state === 'reference'}
                    onClick={() => {
                      if (
                        row.spec &&
                        row.state !== 'preview' &&
                        row.spec.id !== editingId
                      )
                        startEditing(row.spec)
                      setSelectedKey(row.key)
                    }}
                  >
                    <span
                      className={`strategy-lab__dot strategy-lab__dot--${row.state}`}
                      title={STATE_LABELS[row.state]}
                    />
                    <span className="strategy-lab__rank-name">{row.label}</span>
                    <span
                      className={`strategy-lab__num strategy-lab__rank-return ${row.result.returnPct >= 0 ? 'is-up' : 'is-down'}`}
                    >
                      {signedPercent(row.result.returnPct, 2)}
                    </span>
                    <span className="strategy-lab__bar" aria-hidden="true">
                      <span
                        className={
                          row.result.returnPct >= 0 ? 'is-up' : 'is-down'
                        }
                        style={{
                          width: `${Math.round((Math.abs(row.result.returnPct) / bestReturn) * 100)}%`,
                        }}
                      />
                    </span>
                    <span
                      className={`strategy-lab__num strategy-lab__rank-hit${few ? ' is-few' : ''}`}
                    >
                      {row.state === 'reference'
                        ? 'referencia'
                        : row.result.hitRatePct === null
                          ? 'sin trades'
                          : `${percent(row.result.hitRatePct)} · ${row.result.trades.length}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="strategy-lab__legend">
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--active" />
              activa en paper
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--draft" />
              sólo Laboratorio
            </span>
            <span>
              <span className="strategy-lab__dot strategy-lab__dot--preview" />
              sin guardar
            </span>
            <span>gris = menos de {MIN_RELIABLE_TRADES} trades</span>
          </div>
          <a className="strategy-lab__legacy" href="/historicos">
            Pruebas históricas spot (BTC-EUR)
          </a>
        </section>

        <section
          className="strategy-lab__panel strategy-lab__focus"
          aria-label="Resultado de la estrategia elegida"
        >
          <div className="strategy-lab__panel-head">
            <h2>{selected?.label ?? '—'}</h2>
            {selected && (
              <span
                className={`strategy-lab__chip strategy-lab__chip--${selected.state}`}
              >
                {STATE_LABELS[selected.state]}
              </span>
            )}
            <span className="strategy-lab__context">
              Estimación en el navegador · comisión 0,05 % por lado · 10.000 US$
            </span>
          </div>
          {result && (
            <div className="strategy-lab__kpis">
              <div className="strategy-lab__kpi strategy-lab__kpi--key">
                <span className="strategy-lab__eyebrow">Rentabilidad</span>
                <strong
                  className={`strategy-lab__num ${result.returnPct >= 0 ? 'is-up' : 'is-down'}`}
                >
                  {signedPercent(result.returnPct, 2)}
                </strong>
                <span className="strategy-lab__num">
                  {signedUsd(result.netUsd)}
                </span>
              </div>
              <div className="strategy-lab__kpi strategy-lab__kpi--key">
                <span className="strategy-lab__eyebrow">Acierto</span>
                <strong className="strategy-lab__num">
                  {result.hitRatePct === null
                    ? '—'
                    : percent(result.hitRatePct)}
                </strong>
                <span className="strategy-lab__num">
                  {result.wins} de {result.trades.length} trades
                </span>
              </div>
              <div className="strategy-lab__kpi">
                <span className="strategy-lab__eyebrow">
                  Vs comprar y mantener
                </span>
                <strong className="strategy-lab__num">
                  {reference
                    ? `${signedPercent(result.returnPct - reference.result.returnPct, 2).replace(' %', ' pts')}`
                    : '—'}
                </strong>
                <span className="strategy-lab__num">
                  {reference
                    ? signedPercent(reference.result.returnPct, 2)
                    : ''}
                </span>
              </div>
              <div className="strategy-lab__kpi">
                <span className="strategy-lab__eyebrow">Caída máxima</span>
                <strong className="strategy-lab__num is-down">
                  {signedPercent(-result.maxDrawdownPct, 2)}
                </strong>
              </div>
              <div className="strategy-lab__kpi">
                <span className="strategy-lab__eyebrow">
                  Ganadores · perdedores
                </span>
                <span className="strategy-lab__split" aria-hidden="true">
                  <span
                    className="is-up"
                    style={{ flex: Math.max(result.wins, 0.0001) }}
                  />
                  <span
                    className="is-down"
                    style={{ flex: Math.max(result.losses, 0.0001) }}
                  />
                </span>
                <span className="strategy-lab__num">
                  {result.avgWinUsd === null
                    ? '—'
                    : signedUsd(result.avgWinUsd)}{' '}
                  ·{' '}
                  {result.avgLossUsd === null
                    ? '—'
                    : signedUsd(result.avgLossUsd)}
                </span>
              </div>
            </div>
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
          </div>
        </section>

        <aside
          className="strategy-lab__panel strategy-lab__editor"
          aria-label={`Editar ${shortName(draft)}`}
        >
          <div className="strategy-lab__panel-head">
            <h2>
              {shortName(draft)}
              {original.version > 1 ? ` v${original.version}` : ''}
            </h2>
          </div>
          {draft.description && (
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

          {tab === 'rules' && (
            <div className="strategy-lab__tab-body">
              {draft.delegate ? (
                <div className="strategy-lab__delegate">
                  {(['trend', 'range'] as const).map((regime) => (
                    <label key={regime}>
                      {regime === 'trend' ? 'En tendencia usa' : 'En rango usa'}
                      <select
                        value={draft.delegate?.[regime] ?? ''}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...cloneSpec(current),
                            delegate: {
                              ...current.delegate,
                              [regime]: event.target.value,
                            },
                          }))
                        }
                      >
                        {[...catalog.values()]
                          .filter((spec) => !spec.delegate)
                          .map((spec) => (
                            <option key={spec.id} value={spec.id}>
                              {shortName(spec)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                </div>
              ) : (
                <>
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
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <span className="strategy-lab__context">
                      Entra si se cumplen todas
                    </span>
                  </div>
                  {nested && (
                    <p className="strategy-lab__context">
                      Esta estrategia tiene grupos anidados: editalos en la
                      pestaña JSON.
                    </p>
                  )}
                  <ul className="strategy-lab__rules">
                    {conditions.map((condition, index) => {
                      const constant =
                        parseDecimalInput(condition.right) !== null
                      const state = states[index]
                      return (
                        <li key={index} className="strategy-lab__rule">
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
                          <select
                            aria-label={`Condición ${index + 1}: indicador`}
                            value={condition.left}
                            onChange={(event) =>
                              updateCondition(index, {
                                left: event.target.value,
                              })
                            }
                          >
                            {operandOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`Condición ${index + 1}: comparador`}
                            className="strategy-lab__op"
                            value={condition.op}
                            onChange={(event) =>
                              updateCondition(index, {
                                op: event.target.value as Comparator,
                              })
                            }
                          >
                            {COMPARATORS.map((op) => (
                              <option key={op} value={op}>
                                {COMPARATOR_LABELS[op]}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`Condición ${index + 1}: contra`}
                            value={constant ? '__number' : condition.right}
                            onChange={(event) =>
                              updateCondition(index, {
                                right:
                                  event.target.value === '__number'
                                    ? '50'
                                    : event.target.value,
                              })
                            }
                          >
                            {operandOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            <option value="__number">Número</option>
                          </select>
                          <button
                            type="button"
                            className="strategy-lab__icon"
                            aria-label={`Quitar condición ${index + 1}`}
                            onClick={() =>
                              updateConditions(
                                conditions.filter(
                                  (_, position) => position !== index,
                                ),
                              )
                            }
                          >
                            ×
                          </button>
                          {constant && (
                            <input
                              aria-label={`Condición ${index + 1}: número`}
                              className="strategy-lab__num-input"
                              defaultValue={formatDecimal(condition.right)}
                              onBlur={(event) => {
                                const value = parseDecimalInput(
                                  event.target.value,
                                )
                                if (value !== null)
                                  updateCondition(index, { right: value })
                              }}
                            />
                          )}
                          {condition.scale && (
                            <span className="strategy-lab__context strategy-lab__scale">
                              × {operandLabel(condition.scale, effective)}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                  <button
                    type="button"
                    className="strategy-lab__link"
                    onClick={() =>
                      updateConditions([
                        ...conditions,
                        { left: '1m.rsi14', op: '>', right: '50' },
                      ])
                    }
                  >
                    + Agregar condición
                  </button>
                </>
              )}

              {Object.keys(inputs).length > 0 && (
                <fieldset className="strategy-lab__params">
                  <legend className="strategy-lab__eyebrow">Parámetros</legend>
                  {Object.entries(inputs).map(([param, text]) => {
                    const values = parseParamValues(text)
                    return (
                      <label
                        key={param}
                        className={
                          values && values.length > 1 ? 'is-sweep' : ''
                        }
                      >
                        <span className="strategy-lab__num">${param}</span>
                        <input
                          value={text}
                          aria-invalid={values === null}
                          onChange={(event) => {
                            const next = event.target.value
                            setInputs((current) => {
                              const updated = { ...current, [param]: next }
                              // Only one parameter can be swept at a time.
                              if ((parseParamValues(next)?.length ?? 0) > 1)
                                for (const other of Object.keys(updated))
                                  if (
                                    other !== param &&
                                    (parseParamValues(updated[other]!)
                                      ?.length ?? 0) > 1
                                  )
                                    updated[other] = formatDecimal(
                                      original.params[other] ?? '0',
                                    )
                              return updated
                            })
                          }}
                        />
                        <small>
                          {values === null
                            ? 'Números separados por punto y coma'
                            : values.length > 1
                              ? `${values.length} variantes en el ranking`
                              : original.params[param] !== values[0]
                                ? `antes ${formatDecimal(original.params[param] ?? '—')}`
                                : 'probá varios: 35; 40; 45'}
                        </small>
                      </label>
                    )
                  })}
                </fieldset>
              )}
            </div>
          )}

          {tab === 'risk' && (
            <div className="strategy-lab__tab-body strategy-lab__risk">
              <label>
                Stop (× ATR 14)
                <input
                  defaultValue={formatDecimal(draft.risk.stop_atr)}
                  key={`stop-${draft.id}-${draft.version}`}
                  onBlur={(event) => setRisk('stop_atr', event.target.value)}
                />
              </label>
              <label>
                Objetivo (× ATR 14)
                <input
                  defaultValue={formatDecimal(draft.risk.target_atr)}
                  key={`target-${draft.id}-${draft.version}`}
                  onBlur={(event) => setRisk('target_atr', event.target.value)}
                />
              </label>
              <label>
                Cierre por tiempo (minutos, 0 = sin límite)
                <input
                  defaultValue={String(draft.horizon_minutes)}
                  key={`horizon-${draft.id}-${draft.version}`}
                  onBlur={(event) => {
                    const minutes = Number(event.target.value)
                    if (Number.isSafeInteger(minutes) && minutes >= 0)
                      setDraft((current) => ({
                        ...cloneSpec(current),
                        horizon_minutes: minutes,
                      }))
                  }}
                />
              </label>
              <fieldset>
                <legend>Opera sólo en</legend>
                {(['trend', 'range'] as const).map((regime) => (
                  <label key={regime} className="strategy-lab__check">
                    <input
                      type="checkbox"
                      checked={draft.regime.includes(regime)}
                      onChange={(event) =>
                        setRegime(regime, event.target.checked)
                      }
                    />
                    {regime === 'trend' ? 'Tendencia' : 'Rango'}
                  </label>
                ))}
                <small>Sin marcar = cualquier régimen.</small>
              </fieldset>
            </div>
          )}

          {tab === 'json' && (
            <div className="strategy-lab__tab-body">
              <pre className="strategy-lab__json">
                {JSON.stringify(effective, null, 2)}
              </pre>
              <button
                type="button"
                className="strategy-lab__button"
                onClick={() => downloadJson(effective)}
              >
                Exportar JSON
              </button>
            </div>
          )}

          {tab === 'versions' && (
            <div className="strategy-lab__tab-body">
              <ul className="strategy-lab__versions">
                {BASE_IDS.has(editingId) && (
                  <li>
                    <b>v1</b> · la que corre en paper
                  </li>
                )}
                {editingVersions.map((entry) => (
                  <li key={`${entry.spec.version}-${entry.savedAt}`}>
                    <b>v{entry.spec.version}</b> · guardada{' '}
                    {new Date(entry.savedAt).toLocaleString('es-ES')}
                  </li>
                ))}
              </ul>
              <small className="strategy-lab__context">
                Las versiones se guardan en este navegador hasta que exista el
                registro de estrategias.
              </small>
            </div>
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
              Modificar {shortName(original)}
            </label>
            <label className="strategy-lab__check">
              <input
                type="radio"
                name="strategy-lab-save"
                checked={saveMode === 'new'}
                onChange={() => setSaveMode('new')}
              />
              Crear estrategia nueva
            </label>
          </fieldset>
          {sweep && !variantSelected && (
            <p className="strategy-lab__context">
              Elegí una variante del ranking para guardarla.
            </p>
          )}
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--primary strategy-lab__save-button"
            disabled={!canSave}
            onClick={save}
          >
            Guardar
          </button>
          {BASE_IDS.has(original.id) && saveMode === 'modify' && (
            <small className="strategy-lab__context">
              El motor en paper sigue usando la v1 hasta que exista la promoción
              de versiones.
            </small>
          )}
        </aside>
      </div>
      {selected && selected.result.trades.length > 0 && (
        <details className="strategy-lab__panel strategy-lab__trades">
          <summary>
            Trades de {selected.label} ({selected.result.trades.length})
          </summary>
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
                {selected.result.trades.map((trade, index) => (
                  <tr key={index}>
                    <td className="strategy-lab__num">
                      {utcTime(trade.entryTime)}
                    </td>
                    <td className={trade.side === 'LONG' ? 'is-up' : 'is-down'}>
                      {trade.side === 'LONG' ? 'Largo' : 'Corto'}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {price(trade.entryPrice)}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {price(trade.exitPrice)}
                    </td>
                    <td>
                      {
                        {
                          stop: 'stop',
                          target: 'objetivo',
                          rule: 'regla de salida',
                          horizon: 'tiempo',
                          end: 'fin de la ventana',
                        }[trade.exitReason]
                      }
                    </td>
                    <td
                      className={`strategy-lab__num is-num ${trade.netUsd > 0 ? 'is-up' : 'is-down'}`}
                    >
                      {signedUsd(trade.netUsd)}
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
