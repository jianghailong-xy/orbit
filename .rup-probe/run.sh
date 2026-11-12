#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the Mac and iPhone probe apps from the
# real shared sources, and let RupShotTests photograph a session held by its runner's update.
# Run from a copy of this directory at the repository root (project.yml's `../src` paths).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
PASSES="${PASSES:-mac ios}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests.log" > "$OUT/stub.out" 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/sessions; then echo "==> stub ready after ${i}s"; break; fi
  sleep 1
done

STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir
  echo "==> $1"
  echo "=== pass $1 ===" >> "$OUT/requests.log"
  TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project RupProbe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -60 || true
  local attachments="$4/attachments"
  mkdir -p "$attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$attachments" \
    > /dev/null 2>&1 || true
  python3 - "$4" "$attachments" <<'PY' || true
import json, os, re, shutil, sys
out, base = sys.argv[1], sys.argv[2]
manifest = os.path.join(base, "manifest.json")
if not os.path.exists(manifest):
    raise SystemExit(0)
for test in json.load(open(manifest)):
    for a in test["attachments"]:
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", a["suggestedHumanReadableName"].split("_0_")[0])
        ext = os.path.splitext(a["exportedFileName"])[1]
        dest = os.path.join(out, name + ext)
        if not os.path.exists(dest):
            shutil.copy(os.path.join(base, a["exportedFileName"]), dest)
# Upload-artifact refuses names with quotes and the like: sanitize every exported file name.
for f in os.listdir(base):
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", f)
    if clean != f:
        os.rename(os.path.join(base, f), os.path.join(base, clean))
PY
}

for p in $PASSES; do
  case "$p" in
    mac) run_pass mac RupMacProbe "platform=macOS" "$OUT/mac" ;;
    ios)
      IPHONE_UDID=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,re
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        if x["isAvailable"] and "iPhone" in x["name"]:
            k=(v,("Pro" in x["name"])*2-("Max" in x["name"]))
            if best is None or k>best[0]: best=(k,x["udid"],x["name"])
print(best[1] if best else "")')
      echo "==> iPhone $IPHONE_UDID"
      xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
      xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
      xcrun simctl status_bar "$IPHONE_UDID" override --time "11:42" --batteryState charged --batteryLevel 100 2>/dev/null || true
      run_pass ios RupProbe "id=$IPHONE_UDID" "$OUT/ios" ;;
  esac
done
kill "$STUB_PID" 2>/dev/null || true

grep -E "BODY" "$OUT/requests.log" > "$OUT/writes.txt" || true
grep -E "NOT SERVED" "$OUT/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
printf 'exit=%s\n' "$STATUS" > "$OUT/done-probe.txt"
ls -la "$OUT/ios" "$OUT/mac"
exit "$STATUS"
