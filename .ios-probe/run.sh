#!/usr/bin/env bash
# Build the pull-to-refresh × search-field probe, then relaunch it once per variant on an iOS 26
# simulator and screenshot each one while the refresh is held. Evidence only — nothing here is a
# gate, and none of it belongs on the delivered branch.
#
#   bash .ios-probe/run.sh [out-dir]
#
# The variant is passed through the environment; `simctl launch` only forwards those with the
# SIMCTL_CHILD_ prefix. The app writes its geometry dump into Documents and then a `done` marker,
# which is what this script waits on rather than a fixed sleep: the answer to "did the pull engage
# at all?" has to be readable, not assumed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out}"
BUNDLE=io.orbitd.probe
SIM_NAME="${SIM_NAME:-iPhone 17 Pro}"
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
if [ $BUILT -ne 0 ]; then tail -60 "$OUT/build.log"; exit 1; fi
tail -2 "$OUT/build.log"

echo "== simulator =="
xcrun simctl list runtimes | grep -i ios || true
# Newest iOS runtime first — the Liquid Glass navigation bar and the drawer search field this probe
# is about only render on iOS 26, and a run on an older runtime would answer a different question.
UDID=$(xcrun simctl list devices available | sed -nE 's/^    '"$SIM_NAME"' \(([0-9A-F-]{36})\).*/\1/p' | head -1)
if [ -z "${UDID:-}" ]; then
  echo "no available simulator named $SIM_NAME; available:"
  xcrun simctl list devices available | sed -nE 's/^    ((iPhone|iPad)[^(]*) \(.*/  \1/p' | head -20
  exit 1
fi
echo "device: $SIM_NAME ($UDID)"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

APP="$HERE/.dd/Build/Products/Debug-iphonesimulator/OrbitProbe.app"
xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP" || exit 1

CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
DOCS="$CONTAINER/Documents"

shot() {  # shot <variant> <pull-style>
  local variant="$1" pull="$2" name="$variant-$pull"
  rm -f "$DOCS/done" "$DOCS/report.txt"

  SIMCTL_CHILD_PROBE_VARIANT="$variant" SIMCTL_CHILD_PROBE_PULL="$pull" \
    xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" > "$OUT/launch-$name.log" 2>&1

  local waited=0
  while [ ! -f "$DOCS/done" ] && [ "$waited" -lt 30 ]; do sleep 1; waited=$((waited + 1)); done
  if [ ! -f "$DOCS/done" ]; then
    echo "[$name] no done marker after ${waited}s — shooting anyway"
  fi

  xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null 2>&1
  cp "$DOCS/report.txt" "$OUT/$name.txt" 2>/dev/null || echo "[$name] no report"
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1
  sleep 1
}

VARIANTS="${VARIANTS:-leadBare leadBareRowSeparatorHidden leadBareSectionSeparatorHidden leadEmptyHeader}"
PULLS="${PULLS:-none}"

echo "== run =="
for variant in $VARIANTS; do
  for pull in $PULLS; do
    shot "$variant" "$pull"
  done
done

echo "== measured =="
# The verdict lines, in the log rather than only in the artifact: the frames behind each one are in
# the matching .txt.
grep -H "^OVERLAP\|^variant" "$OUT"/*.txt 2>/dev/null | sed 's|'"$OUT"'/||'

echo "== files =="
ls -la "$OUT"/*.png "$OUT"/*.txt 2>/dev/null | sed 's|.*/||'
