#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md), task ⑥. Build the app's real closing cards — and the
# card chrome they are drawn in, cut out of the real files — into a throwaway Mac app, and capture
# each state in a real window.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT"
mkdir -p "$OUT"

APP=../../src/macos/OrbitApp/Sources/OrbitApp
SRC=Sources/DoneProbe
# Copied at run time, never kept here: the probe draws whatever this commit ships.
cp "$APP/Views/ProjectDoneCards.swift" "$APP/Views/Typography.swift" "$APP/Platform.swift" "$SRC/" || exit 1
python3 extract.py "$APP" "$SRC" || exit 1

echo "==> building"
if ! swift build > "$OUT/build.log" 2>&1; then
  echo "==> build failed:"
  grep -E "error:" "$OUT/build.log" | head -40
  tail -60 "$OUT/build.log"
  exit 1
fi
BIN="$(swift build --show-bin-path)/DoneProbe"

for appearance in light dark; do
  echo "==> $appearance"
  "$BIN" "$appearance" "$OUT" || echo "    probe exited $?"
done

echo "==> shots:"
ls -la "$OUT"
ls "$OUT"/*.png > /dev/null 2>&1 || { echo "==> no captures"; exit 1; }
