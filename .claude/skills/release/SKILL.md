---
name: release
description: Cut a release of the macOS client by creating and pushing a vX.Y.Z git tag, which triggers the macos-release GitHub Actions workflow that builds the signed + notarized Orbit.dmg. Use whenever someone wants to cut/ship a release, tag a version, or kick off a release build.
---

# Cut a macOS release

A release is a `vX.Y.Z` git tag. Pushing it triggers
`.github/workflows/macos-release.yml`, which signs + notarizes the macOS client
and uploads `Orbit.dmg` as a build artifact. The tag version flows into the
DMG's `CFBundleShortVersionString` (the workflow exports `VERSION` from the tag
name), so the tag is the single source of truth for the release version.

## How to use

1. **Pick the version.** If the user didn't give one, look at the latest tag and
   propose the next patch/minor — confirm before tagging:

   ```bash
   git tag --list 'v*' --sort=-v:refname | head -1
   ```

2. **Make sure the release commit is `HEAD` and pushed** (`git push origin <branch>`).
   The script refuses a dirty working tree; the tag should point at a committed,
   pushed state so the workflow checks out the right code.

3. **Run the helper** from anywhere (it resolves the repo root itself):

   ```bash
   .claude/skills/release/release.sh 0.2.0      # or: v0.2.0
   ```

   It validates the version is `X.Y.Z`, refuses a dirty tree or an
   already-used tag (local or remote), creates an annotated `vX.Y.Z` tag, and
   pushes it to `origin`.

4. **Watch the build and report the result.** The push triggers the workflow:

   ```bash
   gh run watch "$(gh run list --workflow macos-release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   When it's green, the signed + notarized `Orbit.dmg` is in the run's Artifacts.

## Notes

- Only `X.Y.Z` is accepted (no prerelease suffix) so the version is valid as the
  app's `CFBundleShortVersionString`.
- The release secrets (`DEVID_CERT_*`, `APPLE_*`) must be configured for the
  workflow to succeed — see the header of `.github/workflows/macos-release.yml`.
- To undo a tag pushed by mistake:

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the build if it already started
  ```
