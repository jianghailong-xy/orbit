#!/usr/bin/env bash
set -euo pipefail

kit=.session-phase-probe
mkdir -p "$kit/shots"
cp -R docs/evidence/source-refused-native/probe-harness/. "$kit/"
task_commit=$(git rev-parse HEAD^)
case "$PROBE_REVISION" in
  before)
    app_commit=3154a8834c6a0363e4ae90e5617c9d59ba7ca33a
    git fetch --depth=1 origin "$app_commit"
    git restore --source="$app_commit" --staged --worktree src/macos src/ios
    ;;
  after)
    app_commit=$task_commit
    ;;
esac

cd "$kit"
printf '%s %s\n' "$PROBE_REVISION" "$app_commit" > shots/revision.txt
python3 - <<'PY'
from pathlib import Path

stub = Path("stub.py")
source = stub.read_text()
start = source.index("SESSIONS = {")
end = source.index("\nSTATE =", start)
stub.write_text(source[:start] + """
def row(sid, title, status, *, phase, released, outcome=None, waiting=None, reason=None, task=None, finished=False):
    run_state = "QUEUED" if status == "PENDING" else status
    return {
        "id": sid, "publicId": sid, "title": title,
        "status": status, "runStatus": status, "runState": run_state, "sessionState": run_state,
        "lifecycleState": "OPEN", "endReason": reason, "phase": phase,
        "released": released, "lastTurnOutcome": outcome, "waitingOn": waiting,
        "workFinished": finished, "taskId": task, "agentId": "a1", "assignedRunnerId": "r1",
        "provider": "claude", "engine": "claude", "numTurns": 1,
        "createdAt": ago(30), "updatedAt": ago(2), "lastTurnAt": ago(2),
        "agent": AGENT,
    }

SESSIONS = {
    "S1": row("S1", "Review release notes", "SUCCEEDED", phase="IDLE", released=True,
              outcome="ANSWERED", reason="task_done", task="T1", finished=True),
    "S2": row("S2", "Check the nightly build", "PENDING", phase="PENDING", released=False, waiting="HOLD"),
    "S3": row("S3", "Collect the build logs", "FAILED", phase="IDLE", released=True,
              outcome="FAILED", reason="ended"),
    "S4": row("S4", "Compare the two reports", "SUCCEEDED", phase="IDLE", released=True, outcome="ANSWERED"),
    "S5": row("S5", "Review the pending changes", "AWAITING_INPUT", phase="IDLE", released=False,
              outcome="INTERRUPTED", reason="ended"),
    "S6": row("S6", "Archive the review notes", "CANCELLED", phase="IDLE", released=True,
              outcome="INTERRUPTED", reason="ended"),
}
""" + source[end:])
PY

xcodegen generate
python3 -u stub.py 8765 "$PWD/shots/requests.log" > shots/stub.log 2>&1 &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null || true' EXIT
curl --fail --retry 15 --retry-connrefused --retry-delay 1 --silent --show-error     -o shots/payloads.json http://127.0.0.1:8765/api/sessions

cases=(task-finished queued-on-hold requested-end plain-conversation interrupted-ending interrupted-released)
if [ "$PROBE_CLIENT" = mac ]; then
    xcodebuild build -project RunStartProbe.xcodeproj -scheme RunStartMacProbe         -destination 'platform=macOS' -derivedDataPath .build         CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- > shots/build.log 2>&1         || { tail -150 shots/build.log; exit 1; }
    binary=.build/Build/Products/Debug/RunStartMacProbe.app/Contents/MacOS/RunStartMacProbe
    for index in "${!cases[@]}"; do
        sid="S$((index + 1))"
        name="${cases[$index]}"
        "$binary" -orbit.instance http://127.0.0.1:8765 -probe.session "$sid"             -probe.fresh -ApplePersistenceIgnoreState YES -shell.sidebarVisible YES             -probe.shot "$PWD/shots/$name.png" -probe.windowLog "$PWD/shots/$name.log"             > "shots/$name.app.log" 2>&1 &
        app_pid=$!
        for attempt in {1..25}; do
            if [ -s "shots/$name.png" ]; then break; fi
            if ! kill -0 "$app_pid" 2>/dev/null; then break; fi
            sleep 1
        done
        kill "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
        test -s "shots/$name.png" || { cat "shots/$name.app.log"; exit 1; }
    done
else
    udid=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for devices in reversed(list(json.load(sys.stdin)["devices"].values())):
    for device in devices:
        if device["isAvailable"] and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit()
sys.exit("No iPhone simulator")')
    xcrun simctl boot "$udid" || true
    xcrun simctl bootstatus "$udid" -b
    xcrun simctl status_bar "$udid" override --time '15:12' --batteryState charged --batteryLevel 100
    xcodebuild build -project RunStartProbe.xcodeproj -scheme RunStartProbe         -destination "id=$udid" -derivedDataPath .build         CODE_SIGNING_ALLOWED=NO > shots/build.log 2>&1         || { tail -150 shots/build.log; exit 1; }
    bundle=io.orbitd.crossingsprobe
    xcrun simctl install "$udid" .build/Build/Products/Debug-iphonesimulator/RunStartProbe.app
    for index in "${!cases[@]}"; do
        sid="S$((index + 1))"
        name="${cases[$index]}"
        xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
        xcrun simctl launch "$udid" "$bundle" -orbit.instance http://127.0.0.1:8765             -probe.session "$sid" -probe.fresh
        sleep 12
        xcrun simctl io "$udid" screenshot "$PWD/shots/$name.png"
    done
fi
for index in "${!cases[@]}"; do
    sid="S$((index + 1))"
    grep -q "/api/sessions/$sid" shots/requests.log
    test -s "shots/${cases[$index]}.png"
done
rm shots/build.log
