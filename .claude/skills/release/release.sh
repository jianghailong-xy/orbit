#!/usr/bin/env bash
# Cut a release of the Orbit clients. A release is one git tag — `vX.Y.Z` — and pushing it runs every
# job of .github/workflows/release.yml from that same tag:
#   • identity        → refuses a tag that is not v + the root package.json version, or has no release notes
#   • dmg             → signed + notarized DMG + GitHub Release + Sparkle appcast
#   • testflight      → signed .ipa uploaded to TestFlight (marketing version = X.Y.Z with any -beta.N
#                       suffix stripped; build number = commit count)
#   • android-build   → signed release APK (versionName = X.Y.Z[-beta.N]; versionCode = commit count)
#   • android-publish → the APK, its .sha256 and android-update.json attached to dmg's GitHub Release
# Run from anywhere; it resolves the repo root itself.
#
# The root package.json version is the version of record. The flow is:
#   release.sh bump 0.2.0-beta.3   # set package.json + package-lock, open release-notes/0.2.0-beta.3.md
#   $EDITOR release-notes/0.2.0-beta.3.md
#   git add -A && git commit ...   # (bump already committed; amend or add a follow-up commit)
#   release.sh 0.2.0-beta.3        # check the identity, tag, push
#
#   .claude/skills/release/release.sh 0.2.0          # or: v0.2.0
#   .claude/skills/release/release.sh 0.2.0-beta.3   # macOS beta channel; iOS ships 0.2.0 to TestFlight
#   .claude/skills/release/release.sh next           # print the next beta after the package version
#
set -euo pipefail

usage() {
  echo "usage: release.sh <version|next|bump <version|next>>" >&2
  echo "  e.g. release.sh next | release.sh bump 0.2.0-beta.3 | release.sh 0.2.0-beta.3" >&2
  exit 1
}

ver="${1:-}"
[ -n "$ver" ] || usage
cd "$(git rev-parse --show-toplevel)"

package_version() {
  node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version'
}

# `next` = the next beta after the package version, so the counter never has to be tracked by hand.
# A beta sorts BELOW the matching stable (0.1.1-beta.2 < 0.1.1), so once X.Y.Z is the package version its
# betas are spent: the next beta opens on X.Y.(Z+1).
next_version() {
  local current rest
  current="$(package_version)"
  case "$current" in
    *-beta.*) printf '%s\n' "${current%-beta.*}-beta.$(( ${current##*-beta.} + 1 ))" ;;
    *)
      rest="${current#*.}"
      printf '%s\n' "${current%%.*}.${rest%%.*}.$(( ${rest#*.} + 1 ))-beta.1"
      ;;
  esac
}

if [ "$ver" = "next" ]; then
  # Print only: tagging needs the package bump and the notes first (use `bump next`).
  echo "▶ next after $(package_version) → $(next_version)"
  exit 0
fi

if [ "$ver" = "bump" ]; then
  ver="${2:-}"
  [ -n "$ver" ] || usage
  if [ "$ver" = "next" ]; then ver="$(next_version)"; fi
  ver="${ver#v}"
  if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'; then
    echo "✗ version must be X.Y.Z or X.Y.Z-beta.N (got '$ver')" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "✗ tracked changes are uncommitted — commit or stash first:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  [ -e "release-notes/$ver.md" ] || {
    mkdir -p release-notes
    cat > "release-notes/$ver.md" <<NOTES
# Orbit $ver

## Summary
TODO: what this release changes, in one or two sentences.

## Upgrade impact
TODO: migrations, configuration, runner and client changes, and what an operator must do.

## Security fixes
TODO: name the fixed issues, or write "None in this release."

## Known limitations
TODO: or "None known."

## Artifacts and verification
TODO: what the release publishes, and which checks support it.

## Rollback
TODO: the previous tag, and whether an application-only rollback is schema-safe.
NOTES
  }
  node -e '
    const fs = require("fs");
    const version = process.argv[1];
    for (const file of ["package.json", "package-lock.json"]) {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      json.version = version;
      if (file === "package-lock.json" && json.packages && json.packages[""]) json.packages[""].version = version;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    }
  ' "$ver"
  git add package.json package-lock.json "release-notes/$ver.md"
  git commit -m "chore(release): prepare $ver"
  echo "✓ package version, lockfile and release-notes/$ver.md are ready"
  echo "  Fill in every section of release-notes/$ver.md, commit it, then run: release.sh $ver"
  exit 0
fi

ver="${ver#v}"                                    # accept 0.2.0 or v0.2.0
# X.Y.Z → macOS stable channel (everyone) + iOS TestFlight; X.Y.Z-beta.N →
# macOS beta channel + iOS TestFlight. The suffix is a macOS/Sparkle concept; iOS strips it to a
# numeric marketing version (build number carries the beta iteration on TestFlight).
if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'; then
  echo "✗ version must be X.Y.Z or X.Y.Z-beta.N (got '$ver')" >&2
  exit 1
fi
tag="v$ver"

# One version: the tag must be v + package.json, the notes must be filled in, and the tag must point at
# this commit. This is the same gate release.yml runs before it builds anything.
node scripts/release-identity.mjs check-tag "$tag"

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
echo "✓ pushed $tag — release.yml is building the macOS DMG, the iOS TestFlight build and the Android APK from this one tag"

if command -v gh >/dev/null 2>&1; then
  url="$(gh repo view --json url -q .url 2>/dev/null || true)"
  [ -n "$url" ] && echo "  Actions: $url/actions/workflows/release.yml"
fi
