---
name: release
description: Cut a release of the Orbit clients by creating and pushing one vX.Y.Z git tag, which triggers the macOS release (signed + notarized DMG), the iOS release (TestFlight build) and the Android release (signed APK on the same GitHub Release) from the same tag. Use whenever someone wants to cut/ship a release, tag a version, push a TestFlight, beta or Android build, or kick off a release build.
---

# Cut a release (macOS + iOS + Android from one tag)

A release is a single git tag — `vX.Y.Z`. Pushing it runs every job of `.github/workflows/release.yml`
from that same tag, so one command ships all three clients together:

| Job (in `release.yml`) | Output |
|------------------------|--------|
| `dmg` | macOS: signed + notarized DMG, a GitHub Release, and the Sparkle auto-update appcast |
| `testflight` | iOS: signed `.ipa` archived and uploaded to TestFlight |
| `android-build` | Android: signed release APK (signing key from the `android-internal` environment) |
| `android-publish` | Android: attaches `orbit-android-<version>.apk`, its `.sha256` and `android-update.json` to the **same GitHub Release** `dmg` created; installed Android apps update themselves from it |

The tag is the single source of truth for the version:

- `vX.Y.Z` → macOS **stable** channel (reaches everyone) **+** an iOS TestFlight build.
- `vX.Y.Z-beta.N` → macOS **beta** channel (only users who enabled "Receive beta updates") **+** an
  iOS TestFlight build. The `-beta.N` suffix is a macOS/Sparkle concept; iOS strips it to a numeric
  marketing version (`v0.2.0-beta.3` → TestFlight `0.2.0`), and the build number (commit count)
  carries the beta iteration on TestFlight.
- Android, either way: `versionName` is the tag without `v` (`0.2.0-beta.3`, suffix kept) and
  `versionCode` is the same commit count as the iOS build number. Every Android phone on an older
  version is offered the new one, beta or stable.

## How to use

1. **Pick the version.** `release.sh next` resolves it from the newest tag — the next beta in the
   current series, or `X.Y.(Z+1)-beta.1` if the newest tag is a stable release. Confirm the
   resolved version before tagging; pass an explicit version for anything else (a stable release,
   or opening a new minor).

   ```bash
   git -c versionsort.suffix=-beta tag --list 'v*' --sort=-v:refname | head -1
   ```

   **A beta belongs to the version it precedes, not the one already out.** `0.1.1-beta.2` sorts
   *below* `0.1.1`, so once `X.Y.Z` ships stable, its betas are spent — the next beta must open on
   `X.Y.(Z+1)`. Missing that bump is what left the counter running to `0.1.1-beta.100` on a version
   that was never released. `next` handles the bump; if you pass a version by hand, check it
   sorts above the newest stable tag.

2. **Always cut from `main`, synced with `origin/main`.** Check out `main` and pull before tagging.
   Tagging a feature/session branch — or a `main` that's behind `origin/main` — ships a tree that's
   missing whatever landed on `main` in parallel, so the release silently **drops those features and
   can revert already-merged fixes**. The tag must point at a committed, pushed `main` tip so both
   workflows check out the right code. Verify before tagging:

   ```bash
   git rev-parse --abbrev-ref HEAD                     # → main
   git fetch origin && git rev-list --count HEAD..origin/main   # → 0 (nothing on origin/main you're missing)
   ```

   If a fix lives only on another branch, merge it into `main` first — never tag the branch directly.

3. **Run the helper** (resolves the repo root itself):

   ```bash
   .claude/skills/release/release.sh next            # next beta after the newest tag
   .claude/skills/release/release.sh 0.2.0           # stable macOS + iOS TestFlight
   .claude/skills/release/release.sh 0.2.0-beta.3    # macOS beta channel + iOS TestFlight
   ```

   It validates the version, refuses a dirty tree or an already-used tag (local or remote), creates
   an annotated `vX.Y.Z` tag, and pushes it to `origin`.

4. **Watch the build and report the result.** All four jobs run in the one `release.yml` run:

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
     the APK `android-build` already made is attached after it. An `android-build` that refused the
     version (the commit count must grow) needs a new commit and a new tag.

## Notes

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
- To undo a tag pushed by mistake (one run holds all the jobs):

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the release.yml run if it already started
  ```

  Once `android-publish` has attached `android-update.json`, installed Android apps may already be
  offered that version: say so when reporting the mistake rather than quietly deleting the release.
