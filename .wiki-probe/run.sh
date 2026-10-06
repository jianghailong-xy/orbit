#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py in its three modes — one space on 8765, three on 8766,
# the home's reads held back on 8767 — build the probe app from the real shared sources, and let the UI tests
# read the Wiki off the screen and photograph it: the iPhone suite on an iPhone simulator, the iPad suite on an
# iPad (11-inch, as mock 32 draws it).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT" results
xcodegen generate >/dev/null || exit 1

python3 -u stub.py 8765 "$OUT/requests-one.log" one > "$OUT/stub-one.out" 2>&1 &
ONE_PID=$!
python3 -u stub.py 8766 "$OUT/requests-three.log" three > "$OUT/stub-three.out" 2>&1 &
THREE_PID=$!
SLOW=25 python3 -u stub.py 8767 "$OUT/requests-slow.log" slow > "$OUT/stub-slow.out" 2>&1 &
SLOW_PID=$!
ready=0
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/api/wiki/spaces && curl -fs -o /dev/null http://127.0.0.1:8766/api/wiki/spaces \
     && curl -fs -o /dev/null http://127.0.0.1:8767/api/wiki/spaces; then
    ready=1; echo "==> stubs ready after ${i}s"; break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "==> a stub never answered"; cat "$OUT"/stub-*.out; exit 1; fi

pick() {
  xcrun simctl list devices available -j | python3 -c '
import json,sys,re
kind=sys.argv[1]
d=json.load(sys.stdin)["devices"]; best=None
for rt,ds in d.items():
    m=re.search(r"iOS-(\d+)-(\d+)",rt); v=(int(m.group(1)),int(m.group(2))) if m else (0,0)
    for x in ds:
        n=x["name"]
        if not x["isAvailable"] or kind not in n: continue
        if kind=="iPhone": k=(v,("Pro" in n)*2-("Max" in n))
        else: k=(v,("Air 11" in n)*3+("Pro 11" in n)*2+("11-inch" in n))
        if best is None or k>best[0]: best=(k,x["udid"],n,rt)
print(best[1] if best else "")
print(kind, best[2] if best else "-", best[3] if best else "-", file=sys.stderr)' "$1"
}
IPHONE_UDID=$(pick iPhone)
IPAD_UDID=$(pick iPad)
echo "==> iPhone $IPHONE_UDID, iPad $IPAD_UDID"
for udid in "$IPHONE_UDID" "$IPAD_UDID"; do
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
done

STATUS=0
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project WikiProbe.xcodeproj -scheme WikiProbe \
  -destination "id=$IPHONE_UDID" -derivedDataPath .dd -resultBundlePath results/phone.xcresult \
  -only-testing:WikiProbeUITests/WikiPhoneShotsTests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-phone.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-phone.log | tail -60 || true
TEST_RUNNER_SHOTS_DIR="$OUT" xcodebuild test -project WikiProbe.xcodeproj -scheme WikiProbe \
  -destination "id=$IPAD_UDID" -derivedDataPath .dd -resultBundlePath results/pad.xcresult \
  -only-testing:WikiProbeUITests/WikiPadShotsTests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > build-pad.log 2>&1 || STATUS=1
grep -E "Test Case|Executed|error:|\*\* TEST" build-pad.log | tail -60 || true
for bundle in phone pad; do
  mkdir -p "$OUT/attachments-$bundle"
  xcrun xcresulttool export attachments --path "results/$bundle.xcresult" --output-path "$OUT/attachments-$bundle" \
    > /dev/null 2>&1 || true
done
kill "$ONE_PID" "$THREE_PID" "$SLOW_PID" 2>/dev/null || true
cat "$OUT"/requests-*.log 2>/dev/null | grep -E '" 404 ' | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/not-served.txt" || true
ls -la "$OUT"
exit "$STATUS"
