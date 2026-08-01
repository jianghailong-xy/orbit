#!/usr/bin/env bash
# Cut one Orbit client release tag. Pushing vX.Y.Z runs both jobs in
# .github/workflows/release.yml: the signed macOS DMG and iOS TestFlight upload.
set -euo pipefail

ver="${1:-}"
if [ -z "$ver" ]; then
  echo "usage: release.sh <version|next>   e.g. release.sh 0.2.0 | release.sh next" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

if [ "$ver" = "next" ]; then
  latest="$(git -c versionsort.suffix=-beta tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
  if [ -z "$latest" ]; then
    echo "✗ no v* tag found — pass an explicit version instead of 'next'" >&2
    exit 1
  fi
  case "$latest" in
    *-beta.*) ver="${latest%-beta.*}-beta.$(( ${latest##*-beta.} + 1 ))" ;;
    *)
      rest="${latest#v}"
      rest="${rest#*.}"
      ver="${latest%%.*}.${rest%%.*}.$(( ${rest#*.} + 1 ))-beta.1"
      ;;
  esac
  echo "▶ next after $latest → ${ver#v}"
fi

ver="${ver#v}"
if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "✗ version must be X.Y.Z or X.Y.Z-beta.N (got '$ver')" >&2
  exit 1
fi
tag="v$ver"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ tracked changes are uncommitted — commit or stash first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

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
echo "✓ pushed $tag — release.yml is building the macOS DMG and iOS TestFlight build"

if command -v gh >/dev/null 2>&1; then
  url="$(gh repo view --json url -q .url 2>/dev/null || true)"
  [ -n "$url" ] && echo "  Actions: $url/actions/workflows/release.yml"
fi
