#!/bin/bash
# Builds this worktree's web app and shoots the Landings window drawn as a chat (owner 2026-11-02,
# option C, docs/mocks/landings-chat-bubbles), frames a–e, light and dark, inside a private network
# namespace (docker veths coming and going abort chunk loads with ERR_NETWORK_CHANGED on this host).
# Adapted from docs/evidence/landings-one-window/web/kit/run.sh.
#
#   bash docs/evidence/landings-chat-bubbles/web/kit/run.sh [outDir]
#   FRAMES_ONLY=c-open,d-menu THEMES=dark bash docs/evidence/landings-chat-bubbles/web/kit/run.sh [outDir]
#
# Needs `npm ci` at the repo root and `npm run build -w @orbit/shared` (the fixtures import its dist).
# The dist is built into /tmp/lcb-web-shots/dist so nothing built is committed; delete that directory
# when done. Frames are written as <outDir>/<theme>-<frame>.png plus report.json.
set -euo pipefail
WT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRATCH=/tmp/lcb-web-shots
mkdir -p "$OUT" "$SCRATCH"
cd "$WT/src/web"
npx vite build --outDir "$SCRATCH/dist" --emptyOutDir >"$SCRATCH/build.txt" 2>&1
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  "ip link set lo up && cd '$WT/docs/evidence/landings-chat-bubbles/web/kit' && WT='$WT' DIST='$SCRATCH/dist' FRAMES_ONLY='${FRAMES_ONLY:-}' THEMES='${THEMES:-light,dark}' node capture.mjs '$OUT'"
