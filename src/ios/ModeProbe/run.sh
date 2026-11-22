#!/usr/bin/env bash
set -euo pipefail
cd src/ios
python3 ModeProbe/stub.py >build/mode-stub.log 2>&1 &
stub=$!
trap 'kill "$stub"' EXIT
device=$(xcrun simctl list devices available -j | python3 -c '
import json,sys
devices = json.load(sys.stdin)["devices"]
for runtime, models in reversed(list(devices.items())):
    phones = [d for d in models if "iPhone" in d["name"]]
    if phones:
        print(next((d["udid"] for d in phones if d["name"].endswith(" Pro")), phones[0]["udid"]))
        break')
test -n "$device"
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time "9:41" --batteryState charged --batteryLevel 100
xcrun simctl ui "$device" appearance light
curl -fsS http://127.0.0.1:8765/api/users/me >/dev/null
status=0
xcodebuild test -project Orbit.xcodeproj -scheme Orbit -destination "id=$device" \
  -parallel-testing-enabled NO -resultBundlePath build/mode.xcresult \
  -configuration Debug -derivedDataPath build/dd \
  CODE_SIGN_STYLE=Manual CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- >build/mode-tests.log 2>&1 || status=$?
tail -110 build/mode-tests.log
if test -d build/mode.xcresult; then
  xcrun xcresulttool export attachments --path build/mode.xcresult --output-path build/mode-shots
  python3 - <<'PY'
import json, pathlib, shutil
root = pathlib.Path("build/mode-shots")
for record in json.loads((root / "manifest.json").read_text()):
    for capture in record.get("attachments", []):
        name = capture["suggestedHumanReadableName"].split("_0_")[0]
        source = root / capture["exportedFileName"]
        if source.suffix == ".png" and name[:2] in ["01", "02", "03", "04"]:
            shutil.copyfile(source, root / (name + ".png"))
PY
fi
exit "$status"
