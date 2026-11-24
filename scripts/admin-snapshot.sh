#!/bin/sh
# Baja los datos de la consola de admin a una carpeta, para armar o refrescar el dashboard.
# Uso: ADMIN_API_KEY=... scripts/admin-snapshot.sh <carpeta>   (la clave está en 1Password, item Chambeano)
set -eu
out="${1:?carpeta de salida}"
base="${CHAMBEANDO_URL:-https://chambeando.urcalab.com}"
mkdir -p "$out"
for p in "overview?days=30" sources "users?limit=1000" "runs?limit=168" "log?limit=2000"; do
  curl -fsS -m 60 -H "Authorization: Bearer $ADMIN_API_KEY" "$base/admin/$p" -o "$out/$(echo "$p" | cut -d'?' -f1).json"
done
echo "datos en $out"
