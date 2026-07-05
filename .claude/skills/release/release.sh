#!/usr/bin/env bash
# Cut a release of the Orbit clients. A release is one git tag — `vX.Y.Z` — and pushing it runs both
# jobs of .github/workflows/release.yml from that same tag:
#   • dmg        → signed + notarized DMG + GitHub Release + Sparkle appcast
#   • testflight → signed .ipa uploaded to TestFlight (marketing version = X.Y.Z with any -beta.N
#                  suffix stripped; build number = commit count)
# Run from anywhere; it resolves the repo root itself.
#
#   .claude/skills/release/release.sh 0.2.0          # or: v0.2.0
#   .claude/skills/release/release.sh 0.2.0-beta.3   # macOS beta channel; iOS ships 0.2.0 to TestFlight
#
set -euo pipefail

ver="${1:-}"
if [ -z "$ver" ]; then
  echo "usage: release.sh <version>   e.g.  release.sh 0.2.0" >&2
  exit 1
fi
ver="${ver#v}"                                    # accept 0.2.0 or v0.2.0
# X.Y.Z → macOS stable channel (everyone) + iOS TestFlight; X.Y.Z-beta.N (any prerelease suffix) →
# macOS beta channel + iOS TestFlight. The suffix is a macOS/Sparkle concept; iOS strips it to a
# numeric marketing version (build number carries the beta iteration on TestFlight).
if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "✗ version must be X.Y.Z or X.Y.Z-beta.N (got '$ver')" >&2
  exit 1
fi
tag="v$ver"

cd "$(git rev-parse --show-toplevel)"

# The tag must point at a fully committed state. Untracked files don't enter the tag, so only
# tracked (staged/unstaged) changes block a release.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ tracked changes are uncommitted — commit or stash first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

# Refuse to clobber an existing tag (local or remote).
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "✗ tag $tag already exists locally" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  echo "✗ tag $tag already exists on origin" >&2
  exit 1
fi

branch="$(git branch --show-current)"
echo "▶ tagging $tag at $(git rev-parse --short HEAD) (branch: ${branch:-detached})"
git tag -a "$tag" -m "Release $tag"
git push origin "$tag"
echo "✓ pushed $tag — release.yml is building the macOS DMG and the iOS TestFlight build from this one tag"

if command -v gh >/dev/null 2>&1; then
  url="$(gh repo view --json url -q .url 2>/dev/null || true)"
  [ -n "$url" ] && echo "  Actions: $url/actions/workflows/release.yml"
fi
