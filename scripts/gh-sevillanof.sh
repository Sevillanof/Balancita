#!/usr/bin/env bash
# Corre `gh` con la cuenta Sevillanof SOLO para este proceso, sin tocar la cuenta global de gh
# (`gh auth switch` cambia el valor por defecto de toda la máquina; esto no).
#
# Uso:
#   scripts/gh-sevillanof.sh pr list --base main        # cualquier comando de gh
#   source scripts/gh-sevillanof.sh                     # solo exporta GH_TOKEN en el shell/script que lo carga
#                                                       # (lo usa ops/vps/desplegar.sh)
#
# Si la cuenta Sevillanof no está en gh o el token no la identifica, aborta sin correr nada.
# El token nunca se imprime.

CUENTA_GH="${CUENTA_GH:-Sevillanof}"

fijar_cuenta_sevillanof() {
  local token login
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh-sevillanof: no encuentro el comando gh en el PATH." >&2
    return 1
  fi
  if ! token="$(gh auth token -u "$CUENTA_GH" 2>/dev/null)" || [ -z "$token" ]; then
    echo "gh-sevillanof: gh no tiene guardada la cuenta $CUENTA_GH (probá: gh auth login)." >&2
    return 1
  fi
  export GH_TOKEN="$token"
  if ! login="$(gh api user -q .login 2>/dev/null)"; then
    unset GH_TOKEN
    echo "gh-sevillanof: el token de $CUENTA_GH no sirvió contra la API de GitHub (¿vencido? probá: gh auth login)." >&2
    return 1
  fi
  if [ "$login" != "$CUENTA_GH" ]; then
    unset GH_TOKEN
    echo "gh-sevillanof: la cuenta activa es '$login' y tiene que ser '$CUENTA_GH'. No sigo." >&2
    return 1
  fi
}

# Ejecutado (no cargado con `source`): fija la cuenta y reenvía los argumentos a gh.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  fijar_cuenta_sevillanof || exit 1
  exec gh "$@"
fi
