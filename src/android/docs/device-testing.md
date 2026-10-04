# Android device checks

A02 covers the application shell: installation, cold launch, navigation to build
information, system Back, background/resume, and process-stop/relaunch. The shell
has no backend fixture. Business login/UI, notifications, performance measurement,
and the final product matrix belong to their implementation tasks and A15.

## Host and device ownership

The task host provides Java 21 at `/usr/lib/jvm/java-21-openjdk-amd64`, SDK tools
at `/opt/android-sdk`, KVM, and the shared `orbit-ui-api36` AVD on
`emulator-5554`. Its AVD and user directories are
`/var/lib/orbit/android/avd` and `/var/lib/orbit/android/user`.

Both scripts acquire `flock /var/lib/orbit/android/ui.lock`. On this host, device
commands require host access outside the restricted build sandbox. The API 36
emulator is managed by `orbit-android-emulator.service`: use its existing device.
For API 29–35, the smoke script starts one AVD on port 5556 and terminates only
the process it started after saving evidence. An occupied port produces an error;
pass the existing device serial explicitly when reuse is intended. Never run
`adb kill-server`, restart the API 36 service, or operate the device outside the
shared lock while another task uses it.

Other hosts can set `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_AVD_HOME`,
`ANDROID_USER_HOME`, and `ANDROID_DEVICE_LOCK` to their own locations. Use the
same lock path for all users of a shared device. Preparation requires accepted
Android SDK licenses, network access, and enough space for eight system images.
The checked-in entry uses the host's existing command-line tools; every device
run records their actual revision with the emulator, adb, aapt, Java, Python,
and system-image revisions in `tools.txt`.

## Prepare and run API 29–36

```bash
bash src/android/scripts/device-prepare.sh
# A subset is useful on an existing host:
bash src/android/scripts/device-prepare.sh 29 30 31 32 33 34 35
```

Preparation installs missing `google_apis;x86_64` images and creates missing
`orbit-ui-apiNN` AVDs with the Pixel 2 hardware profile. Installed images and
existing AVDs are reused. The default preparation includes API 36; on a new
host, start its AVD on port 5554 before the default API 36 smoke command, or
provide a running device serial explicitly. Image package revisions can change
upstream; compare the recorded revisions before comparing results across hosts.

Build the debug APK using the verification entry in the Android README. Then:

```bash
apk=src/android/app/build/outputs/apk/debug/app-debug.apk
run_id=$(date -u +%Y%m%dT%H%M%SZ)
bash src/android/scripts/device-smoke.sh 29 "$apk" "src/android/build/device/$run_id/api29"
bash src/android/scripts/device-smoke.sh 36 "$apk" "src/android/build/device/$run_id/api36"

# Run each OS version, sequentially, with a fresh result directory:
for api in 29 30 31 32 33 34 35 36; do
  bash src/android/scripts/device-smoke.sh "$api" "$apk" "src/android/build/device/matrix-$run_id/api$api"
done
```

| Android version | API | AVD | A02 requirement |
| --- | --- | --- | --- |
| 10 | 29 | `orbit-ui-api29` | Minimum OS launch and screenshots |
| 11 | 30 | `orbit-ui-api30` | Regression entry prepared |
| 12 | 31 | `orbit-ui-api31` | Regression entry prepared |
| 12L | 32 | `orbit-ui-api32` | Regression entry prepared |
| 13 | 33 | `orbit-ui-api33` | Regression entry prepared |
| 14 | 34 | `orbit-ui-api34` | Regression entry prepared |
| 15 | 35 | `orbit-ui-api35` | Regression entry prepared |
| 16 | 36 | `orbit-ui-api36` | Current target OS launch and screenshots |

The task host was provisioned on 2026-10-04 with image revisions 13, 16, 12, 4,
17, 14, 9, and 7 for API 29 through 36 respectively. API 29–35 use Pixel 2
profiles; the existing shared API 36 AVD retains its Pixel 7 profile.

An available image or AVD does not establish a passing run. The script checks
the running device API before installation and returns nonzero for a failed
check. Use a new output directory for every attempt; failed attempts retain their
raw files and `result.txt` exit code.

## Evidence and manual checklist

Each successful run retains:

- APK SHA-256 and manifest package/version identity, plus the checkout SHA and
  Android working-tree status at execution. The APK's embedded source identity
  is captured separately from the Build information screen; this is the build
  identity to compare when the checkout has advanced.
- Device manufacturer/model, Android release/API, security patch, OS build and
  fingerprint, emulator flag, GMS package version, display, font, locale, and
  rotation settings. A Google APIs emulator establishes emulator behavior only.
- Actual tool/parser and image revisions, a hashed run-conditions JSON document,
  installation/launch output, XML UI hierarchy, activity state, raw logcat and
  crash output, and screenshots for each shell transition.

Review the screenshots for readable text, unobscured controls, and system bar
insets at API 29 and API 36. Confirm the Build information screen identifies the
expected package, full source SHA, build, device, and Android API. Installation
and foreground assertions alone cannot establish visual correctness.

An optional fifth argument copies a run-conditions JSON file into the evidence:

```bash
bash src/android/scripts/device-smoke.sh 36 "$apk" /tmp/a02-api36-run \
  emulator-5554 /path/to/run-conditions.json
```

Use that document for the exact fixture hashes, measurement tool/parser versions,
network/account conditions and run parameters when later tasks add measurements.
Those tasks must pin and validate their own measurement tools before comparison.
A02 records the existing toolchain and raw shell data; it does not run performance
or FCM tests. `am start -W` output is retained as launch diagnostics, not a
performance acceptance result. The entry does not change locale, font scale,
animation settings, or rotation settings.

## Target phone

The owner can install the supplied debug APK locally on the agreed Hong Kong or
Singapore GMS phone. Record its model, actual Android/API and OS build, then open
Orbit, capture the shell and Build information screen, navigate Back, background
and resume it, and force-stop/reopen it. Preserve the supplied APK hash and its
embedded build/source identity together with those screenshots. This process
does not require remote ADB access.

If ADB is already available, the same entry can target that phone:

```bash
bash src/android/scripts/device-smoke.sh 35 "$apk" /tmp/a02-phone-run DEVICE_SERIAL
```

Substitute the phone's actual API and serial. Unlock the phone and approve its
existing USB-debugging pairing before running. Phone evidence remains pending
until a real target phone run is saved; emulator evidence cannot satisfy that
part of A02 acceptance. Release signing is A14 work.

The commands follow the Android Developers documentation for
[AVD creation](https://developer.android.com/tools/avdmanager),
[emulator startup](https://developer.android.com/studio/run/emulator-commandline),
and [ADB installation and capture](https://developer.android.com/tools/adb).
