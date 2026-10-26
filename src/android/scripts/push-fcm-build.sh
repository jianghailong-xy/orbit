#!/usr/bin/env bash
# The release package io.orbitd.android and its release-type test APK, for A10's real Firebase checks
# (push-fcm-emulator.sh, push-fcm-production.sh). Takes the five public ORBIT_ANDROID_FIREBASE_* client values from the
# environment (for example `set -a; . android-client.env; set +a`) and signs with a throwaway key that is deleted as
# soon as Gradle ends. The output records that the values were supplied and reached BuildConfig, never the values.
set -euo pipefail
(( $# == 1 )) || { echo 'Usage: push-fcm-build.sh NEW_BUILD_DIR' >&2; exit 2; }
build="$(realpath -m "$1")"
mkdir -p "$build"
[[ -z "$(ls -A "$build")" ]] || { echo 'Use a new build directory' >&2; exit 2; }
package=io.orbitd.android
for name in APP_ID API_KEY PROJECT_ID SENDER_ID ANDROID_PACKAGE; do
  variable="ORBIT_ANDROID_FIREBASE_$name"
  [[ -n "${!variable:-}" ]] || { echo "Missing $variable" >&2; exit 2; }
done
[[ "$ORBIT_ANDROID_FIREBASE_ANDROID_PACKAGE" == "$package" ]] || { echo "The Firebase client must be the one for $package" >&2; exit 2; }
: "${JAVA_HOME:?Set JAVA_HOME to Java 21}"
scripts="$(cd "$(dirname "$0")" && pwd)"
android="$(cd "$scripts/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
tools="$ANDROID_HOME/build-tools/36.0.0"

# The highest version code keeps the in-app updater quiet, since no published release is newer.
signing="$(mktemp -d)"
trap 'rm -rf "$signing"' EXIT
password="$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$signing/throwaway.p12" -storetype PKCS12 -storepass "$password" -keypass "$password" \
  -alias a10fcm -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=A10 FCM emulator check (throwaway)' > /dev/null 2>&1
gradle_status=0
ORBIT_ANDROID_KEYSTORE_PATH="$signing/throwaway.p12" ORBIT_ANDROID_STORE_PASSWORD="$password" ORBIT_ANDROID_KEY_ALIAS=a10fcm \
  ORBIT_ANDROID_KEY_PASSWORD="$password" ORBIT_ANDROID_VERSION_NAME=0.0.0-a10-fcm-check ORBIT_ANDROID_VERSION_CODE=2100000000 \
  bash "$android/gradlew" -p "$android" --no-daemon --max-workers=2 -PorbitTestBuildType=release \
  :app:assembleRelease :app:assembleReleaseAndroidTest > "$build/gradle.log" 2>&1 || gradle_status=$?
rm -rf "$signing"
(( gradle_status == 0 )) || { tail -40 "$build/gradle.log" >&2; exit 1; }
cp "$android/app/build/outputs/apk/release/app-release.apk" "$build/app-release.apk"
cp "$android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk" "$build/app-release-androidTest.apk"
python3 - "$android/app/build/generated/source/buildConfig/release/io/orbitd/android/BuildConfig.java" > "$build/firebase-config.txt" <<'PY'
import os, re, sys
config = open(sys.argv[1]).read()
assert 'DEBUG = false' in config, 'not a release BuildConfig'
for name in ('APP_ID', 'API_KEY', 'PROJECT_ID', 'SENDER_ID', 'ANDROID_PACKAGE'):
    assert f'FIREBASE_{name} = "{os.environ["ORBIT_ANDROID_FIREBASE_" + name]}"' in config, f'BuildConfig.FIREBASE_{name} differs'
    print(f'FIREBASE_{name}: supplied and equal in BuildConfig')
print('SOURCE_SHA=' + re.search(r'SOURCE_SHA = "([0-9a-f]+)"', config)[1])
print('SOURCE_DIRTY=' + re.search(r'SOURCE_DIRTY = (\w+)', config)[1])
PY
"$tools/aapt" dump badging "$build/app-release.apk" > "$build/badging.txt"
grep -F "package: name='$package'" "$build/badging.txt" > /dev/null
if grep -q application-debuggable "$build/badging.txt"; then echo 'The release APK must not be debuggable' >&2; exit 1; fi
"$tools/apksigner" verify --print-certs "$build/app-release.apk" | grep 'SHA-256' > "$build/signing.txt"
sha256sum "$build/app-release.apk" "$build/app-release-androidTest.apk" "$scripts/push-fcm-build.sh" > "$build/inputs.sha256"
