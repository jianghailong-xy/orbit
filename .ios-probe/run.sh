#!/usr/bin/env bash
# Build the probe app and photograph the landing row on an iOS simulator.
#
# Run from the repo root on a Mac runner: `bash .ios-probe/run.sh`. Keeps its build log on failure
# (a bare `** BUILD FAILED **` in CI is a wasted round), picks the newest iOS runtime's iPhone, and
# exits non-zero if no PNG came out — a probe that shot nothing must not be green.
set -uo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-$PWD/out}"
BUNDLE=io.orbitd.landingprobe
mkdir -p "$OUT"
rm -f "$OUT"/*.png

echo "== toolchain"; swift --version; xcodegen --version
echo "== generate"
xcodegen generate > gen.log 2>&1 || { echo "xcodegen failed"; tail -40 gen.log; exit 1; }

echo "== build"
xcodebuild -project LandingProbe.xcodeproj -scheme LandingProbe -sdk iphonesimulator \
  -configuration Debug -derivedDataPath .dd build > build.log 2>&1 \
  || { echo "build failed"; tail -80 build.log; exit 1; }

echo "== runtimes"
xcrun simctl list runtimes

echo "== device"
xcrun simctl list devices available -j > devices.json
UDID=$(python3 - <<'PY'
import json
devices = json.load(open('devices.json'))['devices']
best = None
for runtime, rows in devices.items():
    if 'iOS' not in runtime:
        continue
    version = tuple(int(p) for p in runtime.split('iOS-')[-1].split('-') if p.isdigit())
    for row in rows:
        if not row.get('isAvailable') or not row['name'].startswith('iPhone'):
            continue
        # The newest runtime, and a Pro class device within it — the same shape of device the
        # owner's reports come from.
        key = (version, 'Pro' in row['name'], row['name'])
        if best is None or key > best[0]:
            best = (key, row['udid'], row['name'], runtime)
print(best[1] if best else '')
PY
)
[ -n "$UDID" ] || { echo "no iPhone simulator available"; exit 1; }
echo "udid=$UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b > /dev/null 2>&1 || true
xcrun simctl install "$UDID" .dd/Build/Products/Debug-iphonesimulator/LandingProbe.app \
  || { echo "install failed"; exit 1; }

failed=0
for CASE in checking queued multi untitled none; do
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  SIMCTL_CHILD_PROBE_CASE="$CASE" xcrun simctl launch "$UDID" "$BUNDLE" > "launch-$CASE.log" 2>&1 \
    || { echo "!! launch failed for $CASE"; cat "launch-$CASE.log"; failed=1; continue; }
  sleep 6
  # A screenshot is worthless if the app is not the thing on screen: a probe that crashed at launch
  # leaves the home screen, and five shots of the home screen look like five shots of something.
  # The first version of this script did exactly that and was green.
  if ! xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "$BUNDLE"; then
    echo "!! $CASE: the app is not running — it exited after launch"
    grep -l "$BUNDLE" ~/Library/Logs/DiagnosticReports/*.ips 2>/dev/null | tail -2 | while read -r f; do
      echo "---- $f"; head -40 "$f"
    done
    failed=1
  fi
  xcrun simctl io "$UDID" screenshot "$OUT/landing-$CASE.png" 2>&1 | tail -1
  echo "shot $CASE"
done

# The launch logs and any crash report travel with the shots: the next round is read, not guessed.
cp launch-*.log "$OUT/" 2>/dev/null || true
ls ~/Library/Logs/DiagnosticReports/LandingProbe*.ips > /dev/null 2>&1 \
  && cp ~/Library/Logs/DiagnosticReports/LandingProbe*.ips "$OUT/" 2>/dev/null
ls "$OUT"/*.png || { echo "no screenshots were taken"; exit 1; }
[ "$failed" = "0" ] || { echo "!! at least one case did not render"; exit 1; }
