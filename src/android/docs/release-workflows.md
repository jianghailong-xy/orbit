# Release workflow isolation

Android S1 uses a signed APK installed directly on Android 10–16 (minSdk 29).
`android-release.yml` only creates an Actions artifact. It has no store upload or
GitHub Release step. The existing Apple workflow retains its three platform
choices; `both` means macOS and iOS.

| Event / selection | macOS DMG | iOS TestFlight | Android signed APK |
| --- | --- | --- | --- |
| Push `v*` tag | Build and publish | Build and upload | No |
| Dispatch `release.yml`, `both` | Build | Build and upload | No |
| Dispatch `release.yml`, `macos` | Build | No | No |
| Dispatch `release.yml`, `ios` | No | Build and upload | No |
| Dispatch `release.yml`, input omitted (default `both`) | Build | Build and upload | No |
| Dispatch `release.yml`, effective invalid/empty platform | No | No | No |
| Dispatch `android-release.yml` | No | No | Build artifact |
| Pull request | No release job | No release job | Debug CI only; no release secrets |
| Branch push / non-`v*` tag | No release job | No release job | No release job |

Manual Apple runs on a tag can build with the tag version, but macOS publishing
(GitHub Release, Sparkle appcast, Pages) requires an actual `v*` tag **push**.
Manual iOS runs retain the existing TestFlight upload behavior. None of these
manual or tag-triggered remote workflows is executed by the local A14 checks.

Before an authorized Android run, configure the `android-internal` environment
with required reviewers and allowed release source refs. Store credentials only
as environment secrets: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and
`ANDROID_KEY_PASSWORD`. Set environment variables
`ANDROID_APPLICATION_ID` and `ANDROID_CERT_SHA256` to the reviewed application ID
and signing certificate SHA-256. Do not put the keystore or passwords in source,
repository-wide secrets, Gradle properties, or artifact directories. The workflow
contains configuration references only; it does not create the environment,
review rules, or credentials.

The reviewer must check the selected source SHA, application ID, certificate, and
explicit `version_name` / monotonically increasing `version_code` against the last
distributed APK. Serialization prevents concurrent runs but does not reserve a
version code. Re-running a job is still subject to that review.

The build step restores the keystore to a private runner temporary file and
removes it on exit and in an `always()` cleanup step. Signing secrets are scoped
to that step. Checkout has read-only access and does not persist its credentials.
The output contains the signed APK and public identity evidence, never key material.
The build script verifies the expected certificate before upload.

Local checks (no credentials or remote workflow execution):

```sh
node --test scripts/ci/release-workflows.test.mjs
actionlint .github/workflows/release.yml .github/workflows/android.yml .github/workflows/android-release.yml
```

The matrix tests read the actual workflow predicates and exercise manual choices,
stable/beta tags, non-release tags, branch pushes, PRs, and unsupported events.
They also require a dispatch-only Android workflow and absence of production
signing secrets from ordinary Android CI. `actionlint` validates the complete YAML
and GitHub Actions expression syntax. Neither check proves that private signing
resources or a future hosted runner work; those need their own authorized run.
