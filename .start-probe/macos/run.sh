#!/usr/bin/env bash
# TEMPORARY evidence probe (see ../README.md). Build the same cards (cut out of the real files by gen.py)
# into a macOS executable and photograph each conversation in a real window.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" Sources/StartProbeMac/Generated Sources/StartProbeMac/shared
mkdir -p "$OUT"
python3 ../gen.py ../.. Sources/StartProbeMac/Generated
cp -R ../shared Sources/StartProbeMac/shared

STATUS=0
swift build > build.log 2>&1 || STATUS=$?
tail -30 build.log
cp build.log "$OUT/swift-build.log"
[ "$STATUS" -eq 0 ] || { grep -E "error:" build.log | head -40; exit "$STATUS"; }
BIN="$(swift build --show-bin-path)/StartProbeMac"
for args in "-screen start" "-screen start -bottom" "-screen start-nocheck -bottom" \
            "-screen change" "-screen started" "-screen confirmed" "-screen start -dark"; do
  echo "==> $args"
  # shellcheck disable=SC2086
  SHOTS_DIR="$OUT" "$BIN" $args &
  pid=$!
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || echo "exited $?"
done
echo "==> shots:"
ls -la "$OUT"
ls "$OUT"/*.png > /dev/null 2>&1 || { echo "==> no captures"; exit 1; }
