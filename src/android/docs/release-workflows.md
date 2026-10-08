# Release workflow isolation

Android S1 uses a signed APK installed directly on Android 10–16 (minSdk 29). One
`v*` tag ships all three clients through `release.yml`: `dmg` (macOS) creates the
GitHub Release, `testflight` uploads iOS, `android-build` builds and signs the APK,
and `android-publish` attaches the APK, its `.sha256` and `android-update.json` to
that same Release. Android has no store upload, Apple tooling or dispatch entry; the
dispatch keeps its three Apple choices, and `both` means macOS and iOS.

| Event / selection | `dmg` (macOS) | `testflight` (iOS) | `android-build` | `android-publish` |
| --- | --- | --- | --- | --- |
| Push `v*` tag | Build and publish | Build and upload | Build and sign | Attach, after `dmg` and `android-build` succeeded |
| Push `v*` tag, commit already published for Android | Build and publish | Build and upload | Check only, then skip quietly | Skipped |
| Dispatch `release.yml`, `both` | Build | Build and upload | No | No |
| Dispatch `release.yml`, `macos` | Build | No | No | No |
| Dispatch `release.yml`, `ios` | No | Build and upload | No | No |
| Dispatch `release.yml`, input omitted (default `both`) | Build | Build and upload | No | No |
| Dispatch `release.yml`, effective invalid/empty platform | No | No | No | No |
| Push `android-v*` tag (retired) | No (`release.yml` not started) | No | No | No |
| Pull request | No release job | No release job | No release job | No release job (debug CI only, no release secrets) |
| Branch push (including a branch named `v…` or `android-v…`) / other tags | No release job | No release job | No release job | No release job |

GitHub tag filters match the whole tag name: `v*` never matches `android-v0.1.0`.
`client.yml`, `android.yml`, `ci.yml`, `docs.yml`, `pages.yml` and
`probe-dispatch.yml` filter on branches only, and `android-release.yml` no longer
exists, so an `android-v*` tag starts no workflow at all. Every job guard in
`release.yml` names its event explicitly (`github.event_name == 'push' &&
github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')`, or the dispatch
with `both`/`macos`/`ios`); none is a negation such as `platform != 'ios'`, which
an added option would have matched. Manual Apple runs on a tag can build with the
tag version, but macOS publishing (GitHub Release, Sparkle appcast, Pages) and both
Android jobs require an actual `v*` tag **push**.

## Jobs and credentials

The coordinator configures the `android-internal` environment to accept only `v*`
tags, with no required reviewers (pushing the tag is the release decision):

- secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`;
- variables `ANDROID_APPLICATION_ID` (`io.orbitd.android`) and
  `ANDROID_CERT_SHA256` (the approved certificate fingerprint);
- optional variables `ANDROID_FIREBASE_APP_ID`, `ANDROID_FIREBASE_API_KEY`,
  `ANDROID_FIREBASE_PROJECT_ID`, `ANDROID_FIREBASE_SENDER_ID`,
  `ANDROID_FIREBASE_ANDROID_PACKAGE`: non-secret Firebase client values, all or
  none (none keeps push off). No service account is read anywhere in this workflow.

`android-build` (environment `android-internal`, `contents: read`, a full checkout
without persisted credentials) first checks the tag and the release history
(`github-release.py validate`): `versionName` is the tag without `v`,
`versionCode` is `git rev-list --count HEAD`, and it must exceed the `versionCode`
of every `android-update.json` published on a v* release of the package. If one of
them was built from this very commit (a second tag on it), every later step is
skipped and the job succeeds with a notice. Otherwise it runs the original
verification gate, restores the keystore into a private runner file (`umask
077`), builds with `build-release.sh` (which verifies package, version, min/target
SDK, non-debuggable release and the signer against `ANDROID_CERT_SHA256`) and
deletes the keystore on exit and in an `always()` step. Only that build step
references the secrets. No shell tracing, Gradle `--info/--debug` or build scans are
used. The APK and its `identity.json` go to the publishing job as a run artifact.

`android-publish` (`needs: [dmg, android-build]`, `contents: write`, no environment,
no secrets) downloads that artifact and writes `android-update.json` and the
`.sha256` file. It fails if the tag's release does not exist (the `dmg` job creates
it), is a draft or already has `android-update.json`; it re-reads the history and
skips quietly if this commit was published by another tag meanwhile. It uploads the
APK and `.sha256` with `gh release upload` (never `--clobber`; a file left by an
earlier attempt is skipped only when its SHA-256 matches), then
`android-update.json` last, since installed apps act only on releases that carry
it. Finally it downloads every attached Android file and compares it with the
verified one; its step summary lists them with their SHA-256. It never creates or
edits the release, so the pre-release flag and `latest` stay what `dmg` set.

The workflow keeps its `concurrency: release-${{ github.ref }}` (one run per tag).

## Watching, failures and re-publishing

- The tag's `release.yml` run shows all four jobs. A failed `dmg` leaves
  `android-publish` skipped: fix the cause and use **Re-run failed jobs**, which
  builds the DMG again and then attaches Android with the APK `android-build`
  already made. A failed `android-build` can be re-run the same way. (`dmg`'s own
  re-run stops at `gh release create` if the failed attempt had already created the
  release; that is the macOS job's behavior, unchanged here.)
- A failed `android-publish` is re-run on its own. If it got as far as attaching
  `android-update.json`, the release is published and the re-run refuses to touch
  it; check the files with `gh release view vX.Y.Z --json assets`.
- A tag whose `android-build` refused the version (not increasing) needs a new
  commit: the commit count is the version code.
- This repository's releases must stay mutable (GitHub's immutable releases off):
  Android is attached after `dmg` publishes the release.

## Local checks (no credentials or remote execution)

```sh
node --test scripts/ci/release-workflows.test.mjs
actionlint .github/workflows/release.yml .github/workflows/android.yml
```

The matrix tests read the actual job guards, `needs` and `on:` filters of every
workflow in `.github/workflows`, model GitHub's tag/branch filter rules and
job-dependency success, and assert that a `v*` push selects all four jobs, that
dispatch `both`/`macos`/`ios` never selects Android, that pull requests, branch
pushes and `android-v*` tags start no release job, that `android-publish` waits for
`dmg` and `android-build`, that the signing environment and secrets appear only in
`android-build` (its build step), that publishing never creates, edits or
overwrites, and that ordinary Android CI has no signing material. They also run
`github-release.py` against a stand-in GitHub: increasing `versionCode`, the quiet
skip for an already published commit, and the refusal to publish over an existing
`android-update.json`. `actionlint` validates the complete YAML and expression
syntax. Neither check executes the hosted workflow; its run record is separate
evidence.
