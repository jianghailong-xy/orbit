#!/bin/bash
# Shoots the board's frames inside a private network namespace (docker veths coming and going abort
# chunk loads with ERR_NETWORK_CHANGED on this host), with Inter + Noto Sans SC.
#   bash run.sh <outDir> [scene,scene]
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$KIT/out}"
mkdir -p "$OUT"
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  "ip link set lo up && cd '$KIT' && node capture.mjs '$OUT' '${2:-}'"
