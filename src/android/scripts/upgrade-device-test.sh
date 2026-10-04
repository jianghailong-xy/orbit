#!/usr/bin/env bash
set -euo pipefail

if (( $# != 5 )); then
  echo "Usage: $0 OLD_RELEASE_APK NEW_RELEASE_APK RELEASE_TEST_APK EVIDENCE_DIR SERIAL" >&2
  exit 2
fi
old_apk="$(realpath "$1")"
new_apk="$(realpath "$2")"
test_apk="$(realpath "$3")"
output="$(realpath -m "$4")"
serial="$5"
for artifact in "$old_apk" "$new_apk" "$test_apk"; do [[ -f "$artifact" ]]; done
mkdir -p "$output"
[[ -z "$(ls -A "$output")" ]] || { echo 'Use a new evidence directory' >&2; exit 2; }
sdk="${ANDROID_HOME:-/opt/android-sdk}"
adb="$sdk/platform-tools/adb"
aapt="$sdk/build-tools/36.0.0/aapt"
apksigner="$sdk/build-tools/36.0.0/apksigner"
package='io.orbitd.android.upgradetest'
runner="$package.test/androidx.test.runner.AndroidJUnitRunner"

# Artifact inspection precedes the lock and never modifies the shared emulator.
sha256sum "$old_apk" "$new_apk" "$test_apk" > "$output/apks.sha256"
for name in old new test; do
  case "$name" in old) artifact="$old_apk" ;; new) artifact="$new_apk" ;; test) artifact="$test_apk" ;; esac
  "$aapt" dump badging "$artifact" > "$output/$name-badging.txt"
  "$apksigner" verify --verbose --print-certs "$artifact" > "$output/$name-signature.txt"
done
"$aapt" dump xmltree "$test_apk" AndroidManifest.xml > "$output/test-manifest.txt"
python3 - "$output" "$package" <<'PY'
import json, pathlib, re, sys
root, package = pathlib.Path(sys.argv[1]), sys.argv[2]
identities = {}
for name in ('old', 'new', 'test'):
    badging = (root / f'{name}-badging.txt').read_text()
    fields = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    assert fields, f'Missing package identity: {name}'
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: (\w+)$', (root / f'{name}-signature.txt').read_text(), re.M)
    assert len(certs) == 1, 'Exactly one signer is required for this fixture'
    identities[name] = dict(package=fields[1], versionCode=int(fields[2]), versionName=fields[3], certificateSHA256=certs[0])
    if name != 'test':
        assert 'application-debuggable' not in badging, 'Target must be a non-debuggable release APK'
        assert "sdkVersion:'29'" in badging, 'Expected minSdk29'
old, new, test = (identities[k] for k in ('old', 'new', 'test'))
assert old['package'] == new['package'] == package
assert test['package'] == package + '.test'
assert old['versionCode'] < new['versionCode'], 'Upgrade must increase versionCode'
assert old['versionName'] != new['versionName'], 'Upgrade must have a distinguishable versionName'
assert old['certificateSHA256'] == new['certificateSHA256'] == test['certificateSHA256'], 'App/test APKs must use the same isolated test certificate'
assert re.search(r'android:targetPackage[^\n]*"' + re.escape(package) + r'"', (root / 'test-manifest.txt').read_text())
(root / 'identities.json').write_text(json.dumps(identities, indent=2) + '\n')
PY

exec 9>"${ANDROID_DEVICE_LOCK:-/var/lib/orbit/android/ui.lock}"
flock -w 600 9
cleanup() {
  local result=$?
  printf 'exit_code=%s\nfinished_utc=%s\n' "$result" "$(date -u +%FT%TZ)" >> "$output/result.txt"
}
trap cleanup EXIT
printf 'scope=A14 isolated non-production signing; local auth fixture; emulator/device identity below\nstarted_utc=%s\n' "$(date -u +%FT%TZ)" > "$output/result.txt"
[[ "$("$adb" -s "$serial" get-state)" == device ]]
api="$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
[[ "$api" =~ ^(29|3[0-6])$ ]] || { echo 'Expected API29–36' >&2; exit 1; }
"$adb" -s "$serial" shell pm list packages "$package" > "$output/packages-before.txt"
if grep -Fxq "package:$package" "$output/packages-before.txt"; then
  echo 'Isolated target package is already installed. Use a fresh disposable device/profile; this script never removes app data.' >&2
  exit 1
fi
{
  printf 'serial=%s\n' "$serial"
  for property in ro.product.model ro.build.version.release ro.build.version.sdk ro.build.fingerprint ro.build.version.security_patch ro.kernel.qemu; do
    printf '%s=%s\n' "$property" "$("$adb" -s "$serial" shell getprop "$property" | tr -d '\r')"
  done
} > "$output/device.txt"

run_phase() {
  local phase="$1" identity="$2"
  local version_name version_code start pid
  version_name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["versionName"])' "$output/identities.json" "$identity")"
  version_code="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["versionCode"])' "$output/identities.json" "$identity")"
  "$adb" -s "$serial" shell am force-stop "$package"
  start="$("$adb" -s "$serial" shell date +%s | tr -d '\r').000"
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class io.orbitd.android.release.UpgradeDeviceTest \
    -e a14_phase "$phase" -e a14_expected_version_name "$version_name" \
    -e a14_expected_version_code "$version_code" "$runner" > "$output/$phase.txt" 2>&1
  cat "$output/$phase.txt"
  grep -F 'OK (1 test)' "$output/$phase.txt" >/dev/null
  if grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -[234]' "$output/$phase.txt"; then return 1; fi
  pid="$(python3 -c 'import pathlib,re,sys; p=set(re.findall(r"a14_pid=(\d+)",pathlib.Path(sys.argv[1]).read_text())); assert len(p)==1; print(p.pop())' "$output/$phase.txt")"
  "$adb" -s "$serial" logcat -d -v threadtime --pid="$pid" -T "$start" > "$output/$phase-logcat.txt"
  [[ -s "$output/$phase-logcat.txt" ]]
}

"$adb" -s "$serial" install "$old_apk" > "$output/install-old.txt" 2>&1
"$adb" -s "$serial" install -r "$test_apk" > "$output/install-tests.txt" 2>&1
run_phase seed old
"$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-before-upgrade.txt"
"$adb" -s "$serial" shell am force-stop "$package"
"$adb" -s "$serial" install -r "$new_apk" > "$output/install-upgrade.txt" 2>&1
"$adb" -s "$serial" shell dumpsys package "$package" > "$output/package-after-upgrade.txt"
run_phase verify new
python3 - "$output" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
def installed(name):
    text = (root / f'package-{name}-upgrade.txt').read_text()
    return {key: re.search(pattern, text)[1].strip() for key, pattern in {
        'uid': r'\buserId=(\d+)', 'firstInstallTime': r'firstInstallTime=([^\r\n]+)',
        'versionCode': r'\bversionCode=(\d+)', 'versionName': r'\bversionName=([^\r\n]+)',
    }.items()}
before, after = installed('before'), installed('after')
assert before['uid'] == after['uid'], 'UID must survive replacement'
assert before['firstInstallTime'] == after['firstInstallTime'], 'First install time must survive replacement'
identities = json.loads((root / 'identities.json').read_text())
for phase, which, actual in [('seed', 'old', before), ('verify', 'new', after)]:
    text = (root / f'{phase}.txt').read_text()
    runtime = dict(re.findall(r'INSTRUMENTATION_STATUS: (a14_\w+)=(.*)', text))
    artifact = identities[which]
    assert actual['versionCode'] == str(artifact['versionCode']) == runtime['a14_version_code']
    assert actual['versionName'] == artifact['versionName'] == runtime['a14_version_name']
    assert runtime['a14_client_version'] == artifact['versionName']
    assert re.fullmatch(r'[0-9a-f]{40}', runtime['a14_source'])
    artifact['runtime'] = runtime
for name in ('install-old.txt', 'install-tests.txt', 'install-upgrade.txt'):
    assert re.search(r'^Success\s*$', (root / name).read_text(), re.M), f'Installation failed: {name}'
assert identities['old']['runtime']['a14_pid'] != identities['new']['runtime']['a14_pid']
for log in root.glob('*.txt'):
    content = log.read_bytes()
    for secret in (b'a14-fixture-access', b'a14-fixture-refresh', b'a14-fixture-password'):
        assert secret not in content, f'Fixture credential in {log.name}'
(root / 'identities.json').write_text(json.dumps(identities, indent=2) + '\n')
(root / 'checks.json').write_text(json.dumps(dict(
    scope='Temporary test signature and local synthetic auth fixture; no production backend or real-device claim',
    install='Fresh install followed by adb install -r; no uninstall or data clear',
    before=before, after=after,
    checks=['same signer', 'increased versionCode', 'non-debuggable release', 'same UID and firstInstallTime',
            'real production Application login restored', 'Keystore credential survived',
            'four account/server data namespaces survived without crossing', 'logout cleared credentials and data',
            'runtime BuildConfig matches package version and AuthSession clientVersion'],
), indent=2) + '\n')
PY
printf 'PASS: A14 API%s APK replacement; evidence: %s\n' "$api" "$output"
