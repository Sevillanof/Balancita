#!/bin/bash
# Daily consistent backup (VACUUM INTO: one read snapshot, never a raw file copy) of the live SQLite databases,
# integrity_check on each copy, 7-day retention, then the Parquet export from the COPIES (never from the live DB).
# Runs as user balancita (balancita-respaldo.timer, 04:30 Europe/Madrid). Low priority.
# Versioned in the repo (ops/vps/); installed at /usr/local/bin/balancita-respaldo.sh (see ops/vps/README.md).
set -u
SRC=/home/balancita/Balancita/server/data/dev-live
ROOT=/home/balancita/backups
OUT=/home/balancita/parquet
PY=/home/balancita/.venvs/archivo-pq/bin/python
LOG=/home/balancita/respaldo.log
DAY=$(date +%F)
STAMP=$(date -u +%Y%m%d-%H%M%S)
DEST=$ROOT/$DAY
rc=0
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

mkdir -p "$DEST" "$OUT"
log "inicio respaldo -> $DEST"
for f in $(cd "$SRC" && find . -name '*.sqlite' | sed 's#^\./##' | sort); do
  # flat file name: <base>-<stamp>.sqlite (the Parquet job expects exactly this); nested ones keep their folder in the name
  base=$(basename "$f" .sqlite)
  [[ $f == */* ]] && base="$(dirname "$f" | tr / _)__$base"
  tmp="$DEST/$base-$STAMP.sqlite.tmp"
  final="$DEST/$base-$STAMP.sqlite"
  rm -f "$tmp"
  if nice -n 19 ionice -c3 sqlite3 -readonly -cmd ".timeout 60000" "$SRC/$f" "VACUUM INTO '$tmp'" 2>>"$LOG"; then
    res=$(nice -n 19 ionice -c3 sqlite3 "$tmp" "pragma integrity_check" | head -1)
    if [[ $res == ok ]]; then
      mv "$tmp" "$final"; log "ok $f $(stat -c %s "$final") bytes"
    else
      log "FALLA integrity_check $f: $res"; mv "$tmp" "$tmp.malo"; rc=1
    fi
  else
    log "FALLA copia $f"; rm -f "$tmp"; rc=1
  fi
done

# retention: remove backup day folders older than 7 days (only inside $ROOT)
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime +7 -exec rm -rf {} + 2>>"$LOG"

if [[ -x $PY ]]; then
  cd /home/balancita/Balancita/python && PYTHONPATH=. nice -n 19 ionice -c3 "$PY" -m archivo_parquet nocturno --destino "$OUT" --respaldos "$DEST" >> "$LOG" 2>&1
  prc=$?; log "parquet nocturno exit=$prc"; (( prc == 0 || prc == 3 )) || rc=1
else
  log "aviso: falta el venv $PY, no se exporto Parquet"
fi
log "fin respaldo rc=$rc"

# Alert: its own healthchecks.io check (HC_PING_URL_RESPALDO in /etc/balancita/alert.env). A failed run pings /fail with the
# reason; a run that never happens is caught by the check's daily period + grace on healthchecks.io.
if [[ -n "${HC_PING_URL_RESPALDO:-}" ]]; then
  if (( rc == 0 )); then
    curl -fsS -m 10 --retry 2 -o /dev/null "$HC_PING_URL_RESPALDO" || log "aviso: ping a healthchecks fallo"
  else
    reason=$(cd /home/balancita/Balancita/python && PYTHONPATH=. "$PY" -m archivo_parquet estado --destino "$OUT" 2>&1 | head -c 900)
    curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "respaldo rc=$rc. ${reason:-ver $LOG}" "${HC_PING_URL_RESPALDO%/}/fail" \
      || log "aviso: ping /fail fallo"
  fi
fi
exit $rc
