#!/usr/bin/env bash
# Runs the three client drivers over fixture.json at a checkout of the project tip and prints the table.
#   run-all.sh <checkout-of-project-tip> <outdir>
set -euo pipefail
TIP=$(cd "$1" && pwd); OUT=$(mkdir -p "$2" && cd "$2" && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
cp "$HERE/fixture.json" "$OUT/fixture.json"
# capabilities as the server's own withSessionCapabilities builds them (needs a compiled apiserver: tsc -p tsconfig.test.json)
[ -f "$TIP/src/apiserver/build/sessions/session-state.js" ] && node "$HERE/server-capabilities.cjs" "$TIP/src/apiserver/build" "$OUT/fixture.json"
cp "$HERE/web-decisions.test.ts" "$TIP/src/web/src/lib/webDecisions.test.ts"
cp "$HERE/AndroidDecisionsTest.kt" "$TIP/src/android/app/src/test/kotlin/io/orbitd/android/sessionfacts/"
rm -rf "$OUT/swiftpkg"; cp -r "$TIP/src/macos/OrbitKit" "$OUT/swiftpkg"; cp "$HERE/AppleDecisionsTests.swift" "$OUT/swiftpkg/Tests/OrbitKitTests/"
(cd "$TIP/src/web" && FIXTURE="$OUT/fixture.json" OUT="$OUT/web.json" npx vitest run src/lib/webDecisions.test.ts >"$OUT/web.log" 2>&1)
(cd "$TIP/src/android" && ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk FIXTURE="$OUT/fixture.json" OUT="$OUT/android.json" ./gradlew --offline :app:cleanTestDebugUnitTest :app:testDebugUnitTest --tests '*AndroidDecisionsTest' >"$OUT/android.log" 2>&1)
docker run --rm -v "$OUT:/o" -w /o/swiftpkg -e FIXTURE=/o/fixture.json -e OUT=/o/apple.json swift:6.1 swift test --filter AppleDecisionsTests >"$OUT/swift.log" 2>&1
node "$HERE/compare.mjs" "$OUT/web.json" "$OUT/apple.json" "$OUT/android.json" | tee "$OUT/table.md"
