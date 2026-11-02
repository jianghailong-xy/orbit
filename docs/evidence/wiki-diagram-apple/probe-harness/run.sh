#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged). Serve stub.py, build the iPhone and Mac probe apps from the tree's own shell
# and shared sources, and let DiagramShotTests drive and photograph them. Each platform gets its own stub log, so
# requests.log shows what that app sent. Adapted from docs/evidence/criteria-reply-session-line/probe-harness.
# Beside the pictures: what the compiler said of WikiDiagram.swift, the Mermaid build inside each probe app, and the
# real iOS project's (src/ios/project.yml) resources phase, which takes the build in with the shared sources.
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file. The stub must answer before anything runs, or the pass is void.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/agents; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered on 127.0.0.1:8765; its output:"
  cat "$1.out"
  exit 1
}

STUB_PID=""
STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir, $5 app name
  echo "==> $1"
  SHOTS_DIR="$4" TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project WdgProbe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-$1" -resultBundlePath "results/$1.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -80 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  # The file this task added, as this build compiled it into the probe app, and anything the compiler said of it.
  grep -E "SwiftCompile .*WikiDiagram\.swift" "build-$1.log" \
    | sed -E 's#/Users/runner/work/[^ ]*/src/#src/#g' | sort -u > "$4/compiled-$1.txt" || true
  grep -E "WikiDiagram\.swift:[0-9]+:[0-9]+: (warning|error)" "build-$1.log" | sort -u > "$4/diagnostics-WikiDiagram-$1.txt" || true
  echo "$(wc -l < "$4/diagnostics-WikiDiagram-$1.txt") diagnostics on WikiDiagram.swift" >> "$4/diagnostics-WikiDiagram-$1.txt"
  # The Mermaid build as the app carries it, against the tree's own file.
  { shasum -a 256 ../src/macos/OrbitApp/Sources/OrbitApp/Resources/mermaid.min.js
    find ".dd-$1/Build/Products" -name mermaid.min.js -path "*$5.app*" -exec shasum -a 256 {} \; ; } > "$4/bundle-$1.txt"
  # A runner whose test process could not write the pictures still keeps them as attachments.
  mkdir -p "$4/attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$4/attachments" \
    > /dev/null 2>&1 || true
  # The Mac UI-test runner may not write outside its container: name the exported pictures and notes instead.
  python3 - "$4" <<'PY' || true
import json, os, shutil, sys
out = sys.argv[1]; base = os.path.join(out, "attachments")
for test in json.load(open(os.path.join(base, "manifest.json"))):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        if ext in (".png", ".txt") and not os.path.exists(os.path.join(out, name if ext == ".txt" else name + ext)):
            shutil.copy(os.path.join(base, a["exportedFileName"]), os.path.join(out, name if ext == ".txt" else name + ext))
PY
}

# The real iOS project: XcodeGen puts the Mermaid build and its license in the app's Copy Bundle Resources phase.
( cd ../src/ios && xcodegen generate >/dev/null && grep -E "mermaid[^ ]* in Resources" Orbit.xcodeproj/project.pbxproj | sort -u ) \
  > "$OUT/ios-project-resources.txt" 2>&1 || true

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
echo "==> iPhone $IPHONE_UDID: $(xcrun simctl list devices | grep "$IPHONE_UDID" | sed -E 's/^ +//')"
xcrun simctl boot "$IPHONE_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$IPHONE_UDID" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$IPHONE_UDID" override --time "9:41" --batteryState charged --batteryLevel 100 2>/dev/null || true
for domain in com.apple.Preferences com.apple.keyboard.preferences; do
  xcrun simctl spawn "$IPHONE_UDID" defaults write "$domain" DidShowContinuousPathIntroduction -bool true 2>/dev/null || true
done

serve "$OUT/ios/requests.log"
run_pass ios WdgProbe "id=$IPHONE_UDID" "$OUT/ios" WdgProbe
serve "$OUT/mac/requests.log"
run_pass mac WdgMacProbe "platform=macOS" "$OUT/mac" WdgMacProbe
kill "$STUB_PID" 2>/dev/null || true

for p in ios mac; do
  grep -E '" 404 ' "$OUT/$p/requests.log" | sed -E 's/^[0-9:.]+ //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" || true
  grep -E "POST|PATCH|DELETE|body:" "$OUT/$p/requests.log" > "$OUT/$p/writes.txt" || true
done
ls -la "$OUT" "$OUT/ios" "$OUT/mac"
exit "$STATUS"
