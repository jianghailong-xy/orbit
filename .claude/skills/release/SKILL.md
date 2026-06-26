---
name: release
description: Cut a release of the macOS client by creating and pushing a vX.Y.Z git tag, which triggers the macos-release GitHub Actions workflow that builds the signed + notarized Orbit DMG. Use whenever someone wants to cut/ship a release, tag a version, or kick off a release build.
---

# Cut a macOS release

A release is a git tag. Pushing it triggers `.github/workflows/macos-release.yml`,
which signs + notarizes the macOS client, creates a GitHub Release with the DMG +
`.zip`, and publishes the Sparkle auto-update appcast to GitHub Pages. The tag is
the single source of truth for the version (the workflow exports `VERSION` from the
tag name into `CFBundleShortVersionString` and the artifact filenames):

- `vX.Y.Z` → **stable** channel (reaches everyone).
- `vX.Y.Z-beta.N` → **beta** channel (only users who enabled "Receive beta updates").

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

   When it's green, the signed + notarized DMG is in the run's Artifacts.

## Notes

- Accepted: `X.Y.Z` (stable) or `X.Y.Z-beta.N` (beta channel).
- The release secrets (`DEVID_CERT_*`, `APPLE_*`, `SPARKLE_ED_PRIVATE_KEY`) must be
  configured — see the header of `.github/workflows/macos-release.yml`.
- To undo a tag pushed by mistake:

  ```bash
  git push origin :refs/tags/vX.Y.Z   # delete remote tag
  git tag -d vX.Y.Z                   # delete local tag
  gh run cancel <run-id>              # stop the build if it already started
  ```
