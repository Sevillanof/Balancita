/* DATOS DE EJEMPLO: caídas y precios inventados solo para las pruebas de la pantalla del analista de rebote. */
import type {
  HonestyMeter,
  QuickRebote,
  ReboteTrade,
  ReboteVariant,
} from '../infrastructure/quick-api.ts'

const H = 3_600_000
export const T0 = Date.UTC(2024, 0, 1)

const meter: HonestyMeter = {
  semaforo: 'rojo',
  motivo: 'Solo el 0 % del resultado está fuera del ajuste de la fórmula.',
  intentos: 2200,
  fuera_del_ajuste_pct: 0,
  practica_usada: true,
  incluye_practica: false,
  practica: { desde: '2025-10-16', hasta: '2026-04-19' },
  holdout_intacto: true,
  holdout_desde: '2026-04-19',
  prob_no_es_suerte: 0.3,
  medicion: 'vigente',
}

/** A fall at hour `at` (−6 % in the hour before) that is held `hold` hours, and the 5-minute prices around it. */
function trade(
  at: number,
  hold: number,
  net: number,
  before: number,
  fixed: number,
): ReboteTrade {
  const entry = T0 + at * H + 60_000
  const exit = entry + hold * H
  const velas: Array<[number, number]> = []
  for (let t = entry - 4 * H; t <= exit + 3 * H; t += 300_000)
    velas.push([t, 2000 + ((t - entry) / H) * 2])
  return {
    producto: 'PF_ETHUSD',
    lado: 1,
    entrada_ms: entry,
    salida_ms: exit,
    neto_bp: net,
    motivo: 'tiempo',
    entrada_px: 1900,
    salida_px: 1900 * (1 + net / 1e4),
    caida: {
      desde_ms: entry - H - 60_000,
      hasta_ms: entry - 60_000,
      desde_px: 2020,
      hasta_px: 1900,
      pct: -5.94,
      btc_pct: -2.1,
    },
    velas,
    cuenta: {
      compuesto: {
        nocional_usd: before,
        pnl_usd: (before * net) / 1e4,
        cuenta_usd: before + (before * net) / 1e4,
      },
      fijo: {
        nocional_usd: 100,
        pnl_usd: (100 * net) / 1e4,
        cuenta_usd: fixed,
      },
    },
  }
}

const principal: ReboteVariant = {
  id: 'principal',
  label: 'Caída de 5 % en 1 h → largo 24 h',
  salida_horas: 24,
  filtro_btc_pct: null,
  caidas: 2,
  operaciones: [
    trade(100, 24, 1000, 1000, 1010),
    trade(300, 24, -500, 1100, 1005),
  ],
  resumen: {
    operaciones: 2,
    neto_pb: 500,
    ganadoras: 0.5,
    por_anio: { '2024': { operaciones: 2, neto_pb: 500 } },
  },
  cuentas: {
    compuesto: {
      inicial_usd: 1000,
      final_usd: 1045,
      ganancia_usd: 45,
      ganancia_pct: 4.5,
      caida_maxima_pct: 5,
      curva: [
        [T0 + 125 * H, 1100],
        [T0 + 325 * H, 1045],
      ],
    },
    fijo: {
      inicial_usd: 1000,
      final_usd: 1005,
      ganancia_usd: 5,
      ganancia_pct: 0.5,
      caida_maxima_pct: 0.5,
      curva: [
        [T0 + 125 * H, 1010],
        [T0 + 325 * H, 1005],
      ],
    },
  },
  honestidad: meter,
}

const filtered: ReboteVariant = {
  ...principal,
  id: 'filtro_btc',
  label: 'Con filtro: ETH 2 puntos peor que BTC → largo 4 h',
  salida_horas: 4,
  filtro_btc_pct: 2,
  caidas: 1,
  operaciones: [trade(100, 4, 300, 1000, 1003)],
  resumen: { ...principal.resumen, operaciones: 1 },
}

export const rebote: QuickRebote = {
  schema: 'balancita-qwen-rebote.v1',
  producto: 'PF_ETHUSD',
  desde_ms: T0,
  hasta_ms: T0 + 400 * H,
  inicial_usd: 1000,
  fijo_usd: 100,
  costo_ida_vuelta_pb: 10.38,
  caida_pct: 5,
  ventana_min: 60,
  variantes: [principal, filtered],
  mercado: {
    PF_ETHUSD: Array.from({ length: 400 }, (_, i) => [
      T0 + i * H,
      2000 + (i % 24),
    ]),
  },
  note: 'n',
}
