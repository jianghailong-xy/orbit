#!/usr/bin/env bash
# Cut a release of the macOS client: validate, create an annotated vX.Y.Z tag,
# and push it to origin — which triggers the `macos-release` GitHub Actions
# workflow that builds the signed + notarized Orbit.dmg. Run from anywhere; it
# resolves the repo root itself.
#
#   .claude/skills/release/release.sh 0.2.0      # or: v0.2.0
#
set -euo pipefail

ver="${1:-}"
if [ -z "$ver" ]; then
  echo "usage: release.sh <version>   e.g.  release.sh 0.2.0" >&2
  exit 1
fi
ver="${ver#v}"                                    # accept 0.2.0 or v0.2.0
if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "✗ version must be X.Y.Z (got '$ver')" >&2
  exit 1
fi
tag="v$ver"

cd "$(git rev-parse --show-toplevel)"

# The tag must point at a fully committed state.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree is not clean — commit or stash first:" >&2
  git status --short >&2
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
echo "✓ pushed $tag — the macos-release workflow is now building the DMG"

if command -v gh >/dev/null 2>&1; then
  url="$(gh repo view --json url -q .url 2>/dev/null || true)"
  [ -n "$url" ] && echo "  Actions: $url/actions/workflows/macos-release.yml"
fi
