#!/usr/bin/env bash
# TEMPORARY evidence probe (never merged; see README.md). Serve stub.py, build the iPhone and Mac
# probe apps from the real shared sources, and let RecapEntriesShotTests photograph the recap in the
# places a session is entered from besides the session list — twice per platform, once per mode:
#
#   recaps on   the chat page's recap at its top ("Recap · <n>m ago" + the sentence), and P1's
#               entries — its row in the workspace list and its sessions page's rows (iPhone), its
#               page's coordinator card (both) — saying a recap under its "Recap · <clock>" label in
#               place of the raw reply.
#   recaps off  the same stub started with --recaps-off (the same account with that switch off):
#               the chat page draws nothing in the recap's place, the entries their raw replies, and
#               no label is drawn anywhere.
#
# Both modes share one shots directory per platform — `shots/mac/` and `shots/ios/` — and every
# picture's file name says which pass it came from (`…-with-recap`, `…-with-recaps-off`); the mode
# the stub served heads every line of the request log beside it.
#
# Run it from a copy of this directory placed at the repository root (the project.yml's `../src`
# paths are relative to the repo, as the session-recap probe's were under `.recap-probe/`).
set -uo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-$PWD/shots}"
rm -rf "$OUT" results
mkdir -p "$OUT/ios" "$OUT/mac" results
xcodegen generate >/dev/null || exit 1

serve() {  # $1 = log file, $2… = the stub's own flags (--recaps-off). The stub must answer before
           # anything runs, or the pass is void — and the flag is part of what has to answer, since a
           # pass whose mode never reached the stub would photograph the other mode's rows.
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; fi
  python3 -u stub.py 8765 "$1" "${@:2}" > "$1.out" 2>&1 &
  STUB_PID=$!
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:8765/api/sessions; then
      echo "==> stub ready on 127.0.0.1:8765 (pid $STUB_PID, after ${i}s, flags: ${*:2})"
      return 0
    fi
    sleep 1
  done
  echo "==> stub never answered on 127.0.0.1:8765; python: $(python3 --version 2>&1); its output:"
  cat "$1.out"; ps aux | grep stub.py | grep -v grep || true
  lsof -nP -iTCP:8765 || true
  exit 1
}

STUB_PID=""
STATUS=0
run_pass() {  # $1 label, $2 scheme, $3 destination, $4 shots dir, $5 on|off
  echo "==> $1 (recaps-$5)"
  local env_off=""
  [ "$5" = "off" ] && env_off="TEST_RUNNER_RECAPS_OFF=1"
  # One derived-data root per PLATFORM, not per pass: the off pass reuses everything the on pass
  # built, which is the difference between two builds and four on a 10×-billed Mac runner.
  env $env_off TEST_RUNNER_SHOTS_DIR="$4" xcodebuild test -project RecapEntriesProbe.xcodeproj -scheme "$2" \
    -destination "$3" -derivedDataPath ".dd-${1%%-*}" -resultBundlePath "results/$1.xcresult" \
    CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > "build-$1.log" 2>&1 || STATUS=1
  grep -E "Test Case|Executed|error:|\*\* TEST" "build-$1.log" | tail -60 || true
  cp "build-$1.log" "$4/xcodebuild-$1.log"
  # A pass's own export directory: the two passes of a platform share the shots directory, and the
  # second export would otherwise overwrite the first's manifest before it is read.
  local attachments="$4/attachments-$1"
  mkdir -p "$attachments"
  xcrun xcresulttool export attachments --path "results/$1.xcresult" --output-path "$attachments" \
    > /dev/null 2>&1 || true
  # The Mac UI-test runner may not write outside its container: name the exported pictures instead.
  python3 - "$4" "$attachments" <<'PY' || true
import json, os, shutil, sys
out, base = sys.argv[1], sys.argv[2]
manifest = os.path.join(base, "manifest.json")
if not os.path.exists(manifest):
    raise SystemExit(0)
for test in json.load(open(manifest)):
    for a in test["attachments"]:
        name = a["suggestedHumanReadableName"].split("_0_")[0]
        ext = os.path.splitext(a["exportedFileName"])[1]
        # Pictures by their attachment name; texts (notes, trees, the request log) are named with
        # their extension already. A file the runner managed to write itself is kept.
        if ext == ".txt" and not name.endswith(".txt"):
            name += ".txt"
        target = os.path.join(out, name + ".png" if ext == ".png" else name)
        if ext in (".png", ".txt") and not os.path.exists(target):
            shutil.copy(os.path.join(base, a["exportedFileName"]), target)
PY
}

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
xcrun simctl status_bar "$IPHONE_UDID" override --time "15:12" --batteryState charged --batteryLevel 100 2>/dev/null || true

# The Mac first: a crash in the simulator leaves a "quit unexpectedly" panel on the Mac's screen.
serve "$OUT/mac/requests-on.log"
run_pass mac-on RecapEntriesMacProbe "platform=macOS" "$OUT/mac" on
serve "$OUT/mac/requests-off.log" --recaps-off
run_pass mac-off RecapEntriesMacProbe "platform=macOS" "$OUT/mac" off
serve "$OUT/ios/requests-on.log"
run_pass ios-on RecapEntriesProbe "id=$IPHONE_UDID" "$OUT/ios" on
serve "$OUT/ios/requests-off.log" --recaps-off
run_pass ios-off RecapEntriesProbe "id=$IPHONE_UDID" "$OUT/ios" off
kill "$STUB_PID" 2>/dev/null || true

# What the Mac probe apps did to their own windows (`-probe.windowLog`): the UI-test runner's sandbox
# cannot read it back, so it is collected here.
cp /tmp/recap-entries-window-*.log "$OUT/mac/" 2>/dev/null || true
for p in ios mac; do
  # Both modes' logs in one pair of files: a write here is `BODY …` or a mutating verb, and the
  # probe presses nothing — anything in writes.txt is the pass doing something it does not claim to.
  cat "$OUT/$p"/requests-*.log 2>/dev/null | grep -E "POST|PATCH|DELETE|BODY" > "$OUT/$p/writes.txt" || true
  cat "$OUT/$p"/requests-*.log 2>/dev/null | grep -E "NOT SERVED" \
    | sed -E 's/^[0-9:]+ \[[a-z-]+\] //' | sort | uniq -c | sort -rn > "$OUT/$p/not-served.txt" || true
done
# The marker the task's evidence convention names: the probe ran to the end.
printf 'exit=%s\n' "$STATUS" > "$OUT/.done-probe"
ls -la "$OUT/ios" "$OUT/mac"
exit "$STATUS"
