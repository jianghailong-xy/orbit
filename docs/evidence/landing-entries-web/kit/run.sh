#!/bin/bash
# Builds this worktree's web app and shoots the landing-entry frames of docs/mocks/landing-session/
# v4/04 and 06, inside a private network namespace (docker veths coming and going abort chunk loads
# with ERR_NETWORK_CHANGED on this host, and the page then sits on its boot splash).
#
#   bash docs/evidence/landing-entries-web/kit/run.sh [outDir]
#
# The dist is built into /var/tmp/le-shots/dist so nothing built is committed. Frames are written as
# <outDir>/<theme>-<frame>.png plus report.json; copy them where the evidence keeps them.
set -euo pipefail
WT="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="${1:-$(dirname "$0")/../web}"
mkdir -p "$OUT" /var/tmp/le-shots
cd "$WT/src/web"
npx vite build --outDir /var/tmp/le-shots/dist --emptyOutDir >/var/tmp/le-shots/build.log 2>&1
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  "ip link set lo up && cd '$WT/docs/evidence/landing-entries-web/kit' && WT='$WT' node capture.mjs '$OUT'"
