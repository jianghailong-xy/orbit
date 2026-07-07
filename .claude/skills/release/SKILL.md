---
name: release
description: Cut a release of the Orbit clients by creating and pushing one vX.Y.Z git tag, which triggers BOTH the macOS release (signed + notarized DMG) and the iOS release (TestFlight build) from the same tag. Use whenever someone wants to cut/ship a release, tag a version, push a TestFlight or beta build, or kick off a release build.
---

# Cut a release (macOS + iOS from one tag)

A release is a single git tag — `vX.Y.Z`. Pushing it runs both jobs of `.github/workflows/release.yml`
from that same tag, so one command ships both clients together:

| Job (in `release.yml`) | Output |
|------------------------|--------|
| `dmg` | macOS: signed + notarized DMG, a GitHub Release, and the Sparkle auto-update appcast |
| `testflight` | iOS: signed `.ipa` archived and uploaded to TestFlight |

The tag is the single source of truth for the version:

- `vX.Y.Z` → macOS **stable** channel (reaches everyone) **+** an iOS TestFlight build.
- `vX.Y.Z-beta.N` → macOS **beta** channel (only users who enabled "Receive beta updates") **+** an
  iOS TestFlight build. The `-beta.N` suffix is a macOS/Sparkle concept; iOS strips it to a numeric
  marketing version (`v0.2.0-beta.3` → TestFlight `0.2.0`), and the build number (commit count)
  carries the beta iteration on TestFlight.

## How to use

1. **Pick the version.** If the user didn't give one, look at the latest tag and propose the next
   patch/minor — confirm before tagging:

   ```bash
   git tag --list 'v*' --sort=-v:refname | head -1
   ```

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
   .claude/skills/release/release.sh 0.2.0          # stable macOS + iOS TestFlight
   .claude/skills/release/release.sh 0.2.0-beta.3   # macOS beta channel + iOS TestFlight
   ```

   It validates the version, refuses a dirty tree or an already-used tag (local or remote), creates
   an annotated `vX.Y.Z` tag, and pushes it to `origin`.

4. **Watch the build and report the result.** Both jobs run in the one `release.yml` run:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   - **`dmg` (macOS):** when green, the signed + notarized DMG is in the run's Artifacts and a GitHub Release.
   - **`testflight` (iOS):** when green, the build is uploaded, then needs a few minutes of App Store
     Connect processing (and a one-time export-compliance answer) before it shows up in TestFlight.

## Notes

- Accepted: `X.Y.Z` (stable) or `X.Y.Z-beta.N` (macOS beta channel). iOS always ships the numeric
  `X.Y.Z` to TestFlight regardless of suffix.
- **One tag fires both** jobs — every `v*` tag also uploads an iOS TestFlight build (two `macos-15`
  runner jobs). To build only one platform, skip the tag and dispatch with the `platform` input:
  `gh workflow run release.yml --ref main -f platform=macos` (or `-f platform=ios`). A dispatch with
  no tag builds each client's default version.
- Required secrets are in the `release.yml` header:
  - macOS `dmg`: `DEVID_CERT_P12_BASE64`, `DEVID_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
    `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `SPARKLE_ED_PRIVATE_KEY`.
  - iOS `testflight`: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, `APPLE_TEAM_ID`.
- To undo a tag pushed by mistake (one run holds both jobs):

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the release.yml run if it already started
  ```
