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
#   .claude/skills/release/release.sh next           # next beta after the newest tag
#
set -euo pipefail

ver="${1:-}"
if [ -z "$ver" ]; then
  echo "usage: release.sh <version|next>   e.g.  release.sh 0.2.0  |  release.sh next" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# `next` = the next beta after the newest tag, so the counter never has to be tracked by hand.
# A beta sorts BELOW the matching stable (0.1.1-beta.2 < 0.1.1), so once X.Y.Z ships stable its
# betas are spent: the next beta opens on X.Y.(Z+1). Skipping that bump is what stranded the
# counter on an unreleased 0.1.1 for 100 betas.
if [ "$ver" = "next" ]; then
  # versionsort.suffix=-beta makes -beta.N sort below its stable; without it 0.1.1-beta.2 > 0.1.1.
  latest="$(git -c versionsort.suffix=-beta tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
  if [ -z "$latest" ]; then
    echo "✗ no v* tag found — pass an explicit version instead of 'next'" >&2
    exit 1
  fi
  case "$latest" in
    *-beta.*) ver="${latest%-beta.*}-beta.$(( ${latest##*-beta.} + 1 ))" ;;   # v0.1.2-beta.3 → v0.1.2-beta.4
    *)        rest="${latest#v}"; rest="${rest#*.}"                            # v0.1.2 → v0.1.3-beta.1
              ver="${latest%%.*}.${rest%%.*}.$(( ${rest#*.} + 1 ))-beta.1" ;;
  esac
  echo "▶ next after $latest → ${ver#v}"
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
