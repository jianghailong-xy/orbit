---
name: release
description: Cut an Orbit client release by creating and pushing one vX.Y.Z git tag, triggering the signed/notarized macOS DMG release, the iOS TestFlight build and the signed Android APK on the same GitHub Release. Use when asked to cut or ship a release, tag a version, publish a beta, TestFlight or Android build, or start the client release workflow. Do not use for ordinary deployments of the Docker Compose stack; use the upgrade skill instead.
---

# Cut an Orbit client release

Use one `vX.Y.Z` tag to ship all three clients through `.github/workflows/release.yml`:

| Job | Output |
| --- | --- |
| `identity` | Refuses the tag unless it is `v` + the root `package.json` version and carries a filled-in `release-notes/<version>.md`; every build job waits for it |
| `dmg` | Signed and notarized macOS DMG, GitHub Release, and Sparkle appcast |
| `testflight` | Signed iOS `.ipa` uploaded to TestFlight |
| `android-build` | Signed Android release APK, from the `android-internal` environment |
| `android-publish` | The APK, its `.sha256` and `android-update.json` attached to the same GitHub Release, after `dmg` and `android-build` succeed |

**The root `package.json` version is the version of record**, and the tag is that version with `v`. The GitHub Release, the DMG/`.zip` names, the TestFlight marketing version, the Android `versionName`, the runner binaries and `/dl/version.json`, the Sparkle appcast and `android-update.json` all derive from it, and `release.yml` refuses a tag that disagrees with the package.

Interpret tags as follows:

- `vX.Y.Z`: macOS stable channel, an iOS TestFlight build and an Android release.
- `vX.Y.Z-beta.N`: macOS beta channel, an iOS TestFlight build and an Android release. iOS uses numeric marketing version `X.Y.Z`; the commit-count build number distinguishes iterations.
- Android uses the tag without `v` as `versionName` and the same commit count as `versionCode`; installed Android apps update to any higher `versionCode`.

## Workflow

1. Resolve the version. `release.sh next` prints the one tag to cut next, resolved from the package version alone; old tags are never read as a sequence:

   ```bash
   .agents/skills/release/scripts/release.sh next
   ```

   While the package version has no tag yet (locally or on `origin`), it is the candidate. Once it is tagged, `next` is the next beta in its series, or `X.Y.(Z+1)-beta.1` after a stable `X.Y.Z`: a beta belongs to the version it precedes. `next` only prints. Pass an explicit version for anything else.

2. If the package version is not the version to release, bump it. This is the release commit: `package.json`, the lockfile and `release-notes/<version>.md` all name the same version.

   ```bash
   .agents/skills/release/scripts/release.sh bump next          # or: bump 0.2.0-beta.3
   ```

   Fill in every section of the notes (`docs/release-notes-template.md`) and commit them. `bump next` while the package version is still untagged and its notes exist changes nothing.

3. Verify the release commit is the committed and pushed `main` tip:

   ```bash
   git rev-parse --abbrev-ref HEAD
   git fetch origin
   git rev-list --count HEAD..origin/main
   ```

   Require `main` and a result of `0`. If a fix exists only on another branch, merge it into `main`; never tag the feature branch.

4. Run the identity gate by hand (`node scripts/release-identity.mjs check-tag vX.Y.Z`), then state the exact resolved tag and the full commit SHA it will point at (`git rev-parse HEAD`) and get explicit user confirmation of both before tagging. Creating and pushing the tag is an external, release-triggering action.

5. Tag it with the version `package.json` already carries:

   ```bash
   .agents/skills/release/scripts/release.sh 0.2.0-beta.3
   ```

   The helper runs the same identity gate as CI (`node scripts/release-identity.mjs check-tag vX.Y.Z`): it refuses a tag that disagrees with `package.json`, missing or placeholder notes, tracked uncommitted changes and an already-used tag (local or remote), then creates an annotated tag and pushes it to `origin`.

6. Watch the shared workflow and report every job result:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   A green `testflight` job means upload completed; App Store Connect may still need processing time and an export-compliance answer. A green `android-publish` job means the Android files are on the release (`gh release view vX.Y.Z --json assets -q '.assets[].name'`); its step summary lists their SHA-256. When `android-build` reports that the commit was already published for Android under another tag, both Android jobs end without publishing, which is expected.

## Constraints

- Accept only `X.Y.Z` or `X.Y.Z-beta.N` versions, and only the one `package.json` carries.
- `scripts/release.sh` is `.claude/skills/release/release.sh`, byte for byte, and this skill follows the same rules (`npm run test:release-identity` checks it). Change both together.
- Every pushed `v*` tag starts all the platform jobs. To build one Apple platform only, dispatch `release.yml` on `main` with `platform=macos` or `platform=ios` instead of creating a tag. Android never runs from a dispatch, and `android-v*` tags start nothing.
- If `dmg` fails, Android is not attached. After the cause is fixed, re-run the failed jobs of that run (`gh run rerun <run-id> --failed`); it rebuilds the DMG and then attaches the Android build already made. Ask before re-running, as it publishes.
- Required signing and publishing secrets are documented in `.github/workflows/release.yml`; Android signing lives only in the `android-internal` environment.
- If a tag was pushed incorrectly, ask for confirmation before deleting the remote/local tag or cancelling its workflow; those are destructive external actions.
