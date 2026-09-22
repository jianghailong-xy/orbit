#!/usr/bin/env bash
# Build the tail-pinning × reasoning-fold probe, then relaunch it once per variant on an iOS 26
# simulator and collect what it wrote. Evidence only — nothing here is a gate, and none of it
# belongs on the delivered branch.
#
#   bash .ios-probe/run.sh [out-dir]
#
# The variant is passed through the environment; `simctl launch` only forwards those with the
# SIMCTL_CHILD_ prefix. The app writes the trace and a verdict into Documents and then a `done`
# marker, which is what this script waits on rather than a fixed sleep.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
BUNDLE=io.orbitd.probe
mkdir -p "$OUT"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

echo "== toolchain =="
xcodebuild -version
xcodegen --version

echo "== generate =="
cd "$HERE" && xcodegen generate || exit 1

echo "== build =="
# The log is kept whatever happens: a round that ends in "** BUILD FAILED **" alone is a round
# spent on nothing.
xcodebuild -project Probe.xcodeproj -scheme Probe -sdk iphonesimulator \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$HERE/.dd" build > "$OUT/build.log" 2>&1
BUILT=$?
if [ $BUILT -ne 0 ]; then tail -80 "$OUT/build.log"; exit 1; fi
tail -2 "$OUT/build.log"

echo "== simulator =="
xcrun simctl list runtimes | grep -i ios || true
# Newest iOS runtime first, then the preferred device (or any iPhone on it): the phase/geometry this
# probe reads is the platform's, and the owner's phone is on the newest iOS the runner can run.
xcrun simctl list devices available --json > "$OUT/devices.json" 2>/dev/null
UDID=$(SIM_NAME="${SIM_NAME:-iPhone 17 Pro}" python3 - "$OUT/devices.json" <<'PY'
import json, os, re, sys
devices = json.load(open(sys.argv[1]))["devices"]
def runtime_key(name):
    m = re.search(r"iOS[- ]?([0-9]+)(?:[.-]([0-9]+))?", name)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)
runtimes = sorted((n for n in devices if "iOS" in n), key=runtime_key, reverse=True)
want = os.environ.get("SIM_NAME", "")
for runtime in runtimes:
    avail = [d for d in devices[runtime] if d.get("isAvailable")]
    for d in avail:
        if want and d["name"] == want:
            print(d["udid"]); sys.exit(0)
for runtime in runtimes:
    for d in devices[runtime]:
        if d.get("isAvailable") and d["name"].startswith("iPhone"):
            print(d["udid"]); sys.exit(0)
sys.exit(1)
PY
)
if [ -z "${UDID:-}" ]; then
  echo "no available iPhone simulator; available:"
  xcrun simctl list devices available | sed -nE 's/^    ((iPhone|iPad)[^(]*) \(.*/  \1/p' | head -20
  exit 1
fi
echo "device: $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

APP="$HERE/.dd/Build/Products/Debug-iphonesimulator/OrbitProbe.app"
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
DOCS="$CONTAINER/Documents"

collect() {  # collect <variant> — pull what the app wrote, whatever happened
  local variant="$1"
  # Recomputed every time: `xcodebuild test` reinstalls the app, and the data container it ends up
  # with is not always the one `simctl install` left behind — reading the old path is how the first
  # swipe run produced a passing test and no trace at all.
  local container
  container=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data 2>/dev/null)
  if [ -n "$container" ]; then DOCS="$container/Documents"; fi
  local waited=0
  while [ ! -f "$DOCS/done" ] && [ "$waited" -lt 90 ]; do sleep 1; waited=$((waited + 1)); done
  if [ ! -f "$DOCS/done" ]; then
    echo "[$variant] no done marker after ${waited}s — collecting anyway"
  fi
  cp "$DOCS/report.txt" "$OUT/$variant.txt" 2>/dev/null || echo "[$variant] no report"
  cp "$DOCS/shot.png" "$OUT/$variant.png" 2>/dev/null || echo "[$variant] no screenshot"
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1
  sleep 1
}

run() {  # run <variant>
  local variant="$1"
  rm -f "$DOCS/done" "$DOCS/report.txt" "$DOCS/shot.png"

  if [ "$variant" = "swipe" ]; then
    # The gesture variant is driven by the UI test (only a test can synthesize a touch); the app
    # writes the same trace, and waits for the drag rather than for a fixed moment in it.
    xcodebuild test \
      -project "$HERE/Probe.xcodeproj" -scheme Probe \
      -destination "id=$UDID" -derivedDataPath "$HERE/.dd" \
      -only-testing:ProbeUITests \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
      > "$OUT/test-$variant.log" 2>&1
    local code=$?
    if [ $code -ne 0 ]; then echo "[$variant] xcodebuild test exited $code"; tail -30 "$OUT/test-$variant.log"; fi
    collect "$variant"
    return
  fi

  SIMCTL_CHILD_PROBE_VARIANT="$variant" \
    xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" > "$OUT/launch-$variant.log" 2>&1
  collect "$variant"
}

VARIANTS="${VARIANTS:-disclosure plain nofold jump swipe}"

echo "== run =="
for variant in $VARIANTS; do run "$variant"; done

echo "== verdict =="
# The conclusion, in the log rather than only in the artifact: the frames behind each line are in
# the matching .txt.
grep -H "^VERDICT" "$OUT"/*.txt 2>/dev/null | sed 's|'"$OUT"'/||'
echo "== gesture =="
grep -H "GESTURE\|PHASE" "$OUT"/swipe.txt 2>/dev/null | sed 's|'"$OUT"'/||' | head -40
echo "== fold frame =="
grep -H -A3 -B3 "FOLD issued" "$OUT"/*.txt 2>/dev/null | sed 's|'"$OUT"'/||' | head -80

echo "== files =="
ls -la "$OUT"/*.png "$OUT"/*.txt 2>/dev/null | sed 's|.*/||'
