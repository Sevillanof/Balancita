#!/bin/bash
# Instala (o actualiza) la exportacion nocturna a Parquet en esta Mac. Idempotente, sin sudo. Un solo comando:
#   bash ops/launchd/instalar-archivo-parquet.sh
# Hace: venv fuera del repo con pyarrow (hashes), plist con rutas absolutas, launchctl, y una corrida de prueba --dry-run.
# Recarga el agente existente (bootout + bootstrap) para que tome la plantilla nueva.
# NO enciende el borrado de SQLite (FUTURES_ARCHIVE_DELETE): eso es aparte y esta apagado.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${ARCHIVO_VENV:-$HOME/.venvs/archivo-parquet}"
DESTINO="${BALANCITA_ARCHIVO_DESTINO:-$HOME/balancita-data.noindex/archivo-parquet}"
RESPALDOS="${BALANCITA_RESPALDOS_DIR:-$REPO/server/data/backups}"
LABEL="com.balancita.archivo-parquet"
PLIST="${ARCHIVO_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
PLANTILLA="$REPO/ops/launchd/$LABEL.plist"
SIN_LAUNCHCTL="${ARCHIVO_SIN_LAUNCHCTL:-0}" # 1 = no llama a launchctl (pruebas)

if [ "$(id -u)" = "0" ] && [ "$SIN_LAUNCHCTL" != "1" ]; then echo "No uses sudo: es un agente de tu usuario." >&2; exit 2; fi
if [ "$SIN_LAUNCHCTL" != "1" ] && [ "$(uname)" != "Darwin" ]; then echo "Esto es para macOS (launchd)." >&2; exit 2; fi
command -v uv >/dev/null 2>&1 || { echo "Falta 'uv' (https://docs.astral.sh/uv/). Instalalo y repeti el comando." >&2; exit 2; }

echo "1/4 entorno Python en $VENV"
[ -x "$VENV/bin/python" ] || uv venv "$VENV"
uv pip install --python "$VENV/bin/python" --require-hashes -r "$REPO/python/archivo_parquet/requisitos.txt"
"$VENV/bin/python" -c "import pyarrow; print('pyarrow', pyarrow.__version__)"

echo "2/4 carpetas"
mkdir -p "$DESTINO" "$(dirname "$PLIST")"

echo "3/4 plist en $PLIST"
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/[&|\\]/\\&/g'; }
NUEVO="$(mktemp)"
sed -e "s|__REPO__|$(esc "$REPO")|g" -e "s|__PYTHON__|$(esc "$VENV/bin/python")|g" \
    -e "s|__DESTINO__|$(esc "$DESTINO")|g" -e "s|__RESPALDOS__|$(esc "$RESPALDOS")|g" "$PLANTILLA" >"$NUEVO"
if ! cmp -s "$NUEVO" "$PLIST" 2>/dev/null; then mv "$NUEVO" "$PLIST"; else rm -f "$NUEVO"; fi
if [ "$SIN_LAUNCHCTL" != "1" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "   cargado: $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo si || echo 'no se pudo confirmar')"
fi

echo "4/4 corrida de prueba (--dry-run: no escribe nada)"
set +e
(cd "$REPO/python" && PYTHONPATH="$REPO/python" "$VENV/bin/python" -m archivo_parquet nocturno --dry-run --destino "$DESTINO" --respaldos "$RESPALDOS")
CODIGO=$?
set -e
echo
case "$CODIGO" in
  0|3) echo "Listo. Se exporta cada noche a las 04:30 (hora de la Mac; si estaba dormida, espera 10 min tras despertar, y se reintenta cada hora) en $DESTINO. Resumen de cada corrida: $DESTINO/nocturno.jsonl" ;;
  *) echo "La prueba salio con codigo $CODIGO: revisa el mensaje de arriba. El agente quedo instalado." >&2; exit "$CODIGO" ;;
esac
