# Release workflow isolation

Android S1 uses a signed APK installed directly on Android 10–16 (minSdk 29).
`android-release.yml` publishes it as a GitHub **pre-release** when an
`android-v<versionName>` tag is pushed. It has no store upload, Apple tooling or
dispatch entry. The existing Apple workflow keeps its three platform choices;
`both` means macOS and iOS.

| Event / selection | macOS DMG | iOS TestFlight | Android signed APK + GitHub pre-release |
| --- | --- | --- | --- |
| Push `v*` tag | Build and publish | Build and upload | No (`android-release.yml` not started) |
| Push `android-v*` tag | No (`release.yml` not started) | No | Build, sign, publish |
| Dispatch `release.yml`, `both` | Build | Build and upload | No |
| Dispatch `release.yml`, `macos` | Build | No | No |
| Dispatch `release.yml`, `ios` | No | Build and upload | No |
| Dispatch `release.yml`, input omitted (default `both`) | Build | Build and upload | No |
| Dispatch `release.yml`, effective invalid/empty platform | No | No | No |
| Pull request | No release job | No release job | Debug CI only; no release secrets |
| Branch push (including a branch named `android-v…`) / other tags | No release job | No release job | No release job |

GitHub tag filters match the whole tag name: `v*` never matches `android-v0.1.0`,
and `android-v*` never matches `v0.1.0`. `client.yml`, `android.yml`, `ci.yml`,
`docs.yml` and `pages.yml` filter on branches only, so no other workflow — and no
macOS runner — starts for an `android-v*` tag. Manual Apple runs on a tag can build
with the tag version, but macOS publishing (GitHub Release, Sparkle appcast, Pages)
requires an actual `v*` tag **push**.

## Jobs and credentials

The owner configured the `android-internal` environment to accept only `android-v*`
tags, with no required reviewers (pushing the tag is the release decision):

- secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`;
- variables `ANDROID_APPLICATION_ID` (`io.orbitd.android`) and
  `ANDROID_CERT_SHA256` (the approved certificate fingerprint);
- optional variables `ANDROID_FIREBASE_APP_ID`, `ANDROID_FIREBASE_API_KEY`,
  `ANDROID_FIREBASE_PROJECT_ID`, `ANDROID_FIREBASE_SENDER_ID`,
  `ANDROID_FIREBASE_ANDROID_PACKAGE`: non-secret Firebase client values, all or
  none (none keeps push off). No service account is read anywhere in this workflow.

`apk` (environment `android-internal`, `contents: read`) first checks the tag
against `orbitVersionName`/`orbitVersionCode` in `src/android/gradle.properties`
at the tagged commit and against every published `android-v*` release
(`github-release.py validate`), then runs the original verification gate, then
restores the keystore into a private runner file (`umask 077`), builds with
`build-release.sh` (which verifies package, version, min/target SDK,
non-debuggable release and the signer against `ANDROID_CERT_SHA256`) and deletes
the keystore on exit and in an `always()` step. Only this step references the
secrets. No shell tracing, Gradle `--info/--debug` or build scans are used.

`publish` (`contents: write`, no environment, no secrets) downloads that job's
artifact, re-reads the release history, writes `android-update.json`, the
`.sha256` file and release notes (the annotated tag message), creates the
pre-release with `--verify-tag --prerelease --latest=false` (so
`releases/latest` stays the macOS release), then downloads every published asset
and compares it with the verified files.

`concurrency: android-internal-release` runs one release at a time; GitHub keeps
only the newest pending run, so push release tags one after another. A run that
fails before publishing leaves no release; fix the cause, delete the tag
(`git push origin :refs/tags/android-vX`) and push it again.

## Local checks (no credentials or remote execution)

```sh
node --test scripts/ci/release-workflows.test.mjs
actionlint .github/workflows/release.yml .github/workflows/android.yml .github/workflows/android-release.yml
```

The matrix tests read the actual workflow predicates and `on:` filters of every
workflow in `.github/workflows`, model GitHub's tag/branch filter rules, and assert
that `android-v*` tags start only `android-release.yml` (no Apple tooling), `v*`
tags start only `release.yml`, branch pushes never start the Android release,
secrets appear only in the signing step, publishing has no environment or
secrets, and ordinary Android CI has no signing material. `actionlint` validates
the complete YAML and expression syntax. Neither check executes the hosted
workflow; its run record is separate evidence.
