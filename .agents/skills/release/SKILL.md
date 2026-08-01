---
name: release
description: Cut an Orbit client release by creating and pushing one vX.Y.Z git tag, triggering both the signed/notarized macOS DMG release and the iOS TestFlight build. Use when asked to cut or ship a release, tag a version, publish a beta or TestFlight build, or start the client release workflow. Do not use for ordinary deployments of the Docker Compose stack; use the upgrade skill instead.
---

# Cut an Orbit client release

Use one `vX.Y.Z` tag to ship both clients through `.github/workflows/release.yml`:

| Job | Output |
| --- | --- |
| `dmg` | Signed and notarized macOS DMG, GitHub Release, and Sparkle appcast |
| `testflight` | Signed iOS `.ipa` uploaded to TestFlight |

Interpret tags as follows:

- `vX.Y.Z`: macOS stable channel and an iOS TestFlight build.
- `vX.Y.Z-beta.N`: macOS beta channel and an iOS TestFlight build. iOS uses numeric marketing version `X.Y.Z`; the commit-count build number distinguishes iterations.

## Workflow

1. Resolve the requested version. For `next`, inspect the newest version tag:

   ```bash
   git -c versionsort.suffix=-beta tag --list 'v*' --sort=-v:refname | head -1
   ```

   A beta belongs to the version it precedes. After `X.Y.Z` ships stable, open the next beta at `X.Y.(Z+1)-beta.1`.

2. Verify the release commit is the committed and pushed `main` tip:

   ```bash
   git rev-parse --abbrev-ref HEAD
   git fetch origin
   git rev-list --count HEAD..origin/main
   ```

   Require `main` and a result of `0`. If a fix exists only on another branch, merge it into `main`; never tag the feature branch.

3. State the exact resolved tag and get explicit user confirmation before running the helper. Creating and pushing the tag is an external, release-triggering action.

4. Run the helper from the repository:

   ```bash
   .agents/skills/release/scripts/release.sh next
   .agents/skills/release/scripts/release.sh 0.2.0
   .agents/skills/release/scripts/release.sh 0.2.0-beta.3
   ```

   The helper validates the version, refuses tracked uncommitted changes and reused tags, creates an annotated tag, and pushes it to `origin`.

5. Watch the shared workflow and report both job results:

   ```bash
   gh run watch "$(gh run list --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')"
   ```

   A green `testflight` job means upload completed; App Store Connect may still need processing time and an export-compliance answer.

## Constraints

- Accept only `X.Y.Z` or `X.Y.Z-beta.N`-style versions.
- Every pushed `v*` tag starts both platform jobs. To build one platform only, dispatch `release.yml` on `main` with `platform=macos` or `platform=ios` instead of creating a tag.
- Required signing and publishing secrets are documented in `.github/workflows/release.yml`.
- If a tag was pushed incorrectly, ask for confirmation before deleting the remote/local tag or cancelling its workflow; those are destructive external actions.
