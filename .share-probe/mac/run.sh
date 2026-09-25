#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Build the app's real ShareSheet — and ConsoleView's
# macOS share entry, cut out of the real file — into a throwaway Mac app, point it at the stub
# server, and capture the window and its sheet for an unshared and a shared session.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT"
mkdir -p "$OUT"

APP=../../src/macos/OrbitApp/Sources/OrbitApp
SRC=Sources/ShareProbe
# Copied at run time, never kept here: the probe draws whatever this commit ships.
cp "$APP/Views/ShareSheet.swift" "$APP/Platform.swift" "$SRC/"
python3 extract.py "$APP/Views/Console/ConsoleView.swift" SessionPageStandIn.swift.in > "$SRC/SessionPageStandIn.swift"
echo "==> generated $SRC/SessionPageStandIn.swift:"
cat "$SRC/SessionPageStandIn.swift"
cp "$SRC/SessionPageStandIn.swift" "$OUT/"

python3 stub_server.py > "$OUT/stub.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

echo "==> building"
if ! swift build > build.log 2>&1; then
  echo "==> build failed; last 80 lines:"
  tail -80 build.log
  exit 1
fi
BIN="$(swift build --show-bin-path)/ShareProbe"

for session in new live; do
  echo "==> $session"
  "$BIN" "$session" "$OUT" || echo "    probe exited $?"
done

echo "==> stub log:"
cat "$OUT/stub.log"
echo "==> shots:"
ls -la "$OUT"
ls "$OUT"/*.png > /dev/null 2>&1 || { echo "==> no captures"; exit 1; }
