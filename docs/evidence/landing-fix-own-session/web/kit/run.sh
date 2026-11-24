#!/bin/bash
# Builds this worktree's web app and shoots the screens the owner ruled on docs/mocks/landing-fix-own-session (web a–e),
# light and dark, inside a private network namespace (docker veths coming and going abort chunk loads with
# ERR_NETWORK_CHANGED on this host). Adapted from docs/evidence/landings-chat-bubbles/web/kit/run.sh.
#
#   bash docs/evidence/landing-fix-own-session/web/kit/run.sh [outDir]
#   SCENES_ONLY=a1-session-card THEMES=light bash docs/evidence/landing-fix-own-session/web/kit/run.sh [outDir]
#
# Needs the worktree's node_modules (scripts/worktree-overlay.sh) and @orbit/shared's dist. The dist is built into
# /tmp/lfos-web-shots/dist so nothing built is committed. Fonts: Inter, JetBrains Mono and Noto Sans SC from
# /var/tmp/landing-mock-render/fonts, the board's own render fonts, when that directory exists.
set -euo pipefail
WT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/out}"
SCRATCH=/tmp/lfos-web-shots
mkdir -p "$OUT" "$SCRATCH"
FONTS_ENV=""
if [ -d /var/tmp/landing-mock-render/fonts ]; then
  cat > "$SCRATCH/fonts.conf" <<CONF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>/var/tmp/landing-mock-render/fonts</dir><include ignore_missing="yes">/etc/fonts/fonts.conf</include><cachedir>$SCRATCH/fc-cache</cachedir></fontconfig>
CONF
  FONTS_ENV="FONTCONFIG_FILE=$SCRATCH/fonts.conf"
fi
cd "$WT/src/web"
npx vite build --outDir "$SCRATCH/dist" --emptyOutDir >"$SCRATCH/build.txt" 2>&1
env $FONTS_ENV unshare -n bash -c \
  "ip link set lo up && cd '$WT/docs/evidence/landing-fix-own-session/web/kit' && WT='$WT' DIST='$SCRATCH/dist' SCENES_ONLY='${SCENES_ONLY:-}' THEMES='${THEMES:-light,dark}' node capture.mjs '$OUT'"
