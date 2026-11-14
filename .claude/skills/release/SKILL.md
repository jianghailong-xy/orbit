---
name: release
description: Cut a release of the Orbit clients by creating and pushing one vX.Y.Z git tag, which triggers the macOS release (signed + notarized DMG), the iOS release (TestFlight build) and the Android release (signed APK on the same GitHub Release) from the same tag. Use whenever someone wants to cut/ship a release, tag a version, push a TestFlight, beta or Android build, or kick off a release build.
---

# Cut a release (macOS + iOS + Android from one tag)

A release is a single git tag — `vX.Y.Z`. Pushing it runs every job of `.github/workflows/release.yml`
from that same tag, so one command ships all three clients together:

| Job (in `release.yml`) | Output |
|------------------------|--------|
| `identity` | Refuses the tag unless it is `v` + the root `package.json` version and carries a filled-in `release-notes/<version>.md`; every build job waits for it |
| `dmg` | macOS: signed + notarized DMG, a GitHub Release whose body is those release notes, and the Sparkle auto-update appcast |
| `testflight` | iOS: signed `.ipa` archived and uploaded to TestFlight |
| `android-build` | Android: signed release APK (signing key from the `android-internal` environment) |
| `android-publish` | Android: attaches `orbit-android-<version>.apk`, its `.sha256` and `android-update.json` to the **same GitHub Release** `dmg` created; installed Android apps update themselves from it |

**The root `package.json` version is the version of record**, and the tag is that version with `v`. Every
surface derives from it: the GitHub Release, the DMG/`.zip` names and `CFBundleShortVersionString`, the
TestFlight marketing version (numeric, suffix stripped), the Android `versionName`, the runner binaries and
`/dl/version.json`, the Sparkle appcast and `android-update.json`. `release.yml` refuses a tag that disagrees
with the package, so the two cannot drift.

- `vX.Y.Z` → macOS **stable** channel (reaches everyone) **+** an iOS TestFlight build.
- `vX.Y.Z-beta.N` → macOS **beta** channel (only users who enabled "Receive beta updates") **+** an
  iOS TestFlight build. The `-beta.N` suffix is a macOS/Sparkle concept; iOS strips it to a numeric
  marketing version (`v0.2.0-beta.3` → TestFlight `0.2.0`), and the build number (commit count)
  carries the beta iteration on TestFlight.
- Android, either way: `versionName` is the tag without `v` (`0.2.0-beta.3`, suffix kept) and
  `versionCode` is the same commit count as the iOS build number. Every Android phone on an older
  version is offered the new one, beta or stable.

## How to use

1. **Pick the version.** `release.sh next` prints the one tag to cut next, resolved from the **package
   version** alone (old tags are never read as a sequence): the package version itself while it has no
   tag yet (the release commit is prepared and waiting), otherwise the next beta in the current series,
   or `X.Y.(Z+1)-beta.1` once a stable version is the package version. It only prints. Confirm it before
   bumping; pass an explicit version for anything else (a stable release, or opening a new minor).

   **A beta belongs to the version it precedes, not the one already out.** `0.1.1-beta.2` sorts
   *below* `0.1.1`, so once `X.Y.Z` ships stable, its betas are spent — the next beta must open on
   `X.Y.(Z+1)`. `next` handles the bump.

2. **Bump the package and open the notes.** This is the release commit: `package.json`, the lockfile and
   `release-notes/<version>.md` all name the same version.

   ```bash
   .claude/skills/release/release.sh bump next          # or: bump 0.2.0-beta.3
   ```

   `bump next` while the package version is still untagged and its notes exist changes nothing.

   Fill in every section of the notes file (`docs/release-notes-template.md`), commit it, and make sure
   the branch is `main` synced with `origin/main` before tagging. Tagging a feature/session branch — or
   a `main` that's behind `origin/main` — ships a tree that's missing whatever landed on `main` in
   parallel, so the release silently **drops those features and can revert already-merged fixes**.

   ```bash
   git rev-parse --abbrev-ref HEAD                     # → main
   git fetch origin && git rev-list --count HEAD..origin/main   # → 0 (nothing on origin/main you're missing)
   ```

3. **Confirm the exact tag and commit.** Run the identity gate by hand
   (`node scripts/release-identity.mjs check-tag vX.Y.Z`), then state the exact tag and the full commit SHA
   it will point at (`git rev-parse HEAD`) and get explicit confirmation of both before tagging: creating
   and pushing the tag is an external, release-triggering action.

4. **Tag it** (resolves the repo root itself). It runs the same identity gate as CI, refuses a dirty
   tree, a tag that disagrees with `package.json`, missing or placeholder notes, and an already-used tag
   (local or remote), then creates an annotated tag and pushes it:

   ```bash
   .claude/skills/release/release.sh 0.2.0-beta.3    # the version package.json already carries
   ```

5. **Watch the build and report the result.** All five jobs run in the one `release.yml` run:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   - **`dmg` (macOS):** when green, the signed + notarized DMG is in the run's Artifacts and a GitHub Release.
   - **`testflight` (iOS):** when green, the build is uploaded, then needs a few minutes of App Store
     Connect processing (and a one-time export-compliance answer) before it shows up in TestFlight.
   - **`android-build` / `android-publish` (Android):** `android-publish` waits for `dmg` and
     `android-build`; when green, the release lists `orbit-android-<version>.apk`, its `.sha256` and
     `android-update.json` (`gh release view vX.Y.Z --json assets -q '.assets[].name'`), and the job's
     summary shows their SHA-256. If the commit already went out for Android under another tag,
     `android-build` says so and both Android jobs end without publishing; that is not a failure.
   - **Re-publishing Android:** if `dmg` failed, Android is not attached. Fix the cause, then use
     **Re-run failed jobs** on that run (`gh run rerun <run-id> --failed`): the DMG is built again and
     the APK `android-build` already made is attached after it. Ask before re-running: it publishes. An
     `android-build` that refused the version (the commit count must grow) needs a new commit and a new tag.

## Notes

- `.agents/skills/release/` carries the same rules for other engines; its `scripts/release.sh` is this
  `release.sh`, byte for byte (`npm run test:release-identity` checks it). Change both together.
- Accepted: `X.Y.Z` (stable) or `X.Y.Z-beta.N` (macOS beta channel). iOS always ships the numeric
  `X.Y.Z` to TestFlight regardless of suffix.
- **One tag fires all three** — every `v*` tag also uploads an iOS TestFlight build (two `macos-15`
  runner jobs) and publishes Android (two `ubuntu-24.04` jobs). To build only one Apple platform, skip
  the tag and dispatch with the `platform` input: `gh workflow run release.yml --ref main -f platform=macos`
  (or `-f platform=ios`). A dispatch with no tag builds each client's default version. Android has no
  dispatch: it builds and publishes on `v*` tag pushes only. `android-v*` tags are retired and start nothing.
- Required secrets are in the `release.yml` header:
  - macOS `dmg`: `DEVID_CERT_P12_BASE64`, `DEVID_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
    `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `SPARKLE_ED_PRIVATE_KEY`.
  - iOS `testflight`: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, `APPLE_TEAM_ID`.
  - Android `android-build`: the `android-internal` environment (v* tags only) — secrets
    `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
    variables `ANDROID_APPLICATION_ID`, `ANDROID_CERT_SHA256` (see `src/android/docs/release.md`).
- To undo a tag pushed by mistake (one run holds all the jobs), ask for confirmation before deleting the
  tag or cancelling its run: both are destructive external actions.

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the release.yml run if it already started
  ```

  Once `android-publish` has attached `android-update.json`, installed Android apps may already be
  offered that version: say so when reporting the mistake rather than quietly deleting the release.
