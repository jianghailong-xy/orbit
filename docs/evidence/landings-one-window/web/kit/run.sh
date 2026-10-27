#!/bin/bash
# Builds this worktree's web app and shoots the Landings window frames of
# docs/mocks/landings-one-window (b, d, e, f, g) inside a private network namespace (docker veths
# coming and going abort chunk loads with ERR_NETWORK_CHANGED on this host). Copied in shape from
# docs/evidence/landing-entries-web/kit/run.sh.
#
#   bash docs/evidence/landings-one-window/web/kit/run.sh [outDir]
#
# The dist is built into /var/tmp/lw-shots/dist so nothing built is committed. Frames are written as
# <outDir>/<theme>-<frame>.png plus report.json.
set -euo pipefail
WT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
mkdir -p "$OUT" /var/tmp/lw-shots
cd "$WT/src/web"
npx vite build --outDir /var/tmp/lw-shots/dist --emptyOutDir >/var/tmp/lw-shots/build.log 2>&1
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  "ip link set lo up && cd '$WT/docs/evidence/landings-one-window/web/kit' && WT='$WT' DIST=/var/tmp/lw-shots/dist FRAMES_ONLY='${FRAMES_ONLY:-}' node capture.mjs '$OUT'"
