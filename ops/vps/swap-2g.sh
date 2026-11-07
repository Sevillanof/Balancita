#!/bin/bash
# Swap de 2 GB de red de seguridad + vm.swappiness=10 (paso 2 de T8, odd/tasks/noticias-y-auditor.md).
# No acelera Qwen: evita que un pico de RAM (como el needrestart del 6-nov) mate procesos de la app.
# Idempotente: se puede correr varias veces. Como root en el VPS; NO se corre desde el repo en otra máquina.
#   Opciones por entorno: SWAPFILE (default /swapfile), SWAP_SIZE (default 2G), SWAPPINESS (default 10).
set -euo pipefail

SWAPFILE=${SWAPFILE:-/swapfile}
SWAP_SIZE=${SWAP_SIZE:-2G}
SWAPPINESS=${SWAPPINESS:-10}
FSTAB=${FSTAB:-/etc/fstab}
SYSCTL_FILE=${SYSCTL_FILE:-/etc/sysctl.d/99-balancita.conf}

if [[ $(id -u) -ne 0 ]]; then
  echo "swap-2g.sh: hay que correrlo como root" >&2
  exit 1
fi

# 1. El archivo: solo si falta (si ya existe no se toca: puede estar en uso).
if [[ ! -e $SWAPFILE ]]; then
  fallocate -l "$SWAP_SIZE" "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$(( $(numfmt --from=iec "$SWAP_SIZE") / 1048576 ))
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  echo "creado $SWAPFILE ($SWAP_SIZE)"
else
  chmod 600 "$SWAPFILE"
  echo "ya existe $SWAPFILE: no se vuelve a crear"
fi

# 2. Activarlo si todavía no está activo.
if ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  # Un archivo que existía pero sin firma de swap (corrida cortada a medias) se formatea acá.
  blkid -p "$SWAPFILE" >/dev/null 2>&1 || mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
  echo "activado $SWAPFILE"
else
  echo "$SWAPFILE ya está activo"
fi

# 3. fstab: una sola línea.
if ! grep -qE "^[[:space:]]*$SWAPFILE[[:space:]]+none[[:space:]]+swap[[:space:]]" "$FSTAB"; then
  echo "$SWAPFILE none swap sw 0 0" >> "$FSTAB"
  echo "línea agregada a $FSTAB"
else
  echo "$FSTAB ya tiene la línea de $SWAPFILE"
fi

# 4. swappiness: ahora y persistido (el archivo se reescribe entero: nunca queda duplicado).
sysctl -w "vm.swappiness=$SWAPPINESS" >/dev/null
printf '# Balancita: usar swap solo como red de seguridad (ops/vps/swap-2g.sh)\nvm.swappiness=%s\n' "$SWAPPINESS" > "$SYSCTL_FILE"
echo "vm.swappiness=$SWAPPINESS (persistido en $SYSCTL_FILE)"

swapon --show
free -h
