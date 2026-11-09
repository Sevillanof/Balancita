#!/usr/bin/env bash
# Despliegue único develop → main → VPS (reproduce lo que se hacía a mano; ver ops/vps/README.md).
#
#   ops/vps/desplegar.sh [--dry-run] [--sin-reinicio] [--dropin NOMBRE]... [--ayuda]
#
# Pasos (cada uno se verifica y el script corta con el motivo si algo no cuadra):
#   1. gh con la cuenta Sevillanof (solo en este proceso; no toca la cuenta global de gh).
#   2. PR develop → main (se reutiliza el abierto; si main ya tiene develop, se salta).
#   3. Espera la CI del commit (los checks de push y de pull_request), hasta 60 min.
#      Corta si hay conflicto, un check en rojo o si no aparecen checks.
#   4. Merge del PR.
#   5. VPS (ssh BatchMode): `git pull --ff-only` como balancita.
#   6. Instala los drop-ins de systemd que cambiaron (y `daemon-reload`). Un drop-in que está en el repo
#      pero NO instalado en la VPS (hoy noticias.conf) no se instala solo: pedirlo con --dropin NOMBRE.
#   7. Reinicia `balancita` solo entre los minutos :16 y :27 UTC (espera la ventana).
#   8. Chequeos: servicio activo, llama-server con VmLck > 0 y `-t 5`, sin integridad corriendo
#      justo después del arranque, sin errores nuevos en qwen-live y sin Traceback en el journal.
#
# Opciones:
#   --dry-run        solo lecturas (cuenta gh, PR, ssh de prueba); no crea ni mergea PR ni cambia la VPS.
#   --sin-reinicio   hace todo menos reiniciar y los chequeos posteriores; dice si el reinicio queda pendiente.
#   --dropin NOMBRE  también instala ese drop-in aunque todavía no esté en la VPS (se puede repetir).
#
# Idempotente: se puede volver a correr tras un corte; lo que ya está hecho se salta. Solo reinicia si
# el servicio arrancó antes del último commit o drop-in instalado.
#
# Códigos de salida: 0 ok · 1 error general · 2 uso incorrecto · 3 PR/CI (conflicto, rojo, sin checks, tiempo)
#                    4 chequeos posteriores al reinicio fallaron · 5 VPS (ssh, pull, drop-ins, reinicio)
#
# Variables (para pruebas o cambios puntuales): DESPLIEGUE_REPO, DESPLIEGUE_VPS, DESPLIEGUE_VPS_DIR,
#   DESPLIEGUE_CI_MAX_SEG (3600), DESPLIEGUE_SONDEO_SEG (30), DESPLIEGUE_AVISO_SEG (120),
#   DESPLIEGUE_SIN_CHECKS_SEG (600), DESPLIEGUE_ARRANQUE_SEG (60), DESPLIEGUE_LLAMA_SEG (240).
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"

REPO="${DESPLIEGUE_REPO:-Sevillanof/Balancita}"
VPS="${DESPLIEGUE_VPS:-root@13.140.202.221}"
VPS_DIR="${DESPLIEGUE_VPS_DIR:-/home/balancita/Balancita}"
VPS_DB="$VPS_DIR/server/data/dev-live/qwen-live/live.sqlite"
DROPINS_ORIGEN="$VPS_DIR/ops/vps/systemd/balancita.service.d"
DROPINS_DESTINO="/etc/systemd/system/balancita.service.d"
CI_MAX_SEG="${DESPLIEGUE_CI_MAX_SEG:-3600}"
SONDEO_SEG="${DESPLIEGUE_SONDEO_SEG:-30}"
AVISO_SEG="${DESPLIEGUE_AVISO_SEG:-120}"
SIN_CHECKS_SEG="${DESPLIEGUE_SIN_CHECKS_SEG:-600}"
ARRANQUE_SEG="${DESPLIEGUE_ARRANQUE_SEG:-60}"
LLAMA_SEG="${DESPLIEGUE_LLAMA_SEG:-240}"
VENTANA_DESDE=16
VENTANA_HASTA=27
REINTENTOS=4

DRY=0
SIN_REINICIO=0
DROPINS_NUEVOS=()
PR=""

ERR_ARCHIVO="$(mktemp)"
trap 'rm -f "$ERR_ARCHIVO"' EXIT

ahora_txt() { date -u +%H:%M:%S; }
info() { printf '[%s] %s\n' "$(ahora_txt)" "$*"; }
aviso() { printf '[%s] %s\n' "$(ahora_txt)" "$*" >&2; }
simular() { printf '[%s] [dry-run] %s\n' "$(ahora_txt)" "$*"; }
fallar() {
  local codigo="$1"
  shift
  printf '[%s] ERROR: %s\n' "$(ahora_txt)" "$*" >&2
  exit "$codigo"
}

uso() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --sin-reinicio) SIN_REINICIO=1 ;;
    --dropin)
      [ $# -ge 2 ] || fallar 2 "--dropin necesita el nombre de un archivo (por ejemplo noticias.conf)."
      case "$2" in
        */* | "" | .*) fallar 2 "--dropin va con el nombre del archivo, sin rutas: '$2'." ;;
      esac
      DROPINS_NUEVOS+=("$2")
      shift
      ;;
    -h | --ayuda | --help)
      uso
      exit 0
      ;;
    *) fallar 2 "opción desconocida: $1 (probá --ayuda)." ;;
  esac
  shift
done

# --- gh con la cuenta Sevillanof (solo este proceso) ---------------------------------------------------------
# shellcheck source=../../scripts/gh-sevillanof.sh
. "$RAIZ/scripts/gh-sevillanof.sh"

# gh con reintentos: los 401/5xx transitorios de GitHub se reintentan; si sigue fallando, se aborta.
gh_r() {
  local intento=1 salida
  while :; do
    if salida="$(gh "$@" 2>"$ERR_ARCHIVO")"; then
      printf '%s' "$salida"
      return 0
    fi
    if [ "$intento" -ge "$REINTENTOS" ]; then
      fallar 3 "gh $1 $2 falló $REINTENTOS veces seguidas: $(tr '\n' ' ' <"$ERR_ARCHIVO" | cut -c1-300)"
    fi
    aviso "gh falló (intento $intento de $REINTENTOS: $(tr '\n' ' ' <"$ERR_ARCHIVO" | cut -c1-120)); reintento en $((intento * 5)) s."
    sleep $((intento * 5))
    intento=$((intento + 1))
  done
}

# ssh en BatchMode (sin preguntas). Reintenta solo ante cortes de conexión (código 255); cualquier otro
# código es el del comando remoto y lo devuelve.
vps() {
  local intento=1 rc salida
  while :; do
    rc=0
    salida="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$VPS" "$1" 2>"$ERR_ARCHIVO")" || rc=$?
    if [ "$rc" -ne 255 ]; then
      printf '%s' "$salida"
      return "$rc"
    fi
    if [ "$intento" -ge "$REINTENTOS" ]; then
      fallar 5 "no pude conectar por ssh a $VPS ($REINTENTOS intentos): $(tr '\n' ' ' <"$ERR_ARCHIVO" | cut -c1-200)"
    fi
    aviso "ssh sin conexión (intento $intento de $REINTENTOS); reintento en $((intento * 5)) s."
    sleep $((intento * 5))
    intento=$((intento + 1))
  done
}

# --- 2/3/4. PR, CI y merge -----------------------------------------------------------------------------------
buscar_pr_abierto() {
  gh_r pr list -R "$REPO" --base main --head develop --state open --json number -q '.[0].number // empty'
}

asegurar_pr() {
  local adelante
  PR="$(buscar_pr_abierto)"
  if [ -n "$PR" ]; then
    info "Ya hay un PR develop → main abierto: #$PR (lo reutilizo)."
    return 0
  fi
  adelante="$(gh_r api "repos/$REPO/compare/main...develop" -q .ahead_by)"
  if [ "$adelante" = "0" ]; then
    info "main ya contiene todo develop (0 commits de diferencia) y no hay PR abierto: no hay nada que mergear."
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    simular "crearía el PR develop → main ($adelante commits de diferencia)."
    return 0
  fi
  info "Creo el PR develop → main ($adelante commits de diferencia)."
  gh_r pr create -R "$REPO" --base main --head develop \
    --title "Despliegue: develop → main" \
    --body "Despliegue con ops/vps/desplegar.sh." >/dev/null
  PR="$(buscar_pr_abierto)"
  [ -n "$PR" ] || fallar 3 "creé el PR pero no lo encuentro abierto en $REPO."
  info "PR creado: #$PR."
}

# Una lectura de la CI: imprime "total pendientes rojos" de los checks del último commit del PR.
resumen_checks() {
  gh_r pr view "$PR" -R "$REPO" --json statusCheckRollup -q '.statusCheckRollup | [length,
    ([.[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING")] | length),
    ([.[] | select(.conclusion == "FAILURE" or .conclusion == "CANCELLED" or .conclusion == "TIMED_OUT"
      or .state == "FAILURE" or .state == "ERROR")] | length)] | map(tostring) | join(" ")'
}

nombres_rojos() {
  gh_r pr view "$PR" -R "$REPO" --json statusCheckRollup -q '[.statusCheckRollup[]
    | select(.conclusion == "FAILURE" or .conclusion == "CANCELLED" or .conclusion == "TIMED_OUT" or .state == "FAILURE" or .state == "ERROR")
    | .name // .context] | join(", ")'
}

esperar_ci() {
  local inicio ahora transcurrido ultimo_aviso=-99999 mergeable resumen total pend rojos eventos sha estado
  inicio="$(date +%s)"
  while :; do
    ahora="$(date +%s)"
    transcurrido=$((ahora - inicio))
    mergeable="$(gh_r pr view "$PR" -R "$REPO" --json mergeable -q .mergeable)"
    [ "$mergeable" != "CONFLICTING" ] || fallar 3 "el PR #$PR tiene conflictos con main: resolvelos y volvé a correr el script."
    resumen="$(resumen_checks)"
    read -r total pend rojos <<<"$resumen"
    if [ "${rojos:-0}" -gt 0 ]; then
      fallar 3 "la CI del PR #$PR está en rojo ($rojos checks fallidos: $(nombres_rojos)). No mergeo."
    fi
    if [ "${total:-0}" -eq 0 ]; then
      [ "$transcurrido" -lt "$SIN_CHECKS_SEG" ] || fallar 3 "el PR #$PR no tiene checks de CI después de $((transcurrido / 60)) min (¿workflow roto o sin disparar?). No mergeo."
      estado="todavía sin checks"
    elif [ "${pend:-0}" -gt 0 ]; then
      estado="$pend de $total checks pendientes"
    else
      sha="$(gh_r pr view "$PR" -R "$REPO" --json headRefOid -q .headRefOid)"
      eventos="$(gh_r run list -R "$REPO" --commit "$sha" --json event -q '[.[].event] | unique | join(",")')"
      if [ "$eventos" = "pull_request,push" ]; then
        info "CI verde en el PR #$PR: $total checks (conjuntos push y pull_request)."
        return 0
      fi
      [ "$transcurrido" -lt "$SIN_CHECKS_SEG" ] || fallar 3 "faltan checks de CI: solo hay corridas de '${eventos:-ninguna}' y se esperan push y pull_request."
      estado="sin pendientes pero faltan checks (corridas: ${eventos:-ninguna}; se esperan push y pull_request)"
    fi
    [ "$transcurrido" -lt "$CI_MAX_SEG" ] || fallar 3 "la CI del PR #$PR no terminó en $((CI_MAX_SEG / 60)) min ($estado). No mergeo."
    if [ $((transcurrido - ultimo_aviso)) -ge "$AVISO_SEG" ]; then
      info "Esperando la CI del PR #$PR: $estado (van $((transcurrido / 60)) min de $((CI_MAX_SEG / 60)))."
      ultimo_aviso=$transcurrido
    fi
    sleep "$SONDEO_SEG"
  done
}

mergear_pr() {
  local estado
  estado="$(gh_r pr view "$PR" -R "$REPO" --json state -q .state)"
  if [ "$estado" = "MERGED" ]; then
    info "El PR #$PR ya estaba mergeado."
    return 0
  fi
  info "Mergeo el PR #$PR (merge commit; develop no se borra)."
  gh_r pr merge "$PR" -R "$REPO" --merge >/dev/null
  estado="$(gh_r pr view "$PR" -R "$REPO" --json state -q .state)"
  [ "$estado" = "MERGED" ] || fallar 3 "pedí el merge del PR #$PR pero el estado es '$estado'."
  info "PR #$PR mergeado."
}

# --- 5/6. VPS: pull y drop-ins -------------------------------------------------------------------------------
vps_pull() {
  local salida
  info "VPS: git pull --ff-only en $VPS_DIR."
  salida="$(vps "cd $VPS_DIR && sudo -u balancita git pull --ff-only 2>&1")" ||
    fallar 5 "git pull --ff-only falló en la VPS: $(printf '%s' "$salida" | tr '\n' ' ' | cut -c1-300)"
  info "VPS: $(printf '%s' "$salida" | tail -1)"
}

dropin_pedido() {
  local nombre="$1" pedido
  for pedido in ${DROPINS_NUEVOS[@]+"${DROPINS_NUEVOS[@]}"}; do
    [ "$pedido" != "$nombre" ] || return 0
  done
  return 1
}

vps_dropins() {
  local estado nombre situacion instalados=0
  estado="$(vps "for f in $DROPINS_ORIGEN/*.conf; do [ -e \"\$f\" ] || continue; n=\$(basename \"\$f\"); d=$DROPINS_DESTINO/\$n; if [ ! -e \"\$d\" ]; then echo \"\$n nuevo\"; elif cmp -s \"\$f\" \"\$d\"; then echo \"\$n igual\"; else echo \"\$n distinto\"; fi; done")" ||
    fallar 5 "no pude comparar los drop-ins de systemd en la VPS."
  while read -r nombre situacion; do
    [ -n "$nombre" ] || continue
    case "$situacion" in
      igual) info "Drop-in $nombre: igual al instalado." ;;
      distinto | nuevo)
        if [ "$situacion" = nuevo ] && ! dropin_pedido "$nombre"; then
          info "Drop-in $nombre: está en el repo pero NO instalado en la VPS; no lo instalo solo (pasá --dropin $nombre para aplicarlo)."
          continue
        fi
        info "Drop-in $nombre: $situacion; lo instalo."
        vps "install -D -m 644 $DROPINS_ORIGEN/$nombre $DROPINS_DESTINO/$nombre" >/dev/null || fallar 5 "no pude instalar el drop-in $nombre."
        instalados=$((instalados + 1))
        ;;
    esac
  done <<<"$estado"
  if [ "$instalados" -gt 0 ]; then
    vps "systemctl daemon-reload" >/dev/null || fallar 5 "systemctl daemon-reload falló."
    info "VPS: $instalados drop-in(s) instalado(s) y daemon-reload hecho."
  fi
}

# Imprime "si" o "no": el servicio necesita reiniciarse si arrancó antes del último commit o drop-in.
vps_necesita_reinicio() {
  vps "inicio=\$(date -d \"\$(systemctl show balancita -p ActiveEnterTimestamp --value)\" +%s 2>/dev/null || echo 0); commit=\$(git -C $VPS_DIR log -1 --format=%ct); dropin=\$(stat -c %Y $DROPINS_DESTINO/*.conf 2>/dev/null | sort -n | tail -1); dropin=\${dropin:-0}; mayor=\$commit; [ \"\$dropin\" -gt \"\$mayor\" ] && mayor=\$dropin; if [ \"\$inicio\" -lt \"\$mayor\" ]; then echo si; else echo no; fi" ||
    fallar 5 "no pude saber si el servicio necesita reinicio."
}

# --- 7. ventana de reinicio ----------------------------------------------------------------------------------
esperar_ventana() {
  local m s falta paso
  while :; do
    m="$(date -u +%M)"
    s="$(date -u +%S)"
    m=$((10#$m))
    s=$((10#$s))
    if [ "$m" -ge "$VENTANA_DESDE" ] && [ "$m" -le "$VENTANA_HASTA" ]; then
      info "Estamos en la ventana de reinicio (minuto :$(printf '%02d' "$m") UTC; permitida :$VENTANA_DESDE-:$VENTANA_HASTA)."
      return 0
    fi
    falta=$(((VENTANA_DESDE - m + 60) % 60 * 60 - s))
    [ "$falta" -ge 1 ] || falta=1
    info "Fuera de la ventana de reinicio (minuto :$(printf '%02d' "$m") UTC; permitida :$VENTANA_DESDE-:$VENTANA_HASTA): espero $((falta / 60)) min $((falta % 60)) s para no cruzar una mirada."
    paso=$falta
    [ "$paso" -le 300 ] || paso=300
    sleep "$paso"
  done
}

# --- 8. chequeos posteriores ---------------------------------------------------------------------------------
FALLAS=()
falla() {
  FALLAS+=("$1")
  printf '[%s]   ✗ %s\n' "$(ahora_txt)" "$1" >&2
}
bien() { printf '[%s]   ✓ %s\n' "$(ahora_txt)" "$1"; }

chequeos_posteriores() {
  local desde_s="$1" activo llama inicio ahora salida desde_ms
  info "Chequeos posteriores (espero $ARRANQUE_SEG s a que arranque)."
  sleep "$ARRANQUE_SEG"

  activo="$(vps "systemctl is-active balancita; true")"
  if [ "$activo" = "active" ]; then bien "balancita está active."; else falla "balancita no está active (is-active dice '${activo:-nada}')."; fi

  # llama-server tarda en aparecer mientras carga el modelo: se reintenta hasta LLAMA_SEG.
  inicio="$(date +%s)"
  while :; do
    llama="$(vps "pid=\$(ps -eo pid=,comm= | awk '\$2==\"llama-server\"{print \$1; exit}'); if [ -z \"\$pid\" ]; then echo sin-proceso; else lck=\$(awk '/VmLck/{print \$2}' /proc/\$pid/status); if tr '\\0' ' ' </proc/\$pid/cmdline | grep -qE -- '(^| )-t 5( |\$)'; then h=si; else h=no; fi; echo \"pid=\$pid vmlck_kb=\${lck:-0} hilos5=\$h\"; fi; true")"
    [ "$llama" = "sin-proceso" ] || break
    ahora="$(date +%s)"
    [ $((ahora - inicio)) -lt "$LLAMA_SEG" ] || break
    info "llama-server todavía no está corriendo; espero 15 s."
    sleep 15
  done
  if [ "$llama" = "sin-proceso" ] || [ -z "$llama" ]; then
    falla "no hay proceso llama-server después de $LLAMA_SEG s."
  else
    if [[ "$llama" =~ vmlck_kb=([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]; then
      bien "llama-server con VmLck ${BASH_REMATCH[1]} kB (mlock aplicado)."
    else
      falla "llama-server con VmLck 0 (mlock no aplicado): $llama"
    fi
    if [[ "$llama" == *"hilos5=si"* ]]; then bien "llama-server con -t 5."; else falla "llama-server sin '-t 5': $llama"; fi
  fi

  salida="$(vps "ps -eo args= | grep '[d]b-health-child.*integrity' | cut -c1-200; true")"
  if [ -z "$salida" ]; then bien "no hay chequeo de integridad corriendo."; else falla "hay un chequeo de integridad corriendo justo después del arranque: $salida"; fi

  desde_ms=$((desde_s * 1000))
  if salida="$(vps "sqlite3 -readonly $VPS_DB \"SELECT at_ms || ' ' || place || ' ' || coalesce(product,'-') || ' ' || kind || ' ' || substr(detail,1,120) FROM errors WHERE at_ms >= $desde_ms ORDER BY at_ms DESC LIMIT 10\" 2>&1")"; then
    if [ -z "$salida" ]; then bien "sin errores nuevos en qwen-live (tabla errors)."; else falla "errores nuevos en qwen-live/live.sqlite (at_ms place product kind detalle): $(printf '%s' "$salida" | tr '\n' '|')"; fi
  else
    falla "no pude leer la tabla errors de $VPS_DB (no verifico en silencio): $(printf '%s' "$salida" | tr '\n' ' ' | cut -c1-150)"
  fi

  salida="$(vps "journalctl -u balancita --since \"\$(date -d @$desde_s '+%Y-%m-%d %H:%M:%S')\" --no-pager -o cat 2>/dev/null | grep -c Traceback; true")"
  salida="${salida//[^0-9]/}"
  if [ "${salida:-0}" = "0" ]; then bien "el journal no tiene Traceback desde el reinicio."; else falla "el journal tiene $salida línea(s) con Traceback desde el reinicio (journalctl -u balancita --since ...)."; fi

  if [ "${#FALLAS[@]}" -gt 0 ]; then
    fallar 4 "fallaron ${#FALLAS[@]} chequeo(s) posteriores al reinicio. Nada se deshizo solo; para volver atrás ver «Deshacer» en ops/vps/README.md."
  fi
  info "Todos los chequeos posteriores pasaron."
}

# --- flujo ---------------------------------------------------------------------------------------------------
main() {
  local necesita reinicio_s plan
  [ "$DRY" = 0 ] || info "Modo --dry-run: solo lecturas; no creo ni mergeo PR ni toco la VPS."
  fijar_cuenta_sevillanof || fallar 1 "no pude fijar la cuenta Sevillanof para gh (ver arriba); no sigo."
  info "gh con la cuenta Sevillanof (solo en este proceso; la cuenta global de gh no cambia)."

  asegurar_pr
  if [ -n "$PR" ]; then
    if [ "$DRY" = 1 ]; then
      simular "esperaría la CI del PR #$PR (hasta $((CI_MAX_SEG / 60)) min) y lo mergearía."
    else
      esperar_ci
      mergear_pr
    fi
  fi

  vps "true" >/dev/null || fallar 5 "no pude entrar por ssh a $VPS."
  info "VPS: ssh BatchMode a $VPS responde."
  if [ "$DRY" = 1 ]; then
    plan="reinicio de balancita dentro de :$VENTANA_DESDE-:$VENTANA_HASTA UTC y chequeos posteriores"
    [ "$SIN_REINICIO" = 0 ] || plan="sin reinicio (--sin-reinicio)"
    simular "en la VPS: git pull --ff-only; instalar los drop-ins distintos (los nuevos solo con --dropin); $plan."
    info "Fin del dry-run: no se cambió nada."
    return 0
  fi

  vps_pull
  vps_dropins
  necesita="$(vps_necesita_reinicio)"

  if [ "$SIN_REINICIO" = 1 ]; then
    if [ "$necesita" = "si" ]; then
      info "--sin-reinicio: balancita NO se reinició y queda pendiente (corré el script otra vez, sin esa opción, para reiniciar en la ventana :$VENTANA_DESDE-:$VENTANA_HASTA)."
    else
      info "--sin-reinicio: el servicio ya corre con el código y los drop-ins actuales."
    fi
    info "Despliegue terminado sin reinicio."
    return 0
  fi
  if [ "$necesita" != "si" ]; then
    info "balancita ya arrancó después del último commit y drop-in: no hace falta reiniciar."
    return 0
  fi
  esperar_ventana
  reinicio_s="$(date +%s)"
  info "Reinicio balancita (reinicia TODO el stack)."
  vps "systemctl restart balancita" >/dev/null || fallar 5 "systemctl restart balancita falló."
  chequeos_posteriores "$reinicio_s"
  info "Despliegue completo."
}

main
