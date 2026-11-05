#!/bin/bash
# Balancita health check: runs every 5 min as user balancita (balancita-healthcheck.timer).
# Always appends a summary to ~/health.log. If HC_PING_URL is set (from /etc/balancita/alert.env, loaded by the
# unit), pings healthchecks.io on success and <url>/fail with the reason otherwise.
DB=/home/balancita/Balancita/server/data/dev-live/futures-market.sqlite
LOG=/home/balancita/health.log
problems=()

systemctl is-active --quiet balancita || problems+=("balancita.service no activo")

now_ms=$(( $(date +%s) * 1000 ))
last=$(sqlite3 -readonly -cmd ".timeout 5000" "$DB" "select max(bucket_start) from paper_futures_official_candles where product_id='PF_ETHUSD' and interval_ms=60000" 2>/dev/null)
if [[ "$last" =~ ^[0-9]+$ ]]; then
  age_min=$(( (now_ms - last) / 60000 ))
  (( age_min >= 10 )) && problems+=("ultima vela 1m ETH de hace ${age_min} min")
else
  age_min=NA; problems+=("no se pudo leer la ultima vela 1m ETH")
fi

curl -sf -m 5 http://127.0.0.1:8088/health >/dev/null || problems+=("llama-server /health falla")

disk=$(df --output=pcent /home | tail -1 | tr -dc 0-9)
(( disk >= 80 )) && problems+=("disco al ${disk}%")

mem_free_mb=$(free -m | awk '/^Mem:/{print $7}')
(( mem_free_mb < 500 )) && problems+=("RAM disponible ${mem_free_mb} MB")

stamp=$(date -u +%FT%TZ)
if (( ${#problems[@]} == 0 )); then
  status=OK; reason=""
else
  status=FALLA; reason=$(IFS=';'; echo "${problems[*]}")
fi
echo "$stamp $status vela_eth_edad_min=$age_min disco=${disk}% ram_disp_mb=${mem_free_mb} $reason" >> "$LOG"
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

if [[ -n "${HC_PING_URL:-}" ]]; then
  if [[ $status == OK ]]; then
    curl -fsS -m 10 --retry 2 -o /dev/null "$HC_PING_URL" || echo "$stamp aviso: ping a healthchecks fallo" >> "$LOG"
  else
    curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$reason" "${HC_PING_URL%/}/fail" || echo "$stamp aviso: ping /fail fallo" >> "$LOG"
  fi
fi
[[ $status == OK ]]
