#!/usr/bin/env bash
# Build the transcript-List scroll crash probe once, then launch it once per run entry on an iOS 26
# iPhone simulator and collect what each run wrote. Evidence only.
#
#   RUNS="scenario:mode:fix:seed ..." bash .crash-probe/run.sh [out-dir]
#
#   scenario  cold warm overcap trim resync record history switch swap fuzz press (see FakeConsole.swift)
#   mode      count = log + skip an out-of-bounds scroll (counts them all); crash = let it abort
#   fix       none = as shipped in v0.1.2-beta.142; defer / route = candidate fixes (see Transcript.swift)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
BUNDLE=io.orbitd.crashprobe
mkdir -p "$OUT"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

# macOS ships no `timeout`; a portable watchdog instead.
with_limit() {  # with_limit <seconds> <cmd...>
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid"
  local rc=$?
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
}

echo "== toolchain =="
xcodebuild -version
xcodegen --version

echo "== generate =="
cd "$HERE" && xcodegen generate || exit 1

echo "== build =="
with_limit 1500 xcodebuild -project CrashProbe.xcodeproj -scheme CrashProbe -configuration Release \
  -sdk iphonesimulator -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$HERE/.dd" build > "$OUT/build.log" 2>&1
if [ $? -ne 0 ]; then grep -E "error:|warning: unre" "$OUT/build.log" | head -60; tail -40 "$OUT/build.log"; exit 1; fi
tail -2 "$OUT/build.log"

echo "== simulator =="
xcrun simctl list runtimes | grep -i ios || true
xcrun simctl list devices available --json > "$OUT/devices.json" 2>/dev/null
# The newest iOS 26.x runtime (the tester is on 26.6.1), else the newest there is; a 440pt-wide
# iPhone (the tester's iPhone17,2 is 440x956) where there is one.
UDID=$(python3 - "$OUT/devices.json" <<'PY'
import json, re, sys
devices = json.load(open(sys.argv[1]))["devices"]
def key(name):
    m = re.search(r"iOS[- ]?([0-9]+)(?:[.-]([0-9]+))?", name)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)
runtimes = sorted((n for n in devices if "iOS" in n), key=key, reverse=True)
runtimes = [r for r in runtimes if key(r)[0] == 26] + [r for r in runtimes if key(r)[0] != 26]
for want in ("iPhone 17 Pro Max", "iPhone 16 Pro Max", "iPhone Air", "iPhone 17 Pro"):
    for rt in runtimes:
        for d in devices[rt]:
            if d.get("isAvailable") and d["name"] == want:
                print(d["udid"]); print(want + " / " + rt, file=sys.stderr); sys.exit(0)
for rt in runtimes:
    for d in devices[rt]:
        if d.get("isAvailable") and d["name"].startswith("iPhone"):
            print(d["udid"]); print(d["name"] + " / " + rt, file=sys.stderr); sys.exit(0)
sys.exit(1)
PY
)
if [ -z "${UDID:-}" ]; then echo "no iPhone simulator"; exit 1; fi
echo "device: $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
with_limit 300 xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

APP="$HERE/.dd/Build/Products/Release-iphonesimulator/CrashProbe.app"
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

REPORTS="$HOME/Library/Logs/DiagnosticReports"
mkdir -p "$REPORTS"

run() {  # run <scenario> <mode> <fix> <seed>
  local scenario="$1" mode="$2" fix="$3" seed="$4"
  local name="$scenario-$mode-$fix-$seed"
  local seconds=14
  case "$scenario" in fuzz|press) seconds=25 ;; esac
  local container docs
  container=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data 2>/dev/null)
  docs="$container/Documents"
  rm -f "$docs/done" "$docs/trace.txt"
  touch "$OUT/.mark"
  echo "-- $name"
  SIMCTL_CHILD_PROBE_SCENARIO="$scenario" SIMCTL_CHILD_PROBE_MODE="$mode" \
  SIMCTL_CHILD_PROBE_FIX="$fix" SIMCTL_CHILD_PROBE_SEED="$seed" SIMCTL_CHILD_PROBE_SECONDS="$seconds" \
    with_limit $((seconds + 45)) xcrun simctl launch --console-pty --terminate-running-process \
      "$UDID" "$BUNDLE" > "$OUT/console-$name.log" 2>&1
  local rc=$?
  sleep 1
  cp "$docs/trace.txt" "$OUT/$name.txt" 2>/dev/null || echo "[$name] no trace"
  local verdict
  verdict=$(grep -h "VERDICT" "$OUT/$name.txt" 2>/dev/null | tail -1)
  [ -z "$verdict" ] && verdict="VERDICT NONE (launch rc=$rc; app died without a word — see console log)"
  echo "   $verdict"
  grep -h "EXCEPTION" "$OUT/$name.txt" 2>/dev/null | head -2 | sed 's/^/   /'
  # A simulator app's crash report lands on the host.
  find "$REPORTS" -newer "$OUT/.mark" -name 'CrashProbe*' -exec cp {} "$OUT/" \; 2>/dev/null
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1
  sleep 1
}

DEFAULT_RUNS="press:count:none:1 press:count:none:2 press:count:none:3 press:count:none:4 \
press:crash:none:5 \
press:count:route:1 press:count:route:2 press:count:route:3 press:count:route:4 \
fuzz:count:route:1 fuzz:count:route:2 fuzz:count:route:3 fuzz:count:route:4 \
overcap:count:route:1 history:count:route:1 record:count:route:1 switch:count:route:1 \
swap:count:route:1 trim:count:route:1 resync:count:route:1 cold:count:route:1"
RUNS="${RUNS:-$DEFAULT_RUNS}"

echo "== run =="
for entry in $RUNS; do
  IFS=: read -r scenario mode fix seed <<< "$entry"
  run "$scenario" "${mode:-count}" "${fix:-none}" "${seed:-1}"
done

echo "== verdicts =="
grep -h "VERDICT" "$OUT"/*.txt 2>/dev/null
echo "== exceptions =="
grep -h "EXCEPTION" "$OUT"/*.txt 2>/dev/null | sort | uniq -c | head -20
echo "== first out-of-bounds per run, with the 14 lines before it =="
for f in "$OUT"/*.txt; do
  if grep -q "OUT-OF-BOUNDS" "$f"; then
    echo "### $(basename "$f")"
    grep -m1 -B14 -A1 "OUT-OF-BOUNDS" "$f"
  fi
done
echo "== files =="
ls -la "$OUT" | head -80
