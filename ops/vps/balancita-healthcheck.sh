#!/bin/bash
# Balancita health check: runs every 5 min as user balancita (balancita-healthcheck.timer).
# Always appends a summary to ~/health.log. If HC_PING_URL is set (from /etc/balancita/alert.env, loaded by the
# unit), pings healthchecks.io on success and <url>/fail with the reason otherwise.
#
# Checks (S5 de odd/tasks/operacion-mejoras.md; detalle y umbrales en ops/vps/README.md):
#   servicio, última vela 1m de ETH, disco, RAM                              (de siempre)
#   latido del operador        decisión o salto más reciente <= HC_LATIDO_MAX_MIN (20)
#   miradas perdidas           < HC_PERDIDAS_MIN (2) en los últimos HC_PERDIDAS_VENTANA_MIN (60) min
#   posición sin valorar       última marca de una posición abierta <= HC_SIN_VALORAR_MAX_MIN (30) min
#   reloj de la VPS            NTP sincronizado y |diferencia contra Kraken| <= HC_RELOJ_MAX_S (3) s
# Qwen (llama-server) caído ya NO falla el ping: no afecta al paper; queda en el log como llama=caido.
# Todo se lee con sqlite3 -readonly y consultas acotadas; nada se escribe fuera del log.
#
# Rutas y umbrales se pueden cambiar por entorno (valores por defecto entre paréntesis):
#   HC_DATA_DIR (/home/balancita/Balancita/server/data/dev-live)  HC_LOG (/home/balancita/health.log)
#   HC_DISK_PATH (/home)  HC_LLAMA_URL (http://127.0.0.1:8088/health)  HC_KRAKEN_URL (https://futures.kraken.com)
#   HC_SQLITE_TIMEOUT_MS (2000)
HC_DATA_DIR="${HC_DATA_DIR:-/home/balancita/Balancita/server/data/dev-live}"
LOG="${HC_LOG:-/home/balancita/health.log}"
DB="$HC_DATA_DIR/futures-market.sqlite"
LIVE_DB="$HC_DATA_DIR/qwen-live/live.sqlite"
AUDITOR_DB="$HC_DATA_DIR/qwen-live/auditor.sqlite"
DISK_PATH="${HC_DISK_PATH:-/home}"
LLAMA_URL="${HC_LLAMA_URL:-http://127.0.0.1:8088/health}"
KRAKEN_URL="${HC_KRAKEN_URL:-https://futures.kraken.com}"
SQLITE_TIMEOUT_MS="${HC_SQLITE_TIMEOUT_MS:-2000}"
LATIDO_MAX_MIN="${HC_LATIDO_MAX_MIN:-20}"
PERDIDAS_MIN="${HC_PERDIDAS_MIN:-2}"
PERDIDAS_VENTANA_MIN="${HC_PERDIDAS_VENTANA_MIN:-60}"
SIN_VALORAR_MAX_MIN="${HC_SIN_VALORAR_MAX_MIN:-30}"
RELOJ_MAX_S="${HC_RELOJ_MAX_S:-3}"
problems=()

# Solo lectura y con espera corta si la base está ocupada.
consulta() { sqlite3 -readonly -cmd ".timeout $SQLITE_TIMEOUT_MS" "$@" 2>/dev/null; }

# Epoch (s) de una fecha HTTP «Mon, 09 Nov 2026 22:29:00 GMT», en bash puro (no depende de date -d de GNU).
http_date_epoch() {
  local re='^[A-Za-z]{3}, ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT'
  [[ "$1" =~ $re ]] || return 1
  local d=$((10#${BASH_REMATCH[1]})) y=${BASH_REMATCH[3]} mon
  local hh=$((10#${BASH_REMATCH[4]})) mm=$((10#${BASH_REMATCH[5]})) ss=$((10#${BASH_REMATCH[6]}))
  case "${BASH_REMATCH[2]}" in
    Jan) mon=1 ;; Feb) mon=2 ;; Mar) mon=3 ;; Apr) mon=4 ;; May) mon=5 ;; Jun) mon=6 ;;
    Jul) mon=7 ;; Aug) mon=8 ;; Sep) mon=9 ;; Oct) mon=10 ;; Nov) mon=11 ;; Dec) mon=12 ;; *) return 1 ;;
  esac
  (( mon <= 2 )) && y=$((y - 1))
  local era=$((y / 400)) yoe doy doe
  yoe=$((y - era * 400))
  doy=$(( (153 * ((mon + 9) % 12) + 2) / 5 + d - 1 ))
  doe=$(( yoe * 365 + yoe / 4 - yoe / 100 + doy ))
  echo $(( (era * 146097 + doe - 719468) * 86400 + hh * 3600 + mm * 60 + ss ))
}

systemctl is-active --quiet balancita || problems+=("balancita.service no activo")

now_s=$(date +%s)
now_ms=$(( now_s * 1000 ))
last=$(consulta "$DB" "select max(bucket_start) from paper_futures_official_candles where product_id='PF_ETHUSD' and interval_ms=60000")
if [[ "$last" =~ ^[0-9]+$ ]]; then
  age_min=$(( (now_ms - last) / 60000 ))
  (( age_min >= 10 )) && problems+=("ultima vela 1m ETH de hace ${age_min} min")
else
  age_min=NA; problems+=("no se pudo leer la ultima vela 1m ETH")
fi

# --- Operador: latido, miradas perdidas y posiciones sin valorar (live.sqlite es obligatoria) ---
latido_min=NA; perdidas_n=NA; sin_valorar_min=NA
if [[ ! -f "$LIVE_DB" ]]; then
  problems+=("no existe live.sqlite del operador")
else
  cut_ms=$(( now_ms - PERDIDAS_VENTANA_MIN * 60000 ))
  # Una sola lectura: último t_ms de decisiones y de salteadas (sin proceso_detenido), miradas con proceso_detenido en la ventana (t_ms separados por
  # coma) y la posición abierta con la marca más vieja (la marca se actualiza con cada valoración con el libro; si falla queda
  # la del último éxito y trades.execution_error con el motivo).
  row=$(consulta -separator '|' "$LIVE_DB" "select
    (select max(t_ms) from decisions),
    (select max(t_ms) from skipped where reason<>'proceso_detenido'),
    (select group_concat(t_ms) from (select distinct t_ms from skipped where reason='proceso_detenido' and t_ms >= $cut_ms)),
    (select product || ' #' || trade_no || '|' || coalesce(mark_ms, opened_at_ms, entry_ms) || '|' || coalesce(execution_error, '')
       from trades where status='open' order by coalesce(mark_ms, opened_at_ms, entry_ms) asc limit 1)")
  rc=$?
  if (( rc != 0 )) || [[ -z "$row" ]]; then
    problems+=("no se pudo leer live.sqlite del operador")
  else
    IFS='|' read -r dec_max skip_max perdidas_live abierta_id abierta_ms abierta_err <<<"$row"

    # a) latido: la mirada (decisión o salto) más reciente. Las perdidas no cuentan: su t_ms es de una hora ya pasada.
    ultimo=0
    [[ "$dec_max" =~ ^[0-9]+$ ]] && (( dec_max > ultimo )) && ultimo=$dec_max
    [[ "$skip_max" =~ ^[0-9]+$ ]] && (( skip_max > ultimo )) && ultimo=$skip_max
    if (( ultimo == 0 )); then
      problems+=("operador sin latido (live.sqlite sin decisiones ni saltos)")
    else
      latido_min=$(( (now_ms - ultimo) / 60000 ))
      (( now_ms - ultimo > LATIDO_MAX_MIN * 60000 )) && problems+=("operador sin latido (ultima mirada hace ${latido_min} min)")
    fi

    # b) miradas perdidas en la ventana: live.sqlite (skipped) y auditor (miradas_perdidas), una vez por mirada.
    perdidas_auditor=$(consulta "$AUDITOR_DB" "select group_concat(t_ms) from (select distinct t_ms from miradas_perdidas where t_ms >= $cut_ms)")
    perdidas_n=$(printf '%s\n%s\n' "$perdidas_live" "$perdidas_auditor" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -u | wc -l | tr -dc 0-9)
    (( perdidas_n >= PERDIDAS_MIN )) && problems+=("${perdidas_n} miradas perdidas en la ultima hora")

    # c) posición abierta sin valorar: edad de la marca más vieja.
    sin_valorar_min=0
    if [[ "$abierta_ms" =~ ^[0-9]+$ ]]; then
      sin_valorar_min=$(( (now_ms - abierta_ms) / 60000 ))
      if (( now_ms - abierta_ms > SIN_VALORAR_MAX_MIN * 60000 )); then
        detalle=""; [[ -n "$abierta_err" ]] && detalle=" ($abierta_err)"
        problems+=("posicion $abierta_id sin valorar hace ${sin_valorar_min} min${detalle}")
      fi
    fi
  fi
fi

# --- d) Reloj de la VPS: NTP sincronizado y diferencia contra la cabecera Date de Kraken (positivo = VPS adelantada) ---
reloj_s=NA; ntp=NA
if command -v timedatectl >/dev/null 2>&1; then
  ntp=$(timedatectl show -p NTPSynchronized 2>/dev/null | head -1)
  ntp=${ntp#NTPSynchronized=}; ntp=${ntp:-NA}
fi
fecha=$(curl -sI -m 3 "$KRAKEN_URL" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="date:"{sub(/^[^:]*: */,""); print; exit}')
if [[ -n "$fecha" ]] && server_s=$(http_date_epoch "$fecha"); then
  reloj_s=$(( $(date +%s) - server_s ))
fi
if [[ "$reloj_s" != NA ]] && (( reloj_s > RELOJ_MAX_S || reloj_s < -RELOJ_MAX_S )); then
  problems+=("reloj de la VPS desfasado $(printf '%+d' "$reloj_s") s")
elif [[ "$ntp" == no ]]; then
  medido=""; [[ "$reloj_s" != NA ]] && medido=" (diferencia con Kraken $(printf '%+d' "$reloj_s") s)"
  problems+=("reloj de la VPS sin sincronizar (NTP)$medido")
fi

# --- e) Qwen: ya no falla el ping (no afecta al paper); solo queda en el log ---
if curl -sf -m 3 "$LLAMA_URL" >/dev/null; then llama=ok; else llama=caido; fi

disk=$(df --output=pcent "$DISK_PATH" | tail -1 | tr -dc 0-9)
(( disk >= 80 )) && problems+=("disco al ${disk}%")

mem_free_mb=$(free -m | awk '/^Mem:/{print $7}')
(( mem_free_mb < 500 )) && problems+=("RAM disponible ${mem_free_mb} MB")

stamp=$(date -u +%FT%TZ)
if (( ${#problems[@]} == 0 )); then
  status=OK; reason=""
else
  status=FALLA; reason=$(IFS=';'; echo "${problems[*]}")
fi
echo "$stamp $status vela_eth_edad_min=$age_min latido_min=$latido_min perdidas_1h=$perdidas_n sin_valorar_min=$sin_valorar_min reloj_s=$reloj_s ntp=$ntp llama=$llama disco=${disk}% ram_disp_mb=${mem_free_mb} $reason" >> "$LOG"
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

if [[ -n "${HC_PING_URL:-}" ]]; then
  if [[ $status == OK ]]; then
    curl -fsS -m 10 --retry 2 -o /dev/null "$HC_PING_URL" || echo "$stamp aviso: ping a healthchecks fallo" >> "$LOG"
  else
    curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$reason" "${HC_PING_URL%/}/fail" || echo "$stamp aviso: ping /fail fallo" >> "$LOG"
  fi
fi
[[ $status == OK ]]
