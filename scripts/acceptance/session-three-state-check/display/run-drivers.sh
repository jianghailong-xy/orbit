#!/usr/bin/env bash
# The three clients' own functions over <rows.json>: the display driver at the tip, and the group driver at the tip and
# at <base>, the commit before the display change. Node modules installed and @orbit/shared built in both checkouts.
#   run-drivers.sh <tip checkout> <base checkout> <rows.json> <outdir>
# Writes <outdir>/{web,apple,android}.json and groups-{tip,base}-{web,apple,android}.json. Exit non-zero on any failure.
set -euo pipefail
TIP=$(cd "$1" && pwd); BASE=$(cd "$2" && pwd); ROWS=$(realpath "$3"); OUT=$(mkdir -p "$4" && cd "$4" && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
cp "$ROWS" "$OUT/rows.json"
for side in tip base; do
  T=$TIP; [ $side = base ] && T=$BASE
  echo "== $side $(git -C "$T" rev-parse --short=10 HEAD)"
  # web
  cp "$HERE/web-groups.test.ts" "$T/src/web/src/lib/webGroups.test.ts"; files=src/lib/webGroups.test.ts
  if [ $side = tip ]; then cp "$HERE/web-display.test.ts" "$T/src/web/src/lib/webDisplay.test.ts"; fi
  (cd "$T/src/web" && ROWS="$OUT/rows.json" OUT="$OUT/groups-$side-web.json" npx vitest run $files)
  [ $side = tip ] && (cd "$T/src/web" && ROWS="$OUT/rows.json" OUT="$OUT/web.json" npx vitest run src/lib/webDisplay.test.ts)
  echo "web $side done"
  # Android
  A="$T/src/android/app/src/test/kotlin/io/orbitd/android/sessionfacts"; mkdir -p "$A"
  cp "$HERE/AndroidGroupsTest.kt" "$A/"; [ $side = tip ] && cp "$HERE/AndroidDisplayTest.kt" "$A/"
  gradle() { (cd "$T/src/android" && ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk ROWS="$OUT/rows.json" OUT="$1" \
    ./gradlew --offline --no-daemon :app:testDebugUnitTest --tests "*$2" --rerun); }
  gradle "$OUT/groups-$side-android.json" AndroidGroupsTest
  [ $side = tip ] && gradle "$OUT/android.json" AndroidDisplayTest
  echo "android $side done"
  # Apple (OrbitKit on Linux)
  rm -rf "$OUT/swift-$side"; mkdir -p "$OUT/swift-$side/src/macos"; cp -r "$T/src/macos/OrbitKit" "$OUT/swift-$side/src/macos/"
  K="$OUT/swift-$side/src/macos/OrbitKit/Tests/OrbitKitTests"; cp "$HERE/AppleGroupsTests.swift" "$K/"
  filter="--filter AppleGroupsTests"; [ $side = tip ] && cp "$HERE/AppleDisplayTests.swift" "$K/" && filter="--filter AppleGroupsTests|AppleDisplayTests"
  disp=/o/apple.json
  docker run --rm -v "$OUT:/o" -w "/o/swift-$side/src/macos/OrbitKit" -e ROWS=/o/rows.json -e OUT=/o/groups-$side-apple.json swift:6.1 \
    swift test --filter AppleGroupsTests
  [ $side = tip ] && docker run --rm -v "$OUT:/o" -w "/o/swift-$side/src/macos/OrbitKit" -e ROWS=/o/rows.json -e OUT=$disp swift:6.1 \
    swift test --filter AppleDisplayTests
  echo "apple $side done"
done
rm -rf "$OUT"/swift-tip "$OUT"/swift-base
ls -la "$OUT"
