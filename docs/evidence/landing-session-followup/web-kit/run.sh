#!/bin/bash
# Builds this worktree's web app and shoots the landing-session follow-up frames (task
# 34jBwFmcEPK012TsNL0Lc) inside a private network namespace (docker veths coming and going abort
# chunk loads with ERR_NETWORK_CHANGED on this host, and the page then sits on its boot splash).
#
#   bash docs/evidence/landing-session-followup/web-kit/run.sh <outDir>
#
# The dist is built into /var/tmp/lsf-shots/dist so nothing built is committed. Frames are written as
# <outDir>/entries/<theme>-<frame>.png and <outDir>/landing/<theme>-<frame>.png, each with report.json.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$KIT/../../../.." && pwd)"
OUT="${1:?outDir}"
mkdir -p "$OUT/entries" "$OUT/landing" /var/tmp/lsf-shots
cd "$WT/src/web"
npx vite build --outDir /var/tmp/lsf-shots/dist --emptyOutDir >/var/tmp/lsf-shots/build.log 2>&1
FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf unshare -n bash -c \
  "ip link set lo up && cd '$KIT' && WT='$WT' node capture-entries.mjs '$OUT/entries' && WT='$WT' node capture-landing.mjs '$OUT/landing'"
