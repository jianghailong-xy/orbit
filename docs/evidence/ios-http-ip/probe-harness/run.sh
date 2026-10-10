#!/usr/bin/env bash
# Builds the probe app twice and asks each build several URLs, to answer one question with what the
# OS actually did rather than what its documentation says: may an app carrying
# src/ios/Support/Info.plist's ATS block reach a self-hosted server over plain http?
#
#   shipped  — INFOPLIST_FILE is src/ios/Support/Info.plist, the file the iPhone build ships
#   control  — the same app with no NSAppTransportSecurity dictionary (what it carried before)
#
# The arms (one launch each; the two builds are reused):
#
#   shipped         http://<host-ip>:<port>/   the case this probe exists for: a server reached by
#                                              IP on the machine the app runs on
#   control         same URL, no ATS keys      what the documented iOS 17 rule would refuse
#   control-named   http://neverssl.com/       ATS must refuse a *named* host over http — the arm
#                                              that proves this environment enforces ATS at all
#   shipped-named   same URL, shipped keys     NSAllowsArbitraryLoads doing what it says
#   control-public  http://1.1.1.1/            an IP literal that is not this machine
#   shipped-public  same URL, shipped keys
#
# Asserted: the three shipped arms answer, and control-named is refused with
# NSURLErrorDomain -1022. Reported, not asserted: the two control arms over IP literals — an OS that
# no longer refuses them (measured: iOS 26 simulator) answers 200, and that reading is the finding,
# not a failure. docs/evidence/ios-http-ip/README.md.
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
xcrun simctl list devices | grep "$UDID" | sed 's/^ *//' || true

xcodegen generate >/dev/null || fail "xcodegen generate"

# 3. One build per plist. Each arm names its plist on the command line rather than relying on the
# project's setting, so an arm cannot quietly run against the other one's file — and no empty array
# is ever expanded, which bash 3.2 (the runner's /bin/bash) reads as unbound under `set -u`.
build_variant() { # variant plist
  local variant="$1" plist="$2"
  echo "==> build $variant ($plist)"
  if ! xcodebuild build -project ATSProbe.xcodeproj -scheme ATSProbe \
      -destination "id=$UDID" -derivedDataPath ".dd-$variant" -configuration Debug \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO INFOPLIST_FILE="$plist" \
      > "$OUT/build-$variant.log" 2>&1; then
    tail -40 "$OUT/build-$variant.log" >&2
    return 1
  fi
  { echo "== $variant app Info.plist =="
    plutil -p ".dd-$variant/Build/Products/Debug-iphonesimulator/ATSProbe.app/Info.plist" 2>/dev/null \
      | sed -n '/NSAppTransportSecurity/,/^  }/p'
  } > "$OUT/app-ats-$variant.txt"
}

# 4. One launch per arm: install the variant's app, hand it the URL, read its one line back. An
# arm that comes back with no line at all is retried once — run 38015680419's control-public launch
# exited silently, and the same launch was clean in every other arm, so a missing line is read as
# the simulator dropping an attach rather than as an answer.
launch_arm() { # label variant url
  local label="$1" variant="$2" url="$3" attempt line
  local app=".dd-$variant/Build/Products/Debug-iphonesimulator/ATSProbe.app"
  for attempt in 1 2; do
    echo "==> $label: $url (attempt $attempt)"
    xcrun simctl uninstall "$UDID" io.orbitd.atsprobe >/dev/null 2>&1 || true
    xcrun simctl install "$UDID" "$app" || return 1
    SIMCTL_CHILD_PROBE_URL="$url" xcrun simctl launch --console "$UDID" io.orbitd.atsprobe \
      > "$OUT/console-$label.log" 2>&1 || true
    grep -m1 '^PROBE ' "$OUT/console-$label.log" > "$OUT/$label.txt" || echo "PROBE result=missing" > "$OUT/$label.txt"
    line=$(cat "$OUT/$label.txt")
    [ "$line" = "PROBE result=missing" ] || break
    sleep 3
  done
  cat "$OUT/$label.txt"
}

build_variant shipped "$PWD/../../../../src/ios/Support/Info.plist" || fail "the shipped plist's build did not finish"
build_variant control "$PWD/InfoControl.plist" || fail "the control build did not finish"

launch_arm shipped        shipped "$PROBE_URL"            || fail "shipped arm did not finish"
launch_arm control        control "$PROBE_URL"            || fail "control arm did not finish"
launch_arm control-named  control "http://neverssl.com/"  || fail "control-named arm did not finish"
launch_arm shipped-named  shipped "http://neverssl.com/"  || fail "shipped-named arm did not finish"
launch_arm control-public control "http://1.1.1.1/"       || fail "control-public arm did not finish"
launch_arm shipped-public shipped "http://1.1.1.1/"       || fail "shipped-public arm did not finish"

STATUS=0
need() { # label glob what
  local line; line=$(cat "$OUT/$1.txt")
  case "$line" in
    $2) : ;;
    *) echo "!! $1: $3 — got: $line" >&2; STATUS=1 ;;
  esac
}
need shipped        "PROBE result=ok*" "the shipped app could not reach a self-hosted server by IP"
need shipped-named  "PROBE result=ok*" "the shipped app could not reach a named host over http"
need shipped-public "PROBE result=ok*" "the shipped app could not reach a public IP literal over http"
need control-named  "*code=-1022*"     "the control app was NOT refused a named host over http, so this run exercised no ATS at all"

{ echo "url:              $PROBE_URL"
  echo "shipped:          $(cat "$OUT/shipped.txt")          (self-hosted by IP, shipped plist)"
  echo "control:          $(cat "$OUT/control.txt")          (same URL, no ATS dictionary)"
  echo "control-named:    $(cat "$OUT/control-named.txt")    (named http host, no ATS dictionary)"
  echo "shipped-named:    $(cat "$OUT/shipped-named.txt")    (named http host, shipped plist)"
  echo "control-public:   $(cat "$OUT/control-public.txt")   (public IP literal, no ATS dictionary)"
  echo "shipped-public:   $(cat "$OUT/shipped-public.txt")   (public IP literal, shipped plist)"
} | tee "$OUT/summary.txt"
exit $STATUS
