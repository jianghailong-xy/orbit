#!/usr/bin/env bash
# TEMPORARY evidence probe (P1-03). Build the app's real AgentToolsSheet into a throwaway Mac app and
# capture it for a connected Claude session, a Codex session whose server failed, and a workspace.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT"
mkdir -p "$OUT"
APP=../../src/macos/OrbitApp/Sources/OrbitApp
SRC=Sources/AgentToolsProbe
# Copied at run time, never kept here: the probe draws whatever this commit ships.
for f in ${PROBE_COPY:-Views/AgentToolsSheet.swift Views/Typography.swift}; do cp "$APP/$f" "$SRC/"; done
echo "==> building"
if ! swift build > build.log 2>&1; then
  echo "==> build failed; last 120 lines:"
  tail -120 build.log
  exit 1
fi
BIN="$(swift build --show-bin-path)/AgentToolsProbe"
for variant in connected failed workspace; do
  echo "==> $variant"
  "$BIN" "$variant" "$OUT" || echo "    probe exited $?"
done
ls -la "$OUT"
ls "$OUT"/*.png > /dev/null 2>&1 || { echo "==> no captures"; exit 1; }
