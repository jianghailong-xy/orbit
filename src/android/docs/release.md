# Android S1 internal APK builds

S1 is direct installation of a signed APK on Android 10–16 (minSdk 29, targetSdk 36).
There is no store upload, AAB channel, automatic Android tag release, or deployment in this workflow.
The existing `:app` / `:core`, pinned SDK, Java and Gradle wrapper remain the build system.
See [the event/platform matrix](release-workflows.md) for Apple isolation.

## Version and artifact identity

`gradle.properties` supplies development defaults. A signed build requires explicit
`ORBIT_ANDROID_VERSION_NAME` and `ORBIT_ANDROID_VERSION_CODE`. `versionName` is
`X.Y.Z[-suffix]` (for example `0.1.0-internal.2`), at most 32 characters, matching the
authenticated `X-Orbit-Client: android/<versionName>` telemetry limit. `versionCode`
is an integer in 1..2100000000. Allocate it monotonically for each application ID;
every delivered replacement must have a strictly larger code, including retries
whose APK bytes changed. It is deliberately **not** a branch commit count or a
workflow run number: neither establishes ordering across independent histories/workflows.
The release owner checks the previous artifact manifest before approving a build.
Use a distinct `versionName` for every candidate that must be distinguishable in
backend telemetry; increasing only `versionCode` leaves the reported header unchanged.

Keep the same approved application ID and signing certificate across upgrades.
`io.orbitd.android` is the existing development default, not confirmation of the
final distribution ID. The signed-build script requires an explicit application ID.
Debug APKs have `.debug`; temporary signing verification uses a separate
`*.upgradetest` ID and `ORBIT_ANDROID_SIGNING_PURPOSE=test`.

The script refuses an uncommitted source tree, records full Git HEAD and clean
state, checks APK package/version/min/target SDK, rejects debuggable APKs, verifies
the signer against an independently supplied SHA-256 fingerprint, and checks the
source SHA occurs in packaged DEX. Keep `app-release.apk`, `identity.json`,
`BuildConfig.java`, `badging.txt`, `signing.txt`, and `build.log` together.
The source SHA is injected at build time; even an otherwise unchanged app rebuilt
at another commit has a different build identity and usually a different APK hash.
Two builds with the same source SHA and different version values are distinct APKs;
their manifest and SHA-256, not a filename or “latest beta”, identify each one.

## Signing configuration (reviewable setup; no credentials in this repository)

The manual `Android internal APK` workflow uses the `android-internal` GitHub
environment. Before enabling it, the designated key owner must configure required
reviewers, prevent self-review where available, and allow only the reviewed release
branch. Restrict workflow edits through the repository's review policy. Do not put
these secrets at repository scope for arbitrary branches to consume.

Environment variables:

| Name | Value supplied by the owner |
| --- | --- |
| `ANDROID_APPLICATION_ID` | Confirmed distribution package ID |
| `ANDROID_CERT_SHA256` | Approved certificate fingerprint, from the key owner independently of the uploaded keystore |

Environment secrets:

| Name | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Existing signing keystore, encoded without logging it |
| `ANDROID_STORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Signing key alias |
| `ANDROID_KEY_PASSWORD` | Private key password |

The workflow materializes the keystore only in its temporary runner directory,
restricts file permissions, passes passwords through environment variables and
removes it in an `always()` cleanup step. Only the artifact directory is uploaded.
Do not enable shell tracing, Gradle debug logs/build scans, or publish Gradle caches
from the signing job. Do not regenerate/replace an existing key to make an upgrade pass.
Losing the signing key prevents normal updates under the same package ID.

The final application ID, key custodian, approved certificate and protected secret
entry point must be supplied before a distribution build can be claimed. This
document and workflow do not create those resources or authorize a release.
Ordinary PR CI uses debug signing and requires none of these credentials.

## Local build and verification

Run the original project gate first:

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk bash src/android/gradlew -p src/android --no-daemon --max-workers=2 test lintDebug assembleDebug
node --test scripts/ci/release-workflows.test.mjs
```

For a signed build, use the approved secure environment to export
`ORBIT_ANDROID_APPLICATION_ID`, `ORBIT_ANDROID_VERSION_NAME`,
`ORBIT_ANDROID_VERSION_CODE`, `ORBIT_ANDROID_CERT_SHA256`,
`ORBIT_ANDROID_KEYSTORE_PATH` (absolute, outside the repository),
`ORBIT_ANDROID_STORE_PASSWORD`, `ORBIT_ANDROID_KEY_ALIAS`,
`ORBIT_ANDROID_KEY_PASSWORD`, and `ORBIT_ANDROID_SIGNING_PURPOSE=release`.
Do not put secret values into command history or Gradle property files.

```sh
bash src/android/scripts/build-release.sh /absolute/new/artifact-directory
```

Raw `assembleRelease` without a signing environment can still produce an unsigned
development artifact; it is not the verified distribution entry point above.
The original PR gate continues to run release unit tests without private keys.

## Install and replace without losing state

Use only an authorized test device/account. Save the old and new APKs and their
identities before touching the device. Verify matching package ID and signer,
increasing code, APK SHA-256, and both source SHAs. Capture the real device's
model/API/build fingerprint, installed package version, UID, firstInstallTime and
lastUpdateTime. Never uninstall or `pm clear` between the two versions.

```sh
adb -s DEVICE install old.apk
# Login, populate account/server-scoped cache and draft, then stop the app.
adb -s DEVICE install -r new.apk
# Relaunch: login restored, correct account/server data retained, foreign cache absent.
```

The reproducible local fixture test is `scripts/upgrade-device-test.sh`; its
usage lists the two APKs, same-signer instrumentation APK, device and output
directory. It uses an isolated `*.upgradetest` package, checks an initially absent
package, uses real Android credential/data stores across two processes, and does
not change emulator settings or ports. The complete run must own
`flock /var/lib/orbit/android/ui.lock`. Do not interrupt another task holding it.
Temporary test signatures prove packaging/update mechanics only; never distribute
them as the final signed build. Keep test keystores outside source and evidence archives.

For actual deployment version observation, make an authenticated request after
each install and inspect `ClientVersion` for that user and `kind=android`.
Unauthenticated login requests intentionally do not create a row. An unchanged
version is throttled to one write per hour; a changed version is recorded
immediately. The backend is additive for Android and keeps web/iOS/macOS behavior.
Record the exact backend SHA, request date and observed row; the local PostgreSQL
fixture is not evidence from a real deployment.

## Notes accompanying each candidate

Include: versionName/code, application ID, APK and certificate SHA-256, client
source SHA, required backend SHA/capabilities, device/OS tested, previous APK
identity, install/update results, login/cache/version observations, changes since
the previous candidate and known gaps. Label temporary-signed fixture artifacts
“NOT FOR DISTRIBUTION”. Installation is side-loading via the approved internal
delivery route; never invent a public download or store channel.

A14 establishes this pipeline and local upgrade evidence. Actual signed package,
target devices and authorized deployment evidence remain explicit when absent.
A15 rechecks the final integrated feature combination and cross-platform quality;
this does not make A15 a prerequisite for building or testing A14.
