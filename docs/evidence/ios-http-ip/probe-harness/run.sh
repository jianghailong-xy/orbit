#!/usr/bin/env bash
# Builds the probe app twice against the same local HTTP server and reads back what the URLSession
# request to http://<host-ip>:<port>/ did each time:
#
#   shipped — INFOPLIST_FILE is src/ios/Support/Info.plist, the file the iPhone build ships
#   control — the same app with no NSAppTransportSecurity dictionary (what it carried before)
#
# Expected on iOS 17+: control fails with NSURLErrorDomain -1022 (ATS), shipped answers 200. The
# run exits non-zero when either arm says anything else, so a silent ATS regression fails the job.
# docs/evidence/ios-http-ip/README.md.
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8099}"
OUT="$PWD/results"
rm -rf "$OUT" .dd-shipped .dd-control
mkdir -p "$OUT"

fail() { echo "!! $*" >&2; exit 1; }

# 1. The server, on every interface, reached by IP the way a self-hosted Orbit is.
( cd "$OUT" && exec python3 -m http.server "$PORT" --bind 0.0.0.0 > server.log 2>&1 ) &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

HOST_IP=""
for iface in en0 en1; do
  HOST_IP=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  [ -n "$HOST_IP" ] && break
done
[ -n "$HOST_IP" ] || fail "no en0/en1 address, so the app has no IP to ask for"
PROBE_URL="http://$HOST_IP:$PORT/"
echo "==> probe url $PROBE_URL"

code=""
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$PROBE_URL" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || fail "the host itself could not fetch $PROBE_URL (HTTP ${code:-none})"
echo "==> host fetch HTTP $code"

# 2. The newest iPhone simulator.
UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPhone" in x["name"]:
            k=(v,("Pro" in x["name"])*2-("Max" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"])
print(best[1] if best else "")')
[ -n "$UDID" ] || fail "no available iPhone simulator"
echo "==> simulator $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

xcodegen generate >/dev/null || fail "xcodegen generate"

# 3. One arm of the A/B: build, keep the ATS block that actually landed in the .app, install, run.
run_arm() { # name [plist-override]
  local name="$1" plist="${2:-}" extra=()
  [ -n "$plist" ] && extra=(INFOPLIST_FILE="$plist")
  echo "==> $name: build"
  if ! xcodebuild build -project ATSProbe.xcodeproj -scheme ATSProbe \
      -destination "id=$UDID" -derivedDataPath ".dd-$name" -configuration Debug \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO "${extra[@]}" \
      > "$OUT/build-$name.log" 2>&1; then
    tail -40 "$OUT/build-$name.log" >&2
    return 1
  fi
  local app=".dd-$name/Build/Products/Debug-iphonesimulator/ATSProbe.app"
  { echo "== $name app Info.plist =="
    plutil -p "$app/Info.plist" 2>/dev/null | sed -n '/NSAppTransportSecurity/,/^  }/p'
  } > "$OUT/app-ats-$name.txt"
  xcrun simctl uninstall "$UDID" io.orbitd.atsprobe >/dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$app" || return 1
  echo "==> $name: launch"
  SIMCTL_CHILD_PROBE_URL="$PROBE_URL" xcrun simctl launch --console "$UDID" io.orbitd.atsprobe \
    > "$OUT/console-$name.log" 2>&1 || true
  grep -m1 '^PROBE ' "$OUT/console-$name.log" > "$OUT/$name.txt" || echo "PROBE result=missing" > "$OUT/$name.txt"
  cat "$OUT/$name.txt"
}

run_arm shipped || fail "the shipped arm's build/run did not finish"
run_arm control "$PWD/InfoControl.plist" || fail "the control arm's build/run did not finish"

SHIPPED=$(cat "$OUT/shipped.txt")
CONTROL=$(cat "$OUT/control.txt")
STATUS=0
case "$SHIPPED" in
  "PROBE result=ok status=200"*) : ;;
  *) echo "!! shipped arm did not reach $PROBE_URL: $SHIPPED" >&2; STATUS=1 ;;
esac
case "$CONTROL" in
  *code=-1022*) : ;;
  *) echo "!! control arm was not blocked by ATS (-1022): $CONTROL" >&2; STATUS=1 ;;
esac
{ echo "url: $PROBE_URL"
  echo "shipped (src/ios/Support/Info.plist): $SHIPPED"
  echo "control (no ATS dictionary):          $CONTROL"
} | tee "$OUT/summary.txt"
exit $STATUS
