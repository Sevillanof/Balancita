import { useEffect, useState, type ReactNode } from 'react'
import { amount, utcDateTime } from '../../../shared/finance/format.ts'
import { DataState } from '../../../shared/mission-control/index.ts'
import {
  fetchActivity,
  type ActivityReport,
  type ExperimentActivity,
} from '../../observability/infrastructure/observability-api.ts'
import {
  agoText,
  experimentIdOf,
  rangeName,
  spanDays,
  utcDay,
  verdictStatement,
} from '../domain/strategy-detail.ts'
import {
  conditionSentence,
  formatDecimal,
  resolveValue,
  rulesOf,
  rulesScopes,
  sideConditions,
  type Rules,
  type Side,
} from '../domain/strategy-spec.ts'
import {
  count,
  horizonText,
  netBpPerOp,
  netUsd,
} from '../domain/strategy-format.ts'
import type {
  Inventory,
  InventoryStrategy,
  StrategyApi,
  StrategyDetail,
  StrategyPlan,
} from '../infrastructure/strategy-api.ts'
import {
  FrozenBadge,
  OperationalBadge,
  ResearchBadge,
} from './StrategyStatusBadges.tsx'
import './StrategyDetailView.css'

const NA = 'No disponible'

/** Reads the B2 activity report; injectable so tests never hit the network. */
export type LoadActivity = (signal: AbortSignal) => Promise<ActivityReport>

const defaultLoadActivity: LoadActivity = (signal) =>
  fetchActivity('24h', null, signal)

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ok'; value: T }
  | { state: 'error'; message: string }

function useLoaded<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  key: unknown,
): Loaded<T> {
  const [status, setStatus] = useState<{ key: unknown; loaded: Loaded<T> }>({
    key,
    loaded: { state: 'loading' },
  })
  useEffect(() => {
    if (!load) return
    const controller = new AbortController()
    load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted)
          setStatus({ key, loaded: { state: 'ok', value } })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setStatus({
            key,
            loaded: {
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          })
      },
    )
    return () => controller.abort()
    // `load` is a fresh closure per render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (!load)
    return { state: 'error', message: 'Este origen de datos no lo ofrece.' }
  return status.key === key ? status.loaded : { state: 'loading' }
}

function Module({
  index,
  title,
  aside,
  children,
  testId,
}: {
  index: string
  title: string
  aside?: ReactNode
  children: ReactNode
  testId: string
}) {
  return (
    <section className="detail__module" data-testid={testId}>
      <header>
        <h3>
          <span>MÓDULO {index} //</span> {title}
        </h3>
        {aside && <div className="detail__aside">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

function Sub({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="detail__sub">
      <h4>{title}</h4>
      {children}
    </div>
  )
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="detail__unavailable">{children}</p>
}

function Kpi({
  label,
  value,
  note,
  tone,
  missing,
}: {
  label: string
  value: string | null
  note?: ReactNode
  tone?: 'up' | 'down'
  missing?: string
}) {
  return (
    <div className="detail__kpi">
      <dt>{label}</dt>
      <dd
        className={
          value === null ? 'is-missing' : tone ? `is-${tone}` : undefined
        }
      >
        {value ?? NA}
      </dd>
      {(note || (value === null && missing)) && (
        <small>{value === null && missing ? missing : note}</small>
      )}
    </div>
  )
}

const tone = (value: number | null | undefined) =>
  value == null ? undefined : value >= 0 ? 'up' : 'down'

const SIDE_LABEL: Record<Side, string> = { LONG: 'Largo', SHORT: 'Corto' }

function SideRules({
  rules,
  params,
}: {
  rules: Rules
  params: StrategyDetail['spec']['params']
}) {
  return (
    <div className="detail__sides">
      {(['LONG', 'SHORT'] as const).map((side) => {
        const entry = rules.sides[side]
        if (!entry) return null
        const conditions = sideConditions(rules, side)
        return (
          <article key={side} data-testid={`side-${side}`}>
            <h5 className={side === 'LONG' ? 'is-up' : 'is-down'}>
              {SIDE_LABEL[side]}
            </h5>
            {conditions.length === 0 && <p>{NA}</p>}
            {conditions.map(({ node }, index) => (
              <p key={index}>{conditionSentence(node, params)}</p>
            ))}
            <small>
              motivo <code>{entry.reason}</code> · invalida por{' '}
              <code>{entry.invalidation}</code>
            </small>
          </article>
        )
      })}
    </div>
  )
}

function ConfigModule({
  row,
  detail,
}: {
  row: InventoryStrategy
  detail: StrategyDetail | null
}) {
  const spec = detail?.spec
  const scopes = spec ? rulesScopes(spec) : []
  const risk = spec?.rules?.risk
  const params = spec?.params ?? {}
  const indicators = Object.entries(spec?.indicators ?? {})
  const gates = spec?.rules?.gates ?? []
  return (
    <Module
      index="01"
      title="CONFIGURACIÓN Y NÚCLEO"
      testId="module-config"
      aside={
        <span className="detail__hash" title={row.spec_hash ?? undefined}>
          HASH: {row.spec_hash?.slice(0, 8) ?? NA}
        </span>
      }
    >
      <Sub title="Tesis / qué busca">
        <p className="detail__thesis">{spec?.description || row.description}</p>
      </Sub>

      <Sub title="Condiciones de entrada (del spec)">
        {!spec?.rules && !spec?.branches ? (
          <Unavailable>
            {NA}: el registro no devolvió el spec de esta estrategia.
          </Unavailable>
        ) : (
          scopes.map((scope) => {
            const rules = spec ? rulesOf(spec, scope) : undefined
            return rules ? (
              <div key={scope}>
                {scopes.length > 1 && (
                  <h5 className="detail__scope">
                    {scope === 'trend' ? 'En tendencia' : 'En rango'}
                  </h5>
                )}
                <SideRules rules={rules} params={params} />
              </div>
            ) : null
          })
        )}
        {gates.length > 0 && (
          <p className="detail__note">
            Requisito previo:{' '}
            {gates.map((gate) => (
              <code key={gate.reason}>{gate.reason}</code>
            ))}{' '}
            (régimen {gates.map((gate) => gate.require).join(', ')}).
          </p>
        )}
        <p className="detail__note">
          Valores actuales de cada condición: {NA}. B3 todavía no guarda la
          evaluación por estrategia.
        </p>
      </Sub>

      <Sub title="Parámetros cuantitativos">
        <table className="detail__table" data-testid="params-table">
          <thead>
            <tr>
              <th>Parámetro</th>
              <th className="is-num">Valor</th>
              <th>Origen</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(params).map(([key, value]) => (
              <tr key={key}>
                <td>
                  <code>{key}</code>
                </td>
                <td className="is-num">{formatDecimal(value)}</td>
                <td>params del spec</td>
              </tr>
            ))}
            {indicators.map(([kind, periods]) => (
              <tr key={kind}>
                <td>
                  <code>{kind}</code> · ventana en velas
                </td>
                <td className="is-num">{(periods ?? []).join(', ')}</td>
                <td>indicadores del spec</td>
              </tr>
            ))}
            {risk && (
              <>
                <tr>
                  <td>Stop</td>
                  <td className="is-num">
                    {formatDecimal(resolveValue(risk.stop_atr, params))}
                    {risk.vol ? ' × vol.' : ' × ATR'}
                  </td>
                  <td>
                    <code>{risk.vol ?? 'ATR 14 (1 m)'}</code>
                  </td>
                </tr>
                <tr>
                  <td>Objetivo</td>
                  <td className="is-num">
                    {formatDecimal(
                      resolveValue(risk.target_stop_ratio, params),
                    )}{' '}
                    × stop
                  </td>
                  <td>riesgo del spec</td>
                </tr>
              </>
            )}
            {spec?.rules && (
              <tr>
                <td>Salida por tiempo</td>
                <td className="is-num">
                  {horizonText(spec.rules.horizon_minutes) ?? NA}
                </td>
                <td>horizonte del spec</td>
              </tr>
            )}
            {Object.keys(params).length === 0 && !risk && (
              <tr>
                <td colSpan={3}>{NA}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Sub>
    </Module>
  )
}

function PipelineModule({ spec }: { spec: StrategyDetail['spec'] | null }) {
  const scopes = spec ? rulesScopes(spec) : []
  const codes = scopes.flatMap((scope) => {
    const rules = spec ? rulesOf(spec, scope) : undefined
    if (!rules) return []
    return [
      ...(rules.gates ?? []).map((gate) => ({
        code: gate.reason,
        kind: 'Bloqueo previo',
      })),
      ...(['LONG', 'SHORT'] as const).flatMap((side) =>
        rules.sides[side]
          ? [{ code: rules.sides[side].reason, kind: SIDE_LABEL[side] }]
          : [],
      ),
    ]
  })
  return (
    <Module
      index="03"
      title="PIPELINE DE SEÑALES"
      testId="module-pipeline"
      aside={<span className="detail__tag">REQUIERE B3</span>}
    >
      <Unavailable>
        <b>Tasa de paso y desglose de descartes: {NA.toLowerCase()}.</b> B2 solo
        cuenta veredictos del motor completo (<code>reason_code</code> no es
        atribución a una estrategia) y no separa «no hubo señal» de «no se
        evaluó». B3 debe guardar, por estrategia e intervalo, la evaluación y el
        descarte.
      </Unavailable>
      <Sub title="Códigos que emite el spec (no son conteos)">
        <table className="detail__table" data-testid="reason-codes">
          <thead>
            <tr>
              <th>Origen</th>
              <th>Código</th>
              <th className="is-num">Veces en el forward</th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 && (
              <tr>
                <td colSpan={3}>{NA}</td>
              </tr>
            )}
            {codes.map(({ code, kind }) => (
              <tr key={`${kind}-${code}`}>
                <td>{kind}</td>
                <td>
                  <code>{code}</code>
                </td>
                <td className="is-num is-missing">B3</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sub>
    </Module>
  )
}

function ProvenanceModule({
  row,
  inventory,
  detail,
}: {
  row: InventoryStrategy
  inventory: Inventory
  detail: StrategyDetail | null
}) {
  const t = inventory.thresholds
  const cost = inventory.cost_model
  return (
    <Module index="05" title="AUDITORÍA Y FUENTES" testId="module-audit">
      <div className="detail__triple">
        <Sub title="Registro del spec">
          <table className="detail__table" data-testid="audit-table">
            <tbody>
              <tr>
                <th scope="row">Identificador</th>
                <td>
                  <code>{row.id}</code> · v{row.version}
                </td>
              </tr>
              <tr>
                <th scope="row">Hash del spec</th>
                <td>
                  <code className="detail__wrap">{row.spec_hash ?? NA}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Origen en el registro</th>
                <td>{detail?.origin ?? NA}</td>
              </tr>
              <tr>
                <th scope="row">Modelo de costes</th>
                <td>
                  {cost ? (
                    <>
                      <code>{cost.version}</code> · hash{' '}
                      <code>{cost.hash.slice(0, 8)}</code>
                    </>
                  ) : (
                    NA
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Tamaño</th>
                <td>{inventory.notional_usd} USD fijos por operación</td>
              </tr>
              <tr>
                <th scope="row">Umbrales de calificación</th>
                <td>
                  {t.t_tentative != null && (
                    <>tentativa t &gt; {amount(t.t_tentative)}</>
                  )}
                  {t.t_reliable != null && (
                    <>
                      {' '}
                      · fiable t &gt; {amount(t.t_reliable)} con ≥{' '}
                      {count(t.reliable_trades)} ops
                    </>
                  )}
                  {t.t_tentative == null && t.t_reliable == null && NA}
                </td>
              </tr>
              <tr>
                <th scope="row">Estado operativo</th>
                <td>
                  {row.operational.basis === 'registry'
                    ? 'registro de estrategias'
                    : row.operational.basis === 'config'
                      ? 'solo registrada en un config (no prueba que corra)'
                      : 'sin fuente'}
                  {row.operational.reason && (
                    <>
                      {' '}
                      · motivo <code>{row.operational.reason}</code>
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Sub>
        <Sub title="Historial de estados del registro">
          <table className="detail__table" data-testid="state-events">
            <thead>
              <tr>
                <th>Versión</th>
                <th>Estado</th>
                <th>Motivo</th>
                <th>Cuándo (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {(detail?.events ?? []).length === 0 && (
                <tr>
                  <td colSpan={4}>{NA}</td>
                </tr>
              )}
              {(detail?.events ?? []).map((event, index) => (
                <tr key={index}>
                  <td>v{event.version}</td>
                  <td>
                    <code>{event.state}</code>
                  </td>
                  <td>
                    <code>{event.reason}</code>
                  </td>
                  <td>
                    {event.known_at > 0
                      ? utcDateTime(event.known_at)
                      : 'incluida con el código'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Sub>
        <Sub title="De dónde sale cada sección">
          <table className="detail__table" data-testid="sources-table">
            <thead>
              <tr>
                <th>Sección</th>
                <th>Fuente</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Configuración y parámetros</td>
                <td>
                  <code>GET /api-strategies/strategies/{row.id}</code> (spec del
                  registro)
                </td>
              </tr>
              <tr>
                <td>Backtest y rangos</td>
                <td>
                  <code>config/strategy-reliability.json</code> vía{' '}
                  <code>/api-strategies/inventory</code>
                </td>
              </tr>
              <tr>
                <td>Forward registrado</td>
                <td>
                  <code>config/forward-strategies.json</code> vía{' '}
                  <code>/api-strategies/inventory</code>
                </td>
              </tr>
              <tr>
                <td>Operaciones almacenadas</td>
                <td>
                  <code>GET /api-live/observability/activity</code> (B2)
                </td>
              </tr>
              <tr>
                <td>Resultado y posiciones del forward</td>
                <td>B5 (no existe)</td>
              </tr>
              <tr>
                <td>Descartes por intervalo</td>
                <td>B3 (no existe)</td>
              </tr>
            </tbody>
          </table>
        </Sub>
      </div>
    </Module>
  )
}

function PerformanceModule({
  row,
  inventory,
}: {
  row: InventoryStrategy
  inventory: Inventory
}) {
  const bt = row.research.backtest
  const ranges = Object.entries(bt?.ranges ?? {})
  const periodRanges = inventory.period?.ranges ?? {}
  const periodNames = Object.keys(periodRanges)
  const firstRange = Object.values(periodRanges)[0]
  const days = firstRange
    ? spanDays(firstRange.first_bucket_ms, firstRange.last_bucket_ms)
    : null
  const t = inventory.thresholds
  const trials = bt?.selection_trials ?? null
  const fwd = row.forward
  return (
    <Module
      index="02"
      title="RENDIMIENTO"
      testId="module-performance"
      aside={
        bt ? (
          <span>
            Backtest ·{' '}
            {periodNames.length > 0
              ? `${periodNames.length} rangos${days ? ` de ${days} d` : ''} · `
              : ''}
            {count(bt.trades)} operaciones · {inventory.notional_usd} USD c/u
          </span>
        ) : undefined
      }
    >
      <p className="detail__verdict" data-testid="verdict">
        {verdictStatement(row)}
      </p>

      <Sub title="Backtest · todo el período">
        {bt ? (
          <>
            <dl className="detail__kpis detail__kpis--3">
              <Kpi
                label="Neto medio por operación"
                value={netBpPerOp(bt.mean_net_bp)}
                tone={tone(bt.mean_net_bp)}
                note={
                  bt.median_net_bp == null
                    ? undefined
                    : `mediana ${netBpPerOp(bt.median_net_bp)}`
                }
              />
              <Kpi
                label="Neto acumulado"
                value={netUsd(bt.pnl_usd)}
                tone={tone(bt.pnl_usd)}
                note="neto de costes · sin desglose bruto/costes"
              />
              <Kpi
                label="Drawdown · Sharpe"
                value={null}
                missing="no calculados en esta fuente"
              />
            </dl>
            <dl className="detail__kpis detail__kpis--4">
              <Kpi
                label="Acierto"
                value={
                  bt.hit_rate == null
                    ? null
                    : `${amount(bt.hit_rate * 100, 1)} %`
                }
              />
              <Kpi
                label="Estadístico t"
                value={bt.t_stat == null ? null : amount(bt.t_stat)}
                note={
                  t.t_tentative == null
                    ? undefined
                    : `tentativa > ${amount(t.t_tentative)}`
                }
              />
              <Kpi
                label="Prob. deflactada"
                value={
                  bt.deflated_probability == null
                    ? null
                    : amount(bt.deflated_probability)
                }
                note={
                  trials == null
                    ? undefined
                    : `${count(trials)} ${trials === 1 ? 'configuración' : 'configuraciones'}`
                }
              />
              <Kpi
                label="Tramos positivos"
                value={
                  bt.folds_positive == null || bt.folds_judged == null
                    ? null
                    : `${bt.folds_positive} / ${bt.folds_judged}`
                }
                note="tramos de tiempo, purgados"
              />
            </dl>
          </>
        ) : (
          <Unavailable>
            {NA}:{' '}
            {row.no_backtest
              ? 'esta estrategia no tiene backtest por diseño; solo cuentan las operaciones posteriores al inicio.'
              : 'no hay medición comparable para este spec.'}
          </Unavailable>
        )}
      </Sub>

      <Sub title="Fuera de muestra · por rango">
        {ranges.length > 0 ? (
          <>
            <table className="detail__table" data-testid="range-table">
              <thead>
                <tr>
                  <th>Rango</th>
                  <th>Fechas (UTC)</th>
                  <th className="is-num">Ops</th>
                  <th className="is-num">Neto medio</th>
                  <th className="is-num">t</th>
                  <th className="is-num">Tramos +</th>
                </tr>
              </thead>
              <tbody>
                {ranges.map(([name, range]) => {
                  const span = periodRanges[name]
                  return (
                    <tr key={name}>
                      <td>{rangeName(name)}</td>
                      <td>
                        {span
                          ? `${utcDay(span.first_bucket_ms)} → ${utcDay(span.last_bucket_ms)}`
                          : NA}
                      </td>
                      <td className="is-num">{count(range.trades)}</td>
                      <td
                        className={`is-num is-${tone(range.mean_net_bp) ?? 'missing'}`}
                      >
                        {netBpPerOp(range.mean_net_bp) ?? NA}
                      </td>
                      <td className="is-num">
                        {range.t_stat == null ? NA : amount(range.t_stat)}
                      </td>
                      <td className="is-num">
                        {range.folds_positive ?? '—'}/
                        {range.folds_judged ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="detail__note" data-testid="oos-note">
              {trials != null && trials > 1
                ? `No hay un tramo fuera de muestra puro: los parámetros se buscaron entre ${count(trials)} configuraciones mirando estos rangos. Solo el forward puede validar.`
                : 'Rangos medidos por separado. La fuente no marca cuál sirvió para elegir parámetros; no se llama «fuera de muestra» a ninguno.'}
            </p>
          </>
        ) : (
          <Unavailable>
            {NA}: sin medición por rango para este spec.
          </Unavailable>
        )}
      </Sub>

      <Sub title="Forward paper · desde el primer ciclo">
        <dl className="detail__kpis detail__kpis--3">
          <Kpi
            label="Operaciones del forward"
            value={fwd.trades == null ? null : count(fwd.trades)}
            missing={`resultados del forward: ${fwd.missing}`}
          />
          <Kpi
            label="Resultado neto del forward"
            value={null}
            missing={`resultados del forward: ${fwd.missing}`}
          />
          <Kpi
            label="Registrada en el forward"
            value={
              fwd.registered && fwd.start_ms != null
                ? utcDateTime(fwd.start_ms)
                : null
            }
            missing={
              fwd.registered
                ? 'sin fecha de inicio'
                : 'no está en forward-strategies.json'
            }
            note={
              fwd.min_trades == null
                ? undefined
                : `se juzga con ${count(fwd.min_trades)} operaciones`
            }
          />
        </dl>
      </Sub>
    </Module>
  )
}

const SIDE_WORD: Record<string, string> = { LONG: 'largo', SHORT: 'corto' }
const EXIT_WORD: Record<string, string> = {
  target: 'Objetivo',
  stop: 'Stop',
  time_stop: 'Tiempo',
  strategy_exit: 'Regla de salida',
}

function productName(product: string) {
  return product.replace(/^PF_/, '').replace(/USD$/, 'USD')
}

function StoredOperations({
  experiment,
  report,
}: {
  experiment: ExperimentActivity | null
  report: ActivityReport
}) {
  if (report.operations.state !== 'ok')
    return (
      <Unavailable>
        {NA}: B2 informa «{report.operations.detail}».
      </Unavailable>
    )
  if (!experiment)
    return (
      <Unavailable>
        {NA}: B2 no tiene una fila de este experimento (el forward no lo reporta
        como esperado ni lo tiene en su estado).
      </Unavailable>
    )
  const last = experiment.lastTrade
  return (
    <>
      <dl className="detail__kpis detail__kpis--4" data-testid="stored-ops">
        <Kpi
          label="Última operación almacenada"
          value={
            last
              ? `${productName(last.product)}${last.side ? ` ${SIDE_WORD[last.side] ?? last.side}` : ''}`
              : null
          }
          missing="nunca operó según el registro"
        />
        <Kpi
          label="Salida"
          value={
            last?.exitReason
              ? (EXIT_WORD[last.exitReason] ?? last.exitReason)
              : null
          }
          missing={last ? 'sin salida registrada' : undefined}
        />
        <Kpi
          label="Entrada"
          value={agoText(last?.entryBucketMs, report.generatedAtMs)}
          note={last ? utcDateTime(last.entryBucketMs) : undefined}
        />
        <Kpi
          label="Registros abiertos sin verificar"
          value={String(experiment.openRecords)}
          note="forward_open: historia, no posición actual"
        />
      </dl>
      <p className="detail__note">
        Operaciones en las últimas 24 h: {experiment.tradesInWindow} · último
        ciclo del forward:{' '}
        {experiment.lastCycleMs == null
          ? NA
          : `${utcDateTime(experiment.lastCycleMs)} (${agoText(experiment.lastCycleMs, report.generatedAtMs)})`}
        . Posición actual verificada y resultado en USD o pb de esta operación:{' '}
        {NA} (B5).
      </p>
    </>
  )
}

function OperationsModule({
  row,
  activity,
}: {
  row: InventoryStrategy
  activity: Loaded<ActivityReport>
}) {
  const experiment =
    activity.state === 'ok' && activity.value.operations.state === 'ok'
      ? (activity.value.operations.experiments.find(
          (item) => item.experimentId === experimentIdOf(row),
        ) ?? null)
      : null
  return (
    <Module
      index="04"
      title="OPERACIONES ALMACENADAS DEL FORWARD"
      testId="module-operations"
      aside={<span className="detail__tag">SIN CURVA DE EQUITY</span>}
    >
      <Unavailable>
        <b>Curva de equity y trailing: {NA.toLowerCase()}.</b> No hay una serie
        de equity por experimento; no se dibuja ninguna.
      </Unavailable>
      {activity.state === 'loading' && (
        <DataState kind="loading" title="Leyendo operaciones (B2)…" />
      )}
      {activity.state === 'error' && (
        <Unavailable>
          {NA}: no se pudo leer B2 ({activity.message}).
        </Unavailable>
      )}
      {activity.state === 'ok' && (
        <StoredOperations experiment={experiment} report={activity.value} />
      )}
    </Module>
  )
}

function PlanModule({ plan }: { plan: StrategyPlan | null }) {
  return (
    <Module index="06" title="PLAN DE EJECUCIÓN" testId="module-plan">
      {!plan ? (
        <Unavailable>{NA}: el registro no devolvió el plan.</Unavailable>
      ) : (
        <table className="detail__table" data-testid="plan-table">
          <tbody>
            <tr>
              <th scope="row">Señal</th>
              <td>
                {plan.signal.type}
                {plan.signal.model ? ` · ${plan.signal.model}` : ''}
              </td>
            </tr>
            <tr>
              <th scope="row">Lados</th>
              <td>{plan.entry.sides.join(' / ')}</td>
            </tr>
            <tr>
              <th scope="row">Stop</th>
              <td>
                {plan.exit.stop_atr
                  ? `${plan.exit.stop_atr} × ${plan.exit.volatility}`
                  : 'sin stop'}
              </td>
            </tr>
            <tr>
              <th scope="row">Objetivo</th>
              <td>
                {plan.exit.target_stop_ratio
                  ? `${plan.exit.target_stop_ratio} × el stop`
                  : 'sin objetivo'}
              </td>
            </tr>
            <tr>
              <th scope="row">Tiempo</th>
              <td>{horizonText(plan.exit.time_minutes) ?? 'sin límite'}</td>
            </tr>
            <tr>
              <th scope="row">Tamaño</th>
              <td>{plan.size.notional_usd} USD fijos por operación</td>
            </tr>
            <tr>
              <th scope="row">Productos</th>
              <td>
                {plan.products === 'all' ? 'los 8 perpetuos' : plan.products}
              </td>
            </tr>
            <tr>
              <th scope="row">Costes</th>
              <td>{plan.costs.model}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Module>
  )
}

type Props = {
  api: StrategyApi
  row: InventoryStrategy
  inventory: Inventory
  onBack: () => void
  onOpenLab: () => void
  loadActivity?: LoadActivity
}

/**
 * Detail of one strategy (Stitch v5 «Detalle C29»): configuration, backtest,
 * out-of-sample ranges and forward in separate sections, each with its source.
 * Whatever has no source says «No disponible» or names the missing piece (B3,
 * B5). No chart is drawn: there is no series to draw.
 */
export default function StrategyDetailView({
  api,
  row,
  inventory,
  onBack,
  onOpenLab,
  loadActivity = defaultLoadActivity,
}: Props) {
  const detail = useLoaded(() => api.detail(row.id), `detail:${row.id}`)
  const plans = useLoaded(
    api.plans ? () => (api.plans as NonNullable<typeof api.plans>)() : null,
    `plans:${row.id}`,
  )
  const activity = useLoaded(loadActivity, `activity:${row.id}`)
  const stored = detail.state === 'ok' ? detail.value : null
  const plan = plans.state === 'ok' ? (plans.value[row.id] ?? null) : null
  const market =
    row.market.products != null ? `${row.market.products} perpetuos PF_` : NA
  return (
    <section
      className="detail"
      aria-label={`Detalle de ${row.name}`}
      data-testid="strategy-detail"
    >
      <header className="detail__head">
        <div className="detail__crumbs">
          <button type="button" onClick={onBack}>
            Estrategias
          </button>
          <span aria-hidden="true">/</span>
          <h2>{row.name}</h2>
          <small>v{row.version}</small>
        </div>
        <div className="detail__badges">
          <OperationalBadge
            state={row.operational.state}
            basis={row.operational.basis}
          />
          <ResearchBadge state={row.research.state} />
          {row.frozen && <FrozenBadge />}
        </div>
        <p className="detail__market">
          {market}
          {row.market.horizon_minutes != null &&
            ` · horizonte ${horizonText(row.market.horizon_minutes)}`}
          {row.research.backtest?.t_stat != null &&
            ` · t = ${amount(row.research.backtest.t_stat)}`}
        </p>
        <div className="detail__actions">
          <button type="button" onClick={onOpenLab}>
            Abrir en Laboratorio
          </button>
          <a href="/terminal">Ver en Terminal →</a>
        </div>
      </header>

      {detail.state === 'error' && (
        <DataState
          kind="error"
          title="No se pudo leer el spec de esta estrategia"
          detail={`${detail.message}. Se muestran solo los datos del inventario.`}
        />
      )}

      <div className="detail__grid">
        <div className="detail__col">
          <ConfigModule row={row} detail={stored} />
          <PipelineModule spec={stored?.spec ?? null} />
        </div>
        <div className="detail__col">
          <PerformanceModule row={row} inventory={inventory} />
          <OperationsModule row={row} activity={activity} />
          <PlanModule plan={plan} />
        </div>
      </div>
      <ProvenanceModule row={row} inventory={inventory} detail={stored} />
    </section>
  )
}
