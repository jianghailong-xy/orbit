#!/usr/bin/env bash
# S1 signed APK only. Credentials stay in the environment and an external keystore.
set -euo pipefail
[[ $# == 1 ]] || { echo "Usage: $0 <new-output-directory>" >&2; exit 2; }
android_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$android_dir/../.." && pwd)
for name in VERSION_NAME VERSION_CODE APPLICATION_ID KEYSTORE_PATH STORE_PASSWORD KEY_ALIAS KEY_PASSWORD CERT_SHA256 SIGNING_PURPOSE; do
  variable="ORBIT_ANDROID_$name"
  [[ -n ${!variable:-} ]] || { echo "Missing $variable" >&2; exit 2; }
done
[[ $ORBIT_ANDROID_SIGNING_PURPOSE == release || $ORBIT_ANDROID_SIGNING_PURPOSE == test ]] || {
  echo 'SIGNING_PURPOSE must be release or test (test is NOT a distribution identity)' >&2; exit 2;
}
[[ $ORBIT_ANDROID_SIGNING_PURPOSE != test || $ORBIT_ANDROID_APPLICATION_ID == *.upgradetest ]] || {
  echo 'Temporary test signing requires an isolated *.upgradetest application ID' >&2; exit 2;
}
# Update rehearsals only: the updater reads a stand-in for GitHub on the device loopback (adb reverse).
update_api=${ORBIT_ANDROID_UPDATE_API:-https://api.github.com}
[[ $update_api == https://api.github.com || ( $ORBIT_ANDROID_SIGNING_PURPOSE == test && $update_api =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}$ ) ]] || {
  echo 'ORBIT_ANDROID_UPDATE_API is only for a test-signed rehearsal: http://127.0.0.1:<port>' >&2; exit 2;
}
[[ $ORBIT_ANDROID_VERSION_NAME =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ && ${#ORBIT_ANDROID_VERSION_NAME} -le 32 ]] || {
  echo 'Invalid version name (X.Y.Z[-suffix], max 32 characters)' >&2; exit 2;
}
[[ $ORBIT_ANDROID_VERSION_CODE =~ ^[1-9][0-9]{0,9}$ && $ORBIT_ANDROID_VERSION_CODE -le 2100000000 ]] || {
  echo 'Invalid version code (1..2100000000)' >&2; exit 2;
}
[[ $ORBIT_ANDROID_APPLICATION_ID =~ ^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$ ]] || {
  echo 'Invalid application ID' >&2; exit 2;
}
# Firebase client values are not secrets; all five or none (none keeps push notifications off).
firebase_values=0
for name in APP_ID API_KEY PROJECT_ID SENDER_ID ANDROID_PACKAGE; do
  variable="ORBIT_ANDROID_FIREBASE_$name"
  [[ -z ${!variable:-} ]] || firebase_values=$((firebase_values + 1))
done
[[ $firebase_values == 0 || $firebase_values == 5 ]] || {
  echo 'Set all five ORBIT_ANDROID_FIREBASE_* client values or none (push stays off without them)' >&2; exit 2;
}
[[ $firebase_values == 0 || $ORBIT_ANDROID_FIREBASE_ANDROID_PACKAGE == "$ORBIT_ANDROID_APPLICATION_ID" ]] || {
  echo 'ORBIT_ANDROID_FIREBASE_ANDROID_PACKAGE must equal the application ID' >&2; exit 2;
}
[[ -f $ORBIT_ANDROID_KEYSTORE_PATH && $ORBIT_ANDROID_KEYSTORE_PATH == /* ]] || {
  echo 'Keystore must be an existing absolute path outside the repository' >&2; exit 2;
}
case "$(realpath "$ORBIT_ANDROID_KEYSTORE_PATH")" in "$repo_dir"/*)
  echo 'Keep signing credentials outside the repository' >&2; exit 2;;
esac
[[ -z $(git -C "$repo_dir" status --porcelain) ]] || {
  echo 'Commit the source before building an identified release/test artifact' >&2; exit 2;
}
source_sha=$(git -C "$repo_dir" rev-parse HEAD)
: "${JAVA_HOME:?Set JAVA_HOME to Java 21}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
tools="$ANDROID_HOME/build-tools/36.0.0"
mkdir -p "$1"
output=$(cd "$1" && pwd)
[[ -z $(find "$output" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
  echo 'Output directory must be empty' >&2; exit 2;
}
printf '%s\n' "$source_sha" > "$output/source-sha.txt"
# No --info/--debug, command-line passwords, Gradle build scan or credential capture.
bash "$android_dir/gradlew" -p "$android_dir" --no-daemon --max-workers=2 \
  -PorbitSourceSha="$source_sha" -PorbitSourceDirty=false -PorbitUpdateApi="$update_api" :app:assembleRelease \
  2>&1 | tee "$output/build.log"
cp "$android_dir/app/build/outputs/apk/release/app-release.apk" "$output/app-release.apk"
"$tools/aapt" dump badging "$output/app-release.apk" > "$output/badging.txt"
"$tools/apksigner" verify --verbose --print-certs "$output/app-release.apk" > "$output/signing.txt"
cp "$android_dir/app/build/generated/source/buildConfig/release/io/orbitd/android/BuildConfig.java" "$output/BuildConfig.java"
python3 - "$output" <<'PY'
import hashlib, json, os, pathlib, re, sys, zipfile
p = pathlib.Path(sys.argv[1])
badging = (p / 'badging.txt').read_text()
package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
assert package, 'Missing APK package metadata'
app_id, code, version = package.groups()
assert app_id == os.environ['ORBIT_ANDROID_APPLICATION_ID']
assert code == os.environ['ORBIT_ANDROID_VERSION_CODE']
assert version == os.environ['ORBIT_ANDROID_VERSION_NAME']
assert "sdkVersion:'29'" in badging and "targetSdkVersion:'36'" in badging
assert 'application-debuggable' not in badging, 'Release APK must not be debuggable'
certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$', (p / 'signing.txt').read_text(), re.M)
expected_cert = os.environ['ORBIT_ANDROID_CERT_SHA256'].replace(':', '').lower()
assert re.fullmatch('[0-9a-f]{64}', expected_cert), 'Expected certificate must be a SHA-256 fingerprint'
assert certs == [expected_cert], 'APK signer does not match the independently configured fingerprint'
source = (p / 'source-sha.txt').read_text().strip()
config = (p / 'BuildConfig.java').read_text()
assert f'SOURCE_SHA = "{source}"' in config and 'SOURCE_DIRTY = false' in config
assert f'VERSION_NAME = "{version}"' in config and f'VERSION_CODE = {code};' in config
update_api = re.search(r'UPDATE_API = "([^"]*)"', config)[1]
assert update_api == os.environ.get('ORBIT_ANDROID_UPDATE_API', 'https://api.github.com'), 'BuildConfig.UPDATE_API differs'
assert update_api == 'https://api.github.com' or os.environ['ORBIT_ANDROID_SIGNING_PURPOSE'] == 'test'
firebase = {name: os.environ.get(f'ORBIT_ANDROID_FIREBASE_{name}', '') for name in
            ('APP_ID', 'API_KEY', 'PROJECT_ID', 'SENDER_ID', 'ANDROID_PACKAGE')}
for name, value in firebase.items():
    assert f'FIREBASE_{name} = "{value}"' in config, f'BuildConfig.FIREBASE_{name} differs from the supplied value'
with zipfile.ZipFile(p / 'app-release.apk') as apk:
    assert any(source.encode() in apk.read(n) for n in apk.namelist() if re.fullmatch(r'classes\d*\.dex', n)), 'Source SHA absent from packaged DEX'
identity = dict(applicationId=app_id, versionName=version, versionCode=int(code), minSdk=29, targetSdk=36,
                buildType='release', debuggable=False, sourceSha=source, sourceDirty=False,
                apkSha256=hashlib.sha256((p / 'app-release.apk').read_bytes()).hexdigest(),
                certificateSha256=certs[0], signingPurpose=os.environ['ORBIT_ANDROID_SIGNING_PURPOSE'],
                distributionSignature=os.environ['ORBIT_ANDROID_SIGNING_PURPOSE'] == 'release', updateApi=update_api,
                pushConfigured=all(firebase.values()), firebaseProjectId=firebase['PROJECT_ID'] or None)
(p / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
print(json.dumps(identity, indent=2))
PY
